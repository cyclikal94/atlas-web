import { useCallback, useEffect, useRef, useState } from "react";
import type { TasksResult } from "../api";
import { useTasksEnv } from "../env";
import { noteIfRefused } from "../memory";
import type { DependencyGraph } from "../model/contract";

/**
 * WEB-18 (plan §3.5, D-18-5; backend `docs/tasks.md` "Dependency graph", consumer obligations 1–5): ONE view of one day's dependency graph
 * at one `max_depth`, for the signed-in identity, held in this component's memory only (never stored, cached or logged).
 *
 * - A view is keyed by `identity`, root and `max_depth`; an answer is applied only if it answers the LATEST request issued (a generation
 *   number) for the scope still shown, so an out-of-order answer, one of an earlier identity, or one asked before a connection loss or a
 *   BFCache hide is dropped. Answers are never merged: each applied answer REPLACES the view.
 * - It reads only while `active`: when it becomes active, on `refresh()` ("Check again", "Try again"), when `settled` changes (the
 *   caller's own drafts of the day settling and the applied sync revision moving), when the connection returns, when the document becomes
 *   visible again and on a BFCache restore. At most one request is in flight per view; a trigger meanwhile queues exactly one follow-up.
 * - Offline, a refusal (`403`/`404`: the view is removed) and a closed session drop the graph; a failed re-read while online keeps the last
 *   whole answer as `stale` (labelled with its time), never as current; a failure with nothing shown is `error`.
 */
export type GraphView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "refused" }
  | { kind: "error"; requestId?: string }
  | {
      kind: "ready";
      graph: DependencyGraph;
      /** When the answer was applied (ms, `env.now()`). */
      at: number;
      requestId?: string;
      /** A re-read is in flight; the answer shown is the previous whole one. */
      checking: boolean;
    }
  | {
      kind: "stale";
      graph: DependencyGraph;
      at: number;
      requestId?: string;
      checking: boolean;
    };

export const GRAPH_READ = (
  occurrenceId: string,
  maxDepth: number | undefined,
) => `dependency-graph:${occurrenceId}:${maxDepth ?? "all"}`;

interface Held {
  scope: string;
  view: GraphView;
  /** The number of answers applied to this scope (a component compares it to notice a new whole answer). */
  seq: number;
}

/** Resolves every `refresh()` waiting for the follow-up of the request in flight. */
function releaseAll(waiters: { current: Array<() => void> }): void {
  const ready = waiters.current;
  waiters.current = [];
  for (const done of ready) done();
}

const IDLE: GraphView = { kind: "idle" };
const LOADING: GraphView = { kind: "loading" };

function failed(
  previous: GraphView,
  result: Extract<TasksResult<DependencyGraph>, { ok: false }>,
): GraphView {
  if (result.kind === "offline") return { kind: "offline" };
  if (result.kind === "forbidden" || result.kind === "not_found")
    return { kind: "refused" };
  const requestId =
    "requestId" in result && result.requestId ? result.requestId : undefined;
  // A closed session (or an identity that moved) shows nothing it had: there is no account to show it for.
  if (
    result.kind !== "closed" &&
    (previous.kind === "ready" || previous.kind === "stale")
  )
    return {
      kind: "stale",
      graph: previous.graph,
      at: previous.at,
      ...(previous.requestId ? { requestId: previous.requestId } : {}),
      checking: false,
    };
  return { kind: "error", ...(requestId ? { requestId } : {}) };
}

export function useDependencyGraph(
  rootId: string,
  maxDepth: number | undefined,
  options: { active: boolean; settled: string },
): { view: GraphView; seq: number; refresh(): Promise<void> } {
  const env = useTasksEnv();
  const scope = `${env.identity}\u0000${rootId}\u0000${maxDepth ?? ""}`;
  const [held, setHeld] = useState<Held>({ scope: "", view: IDLE, seq: 0 });
  const latest = useRef(0);
  const current = useRef(scope);
  current.current = scope;
  const active = useRef(options.active);
  active.current = options.active;
  const online = useRef(env.online);
  online.current = env.online;
  // The request in flight (its scope and generation) and whether a trigger asked for one more meanwhile.
  const flight = useRef<{ scope: string; gen: number } | null>(null);
  const queued = useRef(false);
  const waiters = useRef<Array<() => void>>([]);
  /** Drops whatever is shown or asked for this scope: nothing in flight may land afterwards. */
  const drop = useCallback((view: GraphView) => {
    latest.current += 1;
    flight.current = null;
    queued.current = false;
    setHeld({ scope: current.current, view, seq: 0 });
    releaseAll(waiters);
  }, []);
  const ask = useCallback(async (): Promise<void> => {
    if (!active.current) return;
    const asked = current.current;
    if (!online.current) {
      drop({ kind: "offline" });
      return;
    }
    if (flight.current !== null && flight.current.scope === asked) {
      // One in flight for this view: exactly one follow-up, answered after it.
      queued.current = true;
      return new Promise<void>((resolve) => waiters.current.push(resolve));
    }
    latest.current += 1;
    const mine = latest.current;
    flight.current = { scope: asked, gen: mine };
    setHeld((prev) =>
      prev.scope === asked
        ? {
            ...prev,
            view:
              prev.view.kind === "ready" || prev.view.kind === "stale"
                ? { ...prev.view, checking: true }
                : prev.view.kind === "idle"
                  ? LOADING
                  : prev.view,
          }
        : { scope: asked, view: LOADING, seq: 0 },
    );
    const result = await env.api.readDependencyGraph(rootId, maxDepth);
    // A refusal is noted when it arrives (WEB-10a's consumer obligation), whatever the screen does with it.
    noteIfRefused(env.identity, GRAPH_READ(rootId, maxDepth), result);
    if (flight.current?.gen === mine) flight.current = null;
    // Only the answer to the latest request of the scope still shown is applied (obligation 2).
    if (latest.current !== mine || current.current !== asked) return;
    setHeld((prev) => {
      const previous = prev.scope === asked ? prev.view : LOADING;
      const view: GraphView = result.ok
        ? {
            kind: "ready",
            graph: result.value,
            at: env.now(),
            ...(result.requestId ? { requestId: result.requestId } : {}),
            checking: false,
          }
        : failed(previous, result);
      const before = prev.scope === asked ? prev.seq : 0;
      const ended = view.kind === "offline" || view.kind === "refused";
      return {
        scope: asked,
        view,
        seq: result.ok ? before + 1 : ended ? 0 : before,
      };
    });
    if (queued.current && active.current) {
      queued.current = false;
      await ask();
      return;
    }
    releaseAll(waiters);
  }, [env, rootId, maxDepth, drop]);

  // Activation, the scope, the connection and the caller's own settlements (plan D-18-5).
  const ran = useRef<string | null>(null);
  useEffect(() => {
    if (!options.active) {
      // Inactive: nothing is read, and nothing asked earlier may land.
      if (ran.current !== null) drop(IDLE);
      ran.current = null;
      return;
    }
    const key = `${scope}\u0000${env.online}\u0000${options.settled}`;
    if (ran.current === key) return;
    ran.current = key;
    void ask();
  }, [scope, env.online, options.active, options.settled, ask, drop]);

  // Shown again: the document becomes visible, or the page comes back from the BFCache (whose hide dropped the snapshot).
  useEffect(() => {
    if (!options.active) return;
    const visible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    const hide = (event: PageTransitionEvent) => {
      if (event.persisted) drop(LOADING);
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) void ask();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [options.active, ask, drop]);

  const refresh = useCallback(() => ask(), [ask]);
  const mine = held.scope === scope;
  return {
    view: !options.active ? IDLE : mine ? held.view : LOADING,
    seq: mine ? held.seq : 0,
    refresh,
  };
}

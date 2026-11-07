import { useEffect, useRef } from "react";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { type PeopleMemory, useMemoryRevision } from "../memory";
import {
  ACTIVITY_MAX,
  type ActivityTimeline,
  collapseActivity,
  depthOf,
  extendActivity,
  readActivity,
} from "./timeline";

/**
 * WEB-19: what the "Recent changes" section shows of a person's activity (`timeline.ts`), for the displayed identity.
 *
 *  - Offline: nothing (never an earlier answer: the summaries' rule, D-19-8).
 *  - While a re-read is on its way, the timeline this view showed for the SAME person under the same identity stays (`previous`, marked
 *    busy), with the same controls as when it was ready (R-1: the section keeps one tree, so focus and the controls survive a refresh);
 *    a failure, a `404`, a merge note, going offline or another person or identity lets go of it at once (D-19-3).
 *  - `ready`: the held timeline cut to the depth asked for. `canExtend`: "Show all changes"/"Show older changes" can show more (held, or
 *    recorded before what is held); `atCap`: the 500 most recent are shown and more were recorded.
 */
export interface ActivityShown {
  timeline: ActivityTimeline;
  checkedAt: number;
  depth: number;
  extending: boolean;
  extendFailed: boolean;
  canExtend: boolean;
  atCap: boolean;
  /** Every event recorded since coverage began is shown: nothing earlier exists. */
  startReached: boolean;
  extend(): void;
  collapse(): void;
}

export type ActivityView =
  | { status: "offline" }
  | { status: "loading"; previous: ActivityShown | null }
  | ({ status: "ready" } & ActivityShown)
  | { status: "failed"; reason: "failed" | "stale"; retry(): void }
  | { status: "gone" }
  | { status: "merged"; canonicalId: string };

/** The events of `timeline` shown at `depth` (the newest first). */
const cut = (timeline: ActivityTimeline, depth: number): ActivityTimeline =>
  timeline.items.length <= depth
    ? timeline
    : { ...timeline, items: timeline.items.slice(0, depth) };

/** What `held` shows at `depth`, and what its controls can do (the same whether it is the answer now or the one a re-read will replace). */
function shownOf(
  env: PeopleEnv,
  personId: string,
  held: ActivityTimeline,
  checkedAt: number,
  depth: number,
  step: { extending: boolean; extendFailed: boolean },
): ActivityShown {
  const more = held.items.length > depth || held.next !== null;
  return {
    timeline: cut(held, depth),
    checkedAt,
    depth,
    extending: step.extending,
    extendFailed: step.extendFailed,
    canExtend: more && (depth < ACTIVITY_MAX || held.items.length < depth),
    atCap: depth >= ACTIVITY_MAX && held.items.length >= depth && more,
    startReached: !more,
    extend: () => extendActivity(env, personId),
    collapse: () => collapseActivity(env.memory, personId),
  };
}

const IDLE = { extending: false, extendFailed: false } as const;

export function useActivity(personId: string): ActivityView {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const memory = env.memory;
  const generation = memory.summaryGeneration;
  // Not released on unmount (unlike an owned summary): the entry is the person's for this generation whichever view shows it, so a
  // remount (StrictMode's rehearsal, a `403`'s remount of the protected tree) joins the read on its way instead of asking again. Every
  // invalidation clears it, and an answer is applied only under the generation and identity it was asked for (`timeline.ts`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: an invalidation (a new generation) asks again
  useEffect(() => {
    if (!env.online) return;
    readActivity(env, personId);
  }, [env, personId, generation]);
  const shown = useRef<{
    memory: PeopleMemory;
    personId: string;
    timeline: ActivityTimeline;
    checkedAt: number;
  } | null>(null);
  if (
    shown.current !== null &&
    (shown.current.memory !== memory || shown.current.personId !== personId)
  )
    shown.current = null;
  if (!env.online) {
    shown.current = null;
    return { status: "offline" };
  }
  const depth = depthOf(memory, personId);
  const state = memory.activity.get(personId)?.state;
  if (state === undefined || state.kind === "loading") {
    const previous = shown.current;
    return {
      status: "loading",
      previous:
        previous === null
          ? null
          : shownOf(
              env,
              personId,
              previous.timeline,
              previous.checkedAt,
              depth,
              IDLE,
            ),
    };
  }
  if (state.kind !== "ready") {
    shown.current = null;
    if (state.kind === "failed")
      return {
        status: "failed",
        reason: state.reason,
        retry: () => readActivity(env, personId, { force: true }),
      };
    return state.kind === "gone"
      ? { status: "gone" }
      : { status: "merged", canonicalId: state.canonicalId };
  }
  shown.current = {
    memory,
    personId,
    timeline: state.timeline,
    checkedAt: state.checkedAt,
  };
  const held = state.timeline;
  return {
    status: "ready",
    ...shownOf(env, personId, held, state.checkedAt, depth, state),
  };
}

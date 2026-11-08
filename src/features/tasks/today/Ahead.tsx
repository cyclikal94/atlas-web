import { useEffect, useMemo } from "react";
import { Button } from "../../../components/ui/button";
import {
  type MaterialiseSequenceRow,
  type TaskSequences,
  useCachedResources,
} from "../../../data";
import { useCatchUp } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { type AheadTarget, aheadDigest } from "../model/ahead";
import { CATCH_UP_COPY, reasonText, stopsFor } from "./CatchUpBanner";

/** Provisional copy (the Final design, 8 November 2026; docs/tasks.md checkpoint list). */
export const AHEAD_COPY = {
  running: "Planning the month ahead…",
  paused: "The days ahead are planned when Atlas can reach the server.",
  stopped: (title: string) => `Couldn't plan ahead for “${title}”.`,
  planned: (day: string) => `Planned with the server through ${day}.`,
} as const;

/** Where this device notes the plan it last saw settled, so a reload does not ask the server again the same day. */
export const AHEAD_STORAGE_KEY = "atlas.ahead.v1";
function readSettled(): string | null {
  try {
    return globalThis.localStorage?.getItem(AHEAD_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}
function writeSettled(value: string) {
  try {
    globalThis.localStorage?.setItem(AHEAD_STORAGE_KEY, value);
  } catch {
    // Full or blocked storage: the runner's own records still keep the work from repeating within this page.
  }
}

const rowFor = (
  found: TaskSequences | undefined,
  day: string,
): MaterialiseSequenceRow | null => found?.days?.[day] ?? null;

/**
 * The look-ahead of the days ahead (`model/ahead.ts`): asks the page's catch-up runner, while the server can be reached, to bring each
 * planned task up to date through its day (trigger `ahead`, one sequence per task and day, the runner's own budget and stops), says so
 * while it works, and shows each stop with its reason and "Try again", as Today's banner does. A plan this device saw settle is noted
 * and not asked again until it changes (a new task, a new day).
 */
export function Ahead({
  targets,
  horizonLabel,
}: {
  targets: readonly AheadTarget[];
  /** The last planned day, as said to the person. */
  horizonLabel: string;
}) {
  const env = useTasksEnv();
  const digest = aheadDigest(targets);
  const noted = `${env.identity}\u0000${digest}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the plan is read by its digest, so equal plans keep their arrays
  const taskIds = useMemo(() => targets.map((t) => t.taskId), [digest]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above
  const days = useMemo(
    () => [...new Set(targets.map((t) => t.throughDate))],
    [digest],
  );
  const { runner, state, records, discovery } = useCatchUp(taskIds, {
    days,
  });
  const titles = useCachedResources(taskIds);
  const reachable = env.online && env.writable;
  const settledBefore = readSettled() === noted;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the plan or the connection changes
  useEffect(() => {
    if (!reachable || settledBefore || targets.length === 0) return;
    for (const target of targets)
      runner.ensure(target.taskId, "ahead", {
        throughDate: target.throughDate,
      });
  }, [digest, reachable, runner]);
  const found: ReadonlyMap<string, TaskSequences> =
    records.status === "ready" ? records.value : new Map();
  const dayOf = new Map(targets.map((t) => [t.taskId, t.throughDate]));
  const rowsOf = (taskId: string) => {
    const row = rowFor(found.get(taskId), dayOf.get(taskId) ?? "");
    return row === null ? [] : [row];
  };
  const stopped = targets.flatMap((t) =>
    stopsFor(t.taskId, rowsOf(t.taskId), state, discovery).filter(
      (stop) =>
        stop.throughDate === undefined || stop.throughDate === t.throughDate,
    ),
  );
  const working = targets.filter(
    (t) =>
      state.active.includes(t.taskId) ||
      rowsOf(t.taskId).some((row) => row.phase !== "stopped"),
  );
  const settled =
    reachable &&
    records.status === "ready" &&
    working.length === 0 &&
    stopped.length === 0;
  useEffect(() => {
    if (settled && !settledBefore && targets.length > 0) writeSettled(noted);
  }, [settled, settledBefore, noted, targets.length]);
  if (targets.length === 0) return null;
  const titleOf = (taskId: string): string => {
    const row = titles.status === "ready" ? titles.value[taskId] : null;
    return row?.merged.label ?? CATCH_UP_COPY.untitled;
  };
  if (settled || settledBefore)
    return stopped.length === 0 ? (
      // Settled: nothing to say on the page (the days ahead speak for themselves); the plan's reach for assistive technology only.
      <p className="sr-only" data-ahead="planned">
        {AHEAD_COPY.planned(horizonLabel)}
      </p>
    ) : null;
  return (
    <div
      className="flex flex-col gap-2 pl-[94px]"
      data-ahead={
        !reachable ? "paused" : working.length > 0 ? "running" : "idle"
      }
    >
      {!reachable ? (
        <p className="text-xs text-muted-foreground">{AHEAD_COPY.paused}</p>
      ) : working.length > 0 ? (
        <p aria-busy="true" className="text-xs text-muted-foreground">
          {AHEAD_COPY.running}
        </p>
      ) : null}
      {stopped.map((stop) => (
        <div
          key={`${stop.taskId}|${stop.throughDate ?? ""}`}
          className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3.5 py-2.5"
          data-ahead-stopped={stop.reason}
          data-ahead-task={stop.taskId}
        >
          <p className="text-sm font-medium text-foreground">
            {AHEAD_COPY.stopped(titleOf(stop.taskId))}
          </p>
          <p className="text-xs text-muted-foreground">{reasonText(stop)}</p>
          {stop.requestId ? (
            <p className="select-all font-num text-xs text-muted-foreground">
              {copy.REQUEST_ID(stop.requestId)}
            </p>
          ) : null}
          {reachable && stop.reason !== "horizon" ? (
            <span>
              <Button
                size="sm"
                onClick={() =>
                  runner.tryAgain(stop.taskId, stop.throughDate, stop.seen)
                }
              >
                {copy.TRY_AGAIN}
              </Button>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

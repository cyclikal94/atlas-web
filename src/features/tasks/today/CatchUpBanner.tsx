import { useEffect, useId, useRef } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { type MaterialiseSequenceRow, useCachedResources } from "../../../data";
import { useCatchUp } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import type { StopReason } from "../model/materialise";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const CATCH_UP_COPY = {
  running: (n: number) =>
    n === 1
      ? "Bringing 1 repeating task up to date…"
      : `Bringing ${n} repeating tasks up to date…`,
  stopped: (title: string) =>
    `Couldn't bring “${title}” up to date automatically.`,
  paused:
    "Repeating tasks will be brought up to date when Atlas can reach the server.",
  done: "Repeating tasks are up to date.",
  untitled: "a repeating task",
  reason: {
    bound:
      "It needed more catching up than Atlas does in one go. Try again to carry on from where it stopped.",
    no_progress:
      "The server didn't add any days. Check this device's date and time, then try again.",
    horizon: "That day is too far ahead to bring up to date.",
    capacity: "The server is busy right now.",
    rejected:
      "This task can't be brought up to date from here. It may have been archived, or it's no longer shared with you.",
    unreachable: "Atlas couldn't reach the server.",
  } satisfies Record<StopReason, string>,
} as const;

/** The latest day's sequence of each task (a task has at most a few: older ones are pruned when a later day begins). */
function latestByTask(
  rows: readonly MaterialiseSequenceRow[],
): Map<string, MaterialiseSequenceRow> {
  const out = new Map<string, MaterialiseSequenceRow>();
  for (const row of rows) {
    const held = out.get(row.task_id);
    if (held === undefined || row.through_date > held.through_date)
      out.set(row.task_id, row);
  }
  return out;
}

/**
 * WF-TODAY-01 C: Today brings the repeating tasks the server lists in `pending_tasks` up to date AUTOMATICALLY (WEB-04 §5.8; D-10c-5,
 * escalation E-5): one at a time, through the page's runner. The banner says what is happening ("Bringing n repeating tasks up to date…"),
 * each task that stopped with its reason and "Try again", or, offline or while this app is not compatible with the server, that it waits
 * (with WEB-10a's pending sentence). It leaves once Today's next current answer no longer lists the task. Announced through the announcer
 * only on completion and on a stop (R6); there is no live region here.
 */
export function CatchUpBanner({ pendingTasks }: { pendingTasks: string[] }) {
  const env = useTasksEnv();
  const announcer = useAnnouncer();
  const heading = useId();
  const { runner, state, records } = useCatchUp();
  const titles = useCachedResources(pendingTasks);
  const key = pendingTasks.join(",");
  const reachable = env.online && env.writable;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the listed tasks or the connection change
  useEffect(() => {
    if (!reachable) return;
    for (const taskId of pendingTasks) runner.ensure(taskId, "daily");
  }, [key, reachable, runner]);
  const seen = useRef({ finished: state.finished, stops: state.stops });
  useEffect(() => {
    if (state.finished > seen.current.finished)
      announcer.announce(CATCH_UP_COPY.done, "polite");
    if (state.stops > seen.current.stops)
      announcer.announce(
        CATCH_UP_COPY.stopped(CATCH_UP_COPY.untitled),
        "assertive",
      );
    seen.current = { finished: state.finished, stops: state.stops };
  }, [state.finished, state.stops, announcer]);
  if (pendingTasks.length === 0) return null;
  const latest = latestByTask(records.status === "ready" ? records.value : []);
  const titleOf = (taskId: string): string => {
    const row = titles.status === "ready" ? titles.value[taskId] : null;
    return row?.merged.label ?? CATCH_UP_COPY.untitled;
  };
  const stopped = pendingTasks.flatMap((taskId) => {
    const row = latest.get(taskId);
    if (row?.phase === "stopped" && row.stop !== null)
      return [
        {
          taskId,
          throughDate: row.through_date as string | undefined,
          reason: row.stop.reason,
          requestId: row.stop.request_id,
        },
      ];
    const memory = state.unrecorded.get(taskId);
    return memory === undefined
      ? []
      : [
          {
            taskId,
            throughDate: undefined,
            reason: memory.reason,
            requestId: memory.requestId,
          },
        ];
  });
  const working = pendingTasks.filter(
    (taskId) =>
      state.active.includes(taskId) ||
      (latest.get(taskId)?.phase ?? "stopped") !== "stopped",
  );
  return (
    <section
      data-pending-tasks=""
      data-catch-up={
        !reachable ? "paused" : working.length > 0 ? "running" : "idle"
      }
      aria-labelledby={heading}
      className="flex max-w-[620px] flex-col gap-2 rounded-row border border-hairline-strong bg-raised px-3.5 py-2.5"
    >
      <h2 id={heading} className="sr-only">
        {copy.PENDING_TASKS}
      </h2>
      {!reachable ? (
        <p className="text-[13px] leading-[1.55] text-ink-1">
          {CATCH_UP_COPY.paused} {copy.PENDING_TASKS}
        </p>
      ) : working.length > 0 ? (
        <p
          aria-busy="true"
          className="text-[13px] leading-[1.55] text-ink-1"
          data-catch-up-running={working.length}
        >
          {CATCH_UP_COPY.running(working.length)}
        </p>
      ) : stopped.length === 0 ? (
        <p className="text-[13px] leading-[1.55] text-ink-1">
          {copy.PENDING_TASKS}
        </p>
      ) : null}
      {stopped.map((stop) => (
        <div
          key={stop.taskId}
          className="flex flex-col gap-1"
          data-catch-up-stopped={stop.reason}
          data-catch-up-task={stop.taskId}
        >
          <p className="text-[13px] font-medium text-ink-1">
            {CATCH_UP_COPY.stopped(titleOf(stop.taskId))}
          </p>
          <p className="text-[12.5px] text-ink-2">
            {CATCH_UP_COPY.reason[stop.reason]}
          </p>
          {stop.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(stop.requestId)}
            </p>
          ) : null}
          {reachable && stop.reason !== "horizon" ? (
            <span>
              <Button
                onClick={() => runner.tryAgain(stop.taskId, stop.throughDate)}
              >
                {copy.TRY_AGAIN}
              </Button>
            </span>
          ) : null}
        </div>
      ))}
    </section>
  );
}

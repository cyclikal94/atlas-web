import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import {
  type MaterialiseDiscovery,
  type MaterialiseSequenceRow,
  type TaskSequences,
  useCachedResources,
} from "../../../data";
import {
  type RunnerState,
  type SeenStop,
  seenDiscovery,
  seenSequence,
} from "../catchup/runner";
import { useCatchUp } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { callerOf, type StopReason } from "../model/materialise";
import { type Pause, readSchedule } from "../model/retry";

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
  forDay: (day: string) => `For ${day}`,
  /** Revision 6 (review R28): a task holds more days than are shown. */
  earlier: "Atlas is keeping track of earlier days for this task too.",
  showEarlier: "Show earlier days",
  everyDay: (title: string) => `See every day for “${title}”`,
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
    storage:
      "This device is short of storage space, so Atlas couldn't keep track of catching up. Free some space, then try again.",
  } satisfies Record<ShownReason, string>,
  /** Revision 10 (Decision B): why trying again automatically stopped, in place of the reason. */
  pause: {
    window:
      "Atlas kept trying for a few minutes without success. It will try again when this device reconnects.",
    unrecognised:
      "The server gave an answer Atlas didn't recognise, several times.",
    clock:
      "This device's clock changed while Atlas was trying. Check its date and time, then try again.",
    legacy:
      "Atlas was updated while it was catching up. Try again to carry on.",
  } satisfies Record<Pause, string>,
} as const;

/** The sentence that says why a stop stands (revision 10: a retry pause says why trying again stopped). */
export const reasonText = (stop: { reason: ShownReason; pause?: Pause }) =>
  stop.pause === undefined
    ? CATCH_UP_COPY.reason[stop.reason]
    : CATCH_UP_COPY.pause[stop.pause];

/** A record's retry pause, when its stop is one (revision 10). */
const pauseOf = (
  value: unknown,
  caller: Parameters<typeof readSchedule>[1],
) => {
  const s = readSchedule(value, caller);
  return s === null || s === "invalid" || s.pause === null
    ? {}
    : { pause: s.pause };
};

/**
 * Why a task's catch-up stopped, as shown: a sequence's or a discovery's reason, or `storage` (revision 3, review R16: this page could not
 * admit the task's discovery record, so it sent nothing).
 */
export type ShownReason = StopReason | "storage";

/**
 * A task's stopped catch-up, as this page knows it: a day's record when stopped, else its stopped discovery (the first read; any page's
 * record, review R13), else a discovery stop held in this page's memory only (its record could not be written).
 */
export interface ShownStop {
  taskId: string;
  throughDate: string | undefined;
  reason: ShownReason;
  requestId: string | undefined;
  /** Revision 10: the retry pause it is, if any. */
  pause?: Pause;
  /** What a "Try again" pressed on it names (review R20): this very stop, never a later one that looks the same. */
  seen: SeenStop;
}
/**
 * The days of a task whose stopped catch-up a screen shows (revision 5, review R24): the exact day it works for (`target`, once known),
 * and, while that day is not known or when the screen shows every retained stop (`every`: the task's detail), the task's latest days as
 * read. A later day (a horizon stop) never stands in for the target: each is reached by its own key. Revision 6 (review R28): `every` adds
 * the further exact days read by key (a selected day, a day a command asked for). Rows not read are not "no stop": a screen whose read is
 * incomplete (`found.complete` false) offers the rest.
 */
export function recoveryRows(
  found: TaskSequences | undefined,
  target: string | undefined,
  every = false,
): MaterialiseSequenceRow[] {
  if (found === undefined) return [];
  const rows: MaterialiseSequenceRow[] = [];
  const add = (row: MaterialiseSequenceRow) => {
    if (!rows.some((r) => r.through_date === row.through_date)) rows.push(row);
  };
  if (target !== undefined && found.target) rows.push(found.target);
  if (every)
    for (const row of Object.values(found.days ?? {}))
      if (row !== null) add(row);
  if (target === undefined || every) for (const row of found.rows) add(row);
  return rows;
}

/**
 * Every stop of a task a screen shows, each with what a "Try again" on it names (revision 5, review R26): a day's stopped sequence with the
 * discovery stop shown beside it; else the stopped discovery; else the page's memory stop.
 */
export function stopsFor(
  taskId: string,
  rows: readonly MaterialiseSequenceRow[],
  state: RunnerState,
  discovery: Readonly<Record<string, MaterialiseDiscovery>> = {},
): ShownStop[] {
  const entry = discovery[taskId];
  const found = entry?.stop ? entry : null;
  const days = rows.flatMap((row) =>
    row.phase === "stopped" && row.stop !== null
      ? [
          {
            taskId,
            throughDate: row.through_date,
            reason: row.stop.reason,
            requestId: row.stop.request_id,
            ...pauseOf(row.schedule, callerOf(row)),
            seen: seenSequence(row, found),
          },
        ]
      : [],
  );
  if (days.length > 0) return days;
  if (found?.stop)
    return [
      {
        taskId,
        throughDate: undefined,
        reason: found.stop.reason,
        requestId: found.stop.request_id,
        ...pauseOf(found.schedule, "discovery"),
        seen: seenDiscovery(found),
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
          seen: { kind: "memory", id: memory.id },
        },
      ];
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
  const { runner, state, records, todayOf, discovery } =
    useCatchUp(pendingTasks);
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
  const found: ReadonlyMap<string, TaskSequences> =
    records.status === "ready" ? records.value : new Map();
  // Each task's rows for the day Today works for: its today once known, else its latest days as read (revision 5, R24).
  const rowsOf = (taskId: string) =>
    recoveryRows(found.get(taskId), todayOf(taskId));
  const titleOf = (taskId: string): string => {
    const row = titles.status === "ready" ? titles.value[taskId] : null;
    return row?.merged.label ?? CATCH_UP_COPY.untitled;
  };
  const stopped = pendingTasks.flatMap((taskId) =>
    stopsFor(taskId, rowsOf(taskId), state, discovery),
  );
  const working = pendingTasks.filter(
    (taskId) =>
      state.active.includes(taskId) ||
      rowsOf(taskId).some((row) => row.phase !== "stopped"),
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
          key={`${stop.taskId}|${stop.throughDate ?? ""}`}
          className="flex flex-col gap-1"
          data-catch-up-stopped={stop.reason}
          data-catch-up-task={stop.taskId}
          data-catch-up-day={stop.throughDate}
        >
          <p className="text-[13px] font-medium text-ink-1">
            {CATCH_UP_COPY.stopped(titleOf(stop.taskId))}
          </p>
          <p className="text-[12.5px] text-ink-2">{reasonText(stop)}</p>
          {stop.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(stop.requestId)}
            </p>
          ) : null}
          {reachable && stop.reason !== "horizon" ? (
            <span>
              <Button
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
      {/* Revision 6 (review R28): a task whose day is not known yet and holds more days than were read: every one is on its page. */}
      {pendingTasks
        .filter(
          (taskId) =>
            todayOf(taskId) === undefined &&
            found.get(taskId)?.complete === false,
        )
        .map((taskId) => (
          <Link
            key={`more|${taskId}`}
            to="/tasks/$taskId"
            params={{ taskId }}
            search={{}}
            data-catch-up-more={taskId}
            className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13px] text-ink-1 underline underline-offset-2"
          >
            {CATCH_UP_COPY.everyDay(titleOf(taskId))}
          </Link>
        ))}
    </section>
  );
}

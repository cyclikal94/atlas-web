import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  useDataEnv,
  useDraftWithCommand,
  useSharingDefaults,
} from "../../../data";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { momentLabel } from "../format";
import { noteIfRefused } from "../memory";
import { cancelTimer, startTimer, stopTimer } from "../model/commands";
import type { TimerSession } from "../model/contract";
import { progressOf } from "../model/dependencies";
import {
  elapsed,
  isTimerGoal,
  type RunningSession,
  runningOn,
  SEVEN_DAYS,
  type StartBlock,
  startBlock,
  stopChoice,
  timerCommandOf,
} from "../model/timers";
import { useCopiedTimers } from "../timers/copy";
import type { PendingMark, RowModel } from "../view";
import type { DependencyState } from "./Dependencies";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const TIMER_COPY = {
  heading: "Timer",
  notUsed: "Not used for this task — timers are for tasks measured in time.",
  start: "Start",
  stop: "Stop",
  discard: "Discard",
  running: "Running",
  startedAt: (time: string) => `Started ${time}`,
  lastChecked: (time: string) => `Last checked ${time}`,
  blocked: {
    not_open: "This day hasn't opened yet.",
    covered: "An earlier day of this task is still open.",
    closed: "This day is closed.",
    denied: "Only participants can time this.",
    running: "A timer is already running for this day.",
  } satisfies Record<NonNullable<StartBlock>, string>,
  sevenDays:
    "This timer has run for more than 7 days, the most one session can record.",
  recordSeven: "Record the first 7 days",
  discardSession: "Discard the session",
  closedDay: (time: string) =>
    `This day closed at ${time}; the time up to then is recorded.`,
  conflictTitle: "This timer action couldn't be completed as sent.",
  review: "Review this day's timer sessions",
  sessions: "This day's sessions",
  hideSessions: "Hide this day's sessions",
  sessionsOffline: "Shown when you're online.",
  sessionsEmpty: "No sessions yet.",
  sessionsFailed: "Couldn't load this day's sessions.",
  loadMore: "Load more",
  sessionRow: (start: string, end: string, duration: string) =>
    `${start} – ${end} · ${duration}`,
  sessionRunning: (start: string) => `${start} – running`,
  yourTimers: "Your timers",
  see: "See what needs doing first",
  saved: "Saved on this device. It will be sent when Atlas can.",
} as const;

/** The page's clock for a running timer: one tick a second while the page is shown (no live region). */
function useSecond(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const timer = setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active]);
  return now;
}

const timerKind = (kind: string) =>
  kind === "start_timer" || kind === "stop_timer" || kind === "cancel_timer";

/** A timer draft's status as its pending mark (the detail's and the account list's). */
export const MARK: Readonly<Record<string, PendingMark>> = {
  queued: "queued",
  blocked: "queued",
  in_flight: "sending",
  acknowledged: "waiting",
};

/**
 * The last COMPLETE read of each day's sessions on this page, for the displayed identity only (page memory, never persisted): offline, a
 * session this device saw running stays shown, marked with when it was read ("Last checked"), until the connection is back.
 */
const lastRead = new Map<string, { sessions: TimerSession[]; at: number }>();
let lastReadFor = "";
function remember(
  identity: string,
  occurrenceId: string,
  sessions: TimerSession[] | null,
  at: number,
) {
  if (lastReadFor !== identity) {
    lastRead.clear();
    lastReadFor = identity;
  }
  if (sessions === null) return lastRead.get(occurrenceId) ?? null;
  lastRead.delete(occurrenceId);
  lastRead.set(occurrenceId, { sessions, at });
  if (lastRead.size > 200) {
    const oldest = lastRead.keys().next().value;
    if (oldest !== undefined) lastRead.delete(oldest);
  }
  return null;
}

/** The day's own sessions (`GET /occurrences/{id}/timers`, online, 50 a page): what tells a running session apart on this device. */
function useDaySessions(occurrenceId: string, again: string) {
  const env = useTasksEnv();
  const [state, setState] = useState<{
    scope: string;
    pages: TimerSession[][];
    next: string | null;
    status: "loading" | "ready" | "error" | "offline";
    requestId?: string;
    /** When the read's FIRST page was issued (ms): a later page cannot make it newer than that. */
    askedAt?: number;
  }>({ scope: "", pages: [], next: null, status: "loading" });
  const scope = `${env.identity}\u0000${occurrenceId}`;
  const load = async (after: string | null) => {
    if (!env.online) {
      setState({ scope, pages: [], next: null, status: "offline" });
      return;
    }
    const asked = env.now();
    const result = await env.api.readTimers(occurrenceId, after ?? undefined);
    noteIfRefused(env.identity, `timers:${occurrenceId}`, result);
    setState((prev) => {
      if (!result.ok)
        return {
          ...(prev.scope === scope ? prev : { pages: [], next: null }),
          scope,
          status: "error",
          ...("requestId" in result && result.requestId
            ? { requestId: result.requestId }
            : {}),
        };
      const fresh = after === null || prev.scope !== scope;
      const pages = fresh ? [] : prev.pages;
      const all = [...pages, result.value.items];
      const askedAt = fresh ? asked : (prev.askedAt ?? asked);
      if (result.value.next_after === null)
        remember(env.identity, occurrenceId, all.flat(), askedAt);
      return {
        scope,
        pages: all,
        next: result.value.next_after,
        status: "ready",
        askedAt,
      };
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for another identity, day, connection or answered draft
  useEffect(() => {
    void load(null);
  }, [scope, env.online, again]);
  const current = state.scope === scope ? state : null;
  const kept =
    current?.status === "offline"
      ? remember(env.identity, occurrenceId, null, 0)
      : null;
  return {
    status: current?.status ?? "loading",
    requestId: current?.requestId,
    sessions:
      kept !== null ? kept.sessions : current ? current.pages.flat() : [],
    complete:
      kept !== null ||
      (current !== null && current.next === null && current.status === "ready"),
    /** When the sessions shown offline were read (ms), or null for a read now. */
    keptAt: kept?.at ?? null,
    /** When the complete read shown was issued (ms; the kept one's offline), or null while there is none. */
    readAt:
      kept !== null
        ? kept.at
        : current?.status === "ready" && current.next === null
          ? (current.askedAt ?? null)
          : null,
    more: current?.next ? () => void load(current.next) : null,
    retry: () => void load(null),
  };
}

/**
 * WF-TASK-01's timer block under B6 (CM-355, 394, 422; TASK-6/6a, TASK-25; plan §4.3): for a goal measured in seconds, Start, the running
 * session with Stop and Discard (queued, offline-capable), the 7-day and closed-day choices, the cause-neutral conflict block and the day's
 * sessions. Start is withheld only while a session of mine runs on THIS day: other days' timers are independent.
 */
export function TimerBlock({
  row,
  actions,
  deps,
  writable,
  onSee,
}: {
  row: RowModel;
  actions: Pick<TaskActions, "enqueue">;
  deps: DependencyState;
  writable: boolean;
  /** Opens "What needs doing first" (a stop that met an unmet prerequisite, WEB-04 wireframe §2). */
  onSee(): void;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const defaults = useSharingDefaults().record;
  const heading = useId();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timerDrafts = row.drafts.filter((d) => timerCommandOf(d) !== null);
  const again = timerDrafts.map((d) => `${d.local_id}:${d.status}`).join(",");
  const day = useDaySessions(row.id, again);
  const copied = useCopiedTimers();
  const running = runningOn(row.id, {
    drafts: timerDrafts,
    read: day.complete ? day.sessions : null,
    copy: copied?.rows ?? null,
    readAt: day.readAt,
    copyAt: copied?.readAt ?? null,
  });
  const now = useSecond(running.length > 0);
  const [showSessions, setShowSessions] = useState(false);
  const [sevenDays, setSevenDays] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conflicted = useDraftWithCommand(
    row.attention !== null && timerKind(row.attention.kind)
      ? row.attention.local_id
      : null,
  );
  const attention =
    row.attention !== null &&
    (row.attention.kind === "start_timer" ||
      row.attention.kind === "stop_timer" ||
      row.attention.kind === "cancel_timer") &&
    (row.attention.status === "version_conflict" ||
      row.attention.status === "rejected")
      ? row.attention
      : null;
  if (!isTimerGoal(row.data))
    return (
      <p className="text-[12.5px] text-ink-2" data-timer-block="unused">
        {TIMER_COPY.notUsed}
      </p>
    );
  const block = startBlock({
    data: row.data,
    nowMs: now,
    mayRecord:
      row.streamPresent ||
      row.streamPending ||
      (row.data.definition.participation === "anyone" && row.canEdit),
    running,
  });
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(() =>
      actions.enqueue(
        startTimer({
          occurrenceId: row.id,
          sessionId: env.newId(),
          progressId: row.progressId,
          startedAt: Math.floor(env.now() / 1000),
          firstAnyoneStream:
            row.data.definition.participation === "anyone" &&
            !row.streamPresent &&
            !row.streamPending,
          defaults,
        }),
        TIMER_COPY.saved,
      ),
    );
  const end = (session: RunningSession, stoppedAt: number | null) =>
    run(() => {
      const input = {
        occurrenceId: row.id,
        sessionId: session.id,
        progressId: row.progressId,
        streamKnown: row.streamPresent || row.streamPending,
        knownVersion: session.source === "draft" ? null : session.version,
      };
      return actions.enqueue(
        stoppedAt === null
          ? cancelTimer(input)
          : stopTimer({ ...input, stoppedAt }),
        TIMER_COPY.saved,
      );
    });
  const stop = (session: RunningSession) => {
    const choice = stopChoice(session, row.data, env.now());
    if (choice.kind === "seven_days") {
      setSevenDays(session.id);
      return;
    }
    void end(session, choice.stoppedAt);
  };
  const disabled = !writable ? copy.NOT_WRITABLE : busy ? copy.SAVING : null;
  const conflictKind = attention?.kind;
  // A refused stop: whether its duration explains it (more than the 7 days one session can record), from the sent body and the session.
  const sent =
    conflicted.status === "ready" && conflicted.value !== null
      ? timerCommandOf(conflicted.value)
      : null;
  const startedOf = (id: string) =>
    day.sessions.find((x) => x.id === id)?.started_at ??
    copied?.rows.find((x) => x.id === id)?.started_at ??
    null;
  const conflictStop =
    sent !== null && sent.kind === "stop_timer" && sent.at !== null
      ? {
          overSeven:
            startedOf(sent.session) !== null &&
            sent.at - (startedOf(sent.session) as number) > SEVEN_DAYS,
        }
      : null;
  const unmet =
    conflictKind === "stop_timer" && deps.read.kind === "ready"
      ? progressOf(deps.read.preview, row.id).firstOpen !== null
      : false;
  return (
    <section
      aria-labelledby={heading}
      data-timer-block={running.length > 0 ? "running" : "idle"}
      className="flex flex-col gap-3 rounded-row border border-hairline-strong bg-panel p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={heading} className="text-[15px] font-medium text-ink-1">
          {TIMER_COPY.heading}
        </h2>
        <Link
          to="/tasks/timers"
          className="atlas-transition inline-flex min-h-11 items-center text-[13px] text-ink-2 hover:text-ink-1"
        >
          {TIMER_COPY.yourTimers}
        </Link>
      </div>
      {attention !== null ? (
        <div
          data-timer-conflict={attention.local_id}
          className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
        >
          <p className="text-[13px] text-ink-1">{TIMER_COPY.conflictTitle}</p>
          {conflictStop !== null &&
          attention.status === "rejected" &&
          conflictStop.overSeven ? (
            <p className="text-[12.5px] text-ink-2">{TIMER_COPY.sevenDays}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setShowSessions(true)}>
              {TIMER_COPY.review}
            </Button>
            {unmet ? <Button onClick={onSee}>{TIMER_COPY.see}</Button> : null}
            <Button
              onClick={() => void data.outbox()?.discard(attention.local_id)}
            >
              {TIMER_COPY.discard}
            </Button>
          </div>
        </div>
      ) : null}
      {running.map((session) => {
        const mark = session.startDraft
          ? MARK[session.startDraft.status]
          : undefined;
        return (
          <div
            key={session.id}
            className="flex flex-col gap-2"
            data-timer-session={session.id}
            data-timer-source={session.source}
          >
            <p className="text-[13px] text-ink-2">
              {TIMER_COPY.running} ·{" "}
              {TIMER_COPY.startedAt(
                momentLabel(session.startedAt * 1000, now, zone),
              )}
              {mark ? ` · ${copy.PENDING[mark]}` : ""}
            </p>
            <p
              className="font-num text-[22px] text-ink-1 tabular-nums"
              data-timer-elapsed=""
            >
              {elapsed(session.startedAt, now)}
            </p>
            {session.source === "copy" && copied ? (
              <p className="text-[12px] text-ink-2">
                {TIMER_COPY.lastChecked(momentLabel(copied.readAt, now, zone))}
              </p>
            ) : session.source === "read" && day.keptAt !== null ? (
              <p className="text-[12px] text-ink-2">
                {TIMER_COPY.lastChecked(momentLabel(day.keptAt, now, zone))}
              </p>
            ) : null}
            {sevenDays === session.id ? (
              <div className="flex flex-col gap-2" data-timer-seven-days="">
                <p className="text-[12.5px] text-ink-2">
                  {TIMER_COPY.sevenDays}
                </p>
                <span className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setSevenDays(null);
                      void end(session, session.startedAt + SEVEN_DAYS);
                    }}
                  >
                    {TIMER_COPY.recordSeven}
                  </Button>
                  <Button
                    onClick={() => {
                      setSevenDays(null);
                      void end(session, null);
                    }}
                  >
                    {TIMER_COPY.discardSession}
                  </Button>
                </span>
              </div>
            ) : (
              <span className="flex flex-wrap gap-2">
                {disabled ? (
                  <Button disabled reason={disabled}>
                    {TIMER_COPY.stop}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => stop(session)}>
                    {TIMER_COPY.stop}
                  </Button>
                )}
                {disabled ? null : (
                  <Button onClick={() => void end(session, null)}>
                    {TIMER_COPY.discard}
                  </Button>
                )}
              </span>
            )}
            {stopChoice(session, row.data, now).kind === "closed" &&
            row.data.closes_at !== null ? (
              <p className="text-[12px] text-ink-2">
                {TIMER_COPY.closedDay(
                  momentLabel(row.data.closes_at * 1000, now, zone),
                )}
              </p>
            ) : null}
          </div>
        );
      })}
      {running.length === 0 ? (
        <span>
          {block !== null ? (
            <Button disabled reason={TIMER_COPY.blocked[block]}>
              {TIMER_COPY.start}
            </Button>
          ) : disabled ? (
            <Button disabled reason={disabled}>
              {TIMER_COPY.start}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void start()}>
              {TIMER_COPY.start}
            </Button>
          )}
        </span>
      ) : null}
      <span>
        <Button variant="quiet" onClick={() => setShowSessions((v) => !v)}>
          {showSessions ? TIMER_COPY.hideSessions : TIMER_COPY.sessions}
        </Button>
      </span>
      {showSessions ? (
        <div className="flex flex-col gap-1.5" data-timer-sessions={day.status}>
          {day.status === "offline" ? (
            <p className="text-[12.5px] text-ink-2">
              {TIMER_COPY.sessionsOffline}
            </p>
          ) : day.status === "loading" ? (
            <div aria-busy="true" className="min-h-10 rounded-row bg-raised" />
          ) : day.status === "error" ? (
            <div className="flex flex-col gap-1">
              <p className="text-[12.5px] text-ink-2">
                {TIMER_COPY.sessionsFailed}
              </p>
              {day.requestId ? (
                <p className="select-all font-num text-[12px] text-ink-2">
                  {copy.REQUEST_ID(day.requestId)}
                </p>
              ) : null}
              <span>
                <Button onClick={day.retry}>{copy.TRY_AGAIN}</Button>
              </span>
            </div>
          ) : day.sessions.length === 0 ? (
            <p className="text-[12.5px] text-ink-2">
              {TIMER_COPY.sessionsEmpty}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {day.sessions.map((s) => {
                const startText = momentLabel(s.started_at * 1000, now, zone);
                return (
                  <li
                    key={s.id}
                    className="text-[13px] text-ink-1"
                    data-day-session={s.id}
                  >
                    {s.stopped_at === null
                      ? TIMER_COPY.sessionRunning(startText)
                      : TIMER_COPY.sessionRow(
                          startText,
                          momentLabel(s.stopped_at * 1000, now, zone),
                          elapsed(s.started_at, s.stopped_at * 1000),
                        )}
                  </li>
                );
              })}
            </ul>
          )}
          {day.more ? (
            <span>
              <Button variant="quiet" onClick={day.more}>
                {TIMER_COPY.loadMore}
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

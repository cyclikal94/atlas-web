import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../../components/ui/button";
import {
  commitTimerCorrection,
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
  copyCorrection,
  dayObservation,
  elapsed,
  isTimerGoal,
  keptStands,
  type RunningSession,
  runningOn,
  SEVEN_DAYS,
  type StartBlock,
  startBlock,
  stopChoice,
  timerCommandOf,
} from "../model/timers";
import {
  type IssuedRead,
  issueTimerRead,
  useTimerEvidence,
  withEndExpectation,
} from "../timers/copy";
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
 * The last read of each day's sessions this page ACCEPTED (page memory, never persisted), for the displayed identity only: offline, a
 * session this device saw running stays shown, marked with when it was read ("Last checked"), until the connection is back. A read that
 * had not reached the end of the day's list is kept as well, marked incomplete: what it lists is known (review R11), what it omits is
 * not. `issued` orders two readers of one day on this page (a remounted block): an earlier one never replaces a later one's entry.
 * A kept read belongs to the database it was ordered in (revision 3, DA-T3): once another incarnation is bound, it is not shown (its
 * order means nothing there, and what retired its sessions there cannot be seen).
 */
interface Kept {
  sessions: TimerSession[];
  /** ms, when the read's first page was issued. */
  at: number;
  /** Its place in the observation order (W28), or null. */
  order: number | null;
  complete: boolean;
  issued: number;
  /** The database incarnation the read was issued under, or null (none was bound). */
  incarnation: string | null;
}
const lastRead = new Map<string, Kept>();
let lastReadFor = "";
let issuedSeq = 0;
function keptOf(identity: string) {
  if (lastReadFor !== identity) {
    lastRead.clear();
    lastReadFor = identity;
  }
  return lastRead;
}
function remember(identity: string, occurrenceId: string, entry: Kept) {
  const kept = keptOf(identity);
  const held = kept.get(occurrenceId);
  if (held !== undefined && held.issued > entry.issued) return;
  kept.delete(occurrenceId);
  kept.set(occurrenceId, entry);
  if (kept.size > 200) {
    const oldest = kept.keys().next().value;
    if (oldest !== undefined) kept.delete(oldest);
  }
}

/** The pages one read has accepted, and whether its next page is on its way (one at a time). */
interface Chain {
  owner: number;
  pages: TimerSession[][];
  next: string | null;
  loading: boolean;
  askedAt: number;
  issued: number;
  read: IssuedRead | null;
  incarnation: string | null;
}

/**
 * What the latest read of the day ACCEPTED, as one value (revision 7, review R31): its pages and cursor, and where it was issued (its place
 * in the observation order, the database incarnation, when). Kept apart from how the newest request is doing: a request that fails (a
 * further page, or a first page asked again) changes none of it, so the same rows never lose the order that lets a later observation
 * retire them, and a failure is never taken for a read with no order. Only another read's accepted first page replaces it, with its own.
 */
interface Accepted {
  pages: TimerSession[][];
  next: string | null;
  /** When the read's FIRST page was issued (ms): a later page cannot make it newer than that. */
  askedAt: number;
  /** Its place in the observation order (W28), or null: the read genuinely had none (no open service, a store failure at issue). */
  order: number | null;
  /** The database incarnation it was issued under, or null (none was bound). */
  incarnation: string | null;
}

/**
 * The day's own sessions (`GET /occurrences/{id}/timers`, online, 50 a page): what tells a running session apart on this device.
 *
 * ONE read owns what this shows (review R10): a new read (mount, another identity, day, connection or answered draft, Retry) takes over
 * at once, so an answer to an earlier one, success or failure, is dropped before it reaches the screen, the page memory or the copy; and
 * a further page is accepted only for the chain and cursor that asked for it, one at a time. Each accepted page corrects the copy (W28)
 * under the read's place in the observation order: a session it lists finished, and, once complete, one it does not list; and records
 * what it observed of the day (its scope, revision 3), for every page of this database. What was accepted keeps its provenance whatever
 * happens to a later request (revision 7, R31); one ordered in another database incarnation than the one bound now decides nothing here,
 * and the day is read again.
 */
function useDaySessions(occurrenceId: string, again: string) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const store = data.serviceStore;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const current = useCallback(() => store.get(), [store]);
  const service = useSyncExternalStore(subscribe, current, current);
  const [state, setState] = useState<{
    scope: string;
    accepted: Accepted | null;
    status: "loading" | "ready" | "error" | "offline";
    requestId?: string;
  }>({ scope: "", accepted: null, status: "loading" });
  const scope = `${env.identity}\u0000${occurrenceId}`;
  const owner = useRef(0);
  const chain = useRef<Chain | null>(null);
  const load = async (after: string | null) => {
    const identity = env.identity;
    let link: Chain;
    if (after === null) {
      owner.current += 1;
      const mine = owner.current;
      chain.current = null;
      if (!env.online) {
        setState({ scope, accepted: null, status: "offline" });
        return;
      }
      issuedSeq += 1;
      link = {
        owner: mine,
        pages: [],
        next: null,
        loading: true,
        askedAt: env.now(),
        issued: issuedSeq,
        read: null,
        incarnation: data.service()?.incarnationId ?? null,
      };
      chain.current = link;
      link.read = await issueTimerRead(data, identity);
      if (owner.current !== mine) return;
      if (link.read !== null)
        link.incarnation = link.read.service.incarnationId;
    } else {
      const held = chain.current;
      if (
        held === null ||
        held.owner !== owner.current ||
        held.next !== after ||
        held.loading
      )
        return;
      held.loading = true;
      link = held;
    }
    const result = await env.api.readTimers(occurrenceId, after ?? undefined);
    noteIfRefused(identity, `timers:${occurrenceId}`, result);
    if (owner.current !== link.owner || chain.current !== link) return;
    link.loading = false;
    if (!result.ok) {
      const requestId =
        "requestId" in result && result.requestId
          ? { requestId: result.requestId }
          : {};
      // What was accepted stays as it was accepted (positive rows, their order and completeness); nothing new is known.
      setState((prev) => ({
        scope,
        accepted: prev.scope === scope ? prev.accepted : null,
        status: "error",
        ...requestId,
      }));
      return;
    }
    link.pages = [...link.pages, result.value.items];
    link.next = result.value.next_after;
    const sessions = link.pages.flat();
    const complete = link.next === null;
    const order = link.read?.order ?? null;
    setState({
      scope,
      accepted: {
        pages: link.pages,
        next: link.next,
        askedAt: link.askedAt,
        order,
        incarnation: link.incarnation,
      },
      status: "ready",
    });
    remember(identity, occurrenceId, {
      sessions,
      at: link.askedAt,
      order,
      complete,
      issued: link.issued,
      incarnation: link.incarnation,
    });
    const read = link.read;
    if (read !== null && data.service() === read.service)
      void commitTimerCorrection(data, read.service, read.captured, {
        order: read.order,
        drop: copyCorrection(occurrenceId, sessions, complete),
        scope: dayObservation(occurrenceId, sessions, complete),
      });
  };
  const shown = state.scope === scope ? state : null;
  const bound = service?.incarnationId ?? null;
  // A read ordered in another database incarnation than the one bound now: its order means nothing here and what retired its sessions
  // there cannot be seen (DA-T3), so it is not shown, never shown as unordered (revision 7, R31), and the day is read again.
  const foreign =
    shown?.accepted != null &&
    shown.accepted.incarnation !== null &&
    bound !== null &&
    shown.accepted.incarnation !== bound;
  const accepted = foreign ? null : (shown?.accepted ?? null);
  const next = accepted?.next ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for another identity, day, connection or answered draft
  useEffect(() => {
    void load(null);
    return () => {
      owner.current += 1;
    };
  }, [scope, env.online, again]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again once when another binding replaced the one the read was ordered in
  useEffect(() => {
    if (foreign) void load(null);
  }, [foreign]);
  const held =
    shown?.status === "offline"
      ? (keptOf(env.identity).get(occurrenceId) ?? null)
      : null;
  // A read kept from another database incarnation is not shown (DA-T3).
  const kept = keptStands(held, bound) ? held : null;
  return {
    status: foreign ? "loading" : (shown?.status ?? "loading"),
    requestId: shown?.requestId,
    /** Every session accepted (the kept read's offline): positive knowledge, complete or not. */
    sessions:
      kept !== null ? kept.sessions : accepted ? accepted.pages.flat() : [],
    /** The accepted read reached the end of the day's list (whatever a later request did since). */
    complete:
      kept !== null
        ? kept.complete
        : accepted !== null && accepted.next === null,
    /** When the sessions shown offline were read (ms), or null for a read now. */
    keptAt: kept?.at ?? null,
    /** The shown read's place in the observation order (W28), as it was issued; null only for a read that had none. */
    order: kept !== null ? kept.order : (accepted?.order ?? null),
    /** The database incarnation bound now: what an end acted on is checked against it (revision 7, R32). */
    bound,
    more: next !== null ? () => void load(next) : null,
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
  // The copy, the day's scope and the floor of ONE snapshot (revision 4, review R19); none read yet: no ordered positive is trusted.
  const evidence = useTimerEvidence();
  const copied = evidence.copy;
  const running = runningOn(row.id, {
    drafts: timerDrafts,
    read: day.sessions,
    complete: day.complete,
    copy: copied?.rows ?? null,
    readOrder: day.order,
    copyOrder: copied?.order ?? null,
    copyComplete: copied?.complete ?? false,
    scope: evidence.authority?.scopes[row.id] ?? null,
    floor: evidence.authority?.floor ?? Number.POSITIVE_INFINITY,
    // The account's latest complete observation and every session listed finished (revision 5, review R23), as the account's list.
    account: evidence.authority?.account ?? null,
    ended: evidence.authority?.ended ?? new Set(),
    endedLost: evidence.authority?.endedLost ?? false,
    // Revision 6 (R27): a lost finished session distrusts every positive up to and including its order (`positiveTrusted`).
    endedThrough: evidence.authority?.endedThrough ?? 0,
  });
  const now = useSecond(running.length > 0);
  const [showSessions, setShowSessions] = useState(false);
  const [sevenDays, setSevenDays] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
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
  // One act at a time, also between a press and the render that shows it busy (a second activation of the same control admits nothing).
  const run = async (fn: () => Promise<unknown>) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      acting.current = false;
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
  // Stop, Discard and both 7-day choices end what was SHOWN (revision 7, review R32): the writing transaction admits the end only if that
  // observation still stands against what is stored then (`withEndExpectation`), so a retirement another page stored before the press, whose
  // notification has not reached this screen, queues nothing. The database it was observed in is the one bound when it was shown.
  const shownIn = day.bound;
  const end = (session: RunningSession, stoppedAt: number | null) =>
    run(() => {
      const input = {
        occurrenceId: row.id,
        sessionId: session.id,
        progressId: row.progressId,
        streamKnown: row.streamPresent || row.streamPending,
        knownVersion: session.source === "draft" ? null : session.version,
      };
      const request =
        stoppedAt === null
          ? cancelTimer(input)
          : stopTimer({ ...input, stoppedAt });
      return actions.enqueue(
        // None bound when it was shown: nothing it was observed in can be confirmed, so the transaction refuses it.
        withEndExpectation(
          request,
          { occurrenceId: row.id, sessionId: session.id, order: session.order },
          shownIn ?? "",
        ),
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

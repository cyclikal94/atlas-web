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
import { GroupedBox, GroupedSection } from "../../../components/ui/grouped";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type AccountService,
  commitTimerCopy,
  commitTimerEnded,
  readResourcesNow,
  readTimerAuthorityNow,
  TIMER_COPY_ROWS,
  useAllOutstandingByKind,
  useCachedResources,
  useDataEnv,
} from "../../../data";
import { useTaskActions } from "../actions";
import * as copy from "../copy";
import { MARK, TIMER_COPY } from "../detail/Timer";
import { useTasksEnv } from "../env";
import { dayLabel, momentLabel } from "../format";
import { noteIfRefused } from "../memory";
import { cancelTimer, stopTimer } from "../model/commands";
import {
  type AccountTimerSession,
  type OccurrenceData,
  parseOccurrenceData,
} from "../model/contract";
import { progressId } from "../model/ids";
import {
  elapsed,
  SEVEN_DAYS,
  type StopChoice,
  stillRunning,
  stopChoice,
  timerCommandOf,
} from "../model/timers";
import { taskPath } from "../route";
import type { PendingMark } from "../view";
import {
  authorityOf,
  epochOf,
  type IssuedRead,
  issueTimerRead,
  useTimerEvidence,
  withEndExpectation,
} from "./copy";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const TIMERS_COPY = {
  title: "Your timers",
  back: "‹ Tasks",
  running: "Running",
  history: "Earlier sessions",
  empty: "No timers yet.",
  noRunning: "Nothing is running.",
  failed: "Couldn't load these timers.",
  historyOffline: "Session history is shown when you're online.",
  restricted: "Restricted — sharing changed since this session",
  restrictedWhy: "It can't be stopped until access is restored.",
  loading: "Loading your timers",
  loadMore: "Load more",
  times: (start: string, end: string | null) =>
    end === null ? `Started ${start}` : `${start} – ${end}`,
  lastChecked: (time: string) => `Running timers as last checked ${time}`,
  noTitle: "A task not on this device",
} as const;

const PAGE = 50;
const TIMER_KINDS = ["start_timer", "stop_timer", "cancel_timer"];

type Section =
  | { kind: "loading" }
  | { kind: "offline" }
  | {
      kind: "ready";
      rows: AccountTimerSession[];
      next: string | null;
      more: "idle" | "loading" | "error";
      /** The read's place in the observation order (W29; its first page's, for every page of it), or null (review R19). */
      order: number | null;
      /**
       * The database incarnation it was ordered in, or null (none was bound). Its order means nothing in another one (revision 5, R23):
       * once another is bound, its rows are not shown and the list is read again.
       */
      incarnation: string | null;
    }
  | { kind: "error"; requestId?: string };

/** Pages of one state, the later row superseding an earlier one of the same id (the contract's rule for overlapping pages). */
const merge = (
  rows: readonly AccountTimerSession[],
  page: readonly AccountTimerSession[],
) => {
  const ids = new Set(page.map((r) => r.id));
  return [...rows.filter((r) => !ids.has(r.id)), ...page];
};

/**
 * One state of the account's sessions, paged. ONE read owns what it shows (review R10): a new read (mount, identity, connection, a change
 * of mine, Retry) takes over at once, so an earlier read's answer, success or failure, is dropped before it reaches the screen or the
 * copy, and a further page is accepted only for the read and cursor that asked for it, one at a time. Running and stopped are separate.
 */
function useSection(state: "running" | "stopped", again: string) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const store = data.serviceStore;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const current = useCallback(() => store.get(), [store]);
  const bound = useSyncExternalStore(subscribe, current, current);
  const [section, setSection] = useState<{ scope: string; value: Section }>({
    scope: "",
    value: { kind: "loading" },
  });
  const scope = `${env.identity}\u0000${state}`;
  const owner = useRef(0);
  const chain = useRef<{
    owner: number;
    next: string | null;
    loading: boolean;
    incarnation: string | null;
  } | null>(null);
  const load = async (after: string | null) => {
    const identity = env.identity;
    let link: {
      owner: number;
      next: string | null;
      loading: boolean;
      incarnation: string | null;
    };
    // The running list's first page is the copy this device keeps (W29): its place in the observation order is taken at ISSUE.
    let issued: IssuedRead | null = null;
    // A history read's stamp at issue (revision 5, R23): what it lists finished is recorded only for the binding it was asked under.
    let history: {
      service: AccountService;
      captured: ReturnType<AccountService["capture"]>;
    } | null = null;
    const readAt = env.now();
    if (after === null) {
      owner.current += 1;
      const mine = owner.current;
      chain.current = null;
      if (!env.online) {
        setSection({ scope, value: { kind: "offline" } });
        return;
      }
      link = { owner: mine, next: null, loading: true, incarnation: null };
      chain.current = link;
      if (state === "running") {
        issued = await issueTimerRead(data, identity);
        if (owner.current !== mine) return;
      }
      link.incarnation =
        issued?.service.incarnationId ?? data.service()?.incarnationId ?? null;
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
    if (state === "stopped") {
      const service = data.service();
      if (service)
        history = { service, captured: service.capture(epochOf(identity)) };
    }
    const result = await env.api.readAccountTimers({
      state,
      limit: PAGE,
      ...(after === null ? {} : { after }),
    });
    noteIfRefused(identity, `timer-sessions:${state}`, result);
    if (owner.current !== link.owner || chain.current !== link) return;
    link.loading = false;
    if (!result.ok) {
      setSection((prev) =>
        after !== null && prev.scope === scope && prev.value.kind === "ready"
          ? { scope, value: { ...prev.value, more: "error" } }
          : {
              scope,
              value: {
                kind: "error",
                ...("requestId" in result && result.requestId
                  ? { requestId: result.requestId }
                  : {}),
              },
            },
      );
      return;
    }
    link.next = result.value.next_after;
    setSection((prev) => {
      const first =
        after === null || prev.scope !== scope || prev.value.kind !== "ready";
      return {
        scope,
        value: {
          kind: "ready",
          rows: first
            ? result.value.items
            : merge(
                (prev.value as Extract<Section, { kind: "ready" }>).rows,
                result.value.items,
              ),
          next: result.value.next_after,
          more: "idle",
          order: first
            ? (issued?.order ?? null)
            : (prev.value as Extract<Section, { kind: "ready" }>).order,
          incarnation: link.incarnation,
        },
      };
    });
    // Every accepted page of the history is evidence for every source (revision 5, review R23): a session it lists finished never runs
    // again, so it is recorded (and taken out of the copy), for this tab's list offline, other tabs, the detail and a reload.
    if (history !== null && data.service() === history.service) {
      const ids = result.value.items.map((row) => row.id);
      if (ids.length > 0)
        void commitTimerEnded(data, history.service, history.captured, ids);
    }
    // Every accepted FIRST page of the running list is the copy this device keeps (bounded), for a reload offline.
    if (issued !== null && data.service() === issued.service)
      void commitTimerCopy(data, issued.service, issued.captured, {
        format: 2,
        order: issued.order,
        read_at: readAt,
        complete: result.value.next_after === null,
        running: result.value.items.slice(0, TIMER_COPY_ROWS) as never,
      });
  };
  // A read ordered in another database incarnation than the one bound now is not shown, and the list is read again (revision 5, R23).
  const held = section.scope === scope ? section.value : null;
  const rebound =
    held?.kind === "ready" &&
    held.incarnation !== null &&
    bound !== null &&
    held.incarnation !== bound.incarnationId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for another identity, a connection or a change of mine
  useEffect(() => {
    void load(null);
    return () => {
      owner.current += 1;
    };
  }, [scope, env.online, again]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again once when another binding replaced the one the read was ordered in
  useEffect(() => {
    if (rebound) void load(null);
  }, [rebound]);
  const value = held !== null && !rebound ? held : { kind: "loading" as const };
  return {
    value,
    more:
      value.kind === "ready" && value.next !== null
        ? () => {
            const next = value.next;
            if (chain.current?.next !== next || chain.current.loading) return;
            setSection((prev) =>
              prev.value.kind === "ready"
                ? { ...prev, value: { ...prev.value, more: "loading" } }
                : prev,
            );
            void load(next);
          }
        : null,
    retry: () => void load(null),
  };
}

/** What a person does to a running row: Stop (which may first ask about the 7 days), Discard, or "Record the first 7 days". */
type Act = (
  row: AccountTimerSession & { access: "available" },
  what: "stop" | "discard" | "seven_days",
) => void;

/**
 * How a stop of `row` is recorded now: the detail's rule (`stopChoice`) when its day is on this device; otherwise only the 7-day cap is
 * known (no window to close at).
 */
function choiceFor(
  row: Pick<AccountTimerSession, "started_at">,
  data: OccurrenceData | null,
  nowMs: number,
): StopChoice {
  const session = { startedAt: row.started_at };
  if (data !== null) return stopChoice(session, data, nowMs);
  const now = Math.max(Math.floor(nowMs / 1000), row.started_at + 1);
  return now - row.started_at > SEVEN_DAYS
    ? { kind: "seven_days", capped: row.started_at + SEVEN_DAYS }
    : { kind: "now", stoppedAt: now };
}

function SessionRow({
  row,
  nowMs,
  zone,
  offlineTitle,
  act,
  choosing = false,
  pending,
  disabled = null,
  closedAt = null,
}: {
  row: AccountTimerSession;
  nowMs: number;
  zone: string;
  /** Offline from the copy: the title only while its day is still in this device's cache, otherwise restricted. */
  offlineTitle?: string | null;
  act: Act | null;
  /** The stop asked about the 7 days: "Record the first 7 days" or "Discard the session" (review R3: never truncated silently). */
  choosing?: boolean;
  /** A stop or discard of this session is on its way from this device: its mark, and no second one is offered. */
  pending?: PendingMark;
  /** Why a stop or discard cannot be made now (this page is saving one). */
  disabled?: string | null;
  /** Its day closes before now (`close_incomplete`): the time recorded is up to then (s). */
  closedAt?: number | null;
}) {
  const start = momentLabel(row.started_at * 1000, nowMs, zone);
  const end =
    row.stopped_at === null
      ? null
      : momentLabel(row.stopped_at * 1000, nowMs, zone);
  const restricted = row.access === "restricted" || offlineTitle === null;
  return (
    <li
      data-account-timer={row.id}
      data-access={restricted ? "restricted" : "available"}
      className="flex flex-col gap-1.5 py-3"
    >
      {restricted ? (
        <>
          <p className="text-sm font-medium text-muted-foreground">
            {TIMERS_COPY.restricted}
          </p>
          <p className="text-xs text-muted-foreground">
            {TIMERS_COPY.times(start, end)}
            {row.stopped_at === null
              ? ` · ${elapsed(row.started_at, nowMs)}`
              : ""}
          </p>
          {row.stopped_at === null ? (
            <p className="text-xs text-muted-foreground">
              {TIMERS_COPY.restrictedWhy}
            </p>
          ) : null}
        </>
      ) : row.access === "available" ? (
        <>
          <Link
            to={taskPath(row.task_id, row.occurrence_id)}
            className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm font-medium text-foreground underline underline-offset-2"
          >
            {offlineTitle ?? row.task_title}
          </Link>
          <p className="text-xs text-muted-foreground">
            {row.slot_date ? `${dayLabel(row.slot_date)} · ` : ""}
            {TIMERS_COPY.times(start, end)}
          </p>
          {row.stopped_at === null ? (
            <p className="font-num text-lg text-foreground tabular-nums">
              {elapsed(row.started_at, nowMs)}
            </p>
          ) : (
            <p className="font-num text-sm text-foreground tabular-nums">
              {elapsed(row.started_at, row.stopped_at * 1000)}
            </p>
          )}
          {row.stopped_at === null && pending !== undefined ? (
            <p
              className="text-xs text-muted-foreground"
              data-timer-pending={pending}
            >
              {copy.PENDING[pending]}
            </p>
          ) : row.stopped_at === null && row.can_modify && act !== null ? (
            choosing ? (
              <div className="flex flex-col gap-2" data-timer-seven-days="">
                <p className="text-xs text-muted-foreground">
                  {TIMER_COPY.sevenDays}
                </p>
                <span className="flex flex-wrap gap-2">
                  {disabled ? (
                    <Button disabled reason={disabled}>
                      {TIMER_COPY.recordSeven}
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      onClick={() => act(row, "seven_days")}
                    >
                      {TIMER_COPY.recordSeven}
                    </Button>
                  )}
                  {disabled ? null : (
                    <Button onClick={() => act(row, "discard")}>
                      {TIMER_COPY.discardSession}
                    </Button>
                  )}
                </span>
              </div>
            ) : (
              <span className="flex flex-wrap gap-2">
                {disabled ? (
                  <Button disabled reason={disabled}>
                    {TIMER_COPY.stop}
                  </Button>
                ) : (
                  <Button variant="default" onClick={() => act(row, "stop")}>
                    {TIMER_COPY.stop}
                  </Button>
                )}
                {disabled ? null : (
                  <Button onClick={() => act(row, "discard")}>
                    {TIMER_COPY.discard}
                  </Button>
                )}
              </span>
            )
          ) : null}
          {row.stopped_at === null && closedAt !== null ? (
            <p className="text-xs text-muted-foreground">
              {TIMER_COPY.closedDay(momentLabel(closedAt * 1000, nowMs, zone))}
            </p>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/**
 * The account's timers under B6 (D-10c-12, E-4): running first (`state=running`, paged), then earlier sessions (`state=stopped`, with
 * Load more). An available running row links to its day and offers Stop and Discard while `can_modify`, queued through the same
 * builders as the detail's; a restricted row shows its times only. Offline it shows the bounded copy of the last running read (W29),
 * each copied row's title only while its day is still in this device's cache (otherwise restricted); history is online only.
 */
export function TimersPage() {
  const env = useTasksEnv();
  const data = useDataEnv();
  const actions = useTaskActions();
  const heading = useId();
  const historyHeading = useId();
  const [asked, setAgain] = useState(0);
  // A stop or discard of mine (this tab's or another's) moving on its way, or leaving the outbox, is a change of mine: read again.
  const outstanding = useAllOutstandingByKind(TIMER_KINDS);
  const drafts = outstanding.status === "ready" ? outstanding.value.drafts : [];
  const again = `${asked}|${drafts.map((d) => `${d.local_id}:${d.status}`).join(",")}`;
  const running = useSection("running", again);
  const history = useSection("stopped", again);
  const evidence = useTimerEvidence();
  const copied = evidence.copy;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, []);
  const offline = running.value.kind === "offline";
  // Every running row, from the copy offline or the live list online, stands only by the detail's rule against the same snapshot
  // (revision 4, review R19): a later complete read of its day, a finished listing or the floor retires it; so does this page's own
  // history (a session listed stopped never runs again). What was read is kept as read; only what is shown is resolved.
  const stopped = new Set(
    history.value.kind === "ready" ? history.value.rows.map((r) => r.id) : [],
  );
  const stands = (row: AccountTimerSession, order: number | null) =>
    !stopped.has(row.id) &&
    stillRunning(
      evidence.authority,
      row.access === "available" ? row.occurrence_id : null,
      row.id,
      order,
    );
  const copiedRows = offline
    ? (copied?.rows ?? []).filter((r) => stands(r, copied?.order ?? null))
    : [];
  const runningRows =
    running.value.kind === "ready"
      ? running.value.rows.filter((r) =>
          stands(
            r,
            (running.value as Extract<Section, { kind: "ready" }>).order,
          ),
        )
      : [];
  const shownRunning = offline ? copiedRows : runningRows;
  // What an act may still end once its own reads are answered (review R19: a correction can land while it waits), with the order each
  // was seen at, so the act can judge it again against the authority stored by then (revision 5, review R23).
  const standing = useRef(new Map<string, number | null>());
  const shownOrder = offline
    ? (copied?.order ?? null)
    : running.value.kind === "ready"
      ? running.value.order
      : null;
  standing.current = new Map(shownRunning.map((r) => [r.id, shownOrder]));
  // The database what is shown was observed in (revision 7, R32): the live list's read, or the one bound (the copy is read from it).
  const shownIn = useRef("");
  shownIn.current =
    (offline
      ? null
      : running.value.kind === "ready"
        ? running.value.incarnation
        : null) ??
    data.service()?.incarnationId ??
    "";
  // The days of the running rows this device holds: a copied row's title offline, and every row's window (a closed day's stop).
  const cached = useCachedResources(
    shownRunning.flatMap((r) =>
      r.access === "available" ? [r.occurrence_id] : [],
    ),
  );
  const dataOf = (row: AccountTimerSession): OccurrenceData | null => {
    if (row.access !== "available" || cached.status !== "ready") return null;
    const day = cached.value[row.occurrence_id]?.merged;
    return day ? parseOccurrenceData(day.value) : null;
  };
  const offlineTitleOf = (row: AccountTimerSession): string | null => {
    if (row.access !== "available") return null;
    const day =
      cached.status === "ready" ? cached.value[row.occurrence_id] : null;
    return day ? row.task_title : null;
  };
  // A stop or discard this device has on its way (review R3): the session shows its mark and is not offered another, as on the detail.
  const ending = new Map<string, PendingMark>();
  for (const d of drafts) {
    const t = timerCommandOf(d);
    const mark = MARK[d.status];
    if (t !== null && t.kind !== "start_timer" && mark !== undefined)
      ending.set(t.session, mark);
  }
  // One act at a time, and the 7-day question asked before anything is queued (review R3: the detail's choice, at both entry points).
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const act: Act = async (row, what) => {
    if (busy) return;
    setBusy(true);
    // Taken at the press, with the order the row was shown at (below): what the act ends was observed in this database.
    const incarnation = shownIn.current;
    try {
      const stream = await progressId(row.occurrence_id, env.accountId);
      const held = await readResourcesNow(data, [stream, row.occurrence_id]);
      const day = held?.get(row.occurrence_id)?.merged;
      const parsed = day ? parseOccurrenceData(day.value) : null;
      // Retired while this waited: nothing is queued (the row has gone from the screen with its actions). Judged again against the
      // authority as stored NOW (revision 5, R23), so a correction committed whose watch has not reached this screen yet counts too.
      const service = data.service();
      const stored =
        service === null || service === undefined
          ? undefined
          : await readTimerAuthorityNow(service);
      const order = standing.current.get(row.id);
      if (
        order === undefined ||
        stored === undefined ||
        !stillRunning(authorityOf(stored), row.occurrence_id, row.id, order) ||
        !standing.current.has(row.id)
      ) {
        setChoosing(null);
        return;
      }
      const input = {
        occurrenceId: row.occurrence_id,
        sessionId: row.id,
        progressId: stream,
        streamKnown: held?.has(stream) ?? false,
        knownVersion: row.version,
      };
      // The re-check above is this screen's; the writing transaction checks again against what is stored THEN (revision 7, R32: any
      // retirement committed during the waits below, the quota's included, refuses the end), as the detail's ends are.
      const witness = {
        occurrenceId: row.occurrence_id,
        sessionId: row.id,
        order,
      };
      if (what === "discard") {
        setChoosing(null);
        await actions.enqueue(
          withEndExpectation(cancelTimer(input), witness, incarnation),
          TIMER_COPY.saved,
        );
        setAgain((n) => n + 1);
        return;
      }
      if (what === "seven_days") {
        setChoosing(null);
        await actions.enqueue(
          withEndExpectation(
            stopTimer({ ...input, stoppedAt: row.started_at + SEVEN_DAYS }),
            witness,
            incarnation,
          ),
          TIMER_COPY.saved,
        );
        setAgain((n) => n + 1);
        return;
      }
      const choice = choiceFor(row, parsed, env.now());
      if (choice.kind === "seven_days") {
        setChoosing(row.id);
        return;
      }
      await actions.enqueue(
        withEndExpectation(
          stopTimer({ ...input, stoppedAt: choice.stoppedAt }),
          witness,
          incarnation,
        ),
        TIMER_COPY.saved,
      );
      setAgain((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  const rowProps = (row: AccountTimerSession) => {
    const day = dataOf(row);
    const closed =
      day !== null &&
      day.closes_at !== null &&
      choiceFor(row, day, now).kind === "closed"
        ? day.closes_at
        : null;
    return {
      choosing: choosing === row.id,
      ...(ending.has(row.id) ? { pending: ending.get(row.id) } : {}),
      disabled: busy ? copy.SAVING : null,
      closedAt: closed,
    };
  };
  const historyRows = history.value.kind === "ready" ? history.value.rows : [];
  const nothing =
    running.value.kind === "ready" &&
    history.value.kind === "ready" &&
    runningRows.length === 0 &&
    historyRows.length === 0;
  return (
    <article className="flex max-w-[760px] flex-col gap-6" data-timers-page="">
      <div className="flex flex-col gap-2">
        <Link
          to="/tasks"
          search={{}}
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground hover:text-foreground"
        >
          {TIMERS_COPY.back}
        </Link>
        <PageHeading>{TIMERS_COPY.title}</PageHeading>
      </div>
      {nothing ? (
        <p className="text-sm text-muted-foreground" data-timers-empty="">
          {TIMERS_COPY.empty}
        </p>
      ) : null}
      <GroupedBox data-timers-sections="">
        <GroupedSection
          aria-labelledby={heading}
          data-timers-running={running.value.kind}
          dot={runningRows.length > 0 ? "success" : "muted"}
          heading={<h2 id={heading}>{TIMERS_COPY.running}</h2>}
        >
          {running.value.kind === "loading" ? (
            <div aria-busy="true" className="flex flex-col gap-2">
              <span className="sr-only">{TIMERS_COPY.loading}</span>
              {[0, 1].map((n) => (
                <div key={n} className="min-h-12 rounded-lg bg-card" />
              ))}
            </div>
          ) : running.value.kind === "error" ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">
                {TIMERS_COPY.failed}
              </p>
              {running.value.requestId ? (
                <p className="select-all font-num text-xs text-muted-foreground">
                  {copy.REQUEST_ID(running.value.requestId)}
                </p>
              ) : null}
              <span>
                <Button onClick={running.retry}>{copy.TRY_AGAIN}</Button>
              </span>
            </div>
          ) : offline ? (
            <>
              {copied ? (
                <p className="text-xs text-muted-foreground">
                  {TIMERS_COPY.lastChecked(
                    momentLabel(copied.readAt, now, zone),
                  )}
                </p>
              ) : null}
              {copiedRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {TIMERS_COPY.noRunning}
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                  {copiedRows.map((row) => (
                    <SessionRow
                      key={row.id}
                      row={row}
                      nowMs={now}
                      zone={zone}
                      offlineTitle={offlineTitleOf(row)}
                      act={
                        offlineTitleOf(row) === null || !env.writable
                          ? null
                          : (r, w) => void act(r, w)
                      }
                      {...rowProps(row)}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : runningRows.length === 0 ? (
            nothing ? null : (
              <p className="text-sm text-muted-foreground">
                {TIMERS_COPY.noRunning}
              </p>
            )
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {runningRows.map((row) => (
                <SessionRow
                  key={row.id}
                  row={row}
                  nowMs={now}
                  zone={zone}
                  act={env.writable ? (r, w) => void act(r, w) : null}
                  {...rowProps(row)}
                />
              ))}
            </ul>
          )}
          {running.more ? (
            <span>
              <Button variant="ghost" onClick={running.more}>
                {TIMERS_COPY.loadMore}
              </Button>
            </span>
          ) : null}
        </GroupedSection>
        <GroupedSection
          aria-labelledby={historyHeading}
          data-timers-history={history.value.kind}
          heading={<h2 id={historyHeading}>{TIMERS_COPY.history}</h2>}
        >
          {history.value.kind === "offline" ? (
            <p className="text-sm text-muted-foreground">
              {TIMERS_COPY.historyOffline}
            </p>
          ) : history.value.kind === "loading" ? (
            <div aria-busy="true" className="min-h-12 rounded-lg bg-card" />
          ) : history.value.kind === "error" ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">
                {TIMERS_COPY.failed}
              </p>
              <span>
                <Button onClick={history.retry}>{copy.TRY_AGAIN}</Button>
              </span>
            </div>
          ) : historyRows.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {historyRows.map((row) => (
                <SessionRow
                  key={row.id}
                  row={row}
                  nowMs={now}
                  zone={zone}
                  act={null}
                />
              ))}
            </ul>
          )}
          {history.more ? (
            <span>
              <Button variant="ghost" onClick={history.more}>
                {TIMERS_COPY.loadMore}
              </Button>
            </span>
          ) : null}
        </GroupedSection>
      </GroupedBox>
    </article>
  );
}

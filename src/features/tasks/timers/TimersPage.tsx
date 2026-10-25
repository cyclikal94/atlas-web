import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  commitTimerCopy,
  readResourcesNow,
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
  stopChoice,
  timerCommandOf,
} from "../model/timers";
import { taskPath } from "../route";
import type { PendingMark } from "../view";
import { useCopiedTimers } from "./copy";

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

function useSection(state: "running" | "stopped", again: number) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const [section, setSection] = useState<{ scope: string; value: Section }>({
    scope: "",
    value: { kind: "loading" },
  });
  const scope = `${env.identity}\u0000${state}`;
  const current = useRef(scope);
  current.current = scope;
  const load = async (after: string | null) => {
    if (!env.online) {
      setSection({ scope, value: { kind: "offline" } });
      return;
    }
    const service = data.service();
    // The stamp of the read's ISSUE: the copy it writes belongs to the binding it was asked under (W28).
    const captured = service?.capture(
      Number(env.identity.slice(env.identity.lastIndexOf(":") + 1)),
    );
    const readAt = env.now();
    const asked = scope;
    const result = await env.api.readAccountTimers({
      state,
      limit: PAGE,
      ...(after === null ? {} : { after }),
    });
    noteIfRefused(env.identity, `timer-sessions:${state}`, result);
    if (current.current !== asked) return;
    if (!result.ok) {
      setSection((prev) =>
        after !== null && prev.scope === asked && prev.value.kind === "ready"
          ? { scope: asked, value: { ...prev.value, more: "error" } }
          : {
              scope: asked,
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
    setSection((prev) => ({
      scope: asked,
      value: {
        kind: "ready",
        rows:
          after === null || prev.value.kind !== "ready"
            ? result.value.items
            : merge(prev.value.rows, result.value.items),
        next: result.value.next_after,
        more: "idle",
      },
    }));
    // Every successful FIRST page of the running list is the copy this device keeps (bounded), for a reload offline.
    if (
      state === "running" &&
      after === null &&
      service !== null &&
      service !== undefined &&
      captured !== undefined &&
      data.service() === service
    )
      void commitTimerCopy(data, service, captured, {
        format: 1,
        read_at: readAt,
        complete: result.value.next_after === null,
        running: result.value.items.slice(0, TIMER_COPY_ROWS) as never,
      });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for another identity, a connection or a change of mine
  useEffect(() => {
    void load(null);
  }, [scope, env.online, again]);
  const value =
    section.scope === scope ? section.value : { kind: "loading" as const };
  return {
    value,
    more:
      value.kind === "ready" && value.next !== null
        ? () => {
            setSection((prev) =>
              prev.value.kind === "ready"
                ? { ...prev, value: { ...prev.value, more: "loading" } }
                : prev,
            );
            void load(value.next);
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
      className="flex flex-col gap-1.5 rounded-row border border-hairline-strong bg-panel p-3"
    >
      {restricted ? (
        <>
          <p className="text-[13px] font-medium text-ink-2">
            {TIMERS_COPY.restricted}
          </p>
          <p className="text-[12.5px] text-ink-2">
            {TIMERS_COPY.times(start, end)}
            {row.stopped_at === null
              ? ` · ${elapsed(row.started_at, nowMs)}`
              : ""}
          </p>
          {row.stopped_at === null ? (
            <p className="text-[12px] text-ink-2">
              {TIMERS_COPY.restrictedWhy}
            </p>
          ) : null}
        </>
      ) : row.access === "available" ? (
        <>
          <Link
            to={taskPath(row.task_id, row.occurrence_id)}
            className="atlas-transition inline-flex min-h-11 w-fit items-center text-[14px] font-medium text-ink-1 underline underline-offset-2"
          >
            {offlineTitle ?? row.task_title}
          </Link>
          <p className="text-[12.5px] text-ink-2">
            {row.slot_date ? `${dayLabel(row.slot_date)} · ` : ""}
            {TIMERS_COPY.times(start, end)}
          </p>
          {row.stopped_at === null ? (
            <p className="font-num text-[17px] text-ink-1 tabular-nums">
              {elapsed(row.started_at, nowMs)}
            </p>
          ) : (
            <p className="font-num text-[13px] text-ink-1 tabular-nums">
              {elapsed(row.started_at, row.stopped_at * 1000)}
            </p>
          )}
          {row.stopped_at === null && pending !== undefined ? (
            <p className="text-[12px] text-ink-2" data-timer-pending={pending}>
              {copy.PENDING[pending]}
            </p>
          ) : row.stopped_at === null && row.can_modify && act !== null ? (
            choosing ? (
              <div className="flex flex-col gap-2" data-timer-seven-days="">
                <p className="text-[12.5px] text-ink-2">
                  {TIMER_COPY.sevenDays}
                </p>
                <span className="flex flex-wrap gap-2">
                  {disabled ? (
                    <Button disabled reason={disabled}>
                      {TIMER_COPY.recordSeven}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
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
                  <Button variant="primary" onClick={() => act(row, "stop")}>
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
            <p className="text-[12px] text-ink-2">
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
 * builders as the detail's; a restricted row shows its times only. Offline it shows the bounded copy of the last running read (W28),
 * each copied row's title only while its day is still in this device's cache (otherwise restricted); history is online only.
 */
export function TimersPage() {
  const env = useTasksEnv();
  const data = useDataEnv();
  const actions = useTaskActions();
  const heading = useId();
  const historyHeading = useId();
  const [again, setAgain] = useState(0);
  const running = useSection("running", again);
  const history = useSection("stopped", again);
  const copied = useCopiedTimers();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, []);
  const offline = running.value.kind === "offline";
  const copiedRows = offline ? (copied?.rows ?? []) : [];
  const shownRunning = offline
    ? copiedRows
    : running.value.kind === "ready"
      ? running.value.rows
      : [];
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
  const outstanding = useAllOutstandingByKind(TIMER_KINDS);
  const ending = new Map<string, PendingMark>();
  for (const d of outstanding.status === "ready"
    ? outstanding.value.drafts
    : []) {
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
    try {
      const stream = await progressId(row.occurrence_id, env.accountId);
      const held = await readResourcesNow(data, [stream, row.occurrence_id]);
      const day = held?.get(row.occurrence_id)?.merged;
      const parsed = day ? parseOccurrenceData(day.value) : null;
      const input = {
        occurrenceId: row.occurrence_id,
        sessionId: row.id,
        progressId: stream,
        streamKnown: held?.has(stream) ?? false,
        knownVersion: row.version,
      };
      if (what === "discard") {
        setChoosing(null);
        await actions.enqueue(cancelTimer(input), TIMER_COPY.saved);
        setAgain((n) => n + 1);
        return;
      }
      if (what === "seven_days") {
        setChoosing(null);
        await actions.enqueue(
          stopTimer({ ...input, stoppedAt: row.started_at + SEVEN_DAYS }),
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
        stopTimer({ ...input, stoppedAt: choice.stoppedAt }),
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
  const runningRows = running.value.kind === "ready" ? running.value.rows : [];
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
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13px] text-ink-2 hover:text-ink-1"
        >
          {TIMERS_COPY.back}
        </Link>
        <PageHeading>{TIMERS_COPY.title}</PageHeading>
      </div>
      {nothing ? (
        <p className="text-[13.5px] text-ink-2" data-timers-empty="">
          {TIMERS_COPY.empty}
        </p>
      ) : null}
      <section
        aria-labelledby={heading}
        className="flex flex-col gap-2"
        data-timers-running={running.value.kind}
      >
        <h2 id={heading} className="text-[14px] font-medium text-ink-1">
          {TIMERS_COPY.running}
        </h2>
        {running.value.kind === "loading" ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{TIMERS_COPY.loading}</span>
            {[0, 1].map((n) => (
              <div key={n} className="min-h-12 rounded-row bg-raised" />
            ))}
          </div>
        ) : running.value.kind === "error" ? (
          <div className="flex flex-col gap-1">
            <p className="text-[13px] text-ink-2">{TIMERS_COPY.failed}</p>
            {running.value.requestId ? (
              <p className="select-all font-num text-[12px] text-ink-2">
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
              <p className="text-[12px] text-ink-2">
                {TIMERS_COPY.lastChecked(momentLabel(copied.readAt, now, zone))}
              </p>
            ) : null}
            {copiedRows.length === 0 ? (
              <p className="text-[13px] text-ink-2">{TIMERS_COPY.noRunning}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
            <p className="text-[13px] text-ink-2">{TIMERS_COPY.noRunning}</p>
          )
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
            <Button variant="quiet" onClick={running.more}>
              {TIMERS_COPY.loadMore}
            </Button>
          </span>
        ) : null}
      </section>
      <section
        aria-labelledby={historyHeading}
        className="flex flex-col gap-2"
        data-timers-history={history.value.kind}
      >
        <h2 id={historyHeading} className="text-[14px] font-medium text-ink-1">
          {TIMERS_COPY.history}
        </h2>
        {history.value.kind === "offline" ? (
          <p className="text-[13px] text-ink-2">{TIMERS_COPY.historyOffline}</p>
        ) : history.value.kind === "loading" ? (
          <div aria-busy="true" className="min-h-12 rounded-row bg-raised" />
        ) : history.value.kind === "error" ? (
          <div className="flex flex-col gap-1">
            <p className="text-[13px] text-ink-2">{TIMERS_COPY.failed}</p>
            <span>
              <Button onClick={history.retry}>{copy.TRY_AGAIN}</Button>
            </span>
          </div>
        ) : historyRows.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
            <Button variant="quiet" onClick={history.more}>
              {TIMERS_COPY.loadMore}
            </Button>
          </span>
        ) : null}
      </section>
    </article>
  );
}

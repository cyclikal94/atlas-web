import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type CacheRow,
  type DraftWithCommand,
  readAllOutstandingNow,
  readCoherently,
  readResourcePageNow,
  readResourcesNow,
  type Stage,
  scanResources,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import type { TasksResult } from "../api";
import { useCatchUp } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel } from "../format";
import { useScopedRead } from "../local-read";
import { noteIfRefused } from "../memory";
import { pendingOn } from "../model/commands";
import {
  type OccurrenceData,
  parseDefinition,
  parseOccurrenceData,
  parseProgressState,
  type TaskDefinition,
  type TaskStreak,
} from "../model/contract";
import { personalResult } from "../model/evaluate";
import { progressId } from "../model/ids";
import type { StopReason } from "../model/materialise";
import {
  type Figure,
  figureOf,
  latestPeriods,
  opened,
  STRIP_PERIODS,
  type StripCell,
  type StripState,
  strip,
  tally,
  unitOf,
} from "../model/streak";
import { CATCH_UP_COPY } from "../today/CatchUpBanner";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const STREAK_COPY = {
  title: "How it's been going",
  back: (title: string) => `‹ ${title}`,
  link: "Streak",
  current: (n: number, unit: string) => `On a run of ${n} ${unit}`,
  longest: (n: number, unit: string) => `Best run ${n} ${unit}`,
  currentName: "Current run",
  longestName: "Best run",
  shared: "Shared",
  you: "You",
  withheld: "Withheld — someone keeps their part private",
  unknown: "Unknown",
  loading: "Loading how it's been going",
  error: "Couldn't load how it's been going.",
  offline: "Shown when you're online",
  catchingUp: "Working out the missing days…",
  stopped: "Couldn't work out the missing days",
  dayByDay: "Day by day",
  onDevice: "On this device",
  lastN: (unit: string, done: number, total: number, missed: number) =>
    `Last ${STRIP_PERIODS} ${unit}: ${done}/${total}, ${missed} missed`,
  nothing: "Nothing to show yet.",
  absent: "This task isn't on this device.",
  state: {
    done: "Done",
    missed: "Missed",
    open: "Still open",
    none: "No record",
    skipped: "Skipped",
  } satisfies Record<StripState, string>,
  undated: "No date",
} as const;

/** The mark beside each word, so colour is never the only signal. */
const MARK: Readonly<Record<StripState, string>> = {
  done: "✓",
  missed: "✕",
  open: "○",
  none: "–",
  skipped: "↷",
};
const TONE: Readonly<Record<StripState, string>> = {
  done: "bg-done text-action-on",
  missed: "bg-missed-tint border border-missed-edge text-ink-1",
  open: "bg-canvas border border-hairline-strong text-ink-1",
  none: "bg-inset text-ink-2",
  skipped: "bg-raised border border-dashed border-hairline-strong text-ink-2",
};

// ---- the device's strip -----------------------------------------------------------------------------------------------------------
interface LocalStreak {
  title: string | null;
  definition: TaskDefinition | null;
  cells: StripCell[];
}

/** One certified read (WEB-10a revision 3): the task, its details, its opened days and my streams and outstanding evidence for the last 30. */
async function readLocal(
  data: Parameters<typeof readResourcesNow>[0],
  taskId: string,
  me: string,
  nowMs: number,
  signal: AbortSignal,
): Promise<Stage<LocalStreak>> {
  const unread = (): Stage<never> => ({
    ok: false,
    why: signal.aborted ? "aborted" : "failed",
  });
  const task = await readResourcesNow(data, [taskId]);
  if (task === null) return unread();
  const taskRow = task.get(taskId)?.merged ?? null;
  const executions = await readResourcePageNow(data, {
    kind: "execution",
    parentId: taskId,
    limit: 1,
  });
  if (!executions.ok) return executions;
  const execution = executions.value.rows[0]?.merged ?? null;
  const definition = execution ? parseDefinition(execution.value) : null;
  if (taskRow === null || execution === null)
    return {
      ok: true,
      value: { title: taskRow?.label ?? null, definition, cells: [] },
    };
  // Keep only the latest 30 opened days while walking every saved day (the walk is bounded per window; F-1's cost applies).
  let kept: Array<{ id: string; data: OccurrenceData }> = [];
  const end = await scanResources(
    data,
    { kind: "occurrence", parentId: execution.id },
    (rows) => {
      for (const listed of rows) {
        const parsed = parseOccurrenceData(listed.merged.value);
        if (parsed === null || parsed.task_id !== taskId) continue;
        if (!opened(parsed, nowMs)) continue;
        kept.push({ id: listed.base.id, data: parsed });
      }
      kept = latestPeriods(kept, nowMs);
      return undefined;
    },
    signal,
  );
  if (end !== "complete") return unread();
  const latest = kept;
  const streams = await Promise.all(
    latest.map((day) => progressId(day.id, me)),
  );
  const rows = await readResourcesNow(data, streams);
  if (rows === null) return unread();
  const outstanding = await readAllOutstandingNow(data, [
    ...latest.map((d) => d.id),
    ...streams,
  ]);
  if (!outstanding.ok) return outstanding;
  const drafts = new Map<string, DraftWithCommand>();
  for (const entry of Object.values(outstanding.value))
    for (const d of entry.drafts) drafts.set(d.local_id, d);
  const ordered = [...drafts.values()].sort(
    (a, b) => a.created_seq - b.created_seq,
  );
  const cells = strip(
    latest.map((day, i) => {
      const stream = streams[i] as string;
      const row: CacheRow | null = rows.get(stream)?.merged ?? null;
      const state = row ? parseProgressState(row.value) : null;
      // What has landed in the synced stream is not layered again (F4; review R6).
      const pending = pendingOn(ordered, me, day.id, state);
      return {
        id: day.id,
        data: day.data,
        result: personalResult({
          occurrence: day.data,
          stream: state,
          pending,
          streamPending: pending.length > 0,
          me,
          nowMs,
        }),
      };
    }),
    nowMs,
  );
  return { ok: true, value: { title: taskRow.label, definition, cells } };
}

// ---- the server's figures ---------------------------------------------------------------------------------------------------------
type Read =
  | { kind: "loading" }
  | { kind: "ready"; streak: TaskStreak }
  | { kind: "error"; requestId?: string }
  | { kind: "catching_up" }
  | { kind: "stopped"; reason: StopReason; requestId?: string; day?: string }
  | { kind: "offline" };

const STREAK_READ = (taskId: string) => `streak:${taskId}`;
const requiresCatchUp = (result: TasksResult<TaskStreak>) =>
  !result.ok &&
  result.kind === "conflict" &&
  result.code === "materialisation_required";

/**
 * Both scopes, read for the displayed identity on the visit, on focus or show, when committed content changes and after a catch-up. A
 * `409 materialisation_required` asks the page's runner to catch the task up (trigger `streak`) and reads ONCE more when it has: a second
 * one in the same visit is a stop (no progress), never another catch-up. A stop of the sequence is shown with its reason and Try again.
 */
function useStreakFigures(taskId: string, shared: boolean) {
  const env = useTasksEnv();
  const { runner, state, records, discovery, discoveryRead } = useCatchUp();
  const position = useCachePosition();
  // Committed CONTENT asks again (WEB-10a decision 25); the position's first load is not a change.
  const revision =
    position.status === "ready"
      ? String(position.value?.appliedRevision ?? 0)
      : position.status === "unavailable" && position.reason === "absent"
        ? "none"
        : null;
  const [read, setRead] = useState<{ personal: Read; joint: Read | null }>({
    personal: { kind: "loading" },
    joint: shared ? { kind: "loading" } : null,
  });
  const [ask, setAsk] = useState(0);
  const generation = useRef(0);
  const visit = useRef({ caughtUp: false, asked: false, reread: false });
  // A new identity starts the visit's memory afresh.
  const identity = useRef(env.identity);
  if (identity.current !== env.identity) {
    identity.current = env.identity;
    visit.current = { caughtUp: false, asked: false, reread: false };
  }
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") setAsk((n) => n + 1);
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  const ran = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on a visit, a show, committed content or the person's Try again
  useEffect(() => {
    if (revision === null) return;
    // One read per reason (a replayed effect asks nothing more).
    const key = `${taskId}|${shared}|${env.online}|${env.identity}|${revision}|${ask}`;
    if (ran.current === key) return;
    ran.current = key;
    if (!env.online) {
      setRead({
        personal: { kind: "offline" },
        joint: shared ? { kind: "offline" } : null,
      });
      return;
    }
    generation.current += 1;
    const mine = generation.current;
    const asked = env.identity;
    const one = async (scope: "personal" | "joint"): Promise<Read> => {
      const result = await env.api.readStreak(taskId, scope);
      // A refusal is noted when it arrives (WEB-10a's consumer obligation).
      noteIfRefused(asked, STREAK_READ(taskId), result);
      if (result.ok) return { kind: "ready", streak: result.value };
      if (requiresCatchUp(result)) {
        if (visit.current.reread)
          return { kind: "stopped", reason: "no_progress" };
        return { kind: "catching_up" };
      }
      if (result.kind === "offline") return { kind: "offline" };
      return {
        kind: "error",
        ...("requestId" in result && result.requestId
          ? { requestId: result.requestId }
          : {}),
      };
    };
    void Promise.all([one("personal"), shared ? one("joint") : null]).then(
      ([personal, joint]) => {
        // Only the latest read of the displayed identity is shown (CM-384).
        if (generation.current !== mine || identity.current !== asked) return;
        setRead({ personal, joint });
      },
    );
  }, [taskId, shared, env.online, env.identity, revision, ask]);

  const waiting =
    read.personal.kind === "catching_up" || read.joint?.kind === "catching_up";
  const record =
    records.status === "ready"
      ? records.value
          .filter((r) => r.task_id === taskId)
          .sort((a, b) => b.through_date.localeCompare(a.through_date))[0]
      : undefined;
  // Ask the runner once per visit; read again once when it has finished (no live sequence for the task, none running here).
  useEffect(() => {
    if (!waiting || !env.online) return;
    if (!visit.current.asked) {
      visit.current.asked = true;
      runner.ensure(taskId, "streak");
      return;
    }
    const running =
      state.active.includes(taskId) ||
      (record !== undefined && record.phase !== "stopped");
    // A stopped discovery (review R13) is not a finished catch-up: it is shown, never read past (nor while its record is unread).
    const stopped =
      record?.phase === "stopped" ||
      !discoveryRead ||
      discovery[taskId]?.stop != null ||
      state.unrecorded.has(taskId);
    if (!running && !stopped && !visit.current.reread) {
      visit.current.reread = true;
      setAsk((n) => n + 1);
    }
  }, [
    waiting,
    env.online,
    state,
    record,
    discovery,
    discoveryRead,
    runner,
    taskId,
  ]);
  const stoppedRecord =
    waiting && record?.phase === "stopped" && record.stop !== null
      ? record
      : null;
  const discovered = discovery[taskId]?.stop;
  const memoryStop = !waiting
    ? undefined
    : discovered
      ? {
          reason: discovered.reason,
          ...(discovered.request_id
            ? { requestId: discovered.request_id }
            : {}),
        }
      : state.unrecorded.get(taskId);
  const stop: Read | null = stoppedRecord?.stop
    ? {
        kind: "stopped",
        reason: stoppedRecord.stop.reason,
        ...(stoppedRecord.stop.request_id
          ? { requestId: stoppedRecord.stop.request_id }
          : {}),
        day: stoppedRecord.through_date,
      }
    : memoryStop
      ? {
          kind: "stopped",
          reason: memoryStop.reason,
          ...(memoryStop.requestId ? { requestId: memoryStop.requestId } : {}),
        }
      : null;
  return {
    personal: stop ?? read.personal,
    joint: read.joint === null ? null : (stop ?? read.joint),
    retry: () => setAsk((n) => n + 1),
    tryAgain: (day?: string) => {
      visit.current.reread = false;
      runner.tryAgain(taskId, day);
    },
  };
}

function FigureText({
  figure,
  unit,
  kind,
}: {
  figure: Figure;
  unit: (n: number) => string;
  kind: "current" | "longest";
}) {
  if (figure.kind === "withheld") return <>{STREAK_COPY.withheld}</>;
  if (figure.kind === "unknown") return <>{STREAK_COPY.unknown}</>;
  return (
    <>
      {kind === "current"
        ? STREAK_COPY.current(figure.value, unit(figure.value))
        : STREAK_COPY.longest(figure.value, unit(figure.value))}
    </>
  );
}

function Tiles({
  name,
  read,
  scope,
  unit,
  retry,
  tryAgain,
}: {
  name: string | null;
  read: Read;
  scope: "joint" | "personal";
  unit: (n: number) => string;
  retry(): void;
  tryAgain(day?: string): void;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={name === null ? undefined : heading}
      aria-label={name === null ? STREAK_COPY.title : undefined}
      data-streak-scope={scope}
      data-streak-state={read.kind}
      className="flex flex-col gap-2"
    >
      {name === null ? null : (
        <h2 id={heading} className="text-[14px] font-medium text-ink-1">
          {name}
        </h2>
      )}
      {read.kind === "loading" ? (
        <div aria-busy="true" className="flex flex-wrap gap-2">
          <span className="sr-only">{STREAK_COPY.loading}</span>
          {[0, 1].map((n) => (
            <div key={n} className="min-h-12 w-48 rounded-row bg-raised" />
          ))}
        </div>
      ) : read.kind === "offline" ? (
        <p className="text-[13px] text-ink-2">{STREAK_COPY.offline}</p>
      ) : read.kind === "catching_up" ? (
        <p aria-busy="true" className="text-[13px] text-ink-2">
          {STREAK_COPY.catchingUp}
        </p>
      ) : read.kind === "stopped" ? (
        <div className="flex flex-col gap-1" data-streak-stopped={read.reason}>
          <p className="text-[13px] font-medium text-ink-1">
            {STREAK_COPY.stopped}
          </p>
          <p className="text-[12.5px] text-ink-2">
            {CATCH_UP_COPY.reason[read.reason]}
          </p>
          {read.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(read.requestId)}
            </p>
          ) : null}
          {read.reason === "horizon" ? null : (
            <span>
              <Button onClick={() => tryAgain(read.day)}>
                {copy.TRY_AGAIN}
              </Button>
            </span>
          )}
        </div>
      ) : read.kind === "error" ? (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-ink-2">{STREAK_COPY.error}</p>
          {read.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(read.requestId)}
            </p>
          ) : null}
          <span>
            <Button onClick={retry}>{copy.TRY_AGAIN}</Button>
          </span>
        </div>
      ) : (
        <dl className="m-0 flex flex-wrap gap-2">
          {(["current", "longest"] as const).map((kind) => (
            <div
              key={kind}
              className="flex min-w-0 flex-col gap-1 rounded-row border border-hairline-strong bg-panel p-3"
              data-streak-figure={kind}
            >
              <dt className="text-[12px] text-ink-2">
                {kind === "current"
                  ? STREAK_COPY.currentName
                  : STREAK_COPY.longestName}
              </dt>
              <dd className="m-0 text-[15px] font-medium text-ink-1">
                <FigureText
                  figure={figureOf(read.streak[kind], scope)}
                  unit={unit}
                  kind={kind}
                />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** WF-TASK-06: the task's streak (CM-368, CM-395; TASK-5/5a). */
export function StreakPage({ taskId }: { taskId: string }) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const position = useCachePosition();
  const composition =
    position.status === "ready" ? (position.value?.composition ?? -1) : -2;
  const noDatabase =
    position.status === "unavailable" && position.reason === "absent";
  const [attempt, setAttempt] = useState(0);
  const scope = `${env.identity}\u0000${data.service()?.incarnationId ?? "-"}\u0000${taskId}`;
  const local = useScopedRead<LocalStreak>(
    scope,
    `${composition}|${attempt}`,
    (signal) =>
      readCoherently(
        data,
        () => readLocal(data, taskId, env.accountId, env.now(), signal),
        { signal },
      ),
    !noDatabase,
  );
  const value = local.complete?.value ?? null;
  const definition = value?.definition ?? null;
  const shared = definition !== null && definition.participation !== "personal";
  const figures = useStreakFigures(taskId, shared);
  const stripHeading = useId();
  const unit = (n: number) =>
    definition === null ? (n === 1 ? "time" : "times") : unitOf(definition, n);
  const cells = value?.cells ?? [];
  const counts = tally(cells);
  const title = value?.title ?? null;
  const failed =
    value === null &&
    (local.latest === "failed" || local.latest === "unstable");
  return (
    <article
      className="flex max-w-[760px] flex-col gap-6"
      data-streak-page={taskId}
    >
      <div className="flex flex-col gap-2">
        <Link
          to="/tasks/$taskId"
          params={{ taskId }}
          search={{}}
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13px] text-ink-2 hover:text-ink-1"
        >
          {STREAK_COPY.back(title ?? copy.UNTITLED)}
        </Link>
        <PageHeading>{STREAK_COPY.title}</PageHeading>
        {title !== null ? (
          <p className="text-[13px] text-ink-2">{title}</p>
        ) : null}
      </div>
      {failed ? (
        <div className="flex flex-col gap-2" data-streak-local-error="">
          <p className="text-[13px] text-ink-2">
            {local.latest === "unstable"
              ? copy.LOCAL_UNSTABLE
              : copy.LOCAL_FAILED}
          </p>
          <span>
            <Button onClick={() => setAttempt((n) => n + 1)}>
              {copy.TRY_AGAIN}
            </Button>
          </span>
        </div>
      ) : value !== null && value.title === null ? (
        <p className="text-[13.5px] text-ink-2" data-streak-absent="">
          {STREAK_COPY.absent}
        </p>
      ) : null}
      {shared && figures.joint !== null ? (
        <>
          <Tiles
            name={STREAK_COPY.shared}
            read={figures.joint}
            scope="joint"
            unit={unit}
            retry={figures.retry}
            tryAgain={figures.tryAgain}
          />
          <Tiles
            name={STREAK_COPY.you}
            read={figures.personal}
            scope="personal"
            unit={unit}
            retry={figures.retry}
            tryAgain={figures.tryAgain}
          />
        </>
      ) : (
        <Tiles
          name={null}
          read={figures.personal}
          scope="personal"
          unit={unit}
          retry={figures.retry}
          tryAgain={figures.tryAgain}
        />
      )}
      <section aria-labelledby={stripHeading} className="flex flex-col gap-2">
        <h2 id={stripHeading} className="text-[14px] font-medium text-ink-1">
          {STREAK_COPY.dayByDay}
          {env.online ? "" : ` · ${STREAK_COPY.onDevice}`}
        </h2>
        {value === null && !failed ? (
          <div aria-busy="true" className="flex flex-wrap gap-1">
            <span className="sr-only">{STREAK_COPY.loading}</span>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="size-9 rounded-control bg-raised" />
            ))}
          </div>
        ) : cells.length === 0 ? (
          <p className="text-[13px] text-ink-2" data-streak-empty="">
            {STREAK_COPY.nothing}
          </p>
        ) : (
          <>
            <p className="text-[13px] text-ink-1" data-streak-tally="">
              {STREAK_COPY.lastN(
                unit(STRIP_PERIODS),
                counts.done,
                counts.total,
                counts.missed,
              )}
            </p>
            <ol
              className="m-0 flex list-none flex-wrap gap-1 p-0"
              data-streak-strip=""
            >
              {cells.map((cell) => {
                const label = `${cell.date === null ? STREAK_COPY.undated : dayLabel(cell.date)}: ${STREAK_COPY.state[cell.state]}`;
                return (
                  <li
                    key={cell.id}
                    title={label}
                    data-strip-state={cell.state}
                    className={`flex size-9 items-center justify-center rounded-control text-[12px] ${TONE[cell.state]}`}
                  >
                    <span aria-hidden="true">{MARK[cell.state]}</span>
                    <span className="sr-only">{label}</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>
    </article>
  );
}

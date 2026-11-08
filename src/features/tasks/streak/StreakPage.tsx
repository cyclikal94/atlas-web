import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Breadcrumb } from "../../../components/ui/breadcrumb";
import { Button } from "../../../components/ui/button";
import { GroupedBox, GroupedSection } from "../../../components/ui/grouped";
import { Eyebrow, PageHeader } from "../../../components/ui/page-header";
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
import type { SeenStop } from "../catchup/runner";
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
import type { Pause } from "../model/retry";
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
import { TASKS_TITLE } from "../titles";
import {
  reasonText,
  recoveryRows,
  type ShownReason,
  stopsFor,
} from "../today/CatchUpBanner";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const STREAK_COPY = {
  title: "How it's been going",
  back: (title: string) => `‹ ${title}`,
  /** The facts strip's way to this page: the cell is labelled "Streak", so the link says what pressing it does. */
  link: "View",
  linkName: "See how it's been going",
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
  done: "bg-done text-primary-foreground",
  missed: "bg-warning/10 border border-warning/35 text-foreground",
  open: "bg-background border border-border text-foreground",
  none: "bg-muted text-muted-foreground",
  skipped: "bg-card border border-dashed border-border text-muted-foreground",
};

// ---- the device's strip -----------------------------------------------------------------------------------------------------------
interface LocalStreak {
  title: string | null;
  definition: TaskDefinition | null;
  cells: StripCell[];
  /**
   * The instant (ms) the cells were evaluated at, and the next instant (s) at which they stop being current, or null when no boundary
   * lies ahead (revision 19, review R41): the earliest opening of ANY saved period still to open (one that opens joins the strip and may
   * push the oldest out of the last 30, so a period not shown counts too) and the earliest closing of a shown period (its open state
   * becomes its final one). Constant size: the walk keeps only the minimum, not the periods.
   */
  at: number;
  next: number | null;
}

/** Whether a local strip evaluated at `value.at` still holds at `nowMs`: no boundary since, and the clock has not gone back before it. */
export const localCurrent = (
  value: { at: number; next: number | null },
  nowMs: number,
): boolean =>
  nowMs >= value.at && (value.next === null || nowMs < value.next * 1000);

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
      value: {
        title: taskRow?.label ?? null,
        definition,
        cells: [],
        at: nowMs,
        next: null,
      },
    };
  // Keep only the latest 30 opened days while walking every saved day (the walk is bounded per window; F-1's cost applies).
  let kept: Array<{ id: string; data: OccurrenceData }> = [];
  let opening = null as number | null;
  const end = await scanResources(
    data,
    { kind: "occurrence", parentId: execution.id },
    (rows) => {
      for (const listed of rows) {
        const parsed = parseOccurrenceData(listed.merged.value);
        if (parsed === null || parsed.task_id !== taskId) continue;
        if (!opened(parsed, nowMs)) {
          const at = parsed.opens_at as number;
          if (opening === null || at < opening) opening = at;
          continue;
        }
        kept.push({ id: listed.base.id, data: parsed });
      }
      kept = latestPeriods(kept, nowMs);
      return undefined;
    },
    signal,
  );
  if (end !== "complete") return unread();
  const latest = kept;
  let next = opening;
  for (const day of latest) {
    const closes = day.data.closes_at;
    if (
      closes !== null &&
      closes * 1000 > nowMs &&
      (next === null || closes < next)
    )
      next = closes;
  }
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
  return {
    ok: true,
    value: { title: taskRow.label, definition, cells, at: nowMs, next },
  };
}

const CAP = 6 * 3_600_000;
/** Attempts of one local read whose result a boundary overtook while it was read (each is evaluated afresh at its own instant). */
const CURRENT_ATTEMPTS = 3;
/**
 * The paced attempts after a re-read of a strip that is no longer current did not complete (revision 20, review R42): one coherent read
 * each, after these waits in turn; then none until a return to the page, a committed change or Try again. A complete read starts again.
 */
export const EXPIRY_RETRIES_MS: readonly number[] = [2_000, 10_000, 60_000];
/** The wait before the `step`-th paced attempt (0-based), or null once they are spent: the ladder is finite. */
export const expiryRetryDelay = (step: number): number | null =>
  step >= 0 && step < EXPIRY_RETRIES_MS.length
    ? (EXPIRY_RETRIES_MS[step] as number)
    : null;

/** How the strip's local read stands: the last finished read's outcome, or `reading` while one is in progress or due. */
type LocalOutcome = "reading" | "complete" | "failed" | "unstable" | "other";

/**
 * When the shown strip stops being current (revision 19, review R41): at its next boundary (plus 50 ms; a wait capped at six hours re-arms
 * itself) and on return to the page (`visibilitychange`, `focus`, `pageshow`: a timer does not run while a device sleeps), the clock is read
 * against the strip's OWN evaluation instant, so a boundary crossed while the page slept, or a clock that went back before it, is seen
 * without any data change; offline as online. Each expiry calls `expire`, which asks the local read again; the last complete strip stays as it
 * was until that read completes.
 *
 * Revision 20 (review R42): a re-read that does not complete leaves the same strip retained (the page marks it stale), so the watcher is
 * judged on the strip AND how its last read ended, and always knows what it waits for next. A current strip waits for its boundary, whatever
 * its last read did; a lapsed strip with a read in progress waits for that read; a lapsed strip whose last read failed or kept changing gets
 * the next paced attempt of `EXPIRY_RETRIES_MS` (none once they are spent); any other lapsed strip is asked again at once. A return to the
 * page asks again for a lapsed strip whatever its last read did: the listeners stay armed for as long as a strip is retained. The paced
 * attempts start afresh with each complete strip and a due one ends with the scope or the page (the effect's cleanup).
 */
function useLocalExpiry(
  read: () => number,
  value: { at: number; next: number | null } | null,
  outcome: LocalOutcome,
  expire: () => void,
): void {
  const latest = useRef({ read, expire });
  latest.current = { read, expire };
  /** The next paced attempt's place in `EXPIRY_RETRIES_MS`, counted for the strip in `counted`; 0 again for each complete strip. */
  const step = useRef(0);
  const counted = useRef(value);
  useEffect(() => {
    if (counted.current !== value) {
      counted.current = value;
      step.current = 0;
    }
    if (value === null) return;
    const failing = outcome === "failed" || outcome === "unstable";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (wake = false) => {
      clearTimeout(timer);
      const t = latest.current.read();
      if (!localCurrent(value, t)) {
        // A read in progress answers for this strip (a wake still asks: its read is then the latest asked).
        if (outcome === "reading" && !wake) return;
        if (failing && !wake) {
          // This lapsed strip's last re-read did not complete: the next paced attempt, if one is left.
          const delay = expiryRetryDelay(step.current);
          if (delay === null) return;
          timer = setTimeout(() => {
            step.current += 1;
            latest.current.expire();
          }, delay);
          return;
        }
        latest.current.expire();
        return;
      }
      if (value.next === null) return;
      timer = setTimeout(arm, Math.min(value.next * 1000 - t + 50, CAP));
    };
    // A strip published after its own boundary (a slow read that a boundary overtook) is asked again at once.
    arm();
    const resume = () => {
      if (document.visibilityState === "visible") arm(true);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [value, outcome]);
}

// ---- the server's figures ---------------------------------------------------------------------------------------------------------
type Read =
  | { kind: "loading" }
  | { kind: "ready"; streak: TaskStreak }
  | { kind: "error"; requestId?: string }
  | { kind: "catching_up" }
  | {
      kind: "stopped";
      reason: ShownReason;
      requestId?: string;
      day?: string;
      pause?: Pause;
    }
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
  const { runner, state, records, todayOf, discovery, discoveryRead } =
    useCatchUp([taskId]);
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
  // The one read that may still publish (review R22): its reason and whether it still owns the figures.
  const owner = useRef<{ key: string; live: boolean } | null>(null);
  // A deliberate refresh retires the read in flight at once, not only when its own effect runs.
  const refresh = useCallback(() => {
    if (owner.current) owner.current.live = false;
    owner.current = null;
    setAsk((n) => n + 1);
  }, []);
  const visit = useRef({ caughtUp: false, asked: false, reread: false });
  // A new identity starts the visit's memory afresh.
  const identity = useRef(env.identity);
  if (identity.current !== env.identity) {
    identity.current = env.identity;
    visit.current = { caughtUp: false, asked: false, reread: false };
  }
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on a visit, a show, committed content or the person's Try again
  useEffect(() => {
    const key =
      revision === null
        ? null
        : `${taskId}|${shared}|${env.online}|${env.identity}|${revision}|${ask}`;
    const held = owner.current;
    if (held !== null && held.key === key) {
      // One read per reason: a replayed effect resumes its own read and asks nothing more.
      held.live = true;
      return () => {
        held.live = false;
      };
    }
    // Any other run ends the earlier read's ownership before it returns: going offline, losing the committed position, another
    // identity, task or reason (review R22). A held answer then changes nothing it no longer owns.
    if (held !== null) held.live = false;
    owner.current = null;
    if (key === null) return;
    const mine = { key, live: true };
    owner.current = mine;
    if (!env.online) {
      setRead({
        personal: { kind: "offline" },
        joint: shared ? { kind: "offline" } : null,
      });
      return () => {
        mine.live = false;
      };
    }
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
        // Only the read that still owns the figures of the displayed identity is shown (CM-384, review R22).
        if (!mine.live || owner.current !== mine || identity.current !== asked)
          return;
        setRead({ personal, joint });
      },
    );
    return () => {
      mine.live = false;
    };
  }, [taskId, shared, env.online, env.identity, revision, ask]);

  const waiting =
    read.personal.kind === "catching_up" || read.joint?.kind === "catching_up";
  // The row of the day the streak needs caught up, its task's today, read by its own key (revision 5, R24; by task, R21): unknown until
  // this page's runner has read the task, and then a later day's stop never stands in for it.
  const today = todayOf(taskId);
  const found =
    records.status === "ready" ? records.value.get(taskId) : undefined;
  const record = today === undefined ? undefined : (found?.target ?? undefined);
  const sequencesRead = records.status === "ready" && today !== undefined;
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
    // A stopped discovery (review R13) is not a finished catch-up: it is shown, never read past (nor while its record, or the task's
    // sequence, is unread: review R21).
    const stopped =
      record?.phase === "stopped" ||
      !discoveryRead ||
      !sequencesRead ||
      discovery[taskId]?.stop != null ||
      state.unrecorded.has(taskId);
    if (!running && !stopped && !visit.current.reread) {
      visit.current.reread = true;
      refresh();
    }
  }, [
    waiting,
    env.online,
    state,
    record,
    discovery,
    discoveryRead,
    sequencesRead,
    runner,
    taskId,
    refresh,
  ]);
  // The stop shown, chosen as every screen chooses it (revision 5, reviews R24 and R26): the row of the task's today once its day is known
  // (else its latest days as read), else its stopped discovery, else this page's memory stop; with what a "Try again" on it names.
  const shown = waiting
    ? stopsFor(taskId, recoveryRows(found, today), state, discovery)[0]
    : undefined;
  const seen: SeenStop = shown?.seen ?? { kind: "none" };
  const stop: Read | null = shown
    ? {
        kind: "stopped",
        reason: shown.reason,
        ...(shown.pause === undefined ? {} : { pause: shown.pause }),
        ...(shown.requestId ? { requestId: shown.requestId } : {}),
        ...(shown.throughDate === undefined ? {} : { day: shown.throughDate }),
      }
    : null;
  return {
    personal: stop ?? read.personal,
    joint: read.joint === null ? null : (stop ?? read.joint),
    retry: refresh,
    tryAgain: (day?: string) => {
      visit.current.reread = false;
      // A stop of this visit's own reads (a second 409) names no record: the runner asks afresh, only while no stop stands (revision 5,
      // R26: a stop that appeared since is not lifted by a press on another).
      runner.tryAgain(taskId, day, stop === null ? { kind: "none" } : seen);
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
        <h2 id={heading} className="text-sm font-medium text-foreground">
          {name}
        </h2>
      )}
      {read.kind === "loading" ? (
        <div aria-busy="true" className="flex flex-wrap gap-2">
          <span className="sr-only">{STREAK_COPY.loading}</span>
          {[0, 1].map((n) => (
            <div key={n} className="min-h-12 w-48 rounded-lg bg-card" />
          ))}
        </div>
      ) : read.kind === "offline" ? (
        <p className="text-sm text-muted-foreground">{STREAK_COPY.offline}</p>
      ) : read.kind === "catching_up" ? (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {STREAK_COPY.catchingUp}
        </p>
      ) : read.kind === "stopped" ? (
        <div className="flex flex-col gap-1" data-streak-stopped={read.reason}>
          <p className="text-sm font-medium text-foreground">
            {STREAK_COPY.stopped}
          </p>
          <p className="text-xs text-muted-foreground">{reasonText(read)}</p>
          {read.requestId ? (
            <p className="select-all font-num text-xs text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">{STREAK_COPY.error}</p>
          {read.requestId ? (
            <p className="select-all font-num text-xs text-muted-foreground">
              {copy.REQUEST_ID(read.requestId)}
            </p>
          ) : null}
          <span>
            <Button onClick={retry}>{copy.TRY_AGAIN}</Button>
          </span>
        </div>
      ) : (
        // The figures as a facts strip (the Final design, 8 November 2026): the same labelled cells as the task page's.
        <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-border bg-border">
          {(["current", "longest"] as const).map((kind) => (
            <div
              key={kind}
              className="flex min-h-[72px] min-w-0 flex-col justify-center gap-1 bg-card px-4 py-3"
              data-streak-figure={kind}
            >
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {kind === "current"
                  ? STREAK_COPY.currentName
                  : STREAK_COPY.longestName}
              </dt>
              <dd className="m-0 text-sm font-medium text-foreground">
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
  // The strip is evaluated at one instant; a strip a boundary overtook while it was read is read again, never published as current.
  const [expired, setExpired] = useState(0);
  const local = useScopedRead<LocalStreak>(
    scope,
    `${composition}|${attempt}|${expired}`,
    async (signal) => {
      let read: Awaited<ReturnType<typeof readCoherently<LocalStreak>>> = {
        kind: "unstable",
      };
      for (let i = 0; i < CURRENT_ATTEMPTS; i += 1) {
        const at = env.now();
        read = await readCoherently(
          data,
          () => readLocal(data, taskId, env.accountId, at, signal),
          { signal },
        );
        if (read.kind !== "complete" || localCurrent(read.value, env.now()))
          return read;
      }
      // Overtaken every time (a clock moving on and back): not current, so not complete.
      return read.kind === "complete" ? { kind: "unstable" } : read;
    },
    !noDatabase,
  );
  const value = local.complete?.value ?? null;
  // How the last local read ended, read with the retained strip exactly as Today does (revision 20, review R42): a read that failed or kept
  // changing is shown as such whether or not an earlier strip is kept, and a kept strip is then marked as what was last read, never as current
  // (also while the next attempt is in progress: only a complete read ends the marking).
  const localError = noDatabase
    ? null
    : local.latest === "failed" || local.latest === "unstable"
      ? local.latest
      : null;
  const stale = value !== null && localError !== null;
  const outcome: LocalOutcome = local.reading
    ? "reading"
    : local.latest === "complete" ||
        local.latest === "failed" ||
        local.latest === "unstable"
      ? local.latest
      : "other";
  useLocalExpiry(env.now, value, outcome, () => setExpired((n) => n + 1));
  const retryLocal = () => setAttempt((n) => n + 1);
  const definition = value?.definition ?? null;
  const shared = definition !== null && definition.participation !== "personal";
  const figures = useStreakFigures(taskId, shared);
  const stripHeading = useId();
  const unit = (n: number) =>
    definition === null ? (n === 1 ? "time" : "times") : unitOf(definition, n);
  const cells = value?.cells ?? [];
  const counts = tally(cells);
  const title = value?.title ?? null;
  // Nothing retained: the read's failure is all there is to show.
  const failed = value === null && localError !== null;
  return (
    <article
      className="flex min-w-0 max-w-[880px] flex-col gap-6"
      data-streak-page={taskId}
    >
      <Breadcrumb
        items={[
          { label: TASKS_TITLE, to: "/tasks" },
          {
            label: title ?? copy.UNTITLED,
            to: "/tasks/$taskId",
            params: { taskId },
          },
        ]}
        current={STREAK_COPY.title}
      />
      <PageHeader
        eyebrow={<Eyebrow>{title ?? copy.UNTITLED}</Eyebrow>}
        title={<PageHeading>{STREAK_COPY.title}</PageHeading>}
      />
      {failed ? (
        <div className="flex flex-col gap-2" data-streak-local-error="">
          <p className="text-sm text-muted-foreground">
            {local.latest === "unstable"
              ? copy.LOCAL_UNSTABLE
              : copy.LOCAL_FAILED}
          </p>
          <span>
            <Button onClick={retryLocal}>{copy.TRY_AGAIN}</Button>
          </span>
        </div>
      ) : noDatabase || (value !== null && value.title === null) ? (
        // No database on this device (revision 20, Q7): nothing of the task was ever saved here, which is what "absent" says.
        <p className="text-sm text-muted-foreground" data-streak-absent="">
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
      <GroupedBox data-streak-box="">
        <GroupedSection
          aria-labelledby={stripHeading}
          heading={<h2 id={stripHeading}>{STREAK_COPY.dayByDay}</h2>}
          summary={env.online ? undefined : STREAK_COPY.onDevice}
        >
          {stale ? (
            // The kept strip is what was last read, not the current one (revision 20, review R42): its own Try again reads the strip again; the
            // figures' Try again is theirs.
            <div className="flex flex-col gap-1" data-streak-stale={localError}>
              <p className="text-sm text-muted-foreground">
                {localError === "unstable"
                  ? copy.LOCAL_UNSTABLE
                  : copy.LOCAL_FAILED}
              </p>
              <p className="text-xs text-muted-foreground">
                {copy.SHOWING_LAST_READ}
              </p>
              <span>
                <Button onClick={retryLocal}>{copy.TRY_AGAIN}</Button>
              </span>
            </div>
          ) : null}
          {noDatabase || failed ? null : value === null ? (
            <div aria-busy="true" className="flex flex-wrap gap-1">
              <span className="sr-only">{STREAK_COPY.loading}</span>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <div key={n} className="size-9 rounded-md bg-card" />
              ))}
            </div>
          ) : cells.length === 0 ? (
            // Unknown is not empty: a kept empty strip whose re-read failed says so above, never "Nothing to show yet." (as Today, R9).
            stale ? null : (
              <p className="text-sm text-muted-foreground" data-streak-empty="">
                {STREAK_COPY.nothing}
              </p>
            )
          ) : (
            <>
              <p className="text-sm text-foreground" data-streak-tally="">
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
                      className={`flex size-9 items-center justify-center rounded-md text-xs ${TONE[cell.state]}`}
                    >
                      <span aria-hidden="true">{MARK[cell.state]}</span>
                      <span className="sr-only">{label}</span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </GroupedSection>
      </GroupedBox>
    </article>
  );
}

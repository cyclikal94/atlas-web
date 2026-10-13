import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CacheRow,
  readResourcesNow,
  scanResources,
  useAllOutstandingByKind,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import type { TasksApi, TasksResult } from "../api";
import { useTasksEnv } from "../env";
import { forgetRefusal, noteIfRefused, noteJoint, refusalOf } from "../memory";
import { QUEUED_KINDS } from "../model/commands";
import {
  type OccurrencePage,
  type OccurrenceView,
  parseOccurrenceData,
} from "../model/contract";
import { inDayView } from "../model/evaluate";
import { progressId } from "../model/ids";
import { dayEnd } from "../model/time";
import { composeRow, type Outstanding, type RowModel } from "../view";

/**
 * The Today view's data (D-10a-1, §4.1). Resources come from the cache; the derived fields (outcomes, `actionable`, membership,
 * `pending_tasks`) come from `GET /daily` while online, held in page memory for the displayed identity only and never written to storage.
 * Two reads per view: `scope=joint` (membership, the joint result, joint actionability) and `scope=personal` (my result), both
 * `state=all` and filtered here so counts and filters agree. Offline, or before the first answer, the day is derived from the cache by a
 * bounded walk of every cached occurrence (D-10a-2) and the personal reapplication of ARCH §3.3c.
 */
export interface DailyAnswer {
  key: string;
  joint: Map<string, OccurrenceView>;
  personal: Map<string, OccurrenceView>;
  pendingTasks: string[];
  at: number;
  /** The cache generation (`syncTick`) the read began under: a sync page committed since makes the personal results stale. */
  tick: number;
}

export type DailyError =
  | { kind: "failed"; requestId?: string }
  | { kind: "kept_changing" };

export interface TodayView {
  /** Neither the first answer nor the first cache walk has arrived. */
  loading: boolean;
  rows: RowModel[];
  unreadable: string[];
  pendingTasks: string[];
  error: DailyError | null;
  /** The rows come from the cache only (offline, or the server read failed). */
  fromDevice: boolean;
  /** The database is absent: nothing was ever saved or synced on this device. */
  noDatabase: boolean;
  now: number;
  retry(): void;
}

const RESTARTS = 3;
const DAILY = "daily";

/** One scope of `/daily`, every page, restarting from the first page on `409 conflict` (TASK-7): never a mix of revisions. */
export async function readWholeDay(
  api: TasksApi,
  query: {
    day: string;
    zone: string;
    scope: "joint" | "personal";
    limit: number;
  },
  isCurrent: () => boolean,
  /** Called with every answer as it arrives, before anything else (the refusal memo, which must not depend on the screen). */
  onAnswer: (result: TasksResult<OccurrencePage>) => void = () => undefined,
): Promise<
  | { ok: true; items: OccurrenceView[]; pendingTasks: string[] }
  | { ok: false; error: DailyError | "refused" | "closed" | "offline" }
> {
  for (let restart = 0; restart < RESTARTS; restart += 1) {
    const items: OccurrenceView[] = [];
    let revision: number | undefined;
    let after: string | undefined;
    let pendingTasks: string[] = [];
    let conflicted = false;
    for (;;) {
      if (!isCurrent()) return { ok: false, error: "closed" };
      const page: TasksResult<OccurrencePage> = await api.readDaily({
        ...query,
        ...(after === undefined ? {} : { after }),
        ...(revision === undefined ? {} : { revision }),
      });
      onAnswer(page);
      if (!isCurrent()) return { ok: false, error: "closed" };
      if (!page.ok) {
        if (page.kind === "conflict" && revision !== undefined) {
          conflicted = true;
          break;
        }
        if (page.kind === "offline") return { ok: false, error: "offline" };
        if (page.kind === "closed") return { ok: false, error: "closed" };
        if (page.kind === "forbidden" || page.kind === "not_found")
          return { ok: false, error: "refused" };
        return {
          ok: false,
          error: {
            kind: "failed",
            ...("requestId" in page && page.requestId
              ? { requestId: page.requestId }
              : {}),
          },
        };
      }
      if (revision === undefined) {
        revision = page.value.revision;
        pendingTasks = page.value.pending_tasks;
      }
      items.push(...page.value.items);
      if (page.value.next_after === null)
        return { ok: true, items, pendingTasks };
      after = page.value.next_after;
    }
    if (!conflicted) break;
  }
  return { ok: false, error: { kind: "kept_changing" } };
}

/** Whether a cached occurrence could belong to the day at all (a superset; the row's own state decides). */
function candidate(
  data: ReturnType<typeof parseOccurrenceData>,
  day: string,
  zone: string,
  end: number,
): boolean {
  if (data === null) return true; // shown as unreadable, never dropped silently
  if (data.slot.instant !== null || data.slot.date !== null) {
    if (inDayView(data, day, zone, false)) return true;
  }
  return (
    !data.resolved &&
    data.covered_by === null &&
    (data.opens_at === null || data.opens_at < end)
  );
}

export function useTodayView(day: string, zone: string): TodayView {
  const env = useTasksEnv();
  const data = useDataEnv();
  const outstandingPage = useAllOutstandingByKind(QUEUED_KINDS);
  const position = useCachePosition();
  const [now, setNow] = useState(() => env.now());
  const [scan, setScan] = useState<{
    key: string;
    rows: Map<string, CacheRow>;
  } | null>(null);
  const [answer, setAnswer] = useState<DailyAnswer | null>(null);
  const [error, setError] = useState<DailyError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [related, setRelated] = useState<{
    progressIds: Map<string, string>;
    rows: Map<string, CacheRow>;
  }>({ progressIds: new Map(), rows: new Map() });
  const key = `${env.identity}\u0000${day}\u0000${zone}`;
  const pageSeq =
    position.status === "ready" ? (position.value?.pageSeq ?? -1) : -2;
  // A committed sync page moves `pageSeq`; the position's own first load (loading → ready) is not a change of the cache, so the server
  // read is not restarted (and its first answer discarded) by it.
  const [syncTick, setSyncTick] = useState(0);
  const lastSeq = useRef<number | null>(null);
  useEffect(() => {
    if (pageSeq < 0) return;
    if (lastSeq.current !== null && lastSeq.current !== pageSeq)
      setSyncTick((n) => n + 1);
    lastSeq.current = pageSeq;
  }, [pageSeq]);
  const ready = position.status;
  const noDatabase = position.status === "unavailable";

  // Every page of the outstanding work (R4, revision 1): until the whole overlay is read no row is composed, so a personal result is never
  // computed from part of what this device saved.
  const overlayLoading = outstandingPage.status === "loading";
  const outstanding: Outstanding = useMemo(
    () =>
      outstandingPage.status === "ready"
        ? {
            drafts: outstandingPage.value.drafts,
            attention: outstandingPage.value.attention,
          }
        : { drafts: [], attention: [] },
    [outstandingPage],
  );
  const draftsKey = outstanding.drafts
    .map((d) => `${d.local_id}:${d.status}`)
    .join(",");

  // ---- the cache walk (D-10a-2): on mount, on day/zone change, when a sync page commits or the queue changes (debounced) -----------
  const scanned = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-walked when the cache position or the queue changes
  useEffect(() => {
    const controller = new AbortController();
    const delay = scanned.current ? 750 : 0;
    const timer = setTimeout(() => {
      const found = new Map<string, CacheRow>();
      const end = dayEnd(day, zone);
      void scanResources(
        data,
        { kind: "occurrence" },
        (rows) => {
          for (const row of rows) {
            const parsed = parseOccurrenceData(row.merged.value);
            if (candidate(parsed, day, zone, end))
              found.set(row.base.id, row.merged);
          }
          return undefined;
        },
        controller.signal,
      ).then((end) => {
        if (controller.signal.aborted) return;
        scanned.current = true;
        if (end === "complete" || end === "closed")
          setScan({ key, rows: end === "complete" ? found : new Map() });
      });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [data, key, ready, syncTick, draftsKey]);

  // ---- the two /daily reads: on mount, day/zone change, reconnect, a committed sync page, a retry, a window boundary --------------
  const read = useRef(0);
  const answered = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on the listed triggers; `now` moves at window boundaries
  useEffect(() => {
    if (!env.online) return;
    // A refused read is not asked again on a remount, only on "Try again" (D-12a-13).
    if (refusalOf(env.identity, DAILY) !== null) {
      setError({ kind: "failed" });
      return;
    }
    const mine = ++read.current;
    const isCurrent = () => mine === read.current;
    const tick = syncTick;
    const delay = answered.current ? 750 : 0;
    const timer = setTimeout(() => {
      const query = { day, zone, limit: env.dailyPageSize };
      void Promise.all([
        readWholeDay(env.api, { ...query, scope: "joint" }, isCurrent, (r) =>
          noteIfRefused(env.identity, DAILY, r),
        ),
        readWholeDay(env.api, { ...query, scope: "personal" }, isCurrent, (r) =>
          noteIfRefused(env.identity, DAILY, r),
        ),
      ]).then(([joint, personal]) => {
        if (!isCurrent()) return;
        if (!joint.ok || !personal.ok) {
          const failed = !joint.ok
            ? joint.error
            : !personal.ok
              ? personal.error
              : "closed";
          if (failed === "closed" || failed === "offline") return;
          setError(failed === "refused" ? { kind: "failed" } : failed);
          return;
        }
        const at = env.now();
        const jointMap = new Map(joint.items.map((item) => [item.id, item]));
        for (const item of joint.items)
          noteJoint(env.identity, item.id, {
            outcome: item.outcome,
            periodOutcome: item.period_outcome,
            actionable: item.actionable,
            at,
          });
        answered.current = true;
        setError(null);
        setAnswer({
          key,
          joint: jointMap,
          personal: new Map(personal.items.map((item) => [item.id, item])),
          pendingTasks: joint.pendingTasks,
          at,
          tick,
        });
      });
    }, delay);
    return () => {
      clearTimeout(timer);
      // A late answer for another identity, day or zone is dropped.
      if (read.current === mine) read.current += 1;
    };
  }, [env.api, env.identity, env.online, key, syncTick, attempt, now]);

  // FRESHNESS OF THE SERVER'S ANSWER (R2, revision 1). The last `/daily` answer for this identity, day and zone lists the day and carries
  // the joint fields only while the device is ONLINE: offline the day is what the device holds, and my result is the personal reapplication
  // of ARCH §3.3c over the saved summary (with its finalisation once a window closes), never an answer received before going offline. My
  // personal result from the server also stops applying once a sync page has committed after its read began (the cache may hold newer
  // progress than it: the re-read follows) and, row by row, once a window boundary has passed since it was answered (`composeRow`). The
  // joint result stays the server's alone, shown with its time by the detail (Q8).
  const listed =
    env.online && answer !== null && answer.key === key ? answer : null;
  const personalFresh = listed !== null && listed.tick === syncTick;
  const current = listed;
  const local = scan !== null && scan.key === key ? scan : null;

  // ---- the projected first occurrences of outstanding creates (§4.3) ----------------------------------------------------------------
  const projected = useMemo(
    () =>
      outstanding.drafts
        .filter((d) => d.kind === "create_task")
        .map((d) => d.target_resource_ids[2])
        .filter((id): id is string => id !== undefined),
    [outstanding],
  );

  const ids = useMemo(() => {
    const set = new Set<string>(projected);
    for (const id of local?.rows.keys() ?? []) set.add(id);
    for (const id of current?.joint.keys() ?? []) set.add(id);
    for (const id of current?.personal.keys() ?? []) set.add(id);
    return [...set].sort();
  }, [local, current, projected]);
  const idsKey = ids.join(",");

  // ---- related rows: my progress stream by its deterministic id, and the task, for every candidate ------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the ids, the cache position and the queue
  useEffect(() => {
    let live = true;
    void (async () => {
      const progressIds = new Map<string, string>();
      for (const id of ids)
        progressIds.set(id, await progressId(id, env.accountId));
      const taskIds = new Set<string>();
      for (const id of ids) {
        const value =
          current?.joint.get(id)?.data ??
          parseOccurrenceData(local?.rows.get(id)?.value ?? null);
        if (value) taskIds.add(value.task_id);
      }
      const rows = await readResourcesNow(data, [
        ...progressIds.values(),
        ...taskIds,
      ]);
      // The merged rows (cache with its admitted overlay), never the listing wrapper.
      const merged = new Map<string, CacheRow>();
      for (const [rowId, listed] of rows ?? [])
        merged.set(rowId, listed.merged);
      if (live) setRelated({ progressIds, rows: merged });
    })();
    return () => {
      live = false;
    };
  }, [idsKey, ready, syncTick, draftsKey, env.accountId, data]);

  // ---- rows ----------------------------------------------------------------------------------------------------------------------------
  const composed = useMemo(() => {
    const rows: RowModel[] = [];
    const unreadable: string[] = [];
    if (overlayLoading) return { rows, unreadable };
    for (const id of ids) {
      const pid = related.progressIds.get(id);
      if (pid === undefined) continue;
      const occurrence = local?.rows.get(id) ?? null;
      const joint = current?.joint.get(id) ?? null;
      const taskId =
        joint?.data.task_id ??
        parseOccurrenceData(occurrence?.value ?? null)?.task_id;
      const result = composeRow(
        {
          occurrenceId: id,
          progressId: pid,
          occurrence,
          task:
            taskId === undefined ? null : (related.rows.get(taskId) ?? null),
          progress: related.rows.get(pid) ?? null,
          joint,
          personal: personalFresh ? (current?.personal.get(id) ?? null) : null,
          answeredAt: personalFresh ? (current?.at ?? null) : null,
        },
        outstanding,
        env.accountId,
        now,
      );
      if (result.kind === "unreadable") {
        unreadable.push(id);
        continue;
      }
      const row = result.row;
      if (row.archived) continue;
      const fromServer =
        current !== null && (current.joint.has(id) || current.personal.has(id));
      if (!fromServer && !inDayView(row.data, day, zone, row.actionable))
        continue;
      rows.push(row);
    }
    return { rows, unreadable };
  }, [
    ids,
    related,
    local,
    current,
    outstanding,
    env.accountId,
    now,
    day,
    zone,
    personalFresh,
    overlayLoading,
  ]);

  // ---- the next window boundary among the shown rows re-evaluates them (E-T9: no timer is shortened) -----------------------------------
  useEffect(() => {
    const nowSec = Math.floor(now / 1000);
    let next = Number.POSITIVE_INFINITY;
    for (const row of composed.rows)
      for (const t of [row.data.opens_at, row.data.closes_at])
        if (t !== null && t > nowSec && t < next) next = t;
    if (!Number.isFinite(next)) return;
    const wait = Math.min(next * 1000 - env.now() + 50, 6 * 60 * 60 * 1000);
    const timer = setTimeout(() => setNow(env.now()), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [composed.rows, now, env]);

  return {
    loading:
      (local === null && current === null && !noDatabase) || overlayLoading,
    rows: composed.rows,
    unreadable: composed.unreadable,
    pendingTasks: current?.pendingTasks ?? [],
    error: env.online ? error : null,
    fromDevice: current === null,
    noDatabase,
    now,
    retry: () => {
      forgetRefusal(env.identity, DAILY);
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CacheRow,
  readCacheRevisionNow,
  readResourcesNow,
  scanResources,
  useAllOutstandingByKind,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import type { TasksApi, TasksResult } from "../api";
import { useBoundaryClock } from "../clock";
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
import {
  type AnswerBasis,
  answerCovers,
  composeRow,
  type Outstanding,
  type RowModel,
} from "../view";

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
  /**
   * When the accepted page chains were DISPATCHED (ms, the earlier of the two scopes; a chain restarted on `409` counts from its restart).
   * The server evaluated the day no earlier than this; a window boundary after it makes a row's derived fields stale, whenever the answer
   * was delivered (R2, revision 2).
   */
  requestedAt: number;
  /** When both scopes had answered (ms): for display only, never evaluation time. */
  receivedAt: number;
  /** The cache page sequence read from the durable sync state when the read was dispatched (null: none yet; `"closed"`: no database). */
  seq: number | null | "closed";
  /** Each scope's `revision` (the server's sync clock when it was read). */
  revisions: { joint: number; personal: number };
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
  /** The shown rows are the last coherent composition while a newer one is read (a sync page committed, or new rows were listed). */
  refreshing: boolean;
  /** The database is absent: nothing was ever saved or synced on this device. */
  noDatabase: boolean;
  now: number;
  retry(): void;
}

const RESTARTS = 3;
const DAILY = "daily";

/**
 * One scope of `/daily`, every page, restarting from the first page on `409 conflict` (TASK-7): never a mix of revisions. The answer carries
 * the scope's `revision` and when its accepted chain was DISPATCHED (`startedAt`, from `clock`): a restart discards the earlier pages and their
 * time with them.
 */
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
  clock: () => number = () => Date.now(),
): Promise<
  | {
      ok: true;
      items: OccurrenceView[];
      pendingTasks: string[];
      revision: number;
      startedAt: number;
    }
  | { ok: false; error: DailyError | "refused" | "closed" | "offline" }
> {
  for (let restart = 0; restart < RESTARTS; restart += 1) {
    const startedAt = clock();
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
        return {
          ok: true,
          items,
          pendingTasks,
          revision: revision ?? page.value.revision,
          startedAt,
        };
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

/** How many times `value` has changed since it was first known (a negative value is "not known yet" and never counts). */
function useChangeCount(value: number): number {
  const [count, setCount] = useState(0);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (value < 0) return;
    if (last.current !== null && last.current !== value) setCount((n) => n + 1);
    last.current = value;
  }, [value]);
  return count;
}

export function useTodayView(day: string, zone: string): TodayView {
  const env = useTasksEnv();
  const data = useDataEnv();
  const outstandingPage = useAllOutstandingByKind(QUEUED_KINDS);
  const position = useCachePosition();
  const [scan, setScan] = useState<{
    key: string;
    rows: Map<string, CacheRow>;
  } | null>(null);
  const [answer, setAnswer] = useState<DailyAnswer | null>(null);
  const [error, setError] = useState<DailyError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${env.identity}\u0000${day}\u0000${zone}`;
  // Two generations of the cache (revision 2). Every committed page (`page_seq`) re-reads the LOCAL rows: cheap, and right whatever the
  // page carried. Only committed CONTENT (the applied revision, which an empty delta page does not move) asks the SERVER again: re-reading
  // `/daily` on every `page_seq` move looped, because the read's own request woke the leader's engine, whose empty page moved `page_seq`
  // again (found by E-C13: two reads per tab and a sync every 0.8 s, for ever). The position's own first load (loading → ready) is not a
  // change of the cache, so neither restarts on it.
  const pageSeq =
    position.status === "ready" ? (position.value?.pageSeq ?? -1) : -2;
  const cacheRevision =
    position.status === "ready"
      ? (position.value?.appliedRevision ?? (position.value ? 0 : -1))
      : -2;
  const syncTick = useChangeCount(pageSeq);
  const contentTick = useChangeCount(cacheRevision);
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
  // A queued draft edited under the same id and status changes its digest (revision 2): the walk sees its new candidates too.
  const draftsKey = outstanding.drafts
    .map((d) => `${d.local_id}:${d.status}:${d.command_digest}`)
    .join(",");

  // ---- the cache walk (D-10a-2): on mount, on day/zone change, when a sync page commits or the queue changes (debounced) -----------
  // The walk only DISCOVERS candidate occurrences; their rows are read again with the related rows (below), at one cache position.
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

  const listed =
    env.online && answer !== null && answer.key === key ? answer : null;
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
    for (const id of listed?.joint.keys() ?? []) set.add(id);
    for (const id of listed?.personal.keys() ?? []) set.add(id);
    return [...set].sort();
  }, [local, listed, projected]);
  const idsKey = ids.join(",");

  // ---- the clock (R8/R2, revision 2): the boundaries of every CANDIDATE row, not only the rows that pass the day's filter ---------------
  const windows = useMemo(() => {
    const out: Array<{ opens_at: number | null; closes_at: number | null }> =
      [];
    for (const row of local?.rows.values() ?? []) {
      const parsed = parseOccurrenceData(row.value);
      if (parsed) out.push(parsed);
    }
    for (const item of listed?.joint.values() ?? []) out.push(item.data);
    for (const item of listed?.personal.values() ?? []) out.push(item.data);
    return out;
  }, [local, listed]);
  const clock = useBoundaryClock(env.now, windows);
  const now = clock.now;

  // ---- the two /daily reads: on mount, day/zone change, reconnect, a committed sync page, a retry, a crossed window boundary ----------
  const read = useRef(0);
  const answered = useRef(false);
  const [restale, setRestale] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on the listed triggers; `clock.epoch` moves at window boundaries
  useEffect(() => {
    if (!env.online) return;
    // A refused read is not asked again on a remount, only on "Try again" (D-12a-13).
    if (refusalOf(env.identity, DAILY) !== null) {
      setError({ kind: "failed" });
      return;
    }
    const mine = ++read.current;
    const isCurrent = () => mine === read.current;
    const delay = answered.current ? 750 : 0;
    const timer = setTimeout(() => {
      const query = { day, zone, limit: env.dailyPageSize };
      void (async () => {
        // The durable cache position when the read is DISPATCHED: a page committed after it makes the answer older than the cache.
        const seq = await readCacheRevisionNow(data);
        if (!isCurrent()) return;
        const [joint, personal] = await Promise.all([
          readWholeDay(
            env.api,
            { ...query, scope: "joint" },
            isCurrent,
            (r) => noteIfRefused(env.identity, DAILY, r),
            env.now,
          ),
          readWholeDay(
            env.api,
            { ...query, scope: "personal" },
            isCurrent,
            (r) => noteIfRefused(env.identity, DAILY, r),
            env.now,
          ),
        ]);
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
        const requestedAt = Math.min(joint.startedAt, personal.startedAt);
        // Sampled at publication: an answer dispatched before a boundary that has now passed is stale on arrival.
        const receivedAt = clock.revalidate();
        const jointMap = new Map(joint.items.map((item) => [item.id, item]));
        for (const item of joint.items)
          noteJoint(env.identity, item.id, {
            outcome: item.outcome,
            periodOutcome: item.period_outcome,
            actionable: item.actionable,
            at: requestedAt,
          });
        answered.current = true;
        setError(null);
        setAnswer({
          key,
          joint: jointMap,
          personal: new Map(personal.items.map((item) => [item.id, item])),
          pendingTasks: joint.pendingTasks,
          requestedAt,
          receivedAt,
          seq,
          revisions: { joint: joint.revision, personal: personal.revision },
        });
        // Stale on arrival (a boundary of a listed row passed while it was read): ask once more, now that the boundary is behind the
        // dispatch; the new read's own dispatch time then covers it, so this cannot repeat for the same boundary.
        const staleOnArrival = [...joint.items, ...personal.items].some(
          (item) => !answerCovers(item.data, requestedAt, receivedAt),
        );
        if (staleOnArrival) setRestale((n) => n + 1);
      })();
    }, delay);
    return () => {
      clearTimeout(timer);
      // A late answer for another identity, day or zone is dropped.
      if (read.current === mine) read.current += 1;
    };
  }, [
    env.api,
    env.identity,
    env.online,
    key,
    contentTick,
    attempt,
    clock.epoch,
    restale,
  ]);

  // ---- related rows: the occurrence itself, my progress stream by its deterministic id and the task, for every candidate, read at ONE
  // cache position (revision 2, C2): the position is read before and after, and a read that spans a committed page is read again. --------
  const [related, setRelated] = useState<{
    idsKey: string;
    key: string;
    seq: number | null | "closed";
    progressIds: Map<string, string>;
    rows: Map<string, CacheRow>;
  } | null>(null);
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
          listed?.joint.get(id)?.data ??
          listed?.personal.get(id)?.data ??
          parseOccurrenceData(local?.rows.get(id)?.value ?? null);
        if (value) taskIds.add(value.task_id);
      }
      for (let attempt = 0; attempt < 3 && live; attempt += 1) {
        const before = await readCacheRevisionNow(data);
        const rows = await readResourcesNow(data, [
          ...ids,
          ...progressIds.values(),
          ...taskIds,
        ]);
        const after = await readCacheRevisionNow(data);
        if (!live) return;
        if (before !== after && attempt < 2) continue;
        // The merged rows (cache with its admitted overlay), never the listing wrapper.
        const merged = new Map<string, CacheRow>();
        for (const [rowId, row] of rows ?? []) merged.set(rowId, row.merged);
        setRelated({ idsKey, key, seq: after, progressIds, rows: merged });
        return;
      }
    })();
    return () => {
      live = false;
    };
  }, [idsKey, key, ready, syncTick, draftsKey, env.accountId, data]);

  // Occurrences this view has held in its cache, for this identity, day and zone: a daily item the cache lacks is ahead of the delta only
  // if the cache never held it here (an old answer cannot bring back a row the cache removed).
  const everCached = useRef<{ key: string; ids: Set<string> }>({
    key,
    ids: new Set(),
  });
  if (everCached.current.key !== key)
    everCached.current = { key, ids: new Set() };
  if (related !== null && related.key === key)
    for (const [rowId, row] of related.rows)
      if (row.kind === "occurrence") everCached.current.ids.add(rowId);

  // ---- rows: composed only from related rows read for the CURRENT candidates; otherwise the last coherent composition is kept ----------
  const coherent =
    related !== null && related.key === key && related.idsKey === idsKey;
  const lastComposed = useRef<{
    key: string;
    rows: RowModel[];
    unreadable: string[];
  } | null>(null);
  const composed = useMemo(() => {
    const rows: RowModel[] = [];
    const unreadable: string[] = [];
    // Nothing to compose from yet: neither the walk nor an answer (unless there is no database at all).
    const sourcesReady = local !== null || listed !== null || noDatabase;
    if (overlayLoading || !coherent || related === null || !sourcesReady)
      return null;
    const cacheSeq = related.seq;
    for (const id of ids) {
      const pid = related.progressIds.get(id);
      if (pid === undefined) continue;
      const occurrence = related.rows.get(id) ?? null;
      const joint = listed?.joint.get(id) ?? null;
      const mine = listed?.personal.get(id) ?? null;
      const basis: AnswerBasis | null =
        listed === null
          ? null
          : {
              requestedAt: listed.requestedAt,
              current:
                cacheSeq === "closed" ||
                (listed.seq !== "closed" && listed.seq === cacheSeq),
              neverCached: !everCached.current.ids.has(id),
            };
      const taskId = (
        occurrence === null
          ? (joint?.data ?? mine?.data ?? null)
          : parseOccurrenceData(occurrence.value)
      )?.task_id;
      const result = composeRow(
        {
          occurrenceId: id,
          progressId: pid,
          occurrence,
          task:
            taskId === undefined ? null : (related.rows.get(taskId) ?? null),
          progress: related.rows.get(pid) ?? null,
          joint,
          personal: mine,
          answer: basis,
        },
        outstanding,
        env.accountId,
        now,
      );
      if (result.kind === "absent") continue;
      if (result.kind === "unreadable") {
        unreadable.push(id);
        continue;
      }
      const row = result.row;
      if (row.archived) continue;
      // The server's membership of the day only while its answer for the row is current; otherwise the device decides (§4.1).
      if (!row.listed && !inDayView(row.data, day, zone, row.actionable))
        continue;
      rows.push(row);
    }
    return { key, rows, unreadable };
  }, [
    ids,
    related,
    listed,
    outstanding,
    env.accountId,
    now,
    day,
    zone,
    overlayLoading,
    coherent,
    key,
    local,
    noDatabase,
  ]);
  if (composed !== null) lastComposed.current = composed;
  const shown =
    composed ??
    (lastComposed.current !== null && lastComposed.current.key === key
      ? lastComposed.current
      : null);

  // An answer dispatched before the cache position the rows were read at is older than the cache (a page committed meanwhile, or the
  // database was created after it): ask again, once for each such pair. Committed content also re-reads through `contentTick`; this covers a
  // commit no notification reported before the read (for example the first page that creates the database).
  const behind =
    listed !== null &&
    related !== null &&
    related.key === key &&
    related.seq !== "closed" &&
    listed.seq !== related.seq
      ? `${listed.receivedAt}|${String(related.seq)}`
      : null;
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (behind === null || askedFor.current === behind) return;
    askedFor.current = behind;
    setRestale((n) => n + 1);
  }, [behind]);

  return {
    loading: shown === null,
    rows: shown?.rows ?? [],
    unreadable: shown?.unreadable ?? [],
    pendingTasks: listed?.pendingTasks ?? [],
    error: env.online ? error : null,
    fromDevice: listed === null,
    refreshing: composed === null && shown !== null,
    noDatabase,
    now,
    retry: () => {
      forgetRefusal(env.identity, DAILY);
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

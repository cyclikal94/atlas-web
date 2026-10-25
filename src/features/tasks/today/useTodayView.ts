import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CacheRow,
  type LocalBasis,
  type LocalRead,
  readAllOutstandingByKindNow,
  readCoherently,
  readLocalBasisNow,
  readResourcesNow,
  type Stage,
  scanResources,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import type { TasksApi, TasksResult } from "../api";
import { useBoundaryClock } from "../clock";
import { useTasksEnv } from "../env";
import { useScopedRead } from "../local-read";
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
  effectiveOccurrence,
  type Outstanding,
  type RowModel,
  type RowSources,
} from "../view";

/**
 * The Today view's data (D-10a-1, §4.1). Resources come from the cache; the derived fields (outcomes, `actionable`, membership,
 * `pending_tasks`) come from `GET /daily` while online, held in page memory for the displayed identity only and never written to storage.
 * Two reads per view: `scope=joint` (membership, the joint result, joint actionability) and `scope=personal` (my result), both
 * `state=all` and filtered here so counts and filters agree. Offline, or before the first answer, the day is derived from the cache by a
 * bounded walk of every cached occurrence (D-10a-2) and the personal reapplication of ARCH §3.3c.
 *
 * LOCAL INPUTS (R9, revision 3; design assessment C3). Everything this device holds for the day (every page of the outstanding work, the
 * walk that discovers the candidates, and their related rows) is read as ONE certified snapshot (`readCoherently`): the local basis is read
 * before and after, so a commit in this page or another between any two of those reads is never published as a day (it is read again, a
 * bounded number of times). A read that failed, or kept changing, is never shown as an empty day: the last complete snapshot of the same
 * identity, day and zone stays, marked stale, with the reason; without one the reason is shown with nothing. Rows are composed from the
 * retained snapshot with the CURRENT time, so time still moves while a newer read is pending. A new snapshot is read when the local
 * composition generation moves (any local commit); the server is asked again only for committed content, the clock or a retry (an empty
 * sync page asks it nothing: the loop of revision 2).
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
  /**
   * The cache's content revision when the read was dispatched (`applied_revision`, null before any batch), `"absent"` when there was no
   * database, `"unknown"` when it could not be read (never current).
   */
  seq: number | null | "absent" | "unknown";
  /** Each scope's `revision` (the server's sync clock when it was read). */
  revisions: { joint: number; personal: number };
  /** The screen clock's generation when the read was dispatched: its derived fields apply only while the clock has not gone back since. */
  clockGeneration: number;
}

export type DailyError =
  | { kind: "failed"; requestId?: string }
  | { kind: "kept_changing" };

export interface TodayView {
  /** Neither the first answer nor the first cache walk has arrived. */
  loading: boolean;
  /**
   * This device's saved tasks could not be read whole (revision 3): `failed` (a read failed) or `unstable` (they kept changing while they
   * were read). Shown whether online or not; never as an empty day.
   */
  localError: "failed" | "unstable" | null;
  /** The rows are the last complete read of this device's data, shown because a newer one could not be completed (`localError`). */
  stale: boolean;
  rows: RowModel[];
  unreadable: string[];
  pendingTasks: string[];
  error: DailyError | null;
  /** The rows come from the cache only (offline, the server read failed, or the answer predates a change of the device clock). */
  fromDevice: boolean;
  /** The shown rows are the last complete snapshot while a newer one is read (a local commit, or new rows were listed). */
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

/** The day's local inputs, read as one certified snapshot (see the module comment). */
interface Snapshot {
  /** The listed daily ids the related rows were read for (their task and my progress included). */
  dailyKey: string;
  basis: LocalBasis | null;
  outstanding: Outstanding;
  /** The candidate occurrences, sorted: walked, projected by an outstanding create, named by an outstanding draft, or listed. */
  candidates: string[];
  progressIds: Map<string, string>;
  /** The related rows (occurrence, task, my progress) with their admitted overlays, by id. */
  rows: Map<string, CacheRow>;
}

const NOTHING: Outstanding = { drafts: [], attention: [] };

/** The snapshot of a device with no database: nothing saved here, so the server's answer alone is the day. */
const EMPTY: Snapshot = {
  dailyKey: "",
  basis: null,
  outstanding: NOTHING,
  candidates: [],
  progressIds: new Map(),
  rows: new Map(),
};

/** The ids of an answer's two scopes, sorted (what the related rows must have been read for). */
const dailyIdsOf = (answer: DailyAnswer | null): string[] =>
  answer === null
    ? []
    : [...new Set([...answer.joint.keys(), ...answer.personal.keys()])].sort();

/**
 * One read of the day's local inputs (the stages `readCoherently` brackets): every page of the outstanding task work, the walk of every
 * cached occurrence (D-10a-2) that discovers the candidates, then the related rows of every candidate and of every listed daily item.
 */
async function readDay(
  data: Parameters<typeof readCoherently>[0],
  input: {
    day: string;
    zone: string;
    accountId: string;
    daily: DailyAnswer | null;
  },
  signal: AbortSignal,
): Promise<Stage<Snapshot>> {
  const queue = await readAllOutstandingByKindNow(data, QUEUED_KINDS);
  if (!queue.ok) return queue;
  const outstanding: Outstanding = queue.value;
  const found = new Map<string, CacheRow>();
  const end = dayEnd(input.day, input.zone);
  const walked = await scanResources(
    data,
    { kind: "occurrence" },
    (rows) => {
      for (const row of rows) {
        const parsed = parseOccurrenceData(row.merged.value);
        if (candidate(parsed, input.day, input.zone, end))
          found.set(row.base.id, row.merged);
      }
      return undefined;
    },
    signal,
  );
  if (walked === "aborted") return { ok: false, why: "aborted" };
  if (walked !== "complete")
    return {
      ok: false,
      why: data.service() === null ? "closed" : "failed",
    };
  // Occurrences an outstanding create projects, or a queued draft names (a correction can bring one into the day: its effective
  // structure decides, after the related read, never the walk's committed predicate).
  const projected = new Set<string>();
  const named = new Set<string>();
  for (const draft of outstanding.drafts) {
    if (draft.kind === "create_task") {
      const id = draft.target_resource_ids[2];
      if (id !== undefined) projected.add(id);
    }
    for (const id of draft.index_targets) named.add(id);
  }
  const daily = input.daily;
  const listedIds = dailyIdsOf(daily);
  const asked = [
    ...new Set([...found.keys(), ...projected, ...named, ...listedIds]),
  ].sort();
  const failure = (): Stage<never> => ({
    ok: false,
    why: data.service() === null ? "closed" : "failed",
  });
  // The rows of every id asked about (a draft names tasks and streams too: only occurrences become candidates).
  const first = await readResourcesNow(data, asked);
  if (first === null) return failure();
  const rows = new Map<string, CacheRow>();
  for (const [rowId, row] of first) rows.set(rowId, row.merged);
  const listedSet = new Set(listedIds);
  const candidates = asked.filter(
    (id) =>
      found.has(id) ||
      projected.has(id) ||
      listedSet.has(id) ||
      rows.get(id)?.kind === "occurrence",
  );
  // My progress stream of every candidate (by its deterministic id) and its task (from its row, its listed item or its projection).
  const progressIds = new Map<string, string>();
  for (const id of candidates)
    progressIds.set(id, await progressId(id, input.accountId));
  if (signal.aborted) return { ok: false, why: "aborted" };
  const more = new Set<string>(progressIds.values());
  for (const id of candidates) {
    const value =
      parseOccurrenceData(rows.get(id)?.value ?? null) ??
      daily?.joint.get(id)?.data ??
      daily?.personal.get(id)?.data ??
      effectiveOccurrence(
        {
          occurrenceId: id,
          progressId: progressIds.get(id) ?? "",
          occurrence: null,
          task: null,
          joint: null,
        },
        outstanding,
      ).data;
    if (value) more.add(value.task_id);
  }
  for (const id of rows.keys()) more.delete(id);
  const second = await readResourcesNow(data, [...more]);
  if (second === null) return failure();
  for (const [rowId, row] of second) rows.set(rowId, row.merged);
  return {
    ok: true,
    value: {
      dailyKey: listedIds.join(","),
      basis: null,
      outstanding,
      candidates,
      progressIds,
      rows,
    },
  };
}

/** The provenance of `answer` as the rows of `snap` see it (R2): content currency against the snapshot, and the clock it was asked in. */
function basisFor(
  snap: Snapshot,
  answer: DailyAnswer | null,
  clockGeneration: number,
): AnswerBasis | null {
  if (answer === null) return null;
  return {
    requestedAt: answer.requestedAt,
    current:
      snap === EMPTY
        ? answer.seq === "absent"
        : snap.basis !== null && answer.seq === snap.basis.appliedRevision,
    sameClock: answer.clockGeneration === clockGeneration,
  };
}

/** The ids a composition covers: the snapshot's candidates and the listed items whose related rows it has read. */
function idsOf(snap: Snapshot, answer: DailyAnswer | null): string[] {
  const ids = new Set(snap.candidates);
  for (const id of dailyIdsOf(answer))
    if (snap === EMPTY || snap.progressIds.has(id)) ids.add(id);
  return [...ids].sort();
}

/** One row's sources, the SAME for the clock's windows and for the composition (R8, revision 3). */
function sourcesOf(
  id: string,
  snap: Snapshot,
  answer: DailyAnswer | null,
  basis: AnswerBasis | null,
): RowSources {
  const pid = snap.progressIds.get(id) ?? "";
  const occurrence = snap.rows.get(id) ?? null;
  const joint = answer?.joint.get(id) ?? null;
  const mine = answer?.personal.get(id) ?? null;
  const taskId = (
    occurrence === null
      ? (joint?.data ?? mine?.data ?? null)
      : parseOccurrenceData(occurrence.value)
  )?.task_id;
  return {
    occurrenceId: id,
    progressId: pid,
    occurrence,
    task: taskId === undefined ? null : (snap.rows.get(taskId) ?? null),
    progress: pid === "" ? null : (snap.rows.get(pid) ?? null),
    joint,
    personal: mine,
    answer: basis,
  };
}

export function useTodayView(day: string, zone: string): TodayView {
  const env = useTasksEnv();
  const data = useDataEnv();
  const position = useCachePosition();
  const [answer, setAnswer] = useState<DailyAnswer | null>(null);
  const [error, setError] = useState<DailyError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${env.identity}\u0000${day}\u0000${zone}`;
  // Only committed CONTENT (the applied revision, which an empty delta page does not move) asks the SERVER again (revision 2: re-reading
  // `/daily` on every `page_seq` move looped with the production leader). Every local commit (the composition generation) re-reads the
  // LOCAL snapshot. The position's own first load (loading → ready) is neither.
  const cacheRevision =
    position.status === "ready"
      ? (position.value?.appliedRevision ?? (position.value ? 0 : -1))
      : -2;
  const composition =
    position.status === "ready" ? (position.value?.composition ?? -1) : -2;
  const contentTick = useChangeCount(cacheRevision);
  // No database on this device: nothing was ever saved or synced here (a watch that failed is not that).
  const noDatabase =
    position.status === "unavailable" && position.reason === "absent";

  const listed =
    env.online && answer !== null && answer.key === key ? answer : null;
  const dailyKey = dailyIdsOf(listed).join(",");

  // ---- the local snapshot: on mount, day/zone/identity change, every local commit, new listed rows, a retry --------------------------
  const listedRef = useRef(listed);
  listedRef.current = listed;
  const local = useScopedRead<Snapshot>(
    key,
    `${composition}|${dailyKey}|${attempt}`,
    (signal) =>
      readCoherently<Snapshot>(
        data,
        () =>
          readDay(
            data,
            { day, zone, accountId: env.accountId, daily: listedRef.current },
            signal,
          ),
        { signal },
      ).then(
        (read): LocalRead<Snapshot> =>
          read.kind === "complete"
            ? { ...read, value: { ...read.value, basis: read.basis } }
            : read,
      ),
    !noDatabase,
  );
  const snapshot: Snapshot | null = noDatabase
    ? EMPTY
    : (local.complete?.value ?? null);
  const localError: TodayView["localError"] =
    noDatabase || local.latest === null || local.latest === "complete"
      ? null
      : local.latest === "unstable"
        ? "unstable"
        : local.latest === "failed"
          ? "failed"
          : null;

  // ---- the clock (R8/R2, revisions 2 and 3): the boundaries of every candidate's EFFECTIVE structure (a projected create, a queued
  // correction, a listed item), resolved exactly as it is composed, before the day's filter ------------------------------------------------
  const windows = useMemo(() => {
    const out: Array<{ opens_at: number | null; closes_at: number | null }> =
      [];
    for (const item of listed?.joint.values() ?? []) out.push(item.data);
    for (const item of listed?.personal.values() ?? []) out.push(item.data);
    if (snapshot === null) return out;
    // Structure does not depend on the clock, so neither does the window it gives (the generation passed is irrelevant here).
    const basis = basisFor(snapshot, listed, 0);
    for (const id of idsOf(snapshot, listed)) {
      const effective = effectiveOccurrence(
        sourcesOf(id, snapshot, listed, basis),
        snapshot.outstanding,
      );
      if (effective.data) out.push(effective.data);
    }
    return out;
  }, [snapshot, listed]);
  const clock = useBoundaryClock(env.now, windows);
  const now = clock.now;

  // ---- the two /daily reads: on mount, day/zone change, reconnect, committed content, a retry, a crossed boundary or a clock moved back
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
        // The clock's generation and the cache's content revision when the read is DISPATCHED: a clock that goes back, or content
        // committed, after it makes the answer older than what it would be compared with.
        const clockGeneration = clock.generationNow();
        const position = await readLocalBasisNow(data);
        const seq: DailyAnswer["seq"] =
          position.kind === "ok"
            ? position.basis.appliedRevision
            : position.kind === "closed"
              ? "absent"
              : "unknown";
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
        // Sampled at publication: an answer dispatched before a boundary that has now passed is stale on arrival, and one dispatched
        // before the clock went back is not the clock's any more (its derived fields never apply; nor is it the joint "as of").
        const receivedAt = clock.revalidate();
        const sameClock = clock.generationNow() === clockGeneration;
        const jointMap = new Map(joint.items.map((item) => [item.id, item]));
        if (sameClock)
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
          clockGeneration,
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

  // ---- rows: composed from the last complete snapshot of this identity, day and zone, with the current time --------------------------
  const composed = useMemo(() => {
    if (snapshot === null) return null;
    const rows: RowModel[] = [];
    const unreadable: string[] = [];
    // Listed rows the snapshot has not read the related rows of yet are left out until it has (a refresh is under way).
    const basis = basisFor(snapshot, listed, clock.generation);
    for (const id of idsOf(snapshot, listed)) {
      const result = composeRow(
        sourcesOf(id, snapshot, listed, basis),
        snapshot.outstanding,
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
    return { rows, unreadable };
  }, [snapshot, listed, env.accountId, now, day, zone, clock.generation]);

  // An answer dispatched before the content revision the snapshot was read at is older than the cache (content committed meanwhile, or
  // the database was created after it): ask again, once for each such pair. Committed content also re-reads through `contentTick`; this
  // covers a commit no notification reported before the read (for example the first page that creates the database).
  const behind =
    listed !== null &&
    snapshot !== null &&
    snapshot !== EMPTY &&
    snapshot.basis !== null &&
    listed.seq !== snapshot.basis.appliedRevision
      ? `${listed.receivedAt}|${String(snapshot.basis.appliedRevision)}`
      : null;
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (behind === null || askedFor.current === behind) return;
    askedFor.current = behind;
    setRestale((n) => n + 1);
  }, [behind]);

  const eligible =
    listed !== null && listed.clockGeneration === clock.generation;
  const pendingRefresh =
    !noDatabase &&
    (local.reading || (snapshot !== null && snapshot.dailyKey !== dailyKey));
  return {
    loading: composed === null && localError === null,
    localError,
    stale: composed !== null && localError !== null,
    rows: composed?.rows ?? [],
    unreadable: composed?.unreadable ?? [],
    pendingTasks: eligible ? listed.pendingTasks : [],
    error: env.online ? error : null,
    fromDevice: !eligible,
    refreshing: composed !== null && pendingRefresh,
    noDatabase,
    now,
    retry: () => {
      forgetRefusal(env.identity, DAILY);
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

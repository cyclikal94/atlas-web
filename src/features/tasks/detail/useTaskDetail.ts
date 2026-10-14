import { useEffect, useMemo, useState } from "react";
import {
  type CacheRow,
  readAllOutstandingByKindNow,
  readAllOutstandingNow,
  readCoherently,
  readResourcesNow,
  scanResources,
  useAllOutstanding,
  useAllOutstandingByKind,
  useCachedResources,
  useCachePosition,
  useDataEnv,
  useResourceList,
} from "../../../data";
import { useBoundaryClock } from "../clock";
import { useTasksEnv } from "../env";
import { useScopedRead } from "../local-read";
import { type JointAnswer, jointOf } from "../memory";
import { QUEUED_KINDS } from "../model/commands";
import {
  type OccurrenceData,
  parseDefinition,
  parseOccurrenceData,
  type TaskDefinition,
} from "../model/contract";
import {
  occurrenceId as occurrenceIdOf,
  progressId as progressIdOf,
  slotKey,
} from "../model/ids";
import { todayIn } from "../model/time";
import {
  composeRow,
  effectiveOccurrence,
  type Outstanding,
  patched,
  type RowModel,
} from "../view";

/**
 * Everything the task detail shows (WF-TASK-01), from the cache and the outstanding drafts (a task created offline shows at once, projected,
 * marked "Not sent yet"): the task, its details (the definition), a page of the occurrences of it this device holds, the displayed
 * occurrence and my part in it.
 *
 * WHICH DAY IS SHOWN (R1, revision 1): an `occurrence` in the address is resolved BY ITS OWN ID and must be one of this task's (its parent
 * is the task's details, and its task id, when it can be read, is the task's); while it is being read nothing is shown, and when it is not
 * on this device or not this task's the view says so (`selection: "unavailable"`) and offers nothing to record: it never shows, or records
 * against, another day in its place. Without one: today's deterministic slot (or `once`) when this device holds it, else the latest by date
 * of ALL the task's saved days (a bounded walk), never only the first page's.
 *
 * The default day is chosen once for the visit (revision 2, assessed against design assessment C3): moving it at midnight while the person
 * is on the page would retarget an open record card or correction (their input belongs to the day they were opened for). The DISPLAYED
 * day's own window is followed by the clock (`now`); the next visit, or the day picker, chooses again.
 *
 * THE DISPLAYED DAY'S ROW (R9, revision 3; design assessment C3, Q17) is composed from ONE certified read of its inputs (the task, the
 * occurrence and my progress rows, every page of the outstanding task work and of the work naming them; `readCoherently`), read again when
 * the local composition generation moves: never from live reads that may each show a different commit. A read that failed or kept changing
 * keeps the last complete one of the same day (`rowError` says why), or shows the reason with no result: never a result from part of it.
 * The clock schedules the window of that same composition (`effectiveOccurrence`).
 */
export interface TaskDetailView {
  status: "loading" | "absent" | "ready";
  task: CacheRow | null;
  execution: CacheRow | null;
  definition: TaskDefinition | null;
  /** The page of saved days the picker shows (by id, then shown by date), plus the selected day when it is on another page. */
  occurrences: Array<{ id: string; data: OccurrenceData | null }>;
  /** The picker's pages: the saved days are listed a page (100) at a time, so every one of them can be reached (Q9). */
  days: {
    /** The person has paged through the saved days: the picker stays while a page is read. */
    paged: boolean;
    more: boolean;
    previous: boolean;
    showMore(): void;
    showPrevious(): void;
  };
  /** How the displayed day was chosen; `unavailable` and `loading` show no day. */
  selection: "explicit" | "default" | "loading" | "unavailable";
  row: RowModel | null;
  unreadable: boolean;
  /** The displayed day's inputs could not be read whole (`failed`, or `unstable`: they kept changing); `row` is then the last complete one. */
  rowError: "failed" | "unstable" | null;
  /** Reads the displayed day's inputs again (after `rowError`). */
  retryRow(): void;
  /** The task is in the cache (not only projected): sharing and revise need it. */
  synced: boolean;
  outstanding: Outstanding;
  joint: JointAnswer | null;
  /** My progress ids by occurrence (deterministic), for a correction's side effects: other people's are read from the cache by parent. */
  progressRows: CacheRow[];
  /**
   * The time the displayed day is evaluated against (R8, revision 2): it moves when the day's window opens or closes, and when the page is
   * shown, focused or restored, so the result, the pill and the recording controls follow the clock without any other change.
   */
  now: number;
}

const progressCache = new Map<string, string>();
/** My deterministic progress id for an occurrence, computed once (async SHA-1). */
export function useProgressId(
  occurrenceId: string | null,
  me: string,
): string | null {
  const key = occurrenceId === null ? null : `${occurrenceId}:${me}`;
  const [value, setValue] = useState<string | null>(
    key === null ? null : (progressCache.get(key) ?? null),
  );
  useEffect(() => {
    if (key === null || occurrenceId === null) {
      setValue(null);
      return;
    }
    const known = progressCache.get(key);
    if (known !== undefined) {
      setValue(known);
      return;
    }
    let live = true;
    void progressIdOf(occurrenceId, me).then((id) => {
      progressCache.set(key, id);
      if (live) setValue(id);
    });
    return () => {
      live = false;
    };
  }, [key, occurrenceId, me]);
  return value;
}

export function useTaskDetail(
  taskId: string,
  occurrenceParam: string | undefined,
): TaskDetailView {
  const env = useTasksEnv();
  const data = useDataEnv();
  const byKind = useAllOutstandingByKind(QUEUED_KINDS);
  const all: Outstanding = useMemo(
    () =>
      byKind.status === "ready"
        ? { drafts: byKind.value.drafts, attention: byKind.value.attention }
        : { drafts: [], attention: [] },
    [byKind],
  );
  const create = all.drafts.find(
    (d) => d.kind === "create_task" && d.target_resource_ids[0] === taskId,
  );
  const cachedTask = useCachedResources([taskId]);
  const executions = useResourceList({
    kind: "execution",
    parentId: taskId,
    limit: 1,
  });
  const cachedExecution =
    executions.status === "ready"
      ? (executions.value.rows[0]?.merged ?? null)
      : null;
  const executionId =
    cachedExecution?.id ?? create?.target_resource_ids[1] ?? null;
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [paged, setPaged] = useState(false);
  const occurrenceList = useResourceList({
    kind: "occurrence",
    parentId: executionId ?? "-",
    after: cursors[cursors.length - 1] ?? null,
  });
  const taskBase =
    cachedTask.status === "ready"
      ? (cachedTask.value[taskId]?.merged ?? null)
      : null;
  const relevant = all.drafts.filter((d) =>
    [taskId, executionId].some(
      (id) => id !== null && d.index_targets.includes(id),
    ),
  );
  const task = patched(taskBase, taskId, relevant);
  const execution =
    executionId === null
      ? null
      : patched(cachedExecution, executionId, relevant);
  const definition =
    execution === null ? null : parseDefinition(execution.value);

  const occurrences = useMemo(() => {
    const out = new Map<string, OccurrenceData | null>();
    if (occurrenceList.status === "ready")
      for (const row of occurrenceList.value.rows)
        out.set(row.base.id, parseOccurrenceData(row.merged.value));
    const projected = create?.target_resource_ids[2];
    if (
      cursors.length === 1 &&
      projected !== undefined &&
      !out.has(projected) &&
      create !== undefined
    ) {
      const row = patched(null, projected, [create]);
      out.set(projected, row === null ? null : parseOccurrenceData(row.value));
    }
    return [...out]
      .map(([id, data]) => ({ id, data }))
      .sort((a, b) => {
        const da = a.data?.slot.date ?? "9999-12-31";
        const db = b.data?.slot.date ?? "9999-12-31";
        return da < db ? -1 : da > db ? 1 : a.id < b.id ? -1 : 1;
      });
  }, [occurrenceList, create, cursors.length]);

  // ---- the displayed occurrence (R1, revision 1) ------------------------------------------------------------------------------------
  // The address's occurrence, by its own id (cached, or the projection of this task's queued create).
  const asked = useCachedResources(
    occurrenceParam === undefined ? [] : [occurrenceParam],
  );
  const askedRow = useMemo((): CacheRow | null | undefined => {
    if (occurrenceParam === undefined) return null;
    if (
      create !== undefined &&
      create.target_resource_ids[2] === occurrenceParam
    )
      return patched(null, occurrenceParam, [create]);
    if (asked.status === "loading") return undefined;
    return asked.status === "ready"
      ? (asked.value[occurrenceParam]?.merged ?? null)
      : null;
  }, [occurrenceParam, asked, create]);
  const belongs = (row: CacheRow | null | undefined): boolean => {
    if (row === null || row === undefined || row.kind !== "occurrence")
      return false;
    if (executionId === null || row.parent_id !== executionId) return false;
    const parsed = parseOccurrenceData(row.value);
    return parsed === null || parsed.task_id === taskId;
  };

  // Without one: today's slot (or `once`), read by its id; else the latest by date of every saved day.
  const [todaysId, setTodaysId] = useState<string | null>(null);
  useEffect(() => {
    if (definition === null) return;
    let live = true;
    const day = todayIn(definition.schedule.timezone, env.now());
    const key =
      definition.schedule.repeat === null ||
      definition.schedule.repeat.frequency === "after_completion"
        ? "once"
        : slotKey(definition.schedule, day);
    void occurrenceIdOf(taskId, key).then((id) => {
      if (live) setTodaysId(id);
    });
    return () => {
      live = false;
    };
  }, [definition, taskId, env]);
  const todays = useCachedResources(
    occurrenceParam === undefined && todaysId !== null ? [todaysId] : [],
  );
  const todaysHeld =
    todaysId !== null &&
    ((create !== undefined && create.target_resource_ids[2] === todaysId) ||
      (todays.status === "ready" && belongs(todays.value[todaysId]?.merged)));
  const position = useCachePosition();
  const pageSeq =
    position.status === "ready" ? (position.value?.pageSeq ?? -1) : -2;
  const [latest, setLatest] = useState<{
    executionId: string;
    id: string | null;
    data: OccurrenceData | null;
  } | null>(null);
  const wantLatest =
    occurrenceParam === undefined &&
    executionId !== null &&
    definition !== null &&
    todaysId !== null &&
    !todaysHeld &&
    todays.status !== "loading";
  // biome-ignore lint/correctness/useExhaustiveDependencies: walked again when a sync page commits
  useEffect(() => {
    if (!wantLatest || executionId === null) return;
    const controller = new AbortController();
    let best: { id: string; date: string; data: OccurrenceData | null } | null =
      null;
    void scanResources(
      data,
      { kind: "occurrence", parentId: executionId },
      (rows) => {
        for (const row of rows) {
          const parsed = parseOccurrenceData(row.merged.value);
          const date = parsed?.slot.date ?? "9999-12-31";
          if (
            best === null ||
            date > best.date ||
            (date === best.date && row.base.id > best.id)
          )
            best = { id: row.base.id, date, data: parsed };
        }
        return undefined;
      },
      controller.signal,
    ).then((end) => {
      if (end !== "complete" || controller.signal.aborted) return;
      const found = best as {
        id: string;
        data: OccurrenceData | null;
      } | null;
      setLatest({
        executionId,
        id: found?.id ?? null,
        data: found?.data ?? null,
      });
    });
    return () => controller.abort();
  }, [wantLatest, executionId, data, pageSeq]);
  const projectedFirst =
    create?.target_resource_ids[2] !== undefined && occurrences.length > 0
      ? (create.target_resource_ids[2] as string)
      : null;

  let selection: TaskDetailView["selection"];
  let chosen: string | null;
  if (occurrenceParam !== undefined) {
    if (
      askedRow === undefined ||
      (executionId === null && executions.status === "loading")
    ) {
      selection = "loading";
      chosen = null;
    } else if (belongs(askedRow)) {
      selection = "explicit";
      chosen = occurrenceParam;
    } else {
      selection = "unavailable";
      chosen = null;
    }
  } else if (todaysHeld) {
    selection = "default";
    chosen = todaysId;
  } else if (latest !== null && latest.executionId === executionId) {
    selection = "default";
    chosen = latest.id ?? projectedFirst;
  } else if (definition === null || executionId === null) {
    // Nothing to walk: a task whose details are not here shows no day.
    selection = "default";
    chosen = null;
  } else {
    selection = "loading";
    chosen = null;
  }
  const progressId = useProgressId(chosen, env.accountId);
  const ids = [
    taskId,
    ...(executionId ? [executionId] : []),
    ...(chosen ? [chosen] : []),
    ...(progressId ? [progressId] : []),
  ];
  const outstanding = useAllOutstanding(ids);
  const othersList = useResourceList({
    kind: "progress",
    parentId: chosen ?? "-",
  });

  const detail: Outstanding = useMemo(() => {
    if (outstanding.status !== "ready") return all;
    const drafts = new Map(all.drafts.map((d) => [d.local_id, d]));
    const attention = new Map(all.attention.map((d) => [d.local_id, d]));
    for (const entry of Object.values(outstanding.value)) {
      for (const d of entry.drafts) drafts.set(d.local_id, d);
      for (const d of entry.attention) attention.set(d.local_id, d);
    }
    return { drafts: [...drafts.values()], attention: [...attention.values()] };
  }, [outstanding, all]);

  const joint = chosen === null ? null : jointOf(env.identity, chosen);
  // ---- the displayed day's inputs, as one certified read (R9, revision 3) ------------------------------------------------------------
  const [attempt, setAttempt] = useState(0);
  const composition =
    position.status === "ready" ? (position.value?.composition ?? -1) : -2;
  const rowRead = useScopedRead<{
    all: Outstanding;
    detail: Outstanding;
    rows: Map<string, CacheRow>;
  }>(
    `${env.identity}\u0000${taskId}\u0000${chosen}\u0000${progressId}`,
    `${composition}|${attempt}`,
    (signal) =>
      readCoherently(
        data,
        async () => {
          const queue = await readAllOutstandingByKindNow(data, QUEUED_KINDS);
          if (!queue.ok) return queue;
          const named = await readAllOutstandingNow(data, ids);
          if (!named.ok) return named;
          const read = await readResourcesNow(data, [
            taskId,
            ...(chosen ? [chosen] : []),
            ...(progressId ? [progressId] : []),
          ]);
          if (read === null)
            return {
              ok: false,
              why: data.service() === null ? "closed" : "failed",
            } as const;
          const drafts = new Map(
            queue.value.drafts.map((d) => [d.local_id, d]),
          );
          const attention = new Map(
            queue.value.attention.map((d) => [d.local_id, d]),
          );
          for (const entry of Object.values(named.value)) {
            for (const d of entry.drafts) drafts.set(d.local_id, d);
            for (const d of entry.attention) attention.set(d.local_id, d);
          }
          const rows = new Map<string, CacheRow>();
          for (const [rowId, row] of read) rows.set(rowId, row.merged);
          return {
            ok: true,
            value: {
              all: queue.value,
              detail: {
                drafts: [...drafts.values()],
                attention: [...attention.values()],
              },
              rows,
            },
          } as const;
        },
        { signal },
      ),
    chosen !== null && progressId !== null,
  );
  const inputs = rowRead.complete?.value ?? null;
  const rowError: TaskDetailView["rowError"] =
    rowRead.latest === "failed" || rowRead.latest === "unstable"
      ? rowRead.latest
      : null;
  const rowSources =
    chosen === null || progressId === null || inputs === null
      ? null
      : {
          occurrenceId: chosen,
          progressId,
          occurrence: inputs.rows.get(chosen) ?? null,
          task: inputs.rows.get(taskId) ?? null,
          progress: inputs.rows.get(progressId) ?? null,
          joint: null,
          personal: null,
          answer: null,
        };
  // The displayed day's window as it will be composed (its queued correction applied): the clock wakes at its boundaries (R8).
  const shownWindow =
    rowSources === null || inputs === null
      ? null
      : effectiveOccurrence(rowSources, inputs.detail).data;
  const clock = useBoundaryClock(
    env.now,
    shownWindow === null ? [] : [shownWindow],
  );
  let row: RowModel | null = null;
  let unreadable = false;
  if (rowSources !== null && inputs !== null) {
    const result = composeRow(
      rowSources,
      inputs.detail,
      env.accountId,
      clock.now,
    );
    if (result.kind === "row") row = result.row;
    else if (result.kind === "unreadable") unreadable = true;
  }
  const loading =
    cachedTask.status === "loading" || executions.status === "loading";
  // Until every page of the outstanding work is read no day is composed: a personal result is never computed from part of it (R4). The
  // row's own inputs are one certified read (above): until it has completed once, the day is loading, unless it failed.
  const overlayLoading =
    byKind.status === "loading" || outstanding.status === "loading";
  const rowLoading = chosen !== null && inputs === null && rowError === null;
  // The picker lists the page's days, and the selected day when it is on another page.
  const listed =
    chosen !== null && !occurrences.some((o) => o.id === chosen)
      ? [
          ...occurrences,
          {
            id: chosen,
            data:
              parseOccurrenceData(
                (chosen === occurrenceParam
                  ? askedRow
                  : chosen === todaysId
                    ? todays.status === "ready"
                      ? todays.value[chosen]?.merged
                      : null
                    : null
                )?.value ?? null,
              ) ?? (chosen === latest?.id ? latest.data : null),
          },
        ]
      : occurrences;
  const page = occurrenceList.status === "ready" ? occurrenceList.value : null;
  return {
    status: loading ? "loading" : task === null ? "absent" : "ready",
    task,
    execution,
    definition,
    occurrences: listed,
    days: {
      paged: cursors.length > 1 || paged,
      more: page?.next !== null && page?.next !== undefined,
      previous: cursors.length > 1,
      showMore: () => {
        const next = page?.next;
        if (!next) return;
        setPaged(true);
        setCursors((c) => [...c, next]);
      },
      showPrevious: () =>
        setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    },
    selection:
      (overlayLoading || rowLoading) && chosen !== null ? "loading" : selection,
    row: overlayLoading ? null : row,
    unreadable,
    rowError,
    retryRow: () => setAttempt((n) => n + 1),
    synced: taskBase !== null,
    outstanding: detail,
    joint,
    progressRows:
      othersList.status === "ready"
        ? othersList.value.rows.map((r) => r.merged)
        : [],
    now: clock.now,
  };
}

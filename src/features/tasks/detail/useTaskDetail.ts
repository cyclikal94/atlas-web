import { useEffect, useMemo, useState } from "react";
import {
  type CacheRow,
  scanResources,
  useAllOutstanding,
  useAllOutstandingByKind,
  useCachedResources,
  useCachePosition,
  useDataEnv,
  useResourceList,
} from "../../../data";
import { useTasksEnv } from "../env";
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
import { composeRow, type Outstanding, patched, type RowModel } from "../view";

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
  /** The task is in the cache (not only projected): sharing and revise need it. */
  synced: boolean;
  outstanding: Outstanding;
  joint: JointAnswer | null;
  /** My progress ids by occurrence (deterministic), for a correction's side effects: other people's are read from the cache by parent. */
  progressRows: CacheRow[];
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
  const occurrenceCached = useCachedResources(chosen ? [chosen] : []);
  const progressCached = useCachedResources(progressId ? [progressId] : []);
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
  let row: RowModel | null = null;
  let unreadable = false;
  if (chosen !== null && progressId !== null) {
    const occurrenceRow =
      occurrenceCached.status === "ready"
        ? (occurrenceCached.value[chosen]?.merged ?? null)
        : null;
    const progressRow =
      progressCached.status === "ready"
        ? (progressCached.value[progressId]?.merged ?? null)
        : null;
    const result = composeRow(
      {
        occurrenceId: chosen,
        progressId,
        occurrence: occurrenceRow,
        task: taskBase,
        progress: progressRow,
        joint: null,
        personal: null,
        answeredAt: null,
      },
      detail,
      env.accountId,
      env.now(),
    );
    if (result.kind === "row") row = result.row;
    else unreadable = true;
  }
  const loading =
    cachedTask.status === "loading" || executions.status === "loading";
  // Until every page of the outstanding work is read no day is composed: a personal result is never computed from part of it (R4).
  const overlayLoading =
    byKind.status === "loading" || outstanding.status === "loading";
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
    selection: overlayLoading && chosen !== null ? "loading" : selection,
    row: overlayLoading ? null : row,
    unreadable,
    synced: taskBase !== null,
    outstanding: detail,
    joint,
    progressRows:
      othersList.status === "ready"
        ? othersList.value.rows.map((r) => r.merged)
        : [],
  };
}

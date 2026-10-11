import { useEffect, useMemo, useState } from "react";
import {
  type CacheRow,
  useCachedResources,
  useOutstanding,
  useOutstandingByKind,
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
 * marked "Not sent yet"): the task, its details (the definition), the occurrences of it this device holds, the displayed occurrence (the
 * `occurrence` parameter; else today's deterministic slot or `once`; else the latest by date) and my part in it.
 */
export interface TaskDetailView {
  status: "loading" | "absent" | "ready";
  task: CacheRow | null;
  execution: CacheRow | null;
  definition: TaskDefinition | null;
  occurrences: Array<{ id: string; data: OccurrenceData | null }>;
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
  const byKind = useOutstandingByKind(QUEUED_KINDS);
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
  const occurrenceList = useResourceList({
    kind: "occurrence",
    parentId: executionId ?? "-",
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
  }, [occurrenceList, create]);

  // The displayed occurrence: the parameter; else today's slot (or `once`); else the latest by date.
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
  const chosen =
    (occurrenceParam !== undefined &&
    occurrences.some((o) => o.id === occurrenceParam)
      ? occurrenceParam
      : null) ??
    (todaysId !== null && occurrences.some((o) => o.id === todaysId)
      ? todaysId
      : null) ??
    occurrences[occurrences.length - 1]?.id ??
    null;
  const progressId = useProgressId(chosen, env.accountId);
  const ids = [
    taskId,
    ...(executionId ? [executionId] : []),
    ...(chosen ? [chosen] : []),
    ...(progressId ? [progressId] : []),
  ];
  const outstanding = useOutstanding(ids);
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
    for (const entry of Object.values(outstanding.value.byId)) {
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
  return {
    status: loading ? "loading" : task === null ? "absent" : "ready",
    task,
    execution,
    definition,
    occurrences,
    row,
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

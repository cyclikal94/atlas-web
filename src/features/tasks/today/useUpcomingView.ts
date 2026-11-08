import { useMemo, useState } from "react";
import {
  type CacheRow,
  type LocalRead,
  readAllOutstandingByKindNow,
  readCoherently,
  readResourcesNow,
  type Stage,
  scanResources,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import { useTasksEnv } from "../env";
import { useScopedRead } from "../local-read";
import {
  type AheadSource,
  type AheadTarget,
  aheadTargets,
} from "../model/ahead";
import { QUEUED_KINDS } from "../model/commands";
import { parseDefinition, parseOccurrenceData } from "../model/contract";
import { progressId } from "../model/ids";
import { addDays, todayIn } from "../model/time";
import {
  composeRow,
  effectiveOccurrence,
  type Outstanding,
  type RowModel,
} from "../view";

/**
 * The days after the displayed one (the "Upcoming" fold of the day view), from THIS DEVICE only: every cached occurrence dated after
 * the day and within the horizon, with the outstanding drafts applied, composed exactly as an offline day is (`composeRow` with no server
 * answer). The server's `/daily` is a one-day read and is asked for the displayed day only; the days ahead say so. The read is one
 * certified snapshot (`readCoherently`, as the day's is), read again on every local commit; a read that failed, or kept changing, keeps
 * the last complete snapshot and says why, never an empty horizon.
 *
 * The same snapshot plans the LOOK-AHEAD (`model/ahead.ts`, the Final design, 8 November 2026): from every task's details this device
 * holds (the `execution` rows), which tasks the fold asks the page's runner to bring up to date through the horizon, so the days ahead are
 * made by the server before they come. `ahead` is empty until the read lands.
 */
export const UPCOMING_HORIZON_DAYS = 183;

export interface UpcomingView {
  loading: boolean;
  error: "failed" | "unstable" | null;
  stale: boolean;
  rows: RowModel[];
  /** The look-ahead plan: the tasks to bring up to date through the days ahead (`model/ahead.ts`). */
  ahead: AheadTarget[];
  noDatabase: boolean;
  retry(): void;
}

interface Snapshot {
  outstanding: Outstanding;
  candidates: string[];
  progressIds: Map<string, string>;
  rows: Map<string, CacheRow>;
  ahead: AheadTarget[];
}

const EMPTY: Snapshot = {
  outstanding: { drafts: [], attention: [] },
  candidates: [],
  progressIds: new Map(),
  rows: new Map(),
  ahead: [],
};

async function readAhead(
  data: Parameters<typeof readCoherently>[0],
  input: {
    fromDay: string;
    untilDay: string;
    accountId: string;
    today: string;
  },
  signal: AbortSignal,
): Promise<Stage<Snapshot>> {
  const queue = await readAllOutstandingByKindNow(data, QUEUED_KINDS);
  if (!queue.ok) return queue;
  const outstanding: Outstanding = queue.value;
  const found = new Map<string, CacheRow>();
  // The look-ahead's sources: every task's details this device holds (an `execution` row names its task as its parent).
  const details: AheadSource[] = [];
  const detailsWalk = await scanResources(
    data,
    { kind: "execution" },
    (rows) => {
      for (const row of rows) {
        const taskId = row.merged.parent_id;
        if (taskId === null) continue;
        details.push({
          taskId,
          definition: parseDefinition(row.merged.value),
          archived: row.merged.archived,
        });
      }
      return undefined;
    },
    signal,
  );
  if (detailsWalk === "aborted") return { ok: false, why: "aborted" };
  if (detailsWalk !== "complete")
    return { ok: false, why: data.service() === null ? "closed" : "failed" };
  const walked = await scanResources(
    data,
    { kind: "occurrence" },
    (rows) => {
      for (const row of rows) {
        const parsed = parseOccurrenceData(row.merged.value);
        if (parsed === null) continue;
        const date = parsed.slot.date;
        if (date !== null && date > input.fromDay && date <= input.untilDay)
          found.set(row.base.id, row.merged);
      }
      return undefined;
    },
    signal,
  );
  if (walked === "aborted") return { ok: false, why: "aborted" };
  if (walked !== "complete")
    return { ok: false, why: data.service() === null ? "closed" : "failed" };
  const failure = (): Stage<never> => ({
    ok: false,
    why: data.service() === null ? "closed" : "failed",
  });
  // Occurrences an outstanding create projects (a task made here and not sent yet may be dated ahead).
  const projected: string[] = [];
  for (const draft of outstanding.drafts)
    if (draft.kind === "create_task") {
      const id = draft.target_resource_ids[2];
      if (id !== undefined) projected.push(id);
    }
  const candidates = [...new Set([...found.keys(), ...projected])].sort();
  const rows = new Map<string, CacheRow>(found);
  const progressIds = new Map<string, string>();
  const more = new Set<string>();
  for (const id of candidates) {
    const pid = await progressId(id, input.accountId);
    progressIds.set(id, pid);
    more.add(pid);
    const value =
      parseOccurrenceData(rows.get(id)?.value ?? null) ??
      effectiveOccurrence(
        {
          occurrenceId: id,
          progressId: pid,
          occurrence: null,
          task: null,
          joint: null,
        },
        outstanding,
      ).data;
    if (value) more.add(value.task_id);
  }
  if (signal.aborted) return { ok: false, why: "aborted" };
  const related = await readResourcesNow(data, [...more]);
  if (related === null) return failure();
  for (const [rowId, row] of related) rows.set(rowId, row.merged);
  return {
    ok: true,
    value: {
      outstanding,
      candidates,
      progressIds,
      rows,
      ahead: aheadTargets(details, input.today),
    },
  };
}

export function useUpcomingView(
  fromDay: string,
  zone: string,
  now: number,
): UpcomingView {
  const env = useTasksEnv();
  const data = useDataEnv();
  const position = useCachePosition();
  const [attempt, setAttempt] = useState(0);
  const untilDay = addDays(fromDay, UPCOMING_HORIZON_DAYS);
  // The look-ahead reaches from the device's today (the server's horizon is counted from its own), not the displayed day.
  const today = todayIn(zone, now);
  const key = `${env.identity}\u0000ahead\u0000${fromDay}\u0000${zone}\u0000${today}`;
  const composition =
    position.status === "ready" ? (position.value?.composition ?? -1) : -2;
  const noDatabase =
    position.status === "unavailable" && position.reason === "absent";
  const local = useScopedRead<Snapshot>(
    key,
    `${composition}|${attempt}`,
    (signal) =>
      readCoherently<Snapshot>(
        data,
        () =>
          readAhead(
            data,
            { fromDay, untilDay, accountId: env.accountId, today },
            signal,
          ),
        { signal },
      ).then((read): LocalRead<Snapshot> => read),
    !noDatabase,
  );
  const snapshot: Snapshot | null = noDatabase
    ? EMPTY
    : (local.complete?.value ?? null);
  const error: UpcomingView["error"] =
    noDatabase || local.latest === null || local.latest === "complete"
      ? null
      : local.latest === "unstable"
        ? "unstable"
        : local.latest === "failed"
          ? "failed"
          : null;
  const rows = useMemo(() => {
    if (snapshot === null) return null;
    const out: RowModel[] = [];
    for (const id of snapshot.candidates) {
      const pid = snapshot.progressIds.get(id) ?? "";
      const occurrence = snapshot.rows.get(id) ?? null;
      const taskId =
        occurrence === null
          ? undefined
          : parseOccurrenceData(occurrence.value)?.task_id;
      const result = composeRow(
        {
          occurrenceId: id,
          progressId: pid,
          occurrence,
          task:
            taskId === undefined ? null : (snapshot.rows.get(taskId) ?? null),
          progress: pid === "" ? null : (snapshot.rows.get(pid) ?? null),
          joint: null,
          personal: null,
          answer: null,
        },
        snapshot.outstanding,
        env.accountId,
        now,
      );
      if (result.kind !== "row") continue;
      const row = result.row;
      const date = row.data.slot.date;
      if (row.archived || date === null || date <= fromDay || date > untilDay)
        continue;
      out.push(row);
    }
    return out;
  }, [snapshot, env.accountId, now, fromDay, untilDay]);
  return {
    loading: rows === null && error === null,
    error,
    stale: rows !== null && error !== null,
    rows: rows ?? [],
    ahead: snapshot?.ahead ?? [],
    noDatabase,
    retry: () => setAttempt((n) => n + 1),
  };
}

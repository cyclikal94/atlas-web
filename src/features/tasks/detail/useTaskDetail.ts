import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CacheRow,
  type DataEnv,
  type DraftWithCommand,
  type ResourcePage,
  readAllOutstandingByKindNow,
  readAllOutstandingNow,
  readCoherently,
  readResourcePageNow,
  readResourcesNow,
  type Stage,
  scanResources,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import { useBoundaryClock } from "../clock";
import { useTasksEnv } from "../env";
import { disownKept, keptEntry, keptKey, useKeptInput } from "../kept-input";
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
import { type TaskVisit, useTaskVisit } from "../visit";
import { correctionKey, disownCorrection, resumable } from "./correction-owner";
import { forgetKeptFix, hasKeptFix } from "./EntryHistory";

/**
 * Everything the task detail shows (WF-TASK-01), from the cache and the outstanding drafts (a task created offline shows at once, projected,
 * marked "Not sent yet"): the task, its details (the definition), a page of the occurrences of it this device holds, the displayed
 * occurrence and my part in it.
 *
 * ONE CERTIFIED READ (R9, revision 4; design assessment C1): the task, its execution, the displayed day's selection, the queue (every page),
 * the outstanding work naming them, the day and my progress rows and every progress stream of the day are read as ONE composition
 * (`readCoherently`), read again when the local composition generation moves or on Try again. So:
 * - "This task isn't on this device" (`absent`) and "no day" are said only by a COMPLETE read. A read that failed or kept changing, with
 *   no complete read of the same identity, database, task and address, is `error` (with Try again), never absence; with one it is kept,
 *   marked stale (`readError`), and Try again reads everything again, the task and the selection included.
 * - The displayed task, details, day, outstanding work and row always come from the same read: none of them can show another commit.
 *
 * WHICH DAY IS SHOWN (R1, revision 1): an `occurrence` in the address is resolved BY ITS OWN ID and must be one of this task's (its parent
 * is the task's details, and its task id, when it can be read, is the task's); when it is not on this device or not this task's the view
 * says so (`selection: "unavailable"`) and offers nothing to record: it never shows, or records against, another day in its place. Without
 * one: today's deterministic slot (or `once`) when this device holds it, else the latest by date of ALL the task's saved days (the whole
 * walk), never only the first page's.
 *
 * The default day is chosen once for the visit (revision 2, enforced in revision 4): moving it at midnight, or to a day synced later, while
 * the person is on the page would retarget an open record card or correction. Later reads keep it; when it is no longer this task's here
 * (a committed page removed it, in this tab or another) the view says so (`unavailable`, `lost`) and never chooses another day in its place
 * (revision 20, DA20-I1): only the person does ("Show this task's days", `chooseAgain`), or the next visit. The DISPLAYED day's own window is
 * followed by the clock (`now`); the next visit, or the day picker, chooses again.
 *
 * The visit OWNS the input typed for its day (revision 20, DA20-I1; ia.md §1.3.3): while it shows a day, available or not, that day's
 * amount, fix and correction sessions are its own, so an editor the data hides keeps its raw input and its pending save, and shows them
 * again when the day is back. Ending the visit lets go as any departure does (it goes on at the sync screens); showing another day in place
 * lets go of the day shown before unless it was parked. The input is never moved to another day.
 *
 * The LOGICAL visit (revision 21, DA21-I1/I2; revision 22, R34 / DA22-I1..I3): its own day is its target before anything says whether the
 * task's details can be read (missing or unreadable details show it unavailable and keep its input), and it owns every day's input typed
 * on it, parked ones and those kept through the sync screens included, whether or not their editors mount again. The visit is the
 * screen's address, not this hook's mount (`visit.ts`): a remount at the same address (the cache gate, the protected tree) goes on with the
 * same day and input, and its ordinary end (anywhere but the sync screens and this address, or another identity) drops them all.
 *
 * A visit to the sync screens is part of the visit when it holds the person's input (revision 19, DA19-I1; ia.md §1.3.3): the day chosen
 * is kept with the screen (`kept-input.ts`), and coming back shows THAT day again when an amount, a fix or a correction typed for it is
 * kept, before any default is chosen, so the input is found where it was typed. If that day is no longer this task's here, the view says
 * so (`unavailable`, `lost`) rather than showing another day in its place; the input stays with its own day, never moved to another.
 * Without kept input the next visit chooses afresh. A day in the address is the address's.
 *
 * The day picker's FIRST page is part of the same read; a later page is a read of its own (it lists days to navigate to; it never chooses the
 * displayed one): its failure is shown with Try again and never says there are no more days.
 */
export interface TaskDetailView {
  /** `error`: nothing complete has been read for this task here yet (the read failed or kept changing); never absence. */
  status: "loading" | "absent" | "error" | "ready";
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
    /** The page could not be read whole (`failed`, or `unstable`); `more` is then unknown, not "no more". */
    error: "failed" | "unstable" | null;
    showMore(): void;
    showPrevious(): void;
    /** Reads the picker's page again. */
    retry(): void;
  };
  /** How the displayed day was chosen; `unavailable` and `loading` show no day. */
  selection: "explicit" | "default" | "loading" | "unavailable";
  /**
   * `unavailable` because the visit's own day (not one named by the address) is no longer this task's here: the day kept with the
   * person's input through a sync visit (DA19-I1), or the day this visit showed (DA20-I1).
   */
  lost: boolean;
  /** Lets go of that day: the visit chooses its default day again (the input stays with its own day). */
  chooseAgain(): void;
  row: RowModel | null;
  unreadable: boolean;
  /**
   * The last read could not be read whole (`failed`, or `unstable`: it kept changing). With `status: "ready"` what is shown is the last
   * complete read, stale; with `status: "error"` there is none.
   */
  readError: "failed" | "unstable" | null;
  /**
   * What is shown is the last complete read and no later read of this device's data is due, running or failed (revision 6, D6-5): a change
   * seen but not yet read in leaves the shown detail a retained display, never a current one.
   */
  current: boolean;
  /** Reads everything again (the task, its details, the day's selection and inputs). */
  retry(): void;
  /** The task is in the cache (not only projected): sharing and revise need it. */
  synced: boolean;
  outstanding: Outstanding;
  joint: JointAnswer | null;
  /** Every progress stream of the displayed day (read whole, in the same read): a correction's side effects and who counts. */
  progressRows: CacheRow[];
  /**
   * The time the displayed day is evaluated against (R8, revision 2): it moves when the day's window opens or closes, and when the page is
   * shown, focused or restored, so the result, the pill and the recording controls follow the clock without any other change.
   */
  now: number;
}

const progressCache = new Map<string, string>();
/** My deterministic progress id for an occurrence, computed once (async SHA-1). */
async function progressIdFor(occurrenceId: string, me: string) {
  const key = `${occurrenceId}:${me}`;
  const known = progressCache.get(key);
  if (known !== undefined) return known;
  const id = await progressIdOf(occurrenceId, me);
  progressCache.set(key, id);
  return id;
}

/** What one certified read of the detail holds. */
interface DetailInputs {
  queue: Outstanding;
  /** The queue and the outstanding work naming the task, its details, the day and my progress (every page of each). */
  detail: Outstanding;
  create: DraftWithCommand | null;
  /** The cached task and execution (with their overlays), or null. */
  taskBase: CacheRow | null;
  executionBase: CacheRow | null;
  executionId: string | null;
  /** The day picker's first page of saved days. */
  firstPage: ResourcePage | null;
  selection: "explicit" | "default" | "unavailable";
  /** `unavailable` because the visit's own day (kept through a sync visit, or shown by this visit) is no longer this task's here. */
  lost: boolean;
  /** The day this visit is about, shown or `unavailable` (the address's, the visit's, or the one kept with input), with my progress id. */
  target: string | null;
  targetProgress: string | null;
  chosen: string | null;
  chosenData: OccurrenceData | null;
  progressId: string | null;
  /** The chosen day and my progress, cached (with overlays). */
  rows: Map<string, CacheRow>;
  /** Every cached progress stream of the chosen day. */
  others: CacheRow[];
}

const EMPTY: Outstanding = { drafts: [], attention: [] };

const createOf = (queue: Outstanding, taskId: string) =>
  queue.drafts.find(
    (d) => d.kind === "create_task" && d.target_resource_ids[0] === taskId,
  ) ?? null;

const relevantTo = (queue: Outstanding, ids: ReadonlyArray<string | null>) =>
  queue.drafts.filter((d) =>
    ids.some((id) => id !== null && d.index_targets.includes(id)),
  );

/**
 * The detail's inputs, as one stage of a certified read. A failed or interrupted read of any of them fails the stage: nothing here turns a
 * failure into an absent task, details or day.
 */
async function readDetail(
  data: Pick<DataEnv, "service">,
  input: {
    taskId: string;
    occurrenceParam: string | undefined;
    pinned: string | null;
    /** The day this screen showed when the person left for the sync screens, or null. */
    returned: string | null;
    /** Whether input typed for that day (my progress there, or its correction) is kept for this screen. */
    keeps(occurrenceId: string, progressId: string): boolean;
    me: string;
    now: number;
  },
  signal: AbortSignal,
): Promise<Stage<DetailInputs>> {
  const { taskId, occurrenceParam } = input;
  const service = data.service();
  const unread = (): Stage<never> => ({
    ok: false,
    why: signal.aborted
      ? "aborted"
      : data.service() === service && service !== null
        ? "failed"
        : "closed",
  });
  const queue = await readAllOutstandingByKindNow(data, QUEUED_KINDS);
  if (!queue.ok) return queue;
  const create = createOf(queue.value, taskId);
  const task = await readResourcesNow(data, [taskId]);
  if (task === null) return unread();
  const executions = await readResourcePageNow(data, {
    kind: "execution",
    parentId: taskId,
    limit: 1,
  });
  if (!executions.ok) return executions;
  const executionBase = executions.value.rows[0]?.merged ?? null;
  const executionId =
    executionBase?.id ?? create?.target_resource_ids[1] ?? null;
  const execution =
    executionId === null
      ? null
      : patched(
          executionBase,
          executionId,
          relevantTo(queue.value, [taskId, executionId]),
        );
  const definition =
    execution === null ? null : parseDefinition(execution.value);
  let firstPage: ResourcePage | null = null;
  if (executionId !== null) {
    const page = await readResourcePageNow(data, {
      kind: "occurrence",
      parentId: executionId,
    });
    if (!page.ok) return page;
    firstPage = page.value;
  }
  const belongs = (row: CacheRow | null): row is CacheRow => {
    if (row === null || row.kind !== "occurrence") return false;
    if (executionId === null || row.parent_id !== executionId) return false;
    const parsed = parseOccurrenceData(row.value);
    return parsed === null || parsed.task_id === taskId;
  };
  // A day by its own id: the projection of this task's queued create, or the cached row.
  const dayById = async (id: string): Promise<Stage<CacheRow | null>> => {
    if (create !== null && create.target_resource_ids[2] === id)
      return { ok: true, value: patched(null, id, [create]) };
    const read = await readResourcesNow(data, [id]);
    if (read === null) return unread();
    return { ok: true, value: read.get(id)?.merged ?? null };
  };

  let selection: DetailInputs["selection"] = "default";
  let lost = false;
  let target: string | null = null;
  let chosen: string | null = null;
  let chosenRow: CacheRow | null = null;
  if (occurrenceParam !== undefined) {
    target = occurrenceParam;
    const asked = await dayById(occurrenceParam);
    if (!asked.ok) return asked;
    if (belongs(asked.value)) {
      selection = "explicit";
      chosen = occurrenceParam;
      chosenRow = asked.value;
    } else selection = "unavailable";
  } else {
    // The visit's own day is its target BEFORE anything says whether the task's execution or details can be read (revision 21, DA21-I1):
    // with a parent missing or unreadable here the day is unavailable (nothing to record against), and the visit still holds its input.
    const shows = (row: CacheRow | null): row is CacheRow =>
      definition !== null && belongs(row);
    if (input.pinned !== null) {
      // The visit's day, resolved by its id on every read: gone, it is unavailable, never replaced by another day (DA20-I1).
      target = input.pinned;
      const kept = await dayById(input.pinned);
      if (!kept.ok) return kept;
      if (shows(kept.value)) {
        chosen = input.pinned;
        chosenRow = kept.value;
      } else {
        selection = "unavailable";
        lost = true;
      }
    }
    const back = input.returned;
    if (
      target === null &&
      back !== null &&
      input.keeps(back, await progressIdFor(back, input.me))
    ) {
      target = back;
      const kept = await dayById(back);
      if (!kept.ok) return kept;
      if (shows(kept.value)) {
        chosen = back;
        chosenRow = kept.value;
      } else {
        selection = "unavailable";
        lost = true;
      }
    }
    if (
      chosen === null &&
      !lost &&
      definition !== null &&
      executionId !== null
    ) {
      // Today's slot (or `once`), read by its id; else the latest by date of every saved day.
      const day = todayIn(definition.schedule.timezone, input.now);
      const todaysId = await occurrenceIdOf(
        taskId,
        definition.schedule.repeat === null ||
          definition.schedule.repeat.frequency === "after_completion"
          ? "once"
          : slotKey(definition.schedule, day),
      );
      const todays = await dayById(todaysId);
      if (!todays.ok) return todays;
      if (belongs(todays.value)) {
        chosen = todaysId;
        chosenRow = todays.value;
      }
    }
    if (
      chosen === null &&
      !lost &&
      definition !== null &&
      executionId !== null
    ) {
      let best: { id: string; date: string; row: CacheRow } | null = null;
      const end = await scanResources(
        data,
        { kind: "occurrence", parentId: executionId },
        (rows) => {
          for (const listed of rows) {
            const date =
              parseOccurrenceData(listed.merged.value)?.slot.date ??
              "9999-12-31";
            if (
              best === null ||
              date > best.date ||
              (date === best.date && listed.base.id > best.id)
            )
              best = { id: listed.base.id, date, row: listed.merged };
          }
          return undefined;
        },
        signal,
      );
      if (end !== "complete") return unread();
      const found = best as { id: string; row: CacheRow } | null;
      const projected = create?.target_resource_ids[2];
      if (found !== null) {
        chosen = found.id;
        chosenRow = found.row;
      } else if (create !== null && projected !== undefined) {
        chosen = projected;
        chosenRow = patched(null, projected, [create]);
      }
    }
  }
  if (signal.aborted) return unread();
  target ??= chosen;

  const progressId =
    chosen === null ? null : await progressIdFor(chosen, input.me);
  const targetProgress =
    target === null ? null : await progressIdFor(target, input.me);
  const named = await readAllOutstandingNow(data, [
    taskId,
    ...(executionId ? [executionId] : []),
    ...(chosen ? [chosen] : []),
    ...(progressId ? [progressId] : []),
  ]);
  if (!named.ok) return named;
  const drafts = new Map(queue.value.drafts.map((d) => [d.local_id, d]));
  const attention = new Map(queue.value.attention.map((d) => [d.local_id, d]));
  for (const entry of Object.values(named.value)) {
    for (const d of entry.drafts) drafts.set(d.local_id, d);
    for (const d of entry.attention) attention.set(d.local_id, d);
  }
  const rows = new Map<string, CacheRow>();
  const others: CacheRow[] = [];
  if (chosen !== null && progressId !== null) {
    const read = await readResourcesNow(data, [chosen, progressId]);
    if (read === null) return unread();
    for (const [rowId, row] of read) rows.set(rowId, row.merged);
    const end = await scanResources(
      data,
      { kind: "progress", parentId: chosen },
      (page) => {
        for (const listed of page) others.push(listed.merged);
        return undefined;
      },
      signal,
    );
    if (end !== "complete") return unread();
  }
  return {
    ok: true,
    value: {
      queue: queue.value,
      detail: {
        drafts: [...drafts.values()],
        attention: [...attention.values()],
      },
      create,
      taskBase: task.get(taskId)?.merged ?? null,
      executionBase,
      executionId,
      firstPage,
      selection,
      lost,
      target,
      targetProgress,
      chosen,
      chosenData:
        chosenRow === null ? null : parseOccurrenceData(chosenRow.value),
      progressId,
      rows,
      others,
    },
  };
}

/** The day a logical visit of a task's detail shows (null: none yet): the input typed for it is let go when it shows another in place. */
interface DayShown {
  target: string | null;
  progress: string | null;
}

/** What each visit's detail of a task shows, between its mounts (page memory, as the visit is). */
const shownDays = new WeakMap<TaskVisit, Map<string, DayShown>>();

function shownBy(visit: TaskVisit, taskId: string): DayShown {
  let tasks = shownDays.get(visit);
  if (tasks === undefined) {
    tasks = new Map();
    shownDays.set(visit, tasks);
  }
  let shown = tasks.get(taskId);
  if (shown === undefined) {
    shown = { target: null, progress: null };
    tasks.set(taskId, shown);
  }
  return shown;
}

/**
 * The visit shows `target`. The day shown before is let go as a departure lets go of it (its amount, fix and correction are dropped once
 * nothing holds them), unless the visit parked it ("Show this task's days": it stays the visit's until the visit ends); a parked day shown
 * again is the shown one again.
 */
function show(
  shown: DayShown,
  identity: string,
  target: string | null,
  progress: string | null,
): void {
  const before = shown.target;
  if (before !== null && before !== target) {
    if (shown.progress !== null) {
      disownKept(keptKey(identity, `record:${shown.progress}`));
      forgetKeptFix(`${identity}\u0000${shown.progress}`);
    }
    disownCorrection(correctionKey(identity, before));
  }
  shown.target = target;
  shown.progress = progress;
}

export function useTaskDetail(
  taskId: string,
  occurrenceParam: string | undefined,
): TaskDetailView {
  const env = useTasksEnv();
  const data = useDataEnv();
  const position = useCachePosition();
  // No database on this device: nothing was ever saved or synced here (a read that failed is not that).
  const noDatabase =
    position.status === "unavailable" && position.reason === "absent";
  const composition =
    position.status === "ready" ? (position.value?.composition ?? -1) : -2;
  // A complete read belongs to one identity, database incarnation, task and address: another one keeps nothing of it.
  const scope = `${env.identity}\u0000${data.service()?.incarnationId ?? "-"}\u0000${taskId}\u0000${occurrenceParam ?? ""}`;
  const pinned = useRef<{ scope: string; id: string } | null>(null);
  // The visit's default day, kept with this screen through a visit to the sync screens (revision 19, DA19-I1; `kept-input.ts`). Coming
  // back, it is read before any default is chosen, and only while input typed for it is kept.
  const day = useKeptInput<string | null>(
    keptKey(env.identity, `detail-day:${taskId}`),
    env.identity,
    () => null,
    { consumed: () => null, unedited: true },
  );
  const dayRef = useRef(day);
  dayRef.current = day;
  const keeps = (occurrenceId: string, progressId: string) => {
    const amount = keptEntry(keptKey(env.identity, `record:${progressId}`));
    return (
      (amount !== null &&
        (amount.revision > 0 || amount.submitting !== null)) ||
      hasKeptFix(`${env.identity}\u0000${progressId}`) ||
      resumable(correctionKey(env.identity, occurrenceId)) !== null
    );
  };
  const [attempt, setAttempt] = useState(0);
  const read = useScopedRead<DetailInputs>(
    scope,
    `${composition}|${attempt}`,
    (signal) =>
      readCoherently(
        data,
        () =>
          readDetail(
            data,
            {
              taskId,
              occurrenceParam,
              pinned:
                pinned.current?.scope === scope ? pinned.current.id : null,
              // Only before this screen has chosen a day: coming back from the sync screens (its own pin governs after).
              returned: pinned.current === null ? day.value : null,
              keeps,
              me: env.accountId,
              now: env.now(),
            },
            signal,
          ),
        { signal },
      ),
    !noDatabase,
  );
  const inputs = read.complete?.value ?? null;
  // The visit's default day: the first one a complete read chose, kept while it is this task's.
  useEffect(() => {
    if (
      inputs !== null &&
      occurrenceParam === undefined &&
      inputs.chosen !== null
    ) {
      const chosen = inputs.chosen;
      pinned.current = { scope, id: chosen };
      if (dayRef.current.value !== chosen) dayRef.current.edit(() => chosen);
    }
  }, [inputs, occurrenceParam, scope]);
  // The visit owns the input typed for its day, shown or unavailable (revision 20, DA20-I1), and every day it parked or kept through the
  // sync screens (DA21-I2): owned by the screen's visit, not this mount (revision 22, `visit.ts`), so a remount at the same address goes on
  // with them and only the visit's end lets go of them. What it shows is the visit's too: a later mount lets go of the day a COMPLETE read
  // no longer shows, never of one merely not read yet.
  const visitOf = useTaskVisit();
  const visit = useRef<TaskVisit | null>(null);
  const alone = useRef<DayShown>({ target: null, progress: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the visit is asked for when the screen opens for an identity and task
  useEffect(() => {
    visit.current = visitOf(env.identity);
    alone.current = { target: null, progress: null };
  }, [env.identity, taskId]);
  const complete = inputs !== null;
  const target = inputs?.target ?? null;
  const targetProgress = inputs?.targetProgress ?? null;
  useEffect(() => {
    if (!complete) return;
    const mine = visit.current;
    show(
      mine === null || mine.identity !== env.identity
        ? alone.current
        : shownBy(mine, taskId),
      env.identity,
      target,
      targetProgress,
    );
  }, [complete, target, targetProgress, env.identity, taskId]);
  const readError: TaskDetailView["readError"] =
    read.latest === "failed" || read.latest === "unstable" ? read.latest : null;

  const queue = inputs?.queue ?? EMPTY;
  const executionId = inputs?.executionId ?? null;
  const relevant = relevantTo(queue, [taskId, executionId]);
  const task =
    inputs === null ? null : patched(inputs.taskBase, taskId, relevant);
  const execution =
    inputs === null || executionId === null
      ? null
      : patched(inputs.executionBase, executionId, relevant);
  const definition =
    execution === null ? null : parseDefinition(execution.value);
  const chosen = inputs?.chosen ?? null;
  const progressId = inputs?.progressId ?? null;

  // ---- the day picker's page: the first from the detail's read, a later one from a read of its own ---------------------------------------
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [paged, setPaged] = useState(false);
  const [pickerAttempt, setPickerAttempt] = useState(0);
  const cursor = cursors[cursors.length - 1] ?? null;
  const picker = useScopedRead(
    `${scope}\u0000${executionId}\u0000${cursor}`,
    `${composition}|${pickerAttempt}`,
    (signal) =>
      readCoherently(
        data,
        () =>
          readResourcePageNow(data, {
            kind: "occurrence",
            parentId: executionId ?? "-",
            after: cursor,
          }),
        { signal },
      ),
    !noDatabase && executionId !== null && cursors.length > 1,
  );
  const page =
    cursors.length === 1
      ? (inputs?.firstPage ?? null)
      : (picker.complete?.value ?? null);
  const create = inputs?.create ?? null;
  const occurrences = useMemo(() => {
    const out = new Map<string, OccurrenceData | null>();
    for (const row of page?.rows ?? [])
      out.set(row.base.id, parseOccurrenceData(row.merged.value));
    const projected = create?.target_resource_ids[2];
    if (
      cursors.length === 1 &&
      projected !== undefined &&
      !out.has(projected) &&
      create !== null
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
  }, [page, create, cursors.length]);

  // ---- the displayed day's row, from the same read ---------------------------------------------------------------------------------------
  const joint = chosen === null ? null : jointOf(env.identity, chosen);
  const rowSources =
    chosen === null || progressId === null || inputs === null
      ? null
      : {
          occurrenceId: chosen,
          progressId,
          occurrence: inputs.rows.get(chosen) ?? null,
          task: inputs.taskBase,
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
  // The picker lists the page's days, and the selected day when it is on another page.
  const listed =
    chosen !== null && !occurrences.some((o) => o.id === chosen)
      ? [...occurrences, { id: chosen, data: inputs?.chosenData ?? null }]
      : occurrences;
  const pickerError =
    cursors.length > 1 &&
    (picker.latest === "failed" || picker.latest === "unstable")
      ? picker.latest
      : null;
  return {
    status: noDatabase
      ? "absent"
      : inputs === null
        ? readError === null
          ? "loading"
          : "error"
        : task === null
          ? "absent"
          : "ready",
    task,
    execution,
    definition,
    occurrences: listed,
    days: {
      paged: cursors.length > 1 || paged,
      more: page?.next !== null && page?.next !== undefined,
      previous: cursors.length > 1,
      error: pickerError,
      showMore: () => {
        const next = page?.next;
        if (!next) return;
        setPaged(true);
        setCursors((c) => [...c, next]);
      },
      showPrevious: () =>
        setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
      retry: () => setPickerAttempt((n) => n + 1),
    },
    selection: inputs === null ? "loading" : inputs.selection,
    lost: inputs?.lost ?? false,
    chooseAgain: () => {
      // The input stays with its own day (DA20-I1): the visit keeps owning that day, parked, until it ends (DA21-I2).
      const mine = visit.current;
      if (mine !== null && mine.identity === env.identity)
        shownBy(mine, taskId).target = null;
      alone.current.target = null;
      pinned.current = null;
      day.edit(() => null);
      setAttempt((n) => n + 1);
    },
    row,
    unreadable,
    readError,
    current: !read.reading && readError === null,
    retry: () => setAttempt((n) => n + 1),
    synced: inputs?.taskBase !== null && inputs?.taskBase !== undefined,
    outstanding: inputs?.detail ?? EMPTY,
    joint,
    progressRows: inputs?.others ?? [],
    now: clock.now,
  };
}

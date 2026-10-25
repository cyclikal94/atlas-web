import type { CacheRow, DraftRow, DraftWithCommand } from "../../../data";
import { commandOf } from "./commands";
import { LIST_CAPACITY, parseListValue, projectCreateList } from "./lists";

/**
 * One list as a screen shows it, composed PURELY from what this device holds (D-10b-4): the cached row (with its effects' overlays) or the
 * projection of this device's outstanding `create_list`, then, in queue order (`created_seq`), every outstanding draft naming the list:
 * - `edit_list` and `archive` through their display patches (`label`, `archived`), as `patched()` does for a task;
 * - `list_item` applied to the membership as a set operation (`included: true` adds, `false` removes), when it is `queued`, `in_flight`
 *   or `acknowledged` while its effect stands. Re-applying an acknowledged change a committed page already carries changes nothing.
 *   A `blocked` one (the server refused it for capacity, `503 slice_capacity`) is NOT applied: it is `refused`, and waits for the person in
 *   Sync. Conflicted and rejected drafts are attention headers, never applied.
 *
 * This is the single rule for the pane's counts, the detail's rows, the capacity pre-check and the picker's exclusions (plan §3.2, §4.3).
 */
export type PendingMark = "queued" | "sending" | "waiting";

export interface ComposedList {
  row: CacheRow;
  /** Known only through this device's outstanding `create_list` (not in the cache yet). */
  projected: boolean;
  /** The task ids shown, or null when the cached value does not parse (nothing about the membership is then shown). */
  members: string[] | null;
  /** Per task id: the mark of the latest applied change touching it. */
  marks: Map<string, PendingMark>;
  /** `list_item` drafts of this list the server refused for capacity (`blocked`), oldest first. */
  refused: DraftWithCommand[];
  /** Conflicted or rejected drafts naming this list. */
  attention: number;
  /** Any outstanding work on the list, or null. */
  pending: PendingMark | null;
  /** The list's outstanding `create_list`, or null. */
  create: DraftWithCommand | null;
}

const APPLIED: readonly DraftRow["status"][] = [
  "queued",
  "in_flight",
  "acknowledged",
];

const markFor = (status: DraftRow["status"]): PendingMark =>
  status === "in_flight"
    ? "sending"
    : status === "acknowledged"
      ? "waiting"
      : "queued";

/** The mark of a set of outstanding drafts (WEB-10a's vocabulary): not sent yet, sending, or waiting for the server. */
function markOf(drafts: readonly DraftRow[]): PendingMark | null {
  if (drafts.length === 0) return null;
  if (drafts.some((d) => d.status === "queued" || d.status === "blocked"))
    return "queued";
  if (drafts.some((d) => d.status === "in_flight")) return "sending";
  return "waiting";
}

/** A `list_item` draft's change of `listId`, or null when the draft is not one. */
export function listItemOf(
  draft: Pick<DraftWithCommand, "command" | "kind">,
  listId: string,
): { taskId: string; included: boolean } | null {
  if (draft.kind !== "list_item") return null;
  const command = commandOf(draft);
  if (
    command === null ||
    command.list_id !== listId ||
    typeof command.task_id !== "string" ||
    typeof command.included !== "boolean"
  )
    return null;
  return { taskId: command.task_id, included: command.included };
}

export function composeList(
  listId: string,
  cached: CacheRow | null,
  outstanding: {
    drafts: readonly DraftWithCommand[];
    attention: readonly DraftRow[];
  },
): ComposedList | null {
  const naming = outstanding.drafts
    .filter((d) => d.index_targets.includes(listId))
    .sort((a, b) => a.created_seq - b.created_seq);
  const create =
    naming.find(
      (d) => d.kind === "create_list" && d.target_resource_ids[0] === listId,
    ) ?? null;
  let row =
    cached ?? (create === null ? null : projectCreateList(create, listId));
  if (row === null) return null;
  const parsed = parseListValue(row.value);
  const members = parsed === null ? null : new Set(parsed.task_ids);
  const marks = new Map<string, PendingMark>();
  const refused: DraftWithCommand[] = [];
  for (const draft of naming) {
    const patch = draft.display_patch?.[listId];
    if (patch !== undefined)
      row = {
        ...row,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      };
    const item = listItemOf(draft, listId);
    if (item === null) continue;
    if (draft.status === "blocked") {
      refused.push(draft);
      continue;
    }
    if (!APPLIED.includes(draft.status)) continue;
    marks.set(item.taskId, markFor(draft.status));
    if (members === null) continue;
    if (item.included) members.add(item.taskId);
    else members.delete(item.taskId);
  }
  return {
    row,
    projected: cached === null,
    members: members === null ? null : [...members],
    marks,
    refused,
    attention: outstanding.attention.filter((d) =>
      d.index_targets.includes(listId),
    ).length,
    pending: markOf(naming),
    create,
  };
}

export type ListRow =
  | {
      kind: "task";
      id: string;
      title: string;
      archived: boolean;
      projected: boolean;
      mark: PendingMark | null;
    }
  | { kind: "withheld"; id: string; mark: PendingMark | null };

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The detail's rows (D-10b-5/6): every member this device can name, by title (then id), then the WITHHELD members last by id: a task id
 * the list names for which this device holds neither a cached row nor an outstanding create (not synced yet, removed, or an access change
 * half-applied). A withheld row reveals nothing but that it is there.
 */
export function listRows(
  composed: ComposedList,
  tasks: ReadonlyMap<string, CacheRow>,
  projected: ReadonlySet<string> = new Set(),
): ListRow[] {
  const known: Extract<ListRow, { kind: "task" }>[] = [];
  const withheld: Extract<ListRow, { kind: "withheld" }>[] = [];
  for (const id of composed.members ?? []) {
    const task = tasks.get(id);
    const mark = composed.marks.get(id) ?? null;
    if (task === undefined) withheld.push({ kind: "withheld", id, mark });
    else
      known.push({
        kind: "task",
        id,
        title: task.label,
        archived: task.archived,
        projected: projected.has(id),
        mark,
      });
  }
  known.sort((a, b) => collator.compare(a.title, b.title) || byId(a, b));
  withheld.sort(byId);
  return [...known, ...withheld];
}

/** The composed membership is at the server's cap (the server also counts tasks the reader cannot see: a pre-check, never a promise). */
export const atCapacity = (c: ComposedList): boolean =>
  (c.members?.length ?? 0) >= LIST_CAPACITY;
/** How many more tasks the composed membership has room for (none when it cannot be read). */
export const roomFor = (c: ComposedList): number =>
  Math.max(0, LIST_CAPACITY - (c.members?.length ?? LIST_CAPACITY));

import { useState } from "react";
import {
  type CacheRow,
  type DataEnv,
  type DraftRow,
  type DraftWithCommand,
  readAllOutstandingByKindNow,
  readAllOutstandingNow,
  readCoherently,
  readResourcePageNow,
  readResourcesNow,
  type Stage,
  useCachePosition,
  useDataEnv,
} from "../../../data";
import { useTasksEnv } from "../env";
import { useScopedRead } from "../local-read";
import { type ComposedList, composeList } from "../model/list-view";
import { LIST_KINDS } from "../model/lists";
import { projectCreateTask } from "../register";
import { patched } from "../view";

/**
 * The Lists screens' reads (plan §3.3). Each is ONE certified composition of this device's data (`readCoherently`, WEB-10a revision 3):
 * every stage is read between two reads of the local basis, so nothing shown mixes two commits, and it is read again when the local
 * composition generation moves or on Try again. A read that failed or kept changing is never shown as empty or absent: with an earlier
 * complete read of the same scope that one is kept (stale), without one the screen says it could not read (D-10b-13: no online reads).
 */
type Outstanding = { drafts: DraftWithCommand[]; attention: DraftRow[] };

/** The state of a certified read, as every list screen shows it. */
export interface ReadState<T> {
  /** The last complete read of this scope, or null. */
  value: T | null;
  /** The last read failed or kept changing (with `value`, what is shown is stale; without, nothing is known). */
  error: "failed" | "unstable" | null;
  /** No database on this device: nothing was ever saved or synced here (a failed read is not that). */
  noDatabase: boolean;
  /** A read of this scope is in progress or due (what is shown may be about to change). */
  reading: boolean;
  retry(): void;
}

function useCertified<T>(
  scopeParts: readonly unknown[],
  run: (
    data: Pick<DataEnv, "service">,
    signal: AbortSignal,
  ) => Promise<Stage<T>>,
): ReadState<T> {
  const env = useTasksEnv();
  const data = useDataEnv();
  const position = useCachePosition();
  const noDatabase =
    position.status === "unavailable" && position.reason === "absent";
  const composition =
    position.status === "ready" ? (position.value?.composition ?? -1) : -2;
  const [attempt, setAttempt] = useState(0);
  // A complete read belongs to one identity, database incarnation and address: another one keeps nothing of it.
  const scope = [
    env.identity,
    data.service()?.incarnationId ?? "-",
    ...scopeParts,
  ].join("\u0000");
  const read = useScopedRead<T>(
    scope,
    `${composition}|${attempt}`,
    (signal) => readCoherently(data, () => run(data, signal), { signal }),
    !noDatabase,
  );
  return {
    value: read.complete?.value ?? null,
    error:
      read.latest === "failed" || read.latest === "unstable"
        ? read.latest
        : null,
    noDatabase,
    reading: read.reading,
    retry: () => setAttempt((n) => n + 1),
  };
}

const unread = (
  data: Pick<DataEnv, "service">,
  service: ReturnType<DataEnv["service"]>,
  signal: AbortSignal,
): Stage<never> => ({
  ok: false,
  why: signal.aborted
    ? "aborted"
    : data.service() === service && service !== null
      ? "failed"
      : "closed",
});

// ---- the pane -------------------------------------------------------------------------------------------------------------------
export interface PaneView {
  /** Outstanding creates (first page only), then the page's cached lists by name; only those of the filter asked for. */
  lists: ComposedList[];
  next: string | null;
  /** Changes to lists that need the person in Sync: conflicts, rejections and capacity refusals. */
  attention: number;
  /** The page held any list (of either filter), or this device has a list not received yet: "No lists yet" is not true then. */
  any: boolean;
}

const byName = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const orderByName = (a: ComposedList, b: ComposedList) =>
  byName.compare(a.row.label, b.row.label) ||
  (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);

/** A list's outstanding create, by list id. */
const createdLists = (queue: Outstanding) =>
  queue.drafts.filter(
    (d) => d.kind === "create_list" && d.target_resource_ids[0] !== undefined,
  );

/**
 * A page (100) of this device's lists, by id (D-10b-5: the cache has no name index), shown by name; on the first page, the lists this
 * device created and has not received yet come first. The queue of every list kind is read whole in the same composition.
 */
export function useListsPane(options: {
  archived: boolean;
  after: string | null;
}): ReadState<PaneView> {
  return useCertified(
    ["lists-pane", options.archived, options.after ?? ""],
    async (data, signal) => {
      const service = data.service();
      const page = await readResourcePageNow(data, {
        kind: "list",
        after: options.after,
        limit: 100,
      });
      if (!page.ok) return page;
      const queue = await readAllOutstandingByKindNow(data, LIST_KINDS);
      if (!queue.ok) return queue;
      const creates = createdLists(queue.value);
      let cachedCreates = new Map<string, unknown>();
      if (options.after === null && creates.length > 0) {
        const read = await readResourcesNow(
          data,
          creates.map((d) => d.target_resource_ids[0] as string),
        );
        if (read === null) return unread(data, service, signal);
        cachedCreates = read;
      }
      const lists: ComposedList[] = [];
      const known = new Set<string>();
      for (const row of page.value.rows) {
        known.add(row.base.id);
        const composed = composeList(row.base.id, row.merged, queue.value);
        if (composed !== null) lists.push(composed);
      }
      lists.sort(orderByName);
      const projected: ComposedList[] = [];
      if (options.after === null)
        for (const create of creates) {
          const id = create.target_resource_ids[0] as string;
          if (cachedCreates.has(id) || known.has(id)) continue;
          const composed = composeList(id, null, queue.value);
          if (composed !== null) projected.push(composed);
        }
      projected.sort(
        (a, b) => (a.create?.created_seq ?? 0) - (b.create?.created_seq ?? 0),
      );
      const lists_ = [...projected, ...lists];
      const listIds = new Set(lists_.map((c) => c.row.id));
      const attention =
        queue.value.attention.filter(
          (d) =>
            d.kind !== "archive" ||
            d.index_targets.some((id) => listIds.has(id)),
        ).length +
        queue.value.drafts.filter(
          (d) => d.kind === "list_item" && d.status === "blocked",
        ).length;
      return {
        ok: true,
        value: {
          lists: lists_.filter((c) => c.row.archived === options.archived),
          next: page.value.next,
          attention,
          any: lists_.length > 0,
        },
      };
    },
  );
}

// ---- the detail -------------------------------------------------------------------------------------------------------------------
export interface DetailView {
  /** Null: neither cached nor created on this device (a complete read says so). */
  list: ComposedList | null;
  /** The members (and refused tasks) this device can name: cached, with queued patches, or projected from an outstanding create. */
  tasks: Map<string, CacheRow>;
  /** Of those, the ones known only through this device's outstanding `create_task`, with that create's local id. */
  projected: Map<string, string>;
}

/** The task ids a list's composition names: its members and the tasks of its refused changes. */
function namedTasks(list: ComposedList): string[] {
  const ids = new Set(list.members ?? []);
  for (const draft of list.refused) {
    const id = (draft.command as { command?: { task_id?: unknown } }).command
      ?.task_id;
    if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

/**
 * One list and the tasks it names, as one certified read: the list (cached, or projected from this device's create), the outstanding work
 * naming it, then the named tasks by id (100 per transaction) and the outstanding work naming THEM (their queued renames and archives,
 * and the creates of tasks this device has not sent).
 */
export function useListDetail(listId: string): ReadState<DetailView> {
  return useCertified<DetailView>(
    ["list-detail", listId],
    async (data, signal) => {
      const service = data.service();
      const cached = await readResourcesNow(data, [listId]);
      if (cached === null) return unread(data, service, signal);
      const named = await readAllOutstandingNow(data, [listId]);
      if (!named.ok) return named;
      const list = composeList(
        listId,
        cached.get(listId)?.merged ?? null,
        named.value[listId] ?? { drafts: [], attention: [] },
      );
      const tasks = new Map<string, CacheRow>();
      const projected = new Map<string, string>();
      if (list === null) return { ok: true, value: { list, tasks, projected } };
      const ids = namedTasks(list);
      const rows = await readResourcesNow(data, ids);
      if (rows === null) return unread(data, service, signal);
      const work = await readAllOutstandingNow(data, ids);
      if (!work.ok) return work;
      for (const id of ids) {
        const drafts = [...(work.value[id]?.drafts ?? [])].sort(
          (a, b) => a.created_seq - b.created_seq,
        );
        const row = patched(rows.get(id)?.merged ?? null, id, drafts);
        if (row === null || row.kind !== "task") continue;
        tasks.set(id, row);
        if (!rows.has(id)) {
          const create = drafts.find(
            (d) =>
              d.kind === "create_task" &&
              d.target_resource_ids[0] === id &&
              projectCreateTask(d, id) !== null,
          );
          if (create !== undefined) projected.set(id, create.local_id);
        }
      }
      return { ok: true, value: { list, tasks, projected } };
    },
  );
}

// ---- the task picker ---------------------------------------------------------------------------------------------------------------
export interface PickerItem {
  id: string;
  title: string;
  /** Known only through this device's outstanding `create_task` (with its local id: an add depends on it, D-10b-11). */
  createLocalId: string | null;
}

export interface PickerPage {
  items: PickerItem[];
  /** Where "More tasks" continues (the last task id walked), or null at the end. */
  next: string | null;
}

/** Case- and accent-insensitive (D-10b-12): NFD with combining marks removed, then lower case. */
export const searchKey = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export const PICKER_PAGE = 100;
const PICKER_KINDS = ["create_task", "revise_task", "archive"] as const;

/**
 * A page of the tasks this device can offer for a list (D-10b-12): its cached tasks that are not archived and not `excluded` (already
 * members), matching `query`, walked 100 at a time in id order until a page of matches or the end; on the first page, the tasks this device
 * created and has not sent (projected). Titles and archived flags include this device's queued changes. Only tasks the person can already
 * see are here: the picker is never a way to find others.
 */
export function usePickerPage(options: {
  listId: string;
  query: string;
  after: string | null;
  excluded: ReadonlySet<string>;
}): ReadState<PickerPage> {
  const key = searchKey(options.query.trim());
  const excludedKey = [...options.excluded].sort().join(",");
  return useCertified(
    ["list-picker", options.listId, key, options.after ?? "", excludedKey],
    async (data, signal) => {
      const service = data.service();
      const queue = await readAllOutstandingByKindNow(data, PICKER_KINDS);
      if (!queue.ok) return queue;
      const naming = (id: string) =>
        queue.value.drafts
          .filter((d) => d.index_targets.includes(id))
          .sort((a, b) => a.created_seq - b.created_seq);
      const offered = (row: CacheRow | null): row is CacheRow =>
        row !== null &&
        row.kind === "task" &&
        !row.archived &&
        !options.excluded.has(row.id) &&
        searchKey(row.label).includes(key);
      const items: PickerItem[] = [];
      if (options.after === null) {
        const creates = queue.value.drafts.filter(
          (d) => d.kind === "create_task" && d.target_resource_ids[0],
        );
        const ids = creates.map((d) => d.target_resource_ids[0] as string);
        const cached = await readResourcesNow(data, ids);
        if (cached === null) return unread(data, service, signal);
        for (const create of creates) {
          const id = create.target_resource_ids[0] as string;
          if (cached.has(id)) continue;
          const row = patched(null, id, naming(id));
          if (offered(row))
            items.push({
              id,
              title: row.label,
              createLocalId: create.local_id,
            });
        }
      }
      // Exactly a page of cached matches: the walk stops AT the next match, and "More tasks" resumes after the row before it.
      let after = options.after;
      let next: string | null = null;
      let found = 0;
      walk: for (;;) {
        if (signal.aborted) return unread(data, service, signal);
        const page = await readResourcePageNow(data, {
          kind: "task",
          after,
          limit: PICKER_PAGE,
        });
        if (!page.ok) return page;
        for (const listed of page.value.rows) {
          const row = patched(
            listed.merged,
            listed.base.id,
            naming(listed.base.id),
          );
          if (offered(row)) {
            if (found === PICKER_PAGE) {
              next = after;
              break walk;
            }
            found += 1;
            items.push({ id: row.id, title: row.label, createLocalId: null });
          }
          after = listed.base.id;
        }
        if (page.value.next === null) break;
        after = page.value.next;
        // A long walk never holds the page: a macrotask between windows.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      return { ok: true, value: { items, next } };
    },
  );
}

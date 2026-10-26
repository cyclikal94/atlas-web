import type { CacheRow } from "../../../src/data";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { cacheRow } from "../data/rows";

/** WEB-10b's list rows and tasks as synced rows, for the Lists screens' component tests (FIXTURE evidence). */
let seq = 0;
export const listId = (n?: number) => {
  seq += 1;
  return `cccccccc-0000-4000-8000-${String(n ?? 500 + seq).padStart(12, "0")}`;
};
export const taskId = (n: number) =>
  `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function listRow(
  id: string,
  name: string,
  taskIds: readonly string[],
  over: Partial<CacheRow> = {},
): CacheRow {
  return cacheRow({
    id,
    kind: "list",
    parent_id: null,
    label: name,
    value: { task_ids: [...taskIds] },
    version: 2,
    policy_version: 1,
    can_edit: true,
    archived: false,
    ...over,
  });
}

export function taskRow(
  id: string,
  title: string,
  over: Partial<CacheRow> = {},
): CacheRow {
  return cacheRow({
    id,
    kind: "task",
    label: title,
    version: 1,
    policy_version: 1,
    ...over,
  });
}

/** Page memory between tests: kept input, visits and the tasks slice's memos. */
export function forgetLists(): void {
  forgetKept();
  forgetTaskMemory();
}

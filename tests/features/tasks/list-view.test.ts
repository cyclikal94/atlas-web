// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { CacheRow, DraftRow, DraftWithCommand } from "../../../src/data";
import { archiveResource } from "../../../src/features/tasks/model/commands";
import {
  atCapacity,
  composeList,
  listRows,
  roomFor,
} from "../../../src/features/tasks/model/list-view";
import {
  createList,
  editList,
  listItem,
} from "../../../src/features/tasks/model/lists";
import { cacheRow, draftRow } from "../../support/data/rows";

/**
 * WEB-10b L3 (D-10b-4/5/6, plan §3.2): the one composition every list screen uses. Membership starts from the cached value and every
 * outstanding `list_item` of the list is applied IN QUEUE ORDER as a set operation when queued, in flight or acknowledged (its effect
 * standing); a capacity-refused (`blocked`) one is not applied but listed; conflicts and rejections are attention only.
 */
const LIST = "52000000-0000-4000-8000-000000000001";
const OTHER_LIST = "52000000-0000-4000-8000-000000000009";
const t = (n: number) =>
  `53000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cached = (ids: string[], over: Partial<CacheRow> = {}) =>
  cacheRow({
    id: LIST,
    kind: "list",
    label: "Weekend",
    version: 3,
    policy_version: 1,
    value: { task_ids: ids },
    ...over,
  });

let seq = 0;
function item(
  taskId: string,
  included: boolean,
  status: DraftRow["status"] = "queued",
  list = LIST,
  createdSeq?: number,
): DraftWithCommand {
  seq += 1;
  return draftRow({
    kind: "list_item",
    status,
    created_seq: createdSeq ?? seq,
    command: listItem({ listId: list, taskId, included }).build({ [list]: 1 })
      .command as DraftWithCommand["command"],
    target_resource_ids: [list],
    index_targets: [list],
    ...(status === "blocked" ? { blocked_reason: "slice_capacity" } : {}),
  });
}
const patchDraft = (
  request: ReturnType<typeof editList>,
  kind: string,
  status: DraftRow["status"] = "queued",
): DraftWithCommand => {
  seq += 1;
  const built = request.build({ [LIST]: 3 });
  return draftRow({
    kind,
    status,
    created_seq: seq,
    command: built.command as DraftWithCommand["command"],
    display_patch: built.displayPatch ?? null,
    target_resource_ids: [LIST],
    index_targets: [LIST],
  });
};
const out = (drafts: DraftWithCommand[], attention: DraftRow[] = []) => ({
  drafts,
  attention,
});

describe("L3: membership", () => {
  test("cached ids with no work", () => {
    const c = composeList(LIST, cached([t(1), t(2)]), out([]));
    expect(c?.members).toEqual([t(1), t(2)]);
    expect(c?.pending).toBeNull();
    expect(c?.projected).toBe(false);
  });

  test.each([
    ["queued", "queued"],
    ["in_flight", "sending"],
    ["acknowledged", "waiting"],
  ] as const)("a %s add is applied, marked %s", (status, mark) => {
    const c = composeList(
      LIST,
      cached([t(1)]),
      out([item(t(2), true, status)]),
    );
    expect(c?.members).toEqual([t(1), t(2)]);
    expect(c?.marks.get(t(2))).toBe(mark);
    expect(c?.pending).toBe(mark);
  });

  test("a blocked (capacity) add is NOT applied: it is refused, and the list is pending", () => {
    const blocked = item(t(2), true, "blocked");
    const c = composeList(LIST, cached([t(1)]), out([blocked]));
    expect(c?.members).toEqual([t(1)]);
    expect(c?.refused).toEqual([blocked]);
    expect(c?.marks.has(t(2))).toBe(false);
    expect(c?.pending).toBe("queued");
  });

  test("attention drafts are counted, never applied", () => {
    const conflicted = item(t(2), true, "version_conflict");
    const c = composeList(
      LIST,
      cached([t(1)]),
      out([], [conflicted, item(t(3), true, "rejected")]),
    );
    expect(c?.members).toEqual([t(1)]);
    expect(c?.attention).toBe(2);
    // A conflict passed among the drafts (it never is) would still not be applied.
    expect(
      composeList(LIST, cached([t(1)]), out([conflicted]))?.members,
    ).toEqual([t(1)]);
  });

  test("queue order decides: add then remove leaves it out; remove then add leaves it in, whatever order the reads returned", () => {
    const add = item(t(2), true, "queued", LIST, 10);
    const remove = item(t(2), false, "queued", LIST, 11);
    expect(composeList(LIST, cached([]), out([remove, add]))?.members).toEqual(
      [],
    );
    const remove2 = item(t(3), false, "in_flight", LIST, 20);
    const add2 = item(t(3), true, "queued", LIST, 21);
    expect(
      composeList(LIST, cached([t(3)]), out([add2, remove2]))?.members,
    ).toEqual([t(3)]);
  });

  test("idempotent: an acknowledged add whose page already arrived changes nothing; removing an absent task changes nothing", () => {
    const c = composeList(
      LIST,
      cached([t(1)]),
      out([item(t(1), true, "acknowledged"), item(t(9), false)]),
    );
    expect(c?.members).toEqual([t(1)]);
  });

  test("another list's drafts are ignored", () => {
    const c = composeList(
      LIST,
      cached([t(1)]),
      out([item(t(2), true, "queued", OTHER_LIST)]),
    );
    expect(c?.members).toEqual([t(1)]);
    expect(c?.pending).toBeNull();
  });

  test("an unparseable cached value shows no membership (null), the label and patches still apply", () => {
    const c = composeList(
      LIST,
      cached([], { value: { task_ids: "x" } as never }),
      out([
        item(t(2), true),
        patchDraft(
          editList({ listId: LIST, name: "New", policyVersion: 1 }),
          "edit_list",
        ),
      ]),
    );
    expect(c?.members).toBeNull();
    expect(c?.row.label).toBe("New");
    expect(c && atCapacity(c)).toBe(false);
    expect(c && roomFor(c)).toBe(0);
  });
});

describe("L3: the row", () => {
  test("a queued rename and archive patch the label and archived flag in queue order", () => {
    const c = composeList(
      LIST,
      cached([]),
      out([
        patchDraft(
          editList({ listId: LIST, name: "A", policyVersion: 1 }),
          "edit_list",
        ),
        patchDraft(
          archiveResource({ id: LIST, archived: true }) as never,
          "archive",
        ),
        patchDraft(
          editList({ listId: LIST, name: "B", policyVersion: 1 }),
          "edit_list",
        ),
      ]),
    );
    expect(c?.row.label).toBe("B");
    expect(c?.row.archived).toBe(true);
  });

  test("not cached: the outstanding create is projected, empty, with its own queued adds", () => {
    seq += 1;
    const create = draftRow({
      kind: "create_list",
      created_seq: seq,
      command: createList({
        listId: LIST,
        name: "Weekend",
        defaults: null,
      }).build({}).command as DraftWithCommand["command"],
      target_resource_ids: [LIST],
      index_targets: [LIST],
    });
    const c = composeList(LIST, null, out([create, item(t(4), true)]));
    expect(c?.projected).toBe(true);
    expect(c?.create).toBe(create);
    expect(c?.row).toMatchObject({
      id: LIST,
      label: "Weekend",
      version: 1,
      can_edit: true,
    });
    expect(c?.members).toEqual([t(4)]);
  });

  test("neither cached nor created here: nothing", () => {
    expect(composeList(LIST, null, out([item(t(1), true)]))).toBeNull();
  });
});

describe("L3: capacity counts pending adds, not refused ones", () => {
  const ids = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => t(from + i));
  test("99 cached + 1 queued add = 100: at capacity, no room", () => {
    const c = composeList(LIST, cached(ids(99)), out([item(t(500), true)]));
    expect(c && atCapacity(c)).toBe(true);
    expect(c && roomFor(c)).toBe(0);
  });
  test("99 cached + 1 refused add: room for 1", () => {
    const c = composeList(
      LIST,
      cached(ids(99)),
      out([item(t(500), true, "blocked")]),
    );
    expect(c && atCapacity(c)).toBe(false);
    expect(c && roomFor(c)).toBe(1);
  });
  test("100 cached − 1 queued remove = 99: room for 1", () => {
    const c = composeList(LIST, cached(ids(100)), out([item(t(1), false)]));
    expect(c && roomFor(c)).toBe(1);
  });
});

describe("L3: rows (D-10b-5/6)", () => {
  const task = (id: string, label: string, archived = false) =>
    cacheRow({ id, kind: "task", label, archived });
  test("readable rows by title (numeric, accent and case insensitive), then id; withheld last by id", () => {
    const c = composeList(
      LIST,
      cached([t(9), t(1), t(2), t(3), t(4), t(8)]),
      out([item(t(4), true)]),
    );
    if (c === null) throw new Error("setup");
    const tasks = new Map([
      [t(1), task(t(1), "Task 10")],
      [t(2), task(t(2), "task 9")],
      [t(3), task(t(3), "Éclair", true)],
      [t(4), task(t(4), "eclair")],
    ]);
    const rows = listRows(c, tasks, new Set([t(4)]));
    expect(rows.map((r) => r.id)).toEqual([t(3), t(4), t(2), t(1), t(8), t(9)]);
    expect(rows[0]).toEqual({
      kind: "task",
      id: t(3),
      title: "Éclair",
      archived: true,
      projected: false,
      mark: null,
    });
    expect(rows[1]).toMatchObject({ projected: true, mark: "queued" });
    expect(rows.slice(4)).toEqual([
      { kind: "withheld", id: t(8), mark: null },
      { kind: "withheld", id: t(9), mark: null },
    ]);
  });
});

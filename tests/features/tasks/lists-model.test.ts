// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DraftWithCommand, EnqueueRequest } from "../../../src/data";
import {
  archive,
  archiveResource,
  createTask,
} from "../../../src/features/tasks/model/commands";
import {
  createList,
  editList,
  LIST_CAPACITY,
  LIST_KINDS,
  LIST_NAME_MAX,
  listItem,
  listNameProblem,
  parseListValue,
  projectCreateList,
  renameQueuedCreate,
} from "../../../src/features/tasks/model/lists";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";
import { record as defaultsRecord } from "../../support/data/sharing";
import { validate, validateAs } from "../../support/tasks/contract-schema";
import { definition } from "../../support/tasks/world";

/**
 * WEB-10b L1/L2 (plan §3.1, §7.1): the list model is the SERVER's rules and the vendored contract's shapes. The name rule is `lib.rs`
 * 159-165 (Unicode White_Space blankness, code points, 300); a list value is `{"task_ids": [...]}` (`service.rs` 296-303); every built body
 * is a valid `TaskCommandInput` with exactly the schema's keys. The builders go through the PRODUCTION outbox over the double, so the bases,
 * seeds, review block, dependencies and in-place edit are the store's own.
 */
const LIST = "50000000-0000-4000-8000-000000000001";
const TASK = "50000000-0000-4000-8000-000000000002";
const TASK2 = "50000000-0000-4000-8000-000000000003";
const id = (n: number) =>
  `51000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("L1: the name rule is the server's", () => {
  test.each([
    ["", "blank"],
    [" ", "blank"],
    ["\t\n  ", "blank"],
    // U+0085 (NEXT LINE) is White_Space: Rust's trim removes it, so a name of only it is blank (String.prototype.trim agrees here).
    ["\u0085", "blank"],
    // U+FEFF is NOT White_Space: Rust keeps it, so it is a name (String.prototype.trim would call it blank).
    ["﻿", null],
    ["᠎", null],
    ["a", null],
    [" a ", null],
  ])("%j → %s", (name, problem) => {
    expect(listNameProblem(name)).toBe(problem);
  });

  test("length is counted in code points: 300 astral characters fit, 301 do not", () => {
    const astral = "😀";
    expect(astral.length).toBe(2);
    expect(listNameProblem(astral.repeat(LIST_NAME_MAX))).toBeNull();
    expect(listNameProblem(astral.repeat(LIST_NAME_MAX + 1))).toBe("too_long");
    expect(listNameProblem("a".repeat(300))).toBeNull();
    expect(listNameProblem("a".repeat(301))).toBe("too_long");
  });

  test("the constants are the server's", () => {
    expect(LIST_CAPACITY).toBe(100);
    expect(LIST_NAME_MAX).toBe(300);
    expect([...LIST_KINDS]).toEqual([
      "create_list",
      "edit_list",
      "list_item",
      "archive",
    ]);
  });
});

describe("L1: parseListValue accepts exactly a list value", () => {
  test("ids, in order", () => {
    expect(parseListValue({ task_ids: [TASK, TASK2] })).toEqual({
      task_ids: [TASK, TASK2],
    });
    expect(parseListValue({ task_ids: [] })).toEqual({ task_ids: [] });
  });
  test("100 ids are a list; 101 are not", () => {
    const ids = Array.from({ length: 101 }, (_, i) => id(i + 1));
    expect(parseListValue({ task_ids: ids.slice(0, 100) })).not.toBeNull();
    expect(parseListValue({ task_ids: ids })).toBeNull();
  });
  test.each([
    ["null", null],
    ["an array", [TASK]],
    ["no key", {}],
    ["an extra key", { task_ids: [], name: "x" }],
    ["a duplicate id", { task_ids: [TASK, TASK] }],
    ["a non-UUID", { task_ids: ["not-a-uuid"] }],
    [
      "an upper-case UUID",
      { task_ids: ["5ABCDEF0-0000-4000-8000-00000000000B"] },
    ],
    ["a number", { task_ids: [1] }],
    ["ids not an array", { task_ids: TASK }],
  ])("rejects %s", (_, value) => {
    expect(parseListValue(value)).toBeNull();
  });
});

describe("L2: every body is a valid TaskCommandInput with exactly the schema's keys", () => {
  const bodies: Array<[string, EnqueueRequest, Record<string, number>]> = [
    [
      "create_list (defaults fetched)",
      createList({ listId: LIST, name: "Weekend", defaults: defaultsRecord() }),
      {},
    ],
    [
      "create_list (defaults never fetched)",
      createList({ listId: LIST, name: "Weekend", defaults: null }),
      {},
    ],
    [
      "edit_list",
      editList({ listId: LIST, name: "Groceries", policyVersion: 4 }),
      { [LIST]: 3 },
    ],
    [
      "list_item add",
      listItem({ listId: LIST, taskId: TASK, included: true }),
      { [LIST]: 2 },
    ],
    [
      "list_item remove",
      listItem({ listId: LIST, taskId: TASK, included: false }),
      { [LIST]: 2 },
    ],
    [
      "archive of a list",
      archiveResource({ id: LIST, archived: true }),
      { [LIST]: 5 },
    ],
  ];
  test.each(bodies)("%s", (_, request, bases) => {
    const built = request.build(bases);
    expect(validateAs(built.command, "TaskCommandInput")).toEqual([]);
    // No optional field is ever sent as null.
    expect(JSON.stringify(built.command)).not.toContain("null");
  });

  test("the exact bodies", () => {
    expect(
      createList({ listId: LIST, name: "Weekend", defaults: null }).build({})
        .command,
    ).toEqual({ command: { kind: "create_list", id: LIST, name: "Weekend" } });
    const withDefaults = createList({
      listId: LIST,
      name: "Weekend",
      defaults: defaultsRecord(),
    }).build({});
    expect(Object.keys(withDefaults.command).sort()).toEqual([
      "command",
      "defaults_revision",
    ]);
    expect((withDefaults.command as { command: object }).command).toEqual({
      kind: "create_list",
      id: LIST,
      name: "Weekend",
    });
    expect(
      editList({ listId: LIST, name: "G", policyVersion: 4 }).build({
        [LIST]: 3,
      }),
    ).toEqual({
      command: {
        command: {
          kind: "edit_list",
          id: LIST,
          expected_version: 3,
          expected_policy_version: 4,
          name: "G",
        },
      },
      displayPatch: { [LIST]: { label: "G" } },
    });
    const item = listItem({ listId: LIST, taskId: TASK, included: true }).build(
      { [LIST]: 2 },
    );
    expect(item).toEqual({
      command: {
        command: {
          kind: "list_item",
          list_id: LIST,
          expected_version: 2,
          task_id: TASK,
          included: true,
        },
      },
    });
    // D-10b-4: membership is never a display patch.
    expect(item.displayPatch).toBeUndefined();
  });

  test("the validator itself refuses what the contract refuses (controls)", () => {
    const bad = [
      {
        command: {
          kind: "edit_list",
          id: LIST,
          expected_version: 1,
          name: "x",
        },
      },
      { command: { kind: "create_list", id: LIST, name: "" } },
      { command: { kind: "create_list", id: LIST, name: "x", extra: 1 } },
      {
        command: {
          kind: "list_item",
          list_id: LIST,
          expected_version: 0,
          task_id: TASK,
          included: true,
        },
      },
      {
        command: { kind: "create_list", id: LIST, name: "x" },
        defaults_revision: "nope",
      },
    ];
    for (const body of bad)
      expect(validateAs(body, "TaskCommandInput")).not.toEqual([]);
    expect(
      validate("😀".repeat(300), { type: "string", maxLength: 300 }),
    ).toEqual([]);
  });

  test("archive of a task delegates unchanged to the resource builder", () => {
    const a = archive({ taskId: TASK, archived: true });
    const b = archiveResource({ id: TASK, archived: true });
    expect(a.targets).toEqual(b.targets);
    expect(a.build({ [TASK]: 7 })).toEqual(b.build({ [TASK]: 7 }));
    expect(a.targets).toEqual([
      {
        resourceId: TASK,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ]);
  });
});

describe("L2: targets, bases and the defaults through the production outbox", () => {
  async function world() {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: TASK, kind: "task", version: 1, policy_version: 1 }),
    ]);
    w.start();
    await w.settle();
    w.online = false;
    return w;
  }
  const stored = (
    w: Awaited<ReturnType<typeof world>>,
    localId: string,
  ): DraftWithCommand => {
    const header = w.drafts().find((d) => d.local_id === localId);
    if (header === undefined) throw new Error("no draft");
    return { ...header, command: w.commandOf(localId) as never };
  };

  test("create_list seeds the new list at 1 and captures the `list` defaults; the next change follows it on version 1", async () => {
    const w = await world();
    const record = defaultsRecord();
    const created = await w.outbox.enqueue(
      createList({ listId: LIST, name: "Weekend", defaults: record }),
    );
    expect(created.kind).toBe("queued");
    const add = await w.outbox.enqueue(
      listItem({ listId: LIST, taskId: TASK, included: true }),
    );
    expect(add.kind).toBe("queued");
    const [c, a] = w.drafts();
    expect(c?.kind).toBe("create_list");
    expect(c?.review_block).toBeNull();
    expect(c?.defaults_revision).not.toBeNull();
    expect(
      (c?.defaults_context as { kinds?: Record<string, unknown> } | null)
        ?.kinds,
    ).toHaveProperty("list");
    expect(a?.kind).toBe("list_item");
    expect(a?.depends_on).toEqual([c?.local_id]);
    const body = w.commandOf(a?.local_id as string) as {
      command: { expected_version: number };
    };
    expect(body.command.expected_version).toBe(1);
  });

  test("defaults never fetched: the create is held for review of the `list` kind (D-10b-3)", async () => {
    const w = await world();
    await w.outbox.enqueue(
      createList({ listId: LIST, name: "Weekend", defaults: null }),
    );
    expect(w.drafts()[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["list"],
    });
  });

  test("two adds on a cached list chain their versions; an add of a task not sent yet depends on its create (D-10b-11)", async () => {
    const w = await world();
    w.put("cache", [
      cacheRow({
        id: LIST,
        kind: "list",
        version: 6,
        policy_version: 2,
        value: { task_ids: [] },
      }),
    ]);
    const task = await w.outbox.enqueue(
      createTask({
        taskId: TASK2,
        executionId: id(90),
        occurrenceId: null,
        progressId: null,
        title: "New",
        definition: definition({
          schedule: {
            start_date: "2999-01-01",
            time: null,
            timezone: "UTC",
            repeat: null,
          },
        }),
        sharing: "only_me",
        defaults: defaultsRecord(),
      }),
    );
    if (task.kind !== "queued") throw new Error("setup");
    const first = await w.outbox.enqueue(
      listItem({ listId: LIST, taskId: TASK, included: true }),
    );
    const second = await w.outbox.enqueue(
      listItem({
        listId: LIST,
        taskId: TASK2,
        included: true,
        after: task.localId,
      }),
    );
    if (first.kind !== "queued" || second.kind !== "queued")
      throw new Error("setup");
    const one = stored(w, first.localId);
    const two = stored(w, second.localId);
    expect(
      (one.command as { command: { expected_version: number } }).command
        .expected_version,
    ).toBe(6);
    expect(
      (two.command as { command: { expected_version: number } }).command
        .expected_version,
    ).toBe(7);
    expect(two.depends_on).toContain(first.localId);
    expect(two.depends_on).toContain(task.localId);
    // Only the list is a target: the task is not, so a list change never waits behind an unrelated task's conflict.
    expect(two.target_resource_ids).toEqual([LIST]);
    expect(one.depends_on).not.toContain(task.localId);
  });

  test("a list cached as read-only refuses a rename, an add and an archive in the writing transaction (`denied`)", async () => {
    const w = await world();
    w.put("cache", [
      cacheRow({
        id: LIST,
        kind: "list",
        version: 2,
        policy_version: 1,
        can_edit: false,
        value: { task_ids: [] },
      }),
    ]);
    for (const request of [
      editList({ listId: LIST, name: "x", policyVersion: 1 }),
      listItem({ listId: LIST, taskId: TASK, included: true }),
      archiveResource({ id: LIST, archived: true }),
    ])
      expect(await w.outbox.enqueue(request)).toEqual({
        kind: "refused",
        reason: "denied",
      });
    expect(w.drafts()).toEqual([]);
  });

  test("renameQueuedCreate edits only the name, keeping the captured defaults and the review block", async () => {
    const w = await world();
    const out = await w.outbox.enqueue(
      createList({ listId: LIST, name: "Weekend", defaults: null }),
    );
    if (out.kind !== "queued") throw new Error("setup");
    const before = stored(w, out.localId);
    const request = renameQueuedCreate(before, "Weekday");
    if (request === null) throw new Error("not a create");
    expect(await w.outbox.editQueued(out.localId, request)).toEqual({
      kind: "edited",
      localId: out.localId,
    });
    const after = stored(w, out.localId);
    expect(after.command).toEqual({
      command: { kind: "create_list", id: LIST, name: "Weekday" },
    });
    expect(after.review_block).toEqual(before.review_block);
    expect(after.defaults_context).toEqual(before.defaults_context);
    expect(after.defaults_revision).toEqual(before.defaults_revision);
  });

  test("renameQueuedCreate keeps a captured revision and refuses a draft edited since it was read (`draft_changed`)", async () => {
    const w = await world();
    const out = await w.outbox.enqueue(
      createList({ listId: LIST, name: "Weekend", defaults: defaultsRecord() }),
    );
    if (out.kind !== "queued") throw new Error("setup");
    const seen = stored(w, out.localId);
    const revision = (seen.command as { defaults_revision: string })
      .defaults_revision;
    const rename = renameQueuedCreate(seen, "A");
    if (rename === null) throw new Error("setup");
    expect((await w.outbox.editQueued(out.localId, rename)).kind).toBe(
      "edited",
    );
    const now = stored(w, out.localId);
    expect(now.command).toEqual({
      command: { kind: "create_list", id: LIST, name: "A" },
      defaults_revision: revision,
    });
    expect(now.defaults_revision).toBe(seen.defaults_revision);
    // The first view is stale now: a second rename from it changes nothing.
    const stale = renameQueuedCreate(seen, "B");
    if (stale === null) throw new Error("setup");
    expect(await w.outbox.editQueued(out.localId, stale)).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(stored(w, out.localId).command).toEqual(now.command);
  });

  test("renameQueuedCreate refuses a draft that is not a list create", () => {
    const request = listItem({ listId: LIST, taskId: TASK, included: true });
    const draft = {
      kind: "list_item",
      target_resource_ids: [LIST],
      command: request.build({ [LIST]: 1 }).command,
    } as unknown as DraftWithCommand;
    expect(renameQueuedCreate(draft, "x")).toBeNull();
  });
});

describe("the projection of an outstanding create_list", () => {
  const draft = (command: object) =>
    ({
      command: { command },
      target_resource_ids: [LIST],
    }) as unknown as DraftWithCommand;
  test("its own id only, empty, editable", () => {
    const d = draft({ kind: "create_list", id: LIST, name: "Weekend" });
    expect(projectCreateList(d, LIST)).toEqual({
      id: LIST,
      kind: "list",
      parent_id: null,
      label: "Weekend",
      value: { task_ids: [] },
      version: 1,
      can_edit: true,
      archived: false,
      kind_date: null,
    });
    expect(projectCreateList(d, TASK)).toBeNull();
    expect(
      projectCreateList(draft({ kind: "create_task", id: LIST }), LIST),
    ).toBeNull();
  });
});

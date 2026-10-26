// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  CacheRow,
  CurrentReadIo,
  DraftWithCommand,
  EnqueueRequest,
} from "../../../src/data";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import {
  archive,
  archiveResource,
} from "../../../src/features/tasks/model/commands";
import {
  createList,
  editList,
  listItem,
} from "../../../src/features/tasks/model/lists";
import {
  DESCRIPTIONS,
  parseListPage,
  registerTaskCommands,
  taskCommandSpecs,
} from "../../../src/features/tasks/register";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow, draftRow } from "../../support/data/rows";

/**
 * WEB-10b L4 (plan §3.4): the list kinds' registrations. The authorised current read of a list walks `GET /lists`, which filters by
 * `archived` and is paged by id (`server/src/tasks.rs` 116-141: `next_after` is the last id of a FULL page): both collections, the expected
 * one first; each cursor followed; absence only once both ended; a refusal, error or malformed page is that page's answer. An archive reads
 * the task first, exactly as before, and the list only on the task read's `404`. The endpoint double below answers exactly as the released
 * one does (ids in byte order after `after`, at most `limit`).
 */
const LIST = "54000000-0000-4000-8000-000000000050";
const TASK = "54000000-0000-4000-8000-000000000060";
const LIMIT = 200;
const specs = taskCommandSpecs();
const registry = createCommandRegistry();
registerTaskCommands(registry);

const projection = (id: string, archived: boolean, over: object = {}) => ({
  id,
  kind: "list",
  parent_id: null,
  label: "Weekend",
  value: { task_ids: [] },
  version: 4,
  can_edit: true,
  policy_version: 2,
  archived,
  ...over,
});
const others = (n: number, prefix = "4") =>
  Array.from(
    { length: n },
    (_, i) =>
      `${prefix}4000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
  );
function endpoint(ids: string[], archived: boolean, after: string | null) {
  const items = [...ids]
    .sort()
    .filter((id) => after === null || id > after)
    .slice(0, LIMIT);
  return {
    items: items.map((id) => projection(id, archived)),
    next_after: items.length === LIMIT ? (items.at(-1) as string) : null,
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const query = (path: string) => new URL(path, "http://localhost").searchParams;
const listPath = (archived: boolean, after: string | null) =>
  `/lists?archived=${archived}&limit=200${after === null ? "" : `&after=${after}`}`;

/** Serves both collections; any other path is a 404 (as `GET /tasks/{list id}` answers). */
const serving =
  (active: string[], archived: string[]) =>
  (path: string): Response => {
    if (!path.startsWith("/lists"))
      return json({ error: { code: "not_found" } }, 404);
    const q = query(path);
    const which = q.get("archived") === "true";
    return json(endpoint(which ? archived : active, which, q.get("after")));
  };

function draftOf(request: EnqueueRequest, kind: string): DraftWithCommand {
  return draftRow({
    kind,
    status: "version_conflict",
    command: request.build({ [LIST]: 4, [TASK]: 4 })
      .command as DraftWithCommand["command"],
    target_resource_ids: request.targets
      .filter((t) => t.role === "primary")
      .map((t) => t.resourceId),
  });
}
const DRAFTS = {
  edit_list: () =>
    draftOf(
      editList({ listId: LIST, name: "New", policyVersion: 1 }),
      "edit_list",
    ),
  list_item: () =>
    draftOf(
      listItem({ listId: LIST, taskId: TASK, included: true }),
      "list_item",
    ),
  archive_list: () =>
    draftOf(archiveResource({ id: LIST, archived: true }), "archive"),
  restore_list: () =>
    draftOf(archiveResource({ id: LIST, archived: false }), "archive"),
};

async function readWith(
  draft: DraftWithCommand,
  answer: (path: string, n: number) => Response | Promise<Response>,
  signal: AbortSignal = new AbortController().signal,
) {
  const asked: string[] = [];
  const io: CurrentReadIo = {
    signal,
    get: async (path) => {
      asked.push(path);
      if (asked.length > 12) throw new Error("the walk did not stop");
      return answer(path, asked.length);
    },
  };
  return { read: await registry.readCurrent(draft, io), asked };
}

describe("L4: descriptions, projections and admissions", () => {
  test("each list kind is described for the queue", () => {
    expect(DESCRIPTIONS.create_list).toBe("New list");
    expect(DESCRIPTIONS.edit_list).toBe("List name change");
    expect(DESCRIPTIONS.list_item).toBe("List change");
    for (const kind of ["create_list", "edit_list", "list_item"])
      expect(registry.describe(draftRow({ kind }))).toBe(DESCRIPTIONS[kind]);
  });

  test("a create is projected for its own id only and needs nothing", () => {
    const create = draftRow({
      kind: "create_list",
      command: createList({ listId: LIST, name: "W", defaults: null }).build({})
        .command as DraftWithCommand["command"],
      target_resource_ids: [LIST],
    });
    expect(registry.projectCreate(create, LIST)).toMatchObject({
      id: LIST,
      kind: "list",
      label: "W",
    });
    expect(registry.projectCreate(create, TASK)).toBeNull();
    expect(registry.admission(create)).toEqual({});
    expect(specs.create_list?.rebuild).toBeUndefined();
  });

  test("a rename, a membership change and an archive need edit access to the list", () => {
    expect(registry.admission(DRAFTS.edit_list())).toEqual({
      [LIST]: { requiresEdit: true },
    });
    expect(registry.admission(DRAFTS.list_item())).toEqual({
      [LIST]: { requiresEdit: true },
    });
    expect(registry.admission(DRAFTS.archive_list())).toEqual({
      [LIST]: { requiresEdit: true },
    });
  });
});

describe("L4: parseListPage is strict", () => {
  const ok = endpoint(others(3), false, null);
  test("a page of the collection", () => {
    expect(parseListPage(ok, false, null)?.items).toHaveLength(3);
  });
  test.each([
    ["another key", { ...ok, extra: 1 }],
    ["the other collection", endpoint(others(3), true, null)],
    [
      "another kind",
      {
        items: [{ ...projection(others(1)[0] as string, false), kind: "task" }],
        next_after: null,
      },
    ],
    [
      "a parent",
      {
        items: [
          { ...projection(others(1)[0] as string, false), parent_id: TASK },
        ],
        next_after: null,
      },
    ],
    ["ids out of order", { items: [...ok.items].reverse(), next_after: null }],
    ["a repeated id", { items: [ok.items[0], ok.items[0]], next_after: null }],
    [
      "a short page with a cursor",
      { items: ok.items, next_after: ok.items[2]?.id },
    ],
    [
      "a full page without one",
      { ...endpoint(others(200), false, null), next_after: null },
    ],
    [
      "a full page with a different cursor",
      { ...endpoint(others(200), false, null), next_after: others(1)[0] },
    ],
    [
      "more than 200 items",
      {
        items: others(201).map((id) => projection(id, false)),
        next_after: null,
      },
    ],
  ])("refuses %s", (_, page) => {
    expect(parseListPage(page, false, null)).toBeNull();
  });
  test("refuses an id not after the cursor", () => {
    expect(parseListPage(ok, false, ok.items[1]?.id ?? null)).toBeNull();
  });
});

describe("L4: readListCurrent walks both collections", () => {
  for (const name of ["edit_list", "list_item"] as const)
    test(`${name}: active first; found on the second page of the active collection`, async () => {
      const ids = [...others(200), LIST];
      const { read, asked } = await readWith(DRAFTS[name](), serving(ids, []));
      expect(read).toMatchObject({
        kind: "loaded",
        value: { id: LIST, kind: "list", version: 4 },
      });
      expect(asked).toEqual([
        listPath(false, null),
        listPath(false, others(200)[199] as string),
      ]);
    });

  test("archive (expects active): found in the ARCHIVED collection after the active one ended", async () => {
    // Expected state first: archiving expects the list active.
    const { read, asked } = await readWith(
      DRAFTS.archive_list(),
      serving(others(5), [LIST]),
    );
    expect(read).toMatchObject({
      kind: "loaded",
      value: { id: LIST, archived: true },
    });
    expect(asked).toEqual([
      `/tasks/${LIST}`,
      listPath(false, null),
      listPath(true, null),
    ]);
  });

  test("restore (expects archived): the archived collection is read first", async () => {
    const draft = draftOf(
      archiveResource({ id: LIST, archived: false }),
      "archive",
    );
    const { read, asked } = await readWith(draft, serving([], [LIST]));
    expect(read).toMatchObject({ kind: "loaded", value: { id: LIST } });
    // `restore_list` reaches the list read after the task 404; its first collection is the archived one.
    expect(asked).toEqual([`/tasks/${LIST}`, listPath(true, null)]);
  });

  test("absent only once BOTH collections ended: inaccessible", async () => {
    const { read, asked } = await readWith(
      DRAFTS.edit_list(),
      serving(others(3), others(2, "3")),
    );
    expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
    expect(asked).toEqual([listPath(false, null), listPath(true, null)]);
  });

  test("a page that holds a larger id ends that collection without asking for the next page", async () => {
    // Ids sort above LIST ("5..." > "54...05" holds for "6..." and up).
    const above = others(200, "7");
    const { read, asked } = await readWith(
      DRAFTS.edit_list(),
      serving(above, []),
    );
    expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
    expect(asked).toEqual([listPath(false, null), listPath(true, null)]);
  });

  test("exactly 200 below it, then an EMPTY page ends the collection", async () => {
    const { read, asked } = await readWith(
      DRAFTS.edit_list(),
      serving(others(200), []),
    );
    expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
    expect(asked).toEqual([
      listPath(false, null),
      listPath(false, others(200)[199] as string),
      listPath(true, null),
    ]);
  });

  test.each([
    [403, "inaccessible"],
    [404, "inaccessible"],
    [500, "error"],
  ] as const)(
    "a %s on a LATER page is that page's answer (%s), never absence of the rest",
    async (status, reason) => {
      const { read, asked } = await readWith(DRAFTS.edit_list(), (path, n) =>
        n === 1
          ? serving([...others(200), LIST], [])(path)
          : json({ error: { code: "x" } }, status),
      );
      expect(read).toEqual({ kind: "failed", reason });
      expect(asked).toHaveLength(2);
    },
  );

  test("a malformed page is indeterminate and nothing more is asked", async () => {
    const { read, asked } = await readWith(DRAFTS.edit_list(), () =>
      json({ items: [projection(LIST, true)], next_after: null }),
    );
    expect(read).toEqual({ kind: "indeterminate" });
    expect(asked).toHaveLength(1);
  });

  test("a page whose cursor goes back is indeterminate", async () => {
    const first = endpoint(others(200), false, null);
    const { read } = await readWith(DRAFTS.edit_list(), (_path, n) =>
      n === 1 ? json(first) : json({ ...endpoint(others(200), false, null) }),
    );
    expect(read).toEqual({ kind: "indeterminate" });
  });

  test("an ended scope sends nothing more and answers unavailable", async () => {
    const controller = new AbortController();
    const { read, asked } = await readWith(
      DRAFTS.edit_list(),
      (path) => {
        controller.abort();
        return serving(others(200), [])(path);
      },
      controller.signal,
    );
    expect(read).toEqual({ kind: "failed", reason: "unavailable" });
    expect(asked).toHaveLength(1);
  });
});

describe("L4: an archive reads the task first, the list only on its 404", () => {
  const taskDetail = {
    task: {
      id: TASK,
      kind: "task",
      parent_id: null,
      label: "T",
      value: null,
      version: 9,
      can_edit: true,
      policy_version: 1,
      archived: false,
    },
    execution: null,
    materialisation: null,
  };
  test("a task archive: one request, the task's answer exactly as before", async () => {
    const draft = draftOf(archive({ taskId: TASK, archived: true }), "archive");
    const { read, asked } = await readWith(draft, () => json(taskDetail));
    expect(read).toEqual({
      kind: "loaded",
      value: expect.objectContaining({ id: TASK, version: 9 }),
      related: [],
    });
    expect(asked).toEqual([`/tasks/${TASK}`]);
  });
  test.each([
    [403, "inaccessible"],
    [410, "inaccessible"],
    [500, "error"],
  ] as const)(
    "a task read's %s is its answer: no list walk",
    async (status, reason) => {
      const draft = draftOf(
        archive({ taskId: TASK, archived: true }),
        "archive",
      );
      const { read, asked } = await readWith(draft, () =>
        json({ error: { code: "x" } }, status),
      );
      expect(read).toEqual({ kind: "failed", reason });
      expect(asked).toHaveLength(1);
    },
  );
  test("a task no longer readable (404) is looked for among the lists too, and ends inaccessible", async () => {
    const draft = draftOf(archive({ taskId: TASK, archived: true }), "archive");
    const { read, asked } = await readWith(draft, serving([], []));
    expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
    expect(asked).toEqual([
      `/tasks/${TASK}`,
      listPath(false, null),
      listPath(true, null),
    ]);
  });
});

describe("L4: rebuilds on the reviewed list", () => {
  const reviewed = (over: Partial<CacheRow> = {}) =>
    cacheRow({
      id: LIST,
      kind: "list",
      version: 8,
      policy_version: 5,
      ...over,
    });
  const withoutBuild = (request: EnqueueRequest) =>
    request.targets.map(({ reviewedBase: _r, ...target }) => target);

  test("edit_list: same targets, the reviewed version and policy version", () => {
    const original = editList({ listId: LIST, name: "New", policyVersion: 1 });
    const rebuilt = specs.edit_list?.rebuild?.(
      DRAFTS.edit_list(),
      reviewed(),
    ) as EnqueueRequest;
    expect(withoutBuild(rebuilt)).toEqual(withoutBuild(original));
    expect(rebuilt.targets[0]?.reviewedBase).toBe(8);
    expect(
      (rebuilt.build({ [LIST]: 8 }).command as { command: object }).command,
    ).toEqual({
      kind: "edit_list",
      id: LIST,
      expected_version: 8,
      expected_policy_version: 5,
      name: "New",
    });
  });
  test.each([
    ["no policy version", { policy_version: undefined }],
    ["no edit access", { can_edit: false }],
    ["another resource", { id: TASK }],
    ["another kind", { kind: "task" as const }],
  ])("edit_list is not rebuilt on %s", (_, over) => {
    const current = reviewed();
    const changed = { ...current, ...over } as CacheRow;
    if ("policy_version" in over)
      delete (changed as { policy_version?: number }).policy_version;
    expect(specs.edit_list?.rebuild?.(DRAFTS.edit_list(), changed)).toBeNull();
  });
  test("edit_list is not rebuilt without a reviewed read", () => {
    expect(specs.edit_list?.rebuild?.(DRAFTS.edit_list(), null)).toBeNull();
  });

  test("list_item: the same task and direction on the reviewed version, no extra dependency", () => {
    const original = listItem({
      listId: LIST,
      taskId: TASK,
      included: true,
      after: "x",
    });
    const draft = draftOf(original, "list_item");
    const rebuilt = specs.list_item?.rebuild?.(
      draft,
      reviewed(),
    ) as EnqueueRequest;
    expect(rebuilt.dependsOnExtra).toBeUndefined();
    expect(rebuilt.targets).toEqual([
      { ...original.targets[0], reviewedBase: 8 },
    ]);
    expect(
      (rebuilt.build({ [LIST]: 8 }).command as { command: object }).command,
    ).toEqual({
      kind: "list_item",
      list_id: LIST,
      expected_version: 8,
      task_id: TASK,
      included: true,
    });
    expect(
      specs.list_item?.rebuild?.(draft, reviewed({ can_edit: false })),
    ).toBeNull();
    expect(specs.list_item?.rebuild?.(draft, null)).toBeNull();
  });

  test("archive of a list: rebuilt on the list; not on a denial or another resource", () => {
    const rebuilt = specs.archive?.rebuild?.(
      DRAFTS.archive_list(),
      reviewed(),
    ) as EnqueueRequest;
    expect(
      rebuilt,
      "a list's archive is rebuilt on the reviewed list",
    ).not.toBeNull();
    expect(withoutBuild(rebuilt)).toEqual(
      withoutBuild(archiveResource({ id: LIST, archived: true })),
    );
    expect(rebuilt.targets[0]?.reviewedBase).toBe(8);
    expect(
      specs.archive?.rebuild?.(
        DRAFTS.archive_list(),
        reviewed({ can_edit: false }),
      ),
    ).toBeNull();
    expect(
      specs.archive?.rebuild?.(
        DRAFTS.archive_list(),
        reviewed({ kind: "execution" }),
      ),
    ).toBeNull();
  });

  test("Save as new of a conflicted rename through the production outbox: sent on the reviewed version; the next change follows it", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({
        id: LIST,
        kind: "list",
        version: 3,
        policy_version: 1,
        value: { task_ids: [] },
      }),
    ]);
    w.start();
    await w.settle();
    w.script.push(w.error(409, "conflict"));
    const first = await w.outbox.enqueue(
      editList({ listId: LIST, name: "New", policyVersion: 1 }),
    );
    if (first.kind !== "queued") throw new Error("setup");
    await w.settle();
    const header = w.drafts().find((d) => d.local_id === first.localId);
    expect(header?.status).toBe("version_conflict");
    const stored = {
      ...header,
      command: w.commandOf(first.localId),
    } as DraftWithCommand;
    const rebuilt = specs.edit_list?.rebuild?.(
      stored,
      reviewed({ version: 6, policy_version: 2 }),
    ) as EnqueueRequest;
    expect((await w.outbox.supersede(first.localId, rebuilt)).kind).toBe(
      "superseded",
    );
    await w.outbox.enqueue(
      listItem({ listId: LIST, taskId: TASK, included: true }),
    );
    await w.settle();
    const sent = w.sent.map(
      (s) =>
        (JSON.parse(s.body) as { command: Record<string, unknown> }).command,
    );
    expect(sent.slice(1)).toEqual([
      {
        kind: "edit_list",
        id: LIST,
        expected_version: 6,
        expected_policy_version: 2,
        name: "New",
      },
      {
        kind: "list_item",
        list_id: LIST,
        expected_version: 7,
        task_id: TASK,
        included: true,
      },
    ]);
  });
});

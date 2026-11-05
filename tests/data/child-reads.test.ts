// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readMergedUnder } from "../../src/data/plans/merged-under";
import {
  type ChildPage,
  readChildPage,
  readFormCopiesUnder,
  readOutstandingCreates,
} from "../../src/data/plans/outstanding-reads";
import type { Loadable } from "../../src/data/store/port";
import { pageWorld } from "../support/data/page-world";
import {
  cacheRow,
  draftRow,
  effectRow,
  recoveryRow,
} from "../support/data/rows";
import { type PageSpec, uuid } from "../support/data/sync-pages";

/**
 * WEB-11a review 16 (R16.1; DA16-02, DA16-04, DA16-05, DA16-07): what a screen shows under a parent is read WITH the parent, in ONE
 * transaction. Through the PRODUCTION plans over the double of IndexedDB, and the PRODUCTION page commit for a removal that keeps the
 * children cached. Expected values are literal ids, labels and flags, never the answer of another plan. FIXTURE evidence: the double re-runs
 * a watch after any commit to its scope, so the live tests show what the plan answers after each commit, not which commits a real engine's
 * live query notices (the native E-P40 case does that).
 */
const PERSON = uuid(1);
const OTHER = uuid(2);
const field = (n: number, over: Parameters<typeof cacheRow>[0] = {}) =>
  cacheRow({
    id: uuid(100 + n),
    kind: "field",
    parent_id: PERSON,
    label: `field ${n}`,
    ...over,
  });
const KINDS = ["create_person", "put_field", "edit", "archive"];

type World = Awaited<ReturnType<typeof pageWorld>>;
const page = (
  w: World,
  over: Partial<{
    parentId: string;
    parentKind: "person" | "task";
    after: string | null;
    kinds: string[];
  }> = {},
  // `parentId: undefined` reads every row of the kind (the ledger).
  scoped = true,
): Promise<ChildPage> =>
  w.service.store.run(readChildPage, {
    incarnationId: w.service.incarnationId,
    kind: "field",
    parentKind: over.parentKind ?? "person",
    ...(scoped ? { parentId: over.parentId ?? PERSON } : {}),
    after: over.after ?? null,
    ...(over.kinds === undefined ? {} : { kinds: over.kinds }),
  });
const ids = (result: ChildPage) => result.page.rows.map((row) => row.base.id);
const removal = (
  revision: number,
  changes: PageSpec["batches"][number]["changes"],
): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: `cursor-${revision}`,
  batches: [{ revision, changes }],
});
const fieldProjection = (n: number, label = `field ${n}`) => ({
  id: uuid(100 + n),
  kind: "field",
  parent_id: PERSON,
  label,
  value: null,
  version: 2,
  can_edit: true,
  archived: false,
});
const named = (id: string, over: Parameters<typeof draftRow>[0] = {}) =>
  draftRow({
    command: { command: { kind: "put_field", id, parent_id: PERSON } },
    target_resource_ids: [id],
    index_targets: [id],
    ...over,
  });

describe("readChildPage: a page of children with their parents and the drafts over them, in one read", () => {
  test("a visible person: its fields with their overlay, the person with its overlay, and only the outstanding drafts naming a field", async () => {
    const w = await pageWorld();
    w.put("cache", [
      cacheRow({ id: PERSON, label: "Mo" }),
      field(1),
      field(2),
      cacheRow({ id: uuid(200), kind: "field", parent_id: OTHER }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: uuid(101),
        local_id: "L1",
        display: { archived: true },
      }),
      effectRow({
        resource_id: PERSON,
        local_id: "L2",
        display: { label: "Mo (renamed)" },
      }),
      effectRow({ resource_id: uuid(102), local_id: "ACK-STANDS" }),
    ]);
    w.put("drafts", [
      named(uuid(101), { local_id: "Q1", created_seq: 5 }),
      named(uuid(102), {
        local_id: "ACK-STANDS",
        status: "acknowledged",
        created_seq: 3,
      }),
      named(uuid(102), {
        local_id: "ACK-RELEASED",
        status: "acknowledged",
        created_seq: 4,
      }),
      named(uuid(102), {
        local_id: "CONFLICT",
        status: "version_conflict",
        created_seq: 6,
      }),
      named(uuid(200), { local_id: "ELSEWHERE", created_seq: 7 }),
      draftRow({
        local_id: "OTHER-KIND",
        kind: "create_task",
        target_resource_ids: [uuid(101)],
        index_targets: [uuid(101)],
        created_seq: 8,
      }),
    ]);
    const result = await page(w, { kinds: KINDS });
    expect(ids(result)).toEqual([uuid(101), uuid(102)]);
    expect(result.page.rows.map((row) => row.merged.archived)).toEqual([
      true,
      false,
    ]);
    expect(Object.keys(result.parents)).toEqual([PERSON]);
    expect(result.parents[PERSON]?.label).toBe("Mo (renamed)");
    expect(result.page.next).toBeNull();
    // Oldest first; a conflict, a released acknowledgement, another kind and another person's field are not outstanding over the page.
    expect(result.drafts?.map((d) => d.local_id)).toEqual(["ACK-STANDS", "Q1"]);
    expect(result.drafts?.[1]?.command).toEqual({
      command: { kind: "put_field", id: uuid(101), parent_id: PERSON },
    });
  });

  test("without `kinds` no drafts are read", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON }), field(1)]);
    w.put("drafts", [named(uuid(101))]);
    const result = await page(w);
    expect("drafts" in result).toBe(false);
  });

  test("a read-only and an archived person are visible (the cached-person rule: neither editability nor archival hides)", async () => {
    for (const over of [{ can_edit: false }, { archived: true }]) {
      const w = await pageWorld();
      w.put("cache", [cacheRow({ id: PERSON, ...over }), field(1)]);
      expect(ids(await page(w))).toEqual([uuid(101)]);
    }
  });

  test("a field whose person the cache does not hold is not answered, though the field is cached; no drafts of it are read", async () => {
    const w = await pageWorld();
    w.put("cache", [field(1), field(2)]);
    w.put("drafts", [named(uuid(101))]);
    expect(await page(w, { kinds: KINDS })).toEqual({
      page: { rows: [], next: null },
      parents: {},
      drafts: [],
    });
  });

  test("a row of the person's id that is not a person: not held, nothing answered", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, kind: "task" }), field(1)]);
    expect(await page(w)).toEqual({
      page: { rows: [], next: null },
      parents: {},
    });
    expect(ids(await page(w, { parentKind: "task" }))).toEqual([uuid(101)]);
  });

  test("a visible person with no fields: held, with an empty page (never hidden)", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" })]);
    const result = await page(w);
    expect(result.page).toEqual({ rows: [], next: null });
    expect(result.parents[PERSON]?.label).toBe("Mo");
  });

  test("the ledger (every field): a field is answered only under a held person; the cursor is the page READ, so hidden rows never trap a later one", async () => {
    const w = await pageWorld();
    // 100 fields of an absent person first in id order, then one of a visible person.
    w.put("cache", [
      cacheRow({ id: OTHER, label: "Bo" }),
      ...Array.from({ length: 100 }, (_, i) => field(i)),
      cacheRow({
        id: uuid(300),
        kind: "field",
        parent_id: OTHER,
        label: "visible",
      }),
    ]);
    const first = await page(w, {}, false);
    expect(first.page.rows).toEqual([]);
    expect(first.parents).toEqual({});
    expect(first.page.next).toBe(uuid(199));
    const second = await page(w, { after: first.page.next }, false);
    expect(ids(second)).toEqual([uuid(300)]);
    expect(second.parents[OTHER]?.label).toBe("Bo");
    expect(second.page.next).toBeNull();
  });

  test("more draft entries over the page than one read answers whole: drafts null (never a part of them as all of them)", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON }), field(1)]);
    w.put(
      "drafts",
      Array.from({ length: 1001 }, (_, i) =>
        named(uuid(101), { local_id: `D${i}`, created_seq: i + 1 }),
      ),
    );
    expect((await page(w, { kinds: KINDS })).drafts).toBeNull();
    // Control: at the bound, every one is answered.
    const at = await pageWorld();
    at.put("cache", [cacheRow({ id: PERSON }), field(1)]);
    at.put(
      "drafts",
      Array.from({ length: 1000 }, (_, i) =>
        named(uuid(101), { local_id: `D${i}`, created_seq: i + 1 }),
      ),
    );
    expect((await page(at, { kinds: KINDS })).drafts).toHaveLength(1000);
  });
});

describe("readChildPage live, through the production page commit", () => {
  async function watched(w: World) {
    const answers: Loadable<ChildPage>[] = [];
    const watch = w.service.store.watch(readChildPage, {
      incarnationId: w.service.incarnationId,
      kind: "field",
      parentKind: "person",
      parentId: PERSON,
      after: null,
    });
    const stop = watch.subscribe(() => answers.push(watch.get()));
    const settle = async () => {
      for (let i = 0; i < 10; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await settle();
    return { watch, answers, stop, settle };
  }
  const held = (answer: Loadable<ChildPage>) =>
    answer.status === "ready" ? PERSON in answer.value.parents : "not ready";
  const listed = (answer: Loadable<ChildPage>) =>
    answer.status === "ready"
      ? answer.value.page.rows.map(
          (row) => `${row.base.id} ${row.merged.label}`,
        )
      : "not ready";

  test("the person alone is removed, its field kept: the read answers again without the person; it returns: held again", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
    const t = await watched(w);
    expect(held(t.watch.get())).toBe(true);
    await w.commit(w.input(removal(7, [{ kind: "remove", id: PERSON }])));
    await t.settle();
    expect(w.cache().map((row) => row.id)).toEqual([uuid(101)]);
    expect(held(t.watch.get())).toBe(false);
    expect(listed(t.watch.get())).toEqual([]);
    await w.commit(
      w.input(
        removal(8, [
          {
            kind: "upsert",
            resource: {
              id: PERSON,
              kind: "person",
              parent_id: null,
              label: "Mo",
              value: null,
              version: 2,
              can_edit: true,
              archived: false,
            },
          },
        ]),
      ),
    );
    await t.settle();
    expect(held(t.watch.get())).toBe(true);
    expect(listed(t.watch.get())).toEqual([`${uuid(101)} field 1`]);
    t.stop();
  });

  for (const order of ["removal first", "change first"] as const)
    test(`ONE commit removes the person and changes and adds fields (${order}): no answer ever lists the new label or the new field`, async () => {
      const w = await pageWorld();
      w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
      const t = await watched(w);
      const changes = [
        { kind: "upsert" as const, resource: fieldProjection(1, "NEW LABEL") },
        { kind: "upsert" as const, resource: fieldProjection(2) },
      ];
      const remove = { kind: "remove" as const, id: PERSON };
      await w.commit(
        w.input(
          removal(
            7,
            order === "removal first"
              ? [remove, ...changes]
              : [...changes, remove],
          ),
        ),
      );
      await t.settle();
      expect(
        w
          .cache()
          .map((row) => row.id)
          .sort(),
      ).toEqual([uuid(101), uuid(102)]);
      expect(held(t.watch.get())).toBe(false);
      const shown = t.answers.flatMap((answer) => {
        const now = listed(answer);
        return now === "not ready" ? [] : now;
      });
      expect(shown.some((row) => row.includes("NEW LABEL"))).toBe(false);
      expect(shown.some((row) => row.startsWith(uuid(102)))).toBe(false);
      t.stop();
    });

  test("control: a field changed and one added under the visible person are listed", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
    const t = await watched(w);
    await w.commit(
      w.input(
        removal(7, [
          { kind: "upsert", resource: fieldProjection(1, "NEW LABEL") },
          { kind: "upsert", resource: fieldProjection(2) },
        ]),
      ),
    );
    await t.settle();
    expect(listed(t.watch.get())).toEqual([
      `${uuid(101)} NEW LABEL`,
      `${uuid(102)} field 2`,
    ]);
    t.stop();
  });
});

describe("readMergedUnder: a resource and its parent in one read", () => {
  const run = (w: World, id: string, parentId?: string) =>
    w.service.store.run(readMergedUnder, {
      incarnationId: w.service.incarnationId,
      id,
      ...(parentId === undefined ? {} : { parentId }),
    });

  test("a field and the person it names, each as readMerged reads it (overlay applied)", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
    w.put("pending_effects", [
      effectRow({
        resource_id: PERSON,
        local_id: "L1",
        display: { label: "Mo (renamed)" },
      }),
    ]);
    const read = await run(w, uuid(101));
    expect(read.resource.merged?.label).toBe("field 1");
    expect(read.parent?.base?.label).toBe("Mo");
    expect(read.parent?.merged?.label).toBe("Mo (renamed)");
  });

  test("the parent the caller names is read, even for a field the cache does not hold", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" })]);
    const read = await run(w, uuid(101), PERSON);
    expect(read.resource.base).toBeNull();
    expect(read.parent?.base?.id).toBe(PERSON);
  });

  test("a person removed while its field stays: the parent read says not cached", async () => {
    const w = await pageWorld();
    w.put("cache", [field(1)]);
    const read = await run(w, uuid(101));
    expect(read.resource.base?.id).toBe(uuid(101));
    expect(read.parent?.base).toBeNull();
    expect(read.parent?.merged).toBeNull();
  });

  test("a resource that names no parent: parent null", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" })]);
    expect((await run(w, PERSON)).parent).toBeNull();
  });
});

describe("witnesses read in the same transaction", () => {
  test("readFormCopiesUnder: the copies of a prefix and whether the cache holds the person, as that kind", async () => {
    const run = (w: World, kind: "person" | "task") =>
      w.service.store.run(readFormCopiesUnder, {
        incarnationId: w.service.incarnationId,
        prefix: "people-held:P:",
        after: null,
        witness: { id: PERSON, kind },
      });
    const w = await pageWorld();
    w.put("form_recovery" as never, [
      recoveryRow({ form_context: "people-held:P:F", tab_instance_id: "h1" }),
      recoveryRow({ form_context: "elsewhere:F", tab_instance_id: "h2" }),
    ]);
    const absent = await run(w, "person");
    expect(absent.witnessed).toBe(false);
    expect(absent.page.copies.map((row) => row.tab_instance_id)).toEqual([
      "h1",
    ]);
    w.put("cache", [cacheRow({ id: PERSON })]);
    expect((await run(w, "person")).witnessed).toBe(true);
    expect((await run(w, "task")).witnessed).toBe(false);
  });

  test("readOutstandingCreates: with a witness the window says whether the cache holds it; without one it says nothing", async () => {
    const run = (w: World, witness?: { id: string; kind: "person" }) =>
      w.service.store.run(readOutstandingCreates, {
        incarnationId: w.service.incarnationId,
        kinds: KINDS,
        ...(witness === undefined ? {} : { witness }),
      });
    const w = await pageWorld();
    w.put("drafts", [named(uuid(101), { local_id: "Q1", created_seq: 1 })]);
    expect(await run(w, { id: PERSON, kind: "person" })).toEqual({
      drafts: [expect.objectContaining({ local_id: "Q1" })],
      next: null,
      witnessed: false,
    });
    w.put("cache", [cacheRow({ id: PERSON })]);
    expect((await run(w, { id: PERSON, kind: "person" })).witnessed).toBe(true);
    expect("witnessed" in (await run(w))).toBe(false);
  });
});

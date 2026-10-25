// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type ResourcePage,
  readResourceList,
  readVisibleChildren,
  type VisibleChildren,
} from "../../src/data/plans/outbox";
import type { Loadable } from "../../src/data/store/port";
import { pageWorld } from "../support/data/page-world";
import { cacheRow, effectRow } from "../support/data/rows";
import { type PageSpec, uuid } from "../support/data/sync-pages";

/**
 * PPL-5 / A14 (WEB-11a review 15, R15.1; DA15-04): `readVisibleChildren` reads a parent and the page of its children in ONE transaction and
 * says nothing of the children unless the cache holds the parent as the kind asked for. Through the PRODUCTION plan over the double of
 * IndexedDB, and the PRODUCTION page commit for a removal that leaves the children cached. Expected values are literal ids and counts, not
 * the answer of another plan. FIXTURE evidence: the double re-runs a watch after any commit to its scope, so the live tests here show what
 * the plan answers after each commit, not which commits the engine's live query would notice (the native E-P39 case does that).
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

type World = Awaited<ReturnType<typeof pageWorld>>;
const read = (
  w: World,
  over: Partial<{ parentId: string; parentKind: "person" | "field" }> = {},
): Promise<VisibleChildren> =>
  w.service.store.run(readVisibleChildren, {
    incarnationId: w.service.incarnationId,
    parentId: over.parentId ?? PERSON,
    parentKind: over.parentKind ?? "person",
    kind: "field",
  });
const ids = (result: VisibleChildren) =>
  result === null ? null : result.rows.map((row) => row.base.id);

const removal = (
  revision: number,
  changes: PageSpec["batches"][number]["changes"],
): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: `cursor-${revision}`,
  batches: [{ revision, changes }],
});
const fieldProjection = (n: number) => ({
  id: uuid(100 + n),
  kind: "field",
  parent_id: PERSON,
  label: `field ${n}`,
  value: null,
  version: 1,
  can_edit: true,
  archived: false,
});

describe("one read of the parent and its children", () => {
  test("a visible person: the page of its fields, exactly as the list read gives it (overlay and order)", async () => {
    const w = await pageWorld();
    w.put("cache", [
      cacheRow({ id: PERSON, label: "Mo" }),
      field(2),
      field(1),
      cacheRow({ id: uuid(200), kind: "field", parent_id: OTHER }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: uuid(101),
        local_id: "L1",
        display: { archived: true },
      }),
    ]);
    const result = await read(w);
    expect(ids(result)).toEqual([uuid(101), uuid(102)]);
    if (result === null) throw new Error("visible");
    expect(result.rows.map((row) => row.merged.archived)).toEqual([
      true,
      false,
    ]);
    expect(result.rows.map((row) => row.pending)).toEqual([1, 0]);
    expect(result.next).toBeNull();
    // The list read of the same parent, unchanged by this plan.
    const list: ResourcePage = await w.service.store.run(readResourceList, {
      incarnationId: w.service.incarnationId,
      kind: "field",
      parentId: PERSON,
    });
    expect(list.rows.map((row) => row.base.id)).toEqual([uuid(101), uuid(102)]);
  });

  test("a read-only and an archived person are visible (the cached-person rule: neither editability nor archival hides)", async () => {
    for (const over of [{ can_edit: false }, { archived: true }]) {
      const w = await pageWorld();
      w.put("cache", [cacheRow({ id: PERSON, ...over }), field(1)]);
      expect(ids(await read(w))).toEqual([uuid(101)]);
    }
  });

  test("no person in the cache: hidden, though its fields are still cached", async () => {
    const w = await pageWorld();
    w.put("cache", [field(1), field(2)]);
    expect(await read(w)).toBeNull();
  });

  test("a row of that id that is not a person: hidden", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, kind: "task" }), field(1)]);
    expect(await read(w)).toBeNull();
    expect(ids(await read(w, { parentKind: "field" }))).toBeNull();
  });

  test("a visible person with no fields: visible with an empty page (never hidden)", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON })]);
    expect(await read(w)).toEqual({ rows: [], next: null });
  });

  test("the page bound and its continuation are the list read's: 101 fields are a first page of 100 that says more follow", async () => {
    const w = await pageWorld();
    w.put("cache", [
      cacheRow({ id: PERSON }),
      ...Array.from({ length: 101 }, (_, i) => field(i)),
    ]);
    const first = await read(w);
    if (first === null) throw new Error("visible");
    expect(first.rows).toHaveLength(100);
    expect(first.next).toBe(uuid(199));
    expect(ids(first)).toEqual(
      Array.from({ length: 100 }, (_, i) => uuid(100 + i)),
    );
  });
});

describe("the live read follows the parent through the production page commit", () => {
  async function watched(w: World) {
    const answers: Loadable<VisibleChildren>[] = [];
    const watch = w.service.store.watch(readVisibleChildren, {
      incarnationId: w.service.incarnationId,
      parentId: PERSON,
      parentKind: "person",
      kind: "field",
    });
    const stop = watch.subscribe(() => answers.push(watch.get()));
    const settle = async () => {
      for (let i = 0; i < 10; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await settle();
    return { watch, answers, stop, settle };
  }

  test("the person is removed and its field stays cached: the read answers hidden; it returns: visible again", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
    const t = await watched(w);
    const before = t.watch.get();
    expect(before.status === "ready" ? ids(before.value) : "not ready").toEqual(
      [uuid(101)],
    );
    expect(
      (await w.commit(w.input(removal(7, [{ kind: "remove", id: PERSON }]))))
        .kind,
    ).toBe("applied");
    await t.settle();
    // The precondition of A14: the field outlives its person in the cache.
    expect(w.cache().map((row) => row.id)).toEqual([uuid(101)]);
    expect(t.watch.get()).toEqual({ status: "ready", value: null });
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
    const back = t.watch.get();
    expect(back.status === "ready" ? ids(back.value) : "not ready").toEqual([
      uuid(101),
    ]);
    t.stop();
  });

  test("ONE commit removes the person and adds a field: no answer ever lists the new field", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
    const t = await watched(w);
    await w.commit(
      w.input(
        removal(7, [
          { kind: "remove", id: PERSON },
          { kind: "upsert", resource: fieldProjection(2) },
        ]),
      ),
    );
    await t.settle();
    expect(
      w
        .cache()
        .map((row) => row.id)
        .sort(),
    ).toEqual([uuid(101), uuid(102)]);
    expect(t.watch.get()).toEqual({ status: "ready", value: null });
    expect(
      t.answers.some(
        (answer) =>
          answer.status === "ready" &&
          (ids(answer.value) ?? []).includes(uuid(102)),
      ),
    ).toBe(false);
    t.stop();
  });

  test("control: a field added under the visible person is listed", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: PERSON, label: "Mo" }), field(1)]);
    const t = await watched(w);
    await w.commit(
      w.input(removal(7, [{ kind: "upsert", resource: fieldProjection(2) }])),
    );
    await t.settle();
    const now = t.watch.get();
    expect(now.status === "ready" ? ids(now.value) : "not ready").toEqual([
      uuid(101),
      uuid(102),
    ]);
    t.stop();
  });
});

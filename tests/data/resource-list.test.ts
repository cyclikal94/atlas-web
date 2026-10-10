// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { mergeResource } from "../../src/data/model/overlay";
import type { CacheRow, PendingEffectRow } from "../../src/data/model/types";
import {
  listPageSize,
  type ResourcePage,
  readResourceList,
} from "../../src/data/plans/outbox";
import { NAME, pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R14 (revision 10): the resource list is a bounded PAGE with a continuation, and its overlay is read and reduced in windows. The
 * fifth review seeded 350 cached resources and 350 unrelated pending effects (with retained acknowledged drafts): one read returned
 * 350 resources and a single batch of 350 cache rows and 350 effects. Here the same populations are read through the PRODUCTION plan
 * over the double of IndexedDB, and what each read returned and held at once is counted. FIXTURE evidence: a read-size counter, not a
 * heap measurement; the same plan runs in the real engines as conformance case C-19.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;
const PAGE = DATA_CONFIG.listPage;

type World = Awaited<ReturnType<typeof pageWorld>>;

const read = (
  w: World,
  input: {
    kind?: "person" | "task";
    parentId?: string;
    after?: string | null;
    limit?: number;
  } = {},
): Promise<ResourcePage> =>
  w.service.store.run(readResourceList, {
    incarnationId: w.service.incarnationId,
    kind: input.kind ?? "person",
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });

/** Every page of a list, from the first, until `next` is null. */
async function walk(
  w: World,
  input: Parameters<typeof read>[1] = {},
): Promise<ResourcePage[]> {
  const pages: ResourcePage[] = [];
  let after: string | null | undefined;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await read(w, { ...input, after });
    pages.push(page);
    if (page.next === null) return pages;
    after = page.next;
  }
  throw new Error("the walk did not end");
}

const peaks = (w: World) => Object.fromEntries(w.env.idb.reads.maxBatch);
const total = (w: World) => Object.fromEntries(w.env.idb.reads.rows);

describe("the review's populations: 350 cached resources and 350 unrelated pending effects, with retained acknowledged drafts", () => {
  for (const filter of ["kind", "parent"] as const)
    test(`the ${filter} filter reads a bounded page and touches no unrelated effect`, async () => {
      const w = await pageWorld();
      const parent = uuid(999);
      w.put(
        "cache",
        Array.from({ length: 350 }, (_, i) =>
          cacheRow({ id: uuid(i + 1), parent_id: parent }),
        ),
      );
      w.put(
        "drafts",
        Array.from({ length: 350 }, (_, i) =>
          draftRow({
            local_id: `unrelated-${i}`,
            status: "acknowledged",
            held_pending_cache: true,
            created_seq: i + 1,
          }),
        ),
      );
      w.put(
        "pending_effects",
        Array.from({ length: 350 }, (_, i) =>
          effectRow({
            resource_id: uuid(1000 + i),
            local_id: `unrelated-${i}`,
            display: { label: "unrelated overlay" },
          }),
        ),
      );
      w.env.idb.reads.reset();
      const page = await read(
        w,
        filter === "parent" ? { parentId: parent } : {},
      );
      expect(page.rows.length).toBe(PAGE);
      expect(page.next).toBe(page.rows[PAGE - 1]?.base.id);
      expect(peaks(w).cache).toBeLessThanOrEqual(PAGE);
      // None of the 350 effects belongs to a resource of the page, so none is read.
      expect(total(w).pending_effects ?? 0).toBe(0);
      expect(total(w).drafts ?? 0).toBe(0);
      for (const row of page.rows) expect(row.pending).toBe(0);
    });
});

describe("a page, a continuation, and the whole list", () => {
  test("a walk of 350 rows meets each once, in order, in pages of 100, 100, 100 and 50, and the last says there is no more", async () => {
    const w = await pageWorld();
    const ids = Array.from({ length: 350 }, (_, i) => uuid(i + 1));
    w.put(
      "cache",
      ids.map((id) => cacheRow({ id })),
    );
    // Rows of another kind, and of another parent, are in the same store and never in the list.
    w.put("cache", [
      cacheRow({ id: uuid(5000), kind: "task" }),
      cacheRow({ id: uuid(5001), kind: "task", parent_id: uuid(1) }),
    ]);
    const pages = await walk(w);
    expect(pages.map((page) => page.rows.length)).toEqual([100, 100, 100, 50]);
    expect(pages.map((page) => page.next !== null)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(
      pages.flatMap((page) => page.rows.map((row) => row.base.id)),
    ).toEqual(ids);
  });

  test("a list that is exactly a whole number of pages ends on its last page, not on an empty one", async () => {
    const w = await pageWorld();
    w.put(
      "cache",
      Array.from({ length: 200 }, (_, i) => cacheRow({ id: uuid(i + 1) })),
    );
    const pages = await walk(w);
    expect(pages.map((page) => page.rows.length)).toEqual([100, 100]);
    expect(pages[1]?.next).toBeNull();
  });

  test("an empty list, and a list of one", async () => {
    const w = await pageWorld();
    expect(await read(w)).toEqual({ rows: [], next: null });
    w.put("cache", [cacheRow({ id: uuid(1) })]);
    const one = await read(w);
    expect(one.rows.length).toBe(1);
    expect(one.next).toBeNull();
  });

  test("a page smaller than the bound can be asked for, and a larger one is held to it", async () => {
    const w = await pageWorld();
    w.put(
      "cache",
      Array.from({ length: 250 }, (_, i) => cacheRow({ id: uuid(i + 1) })),
    );
    const small = await walk(w, { limit: 7 });
    expect(small.length).toBe(36);
    expect(Math.max(...small.map((page) => page.rows.length))).toBe(7);
    expect(small.flatMap((page) => page.rows).length).toBe(250);
    for (const asked of [101, 500, 1_000_000, Number.POSITIVE_INFINITY]) {
      expect((await read(w, { limit: asked })).rows.length).toBe(PAGE);
      expect(listPageSize(asked)).toBe(PAGE);
    }
    for (const asked of [0, -3, Number.NEGATIVE_INFINITY])
      expect(listPageSize(asked)).toBe(1);
    expect(listPageSize(Number.NaN)).toBe(PAGE);
    expect(listPageSize(undefined)).toBe(PAGE);
    expect(listPageSize(0.4)).toBe(1);
  });

  test("a list under a parent holds the kind to the one asked for, however the kinds are interleaved, and pages through the rest", async () => {
    const w = await pageWorld();
    const parent = uuid(999);
    const rows: CacheRow[] = [];
    for (let i = 0; i < 300; i += 1)
      rows.push(
        cacheRow({
          id: uuid(i + 1),
          parent_id: parent,
          kind: i % 3 === 0 ? "task" : "person",
        }),
      );
    w.put("cache", rows);
    // Persons of another parent are not in it.
    w.put("cache", [cacheRow({ id: uuid(7000), parent_id: uuid(998) })]);
    const pages = await walk(w, { parentId: parent, limit: 40 });
    const persons = rows.filter((row) => row.kind === "person");
    expect(
      pages.flatMap((page) => page.rows.map((row) => row.base.id)),
    ).toEqual(persons.map((row) => row.id));
    expect(pages.map((page) => page.rows.length)).toEqual([40, 40, 40, 40, 40]);
    expect(pages[pages.length - 1]?.next).toBeNull();
    // The pages of the other kind, under the same parent, are the complement.
    const tasks = await walk(w, { parentId: parent, kind: "task" });
    expect(tasks.flatMap((page) => page.rows).length).toBe(100);
  });

  test("the walk resumes where it left off whatever changes between pages: nothing is met twice, nothing after the cursor is missed", async () => {
    const w = await pageWorld();
    const ids = Array.from({ length: 30 }, (_, i) => uuid(100 + i * 10));
    w.put(
      "cache",
      ids.map((id) => cacheRow({ id })),
    );
    const first = await read(w, { limit: 10 });
    expect(first.rows.map((row) => row.base.id)).toEqual(ids.slice(0, 10));
    // Between the pages: rows are added before the cursor and after it, and the row the cursor names is removed.
    const before = uuid(101);
    const added = uuid(205);
    const cursor = first.next as string;
    w.env.idb.clearStore(NAME, "cache");
    w.put("cache", [
      ...ids.filter((id) => id !== cursor).map((id) => cacheRow({ id })),
      cacheRow({ id: before }),
      cacheRow({ id: added }),
    ]);
    const second = await read(w, { limit: 10, after: cursor });
    const seen = second.rows.map((row) => row.base.id);
    const expectedSecond = [...ids.slice(10), added].sort().slice(0, 10);
    expect(seen).toEqual(expectedSecond);
    // Nothing the first page returned comes again, and the row added before the cursor is not met on the way forward.
    for (const id of first.rows.map((row) => row.base.id))
      expect(seen).not.toContain(id);
    expect(seen).not.toContain(before);
    const third = await read(w, { limit: 10, after: second.next as string });
    const all = [...first.rows, ...second.rows, ...third.rows].map(
      (row) => row.base.id,
    );
    expect(new Set(all).size).toBe(all.length);
    expect(third.rows.length).toBe(10);
  });

  test("a cursor past the end is an empty last page, not an error", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: uuid(1) })]);
    expect(await read(w, { after: uuid(9) })).toEqual({
      rows: [],
      next: null,
    });
  });
});

describe("the overlay of a page is read in windows and reduced", () => {
  const specification = (
    base: CacheRow,
    effects: readonly PendingEffectRow[],
  ): CacheRow => mergeResource(base, effects).merged as CacheRow;

  test("ONE displayed resource with 350 changes: every one counts and shows, and no read returns more than a window", async () => {
    const w = await pageWorld();
    const base = cacheRow({ id: uuid(1), label: "Base", value: { keep: 1 } });
    w.put("cache", [base, cacheRow({ id: uuid(2), label: "Other" })]);
    const effects = Array.from({ length: 350 }, (_, i) =>
      effectRow({
        resource_id: base.id,
        local_id: `d-${String(i).padStart(4, "0")}`,
        created_at: `2026-10-01T09:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        display: { label: `edit ${i}`, value: { n: i } },
      }),
    );
    // A change of an UNRELATED resource sorts between and after: it is never read.
    const stray = effectRow({
      resource_id: uuid(900),
      local_id: "stray",
      display: { label: "stray" },
    });
    w.put("pending_effects", [...effects, stray]);
    w.env.idb.reads.reset();
    const page = await read(w);
    const [shown, other] = page.rows;
    expect(shown?.pending).toBe(350);
    expect(shown?.merged).toEqual(specification(base, effects));
    expect(shown?.merged.label).toBe("edit 349");
    expect(other?.pending).toBe(0);
    expect(other?.merged.label).toBe("Other");
    expect(peaks(w).pending_effects).toBeLessThanOrEqual(WINDOW);
    expect(total(w).pending_effects).toBe(350);
  });

  test("changes spread over several resources, on and around the window boundaries, fold to the sequential merge", async () => {
    const w = await pageWorld();
    const counts = [
      0,
      1,
      WINDOW - 1,
      WINDOW,
      WINDOW + 1,
      2 * WINDOW,
      2 * WINDOW + 1,
      7,
    ];
    const bases = counts.map((_, i) =>
      cacheRow({ id: uuid(i + 1), label: `Base ${i}`, value: { n: -1 } }),
    );
    w.put("cache", bases);
    const byResource = new Map<string, PendingEffectRow[]>();
    const all: PendingEffectRow[] = [];
    counts.forEach((count, r) => {
      const list = Array.from({ length: count }, (_, i) =>
        effectRow({
          resource_id: uuid(r + 1),
          local_id: `r${r}-${String((i * 7919) % 1000).padStart(4, "0")}-${i}`,
          created_at: `2026-10-01T09:00:${String(i % 50).padStart(2, "0")}.000Z`,
          display:
            i % 5 === 4 ? null : { label: `r${r} #${i}`, value: { n: i } },
        }),
      );
      byResource.set(uuid(r + 1), list);
      all.push(...list);
    });
    w.put("pending_effects", all);
    w.env.idb.reads.reset();
    const page = await read(w);
    expect(page.rows.length).toBe(counts.length);
    page.rows.forEach((row, r) => {
      expect(row.pending, `resource ${r}`).toBe(counts[r]);
      expect(row.merged, `resource ${r}`).toEqual(
        specification(bases[r] as CacheRow, byResource.get(row.base.id) ?? []),
      );
    });
    expect(peaks(w).pending_effects).toBeLessThanOrEqual(WINDOW);
    // Every change of a displayed resource was read, once: no more.
    expect(total(w).pending_effects).toBe(all.length);
  });

  test("a resource whose changes end exactly at the end of a window is not read twice, and the next resource's are not skipped", async () => {
    const w = await pageWorld();
    w.put("cache", [
      cacheRow({ id: uuid(1) }),
      cacheRow({ id: uuid(2) }),
      cacheRow({ id: uuid(3) }),
    ]);
    const mk = (resource: number, n: number) =>
      Array.from({ length: n }, (_, i) =>
        effectRow({
          resource_id: uuid(resource),
          local_id: `e-${String(i).padStart(4, "0")}`,
          display: { label: `${resource}:${i}` },
          created_at: `2026-10-01T09:00:${String(i % 60).padStart(2, "0")}.000Z`,
        }),
      );
    w.put("pending_effects", [...mk(1, WINDOW), ...mk(2, WINDOW), ...mk(3, 3)]);
    w.env.idb.reads.reset();
    const page = await read(w);
    expect(page.rows.map((row) => row.pending)).toEqual([WINDOW, WINDOW, 3]);
    expect(total(w).pending_effects).toBe(2 * WINDOW + 3);
    expect(peaks(w).pending_effects).toBeLessThanOrEqual(WINDOW);
  });

  test("the effects of the resources of the NEXT page are not read for this one", async () => {
    const w = await pageWorld();
    w.put(
      "cache",
      Array.from({ length: 150 }, (_, i) => cacheRow({ id: uuid(i + 1) })),
    );
    w.put(
      "pending_effects",
      Array.from({ length: 150 }, (_, i) =>
        effectRow({
          resource_id: uuid(i + 1),
          local_id: "e",
          display: { label: `shown ${i}` },
        }),
      ),
    );
    w.env.idb.reads.reset();
    const first = await read(w);
    expect(total(w).pending_effects).toBe(100);
    w.env.idb.reads.reset();
    const second = await read(w, { after: first.next });
    expect(second.rows.length).toBe(50);
    expect(total(w).pending_effects).toBe(50);
    expect(second.rows[0]?.merged.label).toBe("shown 100");
  });

  test("a queued change that is not in the cache yet does not appear in a list of the cache, and an effect with no display still counts", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: uuid(1), label: "Cached" })]);
    w.put("pending_effects", [
      effectRow({ resource_id: uuid(1), local_id: "a", display: null }),
      effectRow({
        resource_id: uuid(404),
        local_id: "create",
        display: { label: "Not cached yet" },
      }),
    ]);
    const page = await read(w);
    expect(page.rows.length).toBe(1);
    expect(page.rows[0]?.pending).toBe(1);
    expect(page.rows[0]?.merged.label).toBe("Cached");
  });
});

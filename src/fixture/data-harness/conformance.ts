import { mergeResource } from "../../data/model/overlay";
import type { RowOf, StoreName } from "../../data/model/schema";
import type { CacheRow, PendingEffectRow } from "../../data/model/types";
import { type ResourcePage, readResourceList } from "../../data/plans/outbox";
import {
  clearOverlayDisplays,
  interestingOf,
} from "../../data/plans/reconcile-windows";
import {
  type AccountStore,
  type Key,
  type Plan,
  PlanRejected,
  range,
  StoreFailure,
  type WriteSink,
  w,
} from "../../data/store/port";

/**
 * FIXTURE ONLY. The ONE conformance suite that the store double and the real Dexie adapter must both pass (F-A3, E-A3 of the
 * plan). It is framework-agnostic: the same cases run in Vitest against the double and in Chromium, Firefox and WebKit against
 * the real adapter (through `/__data`), so the double is validated by the engines rather than trusted.
 *
 * A passing run against the double says nothing about IndexedDB; a passing run in an engine says nothing about the other
 * engines. Each case states what it pins.
 */
export interface Assert {
  ok(value: unknown, message: string): void;
  equal(actual: unknown, expected: unknown, message: string): void;
  deepEqual(actual: unknown, expected: unknown, message: string): void;
}

export interface ConformanceWorld {
  /** A store handle on a FRESH database. */
  fresh(): Promise<AccountStore>;
  /** A second handle on the SAME database (a second connection, as a second tab has). */
  second(of: AccountStore): Promise<AccountStore>;
  /**
   * A transaction on this database that does not finish until `release()`, ahead of which every later transaction on `drafts`
   * queues. A real engine keeps it open with a loop of reads (`blockerPlan`); the double holds it with a fault injection.
   */
  blocker(store: AccountStore): Promise<{ release(): void }>;
}

export interface ConformanceCase {
  id: string;
  title: string;
  run(world: ConformanceWorld, assert: Assert): Promise<void>;
}

// ---- generic plans over the stores ---------------------------------------------------------------------------------------
export const putPlan = <K extends StoreName>(
  store: K,
): Plan<RowOf<K>[], null, number> => ({
  name: `conformance.put.${store}`,
  scope: [store],
  mode: "readwrite",
  durability: "strict",
  read: async () => null,
  decide: (_reads, rows) => ({
    writes: [w.bulkPut(store, rows)],
    result: rows.length,
  }),
});
/** A readwrite transaction on `drafts` that stays open, by reading in a loop, until `released()` is true. */
export const blockerPlan = (
  released: () => boolean,
): Plan<null, null, null> => ({
  name: "conformance.blocker",
  scope: ["drafts"],
  mode: "readwrite",
  durability: "strict",
  read: async (reader) => {
    while (!released()) await reader.get("drafts", "no-such-row");
    return null;
  },
  decide: () => ({ writes: [], result: null }),
});
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const getPlan = <K extends StoreName>(
  store: K,
): Plan<Key, RowOf<K> | undefined, RowOf<K> | undefined> => ({
  name: `conformance.get.${store}`,
  scope: [store],
  mode: "readonly",
  durability: "default",
  read: (reader, key) => reader.get(store, key),
  decide: (row) => ({ writes: [], result: row }),
});
export const listPlan = <K extends StoreName>(
  store: K,
): Plan<number | undefined, RowOf<K>[], RowOf<K>[]> => ({
  name: `conformance.list.${store}`,
  scope: [store],
  mode: "readonly",
  durability: "default",
  read: (reader, limit) => reader.list(store, limit),
  decide: (rows) => ({ writes: [], result: rows }),
});
const anyOfPlan = <K extends StoreName>(
  store: K,
): Plan<
  { index: string; keys: Key[]; limit?: number },
  RowOf<K>[],
  RowOf<K>[]
> => ({
  name: `conformance.anyOf.${store}`,
  scope: [store],
  mode: "readonly",
  durability: "default",
  read: (reader, input) =>
    reader.anyOf(store, input.index, input.keys, input.limit),
  decide: (rows) => ({ writes: [], result: rows }),
});
const byIndexPlan = <K extends StoreName>(
  store: K,
): Plan<
  {
    index: string;
    range: ReturnType<typeof range.all>;
    limit?: number;
    offset?: number;
  },
  RowOf<K>[],
  RowOf<K>[]
> => ({
  name: `conformance.byIndex.${store}`,
  scope: [store],
  mode: "readonly",
  durability: "default",
  read: (reader, input) =>
    reader.byIndex(store, input.index, input.range, input.limit, input.offset),
  decide: (rows) => ({ writes: [], result: rows }),
});

const pageByKeyPlan = (): Plan<
  {
    index: string;
    key: Key;
    after?: string;
    match?: Record<string, unknown>;
    limit: number;
  },
  RowOf<"cache">[],
  RowOf<"cache">[]
> => ({
  name: "conformance.pageByKey.cache",
  scope: ["cache"],
  mode: "readonly",
  durability: "default",
  read: (reader, input) =>
    reader.pageByKey("cache", input.index, input.key, {
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.match === undefined ? {} : { match: input.match }),
      limit: input.limit,
    }),
  decide: (rows) => ({ writes: [], result: rows }),
});

export const draft = (
  id: string,
  status: string,
  seq: number,
  extras: Record<string, unknown> = {},
): RowOf<"drafts"> =>
  ({
    local_id: id,
    account_id: "acct",
    endpoint: "/commands",
    target_id: null,
    kind: "edit",
    command_digest: `d-${id}`,
    defaults_revision: null,
    target_resource_ids: [],
    side_effect_bases: {},
    index_targets: [],
    bases: {},
    bumped: [],
    defaults_context: null,
    review_block: null,
    depends_on: [],
    status,
    held_pending_cache: false,
    unavailable_outcome: false,
    retry_state: null,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    display_patch: null,
    receipt_revision: null,
    created_seq: seq,
    created_at: "2026-10-01T09:00:00.000Z",
    ...extras,
  }) as RowOf<"drafts">;

/** The body of a draft, in its own store (decision D-23): nested, with text outside the ASCII range. */
export const commandRow = (id: string): RowOf<"draft_commands"> => ({
  local_id: id,
  command: {
    kind: "edit",
    nested: { list: [1, 2, { deep: null }], text: "naïve ☃ 𝔘" },
  },
});

const cacheRow = (
  id: string,
  kind: string,
  kindDate: string | null,
  parent: string | null = null,
): RowOf<"cache"> =>
  ({
    id,
    kind,
    parent_id: parent,
    label: `label ${id}`,
    value: { a: 1, b: [true, null, "x"] },
    version: 1,
    can_edit: true,
    archived: false,
    kind_date: kindDate,
  }) as RowOf<"cache">;

async function failureOf(
  promise: Promise<unknown>,
): Promise<StoreFailure | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof StoreFailure ? error : new StoreFailure("error");
  }
}

const ids = (rows: readonly { local_id?: string; id?: string }[]): string[] =>
  rows.map((row) => (row.local_id ?? row.id) as string);

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    id: "C-01",
    title:
      "a row of every owned store round-trips structurally (nested objects, arrays, null, unicode)",
    async run(world, t) {
      const store = await world.fresh();
      await store.run(putPlan("drafts"), [draft("d1", "queued", 1)]);
      await store.run(putPlan("cache"), [cacheRow("c1", "person", null)]);
      await store.run(putPlan("pending_effects"), [
        {
          resource_id: "r1",
          local_id: "d1",
          resource_version: 2,
          created_at: "2026-10-01T09:00:00.000Z",
          submitted_at_page_seq: 0,
          last_mentioned_page_seq: null,
          display: { label: "x", value: { n: 1 } },
          resolved: null,
          no_publication_floor: null,
          receipt_revision: null,
        },
      ]);
      await store.run(putPlan("resource_versions"), [
        { resource_id: "r1", locally_assumed_version: 3, basis: "resource" },
      ]);
      await store.run(putPlan("form_recovery"), [
        {
          form_context: "f",
          tab_instance_id: "t",
          fields: { a: "b" },
          redacted: [],
          saved_at: "2026-10-01T09:00:00.000Z",
          capture_seq: 1,
          terminal: false,
          content_digest: "x",
        },
      ]);
      t.deepEqual(
        await store.run(getPlan("drafts"), "d1"),
        draft("d1", "queued", 1),
        "a draft",
      );
      t.deepEqual(
        await store.run(getPlan("cache"), "c1"),
        cacheRow("c1", "person", null),
        "a cache row",
      );
      const effect = await store.run(getPlan("pending_effects"), ["r1", "d1"]);
      t.deepEqual(
        effect?.display,
        { label: "x", value: { n: 1 } },
        "a pending effect, by its compound key",
      );
      t.equal(
        (await store.run(getPlan("resource_versions"), "r1"))
          ?.locally_assumed_version,
        3,
        "a resource version",
      );
      t.deepEqual(
        (await store.run(getPlan("form_recovery"), ["f", "t"]))?.fields,
        { a: "b" },
        "a form recovery row, by its compound key",
      );
    },
  },
  {
    id: "C-02",
    title:
      "isolation: neither the row that was put nor the row that was read shares a live object with the store",
    async run(world, t) {
      const store = await world.fresh();
      const row = commandRow("iso");
      await store.run(putPlan("draft_commands"), [row]);
      (row.command as { kind: string }).kind = "mutated-after-put";
      const first = await store.run(getPlan("draft_commands"), "iso");
      t.equal(
        ((first as NonNullable<typeof first>).command as { kind: string }).kind,
        "edit",
        "a put row is copied in",
      );
      ((first as NonNullable<typeof first>).command as { kind: string }).kind =
        "mutated-after-get";
      const second = await store.run(getPlan("draft_commands"), "iso");
      t.equal(
        ((second as NonNullable<typeof second>).command as { kind: string })
          .kind,
        "edit",
        "a read row is copied out",
      );
    },
  },
  {
    id: "C-03",
    title:
      "atomicity: a PlanRejected thrown by `apply` after writes rolls back every earlier write",
    async run(world, t) {
      const store = await world.fresh();
      await store.run(putPlan("drafts"), [draft("keep", "queued", 1)]);
      const failing: Plan<null, null, number> = {
        name: "conformance.reject",
        scope: ["drafts", "cache"],
        mode: "readwrite",
        durability: "default",
        read: async () => null,
        decide: () => ({
          writes: [w.put("drafts", draft("early", "queued", 2))],
          result: 0,
        }),
        apply: async (sink) => {
          await sink.put("cache", cacheRow("streamed", "person", null));
          await sink.delete("drafts", "keep");
          throw new PlanRejected("pass2", "invalid_element");
        },
      };
      const failure = await failureOf(store.run(failing, null));
      t.equal(failure?.cause, "plan_rejected", "the failure is plan_rejected");
      t.deepEqual(
        failure?.detail,
        { stage: "pass2", reason: "invalid_element" },
        "its fixed-shape detail survives",
      );
      t.deepEqual(
        ids(await store.run(listPlan("drafts"), undefined)),
        ["keep"],
        "the drafts are exactly as before",
      );
      t.deepEqual(
        await store.run(listPlan("cache"), undefined),
        [],
        "nothing was streamed in",
      );
    },
  },
  {
    id: "C-04",
    title:
      "atomicity: an unexpected error inside `decide` writes nothing and is an `error` failure",
    async run(world, t) {
      const store = await world.fresh();
      const throwing: Plan<null, null, number> = {
        name: "conformance.throw",
        scope: ["drafts"],
        mode: "readwrite",
        durability: "strict",
        read: async () => null,
        decide: () => {
          throw new Error("boom");
        },
      };
      const failure = await failureOf(store.run(throwing, null));
      t.equal(
        failure?.cause,
        "error",
        "an unexpected error is a plain `error` (it never carries its message)",
      );
      t.deepEqual(
        await store.run(listPlan("drafts"), undefined),
        [],
        "nothing was written",
      );
    },
  },
  {
    id: "C-05",
    title:
      "indexes: equality, multi-entry, compound, ranges, bounds, ordering and counts",
    async run(world, t) {
      const store = await world.fresh();
      await store.run(putPlan("drafts"), [
        draft("a", "queued", 3, {
          index_targets: ["r1", "r2"],
          depends_on: ["x"],
        }),
        draft("b", "queued", 1, { index_targets: ["r2"] }),
        draft("c", "rejected", 2, { index_targets: ["r1"] }),
        draft("d", "queued", 4, { index_targets: [] }),
      ]);
      const by = byIndexPlan("drafts");
      t.deepEqual(
        ids(
          await store.run(by, { index: "status", range: range.only("queued") }),
        ),
        ["a", "b", "d"],
        "equality by status, then primary-key order",
      );
      t.deepEqual(
        ids(await store.run(by, { index: "created_seq", range: range.all() })),
        ["b", "c", "a", "d"],
        "index order (created_seq), not insertion order",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "created_seq",
            range: range.between(2, 3),
          }),
        ),
        ["c", "a"],
        "a closed range is inclusive at both ends by default",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "created_seq",
            range: range.between(2, 3, { lowerOpen: true }),
          }),
        ),
        ["a"],
        "an open lower bound excludes it",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "created_seq",
            range: range.atLeast(3),
          }),
        ),
        ["a", "d"],
        "atLeast",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "created_seq",
            range: range.atMost(2, true),
          }),
        ),
        ["b"],
        "an open upper bound excludes it",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "index_targets",
            range: range.only("r2"),
          }),
        ),
        ["a", "b"],
        "multi-entry: every row whose array contains the key, once",
      );
      t.deepEqual(
        ids(
          await store.run(by, { index: "depends_on", range: range.only("x") }),
        ),
        ["a"],
        "a second multi-entry index",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "created_seq",
            range: range.all(),
            limit: 2,
          }),
        ),
        ["b", "c"],
        "`limit` bounds the result, after ordering",
      );
      const count: Plan<null, number, number> = {
        name: "conformance.count",
        scope: ["drafts"],
        mode: "readonly",
        durability: "default",
        read: (reader) =>
          reader.count("drafts", "status", range.only("queued")),
        decide: (n) => ({ writes: [], result: n }),
      };
      t.equal(await store.run(count, null), 3, "count by an index range");

      await store.run(putPlan("cache"), [
        cacheRow("t1", "task", "2026-10-02"),
        cacheRow("t2", "task", "2026-10-01"),
        cacheRow("t3", "task", null),
        cacheRow("p1", "person", "2026-10-01"),
      ]);
      const cacheBy = byIndexPlan("cache");
      t.deepEqual(
        ids(
          await store.run(cacheBy, {
            index: "[kind+kind_date]",
            range: range.between(
              ["task", "2026-10-01"],
              ["task", "2026-10-02"],
            ),
          }),
        ),
        ["t2", "t1"],
        "a compound index orders by its components; a null component is not indexed",
      );
      t.deepEqual(
        ids(
          await store.run(cacheBy, {
            index: "kind",
            range: range.only("task"),
          }),
        ),
        ["t1", "t2", "t3"],
        "an ordinary index includes the row whose OTHER index key is null",
      );
    },
  },
  {
    id: "C-06",
    title:
      "compound primary keys: two drafts against one resource keep two effect rows",
    async run(world, t) {
      const store = await world.fresh();
      const effect = (resource: string, local: string) => ({
        resource_id: resource,
        local_id: local,
        resource_version: 1,
        created_at: "2026-10-01T09:00:00.000Z",
        submitted_at_page_seq: 0,
        last_mentioned_page_seq: null,
        display: null,
        resolved: null as null,
        no_publication_floor: null,
        receipt_revision: null,
      });
      await store.run(putPlan("pending_effects"), [
        effect("r", "a"),
        effect("r", "b"),
        effect("s", "a"),
      ]);
      const by = byIndexPlan("pending_effects");
      t.equal(
        (await store.run(by, { index: "resource_id", range: range.only("r") }))
          .length,
        2,
        "two rows for one resource",
      );
      t.equal(
        (await store.run(by, { index: "local_id", range: range.only("a") }))
          .length,
        2,
        "two rows for one draft",
      );
    },
  },
  {
    id: "C-07",
    title:
      "order: transactions created in order, on two connections, never lose an update",
    async run(world, t) {
      const first = await world.fresh();
      const second = await world.second(first);
      const bump: Plan<null, RowOf<"resource_versions"> | undefined, number> = {
        name: "conformance.bump",
        scope: ["resource_versions"],
        mode: "readwrite",
        durability: "strict",
        read: (reader) => reader.get("resource_versions", "counter"),
        decide: (row) => {
          const next = (row?.locally_assumed_version ?? 0) + 1;
          return {
            writes: [
              w.put("resource_versions", {
                resource_id: "counter",
                locally_assumed_version: next,
                basis: "resource",
              }),
            ],
            result: next,
          };
        },
      };
      const runs: Promise<number>[] = [];
      for (let index = 0; index < 20; index += 1)
        runs.push((index % 2 === 0 ? first : second).run(bump, null));
      const results = await Promise.all(runs);
      t.deepEqual(
        [...results].sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, i) => i + 1),
        "twenty read-modify-write transactions from two connections serialise: every one saw the previous one's write",
      );
      t.equal(
        (await first.run(getPlan("resource_versions"), "counter"))
          ?.locally_assumed_version,
        20,
        "no update was lost",
      );
    },
  },
  {
    id: "C-08",
    title:
      "scope: a plan that reads a store outside its scope fails, and a readonly plan that returns writes is refused",
    async run(world, t) {
      const store = await world.fresh();
      const outside: Plan<null, unknown, number> = {
        name: "conformance.outside",
        scope: ["drafts"],
        mode: "readonly",
        durability: "default",
        read: (reader) => reader.get("cache", "x"),
        decide: () => ({ writes: [], result: 0 }),
      };
      t.ok(
        (await failureOf(store.run(outside, null))) !== null,
        "reading outside the scope fails",
      );
      const sneaky: Plan<null, null, number> = {
        name: "conformance.readonly_writes",
        scope: ["drafts"],
        mode: "readonly",
        durability: "default",
        read: async () => null,
        decide: () => ({
          writes: [w.put("drafts", draft("sneaky", "queued", 1))],
          result: 0,
        }),
      };
      t.ok(
        (await failureOf(store.run(sneaky, null))) !== null,
        "a readonly plan cannot write",
      );
      t.deepEqual(
        await store.run(listPlan("drafts"), undefined),
        [],
        "and nothing was written",
      );
    },
  },
  {
    id: "C-09",
    title: "bulk and streaming writes, deletes and clear",
    async run(world, t) {
      const store = await world.fresh();
      const rows = Array.from({ length: 250 }, (_, index) =>
        cacheRow(`id-${String(index).padStart(3, "0")}`, "person", null),
      );
      await store.run(putPlan("cache"), rows);
      t.equal(
        (await store.run(listPlan("cache"), undefined)).length,
        250,
        "250 rows bulk-put",
      );
      t.equal(
        (await store.run(listPlan("cache"), 10)).length,
        10,
        "list is bounded by its limit",
      );
      const streaming: Plan<null, null, number> = {
        name: "conformance.stream",
        scope: ["cache"],
        mode: "readwrite",
        durability: "default",
        read: async () => null,
        decide: () => ({ writes: [], result: 0 }),
        apply: async (sink) => {
          for (let index = 0; index < 100; index += 1)
            await sink.delete("cache", `id-${String(index).padStart(3, "0")}`);
          await sink.put("cache", cacheRow("streamed", "task", null));
          return 100;
        },
      };
      t.equal(
        await store.run(streaming, null),
        100,
        "the streamed result is returned",
      );
      t.equal(
        (await store.run(listPlan("cache"), undefined)).length,
        151,
        "100 deleted, 1 added by streaming",
      );
      const clearing: Plan<null, null, number> = {
        name: "conformance.clear",
        scope: ["cache"],
        mode: "readwrite",
        durability: "default",
        read: async () => null,
        decide: () => ({
          writes: [
            w.clear("cache"),
            w.put("cache", cacheRow("after-clear", "task", null)),
          ],
          result: 0,
        }),
      };
      await store.run(clearing, null);
      t.deepEqual(
        ids(await store.run(listPlan("cache"), undefined)),
        ["after-clear"],
        "clear then put in one transaction",
      );
    },
  },
  {
    id: "C-10",
    title:
      "a closed handle refuses every plan with `closed`, and a second handle is unaffected",
    async run(world, t) {
      const store = await world.fresh();
      const other = await world.second(store);
      await store.run(putPlan("drafts"), [draft("x", "queued", 1)]);
      store.close();
      store.close();
      t.equal(
        (await failureOf(store.run(listPlan("drafts"), undefined)))?.cause,
        "closed",
        "a closed handle refuses",
      );
      t.deepEqual(
        ids(await other.run(listPlan("drafts"), undefined)),
        ["x"],
        "the other connection still reads the committed row",
      );
    },
  },
  {
    id: "C-12",
    title:
      "a plan that awaits MANY native async calls between its writes stays in ONE transaction: an abort at the end leaves none of them (the zone-loss regression)",
    async run(world, t) {
      const store = await world.fresh();
      await store.run(putPlan("drafts"), [draft("pre-existing", "queued", 1)]);
      // The shape that broke the first implementation: a native `async` function awaited once per ELEMENT between chunk writes.
      // Dexie finds its implicit transaction through a "zone" that this pattern loses, after which each chunk is its own
      // auto-transaction (so a page was eight independent commits) and the page's own transaction ends empty
      // (PrematureCommitError). The double of IndexedDB cannot show it; only a real engine can.
      const perElement = async (): Promise<undefined> => undefined;
      const writeChunk = async (
        sink: Parameters<NonNullable<Plan<null, null, number>["apply"]>>[0],
        from: number,
      ): Promise<void> => {
        for (let i = 0; i < 100; i += 1) await perElement();
        await sink.bulkPut(
          "cache",
          Array.from({ length: 100 }, (_, i) =>
            cacheRow(`id-${from + i}`, "person", null),
          ),
        );
      };
      const failing: Plan<null, null, number> = {
        name: "conformance.zone",
        scope: ["drafts", "cache"],
        mode: "readwrite",
        durability: "default",
        read: async () => null,
        decide: () => ({
          writes: [w.put("drafts", draft("early", "queued", 2))],
          result: 0,
        }),
        apply: async (sink) => {
          await writeChunk(sink, 0);
          await writeChunk(sink, 100);
          await writeChunk(sink, 200);
          await sink.delete("drafts", "pre-existing");
          throw new PlanRejected("zone", "abort_at_the_end");
        },
      };
      const failure = await failureOf(store.run(failing, null));
      t.equal(
        failure?.cause,
        "plan_rejected",
        "the plan is rejected (not a premature-commit error)",
      );
      t.deepEqual(
        await store.run(listPlan("cache"), undefined),
        [],
        "none of the 300 cache rows written after native awaits survived the abort",
      );
      t.deepEqual(
        ids(await store.run(listPlan("drafts"), undefined)),
        ["pre-existing"],
        "the early write and the late delete were rolled back too",
      );
    },
  },
  {
    id: "C-11",
    title: "the singleton is present from creation and carries an incarnation",
    async run(world, t) {
      const store = await world.fresh();
      const row = await store.run(getPlan("sync_state"), "singleton");
      t.ok(row !== undefined, "a database that exists has its singleton");
      t.ok(
        typeof row?.incarnation_id === "string" &&
          row.incarnation_id.length > 0,
        "with an incarnation id",
      );
      t.equal(
        row?.incarnation_id,
        store.incarnationId,
        "which the handle captured at open",
      );
      t.equal(row?.cache_status, "empty", "an empty cache");
    },
  },
  {
    id: "C-13",
    title:
      "the version 2 indexes: a compound [status+created_seq] key, and nested key paths that list a row only while it has the object",
    async run(world, t) {
      const store = await world.fresh();
      await store.run(putPlan("drafts"), [
        draft("q3", "queued", 3),
        draft("q1", "queued", 1),
        draft("f2", "in_flight", 2, {
          retry_state: { state: "backing_off", since: 5 },
        }),
        draft("f4", "in_flight", 4, {
          retry_state: { state: "paused", since: 5 },
          review_block: { kind: "defaults", kinds: ["a"] },
        }),
        draft("q5", "queued", 5),
        draft("c6", "version_conflict", 6),
      ]);
      const by = byIndexPlan("drafts");
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "[status+created_seq]",
            range: range.between(
              ["queued", 0],
              ["queued", Number.MAX_SAFE_INTEGER],
            ),
          }),
        ),
        ["q1", "q3", "q5"],
        "the oldest drafts of ONE status, in queue order",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "[status+created_seq]",
            range: range.between(
              ["queued", 1],
              ["queued", Number.MAX_SAFE_INTEGER],
              {
                lowerOpen: true,
              },
            ),
            limit: 1,
          }),
        ),
        ["q3"],
        "resumed after a position, bounded by a limit",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "[status+created_seq]",
            range: range.between(
              ["in_flight", 0],
              ["in_flight", Number.MAX_SAFE_INTEGER],
            ),
          }),
        ),
        ["f2", "f4"],
        "another status is a separate run of the same index",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "retry_state.state",
            range: range.only("paused"),
          }),
        ),
        ["f4"],
        "a nested key path: only the paused drafts",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "retry_state.state",
            range: range.all(),
          }),
        ).sort(),
        ["f2", "f4"],
        "a row whose object is null is not in the index at all",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "review_block.kind",
            range: range.all(),
          }),
        ),
        ["f4"],
        "the reviewing drafts and no others",
      );
      const count: Plan<null, number[], number[]> = {
        name: "conformance.counts",
        scope: ["drafts"],
        mode: "readonly",
        durability: "default",
        read: async (reader) => [
          await reader.count("drafts", "retry_state.state", range.all()),
          await reader.count("drafts", "review_block.kind", range.all()),
          await reader.count("drafts", "status", range.only("queued")),
        ],
        decide: (n) => ({ writes: [], result: n }),
      };
      t.deepEqual(await store.run(count, null), [2, 1, 3], "indexed counts");
    },
  },
  {
    id: "C-14",
    title:
      "a signal ends a transaction that has not finished (it is queued behind another one, or applying): it writes nothing and the caller hears of it at once; one that has completed is beyond it",
    async run(world, t) {
      const store = await world.fresh();
      // A signal that has already fired refuses before a transaction is created.
      const fired = await failureOf(
        store.run(putPlan("drafts"), [draft("never", "queued", 1)], {
          signal: AbortSignal.abort(),
        }),
      );
      t.equal(fired?.cause, "abort", "a signal that has already fired refuses");
      t.equal(
        await store.run(getPlan("drafts"), "never"),
        undefined,
        "and nothing was created",
      );

      // QUEUED: the transaction exists and its request waits behind another transaction, which has no deadline of its own.
      const block = await world.blocker(store);
      const queuedSignal = new AbortController();
      let reported = false;
      const queued = failureOf(
        store.run(putPlan("drafts"), [draft("queued-write", "queued", 2)], {
          signal: queuedSignal.signal,
        }),
      ).then((failure) => {
        reported = true;
        return failure;
      });
      await pause(30);
      queuedSignal.abort();
      await pause(50);
      t.ok(
        reported,
        "the aborted transaction is reported while the blocker is STILL running (it did not wait for its turn)",
      );
      block.release();
      t.equal(
        (await queued)?.cause,
        "abort",
        "a transaction aborted in the queue is an abort",
      );
      t.equal(
        await store.run(getPlan("drafts"), "queued-write"),
        undefined,
        "and it never ran: its write is not there once the blocker has ended",
      );

      // COMPLETED: a signal that fires afterwards changes nothing.
      const after = new AbortController();
      await store.run(putPlan("drafts"), [draft("done", "queued", 3)], {
        signal: after.signal,
      });
      after.abort();
      await pause(10);
      t.ok(
        (await store.run(getPlan("drafts"), "done")) !== undefined,
        "a signal that fires after completion changes nothing",
      );

      // APPLYING: the signal fires inside the body, between its writes: every write of the transaction is rolled back.
      const mid = new AbortController();
      const applying: Plan<null, null, number> = {
        name: "conformance.abort_in_apply",
        scope: ["drafts"],
        mode: "readwrite",
        durability: "strict",
        read: async () => null,
        decide: () => ({
          writes: [w.put("drafts", draft("early-write", "queued", 4))],
          result: 0,
        }),
        apply: async (sink) => {
          await sink.put("drafts", draft("mid-write", "queued", 5));
          mid.abort();
          await sink.put("drafts", draft("late-write", "queued", 6));
          return 1;
        },
      };
      const failure = await failureOf(
        store.run(applying, null, { signal: mid.signal }),
      );
      t.equal(failure?.cause, "abort", "an abort while applying is an abort");
      t.deepEqual(
        ids(await store.run(listPlan("drafts"), undefined)),
        ["done"],
        "none of the transaction's writes is durable (the early, the middle and the late)",
      );
    },
  },
  {
    id: "C-15",
    title:
      "`anyOf` returns the rows of any of several keys, in index order then primary-key order, and `byIndex` with an offset walks a result a window at a time",
    async run(world, t) {
      const store = await world.fresh();
      await store.run(putPlan("drafts"), [
        draft("d1", "queued", 1),
        draft("d2", "in_flight", 2),
        draft("d3", "queued", 3),
        draft("d4", "blocked", 4),
        draft("d5", "queued", 5),
        draft("d6", "in_flight", 6),
      ]);
      const any = anyOfPlan("drafts");
      t.deepEqual(
        ids(
          await store.run(any, {
            index: "status",
            keys: ["queued", "blocked"],
          }),
        ),
        ["d4", "d1", "d3", "d5"],
        "the rows of either key, ordered by the index key (blocked before queued) and then by primary key",
      );
      t.deepEqual(
        ids(
          await store.run(any, {
            index: "status",
            keys: ["queued", "blocked"],
            limit: 2,
          }),
        ),
        ["d4", "d1"],
        "a limit bounds the result",
      );
      t.deepEqual(
        ids(await store.run(any, { index: "status", keys: [] })),
        [],
        "no keys, no rows (and no request)",
      );
      t.deepEqual(
        ids(
          await store.run(any, { index: "status", keys: ["absent", "queued"] }),
        ),
        ["d1", "d3", "d5"],
        "a key with no rows contributes none",
      );
      t.deepEqual(
        ids(await store.run(any, { index: "created_seq", keys: [5, 2, 9] })),
        ["d2", "d5"],
        "a numeric index, the keys given in any order, a missing one ignored",
      );
      const by = byIndexPlan("drafts");
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "created_seq",
            range: range.all(),
            limit: 2,
            offset: 2,
          }),
        ),
        ["d3", "d4"],
        "an offset skips rows, then the limit bounds what follows",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "status",
            range: range.only("queued"),
            offset: 1,
          }),
        ),
        ["d3", "d5"],
        "an offset with no limit",
      );
      t.deepEqual(
        ids(
          await store.run(by, {
            index: "status",
            range: range.only("queued"),
            limit: 5,
            offset: 3,
          }),
        ),
        [],
        "an offset past the end is an empty result",
      );
      // A window at a time, to the end: nothing lost, nothing repeated.
      const seen: string[] = [];
      for (let offset = 0; ; offset += 4) {
        const rows = ids(
          await store.run(by, {
            index: "created_seq",
            range: range.all(),
            limit: 4,
            offset,
          }),
        );
        seen.push(...rows);
        if (rows.length < 4) break;
      }
      t.deepEqual(
        seen,
        ["d1", "d2", "d3", "d4", "d5", "d6"],
        "windows of four cover the whole index once",
      );
    },
  },
  {
    id: "C-16",
    title:
      "the lookup of which ids have local work (`interestingOf`) finds every one of them, and no read returns more than the window, however many pending effects ONE resource has",
    async run(world, t) {
      const store = await world.fresh();
      const effect = (resource: string, local: string) =>
        ({
          resource_id: resource,
          local_id: local,
          resource_version: 1,
          created_at: "2026-10-01T09:00:00.000Z",
          submitted_at_page_seq: 0,
          last_mentioned_page_seq: null,
          display: { label: `shown ${local}` },
          resolved: null,
          no_publication_floor: null,
          receipt_revision: null,
        }) as RowOf<"pending_effects">;
      const effects: RowOf<"pending_effects">[] = [];
      // One resource with far more effects than a window (the retained acknowledged drafts of one resource), one with a few more than a
      // window, one with a single effect, and a resource that has only a tracked version.
      for (let i = 0; i < 350; i += 1)
        effects.push(effect("r-fan", `d-${String(i).padStart(4, "0")}`));
      for (let i = 0; i < 130; i += 1)
        effects.push(effect("r-two", `e-${String(i).padStart(4, "0")}`));
      effects.push(effect("r-one", "f-0001"));
      await store.run(putPlan("pending_effects"), effects);
      await store.run(putPlan("resource_versions"), [
        { resource_id: "r-ver", locally_assumed_version: 2, basis: "resource" },
      ]);
      const asked = ["r-fan", "r-none", "r-one", "r-two", "r-ver", "r-unknown"];
      const lookup = (window: number): Plan<null, null, unknown> => ({
        name: "conformance.interesting",
        scope: ["pending_effects", "resource_versions"],
        mode: "readonly",
        durability: "default",
        read: async (reader) => {
          // Every read the lookup makes, as the number of rows it returned.
          const sizes: number[] = [];
          const watched = {
            ...reader,
            bulkGet: async (...args: Parameters<typeof reader.bulkGet>) => {
              const rows = await reader.bulkGet(...args);
              sizes.push(rows.filter((row) => row !== undefined).length);
              return rows;
            },
            anyOf: async (...args: Parameters<typeof reader.anyOf>) => {
              const rows = await reader.anyOf(...args);
              sizes.push(rows.length);
              return rows;
            },
          } as typeof reader;
          const found = await interestingOf(watched, asked, window);
          return { found: [...found].sort(), sizes } as never;
        },
        decide: (reads) => ({ writes: [], result: reads }),
      });
      for (const window of [100, 7, 1]) {
        const got = (await store.run(lookup(window), null)) as {
          found: string[];
          sizes: number[];
        };
        t.deepEqual(
          got.found,
          ["r-fan", "r-one", "r-two", "r-ver"],
          `window ${window}: every id with a tracked version or a pending effect is found, and none of the others`,
        );
        t.ok(
          Math.max(...got.sizes) <= window,
          `window ${window}: no read returned more than the window (the largest was ${Math.max(...got.sizes)})`,
        );
        t.ok(
          got.sizes.length >= 2,
          `window ${window}: the effects were asked in bounded rounds, not in one read`,
        );
      }
    },
  },
  {
    id: "C-17",
    title:
      "the windowed overlay clear of the ordinary invalidation drops every overlay, returns no more than the window in any read however many effects ONE resource has, keeps every row, and rolls back whole when it fails part-way",
    async run(world, t) {
      const store = await world.fresh();
      const effect = (resource: string, local: string, shown: boolean) =>
        ({
          resource_id: resource,
          local_id: local,
          resource_version: 1,
          created_at: "2026-10-01T09:00:00.000Z",
          submitted_at_page_seq: 0,
          last_mentioned_page_seq: null,
          display: shown ? { label: `shown ${local}` } : null,
          resolved: null,
          no_publication_floor: null,
          receipt_revision: null,
        }) as RowOf<"pending_effects">;
      const effects: RowOf<"pending_effects">[] = [];
      // One resource with far more effects than a window (the retained acknowledged drafts of one resource, two thirds of them showing
      // an overlay), one that shows all of them, and one with a single effect that shows none.
      for (let i = 0; i < 350; i += 1)
        effects.push(
          effect("r-fan", `d-${String(i).padStart(4, "0")}`, i % 3 !== 1),
        );
      for (let i = 0; i < 130; i += 1)
        effects.push(effect("r-two", `e-${String(i).padStart(4, "0")}`, true));
      effects.push(effect("r-one", "f-0001", false));
      const total = effects.length;
      const showing = effects.filter((row) => row.display !== null).length;
      await store.run(putPlan("pending_effects"), effects);
      const shownNow = async (): Promise<number> =>
        (await store.run(listPlan("pending_effects"), undefined)).filter(
          (row) => row.display !== null,
        ).length;
      // The walk, in the transaction of its caller: every read it makes is measured, and `failAfter` makes its n+1-th write fail.
      let sizes: number[] = [];
      const clearing = (
        window: number,
        failAfter: number | null,
      ): Plan<null, null, number> => ({
        name: "conformance.clearOverlays",
        scope: ["pending_effects"],
        mode: "readwrite",
        durability: "strict",
        read: async () => null,
        decide: () => ({ writes: [], result: 0 }),
        async apply(sink, _decision, _reads, _input, reader) {
          const seen: number[] = [];
          const watched = {
            ...reader,
            byIndex: async (...args: Parameters<typeof reader.byIndex>) => {
              const rows = await reader.byIndex(...args);
              seen.push(rows.length);
              return rows;
            },
          } as typeof reader;
          let written = 0;
          const guarded: WriteSink = {
            ...sink,
            bulkPut: async (...args: Parameters<WriteSink["bulkPut"]>) => {
              if (failAfter !== null && written >= failAfter)
                throw new PlanRejected("apply", "conformance");
              written += 1;
              await sink.bulkPut(...args);
            },
          };
          const cleared = await clearOverlayDisplays(watched, guarded, window);
          sizes = seen;
          return cleared;
        },
      });
      // A failure part-way through the walk rolls EVERYTHING back, in the engine: no window's writes survive.
      const failed = await failureOf(store.run(clearing(7, 3), null));
      t.ok(
        failed?.cause === "plan_rejected",
        "a refusal inside the walk fails the transaction",
      );
      t.equal(
        await shownNow(),
        showing,
        "and every overlay is exactly as it was: the windows already written were rolled back",
      );
      t.equal(
        (await store.run(listPlan("pending_effects"), undefined)).length,
        total,
        "no row was lost",
      );
      for (const window of [100, 7, 1]) {
        await store.run(putPlan("pending_effects"), effects);
        const cleared = await store.run(clearing(window, null), null);
        t.equal(
          cleared,
          showing,
          `window ${window}: it reports how many overlays it dropped`,
        );
        t.equal(
          await shownNow(),
          0,
          `window ${window}: every overlay is dropped`,
        );
        t.equal(
          (await store.run(listPlan("pending_effects"), undefined)).length,
          total,
          `window ${window}: every effect row is kept`,
        );
        t.ok(
          Math.max(...sizes) <= window,
          `window ${window}: no read returned more than the window (the largest was ${Math.max(...sizes)})`,
        );
        t.ok(
          sizes.length >= Math.ceil(total / window),
          `window ${window}: the effects were walked in bounded windows, not read at once`,
        );
      }
    },
  },
  {
    id: "C-18",
    title:
      "a keyset page of one index key returns the rows after a primary key, in primary-key (string) order, holds the match, and resumes correctly whatever is added or removed between pages",
    async run(world, t) {
      const store = await world.fresh();
      // Ids that sort differently as text and as numbers: the order is the STRING order of the primary key, as IndexedDB keeps it.
      const ids = ["id-1", "id-10", "id-11", "id-2", "id-3", "id-20", "id-4"];
      await store.run(
        putPlan("cache"),
        ids.map((id, i) =>
          cacheRow(id, i % 2 === 0 ? "person" : "task", null, "p1"),
        ),
      );
      await store.run(putPlan("cache"), [
        cacheRow("id-5", "person", null, "p2"),
        cacheRow("zz-other-kind", "place", null, "p1"),
      ]);
      const page = (
        input: Parameters<ReturnType<typeof pageByKeyPlan>["read"]>[1],
      ) => store.run(pageByKeyPlan(), input);
      const idsOf = (rows: RowOf<"cache">[]) => rows.map((row) => row.id);
      const sorted = [...ids].sort();
      t.deepEqual(
        idsOf(await page({ index: "parent_id", key: "p1", limit: 100 })),
        [...sorted, "zz-other-kind"].sort(),
        "every row of the key, in primary-key order",
      );
      t.deepEqual(
        idsOf(await page({ index: "parent_id", key: "p1", limit: 3 })),
        [...sorted, "zz-other-kind"].sort().slice(0, 3),
        "at most the limit",
      );
      const all = [...sorted, "zz-other-kind"].sort();
      t.deepEqual(
        idsOf(
          await page({
            index: "parent_id",
            key: "p1",
            after: "id-11",
            limit: 100,
          }),
        ),
        all.slice(all.indexOf("id-11") + 1),
        "strictly after the primary key given: the row it names is not returned",
      );
      t.deepEqual(
        idsOf(
          await page({
            index: "parent_id",
            key: "p1",
            after: "id-1x",
            limit: 2,
          }),
        ),
        all.filter((id) => id > "id-1x").slice(0, 2),
        "after a key no row has: from the next one",
      );
      t.deepEqual(
        idsOf(
          await page({
            index: "parent_id",
            key: "p1",
            match: { kind: "person" },
            limit: 100,
          }),
        ),
        ids.filter((_, i) => i % 2 === 0).sort(),
        "match: only the rows whose fields equal it, the others skipped inside the store",
      );
      t.deepEqual(
        idsOf(
          await page({
            index: "parent_id",
            key: "p1",
            match: { kind: "person" },
            after: "id-1",
            limit: 2,
          }),
        ),
        ids
          .filter((_, i) => i % 2 === 0)
          .sort()
          .filter((id) => id > "id-1")
          .slice(0, 2),
        "match and after and limit together",
      );
      t.deepEqual(
        idsOf(await page({ index: "kind", key: "person", limit: 100 })),
        ["id-1", "id-11", "id-3", "id-4", "id-5"],
        "the kind index, across parents",
      );
      t.deepEqual(
        idsOf(await page({ index: "parent_id", key: "no-such", limit: 5 })),
        [],
        "a key no row has",
      );
      // A walk in pages of two, with rows added before and after the cursor and the cursor's own row removed between the pages.
      const first = idsOf(
        await page({ index: "parent_id", key: "p1", limit: 2 }),
      );
      const cursor = first[first.length - 1] as string;
      await store.run(
        {
          name: "conformance.removeCursorRow",
          scope: ["cache"],
          mode: "readwrite",
          durability: "strict",
          read: async () => null,
          decide: () => ({ writes: [w.delete("cache", cursor)], result: null }),
        } as Plan<null, null, null>,
        null,
      );
      await store.run(putPlan("cache"), [
        cacheRow("aaa-before", "person", null, "p1"),
        cacheRow("id-9", "person", null, "p1"),
      ]);
      const rest = idsOf(
        await page({
          index: "parent_id",
          key: "p1",
          after: cursor,
          limit: 100,
        }),
      );
      t.deepEqual(
        rest,
        [...all.filter((id) => id !== cursor), "aaa-before", "id-9"]
          .sort()
          .filter((id) => id > cursor),
        "the walk resumes after the cursor: the removed row is gone, the row added after it is met, the one added before it is not",
      );
      t.ok(
        !rest.includes("aaa-before") && !first.some((id) => rest.includes(id)),
        "nothing is met twice",
      );
    },
  },
  {
    id: "C-19",
    title:
      "the production resource list reads a bounded page of the cache with a continuation and the overlay of its resources in windows, and returns what the sequential merge gives, however many changes lie over one resource",
    async run(world, t) {
      const store = await world.fresh();
      const ids = Array.from(
        { length: 230 },
        (_, i) => `r-${String(i).padStart(4, "0")}`,
      );
      const rows: CacheRow[] = ids.map(
        (id, i) =>
          ({
            ...cacheRow(id, "person", null),
            label: `Base ${i}`,
            value: { n: -1, keep: true },
          }) as CacheRow,
      );
      await store.run(putPlan("cache"), rows);
      await store.run(putPlan("cache"), [
        cacheRow("t-1", "task", null),
        cacheRow("t-2", "task", null),
      ]);
      // One resource far past a window, resources exactly at and just past it, a few small ones, and effects of resources that are not
      // in the list at all.
      const counts = new Map<string, number>([
        ["r-0000", 250],
        ["r-0001", 100],
        ["r-0002", 101],
        ["r-0003", 1],
        ["r-0150", 7],
        ["r-0229", 120],
      ]);
      const effects: PendingEffectRow[] = [];
      for (const [resource, count] of counts)
        for (let i = 0; i < count; i += 1)
          effects.push({
            resource_id: resource,
            local_id: `${resource}-${String((i * 37) % 500).padStart(4, "0")}-${i}`,
            resource_version: 1,
            created_at: `2026-10-01T09:00:${String(i % 55).padStart(2, "0")}.000Z`,
            submitted_at_page_seq: 0,
            last_mentioned_page_seq: null,
            display:
              i % 6 === 5
                ? null
                : { label: `${resource} #${i}`, value: { n: i } },
            resolved: null,
            no_publication_floor: null,
            receipt_revision: null,
          });
      for (let i = 0; i < 150; i += 1)
        effects.push({
          resource_id: `zz-unrelated-${i}`,
          local_id: `stray-${i}`,
          resource_version: 1,
          created_at: "2026-10-01T09:00:00.000Z",
          submitted_at_page_seq: 0,
          last_mentioned_page_seq: null,
          display: { label: "unrelated" },
          resolved: null,
          no_publication_floor: null,
          receipt_revision: null,
        });
      await store.run(putPlan("pending_effects"), effects);
      const pages: ResourcePage[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page: ResourcePage = await store.run(readResourceList, {
          incarnationId: store.incarnationId,
          kind: "person",
          after,
          limit: 100,
        });
        pages.push(page);
        if (page.next === null) break;
        after = page.next;
      }
      t.deepEqual(
        pages.map((page) => page.rows.length),
        [100, 100, 30],
        "pages of at most 100 and the rest, the last saying there is no more",
      );
      const listed = pages.flatMap((page) => page.rows);
      t.deepEqual(
        listed.map((row) => row.base.id),
        ids,
        "every row once, in order, none of another kind",
      );
      let exact = true;
      for (const row of listed) {
        const own = effects.filter(
          (effect) => effect.resource_id === row.base.id,
        );
        const merged = mergeResource(row.base, own).merged;
        if (
          JSON.stringify(Object.entries(row.merged).sort()) !==
            JSON.stringify(Object.entries(merged ?? {}).sort()) ||
          row.pending !== own.length
        ) {
          exact = false;
          t.ok(false, `${row.base.id}: the overlay is the sequential merge`);
        }
      }
      t.ok(
        exact,
        "every resource shows exactly what the sequential merge gives, and counts every change over it",
      );
    },
  },
];

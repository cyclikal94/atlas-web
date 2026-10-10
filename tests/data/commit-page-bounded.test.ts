// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { type Mention, reconcilePage } from "../../src/data/model/reconcile";
import type {
  DraftWithCommand,
  PendingEffectRow,
  ResourceVersionRow,
} from "../../src/data/model/types";
import { outboxWorld } from "../support/data/outbox-world";
import {
  byKey,
  expected,
  type State,
} from "../support/data/reconcile-reference";
import { draftRow, effectRow, headerOf } from "../support/data/rows";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * R6 (revision 6): what a delta page holds at once is bounded by the working set, whatever the queue and whatever the page names.
 *
 * `reads.maxBatch` is the most rows ONE read call returned, per store: the double's measure of what a plan has in hand together. The
 * cumulative `reads.rows` says how much was read in all. The queues here are built the way the product builds them, through the
 * public `outbox.enqueue` (which tracks a version per version-checked target), plus the settled-receipt shapes (effects, acknowledged
 * drafts) that only a dispatcher run produces, seeded directly. FIXTURE evidence: fake world, no backend, and a heap or an
 * out-of-memory limit is not measured (the read counts say what is held, not what it costs).
 */
const WORKING_SET = DATA_CONFIG.queueWorkingSet;

const create = (id: string, padding = 0): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
      seedIfUntracked: 1,
    },
  ],
  build: () => ({ command: { kind: "create", id, pad: "x".repeat(padding) } }),
});

const upsert = (id: string, version: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(version), version), id, version },
});
const page = (
  changes: PageSpec["batches"][number]["changes"],
  over: Partial<PageSpec> = {},
): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: "cursor-1",
  batches: [{ revision: 7, changes }],
  ...over,
});

const LISTS = ["pending_effects", "resource_versions", "drafts"] as const;
const peaks = (w: Awaited<ReturnType<typeof outboxWorld>>) =>
  Object.fromEntries(
    LISTS.map((s) => [s, w.env.idb.reads.maxBatch.get(s) ?? 0]),
  );

async function enqueued(count: number, padding = 0) {
  const w = await outboxWorld();
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(uuid(i + 1));
    const out = await w.outbox.enqueue(create(uuid(i + 1), padding));
    expect(out.kind).toBe("queued");
  }
  return { w, ids };
}

describe("a page over a queue built by public enqueues", () => {
  test("an EMPTY page reads none of the 350 tracked versions or drafts (the reviewer's reproduction)", async () => {
    const { w } = await enqueued(350);
    expect(w.rows("resource_versions")).toHaveLength(350);
    w.env.idb.reads.reset();
    const out = await w.commit(w.input(page([])));
    expect(out.kind).toBe("applied");
    expect(w.env.idb.reads.rows.get("resource_versions") ?? 0).toBe(0);
    expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBe(0);
    expect(w.env.idb.reads.rows.get("pending_effects") ?? 0).toBe(0);
    expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
  });

  test("a page that names every one of 350 tracked resources: each is reconciled, and no read ever returned more than the working set", async () => {
    const { w, ids } = await enqueued(350);
    w.env.idb.reads.reset();
    const out = await w.commit(w.input(page(ids.map((id) => upsert(id, 9)))));
    expect(out.kind).toBe("applied");
    // Every queued draft stands on its resource, so every version stays, and follows the server (9 > 1).
    const versions = w.rows("resource_versions") as Array<{
      resource_id: string;
      locally_assumed_version: number;
    }>;
    expect(versions).toHaveLength(350);
    expect(new Set(versions.map((v) => v.locally_assumed_version))).toEqual(
      new Set([9]),
    );
    expect(w.rows("drafts")).toHaveLength(350);
    expect(w.cache()).toHaveLength(350);
    for (const store of LISTS)
      expect(peaks(w)[store], store).toBeLessThanOrEqual(WORKING_SET);
    // No body was read: a page never reads a command.
    expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    // And nothing was read beyond what the 350 names needed: a header each, and a version each twice (the lookup that finds that the id
    // has local work, which keeps no row, and the window that reconciles it).
    expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBeLessThanOrEqual(350);
    expect(w.env.idb.reads.rows.get("resource_versions") ?? 0).toBe(2 * 350);
  });

  test("the same page at a window of 7: the same result, and nothing larger than 7 in hand", async () => {
    const { w, ids } = await enqueued(60);
    w.env.idb.reads.reset();
    const out = await w.commit(
      w.input(page(ids.map((id) => upsert(id, 4))), { reconcileWindow: 7 }),
    );
    expect(out.kind).toBe("applied");
    expect(
      (
        w.rows("resource_versions") as Array<{
          locally_assumed_version: number;
        }>
      ).every((v) => v.locally_assumed_version === 4),
    ).toBe(true);
    for (const store of LISTS)
      expect(peaks(w)[store], store).toBeLessThanOrEqual(7);
  });

  test("a page that names half of them leaves the other half exactly as it was", async () => {
    const { w, ids } = await enqueued(200);
    const before = structuredClone(w.rows("resource_versions"));
    const named = ids.filter((_, i) => i % 2 === 0);
    const out = await w.commit(w.input(page(named.map((id) => upsert(id, 5)))));
    expect(out.kind).toBe("applied");
    const after = w.rows("resource_versions") as Array<{
      resource_id: string;
      locally_assumed_version: number;
    }>;
    const unnamed = new Set(ids.filter((_, i) => i % 2 === 1));
    expect(after.filter((v) => unnamed.has(v.resource_id))).toEqual(
      (before as typeof after).filter((v) => unnamed.has(v.resource_id)),
    );
    expect(
      after
        .filter((v) => !unnamed.has(v.resource_id))
        .every((v) => v.locally_assumed_version === 5),
    ).toBe(true);
  });

  test("retained conflicts keep their tracked versions, however many of them the page names", async () => {
    const { w, ids } = await enqueued(250);
    // Every draft is now a retained conflict: still outstanding (a person has yet to decide), so its version must stay.
    const drafts = w.rows("drafts") as Array<Record<string, unknown>>;
    w.put(
      "drafts",
      drafts.map((d) => ({ ...d, status: "version_conflict" })) as never,
    );
    w.env.idb.reads.reset();
    const out = await w.commit(w.input(page(ids.map((id) => upsert(id, 3)))));
    expect(out.kind).toBe("applied");
    expect(w.rows("resource_versions")).toHaveLength(250);
    expect(w.rows("drafts")).toHaveLength(250);
    for (const store of LISTS)
      expect(peaks(w)[store], store).toBeLessThanOrEqual(WORKING_SET);
  });

  test("large import bodies are never read by a page, whatever it names (200 x 64 KiB)", async () => {
    const { w, ids } = await enqueued(200, 64 * 1024);
    w.env.idb.measureBytes = true;
    w.env.idb.reads.reset();
    const out = await w.commit(w.input(page(ids.map((id) => upsert(id, 2)))));
    expect(out.kind).toBe("applied");
    expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    expect(w.env.idb.reads.bytes.get("draft_commands") ?? 0).toBe(0);
    // A header is small: what was read of the drafts is a tiny fraction of the bodies' 12.8 MiB.
    expect(w.env.idb.reads.bytes.get("drafts") ?? 0).toBeLessThan(
      2 * 1024 * 1024,
    );
  });

  test("many drafts on ONE resource: the outstanding question is asked a window of headers at a time", async () => {
    const w = await outboxWorld();
    for (let i = 0; i < 250; i += 1) {
      const out = await w.outbox.enqueue({
        ...create("shared"),
        targets: [
          {
            resourceId: uuid(5000),
            role: "primary",
            basis: "resource",
            versionChecked: true,
            seedIfUntracked: 1,
          },
        ],
        build: () => ({ command: { kind: "edit", n: i } }),
      });
      expect(out.kind).toBe("queued");
    }
    w.env.idb.reads.reset();
    const out = await w.commit(w.input(page([upsert(uuid(5000), 6)])));
    expect(out.kind).toBe("applied");
    expect(peaks(w).drafts).toBeLessThanOrEqual(WORKING_SET);
    // The version stays: 250 drafts are standing on it.
    expect(w.rows("resource_versions")).toHaveLength(1);
  });
});

describe("a final page over settled receipts: the live edge visits every effect, a window at a time", () => {
  /** 350 acknowledged drafts, each with a receipt effect still showing its overlay, awaiting publication. */
  async function receipts(count: number, floor: number | null) {
    const w = await outboxWorld();
    const drafts = [];
    const effects = [];
    for (let i = 0; i < count; i += 1) {
      const draft = draftRow({
        local_id: `d-${String(i).padStart(4, "0")}`,
        status: "acknowledged",
        held_pending_cache: true,
        created_seq: i + 1,
      });
      drafts.push(draft);
      effects.push(
        effectRow({
          resource_id: uuid(i + 1),
          local_id: draft.local_id,
          display: { label: `shown ${i}` },
          no_publication_floor: floor,
        }),
      );
    }
    w.put("drafts", drafts as never);
    w.put("pending_effects", effects as never);
    return w;
  }

  test("every unmentioned receipt older than the request is resolved as unavailable, nothing larger than the working set is ever in hand", async () => {
    const w = await receipts(350, 0);
    w.env.idb.reads.reset();
    // A final page that names none of them, from a request captured after every receipt (request_seq 1 > floor 0).
    w.setSync({ request_seq: 1 });
    const out = await w.commit(
      w.input(page([]), { captured: w.capture({ requestSeq: 1 }) }),
    );
    expect(out.kind).toBe("applied");
    const effects = w.rows("pending_effects") as Array<{
      resolved: string | null;
      display: unknown;
    }>;
    // Resolved, and retained for the person to see (the drafts carry `unavailable_outcome`): nothing was dropped.
    expect(effects).toHaveLength(350);
    expect(effects.every((e) => e.resolved === "no_publication")).toBe(true);
    expect(effects.every((e) => e.display === null)).toBe(true);
    expect(
      (w.rows("drafts") as Array<{ unavailable_outcome: boolean }>).every(
        (d) => d.unavailable_outcome,
      ),
    ).toBe(true);
    for (const store of LISTS)
      expect(peaks(w)[store], store).toBeLessThanOrEqual(WORKING_SET);
  });

  test("a page that is NOT final reads only the effects of the ids it names", async () => {
    const w = await receipts(350, 0);
    w.env.idb.reads.reset();
    const out = await w.commit(
      w.input(
        page([upsert(uuid(1), 2), upsert(uuid(2), 2)], { hasMore: true }),
        { captured: w.capture({ requestSeq: 1 }) },
      ),
    );
    expect(out.kind).toBe("applied");
    // A handful of effect rows were read (each named id's, to find it, to reconcile it, and its owner's, to see whether the draft may
    // leave), and released: not the 350.
    expect(
      w.env.idb.reads.rows.get("pending_effects") ?? 0,
    ).toBeLessThanOrEqual(8);
    // The two named receipts are released and, their drafts having nothing more to wait for, leave; the other 348 are untouched.
    expect(w.rows("pending_effects")).toHaveLength(348);
    expect(w.rows("drafts")).toHaveLength(348);
  });
});

describe("the page stays ATOMIC across windows", () => {
  test("a failure in the middle of the reconciliation rolls back the cache, the cursor and every window already written", async () => {
    const { w, ids } = await enqueued(40);
    const cursor = w.sync().cursor;
    const versions = structuredClone(w.rows("resource_versions"));
    // Fail one of the late writes of the page (after several windows were written).
    w.env.idb.inject({
      match: (tx) => tx.label === "data.commitPage",
      mode: { kind: "throw_on_write", n: 20, as: "error" },
      times: 1,
    });
    const out = await w
      .commit(
        w.input(
          page(
            ids.map((id) => upsert(id, 8)),
            { nextCursor: "cursor-2" },
          ),
          {
            reconcileWindow: 3,
          },
        ),
      )
      .catch((error: unknown) => error);
    expect((out as { kind?: string }).kind).not.toBe("applied");
    expect(w.sync().cursor).toBe(cursor);
    expect(w.cache()).toHaveLength(0);
    expect(w.rows("resource_versions")).toEqual(versions);
    // The same page, requested again, then lands whole.
    const again = await w.commit(
      w.input(
        page(
          ids.map((id) => upsert(id, 8)),
          { nextCursor: "cursor-2" },
        ),
        {
          reconcileWindow: 3,
        },
      ),
    );
    expect(again.kind).toBe("applied");
    expect(w.sync().cursor).toBe("cursor-2");
    expect(w.cache()).toHaveLength(40);
  });
});

describe("R6 (revision 7): ONE resource with hundreds of receipt effects (the initial lookup, then every later window)", () => {
  const SHARED = uuid(777);
  const key = (e: PendingEffectRow): string =>
    JSON.stringify([e.resource_id, e.local_id]);

  /**
   * `count` acknowledged drafts, each with a receipt effect on the SAME resource that still shows its overlay (the population that
   * arises when many acknowledged operations touch one resource before a sync page reconciles their effects), plus `others` resources
   * with one such draft each. With `tracked`, the shared resource also has a tracked version (the lookup then finds it without asking
   * about its effects); without it, the effects are the ONLY local work the lookup can find for it, which is the reviewer's population.
   */
  async function population(
    count: number,
    others: number,
    floor: number | null,
    tracked = false,
  ) {
    const w = await outboxWorld();
    const drafts: DraftWithCommand[] = [];
    const effects: PendingEffectRow[] = [];
    const total = count + others;
    for (let i = 0; i < total; i += 1) {
      const draft = draftRow({
        local_id: `d-${String(i).padStart(4, "0")}`,
        status: "acknowledged",
        held_pending_cache: true,
        index_targets: [i < count ? SHARED : uuid(900 + i)],
        created_seq: i + 1,
      });
      drafts.push(draft);
      effects.push(
        effectRow({
          resource_id: i < count ? SHARED : uuid(900 + i),
          local_id: draft.local_id,
          display: { label: `shown ${i}` },
          no_publication_floor: floor,
        }),
      );
    }
    const versions: ResourceVersionRow[] = tracked
      ? [{ resource_id: SHARED, locally_assumed_version: 1, basis: "resource" }]
      : [];
    w.put("drafts", drafts as never);
    w.put("pending_effects", effects as never);
    w.put("resource_versions", versions as never);
    return { w, drafts, effects, versions, others: total - count };
  }

  /** What the whole-population function says the page leaves, from the rows as they were before it. */
  function reference(
    before: State,
    named: ReadonlyMap<string, Mention>,
    facts: { pageSeq: number; hasMore: boolean; requestSeq: number | null },
  ) {
    const reconciled = reconcilePage({
      effects: byKey(before.effects, key),
      versions: before.versions,
      drafts: before.drafts.map(headerOf),
      mentions: named,
      facts,
    });
    return { want: expected(before, reconciled), reconciled };
  }

  const finalRows = (w: Awaited<ReturnType<typeof population>>["w"]) => ({
    effects: byKey(w.rows("pending_effects") as PendingEffectRow[], key),
    drafts: byKey(
      w.rows("drafts") as ReturnType<typeof headerOf>[],
      (d) => d.local_id,
    ),
    bodies: (w.rows("draft_commands") as Array<{ local_id: string }>)
      .map((b) => b.local_id)
      .sort(),
    versions: byKey(
      w.rows("resource_versions") as ResourceVersionRow[],
      (v) => v.resource_id,
    ),
  });

  const peak = (
    w: Awaited<ReturnType<typeof population>>["w"],
    store: string,
  ): number => w.env.idb.reads.maxBatch.get(store) ?? 0;

  for (const hasMore of [true, false])
    for (const tracked of [false, true])
      test(`a ${hasMore ? "NON-FINAL" : "FINAL"} page, the shared resource ${tracked ? "with" : "WITHOUT"} a tracked version, that names it and 150 others: every effect is reconciled as the whole-population function says, and no read of any store returned more than the working set`, async () => {
        const { w, drafts, effects, versions, others } = await population(
          350,
          150,
          0,
          tracked,
        );
        expect(others).toBe(150);
        const named = new Map<string, Mention>([
          [SHARED, { removed: false, version: 4 }],
          ...effects
            .filter((e) => e.resource_id !== SHARED)
            .map(
              (e) => [e.resource_id, { removed: false, version: 2 }] as const,
            ),
        ]);
        w.setSync({ request_seq: 1 });
        const specChanges = [
          upsert(SHARED, 4),
          ...effects
            .filter((e) => e.resource_id !== SHARED)
            .map((e) => upsert(e.resource_id, 2)),
        ];
        w.env.idb.reads.reset();
        const out = await w.commit(
          w.input(page(specChanges, { hasMore }), {
            captured: w.capture({ requestSeq: 1 }),
          }),
        );
        expect(out.kind).toBe("applied");
        const pageSeq = (out as { value: { pageSeq: number } }).value.pageSeq;
        const { want } = reference({ effects, versions, drafts }, named, {
          pageSeq,
          hasMore,
          requestSeq: 1,
        });
        expect(finalRows(w)).toEqual(want);
        for (const store of LISTS)
          expect(peak(w, store), store).toBeLessThanOrEqual(WORKING_SET);
        // The shared resource's 350 effects are not all in hand at once, in the lookup or in any later window.
        expect(peak(w, "pending_effects")).toBeLessThanOrEqual(WORKING_SET);
        w.assertNoOrphanBodies();
      });

  test("the same pages at a window of 7: the same rows, and nothing larger than 7 in hand, the lookup included", async () => {
    for (const [hasMore, tracked] of [
      [true, false],
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const { w, drafts, effects, versions } = await population(
        60,
        20,
        0,
        tracked,
      );
      const named = new Map<string, Mention>([
        [SHARED, { removed: false, version: 4 }],
      ]);
      w.setSync({ request_seq: 1 });
      w.env.idb.reads.reset();
      const out = await w.commit(
        w.input(page([upsert(SHARED, 4)], { hasMore }), {
          captured: w.capture({ requestSeq: 1 }),
          reconcileWindow: 7,
        }),
      );
      expect(out.kind).toBe("applied");
      const pageSeq = (out as { value: { pageSeq: number } }).value.pageSeq;
      const { want } = reference({ effects, versions, drafts }, named, {
        pageSeq,
        hasMore,
        requestSeq: 1,
      });
      expect(finalRows(w), `hasMore ${hasMore}, tracked ${tracked}`).toEqual(
        want,
      );
      for (const store of LISTS)
        expect(
          peak(w, store),
          `${store}, hasMore ${hasMore}, tracked ${tracked}`,
        ).toBeLessThanOrEqual(7);
    }
  });

  test("a page that names only OTHER resources leaves the shared resource's 350 effects untouched, and reads none of them", async () => {
    const { w, effects } = await population(350, 5, 0);
    const before = structuredClone(
      effects.filter((e) => e.resource_id === SHARED),
    );
    const other = effects.find(
      (e) => e.resource_id !== SHARED,
    ) as PendingEffectRow;
    w.env.idb.reads.reset();
    const out = await w.commit(
      w.input(page([upsert(other.resource_id, 2)], { hasMore: true }), {
        captured: w.capture({ requestSeq: 1 }),
      }),
    );
    expect(out.kind).toBe("applied");
    const after = (w.rows("pending_effects") as PendingEffectRow[]).filter(
      (e) => e.resource_id === SHARED,
    );
    expect(byKey(after, key)).toEqual(byKey(before, key));
    // Only the named resource's effect (and its owner) were read: not the 350.
    expect(
      w.env.idb.reads.rows.get("pending_effects") ?? 0,
    ).toBeLessThanOrEqual(4);
  });

  test("an EMPTY final page over the 350 effects walks them a window at a time and resolves every one (nothing capped, nothing dropped)", async () => {
    const { w } = await population(350, 0, 0);
    w.setSync({ request_seq: 1 });
    w.env.idb.reads.reset();
    const out = await w.commit(
      w.input(page([]), { captured: w.capture({ requestSeq: 1 }) }),
    );
    expect(out.kind).toBe("applied");
    const effects = w.rows("pending_effects") as PendingEffectRow[];
    expect(effects).toHaveLength(350);
    expect(effects.every((e) => e.resolved === "no_publication")).toBe(true);
    for (const store of LISTS)
      expect(peak(w, store), store).toBeLessThanOrEqual(WORKING_SET);
  });

  for (const hasMore of [true, false])
    test(`a failure in the middle of the ${hasMore ? "non-final" : "final"} page's reconciliation rolls back EVERYTHING: the 350 effects, the drafts, the version, the cursor and the cache, and the same page then lands whole`, async () => {
      const { w, drafts, effects, versions } = await population(350, 0, 0);
      const cursor = w.sync().cursor;
      const before = structuredClone(finalRows(w));
      w.setSync({ request_seq: 1 });
      w.env.idb.inject({
        match: (tx) => tx.label === "data.commitPage",
        mode: { kind: "throw_on_write", n: 6, as: "error" },
        times: 1,
      });
      const failed = await w
        .commit(
          w.input(
            page([upsert(SHARED, 4)], { hasMore, nextCursor: "cursor-2" }),
            {
              captured: w.capture({ requestSeq: 1 }),
              reconcileWindow: 25,
            },
          ),
        )
        .catch((error: unknown) => error);
      expect((failed as { kind?: string }).kind).not.toBe("applied");
      expect(w.sync().cursor).toBe(cursor);
      expect(w.cache()).toHaveLength(0);
      expect(finalRows(w)).toEqual(before);
      // Requested again, the page lands whole and equals the reference.
      const again = await w.commit(
        w.input(
          page([upsert(SHARED, 4)], { hasMore, nextCursor: "cursor-2" }),
          {
            captured: w.capture({ requestSeq: 1 }),
            reconcileWindow: 25,
          },
        ),
      );
      expect(again.kind).toBe("applied");
      const pageSeq = (again as { value: { pageSeq: number } }).value.pageSeq;
      const { want } = reference(
        { effects, versions, drafts },
        new Map<string, Mention>([[SHARED, { removed: false, version: 4 }]]),
        { pageSeq, hasMore, requestSeq: 1 },
      );
      expect(finalRows(w)).toEqual(want);
      expect(w.sync().cursor).toBe("cursor-2");
    });
});

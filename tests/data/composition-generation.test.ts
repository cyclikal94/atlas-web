// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { publishEpochPlan } from "../../src/data/plans/epoch";
import { setClosing } from "../../src/data/plans/fence";
import { readLocalBasis } from "../../src/data/plans/outstanding-reads";
import { reconcileOwedReceipts } from "../../src/data/plans/recovery-writers";
import { invalidateRecoveryPosition } from "../../src/data/plans/sync-writers";
import { type Plan, PlanRejected, w as write } from "../../src/data/store/port";
import { outboxWorld } from "../support/data/outbox-world";
import { pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * WEB-10a revision 3 (R9; design assessment C3, schedules Q12, Q15): the LOCAL COMPOSITION GENERATION. The store advances
 * `sync_state.composition_seq` in the SAME transaction as every write to `cache`, `pending_effects`, `drafts` or `draft_commands`, once
 * per transaction, after the plan's writes; a transaction that writes none of them, or commits nothing, leaves it alone. A view that reads
 * the generation before and after several reads can then prove that none of those writes committed between them. These run over the
 * double; the Dexie adapter does the same and is checked in the real engines (fixture.data-composition.spec.ts).
 */
const gen = (sync: { composition_seq?: number }): number =>
  sync.composition_seq ?? 0;

const edit = (id: string, n = 1): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: { kind: "edit", id, base: bases[id] as number, n },
  }),
});

const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});

/** A raw plan over `scope` that streams `rows` drafts (none: an empty bulk write) and may refuse after writing. */
const rawDrafts = (
  scope: Plan<null, null, null>["scope"],
  rows: number,
  refuse = false,
): Plan<null, null, null> => ({
  name: "test.rawDrafts",
  scope,
  mode: "readwrite",
  durability: "strict",
  read: async () => null,
  decide: () => ({ writes: [], result: null }),
  async apply(sink) {
    await sink.bulkPut(
      "drafts",
      Array.from({ length: rows }, (_, i) =>
        draftRow({ local_id: `raw-${i}`, created_seq: 100 + i }),
      ),
    );
    if (refuse) throw new PlanRejected("test", "refused after writing");
    return null;
  },
});

describe("Q12: every outbox writer that writes a composition store advances the generation, once per transaction", () => {
  test("enqueue, edit of a queued draft and discard each advance it by exactly one", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    const start = gen(w.sync());
    const queued = await w.outbox.enqueue(edit("r"));
    expect(queued.kind).toBe("queued");
    expect(gen(w.sync())).toBe(start + 1);
    const localId = (w.drafts()[0] as { local_id: string }).local_id;
    expect((await w.outbox.editQueued(localId, edit("r", 2))).kind).toBe(
      "edited",
    );
    expect(gen(w.sync())).toBe(start + 2);
    expect((await w.outbox.discard(localId)).kind).toBe("discarded");
    expect(gen(w.sync())).toBe(start + 3);
  });

  test("the epoch mirror and the closing fence (writers of sync_state alone) do not advance it", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    await w.outbox.enqueue(edit("r"));
    const queued = gen(w.sync());
    // Writers of the singleton alone.
    await w.service.store.run(publishEpochPlan, {
      incarnationId: w.service.incarnationId,
      epoch: 9,
    });
    await w.service.store.run(setClosing, {
      incarnationId: w.service.incarnationId,
      now: w.now(),
      token: "closing-token",
    });
    expect(gen(w.sync())).toBe(queued);
    expect(w.sync().draft_fence).not.toBeNull();
  });

  test("a claimed send that is acknowledged advances it at the claim and at the receipt", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    await w.outbox.enqueue(edit("r"));
    const queued = gen(w.sync());
    w.start();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(w.drafts()[0]?.status).toBe("acknowledged");
    expect(gen(w.sync())).toBeGreaterThanOrEqual(queued + 2);
  });

  test("a failed send (retry metadata on the draft) and a version conflict advance it", async () => {
    for (const answer of ["failure", "conflict"] as const) {
      const w = await outboxWorld();
      w.put("cache", [cacheRow({ id: "r", version: 5 })]);
      await w.outbox.enqueue(edit("r"));
      const queued = gen(w.sync());
      w.script.push(
        answer === "failure"
          ? w.error(503, "unavailable")
          : w.error(409, "version_conflict"),
      );
      w.start();
      await w.settle();
      expect(w.sent.length).toBeGreaterThanOrEqual(1);
      expect(gen(w.sync())).toBeGreaterThan(queued);
    }
  });
});

describe("Q12: the store's rule itself (once per transaction, written stores only, nothing from a transaction that commits nothing)", () => {
  test("a streamed write advances it once; an empty bulk write reaches no store and advances nothing", async () => {
    const w = await pageWorld();
    const start = gen(w.sync());
    await w.service.store.run(rawDrafts(["drafts", "sync_state"], 0), null);
    expect(gen(w.sync())).toBe(start);
    await w.service.store.run(rawDrafts(["drafts", "sync_state"], 3), null);
    expect(gen(w.sync())).toBe(start + 1);
    expect(w.rows("drafts")).toHaveLength(3);
  });

  test("a transaction that is refused after writing commits nothing, the generation included", async () => {
    const w = await pageWorld();
    const before = JSON.stringify(w.snapshot());
    await expect(
      w.service.store.run(rawDrafts(["drafts", "sync_state"], 2, true), null),
    ).rejects.toMatchObject({ name: "StoreFailure" });
    expect(JSON.stringify(w.snapshot())).toBe(before);
  });

  test("a plan whose scope does not hold sync_state (a test's raw plan) writes its store and is not refused for it", async () => {
    const w = await pageWorld();
    const start = gen(w.sync());
    await w.service.store.run(rawDrafts(["drafts"], 1), null);
    expect(w.rows("drafts")).toHaveLength(1);
    expect(gen(w.sync())).toBe(start);
  });

  test("the local basis read reports the generation with the incarnation, cache status and content revision", async () => {
    const w = await pageWorld();
    await w.service.store.run(rawDrafts(["drafts", "sync_state"], 1), null);
    expect(
      await w.service.store.run(readLocalBasis, {
        incarnationId: w.service.incarnationId,
      }),
    ).toEqual({
      incarnationId: w.service.incarnationId,
      composition: gen(w.sync()),
      cacheStatus: w.sync().cache_status,
      recoveryGeneration: w.sync().recovery_generation,
      appliedRevision: w.sync().applied_revision,
    });
  });
});

describe("Q12/Q15: sync pages, invalidation and reconciliation after recovery", () => {
  test("a page with changes advances it; an empty delta page (no change, nothing to reconcile) does not, though page_seq moves", async () => {
    const w = await pageWorld({ cursor: "c-0", phase: "delta" });
    const start = gen(w.sync());
    const empty = await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "c-1",
        batches: [],
      }),
    );
    expect(empty.kind).toBe("applied");
    expect(w.sync().page_seq).toBe(1);
    expect(gen(w.sync())).toBe(start);
    const full = await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "c-2",
        batches: [{ revision: 3, changes: [upsert(1)] }],
      }),
    );
    expect(full.kind).toBe("applied");
    expect(gen(w.sync())).toBe(start + 1);
  });

  test("an invalidation that drops overlay displays advances it; W26 reconciliation advances it only when it reconciled", async () => {
    const w = await pageWorld({ cursor: "c-0", phase: "delta" });
    w.put("drafts", [
      draftRow({
        local_id: "acked",
        status: "acknowledged",
        held_pending_cache: true,
        receipt_revision: 5,
      }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: uuid(1),
        local_id: "acked",
        receipt_revision: 5,
        no_publication_floor: 0,
        display: { label: "sent" },
      }),
    ]);
    const start = gen(w.sync());
    expect(
      await w.service.commit(reconcileOwedReceipts, { captured: w.capture() }),
    ).toEqual({ kind: "applied", value: { kind: "none" } });
    expect(gen(w.sync())).toBe(start);
    const recovered = await w.commit(
      w.input(
        {
          phase: "delta",
          hasMore: false,
          nextCursor: "c-1",
          batches: [{ revision: 7, changes: [upsert(1)] }],
        },
        { mode: "recovery" },
      ),
    );
    expect(recovered.kind).toBe("applied");
    const afterRecovery = gen(w.sync());
    expect(afterRecovery).toBe(start + 1);
    expect(
      await w.service.commit(reconcileOwedReceipts, { captured: w.capture() }),
    ).toMatchObject({ kind: "applied", value: { kind: "reconciled" } });
    expect(gen(w.sync())).toBe(afterRecovery + 1);

    w.put("pending_effects", [
      effectRow({
        resource_id: uuid(2),
        local_id: "other",
        display: { label: "shown" },
      }),
    ]);
    const beforeInvalidation = gen(w.sync());
    const invalidated = await w.service.commit(invalidateRecoveryPosition, {
      captured: w.capture(),
      reason: "resync_required",
      window: 7,
    });
    expect(invalidated.kind).toBe("applied");
    expect(gen(w.sync())).toBe(beforeInvalidation + 1);
  });

  test("a writer that is dropped by its guards (another binding) writes nothing and advances nothing", async () => {
    const w = await pageWorld({ cursor: "c-0", phase: "delta" });
    w.setSync({ recovery_reconcile_pending: true });
    const before = JSON.stringify(w.snapshot());
    expect(
      await w.service.commit(reconcileOwedReceipts, {
        captured: w.capture({ ownershipToken: "another-binding" }),
      }),
    ).toEqual({ kind: "dropped", reason: "owner" });
    expect(JSON.stringify(w.snapshot())).toBe(before);
    void write;
  });
});

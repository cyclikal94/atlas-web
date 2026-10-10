// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { PendingEffectRow } from "../../src/data/model/types";
import { invalidateRecoveryPosition } from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import { type PageWorld, pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R11 (revision 8): the ordinary invalidation no longer reads every pending effect at once.
 *
 * `invalidateRecoveryPosition` read the whole store of pending effects (display patches included) and built whole-population arrays to
 * clear the overlays, so what it held grew with the retained queue (the third review: 350 retained acknowledged drafts and their
 * receipt effects on one resource, one pending-effect read of 350 rows against `queueWorkingSet = 100`). It now walks the effects in
 * windows inside the SAME transaction, clearing each window's overlays through the transaction's own sink.
 *
 * These run the PRODUCTION plan and engine over the double of IndexedDB, which counts the largest batch every read returned. The
 * evidence is a read-size counter and source inspection, not a heap measurement. Nothing is capped or dropped.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;

type Effects = PendingEffectRow[];

/** Retained acknowledged drafts and their receipt effects; `display` patches on every `showing`-th one. */
function population(
  n: number,
  options: { resources: number; showing: (index: number) => boolean },
): { drafts: ReturnType<typeof draftRow>[]; effects: Effects } {
  const drafts = [];
  const effects: Effects = [];
  for (let i = 0; i < n; i += 1) {
    const local_id = `d-${String(i).padStart(5, "0")}`;
    drafts.push(
      draftRow({
        local_id,
        status: "acknowledged",
        held_pending_cache: true,
        created_seq: i + 1,
      }),
    );
    effects.push(
      effectRow({
        resource_id: uuid(9 + (i % options.resources)),
        local_id,
        display: options.showing(i) ? { label: `overlay ${i}` } : null,
      }),
    );
  }
  return { drafts, effects };
}

/** What the whole-population function would leave: every effect with its display dropped, nothing else changed. */
const cleared = (effects: Effects): Effects =>
  effects.map((row) => ({ ...row, display: null }));
const byKey = (a: PendingEffectRow, b: PendingEffectRow): number =>
  `${a.resource_id}/${a.local_id}`.localeCompare(
    `${b.resource_id}/${b.local_id}`,
  );

async function invalidateOnce(
  w: PageWorld,
  window: number | undefined,
): Promise<{ peak: number; result: unknown }> {
  w.env.idb.reads.reset();
  const out = await w.service.commit(invalidateRecoveryPosition, {
    captured: w.capture(),
    reason: "resync_required",
    ...(window === undefined ? {} : { window }),
  });
  await w.env.settle();
  expect(out.kind).toBe("applied");
  return {
    peak: w.env.idb.reads.maxBatch.get("pending_effects") ?? 0,
    result: out.kind === "applied" ? out.value : null,
  };
}

describe("the review's population: 350 retained acknowledged drafts and receipt effects on ONE resource", () => {
  test("an ordinary 410 invalidates, retains every draft and effect, and no pending-effect read exceeds the working set", async () => {
    const w = await engineWorld();
    const { drafts, effects } = population(350, {
      resources: 1,
      showing: () => true,
    });
    w.put("drafts", drafts);
    w.put("pending_effects", effects);
    w.env.idb.reads.reset();
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.sync().cache_status).toBe("invalid");
    expect(w.rows("drafts")).toHaveLength(350);
    const peak = w.env.idb.reads.maxBatch.get("pending_effects") ?? 0;
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(WINDOW);
    const after = w.rows("pending_effects") as Effects;
    expect(after).toHaveLength(350);
    expect(after.every((row) => row.display === null)).toBe(true);
    w.engine.stop();
  });
});

describe("the final state is the whole-population function's, at every window and population", () => {
  const SIZES = [0, 1, 2, 6, 7, 8, 99, 100, 101, 250, 301] as const;
  const WINDOWS = [1, 2, 3, 7, 100] as const;
  for (const window of WINDOWS)
    for (const size of SIZES) {
      // One heavy resource, and many; a third of the effects show an overlay, and one population shows all of them.
      for (const shape of [
        { resources: 1, showing: (i: number) => i % 3 === 0 },
        { resources: 7, showing: (i: number) => i % 3 !== 1 },
        { resources: 1, showing: () => true },
        { resources: 5, showing: () => false },
      ]) {
        test(`window ${window}, ${size} effects, ${shape.resources} resource(s): every overlay dropped, every row kept, no read above the window`, async () => {
          const w = await pageWorld();
          const { drafts, effects } = population(size, shape);
          w.put("cache", [cacheRow({ id: uuid(5) })]);
          w.put("drafts", drafts);
          w.put("pending_effects", effects);
          const expected = cleared(effects).sort(byKey);
          const { peak, result } = await invalidateOnce(w, window);
          expect(peak).toBeLessThanOrEqual(window);
          const rows = (w.rows("pending_effects") as Effects).sort(byKey);
          expect(rows).toEqual(expected);
          expect(w.rows("drafts")).toHaveLength(size);
          expect(w.cache()).toHaveLength(1);
          expect(w.sync()).toMatchObject({
            cache_status: "invalid",
            cursor: null,
            staging_position: null,
          });
          expect(result).toMatchObject({
            reason: "resync_required",
            overlaysDropped: effects.filter((row) => row.display !== null)
              .length,
          });
        });
      }
    }
});

describe("it is atomic: a failure anywhere in the walk leaves the cache, the position and every overlay as they were", () => {
  for (const as of ["error", "quota"] as const)
    test(`a write that fails part-way through the walk (${as}) rolls the whole invalidation back, and the same invalidation then lands whole`, async () => {
      const w = await pageWorld();
      const { drafts, effects } = population(250, {
        resources: 3,
        showing: (i) => i % 2 === 0,
      });
      w.put("cache", [cacheRow({ id: uuid(5) })]);
      w.put("drafts", drafts);
      w.put("pending_effects", effects);
      const before = JSON.stringify(w.snapshot());
      const syncBefore = w.sync();
      // The 2nd write of the transaction: the staging clear is the first, so this one is inside the windowed walk.
      w.env.idb.inject({
        match: (tx) => tx.label === "data.invalidateCache",
        mode: { kind: "throw_on_write", n: 3, as },
        times: 1,
      });
      const failed = await w.service.commit(invalidateRecoveryPosition, {
        captured: w.capture(),
        reason: "resync_required",
        window: 7,
      });
      await w.env.settle();
      expect(failed.kind).toBe("failed");
      expect(JSON.stringify(w.snapshot())).toBe(before);
      expect(w.sync()).toEqual(syncBefore);
      expect(w.sync().cache_status).toBe("valid");
      // The retry lands whole.
      const { peak } = await invalidateOnce(w, 7);
      expect(peak).toBeLessThanOrEqual(7);
      expect(
        (w.rows("pending_effects") as Effects).every(
          (row) => row.display === null,
        ),
      ).toBe(true);
      expect(w.rows("pending_effects")).toHaveLength(250);
      expect(w.sync().cache_status).toBe("invalid");
    });
});

describe("it still drops what a stale invalidating response must not apply", () => {
  test("a position that moved on drops the whole invalidation: nothing is read for it, nothing is written", async () => {
    const w = await pageWorld({ cursor: "cursor-0" });
    const { drafts, effects } = population(30, {
      resources: 2,
      showing: () => true,
    });
    w.put("drafts", drafts);
    w.put("pending_effects", effects);
    const stale = w.capture();
    w.setSync({ cursor: "cursor-9" });
    const before = JSON.stringify(w.snapshot());
    const out = await w.service.commit(invalidateRecoveryPosition, {
      captured: stale,
      reason: "resync_required",
    });
    await w.env.settle();
    expect(out).toMatchObject({ kind: "dropped", reason: "position" });
    expect(JSON.stringify(w.snapshot())).toBe(before);
    expect(w.sync().cache_status).toBe("valid");
  });

  test("a superseded generation drops it too", async () => {
    const w = await pageWorld({ cursor: "cursor-0" });
    const { effects } = population(10, { resources: 1, showing: () => true });
    w.put("pending_effects", effects);
    const stale = w.capture();
    w.setSync({ recovery_generation: w.sync().recovery_generation + 1 });
    const out = await w.service.commit(invalidateRecoveryPosition, {
      captured: stale,
      reason: "resync_required",
    });
    await w.env.settle();
    expect(out).toMatchObject({ kind: "dropped", reason: "generation" });
    expect(w.sync().cache_status).toBe("valid");
    expect(
      (w.rows("pending_effects") as Effects).every(
        (row) => row.display !== null,
      ),
    ).toBe(true);
  });
});

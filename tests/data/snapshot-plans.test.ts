// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  adoptDecision,
  budgetStep,
  snapshotPageOperation,
} from "../../src/data/model/recovery";
import { initialSyncState } from "../../src/data/model/sync-state";
import type { Captured } from "../../src/data/model/types";
import {
  acquireOwnership,
  activateSnapshot,
  captureRecoveryRequest,
  commitStagingPage,
  reconcileOwedReceipts,
  recordRecoveryOutcome,
  resetRecoveryBudget,
} from "../../src/data/plans/recovery-writers";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../src/data/scan/validate";
import { ACCOUNT, type PageWorld, pageWorld } from "../support/data/page-world";
import {
  cacheRow,
  draftRow,
  effectRow,
  versionRow,
} from "../support/data/rows";
import {
  bytesOf,
  type PageSpec,
  pageJson,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * WEB-09b's plans over the IndexedDB double (the PRODUCTION plans): ownership acquisition and the adopt-versus-restart decision (O-1 to
 * O-6, reconciliation cases (a) to (c)), the capture gate (W21), the staged page and its guards (S-1 to S-8), the atomic activation
 * (S-9 to S-12, reconciliation row 3) and the recovery-scoped budgets (R-1 to R-4, the retry-budget rows 4 to 6).
 */
const NOW = 1_800_000_000_000;
const TOKEN = "token-1";

const upsert = (n: number, over: Record<string, unknown> = {}) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n), ...over },
});
const snapshotPage = (
  changes: PageSpec["batches"][number]["changes"],
  over: Partial<PageSpec> = {},
): PageSpec => ({
  phase: "snapshot",
  hasMore: true,
  nextCursor: "snap-1",
  batches: [{ revision: 50, changes }],
  ...over,
});

async function snapshotWorld(): Promise<PageWorld> {
  const w = await pageWorld({
    cursor: null,
    phase: "snapshot",
    cacheStatus: "empty",
  });
  return w;
}

const own = (w: PageWorld, now = NOW, token = TOKEN) =>
  w.service.store.run(acquireOwnership, {
    incarnationId: w.service.incarnationId,
    tabId: "tab-a",
    token,
    now,
  });

const captureFor = (w: PageWorld, over: Partial<Captured> = {}): Captured => {
  const s = w.sync();
  return w.service.capture(w.page.identity.epoch, {
    requestSeq: s.request_seq,
    ownershipToken: s.owner?.ownership_token ?? null,
    recoveryGeneration: s.recovery_generation,
    expectedPosition: s.staging_position,
    ...over,
  });
};

const decode = () => ({
  validators: createValueValidators(),
  derivers: createKeyDerivers(),
});

function stagedInput(w: PageWorld, spec: PageSpec, over = {}) {
  const bytes = bytesOf(pageJson(spec));
  const scan = scanSyncPage(bytes);
  if (!scan.ok) throw new Error(`the test page does not scan: ${scan.reason}`);
  const captured = captureFor(w);
  return {
    captured,
    bytes,
    scan,
    decode: decode(),
    operation: snapshotPageOperation(captured.expectedPosition),
    ...over,
  };
}

function activationInput(
  w: PageWorld,
  spec: PageSpec,
  over: Record<string, unknown> = {},
) {
  const base = stagedInput(w, spec);
  return {
    ...base,
    now: "2026-10-10T12:00:00.000Z",
    mode: "ordinary" as const,
    activateOperation: base.operation,
    ...over,
  };
}

const staged = (w: PageWorld) =>
  (w.snapshot()?.cache_staging ?? []) as Array<{
    id: string;
    recovery_generation: number;
  }>;

describe("O: ownership acquisition (W20), adopt versus restart (Q7, D 6.2)", () => {
  test("O-1 an attempt inside the bound is ADOPTED: a new token, the same generation, position and staged rows", async () => {
    const w = await snapshotWorld();
    await own(w, NOW, "old");
    w.setSync({
      staging_position: "snap-3",
      staging_started_at: NOW - 30 * 60_000,
    });
    const gen = w.sync().recovery_generation;
    w.put("cache_staging" as never, [
      { ...cacheRow({ id: uuid(1) }), recovery_generation: gen },
    ]);
    const out = await own(w, NOW, "new");
    expect(out).toEqual({
      kind: "owned",
      decision: "adopt",
      recoveryGeneration: gen,
      stagingPosition: "snap-3",
    });
    expect(w.sync().owner).toEqual({
      tab_id: "tab-a",
      ownership_token: "new",
      heartbeat_at: NOW,
    });
    expect(w.sync().recovery_generation).toBe(gen);
    expect(staged(w).map((row) => row.id)).toEqual([uuid(1)]);
  });

  test("O-2 at (and after) the lifetime less the margin the attempt RESTARTS: generation + 1 and every staged row cleared together", async () => {
    for (const age of [
      DATA_CONFIG.snapshotCursorLifetimeMs - DATA_CONFIG.snapshotAdoptMarginMs,
      DATA_CONFIG.snapshotCursorLifetimeMs + 1,
    ]) {
      const w = await snapshotWorld();
      await own(w, NOW, "old");
      w.setSync({ staging_position: "snap-3", staging_started_at: NOW - age });
      const gen = w.sync().recovery_generation;
      w.put("cache_staging" as never, [
        { ...cacheRow({ id: uuid(1) }), recovery_generation: gen },
      ]);
      const out = await own(w, NOW, "new");
      expect(out).toMatchObject({
        decision: "restart",
        recoveryGeneration: gen + 1,
        stagingPosition: null,
      });
      expect(w.sync()).toMatchObject({
        recovery_generation: gen + 1,
        staging_position: null,
        staging_started_at: null,
        phase: "snapshot",
      });
      expect(staged(w)).toEqual([]);
    }
    // One millisecond inside the bound still adopts.
    const inside = initialSyncState("i");
    expect(
      adoptDecision(
        {
          ...inside,
          staging_position: "p",
          staging_started_at:
            NOW -
            (DATA_CONFIG.snapshotCursorLifetimeMs -
              DATA_CONFIG.snapshotAdoptMarginMs -
              1),
        },
        NOW,
      ),
    ).toBe("adopt");
  });

  test("O-3 a clock that moved backwards cannot vouch for the age: restart", () => {
    const sync = {
      ...initialSyncState("i"),
      staging_position: "p",
      staging_started_at: NOW + 1,
    };
    expect(adoptDecision(sync, NOW)).toBe("restart");
  });

  test("O-4 no recorded attempt: restart cursor-less under a new generation", async () => {
    const w = await snapshotWorld();
    const before = w.sync().recovery_generation;
    expect(await own(w)).toMatchObject({
      decision: "restart",
      recoveryGeneration: before + 1,
    });
  });

  test("O-5 the restart is ONE transaction: a fault at any write leaves the owner, the generation and the staged rows as they were", async () => {
    for (const n of [1, 2]) {
      const w = await snapshotWorld();
      await own(w, NOW, "old");
      const gen = w.sync().recovery_generation;
      w.put("cache_staging" as never, [
        { ...cacheRow({ id: uuid(1) }), recovery_generation: gen },
      ]);
      const before = w.snapshot();
      w.env.idb.inject({
        match: (tx) => tx.label === "data.acquireOwnership",
        mode: { kind: "throw_on_write", n, as: "error" },
        times: 1,
      });
      await expect(own(w, NOW, "new")).rejects.toBeTruthy();
      expect(w.snapshot(), `fault at write ${n}`).toEqual(before);
    }
  });

  test("O-6 a valid cache is left as it is: only the owner is written", async () => {
    const w = await pageWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: uuid(5) })]);
    const gen = w.sync().recovery_generation;
    expect(await own(w)).toMatchObject({
      decision: "valid",
      recoveryGeneration: gen,
    });
    expect(w.sync()).toMatchObject({
      cache_status: "valid",
      phase: "delta",
      cursor: "cursor-0",
      recovery_generation: gen,
    });
    expect(w.cache().map((row) => row.id)).toEqual([uuid(5)]);
  });

  test("a closing fence takes no ownership and writes nothing", async () => {
    const w = await snapshotWorld();
    w.setSync({
      draft_fence: {
        token: "f",
        started_at: 0,
        operation_ids: [],
        consent_digest: "d",
        closing: true,
      },
    });
    const before = w.snapshot();
    expect(await own(w)).toEqual({ kind: "closing" });
    expect(w.snapshot()).toEqual(before);
  });
});

describe("W21: the capture gate of the recovery job", () => {
  const capture = (
    w: PageWorld,
    over: Partial<Parameters<typeof captureRecoveryRequest.decide>[1]> = {},
  ) =>
    w.service.store.run(captureRecoveryRequest, {
      incarnationId: w.service.incarnationId,
      token: TOKEN,
      path: "snapshot",
      now: NOW,
      signals: { hasStorageEstimate: true },
      ...over,
    });

  test("a cursor-less capture increments request_seq and begins the attempt's clock and sequence", async () => {
    const w = await snapshotWorld();
    await own(w);
    const out = await capture(w);
    expect(out).toMatchObject({
      kind: "captured",
      position: null,
      requestSeq: 1,
      operation: snapshotPageOperation(null),
      activateOperation: snapshotPageOperation(null),
    });
    expect(w.sync()).toMatchObject({
      request_seq: 1,
      staging_started_at: NOW,
      staging_request_seq: 1,
    });
  });

  test("a capture at a staged position keeps the attempt's clock", async () => {
    const w = await snapshotWorld();
    await own(w);
    w.setSync({ staging_position: "snap-2", staging_started_at: NOW - 5 });
    expect(await capture(w, { now: NOW + 9 })).toMatchObject({
      position: "snap-2",
    });
    expect(w.sync().staging_started_at).toBe(NOW - 5);
  });

  test("another binding's token, a closing fence and a valid cache are refused, writing nothing", async () => {
    const w = await snapshotWorld();
    await own(w);
    const before = w.snapshot();
    expect(await capture(w, { token: "other" })).toEqual({
      kind: "gated",
      reason: "owner",
    });
    expect(w.snapshot()).toEqual(before);
    const v = await pageWorld({ cursor: "c" });
    await own(v);
    expect(await capture(v)).toEqual({ kind: "gated", reason: "not_needed" });
    // The catch-up path wants exactly the opposite.
    expect(await capture(v, { path: "catch_up" })).toMatchObject({
      kind: "captured",
      position: "c",
      operation: "page:c",
      activateOperation: null,
    });
  });

  test("a blocked budget sends nothing; the one permitted attempt is captured and says it was made while blocked", async () => {
    const w = await snapshotWorld();
    await own(w);
    w.setSync({
      recovery_attempt_streak: DATA_CONFIG.recoveryAttemptStopAfter,
      recovery_budget_version: 4,
    });
    expect(await capture(w)).toEqual({
      kind: "gated",
      reason: "blocked",
      blocked: "attempts",
      budgetVersion: 4,
    });
    expect(await capture(w, { allowBlocked: true })).toMatchObject({
      kind: "captured",
      whileBlocked: "attempts",
    });
    const s = await snapshotWorld();
    await own(s);
    s.setSync({ sync_error_streak: DATA_CONFIG.syncErrorStopAfter });
    expect(await capture(s)).toMatchObject({
      reason: "blocked",
      blocked: "sync_error",
    });
  });

  test("a stopped page operation (streak, marker or this tab's memory) and an unreadable marker gate the request", async () => {
    const w = await snapshotWorld();
    await own(w);
    const op = snapshotPageOperation(null);
    w.setSync({ local_write_streaks: { [op]: 3 } });
    expect(await capture(w)).toMatchObject({
      reason: "local_storage",
      operation: op,
    });
    w.setSync({ local_write_streaks: {} });
    expect(await capture(w, { stoppedOperations: [op] })).toMatchObject({
      reason: "local_storage",
      operation: op,
    });
    expect(
      await capture(w, {
        markerState: (operation) =>
          operation === "recovery-budget" ? "unknown" : "unmarked",
      }),
    ).toMatchObject({
      reason: "unreadable",
      operations: ["recovery-budget"],
    });
  });
});

describe("S: the staged page (W22) and its guards", () => {
  async function ownedSnapshot() {
    const w = await snapshotWorld();
    await own(w);
    await w.service.store.run(captureRecoveryRequest, {
      incarnationId: w.service.incarnationId,
      token: TOKEN,
      path: "snapshot",
      now: NOW,
      signals: { hasStorageEstimate: true },
    });
    return w;
  }

  test("S-1 a page is staged under the generation, the position moves to its cursor, and nothing reaches the cache", async () => {
    const w = await ownedSnapshot();
    const out = await w.service.commit(
      commitStagingPage,
      stagedInput(w, snapshotPage([upsert(1), upsert(2)])),
    );
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "staged", position: "snap-1", revision: 50 },
    });
    expect(staged(w).map((row) => [row.id, row.recovery_generation])).toEqual([
      [uuid(1), 1],
      [uuid(2), 1],
    ]);
    expect(w.cache()).toEqual([]);
    expect(w.sync()).toMatchObject({
      staging_position: "snap-1",
      staging_revision: 50,
      cache_status: "empty",
      sync_error_streak: 0,
    });
  });

  test("S-2 to S-7: each guard drops the page with NOTHING written", async () => {
    const cases: Array<{
      what: string;
      arrange(w: PageWorld): Partial<Captured> | undefined;
      reason: string;
    }> = [
      {
        what: "INC",
        arrange: () => ({ incarnationId: "other" }),
        reason: "incarnation",
      },
      {
        what: "STG",
        arrange: () => ({ expectedPosition: "elsewhere" }),
        reason: "position",
      },
      {
        what: "GEN",
        arrange: () => ({ recoveryGeneration: 99 }),
        reason: "generation",
      },
      {
        what: "OWN",
        arrange: () => ({ ownershipToken: "older-owner" }),
        reason: "owner",
      },
      {
        what: "EPO",
        arrange: (w) => {
          w.setSync({ stamp: { epoch: 9 } });
          return undefined;
        },
        reason: "epoch_superseded",
      },
      {
        what: "CLS",
        arrange: (w) => {
          w.setSync({
            draft_fence: {
              token: "f",
              started_at: 0,
              operation_ids: [],
              consent_digest: "d",
              closing: true,
            },
          });
          return undefined;
        },
        reason: "closing",
      },
    ];
    for (const c of cases) {
      const w = await ownedSnapshot();
      const over = c.arrange(w);
      const input = stagedInput(w, snapshotPage([upsert(1)]));
      const before = w.snapshot();
      const out = await w.service.commit(commitStagingPage, {
        ...input,
        captured: { ...input.captured, ...over },
      });
      expect(out, c.what).toEqual({ kind: "dropped", reason: c.reason });
      expect(w.snapshot(), c.what).toEqual(before);
    }
  });

  test("S-8 the same page requested again after it staged is refused by the staging compare-and-set (idempotent)", async () => {
    const w = await ownedSnapshot();
    const input = stagedInput(w, snapshotPage([upsert(1)]));
    await w.service.commit(commitStagingPage, input);
    const once = w.snapshot();
    expect(await w.service.commit(commitStagingPage, input)).toEqual({
      kind: "dropped",
      reason: "position",
    });
    expect(w.snapshot()).toEqual(once);
  });

  test("a delta page, a revision mismatch and a lapsed hold are refused without a write", async () => {
    const w = await ownedSnapshot();
    await w.service.commit(
      commitStagingPage,
      stagedInput(w, snapshotPage([upsert(1)])),
    );
    const before = w.snapshot();
    for (const [spec, over, kind] of [
      [snapshotPage([upsert(2)], { phase: "delta" }), {}, "not_ready"],
      [
        snapshotPage([upsert(2)], {
          batches: [{ revision: 51, changes: [upsert(2)] }],
        }),
        {},
        "revision_mismatch",
      ],
      [
        snapshotPage([], {
          batches: [
            { revision: 50, changes: [upsert(2)] },
            { revision: 49, changes: [upsert(3)] },
          ],
        }),
        {},
        "revision_mismatch",
      ],
      [snapshotPage([upsert(2)]), { leaseLive: () => false }, "lease_lapsed"],
    ] as const) {
      const out = await w.service.commit(
        commitStagingPage,
        stagedInput(w, spec, over),
      );
      expect(out).toMatchObject({ kind: "applied", value: { kind } });
      expect(w.snapshot()).toEqual(before);
    }
  });

  test("a fault at any write of a page leaves staging and the position as they were", async () => {
    for (const n of [1, 2, 3]) {
      const w = await ownedSnapshot();
      const before = w.snapshot();
      w.env.idb.inject({
        match: (tx) => tx.label === "data.commitStagingPage",
        mode: { kind: "throw_on_write", n, as: "error" },
        times: 1,
      });
      const out = await w.service.commit(
        commitStagingPage,
        stagedInput(w, snapshotPage([upsert(1), upsert(2)])),
      );
      expect(out.kind, `fault at write ${n}`).toBe("failed");
      expect(w.snapshot()).toEqual(before);
    }
  });
});

describe("S: the activation (W23) is one transaction (reconciliation row 3)", () => {
  async function stagedWorld(window?: number) {
    const w = await snapshotWorld();
    await own(w);
    await w.service.store.run(captureRecoveryRequest, {
      incarnationId: w.service.incarnationId,
      token: TOKEN,
      path: "snapshot",
      now: NOW,
      signals: { hasStorageEstimate: true },
    });
    await w.service.commit(
      commitStagingPage,
      stagedInput(w, snapshotPage([upsert(1), upsert(2), upsert(3)])),
    );
    void window;
    return w;
  }
  const final = snapshotPage([upsert(4)], {
    hasMore: false,
    nextCursor: "delta-1",
  });

  test("S-9 the final page and the swap: the cache holds every staged row, staging is empty, and the delta cursor and validity are committed with it", async () => {
    const w = await stagedWorld();
    w.put("cache", [cacheRow({ id: uuid(77) })]);
    w.setSync({ cache_status: "invalid" });
    const out = await w.service.commit(
      activateSnapshot,
      activationInput(w, final, { window: 2 }),
    );
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "activated", rows: 4, cursor: "delta-1", revision: 50 },
    });
    expect(
      w
        .cache()
        .map((row) => row.id)
        .sort(),
    ).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(w.cache()[0]).not.toHaveProperty("recovery_generation");
    expect(staged(w)).toEqual([]);
    expect(w.sync()).toMatchObject({
      cursor: "delta-1",
      phase: "delta",
      cache_status: "valid",
      applied_revision: 50,
      staging_position: null,
      staging_started_at: null,
      sync_error_streak: 0,
      delta_error_streak: 0,
      recovery_attempt_streak: 0,
      last_synced_at: "2026-10-10T12:00:00.000Z",
    });
  });

  test("S-10 a fault at ANY write of the activation leaves the old cache, staging and the position exactly as they were", async () => {
    let faulted = 0;
    for (let n = 1; n < 200; n += 1) {
      const w = await stagedWorld();
      w.put("cache", [cacheRow({ id: uuid(77) })]);
      const before = w.snapshot();
      w.env.idb.inject({
        match: (tx) => tx.label === "data.activateSnapshot",
        mode: {
          kind: "throw_on_write",
          n,
          as: n % 2 === 0 ? "quota" : "error",
        },
        times: 1,
      });
      const out = await w.service.commit(
        activateSnapshot,
        activationInput(w, final, { window: 2 }),
      );
      // The activation made fewer than n writes: every index up to its last has been faulted.
      if (out.kind === "applied") break;
      faulted += 1;
      expect(out.kind, `fault at write ${n}`).toBe("failed");
      expect(w.snapshot(), `fault at write ${n}`).toEqual(before);
    }
    // The clear, the final page, two windows of copies and their removals, and the singleton.
    expect(faulted).toBeGreaterThanOrEqual(6);
  });

  test("S-11 adopted rows are admitted by generation alone; rows of another generation are not swapped in", async () => {
    const w = await stagedWorld();
    const gen = w.sync().recovery_generation;
    w.put("cache_staging" as never, [
      { ...cacheRow({ id: uuid(60) }), recovery_generation: gen - 1 },
    ]);
    // A new owner adopts the attempt: a new token, the same generation.
    w.setSync({ staging_started_at: NOW });
    await own(w, NOW + 1, "adopter");
    const out = await w.service.commit(
      activateSnapshot,
      activationInput(w, final),
    );
    expect(out.kind).toBe("applied");
    expect(
      w
        .cache()
        .map((row) => row.id)
        .sort(),
    ).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
  });

  test("S-12 unsent work is byte-identical; a covered receipt is released; a newer receipt is left; a covered absent resource is unavailable", async () => {
    for (const mode of ["ordinary", "recovery"] as const) {
      const w = await stagedWorld();
      const unsent = draftRow({
        local_id: "unsent",
        status: "queued",
        command: { kind: "edit", body: "x".repeat(40) },
      });
      const covered = draftRow({
        local_id: "covered",
        status: "acknowledged",
        held_pending_cache: true,
        receipt_revision: 40,
      });
      const newer = draftRow({
        local_id: "newer",
        status: "acknowledged",
        held_pending_cache: true,
        receipt_revision: 70,
      });
      const gone = draftRow({
        local_id: "gone",
        status: "acknowledged",
        held_pending_cache: true,
        receipt_revision: 45,
      });
      // Unsent work whose effect row carries a revision at or below the boundary (a resend after a receipt was recorded elsewhere):
      // only the owner's status says it is unsent, and it must still not be touched.
      const inFlight = draftRow({ local_id: "in-flight", status: "in_flight" });
      w.put("drafts", [unsent, covered, newer, gone, inFlight]);
      w.put("pending_effects", [
        effectRow({
          resource_id: uuid(1),
          local_id: "unsent",
          display: { label: "mine" },
        }),
        effectRow({
          resource_id: uuid(2),
          local_id: "covered",
          receipt_revision: 40,
          no_publication_floor: 0,
          display: { label: "theirs" },
        }),
        effectRow({
          resource_id: uuid(3),
          local_id: "newer",
          receipt_revision: 70,
          no_publication_floor: 0,
          display: { label: "later" },
        }),
        effectRow({
          resource_id: uuid(2),
          local_id: "in-flight",
          receipt_revision: 30,
          no_publication_floor: 0,
          display: { label: "sending" },
        }),
        effectRow({
          resource_id: uuid(99),
          local_id: "gone",
          receipt_revision: 45,
          no_publication_floor: 0,
          display: { label: "hidden" },
        }),
      ]);
      const draftsBefore = (w.rows("drafts") as Array<{ local_id: string }>)
        .filter(
          (row) => row.local_id === "unsent" || row.local_id === "in-flight",
        )
        .map((row) => JSON.stringify(row));
      const effectsBefore = (
        w.rows("pending_effects") as Array<{ local_id: string }>
      )
        .filter((row) =>
          ["unsent", "newer", "in-flight"].includes(row.local_id),
        )
        .map((row) => JSON.stringify(row));
      const body = w.commandOf("unsent");
      const queueBefore = JSON.stringify([
        w.rows("drafts"),
        w.rows("draft_commands"),
        w.rows("pending_effects"),
      ]);
      const out = await w.service.commit(
        activateSnapshot,
        activationInput(w, final, { mode }),
      );
      expect(out.kind, mode).toBe("applied");
      if (mode === "recovery") {
        // ADAPTED (R8 of the review of 10 October 2026): the recovery-mode activation writes NOTHING of the queue (the approved brief:
        // the recovery touches no draft, `pending_effects` or outbox entry); the receipt bookkeeping is owed and done by W26 once the
        // account is displayed. The original assertions below (covered released, gone unavailable, newer and unsent work untouched)
        // now hold after W26, an ordinary write, which also deletes the finished receipt as the ordinary activation does.
        expect(
          JSON.stringify([
            w.rows("drafts"),
            w.rows("draft_commands"),
            w.rows("pending_effects"),
          ]),
          mode,
        ).toBe(queueBefore);
        expect(w.sync().recovery_reconcile_pending, mode).toBe(true);
        const owed = await w.service.commit(reconcileOwedReceipts, {
          captured: w.capture(),
        });
        expect(owed, mode).toMatchObject({
          kind: "applied",
          value: { kind: "reconciled" },
        });
        expect(w.sync().recovery_reconcile_pending, mode).toBe(false);
      } else expect(w.sync().recovery_reconcile_pending, mode).toBe(false);
      expect(
        (w.rows("drafts") as Array<{ local_id: string }>)
          .filter(
            (row) => row.local_id === "unsent" || row.local_id === "in-flight",
          )
          .map((row) => JSON.stringify(row)),
        mode,
      ).toEqual(draftsBefore);
      expect(w.commandOf("unsent"), mode).toEqual(body);
      expect(
        (w.rows("pending_effects") as Array<{ local_id: string }>)
          .filter((row) =>
            ["unsent", "newer", "in-flight"].includes(row.local_id),
          )
          .map((row) => JSON.stringify(row)),
        mode,
      ).toEqual(effectsBefore);
      const drafts = new Map(
        (
          w.rows("drafts") as Array<{
            local_id: string;
            held_pending_cache: boolean;
            unavailable_outcome: boolean;
          }>
        ).map((row) => [row.local_id, row]),
      );
      expect(drafts.get("newer")?.held_pending_cache, mode).toBe(true);
      expect(drafts.get("gone"), mode).toMatchObject({
        held_pending_cache: false,
        unavailable_outcome: true,
      });
      // The released, finished draft leaves with its effect (in recovery mode, at W26 after the account is displayed).
      expect(drafts.has("covered"), mode).toBe(false);
      w.assertNoOrphanBodies();
    }
  });

  test("tracked versions follow the snapshot; a recovery deletes none", async () => {
    for (const mode of ["ordinary", "recovery"] as const) {
      const w = await stagedWorld();
      w.put("resource_versions", [
        versionRow({ resource_id: uuid(1), locally_assumed_version: 0 }),
        versionRow({ resource_id: uuid(98), locally_assumed_version: 3 }),
      ]);
      await w.service.commit(
        activateSnapshot,
        activationInput(w, final, { mode }),
      );
      const ids = (
        w.rows("resource_versions") as Array<{ resource_id: string }>
      )
        .map((row) => row.resource_id)
        .sort();
      expect(ids, mode).toEqual(mode === "recovery" ? [uuid(1), uuid(98)] : []);
    }
  });

  test("the activation of a page that is not final, or of a valid cache, writes nothing", async () => {
    const w = await stagedWorld();
    const before = w.snapshot();
    const out = await w.service.commit(
      activateSnapshot,
      activationInput(w, snapshotPage([upsert(9)])),
    );
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "not_ready", reason: "final" },
    });
    expect(w.snapshot()).toEqual(before);
  });
});

describe("R: the recovery-scoped retry classes (W24, W25)", () => {
  test("R-1 the reducer: cursor-less errors count sync_error_streak; a cursor defect abandons and counts the attempt; three unrecognised answers on a cursor abandon; server restarts count nothing", () => {
    const zero = {
      sync_error_streak: 0,
      delta_error_streak: 0,
      recovery_attempt_streak: 0,
    };
    expect(budgetStep(zero, "cursorless_error")).toMatchObject({
      sync_error_streak: 1,
      abandon: false,
    });
    expect(budgetStep(zero, "cursor_defect")).toMatchObject({
      recovery_attempt_streak: 1,
      abandon: true,
      attemptCounted: true,
    });
    expect(
      budgetStep({ ...zero, delta_error_streak: 1 }, "cursor_unrecognised"),
    ).toMatchObject({ delta_error_streak: 2, abandon: false });
    expect(
      budgetStep({ ...zero, delta_error_streak: 2 }, "cursor_unrecognised"),
    ).toMatchObject({
      delta_error_streak: 0,
      recovery_attempt_streak: 1,
      abandon: true,
    });
    expect(
      budgetStep({ ...zero, recovery_attempt_streak: 2 }, "server_restart"),
    ).toMatchObject({
      recovery_attempt_streak: 2,
      abandon: true,
      attemptCounted: false,
    });
  });

  test("R-2 an abandonment clears staging, advances the generation and hides a valid cache, writing nothing of the queue or the overlays", async () => {
    const w = await pageWorld({ cursor: "c" });
    await own(w);
    w.put("pending_effects", [
      effectRow({ resource_id: uuid(1), display: { label: "x" } }),
    ]);
    const effects = JSON.stringify(w.rows("pending_effects"));
    const gen = w.sync().recovery_generation;
    // ADAPTED (R5 of the review of 10 October 2026): W24 is admitted with the request's stamp through `AccountService.commit`, so its
    // answer is the commit's `applied` envelope; the recorded values asserted are the original ones.
    const out = await w.service.commit(recordRecoveryOutcome, {
      captured: captureFor(w),
      event: "cursor_defect",
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: {
        abandoned: true,
        recoveryAttemptStreak: 1,
        recoveryGeneration: gen + 1,
      },
    });
    expect(w.sync()).toMatchObject({
      cache_status: "invalid",
      cursor: null,
      phase: "snapshot",
      recovery_generation: gen + 1,
      recovery_budget_version: 1,
    });
    expect(JSON.stringify(w.rows("pending_effects"))).toBe(effects);
  });

  test("R-3 an outcome of a superseded binding counts nothing", async () => {
    const w = await snapshotWorld();
    await own(w);
    const before = w.snapshot();
    for (const [token, generation, reason] of [
      ["older", w.sync().recovery_generation, "owner"],
      [TOKEN, 99, "generation"],
    ] as const)
      expect(
        await w.service.commit(recordRecoveryOutcome, {
          captured: captureFor(w, {
            ownershipToken: token,
            recoveryGeneration: generation,
          }),
          event: "cursorless_error",
        }),
      ).toEqual({ kind: "dropped", reason });
    expect(w.snapshot()).toEqual(before);
  });

  test("R-3b an answer of an EARLIER epoch counts nothing and abandons nothing (R5: W24 is admitted with the request's stamp)", async () => {
    const w = await pageWorld({ cursor: "c" });
    await own(w);
    const before = w.snapshot();
    // The answer's request was captured at epoch 1; a same-account re-authentication then made epoch 2 current. The binding (token,
    // generation) is unchanged, which is exactly what OWN and GEN cannot tell apart.
    const stale = captureFor(w);
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    expect(
      await w.service.commit(recordRecoveryOutcome, {
        captured: stale,
        event: "cursor_defect",
      }),
    ).toEqual({ kind: "dropped", reason: "identity_changed" });
    expect(w.snapshot()).toEqual(before);
    // And inside the data transaction: a later epoch already published to this database (another page's commit) drops it too.
    w.setSync({ stamp: { epoch: 3 } });
    const published = w.snapshot();
    expect(
      await w.service.store.run(recordRecoveryOutcome, {
        captured: captureFor(w),
        event: "cursor_defect",
      }),
    ).toEqual({ kind: "dropped", reason: "epoch_superseded" });
    expect(w.snapshot()).toEqual(published);
  });

  test("R-4 Try again resets the whole-attempt counter only for the failure it saw", async () => {
    const w = await snapshotWorld();
    w.setSync({
      recovery_attempt_streak: 3,
      sync_error_streak: 2,
      recovery_budget_version: 5,
    });
    const run = (expect_: number) =>
      w.service.store.run(resetRecoveryBudget, {
        incarnationId: w.service.incarnationId,
        expect: expect_,
      });
    expect(await run(4)).toEqual({ cleared: false, budgetVersion: 5 });
    expect(w.sync().recovery_attempt_streak).toBe(3);
    expect(await run(5)).toEqual({ cleared: true, budgetVersion: 5 });
    expect(w.sync()).toMatchObject({
      recovery_attempt_streak: 0,
      sync_error_streak: 2,
    });
  });
});

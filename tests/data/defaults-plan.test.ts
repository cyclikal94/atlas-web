// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { AccountService } from "../../src/data/engine/account-service";
import type { SyncStateRow } from "../../src/data/model/types";
import { readDefaults, writeDefaults } from "../../src/data/plans/defaults";
import { DB, defaultsWorld } from "../support/data/defaults-world";
import { record, revision, snapshot } from "../support/data/sharing";

/**
 * W14 `writeDefaults` (WEB-12a): the guard set of a response-derived writer (INC, CLS, EPO) applied from the singleton read in the
 * SAME transaction, the later-issued rule, the quota lease, and the tolerant read. Run against the production plan over the double of
 * IndexedDB, through the store directly so each guard is exercised on its own (the commit path's G1/G2/G5 are the account service's,
 * tested with it). FIXTURE evidence.
 */
async function bound() {
  const t = await defaultsWorld({ online: false });
  t.env.defaults.use();
  await t.settle();
  const service = t.env.service() as AccountService;
  expect(service).not.toBeNull();
  const seed = (patch: Partial<SyncStateRow>) => {
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    t.world.idb.seed(DB, "sync_state", [{ ...sync, ...patch }]);
  };
  const write = (over: {
    epoch?: number;
    incarnationId?: string;
    issuedAt?: number;
    revision?: string;
    leaseLive?: () => boolean;
  }) =>
    service.store.run(writeDefaults, {
      captured: {
        ...service.capture(over.epoch ?? 1),
        ...(over.incarnationId === undefined
          ? {}
          : { incarnationId: over.incarnationId }),
      },
      snapshot: snapshot({ revision: over.revision ?? revision(1) }),
      issuedAt: over.issuedAt ?? 100,
      now: 150,
      ...(over.leaseLive ? { leaseLive: over.leaseLive } : {}),
    });
  return { t, service, seed, write };
}

describe("W14: the guards of a response-derived write", () => {
  test("applies, writes ONE record and publishes the epoch mirror", async () => {
    const { t, write } = await bound();
    const out = await write({ epoch: 3 });
    expect(out).toEqual({
      kind: "applied",
      value: {
        written: true,
        stored: {
          format: 1,
          snapshot: snapshot(),
          fetched_at: 150,
          issued_at: 100,
          epoch: 3,
        },
      },
    });
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(sync.defaults).toEqual(out.kind === "applied" && out.value.stored);
    expect(sync.stamp).toEqual({ epoch: 3 });
  });

  test("MU-D1 EPO: an answer of an EARLIER epoch than the published mirror writes nothing", async () => {
    const { t, seed, write } = await bound();
    seed({ stamp: { epoch: 2 } });
    expect(await write({ epoch: 1 })).toEqual({
      kind: "dropped",
      reason: "epoch_superseded",
    });
    expect(
      (t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow)
        .defaults,
    ).toBeNull();
  });

  test("CLS: an answer that lands while a wipe is closing writes nothing", async () => {
    const { t, seed, write } = await bound();
    seed({
      draft_fence: {
        token: "f",
        started_at: 1,
        operation_ids: [],
        consent_digest: "d",
        closing: true,
      },
    });
    expect(await write({})).toEqual({ kind: "dropped", reason: "closing" });
    expect(
      (t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow)
        .defaults,
    ).toBeNull();
  });

  test("INC: an answer captured for another incarnation of the database writes nothing", async () => {
    const { t, write } = await bound();
    expect(await write({ incarnationId: "another" })).toEqual({
      kind: "dropped",
      reason: "incarnation",
    });
    expect(
      (t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow)
        .defaults,
    ).toBeNull();
  });
});

describe("W14: the later-issued answer stands", () => {
  test("MU-D2: a stored record issued LATER is kept and returned; one issued earlier (or at the same instant) is replaced whole", async () => {
    const { t, seed, write } = await bound();
    seed({
      defaults: record(snapshot({ revision: revision(9) }), { issued_at: 500 }),
    });
    const kept = await write({ issuedAt: 400, revision: revision(1) });
    expect(kept).toEqual({
      kind: "applied",
      value: {
        written: false,
        stored: record(snapshot({ revision: revision(9) }), { issued_at: 500 }),
      },
    });
    const replaced = await write({ issuedAt: 500, revision: revision(2) });
    expect(replaced.kind === "applied" && replaced.value.written).toBe(true);
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(
      (sync.defaults as { snapshot: { defaults: { revision: string } } })
        .snapshot.defaults.revision,
    ).toBe(revision(2));
  });

  test("a stored value that is not a record (WEB-09a's seed, damage) is replaced", async () => {
    const { seed, write } = await bound();
    seed({ defaults: { kind: "garbage" } });
    const out = await write({});
    expect(out.kind === "applied" && out.value.written).toBe(true);
  });
});

describe("W14: the quota lease (R28)", () => {
  test("a lease that is no longer live writes nothing and says so", async () => {
    const { t, write } = await bound();
    const out = await write({ leaseLive: () => false });
    expect(out).toEqual({
      kind: "applied",
      value: { written: false, stored: null, lapsed: true },
    });
    expect(
      (t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow)
        .defaults,
    ).toBeNull();
  });
});

describe("readDefaults", () => {
  test("reads the record back, and a damaged field as none", async () => {
    const { service, seed } = await bound();
    seed({ defaults: record() });
    expect(
      await service.store.run(readDefaults, {
        incarnationId: service.incarnationId,
      }),
    ).toEqual(record());
    seed({ defaults: { format: 1 } });
    expect(
      await service.store.run(readDefaults, {
        incarnationId: service.incarnationId,
      }),
    ).toBeNull();
  });
});

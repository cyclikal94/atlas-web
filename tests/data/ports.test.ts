// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
} from "../../src/data/engine/write-failure-marker";
import {
  EMPTY_DIGEST,
  NO_CONSENT_DIGEST,
  UNREADABLE_BASELINE,
  UNREADABLE_LIVE,
  UNREADABLE_SUMMARY,
} from "../../src/data/model/local-work";
import { accountDatabaseName } from "../../src/data/model/schema";
import { createAccountDatabasePort } from "../../src/data/ports/account-database";
import { createDataDeletionPorts } from "../../src/data/ports/deletion-ports";
import { createPortsImpl } from "../../src/data/ports/ports-impl";
import { createRegistry } from "../../src/data/store/registry";
import { createDefaultDatabasePort } from "../../src/session/adapters/default-deletion";
import { FakeIdb } from "../support/data/fake-idb";
import { scopeOf } from "../support/data/marker-storage";
import { draftRow, recoveryRow } from "../support/data/rows";
import { FakeSyncBus } from "../support/data/sync-bus";
import { World } from "../support/session/world";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);

/** A tiny origin: one world, the double of IndexedDB driven automatically, one page's ports over it. */
function origin() {
  const world = new World();
  for (const page of ["A", "B", "seed"]) world.registerPage(page);
  const idb = new FakeIdb(world);
  idb.autoDrive = true;
  const bus = new FakeSyncBus(world);
  const registry = createRegistry("tab-A");
  const store = new Map<string, string>();
  const markers = createWriteFailureMarkers(
    {
      get length() {
        return store.size;
      },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
    },
    undefined,
    { ownSlot: 0 },
  );
  let now = 1_000;
  const host = idb.hostForPage("A");
  const database = createAccountDatabasePort({
    host,
    registry,
    markers,
    now: () => now,
  });
  let uuid = 0;
  let failOpen = false;
  const impl = createPortsImpl({
    openExisting: async (account) => {
      if (failOpen) throw new Error("storage unavailable");
      const opened = await idb
        .openerForPage("A", createRegistry("port"))
        .open(account, { create: false, single: true, incarnation: "x" });
      return opened.kind === "opened" ? opened.store : null;
    },
    channel: bus.channelFor("A"),
    registry,
    clock: {
      now: () => now,
      sleep: (ms) =>
        new Promise((r) => world.schedule("timer", "A", {}, r, ms)),
    },
    ids: {
      uuid: () => {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      },
    },
    graceMs: 0,
  });
  const create = async (): Promise<void> => {
    const opened = await idb
      .openerForPage("seed", createRegistry("seed"))
      .open(ACCOUNT, { create: true, incarnation: "inc-1", single: true });
    if (opened.kind === "opened") opened.store.close();
  };
  return {
    world,
    idb,
    bus,
    registry,
    markers,
    markerStore: store,
    database,
    impl,
    create,
    setNow: (n: number) => {
      now = n;
    },
    failOpen: (v: boolean) => {
      failOpen = v;
    },
  };
}

describe("F-W1: the real ports are registered, and the defaults can no longer refuse", () => {
  test("production boot registers createDataDeletionPorts (removing it fails here)", () => {
    const boot = readFileSync("src/app/boot.tsx", "utf8");
    expect(boot).toMatch(
      /import \{ createDataDeletionPorts \} from "\.\.\/data"/,
    );
    expect(boot).toMatch(/deletion:\s*createDataDeletionPorts\(\)/);
  });

  test("the session's default refuses while an account database exists; the real database port does not", async () => {
    const defaults = createDefaultDatabasePort({
      databases: async () => [{ name: NAME }],
    });
    await expect(defaults.exists(ACCOUNT)).rejects.toThrow(
      /no account database adapter/,
    );
    const o = origin();
    await o.create();
    expect(await o.database.exists(ACCOUNT)).toBe(true);
    expect(await o.database.readIncarnation(ACCOUNT)).toBe("inc-1");
  });
});

describe("F-W2: AccountDatabasePort", () => {
  test("exists: false for an absent database, true for a present one, and it never creates", async () => {
    const o = origin();
    expect(await o.database.exists(ACCOUNT)).toBe(false);
    expect(o.idb.has(NAME)).toBe(false);
    await o.create();
    expect(await o.database.exists(ACCOUNT)).toBe(true);
  });

  test("exists REJECTS when databases() is unsupported or fails: an unknown answer is never `false` (MU-41)", async () => {
    const o = origin();
    o.idb.listUnsupported = true;
    await expect(o.database.exists(ACCOUNT)).rejects.toThrow();
    o.idb.listUnsupported = false;
    o.idb.listError = new Error("blocked");
    await expect(o.database.exists(ACCOUNT)).rejects.toThrow();
  });

  test("exists rejects when the probe fails or times out, rather than answering false", async () => {
    const o = origin();
    await o.create();
    o.idb.probeMode = "fail";
    await expect(o.database.exists(ACCOUNT)).rejects.toThrow();
    o.idb.probeMode = "hang";
    const pending = o.database.exists(ACCOUNT);
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    );
    await o.world.advance(3_001);
    expect(await settled).toBe("rejected");
  });

  test("exists is false when the database vanishes between the listing and the probe", async () => {
    const o = origin();
    await o.create();
    o.idb.beforeOpen = null;
    const original = o.idb.hostForPage("A").probe;
    void original;
    // Remove it after the listing: the probe then answers `absent`.
    const listing = o.idb.hostForPage("A").list();
    await o.world.runUntilIdle();
    await listing;
    o.idb.vanish(NAME);
    expect(await o.database.exists(ACCOUNT)).toBe(false);
  });

  test("readIncarnation: the probed value, cached for the lock hold; null for a database with no singleton", async () => {
    const o = origin();
    await o.create();
    expect(await o.database.exists(ACCOUNT)).toBe(true);
    // A cache hit: change the stored value behind the port's back; the cached answer is returned.
    const sync = o.idb.peek(NAME, "sync_state", "singleton");
    o.idb.seed(NAME, "sync_state", [
      { ...(sync as object), incarnation_id: "changed" } as never,
    ]);
    expect(await o.database.readIncarnation(ACCOUNT)).toBe("inc-1");
    // After the cache window, a fresh probe.
    o.setNow(1_000 + 10_001);
    expect(await o.database.readIncarnation(ACCOUNT)).toBe("changed");
    // No singleton: null.
    o.idb.createDamaged("22222222-2222-4222-8222-222222222222");
    expect(
      await o.database.readIncarnation("22222222-2222-4222-8222-222222222222"),
    ).toBeNull();
    // Absent: null.
    expect(
      await o.database.readIncarnation("33333333-3333-4333-8333-333333333333"),
    ).toBeNull();
  });

  test("closeOwnConnections is idempotent, resolves with nothing open, and latches", async () => {
    const o = origin();
    await expect(
      o.database.closeOwnConnections(ACCOUNT),
    ).resolves.toBeUndefined();
    await expect(
      o.database.closeOwnConnections(ACCOUNT),
    ).resolves.toBeUndefined();
    expect(o.registry.latch(ACCOUNT)).toBe("closed_for_deletion");
  });

  test("delete: deleted, and it removes the account's write-failure markers BEFORE it resolves (MU-42)", async () => {
    const o = origin();
    await o.create();
    o.markers.set(scopeOf(ACCOUNT), "page:cursor");
    o.markers.set(scopeOf("other"), "page:cursor");
    expect(await o.database.delete(ACCOUNT)).toBe("deleted");
    expect(o.idb.has(NAME)).toBe(false);
    expect(o.markers.operations(scopeOf(ACCOUNT))).toEqual([]);
    expect(o.markers.operations(scopeOf("other"))).toEqual(["page:cursor"]);
    expect(
      [...o.markerStore.keys()].every(
        (k) => k.startsWith(MARKER_PREFIX) || k.startsWith(DIRECTORY_PREFIX),
      ),
    ).toBe(true);
  });

  test("delete never resolves while blocked (MU-40): a connection that cannot respond holds it, and the completion is `blocked_then_deleted`", async () => {
    const o = origin();
    await o.create();
    // A second page holds a connection and, like a frozen tab, never closes it.
    const holder = createRegistry("tab-B");
    const opened = await o.idb
      .openerForPage("B", holder)
      .open(ACCOUNT, { create: false, incarnation: "x", single: true });
    expect(opened.kind).toBe("opened");
    o.world.setFrozen("B", true);
    let result: string | null = null;
    const deleting = o.database.delete(ACCOUNT).then((r) => {
      result = r;
    });
    await o.world.runUntilIdle();
    await o.world.advance(60_000);
    expect(result, "a blocked delete must stay pending").toBeNull();
    expect(o.idb.has(NAME)).toBe(true);
    // The tab wakes and closes on versionchange: the delete completes, and it says it had been blocked.
    o.world.setFrozen("B", false);
    await o.world.runUntilIdle();
    await deleting;
    expect(result).toBe("blocked_then_deleted");
    expect(o.idb.has(NAME)).toBe(false);
  });

  test("delete reports `error` and leaves the markers alone", async () => {
    const o = origin();
    await o.create();
    o.markers.set(scopeOf(ACCOUNT), "x");
    o.idb.deleteError = true;
    expect(await o.database.delete(ACCOUNT)).toBe("error");
    expect(o.markers.operations(scopeOf(ACCOUNT))).toEqual(["x"]);
  });
});

describe("F-W2: LocalWorkPort and WipeCoordinationPort", () => {
  test("summarise: absent database is an empty summary; a present one counts the normative population", async () => {
    const o = origin();
    expect(await o.impl.localWork.summarise(ACCOUNT)).toEqual({
      count: 0,
      items: [],
      digest: EMPTY_DIGEST,
    });
    await o.create();
    o.idb.seed(NAME, "drafts", [
      draftRow({ status: "queued" }),
      draftRow({ status: "acknowledged" }),
    ]);
    o.idb.seed(NAME, "form_recovery", [recoveryRow()]);
    const summary = await o.impl.localWork.summarise(ACCOUNT);
    expect(summary.count).toBe(2);
    expect(summary.items).toEqual([
      "1 change waiting to send",
      "1 unfinished form copy",
    ]);
  });

  test("EVERY method whose caller does not catch is TOTAL: it never rejects, whatever fault is injected", async () => {
    const faults: Array<[string, (o: ReturnType<typeof origin>) => void]> = [
      ["the database cannot be opened", (o) => o.failOpen(true)],
      [
        "every transaction aborts",
        (o) => o.idb.inject({ match: () => true, mode: "abort" }),
      ],
      [
        "every transaction errors",
        (o) => o.idb.inject({ match: () => true, mode: "error" }),
      ],
      [
        "every transaction is refused as closed",
        (o) => o.idb.inject({ match: () => true, mode: "closed" }),
      ],
    ];
    for (const [name, inject] of faults) {
      const o = origin();
      await o.create();
      o.idb.seed(NAME, "drafts", [draftRow({ status: "queued" })]);
      inject(o);
      const c = o.impl.coordination;
      await expect(
        c.waitForClosure(ACCOUNT, 10),
        name,
      ).resolves.toBeUndefined();
      // Total AND honest (R12): the failure is answered, never swallowed, so the wipe cannot go on without the durable flag.
      await expect(c.setClosing(ACCOUNT), name).resolves.toBe("unconfirmed");
      await expect(c.liveDigest(ACCOUNT), name).resolves.toBe(UNREADABLE_LIVE);
      await expect(c.liveCount(ACCOUNT), name).resolves.toBe(0);
      await expect(c.baselineDigest(ACCOUNT), name).resolves.toBe(
        UNREADABLE_BASELINE,
      );
      await expect(
        c.releaseFence(ACCOUNT, "op"),
        name,
      ).resolves.toBeUndefined();
      expect(() => c.broadcastImminent(ACCOUNT, "op"), name).not.toThrow();
      await expect(o.impl.localWork.summarise(ACCOUNT), name).resolves.toEqual({
        count: 0,
        items: [],
        digest: UNREADABLE_SUMMARY,
      });
      // `setDraftFence` is the one that may reject: `initiate()` maps it to `refused/storage_unavailable`.
      await expect(c.setDraftFence(ACCOUNT, "op"), name).rejects.toBeDefined();
    }
  });

  test("the unreadable sentinels are all distinct and none can equal a real digest (a failure to read never reads as `unchanged`)", () => {
    const all = [
      UNREADABLE_SUMMARY,
      UNREADABLE_BASELINE,
      UNREADABLE_LIVE,
      NO_CONSENT_DIGEST,
      EMPTY_DIGEST,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const sentinel of [
      UNREADABLE_SUMMARY,
      UNREADABLE_BASELINE,
      UNREADABLE_LIVE,
      NO_CONSENT_DIGEST,
    ])
      expect(sentinel).not.toMatch(/^[0-9a-f]{64}$/);
  });

  test("baselineDigest: the fence's digest; EMPTY for an empty database; a digest nothing can equal for work with no fence (MU-37)", async () => {
    const o = origin();
    // Absent database.
    expect(await o.impl.coordination.baselineDigest(ACCOUNT)).toBe(
      EMPTY_DIGEST,
    );
    await o.create();
    expect(await o.impl.coordination.baselineDigest(ACCOUNT)).toBe(
      EMPTY_DIGEST,
    );
    o.idb.seed(NAME, "drafts", [draftRow({ status: "queued" })]);
    expect(await o.impl.coordination.baselineDigest(ACCOUNT)).toBe(
      NO_CONSENT_DIGEST,
    );
    const fenced = await o.impl.coordination.setDraftFence(ACCOUNT, "op-1");
    expect(await o.impl.coordination.baselineDigest(ACCOUNT)).toBe(
      fenced.consentDigest,
    );
    expect(await o.impl.coordination.liveDigest(ACCOUNT)).toBe(
      fenced.consentDigest,
    );
    // Release (Keep for now): the baseline is NOT null any more, and work saved after it is not covered.
    await o.impl.coordination.releaseFence(ACCOUNT, "op-1");
    o.idb.seed(NAME, "drafts", [draftRow({ status: "queued" })]);
    expect(await o.impl.coordination.baselineDigest(ACCOUNT)).toBe(
      NO_CONSENT_DIGEST,
    );
    expect(await o.impl.coordination.liveCount(ACCOUNT)).toBe(2);
  });

  test("setDraftFence for an absent database fences nothing and answers the empty digest", async () => {
    const o = origin();
    expect(await o.impl.coordination.setDraftFence(ACCOUNT, "op")).toEqual({
      consentDigest: EMPTY_DIGEST,
    });
  });

  test("releaseFence is idempotent, never throws, and is a no-op for a database that is gone", async () => {
    const o = origin();
    await expect(
      o.impl.coordination.releaseFence(ACCOUNT, "op"),
    ).resolves.toBeUndefined();
    await o.create();
    await o.impl.coordination.setDraftFence(ACCOUNT, "op");
    await o.impl.coordination.releaseFence(ACCOUNT, "op");
    await expect(
      o.impl.coordination.releaseFence(ACCOUNT, "op"),
    ).resolves.toBeUndefined();
    expect(o.idb.peek(NAME, "sync_state", "singleton")?.draft_fence).toBeNull();
  });
});

describe("the static shims are total when the lazy chunk cannot be loaded", () => {
  const failing = () => {
    const o = origin();
    return createDataDeletionPorts({
      host: o.idb.hostForPage("A"),
      registry: o.registry,
      loadImpl: async () => {
        throw new Error("chunk failed to load");
      },
    });
  };
  test("every conservative value is the one the real adapter would give; only setDraftFence rejects", async () => {
    const ports = failing();
    expect(await ports.localWork.summarise(ACCOUNT)).toEqual({
      count: 0,
      items: [],
      digest: UNREADABLE_SUMMARY,
    });
    await expect(
      ports.coordination.setDraftFence(ACCOUNT, "op"),
    ).rejects.toThrow("chunk failed to load");
    expect(() =>
      ports.coordination.broadcastImminent(ACCOUNT, "op"),
    ).not.toThrow();
    await expect(ports.coordination.setClosing(ACCOUNT)).resolves.toBe(
      "unconfirmed",
    );
    await expect(
      ports.coordination.waitForClosure(ACCOUNT, 10),
    ).resolves.toBeUndefined();
    expect(await ports.coordination.liveDigest(ACCOUNT)).toBe(UNREADABLE_LIVE);
    expect(await ports.coordination.liveCount(ACCOUNT)).toBe(0);
    expect(await ports.coordination.baselineDigest(ACCOUNT)).toBe(
      UNREADABLE_BASELINE,
    );
    await expect(
      ports.coordination.releaseFence(ACCOUNT, "op"),
    ).resolves.toBeUndefined();
  });
  test("a failed load is retried on the next call (offline, a chunk not cached yet)", async () => {
    const o = origin();
    let attempts = 0;
    const ports = createDataDeletionPorts({
      host: o.idb.hostForPage("A"),
      registry: o.registry,
      loadImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return o.impl;
      },
    });
    expect((await ports.localWork.summarise(ACCOUNT)).digest).toBe(
      UNREADABLE_SUMMARY,
    );
    expect((await ports.localWork.summarise(ACCOUNT)).digest).toBe(
      EMPTY_DIGEST,
    );
    expect(attempts).toBe(2);
  });
  test("the database port needs no lazy chunk at all", async () => {
    const o = origin();
    const ports = createDataDeletionPorts({
      host: o.idb.hostForPage("A"),
      registry: o.registry,
      loadImpl: async () => {
        throw new Error("never loaded");
      },
    });
    await o.create();
    expect(await ports.database.exists(ACCOUNT)).toBe(true);
    expect(await ports.database.delete(ACCOUNT)).toBe("deleted");
  });
});

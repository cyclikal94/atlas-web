// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  HOLD_LOCK_PREFIX,
  LEDGER_DATABASE,
} from "../../src/data/store/quota-ledger";
import { createProductionQuota } from "../../src/data/ui/production-quota";
import { createWebLocksPort } from "../../src/session";
import { LOCKS } from "../../src/session/constants";
import { rawIdb } from "../support/data/raw-idb";
import { FakeWebLocks } from "../support/data/web-locks";

/**
 * R28 (revision 15) through the application's own composition: the REAL ownership adapter (`createWebLocksPort`, its `tryAcquire` and
 * `probe`) and the REAL IndexedDB ledger (`createIdbLedger`), over a model of the origin's Web Locks and a model of IndexedDB, with one
 * lock manager per page. What a module-level double of the ledger's owners cannot show: that the lock is named and claimed the way the
 * ledger's record says it is, that it is taken before the hold is written and given up after the record has been rewritten, that
 * nothing ever calls `query()` (lint R2: the model throws if anything does), and that a destroyed page's locks free its holds.
 * FIXTURE evidence: the models are test support; the real engines' own locks and IndexedDB are exercised by the real-engine specs.
 */
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
/** An estimate lifetime: how long the bytes of a reclaimed hold are counted as landed (revision 16). */
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const storage = (free: number) => ({
  estimate: async () => ({ usage: 0, quota: free }),
});

interface Stored {
  holds: Record<string, { bytes: number; until: number; owned?: boolean }>;
  landed: { landed: number } | null;
}
const recordOf = (idb: ReturnType<typeof rawIdb>): Stored =>
  (idb.record(LEDGER_DATABASE, "ledger", "state") as Stored | undefined) ?? {
    holds: {},
    landed: null,
  };

function origin(free: number) {
  const idb = rawIdb();
  const locks = new FakeWebLocks();
  const clock = { t: 0 };
  const page = (name: string) =>
    createProductionQuota({
      storage: storage(free),
      factory: idb.factory,
      locks: createWebLocksPort(locks.forPage(name)),
      now: () => clock.t,
    });
  return { idb, locks, clock, page };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the lock that owns a hold", () => {
  test("its name never collides with a lock of the session protocol", () => {
    const names = [
      LOCKS.auth,
      LOCKS.attempt(1),
      LOCKS.lease("x"),
      LOCKS.issue("x"),
      LOCKS.wipe("a"),
      LOCKS.operation("x"),
    ];
    for (const name of names) {
      expect(name.startsWith(HOLD_LOCK_PREFIX)).toBe(false);
      expect(HOLD_LOCK_PREFIX.startsWith(name)).toBe(false);
    }
  });

  test("a reservation claims `atlas-quota-hold:<token>` before the record has it, flags the hold as owned, and keeps the lock until settled", async () => {
    const { idb, locks, page } = origin(FLOOR + 5_000_000);
    const guard = page("A");
    const held = await guard.reserve("input", 900_000);
    expect(held.verdict).toBe("ok");
    const [token] = Object.keys(recordOf(idb).holds);
    expect(locks.names()).toEqual([`${HOLD_LOCK_PREFIX}${token}`]);
    expect(recordOf(idb).holds[token as string]).toMatchObject({
      bytes: 900_000,
      owned: true,
    });
    // Only `ifAvailable` requests were made (the model refuses any other, and throws on `query()`).
    expect(locks.requests).toEqual([
      { page: "A", name: `${HOLD_LOCK_PREFIX}${token}`, granted: true },
    ]);
    held.settle("not_written");
    await vi.waitFor(() => expect(locks.names()).toEqual([]));
  });

  test("the lock is given up only AFTER the record has been rewritten: at the instant it is released, the hold is already out of the record", async () => {
    const { idb, locks, page } = origin(FLOOR + 5_000_000);
    const seen: Array<{ name: string; holds: number }> = [];
    locks.onRelease = (name) =>
      seen.push({ name, holds: Object.keys(recordOf(idb).holds).length });
    const held = await page("A").reserve("input", 900_000);
    expect(Object.keys(recordOf(idb).holds)).toHaveLength(1);
    held.settle("written");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.holds).toBe(0);
    expect(recordOf(idb).landed?.landed).toBe(900_000);
  });

  test("a refused reservation holds no lock, and the lock of one that could not be written is let go", async () => {
    const { idb, locks, page } = origin(FLOOR + 100);
    const refused = await page("A").reserve("input", 900_000);
    expect(refused).toMatchObject({ verdict: "refuse" });
    expect(refused.unestablished).toBeUndefined();
    // A release is not instantaneous (the lock manager publishes it a moment later): wait for it.
    await vi.waitFor(() => expect(locks.names()).toEqual([]));
    const failing = origin(FLOOR + 5_000_000);
    failing.idb.failOpen = 1_000;
    const unestablished = await failing.page("A").reserve("input", 900_000);
    expect(unestablished).toMatchObject({
      verdict: "refuse",
      unestablished: true,
    });
    await vi.waitFor(() => expect(failing.locks.names()).toEqual([]));
    expect(idb.record(LEDGER_DATABASE, "ledger", "state")).toBeUndefined();
  });

  test("a lock manager that fails admits nothing it could not keep: refused as unestablished, no hold in the record", async () => {
    const { idb, locks, page } = origin(FLOOR + 5_000_000);
    locks.failing = 1;
    const refused = await page("A").reserve("input", 900_000);
    expect(refused).toMatchObject({ verdict: "refuse", unestablished: true });
    expect(recordOf(idb).holds).toEqual({});
    expect(locks.names()).toEqual([]);
    expect((await page("A").reserve("input", 900_000)).verdict).toBe("ok");
  });
});

describe("the reclamation of a hold needs the owner proven over", () => {
  test("(adapted, revision 16) the review's schedule through the real adapter: the page is suspended past the lease, so the other page is refused; destroyed, its hold is reclaimed at once and its bytes land for one estimate lifetime", async () => {
    const { idb, locks, clock, page } = origin(FLOOR + 1_200_000);
    const a = page("A");
    const b = page("B");
    await a.reserve("input", 900_000);
    clock.t = LEASE + 1;
    // The lease is over and no timer of A has run (suspended, not destroyed): its lock is held.
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(Object.keys(recordOf(idb).holds)).toHaveLength(1);
    clock.t = 100 * LEASE;
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    // The page is destroyed: the platform releases its lock. That proves the hold over, not that nothing was written: the bytes move
    // into the landed ledger of the record (against the figure the hold recorded) and count for an estimate lifetime.
    locks.destroy("A");
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(recordOf(idb).holds).toEqual({});
    expect(recordOf(idb).landed?.landed).toBe(900_000);
    clock.t = 100 * LEASE + TTL;
    const admitted = await b.reserve("input", 900_000);
    expect(admitted.verdict).toBe("ok");
    expect(Object.values(recordOf(idb).holds)).toHaveLength(1);
    expect(locks.names()).toHaveLength(1);
    admitted.settle("not_written");
  });

  test("the proof asks the lock manager ONLY whether the lock could be taken (`ifAvailable`), once for each hold it counted, and never reads another page's state", async () => {
    const { locks, page } = origin(FLOOR + 1_200_000);
    const a = page("A");
    const b = page("B");
    await a.reserve("input", 900_000);
    const before = locks.requests.length;
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    const asked = locks.requests.slice(before);
    // B claimed its own (a new token), was refused, asked about A's hold (not available: A holds it), and let its own claim go.
    expect(asked.filter((request) => request.page === "B")).toHaveLength(2);
    expect(asked.filter((request) => !request.granted)).toHaveLength(1);
  });

  test("a proof that cannot be asked for proves nothing: a lock manager that fails the probe keeps the hold counted", async () => {
    const { idb, locks, clock, page } = origin(FLOOR + 1_200_000);
    const a = page("A");
    const b = page("B");
    await a.reserve("input", 900_000);
    const [token] = Object.keys(recordOf(idb).holds);
    clock.t = 10 * LEASE;
    // B can take its own claim, but the question about A's hold fails: neither a release nor a hold that stands is shown, so it counts.
    locks.failWhen = (_, name) => name === `${HOLD_LOCK_PREFIX}${token}`;
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(Object.keys(recordOf(idb).holds)).toHaveLength(1);
    locks.failWhen = null;
    locks.destroy("A");
    // Proven over now (and landed, not forgotten): the room is the other page's one estimate lifetime later.
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    clock.t = 10 * LEASE + TTL;
    expect((await b.reserve("input", 900_000)).verdict).toBe("ok");
  });

  test("(adapted, revision 16) a release that is not published yet proves nothing: the hold is kept, and reclaimed (and landed) once it is", async () => {
    const { idb, locks, clock, page } = origin(FLOOR + 1_200_000);
    const a = page("A");
    const b = page("B");
    const held = await a.reserve("input", 900_000);
    const latency = locks.delayReleases();
    // A's settlement cannot be applied (the record keeps the hold): A KEEPS its lock and offers it again; when it is closed it gives up
    // and lets go, but the release is not published.
    idb.failTransaction = 1_000;
    held.settle("not_written");
    await vi.waitFor(() =>
      expect(idb.failTransaction).toBeLessThanOrEqual(998),
    );
    a.close?.();
    await vi.waitFor(() =>
      expect(idb.failTransaction).toBeLessThanOrEqual(997),
    );
    idb.failTransaction = 0;
    expect(locks.names()).toHaveLength(1);
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    latency.publish();
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(recordOf(idb).holds).toEqual({});
    expect(recordOf(idb).landed?.landed).toBe(900_000);
    clock.t = TTL;
    expect((await b.reserve("input", 900_000)).verdict).toBe("ok");
  });

  test("(revision 16) a settlement that the record cannot take is offered again while the page lives, and the lock is kept for all that time", async () => {
    const { idb, locks, page } = origin(FLOOR + 1_200_000);
    const a = page("A");
    const b = page("B");
    const held = await a.reserve("input", 900_000);
    idb.failTransaction = 3;
    held.settle("written");
    await vi.waitFor(() => expect(idb.failTransaction).toBe(0));
    // The fourth try (the third was the first paced one) is taken: the hold is out of the record, the bytes are in it, and only then
    // is the lock let go.
    await vi.waitFor(() => expect(locks.names()).toEqual([]));
    expect(recordOf(idb).holds).toEqual({});
    expect(recordOf(idb).landed?.landed).toBe(900_000);
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
  });
});

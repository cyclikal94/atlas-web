// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  createHoldOwners,
  HOLD_LOCK_PREFIX,
  readLedger,
} from "../../src/data/store/quota-ledger";
import { fakeOrigin } from "../support/data/origin-ledger";

/**
 * R28 (revision 15): the OWNERSHIP of a hold. The review of revision 14 reproduced a hold being reclaimed under a writer that was only
 * suspended: A's 900,000-byte save was in the step before its commit (admitted, `live()` already read), the clock moved past the
 * 30-second lease without A's timers running (a frozen page, a throttled tab, a machine that slept), page B was admitted into the room
 * the lapsed hold had counted, and both landed (3,594,304 bytes left of a 4,194,304-byte floor). Time cannot tell a suspended page from a
 * dead one; a lock the page keeps can. Every hold of a ledger with owners is claimed BEFORE it exists and given up only AFTER its
 * settlement has been asked of the ledger, and a hold is reclaimed only when its owner is PROVEN to have let go (a destroyed page's
 * locks are released by the platform; a `false` proof proves nothing and keeps the hold).
 *
 * These tests drive guards over the model of the origin's ledger with ownership (`fakeOrigin`), the free space an injected estimate and a
 * clock the test moves. The same schedules through the real adapter over a model of Web Locks and of IndexedDB are in
 * `tests/data/production-quota-owners.test.ts`, and through the outbox's public `enqueue` and the engine's commit in
 * `tests/data/outbox-quota-origin.test.ts` and `tests/data/quota-cache-admission.test.ts`. FIXTURE evidence: no genuine quota is
 * exhausted, and no page is really frozen.
 */
const MIB = 1024 * 1024;
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
/** How long a landed write is counted (an estimate lifetime): what a hold that ended without its writer's word is counted for (revision 16). */
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const BODY = 900_000;
const ROOM_FOR_ONE = 1_200_000;

interface Clock {
  t: number;
}

function pageOver(
  origin: ReturnType<typeof fakeOrigin>,
  name: string,
  free: number,
  clock: Clock = { t: 0 },
  config: Partial<typeof DATA_CONFIG> = {},
): QuotaGuard {
  return createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: free }) },
    now: () => clock.t,
    ledger: origin.page(name).ledger,
    config: { ...DATA_CONFIG, ...config },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the ownership is claimed before the hold exists and given up after its settlement has been asked", () => {
  test("a reservation holds its ownership for as long as it is unsettled, and a refused one holds none", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + ROOM_FOR_ONE);
    const held = await a.reserve("input", BODY);
    expect(origin.claimed()).toHaveLength(1);
    const [token] = Object.keys(origin.state().holds);
    expect(origin.claimed()).toEqual([token]);
    expect(origin.state().holds[token as string]).toMatchObject({
      bytes: BODY,
      owned: true,
    });
    // Room for one: the second is refused, and takes nothing with it.
    const refused = await a.reserve("input", BODY);
    expect(refused.verdict).toBe("refuse");
    expect(origin.claimed()).toEqual([token]);
    held.settle("not_written");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect(origin.state().holds).toEqual({});
  });

  test("the ownership is given up only AFTER the settlement was applied: while the ledger is still being asked, the hold has its owner (the completion-notification delay)", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    const settlement = origin.delay("A");
    held.settle("written");
    // The write has landed, but the news has not reached the ledger yet (the settlement is delayed): the hold stands, and so does its owner.
    expect(origin.claimed()).toHaveLength(1);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    clock.t = 10 * LEASE;
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    settlement.release();
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    // The settlement left the landed bytes where every page can see them: still no room for a second save.
    expect(origin.state().landed?.landed).toBe(BODY);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
  });

  test("(adapted, revision 16) a settlement that cannot be applied (twice) KEEPS the ownership and is offered again: the hold stands, counted whole, until the ledger takes it", async () => {
    const origin = fakeOrigin();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    const held = await a.reserve("input", BODY);
    origin.fail("A", 1_000);
    held.settle("not_written");
    await vi.waitFor(() =>
      expect(origin.rejected("A")).toBeGreaterThanOrEqual(3),
    );
    // The owner has NOT let go (its word has not reached the ledger): nobody can prove the hold over, and it is counted whole.
    expect(origin.claimed()).toHaveLength(1);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    origin.heal("A");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect(origin.state().holds).toEqual({});
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("(revision 16) a settlement that is taken on the THIRD try (the reviewer's two rejections) takes the hold out and, for a write that landed, lands its bytes: nothing is lost on the way", async () => {
    for (const outcome of ["written", "not_written"] as const) {
      const origin = fakeOrigin();
      const free = FLOOR + ROOM_FOR_ONE;
      const a = pageOver(origin, "A", free);
      const b = pageOver(origin, "B", free);
      const held = await a.reserve("input", BODY);
      origin.fail("A", 2);
      held.settle(outcome);
      await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
      expect(origin.rejected("A")).toBe(2);
      expect(origin.state().holds).toEqual({});
      expect(origin.state().landed?.landed ?? 0).toBe(
        outcome === "written" ? BODY : 0,
      );
      // A written settlement keeps the room taken; a not-written one gives it back at once: the positive control for each.
      expect((await b.reserve("input", BODY)).verdict).toBe(
        outcome === "written" ? "refuse" : "ok",
      );
    }
  });
});

describe("a hold with a living owner is never reclaimed for the want of a renewal", () => {
  test("pre-transaction delay: the lease is long over, no timer ran, the page is alive: the other page is refused, however far the clock moved", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    for (const moved of [LEASE - 1, LEASE, LEASE + 1, 10 * LEASE, 1e9]) {
      clock.t = moved;
      expect((await b.reserve("input", BODY)).verdict, `+${moved}`).toBe(
        "refuse",
      );
    }
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    // The writer asked `live()` first and found it over (its lease, as it last confirmed it, has ended): it is admitted AGAIN, never
    // revived, and the old hold goes with its settlement.
    expect(held.live()).toBe(false);
    held.settle("not_written");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("in-progress commit: the writer passed `live()`, its page is suspended with the transaction running, the lease ends: the hold stands until the writer settles, and the landed bytes then count", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    expect(held.live()).toBe(true);
    clock.t = LEASE + 1;
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    // The page wakes, the transaction commits, and the settlement is applied: the room is gone for good (the landed ledger).
    held.settle("written");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect(origin.state().landed?.landed).toBe(BODY);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
  });

  test("lost renewal: every renewal is rejected for longer than a lease, and the page is still alive: the hold stands", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = FLOOR + ROOM_FOR_ONE;
    const clock: Clock = {
      get t() {
        return Date.now();
      },
      set t(_value: number) {
        throw new Error("moved by advancing the timers");
      },
    };
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    origin.fail("A", 1_000);
    await vi.advanceTimersByTimeAsync(3 * LEASE);
    // The writer stopped being live by itself (a third before the lease it last confirmed), but its hold was not taken from it.
    expect(held.live()).toBe(false);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    held.settle("not_written");
  });

  test("(adapted, revision 16) a hold is reclaimed on proof even before its lease ends: a page that was destroyed stops holding the room at once, and its bytes count as landed for one estimate lifetime, because it may have written them", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 1 };
    const free = FLOOR + ROOM_FOR_ONE;
    const dying = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    await dying.reserve("input", BODY);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    origin.page("A").die();
    // Reclaimed at once (no wait for the lease), but a destroyed page is not proof that its transaction did not commit: the hold is
    // moved into the landed ledger against the figure it was judged on, not deleted.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toMatchObject({ landed: BODY });
    // The estimate can show the bytes after its own lifetime: the room is the other page's again.
    clock.t = 1 + TTL;
    const admitted = await b.reserve("input", BODY);
    expect(admitted.verdict).toBe("ok");
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    expect(origin.claimed()).toHaveLength(1);
    admitted.settle("not_written");
  });

  test("(adapted, revision 16) dead owner, then the control: a page that is only suspended is not destroyed, and keeps its hold while a destroyed one's goes (its bytes landing)", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + 3_000_000;
    const suspended = pageOver(origin, "SUSPENDED", free, clock);
    const dying = pageOver(origin, "DEAD", free, clock);
    const b = pageOver(origin, "B", free, clock);
    await suspended.reserve("input", BODY);
    await dying.reserve("input", BODY);
    const [suspendedToken, deadToken] = Object.keys(origin.state().holds) as [
      string,
      string,
    ];
    clock.t = 10 * LEASE;
    origin.page("DEAD").die();
    // Room for exactly two of the three: the first is admitted by the first judgement, the second is refused, which makes B ask the owners.
    const first = await b.reserve("input", 1_200_000);
    expect(first.verdict).toBe("ok");
    expect((await b.reserve("input", 1_200_000)).verdict).toBe("refuse");
    // The verdicts alone cannot tell a hold that was reclaimed from one that stands (a landed byte counts like a held one for an estimate
    // lifetime, revision 16), so the record is read: the suspended page's hold STANDS, owned; the dead page's is gone and its bytes landed.
    const record = origin.state();
    expect(record.holds[suspendedToken]).toMatchObject({
      bytes: BODY,
      owned: true,
    });
    expect(record.holds[deadToken]).toBeUndefined();
    expect(record.landed?.landed).toBe(BODY);
    expect(record.landed?.settled).toEqual([deadToken]);
    first.settle("not_written");
  });

  test("(adapted, revision 16) a release that is not PUBLISHED yet proves nothing: the hold is kept until it is (premise P-lock-b), then reclaimed, and its bytes land", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    const latency = origin.delayReleases();
    // The settlement cannot be published; the page gives up offering it (it is closed), and lets go of the ownership, but the release
    // is not published yet.
    origin.fail("A", 1_000);
    held.settle("not_written");
    await vi.waitFor(() =>
      expect(origin.rejected("A")).toBeGreaterThanOrEqual(2),
    );
    a.close?.();
    await vi.waitFor(() =>
      expect(origin.rejected("A")).toBeGreaterThanOrEqual(3),
    );
    await vi.waitFor(() =>
      expect(Object.keys(origin.state().holds)).toHaveLength(1),
    );
    // The owner has let go, but nobody can tell yet: `false`, so the hold counts.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    latency.publish();
    // Published: the hold is proven over and reclaimed, and, nobody having said that nothing was written, its bytes count for the
    // estimate lifetime.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(BODY);
    clock.t = TTL;
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("a reservation older than `quotaHoldMaxAgeMs` is a leak: it stops being renewed, gives up its ownership, and is then reclaimed by the next judgement that needs the room", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = FLOOR + ROOM_FOR_ONE;
    const clock: Clock = {
      get t() {
        return Date.now();
      },
      set t(_value: number) {
        throw new Error("moved by advancing the timers");
      },
    };
    const max = 5 * LEASE;
    const a = pageOver(origin, "A", free, clock, { quotaHoldMaxAgeMs: max });
    const b = pageOver(origin, "B", free, clock, { quotaHoldMaxAgeMs: max });
    const leaked = await a.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(max - 1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    await vi.advanceTimersByTimeAsync(2 * LEASE);
    expect(leaked.live()).toBe(false);
    expect(origin.claimed()).toEqual([]);
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });
});

describe("what a failed claim, a lost answer and a refusal leave behind", () => {
  test("a ledger whose owners cannot be claimed admits nothing it could not keep: refused as unestablished, no hold, no ownership; the next claim works", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 20 * MIB);
    origin.failClaims("A", 1);
    const refused = await a.reserve("input", BODY);
    expect(refused).toMatchObject({ verdict: "refuse", unestablished: true });
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
    const next = await a.reserve("input", BODY);
    expect(next.verdict).toBe("ok");
    next.settle("not_written");
  });

  test("an unavailable estimate is still `unknown` when the claim fails (nothing to protect), and holds nothing", async () => {
    const origin = fakeOrigin();
    const blind = createQuotaGuard({
      storage: { estimate: async () => ({}) },
      now: () => 0,
      ledger: origin.page("A").ledger,
    });
    origin.failClaims("A", 1);
    const result = await blind.reserve("input", BODY);
    expect(result.verdict).toBe("unknown");
    expect(result.unestablished).toBeUndefined();
    expect(origin.claimed()).toEqual([]);
  });

  test("a call whose answer was LOST is asked again without counting the hold its earlier try made: with room for ONE save it is admitted, and there is one hold", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + ROOM_FOR_ONE);
    origin.loseAnswers("A", 1);
    const admitted = await a.reserve("input", BODY);
    expect(admitted.verdict).toBe("ok");
    expect(admitted.unestablished).toBeUndefined();
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    expect(origin.claimed()).toHaveLength(1);
    admitted.settle("not_written");
    await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
  });

  test("a refusal because the answer never came takes a hold the lost answer may have left out of the ledger again, and the ownership with it", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 20 * MIB);
    // Every try is applied and its answer lost: the guard gives up, and the hold that was made is taken out again (or proven over).
    origin.loseAnswers("A", DATA_CONFIG.quotaLedgerAttempts);
    const asked = a.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(10 * DATA_CONFIG.quotaLedgerWaitMs);
    expect(await asked).toMatchObject({
      verdict: "refuse",
      unestablished: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
  });

  test("the ordinary save asks nobody: owners are asked about only when a judgement refuses, `check` never asks, and the number asked is bounded", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + 2_000_000;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const first = await a.reserve("input", BODY);
    const second = await b.reserve("input", BODY);
    expect(second.verdict).toBe("ok");
    expect(origin.probes()).toBe(0);
    expect(await b.check("input", 1_000_000)).toBe("refuse");
    expect(origin.probes()).toBe(0);
    // Refused: the owners of the holds that were counted are asked, once each.
    expect((await b.reserve("input", 1_000_000)).verdict).toBe("refuse");
    expect(origin.probes()).toBe(2);
    first.settle("not_written");
    second.settle("not_written");
  });

  test("(adapted, revision 16) the work of a judgement is bounded: with many holds of one dead page it asks about at most 32, and the rest are reclaimed (and landed) by the next", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + 100;
    const dying = pageOver(origin, "DEAD", free, clock);
    const b = pageOver(origin, "B", free, clock);
    for (let i = 0; i < 40; i += 1) await dying.reserve("input", 1);
    origin.page("DEAD").die();
    expect(Object.keys(origin.state().holds)).toHaveLength(40);
    const before = origin.probes();
    const first = await b.reserve("input", 95);
    expect(origin.probes() - before).toBe(32);
    // 8 holds still count, 92 free: 95 does not fit. The 32 that were proven over are not deleted but landed (revision 16): they count
    // as the same 32 bytes, so the verdict does not change until their estimate lifetime ends.
    expect(first.verdict).toBe("refuse");
    expect(Object.keys(origin.state().holds)).toHaveLength(8);
    expect(origin.state().landed?.landed).toBe(32);
    // The next refused judgement asks about the rest, and lands them too.
    const before2 = origin.probes();
    expect((await b.reserve("input", 95)).verdict).toBe("refuse");
    expect(origin.probes() - before2).toBe(8);
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(40);
    // Every byte of the 40 stays counted until the estimate can show it; then the room is free.
    const small = await b.reserve("input", 50);
    expect(small.verdict).toBe("ok");
    small.settle("not_written");
    clock.t = TTL;
    const free95 = await b.reserve("input", 95);
    expect(free95.verdict).toBe("ok");
    free95.settle("not_written");
  });
});

describe("the ownership over a lock port", () => {
  const throwing = {
    tryAcquire: async () => {
      throw new Error("the lock manager failed");
    },
    probe: async () => {
      throw new Error("the lock manager failed");
    },
  };

  test("a lock manager that throws gives no ownership and proves nothing", async () => {
    const owners = createHoldOwners(throwing);
    expect(await owners.claim("t")).toBeNull();
    expect(await owners.released("t")).toBe(false);
  });

  test("a probe is a proof only when it is exactly `true` (the lock could be taken)", async () => {
    for (const [answer, proof] of [
      [true, true],
      [false, false],
      [undefined, false],
      ["yes", false],
    ] as const)
      expect(
        await createHoldOwners({
          tryAcquire: async () => null,
          probe: async () => answer as unknown as boolean,
        }).released("t"),
      ).toBe(proof);
  });

  test("the lock is named for the token, and the claim is the port's own handle (granted or not)", async () => {
    const seen: string[] = [];
    const handle = { release: () => undefined };
    const owners = createHoldOwners({
      tryAcquire: async (name) => {
        seen.push(name);
        return name.endsWith("taken") ? null : handle;
      },
      probe: async (name) => {
        seen.push(name);
        return true;
      },
    });
    expect(await owners.claim("free")).toBe(handle);
    expect(await owners.claim("taken")).toBeNull();
    await owners.released("free");
    expect(seen).toEqual([
      `${HOLD_LOCK_PREFIX}free`,
      `${HOLD_LOCK_PREFIX}taken`,
      `${HOLD_LOCK_PREFIX}free`,
    ]);
  });
});

describe("a ledger without owners, and a hold that has none, keep the lease semantics", () => {
  test("(adapted, revision 16) a hold without the flag lapses with its lease even on a ledger that has owners, and its bytes then land", async () => {
    const origin = fakeOrigin({
      holds: { legacy: { bytes: BODY, until: LEASE } },
      landed: null,
    });
    const clock: Clock = { t: LEASE - 1 };
    const b = pageOver(origin, "B", FLOOR + ROOM_FOR_ONE, clock);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    // The lease ends: the hold (it recorded no figure: a hold of an older build) lands against the reclaiming page's own, for one
    // estimate lifetime (revision 16), and only then is the room free.
    clock.t = LEASE;
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(BODY);
    clock.t = LEASE + TTL;
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("the stored record keeps the `owned` flag, and drops anything else under that name", () => {
    const stored = {
      holds: {
        a: { bytes: 1, until: 2, owned: true },
        b: { bytes: 1, until: 2, owned: "yes" },
        c: { bytes: 1, until: 2 },
        d: { bytes: -1, until: 2, owned: true },
      },
      landed: null,
    };
    expect(readLedger(stored)).toEqual({
      holds: {
        a: { bytes: 1, until: 2, owned: true },
        b: { bytes: 1, until: 2 },
        c: { bytes: 1, until: 2 },
      },
      landed: null,
    });
  });
});

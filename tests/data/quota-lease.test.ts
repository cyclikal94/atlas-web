// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import { createMemoryLedger } from "../../src/data/store/quota-ledger";
import { fakeOrigin } from "../support/data/origin-ledger";

/**
 * R28 (revision 14): a hold lasts as long as the write it admitted, and the write may begin only while it does; a ledger that cannot
 * answer means the other pages' promises are UNKNOWN, not zero.
 *
 * The review reproduced three schedules after revision 13 made the origin's ledger shared: a hold's lease ran out under a LIVE save
 * (the clock moved 30,001 ms while the save waited just before its transaction; a second save was admitted into the same room and both
 * were written, 3,594,304 bytes left of a 4,194,304-byte floor); the ledger of one page rejected a call and the guard judged on its own
 * accounting, so a 905,000-byte promise of another page counted as zero; and a sync response held while input saves used the space
 * (`tests/data/quota-cache-admission.test.ts`). These tests drive independent guards over a model of the origin's ledger
 * (`fakeOrigin`: one state, atomic operations, per-page order, injected delay, failure and hang), with the free space an injected estimate
 * and a clock the test moves. FIXTURE evidence: no genuine quota is exhausted and no real freeze happens.
 *
 * REVISION 15 (the review of revision 14, R28 again): a ledger that cannot answer no longer leaves a page to judge on its own accounting
 * with the write counted twice (`degraded`): that was a stand-in that bounded neither another page's outstanding write nor the number of
 * pages. A reservation is admitted only on an answer of the origin's ledger, and refused (`unestablished`) when none comes within a
 * bounded number of tries. And a hold with an OWNER (a Web Lock per hold in production, `owners` of the ledger) is never reclaimed for
 * the want of a renewal: the tests of the lease semantics below that need a hold to LAPSE by time run on a ledger without owners
 * (`owners: false`, an older double or a ledger of one realm: the lease alone), and the same schedules with owners are in
 * `tests/data/quota-owners.test.ts`. The original of this file is `.agtx/evidence/WEB-09a/revision-15/adapted/original/`.
 */
const MIB = 1024 * 1024;
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
/** The renewal period, and how long before the lease can end `live()` does. */
const THIRD = Math.floor(LEASE / 3);
/** How long a landed write is counted (an estimate lifetime): what a hold that ended without its writer's word is counted for. */
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const BODY = 900_000;

interface Clock {
  t: number;
}

function pageOver(
  origin: ReturnType<typeof fakeOrigin>,
  name: string,
  free: number,
  clock: Clock = { t: 0 },
  config: Partial<typeof DATA_CONFIG> = {},
  /** `owners: false`: a ledger whose holds are reclaimed by their leases alone (the lease semantics of revision 14). */
  options: { owners?: boolean } = {},
): QuotaGuard {
  return createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: free }) },
    now: () => clock.t,
    ledger: origin.page(name, options).ledger,
    config: { ...DATA_CONFIG, ...config },
  });
}
const LEASE_ONLY = { owners: false };

/** A clock that is the (faked) real one, for the tests in which the renewal timers run. */
const realClock = (): Clock => ({
  get t() {
    return Date.now();
  },
  set t(_value: number) {
    throw new Error("the faked clock is moved by advancing the timers");
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("`live()`: whether the write this reservation admitted may still begin", () => {
  test("it is live from the admission, and ends a third of a lease BEFORE the hold itself can lapse", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 1_000 };
    const a = pageOver(origin, "A", FLOOR + 5 * MIB, clock);
    const held = await a.reserve("input", BODY);
    expect(held.verdict).toBe("ok");
    expect(held.live()).toBe(true);
    clock.t = 1_000 + LEASE - THIRD - 1;
    expect(held.live()).toBe(true);
    // From here a write that began would be one the other pages stop counting before it can land.
    clock.t = 1_000 + LEASE - THIRD;
    expect(held.live()).toBe(false);
    // The hold itself is still in the ledger and still counts, for the whole of the margin.
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    clock.t = 1_000 + LEASE - 1;
    expect(
      (
        await pageOver(origin, "B", FLOOR + 1_200_000, clock).reserve(
          "input",
          BODY,
        )
      ).verdict,
    ).toBe("refuse");
  });

  test("a settled reservation is no longer live, whichever way it ended", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 5 * MIB);
    for (const outcome of ["written", "not_written"] as const) {
      const held = await a.reserve("input", BODY);
      expect(held.live()).toBe(true);
      held.settle(outcome);
      expect(held.live()).toBe(false);
    }
  });

  test("a refused reservation is never live and holds nothing", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 100);
    const refused = await a.reserve("input", BODY);
    expect(refused.verdict).toBe("refuse");
    expect(refused.live()).toBe(false);
    expect(origin.state().holds).toEqual({});
  });

  test("a hold that cannot outlive its page (the in-realm ledger) has no lease: live until it settles, with no timer", async () => {
    vi.useFakeTimers();
    const a = createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: FLOOR + 5 * MIB }) },
      now: () => Date.now(),
      ledger: createMemoryLedger(),
    });
    const held = await a.reserve("input", BODY);
    expect(held.verdict).toBe("ok");
    expect(held.unestablished).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * LEASE);
    expect(held.live()).toBe(true);
    held.settle("written");
    expect(held.live()).toBe(false);
  });
});

describe("a live writer keeps its hold: the lease is renewed for as long as the reservation is unsettled", () => {
  test("the hold is still in the ledger, and the other page still refused, long after one lease would have ended", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(THIRD);
      expect(held.live(), `after ${(i + 1) * THIRD} ms`).toBe(true);
    }
    // Four leases on: the page is still alive, so its promise still counts.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    const [hold] = Object.values(origin.state().holds);
    expect(hold?.bytes).toBe(BODY);
    expect((hold?.until ?? 0) - Date.now()).toBeGreaterThan(0);
    expect((hold?.until ?? 0) - Date.now()).toBeLessThanOrEqual(LEASE);
    held.settle("written");
    await vi.advanceTimersByTimeAsync(0);
    expect(origin.state().holds).toEqual({});
  });

  test("(adapted, revision 18) the control (a ledger without owners): a page that stops renewing (it died) stops holding the space when its last lease ends, and its bytes then count as landed for one estimate lifetime, for a page that is open throughout", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + 1_200_000;
    const dead = pageOver(origin, "A", free, clock, {}, LEASE_ONLY);
    // B is OPEN from the start (revision 18): a page that opens after a landing keeps it for a lifetime from its own start instead
    // (`tests/data/quota-new-page.test.ts`); this test is about the lifetime of the debit a lapsed lease leaves.
    const open = pageOver(origin, "B", free, clock);
    await dead.reserve("input", BODY);
    // No timer runs and nothing renews: the clock moves, as it does for a page that no longer exists.
    clock.t = LEASE - 1;
    expect((await open.reserve("input", BODY)).verdict).toBe("refuse");
    // The lease ended, but ending is not the same as the write not having happened: the hold becomes a landed debit, not nothing.
    clock.t = LEASE;
    expect((await open.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(BODY);
    // ...which the estimate can show after its own lifetime.
    clock.t = LEASE + TTL;
    expect((await open.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("the timer is the guard's alone, one for every reservation it holds, and it goes with the last settlement", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 20 * MIB, realClock());
    const first = await a.reserve("input", MIB);
    const second = await a.reserve("input", MIB);
    expect(vi.getTimerCount()).toBe(1);
    first.settle("not_written");
    expect(vi.getTimerCount()).toBe(1);
    second.settle("written");
    expect(vi.getTimerCount()).toBe(0);
    // A refused reservation arms nothing.
    const tight = pageOver(origin, "B", FLOOR + 100, realClock());
    await tight.reserve("input", MIB);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a renewal is the same atomic change of the ledger as every other: another page's change is never lost between them", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + 20 * MIB;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const mine = await a.reserve("input", MIB);
    const theirs = await b.reserve("input", 2 * MIB);
    await vi.advanceTimersByTimeAsync(THIRD);
    const holds = Object.values(origin.state().holds)
      .map((hold) => hold.bytes)
      .sort();
    expect(holds).toEqual([MIB, 2 * MIB]);
    mine.settle("not_written");
    theirs.settle("not_written");
  });

  test("a ledger that does not answer a renewal leaves the lease where it was: the writer stops being live by itself, a third before it ends", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const a = pageOver(origin, "A", FLOOR + 5 * MIB, clock);
    const held = await a.reserve("input", BODY);
    // Every ledger call of this page now rejects: the renewals cannot be made.
    origin.fail("A", 1_000);
    await vi.advanceTimersByTimeAsync(LEASE - THIRD - 1);
    expect(held.live()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.live()).toBe(false);
  });

  test("a renewal that fails once is made at the next tick, and the hold goes on", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const a = pageOver(origin, "A", FLOOR + 5 * MIB, clock);
    const held = await a.reserve("input", BODY);
    origin.fail("A", 1);
    for (let i = 0; i < 9; i += 1) await vi.advanceTimersByTimeAsync(THIRD);
    expect(held.live()).toBe(true);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    held.settle("not_written");
  });

  test("(adapted, revision 16) a reservation whose writer never began is a leak, not a save: after `quotaHoldMaxAgeMs` it stops being renewed, its permission to begin is revoked, and its hold is taken out as a write that did not happen", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + 1_200_000;
    const max = 5 * LEASE;
    const a = pageOver(origin, "A", free, clock, { quotaHoldMaxAgeMs: max });
    const b = pageOver(origin, "B", free, clock, { quotaHoldMaxAgeMs: max });
    const held = await a.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(max - THIRD);
    // Renewed until the age: the lease the ledger holds still reaches ahead. (Reading `live()` here would be the writer BEGINNING, which
    // is another test: the original of this one did, and a reservation whose writer began is never revoked by its age.)
    const [hold] = Object.values(origin.state().holds);
    expect((hold?.until ?? 0) - Date.now()).toBeGreaterThan(0);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    await vi.advanceTimersByTimeAsync(2 * LEASE);
    expect(held.live()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // Exact, not conservative: the writer could not begin, so nothing was written, and the hold goes without a landed debit.
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toBeNull();
    expect(origin.claimed()).toEqual([]);
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("(revision 16) a reservation whose writer BEGAN is never revoked by its age: the hold, its owner and its renewals stand until the writer's own settlement", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + 1_200_000;
    const max = 5 * LEASE;
    const a = pageOver(origin, "A", free, clock, { quotaHoldMaxAgeMs: max });
    const b = pageOver(origin, "B", free, clock, { quotaHoldMaxAgeMs: max });
    const held = await a.reserve("input", BODY);
    // The writer reads `live()` in the step that begins its transaction, and the transaction is still going on.
    expect(held.live()).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * max);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    // Still the same hold, still owned, still renewed (the lease the ledger holds reaches ahead of the clock).
    const [hold] = Object.values(origin.state().holds);
    expect(hold).toMatchObject({ bytes: BODY, owned: true });
    expect((hold?.until ?? 0) - Date.now()).toBeGreaterThan(0);
    expect(origin.claimed()).toHaveLength(1);
    // The transaction commits at last: the bytes land, and still hold the room against the other page.
    held.settle("written");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(BODY);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
  });
});

describe("a hold that was lost is never revived: the writer asks for admission again", () => {
  test("(adapted, revision 16) (a ledger without owners) the lease ran out while the page was not running (the clock moved past it with no timer): the other page is refused while the lapsed hold's bytes count as landed, admitted after the estimate lifetime, and the late renewal revives nothing", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const clock = realClock();
    const a = pageOver(origin, "A", free, clock, {}, LEASE_ONLY);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    // The page is suspended: its timers do not run while the clock does (the machine slept, or the page was frozen).
    vi.setSystemTime(Date.now() + LEASE + 1);
    expect(held.live()).toBe(false);
    // The lapsed hold is not deleted as though nothing was written (the page may have been about to write, or writing): its bytes land.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(BODY);
    // One estimate lifetime on, the estimate can show them, and the other page is admitted.
    vi.setSystemTime(Date.now() + TTL);
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    // The suspended page wakes and renews: its hold is gone from the ledger, and stays gone.
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(held.live()).toBe(false);
    expect(
      Object.values(origin.state().holds).every(
        (other) => other.bytes === BODY,
      ),
    ).toBe(true);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    held.settle("not_written");
  });

  test("(adapted, revision 16) (a ledger without owners) a hold that was lost stays lost, whatever the clock does afterwards (a clock moved back does not bring a removed hold back)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const clock = realClock();
    const a = pageOver(origin, "A", free, clock, {}, LEASE_ONLY);
    const b = pageOver(origin, "B", free, clock);
    const start = Date.now();
    const held = await a.reserve("input", BODY);
    vi.setSystemTime(start + LEASE + 1);
    // Another page's change takes the lapsed hold out (its bytes land, for the estimate lifetime: the room is not free yet), and the
    // page's own renewal finds it gone.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    await vi.advanceTimersByTimeAsync(THIRD);
    vi.setSystemTime(start + 1);
    expect(held.live()).toBe(false);
    held.settle("not_written");
  });

  test("(a ledger without owners) a lost reservation that nevertheless wrote still lands in the ledger of writes the estimate may not show", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free, clock, {}, LEASE_ONLY);
    const held = await a.reserve("input", BODY);
    clock.t = LEASE + 10;
    // Another page's change removes the lapsed hold.
    await pageOver(origin, "B", FLOOR + 5 * MIB, clock).check("input", 1);
    await pageOver(origin, "B", FLOOR + 5 * MIB, clock).reserve("input", 1);
    held.settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    expect(origin.state().landed?.landed).toBe(BODY);
  });
});

describe("a ledger that REJECTS a call is asked once more", () => {
  test("one rejection costs nothing of the origin-wide guarantee: the origin answers the second try, sees the other page's hold, and the refusal is a refusal for want of space", async () => {
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    const held = await a.reserve("input", 905_000);
    expect(held.verdict).toBe("ok");
    origin.fail("B", 1);
    const refused = await b.reserve("input", BODY);
    expect(refused.verdict).toBe("refuse");
    // Refused because the space is short (the origin answered), not because the accounting could not be established.
    expect(refused.unestablished).toBeUndefined();
    expect(origin.page("B").applied()).toBeGreaterThan(0);
    held.settle("not_written");
  });

  test("the control: with room for both, the page whose ledger rejected once is admitted, by the origin", async () => {
    const origin = fakeOrigin();
    const free = FLOOR + 2_500_000;
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    const held = await a.reserve("input", 905_000);
    origin.fail("B", 1);
    const admitted = await b.reserve("input", BODY);
    expect(admitted.verdict).toBe("ok");
    expect(Object.keys(origin.state().holds)).toHaveLength(2);
    held.settle("not_written");
    admitted.settle("not_written");
  });

  test("`check` is asked once more the same way", async () => {
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    await a.reserve("input", 905_000);
    origin.fail("B", 1);
    expect(await b.check("input", BODY)).toBe("refuse");
  });
});

describe("a ledger that cannot answer at all: nothing is admitted on a guess (revision 15)", () => {
  /**
   * Revision 14 judged a page whose ledger rejected twice on its own accounting, counting the write twice. The review's families show
   * that this bounds neither another page's outstanding write, nor the number of pages, nor the promise this page makes that no other
   * page can see (a locally admitted reservation is invisible to a healthy page). A reservation is now admitted only on an answer of the
   * origin's ledger: a rejected call is asked again (`quotaLedgerAttempts`, with a short doubling wait) and then the reservation is
   * REFUSED, saying `unestablished`. The reviewer's schedule: page A holds 905,000 bytes; page B's ledger rejects.
   */
  const ATTEMPTS = DATA_CONFIG.quotaLedgerAttempts;
  const schedule = async (extra: number, failures: number) => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = FLOOR + extra;
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    const held = await a.reserve("input", 905_000);
    origin.fail("B", failures);
    const asked = b.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(10 * DATA_CONFIG.quotaLedgerWaitMs);
    const result = await asked;
    held.settle("not_written");
    return { result, origin };
  };

  for (const extra of [1_200_000, 2_500_000, 20 * MIB])
    for (const failures of [ATTEMPTS, ATTEMPTS + 1, 100])
      test(`${failures} rejections (every try fails), room above the floor ${extra.toLocaleString("en-GB")}: refused as unestablished, nothing held, whatever the room`, async () => {
        const { result, origin } = await schedule(extra, failures);
        expect(result).toMatchObject({
          verdict: "refuse",
          unestablished: true,
        });
        expect(result.live()).toBe(false);
        // Only A's hold is in the ledger (it was settled after), and B holds no ownership of anything.
        await vi.advanceTimersByTimeAsync(0);
        expect(Object.keys(origin.state().holds)).toHaveLength(0);
        expect(origin.claimed()).toEqual([]);
        // The failed tries were made: the guard asked up to its bound and then gave up.
      });

  for (const failures of [1, 2, ATTEMPTS - 1])
    test(`${failures} rejection(s), fewer than the tries: the origin answers in the end, so the judgement is the origin-wide one, exactly (room for ONE: refused for want of space; room for BOTH: admitted)`, async () => {
      const one = await schedule(1_200_000, failures);
      expect(one.result.verdict).toBe("refuse");
      expect(one.result.unestablished).toBeUndefined();
      const both = await schedule(2_500_000, failures);
      expect(both.result.verdict).toBe("ok");
      expect(both.result.unestablished).toBeUndefined();
      both.result.settle("not_written");
    });

  test("the tries are bounded: a ledger that always rejects is asked exactly `quotaLedgerAttempts` times by one reservation, with a doubling wait", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 5 * MIB);
    origin.fail("A", 100);
    const asked = a.reserve("input", BODY);
    // The waits between tries: 20, 40 and 80 ms.
    const waits = [];
    for (let i = 1; i < ATTEMPTS; i += 1)
      waits.push(DATA_CONFIG.quotaLedgerRetryMs * 2 ** (i - 1));
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(500);
    let done = false;
    void asked.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(
      waits.reduce((sum, ms) => sum + ms, 0) - 1,
    );
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await asked).toMatchObject({
      verdict: "refuse",
      unestablished: true,
    });
    // The guard used exactly its tries, and then asked ONCE to take out a hold that a lost answer may have left (also rejected here).
    await vi.advanceTimersByTimeAsync(0);
    expect(origin.rejected("A")).toBe(ATTEMPTS + 1);
  });

  test("a ledger that does not ANSWER within the wait is refused the same way, and the change it gave up on is not applied late", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const tight = pageOver(origin, "A", FLOOR + 5 * MIB);
    const late = origin.hang("A");
    const pending = tight.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(DATA_CONFIG.quotaLedgerWaitMs);
    expect(await pending).toMatchObject({
      verdict: "refuse",
      unestablished: true,
    });
    late.arrive();
    await vi.advanceTimersByTimeAsync(0);
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
  });

  test("an unavailable ESTIMATE is another condition: the approved `unknown` stands (nothing to protect), whatever the ledger does", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const blind = createQuotaGuard({
      storage: {
        estimate: async () => {
          throw new Error("no estimate");
        },
      },
      now: () => 0,
      ledger: origin.page("A").ledger,
    });
    origin.fail("A", 100);
    const asked = blind.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(10 * DATA_CONFIG.quotaLedgerWaitMs);
    const result = await asked;
    expect(result.verdict).toBe("unknown");
    expect(result.unestablished).toBeUndefined();
    expect(result.live()).toBe(true);
    result.settle("written");
    expect(origin.claimed()).toEqual([]);
  });

  test("`check` stays advisory: it counts the promises it knows, assumes none it does not, and refuses nothing on a guess", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 2 * MIB);
    origin.fail("A", 100);
    // The same write a RESERVATION refuses (the ledger cannot answer) is not refused by the early check.
    expect(await a.check("input", 1_500_000)).toBe("ok");
    // ...and a write that does not fit by what is known is refused by it.
    expect(await a.check("input", 3 * MIB)).toBe("refuse");
  });

  test("(adapted, revision 16) what the origin last showed of the other pages is still counted by `check` while it cannot be read: an owned hold until its owner is proven over, an unowned one until its lease ends and then as a landed debit for one estimate lifetime", async () => {
    for (const owned of [true, false]) {
      const origin = fakeOrigin();
      const clock: Clock = { t: 0 };
      const free = FLOOR + 3_000_000;
      const a = pageOver(origin, "A", free, clock, {}, { owners: owned });
      const b = pageOver(origin, "B", free, clock);
      const held = await a.reserve("input", 2_000_000);
      // B reads the ledger once: it has seen A's 2,000,000-byte promise.
      expect(await b.check("input", 1)).toBe("ok");
      origin.fail("B", 100);
      // Unreachable now: A's promise, last seen, is still counted (1,000,000 is what is left above the floor).
      expect(await b.check("input", 1_200_000)).toBe("refuse");
      expect(await b.check("input", 900_000)).toBe("ok");
      // The lease ends (A did not renew: nothing ran). An unowned hold ends with it, and its bytes are then a landed debit (not nothing:
      // the page may have written); an owned one needs its owner proven over.
      clock.t = LEASE;
      expect(await b.check("input", 1_200_000)).toBe("refuse");
      // One estimate lifetime later the debit has lapsed in its turn (and is not landed again by every later call).
      clock.t = LEASE + TTL;
      expect(await b.check("input", 1_200_000)).toBe(owned ? "refuse" : "ok");
      held.settle("not_written");
    }
  });

  test("`check` counts a promise this page made while the origin answered (only the origin's record held it) and does not count one it settled", async () => {
    const origin = fakeOrigin();
    const free = FLOOR + 2_200_000;
    const a = pageOver(origin, "A", free);
    const earlier = await a.reserve("input", BODY);
    origin.fail("A", 100);
    // Unreachable: alone, 2 x 900,000 would fit into the 2,200,000 above the floor; with its own 900,000 outstanding, 1,500,000 does not.
    expect(await a.check("input", 1_500_000)).toBe("refuse");
    origin.heal("A");
    earlier.settle("not_written");
    await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
    origin.fail("A", 100);
    // Settled: what it last knew no longer holds it.
    expect(await a.check("input", 1_500_000)).toBe("ok");
  });

  test("the control: after the failures end (later recovery) the very next reservation is judged by the origin, counting every page", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    const held = await a.reserve("input", 905_000);
    origin.fail("B", ATTEMPTS);
    const failed = b.reserve("input", 100_000);
    await vi.advanceTimersByTimeAsync(10 * DATA_CONFIG.quotaLedgerWaitMs);
    expect(await failed).toMatchObject({
      verdict: "refuse",
      unestablished: true,
    });
    // Healthy again: 100,000 fits beside A's 905,000 in the 1,200,000 above the floor; BODY does not.
    const small = await b.reserve("input", 100_000);
    expect(small.verdict).toBe("ok");
    expect(small.unestablished).toBeUndefined();
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    small.settle("not_written");
    held.settle("not_written");
  });
});

describe("a settlement the ledger rejects is asked once more", () => {
  test("rejected once: the hold is removed (and the landed bytes recorded) by the second try", async () => {
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", FLOOR + 5 * MIB);
    const held = await a.reserve("input", BODY);
    origin.fail("A", 1);
    held.settle("written");
    await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("(adapted, revision 16) (a ledger with owners) rejected twice: the writer KEEPS its ownership and offers the settlement again, so the hold stands, counted whole, and is taken out exactly when the ledger takes the change", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    origin.fail("A", 1_000);
    held.settle("not_written");
    await vi.waitFor(() =>
      expect(origin.rejected("A")).toBeGreaterThanOrEqual(3),
    );
    // Unpublished: the hold is still in the ledger, still owned (nobody can prove it over), and still counted.
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    expect(origin.claimed()).toHaveLength(1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    // The ledger answers again: the next offer is taken, the hold goes without a landed debit (the writer said it wrote nothing).
    origin.heal("A");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toBeNull();
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("(adapted, revision 16) (a ledger without owners) rejected for good: the hold is left to lapse with its lease, the page no longer renews it, and its bytes then land", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + 1_200_000;
    const a = pageOver(origin, "A", free, clock, {}, LEASE_ONLY);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    origin.fail("A", 1_000);
    held.settle("not_written");
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    // Nobody renews it: it lapses at the end of the lease it had, and the page's offers of the settlement go on failing. A lapsed hold
    // is not nothing (revision 16): its bytes are a landed debit for one estimate lifetime.
    await vi.advanceTimersByTimeAsync(LEASE + 1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
    await vi.advanceTimersByTimeAsync(TTL);
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });
});

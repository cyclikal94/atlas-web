// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  landHold,
  readLedger,
  SETTLED_KEPT,
} from "../../src/data/store/quota-ledger";
import { fakeOrigin } from "../support/data/origin-ledger";

/**
 * R28 (revision 16): the bytes of a write that may have landed stay counted until something establishes otherwise, and a maximum age can
 * revoke only the permission to BEGIN.
 *
 * The review of revision 15 reproduced two schedules through the public outbox. (1) A completed write whose settlement could not reach the
 * ledger (both of its calls rejected): the owner then let go, a healthy page proved it, REMOVED the hold and admitted another write without
 * the already-written bytes ever entering the landed ledger (1,800,000 retained in room for 1,200,000: 3,594,304 bytes left of the
 * 4,194,304-byte floor). (2) An unfinished commit whose reservation reached `quotaHoldMaxAgeMs`: the renewal path treated every reservation
 * that old as a leak, untracked it and released its ownership, so the next page was admitted into a room a transaction was still going to
 * fill (the same 3,594,304). The invariant behind both: releasing a lock, letting a lease lapse or losing a page says the writer stopped
 * answering, never that it wrote nothing; only the writer's own `not_written`, or a reservation whose writer cannot begin any more, takes
 * bytes out of the account.
 *
 * These tests drive guards over the model of the origin's ledger with ownership (`fakeOrigin`), the free space an injected estimate and a
 * clock the test moves; the public outbox and the engine's commit are in `outbox-quota-lease.test.ts`, `outbox-quota-origin.test.ts` and
 * `quota-cache-admission.test.ts`, the real adapter in `production-quota-owners.test.ts`, real engines in the E-O6 native specs. PROTOCOL
 * evidence: no real quota is exhausted, no page is really frozen, and the estimate is an injected figure that never shows a write.
 */
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
const THIRD = Math.floor(LEASE / 3);
const MAX_AGE = DATA_CONFIG.quotaHoldMaxAgeMs;
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const BODY = 900_000;
const ROOM_FOR_ONE = 1_200_000;
const ROOM_FOR_BOTH = 2_500_000;

interface Clock {
  t: number;
}

function pageOver(
  origin: ReturnType<typeof fakeOrigin>,
  name: string,
  free: number,
  clock: Clock = { t: 0 },
  config: Partial<typeof DATA_CONFIG> = {},
  options: { owners?: boolean } = {},
): QuotaGuard {
  return createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: free }) },
    now: () => clock.t,
    ledger: origin.page(name, options).ledger,
    config: { ...DATA_CONFIG, ...config },
  });
}

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

describe("landHold: the one place a write's bytes enter the landed ledger", () => {
  test("a first landing is made against the figure the hold was judged on, and lasts one estimate lifetime from now", () => {
    expect(
      landHold(null, "t1", { bytes: 900, base: 5_000 }, 100, TTL, null),
    ).toEqual({
      base: 5_000,
      landed: 900,
      until: 100 + TTL,
      settled: ["t1"],
    });
  });

  test("a later landing adds to the entry, keeps its first base and moves its end to the latest", () => {
    const first = landHold(
      null,
      "t1",
      { bytes: 900, base: 5_000 },
      100,
      TTL,
      null,
    );
    expect(
      landHold(first, "t2", { bytes: 400, base: 4_000 }, 2_000, TTL, null),
    ).toEqual({
      base: 5_000,
      landed: 1_300,
      until: 2_000 + TTL,
      settled: ["t1", "t2"],
    });
  });

  test("it is ONCE PER HOLD: the same token again changes nothing (a settlement whose answer was lost, a hold another page already landed)", () => {
    const first = landHold(
      null,
      "t1",
      { bytes: 900, base: 5_000 },
      100,
      TTL,
      null,
    );
    const again = landHold(
      first,
      "t1",
      { bytes: 900, base: 5_000 },
      3_000,
      TTL,
      null,
    );
    expect(again).toBe(first);
  });

  test("a hold judged on no figure (`base: null`: the estimate was unavailable) has nothing to cap when there is no entry; an entry that exists still counts its bytes", () => {
    expect(
      landHold(null, "t1", { bytes: 900, base: null }, 100, TTL, 7_000),
    ).toBeNull();
    const existing = landHold(
      null,
      "t1",
      { bytes: 900, base: 5_000 },
      100,
      TTL,
      null,
    );
    expect(
      landHold(existing, "t2", { bytes: 100, base: null }, 200, TTL, null)
        ?.landed,
    ).toBe(1_000);
  });

  test("a hold that recorded no base (a hold of an older build) lands against the reclaiming page's own figure, or not at all without one", () => {
    expect(landHold(null, "t1", { bytes: 900 }, 100, TTL, 7_000)).toMatchObject(
      {
        base: 7_000,
        landed: 900,
      },
    );
    expect(landHold(null, "t1", { bytes: 900 }, 100, TTL, null)).toBeNull();
  });

  test("it remembers only the latest `SETTLED_KEPT` tokens, and never changes its input", () => {
    let landed = landHold(null, "t0", { bytes: 1, base: 9 }, 0, TTL, null);
    for (let i = 1; i < SETTLED_KEPT + 5; i += 1) {
      const before = JSON.stringify(landed);
      const next = landHold(
        landed,
        `t${i}`,
        { bytes: 1, base: 9 },
        0,
        TTL,
        null,
      );
      expect(JSON.stringify(landed)).toBe(before);
      landed = next;
    }
    expect(landed?.settled).toHaveLength(SETTLED_KEPT);
    expect(landed?.settled?.at(-1)).toBe(`t${SETTLED_KEPT + 4}`);
    expect(landed?.landed).toBe(SETTLED_KEPT + 5);
    // A token that has been forgotten is counted again: the safe direction.
    expect(
      landHold(landed, "t0", { bytes: 1, base: 9 }, 0, TTL, null)?.landed,
    ).toBe(SETTLED_KEPT + 6);
  });
});

describe("the stored record keeps `base` and `settled`, and nothing else under those names", () => {
  test("`base` is a figure or `null` (judged on none); anything else is as good as absent", () => {
    const record = readLedger({
      holds: {
        figure: { bytes: 1, until: 2, base: 10 },
        none: { bytes: 1, until: 2, base: null },
        text: { bytes: 1, until: 2, base: "10" },
        nan: { bytes: 1, until: 2, base: Number.NaN },
        negative: { bytes: 1, until: 2, base: -1 },
        absent: { bytes: 1, until: 2 },
      },
      landed: null,
    });
    expect(record.holds).toEqual({
      figure: { bytes: 1, until: 2, base: 10 },
      none: { bytes: 1, until: 2, base: null },
      text: { bytes: 1, until: 2 },
      nan: { bytes: 1, until: 2 },
      negative: { bytes: 1, until: 2 },
      absent: { bytes: 1, until: 2 },
    });
  });

  test("`settled` is a list of strings, at most the latest `SETTLED_KEPT`, and absent when empty", () => {
    const tokens = Array.from({ length: SETTLED_KEPT + 3 }, (_, i) => `t${i}`);
    const landed = (settled: unknown) =>
      readLedger({
        holds: {},
        landed: { base: 1, landed: 2, until: 3, settled },
      }).landed;
    expect(landed(tokens)?.settled).toEqual(tokens.slice(-SETTLED_KEPT));
    expect(landed(["a", 1, null, "b"])?.settled).toEqual(["a", "b"]);
    expect(landed([])).toEqual({ base: 1, landed: 2, until: 3 });
    expect(landed("a")).toEqual({ base: 1, landed: 2, until: 3 });
    expect(landed(undefined)).toEqual({ base: 1, landed: 2, until: 3 });
  });
});

/**
 * THE COMPLETED WRITE WHOSE SETTLEMENT DOES NOT REACH THE LEDGER. A is admitted, begins (`live()`), and settles; what its ledger does to the
 * settlement varies. Page B, healthy and with its own claim, then asks for a second body. THE RESERVE: the origin keeps the floor for
 * `atlas-auth` however the settlement fared (bytes of a write that landed are never forgotten); THE CONTROLS: with room for both, B is
 * admitted in every case (the accounting is not over-conservative: a settlement repeated for a lost answer counts once), and a `not_written`
 * settlement that is published gives the room back at once.
 */
describe("a settlement that does not reach the ledger leaves the bytes counted, whatever the ledger does", () => {
  type Behaviour =
    | "healthy"
    | "rejected twice"
    | "rejected until healed"
    | "silent until it arrives"
    | "answer lost"
    | "answers lost twice";
  const BEHAVIOURS: Behaviour[] = [
    "healthy",
    "rejected twice",
    "rejected until healed",
    "silent until it arrives",
    "answer lost",
    "answers lost twice",
  ];

  for (const outcome of ["written", "not_written"] as const)
    for (const behaviour of BEHAVIOURS)
      for (const roomy of [false, true])
        test(`${outcome}; ${behaviour}; room ${roomy ? "for both" : "for one"}`, async () => {
          const origin = fakeOrigin();
          const clock: Clock = { t: 0 };
          const free = FLOOR + (roomy ? ROOM_FOR_BOTH : ROOM_FOR_ONE);
          const a = pageOver(origin, "A", free, clock);
          const b = pageOver(origin, "B", free, clock);
          const held = await a.reserve("input", BODY);
          expect(held.verdict).toBe("ok");
          const [token] = Object.keys(origin.state().holds) as [string];
          // The writer begins its transaction, and it commits.
          expect(held.live()).toBe(true);
          let arrive: (() => void) | undefined;
          if (behaviour === "rejected twice") origin.fail("A", 2);
          if (behaviour === "rejected until healed") origin.fail("A", 1_000);
          if (behaviour === "silent until it arrives")
            arrive = origin.hang("A").arrive;
          if (behaviour === "answer lost") origin.loseAnswers("A", 1);
          if (behaviour === "answers lost twice") origin.loseAnswers("A", 2);
          held.settle(outcome);

          // While the settlement is on its way (or failing) the other page is judged with the bytes counted.
          // Healthy and lost-answer settlements are applied at once; the others are in doubt for a while.
          const unpublished =
            behaviour === "rejected until healed" ||
            behaviour === "silent until it arrives";
          if (unpublished) {
            await vi.waitFor(() =>
              expect(origin.rejected("A")).toBeGreaterThanOrEqual(
                behaviour === "rejected until healed" ? 3 : 0,
              ),
            );
            // Still the writer's: nobody can prove the hold over, and it counts whole.
            expect(origin.state().holds[token]).toMatchObject({ bytes: BODY });
            expect(origin.claimed()).toContain(token);
            const meanwhile = await b.reserve("input", BODY);
            expect(meanwhile.verdict).toBe(roomy ? "ok" : "refuse");
            meanwhile.settle("not_written");
            origin.heal("A");
            arrive?.();
          }
          await vi.waitFor(() => expect(origin.claimed()).not.toContain(token));
          await vi.waitFor(() =>
            expect(origin.state().holds[token]).toBeUndefined(),
          );

          // Quiescent: the hold is out of the ledger and its bytes are accounted exactly once, or not at all if the writer said so.
          const landed = origin.state().landed;
          if (outcome === "written") {
            expect(landed?.landed, behaviour).toBe(BODY);
            expect(landed?.settled).toContain(token);
          } else expect(landed, behaviour).toBeNull();

          const second = await b.reserve("input", BODY);
          if (roomy) expect(second.verdict, "no over-counting").toBe("ok");
          else
            expect(second.verdict, "the reserve").toBe(
              outcome === "written" ? "refuse" : "ok",
            );
          second.settle("not_written");
        });
});

describe("a page that is destroyed, closed or gives up leaves the bytes of its unpublished settlement counted", () => {
  test("destroyed while the settlement is unpublished: the hold is proven over by the next judgement and its bytes land, they are not deleted", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    expect(held.live()).toBe(true);
    origin.fail("A", 1_000);
    held.settle("written");
    await vi.waitFor(() =>
      expect(origin.rejected("A")).toBeGreaterThanOrEqual(2),
    );
    // The reviewer's schedule: the ledger refused the settlement, and the owner is gone.
    origin.page("A").die();
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toMatchObject({ landed: BODY });
    // The same bytes, not twice: a second judgement changes nothing.
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
    clock.t = TTL;
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("the offers of an unpublished settlement stop after a lease, the ownership is given up, and the hold is then landed by whoever needs the room", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    const [token] = Object.keys(origin.state().holds) as [string];
    origin.fail("A", 10_000);
    held.settle("written");
    await vi.advanceTimersByTimeAsync(LEASE / 2);
    // Offered again and again, paced, and the writer keeps its ownership throughout.
    expect(origin.rejected("A")).toBeGreaterThan(3);
    expect(origin.claimed()).toContain(token);
    await vi.advanceTimersByTimeAsync(
      LEASE + 4 * DATA_CONFIG.quotaLedgerWaitMs,
    );
    expect(origin.claimed()).not.toContain(token);
    const offers = origin.rejected("A");
    // A bounded number of offers (two quick tries, then a lease of paced waits), and none after the ownership was given up.
    expect(offers).toBeLessThan(60);
    await vi.advanceTimersByTimeAsync(10 * LEASE);
    expect(origin.rejected("A")).toBe(offers);
    // The hold is still in the ledger (it never got through); the next judgement that needs the room proves it over and lands it.
    expect(origin.state().holds[token]).toMatchObject({ bytes: BODY });
    origin.heal("A");
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("closing the guard stops the offers at once and lets go of the ownership: the bytes are landed by the next judgement", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    const [token] = Object.keys(origin.state().holds) as [string];
    origin.fail("A", 10_000);
    held.settle("written");
    await vi.advanceTimersByTimeAsync(500);
    expect(origin.claimed()).toContain(token);
    a.close?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(origin.claimed()).not.toContain(token);
    const offers = origin.rejected("A");
    await vi.advanceTimersByTimeAsync(5 * LEASE);
    expect(origin.rejected("A")).toBe(offers);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("late completion: the settlement is delayed past many leases, the owner stands, and the room stays taken before, during and after", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    expect(held.live()).toBe(true);
    const settlement = origin.delay("A");
    held.settle("written");
    clock.t = 100 * LEASE;
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    settlement.release();
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    clock.t = 100 * LEASE + 1;
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("a writer that settles a hold another page already landed (a ledger without owners: its lease lapsed) is counted once", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock, {}, { owners: false });
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    clock.t = LEASE + 1;
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
    held.settle("written");
    await vi.waitFor(() => expect(origin.rejected("A")).toBe(0));
    await vi.waitFor(() => expect(origin.writes()).toBeGreaterThanOrEqual(3));
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("the writer's own word decides its own hold: `not_written` after the lease lapsed (a ledger without owners) leaves no debit, `written` lands once", async () => {
    for (const outcome of ["not_written", "written"] as const) {
      const origin = fakeOrigin();
      const clock: Clock = { t: 0 };
      const free = FLOOR + ROOM_FOR_ONE;
      const a = pageOver(origin, "A", free, clock, {}, { owners: false });
      const held = await a.reserve("input", BODY);
      // No timer ran and nobody judged: the lease is over, but nothing has reclaimed the hold yet.
      clock.t = LEASE + 1;
      held.settle(outcome);
      await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
      expect(origin.state().landed?.landed ?? 0, outcome).toBe(
        outcome === "written" ? BODY : 0,
      );
    }
  });

  test("the landing is made against the figure the hold was judged on, not the reclaiming page's own: a page that sees more free space is still held to the cap the write was admitted under", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const a = pageOver(origin, "A", FLOOR + ROOM_FOR_ONE, clock);
    // B's estimate is far higher (space was freed meanwhile) and does not show A's bytes yet.
    const b = pageOver(origin, "B", FLOOR + 5_000_000, clock);
    await a.reserve("input", BODY);
    expect(Object.values(origin.state().holds)[0]).toMatchObject({
      base: FLOOR + ROOM_FOR_ONE,
    });
    origin.page("A").die();
    // A request that does not fit even beside B's own figure is refused, which makes B ask the owner and reclaim the hold: its bytes land
    // against A's figure (1,200,000 above the floor).
    expect((await b.reserve("input", 4_500_000)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toMatchObject({
      base: FLOOR + ROOM_FOR_ONE,
      landed: BODY,
    });
    // min(5,000,000, 1,200,000 - 900,000) above the floor is 300,000: a request that B's own figure would admit is refused for the
    // estimate lifetime, because the write was admitted under a figure that did not include it.
    expect((await b.reserve("input", 1_000_000)).verdict).toBe("refuse");
    clock.t = TTL;
    expect((await b.reserve("input", 1_000_000)).verdict).toBe("ok");
  });

  test("a hold of another page that recorded no figure (an older build) and lapses while this page SETTLES is landed against this reservation's own figure, not dropped", async () => {
    const free = FLOOR + ROOM_FOR_BOTH;
    const origin = fakeOrigin({
      holds: { legacy: { bytes: 400_000, until: THIRD } },
      landed: null,
    });
    const clock: Clock = { t: 0 };
    const a = pageOver(origin, "A", free, clock);
    const held = await a.reserve("input", BODY);
    // No timer runs (the clock is moved by hand): the legacy hold lapses between the admission and the settlement.
    clock.t = THIRD + 1;
    held.settle("written");
    await vi.waitFor(() =>
      expect(origin.state().landed?.landed).toBe(BODY + 400_000),
    );
    expect(origin.state().holds).toEqual({});
  });

  test("a hold of another page that recorded no figure (an older build) and lapses while this page RENEWS is landed against this reservation's own figure, not dropped", async () => {
    vi.useFakeTimers();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_BOTH;
    const origin = fakeOrigin({
      holds: { legacy: { bytes: 400_000, until: Date.now() + THIRD } },
      landed: null,
    });
    const a = pageOver(origin, "A", free, clock);
    const held = await a.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(THIRD + 1);
    // The renewal tick (a third of the lease) has just run and landed the lapsed legacy hold.
    expect(origin.state().landed?.landed).toBe(400_000);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    held.settle("not_written");
  });

  test("(adapted, revision 18) a landed entry that has expired is gone before a hold lands: the stale bytes are not carried into the new entry (for a page that has been open for more than two lifetimes)", async () => {
    const origin = fakeOrigin({
      holds: { lapsed: { bytes: BODY, until: 1, base: FLOOR + ROOM_FOR_ONE } },
      landed: { base: FLOOR + ROOM_FOR_ONE, landed: 500_000, until: 2 },
    });
    const clock: Clock = { t: 0 };
    // The page began at 0, a long time before it looks (revision 18): an entry stamped before a page began is retired no earlier than two
    // lifetimes after it did (`tests/data/quota-new-page.test.ts`), and a page that looks at the ledger for the first time much later has
    // long passed them.
    const b = pageOver(origin, "B", FLOOR + ROOM_FOR_ONE, clock);
    clock.t = 10 * LEASE;
    expect((await b.reserve("input", 100_000)).verdict).toBe("ok");
    // Only the lapsed hold's 900,000 are counted: the expired 500,000 are not added to it.
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("the approved `unknown` stands: a hold judged on no estimate lands nothing when it is reclaimed, and nothing throws", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const blind = createQuotaGuard({
      storage: { estimate: async () => ({}) },
      now: () => clock.t,
      ledger: origin.page("A").ledger,
    });
    const b = pageOver(origin, "B", FLOOR + ROOM_FOR_ONE, clock);
    const held = await blind.reserve("input", BODY);
    expect(held.verdict).toBe("unknown");
    expect(Object.values(origin.state().holds)[0]).toMatchObject({
      base: null,
    });
    origin.page("A").die();
    // B is refused at first for the room the blind hold counted; the same call proves the hold over and judges again. With no figure
    // there was nothing to cap, so no landed debit is made (the approved `unknown`: the write relied on its own failure), and B is admitted.
    const admitted = await b.reserve("input", BODY);
    expect(admitted.verdict).toBe("ok");
    expect(origin.state().landed).toBeNull();
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    admitted.settle("not_written");
  });
});

/**
 * AN AGE CAN ONLY REVOKE THE PERMISSION TO BEGIN. The review's guard-level schedule read `live()` (the writer beginning), moved the clock
 * the production `quotaHoldMaxAgeMs` through the real renewal timers, and found the second page admitted into the first writer's room.
 */
describe("a maximum age revokes the permission to begin, never the accounting of a write that has begun", () => {
  test("the review's schedule: a writer that BEGAN, at the production maximum age (and far beyond), with the real renewal ticks: the room stays taken", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    const [token] = Object.keys(origin.state().holds) as [string];
    expect(held.live()).toBe(true);
    const start = Date.now();
    for (const age of [MAX_AGE - THIRD, MAX_AGE, 3 * MAX_AGE]) {
      await vi.advanceTimersByTimeAsync(age - (Date.now() - start));
      const probe = await b.reserve("input", BODY);
      expect(probe.verdict, `at ${age}`).toBe("refuse");
    }
    // The hold, its owner and its renewals are all still there.
    expect(origin.state().holds[token]).toMatchObject({
      bytes: BODY,
      owned: true,
    });
    expect(origin.claimed()).toContain(token);
    expect(
      (origin.state().holds[token]?.until ?? 0) - Date.now(),
    ).toBeGreaterThan(0);
    // The transaction commits at last; the bytes land.
    held.settle("written");
    await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
    expect(origin.state().landed?.landed).toBe(BODY);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
  });

  test("the control: with room for both, the age changes nothing for the other page", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_BOTH;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    expect(held.live()).toBe(true);
    await vi.advanceTimersByTimeAsync(MAX_AGE + THIRD);
    const second = await b.reserve("input", BODY);
    expect(second.verdict).toBe("ok");
    second.settle("not_written");
    held.settle("not_written");
  });

  test("a writer that began and whose PAGE is then destroyed past the age: the hold is proven over and its bytes land, they are not erased", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    expect(held.live()).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * MAX_AGE);
    origin.page("A").die();
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
    await vi.advanceTimersByTimeAsync(TTL);
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("failed renewal: every renewal of a writer that BEGAN is rejected through the maximum age and beyond: the hold stands, owned and counted, and the first renewal the ledger takes finds it", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    const [token] = Object.keys(origin.state().holds) as [string];
    expect(held.live()).toBe(true);
    origin.fail("A", 100_000);
    await vi.advanceTimersByTimeAsync(MAX_AGE + 2 * THIRD);
    // Neither the failing renewals nor the age took anything: the hold, the lock and the room are still the writer's.
    expect(origin.state().holds[token]).toMatchObject({
      bytes: BODY,
      owned: true,
    });
    expect(origin.claimed()).toContain(token);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    origin.heal("A");
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(
      (origin.state().holds[token]?.until ?? 0) - Date.now(),
    ).toBeGreaterThan(0);
    expect(origin.claimed()).toContain(token);
    held.settle("written");
    await vi.waitFor(() => expect(origin.claimed()).not.toContain(token));
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("a writer that never began is a leak: at the age its permission is revoked for good and its hold goes as the write that did not happen (exact: no landed debit)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const leaked = await a.reserve("input", BODY);
    await vi.advanceTimersByTimeAsync(MAX_AGE - 1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toBeNull();
    expect(origin.claimed()).toEqual([]);
    // Permission to begin is gone for good, and reading it is not beginning.
    expect(leaked.live()).toBe(false);
    expect(leaked.live()).toBe(false);
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("`live()` that answers `false` begins nothing: a reservation whose lease was seen to end and that is then asked again is still revoked at the age", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const held = await a.reserve("input", BODY);
    // Every renewal fails: the lease the ledger holds is not extended, and `live()` ends by itself a third before it.
    origin.fail("A", 1_000);
    await vi.advanceTimersByTimeAsync(LEASE);
    expect(held.live()).toBe(false);
    origin.heal("A");
    await vi.advanceTimersByTimeAsync(MAX_AGE);
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toBeNull();
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("the revocation is published like any settlement: while the ledger will not take it the hold stands, owned and counted, and it goes when the ledger answers", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const free = FLOOR + ROOM_FOR_ONE;
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    const leaked = await a.reserve("input", BODY);
    const [token] = Object.keys(origin.state().holds) as [string];
    await vi.advanceTimersByTimeAsync(MAX_AGE - THIRD - 1);
    origin.fail("A", 1_000);
    await vi.advanceTimersByTimeAsync(2 * THIRD);
    expect(leaked.live()).toBe(false);
    expect(origin.state().holds[token]).toMatchObject({ bytes: BODY });
    expect(origin.claimed()).toContain(token);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    origin.heal("A");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(origin.state().holds[token]).toBeUndefined();
    expect(origin.claimed()).not.toContain(token);
    expect(origin.state().landed).toBeNull();
    expect((await b.reserve("input", BODY)).verdict).toBe("ok");
  });

  test("a revoked reservation whose writer nevertheless says `written` lands its bytes; saying `not_written` changes nothing", async () => {
    for (const outcome of ["written", "not_written"] as const) {
      vi.useFakeTimers();
      const origin = fakeOrigin();
      const clock = realClock();
      const a = pageOver(origin, "A", FLOOR + ROOM_FOR_ONE, clock);
      const leaked = await a.reserve("input", BODY);
      await vi.advanceTimersByTimeAsync(MAX_AGE + THIRD);
      expect(origin.state().holds).toEqual({});
      const writes = origin.writes();
      leaked.settle(outcome);
      await vi.advanceTimersByTimeAsync(0);
      expect(origin.state().landed?.landed ?? 0, outcome).toBe(
        outcome === "written" ? BODY : 0,
      );
      // Its end was published when it was revoked: a `not_written` after that asks the ledger for nothing.
      if (outcome === "not_written") expect(origin.writes()).toBe(writes);
      vi.useRealTimers();
    }
  });

  test("the age is a boundary: a reservation one millisecond short of it is still renewed, and one at it is revoked", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const config = { quotaHoldMaxAgeMs: 4 * THIRD };
    const a = pageOver(origin, "A", FLOOR + ROOM_FOR_ONE, clock, config);
    const held = await a.reserve("input", BODY);
    clock.t = 4 * THIRD - 1;
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    clock.t = 4 * THIRD;
    await vi.advanceTimersByTimeAsync(THIRD);
    expect(origin.state().holds).toEqual({});
    expect(held.live()).toBe(false);
  });

  test("a ledger without owners keeps a writer that began renewed past the age, too: the lease is extended while the transaction can still run", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock = realClock();
    const a = pageOver(
      origin,
      "A",
      FLOOR + ROOM_FOR_ONE,
      clock,
      {},
      { owners: false },
    );
    const b = pageOver(origin, "B", FLOOR + ROOM_FOR_ONE, clock);
    const held = await a.reserve("input", BODY);
    expect(held.live()).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * MAX_AGE);
    const [hold] = Object.values(origin.state().holds);
    expect(hold?.bytes).toBe(BODY);
    expect((hold?.until ?? 0) - Date.now()).toBeGreaterThan(0);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    held.settle("not_written");
  });
});

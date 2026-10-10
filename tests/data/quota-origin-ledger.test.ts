// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
  type QuotaReservation,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  createMemoryLedger,
  EMPTY_LEDGER,
  ledgerFor,
  readLedger,
} from "../../src/data/store/quota-ledger";
import { fakeOrigin } from "../support/data/origin-ledger";

/**
 * R28 (revision 13): what is promised to writes in flight and what has just landed is the ORIGIN's, not one page's.
 *
 * `held` and the landed-write ledger belonged to ONE `createQuotaGuard` closure, and production builds a separate guard for each
 * protected tree and page. Two pages over the same origin estimate each admitted a 900,000-byte save when the origin could hold one of
 * them above the floor kept for `atlas-auth`; a post-commit `data_changed` hint cannot prevent both being admitted first, and the
 * estimate may lag a write that has landed. The guard now judges and settles through a ledger that every page of the origin shares, each
 * judgement and each settlement ONE atomic change of it.
 *
 * These tests drive independent guards, each with its own page's handle on a model of the origin's ledger (`fakeOrigin`: one state,
 * atomic operations, per-page order, injected delay, failure and hang), with the free space as an injected estimate. The real
 * IndexedDB ledger has its own tests and real-engine specs. FIXTURE evidence: no genuine quota is exhausted.
 */
const MIB = 1024 * 1024;
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const FLOOR = RESERVE / 2;
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const LEASE = DATA_CONFIG.quotaHoldLeaseMs;

interface Clock {
  t: number;
}

/** One page: its own guard, its own estimate (a figure it may let go stale), and its own handle on the origin's ledger. */
function pageOver(
  origin: ReturnType<typeof fakeOrigin>,
  name: string,
  figure: { free: number },
  clock: Clock = { t: 0 },
  /** `owners: false`: a ledger whose holds are reclaimed by their leases alone (revision 14's semantics; see quota-owners.test.ts). */
  options: { owners?: boolean } = {},
): QuotaGuard {
  return createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: figure.free }) },
    now: () => clock.t,
    ledger: origin.page(name, options).ledger,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("two pages, one origin: the reviewer's schedule", () => {
  test("room for ONE 900,000-byte save above the floor: exactly one page is admitted, whichever judges first", async () => {
    for (const first of ["A", "B"]) {
      const origin = fakeOrigin();
      const free = { free: FLOOR + 1_200_000 };
      const a = pageOver(origin, "A", free);
      const b = pageOver(origin, "B", free);
      const delayed = origin.delay(first === "A" ? "B" : "A");
      const both = Promise.all([
        a.reserve("input", 900_000),
        b.reserve("input", 900_000),
      ]);
      // The page that is not delayed has been judged and holds its bytes; the other one arrives after it.
      await vi.waitFor(() => expect(origin.writes()).toBe(1));
      delayed.release();
      const [ra, rb] = await both;
      expect([ra.verdict, rb.verdict].sort(), `first ${first}`).toEqual([
        "ok",
        "refuse",
      ]);
      expect((first === "A" ? ra : rb).verdict).toBe("ok");
    }
  });

  test("the same two pages with room for BOTH are both admitted (the control: the ledger refuses nothing it need not)", async () => {
    const origin = fakeOrigin();
    const free = { free: FLOOR + 2_500_000 };
    const [ra, rb] = await Promise.all([
      pageOver(origin, "A", free).reserve("input", 900_000),
      pageOver(origin, "B", free).reserve("input", 900_000),
    ]);
    expect(ra.verdict).toBe("ok");
    expect(rb.verdict).toBe("ok");
  });

  test("a refused reservation holds nothing and writes nothing: the page that was refused can be admitted once the other settles without writing", async () => {
    const origin = fakeOrigin();
    const free = { free: FLOOR + 1_200_000 };
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    const held = await a.reserve("input", 900_000);
    const writesBefore = origin.writes();
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(origin.writes()).toBe(writesBefore);
    held.settle("not_written");
    await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
    expect((await b.reserve("input", 900_000)).verdict).toBe("ok");
  });

  test("three pages, room for two: two are admitted and the third refused, in any order of arrival", async () => {
    const orders = [
      ["A", "B", "C"],
      ["C", "B", "A"],
      ["B", "C", "A"],
    ];
    for (const order of orders) {
      const origin = fakeOrigin();
      const free = { free: FLOOR + 2_500_000 };
      const guards = new Map(
        ["A", "B", "C"].map((name) => [name, pageOver(origin, name, free)]),
      );
      const results: string[] = [];
      for (const name of order)
        results.push(
          (await (guards.get(name) as QuotaGuard).reserve("input", 1 * MIB))
            .verdict,
        );
      expect(results, order.join("")).toEqual(["ok", "ok", "refuse"]);
    }
  });

  test("a hold of ANOTHER page counts for an ordinary `check` too: the cache's admission sees the user input in flight", async () => {
    const origin = fakeOrigin();
    const free = { free: RESERVE + 3 * MIB };
    const writer = pageOver(origin, "A", free);
    const reader = pageOver(origin, "B", free);
    expect(await reader.check("cache", MIB)).toBe("ok");
    await writer.reserve("input", 2.5 * MIB);
    expect(await reader.check("cache", MIB)).toBe("refuse");
  });
});

describe("delayed estimates and delayed hints", () => {
  test("a page whose estimate LAGS (it never shows the other page's write) is still bound by the bytes that landed", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 1_200_000 };
    const a = pageOver(origin, "A", free, clock);
    // B's estimate is a stub that never moves: it reports the figure from before A wrote.
    const b = pageOver(origin, "B", { free: FLOOR + 1_200_000 }, clock);
    const mine = await a.reserve("input", 900_000);
    mine.settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    clock.t = 100;
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
  });

  test("no hint is needed: the other page never calls `invalidate`, and its CACHED estimate is the one from before", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 1_200_000 };
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    // B reads the estimate now (and caches it for one estimate lifetime), then A is admitted, then B asks again within the lifetime.
    expect(await b.check("input", 1)).toBe("ok");
    await a.reserve("input", 900_000);
    clock.t = TTL - 1;
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
  });

  test("an estimate that DOES show the other page's write is not counted twice (the cap is a minimum, not a sum)", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const state = { free: FLOOR + 3 * MIB };
    const a = pageOver(origin, "A", state, clock);
    const b = pageOver(origin, "B", { free: state.free }, clock);
    const first = await a.reserve("input", MIB);
    first.settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    // The browser has caught up for B: it reports exactly what the write left (floor + 2 MiB), and it is read afresh.
    const caught = pageOver(origin, "C", { free: FLOOR + 2 * MIB }, clock);
    clock.t = 1000;
    expect((await caught.reserve("input", 2 * MIB)).verdict).toBe("ok");
    // Counting the landed MiB again on top of an estimate that already shows it would refuse that.
    expect(
      (
        await pageOver(origin, "D", { free: FLOOR + 2 * MIB }, clock).reserve(
          "input",
          2 * MIB + 1,
        )
      ).verdict,
    ).toBe("refuse");
    void b;
  });

  test("the landed ledger ends one estimate lifetime after the LATEST write, for every page", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 1_200_000 };
    const a = pageOver(origin, "A", free, clock);
    const b = pageOver(origin, "B", free, clock);
    (await a.reserve("input", 900_000)).settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    clock.t = TTL - 1;
    expect(await b.check("input", 900_000)).toBe("refuse");
    clock.t = TTL;
    // The browser's own figure is trusted again, and a fresh read is made (B's cached estimate is older than a lifetime).
    expect(await b.check("input", 900_000)).toBe("ok");
  });

  test("an invalidation (another page's `data_changed`) drops the page's cached estimate and nothing of the ledger", async () => {
    const origin = fakeOrigin();
    const free = { free: FLOOR + 1_200_000 };
    const a = pageOver(origin, "A", free);
    const b = pageOver(origin, "B", free);
    await a.reserve("input", 900_000);
    b.invalidate();
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
  });
});

describe("a settlement is one atomic change", () => {
  test("the bytes of a write that lands are, at every moment another page can look, in the holds or in the landed ledger, never in neither", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 5 * MIB };
    const a = pageOver(origin, "A", free, clock);
    const reservation = await a.reserve("input", MIB);
    reservation.settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    const inHolds = (s: { holds: Record<string, { bytes: number }> }) =>
      Object.values(s.holds).some((hold) => hold.bytes === MIB);
    for (const { state } of origin.history)
      expect(
        inHolds(state) || (state.landed?.landed ?? 0) >= MIB,
        JSON.stringify(state),
      ).toBe(true);
    // And once settled the bytes are in exactly one of them.
    const last = origin.state();
    expect(inHolds(last)).toBe(false);
    expect(last.landed?.landed).toBe(MIB);
  });

  test("a settlement is idempotent, and `not_written` only releases the hold", async () => {
    const origin = fakeOrigin();
    const free = { free: FLOOR + 5 * MIB };
    const a = pageOver(origin, "A", free);
    const r = await a.reserve("input", MIB);
    r.settle("not_written");
    r.settle("written");
    await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
    expect(origin.state().landed).toBeNull();
  });
});

describe("a page that dies with a reservation outstanding", () => {
  test("(adapted, revision 16) (a ledger without owners) its hold stands while the lease runs and, when it ends, becomes a landed debit that frees the space one estimate lifetime later", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 1_000 };
    const free = { free: FLOOR + 1_200_000 };
    const dead = pageOver(origin, "A", free, clock, { owners: false });
    const living = pageOver(origin, "B", free, clock);
    await dead.reserve("input", 900_000);
    // The page never settles. The living page is refused for as long as the lease stands...
    clock.t = 1_000 + LEASE - 1;
    expect((await living.reserve("input", 900_000)).verdict).toBe("refuse");
    // ...and, when it has lapsed, its bytes are not forgotten (the page may have written them): the change that takes the stale hold out
    // lands them, and the living page is admitted once the estimate has had its lifetime to show them.
    clock.t = 1_000 + LEASE;
    expect((await living.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toMatchObject({ landed: 900_000 });
    clock.t = 1_000 + LEASE + TTL;
    const admitted = await living.reserve("input", 900_000);
    expect(admitted.verdict).toBe("ok");
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
  });

  test("(adapted, revision 16) (a ledger with owners) its hold stands for as long as the page lives, however long the clock has moved, and is reclaimed at once when the page is gone, its bytes landing for one estimate lifetime", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 1_000 };
    const free = { free: FLOOR + 1_200_000 };
    const dying = pageOver(origin, "A", free, clock);
    const living = pageOver(origin, "B", free, clock);
    await dying.reserve("input", 900_000);
    // The page is suspended, not gone: no timer ran, the lease is long over, and its owner still holds the lock.
    clock.t = 1_000 + 10 * LEASE;
    expect((await living.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
    // The page is destroyed: the platform releases its lock, which PROVES the hold over, and the next judgement reclaims it.
    origin.page("A").die();
    // ...and the next judgement reclaims it at once. A destroyed page is not proof that its transaction did not commit, so the bytes are
    // a landed debit, not nothing; the estimate can show them one lifetime on.
    expect((await living.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toMatchObject({ landed: 900_000 });
    clock.t = 1_000 + 10 * LEASE + TTL;
    const admitted = await living.reserve("input", 900_000);
    expect(admitted.verdict).toBe("ok");
    expect(Object.keys(origin.state().holds)).toHaveLength(1);
  });

  test("a write that outlives its lease is still counted when it lands (the landed ledger takes it)", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 1_200_000 };
    const slow = pageOver(origin, "A", free, clock);
    const other = pageOver(origin, "B", free, clock);
    const held = await slow.reserve("input", 900_000);
    clock.t = LEASE + 10;
    held.settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    expect(origin.state().landed?.landed).toBe(900_000);
    expect(await other.check("input", 900_000)).toBe("refuse");
  });

  test("(adapted, revision 17) an entry that ends further ahead than its own lifetime allows (the clock moved back since it was made) is not trusted for that long and is not dropped either: a skewed hold lands for one estimate lifetime and a skewed landed entry is CLAMPED to one lifetime from now, its bytes still counted", async () => {
    const origin = fakeOrigin({
      holds: {
        // Made when the clock read 10 hours later than it does now: it would stand for ten hours.
        skewed: { bytes: 900_000, until: 10 * 3_600_000 + LEASE },
      },
      landed: {
        base: FLOOR + 1_200_000,
        landed: 900_000,
        until: 10 * 3_600_000 + TTL,
      },
    });
    const clock: Clock = { t: 0 };
    const page = pageOver(origin, "A", { free: FLOOR + 1_200_000 }, clock);
    // The skewed hold's end cannot be trusted, but nor can its bytes be forgotten: they land for ONE estimate lifetime (not ten hours). The
    // skewed landed entry's end cannot be trusted either, and a step of the clock is no proof that its write is reflected in the estimate
    // (revision 16 DROPPED it, which is what R28b reproduced): it is clamped to one lifetime from now, written back, and its bytes stay
    // counted, so the hold's bytes join them.
    expect((await page.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toMatchObject({
      landed: 1_800_000,
      until: TTL,
    });
    clock.t = TTL;
    expect((await page.reserve("input", 900_000)).verdict).toBe("ok");
    // The edge of the lifetime check below starts again at the origin's time 0.
    clock.t = 0;
    // A hold at the edge of its lifetime still stands: the limit is the lease, not less.
    const edge = fakeOrigin({
      holds: { fine: { bytes: 900_000, until: LEASE } },
      landed: null,
    });
    const other = pageOver(edge, "B", { free: FLOOR + 1_200_000 }, clock);
    expect((await other.reserve("input", 900_000)).verdict).toBe("refuse");
  });

  test("a hold with a lapsed or impossible lease in a stored record is dropped, never trusted", () => {
    expect(
      readLedger({
        holds: {
          ok: { bytes: 1, until: 5 },
          negative: { bytes: -1, until: 5 },
          nan: { bytes: Number.NaN, until: 5 },
          text: { bytes: "1", until: 5 },
          noUntil: { bytes: 1 },
          infinite: { bytes: 1, until: Number.POSITIVE_INFINITY },
        },
        landed: { base: 1, landed: 2, until: 3 },
      }),
    ).toEqual({
      holds: { ok: { bytes: 1, until: 5 } },
      landed: { base: 1, landed: 2, until: 3 },
    });
    for (const damaged of [
      null,
      undefined,
      "x",
      7,
      [],
      { holds: 5, landed: 7 },
      { holds: null, landed: { base: 1 } },
    ])
      expect(readLedger(damaged)).toEqual(
        damaged && typeof damaged === "object" && !Array.isArray(damaged)
          ? { holds: {}, landed: null }
          : EMPTY_LEDGER,
      );
  });
});

/**
 * ADAPTED in revision 15 (R28; the originals are preserved in `.agtx/evidence/WEB-09a/revision-15/adapted/original/`, and revision 14's
 * adaptations in `revision-14/adapted/original/`). Revision 13 answered a rejected call from the guard's own accounting (every other
 * page's promise counted as ZERO); revision 14 counted the write twice instead. The review of revision 14 showed that neither bounds
 * another page's outstanding write, the number of pages, or the promise the page makes that no other page can see (a locally admitted
 * reservation is invisible to a healthy page), so a reservation is now admitted ONLY on an answer of the origin's ledger and is refused
 * (`unestablished`) when none comes within `quotaLedgerAttempts` tries. The intent of each test below is kept as far as it still applies:
 * what the origin did not hear is not promised, the next call uses the origin's again, `check` stays advisory, a change given up on is not
 * applied late, and a silent ledger is used again once it answers. What changed is the outcome of the call that could not be answered.
 */
describe("when the origin's ledger cannot answer, the page admits nothing it could not count, and says so (adapted, revision 15)", () => {
  const ATTEMPTS = DATA_CONFIG.quotaLedgerAttempts;
  /** Lets the waits between tries and the ledger's own wait pass (the timers are fake). */
  const letPass = () =>
    vi.advanceTimersByTimeAsync(10 * DATA_CONFIG.quotaLedgerWaitMs);

  test("a ledger that REJECTS every try: the reservation is refused and says it could not be established, nothing is held, and the next call uses the origin's again (adapted)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = { free: FLOOR + 2_200_000 };
    const a = pageOver(origin, "A", free);
    // The tries of one call, and the one removal of a hold a lost answer may have left.
    origin.fail("A", ATTEMPTS + 1);
    const asked = a.reserve("input", 900_000);
    await letPass();
    const first = await asked;
    expect(first).toMatchObject({ verdict: "refuse", unestablished: true });
    expect(first.live()).toBe(false);
    expect(origin.writes()).toBe(0);
    expect(origin.claimed()).toEqual([]);
    // Nothing was promised, here or at the origin: the next call is judged by the origin, with the whole room.
    const again = await a.reserve("input", 900_000);
    expect(again.verdict).toBe("ok");
    expect(again.unestablished).toBeUndefined();
    expect(origin.writes()).toBe(1);
    again.settle("not_written");
  });

  test("what was refused for want of an answer promised nothing: neither the next reservation nor `check` counts it, and the next one is admitted (adapted)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const free = { free: FLOOR + 1_900_000 };
    const a = pageOver(origin, "A", free);
    origin.fail("A", ATTEMPTS + 1);
    const asked = a.reserve("input", 900_000);
    await letPass();
    expect((await asked).unestablished).toBe(true);
    // Revision 14 counted the unanswered 900,000 bytes (the guard's own accounting still held them); there is none now.
    expect(await a.check("input", 1_100_000)).toBe("ok");
    const next = await a.reserve("input", 1_100_000);
    expect(next.verdict).toBe("ok");
    next.settle("not_written");
  });

  test("`check` falls back the same way (adapted: two rejections; it is advisory, so it counts what it knows and assumes nothing more)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", { free: FLOOR + 2 * MIB });
    origin.fail("A", 2);
    // 1 MiB fits into the 2 MiB above the floor.
    const first = a.check("input", MIB);
    await letPass();
    await expect(first).resolves.toBe("ok");
    origin.fail("A", 2);
    const second = a.check("input", 3 * MIB);
    await letPass();
    await expect(second).resolves.toBe("refuse");
  });

  test("a ledger that does not ANSWER within the wait: the reservation is refused, and the change it gave up on is not applied late (adapted)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 2_200_000 };
    const a = pageOver(origin, "A", free, clock);
    const late = origin.hang("A");
    // The outcome is RECORDED, not awaited: a guard that never gives up on the origin would leave this call pending for ever, and the
    // test must fail by an assertion about that, not by a timeout.
    let first: QuotaReservation | null = null;
    void a.reserve("input", 900_000).then((r) => {
      first = r;
    });
    await vi.advanceTimersByTimeAsync(DATA_CONFIG.quotaLedgerWaitMs);
    expect(first, "answered once the wait ended").not.toBeNull();
    expect(first as unknown as QuotaReservation).toMatchObject({
      verdict: "refuse",
      unestablished: true,
    });
    // The change that reaches the origin afterwards applies nothing, so no phantom promise is left to refuse other pages.
    late.arrive();
    await letPass();
    expect(origin.state().holds).toEqual({});
    expect(origin.writes()).toBe(0);
    expect(origin.claimed()).toEqual([]);
    // ...and another page is admitted by the origin as though the page had never asked.
    const b = pageOver(origin, "B", free, clock);
    expect((await b.reserve("input", 900_000)).verdict).toBe("ok");
  });

  test("a ledger that was silent is used again once it answers, with no skip window of a lease (adapted)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const free = { free: FLOOR + 5 * MIB };
    const a = pageOver(origin, "A", free, clock);
    const late = origin.hang("A");
    let first: QuotaReservation | null = null;
    void a.reserve("input", MIB).then((r) => {
      first = r;
    });
    await vi.advanceTimersByTimeAsync(DATA_CONFIG.quotaLedgerWaitMs);
    expect((first as unknown as QuotaReservation | null)?.unestablished).toBe(
      true,
    );
    // Revision 14 judged on its own for a whole lease after a silence. A silence is no reason to refuse for a lease: the very next
    // call asks the origin again (its page's calls enter in order, so it is answered once the hung one has been let go).
    late.arrive();
    await letPass();
    const third = await a.reserve("input", MIB);
    expect(third.verdict).toBe("ok");
    expect(third.unestablished).toBeUndefined();
    third.settle("not_written");
  });

  test("a ledger that answers in time is not raced against a timer that outlives the call (adapted: the one timer left is the renewal of the hold the page still has, and it goes with the settlement)", async () => {
    vi.useFakeTimers();
    const origin = fakeOrigin();
    const a = pageOver(origin, "A", { free: FLOOR + 5 * MIB });
    const held = await a.reserve("input", MIB);
    expect(vi.getTimerCount()).toBe(1);
    held.settle("not_written");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the in-realm ledger: guards over one estimate source agree", () => {
  const storage = (free: number) => ({
    estimate: async () => ({ usage: 0, quota: free }),
  });
  const over = (source: ReturnType<typeof storage>) =>
    createQuotaGuard({ storage: source, now: () => 0 });

  test("two independent guards over the SAME estimate source share what they have promised (the reviewer's probe, with no ledger passed)", async () => {
    const source = storage(FLOOR + 1_200_000);
    const [ra, rb] = await Promise.all([
      over(source).reserve("input", 900_000),
      over(source).reserve("input", 900_000),
    ]);
    expect([ra.verdict, rb.verdict].sort()).toEqual(["ok", "refuse"]);
  });

  test("guards over DIFFERENT estimate sources, or none, share nothing", async () => {
    const one = over(storage(FLOOR + 1_200_000));
    const two = over(storage(FLOOR + 1_200_000));
    expect((await one.reserve("input", 900_000)).verdict).toBe("ok");
    expect((await two.reserve("input", 900_000)).verdict).toBe("ok");
    expect(ledgerFor(undefined)).not.toBe(ledgerFor(undefined));
    const source = storage(1);
    expect(ledgerFor(source)).toBe(ledgerFor(source));
  });

  test("a memory ledger applies a settlement at once, so the very next judgement sees it", async () => {
    const guard = over(storage(FLOOR + 1_200_000));
    const r = await guard.reserve("input", 900_000);
    r.settle("not_written");
    expect((await guard.reserve("input", 900_000)).verdict).toBe("ok");
  });

  test("a memory ledger gives a change a copy: what it keeps is its own", async () => {
    const ledger = createMemoryLedger();
    await ledger.update((state) => {
      (state.holds as Record<string, unknown>).stolen = { bytes: 1, until: 1 };
      return { state: null, result: undefined };
    });
    expect(await ledger.peek((state) => state)).toEqual(EMPTY_LEDGER);
  });
});

describe("the guard hands the ledger back", () => {
  test("`close` closes what the page opened", () => {
    const origin = fakeOrigin();
    const guard = pageOver(origin, "A", { free: 1 });
    guard.close?.();
    expect(origin.closed).toEqual(["A"]);
  });

  test("`lastFree` reports the free space of the last judgement (after the landed cap)", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const guard = pageOver(origin, "A", { free: FLOOR + 5 * MIB }, clock);
    expect(guard.lastFree()).toBeNull();
    (await guard.reserve("input", MIB)).settle("written");
    await vi.waitFor(() => expect(origin.state().landed).not.toBeNull());
    await guard.check("input", 0);
    expect(guard.lastFree()).toBe(FLOOR + 4 * MIB);
  });

  test("overlapping reservations of one page behave as they did before the ledger was shared (the in-page schedule of R7)", async () => {
    const origin = fakeOrigin();
    const clock: Clock = { t: 0 };
    const guard = pageOver(origin, "A", { free: 6.5 * MIB }, clock);
    const held: QuotaReservation[] = [];
    held.push(await guard.reserve("input", MIB));
    held.push(await guard.reserve("input", MIB));
    for (const r of held) r.settle("written");
    await vi.waitFor(() => expect(origin.state().landed?.landed).toBe(2 * MIB));
    expect(await guard.check("input", MIB)).toBe("refuse");
  });
});

// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { LEDGER_DATABASE } from "../../src/data/store/quota-ledger";
import { createProductionQuota } from "../../src/data/ui/production-quota";
import { rawIdb } from "../support/data/raw-idb";

/**
 * R28 (revision 13): the application's own composition. `createProductionQuota` is what `DataProvider` and the real-engine harness
 * build, so these tests are about the WIRING that a module-level double of the ledger cannot show: that the production guard really
 * judges against the origin's IndexedDB record, that two pages (two guards over one IndexedDB) share it, and that without IndexedDB it
 * degrades to the page-local accounting, never to nothing.
 */
const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
const storage = (free: number) => ({
  estimate: async () => ({ usage: 0, quota: free }),
});

describe("the production guard is wired to the origin's ledger", () => {
  test("a reservation is recorded in the IndexedDB record that every page reads, and settling removes it", async () => {
    const idb = rawIdb();
    const guard = createProductionQuota({
      storage: storage(FLOOR + 5_000_000),
      factory: idb.factory,
    });
    expect(idb.opens).toBe(0);
    const reservation = await guard.reserve("input", 900_000);
    expect(reservation.verdict).toBe("ok");
    const stored = idb.record(LEDGER_DATABASE, "ledger", "state") as {
      holds: Record<string, { bytes: number }>;
    };
    expect(Object.values(stored.holds).map((hold) => hold.bytes)).toEqual([
      900_000,
    ]);
    reservation.settle("not_written");
    await vi.waitFor(() =>
      expect(
        (idb.record(LEDGER_DATABASE, "ledger", "state") as { holds: object })
          .holds,
      ).toEqual({}),
    );
  });

  test("two pages of one origin (two production guards over one IndexedDB), the same estimate, room for ONE save: exactly one is admitted", async () => {
    const idb = rawIdb();
    const page = () =>
      createProductionQuota({
        storage: storage(FLOOR + 1_200_000),
        factory: idb.factory,
      });
    const [a, b] = await Promise.all([
      page().reserve("input", 900_000),
      page().reserve("input", 900_000),
    ]);
    expect([a.verdict, b.verdict].sort()).toEqual(["ok", "refuse"]);
  });

  test("the control: with room for both, both pages are admitted", async () => {
    const idb = rawIdb();
    const page = () =>
      createProductionQuota({
        storage: storage(FLOOR + 2_500_000),
        factory: idb.factory,
      });
    const [a, b] = await Promise.all([
      page().reserve("input", 900_000),
      page().reserve("input", 900_000),
    ]);
    expect([a.verdict, b.verdict]).toEqual(["ok", "ok"]);
  });

  test("a page whose open of the ledger fails ONCE is answered by the origin's ledger all the same: the call is asked again (adapted, revisions 14 and 15)", async () => {
    // It was "answered from its own accounting" in revision 13 (the original is preserved in the revision-14 evidence); a single failure
    // is absorbed by the next try, which costs nothing of the origin-wide guarantee.
    const idb = rawIdb();
    idb.failOpen = 1;
    const guard = createProductionQuota({
      storage: storage(FLOOR + 1_200_000),
      factory: idb.factory,
    });
    const first = await guard.reserve("input", 900_000);
    expect(first.verdict).toBe("ok");
    expect(first.unestablished).toBeUndefined();
    expect((await guard.reserve("input", 900_000)).verdict).toBe("refuse");
    expect(
      Object.keys(
        (idb.record(LEDGER_DATABASE, "ledger", "state") as { holds: object })
          .holds,
      ),
    ).toHaveLength(1);
  });

  test("a page whose open fails on fewer tries than it makes is answered by the origin too (the bound is `quotaLedgerAttempts`)", async () => {
    const idb = rawIdb();
    idb.failOpen = DATA_CONFIG.quotaLedgerAttempts - 1;
    const guard = createProductionQuota({
      storage: storage(FLOOR + 1_200_000),
      factory: idb.factory,
    });
    const first = await guard.reserve("input", 900_000);
    expect(first.verdict).toBe("ok");
    expect(first.unestablished).toBeUndefined();
    first.settle("not_written");
  });

  test("a page that cannot reach the ledger at all (the open fails on every try) is REFUSED, says it could not be established, whatever the room, and holds nothing (adapted, revision 15)", async () => {
    // Revision 14: "answered from its own accounting, says it is degraded, and counts the write twice" (admitted when there was room
    // for both). A reservation is admitted only on an answer of the origin's ledger: nothing else can say what other pages promised.
    for (const room of [1_200_000, 2_500_000, 50_000_000]) {
      const idb = rawIdb();
      idb.failOpen = 100;
      const guard = createProductionQuota({
        storage: storage(FLOOR + room),
        factory: idb.factory,
      });
      const refused = await guard.reserve("input", 900_000);
      expect(refused).toMatchObject({ verdict: "refuse", unestablished: true });
      expect(refused.live()).toBe(false);
      expect(idb.record(LEDGER_DATABASE, "ledger", "state")).toBeUndefined();
    }
  });

  test("`close` lets go of the connection the guard opened", async () => {
    const idb = rawIdb();
    const guard = createProductionQuota({
      storage: storage(FLOOR + 5_000_000),
      factory: idb.factory,
    });
    await guard.check("input", 1);
    guard.close?.();
    await vi.waitFor(() => expect(idb.closed).toBe(1));
  });
});

/**
 * R28 (revision 14) through the application's own composition: the lease is renewed in the origin's IndexedDB record while the page
 * lives, the writer's permission to begin ends with it, and a second page is judged against the record as it stands.
 */
describe("the production guard keeps the lease of a live reservation, in the origin's IndexedDB record", () => {
  const LEASE = DATA_CONFIG.quotaHoldLeaseMs;
  const THIRD = Math.floor(LEASE / 3);
  const holdsOf = (idb: ReturnType<typeof rawIdb>) =>
    Object.values(
      (
        idb.record(LEDGER_DATABASE, "ledger", "state") as {
          holds: Record<string, { bytes: number; until: number }>;
        } | null
      )?.holds ?? {},
    );

  test("the stored lease moves on with the clock for as long as the reservation is unsettled, and the other page stays refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const idb = rawIdb();
      const page = () =>
        createProductionQuota({
          storage: storage(FLOOR + 1_200_000),
          factory: idb.factory,
          now: () => Date.now(),
        });
      const a = page();
      const held = await a.reserve("input", 900_000);
      const first = holdsOf(idb)[0]?.until ?? 0;
      await vi.advanceTimersByTimeAsync(THIRD + 100);
      await vi.waitFor(() =>
        expect(holdsOf(idb)[0]?.until ?? 0).toBeGreaterThan(first),
      );
      // Four leases on, the page is alive: its promise still counts, and the writer may still begin.
      for (let i = 0; i < 11; i += 1) await vi.advanceTimersByTimeAsync(THIRD);
      expect(held.live()).toBe(true);
      expect((await page().reserve("input", 900_000)).verdict).toBe("refuse");
      held.settle("not_written");
      await vi.waitFor(() => expect(holdsOf(idb)).toEqual([]));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("(adapted, revision 18) the review's schedule: the lease ran out under a writer that was still to begin; the second page, open since before, is refused while the lapsed hold's bytes count as landed, admitted one estimate lifetime later, and the first must be admitted again", async () => {
    const idb = rawIdb();
    const clock = { t: 0 };
    const page = () =>
      createProductionQuota({
        storage: storage(FLOOR + 1_200_000),
        factory: idb.factory,
        now: () => clock.t,
      });
    // The second page is OPEN from the start (revision 18): a page that opens after a landing cannot tell how long ago it landed, and is
    // kept to a debit for one lifetime from its own start (`tests/data/quota-new-page.test.ts`); this test is about the lifetime of the
    // debit itself, which a page that has been open throughout reads from the stamp.
    const watching = page();
    const first = await page().reserve("input", 900_000);
    expect(first.live()).toBe(true);
    clock.t = LEASE + 1;
    expect(first.live()).toBe(false);
    // The lapsed hold's bytes are a landed debit, not nothing (revision 16): the room is not free yet...
    expect((await watching.reserve("input", 900_000)).verdict).toBe("refuse");
    // ...but it is one estimate lifetime later.
    clock.t = LEASE + 1 + DATA_CONFIG.quotaEstimateTtlMs;
    const second = await watching.reserve("input", 900_000);
    expect(second.verdict).toBe("ok");
    second.settle("written");
    await vi.waitFor(() =>
      expect(
        (
          idb.record(LEDGER_DATABASE, "ledger", "state") as {
            landed: { landed: number } | null;
          }
        ).landed?.landed,
      ).toBe(900_000),
    );
    // The first writer is admitted again, against what was written meanwhile: no room is left for it.
    first.settle("not_written");
    expect((await page().reserve("input", 900_000)).verdict).toBe("refuse");
  });
});

describe("without IndexedDB", () => {
  test("the guard keeps the in-realm ledger of its estimate source: guards over one source agree, and nothing throws", async () => {
    const source = storage(FLOOR + 1_200_000);
    const page = () =>
      createProductionQuota({ storage: source, factory: null });
    const [a, b] = await Promise.all([
      page().reserve("input", 900_000),
      page().reserve("input", 900_000),
    ]);
    expect([a.verdict, b.verdict].sort()).toEqual(["ok", "refuse"]);
  });

  test("with no estimate source either (a worker, a browser without `navigator.storage`) every verdict is `unknown`, and a reservation still settles", async () => {
    const guard = createProductionQuota({
      storage: undefined,
      factory: null,
    });
    const reservation = await guard.reserve("input", 1);
    expect(reservation.verdict).toBe("unknown");
    reservation.settle("written");
  });

  test("with no estimate to protect the origin's ledger is never opened, even where IndexedDB exists", async () => {
    const idb = rawIdb();
    const guard = createProductionQuota({
      storage: undefined,
      factory: idb.factory,
    });
    await (await guard.reserve("input", 1)).settle("written");
    expect(await guard.check("input", 1)).toBe("unknown");
    expect(idb.opens).toBe(0);
    const noEstimate = createProductionQuota({
      storage: {},
      factory: idb.factory,
    });
    await noEstimate.reserve("input", 1);
    expect(idb.opens).toBe(0);
  });

  test("the defaults are the page's own: no options builds a guard over `navigator.storage` and `indexedDB` when they exist, and over nothing when they do not", async () => {
    const guard = createProductionQuota();
    expect(["ok", "unknown"]).toContain(await guard.check("input", 1));
  });
});

describe("the production guard follows the wall clock by the page's monotonic clock (R28, revision 17)", () => {
  test("with the page's own clocks a step of `Date.now()` is not time: the debit still caps the lagging estimate", async () => {
    const real = Date.now.bind(Date);
    let step = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + step);
    try {
      const idb = rawIdb();
      // Both pages exist BEFORE the step: each has the readings of both clocks to compare.
      const page = () =>
        createProductionQuota({
          storage: storage(FLOOR + 1_200_000),
          factory: idb.factory,
        });
      const a = page();
      const b = page();
      const first = await a.reserve("input", 900_000);
      expect(first.verdict).toBe("ok");
      first.settle("written");
      await vi.waitFor(() =>
        expect(
          (
            idb.record(LEDGER_DATABASE, "ledger", "state") as {
              landed: object | null;
            }
          ).landed,
        ).not.toBeNull(),
      );
      step = 3_600_000;
      expect((await b.reserve("input", 900_000)).verdict).toBe("refuse");
    } finally {
      spy.mockRestore();
    }
  });

  // REPLACES revision 17's second half of the test above (revision 18), which asserted that with a `now` named alone a step "is time
  // passing" and the second save is ADMITTED: an unsafe admission is not an expectation of the reserve. What the naming rule says is what
  // is asserted here: naming `now` names the WHOLE clock (a test moves time by moving `now`), so the page's real `performance.now()` is
  // not read for it. Production never names it: `DataProvider` builds `createProductionQuota()` with the page's own clocks.
  test("naming `now` alone names the whole clock: the page's own monotonic clock is not read for it, and `monotonic: null` says there is none", async () => {
    const reads = vi.spyOn(performance, "now");
    try {
      for (const options of [{ now: () => 1_000 }, { monotonic: null }]) {
        reads.mockClear();
        const guard = createProductionQuota({
          storage: storage(FLOOR + 1_200_000),
          factory: null,
          ...options,
        });
        await (await guard.reserve("input", 1)).settle("not_written");
        expect(
          reads,
          JSON.stringify(Object.keys(options)),
        ).not.toHaveBeenCalled();
      }
      reads.mockClear();
      const own = createProductionQuota({
        storage: storage(FLOOR + 1_200_000),
        factory: null,
      });
      await (await own.reserve("input", 1)).settle("not_written");
      expect(reads).toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });
});

describe("a production guard that opens after a step of the wall clock keeps the debit another page wrote (R28b, revision 18)", () => {
  for (const alive of [
    "the writing page is still open",
    "the writing page has closed",
  ])
    test(`${alive}: the second save is refused where it would not fit, and the debit is still in the origin's record`, async () => {
      const real = Date.now.bind(Date);
      let step = 0;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + step);
      try {
        const idb = rawIdb();
        const page = () =>
          createProductionQuota({
            storage: storage(FLOOR + 1_200_000),
            factory: idb.factory,
          });
        const a = page();
        const first = await a.reserve("input", 900_000);
        expect(first.verdict).toBe("ok");
        first.settle("written");
        const landed = (): { landed: number; until: number } | null =>
          (
            idb.record(LEDGER_DATABASE, "ledger", "state") as {
              landed: { landed: number; until: number } | null;
            }
          ).landed;
        await vi.waitFor(() => expect(landed()).not.toBeNull());
        const written = landed();
        step = 3_600_000;
        if (alive === "the writing page has closed") a.close?.();
        // The page that reads the ledger is CONSTRUCTED after the step: it has no earlier reading of either clock to compare.
        const late = page();
        expect((await late.reserve("input", 900_000)).verdict).toBe("refuse");
        expect(landed()).toEqual(written);
      } finally {
        spy.mockRestore();
      }
    });
});

// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import { type AgeWorld, ageWorld } from "../support/data/lagging-estimate";
import { type FakeOrigin, fakeOrigin } from "../support/data/origin-ledger";

/**
 * R28 (revision 17): the origin's reserve across the EXPIRY of a landed debit and across a step of the wall clock.
 *
 * The review of revision 16 reproduced two schedules through the public outbox. (a) Page A lands a 900,000-byte save; its debit expires at
 * 5,000 ms. Page B samples the lagging estimate at 4,999 ms and is refused, and at 5,001 ms it uses that SAME sample, the debit having
 * been deleted: the second save is admitted and 600,000 bytes are missing from the floor. A request that began before the debit expired
 * and was answered after it is the same. (b) A one-millisecond step of the wall clock backwards read as "this debit ends further ahead
 * than its lifetime allows" and deleted a fresh debit at once.
 *
 * The invariants: the bytes of a write that may have landed stay counted until no reading that could lack them can still be judged
 * (a reading is as old as its REQUEST, and a landing is kept one lifetime after its `until` for the readings that began before it), and a
 * step of a clock is never read as proof that a write is reflected in the estimate. The estimate here lags like the browser's (shows a
 * write only to a request made a lifetime after it landed, in REAL time: `ageWorld`), the ledger is the model of the origin's, and the
 * clocks are injected: PROTOCOL evidence, no native quota is exhausted and no clock is really altered. The review's own reproductions
 * (through the public outbox, separate account databases) are in `outbox-quota-estimate.test.ts`.
 */
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const FLOOR = RESERVE / 2;
const BODY = 900_000;
/** Room for ONE body above the floor, or for both. */
const room = (roomy: boolean): number =>
  FLOOR + (roomy ? 2_500_000 : 1_200_000);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Page `guard` reserves `bytes`, the write lands (the browser will show `shown` of it a lifetime from now: fewer than the ledger counts, when
 * a test needs to tell the browser's figure from the ledger's cap), and the ledger has taken the settlement.
 */
async function land(
  world: AgeWorld,
  origin: FakeOrigin,
  guard: QuotaGuard,
  bytes = BODY,
  shown = bytes,
): Promise<void> {
  const held = await guard.reserve("input", bytes);
  expect(held.verdict).toBe("ok");
  world.wrote(shown);
  held.settle("written");
  await vi.waitFor(() => {
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
  });
}

/** A reservation that was admitted gives its room back (the test only asked what the verdict is). */
async function release(
  origin: FakeOrigin,
  reservation: { verdict: string; settle(outcome: "not_written"): void },
): Promise<void> {
  if (reservation.verdict !== "ok") return;
  reservation.settle("not_written");
  await vi.waitFor(() => {
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
  });
}

describe("R28a: a reading is as old as its request, and a debit lasts as long as a reading that could need it", () => {
  for (const roomy of [false, true]) {
    const label = roomy ? "room for both" : "room for one";

    test(`the review's schedule: a reading taken inside the debit's lifetime is not used to spend the bytes after it (${label})`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      // B reads the estimate one millisecond before the debit ends; the browser does not show A's write yet.
      w.advance(TTL - 1);
      expect(await b.check("input", 1)).toBe("ok");
      const inside = await b.reserve("input", BODY);
      expect(inside.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, inside);
      // Two milliseconds later the debit has ended. B's reading is older than it, so it is not the one to spend the bytes on.
      w.advance(2);
      const after = await b.reserve("input", BODY);
      expect(after.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, after);
      // The estimate was asked again at that boundary, by a request that began after the debit's end (and so shows the write).
      expect(w.asked.B).toEqual([TTL - 1, TTL + 1]);
    });

    test(`a request that began inside the lifetime and was answered after it is not used either (${label})`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      w.advance(TTL - 1);
      const gate = w.hold();
      const second = b.reserve("input", BODY);
      await vi.waitFor(() => expect(w.asked.B).toEqual([TTL - 1]));
      // The answer is delivered after the debit has ended, but it answers what was true when the request began.
      w.advance(2);
      gate.release();
      const result = await second;
      expect(result.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, result);
      expect(w.asked.B).toEqual([TTL - 1, TTL + 1]);
    });

    test(`a request answered while the debit still stands is capped, and no second request is made (${label})`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      w.advance(1_000);
      const gate = w.hold();
      const pending = b.reserve("input", BODY);
      await vi.waitFor(() => expect(w.asked.B).toEqual([1_000]));
      w.advance(3_000);
      gate.release();
      const result = await pending;
      expect(result.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, result);
      expect(w.asked.B).toEqual([1_000]);
    });

    test(`control: a reading requested after the debit's end shows the write and is not capped a second time (${label})`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      w.advance(TTL + 1);
      const result = await b.reserve("input", BODY);
      expect(result.verdict).toBe(roomy ? "ok" : "refuse");
      // The browser's figure, as it is: the landed ledger (which counts the write with its own header bytes, here none) would have been
      // the same or smaller, and counting both would be counting the write twice.
      expect(b.lastFree()).toBe(room(roomy) - BODY);
      expect(w.asked.B).toEqual([TTL + 1]);
      await release(origin, result);
    });

    test(`the advisory check asks again at the boundary rather than refusing on a reading that predates the debit (${label})`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      w.advance(TTL - 1);
      expect(await b.check("input", 1)).toBe("ok");
      w.advance(2);
      // The engine stops with a storage-full notice on a refusal: a reading that predates the debit must not be what refuses it.
      expect(await b.check("input", roomy ? BODY : 300_000)).toBe("ok");
      expect(await b.check("input", BODY)).toBe(roomy ? "ok" : "refuse");
      expect(w.asked.B).toEqual([TTL - 1, TTL + 1]);
    });
  }

  test("the boundaries are exact: a reading requested AT the debit's end shows the write and is neither capped nor asked for again, and one that began a millisecond before it is replaced at the instant it ends (adapted, revision 18: the page that reserves at the end is open from the start, as a page that opens at the end keeps the debit for a lifetime of its own)", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const quota = room(true);
    const a = w.guard(origin, "A", quota);
    const b = w.guard(origin, "B", quota);
    const c = w.guard(origin, "C", quota);
    const d = w.guard(origin, "D", quota);
    // The browser shows 100,000 bytes LESS than the ledger counts, so the browser's figure and the ledger's cap are told apart.
    await land(w, origin, a, BODY, BODY - 100_000);
    w.advance(TTL - 1);
    expect(await c.check("input", 1)).toBe("ok");
    w.advance(1);
    // B's first reading begins exactly at `until`: the write is shown, the entry does not cap it, and no second request is made.
    expect(await b.check("input", 1)).toBe("ok");
    expect(w.asked.B).toEqual([TTL]);
    expect(b.lastFree()).toBe(quota - (BODY - 100_000));
    // C's reading began a millisecond before `until`; now is `until`: it is replaced, not used.
    expect(await c.check("input", 1)).toBe("ok");
    expect(w.asked.C).toEqual([TTL - 1, TTL]);
    expect(c.lastFree()).toBe(quota - (BODY - 100_000));
    // A reservation whose reading begins exactly at the end is admitted on it, with no second request (it is not asked for again, for ever).
    const admitted = await d.reserve("input", 1);
    expect(admitted.verdict).toBe("ok");
    expect(admitted.unestablished).toBeUndefined();
    expect(w.asked.D).toEqual([TTL]);
    await release(origin, admitted);
  });

  test("a reading is used for a lifetime and not a millisecond more", async () => {
    const w = ageWorld();
    const b = w.guard(fakeOrigin(), "B", room(true));
    await b.check("input", 1);
    w.advance(TTL - 1);
    await b.check("input", 1);
    expect(w.asked.B).toEqual([0]);
    w.advance(1);
    await b.check("input", 1);
    expect(w.asked.B).toEqual([0, TTL]);
  });

  test("the advisory check, when the ledger cannot be read at the boundary, still counts the debit it remembers on a reading that predates it (it asks for nothing it cannot judge)", async () => {
    for (const roomy of [false, true]) {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a, BODY, BODY - 100_000);
      w.advance(TTL - 1);
      expect(await b.check("input", 1)).toBe("ok");
      w.advance(2);
      origin.fail("B", 2);
      // The advisory fallback counts what the origin last showed: the debit (ended, and kept) caps the reading that began before it.
      expect(await b.check("input", BODY), `roomy ${roomy}`).toBe(
        roomy ? "ok" : "refuse",
      );
      expect(b.lastFree(), `roomy ${roomy}`).toBe(room(roomy) - BODY);
    }
  });

  test("the entry is kept one further lifetime after its `until`, and retired after it, so nothing is counted for ever", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(true));
    const b = w.guard(origin, "B", room(true));
    await land(w, origin, a);
    expect(origin.state().landed).toMatchObject({ landed: BODY, until: TTL });
    // After `until` the entry still stands, for the readings that began before it.
    w.advance(TTL + 1);
    await release(origin, await b.reserve("input", 1));
    expect(origin.state().landed).toMatchObject({ landed: BODY, until: TTL });
    // A lifetime after that no reading that could need it can be judged any more, and the next change retires it.
    w.advance(TTL);
    await release(origin, await b.reserve("input", 1));
    expect(origin.state().landed).toBeNull();
  });

  test("two landings: a reading requested between their ends is capped by both, and a new one is asked for after the later end", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const quota = FLOOR + 2_000_000;
    const a1 = w.guard(origin, "A1", quota);
    const a2 = w.guard(origin, "A2", quota);
    const b = w.guard(origin, "B", quota);
    await land(w, origin, a1);
    w.advance(3_000);
    await land(w, origin, a2);
    expect(origin.state().landed).toMatchObject({
      landed: 2 * BODY,
      until: 3_000 + TTL,
    });
    // At 6,000 ms the first write is shown and the second is not: only the cap knows of both.
    w.advance(3_000);
    const refused = await b.reserve("input", 300_000);
    expect(refused.verdict).toBe("refuse");
    await release(origin, await b.reserve("input", 150_000));
    // After the later end a new reading shows both.
    w.advance(2_001);
    expect((await b.reserve("input", 300_000)).verdict).toBe("refuse");
    await release(origin, await b.reserve("input", 150_000));
    expect(w.asked.B).toEqual([6_000, 8_001]);
  });

  test("invalidate drops the request on its way as well as the cache: the next judgement asks for a reading that begins after it", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false));
    const b = w.guard(origin, "B", room(false));
    const gate = w.hold();
    const old = b.check("input", 1);
    await vi.waitFor(() => expect(w.asked.B).toEqual([0]));
    w.advance(1);
    await land(w, origin, a);
    // Another page's `data_changed`: B must not read the answer of a request that began before the write.
    b.invalidate();
    const fresh = b.check("input", 1);
    const winner = await Promise.race([
      fresh.then(() => "answered"),
      sleep(100).then(() => "joined the old request"),
    ]);
    expect(winner).toBe("answered");
    expect(w.asked.B).toEqual([0, 1]);
    gate.release();
    await old;
    // The late answer was given to the call that waited for it and was not kept.
    await b.check("input", 1);
    expect(w.asked.B).toEqual([0, 1]);
  });

  test("an answer that arrives after an invalidation is returned to those waiting for it, and is never cached", async () => {
    const w = ageWorld();
    const b = w.guard(fakeOrigin(), "B", room(false));
    const gate = w.hold();
    const old = b.check("input", 1);
    await vi.waitFor(() => expect(w.asked.B).toEqual([0]));
    b.invalidate();
    gate.release();
    expect(await old).toBe("ok");
    expect(await b.check("input", 1)).toBe("ok");
    expect(w.asked.B).toEqual([0, 0]);
  });

  test("a reading that waited for the ledger longer than a lifetime is asked for again: it is never judged against entries that have gone", async () => {
    for (const roomy of [false, true]) {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      // B reads the estimate (it lags: the write is not shown) and its ledger call is held for longer than the debit and its retention.
      const slow = origin.delay("B");
      const pending = b.reserve("input", BODY);
      await vi.waitFor(() => expect(w.asked.B).toEqual([0]));
      w.advance(2 * TTL + 10);
      slow.release();
      const result = await pending;
      expect(result.verdict, `roomy ${roomy}`).toBe(roomy ? "ok" : "refuse");
      expect(w.asked.B).toEqual([0, 2 * TTL + 10]);
      await release(origin, result);
    }
  });

  test("a reservation that cannot be judged on a fresh reading within its tries is refused as unestablished, holds nothing, and is not a storage verdict", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    let t = 0;
    // Every reading of the clock is a lifetime later than the last: no reading is ever young enough when the ledger judges it.
    const guard = createQuotaGuard({
      storage: w.storage(room(true), "S"),
      now: () => {
        t += TTL;
        return t;
      },
      ledger: origin.page("S").ledger,
    });
    const result = await guard.reserve("input", 1_000);
    expect(result.verdict).toBe("refuse");
    expect(result.unestablished).toBe(true);
    expect(result.live()).toBe(false);
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
    expect(w.asked.S).toHaveLength(DATA_CONFIG.quotaLedgerAttempts);
  });

  for (const how of ["missing", "throwing"] as const)
    test(`${how} estimate: the approved \`unknown\` stands (nothing is capped, nothing is asked again, with a landed entry in the ledger)`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin({
        holds: {},
        landed: { base: room(false), landed: BODY, until: TTL },
      });
      let asked = 0;
      let t = 0;
      const guard = createQuotaGuard({
        storage:
          how === "missing"
            ? {}
            : {
                estimate: async () => {
                  asked += 1;
                  throw new Error("no estimate");
                },
              },
        // The clock moves a lifetime at every reading: a reading with a figure would be too old at every judgement.
        now: () => {
          t += TTL / 2;
          return t;
        },
        ledger: origin.page("A").ledger,
      });
      void w;
      const reserved = await guard.reserve("input", 50 * 1024 * 1024);
      expect(reserved.verdict).toBe("unknown");
      expect(await guard.check("input", 50 * 1024 * 1024)).toBe("unknown");
      if (how === "throwing") expect(asked).toBeGreaterThanOrEqual(1);
      reserved.settle("not_written");
    });

  test("input priority stands under the cap: with the same debit, the cache is refused where user input is still admitted", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const quota = RESERVE + 1_000_000;
    const a = w.guard(origin, "A", quota);
    const b = w.guard(origin, "B", quota);
    await land(w, origin, a);
    // Inside the lifetime (the cap on the lagging reading) and after it (the new reading): the same pair of verdicts.
    for (const advance of [1_000, TTL]) {
      w.advance(advance);
      expect(await b.check("cache", 200_000), `+${advance}`).toBe("refuse");
      expect(await b.check("input", 200_000), `+${advance}`).toBe("ok");
    }
  });

  test("the cache kind is judged on a new reading at the boundary too: a page that a reading from before the debit would have let through is refused, and a smaller one is admitted", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const quota = RESERVE + 1_000_000;
    const a = w.guard(origin, "A", quota);
    const b = w.guard(origin, "B", quota);
    await land(w, origin, a);
    w.advance(TTL - 1);
    expect(await b.check("cache", 1)).toBe("ok");
    w.advance(2);
    // The new reading shows A's 900,000 bytes: 100,000 bytes are left above the reserve.
    const small = await b.reserve("cache", 50_000);
    expect(small.verdict).toBe("ok");
    await release(origin, small);
    const refused = await b.reserve("cache", 150_000);
    expect(refused.verdict).toBe("refuse");
    expect(w.asked.B).toEqual([TTL - 1, TTL + 1]);
  });
});

describe("R28b: a step of the wall clock is no proof that a written byte is reflected in the estimate", () => {
  for (const roomy of [false, true]) {
    const label = roomy ? "room for both" : "room for one";

    test(`the review's schedule: one millisecond BACKWARDS does not delete a fresh debit (${label})`, async () => {
      const w = ageWorld(100_000);
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      expect(origin.state().landed?.until).toBe(100_000 + TTL);
      w.step(-1);
      const second = await b.reserve("input", BODY);
      expect(second.verdict).toBe(roomy ? "ok" : "refuse");
      // Not deleted: clamped to one lifetime from the reading, and written back.
      expect(origin.state().landed).toMatchObject({
        landed: BODY,
        until: 99_999 + TTL,
      });
      await release(origin, second);
    });

    test(`and one millisecond FORWARDS is ordinary time (${label})`, async () => {
      const w = ageWorld(100_000);
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      w.step(1);
      const second = await b.reserve("input", BODY);
      expect(second.verdict).toBe(roomy ? "ok" : "refuse");
      expect(origin.state().landed).toMatchObject({
        landed: BODY,
        until: 100_000 + TTL,
      });
      await release(origin, second);
    });

    test(`a step an hour BACKWARDS keeps the debit for one lifetime from the reading, not for an hour, and not for no time (${label})`, async () => {
      const w = ageWorld(3_700_000);
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy));
      const b = w.guard(origin, "B", room(roomy));
      await land(w, origin, a);
      w.step(-3_600_000);
      expect(w.wall()).toBe(100_000);
      const inside = await b.reserve("input", BODY);
      expect(inside.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, inside);
      expect(origin.state().landed?.until).toBe(100_000 + TTL);
      // Real time passes past the clamped end: a reading begun then shows the write, and the debit does not strand the room.
      w.advance(TTL + 1);
      const later = await b.reserve("input", BODY);
      expect(later.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, later);
      w.advance(TTL);
      await release(origin, await b.reserve("input", 1));
      expect(origin.state().landed).toBeNull();
    });
  }

  test("an entry that ends further ahead than its own lifetime allows (the clock moved back since it was made) is clamped to one lifetime from now, never trusted for that long and never dropped: its bytes stay counted", async () => {
    for (const aheadMs of [TTL + 1, 3_600_000, 10 * 3_600_000]) {
      const w = ageWorld(0);
      const origin = fakeOrigin({
        holds: {},
        landed: {
          base: room(false),
          landed: BODY,
          until: aheadMs + TTL,
        },
      });
      const page = w.guard(origin, "A", room(false));
      // The record was made when the clock read `aheadMs` later than it does now: it would stand for as long as the clock was moved.
      expect((await page.reserve("input", BODY)).verdict, `${aheadMs}`).toBe(
        "refuse",
      );
      expect(origin.state().landed, `${aheadMs}`).toMatchObject({
        landed: BODY,
        until: TTL,
      });
    }
  });

  test("a look that clamps an entry writes it back, once: a second look does not extend it afresh", async () => {
    const w = ageWorld(3_700_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(true));
    const b = w.guard(origin, "B", room(true));
    await land(w, origin, a);
    w.step(-3_600_000);
    expect(await b.check("input", 1)).toBe("ok");
    await vi.waitFor(() =>
      expect(origin.state().landed?.until).toBe(100_000 + TTL),
    );
    w.advance(2_000);
    expect(await b.check("input", 1)).toBe("ok");
    expect(origin.state().landed?.until).toBe(100_000 + TTL);
  });

  test("a reading stamped after the clock went back is no age at all: it is asked for again", async () => {
    for (const monotonic of [false, true]) {
      const w = ageWorld(100_000);
      const guard = w.guard(fakeOrigin(), "B", room(true), { monotonic });
      await guard.check("input", 1);
      w.advance(10);
      w.step(-50_000);
      await guard.check("input", 1);
      expect(w.asked.B, `monotonic ${monotonic}`).toEqual([100_000, 100_010]);
    }
  });

  test("a step found by a page that has the monotonic clock drops its readings, the request on its way included", async () => {
    const w = ageWorld(100_000);
    const guard = w.guard(fakeOrigin(), "B", room(true), { monotonic: true });
    const gate = w.hold();
    const old = guard.check("input", 1);
    await vi.waitFor(() => expect(w.asked.B).toHaveLength(1));
    w.step(3_600_000);
    // The request began before the step (its stamp is in the scale before it): the next judgement asks for one that did not.
    const fresh = guard.check("input", 1);
    const winner = await Promise.race([
      fresh.then(() => "answered"),
      sleep(100).then(() => "joined the old request"),
    ]);
    expect(winner).toBe("answered");
    expect(w.asked.B).toHaveLength(2);
    gate.release();
    await old;
  });

  for (const roomy of [false, true]) {
    const label = roomy ? "room for both" : "room for one";

    test(`a step an hour FORWARDS, found by a page that lived through it, does not end the debit: the entry is taken to have just landed and that is written back (${label})`, async () => {
      const w = ageWorld();
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy), { monotonic: true });
      const b = w.guard(origin, "B", room(roomy), { monotonic: true });
      await land(w, origin, a);
      w.advance(1);
      w.step(3_600_000);
      const inside = await b.reserve("input", BODY);
      expect(inside.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, inside);
      // In the one scale every page reads (the wall clock), one lifetime from the look.
      expect(origin.state().landed).toMatchObject({
        landed: BODY,
        until: w.wall() + TTL,
      });
      // The time that really passes ends it as before: a request made after the lifetime shows the write.
      w.advance(TTL);
      const later = await b.reserve("input", BODY);
      expect(later.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, later);
    });

    test(`and a step an hour BACKWARDS, found by them, is met by the same clamp as without a second clock: one lifetime from the look, in the one scale (${label})`, async () => {
      const w = ageWorld(3_700_000);
      const origin = fakeOrigin();
      const a = w.guard(origin, "A", room(roomy), { monotonic: true });
      const b = w.guard(origin, "B", room(roomy), { monotonic: true });
      await land(w, origin, a);
      w.advance(1);
      w.step(-3_600_000);
      const inside = await b.reserve("input", BODY);
      expect(inside.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, inside);
      expect(origin.state().landed?.until).toBe(w.wall() + TTL);
      w.advance(TTL);
      const later = await b.reserve("input", BODY);
      expect(later.verdict).toBe(roomy ? "ok" : "refuse");
      await release(origin, later);
    });
  }

  test("a page that opens AFTER a backwards step still keeps the debit (clamped, never dropped)", async () => {
    const w = ageWorld(3_700_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a);
    w.advance(1);
    w.step(-3_600_000);
    const late = w.guard(origin, "D", room(false), { monotonic: true });
    expect((await late.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed).toMatchObject({ landed: BODY });
  });

  test("a page that opens AFTER a forward step finds the debit where a page that lived through the step has written it back: the one scale is why", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    await land(w, origin, a);
    w.advance(1);
    w.step(3_600_000);
    // B lived through the step: it looks (the advisory check writes back what it found) and so extends the entry.
    expect(await b.check("input", 1)).toBe("ok");
    await vi.waitFor(() =>
      expect(origin.state().landed?.until).toBe(w.wall() + TTL),
    );
    // D's anchors are made after the step: it knows nothing of it, but it reads the entry in the scale it was written back in.
    const late = w.guard(origin, "D", room(false), { monotonic: true });
    expect((await late.reserve("input", BODY)).verdict).toBe("refuse");
  });

  test("the distrust lasts one lifetime of REAL time and no longer: a later look does not extend the entry again, and it is retired as any other", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(true), { monotonic: true });
    const b = w.guard(origin, "B", room(true), { monotonic: true });
    await land(w, origin, a);
    w.advance(1);
    w.step(3_600_000);
    await release(origin, await b.reserve("input", 1));
    const extended = origin.state().landed?.until;
    expect(extended).toBe(w.wall() + TTL);
    // The window ended (a lifetime of the monotonic clock): looks go on without extending anything.
    w.advance(TTL + 1);
    await release(origin, await b.reserve("input", 1));
    expect(origin.state().landed?.until).toBe(extended);
    w.advance(TTL);
    await release(origin, await b.reserve("input", 1));
    expect(origin.state().landed).toBeNull();
  });

  // REPLACES TWO "documented limit" TESTS OF REVISION 17 (revision 18, R28b). They asserted that a page opened after a forward step, and a
  // page with no second clock, ADMIT the second write against the lagging estimate: the reserve was left to the estimate's own
  // refusal, which cannot enforce it while megabytes remain free. The requirement is that the reserve holds; the schedules are covered in
  // full in `quota-new-page.test.ts`, and these two keep the old tests' own setups with the requirement's assertion.
  test("a page that opens AFTER a forward step, when no page that lived through it has changed the ledger since, keeps the debit: the room is held for one more lifetime from its own start", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a);
    w.advance(1);
    w.step(3_600_000);
    // Its anchor is made after the step, and nothing in a ledger stamped before it can show how much time really passed: the entry is taken
    // to have landed no earlier than that anchor.
    const late = w.guard(origin, "D", room(false), { monotonic: true });
    expect((await late.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
  });

  test("with no second clock a forward step before the page opened is kept to the same bound: the page's own start is the earliest the entry can be taken to have landed", async () => {
    const w = ageWorld();
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false));
    await land(w, origin, a);
    w.advance(1);
    w.step(3_600_000);
    const b = w.guard(origin, "B", room(false));
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.landed).toBe(BODY);
  });
});

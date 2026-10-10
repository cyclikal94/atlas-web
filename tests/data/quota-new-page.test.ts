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
 * R28b (revision 18): a page that opens AFTER a step of the wall clock is not trusted with the age of a stamp it did not live through.
 *
 * The review of revision 17 reproduced it through the public outbox and in real Chromium: page A lands a 900,000-byte save (initial free
 * space 5,394,304 bytes, the input floor 4,194,304, room for 1,200,000 above it; its debit 904,961 bytes, five seconds); the wall clock
 * moves an hour forwards without real time passing; page B's guard is then CONSTRUCTED and queues another 900,000 bytes against the
 * lagging estimate, and retires A's debit on the strength of its own reading of the stamp. 1,800,000 bytes retained, 3,594,304 left of the
 * floor, about 54 ms after the original landing. It failed in the order "the new page first" and with every original page closed.
 *
 * The invariant: a stamp's AGE is believed only for a stamp the page has lived through (made after the reading its own clocks have been
 * checked from: `quota-clock.ts`, `anchor()`); an entry stamped before that is taken to have landed no earlier than the anchor. So a debit
 * is never forgotten by a page that cannot know how long ago it landed, whichever page wrote it and whether or not that page is alive, and
 * an abandoned debit is still recovered: it caps for one lifetime from the page's start and is retired one lifetime after that.
 *
 * The estimate lags like the browser's (`ageWorld`), the ledger is the model of the origin's, the clocks are injected: PROTOCOL evidence, no
 * native quota is exhausted and no clock is really altered. The same schedules through the public consumers are in
 * `outbox-quota-estimate.test.ts`, through the production factory over IndexedDB in `production-quota.test.ts`, and in real engines in
 * `tests/e2e/fixture.data-outbox.spec.ts`.
 */
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const SLACK = DATA_CONFIG.quotaClockSlackMs;
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const FLOOR = RESERVE / 2;
const BODY = 900_000;
const HOUR = 3_600_000;
/** Room for ONE body above the floor, or for both. */
const room = (roomy: boolean): number =>
  FLOOR + (roomy ? 2_500_000 : 1_200_000);

/** Page `guard` reserves `bytes`; the write lands (the browser shows `shown` of it a lifetime on); the ledger has taken the settlement. */
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

describe("a page that opens after the landing keeps the debit of a write it did not see land", () => {
  const STEPS = [0, 1, SLACK, SLACK + 1, 3_000, TTL, TTL + 1, HOUR, 10 * HOUR];
  const SCHEDULES = [
    "the new page first",
    "an original page that lived through the step looks first",
    "every original page closed",
  ] as const;
  for (const step of STEPS)
    for (const schedule of SCHEDULES)
      for (const monotonic of [true, false])
        for (const roomy of [false, true])
          test(`a step of ${step} ms forwards, ${schedule}, the new page has ${monotonic ? "the monotonic clock" : "the wall clock only"}, ${roomy ? "room for both" : "room for one"}`, async () => {
            const w = ageWorld(100_000);
            const origin = fakeOrigin();
            const a = w.guard(origin, "A", room(roomy), { monotonic: true });
            await land(w, origin, a);
            const landed = origin.state().landed;
            // About 54 ms of real time pass (the review's figure); the wall clock moves by `step` besides.
            w.advance(54);
            w.step(step);
            if (
              schedule ===
              "an original page that lived through the step looks first"
            )
              expect(await a.check("input", 0)).toBe("ok");
            if (schedule === "every original page closed") a.close?.();
            const b = w.guard(origin, "B", room(roomy), { monotonic });
            const second = await b.reserve("input", BODY);
            expect(second.verdict).toBe(roomy ? "ok" : "refuse");
            // The debit is in the ledger still: never deleted by a page that could not know how old it was.
            expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
              landed?.landed ?? 0,
            );
            await release(origin, second);
            if (schedule === "the new page first") {
              // The original page that lived through the step looks LATER: the debit is still there for it to find.
              expect(await a.check("input", 0)).toBe("ok");
              expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
                landed?.landed ?? 0,
              );
            }
          });

  for (const step of [-1, -SLACK - 1, -TTL - 1, -HOUR, -10 * HOUR])
    for (const monotonic of [true, false])
      for (const roomy of [false, true])
        test(`a step of ${-step} ms backwards, every original page closed, the new page has ${monotonic ? "the monotonic clock" : "the wall clock only"}, ${roomy ? "room for both" : "room for one"}`, async () => {
          const w = ageWorld(10 * HOUR + 100_000);
          const origin = fakeOrigin();
          const a = w.guard(origin, "A", room(roomy), { monotonic: true });
          await land(w, origin, a);
          w.advance(54);
          w.step(step);
          a.close?.();
          const b = w.guard(origin, "B", room(roomy), { monotonic });
          const second = await b.reserve("input", BODY);
          expect(second.verdict).toBe(roomy ? "ok" : "refuse");
          expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
            BODY,
          );
          await release(origin, second);
        });

  test("with no step at all a page that opens just after the landing is held to it as well (the control: the stamp's age is the page's to believe only from its own start)", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a);
    w.advance(54);
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
  });

  test("a page that was open when the write landed believes the stamp, exactly as before: the debit ends at its lifetime, with no step and no wait", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(true), { monotonic: true });
    const b = w.guard(origin, "B", room(true), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    w.advance(TTL);
    const later = await b.reserve("input", BODY);
    expect(later.verdict).toBe("ok");
    await release(origin, later);
    w.advance(TTL);
    await release(origin, await b.reserve("input", 1));
    expect(origin.state().landed).toBeNull();
  });
});

describe("an abandoned debit is recovered, within a bound: one lifetime of cap and one of retention from the page's own start", () => {
  /** The write lands and is never shown by the estimate, so only the debit can stand between the page and the room. */
  async function abandoned(monotonic: boolean) {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    w.advance(54);
    w.step(HOUR);
    a.close?.();
    const b = w.guard(origin, "B", room(false), { monotonic });
    const start = w.wall();
    return { w, origin, b, start };
  }

  for (const monotonic of [true, false]) {
    const label = monotonic ? "the monotonic clock" : "the wall clock only";

    test(`a reading begun before one lifetime from the page's start is capped, one begun at it is not (${label})`, async () => {
      const { w, origin, b } = await abandoned(monotonic);
      w.advance(TTL - 1);
      const inside = await b.reserve("input", BODY);
      expect(inside.verdict).toBe("refuse");
      // At exactly one lifetime a request begun now is after the debit's end: it shows the write (here: nothing was written).
      w.advance(1);
      const after = await b.reserve("input", BODY);
      expect(after.verdict).toBe("ok");
      await release(origin, after);
    });

    test(`the entry stays in the ledger for one more lifetime and is retired by the first change after that (${label})`, async () => {
      const { w, origin, b } = await abandoned(monotonic);
      const original = origin.state().landed;
      expect(original?.landed).toBe(BODY);
      w.advance(TTL);
      await release(origin, await b.reserve("input", 1));
      // Past the debit's end, still inside the retention: the entry is as the writer made it.
      expect(origin.state().landed).toEqual(original);
      w.advance(TTL - 1);
      await release(origin, await b.reserve("input", 1));
      expect(origin.state().landed).toEqual(original);
      w.advance(1);
      await release(origin, await b.reserve("input", 1));
      expect(origin.state().landed).toBeNull();
    });
  }

  test("a page that has been open for long before it first looks has long passed both lifetimes: the entry is gone at its first look", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    a.close?.();
    w.advance(54);
    w.step(HOUR);
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    w.advance(2 * TTL);
    const result = await b.reserve("input", BODY);
    expect(result.verdict).toBe("ok");
    await release(origin, result);
    expect(origin.state().landed).toBeNull();
  });

  test("a landing a page makes itself, or sees made, after it began is believed as stamped: it ends at its own lifetime, not at the page's", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    w.advance(10_000);
    await land(w, origin, a, BODY, 0);
    expect(origin.state().landed?.until).toBe(w.wall() + TTL);
    w.advance(TTL - 1);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    w.advance(1);
    const ended = await b.reserve("input", BODY);
    expect(ended.verdict).toBe("ok");
    await release(origin, ended);
  });
});

describe("a step a page lives through moves its anchor, in either direction, and a clock set back needs no second clock to say so", () => {
  test("a page that lives through a forward step keeps a debit stamped before it, as a page that opens after it does", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    w.advance(54);
    w.step(HOUR);
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
  });

  test("a page with no monotonic clock that sees its wall clock read LESS than it did believes the stamps made after that reading, and not the ones before it", async () => {
    const w = ageWorld(10 * HOUR);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false));
    const b = w.guard(origin, "B", room(false));
    await land(w, origin, a, BODY, 0);
    w.step(-HOUR);
    // B sees the clock go back; the entry (stamped in the scale before) is clamped to one lifetime from this look...
    expect((await b.reserve("input", BODY)).verdict).toBe("refuse");
    expect(origin.state().landed?.until).toBe(w.wall() + TTL);
    // ...and it ends there, in the new scale, as any other: a page does not keep it for the hour the clock was set back.
    w.advance(TTL);
    const later = await b.reserve("input", BODY);
    expect(later.verdict).toBe("ok");
    await release(origin, later);
    w.advance(TTL);
    await release(origin, await b.reserve("input", 1));
    expect(origin.state().landed).toBeNull();
  });
});

describe("the estimate's readings, for a page that opens after a step", () => {
  /** A guard opened after the step, over an entry its estimate never shows: only the cap can refuse. */
  async function opened() {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    w.advance(54);
    w.step(HOUR);
    a.close?.();
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    return { w, origin, b };
  }

  test("a request begun inside the lifetime and answered after it is not used: the debit has run out, so the page asks again, and the new reading shows what is there", async () => {
    const { w, origin, b } = await opened();
    w.advance(TTL - 1);
    const began = w.real;
    const gate = w.hold();
    const pending = b.reserve("input", BODY);
    await vi.waitFor(() => expect(w.asked.B).toEqual([began]));
    w.advance(2);
    gate.release();
    const result = await pending;
    expect(result.verdict).toBe("ok");
    expect(w.asked.B).toHaveLength(2);
    await release(origin, result);
  });

  test("a request answered while the debit still stands is capped, and no second request is made", async () => {
    const { w, origin, b } = await opened();
    w.advance(1_000);
    const gate = w.hold();
    const pending = b.reserve("input", BODY);
    await vi.waitFor(() => expect(w.asked.B).toHaveLength(1));
    w.advance(3_000);
    gate.release();
    const result = await pending;
    expect(result.verdict).toBe("refuse");
    expect(w.asked.B).toHaveLength(1);
    await release(origin, result);
  });

  test("a reading cached inside the lifetime and used across its end is replaced at the boundary, once", async () => {
    const { w, origin, b } = await opened();
    w.advance(TTL - 1);
    expect(await b.check("input", 1)).toBe("ok");
    w.advance(2);
    const result = await b.reserve("input", BODY);
    expect(result.verdict).toBe("ok");
    expect(w.asked.B).toHaveLength(2);
    await release(origin, result);
  });

  test("the advisory check across the boundary asks again too: a reading cached inside the lifetime is not what a refusal that stops the engine is made on", async () => {
    const { w, origin, b } = await opened();
    w.advance(TTL - 1);
    expect(await b.check("input", 1)).toBe("ok");
    w.advance(2);
    expect(await b.check("input", 1)).toBe("ok");
    expect(w.asked.B).toHaveLength(2);
    expect(origin.state().holds).toEqual({});
  });

  test("an invalidation does not end the debit: the next reading is new, and the entry still caps it inside the lifetime", async () => {
    const { w, origin, b } = await opened();
    w.advance(1_000);
    await b.check("input", 1);
    b.invalidate();
    const result = await b.reserve("input", BODY);
    expect(result.verdict).toBe("refuse");
    expect(w.asked.B).toHaveLength(2);
    await release(origin, result);
  });
});

describe("the advisory fallback, when the ledger cannot be read, counts the entry the page took to have just landed", () => {
  test("what the ledger last showed is kept as the PAGE saw it: a cache page it would refuse by that account is not a storage stop (`unknown`), and the same entry believed as stamped would have said `ok`", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const free = RESERVE + 500_000;
    const a = w.guard(origin, "A", free, { monotonic: true });
    await land(w, origin, a, BODY, 0);
    w.advance(54);
    w.step(HOUR);
    a.close?.();
    const b = w.guard(origin, "B", free, { monotonic: true });
    // The ledger answers once, so that the page has seen the entry...
    expect(await b.check("input", 1)).toBe("ok");
    // ...and then it does not answer: the advisory check judges on what it last showed, with the entry as the page took it to be.
    origin.fail("B", 10);
    expect(await b.check("cache", 1)).toBe("unknown");
    expect(await b.check("input", 1)).toBe("ok");
    origin.heal("B");
  });
});

describe("what the page's start must not change: input priority, `unknown`, and the figure that is judged", () => {
  test("user input is the last thing refused: a page that opens after a step is refused a cache page by the debit where it admits input, and admits the cache page once the debit has run out", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    // Free space just above the cache reserve: the debit takes it below the reserve, which refuses a cache page and not input.
    const free = RESERVE + 500_000;
    const a = w.guard(origin, "A", free, { monotonic: true });
    await land(w, origin, a, BODY, 0);
    w.advance(54);
    w.step(HOUR);
    a.close?.();
    const b = w.guard(origin, "B", free, { monotonic: true });
    // The cache page is refused, as the page's own accounting of the entry it did not see land: for want of knowledge, not of space.
    const cache = await b.reserve("cache", 1);
    expect(cache).toMatchObject({ verdict: "refuse", unestablished: true });
    const input = await b.reserve("input", 1_000);
    expect(input.verdict).toBe("ok");
    await release(origin, input);
    w.advance(TTL);
    const later = await b.reserve("cache", 1);
    expect(later.verdict).toBe("ok");
    await release(origin, later);
  });

  test("a refusal that the entry's own stamp makes too is a refusal for want of space and is not `unestablished`; one that only the page's extension makes is", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    const b = w.guard(origin, "B", room(false), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    // B was open when the write landed: it believes the stamp, and the room is short by the stamp's own account.
    const refused = await b.reserve("input", BODY);
    expect(refused.verdict).toBe("refuse");
    expect(refused.unestablished).toBeUndefined();
    // The refusal of a page that opened after a step rests on the extension ALONE: its stamp, believed, would have ended the debit long ago
    // and the write would have been admitted, so that refusal is the page's lack of knowledge.
    w.advance(54);
    w.step(HOUR);
    const late = w.guard(origin, "C", room(false), { monotonic: true });
    const lateRefused = await late.reserve("input", BODY);
    expect(lateRefused.verdict).toBe("refuse");
    expect(lateRefused.unestablished).toBe(true);
  });

  test("the advisory `check` refuses nothing on the page's lack of knowledge: it says `unknown` while the reservation that admits the write still refuses, and says `refuse` for a space that is short by the stamp's own account", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const free = RESERVE + 500_000;
    const a = w.guard(origin, "A", free, { monotonic: true });
    const early = w.guard(origin, "E", free, { monotonic: true });
    await land(w, origin, a, BODY, 0);
    // A page that was open when the write landed believes it: the cache page does not fit by its account, and the advisory check says so.
    expect(await early.check("cache", 1)).toBe("refuse");
    w.advance(54);
    w.step(HOUR);
    a.close?.();
    const b = w.guard(origin, "B", free, { monotonic: true });
    expect(await b.check("cache", 1)).toBe("unknown");
    expect((await b.reserve("cache", 1)).verdict).toBe("refuse");
  });

  test("the approved `unknown`: a page with no estimate is not capped by a debit and does not touch it, whatever its start", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(false), { monotonic: true });
    await land(w, origin, a);
    const before = origin.state();
    w.step(HOUR);
    const blind = createQuotaGuard({
      storage: { estimate: async () => ({}) },
      now: () => w.wall(),
      monotonic: () => w.real,
      ledger: origin.page("B").ledger,
    });
    const result = await blind.reserve("input", BODY);
    expect(result.verdict).toBe("unknown");
    expect(origin.state().landed).toEqual(before.landed);
    await release(origin, result);
  });

  test("the cap is the figure the first of the writes was judged on, less the bytes landed since, as before: a page that opens late adds nothing of its own to it", async () => {
    const w = ageWorld(100_000);
    const origin = fakeOrigin();
    const a = w.guard(origin, "A", room(true), { monotonic: true });
    await land(w, origin, a, BODY, 0);
    const landed = origin.state().landed;
    w.advance(54);
    w.step(HOUR);
    const b = w.guard(origin, "B", room(true), { monotonic: true });
    await release(origin, await b.reserve("input", 1));
    // The entry's own fields are the writer's: only a page's change of the ledger (its landing, a retirement, a clamp) moves them.
    expect(origin.state().landed).toEqual(landed);
  });
});

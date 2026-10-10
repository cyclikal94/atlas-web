// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createQuotaClock } from "../../src/data/engine/quota-clock";

/**
 * R28 (revision 17): what the quota guard knows of its clock. A step of the wall clock is neither proof that a landing's lifetime has
 * passed nor proof that a write did not happen. The wall clock stays the one scale every page of the origin reads, and where the page has a
 * monotonic clock a step FORWARDS is found between two readings and the wall clock is distrusted for one estimate lifetime of real time
 * (`createQuotaClock`). These are the unit cases; the guard's behaviour under a step, through the origin's ledger and the public outbox, is
 * in `quota-estimate-age.test.ts` and `outbox-quota-estimate.test.ts`. Injected clocks only: no real clock is altered.
 */
const SLACK = 250;
const WINDOW = 5_000;

/** Two clocks the test moves by hand: `real` is what the monotonic clock reads, `offset` how far the wall clock is from it. */
function clocks(wall0 = 1_700_000_000_000) {
  const state = { real: 0, offset: wall0 };
  return {
    state,
    wall: () => state.real + state.offset,
    monotonic: () => state.real,
    advance(ms: number) {
      state.real += ms;
    },
    step(ms: number) {
      state.offset += ms;
    },
  };
}

const watch = (
  c: ReturnType<typeof clocks>,
  steps: number[] = [],
  /** `null`: the page has no monotonic clock. */
  monotonic: (() => number) | null = c.monotonic,
) =>
  createQuotaClock({
    wall: c.wall,
    monotonic: monotonic ?? undefined,
    slackMs: SLACK,
    windowMs: WINDOW,
    onStep: (moved) => steps.push(moved),
  });

describe("the wall clock alone", () => {
  test("with no monotonic clock the wall clock is read as it is, and a step cannot be told from time passing: nothing is distrusted", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps, null);
    const first = clock.now();
    c.step(3_600_000);
    expect(clock.now()).toBe(first + 3_600_000);
    expect(clock.distrusted()).toBe(false);
    c.step(-7_200_000);
    expect(clock.now()).toBe(first - 3_600_000);
    expect(clock.distrusted()).toBe(false);
    expect(steps).toEqual([]);
  });

  test("a monotonic clock that IS the wall clock never finds a step", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps, c.wall);
    const first = clock.now();
    c.step(3_600_000);
    expect(clock.now()).toBe(first + 3_600_000);
    expect(clock.distrusted()).toBe(false);
    expect(steps).toEqual([]);
  });
});

describe("a step of the wall clock is found, and the scale stays the wall clock's", () => {
  test("time that really passes is not a step, however many readings are made: the wall clock is read as it is", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps);
    const first = clock.now();
    c.advance(1_000);
    expect(clock.now()).toBe(first + 1_000);
    c.advance(60_000);
    expect(clock.now()).toBe(first + 61_000);
    expect(clock.distrusted()).toBe(false);
    expect(steps).toEqual([]);
  });

  test("a step FORWARDS is announced once, with its sign, the reading is the wall clock's own (no correction: every page reads the same scale), and the wall clock is distrusted for one lifetime of REAL time", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps);
    const first = clock.now();
    c.advance(10);
    c.step(3_600_000);
    expect(clock.now()).toBe(first + 10 + 3_600_000);
    expect(steps).toEqual([3_600_000]);
    expect(clock.distrusted()).toBe(true);
    // The window is of the monotonic clock: it ends WINDOW after the step was found, whatever the wall clock says.
    c.advance(WINDOW - 1);
    expect(clock.now()).toBe(first + 10 + 3_600_000 + WINDOW - 1);
    expect(clock.distrusted()).toBe(true);
    expect(steps).toEqual([3_600_000]);
    c.advance(1);
    expect(clock.distrusted()).toBe(false);
  });

  test("a second step forwards inside the window starts the window again", () => {
    const c = clocks();
    const clock = watch(c);
    clock.now();
    c.step(1_000_000);
    clock.now();
    c.advance(WINDOW - 100);
    c.step(1_000_000);
    clock.now();
    c.advance(WINDOW - 1);
    expect(clock.distrusted()).toBe(true);
    c.advance(1);
    expect(clock.distrusted()).toBe(false);
  });

  test("a step BACKWARDS is announced (the readings made before it are stamped in the scale before it) but distrusts nothing: the ledger's own rule clamps what is further ahead than its lifetime", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps);
    const first = clock.now();
    c.advance(2_000);
    c.step(-86_400_000);
    expect(clock.now()).toBe(first + 2_000 - 86_400_000);
    expect(steps).toEqual([-86_400_000]);
    expect(clock.distrusted()).toBe(false);
  });

  test("steps are each announced as they are found", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps);
    clock.now();
    c.step(1_000_000);
    c.advance(1);
    clock.now();
    c.step(-400_000);
    c.advance(1);
    clock.now();
    expect(steps).toEqual([1_000_000, -400_000]);
  });

  test("a step that happened between two readings is found at the next one, however long ago it was and however many readings were not made", () => {
    const c = clocks();
    const clock = watch(c);
    clock.now();
    c.advance(600_000);
    c.step(3_600_000);
    c.advance(1_000);
    clock.now();
    expect(clock.distrusted()).toBe(true);
  });
});

describe("what is jitter or drift is not a step", () => {
  test("a difference of exactly the slack is jitter; one millisecond more is a step", () => {
    for (const [moved, isStep] of [
      [SLACK, false],
      [-SLACK, false],
      [SLACK + 1, true],
      [-(SLACK + 1), true],
    ] as const) {
      const c = clocks();
      const steps: number[] = [];
      const clock = watch(c, steps);
      const first = clock.now();
      c.step(moved);
      const read = clock.now();
      expect(steps.length > 0, `moved ${moved}`).toBe(isStep);
      // The wall clock is the scale, whatever it did.
      expect(read, `moved ${moved}`).toBe(first + moved);
      expect(clock.distrusted(), `moved ${moved}`).toBe(isStep && moved > 0);
    }
  });

  test("drift below the slack at every reading is never a step, however much it adds up to", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps);
    clock.now();
    for (let i = 0; i < 100; i += 1) {
      c.advance(1_000);
      c.step(SLACK);
      clock.now();
    }
    expect(steps).toEqual([]);
    expect(clock.distrusted()).toBe(false);
  });

  test("a clock that answers something that is not a number is not followed and is not read as a step; the next good reading still finds one", () => {
    const c = clocks();
    const steps: number[] = [];
    let broken = false;
    const clock = watch(c, steps, () => (broken ? Number.NaN : c.state.real));
    const first = clock.now();
    broken = true;
    c.advance(10);
    expect(clock.now()).toBe(first + 10);
    broken = false;
    c.advance(10);
    // The anchors were not moved by the unreadable answer, so the FIRST good reading after it compares with the last good one before it:
    // a step that happened meanwhile is found by that very reading.
    c.step(3_600_000);
    expect(clock.now()).toBe(first + 20 + 3_600_000);
    expect(steps).toEqual([3_600_000]);
    expect(clock.distrusted()).toBe(true);
  });
});

describe("pages that lived through a step find it, and one that opens after it cannot", () => {
  test("every clock created before a step distrusts the wall clock after it; one created after it finds nothing", () => {
    const c = clocks();
    const a = watch(c);
    const b = watch(c);
    c.advance(1_000);
    c.step(3_600_000);
    c.advance(10);
    const late = watch(c);
    a.now();
    b.now();
    late.now();
    expect(a.distrusted()).toBe(true);
    expect(b.distrusted()).toBe(true);
    expect(late.distrusted()).toBe(false);
  });
});

describe("the anchor: the reading from which a page's own clocks have been checked (R28, revision 18)", () => {
  test("it is the wall clock as it read when the clock began, with and without a monotonic clock, and ordinary time does not move it", () => {
    for (const monotonic of [true, false]) {
      const c = clocks();
      const clock = watch(c, [], monotonic ? c.monotonic : null);
      const began = c.wall();
      expect(clock.anchor()).toBe(began);
      c.advance(60_000);
      clock.now();
      expect(clock.anchor()).toBe(began);
    }
  });

  test("a clock that opens after a step is anchored after it: nothing before the anchor is vouched for, and the step is not found", () => {
    const c = clocks();
    const early = watch(c);
    const began = early.anchor();
    c.advance(1_000);
    c.step(3_600_000);
    const late = watch(c);
    early.now();
    late.now();
    expect(late.anchor()).toBe(began + 1_000 + 3_600_000);
    // The page that lived through the step has the step as its anchor too: the stretch it has checked starts again from the reading that
    // found it.
    expect(early.anchor()).toBe(began + 1_000 + 3_600_000);
  });

  test("a step found, forwards or backwards, moves the anchor to the reading that found it", () => {
    for (const moved of [3_600_000, -3_600_000, SLACK + 1, -(SLACK + 1)]) {
      const c = clocks();
      const clock = watch(c);
      c.advance(500);
      c.step(moved);
      const found = clock.now();
      expect(clock.anchor(), `${moved}`).toBe(found);
    }
  });

  test("jitter that is not a step does not move it, forwards at the slack; a reading below it does, because the clock was set back", () => {
    const c = clocks();
    const clock = watch(c);
    const began = clock.anchor();
    c.step(SLACK);
    clock.now();
    expect(clock.anchor()).toBe(began);
    // A reading that is LESS than the anchor (a backwards jitter below the slack, which is not a step) puts the anchor there, so that it is
    // never ahead of the clock it anchors.
    c.step(-SLACK - 100);
    const behind = clock.now();
    expect(behind).toBeLessThan(began);
    expect(clock.anchor()).toBe(behind);
  });

  test("a page with no monotonic clock that finds its wall clock reading less than its anchor re-anchors there, with no step announced", () => {
    const c = clocks();
    const steps: number[] = [];
    const clock = watch(c, steps, null);
    const began = clock.anchor();
    c.step(3_600_000);
    clock.now();
    // Forwards cannot be told from time passing: the anchor stays where the page began.
    expect(clock.anchor()).toBe(began);
    c.step(-7_200_000);
    const back = clock.now();
    expect(clock.anchor()).toBe(back);
    expect(back).toBeLessThan(began);
    expect(steps).toEqual([]);
  });

  test("a wall clock that answers something that is not a number has no anchor to give: every stamp is believed as it was", () => {
    const state = { value: Number.NaN };
    const clock = createQuotaClock({
      wall: () => state.value,
      slackMs: SLACK,
      windowMs: WINDOW,
    });
    expect(clock.anchor()).toBe(Number.NEGATIVE_INFINITY);
    state.value = 1_000;
    clock.now();
    expect(clock.anchor()).toBe(Number.NEGATIVE_INFINITY);
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  AHEAD_DAYS,
  aheadDigest,
  aheadHorizon,
  aheadTargets,
  lastSlotOnOrBefore,
  sameDayMonthsLater,
} from "../../../src/features/tasks/model/ahead";
import type {
  Schedule,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import { addDays } from "../../../src/features/tasks/model/time";

/**
 * The look-ahead plan of the days ahead (the Final design's Upcoming, 8 November 2026): which tasks this device asks the server to bring
 * up to date, and through which day: each task's own last slot on or before the horizon, as the server's cadence lands (its position
 * after a `materialise` is the last slot it made). PURE.
 */
const TODAY = "2026-11-08";
const HORIZON = addDays(TODAY, AHEAD_DAYS); // 2026-12-08
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  start_date: TODAY,
  time: null,
  timezone: "Europe/London",
  repeat: { frequency: "daily", interval: 1 },
  ...over,
});
const def = (over: Partial<Schedule> = {}): TaskDefinition => ({
  schedule: schedule(over),
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
});
const id = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const source = (n: number, over: Partial<Schedule> = {}, archived = false) => ({
  taskId: id(n),
  definition: def(over),
  archived,
});

describe("lastSlotOnOrBefore", () => {
  test("daily and weekly step from the start date", () => {
    expect(HORIZON).toBe("2026-12-08");
    expect(lastSlotOnOrBefore(schedule(), HORIZON)).toBe("2026-12-08");
    expect(
      lastSlotOnOrBefore(
        schedule({ repeat: { frequency: "daily", interval: 7 } }),
        HORIZON,
      ),
    ).toBe("2026-12-06");
    expect(
      lastSlotOnOrBefore(
        schedule({ repeat: { frequency: "weekly", interval: 1 } }),
        HORIZON,
      ),
    ).toBe("2026-12-06");
    expect(
      lastSlotOnOrBefore(
        schedule({
          start_date: "2026-11-10",
          repeat: { frequency: "weekly", interval: 2 },
        }),
        HORIZON,
      ),
    ).toBe("2026-12-08");
  });

  test("monthly and yearly keep the day of the month and skip a month without it (the server's rule)", () => {
    expect(sameDayMonthsLater("2026-10-31", 1)).toBeNull();
    expect(sameDayMonthsLater("2026-10-31", 2)).toBe("2026-12-31");
    expect(sameDayMonthsLater("2024-02-29", 12)).toBeNull();
    expect(sameDayMonthsLater("2024-02-29", 48)).toBe("2028-02-29");
    expect(
      lastSlotOnOrBefore(
        schedule({
          start_date: "2026-10-31",
          repeat: { frequency: "monthly", interval: 1 },
        }),
        HORIZON,
      ),
    ).toBe("2026-10-31");
    expect(
      lastSlotOnOrBefore(
        schedule({
          start_date: "2026-10-15",
          repeat: { frequency: "monthly", interval: 1 },
        }),
        HORIZON,
      ),
    ).toBe("2026-11-15");
    expect(
      lastSlotOnOrBefore(
        schedule({
          start_date: "2025-11-20",
          repeat: { frequency: "yearly", interval: 1 },
        }),
        HORIZON,
      ),
    ).toBe("2026-11-20");
  });

  test("a one-off lands on its day only; after completion, no date and a start beyond the horizon foresee nothing", () => {
    expect(
      lastSlotOnOrBefore(
        schedule({ start_date: "2026-11-17", repeat: null }),
        HORIZON,
      ),
    ).toBe("2026-11-17");
    expect(
      lastSlotOnOrBefore(
        schedule({ repeat: { frequency: "after_completion", interval: 1 } }),
        HORIZON,
      ),
    ).toBeNull();
    expect(
      lastSlotOnOrBefore(schedule({ start_date: null, repeat: null }), HORIZON),
    ).toBeNull();
    expect(
      lastSlotOnOrBefore(schedule({ start_date: "2026-12-09" }), HORIZON),
    ).toBeNull();
  });
});

describe("aheadTargets", () => {
  test("a repeating task is asked for through its last slot before the horizon", () => {
    expect(aheadHorizon(TODAY)).toBe(HORIZON);
    expect(AHEAD_DAYS).toBeLessThan(31);
    expect(
      aheadTargets(
        [
          source(1),
          source(2, { repeat: { frequency: "weekly", interval: 1 } }),
        ],
        TODAY,
      ),
    ).toEqual([
      { taskId: id(1), throughDate: HORIZON },
      { taskId: id(2), throughDate: "2026-12-06" },
    ]);
  });

  test("a one-off ahead is asked for through its own day only", () => {
    const day = addDays(TODAY, 9);
    expect(
      aheadTargets([source(1, { start_date: day, repeat: null })], TODAY),
    ).toEqual([{ taskId: id(1), throughDate: day }]);
  });

  test("nothing to make after today is left alone: undated, past or today's one-offs, a monthly task whose next day is beyond the horizon", () => {
    expect(
      aheadTargets(
        [
          source(1, { start_date: null, repeat: null }),
          source(2, { start_date: TODAY, repeat: null }),
          source(3, { start_date: addDays(TODAY, -3), repeat: null }),
          source(4, { start_date: addDays(TODAY, 50), repeat: null }),
          source(5, {
            start_date: "2026-10-31",
            repeat: { frequency: "monthly", interval: 1 },
          }),
          source(6, {
            repeat: { frequency: "after_completion", interval: 1 },
          }),
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  test("a repeating task that starts beyond the horizon, an archived task and an unreadable definition are left alone", () => {
    expect(
      aheadTargets(
        [
          source(1, { start_date: addDays(TODAY, 40) }),
          source(2, {}, true),
          { taskId: id(3), definition: null, archived: false },
          source(4, { start_date: addDays(TODAY, 3) }),
        ],
        TODAY,
      ),
    ).toEqual([{ taskId: id(4), throughDate: HORIZON }]);
  });

  test("one answer per task, sorted by id, and a digest that tells plans apart", () => {
    const a = aheadTargets(
      [
        source(2),
        source(1),
        source(2, { repeat: null, start_date: addDays(TODAY, 2) }),
      ],
      TODAY,
    );
    expect(a.map((t) => t.taskId)).toEqual([id(1), id(2)]);
    expect(a[1]?.throughDate).toBe(HORIZON);
    expect(aheadDigest(a)).not.toBe(aheadDigest(a.slice(1)));
    expect(aheadDigest([])).toBe("");
  });
});

import { describe, expect, test } from "vitest";
import { DURATION, GOAL_FACT } from "../../../src/features/tasks/copy";

/** A number of seconds as the short duration the facts strip, the rows and the timers read (the Final design). */
describe("DURATION", () => {
  test("minutes, hours and seconds", () => {
    expect(DURATION("0")).toBe("0 min");
    expect(DURATION("45")).toBe("45 s");
    expect(DURATION("1200")).toBe("20 min");
    expect(DURATION("3600")).toBe("1 h");
    expect(DURATION("5400")).toBe("1 h 30 min");
    expect(DURATION("abc")).toBe("abc s");
  });

  test("a goal in seconds reads as a duration; other units keep their words", () => {
    expect(
      GOAL_FACT({
        kind: "numeric",
        minimum: "1200",
        maximum: null,
        unit: "seconds",
      }),
    ).toBe("At least 20 min");
    expect(
      GOAL_FACT({
        kind: "numeric",
        minimum: "600",
        maximum: "3600",
        unit: "seconds",
      }),
    ).toBe("10 min to 1 h");
    expect(
      GOAL_FACT({
        kind: "numeric",
        minimum: null,
        maximum: null,
        unit: "seconds",
      }),
    ).toBe("Any length of time");
    expect(
      GOAL_FACT({
        kind: "numeric",
        minimum: "10",
        maximum: null,
        unit: "cups",
      }),
    ).toBe("At least 10 cups");
  });
});

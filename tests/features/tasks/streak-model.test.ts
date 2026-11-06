// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  OccurrenceData,
  Outcome,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import type { PersonalResult } from "../../../src/features/tasks/model/evaluate";
import {
  figureOf,
  STRIP_PERIODS,
  stateOf,
  strip,
  tally,
  unitOf,
} from "../../../src/features/tasks/model/streak";

/** WF-TASK-06's pure parts (A6; D-10c-8): figures never 0 for unknown, the strip's states, its last-30 window and tally, unit words. */
const def = (repeat: TaskDefinition["schedule"]["repeat"]): TaskDefinition => ({
  schedule: { start_date: "2026-01-01", time: null, timezone: "UTC", repeat },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: true,
});
const NOW = Date.UTC(2026, 9, 25, 12);
const day = (date: string, open = true, closed = true): OccurrenceData => {
  const start = Date.parse(`${date}T00:00:00Z`) / 1000;
  return {
    task_id: "t",
    definition: def({ frequency: "daily", interval: 1 }),
    slot: {
      key: date,
      date,
      intended_time: null,
      timezone: "UTC",
      instant: null,
    },
    opens_at: open ? start : NOW / 1000 + 3600,
    closes_at: closed ? start + 86_400 : NOW / 1000 + 86_400,
    participants: ["me"],
    covered_by: null,
    resolved: false,
  };
};
const result = (outcome: Outcome): PersonalResult => ({
  kind: "result",
  outcome,
  periodOutcome: outcome,
  action: { outcome, amount: null, checked: [] },
  provisional: false,
  stale: false,
});

describe("figures", () => {
  test("MU-10C-29: null is never 0 — Withheld for the joint figure, Unknown for mine; 0 stays 0", () => {
    expect(figureOf(null, "joint")).toEqual({ kind: "withheld" });
    expect(figureOf(null, "personal")).toEqual({ kind: "unknown" });
    expect(figureOf(0, "personal")).toEqual({ kind: "count", value: 0 });
  });

  test("unit words by cadence: interval 1 of a calendar frequency, else times", () => {
    expect(unitOf(def({ frequency: "daily", interval: 1 }), 3)).toBe("days");
    expect(unitOf(def({ frequency: "daily", interval: 1 }), 1)).toBe("day");
    expect(unitOf(def({ frequency: "weekly", interval: 1 }), 2)).toBe("weeks");
    expect(unitOf(def({ frequency: "monthly", interval: 1 }), 2)).toBe(
      "months",
    );
    expect(unitOf(def({ frequency: "yearly", interval: 1 }), 2)).toBe("years");
    expect(unitOf(def({ frequency: "daily", interval: 2 }), 2)).toBe("times");
    expect(unitOf(def({ frequency: "after_completion", interval: 1 }), 2)).toBe(
      "times",
    );
    expect(unitOf(def(null), 1)).toBe("time");
  });
});

describe("the strip", () => {
  test("five states from my finalised result; an open period does not count as missed", () => {
    const closed = day("2026-10-20");
    const open = day("2026-10-25", true, false);
    expect(stateOf(result("complete"), closed, NOW)).toBe("done");
    expect(stateOf(result("missed"), closed, NOW)).toBe("missed");
    expect(stateOf(result("excluded"), closed, NOW)).toBe("skipped");
    expect(stateOf(result("incomplete"), open, NOW)).toBe("open");
    expect(stateOf(result("unknown"), open, NOW)).toBe("open");
    expect(stateOf(result("unknown"), closed, NOW)).toBe("none");
    expect(stateOf({ kind: "none" }, closed, NOW)).toBe("none");
    expect(stateOf({ kind: "unavailable" }, closed, NOW)).toBe("none");
  });

  test("the last 30 OPENED periods, oldest first; a period not yet open is left out; the tally counts only known results", () => {
    const days = Array.from({ length: 35 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 20 + i))
        .toISOString()
        .slice(0, 10);
      return {
        id: date,
        data: day(date),
        result: result(i % 3 === 0 ? "missed" : "complete"),
      };
    });
    const future = {
      id: "future",
      data: day("2026-10-26", false, false),
      result: result("unknown"),
    };
    const cells = strip([future, ...days.reverse()], NOW);
    expect(cells).toHaveLength(STRIP_PERIODS);
    expect(cells[0]?.date).toBe("2026-09-25");
    expect(cells.at(-1)?.date).toBe("2026-10-24");
    expect(cells.some((c) => c.id === "future")).toBe(false);
    const counts = tally([
      ...cells.slice(0, 2),
      { id: "x", date: null, state: "open" },
      { id: "y", date: null, state: "none" },
      { id: "z", date: null, state: "skipped" },
    ]);
    expect(counts.total).toBe(
      cells
        .slice(0, 2)
        .filter((c) => c.state === "done" || c.state === "missed").length,
    );
  });
});

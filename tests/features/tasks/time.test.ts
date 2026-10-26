// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  addDays,
  dateIn,
  dayEnd,
  firstSlot,
  gapShifted,
  resolveWallTime,
  slotOn,
  timeIn,
  todayIn,
  windows,
} from "../../../src/features/tasks/model/time";

const utc = (iso: string) => Date.parse(iso) / 1000;

describe("wall time (A6; schedule.rs resolve)", () => {
  test("an ordinary time resolves to its single instant", () => {
    expect(resolveWallTime("Europe/London", "2026-07-01", "09:00:00")).toBe(
      utc("2026-07-01T08:00:00Z"),
    );
  });

  test("Vienna spring gap: 02:30 never happens and becomes 03:30 (forward by the change of offset)", () => {
    const t = resolveWallTime("Europe/Vienna", "2026-03-29", "02:30:00");
    expect(t).toBe(utc("2026-03-29T01:30:00Z"));
    expect(timeIn(t, "Europe/Vienna")).toBe("03:30");
  });

  test("Vienna autumn fold: 02:30 happens twice and the EARLIER instant is taken", () => {
    const t = resolveWallTime("Europe/Vienna", "2026-10-25", "02:30:00");
    expect(t).toBe(utc("2026-10-25T00:30:00Z"));
  });

  test("Lord Howe half-hour gap: 02:15 becomes 02:45", () => {
    const t = resolveWallTime("Australia/Lord_Howe", "2026-10-04", "02:15:00");
    expect(timeIn(t, "Australia/Lord_Howe")).toBe("02:45");
  });

  test("windows open and close at local midnight in the slot's zone", () => {
    const slot = slotOn(
      {
        start_date: "2026-09-08",
        time: null,
        timezone: "Europe/Vienna",
        repeat: null,
      },
      "2026-09-08",
    );
    const w = windows(slot, { open_days_before: 1, close_days_after: 2 });
    expect(w.opens_at).toBe(utc("2026-09-06T22:00:00Z"));
    expect(w.closes_at).toBe(utc("2026-09-09T22:00:00Z"));
    expect(
      windows(
        { date: null, timezone: "UTC" },
        { open_days_before: 0, close_days_after: 1 },
      ),
    ).toEqual({
      opens_at: null,
      closes_at: null,
    });
  });

  test("display zone versus saved zone: the date of an instant depends on where it is shown (TASK-8/9)", () => {
    const t = resolveWallTime("Pacific/Auckland", "2026-09-08", "07:00:00");
    expect(dateIn(t, "Pacific/Auckland")).toBe("2026-09-08");
    expect(dateIn(t, "Europe/London")).toBe("2026-09-07");
  });

  test("day arithmetic, today and day end", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(todayIn("Europe/London", Date.parse("2026-09-08T23:30:00Z"))).toBe(
      "2026-09-09",
    );
    expect(dayEnd("2026-03-28", "Europe/Vienna")).toBe(
      utc("2026-03-28T23:00:00Z"),
    );
  });

  test("the first slot create_task makes: the start-date slot, `once` undated, none for a future start", () => {
    const now = Date.parse("2026-09-08T10:00:00Z");
    const def = (
      start: string | null,
      repeat: null | {
        frequency: "daily" | "after_completion";
        interval: number;
      },
    ) => ({
      schedule: {
        start_date: start,
        time: null,
        timezone: "Europe/Vienna",
        repeat,
      },
    });
    expect(
      firstSlot(def("2026-09-05", { frequency: "daily", interval: 1 }), now)
        ?.key,
    ).toBe("2026-09-05Tdate");
    expect(firstSlot(def("2026-09-08", null), now)).toMatchObject({
      key: "once",
      date: "2026-09-08",
    });
    expect(firstSlot(def(null, null), now)).toMatchObject({
      key: "once",
      date: null,
    });
    expect(
      firstSlot(
        def("2026-09-08", { frequency: "after_completion", interval: 7 }),
        now,
      )?.key,
    ).toBe("once");
    expect(
      firstSlot(def("2026-09-09", { frequency: "daily", interval: 1 }), now),
    ).toBeNull();
  });

  test("a gap-shifted slot is recognised (the explainer)", () => {
    const sched = {
      start_date: "2026-03-29",
      time: "02:30:00",
      timezone: "Europe/Vienna",
      repeat: { frequency: "daily" as const, interval: 1 },
    };
    expect(gapShifted(slotOn(sched, "2026-03-29"))).toBe(true);
    expect(gapShifted(slotOn(sched, "2026-03-30"))).toBe(false);
  });
});

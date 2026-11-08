import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { AccountTimerPage } from "../../../src/features/tasks/model/contract";
import {
  addDays,
  dayStart,
  todayIn,
} from "../../../src/features/tasks/model/time";
import {
  daysInWindow,
  TIMERS_COPY,
  windowStart,
} from "../../../src/features/tasks/timers/TimersPage";
import { installMatchMedia } from "../../helpers/match-media";
import { fakeApi, mountTasks, seededTask } from "../../support/tasks/world";

/** The timers page's window and goals (the Final design, FD_Timers): This week / This month / All, and the time per task against its goal. */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const page = (items: object[]): TasksResult<AccountTimerPage> => ({
  ok: true,
  value: { items: items as never, next_after: null },
});

describe("the window (pure)", () => {
  test("windowStart: Monday of this week, the first of the month, or the beginning of time", () => {
    // 2026-11-08 is a Sunday: its week began on Monday the 2nd.
    expect(windowStart("week", "2026-11-08", "UTC")).toBe(
      dayStart("2026-11-02", "UTC"),
    );
    expect(windowStart("week", "2026-11-09", "UTC")).toBe(
      dayStart("2026-11-09", "UTC"),
    );
    expect(windowStart("month", "2026-11-08", "UTC")).toBe(
      dayStart("2026-11-01", "UTC"),
    );
    expect(windowStart("all", "2026-11-08", "UTC")).toBe(0);
  });

  test("daysInWindow: a daily task seven a week, every other day four, a weekly one one, a monthly one one", () => {
    expect(daysInWindow({ frequency: "daily", interval: 1 }, "week")).toBe(7);
    expect(daysInWindow({ frequency: "daily", interval: 2 }, "week")).toBe(4);
    expect(daysInWindow({ frequency: "weekly", interval: 1 }, "week")).toBe(1);
    expect(daysInWindow({ frequency: "weekly", interval: 1 }, "month")).toBe(4);
    expect(daysInWindow({ frequency: "monthly", interval: 1 }, "month")).toBe(
      1,
    );
    expect(daysInWindow(null, "week")).toBe(1);
    expect(daysInWindow({ frequency: "daily", interval: 1 }, "all")).toBe(1);
  });
});

describe("the goals aside", () => {
  test("this week's sessions add up per task against its goal; All brings an older session back", async () => {
    const task = await seededTask({
      title: "Practise piano",
      definition: {
        schedule: {
          start_date: todayIn("UTC", Date.now()),
          time: null,
          timezone: "UTC",
          repeat: { frequency: "daily", interval: 1 },
        },
        goal: {
          kind: "numeric",
          minimum: "1200",
          maximum: null,
          unit: "seconds",
        },
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = todayIn(zone, Date.now());
    const weekAgo = Math.floor(dayStart(addDays(today, -40), zone));
    const session = (id: string, started: number, stopped: number) => ({
      access: "available" as const,
      id: `cccccccc-0000-4000-8000-0000000000${id}`,
      occurrence_id: task.occurrenceId,
      task_id: task.taskId,
      task_title: "Practise piano",
      slot_date: task.data.slot.date,
      started_at: started,
      stopped_at: stopped,
      version: 1,
      can_modify: true,
    });
    const api = fakeApi({
      readAccountTimers: async (q) =>
        page(
          q.state === "running"
            ? []
            : [
                session("21", now - 3600, now - 1800),
                session("22", now - 7200, now - 6000),
                session("23", weekAgo + 100, weekAgo + 1900),
              ],
        ),
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    // The goal is read from the day's row once the sessions name it: wait for the reading, not only the row.
    await t.until(
      () =>
        document
          .querySelector("[data-timers-goal]")
          ?.textContent?.includes(" / ") === true,
    );
    const goal = document.querySelector("[data-timers-goal]") as HTMLElement;
    expect(goal.textContent).toContain("Practise piano");
    // 30 min + 20 min this week, against 20 min × 7 days.
    expect(goal.textContent).toContain(
      TIMERS_COPY.goalOf("50 min", "2 h 20 min"),
    );
    expect(
      document.querySelector("[data-timers-summary]")?.textContent,
    ).toContain(TIMERS_COPY.total("50 min", "week"));
    expect(document.querySelectorAll("[data-account-timer]")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: TIMERS_COPY.windows.all }),
    );
    await t.until(
      () => document.querySelectorAll("[data-account-timer]").length === 3,
    );
    expect(
      (document.querySelector("[data-timers-goal]") as HTMLElement).textContent,
    ).toContain("1 h 20 min");
  });
});

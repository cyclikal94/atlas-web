import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TodayScreen } from "../../../src/features/tasks/screens";

/**
 * R6 (review of 13 October 2026, family `task-default-day-timer-rearm`): `/today` without a day rolls over at the display zone's midnight
 * however far away it is when the page is opened. The production `TodayScreen` timer runs under a controlled clock; only the router, the
 * boundary and the page are stubbed (the page shows the day it is given). Deterministic timer scheduling, not device sleep or a real
 * background tab.
 */
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  useMatchRoute: () => () => false,
  Outlet: () => null,
}));
vi.mock("../../../src/features/tasks/env", () => ({
  TasksBoundary: ({ children }: { children: unknown }) => children,
}));
vi.mock("../../../src/features/tasks/today/TodayPage", () => ({
  TodayPage: ({ day }: { day: string }) => (
    <output data-testid="day">{day}</output>
  ),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const shown = () => screen.getByTestId("day").textContent;

describe("the default day rolls over at midnight", () => {
  for (const hour of [20, 12, 1])
    test(`opened at ${String(hour).padStart(2, "0")}:00 UTC (${24 - hour} hours before midnight)`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(
        new Date(`2026-10-12T${String(hour).padStart(2, "0")}:00:00Z`),
      );
      render(<TodayScreen search={{ tz: "UTC" }} />);
      expect(shown()).toBe("2026-10-12");
      await act(async () => {
        await vi.advanceTimersByTimeAsync((24 - hour) * 3_600_000 - 2_000);
      });
      expect(shown()).toBe("2026-10-12");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(shown()).toBe("2026-10-13");
    });

  test("and again the next midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    render(<TodayScreen search={{ tz: "UTC" }} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 3_600_000 + 1_000);
    });
    expect(shown()).toBe("2026-10-13");
    // The new day's wait is armed once that day is rendered; a whole day of six-hour wakes later it rolls over again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    });
    expect(shown()).toBe("2026-10-14");
  });

  test("control: a day chosen in the address never moves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    render(<TodayScreen search={{ tz: "UTC", day: "2026-10-12" }} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(36 * 3_600_000);
    });
    expect(shown()).toBe("2026-10-12");
  });

  test("a page shown again after the device slept past midnight reads the day at once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T23:00:00Z"));
    render(<TodayScreen search={{ tz: "UTC" }} />);
    // The clock moves with no timer run (a sleeping device): pending timers keep their distance.
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    expect(shown()).toBe("2026-10-12");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(shown()).toBe("2026-10-13");
  });
});

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import { CALENDAR_COPY } from "../../../src/features/tasks/calendar/CalendarPage";
import {
  blocksIn,
  isoWeek,
  mondayOf,
  monthEnd,
  monthLabel,
  monthRows,
  shiftMonth,
  weekLabel,
} from "../../../src/features/tasks/calendar/model";
import * as copy from "../../../src/features/tasks/copy";
import { FOCUS_COPY } from "../../../src/features/tasks/focus/FocusPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { addDays } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/** Focus mode and the calendar's month (the Final design, 8 November 2026), on the app's router over the production data controller. */
const media = installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  media.set({ width: 1440 });
});

describe("the month and the week (pure)", () => {
  test("monthEnd and shiftMonth", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-11")).toBe("2026-11-30");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  test("weeks start on Monday, carry ISO numbers and read as one line", () => {
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
    expect(mondayOf("2026-11-09")).toBe("2026-11-09");
    expect(isoWeek("2026-11-09")).toBe(46);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53);
    expect(weekLabel("2026-11-09")).toBe("9 – 15 November");
    expect(weekLabel("2026-10-26")).toBe("26 Oct – 1 Nov");
    expect(weekLabel("2025-12-29")).toBe("29 Dec 2025 – 4 Jan 2026");
    expect(blocksIn("2026-11-01", "2026-12-31", "month")).toEqual([
      "2026-11",
      "2026-12",
    ]);
    expect(blocksIn("2026-11-01", "2026-11-15", "week")).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    // November 2026 starts on a Sunday: with weekends its first row is one day; without them that row goes.
    expect(monthRows("2026-11", true)[0]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      "2026-11-01",
    ]);
    expect(monthRows("2026-11", false)[0]).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
  });
});

describe("focus mode", () => {
  test("the first open thing is up; D marks it done and the next comes up; the order lists the day", async () => {
    const a = await seededTask({ title: "Brush your teeth" });
    const b = await seededTask({ title: "Take the bins out" });
    const t = await mountTasks({
      path: `/focus?day=${TODAY}&tz=UTC`,
      rows: [...a.rows, ...b.rows],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector("[data-focus-current]") !== null,
    );
    const title = () =>
      document.querySelector("[data-focus-title]")?.textContent ?? "";
    expect(title()).toBe("Brush your teeth");
    expect(screen.getByText(FOCUS_COPY.upNext(1, 2))).toBeInTheDocument();
    const order = document.querySelector("[data-focus-order]") as HTMLElement;
    expect(within(order).getAllByRole("button")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(title()).toBe("Take the bins out");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(title()).toBe("Brush your teeth");
    fireEvent.click(screen.getByRole("button", { name: /^Done/ }));
    await t.settle();
    expect(t.drafts()[0]?.kind).toBe("record");
    await t.until(() => title() === "Take the bins out");
    expect(screen.getByText(FOCUS_COPY.lastOne(2, 2))).toBeInTheDocument();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("on the phone the order is a row of bars and the acts sit at the bottom", async () => {
    media.set({ width: 390 });
    const a = await seededTask({ title: "Water the plants" });
    const t = await mountTasks({
      path: `/focus?day=${TODAY}&tz=UTC`,
      rows: a.rows,
      env: { online: false },
    });
    await t.until(
      () => document.querySelector("[data-focus-current]") !== null,
    );
    expect(
      screen.getByRole("list", { name: FOCUS_COPY.progress }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: FOCUS_COPY.wholeDay }),
    ).toHaveAttribute("href", "/today");
    expect(document.querySelector("[data-focus-done]")).not.toBeNull();
  });
});

describe("the calendar", () => {
  const month = TODAY.slice(0, 7);
  const titleButton = () =>
    document.querySelector("[data-calendar-month]") as HTMLElement;
  const search = (t: Awaited<ReturnType<typeof mountTasks>>) =>
    t.router.state.location.search as Record<string, unknown>;

  test("the month's days carry the tasks dated on them; the header names the month in view; a day leads to Today's view of it", async () => {
    const a = await seededTask({ title: "Dentist, Milo", date: TODAY });
    const t = await mountTasks({
      path: `/calendar?at=${TODAY}&tz=UTC`,
      rows: a.rows,
      env: { online: false },
    });
    await t.until(
      () =>
        document.querySelector(`[data-calendar-row="${a.occurrenceId}"]`) !==
        null,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Calendar" }),
    ).toBeInTheDocument();
    expect(titleButton().getAttribute("data-calendar-month")).toBe(month);
    expect(titleButton().textContent).toContain(monthLabel(month));
    expect(document.querySelector("[data-page-summary]")?.textContent).toBe(
      CALENDAR_COPY.things(1),
    );
    const cell = document.querySelector(
      `[data-calendar-day="${TODAY}"]`,
    ) as HTMLElement;
    expect(within(cell).getByText("Dentist, Milo")).toBeInTheDocument();
    const dayLink = within(cell).getAllByRole("link")[0] as HTMLElement;
    expect(dayLink.getAttribute("href")).toContain(`/today?day=${TODAY}`);
    // The window around the day: two months behind, eight ahead, each a block.
    expect(
      document.querySelector(
        `[data-calendar-block="${shiftMonth(month, -2)}"]`,
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(`[data-calendar-block="${shiftMonth(month, 8)}"]`),
    ).not.toBeNull();
    expect(
      document.querySelectorAll("[data-calendar-weekdays] span"),
    ).toHaveLength(7);
    expect(screen.queryByText(copy.UNTITLED)).toBeNull();
  });

  test("the arrows move a month and write the day in view to the address; the legacy month address is read", async () => {
    const t = await mountTasks({
      path: `/calendar?month=${month}&tz=UTC`,
      env: { online: false },
    });
    await t.until(() => titleButton() !== null);
    expect(search(t).at).toBe(`${month}-01`);
    fireEvent.click(
      screen.getByRole("button", { name: CALENDAR_COPY.next.month }),
    );
    await t.until(() => search(t).at === `${shiftMonth(month, 1)}-01`);
    await t.until(
      () =>
        titleButton().getAttribute("data-calendar-month") ===
        shiftMonth(month, 1),
    );
    expect(titleButton().getAttribute("data-calendar-month")).toBe(
      shiftMonth(month, 1),
    );
    fireEvent.click(
      screen.getByRole("button", { name: CALENDAR_COPY.previous.month }),
    );
    await t.until(() => search(t).at === `${month}-01`);
  });

  test("the picker chooses a month a year away: the address and the block follow, and the window grew to hold it", async () => {
    const t = await mountTasks({
      path: `/calendar?at=${TODAY}&tz=UTC`,
      env: { online: false },
    });
    await t.until(() => titleButton() !== null);
    fireEvent.click(titleButton());
    const picker = screen.getByRole("dialog", { name: CALENDAR_COPY.pick });
    expect(
      within(picker).getByRole("button", { name: monthLabel(month) }),
    ).toHaveAttribute("aria-current", "true");
    fireEvent.click(
      within(picker).getByRole("button", { name: CALENDAR_COPY.yearNext }),
    );
    const target = shiftMonth(month, 12);
    fireEvent.click(
      within(picker).getByRole("button", { name: monthLabel(target) }),
    );
    await t.until(() => search(t).at === `${target}-01`);
    expect(
      screen.queryByRole("dialog", { name: CALENDAR_COPY.pick }),
    ).toBeNull();
    await t.until(
      () =>
        document.querySelector(`[data-calendar-block="${target}"]`) !== null,
    );
    await t.until(
      () => titleButton().getAttribute("data-calendar-month") === target,
    );
    expect(titleButton().getAttribute("data-calendar-month")).toBe(target);
    // Today from the picker comes back.
    fireEvent.click(titleButton());
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: CALENDAR_COPY.pick }),
      ).getByRole("button", { name: CALENDAR_COPY.today }),
    );
    await t.until(() => search(t).at === TODAY);
  });

  test("the week view stacks Monday weeks; Weekends off keeps Monday to Friday", async () => {
    const a = await seededTask({ title: "Shopping with Nan", date: TODAY });
    const t = await mountTasks({
      path: `/calendar?view=week&at=${TODAY}&tz=UTC`,
      rows: a.rows,
      env: { online: false },
    });
    await t.until(
      () =>
        document.querySelector(`[data-calendar-row="${a.occurrenceId}"]`) !==
        null,
    );
    const monday = mondayOf(TODAY);
    expect(titleButton().getAttribute("data-calendar-month")).toBe(monday);
    expect(titleButton().textContent).toContain(weekLabel(monday));
    expect(
      document.querySelector(
        `[data-calendar-block="${monday}"] [data-calendar-day="${TODAY}"]`,
      ),
    ).not.toBeNull();
    // The header names the week once: its number and its count under the title.
    expect(document.querySelector("[data-page-summary]")?.textContent).toBe(
      `${CALENDAR_COPY.week(isoWeek(monday))} · ${CALENDAR_COPY.things(1)}`,
    );
    expect(
      document.querySelectorAll("[data-calendar-weekdays] span"),
    ).toHaveLength(7);
    fireEvent.click(
      screen.getByRole("button", { name: CALENDAR_COPY.weekends }),
    );
    await t.until(() => search(t).weekends === false);
    await t.until(
      () =>
        document.querySelectorAll("[data-calendar-weekdays] span").length === 5,
    );
    expect(
      document.querySelector(`[data-calendar-day="${addDays(monday, 5)}"]`),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: CALENDAR_COPY.views.month }),
    );
    await t.until(() => search(t).view === undefined);
    await t.until(
      () => titleButton().getAttribute("data-calendar-month") === month,
    );
    expect(titleButton().getAttribute("data-calendar-month")).toBe(month);
  });
});

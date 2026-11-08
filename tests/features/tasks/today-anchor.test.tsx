import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { longDayLabel } from "../../../src/features/tasks/format";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { addDays } from "../../../src/features/tasks/model/time";
import { REVEAL_DISTANCE } from "../../../src/features/tasks/today/reveal";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/**
 * Today and Upcoming are ONE page (the Final design, revised 8 November 2026): Upcoming is the anchor `/today#upcoming`, the old address
 * redirects there, the rail lights the half the address names, and the sticky bar names the block of the days ahead under it. Recording
 * an amount from a row happens in line with its button.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;

describe("Upcoming as an anchor of Today", () => {
  test("the rail's Upcoming leads to the anchor, lit by the hash; /upcoming redirects there", async () => {
    const task = await seededTask({ title: "Brush your teeth" });
    const ahead = await seededTask({
      title: "Dentist, Milo",
      date: addDays(TODAY, 1),
    });
    const t = await mountTasks({
      path: "/upcoming",
      rows: [...task.rows, ...ahead.rows],
      env: { online: false },
    });
    await t.until(() => t.router.state.location.hash === "upcoming");
    expect(t.router.state.location.pathname).toBe("/today");
    await t.until(() => document.querySelector("[data-today-page]") !== null);
    // One page, one h1 ("Today"); the days ahead are the same page's second half.
    expect(
      screen.getByRole("heading", { level: 1, name: "Today" }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const upcoming = within(nav).getByRole("link", { name: "Upcoming" });
    expect(upcoming).toHaveAttribute("href", "/today#upcoming");
    expect(upcoming).toHaveAttribute("aria-current", "page");
    expect(
      within(nav).getByRole("link", { name: "Today" }),
    ).not.toHaveAttribute("aria-current");
    // The blocks of the days ahead carry what the sticky bar says while they are under it ("Tomorrow · Monday 9 November").
    await t.until(
      () =>
        document.querySelector('[data-rail-heading^="Tomorrow · "]') !== null,
    );
    const tomorrow = document.querySelector(
      '[data-rail-heading^="Tomorrow · "]',
    ) as HTMLElement;
    expect(tomorrow.dataset.railSection).toBe("upcoming");
    expect(tomorrow.dataset.railHeading).toBe(
      copy.UPCOMING.bar(
        copy.UPCOMING.tomorrow,
        longDayLabel(addDays(TODAY, 1)),
      ),
    );
  });

  test("Today's rail item is lit at /today; the Upcoming fold is on the same page", async () => {
    const task = await seededTask({ title: "Brush your teeth" });
    const t = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Today" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Upcoming" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("button", { name: copy.FOLD_UPCOMING }),
    ).toBeInTheDocument();
  });
});

describe("recording from a row, in line with its button", () => {
  test("an amount: the tick opens the field beside it; Record queues the quantity and closes it", async () => {
    const task = await seededTask({
      title: "Water",
      definition: {
        goal: { kind: "numeric", minimum: "8", maximum: null, unit: "glasses" },
      },
    });
    const t = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const r = row(task.occurrenceId) as HTMLElement;
    const tick = within(r).getByRole("button", { name: copy.LOG_AMOUNT });
    expect(tick).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tick);
    const recorder = r.querySelector(
      "[data-row-recorder=numeric]",
    ) as HTMLElement;
    expect(recorder).not.toBeNull();
    // The recorder sits in the row's trailing group, beside the button, not under the title.
    expect(recorder.parentElement).toBe(
      within(r).getByRole("button", { name: copy.CLOSE_RECORDER })
        .parentElement,
    );
    expect(within(r).queryByText(copy.JUST_CHECKED)).toBeNull();
    const field = within(r).getByLabelText(copy.AMOUNT_LABEL("glasses"));
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "2.5" } });
    fireEvent.click(within(r).getByRole("button", { name: copy.RECORD }));
    await t.settle();
    const draft = t.drafts()[0];
    expect(draft?.kind).toBe("record");
    await t.until(
      () =>
        row(task.occurrenceId)?.querySelector("[data-row-recorder]") === null,
    );
  });

  test("a checklist: the items as pressed pills beside the button", async () => {
    const task = await seededTask({
      title: "Pack",
      definition: {
        goal: {
          kind: "checklist",
          items: [
            { id: "11111111-1111-4111-8111-111111111111", label: "Towel" },
            { id: "22222222-2222-4222-8222-222222222222", label: "Goggles" },
          ],
        },
      },
    });
    const t = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const r = row(task.occurrenceId) as HTMLElement;
    fireEvent.click(within(r).getByRole("button", { name: copy.TICK_ITEMS }));
    const towel = within(r).getByRole("button", { name: "Towel" });
    expect(towel).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(towel);
    await t.settle();
    expect(t.drafts()[0]?.kind).toBe("record");
  });
});

describe("the fold, and the pull past the end of the day", () => {
  test("the days ahead are folded to begin with; a pull past the end reveals them and the address follows; the pill folds and reveals", async () => {
    const task = await seededTask({ title: "Brush your teeth" });
    const ahead = await seededTask({
      title: "Dentist, Milo",
      date: addDays(TODAY, 1),
    });
    const t = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC`,
      rows: [...task.rows, ...ahead.rows],
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    expect(document.querySelector("[data-upcoming]")).toBeNull();
    const fold = screen.getByRole("button", { name: copy.FOLD_UPCOMING });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    // A layout engine without geometry is always at the end of the page: a wheel pull fills the fold's line, then reveals.
    act(() => {
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    });
    expect(document.querySelector("[data-today-fold-progress]")).not.toBeNull();
    act(() => {
      window.dispatchEvent(
        new WheelEvent("wheel", { deltaY: REVEAL_DISTANCE }),
      );
    });
    await t.until(() => document.querySelector("[data-upcoming]") !== null);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    await t.until(() => t.router.state.location.hash === "upcoming");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Upcoming" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Folding the days away from there brings the navigation back to Today; the pill reveals them again.
    fireEvent.click(fold);
    await t.until(() => t.router.state.location.hash === "");
    expect(document.querySelector("[data-upcoming]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.FOLD_UPCOMING }));
    await t.until(() => document.querySelector("[data-upcoming]") !== null);
    await t.until(() => t.router.state.location.hash === "upcoming");
  });

  test("the bar's labels: tomorrow, the rest of the week and next week a day at a time, then a month a week at a time", async () => {
    const weekday = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7;
    const sunday = addDays(TODAY, 6 - weekday);
    const nextWeekDay =
      addDays(sunday, 1) > addDays(TODAY, 2)
        ? addDays(sunday, 1)
        : addDays(TODAY, 2);
    const later = addDays(TODAY, 30);
    const rows = (
      await Promise.all([
        seededTask({ title: "Dentist, Milo", date: addDays(TODAY, 1) }),
        seededTask({ title: "Shopping with Nan", date: nextWeekDay }),
        seededTask({ title: "Renew passports", date: later }),
      ])
    ).flatMap((seeded) => seeded.rows);
    const t = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC#upcoming`,
      rows,
      env: { online: false },
    });
    await t.until(
      () =>
        document.querySelectorAll('[data-rail-section="upcoming"]').length >= 3,
    );
    const labels = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-rail-section="upcoming"]',
      ),
    ].map((heading) => heading.dataset.railHeading ?? "");
    expect(labels).toContain(
      copy.UPCOMING.bar(
        copy.UPCOMING.tomorrow,
        longDayLabel(addDays(TODAY, 1)),
      ),
    );
    expect(labels).toContain(
      copy.UPCOMING.bar(copy.UPCOMING.nextWeek, longDayLabel(nextWeekDay)),
    );
    const month = new Intl.DateTimeFormat("en-GB", {
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${later}T00:00:00Z`));
    expect(labels.some((label) => label.startsWith(`${month}`))).toBe(true);
    expect(labels.some((label) => label.startsWith("Later"))).toBe(false);
  });
});

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  readTaskWrapper,
  TASK_WRAPPER_STORAGE_KEY,
} from "../../../src/app/shell/preferences";
import { LAYOUT_COPY } from "../../../src/features/settings/layout/LayoutPage";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { effectiveWrapper } from "../../../src/features/tasks/screens";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/**
 * Settings · Layout, "How things open" (the Final design, 8 November 2026): the task view is one component and each container is a
 * layout around it. On the desktop the split pane keeps the day on the left; the side peek floats over it and the overlay is centred;
 * a page replaces it. The phone always opens a page, and the split pane falls back to a page below the desktop width.
 */
const media = installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  media.set({ width: 1440 });
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;

describe("the container a task opens in", () => {
  test.each([
    ["split", "desktop", "split"],
    ["split", "tablet", "page"],
    ["split", "mobile", "page"],
    ["peek", "tablet", "peek"],
    ["peek", "mobile", "page"],
    ["overlay", "desktop", "overlay"],
    ["page", "desktop", "page"],
  ] as const)("%s on the %s is %s", (wrapper, mode, expected) => {
    expect(effectiveWrapper(wrapper, mode)).toBe(expected);
  });

  test("split pane: the row opens the task beside the day, as a region with its own h2; Close returns to the day alone", async () => {
    const task = await seededTask({ title: "Take the bins out" });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
      wrapper: "split",
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const link = within(row(task.occurrenceId) as HTMLElement).getByRole(
      "link",
      { name: "Take the bins out" },
    );
    expect(link.getAttribute("href")).toContain(`task=${task.taskId}`);
    expect(link.getAttribute("href")).toContain("/today?");
    fireEvent.click(link);
    await t.until(
      () => document.querySelector("[data-task-pane=split]") !== null,
    );
    const pane = document.querySelector(
      "[data-task-pane=split]",
    ) as HTMLElement;
    expect(
      within(pane).getByRole("heading", {
        level: 2,
        name: "Take the bins out",
      }),
    ).toBeInTheDocument();
    // The day keeps its one h1; the task beside it is not another page.
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("[data-today-page]")).not.toBeNull();
    fireEvent.click(
      within(pane).getByRole("button", { name: DETAIL_COPY.close }),
    );
    await t.until(
      () => document.querySelector("[data-task-pane=split]") === null,
    );
    expect(t.router.state.location.search).not.toHaveProperty("task");
  });

  test("side peek: a dialog over the day; Escape closes it", async () => {
    const task = await seededTask({ title: "Read with Milo" });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
      wrapper: "peek",
    });
    await t.until(() => row(task.occurrenceId) !== null);
    fireEvent.click(
      within(row(task.occurrenceId) as HTMLElement).getByRole("link", {
        name: "Read with Milo",
      }),
    );
    await t.until(
      () => document.querySelector("[data-task-pane=peek]") !== null,
    );
    const pane = document.querySelector("[data-task-pane=peek]") as HTMLElement;
    expect(pane.getAttribute("role")).toBe("dialog");
    fireEvent.keyDown(pane, { key: "Escape" });
    await t.until(
      () => document.querySelector("[data-task-pane=peek]") === null,
    );
  });

  test("overlay: a centred dialog over the day", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
      wrapper: "overlay",
    });
    await t.until(() => row(task.occurrenceId) !== null);
    fireEvent.click(
      within(row(task.occurrenceId) as HTMLElement).getByRole("link", {
        name: "Water the plants",
      }),
    );
    await t.until(
      () => document.querySelector("[data-task-pane=overlay]") !== null,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("a page: the row leads to the task's own page, as before", async () => {
    const task = await seededTask({ title: "Pay the water bill" });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
      wrapper: "page",
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const link = within(row(task.occurrenceId) as HTMLElement).getByRole(
      "link",
      { name: "Pay the water bill" },
    );
    expect(link.getAttribute("href")).toBe(
      `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    );
  });
});

describe("Settings · Layout", () => {
  test("the four containers are offered; choosing one is kept on this device", async () => {
    const t = await mountTasks({
      path: "/settings/layout",
      env: { online: false },
      wrapper: "split",
    });
    await t.until(() => document.querySelector("[data-layout-page]") !== null);
    expect(
      screen.getByRole("heading", { level: 1, name: LAYOUT_COPY.title }),
    ).toBeInTheDocument();
    const split = screen.getByRole("radio", {
      name: LAYOUT_COPY.options.split.label,
    });
    expect(split).toBeChecked();
    expect(split).toHaveAccessibleDescription(LAYOUT_COPY.options.split.line);
    fireEvent.click(
      screen.getByRole("radio", { name: LAYOUT_COPY.options.peek.label }),
    );
    expect(readTaskWrapper()).toBe("peek");
    expect(localStorage.getItem(TASK_WRAPPER_STORAGE_KEY)).toBe("peek");
    expect(screen.getByText(LAYOUT_COPY.also[2].how)).toBeInTheDocument();
  });
});

describe("how things open: all the tasks", () => {
  test("with the split pane chosen, a row opens the task beside the list at /tasks?task=", async () => {
    const task = await seededTask({ title: "Take the bins out" });
    const t = await mountTasks({
      path: "/tasks",
      rows: task.rows,
      env: { online: false },
      wrapper: "split",
    });
    await t.until(
      () =>
        document.querySelector(`[data-task-link="${task.taskId}"]`) !== null,
    );
    const link = document.querySelector(
      `[data-task-link="${task.taskId}"]`,
    ) as HTMLElement;
    expect(link.getAttribute("href")).toBe(`/tasks?task=${task.taskId}`);
    fireEvent.click(link);
    await t.until(
      () => document.querySelector("[data-task-pane=split]") !== null,
    );
    expect(document.querySelector("[data-tasks-split]")).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeInTheDocument();
    const pane = document.querySelector(
      "[data-task-pane=split]",
    ) as HTMLElement;
    await t.until(
      () =>
        within(pane).queryByRole("heading", {
          level: 2,
          name: "Take the bins out",
        }) !== null,
    );
  });
});

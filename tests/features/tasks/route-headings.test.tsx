import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/**
 * Revision 2 (a regression of revisions 0-1 found by the shell and sync-screen specs): Today and the task list replaced placeholders whose
 * level-one heading was always there. Their heading is now the ROUTE's, outside the cache gate and the lazy screens, so a page has its one
 * h1 whatever the gate shows and at once (RouteFocus moves focus to it). A task's own page shows the list's heading while the gate hides it.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});
const h1 = () =>
  [...document.querySelectorAll("h1[data-page-heading]")].map(
    (h) => h.textContent,
  );

describe("the destinations' level-one heading", () => {
  test("Today: one h1 while the cache gate hides the day, and one once the day shows", async () => {
    const gated = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC`,
      cacheStatus: "invalid",
    });
    await gated.settle();
    expect(document.querySelector("[data-cache-gate]")).not.toBeNull();
    expect(document.querySelector("[data-today-page]")).toBeNull();
    expect(h1()).toEqual(["Today"]);
    gated.unmount();
    const task = await seededTask();
    const open = await mountTasks({
      path: `/today?day=${TODAY}&tz=UTC`,
      rows: task.rows,
    });
    await open.until(
      () => document.querySelector("[data-today-page]") !== null,
    );
    expect(document.querySelector("[data-today-page]")).not.toBeNull();
    expect(h1()).toEqual(["Today"]);
  });

  test("the task list: one h1 while gated and once shown; a task's page has its own h1 when shown and the list's while gated", async () => {
    const gated = await mountTasks({ path: "/tasks", cacheStatus: "invalid" });
    await gated.settle();
    expect(document.querySelector("[data-cache-gate]")).not.toBeNull();
    expect(h1()).toEqual(["Tasks"]);
    gated.unmount();
    const task = await seededTask({ title: "Water the plants" });
    const gatedDetail = await mountTasks({
      path: `/tasks/${task.taskId}`,
      cacheStatus: "invalid",
    });
    await gatedDetail.settle();
    expect(document.querySelector("[data-cache-gate]")).not.toBeNull();
    expect(h1()).toEqual(["Tasks"]);
    gatedDetail.unmount();
    const list = await mountTasks({ path: "/tasks", rows: task.rows });
    await list.until(
      () => document.querySelector("[data-tasks-layout]") !== null,
    );
    expect(h1()).toEqual(["Tasks"]);
    list.unmount();
    const detail = await mountTasks({
      path: `/tasks/${task.taskId}`,
      rows: task.rows,
    });
    await detail.until(
      () =>
        screen.queryByRole("heading", {
          level: 1,
          name: "Water the plants",
        }) !== null,
    );
    expect(h1()).toEqual(["Water the plants"]);
  });
});

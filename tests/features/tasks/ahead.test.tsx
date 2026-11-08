import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UPCOMING_FOLD_STORAGE_KEY } from "../../../src/app/shell/preferences";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetCatchUp } from "../../../src/features/tasks/catchup/useCatchUp";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { AHEAD_DAYS } from "../../../src/features/tasks/model/ahead";
import type {
  TaskDefinition,
  TaskDetail,
} from "../../../src/features/tasks/model/contract";
import { addDays } from "../../../src/features/tasks/model/time";
import {
  AHEAD_COPY,
  AHEAD_STORAGE_KEY,
} from "../../../src/features/tasks/today/Ahead";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
  TODAY,
} from "../../support/tasks/world";

/**
 * The look-ahead of the days ahead (the Final design, 8 November 2026; `today/Ahead.tsx`, `model/ahead.ts`): while the Upcoming fold is
 * open, Today asks the page's runner to bring every task this device knows of up to date through the horizon (trigger `ahead`), says so,
 * notes the plan once it settles, and shows a stop with its reason and Try again. The app's router over the PRODUCTION data controller
 * and the IndexedDB double, with a scripted client.
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  localStorage.removeItem(AHEAD_STORAGE_KEY);
  localStorage.removeItem(UPCOMING_FOLD_STORAGE_KEY);
});
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetCatchUp();
  localStorage.removeItem(AHEAD_STORAGE_KEY);
  localStorage.removeItem(UPCOMING_FOLD_STORAGE_KEY);
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const HORIZON = addDays(TODAY, AHEAD_DAYS);
const status = () =>
  document.querySelector("[data-ahead]") as HTMLElement | null;

const position = (
  task: SeededTask,
  last: string | null,
  pending: boolean,
): TasksResult<TaskDetail> => ({
  ok: true,
  value: {
    task: task.rows[0] as never,
    execution: task.rows[1] as never,
    materialisation: { last_date: last, pending },
  },
});

/** A client whose position moves to whatever day was last asked for (the server generated through it). */
function serverThatPlans(task: SeededTask) {
  let through: string | null = null;
  const asked: string[] = [];
  const triggers: string[] = [];
  const api = fakeApi({
    readTask: async () => position(task, through, false),
    materialise: async (command) => {
      asked.push(command.through_date);
      through = command.through_date;
      return { ok: true, value: { revision: 9 } };
    },
  });
  return { api, asked, triggers };
}

const daily = (over: Partial<TaskDefinition["schedule"]> = {}) =>
  seededTask({
    title: "Tidy room",
    definition: {
      schedule: {
        start_date: "2026-01-01",
        time: null,
        timezone: "UTC",
        repeat: { frequency: "daily", interval: 1 },
        ...over,
      },
    },
  });

describe("the look-ahead", () => {
  test("a repeating task is brought up to date through the horizon, with the plan said and then noted", async () => {
    const task = await daily();
    const { api, asked } = serverThatPlans(task);
    const t = await mountTasks({ path: PATH, rows: task.rows, api });
    await t.until(() => status()?.dataset.ahead === "planned");
    expect(asked).toEqual([HORIZON]);
    expect(status()).toHaveTextContent(/^Planned with the server through /);
    // The runner's record names the trigger (the daily banner shows none of it: the task was not listed as pending).
    const stores = t.world.idb.snapshot(accountDatabaseName(ME));
    const rows = (stores?.materialise_sequences ?? []) as Array<{
      trigger: string;
    }>;
    expect(rows.every((row) => row.trigger === "ahead")).toBe(true);
    expect(document.querySelector("[data-pending-tasks]")).toBeNull();
    // Settled: noted on this device, so a fresh page asks nothing for the same plan.
    expect(localStorage.getItem(AHEAD_STORAGE_KEY)).not.toBeNull();
    t.unmount();
    forgetCatchUp();
    const again = serverThatPlans(task);
    const t2 = await mountTasks({
      path: PATH,
      rows: task.rows,
      api: again.api,
    });
    await t2.until(() => status()?.dataset.ahead === "planned");
    expect(again.asked).toEqual([]);
    expect(again.api.calls.readTask ?? 0).toBe(0);
  });

  test("a one-off ahead is asked for through its own day; one on today is not asked for at all", async () => {
    const soon = await seededTask({
      title: "Dentist",
      date: addDays(TODAY, 5),
      definition: {
        schedule: {
          start_date: addDays(TODAY, 5),
          time: null,
          timezone: "UTC",
          repeat: null,
        },
      },
    });
    const now = await seededTask({ title: "Sort the recycling" });
    const { api, asked } = serverThatPlans(soon);
    const t = await mountTasks({
      path: PATH,
      rows: [...soon.rows, ...now.rows],
      api,
    });
    await t.until(() => status()?.dataset.ahead === "planned");
    expect(asked).toEqual([addDays(TODAY, 5)]);
  });

  test("a stop is shown with its reason and Try again, and the plan is not noted", async () => {
    const task = await daily();
    // The server accepts and never moves: the runner stops with no progress.
    const api = fakeApi({
      readTask: async () => position(task, "2026-01-01", false),
      materialise: async () => ({ ok: true, value: { revision: 9 } }),
    });
    const t = await mountTasks({ path: PATH, rows: task.rows, api });
    await t.until(
      () => document.querySelector("[data-ahead-stopped]") !== null,
    );
    const stop = document.querySelector("[data-ahead-stopped]") as HTMLElement;
    expect(stop.dataset.aheadStopped).toBe("no_progress");
    expect(stop).toHaveTextContent(AHEAD_COPY.stopped("Tidy room"));
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(localStorage.getItem(AHEAD_STORAGE_KEY)).toBeNull();
  });

  test("with the fold folded away nothing is asked; offline the plan waits", async () => {
    localStorage.setItem(UPCOMING_FOLD_STORAGE_KEY, "folded");
    const task = await daily();
    const { api, asked } = serverThatPlans(task);
    const t = await mountTasks({ path: PATH, rows: task.rows, api });
    await t.settle();
    expect(document.querySelector("[data-upcoming]")).toBeNull();
    expect(asked).toEqual([]);
    t.unmount();
    localStorage.removeItem(UPCOMING_FOLD_STORAGE_KEY);
    const offline = serverThatPlans(task);
    const t2 = await mountTasks({
      path: PATH,
      rows: task.rows,
      api: offline.api,
      env: { online: false },
    });
    await t2.until(() => status() !== null);
    expect(status()?.dataset.ahead).toBe("paused");
    expect(status()).toHaveTextContent(AHEAD_COPY.paused);
    expect(offline.asked).toEqual([]);
  });
});

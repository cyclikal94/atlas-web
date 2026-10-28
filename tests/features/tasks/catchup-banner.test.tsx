import { cleanup, fireEvent, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MaterialiseSequenceRow } from "../../../src/data/model/types";
import { createConflictHandlerRegistry } from "../../../src/data/outbox/registries";
import type { TasksResult } from "../../../src/features/tasks/api";
import {
  forgetCatchUp,
  registerCatchUpConflicts,
  runnerForAccount,
} from "../../../src/features/tasks/catchup/useCatchUp";
import * as copy from "../../../src/features/tasks/copy";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrencePage,
  TaskDetail,
} from "../../../src/features/tasks/model/contract";
import { addDays } from "../../../src/features/tasks/model/time";
import { CATCH_UP_COPY } from "../../../src/features/tasks/today/CatchUpBanner";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * WF-TODAY-01 C (A1, A19): Today brings the tasks its current `/daily` answer lists in `pending_tasks` up to date automatically, and the
 * banner says so: running, each stop with its reason and Try again, paused offline or while incompatible, gone once the next current
 * answer no longer lists the task. The app's router over the PRODUCTION data controller and the IndexedDB double, with a scripted client.
 * FIXTURE evidence: a stubbed answer is the stub's.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetCatchUp();
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const banner = () =>
  document.querySelector("[data-pending-tasks]") as HTMLElement | null;
const polite = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";

/** Counts every call of the overridden methods too (`fakeApi` counts only its defaults). */
function counted(over: Parameters<typeof fakeApi>[0]) {
  const calls = { readTask: 0, materialise: 0 };
  const api = fakeApi({
    readTask: async (id) => {
      calls.readTask += 1;
      return over?.readTask
        ? over.readTask(id)
        : { ok: false, kind: "uncertain" };
    },
    materialise: async (command, key) => {
      calls.materialise += 1;
      return over?.materialise
        ? over.materialise(command, key)
        : { ok: false, kind: "uncertain" };
    },
  });
  return { api, calls };
}

const daily = (pending: string[]): TasksResult<OccurrencePage> => ({
  ok: true,
  value: { items: [], next_after: null, revision: 5, pending_tasks: pending },
});
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
const stopped = (
  task: SeededTask,
  reason: NonNullable<MaterialiseSequenceRow["stop"]>["reason"],
  requestId?: string,
): MaterialiseSequenceRow => ({
  task_id: task.taskId,
  through_date: TODAY,
  sequence_generation: "g",
  phase: "stopped",
  attempt: null,
  read_seq: 1,
  successful_calls: 1,
  last_known_position: "2026-01-01",
  started_at: 1,
  read_failures: 0,
  stop:
    requestId === undefined ? { reason } : { reason, request_id: requestId },
  trigger: "daily",
});

describe("A1: listed tasks are caught up automatically", () => {
  test("running, then done (announced once); the banner leaves when Today's next current answer no longer lists the task", async () => {
    const task = await seededTask({ title: "Water the plants" });
    let listed = true;
    const reads: Array<TasksResult<TaskDetail>> = [
      position(task, "2026-01-01", true),
      position(task, TODAY, false),
    ];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const { api, calls } = counted({
      readTask: async () => reads.shift() ?? position(task, TODAY, false),
      materialise: async () => {
        await held;
        return { ok: true, value: { revision: 9 } };
      },
    });
    api.respond = (q) =>
      q.scope === "joint" ? daily(listed ? [task.taskId] : []) : daily([]);
    const t = await mountTasks({ path: PATH, rows: task.rows, api });
    await t.until(() => banner()?.dataset.catchUp === "running");
    expect(banner()).toHaveTextContent(CATCH_UP_COPY.running(1));
    expect((await axe(banner() as HTMLElement)).violations).toEqual([]);
    release();
    await t.until(() => polite() === CATCH_UP_COPY.done);
    expect(polite()).toBe(CATCH_UP_COPY.done);
    expect(calls.materialise).toBe(1);
    // The new occurrences arrive by sync; Today asks again and the answer no longer lists the task.
    listed = false;
    await t.commitSync([task.rows[0] as never]);
    await t.until(() => banner() === null);
    expect(banner()).toBeNull();
  });

  test("a stop is shown with its task, reason and request ID, and Try again gives a fresh budget (sent once more)", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const reads = [
      position(task, "2026-01-01", true),
      position(task, TODAY, false),
    ];
    const { api, calls } = counted({
      readTask: async () => reads.shift() ?? position(task, TODAY, false),
      materialise: async () => ({ ok: true, value: { revision: 9 } }),
    });
    api.respond = (q) =>
      q.scope === "joint" ? daily([task.taskId]) : daily([]);
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      api,
      sequences: [stopped(task, "no_progress", "req-1")],
    });
    await t.until(
      () =>
        document.querySelector("[data-catch-up-stopped]") !== null &&
        calls.readTask > 0 &&
        (banner()?.textContent ?? "").includes("Water the plants"),
    );
    const stop = document.querySelector(
      "[data-catch-up-stopped]",
    ) as HTMLElement;
    // Revision 4: still shown (an automatic catch-up that lifted it would leave nothing to read, which is this assertion's failure).
    expect(stop, "the stop is still shown").not.toBeNull();
    expect(stop.dataset.catchUpStopped).toBe("no_progress");
    expect(stop).toHaveTextContent(CATCH_UP_COPY.stopped("Water the plants"));
    expect(stop).toHaveTextContent(CATCH_UP_COPY.reason.no_progress);
    expect(stop).toHaveTextContent(copy.REQUEST_ID("req-1"));
    // MU-10C-08 (screen): Today's automatic catch-up never resumes a stop.
    expect(calls.materialise).toBe(0);
    expect((await axe(banner() as HTMLElement)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await t.until(
      () => document.querySelector("[data-catch-up-stopped]") === null,
    );
    expect(calls.materialise).toBe(1);
    expect(document.querySelector("[data-catch-up-stopped]")).toBeNull();
  });

  test("each reason has its own line, and a horizon stop offers no Try again", async () => {
    const tasks = await Promise.all(
      (["bound", "capacity", "rejected", "horizon"] as const).map((n) =>
        seededTask({ title: `Task ${n}` }),
      ),
    );
    const reasons = ["bound", "capacity", "rejected", "horizon"] as const;
    const api = fakeApi();
    api.respond = (q) =>
      q.scope === "joint" ? daily(tasks.map((x) => x.taskId)) : daily([]);
    const t = await mountTasks({
      path: PATH,
      rows: tasks.flatMap((x) => x.rows),
      api,
      sequences: tasks.map((x, i) => stopped(x, reasons[i] as never)),
    });
    await t.until(
      () => document.querySelectorAll("[data-catch-up-stopped]").length === 4,
    );
    for (const [i, reason] of reasons.entries()) {
      const node = document.querySelector(
        `[data-catch-up-task="${tasks[i]?.taskId}"]`,
      ) as HTMLElement;
      expect(node).toHaveTextContent(CATCH_UP_COPY.reason[reason]);
      expect(node.querySelector("button") !== null).toBe(reason !== "horizon");
    }
  });
});

describe("paused: offline, or not compatible with the server", () => {
  test("not compatible: the banner waits with its reason and nothing is read or sent; offline there is no banner and nothing is read", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const { api, calls } = counted({
      readTask: () => new Promise(() => undefined),
    });
    api.respond = (q) =>
      q.scope === "joint" ? daily([task.taskId]) : daily([]);
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      api,
      env: { writable: false },
    });
    await t.until(() => banner() !== null);
    expect(banner()?.dataset.catchUp).toBe("paused");
    expect(banner()).toHaveTextContent(CATCH_UP_COPY.paused);
    expect(banner()).toHaveTextContent(copy.PENDING_TASKS);
    expect(calls.readTask).toBe(0);
    expect(calls.materialise).toBe(0);
    // Offline, Today's day is the device's (WEB-10a decision 16: the last answer lists nothing), so there is no banner either: nothing
    // is read or sent until the connection is back.
    t.rerender(tasksEnv(api, { online: false, writable: true }));
    await t.settle();
    expect(banner()).toBeNull();
    expect(calls.readTask).toBe(0);
  });
});

/**
 * Revision 1 (review R8): the catch-up SERVICE is held by every task screen, not only Today's banner and the streak, so a command refused
 * with `materialisation_required` on a directly opened task detail starts a catch-up; and a STOPPED catch-up of the task is shown on its
 * detail, where the waiting command is, with its reason and "Try again" (WEB-04 §5.8: never a silent rejection).
 */
describe("R8: the command path on a task's own detail", () => {
  const detailPath = (task: SeededTask) =>
    `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;

  test("a directly opened detail holds a live service: a refused task command starts the task's catch-up", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const { api, calls } = counted({
      readTask: async () => position(task, TODAY, false),
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      api,
    });
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    const registry = createConflictHandlerRegistry();
    registerCatchUpConflicts(registry);
    expect(
      registry.decide({
        draft: draftRow({
          account_id: ME,
          kind: "archive",
          endpoint: "/task-commands",
          command: {
            command: {
              kind: "archive",
              id: task.taskId,
              expected_version: 1,
              archived: true,
            },
          },
        }),
        status: 409,
        code: "materialisation_required",
      }),
    ).toEqual({ kind: "reclassify", as: "retry" });
    await t.until(() => calls.readTask > 0);
    expect(
      calls.readTask,
      "the catch-up read the task's position",
    ).toBeGreaterThan(0);
  });

  test("the account's timers (no catch-up shown there) hold the service too: a refused task command starts the catch-up", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const { api, calls } = counted({
      readTask: async () => position(task, TODAY, false),
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(() => document.querySelector("[data-timers-page]") !== null);
    const registry = createConflictHandlerRegistry();
    registerCatchUpConflicts(registry);
    expect(
      registry.decide({
        draft: draftRow({
          account_id: ME,
          kind: "revise_task",
          endpoint: "/task-commands",
          command: { command: { kind: "revise_task", id: task.taskId } },
        }),
        status: 409,
        code: "materialisation_required",
      }),
    ).toEqual({ kind: "reclassify", as: "retry" });
    await t.until(() => calls.readTask > 0);
    expect(calls.readTask).toBeGreaterThan(0);
  });

  test("a stopped catch-up of the task is shown on its detail with its reason; Try again carries on from the position", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const { api, calls } = counted({
      readTask: async () => position(task, TODAY, false),
    });
    const t = await mountTasks({
      path: detailPath(task),
      rows: task.rows,
      api,
      sequences: [stopped(task, "bound")],
    });
    await t.until(
      () => document.querySelector("[data-catch-up-stopped]") !== null,
    );
    const notice = document.querySelector(
      "[data-catch-up-stopped]",
    ) as HTMLElement | null;
    expect(notice, "the stop is shown on the task's detail").not.toBeNull();
    if (notice === null) return;
    expect(notice.dataset.catchUpStopped).toBe("bound");
    expect(notice).toHaveTextContent(CATCH_UP_COPY.stopped("Water the plants"));
    expect(notice).toHaveTextContent(CATCH_UP_COPY.reason.bound);
    expect((await axe(notice)).violations).toEqual([]);
    const before = calls.readTask;
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await t.until(() => calls.readTask > before);
    expect(calls.readTask).toBeGreaterThan(before);
  });

  test("control: no stop of the task, nothing is shown; another task's stop is not this task's", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const other = await seededTask({ title: "Feed the cat" });
    const t = await mountTasks({
      path: detailPath(task),
      rows: [...task.rows, ...other.rows],
      sequences: [stopped(other, "bound")],
    });
    await t.until(() => document.querySelector("[data-task-detail]") !== null);
    await t.settle();
    expect(document.querySelector("[data-catch-up-stopped]")).toBeNull();
  });
});

/**
 * Revision 2 (review R13, DA-M1): a stopped DISCOVERY (the first read; recorded by any page of the account) is shown wherever the task's
 * stop is shown, admits no automatic read, and is lifted by Try again alone.
 */
describe("R13: a recorded discovery stop", () => {
  const unreachable = (task: SeededTask) => ({
    [task.taskId]: { retry: 0, failures: 3, stop: { reason: "unreachable" } },
  });

  test("Today shows another page's stop, reads nothing for it; Try again lifts it and catches up", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const reads = [
      position(task, "2026-01-01", true),
      position(task, TODAY, false),
    ];
    const { api, calls } = counted({
      readTask: async () => reads.shift() ?? position(task, TODAY, false),
      materialise: async () => ({ ok: true, value: { revision: 9 } }),
    });
    api.respond = (q) =>
      q.scope === "joint" ? daily([task.taskId]) : daily([]);
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      api,
      discovery: unreachable(task),
    });
    await t.until(
      () =>
        document.querySelector("[data-catch-up-stopped]") !== null &&
        (banner()?.textContent ?? "").includes("Water the plants"),
    );
    await t.settle();
    const stop = document.querySelector(
      "[data-catch-up-stopped]",
    ) as HTMLElement;
    // Revision 4: asserted shown before it is read (a stop not shown is this assertion's failure, not a TypeError).
    expect(stop, "another page's stop is shown").not.toBeNull();
    expect(stop.dataset.catchUpStopped).toBe("unreachable");
    expect(stop).toHaveTextContent(CATCH_UP_COPY.reason.unreachable);
    expect(calls.readTask).toBe(0);
    expect(calls.materialise).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await t.until(
      () => document.querySelector("[data-catch-up-stopped]") === null,
    );
    await t.until(() => calls.materialise === 1);
    expect(calls.materialise).toBe(1);
  });

  test("the task's detail shows it too; control: another task's discovery stop is not this task's", async () => {
    const task = await seededTask({ title: "Water the plants" });
    const other = await seededTask({ title: "Feed the cat" });
    const { api } = counted({});
    const t = await mountTasks({
      path: `/tasks/${task.taskId}`,
      rows: [...task.rows, ...other.rows],
      api,
      discovery: unreachable(task),
    });
    await t.until(
      () => document.querySelector("[data-catch-up-stopped]") !== null,
    );
    expect(
      document
        .querySelector("[data-catch-up-stopped]")
        ?.getAttribute("data-catch-up-task"),
    ).toBe(task.taskId);
    cleanup();
    forgetCatchUp();
    const again = await mountTasks({
      path: `/tasks/${other.taskId}`,
      rows: [...task.rows, ...other.rows],
      api,
      discovery: unreachable(task),
    });
    await again.until(
      () => document.querySelector("[data-task-detail]") !== null,
    );
    await again.settle();
    expect(document.querySelector("[data-catch-up-stopped]")).toBeNull();
  });
});

/**
 * Revision 4 (review R21, family `materialise-sequence-window-recovery`): a stop is read by its own task, never as a prefix of the
 * account's rows, so any number of other tasks' retained rows cannot hide its reason and Try again. REVIEW4 M5 is ported verbatim (99 and
 * 100 earlier-sorting stopped tasks; 101 added); the task's own detail is the second public caller.
 */
describe("R21: a stop is reachable however many other tasks' rows sort first", () => {
  const others = (target: MaterialiseSequenceRow, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...target,
      task_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    }));

  test.each([99, 100, 101])(
    "REVIEW4 M5 (ported): %s other stopped tasks before this task",
    async (n) => {
      const task = await seededTask({
        title: "Needs catch-up",
        definition: {
          schedule: {
            start_date: "2026-01-01",
            time: null,
            timezone: "UTC",
            repeat: { frequency: "daily", interval: 1 },
          },
        },
      });
      const target = stopped(task, "bound");
      const { api, calls } = counted({
        readTask: async () => position(task, "2026-01-01", true),
      });
      api.respond = (q) =>
        q.scope === "joint" ? daily([task.taskId]) : daily([]);
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api,
        sequences: [...others(target, n), target],
      });
      await t.until(
        () => calls.readTask > 0 && banner()?.dataset.catchUp === "idle",
      );
      expect(calls.materialise).toBe(0);
      const notice = document.querySelector(
        `[data-catch-up-task="${task.taskId}"]`,
      );
      expect(notice).not.toBeNull();
      expect(notice).toHaveTextContent(CATCH_UP_COPY.reason.bound);
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    },
  );

  test.each([
    ["100 other tasks' stops sort first", 100],
    ["none (control)", 0],
  ])(
    "the task's own detail shows its stop and Try again lifts it: %s",
    async (_, n) => {
      const task = await seededTask({
        title: "Needs catch-up",
        definition: {
          schedule: {
            start_date: "2026-01-01",
            time: null,
            timezone: "UTC",
            repeat: { frequency: "daily", interval: 1 },
          },
        },
      });
      const target = stopped(task, "bound");
      const { api, calls } = counted({
        readTask: async () => position(task, "2026-01-01", true),
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        api,
        sequences: [...others(target, n), target],
      });
      await t.until(
        () =>
          document.querySelector(`[data-catch-up-task="${task.taskId}"]`) !==
          null,
      );
      expect(
        document.querySelector(`[data-catch-up-task="${task.taskId}"]`),
        "the task's stop is shown on its detail",
      ).not.toBeNull();
      expect(calls.materialise).toBe(0);
      const button = screen.queryByRole("button", { name: "Try again" });
      expect(button, "with Try again").not.toBeNull();
      fireEvent.click(button as HTMLElement);
      await t.until(() => calls.materialise > 0);
      // The press named the stop shown and lifted it: the fresh budget sends.
      expect(calls.materialise).toBeGreaterThan(0);
    },
  );
});

/** Revision 4 (review R20): the Try again on a stop names THAT stop (its generation and revision) to the runner, from Today and the detail. */
describe("R20: Try again names the stop it was pressed on", () => {
  test.each([
    ["Today's banner", "today"],
    ["the task's detail", "detail"],
  ])("%s", async (_, where) => {
    const task = await seededTask({
      title: "Needs catch-up",
      definition: {
        schedule: {
          start_date: "2026-01-01",
          time: null,
          timezone: "UTC",
          repeat: { frequency: "daily", interval: 1 },
        },
      },
    });
    const target = { ...stopped(task, "bound"), revision: 7 };
    const { api } = counted({
      readTask: () => new Promise(() => undefined),
    });
    api.respond = (q) =>
      q.scope === "joint" ? daily([task.taskId]) : daily([]);
    const t = await mountTasks({
      path:
        where === "today"
          ? PATH
          : `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      api,
      sequences: [target],
    });
    await t.until(
      () =>
        document.querySelector(`[data-catch-up-task="${task.taskId}"]`) !==
        null,
    );
    expect(
      document.querySelector(`[data-catch-up-task="${task.taskId}"]`),
      "the stop is shown",
    ).not.toBeNull();
    const runner = runnerForAccount(ME);
    expect(runner).not.toBeNull();
    const spy = vi.spyOn(runner as NonNullable<typeof runner>, "tryAgain");
    const button = screen.queryByRole("button", { name: "Try again" });
    expect(button, "with Try again").not.toBeNull();
    fireEvent.click(button as HTMLElement);
    // Revision 5 (R26): it also names the discovery stop shown beside it (none here).
    expect(spy).toHaveBeenCalledWith(task.taskId, TODAY, {
      kind: "sequence",
      generation: "g",
      revision: 7,
      discovery: null,
    });
  });
});

/**
 * Revision 5 (review 5 R24): a stop is reached by its own day. A later day (a horizon stop) never stands in for the day a screen works
 * for: Today shows its task's today once known; the detail shows every retained stop, each for its day, each Try again naming its own.
 * REVIEW5 M6 is ported verbatim.
 */
describe("R24: every relevant day's stop stays reachable", () => {
  const needs = () =>
    seededTask({
      title: "Needs catch-up",
      definition: {
        schedule: {
          start_date: "2026-01-01",
          time: null,
          timezone: "UTC",
          repeat: { frequency: "daily", interval: 1 },
        },
      },
    });
  test.each([false, true])(
    "REVIEW5 M6 (ported): later horizon stop hides today's bound stop=%s",
    async (later) => {
      const task = await needs();
      const target = stopped(task, "bound");
      const future = {
        ...stopped(task, "horizon"),
        through_date: addDays(TODAY, 32),
        sequence_generation: "future",
      };
      const { api, calls } = counted({
        readTask: async () => position(task, "2026-01-01", true),
      });
      api.respond = (q) =>
        q.scope === "joint" ? daily([task.taskId]) : daily([]);
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api,
        sequences: later ? [target, future] : [target],
      });
      await t.until(
        () => calls.readTask > 0 && banner()?.dataset.catchUp === "idle",
      );
      expect(calls.readTask).toBeGreaterThan(0);
      expect(banner()?.dataset.catchUp).toBe("idle");
      expect(calls.materialise).toBe(0);
      expect(
        document.querySelector(`[data-catch-up-task="${task.taskId}"]`),
      ).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: "Try again" }),
      ).not.toBeNull();
    },
  );

  test("once its day is known, Today shows that day's stop: an earlier day's retained stop is not Today's (the detail still shows both)", async () => {
    const task = await needs();
    const yesterday = {
      ...stopped(task, "bound"),
      through_date: addDays(TODAY, -1),
      sequence_generation: "y",
    };
    const today = stopped(task, "no_progress");
    const { api, calls } = counted({
      readTask: async () => position(task, "2026-01-01", true),
    });
    api.respond = (q) =>
      q.scope === "joint" ? daily([task.taskId]) : daily([]);
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      api,
      sequences: [yesterday, today],
    });
    await t.until(
      () =>
        calls.readTask > 0 &&
        banner()?.dataset.catchUp === "idle" &&
        document.querySelectorAll(`[data-catch-up-task="${task.taskId}"]`)
          .length === 1,
    );
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-catch-up-task="${task.taskId}"]`,
        ),
      ].map((n) => [n.dataset.catchUpDay, n.dataset.catchUpStopped]),
    ).toEqual([[TODAY, "no_progress"]]);
    expect(calls.materialise).toBe(0);
  });

  test("the task's detail: each retained stop for its own day, a horizon one without Try again; each Try again names its own stop", async () => {
    const task = await needs();
    const yesterday = addDays(TODAY, -1);
    const earlier = {
      ...stopped(task, "bound"),
      through_date: yesterday,
      revision: 3,
    };
    const future = {
      ...stopped(task, "horizon"),
      through_date: addDays(TODAY, 32),
      sequence_generation: "future",
    };
    const { api } = counted({
      readTask: () => new Promise(() => undefined),
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      api,
      sequences: [earlier, future],
    });
    await t.until(
      () =>
        document.querySelectorAll(`[data-catch-up-task="${task.taskId}"]`)
          .length === 2,
    );
    const days = [
      ...document.querySelectorAll<HTMLElement>(
        `[data-catch-up-task="${task.taskId}"]`,
      ),
    ].map((n) => [n.dataset.catchUpDay, n.dataset.catchUpStopped]);
    expect(days).toEqual([
      [yesterday, "bound"],
      [addDays(TODAY, 32), "horizon"],
    ]);
    const buttons = screen.getAllByRole("button", { name: "Try again" });
    expect(buttons).toHaveLength(1);
    const runner = runnerForAccount(ME);
    const spy = vi.spyOn(runner as NonNullable<typeof runner>, "tryAgain");
    fireEvent.click(buttons[0] as HTMLElement);
    expect(spy).toHaveBeenCalledWith(task.taskId, yesterday, {
      kind: "sequence",
      generation: "g",
      revision: 3,
      discovery: null,
    });
    expect(
      (await axe(document.querySelector("main") ?? document.body)).violations,
    ).toEqual([]);
  });
});

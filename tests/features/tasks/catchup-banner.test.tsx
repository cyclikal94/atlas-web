import { cleanup, fireEvent, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import type { MaterialiseSequenceRow } from "../../../src/data/model/types";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetCatchUp } from "../../../src/features/tasks/catchup/useCatchUp";
import * as copy from "../../../src/features/tasks/copy";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrencePage,
  TaskDetail,
} from "../../../src/features/tasks/model/contract";
import { CATCH_UP_COPY } from "../../../src/features/tasks/today/CatchUpBanner";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
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

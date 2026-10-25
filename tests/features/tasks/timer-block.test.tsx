import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import type { TasksResult } from "../../../src/features/tasks/api";
import { TIMER_COPY } from "../../../src/features/tasks/detail/Timer";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { TimerPage } from "../../../src/features/tasks/model/contract";
import { SEVEN_DAYS } from "../../../src/features/tasks/model/timers";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * WF-TASK-01's timer block under B6 (A12–A14; CM-355, 394, 422; TASK-6/6a): offered only for a goal measured in seconds; Start queued
 * offline; one running session per OCCURRENCE (another day's timer never blocks this one); Stop checked against the session's version;
 * the 7-day and closed-day choices; the cause-neutral conflict block; the day's sessions online. The PRODUCTION data controller, outbox
 * and screens over the IndexedDB double. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const seconds = (over: Parameters<typeof seededTask>[0] = {}) =>
  seededTask({
    title: "Practise piano",
    ...over,
    definition: {
      goal: {
        kind: "numeric",
        minimum: "1800",
        maximum: null,
        unit: "seconds",
      },
      carry: "retain_one",
      ...over.definition,
    },
  });
const path = (task: SeededTask) =>
  `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
const block = () =>
  document.querySelector("[data-timer-block]") as HTMLElement | null;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const copyOf = (rows: object[]) => ({
  format: 1,
  read_at: Date.now() - 60_000,
  complete: true,
  running: rows,
});
const copied = (
  task: SeededTask,
  startedAt: number,
  id = "cccccccc-0000-4000-8000-000000000001",
) => ({
  access: "available",
  id,
  occurrence_id: task.occurrenceId,
  task_id: task.taskId,
  task_title: "Practise piano",
  slot_date: task.data.slot.date,
  started_at: startedAt,
  stopped_at: null,
  version: 3,
  can_modify: true,
});

describe("visibility", () => {
  test("a goal not measured in seconds shows one muted line and no controls", async () => {
    const task = await seededTask({ title: "Brush your teeth" });
    const t = await mountTasks({ path: path(task), rows: task.rows });
    await t.until(() => block() !== null);
    expect(block()?.dataset.timerBlock).toBe("unused");
    expect(block()).toHaveTextContent(TIMER_COPY.notUsed);
  });
});

describe("start and stop (A12, A14)", () => {
  test("offline: Start is queued with a fresh session and shown running, not sent yet; Start is then withheld for THIS day; Stop is checked against the start's own record", async () => {
    const task = await seconds();
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => block()?.dataset.timerBlock === "idle");
    expect((await axe(block() as HTMLElement)).violations).toEqual([]);
    fireEvent.click(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.start,
      }),
    );
    await t.until(() => block()?.dataset.timerBlock === "running");
    expect(t.drafts().map((d) => d.kind)).toEqual(["start_timer"]);
    expect(block()).toHaveTextContent("Not sent yet");
    expect(block()?.querySelector("[data-timer-elapsed]")?.textContent).toMatch(
      /^00:00:0\d$/,
    );
    expect(
      within(block() as HTMLElement).queryByRole("button", {
        name: TIMER_COPY.start,
      }),
    ).toBeNull();
    fireEvent.click(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.stop,
      }),
    );
    await t.until(() => t.drafts().length === 2);
    const stop = t
      .bodies()
      .find((b) => b.command.command.kind === "stop_timer");
    expect(stop?.command.command).toMatchObject({
      kind: "stop_timer",
      occurrence_id: task.occurrenceId,
      expected_version: 1,
    });
    await t.until(() => block()?.dataset.timerBlock === "idle");
    expect(block()?.dataset.timerBlock).toBe("idle");
  });

  test("MU-10C-22: a timer running on ANOTHER day (known from the copy) never withholds Start here (B6); one on this day does, with its reason", async () => {
    const here = await seconds();
    const other = await seconds({ title: "Practise scales" });
    const t = await mountTasks({
      path: path(here),
      rows: [...here.rows, ...other.rows],
      env: { online: false },
      timerCopy: copyOf([copied(other, nowSeconds() - 600)]),
    });
    await t.until(() => block()?.dataset.timerBlock === "idle");
    expect(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.start,
      }),
    ).toBeEnabled();
    cleanup();
    const t2 = await mountTasks({
      path: path(here),
      rows: here.rows,
      env: { online: false },
      timerCopy: copyOf([copied(here, nowSeconds() - 600)]),
    });
    await t2.until(() => block()?.dataset.timerBlock === "running");
    expect(
      block()
        ?.querySelector("[data-timer-source]")
        ?.getAttribute("data-timer-source"),
    ).toBe("copy");
    expect(block()).toHaveTextContent(
      TIMER_COPY.lastChecked("").trim().split(" ")[0] as string,
    );
  });

  test("MU-10C-23: beyond 7 days a stop asks first; 'Record the first 7 days' sends started_at + 604,800 with the copy's version", async () => {
    const task = await seconds();
    const started = nowSeconds() - 8 * 86_400;
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      env: { online: false },
      timerCopy: copyOf([copied(task, started)]),
    });
    await t.until(() => block()?.dataset.timerBlock === "running");
    fireEvent.click(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.stop,
      }),
    );
    expect(block()?.querySelector("[data-timer-seven-days]")).toHaveTextContent(
      TIMER_COPY.sevenDays,
    );
    expect(t.drafts()).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: TIMER_COPY.recordSeven }),
    );
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      kind: "stop_timer",
      stopped_at: started + SEVEN_DAYS,
      expected_version: 3,
    });
  });

  test("a closed day (close_incomplete) records only up to its close", async () => {
    const closes = nowSeconds() - 3600;
    const task = await seconds({
      definition: { carry: "close_incomplete" },
      occurrence: { opens_at: closes - 86_400, closes_at: closes },
    });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      env: { online: false },
      timerCopy: copyOf([copied(task, closes - 7200)]),
    });
    await t.until(() => block()?.dataset.timerBlock === "running");
    expect(block()).toHaveTextContent("This day closed at");
    fireEvent.click(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.stop,
      }),
    );
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      stopped_at: closes - 1,
    });
  });
});

describe("the conflict block (A13) and the day's sessions", () => {
  test("MU-10C-20: a timer action in conflict never names a cause; review lists the day's sessions online; Discard discards it", async () => {
    const task = await seconds();
    const local = "70000000-0000-4000-8000-000000000777";
    const sessions: TasksResult<TimerPage> = {
      ok: true,
      value: {
        items: [
          {
            id: "cccccccc-0000-4000-8000-000000000002",
            occurrence_id: task.occurrenceId,
            started_at: nowSeconds() - 7200,
            stopped_at: nowSeconds() - 3600,
            version: 2,
          },
        ],
        next_after: null,
      },
    };
    const api = fakeApi({ readTimers: async () => sessions });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      api,
      drafts: [
        draftRow({
          local_id: local,
          created_seq: 1,
          kind: "stop_timer",
          endpoint: "/task-commands",
          account_id: ME,
          status: "version_conflict",
          target_resource_ids: [
            "cccccccc-0000-4000-8000-000000000009",
            task.occurrenceId,
          ],
          index_targets: [
            "cccccccc-0000-4000-8000-000000000009",
            task.occurrenceId,
          ],
          command: {
            command: {
              kind: "stop_timer",
              occurrence_id: task.occurrenceId,
              session_id: "cccccccc-0000-4000-8000-000000000009",
              expected_version: 1,
              stopped_at: nowSeconds(),
            },
          } as never,
        }),
      ],
    });
    await t.until(
      () => document.querySelector("[data-timer-conflict]") !== null,
    );
    const conflict = document.querySelector(
      "[data-timer-conflict]",
    ) as HTMLElement;
    expect(conflict).toHaveTextContent(TIMER_COPY.conflictTitle);
    expect(conflict.textContent ?? "").not.toMatch(
      /overlap|already running|another timer/i,
    );
    fireEvent.click(
      within(conflict).getByRole("button", { name: TIMER_COPY.review }),
    );
    await t.until(() => document.querySelector("[data-day-session]") !== null);
    expect(document.querySelectorAll("[data-day-session]")).toHaveLength(1);
    fireEvent.click(
      within(conflict).getByRole("button", { name: TIMER_COPY.discard }),
    );
    await t.until(
      () => document.querySelector("[data-timer-conflict]") === null,
    );
    expect(t.drafts().find((d) => d.local_id === local)).toBeUndefined();
  });

  test("offline the day's sessions are shown when online", async () => {
    const task = await seconds();
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => block() !== null);
    fireEvent.click(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.sessions,
      }),
    );
    expect(document.querySelector("[data-timer-sessions]")).toHaveTextContent(
      TIMER_COPY.sessionsOffline,
    );
  });
});

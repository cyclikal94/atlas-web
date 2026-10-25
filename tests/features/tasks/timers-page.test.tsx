import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { SyncStateRow } from "../../../src/data/model/types";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { AccountTimerPage } from "../../../src/features/tasks/model/contract";
import { TIMERS_COPY } from "../../../src/features/tasks/timers/TimersPage";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * The account's timers under B6 (A15; D-10c-4/12): running first, then earlier sessions; an available row links to its day and offers
 * Stop and Discard while it may be modified (queued with the row's version); a restricted row shows times only; the first running page
 * is kept on this device (W28) and shown offline, each copied row titled only while its day is still in the cache. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});
const NAME = accountDatabaseName(ME);
const now = () => Math.floor(Date.now() / 1000);
const available = (task: SeededTask, over: Record<string, unknown> = {}) => ({
  access: "available" as const,
  id: "cccccccc-0000-4000-8000-000000000011",
  occurrence_id: task.occurrenceId,
  task_id: task.taskId,
  task_title: "Practise piano",
  slot_date: task.data.slot.date,
  started_at: now() - 600,
  stopped_at: null,
  version: 4,
  can_modify: true,
  ...over,
});
const restricted = {
  access: "restricted" as const,
  id: "cccccccc-0000-4000-8000-000000000012",
  started_at: now() - 900,
  stopped_at: null,
  version: 1,
};
const page = (items: object[]): TasksResult<AccountTimerPage> => ({
  ok: true,
  value: { items: items as never, next_after: null },
});
const rowOf = (id: string) =>
  document.querySelector(`[data-account-timer="${id}"]`) as HTMLElement | null;

describe("online", () => {
  test("running and earlier sessions; an available row links to its day with Stop and Discard; a restricted row shows times only; the running page is kept on this device", async () => {
    const task = await seededTask({ title: "Practise piano" });
    const finished = available(task, {
      id: "cccccccc-0000-4000-8000-000000000013",
      stopped_at: now() - 60,
      can_modify: false,
    });
    const api = fakeApi({
      readAccountTimers: async (q) =>
        q.state === "running"
          ? page([available(task), restricted])
          : page([finished]),
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(
      () =>
        rowOf(available(task).id) !== null &&
        document.querySelector("[data-timers-history=ready]") !== null,
    );
    const live = rowOf(available(task).id) as HTMLElement;
    expect(
      within(live).getByRole("link", { name: "Practise piano" }),
    ).toHaveAttribute(
      "href",
      `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    );
    expect(
      within(live).getByRole("button", { name: "Stop" }),
    ).toBeInTheDocument();
    const hidden = rowOf(restricted.id) as HTMLElement;
    expect(hidden.dataset.access).toBe("restricted");
    expect(hidden).toHaveTextContent(TIMERS_COPY.restricted);
    expect(within(hidden).queryByRole("button")).toBeNull();
    expect(
      within(rowOf(finished.id) as HTMLElement).queryByRole("button"),
    ).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      TIMERS_COPY.title,
    );
    expect(
      (await axe(document.querySelector("[data-timers-page]") as HTMLElement))
        .violations,
    ).toEqual([]);
    await t.until(() => {
      const sync = t.world.idb.peek(
        NAME,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      return sync.timer_copy != null;
    });
    const sync = t.world.idb.peek(
      NAME,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(
      (sync.timer_copy as { running: Array<{ id: string }> }).running.map(
        (r) => r.id,
      ),
    ).toEqual([available(task).id, restricted.id]);
    fireEvent.click(within(live).getByRole("button", { name: "Stop" }));
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      kind: "stop_timer",
      occurrence_id: task.occurrenceId,
      session_id: available(task).id,
      expected_version: 4,
    });
  });

  test("nothing at all: 'No timers yet.'", async () => {
    const t = await mountTasks({ path: "/tasks/timers" });
    await t.until(() => document.querySelector("[data-timers-empty]") !== null);
    expect(document.querySelector("[data-timers-empty]")).toHaveTextContent(
      TIMERS_COPY.empty,
    );
  });

  test("MU-10C-12 (screen): an answer of another identity is neither shown nor kept", async () => {
    const task = await seededTask({ title: "Practise piano" });
    let release: (r: TasksResult<AccountTimerPage>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readAccountTimers: (q) => {
        calls += 1;
        return q.state === "running" && calls <= 2
          ? new Promise((resolve) => (release = resolve))
          : new Promise(() => undefined);
      },
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(() => calls >= 1);
    t.rerender(tasksEnv(api, { identity: `${ME}:2` }));
    await t.settle();
    release(page([available(task)]));
    await t.settle();
    expect(rowOf(available(task).id)).toBeNull();
    const sync = t.world.idb.peek(
      NAME,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(sync.timer_copy ?? null).toBeNull();
  });
});

describe("offline: the copy (D-10c-4)", () => {
  test("MU-10C-13: a copied row is titled only while its day is in this device's cache, otherwise restricted; history waits for the connection", async () => {
    const cached = await seededTask({ title: "Practise piano" });
    const gone = await seededTask({ title: "Gone" });
    const t = await mountTasks({
      path: "/tasks/timers",
      rows: cached.rows,
      env: { online: false },
      timerCopy: {
        format: 1,
        read_at: Date.now() - 120_000,
        complete: true,
        running: [
          available(cached),
          available(gone, {
            id: "cccccccc-0000-4000-8000-000000000014",
            task_title: "Secret",
          }),
        ],
      },
    });
    await t.until(() => rowOf(available(cached).id) !== null);
    await t.settle();
    expect(rowOf(available(cached).id)).toHaveTextContent("Practise piano");
    const away = rowOf("cccccccc-0000-4000-8000-000000000014") as HTMLElement;
    expect(away.dataset.access).toBe("restricted");
    expect(away).not.toHaveTextContent("Secret");
    expect(document.querySelector("[data-timers-history]")).toHaveTextContent(
      TIMERS_COPY.historyOffline,
    );
  });
});

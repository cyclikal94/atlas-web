import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { SyncStateRow } from "../../../src/data/model/types";
import type { TasksResult } from "../../../src/features/tasks/api";
import { TIMER_COPY } from "../../../src/features/tasks/detail/Timer";
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

/**
 * Revision 1 (review R3): the account's list applies the detail's stop rules at its own entry point. Beyond the server's 7-day cap a Stop
 * asks first ("Record the first 7 days" or "Discard the session") and queues nothing until the person chooses; a closed day records up to
 * its close; and a session whose stop or discard is on its way from this device shows its mark and offers no second one.
 */
describe("R3: the list's Stop asks as the detail's does", () => {
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
  const stopOf = (id: string) =>
    within(rowOf(id) as HTMLElement).queryByRole("button", { name: "Stop" });

  for (const choice of ["Record the first 7 days", "Discard the session"])
    test(`beyond 7 days, Stop queues nothing and asks; "${choice}" queues what it says`, async () => {
      const task = await seconds();
      const started = now() - 8 * 86_400;
      const timer = available(task, { started_at: started });
      const api = fakeApi({
        readAccountTimers: async (q) =>
          q.state === "running" ? page([timer]) : page([]),
      });
      const t = await mountTasks({
        path: "/tasks/timers",
        rows: task.rows,
        api,
      });
      await t.until(() => stopOf(timer.id) !== null);
      fireEvent.click(stopOf(timer.id) as HTMLElement);
      await t.until(
        () =>
          rowOf(timer.id)?.querySelector("[data-timer-seven-days]") !== null,
      );
      expect(t.drafts(), "nothing is queued before the choice").toEqual([]);
      expect(rowOf(timer.id)).toHaveTextContent(TIMER_COPY.sevenDays);
      fireEvent.click(
        within(rowOf(timer.id) as HTMLElement).getByRole("button", {
          name: choice,
        }),
      );
      await t.until(() => t.drafts().length === 1);
      expect(t.bodies()[0]?.command.command).toMatchObject(
        choice === "Record the first 7 days"
          ? {
              kind: "stop_timer",
              session_id: timer.id,
              expected_version: 4,
              stopped_at: started + 604_800,
            }
          : { kind: "cancel_timer", session_id: timer.id, expected_version: 4 },
      );
    });

  test("a closed day (close_incomplete, on this device) records up to its close, and says so", async () => {
    const closes = now() - 3600;
    const task = await seconds({
      definition: { carry: "close_incomplete" },
      occurrence: { opens_at: closes - 86_400, closes_at: closes },
    });
    const timer = available(task, { started_at: closes - 7200 });
    const api = fakeApi({
      readAccountTimers: async (q) =>
        q.state === "running" ? page([timer]) : page([]),
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(
      () =>
        stopOf(timer.id) !== null &&
        (rowOf(timer.id)?.textContent ?? "").includes("This day closed at"),
    );
    fireEvent.click(stopOf(timer.id) as HTMLElement);
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      kind: "stop_timer",
      stopped_at: closes - 1,
    });
  });

  test("a stop on its way: one is queued for two presses, and the row shows its mark with no second Stop while the read still lists it running", async () => {
    const task = await seconds();
    const timer = available(task);
    const api = fakeApi({
      readAccountTimers: async (q) =>
        q.state === "running" ? page([timer]) : page([]),
    });
    const t = await mountTasks({
      path: "/tasks/timers",
      rows: task.rows,
      api,
    });
    await t.until(() => stopOf(timer.id) !== null);
    const stop = stopOf(timer.id) as HTMLElement;
    fireEvent.click(stop);
    fireEvent.click(stop);
    await t.until(
      () => rowOf(timer.id)?.querySelector("[data-timer-pending]") !== null,
    );
    await t.settle();
    expect(t.drafts().filter((d) => d.kind === "stop_timer")).toHaveLength(1);
    expect(stopOf(timer.id)).toBeNull();
    expect(
      within(rowOf(timer.id) as HTMLElement).queryByRole("button", {
        name: "Discard",
      }),
    ).toBeNull();
  });
});

/**
 * Revision 2 (review R10): ONE read owns each section. A newer read (reconnect, Retry, a change of mine) takes over at once: an earlier
 * read's answer, success or failure, never reaches the screen or the copy, and a further page is accepted only for the read and cursor
 * that asked for it. Running and earlier sessions are owned separately.
 */
describe("R10: one read owns each section", () => {
  const full = (from: number, over: Record<string, unknown> = {}) => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      ...restricted,
      id: `cccccccc-0000-4000-8000-${String(from + i).padStart(12, "0")}`,
      ...over,
    }));
    return { items, next_after: items[49]?.id ?? null } as AccountTimerPage;
  };

  test("REVIEW2 T3 (ported): an old available page cannot replace a newer restricted row (no title, link, Stop or Discard), nor the copy", async () => {
    const task = await seededTask({ title: "Practise piano" });
    const old = available(task);
    const hidden = {
      ...restricted,
      id: old.id,
      started_at: old.started_at,
      version: old.version,
    };
    // Every running read is held (the protected tree may mount twice early, so "the first read" is not necessarily the owning one).
    const held: Array<(r: TasksResult<AccountTimerPage>) => void> = [];
    const api = fakeApi({
      readAccountTimers: async (q) =>
        q.state !== "running"
          ? page([])
          : new Promise((r) => {
              held.push(r);
            }),
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(() => held.length >= 1);
    await t.settle();
    const before = held.length;
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => held.length > before);
    held.at(-1)?.(page([hidden]));
    await t.until(() => rowOf(old.id)?.dataset.access === "restricted");
    await t.until(
      () =>
        (t.world.idb.peek(NAME, "sync_state", "singleton") as SyncStateRow)
          .timer_copy != null,
    );
    expect(
      within(rowOf(old.id) as HTMLElement).queryByRole("button"),
    ).toBeNull();
    for (const release of held.slice(0, -1)) release(page([old]));
    await t.settle();
    const row = rowOf(old.id) as HTMLElement;
    expect(row.dataset.access).toBe("restricted");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row).not.toHaveTextContent("Practise piano");
    const kept = (
      t.world.idb.peek(NAME, "sync_state", "singleton") as SyncStateRow
    ).timer_copy as { running: Array<{ access: string }> };
    expect(kept.running.map((r) => r.access)).toEqual(["restricted"]);
  });

  test("reconnect and Retry: earlier reads answering last (success or failure) never replace the newest; the other section is its own", async () => {
    const task = await seededTask({ title: "Practise piano" });
    const finished = available(task, {
      id: "cccccccc-0000-4000-8000-000000000019",
      stopped_at: now() - 60,
      can_modify: false,
    });
    const held: Array<(r: TasksResult<AccountTimerPage>) => void> = [];
    const api = fakeApi({
      readAccountTimers: async (q) =>
        q.state !== "running"
          ? page([finished])
          : new Promise((r) => {
              held.push(r);
            }),
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(() => held.length >= 1);
    await t.settle();
    const first = held.length;
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => held.length > first);
    await t.settle();
    // The newest read fails: Retry asks once more.
    held.at(-1)?.({ ok: false, kind: "uncertain" } as never);
    await t.until(
      () => document.querySelector("[data-timers-running=error]") !== null,
    );
    const before = held.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await t.until(() => held.length > before);
    held.at(-1)?.(page([{ ...restricted, id: available(task).id }]));
    await t.until(() => rowOf(available(task).id) !== null);
    // Every earlier read answers now, available or failed.
    held.slice(0, -1).forEach((release, i) => {
      release(
        i % 2 === 0
          ? page([available(task)])
          : ({ ok: false, kind: "uncertain" } as never),
      );
    });
    await t.settle();
    expect(rowOf(available(task).id)?.dataset.access).toBe("restricted");
    expect(
      document.querySelector("[data-timers-running=ready]"),
    ).not.toBeNull();
    expect(rowOf(finished.id)).not.toBeNull();
  });

  test("Load more: an old read's further page is not merged into a newer read; a second press asks once", async () => {
    let release: (r: TasksResult<AccountTimerPage>) => void = () => undefined;
    const afters: string[] = [];
    let firsts = 0;
    const api = fakeApi({
      readAccountTimers: async (q) => {
        if (q.state !== "running") return page([]);
        if (q.after === undefined) {
          firsts += 1;
          return { ok: true, value: full(firsts === 1 ? 1 : 101) };
        }
        afters.push(q.after);
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const t = await mountTasks({ path: "/tasks/timers", api });
    await t.until(
      () => firsts === 1 && rowOf(full(1).items[0]?.id as string) !== null,
    );
    const more = within(
      document.querySelector("[data-timers-running]") as HTMLElement,
    ).getByRole("button", { name: TIMERS_COPY.loadMore });
    fireEvent.click(more);
    fireEvent.click(more);
    await t.settle();
    expect(afters).toHaveLength(1);
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => firsts === 2);
    await t.settle();
    release(
      page([{ ...restricted, id: "cccccccc-0000-4000-8000-000000000051" }]),
    );
    await t.settle();
    expect(rowOf("cccccccc-0000-4000-8000-000000000051")).toBeNull();
    expect(
      document.querySelectorAll("[data-timers-running] [data-account-timer]"),
    ).toHaveLength(50);
  }, 20_000);

  test("a stop of mine leaving the outbox (another tab's included) reads the list again", async () => {
    const task = await seededTask({ title: "Practise piano" });
    let reads = 0;
    const api = fakeApi({
      readAccountTimers: async (q) => {
        if (q.state === "running") reads += 1;
        return page(q.state === "running" ? [available(task)] : []);
      },
    });
    const t = await mountTasks({ path: "/tasks/timers", rows: task.rows, api });
    await t.until(() => rowOf(available(task).id) !== null);
    const before = reads;
    fireEvent.click(
      within(rowOf(available(task).id) as HTMLElement).getByRole("button", {
        name: "Stop",
      }),
    );
    await t.until(() => t.drafts().length === 1);
    await t.settle();
    const queued = reads;
    expect(queued).toBeGreaterThan(before);
    // The draft is discarded (it leaves the outbox, as another tab's settle or discard would show here): read again.
    await t.data.outbox()?.discard(t.drafts()[0]?.local_id as string);
    await t.until(() => reads > queued);
    expect(reads).toBeGreaterThan(queued);
  });
});

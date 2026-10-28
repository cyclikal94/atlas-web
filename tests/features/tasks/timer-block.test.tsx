import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AccountService,
  commitTimerCopy,
  commitTimerCorrection,
  issueTimerOrderNow,
} from "../../../src/data";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { SyncStateRow } from "../../../src/data/model/types";
import type { TasksResult } from "../../../src/features/tasks/api";
import { TIMER_COPY } from "../../../src/features/tasks/detail/Timer";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import {
  parseTimerPage,
  type TimerPage,
  type TimerSession,
} from "../../../src/features/tasks/model/contract";
import {
  copyCorrection,
  dayObservation,
  SEVEN_DAYS,
} from "../../../src/features/tasks/model/timers";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
  tasksEnv,
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
    // The block is idle before the copy is read too: settle, so the copy's row is known when Start is judged.
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("idle");
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

describe("offline after a start was acknowledged (found by I-10C-TM3)", () => {
  test("a session the day's read showed running stays running offline, marked with when it was read; Stop is still offered", async () => {
    const task = await seconds();
    const running: TasksResult<TimerPage> = {
      ok: true,
      value: {
        items: [
          {
            id: "cccccccc-0000-4000-8000-000000000003",
            occurrence_id: task.occurrenceId,
            started_at: nowSeconds() - 120,
            stopped_at: null,
            version: 1,
          },
        ],
        next_after: null,
      },
    };
    const api = fakeApi({ readTimers: async () => running });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(() => block()?.dataset.timerBlock === "running");
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("running");
    expect(block()).toHaveTextContent("Last checked");
    expect(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.stop,
      }),
    ).toBeEnabled();
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

/**
 * Revision 1 (review R2): a current COMPLETE read of the day's sessions supersedes an older copy. The server omits a cancelled session, so
 * a copied one the read does not list is not running: the block is idle and Start is offered (never a Stop or Discard of a cancelled
 * session). The read listing it keeps it running, from the read.
 */
describe("R2: the day's complete read and the kept copy", () => {
  test("online, a complete empty read issued after the copy: the copied (cancelled) session is not running and Start is offered", async () => {
    const task = await seconds();
    let reads = 0;
    const api = fakeApi({
      readTimers: async () => {
        reads += 1;
        return { ok: true, value: { items: [], next_after: null } };
      },
    });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      api,
      timerCopy: copyOf([copied(task, nowSeconds() - 600)]),
    });
    await t.until(() => reads > 0 && block() !== null);
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("idle");
    expect(
      within(block() as HTMLElement).getByRole("button", {
        name: TIMER_COPY.start,
      }),
    ).toBeEnabled();
    expect(
      within(block() as HTMLElement).queryByRole("button", {
        name: TIMER_COPY.stop,
      }),
    ).toBeNull();
  });

  test("control: the same copy, and a complete read that lists the session running: running, from the read", async () => {
    const task = await seconds();
    const started = nowSeconds() - 600;
    const api = fakeApi({
      readTimers: async () => ({
        ok: true,
        value: {
          items: [
            {
              id: "cccccccc-0000-4000-8000-000000000001",
              occurrence_id: task.occurrenceId,
              started_at: started,
              stopped_at: null,
              version: 3,
            },
          ],
          next_after: null,
        },
      }),
    });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      api,
      timerCopy: copyOf([copied(task, started)]),
    });
    await t.until(() => block()?.dataset.timerBlock === "running");
    expect(
      block()
        ?.querySelector("[data-timer-source]")
        ?.getAttribute("data-timer-source"),
    ).toBe("read");
  });

  /**
   * Revision 2 (design assessment DA-H1): this case supplied `{ items: [], next_after: "more" }`, a page the released endpoint never
   * answers (a further page is named only after a FULL page, by its last id; `parseTimerPage` refuses it). Its intent, "a read that is not
   * complete decides nothing by absence: the copy stands", is kept over a contract-valid full first page that omits the copied session;
   * a later page that fails changes nothing; the empty last page then completes the read, which retires it.
   */
  test("a read that is not complete (a further page) decides nothing by absence: the copy stands, also when the next page fails; completed, it retires it", async () => {
    const task = await seconds();
    const first = fullPage(task, 100);
    let more = 0;
    const api = fakeApi({
      readTimers: async (_id, after) => {
        if (after === undefined) return { ok: true, value: first };
        more += 1;
        expect(after).toBe(first.next_after);
        const last = { items: [], next_after: null };
        expect(parseTimerPage(last, task.occurrenceId, after, 50)).toEqual(
          last,
        );
        return more === 1
          ? { ok: false, kind: "uncertain" }
          : { ok: true, value: last };
      },
    });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      api,
      timerCopy: copyOf([copied(task, nowSeconds() - 600)]),
    });
    await t.until(() => block()?.dataset.timerBlock === "running");
    await t.settle();
    expect(sourceOf(COPIED_ID)).toBe("copy");
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.sessions }));
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.loadMore }));
    await t.until(() => more === 1);
    await t.settle();
    expect(sourceOf(COPIED_ID)).toBe("copy");
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.loadMore }));
    await t.until(() => block()?.dataset.timerBlock === "idle");
    expect(more).toBe(2);
    expect(sourceOf(COPIED_ID)).toBeNull();
  });
});

const COPIED_ID = "cccccccc-0000-4000-8000-000000000001";
const sid = (n: number) =>
  `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionOf = (
  task: SeededTask,
  n: number,
  over: Partial<TimerSession> = {},
): TimerSession => ({
  id: sid(n),
  occurrence_id: task.occurrenceId,
  started_at: nowSeconds() - 600,
  stopped_at: null,
  version: 3,
  ...over,
});
/**
 * A FULL first page as the released endpoint answers one with more to come: 50 sessions in id order, the last id as its cursor (checked
 * with the production parser). `from` numbers the first; `over` replaces rows by number.
 */
function fullPage(
  task: SeededTask,
  from: number,
  over: Record<number, Partial<TimerSession>> = {},
): TimerPage {
  const items = Array.from({ length: 50 }, (_, i) =>
    sessionOf(task, from + i, {
      stopped_at: nowSeconds() - 300,
      ...over[from + i],
    }),
  );
  const page = { items, next_after: items[49]?.id ?? null };
  expect(parseTimerPage(page, task.occurrenceId, null, 50)).toEqual(page);
  return page;
}
const sourceOf = (id: string) =>
  block()
    ?.querySelector(`[data-timer-session="${id}"]`)
    ?.getAttribute("data-timer-source") ?? null;
const syncOf = (t: { world: { idb: { peek: (...a: never[]) => unknown } } }) =>
  (t.world.idb.peek as (n: string, s: string, k: string) => unknown)(
    accountDatabaseName(ME),
    "sync_state",
    "singleton",
  ) as SyncStateRow;

describe("R11: what a partial page lists is known", () => {
  test.each([false, true])(
    "REVIEW2 T1 (ported): a running session on a contract-valid page (partial %s) is running; Start withheld, Stop and Discard offered",
    async (partial) => {
      const task = await seconds();
      const page: TimerPage = partial
        ? fullPage(task, 1, { 1: { stopped_at: null } })
        : { items: [sessionOf(task, 1)], next_after: null };
      expect(parseTimerPage(page, task.occurrenceId, null, 50)).toEqual(page);
      const api = fakeApi({
        readTimers: async () => ({ ok: true, value: page }),
      });
      const t = await mountTasks({ path: path(task), rows: task.rows, api });
      await t.until(() => block()?.dataset.timerBlock === "running");
      expect(sourceOf(sid(1))).toBe("read");
      const here = within(block() as HTMLElement);
      expect(here.queryByRole("button", { name: TIMER_COPY.start })).toBeNull();
      expect(here.getByRole("button", { name: TIMER_COPY.stop })).toBeEnabled();
      expect(
        here.getByRole("button", { name: TIMER_COPY.discard }),
      ).toBeEnabled();
    },
  );

  test("a partial page listing the copied session STOPPED ends it at once; a copied session it does not list stays", async () => {
    const task = await seconds();
    const other = sid(900);
    const api = fakeApi({
      readTimers: async () => ({
        ok: true,
        value: fullPage(task, 1, { 1: { stopped_at: nowSeconds() - 30 } }),
      }),
    });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      api,
      timerCopy: copyOf([
        copied(task, nowSeconds() - 600, sid(1)),
        copied(task, nowSeconds() - 500, other),
      ]),
    });
    await t.until(() => api.calls.readTimers !== undefined);
    await t.settle();
    expect(sourceOf(sid(1))).toBeNull();
    expect(sourceOf(other)).toBe("copy");
  });
});

describe("R10: one read owns what the timer block shows", () => {
  test("REVIEW2 T2 (ported): an older read answering after a newer one (reconnect) cannot resurrect a cancelled session, on screen or offline", async () => {
    const task = await seconds();
    let release: (v: TasksResult<TimerPage>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readTimers: async () => {
        calls += 1;
        return calls === 1
          ? new Promise<TasksResult<TimerPage>>((r) => {
              release = r;
            })
          : { ok: true, value: { items: [], next_after: null } };
      },
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(() => calls === 1);
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => calls === 2);
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("idle");
    release({
      ok: true,
      value: { items: [sessionOf(task, 1)], next_after: null },
    });
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("idle");
    // The page memory kept the newer read: offline it is still idle.
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("idle");
  }, 20_000);

  test("an older read's FAILURE after a newer success changes nothing; control: the same read alone publishes normally", async () => {
    const task = await seconds();
    let release: (v: TasksResult<TimerPage>) => void = () => undefined;
    let calls = 0;
    const running = { items: [sessionOf(task, 1)], next_after: null };
    const api = fakeApi({
      readTimers: async () => {
        calls += 1;
        return calls === 1
          ? new Promise<TasksResult<TimerPage>>((r) => {
              release = r;
            })
          : { ok: true, value: running };
      },
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(() => calls === 1);
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => block()?.dataset.timerBlock === "running");
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.sessions }));
    release({ ok: false, kind: "uncertain" } as never);
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe("running");
    expect(
      document
        .querySelector("[data-timer-sessions]")
        ?.getAttribute("data-timer-sessions"),
    ).toBe("ready");
    cleanup();
    forgetTaskMemory();
    const alone = await seconds();
    const control = fakeApi({
      readTimers: async () => ({
        ok: true,
        value: { items: [sessionOf(alone, 1)], next_after: null },
      }),
    });
    const c = await mountTasks({
      path: path(alone),
      rows: alone.rows,
      api: control,
    });
    await c.until(() => block()?.dataset.timerBlock === "running");
  });

  test("Load more: an old chain's page is never merged into a newer read; a second press asks for one page", async () => {
    const task = await seconds();
    let release: (v: TasksResult<TimerPage>) => void = () => undefined;
    const pages: string[] = [];
    let firsts = 0;
    const api = fakeApi({
      readTimers: async (_id, after) => {
        if (after === undefined) {
          firsts += 1;
          return { ok: true, value: fullPage(task, firsts === 1 ? 1 : 101) };
        }
        pages.push(after);
        return new Promise<TasksResult<TimerPage>>((r) => {
          release = r;
        });
      },
    });
    const t = await mountTasks({ path: path(task), rows: task.rows, api });
    await t.until(() => firsts === 1);
    await t.settle();
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.sessions }));
    const more = screen.getByRole("button", { name: TIMER_COPY.loadMore });
    fireEvent.click(more);
    fireEvent.click(more);
    await t.settle();
    expect(pages).toEqual([sid(50)]);
    // A newer read (reconnect) takes over; then the old chain's page arrives.
    t.rerender(tasksEnv(api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => firsts === 2);
    await t.settle();
    release({
      ok: true,
      value: { items: [sessionOf(task, 51)], next_after: null },
    });
    await t.settle();
    const listed = [...document.querySelectorAll("[data-day-session]")].map(
      (e) => e.getAttribute("data-day-session"),
    );
    expect(listed).toHaveLength(50);
    expect(listed).not.toContain(sid(51));
    expect(listed[0]).toBe(sid(101));
    // Control: the current chain's next page is accepted.
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.loadMore }));
    await t.settle();
    expect(pages).toEqual([sid(50), sid(150)]);
    release({
      ok: true,
      value: { items: [sessionOf(task, 151)], next_after: null },
    });
    await t.settle();
    expect(document.querySelectorAll("[data-day-session]")).toHaveLength(51);
  }, 20_000);
});

describe("DA-T1: a complete day read corrects the kept copy itself", () => {
  test("the cancelled session leaves the copy (so no reload, tab or offline list brings it back); another day's copied session stays", async () => {
    const task = await seconds();
    const elsewhere = "aaaaaaaa-0000-4000-8000-0000000000ff";
    const api = fakeApi({
      readTimers: async () => ({
        ok: true,
        value: { items: [], next_after: null },
      }),
    });
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      api,
      timerCopy: copyOf([
        copied(task, nowSeconds() - 600),
        {
          ...copied(task, nowSeconds() - 600, sid(700)),
          occurrence_id: elsewhere,
        },
      ]),
    });
    await t.until(() => block()?.dataset.timerBlock === "idle");
    await t.until(
      () =>
        (syncOf(t).timer_copy as { running: unknown[] } | undefined)?.running
          .length === 1,
    );
    const sync = syncOf(t);
    expect(
      (sync.timer_copy as { running: Array<{ id: string }> }).running.map(
        (r) => r.id,
      ),
    ).toEqual([sid(700)]);
    expect(sync.timer_fence).toBeGreaterThan(0);
    // Offline, the account's list (which shows the copy) no longer has it.
    t.rerender(tasksEnv(api, { online: false }));
    await t.router.navigate({ to: "/tasks/timers" });
    await t.until(
      () =>
        document.querySelector(`[data-account-timer="${sid(700)}"]`) !== null,
    );
    expect(
      document.querySelector(`[data-account-timer="${COPIED_ID}"]`),
    ).toBeNull();
    expect(
      document.querySelector(`[data-account-timer="${sid(700)}"]`),
    ).not.toBeNull();
  });
});

/**
 * Revision 3 (review R14, family `timer-copy-authoritative-absence`): REVIEW3 T4, ported. The detail's read saw a session running; a LATER
 * complete read of the account's running timers (Your timers) no longer lists it; offline, back on the detail, the earlier read kept in
 * page memory must not bring it back. The control's later account read still lists it: it stays running.
 */
describe("R14: a later complete account read retires what an earlier day read saw", () => {
  test.each([false, true])(
    "REVIEW3 T4 (ported): the later account read still lists the session = %s",
    async (stillRunning) => {
      const task = await seconds();
      const session = {
        id: sid(9801),
        occurrence_id: task.occurrenceId,
        started_at: nowSeconds() - 600,
        stopped_at: null,
        version: 3,
      };
      const page = { items: [session], next_after: null };
      expect(parseTimerPage(page, task.occurrenceId, null, 50)).not.toBeNull();
      const accountRow = copied(task, session.started_at, session.id);
      const api = fakeApi({
        readTimers: async () => ({ ok: true, value: page }),
        readAccountTimers: async (q) => ({
          ok: true,
          value: {
            items:
              q.state === "running" && stillRunning
                ? [accountRow as never]
                : [],
            next_after: null,
          },
        }),
      });
      const t = await mountTasks({ path: path(task), rows: task.rows, api });
      await t.until(() => block()?.dataset.timerBlock === "running");
      const dayOrder = syncOf(t).timer_order as number;
      await t.router.navigate({ to: "/tasks/timers" });
      await t.until(
        () => document.querySelector("[data-timers-running=ready]") !== null,
      );
      await t.until(
        () =>
          ((syncOf(t).timer_copy as { order?: number } | undefined)?.order ??
            0) > dayOrder,
      );
      const copy = syncOf(t).timer_copy as {
        complete: boolean;
        running: unknown[];
      };
      expect(copy.complete).toBe(true);
      expect(copy.running).toHaveLength(stillRunning ? 1 : 0);
      t.rerender(tasksEnv(api, { online: false }));
      await t.settle();
      await t.router.navigate({
        to: "/tasks/$taskId",
        params: { taskId: task.taskId },
        search: { occurrence: task.occurrenceId },
      });
      await t.until(() => block() !== null);
      await t.settle();
      expect(block()?.dataset.timerBlock).toBe(
        stillRunning ? "running" : "idle",
      );
      expect(
        within(block() as HTMLElement).queryByRole("button", {
          name: TIMER_COPY.stop,
        }) !== null,
      ).toBe(stillRunning);
    },
    20_000,
  );
});

/**
 * Revision 3 (design assessment DA-T3): a day's read in ANOTHER tab corrects the kept copy (W28) after this tab's read saw the session
 * running. The correction's scope and order must reach this tab's kept read too: offline (and after a remount of the protected tree) the
 * session is not brought back, with or without a copy. A correction of ANOTHER day decides nothing about this one (the control).
 * "Another tab" is this database's own production commit of a day read's correction, made with that read's own place in the order.
 */
async function correctAsAnotherTab(
  t: Awaited<ReturnType<typeof mountTasks>>,
  occurrenceId: string,
  sessions: TimerSession[],
  complete: boolean,
) {
  const service = t.data.service() as AccountService;
  const captured = service.capture(1);
  const order = await issueTimerOrderNow(service, captured);
  expect(order).not.toBeNull();
  // As a day's read in that tab commits it (`useDaySessions`): the copy's correction and the day's observation.
  const out = await commitTimerCorrection(t.data, service, captured, {
    order: order as number,
    drop: copyCorrection(occurrenceId, sessions, complete),
    scope: dayObservation(occurrenceId, sessions, complete),
  });
  expect(out.kind).toBe("applied");
  await t.settle();
}

describe("DA-T3: a day read in another tab retires what this tab's kept read saw", () => {
  test.each([
    ["with a copy", "the same day", "idle", true],
    ["without a copy", "the same day", "idle", false],
    ["with a copy", "another day (control)", "running", true],
    ["without a copy", "another day (control)", "running", false],
  ] as const)(
    "%s, a complete empty read of %s: %s offline, also after a remount",
    async (_label, which, expected, withCopy) => {
      const task = await seconds();
      const session = sessionOf(task, 9802);
      const api = fakeApi({
        readTimers: async () => ({
          ok: true,
          value: { items: [session], next_after: null },
        }),
      });
      const t = await mountTasks({
        path: path(task),
        rows: task.rows,
        api,
        ...(withCopy
          ? {
              timerCopy: copyOf([copied(task, session.started_at, session.id)]),
            }
          : {}),
      });
      await t.until(() => block()?.dataset.timerBlock === "running");
      await t.until(() => ((syncOf(t).timer_fence as number) ?? 0) > 0);
      await correctAsAnotherTab(
        t,
        which === "the same day"
          ? task.occurrenceId
          : "aaaaaaaa-0000-4000-8000-0000000000fe",
        [],
        true,
      );
      t.rerender(tasksEnv(api, { online: false }));
      await t.settle();
      expect(block()?.dataset.timerBlock).toBe(expected);
      t.remount();
      await t.until(() => block() !== null);
      await t.settle();
      expect(block()?.dataset.timerBlock).toBe(expected);
    },
    20_000,
  );
});

describe("R14: absence is evidence only from what was read whole", () => {
  test.each([
    ["a row of it does not read", "running", [{ id: "damaged" }]],
    ["every row reads, none is this session", "idle", []],
  ] as const)(
    "a later complete account copy where %s: %s offline",
    async (_label, expected, rows) => {
      const task = await seconds();
      const session = sessionOf(task, 9803);
      const api = fakeApi({
        readTimers: async () => ({
          ok: true,
          value: { items: [session], next_after: null },
        }),
      });
      const t = await mountTasks({ path: path(task), rows: task.rows, api });
      await t.until(() => block()?.dataset.timerBlock === "running");
      await t.until(() => ((syncOf(t).timer_fence as number) ?? 0) > 0);
      // A later account read's copy, as Your timers commits it (another tab), complete.
      const service = t.data.service() as AccountService;
      const captured = service.capture(1);
      const order = (await issueTimerOrderNow(service, captured)) as number;
      expect(
        await commitTimerCopy(t.data, service, captured, {
          format: 2,
          order,
          read_at: Date.now(),
          complete: true,
          running: rows as never,
        }),
      ).toEqual({ kind: "applied", value: { written: true } });
      await t.settle();
      t.rerender(tasksEnv(api, { online: false }));
      await t.settle();
      expect(block()?.dataset.timerBlock).toBe(expected);
    },
    20_000,
  );
});

/**
 * Revision 4 (review R19, family `timer-copy-authoritative-absence`): the floor is loss information about EVERY source, the copy included.
 * REVIEW4 T6 is ported verbatim (a later read of another day lands first, then this day's empty complete read with its scope refused by
 * the real quota port: the floor rises to that read's order, which is after the copy's). The remount checks that nothing revives it from
 * the copy afterwards.
 */
describe("R19: a refused scope retires the copy's session too", () => {
  test.each([false, true])(
    "REVIEW4 T6 (ported): scope reservation refused = %s; and after a remount",
    async (refused) => {
      const task = await seconds();
      const session = copied(task, nowSeconds() - 600);
      const t = await mountTasks({
        path: path(task),
        rows: task.rows,
        env: { online: false },
        timerCopy: {
          format: 2,
          order: 1,
          read_at: Date.now(),
          complete: true,
          running: [session],
        },
      });
      await t.until(() => block()?.dataset.timerBlock === "running");
      const service = t.data.service() as AccountService;
      const captured = service.capture(1);
      const earlier = await issueTimerOrderNow(service, captured);
      const later = await issueTimerOrderNow(service, captured);
      await commitTimerCorrection(t.data, service, captured, {
        order: later as number,
        drop: copyCorrection("dddddddd-0000-4000-8000-000000000001", [], true),
        scope: dayObservation("dddddddd-0000-4000-8000-000000000001", [], true),
      });
      const env = refused
        ? {
            quota: {
              reserve: async () => ({
                verdict: "refuse",
                settle: () => undefined,
              }),
            },
          }
        : t.data;
      await commitTimerCorrection(env as never, service, captured, {
        order: earlier as number,
        drop: copyCorrection(task.occurrenceId, [], true),
        scope: dayObservation(task.occurrenceId, [], true),
      });
      await t.settle();
      const sync = t.world.idb.peek(
        accountDatabaseName(ME),
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      if (refused) expect(sync.timer_scope_floor).toBe(earlier);
      else
        expect(
          (sync.timer_scopes as Record<string, { order: number }>)[
            task.occurrenceId
          ]?.order,
        ).toBe(earlier);
      expect(block()?.dataset.timerBlock).toBe("idle");
      t.remount();
      await t.until(() => block() !== null);
      await t.settle();
      expect(block()?.dataset.timerBlock).toBe("idle");
    },
  );

  test.each([
    ["below the floor: not trusted", 1, "idle"],
    ["at the floor (control)", 3, "running"],
  ])("a copy %s, whatever its rows say", async (_, order, expected) => {
    const task = await seconds();
    const session = copied(task, nowSeconds() - 600);
    const t = await mountTasks({
      path: path(task),
      rows: task.rows,
      env: { online: false },
      timerCopy: {
        format: 2,
        order,
        read_at: Date.now(),
        complete: true,
        running: [session],
      },
      sync: { timer_order: 3, timer_fence: 3, timer_scope_floor: 3 },
    });
    await t.until(() => block() !== null);
    await t.settle();
    expect(block()?.dataset.timerBlock).toBe(expected);
  });
});

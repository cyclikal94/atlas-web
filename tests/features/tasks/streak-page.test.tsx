import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { commitMaterialiseDiscovery } from "../../../src/data";
import type { AccountService } from "../../../src/data/engine/account-service";
import type { TasksResult } from "../../../src/features/tasks/api";
import {
  forgetCatchUp,
  runnerForAccount,
} from "../../../src/features/tasks/catchup/useCatchUp";
import * as copy from "../../../src/features/tasks/copy";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrenceData,
  TaskDefinition,
  TaskDetail,
  TaskStreak,
} from "../../../src/features/tasks/model/contract";
import {
  completionEntryId,
  occurrenceId,
  progressId,
} from "../../../src/features/tasks/model/ids";
import {
  addDays,
  slotOn,
  windows,
} from "../../../src/features/tasks/model/time";
import {
  EXPIRY_RETRIES_MS,
  expiryRetryDelay,
  STREAK_COPY,
} from "../../../src/features/tasks/streak/StreakPage";
import { installMatchMedia } from "../../helpers/match-media";
import { cacheRow, draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  type Mounted,
  mountTasks,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * WF-TASK-06 (A5, A6, A18): the server's figures (both scopes for a shared task; null as Withheld or Unknown, never 0), the catch-up
 * on `409 materialisation_required` with ONE read again (a second 409 is a stop, never another catch-up), the strip of my last 30
 * opened periods from this device, offline, error and identity states. The app's router over the PRODUCTION data controller on the
 * IndexedDB double, with a scripted client. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetCatchUp();
});

type Outcome = "complete" | "missed" | "excluded" | "incomplete" | null;

/** A daily task with one occurrence per past day and my stream on each (null: no stream). */
async function repeating(
  outcomes: Outcome[],
  over: Partial<TaskDefinition> = {},
) {
  const first = addDays(TODAY, -(outcomes.length - 1));
  const base = await seededTask({
    title: "Stretch",
    date: first,
    stream: false,
    definition: {
      schedule: {
        start_date: first,
        time: null,
        timezone: "UTC",
        repeat: { frequency: "daily", interval: 1 },
      },
      allow_streak_exclusions: true,
      ...over,
    },
  });
  const rows: CacheRow[] = base.rows.filter((r) => r.kind !== "occurrence");
  const definition = base.data.definition;
  for (const [i, outcome] of outcomes.entries()) {
    const date = addDays(first, i);
    const slot = slotOn(definition.schedule, date);
    const id = await occurrenceId(base.taskId, slot.key);
    const w = windows(slot, definition);
    const data: OccurrenceData = {
      ...base.data,
      slot,
      opens_at: w.opens_at,
      closes_at: w.closes_at,
    };
    rows.push(
      cacheRow({
        id,
        kind: "occurrence",
        parent_id: base.executionId,
        label: "Occurrence",
        value: data as never,
      }),
    );
    if (outcome !== null) {
      const summary = {
        outcome: outcome === "excluded" ? "incomplete" : outcome,
        amount: null,
        checked: [],
      };
      rows.push(
        cacheRow({
          id: await progressId(id, ME),
          kind: "progress",
          parent_id: id,
          label: "Progress",
          value: {
            subject_account_id: ME,
            recent_entries: [],
            entry_count: 0,
            excluded: outcome === "excluded",
            action: summary,
            period: summary,
            aggregate_consent: true,
          } as never,
        }),
      );
    }
  }
  return { ...base, rows };
}

const streak = (
  current: number | null,
  longest: number | null,
): TasksResult<TaskStreak> => ({
  ok: true,
  value: { current, longest },
});
const MATERIALISE: TasksResult<TaskStreak> = {
  ok: false,
  kind: "conflict",
  code: "materialisation_required",
  requestId: "req-409",
};
const page = () =>
  document.querySelector("[data-streak-page]") as HTMLElement | null;
const scope = (s: "joint" | "personal") =>
  document.querySelector(`[data-streak-scope="${s}"]`) as HTMLElement | null;

describe("A6: the figures", () => {
  test("a personal task reads ONE scope and shows its run in the task's unit; the strip shows my last opened days with words", async () => {
    const task = await repeating([
      "complete",
      "missed",
      "excluded",
      null,
      "incomplete",
    ]);
    const asked: string[] = [];
    const api = fakeApi({
      readStreak: async (_id, s) => {
        asked.push(s);
        return streak(3, 5);
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(
      () =>
        scope("personal")?.dataset.streakState === "ready" &&
        document.querySelector("[data-streak-strip]") !== null,
    );
    expect(asked).toEqual(["personal"]);
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.current(3, "days"));
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.longest(5, "days"));
    const states = [
      ...document.querySelectorAll<HTMLElement>("[data-strip-state]"),
    ].map((n) => n.dataset.stripState);
    // Oldest first; the last day (today) is still open; a day with no stream of mine is "No record".
    expect(states).toEqual(["done", "missed", "skipped", "none", "open"]);
    expect(
      document.querySelector("[data-strip-state='missed']"),
    ).toHaveTextContent(STREAK_COPY.state.missed);
    expect(document.querySelector("[data-streak-tally]")).toHaveTextContent(
      STREAK_COPY.lastN("days", 1, 2, 1),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      STREAK_COPY.title,
    );
    expect((await axe(page() as HTMLElement)).violations).toEqual([]);
  });

  test("MU-10C-29 (screen): a shared task reads both scopes; a withheld joint figure says so, mine shows its numbers, never 0", async () => {
    const task = await repeating(["complete", "complete"], {
      participation: "everyone",
    });
    const api = fakeApi({
      readStreak: async (_id, s) =>
        s === "joint" ? streak(null, null) : streak(2, 2),
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => scope("joint")?.dataset.streakState === "ready");
    expect(scope("joint")).toHaveTextContent(STREAK_COPY.shared);
    expect(
      scope("joint")?.querySelectorAll("[data-streak-figure]").length,
    ).toBe(2);
    for (const node of scope("joint")?.querySelectorAll("dd") ?? [])
      expect(node).toHaveTextContent(STREAK_COPY.withheld);
    expect(scope("joint")).not.toHaveTextContent(/\b0\b/);
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.current(2, "days"));
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.you);
  });

  test("a personal unknown is Unknown; an uncertain read is an error with its request ID and Try again", async () => {
    const task = await repeating(["complete"]);
    // Uncertain until the person asks again (the harness may mount the page more than once before it settles).
    let retried = false;
    const api = fakeApi({
      readStreak: async () =>
        retried
          ? streak(null, 4)
          : { ok: false, kind: "uncertain", requestId: "req-5xx" },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => scope("personal")?.dataset.streakState === "error");
    expect(scope("personal")).toHaveTextContent(copy.REQUEST_ID("req-5xx"));
    retried = true;
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await t.until(() => scope("personal")?.dataset.streakState === "ready");
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.unknown);
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.longest(4, "days"));
  });
});

describe("A5: materialisation_required", () => {
  const detail = (
    task: Awaited<ReturnType<typeof repeating>>,
    last: string,
    pending: boolean,
  ): TasksResult<TaskDetail> => ({
    ok: true,
    value: {
      task: task.rows[0] as never,
      execution: task.rows[1] as never,
      materialisation: { last_date: last, pending },
    },
  });

  test("a 409 catches the task up (trigger streak), then reads ONCE more and shows the figures", async () => {
    const task = await repeating(["complete"]);
    // The server's state: pending until one call has been made and its position read.
    let sent = 0;
    let caughtUp = false;
    let afterwards = 0;
    const api = fakeApi({
      readStreak: async () => {
        if (!caughtUp) return MATERIALISE;
        afterwards += 1;
        return streak(1, 1);
      },
      readTask: async () => {
        if (sent === 0) return detail(task, addDays(TODAY, -3), true);
        caughtUp = true;
        return detail(task, TODAY, false);
      },
      materialise: async () => {
        sent += 1;
        return { ok: true, value: { revision: 3 } };
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => scope("personal")?.dataset.streakState === "ready");
    await t.settle();
    expect(sent).toBe(1);
    // Read once more after the catch-up, not on every change.
    expect(afterwards).toBe(1);
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.current(1, "day"));
  });

  test("MU-10C-31: a second 409 in the same visit is a stop (no progress) and never another catch-up", async () => {
    const task = await repeating(["complete"]);
    let sent = 0;
    let caughtUp = false;
    let afterwards = 0;
    const api = fakeApi({
      readStreak: async () => {
        if (caughtUp) afterwards += 1;
        return MATERIALISE;
      },
      readTask: async () => {
        if (sent === 0) return detail(task, addDays(TODAY, -3), true);
        caughtUp = true;
        return detail(task, TODAY, false);
      },
      materialise: async () => {
        sent += 1;
        return { ok: true, value: { revision: 3 } };
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => scope("personal")?.dataset.streakState === "stopped");
    await t.settle();
    expect(
      scope("personal")
        ?.querySelector("[data-streak-stopped]")
        ?.getAttribute("data-streak-stopped"),
    ).toBe("no_progress");
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.stopped);
    expect(sent).toBe(1);
    expect(afterwards).toBe(1);
  });
});

describe("R13: a stopped discovery is not a finished catch-up", () => {
  test("the streak shows the recorded stop; it neither reads the task nor reads the streak again (no catch-up, no rearm)", async () => {
    const task = await repeating(["complete"]);
    let streaks = 0;
    let tasks = 0;
    const api = fakeApi({
      readStreak: async () => {
        streaks += 1;
        return MATERIALISE;
      },
      readTask: async () => {
        tasks += 1;
        return { ok: false, kind: "uncertain" };
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
      discovery: {
        [task.taskId]: {
          retry: 0,
          failures: 3,
          stop: { reason: "unreachable" },
        },
      },
    });
    await t.until(() => scope("personal")?.dataset.streakState === "stopped");
    await t.settle();
    expect(
      scope("personal")
        ?.querySelector("[data-streak-stopped]")
        ?.getAttribute("data-streak-stopped"),
    ).toBe("unreachable");
    // (The protected tree may mount twice early, each mount reading once: counted from the stop on.)
    const shown = streaks;
    await t.settle();
    await t.settle();
    // No "finished" reread follows the stop.
    expect(streaks).toBe(shown);
    t.rerender(tasksEnv(t.api, { online: false }));
    await t.settle();
    t.rerender(tasksEnv(t.api, { online: true }));
    await t.settle();
    await t.settle();
    expect(tasks).toBe(0);
    expect(scope("personal")?.dataset.streakState).toBe("stopped");
    // Online again the streak is read once (its own reconnect), and the stop stands: no catch-up, no further read.
    expect(streaks).toBeLessThanOrEqual(shown + 1);
  });

  /**
   * Revision 5: once this page's runner has read the task (its day is known), a discovery stop another page records afterwards still
   * holds the streak: it is shown and never read past (the day being known is not a finished catch-up).
   */
  test("a stop another page records AFTER this page knew the task's day: shown, and the streak is not read past it", async () => {
    const task = await repeating(["complete"]);
    let streaks = 0;
    let conflict = false;
    const api = fakeApi({
      readStreak: async () => {
        streaks += 1;
        return conflict ? MATERIALISE : streak(1, 1);
      },
      readTask: async () => ({
        ok: true,
        value: {
          task: task.rows[0] as never,
          execution: task.rows[1] as never,
          materialisation: { last_date: TODAY, pending: false },
        },
      }),
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => scope("personal")?.dataset.streakState === "ready");
    const runner = runnerForAccount(ME) as NonNullable<
      ReturnType<typeof runnerForAccount>
    >;
    runner.ensure(task.taskId, "daily");
    await t.until(() => runner.get().zones.has(task.taskId));
    await t.until(() => runner.get().active.length === 0);
    expect(runner.get().zones.get(task.taskId)).toBe("UTC");
    const service = t.data.service() as AccountService;
    expect(
      await commitMaterialiseDiscovery(service, service.capture(1), {
        task_id: task.taskId,
        expected: null,
        next: {
          retry: 0,
          failures: 3,
          stop: { reason: "unreachable" },
          attempt: "eeeeeeee-0000-4000-8000-000000000130",
        },
      }),
    ).toMatchObject({ kind: "applied", value: { kind: "written" } });
    conflict = true;
    fireEvent.focus(window);
    await t.until(() => scope("personal")?.dataset.streakState === "stopped");
    await t.settle();
    const shown = streaks;
    await t.settle();
    await t.settle();
    expect(
      scope("personal")
        ?.querySelector("[data-streak-stopped]")
        ?.getAttribute("data-streak-stopped"),
    ).toBe("unreachable");
    expect(streaks, "no reread past the stop").toBe(shown);
  });
});

describe("offline and identity", () => {
  test("offline: the figures wait for the connection; the strip is drawn from this device and labelled so", async () => {
    const task = await repeating(["complete", "missed"]);
    let asked = 0;
    const api = fakeApi({
      readStreak: async () => {
        asked += 1;
        return streak(1, 1);
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
      env: { online: false },
    });
    await t.until(() => document.querySelector("[data-streak-strip]") !== null);
    expect(asked).toBe(0);
    expect(scope("personal")).toHaveTextContent(STREAK_COPY.offline);
    expect(page()).toHaveTextContent(STREAK_COPY.onDevice);
  });

  test("MU-10C-33 (streak): an answer asked under one identity is never shown under another", async () => {
    const task = await repeating(["complete"]);
    let release: (r: TasksResult<TaskStreak>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readStreak: () => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => (release = resolve))
          : new Promise(() => undefined);
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => calls === 1);
    t.rerender(tasksEnv(api, { identity: `${ME}:2` }));
    await t.settle();
    release(streak(9, 9));
    await t.settle();
    expect(scope("personal")?.dataset.streakState).toBe("loading");
    expect(page()).not.toHaveTextContent(STREAK_COPY.current(9, "days"));
  });
});

/**
 * Revision 1 (review R6): the strip layers MY pending evidence on each day's synced stream as the detail does, and a completion that has
 * LANDED (the stream lists the server's own entry id) is not counted again. A minimum of 5 with 3 recorded by the completion is still open;
 * the control (the 3 recorded by an ordinary entry, the completion still to land) is done.
 */
describe("R6: a landed completion is counted once on the strip", () => {
  const OPERATION = "cccccccc-0000-4000-8000-000000000021";
  async function numericToday(entryId: (occurrence: string) => string) {
    const task = await repeating(["incomplete"], {
      goal: { kind: "numeric", minimum: "5", maximum: null, unit: "cups" },
    });
    const occurrence = task.rows.find(
      (r) => r.kind === "occurrence",
    ) as CacheRow;
    const stream = await progressId(occurrence.id, ME);
    const happened = Math.floor(Date.now() / 1000) - 5;
    const rows = task.rows.map((r) =>
      r.id === stream
        ? {
            ...r,
            value: {
              ...(r.value as Record<string, unknown>),
              action: { outcome: "incomplete", amount: "3", checked: [] },
              period: { outcome: "incomplete", amount: "3", checked: [] },
              recent_entries: [
                {
                  id: entryId(occurrence.id),
                  evidence: { kind: "quantity", amount: "3" },
                  happened_at: happened,
                  recorded_by: ME,
                },
              ],
              entry_count: 1,
            } as never,
          }
        : r,
    );
    const draft = draftRow({
      local_id: OPERATION,
      created_seq: 1,
      kind: "complete_dependencies",
      endpoint: "/task-commands",
      account_id: ME,
      status: "acknowledged",
      target_resource_ids: [occurrence.id],
      index_targets: [occurrence.id, stream],
      command: {
        command: {
          kind: "complete_dependencies",
          occurrence_id: occurrence.id,
          mode: "require_satisfied",
          root_evidence: { kind: "quantity", amount: "3" },
          happened_at: happened,
        },
      },
    });
    // Acknowledged, its overlay on my stream still standing (sync has not yet retired it): what the strip layers.
    const effect = {
      resource_id: stream,
      local_id: OPERATION,
      resource_version: null,
      created_at: new Date().toISOString(),
      submitted_at_page_seq: 0,
      last_mentioned_page_seq: null,
      display: null,
      resolved: null,
      no_publication_floor: null,
      receipt_revision: 5,
    };
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows,
      drafts: [draft],
      effects: [effect, { ...effect, resource_id: occurrence.id }],
      api: fakeApi({ readStreak: async () => streak(0, 0) }),
    });
    await t.until(() => document.querySelector("[data-strip-state]") !== null);
    return document.querySelector<HTMLElement>("[data-strip-state]")?.dataset
      .stripState;
  }
  test("the completion's own entry in the stream: still open (3 of 5), never done", async () => {
    expect(
      await numericToday(
        (occurrence) => completionEntryId(OPERATION, occurrence, ME) as string,
      ),
    ).toBe("open");
  });
  test("control: an ordinary entry of 3 and the completion still to land: done (3 + 3)", async () => {
    expect(await numericToday(() => crypto.randomUUID())).toBe("done");
  });
});

/**
 * Revision 4 (review R22, family `streak-read-connectivity-ownership`): ONE owner per streak read. Going offline (or any other change of
 * its reason) ends the read in flight before anything else, so its answer, held past the change, publishes nothing: no figures, no
 * catch-up. REVIEW4 S1 is ported verbatim (a stable ready screen, exactly one focus refresh held, offline established, then released).
 */
describe("R22: a held streak read never replaces what came after it", () => {
  test.each([false, true])(
    "REVIEW4 S1 (ported): go offline before a held refresh completes = %s",
    async (offline) => {
      const task = await repeating(["complete"]);
      const held: Array<(v: TasksResult<TaskStreak>) => void> = [];
      let holding = false;
      const api = fakeApi({
        readStreak: async () =>
          holding
            ? new Promise<TasksResult<TaskStreak>>((r) => {
                held.push(r);
              })
            : streak(1, 1),
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/streak`,
        rows: task.rows,
        api,
      });
      await t.until(() => scope("personal")?.dataset.streakState === "ready");
      expect(scope("personal")?.dataset.streakState).toBe("ready");
      holding = true;
      fireEvent(window, new Event("focus"));
      await t.until(() => held.length > 0);
      expect(held).toHaveLength(1);
      if (offline) {
        t.rerender(tasksEnv(api, { online: false }));
        await t.until(
          () => scope("personal")?.dataset.streakState === "offline",
        );
        expect(scope("personal")?.dataset.streakState).toBe("offline");
      }
      (held[0] as (v: TasksResult<TaskStreak>) => void)(streak(12, 20));
      await t.settle();
      expect(scope("personal")?.dataset.streakState).toBe(
        offline ? "offline" : "ready",
      );
    },
  );

  test.each([
    ["offline", false],
    ["still online (control)", true],
  ])(
    "a held 409 released once %s: neither the catch-up nor its tile follows",
    async (_, online) => {
      const task = await repeating(["complete"]);
      const held: Array<(v: TasksResult<TaskStreak>) => void> = [];
      let holding = false;
      let tasks = 0;
      const api = fakeApi({
        readStreak: async () =>
          holding
            ? new Promise<TasksResult<TaskStreak>>((r) => {
                held.push(r);
              })
            : streak(1, 1),
        readTask: () => {
          tasks += 1;
          return new Promise(() => undefined);
        },
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/streak`,
        rows: task.rows,
        api,
      });
      await t.until(() => scope("personal")?.dataset.streakState === "ready");
      holding = true;
      fireEvent(window, new Event("focus"));
      await t.until(() => held.length > 0);
      if (!online) {
        t.rerender(tasksEnv(api, { online: false }));
        await t.until(
          () => scope("personal")?.dataset.streakState === "offline",
        );
      }
      (held[0] as (v: TasksResult<TaskStreak>) => void)(MATERIALISE);
      await t.settle();
      await t.settle();
      expect(scope("personal")?.dataset.streakState).toBe(
        online ? "catching_up" : "offline",
      );
      expect(tasks > 0).toBe(online);
    },
  );

  test("reconnect: the newer read is shown, and the read held from before going offline changes nothing when it answers last", async () => {
    const task = await repeating(["complete"]);
    const held: Array<(v: TasksResult<TaskStreak>) => void> = [];
    let holding = false;
    const api = fakeApi({
      readStreak: async () =>
        holding
          ? new Promise<TasksResult<TaskStreak>>((r) => {
              held.push(r);
            })
          : streak(5, 9),
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
    });
    await t.until(() => scope("personal")?.dataset.streakState === "ready");
    holding = true;
    fireEvent(window, new Event("focus"));
    await t.until(() => held.length > 0);
    t.rerender(tasksEnv(api, { online: false }));
    await t.until(() => scope("personal")?.dataset.streakState === "offline");
    holding = false;
    t.rerender(tasksEnv(api, { online: true }));
    await t.until(() => scope("personal")?.dataset.streakState === "ready");
    const shown = scope("personal")?.textContent;
    (held[0] as (v: TasksResult<TaskStreak>) => void)(streak(12, 20));
    await t.settle();
    expect(scope("personal")?.dataset.streakState).toBe("ready");
    expect(scope("personal")?.textContent).toBe(shown);
  });
});

/**
 * Revision 4 (review R21): the streak reads its OWN task's latest sequence, so other tasks' retained rows cannot hide its recorded stop
 * (and it does not read past a catch-up whose sequence it has not read).
 */
describe("R21: the streak's recorded stop, whatever other tasks hold", () => {
  test.each([
    ["100 other tasks' rows sort first", 100],
    ["none (control)", 0],
  ])("%s", async (_, n) => {
    const task = await repeating(["complete"]);
    const target = {
      task_id: task.taskId,
      through_date: TODAY,
      sequence_generation: "g",
      phase: "stopped",
      attempt: null,
      read_seq: 1,
      successful_calls: 8,
      last_known_position: TODAY,
      started_at: 1,
      read_failures: 0,
      stop: { reason: "bound" },
      trigger: "streak",
    };
    const others = Array.from({ length: n }, (_, i) => ({
      ...target,
      task_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    }));
    const api = fakeApi({
      readStreak: async () => MATERIALISE,
      readTask: () => new Promise(() => undefined),
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
      sequences: [...others, target],
    });
    await t.until(() => scope("personal")?.dataset.streakState === "stopped");
    expect(
      scope("personal")
        ?.querySelector("[data-streak-stopped]")
        ?.getAttribute("data-streak-stopped"),
    ).toBe("bound");
  });
});

/**
 * Revision 5 (review 5 R24): the streak needs its task's TODAY caught up, so once the runner has read the task it shows that day's stop,
 * never a later day's (a horizon stop) that happens to sort last.
 */
describe("R24: the streak's stop is its task's today", () => {
  test.each([
    ["a later horizon stop beside today's bound stop", true],
    ["today's bound stop alone (control)", false],
  ])("%s: today's stop and its Try again are shown", async (_, later) => {
    const task = await repeating(["complete"]);
    const today = {
      task_id: task.taskId,
      through_date: TODAY,
      sequence_generation: "g",
      phase: "stopped",
      attempt: null,
      read_seq: 1,
      successful_calls: 8,
      last_known_position: "2026-01-01",
      started_at: 1,
      read_failures: 0,
      stop: { reason: "bound" },
      trigger: "streak",
    };
    const future = {
      ...today,
      through_date: addDays(TODAY, 32),
      sequence_generation: "future",
      stop: { reason: "horizon" },
    };
    let reads = 0;
    const api = fakeApi({
      readStreak: async () => MATERIALISE,
      readTask: async () => {
        reads += 1;
        return {
          ok: true,
          value: {
            task: task.rows[0] as never,
            execution: task.rows[1] as never,
            materialisation: { last_date: "2026-01-01", pending: true },
          },
        };
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/streak`,
      rows: task.rows,
      api,
      sequences: later ? [today, future] : [today],
    });
    await t.until(
      () =>
        reads > 0 &&
        scope("personal")?.querySelector("[data-streak-stopped]") != null &&
        scope("personal")
          ?.querySelector("[data-streak-stopped]")
          ?.getAttribute("data-streak-stopped") === "bound",
    );
    expect(
      scope("personal")
        ?.querySelector("[data-streak-stopped]")
        ?.getAttribute("data-streak-stopped"),
    ).toBe("bound");
    expect(
      screen.getAllByRole("button", { name: copy.TRY_AGAIN }).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * REVISION 19 (review 20 R41, family `streak-window-clock-freshness`): the device's strip is evaluated at ONE instant, and stops being
 * current at the next opening of ANY saved period (shown or not) or the next closing of a shown one; a retained page then reads it again,
 * by its scheduled boundary and on return to the page (focus, visible `visibilitychange`, `pageshow`), offline as online, and a read a
 * boundary overtook is never published as current. The injected clock (`env.now`) is moved; production waits are not shortened (the
 * scheduled cases use a boundary one second ahead, the wake cases one ten seconds ahead, so the scheduled wait cannot stand in for a wake).
 * Fresh-mount controls at the final instant show the state the retained page must reach. FIXTURE evidence; no device sleep.
 */
describe("R41: the strip follows period windows on a retained page", () => {
  const states = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-strip-state]"),
    ).map((x) => x.dataset.stripState);
  /** Daily, so each saved period has its own slot (and id), counted in days. */
  const DAILY = {
    start_date: TODAY,
    time: null,
    timezone: "UTC",
    repeat: { frequency: "daily" as const, interval: 1 },
  };
  const incomplete = {
    action: { outcome: "incomplete" as const, amount: null, checked: [] },
    period: { outcome: "incomplete" as const, amount: null, checked: [] },
  };
  const windowed = (boundary: "open" | "close", base: number, ahead: number) =>
    seededTask({
      title: "Boundary streak",
      definition: { carry: "close_incomplete", schedule: DAILY },
      occurrence:
        boundary === "open"
          ? { opens_at: base / 1000 + ahead, closes_at: base / 1000 + 3600 }
          : { opens_at: base / 1000 - 100, closes_at: base / 1000 + ahead },
      progress: incomplete,
    });
  /** Another saved period of the same task, the day after the seeded one. */
  const another = async (
    task: Awaited<ReturnType<typeof seededTask>>,
    over: Partial<OccurrenceData>,
  ) => {
    const slot = slotOn(
      task.data.definition.schedule,
      addDays(task.data.slot.date as string, 1),
    );
    return cacheRow({
      id: await occurrenceId(task.taskId, slot.key),
      kind: "occurrence",
      parent_id: task.executionId,
      label: "Occurrence",
      value: { ...task.data, slot, ...over } as never,
    });
  };
  const mountAt = async (
    rows: CacheRow[],
    taskId: string,
    clock: { at: number },
    online = false,
  ) => {
    const t = await mountTasks({
      path: `/tasks/${taskId}/streak`,
      rows,
      env: { online, now: () => clock.at },
    });
    await t.until(
      () =>
        document.querySelector("[data-streak-strip],[data-streak-empty]") !==
        null,
    );
    await t.settle();
    return t;
  };
  const wake = (how: "focus" | "visibilitychange" | "pageshow") => {
    if (how === "focus") fireEvent(window, new Event("focus"));
    if (how === "visibilitychange")
      fireEvent(document, new Event("visibilitychange"));
    if (how === "pageshow") fireEvent(window, new Event("pageshow"));
  };
  const until = async (t: Mounted, ready: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ready() && Date.now() < end) await t.settle();
  };
  const expected = (boundary: "open" | "close") =>
    boundary === "open" ? ["open"] : ["missed"];

  for (const boundary of ["open", "close"] as const)
    for (const how of [
      "scheduled",
      "focus",
      "visibilitychange",
      "pageshow",
    ] as const)
      test.each([false, true])(
        `${boundary} by ${how}: the retained strip ${boundary === "open" ? "gains the period that opened" : "finalises the period that closed"} (fresh mount at the same instant: CONTROL %s)`,
        async (control) => {
          const base = Math.floor(Date.now() / 1000) * 1000;
          const clock = { at: control ? base + 20_000 : base };
          const task = await windowed(
            boundary,
            base,
            how === "scheduled" ? 1 : 10,
          );
          const t = await mountAt(task.rows, task.taskId, clock);
          if (!control) {
            expect(states(), "precondition: before the boundary").toEqual(
              boundary === "open" ? [] : ["open"],
            );
            const page = document.querySelector("[data-streak-page]");
            const drafts = t.drafts().length;
            clock.at = base + 20_000;
            if (how !== "scheduled") wake(how);
            await until(
              t,
              () =>
                JSON.stringify(states()) === JSON.stringify(expected(boundary)),
              how === "scheduled" ? 4_000 : 0,
            );
            await t.settle();
            // The same page, and no data activity: only time moved.
            expect(document.querySelector("[data-streak-page]")).toBe(page);
            expect(t.drafts().length).toBe(drafts);
          }
          expect(states(), "the strip follows the current window").toEqual(
            expected(boundary),
          );
          const missed = boundary === "open" ? 0 : 1;
          expect(document.body).toHaveTextContent(
            STREAK_COPY.lastN("days", 0, missed, missed),
          );
        },
        15_000,
      );

  test.each(["open", "close"] as const)(
    "online (%s): the retained strip follows the window on focus as offline; the server's figures are separate",
    async (boundary) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: base };
      const task = await windowed(boundary, base, 10);
      const t = await mountAt(task.rows, task.taskId, clock, true);
      expect(states()).toEqual(boundary === "open" ? [] : ["open"]);
      clock.at = base + 20_000;
      wake("focus");
      await t.settle();
      expect(states()).toEqual(expected(boundary));
    },
    15_000,
  );

  test.each([false, true])(
    "a period opening that the strip does not show yet still ends the strip's validity: it joins at its opening (CONTROL fresh mount %s)",
    async (control) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: control ? base + 20_000 : base };
      // The shown period closes an hour away; only the NOT YET SHOWN period's opening, one second away, is a boundary in reach.
      const task = await windowed("close", base, 3600);
      const later = await another(task, {
        opens_at: base / 1000 + 1,
        closes_at: base / 1000 + 3600,
      });
      const t = await mountAt([...task.rows, later], task.taskId, clock);
      if (!control) {
        expect(states(), "precondition: only the opened period").toEqual([
          "open",
        ]);
        clock.at = base + 20_000;
        await until(t, () => states().length === 2, 4_000);
      }
      expect(states()).toEqual(["open", "none"]);
    },
    15_000,
  );

  test.each([false, true])(
    "a clock that goes back before a shown period opened selects again on return to the page (CONTROL fresh mount %s)",
    async (control) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: control ? base - 20_000 : base };
      const task = await seededTask({
        title: "Boundary streak",
        definition: { carry: "close_incomplete", schedule: DAILY },
        occurrence: {
          opens_at: base / 1000 - 10,
          closes_at: base / 1000 + 3600,
        },
        progress: incomplete,
      });
      const t = await mountAt(task.rows, task.taskId, clock);
      if (!control) {
        expect(states(), "precondition: opened").toEqual(["open"]);
        clock.at = base - 20_000;
        wake("focus");
        await t.settle();
      }
      expect(states()).toEqual([]);
    },
    15_000,
  );

  test("a read that a boundary overtakes is not published: the next state shown is evaluated after the boundary", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    // The shown period closes ten seconds away (no scheduled wait in reach); a sync then adds a later opened period.
    const task = await windowed("close", base, 10);
    const later = await another(task, {
      opens_at: base / 1000 - 50,
      closes_at: base / 1000 + 3600,
    });
    const t = await mountAt(task.rows, task.taskId, clock);
    expect(states()).toEqual(["open"]);
    // The re-read the sync causes walks the occurrences; the clock passes the closure DURING that walk.
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const store = service.store as { run: typeof service.store.run };
    const original = store.run.bind(service.store);
    let armed = false;
    store.run = ((plan, input, options) => {
      if (
        armed &&
        plan.name === "data.readResourceList" &&
        (input as { kind?: string }).kind === "occurrence"
      ) {
        armed = false;
        clock.at = base + 20_000;
      }
      return original(plan, input, options);
    }) as typeof service.store.run;
    const seen: string[] = [];
    const note = () => {
      const now = JSON.stringify(states());
      if (seen[seen.length - 1] !== now) seen.push(now);
    };
    note();
    const observer = new MutationObserver(note);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    try {
      armed = true;
      await t.commitSync([later]);
      await t.settle();
      await act(async () => undefined);
    } finally {
      observer.disconnect();
      store.run = original;
    }
    expect(armed, "precondition: the walk was overtaken").toBe(false);
    expect(seen).toEqual([
      JSON.stringify(["open"]),
      JSON.stringify(["missed", "none"]),
    ]);
  }, 15_000);
});

/**
 * Revision 20 (Review 22's R42; design assessment of 5 November 2026, S1-S9 and Q1-Q7): a strip whose local read did not complete is never
 * shown as current. With nothing retained the read's failure is shown with its Try again; with a strip retained, the strip is kept and marked
 * as what was last read ("Showing what was last read on this device.") with a Try again of its own that reads the strip again, as Today, the
 * detail, the lists and the form do (WEB-10a decision 31). After a re-read of a LAPSED strip fails, paced attempts (2 s, 10 s, 60 s) ask again
 * with no event; a wake, a commit and Try again still do. Faults are injected at the store boundary (`service.store.run`): the occurrence
 * list (`data.readResourceList`, kind occurrence), the task read (`data.readResourcesById`) and the local basis (`data.readLocalBasis`). The
 * injected clock (`env.now`) moves 20 s past a boundary: a scripted clock move, not device sleep or duration evidence; production waits are
 * unchanged and measured with `performance.now()`. FIXTURE evidence.
 */
describe("R42: a strip whose local read did not complete is never shown as current", () => {
  const states = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-strip-state]"),
    ).map((x) => x.dataset.stripState);
  const marker = () =>
    document
      .querySelector("[data-streak-stale]")
      ?.getAttribute("data-streak-stale") ?? null;
  const notice = () =>
    document.querySelector("[data-streak-stale]") as HTMLElement | null;
  const localError = () =>
    document.querySelector("[data-streak-local-error]") as HTMLElement | null;
  const tryAgains = () =>
    screen.queryAllByRole("button", { name: copy.TRY_AGAIN });
  const DAILY = {
    start_date: TODAY,
    time: null,
    timezone: "UTC",
    repeat: { frequency: "daily" as const, interval: 1 },
  };
  const incomplete = {
    action: { outcome: "incomplete" as const, amount: null, checked: [] },
    period: { outcome: "incomplete" as const, amount: null, checked: [] },
  };
  /** A period that opens (`open`) or closes (`close`) `ahead` seconds after `base`; the other end is an hour away or in the past. */
  const windowed = (boundary: "open" | "close", base: number, ahead: number) =>
    seededTask({
      title: "Stale streak",
      definition: { carry: "close_incomplete", schedule: DAILY },
      occurrence:
        boundary === "open"
          ? { opens_at: base / 1000 + ahead, closes_at: base / 1000 + 3600 }
          : { opens_at: base / 1000 - 100, closes_at: base / 1000 + ahead },
      progress: incomplete,
    });
  /** Another saved period of the same task, the day after the seeded one, opened 50 s before `base` (it joins the strip as "none"). */
  const later = async (
    task: Awaited<ReturnType<typeof seededTask>>,
    base: number,
  ) => {
    const slot = slotOn(
      task.data.definition.schedule,
      addDays(task.data.slot.date as string, 1),
    );
    return cacheRow({
      id: await occurrenceId(task.taskId, slot.key),
      kind: "occurrence",
      parent_id: task.executionId,
      label: "Occurrence",
      value: {
        ...task.data,
        slot,
        opens_at: base / 1000 - 50,
        closes_at: base / 1000 + 3600,
      } as never,
    });
  };
  const mountAt = async (
    rows: CacheRow[],
    taskId: string,
    clock: { at: number },
    options: { online?: boolean; api?: ReturnType<typeof fakeApi> } = {},
  ) => {
    const t = await mountTasks({
      path: `/tasks/${taskId}/streak`,
      rows,
      ...(options.api ? { api: options.api } : {}),
      env: { online: options.online ?? false, now: () => clock.at },
    });
    await t.until(
      () =>
        document.querySelector("[data-streak-strip],[data-streak-empty]") !==
        null,
    );
    await t.settle();
    return t;
  };
  type Seam = "occurrence" | "byId" | "basis";
  /**
   * Rejects the reads of `seam` at the store boundary (`times` of them, or every one while `times` is null) and counts every read of it.
   * `restore()` ends the fault and the count.
   */
  const fault = (t: Mounted, seam: Seam, times: number | null) => {
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const store = service.store as { run: typeof service.store.run };
    const original = store.run.bind(service.store);
    const log = { attempts: 0, failures: 0, on: true };
    store.run = ((plan, input, options) => {
      const hit =
        seam === "occurrence"
          ? plan.name === "data.readResourceList" &&
            (input as { kind?: string }).kind === "occurrence"
          : seam === "byId"
            ? plan.name === "data.readResourcesById"
            : plan.name === "data.readLocalBasis";
      if (hit) {
        log.attempts += 1;
        if (log.on && (times === null || log.failures < times)) {
          log.failures += 1;
          return Promise.reject(new Error("R42 injected local read failure"));
        }
      }
      return original(plan, input, options);
    }) as typeof service.store.run;
    return {
      log,
      /** The fault ends; the count goes on. */
      heal: () => {
        log.on = false;
      },
      restore: () => {
        store.run = original;
      },
    };
  };
  /**
   * The page's own `unstable` (the strip evaluated at one instant is overtaken at every attempt: a clock that moves on and back). Each
   * occurrence walk moves the clock between `a` and `b` while `on`; `end(at)` stops and leaves the clock at `at`.
   */
  const seesaw = (t: Mounted, clock: { at: number }, a: number, b: number) => {
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const store = service.store as { run: typeof service.store.run };
    const original = store.run.bind(service.store);
    const log = { walks: 0, on: true };
    store.run = ((plan, input, options) => {
      if (
        log.on &&
        plan.name === "data.readResourceList" &&
        (input as { kind?: string }).kind === "occurrence"
      ) {
        log.walks += 1;
        clock.at = clock.at === a ? b : a;
      }
      return original(plan, input, options);
    }) as typeof service.store.run;
    return {
      log,
      end: (at: number) => {
        log.on = false;
        store.run = original;
        clock.at = at;
      },
    };
  };
  const wake = (how: "focus" | "visibilitychange" | "pageshow") => {
    if (how === "focus") fireEvent(window, new Event("focus"));
    if (how === "visibilitychange")
      fireEvent(document, new Event("visibilitychange"));
    if (how === "pageshow") fireEvent(window, new Event("pageshow"));
  };
  /** Settles until `ready()` holds or `ms` of REAL time pass (production waits run unshortened). */
  const realWait = async (t: Mounted, ready: () => boolean, ms: number) => {
    const end = performance.now() + ms;
    while (!ready() && performance.now() < end) await t.settle();
  };
  /** The stale presentation: both copy lines and exactly one Try again inside the notice. */
  const expectMarked = (kind: "failed" | "unstable") => {
    expect(marker(), "the kept strip is marked as last read").toBe(kind);
    const box = notice() as HTMLElement;
    expect(box).toHaveTextContent(
      kind === "unstable" ? copy.LOCAL_UNSTABLE : copy.LOCAL_FAILED,
    );
    expect(box).toHaveTextContent(copy.SHOWING_LAST_READ);
    expect(
      within(box).getAllByRole("button", { name: copy.TRY_AGAIN }),
    ).toHaveLength(1);
    expect(localError(), "a kept strip is not the no-value error").toBeNull();
  };
  const localTryAgain = () =>
    within(notice() as HTMLElement).getByRole("button", {
      name: copy.TRY_AGAIN,
    });

  // ---- Q1: the status rule --------------------------------------------------------------------------------------------------------
  test.each(["occurrence", "byId", "basis"] as const)(
    "R42 first read (%s fault): with nothing retained the local error is shown with its Try again, never a skeleton or 'Nothing to show yet.'; Try again with the fault gone shows the strip",
    async (seam) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: base };
      const task = await windowed("close", base, 3600);
      const t = await mountAt(task.rows, task.taskId, clock);
      // CONTROL: the healthy first read of the same task.
      expect(states(), "control: a healthy first read shows the strip").toEqual(
        ["open"],
      );
      const f = fault(t, seam, null);
      try {
        // Another identity is another scope: nothing of the first is kept, so its first read is a FIRST read, and it fails.
        t.rerender(
          tasksEnv(t.api, {
            online: false,
            now: () => clock.at,
            identity: `${ME}:2`,
          }),
        );
        await t.until(() => localError() !== null);
        await t.settle();
        expect(
          f.log.failures,
          "precondition: the first read failed",
        ).toBeGreaterThan(0);
        expect(localError()).toHaveTextContent(copy.LOCAL_FAILED);
        expect(marker()).toBeNull();
        expect(states()).toEqual([]);
        expect(document.querySelector("[data-streak-empty]")).toBeNull();
        expect(page()).not.toHaveTextContent(STREAK_COPY.loading);
        expect(tryAgains()).toHaveLength(1);
        f.heal();
        fireEvent.click(tryAgains()[0] as HTMLElement);
        await t.until(() => states().length === 1);
        await t.settle();
        expect(states()).toEqual(["open"]);
        expect(localError()).toBeNull();
        expect(marker()).toBeNull();
      } finally {
        f.restore();
      }
    },
    15_000,
  );

  test("R42 first read unstable (a clock moving on and back at every attempt): the local error says it kept changing, never empty", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    const task = await windowed("close", base, 10);
    const t = await mountAt(task.rows, task.taskId, clock);
    expect(states()).toEqual(["open"]);
    const s = seesaw(t, clock, base, base + 20_000);
    try {
      t.rerender(
        tasksEnv(t.api, {
          online: false,
          now: () => clock.at,
          identity: `${ME}:2`,
        }),
      );
      await t.until(() => localError() !== null);
      expect(s.log.walks, "precondition: every attempt was overtaken").toBe(3);
      expect(localError()).toHaveTextContent(copy.LOCAL_UNSTABLE);
      expect(document.querySelector("[data-streak-empty]")).toBeNull();
    } finally {
      s.end(base);
    }
  }, 15_000);

  test.each([false, true])(
    "R42 retained strip, a committed change's re-read fails: the cells are kept and marked as last read with the strip's own Try again; Try again with the fault gone is current (CONTROL healthy re-read %s)",
    async (control) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: base };
      const task = await windowed("close", base, 3600);
      const t = await mountAt(task.rows, task.taskId, clock);
      expect(states()).toEqual(["open"]);
      const f = fault(t, "occurrence", control ? 0 : null);
      try {
        await t.commitSync([await later(task, base)]);
        await t.settle();
        if (control) {
          expect(states(), "control: the healthy re-read is current").toEqual([
            "open",
            "none",
          ]);
          expect(marker()).toBeNull();
          return;
        }
        expect(
          f.log.failures,
          "precondition: the re-read failed",
        ).toBeGreaterThan(0);
        expect(states(), "the last complete strip is kept").toEqual(["open"]);
        expectMarked("failed");
        f.heal();
        fireEvent.click(localTryAgain());
        await t.until(() => states().length === 2);
        await t.settle();
        expect(states()).toEqual(["open", "none"]);
        expect(marker(), "a complete read ends the marking").toBeNull();
      } finally {
        f.restore();
      }
    },
    15_000,
  );

  test("R42 retained strip, a committed change's re-read keeps changing (unstable): marked with the unstable copy; Try again on a steady clock is current", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    const task = await windowed("close", base, 10);
    const t = await mountAt(task.rows, task.taskId, clock);
    expect(states()).toEqual(["open"]);
    // The closure (10 s away) lies between the two instants: each attempt is overtaken, forward or back, and none is published.
    const s = seesaw(t, clock, base, base + 20_000);
    try {
      await t.commitSync([await later(task, base)]);
      await t.until(() => marker() !== null);
      expect(s.log.walks).toBe(3);
      expect(states()).toEqual(["open"]);
      expectMarked("unstable");
    } finally {
      s.end(base);
    }
    fireEvent.click(localTryAgain());
    await t.until(() => states().length === 2);
    await t.settle();
    expect(states()).toEqual(["open", "none"]);
    expect(marker()).toBeNull();
  }, 15_000);

  // ---- Q2: liveness -----------------------------------------------------------------------------------------------------------------
  test("R42 the paced attempts are finite: 2 s, 10 s and 60 s, then none", () => {
    expect(EXPIRY_RETRIES_MS).toEqual([2_000, 10_000, 60_000]);
    expect([0, 1, 2, 3, 4, -1].map(expiryRetryDelay)).toEqual([
      2_000,
      10_000,
      60_000,
      null,
      null,
      null,
    ]);
  });

  test("R42 scheduled boundary, ONE failed re-read: the lapsed strip is marked at once and the first paced attempt (2 s) makes it current with no wake", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    const task = await windowed("close", base, 1);
    const t = await mountAt(task.rows, task.taskId, clock);
    expect(states()).toEqual(["open"]);
    const f = fault(t, "occurrence", 1);
    try {
      // The page's own boundary wait (real, about 1 s) finds the clock past the closure; its re-read fails once.
      clock.at = base + 20_000;
      await realWait(t, () => f.log.failures === 1 && marker() !== null, 5_000);
      expect(f.log.failures, "precondition: the scheduled re-read failed").toBe(
        1,
      );
      expect(states(), "the lapsed strip is kept").toEqual(["open"]);
      expectMarked("failed");
      const failedAt = performance.now();
      await realWait(t, () => JSON.stringify(states()) === '["missed"]', 4_000);
      const waited = performance.now() - failedAt;
      expect(
        states(),
        "the first paced attempt reads it again, no event",
      ).toEqual(["missed"]);
      expect(marker()).toBeNull();
      expect(f.log.attempts).toBe(2);
      expect(waited, "paced, not at once").toBeGreaterThan(1_500);
    } finally {
      f.restore();
    }
  }, 20_000);

  test("R42 scheduled boundary, a fault that stays: the strip stays marked with its Try again and the paced attempts are bounded (2 reads in the first 5 s)", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    const task = await windowed("close", base, 1);
    const t = await mountAt(task.rows, task.taskId, clock);
    expect(states()).toEqual(["open"]);
    const f = fault(t, "occurrence", null);
    try {
      clock.at = base + 20_000;
      await realWait(t, () => f.log.failures >= 1 && marker() !== null, 5_000);
      expect(f.log.failures, "precondition: the scheduled re-read failed").toBe(
        1,
      );
      const first = performance.now();
      while (performance.now() - first < 5_000) await t.settle();
      expect(
        f.log.attempts,
        "the scheduled read and the 2 s attempt; the next is 10 s later",
      ).toBe(2);
      expect(states()).toEqual(["open"]);
      expectMarked("failed");
      f.heal();
      fireEvent.click(localTryAgain());
      await t.until(() => JSON.stringify(states()) === '["missed"]');
      expect(states()).toEqual(["missed"]);
      expect(marker()).toBeNull();
    } finally {
      f.restore();
    }
  }, 20_000);

  for (const boundary of ["open", "close"] as const)
    test.each(["focus", "visibilitychange", "pageshow"] as const)(
      `R42 %s after a ${boundary === "open" ? "period opened" : "period closed"} with a fault: the kept strip is marked at once (never 'Nothing to show yet.'); a later wake with the fault gone is current`,
      async (how) => {
        const base = Math.floor(Date.now() / 1000) * 1000;
        const clock = { at: base };
        const task = await windowed(boundary, base, 10);
        const t = await mountAt(task.rows, task.taskId, clock);
        const before = boundary === "open" ? [] : ["open"];
        expect(states(), "precondition: before the boundary").toEqual(before);
        const f = fault(t, "occurrence", null);
        try {
          clock.at = base + 20_000;
          wake(how);
          await t.until(() => f.log.failures >= 1 && marker() !== null);
          const failedAt = performance.now();
          expect(states(), "the last complete strip is kept").toEqual(before);
          expectMarked("failed");
          expect(
            document.querySelector("[data-streak-empty]"),
            "unknown is not empty",
          ).toBeNull();
          f.heal();
          wake(how);
          const after = boundary === "open" ? ["open"] : ["missed"];
          // The wake itself reads again: recovered before the first paced attempt (2 s after the failure) could stand in for it.
          await realWait(
            t,
            () => JSON.stringify(states()) === JSON.stringify(after),
            Math.max(0, 1_500 - (performance.now() - failedAt)),
          );
          expect(
            states(),
            "the wake read the strip again, before any paced attempt was due",
          ).toEqual(after);
          expect(marker()).toBeNull();
        } finally {
          f.restore();
        }
      },
      15_000,
    );

  // ---- Q3: what a failed read keeps -------------------------------------------------------------------------------------------------
  test.each([false, true])(
    "R42 a clock gone back before the strip's instant with a fault: marked, then the recovered read selects again (CONTROL healthy %s)",
    async (control) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: base };
      const task = await seededTask({
        title: "Stale streak",
        definition: { carry: "close_incomplete", schedule: DAILY },
        occurrence: {
          opens_at: base / 1000 - 10,
          closes_at: base / 1000 + 3600,
        },
        progress: incomplete,
      });
      const t = await mountAt(task.rows, task.taskId, clock);
      expect(states()).toEqual(["open"]);
      const f = fault(t, "occurrence", control ? 0 : null);
      try {
        clock.at = base - 20_000;
        wake("focus");
        await t.settle();
        if (!control) {
          await t.until(() => marker() !== null);
          expect(states()).toEqual(["open"]);
          expectMarked("failed");
          f.heal();
          wake("focus");
          await t.until(() => marker() === null);
          await t.settle();
        }
        expect(states(), "the period has not opened at this clock").toEqual([]);
        expect(marker()).toBeNull();
      } finally {
        f.restore();
      }
    },
    15_000,
  );

  test("R42 a read a boundary overtakes, then a failed attempt: the overtaken cells are never published and the kept cells are marked", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    const task = await windowed("close", base, 10);
    const t = await mountAt(task.rows, task.taskId, clock);
    expect(states()).toEqual(["open"]);
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const store = service.store as { run: typeof service.store.run };
    const original = store.run.bind(service.store);
    // The first walk is overtaken by the closure; every later walk fails, until healed.
    let walks = 0;
    let failing = true;
    store.run = ((plan, input, options) => {
      if (
        plan.name === "data.readResourceList" &&
        (input as { kind?: string }).kind === "occurrence"
      ) {
        walks += 1;
        if (walks === 1) clock.at = base + 20_000;
        else if (failing)
          return Promise.reject(new Error("R42 injected local read failure"));
      }
      return original(plan, input, options);
    }) as typeof service.store.run;
    const seen: string[] = [];
    const note = () => {
      const now = JSON.stringify({ cells: states(), marker: marker() });
      if (seen[seen.length - 1] !== now) seen.push(now);
    };
    note();
    const observer = new MutationObserver(note);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    try {
      await t.commitSync([await later(task, base)]);
      await t.until(() => marker() !== null);
      await act(async () => undefined);
      expect(
        walks,
        "precondition: overtaken, then a failed attempt",
      ).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual([
        JSON.stringify({ cells: ["open"], marker: null }),
        JSON.stringify({ cells: ["open"], marker: "failed" }),
      ]);
      failing = false;
      fireEvent.click(localTryAgain());
      await t.until(() => states().length === 2);
      await t.settle();
      expect(states()).toEqual(["missed", "none"]);
      expect(marker()).toBeNull();
    } finally {
      observer.disconnect();
      store.run = original;
    }
  }, 15_000);

  // ---- Q4: ownership and lifetime ---------------------------------------------------------------------------------------------------
  test.each(["identity", "task"] as const)(
    "R42 another %s while a paced attempt is due: the old scope's attempt never runs; nothing more is read after the new scope's first read",
    async (change) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: base };
      const task = await windowed("close", base, 1);
      const other = await seededTask({
        title: "Other streak",
        definition: { carry: "close_incomplete", schedule: DAILY },
        occurrence: {
          opens_at: base / 1000 - 100,
          closes_at: base / 1000 + 3600,
        },
        progress: incomplete,
      });
      const t = await mountAt(
        [...task.rows, ...other.rows],
        task.taskId,
        clock,
      );
      expect(states()).toEqual(["open"]);
      const f = fault(t, "occurrence", null);
      try {
        clock.at = base + 20_000;
        await realWait(t, () => marker() !== null, 5_000);
        expect(
          f.log.failures,
          "precondition: the scheduled re-read failed",
        ).toBe(1);
        // A paced attempt is now due 2 s after that failure. The scope changes before it, with the fault gone.
        f.heal();
        if (change === "identity")
          t.rerender(
            tasksEnv(t.api, {
              online: false,
              now: () => clock.at,
              identity: `${ME}:2`,
            }),
          );
        else
          await act(async () => {
            await t.router.navigate({
              to: "/tasks/$taskId/streak",
              params: { taskId: other.taskId },
            });
          });
        await t.until(() => states().length === 1 && marker() === null);
        await t.settle();
        const settled = f.log.attempts;
        const from = performance.now();
        while (performance.now() - from < 3_000) await t.settle();
        expect(
          f.log.attempts,
          "no attempt of the old scope after the change",
        ).toBe(settled);
        expect(marker()).toBeNull();
      } finally {
        f.restore();
      }
    },
    20_000,
  );

  test("R42 leaving the page while a paced attempt is due: nothing more is read", async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const clock = { at: base };
    const task = await windowed("close", base, 1);
    const t = await mountAt(task.rows, task.taskId, clock);
    const f = fault(t, "occurrence", null);
    try {
      clock.at = base + 20_000;
      await realWait(t, () => marker() !== null, 5_000);
      expect(f.log.failures).toBe(1);
      t.unmount();
      const left = f.log.attempts;
      const from = performance.now();
      while (performance.now() - from < 3_000)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
      expect(f.log.attempts).toBe(left);
    } finally {
      f.restore();
    }
  }, 20_000);

  test.each(["offline", "ready", "error"] as const)(
    "R42 figures %s: the stale strip has exactly one Try again of its own, apart from the figures', and it reads the strip again",
    async (figures) => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      const clock = { at: base };
      const task = await windowed("close", base, 3600);
      const api = fakeApi({
        readStreak: async () =>
          figures === "error"
            ? { ok: false, kind: "uncertain", requestId: "req-5xx" }
            : streak(1, 1),
      });
      const t = await mountAt(task.rows, task.taskId, clock, {
        online: figures !== "offline",
        api,
      });
      await t.until(() => scope("personal")?.dataset.streakState === figures);
      expect(scope("personal")?.dataset.streakState).toBe(figures);
      expect(states()).toEqual(["open"]);
      const f = fault(t, "occurrence", null);
      try {
        await t.commitSync([await later(task, base)]);
        await t.until(() => marker() !== null);
        await t.settle();
        expectMarked("failed");
        const theirs = within(scope("personal") as HTMLElement).queryAllByRole(
          "button",
          { name: copy.TRY_AGAIN },
        );
        expect(theirs).toHaveLength(figures === "error" ? 1 : 0);
        expect(tryAgains()).toHaveLength(figures === "error" ? 2 : 1);
        f.heal();
        fireEvent.click(localTryAgain());
        await t.until(() => states().length === 2);
        await t.settle();
        expect(states(), "the strip's Try again read the strip").toEqual([
          "open",
          "none",
        ]);
        expect(marker()).toBeNull();
      } finally {
        f.restore();
      }
    },
    15_000,
  );

  // ---- Q7: no database on this device -----------------------------------------------------------------------------------------------
  test("R42 no database on this device: the page says the task is not on this device; never a skeleton for ever or 'Nothing to show yet.'", async () => {
    const t = await mountTasks({
      path: "/tasks/task-nowhere/streak",
      database: false,
      env: { online: false },
    });
    await t.until(
      () => document.querySelector("[data-streak-absent]") !== null,
    );
    await t.settle();
    expect(document.querySelector("[data-streak-absent]")).toHaveTextContent(
      STREAK_COPY.absent,
    );
    expect(page()).not.toHaveTextContent(STREAK_COPY.loading);
    expect(document.querySelector("[data-streak-empty]")).toBeNull();
    expect(localError()).toBeNull();
    expect(marker()).toBeNull();
  });
});

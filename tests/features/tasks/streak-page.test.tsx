import { cleanup, fireEvent, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetCatchUp } from "../../../src/features/tasks/catchup/useCatchUp";
import * as copy from "../../../src/features/tasks/copy";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrenceData,
  TaskDefinition,
  TaskDetail,
  TaskStreak,
} from "../../../src/features/tasks/model/contract";
import {
  occurrenceId,
  progressId,
} from "../../../src/features/tasks/model/ids";
import {
  addDays,
  slotOn,
  windows,
} from "../../../src/features/tasks/model/time";
import { STREAK_COPY } from "../../../src/features/tasks/streak/StreakPage";
import { installMatchMedia } from "../../helpers/match-media";
import { cacheRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
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

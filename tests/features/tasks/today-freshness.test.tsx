import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import type { TasksResult } from "../../../src/features/tasks/api";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  OccurrencePage,
  OccurrenceView,
} from "../../../src/features/tasks/model/contract";
import { answerCovers } from "../../../src/features/tasks/view";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  mountTasks,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * R2 (family `task-personal-answer-freshness`) and R4 (family `task-outstanding-pagination-completeness`) of the review of 13 October
 * 2026, over the PRODUCTION data controller and plans. R2: my result from `/daily` applies only while it describes the row: online, for the
 * cache it was read against, and until a window boundary of the row has passed since it was answered; otherwise the personal reapplication
 * of ARCH §3.3c (with its finalisation) shows. R4: a view composes from EVERY page of the outstanding work, never the first window alone.
 * Window boundaries are real (seconds ahead of the real clock); no production timer is shortened.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;
const pageOf = (items: OccurrenceView[]): TasksResult<OccurrencePage> => ({
  ok: true,
  value: { items, next_after: null, revision: 5, pending_tasks: [] },
});
const waitReal = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
const never = () => new Promise<TasksResult<OccurrencePage>>(() => undefined);
/** Following several pages of a chained read takes several settle rounds. */
const untilLong = async (
  t: Awaited<ReturnType<typeof mountTasks>>,
  ready: () => boolean,
) => {
  for (let i = 0; i < 5 && !ready(); i += 1) await t.until(ready);
};
const SLOW = { timeout: 30_000 };

/** A numeric maximum of five with two recorded: provisional while open, complete once the window closes in `closesIn` seconds. */
async function provisionalTask(closesIn: number) {
  const summary = { outcome: "provisional" as const, amount: "2", checked: [] };
  const closes = Math.floor(Date.now() / 1000) + closesIn;
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: null, maximum: "5", unit: "cups" },
    },
    progress: { action: summary, period: summary },
    occurrence: { closes_at: closes },
  });
  const answer = (over: Partial<OccurrenceView> = {}): OccurrenceView => ({
    id: task.occurrenceId,
    version: 1,
    can_edit: true,
    data: task.data,
    outcome: "provisional",
    period_outcome: "provisional",
    actionable: true,
    ...over,
  });
  return { task, closes, answer };
}

describe("answerCovers: the server's derived fields describe the moment they were answered", () => {
  const data = { opens_at: 100, closes_at: 200 };
  test("no answer, or a boundary passed since it, is not covered; before the boundary it is", () => {
    expect(answerCovers(data, null, 150_000)).toBe(false);
    expect(answerCovers(data, 150_000, 199_999)).toBe(true);
    expect(answerCovers(data, 150_000, 200_000)).toBe(false);
    expect(answerCovers(data, 50_000, 120_000)).toBe(false);
    // Answered after the boundary: still covered.
    expect(answerCovers(data, 200_500, 300_000)).toBe(true);
    expect(answerCovers({ opens_at: null, closes_at: null }, 1, 9e12)).toBe(
      true,
    );
  });
});

describe("R2: my result from /daily stops applying when it no longer describes the row", () => {
  test(
    "online, then offline WITHOUT a remount: the saved summary is finalised when the real window closes",
    SLOW,
    async () => {
      const { task, closes, answer } = await provisionalTask(3);
      const api = fakeApi();
      api.respond = () => pageOf([answer()]);
      const t = await mountTasks({ path: PATH, rows: task.rows, api });
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      t.rerender(tasksEnv(api, { online: false }));
      await t.settle();
      // Offline at once: the day is the device's, and the row is no longer the server's answer.
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      await waitReal(Math.max(0, closes * 1000 - Date.now()) + 300);
      await t.settle();
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
    },
  );

  test(
    "online, a window closes before the re-read answers: the row is finalised locally, then the new answer shows",
    SLOW,
    async () => {
      const { task, closes, answer } = await provisionalTask(3);
      const api = fakeApi();
      // Every read made before the boundary is answered at once (however many a remount makes); every read after it is HELD until
      // released, so the row can be looked at between the boundary and the new answer.
      const held: Array<(r: TasksResult<OccurrencePage>) => void> = [];
      api.readDaily = async () =>
        Date.now() < closes * 1000
          ? pageOf([answer()])
          : new Promise((resolve) => {
              held.push(resolve);
            });
      const t = await mountTasks({ path: PATH, rows: task.rows, api });
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      // The precondition: before the boundary the row IS the server's answer (provisional, on track).
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      await waitReal(Math.max(0, closes * 1000 - Date.now()) + 300);
      await t.settle();
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      // The re-read the boundary asked for (two scopes) answers: the server's result shows again.
      await untilLong(t, () => held.length >= 2);
      expect(held.length).toBeGreaterThanOrEqual(2);
      const complete = pageOf([
        answer({ outcome: "complete", period_outcome: "complete" }),
      ]);
      await act(async () => {
        for (const resolve of held.splice(0)) resolve(complete);
      });
      await untilLong(
        t,
        () => row(task.occurrenceId)?.dataset.source === "server",
      );
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );

  test(
    "control: online with no boundary passed, the server's answer stays the row's",
    SLOW,
    async () => {
      const { task, answer } = await provisionalTask(600);
      const api = fakeApi();
      api.respond = () => pageOf([answer({ outcome: "complete" })]);
      const t = await mountTasks({ path: PATH, rows: task.rows, api });
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      await waitReal(1_000);
      await t.settle();
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );

  test(
    "a sync page committed after the read began: the cache's newer progress shows until the re-read answers",
    SLOW,
    async () => {
      const task = await seededTask({ title: "Brush your teeth" });
      const answer: OccurrenceView = {
        id: task.occurrenceId,
        version: 1,
        can_edit: true,
        data: task.data,
        outcome: "incomplete",
        period_outcome: "incomplete",
        actionable: true,
      };
      const api = fakeApi();
      // Answered at once until the page is committed (however many reads a remount makes); held from then on.
      let hold = false;
      let held = 0;
      api.readDaily = async () => {
        if (!hold) return pageOf([answer]);
        held += 1;
        return never();
      };
      const t = await mountTasks({ path: PATH, rows: task.rows, api });
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      // The precondition: the row IS the server's answer (not yet done).
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("to_do");
      hold = true;
      // A sync page brings my stream at version 2, done (another device of mine recorded it). The earlier answer said not yet: it was read
      // before this page, so the device's newer progress shows at once, while the re-read (held here) has not answered.
      const done = { outcome: "complete" as const, amount: null, checked: [] };
      const progress = task.rows[3] as CacheRow;
      await t.commitSync([
        {
          ...progress,
          version: 2,
          value: {
            ...(progress.value as Record<string, unknown>),
            action: done,
            period: done,
            entry_count: 1,
          } as never,
        },
      ]);
      await untilLong(t, () => row(task.occurrenceId)?.dataset.pill === "done");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      // The commit asks for a re-read (after its 750 ms pause); while it is held the row stays the device's.
      await waitReal(1_200);
      await t.settle();
      expect(held).toBeGreaterThan(0);
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );
});

describe("R4: views compose from every page of the outstanding work", () => {
  /** `n` queued records of OTHER occurrences (never this row's): what pushes this row's work past the first window. */
  const unrelated = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      draftRow({
        local_id: `cccccccc-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        created_seq: i + 1,
        kind: "record",
        endpoint: "/task-commands",
        account_id: ME,
        target_resource_ids: [
          `dddddddd-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        ],
        index_targets: [
          `dddddddd-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        ],
        command: {
          command: {
            kind: "record",
            occurrence_id: `dddddddd-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            subject_account_id: ME,
            entry_id: crypto.randomUUID(),
            evidence: { kind: "observe" },
            happened_at: Math.floor(Date.now() / 1000),
          },
        },
      }),
    );

  test(
    "Today: a record saved after 120 others is this row's pending work (it was beyond the first window)",
    SLOW,
    async () => {
      const task = await seededTask({ title: "Brush your teeth" });
      const mine = draftRow({
        local_id: "cccccccc-0000-4000-8000-000000009999",
        created_seq: 121,
        kind: "record",
        endpoint: "/task-commands",
        account_id: ME,
        target_resource_ids: [task.progressId, task.occurrenceId],
        index_targets: [task.progressId, task.occurrenceId],
        expected_version: 1,
        command: {
          command: {
            kind: "record",
            occurrence_id: task.occurrenceId,
            subject_account_id: ME,
            entry_id: crypto.randomUUID(),
            evidence: { kind: "checkbox", complete: true },
            expected_version: 1,
            happened_at: Math.floor(Date.now() / 1000),
          },
        },
      });
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        drafts: [...unrelated(120), mine],
        env: { online: false },
      });
      await untilLong(t, () => row(task.occurrenceId)?.dataset.pill === "done");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      expect(
        row(task.occurrenceId)?.querySelector("[data-pending-mark]"),
      ).not.toBeNull();
    },
  );

  test(
    "the detail: 105 amounts saved against one day all count (more than one window naming one resource)",
    SLOW,
    async () => {
      const task = await seededTask({
        definition: {
          goal: {
            kind: "numeric",
            minimum: "200",
            maximum: null,
            unit: "cups",
          },
        },
      });
      const amounts = Array.from({ length: 105 }, (_, i) =>
        draftRow({
          local_id: `cccccccc-1111-4000-8000-${String(i + 1).padStart(12, "0")}`,
          created_seq: i + 1,
          kind: "record",
          endpoint: "/task-commands",
          account_id: ME,
          target_resource_ids: [task.progressId, task.occurrenceId],
          index_targets: [task.progressId, task.occurrenceId],
          command: {
            command: {
              kind: "record",
              occurrence_id: task.occurrenceId,
              subject_account_id: ME,
              entry_id: `eeeeeeee-1111-4000-8000-${String(i + 1).padStart(12, "0")}`,
              evidence: { kind: "quantity", amount: "1" },
              happened_at: Math.floor(Date.now() / 1000),
            },
          },
        }),
      );
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        drafts: amounts,
        env: { online: false },
      });
      const progress = () =>
        document.querySelector("[data-record-progress]")?.textContent ?? null;
      await untilLong(
        t,
        () => progress() === RECORD_COPY.progress("105", "200", "cups"),
      );
      expect(progress()).toBe(RECORD_COPY.progress("105", "200", "cups"));
    },
  );
});

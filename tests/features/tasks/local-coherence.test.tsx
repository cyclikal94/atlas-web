import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { StoreFailure } from "../../../src/data/store/port";
import type { TasksResult } from "../../../src/features/tasks/api";
import * as copy from "../../../src/features/tasks/copy";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { createTask, record } from "../../../src/features/tasks/model/commands";
import type {
  OccurrencePage,
  OccurrenceView,
} from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  type Mounted,
  mountTasks,
  type SeededTask,
  seededTask,
  TODAY,
} from "../../support/tasks/world";

/**
 * WEB-10a revision 3 (R9, R2, R8; design assessment C1–C3, schedules Q1, Q2, Q4, Q7–Q10, Q14, Q16, Q17). Every case drives the COMPOSED
 * screen over the production data controller, plans and store double, and places real commits or failures BETWEEN the reads a screen
 * makes (an interception of the store's `run`), never a mocked counter. A screen's every publication is recorded (a MutationObserver), so
 * a mixed or false state that is replaced a moment later is still seen. FIXTURE evidence; no backend.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const PATH = `/today?day=${TODAY}&tz=UTC`;
/** Another day of the same screen: nothing of the seeded tasks is in it, and it reads only what Today reads. */
const ELSEWHERE = "/today?day=2001-01-02&tz=UTC";
const SLOW = { timeout: 30_000 };
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;
const rows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-today-row]")].map(
    (el) => el.dataset.todayRow as string,
  );
const waitReal = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  });

/** Every state the page publishes, as `sample()` describes it, from now on (deduplicated in a row). */
function history<T>(sample: () => T): { seen: T[]; stop(): void } {
  const seen: T[] = [];
  const note = () => {
    const next = sample();
    if (JSON.stringify(seen[seen.length - 1]) !== JSON.stringify(next))
      seen.push(next);
  };
  note();
  const observer = new MutationObserver(note);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return { seen, stop: () => observer.disconnect() };
}

/**
 * Intercepts the store of the mounted page: `before(plan, n, input)` runs before the n-th run of a plan (1-based, per plan name) and may
 * commit, wait or throw. Re-entrant runs (a commit made by `before`) pass through untouched.
 */
function intercept(
  t: Mounted,
  before: (plan: string, n: number, input: unknown) => Promise<void> | void,
): { counts: Map<string, number>; restore(): void } {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  const store = service.store as { run: typeof service.store.run };
  const original = store.run.bind(service.store);
  const counts = new Map<string, number>();
  let inside = false;
  store.run = (async (plan, input, options) => {
    if (!inside) {
      const n = (counts.get(plan.name) ?? 0) + 1;
      counts.set(plan.name, n);
      inside = true;
      try {
        await before(plan.name, n, input);
      } finally {
        inside = false;
      }
    }
    return original(plan, input, options);
  }) as typeof service.store.run;
  return {
    counts,
    restore: () => {
      store.run = original;
    },
  };
}

/** Shows another day of Today (the route's own search parameters). */
async function showDay(t: Mounted, day: string) {
  await act(async () => {
    await t.router.navigate({ to: "/today", search: { day, tz: "UTC" } });
  });
}

/** A gate a test opens later. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

const failure = () => new StoreFailure("error");

/**
 * After a write placed between two reads (`changed()`), the SECOND later read of the local basis is held: in a screen that refused the
 * mixed attempt that is its next attempt (nothing published yet), in one that accepted it, the read after its publication. A MutationObserver
 * cannot see a state that is replaced inside one `act` (React renders the last), so the page is inspected while this read is held.
 */
function holdAfterChange(t: Mounted, changed: () => boolean) {
  const held = gate();
  let reads = 0;
  let holding = false;
  return {
    async before(plan: string): Promise<void> {
      if (
        !changed() ||
        plan !== "data.readLocalBasis" ||
        !t.router.state.location.href.includes(TODAY)
      )
        return;
      reads += 1;
      if (reads === 2) {
        holding = true;
        await held.opened;
      }
    },
    holding: () => holding,
    release: () => held.open(),
  };
}

async function savedTask(title = "Saved"): Promise<SeededTask> {
  return seededTask({ title });
}

// ---- Q7/Q8: a commit between the reads of one composition is never published as the day ---------------------------------------------

describe("Q8: a commit between two related reads (the occurrence, then its task) is never published as a mixed day", () => {
  for (const between of [true, false])
    test(
      `between=${between}: every published row is the old pair or the new pair, never the old occurrence with the new title`,
      SLOW,
      async () => {
        const task = await savedTask("Old title");
        const t = await mountTasks({
          path: ELSEWHERE,
          rows: task.rows,
          env: { online: false },
        });
        await t.commitSync([]);
        const occurrence = task.rows.find((r) => r.kind === "occurrence");
        const taskRow = task.rows.find((r) => r.kind === "task");
        if (!occurrence || !taskRow) throw new Error("setup");
        const next = [
          { ...occurrence, version: 2 },
          { ...taskRow, label: "New title", version: 2 },
        ];
        let committed = false;
        const hold = holdAfterChange(t, () => committed);
        const spy = intercept(t, async (plan, _n, input) => {
          const ids = (input as { ids?: string[] }).ids ?? [];
          // The task's row is read in the second related read, after the occurrence's: land the page just before it.
          if (
            between &&
            !committed &&
            plan === "data.readResourcesById" &&
            ids.includes(task.taskId) &&
            t.router.state.location.href.includes(TODAY)
          ) {
            committed = true;
            expect(await t.commitNow(next)).toBe(true);
            return;
          }
          await hold.before(plan);
        });
        const shown = () => {
          const el = row(task.occurrenceId);
          return el === null
            ? null
            : `${el.dataset.version}|${el.textContent?.includes("New title") ? "new" : "old"}`;
        };
        await showDay(t, TODAY);
        if (between) {
          await t.until(() => hold.holding());
          await t.settle();
          expect(hold.holding()).toBe(true);
          // Nothing of the attempt that spanned the commit is shown: neither the old occurrence with the new title nor the reverse.
          expect(shown()).not.toBe("1|new");
          expect(shown()).not.toBe("2|old");
          hold.release();
        } else await t.commitSync(next);
        await t.until(() => row(task.occurrenceId)?.dataset.version === "2");
        await t.settle();
        spy.restore();
        expect(committed).toBe(between);
        expect(shown()).toBe("2|new");
      },
    );
});

describe("Q7: a commit behind the walk's cursor (more than one window of occurrences) restarts the walk; the first day published has it", () => {
  test(
    "a task saved behind the cursor while the walk is between its windows is in the FIRST day published",
    SLOW,
    async () => {
      const fillers: CacheRow[] = [];
      for (let i = 0; i < 110; i += 1) {
        const filler = await seededTask({ date: "2099-01-01", stream: false });
        const occurrence = filler.rows.find((r) => r.kind === "occurrence");
        if (occurrence) fillers.push(occurrence);
      }
      const ids = fillers.map((r) => r.id).sort();
      // A task whose occurrence id sorts before the first window's last row (the walk is in primary-key order).
      let added: SeededTask | null = null;
      for (let i = 0; i < 400 && added === null; i += 1) {
        const candidate = await seededTask({ title: "Added behind" });
        if (candidate.occurrenceId < (ids[40] as string)) added = candidate;
      }
      if (added === null) throw new Error("setup: no id behind the cursor");
      const t = await mountTasks({
        path: ELSEWHERE,
        rows: fillers,
        env: { online: false },
      });
      await t.commitSync([]);
      let committed = false;
      let windows = 0;
      const hold = holdAfterChange(t, () => committed);
      const spy = intercept(t, async (plan) => {
        if (
          !committed &&
          plan === "data.readResourceList" &&
          t.router.state.location.href.includes(TODAY)
        ) {
          windows += 1;
          // Between the first and the second window of the walk.
          if (windows === 2) {
            committed = true;
            expect(await t.commitNow(added.rows)).toBe(true);
          }
          return;
        }
        await hold.before(plan);
      });
      await showDay(t, TODAY);
      await t.until(() => hold.holding());
      await t.settle();
      expect(committed).toBe(true);
      expect(hold.holding()).toBe(true);
      // No day the walk certified without the task saved behind its cursor: nothing yet, or a day that has it.
      expect(rows().length === 0 || rows().includes(added.occurrenceId)).toBe(
        true,
      );
      hold.release();
      await t.until(() => row(added.occurrenceId) !== null);
      await t.settle();
      spy.restore();
      expect(row(added.occurrenceId)).not.toBeNull();
    },
  );
});

// ---- Q9: instability on every bounded attempt --------------------------------------------------------------------------------------

describe("Q9: a day that kept changing on every attempt is never certified; cold it says so with nothing, warm the last day stays, stale", () => {
  for (const warm of [false, true])
    test(`warm=${warm}`, SLOW, async () => {
      const task = await savedTask();
      const other = await seededTask({ date: "2099-01-01", stream: false });
      const t = await mountTasks({
        path: warm ? PATH : ELSEWHERE,
        rows: task.rows,
        env: { online: false },
      });
      await t.commitSync([]);
      if (warm) await t.until(() => row(task.occurrenceId) !== null);
      let commits = 0;
      const held = gate();
      let holding = false;
      const spy = intercept(t, async (plan, n, input) => {
        // The FIRST related read of each attempt (the one that names the occurrence): one commit inside each of the three attempts, then
        // the next attempt's waits.
        if (
          plan !== "data.readResourcesById" ||
          !((input as { ids?: string[] }).ids ?? []).includes(task.occurrenceId)
        )
          return;
        if (commits < 3) {
          commits += 1;
          const occurrence = other.rows.find((r) => r.kind === "occurrence");
          expect(
            await t.commitNow([
              { ...(occurrence as CacheRow), version: n + 1 },
            ]),
          ).toBe(true);
          return;
        }
        holding = true;
        await held.opened;
      });
      const seen = history(() =>
        !t.router.state.location.href.includes(TODAY)
          ? null
          : {
              rows: rows().length,
              empty: document.querySelector("[data-today-empty]") !== null,
              error:
                document
                  .querySelector("[data-today-local-error]")
                  ?.getAttribute("data-today-local-error") ?? null,
              stale: document.querySelector("[data-today-stale]") !== null,
            },
      );
      if (warm) {
        // A local change starts a new read of the day.
        await t.commitSync([
          { ...(other.rows[0] as CacheRow), label: "touched" },
        ]);
      } else await showDay(t, TODAY);
      await t.until(
        () => document.querySelector("[data-today-local-error]") !== null,
      );
      expect(commits).toBe(3);
      expect(holding).toBe(true);
      const error = document.querySelector("[data-today-local-error]");
      expect(error?.getAttribute("data-today-local-error")).toBe("unstable");
      expect(document.querySelector("[data-today-empty]")).toBeNull();
      if (warm) {
        expect(row(task.occurrenceId)).not.toBeNull();
        expect(document.querySelector("[data-today-stale]")).not.toBeNull();
      } else expect(rows()).toEqual([]);
      // Quiet again: the read that waited completes, and the day is current.
      held.open();
      await t.until(
        () => document.querySelector("[data-today-local-error]") === null,
      );
      await t.settle();
      seen.stop();
      spy.restore();
      expect(row(task.occurrenceId)).not.toBeNull();
      expect(document.querySelector("[data-today-stale]")).toBeNull();
      expect(seen.seen.some((s) => s?.empty === true)).toBe(false);
    });

  test("control: a stable day is certified, with no notice and nothing stale", async () => {
    const task = await savedTask();
    const t = await mountTasks({
      path: ELSEWHERE,
      rows: task.rows,
      env: { online: false },
    });
    const spy = intercept(t, () => undefined);
    await showDay(t, TODAY);
    await t.until(() => row(task.occurrenceId) !== null);
    await t.settle();
    spy.restore();
    expect(spy.counts.get("data.readLocalBasis") ?? 0).toBeGreaterThan(0);
    expect(document.querySelector("[data-today-local-error]")).toBeNull();
    expect(document.querySelector("[data-today-stale]")).toBeNull();
  });
});

// ---- Q10: a failed read is never an empty day --------------------------------------------------------------------------------------

describe("Q10: a read that failed (the walk, a related read, the basis, a page of the queue) is never shown as an empty day", () => {
  const stages = [
    "data.readResourceList",
    "data.readResourcesById",
    "data.readLocalBasis",
    "data.readOutstandingByKind",
  ] as const;
  for (const stage of stages)
    for (const warm of [false, true])
      test(`${stage}, warm=${warm}`, SLOW, async () => {
        const task = await savedTask();
        const t = await mountTasks({
          path: warm ? PATH : ELSEWHERE,
          rows: task.rows,
          env: { online: false },
        });
        await t.commitSync([]);
        if (warm) await t.until(() => row(task.occurrenceId) !== null);
        let failures = 0;
        const spy = intercept(t, (plan) => {
          if (plan === stage && failures < 1) {
            failures += 1;
            throw failure();
          }
        });
        const seen = history(
          () =>
            t.router.state.location.href.includes(TODAY) &&
            document.querySelector("[data-today-empty]") !== null,
        );
        if (warm)
          await t.commitSync([
            { ...(task.rows[0] as CacheRow), label: "renamed" },
          ]);
        else await showDay(t, TODAY);
        await t.until(
          () => document.querySelector("[data-today-local-error]") !== null,
        );
        seen.stop();
        expect(failures).toBe(1);
        expect(
          document
            .querySelector("[data-today-local-error]")
            ?.getAttribute("data-today-local-error"),
        ).toBe("failed");
        expect(seen.seen).not.toContain(true);
        expect(document.querySelector("[data-today-loading]")).toBeNull();
        if (warm) {
          expect(row(task.occurrenceId)).not.toBeNull();
          expect(document.querySelector("[data-today-stale]")).not.toBeNull();
        } else expect(rows()).toEqual([]);
        // "Try again" reads the day again.
        const retry = [
          ...document.querySelectorAll<HTMLButtonElement>(
            "[data-today-local-error] button",
          ),
        ][0];
        expect(retry).toBeDefined();
        await act(async () => {
          fireEvent.click(retry as HTMLButtonElement);
        });
        await t.until(() => row(task.occurrenceId) !== null);
        await t.until(
          () => document.querySelector("[data-today-local-error]") === null,
        );
        spy.restore();
        expect(document.querySelector("[data-today-local-error]")).toBeNull();
        expect(row(task.occurrenceId)).not.toBeNull();
      });

  test("control: a healthy day with nothing due says so; a candidate whose progress row is missing is still a row (an absence, not a failure)", async () => {
    const t = await mountTasks({
      path: PATH,
      rows: [],
      env: { online: false },
    });
    await t.commitSync([]);
    await t.until(() => document.querySelector("[data-today-empty]") !== null);
    expect(document.querySelector("[data-today-empty]")).not.toBeNull();
    expect(document.querySelector("[data-today-local-error]")).toBeNull();
    cleanup();
    const task = await seededTask({ stream: false });
    const u = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await u.until(() => row(task.occurrenceId) !== null);
    expect(row(task.occurrenceId)).not.toBeNull();
    expect(document.querySelector("[data-today-local-error]")).toBeNull();
  });
});

// ---- Q1/Q2: the clock went back; answers asked before it are not the clock's ---------------------------------------------------------

/** A maximum-5 task with 2 recorded whose window closed a minute ago; the server's answer (evaluated after the close) says complete. */
async function closedTask() {
  const close = Math.floor(Date.now() / 1000) - 60;
  const summary = {
    outcome: "provisional" as const,
    amount: "2",
    checked: [],
  };
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: null, maximum: "5", unit: "cups" },
    },
    progress: { action: summary, period: summary },
    occurrence: { closes_at: close },
  });
  const item: OccurrenceView = {
    id: task.occurrenceId,
    version: 1,
    can_edit: true,
    data: task.data,
    outcome: "complete",
    period_outcome: "complete",
    actionable: false,
  };
  return { task, close, item };
}
const page = (items: OccurrenceView[]): TasksResult<OccurrencePage> => ({
  ok: true,
  value: { items, next_after: null, revision: 1, pending_tasks: [] },
});

describe("Q1: the clock moved back before the close: the retained server answer is not the clock's; local until a new one", () => {
  for (const replacement of ["held", "failed", "control"] as const)
    test(`replacement ${replacement}`, SLOW, async () => {
      const { task, close, item } = await closedTask();
      let now = Date.now();
      let mode: "answer" | "held" | "failed" = "answer";
      const api = fakeApi();
      api.readDaily = async () =>
        mode === "held"
          ? new Promise(() => undefined)
          : mode === "failed"
            ? { ok: false, kind: "uncertain" }
            : page([item]);
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api,
        env: { now: () => now },
      });
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      mode = replacement === "failed" ? "failed" : "held";
      if (replacement === "control") now += 1_000;
      else now = close * 1000 - 60_000;
      await act(async () => {
        fireEvent.focus(window);
      });
      await waitReal(1_000);
      await t.settle();
      if (replacement === "control") {
        expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
        expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      } else {
        expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
        expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      }
    });
});

describe("Q2: an answer asked before the clock went back is never the clock's, even delivered later or back at the same time", () => {
  test(
    "an answer held across the rewind and delivered after it applies no server field; the same-generation control does",
    SLOW,
    async () => {
      const { task, close, item } = await closedTask();
      let now = Date.now();
      const answers: Array<(v: TasksResult<OccurrencePage>) => void> = [];
      const api = fakeApi();
      api.readDaily = () =>
        new Promise((resolve) => {
          answers.push(resolve);
        });
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api,
        env: { now: () => now },
      });
      await t.until(() => answers.length >= 2);
      // Both scopes of the first read are dispatched after the close; the clock now goes back before it.
      const first = answers.splice(0, 2);
      now = close * 1000 - 60_000;
      await act(async () => {
        fireEvent.focus(window);
      });
      await waitReal(1_000);
      for (const deliver of first) deliver(page([item]));
      await waitReal(200);
      await t.settle();
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      // A read asked after the rewind is the clock's: delivered, it applies (the item says what the server says now). Every read still
      // pending, and every later one, is answered so (the old answer's arrival asks once more).
      const current = page([
        {
          ...item,
          outcome: "provisional",
          period_outcome: "provisional",
          actionable: true,
        },
      ]);
      api.readDaily = async () => current;
      for (const deliver of answers.splice(0)) deliver(current);
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      expect(row(task.occurrenceId)?.dataset.source).toBe("server");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
    },
  );

  test(
    "back and forth to the SAME wall time: an answer asked before the excursion is not the clock's",
    SLOW,
    async () => {
      const { task, close, item } = await closedTask();
      const start = Date.now();
      let now = start;
      let held = false;
      const api = fakeApi();
      api.readDaily = async () =>
        held ? new Promise(() => undefined) : page([item]);
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        api,
        env: { now: () => now },
      });
      await t.until(() => row(task.occurrenceId)?.dataset.source === "server");
      held = true;
      now = close * 1000 - 60_000;
      await act(async () => {
        fireEvent.focus(window);
      });
      await waitReal(200);
      now = start;
      await act(async () => {
        fireEvent.focus(window);
      });
      await waitReal(1_000);
      await t.settle();
      expect(row(task.occurrenceId)?.dataset.source).toBe("local");
    },
  );
});

// ---- Q4/Q5: the clock schedules every candidate's EFFECTIVE window ---------------------------------------------------------------------

describe("Q4: an occurrence created offline and recorded on is woken at its close with no other event (R8); controls", () => {
  for (const surface of ["today", "detail"] as const)
    test(surface, SLOW, async () => {
      const task = await seededTask({
        definition: {
          goal: { kind: "numeric", minimum: null, maximum: "5", unit: "cups" },
        },
      });
      const close = (task.data.closes_at as number) * 1000;
      const started = Date.now();
      const now = () => close - 4_000 + (Date.now() - started);
      const t = await mountTasks({
        path:
          surface === "today"
            ? PATH
            : `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: [],
        env: { online: false, now },
      });
      await act(async () => {
        const created = await t.data.outbox()?.enqueue(
          createTask({
            taskId: task.taskId,
            executionId: task.executionId,
            occurrenceId: task.occurrenceId,
            progressId: task.progressId,
            title: "Projected close",
            definition: task.data.definition,
            sharing: "only_me",
            defaults: null,
          }),
        );
        expect(created?.kind).toBe("queued");
        const recorded = await t.data.outbox()?.enqueue(
          record({
            occurrenceId: task.occurrenceId,
            progressId: task.progressId,
            me: ME,
            entryId: crypto.randomUUID(),
            evidence: { kind: "quantity", amount: "2" },
            happenedAt: Math.floor(now() / 1000),
            firstAnyoneStream: false,
            defaults: null,
            replaces: null,
          }),
        );
        expect(recorded?.kind).toBe("queued");
      });
      const pill = () =>
        surface === "today"
          ? row(task.occurrenceId)?.dataset.pill
          : document
              .querySelector("[data-detail-pill]")
              ?.getAttribute("data-detail-pill");
      await t.until(() => pill() === "on_track");
      expect(now()).toBeLessThan(close);
      // Nothing happens on the page but time.
      await waitReal(close - now() + 600);
      await t.settle();
      expect(pill()).toBe("done");
    });
});

/** A maximum-5 task with 2 recorded (provisional while open, complete once closed), with the window given. */
async function upperBound(
  occurrence: {
    opens_at?: number;
    closes_at: number;
    slot?: SeededTask["data"]["slot"];
  },
  date?: string,
) {
  const summary = { outcome: "provisional" as const, amount: "2", checked: [] };
  return seededTask({
    definition: {
      goal: { kind: "numeric", minimum: null, maximum: "5", unit: "cups" },
    },
    progress: { action: summary, period: summary },
    occurrence,
    ...(date === undefined ? {} : { date }),
  });
}
const correction = (
  task: SeededTask,
  value: Record<string, unknown>,
  localId = "cccccccc-0000-4000-8000-00000000c101",
) =>
  draftRow({
    local_id: localId,
    created_seq: 1,
    kind: "revise_occurrence",
    endpoint: "/task-commands",
    account_id: ME,
    target_resource_ids: [task.occurrenceId],
    index_targets: [task.occurrenceId],
    display_patch: { [task.occurrenceId]: { value } },
    command: {
      command: {
        kind: "revise_occurrence",
        id: task.occurrenceId,
        expected_version: 1,
      },
    },
  });

describe("Q5: Today follows the window a queued correction gives, and a correction can bring an occurrence into the day", () => {
  test(
    "a queued correction moves the close an hour earlier to three seconds away: Today wakes at the corrected close (no event)",
    SLOW,
    async () => {
      const task = await upperBound({
        closes_at: Math.floor(Date.now() / 1000) + 3600,
      });
      const corrected = Math.floor(Date.now() / 1000) + 3;
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        env: { online: false },
        drafts: [correction(task, { closes_at: corrected })],
      });
      await t.until(() => row(task.occurrenceId)?.dataset.pill === "on_track");
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      await waitReal(corrected * 1000 - Date.now() + 500);
      await t.settle();
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
    },
  );

  for (const into of [true, false])
    test(
      `a queued correction of a day saved for 2099 to ${into ? "today" : "another day"}: shown in today's list = ${into}`,
      SLOW,
      async () => {
        const today = await seededTask({});
        const far = await seededTask({ date: "2099-01-01", title: "Moved" });
        const target = into
          ? today.data
          : (await seededTask({ date: "2099-02-01" })).data;
        const t = await mountTasks({
          path: PATH,
          rows: far.rows,
          env: { online: false },
          drafts: [
            correction(far, {
              slot: target.slot,
              opens_at: target.opens_at,
              closes_at: target.closes_at,
            }),
          ],
        });
        await t.until(
          () => document.querySelector("[data-today-loading]") === null,
        );
        await t.settle();
        expect(row(far.occurrenceId) !== null).toBe(into);
      },
    );
});

describe("Q9b: a stale day still moves with time (inputs are kept, not frozen rows)", () => {
  test(
    "after a failed read the last day stays, stale, and its close still finalises it with no event",
    SLOW,
    async () => {
      const closes = Math.floor(Date.now() / 1000) + 4;
      const task = await upperBound({ closes_at: closes });
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        env: { online: false },
      });
      await t.commitSync([]);
      await t.until(() => row(task.occurrenceId)?.dataset.pill === "on_track");
      let failing = true;
      const spy = intercept(t, (plan) => {
        if (failing && plan === "data.readResourcesById") throw failure();
      });
      await t.commitSync([{ ...(task.rows[0] as CacheRow), label: "renamed" }]);
      await t.until(
        () => document.querySelector("[data-today-stale]") !== null,
      );
      expect(document.querySelector("[data-today-stale]")).not.toBeNull();
      expect(row(task.occurrenceId)?.dataset.pill).toBe("on_track");
      await waitReal(closes * 1000 - Date.now() + 500);
      await t.settle();
      expect(document.querySelector("[data-today-stale]")).not.toBeNull();
      expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      failing = false;
      spy.restore();
    },
  );
});

describe("Q14: an answer older than a removal this view never observed does not bring the row back; the legitimate first answer does", () => {
  for (const removed of [true, false])
    test(`removed before the answer arrived = ${removed}`, SLOW, async () => {
      const task = await seededTask({});
      const item: OccurrenceView = {
        id: task.occurrenceId,
        version: 1,
        can_edit: true,
        data: task.data,
        outcome: "incomplete",
        period_outcome: "incomplete",
        actionable: true,
      };
      const answers: Array<(v: TasksResult<OccurrencePage>) => void> = [];
      const api = fakeApi();
      api.readDaily = () =>
        new Promise((resolve) => {
          answers.push(resolve);
        });
      // The cache never held the occurrence on this page (the delta has not delivered it, or it was removed before the page looked).
      const t = await mountTasks({
        path: PATH,
        rows: task.rows.filter((r) => r.kind !== "occurrence"),
        api,
      });
      await t.commitSync([]);
      await t.until(() => answers.length >= 2);
      const first = answers.splice(0);
      // Content committed after the read was dispatched: the removal (or, for the control, nothing).
      if (removed) await t.commitSync([], [task.occurrenceId]);
      api.readDaily = async () =>
        removed
          ? {
              ok: true,
              value: {
                items: [],
                next_after: null,
                revision: 3,
                pending_tasks: [],
              },
            }
          : {
              ok: true,
              value: {
                items: [item],
                next_after: null,
                revision: 3,
                pending_tasks: [],
              },
            };
      const seen = history(() => row(task.occurrenceId) !== null);
      for (const deliver of first)
        deliver({
          ok: true,
          value: {
            items: [item],
            next_after: null,
            revision: 1,
            pending_tasks: [],
          },
        });
      await waitReal(1_500);
      await t.settle();
      seen.stop();
      if (removed) {
        expect(seen.seen).not.toContain(true);
        expect(row(task.occurrenceId)).toBeNull();
      } else {
        expect(row(task.occurrenceId)).not.toBeNull();
        expect(row(task.occurrenceId)?.dataset.structure).toBe("daily");
      }
    });
});

describe("Q16: a read of one day that completes after another day is shown is never shown under it", () => {
  test(
    "the first day's read is held, the day changes, the held read is released",
    SLOW,
    async () => {
      const task = await savedTask("First day");
      const t = await mountTasks({
        path: ELSEWHERE,
        rows: task.rows,
        env: { online: false },
      });
      await t.commitSync([]);
      const held = gate();
      let holding = 0;
      const spy = intercept(t, async (plan, _n, input) => {
        if (
          plan === "data.readResourcesById" &&
          ((input as { ids?: string[] }).ids ?? []).includes(
            task.occurrenceId,
          ) &&
          holding === 0
        ) {
          holding += 1;
          await held.opened;
        }
      });
      await showDay(t, TODAY);
      await t.until(() => holding > 0);
      await showDay(t, "2001-01-01");
      await t.settle();
      const seen = history(() => row(task.occurrenceId) !== null);
      held.open();
      await waitReal(300);
      await t.settle();
      seen.stop();
      spy.restore();
      expect(seen.seen).not.toContain(true);
      expect(row(task.occurrenceId)).toBeNull();
    },
  );
});

describe("Q17: the detail, the task list and the task form never take a failed read for no saved work", () => {
  test(
    "detail: a failed read of the day's inputs says so (never 'no day'); Try again reads it",
    SLOW,
    async () => {
      const task = await savedTask();
      const t = await mountTasks({
        path: "/tasks/new",
        rows: task.rows,
        env: { online: false },
      });
      let failing = true;
      const spy = intercept(t, (plan) => {
        if (failing && plan === "data.readResourcesById") throw failure();
      });
      await act(async () => {
        await t.router.navigate({
          to: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        });
      });
      await t.until(
        () => document.querySelector("[data-detail-row-error]") !== null,
      );
      expect(
        document
          .querySelector("[data-detail-row-error]")
          ?.getAttribute("data-detail-row-error"),
      ).toBe("failed");
      expect(document.querySelector("[data-no-occurrence]")).toBeNull();
      failing = false;
      await act(async () => {
        fireEvent.click(
          document.querySelector(
            "[data-detail-row-error] button",
          ) as HTMLButtonElement,
        );
      });
      await t.until(
        () => document.querySelector("[data-detail-pill]") !== null,
      );
      spy.restore();
      expect(document.querySelector("[data-detail-pill]")).not.toBeNull();
      expect(document.querySelector("[data-detail-row-error]")).toBeNull();
    },
  );

  for (const failing of [true, false])
    test(
      `list: a failed read of the tasks = ${failing}: 'No tasks' only when it is known`,
      SLOW,
      async () => {
        const t = await mountTasks({
          path: "/today",
          rows: [],
          env: { online: false },
        });
        await t.commitSync([]);
        // The list's live reads are the double's transactions: a fault there is what a failed read of the store is.
        const remove = t.world.idb.inject({
          match: (tx) => failing && tx.label === "data.readResourceList",
          mode: "error",
        });
        await act(async () => {
          await t.router.navigate({ to: "/tasks" });
        });
        await t.until(
          () =>
            document.querySelector("[data-task-list-error]") !== null ||
            document
              .querySelector("[data-task-list]")
              ?.textContent?.includes("No tasks here yet.") === true,
        );
        await t.settle();
        remove();
        const list = document.querySelector("[data-task-list]");
        expect(document.querySelector("[data-task-list-error]") !== null).toBe(
          failing,
        );
        expect(list?.textContent?.includes("No tasks here yet.")).toBe(
          !failing,
        );
      },
    );

  // LABELLED ADAPTATION (revision 4, R9 / design assessment C1): the edit's entry now reads the task through the detail's certified read,
  // which reads the queue (a queued create is the task); with the queue unreadable AT ENTRY that read fails and the page says so with Try
  // again, so there is no form and no Save at all. Original intent kept: nothing can be saved and the page says why (the same text). The
  // form's own block (the queue becoming unreadable while the form is open) is the next case, so MU-2117 keeps a witness.
  test(
    "form: editing while the queue cannot be read saves nothing and says why",
    SLOW,
    async () => {
      const task = await savedTask();
      const t = await mountTasks({
        path: "/today",
        rows: task.rows,
        env: { online: false },
      });
      await t.commitSync([]);
      const remove = t.world.idb.inject({
        match: (tx) => tx.label === "data.readOutstandingByKind",
        mode: "error",
      });
      await act(async () => {
        await t.router.navigate({
          to: "/tasks/$taskId/edit",
          params: { taskId: task.taskId },
        });
      });
      await t.until(
        () => document.querySelector("[data-task-edit-error]") !== null,
      );
      await t.settle();
      remove();
      const save = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Save"),
      );
      expect(save === undefined || save.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Atlas couldn't read the tasks saved on this device.",
      );
      expect(
        within(
          document.querySelector("[data-task-edit-error]") as HTMLElement,
        ).queryByRole("button", { name: copy.TRY_AGAIN }),
      ).not.toBeNull();
      expect(document.body.textContent).not.toContain(DETAIL_COPY.absent);
    },
  );

  test(
    "form: the queue becomes unreadable while the form is open: Save is withheld and says why; the typed name stays",
    SLOW,
    async () => {
      const task = await savedTask();
      const t = await mountTasks({
        path: "/today",
        rows: task.rows,
        env: { online: false },
      });
      await t.commitSync([]);
      await act(async () => {
        await t.router.navigate({
          to: "/tasks/$taskId/edit",
          params: { taskId: task.taskId },
        });
      });
      await t.until(
        () => document.querySelector('[data-task-form="edit"]') !== null,
      );
      const name = () =>
        screen.getByLabelText(FORM_COPY.name) as HTMLInputElement;
      fireEvent.change(name(), { target: { value: "Typed, not saved" } });
      const remove = t.world.idb.inject({
        match: (tx) => tx.label === "data.readOutstandingByKind",
        mode: "error",
      });
      await t.commitSync([
        {
          ...(task.rows[0] as CacheRow),
          label: "Synced meanwhile",
          version: 2,
        },
      ]);
      await t.until(
        () => document.querySelector("[data-task-edit-error]") !== null,
      );
      await t.settle();
      remove();
      // The form stays (a stale read keeps what is open), with what was typed; its Save is withheld because its write target is unknown.
      expect(document.querySelector('[data-task-form="edit"]')).not.toBeNull();
      expect(name().value).toBe("Typed, not saved");
      const save = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Save"),
      );
      expect(save).toBeDefined();
      expect((save as HTMLButtonElement).disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Atlas couldn't read the tasks saved on this device.",
      );
    },
  );
});

describe("Q12 (caller): a queue write between two pages of the outstanding work (no content revision moves) is never published as a day", () => {
  // The reader must not rely on what today's writers happen to do to the queue's order: a draft that moves to an EARLIER place between the
  // two pages is in neither of them, so its evidence would be missing. (Counting one twice is harmless: pending entries are kept by id.)
  for (const between of [true, false])
    test(
      `between=${between}: two drafts that swap places across the page boundary are each counted, none missed`,
      SLOW,
      async () => {
        // 119 queued records of 1 and a last one of 5 against a minimum of 124: Done. A read that missed the last one (or counted another
        // twice in its place) would say To do.
        const task = await seededTask({
          definition: {
            goal: {
              kind: "numeric",
              minimum: "124",
              maximum: null,
              unit: "cups",
            },
          },
          progress: {
            action: { outcome: "incomplete", amount: "0", checked: [] },
            period: { outcome: "incomplete", amount: "0", checked: [] },
          },
        });
        const t = await mountTasks({
          path: ELSEWHERE,
          rows: task.rows,
          env: { online: false },
        });
        await t.commitSync([]);
        const outbox = t.data.outbox();
        if (!outbox) throw new Error("setup: no outbox");
        await act(async () => {
          for (let i = 0; i < 120; i += 1) {
            const out = await outbox.enqueue(
              record({
                occurrenceId: task.occurrenceId,
                progressId: task.progressId,
                me: ME,
                entryId: crypto.randomUUID(),
                evidence: { kind: "quantity", amount: i === 119 ? "5" : "1" },
                happenedAt: Math.floor(Date.now() / 1000),
                firstAnyoneStream: false,
                defaults: null,
                replaces: null,
              }),
            );
            if (out.kind !== "queued")
              throw new Error(`setup: ${JSON.stringify(out)}`);
          }
        });
        await t.settle();
        const queue = t.drafts();
        const first = queue[queue.length - 1];
        const front = queue[0];
        if (!first || !front) throw new Error("setup: no draft");
        // One transaction that swaps the places of the LAST queued draft (on the second page) and the FIRST (on the first): it writes
        // `drafts` only, so no content revision moves; the store advances the composition generation.
        const move = {
          name: "test.swapDraftPlaces",
          scope: ["drafts", "sync_state"] as const,
          mode: "readwrite" as const,
          durability: "strict" as const,
          read: async (reader: {
            get(store: "drafts", key: string): Promise<unknown>;
          }) => [
            await reader.get("drafts", first.local_id),
            await reader.get("drafts", front.local_id),
          ],
          decide: ([last, head]: unknown[]) => ({
            writes:
              last && head
                ? [
                    {
                      op: "put" as const,
                      store: "drafts" as const,
                      row: {
                        ...(last as object),
                        created_seq: front.created_seq,
                      },
                    },
                    {
                      op: "put" as const,
                      store: "drafts" as const,
                      row: {
                        ...(head as object),
                        created_seq: first.created_seq,
                      },
                    },
                  ]
                : [],
            result: null,
          }),
        };
        const service = t.data.service();
        if (!service) throw new Error("setup: no service");
        let moved = false;
        let pages = 0;
        const hold = holdAfterChange(t, () => moved);
        const spy = intercept(t, async (plan) => {
          // The SECOND page of the queue read for the day under test (an earlier day's read may still be finishing).
          if (
            between &&
            !moved &&
            plan === "data.readOutstandingByKind" &&
            t.router.state.location.href.includes(TODAY)
          ) {
            pages += 1;
            if (pages === 2) {
              moved = true;
              await service.store.run(move as never, null);
            }
            return;
          }
          await hold.before(plan);
        });

        await showDay(t, TODAY);
        if (between) {
          await t.until(() => hold.holding());
          await t.settle();
          expect(hold.holding()).toBe(true);
          // Nothing of the attempt that read the queue across the write is shown: it missed the last record.
          expect(row(task.occurrenceId)?.dataset.pill).not.toBe("to_do");
          hold.release();
        } else
          await act(async () => {
            await service.store.run(move as never, null);
          });
        await t.until(() => row(task.occurrenceId)?.dataset.pill === "done");
        await t.settle();
        spy.restore();
        expect(moved).toBe(between);
        expect(
          t.drafts().find((d) => d.local_id === first.local_id)?.created_seq,
        ).toBe(front.created_seq);
        expect(row(task.occurrenceId)?.dataset.pill).toBe("done");
      },
    );
});

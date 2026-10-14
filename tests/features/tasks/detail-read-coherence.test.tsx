/**
 * WEB-10a revision 4 (R9, `task-related-read-coherence`; design assessment C1, schedules D1–D4, D9): the task detail and the edit page
 * read the task, its details, the displayed day's selection and the day's inputs as ONE certified read, so a read that failed is never
 * taken for absence ("isn't on this device", "no day", "not available"), a failed refresh of a complete read keeps it visibly stale, and
 * Try again reads everything again, cold or warm. Each forced failure is placed at the store (the screens' reads are the production plans
 * over the IndexedDB double, intercepted by plan and input) and counted, with its healthy control.
 */
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
import * as copy from "../../../src/features/tasks/copy";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { progressId } from "../../../src/features/tasks/model/ids";
import { addDays } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import {
  ME,
  type Mounted,
  mountTasks,
  type SeededTask,
  seededTask,
  TODAY,
} from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const SLOW = { timeout: 30_000 };
const detail = () => document.querySelector("[data-task-detail]");
const absent = () =>
  document.querySelector('[data-task-detail="absent"]') !== null;
const recordCard = () => document.querySelector("[data-record-card]");
const tryAgain = (within_: Element | null) =>
  within_ === null
    ? null
    : within(within_ as HTMLElement).queryByRole("button", {
        name: copy.TRY_AGAIN,
      });

/**
 * Fails every run of the mounted store whose plan and input match `fails` (counted), until `restore()`. The detail's reads are all
 * imperative runs of the store (no live query), so this places the fault at the read itself.
 */
function failing(
  t: Mounted,
  fails: (plan: string, input: Record<string, unknown>) => boolean,
): { count(): number; restore(): void } {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  const store = service.store as { run: typeof service.store.run };
  const original = store.run.bind(service.store);
  let n = 0;
  store.run = (async (plan, input, options) => {
    if (fails(plan.name, input as Record<string, unknown>)) {
      n += 1;
      throw new StoreFailure("error");
    }
    return original(plan, input, options);
  }) as typeof service.store.run;
  return {
    count: () => n,
    restore: () => {
      store.run = original;
    },
  };
}

const ids = (input: Record<string, unknown>) =>
  (input.ids as string[] | undefined) ?? [];

async function enter(t: Mounted, path: string) {
  await act(async () => {
    await t.router.navigate({ to: path });
  });
}

/** Mounted on the task list (nothing of the task read yet), so a fault installed now is in place for the detail's first read. */
async function onList(task: SeededTask | null, rows?: CacheRow[]) {
  const t = await mountTasks({
    path: "/tasks",
    rows: rows ?? task?.rows ?? [],
    env: { online: false },
  });
  await t.commitSync([]);
  return t;
}

/** A task with `count` saved days (ids `occ(1..count)`, dated up to yesterday), each with my stream; its own `once` day is not saved. */
const occ = (i: number) =>
  `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`;
async function manyDays(count: number) {
  const task = await seededTask();
  const rows = task.rows.slice(0, 2);
  for (let i = 1; i <= count; i += 1) {
    const id = occ(i);
    rows.push({
      ...(task.rows[2] as CacheRow),
      id,
      value: {
        ...task.data,
        slot: {
          ...task.data.slot,
          key: `day-${i}`,
          date: addDays(TODAY, i - count),
        },
      } as never,
    });
    rows.push({
      ...(task.rows[3] as CacheRow),
      id: await progressId(id, ME),
      parent_id: id,
    });
  }
  return { task, rows };
}

describe("D1: a failed read of the task, its details or the queue at entry is an error with Try again, never absence", () => {
  const faults: Array<{
    name: string;
    fails: (
      task: SeededTask,
    ) => (plan: string, input: Record<string, unknown>) => boolean;
  }> = [
    {
      name: "the task",
      fails: (task) => (plan, input) =>
        plan === "data.readResourcesById" && ids(input).includes(task.taskId),
    },
    {
      name: "its details (execution)",
      fails: () => (plan, input) =>
        plan === "data.readResourceList" && input.kind === "execution",
    },
    {
      name: "the queue",
      fails: () => (plan) => plan === "data.readOutstandingByKind",
    },
  ];
  for (const fault of faults)
    for (const page of ["detail", "edit"] as const)
      test(`${fault.name}, ${page}`, SLOW, async () => {
        const task = await seededTask();
        const t = await onList(task);
        const fault_ = failing(t, fault.fails(task));
        await enter(
          t,
          page === "detail"
            ? `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`
            : `/tasks/${task.taskId}/edit`,
        );
        const marker =
          page === "detail"
            ? "[data-detail-row-error]"
            : "[data-task-edit-error]";
        await t.until(() => document.querySelector(marker) !== null);
        await t.settle();
        expect(fault_.count()).toBeGreaterThan(0);
        expect(
          document.querySelector(marker)?.getAttribute(marker.slice(1, -1)),
        ).toBe("failed");
        expect(absent()).toBe(false);
        expect(document.body.textContent).not.toContain(DETAIL_COPY.absent);
        expect(document.body.textContent).not.toContain(copy.NO_DATABASE);
        expect(document.querySelector("[data-no-occurrence]")).toBeNull();
        expect(document.querySelector("[data-day-unavailable]")).toBeNull();
        // Try again reads everything again: the task and its day come back, and the notice goes.
        fault_.restore();
        const again = tryAgain(document.querySelector(marker));
        expect(again).not.toBeNull();
        expect((again as HTMLButtonElement).disabled).toBe(false);
        await act(async () => {
          fireEvent.click(again as HTMLElement);
        });
        await t.until(() =>
          page === "detail"
            ? recordCard() !== null
            : document.querySelector('[data-task-form="edit"]') !== null,
        );
        expect(document.querySelector(marker)).toBeNull();
        if (page === "detail") expect(recordCard()).not.toBeNull();
        else
          expect(
            document.querySelector('[data-task-form="edit"]'),
          ).not.toBeNull();
      });

  test(
    "control: a healthy read of a task that is not on this device says so (detail and edit), with no fault",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await onList(null);
      await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      await t.until(absent);
      expect(absent()).toBe(true);
      expect(document.querySelector("[data-detail-row-error]")).toBeNull();
      await enter(t, `/tasks/${task.taskId}/edit`);
      await t.until(
        () => document.body.textContent?.includes(DETAIL_COPY.absent) === true,
      );
      expect(document.body.textContent).toContain(DETAIL_COPY.absent);
      expect(document.querySelector("[data-task-edit-error]")).toBeNull();
    },
  );

  test(
    "control: a healthy read of a saved task shows it and its day",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await onList(task);
      await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      await t.until(() => recordCard() !== null);
      expect(recordCard()).not.toBeNull();
      expect(document.querySelector("[data-detail-row-error]")).toBeNull();
      expect(document.querySelector("[data-detail-row-stale]")).toBeNull();
    },
  );
});

describe("D2: a failed read while choosing the day is an error, never 'unavailable', 'no day' or another day", () => {
  test("the day named in the address", SLOW, async () => {
    const task = await seededTask();
    const t = await onList(task);
    const fault = failing(
      t,
      (plan, input) =>
        plan === "data.readResourcesById" &&
        ids(input).length === 1 &&
        ids(input)[0] === task.occurrenceId,
    );
    await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
    await t.until(
      () => document.querySelector("[data-detail-row-error]") !== null,
    );
    expect(fault.count()).toBeGreaterThan(0);
    expect(document.querySelector("[data-day-unavailable]")).toBeNull();
    expect(recordCard()).toBeNull();
    fault.restore();
  });

  test(
    "today's day (read by its own id), without a day in the address",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await onList(task);
      const fault = failing(
        t,
        (plan, input) =>
          plan === "data.readResourcesById" &&
          ids(input).length === 1 &&
          ids(input)[0] === task.occurrenceId,
      );
      await enter(t, `/tasks/${task.taskId}`);
      await t.until(
        () => document.querySelector("[data-detail-row-error]") !== null,
      );
      expect(fault.count()).toBeGreaterThan(0);
      expect(document.querySelector("[data-no-occurrence]")).toBeNull();
      fault.restore();
    },
  );

  test(
    "the walk over every saved day (today's is not on this device): a later window of it fails",
    SLOW,
    async () => {
      // 101 saved days, none of them today's: the latest is found by the walk, whose SECOND window (after the first 100 by id) fails. The
      // picker's first page (read without a cursor) is read whole, so only the walk meets the fault.
      const { task, rows } = await manyDays(101);
      const t = await onList(null, rows);
      const fault = failing(
        t,
        (plan, input) =>
          plan === "data.readResourceList" &&
          input.kind === "occurrence" &&
          typeof input.after === "string",
      );
      await enter(t, `/tasks/${task.taskId}`);
      await t.until(
        () => document.querySelector("[data-detail-row-error]") !== null,
      );
      expect(fault.count()).toBeGreaterThan(0);
      expect(document.querySelector("[data-detail-row-error]")).not.toBeNull();
      expect(recordCard()).toBeNull();
      expect(document.querySelector("[data-no-occurrence]")).toBeNull();
      // Control, same page: the walk restored, Try again finds the latest day (the 101st, dated yesterday).
      fault.restore();
      await act(async () => {
        fireEvent.click(
          tryAgain(
            document.querySelector("[data-detail-row-error]"),
          ) as HTMLElement,
        );
      });
      await t.until(() => recordCard() !== null);
      expect(recordCard()).not.toBeNull();
      expect(
        (
          document.querySelector(
            "[data-day-picker] select",
          ) as HTMLSelectElement
        ).value,
      ).toBe(occ(101));
    },
  );
});

describe("D3/D4: a failed refresh of a complete read keeps it, stale, with Try again (warm); the cold error has Try again too", () => {
  for (const failure of ["the basis", "the day's rows"] as const)
    test(`warm: ${failure} fails on a refresh`, SLOW, async () => {
      const task = await seededTask();
      const t = await onList(task);
      await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      await t.until(() => recordCard() !== null);
      const fault = failing(t, (plan, input) =>
        failure === "the basis"
          ? plan === "data.readLocalBasis"
          : plan === "data.readResourcesById" &&
            ids(input).includes(task.progressId),
      );
      await t.commitSync([
        { ...(task.rows[0] as CacheRow), label: "Renamed", version: 2 },
      ]);
      await t.until(
        () => document.querySelector("[data-detail-row-stale]") !== null,
      );
      expect(fault.count()).toBeGreaterThan(0);
      const stale = document.querySelector("[data-detail-row-stale]");
      expect(stale?.getAttribute("data-detail-row-stale")).toBe("failed");
      // What was read last is kept (stale), never emptied.
      expect(recordCard()).not.toBeNull();
      expect(document.querySelector("h1")?.textContent).toBe(
        "Brush your teeth",
      );
      const again = tryAgain(stale);
      expect(again).not.toBeNull();
      fault.restore();
      await act(async () => {
        fireEvent.click(again as HTMLElement);
      });
      await t.until(
        () => document.querySelector("[data-detail-row-stale]") === null,
      );
      expect(document.querySelector("[data-detail-row-stale]")).toBeNull();
      expect(document.querySelector("h1")?.textContent).toBe("Renamed");
    });

  test(
    "control: a refresh that succeeds shows the new read with no notice",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await onList(task);
      await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      await t.until(() => recordCard() !== null);
      await t.commitSync([
        { ...(task.rows[0] as CacheRow), label: "Renamed", version: 2 },
      ]);
      await t.until(
        () => document.querySelector("h1")?.textContent === "Renamed",
      );
      expect(document.querySelector("h1")?.textContent).toBe("Renamed");
      expect(document.querySelector("[data-detail-row-stale]")).toBeNull();
    },
  );
});

describe("D9: the day picker's later page and the day's other streams", () => {
  const options = () =>
    [...(screen.getByLabelText(DETAIL_COPY.day) as HTMLSelectElement).options]
      .map((o) => o.value)
      .filter((v) => v !== "");

  test(
    "a later page that cannot be read says so with Try again; the day shown and its record card stay",
    SLOW,
    async () => {
      const { task, rows } = await manyDays(101);
      const t = await onList(null, rows);
      await enter(t, `/tasks/${task.taskId}?occurrence=${occ(1)}`);
      await t.until(() => recordCard() !== null);
      expect(options()).toHaveLength(100);
      const fault = failing(
        t,
        (plan, input) =>
          plan === "data.readResourceList" &&
          input.kind === "occurrence" &&
          typeof input.after === "string",
      );
      fireEvent.click(
        screen.getByRole("button", { name: DETAIL_COPY.moreDays }),
      );
      await t.until(
        () => document.querySelector("[data-day-picker-error]") !== null,
      );
      expect(fault.count()).toBeGreaterThan(0);
      const error = document.querySelector("[data-day-picker-error]");
      expect(error?.getAttribute("data-day-picker-error")).toBe("failed");
      // Unknown is not "no more days", and the card stays on the day in the address.
      expect(recordCard()).not.toBeNull();
      expect(
        (screen.getByLabelText(DETAIL_COPY.day) as HTMLSelectElement).value,
      ).toBe(occ(1));
      fault.restore();
      await act(async () => {
        fireEvent.click(tryAgain(error) as HTMLElement);
      });
      await t.until(() => options().includes(occ(101)));
      expect(options()).toContain(occ(101));
      expect(document.querySelector("[data-day-picker-error]")).toBeNull();
    },
  );

  test(
    "the day's progress streams are read whole in the same read: a failed page of them is an error, never 'nobody else'",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await onList(task);
      const fault = failing(
        t,
        (plan, input) =>
          plan === "data.readResourceList" && input.kind === "progress",
      );
      await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      await t.until(
        () => document.querySelector("[data-detail-row-error]") !== null,
      );
      expect(fault.count()).toBeGreaterThan(0);
      expect(document.querySelector("[data-participation]")).toBeNull();
      fault.restore();
    },
  );
});

describe("the default day is chosen once for the visit", () => {
  test(
    "a later day synced while the page is open does not move the day shown; the next visit chooses it",
    SLOW,
    async () => {
      const yesterday = addDays(TODAY, -2);
      const task = await seededTask({
        date: yesterday,
        definition: {
          schedule: {
            start_date: yesterday,
            time: null,
            timezone: "UTC",
            repeat: { frequency: "daily", interval: 1 },
          } as never,
        },
      });
      const t = await onList(task);
      await enter(t, `/tasks/${task.taskId}`);
      await t.until(() => recordCard() !== null);
      const select = () =>
        document.querySelector(
          "[data-day-picker] select",
        ) as HTMLSelectElement | null;
      // One saved day: no picker yet; the record card is for it.
      expect(select()).toBeNull();
      // A later day (not today's slot: yesterday's) arrives by sync while the detail is open.
      const later = {
        ...(task.rows[2] as CacheRow),
        id: "eeeeeeee-0000-4000-8000-0000000000aa",
        value: {
          ...task.data,
          slot: {
            ...task.data.slot,
            key: "later",
            date: addDays(TODAY, -1),
          },
        } as never,
      };
      await t.commitSync([later]);
      await t.until(() => select() !== null);
      // The picker now lists both days; the one shown is still the one this visit chose.
      expect(select()?.value).toBe(task.occurrenceId);
      // The next visit chooses again: the later day.
      await enter(t, "/tasks");
      await enter(t, `/tasks/${task.taskId}`);
      await t.until(() => select()?.value === later.id);
      expect(select()?.value).toBe(later.id);
      expect(detail()).not.toBeNull();
    },
  );
});

describe("X2: the read error states are accessible (jsdom layer; no manual assistive-technology claim)", () => {
  test(
    "the cold error and the stale detail have no axe violations; Try again is a button in the tab order",
    SLOW,
    async () => {
      const { axe } = await import("jest-axe");
      const task = await seededTask();
      const t = await onList(task);
      const fault = failing(
        t,
        (plan, input) =>
          plan === "data.readResourcesById" && ids(input).includes(task.taskId),
      );
      await enter(t, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      await t.until(
        () => document.querySelector("[data-detail-row-error]") !== null,
      );
      const cold = tryAgain(document.querySelector("[data-detail-row-error]"));
      expect(cold?.tagName).toBe("BUTTON");
      expect(cold?.tabIndex).toBe(0);
      expect((await axe(document.body)).violations).toEqual([]);
      fault.restore();
      await act(async () => {
        fireEvent.click(cold as HTMLElement);
      });
      await t.until(() => recordCard() !== null);
      const basis = failing(t, (plan) => plan === "data.readLocalBasis");
      await t.commitSync([
        { ...(task.rows[0] as CacheRow), label: "Renamed", version: 2 },
      ]);
      await t.until(
        () => document.querySelector("[data-detail-row-stale]") !== null,
      );
      const warm = tryAgain(document.querySelector("[data-detail-row-stale]"));
      expect(warm?.tabIndex).toBe(0);
      expect((await axe(document.body)).violations).toEqual([]);
      basis.restore();
    },
  );
});

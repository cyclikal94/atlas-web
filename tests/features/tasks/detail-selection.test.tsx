import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import * as copy from "../../../src/features/tasks/copy";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { progressId } from "../../../src/features/tasks/model/ids";
import { addDays } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, mountTasks, seededTask, TODAY } from "../../support/tasks/world";

/**
 * R1 (review of 13 October 2026, family `task-occurrence-selection-truncated-page`): which day the task detail shows, and records
 * against. An `occurrence` in the address is resolved by its OWN id and must be one of this task's; it is never replaced by another day
 * (today's, or the last of a page) when it is beyond the first page of saved days, absent, or another task's. Without one, today's slot
 * is read by id and the latest by date is taken over EVERY saved day. The picker pages through all of them. FIXTURE evidence (the
 * production controller and plans over the IndexedDB double).
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const occ = (i: number) =>
  `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`;
type Seeded = Awaited<ReturnType<typeof seededTask>>;

/** A task with `count` saved days (ids `occ(1..count)`, so 1..100 are the first page by id and 101.. the next), each with my stream. */
async function manyDays(
  count: number,
  date: (i: number) => string | null = () => TODAY,
): Promise<{ task: Seeded; rows: CacheRow[] }> {
  const task = await seededTask();
  // Without the task's own `once` occurrence: today's deterministic slot is then NOT on the device.
  const rows = task.rows.slice(0, 2);
  for (let i = 1; i <= count; i += 1) {
    const id = occ(i);
    const day = date(i);
    rows.push({
      ...(task.rows[2] as CacheRow),
      id,
      value: {
        ...task.data,
        slot: { ...task.data.slot, key: `day-${i}`, date: day },
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

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const recordCard = () =>
  document.querySelector("[data-record-card]") as HTMLElement | null;
const recorded = (t: Mounted) =>
  t
    .bodies()
    .filter((b) => b.command.command.kind === "record")
    .map((b) => b.command.command.occurrence_id);
const daySelect = () =>
  screen.getByLabelText(DETAIL_COPY.day) as HTMLSelectElement;

async function markDoneAt(t: Mounted): Promise<void> {
  await t.until(() => recordCard() !== null);
  const card = recordCard();
  expect(card).not.toBeNull();
  fireEvent.click(
    within(card as HTMLElement).getByRole("button", { name: copy.MARK_DONE }),
  );
  await t.settle();
}

describe("an occurrence named in the address is the one shown and recorded against", () => {
  test("control: a day on the first page of saved days", async () => {
    const { task, rows } = await manyDays(101);
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${occ(50)}`,
      rows,
      env: { online: false },
    });
    await markDoneAt(t);
    expect(daySelect().value).toBe(occ(50));
    expect(recorded(t)).toEqual([occ(50)]);
  });

  test("a day BEYOND the first page (the 101st by id) is shown and the record names it, never the 100th", async () => {
    const { task, rows } = await manyDays(101);
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${occ(101)}`,
      rows,
      env: { online: false },
    });
    await markDoneAt(t);
    expect(daySelect().value).toBe(occ(101));
    expect(recorded(t)).toEqual([occ(101)]);
  });

  test("a day that is not on this device shows that it is unavailable, offers nothing to record and saves nothing", async () => {
    const { task, rows } = await manyDays(3);
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${occ(999)}`,
      rows,
      env: { online: false },
    });
    await t.until(
      () => document.querySelector("[data-day-unavailable]") !== null,
    );
    expect(document.querySelector("[data-day-unavailable]")).toHaveTextContent(
      DETAIL_COPY.dayUnavailable,
    );
    expect(recordCard()).toBeNull();
    expect(screen.queryByRole("button", { name: copy.MARK_DONE })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Correct this day" }),
    ).toBeNull();
    expect(t.drafts()).toHaveLength(0);
    expect(
      screen.getByRole("link", { name: DETAIL_COPY.showDays }),
    ).toHaveAttribute("href", `/tasks/${task.taskId}`);
  });

  test("another task's day in this task's address is unavailable too: it is never recorded against", async () => {
    const mine = await manyDays(2);
    const other = await seededTask({ title: "Someone else's task" });
    const t = await mountTasks({
      path: `/tasks/${mine.task.taskId}?occurrence=${other.occurrenceId}`,
      rows: [...mine.rows, ...other.rows],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector("[data-day-unavailable]") !== null,
    );
    expect(recordCard()).toBeNull();
    expect(t.drafts()).toHaveLength(0);
  });
});

describe("without an occurrence in the address", () => {
  test("the latest day by date over EVERY saved day, though it is not on the first page", async () => {
    // Day i is dated i days before day 101 (the latest), which is the only one on the second page.
    const { task, rows } = await manyDays(101, (i) => addDays(TODAY, i - 101));
    const t = await mountTasks({
      path: `/tasks/${task.taskId}`,
      rows,
      env: { online: false },
    });
    await markDoneAt(t);
    expect(daySelect().value).toBe(occ(101));
    expect(recorded(t)).toEqual([occ(101)]);
  });

  test("today's deterministic slot is read by its id and shown", async () => {
    const task = await seededTask();
    const t = await mountTasks({
      path: `/tasks/${task.taskId}`,
      rows: task.rows,
      env: { online: false },
    });
    await markDoneAt(t);
    expect(recorded(t)).toEqual([task.occurrenceId]);
  });
});

describe("the day picker reaches every saved day (Q9)", () => {
  test("a page of 100 at a time: More saved days lists the next page; Previous saved days goes back", async () => {
    const { task, rows } = await manyDays(101, (i) => addDays(TODAY, i - 101));
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${occ(1)}`,
      rows,
      env: { online: false },
    });
    await t.until(() => recordCard() !== null);
    const options = () =>
      [...daySelect().options].map((o) => o.value).filter((v) => v !== "");
    expect(options()).toHaveLength(100);
    expect(options()).not.toContain(occ(101));
    const more = screen.queryByRole("button", { name: DETAIL_COPY.moreDays });
    expect(more).not.toBeNull();
    fireEvent.click(more as HTMLElement);
    await t.until(() => options().includes(occ(101)));
    expect(options()).toContain(occ(101));
    // The day shown stays the one in the address, listed while another page is open.
    expect(daySelect().value).toBe(occ(1));
    expect(
      screen.queryByRole("button", { name: DETAIL_COPY.moreDays }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: DETAIL_COPY.previousDays }),
    );
    await t.until(() => options().length === 100);
    expect(options()).toHaveLength(100);
    expect(options()).not.toContain(occ(101));
  });
});

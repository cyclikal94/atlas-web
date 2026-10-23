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
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  forgetKeptFixes,
  HISTORY_COPY,
} from "../../../src/features/tasks/detail/EntryHistory";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { DETAIL_COPY } from "../../../src/features/tasks/detail/TaskDetail";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import * as commands from "../../../src/features/tasks/model/commands";
import type { TaskDefinition } from "../../../src/features/tasks/model/contract";
import {
  occurrenceId,
  progressId,
} from "../../../src/features/tasks/model/ids";
import {
  addDays,
  slotOn,
  windows,
} from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import {
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * Revision 19 (design assessment of Review 19; family `task-sync-navigation-draft-loss`). FIXTURE evidence: the app's router (memory
 * history) over the PRODUCTION data controller and the IndexedDB double.
 *
 * DA19-I1 (`incomplete_fix` of R33; ia.md §1.3.3): the day the detail shows WITHOUT an occurrence in its address is part of the person's
 * draft. They type for that day, check the sync screens, and while they are there the default would move (a later day is synced: Q3a;
 * the task's clock passes midnight onto another saved day: Q3b). Coming back shows the SAME day and the same input, and an explicit save
 * names that day. Paired controls: with nothing typed the visit chooses afresh (the moved default); an explicit address is its own. When the
 * day itself is gone (Q4) the view says so and never shows, or records against, another day in its place.
 *
 * DA19-N1 (`new`): a fix kept through the visit is not leave to fix its old entry. Another tab queues a correction of that entry while the
 * person is away (Q6); the returned editor is readable with the person's value and its Save is refused by the same decision that hides
 * the entry's Fix, with no command added. Paired controls: no correction queued saves exactly once; discarding the queued correction gives a
 * fresh decision; the same correction queued while the editor stays mounted blocks it too.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetKept();
  forgetKeptFixes();
  forgetAllCorrections();
});

type Mounted = Awaited<ReturnType<typeof mountTasks>>;

const detailShown = () => document.querySelector("[data-task-detail]") !== null;
const recordCard = () => document.querySelector("[data-record-card]");
const daySelect = () =>
  document.querySelector(
    "[data-day-picker] select",
  ) as HTMLSelectElement | null;
function field(label: string): HTMLInputElement {
  const found = screen.queryByLabelText(label, { exact: true });
  expect(found, `the field "${label}"`).not.toBeNull();
  return found as HTMLInputElement;
}
function button(name: string): HTMLButtonElement {
  const found = screen.queryByRole("button", { name });
  expect(found, `the button "${name}"`).not.toBeNull();
  return found as HTMLButtonElement;
}
const press = (name: string) => fireEvent.click(button(name));
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

async function toSync(t: Mounted) {
  await act(async () => {
    await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe("/sync");
}
async function back(t: Mounted, expected: string) {
  await act(async () => {
    t.router.history.back();
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(expected);
}

const amount = `${RECORD_COPY.amount} (cups)`;
const newValue = `${HISTORY_COPY.newValue} (cups)`;
const ENTRY = "80000000-0000-4000-8000-0000000000e1";
const entry = (amountText: string) => ({
  id: ENTRY,
  evidence: { kind: "quantity", amount: amountText },
  happened_at: Math.floor(Date.now() / 1000),
  recorded_by: ME,
});

/** A daily task counting cups from `start`, its first day saved with my stream (one recent entry of 1 cup), open for five days after. */
function dailyCups(start: string): Promise<SeededTask> {
  return seededTask({
    date: start,
    definition: {
      schedule: {
        start_date: start,
        time: null,
        timezone: "UTC",
        repeat: { frequency: "daily", interval: 1 },
      } as never,
      goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      close_days_after: 5,
    },
    progress: {
      recent_entries: [entry("1")] as never,
      entry_count: 1,
      action: { outcome: "incomplete", amount: "1", checked: [] },
    },
  });
}

/** Another saved day of the task (`id`, dated `date`), with my empty stream there. */
async function anotherDay(
  task: SeededTask,
  id: string,
  date: string,
  key = `day-${date}`,
): Promise<CacheRow[]> {
  const slot = { ...task.data.slot, key, date };
  const w = windows(slot, task.data.definition);
  return [
    {
      ...(task.rows[2] as CacheRow),
      id,
      value: {
        ...task.data,
        slot,
        opens_at: w.opens_at,
        closes_at: w.closes_at,
      } as never,
    },
    {
      ...(task.rows[3] as CacheRow),
      id: await progressId(id, ME),
      parent_id: id,
      value: {
        ...((task.rows[3] as CacheRow).value as object),
        recent_entries: [],
        entry_count: 0,
        action: { outcome: "unknown", amount: null, checked: [] },
      } as never,
    },
  ];
}

const records = (t: Mounted) =>
  t
    .bodies()
    .map((b) => b.command.command)
    .filter((c) => c.kind === "record");

describe("DA19-I1 Q3a: a later day synced while the person is in the sync screens", () => {
  const LATER = "eeeeeeee-0000-4000-8000-0000000000b1";
  /** Day A (two days ago) is the only saved day, so it is the default; the visit to the sync screens brings day B (yesterday). */
  async function open() {
    const task = await dailyCups(addDays(TODAY, -2));
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => recordCard() !== null);
    // One saved day: no picker; the card is day A's.
    expect(daySelect()).toBeNull();
    const later = await anotherDay(task, LATER, addDays(TODAY, -1));
    const away = async () => {
      await toSync(t);
      await t.commitSync(later);
      await back(t, path);
      await t.until(() => detailShown() && daySelect() !== null);
    };
    return { t, task, away };
  }

  test("the amount typed for day A is shown on day A after the visit, and its save names day A", async () => {
    const { t, task, away } = await open();
    type(amount, "7");
    await away();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7");
    expect(records(t)).toEqual([]);
    press("Record");
    await t.until(() => records(t).length === 1);
    expect(records(t)).toEqual([
      expect.objectContaining({
        occurrence_id: task.occurrenceId,
        evidence: { kind: "quantity", amount: "7" },
      }),
    ]);
  });

  test("the fix typed on day A is open again on day A after the visit; nothing is queued", async () => {
    const { t, task, away } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "4");
    await away();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(newValue).value).toBe("4");
    expect(records(t)).toEqual([]);
  });

  test("the correction kept by the dialog's sync control is resumed from day A's trigger after the visit", async () => {
    const { t, task, away } = await open();
    press(CORRECTION_COPY.open);
    const dialog = () => screen.queryByRole("dialog");
    await t.until(() => dialog() !== null);
    const minimum = () =>
      within(dialog() as HTMLElement).getByLabelText(
        CORRECTION_COPY.minimum,
      ) as HTMLInputElement;
    fireEvent.change(minimum(), { target: { value: "12" } });
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    // The in-dialog sync control keeps the correction and closes the dialog; the shell then shows the queue.
    fireEvent.click(chip as HTMLElement);
    await t.until(() => dialog() === null);
    await away();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("12");
    expect(t.bodies()).toEqual([]);
  });

  test("control: with nothing typed, the visit chooses afresh: the later day", async () => {
    const { t, away } = await open();
    await away();
    await t.until(() => daySelect()?.value === LATER);
    expect(daySelect()?.value).toBe(LATER);
    expect(field(amount).value).toBe("");
  });

  test("control: a day named in the address is the address's, input or not", async () => {
    const task = await dailyCups(addDays(TODAY, -2));
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path: `${path}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => recordCard() !== null);
    type(amount, "7");
    await toSync(t);
    await t.commitSync(await anotherDay(task, LATER, addDays(TODAY, -1)));
    await back(t, path);
    await t.until(() => detailShown() && daySelect() !== null);
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7");
  });
});

describe("DA19-I1 Q3b: the task's day changes at midnight while the person is in the sync screens", () => {
  /** Day A is today's slot, day B tomorrow's; both are saved. The clock is the task zone's (UTC). */
  async function open() {
    const task = await dailyCups(TODAY);
    const def = task.data.definition as TaskDefinition;
    const tomorrow = addDays(TODAY, 1);
    const slot = slotOn(def.schedule, tomorrow);
    const dayB = await occurrenceId(task.taskId, slot.key);
    const rowsB = await anotherDay(task, dayB, tomorrow, slot.key);
    let shift = 0;
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path,
      rows: [...task.rows, ...rowsB],
      env: { online: false, now: () => Date.now() + shift },
    });
    await t.until(() => recordCard() !== null && daySelect() !== null);
    expect(daySelect()?.value).toBe(task.occurrenceId);
    const away = async () => {
      await toSync(t);
      // Midnight in the task's zone passes while the person is in the queue: tomorrow's slot is today's now.
      shift = 24 * 60 * 60 * 1000;
      await back(t, path);
      await t.until(() => detailShown() && recordCard() !== null);
    };
    return { t, task, dayB, away };
  }

  test("the amount typed for day A is shown on day A after midnight, and its save names day A", async () => {
    const { t, task, away } = await open();
    type(amount, "7");
    await away();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7");
    press("Record");
    await t.until(() => records(t).length === 1);
    expect(records(t)).toEqual([
      expect.objectContaining({
        occurrence_id: task.occurrenceId,
        evidence: { kind: "quantity", amount: "7" },
      }),
    ]);
  });

  test("control: with nothing typed, the visit after midnight shows the new day", async () => {
    const { t, dayB, away } = await open();
    await away();
    await t.until(() => daySelect()?.value === dayB);
    expect(daySelect()?.value).toBe(dayB);
    expect(field(amount).value).toBe("");
    expect(records(t)).toEqual([]);
  });
});

describe("DA19-I1 Q4: the day kept with the input is gone when the person comes back", () => {
  test("the view says the day is unavailable, offers nothing to record and moves the input to no other day", async () => {
    const LATER = "eeeeeeee-0000-4000-8000-0000000000b2";
    const task = await dailyCups(addDays(TODAY, -2));
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => recordCard() !== null);
    type(amount, "7");
    await toSync(t);
    // While the person is away, day A leaves this device and day B arrives.
    await t.commitSync(await anotherDay(task, LATER, addDays(TODAY, -1)), [
      task.occurrenceId,
    ]);
    await back(t, path);
    await t.until(
      () => document.querySelector("[data-day-unavailable]") !== null,
    );
    expect(recordCard()).toBeNull();
    expect(records(t)).toEqual([]);
    // Choosing again shows the default day (B), with nothing of day A's input in it.
    press(DETAIL_COPY.showDays);
    await t.until(() => recordCard() !== null);
    // The control is gone with the unavailable day: focus goes to the day's record card, not to the page's body.
    expect(document.activeElement).toBe(recordCard());
    expect(daySelect()).toBeNull();
    expect(field(amount).value).toBe("");
    expect(records(t)).toEqual([]);
  });
});

describe("DA19-N1 Q6: a correction of the entry queued by another tab", () => {
  /** A one-off day with my recent entry E (1 cup), shown by its address. */
  async function open() {
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      },
      progress: {
        recent_entries: [entry("1")] as never,
        entry_count: 1,
        action: { outcome: "incomplete", amount: "1", checked: [] },
      },
    });
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path: `${path}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(
      () => detailShown() && document.querySelector("[data-entry]") !== null,
    );
    return { t, task, path };
  }
  /** Another tab of the same account queues a fix of E (5 cups) into the shared account database. */
  async function otherTabFixes(
    t: Mounted,
    task: SeededTask,
    entryId: string = crypto.randomUUID(),
  ): Promise<string> {
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    let localId = "";
    await act(async () => {
      const outcome = await outbox.enqueue(
        commands.record({
          occurrenceId: task.occurrenceId,
          progressId: task.progressId,
          me: ME,
          entryId,
          evidence: { kind: "quantity", amount: "5" },
          happenedAt: Math.floor(Date.now() / 1000),
          replaces: ENTRY,
          firstAnyoneStream: false,
          defaults: null,
        }),
      );
      if (outcome.kind !== "queued") throw new Error(`setup: ${outcome.kind}`);
      localId = outcome.localId;
    });
    await t.settle();
    return localId;
  }
  const queuedFixShown = () =>
    document.querySelector("[data-entry-pending]") !== null;

  test("kept through the visit: the editor is back with 7, its Save is refused and no command is added", async () => {
    const { t, task, path } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await toSync(t);
    await otherTabFixes(t, task);
    await back(t, path);
    // The returned detail's own read shows the other tab's queued fix (the reader knows it) before anything is pressed.
    await t.until(() => detailShown() && queuedFixShown());
    expect(records(t)).toHaveLength(1);
    expect(field(newValue).value).toBe("7");
    const save = button(HISTORY_COPY.fixSave);
    expect(save.disabled).toBe(true);
    expect(screen.getByText(HISTORY_COPY.correctedSince)).not.toBeNull();
    fireEvent.click(save);
    await t.settle();
    expect(records(t)).toEqual([
      expect.objectContaining({
        replaces: ENTRY,
        evidence: { kind: "quantity", amount: "5" },
      }),
    ]);
  });

  test("control: with nothing kept, the corrected entry offers no Fix", async () => {
    const { t, task } = await open();
    expect(screen.queryByRole("button", { name: HISTORY_COPY.fix })).not.toBe(
      null,
    );
    await otherTabFixes(t, task);
    await t.until(queuedFixShown);
    expect(screen.queryByRole("button", { name: HISTORY_COPY.fix })).toBeNull();
  });

  test("control: with no correction queued, the kept fix saves exactly once, replacing E with 7", async () => {
    const { t, path } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await toSync(t);
    await back(t, path);
    await t.until(detailShown);
    expect(field(newValue).value).toBe("7");
    press(HISTORY_COPY.fixSave);
    await t.until(() => records(t).length === 1);
    expect(records(t)).toEqual([
      expect.objectContaining({
        replaces: ENTRY,
        evidence: { kind: "quantity", amount: "7" },
      }),
    ]);
  });

  test("recovery: the other tab's correction discarded, the decision is taken again and the kept fix saves once", async () => {
    const { t, task, path } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await toSync(t);
    const queued = await otherTabFixes(t, task);
    await back(t, path);
    await t.until(() => detailShown() && queuedFixShown());
    expect(button(HISTORY_COPY.fixSave).disabled).toBe(true);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    await act(async () => {
      const outcome = await outbox.discard(queued as never);
      expect(outcome.kind).toBe("discarded");
    });
    await t.until(() => !queuedFixShown());
    expect(records(t)).toEqual([]);
    expect(field(newValue).value).toBe("7");
    press(HISTORY_COPY.fixSave);
    await t.until(() => records(t).length === 1);
    expect(records(t)).toEqual([
      expect.objectContaining({
        replaces: ENTRY,
        evidence: { kind: "quantity", amount: "7" },
      }),
    ]);
  });

  test("control: a correction queued for ANOTHER entry does not block the kept fix of E", async () => {
    const OTHER_ENTRY = "80000000-0000-4000-8000-0000000000e2";
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      },
      progress: {
        recent_entries: [
          entry("1"),
          { ...entry("2"), id: OTHER_ENTRY },
        ] as never,
        entry_count: 2,
        action: { outcome: "incomplete", amount: "3", checked: [] },
      },
    });
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path: `${path}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(
      () =>
        detailShown() &&
        document.querySelector(`[data-entry="${ENTRY}"]`) !== null,
    );
    fireEvent.click(
      within(
        document.querySelector(`[data-entry="${ENTRY}"]`) as HTMLElement,
      ).getByRole("button", { name: HISTORY_COPY.fix }),
    );
    type(newValue, "7");
    await toSync(t);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    await act(async () => {
      const outcome = await outbox.enqueue(
        commands.record({
          occurrenceId: task.occurrenceId,
          progressId: task.progressId,
          me: ME,
          entryId: crypto.randomUUID(),
          evidence: { kind: "quantity", amount: "5" },
          happenedAt: Math.floor(Date.now() / 1000),
          replaces: OTHER_ENTRY,
          firstAnyoneStream: false,
          defaults: null,
        }),
      );
      expect(outcome.kind).toBe("queued");
    });
    await back(t, path);
    await t.until(() => detailShown() && queuedFixShown());
    expect(field(newValue).value).toBe("7");
    press(HISTORY_COPY.fixSave);
    await t.until(() => records(t).length === 2);
    expect(records(t)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          replaces: ENTRY,
          evidence: { kind: "quantity", amount: "7" },
        }),
      ]),
    );
  });

  test("the same correction queued while the editor stays mounted blocks its Save too", async () => {
    const { t, task } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    expect(button(HISTORY_COPY.fixSave).disabled).toBe(false);
    await otherTabFixes(t, task);
    await t.until(queuedFixShown);
    expect(field(newValue).value).toBe("7");
    const save = button(HISTORY_COPY.fixSave);
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await t.settle();
    expect(records(t)).toHaveLength(1);
  });

  test("a Save handler taken while Save was enabled queues nothing once the other tab's fix of E is known (the save decision at the press)", async () => {
    const { t, task } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    const save = button(HISTORY_COPY.fixSave);
    expect(save.disabled).toBe(false);
    // A stale callback (or programmatic activation): React's own click handler of the enabled Save.
    const key = Object.keys(save).find((k) => k.startsWith("__reactProps$"));
    const handler = (
      save as unknown as Record<string, { onClick?: () => void }>
    )[key ?? ""]?.onClick;
    expect(typeof handler).toBe("function");
    await otherTabFixes(t, task);
    await t.until(queuedFixShown);
    await act(async () => {
      handler?.();
    });
    await t.settle();
    expect(records(t)).toHaveLength(1);
    expect(field(newValue).value).toBe("7");
  });

  test("the queued correction's own entry already among the recent entries: E is still known corrected and offers no Fix", async () => {
    const CORRECTION = "80000000-0000-4000-8000-0000000000c1";
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      },
      progress: {
        recent_entries: [
          entry("1"),
          { ...entry("5"), id: CORRECTION },
        ] as never,
        entry_count: 2,
        action: { outcome: "incomplete", amount: "6", checked: [] },
      },
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    const fixOf = (id: string) => {
      const li = document.querySelector(`[data-entry="${id}"]`);
      return li === null
        ? null
        : within(li as HTMLElement).queryByRole("button", {
            name: HISTORY_COPY.fix,
          });
    };
    await t.until(() => detailShown() && fixOf(ENTRY) !== null);
    // The correction's record is still queued (its send not yet acknowledged) while its entry has reached the recent tail.
    await otherTabFixes(t, task, CORRECTION);
    await t.until(() => fixOf(ENTRY) === null);
    expect(fixOf(ENTRY)).toBeNull();
    expect(records(t)).toHaveLength(1);
  });
});

/** Holds every write the screens queue until the gate opens; then the outbox's own result, or `refused` when `refuse` is set. */
function holdWrites(t: Mounted, refuse = false) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const enqueue = outbox.enqueue.bind(outbox);
  outbox.enqueue = async (request) => {
    await gate;
    return refuse ? { kind: "refused", reason: "quota" } : enqueue(request);
  };
  return { open: () => act(async () => open()) };
}

/**
 * Revision 20 (design assessment of Review 20, DA20-I1, `incomplete_fix` of R33/DA19-I1; ia.md §1.3.3). Revision 19 protected a day that
 * was gone when the person came back; this is the day leaving LATER, after the restored editor mounted (another tab's committed sync page,
 * or this tab's). The visit's day and the input typed for it have one lifetime: the view says the day is unavailable, never shows or records
 * against another day in its place, and the editors' input (amount, fix, correction, a save still pending) is not lost when the data hides
 * them; the day back, the same raw input is there, and only an explicit save writes, naming that day. Day B (an earlier saved day) is
 * the fallback the old code chose. Paired controls: day A still present; nothing typed; choosing again; another identity.
 */
describe("DA20-I1: the visit's day leaves after the person came back", () => {
  const EARLIER = "eeeeeeee-0000-4000-8000-0000000000b3";
  const unavailable = () =>
    document.querySelector("[data-day-unavailable]") !== null;
  const dialog = () => screen.queryByRole("dialog");
  const minimum = () =>
    within(dialog() as HTMLElement).getByLabelText(
      CORRECTION_COPY.minimum,
    ) as HTMLInputElement;
  /** Day A (two days ago, my entry E there) is the default: the latest saved day. Day B (three days ago) is saved too. */
  async function open(explicit = false) {
    const task = await dailyCups(addDays(TODAY, -2));
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path: explicit ? `${path}?occurrence=${task.occurrenceId}` : path,
      rows: [
        ...task.rows,
        ...(await anotherDay(task, EARLIER, addDays(TODAY, -3))),
      ],
      env: { online: false },
    });
    await t.until(
      () => recordCard() !== null && daySelect()?.value === task.occurrenceId,
    );
    expect(daySelect()?.value).toBe(task.occurrenceId);
    /** To the sync screens and back, day A still here: the input is restored on day A. */
    const away = async () => {
      await toSync(t);
      await back(t, path);
      await t.until(() => detailShown() && recordCard() !== null);
      expect(daySelect()?.value).toBe(task.occurrenceId);
    };
    /** A committed page removes day A (B stays); the zero-delay releases of the hidden editors are drained by `settle`. */
    const removeA = async () => {
      await t.commitSync([], [task.occurrenceId]);
      expect(unavailable(), "day A is said to be unavailable").toBe(true);
      await t.settle();
    };
    const restoreA = async () => {
      await t.commitSync([task.rows[2] as CacheRow]);
      await t.until(() => recordCard() !== null);
    };
    return { t, task, path, away, removeA, restoreA };
  }
  /** Day A is gone: the view says so; no day (and so not B) is shown, nothing can be recorded, nothing was. */
  function saysUnavailable(t: Mounted) {
    expect(unavailable()).toBe(true);
    expect(recordCard()).toBeNull();
    expect(daySelect()?.value ?? "").not.toBe(EARLIER);
    expect(screen.queryByText(HISTORY_COPY.fix)).toBeNull();
    expect(t.bodies()).toEqual([]);
  }

  test("the amount restored after the visit: day A leaves, the view says so; A back, the same raw amount, and its save names A once", async () => {
    const { t, task, away, removeA, restoreA } = await open();
    type(amount, "7.125");
    await away();
    expect(field(amount).value).toBe("7.125");
    await removeA();
    saysUnavailable(t);
    await restoreA();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
    press("Record");
    await t.until(() => records(t).length === 1);
    expect(records(t)).toEqual([
      expect.objectContaining({
        occurrence_id: task.occurrenceId,
        evidence: { kind: "quantity", amount: "7.125" },
      }),
    ]);
  });

  test("the fix open again after the visit keeps its value through day A leaving and coming back; nothing is queued", async () => {
    const { t, task, away, removeA, restoreA } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "4.5");
    await away();
    expect(field(newValue).value).toBe("4.5");
    await removeA();
    saysUnavailable(t);
    await restoreA();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    await t.until(() => screen.queryByLabelText(newValue) !== null);
    expect(field(newValue).value).toBe("4.5");
    expect(t.bodies()).toEqual([]);
  });

  test("the correction reopened after the visit keeps its value through day A leaving and coming back; nothing is queued", async () => {
    const { t, task, away, removeA, restoreA } = await open();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    fireEvent.change(minimum(), { target: { value: "12" } });
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    fireEvent.click(chip as HTMLElement);
    await t.until(() => dialog() === null);
    await away();
    // Reopened: the session is the dialog's again (no longer only retained).
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("12");
    await removeA();
    expect(dialog()).toBeNull();
    saysUnavailable(t);
    await restoreA();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    // The dialog the person had open for day A is open again, with what they typed.
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("12");
    expect(t.bodies()).toEqual([]);
  });

  test("not only after a visit: an amount typed on the shown default day survives that day leaving and coming back", async () => {
    const { t, task, removeA, restoreA } = await open();
    type(amount, "7.125");
    await removeA();
    saysUnavailable(t);
    await restoreA();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  test("a day named in the address: the amount survives the day leaving (unavailable) and coming back", async () => {
    const { t, task, removeA, restoreA } = await open(true);
    type(amount, "7.125");
    await removeA();
    saysUnavailable(t);
    await restoreA();
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  test("a record pending when day A leaves settles where its input is: success clears only what it submitted, a refusal keeps it", async () => {
    for (const [newer, refuse] of [
      [null, false],
      ["5", false],
      [null, true],
    ] as const) {
      const { t, task, removeA, restoreA } = await open();
      const gate = holdWrites(t, refuse);
      type(amount, "2");
      press("Record");
      await t.settle();
      if (newer !== null) type(amount, newer);
      await removeA();
      await gate.open();
      await t.settle();
      await restoreA();
      expect(field(amount).value).toBe(refuse ? "2" : (newer ?? ""));
      expect(records(t)).toEqual(
        refuse
          ? []
          : [
              expect.objectContaining({
                occurrence_id: task.occurrenceId,
                evidence: { kind: "quantity", amount: "2" },
              }),
            ],
      );
      cleanup();
      forgetTaskMemory();
      forgetKept();
      forgetKeptFixes();
      forgetAllCorrections();
    }
  });

  test("a fix pending when day A leaves: its success closes it unless a newer value was typed, which is there when A is back", async () => {
    for (const newer of [null, "9"]) {
      const { t, task, removeA, restoreA } = await open();
      const gate = holdWrites(t);
      press(HISTORY_COPY.fix);
      type(newValue, "7");
      press(HISTORY_COPY.fixSave);
      await t.settle();
      if (newer !== null) type(newValue, newer);
      await removeA();
      await gate.open();
      await t.settle();
      await restoreA();
      expect(daySelect()?.value).toBe(task.occurrenceId);
      if (newer === null) expect(screen.queryByLabelText(newValue)).toBeNull();
      else expect(field(newValue).value).toBe(newer);
      expect(records(t)).toEqual([
        expect.objectContaining({
          replaces: ENTRY,
          evidence: { kind: "quantity", amount: "7" },
        }),
      ]);
      cleanup();
      forgetTaskMemory();
      forgetKept();
      forgetKeptFixes();
      forgetAllCorrections();
    }
  });

  test("a correction kept by the dialog's sync control and not reopened survives day A leaving; Correct resumes it when A is back", async () => {
    const { t, away, removeA, restoreA } = await open();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    fireEvent.change(minimum(), { target: { value: "12" } });
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    fireEvent.click(chip as HTMLElement);
    await t.until(() => dialog() === null);
    await away();
    await removeA();
    await restoreA();
    expect(dialog()).toBeNull();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("12");
    expect(t.bodies()).toEqual([]);
  });

  test("a failed read of the visit's day is not its absence: the last complete read stays, stale, with the input on day A", async () => {
    const { t, task, away } = await open();
    type(amount, "7.125");
    await away();
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const store = service.store as { run: typeof service.store.run };
    const original = store.run.bind(service.store);
    store.run = (async (plan, input, options) => {
      const ids = (input as { ids?: string[] }).ids ?? [];
      if (
        plan.name === "data.readResourcesById" &&
        ids.includes(task.occurrenceId)
      )
        throw new StoreFailure("error");
      return original(plan, input, options);
    }) as typeof service.store.run;
    // A committed change (the task renamed) makes the detail read again; that read cannot read day A.
    await t.commitSync([
      { ...(task.rows[0] as CacheRow), label: "Renamed", version: 2 },
    ]);
    await t.until(
      () => document.querySelector("[data-detail-row-stale]") !== null,
    );
    expect(document.querySelector("[data-detail-row-stale]")).not.toBeNull();
    expect(unavailable()).toBe(false);
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7.125");
    store.run = original;
    await t.commitSync([
      { ...(task.rows[0] as CacheRow), label: "Renamed again", version: 3 },
    ]);
    await t.until(
      () => document.querySelector("[data-detail-row-stale]") === null,
    );
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  test("control: day A still here, a later commit (another day arriving) keeps the restored amount on day A", async () => {
    const { t, task, away } = await open();
    type(amount, "7.125");
    await away();
    await t.commitSync(
      await anotherDay(
        task,
        "eeeeeeee-0000-4000-8000-0000000000b4",
        addDays(TODAY, -1),
      ),
    );
    await t.settle();
    expect(unavailable()).toBe(false);
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  test("with nothing typed, the visit's day leaving is said too (never replaced by another day); choosing again shows B, with none of A's input", async () => {
    const { t, removeA } = await open();
    await removeA();
    saysUnavailable(t);
    press(DETAIL_COPY.showDays);
    await t.until(() => recordCard() !== null);
    expect(document.activeElement).toBe(recordCard());
    expect(unavailable()).toBe(false);
    expect(field(amount).value).toBe("");
    expect(t.bodies()).toEqual([]);
  });

  test("choosing again after day A left with input: B is shown blank and stays shown (the mount's pin and the kept day both let go)", async () => {
    const { t, away, removeA } = await open();
    type(amount, "7.125");
    await away();
    await removeA();
    press(DETAIL_COPY.showDays);
    await t.until(() => recordCard() !== null);
    expect(unavailable()).toBe(false);
    expect(field(amount).value).toBe("");
    // A later commit does not take the view back to the unavailable day: B is the visit's day now.
    await t.commitSync([]);
    await t.settle();
    expect(unavailable()).toBe(false);
    expect(recordCard()).not.toBeNull();
    expect(t.bodies()).toEqual([]);
  });

  test("leaving for the sync screens while day A is gone keeps its amount: day A back meanwhile, coming back shows it on day A", async () => {
    const { t, task, path, removeA } = await open();
    type(amount, "7.125");
    await removeA();
    await toSync(t);
    await t.commitSync([task.rows[2] as CacheRow]);
    await back(t, path);
    await t.until(() => detailShown() && recordCard() !== null);
    expect(daySelect()?.value).toBe(task.occurrenceId);
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  test("choosing again keeps day A's amount with day A: picking day A once it is back shows it, and nothing was written", async () => {
    const { t, task, removeA } = await open();
    type(amount, "7.125");
    await removeA();
    press(DETAIL_COPY.showDays);
    await t.until(() => recordCard() !== null);
    expect(field(amount).value).toBe("");
    await t.commitSync([task.rows[2] as CacheRow]);
    await t.until(() => daySelect() !== null);
    expect(daySelect()?.value).toBe(EARLIER);
    fireEvent.change(daySelect() as HTMLSelectElement, {
      target: { value: task.occurrenceId },
    });
    await t.until(() => daySelect()?.value === task.occurrenceId);
    await t.until(() => recordCard() !== null);
    expect(field(amount).value).toBe("7.125");
    expect(t.bodies()).toEqual([]);
  });

  test("the input held while day A is gone is the identity's: another identity drops it, and A back shows none", async () => {
    const { t, removeA, restoreA } = await open();
    type(amount, "7.125");
    await removeA();
    t.rerender(tasksEnv(t.api, { online: false, identity: `${OTHER}:1` }));
    await t.settle();
    t.rerender(tasksEnv(t.api, { online: false }));
    await t.settle();
    await restoreA();
    expect(field(amount).value).toBe("");
    expect(t.bodies()).toEqual([]);
  });
});

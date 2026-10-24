import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { SyncStateRow } from "../../../src/data/model/types";
import { invalidateRecoveryPosition } from "../../../src/data/plans/sync-writers";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  forgetKeptFixes,
  HISTORY_COPY,
} from "../../../src/features/tasks/detail/EntryHistory";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { progressId } from "../../../src/features/tasks/model/ids";
import { addDays, windows } from "../../../src/features/tasks/model/time";
import { installMatchMedia } from "../../helpers/match-media";
import {
  definition,
  fakeApi,
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
  TODAY,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * Revision 22 (Review 22 R34 and design assessment DA22-I1..I3, `incomplete_fix` of the family `task-sync-navigation-draft-loss`; ia.md
 * §1.3.3, task states I1). FIXTURE evidence: the app's router (memory history, observed by the task visits through the same adapter the
 * document record's semantics are tested against) over the PRODUCTION data controller and the IndexedDB double.
 *
 * Unsaved input belongs to the LOGICAL VISIT of its screen (one address, one identity), not to whichever component can render:
 *  - DA22-I1 (R34): the edit form the data hides (its task's details removed by a committed page) keeps its raw input through that
 *    absence, before or after a sync visit, and only an explicit Save writes; an ordinary departure while it is hidden ends it.
 *  - DA22-I2: the cache gate hiding the whole screen (a same-identity invalidation) is not a departure: the gate's recovery at the same
 *    address shows the same input (cached content stays hidden meanwhile); a departure while hidden ends it.
 *  - DA22-I3: leaving the sync screens for anywhere but the editor's own address is an ordinary departure: a later visit starts afresh.
 * For the edit form, the new form and its preset picker, and the day editors (amount, entry fix, occurrence correction). Paired controls
 * keep the input where the visit goes on (staying, Back, the queue's own way back, a protected-tree remount) and every case inspects the
 * durable queue: retention never writes. A save pending through an absence settles by its own session and revision, never navigating a
 * person who has left.
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

const formShown = () => document.querySelector("[data-task-form]") !== null;
const gateShown = () =>
  document.querySelector('[data-cache-gate="refreshing"]') !== null;
const pickerShown = () =>
  screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null;
/** New task's screen in either of its stages (a readiness condition both outcomes meet: the assertion that follows decides). */
const newTaskShown = () => pickerShown() || formShown();
const historyShown = () =>
  document.querySelector("[data-entry-history]") !== null;
const recordCard = () => document.querySelector("[data-record-card]");
const daySelect = () =>
  document.querySelector(
    "[data-day-picker] select",
  ) as HTMLSelectElement | null;
const dialog = () => screen.queryByRole("dialog");
function field(label: string): HTMLInputElement {
  const found = screen.queryByLabelText(label, { exact: true });
  expect(found, `the field "${label}"`).not.toBeNull();
  return found as HTMLInputElement;
}
function press(name: string) {
  const found = screen.queryByRole("button", { name });
  expect(found, `the button "${name}"`).not.toBeNull();
  fireEvent.click(found as HTMLElement);
}
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const nothingWritten = (t: Mounted) => expect(t.bodies()).toEqual([]);

async function to(t: Mounted, path: string, search: object = {}) {
  await act(async () => {
    await t.router.navigate({ to: path, search } as never);
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(path);
}
const toSync = (t: Mounted) => to(t, "/sync", { tab: "queue" });
/** The browser's Back. */
async function back(t: Mounted, expected: string) {
  await act(async () => {
    t.router.history.back();
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(expected);
}

/**
 * The cache gate closes over the screen: the PRODUCTION ordinary-phase invalidation (W18, as a `410 resync_required` makes it) commits
 * `cache_status: "invalid"` for the same identity, account and database; the address does not change. Cached content is hidden.
 */
async function closeGate(t: Mounted) {
  const service = t.data.service();
  if (service === null) throw new Error("closeGate: no open service");
  const s = t.world.idb.peek(
    accountDatabaseName(ME),
    "sync_state",
    "singleton",
  ) as SyncStateRow | undefined;
  if (s === undefined) throw new Error("closeGate: no sync state");
  await act(async () => {
    await service.commit(invalidateRecoveryPosition, {
      captured: service.capture(1, {
        requestSeq: s.request_seq,
        ownershipToken: s.owner?.ownership_token ?? null,
        recoveryGeneration: s.recovery_generation,
        expectedPosition: s.cursor,
      }),
      reason: "resync_required",
    });
  });
  await t.settle();
  const after = t.world.idb.peek(
    accountDatabaseName(ME),
    "sync_state",
    "singleton",
  ) as SyncStateRow;
  expect(after.cache_status, "the invalidation committed").toBe("invalid");
}
/** The gate opens again at the same address: a committed delta page makes the cache valid (no row changes). */
async function openGate(t: Mounted) {
  await t.commitSync([], [], { empty: true });
  expect(gateShown()).toBe(false);
}

/** Holds every write the screens queue until `open()`; `refuse`: the outbox then refuses it (storage). */
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
  return {
    open: async () => {
      await act(async () => open());
      await t.settle();
    },
  };
}

// ---- DA22-I1 (R34): the edit form ----------------------------------------------------------------------------------------------------

describe("DA22-I1 (R34): the edit form's input belongs to the edit visit, not to the form the data can show", () => {
  const ORIGINAL = "Original title";
  const TYPED = "Unfinished personal title";
  const name = () => field(FORM_COPY.name);
  const fieldset = () =>
    document.querySelector("[data-task-form] fieldset") as HTMLFieldSetElement;
  const revises = (t: Mounted) =>
    t
      .bodies()
      .map((b) => b.command.command)
      .filter((c) => c.kind === "revise_task");

  async function open() {
    const task = await seededTask({ title: ORIGINAL });
    const path = `/tasks/${task.taskId}/edit`;
    const t = await mountTasks({
      path,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(formShown);
    expect(name().value).toBe(ORIGINAL);
    nothingWritten(t);
    const executions = task.rows.filter((r) => r.kind === "execution");
    expect(executions, "exactly one execution").toHaveLength(1);
    const execution = executions[0] as CacheRow;
    type(FORM_COPY.name, TYPED);
    expect(name().value).toBe(TYPED);
    return {
      t,
      task,
      path,
      /** A committed page removes the task's details: the form is not shown (same address, nothing queued). */
      remove: async () => {
        await t.commitSync([], [execution.id]);
        expect(formShown()).toBe(false);
        expect(t.router.state.location.pathname).toBe(path);
        nothingWritten(t);
      },
      /** The details come back (a committed page), wherever the person is. */
      bringBack: () => t.commitSync([{ ...execution, version: 3 }]),
      restore: async () => {
        await t.commitSync([{ ...execution, version: 3 }]);
        await t.until(formShown);
        expect(formShown()).toBe(true);
      },
    };
  }

  test("control: sync and Back keep the edit, and an explicit Save writes exactly one revise of this task with the typed title", async () => {
    const { t, task, path } = await open();
    await toSync(t);
    await back(t, path);
    await t.until(formShown);
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
    press(FORM_COPY.save);
    await t.until(() => t.bodies().length === 1);
    expect(revises(t)).toEqual([
      expect.objectContaining({
        kind: "revise_task",
        id: task.taskId,
        title: TYPED,
      }),
    ]);
  });

  test("the details leave and come back while the person stays: the raw title is kept, nothing written", async () => {
    const { t, remove, restore } = await open();
    await remove();
    await restore();
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("after sync and Back, the details leave and come back in the same visit: the raw title is kept", async () => {
    const { t, path, remove, restore } = await open();
    await toSync(t);
    await back(t, path);
    await t.until(formShown);
    await remove();
    await restore();
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("control: a readable refresh of the details leaves the edit as typed", async () => {
    const { t, task } = await open();
    const execution = task.rows.find((r) => r.kind === "execution") as CacheRow;
    await t.commitSync([{ ...execution, version: 2 }]);
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("control: details gone when Back returns from the sync screens, restored while the person stays: the edit is there", async () => {
    const { t, task, path, restore } = await open();
    await toSync(t);
    await t.commitSync([], [task.executionId]);
    await back(t, path);
    expect(formShown()).toBe(false);
    await restore();
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("details gone when Back returns, then an ordinary departure: the abandoned title never comes back on a later visit", async () => {
    const { t, task, path } = await open();
    await toSync(t);
    await t.commitSync([], [task.executionId]);
    await back(t, path);
    expect(formShown()).toBe(false);
    await to(t, "/tasks");
    const execution = task.rows.find((r) => r.kind === "execution") as CacheRow;
    await t.commitSync([{ ...execution, version: 3 }]);
    await to(t, path);
    await t.until(formShown);
    expect(name().value).toBe(ORIGINAL);
    nothingWritten(t);
  });

  test("control: details gone while the form is shown, then an ordinary departure while hidden: a later visit starts from the task", async () => {
    const { t, path, remove, bringBack } = await open();
    await remove();
    await to(t, "/tasks");
    await bringBack();
    await to(t, path);
    await t.until(formShown);
    expect(name().value).toBe(ORIGINAL);
    nothingWritten(t);
  });

  test("a save pending while the details leave, refused while they are gone: the typed title is kept, no longer pending, nothing written", async () => {
    const { t, path, remove, restore } = await open();
    const writes = holdWrites(t, true);
    press(FORM_COPY.save);
    await t.settle();
    expect(fieldset().disabled, "the save is pending").toBe(true);
    await remove();
    await writes.open();
    expect(t.router.state.location.pathname).toBe(path);
    await restore();
    expect(name().value).toBe(TYPED);
    expect(fieldset().disabled, "the refused save is no longer pending").toBe(
      false,
    );
    nothingWritten(t);
  });

  test("control: a save pending when the person leaves, refused after: they stay where they went, and the next visit starts from the task", async () => {
    const { t, path } = await open();
    const writes = holdWrites(t, true);
    press(FORM_COPY.save);
    await t.settle();
    await to(t, "/tasks");
    await writes.open();
    expect(t.router.state.location.pathname).toBe("/tasks");
    await to(t, path);
    await t.until(formShown);
    expect(name().value).toBe(ORIGINAL);
    expect(fieldset().disabled).toBe(false);
    nothingWritten(t);
  });

  test("control: a save pending when the person leaves, succeeding after: one revise, and the person is not moved", async () => {
    const { t, task } = await open();
    const writes = holdWrites(t);
    press(FORM_COPY.save);
    await t.settle();
    await to(t, "/tasks");
    await writes.open();
    expect(t.router.state.location.pathname).toBe("/tasks");
    expect(revises(t)).toEqual([
      expect.objectContaining({ id: task.taskId, title: TYPED }),
    ]);
  });

  test("DA22-I3: sync, then the task list (never back to the form): a later visit of the form starts from the task", async () => {
    const { t, path } = await open();
    await toSync(t);
    await to(t, "/tasks");
    await to(t, path);
    await t.until(formShown);
    expect(name().value).toBe(ORIGINAL);
    nothingWritten(t);
  });

  test("control: sync, then the queue's own way back to the same form (a navigation, not Back): the edit is there", async () => {
    const { t, path } = await open();
    await toSync(t);
    await to(t, path);
    await t.until(formShown);
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("DA22-I2: the cache gate hides the whole screen and opens again at the same address: the edit is there, and was hidden meanwhile", async () => {
    const { t } = await open();
    await closeGate(t);
    expect(gateShown()).toBe(true);
    expect(formShown()).toBe(false);
    expect(screen.queryByDisplayValue(TYPED)).toBeNull();
    await openGate(t);
    await t.until(formShown);
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("control (DA22-I2): an ordinary departure while the gate hides the screen ends the edit: a later visit starts from the task", async () => {
    const { t, path } = await open();
    await closeGate(t);
    expect(formShown()).toBe(false);
    await to(t, "/tasks");
    await openGate(t);
    await to(t, path);
    await t.until(formShown);
    expect(name().value).toBe(ORIGINAL);
    nothingWritten(t);
  });

  test("DA22-I2: the protected tree remounted at the same address (the session's re-check) keeps the edit", async () => {
    const { t } = await open();
    t.remount();
    await t.settle();
    await t.until(formShown);
    expect(name().value).toBe(TYPED);
    nothingWritten(t);
  });

  test("control: another identity while the form is hidden ends the edit: back to the first identity, the task's own title", async () => {
    const { t, remove, restore } = await open();
    await remove();
    t.rerender(tasksEnv(t.api, { online: false, identity: `${OTHER}:1` }));
    await t.settle();
    t.rerender(tasksEnv(t.api, { online: false }));
    await t.settle();
    await restore();
    expect(name().value).toBe(ORIGINAL);
    nothingWritten(t);
  });
});

// ---- the new form and its preset picker ----------------------------------------------------------------------------------------------

describe("DA22-I2/I3: the new form and its preset picker belong to the new-task visit", () => {
  const TITLE = "A new task typed here";
  async function scratchForm() {
    const t = await mountTasks({ path: "/tasks/new", env: { online: false } });
    await t.until(pickerShown);
    press(PRESET_COPY.scratch);
    await t.until(formShown);
    type(FORM_COPY.name, TITLE);
    return t;
  }

  test("DA22-I3: sync, then the task list: a new visit of New task opens the picker afresh", async () => {
    const t = await scratchForm();
    await toSync(t);
    await to(t, "/tasks");
    await to(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown()).toBe(false);
    nothingWritten(t);
  });

  test("control: sync and the way back to New task: the same form and title", async () => {
    const t = await scratchForm();
    await toSync(t);
    await to(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(pickerShown()).toBe(false);
    expect(field(FORM_COPY.name).value).toBe(TITLE);
    nothingWritten(t);
  });

  test("DA22-I2: the cache gate hides and shows the screen again: the same form and title, never the picker", async () => {
    const t = await scratchForm();
    await closeGate(t);
    expect(formShown()).toBe(false);
    await openGate(t);
    await t.until(newTaskShown);
    expect(pickerShown()).toBe(false);
    expect(field(FORM_COPY.name).value).toBe(TITLE);
    nothingWritten(t);
  });

  test("the picker's in-dialog sync control goes to the sync screens straight from the picker, and Back finds the choice", async () => {
    const preset = (id: string, title: string) => ({
      id,
      title,
      definition: definition(),
    });
    const api = fakeApi({
      readPresets: async () => ({
        ok: true,
        value: [preset("first", "First preset"), preset("second", "Second")],
      }),
    });
    const t = await mountTasks({ path: "/tasks/new", api });
    const second = () =>
      screen.queryByRole("radio", { name: /^Second/ }) as HTMLInputElement;
    await t.until(() => second() !== null);
    fireEvent.click(second());
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    await act(async () => {
      fireEvent.click(chip as HTMLElement);
    });
    await t.settle();
    // Not through the task list (an ordinary departure that would end the visit): still New task until the sync screens open.
    expect(t.router.state.location.pathname).toBe("/tasks/new");
    await toSync(t);
    await back(t, "/tasks/new");
    await t.until(() => second() !== null);
    expect(second().checked).toBe(true);
    // Control: Escape leaves for the task list, which ends the visit: New task again starts on the first preset.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await t.settle();
    expect(t.router.state.location.pathname).toBe("/tasks");
    await to(t, "/tasks/new");
    await t.until(() => second() !== null);
    expect(second().checked).toBe(false);
  });
});

// ---- the day editors: amount, entry fix, occurrence correction -------------------------------------------------------------------------

describe("DA22-I2/I3: the day editors' input belongs to the detail visit", () => {
  const EARLIER = "eeeeeeee-0000-4000-8000-0000000000d3";
  const amount = `${RECORD_COPY.amount} (cups)`;
  const newValue = `${HISTORY_COPY.newValue} (cups)`;
  const ENTRY = "80000000-0000-4000-8000-0000000000e2";
  const minimum = () =>
    within(dialog() as HTMLElement).getByLabelText(
      CORRECTION_COPY.minimum,
    ) as HTMLInputElement;

  /** A daily task counting cups from two days ago (my recent entry of 1 cup there), plus an earlier saved day: day A is the default. */
  async function open() {
    const start = addDays(TODAY, -2);
    const task: SeededTask = await seededTask({
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
        recent_entries: [
          {
            id: ENTRY,
            evidence: { kind: "quantity", amount: "1" },
            happened_at: Math.floor(Date.now() / 1000),
            recorded_by: ME,
          },
        ] as never,
        entry_count: 1,
        action: { outcome: "incomplete", amount: "1", checked: [] },
      },
    });
    const date = addDays(TODAY, -3);
    const slot = { ...task.data.slot, key: `day-${date}`, date };
    const w = windows(slot, task.data.definition);
    const earlier: CacheRow[] = [
      {
        ...(task.rows[2] as CacheRow),
        id: EARLIER,
        value: {
          ...task.data,
          slot,
          opens_at: w.opens_at,
          closes_at: w.closes_at,
        } as never,
      },
      {
        ...(task.rows[3] as CacheRow),
        id: await progressId(EARLIER, ME),
        parent_id: EARLIER,
        value: {
          ...((task.rows[3] as CacheRow).value as object),
          recent_entries: [],
          entry_count: 0,
          action: { outcome: "unknown", amount: null, checked: [] },
        } as never,
      },
    ];
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path,
      rows: [...task.rows, ...earlier],
      env: { online: false },
    });
    const onA = () =>
      recordCard() !== null && daySelect()?.value === task.occurrenceId;
    await t.until(onA);
    expect(daySelect()?.value).toBe(task.occurrenceId);
    return {
      t,
      path,
      /** A later visit of the task (from elsewhere): the default is day A again. */
      revisit: async () => {
        await to(t, path);
        await t.until(onA);
        expect(daySelect()?.value).toBe(task.occurrenceId);
      },
      /** The gate opens again: the detail is back on day A. */
      reopened: async () => {
        await openGate(t);
        await t.until(onA);
        expect(daySelect()?.value).toBe(task.occurrenceId);
      },
    };
  }

  test("DA22-I2: the gate hides and shows the detail again: day A's typed amount is there, nothing written", async () => {
    const { t, reopened } = await open();
    type(amount, "7.125");
    await closeGate(t);
    expect(recordCard()).toBeNull();
    await reopened();
    expect(field(amount).value).toBe("7.125");
    nothingWritten(t);
  });

  test("control (DA22-I2): an ordinary departure while the gate hides the detail ends the amount", async () => {
    const { t, revisit } = await open();
    type(amount, "7.125");
    await closeGate(t);
    await to(t, "/tasks");
    await openGate(t);
    await revisit();
    expect(field(amount).value).toBe("");
    nothingWritten(t);
  });

  test("DA22-I3: sync, then the task list: a later visit's amount is blank", async () => {
    const { t, revisit } = await open();
    type(amount, "7.125");
    await toSync(t);
    await to(t, "/tasks");
    await revisit();
    expect(field(amount).value).toBe("");
    nothingWritten(t);
  });

  test("DA22-I2: the protected tree remounted at the detail's address keeps day A's amount", async () => {
    const { t } = await open();
    type(amount, "7.125");
    t.remount();
    await t.settle();
    await t.until(() => recordCard() !== null);
    expect(field(amount).value).toBe("7.125");
    nothingWritten(t);
  });

  test("DA22-I2: the gate hides and shows the detail again: the open fix keeps its value", async () => {
    const { t, reopened } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "4.5");
    await closeGate(t);
    expect(screen.queryByLabelText(newValue)).toBeNull();
    await reopened();
    await t.until(historyShown);
    expect(field(newValue).value).toBe("4.5");
    nothingWritten(t);
  });

  test("DA22-I3: an open fix, sync, then the task list: a later visit has no fix open", async () => {
    const { t, revisit } = await open();
    press(HISTORY_COPY.fix);
    type(newValue, "4.5");
    await toSync(t);
    await to(t, "/tasks");
    await revisit();
    expect(screen.queryByLabelText(newValue)).toBeNull();
    nothingWritten(t);
  });

  test("DA22-I2: the gate hides and shows the detail again: Correct resumes the person's 12", async () => {
    const { t, reopened } = await open();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    fireEvent.change(minimum(), { target: { value: "12" } });
    await closeGate(t);
    expect(dialog()).toBeNull();
    await reopened();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("12");
    nothingWritten(t);
  });

  test("DA22-I3: a correction kept by its sync control, then the task list from the sync screens: Correct on a later visit starts afresh", async () => {
    const { t, revisit } = await open();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    fireEvent.change(minimum(), { target: { value: "12" } });
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    fireEvent.click(chip as HTMLElement);
    await t.until(() => dialog() === null);
    await toSync(t);
    await to(t, "/tasks");
    await revisit();
    press(CORRECTION_COPY.open);
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("10");
    nothingWritten(t);
  });
});

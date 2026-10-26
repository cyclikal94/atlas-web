import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetKeptFixes,
  HISTORY_COPY,
} from "../../../src/features/tasks/detail/EntryHistory";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import {
  definition,
  fakeApi,
  ME,
  mountTasks,
  OTHER,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * R33 (Review 18, family `task-sync-navigation-draft-loss`; WEB-02 ia.md §1.3.3, task states I1): checking sync state never discards an
 * in-progress edit. The person leaves an unfinished task form, progress amount or entry fix for the sync screens and comes back with the
 * browser's Back: the same input is there, raw (an invalid value, a conditionally hidden one), at the same stage, and nothing was sent or
 * queued by coming back. Each case has its control: the same input, left for anywhere else, is dropped as before (an explicit Cancel too),
 * and a save of exactly what is shown is not offered again. A save that was pending when the person left settles where the input is now:
 * newer input stays, the submitted input is consumed. Kept input is the displayed identity's and the editor's own.
 *
 * Through the app's router (memory history) over the PRODUCTION data controller and the IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
const forgetAll = () => {
  forgetTaskMemory();
  forgetKept();
  forgetKeptFixes();
};
afterEach(() => {
  cleanup();
  forgetAll();
});

type Mounted = Awaited<ReturnType<typeof mountTasks>>;

const formShown = () => document.querySelector("[data-task-form]") !== null;
const pickerShown = () =>
  screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null;
/**
 * New task's screen in either of its stages (revision 23, labelled harness adaptation): a readiness condition both outcomes meet, so a
 * mutant showing the other stage fails the assertion that follows instead of spending the test's time in the wait.
 */
const newTaskShown = () => formShown() || pickerShown();
const detailShown = () => document.querySelector("[data-task-detail]") !== null;
/** A field by its label, asserted present first (an absent field is a failed expectation, never a thrown query). */
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

/** The shell's sync control: the queue screen, by the router. */
async function toSync(t: Mounted) {
  await act(async () => {
    await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe("/sync");
}
async function to(t: Mounted, path: string) {
  await act(async () => {
    await t.router.navigate({ to: path, search: {} } as never);
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(path);
}
/** The browser's Back. */
async function back(t: Mounted, expected: string) {
  await act(async () => {
    t.router.history.back();
  });
  await t.settle();
  expect(t.router.state.location.pathname).toBe(expected);
}

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** Holds every write the screens queue until `gate` opens (the outbox's own result is returned then). */
function holdWrites(t: Mounted) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  const gate = held<void>();
  const enqueue = outbox.enqueue.bind(outbox);
  outbox.enqueue = async (request) => {
    await gate.promise;
    return enqueue(request);
  };
  return gate;
}
/** Every save fails (storage refused): the input is kept with the refusal. */
function refuseWrites(t: Mounted) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  outbox.enqueue = async () => ({ kind: "refused", reason: "quota" });
}

describe("the new-task form (R33)", () => {
  async function scratchForm() {
    const t = await mountTasks({ path: "/tasks/new", env: { online: false } });
    await t.until(newTaskShown);
    expect(pickerShown(), "the picker, not the form").toBe(true);
    press(PRESET_COPY.scratch);
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    return t;
  }
  /** A title, plus an interval typed and then hidden by choosing a one-off (a conditionally hidden value). */
  function typeUnfinished() {
    type(FORM_COPY.name, "Keep this unfinished title");
    fireEvent.change(field(FORM_COPY.repeats), { target: { value: "daily" } });
    type(FORM_COPY.interval, "3x");
    fireEvent.change(field(FORM_COPY.repeats), { target: { value: "none" } });
    expect(screen.queryByLabelText(FORM_COPY.interval)).toBeNull();
  }

  test("left for the sync queue and back: the same form, title and hidden interval, nothing queued", async () => {
    const t = await scratchForm();
    typeUnfinished();
    await toSync(t);
    expect(formShown()).toBe(false);
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    expect(pickerShown()).toBe(false);
    expect(field(FORM_COPY.name).value).toBe("Keep this unfinished title");
    fireEvent.change(field(FORM_COPY.repeats), { target: { value: "daily" } });
    expect(field(FORM_COPY.interval).value).toBe("3x");
    expect(t.drafts()).toEqual([]);
  });

  test("a stage chosen and nothing typed yet is kept too: the form, not the picker", async () => {
    const t = await scratchForm();
    await toSync(t);
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    expect(pickerShown()).toBe(false);
    expect(field(FORM_COPY.name).value).toBe("");
  });

  test("control: left for the task list instead, coming back starts afresh at the picker", async () => {
    const t = await scratchForm();
    typeUnfinished();
    await to(t, "/tasks");
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(pickerShown(), "the picker, not the form").toBe(true);
    expect(formShown()).toBe(false);
  });

  test("control: after coming back, leaving for anywhere else drops it as before", async () => {
    const t = await scratchForm();
    typeUnfinished();
    await toSync(t);
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    expect(field(FORM_COPY.name).value).toBe("Keep this unfinished title");
    await to(t, "/tasks");
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(pickerShown(), "the picker, not the form").toBe(true);
    expect(formShown()).toBe(false);
  });

  test("control: Cancel discards it; a later sync visit brings nothing back", async () => {
    const t = await scratchForm();
    type(FORM_COPY.name, "Cancelled");
    press(FORM_COPY.cancel);
    await t.settle();
    expect(t.router.state.location.pathname).toBe("/tasks");
    await toSync(t);
    await to(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(pickerShown(), "the picker, not the form").toBe(true);
    expect(formShown()).toBe(false);
  });

  test("the kept form saves what is shown, once", async () => {
    const t = await scratchForm();
    typeUnfinished();
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    await toSync(t);
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    press(FORM_COPY.save);
    await t.until(detailShown);
    const creates = t
      .bodies()
      .filter((b) => b.command.command.kind === "create_task");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.command.command.title).toBe(
      "Keep this unfinished title",
    );
  });

  test("a save pending when the person left: its success consumes the form; Back shows the picker and nothing is resent", async () => {
    const t = await scratchForm();
    const gate = holdWrites(t);
    type(FORM_COPY.name, "Saved while away");
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    press(FORM_COPY.save);
    await t.settle();
    await toSync(t);
    await act(async () => gate.resolve());
    await t.settle();
    // The person is not moved away from the queue by the late success.
    expect(t.router.state.location.pathname).toBe("/sync");
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(pickerShown(), "the picker, not the form").toBe(true);
    expect(t.drafts().map((d) => d.kind)).toEqual(["create_task"]);
  });

  test("a save pending when the person left, with a newer edit: the newer title stays, with the note; one create queued", async () => {
    const t = await scratchForm();
    const gate = holdWrites(t);
    type(FORM_COPY.name, "Submitted title");
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    press(FORM_COPY.save);
    await t.settle();
    // The fieldset is disabled while the save is pending; the newer edit reaches the session through the field's change.
    type(FORM_COPY.name, "Newer title");
    await toSync(t);
    await act(async () => gate.resolve());
    await t.settle();
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    expect(field(FORM_COPY.name).value).toBe("Newer title");
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      FORM_COPY.newerEdits,
    );
    expect(t.drafts().map((d) => d.kind)).toEqual(["create_task"]);
  });

  test("a refused save: the input and the refusal are kept through the visit", async () => {
    const t = await scratchForm();
    refuseWrites(t);
    type(FORM_COPY.name, "Refused title");
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    press(FORM_COPY.save);
    await t.settle();
    const notice = document.querySelector("[data-form-notice]")?.textContent;
    expect(notice).toBeTruthy();
    await toSync(t);
    await back(t, "/tasks/new");
    await t.until(newTaskShown);
    expect(formShown(), "the form, not the picker").toBe(true);
    expect(field(FORM_COPY.name).value).toBe("Refused title");
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      notice,
    );
    expect(t.drafts()).toEqual([]);
  });

  // Revision 22: its readiness waits accept either stage of New task (the assertions below decide), so a mutant that brings the form back
  // fails by assertion, not by spending the whole wait (Run 2: MU-2334's timeout under contention).
  test("another identity never sees it, and coming back to the first identity it is gone", async () => {
    const t = await scratchForm();
    typeUnfinished();
    await toSync(t);
    t.rerender(tasksEnv(t.api, { online: false, identity: `${OTHER}:1` }));
    await t.settle();
    await back(t, "/tasks/new");
    await t.until(() => pickerShown() || formShown());
    expect(formShown()).toBe(false);
    await to(t, "/tasks");
    t.rerender(tasksEnv(t.api, { online: false }));
    await t.settle();
    await to(t, "/tasks/new");
    await t.until(() => pickerShown() || formShown());
    expect(formShown()).toBe(false);
  });
});

describe("the preset picker (R33, in-dialog sync control)", () => {
  test("a preset chosen is kept through the picker's own sync control; Escape discards it", async () => {
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
    expect(second().checked).toBe(true);
    // The picker's in-dialog sync control: the dialog closes, then the queue opens.
    const chip = screen
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip).toBeDefined();
    await act(async () => {
      fireEvent.click(chip as HTMLElement);
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    await to(t, "/tasks/new");
    await t.until(() => second() !== null);
    expect(second().checked).toBe(true);
    // Escape discards the choice: the picker opened again starts on the first preset.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await t.settle();
    await to(t, "/tasks/new");
    await t.until(() => second() !== null);
    expect(second().checked).toBe(false);
  });
});

describe("the edit form (R33)", () => {
  async function editForm(title = "Original title") {
    const task = await seededTask({ title });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}/edit`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(formShown);
    return { t, task };
  }

  test("left for the sync screens and back: the raw (here invalid, empty) name is shown, not the saved one", async () => {
    const { t, task } = await editForm();
    type(FORM_COPY.name, "");
    await toSync(t);
    await back(t, `/tasks/${task.taskId}/edit`);
    await t.until(formShown);
    expect(field(FORM_COPY.name).value).toBe("");
    expect(t.drafts()).toEqual([]);
  });

  test("control: an unedited form shows the task as it is when the person comes back", async () => {
    const { t, task } = await editForm();
    await toSync(t);
    await back(t, `/tasks/${task.taskId}/edit`);
    await t.until(formShown);
    expect(field(FORM_COPY.name).value).toBe("Original title");
  });

  test("an unedited form holds nothing of the person's: a rename synced while they were away is what they come back to", async () => {
    const { t, task } = await editForm();
    await toSync(t);
    const row = task.rows.find((r) => r.kind === "task");
    if (row === undefined) throw new Error("setup: no task row");
    await t.commitSync([
      { ...row, label: "Renamed elsewhere", version: row.version + 1 },
    ]);
    await back(t, `/tasks/${task.taskId}/edit`);
    await t.until(formShown);
    expect(field(FORM_COPY.name).value).toBe("Renamed elsewhere");
  });

  test("control: left for the task's detail instead, the edit starts from the saved task", async () => {
    const { t, task } = await editForm();
    type(FORM_COPY.name, "Typed then left");
    await to(t, `/tasks/${task.taskId}`);
    await back(t, `/tasks/${task.taskId}/edit`);
    await t.until(formShown);
    expect(field(FORM_COPY.name).value).toBe("Original title");
  });

  test("kept for its own task only: another task's form starts from that task, and going there ends the first task's edit", async () => {
    const { t, task } = await editForm();
    const other = await seededTask({ title: "Other task" });
    t.world.idb.seed(`atlas-${ME}`, "cache", other.rows);
    type(FORM_COPY.name, "Typed for the first task");
    await toSync(t);
    await to(t, `/tasks/${other.taskId}/edit`);
    await t.until(formShown);
    expect(field(FORM_COPY.name).value).toBe("Other task");
    await to(t, `/tasks/${task.taskId}/edit`);
    await t.until(formShown);
    // REVISION 22 ADAPTATION (Review 22 R34 / design assessment DA22-I3, the ordinary-departure rule): leaving the sync screens for
    // another task's form is an ordinary departure from the first task's edit, so its unsaved title is retired, never resurrected on a
    // later visit. Until revision 21 this asserted "Typed for the first task". The original intent, input kept for its own editor only, is
    // the assertion on the other task's form above; sync and Back to the SAME form keeping it is the first test of this group.
    expect(field(FORM_COPY.name).value).toBe("Original title");
    expect(t.drafts()).toEqual([]);
  });
});

describe("progress input on the task detail (R33)", () => {
  const ENTRY = "80000000-0000-4000-8000-000000000001";
  async function detail() {
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
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
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path: `${path}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(
      () => detailShown() && document.querySelector("[data-entry]") !== null,
    );
    return { t, path };
  }
  const amount = `${RECORD_COPY.amount} (cups)`;
  const newValue = `${HISTORY_COPY.newValue} (cups)`;

  test("the amount being typed (raw) is kept through the visit; nothing is recorded", async () => {
    const { t, path } = await detail();
    type(amount, "7,5x");
    await toSync(t);
    await back(t, path);
    await t.until(detailShown);
    expect(field(amount).value).toBe("7,5x");
    expect(t.drafts()).toEqual([]);
  });

  test("the chosen record mode is kept with the hidden amount", async () => {
    const { t, path } = await detail();
    type(amount, "7");
    fireEvent.click(screen.getByRole("radio", { name: RECORD_COPY.checkedOn }));
    expect(screen.queryByLabelText(amount)).toBeNull();
    await toSync(t);
    await back(t, path);
    await t.until(detailShown);
    expect(
      (
        screen.getByRole("radio", {
          name: RECORD_COPY.checkedOn,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: RECORD_COPY.logAmount }));
    expect(field(amount).value).toBe("7");
  });

  test("control: left for Today instead, the amount starts empty", async () => {
    const { t, path } = await detail();
    type(amount, "7");
    await to(t, "/today");
    await back(t, path);
    await t.until(detailShown);
    expect(field(amount).value).toBe("");
  });

  test("a record pending when the person left: its success clears only the amount it submitted", async () => {
    for (const newer of [null, "5"]) {
      const { t, path } = await detail();
      const gate = holdWrites(t);
      type(amount, "2");
      press("Record");
      await t.settle();
      if (newer !== null) type(amount, newer);
      await toSync(t);
      await act(async () => gate.resolve());
      await t.settle();
      await back(t, path);
      await t.until(detailShown);
      expect(field(amount).value).toBe(newer ?? "");
      expect(t.drafts().filter((d) => d.kind === "record")).toHaveLength(1);
      cleanup();
      forgetAll();
    }
  });

  test("after a record consumed its amount, the next amount typed is kept through a visit too", async () => {
    const { t, path } = await detail();
    type(amount, "2");
    press("Record");
    await t.until(() => field(amount).value === "");
    expect(field(amount).value).toBe("");
    type(amount, "8");
    await toSync(t);
    await back(t, path);
    await t.until(detailShown);
    expect(field(amount).value).toBe("8");
    expect(t.drafts().filter((d) => d.kind === "record")).toHaveLength(1);
  });

  test("an open fix is open again, with the value typed, after the visit; nothing is queued", async () => {
    const { t, path } = await detail();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await toSync(t);
    await back(t, path);
    await t.until(detailShown);
    expect(field(newValue).value).toBe("7");
    expect(t.drafts()).toEqual([]);
    // Cancel discards it: the next Fix starts from the entry's value.
    press(HISTORY_COPY.cancel);
    press(HISTORY_COPY.fix);
    expect(field(newValue).value).toBe("1");
  });

  test("a kept fix is the displayed identity's: another identity's history forgets it", async () => {
    const { t, path } = await detail();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await toSync(t);
    t.rerender(tasksEnv(t.api, { online: false, identity: `${OTHER}:1` }));
    await t.settle();
    await back(t, path);
    await t.until(detailShown);
    expect(screen.queryByLabelText(newValue)).toBeNull();
    await to(t, "/today");
    t.rerender(tasksEnv(t.api, { online: false }));
    await t.settle();
    await back(t, path);
    await t.until(detailShown);
    expect(screen.queryByLabelText(newValue)).toBeNull();
  });

  test("control: an open fix left for Today is not kept", async () => {
    const { t, path } = await detail();
    press(HISTORY_COPY.fix);
    type(newValue, "7");
    await to(t, "/today");
    await back(t, path);
    await t.until(detailShown);
    expect(screen.queryByLabelText(newValue)).toBeNull();
    press(HISTORY_COPY.fix);
    expect(field(newValue).value).toBe("1");
  });

  test("a fix pending when the person left: success closes it unless a newer value was typed", async () => {
    for (const newer of [null, "9"]) {
      const { t, path } = await detail();
      const gate = holdWrites(t);
      press(HISTORY_COPY.fix);
      type(newValue, "7");
      press(HISTORY_COPY.fixSave);
      await t.settle();
      if (newer !== null) type(newValue, newer);
      await toSync(t);
      await act(async () => gate.resolve());
      await t.settle();
      await back(t, path);
      await t.until(detailShown);
      if (newer === null) expect(screen.queryByLabelText(newValue)).toBeNull();
      else expect(field(newValue).value).toBe(newer);
      expect(t.drafts().filter((d) => d.kind === "record")).toHaveLength(1);
      cleanup();
      forgetAll();
    }
  });
});

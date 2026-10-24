import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { DraftRow } from "../../../src/data";
import { refusalMessage } from "../../../src/features/tasks/copy";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetKeptFixes } from "../../../src/features/tasks/detail/EntryHistory";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import {
  forgetKept,
  keptKey,
  subscribeKept,
} from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { taskFormContext } from "../../../src/features/tasks/model/recovery";
import { visitHere } from "../../../src/features/tasks/visit";
import { installMatchMedia } from "../../helpers/match-media";
import {
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * Revision 23 (Review 23 R35 and design assessment DA23, `incomplete_fix` of the family `task-sync-navigation-draft-loss`; ia.md §1.3.3,
 * docs/tasks.md decision 44). FIXTURE evidence: the app's router (memory history, observed by the task visits) over the PRODUCTION data
 * controller and the IndexedDB double; the acknowledgement is held AFTER the real outbox committed the command.
 *
 * Settling a save is not permission to act on the screen. A form's Save that the outbox has committed, acknowledged after the person chose
 * to go elsewhere (the task list, or the sync screens, where the visit goes on) but before React removed the old form, is consumed (one
 * command, never offered again) and never moves the person: they stay where they went. Staying on the form, or coming back to it (the same
 * visit) before the acknowledgement, still closes it onto the task. The schedule's barriers are asserted, not assumed: the history has
 * moved and the old form is still mounted when the acknowledgement is released, and the settlement reached that old form.
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
type Mode = "new" | "edit";

const IDENTITY = `${ME}:1`;
const ORIGINAL = "Original title";
const TYPED = "Typed title";
const formShown = () => document.querySelector("[data-task-form]") !== null;
const pickerShown = () =>
  screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null;
const detailShown = () => document.querySelector("[data-task-detail]") !== null;
const fieldset = () =>
  document.querySelector("[data-task-form] fieldset") as HTMLFieldSetElement;
const name = () =>
  screen.getByLabelText(FORM_COPY.name, { exact: true }) as HTMLInputElement;
const dialog = () => screen.queryByRole("dialog");
const commands = (t: Mounted) =>
  (t.bodies() as { command: { command: Record<string, unknown> } }[]).map(
    (b) => b.command.command,
  );
const at = (t: Mounted) => t.router.history.location.pathname;
const SYNC = { to: "/sync", search: { tab: "queue" } } as const;

async function to(t: Mounted, path: string, search: object = {}) {
  await act(async () => {
    await t.router.navigate({ to: path, search } as never);
  });
  await t.settle();
  expect(at(t)).toBe(path);
}
async function back(t: Mounted, expected: string) {
  await act(async () => {
    t.router.history.back();
  });
  await t.settle();
  expect(at(t)).toBe(expected);
}

/**
 * Holds the acknowledgement of the outbox's `method` until `release()`: the write itself commits first (`committed`). `refuse`: hold
 * BEFORE the transaction, then refuse (nothing written); `throws`: hold before it, then throw (nothing written).
 */
function holdAcknowledgement(
  t: Mounted,
  method: "enqueue" | "editQueued" = "enqueue",
  outcome: "commit" | "refuse" | "throws" = "commit",
) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("setup: no outbox");
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const state = { committed: false, asked: false };
  const real = (outbox[method] as (...a: unknown[]) => Promise<unknown>).bind(
    outbox,
  );
  (outbox as unknown as Record<string, unknown>)[method] = async (
    ...args: unknown[]
  ) => {
    state.asked = true;
    if (outcome === "refuse") {
      await gate;
      return { kind: "refused", reason: "quota" };
    }
    if (outcome === "throws") {
      await gate;
      throw new Error("the store threw");
    }
    const result = await real(...args);
    state.committed = true;
    await gate;
    return result;
  };
  return { state, release: () => open() };
}

/** Records, for every settlement of `key`, whether a task form was still mounted when the old form was told (the A < U barrier). */
function watchSettlement(key: string) {
  const seen: { kind: string; formMounted: boolean }[] = [];
  const stop = subscribeKept(key, (event) => {
    seen.push({ kind: event.kind, formMounted: formShown() });
  });
  return { seen, stop };
}

async function openForm(mode: Mode) {
  const task = await seededTask({ title: ORIGINAL });
  const path = mode === "edit" ? `/tasks/${task.taskId}/edit` : "/tasks/new";
  const t = await mountTasks({ path, rows: task.rows, env: { online: false } });
  if (mode === "new") {
    await t.until(pickerShown);
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
  }
  await t.until(formShown);
  expect(name().value).toBe(mode === "edit" ? ORIGINAL : "");
  expect(t.bodies()).toEqual([]);
  fireEvent.change(name(), { target: { value: TYPED } });
  const key = keptKey(
    IDENTITY,
    mode === "edit" ? taskFormContext(task.taskId) : "task-form:new",
  );
  return { t, task, path, key };
}

/** Save, and wait until the outbox has committed the command (its acknowledgement held). */
async function saveCommitted(
  t: Mounted,
  hold: ReturnType<typeof holdAcknowledgement>,
) {
  fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
  await t.until(() => hold.state.committed);
  expect(hold.state.committed, "the outbox committed the save").toBe(true);
  expect(fieldset().disabled, "the save is pending").toBe(true);
}

function savedOnce(t: Mounted, mode: Mode, task: SeededTask): string {
  const all = commands(t);
  expect(all).toHaveLength(1);
  const [saved] = all as [Record<string, unknown>];
  expect(saved.kind).toBe(mode === "edit" ? "revise_task" : "create_task");
  expect(saved.title).toBe(TYPED);
  if (mode === "edit") expect(saved.id).toBe(task.taskId);
  return String(saved.id);
}

/**
 * The central schedule (C < N < A < U): the command committed, the person navigates, the acknowledgement arrives while the old form is
 * still mounted. Returns whether that old form was told of the settlement while mounted.
 */
async function departThenAcknowledge(
  t: Mounted,
  hold: ReturnType<typeof holdAcknowledgement>,
  key: string,
  where: "/tasks" | "/sync",
  owner: ReturnType<typeof visitHere>,
) {
  const watch = watchSettlement(key);
  await act(async () => {
    void t.router.navigate(
      (where === "/sync" ? SYNC : { to: "/tasks", search: {} }) as never,
    );
    expect(at(t), "the history moved before the acknowledgement").toBe(where);
    expect(
      owner.ended(),
      "an ordinary departure ends the visit; the sync screens keep it",
    ).toBe(where === "/tasks");
    expect(formShown(), "the old form has not been removed yet").toBe(true);
    hold.release();
  });
  await t.settle();
  watch.stop();
  return watch.seen;
}

describe("R35: a save acknowledged after the person left never moves them", () => {
  for (const mode of ["new", "edit"] as const)
    for (const where of ["/tasks", "/sync"] as const)
      test(`${mode} form, ${where === "/sync" ? "the sync screens" : "the task list"}: acknowledged before the old form is removed, the person stays; one ${mode === "edit" ? "revise" : "create"}`, async () => {
        const { t, task, path, key } = await openForm(mode);
        const owner = visitHere(IDENTITY, path);
        const hold = holdAcknowledgement(t);
        await saveCommitted(t, hold);
        savedOnce(t, mode, task);
        const seen = await departThenAcknowledge(t, hold, key, where, owner);
        // The precondition: the settlement consumed the session and reached the old form while it was mounted.
        expect(seen).toEqual([{ kind: "consumed", formMounted: true }]);
        expect(at(t)).toBe(where);
        expect(t.router.state.location.pathname).toBe(where);
        savedOnce(t, mode, task);
        if (where === "/sync") {
          // Back to the form: the consumed save is not offered again, and nothing more is written.
          await back(t, path);
          if (mode === "new") {
            await t.until(pickerShown);
            expect(pickerShown(), "the new task starts again").toBe(true);
          } else {
            await t.until(formShown);
            expect(fieldset().disabled).toBe(false);
          }
          savedOnce(t, mode, task);
        }
      });

  for (const mode of ["new", "edit"] as const)
    test(`control: ${mode} form, staying: the acknowledged save closes the form onto its task`, async () => {
      const { t, task, key } = await openForm(mode);
      const hold = holdAcknowledgement(t);
      await saveCommitted(t, hold);
      const watch = watchSettlement(key);
      await act(async () => hold.release());
      await t.settle();
      watch.stop();
      expect(watch.seen).toEqual([{ kind: "consumed", formMounted: true }]);
      const id = savedOnce(t, mode, task);
      expect(at(t)).toBe(`/tasks/${id}`);
    });

  for (const where of ["/tasks", "/sync"] as const)
    test(`edit form, ${where}: acknowledged after the old form was removed, the person stays; one revise`, async () => {
      const { t, task } = await openForm("edit");
      const hold = holdAcknowledgement(t);
      await saveCommitted(t, hold);
      if (where === "/sync") await to(t, "/sync", SYNC.search);
      else await to(t, "/tasks");
      expect(formShown(), "the old form is gone").toBe(false);
      await act(async () => hold.release());
      await t.settle();
      expect(at(t)).toBe(where);
      savedOnce(t, "edit", task);
    });
});

describe("R35: coming back to the same visit before the acknowledgement", () => {
  for (const mode of ["new", "edit"] as const)
    test(`${mode} form: sync, Back to the pending form, then acknowledged: the form the person is at closes onto its task`, async () => {
      const { t, task, path } = await openForm(mode);
      const hold = holdAcknowledgement(t);
      await saveCommitted(t, hold);
      await to(t, "/sync", SYNC.search);
      await back(t, path);
      await t.until(formShown);
      expect(name().value).toBe(TYPED);
      expect(fieldset().disabled, "still the pending save").toBe(true);
      await act(async () => hold.release());
      await t.settle();
      const id = savedOnce(t, mode, task);
      expect(at(t)).toBe(`/tasks/${id}`);
    });

  test("edit form: away, then a new visit of the form typed again, then the old save acknowledged: the new input and its form stay", async () => {
    const { t, task, path } = await openForm("edit");
    const hold = holdAcknowledgement(t);
    await saveCommitted(t, hold);
    await to(t, "/tasks");
    await to(t, path);
    await t.until(formShown);
    expect(fieldset().disabled, "a new session: nothing pending").toBe(false);
    fireEvent.change(name(), { target: { value: "Second title" } });
    await act(async () => hold.release());
    await t.settle();
    expect(at(t)).toBe(path);
    expect(name().value).toBe("Second title");
    expect(fieldset().disabled).toBe(false);
    savedOnce(t, "edit", task);
  });
});

describe("R35: a save refused or thrown while the person is at the sync screens", () => {
  for (const mode of ["new", "edit"] as const)
    for (const outcome of ["refuse", "throws"] as const)
      test(`${mode} form, ${outcome === "refuse" ? "refused" : "the store threw"} before the old form is removed: the person stays, Back finds the typed title kept with the reason, nothing written`, async () => {
        const { t, path, key } = await openForm(mode);
        const owner = visitHere(IDENTITY, path);
        const hold = holdAcknowledgement(t, "enqueue", outcome);
        fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
        await t.until(() => hold.state.asked);
        expect(hold.state.asked, "the outbox was asked").toBe(true);
        const seen = await departThenAcknowledge(t, hold, key, "/sync", owner);
        expect(seen).toEqual([{ kind: "settled", formMounted: true }]);
        expect(at(t)).toBe("/sync");
        expect(t.bodies()).toEqual([]);
        await back(t, path);
        await t.until(formShown);
        expect(name().value).toBe(TYPED);
        expect(fieldset().disabled).toBe(false);
        expect(
          document.querySelector("[data-task-form]")?.textContent,
        ).toContain(
          refusalMessage(outcome === "refuse" ? "quota" : "storage") as string,
        );
        expect(t.bodies()).toEqual([]);
      });
});

describe("R35: an edit saved into the queued change it was shown", () => {
  /** A task created on this device (queued), or a queued revision of a seeded one, then its edit form opened on it. */
  async function queued(kind: "create_task" | "revise_task") {
    if (kind === "create_task") {
      const { t } = await openForm("new");
      fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
      await t.until(detailShown);
      const id = String(commands(t)[0]?.id);
      await to(t, `/tasks/${id}/edit`);
      await t.until(formShown);
      return { t, id, path: `/tasks/${id}/edit` };
    }
    const { t, task } = await openForm("edit");
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.until(detailShown);
    const path = `/tasks/${task.taskId}/edit`;
    await to(t, path);
    await t.until(formShown);
    return { t, id: task.taskId, path };
  }

  for (const kind of ["create_task", "revise_task"] as const)
    for (const where of ["/tasks", "/sync"] as const)
      test(`queued ${kind}, ${where}: the queued change is edited once, acknowledged before the old form is removed, and the person stays`, async () => {
        const { t, id, path } = await queued(kind);
        const before = (t.drafts() as DraftRow[]).map((d) => d.local_id);
        expect(before).toHaveLength(1);
        fireEvent.change(name(), { target: { value: "Second title" } });
        const owner = visitHere(IDENTITY, path);
        const hold = holdAcknowledgement(t, "editQueued");
        fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
        await t.until(() => hold.state.committed);
        expect(hold.state.committed, "the queued change was edited").toBe(true);
        const seen = await departThenAcknowledge(
          t,
          hold,
          keptKey(IDENTITY, taskFormContext(id)),
          where,
          owner,
        );
        expect(seen).toEqual([{ kind: "consumed", formMounted: true }]);
        expect(at(t)).toBe(where);
        expect((t.drafts() as DraftRow[]).map((d) => d.local_id)).toEqual(
          before,
        );
        expect(commands(t)).toEqual([
          expect.objectContaining({ kind, id, title: "Second title" }),
        ]);
      });
});

describe("R35: an occurrence correction acknowledged after the person left", () => {
  test("the sync screens before the old dialog is removed: the person stays, one correction, Back shows the day without the dialog", async () => {
    const task = await seededTask({
      definition: {
        goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      },
    });
    const path = `/tasks/${task.taskId}`;
    const t = await mountTasks({
      path,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(
      () =>
        screen.queryByRole("button", { name: CORRECTION_COPY.open }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    await t.until(() => dialog() !== null);
    fireEvent.change(
      within(dialog() as HTMLElement).getByLabelText(CORRECTION_COPY.minimum),
      { target: { value: "12" } },
    );
    const hold = holdAcknowledgement(t);
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole("button", {
        name: CORRECTION_COPY.save,
      }),
    );
    await t.until(() => hold.state.committed);
    expect(hold.state.committed).toBe(true);
    await act(async () => {
      void t.router.navigate(SYNC as never);
      expect(at(t)).toBe("/sync");
      expect(
        dialog(),
        "the old dialog has not been removed yet",
      ).not.toBeNull();
      hold.release();
    });
    await t.settle();
    expect(at(t)).toBe("/sync");
    expect(commands(t)).toEqual([
      expect.objectContaining({ kind: "revise_occurrence" }),
    ]);
    await back(t, path);
    await t.until(detailShown);
    expect(dialog()).toBeNull();
    expect(commands(t)).toHaveLength(1);
  });
});

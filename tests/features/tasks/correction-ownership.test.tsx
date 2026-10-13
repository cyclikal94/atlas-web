import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { SyncStatusProvider } from "../../../src/components/ui/sync-status";
import type {
  SaveOutcome as SaveResult,
  TaskActions,
} from "../../../src/features/tasks/actions";
import {
  CORRECTION_COPY,
  CorrectionDialog,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  completeCorrection,
  correctionEntry,
  correctionKey,
  discardCorrection,
  editCorrection,
  openCorrection,
  releaseCorrection,
  submitCorrection,
} from "../../../src/features/tasks/detail/correction-owner";
import {
  EntryHistory,
  HISTORY_COPY,
} from "../../../src/features/tasks/detail/EntryHistory";
import { TasksEnvProvider } from "../../../src/features/tasks/env";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import {
  type CorrectionState,
  correctionFrom,
} from "../../../src/features/tasks/model/correction";
import { composeRow, type RowModel } from "../../../src/features/tasks/view";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
  ME,
  mountTasks,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * R3 of the review of 13 October 2026 (revision 2; family `task-save-acknowledgement-consumes-newer-edits`, design assessment C4, schedules
 * S1–S3 and S5): a save's success consumes only the exact editing session and revision it submitted, whichever mount made it, and closes
 * only the session's CURRENT editor. Every save is held and released at a chosen point; each fault schedule has its healthy control.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
  vi.restoreAllMocks();
});

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const ok = (localId = "saved"): SaveResult => ({ ok: true, localId });
const failed: SaveResult = { ok: false, message: "storage" };
const cups = {
  kind: "numeric" as const,
  minimum: "10",
  maximum: null,
  unit: "cups",
};

async function rowFor(
  progress: NonNullable<Parameters<typeof seededTask>[0]>["progress"] = {},
): Promise<RowModel> {
  const task = await seededTask({ definition: { goal: cups }, progress });
  const result = composeRow(
    {
      occurrenceId: task.occurrenceId,
      progressId: task.progressId,
      task: task.rows[0] ?? null,
      occurrence: task.rows[2] ?? null,
      progress: task.rows[3] ?? null,
      joint: null,
      personal: null,
      answer: null,
    },
    { drafts: [], attention: [] },
    ME,
    Date.now(),
  );
  if (result.kind !== "row") throw new Error("setup: the row did not parse");
  return result.row;
}

describe("the correction owner: compare-and-consume (C4)", () => {
  const state = (minimum: string): CorrectionState => ({
    minimum,
    maximum: "",
    unit: "cups",
    labels: {},
    date: "2026-10-13",
    time: "",
    openDaysBefore: "0",
    closeDaysAfter: "0",
  });
  const key = correctionKey(`${ME}:1`, "occ");

  test("control: a success with the submitted revision still current consumes the entry", () => {
    const e = openCorrection(key, `${ME}:1`, () => state("10"));
    editCorrection(key, e.session, state("12"));
    const ticket = submitCorrection(key, e.session);
    if (ticket === null) throw new Error("setup");
    expect(completeCorrection(ticket, true)).toBe("consumed");
    expect(correctionEntry(key)).toBeNull();
  });

  test("an edit after the submission, even back to the submitted value, is newer input", () => {
    const e = openCorrection(key, `${ME}:1`, () => state("10"));
    editCorrection(key, e.session, state("12"));
    const ticket = submitCorrection(key, e.session);
    if (ticket === null) throw new Error("setup");
    editCorrection(key, e.session, state("15"));
    editCorrection(key, e.session, state("12"));
    expect(completeCorrection(ticket, true)).toBe("kept");
    expect(correctionEntry(key)?.state.minimum).toBe("12");
    expect(correctionEntry(key)?.submitting).toBeNull();
  });

  test("a discarded session's ticket matches nothing in the next one (numbers are never reused)", () => {
    const first = openCorrection(key, `${ME}:1`, () => state("10"));
    const ticket = submitCorrection(key, first.session);
    if (ticket === null) throw new Error("setup");
    discardCorrection(key, first.session);
    releaseCorrection(key, first.session);
    const second = openCorrection(key, `${ME}:1`, () => state("10"));
    expect(second.session).not.toBe(first.session);
    expect(second.revision).toBe(ticket.revision);
    expect(completeCorrection(ticket, true)).toBe("gone");
    expect(correctionEntry(key)?.session).toBe(second.session);
  });

  test("a failed save consumes nothing", () => {
    const e = openCorrection(key, `${ME}:1`, () => state("10"));
    const ticket = submitCorrection(key, e.session);
    if (ticket === null) throw new Error("setup");
    expect(completeCorrection(ticket, false)).toBe("kept");
    expect(correctionEntry(key)?.session).toBe(e.session);
  });

  test("another identity's sessions are dropped when the displayed identity opens one", () => {
    openCorrection(key, `${ME}:1`, () => state("10"));
    const other = correctionKey(`${ME}:2`, "occ");
    openCorrection(other, `${ME}:2`, () => state("10"));
    expect(correctionEntry(key)).toBeNull();
    expect(correctionEntry(other)).not.toBeNull();
  });

  test("a release reopened in the same turn resumes the session (a development remount); one not reopened ends it", async () => {
    const first = openCorrection(key, `${ME}:1`, () => state("10"));
    editCorrection(key, first.session, state("11"));
    releaseCorrection(key, first.session);
    const again = openCorrection(key, `${ME}:1`, () => state("10"));
    expect(again.session).toBe(first.session);
    expect(again.state.minimum).toBe("11");
    releaseCorrection(key, again.session);
    await new Promise((r) => setTimeout(r, 0));
    expect(correctionEntry(key)).toBeNull();
  });
});

describe("the correction dialog across mounts (S1, S2, S5)", () => {
  const providers = (children: ReactNode) => (
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
          onOpenSync: () => undefined,
        }}
      >
        <SyncStatusProvider
          value={{
            model: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpen: () => undefined,
          }}
        >
          {children}
        </SyncStatusProvider>
      </ShellEnvProvider>
    </ProtectedProviders>
  );
  const minimum = () =>
    within(screen.getByRole("dialog")).getByLabelText(
      CORRECTION_COPY.minimum,
    ) as HTMLInputElement;
  const saveButton = () =>
    within(screen.getByRole("dialog")).getByRole("button", {
      name: CORRECTION_COPY.save,
    }) as HTMLButtonElement;
  const syncChip = () => {
    const chip = within(screen.getByRole("dialog"))
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip).toBeDefined();
    return chip as HTMLElement;
  };
  function open(
    row: RowModel,
    enqueue: TaskActions["enqueue"],
    identity = `${ME}:1`,
  ) {
    const onClose = vi.fn<() => void>();
    const view = render(
      providers(
        <CorrectionDialog
          row={row}
          identity={identity}
          open
          onClose={onClose}
          actions={{ enqueue }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    return { onClose, view };
  }
  /** Submit `value`, keep the draft through the in-dialog sync control, and unmount (the person is in the queue). */
  async function submitAndRetain(
    row: RowModel,
    value: string,
  ): Promise<{
    save: ReturnType<typeof held<SaveResult>>;
    enqueue: ReturnType<typeof vi.fn<TaskActions["enqueue"]>>;
    onClose: ReturnType<typeof vi.fn<() => void>>;
  }> {
    const save = held<SaveResult>();
    const enqueue = vi.fn<TaskActions["enqueue"]>(() => save.promise);
    const first = open(row, enqueue);
    fireEvent.change(minimum(), { target: { value } });
    fireEvent.click(saveButton());
    expect(enqueue).toHaveBeenCalledOnce();
    fireEvent.click(syncChip());
    expect(first.onClose).toHaveBeenCalledOnce();
    first.view.unmount();
    return { save, enqueue, onClose: first.onClose };
  }

  test("S1: A=12 saved and retained, B=15 entered after reopening and retained again; A's success keeps 15", async () => {
    const row = await rowFor();
    const a = await submitAndRetain(row, "12");
    const second = open(row, vi.fn());
    expect(minimum().value).toBe("12");
    fireEvent.change(minimum(), { target: { value: "15" } });
    fireEvent.click(syncChip());
    second.view.unmount();
    await act(async () => a.save.resolve(ok("a")));
    const third = open(row, vi.fn());
    expect(minimum().value).toBe("15");
    expect(third.onClose).not.toHaveBeenCalled();
  });

  test("control: the same schedule with A failing keeps 15", async () => {
    const row = await rowFor();
    const a = await submitAndRetain(row, "12");
    const second = open(row, vi.fn());
    fireEvent.change(minimum(), { target: { value: "15" } });
    fireEvent.click(syncChip());
    second.view.unmount();
    await act(async () => a.save.resolve(failed));
    open(row, vi.fn());
    expect(minimum().value).toBe("15");
  });

  test("S1: A's success while its unchanged draft is retained consumes it: the next dialog starts from the day", async () => {
    const row = await rowFor();
    const a = await submitAndRetain(row, "12");
    await act(async () => a.save.resolve(ok("a")));
    open(row, vi.fn());
    expect(minimum().value).toBe("10");
  });

  test("S1: A's success after reopening with nothing edited closes the REOPENED editor (it holds the saved draft), never through the old mount", async () => {
    const row = await rowFor();
    const a = await submitAndRetain(row, "12");
    const second = open(row, vi.fn());
    expect(minimum().value).toBe("12");
    // The save is still pending in the reopened dialog: Save waits.
    expect(saveButton().disabled).toBe(true);
    await act(async () => a.save.resolve(ok("a")));
    expect(second.onClose).toHaveBeenCalledOnce();
    expect(a.onClose).toHaveBeenCalledOnce();
  });

  test("S1: A's success after reopening and a newer edit leaves the reopened editor open with B; B's own save then completes it", async () => {
    const row = await rowFor();
    const a = await submitAndRetain(row, "12");
    const bSave = held<SaveResult>();
    const bEnqueue = vi.fn<TaskActions["enqueue"]>(() => bSave.promise);
    const second = open(row, bEnqueue);
    fireEvent.change(minimum(), { target: { value: "15" } });
    await act(async () => a.save.resolve(ok("a")));
    expect(second.onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("15");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(bEnqueue).toHaveBeenCalledOnce();
    await act(async () => bSave.resolve(ok("b")));
    expect(second.onClose).toHaveBeenCalledOnce();
  });

  test("S2: Cancel, then the same day opened again and edited: the earlier save's success neither closes nor clears it", async () => {
    const row = await rowFor();
    const save = held<SaveResult>();
    const enqueue = vi.fn<TaskActions["enqueue"]>(() => save.promise);
    const first = open(row, enqueue);
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(saveButton());
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: CORRECTION_COPY.cancel,
      }),
    );
    expect(first.onClose).toHaveBeenCalledOnce();
    first.view.unmount();
    const second = open(row, vi.fn());
    expect(minimum().value).toBe("10");
    fireEvent.change(minimum(), { target: { value: "15" } });
    await act(async () => save.resolve(ok("a")));
    expect(second.onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("15");
    // The earlier save was made: discarding the editor did not cancel it.
    expect(enqueue).toHaveBeenCalledOnce();
  });

  test("S2: Cancel, then the same day opened again with NOTHING edited: the earlier save's success still closes nothing", async () => {
    const row = await rowFor();
    const save = held<SaveResult>();
    const first = open(
      row,
      vi.fn<TaskActions["enqueue"]>(() => save.promise),
    );
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(saveButton());
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: CORRECTION_COPY.cancel,
      }),
    );
    first.view.unmount();
    const second = open(row, vi.fn());
    await act(async () => save.resolve(ok("a")));
    expect(second.onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("10");
  });

  test("S2: another identity's dialog for the same day is a new session; the first identity's save completes nothing in it", async () => {
    const row = await rowFor();
    const a = await submitAndRetain(row, "12");
    const other = open(row, vi.fn(), `${ME}:2`);
    expect(minimum().value).toBe("10");
    fireEvent.change(minimum(), { target: { value: "15" } });
    await act(async () => a.save.resolve(ok("a")));
    expect(other.onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("15");
    other.view.unmount();
    // Back as the first identity: its retained session went with the identity change.
    open(row, vi.fn());
    expect(minimum().value).toBe("10");
  });

  test("S5: a save that throws keeps the dialog open with the input, and Save can be used again", async () => {
    const row = await rowFor();
    const save = held<SaveResult>();
    const dialog = open(
      row,
      vi.fn<TaskActions["enqueue"]>(() => save.promise),
    );
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(saveButton());
    expect(saveButton().disabled).toBe(true);
    await act(async () => save.reject(new Error("storage exploded")));
    expect(dialog.onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("12");
    expect(saveButton().disabled).toBe(false);
  });
});

describe("the fix of an entry: the parent closes only the fix session that saved (S3)", () => {
  async function fixingView(record: TaskActions["record"]) {
    const entry = {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      evidence: { kind: "quantity", amount: "3" },
      happened_at: Math.floor(Date.now() / 1000),
      recorded_by: ME,
    };
    const row = await rowFor({
      recent_entries: [entry] as never,
      entry_count: 1,
    });
    render(
      <TasksEnvProvider value={tasksEnv(fakeApi(), { online: false })}>
        <EntryHistory row={row} actions={{ record }} zone="UTC" writable />
      </TasksEnvProvider>,
    );
  }
  const value = () =>
    screen.getByLabelText(
      new RegExp(`^${HISTORY_COPY.newValue}`),
    ) as HTMLInputElement;
  const form = () => document.querySelector("[data-fix-form]");

  test("a fix saved, cancelled and opened again for the SAME entry: the earlier save's success leaves the new fix open", async () => {
    const save = held<SaveResult>();
    const record = vi.fn<TaskActions["record"]>(() => save.promise);
    await fixingView(record);
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fix }));
    fireEvent.change(value(), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fixSave }));
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.cancel }));
    expect(form()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fix }));
    expect(value().value).toBe("3");
    fireEvent.change(value(), { target: { value: "5" } });
    await act(async () => save.resolve(ok()));
    expect(form()).not.toBeNull();
    expect(value().value).toBe("5");
  });

  test("control: reopened with nothing typed, the earlier save's success still leaves the new fix open", async () => {
    const save = held<SaveResult>();
    const record = vi.fn<TaskActions["record"]>(() => save.promise);
    await fixingView(record);
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fix }));
    fireEvent.change(value(), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fixSave }));
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.cancel }));
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fix }));
    await act(async () => save.resolve(ok()));
    expect(form()).not.toBeNull();
  });
});

describe("the task form never navigates the person away after they left it (S3)", () => {
  async function formWithHeldSave() {
    const t = await mountTasks({ path: "/tasks/new", env: { online: false } });
    await t.until(
      () =>
        screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: PRESET_COPY.scratch }));
    await t.until(() => document.querySelector("[data-task-form]") !== null);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const real = outbox.enqueue.bind(outbox);
    const gate = held<void>();
    outbox.enqueue = async (request) => {
      await gate.promise;
      return real(request);
    };
    fireEvent.change(screen.getByLabelText(FORM_COPY.name), {
      target: { value: "Water the plants" },
    });
    fireEvent.click(
      screen.getByRole("radio", { name: FORM_COPY.sharingOnlyMe }),
    );
    fireEvent.click(screen.getByRole("button", { name: FORM_COPY.save }));
    await t.settle();
    return { t, gate };
  }

  test("saved, then the person went to the task list: the late success leaves them there", async () => {
    const { t, gate } = await formWithHeldSave();
    await act(async () => {
      await t.router.navigate({ to: "/tasks", search: {} });
    });
    await t.settle();
    expect(t.router.state.location.pathname).toBe("/tasks");
    await act(async () => gate.resolve());
    await t.settle();
    expect(t.drafts().map((d) => d.kind)).toEqual(["create_task"]);
    expect(t.router.state.location.pathname).toBe("/tasks");
  });

  test("control: still on the form, the success opens the new task's detail", async () => {
    const { t, gate } = await formWithHeldSave();
    await act(async () => gate.resolve());
    await t.until(() => t.router.state.location.pathname !== "/tasks/new");
    expect(t.router.state.location.pathname).toMatch(/^\/tasks\/[0-9a-f-]+$/);
  });
});

test("correctionFrom is the dialog's starting state (sanity for the cases above)", async () => {
  const row = await rowFor();
  expect(correctionFrom(row.data).minimum).toBe("10");
});

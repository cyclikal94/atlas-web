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
  EntryHistory,
  HISTORY_COPY,
} from "../../../src/features/tasks/detail/EntryHistory";
import {
  RECORD_COPY,
  RecordCard,
} from "../../../src/features/tasks/detail/RecordCard";
import { TasksEnvProvider } from "../../../src/features/tasks/env";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { composeRow, type RowModel } from "../../../src/features/tasks/view";
import { installMatchMedia } from "../../helpers/match-media";
import { fakeApi, ME, seededTask, tasksEnv } from "../../support/tasks/world";

/**
 * R3 (review of 13 October 2026, family `task-save-acknowledgement-consumes-newer-edits`; PRODUCT-DECISIONS-20261011): a save's success
 * acknowledges the input it SUBMITTED, never input entered while it was pending. Each case holds the save, edits, then answers it; the
 * controls are the same act with no newer edit (the success clears or closes) and a failed save (the input is kept).
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
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ok = (localId = "saved"): SaveResult => ({ ok: true, localId });
const failed: SaveResult = { ok: false, message: "storage" };

async function rowFor(
  goal: {
    kind: "numeric";
    minimum: string | null;
    maximum: string | null;
    unit: string;
  },
  progress: NonNullable<Parameters<typeof seededTask>[0]>["progress"] = {},
): Promise<RowModel> {
  const task = await seededTask({ definition: { goal }, progress });
  const result = composeRow(
    {
      occurrenceId: task.occurrenceId,
      progressId: task.progressId,
      task: task.rows[0] ?? null,
      occurrence: task.rows[2] ?? null,
      progress: task.rows[3] ?? null,
      joint: null,
      personal: null,
      answeredAt: null,
    },
    { drafts: [], attention: [] },
    ME,
    Date.now(),
  );
  if (result.kind !== "row") throw new Error("setup: the row did not parse");
  return result.row;
}
const cups = {
  kind: "numeric" as const,
  minimum: "10",
  maximum: null,
  unit: "cups",
};

describe("the Record progress amount", () => {
  const amount = () =>
    screen.getByLabelText(`${RECORD_COPY.amount} (cups)`) as HTMLInputElement;
  async function submitThen(
    edit: string | null,
    answer: SaveResult,
  ): Promise<ReturnType<typeof vi.fn<TaskActions["record"]>>> {
    const save = held<SaveResult>();
    const record = vi.fn<TaskActions["record"]>(() => save.promise);
    render(
      <RecordCard
        row={await rowFor(cups)}
        actions={{ record }}
        now={Date.now()}
        zone="UTC"
        writable
      />,
    );
    fireEvent.change(amount(), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[1]).toEqual({
      kind: "quantity",
      amount: "2",
    });
    if (edit !== null) fireEvent.change(amount(), { target: { value: edit } });
    await act(async () => save.resolve(answer));
    return record;
  }

  test("control: a success with nothing typed since clears the field", async () => {
    await submitThen(null, ok());
    expect(amount().value).toBe("");
  });

  test("an amount typed while the save was pending stays after its success", async () => {
    await submitThen("5", ok());
    expect(amount().value).toBe("5");
  });

  test("control: a failed save keeps what is in the field", async () => {
    await submitThen("5", failed);
    expect(amount().value).toBe("5");
  });
});

describe("the correction dialog", () => {
  const providers = (children: ReactNode, onOpen = () => undefined) => (
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
          onOpenSync: onOpen,
        }}
      >
        <SyncStatusProvider
          value={{
            model: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpen,
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

  async function open(
    enqueue: TaskActions["enqueue"],
    onClose = vi.fn<() => void>(),
  ) {
    const row = await rowFor(cups);
    const view = render(
      providers(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={onClose}
          actions={{ enqueue }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    return { row, onClose, view };
  }

  test("control: a success with nothing edited since closes the dialog", async () => {
    const save = held<SaveResult>();
    const enqueue = vi.fn<TaskActions["enqueue"]>(() => save.promise);
    const { onClose } = await open(enqueue);
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.save }));
    expect(enqueue).toHaveBeenCalledOnce();
    await act(async () => save.resolve(ok("c1")));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("an edit made while the save was pending keeps the dialog open with the newer value", async () => {
    const save = held<SaveResult>();
    const enqueue = vi.fn<TaskActions["enqueue"]>(() => save.promise);
    const { onClose } = await open(enqueue);
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.save }));
    fireEvent.change(minimum(), { target: { value: "15" } });
    await act(async () => save.resolve(ok("c2")));
    expect(onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("15");
  });

  test("a newer edit kept while the person went to the queue survives the older save's success", async () => {
    const save = held<SaveResult>();
    const enqueue = vi.fn<TaskActions["enqueue"]>(() => save.promise);
    const { row, onClose, view } = await open(enqueue);
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.save }));
    fireEvent.change(minimum(), { target: { value: "15" } });
    // The in-dialog sync control keeps the draft for this occurrence and identity, and leaves.
    const chip = within(screen.getByRole("dialog"))
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip).toBeDefined();
    fireEvent.click(chip as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => save.resolve(ok("c3")));
    // Back from the queue: the dialog opens on the newer edit, not on the saved values.
    render(
      providers(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={vi.fn()}
          actions={{ enqueue: vi.fn<TaskActions["enqueue"]>() }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    expect(minimum().value).toBe("15");
  });

  test("control: a failed save keeps the dialog open with the person's values", async () => {
    const save = held<SaveResult>();
    const enqueue = vi.fn<TaskActions["enqueue"]>(() => save.promise);
    const { onClose } = await open(enqueue);
    fireEvent.change(minimum(), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.save }));
    await act(async () => save.resolve(failed));
    expect(onClose).not.toHaveBeenCalled();
    expect(minimum().value).toBe("12");
  });
});

describe("the fix of one entry", () => {
  async function fixing(record: TaskActions["record"]) {
    const entry = {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      evidence: { kind: "quantity", amount: "3" },
      happened_at: Math.floor(Date.now() / 1000),
      recorded_by: ME,
    };
    const row = await rowFor(cups, {
      recent_entries: [entry] as never,
      entry_count: 1,
    });
    render(
      <TasksEnvProvider value={tasksEnv(fakeApi(), { online: false })}>
        <EntryHistory row={row} actions={{ record }} zone="UTC" writable />
      </TasksEnvProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fix }));
  }
  const value = () =>
    screen.getByLabelText(
      new RegExp(`^${HISTORY_COPY.newValue}`),
    ) as HTMLInputElement;
  const form = () => document.querySelector("[data-fix-form]");

  test("control: a success with nothing typed since closes the fix", async () => {
    const save = held<SaveResult>();
    const record = vi.fn<TaskActions["record"]>(() => save.promise);
    await fixing(record);
    fireEvent.change(value(), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fixSave }));
    await act(async () => save.resolve(ok()));
    expect(form()).toBeNull();
  });

  test("a value typed while the save was pending stays in the open fix; Save waits for the pending one", async () => {
    const save = held<SaveResult>();
    const record = vi.fn<TaskActions["record"]>(() => save.promise);
    await fixing(record);
    fireEvent.change(value(), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fixSave }));
    // One attempt at a time: a second Save while the first is pending sends nothing.
    fireEvent.click(screen.getByRole("button", { name: HISTORY_COPY.fixSave }));
    expect(record).toHaveBeenCalledOnce();
    fireEvent.change(value(), { target: { value: "6" } });
    await act(async () => save.resolve(ok()));
    expect(form()).not.toBeNull();
    expect(value().value).toBe("6");
  });
});

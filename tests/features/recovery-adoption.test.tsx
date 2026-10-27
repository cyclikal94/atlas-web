import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { ShellEnvProvider } from "../../src/app/shell/env";
import { SyncStatusProvider } from "../../src/components/ui/sync-status";
import { DataEnvProvider } from "../../src/data/ui/react";
import { SignInForm } from "../../src/features/authentication/SignInForm";
import {
  ADD_CONTEXT,
  AddSourceDialog,
} from "../../src/features/calendars/AddSourceDialog";
import type { TaskActions } from "../../src/features/tasks/actions";
import {
  CORRECTION_COPY,
  CorrectionDialog,
  CorrectionRecoveryHost,
  forgetAllCorrections,
} from "../../src/features/tasks/detail/CorrectionDialog";
import {
  RECORD_COPY,
  RecordCard,
} from "../../src/features/tasks/detail/RecordCard";
import { TasksEnvProvider } from "../../src/features/tasks/env";
import { forgetKept } from "../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../src/features/tasks/memory";
import { composeRow, type RowModel } from "../../src/features/tasks/view";
import { forgetRecoverableEditors } from "../../src/lib/form-recovery/editor";
import { handoffHandles } from "../../src/lib/form-recovery/handoff";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import { RESTORED_TEXT } from "../../src/lib/form-recovery/RecoveryBanner";
import {
  flushDirty,
  pageFormRegistry,
} from "../../src/lib/form-recovery/registry";
import { installMatchMedia } from "../helpers/match-media";
import { stubEnv } from "../support/data/ui-env";
import { Locks } from "../support/recovery-pages";
import { fakeApi, ME, seededTask, tasksEnv } from "../support/tasks/world";

/**
 * WEB-14a revision 37 (review of 25 October 2026, R40 `production-form-update-recovery-registration`; design assessment Q2-Q5 at the
 * component boundary). The PRODUCT editors (not the fixture form), each with the page's real form registry, recovery identity (over a Web
 * Locks double), recoverable model and session, through a data env whose recovery port is open over the memory store: what an accepted
 * update saves for each of them (`flushDirty`, as the coordinator's "Save and reload"), what a page restores from a copy a gone tab left
 * (nothing sent), the freeze, and an unreadable copy. The real worker/store/coordinator and the new-task route in three engines are
 * `tests/e2e/fixture.pwa-editors.spec.ts`.
 */
installMatchMedia({ width: 1440 });
const locks = new Locks();
beforeAll(() => {
  // The page's recovery identity is made at its first use from `navigator.locks` (jsdom has none).
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks.forPage("this-page"),
  });
});

let store = new MemoryRecoveryAdapter();
let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
  cleanup();
  forgetKept();
  forgetTaskMemory();
  forgetAllCorrections();
  forgetRecoverableEditors();
  for (const handle of handoffHandles(pageFormRegistry))
    void handle.discard?.();
  store = new MemoryRecoveryAdapter();
  vi.restoreAllMocks();
});

/** A data env whose recovery port is OPEN over `store` (the fake resource service has none of its own). */
function dataEnv() {
  const env = stubEnv();
  const open = { get: () => true, subscribe: () => () => undefined };
  return { ...env, formRecovery: store, formRecoveryOpen: open };
}

/** A copy another tab left (its tab has gone: no lock holds its id), as the store keeps it. */
async function left(formContext: string, text: string): Promise<void> {
  expect(
    await store.save({
      formContext,
      tabInstanceId: "gone-tab",
      values: { model: text },
      savedAt: new Date().toISOString(),
      capture: "gone-capture",
    }),
  ).toBe("saved");
}

const contextsOf = (handles: readonly { formContext: string }[]) =>
  handles.map((handle) => handle.formContext).sort();

async function rowFor(): Promise<RowModel> {
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
    },
  });
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

function protectedTree(children: ReactNode) {
  return (
    <DataEnvProvider env={dataEnv() as never}>
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
            <TasksEnvProvider value={tasksEnv(fakeApi())}>
              {children}
            </TasksEnvProvider>
          </SyncStatusProvider>
        </ShellEnvProvider>
      </ProtectedProviders>
    </DataEnvProvider>
  );
}

describe("the Record progress amount (record:<progress>)", () => {
  const amount = () =>
    screen.getByLabelText(`${RECORD_COPY.amount} (cups)`) as HTMLInputElement;
  const card = (row: RowModel, record: TaskActions["record"]) => (
    <RecordCard
      row={row}
      actions={{ record }}
      now={Date.now()}
      zone="UTC"
      writable
    />
  );

  test("typed input makes the card a dirty registered form, and the update's save writes its raw text (nothing recorded)", async () => {
    const row = await rowFor();
    const record = vi.fn<TaskActions["record"]>();
    render(protectedTree(card(row, record)));
    await waitFor(() =>
      expect(contextsOf(pageFormRegistry.all())).toContain(
        `record:${row.progressId}`,
      ),
    );
    expect(pageFormRegistry.dirty()).toHaveLength(0);
    fireEvent.change(amount(), { target: { value: "2.5x" } });
    expect(contextsOf(pageFormRegistry.dirty())).toEqual([
      `record:${row.progressId}`,
    ]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const copies = await store.list(`record:${row.progressId}`);
    expect(copies.map((copy) => JSON.parse(copy.values.model ?? ""))).toEqual([
      { v: 1, mode: "amount", amount: "2.5x" },
    ]);
    expect(record).not.toHaveBeenCalled();
  });

  test("a copy left for this progress is restored into the card, raw, with the restored banner; nothing is recorded until Record", async () => {
    const row = await rowFor();
    await left(
      `record:${row.progressId}`,
      JSON.stringify({ v: 1, mode: "amount", amount: "7" }),
    );
    const record = vi.fn<TaskActions["record"]>(async () => ({
      ok: true as const,
      localId: "r1",
    }));
    render(protectedTree(card(row, record)));
    await waitFor(() => expect(amount().value).toBe("7"));
    expect(
      screen.getByText(RESTORED_TEXT, { selector: "p" }),
    ).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[1]).toEqual({
      kind: "quantity",
      amount: "7",
    });
  });

  test("CONTROL: a copy left for ANOTHER progress is not restored into this card", async () => {
    const row = await rowFor();
    await left(
      "record:another-progress",
      JSON.stringify({ v: 1, mode: "amount", amount: "7" }),
    );
    render(protectedTree(card(row, vi.fn())));
    await waitFor(() =>
      expect(contextsOf(pageFormRegistry.all())).toContain(
        `record:${row.progressId}`,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(amount().value).toBe("");
  });

  test("a copy of another version is offered, never restored in part", async () => {
    const row = await rowFor();
    await left(
      `record:${row.progressId}`,
      JSON.stringify({ v: 99, mode: "amount", amount: "7" }),
    );
    render(protectedTree(card(row, vi.fn())));
    await waitFor(() =>
      expect(
        screen.queryByText("Other saved copies of this form:"),
      ).not.toBeNull(),
    );
    expect(amount().value).toBe("");
    expect(await store.list(`record:${row.progressId}`)).toHaveLength(1);
  });

  test("input the owner drops (the card goes with no visit keeping it) takes its saved copies with it: nothing comes back later", async () => {
    const row = await rowFor();
    const view = render(protectedTree(card(row, vi.fn())));
    fireEvent.change(amount(), { target: { value: "9" } });
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(await store.list(`record:${row.progressId}`)).toHaveLength(1);
    view.unmount();
    await waitFor(async () =>
      expect(await store.list(`record:${row.progressId}`)).toHaveLength(0),
    );
  });

  test("while an update reload is prepared the card takes no input and records nothing", async () => {
    const row = await rowFor();
    const record = vi.fn<TaskActions["record"]>();
    render(protectedTree(card(row, record)));
    fireEvent.change(amount(), { target: { value: "3" } });
    act(() => {
      release = pageFormRegistry.freeze();
    });
    fireEvent.change(amount(), { target: { value: "4" } });
    expect(amount().value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(record).not.toHaveBeenCalled();
  });
});

describe("the occurrence correction (occurrence-correction:<occurrence>)", () => {
  const minimum = () =>
    within(screen.getByRole("dialog")).getByLabelText(
      CORRECTION_COPY.minimum,
    ) as HTMLInputElement;

  test("the detail's host restores a correction left for its day and opens the dialog on it; nothing is saved", async () => {
    const row = await rowFor();
    const enqueue = vi.fn<TaskActions["enqueue"]>();
    // The copy as a page of this build writes it: the dialog's own state with the minimum typed.
    const opened = render(
      protectedTree(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={() => undefined}
          actions={{ enqueue }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    fireEvent.change(minimum(), { target: { value: "12" } });
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const [copy] = await store.list(`occurrence-correction:${row.id}`);
    if (!copy) throw new Error("no copy saved");
    opened.unmount();
    // A gone tab's copy for the same day, as another page would find it.
    forgetAllCorrections();
    store = new MemoryRecoveryAdapter();
    await left(`occurrence-correction:${row.id}`, copy.values.model ?? "");
    const onRestored = vi.fn<(id: string) => void>();
    render(
      protectedTree(
        <CorrectionRecoveryHost
          row={row}
          identity={`${ME}:1`}
          onRestored={onRestored}
        />,
      ),
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(row.id));
    cleanup();
    render(
      protectedTree(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={() => undefined}
          actions={{ enqueue }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    expect(minimum().value).toBe("12");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("the occurrence correction opened directly (its own look)", () => {
  test("a copy left for the day is restored into the open, untouched dialog; nothing is saved until Save", async () => {
    const row = await rowFor();
    await left(
      `occurrence-correction:${row.id}`,
      JSON.stringify({
        v: 1,
        state: {
          minimum: "14",
          maximum: "",
          unit: "cups",
          date: row.data.slot.date ?? "",
          time: "",
          openDaysBefore: "0",
          closeDaysAfter: "0",
          labels: {},
          keptTime: null,
          timeUnconfirmed: false,
        },
      }),
    );
    const enqueue = vi.fn<TaskActions["enqueue"]>();
    render(
      protectedTree(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={() => undefined}
          actions={{ enqueue }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    const minimum = () =>
      within(screen.getByRole("dialog")).getByLabelText(
        CORRECTION_COPY.minimum,
      ) as HTMLInputElement;
    await waitFor(() => expect(minimum().value).toBe("14"));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("the calendar Add source form (calendar-add)", () => {
  test("restored into the open form, label and timezone, nothing queued; typed input is saved by the update", async () => {
    await left(
      ADD_CONTEXT,
      JSON.stringify({ v: 1, label: "Swim club", timezone: "Europe/London" }),
    );
    render(
      protectedTree(
        <AddSourceDialog
          online
          identity={`${ME}:1`}
          onClose={() => undefined}
        />,
      ),
    );
    const label = () =>
      screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement;
    await waitFor(() => expect(label().value).toBe("Swim club"));
    // Restored from a gone tab's copy: dirty until this page has a copy of its own, which the update's save writes.
    expect(contextsOf(pageFormRegistry.dirty())).toEqual([ADD_CONTEXT]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
  });
});

/**
 * LABELLED ADAPTATION (revision 38): revision 37 asserted that this save FAILS, because where pre-account input may be kept was an open owner
 * decision. Kieran decided it (WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026, hand-off sha256 e802f52e…ebaec3): the username only, in this
 * tab's session storage. The other intents are kept as they were: the typed username counts for the update, and it is never written to the
 * account's store. The original case is preserved in `.agtx/evidence/revision-r38-20261026/adaptations/`; the decision's own lifecycle,
 * isolation and failure cases are `tests/lib/pre-account-recovery.test.tsx`.
 */
describe("sign-in before any account is displayed (WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026)", () => {
  test("a typed username counts for the update; it is saved in this tab's session storage, never in the account's store", async () => {
    render(
      protectedTree(
        <SignInForm
          online
          initialUsername=""
          onSubmit={vi.fn()}
          onSso={vi.fn()}
        />,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /username/i }), {
      target: { value: "alice" },
    });
    expect(contextsOf(pageFormRegistry.dirty())).toEqual(["sign-in"]);
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    expect(await store.list("sign-in")).toHaveLength(0);
    expect(
      Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith("atlas-preaccount-recovery:"),
      ),
    ).toHaveLength(1);
    window.sessionStorage.clear();
  });
});

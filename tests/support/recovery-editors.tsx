import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, vi } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { ShellEnvProvider } from "../../src/app/shell/env";
import { SyncStatusProvider } from "../../src/components/ui/sync-status";
import { DataEnvProvider } from "../../src/data/ui/react";
import { forgetSessionRecovery } from "../../src/features/calendars/session-recovery";
import { forgetHouseholdsMemory } from "../../src/features/sharing/households/memory";
import { forgetAllCorrections } from "../../src/features/tasks/detail/CorrectionDialog";
import { forgetKeptFixes } from "../../src/features/tasks/detail/EntryHistory";
import { type TasksEnv, TasksEnvProvider } from "../../src/features/tasks/env";
import { forgetKept } from "../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../src/features/tasks/memory";
import { composeRow, type RowModel } from "../../src/features/tasks/view";
import { forgetRecoverableEditors } from "../../src/lib/form-recovery/editor";
import { handoffHandles } from "../../src/lib/form-recovery/handoff";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import type { FormRecoveryPort } from "../../src/lib/form-recovery/port";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import { stubEnv } from "./data/ui-env";
import { Locks } from "./recovery-pages";
import { fakeApi, ME, seededTask, tasksEnv } from "./tasks/world";

/**
 * The product editors' recovery world for component tests (WEB-14a revision 38; the setup of `tests/features/recovery-adoption.test.tsx`,
 * shared): the page's real form registry, recovery identity (over a Web Locks double), recoverable models and sessions, through a data env
 * whose recovery port is OPEN over a memory store the test can hold at its boundaries.
 */
const locks = new Locks();
/**
 * WEB-14a revision 53: the page's Web Locks double, so a test can hold a recovery owner's lock as ANOTHER page does (a live tab, or an
 * older build's exclusive probe: `held.set(name, "OLD")` until `leave("OLD")`).
 */
export const recoveryLocks = (): Locks => locks;

/** The page's recovery identity is made at its first use from `navigator.locks` (jsdom has none): call in `beforeAll`. */
export function installRecoveryLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks.forPage("this-page"),
  });
}

let current = new MemoryRecoveryAdapter();
/** The store the open port writes to now (a fresh one after every test). */
export const store = (): MemoryRecoveryAdapter => current;

let release: (() => void) | null = null;
/** The freeze an update reload's preparation holds (released after the test). */
export function freeze(): void {
  release = pageFormRegistry.freeze();
}
export function unfreeze(): void {
  release?.();
  release = null;
}

/** Every editor, session, model and copy goes (call in `afterEach`). */
export function forgetRecoveryWorld(): void {
  unfreeze();
  cleanup();
  forgetKept();
  forgetTaskMemory();
  forgetAllCorrections();
  forgetKeptFixes();
  forgetRecoverableEditors();
  // M-13b-1: the WEB-13b sessions' bridge to their models (`session-recovery.ts`).
  forgetSessionRecovery();
  // WEB-12b merge correction M-1: the households page memory and its recovery models (`households/form-recovery.ts`).
  forgetHouseholdsMemory();
  for (const handle of handoffHandles(pageFormRegistry))
    void handle.discard?.();
  current = new MemoryRecoveryAdapter();
  vi.restoreAllMocks();
}

/** A data env whose recovery port is OPEN over the store (the fake resource service has none of its own). */
export function dataEnv() {
  const env = stubEnv();
  const open = { get: () => true, subscribe: () => () => undefined };
  return { ...env, formRecovery: current, formRecoveryOpen: open };
}

/** A copy a tab that has gone left (no lock holds its id), as the store keeps it. */
export async function left(
  formContext: string,
  text: string,
  options: { tab?: string; savedAt?: string } = {},
): Promise<void> {
  const tab = options.tab ?? "gone-tab";
  expect(
    await current.save({
      formContext,
      tabInstanceId: tab,
      values: { model: text },
      savedAt: options.savedAt ?? new Date().toISOString(),
      capture: `${tab}-capture`,
    }),
  ).toBe("saved");
}

/** What the store holds for `formContext`, as the owner's codec text. */
export async function texts(formContext: string): Promise<string[]> {
  return (await current.list(formContext)).map(
    (copy) => copy.values.model ?? "",
  );
}

export const contextsOf = (handles: readonly { formContext: string }[]) =>
  handles.map((handle) => handle.formContext).sort();

/**
 * Holds the store's discard of every copy until `release`: `entered` once the first is asked for (an explicit entered/release barrier,
 * never a timer).
 */
export function holdDiscards(): {
  entered(): boolean;
  release(): Promise<void>;
} {
  const original = current.discard.bind(current);
  let open!: () => void;
  let asked = false;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  vi.spyOn(current, "discard").mockImplementation(async (...args) => {
    asked = true;
    await gate;
    return original(...args);
  });
  return {
    entered: () => asked,
    release: async () => {
      open();
      await gate;
    },
  };
}

/** A numeric task's row as Today composes it. */
export async function rowFor(): Promise<RowModel> {
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

/** The protected tree an editor is shown in, over the open recovery port. */
export function protectedTree(
  children: ReactNode,
  tasks: TasksEnv = tasksEnv(fakeApi()),
) {
  return (
    <DataEnvProvider env={dataEnv() as never}>
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount: 1, conflictCount: 0 },
            onOpenSync: () => undefined,
          }}
        >
          <SyncStatusProvider
            value={{
              model: { phase: "synced", pendingCount: 1, conflictCount: 0 },
              onOpen: () => undefined,
            }}
          >
            <TasksEnvProvider value={tasks}>{children}</TasksEnvProvider>
          </SyncStatusProvider>
        </ShellEnvProvider>
      </ProtectedProviders>
    </DataEnvProvider>
  );
}

/**
 * As `holdDiscards`, over a PRODUCTION port (`data/ports/form-recovery.ts`): the model writes through the port `pin()` gives it, so each
 * pinned port's discard is held until `release`.
 */
export function holdPinnedDiscards(port: FormRecoveryPort): {
  entered(): boolean;
  release(): Promise<void>;
} {
  const pin = port.pin?.bind(port);
  if (!pin) throw new Error("setup: the port does not pin");
  const held = new WeakSet<FormRecoveryPort>();
  let open!: () => void;
  let asked = false;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  vi.spyOn(port, "pin").mockImplementation(() => {
    const pinned = pin();
    if (pinned !== null && !held.has(pinned.port)) {
      held.add(pinned.port);
      const discard = pinned.port.discard.bind(pinned.port);
      pinned.port.discard = async (...args) => {
        asked = true;
        await gate;
        return discard(...args);
      };
    }
    return pinned;
  });
  return {
    entered: () => asked,
    release: async () => {
      open();
      await gate;
    },
  };
}

/** `env` (a data env double) with its recovery port OPEN over the store, in place. */
export function withRecovery<T extends object>(env: T): T {
  return Object.assign(env, {
    formRecovery: current,
    formRecoveryOpen: { get: () => true, subscribe: () => () => undefined },
  });
}

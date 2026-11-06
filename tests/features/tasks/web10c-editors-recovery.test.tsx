import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type {
  SetRotaCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import {
  DEPENDENCY_COPY,
  dependencyRecovery,
} from "../../../src/features/tasks/detail/Dependencies";
import {
  ROTA_COPY,
  rotaRecovery,
} from "../../../src/features/tasks/detail/Rota";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import type {
  DependencyItem,
  DependencyPreview,
  RotaState,
  TaskDefinition,
  TaskResult,
} from "../../../src/features/tasks/model/contract";
import {
  dependencyFormContext,
  rotaFormContext,
} from "../../../src/features/tasks/model/recovery";
import { RESTORED_TEXT } from "../../../src/lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../../src/lib/pwa/coordinator";
import { installMatchMedia } from "../../helpers/match-media";
import { FakeOrigin } from "../../pwa/coordinator-world";
import { draftRow } from "../../support/data/rows";
import {
  contextsOf,
  forgetRecoveryWorld,
  installRecoveryLocks,
} from "../../support/recovery-editors";
import { SLOW } from "../../support/tasks/journal";
import {
  fakeApi,
  ME,
  type Mounted,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * WEB-14a maintenance merge of accepted main 3f8fdf94 (WEB-10c), correction D-1 (Kieran's decision "Fix in WEB-14a merge"): WEB-10c's two
 * kept-input editors, the dependency editor ("Set what this waits for", and "Keep editing" of a conflicted set) and the turn order dialog,
 * take part in app-update recovery (Q4) as WEB-14a's other task editors do (`kept-input.ts` revision 37; docs/pwa.md "The product's
 * editors"). Over the app's router, the PRODUCTION data controller and form-recovery port (IndexedDB double), the page's real registry and
 * the PRODUCTION app-update coordinator (worker, clock and reload are doubles, `tests/pwa/coordinator-world.ts`):
 *
 *  - an open editor is a registered form, so an available update offers "Save and reload" (Q4 state 1: the banner's `formsOpen`), and the
 *    person's input makes it dirty;
 *  - accepting the update saves the raw input (the list and strict rule; the order and the roster version it was edited on) and reloads
 *    the tab once;
 *  - after the reload the SCREEN (the day's work, the conflict block, the rota panel) finds the copy and opens the editor on it, restored
 *    and never saved; saving it stays the person's act.
 *
 * The form contexts are spelt out here (not imported), so that on a tree without the correction each test fails at its first assertion
 * (the editor is not registered), not at an import. FIXTURE/COMPONENT evidence (jsdom), not a native browser result.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
/** Every coordinator a test started, disposed after it whatever happened (a frozen registry must never leak into the next test). */
const started: { dispose(): void }[] = [];
afterEach(async () => {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  forgetRecoveryWorld();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const DEPENDENCY_CONTEXT = (occurrence: string, replacing: string | null) =>
  `dependency-editor:${occurrence}:${replacing ?? "new"}`;
const ROTA_CONTEXT = (task: string) => `rota-order:${task}`;

const path = (task: SeededTask) =>
  `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
const editorBody = () =>
  document.querySelector("[data-dependency-editor]") as HTMLElement | null;
const rotaDialog = () =>
  document.querySelector("[data-rota-dialog]") as HTMLElement | null;

/** The live copies of `context` in the account's recovery store, decoded from their raw text. */
async function copies(t: Mounted, context: string): Promise<unknown[]> {
  return (await t.data.formRecovery.list(context)).map((copy) =>
    JSON.parse(copy.values.model ?? "null"),
  );
}

/** A tab of the production coordinator over the production page registry (worker, clock and reload are doubles). */
async function updatingTab() {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.defineProperty(tab, "forms", { value: pageFormRegistry });
  await tab.start();
  if (tab.coordinator) started.push(tab.coordinator);
  return { origin, tab };
}

/**
 * A new version is installed and the person accepts it ("Save and reload"). The coordinator saves what is dirty through the account's store
 * (the IndexedDB double, driven by the world's turns: `t.settle`), waits out the other tabs' flush grace (its own clock), asks the waiting
 * worker to skip waiting and reloads once it has activated. Each round lets the store work and the clock move; the worker activates only
 * once it was asked to.
 */
async function acceptUpdate(
  t: Mounted,
  origin: FakeOrigin,
  tab: Awaited<ReturnType<typeof updatingTab>>["tab"],
): Promise<void> {
  const waiting = await origin.installNew(2);
  await act(async () => {
    tab.actions?.accept();
  });
  let activated = false;
  for (let round = 0; round < 40 && tab.reloads === 0; round += 1) {
    await t.settle();
    await act(async () => {
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    const asked = waiting.messages.some(
      (m) => (m.message as { type?: string }).type === "atlas:skip-waiting",
    );
    if (asked && !activated) {
      activated = true;
      await act(async () => {
        await origin.activate(waiting);
      });
    }
  }
}

/** The page reloads onto the update: page memory (sessions, models) is gone; the tree mounts again where it was. */
async function reload(t: Mounted): Promise<void> {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  act(() => forgetKept());
  t.remount();
  await t.settle();
}

// ---- the dependency editor ---------------------------------------------------------------------------------------------------------
const TOKEN = "d".repeat(64);
const item = (task: SeededTask): DependencyItem => ({
  occurrence_id: task.occurrenceId,
  task_id: task.taskId,
  complete: false,
  can_complete: true,
  progress_version: null,
});
const answer = (
  root: SeededTask,
  prerequisites: DependencyItem[],
): TasksResult<DependencyPreview> => ({
  ok: true,
  value: {
    token: TOKEN,
    items: [...prerequisites, item(root)],
    unavailable: false,
    strict: false,
  },
});

async function dependencies(drafts?: object[]) {
  const root = await seededTask({ title: "Hang the washing" });
  const prerequisite = await seededTask({ title: "Run the washing machine" });
  const api = fakeApi({ readDependencies: async () => answer(root, []) });
  const t = await mountTasks({
    path: path(root),
    rows: [...root.rows, ...prerequisite.rows],
    api,
    env: { online: true },
    ...(drafts ? { drafts } : {}),
  });
  await t.until(
    () =>
      (document.querySelector("[data-dependencies]") as HTMLElement | null)
        ?.dataset.dependencies === "ready",
  );
  return { t, root, prerequisite };
}

/** The editor is open on the preview read when it opened (Save admitted). */
const editorReady = () => editorBody()?.dataset.dependencyEditor === "open";

describe("D-1: the dependency editor (WEB-10c D-10c-7) takes part in app-update recovery", () => {
  test(
    "a new list: registered while open (Save and reload), dirty once a day is added; the accepted update saves the list and strict and reloads once; after the reload the day's work opens the editor on it, restored, never saved",
    SLOW,
    async () => {
      const { t, root, prerequisite } = await dependencies();
      const CONTEXT = DEPENDENCY_CONTEXT(root.occurrenceId, null);
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(editorReady);
      // Q4 state 1: an open recoverable form makes the available update's banner "Save and reload"; untouched, it is not dirty.
      expect(contextsOf(pageFormRegistry.all())).toContain(CONTEXT);
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      await t.until(() =>
        [
          ...(
            screen.getByLabelText(DEPENDENCY_COPY.addTask) as HTMLSelectElement
          ).options,
        ].some((o) => o.value === prerequisite.taskId),
      );
      fireEvent.change(screen.getByLabelText(DEPENDENCY_COPY.addTask), {
        target: { value: prerequisite.taskId },
      });
      await t.until(
        () =>
          (screen.getByLabelText(DEPENDENCY_COPY.addDay) as HTMLSelectElement)
            .options.length > 1,
      );
      fireEvent.change(screen.getByLabelText(DEPENDENCY_COPY.addDay), {
        target: { value: prerequisite.occurrenceId },
      });
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.add }),
      );
      fireEvent.click(screen.getByLabelText(DEPENDENCY_COPY.strictLabel));
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);

      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads, "the update reloaded the tab once").toBe(1);
      expect(await copies(t, CONTEXT)).toEqual([
        { v: 1, list: [prerequisite.occurrenceId], strict: true },
      ]);
      expect(t.drafts(), "nothing was sent").toEqual([]);

      await reload(t);
      await t.until(() => editorBody() !== null);
      expect(editorBody(), "the editor opened on the copy").not.toBeNull();
      await t.until(
        () =>
          editorBody()?.querySelector(
            `[data-editor-item="${prerequisite.occurrenceId}"]`,
          ) != null,
      );
      expect(
        (screen.getByLabelText(DEPENDENCY_COPY.strictLabel) as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(
        within(editorBody() as HTMLElement).queryByText(RESTORED_TEXT),
        "the restored notice",
      ).not.toBeNull();
      expect(t.drafts(), "restored, never saved").toEqual([]);
      // Saving it is the person's act, admitted on the preview read now.
      await t.until(editorReady);
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.save }),
      );
      await t.until(() => t.drafts().length === 1);
      expect(t.bodies()[0]?.command.command).toEqual({
        kind: "set_dependencies",
        occurrence_id: root.occurrenceId,
        expected_version: 1,
        prerequisites: [prerequisite.occurrenceId],
        strict: true,
      });
    },
  );

  test(
    "Keep editing of a conflicted set: registered under the set it replaces; the accepted update saves the edited list; after the reload the conflict block opens the editor on it again, never saved",
    SLOW,
    async () => {
      const root = await seededTask({ title: "Hang the washing" });
      const pre = await seededTask({ title: "Run the washing machine" });
      const local = "70000000-0000-4000-8000-000000000996";
      const conflicted = draftRow({
        local_id: local,
        created_seq: 1,
        kind: "set_dependencies",
        endpoint: "/task-commands",
        account_id: ME,
        status: "version_conflict",
        target_resource_ids: [root.occurrenceId, pre.occurrenceId],
        index_targets: [root.occurrenceId, pre.occurrenceId],
        command: {
          command: {
            kind: "set_dependencies",
            occurrence_id: root.occurrenceId,
            expected_version: 1,
            prerequisites: [pre.occurrenceId],
            strict: false,
          },
        } as never,
      });
      const api = fakeApi({ readDependencies: async () => answer(root, []) });
      const t = await mountTasks({
        path: path(root),
        rows: [...root.rows, ...pre.rows],
        api,
        env: { online: true },
        drafts: [conflicted],
      });
      const CONTEXT = DEPENDENCY_CONTEXT(root.occurrenceId, local);
      await t.until(
        () =>
          screen.queryByRole("button", {
            name: DEPENDENCY_COPY.keepEditing,
          }) !== null,
      );
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.keepEditing }),
      );
      await t.until(editorReady);
      expect(contextsOf(pageFormRegistry.all())).toContain(CONTEXT);
      // The submitted list, edited: its only day removed.
      await t.until(
        () =>
          editorBody()?.querySelector(
            `[data-editor-item="${pre.occurrenceId}"]`,
          ) != null,
      );
      const remove = within(editorBody() as HTMLElement).getByRole("button", {
        name: new RegExp(`^${DEPENDENCY_COPY.remove}: `),
      });
      fireEvent.click(remove);
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);

      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      expect(await copies(t, CONTEXT)).toEqual([
        { v: 1, list: [], strict: false },
      ]);

      await reload(t);
      await t.until(() => editorBody() !== null);
      expect(
        editorBody(),
        "Keep editing opened again on the copy",
      ).not.toBeNull();
      expect(editorBody()).toHaveTextContent(DEPENDENCY_COPY.editorEmpty);
      expect(
        within(editorBody() as HTMLElement).queryByText(RESTORED_TEXT),
        "the restored notice",
      ).not.toBeNull();
      expect(
        t.drafts().map((d) => d.local_id),
        "only the conflicted set: nothing saved",
      ).toEqual([local]);
    },
  );
});

// ---- the turn order dialog ---------------------------------------------------------------------------------------------------------
const rota = (over: Partial<RotaState>): TasksResult<RotaState> => ({
  ok: true,
  value: {
    version: 2,
    participants: [ME],
    consent_version: 3,
    accepted: false,
    eligible_participants: [],
    ...over,
  },
});
const enrolled = {
  ok: true,
  value: {
    version: 1,
    active: true,
    aggregate_consent: true,
    policy: { grants: [], exclude_accounts: [] },
  },
} as const;

async function turnOrder() {
  const task = await seededTask({
    title: "Take the bins out",
    definition: {
      participation: "anyone",
      schedule: {
        repeat: { frequency: "daily", interval: 1 },
      } as TaskDefinition["schedule"],
    },
    occurrence: { rota: { revision: 2, ordinal: 0, account_id: OTHER } },
  });
  // The roster as the server holds it (a test moves it on, as another editor would).
  let roster: Partial<RotaState> = {
    participants: [ME],
    eligible_participants: [ME, OTHER],
  };
  const sent: Array<{ command: SetRotaCommand; key: string }> = [];
  let answerSet: () => TasksResult<TaskResult> = () => ({
    ok: true,
    value: { revision: 4 } as never,
  });
  const api = fakeApi({
    readRota: async () => rota(roster),
    readEnrolment: async () => enrolled as never,
    access: async (command, key) => {
      sent.push({ command: command as SetRotaCommand, key });
      return answerSet();
    },
  });
  const t = await mountTasks({ path: path(task), rows: task.rows, api });
  await t.until(
    () =>
      screen.queryByRole("button", { name: ROTA_COPY.order }) !== null &&
      !(
        screen.getByRole("button", {
          name: ROTA_COPY.order,
        }) as HTMLButtonElement
      ).disabled,
  );
  return {
    t,
    task,
    sent,
    moveRoster: (next: Partial<RotaState>) => {
      roster = { ...roster, ...next };
    },
    answer: (next: () => TasksResult<TaskResult>) => {
      answerSet = next;
    },
  };
}

describe("D-1: the turn order dialog (WEB-10c WF-TASK-05) takes part in app-update recovery", () => {
  test(
    "registered while open (Save and reload), dirty once someone is added; the accepted update saves the order and its roster version and reloads once; after the reload the rota panel opens the dialog on it, restored, never sent",
    SLOW,
    async () => {
      const { t, task, sent } = await turnOrder();
      const CONTEXT = ROTA_CONTEXT(task.taskId);
      fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.order }));
      await t.until(() => rotaDialog() !== null);
      expect(contextsOf(pageFormRegistry.all())).toContain(CONTEXT);
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      fireEvent.click(
        within(rotaDialog() as HTMLElement).getByRole("button", {
          name: `${ROTA_COPY.add}: Someone (2222…)`,
        }),
      );
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);

      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads, "the update reloaded the tab once").toBe(1);
      expect(await copies(t, CONTEXT)).toEqual([
        { v: 1, base: 2, order: [ME, OTHER] },
      ]);
      expect(sent, "nothing was sent").toEqual([]);

      await reload(t);
      await t.until(() => rotaDialog() !== null);
      expect(rotaDialog(), "the dialog opened on the copy").not.toBeNull();
      expect(
        (rotaDialog() as HTMLElement).querySelector("[data-rota-count]"),
      ).toHaveTextContent(ROTA_COPY.count(2));
      expect(
        within(rotaDialog() as HTMLElement).queryByText(RESTORED_TEXT),
        "the restored notice",
      ).not.toBeNull();
      expect(sent, "restored, never sent").toEqual([]);
      // Saving it is the person's act: set_rota at the roster version the order was edited on.
      fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.save }));
      await t.until(() => sent.length === 1);
      expect(sent[0]?.command).toEqual({
        kind: "set_rota",
        task_id: task.taskId,
        expected_version: 2,
        participants: [ME, OTHER],
      });
    },
  );

  test(
    "the roster moved on while the page reloaded: the restored order keeps the version it was edited on, so Save meets the conflict and keeps the edit (never merged)",
    SLOW,
    async () => {
      const { t, task, sent, moveRoster, answer } = await turnOrder();
      fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.order }));
      await t.until(() => rotaDialog() !== null);
      fireEvent.click(
        within(rotaDialog() as HTMLElement).getByRole("button", {
          name: `${ROTA_COPY.add}: Someone (2222…)`,
        }),
      );
      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      // Another editor's change, made while this page reloaded.
      moveRoster({ version: 3, participants: [OTHER] });
      answer(() => ({ ok: false, kind: "conflict" }));
      await reload(t);
      await t.until(() => rotaDialog() !== null);
      expect(rotaDialog(), "the dialog opened on the copy").not.toBeNull();
      expect(
        (rotaDialog() as HTMLElement).querySelector("[data-rota-count]"),
      ).toHaveTextContent(ROTA_COPY.count(2));
      fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.save }));
      await t.until(() => sent.length === 1);
      expect(sent[0]?.command).toEqual({
        kind: "set_rota",
        task_id: task.taskId,
        expected_version: 2,
        participants: [ME, OTHER],
      });
      await t.until(
        () => document.querySelector("[data-rota-conflict]") !== null,
      );
      expect(document.querySelector("[data-rota-conflict]")).toHaveTextContent(
        ROTA_COPY.conflict,
      );
      expect(
        (rotaDialog() as HTMLElement).querySelector("[data-rota-count]"),
      ).toHaveTextContent(ROTA_COPY.count(2));
    },
  );
});

// ---- Cancel after a restore ----------------------------------------------------------------------------------------------------------
describe("D-1: a restored editor opens ONCE; Cancel closes it and keeps WEB-10c's kept input for the visit", () => {
  test(
    "dependency editor: Cancel after a restore closes it for good (no reopening loop); the person's own Set shows the kept list again",
    SLOW,
    async () => {
      const { t, prerequisite } = await dependencies();
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(editorReady);
      await t.until(() =>
        [
          ...(
            screen.getByLabelText(DEPENDENCY_COPY.addTask) as HTMLSelectElement
          ).options,
        ].some((o) => o.value === prerequisite.taskId),
      );
      fireEvent.change(screen.getByLabelText(DEPENDENCY_COPY.addTask), {
        target: { value: prerequisite.taskId },
      });
      await t.until(
        () =>
          (screen.getByLabelText(DEPENDENCY_COPY.addDay) as HTMLSelectElement)
            .options.length > 1,
      );
      fireEvent.change(screen.getByLabelText(DEPENDENCY_COPY.addDay), {
        target: { value: prerequisite.occurrenceId },
      });
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.add }),
      );
      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      await reload(t);
      await t.until(() => editorBody() !== null);
      expect(editorBody(), "the editor opened on the copy").not.toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.cancel }),
      );
      await t.settle();
      await t.settle();
      expect(editorBody(), "Cancel closed the restored editor").toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(() => editorBody() !== null);
      expect(
        editorBody()?.querySelector(
          `[data-editor-item="${prerequisite.occurrenceId}"]`,
        ),
        "the kept list, as WEB-10c keeps it for the visit",
      ).not.toBeNull();
      expect(t.drafts()).toEqual([]);
    },
  );

  test(
    "turn order: Cancel after a restore closes the dialog for good (no reopening loop); nothing is sent",
    SLOW,
    async () => {
      const { t, sent } = await turnOrder();
      fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.order }));
      await t.until(() => rotaDialog() !== null);
      fireEvent.click(
        within(rotaDialog() as HTMLElement).getByRole("button", {
          name: `${ROTA_COPY.add}: Someone (2222…)`,
        }),
      );
      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      await reload(t);
      await t.until(() => rotaDialog() !== null);
      expect(rotaDialog(), "the dialog opened on the copy").not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.cancel }));
      await t.settle();
      await t.settle();
      expect(rotaDialog(), "Cancel closed the restored dialog").toBeNull();
      expect(sent).toEqual([]);
    },
  );
});

// ---- the codecs (pure) ---------------------------------------------------------------------------------------------------------------
describe("D-1: the two codecs (explicitly versioned raw input; an unreadable text restores nothing)", () => {
  const O = "11111111-1111-4111-8111-111111111111";
  const P = "22222222-2222-4222-8222-222222222222";
  test("the contexts are the day's (and the set replaced) and the task's", () => {
    expect(dependencyFormContext(O, null)).toBe(DEPENDENCY_CONTEXT(O, null));
    expect(dependencyFormContext(O, P)).toBe(DEPENDENCY_CONTEXT(O, P));
    expect(rotaFormContext(O)).toBe(ROTA_CONTEXT(O));
    expect(dependencyRecovery(O, P).context).toBe(DEPENDENCY_CONTEXT(O, P));
    expect(rotaRecovery(O).context).toBe(ROTA_CONTEXT(O));
  });

  test("dependency codec: the list and strict round-trip; a malformed, oversized or duplicated list is not read", () => {
    const codec = dependencyRecovery(O, null);
    const start = { list: [], strict: false };
    const value = { list: [P], strict: true };
    expect(codec.decode(codec.encode(value), start)).toEqual(value);
    for (const text of [
      "not json",
      "null",
      JSON.stringify({ v: 2, list: [P], strict: true }),
      JSON.stringify({ v: 1, list: [P], strict: "yes" }),
      JSON.stringify({ v: 1, list: [1], strict: true }),
      JSON.stringify({ v: 1, list: [P, P], strict: true }),
      JSON.stringify({
        v: 1,
        list: Array.from({ length: 33 }, (_, i) => `${P}-${i}`),
        strict: true,
      }),
    ])
      expect(codec.decode(text, start), text).toBeNull();
  });

  test("rota codec: the order and its roster version round-trip; a malformed version, an oversized or duplicated order is not read", () => {
    const codec = rotaRecovery(O);
    const start = { base: 0, order: [] };
    const value = { base: 2, order: [ME, OTHER] };
    expect(codec.decode(codec.encode(value), start)).toEqual(value);
    for (const text of [
      "{",
      JSON.stringify({ v: 1, base: -1, order: [ME] }),
      JSON.stringify({ v: 1, base: 1.5, order: [ME] }),
      JSON.stringify({ v: 1, base: "2", order: [ME] }),
      JSON.stringify({ v: 1, base: 2, order: [ME, ME] }),
      JSON.stringify({
        v: 1,
        base: 2,
        order: Array.from({ length: 9 }, (_, i) => `${ME}-${i}`),
      }),
    ])
      expect(codec.decode(text, start), text).toBeNull();
  });
});

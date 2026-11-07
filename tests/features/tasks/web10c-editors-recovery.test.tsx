import { act, fireEvent, screen, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type {
  SetRotaCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import { GRAPH_DEFAULT_DEPTH } from "../../../src/features/tasks/api";
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
import { present } from "../../support/present";
import {
  contextsOf,
  forgetRecoveryWorld,
  installRecoveryLocks,
} from "../../support/recovery-editors";
import { buildGraph } from "../../support/tasks/graphs";
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

/**
 * WEB-18 merge correction (7 November 2026): the server's view of the root day as WEB-18's editor reads it (`readDependencyGraph`, depth
 * one for the editor): the root's version and its direct prerequisites. A test moves it on as another editor would.
 */
interface ServerDay {
  version: number;
  direct: SeededTask[];
}
const graphOf = (
  root: SeededTask,
  server: ServerDay,
  maxDepth: number | undefined,
) =>
  buildGraph({
    root: root.occurrenceId,
    nodes: [
      {
        id: root.occurrenceId,
        task: root.taskId,
        title: "Hang the washing",
        canEdit: true,
        version: server.version,
      },
      ...server.direct.map((d) => ({
        id: d.occurrenceId,
        task: d.taskId,
        title: "Run the washing machine",
      })),
    ],
    edges: server.direct.map(
      (d) => [d.occurrenceId, root.occurrenceId] as [string, string],
    ),
    maxDepth: maxDepth ?? GRAPH_DEFAULT_DEPTH,
  });
const graphApi = (root: SeededTask, server: ServerDay) => ({
  readDependencyGraph: async (_id: string, maxDepth?: number) => ({
    ok: true as const,
    value: graphOf(root, server, maxDepth),
  }),
});

async function dependencies(
  drafts?: object[],
  direct: "none" | "prerequisite" = "none",
) {
  const root = await seededTask({ title: "Hang the washing" });
  const prerequisite = await seededTask({ title: "Run the washing machine" });
  const server: ServerDay = {
    version: 1,
    direct: direct === "prerequisite" ? [prerequisite] : [],
  };
  const api = fakeApi({
    readDependencies: async () => answer(root, []),
    ...graphApi(root, server),
  });
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
  return { t, root, prerequisite, server };
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
      // Codec v2 (WEB-18 merge correction): the touched edit with the base it was built from (root version 1, no direct prerequisite).
      expect(await copies(t, CONTEXT)).toEqual([
        {
          v: 2,
          list: [prerequisite.occurrenceId],
          strict: true,
          base: { version: 1, list: [] },
        },
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
        within(present(editorBody(), "the editor")).queryByText(RESTORED_TEXT),
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
      const api = fakeApi({
        readDependencies: async () => answer(root, []),
        ...graphApi(root, { version: 1, direct: [] }),
      });
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
      const remove = within(present(editorBody(), "the editor")).getByRole(
        "button",
        {
          name: new RegExp(`^${DEPENDENCY_COPY.remove}: `),
        },
      );
      fireEvent.click(remove);
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);

      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      expect(await copies(t, CONTEXT)).toEqual([
        { v: 2, list: [], strict: false, base: { version: 1, list: [] } },
      ]);

      await reload(t);
      await t.until(() => editorBody() !== null);
      expect(
        editorBody(),
        "Keep editing opened again on the copy",
      ).not.toBeNull();
      expect(present(editorBody(), "the editor")).toHaveTextContent(
        DEPENDENCY_COPY.editorEmpty,
      );
      expect(
        within(present(editorBody(), "the editor")).queryByText(RESTORED_TEXT),
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
        within(present(rotaDialog(), "the rota dialog")).getByRole("button", {
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
        present(
          present(rotaDialog(), "the rota dialog").querySelector(
            "[data-rota-count]",
          ),
          "the rota count",
        ),
      ).toHaveTextContent(ROTA_COPY.count(2));
      expect(
        within(present(rotaDialog(), "the rota dialog")).queryByText(
          RESTORED_TEXT,
        ),
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
        within(present(rotaDialog(), "the rota dialog")).getByRole("button", {
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
        present(
          present(rotaDialog(), "the rota dialog").querySelector(
            "[data-rota-count]",
          ),
          "the rota count",
        ),
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
      expect(
        present(
          document.querySelector("[data-rota-conflict]"),
          "the rota conflict",
        ),
      ).toHaveTextContent(ROTA_COPY.conflict);
      expect(
        present(
          present(rotaDialog(), "the rota dialog").querySelector(
            "[data-rota-count]",
          ),
          "the rota count",
        ),
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
        within(present(rotaDialog(), "the rota dialog")).getByRole("button", {
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

  test("dependency codec v2 (WEB-18 merge correction): a touched edit round-trips with its base; an untouched one is the start's own text (a); a version-1 copy, a missing base and malformed texts are not read (c)", () => {
    const codec = dependencyRecovery(O, null);
    const start = { list: [], strict: false, base: null, touched: false };
    const value = {
      list: [P],
      strict: true,
      base: { version: 3, list: [] },
      touched: true,
    };
    expect(codec.decode(codec.encode(value), start)).toEqual(value);
    // (a) Whatever WEB-18 filled an untouched edit with, it is the start's text: nothing of it is the person's input.
    const filled = {
      list: [P],
      strict: true,
      base: { version: 3, list: [P] },
      touched: false,
    };
    expect(codec.encode(filled)).toBe(codec.encode(start));
    expect(codec.decode(codec.encode(filled), start)).toBe(start);
    for (const text of [
      "not json",
      "null",
      // (c) the build before this merge: no base, so never restored in part.
      JSON.stringify({ v: 1, list: [P], strict: true }),
      JSON.stringify({ v: 2, list: [P], strict: true }),
      JSON.stringify({ v: 2, list: [P], strict: true, base: null }),
      JSON.stringify({
        v: 2,
        list: [P],
        strict: true,
        base: { version: -1, list: [] },
      }),
      JSON.stringify({
        v: 2,
        list: [P],
        strict: true,
        base: { version: 1, list: [P, P] },
      }),
      JSON.stringify({
        v: 2,
        list: [P],
        strict: "yes",
        base: { version: 1, list: [] },
      }),
      JSON.stringify({
        v: 2,
        list: [1],
        strict: true,
        base: { version: 1, list: [] },
      }),
      JSON.stringify({
        v: 2,
        list: [P, P],
        strict: true,
        base: { version: 1, list: [] },
      }),
      JSON.stringify({
        v: 2,
        list: Array.from({ length: 33 }, (_, i) => `${P}-${i}`),
        strict: true,
        base: { version: 1, list: [] },
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

// ---- revision 57: where a restored editor's focus goes (Review 57, F-R57-1; design assessment of 6 November 2026, C-F1, Q-F1 to Q-F5) ----
/**
 * The restored dialog's focus is a control of the editor itself and never inside a recovery surface (I-F1), on the restored arrival, after
 * a copy chosen while the banner stays, and on a keyboard "Discard instead"'s return, with and without another copy offered (I-F2). Before
 * the correction the turn order dialog's resolver was the first enabled button of a body that also holds the notice: focus landed on the
 * banner's own "Discard instead" (jsdom, and natively in three engines) and one keypress there discarded the restored order.
 *
 * `focus.ts` refuses a target inside a recovery surface (C-F2) and the test setup fails any test whose editor names one. These cases
 * collect the refusals themselves and assert them in the test body, beside where focus is (each waits for a condition that does not
 * depend on focus, then asserts focus), so a defect is reported by the test's own assertions.
 */
const SURFACE =
  "[data-recovery-state],[data-recovery-alternatives],[data-recovery-check]";
const focused = () => document.activeElement as HTMLElement | null;
const inSurface = (element: Element | null) => !!element?.closest(SURFACE);
const label = (element: Element | null) =>
  element?.getAttribute("aria-label") ?? element?.textContent ?? "";
const OTHER_TAB = "r57-gone-tab";
type Reporter = (kind: string, element: Element) => void;
const reporterHook = globalThis as {
  __atlasRecoverySurfaceRefused?: Reporter;
};
const refusals: string[] = [];
/** The describe's cases collect `focus.ts`'s refusals here (cleared before each case) and assert them in the body. */
function collectRefusals(): void {
  let previous: Reporter | undefined;
  beforeAll(() => {
    previous = reporterHook.__atlasRecoverySurfaceRefused;
    reporterHook.__atlasRecoverySurfaceRefused = (kind, element) =>
      refusals.push(`${kind}: ${label(element).trim()}`);
  });
  beforeEach(() => {
    refusals.length = 0;
  });
  afterAll(() => {
    reporterHook.__atlasRecoverySurfaceRefused = previous;
    refusals.length = 0;
  });
}
/** Another closed tab's copy of `context` (older than the reloading tab's own), so the restored editor also offers it. */
async function anotherCopy(t: Mounted, context: string, model: object) {
  expect(
    await t.data.formRecovery.save({
      formContext: context,
      tabInstanceId: OTHER_TAB,
      values: { model: JSON.stringify(model) },
      savedAt: new Date(Date.now() - 60_000).toISOString(),
      capture: `${OTHER_TAB}-capture`,
    }),
  ).toBe("saved");
}
/** "Discard instead" (or another button) used from the keyboard: focused when pressed (jsdom does not focus on click). */
function keyboardPress(button: HTMLElement): void {
  button.focus();
  expect(button, "the control used has focus").toHaveFocus();
  fireEvent.click(button);
}
const rotaCount = () =>
  rotaDialog()?.querySelector("[data-rota-count]")?.textContent ?? "";

async function restoredTurnOrder(options: { another?: boolean } = {}) {
  const world = await turnOrder();
  const { t, task } = world;
  fireEvent.click(screen.getByRole("button", { name: ROTA_COPY.order }));
  await t.until(() => rotaDialog() !== null);
  fireEvent.click(
    within(present(rotaDialog(), "the rota dialog")).getByRole("button", {
      name: `${ROTA_COPY.add}: Someone (2222…)`,
    }),
  );
  const { origin, tab } = await updatingTab();
  await acceptUpdate(t, origin, tab);
  expect(tab.reloads).toBe(1);
  if (options.another)
    await anotherCopy(t, ROTA_CONTEXT(task.taskId), {
      v: 1,
      base: 2,
      order: [OTHER],
    });
  await reload(t);
  // Shown restored (and offering the other copy): conditions of the model and the page, never of focus. `until` gives up silently, so
  // the premise is ASSERTED: a defect that loses the copy fails here, by an assertion, never by a later query that throws.
  const shown = () =>
    rotaDialog()?.querySelector('[data-recovery-state="restored"]') != null &&
    rotaCount() === ROTA_COPY.count(2) &&
    (!options.another ||
      rotaDialog()?.querySelector("[data-recovery-alternatives]") != null);
  await t.until(shown);
  await t.settle();
  expect(shown(), "premise: the dialog reopened restored on the copy").toBe(
    true,
  );
  return world;
}

describe("revision 57 (F-R57-1): a restored turn order dialog focuses its order, never the recovery notice", () => {
  collectRefusals();
  test(
    "Q-F1: after the reload the dialog opened on the copy focuses the order's first usable control (Move down), inside the order, not the banner's Discard instead",
    SLOW,
    async () => {
      await restoredTurnOrder();
      expect(inSurface(focused()), "not a recovery surface").toBe(false);
      expect(
        focused()?.closest("[data-rota-editor]"),
        `inside the order (focus is on "${label(focused())}")`,
      ).not.toBeNull();
      expect(label(focused())).toMatch(new RegExp(`^${ROTA_COPY.down}: `));
      expect(refusals, "no target inside a recovery surface").toEqual([]);
    },
  );

  test(
    "Q-F5: one activation of the focused control leaves the restored order (2 people) and its copy; Discard instead was not used",
    SLOW,
    async () => {
      const { t, task, sent } = await restoredTurnOrder();
      fireEvent.click(focused() as HTMLElement);
      await t.settle();
      expect(
        rotaCount(),
        "the restored order is still there (before the correction: 1, the discard's reset)",
      ).toBe(ROTA_COPY.count(2));
      expect(await copies(t, ROTA_CONTEXT(task.taskId))).toHaveLength(1);
      expect(sent).toEqual([]);
    },
  );

  test(
    "Q-F4: a keyboard Discard instead with no other copy returns focus to the order's first usable control (the reset order's Remove)",
    SLOW,
    async () => {
      const { t } = await restoredTurnOrder();
      keyboardPress(
        present(
          within(present(rotaDialog(), "the rota dialog")).queryByRole(
            "button",
            {
              name: "Discard instead",
            },
          ),
          "'Discard instead'",
        ),
      );
      await t.until(() => rotaCount() === ROTA_COPY.count(1));
      await t.settle();
      expect(rotaCount(), "the discard reset the order").toBe(
        ROTA_COPY.count(1),
      );
      expect(inSurface(focused())).toBe(false);
      expect(
        focused()?.closest("[data-rota-editor]"),
        `inside the order (focus is on "${label(focused())}")`,
      ).not.toBeNull();
      expect(label(focused())).toMatch(new RegExp(`^${ROTA_COPY.remove}: `));
      expect(refusals).toEqual([]);
    },
  );

  test(
    "Q-F4 with another copy offered: a keyboard Discard instead returns focus inside the order, never to the other copy's Restore",
    SLOW,
    async () => {
      const { t } = await restoredTurnOrder({ another: true });
      expect(inSurface(focused()), "the arrival: not a recovery surface").toBe(
        false,
      );
      keyboardPress(
        present(
          within(present(rotaDialog(), "the rota dialog")).queryByRole(
            "button",
            {
              name: "Discard instead",
            },
          ),
          "'Discard instead'",
        ),
      );
      await t.until(() => rotaCount() === ROTA_COPY.count(1));
      await t.settle();
      expect(rotaCount(), "the discard reset the order").toBe(
        ROTA_COPY.count(1),
      );
      expect(inSurface(focused()), "the discard's return").toBe(false);
      expect(
        focused()?.closest("[data-rota-editor]"),
        `inside the order (focus is on "${label(focused())}")`,
      ).not.toBeNull();
      expect(refusals).toEqual([]);
    },
  );

  test(
    "Q-F3: another copy chosen while the restored banner stays: focus lands inside the order of the chosen copy, never on the banner",
    SLOW,
    async () => {
      const { t } = await restoredTurnOrder({ another: true });
      const restore = within(
        rotaDialog()?.querySelector(
          "[data-recovery-alternatives]",
        ) as HTMLElement,
      ).getByRole("button", { name: /^Restore the copy saved / });
      keyboardPress(restore);
      await t.until(() => rotaCount() === ROTA_COPY.count(1));
      await t.settle();
      expect(rotaCount(), "the chosen copy is applied").toBe(
        ROTA_COPY.count(1),
      );
      expect(inSurface(focused())).toBe(false);
      expect(
        focused()?.closest("[data-rota-editor]"),
        `inside the order (focus is on "${label(focused())}")`,
      ).not.toBeNull();
      expect(label(focused())).toMatch(
        new RegExp(`^${ROTA_COPY.remove}: Someone`),
      );
      expect(refusals).toEqual([]);
    },
  );
});

describe("revision 57 (F-R57-1, Review 57 judgement): a restored dependency editor focuses its Task select", () => {
  collectRefusals();
  async function restoredDependencies() {
    const world = await dependencies();
    const { t, prerequisite } = world;
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.set }));
    await t.until(editorReady);
    await t.until(() =>
      [
        ...(screen.getByLabelText(DEPENDENCY_COPY.addTask) as HTMLSelectElement)
          .options,
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
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.add }));
    const { origin, tab } = await updatingTab();
    await acceptUpdate(t, origin, tab);
    expect(tab.reloads).toBe(1);
    await reload(t);
    const shown = () =>
      editorBody()?.querySelector('[data-recovery-state="restored"]') != null &&
      editorBody()?.querySelector(
        `[data-editor-item="${prerequisite.occurrenceId}"]`,
      ) != null;
    await t.until(shown);
    await t.settle();
    // `until` gives up silently: the premise is asserted (a defect that loses the copy fails here, by an assertion).
    expect(shown(), "premise: the editor reopened restored on the copy").toBe(
      true,
    );
    return world;
  }

  test(
    "Q-F2: after the reload the editor opened on the copy focuses the Task select (not a chosen day's Remove, not the banner)",
    SLOW,
    async () => {
      await restoredDependencies();
      expect(focused(), `focus is on "${label(focused())}"`).toBe(
        screen.queryByLabelText(DEPENDENCY_COPY.addTask),
      );
      expect(inSurface(focused())).toBe(false);
      expect(refusals).toEqual([]);
    },
  );

  test(
    "Q-F4: a keyboard Discard instead returns focus to the Task select; the restored day is gone with the copy",
    SLOW,
    async () => {
      const { t, prerequisite } = await restoredDependencies();
      keyboardPress(
        present(
          within(present(editorBody(), "the editor")).queryByRole("button", {
            name: "Discard instead",
          }),
          "'Discard instead'",
        ),
      );
      const gone = () =>
        editorBody()?.querySelector(
          `[data-editor-item="${prerequisite.occurrenceId}"]`,
        ) == null;
      await t.until(gone);
      await t.settle();
      expect(gone(), "the restored day is gone with the copy").toBe(true);
      expect(focused(), `focus is on "${label(focused())}"`).toBe(
        screen.queryByLabelText(DEPENDENCY_COPY.addTask),
      );
      expect(inSurface(focused())).toBe(false);
      expect(refusals).toEqual([]);
    },
  );
});

// ---- WEB-18 merge correction (Kieran, 7 November 2026: "Fix in WEB-18 merge, (a)(b)(c)") ---------------------------------------------
/**
 * WEB-18 builds the dependency editor from its own depth-one graph read (the edit's BASE: the root's version and direct list) and fills an
 * untouched edit from it. D-1's recovery is fitted to that editor (codec v2): (a) an editor WEB-18 only filled is not unsaved input; (b) a
 * restored edit whose server list has moved meets WEB-18's "changed" block, Save withheld until "Start again from the current list"; (c)
 * a copy of the build before this merge (version 1, no base) is offered, never restored in part. And a restore never breaks the editor.
 */
describe("WEB-18 merge correction: D-1's dependency-editor recovery fitted to WEB-18's editor (a)(b)(c)", () => {
  async function addThePrerequisite(t: Mounted, prerequisite: SeededTask) {
    await t.until(() =>
      [
        ...(screen.getByLabelText(DEPENDENCY_COPY.addTask) as HTMLSelectElement)
          .options,
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
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.add }));
  }
  const item = (id: string) =>
    editorBody()?.querySelector(`[data-editor-item="${id}"]`) ?? null;
  const broken = () =>
    /Something went wrong/.test(document.body.textContent ?? "");

  test(
    "(a) an editor WEB-18 only filled (the day already waits for a prerequisite) is registered but never dirty; the accepted update saves nothing for it and reloads; nothing reopens after the reload",
    SLOW,
    async () => {
      const { t, root, prerequisite } = await dependencies(
        undefined,
        "prerequisite",
      );
      const CONTEXT = DEPENDENCY_CONTEXT(root.occurrenceId, null);
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(
        () => editorReady() && item(prerequisite.occurrenceId) !== null,
      );
      expect(
        item(prerequisite.occurrenceId),
        "premise: WEB-18 filled the edit from the day's current list",
      ).not.toBeNull();
      expect(contextsOf(pageFormRegistry.all())).toContain(CONTEXT);
      expect(
        contextsOf(pageFormRegistry.dirty()),
        "(a) nothing the person typed: not dirty",
      ).not.toContain(CONTEXT);
      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      expect(await copies(t, CONTEXT), "nothing saved for it").toEqual([]);
      await reload(t);
      await t.settle();
      await t.settle();
      expect(editorBody(), "nothing reopens").toBeNull();
      expect(broken()).toBe(false);
    },
  );

  test(
    "(b) a restored edit whose server list moved during the reload shows WEB-18's 'changed' block with Save withheld; 'Start again from the current list' builds from the current list; nothing is sent; no crash",
    SLOW,
    async () => {
      const { t, root, prerequisite, server } = await dependencies();
      const CONTEXT = DEPENDENCY_CONTEXT(root.occurrenceId, null);
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(editorReady);
      await addThePrerequisite(t, prerequisite);
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);
      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      // Another editor's change, made while this page reloaded: the root's version moves on.
      server.version = 2;
      await reload(t);
      const changedShown = () =>
        editorBody()?.querySelector("[data-editor-changed]") != null;
      await t.until(changedShown);
      expect(broken(), "a restore never breaks the editor").toBe(false);
      expect(
        item(prerequisite.occurrenceId),
        "the restored edit",
      ).not.toBeNull();
      expect(
        within(present(editorBody(), "the editor")).queryByText(RESTORED_TEXT),
        "the restored notice",
      ).not.toBeNull();
      expect(changedShown(), "(b) WEB-18's changed block").toBe(true);
      expect(editorBody()?.dataset.dependencyEditor).toBe("changed");
      expect(
        present(
          screen.queryByRole("button", { name: DEPENDENCY_COPY.save }),
          "Save",
        ),
        "Save withheld",
      ).toBeDisabled();
      expect(t.drafts()).toEqual([]);
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.editorRestart }),
      );
      await t.until(editorReady);
      expect(changedShown()).toBe(false);
      expect(
        item(prerequisite.occurrenceId),
        "built from the current list",
      ).toBeNull();
      expect(
        present(
          screen.queryByRole("button", { name: DEPENDENCY_COPY.save }),
          "Save",
        ),
      ).not.toBeDisabled();
      expect(t.drafts(), "nothing sent").toEqual([]);
    },
  );

  test(
    "(c) a version-1 copy left by the build before this merge is offered as it is, never restored: the editor does not reopen on it, opening it shows the other copies, and the copy stays in the store",
    SLOW,
    async () => {
      const { t, root, prerequisite } = await dependencies();
      const CONTEXT = DEPENDENCY_CONTEXT(root.occurrenceId, null);
      expect(
        await t.data.formRecovery.save({
          formContext: CONTEXT,
          tabInstanceId: "web18-v1-gone-tab",
          values: {
            model: JSON.stringify({
              v: 1,
              list: [prerequisite.occurrenceId],
              strict: true,
            }),
          },
          savedAt: new Date(Date.now() - 60_000).toISOString(),
          capture: "web18-v1-gone-tab-capture",
        }),
      ).toBe("saved");
      await reload(t);
      await t.settle();
      await t.settle();
      expect(editorBody(), "not reopened on an unreadable copy").toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(
        () =>
          editorReady() &&
          screen.queryByText("Other saved copies of this form:") !== null,
      );
      expect(
        screen.queryByText("Other saved copies of this form:"),
        "(c) offered as it is",
      ).not.toBeNull();
      expect(
        item(prerequisite.occurrenceId),
        "never restored in part",
      ).toBeNull();
      expect(
        within(present(editorBody(), "the editor")).queryByText(RESTORED_TEXT),
      ).toBeNull();
      expect(await t.data.formRecovery.list(CONTEXT)).toHaveLength(1);
      expect(broken()).toBe(false);
    },
  );

  test(
    "'Discard instead' after a restore builds the edit again from the answer shown: Save is admitted, not held until the next read",
    SLOW,
    async () => {
      const { t, prerequisite } = await dependencies();
      fireEvent.click(
        screen.getByRole("button", { name: DEPENDENCY_COPY.set }),
      );
      await t.until(editorReady);
      await addThePrerequisite(t, prerequisite);
      const { origin, tab } = await updatingTab();
      await acceptUpdate(t, origin, tab);
      expect(tab.reloads).toBe(1);
      await reload(t);
      await t.until(() => item(prerequisite.occurrenceId) !== null);
      expect(
        item(prerequisite.occurrenceId),
        "premise: restored",
      ).not.toBeNull();
      fireEvent.click(
        present(
          within(present(editorBody(), "the editor")).queryByRole("button", {
            name: "Discard instead",
          }),
          "'Discard instead'",
        ),
      );
      await t.until(
        () => item(prerequisite.occurrenceId) === null && editorReady(),
      );
      expect(
        item(prerequisite.occurrenceId),
        "the restored day is gone",
      ).toBeNull();
      expect(
        editorBody()?.dataset.dependencyEditor,
        "built again from the answer shown",
      ).toBe("open");
      expect(
        present(
          screen.queryByRole("button", { name: DEPENDENCY_COPY.save }),
          "Save",
        ),
      ).not.toBeDisabled();
      expect(t.drafts()).toEqual([]);
    },
  );
});

import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { TasksResult } from "../../../src/features/tasks/api";
import { DEPENDENCY_COPY } from "../../../src/features/tasks/detail/Dependencies";
import { usePreview } from "../../../src/features/tasks/detail/usePreview";
import { TasksEnvProvider } from "../../../src/features/tasks/env";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  DependencyItem,
  DependencyPreview,
} from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * WF-TASK-04 (A8, A10, A11, A18; D-10c-6/7): the detail's row, the ordered list and its modes, the record card's gate, the editor and
 * the conflict blocks, over the PRODUCTION data controller, outbox and screens on the IndexedDB double with a scripted preview. FIXTURE
 * evidence: the preview is the stub's.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const TOKEN = "d".repeat(64);
const item = (
  task: SeededTask,
  over: Partial<DependencyItem> = {},
): DependencyItem => ({
  occurrence_id: task.occurrenceId,
  task_id: task.taskId,
  complete: false,
  can_complete: true,
  progress_version: null,
  ...over,
});
const answer = (
  root: SeededTask,
  prerequisites: DependencyItem[],
  over: Partial<DependencyPreview> = {},
): TasksResult<DependencyPreview> => ({
  ok: true,
  value: {
    token: TOKEN,
    items: [...prerequisites, item(root)],
    unavailable: false,
    strict: false,
    ...over,
  },
});
const path = (task: SeededTask) =>
  `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
const row = () =>
  document.querySelector("[data-dependencies]") as HTMLElement | null;
const dialog = () =>
  document.querySelector("[data-dependency-dialog]") as HTMLElement | null;

async function mount(options: {
  root?: SeededTask;
  prerequisite?: SeededTask;
  preview: (
    root: SeededTask,
    prerequisite: SeededTask,
  ) => TasksResult<DependencyPreview>;
  online?: boolean;
  drafts?: object[];
}) {
  const root =
    options.root ?? (await seededTask({ title: "Hang the washing" }));
  const prerequisite =
    options.prerequisite ??
    (await seededTask({ title: "Run the washing machine" }));
  const api = fakeApi({
    readDependencies: async () => options.preview(root, prerequisite),
  });
  const t = await mountTasks({
    path: path(root),
    rows: [...root.rows, ...prerequisite.rows],
    api,
    env: { online: options.online ?? true },
    ...(options.drafts ? { drafts: options.drafts } : {}),
  });
  await t.until(
    () =>
      row()?.dataset.dependencies ===
      (options.online === false ? "offline" : "ready"),
  );
  return { t, root, prerequisite, api };
}

describe("the detail's row (A8)", () => {
  test("nothing waited for: says so, and an editor may set what it waits for", async () => {
    await mount({ preview: (root) => answer(root, []) });
    expect(row()).toHaveTextContent(DEPENDENCY_COPY.none);
    expect(
      within(row() as HTMLElement).getByRole("button", {
        name: DEPENDENCY_COPY.set,
      }),
    ).toBeInTheDocument();
  });

  test("progress names the first open prerequisite by its cached title, never an id; an uncached one is 'not on this device'", async () => {
    const away = "aaaaaaaa-0000-4000-8000-0000000fffff";
    await mount({
      preview: (root, pre) =>
        answer(root, [
          item(pre, { complete: true }),
          {
            occurrence_id: away,
            task_id: away,
            complete: false,
            can_complete: false,
            progress_version: null,
          },
        ]),
    });
    expect(row()).toHaveTextContent(
      DEPENDENCY_COPY.progress(1, 2, DEPENDENCY_COPY.notHere),
    );
    expect(row()).not.toHaveTextContent(away);
  });

  test("offline: it can be checked when online, and nothing is read", async () => {
    const { api } = await mount({
      preview: (root) => answer(root, []),
      online: false,
    });
    expect(row()).toHaveTextContent(DEPENDENCY_COPY.offline);
    expect(api.calls.readDependencies).toBeUndefined();
  });

  test("MU-10C-17 (screen): something private: said, and the editor is not offered", async () => {
    await mount({
      preview: (root, pre) => answer(root, [item(pre)], { unavailable: true }),
    });
    expect(row()).toHaveTextContent(DEPENDENCY_COPY.unavailable);
    expect(
      within(row() as HTMLElement).queryByRole("button", {
        name: DEPENDENCY_COPY.set,
      }),
    ).toBeNull();
  });
});

describe("the dialog (A8, A9)", () => {
  test("the ordered list with pills and words, a radio group of modes, and Tick the others off queues ONE completion with the token", async () => {
    const { t, root } = await mount({
      preview: (r, pre) => answer(r, [item(pre)]),
    });
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.see }));
    await t.until(
      () =>
        dialog()?.dataset.dependencyDialog === "ready" &&
        (dialog()?.textContent ?? "").includes("Run the washing machine"),
    );
    const list = document.querySelector(
      "[data-dependency-list]",
    ) as HTMLElement;
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Run the washing machine");
    expect(items[0]).toHaveTextContent(DEPENDENCY_COPY.toDo);
    expect(items[1]).toHaveTextContent(DEPENDENCY_COPY.thisTask);
    const modes = screen.getByRole("radiogroup", {
      name: DEPENDENCY_COPY.modesName,
    });
    expect(within(modes).getAllByRole("radio")).toHaveLength(3);
    expect(
      (await axe(dialog()?.closest("[role=dialog]") as HTMLElement)).violations,
    ).toEqual([]);
    fireEvent.click(
      within(modes).getByRole("radio", { name: DEPENDENCY_COPY.completeAll }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.completeAll }),
    );
    await t.until(() => t.drafts().length === 1);
    expect(t.drafts().map((d) => d.kind)).toEqual(["complete_dependencies"]);
    expect(t.bodies()[0]?.command.command).toEqual({
      kind: "complete_dependencies",
      occurrence_id: root.occurrenceId,
      preview_token: TOKEN,
      mode: "complete_prerequisites",
      happened_at: expect.any(Number),
    });
    await t.until(() => dialog() === null);
    expect(dialog()).toBeNull();
  });

  test("MU-10C-16 (screen): a strict rule offers no Start anyway, and says why; an item I can't tick is said", async () => {
    const { t } = await mount({
      preview: (r, pre) =>
        answer(r, [item(pre, { can_complete: false })], { strict: true }),
    });
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.see }));
    await t.until(() => dialog()?.dataset.dependencyDialog === "ready");
    const modes = screen.getByRole("radiogroup", {
      name: DEPENDENCY_COPY.modesName,
    });
    expect(
      within(modes)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual([DEPENDENCY_COPY.wait]);
    expect(
      document.querySelector("[data-mode-reason=advisory_override]"),
    ).toHaveTextContent(DEPENDENCY_COPY.strict("Hang the washing"));
    expect(
      document.querySelector("[data-mode-reason=complete_prerequisites]"),
    ).toHaveTextContent(DEPENDENCY_COPY.completeAllWhy.cannot_complete);
    expect(dialog()).toHaveTextContent(DEPENDENCY_COPY.cantHere);
  });

  test("everything done: the primary act is Mark done (require_satisfied)", async () => {
    const { t } = await mount({
      preview: (r, pre) => answer(r, [item(pre, { complete: true })]),
    });
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.see }));
    await t.until(() => dialog()?.dataset.dependencyDialog === "ready");
    fireEvent.click(
      within(dialog()?.closest("[role=dialog]") as HTMLElement).getByRole(
        "button",
        {
          name: DEPENDENCY_COPY.markDone,
        },
      ),
    );
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      mode: "require_satisfied",
    });
  });
});

describe("the record card's gate", () => {
  test("Mark done on a day still waiting opens the preview instead of a plain record; offline the plain record is queued", async () => {
    const { t } = await mount({ preview: (r, pre) => answer(r, [item(pre)]) });
    fireEvent.click(
      within(
        document.querySelector("[data-record-card]") as HTMLElement,
      ).getByRole("button", { name: "Mark done" }),
    );
    await t.until(() => dialog() !== null);
    expect(dialog()).not.toBeNull();
    expect(t.drafts()).toEqual([]);
    const offline = await mount({
      preview: (r, pre) => answer(r, [item(pre)]),
      online: false,
    });
    fireEvent.click(
      within(
        document.querySelectorAll("[data-record-card]")[1] as HTMLElement,
      ).getByRole("button", { name: "Mark done" }),
    );
    await offline.t.until(() => offline.t.drafts().length === 1);
    expect(offline.t.drafts().map((d) => d.kind)).toEqual(["record"]);
  });

  test("MU-10C-32: an amount that would complete the day opens the preview; Wait keeps it typed; Start anyway sends it as the root's evidence and clears it", async () => {
    const root = await seededTask({
      title: "Read",
      definition: {
        goal: { kind: "numeric", minimum: "20", maximum: null, unit: "pages" },
      },
    });
    const { t } = await mount({
      root,
      preview: (r, pre) => answer(r, [item(pre)]),
    });
    const amount = screen.getByLabelText("Amount (pages)") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "25" } });
    fireEvent.click(
      within(
        document.querySelector("[data-record-card]") as HTMLElement,
      ).getByRole("button", {
        name: "Record",
      }),
    );
    await t.until(() => dialog()?.dataset.dependencyDialog === "ready");
    expect(dialog()).toHaveTextContent(DEPENDENCY_COPY.evidenceKept);
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.close }),
    );
    await t.until(() => dialog() === null);
    expect(
      (screen.getByLabelText("Amount (pages)") as HTMLInputElement).value,
    ).toBe("25");
    expect(t.drafts()).toEqual([]);
    fireEvent.click(
      within(
        document.querySelector("[data-record-card]") as HTMLElement,
      ).getByRole("button", {
        name: "Record",
      }),
    );
    await t.until(() => dialog()?.dataset.dependencyDialog === "ready");
    fireEvent.click(
      screen.getByRole("radio", { name: DEPENDENCY_COPY.startAnyway }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.startAnyway }),
    );
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      mode: "advisory_override",
      root_evidence: { kind: "quantity", amount: "25" },
    });
    await t.until(
      () =>
        (screen.getByLabelText("Amount (pages)") as HTMLInputElement).value ===
        "",
    );
    expect(
      (screen.getByLabelText("Amount (pages)") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("the editor (D-10c-7)", () => {
  test("MU-10C-18: it starts EMPTY, says it replaces everything, and saves the whole chosen list with strict", async () => {
    const { t, root, prerequisite } = await mount({
      preview: (r, pre) => answer(r, [item(pre)], { strict: true }),
    });
    fireEvent.click(
      within(row() as HTMLElement).getByRole("button", {
        name: DEPENDENCY_COPY.set,
      }),
    );
    await t.until(
      () => document.querySelector("[data-dependency-editor]") !== null,
    );
    const editor = document.querySelector(
      "[data-dependency-editor]",
    ) as HTMLElement;
    expect(editor).toHaveTextContent(DEPENDENCY_COPY.editorEmpty);
    expect(document.body).toHaveTextContent(
      DEPENDENCY_COPY.editorLead("Hang the washing"),
    );
    expect(
      (screen.getByLabelText(DEPENDENCY_COPY.strictLabel) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // The cached tasks are read when the editor opens.
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
    await t.settle();
    expect(
      document.querySelector(
        `[data-editor-item="${prerequisite.occurrenceId}"]`,
      ),
    ).toHaveTextContent("Run the washing machine");
    expect(document.querySelector("[data-editor-counter]")).toHaveTextContent(
      DEPENDENCY_COPY.counter(1),
    );
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.save }));
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toEqual({
      kind: "set_dependencies",
      occurrence_id: root.occurrenceId,
      expected_version: 1,
      prerequisites: [prerequisite.occurrenceId],
      strict: true,
    });
  });
});

describe("conflicts (A11)", () => {
  test("a completion in conflict says the cause from a FRESH preview and sends again as a replacement", async () => {
    const root = await seededTask({ title: "Hang the washing" });
    const local = "70000000-0000-4000-8000-000000000999";
    const { t } = await mount({
      root,
      preview: (r, pre) => answer(r, [item(pre, { complete: true })]),
      drafts: [
        draftRow({
          local_id: local,
          created_seq: 1,
          kind: "complete_dependencies",
          endpoint: "/task-commands",
          account_id: ME,
          status: "version_conflict",
          target_resource_ids: [root.occurrenceId],
          index_targets: [root.occurrenceId],
          command: {
            command: {
              kind: "complete_dependencies",
              occurrence_id: root.occurrenceId,
              preview_token: "e".repeat(64),
              mode: "complete_prerequisites",
              happened_at: 1,
            },
          } as never,
        }),
      ],
    });
    await t.until(
      () =>
        document.querySelector("[data-completion-conflict=satisfied]") !== null,
    );
    expect(
      document.querySelector("[data-completion-conflict]"),
    ).toHaveTextContent(DEPENDENCY_COPY.cause.satisfied);
    // The submitted operation is read from the queue (its durable body).
    await t.until(
      () =>
        screen.queryByRole("button", { name: DEPENDENCY_COPY.review }) !== null,
    );
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.review }),
    );
    await t.until(() => dialog()?.dataset.dependencyDialog === "ready");
    fireEvent.click(
      within(dialog()?.closest("[role=dialog]") as HTMLElement).getByRole(
        "button",
        {
          name: DEPENDENCY_COPY.markDone,
        },
      ),
    );
    await t.until(() => t.drafts().some((d) => d.local_id !== local));
    const fresh = t.drafts().filter((d) => d.status === "queued");
    expect(fresh.map((d) => d.kind)).toEqual(["complete_dependencies"]);
    expect(t.drafts().find((d) => d.local_id === local)?.status).not.toBe(
      "version_conflict",
    );
  });

  test("MU-10C-19: setting what it waits for in conflict uses neutral words (no entry named) and Keep editing starts from the SUBMITTED list", async () => {
    const root = await seededTask({ title: "Hang the washing" });
    const pre = await seededTask({ title: "Run the washing machine" });
    const local = "70000000-0000-4000-8000-000000000998";
    const { t } = await mount({
      root,
      prerequisite: pre,
      preview: (r) => answer(r, []),
      drafts: [
        draftRow({
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
        }),
      ],
    });
    await t.until(() => document.querySelector("[data-set-conflict]") !== null);
    const block = document.querySelector("[data-set-conflict]") as HTMLElement;
    expect(block).toHaveTextContent(DEPENDENCY_COPY.setConflict);
    await t.until(
      () =>
        within(block).queryByRole("button", {
          name: DEPENDENCY_COPY.keepEditing,
        }) !== null,
    );
    // Nothing of what was submitted is named (no title, no id), with the draft itself loaded.
    expect(block).not.toHaveTextContent("Run the washing machine");
    expect(block).not.toHaveTextContent(pre.occurrenceId);
    fireEvent.click(
      within(block).getByRole("button", { name: DEPENDENCY_COPY.keepEditing }),
    );
    await t.until(
      () =>
        document.querySelector(`[data-editor-item="${pre.occurrenceId}"]`) !==
        null,
    );
    expect(
      document.querySelector(`[data-editor-item="${pre.occurrenceId}"]`),
    ).not.toBeNull();
  });
});

/**
 * Revision 1 (review R4): saving a list REPLACES every direct prerequisite (D-10c-7), and "Keep editing" of a refused set supersedes it on
 * the version shown now. So both saves are admitted by the same current conditions: the editor reads the preview again when it opens, and
 * Save is withheld until that answer (or a later one) shows nothing private, while the person may still edit the day, online. What was
 * typed, or the submitted list, is kept meanwhile.
 */
describe("R4: one admission for a new and a replacing save", () => {
  const conflicted = (
    root: SeededTask,
    pre: SeededTask,
    local = "70000000-0000-4000-8000-000000000997",
  ) =>
    draftRow({
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
  const keepEditing = async (t: Awaited<ReturnType<typeof mount>>["t"]) => {
    await t.until(
      () =>
        screen.queryByRole("button", { name: DEPENDENCY_COPY.keepEditing }) !==
        null,
    );
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.keepEditing }),
    );
    await t.until(
      () => document.querySelector("[data-dependency-editor]") !== null,
    );
    await t.settle();
  };
  const editor = () =>
    document
      .querySelector("[data-dependency-editor]")
      ?.getAttribute("data-dependency-editor");

  test("Keep editing on a day whose prerequisites became private: the submitted list is kept, Save is withheld with its reason", async () => {
    const root = await seededTask({ title: "Hang the washing" });
    const pre = await seededTask({ title: "Run the washing machine" });
    const { t } = await mount({
      root,
      prerequisite: pre,
      preview: (r) => answer(r, [], { unavailable: true }),
      drafts: [conflicted(root, pre)],
    });
    await keepEditing(t);
    expect(editor()).toBe("unavailable");
    expect(
      document.querySelector(`[data-editor-item="${pre.occurrenceId}"]`),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: DEPENDENCY_COPY.save }),
    ).toBeDisabled();
    expect(document.body).toHaveTextContent(DEPENDENCY_COPY.editorUnavailable);
    expect(t.drafts().map((d) => d.local_id)).toEqual([
      "70000000-0000-4000-8000-000000000997",
    ]);
  });

  test("control: Keep editing on a day with nothing private saves as a replacement of the refused set", async () => {
    const root = await seededTask({ title: "Hang the washing" });
    const pre = await seededTask({ title: "Run the washing machine" });
    const { t } = await mount({
      root,
      prerequisite: pre,
      preview: (r) => answer(r, []),
      drafts: [conflicted(root, pre)],
    });
    await keepEditing(t);
    expect(editor()).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.save }));
    await t.until(
      () =>
        t.drafts().length === 1 &&
        t.drafts()[0]?.local_id !== "70000000-0000-4000-8000-000000000997",
    );
    expect(t.drafts()[0]?.kind).toBe("set_dependencies");
    expect(t.bodies()[0]?.command.command).toMatchObject({
      prerequisites: [pre.occurrenceId],
    });
  });

  test("Keep editing on a day this person may no longer edit: withheld (denied), nothing replaced", async () => {
    const base = await seededTask({ title: "Hang the washing" });
    const root = {
      ...base,
      rows: base.rows.map((r) =>
        r.id === base.occurrenceId ? { ...r, can_edit: false } : r,
      ),
    };
    const pre = await seededTask({ title: "Run the washing machine" });
    const { t } = await mount({
      root,
      prerequisite: pre,
      preview: (r) => answer(r, []),
      drafts: [conflicted(root, pre)],
    });
    await keepEditing(t);
    expect(editor()).toBe("denied");
    expect(
      screen.getByRole("button", { name: DEPENDENCY_COPY.save }),
    ).toBeDisabled();
  });

  test("a NEW list opened from a preview that has since become private: Save waits for the editor's own fresh read, which withholds it", async () => {
    const root = await seededTask({ title: "Hang the washing" });
    let reads = 0;
    let release: () => void = () => undefined;
    const fresh = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = fakeApi({
      readDependencies: async () => {
        reads += 1;
        if (reads > 1) await fresh;
        return answer(root, [], { unavailable: reads > 1 });
      },
    });
    const t = await mountTasks({ path: path(root), rows: root.rows, api });
    await t.until(
      () =>
        screen.queryByRole("button", { name: DEPENDENCY_COPY.set }) !== null,
    );
    const before = reads;
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.set }));
    await t.until(() => editor() !== undefined && reads > before);
    await t.settle();
    // The re-read is outstanding: the preview the editor was opened from (nothing private then) admits nothing.
    expect(reads, "the editor read the preview again").toBeGreaterThan(before);
    expect(editor()).toBe("loading");
    expect(
      screen.getByRole("button", { name: DEPENDENCY_COPY.save }),
    ).toBeDisabled();
    release();
    await t.until(() => editor() === "unavailable");
    expect(editor()).toBe("unavailable");
    expect(
      screen.getByRole("button", { name: DEPENDENCY_COPY.save }),
    ).toBeDisabled();
  });
});

describe("identity (A18)", () => {
  test("MU-10C-33: a preview asked under one identity is never shown under another", async () => {
    const root = await seededTask({ title: "Hang the washing" });
    const pre = await seededTask({ title: "Run the washing machine" });
    let release: (r: TasksResult<DependencyPreview>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readDependencies: () => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => (release = resolve))
          : new Promise(() => undefined);
      },
    });
    const t = await mountTasks({
      path: path(root),
      rows: [...root.rows, ...pre.rows],
      api,
    });
    await t.until(() => calls >= 1);
    t.rerender(tasksEnv(api, { identity: `${ME}:2` }));
    await t.settle();
    release(answer(root, [item(pre)]));
    await t.settle();
    expect(row()?.dataset.dependencies).toBe("loading");
  });

  test("MU-10C-33 (hook): an answer asked under one identity is dropped when the identity changes under the same reader", async () => {
    // The screens remount on another identity (TasksEnv is keyed by it); this keeps one reader across the change, so only the hook's own
    // rule stands between a late answer and the screen.
    const occurrence = "aaaaaaaa-0000-4000-8000-000000000033";
    let release: (r: TasksResult<DependencyPreview>) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      readDependencies: () => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => (release = resolve))
          : new Promise(() => undefined);
      },
    });
    let env = tasksEnv(api);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
    );
    const { result, rerender } = renderHook(() => usePreview(occurrence, ""), {
      wrapper,
    });
    await act(async () => undefined);
    expect(calls).toBe(1);
    env = tasksEnv(api, { identity: `${ME}:2` });
    rerender();
    await act(async () => undefined);
    expect(calls).toBe(2);
    await act(async () => {
      release({
        ok: true,
        value: {
          token: TOKEN,
          items: [
            {
              occurrence_id: occurrence,
              task_id: "aaaaaaaa-0000-4000-8000-0000000000ff",
              complete: false,
              can_complete: true,
              progress_version: null,
            },
          ],
          unavailable: false,
          strict: false,
        },
      });
    });
    expect(result.current.read.kind).toBe("loading");
  });
});

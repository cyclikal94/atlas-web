import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { TasksResult } from "../../../src/features/tasks/api";
import * as copy from "../../../src/features/tasks/copy";
import { DEPENDENCY_COPY } from "../../../src/features/tasks/detail/Dependencies";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  DependencyGraph,
  DependencyPreview,
} from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { rootGraph } from "../../support/tasks/graphs";
import {
  fakeApi,
  ME,
  mountTasks,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * WEB-18 (A18-5, A18-6, A18-9; D-18-6/7/8): the editor built from its own fresh depth-one graph read, over the PRODUCTION data controller,
 * outbox and screens on the IndexedDB double with scripted reads (FIXTURE evidence): it starts from the AUTHORITATIVE direct list, saves on
 * that read's version (so a moved server answers `conflict`, never a silent overwrite), re-seeds an untouched edit and withholds Save from
 * a touched one when the base moves, and withholds Save while the day has hidden prerequisites, may not be edited, or has another
 * unsettled change of its version.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const TOKEN = "e".repeat(64);
const editor = () =>
  document.querySelector("[data-dependency-editor]") as HTMLElement | null;
const state = () => editor()?.getAttribute("data-dependency-editor");
const save = () => screen.getByRole("button", { name: DEPENDENCY_COPY.save });
const item = (id: string) =>
  document.querySelector(`[data-editor-item="${id}"]`);

type Graph = (
  root: SeededTask,
  pres: SeededTask[],
) => TasksResult<DependencyGraph>;
const graphOf =
  (
    over: {
      version?: number;
      strict?: boolean;
      canEdit?: boolean;
      hidden?: boolean;
      direct?: number[];
      titles?: string[];
    } = {},
  ): Graph =>
  (root, pres) => ({
    ok: true,
    value: rootGraph({
      root: root.occurrenceId,
      task: root.taskId,
      title: "Hang the washing",
      version: over.version ?? 7,
      strict: over.strict ?? false,
      canEdit: over.canEdit ?? true,
      hidden: over.hidden ?? false,
      direct: (over.direct ?? []).map((i) => ({
        id: (pres[i] as SeededTask).occurrenceId,
        task: (pres[i] as SeededTask).taskId,
        title: over.titles?.[i] ?? `Graph title ${i}`,
      })),
    }),
  });
const preview = (
  root: SeededTask,
  over: Partial<DependencyPreview> = {},
): TasksResult<DependencyPreview> => ({
  ok: true,
  value: {
    token: TOKEN,
    items: [
      {
        occurrence_id: root.occurrenceId,
        task_id: root.taskId,
        complete: false,
        can_complete: true,
        progress_version: null,
      },
    ],
    unavailable: false,
    strict: false,
    ...over,
  },
});

async function openEditor(options: {
  /** The depth-one answers in turn (the last repeats). */
  graphs: Array<Graph | (() => Promise<TasksResult<DependencyGraph>>)>;
  previewOver?: Partial<DependencyPreview>;
  drafts?: (root: SeededTask, pres: SeededTask[]) => object[];
  rows?: (root: SeededTask, pres: SeededTask[]) => SeededTask["rows"];
}) {
  const root = await seededTask({ title: "Hang the washing" });
  const pres = [
    await seededTask({ title: "Run the washing machine" }),
    await seededTask({ title: "Buy pegs" }),
    await seededTask({ title: "Fold the towels" }),
  ];
  let n = 0;
  const api = fakeApi({
    readDependencies: async () => preview(root, options.previewOver),
    readDependencyGraph: async (_id, depth) => {
      if (depth !== 1) return { ok: false, kind: "uncertain" };
      const next = options.graphs[Math.min(n, options.graphs.length - 1)];
      n += 1;
      return next === undefined
        ? { ok: false, kind: "uncertain" }
        : next.length === 0
          ? (next as () => Promise<TasksResult<DependencyGraph>>)()
          : (next as Graph)(root, pres);
    },
  });
  const t = await mountTasks({
    path: `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`,
    rows: options.rows?.(root, pres) ?? [
      ...root.rows,
      ...pres.flatMap((p) => p.rows),
    ],
    api,
    ...(options.drafts ? { drafts: options.drafts(root, pres) } : {}),
  });
  await t.until(
    () =>
      (document.querySelector("[data-dependencies]") as HTMLElement | null)
        ?.dataset.dependencies === "ready",
  );
  fireEvent.click(
    within(
      document.querySelector("[data-dependencies]") as HTMLElement,
    ).getByRole("button", { name: DEPENDENCY_COPY.set }),
  );
  await t.until(() => editor() !== null && state() !== "loading");
  return { t, root, pres, api };
}

describe("S-ED1 / S-ED4: built from the authoritative direct list, saved on its version", () => {
  test("a depth-one read when it opens; the list, the strict rule and the labels are the graph's; Save sends the graph's version, not the cache's", async () => {
    const { t, root, pres, api } = await openEditor({
      graphs: [graphOf({ version: 7, strict: true, direct: [0, 1] })],
    });
    expect(api.graphReads).toEqual([
      { occurrenceId: root.occurrenceId, maxDepth: 1 },
    ]);
    expect(state()).toBe("open");
    expect(item(pres[0]?.occurrenceId as string)).toHaveTextContent(
      "Graph title 0",
    );
    expect(item(pres[1]?.occurrenceId as string)).toHaveTextContent(
      "Graph title 1",
    );
    // The preview says not strict; the graph's root says strict: the editor's start is the graph's.
    expect(
      (screen.getByLabelText(DEPENDENCY_COPY.strictLabel) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // Remove one and save: the WHOLE intended visible list, on the graph's version 7 (the cache holds 1).
    expect(item(pres[1]?.occurrenceId as string)).not.toBeNull();
    fireEvent.click(
      within(item(pres[1]?.occurrenceId as string) as HTMLElement).getByRole(
        "button",
        {
          name: new RegExp(`^${DEPENDENCY_COPY.remove}: Graph title 1 · `),
        },
      ),
    );
    await t.settle();
    fireEvent.click(save());
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toEqual({
      kind: "set_dependencies",
      occurrence_id: root.occurrenceId,
      expected_version: 7,
      prerequisites: [pres[0]?.occurrenceId],
      strict: true,
    });
  });

  test("an empty authoritative list starts empty (and a day added from the cache is labelled from the cache)", async () => {
    const { t, pres } = await openEditor({ graphs: [graphOf({ direct: [] })] });
    expect(editor()).toHaveTextContent(DEPENDENCY_COPY.editorEmpty);
    await t.until(() =>
      [
        ...(screen.getByLabelText(DEPENDENCY_COPY.addTask) as HTMLSelectElement)
          .options,
      ].some((o) => o.value === pres[2]?.taskId),
    );
    fireEvent.change(screen.getByLabelText(DEPENDENCY_COPY.addTask), {
      target: { value: pres[2]?.taskId },
    });
    await t.until(
      () =>
        (screen.getByLabelText(DEPENDENCY_COPY.addDay) as HTMLSelectElement)
          .options.length > 1,
    );
    fireEvent.change(screen.getByLabelText(DEPENDENCY_COPY.addDay), {
      target: { value: pres[2]?.occurrenceId },
    });
    fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.add }));
    await t.settle();
    expect(item(pres[2]?.occurrenceId as string)).toHaveTextContent(
      "Fold the towels",
    );
  });
});

describe("S-ED2: a base that moves (changed dependencies)", () => {
  test("untouched: re-seeded from the newer read silently", async () => {
    const { t, pres } = await openEditor({
      graphs: [
        graphOf({ version: 7, direct: [0] }),
        graphOf({ version: 8, direct: [0, 1] }),
      ],
    });
    expect(item(pres[1]?.occurrenceId as string)).toBeNull();
    // Sync reports a change: the editor's view is read again.
    await t.commitSync([
      {
        ...(pres[2]?.rows[0] as SeededTask["rows"][number]),
        label: "Fold the towels again",
      },
    ]);
    await t.until(() => item(pres[1]?.occurrenceId as string) !== null);
    expect(state()).toBe("open");
    fireEvent.click(save());
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      expected_version: 8,
      prerequisites: [pres[0]?.occurrenceId, pres[1]?.occurrenceId].sort(),
    });
  });

  test("touched: Save is withheld with 'changed' until the person starts again from the current list", async () => {
    const { t, pres } = await openEditor({
      graphs: [
        graphOf({ version: 7, direct: [0] }),
        graphOf({ version: 8, direct: [1] }),
      ],
    });
    fireEvent.click(
      screen.getByLabelText(DEPENDENCY_COPY.strictLabel) as HTMLInputElement,
    );
    await t.settle();
    await t.commitSync([
      {
        ...(pres[2]?.rows[0] as SeededTask["rows"][number]),
        label: "Fold the towels again",
      },
    ]);
    await t.until(() => state() === "changed");
    expect(save()).toBeDisabled();
    expect(document.body).toHaveTextContent(DEPENDENCY_COPY.editorChanged);
    // What was typed is not replaced behind the person's back.
    expect(item(pres[0]?.occurrenceId as string)).not.toBeNull();
    expect(t.drafts()).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.editorRestart }),
    );
    await t.settle();
    expect(state()).toBe("open");
    expect(item(pres[0]?.occurrenceId as string)).toBeNull();
    expect(item(pres[1]?.occurrenceId as string)).not.toBeNull();
    fireEvent.click(save());
    await t.until(() => t.drafts().length === 1);
    expect(t.bodies()[0]?.command.command).toMatchObject({
      expected_version: 8,
    });
  });

  test("kept across close and reopen: a touched edit whose base still holds is kept", async () => {
    const { t, pres } = await openEditor({
      graphs: [graphOf({ version: 7, direct: [0, 1] })],
    });
    expect(item(pres[0]?.occurrenceId as string)).not.toBeNull();
    fireEvent.click(
      within(item(pres[0]?.occurrenceId as string) as HTMLElement).getByRole(
        "button",
        {
          name: new RegExp(`^${DEPENDENCY_COPY.remove}`),
        },
      ),
    );
    await t.settle();
    fireEvent.click(
      screen.getByRole("button", { name: DEPENDENCY_COPY.cancel }),
    );
    await t.until(() => editor() === null);
    fireEvent.click(
      within(
        document.querySelector("[data-dependencies]") as HTMLElement,
      ).getByRole("button", {
        name: DEPENDENCY_COPY.set,
      }),
    );
    await t.until(() => editor() !== null && state() === "open");
    expect(item(pres[0]?.occurrenceId as string)).toBeNull();
    expect(item(pres[1]?.occurrenceId as string)).not.toBeNull();
  });
});

describe("S-ED3: a stale write is never a silent overwrite", () => {
  const conflicted = (root: SeededTask, pres: SeededTask[]) => [
    draftRow({
      local_id: "70000000-0000-4000-8000-000000000918",
      created_seq: 1,
      kind: "set_dependencies",
      endpoint: "/task-commands",
      account_id: ME,
      status: "version_conflict",
      target_resource_ids: [
        root.occurrenceId,
        (pres[2] as SeededTask).occurrenceId,
      ],
      index_targets: [root.occurrenceId, (pres[2] as SeededTask).occurrenceId],
      command: {
        command: {
          kind: "set_dependencies",
          occurrence_id: root.occurrenceId,
          expected_version: 1,
          prerequisites: [(pres[2] as SeededTask).occurrenceId],
          strict: false,
        },
      } as never,
    }),
  ];

  test("Keep editing: the SUBMITTED list, the current list read now beside it, and the replacement sent on the version read now", async () => {
    const { t, root, pres } = await openEditorFromConflict({
      graphs: [
        graphOf({
          version: 9,
          direct: [0],
          titles: ["Run the washing machine"],
        }),
      ],
      drafts: conflicted,
    });
    const now = document.querySelector("[data-editor-now]") as HTMLElement;
    expect(now).toHaveTextContent(
      `${DEPENDENCY_COPY.editorWaitsNow} Run the washing machine`,
    );
    expect(item(pres[2]?.occurrenceId as string)).not.toBeNull();
    expect(item(pres[0]?.occurrenceId as string)).toBeNull();
    fireEvent.click(save());
    await t.until(
      () =>
        t.drafts().length === 1 &&
        t.drafts()[0]?.local_id !== "70000000-0000-4000-8000-000000000918",
    );
    expect(t.bodies()[0]?.command.command).toEqual({
      kind: "set_dependencies",
      occurrence_id: root.occurrenceId,
      expected_version: 9,
      prerequisites: [pres[2]?.occurrenceId],
      strict: false,
    });
  });
});

/** Opens the editor through "Keep editing" of a conflicted set. */
async function openEditorFromConflict(
  options: Parameters<typeof openEditor>[0],
) {
  const root = await seededTask({ title: "Hang the washing" });
  const pres = [
    await seededTask({ title: "Run the washing machine" }),
    await seededTask({ title: "Buy pegs" }),
    await seededTask({ title: "Fold the towels" }),
  ];
  let n = 0;
  const api = fakeApi({
    readDependencies: async () => preview(root, options.previewOver),
    readDependencyGraph: async (_id, depth) => {
      if (depth !== 1) return { ok: false, kind: "uncertain" };
      const next = options.graphs[
        Math.min(n, options.graphs.length - 1)
      ] as Graph;
      n += 1;
      return next(root, pres);
    },
  });
  const t = await mountTasks({
    path: `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`,
    rows: [...root.rows, ...pres.flatMap((p) => p.rows)],
    api,
    drafts: options.drafts?.(root, pres) ?? [],
  });
  await t.until(
    () =>
      screen.queryByRole("button", { name: DEPENDENCY_COPY.keepEditing }) !==
      null,
  );
  fireEvent.click(
    screen.getByRole("button", { name: DEPENDENCY_COPY.keepEditing }),
  );
  await t.until(() => editor() !== null && state() !== "loading");
  return { t, root, pres, api };
}

describe("S-ED5..S-ED8: when Save is withheld, and why", () => {
  test("S-ED5 another unsettled change of the day's version (a closure) withholds Save; one that only names the day does not", async () => {
    const { t } = await openEditor({
      graphs: [graphOf({ direct: [] })],
      drafts: (root) => [
        draftRow({
          local_id: "70000000-0000-4000-8000-000000000931",
          created_seq: 1,
          kind: "resolve",
          endpoint: "/task-commands",
          account_id: ME,
          status: "queued",
          target_resource_ids: [root.occurrenceId],
          index_targets: [root.occurrenceId],
          command: {
            command: {
              kind: "resolve",
              occurrence_id: root.occurrenceId,
              expected_version: 1,
              resolved: true,
            },
          } as never,
        }),
      ],
    });
    expect(state()).toBe("pending");
    expect(save()).toBeDisabled();
    expect(document.body).toHaveTextContent(DEPENDENCY_COPY.editorPending);
    expect(t.drafts()).toHaveLength(1);
  });

  test("S-ED5 control: another day's set that only lists this day as a prerequisite does not withhold Save", async () => {
    await openEditor({
      graphs: [graphOf({ direct: [] })],
      drafts: (root, pres) => [
        draftRow({
          local_id: "70000000-0000-4000-8000-000000000932",
          created_seq: 1,
          kind: "set_dependencies",
          endpoint: "/task-commands",
          account_id: ME,
          status: "queued",
          target_resource_ids: [
            (pres[0] as SeededTask).occurrenceId,
            root.occurrenceId,
          ],
          index_targets: [
            (pres[0] as SeededTask).occurrenceId,
            root.occurrenceId,
          ],
          command: {
            command: {
              kind: "set_dependencies",
              occurrence_id: (pres[0] as SeededTask).occurrenceId,
              expected_version: 1,
              prerequisites: [root.occurrenceId],
              strict: false,
            },
          } as never,
        }),
      ],
    });
    expect(state()).toBe("open");
  });

  test("S-ED6 the graph says this person may not edit the day (the cache says they may): withheld as denied", async () => {
    await openEditor({ graphs: [graphOf({ canEdit: false })] });
    expect(state()).toBe("denied");
    expect(save()).toBeDisabled();
    expect(document.body).toHaveTextContent(DEPENDENCY_COPY.editorDenied);
  });

  test("S-ED7 the day has hidden prerequisites: saving would remove them, so it is not offered", async () => {
    await openEditor({ graphs: [graphOf({ hidden: true, direct: [0] })] });
    expect(state()).toBe("restricted");
    expect(save()).toBeDisabled();
    expect(document.body).toHaveTextContent(DEPENDENCY_COPY.editorUnavailable);
  });

  test("S-ED7 a preview with something private still withholds Save (WEB-10c's rule kept), whatever the graph says", async () => {
    // The row offers no "Set" on a private preview, so the editor is reached through "Keep editing".
    await openEditorFromConflict({
      graphs: [graphOf({})],
      previewOver: { unavailable: true },
      drafts: (root, pres) => [
        draftRow({
          local_id: "70000000-0000-4000-8000-000000000933",
          created_seq: 1,
          kind: "set_dependencies",
          endpoint: "/task-commands",
          account_id: ME,
          status: "version_conflict",
          target_resource_ids: [
            root.occurrenceId,
            (pres[0] as SeededTask).occurrenceId,
          ],
          index_targets: [
            root.occurrenceId,
            (pres[0] as SeededTask).occurrenceId,
          ],
          command: {
            command: {
              kind: "set_dependencies",
              occurrence_id: root.occurrenceId,
              expected_version: 1,
              prerequisites: [(pres[0] as SeededTask).occurrenceId],
              strict: false,
            },
          } as never,
        }),
      ],
    });
    expect(state()).toBe("unavailable");
    expect(save()).toBeDisabled();
  });

  test.each([
    [
      "an error",
      { ok: false, kind: "uncertain" } as const,
      DEPENDENCY_COPY.failed,
    ],
    ["a refusal", { ok: false, kind: "not_found" } as const, copy.UNREADABLE],
  ])(
    "S-ED8 the graph read failing (%s): withheld, with the reason",
    async (_name, answer, reason) => {
      const { t } = await openEditor({
        graphs: [() => Promise.resolve(answer)],
      });
      await t.until(() => document.body.textContent?.includes(reason) === true);
      expect(state()).toBe("loading");
      expect(save()).toBeDisabled();
    },
  );
});

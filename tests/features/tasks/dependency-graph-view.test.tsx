import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import type { TasksResult } from "../../../src/features/tasks/api";
import { DEPENDENCY_COPY } from "../../../src/features/tasks/detail/Dependencies";
import { GRAPH_COPY } from "../../../src/features/tasks/detail/DependencyGraph";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type {
  DependencyGraph,
  DependencyPreview,
} from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import {
  branchSpec,
  budgetPartialSpec,
  buildGraph,
  chainSpec,
  crossSpec,
  deepSpec,
  emptySpec,
  type GraphSpec,
  gid,
  restrictedMidSpec,
  restrictedOnlySpec,
  restrictedRootSpec,
  sharedSpec,
} from "../../support/tasks/graphs";
import { SLOW } from "../../support/tasks/journal";
import {
  fakeApi,
  mountTasks,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * WEB-18 (A18-1..8, A18-10..13; D-18-1..4, D-18-9..11): "What needs doing first" drawn from ONE graph answer over the PRODUCTION data
 * controller, outbox and screens on the IndexedDB double, with scripted reads (FIXTURE evidence): the tree and the decorative map agree
 * with the answer's edges and states, the summary and notices say only what is visible, and the modes still come from the preview alone.
 */
const media = installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const TOKEN = "d".repeat(64);
const dialog = () =>
  document.querySelector("[data-dependency-dialog]") as HTMLElement | null;
const section = () =>
  document.querySelector("[data-dependency-graph]") as HTMLElement | null;
const tree = () =>
  document.querySelector("[data-dependency-tree]") as HTMLElement | null;

/** The spec with its root replaced by the seeded day (the answer must be for the day shown). */
function reroot(spec: GraphSpec, root: SeededTask): GraphSpec {
  const map = (id: string) => (id === spec.root ? root.occurrenceId : id);
  return {
    ...spec,
    root: root.occurrenceId,
    nodes: spec.nodes.map((n) =>
      n.id === spec.root
        ? { ...n, id: root.occurrenceId, task: root.taskId }
        : n,
    ),
    edges: spec.edges.map(([p, d]) => [map(p), map(d)]),
  };
}

/** The preview a server would give for the same visible days (completion order is not modelled: the root last). */
function previewOf(
  g: DependencyGraph,
  over: Partial<DependencyPreview> = {},
): TasksResult<DependencyPreview> {
  return {
    ok: true,
    value: {
      token: TOKEN,
      items: [
        ...g.nodes.slice(1).map((n) => ({
          occurrence_id: n.occurrence_id,
          task_id: n.task_id,
          complete: n.outcome === "complete",
          can_complete: true,
          progress_version: null,
        })),
        {
          occurrence_id: g.root_id,
          task_id: g.nodes[0]?.task_id as string,
          complete: false,
          can_complete: true,
          progress_version: null,
        },
      ],
      unavailable: false,
      strict: g.nodes[0]?.strict ?? false,
      ...over,
    },
  };
}

type GraphAnswer = TasksResult<DependencyGraph>;

async function openDialog(options: {
  spec: GraphSpec;
  title?: string;
  /** The graph read's answers in turn (the last repeats); default: the spec's graph. */
  answers?: Array<(g: DependencyGraph) => GraphAnswer | Promise<GraphAnswer>>;
  preview?: (g: DependencyGraph) => TasksResult<DependencyPreview>;
}) {
  const root = await seededTask({ title: options.title ?? "Serve dinner" });
  const graph = buildGraph(reroot(options.spec, root));
  // A day with nothing to wait for has no "See" button: the preview then lists one visible day so the dialog can be opened.
  const preview =
    options.preview ??
    ((g: DependencyGraph) =>
      g.nodes.length > 1
        ? previewOf(g)
        : previewOf(buildGraph(reroot(chainSpec(), root))));
  const answers = options.answers ?? [(g) => ({ ok: true, value: g })];
  let n = 0;
  const api = fakeApi({
    readDependencies: async () => preview(graph),
    readDependencyGraph: async (_id, depth) => {
      if (depth === 1) return { ok: false, kind: "uncertain" };
      const answer = answers[Math.min(n, answers.length - 1)] as (
        g: DependencyGraph,
      ) => GraphAnswer | Promise<GraphAnswer>;
      n += 1;
      return answer(graph);
    },
  });
  const t = await mountTasks({
    path: `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`,
    rows: root.rows,
    api,
  });
  await t.until(
    () =>
      (document.querySelector("[data-dependencies]") as HTMLElement | null)
        ?.dataset.dependencies === "ready",
  );
  fireEvent.click(screen.getByRole("button", { name: DEPENDENCY_COPY.see }));
  await t.until(
    () =>
      dialog()?.dataset.dependencyDialog === "ready" &&
      section() !== null &&
      !["loading", "idle"].includes(section()?.dataset.dependencyGraph ?? ""),
  );
  return { t, root, graph, api };
}

/** The relationships the TREE shows: each nesting (child item needed by its parent item) and each reference. */
function treePairs(): Set<string> {
  const out = new Set<string>();
  for (const item of document.querySelectorAll<HTMLElement>(
    "[data-tree-node]",
  )) {
    const group = item.nextElementSibling;
    if (group?.getAttribute("role") !== "group") continue;
    for (const child of group.children) {
      const node = child.querySelector(":scope > [data-tree-node]");
      if (node)
        out.add(
          `${node.getAttribute("data-tree-node")}>${item.dataset.treeNode}`,
        );
      const ref = (child as HTMLElement).dataset.treeRef;
      if (ref) {
        const [dependant, prerequisite] = ref.split(">");
        out.add(`${prerequisite}>${dependant}`);
      }
    }
  }
  return out;
}
const edgePairs = (g: DependencyGraph) =>
  new Set(g.edges.map((e) => `${e.prerequisite_id}>${e.dependant_id}`));
const mapPairs = () =>
  new Set(
    [...document.querySelectorAll("[data-map-edge]")].map(
      (p) => p.getAttribute("data-map-edge") as string,
    ),
  );
/** Expands every collapsed item of the tree (Right on each), so every relationship is in the document. */
async function expandAll(t: { settle(): Promise<void> }) {
  for (let round = 0; round < 10; round += 1) {
    const closed = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-tree-node][aria-expanded=false]",
      ),
    ];
    if (closed.length === 0) return;
    for (const item of closed) fireEvent.keyDown(item, { key: "ArrowRight" });
    await t.settle();
  }
}
const nodeItem = (id: string) =>
  document.querySelector(`[data-tree-node="${id}"]`) as HTMLElement;

describe("S-G1..S-G3: the tree and the map agree with the answer's edges and states", () => {
  test.each([
    ["S-G1 chain", chainSpec],
    ["S-G2 branch", branchSpec],
    ["S-G3 shared prerequisite", sharedSpec],
    ["cross (same-column and right-to-left edges)", crossSpec],
  ])("%s", async (_name, spec) => {
    const { t, graph, api } = await openDialog({ spec: spec() });
    // Opening reads the whole graph ONCE (the applied revision becoming known is no change: request cost, D-18-5).
    expect(api.graphReads).toEqual([
      { occurrenceId: graph.root_id, maxDepth: undefined },
    ]);
    await expandAll(t);
    expect(treePairs()).toEqual(edgePairs(graph));
    expect(mapPairs()).toEqual(edgePairs(graph));
    for (const node of graph.nodes) {
      const item = nodeItem(node.occurrence_id);
      expect(item.dataset.state).toBe(node.dependency_state);
      expect(item).toHaveTextContent(
        node.occurrence_id === graph.root_id
          ? GRAPH_COPY.thisTask
          : GRAPH_COPY.state[node.dependency_state],
      );
      expect(
        document
          .querySelector(`[data-map-node="${node.occurrence_id}"]`)
          ?.getAttribute("data-state"),
      ).toBe(node.dependency_state);
    }
    // Each day is placed once.
    for (const node of graph.nodes)
      expect(
        document.querySelectorAll(`[data-tree-node="${node.occurrence_id}"]`),
      ).toHaveLength(1);
    // The map is decoration: hidden from assistive technology, nothing in it focusable.
    const map = document.querySelector("[data-graph-map]") as HTMLElement;
    expect(map.getAttribute("aria-hidden")).toBe("true");
    expect(map.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
    // The decorative chain of WEB-10c (connections implied by order) is gone, and so is the fallback list.
    expect(document.querySelector("[data-dependency-list]")).toBeNull();
    expect(
      (await axe(dialog()?.closest("[role=dialog]") as HTMLElement)).violations,
    ).toEqual([]);
  });

  test("S-G3: the shared prerequisite is referenced as 'Needs … too' and the summary names the open direct prerequisite", async () => {
    const { graph } = await openDialog({ spec: sharedSpec() });
    const refs = document.querySelectorAll("[data-tree-ref]");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toHaveTextContent(/Needs “Set the table · .*” too/);
    expect(document.querySelector("[data-graph-summary]")).toHaveTextContent(
      `${GRAPH_COPY.summary(2, 1)}. ${GRAPH_COPY.open(["Cook"])}. ${GRAPH_COPY.furtherBack(1)}.`,
    );
    expect(graph.direct_prerequisites).toHaveLength(2);
  });

  test("S-G3b: the summary keeps a title's own words (one containing '. and '), joining the hidden clause itself", async () => {
    const title = "Pay rent. and file return";
    await openDialog({
      spec: {
        root: gid(60),
        nodes: [
          { id: gid(60), task: gid(60, 1), title: "Move out", hidden: true },
          { id: gid(61), task: gid(61, 1), title },
        ],
        edges: [[gid(61), gid(60)]],
      },
    });
    const summary = document.querySelector(
      "[data-graph-summary]",
    ) as HTMLElement;
    expect(summary.textContent).toBe(
      `${GRAPH_COPY.summary(1, 0)}. ${GRAPH_COPY.open([title])}, ${GRAPH_COPY.hiddenToo}.`,
    );
    expect(summary.textContent).toContain(`“${title}”`);
  });
});

describe("S-G1b: one name for this day in both views", () => {
  test("the map's box for this day and the list's root item both use the day's title as the dialog shows it, whatever the answer's own title", async () => {
    // The answer's task title for the root ("Serve dinner", from the spec) differs from the day's cached title.
    const { graph } = await openDialog({
      spec: sharedSpec(),
      title: "Hang the washing",
    });
    const box = document.querySelector(
      `[data-map-node="${graph.root_id}"]`,
    ) as HTMLElement;
    expect(box).toHaveTextContent("Hang the washing");
    expect(box).not.toHaveTextContent("Serve dinner");
    expect(nodeItem(graph.root_id)).toHaveTextContent(
      `${GRAPH_COPY.thisTask}: Hang the washing`,
    );
  });
});

describe("S-G4 / S-G7: empty, and the graph and the preview disagreeing", () => {
  test("S-G4 the root alone: 'Nothing needs doing first', no map; the modes still follow the preview (S-G7)", async () => {
    await openDialog({ spec: emptySpec() });
    expect(
      document.querySelector("[data-graph-summary=none]"),
    ).toHaveTextContent(GRAPH_COPY.none);
    expect(document.querySelector("[data-graph-map]")).toBeNull();
    expect(document.querySelectorAll("[data-tree-node]")).toHaveLength(1);
    // The preview (another snapshot) still lists something open: the completion modes are the preview's, never the graph's.
    const modes = screen.getByRole("radiogroup", {
      name: DEPENDENCY_COPY.modesName,
    });
    expect(within(modes).getAllByRole("radio").length).toBeGreaterThan(1);
  });

  test("S-G7 a graph that can't be shown: the preview's order is the labelled fallback (and only then)", async () => {
    await openDialog({
      spec: chainSpec(),
      answers: [() => ({ ok: false, kind: "uncertain", requestId: "req-7" })],
    });
    expect(section()?.dataset.dependencyGraph).toBe("error");
    expect(document.querySelector("[data-graph-error]")).toHaveTextContent(
      GRAPH_COPY.failed,
    );
    expect(document.querySelector("[data-graph-error]")).toHaveTextContent(
      "req-7",
    );
    expect(
      document.querySelector("[data-dependency-fallback]"),
    ).toHaveTextContent(GRAPH_COPY.fallback);
    expect(document.querySelector("[data-dependency-list]")).not.toBeNull();
    expect(document.querySelector("[data-dependency-tree]")).toBeNull();
  });

  test("S-G7 strict from the preview: no Start anyway, said; and what can't be ticked is NAMED in the reason (D-18-11)", async () => {
    await openDialog({
      spec: chainSpec(),
      preview: (g) => {
        const p = previewOf(g, { strict: true });
        if (!p.ok) return p;
        const items = p.value.items.map((i, k) =>
          k === 0 ? { ...i, can_complete: false } : i,
        );
        return { ...p, value: { ...p.value, items } };
      },
    });
    expect(
      within(
        screen.getByRole("radiogroup", { name: DEPENDENCY_COPY.modesName }),
      )
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual([DEPENDENCY_COPY.wait]);
    expect(
      document.querySelector("[data-dependency-strict]"),
    ).toHaveTextContent(DEPENDENCY_COPY.strict("Serve dinner"));
    expect(
      document.querySelector("[data-mode-reason=complete_prerequisites]"),
    ).toHaveTextContent(DEPENDENCY_COPY.completeAllWhy.cannot_complete);
    // The graph's items are never annotated from the preview.
    expect(tree()).not.toHaveTextContent(DEPENDENCY_COPY.cantHere);
  });
});

describe("S-G5: restricted data is never presented as whole, and nothing hidden is shown or counted", () => {
  test.each([
    ["root restricted", restrictedRootSpec, true],
    ["middle node restricted", restrictedMidSpec, false],
    ["root restricted with nothing visible", restrictedOnlySpec, true],
  ])("%s", async (_name, spec, rootHidden) => {
    const { graph } = await openDialog({ spec: spec() });
    expect(document.querySelector("[data-graph-restricted]")).toHaveTextContent(
      GRAPH_COPY.restricted,
    );
    const summary = document.querySelector(
      "[data-graph-summary]",
    ) as HTMLElement;
    if (rootHidden)
      expect(summary).toHaveTextContent(
        graph.nodes.length === 1
          ? GRAPH_COPY.rootRestrictedOnly
          : GRAPH_COPY.hiddenToo,
      );
    else expect(summary).not.toHaveTextContent(GRAPH_COPY.hiddenToo);
    // No count of what is hidden, anywhere (WEB-10c's count sentence included).
    const text = dialog()?.closest("[role=dialog]")?.textContent ?? "";
    expect(text).not.toMatch(/\d+ (item|thing)s? you can't see/);
    expect(text).not.toContain(DEPENDENCY_COPY.hiddenCount(1));
    // Only the answer's own days are in the tree.
    expect(
      [...document.querySelectorAll("[data-tree-node]")]
        .map((e) => e.getAttribute("data-tree-node"))
        .sort(),
    ).toEqual(graph.nodes.map((n) => n.occurrence_id).sort());
    const hiddenNode = graph.nodes.find(
      (n) => n.restricted_prerequisites === true,
    );
    if (hiddenNode) {
      expect(nodeItem(hiddenNode.occurrence_id).dataset.state).toBe(
        hiddenNode.dependency_state,
      );
      fireEvent.keyDown(nodeItem(hiddenNode.occurrence_id), { key: "Enter" });
      expect(
        document.querySelector(
          `[data-graph-inspect="${hiddenNode.occurrence_id}"] [data-inspect-hidden]`,
        ),
      ).not.toBeNull();
    }
  });
});

describe("S-G6: an incomplete answer says so", () => {
  test("budget partial: the notice, an unexpanded day 'Not shown here' whose inspector offers to open it", async () => {
    const { t, graph } = await openDialog({ spec: budgetPartialSpec() });
    expect(document.querySelector("[data-graph-partial]")).toHaveTextContent(
      GRAPH_COPY.partial,
    );
    const cut = graph.nodes.find((n) => n.prerequisites === "unexpanded");
    const item = nodeItem(cut?.occurrence_id as string);
    expect(item).toHaveTextContent(GRAPH_COPY.state.unknown);
    expect(item.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(item);
    await t.settle();
    const inspector = document.querySelector(
      `[data-graph-inspect="${cut?.occurrence_id}"]`,
    ) as HTMLElement;
    expect(inspector).toHaveTextContent(GRAPH_COPY.notExpanded);
    expect(
      within(inspector).getByRole("button", { name: GRAPH_COPY.openTask }),
    ).toBeInTheDocument();
    // "Complete" is never claimed.
    expect(dialog()?.textContent).not.toMatch(/whole picture\b(?! )/);
  });
});

describe("S-G8: the inspector and 'Open this task'", () => {
  test("Enter on a day selects it and shows what it waits for and what needs it; Open closes the dialog and shows that day", async () => {
    const { t, graph } = await openDialog({ spec: sharedSpec() });
    const cook = gid(21);
    const item = nodeItem(cook);
    fireEvent.keyDown(item, { key: "Enter" });
    await t.settle();
    expect(item.getAttribute("aria-selected")).toBe("true");
    const inspector = document.querySelector(
      `[data-graph-inspect="${cook}"]`,
    ) as HTMLElement;
    expect(inspector).toHaveTextContent("Cook");
    expect(inspector).toHaveTextContent(GRAPH_COPY.direct);
    expect(inspector).toHaveTextContent(`${GRAPH_COPY.waitsFor} Set the table`);
    expect(inspector).toHaveTextContent(
      `${GRAPH_COPY.neededBy} ${GRAPH_COPY.thisTask}: Serve dinner`,
    );
    // The root has no Open.
    fireEvent.keyDown(nodeItem(graph.root_id), { key: "Enter" });
    await t.settle();
    expect(
      within(
        document.querySelector(
          `[data-graph-inspect="${graph.root_id}"]`,
        ) as HTMLElement,
      ).queryByRole("button", {
        name: GRAPH_COPY.openTask,
      }),
    ).toBeNull();
    fireEvent.keyDown(item, { key: "Enter" });
    await t.settle();
    fireEvent.click(
      within(
        document.querySelector(`[data-graph-inspect="${cook}"]`) as HTMLElement,
      ).getByRole("button", {
        name: GRAPH_COPY.openTask,
      }),
    );
    await t.until(() => dialog() === null);
    expect(dialog()).toBeNull();
    const node = graph.nodes.find((n) => n.occurrence_id === cook);
    expect(t.router.state.location.pathname).toBe(`/tasks/${node?.task_id}`);
    expect(t.router.state.location.search).toMatchObject({ occurrence: cook });
  });

  test("a pick on the map selects the day in the list and moves focus there", async () => {
    const { t } = await openDialog({ spec: sharedSpec() });
    fireEvent.click(
      document.querySelector(`[data-map-node="${gid(23)}"]`) as HTMLElement,
    );
    await t.settle();
    expect(document.activeElement).toBe(nodeItem(gid(23)));
    expect(nodeItem(gid(23)).getAttribute("aria-selected")).toBe("true");
  });
});

describe("S-G9: the keyboard model and the tree's semantics", () => {
  test("roving tab stop; Up/Down, Right opens then enters, Left closes then goes up, Home/End; a reference moves to its day", async () => {
    const { t, graph } = await openDialog({ spec: sharedSpec() });
    const t0 = tree() as HTMLElement;
    expect(t0.getAttribute("role")).toBe("tree");
    expect(t0).toHaveAccessibleName(GRAPH_COPY.treeName);
    expect(t0).toHaveAccessibleDescription(GRAPH_COPY.keys);
    const stops = [...t0.querySelectorAll("[role=treeitem]")].filter(
      (e) => e.getAttribute("tabindex") === "0",
    );
    expect(stops).toEqual([nodeItem(graph.root_id)]);
    const root = nodeItem(graph.root_id);
    expect(root.getAttribute("aria-level")).toBe("1");
    expect(root.getAttribute("aria-expanded")).toBe("true");
    // Cook (level 2, first of two) is open by default (a direct prerequisite), Set the table under it (level 3).
    const cook = nodeItem(gid(21));
    expect(cook.getAttribute("aria-level")).toBe("2");
    expect(cook.getAttribute("aria-posinset")).toBe("1");
    expect(cook.getAttribute("aria-setsize")).toBe("2");
    expect(nodeItem(gid(23)).getAttribute("aria-level")).toBe("3");
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cook);
    fireEvent.keyDown(cook, { key: "ArrowLeft" });
    await t.settle();
    expect(cook.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(`[data-tree-node="${gid(23)}"]`)).toBeNull();
    fireEvent.keyDown(cook, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(cook, { key: "ArrowRight" });
    await t.settle();
    expect(cook.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(cook, { key: "ArrowRight" });
    expect(document.activeElement).toBe(nodeItem(gid(23)));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    const ref = document.querySelector("[data-tree-ref]") as HTMLElement;
    expect(document.activeElement).toBe(ref);
    expect(ref.getAttribute("role")).toBe("treeitem");
    fireEvent.keyDown(ref, { key: "Enter" });
    await t.settle();
    expect(document.activeElement).toBe(nodeItem(gid(23)));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(root);
  });

  test("a reference to a day under a CLOSED branch opens the way to it", async () => {
    const { t } = await openDialog({ spec: sharedSpec() });
    fireEvent.keyDown(nodeItem(gid(21)), { key: "ArrowLeft" });
    await t.settle();
    expect(document.querySelector(`[data-tree-node="${gid(23)}"]`)).toBeNull();
    fireEvent.keyDown(
      document.querySelector("[data-tree-ref]") as HTMLElement,
      { key: " " },
    );
    await t.settle();
    expect(document.activeElement).toBe(nodeItem(gid(23)));
    expect(nodeItem(gid(21)).getAttribute("aria-expanded")).toBe("true");
  });

  // WEB-18 maintenance merge of 2f42ac35 (7 November 2026): about 5 s on the merged tree under a loaded controller, the default limit; the
  // suite's SLOW timeout (timing only, nothing asserted changes).
  test(
    "S-G9b: a key held with Alt, Ctrl or Meta is left to the browser (history Back, word moves); the plain key is the tree's",
    SLOW,
    async () => {
      const { t, graph } = await openDialog({ spec: sharedSpec() });
      const root = nodeItem(graph.root_id);
      const cook = nodeItem(gid(21));
      cook.focus();
      for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const)
        for (const key of [
          "ArrowLeft",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "Enter",
          " ",
        ]) {
          const taken = !fireEvent.keyDown(cook, { key, [modifier]: true });
          await t.settle();
          expect(taken, `${modifier}+${key} is not taken`).toBe(false);
          expect(document.activeElement, `${modifier}+${key}`).toBe(cook);
          expect(cook.getAttribute("aria-expanded")).toBe("true");
          expect(document.querySelector("[data-graph-inspect]")).toBeNull();
        }
      // Control: the same element and keys without a modifier are handled (prevented) and act.
      expect(fireEvent.keyDown(cook, { key: "ArrowLeft" })).toBe(false);
      await t.settle();
      expect(cook.getAttribute("aria-expanded")).toBe("false");
      expect(fireEvent.keyDown(cook, { key: "ArrowUp" })).toBe(false);
      expect(document.activeElement).toBe(root);
      // Shift is not a browser shortcut here and changes nothing about the tree's keys.
      expect(
        fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }),
      ).toBe(false);
      expect(document.activeElement).toBe(cook);
    },
  );
});

describe("S-G10: states and the map's conditions", () => {
  test("checking, then stale after a failed re-read (labelled with its time), then a fresh answer replaces it", async () => {
    let release: (() => void) | null = null;
    const { t, graph } = await openDialog({
      spec: chainSpec(),
      answers: [
        (g) => ({ ok: true, value: g }),
        (g) =>
          new Promise<GraphAnswer>((resolve) => {
            release = () => resolve({ ok: true, value: g });
          }),
        () => ({ ok: false, kind: "uncertain" }),
        (g) => ({ ok: true, value: g }),
      ],
    });
    expect(section()?.dataset.dependencyGraph).toBe("ready");
    fireEvent.click(
      screen.getByRole("button", { name: GRAPH_COPY.checkAgain }),
    );
    await t.settle();
    expect(section()?.dataset.dependencyGraph).toBe("checking");
    expect(section()?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("[data-graph-checking]")).toHaveTextContent(
      GRAPH_COPY.checking,
    );
    // The previous whole answer stays meanwhile.
    expect(nodeItem(graph.root_id)).not.toBeNull();
    await act(async () => {
      release?.();
    });
    await t.settle();
    expect(section()?.dataset.dependencyGraph).toBe("ready");
    fireEvent.click(
      screen.getByRole("button", { name: GRAPH_COPY.checkAgain }),
    );
    await t.until(() => section()?.dataset.dependencyGraph === "stale");
    expect(document.querySelector("[data-graph-stale]")).toHaveTextContent(
      /Couldn't check again\. Shown as it was at \d\d:\d\d\./,
    );
    fireEvent.click(
      within(
        document.querySelector("[data-graph-stale]") as HTMLElement,
      ).getByRole("button", {
        name: "Try again",
      }),
    );
    await t.until(() => section()?.dataset.dependencyGraph === "ready");
    expect(document.querySelector("[data-graph-stale]")).toBeNull();
  });

  test("S-G10b: 'Try again' from the stale notice says it is checking (busy) until the answer replaces it", async () => {
    let release: (() => void) | null = null;
    const { t } = await openDialog({
      spec: chainSpec(),
      answers: [
        (g) => ({ ok: true, value: g }),
        () => ({ ok: false, kind: "uncertain" }),
        (g) =>
          new Promise<GraphAnswer>((resolve) => {
            release = () => resolve({ ok: true, value: g });
          }),
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: GRAPH_COPY.checkAgain }),
    );
    await t.until(() => section()?.dataset.dependencyGraph === "stale");
    expect(section()?.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector("[data-graph-checking]")).toBeNull();
    const stale = document.querySelector("[data-graph-stale]") as HTMLElement;
    fireEvent.click(within(stale).getByRole("button", { name: "Try again" }));
    await t.settle();
    // Still the old answer, still labelled stale, and now visibly checking beside the button that asked.
    expect(section()?.dataset.dependencyGraph).toBe("stale");
    expect(section()?.getAttribute("aria-busy")).toBe("true");
    expect(stale.querySelector("[data-graph-checking]")).toHaveTextContent(
      GRAPH_COPY.checking,
    );
    expect(document.querySelectorAll("[data-graph-checking]")).toHaveLength(1);
    await act(async () => {
      release?.();
    });
    await t.settle();
    expect(section()?.dataset.dependencyGraph).toBe("ready");
    expect(section()?.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector("[data-graph-checking]")).toBeNull();
  });

  test("S-G10c: 'Try again' from the error says it is checking (busy) while the preview's fallback list stays", async () => {
    let release: ((a: GraphAnswer) => void) | null = null;
    const { t, graph } = await openDialog({
      spec: chainSpec(),
      answers: [
        () => ({ ok: false, kind: "uncertain", requestId: "req-7" }),
        () =>
          new Promise<GraphAnswer>((resolve) => {
            release = resolve;
          }),
        (g) => ({ ok: true, value: g }),
      ],
    });
    expect(section()?.dataset.dependencyGraph).toBe("error");
    expect(section()?.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector("[data-graph-checking]")).toBeNull();
    const error = document.querySelector("[data-graph-error]") as HTMLElement;
    fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
    await t.settle();
    expect(section()?.dataset.dependencyGraph).toBe("error");
    expect(section()?.getAttribute("aria-busy")).toBe("true");
    expect(error.querySelector("[data-graph-checking]")).toHaveTextContent(
      GRAPH_COPY.checking,
    );
    expect(document.querySelector("[data-dependency-list]")).not.toBeNull();
    // Failing again: the error stands, no longer checking.
    await act(async () => {
      release?.({ ok: false, kind: "uncertain" });
    });
    await t.settle();
    expect(section()?.dataset.dependencyGraph).toBe("error");
    expect(section()?.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector("[data-graph-checking]")).toBeNull();
    fireEvent.click(
      within(
        document.querySelector("[data-graph-error]") as HTMLElement,
      ).getByRole("button", { name: "Try again" }),
    );
    await t.until(() => section()?.dataset.dependencyGraph === "ready");
    expect(nodeItem(graph.root_id)).not.toBeNull();
  });

  test("a refusal removes the view: the screen says it can't be shown, and the preview's fallback list stands", async () => {
    await openDialog({
      spec: chainSpec(),
      answers: [() => ({ ok: false, kind: "not_found" })],
    });
    expect(section()?.dataset.dependencyGraph).toBe("refused");
    expect(document.querySelector("[data-graph-refused]")).not.toBeNull();
    expect(document.querySelector("[data-dependency-tree]")).toBeNull();
    expect(document.querySelector("[data-dependency-list]")).not.toBeNull();
  });

  test("below 1280 px the list alone (no map), without the 'too much' note", async () => {
    media.set({ width: 1000 });
    await openDialog({ spec: sharedSpec() });
    expect(document.querySelector("[data-graph-map]")).toBeNull();
    expect(document.querySelector("[data-graph-too-much]")).toBeNull();
    expect(tree()).not.toBeNull();
    expect(
      dialog()?.closest("[role=dialog]")?.getAttribute("data-dialog-size"),
    ).toBe("wide");
  });

  test("deeper than the map draws: the list alone, with the note", async () => {
    const { t, graph } = await openDialog({ spec: deepSpec(6) });
    expect(document.querySelector("[data-graph-map]")).toBeNull();
    expect(document.querySelector("[data-graph-too-much]")).toHaveTextContent(
      GRAPH_COPY.tooMuch,
    );
    await expandAll(t);
    expect(treePairs()).toEqual(edgePairs(graph));
  });
});

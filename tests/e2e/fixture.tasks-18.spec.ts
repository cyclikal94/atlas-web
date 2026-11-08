import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  budgetPartialSpec,
  crossSpec,
  emptySpec,
  type GraphSpec,
  gid,
  maximalSpec,
  restrictedMidSpec,
  restrictedRootSpec,
  rootGraph,
  sharedSpec,
} from "../support/tasks/graphs";
import { recordEvidence } from "./data-evidence";
import { serveIdentityReads } from "./data-local-faults";
import {
  type SyncStub,
  seedSettled,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";
import { runAxe } from "./helpers";
import {
  held,
  type Reads10c,
  refusal,
  serveTasks10c,
} from "./tasks-10c-helpers";
import {
  type GraphReads,
  graphFor,
  previewFor,
  serveGraph,
} from "./tasks-18-helpers";
import {
  type BuiltTask,
  bodiesOf,
  buildTask,
  cacheTasks,
  draftsOf,
  serveTaskReads,
} from "./tasks-helpers";

/**
 * WEB-18 in Chromium, Firefox and WebKit: "What needs doing first" drawn from ONE dependency-graph answer, over the PRODUCTION session and
 * protected tree (`/__session`), the production data controller and REAL IndexedDB. Every server answer is the route double's
 * (`tests/e2e/tasks-18-helpers.ts`): FIXTURE evidence, never integration evidence (I-18-* run against the released backend).
 *
 * E-G1 the map and the tree agree with the served edges and states at 1440 px (keyboard, references, a map pick, Open, focus return, axe
 * in light and dark); E-G2 390 px and 1180 px (the list alone, no overflow, 44 px targets, the empty graph); E-G3 restricted answers;
 * E-G4 partial and maximal answers; E-G5 an earlier answer delivered after a later one is never shown; E-G7 offline, 503, no answer,
 * 404 and a stale re-read; E-G9 the editor's depth-one read, its base version and the restricted root. (E-G6, an answer held across an
 * account switch, is jsdom H-2: a switch remounts the detail, so the dialog that held the read is gone.)
 */
const ROOT = (n: number, title: string) => buildTask({ n, title });

async function bootAt(
  context: BrowserContext,
  route: string,
  viewport?: { width: number; height: number },
): Promise<Page> {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

async function setup(
  context: BrowserContext,
  root: BuiltTask,
  others: BuiltTask[],
  arrange: (r10c: Reads10c, graph: GraphReads) => void,
  viewport = { width: 1440, height: 900 },
): Promise<{ page: Page; net: SyncStub; r10c: Reads10c; graph: GraphReads }> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await serveTaskReads(context);
  const r10c = await serveTasks10c(context);
  const graph = await serveGraph(context);
  arrange(r10c, graph);
  await seedSettled(context);
  const page = await bootAt(
    context,
    `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`,
    viewport,
  );
  await cacheTasks(page, net, [root, ...others]);
  await untilTreeSettled(page);
  return { page, net, r10c, graph };
}

/** Serves `g` for the full read and its preview; opens the dialog with the keyboard. */
async function openDialog(page: Page) {
  const opener = page.getByRole("button", {
    name: "See what needs doing first",
  });
  await expect(opener).toBeVisible();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return { dialog, opener };
}

const edgeSet = (g: {
  edges: Array<{ prerequisite_id: string; dependant_id: string }>;
}) =>
  [
    ...new Set(g.edges.map((e) => `${e.prerequisite_id}>${e.dependant_id}`)),
  ].sort();
const mapEdges = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-map-edge]")]
      .map((p) => p.getAttribute("data-map-edge") as string)
      .sort(),
  );
/** Expands the whole tree, then reads its nesting and reference pairs. */
async function treeEdges(page: Page): Promise<string[]> {
  for (let round = 0; round < 10; round += 1) {
    const closed = page.locator("[data-tree-node][aria-expanded=false]");
    const n = await closed.count();
    if (n === 0) break;
    for (let i = 0; i < n; i += 1) {
      await closed.first().focus();
      await page.keyboard.press("ArrowRight");
    }
  }
  return page.evaluate(() => {
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
    return [...out].sort();
  });
}
const overflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

for (const scheme of ["light", "dark"] as const)
  test.describe(`E-G1: the map and the list agree with the served edges (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    for (const [name, spec] of [
      ["shared prerequisite", sharedSpec],
      ["same-column and right-to-left edges", crossSpec],
    ] as const)
      test(`${name}: edges and states, keyboard, a reference, a map pick, axe, focus return`, async ({
        context,
      }, info) => {
        const root = ROOT(1801, "Serve dinner");
        const g = graphFor(root, spec() as GraphSpec);
        const { page, graph } = await setup(context, root, [], (r, s) => {
          r.preview = () => previewFor(g);
          s.answer = () => ({ status: 200, body: g });
        });
        const { dialog, opener } = await openDialog(page);
        await expect(
          dialog.locator("[data-dependency-graph=ready]"),
        ).toBeVisible();
        expect(graph.log.map((l) => l.maxDepth)).toEqual([null]);
        // The map is decoration (hidden from assistive technology, nothing focusable); the list is the control.
        const map = dialog.locator("[data-graph-map]");
        await expect(map).toHaveAttribute("aria-hidden", "true");
        await expect(map.locator("button, a, [tabindex]")).toHaveCount(0);
        expect(await mapEdges(page)).toEqual(edgeSet(g));
        for (const n of g.nodes)
          await expect(
            dialog.locator(`[data-map-node="${n.occurrence_id}"]`),
          ).toHaveAttribute("data-state", n.dependency_state);
        expect(await runAxe(page)).toEqual([]);
        expect(await treeEdges(page)).toEqual(edgeSet(g));
        for (const n of g.nodes)
          await expect(
            dialog.locator(`[data-tree-node="${n.occurrence_id}"]`),
          ).toHaveAttribute("data-state", n.dependency_state);
        // Keyboard: the root is the tab stop; Down, Home and End move; a reference moves to its day.
        const rootItem = dialog.locator(
          `[data-tree-node="${root.occurrenceId}"]`,
        );
        await rootItem.focus();
        await page.keyboard.press("ArrowDown");
        await expect(rootItem).not.toBeFocused();
        await page.keyboard.press("Home");
        await expect(rootItem).toBeFocused();
        await page.keyboard.press("End");
        const ref = dialog.locator("[data-tree-ref]").last();
        if ((await ref.count()) > 0) {
          const target = (
            (await ref.getAttribute("data-tree-ref")) as string
          ).split(">")[1] as string;
          await ref.focus();
          await page.keyboard.press("Enter");
          await expect(
            dialog.locator(`[data-tree-node="${target}"]`),
          ).toBeFocused();
        }
        // A pick on the map selects the day in the list and moves focus there.
        const pick = g.nodes[g.nodes.length - 1]?.occurrence_id as string;
        await dialog.locator(`[data-map-node="${pick}"]`).click();
        await expect(
          dialog.locator(`[data-tree-node="${pick}"]`),
        ).toBeFocused();
        await expect(
          dialog.locator(`[data-tree-node="${pick}"]`),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
          dialog.locator(`[data-graph-inspect="${pick}"]`),
        ).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        recordEvidence(info, `e-g1-${scheme}`, { reads: graph.log });
      });
  });

test.describe("E-G1: Open this task", () => {
  test("the inspector's Open closes the dialog and shows that day", async ({
    context,
  }) => {
    const root = ROOT(1802, "Serve dinner");
    const cook = ROOT(1803, "Cook");
    const g = graphFor(root, sharedSpec(), { [gid(21)]: cook });
    const { page } = await setup(context, root, [cook], (r, s) => {
      r.preview = () => previewFor(g);
      s.answer = () => ({ status: 200, body: g });
    });
    const { dialog } = await openDialog(page);
    const item = dialog.locator(`[data-tree-node="${cook.occurrenceId}"]`);
    await item.focus();
    await page.keyboard.press("Enter");
    await dialog
      .locator(`[data-graph-inspect="${cook.occurrenceId}"]`)
      .getByRole("button", { name: "Open this task" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(
      new RegExp(`/tasks/${cook.taskId}\\?occurrence=${cook.occurrenceId}`),
    );
  });
});

for (const scheme of ["light", "dark"] as const)
  test.describe(`E-G2: narrow and tablet screens (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    for (const [width, height] of [
      [390, 844],
      [1180, 820],
    ] as const)
      test(`${width}×${height}: the list alone, no overflow, 44 px targets, axe; the empty graph`, async ({
        context,
      }) => {
        const root = ROOT(1810 + width / 10, "Serve dinner");
        const g = graphFor(root, sharedSpec());
        const { page } = await setup(
          context,
          root,
          [],
          (r, s) => {
            r.preview = () => previewFor(g);
            s.answer = () => ({ status: 200, body: g });
          },
          { width, height },
        );
        const { dialog } = await openDialog(page);
        await expect(dialog.locator("[data-dependency-tree]")).toBeVisible();
        await expect(dialog.locator("[data-graph-map]")).toHaveCount(0);
        for (const item of await dialog.locator("[role=treeitem]").all()) {
          const box = await item.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await runAxe(page)).toEqual([]);
      });
    test("the empty graph: 'Nothing needs doing first', the root alone, axe", async ({
      context,
    }) => {
      const root = ROOT(1820, "Water plants");
      const g = graphFor(root, emptySpec());
      const preview = graphFor(root, sharedSpec());
      const { page } = await setup(context, root, [], (r, s) => {
        r.preview = () => previewFor(preview);
        s.answer = () => ({ status: 200, body: g });
      });
      const { dialog } = await openDialog(page);
      await expect(dialog.locator("[data-graph-summary=none]")).toHaveText(
        "Nothing needs doing first",
      );
      await expect(dialog.locator("[data-tree-node]")).toHaveCount(1);
      await expect(dialog.locator("[data-graph-map]")).toHaveCount(0);
      expect(await runAxe(page)).toEqual([]);
    });
  });

test.describe("E-G3: restricted answers are never presented as whole", () => {
  for (const [name, spec] of [
    ["root", restrictedRootSpec],
    ["middle node", restrictedMidSpec],
  ] as const)
    test(`restricted ${name}: the notice, no count, only served days`, async ({
      context,
    }) => {
      const root = ROOT(1830, "Birthday party");
      const g = graphFor(root, spec());
      const { page } = await setup(context, root, [], (r, s) => {
        r.preview = () => previewFor(g);
        s.answer = () => ({ status: 200, body: g });
      });
      const { dialog } = await openDialog(page);
      await expect(dialog.locator("[data-graph-restricted]")).toContainText(
        "isn't the whole picture",
      );
      const text = (await dialog.textContent()) ?? "";
      expect(text).not.toMatch(/\d+ (item|thing)s? you can't see/);
      const shown = await dialog.evaluate((d) =>
        [...d.querySelectorAll("[data-tree-node]")]
          .map((e) => e.getAttribute("data-tree-node"))
          .sort(),
      );
      expect(shown).toEqual(g.nodes.map((n) => n.occurrence_id).sort());
      expect(await runAxe(page)).toEqual([]);
    });
});

test.describe("E-G4: incomplete and large answers", () => {
  test("a budget-partial answer: the notice and 'Not shown here'", async ({
    context,
  }) => {
    const root = ROOT(1840, "Launch");
    const g = graphFor(root, budgetPartialSpec());
    const { page } = await setup(context, root, [], (r, s) => {
      r.preview = () => previewFor(g);
      s.answer = () => ({ status: 200, body: g });
    });
    const { dialog } = await openDialog(page);
    await expect(dialog.locator("[data-graph-partial]")).toBeVisible();
    await expect(dialog.locator(`[data-tree-node="${gid(72)}"]`)).toContainText(
      "Not shown here",
    );
    expect(await runAxe(page)).toEqual([]);
  });

  test("the maximal answer (200 days, 5,872 edges): the list alone with the note, expandable, no overflow", async ({
    context,
  }, info) => {
    const root = ROOT(1841, "Item root");
    const g = graphFor(root, maximalSpec());
    const { page } = await setup(context, root, [], (r, s) => {
      // The preview is bounded at 200 items too; it lists the visible days.
      r.preview = () => previewFor(g);
      s.answer = () => ({ status: 200, body: g });
    });
    const started = Date.now();
    const { dialog } = await openDialog(page);
    await expect(dialog.locator("[data-graph-too-much]")).toBeVisible({
      timeout: 20_000,
    });
    const rendered = Date.now() - started;
    await expect(dialog.locator("[data-graph-map]")).toHaveCount(0);
    const closed = dialog
      .locator("[data-tree-node][aria-expanded=false]")
      .first();
    await closed.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      dialog.locator("[data-tree-node][aria-expanded=true]").nth(1),
    ).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await runAxe(page)).toEqual([]);
    // An observation only (no timing is asserted).
    recordEvidence(info, "e-g4-maximal", { renderedMs: rendered });
  });
});

test.describe("E-G5: ordering", () => {
  test("an answer asked before the connection dropped and delivered after a later one is never shown", async ({
    context,
  }) => {
    const root = ROOT(1850, "Serve dinner");
    const first = graphFor(root, sharedSpec());
    const later = graphFor(root, crossSpec());
    const hold = held<void>();
    let n = 0;
    const { page, graph } = await setup(context, root, [], (r, s) => {
      r.preview = () => previewFor(first);
      s.answer = async () => {
        n += 1;
        if (n === 1) {
          await hold.promise;
          return { status: 200, body: first };
        }
        return { status: 200, body: later };
      };
    });
    const { dialog } = await openDialog(page);
    await expect.poll(() => graph.log.length).toBe(1);
    await context.setOffline(true);
    await expect(dialog).toContainText("Can be checked when you're online.");
    await context.setOffline(false);
    await expect.poll(() => graph.log.length).toBeGreaterThanOrEqual(2);
    await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible();
    await expect(dialog.locator("[data-dependency-tree]")).toContainText(
      "Pack boxes",
    );
    hold.release();
    // Long enough for the late answer to be composed and shown, were it applied.
    await page.waitForTimeout(1_500);
    await expect(dialog.locator("[data-dependency-tree]")).toContainText(
      "Pack boxes",
    );
    await expect(dialog.locator("[data-dependency-tree]")).not.toContainText(
      "Set the table",
    );
  });
});

test.describe("E-G7: offline, unavailable and stale reads", () => {
  test("503 and no answer: the error with Try again, and the preview's labelled fallback; 404 removes the view", async ({
    context,
  }) => {
    const root = ROOT(1860, "Serve dinner");
    const g = graphFor(root, sharedSpec());
    const answers = [
      refusal(503, "temporarily_unavailable"),
      { status: 0, body: null },
      { status: 200, body: g },
    ];
    let n = 0;
    const { page } = await setup(context, root, [], (r, s) => {
      r.preview = () => previewFor(g);
      s.answer = () =>
        answers[Math.min(n++, answers.length - 1)] as {
          status: number;
          body: unknown;
        };
    });
    const { dialog } = await openDialog(page);
    await expect(dialog.locator("[data-graph-error]")).toContainText(
      "Couldn't show how these connect",
    );
    await expect(dialog.locator("[data-dependency-fallback]")).toBeVisible();
    await expect(dialog.locator("[data-dependency-list] li")).toHaveCount(4);
    await dialog
      .locator("[data-graph-error]")
      .getByRole("button", { name: "Try again" })
      .click();
    await expect(dialog.locator("[data-graph-error]")).toBeVisible();
    await dialog
      .locator("[data-graph-error]")
      .getByRole("button", { name: "Try again" })
      .click();
    await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible();
    await expect(dialog.locator("[data-dependency-list]")).toHaveCount(0);
  });

  test("a failed re-read keeps the last whole answer, labelled with its time; a 404 then removes it", async ({
    context,
  }) => {
    const root = ROOT(1861, "Serve dinner");
    const g = graphFor(root, sharedSpec());
    const answers = [
      { status: 200, body: g },
      refusal(503, "temporarily_unavailable"),
      refusal(404, "not_found"),
    ];
    let n = 0;
    const { page } = await setup(context, root, [], (r, s) => {
      r.preview = () => previewFor(g);
      s.answer = () =>
        answers[Math.min(n++, answers.length - 1)] as {
          status: number;
          body: unknown;
        };
    });
    const { dialog } = await openDialog(page);
    await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible();
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(dialog.locator("[data-graph-stale]")).toContainText(
      /Shown as it was at \d\d:\d\d\./,
    );
    await expect(dialog.locator("[data-dependency-tree]")).toBeVisible();
    await dialog
      .locator("[data-graph-stale]")
      .getByRole("button", { name: "Try again" })
      .click();
    await expect(dialog.locator("[data-graph-refused]")).toBeVisible();
    await expect(dialog.locator("[data-dependency-tree]")).toHaveCount(0);
  });

  test("offline: the view is hidden, never a stale snapshot; back online it is read again", async ({
    context,
  }) => {
    const root = ROOT(1862, "Serve dinner");
    const g = graphFor(root, sharedSpec());
    const { page, graph } = await setup(context, root, [], (r, s) => {
      r.preview = () => previewFor(g);
      s.answer = () => ({ status: 200, body: g });
    });
    const { dialog } = await openDialog(page);
    await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible();
    await context.setOffline(true);
    await expect(dialog).toContainText("Can be checked when you're online.");
    await expect(dialog.locator("[data-dependency-tree]")).toHaveCount(0);
    const before = graph.log.length;
    await context.setOffline(false);
    await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible();
    expect(graph.log.length).toBeGreaterThan(before);
  });
});

test.describe("E-G9: the editor's own depth-one read", () => {
  test("asks max_depth=1, starts from the served direct list, and the queued command carries the served root version", async ({
    context,
  }) => {
    const root = ROOT(1870, "Hang the washing");
    const pre = ROOT(1871, "Run the washing machine");
    const { page, graph } = await setup(context, root, [pre], (r, s) => {
      r.preview = () =>
        previewFor(
          rootGraph({
            root: root.occurrenceId,
            task: root.taskId,
            title: "Hang the washing",
          }),
        );
      s.answer = (q) => ({
        status: 200,
        body: rootGraph({
          root: root.occurrenceId,
          task: root.taskId,
          title: "Hang the washing",
          version: 5,
          direct: [
            {
              id: pre.occurrenceId,
              task: pre.taskId,
              title: "Run the washing machine",
            },
          ],
          maxDepth: q.maxDepth === "1" ? 1 : 200,
        }),
      });
    });
    await page.getByRole("button", { name: "Set what this waits for" }).click();
    const editor = page.locator("[data-dependency-editor]");
    await expect(editor).toHaveAttribute("data-dependency-editor", "open");
    expect(graph.log.map((l) => l.maxDepth)).toEqual(["1"]);
    await expect(
      page.locator(`[data-editor-item="${pre.occurrenceId}"]`),
    ).toContainText("Run the washing machine");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await draftsOf(page)).length).toBe(1);
    const [body] = await bodiesOf(page);
    expect(body?.command.command).toMatchObject({
      kind: "set_dependencies",
      occurrence_id: root.occurrenceId,
      expected_version: 5,
      prerequisites: [pre.occurrenceId],
    });
  });

  test("a root with hidden prerequisites: saving would remove them, so Save is withheld", async ({
    context,
  }) => {
    const root = ROOT(1872, "Hang the washing");
    const { page } = await setup(context, root, [], (r, s) => {
      r.preview = () =>
        previewFor(
          rootGraph({
            root: root.occurrenceId,
            task: root.taskId,
            title: "Hang the washing",
          }),
        );
      s.answer = () => ({
        status: 200,
        body: rootGraph({
          root: root.occurrenceId,
          task: root.taskId,
          title: "Hang the washing",
          hidden: true,
        }),
      });
    });
    await page.getByRole("button", { name: "Set what this waits for" }).click();
    const editor = page.locator("[data-dependency-editor]");
    await expect(editor).toHaveAttribute(
      "data-dependency-editor",
      "restricted",
    );
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(await draftsOf(page)).toHaveLength(0);
  });
});

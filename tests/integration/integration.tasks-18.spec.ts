import { readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import * as commands from "../../src/features/tasks/model/commands";
import type {
  DependencyGraph,
  DependencyPreview,
  OccurrenceView,
  TaskDefinition,
} from "../../src/features/tasks/model/contract";
import { occurrenceId, progressId } from "../../src/features/tasks/model/ids";
import { slotOn, todayIn } from "../../src/features/tasks/model/time";
import {
  bootHarness,
  expect,
  exposeSession,
  paceSignIn,
  signIn as signInUnpaced,
  stackFile,
  test,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-18 against the RELEASED backend (the release named by `contract-pin.json`: `v0.31.0-rc.1`, API 0.31.0, which ships
 * BE-DEPENDENCY-GRAPH's `getDependencyGraph`) on a disposable SQLite database behind the delaying proxy: the production session, the
 * production data controller and the task screens, with the FIXTURE leader standing in for WEB-09b's production leadership (the WEB-10a
 * harness). FOCUSED REAL-BACKEND EVIDENCE: BE-Q1, BE-B6 and BE-CH1 have no completion record, so this is NOT integration acceptance
 * (`integration_passed` stays false). No PostgreSQL, HTTPS or device.
 *
 * The oracle of every case is a helper read of the same endpoint (`x-atlas-test-helper`), compared with what the screen shows. Cases:
 * I-18-G1 a chain; I-18-G2 a branch with a shared prerequisite; I-18-G3 changed dependencies to an empty graph; I-18-G4 a restricted
 * root read by another account (nothing hidden in the document); I-18-G5 a restricted middle node; I-18-G6 the editor from the
 * authoritative list; I-18-G7a a stale write refused `409` (sync paused); I-18-G7b a stale base seen first (sync running); I-18-G8 the
 * editor's `max_depth=1` read and a real `partial` body; I-18-G9 offline after a shown view.
 */
const API = "/api/experimental/v1";
const HELPER = "x-atlas-test-helper";

const budget = (who: Who) => paceSignIn(who);
// Accounts this stack's other specs do not use (tasks and tasks-10c rotate alice, carol, dave and erin, with frank and grace).
const ROTATION: Who[] = ["heidi", "ivan", "judy", "kate"];
const OTHER: Who = "liam";
const ROTATION_FILE = stackFile("atlas-tasks-18-rotation.txt");
let main: Who = "heidi";
test.beforeEach(async ({ context }, info) => {
  void context;
  let n = 0;
  try {
    n = Number(readFileSync(ROTATION_FILE, "utf8")) || 0;
  } catch {
    n = 0;
  }
  writeFileSync(ROTATION_FILE, String(n + 1));
  main = ROTATION[n % ROTATION.length] as Who;
  info.setTimeout(240_000);
});

interface Id {
  account_id: string;
  epoch: number;
}
async function signedIn(page: Page, who: Who): Promise<Id> {
  await budget(who);
  expect((await signInUnpaced(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = (await page.evaluate(() =>
    window.__s.identity.get(),
  )) as Id | null;
  if (!id) throw new Error("no identity after sign-in");
  return id;
}

async function bootAs(context: BrowserContext, who: Who) {
  const page = await bootHarness(context, "/tasks");
  const id = await signedIn(page, who);
  await page.evaluate(
    (a) => window.__atlasData?.prepareAccount(a),
    id.account_id,
  );
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, id.account_id);
  await page.goto(`/__session?route=${encodeURIComponent("/tasks")}`);
  await exposeSession(page);
  await untilView(page, "displaying");
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, id.account_id);
  return { page, id };
}

const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

interface Raw {
  status: number;
  body: unknown;
}
/** One stamped request made in the page (the session's own client), marked as a helper's, asked again while the session answers `not_sent`. */
const call = (
  page: Page,
  id: Id,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  key?: string,
) =>
  page.evaluate(
    async ({ id, method, path, body, key }) => {
      const fetchFor = window.__s.api.fetchFor(
        "ordinary",
        id.account_id,
        id.epoch,
      );
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await fetchFor(
            new Request(`${location.origin}/api/experimental/v1${path}`, {
              method,
              headers: {
                "x-atlas-test-helper": "1",
                ...(body === undefined
                  ? {}
                  : { "content-type": "application/json" }),
                ...(key ? { "Idempotency-Key": key } : {}),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
          const text = await response.text();
          return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
          };
        } catch (error) {
          if (
            !String((error as { kind?: string }).kind ?? error).includes(
              "not_sent",
            ) ||
            attempt >= 60
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    { id, method, path, body, key },
  ) as Promise<Raw>;

const access = (page: Page, id: Id, command: Record<string, unknown>) =>
  call(
    page,
    id,
    "POST",
    "/task-access-commands",
    { command },
    crypto.randomUUID(),
  );

const ZONE = "Europe/London";
const def = (): TaskDefinition => ({
  schedule: {
    start_date: todayIn(ZONE, Date.now()),
    time: null,
    timezone: ZONE,
    repeat: null,
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
});

interface Made {
  taskId: string;
  occurrenceId: string;
  progressId: string;
}
async function makeTask(
  page: Page,
  id: Id,
  title: string,
  grants?: Array<{ kind: "account"; id: string; edit: boolean }>,
): Promise<Made> {
  const definition = def();
  const taskId = crypto.randomUUID();
  const slot = slotOn(definition.schedule, definition.schedule.start_date);
  const occ = await occurrenceId(taskId, slot.key);
  const prog = await progressId(occ, id.account_id);
  const body = commands
    .createTask({
      taskId,
      executionId: crypto.randomUUID(),
      occurrenceId: occ,
      progressId: prog,
      title,
      definition,
      sharing: "only_me",
      defaults: null,
    })
    .build({}).command as { command: Record<string, unknown> };
  const out = grants
    ? await access(page, id, {
        ...body.command,
        initial_policy: { grants, exclude_accounts: [] },
      })
    : await call(page, id, "POST", "/task-commands", body, crypto.randomUUID());
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return { taskId, occurrenceId: occ, progressId: prog };
}

const versionOf = async (page: Page, id: Id, made: Made) => {
  const out = await call(
    page,
    id,
    "GET",
    `/occurrences?task_id=${made.taskId}&scope=personal&limit=200`,
  );
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return (
    (out.body as { items: OccurrenceView[] }).items.find(
      (v) => v.id === made.occurrenceId,
    ) as OccurrenceView
  ).version;
};
/** `set_dependencies` built by the client's builder on the occurrence's current version; returns the receipt's revision. */
async function setDeps(
  page: Page,
  id: Id,
  root: Made,
  prerequisites: Made[],
  strict = false,
): Promise<number> {
  const out = await call(
    page,
    id,
    "POST",
    "/task-commands",
    commands
      .setDependencies({
        occurrenceId: root.occurrenceId,
        prerequisites: prerequisites.map((p) => p.occurrenceId),
        strict,
      })
      .build({ [root.occurrenceId]: await versionOf(page, id, root) }).command,
    crypto.randomUUID(),
  );
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return (out.body as { revision: number }).revision;
}
const previewOf = async (page: Page, id: Id, made: Made) => {
  const out = await call(
    page,
    id,
    "GET",
    `/occurrences/${made.occurrenceId}/dependencies`,
  );
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return out.body as DependencyPreview;
};
async function complete(page: Page, id: Id, made: Made): Promise<void> {
  const p = await previewOf(page, id, made);
  const out = await call(
    page,
    id,
    "POST",
    "/task-commands",
    {
      command: {
        kind: "complete_dependencies",
        occurrence_id: made.occurrenceId,
        preview_token: p.token,
        mode: "require_satisfied",
        happened_at: Math.floor(Date.now() / 1000),
      },
    },
    crypto.randomUUID(),
  );
  expect(out.status, JSON.stringify(out.body)).toBe(200);
}
/** The oracle: the same endpoint read by the helper. */
async function graphOf(
  page: Page,
  id: Id,
  made: Made,
  maxDepth?: number,
): Promise<DependencyGraph> {
  const out = await call(
    page,
    id,
    "GET",
    `/occurrences/${made.occurrenceId}/dependency-graph${maxDepth === undefined ? "" : `?max_depth=${maxDepth}`}`,
  );
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return out.body as DependencyGraph;
}
const edgeSet = (g: DependencyGraph) =>
  g.edges.map((e) => `${e.prerequisite_id}>${e.dependant_id}`).sort();

/** The page's OWN graph reads (helpers' excluded), with their query. */
function graphRequests(page: Page) {
  const out: Array<{ occurrence: string; maxDepth: string | null }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      !url.pathname.startsWith(API) ||
      request.headers()[HELPER] !== undefined
    )
      return;
    const m = /\/occurrences\/([^/]+)\/dependency-graph$/.exec(url.pathname);
    if (m && request.method() === "GET")
      out.push({
        occurrence: m[1] as string,
        maxDepth: url.searchParams.get("max_depth"),
      });
  });
  return out;
}

async function openDialog(page: Page, root: Made) {
  await go(page, `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`);
  const see = page
    .locator("[data-dependencies]")
    .getByRole("button", { name: "See what needs doing first" });
  await expect(see).toBeVisible({ timeout: 60_000 });
  await see.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible({
    timeout: 60_000,
  });
  return dialog;
}
async function openEditor(page: Page, root: Made) {
  await go(page, `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`);
  const set = page
    .locator("[data-dependencies]")
    .getByRole("button", { name: "Set what this waits for" });
  await expect(set).toBeVisible({ timeout: 60_000 });
  await set.click();
  const editor = page.locator("[data-dependency-editor]");
  await expect(editor).toHaveAttribute("data-dependency-editor", "open", {
    timeout: 60_000,
  });
  return { dialog: page.getByRole("dialog"), editor };
}
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
const mapEdges = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-map-edge]")]
      .map((p) => p.getAttribute("data-map-edge") as string)
      .sort(),
  );
/** The tree's states equal the oracle's, node by node. */
async function expectStates(page: Page, g: DependencyGraph) {
  for (const n of g.nodes)
    await expect(
      page.locator(`[data-tree-node="${n.occurrence_id}"]`),
    ).toHaveAttribute("data-state", n.dependency_state);
}
const appliedRevision = (page: Page, account: string) =>
  page.evaluate(
    (a) =>
      (
        (window.__atlasData?.rows(a, "sync_state") ?? []) as Array<{
          applied_revision?: number | null;
        }>
      )[0]?.applied_revision ?? 0,
    account,
  );
const offline = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
const online = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });

test.describe("I-18-G1: a chain (A18-1, A18-10)", () => {
  test("R ← A ← C (C done): the tree and the map are the server's edges and states; the summary names what directly blocks", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    await page.setViewportSize({ width: 1440, height: 900 });
    const r = await makeTask(page, id, "I-18-G1 root");
    const a = await makeTask(page, id, "I-18-G1 middle");
    const c = await makeTask(page, id, "I-18-G1 first");
    await setDeps(page, id, a, [c]);
    await setDeps(page, id, r, [a]);
    await complete(page, id, c);
    const oracle = await graphOf(page, id, r);
    expect(oracle.nodes.map((n) => n.dependency_state)).toEqual([
      "waiting",
      "ready",
      "satisfied",
    ]);
    const dialog = await openDialog(page, r);
    expect(await mapEdges(page)).toEqual(edgeSet(oracle));
    expect(await treeEdges(page)).toEqual(edgeSet(oracle));
    await expectStates(page, oracle);
    await expect(dialog.locator("[data-graph-summary]")).toHaveText(
      "Waits directly for 1: 0 done. Still open: “I-18-G1 middle”. 1 more further back.",
    );
  });
});

test.describe("I-18-G2: a branch with a shared prerequisite (A18-2, A18-3, A18-11)", () => {
  test("R ← A, R ← B, A ← S, B ← S: S placed once with one reference, four map edges", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    await page.setViewportSize({ width: 1440, height: 900 });
    const r = await makeTask(page, id, "I-18-G2 root");
    const a = await makeTask(page, id, "I-18-G2 A");
    const b = await makeTask(page, id, "I-18-G2 B");
    const s = await makeTask(page, id, "I-18-G2 shared");
    await setDeps(page, id, a, [s]);
    await setDeps(page, id, b, [s]);
    await setDeps(page, id, r, [a, b]);
    const oracle = await graphOf(page, id, r);
    expect(oracle.edges).toHaveLength(4);
    const dialog = await openDialog(page, r);
    await expect(dialog.locator("[data-map-edge]")).toHaveCount(4);
    expect(await mapEdges(page)).toEqual(edgeSet(oracle));
    expect(await treeEdges(page)).toEqual(edgeSet(oracle));
    await expect(
      dialog.locator(`[data-tree-node="${s.occurrenceId}"]`),
    ).toHaveCount(1);
    await expect(dialog.locator("[data-tree-ref]")).toHaveCount(1);
    await expect(dialog.locator("[data-tree-ref]")).toContainText(
      "Needs “I-18-G2 shared",
    );
    await expectStates(page, oracle);
  });
});

test.describe("I-18-G3: changed dependencies (A18-4, A18-6)", () => {
  test("a shown view read again after the server's list is emptied: 'Nothing needs doing first', the root alone, no map", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    await page.setViewportSize({ width: 1440, height: 900 });
    const r = await makeTask(page, id, "I-18-G3 root");
    const a = await makeTask(page, id, "I-18-G3 first");
    await setDeps(page, id, r, [a]);
    const dialog = await openDialog(page, r);
    await expect(dialog.locator("[data-tree-node]")).toHaveCount(2);
    await setDeps(page, id, r, []);
    expect((await graphOf(page, id, r)).edges).toEqual([]);
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(dialog.locator("[data-graph-summary=none]")).toHaveText(
      "Nothing needs doing first",
      {
        timeout: 30_000,
      },
    );
    await expect(dialog.locator("[data-tree-node]")).toHaveCount(1);
    await expect(dialog.locator("[data-graph-map]")).toHaveCount(0);
  });
});

test.describe("I-18-G4/G5: permission-restricted data (A18-5)", () => {
  test("G4 a root another account reads with a hidden prerequisite: the notice, and the hidden day's title and ids nowhere in the document; Set still withheld", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    try {
      const b = await bootAs(other, OTHER);
      const hidden = await makeTask(page, id, "I-18-G4 private");
      const seen = await makeTask(page, id, "I-18-G4 shared first", [
        { kind: "account", id: b.id.account_id, edit: true },
      ]);
      const r = await makeTask(page, id, "I-18-G4 shared root", [
        { kind: "account", id: b.id.account_id, edit: true },
      ]);
      await setDeps(page, id, r, [hidden, seen]);
      const oracle = await graphOf(b.page, b.id, r);
      expect(oracle.restricted).toBe(true);
      expect(oracle.nodes[0]?.restricted_prerequisites).toBe(true);
      await b.page.evaluate(() => window.__atlasData?.retryOutbox());
      const dialog = await openDialog(b.page, r);
      await expect(dialog.locator("[data-graph-restricted]")).toBeVisible();
      await expect(dialog.locator("[data-graph-summary]")).toContainText(
        "and something you can't see",
      );
      expect(await treeEdges(b.page)).toEqual(edgeSet(oracle));
      const html = await b.page.content();
      expect(html).not.toContain("I-18-G4 private");
      expect(html).not.toContain(hidden.taskId);
      expect(html).not.toContain(hidden.occurrenceId);
      await b.page.keyboard.press("Escape");
      await expect(
        b.page
          .locator("[data-dependencies]")
          .getByRole("button", { name: "Set what this waits for" }),
      ).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test("G5 a restricted middle node: it waits on something hidden, the root waits on it", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    try {
      const b = await bootAs(other, OTHER);
      const grant = [
        { kind: "account" as const, id: b.id.account_id, edit: true },
      ];
      const hidden = await makeTask(page, id, "I-18-G5 private");
      const m = await makeTask(page, id, "I-18-G5 middle", grant);
      const r = await makeTask(page, id, "I-18-G5 root", grant);
      await setDeps(page, id, m, [hidden]);
      await setDeps(page, id, r, [m]);
      const oracle = await graphOf(b.page, b.id, r);
      const middle = oracle.nodes.find(
        (n) => n.occurrence_id === m.occurrenceId,
      );
      expect(middle?.restricted_prerequisites).toBe(true);
      const dialog = await openDialog(b.page, r);
      await expectStates(b.page, oracle);
      await expect(
        dialog.locator(`[data-tree-node="${m.occurrenceId}"]`),
      ).toHaveAttribute("data-state", middle?.dependency_state as string);
      await expect(dialog.locator("[data-graph-restricted]")).toBeVisible();
      expect(await b.page.content()).not.toContain("I-18-G5 private");
    } finally {
      await other.close();
    }
  });
});

test.describe("I-18-G6: the editor from the authoritative list (A18-6)", () => {
  test("R ← A, B: the editor shows A and B; remove B, add C, save: the server (and the graph) hold exactly R ← A, R ← C", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const r = await makeTask(page, id, "I-18-G6 root");
    const a = await makeTask(page, id, "I-18-G6 A");
    const b = await makeTask(page, id, "I-18-G6 B");
    const c = await makeTask(page, id, "I-18-G6 C");
    await setDeps(page, id, r, [a, b]);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    const { dialog } = await openEditor(page, r);
    await expect(
      page.locator(`[data-editor-item="${a.occurrenceId}"]`),
    ).toContainText("I-18-G6 A");
    await expect(
      page.locator(`[data-editor-item="${b.occurrenceId}"]`),
    ).toContainText("I-18-G6 B");
    await page
      .locator(`[data-editor-item="${b.occurrenceId}"]`)
      .getByRole("button", { name: /^Remove/ })
      .click();
    await dialog.getByLabel("Task").selectOption(c.taskId);
    await dialog.getByLabel("Day").selectOption(c.occurrenceId);
    await dialog.getByRole("button", { name: "Add" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(async () => (await graphOf(page, id, r)).direct_prerequisites, {
        timeout: 60_000,
      })
      .toEqual([a.occurrenceId, c.occurrenceId].sort());
    const view = await openDialog(page, r);
    await expect(view.locator("[data-tree-node]")).toHaveCount(3);
    expect(await treeEdges(page)).toEqual(edgeSet(await graphOf(page, id, r)));
  });
});

test.describe("I-18-G7: stale writes are never a silent overwrite (A18-9)", () => {
  test("G7a sync paused: a list built on the version read is refused 409 when the server moved; Keep editing shows the server's list; the server keeps it", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const r = await makeTask(page, id, "I-18-G7a root");
    const a = await makeTask(page, id, "I-18-G7a A");
    const b = await makeTask(page, id, "I-18-G7a B");
    await setDeps(page, id, r, [a]);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    const { dialog } = await openEditor(page, r);
    await expect(
      page.locator(`[data-editor-item="${a.occurrenceId}"]`),
    ).toBeVisible();
    // The editor cannot hear the change: sync is stopped before the helper moves the server on.
    await page.evaluate(() => window.__atlasData?.stopSync());
    await setDeps(page, id, r, [b]);
    await page
      .locator(`[data-editor-item="${a.occurrenceId}"]`)
      .getByRole("button", { name: /^Remove/ })
      .click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    const block = page.locator("[data-set-conflict]");
    await expect(block).toContainText(
      "Couldn't set what this waits for as sent.",
      { timeout: 60_000 },
    );
    await block.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.locator("[data-editor-now]")).toContainText(
      "I-18-G7a B",
      { timeout: 60_000 },
    );
    // Nothing was overwritten.
    expect((await graphOf(page, id, r)).direct_prerequisites).toEqual([
      b.occurrenceId,
    ]);
  });

  test("G7b sync running: once the applied revision reaches the helper's change, a touched edit says 'changed' and withholds Save; Start again takes the server's list", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const r = await makeTask(page, id, "I-18-G7b root");
    const a = await makeTask(page, id, "I-18-G7b A");
    const b = await makeTask(page, id, "I-18-G7b B");
    await setDeps(page, id, r, [a]);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    const { dialog, editor } = await openEditor(page, r);
    await expect(
      page.locator(`[data-editor-item="${a.occurrenceId}"]`),
    ).toBeVisible();
    await dialog.getByLabel("Don't allow starting early").check();
    const revision = await setDeps(page, id, r, [b]);
    // The barrier: the account's applied revision has reached the helper's change.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.__atlasData?.restartSync());
          return appliedRevision(page, id.account_id);
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBeGreaterThanOrEqual(revision);
    await expect(editor).toHaveAttribute("data-dependency-editor", "changed", {
      timeout: 60_000,
    });
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await dialog
      .getByRole("button", { name: "Start again from the current list" })
      .click();
    await expect(editor).toHaveAttribute("data-dependency-editor", "open");
    await expect(
      page.locator(`[data-editor-item="${b.occurrenceId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-editor-item="${a.occurrenceId}"]`),
    ).toHaveCount(0);
  });
});

test.describe("I-18-G8: the editor's depth-one read (A18-7)", () => {
  test("R ← A ← B: the editor asks max_depth=1 and lists only A; the real depth-one body is partial; the dialog's read names no depth", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const r = await makeTask(page, id, "I-18-G8 root");
    const a = await makeTask(page, id, "I-18-G8 A");
    const b = await makeTask(page, id, "I-18-G8 B");
    await setDeps(page, id, a, [b]);
    await setDeps(page, id, r, [a]);
    const one = await graphOf(page, id, r, 1);
    expect(one.coverage).toBe("partial");
    expect(one.max_depth).toBe(1);
    const reads = graphRequests(page);
    const { dialog } = await openEditor(page, r);
    await expect(
      page.locator(`[data-editor-item="${a.occurrenceId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-editor-item="${b.occurrenceId}"]`),
    ).toHaveCount(0);
    // Every read the editor made is the depth-one read (sync may make it read again; never a full one).
    const editorReads = reads
      .filter((q) => q.occurrence === r.occurrenceId)
      .map((q) => q.maxDepth);
    expect(editorReads.length).toBeGreaterThanOrEqual(1);
    expect(new Set(editorReads)).toEqual(new Set(["1"]));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    const before = reads.length;
    const view = await openDialog(page, r);
    const dialogReads = reads
      .slice(before)
      .filter((q) => q.occurrence === r.occurrenceId)
      .map((q) => q.maxDepth);
    expect(dialogReads.length).toBeGreaterThanOrEqual(1);
    expect(new Set(dialogReads)).toEqual(new Set([null]));
    await expect(view.locator("[data-graph-partial]")).toHaveCount(0);
    await expect(view.locator("[data-tree-node]")).toHaveCount(3);
  });
});

test.describe("I-18-G9: offline after a shown view (A18-8)", () => {
  test("hidden with the offline words, never a stale snapshot; back online it is read again and shown", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const r = await makeTask(page, id, "I-18-G9 root");
    const a = await makeTask(page, id, "I-18-G9 first");
    await setDeps(page, id, r, [a]);
    const dialog = await openDialog(page, r);
    const reads = graphRequests(page);
    await offline(page);
    await expect(dialog).toContainText("Can be checked when you're online.");
    await expect(dialog.locator("[data-dependency-tree]")).toHaveCount(0);
    await online(page);
    await expect(dialog.locator("[data-dependency-graph=ready]")).toBeVisible({
      timeout: 60_000,
    });
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });
});

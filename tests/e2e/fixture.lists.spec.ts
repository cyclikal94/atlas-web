import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { contrastRatio } from "../../src/design/contrast";
import { recordEvidence } from "./data-evidence";
import { serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  pageText,
  type SyncStub,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  waitForState,
} from "./data-sync-helpers";
import { runAxe } from "./helpers";
import { recordPaintedContrast, surfaceScreenshot } from "./surface-checks";
import {
  type BuiltTask,
  bodiesOf,
  buildTask,
  cacheTasksAndLists,
  draftsOf,
  goOfflineAtBoundary,
  goOnlineAtBoundary,
  listIdOf,
  listUpsert,
  serveTaskReads,
  type TaskReads,
} from "./tasks-helpers";

/**
 * WEB-10b in Chromium, Firefox and WebKit: the PRODUCTION session and protected tree (`/__session`), the production data controller and REAL
 * IndexedDB; the cache is filled by one `/sync` delta page (tasks and lists) through the fixture leader, and drafts are sent by the fixture
 * outbox to the stubbed `/task-commands`. FIXTURE evidence: an answer the stub gives is the stub's (the I-LS cases run against the released
 * backend). Viewport and colour-scheme emulation is browser emulation, not device evidence.
 *
 * E-LS1 pane and detail from the cache (counts, a withheld row, the caption, an archived task; axe, five viewports x two themes, painted
 * contrast, 44 px targets, no overflow); E-LS2 offline create (defaults fetched, and never fetched: review in Sync), then sent; E-LS3 the
 * picker (a task not sent yet included) and the chained adds sent in order after the create; E-LS4 remove, rename (queued create and
 * synced list), read-only controls; E-LS5 capacity (Add disabled at 100, the picker capped, a 503 slice_capacity refused); E-LS6 archive
 * and restore offline; E-LS7 input kept through the in-dialog sync control, Escape, reload, and a save answered while away; E-LS8 two tabs
 * (a denial committed after the screen was drawn, the queued create edited in the other tab, both adding); E-LS9 keyboard only; E-LS10
 * the detail's heading; E-LS11 an answer lost after the write (a labelled test-only fault): the earlier request's look-up settled on the
 * dialog Back mounted again, and an add re-chosen after another tab's remove (review 2 R1, R2), each with its control; E-LS12 (revision 3,
 * D1) the stored draft of a lost answer discarded by ANOTHER TAB's production discard: Save writes nothing, only the separate decision
 * makes the change anew (create and picker), each with its retained-draft control; E-LS13 (revision 4, D1 / DA-N1) an add waits for its
 * task's CURRENT create, read when the add is made: the create discarded by another tab before Add, and between the add's read of the
 * task and its write (placed by real transaction order), with the retained-create control.
 */
const LISTS_ROUTE = "/tasks/lists";
const detailRoute = (id: string) => `/tasks/lists/${id}`;

async function bootAt(
  context: BrowserContext,
  route: string,
  look: {
    viewport?: { width: number; height: number };
    colorScheme?: "light" | "dark";
  } = {},
): Promise<Page> {
  const page = await context.newPage();
  if (look.viewport) await page.setViewportSize(look.viewport);
  if (look.colorScheme)
    await page.emulateMedia({ colorScheme: look.colorScheme });
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function setup(
  context: BrowserContext,
  route: string,
  tasks: BuiltTask[],
  lists: Array<{ upsert: unknown }>,
  arrange: (reads: TaskReads) => void = () => undefined,
  look: Parameters<typeof bootAt>[2] = {},
): Promise<{ page: Page; net: SyncStub; reads: TaskReads }> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  const reads = await serveTaskReads(context);
  arrange(reads);
  await seedSettled(context);
  const page = await bootAt(context, route, look);
  await cacheTasksAndLists(page, net, tasks, lists);
  await untilTreeSettled(page);
  return { page, net, reads };
}

/** The send of the queued drafts by the fixture outbox. */
async function send(page: Page): Promise<void> {
  await startOutbox(page);
  await page.evaluate(() => window.__atlasData?.retryOutbox());
}

/** One more `/sync` page through the fixture leader (the server's view of what was sent). */
async function syncPage(page: Page, net: SyncStub, upserts: unknown[]) {
  net.script.push(() => ({
    status: 200,
    body: pageText([upserts], `cursor-${Date.now()}`),
  }));
  await page.evaluate(() => window.__atlasData?.retrySync());
  await waitForState(page, "idle");
}

const sentKinds = (net: SyncStub) =>
  net.commands.map(
    (c) => (JSON.parse(c.body) as { command: Record<string, unknown> }).command,
  );
const queued = async (page: Page, kind?: string) => {
  const drafts = await draftsOf(page);
  const bodies = await bodiesOf(page);
  return drafts
    .map((d) => ({
      draft: d,
      body: bodies.find((b) => b.local_id === d.local_id)?.command as {
        command: Record<string, unknown>;
      },
    }))
    .filter((x) => kind === undefined || x.body?.command.kind === kind);
};
const detail = (page: Page) => page.locator("[data-list-detail]");
const dialog = (page: Page) => page.getByRole("dialog");

test.describe("E-LS1: the pane and the detail from the cache (L5, L8, L11, L17)", () => {
  test("counts, a withheld row with no link and Remove kept, an archived task, the caption; only cached tasks", async ({
    context,
  }, info) => {
    const a = buildTask({ n: 1, title: "Buy bin bags" });
    const b = buildTask({ n: 2, title: "Apples", archived: true });
    const hidden = "7f000000-0000-4000-8000-000000000999";
    const groceries = listUpsert(1, "Weekly groceries", [
      a.taskId,
      b.taskId,
      hidden,
    ]);
    const home = listUpsert(2, "Home projects", [a.taskId]);
    const { page } = await setup(
      context,
      LISTS_ROUTE,
      [a, b],
      [groceries, home],
    );
    await expect(
      page.locator(`[data-list-link="${groceries.id}"]`),
    ).toContainText("3");
    await expect(page.locator(`[data-list-link="${home.id}"]`)).toContainText(
      "1",
    );
    await page.locator(`[data-list-link="${groceries.id}"]`).click();
    await expect(detail(page)).toHaveAttribute(
      "data-list-detail",
      groceries.id,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Weekly groceries",
    );
    const rows = page.locator("[data-list-row]");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Apples");
    await expect(rows.nth(0)).toContainText("Archived");
    await expect(rows.nth(1)).toContainText("Buy bin bags");
    const withheld = rows.nth(2);
    await expect(withheld).toHaveAttribute("data-list-row", "withheld");
    await expect(withheld).toContainText("Task you can't open");
    await expect(withheld.getByRole("link")).toHaveCount(0);
    await expect(withheld).not.toContainText(hidden);
    await expect(
      withheld.getByRole("button", { name: "Remove this task" }),
    ).toBeVisible();
    await expect(page.locator("[data-list-caption]")).toHaveText(
      "Lists don't change who can see a task. People who can see this list see only the tasks they can already open.",
    );
    // The hidden task is nowhere in this device's cache (the server never sends it): the picker cannot offer it either.
    const cached = (await page.evaluate(
      (acct) => window.__atlasData?.rows(acct, "cache"),
      ACCOUNT,
    )) as Array<{ id: string }>;
    expect(cached.some((r) => r.id === hidden)).toBe(false);
    await page.getByRole("button", { name: "Add task to list" }).click();
    await expect(dialog(page).locator("[data-picker-task]")).toHaveCount(0);
    await expect(dialog(page)).toContainText("No tasks to add.");
    recordEvidence(info, "e-ls1", { list: groceries.id });
  });

  for (const [width, height] of [
    [390, 844],
    [834, 1112],
    [1112, 834],
    [1180, 820],
    [1440, 900],
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      test(`axe, targets, overflow and painted contrast at ${width}×${height}, ${scheme} (browser emulation, not a device)`, async ({
        context,
      }, info) => {
        const a = buildTask({ n: 3, title: "Feed the cat" });
        const list = listUpsert(3, "Weekly groceries", [
          a.taskId,
          "7f000000-0000-4000-8000-000000000998",
        ]);
        const { page } = await setup(
          context,
          detailRoute(list.id),
          [a],
          [list],
          () => undefined,
          { viewport: { width, height }, colorScheme: scheme },
        );
        await expect(page.locator("[data-list-row]")).toHaveCount(2);
        const violations = await runAxe(page);
        expect(violations, JSON.stringify(violations, null, 1)).toEqual([]);
        // No horizontal overflow of the page.
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // Every control of the detail is at least 44 px tall (WCAG 2.5.5 as drawn).
        const small = await detail(page)
          .locator("a, button")
          .evaluateAll((els) =>
            els
              .map((e) => ({
                text: e.textContent,
                h: e.getBoundingClientRect().height,
              }))
              .filter((e) => e.h > 0 && e.h < 44),
          );
        expect(small).toEqual([]);
        const painted = async (locator: Locator) =>
          locator.evaluate((element) => {
            let node: Element | null = element;
            let fill = "rgba(0, 0, 0, 0)";
            while (node) {
              const background = getComputedStyle(node).backgroundColor;
              if (
                background !== "rgba(0, 0, 0, 0)" &&
                background !== "transparent"
              ) {
                fill = background;
                break;
              }
              node = node.parentElement;
            }
            return { color: getComputedStyle(element).color, fill };
          });
        const hex = (rgb: string) =>
          `#${(rgb.match(/\d+/g) ?? [])
            .slice(0, 3)
            .map((n) => Number(n).toString(16).padStart(2, "0"))
            .join("")}`;
        const observations: Record<string, unknown> = {};
        const withheld = await painted(
          page.locator("[data-list-withheld]").first(),
        );
        observations.withheld = {
          ...withheld,
          ratio: contrastRatio(hex(withheld.color), hex(withheld.fill)),
        };
        expect(observations.withheld).toMatchObject({
          ratio: expect.any(Number),
        });
        expect(
          (observations.withheld as { ratio: number }).ratio,
        ).toBeGreaterThanOrEqual(4.5);
        if (width >= 1280) {
          // The selected list's count: ink-2 on select-tint (the wireframe's R10 correction: at least 4.5:1).
          const badge = await painted(
            page.locator(`[data-list-link="${list.id}"] [data-list-count]`),
          );
          observations.badge = {
            ...badge,
            ratio: contrastRatio(hex(badge.color), hex(badge.fill)),
          };
          expect(
            (observations.badge as { ratio: number }).ratio,
          ).toBeGreaterThanOrEqual(4.5);
        }
        recordPaintedContrast(info, scheme, {
          engine: info.project.name,
          width,
          ...observations,
        });
        if (info.project.name === "fixture-chromium")
          await surfaceScreenshot(page, info, {
            name: "lists-detail",
            width,
            scheme,
          });
      });
});

test.describe("E-LS2: create offline, then sent (L2, L6, L14)", () => {
  test("defaults fetched: the create captures their revision; Not sent yet; sent with the local id as its key; shown synced", async ({
    context,
  }, info) => {
    const { page, net, reads } = await setup(context, LISTS_ROUTE, [], []);
    await page.getByRole("button", { name: "+ New list" }).click();
    // Mounting the dialog reads the defaults (online) into this device's record; only then is the act made offline.
    await expect
      .poll(() =>
        page.evaluate(
          (acct) =>
            window.__atlasData?.defaultsRecord(acct).then((r) => r !== null),
          ACCOUNT,
        ),
      )
      .toBe(true);
    expect(reads.snapshot.status).toBe(200);
    await goOfflineAtBoundary(page);
    await dialog(page).getByLabel("Name").fill("Weekend groceries");
    await dialog(page).getByRole("button", { name: "Create list" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(detail(page)).toHaveAttribute("data-list-projected", "");
    await expect(page.locator("[data-pending-mark]").first()).toHaveText(
      "Not sent yet",
    );
    const [create] = await queued(page, "create_list");
    const id = create?.body.command.id as string;
    expect(create?.body.command).toEqual({
      kind: "create_list",
      id,
      name: "Weekend groceries",
    });
    expect(create?.body).toHaveProperty(
      "defaults_revision",
      `${"0".repeat(63)}1`,
    );
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    expect(net.commands[0]?.key).toBe(create?.draft.local_id);
    expect(JSON.parse(net.commands[0]?.body ?? "{}")).toEqual(create?.body);
    const created = listUpsert(0, "Weekend groceries", [], { id, version: 1 });
    await syncPage(page, net, [created.upsert]);
    await expect(detail(page)).not.toHaveAttribute("data-list-projected", "");
    await expect(page.getByRole("button", { name: "Sharing" })).toBeEnabled();
    recordEvidence(info, "e-ls2", { sent: net.commands });
  });

  test("defaults never fetched: held for review in Sync, nothing sent", async ({
    context,
  }) => {
    const { page, net } = await setup(context, LISTS_ROUTE, [], [], (r) => {
      r.snapshot = {
        status: 503,
        body: {
          code: "temporarily_unavailable",
          message: "m",
          request_id: "11111111-1111-4111-8111-111111111111",
          details: [],
        },
      };
    });
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "+ New list" }).click();
    await dialog(page).getByLabel("Name").fill("Unsure audience");
    await dialog(page).getByRole("button", { name: "Create list" }).click();
    await expect(dialog(page)).toHaveCount(0);
    const [create] = await queued(page, "create_list");
    expect(create?.draft).toMatchObject({ kind: "create_list" });
    const rows = (await page.evaluate(
      (acct) => window.__atlasData?.rows(acct, "drafts"),
      ACCOUNT,
    )) as Array<{ review_block: unknown }>;
    expect(rows[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["list"],
    });
    await goOnlineAtBoundary(page);
    await send(page);
    await navigateInApp(page, "/sync?tab=conflicts");
    await expect(
      page.getByText("New list", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Review sharing/ }).first(),
    ).toBeVisible();
    expect(net.commands).toHaveLength(0);
  });
});

test.describe("E-LS3: the picker and the chained adds (L2, L9, L14)", () => {
  test("search, three selected (one not sent yet), Add selected: chained list_item drafts sent in order after the creates", async ({
    context,
  }, info) => {
    const a = buildTask({ n: 4, title: "Éclair shop" });
    const b = buildTask({ n: 5, title: "Post office" });
    const list = listUpsert(4, "Errands", []);
    const { page, net } = await setup(context, "/tasks/new", [a, b], [list]);
    // A task created offline and not sent yet.
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click();
    await expect(
      page.getByRole("radio", { name: "Use my defaults (only you)" }),
    ).toBeVisible();
    await goOfflineAtBoundary(page);
    await page.getByLabel("Name", { exact: true }).fill("Brand new task");
    await page.getByRole("radio", { name: "Only me" }).check();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-task-detail]")).toBeVisible();
    const [taskCreate] = await queued(page, "create_task");
    const newTask = taskCreate?.body.command.id as string;
    await navigateInApp(page, detailRoute(list.id));
    await page.getByRole("button", { name: "Add task to list" }).click();
    await expect(dialog(page).locator("[data-picker-task]")).toHaveCount(3);
    await expect(
      dialog(page).locator(`[data-picker-task="${newTask}"]`),
    ).toContainText("Not sent yet");
    await dialog(page).getByLabel("Search your tasks").fill("eclair");
    await expect(dialog(page).locator("[data-picker-task]")).toHaveCount(1);
    await dialog(page)
      .locator(`[data-picker-task="${a.taskId}"] input`)
      .check();
    await dialog(page).getByLabel("Search your tasks").fill("");
    await expect(dialog(page).locator("[data-picker-task]")).toHaveCount(3);
    await dialog(page).locator(`[data-picker-task="${newTask}"] input`).check();
    await dialog(page)
      .locator(`[data-picker-task="${b.taskId}"] input`)
      .check();
    await expect(dialog(page)).toContainText("3 selected");
    await dialog(page).getByRole("button", { name: "Add selected" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("[data-list-row]")).toHaveCount(3);
    const items = await queued(page, "list_item");
    expect(
      items.map((x) => [
        x.body.command.task_id,
        x.body.command.expected_version,
      ]),
    ).toEqual([
      [a.taskId, 2],
      [newTask, 3],
      [b.taskId, 4],
    ]);
    const rows = (await page.evaluate(
      (acct) => window.__atlasData?.rows(acct, "drafts"),
      ACCOUNT,
    )) as Array<{ local_id: string; depends_on: string[] }>;
    const dependsOf = (localId: string) =>
      rows.find((r) => r.local_id === localId)?.depends_on ?? [];
    expect(dependsOf(items[1]?.draft.local_id as string)).toContain(
      taskCreate?.draft.local_id,
    );
    expect(dependsOf(items[0]?.draft.local_id as string)).not.toContain(
      taskCreate?.draft.local_id,
    );
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(4);
    const sent = sentKinds(net);
    expect(sent.map((c) => c.kind)).toEqual([
      "create_task",
      "list_item",
      "list_item",
      "list_item",
    ]);
    expect(
      sent.filter((c) => c.kind === "list_item").map((c) => c.task_id),
    ).toEqual([a.taskId, newTask, b.taskId]);
    recordEvidence(info, "e-ls3", { sent: net.commands });
  });
});

test.describe("E-LS4: remove, rename, read-only (L2, L7, L8)", () => {
  test("remove a readable and a withheld row; rename a synced list with its policy version", async ({
    context,
  }) => {
    const a = buildTask({ n: 6, title: "Sweep" });
    const hidden = "7f000000-0000-4000-8000-000000000997";
    const list = listUpsert(6, "Chores", [a.taskId, hidden], {
      policy_version: 3,
      version: 5,
    });
    const { page } = await setup(context, detailRoute(list.id), [a], [list]);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "Remove Sweep" }).click();
    await expect(page.locator("[data-list-row]")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove this task" }).click();
    await expect(page.locator("[data-list-row]")).toHaveCount(0);
    await page.getByRole("button", { name: "Rename" }).click();
    await dialog(page).getByLabel("Name").fill("House chores");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "House chores",
    );
    const all = await queued(page);
    expect(all.map((x) => x.body.command)).toEqual([
      {
        kind: "list_item",
        list_id: list.id,
        expected_version: 5,
        task_id: a.taskId,
        included: false,
      },
      {
        kind: "list_item",
        list_id: list.id,
        expected_version: 6,
        task_id: hidden,
        included: false,
      },
      {
        kind: "edit_list",
        id: list.id,
        expected_version: 7,
        expected_policy_version: 3,
        name: "House chores",
      },
    ]);
  });

  test("rename a list whose create is queued: one create body with the new name, no edit_list", async ({
    context,
  }) => {
    const { page } = await setup(context, LISTS_ROUTE, [], []);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "+ New list" }).click();
    await dialog(page).getByLabel("Name").fill("Draft name");
    await dialog(page).getByRole("button", { name: "Create list" }).click();
    await expect(detail(page)).toBeVisible();
    await page.getByRole("button", { name: "Rename" }).click();
    await dialog(page).getByLabel("Name").fill("Final name");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await expect(dialog(page)).toHaveCount(0);
    const all = await queued(page);
    expect(all.map((x) => x.body.command.kind)).toEqual(["create_list"]);
    expect(all[0]?.body.command.name).toBe("Final name");
  });

  test("a read-only list: Rename, Add and Archive disabled with the reason; no Remove", async ({
    context,
  }) => {
    const a = buildTask({ n: 7, title: "Their task" });
    const list = listUpsert(7, "Theirs", [a.taskId], { can_edit: false });
    const { page } = await setup(context, detailRoute(list.id), [a], [list]);
    for (const name of ["Rename", "Add task to list", "Archive"])
      await expect(page.getByRole("button", { name })).toBeDisabled();
    await expect(
      page.getByText("You can't change this list").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove Their task" }),
    ).toHaveCount(0);
  });
});

test.describe("E-LS5: capacity (L10)", () => {
  test("100 composed disables Add with the drawn copy; the picker is capped at the room left", async ({
    context,
  }) => {
    const members = Array.from(
      { length: 98 },
      (_, i) => `7e000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    );
    const a = buildTask({ n: 8, title: "First candidate" });
    const b = buildTask({ n: 9, title: "Second candidate" });
    const c = buildTask({ n: 10, title: "Third candidate" });
    const list = listUpsert(8, "Nearly full", members);
    const { page } = await setup(
      context,
      detailRoute(list.id),
      [a, b, c],
      [list],
    );
    await page.getByRole("button", { name: "Add task to list" }).click();
    await expect(dialog(page)).toContainText("This list can take 2 more.");
    await dialog(page)
      .locator(`[data-picker-task="${a.taskId}"] input`)
      .check();
    await dialog(page)
      .locator(`[data-picker-task="${b.taskId}"] input`)
      .check();
    await expect(
      dialog(page).locator(`[data-picker-task="${c.taskId}"] input`),
    ).toBeDisabled();
    await dialog(page).getByRole("button", { name: "Add selected" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add task to list" }),
    ).toBeDisabled();
    await expect(
      page.getByText("This list already has 100 tasks, its maximum"),
    ).toBeVisible();
  });

  test("a 503 slice_capacity is refused: not applied, the notice, Retry and Discard in Sync", async ({
    context,
  }) => {
    const a = buildTask({ n: 11, title: "One too many" });
    const list = listUpsert(9, "Full on the server", []);
    const { page, net } = await setup(
      context,
      detailRoute(list.id),
      [a],
      [list],
    );
    net.commandScript.push(() => ({
      status: 503,
      body: JSON.stringify({
        code: "slice_capacity",
        message: "m",
        request_id: "11111111-1111-4111-8111-111111111111",
        details: [],
      }),
    }));
    await page.getByRole("button", { name: "Add task to list" }).click();
    await dialog(page)
      .locator(`[data-picker-task="${a.taskId}"] input`)
      .check();
    await dialog(page).getByRole("button", { name: "Add selected" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    await expect(page.locator("[data-list-refused]")).toContainText(
      "Couldn't add “One too many”: this list is full.",
    );
    await expect(page.locator("[data-list-row]")).toHaveCount(0);
    await page
      .locator("[data-list-refused]")
      .getByRole("link", { name: "Open Sync" })
      .click();
    await expect(
      page.getByRole("button", { name: /Retry/ }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Discard/ }).first(),
    ).toBeVisible();
  });
});

test.describe("E-LS6: archive and restore offline (L12)", () => {
  test("Archive offline; the pane's Archived filter lists it; Restore", async ({
    context,
  }) => {
    const list = listUpsert(10, "Seasonal", []);
    const { page } = await setup(context, detailRoute(list.id), [], [list]);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("This list is archived.")).toBeVisible();
    await navigateInApp(page, LISTS_ROUTE);
    await expect(page.locator(`[data-list-link="${list.id}"]`)).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Archived" }).check();
    await expect(page.locator(`[data-list-link="${list.id}"]`)).toBeVisible();
    await page.locator(`[data-list-link="${list.id}"]`).click();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
    const all = await queued(page, "archive");
    expect(all.map((x) => x.body.command)).toEqual([
      { kind: "archive", id: list.id, expected_version: 2, archived: true },
      { kind: "archive", id: list.id, expected_version: 3, archived: false },
    ]);
  });
});

/** The in-dialog sync control: the dialog keeps its input, closes and opens Sync. */
async function toSyncFromDialog(page: Page) {
  await dialog(page).locator("[data-sync-tone]").click();
  await expect(page).toHaveURL(/\/sync/);
}

test.describe("E-LS7: input kept through the sync control (L16)", () => {
  test("rename, picker and create input come back raw after the sync control and Back; Escape discards; a reload forgets", async ({
    context,
  }) => {
    const a = buildTask({ n: 12, title: "Pick me" });
    const list = listUpsert(11, "Kept", []);
    const { page } = await setup(context, detailRoute(list.id), [a], [list]);
    await page.getByRole("button", { name: "Rename" }).click();
    await dialog(page).getByLabel("Name").fill("  half typed ");
    await toSyncFromDialog(page);
    await page.goBack();
    await expect(dialog(page).getByLabel("Name")).toHaveValue("  half typed ");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Add task to list" }).click();
    await dialog(page)
      .locator(`[data-picker-task="${a.taskId}"] input`)
      .check();
    await toSyncFromDialog(page);
    await page.goBack();
    await expect(
      dialog(page).locator(`[data-picker-task="${a.taskId}"] input`),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(dialog(page).getByLabel("Name")).toHaveValue("Kept");
    await page.keyboard.press("Escape");
    await navigateInApp(page, LISTS_ROUTE);
    await page.getByRole("button", { name: "+ New list" }).click();
    await dialog(page).getByLabel("Name").fill("Unsaved");
    // A reload keeps nothing (page memory only; Q4 is WEB-14a's).
    await page.goto(`/__session?route=${encodeURIComponent(LISTS_ROUTE)}`);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    await untilTreeSettled(page);
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "+ New list" }).click();
    await expect(dialog(page).getByLabel("Name")).toHaveValue("");
  });
});

/**
 * Holds every write to the account's `drafts` store: a second connection keeps a read-write transaction over it alive by chaining reads,
 * so the app's enqueue (which writes `drafts`) waits until `release`. A real engine's own transaction scheduling, no product change.
 */
async function holdDraftWrites(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(async (account) => {
    const w = window as unknown as {
      __release?: boolean;
      __held?: Promise<void>;
    };
    w.__release = false;
    const name = (await indexedDB.databases()).find((d) =>
      d.name?.endsWith(account),
    )?.name;
    if (name === undefined) throw new Error("no account database");
    await new Promise<void>((started) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(["drafts"], "readwrite");
        const store = tx.objectStore("drafts");
        w.__held = new Promise<void>((done) => {
          tx.oncomplete = () => {
            db.close();
            done();
          };
        });
        const spin = () => {
          if (w.__release) return;
          store.get("__hold__").onsuccess = spin;
        };
        spin();
        started();
      };
    });
  }, ACCOUNT);
  return async () => {
    await page.evaluate(async () => {
      const w = window as unknown as {
        __release?: boolean;
        __held?: Promise<void>;
      };
      w.__release = true;
      await w.__held;
    });
  };
}

/**
 * Native transaction ORDER (R5). IndexedDB starts a transaction only once every overlapping transaction created before it has finished,
 * and every Atlas plan's scope includes `sync_state`, so whatever is CREATED first runs first. The spec places a real commit of the
 * fixture leader between two stages of one read, or behind a screen's admission, with transactions of its own on a connection of its own
 * (a store held by a read-write transaction that keeps itself alive) and by OBSERVING when the app creates its transactions (a wrapper of
 * `IDBDatabase.prototype.transaction` that records each creation and changes nothing of it). No plan, read or commit of the app is
 * altered; the app's own connection, Dexie and the real engine do the work.
 */
interface Created {
  n: number;
  mode: string;
  stores: string[];
}
/** Before any page of `context` opens its database (Dexie binds the method when it opens): the observer of transaction creation. */
async function observeTransactions(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type Hooks = {
      name: string | null;
      own: IDBDatabase | null;
      log: Array<{ n: number; mode: string; stores: string[] }>;
      created:
        | ((entry: { n: number; mode: string; stores: string[] }) => void)
        | null;
    };
    const hooks: Hooks = { name: null, own: null, log: [], created: null };
    (window as unknown as { __orderHooks: Hooks }).__orderHooks = hooks;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = original.apply(this, args);
      if (hooks.name === null || this === hooks.own || this.name !== hooks.name)
        return tx;
      const scope = args[0];
      const entry = {
        n: hooks.log.length,
        mode: args[1] ?? "readonly",
        stores: (typeof scope === "string" ? [scope] : [...scope]).sort(),
      };
      hooks.log.push(entry);
      hooks.created?.(entry);
      return tx;
    } as IDBDatabase["transaction"];
  });
}

/** Starts recording the account database's transactions from now, with the spec's own connection for holds and reads. */
async function installOrdering(page: Page): Promise<void> {
  await page.evaluate(async (account) => {
    type Entry = { n: number; mode: string; stores: string[] };
    const hooks = (
      window as unknown as {
        __orderHooks?: {
          name: string | null;
          own: IDBDatabase | null;
          log: Entry[];
          created: ((entry: Entry) => void) | null;
        };
      }
    ).__orderHooks;
    if (hooks === undefined) throw new Error("observeTransactions first");
    const name = (await indexedDB.databases()).find((d) =>
      d.name?.endsWith(account),
    )?.name;
    if (name === undefined) throw new Error("no account database");
    const own = await new Promise<IDBDatabase>((ok, fail) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => ok(open.result);
      open.onerror = () => fail(open.error);
    });
    const holds = new Map<
      number,
      { release: boolean; started: boolean; done: Promise<string> }
    >();
    const rules: Array<{
      mode: string;
      has: string[];
      hold: string[];
      fired: number | null;
      holdId: number | null;
    }> = [];
    let ids = 0;
    const hold = (stores: string[]): number => {
      const id = ++ids;
      const tx = own.transaction(stores, "readwrite");
      const store = tx.objectStore(stores[0] as string);
      const h = {
        release: false,
        started: false,
        done: new Promise<string>((done) => {
          tx.oncomplete = () => done("complete");
          tx.onabort = () => done("abort");
        }),
      };
      const ask = () => {
        store.get("__ordering_hold__").onsuccess = () => {
          h.started = true;
          if (!h.release) ask();
        };
      };
      ask();
      holds.set(id, h);
      return id;
    };
    hooks.own = own;
    hooks.name = name;
    hooks.created = (entry) => {
      for (const rule of rules)
        if (
          rule.fired === null &&
          entry.mode === rule.mode &&
          rule.has.every((s) => entry.stores.includes(s))
        ) {
          // Created in the same turn, immediately AFTER the app's transaction: it runs once that one has finished.
          rule.fired = entry.n;
          rule.holdId = hold(rule.hold);
        }
    };
    (window as unknown as { __order: unknown }).__order = {
      log: hooks.log,
      rules,
      hold,
      started: (id: number) => holds.get(id)?.started === true,
      release: async (id: number) => {
        const h = holds.get(id);
        if (h === undefined) throw new Error(`no hold ${id}`);
        h.release = true;
        return h.done;
      },
      arm: (rule: { mode: string; has: string[]; hold: string[] }) => {
        rules.push({ ...rule, fired: null, holdId: null });
        return rules.length - 1;
      },
      row: (store: string, key: string) =>
        new Promise((ok, fail) => {
          const request = own
            .transaction([store], "readonly")
            .objectStore(store)
            .get(key);
          request.onsuccess = () => ok(request.result ?? null);
          request.onerror = () => fail(request.error);
        }),
    };
  }, ACCOUNT);
}
type Order = {
  log: Created[];
  rules: Array<{ fired: number | null; holdId: number | null }>;
  hold(stores: string[]): number;
  started(id: number): boolean;
  release(id: number): Promise<string>;
  arm(rule: { mode: string; has: string[]; hold: string[] }): number;
  row(store: string, key: string): Promise<Record<string, unknown> | null>;
};
const logOf = (page: Page): Promise<Created[]> =>
  page.evaluate(() => (window as unknown as { __order: Order }).__order.log);
/** A read-write transaction of the spec's own over `stores`, kept alive until released. */
const holdStores = (page: Page, stores: string[]): Promise<number> =>
  page.evaluate(
    (s) => (window as unknown as { __order: Order }).__order.hold(s),
    stores,
  );
const holdStarted = (page: Page, id: number): Promise<boolean> =>
  page.evaluate(
    (h) => (window as unknown as { __order: Order }).__order.started(h),
    id,
  );
const releaseHold = (page: Page, id: number): Promise<string> =>
  page.evaluate(
    (h) => (window as unknown as { __order: Order }).__order.release(h),
    id,
  );
/** Arms a hold over `hold` created immediately behind the app's next transaction of that shape; returns the rule. */
const holdBehind = (
  page: Page,
  rule: { mode: string; has: string[]; hold: string[] },
): Promise<number> =>
  page.evaluate(
    (r) => (window as unknown as { __order: Order }).__order.arm(r),
    rule,
  );
const firedHold = (page: Page, rule: number): Promise<number | null> =>
  page.evaluate(
    (r) =>
      (window as unknown as { __order: Order }).__order.rules[r]?.holdId ??
      null,
    rule,
  );
const storedRow = (
  page: Page,
  store: string,
  key: string,
): Promise<Record<string, unknown> | null> =>
  page.evaluate(
    ([s, k]) =>
      (window as unknown as { __order: Order }).__order.row(
        s as string,
        k as string,
      ),
    [store, key] as const,
  );
/** A commit of the fixture leader: read-write over the cache, its effects and the queue (`data.commitPage`). */
const isCommit = (t: Created) =>
  t.mode === "readwrite" &&
  ["cache", "pending_effects", "drafts"].every((s) => t.stores.includes(s));
/** A save of the outbox (`data.enqueueDraft`): read-write over the queue and the cache, not the effects. */
const isEnqueue = (t: Created) =>
  t.mode === "readwrite" &&
  ["drafts", "resource_versions", "cache"].every((s) => t.stores.includes(s)) &&
  !t.stores.includes("pending_effects");
/** A stage that reads cached rows (`data.readResourcesById`) or this device's work (`data.readOutstanding`). */
const readsRows = (t: Created) =>
  t.mode === "readonly" &&
  t.stores.includes("cache") &&
  t.stores.includes("pending_effects");
const readsWork = (t: Created) =>
  t.mode === "readonly" && t.stores.includes("drafts");
/** The next page of `/sync` through this page's leader, WITHOUT waiting for it (the spec orders it). */
function scriptPage(net: SyncStub, upserts: unknown[]) {
  net.script.push(() => ({
    status: 200,
    body: pageText([upserts], `cursor-${Date.now()}`),
  }));
}

test.describe("E-LS7b: a save answered while the person is at Sync (L6, L16)", () => {
  test("the create completes while away: it is saved, and the app does not navigate the person away from Sync", async ({
    context,
  }) => {
    const { page } = await setup(context, LISTS_ROUTE, [], []);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "+ New list" }).click();
    await dialog(page).getByLabel("Name").fill("Answered while away");
    const release = await holdDraftWrites(page);
    await dialog(page).getByRole("button", { name: "Create list" }).click();
    // The save is pending (the dialog's field is disabled); the person checks Sync from the dialog.
    await expect(dialog(page).getByLabel("Name")).toBeDisabled();
    await toSyncFromDialog(page);
    await release();
    await expect
      .poll(async () => (await queued(page, "create_list")).length)
      .toBe(1);
    // Give a wrongly acting editor every chance to navigate.
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/sync/);
    await expect(page.locator("main h1")).toHaveText("Sync");
  });
});

test.describe("E-LS8: another tab (L7, L15)", () => {
  test("a denial committed after the screen was drawn refuses the rename; nothing queued, input kept", async ({
    context,
  }) => {
    const list = listUpsert(12, "Shared", []);
    const { page, net } = await setup(
      context,
      detailRoute(list.id),
      [],
      [list],
    );
    await page.getByRole("button", { name: "Rename" }).click();
    await dialog(page).getByLabel("Name").fill("Renamed here");
    // The server's next page says this person may no longer edit the list (an access change made elsewhere).
    const denied = listUpsert(12, "Shared", [], {
      can_edit: false,
      version: 3,
    });
    await syncPage(page, net, [denied.upsert]);
    // The dialog follows the committed denial: Save is withheld with the reason, and what was typed stays. (A denial committed between
    // the screen's last read and the act is refused by the writing transaction: lists-dialogs.test.tsx, over the production outbox.)
    await expect(dialog(page)).toContainText("You can't change this list");
    await expect(
      dialog(page).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    await expect(dialog(page).getByLabel("Name")).toHaveValue("Renamed here");
    expect(await queued(page)).toEqual([]);
  });

  test("the other tab edits the queued create's name: this tab's rename is refused once, input kept", async ({
    context,
  }) => {
    const { page } = await setup(context, LISTS_ROUTE, [], []);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "+ New list" }).click();
    await dialog(page).getByLabel("Name").fill("Original");
    await dialog(page).getByRole("button", { name: "Create list" }).click();
    await expect(detail(page)).toBeVisible();
    const id = (await detail(page).getAttribute("data-list-detail")) as string;
    await page.getByRole("button", { name: "Rename" }).click();
    await dialog(page).getByLabel("Name").fill("Mine");
    const other = await context.newPage();
    await other.goto(`/__session?route=${encodeURIComponent(detailRoute(id))}`);
    await other.waitForFunction(() => window.__atlasData !== undefined);
    await untilTreeSettled(other);
    await goOfflineAtBoundary(other);
    await other.getByRole("button", { name: "Rename" }).click();
    await dialog(other).getByLabel("Name").fill("Theirs");
    await dialog(other).getByRole("button", { name: "Save" }).click();
    await expect(dialog(other)).toHaveCount(0);
    // The page behind the open dialog is outside the accessibility tree (modal): read its heading by its element.
    await expect(page.locator("h1[data-page-heading]")).toHaveText("Theirs");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await expect(dialog(page)).toContainText(
      "This list's unsent change was edited somewhere else.",
    );
    await expect(dialog(page).getByLabel("Name")).toHaveValue("Mine");
    const all = await queued(page);
    expect(all.map((x) => x.body.command.name)).toEqual(["Theirs"]);
    await other.close();
  });

  test("both tabs add to the same list: chained locally, both sent, no conflict", async ({
    context,
  }) => {
    const a = buildTask({ n: 13, title: "From tab one" });
    const b = buildTask({ n: 14, title: "From tab two" });
    const list = listUpsert(13, "Together", [], { version: 4 });
    const { page, net } = await setup(
      context,
      detailRoute(list.id),
      [a, b],
      [list],
    );
    await goOfflineAtBoundary(page);
    const other = await context.newPage();
    await other.goto(
      `/__session?route=${encodeURIComponent(detailRoute(list.id))}`,
    );
    await other.waitForFunction(() => window.__atlasData !== undefined);
    await untilTreeSettled(other);
    await goOfflineAtBoundary(other);
    await page.getByRole("button", { name: "Add task to list" }).click();
    await dialog(page)
      .locator(`[data-picker-task="${a.taskId}"] input`)
      .check();
    await dialog(page).getByRole("button", { name: "Add selected" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await other.getByRole("button", { name: "Add task to list" }).click();
    await dialog(other)
      .locator(`[data-picker-task="${b.taskId}"] input`)
      .check();
    await dialog(other).getByRole("button", { name: "Add selected" }).click();
    await expect(dialog(other)).toHaveCount(0);
    await other.close();
    const items = await queued(page, "list_item");
    expect(items.map((x) => x.body.command.expected_version)).toEqual([4, 5]);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(2);
    expect(sentKinds(net).map((c) => c.task_id)).toEqual([a.taskId, b.taskId]);
  });
});

test.describe("E-LS8 (a), (b): real-engine ordering (L7, L15, R5)", () => {
  /** Every list row the detail ever drew (title, or "withheld"), recorded as React commits it. */
  async function watchRows(page: Page): Promise<() => Promise<string[]>> {
    await page.evaluate(() => {
      const seen = new Set<string>();
      const look = () => {
        for (const row of document.querySelectorAll(
          "[data-list-detail] [data-list-row]",
        ))
          seen.add(
            `${row.getAttribute("data-list-row")}:${row.getAttribute("data-list-task")}:${row.textContent ?? ""}`,
          );
      };
      new MutationObserver(look).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      (window as unknown as { __rows: Set<string> }).__rows = seen;
    });
    return () =>
      page.evaluate(() => [
        ...(window as unknown as { __rows: Set<string> }).__rows,
      ]);
  }

  for (const changed of [true, false])
    test(`(a) ${changed ? "a commit placed between the detail's list stages and its task stages is never shown mixed" : "control: the same placement with a commit the list does not see"}`, async ({
      context,
    }, info) => {
      await observeTransactions(context);
      const old = buildTask({ n: 21, title: "Old member" });
      const fresh = buildTask({ n: 22, title: "New member" });
      const list = listUpsert(21, "Mixed", [old.taskId]);
      const { page, net } = await setup(context, LISTS_ROUTE, [old], [list]);
      await expect(page.locator("[data-lists-pane]")).toContainText("Mixed");
      await installOrdering(page);
      const rows = await watchRows(page);
      const start = (await logOf(page)).length;
      // ONE page: the list now holds the new member, and the old member is renamed. A read that saw the list before it and its member
      // after it would draw the old member under the new name ("Mixed marker"): no complete read can. The control's page adds an
      // unrelated task only.
      const marker = {
        ...(old.upserts[0] as { resource: Record<string, unknown> }).resource,
        label: "Mixed marker",
        version: 2,
      };
      scriptPage(
        net,
        changed
          ? [
              listUpsert(21, "Mixed", [fresh.taskId], { version: 3 }).upsert,
              ...fresh.upserts,
              { kind: "upsert", resource: marker },
            ]
          : [...fresh.upserts],
      );
      // 1. The leader's step is stopped at its quota read (`holdQuota`), after its own reads of this database: from there to its commit
      // it creates no transaction here.
      await page.evaluate(() => window.__atlasData?.holdQuota());
      await page.evaluate(() => window.__atlasData?.retrySync());
      await expect
        .poll(async () => (await logOf(page)).slice(start).some(readsWork))
        .toBe(true);
      // 2. The queue is held, by a transaction created after the leader's reads (it waits for them, they never wait for it).
      const held = await holdStores(page, ["drafts"]);
      await expect.poll(() => holdStarted(page, held)).toBe(true);
      // 3. The detail's read: its basis and the list's row are read; its work stage waits behind the hold.
      const opened = (await logOf(page)).length;
      await navigateInApp(page, detailRoute(list.id));
      await expect
        .poll(async () => (await logOf(page)).slice(opened).some(readsWork))
        .toBe(true);
      // 4. The leader goes on: its commit is created behind the waiting stage, so it runs after it and before every later stage.
      await page.evaluate(() => window.__atlasData?.releaseQuota());
      await expect
        .poll(async () => (await logOf(page)).slice(opened).some(isCommit))
        .toBe(true);
      expect(await releaseHold(page, held)).toBe("complete");
      const shown = changed ? fresh : old;
      await expect(
        detail(page).locator(`[data-list-task="${shown.taskId}"]`),
      ).toBeVisible();
      await waitForState(page, "idle");
      const log = (await logOf(page)).slice(opened);
      const commit = log.findIndex(isCommit);
      const seen = await rows();
      recordEvidence(info, `e-ls8a-${changed ? "mixed" : "control"}`, {
        log,
        commit,
        seen,
      });
      // The placement: the list's row read and the work stage created before the commit, a row read created after it.
      expect(log.slice(0, commit).some(readsRows), "rows read before").toBe(
        true,
      );
      expect(log.slice(0, commit).some(readsWork), "work read before").toBe(
        true,
      );
      expect(log.slice(commit + 1).some(readsRows), "rows read after").toBe(
        true,
      );
      expect(
        seen.filter(
          (s) => s.includes("Mixed marker") || s.startsWith("withheld"),
        ),
        "never a mixed composition",
      ).toEqual([]);
      expect(seen.some((s) => s.includes(shown.taskId))).toBe(true);
    });

  for (const denied of [true, false])
    test(`(b) ${denied ? "a denial committed after the screen's last read is refused by the writing transaction; nothing queued" : "control: the same stale admission with no denial queues the remove"}`, async ({
      context,
    }, info) => {
      await observeTransactions(context);
      const member = buildTask({ n: 23, title: "Member" });
      const list = listUpsert(23, "Shared", [member.taskId]);
      const { page, net } = await setup(
        context,
        detailRoute(list.id),
        [member],
        [list],
      );
      await goOfflineAtBoundary(page);
      const remove = detail(page).getByRole("button", {
        name: "Remove Member",
      });
      await expect(remove).toBeEnabled();
      await installOrdering(page);
      // A hold over the effects store, created right behind the leader's next commit: the screen's read of that commit waits behind
      // it, so what the screen admits is its read from BEFORE the commit.
      const rule = await holdBehind(page, {
        mode: "readwrite",
        has: ["cache", "pending_effects", "drafts"],
        hold: ["pending_effects"],
      });
      scriptPage(net, [
        listUpsert(23, "Shared", [member.taskId], {
          version: 3,
          ...(denied ? { can_edit: false } : {}),
        }).upsert,
      ]);
      await goOnlineAtBoundary(page);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await expect
        .poll(async () => (await storedRow(page, "cache", list.id))?.version)
        .toBe(3);
      expect(
        (await storedRow(page, "cache", list.id))?.can_edit,
        "committed on this device",
      ).toBe(!denied);
      const held = await firedHold(page, rule);
      expect(held, "the hold stands behind the commit").not.toBeNull();
      await expect.poll(() => holdStarted(page, held as number)).toBe(true);
      // Stale admission: the screen still offers Remove.
      await expect(remove).toBeEnabled();
      const before = (await logOf(page)).length;
      await remove.click();
      await expect
        .poll(async () => (await logOf(page)).slice(before).some(isEnqueue))
        .toBe(true);
      expect(await releaseHold(page, held as number)).toBe("complete");
      // What became of the save: the writing transaction refused it (announced), or it was queued.
      const outcome = async () =>
        (await queued(page, "list_item")).length > 0
          ? "queued"
          : (await page
                .getByText("You can't change this. Nothing was saved.")
                .count()) > 0
            ? "refused"
            : "pending";
      await expect.poll(outcome).not.toBe("pending");
      expect(await outcome(), "the writing transaction's decision").toBe(
        denied ? "refused" : "queued",
      );
      if (denied)
        await expect(
          detail(page).getByRole("button", { name: "Rename" }),
        ).toBeDisabled();
      const log = (await logOf(page)).slice(before);
      recordEvidence(info, `e-ls8b-${denied ? "denied" : "control"}`, {
        log,
        drafts: await draftsOf(page),
      });
      expect(await queued(page)).toHaveLength(denied ? 0 : 1);
    });
});

test.describe("E-LS10: the detail's page heading (R4, L17)", () => {
  const headings = (page: Page) =>
    page.locator("main h1[data-page-heading]").allTextContents();

  test("a deep link to a list this device does not hold: one page heading, naming nothing of it", async ({
    context,
  }) => {
    const absent = listIdOf(98);
    const { page } = await setup(context, detailRoute(absent), [], []);
    await expect(page.locator('[data-list-detail="absent"]')).toBeVisible();
    expect(await headings(page)).toEqual(["Lists"]);
  });

  test("focus moved to the loading heading by a navigation stays on it when the list's name arrives", async ({
    context,
  }) => {
    await observeTransactions(context);
    const list = listUpsert(24, "Groceries", []);
    const { page } = await setup(context, LISTS_ROUTE, [], [list]);
    await expect(page.locator("[data-lists-pane]")).toContainText("Groceries");
    await installOrdering(page);
    // The detail's read waits at its work stage until released, so the page is certainly loading when the route moves focus.
    const held = await holdStores(page, ["drafts"]);
    await expect.poll(() => holdStarted(page, held)).toBe(true);
    await page
      .locator("[data-lists-pane]")
      .getByRole("link", { name: /Groceries/ })
      .click();
    await expect(page.getByText("Loading this list")).toBeVisible();
    // The route's focus is moved one frame after it resolves.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))),
    );
    expect(
      await page.evaluate(() =>
        document.activeElement?.matches("h1[data-page-heading]"),
      ),
      "the loading page's heading has the focus",
    ).toBe(true);
    expect(await headings(page)).toEqual(["Lists"]);
    expect(await releaseHold(page, held)).toBe("complete");
    await expect(page.locator(`[data-list-detail="${list.id}"]`)).toBeVisible();
    expect(await headings(page)).toEqual(["Groceries"]);
    expect(
      await page.evaluate(() => document.activeElement?.textContent),
      "the focused heading is the list's",
    ).toBe("Groceries");
  });
});

test.describe("E-LS9: keyboard only (L17)", () => {
  test("create, add, remove, rename and archive by keyboard; focus returns", async ({
    context,
  }) => {
    const a = buildTask({ n: 15, title: "Keyboard task" });
    const { page } = await setup(context, LISTS_ROUTE, [a], []);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "+ New list" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.type("By keys");
    await page.keyboard.press("Enter");
    await expect(detail(page)).toBeVisible();
    await page.getByRole("button", { name: "Add task to list" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      dialog(page).locator(`[data-picker-task="${a.taskId}"] input`),
    ).toBeVisible();
    await dialog(page)
      .locator(`[data-picker-task="${a.taskId}"] input`)
      .focus();
    await page.keyboard.press("Space");
    await dialog(page).getByRole("button", { name: "Add selected" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("[data-list-row]")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove Keyboard task" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-list-row]")).toHaveCount(0);
    // Focus moves to "Add task to list" once the last row has left.
    await expect(
      page.getByRole("button", { name: "Add task to list" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Rename" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Renamed by keys");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename" })).toBeFocused();
    await page.getByRole("button", { name: "Archive" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    const kinds = (await queued(page)).map((x) => x.body.command.kind);
    expect(kinds).toEqual(["create_list", "list_item", "list_item", "archive"]);
  });
});

/**
 * TEST-ONLY FAULT, ARTIFICIAL (revision 2, review 2 R1/R2; design assessment Q4): the answer of ONE committed draft write is lost. Installed
 * before any page opens its database (Dexie takes the method when it opens). Armed on a page (`loseNextAnswer`), the next readwrite
 * transaction over `draft_commands` COMMITS for real; Dexie is then told it ABORTED (its own `onabort`, with no error), never that it
 * completed, so the app sees a failed write whose data is stored: a store that failed after the write committed. Its notification is lost
 * with it, as a real lost answer's would be. Unarmed it passes every transaction through untouched (each case's control).
 */
async function loseCommittedAnswers(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __loseAnswer: boolean;
      __lost: number;
    };
    w.__loseAnswer = false;
    w.__lost = 0;
    // The armed transactions, and those of them that wrote a draft body (a round that writes nothing, such as an enqueue re-admitted at its
    // measured size, is passed through: only a committed draft write loses its answer).
    const armed = new WeakSet<IDBTransaction>();
    const wrote = new WeakSet<IDBTransaction>();
    for (const method of ["put", "add"] as const) {
      const write = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (this.name === "draft_commands" && armed.has(this.transaction))
          wrote.add(this.transaction);
        return write.apply(this, args);
      } as IDBObjectStore["put"];
    }
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = original.apply(this, args);
      const scope = args[0];
      const stores = typeof scope === "string" ? [scope] : [...scope];
      if (
        !w.__loseAnswer ||
        args[1] !== "readwrite" ||
        !stores.includes("draft_commands")
      )
        return tx;
      armed.add(tx);
      let aborted: ((event: Event) => void) | null = null;
      let completed: ((event: Event) => void) | null = null;
      Object.defineProperty(tx, "onabort", {
        configurable: true,
        get: () => aborted,
        set: (handler: ((event: Event) => void) | null) => {
          aborted = handler;
        },
      });
      Object.defineProperty(tx, "oncomplete", {
        configurable: true,
        get: () => completed,
        set: (handler: ((event: Event) => void) | null) => {
          completed = handler;
        },
      });
      tx.addEventListener("complete", (event) => {
        if (!wrote.has(tx) || !w.__loseAnswer) {
          completed?.(event);
          return;
        }
        w.__loseAnswer = false;
        w.__lost += 1;
        aborted?.(new Event("abort"));
      });
      return tx;
    } as IDBDatabase["transaction"];
  });
}
const loseNextAnswer = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __loseAnswer: boolean }).__loseAnswer = true;
  });
const answersLost = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lost: number }).__lost);
const bySeq = <T extends { draft: { created_seq: number } }>(rows: T[]) =>
  [...rows].sort((x, y) => x.draft.created_seq - y.draft.created_seq);
const STORAGE_REFUSED = "Couldn't save on this device";

test.describe("E-LS11: an answer lost after the write (review 2 R1, R2)", () => {
  for (const remount of [true, false])
    test(`create: the earlier request's retry settles ${remount ? "on the dialog mounted again by Sync and Back" : "on the same dialog (control)"}; the next Save creates the newer name once`, async ({
      context,
    }) => {
      await loseCommittedAnswers(context);
      const { page } = await setup(context, LISTS_ROUTE, [], []);
      await goOfflineAtBoundary(page);
      await page.getByRole("button", { name: "+ New list" }).click();
      await dialog(page).getByLabel("Name").fill("Original");
      await loseNextAnswer(page);
      await dialog(page).getByRole("button", { name: "Create list" }).click();
      // Written, its answer lost: the dialog does not say it saved.
      await expect(dialog(page)).toContainText(STORAGE_REFUSED);
      expect(await answersLost(page)).toBe(1);
      expect(
        (await queued(page, "create_list")).map((x) => x.body.command.name),
      ).toEqual(["Original"]);
      await dialog(page).getByLabel("Name").fill("Newer");
      // The look-up of the earlier request (the dialog's next Save; revision 3, D1: never sent again) is held: a read-only transaction over
      // `drafts` waits behind the read-write one the hold keeps alive.
      const release = await holdDraftWrites(page);
      await dialog(page).getByRole("button", { name: "Create list" }).click();
      await expect(dialog(page).getByLabel("Name")).toBeDisabled();
      if (remount) {
        await toSyncFromDialog(page);
        await expect(dialog(page)).toHaveCount(0);
        await page.goBack();
        await expect(dialog(page).getByLabel("Name")).toBeDisabled();
      }
      await release();
      await expect(dialog(page).getByLabel("Name")).toBeEnabled();
      await expect(dialog(page).getByLabel("Name")).toHaveValue("Newer");
      await expect(dialog(page)).toContainText(
        "Your earlier save created “Original”.",
      );
      await expect(page).toHaveURL(/\/tasks\/lists$/);
      await dialog(page).getByRole("button", { name: "Create list" }).click();
      await expect(dialog(page)).toHaveCount(0);
      const creates = bySeq(await queued(page, "create_list"));
      expect(creates.map((x) => x.body.command.name)).toEqual([
        "Original",
        "Newer",
      ]);
      await expect(page).toHaveURL(
        new RegExp(`/tasks/lists/${creates[1]?.body.command.id as string}$`),
      );
    });

  for (const lost of [true, false])
    test(`picker: ${lost ? "A's add written but its answer lost (B not sent)" : "A and B added (control, no lost answer)"}; A removed in another tab, then chosen again: a new add after the remove`, async ({
      context,
    }) => {
      await loseCommittedAnswers(context);
      const a = buildTask({ n: 31, title: "First" });
      const b = buildTask({ n: 32, title: "Second" });
      const list = listUpsert(31, "Errands", []);
      const { page } = await setup(
        context,
        detailRoute(list.id),
        [a, b],
        [list],
      );
      await goOfflineAtBoundary(page);
      const box = (t: BuiltTask) =>
        dialog(page).locator(`[data-picker-task="${t.taskId}"] input`);
      await page.getByRole("button", { name: "Add task to list" }).click();
      await box(a).check();
      await box(b).check();
      if (lost) await loseNextAnswer(page);
      await dialog(page).getByRole("button", { name: "Add selected" }).click();
      if (lost) {
        await expect(dialog(page)).toContainText(STORAGE_REFUSED);
        expect(await answersLost(page)).toBe(1);
        expect(await queued(page, "list_item")).toHaveLength(1);
      } else {
        await expect(dialog(page)).toHaveCount(0);
        expect(await answersLost(page)).toBe(0);
      }
      const other = await context.newPage();
      await other.goto(
        `/__session?route=${encodeURIComponent(detailRoute(list.id))}`,
      );
      await other.waitForFunction(() => window.__atlasData !== undefined);
      await untilTreeSettled(other);
      await goOfflineAtBoundary(other);
      await other.getByRole("button", { name: "Remove First" }).click();
      await expect
        .poll(async () => (await queued(page, "list_item")).length)
        .toBe(lost ? 2 : 3);
      if (!lost)
        await page.getByRole("button", { name: "Add task to list" }).click();
      // A is offered again; an earlier selection of it, if shown, is cleared, then A is chosen: a new selection.
      await expect(box(a)).toBeVisible();
      if (await box(a).isChecked()) await box(a).uncheck();
      await box(a).check();
      await dialog(page).getByRole("button", { name: "Add selected" }).click();
      await expect(dialog(page)).toHaveCount(0);
      const items = bySeq(await queued(page, "list_item"));
      const ops = items.map(
        (x) =>
          `${x.body.command.included ? "+" : "-"}${x.body.command.task_id as string}`,
      );
      expect(ops).toEqual(
        lost
          ? [`+${a.taskId}`, `-${a.taskId}`, `+${b.taskId}`, `+${a.taskId}`]
          : [`+${a.taskId}`, `+${b.taskId}`, `-${a.taskId}`, `+${a.taskId}`],
      );
      const addsOfA = items.filter(
        (x) => x.body.command.task_id === a.taskId && x.body.command.included,
      );
      expect(new Set(addsOfA.map((x) => x.draft.local_id)).size).toBe(2);
    });
});

/** Another tab of the context, at `route`, with an outbox of its own (not dispatching): its production writers act on the same database. */
async function otherTab(context: BrowserContext, route: string): Promise<Page> {
  const other = await context.newPage();
  await other.goto(`/__session?route=${encodeURIComponent(route)}`);
  await other.waitForFunction(() => window.__atlasData !== undefined);
  await untilTreeSettled(other);
  await goOfflineAtBoundary(other);
  await startOutbox(other, ACCOUNT, { start: false });
  return other;
}
const discardIn = (other: Page, localId: string) =>
  other.evaluate(
    (id) => window.__atlasData?.discardDraft(id),
    localId,
  ) as Promise<{ kind: string }>;

test.describe("E-LS12: an earlier outcome this device cannot establish (revision 3, D1)", () => {
  for (const discarded of [true, false])
    test(`create: the stored create of a lost answer ${discarded ? "discarded in another tab: Save writes nothing and says so; the decision creates a separate list" : "still stored (control): Save finds it and closes onto it"}`, async ({
      context,
    }) => {
      await loseCommittedAnswers(context);
      const { page } = await setup(context, LISTS_ROUTE, [], []);
      await goOfflineAtBoundary(page);
      await page.getByRole("button", { name: "+ New list" }).click();
      await dialog(page).getByLabel("Name").fill("Original");
      await loseNextAnswer(page);
      await dialog(page).getByRole("button", { name: "Create list" }).click();
      await expect(dialog(page)).toContainText(STORAGE_REFUSED);
      expect(await answersLost(page)).toBe(1);
      const [first] = await queued(page, "create_list");
      const old = first?.draft.local_id as string;
      const oldList = first?.body.command.id as string;
      if (discarded) {
        const other = await otherTab(context, LISTS_ROUTE);
        expect(await discardIn(other, old)).toMatchObject({
          kind: "discarded",
        });
        await expect.poll(async () => (await queued(page)).length).toBe(0);
      }
      await dialog(page).getByRole("button", { name: "Create list" }).click();
      if (!discarded) {
        await expect(dialog(page)).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/tasks/lists/${oldList}$`));
        expect(
          (await queued(page)).map((x) => x.draft.local_id),
          "nothing written",
        ).toEqual([old]);
        return;
      }
      await expect(dialog(page)).toContainText(
        "This device can't tell whether your earlier save created “Original”",
      );
      expect(await queued(page), "nothing written").toEqual([]);
      await expect(dialog(page).getByLabel("Name")).toHaveValue("Original");
      await expect(page).toHaveURL(/\/tasks\/lists$/);
      await dialog(page)
        .getByRole("button", { name: "Create as a new list" })
        .click();
      await expect(dialog(page)).toHaveCount(0);
      const made = await queued(page, "create_list");
      expect(made).toHaveLength(1);
      expect(made[0]?.draft.local_id).not.toBe(old);
      expect(made[0]?.body.command.id).not.toBe(oldList);
      expect(made[0]?.body.command.name).toBe("Original");
      await expect(page).toHaveURL(
        new RegExp(`/tasks/lists/${made[0]?.body.command.id as string}$`),
      );
    });

  for (const discarded of [true, false])
    test(`picker: A's lost add ${discarded ? "discarded in another tab: Add writes nothing, B held back too; the decision adds A anew and B" : "still stored (control): A found, B added"}`, async ({
      context,
    }) => {
      await loseCommittedAnswers(context);
      const a = buildTask({ n: 41, title: "First" });
      const b = buildTask({ n: 42, title: "Second" });
      const list = listUpsert(41, "Errands", []);
      const { page } = await setup(
        context,
        detailRoute(list.id),
        [a, b],
        [list],
      );
      await goOfflineAtBoundary(page);
      const box = (t: BuiltTask) =>
        dialog(page).locator(`[data-picker-task="${t.taskId}"] input`);
      await page.getByRole("button", { name: "Add task to list" }).click();
      await box(a).check();
      await box(b).check();
      await loseNextAnswer(page);
      await dialog(page).getByRole("button", { name: "Add selected" }).click();
      await expect(dialog(page)).toContainText(STORAGE_REFUSED);
      expect(await answersLost(page)).toBe(1);
      const [lostAdd] = await queued(page, "list_item");
      const old = lostAdd?.draft.local_id as string;
      if (discarded) {
        const other = await otherTab(context, detailRoute(list.id));
        expect(await discardIn(other, old)).toMatchObject({
          kind: "discarded",
        });
        await expect.poll(async () => (await queued(page)).length).toBe(0);
      }
      await dialog(page).getByRole("button", { name: "Add selected" }).click();
      const ops = async () =>
        bySeq(await queued(page, "list_item")).map(
          (x) =>
            `${x.body.command.included ? "+" : "-"}${x.body.command.task_id as string}`,
        );
      if (!discarded) {
        await expect(dialog(page)).toHaveCount(0);
        expect(await ops()).toEqual([`+${a.taskId}`, `+${b.taskId}`]);
        return;
      }
      await expect(dialog(page)).toContainText(
        "This device can't tell whether an earlier add to this list was made",
      );
      expect(await queued(page), "nothing written").toEqual([]);
      await expect(box(a)).toBeChecked();
      await expect(box(b)).toBeChecked();
      await dialog(page)
        .getByRole("button", { name: "Add as new adds" })
        .click();
      await expect(dialog(page)).toHaveCount(0);
      expect(await ops()).toEqual([`+${a.taskId}`, `+${b.taskId}`]);
      const items = await queued(page, "list_item");
      expect(items.map((x) => x.draft.local_id)).not.toContain(old);
    });
});

/**
 * Revision 4 (review 4, D1 / DA-N1): a task this device created offline (its `create_task` queued), chosen in the picker; another tab's
 * PRODUCTION discard removes that create before Add, or BETWEEN the add's read of the task and its write. The placement is by real
 * transaction order: the add's read of the task (`data.readResourceView`, the one read-only transaction over `resource_versions` and
 * `draft_commands`) is observed as it is created, and in that same turn the spec creates a read-write transaction of its own on the quota
 * ledger, which the add's quota reservation must wait for before its writing transaction can be created. The other tab's discard commits
 * while the add waits; the ledger is then released. No plan, read or write of the app is altered.
 */
async function unsentTask(page: Page, title: string): Promise<string> {
  await page
    .getByRole("button", { name: "Start from scratch instead" })
    .click();
  await expect(
    page.getByRole("radio", { name: "Use my defaults (only you)" }),
  ).toBeVisible();
  await goOfflineAtBoundary(page);
  await page.getByLabel("Name", { exact: true }).fill(title);
  await page.getByRole("radio", { name: "Only me" }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("[data-task-detail]")).toBeVisible();
  const [create] = await queued(page, "create_task");
  expect(create, "the task's create is queued").toBeDefined();
  return create?.draft.local_id as string;
}
/** Arms the ledger hold behind the add's read of the task (see above); the spec's own connection to the ledger is opened now. */
async function holdLedgerBehindTaskRead(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type Entry = { n: number; mode: string; stores: string[] };
    const hooks = (
      window as unknown as {
        __orderHooks: { created: ((entry: Entry) => void) | null };
      }
    ).__orderHooks;
    const ledger = await new Promise<IDBDatabase>((ok, fail) => {
      const open = indexedDB.open("atlas-quota-ledger");
      open.onsuccess = () => ok(open.result);
      open.onerror = () => fail(open.error);
    });
    const state = {
      fired: null as number | null,
      started: false,
      release: false,
      done: null as Promise<string> | null,
    };
    (window as unknown as { __ledgerHold: typeof state }).__ledgerHold = state;
    const previous = hooks.created;
    hooks.created = (entry) => {
      previous?.(entry);
      if (
        state.fired !== null ||
        entry.mode !== "readonly" ||
        !["resource_versions", "draft_commands", "cache"].every((s) =>
          entry.stores.includes(s),
        )
      )
        return;
      state.fired = entry.n;
      const tx = ledger.transaction(["ledger"], "readwrite");
      const store = tx.objectStore("ledger");
      state.done = new Promise<string>((done) => {
        tx.oncomplete = () => done("complete");
        tx.onabort = () => done("abort");
      });
      const ask = () => {
        store.get("__ordering_hold__").onsuccess = () => {
          state.started = true;
          if (!state.release) ask();
        };
      };
      ask();
    };
  });
}
const ledgerHold = (page: Page) =>
  page.evaluate(() => {
    const h = (
      window as unknown as {
        __ledgerHold: { fired: number | null; started: boolean };
      }
    ).__ledgerHold;
    return { fired: h.fired, started: h.started };
  });
const releaseLedger = (page: Page) =>
  page.evaluate(() => {
    const h = (
      window as unknown as {
        __ledgerHold: { release: boolean; done: Promise<string> | null };
      }
    ).__ledgerHold;
    h.release = true;
    return h.done;
  });
const GONE = "A task you chose isn't on this device any more";
const CHANGED =
  "A task you chose changed on this device while it was being added";

test.describe("E-LS13: an add waits for its task's current create (revision 4, D1 / DA-N1)", () => {
  test("the create discarded in another tab BEFORE Add: nothing written, the selection kept and shown; Deselect", async ({
    context,
  }) => {
    const list = listUpsert(51, "Errands", []);
    const { page } = await setup(context, "/tasks/new", [], [list]);
    const create = await unsentTask(page, "Brand new task");
    const [made] = await queued(page, "create_task");
    const task = made?.body.command.id as string;
    await navigateInApp(page, detailRoute(list.id));
    await page.getByRole("button", { name: "Add task to list" }).click();
    await dialog(page).locator(`[data-picker-task="${task}"] input`).check();
    const other = await otherTab(context, detailRoute(list.id));
    expect(await discardIn(other, create)).toMatchObject({
      kind: "discarded",
    });
    await expect.poll(async () => (await queued(page)).length).toBe(0);
    await dialog(page).getByRole("button", { name: "Add selected" }).click();
    await expect(dialog(page)).toContainText(GONE);
    expect(await queued(page), "nothing written").toEqual([]);
    await expect(dialog(page)).toContainText("1 selected");
    const missing = dialog(page).locator(`[data-picker-missing="${task}"]`);
    await expect(missing).toContainText(
      "“Brand new task” isn't on this device any more",
    );
    await dialog(page)
      .getByRole("button", { name: "Deselect “Brand new task”" })
      .click();
    await expect(missing).toHaveCount(0);
    await expect(dialog(page)).toContainText("0 selected");
  });

  for (const discarded of [true, false])
    test(`${discarded ? "the create discarded in another tab BETWEEN the add's read of the task and its write: refused, nothing written; Add again finds the task gone" : "control: the same placement, the create kept: the add is written and waits for it"}`, async ({
      context,
    }, info) => {
      await observeTransactions(context);
      const list = listUpsert(52, "Errands", []);
      const { page } = await setup(context, "/tasks/new", [], [list]);
      const create = await unsentTask(page, "Brand new task");
      const [made] = await queued(page, "create_task");
      const task = made?.body.command.id as string;
      await navigateInApp(page, detailRoute(list.id));
      await page.getByRole("button", { name: "Add task to list" }).click();
      await dialog(page).locator(`[data-picker-task="${task}"] input`).check();
      const other = await otherTab(context, detailRoute(list.id));
      await installOrdering(page);
      await holdLedgerBehindTaskRead(page);
      const start = (await logOf(page)).length;
      await dialog(page).getByRole("button", { name: "Add selected" }).click();
      await expect
        .poll(async () => (await ledgerHold(page)).started)
        .toBe(true);
      const read = (await ledgerHold(page)).fired as number;
      // The add waits at the ledger: its read of the task is made, its writing transaction is not created yet.
      expect(
        (await logOf(page)).slice(start).some(isEnqueue),
        "no write created while the ledger is held",
      ).toBe(false);
      if (discarded)
        expect(await discardIn(other, create)).toMatchObject({
          kind: "discarded",
        });
      expect(await releaseLedger(page)).toBe("complete");
      const outcome = discarded ? CHANGED : null;
      if (outcome === null) await expect(dialog(page)).toHaveCount(0);
      else await expect(dialog(page)).toContainText(outcome);
      const log = (await logOf(page)).slice(start);
      const write = log.find(isEnqueue);
      recordEvidence(info, `e-ls13-${discarded ? "between" : "control"}`, {
        read,
        log,
      });
      expect(write, "the add's write was created").toBeDefined();
      expect((write as Created).n, "after the read").toBeGreaterThan(read);
      const items = await queued(page, "list_item");
      if (!discarded) {
        expect(items).toHaveLength(1);
        const rows = (await page.evaluate(
          (acct) => window.__atlasData?.rows(acct, "drafts"),
          ACCOUNT,
        )) as Array<{ local_id: string; depends_on: string[] }>;
        expect(
          rows.find((r) => r.local_id === items[0]?.draft.local_id)?.depends_on,
          "the add waits for the create it read",
        ).toContain(create);
        return;
      }
      expect(items, "nothing written").toEqual([]);
      await expect(dialog(page)).toContainText("1 selected");
      await dialog(page).getByRole("button", { name: "Add selected" }).click();
      await expect(dialog(page)).toContainText(GONE);
      expect(await queued(page, "list_item"), "still nothing").toEqual([]);
    });
});

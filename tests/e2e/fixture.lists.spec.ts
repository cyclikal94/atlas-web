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
 * (a denial committed after the screen was drawn, the queued create edited in the other tab, both adding); E-LS9 keyboard only.
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

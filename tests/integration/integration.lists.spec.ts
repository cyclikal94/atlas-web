import { readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import * as commands from "../../src/features/tasks/model/commands";
import type { TaskDefinition } from "../../src/features/tasks/model/contract";
import { occurrenceId, progressId } from "../../src/features/tasks/model/ids";
import * as lists from "../../src/features/tasks/model/lists";
import { slotOn, todayIn } from "../../src/features/tasks/model/time";
import {
  ACCOUNTS,
  bootHarness,
  expect,
  exposeSession,
  paceSignIn,
  proxy,
  signIn as signInUnpaced,
  stackFile,
  test,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-10b against the RELEASED backend (`v0.29.0-rc.1`) on a disposable SQLite database behind the delaying proxy: the production session,
 * the production data controller and the Lists screens, with the FIXTURE leader standing in for production leadership. FOCUSED
 * REAL-BACKEND EVIDENCE for a fixture-stage task: BE-Q1 and BE-CH1 have no completion record, so this is NOT integration acceptance
 * (`integration_passed` stays false). No PostgreSQL, HTTPS or device.
 *
 * I-LS1 create, add two, rename and remove through the UI (server values and versions); I-LS2 the access boundary (another person's private
 * task never reaches the reader); I-LS3 the 100-reference cap counting a task the reader cannot see (`503 slice_capacity`); I-LS4 an
 * offline create and add whose create's answer is lost (same-key replay: one list); I-LS5 another device's rename makes a queued add a
 * version conflict, resent from /sync on the reviewed version (the `GET /lists` walk); I-LS6 a sharing change makes a queued rename a
 * Q1 conflict, resent on the new policy version; I-LS7 archive and restore; I-LS8 a real `defaults_changed` for a queued create.
 */
const API = "/api/experimental/v1";
const budget = (who: Who) => paceSignIn(who);
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const OTHERS: Who[] = ["frank", "grace", "heidi", "ivan"];
const ROTATION_FILE = stackFile("atlas-lists-rotation.txt");
let main: Who = "alice";
let other: Who = "frank";
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
  other = OTHERS[n % OTHERS.length] as Who;
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
async function leader(page: Page, account: string): Promise<void> {
  await page.evaluate((a) => window.__atlasData?.prepareAccount(a), account);
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}
async function reopenBound(page: Page, account: string, route: string) {
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await exposeSession(page);
  await untilView(page, "displaying");
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}
async function bootAs(
  context: BrowserContext,
  who: Who,
  route = "/tasks/lists",
) {
  const page = await bootHarness(context, "/tasks");
  const id = await signedIn(page, who);
  await leader(page, id.account_id);
  await reopenBound(page, id.account_id, route);
  return { page, id };
}
const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
const goOffline = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
const goOnline = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
const sendQueue = (page: Page) =>
  page.evaluate(() => window.__atlasData?.retryOutbox());

interface Raw {
  status: number;
  body: unknown;
}
/** One stamped request made in the page (the session's own client), asked again while the session answers `not_sent`. */
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
const post = async (page: Page, id: Id, path: string, body: unknown) => {
  const out = await call(page, id, "POST", path, body, crypto.randomUUID());
  expect(out.status, `${path} ${JSON.stringify(out.body)}`).toBe(200);
  return out;
};

interface ListProjection {
  id: string;
  label: string;
  value: { task_ids: string[] };
  version: number;
  can_edit: boolean;
  policy_version: number;
  archived: boolean;
}
/** A list from the server by id: both `archived` collections of `GET /lists`, every page. */
async function serverList(
  page: Page,
  id: Id,
  listId: string,
): Promise<ListProjection | null> {
  for (const archived of [false, true]) {
    let after: string | null = null;
    for (;;) {
      const out = await call(
        page,
        id,
        "GET",
        `/lists?archived=${archived}&limit=200${after ? `&after=${after}` : ""}`,
      );
      expect(out.status).toBe(200);
      const page_ = out.body as {
        items: ListProjection[];
        next_after: string | null;
      };
      const found = page_.items.find((l) => l.id === listId);
      if (found) return found;
      if (page_.next_after === null) break;
      after = page_.next_after;
    }
  }
  return null;
}
const sorted = (ids: string[]) => [...ids].sort();

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
/** A task created through the client's builder; with `grants`, through `/task-access-commands` with that audience. */
async function makeTask(
  page: Page,
  id: Id,
  title: string,
  grants?: Array<{ kind: "account"; id: string; edit: boolean }>,
): Promise<string> {
  const taskId = crypto.randomUUID();
  const definition = def();
  const slot = slotOn(definition.schedule, definition.schedule.start_date);
  const occ = await occurrenceId(taskId, slot.key);
  const body = commands
    .createTask({
      taskId,
      executionId: crypto.randomUUID(),
      occurrenceId: occ,
      progressId: await progressId(occ, id.account_id),
      title,
      definition,
      sharing: "only_me",
      defaults: null,
    })
    .build({}).command as { command: Record<string, unknown> };
  if (grants)
    await post(page, id, "/task-access-commands", {
      command: {
        ...body.command,
        initial_policy: { grants, exclude_accounts: [] },
      },
    });
  else await post(page, id, "/task-commands", body);
  return taskId;
}
/** A list created and filled through the client's builders, sent by the test (not the outbox). */
async function makeList(
  page: Page,
  id: Id,
  name: string,
  taskIds: string[],
  grants?: Array<{ kind: "account"; id: string; edit: boolean }>,
): Promise<string> {
  const listId = crypto.randomUUID();
  const create = lists.createList({ listId, name, defaults: null }).build({})
    .command as { command: Record<string, unknown> };
  if (grants)
    await post(page, id, "/task-access-commands", {
      command: {
        ...create.command,
        initial_policy: { grants, exclude_accounts: [] },
      },
    });
  else await post(page, id, "/task-commands", create);
  let version = 1;
  for (const taskId of taskIds) {
    await post(
      page,
      id,
      "/task-commands",
      lists
        .listItem({ listId, taskId, included: true })
        .build({ [listId]: version }).command,
    );
    version += 1;
  }
  return listId;
}
const accountIdOf = async (page: Page, id: Id, username: string) => {
  const found = (
    await call(
      page,
      id,
      "GET",
      `/directory?username=${encodeURIComponent(username)}`,
    )
  ).body as Array<{ id: string; username: string }>;
  const entry = (found ?? []).find((e) => e.username === username);
  if (!entry) throw new Error(`no directory entry for ${username}`);
  return entry.id;
};
const rowsOf = async (page: Page, account: string, store: string) =>
  (await page.evaluate(({ a, s }) => window.__atlasData?.rows(a, s as never), {
    a: account,
    s: store,
  })) as Array<Record<string, unknown>>;
async function untilCached(
  page: Page,
  account: string,
  rid: string,
  check: (row: Record<string, unknown>) => boolean = () => true,
) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__atlasData?.nudgeSync());
        const row = (await rowsOf(page, account, "cache")).find(
          (r) => r.id === rid,
        );
        return row !== undefined && check(row);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}
const queue = async (page: Page, account: string) =>
  (
    (await rowsOf(page, account, "drafts")) as Array<{
      kind: string;
      status: string;
      created_seq: number;
    }>
  ).sort((a, b) => a.created_seq - b.created_seq);
const pickerBox = (page: Page, taskId: string) =>
  page.getByRole("dialog").locator(`[data-picker-task="${taskId}"] input`);

test.describe("I-LS1: create, add, rename and remove through the UI (L2, L6, L7, L9)", () => {
  test("the server holds the client's list: its name, its tasks by id and its version after each change", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const t1 = await makeTask(page, id, `I-LS1 one ${stamp}`);
    const t2 = await makeTask(page, id, `I-LS1 two ${stamp}`);
    await untilCached(page, id.account_id, t1);
    await untilCached(page, id.account_id, t2);
    await page
      .getByRole("button", { name: "+ New list" })
      .click({ timeout: 60_000 });
    await page.getByRole("dialog").getByLabel("Name").fill(`I-LS1 ${stamp}`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create list" })
      .click();
    await expect(page.locator("[data-list-detail]")).toBeVisible({
      timeout: 30_000,
    });
    const listId = (await page
      .locator("[data-list-detail]")
      .getAttribute("data-list-detail")) as string;
    await page.getByRole("button", { name: "Add task to list" }).click();
    await pickerBox(page, t1).check({ timeout: 30_000 });
    await pickerBox(page, t2).check();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add selected" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.version, {
        timeout: 60_000,
      })
      .toBe(3);
    await untilCached(page, id.account_id, listId, (r) => r.version === 3);
    await page.getByRole("button", { name: "Rename" }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Name")
      .fill(`I-LS1 renamed ${stamp}`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(
        async () => {
          const l = await serverList(page, id, listId);
          return l && [l.label, sorted(l.value.task_ids), l.version];
        },
        { timeout: 60_000 },
      )
      .toEqual([`I-LS1 renamed ${stamp}`, sorted([t1, t2]), 4]);
    await untilCached(page, id.account_id, listId, (r) => r.version === 4);
    await page
      .getByRole("button", { name: `Remove I-LS1 one ${stamp}` })
      .click({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.value.task_ids, {
        timeout: 60_000,
      })
      .toEqual([t2]);
  });
});

test.describe("I-LS2: the access boundary (L11)", () => {
  test("another person's private task never reaches the reader: not cached, not in the list value, the page or the picker", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const bob = await accountIdOf(page, id, ACCOUNTS[other].username);
    const privateTitle = `I-LS2 private ${stamp}`;
    const p = await makeTask(page, id, privateTitle);
    const s = await makeTask(page, id, `I-LS2 shared ${stamp}`, [
      { kind: "account", id: bob, edit: false },
    ]);
    const listId = await makeList(page, id, `I-LS2 ${stamp}`, [p, s]);
    // Shared with the reader for editing, through the shared sharing editor (WEB-12a) on the list.
    await untilCached(page, id.account_id, listId);
    await go(page, `/tasks/lists/${listId}`);
    await page
      .getByRole("button", { name: "Sharing" })
      .click({ timeout: 60_000 });
    const editor = page.getByRole("dialog", { name: /^Sharing/ });
    await expect(editor.locator("[data-audience]")).toBeVisible({
      timeout: 30_000,
    });
    await editor.getByRole("button", { name: "+ Add account grant" }).click();
    await editor
      .getByRole("textbox", { name: "Exact username" })
      .fill(ACCOUNTS[other].username);
    await editor.getByRole("button", { name: "Look up" }).click();
    await editor
      .getByRole("button", { name: `Choose: ${ACCOUNTS[other].username}` })
      .click();
    await editor
      .locator('[data-grant="account"]')
      .getByRole("radio", { name: "Edit" })
      .check();
    await editor.locator("[data-save]").click();
    await expect(editor).toBeHidden({ timeout: 30_000 });
    const readerContext = await browser.newContext();
    try {
      const reader = await bootAs(
        readerContext,
        other,
        `/tasks/lists/${listId}`,
      );
      await untilCached(reader.page, reader.id.account_id, listId);
      await untilCached(reader.page, reader.id.account_id, s);
      await expect(reader.page.locator("[data-list-row]")).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(
        reader.page.locator(`[data-list-task="${s}"]`),
      ).toBeVisible();
      // The reader's count is what they can see (1), not the list's two references.
      await expect(
        reader.page.locator(`[data-list-link="${listId}"] [data-list-count]`),
      ).toHaveAttribute("data-list-count", "1");
      // Nothing of P on the reader's device: no row, no id in the list value, nothing in the page or the picker.
      for (const store of [
        "cache",
        "drafts",
        "draft_commands",
        "pending_effects",
        "resource_versions",
      ]) {
        const text = JSON.stringify(
          await rowsOf(reader.page, reader.id.account_id, store),
        );
        expect(text.includes(p), `P's id in ${store}`).toBe(false);
        expect(text.includes(privateTitle), `P's title in ${store}`).toBe(
          false,
        );
      }
      const listRow = (
        await rowsOf(reader.page, reader.id.account_id, "cache")
      ).find((r) => r.id === listId) as unknown as ListProjection;
      expect(listRow.value.task_ids).toEqual([s]);
      expect(await reader.page.content()).not.toContain(privateTitle);
      await reader.page
        .getByRole("button", { name: "Add task to list" })
        .click();
      await expect(reader.page.getByRole("dialog")).toBeVisible();
      await expect(reader.page.getByRole("dialog")).not.toContainText(
        privateTitle,
      );
      await reader.page.keyboard.press("Escape");
      // The reader removes the task they can see: the owner's list keeps P.
      await reader.page
        .getByRole("button", { name: `Remove I-LS2 shared ${stamp}` })
        .click();
      await sendQueue(reader.page);
      await expect
        .poll(
          async () => (await serverList(page, id, listId))?.value.task_ids,
          { timeout: 60_000 },
        )
        .toEqual([p]);
    } finally {
      await readerContext.close();
    }
  });
});

test.describe("I-LS3: the cap counts a task the reader cannot see (L10)", () => {
  test("99 visible + 1 private: the reader's add is refused 503 slice_capacity, not applied; the owner sees 100 and Add disabled", async ({
    context,
    browser,
    provokes,
  }) => {
    provokes(503);
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const bob = await accountIdOf(page, id, ACCOUNTS[other].username);
    const shared = [];
    for (let i = 0; i < 99; i += 1)
      shared.push(
        await makeTask(page, id, `I-LS3 ${stamp} ${i}`, [
          { kind: "account", id: bob, edit: false },
        ]),
      );
    const hidden = await makeTask(page, id, `I-LS3 hidden ${stamp}`);
    const listId = await makeList(
      page,
      id,
      `I-LS3 ${stamp}`,
      [...shared, hidden],
      [{ kind: "account", id: bob, edit: true }],
    );
    const readerContext = await browser.newContext();
    try {
      const reader = await bootAs(
        readerContext,
        other,
        `/tasks/lists/${listId}`,
      );
      const mine = await makeTask(
        reader.page,
        reader.id,
        `I-LS3 reader's ${stamp}`,
      );
      await untilCached(reader.page, reader.id.account_id, listId);
      await untilCached(reader.page, reader.id.account_id, mine);
      await expect(reader.page.locator("[data-list-row]")).toHaveCount(99, {
        timeout: 60_000,
      });
      await reader.page
        .getByRole("button", { name: "Add task to list" })
        .click();
      await reader.page
        .getByRole("dialog")
        .getByLabel("Search your tasks")
        .fill(`reader's ${stamp}`);
      await pickerBox(reader.page, mine).check({ timeout: 30_000 });
      await reader.page
        .getByRole("dialog")
        .getByRole("button", { name: "Add selected" })
        .click();
      await expect(reader.page.getByRole("dialog")).toBeHidden({
        timeout: 30_000,
      });
      await sendQueue(reader.page);
      await expect
        .poll(
          async () =>
            (await queue(reader.page, reader.id.account_id)).map((d) => [
              d.kind,
              d.status,
            ]),
          { timeout: 60_000 },
        )
        .toEqual([["list_item", "blocked"]]);
      await expect(reader.page.locator("[data-list-refused]")).toContainText(
        "this list is full",
        { timeout: 30_000 },
      );
      await expect(reader.page.locator("[data-list-row]")).toHaveCount(99);
      expect((await serverList(page, id, listId))?.value.task_ids).toHaveLength(
        100,
      );
      await go(reader.page, "/sync?tab=conflicts");
      await expect(
        reader.page.getByRole("button", { name: /Retry/ }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        reader.page.getByRole("button", { name: /Discard/ }).first(),
      ).toBeVisible();
    } finally {
      await readerContext.close();
    }
    // The owner sees all 100 and cannot add more.
    await untilCached(page, id.account_id, listId);
    await go(page, `/tasks/lists/${listId}`);
    await expect(page.locator("[data-list-row]")).toHaveCount(100, {
      timeout: 60_000,
    });
    await expect(
      page.getByRole("button", { name: "Add task to list" }),
    ).toBeDisabled();
  });
});

test.describe("I-LS4: offline create and add, the create's answer lost (L14)", () => {
  test("replayed with the same key: exactly one list, holding the task, under the client's id", async ({
    context,
    provokes,
  }) => {
    provokes(502);
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const t1 = await makeTask(page, id, `I-LS4 task ${stamp}`);
    await untilCached(page, id.account_id, t1);
    // The defaults are read online when the dialog mounts, then the act is offline.
    await page
      .getByRole("button", { name: "+ New list" })
      .click({ timeout: 60_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            (a) =>
              window.__atlasData?.defaultsRecord(a).then((r) => r !== null),
            id.account_id,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await goOffline(page);
    await page.getByRole("dialog").getByLabel("Name").fill(`I-LS4 ${stamp}`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create list" })
      .click();
    await expect(page.locator("[data-list-projected]")).toBeVisible({
      timeout: 30_000,
    });
    const listId = (await page
      .locator("[data-list-detail]")
      .getAttribute("data-list-detail")) as string;
    await page.getByRole("button", { name: "Add task to list" }).click();
    await pickerBox(page, t1).check({ timeout: 30_000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add selected" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/task-commands`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    await goOnline(page);
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.value.task_ids, {
        timeout: 60_000,
      })
      .toEqual([t1]);
    const all = (await call(page, id, "GET", "/lists?archived=false&limit=200"))
      .body as { items: ListProjection[] };
    expect(all.items.filter((l) => l.label === `I-LS4 ${stamp}`)).toHaveLength(
      1,
    );
    expect((await serverList(page, id, listId))?.version).toBe(2);
    const log = (await proxy.log()).filter(
      (e) => e.path === `${API}/task-commands`,
    );
    expect(log.length).toBeGreaterThanOrEqual(3);
    await proxy.removeRule(rule.id);
  });
});

test.describe("I-LS5: another device's rename makes a queued add a version conflict (L4, L15)", () => {
  test("/sync resends it on the reviewed version (the real GET /lists walk); a following add applies without a conflict", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const t1 = await makeTask(page, id, `I-LS5 one ${stamp}`);
    const t2 = await makeTask(page, id, `I-LS5 two ${stamp}`);
    const listId = await makeList(page, id, `I-LS5 ${stamp}`, []);
    await untilCached(page, id.account_id, listId);
    await untilCached(page, id.account_id, t1);
    await untilCached(page, id.account_id, t2);
    await go(page, `/tasks/lists/${listId}`);
    await goOffline(page);
    await page
      .getByRole("button", { name: "Add task to list" })
      .click({ timeout: 60_000 });
    await pickerBox(page, t1).check({ timeout: 30_000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add selected" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
    // Another device renames the list first (version 1 -> 2).
    const before = await serverList(page, id, listId);
    await post(
      page,
      id,
      "/task-commands",
      lists
        .editList({
          listId,
          name: `I-LS5 elsewhere ${stamp}`,
          policyVersion: before?.policy_version as number,
        })
        .build({ [listId]: 1 }).command,
    );
    await goOnline(page);
    await sendQueue(page);
    await expect
      .poll(
        async () =>
          (await queue(page, id.account_id)).map((d) => [d.kind, d.status]),
        { timeout: 60_000 },
      )
      .toEqual([["list_item", "version_conflict"]]);
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Details: List change/ })
      .click({ timeout: 60_000 });
    const item = page.getByRole("dialog");
    const resend = item
      .getByRole("button", { name: /Resend as a new operation|Save as new/ })
      .first();
    await expect(resend).toBeEnabled({ timeout: 30_000 });
    await resend.click();
    await expect(item).toBeHidden({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.value.task_ids, {
        timeout: 60_000,
      })
      .toEqual([t1]);
    await untilCached(page, id.account_id, listId, (r) => r.version === 3);
    await go(page, `/tasks/lists/${listId}`);
    await page
      .getByRole("button", { name: "Add task to list" })
      .click({ timeout: 60_000 });
    await pickerBox(page, t2).check({ timeout: 30_000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add selected" })
      .click();
    await sendQueue(page);
    await expect
      .poll(
        async () =>
          sorted((await serverList(page, id, listId))?.value.task_ids ?? []),
        { timeout: 60_000 },
      )
      .toEqual(sorted([t1, t2]));
    expect(
      (await queue(page, id.account_id)).filter(
        (d) => d.status === "version_conflict",
      ),
    ).toEqual([]);
  });
});

test.describe("I-LS6: a sharing change makes a queued rename a Q1 conflict (L13)", () => {
  test("the rename built on the old policy version is refused 409 conflict; resent from /sync on the new one, applied", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const bob = await accountIdOf(page, id, ACCOUNTS[other].username);
    const listId = await makeList(page, id, `I-LS6 ${stamp}`, []);
    await untilCached(page, id.account_id, listId);
    await go(page, `/tasks/lists/${listId}`);
    await goOffline(page);
    await page
      .getByRole("button", { name: "Rename" })
      .click({ timeout: 60_000 });
    await page
      .getByRole("dialog")
      .getByLabel("Name")
      .fill(`I-LS6 renamed ${stamp}`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
    const before = await serverList(page, id, listId);
    await post(page, id, "/management-commands", {
      commands: [
        {
          kind: "replace_policy",
          id: listId,
          expected_version: before?.policy_version,
          policy: {
            grants: [{ kind: "account", id: bob, edit: false }],
            exclude_accounts: [],
          },
        },
      ],
    });
    await goOnline(page);
    await sendQueue(page);
    await expect
      .poll(
        async () =>
          (await queue(page, id.account_id)).map((d) => [d.kind, d.status]),
        { timeout: 60_000 },
      )
      .toEqual([["edit_list", "version_conflict"]]);
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Details: List name change/ })
      .click({ timeout: 60_000 });
    const item = page.getByRole("dialog");
    const resend = item
      .getByRole("button", { name: /Resend as a new operation|Save as new/ })
      .first();
    await expect(resend).toBeEnabled({ timeout: 30_000 });
    await resend.click();
    await expect(item).toBeHidden({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.label, {
        timeout: 60_000,
      })
      .toBe(`I-LS6 renamed ${stamp}`);
  });
});

test.describe("I-LS7: archive and restore through the UI (L12)", () => {
  test("GET /lists?archived=true then false", async ({ context }) => {
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    const listId = await makeList(page, id, `I-LS7 ${stamp}`, []);
    await untilCached(page, id.account_id, listId);
    await go(page, `/tasks/lists/${listId}`);
    await page
      .getByRole("button", { name: "Archive" })
      .click({ timeout: 60_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.archived, {
        timeout: 60_000,
      })
      .toBe(true);
    const archived = (
      await call(page, id, "GET", "/lists?archived=true&limit=200")
    ).body as { items: ListProjection[] };
    expect(archived.items.map((l) => l.id)).toContain(listId);
    await untilCached(page, id.account_id, listId, (r) => r.archived === true);
    await page
      .getByRole("button", { name: "Restore" })
      .click({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.archived, {
        timeout: 60_000,
      })
      .toBe(false);
    const active = (
      await call(page, id, "GET", "/lists?archived=false&limit=200")
    ).body as { items: ListProjection[] };
    expect(active.items.map((l) => l.id)).toContain(listId);
  });
});

test.describe("I-LS8: a real defaults_changed for a queued create (L2, L6)", () => {
  test("captured under R1, refused when the list defaults move, reviewed and confirmed in /sync, created once", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const stamp = Date.now() % 100_000;
    await page
      .getByRole("button", { name: "+ New list" })
      .click({ timeout: 60_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            (a) =>
              window.__atlasData?.defaultsRecord(a).then((r) => r !== null),
            id.account_id,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await goOffline(page);
    await page.getByRole("dialog").getByLabel("Name").fill(`I-LS8 ${stamp}`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create list" })
      .click();
    await expect(page.locator("[data-list-projected]")).toBeVisible({
      timeout: 30_000,
    });
    const listId = (await page
      .locator("[data-list-detail]")
      .getAttribute("data-list-detail")) as string;
    const templates = await call(page, id, "GET", "/defaults/templates");
    await post(page, id, "/management-commands", {
      commands: [
        {
          kind: "set_defaults",
          household_id: null,
          resource_kind: "list",
          expected_version: (templates.body as { list: { version: number } })
            .list.version,
          template: { kind: "private" },
        },
      ],
    });
    await goOnline(page);
    await sendQueue(page);
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Review sharing/ })
      .click({ timeout: 60_000 });
    const review = page.getByRole("dialog", { name: "Review sharing" });
    await expect(review).toContainText("Sharing defaults have changed", {
      timeout: 30_000,
    });
    await review.locator("[data-confirm]").click();
    await expect(review).toBeHidden({ timeout: 30_000 });
    await sendQueue(page);
    await expect
      .poll(async () => (await serverList(page, id, listId))?.label, {
        timeout: 60_000,
      })
      .toBe(`I-LS8 ${stamp}`);
    const all = (await call(page, id, "GET", "/lists?archived=false&limit=200"))
      .body as { items: ListProjection[] };
    expect(all.items.filter((l) => l.label === `I-LS8 ${stamp}`)).toHaveLength(
      1,
    );
  });
});

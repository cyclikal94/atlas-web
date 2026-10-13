import type { BrowserContext, Page, Route } from "@playwright/test";
import { serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  atlasError,
  dataPage,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";
import { expect, pressTab, runAxe, test } from "./helpers";

/**
 * E-CAL1 to E-CAL6 (WEB-13a): the Calendars screen in a real engine, through the PRODUCTION composition (`/__session`: the production
 * session, its adapters, the protected tree with its `DataProvider` and the application's command registry, Dexie and real IndexedDB),
 * with the network stubbed by `page.route` (`/me` and `/sessions` served, so nothing hot-loops) and the fixture-only test leader of the
 * data harness sending what the screen queued (the production leader of WEB-09b is not used here). FIXTURE evidence: there is no backend
 * behind any of it (the I-CAL specs run the same journeys against the released one).
 */
const API = "/api/experimental/v1";
const ROUTE = "/__session?route=%2Fsettings%2Fcalendars";
const SOURCE = "00000000-0000-4000-8000-00000000ca11";
const SENTINEL = "sentinel-e-cal-4242";

interface Wire {
  method: string;
  path: string;
  key: string | null;
  body: string;
  /**
   * Revision 4: the test's phase when the request ARRIVED (`CalendarStub.phase`): `open` while `calendarsPage` waits for the screen's
   * first read of the live list (its observation of refresh activity, D-13a-13), then `test`, or whatever the test names next. Reads
   * are counted per phase, so a read of one purpose is never counted as another's.
   */
  phase: string;
  /** When it arrived (`Date.now()`). */
  at: number;
}
type Answer =
  | { status: number; body: unknown }
  | { abort: true }
  /** Revision 4: answered only once the promise settles (a request that has arrived and is held). */
  | { wait: Promise<{ status: number; body: unknown }> }
  | ((wire: Wire) => { status: number; body: unknown } | { abort: true });

/** The calendar endpoints, scripted: every request recorded; each path answers from its own queue, then its default. */
interface CalendarStub {
  wire: Wire[];
  answers: Map<string, Answer[]>;
  /** What `GET /calendar-sources` lists (each item a projection with the read-time flag). */
  live: Array<Record<string, unknown>>;
  calendarLinks: boolean;
  /** The phase recorded on each request as it arrives (revision 4). */
  phase: string;
}

async function stubCalendars(context: BrowserContext): Promise<CalendarStub> {
  const stub: CalendarStub = {
    wire: [],
    answers: new Map(),
    live: [],
    calendarLinks: true,
    phase: "open",
  };
  let revision = 200;
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(API, "");
    const wire: Wire = {
      method: request.method(),
      path,
      key: request.headers()["idempotency-key"] ?? null,
      body: request.postData() ?? "",
      phase: stub.phase,
      at: Date.now(),
    };
    stub.wire.push(wire);
    const queue = stub.answers.get(path) ?? [];
    let next = queue.shift();
    if (typeof next === "function") next = next(wire);
    if (next !== undefined && "wait" in next) next = await next.wait;
    if (next === undefined) {
      if (path === "/notification-capabilities")
        next = {
          status: 200,
          body: {
            calendar_links: stub.calendarLinks,
            ntfy: false,
            web_push: false,
            native_local: false,
            apns: false,
            fcm: false,
            vapid_public_key: null,
          },
        };
      else if (path === "/calendar-sources")
        next = { status: 200, body: { items: stub.live, next_after: null } };
      else {
        revision += 1;
        next = { status: 200, body: { revision } };
      }
    }
    if ("abort" in next) return route.abort("connectionreset");
    return route.fulfill({
      status: next.status,
      contentType: "application/json",
      body:
        typeof next.body === "string" ? next.body : JSON.stringify(next.body),
    });
  };
  await context.route(`**${API}/calendar-commands`, handle);
  await context.route(`**${API}/calendar-sources`, handle);
  await context.route(`**${API}/calendar-sources?*`, handle);
  await context.route(`**${API}/calendar-sources/*/refresh`, handle);
  await context.route(`**${API}/calendar-sources/*/import`, handle);
  await context.route(`**${API}/notification-capabilities`, handle);
  return stub;
}

const projection = (over: Record<string, unknown> = {}) => ({
  id: SOURCE,
  kind: "calendar_source",
  parent_id: null,
  label: "Work rota",
  value: {
    health: "healthy",
    last_success: 1_790_000_000,
    coverage_start: null,
    coverage_end: null,
    timezone: "Europe/London",
  },
  version: 2,
  can_edit: true,
  archived: false,
  ...over,
});

/** A booted Calendars page (the production composition), with the network stubbed and identity reads served. */
async function calendarsPage(
  context: BrowserContext,
  options: { database?: boolean; cache?: Array<Record<string, unknown>> } = {},
) {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  const cal = await stubCalendars(context);
  await seedSettled(context);
  if (options.database !== false) {
    // The account's database exists BEFORE the tree looks for it (the tree opens only a database that exists, and nothing tells it
    // when the fixture leader creates one later): a data-harness page creates it, in the delta phase, and is closed before boot.
    const setup = await dataPage(context);
    await setup.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(a);
      const opened = await data.open(a, { create: true });
      if (opened !== "created" && opened !== "opened")
        throw new Error(`open: ${opened}`);
      await data.seedDelta(a, "cursor-0");
      data.close(a);
    }, ACCOUNT);
    await setup.close();
  }
  const page = await context.newPage();
  await page.goto(ROUTE);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  await expect(
    page.getByRole("heading", { level: 1, name: "Calendar sources" }),
  ).toBeVisible();
  if (options.database === false)
    await untilTreeSettled(page, { connections: 0 });
  else {
    await untilTreeSettled(page, { connections: 2 });
    // The fixture leader binds the same database (it sends what the screen queues once `beginOutbox` is called).
    await startOutbox(page, ACCOUNT, { start: false });
    await untilTreeSettled(page, { connections: 2 });
    if (options.cache) {
      await page.evaluate(
        ({ a, rows }) =>
          window.__atlasData?.put(
            a,
            "cache",
            rows.map((row) => ({ ...row, kind_date: null })),
          ),
        { a: ACCOUNT, rows: options.cache },
      );
      // Revision 4 (D-13a-13): the screen reads the live list for the sources it lists as it shows them. That read is answered (by
      // `cal.live`: empty here, so nothing is seen running) before the test arms any answer of its own, so it never takes one meant for
      // a later read; it is recorded in the `open` phase.
      for (const row of options.cache)
        await expect(
          page.locator(`[data-source-row="${String(row.id)}"]`),
        ).toHaveAttribute("data-observation", OBSERVED);
    }
  }
  cal.phase = "test";
  return { page, net, cal };
}

/** A row whose observation has had its read (or was stopped). */
const OBSERVED = /^(busy|idle|unknown|unconfirmed|ended)$/;

/** The `GET /calendar-sources` reads that arrived in `phase` (revision 4: the screen's own first read is `open`). */
const liveReads = (cal: CalendarStub, phase = "test") =>
  cal.wire.filter(
    (w) =>
      w.method === "GET" && w.path === "/calendar-sources" && w.phase === phase,
  );

/**
 * The rows of one store of the account database, read through the data harness. A remount of the protected tree (the session's
 * re-check of a `403`, a reload) closes the page's shared connection registry and so the harness's own binding (a fixture trait,
 * WEB-09a): the harness then opens its own handle on the database, which exists, and reads through it.
 */
const rows = (page: Page, store: string) =>
  page.evaluate(
    async ({ a, s }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      try {
        return await data.rows(a, s as never);
      } catch (error) {
        if (!String(error).includes("no open store")) throw error;
        data.setIdentity(a);
        const opened = await data.open(a, { create: false });
        if (opened !== "opened") throw new Error(`open: ${opened}`);
        return await data.rows(a, s as never);
      }
    },
    { a: ACCOUNT, s: store },
  ) as Promise<Array<Record<string, unknown>>>;

const calendarCommands = (cal: CalendarStub) =>
  cal.wire.filter((w) => w.path === "/calendar-commands");

test.describe("E-CAL1: Add source, queued offline, sent once by key, then synced", () => {
  test("queued offline with no secret; a lost response is resent with the SAME key and body; a delta page moves it from pending to the list", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, net, cal } = await calendarsPage(context);
    await expect(page.getByText("No calendars yet.")).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "Add source" }).click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByLabel("Label").fill("Weekend chores");
    await dialog.getByLabel("Timezone").fill("Europe/London");
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    const pending = page.locator("[data-pending-source]");
    await expect(pending).toContainText("Weekend chores");
    await expect(pending).toContainText(
      "Pending — will create when back online",
    );
    const [draft] = (await rows(page, "drafts")) as Array<{
      local_id: string;
      endpoint: string;
      kind: string;
      target_resource_ids: string[];
    }>;
    expect(draft).toMatchObject({
      endpoint: "/calendar-commands",
      kind: "create_source",
    });
    const id = draft?.target_resource_ids[0] as string;
    expect(calendarCommands(cal)).toEqual([]);

    // Back online, the leader sends it; the first answer is lost after the server applied it.
    cal.answers.set("/calendar-commands", [{ abort: true }]);
    await context.setOffline(false);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(() => calendarCommands(cal).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    const [first, second] = calendarCommands(cal);
    expect(first?.key).toBe(draft?.local_id);
    expect(second?.key).toBe(first?.key);
    expect(second?.body).toBe(first?.body);
    expect(JSON.parse(first?.body ?? "")).toEqual({
      command: {
        kind: "create_source",
        id,
        label: "Weekend chores",
        timezone: "Europe/London",
      },
    });
    await expect
      .poll(async () =>
        ((await rows(page, "drafts")) as Array<{ status: string }>).map(
          (d) => d.status,
        ),
      )
      .toEqual(["acknowledged"]);
    await expect(pending).toContainText("Saving — will confirm on next sync");

    // A delta page publishes the source: it leaves "Waiting to be created" and appears once, from the cache.
    net.script.push(() => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [
          {
            revision: 300,
            changes: [
              {
                kind: "upsert",
                resource: projection({
                  id,
                  label: "Weekend chores",
                  version: 1,
                  value: {
                    health: "pending",
                    last_success: null,
                    coverage_start: null,
                    coverage_end: null,
                    timezone: "Europe/London",
                  },
                }),
              },
            ],
          },
        ],
        next_cursor: "cursor-after-create",
        has_more: false,
      }),
    }));
    await page.evaluate((a) => window.__atlasData?.startSync(a), ACCOUNT);
    await expect(page.locator(`[data-source-row="${id}"]`)).toContainText(
      "Not refreshed yet · Europe/London",
      { timeout: 30_000 },
    );
    await expect(page.locator("[data-pending-source]")).toHaveCount(0);
    await expect(page.getByText("Weekend chores")).toHaveCount(1);
    // Nothing secret was ever stored, and nothing but the create went out.
    expect(
      cal.wire.filter((w) => w.method === "POST").map((w) => w.path),
    ).toEqual(["/calendar-commands", "/calendar-commands"]);
  });
});

const stores = [
  "cache",
  "cache_staging",
  "pending_effects",
  "drafts",
  "draft_commands",
  "resource_versions",
  "materialise_sequences",
  "reminder_firings",
  "form_recovery",
  "sync_state",
];

/** Everything this page could keep or show, as text: every store of the account database, `atlas-auth`, both web storages, Cache Storage keys, the URL and the DOM. */
async function everywhere(page: Page): Promise<string> {
  const data: Record<string, unknown> = {};
  for (const store of stores) data[store] = await rows(page, store);
  const page_ = await page.evaluate(async () => {
    const caches_ =
      typeof caches === "undefined"
        ? []
        : await Promise.all(
            (await caches.keys()).map(async (name) => {
              const cache = await caches.open(name);
              return [name, (await cache.keys()).map((r) => r.url)];
            }),
          );
    return {
      auth: await window.__atlasFixture?.session?.readRecords(),
      local: { ...localStorage },
      session: { ...sessionStorage },
      caches: caches_,
      url: location.href,
      dom: document.documentElement.outerHTML,
    };
  });
  return JSON.stringify({ data, page: page_ });
}

test.describe("E-CAL1: a queued create the cache already holds", () => {
  test("a create still queued here whose source a delta page has ALREADY published (its answer was lost) is listed once, from the cache, and is not shown as pending", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context);
    await expect(page.getByText("No calendars yet.")).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "Add source" }).click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByLabel("Label").fill("Already published");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    const pending = page.locator("[data-pending-source]");
    await expect(pending).toContainText("Already published");
    const [draft] = (await rows(page, "drafts")) as Array<{
      target_resource_ids: string[];
    }>;
    const id = draft?.target_resource_ids[0] as string;
    // The server committed this create on an earlier attempt whose answer was lost, and a delta page brought it in: the draft is still
    // queued here (nothing was sent from this page), and the cache holds its source.
    await page.evaluate(
      ({ a, row }) =>
        window.__atlasData?.put(a, "cache", [{ ...row, kind_date: null }]),
      {
        a: ACCOUNT,
        row: projection({
          id,
          label: "Already published",
          version: 1,
          value: {
            health: "pending",
            last_success: null,
            coverage_start: null,
            coverage_end: null,
            timezone: "UTC",
          },
        }),
      },
    );
    await expect(page.locator(`[data-source-row="${id}"]`)).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(page.getByText("Already published")).toHaveCount(1);
    expect(
      ((await rows(page, "drafts")) as Array<{ status: string }>).map(
        (d) => d.status,
      ),
    ).toEqual(["queued"]);
    expect(calendarCommands(cal)).toEqual([]);
    await context.setOffline(false);
  });
});

test.describe("E-CAL2: queued settings, ordered behind the create, and a conflict reviewed", () => {
  test("settings changes carry no connection or disconnect, the pending source's change waits for its create, and Review REPLACES a conflicted change", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
    await context.setOffline(true);
    // A pending source, and a settings change against it.
    await page.getByRole("button", { name: "Add source" }).click();
    let dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByLabel("Label").fill("Gym");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Manage Gym" }).click();
    dialog = page.getByRole("dialog", { name: "Manage — Gym" });
    await dialog.getByLabel("Timezone").fill("Asia/Tokyo");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    // A settings change against the cached source: turned off.
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByLabel("Enabled").uncheck();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toContainText("Queued — will apply once synced");
    await expect(row).toContainText("Turned off");
    expect(calendarCommands(cal)).toEqual([]);

    cal.answers.set("/calendar-commands", [
      { status: 200, body: { revision: 1 } },
      { status: 200, body: { revision: 2 } },
      { status: 409, body: JSON.parse(atlasError("conflict")) },
    ]);
    await context.setOffline(false);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(() => calendarCommands(cal).length, { timeout: 30_000 })
      .toBe(3);
    const bodies = calendarCommands(cal).map(
      (w) => JSON.parse(w.body).command as Record<string, unknown>,
    );
    expect(bodies.map((b) => b.kind)).toEqual([
      "create_source",
      "configure_source",
      "configure_source",
    ]);
    expect(bodies[1]).toMatchObject({
      id: bodies[0]?.id,
      expected_version: 1,
      timezone: "Asia/Tokyo",
      enabled: true,
    });
    expect(bodies[2]).toEqual({
      kind: "configure_source",
      id: SOURCE,
      expected_version: 2,
      timezone: "Europe/London",
      enabled: false,
    });
    for (const body of bodies) {
      expect(body).not.toHaveProperty("connection");
      expect(body).not.toHaveProperty("disconnect");
      expect(body).not.toHaveProperty("initial_policy");
    }
    // The conflict needs a decision; Review opens Manage, and Save there supersedes the conflicted draft.
    await expect(row).toContainText("Needs a decision", { timeout: 15_000 });
    const conflicted = calendarCommands(cal)[2]?.key;
    await row.getByRole("button", { name: "Review" }).click();
    dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByLabel("Timezone").fill("Europe/Paris");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    // The fixture leader is woken by saves of its own facade only; the screen's save posts a hint (WEB-09b's leader wakes on it).
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(() => calendarCommands(cal).length, { timeout: 30_000 })
      .toBe(4);
    const replacement = calendarCommands(cal)[3];
    expect(replacement?.key).not.toBe(conflicted);
    expect(JSON.parse(replacement?.body ?? "").command).toMatchObject({
      kind: "configure_source",
      id: SOURCE,
      timezone: "Europe/Paris",
    });
    const drafts = (await rows(page, "drafts")) as Array<{
      local_id: string;
      status: string;
    }>;
    expect(drafts.some((d) => d.local_id === conflicted)).toBe(false);
  });
});

test.describe("E-CAL3: the online-only connection forms keep secrets out of everything", () => {
  test("disabled offline; an uncertain Link is retried with the SAME pair and settled by Check; Replace sends the connection; no secret is stored, shown or kept, before or after a reload", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const console_: string[] = [];
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    page.on("console", (message) => console_.push(message.text()));
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
    await context.setOffline(true);
    const link = page.getByRole("button", { name: "Link a calendar…" });
    await expect(link).toBeDisabled();
    await expect(page.getByText("Needs a connection").first()).toBeVisible();
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    let dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await expect(
      dialog.getByRole("button", { name: "Replace…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Remove…" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await context.setOffline(false);
    await expect(link).toBeEnabled();

    // Link: lost, then refused for the address AFTER the uncertain attempt (still uncertain), then Check finds it.
    cal.answers.set("/calendar-commands", [
      { abort: true },
      { status: 422, body: JSON.parse(atlasError("outbound_denied")) },
    ]);
    await link.click();
    dialog = page.getByRole("dialog", { name: "Link a calendar…" });
    await dialog.getByLabel("Label").fill("Rota feed");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog
      .getByLabel("URL (required)")
      .fill(`https://feed.example/${SENTINEL}.ics`);
    await dialog
      .getByLabel("Bearer token (optional)")
      .fill(`token-${SENTINEL}`);
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(
      dialog.getByText("Couldn't save — check your connection and try again"),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => calendarCommands(cal).length).toBe(2);
    const [first, second] = calendarCommands(cal);
    expect(second?.key).toBe(first?.key);
    expect(second?.body).toBe(first?.body);
    const linked = JSON.parse(first?.body ?? "").command;
    expect(linked).toMatchObject({
      kind: "create_source",
      connection: {
        url: `https://feed.example/${SENTINEL}.ics`,
        bearer: `token-${SENTINEL}`,
      },
    });
    await expect(
      dialog.getByText(
        "This server isn't allowed to fetch calendars from that address.",
      ),
    ).toHaveCount(0);
    cal.live = [
      projection({
        id: linked.id,
        label: "Rota feed",
        value: {
          health: "pending",
          timezone: "UTC",
          refresh_in_progress: false,
        },
      }),
    ];
    await dialog.getByRole("button", { name: "Check" }).click();
    await expect(dialog).toBeHidden();
    // The secret went on the wire for the direct command, and nowhere else.
    expect(await everywhere(page)).not.toContain(SENTINEL);

    // Replace on the cached source: an empty form, the connection sent with the current settings.
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByRole("button", { name: "Replace…" }).click();
    await expect(dialog.getByLabel("URL (required)")).toHaveValue("");
    await dialog
      .getByLabel("URL (required)")
      .fill(`https://feed.example/new-${SENTINEL}.ics`);
    await dialog.getByRole("button", { name: "Replace connection" }).click();
    await expect.poll(() => calendarCommands(cal).length).toBe(3);
    expect(JSON.parse(calendarCommands(cal)[2]?.body ?? "").command).toEqual({
      kind: "configure_source",
      id: SOURCE,
      expected_version: 2,
      timezone: "Europe/London",
      enabled: true,
      connection: {
        url: `https://feed.example/new-${SENTINEL}.ics`,
        bearer: null,
      },
    });
    // A refused attempt shows the field's own words and keeps nothing either.
    await dialog.getByRole("button", { name: "Replace…" }).click();
    cal.answers.set("/calendar-commands", [
      { status: 422, body: JSON.parse(atlasError("invalid_endpoint")) },
    ]);
    await dialog
      .getByLabel("URL (required)")
      .fill(`https://feed.example/bad-${SENTINEL}.ics`);
    await dialog.getByRole("button", { name: "Replace connection" }).click();
    await expect(
      dialog.getByText("Atlas can't fetch a calendar from that address."),
    ).toBeVisible();
    expect(await everywhere(page)).not.toContain(SENTINEL);
    // A reload drops the form with everything typed in it.
    await page.goto(ROUTE);
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
    expect(await everywhere(page)).not.toContain(SENTINEL);
    expect(console_.join("\n")).not.toContain(SENTINEL);
  });
});

/** Presses Refresh on the cached source and returns the refresh requests seen so far. */
const refreshes = (cal: CalendarStub) =>
  cal.wire.filter((w) => w.path === `/calendar-sources/${SOURCE}/refresh`);

test.describe("E-CAL4: the manual refresh (online-only, never queued; B8 causes)", () => {
  test("409 refresh_in_progress is retried with the SAME key after 5 s and ends as refreshed; a new press mints a new key", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      { status: 409, body: JSON.parse(atlasError("refresh_in_progress")) },
    ]);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect(row).toContainText("Refreshing…");
    await expect(row).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 15_000 },
    );
    const [a, b] = refreshes(cal);
    expect(b?.key).toBe(a?.key);
    expect(a?.body).toBe("");
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect.poll(() => refreshes(cal).length).toBe(3);
    expect(refreshes(cal)[2]?.key).not.toBe(a?.key);
    // A refresh is never stored.
    expect(await rows(page, "drafts")).toEqual([]);
  });

  test("each cause's words and action, with no automatic retry: 1, 3, 6a, 6b and an unreadable feed", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    const cases: Array<[number, string, string, string | null]> = [
      [
        422,
        "connection_unavailable",
        "This source needs its connection details re-entered.",
        "Update connection",
      ],
      [
        503,
        "integration_unconfigured",
        "This server can't process calendar connections right now — contact your administrator.",
        null,
      ],
      [
        422,
        "invalid_value",
        "This source is turned off — turn it back on to resume refreshing.",
        "Turn on",
      ],
      [
        404,
        "not_found",
        "This calendar source is no longer available to you.",
        null,
      ],
      [
        422,
        "invalid_ics",
        "This calendar's feed couldn't be read: it isn't a valid calendar file. Your existing events are unchanged.",
        null,
      ],
    ];
    for (const [status, code, words, action] of cases) {
      const before = refreshes(cal).length;
      cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
        { status, body: JSON.parse(atlasError(code)) },
      ]);
      await row.getByRole("button", { name: "Refresh Work rota" }).click();
      await expect(row).toContainText(words);
      if (action)
        await expect(row.getByRole("button", { name: action })).toBeVisible();
      // No automatic retry: one request, and still one a moment later.
      await page.waitForTimeout(1_500);
      expect(refreshes(cal).length).toBe(before + 1);
    }
  });

  test("cause 4 re-reads refresh_in_progress and does not retry; cause 5 with nothing running retries ONCE with the same key", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    cal.live = [
      projection({
        value: {
          health: "healthy",
          timezone: "Europe/London",
          refresh_in_progress: false,
        },
      }),
    ];
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      {
        status: 409,
        body: {
          ...JSON.parse(atlasError("stale_refresh")),
          reason: "generation_changed",
        },
      },
    ]);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect(row).toContainText(
      "A newer change replaced this refresh — refresh again to get the latest.",
    );
    expect(refreshes(cal)).toHaveLength(1);
    // Adapted (revision 4): reads counted per phase; the screen's own first read is the `open` one.
    expect(liveReads(cal, "open")).toHaveLength(1);
    expect(liveReads(cal)).toHaveLength(1);
    // Health was healthy throughout: it is not read as success.
    await expect(row).not.toContainText("Refreshed.");
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      {
        status: 409,
        body: {
          ...JSON.parse(atlasError("stale_refresh")),
          reason: "lease_expired",
        },
      },
      { status: 200, body: { revision: 9 } },
    ]);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect(row).toContainText(
      "Refreshed. New events appear after the next sync.",
    );
    const [, second, third] = refreshes(cal);
    expect(third?.key).toBe(second?.key);
    expect(refreshes(cal)).toHaveLength(3);
  });

  test("a 502 is not success whatever health says; offline mid-retry stops it and NOTHING is sent on reconnect; a reload mid-uncertainty sends nothing", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      { status: 502, body: JSON.parse(atlasError("fetch_failed")) },
    ]);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect.poll(() => refreshes(cal).length).toBe(1);
    await expect(row).not.toContainText("Refreshed.");
    await context.setOffline(true);
    await expect(row).toContainText("Needs a connection");
    await page.waitForTimeout(2_000);
    await context.setOffline(false);
    // The retry would have been at 10 s: wait past it.
    await page.waitForTimeout(12_000);
    expect(refreshes(cal)).toHaveLength(1);
    // An uncertain refresh at reload is not resent (D-13a-13).
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      { status: 409, body: JSON.parse(atlasError("refresh_in_progress")) },
    ]);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect.poll(() => refreshes(cal).length).toBe(2);
    cal.phase = "reloaded";
    await page.goto(ROUTE);
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
    await page.waitForTimeout(7_000);
    expect(refreshes(cal)).toHaveLength(2);
    // Revision 4 (D-13a-13, S5): the new document read the live list once; a list without the source says nothing, so nothing is
    // shown as running.
    expect(liveReads(cal, "reloaded")).toHaveLength(1);
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toHaveAttribute(
      "data-observation",
      "unknown",
    );
    await expect(
      page.locator(`[data-source-row="${SOURCE}"]`),
    ).not.toContainText("Refreshing…");
  });

  test("CH3 / 7(f): 503 temporarily_unavailable is generic: retried with the same key after 10 s", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      { status: 503, body: JSON.parse(atlasError("temporarily_unavailable")) },
    ]);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect(row).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 20_000 },
    );
    const [a, b] = refreshes(cal);
    expect(b?.key).toBe(a?.key);
  });
});

/**
 * The widths of the plan (320, 390, 768, tablet portrait and landscape, 1280). The two phone widths are given the height that shows the
 * whole screen: axe's `target-size` rule measures the UNOBSCURED part of a target at the current scroll position, and a row that ends
 * behind the fixed mobile tab bar at scroll 0 would be reported although scrolling reveals it. Horizontal overflow, 44 px targets and
 * axe are checked at every width as before.
 */
const WIDTHS: Array<{ width: number; height: number }> = [
  { width: 320, height: 1200 },
  { width: 390, height: 1200 },
  { width: 768, height: 1024 },
  { width: 834, height: 1112 },
  { width: 1112, height: 834 },
  { width: 1280, height: 900 },
];

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Every control a person can press in `main` or an open dialog is at least 44 x 44 (the README's touch-target rule). */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const scopes = [
      document.querySelector("main"),
      ...document.querySelectorAll('[role="dialog"]'),
    ].filter(Boolean) as Element[];
    for (const scope of scopes)
      for (const element of scope.querySelectorAll<HTMLElement>(
        'button, a[href], input:not([type="checkbox"]), select, textarea, [role="button"]',
      )) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < 43.5 || rect.height < 43.5)
          out.push(
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
      }
    return out;
  });

for (const scheme of ["dark", "light"] as const)
  test.describe(`E-CAL5: layout, axe and keyboard (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    test(`every width: axe with contrast, 44 px targets, no horizontal scroll; dialogs are sheets below 768 px`, async ({
      context,
    }) => {
      test.setTimeout(120_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [
          projection(),
          projection({
            id: "00000000-0000-4000-8000-00000000ca12",
            label: "Turned-off feed",
            archived: true,
          }),
        ],
      });
      cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
        { status: 422, body: JSON.parse(atlasError("connection_unavailable")) },
      ]);
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      await row.getByRole("button", { name: "Refresh Work rota" }).click();
      await expect(row).toContainText(
        "This source needs its connection details re-entered.",
      );
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        await expect(row).toBeVisible();
        const violations = await runAxe(page);
        expect(
          violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
          `${size.width}`,
        ).toEqual([]);
        expect(await smallTargets(page), `${size.width}`).toEqual([]);
        expect(await overflow(page), `${size.width}`).toBeLessThanOrEqual(0);
        for (const open of ["Manage Work rota", "Link a calendar…"]) {
          await page.getByRole("button", { name: open }).click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          if (open === "Manage Work rota")
            await dialog.getByRole("button", { name: "Replace…" }).click();
          const box = await dialog.boundingBox();
          if (size.width < 768)
            expect(box?.width, `${size.width} sheet`).toBeGreaterThanOrEqual(
              size.width - 1,
            );
          else
            expect(box?.width ?? 0, `${size.width} dialog`).toBeLessThan(
              size.width,
            );
          const inDialog = await runAxe(page);
          expect(
            inDialog.map((v) => [v.id, v.nodes.map((n) => n.target)]),
            `${size.width} ${open}`,
          ).toEqual([]);
          expect(await smallTargets(page), `${size.width} ${open}`).toEqual([]);
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        }
      }
    });
  });

test.describe("E-CAL5: the keyboard journey", () => {
  test("Add source by keyboard alone: focus moves into the dialog, Escape returns it to the opener; disabled controls say why", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page } = await calendarsPage(context, { cache: [projection()] });
    const add = page.getByRole("button", { name: "Add source" });
    await add.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[role="dialog"]') !== null,
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    // Tab order: the dialog's own controls, then its footer.
    const names: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await pressTab(page);
      names.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim() ??
            document.activeElement?.getAttribute("name") ??
            "",
        ),
      );
    }
    expect(names).toEqual(expect.arrayContaining(["Create source", "Cancel"]));
    await page.getByLabel("Label").fill("Keyboard calendar");
    await page.getByLabel("Label").press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-pending-source]")).toContainText(
      "Keyboard calendar",
    );
    await context.setOffline(true);
    const refresh = page.getByRole("button", { name: "Refresh Work rota" });
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAccessibleDescription("Needs a connection");
    await context.setOffline(false);
  });
});

test.describe("E-CAL4: a 403 (the session reclassifies it)", () => {
  test("cause 6b by 403: the outcome is still shown after the session's re-check, and nothing is resent", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      { status: 403, body: JSON.parse(atlasError("forbidden")) },
    ]);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toContainText(
      "This calendar source is no longer available to you.",
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3_000);
    expect(refreshes(cal)).toHaveLength(1);
  });

  test("Remove… refused 403 and Link refused 403: the words outlive the session's re-check (the typed values do not), and nothing is resent", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.answers.set("/calendar-commands", [
      { status: 403, body: JSON.parse(atlasError("forbidden")) },
      { status: 403, body: JSON.parse(atlasError("forbidden")) },
    ]);
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    let dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await dialog.getByRole("button", { name: "Remove connection" }).click();
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row.locator("[data-row-notice]")).toContainText(
      "You no longer have access to make this change.",
      { timeout: 15_000 },
    );
    await page.getByRole("button", { name: "Link a calendar…" }).click();
    dialog = page.getByRole("dialog", { name: "Link a calendar…" });
    await dialog.getByLabel("Label").fill("Not mine");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog
      .getByLabel("URL (required)")
      .fill(`https://feed.example/${SENTINEL}.ics`);
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator('[data-row-notice="link"]')).toContainText(
      "You no longer have access to make this change",
      { timeout: 15_000 },
    );
    await page.waitForTimeout(2_000);
    expect(calendarCommands(cal)).toHaveLength(2);
    expect(await everywhere(page)).not.toContain(SENTINEL);
    await row.getByRole("button", { name: "Dismiss" }).click();
    await expect(row.locator("[data-row-notice]")).toHaveCount(0);
  });
});

test.describe("E-CAL6: lifetime", () => {
  test("leaving the screen mid-retry stops the refresh: nothing more is sent, and coming back starts nothing", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
      { status: 409, body: JSON.parse(atlasError("refresh_in_progress")) },
    ]);
    await page.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect.poll(() => refreshes(cal).length).toBe(1);
    // In-app navigation unmounts the screen (and its refresh controller) while the 5 s retry waits.
    await page
      .getByRole("main")
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await page.waitForTimeout(7_000);
    expect(refreshes(cal)).toHaveLength(1);
    await page.getByRole("link", { name: "Calendars" }).click();
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
    await expect(
      page.locator(`[data-source-row="${SOURCE}"]`),
    ).not.toContainText("Refreshing…");
    await page.waitForTimeout(2_000);
    expect(refreshes(cal)).toHaveLength(1);
  });
});

/**
 * Revision 1 (R1): once an attempt of Replace… or Remove… was uncertain, Retry resends THAT pair whatever the cache learnt meanwhile
 * (the backend looks the key up before it checks the version, so an attempt that landed returns its receipt). The dialog is shown to
 * have taken the newer version (its untouched timezone follows it) before Retry is pressed.
 */
test.describe("E-CAL7: Retry repeats the uncertain connection change", () => {
  const advanced = () =>
    projection({
      version: 3,
      value: {
        health: "pending",
        last_success: 1_790_000_000,
        coverage_start: null,
        coverage_end: null,
        timezone: "UTC",
      },
    });

  for (const change of ["Remove", "Replace"] as const)
    test(`${change}: the answer is lost and the cache moves on; Retry sends the SAME key and body, and its receipt ends the change`, async ({
      context,
    }, info) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      await page.getByRole("button", { name: "Manage Work rota" }).click();
      const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
      await dialog.getByRole("button", { name: `${change}…` }).click();
      cal.answers.set("/calendar-commands", [
        { abort: true },
        { status: 200, body: { revision: 301 } },
      ]);
      if (change === "Replace") {
        await dialog
          .getByLabel("URL (required)")
          .fill(`https://feed.example/${SENTINEL}.ics`);
        await dialog
          .getByRole("button", { name: "Replace connection", exact: true })
          .click();
      } else
        await dialog
          .getByRole("button", { name: "Remove connection", exact: true })
          .click();
      const retry = dialog.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeVisible();
      await page.evaluate(
        async ({ a, row }) => {
          await window.__atlasData?.put(a, "cache", [row]);
        },
        { a: ACCOUNT, row: { ...advanced(), kind_date: null } },
      );
      await expect(dialog.getByLabel("Timezone")).toHaveValue("UTC");
      await retry.click();
      await expect.poll(() => calendarCommands(cal).length).toBe(2);
      const [first, second] = calendarCommands(cal);
      await info.attach("request-pairs", {
        body: JSON.stringify(calendarCommands(cal), null, 2),
        contentType: "application/json",
      });
      expect(second?.key).toBe(first?.key);
      expect(second?.body).toBe(first?.body);
      expect(JSON.parse(first?.body ?? "{}").command).toMatchObject({
        expected_version: 2,
        timezone: "Europe/London",
      });
      await expect(retry).toHaveCount(0);
      // The cache already holds what followed the change (version 3 passes the 2 it was built on): Save is not held back.
      await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
    });
});

/**
 * Revision 1 (R2): an open Manage is cache content. When the cache is invalidated (a recovery), the list goes behind the gate and
 * Manage closes with it; nothing it showed stays on screen. With the cache valid again the list returns and Manage stays closed.
 */
test.describe("E-CAL8: an open Manage follows the cache gate", () => {
  test("the cache is invalidated: Manage (with Remove… open) closes and its source is nowhere on screen; valid again, the list returns", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await expect(
      dialog.getByRole("button", { name: "Remove connection", exact: true }),
    ).toBeVisible();
    const valid = (await rows(page, "sync_state"))[0] as Record<
      string,
      unknown
    >;
    await page.evaluate(
      async ({ a, row }) => {
        await window.__atlasData?.put(a, "sync_state", [row]);
      },
      {
        a: ACCOUNT,
        row: {
          ...valid,
          cache_status: "invalid",
          recovery_generation: Number(valid.recovery_generation ?? 0) + 1,
        },
      },
    );
    await expect(page.locator('[data-cache-gate="refreshing"]')).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-source-row]")).toHaveCount(0);
    await expect(page.getByText("Work rota")).toHaveCount(0);
    await expect(page.getByText("Europe/London")).toHaveCount(0);
    expect(calendarCommands(cal)).toEqual([]);
    await page.evaluate(
      async ({ a, row }) => {
        await window.__atlasData?.put(a, "sync_state", [row]);
      },
      { a: ACCOUNT, row: valid },
    );
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

/** The queued settings changes, in the order they were saved (`created_seq`), joined to their bodies by `local_id`. */
async function queuedSettings(page: Page) {
  const headers = (await rows(page, "drafts")) as Array<{
    local_id: string;
    kind: string;
    created_seq: number;
  }>;
  const bodies = (await rows(page, "draft_commands")) as Array<{
    local_id: string;
    command: { command: Record<string, unknown> };
  }>;
  return headers
    .filter((draft) => draft.kind === "configure_source")
    .sort((a, b) => a.created_seq - b.created_seq)
    .map(
      (draft) =>
        bodies.find((body) => body.local_id === draft.local_id)?.command
          .command,
    );
}

/** A delta page that publishes the source at `version` with `timezone`, through the real sync engine (W1 publishes and retires at once). */
async function publishSource(
  page: Page,
  net: Awaited<ReturnType<typeof stubNetwork>>,
  over: Record<string, unknown>,
) {
  net.script.push(() => ({
    status: 200,
    body: JSON.stringify({
      phase: "delta",
      batches: [
        {
          revision: 400,
          changes: [{ kind: "upsert", resource: projection(over) }],
        },
      ],
      next_cursor: "cursor-after-publication",
      has_more: false,
    }),
  }));
  await page.evaluate((a) => window.__atlasData?.startSync(a), ACCOUNT);
}

const TOKYO = {
  health: "healthy",
  last_success: 1_790_000_000,
  coverage_start: null,
  coverage_end: null,
  timezone: "Asia/Tokyo",
};

test.describe("E-CAL9: Manage opened on a pending source follows it through publication (revision 2, R6)", () => {
  test("the create is sent, receipted, then published at version 4 by a delta page: Manage stays open as the cached source's, and turning it off keeps the PUBLISHED timezone", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, net, cal } = await calendarsPage(context);
    await expect(page.getByText("No calendars yet.")).toBeVisible();
    await page.getByRole("button", { name: "Add source" }).click();
    const add = page.getByRole("dialog", { name: "Add source" });
    await add.getByLabel("Label").fill("Work rota");
    await add.getByLabel("Timezone").fill("Europe/London");
    await add.getByRole("button", { name: "Create source" }).click();
    await expect(add).toBeHidden();
    const pending = page.locator("[data-pending-source]");
    await expect(pending).toContainText("Work rota");
    const id = (await pending.getAttribute("data-pending-source")) as string;
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue(
      "Europe/London",
    );
    await expect(
      dialog.getByRole("button", { name: "Remove…" }),
    ).toBeDisabled();
    // The leader sends the create; the server receipts it.
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(async () =>
        ((await rows(page, "drafts")) as Array<{ status: string }>).map(
          (d) => d.status,
        ),
      )
      .toEqual(["acknowledged"]);
    await publishSource(page, net, {
      id,
      version: 4,
      value: TOKYO,
    });
    await expect(page.locator(`[data-source-row="${id}"]`)).toContainText(
      "Asia/Tokyo",
      { timeout: 30_000 },
    );
    await expect(pending).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue(
      "Asia/Tokyo",
    );
    // Its cached rules: the connection can now be changed (online, nothing waiting).
    await expect(dialog.getByRole("button", { name: "Remove…" })).toBeEnabled();
    await dialog.getByLabel("Enabled", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => queuedSettings(page))
      .toEqual([
        {
          kind: "configure_source",
          id,
          expected_version: 4,
          timezone: "Asia/Tokyo",
          enabled: false,
        },
      ]);
    expect(
      calendarCommands(cal).map((w) => JSON.parse(w.body).command.kind),
    ).toContain("create_source");
  });

  test("control: Manage opened on the cached source, the same publication, the same change", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, net } = await calendarsPage(context, {
      cache: [projection()],
    });
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue(
      "Europe/London",
    );
    await publishSource(page, net, { version: 4, value: TOKYO });
    await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue(
      "Asia/Tokyo",
      { timeout: 30_000 },
    );
    await dialog.getByLabel("Enabled", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => queuedSettings(page))
      .toEqual([
        {
          kind: "configure_source",
          id: SOURCE,
          expected_version: 4,
          timezone: "Asia/Tokyo",
          enabled: false,
        },
      ]);
  });
});

test.describe("E-CAL10: the Enter key is admitted only as Save is (revision 2, R7)", () => {
  test("after Remove, while the cache has not caught up, Enter in Timezone saves nothing; once it has, the same Enter saves ONE change on the new version", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await dialog
      .getByRole("button", { name: "Remove connection", exact: true })
      .click();
    await expect(dialog.locator("[data-connection-panel]")).toHaveCount(0);
    expect(calendarCommands(cal)).toHaveLength(1);
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await expect(
      dialog.getByText("Waiting for your last change to sync"),
    ).toBeVisible();
    const timezone = dialog.getByLabel("Timezone", { exact: true });
    // Every native submission of a form on the page is counted (a submit event is dispatched synchronously by the key press): the
    // outcome of the first Enter is established BEFORE the cache changes. (Changing the cache first would let a save already under way
    // be refused by the observation check, which would hide whether the Enter was admitted at all.)
    await page.evaluate(() => {
      const counter = window as unknown as { __submits?: number };
      counter.__submits = 0;
      document.addEventListener(
        "submit",
        () => {
          counter.__submits = (counter.__submits ?? 0) + 1;
        },
        true,
      );
    });
    const submits = () =>
      page.evaluate(
        () => (window as unknown as { __submits?: number }).__submits ?? 0,
      );
    await timezone.fill("UTC");
    await timezone.press("Enter");
    expect(await submits(), "Enter while Save waits submits nothing").toBe(0);
    expect(await queuedSettings(page)).toEqual([]);
    await expect(dialog).toBeVisible();
    // An explicit submission of the form (the browser's own `requestSubmit`, no submitter) reaches the handler in every engine (WebKit
    // performs no implicit submission here at all): the handler admits nothing. Read one frame later, in the page: a handler that went
    // on would show Save as "Saving…", or Manage would already have closed.
    const explicit = await page.evaluate(async () => {
      const form =
        document.querySelector<HTMLFormElement>("[role=dialog] form");
      form?.requestSubmit();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const save = [
        ...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
      ].find((button) => button.textContent === "Save");
      return {
        dialog: document.querySelector("[role=dialog]") !== null,
        reason:
          document.getElementById(save?.getAttribute("aria-describedby") ?? "")
            ?.textContent ?? null,
      };
    });
    expect(await submits()).toBe(1);
    expect(
      explicit,
      "an explicit submission while Save waits is not admitted",
    ).toEqual({
      dialog: true,
      reason: "Waiting for your last change to sync",
    });
    // The cache catches up with the removal (version 3); Save is offered, and the SAME key press now saves.
    await page.evaluate(
      ({ a, row }) => window.__atlasData?.put(a, "cache", [row]),
      { a: ACCOUNT, row: { ...projection({ version: 3 }), kind_date: null } },
    );
    await expect(save).toBeEnabled();
    await timezone.press("Enter");
    await expect(dialog).toBeHidden();
    expect(await submits()).toBe(2);
    // Exactly one change: the first Enter, pressed while Save waited, queued nothing.
    expect(await queuedSettings(page)).toEqual([
      {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 3,
        timezone: "UTC",
        enabled: true,
      },
    ]);
  });
});

test.describe("E-CAL11: connection details are entered online only (revision 2, R8)", () => {
  for (const form of ["Link a calendar…", "Replace…"] as const)
    test(`${form}: offline the URL and token are disabled with the reason; back online what was entered is still there, nothing was sent, and it sends when asked`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      let dialog = page.getByRole("dialog");
      if (form === "Link a calendar…") {
        await page.getByRole("button", { name: form }).click();
        dialog = page.getByRole("dialog", { name: form });
        await dialog.getByLabel("Label").fill("Rota feed");
      } else {
        await page.getByRole("button", { name: "Manage Work rota" }).click();
        dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
        await dialog.getByRole("button", { name: "Replace…" }).click();
      }
      const url = dialog.getByLabel("URL (required)");
      const bearer = dialog.getByLabel("Bearer token (optional)");
      await url.fill(`https://feed.example/${SENTINEL}.ics`);
      await bearer.fill(`token-${SENTINEL}`);
      await context.setOffline(true);
      for (const field of [url, bearer]) {
        await expect(field).toBeDisabled();
        await expect(field).not.toBeEditable();
        await expect(field).toHaveAccessibleDescription(/Needs a connection/);
      }
      await context.setOffline(false);
      for (const field of [url, bearer]) await expect(field).toBeEnabled();
      await expect(url).toHaveValue(`https://feed.example/${SENTINEL}.ics`);
      await expect(bearer).toHaveValue(`token-${SENTINEL}`);
      expect(calendarCommands(cal)).toEqual([]);
      await dialog
        .getByRole("button", {
          name: form === "Replace…" ? "Replace connection" : "Connect",
          exact: true,
        })
        .click();
      await expect.poll(() => calendarCommands(cal).length).toBe(1);
      expect(
        JSON.parse(calendarCommands(cal)[0]?.body ?? "").command.connection,
      ).toEqual({
        url: `https://feed.example/${SENTINEL}.ics`,
        bearer: `token-${SENTINEL}`,
      });
    });
});

/** A `GET /calendar-sources` page answer. */
const livePage = (
  items: Array<Record<string, unknown>>,
  next: string | null = null,
) => ({ status: 200, body: { items, next_after: next } });

test.describe("E-CAL12: a refresh's live re-read is evidence only for the source it returned (revision 3, R9)", () => {
  for (const reached of [false, true])
    test(`cause 5: the bounded walk (five full pages, each with a continuation) ${reached ? "returns the source, not running: ONE same-key retry (control)" : "never reaches the source: no retry, the cause 5 copy"}`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
        {
          status: 409,
          body: {
            ...JSON.parse(atlasError("stale_refresh")),
            reason: "lease_expired",
          },
        },
        { status: 200, body: { revision: 201 } },
      ]);
      cal.answers.set(
        "/calendar-sources",
        Array.from({ length: 5 }, (_, p) =>
          livePage(
            Array.from({ length: 200 }, (_, i) =>
              reached && p === 2 && i === 100
                ? projection({
                    value: {
                      health: "healthy",
                      last_success: 1_790_000_000,
                      refresh_in_progress: false,
                    },
                  })
                : projection({
                    id: `00000000-0000-4000-8000-${String(1000 + p * 200 + i).padStart(12, "0")}`,
                    label: `Other ${p}-${i}`,
                    value: { health: "healthy", refresh_in_progress: false },
                  }),
            ),
            `00000000-0000-4000-8000-${String(1000 + p * 200 + 199).padStart(12, "0")}`,
          ),
        ),
      );
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      await row.getByRole("button", { name: "Refresh Work rota" }).click();
      await expect(row.locator("[data-refresh]")).not.toHaveAttribute(
        "data-refresh",
        "refreshing",
        { timeout: 15_000 },
      );
      // Adapted (revision 4): reads counted per phase; the screen's own first read is the `open` one.
      expect(liveReads(cal, "open")).toHaveLength(1);
      expect(liveReads(cal), "the walk stops at five pages").toHaveLength(5);
      const sent = refreshes(cal);
      if (reached) {
        await expect(row).toContainText(
          "Refreshed. New events appear after the next sync.",
        );
        expect(sent).toHaveLength(2);
        expect(sent[1]?.key).toBe(sent[0]?.key);
      } else {
        await expect(row).toContainText(
          "Couldn't finish refreshing this source — try again",
        );
        expect(
          sent,
          "a source the read did not return permits no retry",
        ).toHaveLength(1);
      }
    });

  const outcomes = {
    written: {
      title:
        "it wrote its result (last_success moved on): ITS outcome is shown (control)",
      items: [
        projection({
          value: {
            health: "healthy",
            last_success: 1_790_000_900,
            refresh_in_progress: false,
          },
        }),
      ],
      state: "successor_finished",
      words: "The newer refresh finished: it succeeded.",
    },
    gone: {
      title: "the source is missing from the complete list: not finished",
      items: [],
      state: "successor_unconfirmed",
      words:
        "We couldn't confirm that the newer refresh finished — refresh again to check.",
    },
    lapsed: {
      title:
        "only the flag changed (its lease lapsed with no completing write): not finished",
      items: [
        projection({
          value: {
            health: "healthy",
            last_success: 1_790_000_000,
            refresh_in_progress: false,
          },
        }),
      ],
      state: "successor_unconfirmed",
      words:
        "We couldn't confirm that the newer refresh finished — refresh again to check.",
    },
  } as const;
  for (const [name, outcome] of Object.entries(outcomes))
    test(`cause 4: a newer refresh is seen running; 5 s later the read says ${outcome.title} (${name})`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
        {
          status: 409,
          body: {
            ...JSON.parse(atlasError("stale_refresh")),
            reason: "generation_changed",
          },
        },
      ]);
      cal.answers.set("/calendar-sources", [
        livePage([
          projection({
            value: {
              health: "healthy",
              last_success: 1_790_000_000,
              refresh_in_progress: true,
            },
          }),
        ]),
        livePage([...outcome.items]),
      ]);
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      const began = Date.now();
      await row.getByRole("button", { name: "Refresh Work rota" }).click();
      await expect(row.locator("[data-refresh]")).toHaveAttribute(
        "data-refresh",
        outcome.state,
        { timeout: 15_000 },
      );
      // The real 5 s wait between the two reads (SUCCESSOR_POLL_MS) is kept.
      expect(Date.now() - began).toBeGreaterThanOrEqual(5_000);
      await expect(row).toContainText(outcome.words);
      if (outcome.state !== "successor_finished")
        await expect(row).not.toContainText("The newer refresh finished");
      // Adapted (revision 4): reads counted per phase; the screen's own first read is the `open` one.
      expect(liveReads(cal, "open")).toHaveLength(1);
      expect(liveReads(cal)).toHaveLength(2);
      expect(refreshes(cal), "nothing is resent").toHaveLength(1);
    });
});

/**
 * A second tab of the same origin on the Calendars screen (its own production session, protected tree and Dexie), whose OBSERVATION of
 * the other tabs' writes can be held: Dexie tells a page of another page's commit through one `BroadcastChannel`
 * (`x-storagemutated-1`), and this tab's deliveries on that channel alone are kept while `hold()` is in force and delivered, in order, on
 * `release()`. Its own writes, its transactions, the other channels (the session's, `atlas-sync`) and the other tab are untouched. A
 * FIXTURE injection of a schedule (a tab that has not yet re-read what another committed), not of a product fault.
 */
async function peerTab(context: BrowserContext, other: Page): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const Native = window.BroadcastChannel;
    const held: Array<() => void> = [];
    let holding = false;
    class Observed extends Native {
      override set onmessage(fn: ((event: MessageEvent) => unknown) | null) {
        if (this.name !== "x-storagemutated-1" || fn === null) {
          super.onmessage = fn;
          return;
        }
        super.onmessage = (event: MessageEvent) => {
          if (holding) held.push(() => fn.call(this, event));
          else fn.call(this, event);
        };
      }
      override get onmessage() {
        return super.onmessage;
      }
    }
    window.BroadcastChannel = Observed;
    (window as unknown as { __peer: unknown }).__peer = {
      hold() {
        holding = true;
      },
      held: () => held.length,
      release() {
        holding = false;
        for (const deliver of held.splice(0)) deliver();
      },
    };
  });
  await page.goto(ROUTE);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await expect(
    page.getByRole("heading", { level: 1, name: "Calendar sources" }),
  ).toBeVisible();
  await untilTreeSettled(page, { connections: 2 });
  // A page that boots can remount the other tab's tree: both are settled, and both list the source, before anything is opened.
  await untilTreeSettled(other, { connections: 2 });
  for (const tab of [other, page])
    await expect(
      tab.getByRole("button", { name: "Manage Work rota" }),
    ).toBeEnabled();
  return page;
}

const peer = (page: Page, act: "hold" | "release") =>
  page.evaluate(
    (a) =>
      (window as unknown as { __peer: Record<string, () => void> }).__peer[
        a
      ]?.(),
    act,
  );
const heldDeliveries = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __peer: { held(): number } }).__peer.held(),
  );

/** Tab A queues Tokyo for the source through its own Manage. */
async function queueTokyo(a: Page) {
  await a.getByRole("button", { name: "Manage Work rota" }).click();
  const dialog = a.getByRole("dialog", { name: "Manage — Work rota" });
  await dialog.getByLabel("Timezone", { exact: true }).fill("Asia/Tokyo");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => queuedSettings(a))
    .toEqual([
      {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 2,
        timezone: "Asia/Tokyo",
        enabled: true,
      },
    ]);
}

test.describe("E-CAL13: two tabs save the same source (revision 3, design assessment S6)", () => {
  test("tab B has not yet seen tab A's queued Tokyo when it turns the source off and saves: the save is refused as changed, nothing is queued with London; once B sees Tokyo, its change keeps it", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page: a } = await calendarsPage(context, {
      cache: [projection()],
    });
    const b = await peerTab(context, a);
    await b.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = b.getByRole("dialog", { name: "Manage — Work rota" });
    const timezone = dialog.getByLabel("Timezone", { exact: true });
    await expect(timezone).toHaveValue("Europe/London");
    await peer(b, "hold");
    await queueTokyo(a);
    // The hold is in force: B has been told of A's commit and has not delivered it, so it still shows what it read before.
    await expect.poll(() => heldDeliveries(b)).toBeGreaterThan(0);
    await expect(timezone).toHaveValue("Europe/London");
    await dialog.getByLabel("Enabled", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      dialog.getByText(
        "Not saved — this calendar changed while you were saving. Check the values and save again.",
      ),
    ).toBeVisible();
    expect(
      await queuedSettings(a),
      "the save B made on London was refused, not queued",
    ).toEqual([
      {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 2,
        timezone: "Asia/Tokyo",
        enabled: true,
      },
    ]);
    // B now sees A's change: the untouched timezone follows it, B's own change (off) is kept, and saving again keeps Tokyo.
    await peer(b, "release");
    await expect(timezone).toHaveValue("Asia/Tokyo");
    await expect(
      dialog.getByLabel("Enabled", { exact: true }),
    ).not.toBeChecked();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    const queued = await queuedSettings(a);
    expect(queued.at(-1)).toMatchObject({
      kind: "configure_source",
      id: SOURCE,
      timezone: "Asia/Tokyo",
      enabled: false,
    });
    expect(
      queued.filter((c) => c?.timezone === "Europe/London"),
      "never London",
    ).toEqual([]);
  });

  test("control: the same hold with the source unchanged: B's save is queued as it was made", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page: a } = await calendarsPage(context, {
      cache: [projection()],
    });
    const b = await peerTab(context, a);
    await b.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = b.getByRole("dialog", { name: "Manage — Work rota" });
    await peer(b, "hold");
    await dialog.getByLabel("Enabled", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await peer(b, "release");
    await expect
      .poll(() => queuedSettings(a))
      .toEqual([
        {
          kind: "configure_source",
          id: SOURCE,
          expected_version: 2,
          timezone: "Europe/London",
          enabled: false,
        },
      ]);
  });

  test("control: B sees A's queued Tokyo before it saves: its change keeps Tokyo", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page: a } = await calendarsPage(context, {
      cache: [projection()],
    });
    const b = await peerTab(context, a);
    await b.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = b.getByRole("dialog", { name: "Manage — Work rota" });
    const timezone = dialog.getByLabel("Timezone", { exact: true });
    await expect(timezone).toHaveValue("Europe/London");
    await queueTokyo(a);
    await expect(timezone).toHaveValue("Asia/Tokyo");
    await dialog.getByLabel("Enabled", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    const queued = await queuedSettings(a);
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({
      kind: "configure_source",
      id: SOURCE,
      timezone: "Asia/Tokyo",
      enabled: false,
    });
  });
});

/** The source as the live list says it is now, with its lease held or not. */
const leased = (held: boolean) =>
  projection({
    value: {
      health: "healthy",
      last_success: 1_790_000_000,
      coverage_start: null,
      coverage_end: null,
      timezone: "Europe/London",
      refresh_in_progress: held,
    },
  });

/** The same production composition booted again in a NEW document of the same page (a reload), settled with its row listed. */
async function reopen(page: Page, options: { settle?: boolean } = {}) {
  await page.goto(ROUTE);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible();
  // A read held by the test keeps the tree from settling (a request out): such a test waits for the read's arrival instead.
  if (options.settle !== false)
    await untilTreeSettled(page, { connections: 2 });
}

/** Presses Refresh, answered `409 refresh_in_progress`, and waits until the POST has ARRIVED (the row says "Refreshing…" before). */
async function pressHeldRefresh(page: Page, cal: CalendarStub) {
  cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
    { status: 409, body: JSON.parse(atlasError("refresh_in_progress")) },
  ]);
  const row = page.locator(`[data-source-row="${SOURCE}"]`);
  await row.getByRole("button", { name: "Refresh Work rota" }).click();
  await expect.poll(() => refreshes(cal).length).toBe(1);
  await expect(row.locator("[data-refresh]")).toHaveAttribute(
    "data-refresh",
    "refreshing",
  );
}

/**
 * Revision 4 (R10; D-13a-13, design assessment S1, S2, S5, S7, S9, S11, S18): a refresh that holds a source's lease when the screen
 * opens (one in flight at a reload, another tab's, another device's or the server's own) is shown as "Refreshing…" from the live list,
 * and the synced history after it; the screen sends nothing for it, never resumes one, and never says it succeeded. The 5 s pace is
 * the production one (real time). Each request is recorded with the phase in which it arrived, so a read made by the new document is
 * told apart from every other.
 */
test.describe("E-CAL4: a refresh holding the lease when the screen opens (revision 4, R10, D-13a-13)", () => {
  test("a reload while the refresh is held: the new document reads the list, says Refreshing… (Refresh held back, no Check again), then the history once the lease is gone; nothing is resent, no success is claimed", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    await pressHeldRefresh(page, cal);
    cal.phase = "reloaded";
    await reopen(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row.locator("[data-observed]")).toHaveAttribute(
      "data-observed",
      "busy",
    );
    await expect(row).toContainText("Refreshing…");
    await expect(
      row.getByRole("button", { name: "Refresh Work rota" }),
    ).toBeDisabled();
    await expect(row.getByRole("button", { name: "Check again" })).toHaveCount(
      0,
    );
    // No run was restored: the progress is the observation's.
    await expect(row.locator("[data-refresh]")).toHaveCount(0);
    await expect(row).toContainText("Last success");
    expect(liveReads(cal, "reloaded").length).toBeGreaterThanOrEqual(1);
    // The lease ends with nothing written (it lapsed, or another refresh's write is not synced yet).
    cal.phase = "released";
    cal.live = [leased(false)];
    await expect(row).toHaveAttribute("data-observation", "idle", {
      timeout: 15_000,
    });
    await expect(row).not.toContainText("Refreshing…");
    await expect(row).not.toContainText("Refreshed.");
    await expect(row).toContainText("Last success");
    await expect(
      row.getByRole("button", { name: "Refresh Work rota" }),
    ).toBeEnabled();
    const released = liveReads(cal, "released");
    expect(released).toHaveLength(1);
    // The real 5 s pace between reads.
    const before = liveReads(cal, "reloaded").at(-1)?.at ?? 0;
    expect((released[0]?.at ?? 0) - before).toBeGreaterThanOrEqual(5_000);
    // Nothing more is read once it is idle, and the refresh is never sent again.
    await page.waitForTimeout(6_000);
    expect(liveReads(cal, "released")).toHaveLength(1);
    expect(refreshes(cal)).toHaveLength(1);
    expect(await rows(page, "drafts")).toEqual([]);
  });

  test("control: the same press and reload with no lease held: one read, no progress, Refresh available, nothing resent", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(false)];
    await pressHeldRefresh(page, cal);
    cal.phase = "reloaded";
    await reopen(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "idle");
    await expect(row).not.toContainText("Refreshing…");
    await expect(
      row.getByRole("button", { name: "Refresh Work rota" }),
    ).toBeEnabled();
    await page.waitForTimeout(6_000);
    expect(liveReads(cal, "reloaded")).toHaveLength(1);
    expect(refreshes(cal)).toHaveLength(1);
  });

  test("control: no reload: the press's own run shows its progress and outcome; the screen reads nothing for it", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    await pressHeldRefresh(page, cal);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "none");
    // Its own same-key retry after 5 s is answered 200.
    await expect(row).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 15_000 },
    );
    await expect(row.locator("[data-observed]")).toHaveCount(0);
    const [a, b] = refreshes(cal);
    expect(b?.key).toBe(a?.key);
    expect(liveReads(cal)).toEqual([]);
  });

  test("another tab opens while the lease is held elsewhere (its data hints held): it shows Refreshing… without pressing anything, then the history; the first tab has no run of its own; nothing is sent", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page: a, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    cal.phase = "peer";
    const b = await peerTab(context, a);
    await peer(b, "hold");
    const rowB = b.locator(`[data-source-row="${SOURCE}"]`);
    const rowA = a.locator(`[data-source-row="${SOURCE}"]`);
    await expect(rowB).toHaveAttribute("data-observation", "busy");
    await expect(rowB).toContainText("Refreshing…");
    // Tab A is independent: booting B may remount A's protected tree (a fixture trait, WEB-09a); since revision 5 (R11) its remounted
    // screen continues its visit and reads nothing again. Either way it has no run of its own and sends nothing.
    await expect(rowA.locator("[data-refresh]")).toHaveCount(0);
    cal.phase = "released";
    cal.live = [leased(false)];
    await expect(rowB).toHaveAttribute("data-observation", "idle", {
      timeout: 15_000,
    });
    await expect(rowB).not.toContainText("Refreshing…");
    await expect(rowB).not.toContainText("Refreshed.");
    await expect(rowA).not.toContainText("Refreshing…", { timeout: 15_000 });
    await peer(b, "release");
    expect(refreshes(cal)).toEqual([]);
    expect(calendarCommands(cal)).toEqual([]);
  });

  test("a press while the new document's read is still out: the press's outcome stands; the read, answered busy afterwards, changes nothing", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    let release: (answer: { status: number; body: unknown }) => void = () =>
      undefined;
    cal.answers.set("/calendar-sources", [
      {
        wait: new Promise((resolve) => {
          release = resolve;
        }),
      },
    ]);
    cal.phase = "reloaded";
    await reopen(page, { settle: false });
    await expect.poll(() => liveReads(cal, "reloaded").length).toBe(1);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "checking");
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await expect(row).toContainText(
      "Refreshed. New events appear after the next sync.",
    );
    release({ status: 200, body: { items: [leased(true)], next_after: null } });
    await page.waitForTimeout(6_000);
    await expect(row).toContainText("Refreshed.");
    await expect(row).toHaveAttribute("data-observation", "none");
    await expect(row.locator("[data-observed]")).toHaveCount(0);
    expect(refreshes(cal)).toHaveLength(1);
    expect(liveReads(cal, "reloaded")).toHaveLength(1);
  });

  test("offline while it is observed: Refreshing… goes; back online nothing is read or sent", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    cal.phase = "reloaded";
    await reopen(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "busy");
    await context.setOffline(true);
    await expect(row).toHaveAttribute("data-observation", "ended");
    await expect(row).not.toContainText("Refreshing…");
    cal.phase = "offline";
    await page.waitForTimeout(2_000);
    await context.setOffline(false);
    await page.waitForTimeout(7_000);
    expect(liveReads(cal, "offline")).toEqual([]);
    await expect(row).not.toContainText("Refreshing…");
    expect(refreshes(cal)).toEqual([]);
  });

  test("leaving the screen while it is observed: nothing more is read", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    cal.phase = "reloaded";
    await reopen(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "busy");
    await page
      .locator("#main")
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    cal.phase = "left";
    await page.waitForTimeout(7_000);
    expect(liveReads(cal, "left")).toEqual([]);
    expect(refreshes(cal)).toEqual([]);
  });
});

/**
 * Revision 5 (R11; design assessment C1-C4, Q1-Q4, Q6, Q15): what the screen reads by itself (the live list and the capability) is read
 * ONCE PER VISIT. An Atlas `403`, an ordinary refusal included, makes the session hold, close the protected display and mount the tree
 * again under the same identity (the required protective closure, which also closes any open form): the remounted screen continues the
 * visit and reads nothing already read, so a refusing server cannot make it read again and again. A new document, or leaving the screen
 * and opening it again, is a new visit. Through the PRODUCTION session and protected tree; requests are counted per phase and per
 * endpoint, and the remount itself is observed (the heading element present before it is gone), so suppression cannot pass merely
 * because the screen never came back. The 5 s pace is the production one; the 3 s windows only bound what an absent read would be.
 */
const capabilityReads = (cal: CalendarStub, phase: string) =>
  cal.wire.filter(
    (w) => w.path === "/notification-capabilities" && w.phase === phase,
  );
const forbidden403 = () => ({
  status: 403,
  body: JSON.parse(atlasError("forbidden")),
});
/**
 * Marks the screen's heading element and the session trace's length (`markMount`). A remount by the session's protective re-check is
 * established by the kernel's own record, a `surrender` of a non-identity request answered 401/403 after the mark, AND the marked
 * heading being replaced (`remounted`); the early boot mounts of a new document replace the heading too, so the element alone is not
 * evidence. Found by element, not role: an open modal (Manage) takes the heading out of the accessibility tree.
 */
const markMount = async (page: Page) => {
  const heading = page.locator("h1", { hasText: "Calendar sources" });
  await expect(heading).toHaveCount(1);
  await heading.evaluate((h) => {
    h.setAttribute("data-probe-mount", "before");
    (window as unknown as { __probeMark: number }).__probeMark =
      window.__atlasFixture?.session?.trace.length ?? 0;
  });
};
/** The protective surrenders (a 401/403 to a request that is not an identity read) the kernel recorded since `markMount`. */
const protectiveSince = (page: Page) =>
  page.evaluate(() => {
    const trace = window.__atlasFixture?.session?.trace ?? [];
    const from = (window as unknown as { __probeMark?: number }).__probeMark;
    if (from === undefined) throw new Error("markMount was not called");
    return trace
      .slice(from)
      .filter(
        (e) =>
          e.event === "surrender" &&
          (e.data?.status === 401 || e.data?.status === 403) &&
          e.data?.identityRead !== true,
      ).length;
  });
const remounted = async (page: Page) => {
  await expect
    .poll(() => protectiveSince(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator('h1[data-probe-mount="before"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole("heading", { level: 1, name: "Calendar sources" }),
  ).toBeVisible();
};
/** No protective re-check since `markMount`; with `element`, the marked heading is also still the one shown (a settled page). */
const notRemounted = async (
  page: Page,
  options: { element?: boolean } = {},
) => {
  expect(await protectiveSince(page)).toBe(0);
  if (options.element !== false)
    await expect(page.locator('h1[data-probe-mount="before"]')).toHaveCount(1);
};
/** A held answer: the request arrives and waits until `release`. */
function holdAnswer() {
  let release: (answer: { status: number; body: unknown }) => void = () =>
    undefined;
  const wait = new Promise<{ status: number; body: unknown }>((resolve) => {
    release = resolve;
  });
  return {
    answer: { wait } as Answer,
    release: (a: { status: number; body: unknown }) => release(a),
  };
}
/** A new document of the same page whose FIRST live read is held: returns once it has arrived, with the heading marked. */
async function reopenHeld(page: Page, cal: CalendarStub, phase: string) {
  const held = holdAnswer();
  cal.answers.set("/calendar-sources", [held.answer]);
  cal.phase = phase;
  await reopen(page, { settle: false });
  await expect.poll(() => liveReads(cal, phase).length).toBe(1);
  await markMount(page);
  return held;
}

test.describe("E-CAL14: automatic reads are once per visit (revision 5, R11)", () => {
  for (const [label, first, remounts] of [
    ["refused 403 (an ordinary refusal)", forbidden403(), true],
    [
      "control: answered 200 (idle)",
      { status: 200, body: { items: [leased(false)], next_after: null } },
      false,
    ],
    [
      "control: refused 503 (no remount)",
      { status: 503, body: JSON.parse(atlasError("temporarily_unavailable")) },
      false,
    ],
  ] as const)
    test(`a new document's first live read ${label}: ONE list read and ONE capability read, however the session answers; nothing sent`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      const held = await reopenHeld(page, cal, "opened");
      // Every later read would be refused too (the review's six-refusal diagnostic): none may be made.
      cal.answers.set(
        "/calendar-sources",
        Array.from({ length: 6 }, () => forbidden403()),
      );
      held.release(first);
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      if (remounts) await remounted(page);
      await expect(row).toHaveAttribute(
        "data-observation",
        first.status === 200 ? "idle" : "unknown",
      );
      await page.waitForTimeout(3_000);
      if (!remounts) await notRemounted(page, { element: false });
      expect(liveReads(cal, "opened")).toHaveLength(1);
      expect(capabilityReads(cal, "opened")).toHaveLength(1);
      expect(cal.wire.filter((w) => w.method === "POST")).toEqual([]);
      await expect(
        row.getByRole("button", { name: "Refresh Work rota" }),
      ).toBeEnabled();
    });

  test("busy, then the 5 s poll refused 403 with Manage open and edited: the remount closes Manage (the required protective closure), the row says it could not check, and nothing more is read", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    cal.phase = "opened";
    await reopen(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "busy");
    cal.answers.set(
      "/calendar-sources",
      Array.from({ length: 6 }, () => forbidden403()),
    );
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByLabel("Timezone", { exact: true }).fill("Asia/Tokyo");
    await markMount(page);
    await expect
      .poll(() => liveReads(cal, "opened").length, {
        timeout: 15_000,
      })
      .toBe(2);
    await remounted(page);
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveAttribute("data-observation", "unconfirmed");
    await expect(row).toContainText(
      "We couldn't check whether this calendar is still refreshing.",
    );
    // Beyond the next 5 s poll: nothing more is read.
    await page.waitForTimeout(7_000);
    expect(liveReads(cal, "opened")).toHaveLength(2);
    expect(capabilityReads(cal, "opened")).toHaveLength(1);
    expect(cal.wire.filter((w) => w.method === "POST")).toEqual([]);
    expect(await rows(page, "drafts")).toEqual([]);
    expect(await everywhere(page)).not.toContain("Asia/Tokyo");
  });

  for (const [label, poll] of [
    [
      "503",
      { status: 503, body: JSON.parse(atlasError("temporarily_unavailable")) },
    ],
    [
      "idle",
      { status: 200, body: { items: [leased(false)], next_after: null } },
    ],
  ] as const)
    test(`control: busy, then the 5 s poll answered ${label} with Manage open and edited: no remount, Manage keeps the edit, nothing more is read`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      cal.live = [leased(true)];
      cal.phase = "opened";
      await reopen(page);
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      await expect(row).toHaveAttribute("data-observation", "busy");
      cal.answers.set("/calendar-sources", [poll]);
      await page.getByRole("button", { name: "Manage Work rota" }).click();
      const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
      const timezone = dialog.getByLabel("Timezone", { exact: true });
      await timezone.fill("Asia/Tokyo");
      await markMount(page);
      await expect
        .poll(() => liveReads(cal, "opened").length, {
          timeout: 15_000,
        })
        .toBe(2);
      await expect(row).toHaveAttribute(
        "data-observation",
        label === "idle" ? "idle" : "unconfirmed",
      );
      await page.waitForTimeout(7_000);
      await notRemounted(page);
      await expect(timezone).toHaveValue("Asia/Tokyo");
      expect(liveReads(cal, "opened")).toHaveLength(2);
    });

  test("busy, then the 5 s poll refused 403 with Replace… open and a feed URL typed: the remount discards the secret (never kept, stored or shown again); nothing is sent or read again", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    cal.live = [leased(true)];
    cal.phase = "opened";
    await reopen(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "busy");
    cal.answers.set(
      "/calendar-sources",
      Array.from({ length: 6 }, () => forbidden403()),
    );
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByRole("button", { name: "Replace…" }).click();
    await dialog
      .getByLabel("URL (required)")
      .fill(`https://feed.example/poll-${SENTINEL}.ics`);
    await markMount(page);
    await expect
      .poll(() => liveReads(cal, "opened").length, { timeout: 15_000 })
      .toBe(2);
    await remounted(page);
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveAttribute("data-observation", "unconfirmed");
    // Opening Manage again shows an empty connection form: nothing typed was kept.
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    await dialog.getByRole("button", { name: "Replace…" }).click();
    await expect(dialog.getByLabel("URL (required)")).toHaveValue("");
    await page.waitForTimeout(7_000);
    expect(liveReads(cal, "opened")).toHaveLength(2);
    expect(cal.wire.filter((w) => w.method === "POST")).toEqual([]);
    expect(await everywhere(page)).not.toContain(SENTINEL);
  });

  test("DA-1: the capability read refused 403 (the list healthy): the remount reads neither again; Link is not pre-disabled", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    let release: (answer: { status: number; body: unknown }) => void = () =>
      undefined;
    cal.answers.set("/notification-capabilities", [
      {
        wait: new Promise((resolve) => {
          release = resolve;
        }),
      },
      ...Array.from({ length: 6 }, () => forbidden403()),
    ]);
    cal.live = [leased(false)];
    cal.phase = "opened";
    await reopen(page, { settle: false });
    await expect.poll(() => capabilityReads(cal, "opened").length).toBe(1);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "idle");
    await markMount(page);
    release(forbidden403());
    await remounted(page);
    await page.waitForTimeout(3_000);
    expect(capabilityReads(cal, "opened")).toHaveLength(1);
    expect(liveReads(cal, "opened")).toHaveLength(1);
    await expect(row).toHaveAttribute("data-observation", "idle");
    await expect(
      page.getByRole("button", { name: "Link a calendar…" }),
    ).toBeEnabled();
  });

  test("Q4: a manual Refresh refused 403 while the screen's own read is held: the remount does not read again; the press's outcome stands and the late read changes nothing", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const held = await reopenHeld(page, cal, "opened");
    cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [forbidden403()]);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await row.getByRole("button", { name: "Refresh Work rota" }).click();
    await remounted(page);
    await expect(row).toContainText(
      "This calendar source is no longer available to you.",
      { timeout: 15_000 },
    );
    held.release({
      status: 200,
      body: { items: [leased(true)], next_after: null },
    });
    await page.waitForTimeout(6_000);
    await expect(row).not.toContainText("Refreshing…");
    await expect(row).toHaveAttribute("data-observation", "none");
    expect(liveReads(cal, "opened")).toHaveLength(1);
    expect(capabilityReads(cal, "opened")).toHaveLength(1);
    expect(refreshes(cal)).toHaveLength(1);
  });

  test("Q6: after a refused read, leaving the screen and opening it again is a new visit: ONE new list read and ONE new capability read", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const held = await reopenHeld(page, cal, "opened");
    held.release(forbidden403());
    await remounted(page);
    const row = page.locator(`[data-source-row="${SOURCE}"]`);
    await expect(row).toHaveAttribute("data-observation", "unknown");
    await page
      .locator("#main")
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    cal.phase = "returned";
    cal.live = [leased(true)];
    await page.getByRole("link", { name: "Calendars" }).click();
    await expect(row).toHaveAttribute("data-observation", "busy");
    await expect(row).toContainText("Refreshing…");
    expect(liveReads(cal, "returned")).toHaveLength(1);
    expect(capabilityReads(cal, "returned")).toHaveLength(1);
    expect(liveReads(cal, "opened")).toHaveLength(1);
    expect(refreshes(cal)).toEqual([]);
  });

  test("Q15: the first live read refused 403 credential_mismatch (an invalidating answer): one read, nothing sent, nothing read again", async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const { page, cal } = await calendarsPage(context, {
      cache: [projection()],
    });
    const held = await reopenHeld(page, cal, "opened");
    cal.answers.set(
      "/calendar-sources",
      Array.from({ length: 6 }, () => forbidden403()),
    );
    held.release({
      status: 403,
      body: JSON.parse(atlasError("credential_mismatch")),
    });
    await expect(page.locator('h1[data-probe-mount="before"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await page.waitForTimeout(3_000);
    expect(liveReads(cal, "opened")).toHaveLength(1);
    expect(capabilityReads(cal, "opened").length).toBeLessThanOrEqual(1);
    expect(cal.wire.filter((w) => w.method === "POST")).toEqual([]);
  });
});

/**
 * Revision 6 (R12, R13; design assessment C1, C2, Q2, Q3, Q8). Through the PRODUCTION session and protected tree, with the review's
 * schedules adopted as regression cases (its probes are preserved separately):
 *
 *  - R12: who may record a refresh's outcome is decided by admission. Refresh A is held; the person goes to Settings and back (a new
 *    screen and controller); Refresh B (a new key) is pressed and, in one schedule, refused `422 invalid_ics`; then A's success arrives.
 *    A newer admission owns the source for good, so the row keeps B's state. With no newer press, A's late success is shown (the
 *    legitimate late outcome, and the positive control that the late answer is delivered within the bounded window the other two use;
 *    production timers are unchanged).
 *  - R13: a visit ends when the DOCUMENT leaves the screen, even while the protected tree is closed. A manual Refresh refused with an
 *    ordinary `403` makes the session close the tree; its classification is held (the answer's `Response.json()`) so the row is proved
 *    absent before the browser's Back; after releasing it and returning to Calendars, with the source now busy, the new visit reads the
 *    list once and observes it. Control: Back on the mounted screen.
 */
test.describe("E-CAL15: refresh ownership by admission and departures while closed (revision 6, R12 and R13)", () => {
  for (const schedule of [
    "no newer press",
    "newer press running",
    "newer press finished",
  ] as const)
    test(`R12: an older press's late success after Settings and back — ${schedule}`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      const older = holdAnswer();
      const newer = holdAnswer();
      const endpoint = `/calendar-sources/${SOURCE}/refresh`;
      cal.answers.set(endpoint, [older.answer, newer.answer]);
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      const state = row.locator("[data-refresh]");
      await row
        .getByRole("button", { name: "Refresh Work rota", exact: true })
        .click();
      await expect.poll(() => refreshes(cal).length).toBe(1);
      await expect(state).toHaveAttribute("data-refresh", "refreshing");
      await page
        .locator("#main")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect(row).toHaveCount(0);
      await page.getByRole("link", { name: "Calendars", exact: true }).click();
      await expect(row).toHaveAttribute("data-observation", OBSERVED);
      if (schedule !== "no newer press") {
        await row
          .getByRole("button", { name: "Refresh Work rota", exact: true })
          .click();
        await expect.poll(() => refreshes(cal).length).toBe(2);
        expect(refreshes(cal)[1]?.key).not.toBe(refreshes(cal)[0]?.key);
        if (schedule === "newer press finished") {
          newer.release({
            status: 422,
            body: JSON.parse(atlasError("invalid_ics")),
          });
          await expect(state).toHaveAttribute("data-refresh", "failed");
        }
      }
      const answered = page.waitForResponse(
        (r) => r.url().endsWith(endpoint) && r.status() === 200,
      );
      older.release({ status: 200, body: { revision: 201 } });
      await (await answered).finished();
      if (schedule === "no newer press")
        await expect(state).toHaveAttribute("data-refresh", "succeeded");
      else {
        await page.waitForTimeout(750);
        await expect(state).toHaveAttribute(
          "data-refresh",
          schedule === "newer press running" ? "refreshing" : "failed",
        );
      }
      if (schedule === "newer press running") {
        newer.release({
          status: 422,
          body: JSON.parse(atlasError("invalid_ics")),
        });
        await expect(state).toHaveAttribute("data-refresh", "failed");
      }
      expect(refreshes(cal)).toHaveLength(
        schedule === "no newer press" ? 1 : 2,
      );
    });

  for (const closed of [true, false])
    test(`R13: ${closed ? "Back while the protective closure has the tree closed" : "control: Back on the mounted screen"}, then Calendars again with the source busy: one fresh list read, observed busy`, async ({
      context,
    }) => {
      test.setTimeout(60_000);
      const { page, cal } = await calendarsPage(context, {
        cache: [projection()],
      });
      const row = page.locator(`[data-source-row="${SOURCE}"]`);
      // A same-document history entry to go Back to.
      await page
        .locator("#main")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect(row).toHaveCount(0);
      await page.getByRole("link", { name: "Calendars", exact: true }).click();
      await expect(row).toHaveAttribute("data-observation", OBSERVED);
      if (closed) {
        // Holds only the classification of the refresh's 403 (its JSON), so the closure is observed before navigating; the refusal,
        // the session's decision, its timers and the identity are unchanged.
        await page.evaluate(() => {
          const original = Response.prototype.json;
          const probe = window as unknown as {
            __r6Held?: boolean;
            __r6Release?: () => void;
          };
          probe.__r6Held = false;
          let release: () => void = () => undefined;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          probe.__r6Release = () => {
            Response.prototype.json = original;
            release();
          };
          Response.prototype.json = async function (this: Response) {
            if (this.status === 403 && this.url.endsWith("/refresh")) {
              probe.__r6Held = true;
              await held;
            }
            return original.call(this);
          };
        });
        cal.answers.set(`/calendar-sources/${SOURCE}/refresh`, [
          forbidden403(),
        ]);
        await row
          .getByRole("button", { name: "Refresh Work rota", exact: true })
          .click();
        await page.waitForFunction(
          () => (window as unknown as { __r6Held?: boolean }).__r6Held === true,
        );
        await expect(row).toHaveCount(0);
      }
      await page.evaluate(() => history.back());
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings");
      if (closed)
        await page.evaluate(() =>
          (window as unknown as { __r6Release: () => void }).__r6Release(),
        );
      await expect(
        page.getByRole("link", { name: "Calendars", exact: true }),
      ).toBeVisible();
      cal.phase = "returned";
      cal.live = [leased(true)];
      await page.getByRole("link", { name: "Calendars", exact: true }).click();
      await expect(row).toBeVisible();
      await test.info().attach("wire-at-reopen", {
        body: JSON.stringify(cal.wire, null, 2),
        contentType: "application/json",
      });
      await expect(row).toHaveAttribute("data-observation", "busy");
      expect(liveReads(cal, "returned")).toHaveLength(1);
      expect(capabilityReads(cal, "returned")).toHaveLength(1);
      expect(cal.wire.filter((w) => w.method === "POST")).toHaveLength(
        closed ? 1 : 0,
      );
    });
});

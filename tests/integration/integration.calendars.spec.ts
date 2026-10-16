import { readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import {
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
 * I-CAL1 to I-CAL10 (WEB-13a; I-CAL6(c) added in revision 4): the Calendars screen's PRODUCTION code (the production session and its adapters, the protected tree with
 * its `DataProvider` and the application's command registry, Dexie, the stamped client of the online-only actions) in a real engine
 * against the RELEASED backend (v0.27.0-rc.1) on a disposable SQLite database, behind the delaying proxy, with a loopback ICS feed the
 * backend fetches linked calendars from (`scripts/integration/calendar-feed.mjs`; the runner gives the backend a disposable integration
 * key and an outbound exception for the feed's exact origin). Queued commands are sent by the FIXTURE test leader (the production leader
 * of WEB-09b is not used here) and the snapshot is the FIXTURE seeder. Answers the proxy INJECTS are labelled so.
 *
 * FOCUSED EVIDENCE FOR A FIXTURE-STAGE TASK, not integration acceptance: BE-Q22, BE-B8 and BE-CH3 have no completion record
 * (`integration_passed` stays false). No PostgreSQL (the backend container cannot reach a loopback feed), no HTTPS, no real device.
 *
 * The backend's worker refreshes every linked, enabled source whose `next_refresh` has come (a tick every 15 s; a create or a settings
 * change resets it), holding the refresh lease for up to 60 s. Cases that force an order therefore first wait for the worker's own
 * refresh to finish (the feed's count and the live `refresh_in_progress`), and assert final outcomes, not incidental intermediate codes,
 * except where the feed is HELD to force the order.
 */
const API = "/api/experimental/v1";
const FEED = process.env.ATLAS_INTEGRATION_FEED ?? "";
const ROUTE = "/settings/calendars";

// The released backend allows 10 password attempts per account in a fixed 60 s window: every sign-in waits until fewer than 8 of that
// account's attempts are less than a minute old (helpers.ts `paceSignIn`: the stack's own ledger file), and the main account rotates.
const budget = (who: Who) => paceSignIn(who);
const ROTATION: Who[] = ["alice", "carol", "dave", "erin", "bob"];
const ROTATION_FILE = stackFile("atlas-calendar-rotation.txt");
let main: Who = "alice";
test.beforeEach(async ({ context }, info) => {
  void context;
  test.skip(
    !FEED,
    "no loopback feed (the PostgreSQL repeat runs the backend in a container, which cannot reach it)",
  );
  let n = 0;
  try {
    n = Number(readFileSync(ROTATION_FILE, "utf8")) || 0;
  } catch {
    n = 0;
  }
  writeFileSync(ROTATION_FILE, String(n + 1));
  main = ROTATION[n % ROTATION.length] as Who;
  info.setTimeout(180_000);
});

// ---- the feed --------------------------------------------------------------------------------------------------------------------
const feedCtl = async (action: string, body?: unknown) =>
  (
    await fetch(`${FEED}/__feed/${action}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json() as Promise<{
    counts: Record<string, number>;
    held: Record<string, number>;
  }>;
const ics = (summary: string, uid = summary) => {
  const at = new Date(Date.now() + 3 * 86_400_000);
  const date = at.toISOString().slice(0, 10).replaceAll("-", "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//atlas-web//integration//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${date}T000000Z`,
    `DTSTART;VALUE=DATE:${date}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
};
/** A feed path unique to this test, serving one event. */
const newFeed = async (name: string) => {
  const path = `/feeds/${name}-${crypto.randomUUID().slice(0, 8)}.ics`;
  await feedCtl("set", { path, body: ics(name) });
  return path;
};
const served = async (path: string) =>
  (await feedCtl("state")).counts[path] ?? 0;
const heldAt = async (path: string) => (await feedCtl("state")).held[path] ?? 0;

// ---- the page ----------------------------------------------------------------------------------------------------------------------
interface Wire {
  path: string;
  key: string | null;
  body: string;
}
/** Records every calendar write the PAGE sends (the screen's direct requests and the leader's queued ones). */
function recordCalendar(page: Page): Wire[] {
  const seen: Wire[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "POST" ||
      !/\/calendar-(commands|sources\/[^/]+\/(refresh|import))$/.test(
        url.pathname,
      )
    )
      return;
    seen.push({
      path: url.pathname.replace(API, ""),
      key: request.headers()["idempotency-key"] ?? null,
      body: request.postData() ?? "",
    });
  });
  return seen;
}

const reopen = async (page: Page) => {
  await page.goto(`/__session?route=${encodeURIComponent(ROUTE)}`);
  await exposeSession(page);
  await untilView(page, "displaying");
};

/**
 * A signed-in Calendars page whose account has a database (the fixture seeder's real snapshot), bound by the tree (the page is opened
 * again after the seeder created it: the tree looks for a database when the identity is displayed), with the fixture leader's
 * dispatcher (not begun unless asked) and sync engine on the page.
 */
async function ready(
  context: BrowserContext,
  options: { begin?: boolean } = {},
) {
  const page = await bootHarness(context, ROUTE);
  await budget(main);
  expect((await signInUnpaced(page, main)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = (await page.evaluate(() => window.__s.identity.get())) as {
    account_id: string;
    epoch: number;
  };
  await page.evaluate(
    (a) => window.__atlasData?.prepareAccount(a),
    id.account_id,
  );
  await reopen(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Calendar sources" }),
  ).toBeVisible();
  await expect(page.locator("[data-no-database]")).toHaveCount(0);
  await page.evaluate(
    async ({ a, begin }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      await data.startOutbox(a, { start: begin });
      await data.startSync(a);
    },
    { a: id.account_id, begin: options.begin ?? true },
  );
  const wire = recordCalendar(page);
  return { page, id, wire };
}

/** A read through the page's own stamped client (the displayed identity), asked again while the session says not_sent. */
const get = (
  page: Page,
  path: string,
  query: Record<string, string | number> = {},
) =>
  page.evaluate(
    async ({ p, q }) => {
      const id = window.__s.identity.get() as {
        account_id: string;
        epoch: number;
      };
      const client = window.__s.api.client("ordinary", id.account_id, id.epoch);
      for (let attempt = 0; ; attempt += 1) {
        try {
          const { data } = await client.GET(
            p as never,
            { params: { query: q } } as never,
          );
          return data as unknown;
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
    { p: path, q: query },
  );

interface LiveItem {
  id: string;
  label: string;
  version: number;
  archived: boolean;
  value: { health: string; refresh_in_progress: boolean; timezone: string };
}
const sources = async (page: Page) =>
  (
    (await get(page, "/calendar-sources", { limit: 200 })) as {
      items?: LiveItem[];
    }
  )?.items ?? [];
const source = async (page: Page, id: string) =>
  (await sources(page)).find((s) => s.id === id);
const events = async (page: Page, sourceId: string) =>
  (
    (await get(page, "/events", { parent_id: sourceId, limit: 200 })) as {
      items?: unknown[];
    }
  )?.items ?? [];

/** Waits until the backend's worker (or anything else) has no refresh of this source running, and it has refreshed at least once. */
async function untilQuiet(
  page: Page,
  id: string,
  options: { refreshed?: boolean } = {},
  timeout = 60_000,
) {
  await expect
    .poll(
      async () => {
        const s = await source(page, id);
        return s
          ? `${s.value.health}:${s.value.refresh_in_progress}`
          : "absent";
      },
      { timeout, intervals: [500] },
    )
    .toMatch(/^[a-z_]+:false$/);
  // A source without a connection is never refreshed by the worker: its health stays `pending`.
  if (options.refreshed === false) return;
  await expect
    .poll(async () => (await source(page, id))?.value.health, {
      timeout,
      intervals: [500],
    })
    .not.toBe("pending");
}

/**
 * Waits until the account's cache holds the server's CURRENT version of the source. A refresh publishes the source's new health as a
 * new version, and a queued settings change is built on the version the outbox assumes (the cache's): one built before the sync engine
 * has caught up is (correctly) a `409 conflict` that asks for a review. A case that means to send a settings change waits for this.
 */
async function untilCached(page: Page, id: string, timeout = 60_000) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__atlasData?.nudgeSync());
        const live = await source(page, id);
        const account = (
          (await page.evaluate(() => window.__s.identity.get())) as {
            account_id: string;
          }
        ).account_id;
        const cached = (
          (await page.evaluate(
            (a) => window.__atlasData?.rows(a, "cache"),
            account,
          )) as Array<{ id: string; version: number }>
        ).find((r) => r.id === id);
        return live !== undefined && cached?.version === live.version;
      },
      { timeout, intervals: [500] },
    )
    .toBe(true);
}

const row = (page: Page, id: string) =>
  page.locator(`[data-source-row="${id}"]`);

/** "Link a calendar…" through the screen; returns the new source's id (from the request the screen sent). */
async function link(
  page: Page,
  wire: Wire[],
  label: string,
  path: string,
  bearer = "",
) {
  const before = wire.length;
  await page.getByRole("button", { name: "Link a calendar…" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a calendar…" });
  await dialog.getByLabel("Label").fill(label);
  await dialog.getByLabel("Timezone").fill("Europe/London");
  await dialog.getByLabel("URL (required)").fill(`${FEED}${path}`);
  if (bearer) await dialog.getByLabel("Bearer token (optional)").fill(bearer);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const sent = wire.slice(before).find((w) => w.path === "/calendar-commands");
  const id = (JSON.parse(sent?.body ?? "{}") as { command?: { id?: string } })
    .command?.id;
  if (!id) throw new Error("no create was sent");
  // The sync engine brings the source in.
  await page.evaluate(() => window.__atlasData?.nudgeSync());
  await expect(row(page, id)).toBeVisible({ timeout: 30_000 });
  return id;
}

/**
 * Wakes the fixture leader's dispatcher. It is woken by saves of its OWN facade; a save the screen makes goes through the tree's
 * facade, which only posts its `data_changed` hint (the production leader of WEB-09b wakes on that hint; this fixture leader does not).
 */
const wakeLeader = (page: Page) =>
  page.evaluate(() => window.__atlasData?.retryOutbox());

/** A queued settings change through Manage, sent by the leader. */
async function settings(
  page: Page,
  label: string,
  change: { timezone?: string; enabled?: boolean },
) {
  await page.getByRole("button", { name: `Manage ${label}` }).click();
  const dialog = page.getByRole("dialog", { name: `Manage — ${label}` });
  if (change.timezone)
    await dialog.getByLabel("Timezone").fill(change.timezone);
  if (change.enabled !== undefined)
    await dialog.getByLabel("Enabled").setChecked(change.enabled);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await wakeLeader(page);
}

const refreshes = (wire: Wire[], id: string) =>
  wire.filter((w) => w.path === `/calendar-sources/${id}/refresh`);

// =====================================================================================================================================
test.describe("I-CAL1: a credential-free source queued offline", () => {
  test("Add source offline is stored (no secret), sent once by key when online, receipted, and published by a real delta page", async ({
    context,
  }) => {
    const { page, wire } = await ready(context, { begin: false });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Add source" }).click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByLabel("Label").fill("I-CAL1 Chores");
    await dialog.getByLabel("Timezone").fill("Europe/London");
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-pending-source]")).toContainText(
      "Pending — will create when back online",
    );
    expect(wire).toEqual([]);
    await context.setOffline(false);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(() => wire.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    const body = JSON.parse(wire[0]?.body ?? "{}").command as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      kind: "create_source",
      id: body.id,
      label: "I-CAL1 Chores",
      timezone: "Europe/London",
    });
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect(row(page, body.id as string)).toContainText(
      "Not refreshed yet · Europe/London",
      {
        timeout: 30_000,
      },
    );
    await expect(page.locator("[data-pending-source]")).toHaveCount(0);
    expect(
      (await sources(page)).filter((s) => s.label === "I-CAL1 Chores"),
    ).toHaveLength(1);
  });
});

test.describe("I-CAL2: a queued create's lost response", () => {
  test("a proxy-injected drop AFTER the backend committed: resent with the same key and body, and exactly one source exists", async ({
    context,
  }) => {
    const { page, wire } = await ready(context, { begin: false });
    await proxy.addRule({
      method: "POST",
      path: `${API}/calendar-commands`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    await page.getByRole("button", { name: "Add source" }).click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByLabel("Label").fill("I-CAL2 Lost");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(() => wire.length, { timeout: 45_000 })
      .toBeGreaterThanOrEqual(2);
    expect(wire[1]?.key).toBe(wire[0]?.key);
    expect(wire[1]?.body).toBe(wire[0]?.body);
    await expect
      .poll(
        async () =>
          (await sources(page)).filter((s) => s.label === "I-CAL2 Lost").length,
        { timeout: 30_000 },
      )
      .toBe(1);
  });
});

test.describe("I-CAL3: Q22 connection preservation", () => {
  test("queued timezone-only and enabled-only changes keep the connection (a refresh still fetches); Remove clears it (cause 1); Replace points refresh at the new address", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const first = await newFeed("ical3-a");
    const id = await link(page, wire, "I-CAL3 Feed", first);
    await untilQuiet(page, id);
    expect(await served(first)).toBeGreaterThanOrEqual(1);
    // A timezone-only change and an enabled-only change, queued and sent: neither carries or clears the connection.
    await untilCached(page, id);
    await settings(page, "I-CAL3 Feed", { timezone: "Asia/Tokyo" });
    await expect
      .poll(async () => (await source(page, id))?.value.timezone, {
        timeout: 30_000,
      })
      .toBe("Asia/Tokyo");
    // The settings change resets the worker's schedule: let its refresh finish, and the cache catch up, before the next change.
    await untilQuiet(page, id);
    await untilCached(page, id);
    // An enabled-only change: off, then on again (each queued and sent; neither touches the connection).
    await settings(page, "I-CAL3 Feed", { enabled: false });
    await expect
      .poll(async () => (await source(page, id))?.archived, { timeout: 30_000 })
      .toBe(true);
    await untilCached(page, id);
    await settings(page, "I-CAL3 Feed", { enabled: true });
    await expect
      .poll(async () => (await source(page, id))?.archived, { timeout: 30_000 })
      .toBe(false);
    await untilQuiet(page, id);
    await untilCached(page, id);
    const fetched = await served(first);
    await expect(
      row(page, id).getByRole("button", { name: /^Refresh/ }),
    ).toBeEnabled({ timeout: 30_000 });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect(row(page, id)).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 120_000 },
    );
    expect(await served(first)).toBeGreaterThan(fetched);
    for (const w of wire
      .filter((w) => w.path === "/calendar-commands")
      .slice(1)) {
      const command = JSON.parse(w.body).command;
      expect(command).not.toHaveProperty("connection");
      expect(command).not.toHaveProperty("disconnect");
    }
    // Remove the connection (online-only, direct): a refresh is then cause 1.
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            (a) => window.__atlasData?.queue(a),
            (
              await page.evaluate(
                () => window.__s.identity.get() as { account_id: string },
              )
            ).account_id,
          )) as unknown[],
        { timeout: 60_000 },
      )
      .toEqual([]);
    await untilQuiet(page, id);
    await untilCached(page, id);
    await page.getByRole("button", { name: "Manage I-CAL3 Feed" }).click();
    let dialog = page.getByRole("dialog", { name: "Manage — I-CAL3 Feed" });
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await dialog.getByRole("button", { name: "Remove connection" }).click();
    await expect
      .poll(
        async () => {
          // Never an auto-waiting read: the panel may close between two reads.
          const open = await dialog
            .locator("[data-connection-panel]")
            .allInnerTexts();
          return open.length === 0 ? "closed" : open.join(" | ");
        },
        { timeout: 30_000 },
      )
      .toBe("closed");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await untilQuiet(page, id, { refreshed: false });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect(row(page, id)).toContainText(
      "This source needs its connection details re-entered.",
      { timeout: 120_000 },
    );
    // Replace with a NEW address: the next refresh fetches it.
    const second = await newFeed("ical3-b");
    await untilCached(page, id);
    await row(page, id)
      .getByRole("button", { name: "Update connection" })
      .click();
    dialog = page.getByRole("dialog", { name: "Manage — I-CAL3 Feed" });
    await dialog.getByLabel("URL (required)").fill(`${FEED}${second}`);
    await dialog.getByRole("button", { name: "Replace connection" }).click();
    await expect
      .poll(
        async () => {
          // Never an auto-waiting read: the panel may close between two reads.
          const open = await dialog
            .locator("[data-connection-panel]")
            .allInnerTexts();
          return open.length === 0 ? "closed" : open.join(" | ");
        },
        { timeout: 30_000 },
      )
      .toBe("closed");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect
      .poll(() => served(second), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(1);
    await untilQuiet(page, id);
    const before = await served(second);
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect(row(page, id)).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 120_000 },
    );
    expect(await served(second)).toBeGreaterThan(before);
  });
});

test.describe("I-CAL4: a Link whose response is lost", () => {
  test("Retry resends the SAME key and body; the backend replays its receipt; one source; the token is nowhere but the wire", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical4");
    const SENTINEL = `sentinel-ical4-${crypto.randomUUID().slice(0, 8)}`;
    await proxy.addRule({
      method: "POST",
      path: `${API}/calendar-commands`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    await page.getByRole("button", { name: "Link a calendar…" }).click();
    const dialog = page.getByRole("dialog", { name: "Link a calendar…" });
    await dialog.getByLabel("Label").fill("I-CAL4 Feed");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog.getByLabel("URL (required)").fill(`${FEED}${path}`);
    await dialog.getByLabel("Bearer token (optional)").fill(SENTINEL);
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(
      dialog.getByText("Couldn't save — check your connection and try again"),
    ).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Retry" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const sent = wire.filter((w) => w.path === "/calendar-commands");
    expect(sent).toHaveLength(2);
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(
      (await sources(page)).filter((s) => s.label === "I-CAL4 Feed"),
    ).toHaveLength(1);
    // The feed was asked with the token (by the backend), and nothing on the page kept it.
    await expect
      .poll(() => served(path), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(1);
    const kept = await page.evaluate(
      async (a) => {
        const data = window.__atlasData;
        const stores = [
          "cache",
          "pending_effects",
          "drafts",
          "draft_commands",
          "resource_versions",
          "form_recovery",
          "sync_state",
        ];
        const rows: Record<string, unknown> = {};
        for (const s of stores) rows[s] = await data?.rows(a, s as never);
        return JSON.stringify({
          rows,
          local: { ...localStorage },
          session: { ...sessionStorage },
          auth: await window.__atlasFixture?.session?.readRecords(),
          dom: document.documentElement.outerHTML,
          url: location.href,
        });
      },
      (
        await page.evaluate(
          () => window.__s.identity.get() as { account_id: string },
        )
      ).account_id,
    );
    expect(kept).not.toContain(SENTINEL);
  });
});

test.describe("I-CAL5: a genuine fetch failure (cause 2)", () => {
  test("the feed answers 500: the refresh is 502, retried twice with the same key, then cause 2; the events already imported stay", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical5");
    const id = await link(page, wire, "I-CAL5 Feed", path);
    await untilQuiet(page, id);
    await expect
      .poll(async () => (await events(page, id)).length, { timeout: 30_000 })
      .toBe(1);
    await feedCtl("set", { path, status: 500, body: "nope" });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect(row(page, id)).toContainText(
      "Couldn't reach the calendar provider just now.",
      { timeout: 120_000 },
    );
    const sent = refreshes(wire, id);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sent.map((w) => w.key)).size).toBe(1);
    // Never a connection prompt for a bare 502 (7(b)); and the events are unchanged (case 4).
    await expect(row(page, id)).not.toContainText("connection details");
    expect(await events(page, id)).toHaveLength(1);
    const log = (await proxy.log()).filter(
      (e) => e.path === `${API}/calendar-sources/${id}/refresh`,
    );
    expect(
      log.map((e) => e.status).filter((s) => s === 502).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

test.describe("I-CAL6: same-key recovery (case 6)", () => {
  test("6(a): the answer is lost while the original refresh is still EXECUTING; the same key meets 409 refresh_in_progress, then the original's receipt", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical6a");
    const id = await link(page, wire, "I-CAL6 Feed", path);
    await untilQuiet(page, id);
    await feedCtl("hold", { path });
    // Proxy-injected: the browser's connection is destroyed 500 ms in, while the backend's fetch is held at the feed.
    await proxy.addRule({
      method: "POST",
      path: `${API}/calendar-sources/${id}/refresh`,
      ordinal: 1,
      action: "drop_client_after",
      ms: 500,
    });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect.poll(() => heldAt(path), { timeout: 20_000 }).toBe(1);
    await expect(row(page, id)).toContainText("Refreshing…");
    // The same-key retry (10 s) finds the original still running.
    await expect
      .poll(() => refreshes(wire, id).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    await feedCtl("release", { path });
    await expect(row(page, id)).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 120_000 },
    );
    const sent = refreshes(wire, id);
    expect(new Set(sent.map((w) => w.key)).size).toBe(1);
    const statuses = (await proxy.log())
      .filter((e) => e.path === `${API}/calendar-sources/${id}/refresh`)
      .map((e) => e.status);
    expect(statuses).toContain(409);
    expect(statuses.at(-1)).toBe(200);
    // The feed was fetched for the original only (the receipt was replayed, not re-executed).
    expect(await served(path)).toBeGreaterThanOrEqual(2);
  });

  test("6(b): a refresh held by the backend's WORKER: the press meets 409 refresh_in_progress, retries with the same key, and runs after the lease clears", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical6b");
    const id = await link(page, wire, "I-CAL6b Feed", path);
    await untilQuiet(page, id);
    const before = await served(path);
    await feedCtl("hold", { path });
    // A settings change resets next_refresh: the worker's next tick (at most 15 s) refreshes, and is held at the feed.
    await untilCached(page, id);
    await settings(page, "I-CAL6b Feed", { timezone: "UTC" });
    await expect.poll(() => heldAt(path), { timeout: 45_000 }).toBe(1);
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect
      .poll(() => refreshes(wire, id).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        async () =>
          (await proxy.log())
            .filter((e) => e.path === `${API}/calendar-sources/${id}/refresh`)
            .map((e) => e.status),
        { timeout: 20_000 },
      )
      .toContain(409);
    await feedCtl("release", { path });
    await expect(row(page, id)).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 120_000 },
    );
    expect(new Set(refreshes(wire, id).map((w) => w.key)).size).toBe(1);
    expect(await served(path)).toBeGreaterThan(before + 1);
  });

  // Revision 4 (R10, D-13a-13): the reload clause of 6(a). A refresh in flight at a reload is never resent; the new document reads the
  // live list and shows "Refreshing…" while the backend's REAL lease is held (its fetch held at the feed), then the synced history.
  test("6(c): a reload while the refresh's fetch is held: the new document shows Refreshing… from the live list (Refresh held back, no Check again) and sends nothing; after the release the row shows its history, with no success claimed", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical6c");
    const id = await link(page, wire, "I-CAL6c Feed", path);
    await untilQuiet(page, id);
    await feedCtl("hold", { path });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect.poll(() => heldAt(path), { timeout: 20_000 }).toBe(1);
    // The lease is the backend's own: its live list says so.
    await expect
      .poll(async () => (await source(page, id))?.value.refresh_in_progress, {
        timeout: 20_000,
      })
      .toBe(true);
    const sent = refreshes(wire, id).length;
    expect(sent).toBe(1);
    await reopen(page);
    await expect(row(page, id).locator("[data-observed]")).toHaveAttribute(
      "data-observed",
      "busy",
      { timeout: 30_000 },
    );
    await expect(row(page, id)).toContainText("Refreshing…");
    await expect(
      row(page, id).getByRole("button", { name: /^Refresh/ }),
    ).toBeDisabled();
    await expect(
      row(page, id).getByRole("button", { name: "Check again" }),
    ).toHaveCount(0);
    // No run was restored: the progress is the observation's.
    await expect(row(page, id).locator("[data-refresh]")).toHaveCount(0);
    await feedCtl("release", { path });
    await expect(row(page, id)).toHaveAttribute("data-observation", "idle", {
      timeout: 60_000,
    });
    await expect(row(page, id)).not.toContainText("Refreshing…");
    await expect(row(page, id)).not.toContainText("Refreshed.");
    await expect(
      row(page, id).locator("[data-status-line]").first(),
    ).toBeVisible();
    await expect(
      row(page, id).getByRole("button", { name: /^Refresh/ }),
    ).toBeEnabled();
    expect(refreshes(wire, id)).toHaveLength(sent);
  });

  test("6(c) control: the same reload with no refresh running: the live list says so, nothing is shown as refreshing, and nothing is sent", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical6c-idle");
    const id = await link(page, wire, "I-CAL6c Idle", path);
    await untilQuiet(page, id);
    const before = await served(path);
    await reopen(page);
    await expect(row(page, id)).toHaveAttribute("data-observation", "idle", {
      timeout: 30_000,
    });
    await expect(row(page, id)).not.toContainText("Refreshing…");
    await expect(
      row(page, id).getByRole("button", { name: /^Refresh/ }),
    ).toBeEnabled();
    expect(refreshes(wire, id)).toEqual([]);
    expect(await served(path)).toBe(before);
  });
});

test.describe("I-CAL7: a superseded refresh (cause 4)", () => {
  test("a settings change while the refresh's fetch is held: 409 stale_refresh generation_changed, the live re-read, no automatic resend and no health inference", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical7");
    const id = await link(page, wire, "I-CAL7 Feed", path);
    await untilQuiet(page, id);
    await feedCtl("hold", { path });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect.poll(() => heldAt(path), { timeout: 20_000 }).toBe(1);
    await untilCached(page, id);
    await settings(page, "I-CAL7 Feed", { timezone: "Europe/Paris" });
    await expect
      .poll(async () => (await source(page, id))?.value.timezone, {
        timeout: 30_000,
      })
      .toBe("Europe/Paris");
    await feedCtl("release", { path });
    await expect(row(page, id)).toContainText(
      /A newer change replaced this refresh — refresh again to get the latest\.|The newer refresh finished:/,
      { timeout: 120_000 },
    );
    const log = (await proxy.log()).filter(
      (e) => e.path === `${API}/calendar-sources/${id}/refresh`,
    );
    expect(log.map((e) => e.status)).toContain(409);
    // One press, one request: a stale answer is never resent automatically.
    expect(refreshes(wire, id)).toHaveLength(1);
    await expect(row(page, id)).not.toContainText("Refreshed.");
  });
});

test.describe("I-CAL8: worker capacity (CH3, 7(f))", () => {
  test("two held fetches take both calendar slots: a third refresh is 503 temporarily_unavailable, handled as transient, and succeeds after the slots free", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const paths = [
      await newFeed("ical8-a"),
      await newFeed("ical8-b"),
      await newFeed("ical8-c"),
    ];
    const ids: string[] = [];
    for (const [i, path] of paths.entries())
      ids.push(await link(page, wire, `I-CAL8 Feed ${i}`, path));
    for (const id of ids) await untilQuiet(page, id);
    await feedCtl("hold", { path: paths[0] });
    await feedCtl("hold", { path: paths[1] });
    await row(page, ids[0] as string)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await row(page, ids[1] as string)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect
      .poll(
        async () =>
          (await heldAt(paths[0] as string)) +
          (await heldAt(paths[1] as string)),
        { timeout: 20_000 },
      )
      .toBe(2);
    const third = ids[2] as string;
    await row(page, third)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect
      .poll(
        async () =>
          (await proxy.log())
            .filter(
              (e) => e.path === `${API}/calendar-sources/${third}/refresh`,
            )
            .map((e) => e.status),
        { timeout: 20_000 },
      )
      .toContain(503);
    await expect(row(page, third)).toContainText("Refreshing…");
    await feedCtl("release", { path: paths[0] });
    await feedCtl("release", { path: paths[1] });
    await expect(row(page, third)).toContainText(
      "Refreshed. New events appear after the next sync.",
      { timeout: 120_000 },
    );
    expect(new Set(refreshes(wire, third).map((w) => w.key)).size).toBe(1);
  });
});

test.describe("I-CAL9: the import draft behind a queued create (WEB-13b's mechanism)", () => {
  test("held behind its create, sent to /calendar-sources/{id}/import with a real receipt, and a lost response resent byte-identically under the same key", async ({
    context,
  }) => {
    const { page, wire } = await ready(context, { begin: false });
    await page.getByRole("button", { name: "Add source" }).click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByLabel("Label").fill("I-CAL9 Import");
    await dialog.getByLabel("Timezone").fill("UTC");
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    const account = (
      await page.evaluate(
        () => window.__s.identity.get() as { account_id: string },
      )
    ).account_id;
    const drafts = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "drafts"),
      account,
    )) as Array<{ target_resource_ids: string[] }>;
    const sourceId = drafts[0]?.target_resource_ids[0] as string;
    const from = new Date().toISOString().slice(0, 10);
    const through = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const queued = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec as never),
      {
        endpoint: "/calendar-sources/{id}/import",
        targetId: sourceId,
        targets: [
          {
            resourceId: sourceId,
            role: "primary",
            basis: "resource",
            versionChecked: false,
            seedIfUntracked: 1,
          },
        ],
        command: { ics: ics("I-CAL9 imported"), from, through },
      },
    );
    expect(queued?.kind).toBe("queued");
    await proxy.addRule({
      method: "POST",
      path: `${API}/calendar-sources/${sourceId}/import`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(() => wire.length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(3);
    expect(wire.map((w) => w.path)).toEqual([
      "/calendar-commands",
      `/calendar-sources/${sourceId}/import`,
      `/calendar-sources/${sourceId}/import`,
    ]);
    expect(wire[2]?.key).toBe(wire[1]?.key);
    expect(wire[2]?.body).toBe(wire[1]?.body);
    const statuses = (await proxy.log())
      .filter((e) => e.path === `${API}/calendar-sources/${sourceId}/import`)
      .map((e) => e.status);
    expect(statuses).toEqual([200, 200]);
    await expect
      .poll(async () => (await events(page, sourceId)).length, {
        timeout: 30_000,
      })
      .toBe(1);
  });
});

test.describe("I-CAL10: turned off while refreshing (cause 6a)", () => {
  test("the source is turned off while the fetch is held: 422 invalid_value, the turned-off words with Turn on, and Refresh unavailable once the cache catches up", async ({
    context,
  }) => {
    const { page, wire } = await ready(context);
    const path = await newFeed("ical10");
    const id = await link(page, wire, "I-CAL10 Feed", path);
    await untilQuiet(page, id);
    await feedCtl("hold", { path });
    await row(page, id)
      .getByRole("button", { name: /^Refresh/ })
      .click();
    await expect.poll(() => heldAt(path), { timeout: 20_000 }).toBe(1);
    await untilCached(page, id);
    await settings(page, "I-CAL10 Feed", { enabled: false });
    await expect
      .poll(async () => (await source(page, id))?.archived, { timeout: 30_000 })
      .toBe(true);
    await feedCtl("release", { path });
    await expect(row(page, id)).toContainText(
      "This source is turned off — turn it back on to resume refreshing.",
      { timeout: 60_000 },
    );
    await expect(
      row(page, id).getByRole("button", { name: "Turn on" }),
    ).toBeVisible();
    expect(refreshes(wire, id)).toHaveLength(1);
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect(
      row(page, id).getByRole("button", { name: /^Refresh/ }),
    ).toBeDisabled({ timeout: 30_000 });
  });
});

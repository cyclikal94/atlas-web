import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  stubNetwork,
} from "./data-sync-helpers";

/**
 * E-C9 and E-C10 (revision 8: R16 and R17), in Chromium, Firefox and WebKit: the production session, the production data controller
 * (its runtime, plans, profile source and device mirror) and REAL IndexedDB, with the network stubbed. FIXTURE evidence: there is no
 * backend behind any of it, and a status the stub answers is a stub's, not a backend's. Nothing here starts a sync engine, a dispatcher
 * or the harness's gate: the pages carry only what production composes today (the earlier native probe of the review's own
 * dual-runtime fixture caveat).
 *
 * E-C9 (R16): a failed read of `GET /me` or `GET /sessions` is retried inside the data layer's per-caller budget. Two real tabs, a
 * healthy control, a 404, a 503 and a connection reset. Before the fix these made about 800 requests to each endpoint in two seconds,
 * and thousands of writes to `atlas-auth`, because every identity notification asked again and every request caused more of them.
 *
 * E-C10 (R17): a page that starts OFFLINE shows the name verified earlier for the same epoch, without a request and without creating
 * anything; an older epoch's name stays hidden; a name verified online is persisted for the next offline start.
 */
const ME = "**/api/experimental/v1/me";
const SESSIONS = "**/api/experimental/v1/sessions";
type Mode = "healthy" | "404" | "503" | "network";

const sessionsBody = () => ({
  sessions: [
    {
      id: "s1",
      device_id: "dev-1",
      current: true,
      authentication: "local",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  ],
});

/**
 * Counts the requests to both endpoints (and answers them as `mode` says), and the writes the page makes to `atlas-auth`. Call it
 * AFTER `stubNetwork`: the route registered last answers first, and the stub answers every other request of the API with a 404.
 */
async function serve(context: BrowserContext, mode: Mode, username = "Alice") {
  const counts = { me: 0, sessions: 0 };
  await context.addInitScript(() => {
    const w = window as unknown as { __authWrites: number };
    w.__authWrites = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === "atlas-auth") w.__authWrites += 1;
      return put.apply(this, args as never);
    };
  });
  for (const endpoint of ["me", "sessions"] as const)
    await context.route(endpoint === "me" ? ME : SESSIONS, (route) => {
      counts[endpoint] += 1;
      if (mode === "network") return route.abort("connectionreset");
      if (mode === "healthy")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            endpoint === "me" ? { id: ACCOUNT, username } : sessionsBody(),
          ),
        });
      return route.fulfill({
        status: Number(mode),
        contentType: "application/json",
        body: JSON.stringify({
          code: "temporarily_unavailable",
          message: "Injected by the test",
        }),
      });
    });
  return counts;
}

/** The account's database exists, as the first sync or a saved draft would have made it. */
async function createDatabase(context: BrowserContext): Promise<void> {
  await seedSettled(context);
  const seed = await context.newPage();
  await seed.goto("/__session?boot=off");
  await seed.waitForFunction(() => !!window.__atlasData);
  expect(
    await seed.evaluate((account) => {
      window.__atlasData?.setIdentity(account);
      return window.__atlasData?.open(account, { create: true });
    }, ACCOUNT),
  ).toBe("created");
  await seed.close();
}

const authWrites = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __authWrites: number }).__authWrites,
  );

test.describe("E-C9: the identity reads of two real tabs are bounded (R16)", () => {
  for (const mode of ["healthy", "404", "503", "network"] as const)
    test(`${mode}: at most five reads of each endpoint in two seconds across two tabs, and a bounded few in eight`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, mode);
      await createDatabase(context);
      const pages = [await bootSession(context), await bootSession(context)];
      // The production controller only: nothing here calls `startGate`, `startSync` or builds another controller.
      await pages[0]?.waitForTimeout(1_200);
      const before = { ...counts };
      // The reads were made (and counted): a count that stayed at zero would make every bound below vacuous.
      expect(before.me).toBeGreaterThanOrEqual(1);
      expect(before.sessions).toBeGreaterThanOrEqual(1);
      const writesBefore = await Promise.all(pages.map(authWrites));
      await pages[0]?.waitForTimeout(2_000);
      const window2s = {
        me: counts.me - before.me,
        sessions: counts.sessions - before.sessions,
      };
      const writes = (await Promise.all(pages.map(authWrites))).map(
        (n, i) => n - (writesBefore[i] ?? 0),
      );
      await pages[0]?.waitForTimeout(6_000);
      const whole = { ...counts };
      recordEvidence(info, `r16-${mode}`, { window2s, writes, whole });
      // The review's own lenient bound.
      expect(window2s.me).toBeLessThanOrEqual(5);
      expect(window2s.sessions).toBeLessThanOrEqual(5);
      // Instrumented writes to `atlas-auth`: a loop wrote thousands in two seconds.
      for (const n of writes) expect(n).toBeLessThanOrEqual(100);
      if (mode === "healthy") {
        // A healthy page asks once per mounted controller: a tab's protected tree may mount again in its first moments (another tab's
        // request is in flight), and each controller asks once. What it never does is ask again afterwards: nothing in the next
        // eight seconds, whatever the identity notifications.
        expect(before.me).toBeLessThanOrEqual(4);
        expect(before.sessions).toBeLessThanOrEqual(4);
        expect(whole).toEqual(before);
        expect(window2s).toEqual({ me: 0, sessions: 0 });
      } else {
        // Per tab: three attempts in the first seconds for an unrecognised answer (a pause follows), at most as many for the
        // network class (2 s, then 4 s, then 8 s).
        expect(whole.me).toBeLessThanOrEqual(8);
        expect(whole.sessions).toBeLessThanOrEqual(8);
      }
      for (const page of pages) await page.close();
    });

  test("404: the pause is durable: after it, tabs that reload ask nothing at all, neither the profile nor the mirror (R16)", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, "404");
    await createDatabase(context);
    const pages = [await bootSession(context), await bootSession(context)];
    // Three unrecognised answers pause the caller (shared by the tabs through the database): 0 s, 2 s, 6 s.
    await expect
      .poll(() => counts.me, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);
    await pages[0]?.waitForTimeout(9_000);
    const paused = { ...counts };
    expect(paused.me).toBeLessThanOrEqual(4);
    expect(paused.sessions).toBeLessThanOrEqual(4);
    await pages[0]?.waitForTimeout(3_000);
    expect(counts).toEqual(paused);
    for (const page of pages) await page.close();
    const reloaded = [await bootSession(context), await bootSession(context)];
    await reloaded[0]?.waitForTimeout(4_000);
    const after = { ...counts };
    recordEvidence(info, "r16-404-reload", { paused, after });
    // Nothing: a reloaded page asks `/me` only after it has looked for the account's database and read the paused entry there. (The
    // first revision of this test allowed one more `/me` per tab, made before the database was bound.)
    expect(after).toEqual(paused);
    await reloaded[0]?.waitForTimeout(6_000);
    expect(counts).toEqual(after);
    for (const page of reloaded) await page.close();
  });

  test("503: nothing is asked while the page is offline, and `online` asks again at once", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, "503");
    await createDatabase(context);
    const pages = [await bootSession(context), await bootSession(context)];
    await expect.poll(() => counts.me).toBeGreaterThanOrEqual(2);
    await context.setOffline(true);
    await pages[0]?.waitForTimeout(500);
    const offline = { ...counts };
    // The first back-off (2 s) elapses and the second (4 s) is under way: an offline page asks nothing.
    await pages[0]?.waitForTimeout(7_000);
    expect(counts).toEqual(offline);
    await context.setOffline(false);
    await expect
      .poll(() => counts.me - offline.me, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
    recordEvidence(info, "r16-503-online", { offline, after: { ...counts } });
    for (const page of pages) await page.close();
  });
});

async function seedProfile(
  context: BrowserContext,
  profile: { username: string; verified_epoch: number },
): Promise<void> {
  await createDatabase(context);
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(() => !!window.__atlasData);
  await page.evaluate(
    ({ account, stored }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(`atlas-${account}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("sync_state", "readwrite");
          const store = tx.objectStore("sync_state");
          const get = store.get("singleton");
          get.onsuccess = () =>
            store.put({
              ...get.result,
              cache_status: "valid",
              profile: { ...stored, verified_at: 5 },
            });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { account: ACCOUNT, stored: profile },
  );
  await page.close();
}

const persistedProfile = (page: Page) =>
  page.evaluate(
    (account) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open(`atlas-${account}`);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db
            .transaction("sync_state")
            .objectStore("sync_state")
            .get("singleton");
          get.onsuccess = () => {
            db.close();
            resolve(get.result?.profile ?? null);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    ACCOUNT,
  );

const offline = (context: BrowserContext) =>
  context.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    }),
  );

test.describe("E-C10: an offline start shows the name verified for this epoch (R17)", () => {
  for (const [name, epoch, shown] of [
    ["the same epoch", 1, true],
    ["an older epoch", 0, false],
  ] as const)
    test(`${name}: the name is ${shown ? "shown" : "hidden"}, nothing is requested, and the database is not created or changed`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, "healthy", "Offline Alice");
      await seedProfile(context, {
        username: "Offline Alice",
        verified_epoch: epoch,
      });
      await offline(context);
      const page = await bootSession(context);
      await expect
        .poll(() =>
          page.evaluate(
            (account) => window.__atlasData?.openCount(account) ?? 0,
            ACCOUNT,
          ),
        )
        .toBeGreaterThan(0);
      if (shown)
        await expect(
          page.getByText("Offline Alice", { exact: true }).first(),
        ).toBeVisible();
      else {
        await page.waitForTimeout(1_500);
        await expect(
          page.getByText("Offline Alice", { exact: true }),
        ).toHaveCount(0);
      }
      await page.waitForTimeout(500);
      expect(counts).toEqual({ me: 0, sessions: 0 });
      recordEvidence(info, `r17-offline-${name.replace(/ /g, "-")}`, {
        shown: await page.getByText("Offline Alice", { exact: true }).count(),
        counts,
      });
      await page.close();
    });

  test("no database at all: nothing is shown and nothing is created", async ({
    context,
  }) => {
    await stubNetwork(context);
    const counts = await serve(context, "healthy", "Offline Alice");
    await seedSettled(context);
    await offline(context);
    const page = await bootSession(context);
    await page.waitForTimeout(1_500);
    await expect(page.getByText("Offline Alice", { exact: true })).toHaveCount(
      0,
    );
    expect(counts).toEqual({ me: 0, sessions: 0 });
    expect(
      await page.evaluate(
        async (account) =>
          (await indexedDB.databases()).some(
            (database) => database.name === `atlas-${account}`,
          ),
        ACCOUNT,
      ),
    ).toBe(false);
    await page.close();
  });

  test("a name verified online is persisted, and the next offline start shows it with no request", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, "healthy", "Online Alice");
    await createDatabase(context);
    const first = await bootSession(context);
    await expect(
      first.getByText("Online Alice", { exact: true }).first(),
    ).toBeVisible();
    // Whichever of the database and the answer arrived first, the name verified for this epoch ends up in the database.
    await expect
      .poll(() => persistedProfile(first), { timeout: 10_000 })
      .toMatchObject({ username: "Online Alice", verified_epoch: 1 });
    await first.close();
    // A new page of the same browser profile, offline: the persisted name, and no request.
    const before = { ...counts };
    await offline(context);
    const page = await bootSession(context);
    await expect
      .poll(() =>
        page.evaluate(
          (account) => window.__atlasData?.openCount(account) ?? 0,
          ACCOUNT,
        ),
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByText("Online Alice", { exact: true }).first(),
    ).toBeVisible();
    await page.waitForTimeout(500);
    expect(counts).toEqual(before);
    recordEvidence(info, "r17-persisted-then-offline", {
      counts,
      persisted: await persistedProfile(page),
    });
    await page.close();
  });
});

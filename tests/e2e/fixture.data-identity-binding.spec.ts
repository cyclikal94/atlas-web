import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  bootSession,
  bootSessionAfter,
  seedSettled,
  stubNetwork,
} from "./data-sync-helpers";

/**
 * E-C11 (revision 9: R16 binding order and R18 response shapes), in Chromium, Firefox and WebKit: the production session, the
 * production data controller and REAL IndexedDB, with the network stubbed. FIXTURE evidence: no backend is behind any of it, a status
 * or a body the stub answers is the stub's, and the held `indexedDB.databases()` is a deliberate ordering probe (the account-database
 * port lists the databases before it opens one), not a measured device stall.
 *
 * R16: a page used to ask `GET /me` before the controller had attached the account's database, so a reload or a remount supplied one
 * request that the stored (paused) budget forbade. It now asks nothing until it has looked for the database: a durable pause is
 * honoured from the first moment (zero requests across three remounts), a database that exists but is not paused is asked as before,
 * and a database that does not exist is asked on the page's memory once the look has finished.
 *
 * R18: a `200` whose body is not the contract's is an unrecognised answer: never a label, never a verified device, counted (three in a
 * row pause the caller), and a repaired answer verifies.
 *
 * R16 again (revision 10, "a look that FAILS is not an answer"): a controller whose LOOK for the database fails (here
 * `indexedDB.databases()` rejects with `UnknownError`, injected by an init script: a NAMED injection, not a genuine device storage
 * failure) used to take the failure for "there is no database" and start every page with a fresh in-memory budget, so each remount
 * asked `/me` again over a database holding a durable pause (the review: six requests over three pages in each engine). It now keeps
 * waiting, asks nothing, looks again on its own pace, and reads the budget once it can.
 *
 * R34 (revision 19): the faults of this file (a listing that is held or fails, an open of the account's database that fails) were installed
 * by `context.addInitScript`, and the tests looked at fixed moments (two seconds after `bootSession` returned; 700 ms for a listing held
 * 1.5 s). They failed in WebKit in revisions 17 and 18, at a rate of one in about 8 to 15 runs of the affected cases, always in one of two
 * ways: the page had asked `/me` and `/sessions` while the fault was to be holding it back, or its registry held two connections
 * (`openCount` 2, a complete open: the strict and the fast connection) while every open was to fail for ever.
 *
 * What was investigated, and what it showed. (1) The look fell outside the failed interval on a slow runner: REFUTED by measurement. The
 * controller looks again on its own back-off (250 ms doubling), so the first open or listing that is let through comes about 7.8 s after
 * the install (0.0, 0.25, 0.75, 1.75, 3.75 and 7.75 s, in the same sequence in all three engines in 24 observed runs), and the old look at
 * two seconds would have to be about 5.8 s late; the longest boot measured, under a load average of 50, was 395 ms. (2) The preserved failing
 * traces show the opposite of a late look: the first `/me` and `/sessions` of a page arrived 0.65 s into its life and the database was
 * bound 2.06 s in, inside a window that held for four seconds, with a fault that was for ever. A page does that only when the fault is NOT
 * in force. All of the failing shapes (the held listing that did not hold, the listing that did not fail, the open that did not fail, timed
 * or for ever) are one: the context-level init script was not in force in that page, in WebKit only. The driver installs a context's init
 * scripts into a page with `Page.setBootstrapScript` through a call that may fail without saying so, and a page whose process is swapped
 * on its first navigation is resumed only if the engine created its target paused (`playwright-core` 1.63, `WKPage._initializeSession`),
 * so a document can run before its script is installed; no failing run recorded whether the script had run. (3) What is NOT established:
 * that exact driver race was not observed (over a thousand WebKit pages, loaded to a load average of 50 and not, with and without the default
 * page, never lacked the script), so this is the mechanism the evidence supports and not one that was caught.
 *
 * What the tests do now. The fault is installed in the LIVE page (`?boot=manual`: the page is loaded, the application is not started) and
 * checked, and only then does the application start, so there is no moment at which it could be absent; the page records what it did
 * (`window.__atlasFaults`: each open and listing it saw and whether it failed it, whether its entry points are still the installed ones,
 * and the instant the first one was let through); the failed interval is OBSERVED (the test waits for the page's own first pass-through,
 * never for a time) and "nothing was asked while it failed" is checked against that record and the instants at which the requests arrived;
 * and each premise (the page met the fault) is asserted from the page's record before anything else, so that a page without the fault fails
 * by saying so. The durations are the original ones, unshortened (four seconds; 1.5 s for a held listing).
 */
const ME = "**/api/experimental/v1/me";
const SESSIONS = "**/api/experimental/v1/sessions";

const sessionsBody = (rows?: unknown[]) => ({
  sessions: rows ?? [
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

/** Counts the requests to both endpoints and answers them with what the test says (a function, so it can change). */
async function serve(
  context: BrowserContext,
  answer: {
    me: () => { status: number; body: unknown };
    sessions: () => { status: number; body: unknown };
  },
) {
  const counts = { me: 0, sessions: 0 };
  /**
   * `Date.now()` of each request as the test saw it arrive (R34, revision 19), for "nothing was asked while the fault was in force". Not
   * enumerable: `expect(counts).toEqual({ me: 0, sessions: 0 })` compares the counts alone.
   */
  const stamps: { me: number[]; sessions: number[] } = {
    me: [],
    sessions: [],
  };
  Object.defineProperty(counts, "stamps", { value: stamps, enumerable: false });
  for (const endpoint of ["me", "sessions"] as const)
    await context.route(endpoint === "me" ? ME : SESSIONS, (route) => {
      counts[endpoint] += 1;
      stamps[endpoint].push(Date.now());
      const { status, body } = answer[endpoint]();
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  return counts as typeof counts & { stamps: typeof stamps };
}

/** The account's database exists, as the first sync or a saved draft would have made it; optionally with a durable pause. */
async function createDatabase(
  context: BrowserContext,
  pause?: "unrecognised" | "duration",
  profile?: { username: string; verified_epoch: number },
): Promise<void> {
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
  if (profile !== undefined)
    await seed.evaluate(
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
  if (pause !== undefined)
    await seed.evaluate(
      ({ account, kind }) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(`atlas-${account}`);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("sync_state", "readwrite");
            const store = tx.objectStore("sync_state");
            const get = store.get("singleton");
            get.onsuccess = () => {
              const entry =
                kind === "unrecognised"
                  ? {
                      paused: true,
                      backing_off_since: null,
                      unrecognised_streak: 3,
                    }
                  : {
                      paused: true,
                      backing_off_since: Date.now() - 600_000,
                      unrecognised_streak: 0,
                    };
              store.put({
                ...get.result,
                read_retry_states: {
                  "profile:1": entry,
                  "device:1": entry,
                },
              });
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      { account: ACCOUNT, kind: pause },
    );
  await seed.close();
}

/**
 * What a fault installed in the live page did (R34, revision 19), as the page recorded it. Every instant is `Date.now()` of the page, which is
 * the clock of the test process too.
 */
interface FaultRecord {
  installedAt: number;
  /** Opens of the account's database that the page made: the instant of each, and whether the fault failed it. */
  opens: Array<[number, "fail" | "pass"]>;
  firstOpenPassAt: number | null;
  /** The connections the page's registry held at the instant the first open was let through (the database must not be bound before). */
  boundBeforeFirstOpenPass: number | null;
  /** Listings of databases that the page made: the instant of each call, what the fault did with it, and the instant a held one returned. */
  listings: Array<[number, "fail" | "held" | "pass", number | null]>;
  firstListingPassAt: number | null;
  boundBeforeFirstListingPass: number | null;
  /** Whether the text asked for (`watchText`) was on the page at the instant the first listing was let through. */
  textAtFirstListingPass: boolean | null;
  /**
   * Whether the entry points this record installed are still the ones the page's `indexedDB` has when the record is READ (`null`: not
   * installed). A fault that had been lost from the engine's object would make the page bind a database whose opens were to fail.
   */
  intact?: { open: boolean | null; databases: boolean | null };
}

interface Faults {
  /** `indexedDB.open` of the account's database returns a request that fails with this name: for ever, or for `untilMs` from the install. */
  open?: { name: string; untilMs?: number };
  /** `indexedDB.databases()` rejects with `UnknownError` (for ever or for `untilMs`), or returns `ms` after the real listing. */
  listing?: { kind: "fail"; untilMs?: number } | { kind: "hold"; ms: number };
  /** `navigator.onLine` is false. */
  offline?: boolean;
  /** Text whose presence is recorded when the first listing is let through. */
  watchText?: string;
}

/**
 * Installs the faults in the LIVE page, which is loaded but not started (`bootSessionAfter`), and says so when they are not in force. The
 * named injections are the ones the init scripts made: not genuine storage failures, and other databases and the other entry points of
 * `indexedDB` are untouched.
 */
const installFaults = (faults: Faults) => async (page: Page) => {
  const installed = await page.evaluate(
    ({ name, spec }) => {
      const record: FaultRecord = {
        installedAt: Date.now(),
        opens: [],
        firstOpenPassAt: null,
        boundBeforeFirstOpenPass: null,
        listings: [],
        firstListingPassAt: null,
        boundBeforeFirstListingPass: null,
        textAtFirstListingPass: null,
      };
      (window as unknown as { __atlasFaults: FaultRecord }).__atlasFaults =
        record;
      const account = (db: string) => db.replace(/^atlas-/, "");
      const bound = () => window.__atlasData?.openCount(account(name)) ?? -1;
      if (spec.open !== undefined) {
        const { name: errorName, untilMs } = spec.open;
        const original = indexedDB.open.bind(indexedDB);
        indexedDB.open = ((target: string, version?: number) => {
          if (target !== name) return original(target, version);
          const failing =
            untilMs === undefined || Date.now() - record.installedAt < untilMs;
          record.opens.push([Date.now(), failing ? "fail" : "pass"]);
          if (!failing) {
            if (record.firstOpenPassAt === null) {
              record.boundBeforeFirstOpenPass = bound();
              record.firstOpenPassAt = Date.now();
            }
            return original(target, version);
          }
          const request = {
            error: new DOMException("Injected open failure", errorName),
            readyState: "done",
            result: undefined,
            transaction: null,
            source: null,
            onerror: null as null | ((event: unknown) => void),
            onblocked: null,
            onupgradeneeded: null,
            onsuccess: null,
          };
          setTimeout(
            () =>
              request.onerror?.({
                target: request,
                preventDefault() {},
                stopPropagation() {},
              }),
            0,
          );
          return request as unknown as IDBOpenDBRequest;
        }) as typeof indexedDB.open;
        (
          window as unknown as { __atlasFaultEntries: Record<string, unknown> }
        ).__atlasFaultEntries = {
          ...(
            window as unknown as {
              __atlasFaultEntries?: Record<string, unknown>;
            }
          ).__atlasFaultEntries,
          open: indexedDB.open,
        };
      }
      if (spec.listing !== undefined) {
        const listing = spec.listing;
        const databases = indexedDB.databases.bind(indexedDB);
        const letThrough = () => {
          if (record.firstListingPassAt === null) {
            record.boundBeforeFirstListingPass = bound();
            record.textAtFirstListingPass =
              spec.watchText === undefined
                ? null
                : document.body.innerText.includes(spec.watchText);
            record.firstListingPassAt = Date.now();
          }
        };
        indexedDB.databases = async () => {
          const at = Date.now();
          if (listing.kind === "fail") {
            const failing =
              listing.untilMs === undefined ||
              at - record.installedAt < listing.untilMs;
            record.listings.push([at, failing ? "fail" : "pass", null]);
            if (failing)
              throw new DOMException(
                "Injected listing failure",
                "UnknownError",
              );
            letThrough();
            return databases();
          }
          const entry: [number, "fail" | "held" | "pass", number | null] = [
            at,
            "held",
            null,
          ];
          record.listings.push(entry);
          const rows = await databases();
          await new Promise((resolve) => setTimeout(resolve, listing.ms));
          entry[2] = Date.now();
          letThrough();
          return rows;
        };
        (
          window as unknown as { __atlasFaultEntries: Record<string, unknown> }
        ).__atlasFaultEntries = {
          ...(
            window as unknown as {
              __atlasFaultEntries?: Record<string, unknown>;
            }
          ).__atlasFaultEntries,
          databases: indexedDB.databases,
        };
      }
      if (spec.offline === true)
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          get: () => false,
        });
      return true;
    },
    {
      name: `atlas-${ACCOUNT}`,
      spec: faults,
    },
  );
  expect(installed, "the fault is installed in the live page").toBe(true);
};

/** The page's record of what its faults did, with whether its entry points are still in place. */
const faultsOf = (page: Page): Promise<FaultRecord | null> =>
  page.evaluate(() => {
    const record =
      (window as unknown as { __atlasFaults?: FaultRecord }).__atlasFaults ??
      null;
    if (record === null) return null;
    const entries =
      (window as unknown as { __atlasFaultEntries?: Record<string, unknown> })
        .__atlasFaultEntries ?? {};
    return {
      ...record,
      intact: {
        open: "open" in entries ? indexedDB.open === entries.open : null,
        databases:
          "databases" in entries
            ? indexedDB.databases === entries.databases
            : null,
      },
    };
  });

/**
 * Waits for the page to let its first open of the account's database through (the failed interval is over), and reads its record. The
 * wait is shorter than the test's own timeout (30 s), so that a page that stops opening fails HERE, by an assertion, and not by the test
 * timing out: the interval is four seconds and the controller looks again on its own pace (250 ms doubling).
 */
const afterFailedOpens = async (page: Page): Promise<FaultRecord> => {
  await expect
    .poll(async () => (await faultsOf(page))?.firstOpenPassAt ?? null, {
      timeout: 15_000,
    })
    .not.toBeNull();
  return (await faultsOf(page)) as FaultRecord;
};

/** Waits for the page's first listing to be let through (a held one has returned), and reads its record. */
const afterFailedListing = async (page: Page): Promise<FaultRecord> => {
  await expect
    .poll(async () => (await faultsOf(page))?.firstListingPassAt ?? null, {
      timeout: 15_000,
    })
    .not.toBeNull();
  return (await faultsOf(page)) as FaultRecord;
};

/** The requests that arrived before `instant`. */
const askedBefore = (times: number[], instant: number) =>
  times.filter((time) => time < instant);

/** The failed interval the timed faults make, unshortened (R12, R16: four seconds from the page's start). */
const FAILED_INTERVAL_MS = 4_000;

/**
 * The premise of a timed fault, from the page's own record and before anything else is asserted: the page met failures (the fault was in
 * force and the controller tried), and the first open or listing it let through came no earlier than the required interval after the
 * install.
 */
const expectFailedInterval = (
  attempts: ReadonlyArray<readonly unknown[]>,
  record: FaultRecord,
  passAt: number | null,
) => {
  expect(attempts.some((attempt) => attempt[1] === "fail")).toBe(true);
  expect((passAt ?? 0) - record.installedAt).toBeGreaterThanOrEqual(
    FAILED_INTERVAL_MS,
  );
  // The entry points the fault installed are still the page's.
  expect(Object.values(record.intact ?? {})).not.toContain(false);
};

/** How many times this page's controller has opened the account's database (it has bound it, once it is more than zero). */
const opened = (page: Page) =>
  page.evaluate(
    (account) => window.__atlasData?.openCount(account) ?? 0,
    ACCOUNT,
  );

const syncState = (page: Page) =>
  page.evaluate(
    (account) =>
      new Promise<Record<string, unknown> | null>((resolve, reject) => {
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
            resolve(get.result ?? null);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    ACCOUNT,
  );

const NOT_FOUND = { status: 404, body: { code: "not_found", message: "stub" } };

test.describe("E-C11: the database binds late (R16)", () => {
  for (const pause of ["unrecognised", "duration"] as const)
    test(`a durable pause by ${pause}: not one request across three remounts, with the database listing held for 1.5 s`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, {
        me: () => NOT_FOUND,
        sessions: () => NOT_FOUND,
      });
      await createDatabase(context, pause);
      const visits: Array<{ me: number; sessions: number }> = [];
      const faults: FaultRecord[] = [];
      for (let i = 0; i < 3; i += 1) {
        const page = await bootSessionAfter(
          context,
          installFaults({ listing: { kind: "hold", ms: 1_500 } }),
        );
        // The held listing returns at 1.5 s: the page has then read the budget. Wait well beyond it.
        await page.waitForTimeout(3_500);
        visits.push({ ...counts });
        faults.push((await faultsOf(page)) as FaultRecord);
        await page.close();
      }
      recordEvidence(info, `r16-late-binding-${pause}`, { visits, faults });
      // The premise: every visit's first listing was held (the fault was in force), and nothing was asked.
      for (const record of faults) expect(record.listings[0]?.[1]).toBe("held");
      expect(counts).toEqual({ me: 0, sessions: 0 });
    });

  test("control: an existing database that is not paused: nothing while the listing is held, then both endpoints are asked", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context);
    const page = await bootSessionAfter(
      context,
      installFaults({ listing: { kind: "hold", ms: 1_500 } }),
    );
    // Held: the page cannot read a budget yet, so it asks nothing. The held interval is OBSERVED to its end (the instant the held listing
    // returned), not sampled 700 ms after the boot: a slow boot cannot move the look outside it.
    const held = await afterFailedListing(page);
    recordEvidence(info, "r16-late-binding-control-held", {
      held,
      stamps: counts.stamps,
    });
    expect(held.listings[0]?.[1]).toBe("held");
    expect(held.boundBeforeFirstListingPass).toBe(0);
    expect(
      askedBefore(counts.stamps.me, held.firstListingPassAt as number),
    ).toEqual([]);
    expect(
      askedBefore(counts.stamps.sessions, held.firstListingPassAt as number),
    ).toEqual([]);
    await expect.poll(() => counts.me, { timeout: 12_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => counts.sessions, { timeout: 12_000 })
      .toBeGreaterThan(0);
    recordEvidence(info, "r16-late-binding-control", { ...counts });
    await page.close();
  });

  test("control: no database at all: once the look has finished the page asks `/me` on its own memory, never the mirror, and creates nothing", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => ({
        status: 200,
        body: { id: ACCOUNT, username: "Absent Alice" },
      }),
      sessions: () => ({ status: 200, body: sessionsBody() }),
    });
    await seedSettled(context);
    const page = await bootSessionAfter(
      context,
      installFaults({ listing: { kind: "hold", ms: 1_500 } }),
    );
    const held = await afterFailedListing(page);
    recordEvidence(info, "r16-late-binding-absent-held", {
      held,
      stamps: counts.stamps,
    });
    expect(held.listings[0]?.[1]).toBe("held");
    expect(
      askedBefore(counts.stamps.me, held.firstListingPassAt as number),
    ).toEqual([]);
    expect(
      askedBefore(counts.stamps.sessions, held.firstListingPassAt as number),
    ).toEqual([]);
    await expect.poll(() => counts.me, { timeout: 12_000 }).toBeGreaterThan(0);
    await expect(
      page.getByText("Absent Alice", { exact: true }).first(),
    ).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(counts.sessions).toBe(0);
    expect(
      await page.evaluate(
        async (account) =>
          (await indexedDB.databases()).some(
            (database) => database.name === `atlas-${account}`,
          ),
        ACCOUNT,
      ),
    ).toBe(false);
    recordEvidence(info, "r16-late-binding-absent", { ...counts });
    await page.close();
  });
});

test.describe("E-C11: a body that is not the contract's is never a verification (R18)", () => {
  for (const [name, body] of [
    ["no username", { id: ACCOUNT }],
    ["a numeric username", { id: ACCOUNT, username: 42 }],
    [
      "another account's id",
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", username: "Alice" },
    ],
  ] as const)
    test(`/me with ${name}: no label, three asked then paused, and the entry says so`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, {
        me: () => ({ status: 200, body }),
        sessions: () => ({ status: 200, body: sessionsBody() }),
      });
      await createDatabase(context);
      const page = await bootSession(context);
      await expect.poll(() => counts.me, { timeout: 15_000 }).toBe(3);
      await page.waitForTimeout(3_000);
      expect(counts.me).toBe(3);
      await expect(page.getByText("Alice", { exact: true })).toHaveCount(0);
      const state = await syncState(page);
      recordEvidence(info, `r18-me-${name.replace(/ /g, "-")}`, {
        counts,
        entry: (state?.read_retry_states as Record<string, unknown>)?.[
          "profile:1"
        ],
      });
      expect(
        (state?.read_retry_states as Record<string, unknown>)?.["profile:1"],
      ).toMatchObject({ paused: true, unrecognised_streak: 3 });
      await page.close();
    });

  test("/me answers valid after two malformed answers: the label appears and nothing is left behind", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    let asked = 0;
    const counts = await serve(context, {
      me: () => {
        asked += 1;
        return {
          status: 200,
          body:
            asked < 3
              ? { id: ACCOUNT, username: null }
              : { id: ACCOUNT, username: "Repaired Alice" },
        };
      },
      sessions: () => ({ status: 200, body: sessionsBody() }),
    });
    await createDatabase(context);
    const page = await bootSession(context);
    await expect(
      page.getByText("Repaired Alice", { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_000);
    const state = await syncState(page);
    recordEvidence(info, "r18-me-repaired", { counts });
    expect(counts.me).toBe(3);
    expect(
      (state?.read_retry_states as Record<string, unknown>)?.["profile:1"],
    ).toBeUndefined();
    await page.close();
  });

  for (const [name, rows] of [
    ["a null device id", [{ id: "s1", device_id: null, current: true }]],
    ["a numeric device id", [{ id: "s1", device_id: 42, current: true }]],
    ["a truthy current", [{ id: "s1", device_id: "dev-1", current: "yes" }]],
    ["a null row", [null]],
  ] as const)
    test(`/sessions with ${name}: the device is never verified, and it is counted as unrecognised`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, {
        me: () => ({ status: 200, body: { id: ACCOUNT, username: "Alice" } }),
        sessions: () => ({ status: 200, body: sessionsBody([...rows]) }),
      });
      await createDatabase(context);
      const page = await bootSession(context);
      await expect.poll(() => counts.sessions, { timeout: 15_000 }).toBe(3);
      await page.waitForTimeout(3_000);
      expect(counts.sessions).toBe(3);
      const state = await syncState(page);
      recordEvidence(info, `r18-sessions-${name.replace(/ /g, "-")}`, {
        counts,
        device: state?.device_id,
        verified: state?.device_verified,
      });
      expect(state?.device_verified).toBe(false);
      expect(state?.device_id).toBeNull();
      expect(
        (state?.read_retry_states as Record<string, unknown>)?.["device:1"],
      ).toMatchObject({ paused: true, unrecognised_streak: 3 });
      await page.close();
    });

  test("/sessions with the contract's body verifies the device (the valid control)", async ({
    context,
  }) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => ({ status: 200, body: { id: ACCOUNT, username: "Alice" } }),
      sessions: () => ({ status: 200, body: sessionsBody() }),
    });
    await createDatabase(context);
    const page = await bootSession(context);
    await expect
      .poll(async () => (await syncState(page))?.device_verified, {
        timeout: 12_000,
      })
      .toBe(true);
    expect((await syncState(page))?.device_id).toBe("dev-1");
    expect(counts.sessions).toBe(1);
    await page.close();
  });
});

test.describe("E-C11: a look that FAILS is not an answer (R16, revision 10)", () => {
  for (const pause of ["unrecognised", "duration"] as const)
    test(`a listing that fails for ever, a durable pause by ${pause}: not one request across three remounts`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, {
        me: () => NOT_FOUND,
        sessions: () => NOT_FOUND,
      });
      await createDatabase(context, pause);
      const visits: Array<{ me: number; sessions: number }> = [];
      const faults: Array<{ record: FaultRecord | null; opened: number }> = [];
      for (let i = 0; i < 3; i += 1) {
        const page = await bootSessionAfter(
          context,
          installFaults({ listing: { kind: "fail" } }),
        );
        await page.waitForTimeout(2_500);
        visits.push({ ...counts });
        // The look is not an answer: the controller never bound the database, and nothing was asked.
        const bound = await opened(page);
        faults.push({ record: await faultsOf(page), opened: bound });
        recordEvidence(info, `r16-failed-listing-${pause}-visit-${i}`, {
          faults: faults.at(-1),
          counts: { ...counts },
        });
        // The premise, recorded with the page: the fault was in force and the page met it.
        expect(faults.at(-1)?.record?.listings[0]?.[1]).toBe("fail");
        expect(faults.at(-1)?.record?.intact?.databases).toBe(true);
        expect(bound).toBe(0);
        await page.close();
      }
      recordEvidence(info, `r16-failed-listing-${pause}`, { visits, faults });
      expect(counts).toEqual({ me: 0, sessions: 0 });
    });

  test("control: the same paused database with a listing that works: zero requests (the budget is read)", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context, "unrecognised");
    for (let i = 0; i < 3; i += 1) {
      const page = await bootSession(context);
      await page.waitForTimeout(2_500);
      expect(await opened(page)).toBeGreaterThan(0);
      await page.close();
    }
    recordEvidence(info, "r16-failed-listing-control-paused", { ...counts });
    expect(counts).toEqual({ me: 0, sessions: 0 });
  });

  test("control: a healthy database, no pause, a listing that works: both endpoints are asked", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context);
    const page = await bootSession(context);
    await expect.poll(() => counts.me, { timeout: 12_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => counts.sessions, { timeout: 12_000 })
      .toBeGreaterThan(0);
    recordEvidence(info, "r16-failed-listing-control-healthy", { ...counts });
    await page.close();
  });

  for (const pause of ["unrecognised", "duration"] as const)
    test(`a listing that fails for 4 s and then RECOVERS, a durable pause by ${pause}: the database is bound, the budget is read, and still not one request`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, {
        me: () => NOT_FOUND,
        sessions: () => NOT_FOUND,
      });
      await createDatabase(context, pause);
      const page = await bootSessionAfter(
        context,
        installFaults({ listing: { kind: "fail", untilMs: 4_000 } }),
      );
      // The failed interval is OBSERVED to its end: the instant the page's first listing was let through, not a sample two seconds after
      // the boot (a slow boot or sleep moved that outside the four seconds).
      const record = await afterFailedListing(page);
      recordEvidence(info, `r16-failed-listing-interval-${pause}`, {
        record,
        counts: { ...counts },
      });
      expectFailedInterval(record.listings, record, record.firstListingPassAt);
      // Never bound while the look failed, and nothing was asked.
      expect(record.boundBeforeFirstListingPass).toBe(0);
      expect(counts).toEqual({ me: 0, sessions: 0 });
      // The look is made again on its own pace (250 ms doubling): it lands once the listing works.
      await expect
        .poll(() => opened(page), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await page.waitForTimeout(6_000);
      recordEvidence(info, `r16-failed-listing-recovers-${pause}`, {
        ...counts,
      });
      expect(counts).toEqual({ me: 0, sessions: 0 });
      await page.close();
    });

  test("a listing that fails for 4 s and then recovers, no pause: nothing while it fails, then both endpoints are asked (the control of the above)", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context);
    const page = await bootSessionAfter(
      context,
      installFaults({ listing: { kind: "fail", untilMs: 4_000 } }),
    );
    const record = await afterFailedListing(page);
    recordEvidence(info, "r16-failed-listing-interval-healthy", {
      record,
      stamps: counts.stamps,
    });
    expectFailedInterval(record.listings, record, record.firstListingPassAt);
    // Nothing was asked while the listing failed (every request arrived after the first listing that was let through).
    expect(
      askedBefore(counts.stamps.me, record.firstListingPassAt as number),
    ).toEqual([]);
    expect(
      askedBefore(counts.stamps.sessions, record.firstListingPassAt as number),
    ).toEqual([]);
    await expect.poll(() => counts.me, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => counts.sessions, { timeout: 30_000 })
      .toBeGreaterThan(0);
    recordEvidence(info, "r16-failed-listing-recovers-healthy", { ...counts });
    await page.close();
  });

  test("a listing that fails for 4 s and then finds NO database: the page asks `/me` on its own memory, never the mirror, and creates nothing", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => ({
        status: 200,
        body: { id: ACCOUNT, username: "Absent Alice" },
      }),
      sessions: () => ({ status: 200, body: sessionsBody() }),
    });
    await seedSettled(context);
    const page = await bootSessionAfter(
      context,
      installFaults({ listing: { kind: "fail", untilMs: 4_000 } }),
    );
    const record = await afterFailedListing(page);
    recordEvidence(info, "r16-failed-listing-interval-absent", {
      record,
      stamps: counts.stamps,
    });
    expectFailedInterval(record.listings, record, record.firstListingPassAt);
    expect(
      askedBefore(counts.stamps.me, record.firstListingPassAt as number),
    ).toEqual([]);
    expect(
      askedBefore(counts.stamps.sessions, record.firstListingPassAt as number),
    ).toEqual([]);
    await expect.poll(() => counts.me, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(
      page.getByText("Absent Alice", { exact: true }).first(),
    ).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(counts.sessions).toBe(0);
    expect(
      await page.evaluate(
        async (account) =>
          (await indexedDB.databases()).some(
            (database) => database.name === `atlas-${account}`,
          ),
        ACCOUNT,
      ),
    ).toBe(false);
    recordEvidence(info, "r16-failed-listing-then-absent", { ...counts });
    await page.close();
  });

  test("an OFFLINE start with a persisted name and a listing that fails for 4 s: the name is hidden meanwhile and appears when the look lands, with no request", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => ({
        status: 200,
        body: { id: ACCOUNT, username: "Offline Alice" },
      }),
      sessions: () => ({ status: 200, body: sessionsBody() }),
    });
    await createDatabase(context, undefined, {
      username: "Offline Alice",
      verified_epoch: 1,
    });
    const page = await bootSessionAfter(
      context,
      installFaults({
        offline: true,
        listing: { kind: "fail", untilMs: 4_000 },
        watchText: "Offline Alice",
      }),
    );
    const record = await afterFailedListing(page);
    recordEvidence(info, "r16-failed-listing-interval-offline", {
      record,
      stamps: counts.stamps,
    });
    expectFailedInterval(record.listings, record, record.firstListingPassAt);
    // The name is hidden meanwhile: it was not on the page at the instant the first listing was let through.
    expect(record.textAtFirstListingPass).toBe(false);
    await expect(
      page.getByText("Offline Alice", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(counts).toEqual({ me: 0, sessions: 0 });
    recordEvidence(info, "r16-failed-listing-offline-hydration", { ...counts });
    await page.close();
  });
});

test.describe("E-C11: an aborted OPEN REQUEST of an existing database is not an absence (R12, revision 11)", () => {
  // `AbortError` is the one the adapter used to read as "the database does not exist" (the opener answered `absent`, the controller took
  // that for an answer, and every remount asked `/me` on a fresh in-memory budget over a database that holds a durable pause).
  for (const fault of ["AbortError", "UnknownError"] as const)
    for (const pause of ["unrecognised", "duration"] as const)
      test(`${fault} for ever, a durable pause by ${pause}: not one request across three remounts, and the database is never bound`, async ({
        context,
      }, info) => {
        await stubNetwork(context);
        const counts = await serve(context, {
          me: () => NOT_FOUND,
          sessions: () => NOT_FOUND,
        });
        await createDatabase(context, pause);
        const visits: Array<{ me: number; sessions: number }> = [];
        const faults: Array<{ record: FaultRecord | null; opened: number }> =
          [];
        for (let i = 0; i < 3; i += 1) {
          const page = await bootSessionAfter(
            context,
            installFaults({ open: { name: fault } }),
          );
          await page.waitForTimeout(2_500);
          visits.push({ ...counts });
          const bound = await opened(page);
          faults.push({ record: await faultsOf(page), opened: bound });
          recordEvidence(info, `r12-failed-open-${fault}-${pause}-visit-${i}`, {
            faults: faults.at(-1),
            counts: { ...counts },
          });
          // The premise, recorded with the page: the fault was in force, the page opened the database and was refused every time.
          expect(faults.at(-1)?.record?.opens.length).toBeGreaterThan(0);
          expect(
            faults.at(-1)?.record?.opens.every((open) => open[1] === "fail"),
          ).toBe(true);
          expect(faults.at(-1)?.record?.intact?.open).toBe(true);
          expect(bound).toBe(0);
          await page.close();
        }
        recordEvidence(info, `r12-failed-open-${fault}-${pause}`, {
          visits,
          faults,
        });
        expect(counts).toEqual({ me: 0, sessions: 0 });
      });

  test("control: the same paused database with opens that work: zero requests, and the database is bound", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context, "unrecognised");
    for (let i = 0; i < 3; i += 1) {
      const page = await bootSession(context);
      await page.waitForTimeout(2_500);
      expect(await opened(page)).toBeGreaterThan(0);
      await page.close();
    }
    recordEvidence(info, "r12-failed-open-control-paused", { ...counts });
    expect(counts).toEqual({ me: 0, sessions: 0 });
  });

  for (const pause of ["unrecognised", "duration"] as const)
    test(`AbortError for 4 s and then RECOVERS, a durable pause by ${pause}: the budget is read when the look lands, and still not one request`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const counts = await serve(context, {
        me: () => NOT_FOUND,
        sessions: () => NOT_FOUND,
      });
      await createDatabase(context, pause);
      const page = await bootSessionAfter(
        context,
        installFaults({
          open: { name: "AbortError", untilMs: FAILED_INTERVAL_MS },
        }),
      );
      // The failed interval is OBSERVED to its end (the instant the page let its first open through), not sampled two seconds after the boot.
      const record = await afterFailedOpens(page);
      recordEvidence(info, `r12-failed-open-interval-${pause}`, {
        record,
        counts: { ...counts },
      });
      expectFailedInterval(record.opens, record, record.firstOpenPassAt);
      // The database was not bound when the first open was let through (every earlier open failed), and nothing was asked.
      expect(record.boundBeforeFirstOpenPass).toBe(0);
      expect(counts).toEqual({ me: 0, sessions: 0 });
      await expect
        .poll(() => opened(page), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await page.waitForTimeout(6_000);
      recordEvidence(info, `r12-failed-open-recovers-${pause}`, { ...counts });
      expect(counts).toEqual({ me: 0, sessions: 0 });
      await page.close();
    });

  test("AbortError for 4 s and then recovers, no pause: nothing while it fails, then both endpoints are asked (the control of the above)", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context);
    const page = await bootSessionAfter(
      context,
      installFaults({
        open: { name: "AbortError", untilMs: FAILED_INTERVAL_MS },
      }),
    );
    const record = await afterFailedOpens(page);
    recordEvidence(info, "r12-failed-open-interval-healthy", {
      record,
      stamps: counts.stamps,
    });
    expectFailedInterval(record.opens, record, record.firstOpenPassAt);
    // Nothing was asked while the open failed: every request arrived after the first open that was let through.
    expect(
      askedBefore(counts.stamps.me, record.firstOpenPassAt as number),
    ).toEqual([]);
    expect(
      askedBefore(counts.stamps.sessions, record.firstOpenPassAt as number),
    ).toEqual([]);
    await expect.poll(() => counts.me, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => counts.sessions, { timeout: 30_000 })
      .toBeGreaterThan(0);
    recordEvidence(info, "r12-failed-open-recovers-healthy", { ...counts });
    await page.close();
  });

  test("R34 control: the test is late by 9 s, past the whole failed interval (the page's first pass-through is at about 7.8 s): a SAMPLE taken then sees the requests, and the observation still finds that none was asked while the open failed", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    const counts = await serve(context, {
      me: () => NOT_FOUND,
      sessions: () => NOT_FOUND,
    });
    await createDatabase(context);
    const page = await bootSessionAfter(
      context,
      installFaults({
        open: { name: "AbortError", untilMs: FAILED_INTERVAL_MS },
      }),
    );
    // The slowness: the test looks at nothing for nine seconds, which is past the failed interval as the controller experiences it.
    await page.waitForTimeout(9_000);
    // (1) What a sample taken now sees: the page recovered and asked, so a look made this late (`expect(counts).toEqual({ me: 0, sessions: 0 })`)
    // fails. A look is therefore only right if it is made inside the interval, which is what the observation does not depend on.
    await expect.poll(() => counts.me, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => counts.sessions, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const sampled = { ...counts };
    // (2) What the observation finds: the page's own record puts the first pass after the interval, and no request preceded it.
    const record = await afterFailedOpens(page);
    recordEvidence(info, "r34-late-sample-control", {
      sampled,
      record,
      stamps: counts.stamps,
    });
    expect(sampled.me).toBeGreaterThan(0);
    expectFailedInterval(record.opens, record, record.firstOpenPassAt);
    expect(
      askedBefore(counts.stamps.me, record.firstOpenPassAt as number),
    ).toEqual([]);
    expect(
      askedBefore(counts.stamps.sessions, record.firstOpenPassAt as number),
    ).toEqual([]);
    await page.close();
  });
});

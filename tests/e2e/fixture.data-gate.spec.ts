import type { BrowserContext, Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  FIXED_INCARNATION,
  fixedOperationKey,
  fixIncarnation,
  holdStorageEvents,
  installMarkerReadFaults,
  installStorageHold,
  markerEventCounts,
  markerReads,
  NO_READ_FAULTS,
  releaseStorageEvents,
} from "./data-local-faults";
import {
  ACCOUNT,
  atlasError,
  bootSession,
  dataPage,
  seedSettled,
  startLeader,
  stubNetwork,
  untilTreeSettled,
  uuid,
  waitForState,
} from "./data-sync-helpers";
import { type HeldOperations, withHeldOperations } from "./held-operation";
import { expect, test } from "./helpers";

/**
 * R57 (revision 33): a freshly booted page is SETTLED (its session booted, no request lease standing, its tree quiet) before the harness opens
 * the account. The page's boot promise resolves before the answer to its first identity read is processed, and the tree binds, hands over
 * and remounts when the session's own steps finish (see `untilTreeSettled`). The first full author-phase run's pooled MU-991 job failed once,
 * in Firefox, with `could not open the account: refused` at the first harness call of a page booted for this spec: the trace shows that call
 * made 4 ms after the answer to the page's identity read was fulfilled, and this spec was the one that did not settle (the others do before
 * `startLeader`). The open's refusal now names its reason in the message. Forty repetitions of the same cases in Firefox, through the shared
 * driver, did not reproduce it before this change (a bounded stability diagnostic with no acceptance credit), so what is claimed is the
 * missing readiness and its correction, not a reproduction.
 */
const startLeaderSettled = async (page: Page): Promise<void> => {
  await untilTreeSettled(page, { connections: 0 });
  await startLeader(page);
};

// A marker's key names the lifetime of its database (R56, revision 33). The cases below name the key of a marker before the page that creates
// the database has started, so every page of a case's context creates its databases under one fixed incarnation (FIXTURE only).
test.beforeEach(async ({ context }) => {
  await fixIncarnation(context);
});

/**
 * E-C7 (R13, revision 10): the cache stays hidden until its display state is established, in a real engine. The fifth review reproduced,
 * in Chromium, Firefox and WebKit, that a failed read of the sync facts after the controller had established an invalid cache turned the
 * gate `open` with the retained row still in the store. Here the production controller (`createDataEnv`, through the fixture harness's
 * `startGate`), plans, Dexie adapter and the real IndexedDB are driven through the reviewer's own fault (a named `UnknownError`
 * thrown by the real `IDBObjectStore.get` of the singleton in a one-store read-only transaction, which is what the facts read is) over
 * the three durable records of an invalidation (the cache status, the failure streak, and the account's `localStorage` marker) and over
 * the valid control.
 *
 * What is real: IndexedDB and Dexie's live query (which ENDS at its first error, so the controller's paced re-read is what recovers the
 * read), `localStorage`, a real second page as the follower or the reloaded tab, real timers. What is not: the fault is a named thrown
 * exception, not a genuine storage failure; the network is stubbed; no engine runs in the page that reads the gate (a follower has none);
 * the page that reads is a FIXTURE composition of the production controller. The gate is derived as a screen derives it.
 */
type Held = "invalid" | "counter" | "marker" | "valid";
const RECORDS: readonly Held[] = ["invalid", "counter", "marker", "valid"];
const OPERATION = "invalid-op";
const RESOURCE = uuid(9);
const hidden = (record: Held) => record !== "valid";

const DRAFT = {
  local_id: "kept",
  account_id: ACCOUNT,
  endpoint: "/commands",
  target_id: null,
  kind: "edit",
  command_digest: "d-kept",
  defaults_revision: null,
  target_resource_ids: [],
  side_effect_bases: {},
  index_targets: [],
  bases: {},
  bumped: [],
  defaults_context: null,
  review_block: null,
  depends_on: [],
  status: "queued",
  held_pending_cache: false,
  unavailable_outcome: false,
  retry_state: null,
  attempts: 0,
  last_attempt_at: null,
  last_error: null,
  display_patch: null,
  receipt_revision: null,
  created_seq: 1,
  created_at: "2026-10-01T09:00:00.000Z",
};

/**
 * The fault: while armed, `IDBObjectStore.get` of the `sync_state` singleton in a read-only transaction over that store alone throws.
 * Installed before the page's own scripts, so a follower or a reloaded tab can have its FIRST read fail; armed (and counted) by the test.
 */
const faultInit = () => {
  const w = window as unknown as {
    __facts: { armed: boolean; left: number; hit: number };
  };
  w.__facts = { armed: false, left: 0, hit: 0 };
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, key) {
    if (
      w.__facts.armed &&
      w.__facts.left > 0 &&
      this.name === "sync_state" &&
      this.transaction.mode === "readonly" &&
      this.transaction.objectStoreNames.length === 1 &&
      key === "singleton"
    ) {
      w.__facts.left -= 1;
      w.__facts.hit += 1;
      throw new DOMException(
        "review injected facts read failure",
        "UnknownError",
      );
    }
    return get.call(this, key);
  };
};

/**
 * Every read of the `sync_state` singleton in a one-store read-only transaction fails from now until `disarm`: the sync facts read is
 * one of them, and so is the outbox's read of its stops, so a COUNT of faults cannot say which read they fell on. The facts read is the
 * one that is made again on a schedule, which is what the tests below observe.
 */
const arm = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __facts: { armed: boolean; left: number; hit: number };
    };
    w.__facts.armed = true;
    w.__facts.left = Number.MAX_SAFE_INTEGER;
    w.__facts.hit = 0;
  });
const disarm = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __facts: { armed: boolean } }).__facts.armed =
      false;
  });
const hits = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __facts: { hit: number } }).__facts.hit,
  );
const gate = (page: Page) => page.evaluate(() => window.__atlasData?.gate());
const cacheState = (page: Page) =>
  page.evaluate(() => window.__atlasData?.gateCache());
const retained = (page: Page) =>
  page.evaluate(async (a) => {
    const h = window.__atlasData;
    return {
      cache: (await h?.rows(a, "cache"))?.length,
      drafts: (await h?.rows(a, "drafts"))?.length,
    };
  }, ACCOUNT);

/** The database's records, set by a leader page that is then left alone: the cache row, one draft, and the invalidation's records. */
async function seedRecord(page: Page, record: Held): Promise<void> {
  await page.evaluate(
    async ({ a, record, op, resource, draft }) => {
      const h = window.__atlasData;
      if (h === undefined) throw new Error("no harness");
      h.stopSync();
      const sync = (await h.syncState(a)) as Record<string, unknown> & {
        cursor: string;
        local_write_streaks: Record<string, number>;
      };
      sync.local_write_streaks = {};
      sync.cache_status = "valid";
      if (record === "invalid") sync.cache_status = "invalid";
      if (record === "counter")
        sync.local_write_streaks = { [`invalidate:${sync.cursor}`]: 3 };
      await h.put(a, "sync_state", [sync]);
      if (record === "marker") {
        // An EARLIER page's failure, in the lifetime of this database: its directory first, then its key (R55 and R56).
        const scope = `${encodeURIComponent(a)}:${encodeURIComponent(sync.incarnation_id as string)}`;
        const operation = `invalidate:${sync.cursor}`;
        localStorage.setItem(
          `atlas-write-dir:${scope}:31`,
          JSON.stringify({ v: 1, e: [[operation, "seed.1"]] }),
        );
        localStorage.setItem(
          `atlas-write-failing:${scope}:${operation}#seed.1`,
          "1",
        );
      }
      await h.put(a, "cache", [
        {
          id: resource,
          kind: "person",
          parent_id: null,
          label: "retained private resource",
          value: { name: "retained private resource" },
          version: 1,
          can_edit: true,
          archived: false,
          kind_date: null,
        },
      ]);
      await h.put(a, "drafts", [draft]);
      void op;
    },
    { a: ACCOUNT, record, op: OPERATION, resource: RESOURCE, draft: DRAFT },
  );
}

/** Another tab, as a follower or a reloaded tab: it has the fault installed from its first script, and no engine. */
async function followerPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(faultInit);
  await page.goto("/__session?route=%2Ftoday");
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

async function leaderWith(context: BrowserContext, record: Held) {
  const net = await stubNetwork(context);
  await seedSettled(context);
  const leader = await bootSession(context);
  await startLeaderSettled(leader);
  await waitForState(leader, "idle");
  await seedRecord(leader, record);
  return { net, leader };
}

test.describe("E-C7: the cache stays hidden until its display state is established; a failed or delayed read of the facts never opens it (R13)", () => {
  for (const record of RECORDS)
    test(`${record}: a first read that fails (a follower or reloaded tab) is hidden at once, and stays hidden through the paced re-reads until a read says it is valid`, async ({
      context,
    }, info) => {
      const { leader } = await leaderWith(context, record);
      const page = await followerPage(context);
      await arm(page);
      await page.evaluate(
        (a) => window.__atlasData?.startGate(a, { established: false }),
        ACCOUNT,
      );
      // At once: the database is open and the read has not landed (it is failing): hidden, whatever the database says.
      expect(await cacheState(page)).toBe("unverified");
      expect(await gate(page)).toBe("refreshing");
      // Nothing is lost or affected: the row is in the store and the draft is there.
      expect(await retained(page)).toEqual({ cache: 1, drafts: 1 });
      // The failed live query is made again at 250 ms, 500 ms after that, and so on: it keeps failing, and the cache stays hidden.
      const first = await hits(page);
      expect(first).toBeGreaterThan(0);
      for (let sample = 0; sample < 6; sample += 1) {
        await page.waitForTimeout(300);
        expect(await gate(page)).toBe("refreshing");
      }
      expect(await hits(page)).toBeGreaterThan(first);
      expect(await cacheState(page)).toBe("unverified");
      // The fault is gone: the next paced read lands, and what it says is what shows.
      await disarm(page);
      await expect
        .poll(() => cacheState(page), { timeout: 30_000 })
        .not.toBe("unverified");
      expect(await gate(page)).toBe(hidden(record) ? "refreshing" : "open");
      expect(await retained(page)).toEqual({ cache: 1, drafts: 1 });
      recordEvidence(info, `facts-first-read-${record}`, {
        gate: await gate(page),
        hits: await hits(page),
      });
      await page.close();
      await leader.close();
    });

  for (const record of RECORDS)
    test(`${record}: a read that fails AFTER the state was established leaves it standing (hidden stays hidden), and the read made again corrects it`, async ({
      context,
    }, info) => {
      const { leader } = await leaderWith(context, record);
      const page = await followerPage(context);
      await page.evaluate((a) => window.__atlasData?.startGate(a), ACCOUNT);
      expect(await gate(page)).toBe(hidden(record) ? "refreshing" : "open");
      // Every read of the facts fails from here (the live query of the facts ends at its first error, and the paced re-reads fail too).
      await arm(page);
      await page.evaluate(async (a) => {
        const h = window.__atlasData;
        if (h === undefined) throw new Error("no harness");
        const sync = (await h.rows(a, "sync_state"))[0] as {
          page_seq: number;
        };
        sync.page_seq += 1;
        await h.put(a, "sync_state", [sync]);
      }, ACCOUNT);
      await expect.poll(() => hits(page)).toBeGreaterThan(0);
      const first = await hits(page);
      for (let sample = 0; sample < 6; sample += 1) {
        await page.waitForTimeout(300);
        // The gate does not change: an invalid cache is not shown, and a cache that read valid is left as it read.
        expect(await gate(page)).toBe(hidden(record) ? "refreshing" : "open");
      }
      // The reads are being made again, on a schedule, and failing.
      expect(await hits(page)).toBeGreaterThan(first);
      expect(await retained(page)).toEqual({ cache: 1, drafts: 1 });
      // A read that lands after the fault is gone is authoritative: with the database made valid, the content opens.
      await disarm(page);
      await page.evaluate(
        async ({ a }) => {
          const h = window.__atlasData;
          if (h === undefined) throw new Error("no harness");
          const sync = (await h.rows(a, "sync_state"))[0] as {
            cursor: string;
            cache_status: string;
            incarnation_id: string;
            local_write_streaks: Record<string, number>;
          };
          sync.cache_status = "valid";
          sync.local_write_streaks = {};
          // A marker is a key of its own per failure (R52, revision 32): the page that wrote it removes the keys that stand.
          const prefix = `atlas-write-failing:${encodeURIComponent(a)}:${encodeURIComponent(sync.incarnation_id as string)}:invalidate:${sync.cursor}#`;
          for (const key of Object.keys(localStorage))
            if (key.startsWith(prefix)) localStorage.removeItem(key);
          await h.put(a, "sync_state", [sync]);
        },
        { a: ACCOUNT },
      );
      await expect.poll(() => gate(page), { timeout: 20_000 }).toBe("open");
      recordEvidence(info, `facts-after-established-${record}`, {
        hits: await hits(page),
      });
      await page.close();
      await leader.close();
    });

  test("an invalid cache whose reads keep failing stays hidden for as long as they do, and a read that lands but still says invalid keeps it hidden", async ({
    context,
  }, info) => {
    const { leader } = await leaderWith(context, "invalid");
    const page = await followerPage(context);
    await arm(page);
    await page.evaluate(
      (a) => window.__atlasData?.startGate(a, { established: false }),
      ACCOUNT,
    );
    for (let sample = 0; sample < 6; sample += 1) {
      expect(await gate(page)).toBe("refreshing");
      await page.waitForTimeout(250);
    }
    expect(await hits(page)).toBeGreaterThan(2);
    await disarm(page);
    // A read lands and still says invalid: the content stays hidden.
    await expect
      .poll(() => cacheState(page), { timeout: 30_000 })
      .toBe("invalid");
    expect(await gate(page)).toBe("refreshing");
    recordEvidence(info, "facts-keep-failing-invalid", {
      hits: await hits(page),
    });
    await page.close();
    await leader.close();
  });
});

/**
 * E-C8 (R15, revision 11): an ALREADY-OPEN follower hides a cache another page could only record in the account's fallback marker, in a
 * real engine. The sixth review reproduced, in Chromium, Firefox and WebKit, that a follower with a successful read of the facts kept
 * the gate `open` after the leader's guarded invalidation failed (its counter write failed too, or the failure was a quota failure and
 * is not counted) and only the `localStorage` marker recorded it, although the follower had received the marker's `storage` event.
 *
 * What is real: two pages of one browser context with the production session, Dexie, IndexedDB and `localStorage`, the browser's own
 * `storage` event (observed in the follower before its gate is read), and a real held `410 resync_required` that the follower is open
 * BEFORE. What is not: the write failures are named `DOMException`s thrown by the real `IDBObjectStore.put` of `sync_state` in the
 * leader (not genuine device I/O or quota exhaustion); the network is stubbed; the leader is the fixture's test leader; the follower is
 * a FIXTURE composition of the production controller. The controls: the durable counter (which the follower sees through its live
 * query), a marker of another account, another position and an unrelated operation, a marker that goes while the facts still say
 * `valid`, a cleared storage, and a successful recovery.
 */
type Path = "counter" | "marker" | "quota";
const PATHS: readonly Path[] = ["counter", "marker", "quota"];
const OTHER_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Diagnostics for every page of the context: who opens, deletes or closes an IndexedDB database, and what crosses `BroadcastChannel`. */
const traceInit = () => {
  const w = window as unknown as { __trace: Array<[number, string, string]> };
  w.__trace = [];
  const log = (kind: string, detail: string) =>
    w.__trace.push([Math.round(performance.now()), kind, detail]);
  const del = IDBFactory.prototype.deleteDatabase;
  IDBFactory.prototype.deleteDatabase = function (name: string) {
    log(
      "deleteDatabase",
      `${name} ${new Error().stack?.split("\n").slice(1, 4).join(" | ")}`,
    );
    return del.call(this, name);
  };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name: string, version?: number) {
    log("open", `${name} v${version ?? "-"}`);
    return open.call(this, name, version as number);
  };
  const close = IDBDatabase.prototype.close;
  IDBDatabase.prototype.close = function () {
    log("close", this.name);
    return close.call(this);
  };
  const post = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (message: unknown) {
    log("bc-post", `${this.name} ${JSON.stringify(message).slice(0, 120)}`);
    return post.call(this, message);
  };
  const listener = new BroadcastChannel("atlas-sync");
  listener.onmessage = (event) =>
    log("bc-recv", JSON.stringify(event.data).slice(0, 120));
  window.addEventListener("pagehide", () => log("pagehide", ""));
};

/** The follower page: the browser's `storage` events are recorded, and the reads of the `sync_state` singleton are counted. */
const watchInit = () => {
  const w = window as unknown as {
    __watch: {
      events: Array<string | null>;
      reads: number;
      syncWrites: number;
      lookups: Array<[number, string, string | null]>;
    };
  };
  w.__watch = { events: [], reads: 0, syncWrites: 0, lookups: [] };
  window.addEventListener("storage", (event) => {
    w.__watch.events.push(event.key);
    w.__watch.lookups.push([
      Math.round(performance.now()),
      `event:${event.key}`,
      event.newValue,
    ]);
  });
  for (const op of ["put", "add", "delete", "clear"] as const) {
    const original = IDBObjectStore.prototype[op] as (
      ...a: unknown[]
    ) => unknown;
    (IDBObjectStore.prototype as unknown as Record<string, unknown>)[op] =
      function (this: IDBObjectStore, ...args: unknown[]) {
        if (this.name === "sync_state") w.__watch.syncWrites += 1;
        return original.apply(this, args);
      };
  }
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (this: Storage, key: string) {
    const value = getItem.call(this, key);
    if (key.startsWith("atlas-write-failing:"))
      w.__watch.lookups.push([
        Math.round(performance.now()),
        `get:${key}`,
        value,
      ]);
    return value;
  };
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, key) {
    if (
      this.name === "sync_state" &&
      this.transaction.mode === "readonly" &&
      this.transaction.objectStoreNames.length === 1 &&
      key === "singleton"
    )
      w.__watch.reads += 1;
    return get.call(this, key);
  };
};

/**
 * Waits until the page's own boot looks over: the app's protected tree opens the account database, mounts and remounts while the session
 * settles (the first open can come well over a second into the page's life), and each time its data runtime is disposed it closes every
 * connection of the account on the page's connection registry, which a harness controller that does not isolate itself (a second
 * runtime over the same registry, a fixture composition; production has one runtime per page) shares. Settled means the app's own
 * connections to the account are there (the database exists: the leader made it) and have not changed for 600 ms, on a page more than a
 * second old.
 *
 * THIS IS HYGIENE AND NOT A GUARANTEE (R49, revision 30). It infers boot completion from a quiet interval, and the session republishes
 * its identity whenever another page's activity makes it evaluate (measured: a republish of the same identity 2.1 to 2.3 s into a page's
 * life, under load, about once in a hundred runs), which no quiet interval proves is over. A spec that COUNTS reads therefore does not
 * rely on it: it starts an ISOLATED controller (`startGate(account, { isolated: true })`: a registry, an opener and a frozen identity of
 * its own) and counts that controller's own reads of the facts (`gateFactsReads`), so nothing the page's tree or its session does can
 * make the measured controller read, and a read it does make is its own reaction to what the spec did.
 */
async function settled(page: Page): Promise<void> {
  let last = -1;
  let steady = 0;
  for (let round = 0; round < 120 && steady < 4; round += 1) {
    await page.waitForTimeout(150);
    const now = await page.evaluate(
      (a) => ({
        age: performance.now(),
        open: window.__atlasData?.openCount(a) ?? 0,
      }),
      ACCOUNT,
    );
    if (now.age > 1_000 && now.open >= 2 && now.open === last) steady += 1;
    else steady = 0;
    last = now.open;
  }
  if (steady < 4) throw new Error("the follower page never settled its boot");
}

async function watchingPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(watchInit);
  await page.goto("/__session?route=%2Ftoday");
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  await settled(page);
  return page;
}

/**
 * Serves `GET /me` and `GET /sessions` (the profile read and the device mirror) successfully. The shared `stubNetwork` answers neither
 * (404), and with the production session composition each failed attempt writes a lease, which notifies the identity store, which asks
 * again: an open page then repeats both requests about 250 times a second and re-reads the sync facts a few hundred times a second (a
 * pre-existing behaviour, reported in `.agtx/execute.md`, not touched here). A spec that COUNTS reads needs a page that is quiet.
 */
async function serveIdentityReads(context: BrowserContext): Promise<void> {
  const now = Date.now();
  await context.route("**/api/experimental/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: ACCOUNT, username: "alice" }),
    }),
  );
  await context.route("**/api/experimental/v1/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "s1",
            device_id: "dev-1",
            created_at: new Date(now - 60_000).toISOString(),
            expires_at: new Date(now + 86_400_000).toISOString(),
            authentication: "password",
            current: true,
          },
        ],
      }),
    }),
  );
}

const events = (page: Page, key: string) =>
  page.evaluate(
    (k) =>
      (
        window as unknown as { __watch: { events: Array<string | null> } }
      ).__watch.events.filter(
        // A marker is a key of its own per failure (R52, revision 32): the operation's key, and the keys `<operation>#<page>.<count>`.
        (event) => event === k || event?.startsWith(`${k}#`) === true,
      ).length,
    key,
  );
const storageEvents = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __watch: { events: Array<string | null> } })
        .__watch.events.length,
  );
/** EVERY read of the sync singleton on the page, whoever made it (the production tree's included): evidence, never an assertion. */
const singletonReads = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __watch: { reads: number } }).__watch.reads,
  );
/**
 * A write to the `sync_state` table by a writer OTHER than the controller under test (the harness's own runtime, a second handle to the
 * account): the same row, unchanged, so that nothing the controller derives changes and only the live query over the table runs again.
 */
const writeFacts = (page: Page) =>
  page.evaluate(async (a) => {
    const h = window.__atlasData;
    const row = (await h?.syncState(a)) as object | null | undefined;
    if (row === null || row === undefined)
      throw new Error("no sync facts to write");
    await h?.put(a, "sync_state", [row]);
  }, ACCOUNT);
/** Every write to the `sync_state` table on the page, whoever made it: what makes a live query over it run again. Evidence only. */
const syncWrites = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __watch: { syncWrites: number } }).__watch
        .syncWrites,
  );
/** The reads of the sync facts that the (isolated) controller of `startGate` has made itself (see `settled`). */
const gateReads = (page: Page) =>
  page.evaluate(() => window.__atlasData?.gateFactsReads());
/** What the controller has started: the live queries of the facts and every plan through its store, never the re-runs Dexie makes after a write. */
const gateStarted = async (page: Page) => {
  const reads = await gateReads(page);
  return { starts: reads?.starts, calls: reads?.calls };
};

/** One atomic read of what a screen could have derived, and why: the gate, the cache state, every state it passed through, the latch. */
const snapshot = (page: Page) =>
  page.evaluate((a) => {
    const h = window.__atlasData;
    return {
      at: Math.round(performance.now()),
      gate: h?.gate(),
      cache: h?.gateCache(),
      history: h?.gateHistory(),
      latch: h?.latch(a),
      diagnostics: h?.gateDiagnostics(),
      trace: (
        window as unknown as { __trace?: Array<[number, string, string]> }
      ).__trace?.slice(-30),
      lookups: (
        window as unknown as {
          __watch?: { lookups: Array<[number, string, string | null]> };
        }
      ).__watch?.lookups.slice(-40),
    };
  }, ACCOUNT);

/** The follower's gate is hidden; when it is not, the failure carries the whole picture and not just the one word. */
async function expectHidden(
  page: Page,
  when: string,
  peers: Page[] = [],
): Promise<void> {
  const seen = await snapshot(page);
  if (seen.gate !== "refreshing") {
    const others = await Promise.all(peers.map((peer) => snapshot(peer)));
    throw new Error(
      `the follower must be hidden ${when}; it was ${JSON.stringify(seen)}; its peers were ${JSON.stringify(others)}`,
    );
  }
}

const history = (page: Page) =>
  page.evaluate(() => window.__atlasData?.gateHistory());
const syncFacts = async (page: Page) => {
  try {
    return await readSyncFacts(page);
  } catch (error) {
    throw new Error(
      `${String(error)}; the follower was ${JSON.stringify(await snapshot(page))}`,
    );
  }
};
const readSyncFacts = (page: Page) =>
  page.evaluate(
    (a) =>
      window.__atlasData?.syncState(a) as Promise<{
        cursor: string;
        cache_status: string;
        local_write_streaks: Record<string, number>;
      }>,
    ACCOUNT,
  );
const markerKeys = (page: Page) =>
  page.evaluate(() =>
    [
      ...new Set(
        Object.keys(localStorage)
          .filter((key) => key.startsWith("atlas-write-failing:"))
          // A marker is a key of its own per failure (R52, revision 32): the operation's key, once however many failures stand.
          .map((key) => key.replace(/#[0-9a-z-]{1,64}\.[0-9]+$/, "")),
      ),
    ].sort(),
  );

/**
 * The leader's failure: while armed, the real `IDBObjectStore.put` of `sync_state` throws a named exception for the invalidation's row
 * (a quota failure for `quota`, any other failure otherwise) and, for `marker`, for the failure counter's row too, so the marker is the
 * only record.
 */
const installFault = (path: Path) => {
  const w = window as unknown as { __r15: { armed: boolean } };
  w.__r15 = { armed: true };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, row, ...rest) {
    if (w.__r15.armed && this.name === "sync_state") {
      const sync = row as {
        cache_status?: string;
        local_write_streaks?: Record<string, number>;
      };
      if (sync.cache_status === "invalid")
        throw new DOMException(
          "injected invalidation write failure",
          path === "quota" ? "QuotaExceededError" : "UnknownError",
        );
      if (
        path === "marker" &&
        Object.keys(sync.local_write_streaks ?? {}).length > 0
      )
        throw new DOMException("injected counter write failure", "DataError");
    }
    return put.call(this, row, ...(rest as []));
  };
};

const RETAINED_ROW = {
  id: RESOURCE,
  kind: "person",
  parent_id: null,
  label: "retained private resource",
  value: { name: "retained private resource" },
  version: 1,
  can_edit: true,
  archived: false,
  kind_date: null,
};

/**
 * A follower that is open BEFORE the leader's next request is answered, and the leader's next `/sync` request, HELD until `release()`
 * answers it `410 resync_required`. The order matters: while a request of the leader is in flight the follower page's session waits
 * and its app tree is not mounted, and when the request ends the tree mounts and remounts (its data runtime closes every connection
 * of the account on the registry the harness's gate controller shares). So the leader's first sync completes, the follower boots and
 * settles and starts its gate, and only then is the held request made (`nudgeSync`). `opKey` is the marker of the position the
 * follower's facts name.
 */
async function followerBeforeFailure(context: BrowserContext, path: Path) {
  await context.addInitScript(traceInit);
  await stubNetwork(context);
  await serveIdentityReads(context);
  await seedSettled(context);
  const leader = await bootSession(context);
  await leader.evaluate(installFault, path);
  await startLeaderSettled(leader);
  await waitForState(leader, "idle");
  await leader.evaluate(
    async ({ a, row, draft }) => {
      const h = window.__atlasData;
      if (h === undefined) throw new Error("no harness");
      await h.put(a, "cache", [row]);
      await h.put(a, "drafts", [draft]);
      await h.startGate(a);
    },
    { a: ACCOUNT, row: RETAINED_ROW, draft: DRAFT },
  );
  const follower = await watchingPage(context);
  await follower.evaluate((a) => window.__atlasData?.startGate(a), ACCOUNT);
  expect(await gate(follower)).toBe("open");
  expect(await cacheState(follower)).toBe("valid");
  await follower.evaluate(() => window.__atlasData?.resetGateHistory());
  const { cursor } = await syncFacts(follower);
  // From here the leader's next request is held.
  let release!: () => void;
  let requested!: () => void;
  const seen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await leader.route("**/sync?**", async (route) => {
    requested();
    await hold;
    await route.fulfill({
      status: 410,
      contentType: "application/json",
      body: atlasError("resync_required"),
    });
  });
  await leader.evaluate(() => window.__atlasData?.nudgeSync());
  await seen;
  return {
    leader,
    follower,
    release,
    opKey: fixedOperationKey(`invalidate:${cursor}`),
  };
}

/**
 * A follower that is open over a settled, valid database, and a page that can write `localStorage` (the leader's). The leader's sync
 * has moved the position on (the stub answers with its own cursor), so the keys of the position are read from the follower's facts.
 */
async function openFollower(
  context: BrowserContext,
  options: { isolated?: boolean } = {},
) {
  const { leader } = await leaderWith(context, "valid");
  await serveIdentityReads(context);
  const follower = await watchingPage(context);
  await follower.evaluate(
    ({ a, isolated }) => window.__atlasData?.startGate(a, { isolated }),
    { a: ACCOUNT, isolated: options.isolated === true },
  );
  expect(await gate(follower)).toBe("open");
  await follower.evaluate(() => window.__atlasData?.resetGateHistory());
  const { cursor } = await syncFacts(follower);
  return {
    leader,
    follower,
    cursor,
    opKey: fixedOperationKey(`invalidate:${cursor}`),
  };
}

/** ANOTHER page records a failure of the operation `key` names: a key of its own (R52, revision 32), `<operation>#<page>.<count>`. */
const writeKey = (page: Page, key: string) =>
  page.evaluate((k) => {
    // `key` is `atlas-write-failing:<account>:<incarnation>:<operation>`: the failure is listed in the directory of a slot no running page
    // owns FIRST, and its own key is written second (R55).
    const parts = /^atlas-write-failing:([^:]*):([^:]*):(.*)$/.exec(k);
    if (parts === null) throw new Error(`not a marker key: ${k}`);
    const directory = `atlas-write-dir:${parts[1]}:${parts[2]}:31`;
    const raw = localStorage.getItem(directory);
    const entries: Array<[string, string]> =
      raw === null ? [] : (JSON.parse(raw) as { e: Array<[string, string]> }).e;
    entries.push([parts[3] as string, "writer.1"]);
    localStorage.setItem(directory, JSON.stringify({ v: 1, e: entries }));
    localStorage.setItem(`${k}#writer.1`, "1");
  }, key);
/** The page that wrote the marker ends it: the keys that stand for the operation `key` names. */
const removeKey = (page: Page, key: string) =>
  page.evaluate((k) => {
    for (const name of Object.keys(localStorage))
      if (name === k || name.startsWith(`${k}#`)) localStorage.removeItem(name);
  }, key);

test.describe("E-C8: an already-open follower hides a cache another page could only record in the fallback marker (R15)", () => {
  for (const path of PATHS)
    test(`${path}: open before, hidden once the leader's invalidation fails and the follower has heard of it, never \`valid\` in between; the cache row and the draft are kept`, async ({
      context,
    }, info) => {
      const { leader, follower, release, opKey } = await followerBeforeFailure(
        context,
        path,
      );
      release();
      await waitForState(leader, "stopped");
      await expect.poll(() => gate(leader)).toBe("refreshing");
      // The follower hears of the marker as the browser delivers it, before anything else is asked of it.
      if (path !== "counter")
        await expect
          .poll(() => events(follower, opKey), { timeout: 10_000 })
          .toBeGreaterThan(0);
      await expect
        .poll(() => cacheState(follower), { timeout: 10_000 })
        .toBe("invalid");
      await expectHidden(follower, "once it has heard of the marker", [leader]);
      const facts = await syncFacts(follower);
      if (path === "counter") {
        expect(facts.local_write_streaks).not.toEqual({});
        expect(await markerKeys(follower)).toEqual([]);
      } else {
        // The invalidation and its counter both failed: the database still says `valid`, and only the marker records it.
        expect(facts.cache_status).toBe("valid");
        expect(facts.local_write_streaks).toEqual({});
        expect(await markerKeys(follower)).toEqual([opKey]);
      }
      for (let sample = 0; sample < 8; sample += 1) {
        await follower.waitForTimeout(250);
        await expectHidden(follower, `at sample ${sample}`);
      }
      const seen = await history(follower);
      expect(seen).not.toContain("valid");
      expect(seen?.at(-1)).toBe("invalid");
      expect(await retained(follower)).toEqual({ cache: 1, drafts: 1 });
      recordEvidence(info, `r15-follower-${path}`, {
        history: seen,
        facts,
        events: await storageEvents(follower),
      });
      await follower.close();
      await leader.close();
    });

  /**
   * R49 (revision 30). The reads this case is about are the ones THE CONTROLLER STARTS: a new live query of the sync facts (`gateFactsReads`
   * `starts`: what it does when it binds, when a marker of its own position changes, or when a failed read is asked again). A live query that
   * is run AGAIN by Dexie is not the controller's decision: it runs after ANY write to the table it reads, and the data layer writes
   * `sync_state` itself when the page's profile read and device mirror complete (it records their outcome there), which a loaded machine
   * delays to 2.1 to 2.3 s into a page's life about once in a hundred runs (revision 29's failure: 15 reads expected, 19 observed, in
   * Chromium on m2-pro; 1 in 120 under load here, with a late identity read; reproduced on demand with the profile answer held 2.5 s,
   * which failed the old count in 1 of 3 runs and was absorbed by its quiet interval in the others). The last case does what that late write does, deterministically: another writer of the page
   * (the harness's own runtime, a second Dexie instance) writes `sync_state` while the marker is being observed.
   * The old count was every read on the page by anyone, so it counted that write's consequences as this controller's reaction, and
   * waiting longer for the page to be quiet cannot prove a page is quiet (`settled`). The controller under test is ISOLATED (its own
   * registry, opener and frozen identity), so nothing the page's tree or session does can end or rebind it; what it starts is its own
   * reaction to what the spec did; and the same counter is shown to move (the positive control below).
   */
  for (const [name, keyOf, competing] of [
    [
      "another account's marker for the same position",
      (cursor: string) =>
        fixedOperationKey(`invalidate:${cursor}`, OTHER_ACCOUNT),
      false,
    ],
    [
      "this account's marker for another position",
      (cursor: string) => fixedOperationKey(`invalidate:${cursor}-elsewhere`),
      false,
    ],
    [
      "this account's marker for an unrelated operation",
      (cursor: string) => fixedOperationKey(`page:${cursor}`),
      false,
    ],
    [
      "another account's marker for the same position, while another writer of the page writes the facts' table",
      (cursor: string) =>
        fixedOperationKey(`invalidate:${cursor}`, OTHER_ACCOUNT),
      true,
    ],
  ] as const)
    test(`${name}: the follower hears it and changes nothing: no state change, no read of the facts, still open`, async ({
      context,
    }, info) => {
      const { leader, follower, cursor, opKey } = await openFollower(context, {
        isolated: true,
      });
      // The competing writer: the harness opens its own handle to the account (a second Dexie instance on the page's registry, as the
      // page's tree has), through which the spec writes `sync_state` while the marker is being observed. It creates and changes nothing.
      if (competing)
        expect(
          await follower.evaluate((a) => {
            window.__atlasData?.setIdentity(a);
            return window.__atlasData?.open(a, { create: false });
          }, ACCOUNT),
        ).toBe("opened");
      const key = keyOf(cursor);
      const reads = await gateReads(follower);
      // The premise: the counter sees this controller's own bind, so a count that does not move is a controller that did not read.
      expect(reads?.starts).toBeGreaterThan(0);
      expect(reads?.emissions).toBeGreaterThan(0);
      // What the controller STARTS: a live query of the facts, or ANY plan through its store (the outbox facade it builds reads the same
      // singleton when a marker changes what it shows, and an unrelated marker must cost that read too: mutant MU-868).
      const started = await gateStarted(follower);
      expect(started?.calls).toBeGreaterThan(0);
      const pageReadsBefore = await singletonReads(follower);
      const writesBefore = await syncWrites(follower);
      await writeKey(leader, key);
      await expect.poll(() => events(follower, key)).toBeGreaterThan(0);
      if (competing) await writeFacts(follower);
      await follower.waitForTimeout(1_000);
      expect(await gate(follower)).toBe("open");
      expect(await gateStarted(follower)).toEqual(started);
      expect(await history(follower)).toEqual([]);
      await removeKey(leader, key);
      await expect.poll(() => events(follower, key)).toBeGreaterThan(1);
      await follower.waitForTimeout(1_000);
      expect(await gate(follower)).toBe("open");
      expect(await gateStarted(follower)).toEqual(started);
      expect(await history(follower)).toEqual([]);
      const settledReads = await gateReads(follower);
      const pageReadsAfter = await singletonReads(follower);
      const writesAfter = await syncWrites(follower);
      // THE POSITIVE CONTROL, on the same page and the same counter: a marker that DOES concern this position makes the controller START
      // a read (a new live query of the facts) and hides the cache, so a count that stayed still above is not an instrument that cannot
      // see a read.
      await writeKey(leader, opKey);
      await expect
        .poll(() => cacheState(follower), { timeout: 10_000 })
        .toBe("invalid");
      expect(await gate(follower)).toBe("refreshing");
      const concerned = await gateReads(follower);
      expect(concerned?.starts).toBe((started?.starts ?? 0) + 1);
      expect(concerned?.calls).toBeGreaterThan(started?.calls ?? 0);
      expect(concerned?.emissions).toBeGreaterThan(
        settledReads?.emissions ?? 0,
      );
      recordEvidence(
        info,
        `r15-unrelated-${name.split(" ")[0]}-${name.split(" ")[1]}-${competing ? "competing" : "alone"}`,
        {
          reads,
          settledReads,
          afterRelevantMarker: concerned,
          page: {
            readsBefore: pageReadsBefore,
            readsAfter: pageReadsAfter,
            syncWritesBefore: writesBefore,
            syncWritesAfter: writesAfter,
          },
        },
      );
      if (competing) {
        // The case would prove nothing if the competing write did not reach the controller's live query: it must have run again (and
        // the page-wide count, the old measure, must have moved), and the controller must still have started no read of its own.
        expect(writesAfter).toBeGreaterThan(writesBefore);
        expect(settledReads?.emissions).toBeGreaterThan(reads?.emissions ?? 0);
        expect(pageReadsAfter).toBeGreaterThan(pageReadsBefore);
      }
      await follower.close();
      await leader.close();
    });

  test("this position's marker, written by another page, hides the cache; when it goes the content returns only through a read begun after it (never straight from `invalid` to `valid`)", async ({
    context,
  }, info) => {
    const { leader, follower, opKey } = await openFollower(context);
    await writeKey(leader, opKey);
    await expect.poll(() => cacheState(follower)).toBe("invalid");
    expect(await gate(follower)).toBe("refreshing");
    await follower.waitForTimeout(500);
    expect(await gate(follower)).toBe("refreshing");
    expect(await history(follower)).not.toContain("valid");
    // The marker goes while the database still says `valid` and has no counter: the content returns, but through a read.
    await removeKey(leader, opKey);
    await expect.poll(() => gate(follower)).toBe("open");
    const seen = (await history(follower)) ?? [];
    expect(seen.at(-1)).toBe("valid");
    expect(seen.at(-2)).toBe("unverified");
    recordEvidence(info, "r15-marker-removed", { history: seen });
    await follower.close();
    await leader.close();
  });

  test("a cleared localStorage (a null key) may have taken the marker with it: the follower looks again, and the content returns when the read finds nothing against it", async ({
    context,
  }, info) => {
    const { leader, follower, opKey } = await openFollower(context);
    await writeKey(leader, opKey);
    await expect.poll(() => cacheState(follower)).toBe("invalid");
    await leader.evaluate(() => localStorage.clear());
    await expect.poll(() => gate(follower)).toBe("open");
    const seen = (await history(follower)) ?? [];
    expect(seen.at(-1)).toBe("valid");
    expect(seen.at(-2)).toBe("unverified");
    recordEvidence(info, "r15-storage-cleared", { history: seen });
    await follower.close();
    await leader.close();
  });

  for (const path of ["marker", "quota"] as const)
    test(`${path}: a successful recovery: the leader's retry writes the invalidation and the marker goes; the follower stays hidden throughout and opens only at a new position`, async ({
      context,
    }, info) => {
      const { leader, follower, release } = await followerBeforeFailure(
        context,
        path,
      );
      release();
      await waitForState(leader, "stopped");
      await expect.poll(() => cacheState(follower)).toBe("invalid");
      // The fault is gone and the person asks again: the guarded write lands and the marker (what hid it) is removed.
      await leader.evaluate(() => {
        (window as unknown as { __r15: { armed: boolean } }).__r15.armed =
          false;
        window.__atlasData?.retrySync();
      });
      await expect
        .poll(async () => (await syncFacts(follower)).cache_status, {
          timeout: 20_000,
        })
        .toBe("invalid");
      await expect
        .poll(() => markerKeys(follower), { timeout: 10_000 })
        .toEqual([]);
      await follower.waitForTimeout(500);
      expect(await gate(follower)).toBe("refreshing");
      expect(await cacheState(follower)).toBe("invalid");
      expect(await history(follower)).not.toContain("valid");
      // A fresh snapshot is applied at a new position (the fixture arranges it: the real one is WEB-09b's): only now does it open.
      await leader.evaluate(async (a) => {
        const h = window.__atlasData;
        if (h === undefined) throw new Error("no harness");
        h.stopSync();
        const sync = (await h.syncState(a)) as Record<string, unknown> & {
          local_write_streaks: Record<string, number>;
        };
        sync.cache_status = "valid";
        sync.cursor = "cursor-1";
        sync.local_write_streaks = {};
        await h.put(a, "sync_state", [sync]);
      }, ACCOUNT);
      await expect.poll(() => gate(follower), { timeout: 20_000 }).toBe("open");
      expect(await cacheState(follower)).toBe("valid");
      recordEvidence(info, `r15-recovery-${path}`, {
        history: await history(follower),
      });
      await follower.close();
      await leader.close();
    });
});

test.describe("E-C8 (revision 28, R47): an already-open follower keeps an invalid cache hidden while the marker it read cannot be read", () => {
  /** The follower's own `localStorage` reads fail (`getItem` of a marker's key, the enumeration, or both): the leader's page is untouched. */
  const KINDS = ["getItem", "enumeration", "both"] as const;
  const reads = (kind: (typeof KINDS)[number]) => ({
    enumeration: kind !== "getItem",
    getItem: kind !== "enumeration",
  });
  /** What a page does that recomputes the gate with nothing new to say about the marker: connectivity lost and regained. */
  const wobble = (page: Page) =>
    page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });

  for (const path of ["marker", "quota"] as const)
    for (const kind of KINDS)
      test(`${path}, ${kind} unreadable: the follower that read the marker stays hidden through an offline event and a re-read of the facts, the marker and the cached row remain, and it is hidden on the read that lands`, async ({
        context,
      }, info) => {
        const { leader, follower, release, opKey } =
          await followerBeforeFailure(context, path);
        await installMarkerReadFaults(follower);
        release();
        await waitForState(leader, "stopped");
        await expect
          .poll(() => cacheState(follower), { timeout: 10_000 })
          .toBe("invalid");
        expect(await gate(follower)).toBe("refreshing");
        // The follower's reads of `localStorage` now fail, as an unreadable storage's do (the leader's page can still read and write).
        await markerReads(follower, reads(kind));
        await follower.evaluate(() => window.__atlasData?.resetGateHistory());
        await wobble(follower);
        await follower.evaluate(() => window.__atlasData?.nudgeSync?.());
        for (let sample = 0; sample < 8; sample += 1) {
          await follower.waitForTimeout(250);
          await wobble(follower);
          expect(await gate(follower)).not.toBe("open");
          expect(await cacheState(follower)).toBe("invalid");
        }
        const seen = await history(follower);
        expect(seen).not.toContain("valid");
        // Nothing recovered: the marker is still the leader's record of the invalidation, and the retained row is in the store.
        expect(await markerKeys(leader)).toEqual([opKey]);
        expect(await retained(follower)).toEqual({ cache: 1, drafts: 1 });
        // The store can be read again: the marker says what it said.
        await markerReads(follower, NO_READ_FAULTS);
        await wobble(follower);
        await follower.waitForTimeout(250);
        expect(await gate(follower)).toBe("refreshing");
        expect(await cacheState(follower)).toBe("invalid");
        recordEvidence(info, `r47-follower-${path}-${kind}`, { history: seen });
        await follower.close();
        await leader.close();
      });
});

/**
 * E-C8 (revision 29, R47(a)): a page whose `localStorage` GETTER throws does not open a cache the server said was invalid, in a real engine.
 *
 * The independent review of revision 28 seeded a retained cache whose facts still say `valid` and whose invalidation is recorded only in
 * its marker (or only in the durable counter), built a fresh controller while the getter threw (blocked site data), restored it, and saw
 * the cache `valid` and the gate `open` in Chromium, Firefox and WebKit: the markers module had captured `undefined` once and answered
 * every question as an empty store. Here a page is booted with `window.localStorage` throwing from its FIRST script (an init script;
 * the harness's markers are built under it), its controller (`startGate`) reads the facts, and the cache must stay hidden: `unverified`
 * while nothing can be read, never `valid` in between, `invalid` once access returns and the marker is read (the controller asks again on
 * its own pace: nothing notifies it), and `valid` and open again only when a read lands and finds no marker.
 *
 * FIXTURE evidence: the throwing getter is installed by the spec (a real blocked-site-data page is not produced), the controller is the
 * fixture's composition of the production one, and the records are seeded by a leader page that is then left alone.
 */
test.describe("E-C8 (revision 29, R47): a page whose storage getter threw does not open an invalid cache, in a real engine", () => {
  /** `window.localStorage` throws a `SecurityError` from the page's first script until `unblock`. */
  const blockInit = () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const state = { blocked: true };
    (window as unknown as { __block: typeof state }).__block = state;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        if (state.blocked)
          throw new DOMException("injected blocked access", "SecurityError");
        return descriptor?.get?.call(window);
      },
    });
  };
  const unblock = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { __block: { blocked: boolean } }).__block.blocked =
        false;
    });
  async function blockedPage(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    await page.addInitScript(blockInit);
    await page.goto("/__session?route=%2Ftoday");
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    return page;
  }

  for (const record of ["marker", "counter"] as const)
    test(`R47 getter: ${record}: the cache stays hidden while the getter throws and never reads \`valid\`, and it is \`invalid\` once access returns and the record is read`, async ({
      context,
    }, info) => {
      const { leader } = await leaderWith(context, record);
      const page = await blockedPage(context);
      await page.evaluate(
        (a) => window.__atlasData?.startGate(a, { established: false }),
        ACCOUNT,
      );
      await page.evaluate(() => window.__atlasData?.resetGateHistory());
      for (let sample = 0; sample < 12; sample += 1) {
        await page.waitForTimeout(250);
        expect(await gate(page)).not.toBe("open");
        expect(await cacheState(page)).toBe(
          record === "counter" ? "invalid" : "unverified",
        );
      }
      expect(await history(page)).not.toContain("valid");
      await unblock(page);
      await expect
        .poll(() => cacheState(page), { timeout: 20_000 })
        .toBe("invalid");
      expect(await gate(page)).toBe("refreshing");
      expect(await history(page)).not.toContain("valid");
      expect(await retained(page)).toEqual({ cache: 1, drafts: 1 });
      recordEvidence(info, `r47-getter-${record}`, {
        history: await history(page),
        markers: await markerKeys(leader),
      });
    });

  test("R47 getter: control: with no record at all the cache stays `unverified` while the getter throws, and opens only when a read lands", async ({
    context,
  }, info) => {
    await leaderWith(context, "valid");
    const page = await blockedPage(context);
    await page.evaluate(
      (a) => window.__atlasData?.startGate(a, { established: false }),
      ACCOUNT,
    );
    await page.evaluate(() => window.__atlasData?.resetGateHistory());
    for (let sample = 0; sample < 12; sample += 1) {
      await page.waitForTimeout(250);
      expect(await gate(page)).not.toBe("open");
      expect(await cacheState(page)).toBe("unverified");
    }
    await unblock(page);
    await expect
      .poll(() => cacheState(page), { timeout: 20_000 })
      .toBe("valid");
    expect(await gate(page)).toBe("open");
    recordEvidence(info, "r47-getter-control", {
      history: await history(page),
    });
  });
});

/**
 * E-C8 (revision 30, R47): an OLDER removal of the invalidation's marker is no proof about a NEWER one, in a real engine.
 *
 * The independent review of revision 29 had a page's engine apply an ordinary EMPTY page that retains its cursor (F-C2 permits it: no
 * request, no direct call of the markers), whose success path removes the page's and the invalidation's markers at that position. Another
 * page then recorded a NEW `invalidate:<cursor>` marker with its notification held, and the reads of the markers failed; the facts still
 * said `valid` (a failed invalidation is represented only by its fallback marker), and the controller published `cache: valid`,
 * `gate: open` over a cache the server had said was invalid, in Chromium, Firefox and WebKit. A completed removal establishes absence at
 * that removal and nothing after it. Here the leader page's REAL engine applies the empty page (a scripted answer that retains the
 * cursor), a SECOND REAL PAGE writes the new marker into the REAL `localStorage`, the leader's marker reads throw and its marker
 * notifications are held back (or delivered, or the reads work), and the gate is derived by the production controller.
 *
 * What is asserted: with a new marker the cache is hidden and never reads `valid`, whatever the page can read and has heard; with NO
 * new marker and nothing readable it cannot be told from that case, so it is hidden too (deliberately: see `docs/data-layer.md`) and
 * opens when a read lands and finds nothing; a readable store with no marker is open at once. FIXTURE evidence: the HTTP answers are
 * scripted, the unreadable storage and the held notification are installed by the spec, the controller is the fixture's composition of
 * the production one, and no screen is rendered.
 */
test.describe("E-C8 (revision 30, R47): an older removal of the invalidation's marker is no proof about a newer one, in a real engine", () => {
  const NONE = NO_READ_FAULTS;
  // ADAPTED, revision 34 (premises P8 and P10): the origin's listing is a witness of a failure now, so "nothing readable" refuses it as well
  // as every individual read. With only the reads refused, a NEW marker was named by the listing, the page knew of it, and the case could no
  // longer tell a page that takes its own earlier removal for evidence of absence from one that does not (MU-956 survived the affected
  // real-engine run of revision 34 for that reason; MU-957 and MU-946 were the same class).
  const BOTH = { ...NO_READ_FAULTS, getItem: true, enumeration: true };
  interface Schedule {
    name: string;
    /** Another page wrote a NEW marker after the engine's removal. */
    newMarker: boolean;
    /** The leader's marker reads work when the gate is derived. */
    readable: boolean;
    /** The notification of that write reaches the leader before the gate is derived. */
    delivered: boolean;
  }
  const SCHEDULES: Schedule[] = [
    {
      name: "a NEW marker, its notification held, nothing readable",
      newMarker: true,
      readable: false,
      delivered: false,
    },
    {
      name: "a NEW marker, its notification delivered, nothing readable",
      newMarker: true,
      readable: false,
      delivered: true,
    },
    {
      name: "a NEW marker that can be read (its notification held)",
      newMarker: true,
      readable: true,
      delivered: false,
    },
    {
      name: "NO new marker and nothing readable (indistinguishable from the first)",
      newMarker: false,
      readable: false,
      delivered: false,
    },
    {
      name: "NO new marker and it can be read",
      newMarker: false,
      readable: true,
      delivered: false,
    },
  ];

  /** The leader's real engine applies an empty page that retains `cursor-0`; the engine is then stopped and the records are seeded. */
  async function afterAutomaticRemoval(context: BrowserContext) {
    const net = await stubNetwork(context);
    net.script.push((url) => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [],
        next_cursor: url.searchParams.get("cursor") ?? "cursor-0",
        has_more: false,
      }),
    }));
    await seedSettled(context);
    // The leader's storage hold must be its FIRST `storage` listener (see `storageHoldInit`): installed before the page exists.
    await installStorageHold(context);
    const leader = await bootSession(context);
    await installMarkerReadFaults(leader);
    await startLeaderSettled(leader);
    await waitForState(leader, "idle");
    await seedRecord(leader, "valid");
    const { cursor } = await syncFacts(leader);
    expect(cursor).toBe("cursor-0");
    expect(net.requests).toHaveLength(1);
    return {
      net,
      leader,
      key: fixedOperationKey(`invalidate:${cursor}`),
    };
  }

  for (const schedule of SCHEDULES)
    test(`R47 older removal: an ordinary page success retires the marker, then ${schedule.name}`, async ({
      context,
    }, info) => {
      const { leader, key } = await afterAutomaticRemoval(context);
      expect(await markerKeys(leader)).toEqual([]);
      // The notification feed of marker keys: held or delivered, as the schedule says (installed in both cases, so it can count).
      if (!schedule.delivered) await holdStorageEvents(leader);
      if (!schedule.readable) await markerReads(leader, BOTH);
      const writer = await dataPage(context);
      if (schedule.newMarker) {
        await writeKey(writer, key);
        await expect
          .poll(
            async () => {
              const seen = await markerEventCounts(leader);
              return schedule.delivered ? seen.received : seen.held;
            },
            { timeout: 10_000 },
          )
          .toBeGreaterThan(0);
      }
      // The controller is derived NOW, after the removal and the new marker, as a page's tree is when it binds.
      await leader.evaluate(
        ({ a, established }) =>
          window.__atlasData?.startGate(a, { established }),
        { a: ACCOUNT, established: schedule.readable },
      );
      const opens = schedule.readable && !schedule.newMarker;
      // The module's own answer in the real engine: what a read that landed said, else `unknown`, never `unmarked` for want of a read.
      expect(
        await leader.evaluate(
          ([account, operation, lifetime]) =>
            window.__atlasData?.markers.probe(
              { account: account as string, incarnationId: lifetime as string },
              operation as string,
            ),
          [ACCOUNT, "invalidate:cursor-0", FIXED_INCARNATION],
        ),
      ).toBe(
        !schedule.readable
          ? "unknown"
          : schedule.newMarker
            ? "marked"
            : "unmarked",
      );
      for (let sample = 0; sample < 6; sample += 1) {
        await leader.waitForTimeout(250);
        expect((await gate(leader)) === "open").toBe(opens);
      }
      expect(await cacheState(leader)).toBe(
        opens ? "valid" : schedule.readable ? "invalid" : "unverified",
      );
      const seen = await history(leader);
      if (!opens) expect(seen).not.toContain("valid");
      expect(await retained(leader)).toEqual({ cache: 1, drafts: 1 });
      expect((await markerKeys(writer)).length).toBe(
        schedule.newMarker ? 1 : 0,
      );
      recordEvidence(info, `r47-older-removal-${SCHEDULES.indexOf(schedule)}`, {
        history: seen,
        events: await markerEventCounts(leader),
        markers: await markerKeys(writer),
      });
      if (!schedule.readable) {
        // The store can be read again and the held notification is delivered: what the marker says is what shows.
        await markerReads(leader, NONE);
        await releaseStorageEvents(leader);
        await expect
          .poll(() => cacheState(leader), { timeout: 20_000 })
          .toBe(schedule.newMarker ? "invalid" : "valid");
        expect(await gate(leader)).toBe(
          schedule.newMarker ? "refreshing" : "open",
        );
      }
    });

  test("R47 older removal: a controller that is ALREADY open is hidden by its next derivation when a new marker's notification is held and nothing can be read", async ({
    context,
  }, info) => {
    const { leader, key } = await afterAutomaticRemoval(context);
    await leader.evaluate((a) => window.__atlasData?.startGate(a), ACCOUNT);
    expect(await gate(leader)).toBe("open");
    await leader.evaluate(() => window.__atlasData?.resetGateHistory());
    await holdStorageEvents(leader);
    await markerReads(leader, BOTH);
    const writer = await dataPage(context);
    await writeKey(writer, key);
    await expect
      .poll(async () => (await markerEventCounts(leader)).held, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    // What a page does that derives the gate again with nothing new to say about the marker: connectivity lost and regained.
    await leader.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await expect
      .poll(() => cacheState(leader), { timeout: 10_000 })
      .not.toBe("valid");
    for (let sample = 0; sample < 6; sample += 1) {
      await leader.waitForTimeout(250);
      expect(await gate(leader)).not.toBe("open");
    }
    expect(await markerKeys(writer)).toEqual([key]);
    recordEvidence(info, "r47-older-removal-live", {
      history: await history(leader),
    });
  });
});

/**
 * E-C8 (revision 31, R51): an OLDER page completion, delivered late, does not erase a NEWER invalidation's fallback marker, in a real engine.
 *
 * The independent review of revision 30 had a page's engine apply an ordinary EMPTY delta page that keeps `cursor-0` and held the delivery
 * of that successful commit's answer. A second page's engine then received `410` at that position, its invalidation and counter writes
 * aborted (real IndexedDB transactions), and its failure path recorded `invalidate:cursor-0` in the real `localStorage`: an attached follower
 * hid the cache. Releasing the older completion removed that marker (the success path retired `page:<cursor>` and `invalidate:<cursor>`
 * unconditionally), while the durable singleton still said `valid`, and a follower attached afterwards reported `cache: valid`,
 * `gate: open` over a cache the server had said was invalid (one failing case in each of Chromium, Firefox and WebKit). The request is
 * now admitted over the markers the capture gate read, and its success retires those and no newer one. Here the leader page's REAL engine
 * applies the page (its commit's answer held by the fixture's `holdEnginePlan`, the transaction committed at once), a SECOND REAL PAGE's
 * engine receives the `410` (the spec's `page.route`) and fails its invalidation write and its counter write (the spec's `installFault`),
 * a follower is attached while the older completion is held, the completion is released, and a SECOND follower is attached afterwards.
 *
 * What is asserted: the newer marker is exactly as it was recorded after the release, both followers (the one attached before and the one
 * attached after) are hidden (`refreshing`, `invalid`), never `open` over the invalidation, and the durable and the timely controls behave
 * the same. FIXTURE evidence for this engine on this machine: the HTTP answers are scripted, the delayed delivery and the aborted writes
 * are installed by the spec, the leaders are the fixture's test leaders (production starts none until WEB-09b), and the pages are FIXTURE
 * compositions of the production controller; no screen is rendered and no real storage failure is produced.
 */
test.describe("E-C8 (revision 31, R51): an older page completion does not erase a newer invalidation's marker, in a real engine", () => {
  type Scenario = "timely-marker" | "delayed-marker" | "delayed-durable";
  const SCENARIOS: Scenario[] = [
    "timely-marker",
    "delayed-marker",
    "delayed-durable",
  ];
  const KEY = fixedOperationKey("invalidate:cursor-0");
  const traced = (page: Page, text: string) =>
    page.evaluate(
      (needle) =>
        window.__atlasData?.engineTrace.some((line) => line.includes(needle)) ??
        false,
      text,
    );
  /** The names of the failures whose markers stand for the position's invalidation, joined (ADAPTED, revision 32: it was one key's value). */
  const markerName = (page: Page) =>
    page.evaluate(
      (key) =>
        Object.keys(localStorage)
          .filter((name) => name === key || name.startsWith(`${key}#`))
          .map((name) => name.slice(key.length + 1))
          .sort()
          .join(",") || null,
      KEY,
    );

  /**
   * The leader applies an ordinary EMPTY page that keeps `cursor-0`; with `holds`, the answer of that commit is held, owned by the case's
   * held-operation scope (revision 21, R20-N1: released and checked by its own token on every path).
   */
  async function leaderApplies(
    context: BrowserContext,
    holds: HeldOperations | null,
  ) {
    const net = await stubNetwork(context);
    await serveIdentityReads(context);
    await seedSettled(context);
    const leader = await bootSession(context);
    net.script.push((url) => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [],
        next_cursor: url.searchParams.get("cursor") ?? "cursor-0",
        has_more: false,
      }),
    }));
    const hold =
      holds === null ? null : await holds.holdEngine(leader, "data.commitPage");
    await startLeaderSettled(leader);
    if (hold !== null) await hold.untilHeld();
    else {
      await waitForState(leader, "idle");
      // The timely control: the page is applied and its completion delivered, and the leader polls no more, so that the position stays
      // where the page left it while the other page boots (a slow engine would otherwise see the idle poll move it on).
      await leader.evaluate(() => window.__atlasData?.stopSync());
    }
    // The records a hidden cache must not show: a cache row and a draft, put without stopping the engine.
    await leader.evaluate(
      async ({ a, row, draft }) => {
        const h = window.__atlasData;
        if (h === undefined) throw new Error("no harness");
        await h.put(a, "cache", [row]);
        await h.put(a, "drafts", [draft]);
      },
      { a: ACCOUNT, row: RETAINED_ROW, draft: DRAFT },
    );
    expect(net.requests).toHaveLength(1);
    return { net, leader, hold };
  }

  /** Another page whose real engine receives `410` at `cursor-0`; with `aborts`, its invalidation and counter writes abort. */
  async function invalidatesAnother(context: BrowserContext, aborts: boolean) {
    const writer = await bootSession(context);
    const path: Path = "marker";
    if (aborts) await writer.evaluate(installFault, path);
    await writer.route("**/sync?**", (route) =>
      route.fulfill({
        status: 410,
        contentType: "application/json",
        body: atlasError("resync_required"),
      }),
    );
    await startLeaderSettled(writer);
    if (aborts)
      await expect
        .poll(() => markerKeys(writer), { timeout: 20_000 })
        .toEqual([KEY]);
    else
      await expect
        .poll(async () => (await readSyncFacts(writer)).cache_status, {
          timeout: 20_000,
        })
        .toBe("invalid");
    return writer;
  }

  for (const scenario of SCENARIOS)
    test(`R51 older completion: ${scenario}: the newer invalidation stays exactly as recorded, and the cache stays hidden for the follower attached before and for one attached afterwards`, async ({
      context,
    }, info) => {
      // Revision 21 (R20-N1): the held completion is owned by a scope that releases it by its own token on every path.
      const run = async (holds: HeldOperations | null) => {
        const { leader, hold } = await leaderApplies(context, holds);
        const writer = await invalidatesAnother(
          context,
          scenario !== "delayed-durable",
        );
        const recorded = await markerName(writer);
        expect(recorded === null).toBe(scenario === "delayed-durable");
        const attached = await watchingPage(context);
        await attached.evaluate(
          (a) => window.__atlasData?.startGate(a),
          ACCOUNT,
        );
        await expect
          .poll(() => gate(attached), { timeout: 20_000 })
          .toBe("refreshing");
        if (hold !== null) {
          // The older completion is delivered now: the engine's success path runs.
          expect(await traced(leader, "data.sync_commit")).toBe(false);
          await hold.release();
          await expect
            .poll(() => traced(leader, "data.sync_next"), { timeout: 20_000 })
            .toBe(true);
        }
        for (let sample = 0; sample < 6; sample += 1) {
          await attached.waitForTimeout(250);
          expect(await gate(attached)).toBe("refreshing");
        }
        expect(await markerName(writer)).toBe(recorded);
        expect((await markerKeys(writer)).length).toBe(
          scenario === "delayed-durable" ? 0 : 1,
        );
        // A follower attached NOW reads the records and has no cached state to lean on.
        const later = await watchingPage(context);
        await later.evaluate((a) => window.__atlasData?.startGate(a), ACCOUNT);
        await expect
          .poll(() => cacheState(later), { timeout: 20_000 })
          .toBe("invalid");
        for (let sample = 0; sample < 6; sample += 1) {
          await later.waitForTimeout(250);
          expect(await gate(later)).toBe("refreshing");
        }
        expect(await history(later)).not.toContain("valid");
        expect(await retained(later)).toEqual({ cache: 1, drafts: 1 });
        recordEvidence(info, `r51-${scenario}`, {
          recorded,
          after: await markerName(writer),
          attached: await history(attached),
          later: await history(later),
        });
      };
      if (scenario === "timely-marker") await run(null);
      else await withHeldOperations(run);
    });
});

/**
 * E-C8 (revision 31, R47): a REMOVAL the engine really makes is still no proof about a NEWER marker, in a real engine.
 *
 * Revision 30's schedule had the engine's ordinary page success remove a marker that was not there to be removed by anyone; since the engine
 * retires only the markers its capture gate saw (R51), that schedule no longer removes anything, and it would not notice a page that took a
 * removal as evidence of absence. This one performs a genuine supersession: another page records an invalidation that only its marker holds
 * (the facts still say `valid`), the leader's engine stops at it, the person's retry lifts the stop for one cycle and the server accepts the
 * position again (an empty page that keeps `cursor-0`), so the engine retires the marker its gate saw. Then ANOTHER page records a NEW
 * marker, its notification held and the markers unreadable, and the gate is derived by the production controller: it must not open over the
 * cache the server had said was invalid, whatever the page removed itself earlier. With no new marker and a readable store the recovery is
 * intact and the cache opens. FIXTURE evidence: the HTTP answers are scripted, the unreadable storage and the held notification are
 * installed by the spec, the leader is the fixture's test leader and the controller its composition of the production one.
 */
test.describe("E-C8 (revision 31, R47): a removal the engine really makes is no proof about a newer marker, in a real engine", () => {
  const KEY = fixedOperationKey("invalidate:cursor-0");
  // ADAPTED, revision 34 (premises P8 and P10): the origin's listing is a witness of a failure now, so "nothing readable" refuses it as well
  // as every individual read. With only the reads refused, a NEW marker was named by the listing, the page knew of it, and the case could no
  // longer tell a page that takes its own earlier removal for evidence of absence from one that does not (MU-956 survived the affected
  // real-engine run of revision 34 for that reason; MU-957 and MU-946 were the same class).
  const BOTH = { ...NO_READ_FAULTS, getItem: true, enumeration: true };
  const NONE = NO_READ_FAULTS;

  async function afterGenuineSupersession(context: BrowserContext) {
    const net = await stubNetwork(context);
    await seedSettled(context);
    // The leader's storage hold must be its FIRST `storage` listener (see `storageHoldInit`): installed before the page exists.
    await installStorageHold(context);
    const leader = await bootSession(context);
    await installMarkerReadFaults(leader);
    // Another page records an invalidation that only its marker holds, before the leader's engine starts.
    const writer = await dataPage(context);
    await writeKey(writer, KEY);
    await startLeaderSettled(leader);
    await waitForState(leader, "stopped");
    expect(await markerKeys(writer)).toEqual([KEY]);
    // The person's retry lifts the stop for one cycle, and the server accepts the position again.
    net.script.push((url) => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [],
        next_cursor: url.searchParams.get("cursor") ?? "cursor-0",
        has_more: false,
      }),
    }));
    await leader.evaluate(() => window.__atlasData?.retrySync());
    await expect
      .poll(() => markerKeys(writer), { timeout: 20_000 })
      .toEqual([]);
    await waitForState(leader, "idle");
    expect((await readSyncFacts(leader)).cursor).toBe("cursor-0");
    return { leader, writer };
  }

  test("R47 genuine supersession: the engine retires the marker its gate saw, then a NEW marker with its notification held and nothing readable: the cache stays hidden, and shows invalid once a read lands", async ({
    context,
  }, info) => {
    const { leader, writer } = await afterGenuineSupersession(context);
    await holdStorageEvents(leader);
    await markerReads(leader, BOTH);
    await writeKey(writer, KEY);
    await expect
      .poll(async () => (await markerEventCounts(leader)).held, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    // The controller is derived NOW, after the removal and the new marker, as a page's tree is when it binds.
    await leader.evaluate(
      (a) => window.__atlasData?.startGate(a, { established: false }),
      ACCOUNT,
    );
    for (let sample = 0; sample < 6; sample += 1) {
      await leader.waitForTimeout(250);
      expect(await gate(leader)).not.toBe("open");
    }
    expect(await history(leader)).not.toContain("valid");
    expect(await markerKeys(writer)).toEqual([KEY]);
    recordEvidence(info, "r47-genuine-supersession-new-marker", {
      history: await history(leader),
      events: await markerEventCounts(leader),
    });
    // The store can be read again and the held notification is delivered: what the marker says is what shows.
    await markerReads(leader, NONE);
    await releaseStorageEvents(leader);
    await expect
      .poll(() => cacheState(leader), { timeout: 20_000 })
      .toBe("invalid");
    expect(await gate(leader)).toBe("refreshing");
  });

  test("R47 genuine supersession: the engine retires the marker its gate saw and NO new marker is recorded: with a readable store the cache opens (the person's recovery is intact)", async ({
    context,
  }, info) => {
    const { leader, writer } = await afterGenuineSupersession(context);
    await leader.evaluate(
      (a) => window.__atlasData?.startGate(a, { established: true }),
      ACCOUNT,
    );
    await expect.poll(() => gate(leader), { timeout: 20_000 }).toBe("open");
    expect(await cacheState(leader)).toBe("valid");
    expect(await markerKeys(writer)).toEqual([]);
    recordEvidence(info, "r47-genuine-supersession-no-new-marker", {
      history: await history(leader),
    });
  });
});

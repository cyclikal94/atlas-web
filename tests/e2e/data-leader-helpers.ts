import type { BrowserContext, Page, Route } from "@playwright/test";
import { ACCOUNT, settled, upsert } from "./data-sync-helpers";
import { expect } from "./helpers";

/**
 * Helpers for the PRODUCTION leader's real-engine specs (WEB-09b): the production session on `/__session?leader=production`, the
 * network stubbed per context with every `/sync` attributed to the page that sent it, the identity reads served (an unserved `/me` or
 * `/sessions` makes the page ask again and again), and the session harness's fixture-only leader inspector. FIXTURE evidence: there is
 * no backend behind any of it, and the stub `/sync` is scripted by the test.
 */
export { ACCOUNT };

export interface SyncCall {
  page: string;
  cursor: string | null;
  limit: string | null;
  at: number;
}
export interface Scripted {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export interface LeaderNet {
  calls: SyncCall[];
  commands: Array<{ page: string; path: string; key: string | null }>;
  /** Answers each `/sync`; the default answers a cursor-less request with an empty one-page snapshot and any other with an empty delta. */
  answer: (call: SyncCall) => Scripted | Promise<Scripted>;
  /** Answers `GET /browser-sessions/current` (the session's verification); default: the session of `identity`, current. */
  current?: () => Scripted | Promise<Scripted>;
  /**
   * The account and session the stub's identity reads answer for (`/browser-sessions/current`, `/me`, `/sessions`). A case that switches
   * accounts (another tab signs in as someone else) moves it with the record (review cycle 1: E-B6 to E-B8).
   */
  identity: { account: string; session: string };
  /** Answers a command (`POST /commands` and the like); default: `200` with a revision. A held promise holds the command in flight. */
  command?: (call: {
    page: string;
    path: string;
    key: string | null;
  }) => Scripted | Promise<Scripted>;
  /** The `DELETE /sessions/<id>` of a logout (its idempotency key), answered `confirmed_applied` for the current identity. */
  logouts: Array<{ path: string; key: string | null }>;
  /**
   * While true every API request fails as a disconnected network would (`internetdisconnected`). Used with `goOffline` (the page's
   * `navigator.onLine`): the app's own boundary is offline while its assets, already served, stay loadable.
   */
  offline: boolean;
  label(page: Page, name: string): void;
}

const json = (status: number, body: unknown): Scripted => ({
  status,
  body: JSON.stringify(body),
});
export const snapshotPage = (
  changes: unknown[],
  next: string,
  hasMore: boolean,
  revision = 10,
): Scripted =>
  json(200, {
    phase: "snapshot",
    batches: [{ revision, changes }],
    next_cursor: next,
    has_more: hasMore,
  });
export const deltaPage = (
  changes: unknown[],
  next: string,
  revision = 20,
): Scripted =>
  json(200, {
    phase: "delta",
    batches: changes.length === 0 ? [] : [{ revision, changes }],
    next_cursor: next,
    has_more: false,
  });
export const status = (code: number, body: unknown = {}): Scripted =>
  json(code, body);

export async function leaderNetwork(
  context: BrowserContext,
  account = ACCOUNT,
): Promise<LeaderNet> {
  const labels = new Map<Page, string>();
  const net: LeaderNet = {
    calls: [],
    commands: [],
    answer: (call) =>
      call.cursor === null
        ? snapshotPage([], "delta-0", false)
        : deltaPage([], call.cursor),
    label: (page, name) => labels.set(page, name),
    identity: { account, session: "s1" },
    logouts: [],
    offline: false,
  };
  const now = Date.now();
  await context.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: "0.29.0" }),
    }),
  );
  await context.route("**/api/experimental/v1/**", async (route: Route) => {
    if (net.offline)
      return route.abort("internetdisconnected").catch(() => undefined);
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/experimental/v1", "");
    const pageOf = (): string => {
      try {
        return labels.get(request.frame().page()) ?? "unlabelled";
      } catch {
        return "unknown";
      }
    };
    // A request the page itself abandoned while its answer was held (an aborted binding, a closed page) can no longer be fulfilled;
    // that is not a failure of the case.
    const fulfil = (answer: Scripted) =>
      route
        .fulfill({
          status: answer.status,
          contentType: "application/json",
          headers: answer.headers,
          body: answer.body,
        })
        .catch(() => undefined);
    if (path === "/browser-sessions/current" && net.current !== undefined)
      return fulfil(await net.current());
    if (path === "/browser-sessions/current")
      return fulfil(
        json(200, {
          account_id: net.identity.account,
          session_id: net.identity.session,
          expires_at: new Date(now + 86_400_000).toISOString(),
          csrf_token: `csrf.${net.identity.session}`,
        }),
      );
    if (path === "/me")
      return fulfil(json(200, { id: net.identity.account, username: "alice" }));
    if (request.method() === "DELETE" && /^\/sessions\/[^/]+$/.test(path)) {
      const key = request.headers()["idempotency-key"] ?? null;
      net.logouts.push({ path, key });
      return fulfil(
        json(200, {
          operation_id: key,
          account_id: net.identity.account,
          outcome: "confirmed_applied",
        }),
      );
    }
    if (path === "/sessions")
      return fulfil(
        json(200, {
          sessions: [
            {
              id: net.identity.session,
              device_id: "dev-1",
              created_at: new Date(now - 60_000).toISOString(),
              expires_at: new Date(now + 86_400_000).toISOString(),
              authentication: "password",
              current: true,
            },
          ],
        }),
      );
    if (path === "/sync") {
      const call: SyncCall = {
        page: pageOf(),
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
        at: Date.now(),
      };
      net.calls.push(call);
      return fulfil(await net.answer(call));
    }
    if (/^\/(?:commands|task-commands|reminder-commands)$/.test(path)) {
      const call = {
        page: pageOf(),
        path,
        key: request.headers()["idempotency-key"] ?? null,
      };
      net.commands.push(call);
      if (net.command !== undefined) return fulfil(await net.command(call));
      return fulfil(json(200, { revision: 200 + net.commands.length }));
    }
    return fulfil(json(404, {}));
  });
  return net;
}

/** Seeds a settled `auth_state` (and optionally a fence) through the production store, before any session page boots. */
export async function seedAuth(
  context: BrowserContext,
  state: unknown = settled(ACCOUNT),
): Promise<void> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () =>
      window.__atlasFixture?.session !== undefined &&
      window.__atlasData !== undefined,
  );
  await page.evaluate(async (value) => {
    await window.__atlasFixture?.session?.seedAuthState(value);
  }, state);
  await page.close();
}

/**
 * A recovery-eligible record (matrix 3.7.3): the account settled at epoch 2, and one `invalid_session` fence entry of the EARLIER epoch 1
 * (a re-authentication after an ambiguous `401`), no gating attempt and no lease.
 */
export const fencedAfterReauth = (account = ACCOUNT) => ({
  schema: 1,
  latest_epoch: 2,
  fence_seq: 1,
  attempt: null,
  settled: {
    account_id: account,
    epoch: 2,
    settled_at: new Date().toISOString(),
    session_id: "s1",
  },
  fences: {
    [account]: [
      {
        seq: 1,
        epoch: 1,
        obs_id: "obs-1",
        created_at: new Date().toISOString(),
        kind: "invalid_session",
        reason: "current_401",
      },
    ],
  },
  leases: {},
});

/** A session page with the PRODUCTION leader (`?leader=production`), booted, the data harness attached. */
export async function leaderPage(
  context: BrowserContext,
  net: LeaderNet,
  name: string,
  existing?: Page,
  options: { route?: string } = {},
): Promise<Page> {
  const page = existing ?? (await context.newPage());
  net.label(page, name);
  await page.goto(
    `/__session?route=${encodeURIComponent(options.route ?? "/today")}&leader=production`,
  );
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

export type LeaderView = ReturnType<
  NonNullable<NonNullable<Window["__atlasFixture"]>["session"]>["leader"]
>;
export const leaderOf = (page: Page): Promise<LeaderView> =>
  page.evaluate(() => window.__atlasFixture?.session?.leader() as LeaderView);

/** Polls the page's leader view until `ready` says so; the last view is returned (an assertion follows, never a silent timeout). */
export async function untilLeader(
  page: Page,
  ready: (view: LeaderView) => boolean,
  timeoutMs = 15_000,
): Promise<LeaderView> {
  const started = Date.now();
  let view = await leaderOf(page);
  while (!ready(view) && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(50);
    view = await leaderOf(page);
  }
  return view;
}

/**
 * The harness's own READ handle of the account's database (its facts name the account, so the open predicate admits it), opened on first
 * use and only if the database exists: a read never creates. Null while there is no database.
 */
export const syncStateOf = (
  page: Page,
  account = ACCOUNT,
): Promise<Record<string, unknown> | null> =>
  page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) return null;
    // The harness's handle is closed under it when the page's identity leaves the account (an account switch closes every
    // connection of the account on the page): a closed handle is dropped and the database opened again, once.
    for (let round = 0; round < 2; round += 1) {
      if (!data.stores.has(a)) {
        data.setIdentity(a);
        const opened = await data.open(a);
        if (opened !== "opened" && opened !== "created") return null;
      }
      try {
        return await data.syncState(a);
      } catch (error) {
        if (round > 0 || !String(error).includes("closed")) throw error;
        data.close(a);
      }
    }
    return null;
  }, account);

export async function untilSync(
  page: Page,
  ready: (sync: Record<string, unknown> | null) => boolean,
  account = ACCOUNT,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  const started = Date.now();
  let sync = await syncStateOf(page, account);
  while (!ready(sync) && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(50);
    sync = await syncStateOf(page, account);
  }
  return sync;
}

export const rowsOf = (
  page: Page,
  store: string,
  account = ACCOUNT,
): Promise<object[]> =>
  page.evaluate(
    async ([a, name]) => {
      const data = window.__atlasData;
      if (!data) return [];
      // As `syncStateOf`: a handle closed by an account switch is dropped and opened again, once.
      for (let round = 0; round < 2; round += 1) {
        if (!data.stores.has(a)) {
          data.setIdentity(a);
          const opened = await data.open(a);
          if (opened !== "opened" && opened !== "created") return [];
        }
        try {
          return await data.rows(a, name as never);
        } catch (error) {
          if (round > 0 || !String(error).includes("closed")) throw error;
          data.close(a);
        }
      }
      return [];
    },
    [account, store] as const,
  );

/** A held answer: `release` answers it with what was scripted. */
export function held(): {
  promise: Promise<void>;
  release(): void;
} {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A leader page whose session starts only after `install` has run in the LIVE page (`?boot=manual`, R34): a fault the case needs is in
 * force before the application's first request, and `install` checks it.
 */
export async function leaderPageAfter(
  context: BrowserContext,
  net: LeaderNet,
  name: string,
  install: (page: Page) => Promise<void>,
  options: { route?: string } = {},
): Promise<Page> {
  const page = await context.newPage();
  net.label(page, name);
  await page.goto(
    `/__session?route=${encodeURIComponent(options.route ?? "/today")}&leader=production&boot=manual`,
  );
  await page.waitForFunction(
    () =>
      window.__atlasFixture?.session !== undefined &&
      window.__atlasData !== undefined,
  );
  await install(page);
  await page.evaluate(() => window.__atlasFixture?.session?.start());
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  return page;
}

/**
 * NAMED FAULT (E-B14): the next `n` writes to `cache_staging` throw inside their transaction, which aborts it (a local write failure of
 * the staged page, never a quota). The page records each hit; nothing else is touched.
 */
export async function failStagingWrites(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    const w = window as unknown as {
      __staging?: { armed: number; hits: number };
    };
    if (w.__staging) {
      w.__staging.armed = count;
      return;
    }
    w.__staging = { armed: count, hits: 0 };
    const proto = IDBObjectStore.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const put = proto.put as (...a: unknown[]) => unknown;
    proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
      const fault = w.__staging;
      if (fault && fault.armed > 0 && this.name === "cache_staging") {
        fault.armed -= 1;
        fault.hits += 1;
        throw new DOMException("injected fault", "DataError");
      }
      return put.apply(this, args);
    };
  }, n);
}
export const stagingFaultHits = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as unknown as { __staging?: { hits: number } }).__staging?.hits ??
      0,
  );

/**
 * NAMED DELAY (E-B11): the activation's transaction (read-write, its scope holds both `cache` and `cache_staging`) is kept OPEN after it is created,
 * by a chain of reads placed from each other's success, until the page is closed: what the transaction wrote is then never committed.
 * `window.__activationHeld` says the injection engaged.
 */
export async function holdActivation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __activationHeld?: number };
    w.__activationHeld = 0;
    const proto = IDBDatabase.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const transaction = proto.transaction as (...a: unknown[]) => unknown;
    proto.transaction = function (this: IDBDatabase, ...args: unknown[]) {
      const tx = transaction.apply(this, args) as IDBTransaction;
      const names = Array.isArray(args[0]) ? (args[0] as string[]) : [args[0]];
      // Read-write only: Dexie's own read-only look at the schema when it opens names every store, and must not be held.
      if (
        args[1] === "readwrite" &&
        names.includes("cache") &&
        names.includes("cache_staging")
      ) {
        w.__activationHeld = (w.__activationHeld ?? 0) + 1;
        const store = tx.objectStore("sync_state");
        const again = (): void => {
          try {
            const request = store.get("singleton");
            request.onsuccess = again;
          } catch {
            // The transaction has ended (the page is going away).
          }
        };
        again();
      }
      return tx;
    };
  });
}

/**
 * NAMED FAULT (E-R4): the next `n` writes to `store` throw inside their transaction (a local write failure, never a quota). Installed
 * once per page; a later call re-arms it.
 */
export async function failStoreWrites(
  page: Page,
  store: string,
  n: number,
): Promise<void> {
  await page.evaluate(
    ([name, count]) => {
      const w = window as unknown as {
        __storeFault?: Record<string, { armed: number; hits: number }>;
      };
      if (w.__storeFault) {
        w.__storeFault[name] = { armed: count, hits: 0 };
        return;
      }
      w.__storeFault = { [name]: { armed: count, hits: 0 } };
      const proto = IDBObjectStore.prototype as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      const put = proto.put as (...a: unknown[]) => unknown;
      proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
        const fault = w.__storeFault?.[this.name];
        if (fault && fault.armed > 0) {
          fault.armed -= 1;
          fault.hits += 1;
          throw new DOMException("injected fault", "DataError");
        }
        return put.apply(this, args);
      };
    },
    [store, n] as const,
  );
}
export const storeFaultHits = (page: Page, store: string): Promise<number> =>
  page.evaluate(
    (name) =>
      (
        window as unknown as {
          __storeFault?: Record<string, { hits: number }>;
        }
      ).__storeFault?.[name]?.hits ?? 0,
    store,
  );

/**
 * NAMED HOLD (E-R6): once the recovery job reports its FINAL data commit (`data.recovery_commit` with `final: true`, pushed to the session
 * harness's trace in the same synchronous step), every later exclusive request of `atlas-auth` is never granted, so `finish_recovery` cannot
 * run. The page can then be closed between the data commit and the clear. `window.__finishHeld` says the hold engaged.
 */
export async function holdFinishAfterCommit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __finishHeld?: boolean;
      __atlasFixture?: { session?: { trace: Array<unknown> } };
    };
    w.__finishHeld = false;
    let armed = false;
    const trace = w.__atlasFixture?.session?.trace;
    if (!trace) throw new Error("no session harness trace");
    const push = trace.push.bind(trace);
    trace.push = (...items: unknown[]) => {
      for (const item of items as Array<{
        event?: string;
        data?: { final?: boolean; outcome?: string };
      }>)
        if (
          item.event === "data.recovery_commit" &&
          item.data?.final === true &&
          item.data?.outcome === "applied"
        )
          armed = true;
      return push(...items);
    };
    const proto = LockManager.prototype as unknown as {
      request: (...a: unknown[]) => Promise<unknown>;
    };
    const request = proto.request;
    proto.request = function (this: LockManager, ...args: unknown[]) {
      const name = args[0];
      const options =
        typeof args[1] === "object" && args[1] !== null
          ? (args[1] as LockOptions)
          : {};
      if (
        armed &&
        name === "atlas-auth" &&
        (options.mode ?? "exclusive") === "exclusive" &&
        options.ifAvailable !== true
      ) {
        w.__finishHeld = true;
        return new Promise<unknown>(() => undefined);
      }
      return request.apply(this, args as never);
    };
  });
}

// ---- shared arrangements of the leader and recovery specs (moved from fixture.data-leader.spec.ts, review cycle 1) ----
export const SNAP = (n: number[]) => n.map((i) => upsert(i, { n: i }));

export async function fresh(context: BrowserContext): Promise<LeaderNet> {
  const net = await leaderNetwork(context);
  await seedAuth(context);
  return net;
}

/** A database for ACCOUNT, created and arranged in a page that runs no session (`?boot=off`), before any leader page boots. */
export async function arrange(
  context: BrowserContext,
  steps: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  await page.evaluate(async (account) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no harness");
    data.setIdentity(account);
    const opened = await data.open(account, { create: true });
    if (opened !== "created" && opened !== "opened")
      throw new Error(`arrange: ${opened}`);
  }, ACCOUNT);
  await steps(page);
  await page.evaluate((account) => window.__atlasData?.close(account), ACCOUNT);
  await page.close();
}

export const ownerTab = async (page: Page): Promise<string | null> =>
  ((await syncStateOf(page))?.owner as { tab_id?: string } | null)?.tab_id ??
  null;
/** A draft row and its body, as the enqueue plan writes them (a FIXTURE arrangement, written by the harness). */
export const draft = (localId: string, status: string, seq: number) => ({
  header: {
    local_id: localId,
    account_id: ACCOUNT,
    endpoint: "/commands",
    target_id: null,
    kind: "note",
    command_digest: "d".repeat(64),
    defaults_revision: null,
    target_resource_ids: [],
    side_effect_bases: {},
    index_targets: [],
    bases: {},
    bumped: [],
    defaults_context: null,
    review_block: null,
    depends_on: [],
    status,
    ...(status === "blocked" ? { blocked_reason: "slice_capacity" } : {}),
    held_pending_cache: false,
    unavailable_outcome: false,
    retry_state: null,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    display_patch: null,
    receipt_revision: null,
    created_seq: seq,
    created_at: new Date().toISOString(),
  },
  body: {
    local_id: localId,
    command: { kind: "note", text: `${localId} body` },
  },
});
export const QUEUED = "11111111-0000-4000-8000-000000000001";
export const BLOCKED = "11111111-0000-4000-8000-000000000002";

export async function fencedWithCursor(
  context: BrowserContext,
): Promise<LeaderNet> {
  const net = await leaderNetwork(context);
  await seedAuth(context, fencedAfterReauth());
  await arrange(context, async (page) => {
    await page.evaluate(
      async ([account, rows]) => {
        const data = window.__atlasData;
        await data?.seedDelta(account, "delta-0");
        await data?.put(account, "cache", [
          {
            id: "00000000-0000-4000-8000-000000000040",
            kind: "task",
            parent_id: null,
            label: "kept",
            value: null,
            version: 1,
            can_edit: true,
            archived: false,
            kind_date: null,
          },
        ]);
        await data?.put(
          account,
          "drafts",
          rows.map((r) => r.header),
        );
        await data?.put(
          account,
          "draft_commands",
          rows.map((r) => r.body),
        );
      },
      [
        ACCOUNT,
        [draft(QUEUED, "queued", 1), draft(BLOCKED, "blocked", 2)],
      ] as const,
    );
  });
  return net;
}

/**
 * The account is displayed (the protected root is no longer inert). An ASSERTION that polls (review cycle 1): a case whose display
 * never comes fails on this expectation, not on a timeout, so a mutant that prevents the display is caught by an assertion (a timeout
 * is never evidence that a mutant was caught).
 */
export const displayed = (page: Page, timeout = 15_000) =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          // `null` (no `inert` attribute) is displayed; a page with no protected root is not.
          const root = document.getElementById("protected-root");
          return root === null
            ? "no protected root"
            : root.getAttribute("inert");
        }),
      { timeout, message: "the account should be displayed" },
    )
    .toBeNull();
export const fencesOf = async (page: Page): Promise<unknown[]> =>
  (
    (await page.evaluate(() =>
      window.__atlasFixture?.session?.readRecords(),
    )) as {
      auth_state: { fences: Record<string, unknown[]> };
    }
  ).auth_state.fences[ACCOUNT] ?? [];

/**
 * A re-authentication (or any settlement) made by ANOTHER tab while the specs' pages run: `auth_state` is written through the production
 * store from a page that runs no session, and the `atlas-auth` hint is posted, as a sign-in in another tab would post it. Every live
 * session page re-reads the record.
 */
export async function settleElsewhere(
  context: BrowserContext,
  state: unknown,
): Promise<void> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  await page.evaluate(async (value) => {
    const harness = window.__atlasFixture?.session;
    await harness?.seedAuthState(value);
    harness?.hints().post({ type: "auth_state_changed" });
  }, state);
  await page.close();
}

/** The recovery-eligible record of `fencedAfterReauth`, settled at `epoch` (a later re-authentication over the same epoch-1 entry). */
export const reauthenticatedAt = (epoch: number, account = ACCOUNT) => {
  const record = fencedAfterReauth(account);
  return {
    ...record,
    latest_epoch: epoch,
    settled: { ...record.settled, epoch },
  };
};

/**
 * NAMED HOLD (E-R7): once the recovery job reports a FINAL data commit, exclusive requests of `atlas-auth` are not granted while
 * `window.__finishHold` is true, so `finish_recovery` waits for its lock until its own bound (`lockWaitMs`) and answers `lock_timeout`.
 * The test lifts it by setting the flag false; requests made after that are the platform's. `window.__finishHeldCount` counts the
 * requests it held.
 */
export async function holdFinishWhileFlagged(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __finishHold?: boolean;
      __finishHeldCount?: number;
      __atlasFixture?: { session?: { trace: Array<unknown> } };
    };
    w.__finishHold = true;
    w.__finishHeldCount = 0;
    let armed = false;
    const trace = w.__atlasFixture?.session?.trace;
    if (!trace) throw new Error("no session harness trace");
    const push = trace.push.bind(trace);
    trace.push = (...items: unknown[]) => {
      for (const item of items as Array<{
        event?: string;
        data?: { final?: boolean; outcome?: string };
      }>)
        if (
          item.event === "data.recovery_commit" &&
          item.data?.final === true &&
          item.data?.outcome === "applied"
        )
          armed = true;
      return push(...items);
    };
    const proto = LockManager.prototype as unknown as {
      request: (...a: unknown[]) => Promise<unknown>;
    };
    const request = proto.request;
    proto.request = function (this: LockManager, ...args: unknown[]) {
      const name = args[0];
      const options =
        typeof args[1] === "object" && args[1] !== null
          ? (args[1] as LockOptions)
          : {};
      if (
        armed &&
        w.__finishHold === true &&
        name === "atlas-auth" &&
        (options.mode ?? "exclusive") === "exclusive" &&
        options.ifAvailable !== true
      ) {
        w.__finishHeldCount = (w.__finishHeldCount ?? 0) + 1;
        // Never granted; the caller's own signal (its lock wait) ends the wait, as the platform does for an aborted request.
        return new Promise<unknown>((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () =>
              reject(
                options.signal?.reason ??
                  new DOMException("aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      }
      return request.apply(this, args as never);
    };
  });
}

/**
 * NAMED FAULT (E-R3b, T24 C's aborted-recording variant): while `window.__abortAuthWrites` is true, every READWRITE transaction of
 * `atlas-auth` in this page is aborted as soon as it is created, so the session's recording of an answer cannot commit (the matrix's
 * "aborted recording"). Installed before the session starts; armed by the test at the moment the answer is served.
 */
export async function abortAuthWritesWhenArmed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __abortAuthWrites?: boolean;
      __abortedAuthWrites?: number;
    };
    w.__abortAuthWrites = false;
    w.__abortedAuthWrites = 0;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = transaction.apply(this, args);
      if (
        w.__abortAuthWrites === true &&
        this.name === "atlas-auth" &&
        args[1] === "readwrite"
      ) {
        w.__abortedAuthWrites = (w.__abortedAuthWrites ?? 0) + 1;
        tx.abort();
      }
      return tx;
    } as IDBDatabase["transaction"];
  });
}

/**
 * OFFLINE at the app's boundary (E-R3b): `navigator.onLine` answers `false` in this page until `goOnline`, which also fires `online`.
 * Installed before the session starts (`leaderPageAfter`), with the stub's `offline` flag, so a page can boot "offline" while the
 * fixture's own assets (lazily imported chunks) are still served, which the browser's offline emulation would refuse.
 */
export async function goOffline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
}
export async function goOnline(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
}

/**
 * NAMED FAULT (E-R7b): as `abortAuthWritesWhenArmed`, armed by the page itself once the recovery job reports its FINAL data commit
 * (`data.recovery_commit` with `final: true`, pushed to the session harness's trace in the same synchronous step), so `finish_recovery`'s
 * release transaction aborts (`failed`) until the test sets `window.__abortAuthWrites` false.
 */
export async function abortAuthWritesAfterFinalCommit(
  page: Page,
): Promise<void> {
  await abortAuthWritesWhenArmed(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      __abortAuthWrites?: boolean;
      __atlasFixture?: { session?: { trace: Array<unknown> } };
    };
    const trace = w.__atlasFixture?.session?.trace;
    if (!trace) throw new Error("no session harness trace");
    // Armed ONCE, by the first final data commit only: a later commit (the next epoch's own catch-up) must not re-arm what the test
    // has lifted.
    let armed = false;
    const push = trace.push.bind(trace);
    trace.push = (...items: unknown[]) => {
      for (const item of items as Array<{
        event?: string;
        data?: { final?: boolean; outcome?: string };
      }>)
        if (
          !armed &&
          item.event === "data.recovery_commit" &&
          item.data?.final === true &&
          item.data?.outcome === "applied"
        ) {
          armed = true;
          w.__abortAuthWrites = true;
        }
      return push(...items);
    };
  });
}

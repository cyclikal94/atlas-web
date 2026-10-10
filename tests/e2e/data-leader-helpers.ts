import type { BrowserContext, Page, Route } from "@playwright/test";
import { ACCOUNT, settled } from "./data-sync-helpers";

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
  };
  const now = Date.now();
  await context.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: "0.27.0" }),
    }),
  );
  await context.route("**/api/experimental/v1/**", async (route: Route) => {
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
    const fulfil = (answer: Scripted) =>
      route.fulfill({
        status: answer.status,
        contentType: "application/json",
        headers: answer.headers,
        body: answer.body,
      });
    if (path === "/browser-sessions/current")
      return fulfil(
        json(200, {
          account_id: account,
          session_id: "s1",
          expires_at: new Date(now + 86_400_000).toISOString(),
          csrf_token: "csrf.s1",
        }),
      );
    if (path === "/me")
      return fulfil(json(200, { id: account, username: "alice" }));
    if (path === "/sessions")
      return fulfil(
        json(200, {
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
      net.commands.push({
        page: pageOf(),
        path,
        key: request.headers()["idempotency-key"] ?? null,
      });
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
): Promise<Page> {
  const page = existing ?? (await context.newPage());
  net.label(page, name);
  await page.goto("/__session?route=%2Ftoday&leader=production");
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
    if (!data.stores.has(a)) {
      data.setIdentity(a);
      const opened = await data.open(a);
      if (opened !== "opened" && opened !== "created") return null;
    }
    return data.syncState(a);
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
      if (!data.stores.has(a)) {
        data.setIdentity(a);
        const opened = await data.open(a);
        if (opened !== "opened" && opened !== "created") return [];
      }
      return data.rows(a, name as never);
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
): Promise<Page> {
  const page = await context.newPage();
  net.label(page, name);
  await page.goto("/__session?route=%2Ftoday&leader=production&boot=manual");
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

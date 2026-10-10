import { DataRuntime } from "../../../src/data/engine/account-service";
import { createQuotaGuard } from "../../../src/data/engine/quota-guard";
import { openAccountData } from "../../../src/data/store/open";
import { createRegistry } from "../../../src/data/store/registry";
import { createDataEnv, type DataEnv } from "../../../src/data/ui/env";
import {
  currentDeviceThrough,
  readMeThrough,
} from "../../../src/data/ui/identity-reads";
import type { Store } from "../../../src/session";
import { createWebLocksPort } from "../../../src/session/adapters/web-locks";
import { EPOCH_BASE } from "../session/env";
import type { FakePage, Fixture } from "../session/harness";
import type { RealData } from "./real-ports";

/**
 * The PRODUCTION data controller (`createDataEnv`) over a REAL session page of the 08a fixture: the page's own `session.identity`,
 * `session.api.client` and `session.operations.listSessions()` through the production adapters (`readMeThrough`,
 * `currentDeviceThrough`), the page's Web Locks and its persistence hold, and the real account database over the data layer's double
 * of IndexedDB. Only the platform is a double. Several pages of one fixture are several tabs: every request one sends writes a
 * lease the others hear (the hint feedback that drove the request loop of R16), and the pages share one clock and one database.
 *
 * Nothing here starts a sync engine or a dispatcher: it is what production composes today.
 */
/**
 * Named faults of the controller's LOOK for the account's database (R16, revision 10), each read on every attempt so a test can end one:
 * the lazy runtime chunk does not load, `indexedDB.databases()` rejects (a listing that cannot be had), the open rejects. None is a
 * genuine device storage fault.
 */
export interface LookFaults {
  load?: boolean;
  list?: boolean;
  open?: boolean;
}

/** What the look did: the attempts the controller made at each step (a failed one counts). */
export interface LookCounts {
  loads: number;
  lists: number;
  opens: number;
}

export interface SessionController {
  readonly ui: DataEnv;
  readonly page: FakePage;
  readonly looks: LookCounts;
  /** The page's connectivity: the flag, and the `online` and `offline` events the session and the controller hear. */
  setOnline(online: boolean): void;
  dispose(): void;
}

const API = "/api/experimental/v1";
export const ME = `${API}/me`;
export const SESSIONS = `${API}/sessions`;

/** What the stub server answers `GET /me` and `GET /sessions` with when it is healthy. */
export function answerHealthy(f: Fixture, account: string, username: string) {
  const stop = [
    f.server.addRule({
      match: (r) => r.method === "GET" && r.path === ME,
      rewrite: {
        status: 200,
        body: { id: account, username, has_password: true, oidc_issuers: [] },
      },
    }),
  ];
  return () => {
    for (const off of stop) off();
  };
}

/** How many `GET`s of `path` reached the server, from every page (a dropped answer was still processed). */
export function requestsTo(f: Fixture, path: string, page?: string): number {
  return f.server
    .recordsFor(path, "GET")
    .filter((entry) => page === undefined || entry.page === page).length;
}

/** The account's database, created as another path (the first sync, a saved draft) would. */
export async function createDatabase(
  real: RealData,
  account: string,
): Promise<void> {
  await real.createAccountDb(account, "incarnation-review");
}

let controllers = 0;

export function controllerOverSession(
  f: Fixture,
  real: RealData,
  page: FakePage,
  /**
   * `hold`: the data runtime is still being loaded (the lazy chunk) until this settles, so the controller has not yet looked for the
   * account's database: the window in which the review (R16, revision 9) found that a page asked before it could read its budget.
   */
  options: { hold?: Promise<void>; faults?: LookFaults } = {},
): SessionController {
  controllers += 1;
  const world = f.world;
  const registry = createRegistry(`tab-${page.id}-${controllers}`);
  const faults = options.faults ?? {};
  const looks: LookCounts = { loads: 0, lists: 0, opens: 0 };
  const realHost = real.idb.hostForPage(page.id);
  // The listing and the open are the two calls a look makes of the platform: each can be made to reject, on demand.
  const host = new Proxy(realHost, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "list")
        return async (...args: unknown[]) => {
          looks.lists += 1;
          if (faults.list === true)
            throw new DOMException("injected listing failure", "UnknownError");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const realOpener = real.idb.openerForPage(page.id, registry, {
    onVersionChange: () => undefined,
  });
  const opener = new Proxy(realOpener, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "open")
        return async (...args: unknown[]) => {
          looks.opens += 1;
          if (faults.open === true)
            throw new DOMException("injected open failure", "UnknownError");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const locks = createWebLocksPort(f.locks.forPage(page.id));
  let incarnations = 0;
  const runtime = new DataRuntime({
    identity: page.session.identity,
    persistence: page.session.persistence,
    registry,
    open: (account, openOptions) =>
      openAccountData(
        {
          host,
          opener,
          registry,
          locks,
          identityAccount: () =>
            page.session.identity.get()?.account_id ?? null,
          operationPending: (account) =>
            page.session.operations.pending
              .get()
              .some((op) => op.account_id === account),
          newIncarnation: () => `incarnation-${page.id}-${++incarnations}`,
          lockWaitMs: 20_000,
          abortAfter: (ms) => {
            const controller = new AbortController();
            world.schedule(
              "timer",
              page.id,
              { what: "open.lock_wait" },
              () => controller.abort(),
              ms,
            );
            return controller.signal;
          },
        },
        account,
        openOptions,
      ),
  });
  const onlineListeners = new Set<() => void>();
  const online: Store<boolean> = {
    get: () => page.env.online,
    subscribe: (listener) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
  };
  let timerSeq = 0;
  const cancelled = new Set<number>();
  const ui = createDataEnv({
    identity: page.session.identity,
    loadRuntime: async () => {
      looks.loads += 1;
      await options.hold;
      if (faults.load === true) throw new Error("chunk load failed");
      return runtime;
    },
    online,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: () => EPOCH_BASE + world.time,
    }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: {
      now: () => EPOCH_BASE + world.time,
      iso: () => new Date(EPOCH_BASE + world.time).toISOString(),
      // Half: no jitter, so a schedule is exact.
      random: () => 0.5,
    },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: readMeThrough(page.session),
    currentDeviceId: currentDeviceThrough(page.session),
    onOnline: (listener) => page.env.on("online", listener),
    timers: {
      setTimeout: (fn, ms) => {
        timerSeq += 1;
        const id = timerSeq;
        world.schedule(
          "timer",
          page.id,
          { controllerTimer: id },
          () => {
            if (!cancelled.has(id)) fn();
          },
          ms,
        );
        return id;
      },
      clearTimeout: (handle) => {
        cancelled.add(handle as number);
      },
    },
  });
  return {
    ui,
    page,
    looks,
    setOnline(next) {
      if (next) page.goOnline();
      else page.goOffline();
      for (const listener of [...onlineListeners]) listener();
    },
    dispose: () => ui.dispose(),
  };
}

import { accountDatabaseName } from "../../data/model/schema";
import type { AccountId } from "../../data/model/types";
import { createIdbHost } from "../../data/store/idb-host";
import { getPageRegistry } from "../../data/store/registry";
import {
  type BrowserRuntime,
  createBrowserRuntime,
} from "../../data/ui/browser-env";
import {
  type Identity,
  type Session,
  type Store,
  unrevokedHold,
} from "../../session";

/**
 * FIXTURE ONLY (R36 and R37, revision 21). The open-closure harness: the PRODUCTION `createBrowserRuntime` (the page's `DataRuntime`, the
 * open predicate, the Dexie opener, the raw-IndexedDB host, the Web Locks wipe lock and the page's connection registry) over REAL
 * IndexedDB in a real engine, over a session whose identity and pending operations this harness owns (there is no session and no backend).
 * It exists to change ONE thing about the page while a database open is under way, at a point the test names, and to read what is left:
 *
 * - `hold("listing", n)`: the n-th discovery of the databases (`indexedDB.databases()`) made after `begin` is held (the second is the
 *   one a creation makes under the wipe's lock);
 * - `hold("completion", n)`: the n-th native open request of the account's database is held at the point where the ENGINE has finished
 *   it (the connection exists) and the opener has not been told: the window in which the connection is open and nobody knows of it;
 * - `afterRequest(n, change)`: in the same turn in which the n-th native open request is made, and so before the engine can deliver its
 *   upgrade or its success, a deletion, an upgrade by another connection, or a change of one of the page's facts is carried out;
 * - `afterSeeding(action)`: the same, in the turn the first read-write transaction of the account's database is created, which for an
 *   open of an existing database is the opener's seeding of the singleton;
 * - `deleteNow()`, `upgradeNow()`, `change(kind)`: the same, when the test says.
 *
 * Every one is a named injection that delays delivery or acts at an instant; none fails an operation, shortens a duration or stands in for
 * a device. The harness records what the ENGINE did independently of the page's registry (every native open request, every connection it
 * produced, every connection that was closed (`IDBDatabase.prototype.close`), every `versionchange` delivered to one) and what the page
 * holds, and what every `runtime.open` answered, so that a test reads after the runtime's own answer (a wait that ends without one says
 * so rather than timing out). A passing run is fixture evidence for THIS ENGINE ON THIS MACHINE: not a device, not real Safari.
 */
export type Change = "switch" | "signout" | "operation" | "closure";

export interface OpenClosureSnapshot {
  /** Connections of the account in the page's registry. */
  registryConnections: number;
  /** Native connections of the account's database the engine opened and nobody has closed (registered or not). */
  nativeConnectionsLive: number;
  /** Native open requests the page made for the account's database, how many finished in the engine, and the `versionchange` events its connections received. */
  nativeOpenRequests: number;
  nativeOpenSuccesses: number;
  versionChanges: number;
  /** The runtime holds a live service for the account. */
  liveService: boolean;
  latch: string;
  /** What each `runtime.open` answered, in order: `opened`, `absent`, `refused:<reason>` or `threw`. */
  answers: string[];
  listingCalls: number;
  /** A deletion (through the page's own host) or upgrade the harness issued: `none`, `requested`, `done`, `error`; an upgrade can also be `blocked`. */
  deletion: string;
  /** The host's answer to the deletion: `deleted`, or `blocked_then_deleted` when the engine reported another connection holding the database first. */
  deletionResult: string | null;
  upgrade: string;
}

export interface OpenClosureHarness {
  /** A fresh run for `account`: identity set, nothing pending, nothing held, no runtime yet. */
  begin(account: AccountId): void;
  hold(kind: "listing" | "completion", nth: number): void;
  reached(): Promise<void>;
  release(): void;
  /** Arms one action to be carried out in the turn the n-th native open request is made. */
  afterRequest(
    nth: number,
    action: "delete" | "upgrade" | Change | "none",
  ): void;
  /** Arms one action to be carried out in the turn the next read-write transaction of the account's database is created (the seeding). */
  afterSeeding(action: "delete" | "upgrade" | Change | "none"): void;
  /** Starts `runtime.open` (builds the runtime on the first call); the answer is recorded. */
  open(options: { create: boolean }): void;
  change(kind: Change): void;
  /** Disposes the runtime. */
  dispose(): void;
  deleteNow(): void;
  upgradeNow(): void;
  answered(
    count: number,
    timeoutMs: number,
  ): Promise<{ answered: boolean; answers: string[] }>;
  /** Resolves when the harness's deletion or upgrade has finished, or reports that it has not after `timeoutMs`. */
  finished(
    which: "deletion" | "upgrade",
    timeoutMs: number,
  ): Promise<{ finished: boolean; state: string }>;
  /** Whether the engine lists the account's database. */
  exists(): Promise<boolean>;
  snapshot(): OpenClosureSnapshot;
  /** Disposes the runtime, closes what the run opened and puts the page's entry points back. */
  end(): void;
}

class Cell<T> implements Store<T> {
  private readonly listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

interface Hold {
  kind: "listing" | "completion";
  nth: number;
  armed: boolean;
  reachedNow: () => void;
  reached: Promise<void>;
  released: Promise<void>;
  release: () => void;
}

const OTHER_ACCOUNT = "99999999-9999-4999-8999-999999999999";
/** A version above the one the app's schema declares: opening at it is an upgrade by a newer build. */
const NEWER_VERSION = 99;

function createOpenClosureHarness(): OpenClosureHarness {
  const registry = getPageRegistry();
  const originalOpen = indexedDB.open.bind(indexedDB);
  const originalDatabases = indexedDB.databases.bind(indexedDB);
  // The page's own host: the one place an account database is removed (the session boundary test keeps the engine's removal call out of every other file).
  const host = createIdbHost();
  const originalClose = IDBDatabase.prototype.close;
  const originalTransaction = IDBDatabase.prototype.transaction;

  let account: AccountId | null = null;
  let identity = new Cell<Identity | null>(null);
  let pending = new Cell<readonly { account_id: AccountId }[]>([]);
  let built: BrowserRuntime | null = null;
  let hold: Hold | null = null;
  let armedSeeding: "delete" | "upgrade" | Change | "none" | null = null;
  let armed: {
    nth: number;
    action: "delete" | "upgrade" | Change | "none";
  } | null = null;
  let listingCalls = 0;
  let openRequests = 0;
  let openSuccesses = 0;
  let versionChanges = 0;
  let deletion = "none";
  let deletionResult: string | null = null;
  let upgrade = "none";
  let opened = new Set<IDBDatabase>();
  let closed = new Set<IDBDatabase>();
  let answers: string[] = [];
  let waiters: Array<() => void> = [];

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const answer = (text: string): void => {
    answers.push(text);
    wake();
  };

  const change = (kind: Change): void => {
    if (account === null) throw new Error("no run begun");
    switch (kind) {
      case "switch":
        identity.set({
          account_id: OTHER_ACCOUNT,
          epoch: 2,
          session_id: "open-closure-switch",
        });
        return;
      case "signout":
        identity.set(null);
        return;
      case "operation":
        pending.set([{ account_id: account }]);
        return;
      case "closure":
        registry.closeAll(account, { latch: "closed_for_deletion" });
        return;
    }
  };

  const deleteNow = (): void => {
    if (account === null) throw new Error("no run begun");
    deletion = "requested";
    // `blocked_then_deleted` says the engine reported another connection still holding the database before it was deleted.
    void host.delete(accountDatabaseName(account)).then((result) => {
      deletionResult = result;
      deletion = result === "error" ? "error" : "done";
      wake();
    });
  };

  const upgradeNow = (): void => {
    if (account === null) throw new Error("no run begun");
    upgrade = "requested";
    const request = originalOpen(accountDatabaseName(account), NEWER_VERSION);
    request.onblocked = () => {
      if (upgrade === "requested") upgrade = "blocked";
      wake();
    };
    request.onupgradeneeded = () => undefined;
    request.onsuccess = () => {
      // The newer connection is let go at once: it only exists to deliver an upgrade `versionchange` to the page's connections.
      request.result.close();
      upgrade = "done";
      wake();
    };
    request.onerror = () => {
      upgrade = "error";
      wake();
    };
  };

  const act = (action: "delete" | "upgrade" | Change | "none"): void => {
    if (action === "delete") deleteNow();
    else if (action === "upgrade") upgradeNow();
    else if (action !== "none") change(action);
  };

  const installEntryPoints = (): void => {
    indexedDB.databases = async () => {
      listingCalls += 1;
      const mine = hold;
      if (mine?.kind === "listing" && mine.armed && listingCalls === mine.nth) {
        mine.armed = false;
        mine.reachedNow();
        await mine.released;
      }
      return originalDatabases();
    };
    indexedDB.open = ((name: string, version?: number) => {
      const request = originalOpen(name, version);
      if (account === null || name !== accountDatabaseName(account))
        return request;
      if (version === NEWER_VERSION) return request;
      openRequests += 1;
      const mineNumber = openRequests;
      request.addEventListener("success", () => {
        openSuccesses += 1;
        opened.add(request.result);
        request.result.addEventListener("versionchange", () => {
          versionChanges += 1;
        });
      });
      // In the SAME TURN as the request, before the engine can deliver anything of it.
      if (armed !== null && armed.nth === mineNumber) {
        const action = armed.action;
        armed = null;
        act(action);
      }
      const mine = hold;
      if (mine?.kind !== "completion" || !mine.armed || mine.nth !== mineNumber)
        return request;
      // Deliver the SUCCESS late: the engine finishes the request (the connection exists, `request.result` is set), the handler the
      // opener installed is called when the test lets it go.
      mine.armed = false;
      let handler: ((event: Event) => void) | null = null;
      let fired: Event | null = null;
      let go = false;
      const deliver = (): void => {
        if (go && fired !== null && handler !== null) {
          const late = handler;
          handler = null;
          late.call(request, fired);
        }
      };
      request.addEventListener("success", (event) => {
        fired = event;
        mine.reachedNow();
        void mine.released.then(() => {
          go = true;
          deliver();
        });
      });
      return new Proxy(request, {
        set(target, property, value) {
          if (property === "onsuccess") {
            handler = value as (event: Event) => void;
            deliver();
            return true;
          }
          Reflect.set(target, property, value);
          return true;
        },
        get(target, property) {
          if (property === "onsuccess") return handler;
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }) as typeof indexedDB.open;
    IDBDatabase.prototype.close = function close(this: IDBDatabase): void {
      if (account !== null && this.name === accountDatabaseName(account))
        closed.add(this);
      originalClose.call(this);
    };
    IDBDatabase.prototype.transaction = function transaction(
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ): IDBTransaction {
      const made = originalTransaction.apply(this, args);
      if (
        armedSeeding !== null &&
        account !== null &&
        this.name === accountDatabaseName(account) &&
        args[1] === "readwrite"
      ) {
        const action = armedSeeding;
        armedSeeding = null;
        act(action);
      }
      return made;
    } as typeof IDBDatabase.prototype.transaction;
  };

  const sessionOf = (): Session =>
    ({
      identity,
      operations: { pending },
      persistence: { hold: async () => unrevokedHold() },
    }) as unknown as Session;

  return {
    begin(next) {
      if (account !== null) throw new Error("the run was not ended");
      account = next;
      identity = new Cell<Identity | null>({
        account_id: next,
        epoch: 1,
        session_id: "open-closure",
      });
      pending = new Cell<readonly { account_id: AccountId }[]>([]);
      built = null;
      hold = null;
      armed = null;
      armedSeeding = null;
      listingCalls = 0;
      openRequests = 0;
      openSuccesses = 0;
      versionChanges = 0;
      deletion = "none";
      deletionResult = null;
      upgrade = "none";
      opened = new Set();
      closed = new Set();
      answers = [];
      waiters = [];
      installEntryPoints();
    },
    hold(kind, nth) {
      let reachedNow!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedNow = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = {
        kind,
        nth,
        armed: true,
        reachedNow,
        reached,
        released,
        release,
      };
    },
    reached: () => {
      if (hold === null) throw new Error("nothing is armed");
      return hold.reached;
    },
    release() {
      hold?.release();
    },
    afterRequest(nth, action) {
      armed = { nth, action };
    },
    afterSeeding(action) {
      armedSeeding = action;
    },
    open(options) {
      if (account === null) throw new Error("no run begun");
      built ??= createBrowserRuntime(sessionOf());
      built.runtime.open(account, options).then(
        (outcome) =>
          answer(
            outcome.kind === "refused"
              ? `refused:${outcome.reason}`
              : outcome.kind,
          ),
        () => answer("threw"),
      );
    },
    change,
    dispose() {
      built?.runtime.dispose();
    },
    deleteNow,
    upgradeNow,
    answered(count, timeoutMs) {
      return new Promise((resolve) => {
        const check = (): boolean => {
          if (answers.length < count) return false;
          resolve({ answered: true, answers: [...answers] });
          return true;
        };
        if (check()) return;
        const waiter = (): void => {
          if (check()) {
            waiters = waiters.filter((entry) => entry !== waiter);
            clearTimeout(timer);
          }
        };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          waiters = waiters.filter((entry) => entry !== waiter);
          resolve({ answered: false, answers: [...answers] });
        }, timeoutMs);
      });
    },
    finished(which, timeoutMs) {
      return new Promise((resolve) => {
        const state = (): string => (which === "deletion" ? deletion : upgrade);
        const check = (): boolean => {
          if (state() !== "done" && state() !== "error") return false;
          resolve({ finished: state() === "done", state: state() });
          return true;
        };
        if (check()) return;
        const waiter = (): void => {
          if (check()) {
            waiters = waiters.filter((entry) => entry !== waiter);
            clearTimeout(timer);
          }
        };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          waiters = waiters.filter((entry) => entry !== waiter);
          resolve({ finished: false, state: state() });
        }, timeoutMs);
      });
    },
    async exists() {
      if (account === null) return false;
      const name = accountDatabaseName(account);
      return (await originalDatabases()).some(
        (database) => database.name === name,
      );
    },
    snapshot() {
      const target = account;
      return {
        registryConnections: target === null ? 0 : registry.openCount(target),
        nativeConnectionsLive: [...opened].filter((db) => !closed.has(db))
          .length,
        nativeOpenRequests: openRequests,
        nativeOpenSuccesses: openSuccesses,
        versionChanges,
        liveService:
          target === null
            ? false
            : (
                built?.runtime.serviceFor(target) as {
                  live?: boolean;
                } | null
              )?.live === true,
        latch: target === null ? "open" : registry.latch(target),
        answers: [...answers],
        listingCalls,
        deletion,
        deletionResult,
        upgrade,
      };
    },
    end() {
      hold?.release();
      built?.dispose();
      if (account !== null) registry.closeAll(account);
      for (const database of opened) {
        try {
          originalClose.call(database);
        } catch {
          // best effort
        }
      }
      indexedDB.open = originalOpen as typeof indexedDB.open;
      indexedDB.databases = originalDatabases;
      IDBDatabase.prototype.close = originalClose;
      IDBDatabase.prototype.transaction = originalTransaction;
      hold = null;
      armed = null;
      armedSeeding = null;
      built = null;
      account = null;
    },
  };
}

declare global {
  interface Window {
    __atlasOpenClosure?: OpenClosureHarness;
  }
}
window.__atlasOpenClosure = createOpenClosureHarness();

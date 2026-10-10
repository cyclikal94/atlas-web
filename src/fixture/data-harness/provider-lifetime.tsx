import { createRoot, type Root } from "react-dom/client";
import { accountDatabaseName } from "../../data/model/schema";
import type { AccountId } from "../../data/model/types";
import { getPageRegistry } from "../../data/store/registry";
import { type BrowserComposition, DataProvider } from "../../data/ui/react";
import {
  type Identity,
  type Session,
  type Store,
  unrevokedHold,
} from "../../session";

/**
 * FIXTURE ONLY (R35, revision 20). The provider-lifetime harness: the PRODUCTION `DataProvider`, `createProductionEnv`, controller,
 * `createBrowserRuntime`, Dexie opener, raw-IndexedDB host and page registry, in a real browser engine, over a session whose identity this
 * harness owns (there is no session here and no backend). It exists to hold ONE operation of a runtime's open at a time, in the live page,
 * while the provider is unmounted, and to read what is left when that operation is let go:
 *
 * - `listing`: the controller's discovery of the databases (`indexedDB.databases()`, the first call of the page) is held;
 * - `completion`: the first native open request of the account's database is held at the point where the ENGINE has finished it (the
 *   connection exists) and the page's handler has not yet been told, which is the window the review reproduced: the open that finishes
 *   into a runtime that has been disposed.
 *
 * Both are named injections in the page (they delay delivery; they fail nothing and change no production duration), and neither is a
 * device stall. The harness records what the ENGINE did, independently of the page's registry: every native open request of the account's
 * database, every connection it produced and every connection that was closed (`IDBDatabase.prototype.close`), so a connection that no
 * registry knows of is still seen; and what every runtime the provider built answered to every `open` (the explicit completed-open
 * barrier: a test reads after the answer, and a wait that ends without one says so rather than timing out).
 *
 * The page has no network (`navigator.onLine` is false for as long as a run is begun), so the readers that follow the identity wait and
 * nothing asks a backend. A passing run is fixture evidence for THIS ENGINE ON THIS MACHINE: not a device, not real Safari, not a freeze.
 */
export interface ProviderLifetimeSnapshot {
  /** Connections of the account in the page's registry (the controller's runtime and any replacement's). */
  registryConnections: number;
  /** Native connections of the account's database the engine opened and nobody has closed (registered or not). */
  nativeConnectionsLive: number;
  /** Native open requests of the account's database that the page made, and how many of them finished in the engine. */
  nativeOpenRequests: number;
  nativeOpenSuccesses: number;
  /** Runtimes the provider built (each lifetime builds its own), and how many hold a LIVE service for the account. */
  runtimesBuilt: number;
  liveServices: number;
  /** Listeners on the identity store: the controller's and the runtime's subscriptions, which a disposed lifetime must have dropped. */
  identityListeners: number;
  latch: string;
  /** What each `runtime.open` answered, in the order the answers came: `opened`, `absent`, `refused:<reason>` or `threw`. */
  openAnswers: string[];
  /** The listings of the databases the page made. */
  listingCalls: number;
}

export interface ProviderLifetimeHarness {
  /** Begins a run for `account` (an existing database, made by another page): identity set, page offline, nothing held, nothing mounted. */
  begin(account: AccountId): void;
  /** Arms one hold; the first matching operation after this call is held until `release()`. */
  hold(kind: "listing" | "completion"): void;
  /** Resolves when the armed operation has been reached (the hold is in force). */
  reached(): Promise<void>;
  release(): void;
  /** Mounts a new production provider tree (its effects run asynchronously, as React runs them); returns its number (1 is the first). */
  mount(): number;
  unmount(tree: number): void;
  moveIdentity(account: AccountId | null, epoch: number): void;
  /**
   * Resolves when at least `count` `runtime.open` answers have been recorded, or reports that they have not after `timeoutMs` (shorter than
   * the test's own timeout, so a missing answer is an assertion about what was seen and not a test timeout).
   */
  answered(
    count: number,
    timeoutMs: number,
  ): Promise<{ answered: boolean; answers: string[] }>;
  snapshot(): ProviderLifetimeSnapshot;
  /** Unmounts everything, disposes what the run built, closes what it opened and puts the page's entry points back. */
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
  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface Hold {
  kind: "listing" | "completion";
  armed: boolean;
  reachedNow: () => void;
  reached: Promise<void>;
  released: Promise<void>;
  release: () => void;
}

function createProviderLifetimeHarness(): ProviderLifetimeHarness {
  const registry = getPageRegistry();
  const originalOpen = indexedDB.open.bind(indexedDB);
  const originalDatabases = indexedDB.databases.bind(indexedDB);
  const originalClose = IDBDatabase.prototype.close;

  let account: AccountId | null = null;
  let identity = new Cell<Identity | null>(null);
  let hold: Hold | null = null;
  let listingCalls = 0;
  let openRequests = 0;
  let openSuccesses = 0;
  let opened = new Set<IDBDatabase>();
  let closed = new Set<IDBDatabase>();
  let answers: string[] = [];
  let waiters: Array<() => void> = [];
  const runtimes: Array<{ runtime: { serviceFor(a: AccountId): unknown } }> =
    [];
  const disposers: Array<() => void> = [];
  const trees: Array<{ root: Root; node: HTMLElement } | null> = [];

  const installEntryPoints = (): void => {
    indexedDB.databases = async () => {
      listingCalls += 1;
      const mine = hold;
      if (mine?.kind === "listing" && mine.armed && listingCalls === 1) {
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
      openRequests += 1;
      request.addEventListener("success", () => {
        openSuccesses += 1;
        opened.add(request.result);
      });
      const mine = hold;
      if (mine?.kind !== "completion" || !mine.armed) return request;
      // Deliver the SUCCESS late: the engine finishes the request (the connection exists and `request.result` is set), the handler the
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
  };

  const answer = (text: string): void => {
    answers.push(text);
    for (const wake of [...waiters]) wake();
  };

  const loadBrowser = async (): Promise<BrowserComposition> => {
    const module = await import("../../data/ui/browser-env");
    return {
      createBrowserRuntime: (session) => {
        const built = module.createBrowserRuntime(session);
        const openOriginal = built.runtime.open.bind(built.runtime);
        built.runtime.open = async (target, options) => {
          try {
            const outcome = await openOriginal(target, options);
            answer(
              outcome.kind === "refused"
                ? `refused:${outcome.reason}`
                : outcome.kind,
            );
            return outcome;
          } catch (error) {
            answer("threw");
            throw error;
          }
        };
        runtimes.push(built);
        disposers.push(() => built.dispose());
        return built;
      },
    };
  };

  const sessionOf = (): Session =>
    ({
      identity,
      operations: { pending: new Cell<readonly unknown[]>([]) },
      persistence: { hold: async () => unrevokedHold() },
    }) as unknown as Session;

  return {
    begin(next) {
      if (account !== null) throw new Error("the run was not ended");
      account = next;
      identity = new Cell<Identity | null>({
        account_id: next,
        epoch: 1,
        session_id: "provider-lifetime",
      });
      hold = null;
      listingCalls = 0;
      openRequests = 0;
      openSuccesses = 0;
      opened = new Set();
      closed = new Set();
      answers = [];
      waiters = [];
      runtimes.length = 0;
      disposers.length = 0;
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      installEntryPoints();
    },
    hold(kind) {
      let reachedNow!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedNow = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { kind, armed: true, reachedNow, reached, released, release };
    },
    reached: () => {
      if (hold === null) throw new Error("nothing is armed");
      return hold.reached;
    },
    release() {
      hold?.release();
    },
    mount() {
      // A DETACHED container: the provider renders nothing the page needs to show, only its effects run, and the page's own lint rule (R3)
      // keeps anything but `src/components/ui` from inserting nodes into the document body.
      const node = document.createElement("div");
      const root = createRoot(node);
      root.render(
        <DataProvider session={sessionOf()} loadBrowser={loadBrowser}>
          <div>provider-lifetime</div>
        </DataProvider>,
      );
      trees.push({ root, node });
      return trees.length;
    },
    unmount(tree) {
      const mounted = trees[tree - 1];
      if (mounted === null || mounted === undefined) return;
      trees[tree - 1] = null;
      // `unmount` flushes synchronously: the cleanup of the provider's effect (`env.dispose()`) has run when it returns.
      mounted.root.unmount();
    },
    moveIdentity(next, epoch) {
      identity.set(
        next === null
          ? null
          : {
              account_id: next,
              epoch,
              session_id: `provider-lifetime-${epoch}`,
            },
      );
    },
    answered(count, timeoutMs) {
      return new Promise((resolve) => {
        const check = (): boolean => {
          if (answers.length < count) return false;
          resolve({ answered: true, answers: [...answers] });
          return true;
        };
        if (check()) return;
        const wake = (): void => {
          if (check()) {
            waiters = waiters.filter((entry) => entry !== wake);
            clearTimeout(timer);
          }
        };
        waiters.push(wake);
        const timer = setTimeout(() => {
          waiters = waiters.filter((entry) => entry !== wake);
          resolve({ answered: false, answers: [...answers] });
        }, timeoutMs);
      });
    },
    snapshot() {
      const target = account;
      return {
        registryConnections: target === null ? 0 : registry.openCount(target),
        nativeConnectionsLive: [...opened].filter((db) => !closed.has(db))
          .length,
        nativeOpenRequests: openRequests,
        nativeOpenSuccesses: openSuccesses,
        runtimesBuilt: runtimes.length,
        liveServices:
          target === null
            ? 0
            : runtimes.filter(
                (built) =>
                  (
                    built.runtime.serviceFor(target) as {
                      live?: boolean;
                    } | null
                  )?.live === true,
              ).length,
        identityListeners: identity.listenerCount,
        latch: target === null ? "open" : registry.latch(target),
        openAnswers: [...answers],
        listingCalls,
      };
    },
    end() {
      for (let tree = trees.length; tree >= 1; tree -= 1) this.unmount(tree);
      trees.length = 0;
      hold?.release();
      for (const dispose of disposers) dispose();
      if (account !== null) registry.closeAll(account);
      indexedDB.open = originalOpen as typeof indexedDB.open;
      indexedDB.databases = originalDatabases;
      IDBDatabase.prototype.close = originalClose;
      // `begin` shadowed `navigator.onLine` with an own property: deleting it uncovers the engine's own.
      Reflect.deleteProperty(navigator, "onLine");
      hold = null;
      account = null;
    },
  };
}

declare global {
  interface Window {
    __atlasProviderLifetime?: ProviderLifetimeHarness;
  }
}
window.__atlasProviderLifetime = createProviderLifetimeHarness();

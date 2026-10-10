import type { AccountId } from "../../../src/data/model/types";
import type { DatabaseHost } from "../../../src/data/store/host";
import type {
  EngineOpener,
  OpenDeps,
  OpenOptions,
  OpenOutcome,
} from "../../../src/data/store/open";
import type { ConnectionRegistry } from "../../../src/data/store/registry";
import { createWebLocksPort } from "../../../src/session/adapters/web-locks";
import type { LockPort } from "../../../src/session/ports/locks";
import { FakeLockManager } from "../session/locks";
import { World } from "../session/world";
import { FakeIdb } from "./fake-idb";
import { type DataModules, srcDataModules } from "./modules";
import { FakeSyncBus } from "./sync-bus";

/**
 * The deterministic world for the data layer's model-level tests (layer L1b): the 08a `World`, the double of IndexedDB
 * (`FakeIdb`), and the 08a fake Web Locks, shared by any number of pages. Each page has its own registry, locks, identity and
 * pending-operations view, which is what makes two tabs of one browser two PAGES here.
 */
export interface PageEnv {
  id: string;
  registry: ConnectionRegistry;
  host: DatabaseHost;
  opener: EngineOpener;
  locks: LockPort;
  /** The page's settled identity (a FACT); tests move it to model a sign-in, a switch and a sign-out. */
  identity: { account: AccountId | null; epoch: number };
  /** Accounts with a logout or retirement pending, as `session.operations.pending` reports. */
  pending: Set<AccountId>;
  /** The versionchange notices this page's connections received. */
  versionChanges: Array<{ account: AccountId; kind: "deleted" | "upgraded" }>;
  openDeps: OpenDeps;
  open(account: AccountId, options?: OpenOptions): Promise<OpenOutcome>;
}

export class DataTestWorld {
  constructor(readonly modules: DataModules = srcDataModules) {}
  readonly world = new World();
  readonly idb = new FakeIdb(this.world);
  readonly lockManager = new FakeLockManager(this.world);
  readonly bus = new FakeSyncBus(this.world);
  private pages = new Map<string, PageEnv>();
  private incarnations = 0;

  page(id = "A"): PageEnv {
    const existing = this.pages.get(id);
    if (existing) return existing;
    this.world.registerPage(id);
    const registry = this.modules.registry.createRegistry(`tab-${id}`);
    const versionChanges: PageEnv["versionChanges"] = [];
    const host = this.idb.hostForPage(id);
    const opener = this.idb.openerForPage(id, registry, {
      onVersionChange: (account, kind) =>
        versionChanges.push({ account, kind }),
    });
    const locks = createWebLocksPort(this.lockManager.forPage(id));
    const identity: PageEnv["identity"] = { account: null, epoch: 1 };
    const pending = new Set<AccountId>();
    const world = this.world;
    const openDeps: OpenDeps = {
      host,
      opener,
      registry,
      locks,
      identityAccount: () => identity.account,
      operationPending: (account) => pending.has(account),
      newIncarnation: () => `incarnation-${++this.incarnations}`,
      lockWaitMs: 20_000,
      abortAfter(ms) {
        const controller = new AbortController();
        world.schedule(
          "timer",
          id,
          { what: "open.lock_wait" },
          () => controller.abort(),
          ms,
        );
        return controller.signal;
      },
    };
    const env: PageEnv = {
      id,
      registry,
      host,
      opener,
      locks,
      identity,
      pending,
      versionChanges,
      openDeps,
      open: (account, options) =>
        this.modules.open.openAccountData(openDeps, account, options),
    };
    this.pages.set(id, env);
    return env;
  }

  /** Drives the world until `promise` settles, then returns its value (or throws its error). */
  async run<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    let failed = false;
    let value: T | undefined;
    let error: unknown;
    promise.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        failed = true;
        error = e;
      },
    );
    for (let turn = 0; turn < 200 && !done; turn += 1)
      await this.world.runUntilIdle();
    if (!done)
      throw new Error("the promise did not settle while the world was idle");
    if (failed) throw error;
    return value as T;
  }

  /** Delivers everything deliverable now. */
  async settle(): Promise<void> {
    await this.world.runUntilIdle();
  }
}

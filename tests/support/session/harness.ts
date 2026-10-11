import { createWebLocksPort } from "../../../src/session/adapters/web-locks";
import type { Session } from "../../../src/session/api";
import type { SessionConfig } from "../../../src/session/constants";
import type { Kernel } from "../../../src/session/kernel/state";
import { rangeFromPin } from "../../../src/session/model/api-version";
import type { DeletionPorts } from "../../../src/session/ports/deletion";
import type { LockHandle, LockPort } from "../../../src/session/ports/locks";
import {
  FakeClock,
  FakeIds,
  FakePageEnv,
  FakeSurface,
  FakeTrace,
  Prng,
} from "./env";
import { FakeHintBus } from "./hints";
import { FakeLockManager } from "./locks";
import { type Modules, srcModules } from "./modules";
import { createFakeFetch, StubServer } from "./server";
import { FakeAuthStore, SharedStore } from "./store";
import { World } from "./world";

/** Wrap a lock port so the SYNCHRONOUS call of `release()` is logged (the surrender is that call, not its publication). */
function spyLockPort(world: World, page: string, inner: LockPort): LockPort {
  const wrap = async (
    name: string,
    promise: Promise<LockHandle | null>,
  ): Promise<LockHandle | null> => {
    const handle = await promise;
    if (!handle) return null;
    world.log({ type: "lock.held", page, name });
    return {
      release() {
        world.log({ type: "lock.release_called", page, name });
        handle.release();
      },
    };
  };
  return {
    acquire: (name, options) => wrap(name, inner.acquire(name, options)),
    acquireShared: (name, options) =>
      wrap(name, inner.acquireShared(name, options)),
    tryAcquire: (name) => wrap(name, inner.tryAcquire(name)),
    wait: (name, signal) => inner.wait(name, signal),
    probe: (name) => inner.probe(name),
  };
}

/** Local data the wipe reads and destroys. Shared by the pages of one origin. */
export class FakeLocalData {
  databases = new Map<string, { incarnation: string }>();
  /** What the person would lose: a count and a digest per account. */
  work = new Map<string, { count: number; digest: string }>();
  deleteResult: "deleted" | "blocked_then_deleted" | "error" = "deleted";
  existsThrows = false;
  closureWaits: string[] = [];
  calls: string[] = [];
  draftFences = new Map<string, string>();
  baselineDigests = new Map<string, string | null>();
  onSetDraftFence: (() => void) | null = null;
  liveDigests = new Map<string, string>();
  /** How many of the next `setClosing` calls answer `unconfirmed` (the durable flag could not be written). */
  closingFailures = 0;
  /** How many of the next `setClosing` calls REJECT (a port that breaks its totality; the kernel must still not delete). */
  closingRejections = 0;
  /** A late writer that gets in after a `setClosing` call: runs once, after the call at which it is armed returns. */
  afterSetClosing: (() => void) | null = null;
  /** Whether `closing` is durably set, per account (what a recovery writer would find). */
  closing = new Set<string>();
}

export function fakeDeletionPorts(
  store: FakeAuthStore,
  data: FakeLocalData,
  modules: Modules = srcModules,
): DeletionPorts {
  return {
    ledger: modules.ledger.createStoreLedger(store),
    database: {
      async exists(account) {
        data.calls.push(`exists:${account}`);
        if (data.existsThrows) throw new Error("databases() unavailable");
        return data.databases.has(account);
      },
      async readIncarnation(account) {
        data.calls.push(`incarnation:${account}`);
        return data.databases.get(account)?.incarnation ?? null;
      },
      async closeOwnConnections(account) {
        data.calls.push(`close:${account}`);
      },
      async delete(account) {
        data.calls.push(`delete:${account}`);
        if (data.deleteResult === "error") return "error";
        data.databases.delete(account);
        return data.deleteResult;
      },
    },
    localWork: {
      async summarise(account) {
        const work = data.work.get(account) ?? { count: 0, digest: "0" };
        return { count: work.count, items: [], digest: work.digest };
      },
    },
    coordination: {
      async setDraftFence(account, operationId) {
        data.calls.push(`setDraftFence:${account}`);
        data.onSetDraftFence?.();
        data.draftFences.set(account, operationId);
        return { consentDigest: data.work.get(account)?.digest ?? "0" };
      },
      broadcastImminent(account) {
        data.calls.push(`broadcastImminent:${account}`);
      },
      async waitForClosure(account) {
        data.calls.push(`waitForClosure:${account}`);
      },
      async setClosing(account) {
        data.calls.push(`setClosing:${account}`);
        const hook = data.afterSetClosing;
        data.afterSetClosing = null;
        if (data.closingRejections > 0) {
          data.closingRejections -= 1;
          hook?.();
          throw new Error("setClosing rejected");
        }
        if (data.closingFailures > 0) {
          data.closingFailures -= 1;
          hook?.();
          return "unconfirmed";
        }
        data.closing.add(account);
        hook?.();
        return "closing";
      },
      async liveDigest(account) {
        data.calls.push(`liveDigest:${account}`);
        return (
          data.liveDigests.get(account) ?? data.work.get(account)?.digest ?? "0"
        );
      },
      async liveCount(account) {
        return data.work.get(account)?.count ?? 0;
      },
      async baselineDigest(account) {
        data.calls.push(`baselineDigest:${account}`);
        return data.baselineDigests.has(account)
          ? (data.baselineDigests.get(account) ?? null)
          : (data.work.get(account)?.digest ?? "0");
      },
      async releaseFence(account) {
        data.calls.push(`releaseFence:${account}`);
        data.draftFences.delete(account);
      },
    },
  };
}

export interface FixtureOptions {
  seed?: number;
  config?: Partial<SessionConfig>;
  /** The production modules to run; `src/` by default, a patched copy for the mutation tests. */
  modules?: Modules;
  /**
   * WEB-09a: the data ports (database, local work, coordination) of each page, in place of the in-memory fakes of
   * `fakeDeletionPorts`. The deletion LEDGER stays the session's own (over this fixture's `atlas-auth` double). Absent: the
   * 08a behaviour, unchanged. This is how the consent schedules run against the REAL adapters over the data layer's double.
   */
  dataPorts?: (page: {
    id: string;
    world: World;
    fixture: Fixture;
  }) => Omit<DeletionPorts, "ledger">;
}

export class FakePage {
  destroyed = false;
  frozen = false;
  constructor(
    readonly id: string,
    readonly env: FakePageEnv,
    readonly surface: FakeSurface,
    readonly session: Session,
    readonly kernel: Kernel,
    private readonly fixture: Fixture,
  ) {}
  hide(): void {
    this.env.visible = false;
    this.env.emit("hidden");
  }
  show(): void {
    this.env.visible = true;
    this.env.emit("visible");
  }
  goOffline(): void {
    this.env.online = false;
    this.env.emit("offline");
  }
  goOnline(): void {
    this.env.online = true;
    this.env.emit("online");
  }
  freeze(): void {
    this.frozen = true;
    this.fixture.world.setFrozen(this.id, true);
  }
  thaw(): void {
    this.frozen = false;
    this.fixture.world.setFrozen(this.id, false);
  }
  destroy(pending: "commit" | "abort" = "abort"): void {
    this.fixture.destroyPage(this, pending);
  }
}

/** One origin: a world, a stub server, a shared IndexedDB double, Web Locks, a BroadcastChannel and any number of pages. */
export class Fixture {
  readonly world = new World();
  /** Faults the fake platform can inject into every page's `fetch`. */
  readonly faults = { throwSync: 0 };
  readonly server: StubServer;
  readonly store: SharedStore;
  readonly locks: FakeLockManager;
  readonly bus: FakeHintBus;
  readonly prng: Prng;
  readonly data = new FakeLocalData();
  readonly pages: FakePage[] = [];
  private counter = 0;

  constructor(private readonly options: FixtureOptions = {}) {
    this.prng = new Prng(options.seed ?? 1);
    this.server = new StubServer(this.world);
    this.store = new SharedStore(this.world);
    this.locks = new FakeLockManager(this.world);
    this.store.holdsSettlementLock = (page) =>
      this.locks.holdsExclusive(page, "atlas-auth");
    this.bus = new FakeHintBus(this.world);
  }

  addPage(
    options: { config?: Partial<SessionConfig>; start?: boolean } = {},
  ): FakePage {
    const id = `p${++this.counter}`;
    const { world } = this;
    world.registerPage(id);
    const ids = new FakeIds(this.prng);
    const env = new FakePageEnv(world, id, ids.uuid());
    const surface = new FakeSurface(world, id);
    const fakeFetch = createFakeFetch(world, this.server, id, () => env.online);
    const faults = this.faults;
    const fetch = (request: Request): Promise<Response> => {
      if (faults.throwSync > 0) {
        faults.throwSync -= 1;
        throw new TypeError("fetch threw synchronously");
      }
      return fakeFetch(request);
    };
    const store = new FakeAuthStore(this.store, id);
    const modules = this.options.modules ?? srcModules;
    const { session, kernel } = modules.session.createSessionWithKernel(
      {
        store,
        locks: spyLockPort(
          world,
          id,
          createWebLocksPort(this.locks.forPage(id)),
        ),
        hints: this.bus.channelFor(id),
        clock: new FakeClock(world, id),
        ids,
        page: env,
        surface,
        transport: modules.boundary.createIssueTransport(fetch),
        unstamped: modules.unstamped.createUnstampedApi(fetch),
        deletion: this.options.dataPorts
          ? {
              ledger: modules.ledger.createStoreLedger(store),
              ...this.options.dataPorts({ id, world, fixture: this }),
            }
          : fakeDeletionPorts(store, this.data, modules),
        trace: new FakeTrace(world, id, surface),
      },
      {
        supportedRange: rangeFromPin("0.28.0-rc.1"),
        config: { ...this.options.config, ...options.config },
      },
    );
    const page = new FakePage(id, env, surface, session, kernel, this);
    this.pages.push(page);
    return page;
  }

  destroyPage(page: FakePage, pending: "commit" | "abort"): void {
    if (page.destroyed) return;
    page.destroyed = true;
    page.session.dispose();
    this.world.markDestroyed(page.id);
    this.store.destroyPage(page.id, pending);
    this.bus.destroyPage(page.id);
    this.locks.destroyPage(page.id);
    this.world.log({ type: "page.destroyed", page: page.id });
  }

  /** Start a page and run the world until it is idle. */
  async boot(page: FakePage): Promise<void> {
    const started = page.session.start();
    await this.world.runUntilIdle();
    await started;
    await this.world.runUntilIdle();
  }

  async settle(): Promise<void> {
    await this.world.runUntilIdle();
  }

  /** Sign in with the password path and run to idle. Returns the outcome. */
  async signIn(
    page: FakePage,
    username: string,
    password: string,
  ): Promise<import("../../../src/session/api").AttemptOutcome> {
    const begun = await this.runWith(page.session.attempts.begin("password"));
    if (begun.kind !== "started")
      throw new Error(`begin did not start: ${begun.kind}`);
    return this.runWith(
      page.session.attempts.signInWithPassword(begun.handle, {
        username,
        password,
      }),
    );
  }

  /** Await a promise while the world is driven. */
  async runWith<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    promise.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (let i = 0; i < 1000 && !done; i += 1) {
      await this.world.runUntilIdle();
      await this.world.settle();
    }
    if (!done)
      throw new Error("promise did not settle while the world was idle");
    if (error) throw error;
    return value as T;
  }
}

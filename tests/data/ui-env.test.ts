// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DispatcherState } from "../../src/data/engine/outbox-dispatcher";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { RecoverySeam } from "../../src/data/engine/recovery-seam";
import type {
  SyncChannel,
  SyncMessage,
} from "../../src/data/engine/sync-channel";
import type {
  EngineState,
  InvalidationHold,
  SyncEngine,
} from "../../src/data/engine/sync-engine";
import { invalidateOperation } from "../../src/data/model/retry";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { Outbox } from "../../src/data/outbox/outbox";
import { createDataEnv, type DataEnv } from "../../src/data/ui/env";
import type { Identity, Store } from "../../src/session";
import { DataTestWorld } from "../support/data/env";
import {
  FakeMarkerStorage,
  pageMarkers,
  scopeOf,
} from "../support/data/marker-storage";
import { draftRow } from "../support/data/rows";

/**
 * The UI controller (`createDataEnv`) against the production runtime, plans and facade over the double of IndexedDB: it follows the
 * displayed identity, opens a database ONLY IF IT EXISTS, keeps the status inputs, the queue and the summary current, and takes
 * a leader's state when one attaches. FIXTURE evidence: nothing here starts a sync engine or a dispatcher of its own.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get() {
    return this.value;
  }
  set(next: T) {
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** How many subscriptions are live on this store (R30: what a detach function may and may not have cut). */
  get subscribers() {
    return this.listeners.size;
  }
}

async function setup(
  options: {
    database?: boolean;
    signedIn?: boolean;
    /** The look for the database (`runtime.open`) does not finish until this settles. */
    holdOpen?: Promise<void>;
  } = {},
) {
  const markerStorage = new FakeMarkerStorage();
  const markers = pageMarkers(markerStorage, { events: false });
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  const identity = new Cell<Identity | null>(
    options.signedIn === false
      ? null
      : { account_id: ACCOUNT, epoch: 1, session_id: "s" },
  );
  page.identity.account = options.signedIn === false ? null : ACCOUNT;
  if (options.database !== false) {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
  }
  const runtime = new world.modules.accountService.DataRuntime({
    identity,
    persistence: world.modules.accountService.unorderedPersistence,
    registry: page.registry,
    open: async (account, o) => {
      opens += 1;
      await options.holdOpen;
      return page.open(account, o);
    },
  });
  const online = new Cell(true);
  const messages = new Set<(m: SyncMessage) => void>();
  const channel: SyncChannel = {
    post: () => undefined,
    subscribe: (l) => {
      messages.add(l);
      return () => messages.delete(l);
    },
  };
  const me: unknown[] = [];
  let loads = 0;
  let opens = 0;
  let readMeCalls = 0;
  const env = createDataEnv({
    identity,
    loadRuntime: async () => {
      loads += 1;
      return runtime;
    },
    online,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: () => Date.now(),
    }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date().toISOString(), now: () => Date.now() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => {
      readMeCalls += 1;
      return me.length ? { kind: "ok", value: me.shift() } : { kind: "closed" };
    },
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    channel,
    markers,
  });
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await world.settle();
  };
  return {
    world,
    page,
    identity,
    runtime,
    online,
    env,
    markers,
    settle,
    me,
    messages,
    loads: () => loads,
    opens: () => opens,
    readMeCalls: () => readMeCalls,
  };
}
const ready = (t: DataEnv["queue"] | DataEnv["summary"]) => t.get();
/** A valid cache at a known position, made visible to the controller by a write that makes it re-read the facts. */
const seedSync = async (
  t: Awaited<ReturnType<typeof setup>>,
  patch: Record<string, unknown>,
) => {
  await t.settle();
  const name = accountDatabaseName(ACCOUNT);
  const row = t.world.idb.peek(name, "sync_state", "singleton");
  t.world.idb.seed(name, "sync_state", [
    { ...row, cache_status: "valid", ...patch } as never,
  ]);
  await t.env.outbox()?.enqueue({
    endpoint: "/commands",
    targets: [],
    build: () => ({ command: {} }),
  });
  await t.settle();
};

describe("the controller never creates a database", () => {
  test("with no database for the displayed account: nothing is opened, nothing is created, the inputs say 'unknown', and the queue reads as absent", async () => {
    const t = await setup({ database: false });
    await t.settle();
    expect(t.world.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    expect(t.env.queue.get()).toEqual({
      status: "unavailable",
      reason: "absent",
    });
    expect(t.env.inputs.get()).toMatchObject({
      cache: "unknown",
      summary: null,
      engine: null,
      outbox: null,
      online: true,
    });
    expect(t.env.service()).toBeNull();
    expect(t.env.outbox()).toBeNull();
    t.env.dispose();
  });

  test("a discard with no database refuses and creates nothing", async () => {
    const t = await setup({ database: false });
    await t.settle();
    expect(await t.env.actions.discard("x")).toMatchObject({ kind: "refused" });
    expect(t.world.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    t.env.dispose();
  });
});

describe("with a database", () => {
  test("the inputs, the queue and the summary follow the store, live", async () => {
    const t = await setup();
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.env.inputs.get()).toMatchObject({
      cache: "empty",
      lastSyncedAt: null,
      summary: { waiting: 0, total: 0 },
    });
    // The rows are read only while a screen subscribes; the counts above came from the indexes without any subscriber.
    expect(t.env.queue.get()).toMatchObject({ status: "loading" });
    const watching = t.env.queue.subscribe(() => undefined);
    await t.settle();
    expect(ready(t.env.queue)).toMatchObject({
      status: "ready",
      value: { rows: [], more: false },
    });
    watching();
    const facade = t.env.outbox() as Outbox;
    const out = await facade.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { kind: "x" } }),
    });
    expect(out.kind).toBe("queued");
    await t.settle();
    expect(ready(t.env.summary)).toMatchObject({
      status: "ready",
      value: { waiting: 1, total: 1 },
    });
    expect(t.env.inputs.get().summary).toMatchObject({ waiting: 1 });
    // The rows are loaded only because something subscribed to them; the count above came from the index counts.
    const unsubscribe = t.env.queue.subscribe(() => undefined);
    await t.settle();
    expect(
      (ready(t.env.queue) as { value: { rows: unknown[] } }).value.rows,
    ).toHaveLength(1);
    unsubscribe();
    t.env.dispose();
  });

  test("the cache status and the last sync come from sync_state", async () => {
    const t = await setup();
    await t.settle();
    const name = accountDatabaseName(ACCOUNT);
    const row = t.world.idb.peek(name, "sync_state", "singleton");
    t.world.idb.seed(name, "sync_state", [
      {
        ...row,
        cache_status: "invalid",
        last_synced_at: "2026-10-01T09:00:00.000Z",
      } as never,
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    expect(t.env.inputs.get()).toMatchObject({
      cache: "invalid",
      lastSyncedAt: "2026-10-01T09:00:00.000Z",
    });
    t.env.dispose();
  });

  describe("R10: a cache the server said is invalid stays hidden while the write that records it is outstanding", () => {
    test("the control: a valid cache, nothing outstanding, is valid", async () => {
      const t = await setup();
      await seedSync(t, { cursor: "cursor-0" });
      expect(t.env.inputs.get().cache).toBe("valid");
      t.env.dispose();
    });

    test("a durable failure streak at the CURRENT position reads as invalid, for every tab that reads the facts", async () => {
      const t = await setup();
      await seedSync(t, {
        cursor: "cursor-0",
        local_write_streaks: { [invalidateOperation("cursor-0")]: 1 },
      });
      expect(t.env.inputs.get().cache).toBe("invalid");
      t.env.dispose();
    });

    test("a streak left at a position that has moved on hides nothing", async () => {
      const t = await setup();
      await seedSync(t, {
        cursor: "cursor-9",
        local_write_streaks: { [invalidateOperation("cursor-0")]: 2 },
      });
      expect(t.env.inputs.get().cache).toBe("valid");
      t.env.dispose();
    });

    test("the account's fallback marker for the current position reads as invalid (a reload with even the streak unwritten); one for another position does not", async () => {
      const t = await setup();
      t.markers.set(scopeOf(ACCOUNT), invalidateOperation("cursor-0"));
      await seedSync(t, { cursor: "cursor-0" });
      expect(t.env.inputs.get().cache).toBe("invalid");
      t.markers.clear(scopeOf(ACCOUNT), invalidateOperation("cursor-0"));
      t.markers.set(scopeOf(ACCOUNT), invalidateOperation("cursor-5"));
      await seedSync(t, {
        cursor: "cursor-0",
        last_synced_at: "2026-10-02T09:00:00.000Z",
      });
      expect(t.env.inputs.get().cache).toBe("valid");
      t.env.dispose();
    });

    test("an attached engine's hold on the CURRENT position hides the cache and recomputes the status when it is added and when it ends; another position's, account's or incarnation's does not", async () => {
      const t = await setup();
      await seedSync(t, { cursor: "cursor-0" });
      expect(t.env.inputs.get().cache).toBe("valid");
      const incarnationId = t.env.service()?.incarnationId as string;
      const holds = new Cell<readonly InvalidationHold[]>([]);
      const engine = {
        state: new Cell<EngineState>({ kind: "waiting", reason: "offline" }),
        invalidations: holds,
        retryNow: () => undefined,
        start: () => undefined,
        stop: () => undefined,
        nudge: () => undefined,
        settled: async () => undefined,
      } as SyncEngine;
      const off = t.env.attachLeader({ engine });
      expect(t.env.inputs.get().cache).toBe("valid");
      const mine = {
        account: ACCOUNT,
        incarnationId,
        operation: invalidateOperation("cursor-0"),
      };
      holds.set([mine]);
      expect(t.env.inputs.get().cache).toBe("invalid");
      holds.set([]);
      expect(t.env.inputs.get().cache).toBe("valid");
      for (const foreign of [
        { ...mine, operation: invalidateOperation("cursor-5") },
        { ...mine, account: OTHER },
        { ...mine, incarnationId: "another-incarnation" },
      ]) {
        holds.set([foreign]);
        expect(t.env.inputs.get().cache).toBe("valid");
      }
      // Detached, a leader's hold is carried; and it still obeys the same key.
      holds.set([mine]);
      expect(t.env.inputs.get().cache).toBe("invalid");
      off();
      expect(t.env.inputs.get().engine).toBeNull();
      expect(t.env.inputs.get().cache).toBe("invalid");
      t.env.dispose();
    });

    test("an invalid cache stays invalid, and a cache with no database is unknown", async () => {
      const t = await setup();
      await seedSync(t, { cache_status: "invalid", cursor: null });
      expect(t.env.inputs.get().cache).toBe("invalid");
      t.env.dispose();
      const none = await setup({ database: false });
      await none.settle();
      expect(none.env.inputs.get().cache).toBe("unknown");
      none.env.dispose();
    });
  });

  test("the displayed identity leaving the account ends the service and the queue reads as absent; returning reattaches", async () => {
    const t = await setup();
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    t.page.identity.account = null;
    t.identity.set(null);
    await t.settle();
    expect(t.env.service()).toBeNull();
    expect(t.env.queue.get()).toEqual({
      status: "unavailable",
      reason: "absent",
    });
    expect(t.env.inputs.get().summary).toBeNull();
    t.page.identity.account = ACCOUNT;
    t.identity.set({ account_id: ACCOUNT, epoch: 1, session_id: "s" });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    t.env.dispose();
  });

  test("another account is never read: switching the identity to an account with no database shows absent, not the old queue", async () => {
    const t = await setup();
    await t.settle();
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    t.page.identity.account = OTHER;
    t.identity.set({ account_id: OTHER, epoch: 1, session_id: "s2" });
    await t.settle();
    expect(t.env.queue.get()).toEqual({
      status: "unavailable",
      reason: "absent",
    });
    expect(t.world.idb.has(accountDatabaseName(OTHER))).toBe(false);
    t.env.dispose();
  });
});

describe("a database that another tab creates later", () => {
  test("a data_changed hint (or online) makes the controller look again, without a reload, and still never creates", async () => {
    const t = await setup({ database: false });
    await t.settle();
    expect(t.env.service()).toBeNull();
    // Another tab runs the first sync and creates the database.
    const created = await t.page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    for (const listener of [...t.messages])
      listener({ type: "data_changed", account: ACCOUNT, stores: ["cache"] });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    const watching = t.env.queue.subscribe(() => undefined);
    await t.settle();
    expect(t.env.queue.get()).toMatchObject({ status: "ready" });
    watching();
    t.env.dispose();
  });

  test("coming back online looks again too", async () => {
    const t = await setup({ database: false });
    await t.settle();
    const created = await t.page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    t.online.set(false);
    t.online.set(true);
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    t.env.dispose();
  });
});

describe("a leader takes part", () => {
  const fakeEngine = (initial: EngineState) => {
    const state = new Cell<EngineState>(initial);
    let retries = 0;
    return {
      engine: {
        state,
        invalidations: new Cell<readonly InvalidationHold[]>([]),
        retryNow: () => {
          retries += 1;
        },
        start: () => undefined,
        stop: () => undefined,
        nudge: () => undefined,
        settled: async () => undefined,
      } as SyncEngine,
      state,
      retries: () => retries,
    };
  };

  test("the status inputs carry the engine's state while it is attached, and fall back to 'no engine' when it detaches", async () => {
    const t = await setup();
    await t.settle();
    const e = fakeEngine({ kind: "running", catchingUp: true });
    const off = t.env.attachLeader({ engine: e.engine });
    expect(t.env.inputs.get().engine).toEqual({
      kind: "running",
      catchingUp: true,
    });
    e.state.set({ kind: "stopped", cause: "floor" });
    expect(t.env.inputs.get().engine).toEqual({
      kind: "stopped",
      cause: "floor",
    });
    t.env.actions.retryUpdates();
    expect(e.retries()).toBe(1);
    off();
    expect(t.env.inputs.get().engine).toBeNull();
    t.env.dispose();
  });

  test("a recovery seam's activity flows to the chip's 'Resyncing'", async () => {
    const t = await setup();
    await t.settle();
    const active = new Cell(false);
    t.env.attachLeader({
      recovery: { registered: true, request: () => undefined, active },
    });
    expect(t.env.inputs.get().recovery).toEqual({
      registered: true,
      active: false,
    });
    active.set(true);
    expect(t.env.inputs.get().recovery).toEqual({
      registered: true,
      active: true,
    });
    t.env.dispose();
  });

  test("with no leader, Retry now for updates does nothing and never throws", async () => {
    const t = await setup();
    await t.settle();
    expect(() => t.env.actions.retryUpdates()).not.toThrow();
    expect(() => t.env.actions.retryChanges()).not.toThrow();
    t.env.dispose();
  });
});

describe("R30 (revision 14): a detach function belongs to the attachment that made it", () => {
  /** A leader with every store the controller follows, each one a cell whose live subscriptions can be counted. */
  const leaderOf = () => {
    const engineState = new Cell<EngineState>({
      kind: "waiting",
      reason: "offline",
    });
    const invalidations = new Cell<readonly InvalidationHold[]>([]);
    const outboxState = new Cell<DispatcherState>({ kind: "idle" });
    const notResponding = new Cell(false);
    const memoryOnly = new Cell(false);
    const recoveryActive = new Cell(false);
    const stores = {
      engineState,
      invalidations,
      outboxState,
      notResponding,
      memoryOnly,
      recoveryActive,
    };
    const leader = {
      engine: {
        state: engineState,
        invalidations,
        retryNow: () => undefined,
        start: () => undefined,
        stop: () => undefined,
        nudge: () => undefined,
        settled: async () => undefined,
      } as SyncEngine,
      outbox: {
        state: outboxState,
        storageNotResponding: notResponding,
        storageMemoryOnly: memoryOnly,
      } as unknown as Outbox,
      recovery: {
        registered: true,
        request: () => undefined,
        active: recoveryActive,
      } as RecoverySeam,
    };
    const live = () =>
      Object.fromEntries(
        Object.entries(stores).map(([name, cell]) => [name, cell.subscribers]),
      );
    return { stores, leader, live };
  };
  const NONE = {
    engineState: 0,
    invalidations: 0,
    outboxState: 0,
    notResponding: 0,
    memoryOnly: 0,
    recoveryActive: 0,
  };
  const ONE = {
    engineState: 1,
    invalidations: 1,
    outboxState: 1,
    notResponding: 1,
    memoryOnly: 1,
    recoveryActive: 1,
  };

  /** What the status says about the leader that stands: every store moves one input, so a cut subscription shows. */
  const drive = (
    t: Awaited<ReturnType<typeof setup>>,
    b: ReturnType<typeof leaderOf>,
  ) => {
    b.stores.engineState.set({ kind: "running", catchingUp: true });
    expect(t.env.inputs.get().engine).toEqual({
      kind: "running",
      catchingUp: true,
    });
    b.stores.outboxState.set({ kind: "sending" });
    expect(t.env.inputs.get().outbox).toEqual({ kind: "sending" });
    b.stores.notResponding.set(true);
    expect(t.env.inputs.get().storageNotResponding).toBe(true);
    b.stores.memoryOnly.set(true);
    expect(t.env.inputs.get().storageMemoryOnly).toBe(true);
    b.stores.recoveryActive.set(true);
    expect(t.env.inputs.get().recovery).toEqual({
      registered: true,
      active: true,
    });
    b.stores.notResponding.set(false);
    b.stores.memoryOnly.set(false);
    b.stores.recoveryActive.set(false);
    b.stores.outboxState.set({ kind: "idle" });
    expect(t.env.inputs.get().recovery.active).toBe(false);
    expect(t.env.inputs.get().outbox).toEqual({ kind: "idle" });
  };

  // "late": the first and only call comes after the replacement; "twice": it ran once before it and runs again; "late and twice": it
  // never ran before the replacement and runs twice after.
  for (const cleanup of ["late", "twice", "late and twice"] as const)
    test(`an obsolete disposer (${cleanup}) leaves every subscription of the replacement leader in place, and the status keeps following it`, async () => {
      const t = await setup();
      await t.settle();
      const a = leaderOf();
      const b = leaderOf();
      const detachA = t.env.attachLeader(a.leader);
      expect(a.live()).toEqual(ONE);
      if (cleanup !== "late") {
        detachA();
        expect(a.live()).toEqual(NONE);
      }
      const detachB = t.env.attachLeader(b.leader);
      // Replacing a leader lets go of the one before, and follows the new one.
      expect(a.live()).toEqual(NONE);
      expect(b.live()).toEqual(ONE);
      // The obsolete disposer runs (again, or for the first time) AFTER the replacement attached.
      detachA();
      if (cleanup === "late and twice") detachA();
      expect(b.live()).toEqual(ONE);
      expect(a.live()).toEqual(NONE);
      drive(t, b);
      // The replacement's own disposer still works, once.
      detachB();
      expect(b.live()).toEqual(NONE);
      expect(t.env.inputs.get().engine).toBeNull();
      expect(t.env.inputs.get().outbox).toBeNull();
      t.env.dispose();
    });

  test("the control: a disposer detaches the leader that stands, and a second call changes nothing", async () => {
    const t = await setup();
    await t.settle();
    const a = leaderOf();
    const detach = t.env.attachLeader(a.leader);
    drive(t, a);
    detach();
    expect(a.live()).toEqual(NONE);
    expect(t.env.inputs.get().engine).toBeNull();
    expect(t.env.inputs.get().outbox).toBeNull();
    expect(t.env.inputs.get().recovery.registered).toBe(false);
    const b = leaderOf();
    t.env.attachLeader(b.leader);
    detach();
    expect(b.live()).toEqual(ONE);
    drive(t, b);
    t.env.dispose();
  });

  test("the same leader attached again: the first disposer is obsolete, the second detaches", async () => {
    const t = await setup();
    await t.settle();
    const a = leaderOf();
    const first = t.env.attachLeader(a.leader);
    const second = t.env.attachLeader(a.leader);
    expect(a.live()).toEqual(ONE);
    first();
    expect(a.live()).toEqual(ONE);
    drive(t, a);
    second();
    expect(a.live()).toEqual(NONE);
    t.env.dispose();
  });

  test("an obsolete disposer neither carries nor forgets: the replacement's admitted invalidation still hides the cache", async () => {
    const t = await setup();
    await seedSync(t, { cursor: "cursor-0" });
    const incarnationId = t.env.service()?.incarnationId as string;
    const a = leaderOf();
    const b = leaderOf();
    const detachA = t.env.attachLeader(a.leader);
    t.env.attachLeader(b.leader);
    detachA();
    expect(t.env.inputs.get().cache).toBe("valid");
    b.stores.invalidations.set([
      {
        account: ACCOUNT,
        incarnationId,
        operation: invalidateOperation("cursor-0"),
      },
    ]);
    expect(t.env.inputs.get().cache).toBe("invalid");
    detachA();
    expect(t.env.inputs.get().cache).toBe("invalid");
    b.stores.invalidations.set([]);
    expect(t.env.inputs.get().cache).toBe("valid");
    t.env.dispose();
  });

  test("a repeated disposer carries nothing new: what a detached leader's engine admits afterwards is not this tab's to hold", async () => {
    const t = await setup();
    await seedSync(t, { cursor: "cursor-0" });
    const incarnationId = t.env.service()?.incarnationId as string;
    const a = leaderOf();
    const detach = t.env.attachLeader(a.leader);
    detach();
    // The detached engine goes on (it is somebody else's now) and admits an invalidation of the position this tab shows.
    a.stores.invalidations.set([
      {
        account: ACCOUNT,
        incarnationId,
        operation: invalidateOperation("cursor-0"),
      },
    ]);
    detach();
    expect(t.env.inputs.get().cache).toBe("valid");
    t.env.dispose();
  });

  test("a disposer that runs after the controller was stopped and started again detaches nothing of a later leader", async () => {
    const t = await setup();
    await t.settle();
    const a = leaderOf();
    const b = leaderOf();
    const detachA = t.env.attachLeader(a.leader);
    t.env.dispose();
    t.env.start();
    t.env.attachLeader(b.leader);
    detachA();
    expect(b.live()).toEqual(ONE);
    drive(t, b);
    t.env.dispose();
  });
});

/**
 * R31 (revision 15): what a detached leader admitted (an invalidation that could be written nowhere durable) belongs to the CONTROLLER,
 * and `stop`/`start` are a reversible pair (R29): a restart in the same JavaScript realm must not reopen the cache the server called
 * invalid. The hold ends on evidence from a read of the facts that landed: the position moved on, or the durable state now speaks (the
 * cache is no longer `valid`: the invalidation was recorded, and a later `valid` is a recovered cache), never on a lifecycle event.
 */
describe("R31 (revision 15): a carried invalidation outlives a restart of the controller and ends only on evidence", () => {
  const CURSOR = "cursor-0";
  type T = Awaited<ReturnType<typeof setup>>;
  const engineOf = (holds: Cell<readonly InvalidationHold[]>) =>
    ({
      state: new Cell<EngineState>({ kind: "waiting", reason: "offline" }),
      invalidations: holds,
      retryNow: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      nudge: () => undefined,
      settled: async () => undefined,
    }) as SyncEngine;
  /** A valid cache at `CURSOR`, and a leader that admits an invalidation of it which no durable record holds. */
  const admitted = async (t: T) => {
    await seedSync(t, { cursor: CURSOR });
    const incarnationId = t.env.service()?.incarnationId as string;
    const holds = new Cell<readonly InvalidationHold[]>([]);
    const off = t.env.attachLeader({ engine: engineOf(holds) });
    holds.set([
      {
        account: ACCOUNT,
        incarnationId,
        operation: invalidateOperation(CURSOR),
      },
    ]);
    expect(t.env.inputs.get().cache).toBe("invalid");
    return { holds, off, incarnationId };
  };
  const restart = async (t: T) => {
    t.env.dispose();
    t.env.start();
    await t.settle();
  };
  /** The same write as `seedSync` makes to ANY account's database, with a real write (a draft) through the bound facade to wake the watch. */
  const writeFacts = async (
    t: T,
    account: string,
    patch: Record<string, unknown>,
  ) => {
    await t.settle();
    const name = accountDatabaseName(account);
    const row = t.world.idb.peek(name, "sync_state", "singleton");
    t.world.idb.seed(name, "sync_state", [{ ...row, ...patch } as never]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
  };

  for (const restarts of [1, 2, 3])
    test(`the leader detached, then the controller stopped and started ${restarts} time(s): the cache stays hidden at its position`, async () => {
      const t = await setup();
      const { off } = await admitted(t);
      off();
      expect(t.env.inputs.get().engine).toBeNull();
      expect(t.env.inputs.get().cache).toBe("invalid");
      for (let i = 0; i < restarts; i += 1) {
        await restart(t);
        expect(t.env.inputs.get().cache).toBe("invalid");
      }
      // A repeated disposer, after the restarts, carries nothing new and forgets nothing.
      off();
      expect(t.env.inputs.get().cache).toBe("invalid");
      t.env.dispose();
    });

  test("a stop that is repeated before the start keeps it too, and so does a start that is repeated", async () => {
    const t = await setup();
    const { off } = await admitted(t);
    off();
    t.env.dispose();
    t.env.dispose();
    t.env.start();
    t.env.start();
    await t.settle();
    expect(t.env.inputs.get().cache).toBe("invalid");
    t.env.dispose();
  });

  test("the control: the leader stays attached through the restart, detaches after it, and the hold is carried from the live engine", async () => {
    const t = await setup();
    const { off } = await admitted(t);
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("invalid");
    off();
    expect(t.env.inputs.get().cache).toBe("invalid");
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("invalid");
    t.env.dispose();
  });

  test("a leader that was REPLACED hands its hold on, and the controller keeps it through a restart", async () => {
    const t = await setup();
    await admitted(t);
    // A replacement with nothing admitted: the first leader's hold is carried at the moment it is replaced.
    const replacement = t.env.attachLeader({
      engine: engineOf(new Cell<readonly InvalidationHold[]>([])),
    });
    expect(t.env.inputs.get().cache).toBe("invalid");
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("invalid");
    replacement();
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("invalid");
    t.env.dispose();
  });

  test("the control: a restart with nothing admitted leaves the cache open", async () => {
    const t = await setup();
    await seedSync(t, { cursor: CURSOR });
    const off = t.env.attachLeader({
      engine: engineOf(new Cell<readonly InvalidationHold[]>([])),
    });
    off();
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("valid");
    t.env.dispose();
  });

  test("a position that moved on while the controller was stopped is another cache: it is not hidden, and the old hold is dropped for good", async () => {
    const t = await setup();
    const { off } = await admitted(t);
    off();
    t.env.dispose();
    // Another page committed while this one was stopped: a newer position, still valid.
    const name = accountDatabaseName(ACCOUNT);
    const row = t.world.idb.peek(name, "sync_state", "singleton");
    t.world.idb.seed(name, "sync_state", [
      { ...row, cache_status: "valid", cursor: "cursor-9" } as never,
    ]);
    t.env.start();
    await t.settle();
    expect(t.env.inputs.get().cache).toBe("valid");
    // What a read that named another position decided is final: were the old position ever named again (a test can only do it by
    // writing the cursor back), the hold the controller carried for it has already gone.
    await writeFacts(t, ACCOUNT, { cursor: CURSOR });
    expect(t.env.inputs.get().cache).toBe("valid");
    t.env.dispose();
  });

  test("the durable state speaking ends it: once the facts say the cache is invalid, a later valid cache at the same position (a recovered one) is not hidden by the old hold", async () => {
    const t = await setup();
    const { off } = await admitted(t);
    off();
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("invalid");
    // The invalidation is recorded by whoever could write it (another tab): the status itself now hides the cache.
    await writeFacts(t, ACCOUNT, { cache_status: "invalid" });
    expect(t.env.inputs.get().cache).toBe("invalid");
    // Recovery replaced the cache; it is named by the same position and is valid.
    await writeFacts(t, ACCOUNT, { cache_status: "valid", cursor: CURSOR });
    expect(t.env.inputs.get().cache).toBe("valid");
    t.env.dispose();
  });

  test("another account's facts do not decide it: the hold survives a visit to another account and a restart, and hides the account's cache on its return", async () => {
    const t = await setup();
    const { off } = await admitted(t);
    off();
    // The other account's database, made while the page is signed in as it (a page opens only the account it shows), valid at the
    // SAME position name: only the account keeps this account's hold from hiding it.
    t.page.identity.account = OTHER;
    const other = await t.page.open(OTHER, { create: true });
    if (other.kind !== "opened") throw new Error("setup");
    t.world.idb.seed(accountDatabaseName(OTHER), "sync_state", [
      {
        ...t.world.idb.peek(
          accountDatabaseName(OTHER),
          "sync_state",
          "singleton",
        ),
        cache_status: "valid",
        cursor: CURSOR,
      } as never,
    ]);
    t.page.identity.account = OTHER;
    t.identity.set({ account_id: OTHER, epoch: 1, session_id: "s2" });
    await t.settle();
    // The other account is not hidden by this account's hold: it is keyed by the account (and its incarnation and position).
    expect(t.env.inputs.get().cache).toBe("valid");
    await restart(t);
    expect(t.env.inputs.get().cache).toBe("valid");
    t.page.identity.account = ACCOUNT;
    t.identity.set({ account_id: ACCOUNT, epoch: 1, session_id: "s" });
    await t.settle();
    expect(t.env.inputs.get().cache).toBe("invalid");
    t.env.dispose();
  });
});

describe("discard through the controller", () => {
  test("removes a queued draft from the queue the screens read", async () => {
    const t = await setup();
    await t.settle();
    const name = accountDatabaseName(ACCOUNT);
    t.world.idb.seed(name, "drafts", [
      draftRow({ local_id: "d1", created_seq: 1, status: "queued" }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    const out = await t.env.actions.discard("d1");
    expect(out).toMatchObject({ kind: "discarded", outcome: "removed" });
    await t.settle();
    const unsubscribe = t.env.queue.subscribe(() => undefined);
    await t.settle();
    const queue = t.env.queue.get();
    expect(
      queue.status === "ready" &&
        queue.value.rows.some((d) => d.local_id === "d1"),
    ).toBe(false);
    unsubscribe();
    t.env.dispose();
  });
});

describe("the profile label", () => {
  test("is read once the account is displayed and online, for the current epoch only", async () => {
    const t = await setup();
    t.me.push({ id: ACCOUNT, username: "kieran" });
    await t.settle();
    // Re-evaluate: the profile source follows the identity and verifies once online.
    t.identity.set({ account_id: ACCOUNT, epoch: 1, session_id: "s" });
    await t.settle();
    expect(t.env.profile.labelFor(t.identity.get())).toBe("kieran");
    t.identity.set({ account_id: ACCOUNT, epoch: 2, session_id: "s" });
    t.page.identity.epoch = 2;
    expect(t.env.profile.labelFor(t.identity.get())).toBeNull();
    t.env.dispose();
  });
});

describe("loading the runtime", () => {
  test("is lazy, happens once for any number of identity notifications, and a failure leaves the controller inert but alive", async () => {
    const t = await setup();
    await t.settle();
    t.identity.set({ account_id: ACCOUNT, epoch: 1, session_id: "s" });
    t.identity.set({ account_id: ACCOUNT, epoch: 1, session_id: "s" });
    await t.settle();
    expect(t.loads()).toBe(1);
    t.env.dispose();
    const world = new DataTestWorld();
    const failing = createDataEnv({
      identity: new Cell<Identity | null>({
        account_id: ACCOUNT,
        epoch: 1,
        session_id: "s",
      }),
      loadRuntime: async () => {
        throw new Error("chunk failed");
      },
      online: new Cell(true),
      quota: createQuotaGuard({ storage: undefined, now: () => 0 }),
      ids: { uuid: () => "x" },
      clock: { iso: () => "", now: () => 0 },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
      readMe: async () => ({ kind: "closed" }),
      currentDeviceId: async () => ({ kind: "closed" }),
      onOnline: () => () => undefined,
    });
    void world;
    await new Promise((r) => setTimeout(r, 5));
    expect(failing.service()).toBeNull();
    expect(failing.queue.get().status).toBeDefined();
    failing.dispose();
  });
});

describe("R16 (revision 9): the look for the account's database", () => {
  const same = (): Identity => ({
    account_id: ACCOUNT,
    epoch: 1,
    session_id: "s",
  });
  const held = () => {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  test("a notification of the identity the page is already looking for starts no other look: the look can finish", async () => {
    const hold = held();
    const t = await setup({ holdOpen: hold.promise });
    // The look is under way (held inside the runtime's open) when the notifications arrive.
    await t.settle();
    expect(t.opens()).toBe(1);
    for (let i = 0; i < 500; i += 1) t.identity.set(same());
    await t.settle();
    expect(t.opens()).toBe(1);
    hold.release();
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.opens()).toBe(1);
  });

  test("the profile read waits for the look: nothing is asked while it is under way, and the page then asks once", async () => {
    const hold = held();
    const t = await setup({ holdOpen: hold.promise });
    t.me.push({ id: ACCOUNT, username: "Late Alice" });
    await t.settle();
    expect(t.readMeCalls()).toBe(0);
    hold.release();
    await t.settle();
    expect(t.readMeCalls()).toBe(1);
    expect(t.env.profile.labelFor(t.identity.get())).toBe("Late Alice");
  });

  test("a database that does not exist is a finished look: the profile is asked on the page's memory, and nothing is created", async () => {
    const hold = held();
    const t = await setup({ database: false, holdOpen: hold.promise });
    t.me.push({ id: ACCOUNT, username: "Absent Alice" });
    await t.settle();
    expect(t.readMeCalls()).toBe(0);
    hold.release();
    await t.settle();
    expect(t.readMeCalls()).toBe(1);
    expect(t.world.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
  });

  test("a durable pause is honoured from the first moment: the held look, then the open database, and not one request", async () => {
    const hold = held();
    const t = await setup({ holdOpen: hold.promise });
    const sync = t.world.idb.peek(
      accountDatabaseName(ACCOUNT),
      "sync_state",
      "singleton",
    );
    if (sync === undefined) throw new Error("setup: no singleton");
    t.world.idb.seed(accountDatabaseName(ACCOUNT), "sync_state", [
      {
        ...sync,
        read_retry_states: {
          "profile:1": {
            backing_off_since: null,
            paused: true,
            unrecognised_streak: 3,
          },
        },
      },
    ]);
    await t.settle();
    hold.release();
    await t.settle();
    expect(t.readMeCalls()).toBe(0);
  });
});

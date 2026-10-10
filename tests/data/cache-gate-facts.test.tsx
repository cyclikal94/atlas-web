import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createDataEnv,
  DataEnvProvider,
  useCachedResource,
} from "../../src/data";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { SyncStateRow } from "../../src/data/model/types";
import { resetSizingFloor } from "../../src/data/plans/sync-writers";
import { CacheGate } from "../../src/features/sync/CacheGate";
import { GATE_TITLE } from "../../src/features/sync/copy";
import type { Identity, Store } from "../../src/session";
import { DataTestWorld } from "../support/data/env";
import { cacheRow } from "../support/data/rows";

/**
 * R13 at the component boundary (revision 10): the REAL provider, `CacheGate` and `useCachedResource` over the production controller,
 * plans and the double of IndexedDB. A cache the database says is invalid must not reach the screen when the read of its sync facts is
 * delayed or fails, and the shell around the gate stays on screen. FIXTURE evidence (jsdom, a named injected fault).
 */
afterEach(cleanup);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const RETAINED = "REVIEW RETAINED CONTENT";
const NAME = accountDatabaseName(ACCOUNT);

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
}

/** Timers the test drives: the controller's paced re-read runs when `tick` reaches it. */
function manualTimers() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        next += 1;
        due.set(next, { at: now + ms, fn });
        return next;
      },
      clearTimeout: (handle: unknown) => {
        due.delete(handle as number);
      },
    },
    tick(ms: number) {
      now += ms;
      for (const [id, entry] of [...due])
        if (entry.at <= now) {
          due.delete(id);
          entry.fn();
        }
    },
    pending: () => due.size,
  };
}

function Resource() {
  const resource = useCachedResource("r");
  return (
    <p data-testid="resource">
      {resource.status === "ready"
        ? (resource.value.merged?.label ?? "nothing")
        : `unavailable:${resource.status}`}
    </p>
  );
}

async function mount(options: {
  database: boolean;
  cacheStatus?: "valid" | "invalid";
  /** Arms a fault before the controller makes its first read of the facts. */
  arm?: (world: DataTestWorld) => void;
}) {
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  page.identity.account = ACCOUNT;
  if (options.database) {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    const sync = world.idb.peek(
      NAME,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    world.idb.seed(NAME, "sync_state", [
      {
        ...sync,
        cache_status: options.cacheStatus ?? "valid",
        cursor: "cursor-0",
      },
    ]);
    world.idb.seed(NAME, "cache", [cacheRow({ id: "r", label: RETAINED })]);
  }
  options.arm?.(world);
  const onlineListeners = new Set<() => void>();
  const identity = new Cell<Identity | null>({
    account_id: ACCOUNT,
    epoch: 1,
    session_id: "s",
  });
  const runtime = new world.modules.accountService.DataRuntime({
    identity,
    persistence: world.modules.accountService.unorderedPersistence,
    registry: page.registry,
    open: (a, o) => page.open(a, o),
  });
  const clock = manualTimers();
  const env = createDataEnv({
    identity,
    loadRuntime: async () => runtime,
    online: new Cell(true),
    quota: createQuotaGuard({ storage: undefined, now: () => 0 }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date().toISOString(), now: () => 0 },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: (listener) => {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
    channel: { post: () => undefined, subscribe: () => () => undefined },
    timers: clock.timers,
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 15; i += 1) await world.settle();
    });
  };
  render(
    <DataEnvProvider env={env}>
      <nav aria-label="Shell">Shell stays</nav>
      <CacheGate>
        <Resource />
      </CacheGate>
    </DataEnvProvider>,
  );
  await settle();
  return {
    world,
    env,
    settle,
    /** Time passes: the controller's paced re-read, if due, is made. */
    async tick(ms: number) {
      clock.tick(ms);
      await settle();
    },
    pending: clock.pending,
    /** Another tab creates the account database (the first sync), with this cache and status, and this page is told the browser is online. */
    async anotherTabCreates(cacheStatus: "valid" | "invalid") {
      const created = await page.open(ACCOUNT, { create: true });
      if (created.kind !== "opened") throw new Error("setup");
      const sync = world.idb.peek(
        NAME,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      world.idb.seed(NAME, "sync_state", [
        { ...sync, cache_status: cacheStatus, cursor: "cursor-0" },
      ]);
      world.idb.seed(NAME, "cache", [cacheRow({ id: "r", label: RETAINED })]);
      for (const listener of [...onlineListeners]) listener();
      await settle();
    },
    /** Any write to the singleton re-evaluates a live read of it. */
    async nudge() {
      await act(async () => {
        const service = env.service();
        if (service === null) throw new Error("no service");
        await service.store.run(resetSizingFloor, {
          incarnationId: service.incarnationId,
        });
      });
      await settle();
    },
    makeValid() {
      world.idb.seed(NAME, "sync_state", [
        {
          ...(world.idb.peek(NAME, "sync_state", "singleton") as SyncStateRow),
          cache_status: "valid",
        },
      ]);
    },
  };
}

const failFacts = (
  mode: "error" | "pending",
  times = 1,
): ((world: DataTestWorld) => void) => {
  return (world) => {
    world.idb.inject({
      match: (tx) => tx.label === "data.readSyncFacts",
      mode,
      times,
    });
  };
};

const gateShown = () =>
  screen.queryByRole("heading", { name: GATE_TITLE }) !== null;

describe("CacheGate with the sync facts unread", () => {
  test("a failed read of the facts of an invalid cache: the retained content is not rendered, the shell is, and the message is the wireframe's", async () => {
    const t = await mount({
      database: true,
      cacheStatus: "invalid",
      arm: failFacts("error"),
    });
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(screen.queryByTestId("resource")).toBeNull();
    expect(gateShown()).toBe(true);
    expect(
      screen.getByRole("navigation", { name: "Shell" }),
    ).toBeInTheDocument();
    // The read is made again after its wait, and what it says (invalid) keeps the content hidden.
    await t.tick(DATA_CONFIG.factsReadRetryMs);
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    // The database becomes valid and a later read lands: the content is shown, and the gate is gone.
    t.makeValid();
    await t.nudge();
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
  });

  test("a failed read AFTER the invalid state was established: the content stays hidden through it", async () => {
    const t = await mount({ database: true, cacheStatus: "invalid" });
    expect(gateShown()).toBe(true);
    // The next read fails (armed now, consumed by the nudge's re-evaluation).
    failFacts("error")(t.world);
    await t.nudge();
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    await t.tick(DATA_CONFIG.factsReadRetryMs);
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
  });

  test("a delayed first read of a valid cache: hidden while it is pending, shown the moment it lands", async () => {
    const t = await mount({
      database: true,
      cacheStatus: "valid",
      // Two reads never answer: opening the account publishes its epoch, a write to the singleton that re-evaluates the first read.
      arm: failFacts("pending", 2),
    });
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    await t.nudge();
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
  });

  test("control: a valid cache with nothing wrong is shown, there is no gate and nothing is waiting to read again", async () => {
    const t = await mount({ database: true, cacheStatus: "valid" });
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
    expect(t.pending()).toBe(0);
  });

  test("control: an invalid cache that reads normally is hidden", async () => {
    await mount({ database: true, cacheStatus: "invalid" });
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
  });

  test("a database another tab creates later is hidden until ITS first read lands, then shown if valid", async () => {
    const t = await mount({ database: false });
    expect(gateShown()).toBe(false);
    // The first read of the new database never answers (two reads: opening publishes the epoch, which re-evaluates the first).
    failFacts("pending", 2)(t.world);
    await t.anotherTabCreates("valid");
    expect(t.env.inputs.get().cache).toBe("unverified");
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    await t.nudge();
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
  });

  test("a database another tab creates later with an INVALID cache is hidden as soon as it is bound", async () => {
    const t = await mount({ database: false });
    await t.anotherTabCreates("invalid");
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
  });

  test("control: with NO database nothing is gated, the view reads as absent, and nothing is created", async () => {
    const t = await mount({ database: false });
    expect(gateShown()).toBe(false);
    expect(screen.getByTestId("resource")).toHaveTextContent(
      "unavailable:unavailable",
    );
    expect(t.world.idb.has(NAME)).toBe(false);
    expect(t.env.inputs.get().cache).toBe("unknown");
  });
});

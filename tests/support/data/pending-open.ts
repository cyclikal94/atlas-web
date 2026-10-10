import {
  DataRuntime,
  unorderedPersistence,
} from "../../../src/data/engine/account-service";
import type { DatabaseHost } from "../../../src/data/store/host";
import {
  type EngineOpener,
  type OpenDeps,
  openAccountData,
} from "../../../src/data/store/open";
import { StoreFailure } from "../../../src/data/store/port";
import type { Identity, Store } from "../../../src/session";
import { DataTestWorld } from "./env";

/**
 * The world of the R35 tests (revision 20): a page of the data layer's fake world whose database discovery and native open can each be HELD
 * at a point the test names, and runtimes built over it. Shared by `tests/data/runtime-disposal.test.ts` (the runtime alone) and
 * `tests/data/provider-pending-open.test.tsx` (the production provider, controller and runtime). The double of IndexedDB is test support; the
 * runtime, `openAccountData`, the registry and the controller are the production modules.
 */
export const A = "11111111-1111-4111-8111-111111111111";
export const B = "22222222-2222-4222-8222-222222222222";

export class Cell<T> implements Store<T> {
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
  get listenerCount() {
    return this.listeners.size;
  }
}

/** A point at which a test holds an operation: `reached` says the operation is there, `release` lets it go. */
export function gate() {
  let release!: () => void;
  let reach!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    reached,
    release,
    pass: async (): Promise<void> => {
      reach();
      await open;
    },
  };
}
export type Gate = ReturnType<typeof gate>;

/** What is held, by the number of the call (1 is the first): a listing, a native open before it starts, a native open after it finished. */
export interface Holds {
  listing?: Record<number, Gate>;
  before?: Record<number, Gate>;
  landed?: Record<number, Gate>;
}

export async function setup(
  options: {
    seeded?: boolean;
    holds?: Holds;
    /**
     * `false`: the opener never asks `permit` (an implementation that does not, or the point of the creating upgrade being out of its
     * reach): only the checks `openAccountData` makes before it starts the creating open stand between a changed fact and a creation.
     */
    honourPermit?: boolean;
    /** The opener lets go of its handles and FAILS (`StoreFailure("closed")`) once its native open has finished: the real opener's reaction to a closure. */
    failAfterLanded?: boolean;
  } = {},
) {
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("P");
  page.identity.account = A;
  if (options.seeded !== false) {
    const seeded = await page.open(A, { create: true });
    if (seeded.kind !== "opened") throw new Error("setup: no database");
    seeded.store.close();
  }
  const identity = new Cell<Identity | null>({
    account_id: A,
    epoch: 1,
    session_id: "s1",
  });
  const holds = options.holds ?? {};
  const calls = { listings: 0, opens: 0 };
  const host: DatabaseHost = {
    ...page.host,
    list: async () => {
      calls.listings += 1;
      await holds.listing?.[calls.listings]?.pass();
      return page.host.list();
    },
  };
  const opener: EngineOpener = {
    open: async (account, openOptions) => {
      calls.opens += 1;
      const call = calls.opens;
      await holds.before?.[call]?.pass();
      const opened = await page.opener.open(
        account,
        options.honourPermit === false
          ? { ...openOptions, permit: undefined }
          : openOptions,
      );
      await holds.landed?.[call]?.pass();
      if (options.failAfterLanded === true) {
        if (opened.kind === "opened") opened.store.close();
        throw new StoreFailure("closed");
      }
      return opened;
    },
  };
  const openDeps: OpenDeps = { ...page.openDeps, host, opener };
  const events: Array<[string, unknown]> = [];
  /** A runtime over the page's registry. `honour: false` is an implementation of `open` that never looks at `abandoned`. */
  const runtime = (honour = true): DataRuntime =>
    new DataRuntime({
      identity,
      persistence: unorderedPersistence,
      registry: page.registry,
      open: (account, openOptions) =>
        openAccountData(
          openDeps,
          account,
          honour ? openOptions : { create: openOptions.create },
        ),
      trace: { emit: (event, data) => events.push([event, data]) },
    });
  /**
   * A runtime whose `open` is the bare opener: no `openAccountData`, so no lifetime check of its own and no refusals. It is the stand-in
   * for any implementation of `RuntimeDeps.open` that does not look at the registry's closures, and shows that the RUNTIME holds the
   * invariant on its own (R37, revision 21).
   */
  const rawRuntime = (): DataRuntime =>
    new DataRuntime({
      identity,
      persistence: unorderedPersistence,
      registry: page.registry,
      open: async (account, openOptions) => {
        const opened = await opener.open(account, {
          create: openOptions.create,
          incarnation: "raw-incarnation",
        });
        return opened;
      },
      trace: { emit: (event, data) => events.push([event, data]) },
    });
  const published = () =>
    events.filter(([event]) => event === "data.epoch_published").length;
  /** What a runtime that is gone must hold: nothing. */
  const held = (rt: DataRuntime) => ({
    connections: page.registry.openCount(A),
    service: rt.serviceFor(A)?.live ?? false,
    published: published(),
    latch: page.registry.latch(A),
  });
  return {
    world,
    page,
    identity,
    calls,
    openDeps,
    runtime,
    rawRuntime,
    held,
    events,
    published,
  };
}

export type PendingWorld = Awaited<ReturnType<typeof setup>>;

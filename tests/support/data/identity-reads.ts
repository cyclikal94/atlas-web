import type { AccountService } from "../../../src/data/engine/account-service";
import type { ReadResult } from "../../../src/data/engine/identity-task";
import type { AccountId } from "../../../src/data/model/types";
import { EPOCH_BASE } from "../session/env";
import type { FakeIdb } from "./fake-idb";
import { ACCOUNT, type PageWorld } from "./page-world";

/**
 * What the profile source, the device mirror and `followIdentity` need of a page, over the page world: connectivity as a flag and an
 * `online` event, the account's service appearing (the database opens late, or another tab creates it), and timers on the world's
 * clock (so a back-off is delivered by `advance`, and nothing is delivered by a bare `settle`). `service` is the world's one open
 * service, or none (`database: false`, or before `openDatabase()`).
 *
 * `database: false` models a controller that is STILL LOOKING for the account's database (its runtime is loading, or the database is
 * being opened): `databasePending` is true until `openDatabase()` (it opened) or `findNoDatabase()` (it looked and there is none).
 * `binding: "absent"` starts from the second: a database that genuinely does not exist.
 */
export interface IdentityReadWorld {
  state: { online: boolean; database: boolean; pending: boolean };
  online(): boolean;
  onOnline(listener: () => void): () => void;
  onService(listener: () => void): () => void;
  service(account: AccountId): AccountService | null;
  /** True while the page has not finished looking for the account's database. */
  databasePending(account: AccountId): boolean;
  clock: { now(): number; random(): number };
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** The browser comes back: the flag turns true and the `online` event fires. */
  goOnline(): void;
  /** The browser loses connectivity (no event the data layer listens to). */
  goOffline(): void;
  /** The database opens: the service is available and the controller's service store notifies. */
  openDatabase(): void;
  /** The page has finished looking and there is no database: nothing is pending any more, and the readers are told. */
  findNoDatabase(): void;
  /** Timers set and not yet fired or cleared. */
  pendingTimers(): number;
  /** The world's time, in ms since the world began. */
  time(): number;
}

export function identityReadWorld(
  w: PageWorld,
  options: {
    database?: boolean;
    random?: number;
    /** With `database: false`: the database is being looked for (the default), or it genuinely does not exist. */
    binding?: "pending" | "absent";
  } = {},
): IdentityReadWorld {
  const world = w.env.world;
  const state = {
    online: true,
    database: options.database !== false,
    pending: options.database === false && options.binding !== "absent",
  };
  const onlineListeners = new Set<() => void>();
  const serviceListeners = new Set<() => void>();
  const cancelled = new Set<number>();
  const pending = new Set<number>();
  let seq = 0;
  return {
    state,
    online: () => state.online,
    onOnline(listener) {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    onService(listener) {
      serviceListeners.add(listener);
      return () => {
        serviceListeners.delete(listener);
      };
    },
    service: (account) =>
      state.database && account === ACCOUNT ? w.service : null,
    databasePending: (account) => state.pending && account === ACCOUNT,
    clock: {
      now: () => EPOCH_BASE + world.time,
      random: () => options.random ?? 0.5,
    },
    timers: {
      setTimeout(fn, ms) {
        seq += 1;
        const id = seq;
        pending.add(id);
        world.schedule(
          "timer",
          "A",
          { timer: id },
          () => {
            pending.delete(id);
            if (!cancelled.has(id)) fn();
          },
          ms,
        );
        return id;
      },
      clearTimeout(handle) {
        cancelled.add(handle as number);
        pending.delete(handle as number);
      },
    },
    goOnline() {
      state.online = true;
      for (const listener of [...onlineListeners]) listener();
    },
    goOffline() {
      state.online = false;
    },
    openDatabase() {
      state.database = true;
      state.pending = false;
      for (const listener of [...serviceListeners]) listener();
    },
    findNoDatabase() {
      state.pending = false;
      for (const listener of [...serviceListeners]) listener();
    },
    pendingTimers: () => pending.size,
    time: () => world.time,
  };
}

/**
 * Counts the transactions the plans run, by name, without changing any of them (an injection whose `match` only records and never
 * matches): how a test says that a healthy read wrote nothing, or that a loop did not write.
 */
export function watchTransactions(idb: FakeIdb): {
  count(label: string): number;
  stop(): void;
} {
  const labels: string[] = [];
  const stop = idb.inject({
    match: (tx) => {
      labels.push(tx.label);
      return false;
    },
    mode: "error",
  });
  return {
    count: (label) => labels.filter((entry) => entry === label).length,
    stop,
  };
}

/** The classified answers a script of `readMe` or `currentDeviceId` can give. */
export const ok = <T>(value: T): ReadResult<T> => ({ kind: "ok", value });
export const failed: ReadResult<never> = { kind: "failure" };
export const unrecognised: ReadResult<never> = { kind: "unrecognised" };
export const notSent: ReadResult<never> = { kind: "not_sent" };
export const closed: ReadResult<never> = { kind: "closed" };

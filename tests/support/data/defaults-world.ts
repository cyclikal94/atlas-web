import type { ReadResult } from "../../../src/data/engine/identity-task";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../../src/data/engine/quota-guard";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { SyncStateRow } from "../../../src/data/model/types";
import { createDataEnv } from "../../../src/data/ui/env";
import type { Identity, Persistence, Store } from "../../../src/session";
import { EPOCH_BASE } from "../session/env";
import { DataTestWorld } from "./env";

/**
 * The production data controller, runtime, plans and defaults source (WEB-12a) over the double of IndexedDB, with the real asynchronous
 * binding and a scripted `GET /defaults/snapshot`. FIXTURE evidence: the platform is a double and no backend is involved.
 */
export const ACCOUNT = "11111111-1111-4111-8111-111111111111";
export const OTHER = "99999999-9999-4999-8999-999999999999";
export const DB = accountDatabaseName(ACCOUNT);

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
    return () => {
      this.listeners.delete(l);
    };
  }
}

export interface DefaultsWorldOptions {
  database?: boolean;
  online?: boolean;
  epoch?: number;
  /** A value written into `sync_state.defaults` before the page starts. */
  persisted?: unknown;
  /** Each read waits for `release` instead of answering from `answers`. */
  hold?: boolean;
  answers?: ReadResult<unknown>[];
  /** No `readDefaultsSnapshot` dependency at all. */
  noReader?: boolean;
  quota?: QuotaGuard;
  /** The session's persistence hold (G5); default: never stale. */
  persistence?: Persistence;
}

export async function defaultsWorld(options: DefaultsWorldOptions = {}) {
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  const epoch = options.epoch ?? 1;
  const identity = new Cell<Identity | null>({
    account_id: ACCOUNT,
    epoch,
    session_id: "s",
  });
  page.identity.account = ACCOUNT;
  page.identity.epoch = epoch;
  const create = async () => {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    await world.settle();
    if (options.persisted !== undefined) {
      const sync = world.idb.peek(
        DB,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      world.idb.seed(DB, "sync_state", [
        { ...sync, defaults: options.persisted },
      ]);
    }
  };
  if (options.database !== false) await create();
  const runtime = new world.modules.accountService.DataRuntime({
    identity,
    persistence:
      options.persistence ?? world.modules.accountService.unorderedPersistence,
    registry: page.registry,
    open: (account, o) => page.open(account, o),
  });
  const online = new Cell(options.online !== false);
  const onlineListeners = new Set<() => void>();
  const asked: Array<[string, number]> = [];
  const answers: ReadResult<unknown>[] = [...(options.answers ?? [])];
  const held: Array<(result: ReadResult<unknown>) => void> = [];
  const cancelled = new Set<number>();
  let seq = 0;
  const now = () => EPOCH_BASE + world.world.time;
  const env = createDataEnv({
    identity,
    loadRuntime: async () => runtime,
    online,
    quota:
      options.quota ??
      createQuotaGuard({
        storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
        now,
      }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: {
      iso: () => new Date(now()).toISOString(),
      now,
      random: () => 0.5,
    },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    ...(options.noReader
      ? {}
      : {
          readDefaultsSnapshot: async (account: string, e: number) => {
            asked.push([account, e]);
            if (options.hold)
              return new Promise<ReadResult<unknown>>((resolve) => {
                held.push(resolve);
              });
            return answers.shift() ?? { kind: "failure" };
          },
        }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: (l) => {
      onlineListeners.add(l);
      return () => {
        onlineListeners.delete(l);
      };
    },
    timers: {
      setTimeout: (fn, ms) => {
        seq += 1;
        const id = seq;
        world.world.schedule(
          "timer",
          "A",
          { timer: id },
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
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await world.settle();
  };
  const advance = async (ms: number) => {
    await world.world.advance(ms);
    await settle();
  };
  return {
    world,
    page,
    identity,
    env,
    online,
    asked,
    answers,
    held,
    release: (result: ReadResult<unknown>) => held.shift()?.(result),
    settle,
    advance,
    create,
    now,
    goOnline() {
      online.set(true);
      for (const l of [...onlineListeners]) l();
    },
    stored: () =>
      (
        world.idb.peek(DB, "sync_state", "singleton") as
          | SyncStateRow
          | undefined
      )?.defaults ?? null,
    databaseExists: () =>
      world.idb.peek(DB, "sync_state", "singleton") !== undefined,
  };
}

/**
 * A MINIMAL model of the raw IndexedDB API that the origin's quota ledger (`createIdbLedger`) uses, with the one property it relies on:
 * read-write transactions on a database run ONE AFTER ANOTHER, whichever connection began them, so a get and a put inside one transaction
 * are atomic across pages. Several `createIdbLedger` instances over one `RawIdb` are several pages of one origin.
 *
 * It models the contract the ledger needs, not the browser: the real engines have their own real-engine specs. Failures are injected by
 * name (`failOpen`, `failTransaction`, `abortNext`), and what was asked of it is recorded (`transactions`, `closed`, `opens`).
 */
interface Database {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  /** The tail of the read-write transactions: a new one begins when the one before it has finished. */
  lock: Promise<void>;
}

export interface RawIdb {
  factory: IDBFactory;
  /** The record stored under `key` in `store` of `name`, as a structured clone would give it. */
  record(name: string, store: string, key: string): unknown;
  /** Replaces a record behind the ledger's back (a damaged one). */
  put(name: string, store: string, key: string, value: unknown): void;
  opens: number;
  closed: number;
  transactions: Array<{ mode: string; durability: unknown }>;
  failOpen: number;
  failTransaction: number;
  /** The next read-write transaction aborts before it completes. */
  abortNext: number;
  /** Fires `versionchange` at every open connection (another page upgrades or deletes the database). */
  versionChange(name: string): void;
  /** A request that is never answered: the next open never fires. */
  stallOpen: number;
}

const clone = <T>(value: T): T =>
  value === undefined ? value : (structuredClone(value) as T);

export function rawIdb(): RawIdb {
  const databases = new Map<string, Database>();
  const connections = new Map<string, Set<{ fire(): void }>>();
  const state: RawIdb = {
    opens: 0,
    closed: 0,
    transactions: [],
    failOpen: 0,
    failTransaction: 0,
    abortNext: 0,
    stallOpen: 0,
    record: (name, store, key) =>
      clone(databases.get(name)?.stores.get(store)?.get(key)),
    put(name, store, key, value) {
      databases.get(name)?.stores.get(store)?.set(key, clone(value));
    },
    versionChange(name) {
      for (const connection of [...(connections.get(name) ?? [])])
        connection.fire();
    },
    factory: undefined as unknown as IDBFactory,
  };

  const later = (fn: () => void): void => {
    queueMicrotask(fn);
  };

  state.factory = {
    open(name: string, version?: number) {
      state.opens += 1;
      const request: Record<string, unknown> = {
        result: undefined,
        error: null,
      };
      if (state.stallOpen > 0) {
        state.stallOpen -= 1;
        return request as unknown as IDBOpenDBRequest;
      }
      later(() => {
        if (state.failOpen > 0) {
          state.failOpen -= 1;
          request.error = new Error("open failed");
          (request.onerror as (() => void) | undefined)?.();
          return;
        }
        let database = databases.get(name);
        const created = database === undefined;
        if (database === undefined) {
          database = {
            version: version ?? 1,
            stores: new Map(),
            lock: Promise.resolve(),
          };
          databases.set(name, database);
        }
        const db = database;
        let open = true;
        const handle: Record<string, unknown> = {
          objectStoreNames: {
            contains: (store: string) => db.stores.has(store),
          },
          createObjectStore(store: string) {
            db.stores.set(store, new Map());
            return {};
          },
          close() {
            if (!open) return;
            open = false;
            state.closed += 1;
            connections.get(name)?.delete(entry);
          },
          onversionchange: null,
          onclose: null,
          transaction(
            storeName: string,
            mode: IDBTransactionMode,
            options?: { durability?: unknown },
          ) {
            if (!open) throw new Error("the connection is closed");
            if (state.failTransaction > 0) {
              state.failTransaction -= 1;
              throw new Error("transaction failed");
            }
            state.transactions.push({
              mode,
              durability: options?.durability,
            });
            const store = db.stores.get(storeName) as Map<string, unknown>;
            // The transaction sees the store as it is when IT begins (a read-write one waits for the one before it), not when it was asked for.
            let staging = new Map<string, unknown>();
            const tx: Record<string, unknown> = {
              error: null,
              abort() {
                aborted = true;
              },
              objectStore: () => ({
                get(key: string) {
                  const req: Record<string, unknown> = { result: undefined };
                  reads.push(() => {
                    req.result = clone(staging.get(key));
                    (req.onsuccess as (() => void) | undefined)?.();
                  });
                  return req;
                },
                put(value: unknown, key: string) {
                  staging.set(key, clone(value));
                },
              }),
            };
            let aborted = false;
            const reads: Array<() => void> = [];
            const begin = mode === "readwrite" ? db.lock : Promise.resolve();
            const finished = begin.then(async () => {
              staging = new Map(store);
              await Promise.resolve();
              for (const read of reads) read();
              await Promise.resolve();
              if (aborted || (mode === "readwrite" && state.abortNext > 0)) {
                if (!aborted && mode === "readwrite") state.abortNext -= 1;
                tx.error = new Error("the transaction aborted");
                (tx.onabort as (() => void) | undefined)?.();
                return;
              }
              if (mode === "readwrite")
                for (const [key, value] of staging) store.set(key, value);
              (tx.oncomplete as (() => void) | undefined)?.();
            });
            if (mode === "readwrite") db.lock = finished;
            return tx as unknown as IDBTransaction;
          },
        };
        const entry = {
          fire: () => (handle.onversionchange as (() => void) | null)?.(),
        };
        const set = connections.get(name) ?? new Set();
        set.add(entry);
        connections.set(name, set);
        request.result = handle;
        if (created) (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return state;
}

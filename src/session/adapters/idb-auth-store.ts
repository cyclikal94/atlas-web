import { initialAuthState, validateAuthState } from "../model/records";
import type {
  AccountId,
  AuthRecords,
  BootRecord,
  DeviceRecord,
  PendingDeletion,
} from "../model/types";
import {
  type AuthStore,
  type Durability,
  type PendingTransaction,
  type Rmw,
  StoreError,
  type StoreErrorCause,
} from "../ports/store";

/**
 * The production `AuthStore`: raw IndexedDB, one database `atlas-auth`, version 1, one object store `records` with
 * out-of-line keys `auth_state`, `device`, `boot` and `pending_deletions:<account_id>` (decision D-01). No wrapper
 * library sits between the protocol and the transaction: the ordering arguments (Ex1, Theorems 1 to 5) rest on
 * IndexedDB's transaction-creation order and on when `complete` fires, and both stay visible here.
 *
 * `transact` creates its transaction SYNCHRONOUSLY, so creation order is call order. The body runs once, in the success
 * callback of the reads issued at creation, on records IndexedDB has just cloned for it; its writes go into the same
 * transaction, so a transaction commits atomically or not at all.
 */
export const AUTH_DATABASE = "atlas-auth";
export const AUTH_STORE = "records";
export const AUTH_DATABASE_VERSION = 1;
const PENDING_PREFIX = "pending_deletions:";

export interface OpenAuthStoreOptions {
  /** `indexedDB` in production. */
  factory?: Pick<IDBFactory, "open">;
  /** The database was closed under us (`versionchange` or an abnormal close). Later transactions reject `closed`. */
  onClosed?: (reason: "versionchange" | "close") => void;
}

export interface OpenedAuthStore extends AuthStore {
  close(): void;
}

/** Why the database could not be opened, for the compatibility screen and the read-failure card. */
export class AuthStoreOpenError extends Error {
  constructor(
    readonly reason: "unavailable" | "blocked" | "error",
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "AuthStoreOpenError";
  }
}

export function openAuthStore(
  options: OpenAuthStoreOptions = {},
): Promise<OpenedAuthStore> {
  const factory =
    options.factory ??
    (typeof indexedDB === "undefined" ? undefined : indexedDB);
  if (!factory) return Promise.reject(new AuthStoreOpenError("unavailable"));
  return new Promise<OpenedAuthStore>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(AUTH_DATABASE, AUTH_DATABASE_VERSION);
    } catch (error) {
      reject(new AuthStoreOpenError("error", String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_STORE))
        db.createObjectStore(AUTH_STORE);
    };
    // `blocked` is not success: the open stays pending until the other connection closes (or the caller gives up).
    request.onerror = () => {
      reject(new AuthStoreOpenError("error", request.error?.name ?? "unknown"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_STORE)) {
        db.close();
        reject(new AuthStoreOpenError("error", "missing object store"));
        return;
      }
      resolve(createStore(db, options.onClosed));
    };
  });
}

function createStore(
  db: IDBDatabase,
  onClosed: OpenAuthStoreOptions["onClosed"],
): OpenedAuthStore {
  let closed = false;
  const markClosed = (reason: "versionchange" | "close") => {
    if (closed) return;
    closed = true;
    onClosed?.(reason);
  };
  // A newer page wants to upgrade (or the browser dropped the connection): close at once so it is never blocked by
  // us, and fail every later transaction with `closed`. The kernel retries and the page shows the read-failure card
  // until it is reloaded.
  db.onversionchange = () => {
    db.close();
    markClosed("versionchange");
  };
  db.onclose = () => markClosed("close");

  return {
    transact<T>(
      body: (records: Readonly<AuthRecords>) => Rmw<T>,
      options?: { durability?: Durability; label?: string },
    ): PendingTransaction<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const complete = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A caller that does not await `complete` (a fire-and-forget recording) must not raise an unhandled rejection.
      complete.catch(() => undefined);
      if (closed) {
        reject(new StoreError("closed"));
        return { complete };
      }
      let tx: IDBTransaction;
      try {
        // An unknown `durability` member is ignored by an engine that does not implement it.
        tx = db.transaction(AUTH_STORE, "readwrite", {
          durability: options?.durability ?? "default",
        });
      } catch (error) {
        const closedNow =
          error instanceof DOMException && error.name === "InvalidStateError";
        if (closedNow) markClosed("close");
        reject(new StoreError(closedNow ? "closed" : "error"));
        return { complete };
      }
      const store = tx.objectStore(AUTH_STORE);
      let outcome: Rmw<T> | undefined;
      let failure: unknown;

      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      valuesRequest.onsuccess = () => {
        try {
          const keys = keysRequest.result as IDBValidKey[];
          const values = valuesRequest.result as unknown[];
          const read = assemble(keys, values);
          if (read === "corrupt") {
            failure = new StoreError("corrupt");
            tx.abort();
            return;
          }
          outcome = body(read.records);
          if (outcome.write) write(store, outcome.write, read.pendingKeys);
        } catch (error) {
          // A throwing body is a defect; abort so nothing half-applied is committed, and surface the defect.
          failure = error;
          try {
            tx.abort();
          } catch {
            // already finished
          }
        }
      };
      tx.oncomplete = () => {
        if (outcome) resolve(outcome.result);
        else reject(new StoreError("error"));
      };
      tx.onabort = () => {
        if (failure !== undefined) reject(failure);
        else reject(new StoreError(causeOf(tx.error)));
      };
      tx.onerror = () => {
        // The transaction aborts after this; `onabort` settles the promise.
      };
      return { complete };
    },
    close() {
      closed = true;
      db.close();
    },
  };
}

function causeOf(error: DOMException | null): StoreErrorCause {
  if (!error) return "abort";
  if (error.name === "QuotaExceededError") return "quota";
  if (error.name === "AbortError") return "abort";
  return "error";
}

interface Assembled {
  records: AuthRecords;
  /** The keys of `pending_deletions:*` records that exist now, so a write can delete the ones that are gone. */
  pendingKeys: string[];
}

/**
 * Builds the records the body sees. A missing `auth_state` is the initial record; a PRESENT but malformed one is
 * "corrupt" and the transaction is aborted without writing: a reset would discard fences and unresolved
 * leases, and a page that cannot read its record must fail closed (EC-02).
 */
function assemble(
  keys: readonly IDBValidKey[],
  values: readonly unknown[],
): Assembled | "corrupt" {
  let authState: unknown;
  let device: unknown = null;
  let boot: unknown = null;
  const pending: Record<AccountId, PendingDeletion> = {};
  const pendingKeys: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = values[index];
    if (typeof key !== "string") continue;
    if (key === "auth_state") authState = value;
    else if (key === "device") device = value;
    else if (key === "boot") boot = value;
    else if (key.startsWith(PENDING_PREFIX)) {
      const account = key.slice(PENDING_PREFIX.length);
      if (!validPending(value, account)) return "corrupt";
      pending[account] = value;
      pendingKeys.push(key);
    }
  }
  const state =
    authState === undefined ? initialAuthState() : validateAuthState(authState);
  if (state === null) return "corrupt";
  if (device !== null && !validDevice(device)) return "corrupt";
  if (boot !== null && !validBoot(boot)) return "corrupt";
  return {
    records: {
      auth_state: state,
      device: device as DeviceRecord | null,
      boot: boot as BootRecord | null,
      pending_deletions: pending,
    },
    pendingKeys,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validDevice = (value: unknown): value is DeviceRecord =>
  isObject(value) &&
  typeof value.device_id === "string" &&
  value.device_id.length > 0;
const validBoot = (value: unknown): value is BootRecord =>
  isObject(value) && typeof value.last_boot_at === "string";
const validPending = (
  value: unknown,
  account: string,
): value is PendingDeletion =>
  isObject(value) &&
  value.account_id === account &&
  typeof value.operation_id === "string" &&
  typeof value.status === "string";

function write(
  store: IDBObjectStore,
  changes: Partial<AuthRecords>,
  existingPendingKeys: readonly string[],
): void {
  if (changes.auth_state !== undefined)
    store.put(changes.auth_state, "auth_state");
  if (changes.device !== undefined) {
    if (changes.device === null) store.delete("device");
    else store.put(changes.device, "device");
  }
  if (changes.boot !== undefined) {
    if (changes.boot === null) store.delete("boot");
    else store.put(changes.boot, "boot");
  }
  if (changes.pending_deletions !== undefined) {
    // The write replaces the whole map: put every entry, delete those that are gone.
    const keep = new Set<string>();
    for (const [account, entry] of Object.entries(changes.pending_deletions)) {
      const key = `${PENDING_PREFIX}${account}`;
      keep.add(key);
      store.put(entry, key);
    }
    for (const key of existingPendingKeys)
      if (!keep.has(key)) store.delete(key);
  }
}

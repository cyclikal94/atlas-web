import {
  accountDatabaseName,
  KEY_PATHS,
  type StoreName,
} from "../model/schema";
import type { AccountId } from "../model/types";
import { classifyFailure } from "./failure";
import {
  type AccountStore,
  type Decision,
  type KeyRange,
  type Plan,
  type Reader,
  StoreFailure,
  type Watchable,
  type Write,
} from "./port";

/**
 * THE RECOVERY CONNECTION (WEB-14a revision 1, R7; WEB-04 design 8, "old code writing into a newer, already-upgraded schema"). When another
 * tab's newer build has upgraded an account's database, this page's code never opens it for ordinary use again (D-P8: the account is latched
 * `upgrade_pending`, and every open is refused). The one exception the design makes is the person's unfinished form: the old code may still
 * save, restore, list and discard its `form_recovery` copies through a FRESH connection opened after the upgrade, because that store has a
 * binding forward-compatible contract (its key path `[form_context, tab_instance_id]` and its `form_context` index never change in a way an
 * old-shaped row would not satisfy, and any field a newer schema adds is optional from the reader's side).
 *
 * What this store is, and is not:
 *  - It runs ONLY the W9 recovery plans (`ALLOWED`) and only over `form_recovery` and the `sync_state` singleton (which carries the
 *    incarnation, `closing` and the writer-generation counter those plans guard with). Any other plan is refused before anything is opened:
 *    it is not a way back into the account's data.
 *  - Every `run` opens a new connection WITHOUT a version (so it never upgrades, and it opens whatever version the database now has, after
 *    any upgrade in progress), checks that the two stores are there with the contract's key paths and index (a database that does not keep
 *    the contract fails, like any failed local write: the form stays in memory, WEB-04 8), runs the plan in one transaction, and closes. A
 *    `versionchange` closes it at once, so it never blocks another tab's upgrade or deletion. A database that is not there is never created.
 *  - The plans keep their own guards inside the transaction: the incarnation (INC: a database deleted and re-created since is refused),
 *    `closing` (CLS: nothing is written once a sign-out's wipe is under way) and the order of captures (`writer_gen`, `capture_seq`). The
 *    caller's `admitted()` (the account is still latched `upgrade_pending`, not closed for a deletion or an identity change, and still the
 *    displayed one) is asked before the connection is opened and again inside the transaction before anything is written.
 *  - The quota reserve is the port's, as for any recovery write.
 */
export const RECOVERY_PLANS = [
  "data.claimFormWriter",
  "data.saveFormRecovery",
  "data.loadFormRecovery",
  "data.listFormRecovery",
] as const;
const ALLOWED = new Set<string>(RECOVERY_PLANS);
const SCOPE = new Set<StoreName>(["form_recovery", "sync_state"]);

export interface RecoveryStoreDeps {
  account: AccountId;
  /** The incarnation of the database this page last had open: the plans refuse another (INC). */
  incarnationId: string;
  /** Whether a recovery write may begin now (the account is latched `upgrade_pending` and is still the displayed one). */
  admitted(): boolean;
  factory?: IDBFactory;
}

const sameKeyPath = (actual: string | string[] | null, expected: unknown) =>
  JSON.stringify(actual) === JSON.stringify(expected);

/** Whether a database keeps the recovery contract: the two stores, their key paths, and the `form_context` index. */
function keepsContract(db: IDBDatabase): boolean {
  if (
    !db.objectStoreNames.contains("form_recovery") ||
    !db.objectStoreNames.contains("sync_state")
  )
    return false;
  try {
    const tx = db.transaction(["form_recovery", "sync_state"], "readonly");
    const recovery = tx.objectStore("form_recovery");
    const sync = tx.objectStore("sync_state");
    const ok =
      sameKeyPath(recovery.keyPath, KEY_PATHS.form_recovery) &&
      sameKeyPath(sync.keyPath, KEY_PATHS.sync_state) &&
      recovery.indexNames.contains("form_context") &&
      sameKeyPath(recovery.index("form_context").keyPath, "form_context");
    tx.abort();
    return ok;
  } catch {
    return false;
  }
}

/** Opens the account's database at whatever version it has, never creating or upgrading it. */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      // No version was asked for, so an upgrade means the database did not exist: abort the creating upgrade (the engine discards it).
      try {
        request.transaction?.abort();
      } catch {
        // Already aborted.
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(new StoreFailure("absent"));
    request.onblocked = () => undefined;
  });
}

const requestOf = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const toRange = (range: KeyRange): IDBKeyRange | null => {
  if (range.kind === "all") return null;
  if (range.kind === "only") return IDBKeyRange.only(range.value);
  const { lower, upper, lowerOpen, upperOpen } = range;
  if (lower !== undefined && upper !== undefined)
    return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return null;
};

const unsupported = (): never => {
  throw new StoreFailure("error");
};

/** The reader of one recovery transaction: `get` and an index range (with `limit` and `offset`), which is all the W9 plans read. */
function makeReader(tx: IDBTransaction): Reader {
  const inScope = (store: StoreName): IDBObjectStore => {
    if (!SCOPE.has(store)) throw new StoreFailure("error");
    return tx.objectStore(store);
  };
  return {
    get: async (store, key) =>
      (await requestOf(inScope(store).get(key as IDBValidKey))) as never,
    bulkGet: unsupported,
    async byIndex(store, index, range, limit, offset) {
      const source = inScope(store).index(index);
      const rows: unknown[] = [];
      const cursor = source.openCursor(toRange(range));
      let skipped = (offset ?? 0) === 0;
      await new Promise<void>((resolve, reject) => {
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return resolve();
          if (!skipped) {
            skipped = true;
            at.advance(offset ?? 0);
            return;
          }
          rows.push(at.value);
          if (limit !== undefined && rows.length >= limit) return resolve();
          at.continue();
        };
      });
      return rows as never;
    },
    anyOf: unsupported,
    pageByKey: unsupported,
    list: unsupported,
    count: unsupported,
  };
}

async function applyWrite(tx: IDBTransaction, write: Write): Promise<void> {
  if (!SCOPE.has(write.store) || write.op !== "put")
    throw new StoreFailure("error");
  await requestOf(tx.objectStore(write.store).put(write.row));
}

export function createRecoveryStore(deps: RecoveryStoreDeps): AccountStore {
  const factory =
    deps.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
  const name = accountDatabaseName(deps.account);
  let closed = false;
  return {
    account: deps.account,
    incarnationId: deps.incarnationId,
    async run<I, R, O>(plan: Plan<I, R, O>, input: I): Promise<O> {
      // Not a way back into the account's data: only the recovery plans, only over their two stores, and no streaming apply.
      if (
        !ALLOWED.has(plan.name) ||
        plan.apply !== undefined ||
        plan.scope.some((store) => !SCOPE.has(store))
      )
        throw new StoreFailure("error");
      if (closed || !factory || !deps.admitted())
        throw new StoreFailure("closed");
      let db: IDBDatabase;
      try {
        db = await openExisting(factory, name);
      } catch (error) {
        throw classifyFailure(error);
      }
      try {
        if (!keepsContract(db)) throw new StoreFailure("error");
        if (!deps.admitted()) throw new StoreFailure("closed");
        const tx = db.transaction([...plan.scope], plan.mode, {
          durability: plan.durability === "strict" ? "strict" : "default",
        });
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error ?? new StoreFailure("abort"));
          tx.onerror = () => undefined;
        });
        // A transaction that ends early (an abort) must not leave its completion unhandled.
        done.catch(() => undefined);
        let result: O;
        try {
          const reads = await plan.read(makeReader(tx), input);
          const decision: Decision<O> = plan.decide(reads, input);
          if (plan.mode === "readonly") {
            if (decision.writes.length > 0) throw new StoreFailure("error");
          } else {
            // In the transaction, before anything is written: the account may have been closed for a deletion meanwhile.
            if (!deps.admitted()) throw new StoreFailure("closed");
            for (const write of decision.writes) await applyWrite(tx, write);
          }
          result = decision.result;
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // Already finished.
          }
          throw error;
        }
        await done;
        return result;
      } catch (error) {
        throw classifyFailure(error);
      } finally {
        db.close();
      }
    },
    watch<I, R, O>(_plan: Plan<I, R, O>, _input: I): Watchable<O> {
      // Nothing watches through the recovery connection: it exists only for the person's save, restore and discard.
      return {
        get: () => ({ status: "unavailable", reason: "closed" }),
        subscribe: () => () => undefined,
      };
    },
    close() {
      closed = true;
    },
  };
}

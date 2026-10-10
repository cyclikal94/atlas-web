import Dexie, { liveQuery, type Table, type Transaction } from "dexie";
import { commandKindOf } from "../model/outbox";
import {
  accountDatabaseName,
  DEXIE_SCHEMA,
  DEXIE_SCHEMA_V1,
  KEY_PATHS,
  SCHEMA_VERSION,
  type StoreName,
} from "../model/schema";
import { initialSyncState } from "../model/sync-state";
import type { AccountId, SyncStateRow } from "../model/types";
import { classifyFailure } from "./failure";
import type { EngineOpener } from "./open";
import {
  type AccountStore,
  type Decision,
  type Key,
  type KeyRange,
  type Loadable,
  type OpenResult,
  type Plan,
  type Reader,
  type RunOptions,
  StoreFailure,
  type Watchable,
  type Write,
  type WriteSink,
} from "./port";
import type { ConnectionRegistry } from "./registry";

/**
 * The Dexie adapter (plan 5.1, decisions D-01 to D-03): the ONLY file that imports `dexie` (lint rule R14).
 *
 * Every Dexie instance is constructed with `autoOpen: false`, and `versionchange` is handled by OUR subscriber, registered so
 * it runs first (Dexie runs the last-subscribed handler first and stops at `false`), which latches the account, closes every
 * connection with `disableAutoOpen: true`, reports the closure and returns `false`. Dexie's own default handler closes with
 * `disableAutoOpen: false`, so a later query would silently RE-CREATE a database that another tab had just deleted; with the
 * auto-open disabled and the latch set, a late writer gets `StoreFailure("closed")` instead.
 */
class CreateRefused extends Error {
  constructor() {
    super("the database does not exist and may not be created here");
    this.name = "CreateRefused";
  }
}

const NAMES = (error: unknown): string[] => {
  const names: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const named = current as {
      name?: unknown;
      inner?: unknown;
      failures?: unknown;
    };
    if (typeof named.name === "string") names.push(named.name);
    // A `BulkError` (`bulkPut`, `bulkDelete`) carries the failures of its operations: what went wrong is in them.
    if (Array.isArray(named.failures))
      for (const failure of named.failures)
        if (typeof (failure as { name?: unknown })?.name === "string")
          names.push((failure as { name: string }).name);
    current = named.inner;
  }
  return names;
};

/** Maps any error from Dexie or a plan to the closed set of failure causes (shared with the double: `failure.ts`). */
export const toStoreFailure = classifyFailure;

type AnyTable = Table<object, Key>;

/**
 * Where tables come from. INSIDE a plan this is ALWAYS the `Transaction` object, never the `Dexie` instance: a table taken from
 * `trans.table(...)` is bound to that transaction explicitly, whereas `db.table(...)` finds its transaction through Dexie's
 * implicit "zone", which is LOST after an `await` of anything that is not a Dexie promise. A table that lost its zone silently
 * opens its OWN transaction: the page's chunks were then eight independent commits, and the page's own transaction ended empty
 * (`PrematureCommitError`). The real-engine suite found exactly that; the double of IndexedDB cannot show it.
 */
interface TableSource {
  table(name: string): unknown;
}

function tableOf(source: TableSource, name: StoreName): AnyTable {
  return source.table(name) as AnyTable;
}

function collectionFor(table: AnyTable, index: string, range: KeyRange) {
  if (range.kind === "all") return table.orderBy(index);
  const where = table.where(index);
  if (range.kind === "only") return where.equals(range.value as never);
  const { lower, upper, lowerOpen, upperOpen } = range;
  if (lower !== undefined && upper !== undefined)
    return where.between(
      lower as never,
      upper as never,
      !lowerOpen,
      !upperOpen,
    );
  if (lower !== undefined)
    return lowerOpen
      ? where.above(lower as never)
      : where.aboveOrEqual(lower as never);
  if (upper !== undefined)
    return upperOpen
      ? where.below(upper as never)
      : where.belowOrEqual(upper as never);
  return table.orderBy(index);
}

function makeReader(db: TableSource): Reader {
  return {
    async get(store, key) {
      return (await tableOf(db, store).get(key as never)) as never;
    },
    async bulkGet(store, keys) {
      return (await tableOf(db, store).bulkGet(keys as never[])) as never;
    },
    async byIndex(store, index, range, limit, offset) {
      let collection = collectionFor(tableOf(db, store), index, range);
      if (offset !== undefined && offset > 0)
        collection = collection.offset(offset);
      return (await (limit === undefined
        ? collection.toArray()
        : collection.limit(limit).toArray())) as never;
    },
    async anyOf(store, index, keys, limit) {
      if (keys.length === 0) return [] as never;
      const collection = tableOf(db, store)
        .where(index)
        .anyOf(keys as never[]);
      return (await (limit === undefined
        ? collection.toArray()
        : collection.limit(limit).toArray())) as never;
    },
    async pageByKey(store, index, key, { after, match, limit }) {
      const keyPath = KEY_PATHS[store];
      if (typeof keyPath !== "string")
        throw new Error(`pageByKey needs a string primary key: ${store}`);
      let collection = tableOf(db, store)
        .where(index)
        .equals(key as never);
      // Equal index keys come back in primary-key order, so "after" and "match" are filters on the walk, applied inside the store: a
      // row that does not pass is never returned, and the walk stops once `limit` rows have.
      if (after !== undefined || match !== undefined)
        collection = collection.and((row) => {
          const fields = row as Record<string, unknown>;
          if (after !== undefined && !((fields[keyPath] as string) > after))
            return false;
          if (match !== undefined)
            for (const [field, value] of Object.entries(match))
              if (fields[field] !== value) return false;
          return true;
        });
      return (await collection.limit(limit).toArray()) as never;
    },
    async list(store, limit) {
      const table = tableOf(db, store);
      return (await (limit === undefined
        ? table.toArray()
        : table.limit(limit).toArray())) as never;
    },
    async count(store, index, range) {
      const table = tableOf(db, store);
      // No index: the rows of the store. With an index: that index's ENTRIES in the range (`all` included), so a row that has no
      // key in a nested or optional index is not counted.
      if (!index) return table.count();
      return collectionFor(table, index, range ?? { kind: "all" }).count();
    },
  };
}

function makeSink(db: TableSource): WriteSink {
  return {
    async put(store, row) {
      await tableOf(db, store).put(row as object);
    },
    async delete(store, key) {
      await tableOf(db, store).delete(key as never);
    },
    async bulkPut(store, rows) {
      if (rows.length > 0) await tableOf(db, store).bulkPut(rows as object[]);
    },
    async bulkDelete(store, keys) {
      if (keys.length > 0) await tableOf(db, store).bulkDelete(keys as never[]);
    },
  };
}

async function applyWrite(db: TableSource, write: Write): Promise<void> {
  const table = tableOf(db, write.store);
  switch (write.op) {
    case "put":
      await table.put(write.row);
      return;
    case "bulkPut":
      await table.bulkPut(write.rows as object[]);
      return;
    case "delete":
      await table.delete(write.key as never);
      return;
    case "bulkDelete":
      await table.bulkDelete(write.keys as never[]);
      return;
    case "clear":
      await table.clear();
      return;
  }
}

class DexieAccountStore implements AccountStore {
  private closed = false;
  constructor(
    readonly account: AccountId,
    readonly incarnationId: string,
    private readonly strict: Dexie,
    private readonly fast: Dexie,
    private readonly registry: ConnectionRegistry,
    private readonly unregister: () => void,
  ) {}

  private dbFor(plan: Pick<Plan<never, never, never>, "durability">): Dexie {
    return plan.durability === "strict" ? this.strict : this.fast;
  }

  private assertOpen(db: Dexie): void {
    // The latch is per ACCOUNT: a wipe, an identity change or an upgrade closes every connection of this page.
    if (
      this.closed ||
      this.registry.latch(this.account) !== "open" ||
      !db.isOpen()
    )
      throw new StoreFailure("closed");
  }

  async run<I, R, O>(
    plan: Plan<I, R, O>,
    input: I,
    options: RunOptions = {},
  ): Promise<O> {
    const db = this.dbFor(plan);
    this.assertOpen(db);
    const { signal } = options;
    // A signal that has already fired never creates a transaction.
    if (signal?.aborted) throw new StoreFailure("abort");
    const tables = plan.scope.map((name) => tableOf(db, name));
    const mode = plan.mode === "readonly" ? "r" : "rw";
    // The signal ends the transaction wherever it is: not yet started (queued behind another one: the wait that has no other
    // deadline), reading, applying, or waiting to commit. `abort` takes effect at once and nothing of it is ever durable. A
    // transaction that is already COMMITTING refuses (`InvalidStateError`) and completes, and `run` then reports its real outcome,
    // which is what a caller that keeps a lock until `run` has settled needs. The listener is kept until `run` settles, not until
    // the body returns: a transaction whose body has finished can still be aborted until it starts to commit.
    //
    // A transaction that `abort` has ended is reported AT ONCE, not when the engine delivers its `abort` event: Chromium delivers it
    // promptly, but Firefox and WebKit deliver the event of a transaction that is still waiting in the queue only when the one in
    // front of it has finished (the real-engine conformance case C-14 found exactly that), and a caller that must know it is over
    // (the persistence hold gives up its lock on it) cannot wait for the transaction it just cancelled to be dequeued. Nothing of an
    // aborted transaction can commit, so there is nothing left to wait for.
    let started = null as Transaction | null;
    let rejectAborted: ((failure: StoreFailure) => void) | null = null;
    const ended = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = (): void => {
      try {
        started?.abort();
        if (started !== null) rejectAborted?.(new StoreFailure("abort"));
      } catch {
        // Committing or finished: it completes (or has completed) and `run` reports that.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const running = db.transaction(mode, tables, async (trans) => {
        started = trans;
        // The signal fired between this call and the start of the body (Dexie enters the scope in a later microtask): there is
        // no transaction to abort yet, so the body refuses, which aborts the transaction before anything is read or written.
        if (signal?.aborted) throw new StoreFailure("abort");
        // A transaction that was queued behind another one can start AFTER this page's identity left the account (IndexedDB
        // lets a pending transaction finish once the connection is closed). The latch is page memory, so this is a hint
        // (it is never the authority), but it stops this page's own late commit from running.
        this.assertOpen(db);
        const reads = await plan.read(makeReader(trans), input);
        const decision: Decision<O> = plan.decide(reads, input);
        if (plan.mode === "readwrite") this.assertOpen(db);
        if (plan.mode === "readonly") {
          // A readonly plan that returns writes is a programming error: refuse it rather than drop its writes silently
          // (the conformance suite found the adapter did, while the double refused).
          if (decision.writes.length > 0) throw new StoreFailure("error");
          return decision.result;
        }
        for (const write of decision.writes) await applyWrite(trans, write);
        if (plan.apply)
          return await plan.apply(
            makeSink(trans),
            decision,
            reads,
            input,
            makeReader(trans),
          );
        return decision.result;
      });
      // The transaction's own rejection, when `abort` already reported it, is not an unhandled one.
      running.catch(() => undefined);
      return await Promise.race([running, ended]);
    } catch (error) {
      throw toStoreFailure(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  watch<I, R, O>(plan: Plan<I, R, O>, input: I): Watchable<O> {
    const db = this.dbFor(plan);
    let state: Loadable<O> = { status: "loading" };
    const listeners = new Set<() => void>();
    let subscription: { unsubscribe(): void } | null = null;
    const publish = (next: Loadable<O>): void => {
      state = next;
      for (const listener of [...listeners]) listener();
    };
    const start = (): void => {
      if (this.closed || this.registry.latch(this.account) !== "open") {
        publish({ status: "unavailable", reason: "closed" });
        return;
      }
      const tables = plan.scope.map((name) => tableOf(db, name));
      subscription = liveQuery(() =>
        db.transaction("r", tables, async (trans) => {
          const reads = await plan.read(makeReader(trans), input);
          return plan.decide(reads, input).result;
        }),
      ).subscribe({
        next: (value) => publish({ status: "ready", value }),
        error: (error: unknown) =>
          publish({
            status: "unavailable",
            reason:
              toStoreFailure(error).cause === "closed" ? "closed" : "error",
          }),
      });
    };
    return {
      get: () => state,
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) start();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            subscription?.unsubscribe();
            subscription = null;
          }
        };
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unregister();
    for (const db of [this.strict, this.fast]) {
      try {
        db.close({ disableAutoOpen: true });
      } catch {
        // Closing is best effort and never throws.
      }
    }
  }
}

/**
 * The version 1 to 2 upgrade (decision D-23): a draft's command moves from its row in `drafts` to a row in `draft_commands`, and
 * the header gains its derived `kind`. One draft at a time inside the upgrade transaction, so a store of large imports is never
 * held in memory whole. A row that has no `command` (already split) is left alone, so the step is safe to repeat.
 */
async function moveDraftCommands(tx: Transaction): Promise<void> {
  const drafts = tx.table("drafts");
  const bodies = tx.table("draft_commands");
  const keys = (await drafts.toCollection().primaryKeys()) as string[];
  for (const key of keys) {
    const row = (await drafts.get(key)) as
      | (Record<string, unknown> & { endpoint?: string })
      | undefined;
    if (row === undefined || !("command" in row)) continue;
    const { command, ...header } = row;
    await bodies.put({ local_id: key, command });
    await drafts.put({
      ...header,
      kind: commandKindOf(
        command as Record<string, never>,
        String(header.endpoint ?? ""),
      ),
    });
  }
}

export interface DexieOpenerDeps {
  registry: ConnectionRegistry;
  /** A connection closed because of another tab's `versionchange` (a deletion or an upgrade): the data runtime reports it. */
  onVersionChange?(account: AccountId, kind: "deleted" | "upgraded"): void;
}

export function createDexieOpener(deps: DexieOpenerDeps): EngineOpener {
  return {
    async open(account, options): Promise<OpenResult> {
      const name = accountDatabaseName(account);
      let created = false;
      // Whether THIS open's own `populate` hook refused to create the database (R12, revision 11). Dexie runs that hook only inside
      // the upgrade that creates the database (old version 0), so the flag is the one proof that the database did not exist: an open
      // request that failed for any other reason, an `AbortError` included, says nothing about whether it exists.
      let refusedCreation = false;
      // Whether this call has returned its store. `permit` belongs to the creating upgrade of THIS open: a later reopening of one of these
      // handles (what a stale handle does when something removes the adapter's defences) is not a creation anyone asked this call for, and
      // is governed by those defences alone.
      let finished = false;
      // THE LIFETIME OF THIS OPEN (R37, revision 21): a closure of the account on this page after this point ends it.
      const born = deps.registry.generation(account);
      const lifetimeEnded = (): boolean =>
        deps.registry.generation(account) !== born;
      const instances: Dexie[] = [];
      // Every connection this open acquires is in the registry from the moment it exists, so `registry.closeAll` (a wipe, a deletion, a
      // latch) closes it wherever the open is: waiting for its second connection, seeding the singleton, or about to return. A connection
      // that only joined the registry when the whole open was over escaped every closure that came before, and blocked the deletion that
      // sent it.
      const registrations: Array<() => void> = [];
      const adopt = (db: Dexie): void => {
        registrations.push(
          deps.registry.register(account, {
            close: () => db.close({ disableAutoOpen: true }),
          }),
        );
      };
      const make = (
        durability: "strict" | "default",
        mayCreate: boolean,
      ): Dexie => {
        const db = new Dexie(name, {
          autoOpen: false,
          chromeTransactionDurability: durability,
        });
        db.version(1).stores({ ...DEXIE_SCHEMA_V1 });
        db.version(SCHEMA_VERSION)
          .stores({ ...DEXIE_SCHEMA })
          .upgrade(moveDraftCommands);
        db.on("populate", (tx: Transaction) => {
          // Runs inside the versionchange transaction that CREATES the database. A refusal aborts it: the engine discards the new
          // database, so an open that was not allowed to create can never leave one behind (E-W2). The caller's `permit` is the
          // may-create predicate read at this very boundary (R36): a fact that changed while the request was queued refuses here.
          if (!mayCreate || (!finished && options.permit?.() === false)) {
            refusedCreation = true;
            throw new CreateRefused();
          }
          created = true;
          // Seeded in the creating transaction: a database that exists is never seen without its singleton.
          return tx
            .table("sync_state")
            .add(initialSyncState(options.incarnation));
        });
        // Registered AFTER Dexie's own default, so it runs first; returning false stops the default.
        db.on("versionchange", (event: IDBVersionChangeEvent) => {
          const deleted = event.newVersion === null;
          const latch = deleted ? "closed_for_deletion" : "upgrade_pending";
          // An engine may deliver the event to BOTH of this page's connections (WebKit does; Chromium and Firefox close the
          // second before its event): report the closure once.
          const first = deps.registry.latch(account) !== latch;
          // Every connection this open has acquired is in the registry (see `adopt`), so this closes all of them, the one that received
          // the event included.
          deps.registry.closeAll(account, { latch });
          if (first)
            deps.onVersionChange?.(account, deleted ? "deleted" : "upgraded");
          return false;
        });
        instances.push(db);
        return db;
      };
      /** Lets go of everything this open acquired: its registry entries and its connections. Idempotent. */
      const release = (): void => {
        for (const off of registrations.splice(0)) off();
        for (const db of instances) {
          try {
            db.close({ disableAutoOpen: true });
          } catch {
            // best effort
          }
        }
      };
      /** The open stops where a closure ended its lifetime: its handles are let go and it fails, whatever it was waiting for. */
      const endedByClosure = (): StoreFailure => {
        release();
        return new StoreFailure("closed");
      };

      // ABSENT only when our own refusal ended the open, however the engine words the abort of the creating upgrade (`CreateRefused`,
      // or an `AbortError` in some engines). Every other failure is a failure and is reported as one (R12, revision 11): an aborted
      // open request is not proof that the database is missing, and `absent` is read as "nothing to close, nothing to fence, an empty
      // digest, no retry budget to find" by every caller (the closing gate, the consent digest, the identity reads).
      const refused = (error: unknown): boolean =>
        refusedCreation || NAMES(error).includes("CreateRefused");

      const strict = make("strict", options.create);
      try {
        await strict.open();
      } catch (error) {
        // A closure outranks whatever the engine says about the request it interrupted.
        if (lifetimeEnded()) throw endedByClosure();
        release();
        if (refused(error)) return { kind: "absent" };
        throw toStoreFailure(error);
      }
      adopt(strict);
      if (lifetimeEnded()) throw endedByClosure();
      const fast = options.single ? strict : make("default", false);
      try {
        if (!options.single) await fast.open();
      } catch (error) {
        if (lifetimeEnded()) throw endedByClosure();
        release();
        // The second connection refuses the same way when the database was deleted between the two opens.
        if (refused(error)) return { kind: "absent" };
        throw toStoreFailure(error);
      }
      if (fast !== strict) adopt(fast);
      if (lifetimeEnded()) throw endedByClosure();

      // A database that exists without its singleton can only mean external damage: re-seed IN PLACE (fresh incarnation,
      // `cache_status: "empty"`) and never delete anything, so retained drafts survive.
      let incarnation = options.incarnation;
      try {
        incarnation = await strict.transaction(
          "rw",
          [tableOf(strict, "sync_state")],
          async () => {
            const table = tableOf(strict, "sync_state");
            const existing = (await table.get("singleton" as never)) as
              | SyncStateRow
              | undefined;
            if (existing) return existing.incarnation_id;
            await table.put(initialSyncState(options.incarnation));
            return options.incarnation;
          },
        );
      } catch (error) {
        if (lifetimeEnded()) throw endedByClosure();
        release();
        throw toStoreFailure(error);
      }
      if (lifetimeEnded()) throw endedByClosure();

      const store = new DexieAccountStore(
        account,
        incarnation,
        strict,
        fast,
        deps.registry,
        () => {
          for (const off of registrations.splice(0)) off();
        },
      );
      finished = true;
      return { kind: "opened", store, created };
    },
  };
}

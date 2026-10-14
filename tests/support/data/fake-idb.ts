import {
  advanceComposition,
  advancesComposition,
} from "../../../src/data/model/composition";
import {
  accountDatabaseName,
  KEY_PATHS,
  type RowOf,
  STORE_NAMES,
  type StoreName,
} from "../../../src/data/model/schema";
import { initialSyncState } from "../../../src/data/model/sync-state";
import type { AccountId, SyncStateRow } from "../../../src/data/model/types";
import { classifyFailure } from "../../../src/data/store/failure";
import type { DatabaseHost, ProbeResult } from "../../../src/data/store/host";
import type { EngineOpener } from "../../../src/data/store/open";
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
} from "../../../src/data/store/port";
import type { ConnectionRegistry } from "../../../src/data/store/registry";
import type { World } from "../session/world";
import {
  compareKeys,
  indexKeysOf,
  indexSpec,
  inRange,
  keyString,
  primaryKeyOf,
} from "./keys";

/**
 * The IndexedDB double for the data layer (plan 5.1.1, decision D-01 of the 08a plan, validated by the conformance suite
 * and the real-engine runs). It is NOT IndexedDB: it models the properties the protocol depends on, deterministically:
 *
 * - transactions on one database run in CREATION ORDER, one at a time, and a transaction sees exactly the committed effects of
 *   every earlier-created one (a stronger schedule than IndexedDB allows, never a weaker one);
 * - a transaction is atomic: its writes are applied to the database only at commit, and any failure rolls everything back;
 * - every row is structured-cloned on the way in and the way out, so no page shares a live object;
 * - `versionchange` reaches every open connection on a delete, a connection closes only when its transactions have finished,
 *   and a delete that finds a connection still open is BLOCKED until it closes;
 * - faults are injectable per predicate (`abort`, `error`, `quota`, `closed`, `pending`, `pending_blocking`,
 *   `commit_then_lose_completion`, `stall_commit`, and a throw at the n-th write);
 * - `stall_commit` is the other half of "a completion that has not been delivered": the transaction has finished its body and is
 *   COMMITTING (an `abort` is refused, as `IDBTransaction.abort()` refuses one) but its data is NOT durable yet. Later transactions
 *   queue behind it. `completeStalled` makes it durable and delivers its completion; `failStalled` ends it without effect, as an
 *   engine does when a commit fails (a quota or an I/O error). `commit_then_lose_completion` and a withheld `D0` are the first half:
 *   the data IS durable and only the event is missing. A page cannot tell the two apart, which is the point of having both;
 * - `RunOptions.signal` ends a transaction that has not finished, as `IDBTransaction.abort()` does: one still in the queue leaves it
 *   (and its connection stops counting it), one that is stuck or whose body is awaiting is rolled back at once (an overlay that is
 *   simply never merged), and one that has COMMITTED is beyond it (the completion is still delivered, or lost, as the knobs say).
 *
 * Time is the 08a `World`: the start of a transaction and the delivery of its completion are events with delay knobs.
 */
export type InjectMode =
  | "abort"
  | "error"
  | "quota"
  | "closed"
  | "pending"
  | "pending_blocking"
  | "commit_then_lose_completion"
  | "stall_commit"
  | { kind: "throw_on_write"; n: number; as: "error" | "quota" | "alloc" };

export interface TxInfo {
  page: string;
  account: AccountId;
  label: string;
  durability: "strict" | "default";
  mode: "readonly" | "readwrite";
  order: number;
}
export interface Injection {
  match: (tx: TxInfo) => boolean;
  mode: InjectMode;
  times?: number;
}

const clone = <T>(value: T): T => structuredClone(value);

interface Entry {
  key: Key;
  row: object;
}
type Table = Map<string, Entry>;

interface Tx {
  info: TxInfo;
  connection: FakeConnection;
  plan: Plan<unknown, unknown, unknown>;
  input: unknown;
  mode: InjectMode | null;
  /** The page's latch, consulted when the body runs (the double's counterpart of the adapter's in-transaction check). */
  isOpen: () => boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  dropped?: boolean;
  /** `RunOptions.signal` fired while the transaction had not finished: it never commits. */
  aborted?: boolean;
  /** The body has begun (`execute`): an abort now is observed at the body's next checkpoint. */
  begun?: boolean;
  /** Committed, failed or aborted: the transaction is over, and a late abort changes nothing (it is committing or complete). */
  over?: boolean;
  /** The body is finished and the engine is committing: an abort is refused, and the data is not durable until `completeStalled`. */
  committing?: boolean;
}

/** A `stall_commit` transaction, waiting for the engine to finish (or fail) its commit. */
interface StalledCommit {
  tx: Tx;
  commit(): void;
  fail(cause: "abort" | "error" | "quota"): void;
}

class FakeConnection {
  closing = false;
  /** Transactions created on this connection that have not finished. */
  active = 0;
  constructor(
    readonly db: FakeDatabase,
    readonly page: string,
    readonly durability: "strict" | "default",
    /** What the page's own handler does on `versionchange` (the adapter's: latch, close, report). */
    public onVersionChange: (newVersion: number | null) => void,
  ) {}
  get fullyClosed(): boolean {
    return this.closing && this.active === 0;
  }
  close(): void {
    this.closing = true;
    this.db.afterConnectionChange();
  }
}

class FakeDatabase {
  readonly tables = new Map<StoreName, Table>();
  readonly connections = new Set<FakeConnection>();
  queue: Tx[] = [];
  running: Tx | null = null;
  stuck: Tx | null = null;
  /** The transaction that is committing and not yet durable (`stall_commit`). */
  stalled: StalledCommit | null = null;
  /** Deletes waiting for every connection to close. */
  waitingDeletes: Array<() => void> = [];
  constructor(
    readonly name: string,
    readonly world: World,
    readonly owner: FakeIdb,
  ) {
    for (const store of STORE_NAMES) this.tables.set(store, new Map());
  }

  table(store: StoreName): Table {
    return this.tables.get(store) as Table;
  }

  afterConnectionChange(): void {
    this.owner.settleDeletes(this);
  }
}

export class FakeIdb {
  readonly databases = new Map<string, FakeDatabase>();
  private counter = 0;
  private injections: Injection[] = [];
  private listeners = new Set<
    (db: string, stores: ReadonlySet<StoreName>, page: string) => void
  >();
  /** Set a test hook that runs between `list()` and the open that follows (the database vanishing in between). */
  beforeOpen: ((name: string) => void) | null = null;
  /** `indexedDB.databases()` is unsupported (the call rejects). */
  listUnsupported = false;
  /** Make the next `list()` calls fail with this error. */
  listError: Error | null = null;
  /** Make `probe` fail, or never answer until its time-out. */
  probeMode: "ok" | "fail" | "hang" = "ok";
  /** Make `delete` answer `error`. */
  deleteError = false;
  /**
   * What the plans READ, per store: the rows returned to a plan's `read` (every row of a `get`, a `bulkGet`, an index range or a list)
   * and, when `measureBytes` is on, their serialised size. Counts and key-only index entries are not rows read. It is how a test
   * asserts that a read is bounded: that it touched this many rows, and none of a store it had no business in.
   */
  readonly reads = {
    rows: new Map<string, number>(),
    bytes: new Map<string, number>(),
    /**
     * The most rows ONE read call returned, per store: what a plan holds at once while it works through a population in windows. A
     * cumulative count says how much was read in all; this says how much was ever in hand together.
     */
    maxBatch: new Map<string, number>(),
    reset(): void {
      this.rows.clear();
      this.bytes.clear();
      this.maxBatch.clear();
    },
  };
  /** Measure the bytes of every row read (a JSON length: it is a comparison figure, not the engine's). */
  measureBytes = false;
  /**
   * Called synchronously when a put has CLONED its row, which is where the native `IDBObjectStore.put` returns: the interval the real
   * adapter leaves open is between one write of a transaction and the next (R39, revision 22; see `applyWrites`). A test installs it to run
   * caller code, or to queue some, exactly there.
   */
  afterPut: ((store: StoreName, key: Key) => void) | null = null;
  /** Every `deleteDatabase` requested, for assertions that a repair never deletes. */
  readonly deleteRequests: string[] = [];
  /**
   * When true the world is driven automatically after every request (the conformance suite, which wants natural asynchronous
   * behaviour). Scenario tests leave it false and drive the world explicitly, so they control every delivery.
   */
  autoDrive = false;
  private pumping = false;

  /** @internal */
  pump(): void {
    if (!this.autoDrive || this.pumping) return;
    this.pumping = true;
    void this.world.runUntilIdle().finally(() => {
      this.pumping = false;
      if (this.world.pendingCount() > 0) this.pump();
    });
  }

  constructor(readonly world: World) {}

  // ---- faults and inspection ----------------------------------------------------------------------------------------
  inject(injection: Injection): () => void {
    this.injections.push(injection);
    return () => {
      this.injections = this.injections.filter((entry) => entry !== injection);
    };
  }
  clearInjections(): void {
    this.injections = [];
  }
  private modeFor(info: TxInfo): InjectMode | null {
    for (const injection of this.injections) {
      if (injection.times !== undefined && injection.times <= 0) continue;
      if (injection.match(info)) {
        if (injection.times !== undefined) injection.times -= 1;
        return injection.mode;
      }
    }
    return null;
  }

  /** The committed contents of a database (rows sorted by primary key), for byte-for-byte comparisons. */
  snapshot(name: string): Record<string, object[]> | null {
    const db = this.databases.get(name);
    if (!db) return null;
    const out: Record<string, object[]> = {};
    for (const store of STORE_NAMES) {
      out[store] = [...db.table(store).values()]
        .sort((a, b) => compareKeys(a.key, b.key))
        .map((entry) => clone(entry.row));
    }
    return out;
  }
  has(name: string): boolean {
    return this.databases.has(name);
  }
  /** Direct, non-transactional access for arranging a scenario (never used by the code under test). */
  seed<K extends StoreName>(
    name: string,
    store: K,
    rows: readonly RowOf<K>[],
  ): void {
    const db = this.databases.get(name);
    if (!db) throw new Error(`no database ${name}`);
    for (const row of rows) {
      let stored = row as object;
      // A test draft is written as the header AND its body together (`draftRow()`); the store holds them apart (decision D-23),
      // so a draft that carries a `command` is split here, exactly as the enqueue plan writes it.
      if (store === "drafts" && "command" in (row as object)) {
        const { command, ...header } = row as Record<string, unknown>;
        const body = { local_id: header.local_id, command };
        const bodyKey = primaryKeyOf("draft_commands", body);
        db.table("draft_commands").set(keyString(bodyKey), {
          key: bodyKey,
          row: clone(body),
        });
        stored = header;
      }
      const key = primaryKeyOf(store, stored);
      db.table(store).set(keyString(key), { key, row: clone(stored) });
    }
  }
  /** Direct, non-transactional removal of every row of one store, for arranging a scenario (a page cleared an overlay). */
  clearStore(name: string, store: StoreName): void {
    const db = this.databases.get(name);
    if (!db) throw new Error(`no database ${name}`);
    db.table(store).clear();
  }
  peek<K extends StoreName>(
    name: string,
    store: K,
    key: Key,
  ): RowOf<K> | undefined {
    const entry = this.databases.get(name)?.table(store).get(keyString(key));
    return entry ? (clone(entry.row) as RowOf<K>) : undefined;
  }
  /** Creates a database that exists WITHOUT its singleton (external damage). */
  createDamaged(account: AccountId): void {
    this.databases.set(
      accountDatabaseName(account),
      new FakeDatabase(accountDatabaseName(account), this.world, this),
    );
  }
  /** Removes a database as if another browser profile action did it, with no versionchange. */
  vanish(name: string): void {
    this.databases.delete(name);
  }
  openConnections(name: string): number {
    const db = this.databases.get(name);
    return db ? [...db.connections].filter((c) => !c.closing).length : 0;
  }
  /** Ends a `pending_blocking` transaction without effect (its page gave up on it), so later transactions can start. */
  releaseStuck(name: string): boolean {
    const db = this.databases.get(name);
    const stuck = db?.stuck;
    if (!db || !stuck) return false;
    db.stuck = null;
    stuck.reject(new StoreFailure("abort"));
    stuck.connection.active -= 1;
    db.running = null;
    db.afterConnectionChange();
    this.kick(db);
    return true;
  }
  /** Whether a `stall_commit` transaction of this database is committing and not yet durable. */
  hasStalledCommit(name: string): boolean {
    return this.databases.get(name)?.stalled != null;
  }
  /** The engine finishes the stalled commit: the data becomes durable now and the completion is delivered (as the knobs say). */
  completeStalled(name: string): boolean {
    const db = this.databases.get(name);
    const stalled = db?.stalled;
    if (!db || !stalled) return false;
    db.stalled = null;
    stalled.commit();
    this.pump();
    return true;
  }
  /** The engine's commit fails: nothing of the transaction is durable, and the caller hears of the failure. */
  failStalled(
    name: string,
    cause: "abort" | "error" | "quota" = "error",
  ): boolean {
    const db = this.databases.get(name);
    const stalled = db?.stalled;
    if (!db || !stalled) return false;
    db.stalled = null;
    stalled.fail(cause);
    this.pump();
    return true;
  }
  /** A destroyed page: the platform closes its connections. */
  destroyPage(page: string): void {
    for (const db of this.databases.values())
      for (const connection of db.connections)
        if (connection.page === page) connection.close();
  }
  onCommit(
    listener: (
      db: string,
      stores: ReadonlySet<StoreName>,
      page: string,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- the two ports, as one page sees them -------------------------------------------------------------------------
  hostForPage(page: string): DatabaseHost {
    return {
      list: () =>
        new Promise<readonly string[]>((resolve, reject) => {
          if (this.listUnsupported) {
            reject(new Error("indexedDB.databases() is not available"));
            return;
          }
          const error = this.listError;
          this.world.schedule("misc", page, { what: "idb.list" }, () => {
            if (error) reject(error);
            else resolve([...this.databases.keys()]);
          });
          this.pump();
        }),
      probe: (name, timeoutMs) =>
        new Promise<ProbeResult>((resolve, reject) => {
          if (this.probeMode === "hang") {
            this.world.schedule(
              "timer",
              page,
              { what: "idb.probe_timeout" },
              () =>
                reject(
                  new Error("the probe of the account database timed out"),
                ),
              timeoutMs,
            );
            this.pump();
            return;
          }
          this.world.schedule("misc", page, { what: "idb.probe", name }, () => {
            if (this.probeMode === "fail") {
              reject(new Error("probe failed"));
              return;
            }
            const db = this.databases.get(name);
            if (!db) {
              resolve({ kind: "absent" });
              return;
            }
            const row = db.table("sync_state").get(keyString("singleton"))
              ?.row as { incarnation_id?: unknown } | undefined;
            resolve({
              kind: "present",
              incarnation:
                typeof row?.incarnation_id === "string"
                  ? row.incarnation_id
                  : null,
            });
          });
          this.pump();
        }),
      delete: (name) =>
        new Promise((resolve) => {
          this.deleteRequests.push(name);
          this.world.schedule(
            "misc",
            page,
            { what: "idb.delete", name },
            () => {
              if (this.deleteError) {
                resolve("error");
                return;
              }
              const db = this.databases.get(name);
              if (!db) {
                resolve("deleted");
                return;
              }
              let blocked = false;
              const finish = (): void => {
                this.databases.delete(name);
                resolve(blocked ? "blocked_then_deleted" : "deleted");
              };
              // versionchange to every open connection; each page's handler closes its own.
              for (const connection of [...db.connections]) {
                if (connection.closing) continue;
                this.world.schedule(
                  "misc",
                  connection.page,
                  { what: "idb.versionchange", name },
                  () => connection.onVersionChange(null),
                );
              }
              db.waitingDeletes.push(finish);
              // `blocked` is evaluated only AFTER every versionchange has been delivered: a connection that closes in its
              // handler (a normal page) is not blocking; one whose page cannot respond (frozen) still is.
              this.world.schedule(
                "misc",
                page,
                { what: "idb.versionchange_done", name },
                () =>
                  this.settleDeletes(db, () => {
                    blocked = true;
                  }),
              );
            },
          );
          this.pump();
        }),
    };
  }

  /** Runs waiting deletes once every connection is fully closed; reports `blocked` when some are still open. */
  settleDeletes(db: FakeDatabase, onBlocked?: () => void): void {
    if (db.waitingDeletes.length === 0) return;
    const open = [...db.connections].some((c) => !c.fullyClosed);
    if (open) {
      onBlocked?.();
      return;
    }
    const pending = db.waitingDeletes;
    db.waitingDeletes = [];
    for (const finish of pending) finish();
  }

  openerForPage(
    page: string,
    registry: ConnectionRegistry,
    options: {
      onVersionChange?: (
        account: AccountId,
        kind: "deleted" | "upgraded",
      ) => void;
    } = {},
  ): EngineOpener {
    return {
      open: async (account, openOptions): Promise<OpenResult> => {
        const name = accountDatabaseName(account);
        this.beforeOpen?.(name);
        let db = this.databases.get(name);
        let created = false;
        if (!db) {
          if (!openOptions.create) return { kind: "absent" };
          // The creating upgrade is the boundary (R36, revision 21): the real opener asks `permit` inside its `populate` hook, in the
          // versionchange transaction that would create the database, and a refusal aborts it so nothing is left behind.
          if (openOptions.permit?.() === false) return { kind: "absent" };
          db = new FakeDatabase(name, this.world, this);
          const seed = initialSyncState(openOptions.incarnation);
          db.table("sync_state").set(keyString("singleton"), {
            key: "singleton",
            row: clone(seed),
          });
          this.databases.set(name, db);
          created = true;
        }
        const target = db;
        const makeConnection = (
          durability: "strict" | "default",
        ): FakeConnection => {
          const connection = new FakeConnection(
            target,
            page,
            durability,
            (newVersion) => {
              const deleted = newVersion === null;
              const latch = deleted ? "closed_for_deletion" : "upgrade_pending";
              // The real adapter reports a closure once per page, whatever the engine delivers.
              const first = registry.latch(account) !== latch;
              registry.closeAll(account, { latch });
              if (first)
                options.onVersionChange?.(
                  account,
                  deleted ? "deleted" : "upgraded",
                );
            },
          );
          target.connections.add(connection);
          return connection;
        };
        const strict = makeConnection("strict");
        const fast = openOptions.single ? strict : makeConnection("default");
        // A database that exists without its singleton: re-seed IN PLACE.
        let incarnation = openOptions.incarnation;
        const existing = target.table("sync_state").get(keyString("singleton"))
          ?.row as { incarnation_id: string } | undefined;
        if (existing) incarnation = existing.incarnation_id;
        else
          target.table("sync_state").set(keyString("singleton"), {
            key: "singleton",
            row: clone(initialSyncState(incarnation)),
          });
        const unregister = [...new Set([strict, fast])].map((connection) =>
          registry.register(account, { close: () => connection.close() }),
        );
        const store = new FakeAccountStore(
          this,
          account,
          incarnation,
          { strict, default: fast },
          registry,
          () => {
            for (const off of unregister) off();
            strict.close();
            fast.close();
          },
        );
        return { kind: "opened", store, created };
      },
    };
  }

  // ---- transactions -------------------------------------------------------------------------------------------------
  /** @internal */
  create(
    connection: FakeConnection,
    account: AccountId,
    plan: Plan<unknown, unknown, unknown>,
    input: unknown,
    isOpen: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const info: TxInfo = {
      page: connection.page,
      account,
      label: plan.name,
      durability: plan.durability,
      mode: plan.mode,
      order: ++this.counter,
    };
    const mode = this.modeFor(info);
    return new Promise((resolve, reject) => {
      this.world.log({
        type: "idb.create",
        page: info.page,
        label: info.label,
        order: info.order,
        mode: typeof mode === "string" ? mode : (mode?.kind ?? null),
      });
      if (signal?.aborted) {
        // Refused before a transaction exists, as the adapter does.
        reject(new StoreFailure("abort"));
        return;
      }
      if (mode === "pending") {
        // Never runs, never completes, blocks nothing: only a signal ends it.
        signal?.addEventListener(
          "abort",
          () => {
            this.world.schedule(
              "D0",
              info.page,
              { label: info.label, tx: info.order },
              () => reject(new StoreFailure("abort")),
            );
            this.pump();
          },
          { once: true },
        );
        return;
      }
      if (mode === "closed") {
        this.world.schedule(
          "D0",
          info.page,
          { label: info.label, tx: info.order },
          () => reject(new StoreFailure("closed")),
        );
        this.pump();
        return;
      }
      const db = connection.db;
      connection.active += 1;
      const tx: Tx = {
        info,
        connection,
        plan,
        input,
        mode,
        isOpen,
        resolve,
        reject,
      };
      db.queue.push(tx);
      if (signal)
        signal.addEventListener("abort", () => this.abortTx(db, tx), {
          once: true,
        });
      this.kick(db);
      this.pump();
    });
  }

  /** `RunOptions.signal` fired. See the header: what a transaction can still be at this moment, and what each state does. */
  private abortTx(db: FakeDatabase, tx: Tx): void {
    // A transaction that is already COMMITTING refuses (`InvalidStateError`) and completes: its data lands when the engine says.
    if (tx.over || tx.committing) return;
    tx.aborted = true;
    const rejectLater = (): void =>
      this.world.schedule(
        "D0",
        tx.info.page,
        { label: tx.info.label, tx: tx.info.order },
        () => tx.reject(new StoreFailure("abort")),
      );
    // Stuck, or its body has begun (reading, or awaiting something inside `apply`): IndexedDB aborts the transaction at once and the
    // caller hears of it whatever the body is waiting for; the body, if it resumes, stops at its next checkpoint and does nothing.
    if (db.running === tx && (tx.begun || db.stuck === tx)) {
      db.stuck = null;
      tx.over = true;
      tx.connection.active -= 1;
      db.running = null;
      rejectLater();
      db.afterConnectionChange();
      this.kick(db);
      this.pump();
      return;
    }
    if (db.running === tx) {
      // Created and about to start: `start` observes `aborted` and ends it without running the body.
      this.pump();
      return;
    }
    // Still in the queue behind another transaction: it leaves the queue and never runs.
    const at = db.queue.indexOf(tx);
    if (at >= 0) db.queue.splice(at, 1);
    tx.over = true;
    tx.connection.active -= 1;
    rejectLater();
    db.afterConnectionChange();
    this.pump();
  }

  /** @internal */
  kick(db: FakeDatabase): void {
    if (db.running !== null || db.queue.length === 0) return;
    const head = db.queue[0] as Tx;
    db.running = head;
    this.world.schedule(
      "store_start",
      head.info.page,
      { label: head.info.label, tx: head.info.order },
      () => this.start(db, head),
    );
  }

  private finish(db: FakeDatabase, tx: Tx): void {
    tx.over = true;
    tx.connection.active -= 1;
    db.running = null;
    db.afterConnectionChange();
    this.kick(db);
  }

  private start(db: FakeDatabase, tx: Tx): void {
    db.queue.shift();
    if (tx.dropped) {
      this.finish(db, tx);
      return;
    }
    if (tx.aborted) {
      // Aborted after it was created and before its body began: nothing was read or written.
      this.world.schedule(
        "D0",
        tx.info.page,
        { label: tx.info.label, tx: tx.info.order },
        () => tx.reject(new StoreFailure("abort")),
      );
      this.finish(db, tx);
      return;
    }
    if (tx.mode === "pending_blocking") {
      this.world.log({
        type: "idb.stuck",
        page: tx.info.page,
        label: tx.info.label,
        order: tx.info.order,
      });
      db.stuck = tx;
      return;
    }
    const { info } = tx;
    const fail = (error: unknown, cause: string): void => {
      // Already ended (a signal aborted it while its body was awaiting): the caller has been told, and the double is free.
      if (tx.over) return;
      this.world.log({
        type: "idb.fail",
        page: info.page,
        label: info.label,
        order: info.order,
        cause,
      });
      this.world.schedule(
        "D0",
        info.page,
        { label: info.label, tx: info.order },
        () => tx.reject(error),
      );
      this.finish(db, tx);
    };
    if (tx.mode === "abort" || tx.mode === "error" || tx.mode === "quota") {
      fail(new StoreFailure(tx.mode), tx.mode);
      return;
    }
    void this.execute(db, tx, fail);
  }

  private async execute(
    db: FakeDatabase,
    tx: Tx,
    fail: (error: unknown, cause: string) => void,
  ): Promise<void> {
    const { info, plan } = tx;
    tx.begun = true;
    // A checkpoint: an aborted transaction does nothing more (the overlay below is never merged, so nothing was ever written).
    const checkpoint = (): void => {
      if (tx.aborted) throw new StoreFailure("abort");
    };
    const overlay = new Map<StoreName, Map<string, Entry | null>>();
    const cleared = new Set<StoreName>();
    const touched = new Set<StoreName>();
    let writes = 0;
    const throwAt =
      typeof tx.mode === "object" && tx.mode !== null ? tx.mode : null;
    const inScope = (store: StoreName): void => {
      if (!plan.scope.includes(store))
        throw new Error(
          `plan ${plan.name} used ${store}, which is not in its scope`,
        );
    };
    const overlayOf = (store: StoreName): Map<string, Entry | null> => {
      let layer = overlay.get(store);
      if (!layer) {
        layer = new Map();
        overlay.set(store, layer);
      }
      return layer;
    };
    const merged = (store: StoreName): Entry[] => {
      const base = cleared.has(store)
        ? new Map<string, Entry>()
        : new Map(db.table(store));
      for (const [k, entry] of overlay.get(store) ?? [])
        if (entry === null) base.delete(k);
        else base.set(k, entry);
      return [...base.values()];
    };
    const countWrite = (): void => {
      checkpoint();
      writes += 1;
      if (throwAt && writes === throwAt.n) {
        // An allocation failure is a RangeError, which the shared classification maps to its own fixed-shape signal.
        if (throwAt.as === "alloc")
          throw new RangeError("Array buffer allocation failed");
        throw new StoreFailure(throwAt.as);
      }
    };
    const doPut = (store: StoreName, row: object): void => {
      inScope(store);
      countWrite();
      const key = primaryKeyOf(store, row);
      overlayOf(store).set(keyString(key), { key, row: clone(row) });
      touched.add(store);
      this.afterPut?.(store, key);
    };
    const doDelete = (store: StoreName, key: Key): void => {
      inScope(store);
      countWrite();
      overlayOf(store).set(keyString(key), null);
      touched.add(store);
    };
    const lookup = (store: StoreName, key: Key): Entry | undefined => {
      checkpoint();
      const layer = overlay.get(store)?.get(keyString(key));
      if (layer !== undefined) return layer ?? undefined;
      if (cleared.has(store)) return undefined;
      return db.table(store).get(keyString(key));
    };
    const track = (
      store: StoreName,
      rows: readonly (object | undefined)[],
    ): void => {
      const found = rows.filter((row): row is object => row !== undefined);
      this.reads.rows.set(
        store,
        (this.reads.rows.get(store) ?? 0) + found.length,
      );
      this.reads.maxBatch.set(
        store,
        Math.max(this.reads.maxBatch.get(store) ?? 0, found.length),
      );
      if (this.measureBytes)
        this.reads.bytes.set(
          store,
          (this.reads.bytes.get(store) ?? 0) +
            found.reduce((sum, row) => sum + JSON.stringify(row).length, 0),
        );
    };
    const reader: Reader = {
      get: async (store, key) => {
        inScope(store);
        const entry = lookup(store, key);
        track(store, [entry?.row]);
        return (entry ? clone(entry.row) : undefined) as never;
      },
      bulkGet: async (store, keys) => {
        inScope(store);
        const found = keys.map((key) => lookup(store, key));
        track(
          store,
          found.map((entry) => entry?.row),
        );
        return found.map((entry) =>
          entry ? clone(entry.row) : undefined,
        ) as never;
      },
      byIndex: async (store, index, range: KeyRange, limit, offset) => {
        checkpoint();
        inScope(store);
        const spec = indexSpec(store, index);
        const hits: Array<{ ik: Key; pk: Key; row: object }> = [];
        for (const entry of merged(store))
          for (const ik of indexKeysOf(entry.row, spec))
            if (inRange(ik, range))
              hits.push({ ik, pk: entry.key, row: entry.row });
        hits.sort((a, b) => compareKeys(a.ik, b.ik) || compareKeys(a.pk, b.pk));
        const skipped = offset === undefined ? hits : hits.slice(offset);
        const sliced = limit === undefined ? skipped : skipped.slice(0, limit);
        track(
          store,
          sliced.map((hit) => hit.row),
        );
        return sliced.map((hit) => clone(hit.row)) as never;
      },
      anyOf: async (store, index, keys, limit) => {
        checkpoint();
        inScope(store);
        const spec = indexSpec(store, index);
        const hits: Array<{ ik: Key; pk: Key; row: object }> = [];
        for (const entry of merged(store))
          for (const ik of indexKeysOf(entry.row, spec))
            if (keys.some((key) => compareKeys(ik, key) === 0))
              hits.push({ ik, pk: entry.key, row: entry.row });
        hits.sort((a, b) => compareKeys(a.ik, b.ik) || compareKeys(a.pk, b.pk));
        const sliced = limit === undefined ? hits : hits.slice(0, limit);
        track(
          store,
          sliced.map((hit) => hit.row),
        );
        return sliced.map((hit) => clone(hit.row)) as never;
      },
      pageByKey: async (store, index, key, { after, match, limit }) => {
        checkpoint();
        inScope(store);
        const keyPath = KEY_PATHS[store];
        if (typeof keyPath !== "string")
          throw new Error(`pageByKey needs a string primary key: ${store}`);
        const spec = indexSpec(store, index);
        const hits: Array<{ ik: Key; pk: Key; row: object }> = [];
        for (const entry of merged(store))
          for (const ik of indexKeysOf(entry.row, spec))
            if (compareKeys(ik, key) === 0)
              hits.push({ ik, pk: entry.key, row: entry.row });
        hits.sort((a, b) => compareKeys(a.pk, b.pk));
        const passing = hits.filter(({ row }) => {
          const fields = row as Record<string, unknown>;
          if (after !== undefined && !((fields[keyPath] as string) > after))
            return false;
          if (match !== undefined)
            for (const [field, value] of Object.entries(match))
              if (fields[field] !== value) return false;
          return true;
        });
        const sliced = passing.slice(0, limit);
        track(
          store,
          sliced.map((hit) => hit.row),
        );
        return sliced.map((hit) => clone(hit.row)) as never;
      },
      list: async (store, limit) => {
        checkpoint();
        inScope(store);
        const all = merged(store).sort((a, b) => compareKeys(a.key, b.key));
        const taken = limit === undefined ? all : all.slice(0, limit);
        track(
          store,
          taken.map((entry) => entry.row),
        );
        return taken.map((entry) => clone(entry.row)) as never;
      },
      count: async (store, index, range) => {
        checkpoint();
        inScope(store);
        // No index: the rows of the store. With an index: that index's ENTRIES in the range (`all` included), so a row that has no
        // key in a nested or optional index is not counted.
        if (!index) return merged(store).length;
        const spec = indexSpec(store, index);
        const within = range ?? { kind: "all" as const };
        let total = 0;
        for (const entry of merged(store))
          for (const ik of indexKeysOf(entry.row, spec))
            if (inRange(ik, within)) total += 1;
        return total;
      },
    };
    const sink: WriteSink = {
      put: async (store, row) => doPut(store, row as object),
      delete: async (store, key) => doDelete(store, key),
      bulkPut: async (store, rows) => {
        for (const row of rows) doPut(store, row as object);
      },
      bulkDelete: async (store, keys) => {
        for (const key of keys) doDelete(store, key);
      },
    };
    const applyWrite = (write: Write): void => {
      switch (write.op) {
        case "put":
          doPut(write.store, write.row);
          return;
        case "bulkPut":
          for (const row of write.rows) doPut(write.store, row);
          return;
        case "delete":
          doDelete(write.store, write.key);
          return;
        case "bulkDelete":
          for (const key of write.keys) doDelete(write.store, key);
          return;
        case "clear":
          inScope(write.store);
          countWrite();
          cleared.add(write.store);
          overlay.set(write.store, new Map());
          touched.add(write.store);
      }
    };
    try {
      if (!tx.isOpen()) throw new StoreFailure("closed");
      const reads = await plan.read(reader, tx.input);
      const decision: Decision<unknown> = plan.decide(reads, tx.input);
      checkpoint();
      if (plan.mode === "readwrite" && !tx.isOpen())
        throw new StoreFailure("closed");
      let result = decision.result;
      if (plan.mode === "readonly") {
        if (decision.writes.length > 0) throw new StoreFailure("error");
      } else {
        // ONE write at a time with a turn between them, as the native adapter issues them (`await applyWrite(...)` in the Dexie adapter):
        // IndexedDB clones a value when its put is CALLED, so a value the caller still owns can change between one write's clone and
        // the next write's. A double that applied every write in one synchronous step could never show it (R39, revision 22).
        for (const write of decision.writes) {
          applyWrite(write);
          await Promise.resolve();
        }
        if (plan.apply)
          result = await plan.apply(sink, decision, reads, tx.input, reader);
        // The local composition generation, as the Dexie adapter advances it (`model/composition.ts`, WEB-10a revision 3): in THIS
        // transaction, after every write of the plan, when it wrote a store a screen composes from.
        if (advancesComposition(touched, plan.scope)) {
          const sync = (await reader.get("sync_state", "singleton")) as
            | SyncStateRow
            | undefined;
          if (sync !== undefined) doPut("sync_state", advanceComposition(sync));
        }
      }
      // Commit: atomic. From here a signal is too late: the transaction is committing.
      checkpoint();
      const commitNow = (): void => {
        let wrote = false;
        for (const store of touched) {
          const table = db.table(store);
          if (cleared.has(store)) table.clear();
          for (const [k, entry] of overlay.get(store) ?? []) {
            wrote = true;
            if (entry === null) table.delete(k);
            else table.set(k, entry);
          }
          if (cleared.has(store)) wrote = true;
        }
        this.world.log({
          type: "idb.commit",
          page: info.page,
          label: info.label,
          order: info.order,
          wrote,
          durability: info.durability,
        });
        if (touched.size > 0)
          for (const listener of this.listeners)
            listener(db.name, touched, info.page);
        if (tx.mode !== "commit_then_lose_completion")
          this.world.schedule(
            "D0",
            info.page,
            { label: info.label, tx: info.order },
            () => tx.resolve(clone(result)),
          );
        this.finish(db, tx);
      };
      if (tx.mode === "stall_commit") {
        // Committing, not durable: the overlay stays unmerged until the engine finishes. Later transactions wait behind it.
        tx.committing = true;
        this.world.log({
          type: "idb.committing",
          page: info.page,
          label: info.label,
          order: info.order,
        });
        db.stalled = {
          tx,
          commit: commitNow,
          fail: (cause) => fail(new StoreFailure(cause), cause),
        };
        return;
      }
      commitNow();
    } catch (error) {
      const failure = classifyFailure(error);
      fail(failure, failure.cause);
    }
  }
}

class FakeAccountStore implements AccountStore {
  private closed = false;
  constructor(
    private readonly idb: FakeIdb,
    readonly account: AccountId,
    readonly incarnationId: string,
    private readonly connections: {
      strict: FakeConnection;
      default: FakeConnection;
    },
    private readonly registry: ConnectionRegistry,
    private readonly onClose: () => void,
  ) {}

  run<I, R, O>(
    plan: Plan<I, R, O>,
    input: I,
    options: RunOptions = {},
  ): Promise<O> {
    const connection =
      plan.durability === "strict"
        ? this.connections.strict
        : this.connections.default;
    if (
      this.closed ||
      this.registry.latch(this.account) !== "open" ||
      connection.closing
    )
      return Promise.reject(new StoreFailure("closed"));
    return this.idb.create(
      connection,
      this.account,
      plan as never,
      input,
      () => !this.closed && this.registry.latch(this.account) === "open",
      options.signal,
    ) as Promise<O>;
  }

  watch<I, R, O>(plan: Plan<I, R, O>, input: I): Watchable<O> {
    let state: Loadable<O> = { status: "loading" };
    const listeners = new Set<() => void>();
    let off: (() => void) | null = null;
    let generation = 0;
    const publish = (next: Loadable<O>): void => {
      state = next;
      for (const listener of [...listeners]) listener();
    };
    const evaluate = (): void => {
      const mine = ++generation;
      this.run(plan, input).then(
        (value) => {
          if (mine === generation) publish({ status: "ready", value });
        },
        (error: unknown) => {
          if (mine === generation)
            publish({
              status: "unavailable",
              reason:
                error instanceof StoreFailure && error.cause === "closed"
                  ? "closed"
                  : "error",
            });
        },
      );
    };
    return {
      get: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        if (listeners.size === 1) {
          evaluate();
          off = this.idb.onCommit((name, stores) => {
            if (name !== accountDatabaseName(this.account)) return;
            if (plan.scope.some((s) => stores.has(s))) evaluate();
          });
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            off?.();
            off = null;
          }
        };
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

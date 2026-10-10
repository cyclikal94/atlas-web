/**
 * The origin's quota ledger (R28, revision 13): what EVERY page of the origin has promised to write and has just written, kept where
 * every page can read and change it atomically.
 *
 * The browser's free-space estimate is the origin's, but it is read before a write and it can lag behind one that has landed, and a
 * guard held in one page's memory knows nothing of the bytes another page has just been admitted for. Two pages therefore each judged a
 * large save against the same free figure and both were admitted, though the origin could hold only one of them above the floor kept
 * for `atlas-auth`. The remedy is one ledger per origin, and the only store whose read-modify-write is atomic across every page of the
 * origin is IndexedDB: overlapping read-write transactions on one object store run one after another, whichever page began them.
 *
 * What it holds is two numbers and an expiry per entry, nothing else: no account, no content, no identifier of a person. A reservation
 * ("hold") is leased, so a page that dies with one outstanding stops holding the room when the lease ends (or its owner is proven gone);
 * the bytes of writes that have landed are kept for one estimate lifetime, for the same reason the in-page ledger always kept them: the
 * estimate may not show them yet, and then for one more, for the readings of the estimate that began before that lifetime ended and may
 * still be in use (R28, revision 17: a reading is as old as its request, and the entry caps it for as long as it is). The stamps are the
 * wall clock's, the one scale every page reads: an entry that ends further ahead than its lifetime allows is clamped to one lifetime from
 * the look that finds it, never dropped, and a page that finds a step of the clock FORWARDS writes every entry back as just landed
 * (`engine/quota-guard.ts`, `liveAt`). A page that began AFTER an entry was stamped cannot vouch for the stamp's age (a step may lie between
 * the two that it never saw), so it takes the entry to have landed no earlier than its own start and retires it two lifetimes after that, in
 * its own judgement only: nothing about that is written into the record (R28, revision 18). A hold is never merely DELETED by a page other than its writer (R28, revision 16): its writer may have
 * written, or be writing, its bytes, and a lock released or a lease over says nothing of that, so the bytes move from the hold into the
 * landed ledger (`landHold`) and lapse with it. Only the writer's own settlement can say the bytes were not written.
 *
 * Raw IndexedDB belongs to `src/data/store/**` (lint rule R13), which is why this module is here and the guard in `engine/` only
 * receives it.
 */

/** Space promised to a write that has not finished; it ends when the write settles, or when its lease runs out. */
export interface LedgerHold {
  bytes: number;
  /** Absolute instant (ms) at which the hold lapses by itself; `Infinity` for a ledger that cannot outlive its page. */
  until: number;
  /**
   * The hold has an OWNER (R28, revision 15): its writer's page keeps a lock named for the hold's token for as long as the write may
   * still run (`HoldOwners`). An owned hold is NEVER dropped for the want of a renewal: time alone says nothing of a page that is only
   * suspended (its timers do not run, its transaction may be committing), so it is reclaimed only when the owner is PROVEN to have
   * let go. A hold without an owner lapses with its lease, as it always did.
   */
  owned?: boolean;
  /**
   * The free space the hold was judged against (R28, revision 16): what the landed ledger caps a re-read estimate with if this write
   * turns out to have landed. A hold leaves the ledger by its writer's settlement, or else by being RECLAIMED (its owner proven gone, its
   * lease over), and a reclaimed hold is never simply deleted: the writer may have written (or be writing) its bytes, so they move into
   * the landed ledger against this figure, exactly as the writer's own `written` settlement would have put them. `null`: judged on no
   * figure (the estimate was unavailable), so there is nothing to cap. Absent (a hold of an older build): the reclaiming page's own figure.
   */
  base?: number | null;
}

/**
 * The writes that have landed and that the estimate may not show yet: `base` is the free space the first of them was judged against,
 * `landed` the bytes of every one since, `until` the end of the lifetime of the latest. The cap on a re-read estimate is
 * `min(estimate, base - landed)`, so an estimate that does show them is never counted twice. It applies to a reading whose request began
 * before `until` (a request that began after it shows the write), and the entry is retired one further lifetime after `until`, when no
 * such reading can still be judged (R28, revision 17).
 */
export interface LedgerLanded {
  base: number;
  landed: number;
  until: number;
  /**
   * The tokens of the latest holds whose bytes are in `landed` (R28, revision 16), so that a landing is made ONCE per hold: a settlement
   * whose answer was lost and is published again, or a writer that settles a hold another page already reclaimed, counts nothing twice.
   * Bounded (`SETTLED_KEPT`); a token forgotten is at worst counted again, which is the safe direction.
   */
  settled?: readonly string[];
}

/** How many of the latest landings a landed entry remembers by token. */
export const SETTLED_KEPT = 32;

/**
 * The landed ledger after the write of hold `token` (`bytes`, judged against `base`) is taken to have landed at `now`, for one estimate
 * lifetime (`ttlMs`). This is the ONE place a write's bytes enter the landed ledger, whether its writer says so (`settle("written")`)
 * or a page reclaiming the hold does (R28, revision 16: a hold that ends any other way than its writer's settlement is treated as a
 * write that may have landed, never as one that did not). Idempotent per token. A write judged on no figure has nothing to cap: `null`
 * when there is no entry yet to add it to.
 */
export function landHold(
  landed: LedgerLanded | null,
  token: string,
  hold: { bytes: number; base?: number | null },
  now: number,
  ttlMs: number,
  figure: number | null,
): LedgerLanded | null {
  if (landed?.settled?.includes(token) === true) return landed;
  const settled = [...(landed?.settled ?? []), token].slice(-SETTLED_KEPT);
  const until = now + ttlMs;
  if (landed !== null)
    return {
      base: landed.base,
      landed: landed.landed + hold.bytes,
      until,
      settled,
    };
  const base = hold.base === undefined ? figure : hold.base;
  return base === null ? null : { base, landed: hold.bytes, until, settled };
}

export interface LedgerState {
  holds: Record<string, LedgerHold>;
  landed: LedgerLanded | null;
}

export const EMPTY_LEDGER: LedgerState = Object.freeze({
  holds: Object.freeze({}) as Record<string, LedgerHold>,
  landed: null,
});

/** What a change of the ledger answers: the state to store (`null`: leave it) and what the caller learns. */
export interface LedgerChange<T> {
  state: LedgerState | null;
  result: T;
}

export interface OriginLedger {
  /**
   * `true` when entries are shared with other pages (so a hold must carry a lease: the page that made it may die). `false` for a ledger
   * that lives and dies with one realm.
   */
  readonly shared: boolean;
  /**
   * Reads the ledger and lets `change` judge or alter it, ATOMICALLY with respect to every other page that shares it. `change` is
   * synchronous (a transaction ends when nothing is awaited) and must not keep the state it is given. Rejects when the ledger cannot be
   * read or written; the caller then judges without it and says so.
   */
  update<T>(change: (state: LedgerState) => LedgerChange<T>): Promise<T>;
  /** Reads the ledger (no write). */
  peek<T>(read: (state: LedgerState) => T): Promise<T>;
  /**
   * Who may say that a hold is over (R28, revision 15). Present on a ledger that other pages share and that can tell a page that is
   * merely SUSPENDED from one that is gone; absent, holds are reclaimed by their leases alone (a ledger of one realm, or a double).
   */
  readonly owners?: HoldOwners;
  /** Lets go of what the ledger holds open (a connection). The next use opens it again. */
  close(): void;
}

/**
 * The cross-page ownership of a hold. In production a Web Lock named for the token, kept by the writer's page: the platform releases
 * it when the page is destroyed, and the page releases it when the write is over. Nothing here reads another page's state: `claim`
 * is a request that is granted or not, and `released` asks whether a request would be granted now (`ifAvailable`), the one question
 * the lifecycle matrix allows of a lock (a `true` proves the holder let go, a `false` proves nothing and so keeps the hold).
 */
export interface HoldOwners {
  /**
   * Takes the ownership of `token` and keeps it until `release()` (or until the page is gone). Resolves `null` when it could not be
   * taken (the lock manager failed, or the name was already held): the caller then has no owner to rely on and must not admit a write
   * whose hold could be reclaimed under it.
   */
  claim(token: string): Promise<{ release(): void } | null>;
  /** `true` only when the ownership of `token` is PROVEN to have ended (released, or its page destroyed). Never rejects. */
  released(token: string): Promise<boolean>;
}

const own = (state: LedgerState): LedgerState => ({
  holds: { ...state.holds },
  landed: state.landed === null ? null : { ...state.landed },
});

/**
 * A ledger in this realm's memory. It shares nothing with another page; two guards of ONE page that read the same estimate source share
 * one (`ledgerFor`), which is the same promise the origin's ledger makes at smaller scale. Applied at the moment of the call, so a
 * settlement is visible to the very next judgement.
 */
export interface MemoryLedger extends OriginLedger {
  /** The state, at once (a guard reads its own accounting while it judges against the origin's). */
  read(): LedgerState;
}

export function createMemoryLedger(): MemoryLedger {
  let state: LedgerState = EMPTY_LEDGER;
  return {
    shared: false,
    read: () => own(state),
    update(change) {
      try {
        const out = change(own(state));
        if (out.state !== null) state = out.state;
        return Promise.resolve(out.result);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    peek(read) {
      try {
        return Promise.resolve(read(own(state)));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    close() {
      // Nothing is held open.
    },
  };
}

const byOwner = new WeakMap<object, OriginLedger>();

/**
 * The ledger guards over `owner` (their estimate source: the page's `navigator.storage`) share: one per estimate source in this realm,
 * so two guards that ask the same origin the same question also count the same promises. With no estimate source there is nothing to
 * judge, and a guard keeps a ledger of its own.
 */
export function ledgerFor(owner: object | undefined): OriginLedger {
  if (owner === undefined) return createMemoryLedger();
  let found = byOwner.get(owner);
  if (found === undefined) {
    found = createMemoryLedger();
    byOwner.set(owner, found);
  }
  return found;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** What a stored record says, or nothing when it is not a ledger (an empty or damaged record never blocks a write: it is reset). */
export function readLedger(raw: unknown): LedgerState {
  if (typeof raw !== "object" || raw === null) return EMPTY_LEDGER;
  const record = raw as { holds?: unknown; landed?: unknown };
  const holds: Record<string, LedgerHold> = {};
  if (typeof record.holds === "object" && record.holds !== null)
    for (const [token, hold] of Object.entries(record.holds)) {
      const entry = hold as {
        bytes?: unknown;
        until?: unknown;
        owned?: unknown;
        base?: unknown;
      } | null;
      if (
        entry !== null &&
        typeof entry === "object" &&
        finite(entry.bytes) &&
        typeof entry.until === "number" &&
        Number.isFinite(entry.until)
      )
        holds[token] = {
          bytes: entry.bytes,
          until: entry.until,
          ...(entry.owned === true ? { owned: true } : {}),
          // `null` (judged on no figure) is a statement; anything else that is not a figure is as good as absent.
          ...(entry.base === null || finite(entry.base)
            ? { base: entry.base }
            : {}),
        };
    }
  let landed: LedgerLanded | null = null;
  const stored = record.landed as
    | (Partial<LedgerLanded> & { settled?: unknown })
    | null
    | undefined;
  if (
    stored !== null &&
    typeof stored === "object" &&
    finite(stored.base) &&
    finite(stored.landed) &&
    typeof stored.until === "number" &&
    Number.isFinite(stored.until)
  ) {
    const settled = Array.isArray(stored.settled)
      ? stored.settled
          .filter((token): token is string => typeof token === "string")
          .slice(-SETTLED_KEPT)
      : [];
    landed = {
      base: stored.base,
      landed: stored.landed,
      until: stored.until,
      ...(settled.length === 0 ? {} : { settled }),
    };
  }
  return { holds, landed };
}

/**
 * The part of the page's lock port that the ownership of a hold uses: `tryAcquire` (an `ifAvailable` request that is kept on a grant)
 * and `probe` (an `ifAvailable` request that is let go at once). `createWebLocksPort(navigator.locks)` has both; neither reads another
 * page's state, and `query()` is not part of it (lint R2).
 */
export interface OwnerLocks {
  tryAcquire(name: string): Promise<{ release(): void } | null>;
  probe(name: string): Promise<boolean>;
}

/** The name of the lock that owns a hold: one per token, apart from every lock of the session protocol. */
export const HOLD_LOCK_PREFIX = "atlas-quota-hold:";

/** The ownership of holds over a page's locks (R28, revision 15). A failure of the lock manager is a `null` claim and an unproven release. */
export function createHoldOwners(locks: OwnerLocks): HoldOwners {
  return {
    async claim(token) {
      try {
        return await locks.tryAcquire(`${HOLD_LOCK_PREFIX}${token}`);
      } catch {
        return null;
      }
    },
    async released(token) {
      try {
        return (await locks.probe(`${HOLD_LOCK_PREFIX}${token}`)) === true;
      } catch {
        return false;
      }
    },
  };
}

export const LEDGER_DATABASE = "atlas-quota-ledger";
const STORE = "ledger";
const KEY = "state";
/** How long one call of the origin ledger may take before the page's queue goes on without it. */
export const STUCK_MS = 10_000;

/**
 * The origin's ledger over IndexedDB: one tiny database, one record. Opened on first use (constructing it holds nothing), closed by
 * `close()` or when another page asks to change or delete the database (`versionchange`), and opened again on the next use.
 *
 * One page's calls enter the database in the order they were made (a settlement made before the next judgement is applied before it);
 * across pages the database orders them. A call that fails rejects, and the next call tries again.
 *
 * `locks` gives the holds their OWNERS (R28, revision 15): with it, a hold is reclaimed only once its writer's lock is proven released;
 * without it, by its lease alone.
 *
 * Returns `undefined` where there is no IndexedDB (or `null` is passed), and the caller keeps its in-realm ledger.
 */
export function createIdbLedger(
  factory: IDBFactory | null | undefined = typeof indexedDB === "undefined"
    ? null
    : indexedDB,
  locks?: OwnerLocks,
): OriginLedger | undefined {
  // `undefined` is the page's own IndexedDB (the default above); `null` is none at all, which a caller names when it must not use it.
  if (factory === null || factory === undefined) return undefined;
  let connection: Promise<IDBDatabase> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const open = (): Promise<IDBDatabase> => {
    if (connection !== null) return connection;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(LEDGER_DATABASE, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another page wants to change or delete the database: let go, and open again on the next use.
        db.onversionchange = () => {
          db.close();
          if (connection === opening) connection = null;
        };
        db.onclose = () => {
          if (connection === opening) connection = null;
        };
        resolve(db);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("the quota ledger did not open"));
      request.onblocked = () =>
        reject(new Error("the quota ledger is blocked"));
    });
    connection = opening;
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
    return opening;
  };

  const attempt = async <T>(
    mode: IDBTransactionMode,
    change: (state: LedgerState) => LedgerChange<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        // The ledger is advisory and rewritten at every change: it does not wait for the disk, and it is visible to every page at once.
        transaction = db.transaction(STORE, mode, { durability: "relaxed" });
      } catch (error) {
        connection = null;
        reject(error);
        return;
      }
      const store = transaction.objectStore(STORE);
      let result: T;
      const read = store.get(KEY);
      read.onsuccess = () => {
        try {
          const out = change(readLedger(read.result));
          result = out.result;
          if (mode === "readwrite" && out.state !== null)
            store.put(out.state, KEY);
        } catch (error) {
          reject(error);
          try {
            transaction.abort();
          } catch {
            // Already finished.
          }
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("the quota ledger aborted"));
    });
  };

  /**
   * One page's calls enter in order, and one that never completes (a request that is never answered) must not hold up every call behind
   * it for good: it is given up on after `STUCK_MS`, and the queue goes on. The guard that called it gave up long before (its own wait is
   * far shorter), so nobody is still waiting for it.
   */
  const run = <T>(
    mode: IDBTransactionMode,
    change: (state: LedgerState) => LedgerChange<T>,
  ): Promise<T> => {
    const task = tail.then(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        attempt(mode, change),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // A request that never answers may be the OPEN itself: forget the connection, so the next call opens afresh.
            connection = null;
            reject(new Error("the quota ledger is stuck"));
          }, STUCK_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    });
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const owners = locks === undefined ? undefined : createHoldOwners(locks);
  return {
    shared: true,
    update: (change) => run("readwrite", change),
    peek: (read) =>
      run("readonly", (state) => ({ state: null, result: read(state) })),
    ...(owners === undefined ? {} : { owners }),
    close() {
      const closing = connection;
      connection = null;
      closing?.then(
        (db) => db.close(),
        () => undefined,
      );
    },
  };
}

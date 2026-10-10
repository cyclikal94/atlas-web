/**
 * The write-failure marker (decision D-14; WEB-04 design 5.12). When a local write fails and even the durable streak counter
 * cannot be written, the failure is recorded in `localStorage` so it survives a reload. This is the ONLY module in `src/data`
 * that uses `localStorage` (lint rule R17), and what it stores holds NO content: keys that name the account, the database lifetime,
 * the operation and ONE failure (a random page part and a count, never anything the person wrote), and the fixed value `1`.
 *
 * Four obligations govern how a failure is recorded, found and ended (revision 34; the earlier revisions' rules are kept).
 *
 * 1. EXACT RETIREMENT AUTHORITY (R50 to R53). A marker is ONE failure, written ONCE under a key of its own:
 *
 *        atlas-write-failing:<account>:<incarnation>:<operation>#<page>.<count>
 *
 *    `localStorage` has no atomic compare-and-remove, so ending a failure is `removeItem` of the exact key that was witnessed, which can
 *    touch no other failure (a newer one has a key of its own, and no key is ever written twice). A success ends the failures that stood
 *    when the write was ISSUED (`witnessStops`) and no others, whenever its result is delivered (`retireStops`).
 *
 * 2. COMPLETE OBSERVATION (R55, revisions 32 to 35). A failure's KEY is the only thing that is ever written once and never again, so it
 *    is the one record that cannot be lost by another page's write; everything that merely POINTS at keys can. The AUTHORITY for which
 *    failures stand is therefore the store's own list of its keys, read in ONE operation (revision 35):
 *
 *    (a) the SNAPSHOT of the origin's keys (`snapshotKeys`): `Object.keys` of the browser's `localStorage`. The HTML standard defines
 *        a Storage object's supported property names as "the result of running get the keys on storage's map", and the Storage
 *        standard defines that map as a proxy whose every operation "is instead performed on its backing map", the bottle's map "where
 *        the actual data meant to be stored lives". So the list is the backing map's keys taken by ONE map operation, at one instant,
 *        not a walk: nothing another context does can shift it part-way. A key whose `setItem` returned before that instant and which
 *        no `removeItem` has removed since is in it; and that is exactly the coherence a read of ONE key (`getItem`) relies on, so no
 *        failure that a direct read would find can be missing from a snapshot taken after it was written. (The enumeration re-checks each
 *        key as it builds the list, so a key that is REMOVED while the list is made can be left out: a removal is a retirement, keys are
 *        never written twice, and its absence is then true.)
 *
 *        Revisions 32 to 34 walked `Storage.key(i)` over `Storage.length` instead, which is one operation PER INDEX: another context's
 *        insertion and removal of unrelated keys between two of them can move a standing key behind the index being read (the order is
 *        implementation-defined and changes on mutation), the same way in two walks, so neither one walk, nor two that agree, nor a
 *        length checked at the ends could certify that nothing was missed (the review of revision 34). `key(i)` is no longer read.
 *        `length` is read first, only as the work bound (`LISTING_MAX_KEYS`), never as a check of the snapshot.
 *    (b) the DIRECTORIES: `SLOT_COUNT` fixed addresses that a page holding a slot (a Web Lock, `atlas-write-slot:<n>`, taken while its
 *        controller runs) writes before the key it lists:
 *
 *            atlas-write-dir:<account>:<incarnation>:<slot>     {"v":1,"e":[["<operation>","<page>.<count>"], ...]}
 *
 *        They are POSITIVE discovery only and certify nothing: a lock hands a slot over and says nothing about whether the new owner SEES
 *        what the previous one wrote last (measured on Firefox and WebKit), and a page that holds no slot writes no entry at all. What a
 *        directory lists and whose key stands is found when the snapshot cannot be made (it is refused or over its bound), and the read is
 *        then incomplete all the same.
 *    (c) the EXACT KEYS this page has established (it wrote them, or a read found them) are read again by name after the snapshot. One
 *        that stands and that the snapshot did not list contradicts it (it existed before the snapshot was taken, and keys are never
 *        written twice), so the read is INCOMPLETE and the failure stands: a page never forgets a failure it knew of because a listing
 *        left it out.
 *
 *    A snapshot that cannot be made (no single-operation listing, a refused read of the size or of the keys, more keys than
 *    `LISTING_MAX_KEYS`), a directory that cannot be parsed, a contradiction (c) and a read that passes the work bound are UNKNOWN for
 *    whatever was not found, never absence; what was found stands. The residual is the platform's: the HTML standard "does not define
 *    the interaction with other agent clusters in a multiprocess user agent", which bounds a read of one key exactly as it bounds the
 *    snapshot, so what is claimed is that the snapshot is as complete as a direct read of a key is fresh, and no weaker.
 *
 *    Every other operation on a marker is a blind write or removal of ONE exact key, and the directory has one writer at a time (the
 *    holder of its slot's lock), so there is no read-modify-write between pages that a result depends on.
 *
 * 3. DURABLE AT ONCE (R58, revision 34). A failure is recorded by writing its key IMMEDIATELY, in the same synchronous step as the
 *    last look at the service's lifetime. It never waits for a lock: when the page holds no slot yet (the controller has not taken it,
 *    it was refused, or there are no locks at all) the key is written alone and listed in the directory when the slot arrives. So
 *    there is no failure that is "pending" and can be published after the person has recovered the operation, or after its service
 *    has ended; the only thing that arrives late is an index entry for a key, and it is made only for a key that still stands.
 *
 * 4. LIFETIME ADMISSION (R56). The key names the database's INCARNATION as well as the account, and every call takes the scope
 *    (`StopScope`: account and incarnation). A callback that was delivered after its service ended (`live`) records nothing, and one that
 *    cannot be stopped in time (a page whose notice of the deletion is late) can only write the keys of ITS OWN, dead, lifetime, which no
 *    reader of the replacement database consults. Deleting an account's database removes its markers (`clearAccount`) as housekeeping; no
 *    answer depends on that having happened, so a deletion that never reached the cleanup (a crash, the wipe that finds the database
 *    already absent) leaves unreachable keys and nothing else.
 */
export const MARKER_PREFIX = "atlas-write-failing:";
export const DIRECTORY_PREFIX = "atlas-write-dir:";
/** The names of the Web Locks that give a page its directory slot. */
export const SLOT_LOCK_PREFIX = "atlas-write-slot:";

/**
 * How many pages of an origin can LIST their failures in a directory at once (a page holds one slot while its controller runs). A page
 * beyond this, or one that holds none, still records every failure durably (its key is written at once and found by the snapshot of the origin's keys) and
 * only leaves it out of a directory: capacity never turns a failure into a memory-only one.
 */
export const SLOT_COUNT = 32;
/** How many failures one directory lists, and the size of its text: a listing that would pass either is not written (the keys stand and the snapshot finds them), and nothing that stands is dropped from it. */
export const DIRECTORY_MAX_ENTRIES = 2_048;
export const DIRECTORY_MAX_CHARS = 262_144;
/** The most failures one observation will check before it gives up and answers `unknown` (bounded work). */
export const OBSERVATION_MAX_ENTRIES = 16_384;
/** The most keys of the origin one snapshot will take before it gives up and answers `unknown` (bounded work; the app writes a few dozen). */
export const LISTING_MAX_KEYS = 8_192;

export interface MarkerStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /**
   * Every key of the store, read in ONE operation (header, obligation 2 (a)). The browser's `localStorage` has no method of this name:
   * its keys are read with `Object.keys`, which is that operation. A double supplies it; a store that has neither cannot be listed, and
   * every read of it is incomplete.
   */
  keys?(): readonly string[];
}

/** What every marker stores: the failure is in the KEY. */
const MARKED = "1";

/** The part of a key after the operation: `#` and a page part, a dot and a count. The page part is random; the count is the page's. */
const INSTANCE_SEPARATOR = "#";
const INSTANCE_PATTERN = /^[0-9a-z-]{1,64}\.[0-9]+$/;

/** What a stop belongs to: one account's database, and ONE LIFETIME of it (its incarnation). */
export interface StopScope {
  readonly account: string;
  readonly incarnationId: string;
}

const enc = (part: string): string => encodeURIComponent(part);
/** The scope as a key part: nothing in it is a colon, so the key splits unambiguously. */
const scopePart = (scope: StopScope): string =>
  `${enc(scope.account)}:${enc(scope.incarnationId)}`;
const scopeId = (scope: StopScope): string => scopePart(scope);

/**
 * The key of ONE failure's marker: the scope, the operation and the instance (`<page>.<count>`). Exported for the tests and the
 * fixture, which plant and read markers as another page would.
 */
export const markerKey = (
  scope: StopScope,
  operation: string,
  instance: string,
): string =>
  `${MARKER_PREFIX}${scopePart(scope)}:${operation}${INSTANCE_SEPARATOR}${instance}`;

/** The key of one slot's directory for a scope. */
export const directoryKey = (scope: StopScope, slot: number): string =>
  `${DIRECTORY_PREFIX}${scopePart(scope)}:${slot}`;

/** What a marker key names, or null when it is not one. Exported like `markerKey`. */
export function parseMarkerKey(key: string): {
  account: string;
  incarnationId: string;
  operation: string;
  instance: string;
} | null {
  if (!key.startsWith(MARKER_PREFIX)) return null;
  const rest = key.slice(MARKER_PREFIX.length);
  const first = rest.indexOf(":");
  const second = first < 0 ? -1 : rest.indexOf(":", first + 1);
  const at = rest.lastIndexOf(INSTANCE_SEPARATOR);
  if (first < 0 || second < 0 || at <= second) return null;
  const instance = rest.slice(at + 1);
  if (!INSTANCE_PATTERN.test(instance)) return null;
  try {
    return {
      account: decodeURIComponent(rest.slice(0, first)),
      incarnationId: decodeURIComponent(rest.slice(first + 1, second)),
      operation: rest.slice(second + 1, at),
      instance,
    };
  } catch {
    return null;
  }
}

/**
 * Another page wrote or removed an item of the shared storage (the browser's `storage` event): the item's key, or `null` when the whole
 * storage was cleared. A page is never told of its own writes, exactly as the browser does not tell it.
 */
export interface MarkerEvents {
  subscribe(listener: (key: string | null) => void): () => void;
}

/** A change another page made to a marker, as a question: does it concern this account, and this operation of it? */
export interface MarkerChange {
  /** Without an operation: any marker of the account. A cleared storage touches everything. */
  touches(account: string, operation?: string): boolean;
}

/**
 * The Web Locks a page uses to own a directory slot: `tryAcquire` takes the named lock if it is free at this moment (`ifAvailable`; a
 * lock is never stolen, and never read with `query()`), and the handle keeps it until released. `LockPort` of the session has the same
 * method; `null` is "held elsewhere", and so is an environment that has no locks.
 */
export interface SlotLocks {
  tryAcquire(name: string): Promise<{ release(): void } | null>;
}

/**
 * The local-write stops of THIS PAGE that neither the database nor the account's marker could record, and the board on which the
 * page's writers tell each other that a stop changed (R46 and R47, revision 27).
 *
 * A stop is the failure state of one LOGICAL operation (`draft:<id>`, `receipt:<id>`, `queue`), and the operation is written by more
 * than one component of a page: the facade (a save, an edit, a supersession, a discard) and the dispatcher (the claim, the receipt, the
 * read of the queue), and a page may hold more than one of each. Their durable record (the streak) and their marker (`localStorage`) are
 * shared by construction; this is the third place a stop can be, the memory of the tab, so it must be shared the same way. It travels
 * with the markers because every writer of a page already receives the page's markers: one that holds its own copy of a stop is one that
 * the others cannot see (the dispatcher then sent a draft the facade had stopped) and cannot end (the dispatcher stayed stopped after
 * the facade had saved the draft). A reload loses it, which is the disclosed limitation of a memory-only stop.
 */
export interface LocalStops {
  /**
   * This tab holds the stop of `operation` (it could be recorded nowhere durable, or not yet). Every hold is a NEW instance, a failure
   * of its own, even when the operation is already held: a stop recorded again is newer than any write issued before it (R50, revision
   * 31). Answers the instance, so that a hold that was only waiting for a durable record is released as exactly that hold.
   */
  hold(scope: StopScope, operation: string): string;
  /**
   * Ends the tab's hold on `operation`, whichever writer took it; true when there was one. With `instance` (what `instance` said when
   * an act began), only that hold: a hold recorded since is a newer failure and stays.
   */
  release(scope: StopScope, operation: string, instance?: string): boolean;
  /** The instance of the hold on `operation` now, or null. A write about to be issued takes this to know which hold it can end. */
  instance(scope: StopScope, operation: string): string | null;
  has(scope: StopScope, operation: string): boolean;
  /** Every operation of the scope that the tab holds. */
  operations(scope: StopScope): string[];
  /** Forgets every stop of the account, whatever its incarnation (its database was deleted). */
  clearAccount(account: string): void;
  /**
   * A writer tells the others which stops of `scope` changed in some record (the database, the markers or this memory): a prompt to look
   * again, never evidence. `from` names the announcer, so that a writer can ignore its own news. The news names the operations, so that a writer
   * that holds nothing of them has nothing to look at, and the healthy path (a save that ends nothing that anyone shows) costs the
   * others nothing.
   */
  announce(scope: StopScope, from: object, news: StopNews): void;
  subscribe(
    listener: (scope: StopScope, from: object, news: StopNews) => void,
  ): () => void;
}

export interface StopNews {
  /** Operations whose stop was just recorded (so a writer that shows the stops that stand has one more to show). */
  recorded?: readonly string[];
  /** Operations whose stop ended, or may have: a success, an abandonment or a retry, whichever record held it. */
  ended?: readonly string[];
}

/** A page's memory of its stops (see `LocalStops`). One per page: `createWriteFailureMarkers` makes it, a writer without markers makes its own. */
export function createLocalStops(): LocalStops {
  // Scope -> operation -> the instance of its hold (a count, unique within the page: the memory is the page's).
  const held = new Map<string, Map<string, string>>();
  let instances = 0;
  const listeners = new Set<
    (scope: StopScope, from: object, news: StopNews) => void
  >();
  const keyOf = (scope: StopScope): string =>
    JSON.stringify([scope.account, scope.incarnationId]);
  return {
    hold(scope, operation) {
      const key = keyOf(scope);
      const operations = held.get(key) ?? new Map<string, string>();
      instances += 1;
      const instance = `m${instances}`;
      operations.set(operation, instance);
      held.set(key, operations);
      return instance;
    },
    release(scope, operation, instance) {
      const key = keyOf(scope);
      const operations = held.get(key);
      if (operations === undefined) return false;
      if (instance !== undefined && operations.get(operation) !== instance)
        return false;
      if (!operations.delete(operation)) return false;
      if (operations.size === 0) held.delete(key);
      return true;
    },
    instance: (scope, operation) =>
      held.get(keyOf(scope))?.get(operation) ?? null,
    has: (scope, operation) => held.get(keyOf(scope))?.has(operation) === true,
    operations: (scope) => [...(held.get(keyOf(scope))?.keys() ?? [])],
    clearAccount(account) {
      for (const key of [...held.keys()])
        if ((JSON.parse(key) as [string, string])[0] === account)
          held.delete(key);
    },
    announce(scope, from, news) {
      for (const listener of [...listeners]) {
        try {
          listener(scope, from, news);
        } catch {
          // One writer's defect must not stop another from hearing.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * What a read of ONE marker could say (R47, revisions 28 to 30; R55, revision 33). A read that threw is not a read of an absent marker, and
 * neither is a store that could not be obtained or a record that could not be completed: `unknown` is its own answer, and a consumer
 * decides what it means for what it protects. `marked` also covers a marker this page has ESTABLISHED (it wrote it, or a read found it)
 * that a failed read can neither confirm nor deny.
 *
 * `unmarked` is only ever what a read that COMPLETED said now (or the answer of an environment that has no store at all). It is never what
 * this page did earlier: a removal that returned established that the key was gone AT that moment, and says nothing about a marker
 * another page wrote afterwards, which no notification is guaranteed to have announced yet.
 */
export type MarkerState = "marked" | "unmarked" | "unknown";

/**
 * What stood for ONE operation when an act began (R50 and R51, revision 31; R52, revision 32): the INSTANCES of its markers, so that a
 * success that is delivered later ends the failures it could have recovered and no newer one.
 *
 *   * `none`: a read that COMPLETED found no marker (or the environment has no store at all). Anything that stands later was recorded
 *     after the act began, and is a newer failure.
 *   * `instance`: markers stood, by name (the part of the key after the operation). It is also what this page ESTABLISHED when a read
 *     could not be completed. Ending them is the removal of those exact keys, and of nothing else.
 *   * `unread`: nothing could be read and the page had established nothing, so nothing is known of it, and no key can be named. A
 *     success cannot end it, and neither can a retry made now: what a later read finds may be newer than the act, and an act is
 *     entitled to the failures that stood when it began and no others. A retry made when a read completes names them.
 */
export type MarkerSeen =
  | { kind: "none" }
  | { kind: "instance"; instances: readonly string[] }
  | { kind: "unread" };

/** What a witness says of a marker, in the three-valued answer of `probe` (an instance is `marked`, whatever named it). */
export function markerStateOf(seen: MarkerSeen): MarkerState {
  return seen.kind === "none"
    ? "unmarked"
    : seen.kind === "instance"
      ? "marked"
      : "unknown";
}

/**
 * What a read of a scope's markers could say: the operations that carry one and whether the read that found them COMPLETED. When it
 * did not, `operations` is what this page has established and no more, and an operation that is not in it may still have a marker
 * nobody here has seen.
 */
export interface MarkerRead {
  operations: string[];
  known: boolean;
}

/**
 * How recording a failure ended (R56, R58). `recorded`: the marker is durable NOW (its key is written; it is listed in a directory when
 * the page holds a slot, and later when it takes one). `unavailable`: this page could not record it (no store, a refused write): the
 * caller holds the stop in the page's memory and says so. `obsolete`: the failure belongs to a lifetime that ended before it could be
 * recorded (the caller's `live` said so), so NOTHING was written and nothing is to be held: it is not a storage failure of the
 * replacement database.
 *
 * There is no "pending" outcome since revision 34: a failure never waits for a lock, so none can be published after it was recovered
 * (R58) or after its service ended. `settled` is kept for the callers of revision 33 and is always already settled.
 */
export type PublicationOutcome = "recorded" | "unavailable" | "obsolete";
export interface Publication {
  readonly state: PublicationOutcome;
  readonly settled: Promise<PublicationOutcome>;
}

export interface WriteFailureMarkers {
  /**
   * Records a failure of the operation in the scope: a NEW instance under a key of its own, even when a marker stands (a failure recorded
   * again is newer than any write issued before it, R50). `live` is asked in the same synchronous step as the first write: a callback
   * that outlived its service writes nothing (R56). The key is written AT ONCE, whether or not the page holds a slot (R58): the answer
   * is final, and nothing is left to be published later. The page's own earlier instance of the operation is removed once the new one is
   * stored, so that a page that keeps failing leaves one marker per operation and no more.
   */
  set(scope: StopScope, operation: string, live?: () => boolean): Publication;
  /**
   * Removes every marker of the operation that a read finds NOW. It is not a recovery: it covers whatever stands, newer failures
   * included, so no act that has a witness uses it (`retire` ends the instances the act saw). No production code calls it.
   */
  clear(scope: StopScope, operation: string): void;
  /**
   * The instances of the operation's markers NOW, taken when an act begins (a write is about to be issued, a retry is made, a gate
   * decides). Its read is the same as `probe`'s, and `probe` is its three-valued form.
   */
  witness(scope: StopScope, operation: string): MarkerSeen;
  /**
   * Ends the markers that a witness saw: the removal of those exact keys. A newer instance has a key of its own and is never touched,
   * however late the call is made and whatever another page wrote meanwhile (R52). A marker that cannot be removed is OWED the removal
   * (the same exact key, made again at the next read), and a witness that named nothing (`unread`) ends nothing. `explicit` is the
   * person's own act (a retry, an abandonment): a removal that cannot be made is not owed, the person's next act tries again. Answers
   * whether a marker this page believed to stand was removed.
   */
  retire(
    scope: StopScope,
    operation: string,
    seen: MarkerSeen,
    options?: { explicit?: boolean },
  ): boolean;
  /**
   * Whether the operation carries a marker, as far as this page knows: a marker that was established and cannot be read again still
   * counts (R47). A consumer that must tell "none" from "could not read" asks `probe`.
   */
  has(scope: StopScope, operation: string): boolean;
  /**
   * The operation's marker, three-valued: a read that could not be completed is `unknown` (or `marked`, when the page established it
   * and nothing a completed read has contradicted that), never `unmarked` for want of a read, and never `unmarked` because this page
   * once removed the marker (R47, revision 30). Asked at the point where the answer is used: it reads the store each time.
   */
  probe(scope: StopScope, operation: string): MarkerState;
  /** Every operation with a marker in the scope, as far as this page knows (see `inspect`). */
  operations(scope: StopScope): string[];
  /**
   * Every operation with a marker in the scope, and whether the read COMPLETED. A read that fails keeps what the page has established
   * until a read that completed says otherwise, or the page ends the marker itself (R47): the stops a page knows of do not end because
   * their record cannot be read.
   */
  inspect(scope: StopScope): MarkerRead;
  /**
   * Removes every marker and directory of the account, whatever the lifetime (its database was deleted), and the page's memory of its
   * stops with them. HOUSEKEEPING: it lists the origin's keys, which is fine for removing and never for deciding, and nothing a read
   * answers depends on it (the keys of a lifetime are not read by any other).
   */
  clearAccount(account: string): void;
  /** The page's own record of the stops no store could hold, shared by every writer that receives these markers (R46, revision 27). */
  readonly stops: LocalStops;
  /**
   * Takes this page's directory slot now (a publication asks for it on first use otherwise, without waiting for it), and lists in it the
   * failures this page has recorded while it held none. Resolves whether the page holds a slot; never rejects. A controller calls it
   * when it starts.
   */
  prepare(): Promise<boolean>;
  /**
   * Lets go of the slot; a failure recorded afterwards is still durable (its key is written, and found by the snapshot of the origin's keys) and is listed in a
   * directory when the page takes a slot again. A controller that stops calls it; a page that goes away lets go by itself. Idempotent.
   */
  release(): void;
  /**
   * ANOTHER page set or removed a marker (R15). A prompt to look again and nothing else: the change names a key and carries no value,
   * so what a marker says is only ever what `has` and `operations` read now, and a page that is told of a removal learns nothing
   * about whether the thing it protected is safe. Never fired for this page's own writes.
   */
  subscribe(listener: (change: MarkerChange) => void): () => void;
}

/**
 * `storage` events of the page's window for ONE storage area. The window is the only place the browser delivers them, so this lives
 * here with the one module that uses `localStorage`; with no window (a worker, a test of the engine) there is no feed. The area is
 * asked for at each event, as every use of the store is (R47, revision 29): when it cannot be obtained, the event cannot be told from
 * one of this storage's, and is heard (a prompt to look again costs a read and decides nothing).
 */
function windowStorageEvents(
  areaOf: () => MarkerStorage | undefined,
): MarkerEvents | undefined {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  )
    return undefined;
  return {
    subscribe(listener) {
      const hear = (event: StorageEvent): void => {
        const area = areaOf();
        if (
          area !== undefined &&
          event.storageArea !== (area as unknown as Storage)
        )
          return;
        listener(event.key);
      };
      window.addEventListener("storage", hear);
      return () => window.removeEventListener("storage", hear);
    },
  };
}

/**
 * What obtaining the marker store said (R47, revision 29): the store; `none`, an environment that has no `localStorage` at all (a worker,
 * a test of the engine), where nothing could ever have been written and an empty read is complete; or `blocked`, an access that threw
 * (blocked site data), which says NOTHING about what the store holds and is never a read of an empty one. A refusal is never kept: it
 * is asked again at every use until the store has been obtained once, so an object built while access was refused finds the store when
 * access is restored; and a refused access never becomes an absent one (an environment's `localStorage` does not go away).
 */
type Access =
  | { kind: "store"; storage: MarkerStorage }
  | { kind: "none" }
  | { kind: "blocked" };

/** One marker a scope's directories list and whose key stands: what the key names. */
interface Standing {
  key: string;
  operation: string;
  instance: string;
}

/**
 * What an observation of a scope found: the markers that stand, and the operations that a listed failure's key could not be read for
 * (such an operation is UNKNOWN, since the failure may stand, and no other operation is: one unreadable key is not a verdict on the
 * scope). `complete` is false when a witness could not be completed (a directory that is not one, a snapshot that could not be made, an
 * established key the snapshot did not list, a bound): what was found stands, and nothing else is known to be absent.
 */
interface Observed {
  found: Standing[];
  unreadable: Set<string>;
  complete: boolean;
}

/** The instances a page knows of, by scope and operation. */
class Instances {
  private readonly byScope = new Map<string, Map<string, Set<string>>>();
  get(scope: string, operation: string): ReadonlySet<string> | undefined {
    return this.byScope.get(scope)?.get(operation);
  }
  add(scope: string, operation: string, instance: string): void {
    const operations =
      this.byScope.get(scope) ?? new Map<string, Set<string>>();
    const known = operations.get(operation) ?? new Set<string>();
    known.add(instance);
    operations.set(operation, known);
    this.byScope.set(scope, operations);
  }
  remove(scope: string, operation: string, instance: string): void {
    const operations = this.byScope.get(scope);
    const known = operations?.get(operation);
    if (operations === undefined || known === undefined) return;
    known.delete(instance);
    if (known.size === 0) operations.delete(operation);
    if (operations.size === 0) this.byScope.delete(scope);
  }
  /** Replaces what is known of one operation (an empty set forgets it). */
  replace(scope: string, operation: string, instances: Iterable<string>): void {
    const next = new Set(instances);
    const operations =
      this.byScope.get(scope) ?? new Map<string, Set<string>>();
    if (next.size === 0) operations.delete(operation);
    else operations.set(operation, next);
    if (operations.size === 0) this.byScope.delete(scope);
    else this.byScope.set(scope, operations);
  }
  operations(scope: string): string[] {
    return [...(this.byScope.get(scope)?.keys() ?? [])];
  }
  clearAccount(account: string): void {
    const prefix = `${enc(account)}:`;
    for (const key of [...this.byScope.keys()])
      if (key.startsWith(prefix)) this.byScope.delete(key);
  }
}

/** The failures a directory lists, or null when its text is not a directory (malformed: unknown, never empty). */
function parseDirectory(raw: string): Array<[string, string]> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { v?: unknown; e?: unknown };
    if (record.v !== 1 || !Array.isArray(record.e)) return null;
    const entries: Array<[string, string]> = [];
    for (const entry of record.e as unknown[]) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" ||
        !INSTANCE_PATTERN.test(entry[1])
      )
        return null;
      entries.push([entry[0], entry[1]]);
    }
    return entries;
  } catch {
    return null;
  }
}

const serializeDirectory = (entries: ReadonlyArray<[string, string]>): string =>
  JSON.stringify({ v: 1, e: entries });

/**
 * Every key of the origin, read in ONE operation of the store (header, obligation 2 (a)), or `null` when that cannot be done: the
 * store has no single-operation listing, its size or its keys could not be read, or it holds more than `LISTING_MAX_KEYS` keys. The
 * size is read first, and only as the work bound (it is a separate operation, so it is never compared with the snapshot), so an origin
 * over the bound is never materialised. The browser's `localStorage` is recognised first (a key the origin stored under the name `keys`
 * reads as a string property of it, never as a method).
 */
export function snapshotKeys(storage: MarkerStorage): readonly string[] | null {
  try {
    const count = storage.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > LISTING_MAX_KEYS)
      return null;
    let keys: readonly string[];
    if (typeof Storage !== "undefined" && storage instanceof Storage)
      keys = Object.keys(storage);
    else if (typeof storage.keys === "function") keys = storage.keys();
    else return null;
    if (!Array.isArray(keys) || keys.length > LISTING_MAX_KEYS) return null;
    return keys;
  } catch {
    return null;
  }
}

/**
 * The failures of a scope that ONE snapshot of the origin's keys names (header, obligation 2 (a)), or `null` when the snapshot cannot be
 * made or names more failures than one observation will check. It does not read a value.
 */
function listScope(
  storage: MarkerStorage,
  scope: StopScope,
): Standing[] | null {
  const keys = snapshotKeys(storage);
  if (keys === null) return null;
  const prefix = `${MARKER_PREFIX}${scopePart(scope)}:`;
  const found: Standing[] = [];
  for (const key of keys) {
    if (typeof key !== "string" || !key.startsWith(prefix)) continue;
    const parsed = parseMarkerKey(key);
    if (
      parsed === null ||
      parsed.account !== scope.account ||
      parsed.incarnationId !== scope.incarnationId
    )
      continue;
    found.push({ key, operation: parsed.operation, instance: parsed.instance });
    if (found.length > OBSERVATION_MAX_ENTRIES) return null;
  }
  return found;
}

/**
 * The failures of a scope that stand and that NO directory but the one being rewritten (`rewriting`) lists: what a hand-over of a slot
 * (a new owner that rewrote the list it inherited from a view that was behind) or a page that held no slot when it recorded a failure
 * left out of the directories. The page that holds a slot lists them in its own directory when it writes it (positive discovery
 * only: what certifies absence is the snapshot). Unreadable directories list nothing here (their failures are found by the snapshot alone).
 */
function unlistedStanding(
  storage: MarkerStorage,
  scope: StopScope,
  rewriting: number,
): Array<[string, string]> {
  const standing = listScope(storage, scope);
  if (standing === null || standing.length === 0) return [];
  const listed = new Set<string>();
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    // The directory being rewritten lists nothing here: what the caller keeps of it is decided by the caller, and what it omits (it was
    // read from a view that was behind) is exactly what this finds.
    if (slot === rewriting) continue;
    const raw = storage.getItem(directoryKey(scope, slot));
    if (raw === null) continue;
    for (const [operation, instance] of parseDirectory(raw) ?? [])
      listed.add(markerKey(scope, operation, instance));
  }
  return standing
    .filter((entry) => !listed.has(entry.key))
    .map((entry) => [entry.operation, entry.instance]);
}

/**
 * Writes the directory `slot` of `scope`, which the caller owns (it holds the slot's lock): the entries it inherits whose keys still
 * stand, the failures that stand and no directory lists, and `additions`. It never drops an entry whose key stands, and writes nothing
 * (answers `not-listed`) when the directory it finds cannot be parsed, a read or the write is refused, or the list would pass a bound:
 * the keys stand and the snapshot finds them, so a directory that cannot be written costs positive discovery and nothing else. An
 * addition's key need not exist yet (the directory is written BEFORE the key); it is dropped again by the next write if it never does.
 */
function writeDirectory(
  storage: MarkerStorage,
  scope: StopScope,
  slot: number,
  additions: ReadonlyArray<[string, string]>,
): "listed" | "not-listed" {
  const directory = directoryKey(scope, slot);
  let kept: Array<[string, string]>;
  try {
    const before = storage.getItem(directory);
    if (before === null) kept = [];
    else {
      const parsed = parseDirectory(before);
      // A directory this page cannot read is not overwritten: what it lists is protection nobody can see, and it stays.
      if (parsed === null) return "not-listed";
      kept = parsed;
    }
    // Failures whose keys are gone have ended; what stands stays, whoever recorded it before this page took the slot.
    kept = kept.filter(
      ([operation, instance]) =>
        storage.getItem(markerKey(scope, operation, instance)) !== null,
    );
    for (const entry of unlistedStanding(storage, scope, slot))
      if (!kept.some((have) => have[0] === entry[0] && have[1] === entry[1]))
        kept.push(entry);
  } catch {
    return "not-listed";
  }
  for (const entry of additions)
    if (!kept.some((have) => have[0] === entry[0] && have[1] === entry[1]))
      kept.push([entry[0], entry[1]]);
  const text = serializeDirectory(kept);
  // A bound refuses the listing; it never drops one that stands.
  if (kept.length > DIRECTORY_MAX_ENTRIES || text.length > DIRECTORY_MAX_CHARS)
    return "not-listed";
  try {
    if (kept.length === 0) storage.removeItem(directory);
    else storage.setItem(directory, text);
  } catch {
    return "not-listed";
  }
  return "listed";
}

/**
 * The slot lock of a page that has none to use: the page's own `navigator.locks`, when it has Web Locks (a secure context of a supported
 * browser; the app refuses a browser without them, answer Q12), and nothing otherwise.
 */
function pageSlotLocks(): SlotLocks | undefined {
  if (typeof navigator === "undefined") return undefined;
  let manager: LockManager | undefined;
  try {
    manager = navigator.locks;
  } catch {
    return undefined;
  }
  if (manager === undefined || typeof manager.request !== "function")
    return undefined;
  const locks = manager;
  return {
    tryAcquire(name) {
      return new Promise((resolve) => {
        try {
          locks
            .request(name, { ifAvailable: true }, (lock) => {
              if (lock === null) {
                resolve(null);
                return undefined;
              }
              return new Promise<void>((done) => {
                let released = false;
                resolve({
                  release() {
                    if (released) return;
                    released = true;
                    done();
                  },
                });
              });
            })
            .catch(() => resolve(null));
        } catch {
          resolve(null);
        }
      });
    },
  };
}

export interface MarkerOptions {
  /** The page's part of a failure's name (random by default; a test supplies a fixed one). */
  id?: () => string;
  /**
   * The locks that give the page its directory slot. Omitted: the page's own Web Locks. `null`: none (the page lists no failure in a
   * directory; every failure is still recorded by its key, which every reader finds by the snapshot).
   */
  locks?: SlotLocks | null;
  /** Which slot to try first (a test fixes it; by default a random one, so a slot a page has just let go of is not at once taken by the next). */
  slotStart?: () => number;
  /**
   * A page that is already known to own the directory slot `ownSlot` (no lock is asked for). For tests that model neither locks nor
   * page lifetimes; a test of the slot protocol itself does not use it, and no production composition does.
   */
  ownSlot?: number;
}

/**
 * `storage`: the page's `localStorage` (obtained at each use) when omitted. `events`: the feed of other pages' changes; omitted, it is
 * the window's own for the real `localStorage` and none for any storage a caller supplies (a double names its own).
 */
export function createWriteFailureMarkers(
  storageOrUndefined?: MarkerStorage,
  events?: MarkerEvents,
  options: MarkerOptions = {},
): WriteFailureMarkers {
  let kept: MarkerStorage | undefined = storageOrUndefined;
  let refused = false;
  const access = (): Access => {
    if (kept !== undefined) return { kind: "store", storage: kept };
    const found = obtainStorage();
    if (found.kind === "store") kept = found.storage;
    else if (found.kind === "blocked") refused = true;
    return found.kind === "none" && refused ? { kind: "blocked" } : found;
  };
  // The first attempt is made now, as a page asks for its storage when it is built: what it finds (the store, or a refusal) is what a
  // later `none` is measured against.
  access();
  const feed =
    events ??
    (storageOrUndefined === undefined
      ? windowStorageEvents(() => {
          const found = access();
          return found.kind === "store" ? found.storage : undefined;
        })
      : undefined);

  // ---- the page's directory slot --------------------------------------------------------------------------------------------------
  type SlotState =
    | { state: "idle" }
    | { state: "pending"; promise: Promise<number | null> }
    | { state: "held"; slot: number; release(): void }
    | { state: "none" };
  let slotState: SlotState =
    options.ownSlot === undefined
      ? { state: "idle" }
      : { state: "held", slot: options.ownSlot, release: () => undefined };
  /** True after `release` and until `prepare`: nothing takes a slot lazily, so a stopped page does not hold one. */
  let released = false;
  /** Counts releases, so that a slot that was being taken when the page let go is let go of when it arrives. */
  let leases = 0;
  const slotLocks = (): SlotLocks | undefined =>
    options.locks === null ? undefined : (options.locks ?? pageSlotLocks());
  /** Takes the first free slot from a starting point (once at a time); resolves the slot, or null when none could be taken. */
  const takeSlot = (): Promise<number | null> => {
    if (slotState.state === "held") return Promise.resolve(slotState.slot);
    if (slotState.state === "pending") return slotState.promise;
    const locks = slotLocks();
    if (locks === undefined || released) return Promise.resolve(null);
    const lease = leases;
    const given = options.slotStart?.();
    const start =
      given !== undefined
        ? ((Math.trunc(given) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT
        : Math.floor(Math.random() * SLOT_COUNT);
    const promise = (async (): Promise<number | null> => {
      for (let step = 0; step < SLOT_COUNT; step += 1) {
        const slot = (start + step) % SLOT_COUNT;
        let handle: { release(): void } | null = null;
        try {
          handle = await locks.tryAcquire(`${SLOT_LOCK_PREFIX}${slot}`);
        } catch {
          handle = null;
        }
        if (handle === null) continue;
        if (lease !== leases) {
          // The page let go while this was under way: the slot is not kept.
          handle.release();
          return null;
        }
        slotState = { state: "held", slot, release: () => handle?.release() };
        // The failures this page recorded while it held no slot are listed now (their keys stand and are found without it).
        try {
          listUnlisted(slot);
        } catch {
          // The keys stand and the snapshot finds them; the directory is written by the next publication.
        }
        return slot;
      }
      // Every slot is held elsewhere (or no lock could be asked for): asked again by the next publication.
      if (lease === leases) slotState = { state: "none" };
      return null;
    })();
    slotState = { state: "pending", promise };
    return promise;
  };

  // ---- what a page knows ----------------------------------------------------------------------------------------------------------
  /**
   * The markers of a scope that stand (header, obligation 2), and whether the observation is `complete`: the SNAPSHOT of the origin's
   * keys is the authority, the directories add what they list, and the instances this page has established are read again by their
   * exact keys. It is not complete when the snapshot could not be made, a directory is not one, an established key stands that the
   * snapshot did not list, a read was refused or more failures than one observation will check were named; what was found stands all the
   * same, and the absence of anything else is unknown. What it returns is the page's view at that moment and nothing more: a marker
   * another page writes a moment later is not in it, which is why a consumer asks again at the point of use and why ending a failure
   * never depends on one.
   */
  const standing = (storage: MarkerStorage, scope: StopScope): Observed => {
    const found: Standing[] = [];
    const unreadable = new Set<string>();
    const seen = new Set<string>();
    let complete = true;
    let checked = 0;
    const consider = (
      key: string,
      operation: string,
      instance: string,
    ): boolean => {
      if (seen.has(key)) return true;
      seen.add(key);
      checked += 1;
      if (checked > OBSERVATION_MAX_ENTRIES) return false;
      try {
        if (storage.getItem(key) !== null)
          found.push({ key, operation, instance });
      } catch {
        // A failure whose key cannot be read may stand: its operation, and no other, is unknown.
        unreadable.add(operation);
      }
      return true;
    };
    // The directories and the snapshot are read independently: a directory that cannot be read leaves the snapshot to answer.
    try {
      for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
        const raw = storage.getItem(directoryKey(scope, slot));
        if (raw === null) continue;
        const entries = parseDirectory(raw);
        if (entries === null) {
          // A directory that is not one lists nothing anybody can use; the other witness and the other directories still answer.
          complete = false;
          continue;
        }
        for (const [operation, instance] of entries)
          if (
            !consider(
              markerKey(scope, operation, instance),
              operation,
              instance,
            )
          )
            return { found, unreadable, complete: false };
      }
    } catch {
      complete = false;
    }
    const listing = listScope(storage, scope);
    if (listing === null) complete = false;
    else
      for (const entry of listing)
        if (!consider(entry.key, entry.operation, entry.instance))
          return { found, unreadable, complete: false };
    // What this page has established is read again by its exact key (obligation 2 (c)): a listing never makes it forget one.
    const listed = new Set(listing?.map((entry) => entry.key) ?? []);
    const id = scopeId(scope);
    for (const operation of established.operations(id))
      for (const instance of established.get(id, operation) ?? []) {
        const key = markerKey(scope, operation, instance);
        if (listed.has(key)) continue;
        let stands: boolean;
        try {
          stands = storage.getItem(key) !== null;
        } catch {
          unreadable.add(operation);
          continue;
        }
        // Gone: it was removed (a key is never written again), whatever a directory said of it earlier in this read.
        if (!stands) continue;
        if (!seen.has(key)) {
          seen.add(key);
          checked += 1;
          if (checked > OBSERVATION_MAX_ENTRIES)
            return { found, unreadable, complete: false };
          found.push({ key, operation, instance });
        }
        // It stands NOW, after the snapshot that did not list it, and it existed before: the snapshot is contradicted, and says nothing
        // of what else it left out.
        if (listing !== null) complete = false;
      }
    return { found, unreadable, complete };
  };
  /**
   * The markers this page has ESTABLISHED, by scope, operation and instance: the ones it wrote and the ones a read found, until it
   * removed one or a read that completed showed it gone (R47, revision 28). A read that fails cannot say that a marker ended, so it
   * keeps what is here; only the page's own successful removal, or a read that completed, ends one. It is the page's memory of the
   * record, never the record: the markers (`localStorage`) remain what a reload finds.
   */
  const established = new Instances();
  /** The instances this page itself wrote and has not removed: the only ones it replaces when it records a newer failure of the operation. */
  const written = new Instances();
  const stops = createLocalStops();
  // A name for each failure this page records: the page's own random part and a count (unique among the pages of an origin).
  const pageName = ((): string => {
    const given = options.id?.() ?? randomPart();
    const clean = given
      .toLowerCase()
      .replace(/[^0-9a-z-]/g, "-")
      .slice(0, 64);
    return clean === "" ? randomPart() : clean;
  })();
  let failures = 0;
  const nameFailure = (): string => {
    failures += 1;
    return `${pageName}.${failures}`;
  };
  /**
   * The removals this page owes, by key: a success, a retry or a replacement ended the marker, but its removal threw (or the store
   * could not be obtained). The key names the failure exactly, so the removal is simply made again by the next read, and cannot reach
   * any other failure. In memory only: a reload forgets it, and the marker then stands (the disclosed limitation of a retirement and a
   * reload that both fail).
   */
  const owed = new Map<
    string,
    { scope: StopScope; operation: string; instance: string }
  >();
  const isOwed = (
    scope: StopScope,
    operation: string,
    instance: string,
  ): boolean => owed.has(markerKey(scope, operation, instance));
  /**
   * The failures this page recorded whose keys no directory of this page lists yet (it held no slot, or the directory could not be
   * written), by key. The keys stand and the snapshot finds them; `listUnlisted` lists them when the page holds a slot. A failure that
   * ends leaves this map with it (`gone`), so a listing made later is only ever made for a key that still stands (R58): nothing that
   * arrives late can bring a recovered failure back.
   */
  const unlisted = new Map<
    string,
    { scope: StopScope; operation: string; instance: string }
  >();
  /** The marker is gone as far as this page is concerned: it removed the key, or a read that completed did not find it. */
  const gone = (
    scope: StopScope,
    operation: string,
    instance: string,
  ): void => {
    owed.delete(markerKey(scope, operation, instance));
    unlisted.delete(markerKey(scope, operation, instance));
    established.remove(scopeId(scope), operation, instance);
    written.remove(scopeId(scope), operation, instance);
  };
  /**
   * Removes ONE marker by its exact key. A removal that threw is owed (`owe`): the page ended the marker and the store refused, so the
   * next read makes the removal. The person's own explicit act and `clear` owe nothing: a removal that threw leaves the marker
   * established and standing, and the person's next act tries again.
   */
  const remove = (
    storage: MarkerStorage,
    scope: StopScope,
    operation: string,
    instance: string,
    owe = true,
  ): boolean => {
    try {
      storage.removeItem(markerKey(scope, operation, instance));
      gone(scope, operation, instance);
      return true;
    } catch {
      if (owe)
        owed.set(markerKey(scope, operation, instance), {
          scope,
          operation,
          instance,
        });
      return false;
    }
  };
  /**
   * What this page can say of the marker when no read completed: what it established, or nothing. A removal that returned is
   * deliberately NOT remembered (R47, revision 30). It established that the key was gone at that moment; a marker another page
   * writes later is a NEW stop, and the only things that can tell this page of it are a read that completes (asked at the point of
   * use, every time) or a `storage` notification, which the browser may deliver late and which a consumer must not be the only
   * protection against. With neither, the answer is `unknown`.
   */
  const believed = (scope: StopScope, operation: string): MarkerSeen => {
    // An instance that this page has ended, though the removal could not be made (it is OWED), is not known to stand: what is unknown
    // is whether a NEWER one does, and the answer to that is the next read that completes.
    const instances = [...(established.get(scopeId(scope), operation) ?? [])]
      .filter((instance) => !isOwed(scope, operation, instance))
      .sort();
    return instances.length === 0
      ? { kind: "unread" }
      : { kind: "instance", instances };
  };
  /**
   * The removals this page owes for `scope`, made now: an exact key is removed whether or not it is listed (removing a key that is gone
   * changes nothing). What was removed leaves `listed`.
   */
  const settle = (
    storage: MarkerStorage,
    scope: StopScope,
    listed: Standing[],
  ): void => {
    const id = scopeId(scope);
    for (const due of [...owed.values()]) {
      if (scopeId(due.scope) !== id) continue;
      const key = markerKey(scope, due.operation, due.instance);
      if (remove(storage, scope, due.operation, due.instance)) {
        const at = listed.findIndex((entry) => entry.key === key);
        if (at >= 0) listed.splice(at, 1);
      }
    }
  };
  /** What a read that completed establishes of ONE operation (and forgets of what it no longer finds). */
  const learn = (
    scope: StopScope,
    operation: string,
    instances: readonly string[],
  ): void => {
    const id = scopeId(scope);
    established.replace(id, operation, instances);
    written.replace(
      id,
      operation,
      [...(written.get(id, operation) ?? [])].filter((instance) =>
        instances.includes(instance),
      ),
    );
  };
  /**
   * What ONE read of the marker says, as instances (R47, revisions 28 to 30; R50, revision 31; R52, revision 32; R55, revision 33): a
   * read that completed says what stands now; one that could not be completed says what this page established, or nothing.
   */
  const see = (scope: StopScope, operation: string): MarkerSeen => {
    const found = access();
    if (found.kind === "none") return { kind: "none" };
    if (found.kind === "blocked") return believed(scope, operation);
    const observed = standing(found.storage, scope);
    // The removals this page owes are made by a read that LANDS (R47): an observation that could not be completed makes none.
    if (observed.complete) settle(found.storage, scope, observed.found);
    const instances = observed.found
      .filter((entry) => entry.operation === operation)
      .map((entry) => entry.instance)
      .sort();
    // A failure of this operation is listed and its key cannot be read: it may stand, and this page cannot say. What it has established
    // stands, and what it has not is unknown (never absent).
    if (observed.unreadable.has(operation)) {
      const known = believed(scope, operation);
      const merged = new Set([
        ...instances,
        ...(known.kind === "instance" ? known.instances : []),
      ]);
      return merged.size === 0
        ? { kind: "unread" }
        : { kind: "instance", instances: [...merged].sort() };
    }
    // A witness could not be completed (R55): what the other found stands, and is established by this page; the absence of anything
    // else is not known. Nothing is forgotten, and nothing is learnt as ended.
    if (!observed.complete) {
      for (const instance of instances)
        established.add(scopeId(scope), operation, instance);
      const known = believed(scope, operation);
      return known.kind === "instance"
        ? { kind: "instance", instances: known.instances }
        : { kind: "unread" };
    }
    learn(scope, operation, instances);
    return instances.length === 0
      ? { kind: "none" }
      : { kind: "instance", instances };
  };
  /** The answer of `see` as `probe` gives it (R47): a marker that stands is `marked`, whether or not it could be named. */
  const probe = (scope: StopScope, operation: string): MarkerState =>
    markerStateOf(see(scope, operation));
  const inspect = (scope: StopScope): MarkerRead => {
    const id = scopeId(scope);
    const found = access();
    if (found.kind === "none") return { operations: [], known: true };
    if (found.kind !== "store")
      return {
        // An instance that has been ended (owed its removal) is not a stop this page knows of: what it cannot know is whether a newer
        // one stands, and that is `known: false`.
        operations: established
          .operations(id)
          .filter((operation) =>
            [...(established.get(id, operation) ?? [])].some(
              (instance) => !isOwed(scope, operation, instance),
            ),
          ),
        known: false,
      };
    const observed = standing(found.storage, scope);
    if (observed.complete) settle(found.storage, scope, observed.found);
    const byOperation = new Map<string, string[]>();
    for (const entry of observed.found)
      byOperation.set(entry.operation, [
        ...(byOperation.get(entry.operation) ?? []),
        entry.instance,
      ]);
    // A witness could not be completed (R55): what was found stands and is established; what the page had established stays; nothing is
    // learnt as ended, and the read says it is not whole.
    if (!observed.complete) {
      for (const [operation, instances] of byOperation)
        for (const instance of instances)
          established.add(id, operation, instance);
      return {
        operations: established
          .operations(id)
          .filter((operation) =>
            [...(established.get(id, operation) ?? [])].some(
              (instance) => !isOwed(scope, operation, instance),
            ),
          ),
        known: false,
      };
    }
    // What a read finds the page establishes, by name (a few keys, and none on a healthy page): a later success can then end exactly
    // those instances even if the store becomes unreadable before it is delivered (R50, revision 31). An operation whose listed key could
    // not be read keeps what the page established of it and is not forgotten.
    for (const operation of established.operations(id))
      if (!byOperation.has(operation) && !observed.unreadable.has(operation))
        learn(scope, operation, []);
    for (const [operation, instances] of byOperation)
      if (!observed.unreadable.has(operation))
        learn(scope, operation, instances.sort());
    // An unreadable key leaves the read incomplete (`known: false`): the operations it concerns are those the page has found or
    // established, and it cannot say that no other stands.
    for (const operation of observed.unreadable)
      if (
        !byOperation.has(operation) &&
        [...(established.get(id, operation) ?? [])].some(
          (instance) => !isOwed(scope, operation, instance),
        )
      )
        byOperation.set(operation, []);
    return {
      operations: [...byOperation.keys()],
      known: observed.unreadable.size === 0,
    };
  };

  // ---- recording a failure --------------------------------------------------------------------------------------------------------
  /**
   * Lists in this page's directory (slot `slot`) the failures it recorded while it held none, for each scope it recorded them in. A
   * key that no longer stands is not listed and is forgotten. A directory that cannot be written leaves them where they are (found by
   * the listing) for the next time. Synchronous: nothing awaits between the look at a key and the write that lists it.
   */
  const listUnlisted = (slot: number): void => {
    const found = access();
    if (found.kind !== "store" || unlisted.size === 0) return;
    const byScope = new Map<
      string,
      { scope: StopScope; entries: Array<[string, string]>; keys: string[] }
    >();
    for (const [key, due] of [...unlisted]) {
      let stands = false;
      try {
        stands = found.storage.getItem(key) !== null;
      } catch {
        continue;
      }
      if (!stands) {
        unlisted.delete(key);
        continue;
      }
      const group = byScope.get(scopeId(due.scope)) ?? {
        scope: due.scope,
        entries: [],
        keys: [],
      };
      group.entries.push([due.operation, due.instance]);
      group.keys.push(key);
      byScope.set(scopeId(due.scope), group);
    }
    for (const group of byScope.values())
      if (
        writeDirectory(found.storage, group.scope, slot, group.entries) ===
        "listed"
      )
        for (const key of group.keys) unlisted.delete(key);
  };

  /**
   * Records ONE failure: its key is written NOW (R58), listed in this page's directory first when the page holds a slot, so that a key
   * that stands is listed by the page that wrote it. A directory that cannot be written costs positive discovery and not the record:
   * the key is written anyway, and found by the snapshot. The directory is written first, the key second: a page that stops between
   * the two leaves a listing whose key is not there, which ends nothing and is dropped by the next write. Nothing awaits in here, and
   * the last look at the lifetime (R56) is in the step of the first write.
   */
  const publish = (
    storage: MarkerStorage,
    scope: StopScope,
    operation: string,
    instance: string,
    slot: number | null,
    live: (() => boolean) | undefined,
  ): PublicationOutcome => {
    if (live !== undefined && !live()) return "obsolete";
    const key = markerKey(scope, operation, instance);
    const listed =
      slot === null
        ? "not-listed"
        : writeDirectory(storage, scope, slot, [[operation, instance]]);
    try {
      storage.setItem(key, MARKED);
    } catch {
      // Not recorded: the listing is put back, so that it does not claim a failure that has no key (the write drops it, its key being
      // absent).
      if (slot !== null && listed === "listed")
        writeDirectory(storage, scope, slot, []);
      return "unavailable";
    }
    if (listed === "not-listed")
      unlisted.set(key, { scope, operation, instance });
    // A newer failure has a name of its own: what an earlier success is owed (an older name) never matches it, and removing an older
    // name cannot reach it.
    const id = scopeId(scope);
    established.add(id, operation, instance);
    // The operation is marked by the new instance now, so the page's own older ones are redundant and go (a page that fails again and
    // again leaves one marker per operation). Only the page's OWN: another page's instance is its writer's. A removal that throws is owed.
    for (const older of [...(written.get(id, operation) ?? [])])
      remove(storage, scope, operation, older);
    written.add(id, operation, instance);
    return "recorded";
  };

  return {
    stops,
    set(scope, operation, live) {
      const finished = (outcome: PublicationOutcome): Publication => ({
        state: outcome,
        settled: Promise.resolve(outcome),
      });
      if (live !== undefined && !live()) return finished("obsolete");
      const found = access();
      if (found.kind !== "store") return finished("unavailable");
      const instance = nameFailure();
      // The failure is written NOW. A page that holds no slot asks for one (the failure does not wait for it) and lists it when the
      // slot arrives; a page that was released asks for none.
      let slot: number | null = null;
      if (slotState.state === "held") slot = slotState.slot;
      else if (!released) void takeSlot();
      return finished(
        publish(found.storage, scope, operation, instance, slot, live),
      );
    },
    clear(scope, operation) {
      const found = access();
      if (found.kind !== "store") return;
      const observed = standing(found.storage, scope);
      for (const entry of observed.found)
        if (entry.operation === operation)
          remove(found.storage, scope, operation, entry.instance, false);
    },
    witness: see,
    retire(scope, operation, seen, options) {
      if (seen.kind !== "instance") return false;
      const found = access();
      if (found.kind === "none") return false;
      const explicit = options?.explicit === true;
      let removed = false;
      for (const instance of seen.instances) {
        if (found.kind === "blocked") {
          if (!explicit)
            owed.set(markerKey(scope, operation, instance), {
              scope,
              operation,
              instance,
            });
          continue;
        }
        // Removing a key that is gone already changes nothing; what is answered is whether this page believed the instance stood.
        const stood =
          established.get(scopeId(scope), operation)?.has(instance) === true;
        if (
          remove(found.storage, scope, operation, instance, !explicit) &&
          stood
        )
          removed = true;
      }
      return removed;
    },
    has: (scope, operation) => probe(scope, operation) === "marked",
    probe,
    operations: (scope) => inspect(scope).operations,
    inspect,
    clearAccount(account) {
      const found = access();
      if (found.kind === "store") {
        // Housekeeping only: the origin's keys are listed to be REMOVED, never to decide anything. A key this listing misses is
        // unreachable (it names a lifetime nothing reads) and costs a few bytes.
        const prefixes = [
          `${MARKER_PREFIX}${enc(account)}:`,
          `${DIRECTORY_PREFIX}${enc(account)}:`,
        ];
        try {
          // The snapshot when it can be made, a walk of the indices otherwise: removing decides nothing, so either will do.
          let all = snapshotKeys(found.storage);
          if (all === null) {
            const walked: string[] = [];
            for (let index = 0; index < found.storage.length; index += 1) {
              const key = found.storage.key(index);
              if (key !== null) walked.push(key);
            }
            all = walked;
          }
          const keys = all.filter(
            (key) =>
              typeof key === "string" &&
              prefixes.some((p) => key.startsWith(p)),
          );
          for (const key of keys) {
            try {
              found.storage.removeItem(key);
            } catch {
              // best effort
            }
          }
        } catch {
          // best effort
        }
      }
      // The account's database is gone with them: nothing it established is left to protect.
      established.clearAccount(account);
      written.clearAccount(account);
      for (const [key, due] of [...owed])
        if (due.scope.account === account) owed.delete(key);
      for (const [key, due] of [...unlisted])
        if (due.scope.account === account) unlisted.delete(key);
      stops.clearAccount(account);
    },
    prepare: async () => {
      released = false;
      return (await takeSlot()) !== null;
    },
    release() {
      released = true;
      leases += 1;
      if (slotState.state === "held") slotState.release();
      slotState = { state: "idle" };
    },
    subscribe(listener) {
      if (feed === undefined) return () => undefined;
      return feed.subscribe((key) => {
        // Other keys of the origin are none of ours, and a directory says nothing a failure's own key does not (the key is the truth,
        // and it is written after the directory); a cleared storage (`null`) may have taken any marker with it.
        if (key !== null && !key.startsWith(MARKER_PREFIX)) return;
        const parsed = key === null ? null : parseMarkerKey(key);
        listener({
          touches: (account, operation) => {
            if (key === null) return true;
            if (parsed === null) return false;
            if (parsed.account !== account) return false;
            return operation === undefined || parsed.operation === operation;
          },
        });
      });
    },
  };
}

/**
 * Records the stop of an operation whose counter could not be written (the fallback of WEB-04 design 5.12), for a writer that has
 * just seen the counter fail: the marker of the scope's lifetime, or, when that cannot be written, the page's memory (the writer's own:
 * `memory.hold` takes the hold).
 *
 *   * `marker`: durable now. Its key is written in this step (R58): nothing is left to be published later, so no recovery can be
 *     followed by the failure it recovered, whatever the page's slot or locks are doing.
 *   * `memory`: held in the page's memory, which the writer discloses: the marker could not be written (no store, a refused write).
 *   * `obsolete`: the lifetime ended before anything could be written (`live` said so). Nothing was recorded, held or to be shown: the
 *     callback belongs to a database that no longer exists, and a stop must not be created in the replacement's name (R56).
 */
export function recordStop(
  markers: WriteFailureMarkers | undefined,
  scope: StopScope,
  operation: string,
  live: () => boolean,
  memory: { hold(): void },
): "marker" | "memory" | "obsolete" {
  if (!live()) return "obsolete";
  const published = markers?.set(scope, operation, live);
  if (published?.state === "obsolete") return "obsolete";
  if (published?.state === "recorded") return "marker";
  memory.hold();
  return "memory";
}

/**
 * The stops of some operations as they stood when an act began (R50 and R51, revision 31): per operation, the page's memory hold
 * (its instance) and the marker (`MarkerSeen`). A write takes it BEFORE it is issued and a success retires what it names AFTER, so
 * that a result that is delivered late ends the failures it could have recovered and no newer one.
 */
export interface StopWitness {
  readonly scope: StopScope;
  readonly stood: ReadonlyMap<
    string,
    { memory: string | null; marker: MarkerSeen }
  >;
}

/** Takes the witness of `operations` for `scope`: synchronous, a read of the page's memory and of each marker. */
export function witnessStops(
  markers: WriteFailureMarkers | undefined,
  stops: LocalStops,
  scope: StopScope,
  operations: Iterable<string>,
): StopWitness {
  const stood = new Map<
    string,
    { memory: string | null; marker: MarkerSeen }
  >();
  for (const operation of operations)
    if (!stood.has(operation))
      stood.set(operation, {
        memory: stops.instance(scope, operation),
        marker: markers?.witness(scope, operation) ?? { kind: "none" },
      });
  return { scope, stood };
}

/**
 * Ends the stops a witness saw, and only those: a hold or a marker recorded since is a newer failure and stays (R50, revision 31).
 * `operations` narrows it to some of the operations the witness covers. `explicit` is the person's own retry (or an abandonment), whose
 * removal of a marker is not owed if it cannot be made; no success is explicit. Answers the operations that had a hold or a marker
 * ended.
 */
export function retireStops(
  markers: WriteFailureMarkers | undefined,
  stops: LocalStops,
  witness: StopWitness,
  options: { operations?: Iterable<string>; explicit?: boolean } = {},
): string[] {
  const ended: string[] = [];
  const named =
    options.operations === undefined ? null : new Set(options.operations);
  for (const [operation, stood] of witness.stood) {
    if (named !== null && !named.has(operation)) continue;
    let did = false;
    if (
      stood.memory !== null &&
      stops.release(witness.scope, operation, stood.memory)
    )
      did = true;
    if (
      markers?.retire(witness.scope, operation, stood.marker, {
        explicit: options.explicit === true,
      }) === true
    )
      did = true;
    if (did) ended.push(operation);
  }
  return ended;
}

/** The operations whose marker could not be read, and no instance of it named, when the witness was taken. */
export function unreadStops(witness: StopWitness): string[] {
  return [...witness.stood]
    .filter(([, stood]) => stood.marker.kind === "unread")
    .map(([operation]) => operation);
}

/** A random part for a page's failure names: a UUID where the platform has one, and random digits otherwise. */
function randomPart(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid !== undefined) return uuid;
  } catch {
    // Fall through to the weaker source.
  }
  return `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

function obtainStorage(): Access {
  try {
    return typeof localStorage === "undefined"
      ? { kind: "none" }
      : { kind: "store", storage: localStorage };
  } catch {
    // Access to localStorage itself can throw (blocked site data): that is "could not read", not "nothing there" (R47, revision 29).
    return { kind: "blocked" };
  }
}

import type { RowOf, StoreName } from "../model/schema";
import type { AccountId } from "../model/types";

/**
 * The store port and the transaction plan (plan 5.1.1, decision D-02). Types only: nothing here touches a browser global.
 *
 * Every operation is a PLAN: `read` prefetches inside the transaction, a PURE `decide` makes every decision (guards,
 * refusals, small writes), and `apply` streams large writes. All three run in ONE transaction, with no non-IndexedDB `await`
 * inside it. That keeps the decision in the transaction body (the 08a round-3 lesson), makes every decision testable without
 * I/O, and lets a sync page stream (D-08).
 */
export type Key = string | number | readonly (string | number)[];

export type KeyRange =
  | { kind: "all" }
  | { kind: "only"; value: Key }
  | {
      kind: "range";
      lower?: Key;
      upper?: Key;
      lowerOpen?: boolean;
      upperOpen?: boolean;
    };
export const range = {
  all: (): KeyRange => ({ kind: "all" }),
  only: (value: Key): KeyRange => ({ kind: "only", value }),
  between: (
    lower: Key,
    upper: Key,
    options: { lowerOpen?: boolean; upperOpen?: boolean } = {},
  ): KeyRange => ({ kind: "range", lower, upper, ...options }),
  atLeast: (lower: Key, lowerOpen = false): KeyRange => ({
    kind: "range",
    lower,
    lowerOpen,
  }),
  atMost: (upper: Key, upperOpen = false): KeyRange => ({
    kind: "range",
    upper,
    upperOpen,
  }),
};

/**
 * Valid only inside the transaction of a plan: its `read`, and its `apply` (which is handed the same reader, so a streaming apply can
 * look up only what the part of a page it has reached names, and never has to prefetch the population of local work it might touch).
 * Reading a store outside the plan's `scope` throws.
 */
export interface Reader {
  get<K extends StoreName>(store: K, key: Key): Promise<RowOf<K> | undefined>;
  bulkGet<K extends StoreName>(
    store: K,
    keys: readonly Key[],
  ): Promise<(RowOf<K> | undefined)[]>;
  /**
   * Rows by an index, in index order then primary-key order. `limit` bounds the result (default: unbounded) and `offset` skips that
   * many rows first, so a result larger than the working set can be walked a window at a time.
   */
  byIndex<K extends StoreName>(
    store: K,
    index: string,
    range: KeyRange,
    limit?: number,
    offset?: number,
  ): Promise<RowOf<K>[]>;
  /**
   * The rows whose key in `index` is ANY of `keys`, in index order then primary-key order: one lookup of a batch of ids, whatever
   * the size of the store. A row with several matching entries of a multi-entry index may appear once per entry.
   */
  anyOf<K extends StoreName>(
    store: K,
    index: string,
    keys: readonly Key[],
    limit?: number,
  ): Promise<RowOf<K>[]>;
  /**
   * A KEYSET page of ONE index key (R14): the rows whose key in `index` is `key` and whose PRIMARY key sorts after `after` (every row
   * when omitted), in primary-key order, keeping only those whose fields equal every entry of `match` (the others are skipped inside
   * the store and never returned), at most `limit`. Passing the last primary key of a page as the next `after` meets every row once,
   * whatever is added or removed between the reads: unlike `offset`, nothing shifts. The store's primary key must be a single string
   * (an id).
   */
  pageByKey<K extends StoreName>(
    store: K,
    index: string,
    key: Key,
    options: {
      after?: string;
      match?: Readonly<Record<string, unknown>>;
      limit: number;
    },
  ): Promise<RowOf<K>[]>;
  /** Every row of a store in primary-key order, bounded by `limit`. */
  list<K extends StoreName>(store: K, limit?: number): Promise<RowOf<K>[]>;
  /**
   * Without an index, the rows of the store. With one, that index's ENTRIES in the range (default: all of them): a row with no key
   * in a nested or optional index is not counted. Bodies are never read, so a count is how a list or a summary stays small.
   */
  count(store: StoreName, index?: string, range?: KeyRange): Promise<number>;
}

export type Write =
  | { op: "put"; store: StoreName; row: object }
  | { op: "bulkPut"; store: StoreName; rows: readonly object[] }
  | { op: "delete"; store: StoreName; key: Key }
  | { op: "bulkDelete"; store: StoreName; keys: readonly Key[] }
  | { op: "clear"; store: StoreName };

/** Typed constructors, so a row of the wrong shape does not compile. */
export const w = {
  put: <K extends StoreName>(store: K, row: RowOf<K>): Write => ({
    op: "put",
    store,
    row: row as object,
  }),
  bulkPut: <K extends StoreName>(
    store: K,
    rows: readonly RowOf<K>[],
  ): Write => ({ op: "bulkPut", store, rows: rows as readonly object[] }),
  delete: (store: StoreName, key: Key): Write => ({
    op: "delete",
    store,
    key,
  }),
  bulkDelete: (store: StoreName, keys: readonly Key[]): Write => ({
    op: "bulkDelete",
    store,
    keys,
  }),
  clear: (store: StoreName): Write => ({ op: "clear", store }),
};

/** The streaming writer of `apply` (one change at a time, so a 64,000-change page needs no 64,000-row array). */
export interface WriteSink {
  put<K extends StoreName>(store: K, row: RowOf<K>): Promise<void>;
  delete(store: StoreName, key: Key): Promise<void>;
  /** In the order given. A page is applied in chunks, so a 64,000-change page is 640 calls and never one 64,000-row array. */
  bulkPut<K extends StoreName>(
    store: K,
    rows: readonly RowOf<K>[],
  ): Promise<void>;
  bulkDelete(store: StoreName, keys: readonly Key[]): Promise<void>;
}

export interface Decision<O> {
  writes: readonly Write[];
  result: O;
}

export interface Plan<I, R, O> {
  /** The transaction label (diagnostics and fault injection). */
  readonly name: string;
  /** EVERY store touched, reads included (D:1730). */
  readonly scope: readonly StoreName[];
  readonly mode: "readonly" | "readwrite";
  /** `strict` for the user-visible promise (drafts, outbox state, fence, `form_recovery`); `default` for cache pages (D-03). */
  readonly durability: "strict" | "default";
  /** Only `Reader` calls may be awaited here (lint rule R14, and a test). */
  read(reader: Reader, input: I): Promise<R>;
  /** PURE and SYNCHRONOUS. A refusal returns no writes. */
  decide(reads: R, input: I): Decision<O>;
  /**
   * Streaming page apply (D-08). May throw `PlanRejected`, which aborts the transaction. It is handed the transaction's `Reader`: it
   * sees every write the transaction has made so far, so it can look up in bounded batches what the part of the page it has reached
   * names, and read-modify-write in windows.
   */
  apply?(
    sink: WriteSink,
    decision: Decision<O>,
    reads: R,
    input: I,
    reader: Reader,
  ): Promise<O>;
}

/** Thrown from `apply`: the whole transaction aborts, so every earlier streamed write rolls back. */
export class PlanRejected extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
  ) {
    super(`plan rejected at ${stage}: ${reason}`);
    this.name = "PlanRejected";
  }
}

export type StoreFailureCause =
  | "quota"
  | "abort"
  | "error"
  | "blocked"
  | "closed"
  | "absent"
  | "plan_rejected";

/** A fixed, closed set; it never carries a message that could hold content. */
export class StoreFailure extends Error {
  constructor(
    readonly cause: StoreFailureCause,
    readonly detail?: { stage: string; reason: string },
  ) {
    super(`store failure: ${cause}`);
    this.name = "StoreFailure";
  }
}

/**
 * Structural, not `instanceof`: the mutation harness loads a patched COPY of this module, and a failure thrown by the double
 * (the original module) must still be recognised by the copy.
 */
export function isStoreFailure(error: unknown): error is StoreFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "StoreFailure" &&
    typeof (error as { cause?: unknown }).cause === "string"
  );
}

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  /** The database is absent or latched: the view shows nothing and CREATES nothing. */
  | { status: "unavailable"; reason: "absent" | "closed" | "error" };

export interface Watchable<T> {
  get(): Loadable<T>;
  subscribe(listener: () => void): () => void;
}

export interface RunOptions {
  /**
   * Ends the transaction when it fires. A transaction that has not started (queued behind another one), that is reading or that
   * is applying is ABORTED, so nothing of it is ever durable, and `run` rejects with `StoreFailure("abort")`. A transaction that is
   * already committing cannot be aborted: it completes, and `run` reports its real outcome. A signal that has already fired
   * refuses before a transaction is created. It is how a persistence hold that has run out (`PersistenceHold.revoked`) stops a
   * commit it can no longer vouch for, whatever the engine is doing with it: a wait in the engine's own queue has no other deadline.
   */
  signal?: AbortSignal;
}

export interface AccountStore {
  readonly account: AccountId;
  /** Captured when this handle was opened. */
  readonly incarnationId: string;
  run<I, R, O>(plan: Plan<I, R, O>, input: I, options?: RunOptions): Promise<O>;
  /** A live view of a READONLY plan: re-evaluated when the data changes, in this page or another. */
  watch<I, R, O>(plan: Plan<I, R, O>, input: I): Watchable<O>;
  /** Idempotent. */
  close(): void;
}

/** How a store handle for an account is obtained. The Dexie adapter and the test double implement it. */
export type OpenResult =
  | { kind: "opened"; store: AccountStore; created: boolean }
  | { kind: "absent" };

/** Each plan is registered here so the inventory test (R18, F-S7) can see every writer. */
export interface PlanRegistration {
  plan: Plan<never, never, unknown>;
  guards: readonly string[];
}

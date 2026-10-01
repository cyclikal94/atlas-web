import type { AuthRecords } from "../model/types";

/** `strict` for the four request-class covers, recordings and closing writes; `default` for exposure covers and the canary. */
export type Durability = "strict" | "default";

/** What a transaction body decides: the records to write (null commits nothing) and the value `complete` settles with. */
export interface Rmw<T> {
  write: Partial<AuthRecords> | null;
  result: T;
}

export type StoreErrorCause =
  | "abort"
  | "quota"
  | "error"
  | "blocked"
  | "closed"
  /** A stored record is present and malformed. Nothing was written: a reset would discard fences (EC-02). */
  | "corrupt";
export class StoreError extends Error {
  constructor(readonly cause: StoreErrorCause) {
    super(cause);
    this.name = "StoreError";
  }
}

export interface PendingTransaction<T> {
  /** Settles at the transaction's `complete` with the body's result, or rejects with a StoreError at `error` or `abort`. */
  readonly complete: Promise<T>;
}

/**
 * One object store in one database. `transact` returns synchronously, so transaction creation order is call order;
 * that order is the ordering the protocol's arguments rest on (IndexedDB 2.7.2, matrix 3.11).
 */
export interface AuthStore {
  /**
   * `body` runs once, synchronously, inside the transaction, on a structured clone of the records. It sees every
   * change of every earlier-created overlapping transaction and no interleaving, and no transaction created later
   * starts until this one has finished. That is what lets a body take a decision that must be ATOMIC with its read (the
   * release of a stamped answer, `kernel/send.ts`): it makes the decision in the body and does not wait for `complete`,
   * which is delivered later and, to a busy page, later still.
   */
  transact<T>(
    body: (records: Readonly<AuthRecords>) => Rmw<T>,
    options?: {
      durability?: Durability;
      /** A name for diagnostics and for the fake world's fault injection; ignored in production. */
      label?: string;
    },
  ): PendingTransaction<T>;
}

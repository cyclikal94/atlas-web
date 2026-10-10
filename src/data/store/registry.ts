import type { AccountId } from "../model/types";

/**
 * The static connection registry of THIS page (plan 5.1.2). It is deliberately tiny and imports no Dexie: it is loaded at
 * boot with the port shims, so `closeOwnConnections` works whether or not the Dexie chunk has loaded.
 *
 * It records every open connection by account, holds the per-account latch, and carries the page's `tab_id`. A latched
 * account refuses every plan with `StoreFailure("closed")` until `openAccountData` is called again through its predicate, so
 * a late commit CANNOT re-create a wiped database.
 */
export type Latch =
  | "open"
  /** A wipe is imminent or the database was deleted: no connection may be re-opened by a late writer. */
  | "closed_for_deletion"
  /** This page's identity left the account (a switch, a sign-out). */
  | "closed_for_identity"
  /** A newer build upgraded the database: this page must reload. */
  | "upgrade_pending";

export interface Closable {
  close(): void;
}

export interface ConnectionRegistry {
  readonly tabId: string;
  register(account: AccountId, connection: Closable): () => void;
  openCount(account: AccountId): number;
  latch(account: AccountId): Latch;
  setLatch(account: AccountId, latch: Latch): void;
  /**
   * How many CLOSURES of the account this page has seen (R37, revision 21): every `closeAll` and every latch to anything but `open`. It
   * only goes up, per account, and the new value is visible to a latch listener. An open reads it when it is asked for and a closure
   * since then has ended its lifetime: what the latch's current value cannot say, because a deliberately authorised new open also begins
   * while the account is latched and lifts that latch when it finishes.
   */
  generation(account: AccountId): number;
  /** Closes every connection of the account (synchronously), then latches it. Idempotent; never rejects. */
  closeAll(account: AccountId, options?: { latch?: Latch }): void;
  /** Observers of latch changes (a status screen, the account service). */
  onLatch(listener: (account: AccountId, latch: Latch) => void): () => void;
}

export function createRegistry(tabId: string): ConnectionRegistry {
  const connections = new Map<AccountId, Set<Closable>>();
  const latches = new Map<AccountId, Latch>();
  const generations = new Map<AccountId, number>();
  const listeners = new Set<(account: AccountId, latch: Latch) => void>();
  const close = (account: AccountId): void => {
    generations.set(account, (generations.get(account) ?? 0) + 1);
  };
  const setLatch = (account: AccountId, latch: Latch): void => {
    // A latch to anything but `open` is a closure even when it changes nothing (the account was latched already): an open that began in
    // between must still be ended by it. Lifting a latch is not one.
    if (latch !== "open") close(account);
    if ((latches.get(account) ?? "open") === latch) return;
    latches.set(account, latch);
    for (const listener of [...listeners]) listener(account, latch);
  };
  return {
    tabId,
    register(account, connection) {
      let set = connections.get(account);
      if (!set) {
        set = new Set();
        connections.set(account, set);
      }
      set.add(connection);
      return () => {
        connections.get(account)?.delete(connection);
      };
    },
    openCount: (account) => connections.get(account)?.size ?? 0,
    latch: (account) => latches.get(account) ?? "open",
    setLatch,
    generation: (account) => generations.get(account) ?? 0,
    closeAll(account, options) {
      // Counted FIRST, whatever the latch and whether or not anything is registered: an open that has not registered its connections yet
      // is ended by this closure too.
      close(account);
      // Latch FIRST: a plan that starts in the same turn sees the latch and refuses, instead of racing the close.
      setLatch(account, options?.latch ?? "closed_for_deletion");
      const set = connections.get(account);
      if (!set) return;
      for (const connection of [...set]) {
        try {
          connection.close();
        } catch {
          // A connection that cannot be closed is already unusable; closing is best effort and must never throw.
        }
      }
      set.clear();
    },
    onLatch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let page: ConnectionRegistry | null = null;
/** The page's registry (memoised). The tab id is a random UUID, fresh per page load. */
export function getPageRegistry(): ConnectionRegistry {
  page ??= createRegistry(globalThis.crypto.randomUUID());
  return page;
}

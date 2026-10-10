/**
 * The raw-IndexedDB host (plan 5.3.2): the three things the deletion ports and the open predicate need to know about ANY
 * account's database, independent of Dexie. The browser implementation (`idb-host.ts`) is a thin shim over `indexedDB`; the
 * test double (`tests/support/data/fake-idb.ts`) implements the same interface with simulated connections, so the logic of
 * the ports is tested over the double and the shim is proved in three real engines.
 *
 * `deleteDatabase` is referenced ONLY in `idb-host.ts` (lint rule R16).
 */
export type ProbeResult =
  | { kind: "absent" }
  | { kind: "present"; incarnation: string | null };

export interface DatabaseHost {
  /**
   * The names of the existing databases. REJECTS when `indexedDB.databases()` is missing or throws: an unknown answer is
   * never "absent" (MU-41).
   */
  list(): Promise<readonly string[]>;
  /**
   * Opens an EXISTING database with no version, reads `sync_state.incarnation_id` and closes. An `upgradeneeded` event
   * means the database vanished: the upgrade is aborted (the engine discards the new database) and the answer is `absent`.
   * A probe that fails or does not answer within `timeoutMs` REJECTS.
   */
  probe(name: string, timeoutMs: number): Promise<ProbeResult>;
  /**
   * `deleteDatabase`. `blocked` is remembered and NEVER resolves the promise; `success` resolves `deleted` (or
   * `blocked_then_deleted` when `blocked` fired first); `error` resolves `error`.
   */
  delete(name: string): Promise<"deleted" | "blocked_then_deleted" | "error">;
}

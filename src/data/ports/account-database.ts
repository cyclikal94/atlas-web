import type { WriteFailureMarkers } from "../engine/write-failure-marker";
import { DATA_CONFIG } from "../model/config";
import { accountDatabaseName } from "../model/schema";
import type { AccountId } from "../model/types";
import type { DatabaseHost } from "../store/host";
import type { ConnectionRegistry } from "../store/registry";
import type { AccountDatabasePort } from "./types";

/**
 * The real `AccountDatabasePort` (plan 5.3.2). It uses RAW IndexedDB through the `DatabaseHost` and the static registry, never
 * Dexie, so it works before the Dexie chunk has loaded and adds almost nothing to the initial bundle.
 *
 * The contract it keeps (docs/session.md, obligation 1):
 *  - `exists` goes through `indexedDB.databases()` and REJECTS when that is missing or throws: an unknown answer is never
 *    "absent" (MU-41), because the wipe would then conclude "nothing to delete" about data it cannot see;
 *  - nothing here ever creates a database (a probe whose upgrade fires aborts it);
 *  - `delete` never resolves on `blocked`: the kernel holds `atlas-delete:<account>` for as long as the delete is blocked (D:6911),
 *    which is why every tab closes its connections on `versionchange`;
 *  - the account's write-failure markers are removed before a successful delete resolves (D-14, MU-42).
 */
export interface AccountDatabaseDeps {
  host: DatabaseHost;
  registry: ConnectionRegistry;
  markers: WriteFailureMarkers;
  now(): number;
  probeTimeoutMs?: number;
  incarnationCacheMs?: number;
}

export function createAccountDatabasePort(
  deps: AccountDatabaseDeps,
): AccountDatabasePort & {
  /** Drops cached incarnations (a creation or a deletion by this page changes the answer). */
  forget(account: AccountId): void;
} {
  const probeTimeout = deps.probeTimeoutMs ?? DATA_CONFIG.probeTimeoutMs;
  const cacheMs = deps.incarnationCacheMs ?? DATA_CONFIG.incarnationCacheMs;
  const cache = new Map<
    AccountId,
    { incarnation: string | null; at: number }
  >();
  const fresh = (account: AccountId): string | null | undefined => {
    const hit = cache.get(account);
    if (!hit) return undefined;
    if (deps.now() - hit.at > cacheMs) {
      cache.delete(account);
      return undefined;
    }
    return hit.incarnation;
  };

  return {
    async exists(account) {
      const name = accountDatabaseName(account);
      // Rejects when `databases()` is unavailable: the kernel maps that to `retry_later/adapter_missing` and keeps its entry.
      const listed = (await deps.host.list()).includes(name);
      if (!listed) {
        cache.delete(account);
        // Unlisted but a connection of THIS page is registered: the listing may lag a creation made a moment ago.
        return deps.registry.openCount(account) > 0;
      }
      const probe = await deps.host.probe(name, probeTimeout);
      if (probe.kind === "absent") {
        cache.delete(account);
        return false;
      }
      cache.set(account, { incarnation: probe.incarnation, at: deps.now() });
      return true;
    },

    async readIncarnation(account) {
      const cached = fresh(account);
      if (cached !== undefined) return cached;
      const probe = await deps.host.probe(
        accountDatabaseName(account),
        probeTimeout,
      );
      if (probe.kind === "absent") {
        cache.delete(account);
        return null;
      }
      cache.set(account, { incarnation: probe.incarnation, at: deps.now() });
      return probe.incarnation;
    },

    async closeOwnConnections(account) {
      cache.delete(account);
      // Idempotent; resolves even when nothing is open. Latches, so a late writer gets `closed` and cannot re-open.
      deps.registry.closeAll(account, { latch: "closed_for_deletion" });
    },

    async delete(account) {
      cache.delete(account);
      const outcome = await deps.host.delete(accountDatabaseName(account));
      if (outcome !== "error") {
        // Before the success is reported, so a retry after a crash cannot find a marker for a database that no longer exists.
        deps.markers.clearAccount(account);
        cache.delete(account);
      }
      return outcome;
    },

    forget(account) {
      cache.delete(account);
    },
  };
}

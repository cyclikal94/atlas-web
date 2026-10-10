import { invalidateOperation } from "../model/retry";
import type { CacheStatus } from "../model/types";
import { readPlan } from "./builders";

/**
 * What the status model reads of `sync_state` (plan 5.7): the cache status that gates cache-sourced views, the last completed
 * catch-up, and whether the delta phase has begun. READONLY; re-evaluated by `watch` when the singleton changes, in this page or
 * another.
 */
export interface SyncFacts {
  cacheStatus: CacheStatus;
  lastSyncedAt: string | null;
  phase: "snapshot" | "delta";
  /**
   * An invalidation the server ADMITTED at the current position has failed to persist (R10): the cache is KNOWN to be invalid although
   * `cacheStatus` still says `valid`, because the write that would say otherwise has not succeeded. The view hides the cache while this
   * holds (durable and shared with every tab, as the streak it reads is). Tied to the CURRENT position, so a streak left at a position
   * that has since moved on can never hide a newer valid cache.
   */
  invalidating: boolean;
  /** The operation that names an admitted invalidation at the current position (`invalidate:<cursor>`): the key of its fallback marker. */
  invalidateOperation: string;
}

export const readSyncFacts = readPlan<
  { incarnationId: string },
  null,
  SyncFacts | null
>({
  name: "data.readSyncFacts",
  scope: [],
  read: async () => null,
  decide: ({ sync }) =>
    sync === undefined
      ? null
      : {
          cacheStatus: sync.cache_status,
          lastSyncedAt: sync.last_synced_at,
          phase: sync.phase,
          invalidating:
            (sync.local_write_streaks[invalidateOperation(sync.cursor)] ?? 0) >
            0,
          invalidateOperation: invalidateOperation(sync.cursor),
        },
});

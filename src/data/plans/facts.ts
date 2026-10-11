import { DATA_CONFIG } from "../model/config";
import {
  blockedBy,
  SNAPSHOT_PAGE_PREFIX,
  SYNC_WRITER_OPERATIONS,
} from "../model/recovery";
import { INVALIDATE_PREFIX, invalidateOperation } from "../model/retry";
import { atFloor } from "../model/sizing";
import type { SyncStops } from "../model/status";
import type { CacheStatus, SyncStateRow } from "../model/types";
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
  /** WEB-09b: the recovery-scoped budget is at its bound (durable, so every page shows the blocking state). */
  recoveryBlocked: boolean;
  /**
   * WEB-09b (P-11, R6 of the review of 10 October 2026): the durable stops of the SYNC writers that a follower page can read and its
   * leader's states would otherwise be the only source of: the `sync` read caller paused after a sustained failure or its unrecognised
   * bound (`read_retry_states.sync.paused`), a sync-side local write stopped at its bound (a page, a staged page or activation, the
   * capture, an admitted invalidation, the job's own bookkeeping), and the Q23 floor. The draft queue's own stops are the outbox facade's,
   * and every page reads those already. A follower cannot tell a frozen leader from a healthy one (an acknowledged limit); it can tell
   * these, and says so.
   */
  syncStops: SyncStops;
}

/** The operations of `local_write_streaks` that are the sync writers' (the engine's and the recovery job's), never the outbox's. */
export function isSyncOperation(operation: string): boolean {
  return (
    SYNC_WRITER_OPERATIONS.includes(operation) ||
    operation.startsWith("page:") ||
    operation.startsWith(INVALIDATE_PREFIX) ||
    operation.startsWith(SNAPSHOT_PAGE_PREFIX)
  );
}

export function syncStopsOf(sync: SyncStateRow): SyncStops {
  return {
    paused: sync.read_retry_states.sync?.paused === true,
    pageStopped: Object.entries(sync.local_write_streaks).some(
      ([operation, streak]) =>
        isSyncOperation(operation) &&
        streak >= DATA_CONFIG.localWritePauseAfter,
    ),
    floor: atFloor(sync.sizing),
  };
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
          recoveryBlocked: blockedBy(sync) !== null,
          syncStops: syncStopsOf(sync),
        },
});

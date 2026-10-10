import { DATA_CONFIG } from "./config";
import type { SyncStateRow } from "./types";

/**
 * The singleton `sync_state` row, seeded in the SAME transaction that creates the database (D:637-641, D:2054: "written
 * once, atomically"), so a database that exists is never seen without it. Every field of plan 5.0.3 is seeded; the
 * recovery fields (`recovery_generation`, `owner`, `staging_position`, `expected_position`) are WEB-09b's and are seeded so
 * admission compares against stable values. Deliberately NOT created: `sync_seq_generation` (named in D:2054 but never
 * defined in any approved text), `sync_error_streak`, `delta_error_streak`, `recovery_attempt_streak` (all WEB-09b's).
 */
export function initialSyncState(incarnationId: string): SyncStateRow {
  return {
    key: "singleton",
    incarnation_id: incarnationId,
    cursor: null,
    phase: "snapshot",
    cache_status: "empty",
    applied_revision: null,
    page_seq: 0,
    request_seq: 0,
    last_synced_at: null,
    draft_seq: 0,
    draft_fence: null,
    defaults: null,
    device_id: null,
    device_verified: false,
    device_verified_for: null,
    read_retry_states: {},
    local_write_streaks: {},
    sizing: {
      limit: DATA_CONFIG.initialLimitOther,
      class: null,
      floor_hits: 0,
      attempt: null,
    },
    profile: null,
    stamp: null,
    recovery_generation: 0,
    owner: null,
    staging_position: null,
    expected_position: null,
  };
}

/** The fields WEB-09b writes: no plan of this slice writes them except `invalidateRecoveryPosition` (F-A2). */
export const RECOVERY_OWNED_FIELDS = [
  "recovery_generation",
  "owner",
  "staging_position",
  "expected_position",
  "phase",
] as const;

/** Fields this slice must never create (they belong to WEB-09b; F-A2 asserts nothing here writes them). */
export const FORBIDDEN_STREAK_FIELDS = [
  "sync_error_streak",
  "delta_error_streak",
  "recovery_attempt_streak",
  "sync_seq_generation",
] as const;

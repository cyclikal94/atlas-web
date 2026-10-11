import { DATA_CONFIG } from "./config";
import type { SyncStateRow } from "./types";

/**
 * The pure decisions of WEB-09b's snapshot and recovery mechanics (reconciliation row 3, row 6 cases (a) to (e), the retry-budget rows
 * 4 to 6; WEB-04 design 4.1, 5.11, 6.2). Nothing here reads a clock, the database or the browser: the plans call these from their
 * decisions, and the job calls them to classify what it saw.
 */
export type RecoveryConfig = Pick<
  typeof DATA_CONFIG,
  | "snapshotCursorLifetimeMs"
  | "snapshotAdoptMarginMs"
  | "syncErrorStopAfter"
  | "deltaErrorAbandonAfter"
  | "recoveryAttemptStopAfter"
>;

/** The WEB-09b fields of the singleton with their defaults (a database created before them has none). */
export interface RecoveryFields {
  staging_started_at: number | null;
  staging_request_seq: number | null;
  staging_revision: number | null;
  staging_bytes: number;
  sync_error_streak: number;
  delta_error_streak: number;
  recovery_attempt_streak: number;
  recovery_budget_version: number;
}

export function recoveryFields(sync: SyncStateRow): RecoveryFields {
  return {
    staging_started_at: sync.staging_started_at ?? null,
    staging_request_seq: sync.staging_request_seq ?? null,
    staging_revision: sync.staging_revision ?? null,
    staging_bytes: sync.staging_bytes ?? 0,
    sync_error_streak: sync.sync_error_streak ?? 0,
    delta_error_streak: sync.delta_error_streak ?? 0,
    recovery_attempt_streak: sync.recovery_attempt_streak ?? 0,
    recovery_budget_version: sync.recovery_budget_version ?? 0,
  };
}

/** The staged attempt's fields, all cleared: a restart, an abandonment and an activation each write exactly these. */
export const CLEARED_STAGING = Object.freeze({
  staging_position: null,
  expected_position: null,
  staging_started_at: null,
  staging_request_seq: null,
  staging_revision: null,
  staging_bytes: 0,
});

/**
 * Whether the database needs a snapshot: its cache is not valid (a fresh database is `empty`; an invalidation makes it `invalid`), or
 * the delta phase has no cursor to continue from.
 */
export const needsSnapshot = (sync: SyncStateRow): boolean =>
  sync.cache_status !== "valid" ||
  sync.phase !== "delta" ||
  sync.cursor === null;

/**
 * The adopt-versus-restart decision at ownership acquisition (Q7, D 6.2, reconciliation cases (a) to (c)): a staged attempt is ADOPTED
 * (same generation, resumed at `staging_position`, its staged rows kept) iff one is recorded and its age, by the client clock of its
 * cursor-less capture, is at least `snapshotAdoptMarginMs` inside the one-hour lifetime. A clock that moved backwards (a negative age)
 * cannot vouch for the age at all and restarts too. No snapshot needed: `valid`.
 */
export type AdoptDecision = "valid" | "adopt" | "restart";

export function adoptDecision(
  sync: SyncStateRow,
  now: number,
  config: RecoveryConfig = DATA_CONFIG,
): AdoptDecision {
  if (!needsSnapshot(sync)) return "valid";
  const started = sync.staging_started_at ?? null;
  if (sync.staging_position === null || started === null) return "restart";
  const age = now - started;
  if (age < 0) return "restart";
  return age < config.snapshotCursorLifetimeMs - config.snapshotAdoptMarginMs
    ? "adopt"
    : "restart";
}

/**
 * The identity of a snapshot page's local writes in `local_write_streaks` (D 5.12, reconciliation row 7: "a sync page's own" identity,
 * WEB-09b's share): one per page POSITION (the cursor-less first page is `start`). The FINAL page's commit is the activation, and it is
 * that page's own write, so it counts under the same identity. The identity does not carry the generation: every binding with nothing
 * staged restarts under a new generation (W20), so an identity that carried it would let a reload forget three failures, and the bound
 * would not survive a reload. A staged position is a cursor of one snapshot session, so it names one page of one attempt by itself. The
 * catch-up path uses WEB-09a's own delta-page identity, `page:<cursor>`.
 */
export const SNAPSHOT_PAGE_PREFIX = "snapshot-page:";

/**
 * The fixed identities of the sync writers' own bookkeeping writes in `local_write_streaks` (the engine's capture, read-retry and sizing
 * writes, the recovery job's capture and budget writes), named here as values so that the follower's facts (`plans/facts.ts`) can tell a
 * sync writer's stop from the outbox's without importing the writers. `tests/data/follower-status.test.tsx` holds them equal to the
 * writers' own constants.
 */
export const SYNC_WRITER_OPERATIONS: readonly string[] = [
  "capture",
  "retry-state",
  "sizing",
  "recovery-capture",
  "recovery-budget",
];
export const snapshotPageOperation = (position: string | null): string =>
  position === null
    ? `${SNAPSHOT_PAGE_PREFIX}start`
    : `${SNAPSHOT_PAGE_PREFIX}at:${position}`;

/**
 * The local-write failures of an attempt that is OVER (a restart, an abandonment, an activation that committed): the stops of its staged
 * positions name pages that will never be asked for again, so they are removed with their versions. The cursor-less first page's
 * (`snapshot-page:start`) is kept: it is the same page of every attempt, and its bound must survive restarts.
 */
export function withoutAttemptStreaks(
  sync: SyncStateRow,
): Pick<SyncStateRow, "local_write_streaks" | "local_write_versions"> {
  const over = (operation: string): boolean =>
    operation.startsWith(`${SNAPSHOT_PAGE_PREFIX}at:`);
  const streaks: Record<string, number> = {};
  for (const [operation, count] of Object.entries(sync.local_write_streaks))
    if (!over(operation)) streaks[operation] = count;
  const versions: Record<string, number> = {};
  for (const [operation, version] of Object.entries(
    sync.local_write_versions ?? {},
  ))
    if (!over(operation)) versions[operation] = version;
  return {
    local_write_streaks: streaks,
    ...(sync.local_write_versions === undefined
      ? {}
      : { local_write_versions: versions }),
  };
}

/**
 * Why the job stops issuing automatically (reconciliation rows 4 and 6, the persistent blocking "sync can't proceed" state):
 * `sync_error` (three cursor-less `400`/`422`/unrecognised answers) or `attempts` (three error-driven restarts of the whole attempt).
 * `null`: not blocked.
 */
export type BlockedBy = "sync_error" | "attempts" | null;

export function blockedBy(
  sync: SyncStateRow,
  config: RecoveryConfig = DATA_CONFIG,
): BlockedBy {
  const f = recoveryFields(sync);
  if (f.recovery_attempt_streak >= config.recoveryAttemptStopAfter)
    return "attempts";
  if (f.sync_error_streak >= config.syncErrorStopAfter) return "sync_error";
  return null;
}

/**
 * What one answer does to the three counters (the retry-budget table). The job classifies the answer; this says what is counted and
 * whether the attempt is abandoned (staging cleared, a new generation, a cursor-less restart):
 *
 *  - `cursorless_error`: a cursor-less request answered `400`/`422`/unrecognised: `sync_error_streak += 1`;
 *  - `cursor_defect`: a request ON a cursor answered `400`/`422`: the cursor is abandoned at once and the whole attempt is counted;
 *  - `cursor_unrecognised`: an unrecognised answer on a cursor: `delta_error_streak += 1`, and at the bound the cursor is abandoned
 *    and the whole attempt is counted;
 *  - `server_restart`: `410 resync_required` or `409 access_changed`: abandoned, counted NOWHERE (the server instructed it).
 */
export type BudgetEvent =
  | "cursorless_error"
  | "cursor_defect"
  | "cursor_unrecognised"
  | "server_restart";

export interface BudgetStep {
  sync_error_streak: number;
  delta_error_streak: number;
  recovery_attempt_streak: number;
  /** A new version of the whole-attempt failure was recorded (the attempt counter moved). */
  attemptCounted: boolean;
  abandon: boolean;
}

export function budgetStep(
  fields: Pick<
    RecoveryFields,
    "sync_error_streak" | "delta_error_streak" | "recovery_attempt_streak"
  >,
  event: BudgetEvent,
  config: RecoveryConfig = DATA_CONFIG,
): BudgetStep {
  const base = {
    sync_error_streak: fields.sync_error_streak,
    delta_error_streak: fields.delta_error_streak,
    recovery_attempt_streak: fields.recovery_attempt_streak,
  };
  switch (event) {
    case "cursorless_error":
      return {
        ...base,
        sync_error_streak: base.sync_error_streak + 1,
        attemptCounted: false,
        abandon: false,
      };
    case "cursor_defect":
      return {
        ...base,
        // The cursor changes (it is abandoned): its own counter starts again.
        delta_error_streak: 0,
        recovery_attempt_streak: base.recovery_attempt_streak + 1,
        attemptCounted: true,
        abandon: true,
      };
    case "cursor_unrecognised": {
      const delta = base.delta_error_streak + 1;
      if (delta < config.deltaErrorAbandonAfter)
        return {
          ...base,
          delta_error_streak: delta,
          attemptCounted: false,
          abandon: false,
        };
      return {
        ...base,
        delta_error_streak: 0,
        recovery_attempt_streak: base.recovery_attempt_streak + 1,
        attemptCounted: true,
        abandon: true,
      };
    }
    case "server_restart":
      return {
        ...base,
        delta_error_streak: 0,
        attemptCounted: false,
        abandon: true,
      };
  }
}

/**
 * Whether every batch of a snapshot page carries ONE revision, the snapshot's boundary (D 4.1: `crates/core/src/sync.rs` emits every
 * snapshot batch at `boundary`), and it matches what earlier pages of the same attempt recorded. A page that disagrees is an
 * unrecognised answer, never applied. `null`: an empty page, which says nothing about the boundary.
 */
export function pageRevision(
  revisions: readonly number[],
): number | null | "mixed" {
  let revision: number | null = null;
  for (const value of revisions) {
    if (revision === null) revision = value;
    else if (revision !== value) return "mixed";
  }
  return revision;
}

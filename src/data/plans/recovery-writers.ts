import { DATA_CONFIG } from "../model/config";
import type { Mention, Reconciled } from "../model/reconcile";
import { reconcileVersions } from "../model/reconcile";
import {
  adoptDecision,
  type BlockedBy,
  type BudgetEvent,
  blockedBy,
  budgetStep,
  CLEARED_STAGING,
  needsSnapshot,
  pageRevision,
  type RecoveryConfig,
  recoveryFields,
  snapshotPageOperation,
  withoutAttemptStreaks,
} from "../model/recovery";
import {
  failureVersion,
  initialReadRetry,
  invalidateOperation,
  onLocalWriteSuccess,
} from "../model/retry";
import type { StagingRow } from "../model/schema";
import {
  atFloor,
  type DeviceSignals,
  initialState,
  next as nextSizing,
} from "../model/sizing";
import type {
  CacheRow,
  Captured,
  PendingEffectRow,
  ResourceVersionRow,
  SizingState,
  SyncStateRow,
} from "../model/types";
import type { ScanOk } from "../scan/scan";
import { type DecodeDeps, decodeChange, PageInvalid } from "../scan/validate";
import {
  type Key,
  PlanRejected,
  type Reader,
  range,
  type WriteSink,
  w,
} from "../store/port";
import { guardedPlan, singletonPlan } from "./builders";
import {
  acknowledgedOnly,
  hasOutstandingDraft,
  reconcileEffectWindow,
} from "./reconcile-windows";

/**
 * WEB-09b's writers (W20 to W25): ownership, the staged snapshot and its atomic activation, and the three recovery-scoped retry classes.
 * WEB-09a's writers (W1 to W19) write none of these fields except through W18's documented exception (F-A2); these write nothing of the
 * draft queue except the receipt bookkeeping of ACKNOWLEDGED drafts inside the activation (P-7), and never `draft_commands` in recovery.
 *
 * The STAGED SNAPSHOT (D 4.1, corrected for atomicity; reconciliation row 3). Each snapshot page is ONE transaction that writes its rows to
 * `cache_staging` tagged with the current `recovery_generation` and moves `staging_position` to the page's `next_cursor`, admitted by the
 * staging compare-and-set (STG), the generation (GEN), the ownership token (OWN), the incarnation, a closing fence and the epoch mirror.
 * The FINAL page and the swap are ONE transaction: the cache is cleared, every staged row of the current generation is copied into it in
 * keyset windows (memory is bounded by the window, the transaction stays one transaction), staging is emptied, and the delta cursor,
 * `phase: "delta"` and `cache_status: "valid"` are committed with it. There is no moment where the swap has happened and the cache is not
 * valid, or the reverse: a failure anywhere rolls the whole activation back and the old cache (hidden) and the staged rows are as they were.
 */

// ---- shared ---------------------------------------------------------------------------------------------------------------------
/** The identity of the job's own capture write in `local_write_streaks` (its failures stop it like WEB-09a's `capture`). */
export const RECOVERY_CAPTURE_OPERATION = "recovery-capture";
/** The identity of the job's own budget write (`recordRecoveryOutcome`): when the counter cannot be written the stop is immediate. */
export const RECOVERY_BUDGET_OPERATION = "recovery-budget";

const recoveryConfig = (
  over: Partial<RecoveryConfig> | undefined,
): RecoveryConfig => ({ ...DATA_CONFIG, ...over });

const owns = (sync: SyncStateRow, token: string | null): boolean =>
  (sync.owner?.ownership_token ?? null) === token;

// ---- W20 ------------------------------------------------------------------------------------------------------------------------
export type AcquireResult =
  | { kind: "absent" }
  /** A wipe of the account is closing: no ownership is taken and nothing is written. */
  | { kind: "closing" }
  | {
      kind: "owned";
      /** `valid`: no snapshot is needed; `adopt`: the staged attempt resumes; `restart`: a new generation starts cursor-less. */
      decision: "valid" | "adopt" | "restart";
      recoveryGeneration: number;
      stagingPosition: string | null;
    };

/**
 * W20: the binding's ownership (D 6.2, Q7; reconciliation cases (a) to (c)). ONE transaction writes the new `owner` and decides the
 * snapshot: an unexpired staged attempt is ADOPTED (its generation, its position and its staged rows are kept: the swap admits them by
 * generation alone); an expired or absent one RESTARTS (the generation advances and every staged row is cleared in the same transaction).
 * A valid cache is left as it is. `heartbeat_at` is written once per acquisition: there is no heartbeat takeover (Q12, P-2).
 */
export const acquireOwnership = singletonPlan<
  {
    incarnationId: string;
    tabId: string;
    token: string;
    now: number;
    config?: Partial<RecoveryConfig>;
  },
  null,
  AcquireResult
>({
  name: "data.acquireOwnership",
  meta: { writer: "W20", guards: ["INC", "CLS"], quota: null },
  scope: ["cache_staging"],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined) return { result: { kind: "absent" } };
    if (sync.draft_fence?.closing === true)
      return { result: { kind: "closing" } };
    const owner = {
      tab_id: input.tabId,
      ownership_token: input.token,
      heartbeat_at: input.now,
    };
    const decision = adoptDecision(
      sync,
      input.now,
      recoveryConfig(input.config),
    );
    if (decision === "restart") {
      const generation = sync.recovery_generation + 1;
      return {
        writes: [w.clear("cache_staging")],
        sync: {
          ...sync,
          ...withoutAttemptStreaks(sync),
          owner,
          recovery_generation: generation,
          ...CLEARED_STAGING,
          phase: "snapshot",
        },
        result: {
          kind: "owned",
          decision,
          recoveryGeneration: generation,
          stagingPosition: null,
        },
      };
    }
    return {
      sync: { ...sync, owner },
      result: {
        kind: "owned",
        decision,
        recoveryGeneration: sync.recovery_generation,
        stagingPosition: sync.staging_position,
      },
    };
  },
});

// ---- W21 ------------------------------------------------------------------------------------------------------------------------
export type RecoveryPath = "snapshot" | "catch_up";

export type RecoveryGate =
  | "absent"
  | "closing"
  /** Another binding owns the database now: this one ends. */
  | "owner"
  /** Nothing to recover on this path (the cache is valid, or there is no valid cursor to catch up from). */
  | "not_needed"
  | "blocked"
  | "paused"
  | "unrecognised"
  | "local_storage"
  | "unreadable"
  | "floor";

export type RecoveryCapture =
  | {
      kind: "captured";
      requestSeq: number;
      /** The position the request is made at: the staged position (snapshot) or the delta cursor (catch-up); null: cursor-less. */
      position: string | null;
      recoveryGeneration: number;
      limit: number;
      /** The page's local-write operation and the activation's (snapshot path). */
      operation: string;
      activateOperation: string | null;
      /** The attempt was permitted while blocked (the one attempt of a page load, or after "Try again"). */
      whileBlocked: BlockedBy;
      steppedDown: boolean;
      /** The bytes already staged by this attempt: the activation admits them with its final page (the swap rewrites them). */
      stagingBytes: number;
    }
  | {
      kind: "gated";
      reason: RecoveryGate;
      blocked?: BlockedBy;
      /** `local_storage`: the stopped operation and the version of its failure; `unreadable`: every operation that could not be read. */
      operation?: string;
      version?: number | null;
      operations?: readonly string[];
      /** `blocked`: the version of the whole-attempt failure a "Try again" ends. */
      budgetVersion?: number;
    };

/**
 * W21: the local gate and the capture of one snapshot or catch-up request (the recovery job's counterpart of W19). `request_seq` is
 * incremented when the request is captured for issue; a cursor-less capture also begins the attempt's clock (`staging_started_at`) and
 * records its sequence (`staging_request_seq`, the boundary for receipts at activation). Admitted only for the binding that owns the
 * database (OWN) and never while a wipe is closing. A blocked budget sends NOTHING unless the job was permitted one attempt
 * (`allowBlocked`: the one attempt of a page load, or the person's "Try again"), and the attempt is then subject to the same counters.
 */
export const captureRecoveryRequest = singletonPlan<
  {
    incarnationId: string;
    token: string;
    path: RecoveryPath;
    now: number;
    signals: DeviceSignals;
    allowBlocked?: boolean;
    stoppedOperations?: readonly string[];
    markerState?: (operation: string) => "marked" | "unmarked" | "unknown";
    endedAttempt?: string | null;
  },
  null,
  RecoveryCapture
>({
  name: "data.captureRecoveryRequest",
  meta: { writer: "W21", guards: ["INC", "CLS", "OWN"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined)
      return { result: { kind: "gated", reason: "absent" } };
    if (sync.draft_fence?.closing === true)
      return { result: { kind: "gated", reason: "closing" } };
    if (!owns(sync, input.token))
      return { result: { kind: "gated", reason: "owner" } };
    const snapshot = input.path === "snapshot";
    if (snapshot ? !needsSnapshot(sync) : needsSnapshot(sync))
      return { result: { kind: "gated", reason: "not_needed" } };
    const fields = recoveryFields(sync);
    const blocked = blockedBy(sync);
    if (blocked !== null && input.allowBlocked !== true)
      return {
        result: {
          kind: "gated",
          reason: "blocked",
          blocked,
          budgetVersion: fields.recovery_budget_version,
        },
      };

    // The sizing ladder is consumed, never re-implemented (P-10): a crash-loop marker found here is a tab that did not survive.
    let sizing: SizingState =
      sync.sizing.class === null ? initialState(input.signals) : sync.sizing;
    let steppedDown = false;
    if (sizing.attempt !== null) {
      if (sizing.attempt.id === input.endedAttempt)
        sizing = { ...sizing, attempt: null };
      else {
        sizing = nextSizing(sizing, { kind: "crashed_attempt" }).state;
        steppedDown = true;
      }
    }
    const sizingChanged = sizing !== sync.sizing;
    const position = snapshot ? sync.staging_position : sync.cursor;
    const operation = snapshot
      ? snapshotPageOperation(position)
      : `page:${position ?? ""}`;
    // The final page's commit (the activation) is that page's own write: one identity (see `snapshotPageOperation`).
    const activateOperation = snapshot ? operation : null;
    const order = [
      RECOVERY_CAPTURE_OPERATION,
      RECOVERY_BUDGET_OPERATION,
      operation,
    ];
    const markers = new Map<string, "marked" | "unmarked" | "unknown">();
    const markerOf = (op: string): "marked" | "unmarked" | "unknown" => {
      const known = markers.get(op);
      if (known !== undefined) return known;
      const state = input.markerState?.(op) ?? "unmarked";
      markers.set(op, state);
      return state;
    };
    const stopped = (op: string): boolean =>
      (sync.local_write_streaks[op] ?? 0) >= DATA_CONFIG.localWritePauseAfter ||
      input.stoppedOperations?.includes(op) === true ||
      markerOf(op) === "marked";
    const stoppedOperation = order.find(stopped) ?? null;
    const unreadable = order.filter((op) => markerOf(op) === "unknown");
    const retry = sync.read_retry_states.sync;
    const gate = ((): RecoveryGate | null => {
      if (retry?.paused === true)
        return retry.unrecognised_streak >= DATA_CONFIG.unrecognisedPauseAfter
          ? "unrecognised"
          : "paused";
      if (stoppedOperation !== null) return "local_storage";
      if (unreadable.length > 0) return "unreadable";
      if (atFloor(sizing)) return "floor";
      return null;
    })();
    if (gate !== null)
      return {
        sync: sizingChanged ? { ...sync, sizing } : null,
        result: {
          kind: "gated",
          reason: gate,
          ...(gate === "local_storage" && stoppedOperation !== null
            ? {
                operation: stoppedOperation,
                version: failureVersion(sync, stoppedOperation),
              }
            : gate === "unreadable"
              ? { operation: unreadable[0] as string, operations: unreadable }
              : {}),
        },
      };
    const requestSeq = sync.request_seq + 1;
    const begins = snapshot && position === null;
    return {
      sync: {
        ...sync,
        request_seq: requestSeq,
        sizing,
        expected_position: position,
        local_write_streaks: onLocalWriteSuccess(
          sync.local_write_streaks,
          RECOVERY_CAPTURE_OPERATION,
        ),
        // A cursor-less capture begins the attempt: its clock and its sequence (the server's session starts later than this).
        ...(begins
          ? {
              staging_started_at: input.now,
              staging_request_seq: requestSeq,
              staging_revision: null,
              staging_bytes: 0,
            }
          : {}),
      },
      result: {
        kind: "captured",
        requestSeq,
        position,
        recoveryGeneration: sync.recovery_generation,
        limit: Math.min(sizing.limit, DATA_CONFIG.syncLimitMax),
        operation,
        activateOperation,
        whileBlocked: blocked,
        steppedDown,
        stagingBytes: begins ? 0 : fields.staging_bytes,
      },
    };
  },
});

// ---- the page's rows ------------------------------------------------------------------------------------------------------------
interface StagedInput {
  captured: Captured;
  bytes: Uint8Array;
  scan: ScanOk;
  decode: DecodeDeps;
  /** The page's local-write operation (`snapshot-page:<generation>:<position>`): its success clears its streak and no other. */
  operation: string;
  elapsed?: () => number;
  applyChunk?: number;
  watchdogMs?: number;
  /** The quota reservation's `live()` (R28): the page was admitted under a hold, and the commit begins only while it stands. */
  leaseLive?: () => boolean;
}

export type StagedRefusal =
  /** The hold the page was admitted under ended (R28): nothing was written. */
  | { kind: "lease_lapsed" }
  /** The database does not take this page (the cache is valid, the page is not a snapshot page): nothing was written. */
  | { kind: "not_ready"; reason: "cache_status" | "page_phase" | "final" }
  /** The page's batches disagree on the boundary revision, or with the pages already staged: an unrecognised answer. */
  | { kind: "revision_mismatch" };

/** The boundary of the page against what the attempt has staged, or why it cannot be taken. */
function admitPage(
  sync: SyncStateRow,
  input: StagedInput,
  final: boolean,
): StagedRefusal | { kind: "ok"; revision: number | null } {
  if (input.leaseLive !== undefined && !input.leaseLive())
    return { kind: "lease_lapsed" };
  if (!needsSnapshot(sync))
    return { kind: "not_ready", reason: "cache_status" };
  if (input.scan.phase !== "snapshot")
    return { kind: "not_ready", reason: "page_phase" };
  if (input.scan.hasMore === final)
    return { kind: "not_ready", reason: "final" };
  const revision = pageRevision(input.scan.batches.map((b) => b.revision));
  if (revision === "mixed") return { kind: "revision_mismatch" };
  const staged = recoveryFields(sync).staging_revision;
  if (revision !== null && staged !== null && revision !== staged)
    return { kind: "revision_mismatch" };
  return { kind: "ok", revision: revision ?? staged };
}

/**
 * Streams the page's changes into `cache_staging`, tagged with the generation, in order (a run of upserts is one `bulkPut`, a removal
 * ends it first), with the watchdog at every chunk boundary. A refusal of any change aborts the whole transaction.
 */
async function stagePage(
  sink: WriteSink,
  input: StagedInput,
  startedAt: number,
): Promise<number> {
  const { scan, bytes } = input;
  const chunk = input.applyChunk ?? DATA_CONFIG.applyChunk;
  const watchdogMs = input.watchdogMs ?? DATA_CONFIG.syncApplyWatchdogMs;
  const elapsed = input.elapsed ?? (() => performance.now());
  const generation = input.captured.recoveryGeneration;
  let puts: StagingRow[] = [];
  const flush = async (): Promise<void> => {
    if (puts.length === 0) return;
    const ready = puts;
    puts = [];
    await sink.bulkPut("cache_staging", ready);
  };
  try {
    for (let index = 0; index < scan.totalChanges; index += 1) {
      const change = decodeChange(
        bytes,
        scan.elements[index * 2] as number,
        scan.elements[index * 2 + 1] as number,
        scan.nodes[index] as number,
        input.decode,
      );
      if (change.kind === "upsert") {
        puts.push({ ...change.row, recovery_generation: generation });
        if (puts.length >= chunk) await flush();
      } else {
        await flush();
        await sink.delete("cache_staging", change.id);
      }
      if ((index + 1) % chunk === 0 && elapsed() - startedAt > watchdogMs)
        throw new PlanRejected("apply", "watchdog");
    }
    await flush();
  } catch (error) {
    if (error instanceof PageInvalid)
      throw new PlanRejected(error.stage, error.reason);
    throw error;
  }
  return scan.totalChanges;
}

/** The streaks a successful page or activation ends: its own operations', the read caller's, the cursor-less and per-cursor counters. */
function afterSuccess(
  sync: SyncStateRow,
  operations: readonly string[],
  cursorless: boolean,
): Partial<SyncStateRow> {
  let streaks = sync.local_write_streaks;
  for (const operation of operations)
    streaks = onLocalWriteSuccess(streaks, operation);
  return {
    read_retry_states: { ...sync.read_retry_states, sync: initialReadRetry() },
    local_write_streaks: streaks,
    sizing: { ...sync.sizing, attempt: null, floor_hits: 0 },
    // Any success on the cursor ends its own counter, and the position moves on (a cursor change) anyway.
    delta_error_streak: 0,
    ...(cursorless ? { sync_error_streak: 0 } : {}),
  };
}

// ---- W22 ------------------------------------------------------------------------------------------------------------------------
export type StagingResult =
  | {
      kind: "staged";
      pageSeq: number;
      changes: number;
      revision: number | null;
      position: string;
    }
  | StagedRefusal;

/** W22: one snapshot page that is not the last (`has_more: true`), staged in ONE transaction. See the header. */
export const commitStagingPage = guardedPlan<StagedInput, null, StagingResult>({
  name: "data.commitStagingPage",
  meta: {
    writer: "W22",
    guards: ["INC", "CLS", "STG", "GEN", "OWN", "EPO"],
    quota: "cache",
  },
  scope: ["cache_staging"],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const admitted = admitPage(sync, input, false);
    if (admitted.kind !== "ok") return { result: admitted };
    const pageSeq = sync.page_seq + 1;
    const fields = recoveryFields(sync);
    return {
      sync: {
        ...sync,
        ...afterSuccess(
          sync,
          [input.operation],
          input.captured.expectedPosition === null,
        ),
        staging_position: input.scan.nextCursor,
        expected_position: null,
        staging_revision: admitted.revision,
        staging_bytes: fields.staging_bytes + input.bytes.length,
        page_seq: pageSeq,
      },
      result: {
        kind: "staged",
        pageSeq,
        changes: input.scan.totalChanges,
        revision: admitted.revision,
        position: input.scan.nextCursor,
      },
    };
  },
  async apply(sink, { input, result }) {
    if (result.kind !== "staged") return result;
    const elapsed = input.elapsed ?? (() => performance.now());
    await stagePage(sink, input, elapsed());
    return result;
  },
});

// ---- W23 ------------------------------------------------------------------------------------------------------------------------
export interface ActivationInput extends StagedInput {
  /** An ISO instant, for `last_synced_at`. */
  now: string;
  /** `recovery`: matrix 3.7.3 (P-7): the receipt bookkeeping of acknowledged drafts only, and nothing is deleted. */
  mode: "ordinary" | "recovery";
  /** The activation's local-write operation: the final page's own (`snapshot-page:<position>`). */
  activateOperation: string;
  /** Staged rows per keyset window (default `activationWindow`). */
  window?: number;
  /** Effect and version rows per window (default `queueWorkingSet`). */
  reconcileWindow?: number;
}

export type ActivationResult =
  | {
      kind: "activated";
      pageSeq: number;
      /** Rows the cache holds after the swap. */
      rows: number;
      revision: number | null;
      cursor: string;
      stats: Reconciled["stats"];
    }
  | StagedRefusal;

/**
 * W23: the FINAL snapshot page and the swap, in ONE transaction (D 4.1). The final page's own admission (its captured OWN, STG and GEN)
 * is the guard; the staged rows it swaps in are admitted by GENERATION alone, so rows an earlier owner staged and this one adopted are
 * eligible, and rows of any other generation are not (case 2 of the disposition). Every counter of the attempt ends with it: the three
 * recovery-scoped classes (`recovery_attempt_streak` ONLY here, or by the person's "Try again"), the read caller, and the operations' streaks.
 */
export const activateSnapshot = guardedPlan<
  ActivationInput,
  null,
  ActivationResult
>({
  name: "data.activateSnapshot",
  meta: {
    writer: "W23",
    guards: ["INC", "CLS", "STG", "GEN", "OWN", "EPO"],
    quota: "cache",
  },
  scope: [
    "cache",
    "cache_staging",
    "pending_effects",
    "drafts",
    "draft_commands",
    "resource_versions",
  ],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const admitted = admitPage(sync, input, true);
    if (admitted.kind !== "ok") return { result: admitted };
    const pageSeq = sync.page_seq + 1;
    return {
      writes: [w.clear("cache")],
      sync: {
        ...sync,
        ...afterSuccess(
          { ...sync, ...withoutAttemptStreaks(sync) },
          [
            input.operation,
            input.activateOperation,
            invalidateOperation(sync.cursor),
          ],
          input.captured.expectedPosition === null,
        ),
        ...CLEARED_STAGING,
        cursor: input.scan.nextCursor,
        phase: "delta",
        cache_status: "valid",
        applied_revision: admitted.revision ?? sync.applied_revision,
        last_synced_at: input.now,
        page_seq: pageSeq,
        sync_error_streak: 0,
        delta_error_streak: 0,
        recovery_attempt_streak: 0,
      },
      result: {
        kind: "activated",
        pageSeq,
        rows: 0,
        revision: admitted.revision,
        cursor: input.scan.nextCursor,
        stats: {
          mentioned: 0,
          resolvedNoPublication: 0,
          heldReleased: 0,
          unavailable: 0,
        },
      },
    };
  },
  async apply(sink, { reader, input, result }) {
    if (result.kind !== "activated") return result;
    const elapsed = input.elapsed ?? (() => performance.now());
    const watchdogMs = input.watchdogMs ?? DATA_CONFIG.syncApplyWatchdogMs;
    const startedAt = elapsed();
    const late = (): boolean => elapsed() - startedAt > watchdogMs;
    // 1. The final page is staged like any other, in this same transaction.
    await stagePage(sink, input, startedAt);
    // 2. The swap: the cache was cleared by the decision; every staged row of THIS generation is copied in, a window at a time, and
    // removed from staging as it goes (so the next window is simply the first remaining one: no row is met twice, none is skipped).
    const generation = input.captured.recoveryGeneration;
    const size = Math.max(1, input.window ?? DATA_CONFIG.activationWindow);
    let rows = 0;
    for (;;) {
      const staged = await reader.pageByKey(
        "cache_staging",
        "recovery_generation",
        generation,
        { limit: size },
      );
      if (staged.length === 0) break;
      await sink.bulkPut(
        "cache",
        staged.map(({ recovery_generation: _g, ...row }) => row as CacheRow),
      );
      await sink.bulkDelete(
        "cache_staging",
        staged.map((row) => row.id),
      );
      rows += staged.length;
      if (late()) throw new PlanRejected("apply", "watchdog");
      if (staged.length < size) break;
    }
    // 3. The receipt bookkeeping of acknowledged drafts the snapshot covers (P-7), then the tracked versions, against the new cache.
    const window = Math.max(
      1,
      input.reconcileWindow ?? DATA_CONFIG.queueWorkingSet,
    );
    const stats = await reconcileReceipts(reader, sink, {
      boundary: result.revision,
      pageSeq: result.pageSeq,
      window,
      deletes: input.mode !== "recovery",
      late,
    });
    await reconcileTrackedVersions(reader, sink, {
      window,
      deletes: input.mode !== "recovery",
      late,
    });
    return { ...result, rows, stats };
  },
});

/** The compound primary key of `pending_effects`, as an index (the walk is by key, so what it writes cannot move it). */
const EFFECT_KEY = "[resource_id+local_id]";

/**
 * The receipts the snapshot COVERS, released against it (D 4.1: the swap is the transaction that can clear `held_pending_cache`): an
 * effect of an ACKNOWLEDGED draft whose receipt revision is at or below the snapshot's boundary, not yet resolved. The new cache is the
 * account's view at that boundary, so a covered resource it holds is a mention (release (a)) and one it does not hold was not published to
 * this account (`no_publication`, release (b)). Everything else is left exactly as it is: an unsent draft's effects (P-7: no WEB-09b
 * plan writes them), and a receipt newer than the boundary, which the first delta page after the swap reconciles as it always would. A
 * snapshot that reported no boundary (an empty account) covers nothing.
 */
async function reconcileReceipts(
  reader: Reader,
  sink: WriteSink,
  options: {
    boundary: number | null;
    pageSeq: number;
    window: number;
    deletes: boolean;
    late(): boolean;
  },
): Promise<Reconciled["stats"]> {
  const stats = {
    mentioned: 0,
    resolvedNoPublication: 0,
    heldReleased: 0,
    unavailable: 0,
  };
  const boundary = options.boundary;
  if (boundary === null) return stats;
  let after: Key | null = null;
  for (;;) {
    const rows: PendingEffectRow[] = await reader.byIndex(
      "pending_effects",
      EFFECT_KEY,
      after === null ? range.all() : range.atLeast(after, true),
      options.window,
    );
    if (rows.length === 0) break;
    const covered = rows.filter(
      (row) =>
        row.resolved === null &&
        row.receipt_revision !== null &&
        row.receipt_revision <= boundary,
    );
    if (covered.length > 0) {
      const present = await reader.bulkGet(
        "cache",
        covered.map((row) => row.resource_id),
      );
      const mentions = new Map<string, Mention>();
      covered.forEach((row, at) => {
        const cached = present[at];
        if (cached !== undefined)
          mentions.set(row.resource_id, {
            removed: false,
            version: cached.version,
          });
      });
      await reconcileEffectWindow(reader, sink, covered, {
        mentions,
        // Every covered row is decided by the snapshot: one the cache does not hold resolves (`requestSeq` above every floor).
        facts: {
          pageSeq: options.pageSeq,
          hasMore: false,
          requestSeq: Number.MAX_SAFE_INTEGER,
        },
        window: options.window,
        stats,
        select: acknowledgedOnly,
        deletes: options.deletes,
      });
    }
    if (options.late()) throw new PlanRejected("apply", "watchdog");
    if (rows.length < options.window) break;
    const last = rows[rows.length - 1] as PendingEffectRow;
    after = [last.resource_id, last.local_id];
  }
  return stats;
}

/**
 * Every tracked version against the new cache: a resource it holds is delivered at its version; one it does not hold is gone from this
 * account's view. `reconcileVersions` decides (a version is never lowered, and a resource an outstanding draft still targets keeps its
 * record); in recovery mode nothing is deleted.
 */
async function reconcileTrackedVersions(
  reader: Reader,
  sink: WriteSink,
  options: { window: number; deletes: boolean; late(): boolean },
): Promise<void> {
  let after: Key | null = null;
  for (;;) {
    const versions: ResourceVersionRow[] = await reader.byIndex(
      "resource_versions",
      "resource_id",
      after === null ? range.all() : range.atLeast(after, true),
      options.window,
    );
    if (versions.length === 0) break;
    const present = await reader.bulkGet(
      "cache",
      versions.map((row) => row.resource_id),
    );
    const mentions = new Map<string, Mention>();
    versions.forEach((row, at) => {
      const cached = present[at];
      mentions.set(
        row.resource_id,
        cached === undefined
          ? { removed: true, version: null }
          : { removed: false, version: cached.version },
      );
    });
    const outstanding = new Set<string>();
    for (const version of versions)
      if (
        version.basis !== "timer_session" &&
        (await hasOutstandingDraft(reader, version.resource_id, options.window))
      )
        outstanding.add(version.resource_id);
    const result = reconcileVersions({ versions, mentions, outstanding });
    if (result.versionPuts.length)
      await sink.bulkPut("resource_versions", result.versionPuts);
    if (options.deletes && result.versionDeletes.length)
      await sink.bulkDelete("resource_versions", result.versionDeletes);
    if (options.late()) throw new PlanRejected("apply", "watchdog");
    if (versions.length < options.window) break;
    after = (versions[versions.length - 1] as ResourceVersionRow).resource_id;
  }
}

// ---- W24 ------------------------------------------------------------------------------------------------------------------------
export type RecoveryOutcomeResult =
  | { kind: "dropped"; reason: "absent" | "closing" | "owner" | "generation" }
  | {
      kind: "recorded";
      syncErrorStreak: number;
      deltaErrorStreak: number;
      recoveryAttemptStreak: number;
      blocked: BlockedBy;
      abandoned: boolean;
      recoveryGeneration: number;
      budgetVersion: number;
    };

/**
 * W24: what one answer does to the recovery-scoped counters (`budgetStep`) and, when the attempt is ABANDONED (a cursor defect, a tripped
 * per-cursor bound, `410`, `409 access_changed`), the abandonment in the same transaction: staging cleared, a new generation, a cursor-less
 * restart, and a cache that was still `valid` (a catch-up cursor abandoned) made `invalid`. It writes NOTHING of the draft queue and drops no
 * overlay (P-7; the cache gate hides the cache while it is invalid). Only the binding that owns the attempt (OWN, GEN) may record it: the
 * answer of a superseded binding counts nothing.
 */
export const recordRecoveryOutcome = singletonPlan<
  {
    incarnationId: string;
    token: string;
    recoveryGeneration: number;
    event: BudgetEvent;
    config?: Partial<RecoveryConfig>;
  },
  null,
  RecoveryOutcomeResult
>({
  name: "data.recordRecoveryOutcome",
  meta: { writer: "W24", guards: ["INC", "CLS", "OWN", "GEN"], quota: null },
  scope: ["cache_staging"],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined)
      return { result: { kind: "dropped", reason: "absent" } };
    if (sync.draft_fence?.closing === true)
      return { result: { kind: "dropped", reason: "closing" } };
    if (!owns(sync, input.token))
      return { result: { kind: "dropped", reason: "owner" } };
    if (sync.recovery_generation !== input.recoveryGeneration)
      return { result: { kind: "dropped", reason: "generation" } };
    const config = recoveryConfig(input.config);
    const fields = recoveryFields(sync);
    const step = budgetStep(fields, input.event, config);
    const budgetVersion = step.attemptCounted
      ? fields.recovery_budget_version + 1
      : fields.recovery_budget_version;
    let next: SyncStateRow = {
      ...sync,
      sync_error_streak: step.sync_error_streak,
      delta_error_streak: step.delta_error_streak,
      recovery_attempt_streak: step.recovery_attempt_streak,
      recovery_budget_version: budgetVersion,
      local_write_streaks: onLocalWriteSuccess(
        sync.local_write_streaks,
        RECOVERY_BUDGET_OPERATION,
      ),
    };
    if (step.abandon) {
      next = {
        ...next,
        ...withoutAttemptStreaks(next),
        recovery_generation: sync.recovery_generation + 1,
        ...CLEARED_STAGING,
        phase: "snapshot",
        ...(sync.cache_status === "valid"
          ? { cache_status: "invalid" as const, cursor: null }
          : {}),
      };
    }
    return {
      writes: step.abandon ? [w.clear("cache_staging")] : [],
      sync: next,
      result: {
        kind: "recorded",
        syncErrorStreak: step.sync_error_streak,
        deltaErrorStreak: step.delta_error_streak,
        recoveryAttemptStreak: step.recovery_attempt_streak,
        blocked: blockedBy(next, config),
        abandoned: step.abandon,
        recoveryGeneration: next.recovery_generation,
        budgetVersion,
      },
    };
  },
});

// ---- W25 ------------------------------------------------------------------------------------------------------------------------
/**
 * W25: the person's "Try again" from the blocking state: `recovery_attempt_streak := 0` for a fresh budget, and nothing else (the
 * cursor-less counter is left: the attempt it permits is subject to it, as a reload's is). Conditional on the version of the whole-attempt
 * failure the person saw (R53-style), so an older act never clears a newer trip.
 */
export const resetRecoveryBudget = singletonPlan<
  { incarnationId: string; expect: number },
  null,
  { cleared: boolean; budgetVersion: number }
>({
  name: "data.resetRecoveryBudget",
  meta: { writer: "W25", guards: ["INC"], quota: null },
  scope: [],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined)
      return { result: { cleared: false, budgetVersion: 0 } };
    const fields = recoveryFields(sync);
    if (fields.recovery_budget_version !== input.expect)
      return {
        result: {
          cleared: false,
          budgetVersion: fields.recovery_budget_version,
        },
      };
    if (fields.recovery_attempt_streak === 0)
      return {
        result: {
          cleared: true,
          budgetVersion: fields.recovery_budget_version,
        },
      };
    return {
      sync: { ...sync, recovery_attempt_streak: 0 },
      result: { cleared: true, budgetVersion: fields.recovery_budget_version },
    };
  },
});

/**
 * The provisional constants of matrix section 3.3, in one table. WEB-08c and WEB-09a tune them. `createSession`
 * accepts a `SessionConfig` override so tests run on fake time and the scenario matrices run with tiny values.
 */
export interface SessionConfig {
  /** Every `atlas-auth` request and a closing write's reservation wait. A time-out is a retry signal, never a discard. */
  lockWaitMs: number;
  /** `activate`, and immediately on `hidden`. */
  activationAbortMs: number;
  /** `activate/cancel` and the OBSERVE `current()`. */
  cancelObserveTimeoutMs: number;
  /** `expires_at` for `exchanging` (password, registration). */
  exchangingExpiryMs: number;
  /** `expires_at` for `redirected`. */
  redirectedExpiryMs: number;
  /** First step of the back-off used by resolution, verification, operation recovery and retries. */
  backoffInitialMs: number;
  backoffMaxMs: number;
  /** A recording or cover transaction with no `complete`. */
  recordingStallMs: number;
  coverStallMs: number;
  /**
   * The display check's own record read (`evaluate`: boot, resume, hints, visibility; matrix 3.7.2 "Read pending"): how long it may stay
   * pending, with the gate up, before the page treats the store as stalled and fails closed. Human decision T22-READ-BOUND-20261012
   * (Kieran, 12 October 2026): 6 s, so T22's local check held for 5 s is decided by its answer, not by a timer race. Only this read; every
   * cover, lease, observation, exposure and other read or write keeps its hard 5 s bound. Nothing is shown or sent while it waits.
   */
  displayReadStallMs: number;
  /** Every stamped request; also the give-up interval of a deferred cover. */
  stampedRequestTimeoutMs: number;
  /** Resume verification and the displaying page's scan. */
  resumeVerificationMinIntervalMs: number;
  scanIntervalMs: number;
  /** Show `1e.waiting` after this long waiting for another window. */
  waitingCardDelayMs: number;
  /** The bounded wait for coordinated closure in step 3a of the canonical wipe (WEB-04 7.8). */
  wipeClosureWaitMs: number;
  /**
   * How many times step 3a asks for the durable closing flag before it gives up and reports `retry_later/closing_unconfirmed` (the
   * first re-ask is at once, later ones follow the usual back-off; the deletion never goes on without the flag). At least 1.
   */
  closingWriteAttempts: number;
  /** `GET /health` bound. */
  healthTimeoutMs: number;
  /**
   * The wait for the shared `atlas-auth` lock of a persistence hold. A settlement or closing write holds it exclusively for the
   * length of its own transaction (and a closing write for up to `lockWaitMs`); a persistence hold that cannot be had in time is
   * `unavailable`, which the caller treats like a request that was never sent: nothing is applied, nothing is counted, and it asks again.
   */
  persistenceWaitMs: number;
  /**
   * The longest a persistence hold vouches for its verdict. At this bound the hold is REVOKED (not simply released): the data
   * transaction it protects is aborted if it can still be, the lock is kept until that transaction has settled, and only then is
   * a settlement let in (`kernel/persistence.ts`). It is a deadline for the whole commit, from the verdict to the transaction's
   * completion, queue wait included, so it must sit above the data layer's own apply watchdog (`syncApplyWatchdogMs`, 20 s, which
   * measures the apply alone) with room for the verdict read, the engine's queue and the reads before the apply: a revocation that
   * came first would turn every slow apply into an endless retry instead of the watchdog's step-down. `tests/data/commit-guard-expiry`
   * keeps the margin (at least 10 s). A settlement that waits for a hold gives up after `lockWaitMs` and retries (the session's
   * rule for every `atlas-auth` request), so a long hold is a delay, not a block. A hold ended this way is traced.
   */
  persistenceHoldMs: number;
  /**
   * After a revocation, how long registered work may stay unresolved before the stall is TRACED (`persistence.stalled`, once). It is
   * a report and nothing else: the lock is never given up while registered work is unresolved, because a commit that is already
   * committing cannot be aborted and, from this page, cannot be told from a durable write whose completion has not arrived; giving
   * the lock up would let another page settle a transition ahead of a commit that then lands. Provisional and unmeasured.
   */
  persistenceStallMs: number;
}

export const DEFAULT_CONFIG: SessionConfig = Object.freeze({
  lockWaitMs: 20_000,
  activationAbortMs: 15_000,
  cancelObserveTimeoutMs: 15_000,
  exchangingExpiryMs: 90_000,
  redirectedExpiryMs: 720_000,
  backoffInitialMs: 2_000,
  backoffMaxMs: 60_000,
  recordingStallMs: 5_000,
  coverStallMs: 5_000,
  displayReadStallMs: 6_000,
  stampedRequestTimeoutMs: 30_000,
  resumeVerificationMinIntervalMs: 30_000,
  scanIntervalMs: 30_000,
  waitingCardDelayMs: 2_000,
  wipeClosureWaitMs: 5_000,
  closingWriteAttempts: 3,
  healthTimeoutMs: 3_000,
  persistenceWaitMs: 20_000,
  persistenceHoldMs: 30_000,
  persistenceStallMs: 10_000,
});

/** Lock names (matrix 3.3). Only ever requested, waited for or probed; never queried, never stolen. */
export const LOCKS = {
  auth: "atlas-auth",
  attempt: (epoch: number) => `atlas-attempt-${epoch}`,
  lease: (id: string) => `atlas-lease-${id}`,
  issue: (id: string) => `atlas-issue-${id}`,
  /** The canonical wipe (WEB-04 7.8); requested only when `atlas-auth` is not held (D-04). */
  wipe: (account: string) => `atlas-delete:${account}`,
  /** A liveness and de-duplication lock for an operation fence (D-17); correctness never depends on it. */
  operation: (operationId: string) => `atlas-op-${operationId}`,
} as const;

export const BROADCAST_CHANNEL = "atlas-auth";

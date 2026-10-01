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
  /** Every stamped request; also the give-up interval of a deferred cover. */
  stampedRequestTimeoutMs: number;
  /** Resume verification and the displaying page's scan. */
  resumeVerificationMinIntervalMs: number;
  scanIntervalMs: number;
  /** Show `1e.waiting` after this long waiting for another window. */
  waitingCardDelayMs: number;
  /** The bounded wait for coordinated closure in step 3a of the canonical wipe (WEB-04 7.8). */
  wipeClosureWaitMs: number;
  /** `GET /health` bound. */
  healthTimeoutMs: number;
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
  stampedRequestTimeoutMs: 30_000,
  resumeVerificationMinIntervalMs: 30_000,
  scanIntervalMs: 30_000,
  waitingCardDelayMs: 2_000,
  wipeClosureWaitMs: 5_000,
  healthTimeoutMs: 3_000,
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

import type { Store } from "../../session";

/**
 * The seam to WEB-09b's recovery job (plan 5.9). This slice performs the ordinary-phase invalidation transaction and then asks
 * the seam to recover; WEB-09b registers a real one. The DEFAULT is conservative and TRUE: it reports that no recovery job is
 * registered, so the engine stops with `no_recovery`, the cache stays hidden, drafts are untouched, and the sync chip reads
 * "Updates stopped" (which is accurate: nothing is going to refresh the cache), never "Resyncing".
 */
export type RecoveryReason =
  | "resync_required"
  | "construction_defect"
  | "access_changed"
  | "unrecognised_delta";

export interface RecoverySeam {
  /** Whether a recovery job exists. When false the engine says so rather than claiming a resync is under way. */
  readonly registered: boolean;
  request(reason: RecoveryReason): void;
  /** True while a recovery is running; feeds the chip's "Resyncing" (from the instant the `410` arrived, Q24). */
  readonly active: Store<boolean>;
}

const never: Store<boolean> = {
  get: () => false,
  subscribe: () => () => undefined,
};

export const defaultRecoverySeam: RecoverySeam = Object.freeze({
  registered: false,
  request: () => undefined,
  active: never,
});

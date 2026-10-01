/**
 * The durable `atlas-auth` records and the value types of the session module (account-lifecycle matrix,
 * section 3.3). Pure data: nothing here imports the browser, React or another module of the repository.
 */

export type AccountId = string;
export type SessionId = string;
export type DeviceId = string;
/** A fresh UUID for every cover iteration; never reused. */
export type LeaseId = string;
/** Canonical lower-case UUID; the `Idempotency-Key` of a logout or retirement. */
export type OperationId = string;
/** Integer >= 1. `latest_epoch` starts at 0. */
export type Epoch = number;
export type Seq = number;
export type IsoInstant = string;

export type AttemptMethod = "password" | "registration" | "oidc" | "oidc_link";
export type AttemptPhase =
  | "exchanging"
  | "redirected"
  | "activating"
  | "indeterminate"
  | "verifying";
/** The phases in which an attempt gates display and replay (matrix 3.4). */
export const GATING_PHASES: readonly AttemptPhase[] = [
  "activating",
  "indeterminate",
  "verifying",
];
export type CancelResult = "not_activated" | "session_revoked" | "unknown";

export interface Attempt {
  epoch: Epoch;
  method: AttemptMethod;
  phase: AttemptPhase;
  previous_account_id: AccountId | null;
  target_account_id: AccountId | null;
  /** 43 characters, base64url of 32 random octets. Deleted only under invariant I1. */
  verifier: string;
  /** SA-02: `null` or the seq of the newest deferred observation; never a boolean. Set only while gating. */
  observations_deferred: Seq | null;
  /** Set when phase is `verifying`. */
  cancel_result: CancelResult | null;
  started_at: IsoInstant;
  /** Applies to `exchanging` and `redirected` only. */
  expires_at: IsoInstant;
}

export interface Settled {
  account_id: AccountId;
  epoch: Epoch;
  settled_at: IsoInstant;
  session_id: SessionId;
}

export type LeaseClass =
  | "ordinary"
  | "verification"
  | "operation"
  | "recovery"
  | "exposure";
export interface Lease {
  account_id: AccountId;
  epoch: Epoch;
  boot_id: string;
  created_at: IsoInstant;
  class: LeaseClass;
}

export type InvalidReason =
  | "unauthenticated"
  | "current_401"
  | "password_changed"
  | "unlinked"
  | "removed_elsewhere"
  | "unresolved_response";

interface FenceBase {
  seq: Seq;
  epoch: Epoch;
  obs_id: string;
  created_at: IsoInstant;
}

/** Exactly the API's `DeviceSummary`, stored for display only. */
export interface DeviceSummary {
  sessions: number;
  native_handoffs: number;
  notification_subscriptions: number;
  pending_sign_ins: number;
  sync_registered: boolean;
}

/** Immutable once written (matrix 3.5.3). */
export type Envelope = Readonly<
  | {
      operation_id: OperationId;
      op: "logout";
      account_id: AccountId;
      target: { session_id: SessionId };
      initiated_epoch: Epoch;
    }
  | {
      operation_id: OperationId;
      op: "retire_device";
      account_id: AccountId;
      target: { device_id: DeviceId };
      state_token: string;
      summary: DeviceSummary;
      initiated_epoch: Epoch;
    }
>;

export type Fence =
  | (FenceBase & { kind: "invalid_session"; reason: InvalidReason })
  | (FenceBase & { kind: "credential_unverified" })
  | (FenceBase & { kind: "drift" })
  | (FenceBase & { kind: "operation"; envelope: Envelope });
export type FenceKind = Fence["kind"];

export interface AuthState {
  schema: 1;
  /** Only increases; never reused. */
  latest_epoch: Epoch;
  /** Only increases; never reused. */
  fence_seq: Seq;
  attempt: Attempt | null;
  settled: Settled | null;
  fences: Record<AccountId, Fence[]>;
  leases: Record<LeaseId, Lease>;
}

/** D-02: the device ID is a record in `atlas-auth`. */
export interface DeviceRecord {
  device_id: string;
  created_at: IsoInstant;
}
export interface BootRecord {
  last_boot_at: IsoInstant;
}
export type PendingDeletionStatus =
  | "pending"
  | "awaiting_consent"
  | "deletion_approved";
/** D-03: the deletion record lives in `atlas-auth`. */
export interface PendingDeletion {
  operation_id: OperationId;
  account_id: AccountId;
  incarnation_id: string | null;
  status: PendingDeletionStatus;
  digest: string | null;
  approved_digest: string | null;
  /** How many changes were saved after the person confirmed (for the consent prompt); a count, never content. */
  count: number | null;
  created_at: IsoInstant;
}

/** The whole `atlas-auth` database: one object store, four kinds of key (D-01). */
export interface AuthRecords {
  auth_state: AuthState;
  device: DeviceRecord | null;
  boot: BootRecord | null;
  pending_deletions: Record<AccountId, PendingDeletion>;
}

export const isGating = (attempt: Attempt | null): boolean =>
  attempt !== null && GATING_PHASES.includes(attempt.phase);

/** What an observation reports (matrix 3.6, O9 to O14). */
export type ObservationKind =
  | "unauthenticated"
  | "current_401"
  | "password_changed"
  | "credential_mismatch"
  | "different_account"
  /** A verification answered 200 for the same account with a different session_id while leases were unresolved (E4). */
  | "session_mismatch";

export type CoverClass = LeaseClass;

/** The result of a cover transaction (matrix 3.6.2 `cover()`). */
export type ClosedReason =
  | "fence"
  | "gating_attempt"
  | "no_operation_fence"
  | "recovery_ineligible";

import {
  type AccountId,
  type AuthRecords,
  type AuthState,
  type Envelope,
  type Fence,
  GATING_PHASES,
  type Lease,
} from "./types";

/** The initial `auth_state` (matrix 3.3): nothing settled, nothing fenced, no epoch allocated. */
export function initialAuthState(): AuthState {
  return {
    schema: 1,
    latest_epoch: 0,
    fence_seq: 0,
    attempt: null,
    settled: null,
    fences: {},
    leases: {},
  };
}

export function initialRecords(): AuthRecords {
  return {
    auth_state: initialAuthState(),
    device: null,
    boot: null,
    pending_deletions: {},
  };
}

/** A deep copy. Every reducer works on a copy so a caller's snapshot is never mutated. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const ATTEMPT_METHODS = ["password", "registration", "oidc", "oidc_link"];
const LEASE_CLASSES = [
  "ordinary",
  "verification",
  "operation",
  "recovery",
  "exposure",
];
const FENCE_KINDS = [
  "invalid_session",
  "credential_unverified",
  "drift",
  "operation",
];
const CANCEL_RESULTS = ["not_activated", "session_revoked", "unknown"];

function validAttempt(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return (
    isInt(value.epoch) &&
    ATTEMPT_METHODS.includes(value.method as string) &&
    [...GATING_PHASES, "exchanging", "redirected"].includes(
      value.phase as never,
    ) &&
    isStringOrNull(value.previous_account_id) &&
    isStringOrNull(value.target_account_id) &&
    isString(value.verifier) &&
    (value.observations_deferred === null ||
      isInt(value.observations_deferred)) &&
    (value.cancel_result === null ||
      CANCEL_RESULTS.includes(value.cancel_result as string)) &&
    isString(value.started_at) &&
    isString(value.expires_at)
  );
}

function validSettled(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return (
    isString(value.account_id) &&
    isInt(value.epoch) &&
    isString(value.settled_at) &&
    isString(value.session_id)
  );
}

function validFence(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (
    !isInt(value.seq) ||
    !isInt(value.epoch) ||
    !isString(value.obs_id) ||
    !FENCE_KINDS.includes(value.kind as string)
  )
    return false;
  if (value.kind === "operation") return isObject(value.envelope);
  if (value.kind === "invalid_session") return isString(value.reason);
  return true;
}

function validLease(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isString(value.account_id) &&
    isInt(value.epoch) &&
    isString(value.boot_id) &&
    LEASE_CLASSES.includes(value.class as string)
  );
}

/**
 * Structural validation of a stored `auth_state`. An unknown `schema` or any malformed member returns null: the
 * caller fails closed and never overwrites the record, because a reset would discard fences (EC-02).
 */
export function validateAuthState(value: unknown): AuthState | null {
  if (!isObject(value) || value.schema !== 1) return null;
  if (!isInt(value.latest_epoch) || !isInt(value.fence_seq)) return null;
  if (!validAttempt(value.attempt) || !validSettled(value.settled)) return null;
  if (!isObject(value.fences) || !isObject(value.leases)) return null;
  for (const list of Object.values(value.fences)) {
    if (!Array.isArray(list) || !list.every(validFence)) return null;
  }
  for (const lease of Object.values(value.leases)) {
    if (!validLease(lease)) return null;
  }
  return value as unknown as AuthState;
}

export const fencesFor = (state: AuthState, account: AccountId): Fence[] =>
  state.fences[account] ?? [];

export function leaseIds(state: AuthState): string[] {
  return Object.keys(state.leases);
}

export function leasesOfOthers(
  state: AuthState,
  account: AccountId,
  bootId: string,
): Array<[string, Lease]> {
  return Object.entries(state.leases).filter(
    ([, lease]) => lease.account_id === account && lease.boot_id !== bootId,
  );
}

export function operationFence(
  state: AuthState,
  account: AccountId,
): (Fence & { kind: "operation" }) | undefined {
  return fencesFor(state, account).find(
    (fence): fence is Fence & { kind: "operation" } =>
      fence.kind === "operation",
  );
}

export function envelopeOf(fence: Fence): Envelope | null {
  return fence.kind === "operation" ? fence.envelope : null;
}

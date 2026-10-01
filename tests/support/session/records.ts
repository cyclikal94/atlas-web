import { initialRecords } from "../../../src/session/model/records";
import type {
  Attempt,
  AuthRecords,
  Envelope,
  Fence,
  Lease,
  Settled,
} from "../../../src/session/model/types";
import type { Rmw } from "../../../src/session/ports/store";

export const NOW = "2026-09-30T12:00:00.000Z";

/** Build records from parts; `fence_seq` and `latest_epoch` are raised to cover everything given. */
export function records(parts: {
  settled?: Partial<Settled> | null;
  attempt?: Partial<Attempt> | null;
  fences?: Record<string, Fence[]>;
  leases?: Record<string, Partial<Lease>>;
  latest_epoch?: number;
  fence_seq?: number;
}): AuthRecords {
  const base = initialRecords();
  const state = base.auth_state;
  if (parts.settled !== undefined && parts.settled !== null) {
    state.settled = {
      account_id: "A",
      epoch: 1,
      settled_at: NOW,
      session_id: "s1",
      ...parts.settled,
    };
  }
  if (parts.attempt !== undefined && parts.attempt !== null) {
    state.attempt = {
      epoch: 2,
      method: "password",
      phase: "exchanging",
      previous_account_id: null,
      target_account_id: null,
      verifier: "v".repeat(43),
      observations_deferred: null,
      cancel_result: null,
      started_at: NOW,
      expires_at: "2026-09-30T12:01:30.000Z",
      ...parts.attempt,
    };
  }
  state.fences = parts.fences ?? {};
  for (const [id, lease] of Object.entries(parts.leases ?? {})) {
    state.leases[id] = {
      account_id: "A",
      epoch: 1,
      boot_id: "other",
      created_at: NOW,
      class: "ordinary",
      ...lease,
    };
  }
  let maxEpoch = 0;
  let maxSeq = 0;
  const consider = (epoch: number) => {
    maxEpoch = Math.max(maxEpoch, epoch);
  };
  if (state.settled) consider(state.settled.epoch);
  if (state.attempt) {
    consider(state.attempt.epoch);
    maxSeq = Math.max(maxSeq, state.attempt.observations_deferred ?? 0);
  }
  for (const list of Object.values(state.fences))
    for (const fence of list) {
      consider(fence.epoch);
      maxSeq = Math.max(maxSeq, fence.seq);
    }
  for (const lease of Object.values(state.leases)) consider(lease.epoch);
  state.latest_epoch = Math.max(parts.latest_epoch ?? 0, maxEpoch);
  state.fence_seq = Math.max(parts.fence_seq ?? 0, maxSeq);
  return base;
}

export function invalid(
  seq: number,
  epoch: number,
  reason:
    | "current_401"
    | "unauthenticated"
    | "password_changed"
    | "removed_elsewhere"
    | "unresolved_response" = "unauthenticated",
): Fence {
  return {
    seq,
    epoch,
    obs_id: `o${seq}`,
    kind: "invalid_session",
    reason,
    created_at: NOW,
  };
}
export function unverified(seq: number, epoch: number): Fence {
  return {
    seq,
    epoch,
    obs_id: `o${seq}`,
    kind: "credential_unverified",
    created_at: NOW,
  };
}
export function drift(seq: number, epoch: number): Fence {
  return { seq, epoch, obs_id: `o${seq}`, kind: "drift", created_at: NOW };
}
export function operation(seq: number, envelope: Envelope): Fence {
  return {
    seq,
    epoch: envelope.initiated_epoch,
    obs_id: `o${seq}`,
    kind: "operation",
    envelope,
    created_at: NOW,
  };
}
export const logoutEnvelope = (
  operationId = "op1",
  account = "A",
  epoch = 1,
  session = "s1",
): Envelope => ({
  operation_id: operationId,
  op: "logout",
  account_id: account,
  target: { session_id: session },
  initiated_epoch: epoch,
});

/** Apply a reducer the way the store does: the body sees a clone; a write is merged; the result is returned. */
export function apply<T>(
  recs: AuthRecords,
  body: (records: Readonly<AuthRecords>) => Rmw<T>,
): { records: AuthRecords; result: T; wrote: boolean } {
  const outcome = body(structuredClone(recs));
  if (!outcome.write)
    return { records: recs, result: outcome.result, wrote: false };
  return {
    records: { ...recs, ...structuredClone(outcome.write) },
    result: outcome.result,
    wrote: true,
  };
}

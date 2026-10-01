import {
  type AuthRecords,
  type AuthState,
  type Fence,
  isGating,
} from "./types";

/**
 * Structural invariants of `auth_state` that hold after every committed transaction (matrix 3.3, I1, rules 9 and
 * 10). Tests call this after every step; the kernel never calls it in production.
 */
export function checkInvariants(state: AuthState): string[] {
  const violations: string[] = [];
  const epochs: number[] = [];
  if (state.attempt) epochs.push(state.attempt.epoch);
  if (state.settled) epochs.push(state.settled.epoch);
  const seqs: number[] = [];
  for (const [account, list] of Object.entries(state.fences)) {
    const seen = new Set<number>();
    for (const fence of list) {
      epochs.push(fence.epoch);
      seqs.push(fence.seq);
      if (seen.has(fence.seq))
        violations.push(`duplicate seq ${fence.seq} for ${account}`);
      seen.add(fence.seq);
      if (fence.kind === "operation" && fence.envelope.account_id !== account)
        violations.push(`operation fence under the wrong account ${account}`);
    }
  }
  for (const lease of Object.values(state.leases)) epochs.push(lease.epoch);
  if (state.attempt?.observations_deferred != null)
    seqs.push(state.attempt.observations_deferred);
  for (const epoch of epochs) {
    if (epoch > state.latest_epoch)
      violations.push(
        `epoch ${epoch} exceeds latest_epoch ${state.latest_epoch}`,
      );
  }
  for (const seq of seqs) {
    if (seq > state.fence_seq)
      violations.push(`seq ${seq} exceeds fence_seq ${state.fence_seq}`);
  }
  const attempt = state.attempt;
  if (attempt) {
    if (attempt.observations_deferred !== null && !isGating(attempt))
      violations.push(
        "observations_deferred set while the attempt is not gating",
      );
    if (typeof attempt.verifier !== "string" || attempt.verifier.length === 0)
      violations.push("attempt without a verifier");
    if (attempt.phase === "verifying" && attempt.cancel_result === null)
      violations.push("verifying attempt without a cancel_result");
  }
  return violations;
}

export function assertInvariants(state: AuthState): void {
  const violations = checkInvariants(state);
  if (violations.length > 0)
    throw new Error(`auth_state invariants violated: ${violations.join("; ")}`);
}

/** An envelope is immutable once written: the same operation_id must carry a deep-equal envelope in every later snapshot. */
export function envelopesPreserved(
  before: AuthState,
  after: AuthState,
): string[] {
  const violations: string[] = [];
  const index = (state: AuthState) => {
    const map = new Map<string, string>();
    for (const list of Object.values(state.fences)) {
      for (const fence of list) {
        if (fence.kind === "operation")
          map.set(fence.envelope.operation_id, JSON.stringify(fence.envelope));
      }
    }
    return map;
  };
  const was = index(before);
  const is = index(after);
  for (const [id, json] of is) {
    const earlier = was.get(id);
    if (earlier !== undefined && earlier !== json)
      violations.push(`envelope ${id} was mutated`);
  }
  return violations;
}

/** I1: a gating attempt keeps its verifier for as long as it exists, and only a terminal event removes the attempt. */
export function verifierKeptWhileGating(
  before: AuthState,
  after: AuthState,
): string[] {
  if (before.attempt && isGating(before.attempt) && after.attempt) {
    if (after.attempt.epoch === before.attempt.epoch) {
      return after.attempt.verifier === before.attempt.verifier
        ? []
        : ["a gating attempt's verifier changed"];
    }
    return ["a gating attempt was replaced by another epoch"];
  }
  return [];
}

export const accountsWithFences = (records: AuthRecords): string[] =>
  Object.entries(records.auth_state.fences)
    .filter(([, list]) => list.length > 0)
    .map(([account]) => account);

export type { Fence };

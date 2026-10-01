import type { Rmw } from "../../ports/store";
import { leasesOfOthers } from "../records";
import type {
  AccountId,
  AuthRecords,
  AuthState,
  ClosedReason,
  Epoch,
  LeaseClass,
  LeaseId,
  OperationId,
} from "../types";
import { isGating } from "../types";
import { draft } from "./util";

/** The result of one cover iteration (matrix 3.6.2 `cover()`); the kernel adds CANCELLED and NOT_COVERED. */
export type CoverDecision =
  | {
      kind: "COVERED";
      lease: LeaseId;
      unresolved: readonly LeaseId[];
      /** `fence_seq` at the cover's commit: it precedes the send, so it is the `s` of rule 9. */
      fence_seq: number;
    }
  | { kind: "CLOSED"; reason: ClosedReason }
  | { kind: "CLOSED_UNRESOLVED"; unresolved: readonly LeaseId[] }
  | { kind: "STALE" }
  | { kind: "DEFER"; ids: readonly LeaseId[] };

/**
 * Recovery eligibility (matrix 3.7.3 item 3), evaluated from the durable record only: `settled == (X, e)`; no
 * gating attempt; `fences[X]` non-empty and EVERY entry `invalid_session` or `drift` with `epoch < e`.
 */
export function recoveryEligible(
  state: AuthState,
  account: AccountId,
  epoch: Epoch,
): boolean {
  const settled = state.settled;
  if (!settled || settled.account_id !== account || settled.epoch !== epoch)
    return false;
  if (isGating(state.attempt)) return false;
  const fences = state.fences[account] ?? [];
  if (fences.length === 0) return false;
  return fences.every(
    (fence) =>
      (fence.kind === "invalid_session" || fence.kind === "drift") &&
      fence.epoch < epoch,
  );
}

export interface CoverInput {
  account_id: AccountId;
  epoch: Epoch;
  klass: LeaseClass;
  boot_id: string;
  /** The lease ids this page has been granted (monotone, memory only). */
  released: ReadonlySet<LeaseId>;
  lease_id: LeaseId;
  now: string;
  /** For the operation class: the envelope whose fence must exist. */
  operation_id?: OperationId;
}

/**
 * The transaction body of `cover()` (matrix 3.6.2 step 1). Exactly one lease per activity and per iteration; Ex1
 * (defer on any foreign lease not released to this page) and Ex3 (unresolved foreign leases close the ordinary,
 * exposure and recovery classes) are decided INSIDE the transaction, from the record alone. Nothing is written
 * unless the result is COVERED.
 */
export function cover(
  records: Readonly<AuthRecords>,
  input: CoverInput,
): Rmw<CoverDecision> {
  const state = records.auth_state;
  const settled = state.settled;
  const nothing = (result: CoverDecision): Rmw<CoverDecision> => ({
    write: null,
    result,
  });
  if (
    settled === null ||
    settled.account_id !== input.account_id ||
    settled.epoch !== input.epoch
  )
    return nothing({ kind: "STALE" });

  const foreign = leasesOfOthers(state, input.account_id, input.boot_id);
  const outstanding = foreign
    .map(([id]) => id)
    .filter((id) => !input.released.has(id));
  if (outstanding.length > 0)
    return nothing({ kind: "DEFER", ids: outstanding });

  const done = foreign
    .filter(([, lease]) => lease.class === "exposure")
    .map(([id]) => id);
  const doneSet = new Set(done);
  const unresolved = foreign.map(([id]) => id).filter((id) => !doneSet.has(id));

  const fences = state.fences[input.account_id] ?? [];
  switch (input.klass) {
    case "ordinary":
    case "exposure":
      if (fences.length > 0)
        return nothing({ kind: "CLOSED", reason: "fence" });
      if (isGating(state.attempt))
        return nothing({ kind: "CLOSED", reason: "gating_attempt" });
      if (unresolved.length > 0)
        return nothing({ kind: "CLOSED_UNRESOLVED", unresolved });
      break;
    case "verification":
      break;
    case "operation": {
      const found = fences.some(
        (fence) =>
          fence.kind === "operation" &&
          (input.operation_id === undefined ||
            fence.envelope.operation_id === input.operation_id),
      );
      if (!found)
        return nothing({ kind: "CLOSED", reason: "no_operation_fence" });
      break;
    }
    case "recovery":
      if (isGating(state.attempt))
        return nothing({ kind: "CLOSED", reason: "gating_attempt" });
      if (!recoveryEligible(state, input.account_id, input.epoch))
        return nothing({ kind: "CLOSED", reason: "recovery_ineligible" });
      if (unresolved.length > 0)
        return nothing({ kind: "CLOSED_UNRESOLVED", unresolved });
      break;
  }

  const next = draft(records);
  for (const id of done) delete next.leases[id];
  next.leases[input.lease_id] = {
    account_id: input.account_id,
    epoch: input.epoch,
    boot_id: input.boot_id,
    created_at: input.now,
    class: input.klass,
  };
  return {
    write: { auth_state: next },
    result: {
      kind: "COVERED",
      lease: input.lease_id,
      // The verification's captured set: every foreign request lease that was in the record, all released to this page.
      unresolved: input.klass === "verification" ? unresolved : [],
      fence_seq: next.fence_seq,
    },
  };
}

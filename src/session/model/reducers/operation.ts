import type { Rmw } from "../../ports/store";
import { deepFreeze } from "../records";
import type {
  AccountId,
  AuthRecords,
  DeviceId,
  DeviceSummary,
  Envelope,
  Epoch,
  LeaseId,
  OperationId,
} from "../types";
import { isGating } from "../types";
import {
  deleteLeases,
  draft,
  invalidSession,
  nextSeq,
  pushFence,
  tidyFences,
} from "./util";

export type RaiseRefusal =
  | "not_settled"
  | "attempt_gating"
  | "operation_pending"
  | "fence_exists";
export type RaiseResult =
  | { kind: "FENCED"; envelope: Envelope }
  | { kind: "REFUSED"; reason: RaiseRefusal };

/**
 * 3.5.3 and Ex2: raise the operation fence with its immutable envelope in ONE transaction. Requires
 * `settled == (X, e)`; one operation at a time. Logout's `target.session_id` is read from `settled` INSIDE the
 * transaction (never from a copy taken earlier, rule 10).
 */
export function raiseOperationFence(
  records: Readonly<AuthRecords>,
  input:
    | {
        op: "logout";
        account_id: AccountId;
        epoch: Epoch;
        operation_id: OperationId;
        obs_id: string;
        now: string;
      }
    | {
        op: "retire_device";
        account_id: AccountId;
        epoch: Epoch;
        operation_id: OperationId;
        obs_id: string;
        now: string;
        device_id: DeviceId;
        state_token: string;
        summary: DeviceSummary;
      },
): Rmw<RaiseResult> {
  const state = draft(records);
  const settled = state.settled;
  const refuse = (reason: RaiseRefusal): Rmw<RaiseResult> => ({
    write: null,
    result: { kind: "REFUSED", reason },
  });
  if (
    !settled ||
    settled.account_id !== input.account_id ||
    settled.epoch !== input.epoch
  )
    return refuse("not_settled");
  if (isGating(state.attempt)) return refuse("attempt_gating");
  const existing = state.fences[input.account_id] ?? [];
  if (existing.some((fence) => fence.kind === "operation"))
    return refuse("operation_pending");
  if (existing.length > 0) return refuse("fence_exists");
  const envelope: Envelope = deepFreeze(
    input.op === "logout"
      ? {
          operation_id: input.operation_id,
          op: "logout" as const,
          account_id: input.account_id,
          target: { session_id: settled.session_id },
          initiated_epoch: input.epoch,
        }
      : {
          operation_id: input.operation_id,
          op: "retire_device" as const,
          account_id: input.account_id,
          target: { device_id: input.device_id },
          state_token: input.state_token,
          summary: { ...input.summary },
          initiated_epoch: input.epoch,
        },
  );
  pushFence(state, input.account_id, {
    seq: nextSeq(state),
    epoch: input.epoch,
    obs_id: input.obs_id,
    kind: "operation",
    envelope,
    created_at: input.now,
  });
  return {
    write: { auth_state: state },
    result: { kind: "FENCED", envelope },
  };
}

export type OperationOutcome =
  | "confirmed_applied"
  | "rejected_stale"
  | "superseded";
export type ApplyResult =
  | { kind: "WIPED"; settledCleared: boolean }
  | { kind: "NOTICE" }
  | { kind: "HIDDEN" }
  | { kind: "ABSENT" };

/**
 * 3.5.1, 3.5.4, E6: apply the recorded outcome of an operation. Called only after `operation_id` and `account_id`
 * were matched against the envelope by the caller; this reducer re-finds the envelope inside the transaction.
 *
 * - confirmed_applied: remove ALL of the account's fences and leases (SA-12) and clear `settled` ONLY if it is the
 *   account and epoch the operation began under (3.5.4).
 * - rejected_stale: remove the envelope only; `superseded`: replace it by `invalid_session('removed_elsewhere')`
 *   recorded under `initiated_epoch` (SA-11).
 * The operation call's own lease is deleted in the same transaction (E6).
 */
export function applyOperationOutcome(
  records: Readonly<AuthRecords>,
  input: {
    account_id: AccountId;
    operation_id: OperationId;
    outcome: OperationOutcome;
    call_lease?: LeaseId;
    obs_id: string;
    now: string;
  },
): Rmw<ApplyResult> {
  const state = draft(records);
  const list = state.fences[input.account_id] ?? [];
  const fence = list.find(
    (f) =>
      f.kind === "operation" && f.envelope.operation_id === input.operation_id,
  );
  if (fence?.kind !== "operation") {
    if (input.call_lease !== undefined && state.leases[input.call_lease]) {
      delete state.leases[input.call_lease];
      return { write: { auth_state: state }, result: { kind: "ABSENT" } };
    }
    return { write: null, result: { kind: "ABSENT" } };
  }
  const envelope = fence.envelope;
  if (input.call_lease !== undefined) delete state.leases[input.call_lease];
  switch (input.outcome) {
    case "confirmed_applied": {
      delete state.fences[input.account_id];
      for (const [id, lease] of Object.entries(state.leases)) {
        if (lease.account_id === input.account_id) delete state.leases[id];
      }
      let settledCleared = false;
      if (
        state.settled &&
        state.settled.account_id === envelope.account_id &&
        state.settled.epoch === envelope.initiated_epoch
      ) {
        state.settled = null;
        settledCleared = true;
      }
      return {
        write: { auth_state: state },
        result: { kind: "WIPED", settledCleared },
      };
    }
    case "rejected_stale": {
      state.fences[input.account_id] = list.filter(
        (f) =>
          !(
            f.kind === "operation" &&
            f.envelope.operation_id === input.operation_id
          ),
      );
      tidyFences(state, input.account_id);
      return { write: { auth_state: state }, result: { kind: "NOTICE" } };
    }
    case "superseded": {
      const rest = list.filter(
        (f) =>
          !(
            f.kind === "operation" &&
            f.envelope.operation_id === input.operation_id
          ),
      );
      state.fences[input.account_id] = [
        ...rest,
        invalidSession(
          nextSeq(state),
          envelope.initiated_epoch,
          input.obs_id,
          "removed_elsewhere",
          input.now,
        ),
      ];
      return { write: { auth_state: state }, result: { kind: "HIDDEN" } };
    }
  }
}

export type FinishRecoveryResult =
  | { kind: "CLEARED"; removed: number }
  | { kind: "NOT_ELIGIBLE" }
  | { kind: "RERUN"; removed: number }
  | { kind: "SUPERSEDED" };

/**
 * 3.7.3 step 2 `finish_recovery`, under `atlas-auth`: remove EXACTLY the entries with `epoch < e` and `seq <= s`
 * (rule 9, by identity); refuse if any entry is another kind or of epoch `>= e`. Leaves every lease.
 */
export function finishRecovery(
  records: Readonly<AuthRecords>,
  input: { account_id: AccountId; epoch: Epoch; s: number },
): Rmw<FinishRecoveryResult> {
  const state = draft(records);
  const settled = state.settled;
  if (
    !settled ||
    settled.account_id !== input.account_id ||
    settled.epoch !== input.epoch ||
    isGating(state.attempt)
  )
    return { write: null, result: { kind: "SUPERSEDED" } };
  const list = state.fences[input.account_id] ?? [];
  if (
    list.some(
      (f) =>
        (f.kind !== "invalid_session" && f.kind !== "drift") ||
        f.epoch >= input.epoch,
    )
  )
    return { write: null, result: { kind: "NOT_ELIGIBLE" } };
  const kept = list.filter((f) => !(f.epoch < input.epoch && f.seq <= input.s));
  const removed = list.length - kept.length;
  if (removed > 0) {
    if (kept.length > 0) state.fences[input.account_id] = kept;
    else delete state.fences[input.account_id];
  }
  const write = removed > 0 ? { auth_state: state } : null;
  if (kept.some((f) => f.epoch < input.epoch && f.seq > input.s))
    return { write, result: { kind: "RERUN", removed } };
  return { write, result: { kind: "CLEARED", removed } };
}

/** Delete the leases of a wiped account that this page is shown to have (E6). */
export function deleteAccountLeases(
  records: Readonly<AuthRecords>,
  input: { account_id: AccountId },
): Rmw<"DONE"> {
  const state = draft(records);
  const ids = Object.entries(state.leases)
    .filter(([, lease]) => lease.account_id === input.account_id)
    .map(([id]) => id);
  if (ids.length === 0) return { write: null, result: "DONE" };
  deleteLeases(state, ids);
  return { write: { auth_state: state }, result: "DONE" };
}

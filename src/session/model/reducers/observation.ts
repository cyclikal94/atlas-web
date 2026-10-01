import type { Rmw } from "../../ports/store";
import type {
  AccountId,
  AuthRecords,
  Epoch,
  InvalidReason,
  LeaseId,
  ObservationKind,
  SessionId,
} from "../types";
import { isGating } from "../types";
import {
  deleteLeases,
  draft,
  hasObservation,
  hasSameKindAndEpoch,
  invalidSession,
  nextSeq,
  pushFence,
  tidyFences,
} from "./util";

/**
 * 3.6.1 step 2: record an observation in ONE transaction that never requests `atlas-auth`. Deletes exactly this
 * request's lease in every branch (STALE and DONE included). Staleness is the only reason nothing is recorded, and
 * it is decided here (rule 8).
 *
 * `retire` is the set of unresolved leases a verification captured (E4): a fence replaces them in this transaction.
 */
export interface RecordObservationInput {
  lease_id: LeaseId;
  account_id: AccountId;
  stamp_epoch: Epoch;
  kind: ObservationKind;
  obs_id: string;
  now: string;
  /** Overrides the reason of an `invalid_session` fence: `unlinked` for the OIDC unlink, `unresolved_response` for E4. */
  reason?: InvalidReason;
  retire?: readonly LeaseId[];
}
export function recordObservation(
  records: Readonly<AuthRecords>,
  input: RecordObservationInput,
): Rmw<"STALE" | "DONE"> {
  const state = draft(records);
  delete state.leases[input.lease_id];
  const settled = state.settled;
  if (
    settled === null ||
    settled.account_id !== input.account_id ||
    settled.epoch !== input.stamp_epoch
  )
    return { write: { auth_state: state }, result: "STALE" };
  const account = input.account_id;
  if (hasObservation(state, account, input.obs_id))
    return { write: { auth_state: state }, result: "DONE" };
  const gating = isGating(state.attempt);
  switch (input.kind) {
    case "unauthenticated":
    case "current_401":
    case "password_changed":
    case "session_mismatch": {
      const reason: InvalidReason =
        input.reason ??
        (input.kind === "unauthenticated"
          ? "unauthenticated"
          : input.kind === "current_401"
            ? "current_401"
            : input.kind === "session_mismatch"
              ? "unresolved_response"
              : "password_changed");
      // A 401 is never deferred (rule D). Duplicates of the same kind and epoch are not added.
      if (
        !hasSameKindAndEpoch(
          state,
          account,
          "invalid_session",
          input.stamp_epoch,
        )
      )
        pushFence(
          state,
          account,
          invalidSession(
            nextSeq(state),
            input.stamp_epoch,
            input.obs_id,
            reason,
            input.now,
          ),
        );
      break;
    }
    case "credential_mismatch": {
      if (gating && state.attempt) {
        state.attempt.observations_deferred = nextSeq(state);
      } else {
        // Always added: rule 9 clears by seq and a mismatch recorded after a verification was sent must not be absorbed.
        pushFence(state, account, {
          seq: nextSeq(state),
          epoch: input.stamp_epoch,
          obs_id: input.obs_id,
          kind: "credential_unverified",
          created_at: input.now,
        });
      }
      break;
    }
    case "different_account": {
      if (gating && state.attempt) {
        state.attempt.observations_deferred = nextSeq(state);
      } else if (
        !hasSameKindAndEpoch(state, account, "drift", input.stamp_epoch)
      ) {
        pushFence(state, account, {
          seq: nextSeq(state),
          epoch: input.stamp_epoch,
          obs_id: input.obs_id,
          kind: "drift",
          created_at: input.now,
        });
      }
      break;
    }
  }
  if (input.retire) deleteLeases(state, input.retire);
  return { write: { auth_state: state }, result: "DONE" };
}

/**
 * E3/E4 together with the same-account branch of O11, under `atlas-auth` (a release). The verification's own lease
 * is deleted in every branch. On a strict match (`200`, same account, `session_id == settled.session_id`) the
 * captured unresolved leases are retired by identity. On a different `session_id` while captured leases remain, an
 * `invalid_session` fence (`unresolved_response`) replaces them (E4). In both cases `settled.session_id` is
 * refreshed for the same account, and only the `credential_unverified` entries with `seq <= s` (the fence_seq
 * captured before the request was sent) are cleared. A lease created, or an observation recorded, after the request
 * was sent is not covered and survives.
 */
export function verifyOutcome(
  records: Readonly<AuthRecords>,
  input: {
    lease_id: LeaseId;
    account_id: AccountId;
    epoch: Epoch;
    session_id: SessionId;
    captured: readonly LeaseId[];
    s: number;
    obs_id: string;
    now: string;
  },
): Rmw<{
  kind: "RETIRED" | "FENCED" | "STALE";
  cleared: number;
  retired: number;
}> {
  const state = draft(records);
  delete state.leases[input.lease_id];
  const settled = state.settled;
  if (
    settled === null ||
    settled.account_id !== input.account_id ||
    settled.epoch !== input.epoch
  )
    return {
      write: { auth_state: state },
      result: { kind: "STALE", cleared: 0, retired: 0 },
    };
  const strict = input.session_id === settled.session_id;
  const present = input.captured.filter((id) => state.leases[id] !== undefined);
  let kind: "RETIRED" | "FENCED" = "RETIRED";
  if (!strict && present.length > 0) {
    kind = "FENCED";
    if (
      !hasSameKindAndEpoch(
        state,
        input.account_id,
        "invalid_session",
        input.epoch,
      )
    )
      pushFence(
        state,
        input.account_id,
        invalidSession(
          nextSeq(state),
          input.epoch,
          input.obs_id,
          "unresolved_response",
          input.now,
        ),
      );
  }
  deleteLeases(state, present);
  settled.session_id = input.session_id;
  const before = state.fences[input.account_id] ?? [];
  const after = before.filter(
    (fence) =>
      !(fence.kind === "credential_unverified" && fence.seq <= input.s),
  );
  if (after.length > 0) state.fences[input.account_id] = after;
  else delete state.fences[input.account_id];
  return {
    write: { auth_state: state },
    result: {
      kind,
      cleared: before.length - after.length,
      retired: present.length,
    },
  };
}

/** E5: convert unresolved leases of an OLDER epoch than `settled.epoch` for the same account into fences (add-only). */
export function convertStale(
  records: Readonly<AuthRecords>,
  input: { account_id: AccountId; ids: readonly LeaseId[]; now: string },
): Rmw<{ kind: "CONVERTED"; ids: LeaseId[] }> {
  const state = draft(records);
  const converted: LeaseId[] = [];
  const settled = state.settled;
  if (settled && settled.account_id === input.account_id) {
    for (const id of input.ids) {
      const lease = state.leases[id];
      // Only a lease of the settled ACCOUNT and of an OLDER epoch is converted (E5).
      if (
        !lease ||
        lease.account_id !== input.account_id ||
        lease.epoch >= settled.epoch
      )
        continue;
      pushFence(state, input.account_id, {
        seq: nextSeq(state),
        epoch: lease.epoch,
        obs_id: id,
        kind: "invalid_session",
        reason: "unresolved_response",
        created_at: input.now,
      });
      delete state.leases[id];
      converted.push(id);
    }
  }
  if (converted.length === 0)
    return { write: null, result: { kind: "CONVERTED", ids: [] } };
  return {
    write: { auth_state: state },
    result: { kind: "CONVERTED", ids: converted },
  };
}

/**
 * O11, same account: clear only the `credential_unverified` entries with `seq <= s`. Never touches a lease, an
 * attempt or another kind of fence (rule 9, rule 12).
 */
export function clearCredentialUnverified(
  records: Readonly<AuthRecords>,
  input: { account_id: AccountId; s: number },
): Rmw<{ kind: "CLEARED"; count: number }> {
  const state = draft(records);
  const list = state.fences[input.account_id] ?? [];
  const kept = list.filter(
    (fence) =>
      !(fence.kind === "credential_unverified" && fence.seq <= input.s),
  );
  if (kept.length === list.length)
    return { write: null, result: { kind: "CLEARED", count: 0 } };
  state.fences[input.account_id] = kept;
  tidyFences(state, input.account_id);
  return {
    write: { auth_state: state },
    result: { kind: "CLEARED", count: list.length - kept.length },
  };
}

/** Rule 12: the owner retires ITS OWN lease; it touches nothing else. Absent commits nothing. */
export function retireOwnLease(
  records: Readonly<AuthRecords>,
  input: { lease_id: LeaseId },
): Rmw<"DONE"> {
  if (records.auth_state.leases[input.lease_id] === undefined)
    return { write: null, result: "DONE" };
  const state = draft(records);
  delete state.leases[input.lease_id];
  return { write: { auth_state: state }, result: "DONE" };
}

/** Best-effort deletion of a set of the caller's own finished exposure leases. */
export function deleteOwnLeases(
  records: Readonly<AuthRecords>,
  input: { ids: readonly LeaseId[] },
): Rmw<"DONE"> {
  if (!input.ids.some((id) => records.auth_state.leases[id] !== undefined))
    return { write: null, result: "DONE" };
  const state = draft(records);
  deleteLeases(state, input.ids);
  return { write: { auth_state: state }, result: "DONE" };
}

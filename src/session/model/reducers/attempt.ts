import type { Rmw } from "../../ports/store";
import type {
  AccountId,
  AttemptMethod,
  AuthRecords,
  CancelResult,
  Epoch,
  LeaseId,
  SessionId,
} from "../types";
import { isGating } from "../types";
import {
  deleteLeases,
  draft,
  hasSameKindAndEpoch,
  invalidSession,
  nextSeq,
  pushFence,
  tidyFences,
} from "./util";

/** Matrix 3.4 step 1: allocate an epoch, replacing only a non-gating attempt. */
export type AllocateResult =
  | { kind: "RESOLVE_FIRST" }
  | { kind: "ALLOCATED"; epoch: Epoch };
export function allocateEpoch(
  records: Readonly<AuthRecords>,
  input: {
    method: AttemptMethod;
    verifier: string;
    now: string;
    expiresAt: string;
  },
): Rmw<AllocateResult> {
  const state = draft(records);
  if (isGating(state.attempt))
    return { write: null, result: { kind: "RESOLVE_FIRST" } };
  const epoch = state.latest_epoch + 1;
  state.latest_epoch = epoch;
  state.attempt = {
    epoch,
    method: input.method,
    phase: "exchanging",
    previous_account_id: state.settled?.account_id ?? null,
    target_account_id: null,
    verifier: input.verifier,
    observations_deferred: null,
    cancel_result: null,
    started_at: input.now,
    expires_at: input.expiresAt,
  };
  return {
    write: { auth_state: state },
    result: { kind: "ALLOCATED", epoch },
  };
}

/** Step 2: store the target account only when the attempt still belongs to the requester. */
export function recordGrant(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch; account_id: AccountId },
): Rmw<"OK" | "SUPERSEDED"> {
  const state = draft(records);
  if (state.attempt?.epoch !== input.epoch)
    return { write: null, result: "SUPERSEDED" };
  state.attempt.target_account_id = input.account_id;
  return { write: { auth_state: state }, result: "OK" };
}

/**
 * Step 3.2, a closing write's transaction: raise the display gate durably before anything can change the cookie.
 * Returns the verifier the activation needs: it is read INSIDE the transaction, never from a copy.
 */
export function beginActivating(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch },
): Rmw<
  | { kind: "OK"; verifier: string; target: AccountId | null }
  | { kind: "SUPERSEDED" }
> {
  const state = draft(records);
  const attempt = state.attempt;
  if (
    !attempt ||
    attempt.epoch !== input.epoch ||
    (attempt.phase !== "exchanging" && attempt.phase !== "redirected")
  )
    return { write: null, result: { kind: "SUPERSEDED" } };
  attempt.phase = "activating";
  return {
    write: { auth_state: state },
    result: {
      kind: "OK",
      verifier: attempt.verifier,
      target: attempt.target_account_id,
    },
  };
}

/** OIDC: the flow left the page. Phase `redirected` with its own (longer) expiry; only for an attempt not yet gating. */
export function markRedirected(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch; expiresAt: string },
): Rmw<"OK" | "SUPERSEDED"> {
  const state = draft(records);
  const attempt = state.attempt;
  if (
    !attempt ||
    attempt.epoch !== input.epoch ||
    attempt.phase !== "exchanging"
  )
    return { write: null, result: "SUPERSEDED" };
  attempt.phase = "redirected";
  attempt.expires_at = input.expiresAt;
  return { write: { auth_state: state }, result: "OK" };
}

/** Read the attempt (for resolution). A pure read: no write. */
export function readAttempt(
  records: Readonly<AuthRecords>,
): Rmw<AuthRecords["auth_state"]["attempt"]> {
  return { write: null, result: structuredClone(records.auth_state.attempt) };
}

/**
 * Step 4 / O1: settlement. Writes `settled`, clears the attempt (the verifier is discarded, I1) and discards
 * `observations_deferred` by design (rule 10, case 1). Clears no fence and no lease.
 */
export function settle(
  records: Readonly<AuthRecords>,
  input: {
    epoch: Epoch;
    account_id: AccountId;
    session_id: SessionId;
    now: string;
  },
): Rmw<"SETTLED" | "SUPERSEDED"> {
  const state = draft(records);
  const attempt = state.attempt;
  if (
    !attempt ||
    attempt.epoch !== input.epoch ||
    attempt.phase !== "activating"
  )
    return { write: null, result: "SUPERSEDED" };
  state.settled = {
    account_id: input.account_id,
    epoch: input.epoch,
    settled_at: input.now,
    session_id: input.session_id,
  };
  state.attempt = null;
  return { write: { auth_state: state }, result: "SETTLED" };
}

/**
 * Step 5 / O2: a definitive refusal. Clears the attempt and, in the same transaction, promotes a non-null marker to
 * `credential_unverified` for the settled account (rule 10, case 2).
 */
export function failDefinitive(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch; obsId: string; now: string },
): Rmw<"CLEARED" | "SUPERSEDED"> {
  const state = draft(records);
  const attempt = state.attempt;
  if (!attempt || attempt.epoch !== input.epoch)
    return { write: null, result: "SUPERSEDED" };
  const marker = attempt.observations_deferred;
  state.attempt = null;
  if (marker !== null && state.settled) {
    pushFence(state, state.settled.account_id, {
      seq: nextSeq(state),
      epoch: state.settled.epoch,
      obs_id: input.obsId,
      kind: "credential_unverified",
      created_at: input.now,
    });
  }
  return { write: { auth_state: state }, result: "CLEARED" };
}

/** O3: `activating` or `indeterminate` becomes `indeterminate`. Never from `exchanging`, never downgrading `verifying`. */
export function markIndeterminate(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch },
): Rmw<"OK" | "SUPERSEDED"> {
  const state = draft(records);
  const attempt = state.attempt;
  if (
    !attempt ||
    attempt.epoch !== input.epoch ||
    (attempt.phase !== "activating" && attempt.phase !== "indeterminate")
  )
    return { write: null, result: "SUPERSEDED" };
  if (attempt.phase === "indeterminate") return { write: null, result: "OK" };
  attempt.phase = "indeterminate";
  return { write: { auth_state: state }, result: "OK" };
}

/**
 * 3.4.3 / O7: clear a non-gating attempt. Refuses any gating phase, always, whatever `expires_at` says. With
 * `expiredBefore` it clears only an attempt whose `expires_at` has passed (phase-specific expiry).
 */
export function clearNonGating(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch; expiredAt?: number },
): Rmw<"CLEARED" | "NOT_ALLOWED" | "SUPERSEDED"> {
  const state = draft(records);
  const attempt = state.attempt;
  if (!attempt || attempt.epoch !== input.epoch)
    return { write: null, result: "SUPERSEDED" };
  if (isGating(attempt)) return { write: null, result: "NOT_ALLOWED" };
  if (
    input.expiredAt !== undefined &&
    Date.parse(attempt.expires_at) > input.expiredAt
  )
    return { write: null, result: "NOT_ALLOWED" };
  state.attempt = null;
  return { write: { auth_state: state }, result: "CLEARED" };
}

/**
 * 3.4.2 / O4, after `activate/cancel` answered. Reads the attempt (and so the deferral marker) inside itself. With
 * nothing settled there is no account a stale cookie could affect, so the attempt clears whatever the result was
 * (decision D-20: nothing is inferred from a cookie and a later sign-in replaces it).
 */
export function resolveAfterCancel(
  records: Readonly<AuthRecords>,
  input: { epoch: Epoch; result: CancelResult },
): Rmw<"CLEARED" | "VERIFYING" | "SUPERSEDED"> {
  const state = draft(records);
  const attempt = state.attempt;
  if (!attempt || attempt.epoch !== input.epoch || !isGating(attempt))
    return { write: null, result: "SUPERSEDED" };
  if (
    input.result === "not_activated" &&
    attempt.observations_deferred === null
  ) {
    state.attempt = null;
    return { write: { auth_state: state }, result: "CLEARED" };
  }
  if (state.settled === null) {
    state.attempt = null;
    return { write: { auth_state: state }, result: "CLEARED" };
  }
  attempt.phase = "verifying";
  attempt.cancel_result = input.result;
  return { write: { auth_state: state }, result: "VERIFYING" };
}

/** What the OBSERVE `current()` answered. */
export type Observed =
  | { kind: "401" }
  | { kind: "200"; account_id: AccountId; session_id: SessionId };

/**
 * 3.4.2 OBSERVE / O5: the transaction after the leased `current()`. Deletes only the request's own lease; a marker
 * newer than `s` keeps the attempt `verifying`; `401` adds `invalid_session` for `settled`; another account adds
 * `drift`; the same account refreshes `settled.session_id`. NEVER settles and NEVER adopts the target.
 * Step 4 (matrix 3.6.2) is applied to the unresolved leases `captured` before the request was sent.
 */
export function observeAttempt(
  records: Readonly<AuthRecords>,
  input: {
    epoch: Epoch;
    lease: LeaseId;
    s: number;
    observed: Observed;
    captured: readonly LeaseId[];
    obsId: string;
    now: string;
  },
): Rmw<"REOBSERVE" | "DONE" | "SUPERSEDED"> {
  const state = draft(records);
  delete state.leases[input.lease];
  const attempt = state.attempt;
  if (!attempt || attempt.epoch !== input.epoch)
    return { write: { auth_state: state }, result: "SUPERSEDED" };
  if (
    attempt.observations_deferred !== null &&
    attempt.observations_deferred > input.s
  )
    return { write: { auth_state: state }, result: "REOBSERVE" };
  state.attempt = null;
  const settled = state.settled;
  if (settled) {
    const account = settled.account_id;
    const before = settled.session_id;
    const strict =
      input.observed.kind === "200" &&
      input.observed.account_id === account &&
      input.observed.session_id === before;
    if (input.observed.kind === "401") {
      if (
        !hasSameKindAndEpoch(state, account, "invalid_session", settled.epoch)
      )
        pushFence(
          state,
          account,
          invalidSession(
            nextSeq(state),
            settled.epoch,
            input.obsId,
            "current_401",
            input.now,
          ),
        );
    } else if (input.observed.account_id !== account) {
      if (!hasSameKindAndEpoch(state, account, "drift", settled.epoch))
        pushFence(state, account, {
          seq: nextSeq(state),
          epoch: settled.epoch,
          obs_id: input.obsId,
          kind: "drift",
          created_at: input.now,
        });
    } else {
      settled.session_id = input.observed.session_id;
      if (
        !strict &&
        input.captured.some((id) => state.leases[id] !== undefined) &&
        !hasSameKindAndEpoch(state, account, "invalid_session", settled.epoch)
      ) {
        pushFence(
          state,
          account,
          invalidSession(
            nextSeq(state),
            settled.epoch,
            input.obsId,
            "unresolved_response",
            input.now,
          ),
        );
      }
    }
    deleteLeases(state, input.captured);
    tidyFences(state, account);
  }
  return { write: { auth_state: state }, result: "DONE" };
}

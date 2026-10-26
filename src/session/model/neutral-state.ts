import type { AuthState } from "./types";
import { isGating } from "./types";

/**
 * The neutral full-page states drawn in `wireframes/behaviour/reconnect-to-confirm.html` (matrix 3.7). They REPLACE
 * (unmount) the protected view. This module is pure: it names the state; the components render it.
 */
export type NeutralStateId =
  | "1a.confirming"
  | "1a.checking"
  | "1a.device_changed"
  | "1a.ended_elsewhere"
  | "1b"
  | "1c.finishing"
  | "1c.offline"
  | "1c.lock_wait"
  | "1c.superseded"
  | "1c.resolving"
  | "1c.ended"
  | "1d"
  | "1e.checking"
  | "1e.session_online"
  | "1e.session_offline"
  | "1e.read_failure"
  | "1e.interrupted_online"
  | "1e.interrupted_offline"
  | "1e.waiting"
  | "2"
  | "3"
  | "wipe.consent";

/** What this PAGE knows beyond the durable record (memory only). */
export interface NeutralMemory {
  /** A logout or retirement call is being sent or awaited under a valid credential. */
  operationCallInFlight: boolean;
  /** A foreign request lease is known to be unresolved (its lock was released and the lease is in the record). */
  unresolvedLeaseKnown: boolean;
  /** This page's exposure has been waiting on another window longer than the waiting-card delay. */
  waitingOnOtherWindow: boolean;
  /** The record could not be read or the canary write failed. */
  readFailure: boolean;
  /** A transient notice the page holds (not durable). */
  notice:
    | "1c.superseded"
    | "1c.ended"
    | "1a.device_changed"
    | "1c.lock_wait"
    | null;
  /**
   * WEB-09b reports the recovery job's phase; the job itself is not this module's. It selects state 2 or 3 only while older-epoch
   * recovery fences close the settled account (WEB-08c R9); `evaluate` withdraws a report of another identity before deriving.
   */
  recovery: "catching_up" | "failed" | null;
  /** This page holds an in-memory hold for the settled account. */
  hold: boolean;
}

export interface NeutralEnv {
  online: boolean;
}

export const EMPTY_MEMORY: NeutralMemory = {
  operationCallInFlight: false,
  unresolvedLeaseKnown: false,
  waitingOnOtherWindow: false,
  readFailure: false,
  notice: null,
  recovery: null,
  hold: false,
};

/**
 * The state the record and this page's memory name for the settled account, or null when nothing closes it.
 *
 * Precedence when several hold at once (decision D-05): operation fence (1a), gating attempt (1c), drift (1d),
 * invalid session (1b), unverified credential (1e session check), unresolved lease (1e interrupted request),
 * waiting exposure (1e waiting), boot read failure (1e read failure). Chosen because row 3's copy must never be
 * replaced by the ordinary reconnect copy, and a gating attempt names the interval in which the cookie can change.
 */
export function deriveNeutral(
  record: AuthState,
  memory: NeutralMemory,
  env: NeutralEnv,
): NeutralStateId | null {
  if (memory.readFailure) return "1e.read_failure";
  const attempt = record.attempt;
  const account = record.settled?.account_id ?? null;
  const fences = account ? (record.fences[account] ?? []) : [];

  if (fences.some((fence) => fence.kind === "operation"))
    return memory.operationCallInFlight ? "1a.checking" : "1a.confirming";
  if (isGating(attempt)) {
    if (!env.online) return "1c.offline";
    return attempt?.phase === "activating" ? "1c.finishing" : "1c.resolving";
  }
  // After a re-authentication the older-epoch entries are what recovery clears (matrix 3.7.3): the person has already
  // signed in again, so the card is "Catching up" (state 2), or its failure (state 3), not the reconnect card.
  const settledEpoch = record.settled?.epoch;
  if (
    settledEpoch !== undefined &&
    fences.length > 0 &&
    fences.every(
      (fence) =>
        (fence.kind === "invalid_session" || fence.kind === "drift") &&
        fence.epoch < settledEpoch,
    )
  )
    return memory.recovery === "failed" ? "3" : "2";
  if (fences.some((fence) => fence.kind === "drift")) return "1d";
  const invalid = fences.filter((fence) => fence.kind === "invalid_session");
  if (invalid.length > 0) {
    const onlyRemoved = invalid.every(
      (fence) =>
        fence.kind === "invalid_session" &&
        fence.reason === "removed_elsewhere",
    );
    return onlyRemoved ? "1a.ended_elsewhere" : "1b";
  }
  if (fences.some((fence) => fence.kind === "credential_unverified"))
    return env.online ? "1e.session_online" : "1e.session_offline";
  if (memory.unresolvedLeaseKnown)
    return env.online ? "1e.interrupted_online" : "1e.interrupted_offline";
  if (memory.waitingOnOtherWindow) return "1e.waiting";
  // WEB-08c revision 4 (R9): the recovery report chooses between 2 and 3 only above, while older-epoch recovery fences close the account.
  // With no fence it names nothing: a report the page still holds after the recovery cleared its fence (a lost or late withdrawal, a
  // follower whose hint never came) is no gate, and the exposure protocol decides as for any account that nothing closes.
  // A retirement that was refused as stale leaves no fence; the card stays until the person reviews the device.
  if (memory.notice === "1a.device_changed") return "1a.device_changed";
  return null;
}

/** A notice that is not tied to an account: what a signed-out surface says about a sign-in that did not finish. */
export function deriveSignedOut(
  record: AuthState,
  memory: NeutralMemory,
  env: NeutralEnv,
): NeutralStateId | null {
  if (memory.readFailure) return "1e.read_failure";
  if (isGating(record.attempt)) return deriveNeutral(record, memory, env);
  if (
    memory.notice === "1c.superseded" ||
    memory.notice === "1c.ended" ||
    memory.notice === "1c.lock_wait"
  )
    return memory.notice;
  return null;
}

/** Live-region politeness of each state (matrix 3.7.2; the wireframe's engineering notes). */
export const NEUTRAL_POLITENESS: Record<NeutralStateId, "status" | "alert"> = {
  "1a.confirming": "status",
  "1a.checking": "status",
  "1a.device_changed": "status",
  "1a.ended_elsewhere": "status",
  "1b": "alert",
  "1c.finishing": "status",
  "1c.offline": "status",
  "1c.lock_wait": "status",
  "1c.superseded": "status",
  "1c.resolving": "status",
  "1c.ended": "status",
  "1d": "alert",
  "1e.checking": "status",
  "1e.session_online": "alert",
  "1e.session_offline": "alert",
  "1e.read_failure": "alert",
  "1e.interrupted_online": "status",
  "1e.interrupted_offline": "status",
  "1e.waiting": "status",
  "2": "status",
  "3": "status",
  "wipe.consent": "status",
};

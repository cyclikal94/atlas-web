import type {
  AccountId,
  ClosedReason,
  Epoch,
  LeaseClass,
  LeaseId,
  ObservationKind,
} from "../model/types";

export type ActivityState =
  | "COVERING"
  | "RESERVED"
  | "ISSUED"
  | "ACTED"
  | "ENDED"
  | "CANCELLED";

export type CancelReason =
  | "hold"
  | "closing_write"
  | "hidden"
  | "cover_timeout"
  | "caller_abort"
  | "superseded"
  | "act_guard"
  | "settlement_changed"
  | "read_failure"
  | "disposed";

/** The page-local object for one exposure attempt or one request (matrix 3.6.2 Terms). */
export interface Activity {
  readonly n: number;
  readonly kind: "exposure" | "request";
  readonly klass: LeaseClass;
  readonly account: AccountId;
  readonly epoch: Epoch;
  state: ActivityState;
  /** The current cover iteration's lease id (a fresh UUID each iteration). */
  m: LeaseId | null;
  /** Aborted by `cancel`: reaches lock requests and DEFER waits. */
  readonly signal: AbortSignal;
  /** ONE synchronous, idempotent step (matrix 3.6.2 "To cancel"). */
  cancel(reason: CancelReason): void;
}

export type CoverResult =
  | {
      kind: "COVERED";
      lease: LeaseId;
      unresolved: ReadonlySet<LeaseId>;
      fenceSeq: number;
    }
  | { kind: "CLOSED"; reason: ClosedReason }
  | { kind: "CLOSED_UNRESOLVED"; unresolved: ReadonlySet<LeaseId> }
  | { kind: "STALE" }
  /** The write failed, aborted or stalled beyond 5 s, or a lock could not be requested. */
  | { kind: "NOT_COVERED" }
  /** Wait for these locks OUTSIDE atlas-auth, then run again. */
  | { kind: "DEFER"; ids: readonly LeaseId[] }
  | { kind: "CANCELLED" };

/**
 * The closed set of protocol outcomes a stamped call can end in instead of a Response (decision D-06). `stale`: the identity
 * the call was stamped with is no longer the settled one, judged by the durable record in the step that releases the answer
 * (`releaseResponse`), or the record could not be read in time to show that it still is; nothing of the answer is handed back.
 */
export type StampedFailure =
  | "not_sent"
  | "stale"
  | "closed"
  | "closed_unresolved"
  | "not_covered"
  | "auth_state";

export class StampedRequestError extends Error {
  constructor(
    readonly kind: StampedFailure,
    readonly detail?: { observation?: ObservationKind },
  ) {
    super(kind);
    this.name = "StampedRequestError";
  }
}

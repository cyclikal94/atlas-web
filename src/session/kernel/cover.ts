import { LOCKS } from "../constants";
import {
  type CoverDecision,
  cover as coverReducer,
} from "../model/reducers/cover";
import type { AuthState, LeaseId, OperationId } from "../model/types";
import { combineSignals } from "./signals";
import type { ActivityImpl, Kernel } from "./state";
import type { CoverResult } from "./types";

/** A cover result plus the record the transaction read, for the neutral state a CLOSED result names. */
export type CoverOutcome = CoverResult & { record?: AuthState };

/**
 * `cover()` (matrix 3.6.2 step 1): ONE cover iteration for one activity. A fresh lease id and lock for every
 * iteration; the lease lock (and, for ordinary and recovery, the issue lock) are acquired BEFORE the transaction; the
 * transaction body checks the activity's own cancellation first and writes nothing if it is cancelled.
 *
 * STALE, CLOSED, CLOSED_UNRESOLVED, DEFER and CANCELLED release both locks and return; nothing was written. COVERED
 * hands the locks to the activity, which uses them at its synchronous boundary (issue) or at `act`.
 */
export async function cover(
  k: Kernel,
  activity: ActivityImpl,
  options: { operationId?: OperationId } = {},
): Promise<CoverOutcome> {
  const { ports, memory } = k;
  const leaseId: LeaseId = ports.ids.uuid();
  activity.m = leaseId;
  activity.leases.push(leaseId);
  const needsIssueLock =
    activity.kind === "request" &&
    (activity.klass === "ordinary" || activity.klass === "recovery");
  const cancelled = () => activity.state === "CANCELLED";

  const releaseBoth = () => {
    const lease = activity.leaseHandle;
    const issue = activity.issueHandle;
    activity.leaseHandle = null;
    activity.issueHandle = null;
    issue?.release();
    lease?.release();
  };

  k.emit("cover.begin", {
    n: activity.n,
    klass: activity.klass,
    lease: leaseId,
  });
  const leaseHandle = await ports.locks.acquire(LOCKS.lease(leaseId), {
    signal: activity.signal,
    abandonIf: cancelled,
  });
  if (leaseHandle === null)
    return cancelled() ? { kind: "CANCELLED" } : lockFailure(k, activity);
  activity.leaseHandle = leaseHandle;
  if (cancelled()) {
    leaseHandle.release();
    activity.leaseHandle = null;
    return { kind: "CANCELLED" };
  }
  if (needsIssueLock) {
    const issueHandle = await ports.locks.acquire(LOCKS.issue(leaseId), {
      signal: activity.signal,
      abandonIf: cancelled,
    });
    if (issueHandle === null) {
      activity.leaseHandle?.release();
      activity.leaseHandle = null;
      return cancelled() ? { kind: "CANCELLED" } : lockFailure(k, activity);
    }
    activity.issueHandle = issueHandle;
    if (cancelled()) {
      issueHandle.release();
      activity.issueHandle = null;
      activity.leaseHandle?.release();
      activity.leaseHandle = null;
      return { kind: "CANCELLED" };
    }
  }

  type Decided = CoverDecision | { kind: "CANCELLED" };
  let recordSeen: AuthState | undefined;
  const transaction = ports.store.transact<Decided>(
    (records) => {
      // Synchronous with the decision, before any write: a cancelled activity writes NO lease (Ex5(a)).
      if (activity.state === "CANCELLED")
        return { write: null, result: { kind: "CANCELLED" } };
      const outcome = coverReducer(records, {
        account_id: activity.account,
        epoch: activity.epoch,
        klass: activity.klass,
        boot_id: memory.bootId,
        released: memory.released,
        lease_id: leaseId,
        now: ports.clock.iso(),
        operation_id: options.operationId,
      });
      recordSeen = records.auth_state;
      return outcome;
    },
    {
      durability: activity.klass === "exposure" ? "default" : "strict",
      label: `cover:${activity.klass}`,
    },
  );

  let decided: Decided | "stalled";
  try {
    decided = await k.withStall(transaction.complete, k.config.coverStallMs);
  } catch {
    decided = "stalled";
  }

  if (decided === "stalled") {
    if (cancelled()) return { kind: "CANCELLED" };
    // The cover's OWN 5 s time-out: terminal, so a `complete` that arrives afterwards is discarded by identity.
    activity.cancel("cover_timeout");
    return { kind: "NOT_COVERED" };
  }
  if (cancelled()) {
    // A completion for a cancelled activity never assigns, renders, issues or schedules; cancel already retired the lease.
    return { kind: "CANCELLED" };
  }
  switch (decided.kind) {
    case "CANCELLED":
      releaseBoth();
      return { kind: "CANCELLED" };
    case "COVERED":
      if (activity.klass !== "exposure")
        ports.hints.post({
          type: "lease",
          lease_id: leaseId,
          account_id: activity.account,
        });
      k.emit("cover.committed", {
        n: activity.n,
        klass: activity.klass,
        lease: leaseId,
        unresolved: [...decided.unresolved],
      });
      return {
        kind: "COVERED",
        lease: decided.lease,
        unresolved: new Set(decided.unresolved),
        fenceSeq: decided.fence_seq,
      };
    case "STALE":
      releaseBoth();
      return { kind: "STALE" };
    case "CLOSED":
      releaseBoth();
      return { kind: "CLOSED", reason: decided.reason, record: recordSeen };
    case "CLOSED_UNRESOLVED":
      releaseBoth();
      return {
        kind: "CLOSED_UNRESOLVED",
        unresolved: new Set(decided.unresolved),
        record: recordSeen,
      };
    case "DEFER":
      releaseBoth();
      return { kind: "DEFER", ids: decided.ids };
  }
}

/** A lock that could not be requested at all (an unusable lock manager): the request is not covered and not sent. */
function lockFailure(k: Kernel, activity: ActivityImpl): CoverOutcome {
  activity.cancel("cover_timeout");
  k.emit("cover.lock_failure", { n: activity.n });
  return { kind: "NOT_COVERED" };
}

/**
 * What a DEFER waits for: each lock, OUTSIDE atlas-auth. The ids join `released` on a grant. Cancelling the activity
 * aborts the waits; a deferred cover may give up after the request time-out (never sent, retried on the back-off).
 */
export async function waitForLocks(
  k: Kernel,
  activity: ActivityImpl,
  ids: readonly LeaseId[],
  giveUp?: AbortSignal,
): Promise<"granted" | "cancelled" | "gave_up" | "failed"> {
  const signal = combineSignals(activity.signal, giveUp);
  for (const id of ids) {
    const result = await k.ports.locks.wait(LOCKS.lease(id), signal);
    if (result === "failed") return "failed";
    if (result === "aborted")
      return activity.state === "CANCELLED" ? "cancelled" : "gave_up";
    k.memory.released.add(id);
    if (activity.state === "CANCELLED") return "cancelled";
  }
  return "granted";
}

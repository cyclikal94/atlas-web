import { deleteOwnLeases, retireOwnLease } from "../model/reducers/observation";
import type { AccountId, Epoch, LeaseClass, LeaseId } from "../model/types";
import type { Kernel } from "./state";
import { ActivityImpl } from "./state";
import type { CancelReason } from "./types";

/**
 * The first statement of `send` and of `expose` (lint rule R11): an activity is created BEFORE its first lock request
 * so it is cancellable from its creation (Ex5). No other code constructs an activity.
 */
export function createActivity(
  k: Kernel,
  kind: "exposure" | "request",
  klass: LeaseClass,
  account: AccountId,
  epoch: Epoch,
): ActivityImpl {
  const activity = new ActivityImpl(
    ++k.memory.activitySeq,
    kind,
    klass,
    account,
    epoch,
    (target, reason) => cancelActivity(k, target, reason),
  );
  k.memory.register(activity);
  k.emit("activity.create", {
    n: activity.n,
    kind,
    klass,
    account,
    epoch,
  });
  return activity;
}

/**
 * Cancel an activity: ONE synchronous, idempotent step (matrix 3.6.2 "To cancel", Ex5, Ex6). `state := CANCELLED`
 * comes first; then the page forgets it; its pending waits are aborted; its issue lock is released in this same
 * step; and its current cover iteration is retired (a request: delete the lease THEN release its lock; an exposure:
 * release the lock, then delete best-effort). It never awaits and never reads a lock.
 */
export function cancelActivity(
  k: Kernel,
  activity: ActivityImpl,
  reason: CancelReason,
): void {
  // An ISSUED request is no longer unsent: it has its own lease and its answer is handled by step 2 (never cancelled).
  if (activity.terminal || activity.state === "ISSUED") return;
  activity.state = "CANCELLED";
  activity.cancelReason = reason;
  k.memory.unregister(activity);
  activity.abortWaits();
  const issue = activity.issueHandle;
  activity.issueHandle = null;
  issue?.release();
  const leaseId = activity.m;
  const leaseHandle = activity.leaseHandle;
  activity.leaseHandle = null;
  k.emit("activity.cancel", {
    n: activity.n,
    kind: activity.kind,
    klass: activity.klass,
    account: activity.account,
    reason,
    lease: leaseId,
    issueReleased: issue !== null,
  });
  if (leaseId === null) return;
  if (activity.kind === "exposure") {
    // A finished exposure lease closes nothing: release first, delete best-effort.
    leaseHandle?.release();
    void deleteBestEffort(k, [leaseId]);
    return;
  }
  // A request that never issued: delete its lease and THEN release the lease's lock, so it never looks unresolved.
  void retireLease(k, leaseId, leaseHandle);
}

/** Delete a lease this page owns, then release its lock; on failure keep both and retry on the back-off. */
export async function retireLease(
  k: Kernel,
  leaseId: LeaseId,
  handle: { release(): void } | null,
  confirm?: Parameters<typeof retireOwnLease>[1]["confirm"],
): Promise<void> {
  for (let attempt = 0; !k.disposed; attempt += 1) {
    try {
      const outcome = await k.withStall(
        k.transact(
          (records) => retireOwnLease(records, { lease_id: leaseId, confirm }),
          "retire",
        ),
        k.config.recordingStallMs,
      );
      if (outcome === "stalled") throw new Error("stalled");
      k.emit("lease.retired", { lease: leaseId });
      handle?.release();
      return;
    } catch {
      k.emit("lease.retire_failed", { lease: leaseId, attempt });
      await k.sleep(k.backoff(attempt));
    }
  }
}

/** Best-effort deletion of finished exposure leases; a failure changes nothing (a finished lease closes nothing). */
export async function deleteBestEffort(
  k: Kernel,
  ids: readonly LeaseId[],
): Promise<void> {
  try {
    await k.withStall(
      k.transact(
        (records) => deleteOwnLeases(records, { ids }),
        "delete_finished",
      ),
      k.config.recordingStallMs,
    );
  } catch {
    // Best effort only.
  }
}

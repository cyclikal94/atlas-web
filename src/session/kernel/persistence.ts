import { LOCKS } from "../constants";
import type { AccountId, Epoch } from "../model/types";
import type { Clock } from "../ports/clock";
import type { LockHandle } from "../ports/locks";
import { checkAtTheRecord, stampIsStale } from "./send";
import type { Kernel } from "./state";

/**
 * The persistence hold: how a cache, draft or outbox commit is ORDERED against every settlement of the session record
 * (docs/session.md, obligation 4, revision 6).
 *
 * IndexedDB transactions never span two databases, so a commit in `atlas-<account>` cannot be atomic with a read of `atlas-auth`,
 * and a read of the record followed by a commit leaves a gap in which another page can settle a transition (a sign-out, a switch,
 * a re-authentication) that this page has not been told of. What CAN be ordered across databases is a Web Lock, and every write that
 * changes `auth_state.settled` is made while the page holds `atlas-auth` EXCLUSIVELY (`settleAttempt`, the completion of a wipe).
 * So the hold is:
 *
 *   1. a SHARED request for `atlas-auth`, granted only when no exclusive holder exists and kept until released;
 *   2. then, inside that hold, the verdict at the record (`checkAtTheRecord`: the durable `settled` read in the body of a store
 *      transaction, the same authority the stamped wrapper's release uses).
 *
 * While the hold is kept no settlement can begin: a transition that was already committed is seen by the verdict (the commit is
 * refused, whatever this page has been told), and one that has not is ordered AFTER the holder's persistence, which finishes
 * inside the hold. No notice, broadcast or hint takes part. Holds coexist (they are shared), so commits are not serialised with
 * one another, only with settlements; a request that waits behind a settlement is served after it, in queue order.
 *
 * EXPIRY IS A REVOCATION, NOT A RELEASE (revision 6), AND THE LOCK IS NEVER GIVEN UP WHILE REGISTERED WORK IS UNRESOLVED (revision 7).
 * A hold that outlives `persistenceHoldMs` (a transaction queued behind a long one, a stalled apply) must not leave a commit able to
 * persist on the strength of a verdict that is no longer vouched for: if the lock were simply given up, a transaction still queued
 * in the engine could run after another page's settlement and be applied. So at expiry, in this order:
 *
 *   1. the hold is REVOKED: `valid()` is false and `revoked` fires, synchronously, so the data layer aborts a transaction that has
 *      not started, is reading or is applying (it cannot persist anything afterwards), and refuses to start one;
 *   2. the lock is kept until every piece of work registered with `track` has SETTLED: a transaction that was aborted settles at
 *      once, and one that is already committing cannot be aborted and completes while the lock is still held, so it is ordered before
 *      any settlement, exactly as an unexpired commit is;
 *   3. only then is the shared lock released, and a settlement can begin.
 *
 * Step 2 has NO deadline. The first two revisions gave the lock up `persistenceDrainMs` after the revocation, which waived the
 * invariant for exactly the transaction it exists for: from this page a commit that is "committing" and not yet complete (its data
 * is not durable yet and will be) cannot be told from a durable one whose completion has not been delivered, and once the lock was
 * gone another page could settle a switch, a re-authentication or a sign-out and the old commit could still land after it, with no
 * later ordering fence. Nothing on this page can force a transaction that is committing to end (`abort()` refuses), so the only
 * safe rule is to wait for it. The cost is availability, never privacy: a settlement requested elsewhere gives up after `lockWaitMs`
 * and retries, as every `atlas-auth` request does, so while an old commit is outstanding the browser shows the paused state and a
 * settlement is simply not made, and it is made as soon as the commit ends or the page that holds it is closed or reloaded (a Web
 * Lock does not outlive its page). `persistenceStallMs` after the revocation, if work is still unresolved, the event is TRACED
 * (`persistence.stalled`, once) so that a stalled engine is visible; it releases nothing.
 *
 * A holder that registered no work (it forgot to release, or never persisted) is released at once after the revocation, which is
 * what the bound was always for. `release()` itself waits for registered work, so a consumer cannot give the lock up under a
 * transaction it has not seen end.
 *
 * What it does not do: it does not make the data transaction part of the record's transaction (nothing can), and it does not cover
 * an invalidation (`401`, `credential_mismatch`) that adds a fence without changing `settled`.
 */
export type PersistenceHold =
  /** The shared lock is held and the record says `(account, epoch)` is settled: persist, then `release()` (idempotent). */
  | {
      kind: "held";
      /**
       * Fires, synchronously, the moment the hold is REVOKED (it outlived `persistenceHoldMs`). Hand it to the data transaction
       * (`RunOptions.signal`): the transaction is then abandoned, wherever it is, and nothing of it is durable. It is the bound's own
       * timer and cannot be cancelled, so it also fires, harmlessly, after a hold that was released in time: use it only while the
       * work is in flight, and read `valid()` for the truth.
       */
      readonly revoked: AbortSignal;
      /** Synchronous: false once the hold is released or revoked. Check it in the same step as the work it protects is started. */
      valid(): boolean;
      /**
       * Registers the work this hold protects. The lock is kept until every registered promise has settled (fulfilled or rejected):
       * after a revocation, and also when `release()` is called, which then takes effect when the last of them has settled. There is
       * no deadline. Call it in the same synchronous step as `valid()` was checked and the work was started.
       */
      track(work: Promise<unknown>): void;
      /** Idempotent. Gives the lock back once no registered work is unresolved (at once when there is none). */
      release(): void;
    }
  /** The record names another identity, or none: persist nothing. */
  | { kind: "stale" }
  /** The lock could not be had in time, or the record could not be read: persist nothing; it is not an answer about identity. */
  | { kind: "unavailable" };

export async function holdForPersistence(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
): Promise<PersistenceHold> {
  if (k.disposed) return { kind: "unavailable" };
  // A change this page already knows of needs neither the lock nor a read: the copy is only ever assigned after a durable commit
  // or a read of the record. It is a hint, never the authority (the record is read below).
  if (stampIsStale(k, account, epoch)) {
    k.emit("persistence.refused", { account, epoch, why: "known" });
    return { kind: "stale" };
  }
  const lock = await k.ports.locks.acquireShared(LOCKS.auth, {
    signal: k.ports.clock.abortAfter(k.config.persistenceWaitMs),
  });
  if (lock === null) {
    k.emit("persistence.refused", { account, epoch, why: "lock" });
    return { kind: "unavailable" };
  }
  let verdict: Awaited<ReturnType<typeof checkAtTheRecord>>;
  try {
    verdict = await checkAtTheRecord(
      k,
      account,
      epoch,
      null,
      "persistence.check",
    );
  } catch {
    lock.release();
    k.emit("persistence.refused", { account, epoch, why: "record" });
    return { kind: "unavailable" };
  }
  if (verdict.kind !== "current") {
    lock.release();
    if (verdict.kind === "unreadable") {
      k.emit("persistence.refused", { account, epoch, why: "unreadable" });
      void k.hooks.evaluate("response_unverified");
      return { kind: "unavailable" };
    }
    // The record names another identity: when it differs from this page's own copy, the page re-reads at once instead of waiting
    // for a notice that may never arrive.
    const local = k.memory.settled;
    const { durable } = verdict;
    if (
      durable === null
        ? local !== null
        : local === null ||
          local.account !== durable.account ||
          local.epoch !== durable.epoch
    )
      void k.hooks.evaluate("response_stale");
    k.emit("persistence.refused", { account, epoch, why: "moved" });
    return { kind: "stale" };
  }
  return openHold(lock, {
    clock: k.ports.clock,
    holdMs: k.config.persistenceHoldMs,
    stallMs: k.config.persistenceStallMs,
    emit: (event) => k.emit(event, { account, epoch }),
  });
}

/**
 * A granted hold that is never revoked and tracks nothing: for a DOUBLE of the session (a fixture page, a test world) that has no
 * `atlas-auth` record to order against and so nothing to run out. The session itself never uses it.
 */
export function unrevokedHold(
  release: () => void = () => undefined,
): Extract<PersistenceHold, { kind: "held" }> {
  return {
    kind: "held",
    revoked: new AbortController().signal,
    valid: () => true,
    track: () => undefined,
    release,
  };
}

export interface HoldDeps {
  clock: Pick<Clock, "abortAfter">;
  /** `persistenceHoldMs`: when the hold is revoked. */
  holdMs: number;
  /** `persistenceStallMs`: how long after a revocation unresolved registered work is reported as stalled. Nothing is released by it. */
  stallMs: number;
  /** The closed trace vocabulary: `held`, `released`, `timed_out`, `stalled`. */
  emit(
    event: `persistence.${"held" | "released" | "timed_out" | "stalled"}`,
  ): void;
}

/**
 * The lifecycle of a granted hold, apart from how it was granted: revocation at the bound, the registered work, the stall report, the
 * release. Separate so that the commit-guard matrix runs THIS code over its fake locks, and not a copy of it.
 */
export function openHold(
  lock: LockHandle,
  deps: HoldDeps,
): Extract<PersistenceHold, { kind: "held" }> {
  // The lock has been given back.
  let finished = false;
  // `release()` was asked for: no more work is accepted, and the lock goes when the registered work has settled.
  let closing = false;
  // Registered work that has not settled. The lock is never given back while this is above zero.
  let unresolved = 0;
  // The revocation signal IS the bound: it fires `holdMs` after the verdict, and `valid()` reads it.
  const revoked = deps.clock.abortAfter(deps.holdMs);
  const giveBack = (): void => {
    if (finished) return;
    finished = true;
    revoked.removeEventListener("abort", expire);
    lock.release();
    deps.emit("persistence.released");
  };
  const release = (): void => {
    closing = true;
    if (unresolved === 0) giveBack();
  };
  const settled = (): void => {
    unresolved -= 1;
    if (unresolved === 0 && (closing || revoked.aborted)) giveBack();
  };
  // Registered before anyone else can register on `revoked`, so it runs first. It does not release while there is work: the data
  // layer's own listeners abort that work, synchronously, in the same dispatch, and the lock goes when it has settled. If the work
  // does not settle, the lock stays, and the stall is reported once (it is never a reason to release).
  function expire(): void {
    if (finished) return;
    deps.emit("persistence.timed_out");
    if (unresolved === 0) {
      giveBack();
      return;
    }
    const stall = deps.clock.abortAfter(deps.stallMs);
    stall.addEventListener(
      "abort",
      () => {
        if (!finished && unresolved > 0) deps.emit("persistence.stalled");
      },
      { once: true },
    );
  }
  revoked.addEventListener("abort", expire, { once: true });
  deps.emit("persistence.held");
  return {
    kind: "held",
    revoked,
    valid: () => !closing && !finished && !revoked.aborted,
    track(promise) {
      // Work registered after revocation or release is not waited for: it must never have been started (`valid()` was false).
      if (closing || finished || revoked.aborted) return;
      unresolved += 1;
      promise.then(settled, settled);
    },
    release,
  };
}

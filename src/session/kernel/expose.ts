import { LOCKS } from "../constants";
import type { AccountId, AuthState, Epoch, LeaseId } from "../model/types";
import { isGating } from "../model/types";
import { createActivity, deleteBestEffort } from "./activity";
import { cover, waitForLocks } from "./cover";
import { cancelPageActivitiesFor, setHold } from "./observation";
import type { ActivityImpl, Kernel } from "./state";

/**
 * Exposure (matrix 3.6.2 step 3): how a page comes to display an account. A page displays an account only in the one
 * synchronous step `act`, under an EXPOSURE LEASE committed by the same transaction that found no fence, no gating
 * attempt and no unresolved foreign lease (Ex1, Ex3, Ex4). There is no latch and no cached permission.
 */

export type ExposeGate = "NOT_DECIDED" | "already" | "started";

/**
 * The entry tests of `expose`. They precede the activity because they refuse to start one. Trigger: boot; a page
 * becoming visible, `pageshow`, `focus`, `resume`; a hint while gated; `online`; after a fence clear, a settlement or
 * the end of a closing write. Never inside `atlas-auth`, and it never requests it.
 */
export function tryExpose(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
): ExposeGate {
  const { memory, ports } = k;
  if (!ports.page.isVisible() || memory.hasHold(account) || memory.closing > 0)
    return "NOT_DECIDED";
  if (memory.exposure !== null) return "already";
  if (
    memory.display.kind === "displaying" &&
    memory.display.account === account &&
    memory.display.epoch === epoch
  )
    return "already";
  void expose(k, account, epoch);
  return "started";
}

/** `expose(X, e)`: its FIRST statement creates the activity, before any lock is requested (lint rule R11). */
export async function expose(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
): Promise<void> {
  const a = createActivity(k, "exposure", "exposure", account, epoch);
  let deferredSince: number | null = null;
  let waitingTimer: number | null = null;
  const stopWaiting = () => {
    if (waitingTimer !== null) k.ports.clock.clearTimeout(waitingTimer);
    waitingTimer = null;
    if (k.neutral.waitingOnOtherWindow) {
      k.neutral = { ...k.neutral, waitingOnOtherWindow: false };
    }
  };
  try {
    for (;;) {
      // Checked after EVERY await: `a` is no longer page.exposure, and it writes nothing more.
      if (isCancelled(a)) return cleanup(k, a);
      const c = await cover(k, a);
      if (isCancelled(a) && c.kind !== "NOT_COVERED") {
        // A completion, of ANY result, for a cancelled or superseded attempt: discard it and clean up its own lease.
        k.emit("expose.discarded", { n: a.n, result: c.kind });
        return cleanup(k, a);
      }
      switch (c.kind) {
        case "CANCELLED":
          return cleanup(k, a);
        case "STALE":
          end(k, a);
          k.hooks.evaluate("stale");
          return;
        case "CLOSED":
          end(k, a);
          k.hooks.closeFromCover(account, c);
          return;
        case "CLOSED_UNRESOLVED":
          end(k, a);
          k.hooks.closeFromCover(account, c);
          if (k.ports.page.isOnline())
            void k.hooks.verifyUnresolved(account, epoch, c.unresolved);
          return;
        case "NOT_COVERED":
          end(k, a);
          k.neutral = { ...k.neutral, readFailure: true };
          k.hooks.evaluate("not_covered");
          scheduleRetry(k, "expose_retry");
          return;
        case "DEFER": {
          if (deferredSince === null) {
            deferredSince = k.ports.clock.now();
            waitingTimer = k.ports.clock.setTimeout(() => {
              if (a.state === "COVERING") {
                k.neutral = { ...k.neutral, waitingOnOtherWindow: true };
                k.hooks.evaluate("waiting_card");
              }
            }, k.config.waitingCardDelayMs);
          }
          const waited = await waitForLocks(k, a, c.ids);
          if (waited === "granted") continue;
          if (!isCancelled(a)) a.cancel("cover_timeout");
          return cleanup(k, a);
        }
        case "COVERED":
          // The SAME synchronous step as the check above, so `a` was COVERING and was page.exposure.
          a.state = "RESERVED";
          k.ports.page.queueTask(() => act(k, a));
          return;
      }
    }
  } finally {
    stopWaiting();
  }
}

/**
 * `act(a)`: ONE synchronous step in a task of this page. No `await`, no read. Guarded only by THIS attempt's own
 * state and the page's own memory (Ex5). The tree is mounted, or the gate lifted, ONLY here (lint rule R10).
 */
export function act(k: Kernel, a: ActivityImpl): void {
  const { memory, ports } = k;
  if (
    a.state !== "RESERVED" ||
    memory.exposure !== a ||
    a.leaseHandle === null ||
    memory.hasHold(a.account) ||
    !ports.page.isVisible() ||
    memory.closing > 0 ||
    memory.settled?.account !== a.account ||
    memory.settled?.epoch !== a.epoch
  ) {
    a.cancel("act_guard");
    return;
  }
  ports.trace.emit("act.begin", { n: a.n, account: a.account, epoch: a.epoch });
  a.state = "ACTED";
  memory.exposure = null;
  ports.surface.attachTree(a.account, a.epoch);
  memory.mountedAccount = a.account;
  memory.display = { kind: "displaying", account: a.account, epoch: a.epoch };
  const handle = a.leaseHandle;
  a.leaseHandle = null;
  handle.release();
  k.view.set({ kind: "displaying", account_id: a.account, epoch: a.epoch });
  ports.trace.emit("act.end", { n: a.n });
  // Then, best effort: delete leases[a.m].
  if (a.m !== null) void deleteBestEffort(k, [a.m]);
}

/** A function, not a comparison, so control-flow narrowing cannot hide a cancellation that happened at an await. */
function isCancelled(a: ActivityImpl): boolean {
  return a.state === "CANCELLED";
}

function end(k: Kernel, a: ActivityImpl): void {
  if (!a.terminal) a.state = "ENDED";
  k.memory.unregister(a);
  // The cover released the lock itself when it returned STALE, CLOSED, CLOSED_UNRESOLVED or DEFER.
}

/** A cancelled attempt's OWN lease, and nothing else: release the lock (idempotent) and delete best-effort. */
function cleanup(k: Kernel, a: ActivityImpl): void {
  const handle = a.leaseHandle;
  a.leaseHandle = null;
  handle?.release();
  const issue = a.issueHandle;
  a.issueHandle = null;
  issue?.release();
  k.memory.unregister(a);
  if (a.m !== null) void deleteBestEffort(k, [a.m]);
}

function scheduleRetry(k: Kernel, label: string): void {
  void (async () => {
    const elapsed = await k.sleep(k.backoff(0));
    if (!k.disposed) {
      k.emit(label, { elapsed });
      k.neutral = { ...k.neutral, readFailure: false };
      k.hooks.evaluate(label);
    }
  })();
}

// ---- closing writes (matrix 3.3.1 Ex2, Ex6) ---------------------------------------------------------------------

/**
 * The FIRST synchronous step of every closing write of this page (lint rule R8): an activating attempt, a
 * settlement, an operation fence. It cancels the page's exposure attempt in whatever state AND every unsent
 * ordinary and recovery request for every account (releasing each issue lock in this step and retiring each unused
 * lease), and forbids a new attempt, or the start or issue of a request, until the write has finished.
 */
export function beginClosing(k: Kernel): void {
  k.memory.closing += 1;
  k.emit("closing.begin", { closing: k.memory.closing });
  if (k.memory.exposure !== null) k.memory.exposure.cancel("closing_write");
  for (const set of [...k.memory.unsent.values()]) {
    for (const activity of [...set]) activity.cancel("closing_write");
  }
}

/** When the write's transaction has completed, aborted or failed, or the procedure gave up. */
export function endClosing(k: Kernel): void {
  k.memory.closing = Math.max(0, k.memory.closing - 1);
  k.emit("closing.end", { closing: k.memory.closing });
  k.hooks.evaluate("closing_end");
}

// ---- displaying pages: what closes a page that has already displayed ------------------------------------------

/**
 * Synchronously stop displaying an account: clear the display state and unmount (level 1). A page that is HIDDEN still
 * has its tree mounted behind the level-0 gate (inert); when the record closes the account it must be unmounted too,
 * so nothing protected remains (matrix 3.7.2 item 3, "Unresolved lease found").
 */
export function closeDisplay(
  k: Kernel,
  account: AccountId,
  cause: string,
): void {
  const display = k.memory.display;
  const displaying =
    display.kind === "displaying" && display.account === account;
  if (!displaying && k.memory.mountedAccount !== account) return;
  if (displaying) k.memory.display = { kind: "gated" };
  k.memory.mountedAccount = null;
  k.ports.surface.discardSavedPosition();
  k.ports.surface.unmountTree();
  k.emit("display.closed", { account, cause });
  // A provisional neutral state until the next read names the right one.
  k.view.set({ kind: "neutral", state: "1e.checking" });
}

/** The level-0 gate (matrix 3.7.2 step 1): on `hidden` and on `pagehide`, synchronously. */
export function applyLevel0Gate(k: Kernel): void {
  const display = k.memory.display;
  if (display.kind === "displaying")
    k.ports.surface.saveFocusAndScroll(display.account, display.epoch);
  k.ports.surface.applyLevel0();
  if (k.memory.exposure !== null) k.memory.exposure.cancel("hidden");
  k.memory.display = { kind: "gated" };
  abortWatches(k);
  k.emit("gate.level0", {});
}

// ---- the watch, the scan --------------------------------------------------------------------------------------

const watchControllers = new WeakMap<Kernel, AbortController>();

function abortWatches(k: Kernel): void {
  watchControllers.get(k)?.abort();
  watchControllers.delete(k);
  k.memory.watching.clear();
}

/**
 * A displaying, visible page holds a `wait(id)` on every foreign REQUEST lease it knows of. A grant re-reads the
 * record: a lease still present is unresolved, so the page holds the account, unmounts and starts a verification;
 * a lease that has gone was deleted after a clean answer and the watch simply ends. Hidden pages hold none.
 */
export function watchForeignLeases(
  k: Kernel,
  record: AuthState,
  account: AccountId,
): void {
  if (k.memory.display.kind !== "displaying" || !k.ports.page.isVisible())
    return;
  for (const [id, lease] of Object.entries(record.leases)) {
    if (lease.account_id !== account || lease.boot_id === k.bootId) continue;
    if (lease.class === "exposure") continue;
    watchOne(k, id, account);
  }
}

export function noteForeignLease(
  k: Kernel,
  id: LeaseId,
  account: AccountId,
): void {
  k.memory.knownForeign.add(id);
  if (k.memory.display.kind === "displaying" && k.ports.page.isVisible())
    watchOne(k, id, account);
}

function watchOne(k: Kernel, id: LeaseId, account: AccountId): void {
  if (k.memory.watching.has(id) || k.memory.released.has(id)) {
    // A lease already released to this page is checked by the next read.
    if (k.memory.released.has(id)) k.hooks.evaluate("released_foreign");
    return;
  }
  k.memory.watching.add(id);
  let controller = watchControllers.get(k);
  if (!controller) {
    controller = new AbortController();
    watchControllers.set(k, controller);
  }
  void (async () => {
    const result = await k.ports.locks.wait(LOCKS.lease(id), controller.signal);
    k.memory.watching.delete(id);
    if (result !== "granted") return;
    k.memory.released.add(id);
    k.emit("watch.granted", { lease: id });
    // Re-read: a lease still present is unresolved.
    let record: AuthState | null = null;
    try {
      record = await k.transact(
        (records) => ({
          write: null,
          result: structuredClone(records.auth_state),
        }),
        "read",
        false,
      );
    } catch {
      record = null;
    }
    if (record === null) {
      // Cannot tell: fail closed.
      closeForUnresolved(k, account, id, new Set([id]));
      return;
    }
    if (record.leases[id] !== undefined)
      closeForUnresolved(k, account, id, new Set([id]));
  })();
}

function closeForUnresolved(
  k: Kernel,
  account: AccountId,
  lease: LeaseId,
  unresolved: ReadonlySet<LeaseId>,
): void {
  const holdId = `w:${lease}`;
  setHold(k, account, holdId, "watch");
  k.neutral = { ...k.neutral, unresolvedLeaseKnown: true };
  k.hooks.evaluate("watch_closed");
  const epoch = k.memory.settled?.epoch;
  if (epoch === undefined) {
    k.memory.releaseHold(account, holdId);
    return;
  }
  void resolveWatchHold(k, account, epoch, lease, holdId, unresolved);
}

/**
 * Keep the watch hold `w:<lease>` until THAT lease is gone from the record, then release it and let the page display
 * again (matrix 3.7.2; evidence E3 and T23 K). Two watches can fire for two orphaned leases: the second finds a
 * verification already running in this page and JOINS it (it returns when that run ends). The run it joined captured only
 * the leases released to this page when its own cover committed, so the joined caller looks at the record afterwards and
 * releases only what was actually resolved; a lease still present (not captured, or the evidence failed) keeps its hold
 * and is verified again on the back-off, never abandoned with its hold still in place.
 */
async function resolveWatchHold(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  lease: LeaseId,
  holdId: string,
  unresolved: ReadonlySet<LeaseId>,
): Promise<void> {
  for (let attempt = 0; !k.disposed; attempt += 1) {
    await k.hooks.verifyUnresolved(account, epoch, unresolved);
    if (await leaseIsGone(k, lease)) {
      k.memory.releaseHold(account, holdId);
      k.neutral = { ...k.neutral, unresolvedLeaseKnown: false };
      k.hooks.evaluate("watch_resolved");
      return;
    }
    // Another identity now stands: the lease is settled by the new settlement's own exposure (E5), not by this hold.
    const settled = k.memory.settled;
    if (
      settled === null ||
      settled.account !== account ||
      settled.epoch !== epoch
    ) {
      k.memory.releaseHold(account, holdId);
      k.hooks.evaluate("watch_superseded");
      return;
    }
    const elapsed = await k.sleep(k.backoff(attempt));
    if (!elapsed) attempt = -1;
  }
}

/** Whether the record, read now, no longer holds the lease. An unreadable or stalled record is NOT evidence: false. */
async function leaseIsGone(k: Kernel, lease: LeaseId): Promise<boolean> {
  try {
    const gone = await k.withStall(
      k.transact(
        (records) => ({
          write: null,
          result: records.auth_state.leases[lease] === undefined,
        }),
        "read",
        false,
      ),
      k.config.recordingStallMs,
    );
    return gone === true;
  } catch {
    return false;
  }
}

/** Whether a fresh read shows the displayed account closed (a fence, a gating attempt, a changed identity). */
export function recordClosesDisplay(
  record: AuthState,
  account: AccountId,
  epoch: Epoch,
): boolean {
  const settled = record.settled;
  if (!settled || settled.account_id !== account || settled.epoch !== epoch)
    return true;
  if (isGating(record.attempt)) return true;
  return (record.fences[account] ?? []).length > 0;
}

export { cancelPageActivitiesFor };

import { LOCKS } from "../constants";
import type { AuthRecords } from "../model/types";
import type { LockHandle } from "../ports/locks";
import type { Rmw } from "../ports/store";
import { readRecords } from "./evaluate";
import type { Kernel } from "./state";

/**
 * The transaction half of a closing write (matrix 3.3.1 Ex2). The caller has ALREADY run `beginClosing` as its first
 * statement (lint rule R8). This helper: requests `atlas-auth` (unless the caller holds it), WAITS - still holding
 * it, with no network call outstanding - until every reservation of another page has been released to this page (an
 * exposure lease's lock, and the ISSUE lock of every ordinary or recovery lease), then creates the write's
 * transaction, whose own body aborts and retries if it finds a reservation it has not yet seen released.
 *
 * The wait is bounded at `lockWaitMs`. On expiry the write GIVES UP: nothing was committed, `atlas-auth` is
 * released, and a time-out is never converted into a commit.
 */
interface Reservation {
  id: string;
  name: string;
  kind: "lease" | "issue";
}

function reservationsOf(
  k: Kernel,
  records: Readonly<AuthRecords>,
): Reservation[] {
  const out: Reservation[] = [];
  for (const [id, lease] of Object.entries(records.auth_state.leases)) {
    if (lease.boot_id === k.bootId) continue;
    if (lease.class === "exposure")
      out.push({ id, name: LOCKS.lease(id), kind: "lease" });
    else if (lease.class === "ordinary" || lease.class === "recovery")
      out.push({ id, name: LOCKS.issue(id), kind: "issue" });
  }
  return out;
}

const seenReleased = (k: Kernel, r: Reservation): boolean =>
  r.kind === "lease"
    ? k.memory.released.has(r.id)
    : k.memory.releasedIssue.has(r.id);

export type ClosingResult<T> =
  | { kind: "done"; value: T; auth: LockHandle | null }
  | { kind: "lock_timeout" }
  | { kind: "gave_up" }
  /** `abandonIf` held just before the transaction would have been created: nothing was committed, `atlas-auth` is released. */
  | { kind: "abandoned" }
  | { kind: "failed"; error: unknown };

export async function runClosingTransaction<T>(
  k: Kernel,
  options: {
    holdsAuth: boolean;
    keepAuth?: boolean;
    label: string;
    body: (records: Readonly<AuthRecords>) => Rmw<T>;
    /**
     * Asked immediately before the transaction is created, after every wait: true means the write is no longer wanted (the
     * page became hidden while it waited for `atlas-auth` or for another page's reservation). Nothing has been committed
     * at that point, so nothing has to be undone.
     */
    abandonIf?: () => boolean;
  },
): Promise<ClosingResult<T>> {
  let auth: LockHandle | null = null;
  if (!options.holdsAuth) {
    auth = await k.ports.locks.acquire(LOCKS.auth, {
      signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
    });
    if (auth === null) return { kind: "lock_timeout" };
  }
  let keep = false;
  try {
    const bound = k.ports.clock.abortAfter(k.config.lockWaitMs);
    for (;;) {
      const records = await readRecords(k);
      if (records === null) return { kind: "failed", error: new Error("read") };
      for (const reservation of reservationsOf(k, records)) {
        if (seenReleased(k, reservation)) continue;
        const waited = await k.ports.locks.wait(reservation.name, bound);
        if (waited === "aborted") {
          k.emit("closing.gave_up", { label: options.label });
          return { kind: "gave_up" };
        }
        if (waited === "failed")
          return { kind: "failed", error: new Error("lock") };
        (reservation.kind === "lease"
          ? k.memory.released
          : k.memory.releasedIssue
        ).add(reservation.id);
      }
      if (options.abandonIf?.() === true) {
        k.emit("closing.abandoned", { label: options.label });
        return { kind: "abandoned" };
      }
      type Wrapped = { retry: true } | { retry: false; value: T };
      let outcome: Wrapped | "stalled";
      try {
        outcome = await k.withStall(
          k.ports.store.transact<Wrapped>(
            (current) => {
              // Abort and retry if a reservation appeared that this page has not yet seen released.
              if (reservationsOf(k, current).some((r) => !seenReleased(k, r)))
                return { write: null, result: { retry: true } };
              const inner = options.body(current);
              return {
                write: inner.write,
                result: { retry: false, value: inner.result },
              };
            },
            { durability: "strict", label: options.label },
          ).complete,
          k.config.coverStallMs,
        );
      } catch (error) {
        return { kind: "failed", error };
      }
      if (outcome === "stalled")
        return { kind: "failed", error: new Error("stalled") };
      if (outcome.retry) continue;
      keep = options.keepAuth === true;
      return {
        kind: "done",
        value: outcome.value,
        auth: keep ? auth : null,
      };
    }
  } finally {
    if (!keep) auth?.release();
  }
}

import type { LockHandle, LockPort, Store } from "../../session";

/**
 * Production leadership (P-1, D 6.1, reconciliation row 6 case 5 and case (f)). ONE fixed, origin-wide exclusive Web Lock,
 * `atlas-sync-leader`, requested once per page when the leader starts: `tryAcquire` (held if granted), else an ordinary request that
 * stays QUEUED for as long as the page lives. A queued request is a follower, not a competing leader: it is granted only when the
 * holder's page ends (the platform releases the lock) or the holder disposes its leader. The lock is never released across a logout, a
 * retirement, an account switch or a re-authentication: the holder re-points itself internally. Never `navigator.locks.query()`.
 */
export type LeaderRole =
  | { kind: "idle" }
  | { kind: "electing" }
  /** This page's request is queued: another page holds the lock (`tryAcquire` refused it). */
  | { kind: "follower" }
  | { kind: "leader" };

export interface LeaderElection {
  readonly role: Store<LeaderRole>;
  /** Idempotent. */
  start(): void;
  /** Tests and HMR only: abandons a queued request, releases a held lock. Production never calls it (the page's end does). */
  dispose(): void;
}

export function createLeaderElection(deps: {
  locks: LockPort;
  name: string;
}): LeaderElection {
  let role: LeaderRole = { kind: "idle" };
  const listeners = new Set<() => void>();
  const set = (next: LeaderRole): void => {
    if (role.kind === next.kind) return;
    role = next;
    for (const listener of [...listeners]) listener();
  };
  let started = false;
  let disposed = false;
  let held: LockHandle | null = null;
  const pending = new AbortController();

  const granted = (handle: LockHandle): void => {
    if (disposed) {
      handle.release();
      return;
    }
    held = handle;
    set({ kind: "leader" });
  };

  return {
    role: {
      get: () => role,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    start() {
      if (started || disposed) return;
      started = true;
      set({ kind: "electing" });
      void (async () => {
        let first: LockHandle | null = null;
        try {
          first = await deps.locks.tryAcquire(deps.name);
        } catch {
          first = null;
        }
        if (first !== null) {
          granted(first);
          return;
        }
        if (disposed) return;
        // Another page holds the lock: this page follows, and its request waits, queued, for as long as the page lives.
        set({ kind: "follower" });
        const later = await deps.locks.acquire(deps.name, {
          signal: pending.signal,
          abandonIf: () => disposed,
        });
        if (later !== null) granted(later);
      })();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.abort();
      held?.release();
      held = null;
      set({ kind: "idle" });
    },
  };
}

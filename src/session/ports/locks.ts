/** Web Locks as the protocol uses them: never `query()`, never `steal` (matrix 3.3, 3.11). */
export interface LockHandle {
  /** Synchronous and idempotent. */
  release(): void;
}

export interface LockPort {
  /**
   * Exclusive request. Resolves once GRANTED (the callback has run and `release` exists); null if `signal` aborts
   * first. A handle that is granted after `signal` aborted is released before this resolves.
   */
  acquire(
    name: string,
    options?: {
      signal?: AbortSignal;
      /** Consulted synchronously in the grant callback: when true the lock is given up at once and null resolves. */
      abandonIf?: () => boolean;
    },
  ): Promise<LockHandle | null>;
  /**
   * wait(id): request, and release at once when granted. Aborting before the grant resolves "aborted"; any other
   * failure of the lock manager resolves "failed" (a wait that could not be made is not a grant).
   */
  wait(
    name: string,
    signal?: AbortSignal,
  ): Promise<"granted" | "aborted" | "failed">;
  /** probe(id): `ifAvailable`. `true` proves the lock was released; `false` proves NOTHING. */
  probe(name: string): Promise<boolean>;
  /**
   * `ifAvailable`, and HOLD it on a grant. Null when it was not available. Used only for liveness and
   * de-duplication locks whose correctness never depends on them (`atlas-op-<id>`, decision D-17).
   */
  tryAcquire(name: string): Promise<LockHandle | null>;
}

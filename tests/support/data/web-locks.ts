import type { LockManagerLike } from "../../../src/session/adapters/web-locks";

/**
 * A model of the origin's Web Locks as the ownership of quota holds uses them (R28, revision 15): exclusive locks per name, an
 * `ifAvailable` request that calls back with `null` while the name is held and otherwise holds it until the callback's promise
 * settles, and a destroyed page whose locks the platform releases. `query()` and `steal` do not exist here (lint rule R2): any use
 * fails the test. It is the origin-wide registry that the production `createWebLocksPort(navigator.locks)` talks to, one manager per
 * page over it (`forPage`), so the REAL adapter (`tryAcquire`, `probe`) and the REAL ledger are exercised, not a double of either.
 *
 * `delayReleases()` models the platform's latency (premise P-lock-b): a release is not published at once, so for a while an
 * `ifAvailable` request still finds the lock held (a probe says `false`, which proves nothing).
 */
export class FakeWebLocks {
  /** name -> the page that holds it. */
  private held = new Map<string, string>();
  /** name -> the function that ends the hold (the callback's promise resolves). */
  private ends = new Map<string, () => void>();
  private unpublished = new Set<string>();
  private delaying = false;
  /** Called when a lock is released (before it can be granted again), with its name. */
  onRelease: (name: string) => void = () => undefined;
  /** Every request made, in order, by page and name (`ifAvailable` requests only: the only kind the ownership makes). */
  readonly requests: Array<{ page: string; name: string; granted: boolean }> =
    [];
  /** Requests that fail outright (the lock manager throws): the next `n`. */
  failing = 0;
  /** Requests that fail outright when this matches (the lock manager throws): until it is cleared with `null`. */
  failWhen: ((page: string, name: string) => boolean) | null = null;

  forPage(page: string): LockManagerLike & { query: () => never } {
    const manager = this;
    return {
      request(
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => unknown,
      ): Promise<unknown> {
        return manager.request(page, name, options, callback);
      },
      query() {
        throw new Error("navigator.locks.query() must never be called");
      },
    } as unknown as LockManagerLike & { query: () => never };
  }

  private async request(
    page: string,
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => unknown,
  ): Promise<unknown> {
    if (this.failing > 0) {
      this.failing -= 1;
      throw new Error("the lock manager failed");
    }
    if (this.failWhen?.(page, name) === true)
      throw new Error("the lock manager failed");
    if (options.ifAvailable !== true)
      throw new Error("the ownership only makes `ifAvailable` requests");
    if (this.held.has(name)) {
      this.requests.push({ page, name, granted: false });
      return callback(null);
    }
    this.requests.push({ page, name, granted: true });
    this.held.set(name, page);
    let destroyed!: () => void;
    const gone = new Promise<undefined>((resolve) => {
      destroyed = () => resolve(undefined);
    });
    this.ends.set(name, destroyed);
    try {
      // The lock is held until the callback's own promise settles (or the page is destroyed).
      return await Promise.race([
        Promise.resolve(callback({ name, mode: "exclusive" } as Lock)),
        gone,
      ]);
    } finally {
      this.release(name);
    }
  }

  private release(name: string): void {
    if (!this.held.has(name)) return;
    this.ends.delete(name);
    if (this.delaying) {
      this.unpublished.add(name);
      this.onRelease(name);
      return;
    }
    this.held.delete(name);
    this.onRelease(name);
  }

  /** The page is destroyed: the platform releases every lock it holds (and publishes it, whatever the delay). */
  destroy(page: string): void {
    for (const [name, holder] of [...this.held]) {
      if (holder !== page) continue;
      this.ends.get(name)?.();
      this.ends.delete(name);
      this.held.delete(name);
      this.unpublished.delete(name);
    }
  }

  /** From now on a release is published only by `publish()`. */
  delayReleases(): { publish(): void } {
    this.delaying = true;
    return {
      publish: () => {
        for (const name of this.unpublished) this.held.delete(name);
        this.unpublished.clear();
        this.delaying = false;
      },
    };
  }

  /** The names held now (published or not), for assertions only. */
  names(): string[] {
    return [...this.held.keys()];
  }
}

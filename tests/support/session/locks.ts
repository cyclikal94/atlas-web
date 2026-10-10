import type { LockManagerLike } from "../../../src/session/adapters/web-locks";
import type { World } from "./world";

/**
 * A faithful stand-in for the origin's Web Locks manager (plan 13.1): first-in-first-out per name; `exclusive` and `shared`
 * requests (a shared request is granted together with other shared holders and never alongside an exclusive one, and a shared
 * request queued behind a waiting exclusive one waits for it, as the specification's queue does); a lock is granted only after
 * its holder's release has been PUBLISHED (delay knob D1); `ifAvailable` calls back with null while the lock is held or its
 * release is unpublished; a `signal` rejects a not-yet-granted request with AbortError and is ignored once granted;
 * `query()` and `steal` throw so any use fails the test. A destroyed page's locks are released by the platform (also through D1).
 */
interface Holder {
  page: string;
  token: number;
  mode: "exclusive" | "shared";
}
interface Pending {
  page: string;
  mode: "exclusive" | "shared";
  callback: (lock: object | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
interface LockState {
  /** Every current holder: one exclusive, or any number of shared. */
  holders: Holder[];
  /** Releases not yet published (a grant waits for them, as it waited for the single holder's). */
  releasing: number;
  /** An exclusive release is among the unpublished ones: nothing at all is granted until it is published. */
  exclusiveReleasing: number;
  queue: Pending[];
}

export class FakeLockManager {
  private states = new Map<string, LockState>();
  private tokens = 0;
  /** Every lock name each page currently holds (for destruction). */
  private heldBy = new Map<string, Set<string>>();

  constructor(private readonly world: World) {}

  private state(name: string): LockState {
    let state = this.states.get(name);
    if (!state) {
      state = { holders: [], releasing: 0, exclusiveReleasing: 0, queue: [] };
      this.states.set(name, state);
    }
    return state;
  }

  /** The `navigator.locks` object as one page sees it. */
  forPage(page: string): LockManagerLike & {
    query: () => never;
  } {
    const manager = this;
    return {
      request(
        name: string,
        a: LockOptions | ((lock: Lock | null) => unknown),
        b?: (lock: Lock | null) => unknown,
      ): Promise<never> {
        const options: LockOptions = typeof a === "function" ? {} : a;
        const callback = (typeof a === "function" ? a : b) as (
          lock: object | null,
        ) => unknown;
        return manager.request(page, name, options, callback) as Promise<never>;
      },
      query() {
        manager.world.log({ type: "spy.locks_query", page });
        throw new Error("navigator.locks.query() must never be called");
      },
    } as unknown as LockManagerLike & { query: () => never };
  }

  private request(
    page: string,
    name: string,
    options: LockOptions,
    callback: (lock: object | null) => unknown,
  ): Promise<unknown> {
    if (options.steal) {
      this.world.log({ type: "spy.locks_steal", page, name });
      throw new Error("steal must never be used");
    }
    const log = (type: string, extra: Record<string, unknown> = {}) =>
      this.world.log({ type, page, name, ...extra });
    return new Promise<unknown>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      log("lock.request", { ifAvailable: options.ifAvailable === true });
      const state = this.state(name);
      if (options.ifAvailable) {
        this.world.schedule(
          "lock_grant",
          page,
          { name, ifAvailable: true },
          () => {
            const free =
              state.holders.length === 0 &&
              state.releasing === 0 &&
              state.queue.length === 0;
            if (!free) {
              log("lock.unavailable");
              try {
                resolve(callback(null));
              } catch (error) {
                reject(error);
              }
              return;
            }
            this.grantTo(state, name, {
              page,
              mode: "exclusive",
              callback,
              resolve,
              reject,
            });
          },
        );
        return;
      }
      const pending: Pending = {
        page,
        mode: options.mode === "shared" ? "shared" : "exclusive",
        callback,
        resolve,
        reject,
      };
      if (options.signal) {
        pending.signal = options.signal;
        pending.onAbort = () => {
          const index = state.queue.indexOf(pending);
          if (index === -1) return;
          state.queue.splice(index, 1);
          log("lock.aborted");
          reject(new DOMException("aborted", "AbortError"));
        };
        options.signal.addEventListener("abort", pending.onAbort, {
          once: true,
        });
      }
      state.queue.push(pending);
      this.world.schedule("lock_grant", page, { name }, () =>
        this.tryGrant(name),
      );
    });
  }

  /** Whether the head of the queue may be granted now: in queue order, and never past a request that has to wait. */
  private grantable(state: LockState, head: Pending): boolean {
    if (head.mode === "exclusive")
      return state.holders.length === 0 && state.releasing === 0;
    return (
      state.exclusiveReleasing === 0 &&
      state.holders.every((holder) => holder.mode === "shared")
    );
  }

  private tryGrant(name: string): void {
    const state = this.state(name);
    while (state.queue.length > 0) {
      const head = state.queue[0] as Pending;
      if (this.world.isDestroyed(head.page)) {
        state.queue.shift();
        if (head.onAbort)
          head.signal?.removeEventListener("abort", head.onAbort);
        continue;
      }
      if (!this.grantable(state, head)) return;
      state.queue.shift();
      if (head.onAbort) head.signal?.removeEventListener("abort", head.onAbort);
      this.grantTo(state, name, head);
      // A shared grant may be followed by more shared requests that were queued behind it; an exclusive one ends the round.
      if (head.mode === "exclusive") return;
    }
  }

  private grantTo(
    state: LockState,
    name: string,
    request: Pick<Pending, "page" | "mode" | "callback" | "resolve" | "reject">,
  ): void {
    const holder: Holder = {
      page: request.page,
      token: ++this.tokens,
      mode: request.mode,
    };
    state.holders.push(holder);
    let held = this.heldBy.get(request.page);
    if (!held) {
      held = new Set();
      this.heldBy.set(request.page, held);
    }
    held.add(name);
    this.world.log({
      type: "lock.grant",
      page: request.page,
      name,
      mode: request.mode,
    });
    let outcome: unknown;
    try {
      outcome = request.callback({ name, mode: request.mode });
    } catch (error) {
      this.release(name, holder, "callback_threw");
      request.reject(error);
      return;
    }
    Promise.resolve(outcome).then(
      (value) => {
        if (this.world.isDestroyed(request.page)) return;
        this.release(name, holder, "released");
        request.resolve(value);
      },
      (error) => {
        if (this.world.isDestroyed(request.page)) return;
        this.release(name, holder, "released");
        request.reject(error);
      },
    );
  }

  private release(name: string, holder: Holder, reason: string): void {
    const state = this.state(name);
    const index = state.holders.findIndex((h) => h.token === holder.token);
    if (index === -1) return;
    state.holders.splice(index, 1);
    state.releasing += 1;
    if (holder.mode === "exclusive") state.exclusiveReleasing += 1;
    if (!state.holders.some((h) => h.page === holder.page))
      this.heldBy.get(holder.page)?.delete(name);
    this.world.log({
      type: "lock.release",
      page: holder.page,
      name,
      reason,
      mode: holder.mode,
    });
    // The release is PUBLISHED later; nothing is granted, and `ifAvailable` still sees the lock held, until then.
    this.world.schedule("D1", null, { name, releasedBy: holder.page }, () => {
      state.releasing -= 1;
      if (holder.mode === "exclusive") state.exclusiveReleasing -= 1;
      this.world.log({ type: "lock.published", name });
      this.tryGrant(name);
    });
  }

  /** The platform releases every lock of a destroyed page and abandons its queued requests. */
  destroyPage(page: string): void {
    for (const [name, state] of this.states) {
      state.queue = state.queue.filter((pending) => {
        if (pending.page !== page) return true;
        if (pending.onAbort)
          pending.signal?.removeEventListener("abort", pending.onAbort);
        return false;
      });
      for (const holder of state.holders.filter((h) => h.page === page))
        this.release(name, holder, "destroyed");
    }
  }

  /** Names currently held by a page (a test oracle; the production code cannot see this). */
  heldNames(page: string): string[] {
    return [...(this.heldBy.get(page) ?? [])];
  }
  allHeldNames(): Array<{ page: string; name: string }> {
    const out: Array<{ page: string; name: string }> = [];
    for (const [page, names] of this.heldBy) {
      for (const name of names) out.push({ page, name });
    }
    return out;
  }
  isFree(name: string): boolean {
    const state = this.states.get(name);
    return !state || (state.holders.length === 0 && state.releasing === 0);
  }
  /** Whether a page holds the lock EXCLUSIVELY right now (the protocol's premise about every settlement, checked by the store). */
  holdsExclusive(page: string, name: string): boolean {
    return (
      this.states
        .get(name)
        ?.holders.some((h) => h.page === page && h.mode === "exclusive") ??
      false
    );
  }
}

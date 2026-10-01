import type { LockManagerLike } from "../../../src/session/adapters/web-locks";
import type { World } from "./world";

/**
 * A faithful stand-in for the origin's Web Locks manager (plan 13.1): exclusive locks only; first-in-first-out per
 * name; a lock is granted only after its holder's release has been PUBLISHED (delay knob D1); `ifAvailable` calls
 * back with null while the lock is held or its release is unpublished; a `signal` rejects a not-yet-granted request
 * with AbortError and is ignored once granted; `query()` and `steal` throw so any use fails the test. A destroyed
 * page's locks are released by the platform (also through D1).
 */
interface Holder {
  page: string;
  token: number;
}
interface Pending {
  page: string;
  callback: (lock: object | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
interface LockState {
  holder: Holder | null;
  /** The holder released; the release is not yet published. */
  releasing: boolean;
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
      state = { holder: null, releasing: false, queue: [] };
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
              state.holder === null &&
              !state.releasing &&
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
              callback,
              resolve,
              reject,
            });
          },
        );
        return;
      }
      const pending: Pending = { page, callback, resolve, reject };
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

  private tryGrant(name: string): void {
    const state = this.state(name);
    if (state.holder !== null || state.releasing) return;
    while (state.queue.length > 0) {
      const next = state.queue.shift() as Pending;
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      if (this.world.isDestroyed(next.page)) continue;
      this.grantTo(state, name, next);
      return;
    }
  }

  private grantTo(
    state: LockState,
    name: string,
    request: Pick<Pending, "page" | "callback" | "resolve" | "reject">,
  ): void {
    const holder: Holder = { page: request.page, token: ++this.tokens };
    state.holder = holder;
    let held = this.heldBy.get(request.page);
    if (!held) {
      held = new Set();
      this.heldBy.set(request.page, held);
    }
    held.add(name);
    this.world.log({ type: "lock.grant", page: request.page, name });
    let outcome: unknown;
    try {
      outcome = request.callback({ name, mode: "exclusive" });
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
    if (state.holder?.token !== holder.token) return;
    state.holder = null;
    state.releasing = true;
    this.heldBy.get(holder.page)?.delete(name);
    this.world.log({ type: "lock.release", page: holder.page, name, reason });
    // The release is PUBLISHED later; nothing is granted, and `ifAvailable` still sees the lock held, until then.
    this.world.schedule("D1", null, { name, releasedBy: holder.page }, () => {
      state.releasing = false;
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
      if (state.holder?.page === page)
        this.release(name, state.holder, "destroyed");
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
    return !state || (state.holder === null && !state.releasing);
  }
}

import type { LockHandle, LockPort } from "../ports/locks";

/** The part of `navigator.locks` the protocol uses. `query()` and `steal` are deliberately not part of it (R2, matrix 3.3). */
export type LockManagerLike = Pick<LockManager, "request">;

const isAbort = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

/**
 * The production `LockPort` over Web Locks. There is no fallback: the capability check has already refused a browser
 * without them (answer Q12). A lock is requested `exclusive` (the protocol's own locks) or, for `acquireShared`, `shared` (the
 * persistence hold, which must coexist with other holds and conflict with every settlement); it is never stolen, and never read
 * with `query()`.
 */
export function createWebLocksPort(locks: LockManagerLike): LockPort {
  return {
    acquire(name, options) {
      return new Promise<LockHandle | null>((resolve) => {
        const abandonIf = options?.abandonIf;
        const request = locks.request(
          name,
          { mode: "exclusive", signal: options?.signal },
          (lock) => {
            if (!lock) {
              resolve(null);
              return undefined;
            }
            if (abandonIf?.()) {
              resolve(null);
              return undefined;
            }
            return new Promise<void>((done) => {
              let released = false;
              resolve({
                release() {
                  if (released) return;
                  released = true;
                  done();
                },
              });
            });
          },
        );
        request.catch(() => resolve(null));
      });
    },
    acquireShared(name, options) {
      return new Promise<LockHandle | null>((resolve) => {
        const request = locks.request(
          name,
          { mode: "shared", signal: options?.signal },
          (lock) => {
            if (!lock) {
              resolve(null);
              return undefined;
            }
            return new Promise<void>((done) => {
              let released = false;
              resolve({
                release() {
                  if (released) return;
                  released = true;
                  done();
                },
              });
            });
          },
        );
        request.catch(() => resolve(null));
      });
    },
    async wait(name, signal) {
      try {
        await locks.request(
          name,
          { mode: "exclusive", signal },
          () => undefined,
        );
        return "granted";
      } catch (error) {
        return isAbort(error) ? "aborted" : "failed";
      }
    },
    tryAcquire(name) {
      return new Promise<LockHandle | null>((resolve) => {
        const request = locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((done) => {
            let released = false;
            resolve({
              release() {
                if (released) return;
                released = true;
                done();
              },
            });
          });
        });
        request.catch(() => resolve(null));
      });
    },
    async probe(name) {
      try {
        const granted = await locks.request(
          name,
          { ifAvailable: true },
          (lock) => lock !== null,
        );
        return granted === true;
      } catch {
        return false;
      }
    },
  };
}

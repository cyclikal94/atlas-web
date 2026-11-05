/**
 * The page's RECOVERY IDENTIFIER (WEB-14a, D-P6; WEB-03 5, sixth-round correction): the `tab_instance_id` its recovery copies are keyed by.
 *
 *  - It is minted at the page's FIRST save, with `crypto.randomUUID()`, and kept in memory only: never in `sessionStorage`, which a
 *    duplicated or opener-copied tab inherits, so two tabs can never share one and overwrite each other's copy. A reload is a new page and
 *    a new identifier; the copies of the page it replaced are found by `list`.
 *  - While the page lives it holds the Web Lock `atlas-recovery-tab-<id>`, granted before its first copy is written. A copy whose
 *    identifier's lock is still held belongs to a tab that is OPEN (it may still be editing that form), so a restoring page never takes it
 *    over or discards it; only copies of tabs that have gone are offered for restore. Ownership is probed with `ifAvailable` (never
 *    `locks.query`, which some engines answer inconsistently), in shared mode (revision 52, F-R52-1): see `observe`.
 *  - OWNERSHIP PRECEDES EXPOSURE (revision 3, R12). An identifier is the page's only once its lock is GRANTED: a candidate being acquired
 *    is not advertised, and a request that fails (the lock manager rejects or throws) rejects every waiter with a
 *    `RecoveryIdentityError`, so no copy is written under an identifier nobody holds (a live page's copy would look like a gone tab's to
 *    every other page). The next `id()` makes a new acquisition. A page without a lock manager has no recovery identity at all
 *    (`getPageRecoveryTab`); `locks: null` is a test double only.
 */
export interface RecoveryTab {
  /** The page's identifier: its lock is held before it is returned; rejects (`RecoveryIdentityError`) when the lock cannot be had. */
  id(): Promise<string>;
  /** The identifier, once this page holds its lock. */
  current(): string | null;
  /** Whether the tab that owns `id` is still open (this page's own identifier is always open). */
  ownerOpen(id: string): Promise<boolean>;
  /**
   * Revision 6 (R13; `handoff.ts`): holds the update hand-off `id`'s lock (`atlas-recovery-handoff-<id>`) for the page's life. True once
   * held (at once when this page holds it already); false when it cannot be had: another live page holds it after `wait` ms, or the lock
   * manager refused. Only authority depends on it, never whether input is shown. The three hand-off methods are optional for a double
   * written before revision 6, which then behaves as one with no lock manager (holds any hand-off; sees none held but its own).
   */
  holdHandoff?(id: string, wait?: number): Promise<boolean>;
  /** Whether a live page (this one included) holds the hand-off `id`. A probe that cannot be made says held. */
  handoffHeld?(id: string): Promise<boolean>;
  /** Runs `act` holding the hand-off `id`'s lock if nobody holds it; null (nothing run) when somebody does or it cannot be asked. */
  whileFree?<T>(id: string, act: () => Promise<T>): Promise<T | null>;
}

export interface RecoveryTabDeps {
  uuid(): string;
  /**
   * `navigator.locks`. TESTS ONLY: null for a double with no lock manager, whose identifier is its own at once and every other owner
   * counts as gone (no cross-tab safety: never the page's).
   */
  locks: Pick<LockManager, "request"> | null;
}

/** The page's recovery identity cannot be had (its lock was refused, or the page has no lock manager): nothing may be saved under it. */
export class RecoveryIdentityError extends Error {
  constructor(readonly reason: unknown) {
    super("The page's recovery identity could not be acquired");
    this.name = "RecoveryIdentityError";
  }
}

export const recoveryLockName = (id: string): string =>
  `atlas-recovery-tab-${id}`;

export const handoffLockName = (id: string): string =>
  `atlas-recovery-handoff-${id}`;

/**
 * A PASSIVE observation (WEB-14a revision 52, F-R52-1 and DA-N1; design assessment of 3 November 2026, C1, L1-L3): whether nobody holds
 * `name` exclusively now and no exclusive request waits for it, without waiting. It asks in SHARED mode, so observations are compatible with
 * one another: any number of pages (or forms of one page) looking at one closed owner, or one abandoned hand-off, at once all find it free.
 * An exclusive probe made each observer a momentary owner of the lock it probed, so a concurrent observer saw a live owner and a closed
 * tab's second copy was not offered. Authority stays exclusive and is never made here: a page's identifier, a hand-off claim
 * (`holdHandoff`) and an action over an abandoned hand-off (`whileFree`) each hold the lock exclusively, so an observation is refused
 * while any of them holds it or waits for it, and is never authority to change a copy. The shared hold ends when the callback returns (it
 * can briefly delay an exclusive request, as the exclusive probe did). Rejects when the lock manager refuses: callers keep their
 * conservative answer.
 */
const observe = (
  locks: Pick<LockManager, "request">,
  name: string,
): Promise<boolean> =>
  locks.request(
    name,
    { mode: "shared", ifAvailable: true },
    (lock) => lock !== null,
  );

export function createRecoveryTab(deps: RecoveryTabDeps): RecoveryTab {
  /** The identifier whose lock this page holds, once granted. */
  let owned: string | null = null;
  /** The acquisition in flight (its candidate is not the page's yet), shared by every caller. */
  let acquiring: { candidate: string; held: Promise<string> } | null = null;
  /** The hand-offs this page holds or is asking for (revision 6, R13). */
  const handoffs = new Map<string, Promise<boolean>>();
  return {
    id() {
      if (owned !== null) return Promise.resolve(owned);
      if (acquiring) return acquiring.held;
      const candidate = deps.uuid();
      const locks = deps.locks;
      if (!locks) {
        owned = candidate;
        return Promise.resolve(candidate);
      }
      // Made before the request (a lock manager may call back at once); only this attempt is ever forgotten by its own outcome.
      const attempt = { candidate, held: Promise.resolve(candidate) };
      const end = (): void => {
        if (acquiring === attempt) acquiring = null;
      };
      acquiring = attempt;
      attempt.held = new Promise<string>((resolve, reject) => {
        const refused = (reason: unknown): void => {
          end();
          reject(new RecoveryIdentityError(reason));
        };
        try {
          // Held for the page's life: the callback's promise never settles, so the lock is released only when the page goes.
          locks
            .request(recoveryLockName(candidate), { mode: "exclusive" }, () => {
              end();
              owned = candidate;
              resolve(candidate);
              return new Promise<never>(() => undefined);
            })
            // Not granted (rejected or thrown): no identity, and the next `id()` makes a new acquisition.
            .catch(refused);
        } catch (reason) {
          refused(reason);
        }
      });
      return attempt.held;
    },
    current: () => owned,
    async ownerOpen(id) {
      if (id === owned || id === acquiring?.candidate) return true;
      const locks = deps.locks;
      if (!locks) return false;
      try {
        // Free (no page holds it exclusively): the owner has gone. Another observer of the same owner is never mistaken for it.
        return !(await observe(locks, recoveryLockName(id)));
      } catch {
        // A probe that cannot be made says nothing: the copy is treated as another open tab's and left alone.
        return true;
      }
    },
    holdHandoff(id, wait = 0) {
      const known = handoffs.get(id);
      if (known) return known;
      const locks = deps.locks;
      const name = handoffLockName(id);
      // Held for the page's life once granted: the callback's promise never settles.
      const hold = (options: LockOptions): Promise<boolean> =>
        new Promise<boolean>((resolve, reject) => {
          locks
            ?.request(name, options, (lock) => {
              if (lock === null) {
                resolve(false);
                return;
              }
              resolve(true);
              return new Promise<never>(() => undefined);
            })
            .catch(reject);
        });
      const asked = (async (): Promise<boolean> => {
        if (!locks) return true;
        try {
          if (await hold({ mode: "exclusive", ifAvailable: true })) return true;
          if (wait <= 0) return false;
          // Another page holds it now (a page that is going, whose locks the browser has not released yet, or a duplicated tab).
          const stop = new AbortController();
          const timer = setTimeout(() => stop.abort(), wait);
          try {
            return await hold({ mode: "exclusive", signal: stop.signal });
          } finally {
            clearTimeout(timer);
          }
        } catch {
          return false;
        }
      })();
      handoffs.set(id, asked);
      // Not held: the next ask asks again.
      void asked.then((held) => {
        if (!held && handoffs.get(id) === asked) handoffs.delete(id);
      });
      return asked;
    },
    async handoffHeld(id) {
      const known = handoffs.get(id);
      if (known && (await known)) return true;
      const locks = deps.locks;
      if (!locks) return false;
      try {
        return !(await observe(locks, handoffLockName(id)));
      } catch {
        return true;
      }
    },
    async whileFree(id, act) {
      if (handoffs.has(id)) return null;
      const locks = deps.locks;
      if (!locks) return act();
      try {
        return await locks.request(
          handoffLockName(id),
          { mode: "exclusive", ifAvailable: true },
          (lock) => (lock === null ? null : act()),
        );
      } catch {
        return null;
      }
    },
  };
}

let page: RecoveryTab | null = null;
/** A page with no lock manager: it cannot own an identifier, so it saves no copy (revision 3, R12); every copy it finds is another tab's. */
const unavailable: RecoveryTab = {
  id: () =>
    Promise.reject(new RecoveryIdentityError("no Web Locks in this page")),
  current: () => null,
  ownerOpen: async () => true,
  holdHandoff: async () => false,
  handoffHeld: async () => true,
  whileFree: async () => null,
};

/** The page's recovery identity (memoised). */
export function getPageRecoveryTab(): RecoveryTab {
  const locks =
    typeof navigator !== "undefined" ? (navigator.locks ?? null) : null;
  page ??= locks
    ? createRecoveryTab({ uuid: () => crypto.randomUUID(), locks })
    : unavailable;
  return page;
}

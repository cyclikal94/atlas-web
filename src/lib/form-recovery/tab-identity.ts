/**
 * The page's RECOVERY IDENTIFIER (WEB-14a, D-P6; WEB-03 5, sixth-round correction): the `tab_instance_id` its recovery copies are keyed by.
 *
 *  - It is minted at the page's FIRST save, with `crypto.randomUUID()`, and kept in memory only: never in `sessionStorage`, which a
 *    duplicated or opener-copied tab inherits, so two tabs can never share one and overwrite each other's copy. A reload is a new page and
 *    a new identifier; the copies of the page it replaced are found by `list`.
 *  - While the page lives it holds the Web Lock `atlas-recovery-tab-<id>`, granted before its first copy is written. A copy whose
 *    identifier's lock is still held belongs to a tab that is OPEN (it may still be editing that form), so a restoring page never takes it
 *    over or discards it; only copies of tabs that have gone are offered for restore. Ownership is probed with `ifAvailable` (never
 *    `locks.query`, which some engines answer inconsistently).
 */
export interface RecoveryTab {
  /** The page's identifier, minted on first use (the lock is held before it is returned). */
  id(): Promise<string>;
  /** The identifier, if this page has minted one. */
  current(): string | null;
  /** Whether the tab that owns `id` is still open (this page's own identifier is always open). */
  ownerOpen(id: string): Promise<boolean>;
}

export interface RecoveryTabDeps {
  uuid(): string;
  /** `navigator.locks`; null where the page has none (a unit test), when every other owner counts as gone. */
  locks: Pick<LockManager, "request"> | null;
}

export const recoveryLockName = (id: string): string =>
  `atlas-recovery-tab-${id}`;

export function createRecoveryTab(deps: RecoveryTabDeps): RecoveryTab {
  let minted: string | null = null;
  let held: Promise<string> | null = null;
  return {
    id() {
      if (held) return held;
      const id = deps.uuid();
      minted = id;
      const locks = deps.locks;
      held = locks
        ? new Promise<string>((resolve) => {
            // Held for the page's life: the callback's promise never settles, so the lock is released only when the page goes.
            void locks
              .request(recoveryLockName(id), { mode: "exclusive" }, () => {
                resolve(id);
                return new Promise<never>(() => undefined);
              })
              .catch(() => resolve(id));
          })
        : Promise.resolve(id);
      return held;
    },
    current: () => minted,
    async ownerOpen(id) {
      if (id === minted) return true;
      const locks = deps.locks;
      if (!locks) return false;
      try {
        // Granted only when nobody holds it: the owner has gone. The probe's own hold ends when the callback returns.
        return await locks.request(
          recoveryLockName(id),
          { mode: "exclusive", ifAvailable: true },
          (lock) => lock === null,
        );
      } catch {
        // A probe that cannot be made says nothing: the copy is treated as another open tab's and left alone.
        return true;
      }
    },
  };
}

let page: RecoveryTab | null = null;
/** The page's recovery identity (memoised). */
export function getPageRecoveryTab(): RecoveryTab {
  page ??= createRecoveryTab({
    uuid: () => crypto.randomUUID(),
    locks: typeof navigator !== "undefined" ? (navigator.locks ?? null) : null,
  });
  return page;
}

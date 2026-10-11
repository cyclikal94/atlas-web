/**
 * Where to put the person back when the protected tree mounts again (WEB-08c, decision D-8c-03): after an in-place same-account
 * re-authentication (G-23) the screen they confirmed from, and after "Review this device" (G-10) the device row. PAGE MEMORY, one
 * destination at a time, and only a NAVIGATION CONVENIENCE: it never grants anything, carries no account data beyond the account id
 * the person was already looking at, and is dropped rather than applied whenever there is any doubt it is theirs:
 *  - it is applied only when the SAME account mounts, at the epoch it asks for (a re-authentication: a NEWER epoch than the one it was
 *    requested under; a device review: that epoch or later);
 *  - it is used once;
 *  - it expires `RETURN_DESTINATION_TTL_MS` after it was requested;
 *  - another account mounting drops it.
 */
export const RETURN_DESTINATION_TTL_MS = 120_000;

export interface ReturnDestination {
  readonly account: string;
  readonly epoch: number;
  /** `newer`: only an epoch above `epoch` (a new session of the same account); `same-or-newer`: `epoch` or above. */
  readonly when: "newer" | "same-or-newer";
  /** An application path, e.g. `/settings/signing-in`. */
  readonly path: string;
  /** The `data-return-focus` value of the control to focus once it exists. */
  readonly focusKey: string;
  readonly requestedAt: number;
}

let pending: ReturnDestination | null = null;

export const returnDestination = {
  set(destination: ReturnDestination): void {
    pending = destination;
  },
  peek: (): ReturnDestination | null => pending,
  clear(): void {
    pending = null;
  },
  /**
   * Drops `destination` if it is still the pending one (WEB-08c, R2 of the review of 11 October 2026): a request that set a destination
   * and then ended without a settlement cleans up ITS OWN, never a newer request's for the same account.
   */
  clearIf(destination: ReturnDestination): void {
    if (pending === destination) pending = null;
  },
  /**
   * The destination for the account that has just mounted, consumed; or null. A destination for ANOTHER account, or one that has
   * expired, is dropped. One that is the same account's but waits for a newer epoch than this mount's is KEPT (a remount of the old
   * session before the new one settles must not spend it).
   */
  take(account: string, epoch: number, now: number): ReturnDestination | null {
    const found = pending;
    if (found === null) return null;
    if (
      found.account !== account ||
      now - found.requestedAt > RETURN_DESTINATION_TTL_MS
    ) {
      pending = null;
      return null;
    }
    const due =
      found.when === "newer" ? epoch > found.epoch : epoch >= found.epoch;
    if (!due) return null;
    pending = null;
    return found;
  },
};

/**
 * Focuses `[data-return-focus="<key>"]` once it is in the document (a Settings dialog loads its rows after a request), for at most
 * `timeoutMs`. Returns a function that stops looking.
 */
export function focusWhenPresent(
  key: string,
  options: { timeoutMs?: number; root?: Document } = {},
): () => void {
  const root = options.root ?? document;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = () => {
    if (stopped) return;
    const target = root.querySelector<HTMLElement>(
      `[data-return-focus="${CSS.escape(key)}"]`,
    );
    if (target && !target.closest("[inert]")) {
      target.focus();
      if (root.activeElement === target) return;
    }
    if (Date.now() < deadline) timer = setTimeout(look, 50);
  };
  look();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

import type { Store } from "../../session";

/**
 * What a controller says of the LIFETIME of the cache it is bound to (WEB-13b revision 7, review 7 R7; design assessment C1/C2), for what
 * outlives every controller of the page: a kept import session, whose dialog and protected tree may both be gone while the page's leader
 * goes on syncing. Null while the controller is bound to no database.
 *
 * A controller is the protected tree's (`DataProvider` builds one per mount and disposes it at unmount), so no single controller can be
 * observed for a page's lifetime. What CAN be compared across controllers is the durable invalidation witness (revision 8, review 8 R7b:
 * `sync_state.cache_invalidation_seq`): every committed invalidation moves it on (W18, W24's abandonment of a valid cache) and nothing else
 * does (a first fill and an empty attempt's restart move `recovery_generation`, which revision 7 compared, but not this), so two readings
 * that differ saw an invalidation between them, even when no controller was there to see it.
 */
export interface CacheLifetime {
  readonly account: string;
  readonly incarnationId: string;
  /** The invalidation witness the established sync facts name; null while none are (the first read pending, or failed with none before it). */
  readonly invalidations: number | null;
  /**
   * The cache is KNOWN to be invalid: its status says so, or an invalidation the server admitted has not been written yet (its durable
   * streak, its marker, a hold of this page's engine). A cache that is merely unverified (not read yet, an unreadable marker) is not.
   */
  readonly invalidated: boolean;
  /** The established cache is valid and not known to be invalid. */
  readonly valid: boolean;
}

/** The page's cache lifetime: what the controller published most recently, and still publishing, says (null when none publishes). */
export interface CacheLifetimes {
  get(): CacheLifetime | null;
  subscribe(listener: () => void): () => void;
}

const sources: Array<{ source: Store<CacheLifetime | null> }> = [];
const listeners = new Set<() => void>();
const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

export const pageCacheLifetime: CacheLifetimes = {
  get: () => sources.at(-1)?.source.get() ?? null,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * A mounted controller publishes its cache lifetime for as long as it is mounted (`DataEnvProvider`); the returned function withdraws THIS
 * publication only, so a late or replayed withdrawal (Strict Mode) never withdraws a successor's, nor another publication of the same store.
 */
export function publishCacheLifetime(
  source: Store<CacheLifetime | null>,
): () => void {
  const entry = { source };
  sources.push(entry);
  const off = source.subscribe(() => {
    if (sources.at(-1) === entry) notify();
  });
  notify();
  return () => {
    const at = sources.indexOf(entry);
    if (at < 0) return;
    off();
    sources.splice(at, 1);
    notify();
  };
}

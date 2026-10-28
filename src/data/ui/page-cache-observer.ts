import type { AccountService } from "../engine/account-service";
import { readSyncFacts } from "../plans/facts";

/**
 * What the PAGE reads of one database's cache, outside every controller (WEB-13b revision 8, review 8 R7b; design assessment C3): for
 * what outlives the protected tree (a kept import session). It reads through the account SERVICE in hand, which belongs to the page's
 * runtime: a production page's runtime is composed by its leader and never disposed while the page lives (`PageDataHost.runtime`), so a
 * remount of the protected tree disposes the controller but not this service, and the observation goes on with no controller mounted.
 * No Dexie, no engine, no database and no runtime of its own; another incarnation is never read. It ends with the service (an identity
 * change, a closure, a deletion), and what it read then stands no more: what follows is the controllers' to publish
 * (`cache-lifetime.ts`) and a fresh read's to tell.
 *
 *  - `opening`: the invalidation witness read by ONE read made when the observation began (null until it lands, and for good when it
 *    failed). IndexedDB runs a read after every write created before it and before every write created after it, so it is what the
 *    database said at that moment, whenever it is delivered: an invalidation committed after the observation began is never in it.
 *  - `invalidations`, `invalidated`: the live reading (null and false until one lands): the witness, and whether the cache is KNOWN to be
 *    invalid now (its status, or an admitted invalidation not written yet: its durable streak). A reading missed is told by the witness.
 */
export interface CacheObservation {
  readonly opening: number | null;
  readonly invalidations: number | null;
  readonly invalidated: boolean;
}

export interface CacheObserver {
  get(): CacheObservation;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export type CacheService = Pick<
  AccountService,
  "store" | "incarnationId" | "ended" | "onEnd"
>;

/** The witness as ONE read made now says (null: the read failed, or the database has no singleton): a resume's fresh authority. */
export async function readInvalidations(
  service: CacheService,
): Promise<number | null> {
  try {
    const facts = await service.store.run(readSyncFacts, {
      incarnationId: service.incarnationId,
    });
    return facts?.invalidations ?? null;
  } catch {
    return null;
  }
}

export function observeCache(service: CacheService): CacheObserver {
  let value: CacheObservation = {
    opening: null,
    invalidations: null,
    invalidated: false,
  };
  const listeners = new Set<() => void>();
  let over = false;
  const set = (patch: Partial<CacheObservation>): void => {
    if (over) return;
    value = { ...value, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const offs: Array<() => void> = [];
  const end = (): void => {
    // What an ended service said no longer stands for its database: nothing is known from here any more.
    set({ invalidations: null, invalidated: false });
    over = true;
    for (const off of offs.splice(0)) off();
  };
  if (!service.ended) {
    void readInvalidations(service).then((opening) => set({ opening }));
    const source = service.store.watch(readSyncFacts, {
      incarnationId: service.incarnationId,
    });
    const read = (): void => {
      const now = source.get();
      if (now.status === "ready" && now.value !== null)
        set({
          invalidations: now.value.invalidations,
          invalidated:
            now.value.cacheStatus === "invalid" || now.value.invalidating,
        });
    };
    offs.push(source.subscribe(read), service.onEnd(end));
    read();
  }
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      end();
      listeners.clear();
    },
  };
}

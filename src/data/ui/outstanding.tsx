import { useMemo } from "react";
import type {
  DraftRow,
  DraftWithCommand,
  ResourceId,
  ResourceKind,
} from "../model/types";
import type { FormCopyCursor } from "../plans/form-copies";
import type { ListedResource } from "../plans/outbox";
import {
  type CachePosition,
  type ChildPage,
  type ChildPageInput,
  type FormCopiesUnder,
  type Inventory,
  type InventoryInput,
  type OutstandingByKindPage,
  type OutstandingCreatesPage,
  type OutstandingCursor,
  type OutstandingForResource,
  type OutstandingPage,
  readCachePosition,
  readChildPage,
  readFormCopiesUnder,
  readInventory,
  readOutstanding,
  readOutstandingByKind,
  readOutstandingCreates,
  readResourcesById,
} from "../plans/outstanding-reads";
import {
  type DraftHeadersPage,
  readDraftHeaders,
} from "../plans/pending-reads";
import type { Loadable, Watchable } from "../store/port";
import { useWatch } from "./react";

/**
 * WEB-10a's live reads, in a module of their own: only the (lazy) task screens import it, so the plans stay out of every initial bundle.
 */
/** A stable dependency key for a list of ids (the order a caller gives does not matter: the reads answer by id). */
const idsKey = (ids: readonly string[]): string =>
  [...new Set(ids)].sort().join("\u0000");

/**
 * The drafts naming each of `ids` (at most 100) that the cache does not show yet, with their bodies, and the ones that need a decision
 * (headers): what a slice layers over a cached row to show saved, unsent work (`readOutstanding`). Live: it follows the queue.
 */
export function useOutstanding(
  ids: readonly ResourceId[],
): Loadable<OutstandingPage> {
  const key = idsKey(ids);
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readOutstanding, {
            incarnationId: service.incarnationId,
            ids: key === "" ? [] : key.split("\u0000"),
          })
        : null;
    },
    [key],
  );
}

/**
 * This device's unsettled drafts of one kind, oldest first, a window (100) at a time, as HEADERS only (WEB-13b, `readDraftHeaders`): for a
 * list of drafts whose bodies may be large (an import carries up to 1 MiB). Live: it follows the queue.
 */
export function useDraftHeaders(
  kind: string,
  after?: number | null,
): Loadable<DraftHeadersPage> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readDraftHeaders, {
            incarnationId: service.incarnationId,
            kind,
            ...(after === undefined || after === null ? {} : { after }),
          })
        : null;
    },
    [kind, after],
  );
}

/** The outstanding drafts of some kinds (a slice's commands, creates included), oldest first, one window at a time, and those needing a decision. */
export function useOutstandingByKind(
  kinds: readonly string[],
  after?: number | null,
): Loadable<OutstandingByKindPage> {
  const key = idsKey(kinds);
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readOutstandingByKind, {
            incarnationId: service.incarnationId,
            kinds: key === "" ? [] : key.split("\u0000"),
            ...(after === undefined || after === null ? {} : { after }),
          })
        : null;
    },
    [key, after],
  );
}

/**
 * A live read that FOLLOWS ITS CURSORS (R4, revision 1): page 0 is watched, and each ready page whose `nextOf` is not null opens a watch of
 * the next one, until a page says it is the last. Every page is its own bounded read and stays live (a change anywhere re-evaluates the
 * pages it touches). The value is ready only when EVERY page up to the last is ready, so a consumer never composes from a silently cut
 * overlay: while a re-evaluated chain is still loading it keeps the last complete value (as any live read shows its previous answer
 * until the new one arrives), and before the first complete chain it is `loading`. A failed page makes the whole value unavailable.
 * A cursor that does not advance (one already in the chain) is an error, never a loop.
 */
export function chainWatch<P, C>(
  open: (cursor: C | null) => Watchable<P>,
  nextOf: (page: P) => C | null,
  keyOf: (cursor: C) => string,
): Watchable<readonly P[]> {
  interface Link {
    key: string;
    watch: Watchable<P>;
    off: (() => void) | null;
  }
  let links: Link[] = [];
  let state: Loadable<readonly P[]> = { status: "loading" };
  let complete: readonly P[] | null = null;
  const listeners = new Set<() => void>();
  let evaluating = false;
  let again = false;
  const same = (a: Loadable<readonly P[]>, b: Loadable<readonly P[]>) => {
    if (a.status === "ready" && b.status === "ready")
      return (
        a.value.length === b.value.length &&
        a.value.every((page, i) => page === b.value[i])
      );
    if (a.status === "unavailable" && b.status === "unavailable")
      return a.reason === b.reason;
    return a.status === b.status;
  };
  const publish = (next: Loadable<readonly P[]>): void => {
    if (same(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const cut = (from: number): void => {
    for (const link of links.slice(from)) link.off?.();
    links = links.slice(0, from);
  };
  const add = (cursor: C | null, key: string): void => {
    const link: Link = { key, watch: open(cursor), off: null };
    links.push(link);
    link.off = link.watch.subscribe(evaluate);
  };
  function evaluate(): void {
    if (evaluating) {
      again = true;
      return;
    }
    evaluating = true;
    try {
      do {
        again = false;
        step();
      } while (again && links.length > 0);
    } finally {
      evaluating = false;
    }
  }
  function step(): void {
    const pages: P[] = [];
    for (let i = 0; i < links.length; i += 1) {
      const current = (links[i] as Link).watch.get();
      if (current.status === "unavailable") {
        cut(i + 1);
        publish(current);
        return;
      }
      if (current.status === "loading") {
        cut(i + 1);
        publish(
          complete === null
            ? { status: "loading" }
            : { status: "ready", value: complete },
        );
        return;
      }
      pages.push(current.value);
      const next = nextOf(current.value);
      if (next === null) {
        cut(i + 1);
        complete = pages;
        publish({ status: "ready", value: pages });
        return;
      }
      const key = keyOf(next);
      if (links[i + 1]?.key === key) continue;
      if (links.slice(0, i + 1).some((link) => link.key === key)) {
        cut(i + 1);
        publish({ status: "unavailable", reason: "error" });
        return;
      }
      cut(i + 1);
      add(next, key);
      // `add` may have re-entered `evaluate` (a watch that answers at once): this walk goes on with the new link either way.
    }
  }
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        add(null, "");
        evaluate();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cut(0);
          complete = null;
          state = { status: "loading" };
        }
      };
    },
  };
}

/** Every page of `readOutstandingByKind` merged: the asked kinds' outstanding drafts and those needing a decision, oldest first. */
export function useAllOutstandingByKind(
  kinds: readonly string[],
): Loadable<{ drafts: DraftWithCommand[]; attention: DraftRow[] }> {
  const key = idsKey(kinds);
  const pages = useWatch(
    (env) => {
      const service = env.service();
      if (!service) return null;
      const asked = key === "" ? [] : key.split("\u0000");
      return chainWatch<OutstandingByKindPage, number>(
        (after) =>
          service.store.watch(readOutstandingByKind, {
            incarnationId: service.incarnationId,
            kinds: asked,
            ...(after === null ? {} : { after }),
          }),
        (page) => page.next,
        (after) => String(after),
      );
    },
    [key],
  );
  return useMemo(
    () =>
      pages.status !== "ready"
        ? pages
        : {
            status: "ready",
            value: {
              drafts: pages.value.flatMap((page) => page.drafts),
              attention: pages.value.flatMap((page) => page.attention),
            },
          },
    [pages],
  );
}

/** Every page of `readOutstanding` for `ids` merged by resource: what a slice layers over the rows it shows, whatever its size. */
export function useAllOutstanding(
  ids: readonly ResourceId[],
): Loadable<Record<ResourceId, OutstandingForResource>> {
  const key = idsKey(ids);
  const pages = useWatch(
    (env) => {
      const service = env.service();
      if (!service) return null;
      const asked = key === "" ? [] : key.split("\u0000");
      return chainWatch<OutstandingPage, OutstandingCursor>(
        (after) =>
          service.store.watch(readOutstanding, {
            incarnationId: service.incarnationId,
            ids: asked,
            ...(after === null ? {} : { after }),
          }),
        (page) => page.next,
        (after) => `${after.id}\u0000${after.after}`,
      );
    },
    [key],
  );
  return useMemo(() => {
    if (pages.status !== "ready") return pages;
    const byId: Record<ResourceId, OutstandingForResource> = {};
    for (const page of pages.value)
      for (const [id, entry] of Object.entries(page.byId)) {
        const known = byId[id];
        byId[id] = known
          ? {
              drafts: [...known.drafts, ...entry.drafts],
              attention: [...known.attention, ...entry.attention],
            }
          : entry;
      }
    return { status: "ready", value: byId };
  }, [pages]);
}

/** Cached resources by id (at most 100), each with its overlay applied; `null` for an id the cache does not hold. */
export function useCachedResources(
  ids: readonly ResourceId[],
): Loadable<Record<ResourceId, ListedResource | null>> {
  const key = idsKey(ids);
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readResourcesById, {
            incarnationId: service.incarnationId,
            ids: key === "" ? [] : key.split("\u0000"),
          })
        : null;
    },
    [key],
  );
}

/** Where the cache stands (page sequence, applied revision, last sync): changes when a sync page is committed. */
export function useCachePosition(): Loadable<CachePosition | null> {
  return useWatch((env) => {
    const service = env.service();
    return service
      ? service.store.watch(readCachePosition, {
          incarnationId: service.incarnationId,
        })
      : null;
  }, []);
}

// Both slices share the same single-draft hook, kept separate from these larger read plans.
export { useDraftWithCommand } from "./draft-body";

/**
 * WEB-11a's live read of outstanding work, in a module of its own: only the (lazy) people screens import it, so the plan stays out of every
 * initial bundle.
 */

/**
 * One window of this device's OUTSTANDING saves of the command kinds asked for, with their bodies (`readOutstandingCreates`): the
 * queued, in-flight and capacity-blocked drafts, and the acknowledged ones whose change the cache has not published yet, oldest first,
 * at most 100. Pass the page's `next` back as `after` to read the following window. A screen uses it to show what the cache cannot yet
 * (a resource created on this device, a change not yet sent); it never creates a database.
 */
export function useOutstandingCreates(
  kinds: readonly string[],
  after?: number | null,
  witness?: { id: ResourceId; kind: ResourceKind },
): Loadable<OutstandingCreatesPage> {
  const key = kinds.join("\u0000");
  const witnessId = witness?.id;
  const witnessKind = witness?.kind;
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readOutstandingCreates, {
            incarnationId: service.incarnationId,
            kinds: key === "" ? [] : key.split("\u0000"),
            ...(typeof after === "number" ? { after } : {}),
            ...(witnessId === undefined || witnessKind === undefined
              ? {}
              : { witness: { id: witnessId, kind: witnessKind } }),
          })
        : null;
    },
    [key, after, witnessId, witnessKind],
  );
}

/**
 * One page of `kind` (under `parentId`) with the parents of its rows, and on request the drafts over them, read in ONE transaction
 * (`readChildPage`, WEB-11a review 16): rows whose parent the cache does not hold as `parentKind` are not answered. A new parent, page or
 * kind is a new read that starts `loading`.
 */
export function useChildPage(
  options: Omit<ChildPageInput, "incarnationId">,
): Loadable<ChildPage> {
  const { kind, parentKind, parentId, after } = options;
  const kinds = options.kinds?.join("\u0000");
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readChildPage, {
            incarnationId: service.incarnationId,
            kind,
            parentKind,
            ...(parentId === undefined ? {} : { parentId }),
            after: after ?? null,
            ...(kinds === undefined
              ? {}
              : { kinds: kinds === "" ? [] : kinds.split("\u0000") }),
          })
        : null;
    },
    [kind, parentKind, parentId, after, kinds],
  );
}

/** A page of form copies with whether the cache held `witness` in the same read (`readFormCopiesUnder`, WEB-11a review 16). */
export function useFormCopiesUnder(
  prefix: string,
  after: FormCopyCursor | null,
  witness: { id: ResourceId; kind: ResourceKind },
): Loadable<FormCopiesUnder> {
  const { id, kind } = witness;
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readFormCopiesUnder, {
            incarnationId: service.incarnationId,
            prefix,
            after,
            witness: { id, kind },
          })
        : null;
    },
    [prefix, after, id, kind],
  );
}

/**
 * The cache and this device's outstanding saves of `kinds` read in ONE transaction (`readInventory`): what a screen asks, after its
 * separate reads, before it says something is NOT there. `query` null reads nothing (loading).
 */
export function useInventory(
  query: Omit<InventoryInput, "incarnationId"> | null,
): Loadable<Inventory> {
  const key = query === null ? null : JSON.stringify(query);
  return useWatch(
    (env) => {
      const service = env.service();
      return service && key !== null
        ? service.store.watch(readInventory, {
            incarnationId: service.incarnationId,
            ...(JSON.parse(key) as Omit<InventoryInput, "incarnationId">),
          })
        : null;
    },
    [key],
  );
}

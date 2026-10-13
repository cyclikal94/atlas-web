import { useMemo } from "react";
import type { DraftRow, DraftWithCommand, ResourceId } from "../model/types";
import type { ListedResource } from "../plans/outbox";
import {
  type CachePosition,
  type OutstandingByKindPage,
  type OutstandingCursor,
  type OutstandingForResource,
  type OutstandingPage,
  readCachePosition,
  readOutstanding,
  readOutstandingByKind,
  readResourcesById,
} from "../plans/outstanding-reads";
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

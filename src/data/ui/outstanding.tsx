import type { ResourceId } from "../model/types";
import type { ListedResource } from "../plans/outbox";
import {
  type CachePosition,
  type OutstandingByKindPage,
  type OutstandingPage,
  readCachePosition,
  readOutstanding,
  readOutstandingByKind,
  readResourcesById,
} from "../plans/outstanding-reads";
import type { Loadable } from "../store/port";
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

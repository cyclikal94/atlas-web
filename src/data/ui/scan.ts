import type { ResourceId, ResourceKind } from "../model/types";
import { type ListedResource, readResourceList } from "../plans/outbox";
import {
  readCachePosition,
  readResourcesById,
} from "../plans/outstanding-reads";
import type { DataEnv } from "./env";

/**
 * Walks EVERY cached resource of one kind (optionally under one parent), a window at a time (WEB-10a, D-10a-2): for a view that must look at
 * the whole population to decide what to show (the offline Today view keeps the occurrences of one day, which no index answers). Each window
 * is ONE read transaction of `readResourceList` (at most 100 rows with their overlays), in primary-key order from the last row of the
 * previous one, and a macrotask is yielded between windows so a long walk never holds the page. At most one window's rows are held here.
 *
 * It stops, and says why: `complete` (every row was visited), `aborted` (the signal fired, or `visit` returned `"stop"`), or `closed` (there
 * is no open database, or the displayed account's database changed under the walk: what was visited belongs to the one before).
 */
export type ScanEnd = "complete" | "aborted" | "closed";

export async function scanResources(
  env: Pick<DataEnv, "service">,
  options: { kind: ResourceKind; parentId?: ResourceId; window?: number },
  visit: (rows: readonly ListedResource[]) => undefined | "stop",
  signal: AbortSignal,
): Promise<ScanEnd> {
  const service = env.service();
  if (service === null) return "closed";
  let after: ResourceId | null = null;
  for (;;) {
    if (signal.aborted) return "aborted";
    if (env.service() !== service) return "closed";
    let page: Awaited<ReturnType<typeof readOnce>>;
    try {
      page = await readOnce(service, options, after);
    } catch {
      // A failed read is a database that cannot be walked now (closed, latched): nothing visited so far is complete.
      return signal.aborted ? "aborted" : "closed";
    }
    if (signal.aborted) return "aborted";
    if (env.service() !== service) return "closed";
    if (visit(page.rows) === "stop") return "aborted";
    if (page.next === null) return "complete";
    after = page.next;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function readOnce(
  service: NonNullable<ReturnType<DataEnv["service"]>>,
  options: { kind: ResourceKind; parentId?: ResourceId; window?: number },
  after: ResourceId | null,
) {
  return service.store.run(readResourceList, {
    incarnationId: service.incarnationId,
    kind: options.kind,
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    ...(after === null ? {} : { after }),
    ...(options.window === undefined ? {} : { limit: options.window }),
  });
}

/**
 * Cached resources by id, with their overlays, read NOW (not live): for a walk that needs the rows related to what it found (WEB-10a's
 * offline day: each window's occurrences, then their tasks and my progress). Read 100 ids per transaction. `null` when there is no open
 * database, or the displayed account's database changed while reading.
 */
export async function readResourcesNow(
  env: Pick<DataEnv, "service">,
  ids: readonly ResourceId[],
): Promise<Map<ResourceId, ListedResource> | null> {
  const service = env.service();
  if (service === null) return null;
  const out = new Map<ResourceId, ListedResource>();
  const unique = [...new Set(ids)];
  for (let at = 0; at < unique.length; at += 100) {
    let page: Record<ResourceId, ListedResource | null>;
    try {
      page = await service.store.run(readResourcesById, {
        incarnationId: service.incarnationId,
        ids: unique.slice(at, at + 100),
      });
    } catch {
      return null;
    }
    if (env.service() !== service) return null;
    for (const [id, row] of Object.entries(page))
      if (row !== null) out.set(id, row);
  }
  return out;
}

/**
 * The cache's CONTENT revision read NOW from the durable sync state (`applied_revision`, 0 before any batch; WEB-10a revision 2, C2): a view
 * that composes from several separate reads reads it before and after them, and discards what it read when content was committed in between
 * (a hint or a live query may arrive after the reads). Not `page_seq`: an empty delta page moves `page_seq` (and the cursor) without changing
 * any row, and a view that re-read the server on every such page woke the engine with its own request and looped. `null` when the database
 * has no sync state yet; `"closed"` when there is no open database or the read failed.
 */
export async function readCacheRevisionNow(
  env: Pick<DataEnv, "service">,
): Promise<number | null | "closed"> {
  const service = env.service();
  if (service === null) return "closed";
  try {
    const position = await service.store.run(readCachePosition, {
      incarnationId: service.incarnationId,
    });
    if (env.service() !== service) return "closed";
    return position === null ? null : (position.appliedRevision ?? 0);
  } catch {
    return "closed";
  }
}

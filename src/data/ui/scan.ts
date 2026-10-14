import type {
  DraftRow,
  DraftWithCommand,
  ResourceId,
  ResourceKind,
} from "../model/types";
import { type ListedResource, readResourceList } from "../plans/outbox";
import {
  type LocalBasis,
  type OutstandingByKindPage,
  type OutstandingCursor,
  type OutstandingForResource,
  type OutstandingPage,
  readCachePosition,
  readLocalBasis,
  readOutstanding,
  readOutstandingByKind,
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

/**
 * A composition read from several transactions, certified (WEB-10a revision 3, design assessment C3): `complete` only when the local basis
 * (`readLocalBasis`: incarnation, composition generation, cache status, recovery and content generations) read BEFORE and AFTER every
 * stage is the same, which proves that nothing the stages read was written between them, in this page or another (`model/composition.ts`).
 * Otherwise it says why there is no composition, and never turns a failure into an empty one:
 * - `unstable`: every one of the bounded attempts spanned a commit (the queue or the cache kept changing). Ask again later.
 * - `failed`: a read failed (the store refused it, or a stage could not be read whole). Unknown is not empty.
 * - `closed`: there is no open database, or the displayed account's database changed under the read.
 * - `aborted`: the caller's signal fired.
 */
export type LocalRead<T> =
  | { kind: "complete"; value: T; basis: LocalBasis }
  | { kind: "unstable" | "failed" | "closed" | "aborted" };

/** What one stage of a composition read: its value, or why there is none. */
export type Stage<T> =
  | { ok: true; value: T }
  | { ok: false; why: "failed" | "closed" | "aborted" };

const sameBasis = (a: LocalBasis, b: LocalBasis): boolean =>
  a.incarnationId === b.incarnationId &&
  a.composition === b.composition &&
  a.cacheStatus === b.cacheStatus &&
  a.recoveryGeneration === b.recoveryGeneration &&
  a.appliedRevision === b.appliedRevision;

/** The local basis read NOW: `failed` when the read failed or the singleton is missing, `closed` when there is no open database. */
export async function readLocalBasisNow(
  env: Pick<DataEnv, "service">,
): Promise<{ kind: "ok"; basis: LocalBasis } | { kind: "failed" | "closed" }> {
  const service = env.service();
  if (service === null) return { kind: "closed" };
  try {
    const basis = await service.store.run(readLocalBasis, {
      incarnationId: service.incarnationId,
    });
    if (env.service() !== service) return { kind: "closed" };
    return basis === null ? { kind: "failed" } : { kind: "ok", basis };
  } catch {
    return { kind: env.service() === service ? "failed" : "closed" };
  }
}

export async function readCoherently<T>(
  env: Pick<DataEnv, "service">,
  read: () => Promise<Stage<T>>,
  options: { attempts?: number; signal?: AbortSignal } = {},
): Promise<LocalRead<T>> {
  const service = env.service();
  if (service === null) return { kind: "closed" };
  for (let attempt = 0; attempt < (options.attempts ?? 3); attempt += 1) {
    if (options.signal?.aborted) return { kind: "aborted" };
    const before = await readLocalBasisNow(env);
    if (before.kind !== "ok") return before;
    const stage = await read();
    if (!stage.ok) return { kind: stage.why };
    const after = await readLocalBasisNow(env);
    if (after.kind !== "ok") return after;
    if (env.service() !== service) return { kind: "closed" };
    if (options.signal?.aborted) return { kind: "aborted" };
    if (sameBasis(before.basis, after.basis))
      return { kind: "complete", value: stage.value, basis: after.basis };
  }
  return { kind: "unstable" };
}

/** Why a read that came back with nothing has nothing: the page's database changed (`closed`), or the read failed. */
const unread = (
  env: Pick<DataEnv, "service">,
  service: ReturnType<DataEnv["service"]>,
): Stage<never> => ({
  ok: false,
  why: env.service() === service ? "failed" : "closed",
});

/**
 * Every page of `readOutstandingByKind` read NOW, merged (a stage of a certified composition: its pages are separate transactions, which
 * the certificate joins). A failed page, or a continuation that does not move forward, fails the whole read: part of the queue is never
 * answered as all of it.
 */
export async function readAllOutstandingByKindNow(
  env: Pick<DataEnv, "service">,
  kinds: readonly string[],
): Promise<Stage<{ drafts: DraftWithCommand[]; attention: DraftRow[] }>> {
  const service = env.service();
  if (service === null) return { ok: false, why: "closed" };
  const drafts: DraftWithCommand[] = [];
  const attention: DraftRow[] = [];
  let after: number | null = null;
  for (;;) {
    let page: OutstandingByKindPage;
    try {
      page = await service.store.run(readOutstandingByKind, {
        incarnationId: service.incarnationId,
        kinds,
        ...(after === null ? {} : { after }),
      });
    } catch {
      return unread(env, service);
    }
    if (env.service() !== service) return { ok: false, why: "closed" };
    drafts.push(...page.drafts);
    attention.push(...page.attention);
    const next = page.next;
    if (next === null) return { ok: true, value: { drafts, attention } };
    if (after !== null && next <= after) return { ok: false, why: "failed" };
    after = next;
  }
}

/** Every page of `readOutstanding` for `ids` read NOW, merged by resource (a stage of a certified composition, as above). */
export async function readAllOutstandingNow(
  env: Pick<DataEnv, "service">,
  ids: readonly ResourceId[],
): Promise<Stage<Record<ResourceId, OutstandingForResource>>> {
  const service = env.service();
  if (service === null) return { ok: false, why: "closed" };
  const byId: Record<ResourceId, OutstandingForResource> = {};
  let after: OutstandingCursor | null = null;
  const seen = new Set<string>();
  for (;;) {
    let page: OutstandingPage;
    try {
      page = await service.store.run(readOutstanding, {
        incarnationId: service.incarnationId,
        ids,
        ...(after === null ? {} : { after }),
      });
    } catch {
      return unread(env, service);
    }
    if (env.service() !== service) return { ok: false, why: "closed" };
    for (const [id, entry] of Object.entries(page.byId)) {
      const known = byId[id];
      byId[id] = known
        ? {
            drafts: [...known.drafts, ...entry.drafts],
            attention: [...known.attention, ...entry.attention],
          }
        : entry;
    }
    const next = page.next;
    if (next === null) return { ok: true, value: byId };
    const key = `${next.id}\u0000${next.after}`;
    if (seen.has(key)) return { ok: false, why: "failed" };
    seen.add(key);
    after = next;
  }
}

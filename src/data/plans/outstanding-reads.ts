import { DATA_CONFIG } from "../model/config";
import { applyOverlay, type Overlay } from "../model/overlay";
import type {
  CacheRow,
  DraftRow,
  DraftStatus,
  DraftWithCommand,
  IsoInstant,
  LocalId,
  ResourceId,
} from "../model/types";
import { type Reader, range } from "../store/port";
import { bulkGetWindowed, WINDOW } from "./bounded-reads";
import { readPlan } from "./builders";
import type { ListedResource } from "./outbox";
import { readOverlays } from "./overlay-windows";

/**
 * Reads of the work this device has saved but the cache does not show yet (WEB-10a, §3.1 of its plan). They are READS, never writers,
 * and know nothing of what a command means: which drafts name a resource, with their bodies, so a feature slice can layer its own pending
 * effects over the cached row; which creates of some kinds are still outstanding; a page of resources by id; and where the cache stands.
 *
 * Why they are needed: a QUEUED draft has no `pending_effects` row (the claim writes them), so `readResourceList` and `readMerged` show
 * nothing of a draft until it is sent, and a create the cache does not hold is invisible to every list. Every read here is bounded:
 * at most `queueWorkingSet` (100) ids per call, at most that many bodies, every population walked a window at a time. A read that cannot
 * answer everything in one call says where to resume (R4, revision 1): nothing saved is ever dropped from an answer without a cursor.
 */

/** The statuses whose effect the cache cannot show yet, whatever happens next (an acknowledged draft is added while its effect stands). */
const OUTSTANDING_STATUSES: readonly DraftStatus[] = [
  "queued",
  "in_flight",
  "blocked",
];
/** The statuses a person must decide about: headers only. */
const ATTENTION_STATUSES: readonly DraftStatus[] = [
  "version_conflict",
  "operation_conflict",
  "rejected",
];

export interface OutstandingForResource {
  /**
   * The drafts naming the resource (`index_targets`) whose effect the cache does not show yet, with their bodies, oldest first by
   * `created_seq`: `queued`, `in_flight` and `blocked` (a defaults review included), and `acknowledged` while its `pending_effects` row
   * for this resource still stands (the receipt has come, the sync page that carries the effect has not).
   */
  drafts: DraftWithCommand[];
  /** `version_conflict`, `operation_conflict` and `rejected` drafts naming it: headers only, oldest first. */
  attention: DraftRow[];
}

/** Where `readOutstanding` resumes: the resource (in the order of the request's ids) and the last `created_seq` already answered for it. */
export interface OutstandingCursor {
  id: ResourceId;
  after: number;
}

export interface OutstandingPage {
  /**
   * The answered resources. A resource whose entries did not fit in one call is answered from its OLDEST entries and continued by `next`
   * (its later entries arrive under the same id in the next page): a reader of every page merges them.
   */
  byId: Record<ResourceId, OutstandingForResource>;
  /**
   * Where the next call resumes, or null when every entry of every id asked for has been answered (R4, revision 1: a resource with more
   * than a window of saved work, or a request of more ids than one call reads, is never cut silently). Ask again with it as `after`.
   */
  next: OutstandingCursor | null;
}

const isOutstanding = (draft: DraftRow): boolean =>
  OUTSTANDING_STATUSES.includes(draft.status);
const isAttention = (draft: DraftRow): boolean =>
  ATTENTION_STATUSES.includes(draft.status);
const bySeq = (a: DraftRow, b: DraftRow): number =>
  a.created_seq - b.created_seq;

/** Inserts `draft` into `kept` (oldest first), keeping at most `limit`: the oldest `limit` of a population read in any order. */
function keepOldest(kept: DraftRow[], draft: DraftRow, limit: number): void {
  let at = kept.length;
  while (at > 0 && (kept[at - 1] as DraftRow).created_seq > draft.created_seq)
    at -= 1;
  if (at >= limit) return;
  kept.splice(at, 0, draft);
  if (kept.length > limit) kept.pop();
}

/** Whether an acknowledged draft's effect on `resourceId` still stands (its `pending_effects` row is there). */
async function effectStands(
  reader: Reader,
  resourceId: ResourceId | undefined,
  draft: DraftRow,
): Promise<boolean> {
  return (
    resourceId !== undefined &&
    (await reader.get("pending_effects", [resourceId, draft.local_id])) !==
      undefined
  );
}

/**
 * The oldest `limit` entries naming `id` (outstanding drafts, acknowledged ones whose effect on it stands, and attention headers) with a
 * `created_seq` above `after`. The index of a target lists its drafts in primary-key order, not queue order, so the whole index entry is
 * walked a window at a time (bounded by the count taken first) and only the oldest `limit` are held.
 */
async function oldestNaming(
  reader: Reader,
  id: ResourceId,
  after: number,
  limit: number,
): Promise<DraftRow[]> {
  const kept: DraftRow[] = [];
  const key = range.only(id);
  const windows = Math.ceil(
    (await reader.count("drafts", "index_targets", key)) / WINDOW,
  );
  for (let at = 0; at < windows; at += 1) {
    const rows = await reader.byIndex(
      "drafts",
      "index_targets",
      key,
      WINDOW,
      at * WINDOW,
    );
    for (const draft of rows) {
      if (draft.created_seq <= after) continue;
      const full = kept.length >= limit;
      // Not older than anything held: it cannot be kept, so its effect need not be read.
      if (full && (kept[limit - 1] as DraftRow).created_seq < draft.created_seq)
        continue;
      if (
        isOutstanding(draft) ||
        isAttention(draft) ||
        (draft.status === "acknowledged" &&
          (await effectStands(reader, id, draft)))
      )
        keepOldest(kept, draft, limit);
    }
    if (rows.length < WINDOW) break;
  }
  return kept;
}

export const readOutstanding = readPlan<
  {
    incarnationId: string;
    ids: readonly ResourceId[];
    after?: OutstandingCursor | null;
  },
  {
    answered: Array<{
      id: ResourceId;
      drafts: DraftRow[];
      attention: DraftRow[];
    }>;
    next: OutstandingCursor | null;
    bodies: Map<LocalId, DraftWithCommand["command"]>;
  },
  OutstandingPage
>({
  name: "data.readOutstanding",
  scope: ["drafts", "draft_commands", "pending_effects"],
  read: async (reader, input) => {
    const ids = [...new Set(input.ids)];
    // Resumes at the cursor's resource (an id the request no longer names starts again from the first).
    const from =
      input.after === undefined || input.after === null
        ? 0
        : Math.max(0, ids.indexOf(input.after.id));
    const answered: Array<{
      id: ResourceId;
      drafts: DraftRow[];
      attention: DraftRow[];
    }> = [];
    const wanted = new Set<LocalId>();
    let used = 0;
    let next: OutstandingCursor | null = null;
    // At most one window of entries (and so of bodies) and at most `queueWorkingSet` ids per call; the rest is the next call's.
    for (let at = from; at < ids.length; at += 1) {
      const id = ids[at] as ResourceId;
      const after =
        at === from && input.after?.id === id ? input.after.after : 0;
      if (at - from >= DATA_CONFIG.queueWorkingSet || used >= WINDOW) {
        next = { id, after };
        break;
      }
      const room = WINDOW - used;
      const entries = await oldestNaming(reader, id, after, room + 1);
      const shown = entries.slice(0, room);
      if (entries.length > room)
        next = { id, after: (shown[shown.length - 1] as DraftRow).created_seq };
      used += shown.length;
      const drafts = shown.filter((d) => !isAttention(d));
      for (const draft of drafts) wanted.add(draft.local_id);
      answered.push({ id, drafts, attention: shown.filter(isAttention) });
      if (next !== null) break;
    }
    const keys = [...wanted];
    const rows = await bulkGetWindowed(reader, "draft_commands", keys);
    const bodies = new Map<LocalId, DraftWithCommand["command"]>();
    rows.forEach((row, index) => {
      if (row) bodies.set(keys[index] as LocalId, row.command);
    });
    return { answered, next, bodies };
  },
  decide: ({ reads }) => {
    const byId: Record<ResourceId, OutstandingForResource> = {};
    for (const entry of reads.answered)
      byId[entry.id] = {
        drafts: entry.drafts.flatMap((draft) => {
          const command = reads.bodies.get(draft.local_id);
          return command === undefined ? [] : [{ ...draft, command }];
        }),
        attention: entry.attention,
      };
    return { byId, next: reads.next };
  },
});

export interface OutstandingByKindPage {
  /** The drafts of the asked kinds in this page, oldest first, with their bodies. */
  drafts: DraftWithCommand[];
  /** The drafts of the asked kinds in this page that need a decision (`version_conflict`, `operation_conflict`, `rejected`): headers. */
  attention: DraftRow[];
  /**
   * The `created_seq` to pass as `after` for the next page, or null when every entry after the cursor has been answered. A page may hold
   * fewer entries than a window, none at all, and still have a `next`: the rows it looked at were of other kinds, or acknowledged drafts
   * whose effect is in the cache (R4, revision 1).
   */
  next: number | null;
}

/** The most windows of headers one call looks at in each status before it answers with a continuation (R4, revision 1). */
const EXAMINE_WINDOWS = 10;

/**
 * One status of `[status+created_seq]` after `after`, in queue order, keeping the drafts of `kinds` (an acknowledged one only while its
 * effect on its first target stands) until `limit` are kept, the status ends or `EXAMINE_WINDOWS` windows were looked at. `reach` is the
 * `created_seq` up to which EVERY row of the status was looked at (infinite when it ended), so a page never answers past what it read.
 */
async function walkStatus(
  reader: Reader,
  status: DraftStatus,
  after: number,
  kinds: ReadonlySet<string>,
  limit: number,
): Promise<{ kept: DraftRow[]; reach: number }> {
  const key = range.between(
    [status, after],
    [status, Number.MAX_SAFE_INTEGER],
    { lowerOpen: true },
  );
  const total = await reader.count("drafts", "[status+created_seq]", key);
  const windows = Math.min(Math.ceil(total / WINDOW), EXAMINE_WINDOWS);
  const kept: DraftRow[] = [];
  let last: DraftRow | undefined;
  for (let at = 0; at < windows; at += 1) {
    const rows = await reader.byIndex(
      "drafts",
      "[status+created_seq]",
      key,
      WINDOW,
      at * WINDOW,
    );
    for (const draft of rows) {
      last = draft;
      if (!kinds.has(draft.kind)) continue;
      if (
        draft.status === "acknowledged" &&
        !(await effectStands(reader, draft.target_resource_ids[0], draft))
      )
        continue;
      kept.push(draft);
      if (kept.length >= limit) return { kept, reach: draft.created_seq };
    }
    if (rows.length < WINDOW) return { kept, reach: Number.POSITIVE_INFINITY };
  }
  return {
    kept,
    reach:
      windows * WINDOW >= total || last === undefined
        ? Number.POSITIVE_INFINITY
        : last.created_seq,
  };
}

/**
 * The outstanding drafts of some KINDS (a feature's commands), oldest first, a page at a time: `queued`, `in_flight` and `blocked`, and
 * `acknowledged` while the effect on its first target still stands; and those that need a decision (headers). A create's resource is not
 * in the cache, so no list read shows it; and a view of many resources needs their outstanding work in one read, whatever the number of
 * resources it shows. A page holds at most one window of entries and looks at a bounded number of headers; `next` continues it.
 */
export const readOutstandingByKind = readPlan<
  { incarnationId: string; kinds: readonly string[]; after?: number | null },
  {
    headers: DraftRow[];
    attention: DraftRow[];
    next: number | null;
    bodies: DraftWithCommand[];
  },
  OutstandingByKindPage
>({
  name: "data.readOutstandingByKind",
  scope: ["drafts", "draft_commands", "pending_effects"],
  read: async (reader, input) => {
    const kinds = new Set(input.kinds);
    const after = input.after ?? 0;
    const found: DraftRow[] = [];
    let reach = Number.POSITIVE_INFINITY;
    for (const status of [
      ...OUTSTANDING_STATUSES,
      "acknowledged" as const,
      ...ATTENTION_STATUSES,
    ]) {
      const walked = await walkStatus(reader, status, after, kinds, WINDOW + 1);
      found.push(...walked.kept);
      reach = Math.min(reach, walked.reach);
    }
    // Only what every status was read up to is answered: a later entry of a status that was read further is the next page's.
    const candidates = found.filter((d) => d.created_seq <= reach).sort(bySeq);
    const page = candidates.slice(0, WINDOW);
    const next =
      candidates.length > WINDOW
        ? (page[page.length - 1] as DraftRow).created_seq
        : Number.isFinite(reach)
          ? reach
          : null;
    const headers = page.filter((d) => !isAttention(d));
    const rows = await bulkGetWindowed(
      reader,
      "draft_commands",
      headers.map((d) => d.local_id),
    );
    return {
      headers,
      attention: page.filter(isAttention),
      next,
      bodies: headers.flatMap((draft, index) => {
        const row = rows[index];
        return row ? [{ ...draft, command: row.command }] : [];
      }),
    };
  },
  decide: ({ reads }) => ({
    drafts: reads.bodies,
    attention: reads.attention,
    next: reads.next,
  }),
});

/** Cached resources by id (at most 100), each with the overlay of its admitted changes, as a list shows them; `null` where none is cached. */
export const readResourcesById = readPlan<
  { incarnationId: string; ids: readonly ResourceId[] },
  {
    ids: ResourceId[];
    rows: (CacheRow | undefined)[];
    overlays: Map<ResourceId, Overlay>;
  },
  Record<ResourceId, ListedResource | null>
>({
  name: "data.readResourcesById",
  scope: ["cache", "pending_effects"],
  read: async (reader, input) => {
    const ids = [...new Set(input.ids)].slice(0, DATA_CONFIG.queueWorkingSet);
    const rows = await reader.bulkGet("cache", ids);
    const present = ids.filter((_, index) => rows[index] !== undefined);
    return {
      ids,
      rows,
      overlays: await readOverlays(
        reader,
        present,
        DATA_CONFIG.queueWorkingSet,
      ),
    };
  },
  decide: ({ reads }) => {
    const out: Record<ResourceId, ListedResource | null> = {};
    reads.ids.forEach((id, index) => {
      const base = reads.rows[index];
      const overlay = reads.overlays.get(id);
      out[id] =
        base === undefined || overlay === undefined
          ? null
          : {
              base,
              merged: applyOverlay(base, overlay),
              pending: overlay.pending,
            };
    });
    return out;
  },
});

/** Where the cache stands: a cheap signal that a sync page was committed (re-read what was derived from it). */
export interface CachePosition {
  pageSeq: number;
  appliedRevision: number | null;
  lastSyncedAt: IsoInstant | null;
}

export const readCachePosition = readPlan<
  { incarnationId: string },
  null,
  CachePosition | null
>({
  name: "data.readCachePosition",
  scope: [],
  read: async () => null,
  decide: ({ sync }) =>
    sync === undefined
      ? null
      : {
          pageSeq: sync.page_seq,
          appliedRevision: sync.applied_revision,
          lastSyncedAt: sync.last_synced_at,
        },
});

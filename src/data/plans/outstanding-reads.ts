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
import { range } from "../store/port";
import { bulkGetWindowed, WINDOW, walkIndex } from "./bounded-reads";
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
 * at most `queueWorkingSet` (100) ids per call, at most that many bodies, every population walked a window at a time.
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

export interface OutstandingPage {
  byId: Record<ResourceId, OutstandingForResource>;
  /**
   * The first id of the request that this answer does not cover (its drafts would have taken more than one window of bodies), or null when
   * every id is answered. Ask again from it.
   */
  next: ResourceId | null;
}

const isOutstanding = (draft: DraftRow): boolean =>
  OUTSTANDING_STATUSES.includes(draft.status);
const bySeq = (a: DraftRow, b: DraftRow): number =>
  a.created_seq - b.created_seq;

export const readOutstanding = readPlan<
  { incarnationId: string; ids: readonly ResourceId[] },
  {
    answered: Array<{
      id: ResourceId;
      drafts: DraftRow[];
      attention: DraftRow[];
    }>;
    next: ResourceId | null;
    bodies: Map<LocalId, DraftWithCommand["command"]>;
  },
  OutstandingPage
>({
  name: "data.readOutstanding",
  scope: ["drafts", "draft_commands", "pending_effects"],
  read: async (reader, input) => {
    const ids = [...new Set(input.ids)].slice(0, DATA_CONFIG.queueWorkingSet);
    const answered: Array<{
      id: ResourceId;
      drafts: DraftRow[];
      attention: DraftRow[];
    }> = [];
    const wanted = new Set<LocalId>();
    let next: ResourceId | null = null;
    for (const id of ids) {
      const drafts: DraftRow[] = [];
      const attention: DraftRow[] = [];
      const acknowledged: DraftRow[] = [];
      await walkIndex(
        reader,
        "drafts",
        "index_targets",
        range.only(id),
        (d) => {
          if (isOutstanding(d)) drafts.push(d);
          else if (d.status === "acknowledged") acknowledged.push(d);
          else if (ATTENTION_STATUSES.includes(d.status)) attention.push(d);
        },
      );
      for (const draft of acknowledged)
        if (
          (await reader.get("pending_effects", [id, draft.local_id])) !==
          undefined
        )
          drafts.push(draft);
      const added = drafts.filter((d) => !wanted.has(d.local_id)).length;
      // One window of bodies per call: an id whose drafts would go over it is left for the next call (unless it is the first, whose
      // drafts are then cut to the window: one resource with more than a window of outstanding drafts is shown from its oldest).
      if (wanted.size > 0 && wanted.size + added > WINDOW) {
        next = id;
        break;
      }
      drafts.sort(bySeq);
      const kept = drafts.slice(0, WINDOW);
      for (const draft of kept) wanted.add(draft.local_id);
      answered.push({ id, drafts: kept, attention: attention.sort(bySeq) });
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
  /** At most one window of drafts of the asked kinds, oldest first, with their bodies. */
  drafts: DraftWithCommand[];
  /** The oldest window of drafts of the asked kinds that need a decision (`version_conflict`, `operation_conflict`, `rejected`): headers. */
  attention: DraftRow[];
  /** The `created_seq` to pass as `after` for the next window, or null on the last. */
  next: number | null;
}

/**
 * The outstanding drafts of some KINDS (a feature's commands), oldest first, one window at a time: `queued`, `in_flight` and `blocked`, and
 * `acknowledged` while the effect on its first target still stands; and the oldest window of those that need a decision (headers). A
 * create's resource is not in the cache, so no list read shows it; and a view of many resources needs their outstanding work in one read,
 * whatever the number of resources it shows.
 */
export const readOutstandingByKind = readPlan<
  { incarnationId: string; kinds: readonly string[]; after?: number | null },
  {
    headers: DraftRow[];
    more: boolean;
    bodies: DraftWithCommand[];
    attention: DraftRow[];
  },
  OutstandingByKindPage
>({
  name: "data.readOutstandingByKind",
  scope: ["drafts", "draft_commands", "pending_effects"],
  read: async (reader, input) => {
    const kinds = new Set(input.kinds);
    const after = input.after ?? 0;
    const found: DraftRow[] = [];
    for (const status of [...OUTSTANDING_STATUSES, "acknowledged" as const]) {
      let taken = 0;
      // Per status, in queue order from the cursor, a window at a time; only the oldest window plus one of the asked kinds is kept.
      const keyRange = range.between(
        [status, after],
        [status, Number.MAX_SAFE_INTEGER],
        { lowerOpen: true },
      );
      const rows: DraftRow[] = [];
      await walkIndex(
        reader,
        "drafts",
        "[status+created_seq]",
        keyRange,
        (d) => {
          if (taken <= WINDOW && kinds.has(d.kind)) {
            rows.push(d);
            taken += 1;
          }
        },
      );
      for (const draft of rows) {
        if (draft.status === "acknowledged") {
          const first = draft.target_resource_ids[0];
          if (
            first === undefined ||
            (await reader.get("pending_effects", [first, draft.local_id])) ===
              undefined
          )
            continue;
        }
        found.push(draft);
      }
    }
    found.sort(bySeq);
    const attention: DraftRow[] = [];
    for (const status of ATTENTION_STATUSES) {
      let taken = 0;
      await walkIndex(
        reader,
        "drafts",
        "[status+created_seq]",
        range.between([status, 0], [status, Number.MAX_SAFE_INTEGER]),
        (d) => {
          if (taken < WINDOW && kinds.has(d.kind)) {
            attention.push(d);
            taken += 1;
          }
        },
      );
    }
    attention.sort(bySeq);
    const headers = found.slice(0, WINDOW);
    const rows = await bulkGetWindowed(
      reader,
      "draft_commands",
      headers.map((d) => d.local_id),
    );
    return {
      headers,
      attention: attention.slice(0, WINDOW),
      more: found.length > WINDOW,
      bodies: headers.flatMap((draft, index) => {
        const row = rows[index];
        return row ? [{ ...draft, command: row.command }] : [];
      }),
    };
  },
  decide: ({ reads }) => ({
    drafts: reads.bodies,
    attention: reads.attention,
    next:
      reads.more && reads.headers.length > 0
        ? (reads.headers[reads.headers.length - 1] as DraftRow).created_seq
        : null,
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

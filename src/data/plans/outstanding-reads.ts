import { compositionOf } from "../model/composition";
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
  ResourceKind,
} from "../model/types";
import { type Reader, range } from "../store/port";
import { bulkGetWindowed, WINDOW } from "./bounded-reads";
import { readPlan } from "./builders";
import {
  type FormCopiesInput,
  type FormCopiesPage,
  readFormCopies,
} from "./form-copies";
import {
  type ListedResource,
  listPageSize,
  type ResourcePage,
  readResourceList,
} from "./outbox";
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
  // Distinct from the single-resource summary in pending-reads.ts (WEB-13a).
  name: "data.readOutstandingResources",
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
  /** The local composition generation (`model/composition.ts`): moves with every change of what a screen composes from. */
  composition: number;
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
          composition: compositionOf(sync),
        },
});

/**
 * The basis a composition is read on (WEB-10a revision 3): the database's incarnation, its local composition generation, the cache's
 * status and recovery generation, and its content revision. Read before and after a composition's reads, an unchanged basis proves that
 * nothing the composition reads was written between them (`model/composition.ts`); `null` when the database has no singleton.
 */
export interface LocalBasis {
  incarnationId: string;
  composition: number;
  cacheStatus: string;
  recoveryGeneration: number;
  appliedRevision: number | null;
}

export const readLocalBasis = readPlan<
  { incarnationId: string },
  null,
  LocalBasis | null
>({
  name: "data.readLocalBasis",
  scope: [],
  read: async () => null,
  decide: ({ sync }) =>
    sync === undefined
      ? null
      : {
          incarnationId: sync.incarnation_id,
          composition: compositionOf(sync),
          cacheStatus: sync.cache_status,
          recoveryGeneration: sync.recovery_generation,
          appliedRevision: sync.applied_revision,
        },
});

/**
 * This device's OUTSTANDING saves of some command kinds, with their bodies (WEB-10a/WEB-11a §3.1): what a feature screen needs to show a
 * change the person made that the cache does not show yet. The merged reads deliberately do not give it: a queued draft has no
 * `pending_effects` row until it is claimed, so `readResourceList` lists only the cache, and `readMerged` reads drafts only for an id the
 * caller already knows. A screen of NEW resources (a person created offline, a field created under them) knows no id in advance.
 *
 * "Outstanding" is a draft that is still expected to apply and that the cache may not reflect yet:
 *  - `queued` (a review block included: the person has not confirmed its audience yet), `in_flight` and `blocked` (capacity);
 *  - `acknowledged` only WHILE its own `pending_effects` row for its first primary target stands: the server receipted it and this device
 *    has not yet seen it published. Once that row is released, the cache speaks for the change, and the draft is no longer listed.
 * A conflict, a rejection and a superseded draft are not: they are decided in the queue, never shown as a change that will apply.
 *
 * A READ, never a writer: it is bounded like every outbox read (R21): it walks the `[status+created_seq]` index of each status a window
 * at a time, keeps only headers of the kinds asked for, holds at most one window (`queueWorkingSet`, 100) of them, oldest first by
 * `created_seq` (queue order), and reads the bodies of that window and no others. `next` is the `created_seq` to pass back as `after` for
 * the following window, or null on the last.
 */
export interface OutstandingCreatesInput {
  incarnationId: string;
  /** The command kinds as the header records them (`DraftRow.kind`, for example `create_person`, `put_field`). */
  kinds: readonly string[];
  /** Only drafts after this `created_seq` (a later window); omitted or null: from the oldest. */
  after?: number | null;
  /**
   * A resource whose cached row the window's OWN transaction also reads (WEB-11a review 16, R16.1): the page then says whether the cache
   * held `id` as a `kind` in the state the drafts were read from (`witnessed`). A screen that shows these drafts under a parent shows them
   * only on that evidence: a parent read by another live query may answer for an earlier or a later commit.
   */
  witness?: { id: ResourceId; kind: ResourceKind };
}

export interface OutstandingCreatesPage {
  /** At most one window of outstanding drafts of the kinds asked for, oldest first, each with its body. */
  drafts: DraftWithCommand[];
  /** The `created_seq` to pass back as `after` for the next window, or null when this is the last. */
  next: number | null;
  /** With a `witness`: whether the cache held it, as that kind, in this window's transaction. Absent without one. */
  witnessed?: boolean;
}

const LIVE: readonly DraftStatus[] = ["queued", "in_flight", "blocked"];
const FAR = Number.MAX_SAFE_INTEGER;

export const readOutstandingCreates = readPlan<
  OutstandingCreatesInput,
  OutstandingCreatesPage,
  OutstandingCreatesPage
>({
  name: "data.readOutstandingCreates",
  scope: ["drafts", "draft_commands", "pending_effects", "cache"],
  read: async (reader, input) => {
    const window = await readOutstandingWindow(reader, input);
    const witness = input.witness;
    return witness === undefined
      ? window
      : {
          ...window,
          witnessed:
            (await reader.get("cache", witness.id))?.kind === witness.kind,
        };
  },
  decide: ({ reads }) => reads,
});

/** One window of `readOutstandingCreates`, inside the caller's read transaction. */
async function readOutstandingWindow(
  reader: Reader,
  input: Omit<OutstandingCreatesInput, "incarnationId">,
): Promise<OutstandingCreatesPage> {
  {
    const kinds = new Set(input.kinds);
    const after = input.after ?? 0;
    // The oldest `WINDOW + 1` of every status together: the one more says whether another window follows.
    const keep = WINDOW + 1;
    let kept: DraftRow[] = [];
    const offer = (row: DraftRow): void => {
      kept.push(row);
      if (kept.length > keep * 2) {
        kept.sort((a, b) => a.created_seq - b.created_seq);
        kept = kept.slice(0, keep);
      }
    };
    for (const status of [...LIVE, "acknowledged"] as const) {
      // A keyset walk of ONE status after the cursor, a window of headers at a time; a status contributes at most `keep` rows, because
      // only the oldest `keep` of all of them can be shown.
      let cursor = after;
      let found = 0;
      for (;;) {
        const rows: DraftRow[] = await reader.byIndex(
          "drafts",
          "[status+created_seq]",
          range.between([status, cursor], [status, FAR], { lowerOpen: true }),
          WINDOW,
        );
        for (const row of rows) {
          if (!kinds.has(row.kind)) continue;
          if (status === "acknowledged") {
            const first = row.target_resource_ids[0];
            if (first === undefined) continue;
            const effect = await reader.get("pending_effects", [
              first,
              row.local_id,
            ]);
            if (effect === undefined) continue;
          }
          offer(row);
          found += 1;
        }
        const tail = rows[rows.length - 1];
        if (rows.length < WINDOW || tail === undefined || found >= keep) break;
        cursor = tail.created_seq;
      }
    }
    kept.sort((a, b) => a.created_seq - b.created_seq);
    const more = kept.length > WINDOW;
    const window = kept.slice(0, WINDOW);
    const bodies = await bulkGetWindowed(
      reader,
      "draft_commands",
      window.map((row) => row.local_id),
    );
    const last = window[window.length - 1];
    return {
      drafts: window.flatMap((row, index) => {
        const body = bodies[index];
        return body ? [{ ...row, command: body.command }] : [];
      }),
      next: more && last !== undefined ? last.created_seq : null,
    };
  }
}

/** The most pages and windows one `readInventory` reads: a list step's bound (20 pages) and the outstanding chain's (10 windows). */
const INVENTORY_PAGES = 20;
const INVENTORY_WINDOWS = 10;

/**
 * The cache AND this device's outstanding saves, read in ONE transaction (WEB-11a review 7's design assessment, C15.5): what a screen
 * needs before it may say that something is NOT there. The separate live reads of the cache (`readResourceList`) and of the outstanding
 * saves (`readOutstandingCreates`) are each consistent, but they are delivered separately: when one commit moves a new resource from the
 * queue to the cache (its receipt published), the read of the queue can answer first, and for that moment neither shows it. A screen
 * shows what the separate reads give, and claims an ABSENCE ("No one here yet", "No fields yet", "isn't on this device") only when this
 * read, made after them, agrees. It reads either one resource by id, or the step of a list (of `kind`, under `parentId`, from `after`)
 * up to `pages` pages of `listPage` rows with their overlays, and the outstanding saves of `kinds` up to `windows` windows: the same
 * bounds as the reads it confirms (at most 20 pages and 10 windows), and it stops at the last page and window.
 */
export interface InventoryInput {
  incarnationId: string;
  /** One resource (its cached row), instead of a step of a list. */
  id?: ResourceId;
  kind?: ResourceKind;
  parentId?: string;
  after?: ResourceId | null;
  pages?: number;
  kinds: readonly string[];
  windows?: number;
}

export interface Inventory {
  /** The resource asked for by id, as cached (null: not cached); null too for a step. */
  resource: CacheRow | null;
  /** The pages of the step read, in order, each with the cursor it was read after. */
  pages: Array<{ after: ResourceId | null; page: ResourcePage }>;
  /** The windows of outstanding saves read, in order, each with the cursor it was read after. */
  outstanding: Array<{ after: number | null; page: OutstandingCreatesPage }>;
}

export const readInventory = readPlan<InventoryInput, Inventory, Inventory>({
  name: "data.readInventory",
  scope: ["cache", "pending_effects", "drafts", "draft_commands"],
  read: async (reader, input) => {
    const resource =
      input.id === undefined
        ? null
        : ((await reader.get("cache", input.id)) ?? null);
    const pages: Inventory["pages"] = [];
    if (input.id === undefined && input.kind !== undefined) {
      const index = input.parentId === undefined ? "kind" : "parent_id";
      const key = input.parentId === undefined ? input.kind : input.parentId;
      const match =
        input.parentId === undefined ? {} : { match: { kind: input.kind } };
      const limit = listPageSize();
      let after = input.after ?? null;
      const most = Math.min(input.pages ?? INVENTORY_PAGES, INVENTORY_PAGES);
      for (let n = 0; n < most; n += 1) {
        // A page as `readResourceList` reads it, one row more to know whether another follows.
        const rows = await reader.pageByKey("cache", index, key, {
          ...(after === null ? {} : { after }),
          ...match,
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        const overlays = await readOverlays(
          reader,
          page.map((row) => row.id),
          DATA_CONFIG.queueWorkingSet,
        );
        const last = page[page.length - 1];
        const next = rows.length > limit && last !== undefined ? last.id : null;
        pages.push({
          after,
          page: {
            rows: page.map((base) => {
              const overlay = overlays.get(base.id) as Overlay;
              return {
                base,
                merged: applyOverlay(base, overlay),
                pending: overlay.pending,
              };
            }),
            next,
          },
        });
        if (next === null) break;
        after = next;
      }
    }
    const outstanding: Inventory["outstanding"] = [];
    let after: number | null = null;
    const most = Math.min(
      input.windows ?? INVENTORY_WINDOWS,
      INVENTORY_WINDOWS,
    );
    for (let n = 0; n < most; n += 1) {
      const page = await readOutstandingWindow(reader, {
        kinds: input.kinds,
        after,
      });
      outstanding.push({ after, page });
      if (page.next === null) break;
      after = page.next;
    }
    return { resource, pages, outstanding };
  },
  decide: ({ reads }) => reads,
});

// ---- reads of what is shown under a parent (WEB-11a review 16, R16.1; PPL-5) ---------------------------------------------------------
/**
 * What a screen shows under a parent (a person's fields) is read WITH that parent, in the same transaction. Two live queries are delivered
 * separately (each answers again only when its own commit reaches it), so a parent read by one and children read by another can belong to
 * two commits: an earlier parent that is still there with a child that a later commit (the same one that removed the parent) added or
 * changed. These reads never answer such a pair. They read the parent as the cache holds it; WHETHER that makes the children visible is
 * the screen's rule, said here only as "the cache holds it as `parentKind`" (a person: archival and editability do not change it).
 */

/** At most this many OUTSTANDING drafts naming a page's rows are answered in one transaction (the outstanding chain's bound: ten windows). */
const NAMING_MOST = 10 * WINDOW;

/**
 * The OUTSTANDING drafts of `kinds` that name any of `ids` (`index_targets`), with their bodies, oldest first: queued, in flight and
 * blocked, and acknowledged while the `pending_effects` row of their first primary target stands (`readOutstandingCreates`' definition),
 * inside the caller's transaction. Null when more than `NAMING_MOST` of THEM name the rows, or when one of them has no body: never a part
 * of them answered as all of them.
 *
 * What is counted is outstanding drafts, each once (WEB-11a review 17, R17.1): the outbox keeps a conflict or a rejection until it is
 * dismissed (`decideDiscard`), and a released acknowledgement until its receipt is reconciled, so the entries naming a row can be any
 * number of drafts that change nothing shown. Each id's entries are walked a window at a time (bounded by the count taken first, as
 * `oldestNaming` does), and only the outstanding ones are held: however long the history, no read returns more than a window and no
 * more than `NAMING_MOST + 1` headers are held.
 */
async function outstandingNaming(
  reader: Reader,
  ids: readonly ResourceId[],
  kinds: readonly string[],
): Promise<DraftWithCommand[] | null> {
  if (ids.length === 0 || kinds.length === 0) return [];
  const kept = new Map<LocalId, DraftRow>();
  for (const id of [...new Set(ids)].sort()) {
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
        // A draft naming several of the rows is met once per row: it is one draft.
        if (kept.has(draft.local_id) || !kinds.includes(draft.kind)) continue;
        if (
          LIVE.includes(draft.status) ||
          (draft.status === "acknowledged" &&
            (await effectStands(reader, draft.target_resource_ids[0], draft)))
        ) {
          kept.set(draft.local_id, draft);
          if (kept.size > NAMING_MOST) return null;
        }
      }
      if (rows.length < WINDOW) break;
    }
  }
  const rows = [...kept.values()].sort(bySeq);
  const bodies = await bulkGetWindowed(
    reader,
    "draft_commands",
    rows.map((row) => row.local_id),
  );
  const out: DraftWithCommand[] = [];
  for (const [index, row] of rows.entries()) {
    const body = bodies[index];
    // A header without its body (they are written and removed together): what it would change is unknown, so the answer is not whole.
    if (body === undefined) return null;
    out.push({ ...row, command: body.command });
  }
  return out;
}

export interface ChildPageInput {
  incarnationId: string;
  kind: ResourceKind;
  /** The kind a row's parent must be cached as for the row to be answered. */
  parentKind: ResourceKind;
  /** One parent's children (the `parent_id` index); omitted: every row of `kind` (the `kind` index). */
  parentId?: ResourceId;
  after?: ResourceId | null;
  /** The command kinds of the drafts to read with the page (`drafts`); omitted: none are read. */
  kinds?: readonly string[];
}

export interface ChildPage {
  /**
   * One page as `readResourceList` reads it (its bound, overlays and order), keeping only the rows whose parent the cache holds as
   * `parentKind`. `next` is the cursor of the page READ, so a page whose rows are all hidden still moves the walk on (a hidden row never
   * keeps a later visible one out of reach).
   */
  page: ResourcePage;
  /** The parents of the kept rows (and `parentId`, when the cache holds it as `parentKind`), each with its overlay: absent is not held. */
  parents: Record<ResourceId, CacheRow>;
  /**
   * With `kinds`: the outstanding drafts naming a kept row (see `outstandingNaming`); null when more OUTSTANDING ones than one read answers
   * whole (retained conflicts, rejections and released acknowledgements are never counted), or one without its body.
   */
  drafts?: DraftWithCommand[] | null;
}

/**
 * A page of `kind` (under `parentId`) with the parents of its rows and, on request, the drafts over them, in ONE transaction: a child is
 * answered only with its parent from the same commit, and its saved changes from that commit too. `parentId` is ALWAYS read, so a live query
 * of this plan follows that parent's removal or return even when it has no children.
 */
export const readChildPage = readPlan<
  ChildPageInput,
  {
    list: Awaited<ReturnType<typeof readResourceList.read>>;
    held: CacheRow[];
    overlays: Map<ResourceId, Overlay>;
    drafts?: DraftWithCommand[] | null;
  },
  ChildPage
>({
  name: "data.readChildPage",
  scope: ["cache", "pending_effects", "drafts", "draft_commands"],
  read: async (reader, input) => {
    const list = await readResourceList.read(reader, {
      incarnationId: input.incarnationId,
      kind: input.kind,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      after: input.after ?? null,
    });
    const ids = new Set<ResourceId>(
      input.parentId === undefined ? [] : [input.parentId],
    );
    for (const row of list.reads.rows)
      if (row.parent_id !== null) ids.add(row.parent_id);
    const held = (await reader.bulkGet("cache", [...ids])).filter(
      (row): row is CacheRow => row?.kind === input.parentKind,
    );
    const parentIds = new Set(held.map((row) => row.id));
    return {
      list,
      held,
      overlays: await readOverlays(
        reader,
        [...parentIds],
        DATA_CONFIG.queueWorkingSet,
      ),
      ...(input.kinds === undefined
        ? {}
        : {
            drafts: await outstandingNaming(
              reader,
              list.reads.rows
                .filter((row) => parentIds.has(row.parent_id ?? ""))
                .map((row) => row.id),
              input.kinds,
            ),
          }),
    };
  },
  decide: ({ reads, input }) => {
    const parents: Record<ResourceId, CacheRow> = {};
    for (const base of reads.held)
      parents[base.id] = applyOverlay(
        base,
        reads.overlays.get(base.id) as Overlay,
      );
    const page = readResourceList.decide(reads.list, {
      incarnationId: input.incarnationId,
      kind: input.kind,
    }).result;
    return {
      page: {
        rows: page.rows.filter((row) => (row.base.parent_id ?? "") in parents),
        next: page.next,
      },
      parents,
      ...(reads.drafts === undefined ? {} : { drafts: reads.drafts }),
    };
  },
});

/** A page of form copies (`readFormCopies`) and whether the cache held `witness` as its kind in the same transaction. */
export interface FormCopiesUnder {
  page: FormCopiesPage;
  witnessed: boolean;
}

/** `readFormCopies` with its parent's cached row read in the same transaction (held changes are shown only under a held person). */
export const readFormCopiesUnder = readPlan<
  FormCopiesInput & { witness: { id: ResourceId; kind: ResourceKind } },
  {
    page: Awaited<ReturnType<typeof readFormCopies.read>>;
    witnessed: boolean;
  },
  FormCopiesUnder
>({
  name: "data.readFormCopiesUnder",
  scope: ["form_recovery", "cache"],
  read: async (reader, input) => ({
    page: await readFormCopies.read(reader, input),
    witnessed:
      (await reader.get("cache", input.witness.id))?.kind ===
      input.witness.kind,
  }),
  decide: ({ reads, input }) => ({
    page: readFormCopies.decide(reads.page, input).result,
    witnessed: reads.witnessed,
  }),
});

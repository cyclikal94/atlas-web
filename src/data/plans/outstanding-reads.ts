import { DATA_CONFIG } from "../model/config";
import { applyOverlay, type Overlay } from "../model/overlay";
import type {
  CacheRow,
  DraftRow,
  DraftStatus,
  DraftWithCommand,
  ResourceId,
  ResourceKind,
} from "../model/types";
import { type Reader, range } from "../store/port";
import { bulkGetWindowed, WINDOW } from "./bounded-reads";
import { readPlan } from "./builders";
import { listPageSize, type ResourcePage } from "./outbox";
import { readOverlays } from "./overlay-windows";

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
}

export interface OutstandingCreatesPage {
  /** At most one window of outstanding drafts of the kinds asked for, oldest first, each with its body. */
  drafts: DraftWithCommand[];
  /** The `created_seq` to pass back as `after` for the next window, or null when this is the last. */
  next: number | null;
}

const LIVE: readonly DraftStatus[] = ["queued", "in_flight", "blocked"];
const FAR = Number.MAX_SAFE_INTEGER;

export const readOutstandingCreates = readPlan<
  OutstandingCreatesInput,
  { drafts: DraftWithCommand[]; next: number | null },
  OutstandingCreatesPage
>({
  name: "data.readOutstandingCreates",
  scope: ["drafts", "draft_commands", "pending_effects"],
  read: (reader, input) => readOutstandingWindow(reader, input),
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

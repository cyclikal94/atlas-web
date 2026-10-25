import type { StoreName } from "./schema";
import type { SyncStateRow } from "./types";

/**
 * The LOCAL COMPOSITION GENERATION (WEB-10a revision 3, design assessment C3): `sync_state.composition_seq`, a per-database counter that
 * moves in the SAME transaction as every write to a store a screen composes its rows from. A view that composes from several read
 * transactions (a walk of a whole kind, then the related rows, then every page of the outstanding work) reads the generation before and
 * after them: IndexedDB runs transactions whose scopes overlap in the order they were created, every writer's scope includes `sync_state`,
 * and each read finishes before the next is created, so an unchanged generation proves that no such write committed between the reads,
 * in this page or any other. A changed one says only "read again": it carries no content and is never a reason to ask the server.
 *
 * - Advanced by the STORE, once per transaction, after the plan's own writes and before the transaction commits, whenever the
 *   transaction actually wrote one of those stores (a decision's writes or a streamed write; `advancesComposition`): the Dexie adapter and
 *   the test double both do it, so every writer is covered by construction, registered or not, and none can leave it out. A dropped,
 *   refused or aborted transaction commits nothing, so it advances nothing; a decision that writes nothing there (an empty sync page with
 *   no reconciliation, a page that is not final) advances nothing. A write that changes nothing visible (retry metadata on a draft row)
 *   still advances it: conservative, and only ever a local re-read.
 * - Not advanced by writers of `sync_state` alone (cursors, sizing, retry states, the epoch, defaults, the fence) or of `cache_staging`
 *   (staging is not the cache). `page_seq` and `applied_revision` say what the SERVER sent,
 *   `draft_seq` orders the queue, and none of them moves for every change of what a screen shows (receipts, claims, edits of a queued
 *   draft, reconciliation after recovery).
 * - Absent on a database written before it existed: 0. A database deleted and created again restarts at 0 under a new `incarnation_id`,
 *   so a reader compares the pair, never the number alone.
 * - Older builds cannot write without advancing it: the account schema's version 3 (`SCHEMA_VERSION`) exists for that. Opening it
 *   delivers `versionchange` to an older build's connections, whose adapter latches the account `upgrade_pending` and closes them, and
 *   an older build cannot open a version-3 database at all.
 */
export const COMPOSITION_STORES: ReadonlySet<StoreName> = new Set<StoreName>([
  "cache",
  "pending_effects",
  "drafts",
  "draft_commands",
]);

/** The generation a singleton carries (absent: 0). */
export const compositionOf = (sync: SyncStateRow | undefined): number =>
  sync?.composition_seq ?? 0;

/** The singleton with its generation advanced by one. */
export const advanceComposition = (sync: SyncStateRow): SyncStateRow => ({
  ...sync,
  composition_seq: compositionOf(sync) + 1,
});

/**
 * Whether a transaction must advance the generation: it wrote a composition store, and its scope holds `sync_state` (every registered
 * writer's does; only a test's raw plan over a single store does not).
 */
export const advancesComposition = (
  written: Iterable<StoreName>,
  scope: readonly StoreName[],
): boolean => {
  if (!scope.includes("sync_state")) return false;
  for (const store of written) if (COMPOSITION_STORES.has(store)) return true;
  return false;
};

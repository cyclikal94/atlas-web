import type { DeltaStagingRow } from "./segmented-sync";
import type {
  CacheRow,
  DraftCommandRow,
  DraftRow,
  FormRecoveryRow,
  PendingEffectRow,
  ResourceVersionRow,
  SyncStateRow,
} from "./types";

/**
 * The schema of the per-account database (plan 5.0.1). Dexie version 1 declared ALL nine stores (decision D-13): the
 * stores WEB-09b and later slices own are created empty, so the next slice needs no schema migration (the fields of
 * `sync_state` are free-form, so adding one needs no Dexie version either).
 *
 * VERSION 2 (revision R6/R3, decision D-23) changes this slice's own store only. A draft's command can be large (an import carries
 * up to 1 MiB), and an IndexedDB read returns whole rows, so every scan, count and list of the queue would have read the bodies of
 * drafts nobody was looking at. The body therefore lives in its own store, `draft_commands`, keyed by the draft's `local_id`;
 * the `drafts` row is the small header every queue read, dispatch scan, summary, consent count and page reconciliation uses. The
 * body is read for exactly one draft at a time: when it is sent, edited or projected. The header gains three indexes so the
 * dispatcher and the summary can ask the store for what they need (the oldest sendable drafts, the paused and the review-blocked
 * ones) without scanning rows that cannot matter.
 *
 * Dexie index names are key paths, so the WEB-04 design's index names map as shown in `D_INDEX_NAMES`.
 */
export const DATABASE_PREFIX = "atlas-";
/** The name of the per-account database. Every probe is by this EXACT name: `atlas-auth` shares the prefix. */
export const accountDatabaseName = (account: string): string =>
  `${DATABASE_PREFIX}${account}`;

export const STORE_NAMES = [
  "cache",
  "cache_staging",
  "delta_staging",
  "pending_effects",
  "drafts",
  "draft_commands",
  "resource_versions",
  "materialise_sequences",
  "reminder_firings",
  "form_recovery",
  "sync_state",
] as const;
export type StoreName = (typeof STORE_NAMES)[number];

/** The row each store holds, for the three stores whose rows this slice does not type (owned elsewhere). */
export interface StagingRow extends CacheRow {
  recovery_generation: number;
}
/** `delta_staging` (version 4): the last word of the segmented delta revision being staged about one resource. */
export type DeltaStagingStoreRow = DeltaStagingRow<CacheRow>;
export interface RowByStore {
  cache: CacheRow;
  cache_staging: StagingRow;
  delta_staging: DeltaStagingStoreRow;
  pending_effects: PendingEffectRow;
  drafts: DraftRow;
  draft_commands: DraftCommandRow;
  resource_versions: ResourceVersionRow;
  materialise_sequences: Record<string, unknown>;
  reminder_firings: Record<string, unknown>;
  form_recovery: FormRecoveryRow;
  sync_state: SyncStateRow;
}
export type RowOf<K extends StoreName> = RowByStore[K];

/** The Dexie schema strings: primary key first, then the indexes (`*` multi-entry, `[a+b]` compound). */
export const DEXIE_SCHEMA: Readonly<Record<StoreName, string>> = Object.freeze({
  cache: "id, kind, parent_id, [kind+kind_date]",
  cache_staging: "id, kind, parent_id, [kind+kind_date], recovery_generation",
  // Version 4 (WEB-09c): keyed by resource id (the last word), indexed by the revision it belongs to.
  delta_staging: "id, revision",
  pending_effects: "[resource_id+local_id], resource_id, local_id",
  // `[status+created_seq]`: the oldest drafts of a status, in queue order, without reading the rest. `review_block.kind` and
  // `retry_state.state` are nested key paths: a row is indexed only while it has the object, so each index lists exactly the
  // reviewing, or the backing-off and paused, drafts.
  drafts:
    "local_id, status, created_seq, [status+created_seq], *depends_on, *index_targets, review_block.kind, retry_state.state",
  draft_commands: "local_id",
  resource_versions: "resource_id",
  materialise_sequences: "[task_id+through_date]",
  reminder_firings: "[rule_id+rule_version+occurrence_version]",
  form_recovery: "[form_context+tab_instance_id], form_context",
  sync_state: "key",
});

/** The design's index names (WEB-04 D) mapped to the Dexie index (a key path) they became. */
export const D_INDEX_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "cache.by_kind": "kind",
  "cache.by_parent": "parent_id",
  "cache.by_kind_date": "[kind+kind_date]",
  "pending_effects.by_resource": "resource_id",
  "pending_effects.by_draft": "local_id",
  "drafts.by_status": "status",
  // Decision D-11: a per-database monotone counter, not the clock.
  "drafts.by_created_at": "created_seq",
  // Version 2 additions (this slice's own indexes; WEB-04's design has no counterpart).
  "drafts.by_status_seq": "[status+created_seq]",
  "drafts.by_review": "review_block.kind",
  "drafts.by_retry_state": "retry_state.state",
  "drafts.by_depends_on": "depends_on",
  "drafts.by_target_resource": "index_targets",
  "form_recovery.by_form": "form_context",
});

/**
 * The Dexie schema's version. Version 1 created the nine stores; version 2 splits the draft body out (see above). Version 3 (WEB-10a
 * revision 3) changes no store: it is the upgrade barrier for the local composition generation (`model/composition.ts`). Every writer of
 * this build advances it, a build before it did not, and opening version 3 delivers `versionchange` to an older build's connections,
 * which latch the account `upgrade_pending` and close (an older build cannot open a version-3 database at all), so no writer that leaves
 * the generation alone can commit beside a page that relies on it.
 *
 * VERSION 4 (WEB-09c, BOUNDED-SYNC-PAGINATION-20261027) adds ONE store, `delta_staging`: the persisted pieces of a delta revision delivered
 * in segments (`model/segmented-sync.ts`), never shown, applied whole by W1. No existing store or row changes, and the upgrade moves no
 * data. Like version 3 it is a barrier: an older build's connections latch `upgrade_pending` and close, so no build that does not know a
 * staged revision writes `sync_state` beside one.
 *
 * VERSION 5 (WEB-13b revision 8, review 8 R7b) changes no store: it is the same barrier for the cache's invalidation witness
 * (`sync_state.cache_invalidation_seq`, `model/invalidation.ts`), which a build of version 4 or below leaves alone when it invalidates.
 * Upgrading needs no data step: an absent witness reads 0, the protocol's starting point. (WEB-13b numbered it 4 on its own branch; the
 * base merge of 5 November 2026 renumbered it after the accepted base's version 4, so a version-4 build of the accepted base, which
 * invalidates without the witness, is closed by it and cannot open it.)
 */
export const SCHEMA_VERSION = 5;
/** The version 3 schema (no `delta_staging`), kept so a database created by it is upgraded in order. */
export const COMPOSITION_BARRIER_VERSION = 3;
/** The version that added `delta_staging` (WEB-09c; a barrier too). Version 5 declares the same stores. */
export const DELTA_STAGING_VERSION = 4;
/** The version that moved the command bodies to `draft_commands` (its upgrade runs for a version-1 database). */
export const SPLIT_BODIES_VERSION = 2;

/** The version 2 and 3 schema (every store but `delta_staging`), kept so the version chain declares each store where it began. */
export const DEXIE_SCHEMA_V3: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(DEXIE_SCHEMA).filter(([name]) => name !== "delta_staging"),
  ),
);

/** The version 1 schema, kept so a database created by it is upgraded (the command bodies move to `draft_commands`). */
export const DEXIE_SCHEMA_V1: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(DEXIE_SCHEMA_V3).filter(
      ([name]) => name !== "draft_commands",
    ),
  ),
  drafts: "local_id, status, created_seq, *depends_on, *index_targets",
});

/** Primary keys by store: the key path(s), for the double and for conformance. */
export const KEY_PATHS: Readonly<
  Record<StoreName, string | readonly string[]>
> = Object.freeze({
  cache: "id",
  cache_staging: "id",
  delta_staging: "id",
  pending_effects: ["resource_id", "local_id"],
  drafts: "local_id",
  draft_commands: "local_id",
  resource_versions: "resource_id",
  materialise_sequences: ["task_id", "through_date"],
  reminder_firings: ["rule_id", "rule_version", "occurrence_version"],
  form_recovery: ["form_context", "tab_instance_id"],
  sync_state: "key",
});

/** Parsed once from `DEXIE_SCHEMA` so the double and the conformance suite use the same index definitions. */
export interface IndexSpec {
  name: string;
  keyPath: string | readonly string[];
  multiEntry: boolean;
}
export function parseSchema(store: StoreName): {
  keyPath: string | readonly string[];
  indexes: IndexSpec[];
} {
  const parts = DEXIE_SCHEMA[store].split(",").map((part) => part.trim());
  const path = (text: string): string | readonly string[] =>
    text.startsWith("[") ? text.slice(1, -1).split("+") : text;
  const [primary, ...rest] = parts;
  return {
    keyPath: path(primary as string),
    indexes: rest.map((entry) => {
      const multiEntry = entry.startsWith("*");
      const bare = multiEntry ? entry.slice(1) : entry;
      return { name: bare, keyPath: path(bare), multiEntry };
    }),
  };
}

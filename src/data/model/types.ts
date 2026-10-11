/**
 * The row types of the per-account database (plan 5.0.2, 5.0.3). Pure data: nothing here imports the browser, React or
 * another module of the repository. The field names follow the WEB-04 design (D) where it names them.
 */

export type AccountId = string;
/** An integer >= 1; the session's epoch for one sign-in of an account. */
export type Epoch = number;
/** UUID v4; also the `Idempotency-Key` of the command it carries. */
export type LocalId = string;
export type ResourceId = string;
export type IsoInstant = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** The eleven kinds of `Projection.kind` in the pinned contract. */
export const RESOURCE_KINDS = [
  "person",
  "field",
  "task",
  "execution",
  "occurrence",
  "progress",
  "list",
  "calendar_source",
  "event",
  "review",
  "reminder",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** A `Projection` verbatim, plus the derived index key. */
export interface CacheRow {
  id: ResourceId;
  kind: ResourceKind;
  parent_id: ResourceId | null;
  label: string;
  value: JsonObject | null;
  version: number;
  can_edit: boolean;
  policy_version?: number;
  archived: boolean;
  kind_date: string | null;
}

export type DraftEndpoint =
  | "/task-commands"
  | "/commands"
  | "/reminder-commands"
  /** Registry-extensible; a templated path is resolved from `target_id` at dispatch (WEB-13b registers templates). */
  | (string & {});

export type DraftStatus =
  | "queued"
  | "in_flight"
  | "acknowledged"
  | "version_conflict"
  | "operation_conflict"
  | "rejected"
  | "superseded"
  /** With `blocked_reason` (decision D-12). */
  | "blocked";

export type ProjectionPatch = {
  label?: string;
  archived?: boolean;
  value?: Record<string, unknown>;
};

export interface DraftError {
  status?: number;
  code?: string;
  /** A fixed vocabulary word, never server text. */
  stage: string;
}

export interface DraftRow {
  /** Primary key; the `Idempotency-Key` on every attempt, retries included. */
  local_id: LocalId;
  /** Defensive: must equal the database's account (D:1617). */
  account_id: AccountId;
  endpoint: DraftEndpoint;
  /** The dynamic-routing target fixed at enqueue (Q22, for example `/calendar-sources/{id}/import`). */
  target_id: string | null;
  /**
   * The kind of the command (`command.kind`, else the first member of a command group, else the endpoint), derived once at enqueue
   * so the registries and the queue never need the body to say what a draft is. The data layer never branches on the value.
   */
  kind: string;
  /** SHA-256 hex of the canonical JSON of the command, which lives in `draft_commands` (D-07, D-23). */
  command_digest: string;
  defaults_revision: string | null;
  target_resource_ids: ResourceId[];
  /** Pre-increment version per progress-stream id (D:2048). */
  side_effect_bases: Record<ResourceId, number>;
  /** `target_resource_ids` plus the keys of `side_effect_bases` (multi-entry index). */
  index_targets: ResourceId[];
  /**
   * The version each target was assumed to be at when the command was built (the argument of `build`). An edit of a queued
   * command rebuilds from these, never from a later state. An addition to the WEB-04 field list (plan 5.5.5, flagged for review).
   */
  bases: Record<ResourceId, number>;
  /** The ids whose `resource_versions` record this draft raised by one (the version-checked primary and the side effects). */
  bumped: ResourceId[];
  expected_version?: number;
  /** Opaque to this slice (WEB-12a). */
  defaults_context: unknown | null;
  /** The defaults-review sub-state (D:788); a sub-state, not a status. */
  review_block: { kind: "defaults"; kinds: string[] } | null;
  depends_on: LocalId[];
  status: DraftStatus;
  blocked_reason?: "slice_capacity";
  /** D:3647. Never both this and `unavailable_outcome`. */
  held_pending_cache: boolean;
  /** D:3751. */
  unavailable_outcome: boolean;
  /** D:5063. */
  retry_state: null | { state: "backing_off" | "paused"; since: number };
  /** Issued requests that ended in a counted failure; never a request that was not sent. */
  attempts: number;
  last_attempt_at: IsoInstant | null;
  last_error: DraftError | null;
  /** Caller-supplied at enqueue, copied into `pending_effects` at admission. */
  display_patch: Record<ResourceId, ProjectionPatch> | null;
  receipt_revision: number | null;
  /** A per-database monotone counter (decision D-11): FIFO survives clock changes. */
  created_seq: number;
  created_at: IsoInstant;
}

/**
 * The body of a draft, in its own store keyed by the draft's `local_id` (decision D-23): the canonical command, frozen the instant
 * the draft's status leaves `queued`. It can be large (an import carries up to 1 MiB), so it is read for ONE draft at a time, to
 * send it, edit it or project it, and never by a scan, a count or a list.
 */
export interface DraftCommandRow {
  local_id: LocalId;
  command: JsonObject;
}

/** A draft with its body: what the dispatcher sends, an edit rebuilds, and a registered handler may inspect. */
export type DraftWithCommand = DraftRow & { command: JsonObject };

/** D:2047, field for field. */
export interface PendingEffectRow {
  resource_id: ResourceId;
  local_id: LocalId;
  resource_version: number | null;
  created_at: IsoInstant;
  /** Written once, never overwritten by a resend. */
  submitted_at_page_seq: number;
  last_mentioned_page_seq: number | null;
  display: ProjectionPatch | null;
  resolved: "no_publication" | null;
  no_publication_floor: number | null;
  receipt_revision: number | null;
}

export interface ResourceVersionRow {
  resource_id: ResourceId;
  locally_assumed_version: number;
  basis: "resource" | "progress_stream" | "timer_session";
}

/** D:2053. */
export interface FormRecoveryRow {
  form_context: string;
  tab_instance_id: string;
  fields: Record<string, string>;
  redacted: string[];
  saved_at: IsoInstant;
  /** The order of a capture WITHIN its writer generation: assigned when the capture is asked for, not when it is written. */
  capture_seq: number;
  /**
   * The writer generation: claimed, durably, unique and strictly increasing across every claim (`form_writer_gen` orders them), by each
   * page context that saves this form (`claimFormWriter`), before it can write. Captures are ordered by `(writer_gen, capture_seq)`, so a capture of an earlier page context can never
   * overtake one of a later context, whatever order they reach the store in. Absent on a row written before generations: 0.
   */
  writer_gen?: number;
  terminal: boolean;
  content_digest: string;
}

export interface DraftFence {
  token: string;
  started_at: number;
  operation_ids: string[];
  consent_digest: string;
  closing: boolean;
}

export type CacheStatus = "empty" | "valid" | "invalid";

export interface ReadRetryState {
  backing_off_since: number | null;
  paused: boolean;
  unrecognised_streak: number;
}

export type SizingClass = "constrained" | "unconstrained" | "unknown";
export interface SizingState {
  /** The `limit` of the next `/sync` request, 1 to 80. Stepped down by observed outcomes only (D-09). */
  limit: number;
  /** `null` until the engine first classifies the device (so a step-down is never undone by a later start). */
  class: SizingClass | null;
  floor_hits: number;
  /** The crash-loop marker (D-09): present while a large page is being processed. */
  attempt: null | { id: string; limit: number; started_at: number };
}

export interface ProfileState {
  username: string;
  verified_epoch: Epoch;
  verified_at: number;
}

/** The one `sync_state` row (`key: "singleton"`). Ordinary fields are this slice's; recovery fields are WEB-09b's. */
export interface SyncStateRow {
  key: "singleton";
  incarnation_id: string;
  cursor: string | null;
  phase: "snapshot" | "delta";
  cache_status: CacheStatus;
  applied_revision: number | null;
  page_seq: number;
  request_seq: number;
  last_synced_at: IsoInstant | null;
  draft_seq: number;
  /**
   * The last writer generation handed to ANY claim of a form (R33, revision 18; every claim, R1, revision 19): a per-database counter, like
   * `draft_seq`, so that the claim of a generation is ordered across page contexts without creating anything, and a claim of a form that has a
   * row and one of a form that has none are never given the same number. A row is growth, and growth is admitted by the quota guard before it
   * is written; a claim that created one first would write it unreserved. A generation is `max(this, the row's) + 1`, and this moves to it.
   * Absent on a database that never needed it: 0. Not a non-negative safe integer: no generation is issued (`no_generation`).
   */
  form_writer_gen?: number;
  draft_fence: DraftFence | null;
  defaults: unknown | null;
  device_id: string | null;
  device_verified: boolean;
  device_verified_for: { account_id: AccountId; epoch: Epoch } | null;
  read_retry_states: Record<string, ReadRetryState>;
  local_write_streaks: Record<string, number>;
  /**
   * The FAILURE that stands under each operation of `local_write_streaks` (R53, revision 32): a number taken from `local_write_seq` by
   * the transaction that counted it, so it names one failure episode and is never used twice (a count cannot: three failures, a reset
   * and three more are the same count). A reset that was decided on an earlier look carries the version it saw and clears only that
   * one; a newer failure has a newer version, and stays. Absent on a row that never recorded one (a streak without a version is 0).
   */
  local_write_versions?: Record<string, number>;
  /** The last number handed to a failure in `local_write_versions`; the next one is above it. Absent: 0. */
  local_write_seq?: number;
  sizing: SizingState;
  profile: ProfileState | null;
  /** The published epoch mirror (plan 5.2.2, G3-EPO). */
  stamp: { epoch: Epoch } | null;
  // Written by WEB-09b; read-only here, seeded so admission compares against stable values.
  recovery_generation: number;
  owner: {
    tab_id: string;
    ownership_token: string;
    heartbeat_at: number;
  } | null;
  staging_position: string | null;
  expected_position: string | null;
  /**
   * WEB-09b (all optional and read with their defaults, so a database created before them needs no migration):
   *  - `staging_started_at`: the client clock of the cursor-less capture that began the staged attempt, the one-hour bound of
   *    adoption (Q7); `staging_request_seq`: that capture's `request_seq`, the boundary for receipts at activation;
   *  - `staging_revision`: the snapshot's boundary revision (every page of one snapshot carries it); `staging_bytes`: the staged bytes;
   *  - the three recovery-scoped retry classes (absent = 0) and `recovery_budget_version`, the version of the whole-attempt failure
   *    that a person's "Try again" ends (R53-style: a newer trip is never cleared by an older act).
   */
  staging_started_at?: number | null;
  staging_request_seq?: number | null;
  staging_revision?: number | null;
  staging_bytes?: number;
  sync_error_streak?: number;
  delta_error_streak?: number;
  recovery_attempt_streak?: number;
  recovery_budget_version?: number;
  /**
   * WEB-09b (R8 of the review of 10 October 2026): a RECOVERY-mode data commit (a catch-up page, or the activation of a replacement
   * snapshot while the account was fenced) skipped the receipt bookkeeping of acknowledged drafts, because the recovery touches no draft,
   * `pending_effects` or outbox entry (matrix 3.7.3). It is owed: W26 does it as an ordinary write once the account is displayed, against
   * the cache as it is then, and clears this. Absent: nothing is owed.
   */
  recovery_reconcile_pending?: boolean;
}

/** The value a request carries from the moment it is captured for issue to the moment its answer is committed. */
export interface Captured {
  account: AccountId;
  epoch: Epoch;
  incarnationId: string;
  /** `/sync` only. */
  requestSeq: number | null;
  ownershipToken: string | null;
  recoveryGeneration: number;
  expectedPosition: string | null;
}

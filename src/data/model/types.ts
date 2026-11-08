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
  /**
   * WEB-09c (R20-SEG): `sync_state.request_seq` when the row was created (the claim), written once like `submitted_at_page_seq`. A word
   * STAGED from a request captured at or before it is not evidence about this row (`stagedMentionReaches`). Absent on a row written before
   * it: unknown (the receipt's floor, which comes later, stands in).
   */
  submitted_at_request_seq?: number;
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
  /**
   * WEB-14a revision 8 (R16, R17): what the form's code writes with a capture besides its texts, exactly as it gives it (the store never
   * interprets it): the capture's identity (`capture`, what a conditional discard compares in its transaction), the control state of fields
   * that are not one text (`controls`, versioned; in `content_digest`) and an update hand-off's lineage (`lineage`, versioned). Absent on a
   * row written before revision 8.
   */
  meta?: FormRecoveryMeta;
}

/** WEB-14a revision 8: the optional, versioned records the form's code writes with a capture (`FormRecoveryRow.meta`). */
export interface FormRecoveryMeta {
  capture?: string;
  controls?: { version: number; entries: unknown };
  lineage?: { version: number; entries: unknown };
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
/**
 * The revision being staged (`sync_state.delta_stage`; absent or null: none). `boundary_cursor` is the delta cursor the revision was asked
 * from (the position of the live cache, which is unchanged until activation); `next_index` the segment expected next.
 */
export interface DeltaStage {
  revision: number;
  next_index: number;
  /** The delta cursor the revision was asked from: where a broken sequence starts again. */
  boundary_cursor: string;
  /**
   * The continuation the last staged segment stored as `sync_state.cursor`. The stage belongs to THAT position: any writer that replaces the
   * cursor (an invalidation, a snapshot activation, an abandonment, a restart) leaves a stage whose cursor is no longer the row's, and such a
   * stage is no stage at all (`stageOf`), so no writer can forget to retire it.
   */
  cursor: string;
  /** Changes received in staged segments (ancestors repeated across segments counted each time) and their response bytes. */
  changes: number;
  bytes: number;
  /** Client clock of the first segment. */
  started_at: number;
}

export interface SizingState {
  /** The `limit` of the next `/sync` request, 1 to 80. Stepped down by observed outcomes only (D-09). */
  limit: number;
  /** `null` until the engine first classifies the device (so a step-down is never undone by a later start). */
  class: SizingClass | null;
  floor_hits: number;
  /** The crash-loop marker (D-09): present while a large page is being processed. */
  attempt: null | {
    id: string;
    limit: number;
    started_at: number;
    /** WEB-09c: the `max_changes` the attempt's request carried, when it carried one. */
    max_changes?: number;
  };
  /**
   * WEB-09c (segmented delivery, `model/segmented-sync.ts`): the `max_changes` a device signal at `limit = 1` stepped down to (halving, never
   * below the contract's 4). Absent: the configured starting value.
   */
  max_changes?: number;
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
  /**
   * The local composition generation (WEB-10a revision 3, `model/composition.ts`): advanced in the same transaction as every write to
   * `cache`, `pending_effects`, `drafts` or `draft_commands`, so a view that composes from several reads can prove that none committed
   * between them. Absent on a database that never had such a write since it existed: 0.
   */
  composition_seq?: number;
  draft_fence: DraftFence | null;
  defaults: unknown | null;
  /**
   * WEB-10c (W29, D-10c-4): a bounded copy of the last COMPLETE first page of the displayed account's running timer sessions
   * (`GET /timer-sessions?state=running`), so a reload offline can still show what was running. Read tolerantly (`readTimerCopy`):
   * absent (a database created before it) or damaged is "no copy". Optional, so no migration.
   */
  timer_copy?: unknown | null;
  /**
   * WEB-10c revision 2 (W29): the last place handed out in the timer observation order (`issueTimerOrder`), and the latest order
   * already applied to `timer_copy` (an earlier read's replacement or correction is refused). Absent: 0.
   */
  timer_order?: number;
  timer_fence?: number;
  /**
   * WEB-10c revision 3 (W29, review R14, design assessment DA-T3): what reads of each day observed (`TimerScopeRecord` by occurrence,
   * read tolerantly), and the order below which a day's read is no longer trusted for a session it saw running (what was not kept).
   * Absent: none, 0.
   */
  timer_scopes?: Record<string, unknown>;
  timer_scope_floor?: number;
  /**
   * WEB-10c revision 5 (W29, review R23): the latest COMPLETE observation of the account's running sessions (`TimerAccountRecord`: its
   * order and the sessions it listed), kept apart from `timer_copy` so a later partial first page never erases what it proved; and the
   * sessions any read listed FINISHED (the account's history, a day's read), which never run again (`timer_ended`, bounded). Read
   * tolerantly; absent: none.
   */
  timer_account?: unknown;
  timer_ended?: unknown;
  /**
   * WEB-10c revision 2 (W28, review R13, design assessment DA-M1): the catch-up DISCOVERY of each task (its first read, before its day is
   * known) that has failed: the consecutive uncertain answers it met and, once they reached the bound or a definite refusal came, its
   * stop. Kept across reloads and tabs, so the budget never starts again by itself; only the person's "Try again" (a new `retry`) does.
   * Removed when the discovery succeeds. Absent: none.
   */
  materialise_discovery?: Record<string, MaterialiseDiscovery>;
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
  /**
   * WEB-13b revision 8 (review 8 R7b): the cache's invalidation witness, moved by one by every committed invalidation (W18, and W24's
   * abandonment of a `valid` cache) and by nothing else (`model/invalidation.ts`, `invalidationsOf`). Absent: 0.
   */
  cache_invalidation_seq?: number;
  /**
   * WEB-09c: the delta revision being received in segments (`model/segmented-sync.ts`), staged in `delta_staging` and applied whole by W1.
   * Absent or null: none. In force only while `cursor` is the continuation it stored (`stageOf`).
   */
  delta_stage?: DeltaStage | null;
}

/**
 * WEB-10c (W28, D-10c-1/2): one catch-up sequence of a task's occurrences through a day, in the store `materialise_sequences` that
 * WEB-09a reserved (key `[task_id+through_date]`, version 1: no schema change). The data layer knows its shape and its compare-and-set,
 * never what the phases mean: the task slice's pure state machine decides every transition.
 */
export interface MaterialiseSequenceRow {
  task_id: string;
  /** `YYYY-MM-DD` in the task's zone. */
  through_date: string;
  /** A fresh UUID per incarnation of the key: an answer read under an earlier one never applies. */
  sequence_generation: string;
  phase: "ready" | "submitting" | "awaiting_position_read" | "stopped";
  /** The `materialise` attempt in flight or uncertain: its key and canonical body, written BEFORE it is sent. */
  attempt: { key: string; body: string } | null;
  /** +1 on each move to `awaiting_position_read`: a position read applies only to the move it was asked after. */
  read_seq: number;
  /** Counted successful calls of this run (the unattended budget). */
  successful_calls: number;
  /** `materialisation.last_date` as last read. */
  last_known_position: string | null;
  /** ms, the device clock: display only. */
  started_at: number;
  /** Consecutive uncertain answers (a send or a read). */
  read_failures: number;
  /**
   * Revision 4 (review R20): +1 on EVERY write of the row, stamped by W28 itself, so a row never comes back to an identity a caller saw
   * before (a "Try again" pressed on one stop cannot lift a later stop that looks the same). Absent on rows of earlier builds: 0.
   */
  revision?: number;
  stop: null | {
    reason:
      | "bound"
      | "no_progress"
      | "horizon"
      | "capacity"
      | "rejected"
      | "unreachable";
    request_id?: string;
  };
  trigger: "daily" | "streak" | "draft" | "ahead";
  /**
   * Revision 10 (Decision B): the retry schedule of the caller the phase names (`submitting`: the `materialise` command; awaiting its
   * position: the position read), or `null` (no failure or issue outstanding). ABSENT on a row of an earlier build: its uncertainty has no
   * trustworthy schedule (the task slice migrates it).
   */
  schedule?: MaterialiseRetry | null;
}

/**
 * Revision 10 (Decision B, WEB-04 §5.11): one catch-up caller's durable retry schedule, written BEFORE each transmission (`issued`) and
 * with each answer, so a reload or another tab's turn carries on from it. Times are ms of the device clock. The data layer stores and
 * compares it; the task slice's pure reducer (`model/retry.ts`) decides every value.
 */
export interface MaterialiseRetry {
  v: 1;
  caller: "discovery" | "command" | "position";
  /** The admitted transmission whose answer is not recorded yet, or null. */
  issued: number | null;
  /** The first failure of the episode (its window's start), or null: none since the caller's own success or a reset. */
  since: number | null;
  /** Consecutive failures in the episode (the pacing). */
  failures: number;
  /** The earliest next transmission (0: any time). */
  next: number;
  /** A server deadline (`Retry-After`) still to respect, or null. */
  server: number | null;
  cause: "transient" | "transport" | "rate_limited" | "unrecognised" | null;
  /** Consecutive unrecognised answers of a read (never reset by a recognised transient one). */
  unknown: number;
  /** The latest time written (a clock that goes back before it pauses). */
  seen: number;
  /** Why automatic transmission stopped (the record's stop shows it), or null. */
  pause: null | "window" | "unrecognised" | "clock" | "legacy";
}

/** WEB-10c revision 2 (W28): one task's failed catch-up discovery (`sync_state.materialise_discovery`). */
export interface MaterialiseDiscovery {
  /** The person's "Try again" moves it: an answer decided under an earlier one never applies. */
  retry: number;
  /** Consecutive uncertain first reads. */
  failures: number;
  stop: null | { reason: "unreachable" | "rejected"; request_id?: string };
  /**
   * Revision 3 (reviews R16, R17): the identity of the first read admitted last (written BEFORE it is sent, never reused), or null
   * (none since the entry was made or lifted; an entry of revision 2 has none). An answer is recorded only over its own attempt.
   */
  attempt?: string | null;
  /**
   * Revision 10 (Decision B): the discovery read's retry schedule. Absent on an entry of an earlier build; revision 11 (review R36): `null`
   * when nothing is outstanding (written explicitly, so an absent one is never this build's).
   */
  schedule?: MaterialiseRetry | null;
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

import { type Recomputed, recomputeVersions } from "./outbox";
import { onDraftFailure } from "./retry";
import type {
  CacheRow,
  CacheStatus,
  DraftError,
  DraftRow,
  LocalId,
  PendingEffectRow,
  ResourceId,
  ResourceVersionRow,
} from "./types";

/**
 * What a command's answer does to the stores, as PURE decisions (plan 5.5.4). The plans in `plans/outbox.ts` read the rows,
 * call these, and write the result in one transaction.
 */

// ---- the receipt: `admitReceipt` (W6) -------------------------------------------------------------------------------------------
export interface ReceiptFacts {
  draft: DraftRow | undefined;
  /** The candidate rows of this draft (`pending_effects` by `local_id`). */
  effects: readonly PendingEffectRow[];
  /** The drafts that name this one in `depends_on`. */
  dependants: readonly DraftRow[];
  cacheStatus: CacheStatus;
  /** `sync_state.request_seq` as this receipt is recorded: the floor of the live-edge `no_publication` rule. */
  requestSeq: number;
  revision: number;
}

export type ReceiptDecision =
  | { kind: "noop"; reason: "not_found" | "not_in_flight" }
  | {
      kind: "admitted";
      draftPut: DraftRow | null;
      draftDelete: LocalId | null;
      effectPuts: PendingEffectRow[];
      effectDeletes: Array<[ResourceId, LocalId]>;
      dependantPuts: DraftRow[];
      /** Rows whose `display` this receipt wrote. */
      displayed: number;
      held: boolean;
    };

/**
 * Conditions 0 to 4 of plan 5.5.4, in order. It never writes `cache`: the overlay is shown until a delta page publishes the
 * resource (release (a)) or the live edge shows that nothing will (release (b)).
 */
export function decideReceipt(facts: ReceiptFacts): ReceiptDecision {
  const { draft } = facts;
  // 0: the draft is found with status exactly `in_flight`; anything else is a duplicate or a late receipt, and changes nothing.
  if (draft === undefined) return { kind: "noop", reason: "not_found" };
  if (draft.status !== "in_flight")
    return { kind: "noop", reason: "not_in_flight" };

  const valid = facts.cacheStatus === "valid";
  let held = false;
  let displayed = 0;
  // 1 and 2: the candidate rows.
  const rows = facts.effects.map((row): PendingEffectRow => {
    const open = row.last_mentioned_page_seq === null && row.resolved === null;
    if (
      row.last_mentioned_page_seq === null &&
      row.resolved !== "no_publication" &&
      valid
    ) {
      displayed += 1;
      return {
        ...row,
        display: draft.display_patch?.[row.resource_id] ?? null,
        no_publication_floor: facts.requestSeq,
        receipt_revision: facts.revision,
      };
    }
    // No display: a mention already released this row, or the cache is not valid (nothing is shown over a hidden cache).
    if (open && !valid) held = true;
    return {
      ...row,
      ...(open ? { no_publication_floor: facts.requestSeq } : {}),
      receipt_revision: facts.revision,
    };
  });

  // 3: the draft is acknowledged UNCONDITIONALLY: the operation committed whatever the cache is doing.
  const acknowledged: DraftRow = {
    ...draft,
    status: "acknowledged",
    receipt_revision: facts.revision,
    held_pending_cache: held,
    retry_state: null,
    last_error: null,
  };

  // 4: rows already released leave, and the draft leaves once its overlay is gone and its flags are clear.
  const effectPuts: PendingEffectRow[] = [];
  const effectDeletes: Array<[ResourceId, LocalId]> = [];
  let surviving = 0;
  for (const row of rows) {
    const finished =
      row.display === null &&
      (row.last_mentioned_page_seq !== null || row.resolved !== null) &&
      !held &&
      !acknowledged.unavailable_outcome;
    if (finished) effectDeletes.push([row.resource_id, row.local_id]);
    else {
      effectPuts.push(row);
      surviving += 1;
    }
  }
  const leaves = !held && !acknowledged.unavailable_outcome && surviving === 0;
  return {
    kind: "admitted",
    draftPut: leaves ? null : acknowledged,
    draftDelete: leaves ? draft.local_id : null,
    effectPuts,
    effectDeletes,
    dependantPuts: facts.dependants
      .filter((dependant) => dependant.depends_on.includes(draft.local_id))
      .map((dependant) => ({
        ...dependant,
        depends_on: dependant.depends_on.filter((id) => id !== draft.local_id),
      })),
    displayed,
    held,
  };
}

// ---- every other answer: `recordOutcome` (W7) and `recordFailureOfSend` (W8) -------------------------------------------------------
export type RecordedOutcome =
  /** `409 conflict` or `409 operation_conflict` (or a registered handler's reclassification). */
  | { kind: "conflict"; as: "version_conflict" | "operation_conflict" }
  /** `409 defaults_changed`: a review block on the still-frozen draft, and the queue held from it (D-19). */
  | { kind: "defaults_changed" }
  /** `403`, `404`, `422`, `400`: rejected, and every direct and transitive dependant with it. */
  | { kind: "rejected" }
  /** `503 slice_capacity`. */
  | { kind: "capacity" }
  /** A counted failure that keeps the draft `in_flight`: `500`, `503`, `429`, an unrecognised answer, a network error. */
  | { kind: "retry" };

export interface OutcomeFacts {
  draft: DraftRow | undefined;
  outcome: RecordedOutcome;
  error: DraftError;
  /** `draft` and, for a rejection, every transitive dependant. */
  members: readonly DraftRow[];
  /** The candidate rows of every member. */
  effects: readonly PendingEffectRow[];
  /** Every draft that is not a member and targets an id a member touched. */
  others: readonly DraftRow[];
  cache: ReadonlyMap<ResourceId, CacheRow>;
  versions: ReadonlyMap<ResourceId, ResourceVersionRow>;
  /** Milliseconds since the epoch (the back-off clock) and the same instant as ISO text. */
  now: number;
  nowIso: string;
}

export type OutcomeDecision =
  | { kind: "noop"; reason: "not_found" | "not_in_flight" }
  | {
      kind: "recorded";
      status: DraftRow["status"];
      draftPuts: DraftRow[];
      effectDeletes: Array<[ResourceId, LocalId]>;
      versions: Recomputed;
    };

const none: Recomputed = { puts: [], deletes: [] };

/** A candidate row exists for a draft that may have been executed. A draft that cannot be sent has none. */
const rowsOf = (
  effects: readonly PendingEffectRow[],
  members: readonly DraftRow[],
): Array<[ResourceId, LocalId]> => {
  const ids = new Set(members.map((member) => member.local_id));
  return effects
    .filter((row) => ids.has(row.local_id))
    .map((row) => [row.resource_id, row.local_id]);
};

/**
 * Applies one answer to an `in_flight` draft. Everything else (a draft that is gone, or no longer `in_flight`) is a no-op: a
 * duplicate or late answer changes nothing (the same condition 0 as the receipt).
 */
export function decideOutcome(facts: OutcomeFacts): OutcomeDecision {
  const { draft, outcome, error } = facts;
  if (draft === undefined) return { kind: "noop", reason: "not_found" };
  if (draft.status !== "in_flight")
    return { kind: "noop", reason: "not_in_flight" };
  const counted: DraftRow = {
    ...draft,
    attempts: draft.attempts + 1,
    last_attempt_at: facts.nowIso,
    last_error: error,
  };

  switch (outcome.kind) {
    case "retry": {
      // Stays `in_flight` and keeps the candidate rows: it may have been executed (a lost answer), and is retried with its key.
      const retry = onDraftFailure(draft.retry_state, facts.now);
      return {
        kind: "recorded",
        status: "in_flight",
        draftPuts: [{ ...counted, retry_state: retry }],
        effectDeletes: [],
        versions: none,
      };
    }
    case "defaults_changed":
      return {
        kind: "recorded",
        status: "in_flight",
        draftPuts: [
          {
            ...counted,
            retry_state: null,
            review_block: { kind: "defaults", kinds: [] },
          },
        ],
        effectDeletes: [],
        versions: none,
      };
    case "conflict":
      return {
        kind: "recorded",
        status: outcome.as,
        draftPuts: [{ ...counted, status: outcome.as, retry_state: null }],
        // The server did not execute it and it will not be resent under this key: nothing can ever publish its rows.
        effectDeletes: rowsOf(facts.effects, [draft]),
        versions: none,
      };
    case "capacity":
      return {
        kind: "recorded",
        status: "blocked",
        draftPuts: [
          {
            ...counted,
            status: "blocked",
            blocked_reason: "slice_capacity",
            retry_state: null,
          },
        ],
        effectDeletes: rowsOf(facts.effects, [draft]),
        versions: none,
      };
    case "rejected": {
      const members = facts.members.some((m) => m.local_id === draft.local_id)
        ? facts.members
        : [draft, ...facts.members];
      const puts = members.map(
        (member): DraftRow =>
          member.local_id === draft.local_id
            ? { ...counted, status: "rejected", retry_state: null }
            : {
                ...member,
                status: "rejected",
                retry_state: null,
                last_error: { stage: "dependency_rejected" },
              },
      );
      return {
        kind: "recorded",
        status: "rejected",
        draftPuts: puts,
        effectDeletes: rowsOf(facts.effects, members),
        versions: recomputeVersions({
          members,
          others: facts.others,
          cache: facts.cache,
          versions: facts.versions,
        }),
      };
    }
  }
}

/** "Retry now", `online` and the manual retry of a blocked draft: what a resumed draft looks like. */
export function resumeDraft(draft: DraftRow): DraftRow | null {
  if (draft.status === "blocked") {
    const { blocked_reason: _capacity, ...rest } = draft;
    return {
      ...rest,
      status: "queued",
      retry_state: null,
      attempts: 0,
      last_error: null,
    };
  }
  if (draft.retry_state === null) return null;
  return { ...draft, retry_state: null, attempts: 0 };
}

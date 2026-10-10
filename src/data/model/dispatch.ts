import type { AtlasError } from "../../lib/api-client/problem";
import { DATA_CONFIG } from "./config";
import { isTerminal } from "./outbox";
import { nextDelay, type RetryConfig } from "./retry";
import type { DraftRow, LocalId } from "./types";

/**
 * The dispatcher's decisions as PURE functions (plan 5.5.3 and 5.5.4): which draft is sent next, and what each answer to a
 * command request means. The dispatcher itself (src/data/engine/outbox-dispatcher.ts) only performs them.
 */

// ---- the answer to a command request ------------------------------------------------------------------------------------------
/** What a response to `POST /commands` (or `/task-commands`, `/reminder-commands`, ...) means for the draft (plan 5.5.4). */
export type CommandOutcome =
  /** `200 {revision}`: the operation committed. */
  | { kind: "receipt"; revision: number }
  /** `409 conflict`, `409 operation_conflict`, `409 defaults_changed`. */
  | { kind: "conflict"; code: "conflict" | "operation_conflict" }
  | { kind: "defaults_changed" }
  /** Any other `409` code (`materialisation_required`, `refresh_in_progress`, `stale_refresh`, `stale_delivery`, ...). */
  | { kind: "other_conflict"; code: string }
  /** `403 forbidden`, `404`, `422`, `400 malformed_request`: a returned domain refusal. Retained, never replayed. */
  | { kind: "rejected"; status: number; code: string }
  /** `503 slice_capacity`. */
  | { kind: "capacity" }
  /** `500`, `503 temporarily_unavailable`, `429`, an unrecognised answer: still `in_flight`, retried with the same key. */
  | { kind: "retry"; status: number; code: string | null };

export interface AnswerFacts {
  status: number;
  /** The Atlas-formatted error body, or `null` when the body is not one (a gateway page, an empty body). */
  error: AtlasError | null;
  /** The parsed `revision` of a `200`, or `undefined`. */
  revision: unknown;
}

/**
 * A refusal is recognised only from an ATLAS-FORMATTED error body (the same rule the session applies to an activation). A `404`
 * from a gateway or an HTML page is not the domain's refusal of this command: it is an unrecognised answer, which backs off and
 * keeps the draft, never rejects it. That is the conservative direction: a draft is only ever rejected by the server saying so.
 */
export function classifyAnswer(facts: AnswerFacts): CommandOutcome {
  const { status, error } = facts;
  const code = error?.code ?? null;
  if (status === 200) {
    return Number.isInteger(facts.revision) && (facts.revision as number) >= 0
      ? { kind: "receipt", revision: facts.revision as number }
      : { kind: "retry", status, code: null };
  }
  if (status === 409 && code !== null) {
    if (code === "conflict" || code === "operation_conflict")
      return { kind: "conflict", code };
    if (code === "defaults_changed") return { kind: "defaults_changed" };
    return { kind: "other_conflict", code };
  }
  if (status === 503 && code === "slice_capacity") return { kind: "capacity" };
  if (code !== null) {
    if (
      (status === 403 && code === "forbidden") ||
      (status === 400 && code === "malformed_request") ||
      status === 404 ||
      status === 422
    )
      return { kind: "rejected", status, code };
  }
  return { kind: "retry", status, code };
}

// ---- which draft is next ------------------------------------------------------------------------------------------------------
export type SelectionConfig = RetryConfig;

/**
 * The instant before which a draft is not tried again, from its DURABLE state alone (`attempts`, `last_attempt_at`), so a reload
 * does not make a backing-off draft immediately eligible. The dispatcher's in-memory schedule (jitter, a `Retry-After`) takes
 * precedence while the page lives.
 */
export function durableNotBefore(
  draft: Pick<DraftRow, "retry_state" | "attempts" | "last_attempt_at">,
  config: SelectionConfig = DATA_CONFIG,
): number {
  if (
    draft.retry_state === null ||
    draft.attempts === 0 ||
    draft.last_attempt_at === null
  )
    return 0;
  const last = Date.parse(draft.last_attempt_at);
  if (Number.isNaN(last)) return 0;
  return last + nextDelay(draft.attempts, 0.5, config);
}

export interface SelectionInput {
  /** A PREFIX of the queue in `created_seq` order: the oldest rows, whatever their status. */
  rows: readonly DraftRow[];
  now: number;
  /** In-memory back-off ends (jitter, a `Retry-After`): they take precedence over `durableNotBefore`. */
  blockedUntil?: ReadonlyMap<LocalId, number>;
  config?: SelectionConfig;
}

export interface Selection {
  pick: DraftRow | null;
  /** The earliest instant a draft that only waits for its back-off becomes eligible. */
  wakeAt: number | null;
  /** Rows that wait for the person: a paused draft ("Retry now"), a defaults review. */
  paused: number;
  backingOff: number;
  /** The `created_seq` from which the queue is held (a `409 defaults_changed`), or null. */
  holdFrom: number | null;
}

/**
 * Global FIFO by `created_seq`, over independent drafts (decision D-18, plan 5.5.3). A draft is a candidate when it is `queued`
 * or `in_flight` (a retry candidate) and
 *  - every `depends_on` entry is terminal (a missing row is terminal: it was deleted),
 *  - it has no defaults review, and the queue is not held from an earlier draft's defaults review (D-19),
 *  - it is not paused ("Retry now"), and not waiting for its back-off,
 *  - it shares no target with an EARLIER draft that is not terminal: two drafts against one resource are never reordered.
 *
 * An earlier draft that is waiting (a conflict, a back-off) therefore blocks only the drafts that share a resource with it, so
 * one entry's retry never blocks another (A:3936-3952).
 */
export function selectCandidate(input: SelectionInput): Selection {
  const config = input.config ?? DATA_CONFIG;
  const byId = new Map(input.rows.map((row) => [row.local_id, row]));
  let holdFrom: number | null = null;
  for (const row of input.rows)
    if (
      row.review_block !== null &&
      (row.status === "queued" || row.status === "in_flight")
    ) {
      holdFrom = row.created_seq;
      break;
    }
  const claimed = new Set<string>();
  const out: Selection = {
    pick: null,
    wakeAt: null,
    paused: 0,
    backingOff: 0,
    holdFrom,
  };
  for (const row of input.rows) {
    if (isTerminal(row) || row.status === "superseded") continue;
    const sendable = row.status === "queued" || row.status === "in_flight";
    const shares = row.index_targets.some((id) => claimed.has(id));
    for (const id of row.index_targets) claimed.add(id);
    if (!sendable) continue;
    const paused = row.retry_state?.state === "paused";
    if (paused || row.review_block !== null) out.paused += 1;
    if (paused || row.review_block !== null) continue;
    if (holdFrom !== null && row.created_seq > holdFrom) continue;
    if (shares) continue;
    if (
      row.depends_on.some((id) => {
        const dependency = byId.get(id);
        return dependency !== undefined && !isTerminal(dependency);
      })
    )
      continue;
    const notBefore =
      input.blockedUntil?.get(row.local_id) ?? durableNotBefore(row, config);
    if (notBefore > input.now) {
      out.backingOff += 1;
      // A draft left alone until the person asks (an infinite block) is waited for by nobody: it sets no wake time.
      if (Number.isFinite(notBefore))
        out.wakeAt =
          out.wakeAt === null ? notBefore : Math.min(out.wakeAt, notBefore);
      continue;
    }
    if (out.pick === null) out.pick = row;
  }
  return out;
}

// ---- which draft is next, one candidate at a time ----------------------------------------------------------------------------
/**
 * What the store knows about ONE candidate, read by index and never by scanning the queue: the headers of the drafts it depends
 * on, and, for each of its targets, the earliest unsettled draft that shares it (never the whole population that shares it).
 */
export interface CandidateFacts {
  /** The headers of the `depends_on` ids that still exist (a missing row is terminal: it was deleted). */
  dependencies: ReadonlyMap<LocalId, DraftRow>;
  /**
   * The drafts that decide whether a target holds the candidate back. The rule asks only whether some draft that is not terminal and
   * is OLDER than the candidate shares one of its targets, so the whole population of drafts that share a target is never needed:
   * the store reads, for each target of the candidate, the EARLIEST unsettled draft that has it (`readEarliestSharing`, a window at
   * a time), and that one answers the question exactly. A list of every sharing draft gives the same verdict (the candidate itself
   * may be among them), which is what the whole-queue reference (`selectCandidate`) and the tests give it.
   */
  sharing: readonly DraftRow[];
}

export interface CandidateContext {
  now: number;
  /** The `created_seq` from which the queue is held (a `409 defaults_changed`), or null. */
  holdFrom: number | null;
  blockedUntil?: ReadonlyMap<LocalId, number>;
  config?: SelectionConfig;
}

export type Eligibility =
  | { verdict: "eligible" }
  /** Waits for the person: a paused draft ("Retry now") or a defaults review. */
  | { verdict: "needs_person" }
  /** Held behind an earlier draft's defaults review (D-19). */
  | { verdict: "held" }
  /** Shares a target with an EARLIER draft that is not terminal, or depends on one that is not: it waits for that draft. */
  | { verdict: "waiting_on_draft" }
  /** Waits for its own back-off, until `notBefore` (infinite: left alone until the person asks). */
  | { verdict: "backing_off"; notBefore: number };

/** Whether a status is one of the two the dispatcher sends from. */
export const isSendableStatus = (status: DraftRow["status"]): boolean =>
  status === "queued" || status === "in_flight";

/**
 * The rule of `selectCandidate` for ONE sendable row, from the facts the store holds about it rather than from a prefix of the
 * queue. The two are the same decision: the whole-queue function is the reference that a property test holds this one to. A row
 * "shares a target with an EARLIER draft" when some other draft with a smaller `created_seq` is not terminal and not superseded and
 * has an `index_targets` entry in common; a dependency that no longer exists is terminal.
 */
export function candidateEligibility(
  row: DraftRow,
  context: CandidateContext,
  facts: CandidateFacts,
): Eligibility {
  const config = context.config ?? DATA_CONFIG;
  if (row.retry_state?.state === "paused" || row.review_block !== null)
    return { verdict: "needs_person" };
  if (context.holdFrom !== null && row.created_seq > context.holdFrom)
    return { verdict: "held" };
  const targets = new Set(row.index_targets);
  for (const other of facts.sharing)
    if (
      other.local_id !== row.local_id &&
      other.created_seq < row.created_seq &&
      !isTerminal(other) &&
      other.status !== "superseded" &&
      other.index_targets.some((id) => targets.has(id))
    )
      return { verdict: "waiting_on_draft" };
  for (const id of row.depends_on) {
    const dependency = facts.dependencies.get(id);
    if (dependency !== undefined && !isTerminal(dependency))
      return { verdict: "waiting_on_draft" };
  }
  const notBefore =
    context.blockedUntil?.get(row.local_id) ?? durableNotBefore(row, config);
  if (notBefore > context.now) return { verdict: "backing_off", notBefore };
  return { verdict: "eligible" };
}

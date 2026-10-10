import { DATA_CONFIG } from "./config";
import type { DraftRow } from "./types";

/**
 * The queue summary (plan 5.5.7). The warning is INFORMATIONAL ONLY: nothing is disabled, no change is refused, nothing is
 * dropped (`queue-warning-threshold.html`). The chip's `pendingCount` and `conflictCount` are `waiting` and `needsDecision`; that
 * mapping is proposed and flagged for review.
 */
export interface QueueSummary {
  /** `queued` and `in_flight` (without a defaults review). */
  waiting: number;
  /** `version_conflict`, `operation_conflict`, a defaults review, `rejected` and `blocked`. */
  needsDecision: number;
  /** `acknowledged` and still carrying a flag (`held_pending_cache` or `unavailable_outcome`). */
  held: number;
  total: number;
  /** `total >= queueWarnAt`. */
  warn: boolean;
}

export const EMPTY_SUMMARY: QueueSummary = Object.freeze({
  waiting: 0,
  needsDecision: 0,
  held: 0,
  total: 0,
  warn: false,
});

/** The summary from counts the store gave by index: the same arithmetic as `summariseQueue`, without the rows. */
export function summaryFromCounts(
  counts: { waiting: number; needsDecision: number; held: number },
  warnAt: number = DATA_CONFIG.queueWarnAt,
): QueueSummary {
  const total = counts.waiting + counts.needsDecision + counts.held;
  return { ...counts, total, warn: total >= warnAt };
}

/**
 * Whether a draft appears in a tab of the queue panel: the drafts that are on their way (`queued`, `in_flight`, and an acknowledged
 * one still being confirmed) and those that need the person (the conflicts, a rejected or capacity-blocked one). Everything else
 * (an acknowledged draft that is fully published, a superseded one) is not shown. One predicate, shared by the data layer's page
 * read and the panel's tab split, so the two can never disagree.
 */
export function isQueueVisible(draft: DraftRow): boolean {
  switch (draft.status) {
    case "queued":
    case "in_flight":
    case "version_conflict":
    case "operation_conflict":
    case "rejected":
    case "blocked":
      return true;
    case "acknowledged":
      return draft.held_pending_cache || draft.unavailable_outcome;
    default:
      return false;
  }
}

/** The summary of a whole list of drafts. Kept as the reference the indexed counts are held to (a property test), and for fixtures. */
export function summariseQueue(
  drafts: readonly DraftRow[],
  warnAt: number = DATA_CONFIG.queueWarnAt,
): QueueSummary {
  let waiting = 0;
  let needsDecision = 0;
  let held = 0;
  for (const draft of drafts) {
    switch (draft.status) {
      case "queued":
      case "in_flight":
        if (draft.review_block !== null) needsDecision += 1;
        else waiting += 1;
        break;
      case "version_conflict":
      case "operation_conflict":
      case "rejected":
      case "blocked":
        needsDecision += 1;
        break;
      case "acknowledged":
        if (draft.held_pending_cache || draft.unavailable_outcome) held += 1;
        break;
      default:
        break;
    }
  }
  const total = waiting + needsDecision + held;
  return { waiting, needsDecision, held, total, warn: total >= warnAt };
}

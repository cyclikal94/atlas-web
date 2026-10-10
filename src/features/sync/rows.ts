import type { DraftRow } from "../../data";
import {
  ATTEMPTS,
  BADGE_BLOCKED,
  BADGE_OPERATION_CONFLICT,
  BADGE_REJECTED,
  BADGE_REVIEW,
  BADGE_VERSION_CONFLICT,
  BLOCKED_BODY,
  CONFIRMING,
  CONFLICT_READ_ONLY,
  NOT_SHOWING,
  PAUSED,
  REJECTED_BODY,
  SENDING,
  TRYING_AGAIN,
  WAITING,
  WILL_SEND,
} from "./copy";

/**
 * What one row of the queue panel says and offers, as PURE functions (plan 5.5.7, 5.7; WEB-04 wireframe 14). The panel never
 * decides anything about the draft: it states what the store holds and offers only what the store can do (Discard, Retry).
 *
 * "Waiting to send" holds what is on its way: `queued`, `in_flight` (including a retry that is backing off or paused) and an
 * acknowledged draft that is still being confirmed. "Needs a decision" holds everything the person must look at: the conflicts and
 * a defaults review (shown READ-ONLY with a kind badge: WF-CONFLICT-01/02 are unowned and not built, decision D-17), a rejected
 * change and a capacity-blocked one (each with the actions the store provides). The two tab counts add up to the chip's
 * `pendingCount` and `conflictCount`.
 */
export type Tab = "waiting" | "decision";
export type RowAction = "discard" | "retry" | "dismiss";

export interface RowView {
  tab: Tab;
  /** A short badge for the kinds that need a decision, never colour alone. */
  badge: string | null;
  status: string;
  attempts: string | null;
  /** An explanatory sentence under the title, for the kinds that need one. */
  body: string | null;
  actions: RowAction[];
  /** Why Discard is not offered, when it is not (an `in_flight` draft may already have been received). */
  cannotDiscard: boolean;
}

export function tabOf(draft: DraftRow): Tab | null {
  switch (draft.status) {
    case "queued":
      return draft.review_block !== null ? "decision" : "waiting";
    case "in_flight":
      return draft.review_block !== null ? "decision" : "waiting";
    case "acknowledged":
      return draft.held_pending_cache || draft.unavailable_outcome
        ? "waiting"
        : null;
    case "version_conflict":
    case "operation_conflict":
    case "rejected":
    case "blocked":
      return "decision";
    default:
      return null;
  }
}

export function describeRow(draft: DraftRow, online: boolean): RowView | null {
  const tab = tabOf(draft);
  if (tab === null) return null;
  const attempts = draft.attempts > 0 ? ATTEMPTS(draft.attempts) : null;
  const base = { tab, attempts, body: null, cannotDiscard: false };
  switch (draft.status) {
    case "queued":
      if (draft.review_block !== null)
        return {
          ...base,
          badge: BADGE_REVIEW,
          status: WAITING,
          body: CONFLICT_READ_ONLY,
          actions: [],
        };
      return {
        ...base,
        badge: null,
        status: online ? WAITING : WILL_SEND,
        attempts: ATTEMPTS(draft.attempts),
        actions: ["discard"],
      };
    case "in_flight": {
      if (draft.review_block !== null)
        return {
          ...base,
          badge: BADGE_REVIEW,
          status: WAITING,
          body: CONFLICT_READ_ONLY,
          // A defaults review was DEFINITIVELY not executed (the server said so), so it may be discarded.
          actions: ["discard"],
        };
      if (draft.retry_state?.state === "paused")
        return {
          ...base,
          badge: null,
          status: PAUSED,
          attempts: ATTEMPTS(draft.attempts),
          actions: ["retry"],
          cannotDiscard: true,
        };
      return {
        ...base,
        badge: null,
        status:
          draft.retry_state?.state === "backing_off" ? TRYING_AGAIN : SENDING,
        attempts: ATTEMPTS(draft.attempts),
        actions: [],
        cannotDiscard: true,
      };
    }
    case "acknowledged":
      return {
        ...base,
        badge: null,
        status: draft.unavailable_outcome ? NOT_SHOWING : CONFIRMING,
        actions: draft.unavailable_outcome ? ["dismiss"] : [],
      };
    case "version_conflict":
      return {
        ...base,
        badge: BADGE_VERSION_CONFLICT,
        status: WAITING,
        body: CONFLICT_READ_ONLY,
        actions: ["discard"],
      };
    case "operation_conflict":
      return {
        ...base,
        badge: BADGE_OPERATION_CONFLICT,
        status: WAITING,
        body: CONFLICT_READ_ONLY,
        actions: ["discard"],
      };
    case "rejected":
      return {
        ...base,
        badge: BADGE_REJECTED,
        status: BADGE_REJECTED,
        body: REJECTED_BODY,
        actions: ["dismiss"],
      };
    case "blocked":
      return {
        ...base,
        badge: BADGE_BLOCKED,
        status: BADGE_BLOCKED,
        body: BLOCKED_BODY,
        actions: ["retry", "discard"],
      };
    default:
      return null;
  }
}

/** "09:12" for today; "28 Sep, 09:12" for another day. UK English, 24-hour. */
export function formatSavedAt(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  if (at.toDateString() === now.toDateString()) return `at ${time}`;
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(at);
  return `on ${day} at ${time}`;
}

/** The rows of one tab, in queue order. */
export function rowsOf(drafts: readonly DraftRow[], tab: Tab): DraftRow[] {
  return drafts
    .filter((draft) => tabOf(draft) === tab)
    .sort((a, b) => a.created_seq - b.created_seq);
}

import { digestOf, sha256Hex } from "./canonical";
import type { DraftRow, DraftStatus, FormRecoveryRow } from "./types";

/**
 * The unsynced local work (plan 5.3.3; WEB-04 design 733-775, "THE normative set"). One function serves the count the dialog
 * shows, the live recount, the baseline the consent ticket binds to and the fence's consent digest, so a `reconfirm` or a
 * renewed prompt can only mean that the work genuinely changed.
 *
 * The digest runs over STORED per-row digests (`command_digest`, `content_digest`), so it is synchronous and cheap (decision
 * D-07): it has to be computed INSIDE the transaction that sets the fence.
 */

/** The statuses that are unsynced work whatever else is true of the draft. */
const ALWAYS: ReadonlySet<DraftStatus> = new Set<DraftStatus>([
  "queued",
  "in_flight",
  "rejected",
  "blocked",
  "version_conflict",
  "operation_conflict",
]);

export type Category =
  | "waiting"
  | "needs_decision"
  | "could_not_be_saved"
  | "confirming"
  | "form_copy";

export type LocalWorkMember =
  | { kind: "draft"; category: Category; row: DraftRow }
  | { kind: "form"; category: "form_copy"; row: FormRecoveryRow };

/** Whether a draft is a member of the population. Ordinary acknowledged drafts and superseded drafts are not. */
export function isMemberDraft(draft: DraftRow): boolean {
  if (ALWAYS.has(draft.status)) return true;
  if (draft.status === "acknowledged")
    return draft.held_pending_cache || draft.unavailable_outcome;
  return false;
}

function categoryOf(draft: DraftRow): Category {
  switch (draft.status) {
    case "queued":
    case "in_flight":
      return draft.review_block !== null ? "needs_decision" : "waiting";
    case "version_conflict":
    case "operation_conflict":
      return "needs_decision";
    case "rejected":
    case "blocked":
      return "could_not_be_saved";
    default:
      return "confirming";
  }
}

export function population(
  drafts: readonly DraftRow[],
  recovery: readonly FormRecoveryRow[],
): LocalWorkMember[] {
  const members: LocalWorkMember[] = [];
  for (const row of drafts)
    if (isMemberDraft(row))
      members.push({ kind: "draft", category: categoryOf(row), row });
  // A terminal recovery row has had its fields cleared: it is not work.
  for (const row of recovery)
    if (!row.terminal)
      members.push({ kind: "form", category: "form_copy", row });
  return members;
}

/** The empty-population digest: a fixed, well-known value, never the empty string. */
export const EMPTY_DIGEST = sha256Hex("atlas-local-work:empty");

/** Digests that stand for "the work could not be read": see `unreadable-digests.ts` for why they must differ. */
export {
  UNREADABLE_BASELINE,
  UNREADABLE_LIVE,
  UNREADABLE_SUMMARY,
} from "./unreadable-digests";
/** The baseline of a database with work in it and no fence: nothing was consented to, so it can equal no live digest. */
export const NO_CONSENT_DIGEST = "no-consent";

/** SHA-256 of the sorted per-row digests. Order-independent, and unchanged by `pending_effects` and cache changes. */
export function digestOfMembers(members: readonly LocalWorkMember[]): string {
  if (members.length === 0) return EMPTY_DIGEST;
  const tuples = members.map((member) =>
    member.kind === "draft"
      ? [
          "d",
          member.row.local_id,
          member.row.command_digest,
          member.row.status,
          member.row.held_pending_cache,
          member.row.unavailable_outcome,
        ]
      : [
          "f",
          member.row.form_context,
          member.row.tab_instance_id,
          member.row.content_digest,
          member.row.saved_at,
        ],
  );
  tuples.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return digestOf(tuples);
}

const CATEGORY_TEXT: Record<Category, (n: number) => string> = {
  waiting: (n) => `${n} ${n === 1 ? "change" : "changes"} waiting to send`,
  needs_decision: (n) =>
    `${n} ${n === 1 ? "change" : "changes"} that ${n === 1 ? "needs" : "need"} your decision`,
  could_not_be_saved: (n) =>
    `${n} ${n === 1 ? "change" : "changes"} that could not be saved`,
  confirming: (n) =>
    `${n} ${n === 1 ? "change" : "changes"} still being confirmed`,
  form_copy: (n) => `${n} unfinished form ${n === 1 ? "copy" : "copies"}`,
};
const ORDER: readonly Category[] = [
  "waiting",
  "needs_decision",
  "could_not_be_saved",
  "confirming",
  "form_copy",
];

export interface LocalWorkSummaryValue {
  count: number;
  items: string[];
  digest: string;
}

/** Generic category lines with counts, NEVER content, unique per category (the dialog uses them as React keys). */
export function summarise(
  members: readonly LocalWorkMember[],
): LocalWorkSummaryValue {
  const counts = new Map<Category, number>();
  for (const member of members)
    counts.set(member.category, (counts.get(member.category) ?? 0) + 1);
  return {
    count: members.length,
    items: ORDER.flatMap((category) => {
      const n = counts.get(category);
      return n ? [CATEGORY_TEXT[category](n)] : [];
    }),
    digest: digestOfMembers(members),
  };
}

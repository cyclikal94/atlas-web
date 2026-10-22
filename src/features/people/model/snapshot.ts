import type {
  CacheRow,
  DraftRow,
  DraftWithCommand,
  EditOutcome,
} from "../../../data";
import { type FieldValue, parseFieldValue } from "./values";

/**
 * What an edit BEGAN on (finding 1 of the review of 13 October; Q1, A4–A6; the Q21 rename design captures the version when the form opens).
 * PURE.
 *
 * An edit is bound to the row the person saw when they opened it, not to whatever the cache or the outbox says at the moment they save:
 *  - `version` and `policyVersion`: the cached row's content and policy versions then. A save under another policy version, or of another
 *    content version, is refused until the person has reviewed the current value and audience (and chose "Save mine on the current
 *    version", which re-binds the edit explicitly).
 *  - `expectedBase`: the version the outbox must resolve for the row inside the writing transaction (`BaseGuard`): the base of the newest
 *    outstanding save of this device for the row plus one (this device's own chain), or the cached version when there is none. A change
 *    published by someone else, or a save queued by another page in between, resolves another base and the save is refused, never
 *    re-based.
 *  - `latestLocalId`: the newest outstanding save of the row then; only that one may be edited in place (D-11a-15).
 *  - `latestDigest`: the `command_digest` of THAT save's body as the edit read it (review 2 of 22 October 2026, finding 3). The form shows
 *    that body; an edit in place replaces it only while it is stored exactly so (`reviewedDraft`, judged inside the writing
 *    transaction). Another page's newer edit of the same draft keeps its id, status and bases, so neither those nor the server versions can
 *    tell it apart: only the body's identity can. null when nothing was outstanding, or when the save was not in the outstanding read.
 */
export interface EditSnapshot {
  version: number;
  policyVersion: number | null;
  expectedBase: number;
  latestLocalId: string | null;
  latestDigest: string | null;
}

/** The outstanding saves of this device that raised `id`'s version (its own chain), newest last. */
function chainOf(
  id: string,
  drafts: readonly DraftWithCommand[],
  exclude?: string,
): DraftWithCommand[] {
  return drafts
    .filter(
      (draft) =>
        draft.local_id !== exclude &&
        draft.bumped.includes(id) &&
        typeof draft.bases[id] === "number",
    )
    .sort((a, b) => a.created_seq - b.created_seq);
}

/** The base the next command of an edit of `row` must resolve (see `EditSnapshot.expectedBase`). */
export function expectedBaseOf(
  row: Pick<CacheRow, "id" | "version">,
  drafts: readonly DraftWithCommand[],
  exclude?: string,
): number {
  const latest = chainOf(row.id, drafts, exclude).at(-1);
  return latest === undefined
    ? row.version
    : (latest.bases[row.id] as number) + 1;
}

export function snapshotOf(
  row: Pick<CacheRow, "id" | "version" | "policy_version">,
  drafts: readonly DraftWithCommand[],
  latestLocalId: string | null,
): EditSnapshot {
  return {
    version: row.version,
    policyVersion: row.policy_version ?? null,
    expectedBase: expectedBaseOf(row, drafts),
    latestLocalId,
    latestDigest:
      latestLocalId === null
        ? null
        : (drafts.find((draft) => draft.local_id === latestLocalId)
            ?.command_digest ?? null),
  };
}

/**
 * The draft an edit in place may replace (D-11a-15; review 2, finding 3): the save the edit began on, still queued, with exactly the body
 * it read. For `expectDraft`, inside the writing transaction. PURE.
 */
export const reviewedDraft =
  (snapshot: Pick<EditSnapshot, "latestLocalId" | "latestDigest">) =>
  (draft: DraftRow): boolean =>
    snapshot.latestLocalId !== null &&
    snapshot.latestDigest !== null &&
    draft.local_id === snapshot.latestLocalId &&
    draft.status === "queued" &&
    draft.command_digest === snapshot.latestDigest;

/**
 * Whether a NEW draft may follow the save the edit began on (review 2, finding 3): after an edit in place was refused (`refusal`), or
 * when none was asked (null: that save is held for the defaults review, or the audience was just changed). Only when the outstanding read
 * shows that save NOW with exactly the body the edit read: a body still queued may be edited by another page in the one transaction's
 * window before the new draft is written (as for a held change, docs/people.md), and a body that has left the queue is frozen. Never after
 * `draft_changed` (the stored body is not the one the edit read), `retargeted` or `not_found`, nor when the read does not show it: the
 * person reviews the field again. With nothing outstanding when the edit began, the base guard alone decides. PURE.
 */
export function successorFollows(
  refusal: Extract<EditOutcome, { kind: "refused" }>["reason"] | null,
  snapshot: Pick<EditSnapshot, "latestLocalId" | "latestDigest">,
  drafts: readonly DraftWithCommand[],
): boolean {
  if (snapshot.latestLocalId === null) return true;
  if (refusal !== null && refusal !== "not_queued") return false;
  const draft = drafts.find((d) => d.local_id === snapshot.latestLocalId);
  return (
    draft !== undefined &&
    snapshot.latestDigest !== null &&
    draft.command_digest === snapshot.latestDigest
  );
}

/** Whether the row as it is now is still the one the edit began on (content and policy versions). */
export const stillBound = (
  snapshot: EditSnapshot,
  row: Pick<CacheRow, "version" | "policy_version">,
): boolean =>
  row.version === snapshot.version &&
  (row.policy_version ?? null) === snapshot.policyVersion;

/** The name and value a stored `put_field` draft carries (a conflicted save's content, finding 3), or null when its body is not one. */
export function draftFieldContent(
  draft: DraftWithCommand,
): { label: string; value: FieldValue; policyVersion: number | null } | null {
  const command = (draft.command as { command?: Record<string, unknown> })
    .command;
  if (
    command === undefined ||
    command.kind !== "put_field" ||
    typeof command.label !== "string"
  )
    return null;
  const value = parseFieldValue(command.value);
  if (value === null) return null;
  return {
    label: command.label,
    value,
    policyVersion:
      typeof command.expected_policy_version === "number"
        ? command.expected_policy_version
        : null,
  };
}

import type { CacheRow, DraftWithCommand } from "../../../data";
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
 */
export interface EditSnapshot {
  version: number;
  policyVersion: number | null;
  expectedBase: number;
  latestLocalId: string | null;
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
  };
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

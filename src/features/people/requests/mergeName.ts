import { isCurrentMemory, type PeopleMemory } from "../memory";

/**
 * The sender's "Name after merging" choice for one ordered pair (R1 of review 4): page memory only, per identity, never written to storage,
 * never sent (the command carries the NAME). Every reader, edit, capture and cleanup goes through these functions.
 *
 * OWNERSHIP. Each real edit stores a NEW frozen record, even when it chooses the value already chosen (changed away and back): the record's
 * object identity is the edit's ticket. A merge attempt captures the record current at its original preparation (`captureMergeName`),
 * the same snapshot its body's name was taken from, and keeps it in its origin for as long as the attempt is kept (a replay answers the
 * ORIGINAL capture, never what is chosen when Try again is pressed). Its success consumes the choice only while that exact record is still
 * the pair's current one, in the identity's current memory (`consumeMergeName`): a choice made after the capture (in the same dialog, a
 * reopened comparison of the pair through either entry, or before a retry) is kept; an unchanged choice is consumed by its own success.
 * Rendering, remounting, reading the comparison again or retrying a read never creates or replaces a record.
 */
export type MergeNameChoice = "source" | "target";
export interface MergeNameDraft {
  /** The memory key of the pair the record belongs to (`merge-name:<source>:<target>`). */
  readonly key: string;
  readonly choice: MergeNameChoice;
}

export const mergeNameKey = (sourceId: string, targetId: string): string =>
  `merge-name:${sourceId}:${targetId}`;

const isDraft = (value: unknown, key: string): value is MergeNameDraft =>
  typeof value === "object" &&
  value !== null &&
  (value as MergeNameDraft).key === key &&
  ((value as MergeNameDraft).choice === "source" ||
    (value as MergeNameDraft).choice === "target");

/** The pair's current record (null: nothing chosen, the default, the kept person's name, applies). */
export function mergeNameDraft(
  memory: PeopleMemory,
  sourceId: string,
  targetId: string,
): MergeNameDraft | null {
  const key = mergeNameKey(sourceId, targetId);
  const value = memory.drafts.get(key);
  return isDraft(value, key) ? value : null;
}

/** What the pair's choice is now. */
export const mergeNameChoice = (
  draft: MergeNameDraft | null,
): MergeNameChoice => draft?.choice ?? "target";

/** A real edit: a new record (a new ticket), and every reader renders again. */
export function chooseMergeName(
  memory: PeopleMemory,
  sourceId: string,
  targetId: string,
  choice: MergeNameChoice,
): MergeNameDraft {
  const draft: MergeNameDraft = Object.freeze({
    key: mergeNameKey(sourceId, targetId),
    choice,
  });
  memory.drafts.set(draft.key, draft);
  memory.touch();
  return draft;
}

/**
 * What a fresh attempt is made of, at its original preparation: the record `rendered` (the one the pressed render drew its choice from),
 * only while it is still the pair's current one (null: the render is stale, nothing is sent). A default that was never chosen is made an
 * explicit record here, so its success has a ticket to consume; the shown choice does not change, so no reader is notified.
 */
export function captureMergeName(
  memory: PeopleMemory,
  sourceId: string,
  targetId: string,
  rendered: MergeNameDraft | null,
): MergeNameDraft | null {
  const current = mergeNameDraft(memory, sourceId, targetId);
  if (current !== rendered) return null;
  if (current !== null) return current;
  const draft: MergeNameDraft = Object.freeze({
    key: mergeNameKey(sourceId, targetId),
    choice: "target",
  });
  memory.drafts.set(draft.key, draft);
  return draft;
}

/**
 * A success of the attempt that captured `owned`: its choice is consumed (removed, every reader notified) only when `memory` is still the
 * identity's current memory and `owned` is still the pair's current record; compared and consumed in one synchronous step. An unknown
 * owner (null) or a newer record keeps what is there; nothing of another identity is ever looked up.
 */
export function consumeMergeName(
  memory: PeopleMemory,
  owned: MergeNameDraft | null,
): "consumed" | "kept" | "stale" {
  if (!isCurrentMemory(memory)) return "stale";
  if (owned === null || memory.drafts.get(owned.key) !== owned) return "kept";
  memory.drafts.delete(owned.key);
  memory.touch();
  return "consumed";
}

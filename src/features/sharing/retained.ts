/**
 * Unsaved editor input kept through the dialog's in-dialog sync control (WEB-02 ia.md §1.3.3 and §3, J2; WEB-12a R5). Activating that
 * control is a deliberate check of sync state, not a discard: the editor's current field values are retained, the dialog closes, the
 * queue or conflicts screen opens, and reopening the same editor shows the retained values instead of a fresh form. Cancel, Escape and
 * the close icon discard them, and so does a successful save.
 *
 * In this page's memory only: nothing is written to storage (policies and templates are online-only, D-12a-1), and a reload forgets it.
 * Each entry belongs to ONE displayed identity (`account:epoch`) and ONE target (a resource's policy, or one defaults layer of one kind),
 * and is only ever given back to that identity and that target. Keeping an entry for an identity forgets every other identity's, so a
 * different account (or a later sign-in of the same one) never sees them. A restored entry carries the version it was composed against
 * and its uncertain attempt, so Save stays guarded by that version and a resend keeps its key; nothing is ever sent by restoring.
 */
const LIMIT = 20;
const entries = new Map<string, { identity: string; value: unknown }>();

const keyOf = (identity: string, target: string) =>
  `${identity}\u0000${target}`;

/** Keeps `value` for this identity and target (replacing an earlier one), forgetting every other identity's entries. */
export function retain(identity: string, target: string, value: unknown): void {
  for (const [key, entry] of entries)
    if (entry.identity !== identity) entries.delete(key);
  const key = keyOf(identity, target);
  entries.delete(key);
  entries.set(key, { identity, value });
  if (entries.size > LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** What was retained for exactly this identity and target, if anything. It stays until `forget` (a discard or a successful save). */
export function retained<T>(identity: string, target: string): T | undefined {
  return entries.get(keyOf(identity, target))?.value as T | undefined;
}

/** Discards what was retained for this identity and target. */
export function forget(identity: string, target: string): void {
  entries.delete(keyOf(identity, target));
}

/** For tests: forget everything. */
export function forgetAllRetained(): void {
  entries.clear();
}

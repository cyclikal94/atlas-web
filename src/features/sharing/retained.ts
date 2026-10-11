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
 *
 * Every entry is OWNED by an editor session (WEB-12a review 2, R5): the policy editor of one resource, or the defaults editor, whose
 * entries span every layer, household and kind it has kept. A session outlives its dialog while it has kept input (the sync control
 * suspends it, reopening the same editor resumes it) and ends when the person dismisses the editor: `discard` forgets EVERY entry the
 * session owns, whether or not its read has landed or the form that kept it is on screen, and nothing the ended session does afterwards
 * (a late keep, a late save's forget) can bring an entry back or remove a later session's. Other owners' entries are never touched.
 * There is one defaults editor (the `/sharing/defaults/$kind` route); a second simultaneous host would need its own owner name.
 */
const LIMIT = 20;

/** One editor session. `ended` once dismissed (or once its identity is no longer the one keeping input): it can do nothing more. */
interface Owner {
  identity: string;
  name: string;
  ended: boolean;
}

const entries = new Map<string, { owner: Owner; value: unknown }>();
const owners = new Map<string, Owner>();

const keyOf = (identity: string, name: string) => `${identity}\u0000${name}`;

/** The handle an editor holds for its session: what it reads, keeps and forgets goes through it. */
export interface RetainedSession {
  /** What this session kept for `target`, if anything (nothing once the session has ended). */
  retained<T>(target: string): T | undefined;
  /** Keeps `value` for `target` (replacing an earlier one), forgetting every other identity's entries. Ignored once ended. */
  retain(target: string, value: unknown): void;
  /** Forgets one target (a successful save, a Reload): the session's other entries stay. Ignored once ended. */
  forget(target: string): void;
  /** The person dismissed the editor: forgets every entry the session owns and ends it. Repeating it does nothing. */
  discard(): void;
}

/**
 * The session `name` of `identity`: the one suspended by the sync control if there is one (its entries are given back), otherwise a new
 * one. Calling it again before the session ends returns the same session (React may render a component twice).
 */
export function retainedSession(
  identity: string,
  name: string,
): RetainedSession {
  const ownerKey = keyOf(identity, name);
  let owner = owners.get(ownerKey);
  if (owner === undefined || owner.ended) {
    owner = { identity, name, ended: false };
    owners.set(ownerKey, owner);
  }
  const self = owner;
  return {
    retained<T>(target: string) {
      if (self.ended) return undefined;
      const entry = entries.get(keyOf(identity, target));
      return entry?.owner === self ? (entry.value as T) : undefined;
    },
    retain(target, value) {
      if (self.ended) return;
      for (const [key, entry] of entries)
        if (entry.owner.identity !== identity) entries.delete(key);
      for (const [key, other] of owners)
        if (other.identity !== identity) {
          other.ended = true;
          owners.delete(key);
        }
      const key = keyOf(identity, target);
      entries.delete(key);
      entries.set(key, { owner: self, value });
      if (entries.size > LIMIT) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    forget(target) {
      if (self.ended) return;
      const key = keyOf(identity, target);
      if (entries.get(key)?.owner === self) entries.delete(key);
    },
    discard() {
      if (self.ended) return;
      self.ended = true;
      for (const [key, entry] of entries)
        if (entry.owner === self) entries.delete(key);
      if (owners.get(ownerKey) === self) owners.delete(ownerKey);
    },
  };
}

/** For tests: forget everything (every session ends). */
export function forgetAllRetained(): void {
  for (const owner of owners.values()) owner.ended = true;
  owners.clear();
  entries.clear();
}

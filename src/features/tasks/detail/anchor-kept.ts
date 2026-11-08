import {
  type AnchorDraft,
  type AnchorEditor,
  type AnchorNames,
  createAnchorEditor,
} from "../../calendars/anchors";
import { onTaskVisitEnded, type TaskVisit } from "../visit";

/**
 * The owner of the task detail's anchor editing sessions (WEB-13b revision 2, review 2 R3a/R3b; design assessment, invariants 1–6; ia.md
 * §1.3.3, task states I1). One session (`calendars/anchor-editor.ts`) per displayed identity and task, owned by the task's VISIT, not by
 * the panel showing it or the section that opened it:
 *
 *  - The next panel opened on the visit shows the session the visit still has, if the in-dialog sync control kept it, or a panel that left
 *    without being cancelled (the section remounted, the data hid it) left it holding input or a save being made. Showing it again never
 *    takes it away: a save still being made settles in the session whether or not a panel shows it, before, while or after it is shown
 *    again (R3a). Otherwise the panel starts a new session, and the previous one ends.
 *  - Cancel, Escape and the close icon end the session they showed (`discardPanel`), and only that one: an ended session's late completion
 *    changes nothing, so a cancelled panel's save can never consume another panel's input (R3b). A session consumed by its own save leaves.
 *  - The visit's end (any ordinary departure, another identity) ends every session it owns, shown or not. Page memory only: never stored;
 *    a reload forgets it.
 *
 * The identity of each change pressed and not yet known to be stored (`operationKeys`, R2) is kept per task for the visit too, apart from
 * the sessions: the same change pressed again after a refusal or a failure that may have stored it, in this panel, a panel shown again or
 * a new one, names the same operation; a stored change's identity is retired by the save that stored it.
 */
interface Held {
  editor: AnchorEditor<unknown>;
  owner: TaskVisit | null;
}

const panels = new Map<string, Held>();
const operations = new Map<
  string,
  { owner: TaskVisit; keys: Map<string, string> }
>();

onTaskVisitEnded((visit) => {
  for (const [key, held] of [...panels])
    if (held.owner === visit) {
      held.editor.end();
      panels.delete(key);
    }
  for (const [key, entry] of [...operations])
    if (entry.owner === visit) operations.delete(key);
});

export const keptPanelKey = (identity: string, taskId: string): string =>
  `${identity}\u0000anchor:${taskId}`;

/** Only the displayed identity's sessions and operations are kept. */
function forgetOtherIdentities(key: string): void {
  const mine = `${key.slice(0, key.indexOf("\u0000"))}\u0000`;
  for (const [other, held] of [...panels])
    if (!other.startsWith(mine)) {
      held.editor.end();
      panels.delete(other);
    }
  for (const other of [...operations.keys()])
    if (!other.startsWith(mine)) operations.delete(other);
}

const holdsInput = (editor: AnchorEditor<unknown>): boolean => {
  const state = editor.state();
  return state.revision > 0 || state.busy;
};

/**
 * The session the panel opening now for `key` shows, on `owner`'s visit (null: a section outside any router, whose panels keep nothing):
 * the visit's kept or left session, else a new one from `fresh`. `renew` makes what the next save is checked against after a done save of
 * the session that left newer input.
 *
 * `owner` is the visit going on at the moment the panel opens (revision 3, review 3 R3c): a visit that has ended owns nothing from then on
 * (its end has already let go of what it had), so no panel opens on it (null). The caller asks for the visit going on, not the one it was
 * shown on: an ended visit is never taken for a section outside any router.
 */
export function openPanel<C>(
  key: string,
  owner: TaskVisit | null,
  fresh: () => { draft: AnchorDraft; names: AnchorNames; context: C },
  renew: (context: C) => C,
): AnchorEditor<C> | null {
  if (owner?.ended()) return null;
  forgetOtherIdentities(key);
  const held = panels.get(key);
  if (
    held !== undefined &&
    owner !== null &&
    held.owner === owner &&
    !held.editor.ended() &&
    (held.editor.retained() || holdsInput(held.editor))
  ) {
    held.editor.resume();
    return held.editor as AnchorEditor<C>;
  }
  held?.editor.end();
  const editor: AnchorEditor<C> = createAnchorEditor<C>({
    ...fresh(),
    renew,
    // Only a session that has not ended settles, and every session but the task's current one has ended (replaced, cancelled, its
    // visit or identity gone): the one consumed is the one the task has.
    onConsumed: () => panels.delete(key),
  });
  panels.set(key, { editor: editor as AnchorEditor<unknown>, owner });
  return editor;
}

/** The in-dialog sync control keeps `editor` for the next panel opened on its visit (nothing outside a visit, or once it has ended). */
export function retainPanel(key: string, editor: AnchorEditor<unknown>): void {
  const held = panels.get(key);
  if (
    held === undefined ||
    held.editor !== editor ||
    held.owner === null ||
    held.owner.ended()
  )
    return;
  editor.retain();
}

/** Cancel, Escape or the close icon: `editor`'s session ends (a save it already made stays queued); no other session is touched. */
export function discardPanel(key: string, editor: AnchorEditor<unknown>): void {
  editor.end();
  if (panels.get(key)?.editor === editor) panels.delete(key);
}

/** The identities of `key`'s changes pressed and not yet stored, for `owner`'s visit; outside a live visit, the caller's own (`mine`). */
export function operationKeys(
  key: string,
  owner: TaskVisit | null,
  mine: Map<string, string>,
): Map<string, string> {
  if (owner === null || owner.ended()) return mine;
  const entry = operations.get(key);
  if (entry !== undefined && entry.owner === owner) return entry.keys;
  const keys = new Map<string, string>();
  operations.set(key, { owner, keys });
  return keys;
}

/** Tests only. */
export function forgetKeptPanels(): void {
  for (const held of panels.values()) held.editor.end();
  panels.clear();
  operations.clear();
}

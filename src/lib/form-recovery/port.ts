/**
 * Form recovery around an app-update reload (Q4). WEB-07 owns the presentation and this contract; WEB-09a
 * implements the port over the form_recovery store (src/data/ports/form-recovery.ts), and WEB-14a supplies the update event and the reload.
 *
 * The compound key [formContext, tabInstanceId] mirrors WEB-04's form_recovery store, so two tabs editing
 * the same form never overwrite one another.
 */

/** An explicit allow-list: nothing outside it is ever captured. */
export interface RecoverableFieldSpec {
  name: string;
}

export interface RecoverySnapshot {
  formContext: string;
  tabInstanceId: string;
  values: Record<string, string>;
  savedAt: string;
}

/**
 * `refused` (WEB-09a, decision D-16) means the account is being signed out: nothing was written, and the form stays open. It is
 * not a failure to retry; the person is told that saving is not possible while signing out.
 */
export type SaveResult = "saved" | "failed" | "refused";

/**
 * What a discard (a submission's, or "Discard instead") did to a copy (WEB-14a revision 1, R6). `discarded`: no copy of that form and tab
 * can be restored any more (the terminal row is durable, or there was no copy). `failed`: the copy may still be there and come back after a
 * reload; the caller must not say it was discarded. `refused`: the account is being signed out; nothing was written (the database is about
 * to be deleted with every copy in it).
 */
export type DiscardResult = "discarded" | "failed" | "refused";

/**
 * A read of the store that could not be made (WEB-14a revision 7, R13: no open database, a closed or replaced handle, an aborted
 * transaction) says NOTHING about whether a copy exists, so it is never an empty answer: `load` and `list` REJECT. A caller that cannot
 * read must show that, keep what it owes and let the person try again (`readCopy`, `readCopies`).
 */
export interface FormRecoveryPort {
  save(snapshot: RecoverySnapshot): Promise<SaveResult>;
  /**
   * The copy of that form and tab, or null when there is none that can be restored (none was saved, or it was discarded or submitted).
   * Revision 7 (R13): null is only ever a SUCCESSFUL read; a read that could not be made rejects.
   */
  load(
    formContext: string,
    tabInstanceId: string,
  ): Promise<RecoverySnapshot | null>;
  discard(formContext: string, tabInstanceId: string): Promise<DiscardResult>;
  /**
   * EVERY copy of the form that can still be restored, newest first (WEB-14a; revision 1, R5: complete, however many discarded or submitted
   * rows the form has, so a bound on one read never hides a copy): one per tab that saved one, so a page that returns after an update can
   * restore the newest and name the others. A copy that was discarded or submitted is not listed. Revision 7 (R13): an empty list is only
   * ever a SUCCESSFUL read; a read that could not be made rejects, never answers "no copies".
   */
  list(formContext: string): Promise<readonly RecoverySnapshot[]>;
  /**
   * The port fixed to the account (and database handle) this one reaches NOW, with that account, or null when it reaches none (WEB-14a
   * revision 1). A capture pins the port when it is ASKED FOR, so a write that waits (for the page's recovery identifier, the quota reserve)
   * can never land in another account's store; one whose handle has closed meanwhile fails. `scope` names the account's database as it is
   * now (its incarnation): a database deleted and created again since is another scope. Optional: a port over a single store has nothing to
   * pin.
   */
  pin?(): { account: string; scope: string; port: FormRecoveryPort } | null;
}

/** What one copy's read found (revision 7, R13): the copy, none (a successful read), or nothing known (the read could not be made). */
export type CopyRead =
  | { kind: "found"; copy: RecoverySnapshot }
  | { kind: "absent" }
  | { kind: "unavailable" };

/** What a form's listing found (revision 7, R13): its copies (possibly none), or nothing known. */
export type CopiesRead =
  | { kind: "listed"; copies: readonly RecoverySnapshot[] }
  | { kind: "unavailable" };

/** `port.load`, typed: whatever stops the read (a rejection, a throw, an answer that is not a copy) is `unavailable`, never `absent`. */
export async function readCopy(
  port: FormRecoveryPort,
  formContext: string,
  tabInstanceId: string,
): Promise<CopyRead> {
  try {
    const copy = await port.load(formContext, tabInstanceId);
    if (copy === null) return { kind: "absent" };
    return typeof copy === "object" && typeof copy.values === "object"
      ? { kind: "found", copy }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** `port.list`, typed: whatever stops the read is `unavailable`, never an empty list. */
export async function readCopies(
  port: FormRecoveryPort,
  formContext: string,
): Promise<CopiesRead> {
  try {
    const copies = await port.list(formContext);
    return Array.isArray(copies)
      ? { kind: "listed", copies }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

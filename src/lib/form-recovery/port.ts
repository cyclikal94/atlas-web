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

export interface FormRecoveryPort {
  save(snapshot: RecoverySnapshot): Promise<SaveResult>;
  load(
    formContext: string,
    tabInstanceId: string,
  ): Promise<RecoverySnapshot | null>;
  discard(formContext: string, tabInstanceId: string): Promise<DiscardResult>;
  /**
   * EVERY copy of the form that can still be restored, newest first (WEB-14a; revision 1, R5: complete, however many discarded or submitted
   * rows the form has, so a bound on one read never hides a copy): one per tab that saved one, so a page that returns after an update can
   * restore the newest and name the others. A copy that was discarded or submitted is not listed. A read that fails answers an empty list
   * (nothing is restored; nothing is lost either).
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

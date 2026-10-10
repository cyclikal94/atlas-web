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

export interface FormRecoveryPort {
  save(snapshot: RecoverySnapshot): Promise<SaveResult>;
  load(
    formContext: string,
    tabInstanceId: string,
  ): Promise<RecoverySnapshot | null>;
  discard(formContext: string, tabInstanceId: string): Promise<void>;
}

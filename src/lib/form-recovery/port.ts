/**
 * Form recovery around an app-update reload (Q4). WEB-07 owns the presentation and this contract; WEB-09a
 * implements the port over the form_recovery store, and WEB-14a supplies the update event and the reload.
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

export interface FormRecoveryPort {
  save(snapshot: RecoverySnapshot): Promise<"saved" | "failed">;
  load(
    formContext: string,
    tabInstanceId: string,
  ): Promise<RecoverySnapshot | null>;
  discard(formContext: string, tabInstanceId: string): Promise<void>;
}

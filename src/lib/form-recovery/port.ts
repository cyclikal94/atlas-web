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
  /** The admitted TEXT fields (text inputs, text areas, single selects), as typed: a value is never decoded as anything else. */
  values: Record<string, string>;
  savedAt: string;
  /**
   * WEB-14a revision 8 (R17): the admitted fields whose state is not one text (a checkbox's checked state, a radio group's choice, a
   * group of same-named checkboxes, a multiple select's selections). Version 1: `entries` maps each field name to its `ControlState`; a
   * field is in `values` or here, never both. The store keeps the record exactly as given (and digests it as content); only the form's
   * code reads it (`controls.ts`): a version or an entry it cannot read makes the copy UNREADABLE (offered as it is, never restored in
   * part, never chosen, never taken as a source). Absent: no such field (every copy written before revision 8).
   */
  controls?: Versioned;
  /**
   * Revision 8 (R16): the identity of THIS capture, written with it in the same transaction (the form session gives a fresh random token per
   * capture). A copy read back carries the capture its row holds now: what a conditional discard compares. Absent on a copy written before
   * revision 8, or by a caller that gives none (such a copy is removed by its key only, by the page that restored it).
   */
  capture?: string;
  /**
   * Revision 8 (R16): on an update hand-off, its LINEAGE: the copies its page owed the removal of when it wrote it (its own ordinary copy,
   * the same input, and every clean-up it had not finished), version 1: `entries` is a list of `CopyTarget`, each by exact key and capture.
   * Written by the page that knew them, never inferred by a reader; kept by the store exactly as given. The page that takes the hand-off
   * over removes them (each only if it still holds that capture) BEFORE the hand-off, so the hand-off stays the durable record of what is
   * owed until all of it is settled. Absent, or a record the form's code cannot read (`lineageOf`): nothing is known about its predecessors,
   * and nothing but the hand-off itself is ever removed for it.
   */
  lineage?: Versioned;
}

/** Revision 8: a record the store keeps exactly as it is given (R16 lineage, R17 control state); only the form's code reads its entries. */
export interface Versioned {
  version: number;
  entries: unknown;
}

/**
 * Revision 8 (R16): one copy to remove: where it is stored, its tab (or hand-off) identifier, and the capture it must still hold to be removed
 * (null: a copy written before captures had identities, removable by its exact key only, and only by the page that restored it).
 */
export interface CopyTarget {
  formContext: string;
  tabInstanceId: string;
  capture: string | null;
}

/**
 * Revision 8 (R17): the state of an admitted field that is not one text, version 1. `checkbox`: one checkbox, checked or not. `radio`: a
 * radio group (or one radio), the value of the checked one or null when none is. `checkboxes`: same-named checkboxes, the values of the
 * checked ones in the order of the page. `multiple`: a multiple select, the values of the selected options in option order (none: `[]`).
 */
export type ControlState =
  | { kind: "checkbox"; checked: boolean }
  | { kind: "radio"; value: string | null }
  | { kind: "checkboxes"; checked: readonly string[] }
  | { kind: "multiple"; selected: readonly string[] };

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
  /**
   * Revision 8 (R16): with `capture`, the copy is removed ONLY if it still holds that capture, decided in the same transaction as the removal
   * (and before anything of the row is changed): `discarded` then means that capture can no longer be restored (it was removed now, or was
   * already submitted or discarded, or its own page has since written a newer capture there, which is left as it is). Without `capture`,
   * whatever the row holds is removed (this page's own copy).
   */
  discard(
    formContext: string,
    tabInstanceId: string,
    capture?: string,
  ): Promise<DiscardResult>;
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

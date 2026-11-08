import {
  fieldOf,
  internalOf,
  isSensitiveField,
  isUnsupported,
  SensitiveFieldError,
  snapshotParts,
} from "./controls";
import type { RecoverableFieldSpec, RecoverySnapshot } from "./port";

/**
 * The recovery guard. Passwords and connection secrets are never saved (Q4, Q22): the recovery copy lives in browser storage that anyone
 * with the profile can read, and calendar connection details are online-only. A field is refused when it is type="password", has an
 * autocomplete token for a secret, or is marked data-atlas-sensitive (a group of controls when any member is). Development builds throw
 * so a mistake is found immediately; production builds drop the field.
 *
 * Revision 8 (R17): a field is read and written as its whole state (`controls.ts`): a checkbox's checked state, a radio group's choice,
 * same-named checkboxes, a multiple select's selections, never only `.value`.
 */
export { isSensitiveField, SensitiveFieldError };

export interface SnapshotInput {
  form: HTMLFormElement;
  formContext: string;
  tabInstanceId: string;
  allow: readonly RecoverableFieldSpec[];
  now?: Date;
  /** Development builds throw on a sensitive field; production drops it. Injectable for tests. */
  strict?: boolean;
}

/**
 * The state of each allow-listed field of `form` (`controls.ts`), and of nothing else; a sensitive field throws (`strict`) or is left out;
 * an unsupported one is left out (it can never be captured).
 */
export function readAllowed(
  form: HTMLFormElement,
  allow: readonly RecoverableFieldSpec[],
  strict: boolean,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const { name } of allow) {
    const field = fieldOf(form, name);
    if (field === null) continue;
    if (field === "sensitive") {
      if (strict) throw new SensitiveFieldError(name);
      continue;
    }
    const state = field.read();
    if (!isUnsupported(state)) values[name] = state;
  }
  return values;
}

/** Reads only the allow-listed fields from the form: the texts in `values`, the choices in `controls` (revision 8, R17). */
export function buildSnapshot({
  form,
  formContext,
  tabInstanceId,
  allow,
  now = new Date(),
  strict = import.meta.env.DEV,
}: SnapshotInput): RecoverySnapshot {
  return {
    formContext,
    tabInstanceId,
    ...snapshotParts(readAllowed(form, allow, strict)),
    savedAt: now.toISOString(),
  };
}

/**
 * Shows field states (as `controls.ts` holds them) in the allow-listed fields; never a sensitive field. Returns the fields whose state
 * this form cannot show (another kind of control now, an option or member gone): nothing of them was changed.
 */
export function restoreValues(
  form: HTMLFormElement,
  values: Readonly<Record<string, string>>,
  allow: readonly RecoverableFieldSpec[],
): string[] {
  const misfits: string[] = [];
  for (const { name } of allow) {
    const value = values[name];
    if (value === undefined) continue;
    const field = fieldOf(form, name);
    if (field === null || field === "sensitive") continue;
    if (!field.write(value)) misfits.push(name);
  }
  return misfits;
}

/** Restores saved values into the allow-listed fields. It never submits the form. Returns the fields it could not show (`restoreValues`). */
export function restoreSnapshot(
  form: HTMLFormElement,
  snapshot: RecoverySnapshot,
  allow: readonly RecoverableFieldSpec[],
): string[] {
  return restoreValues(form, internalOf(snapshot), allow);
}

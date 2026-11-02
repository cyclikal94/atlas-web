import type { ControlState, CopyTarget, RecoverySnapshot } from "./port";

/**
 * WEB-14a revision 8 (R17): whether a stored value is a version-1 `ControlState` (a stored record is checked before it is believed). A
 * module of its own so the data layer can read copies without loading the form's DOM code, and without growing the initial chunk.
 */
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function isControlState(value: unknown): value is ControlState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  switch (state.kind) {
    case "checkbox":
      return typeof state.checked === "boolean";
    case "radio":
      return state.value === null || typeof state.value === "string";
    case "checkboxes":
      return strings(state.checked);
    case "multiple":
      return strings(state.selected);
    default:
      return false;
  }
}

/** Revision 8 (R16): whether a stored value is a `CopyTarget`. */
const isTarget = (value: unknown): value is CopyTarget =>
  typeof (value as CopyTarget)?.formContext === "string" &&
  typeof (value as CopyTarget).tabInstanceId === "string" &&
  ((value as CopyTarget).capture === null ||
    typeof (value as CopyTarget).capture === "string");

/** The version of a copy's control state and lineage that this build writes and reads. */
export const VERSION = 1;

/** Entries as a stored record of this build's version. */
export const versioned = (entries: unknown) => ({ version: VERSION, entries });

/**
 * Revision 8 (R17): a copy's control state: none (`undefined`), the states by field name, or `null` when the copy holds control state this
 * build cannot read (another version, or an entry that is not a state): the copy is UNREADABLE.
 */
export function controlsOf(
  copy: Pick<RecoverySnapshot, "controls">,
): Record<string, ControlState> | null | undefined {
  const record = copy.controls;
  if (record === undefined) return undefined;
  const entries = record?.version === VERSION ? record.entries : null;
  return typeof entries === "object" &&
    entries !== null &&
    Object.values(entries).every(isControlState)
    ? (entries as Record<string, ControlState>)
    : null;
}

/** Revision 8 (R17): whether a copy holds control state this build cannot read (offered as it is; never restored, chosen or a source). */
export const unreadable = (copy: Pick<RecoverySnapshot, "controls">): boolean =>
  controlsOf(copy) === null;

/** Revision 8 (R16): a hand-off's lineage, or none when it has none or it cannot be read (nothing is then removed on its account). */
export function lineageOf(
  copy: Pick<RecoverySnapshot, "lineage">,
): readonly CopyTarget[] {
  const record = copy.lineage;
  return record?.version === VERSION &&
    Array.isArray(record.entries) &&
    record.entries.every(isTarget)
    ? record.entries
    : [];
}

import { controlsOf, isControlState, versioned } from "./control-state";
import type { ControlState, RecoverySnapshot } from "./port";

/**
 * WHAT A FIELD HOLDS, WHATEVER CONTROL SHOWS IT (WEB-14a revision 8; review of 13 October 2026, R17; design assessment C4/C5). Revision 7
 * read every admitted field as its `.value`: checking a checkbox changes `checked`, not `value`, and selecting a second option of a multiple
 * select can leave `value` at the first, so both edits compared equal to the field's initial state, the form looked clean, no copy was
 * written and the reload lost them. Every admitted field now has ONE canonical state, read, compared, retained, captured and restored through
 * this module only (the field ledger, the guard's capture and restore, edit events, defaults, tickets):
 *
 *  - TEXT (a text-like input, a text area, a single select): the text itself, exactly as before (so every comparison and every stored copy
 *    of a text field is unchanged). A text that happens to begin with the tag below is escaped, so no text can ever read as a state.
 *  - A CHOICE (`ControlState`): one checkbox (checked), a radio group or one radio (the checked value, or none), same-named checkboxes (the
 *    checked values in page order), a multiple select (the selected values in option order, `[]` for none). Encoded as the tag and the
 *    state's JSON with a fixed key order, so equal states are equal strings: the ledger, coverage and tickets keep comparing strings, and a
 *    string is immutable, so a capture or a ticket can never be changed after it is taken (no aliasing of an array).
 *  - UNSUPPORTED: an admitted name this module cannot represent unambiguously (a file input, a group mixing kinds or other controls, a group
 *    or select whose members repeat a value). Never captured. Untouched it needs nothing; once EDITED it is an obligation no copy can hold
 *    (`fields.resolved`), so the form stays dirty and an update reload stops with retry or an explicit discard: never a silent clean reload.
 *
 * A field with a sensitive member (`isSensitiveField`) is sensitive as a whole: nothing of it is read. In a stored copy, text fields stay in
 * `values` as literal text and choices go to `controls` (version 1); a stored text is never decoded as a choice (`internalOf`).
 */

/**
 * The guard. Passwords and connection secrets are never saved (Q4, Q22): the recovery copy lives in browser storage that anyone with the
 * profile can read, and calendar connection details are online-only. A field is refused when it is type="password", has an autocomplete
 * token for a secret, or is marked data-atlas-sensitive. (Moved here from `guard.ts` in revision 8, which re-exports it.)
 */
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

export function isSensitiveField(element: Element): boolean {
  if (
    element instanceof HTMLInputElement &&
    element.type.toLowerCase() === "password"
  )
    return true;
  if (element.hasAttribute("data-atlas-sensitive")) return true;
  const tokens = (element.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);
  return tokens.some((token) => SECRET_AUTOCOMPLETE.has(token));
}

export class SensitiveFieldError extends Error {
  constructor(readonly fieldName: string) {
    super(
      `Field "${fieldName}" is sensitive and can never be part of a recovery snapshot`,
    );
    this.name = "SensitiveFieldError";
  }
}

const TAG = "\u0001";
/** The state of an admitted field this module cannot represent: never captured, an obligation once edited. */
export const UNSUPPORTED = `${TAG}u`;

/** A text, as the field state holds it. */
export const encodeText = (text: string): string =>
  text.startsWith(TAG) ? `${TAG}t${text}` : text;

/** A choice, as the field state holds it (fixed key order: equal states are equal strings). */
export function encodeState(state: ControlState): string {
  switch (state.kind) {
    case "checkbox":
      return TAG + JSON.stringify({ kind: state.kind, checked: state.checked });
    case "radio":
      return TAG + JSON.stringify({ kind: state.kind, value: state.value });
    case "checkboxes":
      return TAG + JSON.stringify({ kind: state.kind, checked: state.checked });
    case "multiple":
      return (
        TAG + JSON.stringify({ kind: state.kind, selected: state.selected })
      );
  }
}

export type Decoded =
  | { kind: "text"; text: string }
  | { kind: "state"; state: ControlState }
  | { kind: "unsupported" };

/** What a field state holds. */
export function decode(encoded: string): Decoded {
  if (!encoded.startsWith(TAG)) return { kind: "text", text: encoded };
  if (encoded[1] === "t") return { kind: "text", text: encoded.slice(2) };
  if (encoded[1] === "{") {
    try {
      const state: unknown = JSON.parse(encoded.slice(1));
      if (isControlState(state)) return { kind: "state", state };
    } catch {
      // Not a state: unsupported below.
    }
  }
  return { kind: "unsupported" };
}

export const isUnsupported = (encoded: string): boolean =>
  decode(encoded).kind === "unsupported";

/** The parts of a stored copy for field states: the texts in `values`, the choices in `controls`; an unsupported state is never stored. */
export function snapshotParts(
  values: Readonly<Record<string, string>>,
): Pick<RecoverySnapshot, "values" | "controls"> {
  const texts: Record<string, string> = {};
  const controls: Record<string, ControlState> = {};
  for (const [name, encoded] of Object.entries(values)) {
    const decoded = decode(encoded);
    if (decoded.kind === "text") texts[name] = decoded.text;
    else if (decoded.kind === "state") controls[name] = decoded.state;
  }
  return Object.keys(controls).length > 0
    ? { values: texts, controls: versioned(controls) }
    : { values: texts };
}

/** The field states a stored copy holds: each text literally (never decoded as anything else), each choice encoded. */
export function internalOf(
  snapshot: Pick<RecoverySnapshot, "values" | "controls">,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, text] of Object.entries(snapshot.values))
    values[name] = encodeText(text);
  // A copy whose control state cannot be read is never restored (`unreadable`); were it asked, its choices are nothing it can show.
  for (const [name, state] of Object.entries(controlsOf(snapshot) ?? {}))
    values[name] = isControlState(state) ? encodeState(state) : UNSUPPORTED;
  return values;
}

/** One admitted field on a page: the element that identifies it, and its state read, written and as written in the markup (its default). */
export interface FieldAccess {
  /** The control, or a group's first member: the same element means the same field still shown. */
  readonly key: Element;
  /**
   * Which kind of state it holds (`text`, `checkbox`, `radio`, `checkboxes`, `multiple`, `unsupported`). The same element can change kind
   * in place (React keeps an input whose `type` changes): another kind is another field shown.
   */
  readonly kind: string;
  read(): string;
  initial(): string;
  /** Shows `encoded` in the field; false (nothing changed) when this field cannot show that state (another kind, an option gone). */
  write(encoded: string): boolean;
}

/** A field found on the page, a field with a sensitive member, or none. */
export type FieldLookup = FieldAccess | "sensitive" | null;

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const isControl = (element: unknown): element is Control =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement;

const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

const unsupported = (key: Element): FieldAccess => ({
  key,
  kind: "unsupported",
  read: () => UNSUPPORTED,
  initial: () => UNSUPPORTED,
  write: (encoded) => encoded === UNSUPPORTED,
});

/** Writes a choice into a field of `kind`, or nothing (false) when it is another kind or names a value the field does not have. */
const stateWriter =
  <K extends ControlState["kind"]>(
    kind: K,
    apply: (state: Extract<ControlState, { kind: K }>) => boolean,
  ) =>
  (encoded: string): boolean => {
    const decoded = decode(encoded);
    if (decoded.kind !== "state" || decoded.state.kind !== kind) return false;
    return apply(decoded.state as Extract<ControlState, { kind: K }>);
  };

function textField(control: Control): FieldAccess {
  return {
    key: control,
    kind: "text",
    read: () => encodeText(control.value),
    initial: () => {
      if (control instanceof HTMLSelectElement) {
        const options = [...control.options];
        return encodeText(
          (options.find((option) => option.defaultSelected) ?? options[0])
            ?.value ?? "",
        );
      }
      return encodeText(control.defaultValue);
    },
    write: (encoded) => {
      const decoded = decode(encoded);
      if (decoded.kind !== "text") return false;
      control.value = decoded.text;
      return true;
    },
  };
}

function multipleField(select: HTMLSelectElement): FieldAccess {
  const options = () => [...select.options];
  if (!unique(options().map((option) => option.value)))
    return unsupported(select);
  const state = (selected: (option: HTMLOptionElement) => boolean) =>
    encodeState({
      kind: "multiple",
      selected: options()
        .filter(selected)
        .map((option) => option.value),
    });
  return {
    key: select,
    kind: "multiple",
    read: () =>
      unique(options().map((option) => option.value))
        ? state((option) => option.selected)
        : UNSUPPORTED,
    initial: () => state((option) => option.defaultSelected),
    write: stateWriter("multiple", ({ selected }) => {
      const all = options();
      if (
        !unique(all.map((option) => option.value)) ||
        !selected.every((value) => all.some((option) => option.value === value))
      )
        return false;
      for (const option of all)
        option.selected = selected.includes(option.value);
      return true;
    }),
  };
}

function radioField(members: readonly HTMLInputElement[]): FieldAccess {
  const values = members.map((member) => member.value);
  if (!unique(values)) return unsupported(members[0] as Element);
  const pick = (checked: (member: HTMLInputElement) => boolean) =>
    encodeState({
      kind: "radio",
      value: members.find(checked)?.value ?? null,
    });
  return {
    key: members[0] as Element,
    kind: "radio",
    read: () => pick((member) => member.checked),
    initial: () => pick((member) => member.defaultChecked),
    write: stateWriter("radio", ({ value }) => {
      if (value !== null && !values.includes(value)) return false;
      for (const member of members) member.checked = member.value === value;
      return true;
    }),
  };
}

function checkboxesField(members: readonly HTMLInputElement[]): FieldAccess {
  const values = members.map((member) => member.value);
  if (!unique(values)) return unsupported(members[0] as Element);
  const of = (checked: (member: HTMLInputElement) => boolean) =>
    encodeState({
      kind: "checkboxes",
      checked: members.filter(checked).map((member) => member.value),
    });
  return {
    key: members[0] as Element,
    kind: "checkboxes",
    read: () => of((member) => member.checked),
    initial: () => of((member) => member.defaultChecked),
    write: stateWriter("checkboxes", ({ checked }) => {
      if (!checked.every((value) => values.includes(value))) return false;
      // In page order, each once: anything else is not a state these members can show.
      if (
        !sameList(
          checked,
          values.filter((value) => checked.includes(value)),
        )
      )
        return false;
      for (const member of members)
        member.checked = checked.includes(member.value);
      return true;
    }),
  };
}

function checkboxField(box: HTMLInputElement): FieldAccess {
  return {
    key: box,
    kind: "checkbox",
    read: () => encodeState({ kind: "checkbox", checked: box.checked }),
    initial: () =>
      encodeState({ kind: "checkbox", checked: box.defaultChecked }),
    write: stateWriter("checkbox", ({ checked }) => {
      box.checked = checked;
      return true;
    }),
  };
}

const inputType = (element: Element): string | null =>
  element instanceof HTMLInputElement ? element.type.toLowerCase() : null;

/**
 * The admitted field `name` of `form`: what `form.elements.namedItem(name)` names (one control, or every control of that name), as one
 * field. Null: nothing of that name, or something that is not a control (a fieldset, a button, an output: nothing a person types into, as
 * before). `sensitive`: one of its members is sensitive, so nothing of it is read.
 */
export function fieldOf(form: HTMLFormElement, name: string): FieldLookup {
  const item = form.elements.namedItem(name);
  if (item === null) return null;
  const members: Element[] =
    item instanceof Element
      ? [item]
      : Array.from(item as ArrayLike<Element>).filter(
          (member): member is Element => member instanceof Element,
        );
  if (members.length === 0) return null;
  if (members.some((member) => isSensitiveField(member))) return "sensitive";
  const [first] = members as [Element, ...Element[]];
  if (members.length === 1) {
    if (!isControl(first)) return null;
    const type = inputType(first);
    if (type === "checkbox") return checkboxField(first as HTMLInputElement);
    if (type === "radio") return radioField([first as HTMLInputElement]);
    if (type === "file") return unsupported(first);
    if (first instanceof HTMLSelectElement && first.multiple)
      return multipleField(first);
    return textField(first);
  }
  const types = members.map(inputType);
  if (types.every((type) => type === "radio"))
    return radioField(members as HTMLInputElement[]);
  if (types.every((type) => type === "checkbox"))
    return checkboxesField(members as HTMLInputElement[]);
  // Several controls of one name of another kind (two text inputs, a radio beside a checkbox): no single state represents them.
  return members.some(isControl) ? unsupported(first) : null;
}

/** The field `name` of `form` when it can be read (not sensitive), or null. */
export const accessOf = (
  form: HTMLFormElement,
  name: string,
): FieldAccess | null => {
  const found = fieldOf(form, name);
  return found === "sensitive" ? null : found;
};

import { isSensitiveField, restoreSnapshot } from "./guard";
import type { RecoverableFieldSpec, RecoverySnapshot } from "./port";

/**
 * WHAT A FORM HOLDS, FIELD BY FIELD (WEB-14a revision 4; review of 11 October 2026, findings R3 and R11; design assessment of 11 October
 * 2026, C1-C3; PRODUCT-DECISIONS-20261011 item 2). Revision 3 compared the values a form shows NOW with a remembered state and took
 * equality as permission to forget: an edit back to the text of an earlier successful submission looked clean (R3), and a field removed
 * from the page in the same render as its admission left nothing to compare (R11). This module keeps the facts that projection lost.
 *
 *  - THE LEDGER (`ledger`). The latest value of every field the form has admitted, kept in memory whether or not the field is still on the
 *    page or still admitted. It is read from the page while the field is admitted and shown (at every input event, before a handler can
 *    remove the field, at every read, and while the hook renders), so a field that disappears keeps what it held. Content of a field that is
 *    NOT admitted is never read; a sensitive field (`guard.ts`) is never read at all.
 *  - PRESENCE (`present`). The admitted fields shown now, with the element each value is read from. A field that leaves the page keeps its
 *    value (RETAINED); a field that comes back (the same element or a new one) is given its retained value back when it shows what it
 *    started with (untouched); when the person has already typed something else into it, their new text wins and the retained value stays
 *    owed (`shadowed`). Presence is noticed at every read and, for the restore to show at once, by a MutationObserver.
 *  - EDIT PROVENANCE (`input`, `edited`). Every input/change/reset event, and every restore the hook makes from a copy, moves the input
 *    revision and records which field it changed (all fields when the event names none). Coming back into a field, or a schema change, is
 *    not an edit.
 *  - COVERAGE (`covered`). A field's value is RESOLVED, needing no copy, when the next page would show it anyway (its initial value, which
 *    the form starts from again) or when a terminal act covers exactly that value and the field has not been edited since: a successful
 *    submission covers what it sent (and, by the owner's decision, the hidden values of the state it saved), an explicit discard what the
 *    form showed then. An edit after the act ends the coverage of THAT field, even when the person types the same text again (R3).
 *  - DEBT. A retained value (a field no longer shown or no longer admitted) or a shadowed one that is not resolved cannot be written into a
 *    copy (it is not admitted, or not shown to be checked) and must not be dropped: the form counts as dirty and its saves fail, so an
 *    update reload stops and offers retry or an explicit discard (Q4), until the field shows it again, the form is submitted or discarded.
 *
 * Memory only: nothing here is written anywhere.
 */
export type Values = Record<string, string>;

export interface FieldState {
  /** The admitted fields, normalised (each name once, in name order): what is read and captured NOW. */
  allow: readonly RecoverableFieldSpec[];
  /** `schemaKey(allow)`. */
  schema: string;
  /** The form element the fields are read from, or null while no mount shows them. */
  form: () => HTMLFormElement | null;
  /** The latest admitted value of every field seen while admitted (shown or not, admitted or not now). */
  ledger: Values;
  /** The admitted fields shown now, each with the element its value is read from. */
  present: Map<string, Element>;
  /** What each field starts from when the form is shown again (the mount's values; a field first shown later: its default). */
  initial: Values;
  /** The input revision: moved by every edit. */
  input: number;
  /** The revision of the last edit of each field. */
  edited: Map<string, number>;
  /** The revision of the last edit that changed every field (a reset; an event that names no field). */
  editedAll: number;
  /** The value a terminal act covered for each field, and the revision it covered. */
  covered: Map<string, { value: string; at: number }>;
  /** Retained values a field that came back no longer shows, because the person typed something else into it. */
  shadowed: Values;
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** The admitted, non-sensitive control named `name` in `form`, or null. */
export function controlOf(form: HTMLFormElement, name: string): Control | null {
  const element = form.elements.namedItem(name);
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
  )
    return null;
  return isSensitiveField(element) ? null : element;
}

/** The value a control starts from as written (its default). */
export function defaultOf(control: Control): string {
  if (control instanceof HTMLSelectElement) {
    const options = [...control.options];
    return (
      (options.find((option) => option.defaultSelected) ?? options[0])?.value ??
      ""
    );
  }
  return control.defaultValue;
}

/** An allow-list in its normal form (each name once, in name order): reordering the same fields is not a change. */
export const normaliseAllow = (
  allow: readonly RecoverableFieldSpec[],
): readonly RecoverableFieldSpec[] =>
  [...new Set(allow.map((spec) => spec.name))].sort().map((name) => ({ name }));

/** The identity of an allow-list's schema: the encoded sorted names (the empty schema is `[]`, a schema like any other). */
export const schemaKey = (allow: readonly RecoverableFieldSpec[]): string =>
  JSON.stringify(normaliseAllow(allow).map((spec) => spec.name));

/** The allow-list a schema key names. */
export const allowOf = (schema: string): readonly RecoverableFieldSpec[] =>
  (JSON.parse(schema) as string[]).map((name) => ({ name }));

/** The fields of a form as a mount first shows it: every admitted field shown is read, and starts from what it shows. */
export function openFields(
  form: () => HTMLFormElement | null,
  allow: readonly RecoverableFieldSpec[],
): FieldState {
  const fields: FieldState = {
    allow: normaliseAllow(allow),
    schema: schemaKey(allow),
    form,
    ledger: {},
    present: new Map(),
    initial: {},
    input: 0,
    edited: new Map(),
    editedAll: 0,
    covered: new Map(),
    shadowed: {},
  };
  const element = form();
  if (element)
    for (const { name } of fields.allow) {
      const control = controlOf(element, name);
      if (!control) continue;
      fields.present.set(name, control);
      fields.ledger[name] = control.value;
      fields.initial[name] = control.value;
    }
  return fields;
}

const admitted = (fields: FieldState): Set<string> =>
  new Set(fields.allow.map((spec) => spec.name));

/**
 * Brings the ledger up to date with the page: each admitted field still shown is read; a field shown again (or anew) takes its retained
 * value back when it is untouched (it shows what it starts from), or keeps the person's new text while the retained value stays owed; a
 * field no longer shown keeps its value. Never reads a field that is not admitted. Idempotent.
 */
export function sync(fields: FieldState): void {
  const form = fields.form();
  if (!form) return;
  const names = admitted(fields);
  for (const name of [...fields.present.keys()])
    if (!names.has(name)) fields.present.delete(name);
  for (const name of names) {
    const control = controlOf(form, name);
    if (!control) {
      fields.present.delete(name);
      continue;
    }
    const shown = control.value;
    if (fields.present.get(name) === control) {
      fields.ledger[name] = shown;
      continue;
    }
    // Shown again, or for the first time.
    fields.present.set(name, control);
    if (fields.initial[name] === undefined)
      fields.initial[name] = defaultOf(control);
    const retained = fields.ledger[name];
    if (retained === undefined || retained === shown) {
      fields.ledger[name] = shown;
      continue;
    }
    if (shown === defaultOf(control) || shown === fields.initial[name]) {
      // Untouched: the retained value comes back into the field (the same value: not an edit).
      control.value = retained;
      continue;
    }
    // The person typed something else into it: that is the field's value now, and the retained one is still owed.
    if (!resolved(fields, name, retained)) fields.shadowed[name] = retained;
    fields.ledger[name] = shown;
  }
}

/**
 * Reads the admitted fields already followed from the page, and nothing else (no field is restored or newly followed): safe while the hook
 * renders, before a commit removes a field whose value was changed without an event.
 */
export function refresh(fields: FieldState): void {
  const form = fields.form();
  if (!form) return;
  for (const [name, element] of fields.present) {
    const control = controlOf(form, name);
    if (control === element) fields.ledger[name] = control.value;
  }
}

/** The input changed: the fields named (every field when none is named) were edited at the new revision. */
export function noteInput(fields: FieldState, names?: Iterable<string>): void {
  fields.input += 1;
  if (names === undefined) {
    fields.editedAll = fields.input;
    return;
  }
  for (const name of names) fields.edited.set(name, fields.input);
}

/** The revision of the last edit of `name` (0: never edited). */
export const lastEdit = (fields: FieldState, name: string): number =>
  Math.max(fields.edited.get(name) ?? 0, fields.editedAll);

/**
 * Whether `value` of `name` needs no copy: it is what the form starts from again, or a terminal act covered exactly it and the field has
 * not been edited since (revision 4, R3: an edit after the act is the person's, whatever text it leaves).
 */
export function resolved(
  fields: FieldState,
  name: string,
  value: string,
): boolean {
  if (value === (fields.initial[name] ?? "")) return true;
  const cover = fields.covered.get(name);
  return (
    cover !== undefined &&
    cover.value === value &&
    lastEdit(fields, name) <= cover.at
  );
}

/** The values a copy can hold NOW: the admitted fields shown (or, while no mount shows the form, the ones its last mount showed). */
export function capturable(fields: FieldState): Values {
  sync(fields);
  const names = admitted(fields);
  const values: Values = {};
  for (const name of fields.present.keys()) {
    const value = fields.ledger[name];
    if (names.has(name) && value !== undefined) values[name] = value;
  }
  return values;
}

/** Everything the form holds: the ledger (shown, retained and not admitted any more). */
export function held(fields: FieldState): Values {
  sync(fields);
  return { ...fields.ledger };
}

/** The values the form holds that no copy can hold now: retained (not shown or not admitted) and shadowed. */
export function retainedOf(fields: FieldState): [string, string][] {
  const shown = capturable(fields);
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(fields.ledger))
    if (!(name in shown)) out.push([name, value]);
  for (const [name, value] of Object.entries(fields.shadowed))
    out.push([name, value]);
  return out;
}

/** Retained input that is not resolved: the form cannot be saved, and must not be taken for clean (revision 4, R11; D1). */
export const hasDebt = (fields: FieldState): boolean =>
  retainedOf(fields).some(([name, value]) => !resolved(fields, name, value));

/** Whether every value of `values` is resolved (the next page needs no copy of them). */
export const allResolved = (fields: FieldState, values: Values): boolean =>
  Object.entries(values).every(([name, value]) =>
    resolved(fields, name, value),
  );

/**
 * Whether restoring `copy` would give back what the form holds: each field shown, from the copy or (a field it lacks) from where the form
 * starts; and no field the copy holds would bring back another value than the form holds for it.
 */
export function copyMatches(
  fields: FieldState,
  copy: Values,
  shown: Values,
): boolean {
  for (const [name, value] of Object.entries(shown))
    if ((copy[name] ?? fields.initial[name] ?? "") !== value) return false;
  for (const [name, value] of Object.entries(copy))
    if (
      !(name in shown) &&
      value !== (fields.ledger[name] ?? fields.initial[name] ?? "")
    )
      return false;
  return true;
}

/** Whether two records of everything the form held are the same (a field one lacks counts as its initial value). */
export function sameHeld(fields: FieldState, a: Values, b: Values): boolean {
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (
      (a[name] ?? fields.initial[name] ?? "") !==
      (b[name] ?? fields.initial[name] ?? "")
    )
      return false;
  return true;
}

/** A terminal act covers `values` at revision `at` (an older act never replaces a newer one's coverage). */
export function cover(fields: FieldState, values: Values, at: number): void {
  for (const [name, value] of Object.entries(values)) {
    const known = fields.covered.get(name);
    if (known === undefined || known.at <= at)
      fields.covered.set(name, { value, at });
  }
}

/**
 * A submission sent at revision `at` succeeded although the form changed since: it covers the fields that were NOT edited after it and
 * still hold what it sent, and nothing else (revision 4, R3: never an edit made after the send).
 */
export function coverUnedited(
  fields: FieldState,
  sent: Values,
  at: number,
): void {
  sync(fields);
  const unedited: Values = {};
  for (const [name, value] of Object.entries(sent))
    if (lastEdit(fields, name) <= at && fields.ledger[name] === value)
      unedited[name] = value;
  cover(fields, unedited, at);
}

/** An explicit discard: the retained and shadowed values are dropped with the rest of the input (the person's act). */
export function dropRetained(fields: FieldState): void {
  const shown = capturable(fields);
  fields.ledger = { ...shown };
  fields.shadowed = {};
}

/**
 * The admitted schema becomes `allow` (revision 4, R11), the empty schema included. A field no longer admitted keeps its last value in the
 * ledger, never read again while excluded; a field admitted again (or anew) is followed from now on, and takes its retained value back when
 * it is untouched. Returns whether the schema changed (reordering the same fields is no change).
 */
export function setSchema(
  fields: FieldState,
  allow: readonly RecoverableFieldSpec[],
): boolean {
  const key = schemaKey(allow);
  if (key === fields.schema) return false;
  fields.allow = normaliseAllow(allow);
  fields.schema = key;
  const names = admitted(fields);
  for (const name of [...fields.present.keys()])
    if (!names.has(name)) fields.present.delete(name);
  sync(fields);
  return true;
}

/**
 * Puts a copy into the form (a restore after a reload, or an alternative the person chose): the fields shown take its values, an admitted
 * field not shown keeps its value in the ledger (it comes back when the field is shown), and every field it names counts as edited.
 */
export function applySnapshot(
  fields: FieldState,
  form: HTMLFormElement,
  snapshot: RecoverySnapshot,
): void {
  sync(fields);
  restoreSnapshot(form, snapshot, fields.allow);
  const names: string[] = [];
  for (const { name } of fields.allow) {
    const value = snapshot.values[name];
    if (value === undefined) continue;
    names.push(name);
    if (!fields.present.has(name) && controlOf(form, name) === null)
      fields.ledger[name] = value;
  }
  noteInput(fields, names);
  sync(fields);
}

/**
 * A new mount shows the fields a session already holds (a remount: another page's boot remounts the protected tree, F-1). `into` is the
 * session's (no mount shows it), `from` the new mount's, read since it mounted. The new mount's schema is the schema. A field the new mount
 * shows untouched (what it started from) takes the session's value back; one the person has typed into in the new mount keeps their text,
 * and the session's value stays owed; a field the new mount does not show keeps the session's value (retained). What the new mount held
 * before it had a session (its own retained values, its coverage of fields not changed since) joins the session's.
 */
export function adopt(
  into: FieldState,
  from: FieldState,
  form: () => HTMLFormElement | null,
): void {
  into.allow = from.allow;
  into.schema = from.schema;
  into.form = form;
  sync(from);
  const element = form();
  const changed: string[] = [];
  const covered: Values = {};
  for (const [name, mine] of Object.entries(from.ledger)) {
    if (into.initial[name] === undefined && from.initial[name] !== undefined)
      into.initial[name] = from.initial[name];
    const theirs = into.ledger[name];
    const cover = from.covered.get(name);
    if (cover && cover.value === mine && lastEdit(from, name) <= cover.at)
      covered[name] = mine;
    if (theirs === undefined) {
      into.ledger[name] = mine;
      if (lastEdit(from, name) > 0) changed.push(name);
      continue;
    }
    if (mine === theirs) continue;
    const shown = from.present.get(name);
    if (mine === from.initial[name] && shown) {
      // Untouched in the new mount: the session's value comes back into it.
      if (element && controlOf(element, name) === shown)
        (shown as Control).value = theirs;
      continue;
    }
    if (mine === from.initial[name]) continue;
    if (!resolved(into, name, theirs)) into.shadowed[name] = theirs;
    into.ledger[name] = mine;
    changed.push(name);
  }
  for (const [name, value] of Object.entries(from.shadowed))
    into.shadowed[name] ??= value;
  into.present = new Map(from.present);
  if (changed.length > 0) noteInput(into, changed);
  cover(into, covered, into.input);
  sync(into);
}

const INPUT_EVENTS = ["input", "change", "reset"] as const;

/**
 * Follows the fields of `element` while a mount shows them: every input/change/reset event is an edit of the field it names (every field
 * for a reset, or an event that names none) and is read at once, in the capture phase, before any handler of the page can remove the
 * field; a reset is read again after the browser has reset the form (its event comes first); a field added or removed is noticed at once.
 * Returns the stop.
 */
export function watch(
  fields: FieldState,
  element: HTMLFormElement,
): () => void {
  let stopped = false;
  const onInput = (event: Event): void => {
    const target = event.target;
    const name =
      event.type !== "reset" &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement) &&
      target.name !== ""
        ? target.name
        : null;
    noteInput(fields, name === null ? undefined : [name]);
    sync(fields);
    if (event.type === "reset")
      setTimeout(() => {
        if (!stopped) sync(fields);
      }, 0);
  };
  for (const type of INPUT_EVENTS)
    element.addEventListener(type, onInput, true);
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          if (!stopped) sync(fields);
        });
  observer?.observe(element, { childList: true, subtree: true });
  return () => {
    stopped = true;
    observer?.disconnect();
    for (const type of INPUT_EVENTS)
      element.removeEventListener(type, onInput, true);
  };
}

import {
  accessOf,
  type FieldAccess,
  fieldOf,
  internalOf,
  isUnsupported,
  membersOf,
  OPAQUE,
  ownerOf,
  type Shape,
  sameShape,
} from "./controls";
import { restoreValues } from "./guard";
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
 *    owed (`owed`). Presence is noticed at every read and, for the restore to show at once, by a MutationObserver.
 *  - EDIT PROVENANCE (`input`, `edited`). Every input/reset event, every change event that reports a value no input event reported, and
 *    every restore the hook makes from a copy, moves the input revision and records which field it changed (all fields when the event names
 *    none). Coming back into a field, or a schema change, is not an edit. A change event that only COMMITS the value the field's last edit
 *    event already reported is not one either (revision 5): every engine fires it when focus leaves an edited field, and Chromium also when a
 *    focused edited field is removed, possibly AFTER a submission covered that very value (it made the submitted text look unfinished).
 *    Provenance survives a remount: what the person typed into a new mount, even the same text as before, is newer than everything the
 *    session knew (`adopt`, revision 5, R3).
 *  - COVERAGE (`covered`). A field's value is RESOLVED, needing no copy, when the next page would show it anyway (its initial value, which
 *    the form starts from again) or when a terminal act covers exactly that value and the field has not been edited since: a successful
 *    submission covers what it sent (and, by the owner's decision, the hidden values of the state it saved), an explicit discard what the
 *    form showed then. An edit after the act ends the coverage of THAT field, even when the person types the same text again (R3).
 *  - DEBT. A retained value (a field no longer shown or no longer admitted) or an owed one that is not resolved cannot be written into a
 *    copy (it is not admitted, or not shown to be checked) and must not be dropped: the form counts as dirty and its saves fail, so an
 *    update reload stops and offers retry or an explicit discard (Q4), until the field shows it again, the form is submitted or discarded.
 *
 * WHAT A VALUE IS (revision 8, R17). Every value here is a field's whole STATE as `controls.ts` encodes it (the text of a text field,
 * unchanged; a checkbox's checked state, a radio group's choice, same-named checkboxes, a multiple select's selections), never only the
 * control's `.value`; a field this build cannot represent reads `UNSUPPORTED`, is never captured, and is an obligation once edited
 * (`resolved`). Strings: equal states compare equal, and nothing taken (a capture, a ticket) can be changed afterwards.
 *
 * WHAT A FIELD CAN SHOW (revision 9; review of 14 October 2026, R17; design assessment of 14 October 2026, C1-C4). Revision 8 took the
 * page's state as the field's value whenever the same element showed the same kind of state. But a select whose selected option is removed,
 * or a radio group losing its checked member, keeps both, and the browser then shows another state (the first option, no choice) with no
 * event: the ledger took that for the person's value, the choice was gone, the form looked clean and the update reloaded without it. And a
 * restore into a field that could not show a copy's choice (an option gone) reported success while the browser showed nothing, so the next
 * save certified the empty state and removed the copies that held the choice. Now:
 *
 *  - Every field shown has a SHAPE (`controls.ts`: its kind, its options' or members' values and elements, its input type and sanitising
 *    attributes). One rule (`reconcile`) brings a field's ledger up to date, from every reader (a sync, an event, the observer, a capture, a
 *    dirty check, an adoption): the same element in the same shape is read as it is; another shape is never read over what the field held.
 *  - A value the field held that its new shape cannot show is OWED (`owed`), never overwritten: the form is dirty, its saves fail (an
 *    update reload stops with retry or an explicit discard). While the field is not edited after that, the value comes back as soon as the
 *    field can show it exactly; an edit of the field keeps the person's new value and the owed one stays owed. A field showing an owed value
 *    again holds it (no longer owed). Several owed values of one field are kept, none replacing another.
 *  - Every write is exact (`FieldAccess.write`): a restore the field cannot show changes nothing and stays owed (`applySnapshot` returns it).
 *
 * NOTHING IS TAKEN FOR COMPLETE THAT IS NOT (revision 10; review of 14 October 2026, R17 and R11; design assessment of 14 October 2026,
 * RC1/RC2, I1-I5, C1-C4). Revision 9 still projected two kinds of input onto something smaller and took the projection as the whole:
 *
 *  - A number field showing `1e` (what the person is still typing) has the value "": it read as an empty field, so the form looked clean, or
 *    an earlier copy was discarded as if the person had cleared it. Such a field now reads OPAQUE (`controls.ts`): input no copy can hold, an
 *    obligation from the moment it is seen (even before any edit event), resolved only by a terminal act that covered it and was not
 *    followed by another edit of the field. It is never written over. Only an edit of that same field (completing it, clearing it, a
 *    reset) ends it; when it goes otherwise (a script, a render, the field removed or replaced) it stays owed: what it held is gone from the
 *    page, so the form cannot be saved without loss and an update reload stops with retry or an explicit discard (Q4).
 *  - A copy restored into a form that does not admit or show some of its fields kept only the fields admitted: the rest were neither
 *    restored nor owed, the restore was reported complete, and the next save cleaned the copy up. Now EVERY value of a copy becomes the
 *    form's (`applySnapshot`): a field not admitted or not shown keeps it in the ledger (never read from or written to the page), it is
 *    reported incomplete and is an obligation until the field shows it again or a terminal act resolves it. Where a field starts from is
 *    known only for a field the form has shown: an unknown start is never taken for "" (`resolved`).
 *  - What a copy holds is accounted for POSITIVELY before anything replaces or removes it (`accounts`): each of its values is in the capture
 *    replacing it (the field's state now, which the person may have changed since: their progress) or held and resolved.
 *
 * Memory only: nothing here is written anywhere.
 */
export type Values = Record<string, string>;

/** Revision 9 (R17): a value the form holds that its field does not show now, and must not lose. */
export interface Owed {
  readonly value: string;
  /** The revision of the edit that produced it, where known: a successful submission sent no earlier, that sent it, covers it. */
  readonly made?: number;
  /**
   * A value the field could not SHOW (its shape changed, a restore it could not take): the field's last edit when it became owed. While the
   * field is not edited after it, the value comes back into the field as soon as the field can show it. Absent: typed over by the person,
   * never put back over what they typed.
   */
  readonly returns?: number;
}

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
  /** Revision 9 (R17): the shape of each present field (`controls.ts`): the same element in another shape is shown anew. */
  shapes: Map<string, Shape>;
  /** Revision 9: the input revision at which each present field was last read into the ledger (an edit after it is the person's). */
  seen: Map<string, number>;
  /** What each field starts from when the form is shown again (the mount's values; a field first shown later: its default). */
  initial: Values;
  /** The input revision: moved by every edit. */
  input: number;
  /** The revision of the last edit of each field. */
  edited: Map<string, number>;
  /** The revision of the last edit that changed every field (a reset; an event that names no field). */
  editedAll: number;
  /** The value each field showed at its last edit event (revision 5): a change event that reports it again commits that edit, nothing more. */
  evented: Map<string, string>;
  /** The value a terminal act covered for each field, and the revision it covered. */
  covered: Map<string, { value: string; at: number }>;
  /**
   * Revision 9 (R17): values a field shown no longer shows (the person typed something else into it, or it cannot show them), each kept
   * (`Owed`) until the field holds it again, it comes back, a successful submission covers it, or the form is discarded. Revision 8 kept
   * one per field (`shadowed`), which a second such value replaced.
   */
  owed: Map<string, Owed[]>;
  /**
   * Revision 9 (R17): what each field shows instead of a value it owes because it could not show it (the browser's state: the first option,
   * no choice, an empty text), until the person edits the field or an owed value comes back. Never input: not owed when it goes in turn.
   */
  fallback: Map<string, string>;
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
    shapes: new Map(),
    seen: new Map(),
    initial: {},
    input: 0,
    edited: new Map(),
    editedAll: 0,
    evented: new Map(),
    covered: new Map(),
    owed: new Map(),
    fallback: new Map(),
  };
  const element = form();
  if (element)
    for (const { name } of fields.allow) {
      const field = accessOf(element, name);
      if (!field) continue;
      fields.present.set(name, field.key);
      fields.shapes.set(name, field.shape);
      fields.seen.set(name, 0);
      const shown = field.read();
      fields.ledger[name] = shown;
      // Revision 10 (R17): a native editing state already there is input, never where the form starts from (the next page shows the
      // field's default).
      fields.initial[name] = shown === OPAQUE ? field.initial() : shown;
    }
  return fields;
}

const admitted = (fields: FieldState): Set<string> =>
  new Set(fields.allow.map((spec) => spec.name));

/** Revision 9 (R17): `name` owes `entry.value` (unless it is resolved, or already owed: then the newer record of it stands). */
export function owe(fields: FieldState, name: string, entry: Owed): void {
  if (resolved(fields, name, entry.value)) return;
  const others = (fields.owed.get(name) ?? []).filter(
    (known) => known.value !== entry.value,
  );
  fields.owed.set(name, [...others, entry]);
}

/**
 * Revision 10 (R17; C2): `shown`, read from the very field `name` followed (the same element, the same shape), is what it holds now. A
 * native editing state the field no longer shows WITHOUT an edit of it since it was last read (a script set its value, a render replaced
 * it) was not ended by the person: what it held is gone from the page, and it stays owed.
 */
function take(
  fields: FieldState,
  name: string,
  shown: string,
  edited: boolean,
): void {
  if (fields.ledger[name] === OPAQUE && shown !== OPAQUE && !edited)
    owe(fields, name, { value: OPAQUE });
  fields.ledger[name] = shown;
}

/** Revision 9: the values `name` owes, minus those `keep` refuses. */
function settleOwed(
  fields: FieldState,
  name: string,
  keep: (entry: Owed) => boolean,
): void {
  const left = (fields.owed.get(name) ?? []).filter(keep);
  if (left.length > 0) fields.owed.set(name, left);
  else fields.owed.delete(name);
}

/**
 * Revision 9 (R17; C1, C3): THE rule by which a shown field's state enters the ledger, from every reader. The same element in the same
 * shape: what it shows is the field's value. Shown again, anew, or in another shape: what it shows is NOT taken over what the field held.
 * The held value comes back into the field when the field is untouched (another shape: not edited since it was last read; a field shown
 * again: it shows what it starts from) and can show it exactly; otherwise the field's state is what it shows and the held value is owed
 * (to come back later when the person did not type over it). Then an owed value the field can show again, not edited since, comes back,
 * and an owed value the field holds is no longer owed. Never changes the input revision (a transition is no edit). Idempotent.
 */
function reconcile(fields: FieldState, name: string, field: FieldAccess): void {
  const shown = field.read();
  const before = fields.present.get(name);
  const same =
    before === field.key && sameShape(fields.shapes.get(name), field.shape);
  const edited = lastEdit(fields, name) > (fields.seen.get(name) ?? 0);
  fields.present.set(name, field.key);
  fields.shapes.set(name, field.shape);
  fields.seen.set(name, fields.input);
  // Edited since it was last read: what it shows is the person's.
  if (edited) fields.fallback.delete(name);
  if (same) take(fields, name, shown, edited);
  else {
    // Shown again, for the first time, or in another shape (revision 8: another kind; revision 9: another option or member, another type).
    if (fields.initial[name] === undefined)
      fields.initial[name] = field.initial();
    const held = fields.ledger[name];
    if (held === undefined || held === shown) fields.ledger[name] = shown;
    else {
      const untouched =
        before === field.key
          ? !edited
          : shown === field.initial() || shown === fields.initial[name];
      // Untouched: the held value comes back into the field (the same value: not an edit), when the field can show it exactly.
      if (!(untouched && field.write(held))) {
        // The person typed something else into it, or it cannot show the held value: what it shows is the field's state now, and the held
        // value is owed (back as soon as it can be shown, unless the person typed over it).
        const at = lastEdit(fields, name);
        if (!untouched) owe(fields, name, { value: held });
        else {
          // The state the field showed in place of an owed value is not the person's input: it is never owed itself.
          if (fields.fallback.get(name) !== held)
            owe(fields, name, { value: held, made: at, returns: at });
          fields.fallback.set(name, shown);
        }
        fields.ledger[name] = shown;
      }
    }
  }
  // A value owed that the field can show again, and the person has not edited the field since: it comes back (the newest first), whatever
  // brought the field back to it (another shape, a mount of its own, a restore).
  const back = [...(fields.owed.get(name) ?? [])]
    .reverse()
    .find(
      (entry) =>
        entry.returns !== undefined && lastEdit(fields, name) <= entry.returns,
    );
  if (
    back !== undefined &&
    back.value !== fields.ledger[name] &&
    field.write(back.value)
  ) {
    fields.ledger[name] = back.value;
    fields.fallback.delete(name);
  }
  const holds = fields.ledger[name];
  // Revision 10 (R17): an owed native editing state is never settled by another one shown later (what the first held is gone).
  settleOwed(
    fields,
    name,
    (entry) => entry.value !== holds || entry.value === OPAQUE,
  );
}

/**
 * Revision 12 (found qualifying R19; the R18 family): whether `name` was last read from an element outside `form` (a control associated with
 * it by `form=`, or a group or select with such a part).
 */
const readOutside = (
  fields: FieldState,
  form: HTMLFormElement,
  name: string,
): boolean => {
  const key = fields.present.get(name);
  if (key === undefined) return false;
  return [key, ...(fields.shapes.get(name)?.parts ?? [])].some(
    (element) => !form.contains(element),
  );
};

/**
 * Brings the ledger up to date with the page (`reconcile`, each admitted field shown); a field no longer shown keeps its value. Never reads a
 * field that is not admitted. Idempotent.
 *
 * Revision 12: a form OUT OF THE PAGE (its mount removed, the page around it with it: a route left, a session gate unmounting the shell)
 * shows what it showed when it went. Its descendants are still read from it; a control associated with it from outside (`form=`) is no
 * longer associated (that needs both in the page), so a field last read from one is not read again and keeps what it showed then, instead of
 * counting as removed and owing its input (which no save could then take). A member removed while the form was in the page was already
 * read as removed by then (every input event and DOM change reads the form).
 */
export function sync(fields: FieldState): void {
  const form = fields.form();
  if (!form) return;
  const names = admitted(fields);
  for (const name of [...fields.present.keys()])
    if (!names.has(name)) fields.present.delete(name);
  const away = !form.isConnected;
  for (const name of names) {
    if (away && readOutside(fields, form, name)) continue;
    const field = accessOf(form, name);
    if (!field) {
      fields.present.delete(name);
      continue;
    }
    reconcile(fields, name, field);
  }
}

/**
 * Reads the admitted fields already followed from the page, and nothing else (no field is restored or newly followed, nothing is written to
 * the page): safe while the hook renders, before a commit removes a field whose value was changed without an event. A field in another
 * shape is left to the next `sync` (revision 9, R17: its state then is not the field's value).
 */
export function refresh(fields: FieldState): void {
  const form = fields.form();
  if (!form) return;
  for (const [name, element] of fields.present) {
    const field = accessOf(form, name);
    if (
      field?.key === element &&
      sameShape(fields.shapes.get(name), field.shape)
    )
      take(
        fields,
        name,
        field.read(),
        lastEdit(fields, name) > (fields.seen.get(name) ?? 0),
      );
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
  const edit = lastEdit(fields, name);
  const cover = fields.covered.get(name);
  const covered = cover !== undefined && edit <= cover.at;
  // Revision 10 (R17; C2): a native editing state is the person's input whatever its edit count (it may be there before the form first
  // reads it): only a terminal act that covered it, with no edit of the field since, resolves it.
  if (value === OPAQUE) return covered && cover.value === OPAQUE;
  // Revision 8 (R17): a field whose state cannot be represented needs nothing only while it has not been edited since it was shown (or since
  // a terminal act covered it): an edit of it is input no copy can hold.
  if (isUnsupported(value)) return edit === 0 || covered;
  // Revision 10 (R11; I2): where a field starts from is known only for a field the form has shown; an unknown start is never "".
  const start = fields.initial[name];
  return (
    (start !== undefined && value === start) ||
    (covered && cover.value === value)
  );
}

/**
 * Revision 10: what the admitted fields shown hold NOW (or, while no mount shows the form, the ones its last mount showed), each as its
 * state, an unsupported state and a native editing state included: what an explicit discard leaves, and covers.
 */
export function shownOf(fields: FieldState): Values {
  sync(fields);
  const names = admitted(fields);
  const values: Values = {};
  for (const name of fields.present.keys()) {
    const value = fields.ledger[name];
    if (names.has(name) && value !== undefined) values[name] = value;
  }
  return values;
}

/**
 * The values a copy can hold NOW: the admitted fields shown (`shownOf`). Revision 8 (R17): an unsupported state is never captured (it
 * stays the form's: retained, `retainedOf`); revision 10: nor a native editing state (`OPAQUE`, decoded as unsupported).
 */
export const capturable = (fields: FieldState): Values =>
  Object.fromEntries(
    Object.entries(shownOf(fields)).filter(
      ([, value]) => !isUnsupported(value),
    ),
  );

/** Everything the form holds: the ledger (shown, retained and not admitted any more). */
export function held(fields: FieldState): Values {
  sync(fields);
  return { ...fields.ledger };
}

/** The values the form holds that no copy can hold now: retained (not shown or not admitted) and owed (revision 9: every one). */
export function retainedOf(fields: FieldState): [string, string][] {
  const shown = capturable(fields);
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(fields.ledger))
    if (!(name in shown)) out.push([name, value]);
  for (const [name, entries] of fields.owed)
    for (const entry of entries) out.push([name, entry.value]);
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
 * Revision 10 (R11; design assessment C4, I5): whether the form accounts for every value of `copy` (a copy it was restored from): the field
 * is in `captured` (what replaces the copy holds the field's state now, which the person may have changed since: their progress), or the
 * form holds a value for it that needs no copy. Positive: a value the form does not hold at all is never accounted for. Equal text, the
 * order of operations or the identity of a capture are no substitute: a copy not accounted for is neither replaced nor cleaned up.
 */
export const accounts = (
  fields: FieldState,
  copy: Values,
  captured: Values,
): boolean =>
  Object.keys(copy).every((name) => {
    const holds = fields.ledger[name];
    return (
      name in captured || (holds !== undefined && resolved(fields, name, holds))
    );
  });

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
 * still hold what it sent, and nothing else (revision 4, R3: never an edit made after the send). An owed value it sent, produced by an
 * edit no later than the send (revision 5: a remount typed over it), is what it submitted: no longer owed.
 */
export function coverUnedited(
  fields: FieldState,
  sent: Values,
  at: number,
): void {
  sync(fields);
  const unedited: Values = {};
  for (const [name, value] of Object.entries(sent)) {
    if (lastEdit(fields, name) <= at && fields.ledger[name] === value)
      unedited[name] = value;
    settleOwed(
      fields,
      name,
      (entry) =>
        !(
          entry.value === value &&
          entry.made !== undefined &&
          entry.made <= at
        ),
    );
  }
  cover(fields, unedited, at);
}

/** An explicit discard: the retained and owed values are dropped with the rest of the input (the person's act). */
export function dropRetained(fields: FieldState): void {
  // What the fields shown hold stays theirs (revision 10: their whole state, `shownOf`; the act covers it).
  fields.ledger = shownOf(fields);
  fields.owed = new Map();
  fields.fallback = new Map();
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
 * Puts a copy into the form (a restore after a reload, or an alternative the person chose): the fields shown take its values, and every
 * field it names counts as edited. Revision 10 (R11; C3): EVERY value of the copy becomes the form's, whatever the schema admits now: a
 * field not admitted, or admitted but not shown, keeps the copy's value in the ledger (never read from or written to the page; it comes
 * back when the field is admitted and shown), as an obligation until then. Returns the fields of the copy the form does not show
 * (revision 9, R17, C4: a field shown that could not take its value, owed; revision 10: a field not admitted or not shown, retained, whose
 * value needs a copy): the restore is incomplete.
 */
export function applySnapshot(
  fields: FieldState,
  form: HTMLFormElement,
  snapshot: RecoverySnapshot,
): string[] {
  sync(fields);
  const values = internalOf(snapshot);
  const names = Object.keys(values);
  const admits = admitted(fields);
  const unshown = (name: string): boolean =>
    !admits.has(name) || !fields.present.has(name);
  // Revision 8 (R17): a field that cannot show the copy's state (another kind of control now, an option gone) keeps its own; the copy's
  // state stays owed, never dropped. Revision 9: every write is exact, so a field that could not show it is known (no false success),
  // and the value comes back once the field can show it (unless the person types over it first).
  const misfits = new Set(restoreValues(form, values, fields.allow));
  for (const name of names)
    if (unshown(name)) fields.ledger[name] = values[name] as string;
  noteInput(fields, names);
  sync(fields);
  const incomplete: string[] = [];
  for (const name of names) {
    const value = values[name] as string;
    if (misfits.has(name)) {
      if (fields.ledger[name] === value) continue;
      owe(fields, name, { value, returns: lastEdit(fields, name) });
    } else if (!unshown(name) || resolved(fields, name, value)) continue;
    incomplete.push(name);
  }
  return incomplete;
}

/**
 * A new mount shows the fields a session already holds (a remount: another page's boot remounts the protected tree, F-1). `into` is the
 * session's (no mount shows it), `from` the new mount's, read since it mounted. The new mount's schema is the schema. A field the new mount
 * shows UNTOUCHED (no edit event since it mounted, and it shows what it started from) takes the session's value back; a field the person has
 * EDITED in the new mount keeps what they typed, whatever text that is (the same as the session's, the text of an earlier submission, or
 * back to where it started), and the session's value stays owed if it is not resolved; a field the new mount does not show keeps the
 * session's value (retained). What the new mount held before it had a session (its own retained values, its coverage of fields not changed
 * since) joins the session's.
 *
 * PROVENANCE IS TRANSLATED, NOT COMPARED (revision 5, R3; design assessment of 11 October 2026, C2). Revision 4 skipped every field whose
 * text equalled the session's, so an edit typed in a mount that had no database yet (late binding) to the text of an earlier successful
 * submission inherited that submission's coverage, looked clean, and was gone after the reload. The new mount's revisions now map into the
 * session's by one monotone translation, `base + r` with `base` the session's revision at adoption: every edit, coverage stamp and ticket of
 * the new mount keeps its order, and every edit of the new mount is newer than anything the session knew, so no earlier act covers it.
 * A value changed in the new mount without any event is an edit of its own, after all of them. Returns the translation (the hook maps the
 * tickets the mount took before it had a session through it).
 */
export function adopt(
  into: FieldState,
  from: FieldState,
  form: () => HTMLFormElement | null,
): (revision: number) => number {
  into.allow = from.allow;
  into.schema = from.schema;
  into.form = form;
  sync(from);
  const element = form();
  const base = into.input;
  const translate = (revision: number): number => base + revision;
  const edits = new Map<string, number>();
  const unstamped: string[] = [];
  const covered: [string, string, number][] = [];
  const unshown: [string, string][] = [];
  for (const [name, mine] of Object.entries(from.ledger)) {
    if (into.initial[name] === undefined && from.initial[name] !== undefined)
      into.initial[name] = from.initial[name];
    const theirs = into.ledger[name];
    const edit = lastEdit(from, name);
    const cover = from.covered.get(name);
    if (cover && cover.value === mine && edit <= cover.at)
      covered.push([name, mine, translate(cover.at)]);
    if (edit > 0) {
      // Edited in the new mount: the person's value, newer than the session's (even the same text).
      if (theirs !== undefined && theirs !== mine)
        owe(into, name, { value: theirs, made: lastEdit(into, name) });
      into.ledger[name] = mine;
      edits.set(name, translate(edit));
      continue;
    }
    if (theirs === undefined) {
      into.ledger[name] = mine;
      continue;
    }
    if (mine === theirs) continue;
    const shown = from.present.get(name);
    if (mine === from.initial[name]) {
      // Untouched in the new mount: the session's value comes back into it (a field it does not show keeps it, retained). Revision 8 (R17):
      // a field that cannot show it (another kind of control; revision 9: another option or member) keeps its own, and the session's value
      // stays owed, to come back when the field can show it (below, once the revisions are the session's).
      const field = shown && element ? accessOf(element, name) : null;
      if (!field || field.key !== shown || field.write(theirs)) continue;
      unshown.push([name, theirs]);
      into.ledger[name] = mine;
      continue;
    }
    // Changed in the new mount without an event: the new text is the field's, an edit after every other; the session's value stays owed.
    owe(into, name, { value: theirs, made: lastEdit(into, name) });
    into.ledger[name] = mine;
    unstamped.push(name);
  }
  // What the new mount owed is owed by the session (revision 9: every value, none replacing another), in the session's revisions.
  for (const [name, entries] of from.owed)
    for (const entry of entries)
      owe(into, name, {
        value: entry.value,
        ...(entry.made === undefined ? {} : { made: translate(entry.made) }),
        ...(entry.returns === undefined
          ? {}
          : { returns: translate(entry.returns) }),
      });
  for (const [name, value] of from.evented) into.evented.set(name, value);
  for (const [name, value] of from.fallback) into.fallback.set(name, value);
  into.present = new Map(from.present);
  into.shapes = new Map(from.shapes);
  into.seen = new Map(
    [...from.seen].map(([name, at]) => [name, translate(at)]),
  );
  into.input = translate(from.input);
  for (const [name, at] of edits) into.edited.set(name, at);
  if (unstamped.length > 0) noteInput(into, unstamped);
  for (const [name, value, at] of covered) cover(into, { [name]: value }, at);
  for (const [name, value] of unshown)
    owe(into, name, { value, returns: lastEdit(into, name) });
  sync(into);
  return translate;
}

const INPUT_EVENTS = ["input", "change", "reset"] as const;

/** The attributes that change a field's shape (an option's or member's value, a type, a name) or which form a control belongs to. */
const SHAPING = [
  "name",
  "type",
  "value",
  "multiple",
  "min",
  "max",
  "step",
  "form",
  "id",
];
/** What a structural change can concern: a control, an option, a form (or something holding one). */
const CONCERNING = "input,select,textarea,option,form";

/**
 * Follows the fields of `element` while a mount shows them: every input/reset event is an edit of the field it names (every field for a
 * reset, or an event that names none) and is read at once, in the capture phase, before any handler of the page can remove the field; a
 * change event is an edit only when the field shows another value than at its last edit event (revision 5: otherwise it only commits that
 * edit); a reset is read again after the browser has reset the form (its event comes first: revision 10, what each field shows then is
 * the reset's edit); a field added or removed is noticed at once. Returns the stop.
 *
 * THE WHOLE MEMBERSHIP, NOT THE SUBTREE (revision 11; review of 14 October 2026, R18; design assessment of 14 October 2026, C1-C2, I1-I3).
 * Revision 10 listened on the form and observed its subtree, yet read every member `form.elements` names, a control outside the form that
 * belongs to it by its `form` attribute included: what the person typed into such a control never reached the ledger, so removing it left
 * the form clean (an update reloaded without it), and an edit away and back left an older submission's ticket looking current (its copy was
 * discarded). Now events are taken in the capture phase at the ROOT the form is in (the document; also the form itself, should it not be in
 * one: each event once), before any target or application handler, and each is an edit of this form only when it is: a control is this
 * form's when the form owns it (`ownerOf`), wherever it is, and its fields are those whose members (`membersOf`, by name or id) include it;
 * a control another form owns is never this form's input, even inside it; a reset is this form's own. Structural and association changes
 * are observed at the root too (only records that can concern a control or a form are followed). The observer is never relied on alone:
 * every read reconciles first (`sync`).
 */
export function watch(
  fields: FieldState,
  element: HTMLFormElement,
): () => void {
  let stopped = false;
  /** An event reaches both the root and the form: taken once. */
  const taken = new WeakSet<Event>();
  const onInput = (event: Event): void => {
    if (stopped || taken.has(event)) return;
    taken.add(event);
    bind();
    const target = event.target;
    const control = event.type === "reset" ? null : ownerOf(target);
    if (event.type === "reset" ? target !== element : control !== element) {
      // Not this form's control: an edit of this form only when it is nothing a form owns, inside the form (as before revision 11).
      if (
        control !== null ||
        !(target instanceof Node && element.contains(target))
      )
        return;
    }
    // The admitted fields the target is a member of. Only an admitted, non-sensitive field's state is ever read (any other field's event is
    // an edit, as before). Revision 8 (R17): the FIELD's whole state (a checkbox's checked state, every member of a group).
    const names =
      control === element
        ? fields.allow
            .map((spec) => spec.name)
            .filter((name) =>
              membersOf(element, name).includes(target as Element),
            )
        : [];
    const named = control === element ? (target as HTMLInputElement).name : "";
    if (names.length === 0 && named === "") {
      fields.evented.clear();
      noteInput(fields);
    } else if (names.length === 0) noteInput(fields, [named]);
    else {
      const edits: string[] = [];
      for (const name of names) {
        const field = fieldOf(element, name);
        if (field === null || field === "sensitive") {
          edits.push(name);
          continue;
        }
        const state = field.read();
        if (event.type !== "change" || fields.evented.get(name) !== state) {
          fields.evented.set(name, state);
          edits.push(name);
        }
      }
      if (edits.length > 0) noteInput(fields, edits);
    }
    sync(fields);
    if (event.type === "reset") {
      // Revision 10 (R17; C2): the browser resets the fields AFTER this event, so what each shows then is the reset's (an edit not read
      // yet), even where it ends a native editing state.
      for (const name of fields.seen.keys())
        fields.seen.set(name, fields.input - 1);
      setTimeout(() => {
        if (!stopped) sync(fields);
      }, 0);
    }
  };
  const concerns = (node: Node): boolean =>
    node === element ||
    element.contains(node) ||
    (node instanceof Element &&
      (node.matches(CONCERNING) || node.querySelector(CONCERNING) !== null));
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          if (stopped) return;
          bind();
          if (
            records.some(
              (record) =>
                concerns(record.target) ||
                [...record.addedNodes, ...record.removedNodes].some(concerns),
            )
          )
            sync(fields);
        });
  let root: Node | null = null;
  /** Listens and observes at the root the form is in now (the form itself: listened to and observed whatever its root). */
  const bind = (): void => {
    const now = element.getRootNode();
    if (now === root) return;
    if (root !== null && root !== element)
      for (const type of INPUT_EVENTS)
        root.removeEventListener(type, onInput, true);
    root = now;
    if (root !== element)
      for (const type of INPUT_EVENTS)
        root.addEventListener(type, onInput, true);
    observer?.disconnect();
    observer?.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: SHAPING,
    });
  };
  for (const type of INPUT_EVENTS)
    element.addEventListener(type, onInput, true);
  bind();
  return () => {
    stopped = true;
    observer?.disconnect();
    for (const type of INPUT_EVENTS) {
      element.removeEventListener(type, onInput, true);
      root?.removeEventListener(type, onInput, true);
    }
  };
}

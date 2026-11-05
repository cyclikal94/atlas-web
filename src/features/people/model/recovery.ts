import { canonicalBody } from "./attempt";
import {
  type FieldFormState,
  newFieldForm,
  reduceFieldForm,
  type ValueSlots,
} from "./field-form";
import { type NewPersonState, newPersonForm } from "./person-form";
import { FIELD_KINDS, type FieldKind } from "./values";

/**
 * The Q4 form-recovery CONTEXTS of the people forms (WEB-11a §3.2 `recovery.ts`), for WEB-14a's capture. PURE.
 *
 * WEB-11a does not capture anything itself (WEB-14a owns the app-update capture and `src/lib/form-recovery`); it states, per form, the
 * context key and the fields a capture would hold, and how a captured value is read back. A restore only FILLS the form: it never
 * submits, and a value that does not read back exactly is not restored. Nothing here is a secret (no password, no connection secret).
 *
 *  - the field editor: `people-field:<personId>:<fieldId>` or `people-field:<personId>:new:<formId>`;
 *  - the rename form: `people-rename:<personId>`;
 *  - the new-person form: `people-new:<formId>`.
 */
export const fieldContext = (
  personId: string,
  target: { fieldId: string } | { formId: string },
): string =>
  "fieldId" in target
    ? `people-field:${personId}:${target.fieldId}`
    : `people-field:${personId}:new:${target.formId}`;
export const renameContext = (personId: string): string =>
  `people-rename:${personId}`;
export const newPersonContext = (formId: string): string =>
  `people-new:${formId}`;

/** What a capture of the field editor holds: one canonical JSON text of every slot (the hidden ones too), the name and the audience. */
export function fieldRecoveryFields(
  state: FieldFormState,
): Record<string, string> {
  const { revision: _revision, ...kept } = state;
  return { form: canonicalBody(kept) };
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** `value`'s own texts named `keys`, or null when one is missing or not a text. */
function texts<K extends string>(
  value: unknown,
  keys: readonly K[],
): Record<K, string> | null {
  if (!isObject(value)) return null;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const text = value[key];
    if (typeof text !== "string") return null;
    out[key] = text;
  }
  return out;
}
/** Every entry of the list `value` read by `entry`, or null when it is not a list or one entry is not one (review 8, observation 3). */
function entries<T>(
  value: unknown,
  entry: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const read = entry(item);
    if (read === null) return null;
    out.push(read);
  }
  return out;
}
const flagged = <K extends string, F extends string>(
  item: unknown,
  keys: readonly K[],
  flag: F,
): (Record<K, string> & Record<F, boolean>) | null => {
  const read = texts(item, keys);
  if (read === null || !isObject(item) || typeof item[flag] !== "boolean")
    return null;
  return { ...read, [flag]: item[flag] } as Record<K, string> &
    Record<F, boolean>;
};

/**
 * Each slot read back with the SHAPE of its input (review 8, observation 3): texts are texts, the boolean is a boolean or null, and a list
 * holds only its slot's entries. Only the shape is checked: an unfinished entry (a half-typed amount or date) is kept exactly as typed,
 * never validated as a value, trimmed or coerced. Built afresh from what was checked, never cast from the capture.
 */
const SLOT_READERS: {
  [K in FieldKind]: (slot: unknown) => ValueSlots[K] | null;
} = {
  text: (slot) => texts(slot, ["text"]),
  quantity: (slot) => texts(slot, ["amount", "unit"]),
  date: (slot) => texts(slot, ["day", "month", "year"]),
  url: (slot) => texts(slot, ["url"]),
  boolean: (slot) =>
    isObject(slot) && (typeof slot.value === "boolean" || slot.value === null)
      ? { value: slot.value }
      : null,
  choices: (slot) => {
    if (!isObject(slot)) return null;
    const options = entries(slot.options, (item) =>
      flagged(item, ["key", "label"], "selected"),
    );
    return options === null ? null : { options };
  },
  checklist: (slot) => {
    if (!isObject(slot)) return null;
    const items = entries(slot.items, (item) =>
      flagged(item, ["id", "label"], "checked"),
    );
    return items === null ? null : { items };
  },
};

/** A captured field editor read back, or null when it is not one (nothing is restored then). */
export function restoreFieldForm(
  fields: Record<string, string>,
): FieldFormState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fields.form ?? "");
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.name !== "string") return null;
  if (!FIELD_KINDS.includes(parsed.kind as FieldKind)) return null;
  if (!isObject(parsed.slots)) return null;
  const empty = newFieldForm();
  const slots = { ...empty.slots };
  // Every slot, the hidden ones too: the capture holds them all, and a malformed one is not restored by halves.
  for (const kind of FIELD_KINDS) {
    const slot = SLOT_READERS[kind](parsed.slots[kind]);
    if (slot === null) return null;
    slots[kind] = slot as never;
  }
  const audience = parsed.audience;
  if (!["defaults", "only_you", "home", "custom"].includes(audience as string))
    return null;
  return reduceFieldForm(empty, {
    type: "replace",
    state: {
      name: parsed.name,
      kind: parsed.kind as FieldKind,
      slots,
      audience: audience as FieldFormState["audience"],
      revision: 0,
    },
  });
}

export function personRecoveryFields(
  state: NewPersonState,
): Record<string, string> {
  return {
    name: state.name,
    sharing: state.sharing,
    note_open: state.noteOpen ? "1" : "0",
    note: state.note,
  };
}

export function restorePersonForm(
  fields: Record<string, string>,
): NewPersonState | null {
  const { name, sharing, note_open: open, note } = fields;
  if (name === undefined || note === undefined) return null;
  if (sharing !== "defaults" && sharing !== "only_you") return null;
  if (open !== "0" && open !== "1") return null;
  return {
    ...newPersonForm(),
    name,
    sharing,
    noteOpen: open === "1",
    note,
  };
}

export const renameRecoveryFields = (name: string): Record<string, string> => ({
  name,
});
export const restoreRename = (fields: Record<string, string>): string | null =>
  typeof fields.name === "string" ? fields.name : null;

/**
 * WEB-14a (review of 2 November 2026, F-INT-PEOPLE-Q4): the CODECS the people forms' recoverable models use (`form-recovery.ts`), built on
 * the serialisers above. Each copy is ONE explicitly versioned canonical text (`v`), holding the form's captured fields and what its input
 * was composed against, so a restored save keeps the form's own guards: the rename's and the field editor's binding (`snapshot`, the
 * versions the form opened on), where the field edit began (`origin`) and the id a new field is created under (`newFieldId`: a retried
 * create of the same input is the same field, never a second one). Never an attempt, a request id or a secret. A text of another version,
 * or one whose part does not read back with its shape, is not this build's (null: offered, never restored in part).
 *
 * The forms' contexts are stable for the form and its target: a new person's and a new field's form id is `dialog` (page memory keeps one
 * such form at a time, `new-person` and `field:<person>:new`), so the page after a reload finds the copy.
 */
export const NEW_FORM_ID = "dialog";

/** The binding an edit was composed against (`model/snapshot.ts` `EditSnapshot`). */
export interface RecoveredSnapshot {
  version: number;
  policyVersion: number | null;
  expectedBase: number;
  latestLocalId: string | null;
  latestDigest: string | null;
}
/** Where a field edit began (the field editor's `EditOrigin`). */
export type RecoveredOrigin =
  | { kind: "new" }
  | { kind: "field" }
  | { kind: "create"; localId: string | null; digest: string | null };

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const textOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function readSnapshot(value: unknown): RecoveredSnapshot | null {
  if (!isObject(value)) return null;
  const { version, policyVersion, expectedBase, latestLocalId, latestDigest } =
    value;
  if (!isInteger(version) || !isInteger(expectedBase)) return null;
  if (policyVersion !== null && !isInteger(policyVersion)) return null;
  if (!textOrNull(latestLocalId) || !textOrNull(latestDigest)) return null;
  return { version, policyVersion, expectedBase, latestLocalId, latestDigest };
}

function readOrigin(value: unknown): RecoveredOrigin | null {
  if (!isObject(value)) return null;
  if (value.kind === "new" || value.kind === "field")
    return { kind: value.kind };
  if (
    value.kind === "create" &&
    textOrNull(value.localId) &&
    textOrNull(value.digest)
  )
    return { kind: "create", localId: value.localId, digest: value.digest };
  return null;
}

/** A versioned copy's parts (null: not version 1, or its fields are not texts). */
function envelope(
  text: string,
): { fields: Record<string, string>; rest: Obj } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.v !== 1 || !isObject(parsed.fields))
    return null;
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.fields)) {
    if (typeof value !== "string") return null;
    fields[name] = value;
  }
  return { fields, rest: parsed };
}

export const personCodec = {
  context: newPersonContext(NEW_FORM_ID),
  encode: (state: NewPersonState): string =>
    canonicalBody({ v: 1, fields: personRecoveryFields(state) }),
  decode: (text: string): NewPersonState | null => {
    const read = envelope(text);
    return read === null ? null : restorePersonForm(read.fields);
  },
};

export interface RenameInput {
  name: string;
  snapshot: RecoveredSnapshot;
}

export const renameCodec = (personId: string) => ({
  context: renameContext(personId),
  encode: (value: RenameInput): string =>
    canonicalBody({
      v: 1,
      fields: renameRecoveryFields(value.name),
      snapshot: value.snapshot,
    }),
  decode: (text: string): RenameInput | null => {
    const read = envelope(text);
    if (read === null) return null;
    const name = restoreRename(read.fields);
    const snapshot = readSnapshot(read.rest.snapshot);
    return name === null || snapshot === null ? null : { name, snapshot };
  },
});

export interface FieldInput {
  form: FieldFormState;
  touched: boolean;
  snapshot: RecoveredSnapshot | null;
  origin: RecoveredOrigin;
  newFieldId: string;
}

export const fieldCodec = (personId: string, fieldId: string | null) => ({
  context: fieldContext(
    personId,
    fieldId === null ? { formId: NEW_FORM_ID } : { fieldId },
  ),
  encode: (value: FieldInput): string =>
    canonicalBody({
      v: 1,
      fields: fieldRecoveryFields(value.form),
      touched: value.touched,
      snapshot: value.snapshot,
      origin: value.origin,
      newFieldId: value.newFieldId,
    }),
  decode: (text: string): FieldInput | null => {
    const read = envelope(text);
    if (read === null) return null;
    const form = restoreFieldForm(read.fields);
    const { touched, snapshot, origin, newFieldId } = read.rest;
    const binding = snapshot === null ? null : readSnapshot(snapshot);
    const began = readOrigin(origin);
    if (
      form === null ||
      typeof touched !== "boolean" ||
      (snapshot !== null && binding === null) ||
      began === null ||
      typeof newFieldId !== "string" ||
      newFieldId === ""
    )
      return null;
    return { form, touched, snapshot: binding, origin: began, newFieldId };
  },
});

// ---- WEB-11b (D-11b-13) ------------------------------------------------------------------------------------------------------------
/**
 * The New request panel's two forms and the merge dialog's chosen name, for WEB-14a's capture. Each form is its own context, captured
 * whether shown or hidden (PRODUCT-DECISIONS-20261011 item 2: a hidden form's values are kept); a restore only fills the form and never
 * sends. Ids are read back only as UUIDs and names only as texts; anything else restores nothing.
 *
 *  - Ask to link: `people-request-link:<formId>` — the person (`{id, label}`) and the recipient (`{id, username}`), either may be unset;
 *  - Ask to merge: `people-request-merge:<formId>` — the two people picked;
 *  - the merge's name: `people-merge-name:<sourceId>:<targetId>` — which of the two labels was chosen.
 */
export const requestLinkContext = (formId: string): string =>
  `people-request-link:${formId}`;
export const requestMergeContext = (formId: string): string =>
  `people-request-merge:${formId}`;
export const mergeNameContext = (sourceId: string, targetId: string): string =>
  `people-merge-name:${sourceId}:${targetId}`;

type Picked = { id: string; label: string } | null;
type Recipient = { id: string; username: string } | null;
export interface RequestLinkForm {
  person: Picked;
  recipient: Recipient;
}
export interface RequestMergeForm {
  first: Picked;
  second: Picked;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function pickedOf<K extends string>(
  value: unknown,
  name: K,
): ({ id: string } & Record<K, string>) | null | undefined {
  if (value === null) return null;
  const read = texts(value, ["id", name]);
  if (
    read === null ||
    !UUID.test(read.id) ||
    Object.keys(value as Obj).length !== 2
  )
    return undefined;
  return read as { id: string } & Record<K, string>;
}

export const requestLinkFields = (
  form: RequestLinkForm,
): Record<string, string> => ({
  form: canonicalBody({ person: form.person, recipient: form.recipient }),
});
export const requestMergeFields = (
  form: RequestMergeForm,
): Record<string, string> => ({
  form: canonicalBody({ first: form.first, second: form.second }),
});
export const mergeNameFields = (
  choice: "source" | "target",
): Record<string, string> => ({ name: choice });

function parsed(
  fields: Record<string, string>,
  keys: readonly string[],
): Obj | null {
  const text = fields.form;
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isObject(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key))
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A captured Ask to link read back, or null (nothing is restored). */
export function restoreRequestLink(
  fields: Record<string, string>,
): RequestLinkForm | null {
  const value = parsed(fields, ["person", "recipient"]);
  if (value === null) return null;
  const person = pickedOf(value.person, "label");
  const recipient = pickedOf(value.recipient, "username");
  if (person === undefined || recipient === undefined) return null;
  return { person, recipient };
}

/** A captured Ask to merge read back, or null (nothing is restored). */
export function restoreRequestMerge(
  fields: Record<string, string>,
): RequestMergeForm | null {
  const value = parsed(fields, ["first", "second"]);
  if (value === null) return null;
  const first = pickedOf(value.first, "label");
  const second = pickedOf(value.second, "label");
  if (first === undefined || second === undefined) return null;
  return { first, second };
}

/** A captured merge name read back (which label was chosen), or null. */
export function restoreMergeName(
  fields: Record<string, string>,
): "source" | "target" | null {
  return fields.name === "source" || fields.name === "target"
    ? fields.name
    : null;
}

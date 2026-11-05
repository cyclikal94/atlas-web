import {
  type FieldKind,
  type FieldValue,
  labelProblem,
  valueProblem,
} from "./values";

/**
 * The field editor's state (WF-PEOPLE-03). PURE: a reducer and the function that says what a save would send.
 *
 * Conditionally hidden values (PRODUCT-DECISIONS-20261011 item 2): every type keeps ITS OWN value slot for the whole editing session, so
 * switching the type away and back restores what was typed. A save sends only the ACTIVE type's value, and says nothing about the slots
 * it leaves out. A refused or uncertain save keeps everything. A save that succeeds never consumes an edit made after it was asked for:
 * every change raises `revision`, the save carries the revision it was built from (its ticket), and only a success for the CURRENT
 * revision may end the session.
 *
 * The slots hold what the inputs hold (texts), so an unfinished entry (a half-typed amount) is kept as typed and refused with a reason,
 * never silently changed.
 */
export interface ChoiceOption {
  /** A key of this editing session only (never sent). */
  key: string;
  label: string;
  selected: boolean;
}
export interface ChecklistItemSlot {
  /** The item's UUID: sent, and kept across edits so a checked item stays the same item. */
  id: string;
  label: string;
  checked: boolean;
}

export interface ValueSlots {
  text: { text: string };
  quantity: { amount: string; unit: string };
  date: { day: string; month: string; year: string };
  url: { url: string };
  boolean: { value: boolean | null };
  choices: { options: ChoiceOption[] };
  checklist: { items: ChecklistItemSlot[] };
}

/** What a new field's audience is (D-11a-7); an existing field's is changed through the policy (`existing`). */
export type NewAudience = "defaults" | "only_you" | "home";
export type ExistingAudience = "only_you" | "home" | "custom";

export interface FieldFormState {
  name: string;
  kind: FieldKind;
  slots: ValueSlots;
  audience: NewAudience | ExistingAudience;
  /** Raised by every change: what a save's ticket is compared with. */
  revision: number;
}

export const emptySlots = (): ValueSlots => ({
  text: { text: "" },
  quantity: { amount: "", unit: "" },
  date: { day: "", month: "", year: "" },
  url: { url: "" },
  boolean: { value: null },
  choices: { options: [] },
  checklist: { items: [] },
});

export function newFieldForm(): FieldFormState {
  return {
    name: "",
    kind: "text",
    slots: emptySlots(),
    audience: "defaults",
    revision: 0,
  };
}

/**
 * The state of an existing field: its name, its type and its value in that type's slot (`keyOf` names each option for this session).
 * The other slots start empty. `audience` is the classified current audience, or `only_you` until the policy has been read.
 */
export function fromField(
  input: { label: string; value: FieldValue; audience?: ExistingAudience },
  keyOf: () => string,
): FieldFormState {
  const slots = emptySlots();
  const value = input.value;
  switch (value.kind) {
    case "text":
      slots.text = { text: value.text };
      break;
    case "quantity":
      slots.quantity = { amount: value.amount, unit: value.unit };
      break;
    case "date":
      slots.date = {
        day: String(value.day),
        month: String(value.month),
        year:
          value.year === undefined || value.year === null
            ? ""
            : String(value.year),
      };
      break;
    case "url":
      slots.url = { url: value.url };
      break;
    case "boolean":
      slots.boolean = { value: value.value };
      break;
    case "choices":
      slots.choices = {
        options: value.options.map((label) => ({
          key: keyOf(),
          label,
          selected: value.selected.includes(label),
        })),
      };
      break;
    case "checklist":
      slots.checklist = {
        items: value.items.map((item) => ({
          id: item.id,
          label: item.label,
          checked: value.checked.includes(item.id),
        })),
      };
      break;
  }
  return {
    name: input.label,
    kind: value.kind,
    slots,
    audience: input.audience ?? "only_you",
    revision: 0,
  };
}

export type FieldFormAction =
  | { type: "name"; value: string }
  | { type: "kind"; value: FieldKind }
  | { type: "audience"; value: NewAudience | ExistingAudience }
  | {
      type: "slot";
      kind: FieldKind;
      value: ValueSlots[FieldKind];
    }
  | { type: "replace"; state: FieldFormState };

export function reduceFieldForm(
  state: FieldFormState,
  action: FieldFormAction,
): FieldFormState {
  const revision = state.revision + 1;
  switch (action.type) {
    case "name":
      return { ...state, name: action.value, revision };
    case "kind":
      // Switching the type keeps every slot (PRODUCT-DECISIONS item 2): only the active one changes.
      return { ...state, kind: action.value, revision };
    case "audience":
      return { ...state, audience: action.value, revision };
    case "slot":
      return {
        ...state,
        slots: { ...state.slots, [action.kind]: action.value },
        revision,
      };
    case "replace":
      return { ...action.state, revision };
  }
}

export type FieldInputProblem =
  | "label_missing"
  | "label_too_long"
  | "amount_missing"
  | "day_missing"
  | "month_missing"
  | "year_invalid"
  | "boolean_missing"
  | "url_missing"
  | NonNullable<ReturnType<typeof valueProblem>>;

/** Where a problem is shown: the input it belongs to. */
export type ProblemSlot =
  | "name"
  | "text"
  | "amount"
  | "unit"
  | "date"
  | "url"
  | "boolean"
  | "options"
  | "items";

export type Applicable =
  | { ok: true; label: string; value: FieldValue }
  | { ok: false; problems: Partial<Record<ProblemSlot, FieldInputProblem>> };

const WHOLE = /^[0-9]+$/;

/** The ACTIVE type's value from its slot, or the problem with it. The hidden slots are never read. */
export function activeValue(
  kind: FieldKind,
  slots: ValueSlots,
):
  | { ok: true; value: FieldValue }
  | { ok: false; slot: ProblemSlot; problem: FieldInputProblem } {
  let value: FieldValue;
  switch (kind) {
    case "text":
      value = { kind: "text", text: slots.text.text };
      break;
    case "quantity": {
      const amount = slots.quantity.amount.trim();
      if (amount === "")
        return { ok: false, slot: "amount", problem: "amount_missing" };
      value = { kind: "quantity", amount, unit: slots.quantity.unit.trim() };
      break;
    }
    case "date": {
      const { day, month, year } = slots.date;
      if (!WHOLE.test(day.trim()))
        return { ok: false, slot: "date", problem: "day_missing" };
      if (!WHOLE.test(month.trim()))
        return { ok: false, slot: "date", problem: "month_missing" };
      if (year.trim() !== "" && !WHOLE.test(year.trim()))
        return { ok: false, slot: "date", problem: "year_invalid" };
      value = {
        kind: "date",
        ...(year.trim() === "" ? {} : { year: Number(year.trim()) }),
        month: Number(month.trim()),
        day: Number(day.trim()),
      };
      break;
    }
    case "url": {
      const url = slots.url.url.trim();
      if (url === "") return { ok: false, slot: "url", problem: "url_missing" };
      value = { kind: "url", url };
      break;
    }
    case "boolean":
      if (slots.boolean.value === null)
        return { ok: false, slot: "boolean", problem: "boolean_missing" };
      value = { kind: "boolean", value: slots.boolean.value };
      break;
    case "choices":
      value = {
        kind: "choices",
        options: slots.choices.options.map((option) => option.label.trim()),
        selected: slots.choices.options
          .filter((option) => option.selected)
          .map((option) => option.label.trim()),
      };
      break;
    case "checklist":
      value = {
        kind: "checklist",
        items: slots.checklist.items.map((item) => ({
          id: item.id,
          label: item.label.trim(),
        })),
        checked: slots.checklist.items
          .filter((item) => item.checked)
          .map((item) => item.id),
      };
      break;
  }
  const problem = valueProblem(value);
  if (problem === null) return { ok: true, value };
  return { ok: false, slot: SLOT_OF[problem], problem };
}

const SLOT_OF: Record<
  NonNullable<ReturnType<typeof valueProblem>>,
  ProblemSlot
> = {
  text_too_long: "text",
  amount_invalid: "amount",
  unit_missing: "unit",
  unit_too_long: "unit",
  year_out_of_range: "date",
  date_invalid: "date",
  url_invalid: "url",
  options_missing: "options",
  options_too_many: "options",
  option_blank: "options",
  option_too_long: "options",
  options_repeated: "options",
  selected_unknown: "options",
  items_missing: "items",
  items_too_many: "items",
  item_blank: "items",
  item_too_long: "items",
  item_id_invalid: "items",
  checked_unknown: "items",
  value_too_large: "text",
};

/** What a save of `state` sends (the name and the ACTIVE type's value), or every problem that stops it. */
export function applicable(state: FieldFormState): Applicable {
  const problems: Partial<Record<ProblemSlot, FieldInputProblem>> = {};
  const label = labelProblem(state.name);
  if (label !== null) problems.name = label;
  const value = activeValue(state.kind, state.slots);
  if (!value.ok) {
    // A value too large for any one input is shown against the input of the active type.
    problems[
      value.problem === "value_too_large" ? slotOfKind(state.kind) : value.slot
    ] = value.problem;
  }
  if (Object.keys(problems).length > 0 || !value.ok)
    return { ok: false, problems };
  return { ok: true, label: state.name.trim(), value: value.value };
}

const slotOfKind = (kind: FieldKind): ProblemSlot =>
  kind === "quantity"
    ? "amount"
    : kind === "choices"
      ? "options"
      : kind === "checklist"
        ? "items"
        : kind;

/**
 * A save's ticket: the revision it was built from. After a success, the session may end only if nothing was changed since
 * (`isCurrent`); a later edit stays on screen, unsaved, for the person to save in turn.
 */
export interface Ticket {
  revision: number;
}
export const ticketOf = (state: FieldFormState): Ticket => ({
  revision: state.revision,
});
export const isCurrent = (state: FieldFormState, ticket: Ticket): boolean =>
  state.revision === ticket.revision;

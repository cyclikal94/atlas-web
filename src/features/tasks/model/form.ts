import type {
  Carry,
  ChecklistItem,
  Frequency,
  Goal,
  Participation,
  TaskDefinition,
} from "./contract";
import { isContractDate, isKnownZone } from "./contract";
import { parseDecimalInput, toUnits } from "./decimal";

/**
 * The task form (WF-TASK-02) as a PURE value. It keeps EVERY field's value, including fields the current choices hide (PRODUCT-DECISIONS-
 * 20261011 item 2): a hidden field comes back with what was typed in it when it is shown again. `applicable` builds the contract value from
 * the VISIBLE fields only, so a successful save sends nothing hidden and needs no warning about it; a refused or failed save keeps the
 * whole state.
 */
export type RepeatChoice = "none" | Frequency;
export type GoalKind = Goal["kind"];

export interface TaskFormState {
  title: string;
  repeat: RepeatChoice;
  interval: string;
  /** `YYYY-MM-DD` or empty (an undated one-off). */
  startDate: string;
  /** `HH:MM` or empty (any time that day). */
  time: string;
  timezone: string;
  openDaysBefore: string;
  closeDaysAfter: string;
  goalKind: GoalKind;
  minimum: string;
  maximum: string;
  unit: string;
  checklist: ChecklistItem[];
  carry: Carry;
  participation: Participation;
  allowExclusions: boolean;
  /** Create only (D-10a-4). */
  sharing: "defaults" | "only_me";
}

export type FormField =
  | "title"
  | "interval"
  | "startDate"
  | "time"
  | "timezone"
  | "openDaysBefore"
  | "closeDaysAfter"
  | "minimum"
  | "maximum"
  | "unit"
  | "checklist"
  | "participation"
  | "definition";

export type FormErrors = Partial<Record<FormField, string>>;

export function emptyForm(zone: string, today: string): TaskFormState {
  return {
    title: "",
    repeat: "daily",
    interval: "1",
    startDate: today,
    time: "",
    timezone: zone,
    openDaysBefore: "0",
    closeDaysAfter: "1",
    goalKind: "checkbox",
    minimum: "",
    maximum: "",
    unit: "",
    checklist: [],
    carry: "close_incomplete",
    participation: "personal",
    allowExclusions: false,
    sharing: "defaults",
  };
}

/** A form holding a definition (an existing task, or a preset): every field editable. */
export function fromDefinition(
  title: string,
  definition: TaskDefinition,
  base: TaskFormState,
): TaskFormState {
  const { schedule, goal } = definition;
  return {
    ...base,
    title,
    repeat: schedule.repeat === null ? "none" : schedule.repeat.frequency,
    interval:
      schedule.repeat === null
        ? base.interval
        : String(schedule.repeat.interval),
    startDate: schedule.start_date ?? "",
    time: schedule.time === null ? "" : schedule.time.slice(0, 5),
    timezone: schedule.timezone,
    openDaysBefore: String(definition.open_days_before),
    closeDaysAfter: String(definition.close_days_after),
    goalKind: goal.kind,
    minimum: goal.kind === "numeric" ? (goal.minimum ?? "") : base.minimum,
    maximum: goal.kind === "numeric" ? (goal.maximum ?? "") : base.maximum,
    unit: goal.kind === "numeric" ? goal.unit : base.unit,
    checklist:
      goal.kind === "checklist"
        ? goal.items.map((item) => ({ ...item }))
        : base.checklist,
    carry: definition.carry,
    participation: definition.participation,
    allowExclusions: definition.allow_streak_exclusions,
  };
}

/** Which conditional fields the current choices show. */
export function visibleFields(state: TaskFormState): {
  interval: boolean;
  time: boolean;
  numeric: boolean;
  checklist: boolean;
} {
  return {
    interval: state.repeat !== "none",
    // A time needs a date (the contract refuses a time without one): with no start date the time is kept, hidden.
    time: state.startDate.trim() !== "",
    numeric: state.goalKind === "numeric",
    checklist: state.goalKind === "checklist",
  };
}

const INT = /^\d+$/;
const intIn = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!INT.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};
const chars = (text: string) => [...text].length;
const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

export const MESSAGES = {
  title: "Give the task a name of 1 to 300 characters.",
  interval: "Enter a whole number from 1 to 366.",
  startDate: "Enter a real date.",
  startNeeded: "A repeating task needs a start date.",
  time: "Enter a time as hours and minutes, for example 07:30.",
  timezone: "Choose a time zone from the list.",
  openDaysBefore: "Enter a whole number of days from 0 to 366.",
  closeDaysAfter: "Enter a whole number of days from 1 to 366.",
  amount: "Enter an amount such as 3 or 2.5, with at most six decimal places.",
  bound: "Give at least a minimum or a maximum.",
  order: "The minimum can't be more than the maximum.",
  unit: "Give a unit of 1 to 40 characters, for example minutes.",
  checklist: "Add 1 to 100 items, each with a name of 1 to 300 characters.",
  pooled: "A shared total needs an amount to add up.",
  size: "This task is too large to save. Shorten its checklist or names.",
} as const;

export type Applicable =
  | { ok: true; title: string; definition: TaskDefinition }
  | { ok: false; errors: FormErrors };

/**
 * The contract value of the VISIBLE fields, or why it cannot be saved. Hidden fields are neither validated nor sent. The bounds are the
 * contract's: title 1-300, interval 1-366, unit 1-40, `TaskDecimal`, minimum ≤ maximum, 1-100 checklist items of 1-300 characters, the
 * window ranges, pooled needs an amount, and the definition at most 4 KiB as the server measures it.
 */
export function applicable(state: TaskFormState): Applicable {
  const errors: FormErrors = {};
  const show = visibleFields(state);
  const title = state.title.trim();
  if (chars(title) < 1 || chars(title) > 300) errors.title = MESSAGES.title;
  const startDate = state.startDate.trim();
  if (startDate !== "" && !isContractDate(startDate))
    errors.startDate = MESSAGES.startDate;
  if (startDate === "" && state.repeat !== "none")
    errors.startDate = MESSAGES.startNeeded;
  let interval = 1;
  if (show.interval) {
    const n = intIn(state.interval, 1, 366);
    if (n === null) errors.interval = MESSAGES.interval;
    else interval = n;
  }
  let time: string | null = null;
  if (show.time && state.time.trim() !== "") {
    if (!HHMM.test(state.time.trim())) errors.time = MESSAGES.time;
    else time = `${state.time.trim()}:00`;
  }
  if (!isKnownZone(state.timezone)) errors.timezone = MESSAGES.timezone;
  const open = intIn(state.openDaysBefore, 0, 366);
  if (open === null) errors.openDaysBefore = MESSAGES.openDaysBefore;
  const close = intIn(state.closeDaysAfter, 1, 366);
  if (close === null) errors.closeDaysAfter = MESSAGES.closeDaysAfter;
  let goal: Goal = { kind: "checkbox" };
  if (show.numeric) {
    const min =
      state.minimum.trim() === "" ? null : parseDecimalInput(state.minimum);
    const max =
      state.maximum.trim() === "" ? null : parseDecimalInput(state.maximum);
    if (state.minimum.trim() !== "" && min === null)
      errors.minimum = MESSAGES.amount;
    if (state.maximum.trim() !== "" && max === null)
      errors.maximum = MESSAGES.amount;
    if (state.minimum.trim() === "" && state.maximum.trim() === "")
      errors.minimum = MESSAGES.bound;
    if (min !== null && max !== null) {
      const a = toUnits(min) as bigint;
      const b = toUnits(max) as bigint;
      if (a > b) errors.maximum = MESSAGES.order;
    }
    const unit = state.unit.trim();
    if (unit === "" || chars(unit) > 40) errors.unit = MESSAGES.unit;
    goal = { kind: "numeric", minimum: min, maximum: max, unit };
  } else if (show.checklist) {
    const items = state.checklist.map((item) => ({
      id: item.id,
      label: item.label.trim(),
    }));
    if (
      items.length < 1 ||
      items.length > 100 ||
      items.some((item) => chars(item.label) < 1 || chars(item.label) > 300)
    )
      errors.checklist = MESSAGES.checklist;
    goal = { kind: "checklist", items };
  }
  if (state.participation === "pooled" && goal.kind !== "numeric")
    errors.participation = MESSAGES.pooled;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const definition: TaskDefinition = {
    schedule: {
      start_date: startDate === "" ? null : startDate,
      time: startDate === "" ? null : time,
      timezone: state.timezone,
      repeat:
        state.repeat === "none" ? null : { frequency: state.repeat, interval },
    },
    goal,
    carry: state.carry,
    participation: state.participation,
    open_days_before: open as number,
    close_days_after: close as number,
    allow_streak_exclusions: state.allowExclusions,
  };
  if (new TextEncoder().encode(JSON.stringify(definition)).length > 4096)
    return { ok: false, errors: { definition: MESSAGES.size } };
  return { ok: true, title, definition };
}

/** Revise mode locks the repeat family and participation (the server refuses a change of either: a new task is needed). */
export function repeatFamily(choice: RepeatChoice): "none" | "fixed" | "after" {
  if (choice === "none") return "none";
  return choice === "after_completion" ? "after" : "fixed";
}

/**
 * A submission ticket: the form revision a save captured. A save that succeeds closes the form only if no edit came after it; later edits
 * stay open (a success never consumes them).
 */
export interface Ticket {
  revision: number;
}
export const closesForm = (ticket: Ticket, currentRevision: number): boolean =>
  ticket.revision === currentRevision;

import type { Goal, OccurrenceData, TaskDefinition } from "./contract";
import { isContractDate } from "./contract";
import { parseDecimalInput, toUnits } from "./decimal";
import { MESSAGES } from "./form";

/**
 * The correction of ONE occurrence (WF-TASK-03, `revise_occurrence`) as a PURE value: the target for that day (in the frozen goal's kind),
 * the date it counts for, its time of day, and its window. Participation never changes (the server refuses it). The definition sent is
 * the occurrence's own with the goal and the window replaced: the task and every other day stay as they are.
 */
export interface CorrectionState {
  minimum: string;
  maximum: string;
  unit: string;
  /** Checklist item labels by id (the items themselves, and their ids, are kept). */
  labels: Record<string, string>;
  date: string;
  time: string;
  openDaysBefore: string;
  closeDaysAfter: string;
}

export function correctionFrom(data: OccurrenceData): CorrectionState {
  const { goal } = data.definition;
  return {
    minimum: goal.kind === "numeric" ? (goal.minimum ?? "") : "",
    maximum: goal.kind === "numeric" ? (goal.maximum ?? "") : "",
    unit: goal.kind === "numeric" ? goal.unit : "",
    labels:
      goal.kind === "checklist"
        ? Object.fromEntries(goal.items.map((item) => [item.id, item.label]))
        : {},
    date: data.slot.date ?? "",
    time: data.slot.intended_time?.slice(0, 5) ?? "",
    openDaysBefore: String(data.definition.open_days_before),
    closeDaysAfter: String(data.definition.close_days_after),
  };
}

export type CorrectionField =
  | "minimum"
  | "maximum"
  | "unit"
  | "labels"
  | "date"
  | "time"
  | "openDaysBefore"
  | "closeDaysAfter";

export type CorrectionResult =
  | {
      ok: true;
      definition: TaskDefinition;
      date: string | null;
      time: string | null;
    }
  | { ok: false; errors: Partial<Record<CorrectionField, string>> };

const intIn = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

export function correctionResult(
  data: OccurrenceData,
  state: CorrectionState,
): CorrectionResult {
  const errors: Partial<Record<CorrectionField, string>> = {};
  const current = data.definition.goal;
  let goal: Goal = current;
  if (current.kind === "numeric") {
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
    if (
      min !== null &&
      max !== null &&
      (toUnits(min) as bigint) > (toUnits(max) as bigint)
    )
      errors.maximum = MESSAGES.order;
    const unit = state.unit.trim();
    if (unit === "" || [...unit].length > 40) errors.unit = MESSAGES.unit;
    goal = { kind: "numeric", minimum: min, maximum: max, unit };
  } else if (current.kind === "checklist") {
    const items = current.items.map((item) => ({
      id: item.id,
      label: (state.labels[item.id] ?? item.label).trim(),
    }));
    if (
      items.some(
        (item) => [...item.label].length < 1 || [...item.label].length > 300,
      )
    )
      errors.labels = MESSAGES.checklist;
    goal = { kind: "checklist", items };
  }
  const date = state.date.trim();
  if (date !== "" && !isContractDate(date)) errors.date = MESSAGES.startDate;
  let time: string | null = null;
  if (date !== "" && state.time.trim() !== "") {
    if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(state.time.trim()))
      errors.time = MESSAGES.time;
    else time = `${state.time.trim()}:00`;
  }
  const open = intIn(state.openDaysBefore, 0, 366);
  if (open === null) errors.openDaysBefore = MESSAGES.openDaysBefore;
  const close = intIn(state.closeDaysAfter, 1, 366);
  if (close === null) errors.closeDaysAfter = MESSAGES.closeDaysAfter;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const definition: TaskDefinition = {
    ...data.definition,
    goal,
    open_days_before: open as number,
    close_days_after: close as number,
  };
  if (new TextEncoder().encode(JSON.stringify(definition)).length > 4096)
    return { ok: false, errors: { labels: MESSAGES.size } };
  return { ok: true, definition, date: date === "" ? null : date, time };
}

import type { OccurrenceData } from "./contract";
import { type CorrectionState, correctionFrom } from "./correction";
import { HHMMSS, type TaskFormState } from "./form";

/**
 * Form recovery readiness (Q4; WEB-14a supplies the app-update event that captures them). PURE. The recoverable value is the form's
 * whole state as canonical JSON, hidden fields included, keyed by a form context; there are no secrets in it. Restoring NEVER submits: the
 * restored values are shown and Save stays the person's act. A value that does not parse restores nothing.
 */
export const newTaskFormContext = (formId: string) => `task-form:new:${formId}`;
export const taskFormContext = (taskId: string) => `task-form:${taskId}`;
export const correctionFormContext = (occurrenceId: string) =>
  `occurrence-correction:${occurrenceId}`;

export function taskFormRecoveryValues(
  state: TaskFormState,
): Record<string, string> {
  return { form: JSON.stringify(state) };
}

/**
 * The time precision of a recovered form (R31, revision 16): its own kept time when the value carries one (a full `HH:MM:SS` or null, as
 * saved: never taken from a newer row), else, for a value saved before `keptTime` existed, no kept time and, when a time was shown, a
 * confirmation the person has to give before a save (whether it had seconds is unknown). `null`: the value is not one of these.
 */
function precisionOf(
  raw: Record<string, unknown>,
): { keptTime: string | null; timeUnconfirmed: boolean } | null {
  if (!("keptTime" in raw))
    return {
      keptTime: null,
      timeUnconfirmed: typeof raw.time === "string" && raw.time.trim() !== "",
    };
  const kept = raw.keptTime;
  if (kept !== null && (typeof kept !== "string" || !HHMMSS.test(kept)))
    return null;
  const unconfirmed = raw.timeUnconfirmed ?? false;
  if (typeof unconfirmed !== "boolean") return null;
  return { keptTime: kept, timeUnconfirmed: unconfirmed };
}

const FORM_KEYS: ReadonlyArray<keyof TaskFormState> = [
  "title",
  "repeat",
  "interval",
  "startDate",
  "time",
  "timezone",
  "openDaysBefore",
  "closeDaysAfter",
  "goalKind",
  "minimum",
  "maximum",
  "unit",
  "checklist",
  "carry",
  "participation",
  "allowExclusions",
  "sharing",
];

export function restoreTaskForm(
  values: Readonly<Record<string, string>>,
): TaskFormState | null {
  try {
    const raw = JSON.parse(values.form ?? "null") as Record<string, unknown>;
    if (raw === null || typeof raw !== "object") return null;
    for (const key of FORM_KEYS) if (!(key in raw)) return null;
    const strings = [
      "title",
      "interval",
      "startDate",
      "time",
      "timezone",
      "openDaysBefore",
      "closeDaysAfter",
      "minimum",
      "maximum",
      "unit",
    ];
    if (strings.some((key) => typeof raw[key] !== "string")) return null;
    if (!Array.isArray(raw.checklist)) return null;
    if (
      !raw.checklist.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { id: unknown }).id === "string" &&
          typeof (item as { label: unknown }).label === "string",
      )
    )
      return null;
    if (typeof raw.allowExclusions !== "boolean") return null;
    const one = (value: unknown, allowed: readonly string[]) =>
      typeof value === "string" && allowed.includes(value);
    if (
      !one(raw.repeat, [
        "none",
        "daily",
        "weekly",
        "monthly",
        "yearly",
        "after_completion",
      ]) ||
      !one(raw.goalKind, ["checkbox", "numeric", "checklist"]) ||
      !one(raw.carry, ["close_incomplete", "retain_one", "accumulate"]) ||
      !one(raw.participation, ["personal", "anyone", "everyone", "pooled"]) ||
      !one(raw.sharing, ["defaults", "only_me"])
    )
      return null;
    const precision = precisionOf(raw);
    if (precision === null) return null;
    return {
      ...(Object.fromEntries(
        FORM_KEYS.map((key) => [key, raw[key]]),
      ) as unknown as TaskFormState),
      ...precision,
    };
  } catch {
    return null;
  }
}

export function correctionRecoveryValues(
  state: CorrectionState,
): Record<string, string> {
  return { correction: JSON.stringify(state) };
}

export function restoreCorrection(
  values: Readonly<Record<string, string>>,
  data: OccurrenceData,
): CorrectionState | null {
  try {
    const raw = JSON.parse(values.correction ?? "null") as Record<
      string,
      unknown
    >;
    if (raw === null || typeof raw !== "object") return null;
    const base = correctionFrom(data);
    const out: CorrectionState = { ...base };
    for (const key of [
      "minimum",
      "maximum",
      "unit",
      "date",
      "time",
      "openDaysBefore",
      "closeDaysAfter",
    ] as const) {
      if (typeof raw[key] !== "string") return null;
      out[key] = raw[key] as string;
    }
    if (typeof raw.labels !== "object" || raw.labels === null) return null;
    const labels: Record<string, string> = {};
    for (const [id, label] of Object.entries(
      raw.labels as Record<string, unknown>,
    )) {
      if (typeof label !== "string" || !(id in base.labels)) return null;
      labels[id] = label;
    }
    out.labels = { ...base.labels, ...labels };
    // The recovered session's own precision, never the newer row's (`base`): a legacy value's time waits for confirmation (R31).
    const precision = precisionOf(raw);
    if (precision === null) return null;
    out.keptTime = precision.keptTime;
    out.timeUnconfirmed = precision.timeUnconfirmed;
    return out;
  } catch {
    return null;
  }
}

/**
 * Revision 37 (WEB-14a R40): the task form's editing session as ONE recoverable text (version 1): the values it began from (a locked
 * repeat or participation choice is judged against them) and what is typed now, raw (invalid text, hidden fields and the checklist's ids
 * and order included), each checked as `restoreTaskForm` checks a form. A text of another version, or one that does not parse, is null:
 * offered, never restored in part. No secrets: a task form has none.
 */
export const TASK_INPUT_VERSION = 1;

export interface TaskFormInput {
  initial: TaskFormState;
  state: TaskFormState;
}

export function encodeTaskFormInput(input: TaskFormInput): string {
  return JSON.stringify({
    v: TASK_INPUT_VERSION,
    initial: input.initial,
    state: input.state,
  });
}

export function decodeTaskFormInput(text: string): TaskFormInput | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || raw.v !== TASK_INPUT_VERSION)
      return null;
    const initial = restoreTaskForm({ form: JSON.stringify(raw.initial) });
    const state = restoreTaskForm({ form: JSON.stringify(raw.state) });
    return initial === null || state === null ? null : { initial, state };
  } catch {
    return null;
  }
}

/** Revision 37 (R40): the preset picker's choice (a preset id, or "" for none chosen), version 1. */
export const encodePresetChoice = (id: string): string =>
  JSON.stringify({ v: TASK_INPUT_VERSION, preset: id });
export function decodePresetChoice(text: string): string | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    return raw !== null &&
      typeof raw === "object" &&
      raw.v === TASK_INPUT_VERSION &&
      typeof raw.preset === "string"
      ? raw.preset
      : null;
  } catch {
    return null;
  }
}

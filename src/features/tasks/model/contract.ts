import { type CacheRow, isUuid, type Policy, parsePolicy } from "../../../data";
import { isDecimal } from "./decimal";

/**
 * The task resources of the pinned contract (`v0.28.0-rc.1`), as this slice reads them. Every value from the cache or a response is parsed
 * STRICTLY at read time (D-10a-3): the exact keys, every enumeration and bound. A value that does not parse is `null`, and the screens say
 * "This item can't be shown on this device"; nothing is guessed. TypeScript types are not validation.
 *
 * No page-level validator is registered for these kinds: a validator that refused one value would fail the whole sync page.
 */

export type Frequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "after_completion";
export const FREQUENCIES: readonly Frequency[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "after_completion",
];
export interface Cadence {
  frequency: Frequency;
  interval: number;
}
export interface Schedule {
  start_date: string | null;
  time: string | null;
  timezone: string;
  repeat: Cadence | null;
}
export interface ChecklistItem {
  id: string;
  label: string;
}
export type Goal =
  | { kind: "checkbox" }
  | {
      kind: "numeric";
      minimum: string | null;
      maximum: string | null;
      unit: string;
    }
  | { kind: "checklist"; items: ChecklistItem[] };
export type Carry = "close_incomplete" | "retain_one" | "accumulate";
export const CARRIES: readonly Carry[] = [
  "close_incomplete",
  "retain_one",
  "accumulate",
];
export type Participation = "personal" | "anyone" | "everyone" | "pooled";
export const PARTICIPATIONS: readonly Participation[] = [
  "personal",
  "anyone",
  "everyone",
  "pooled",
];
export interface TaskDefinition {
  schedule: Schedule;
  goal: Goal;
  carry: Carry;
  participation: Participation;
  open_days_before: number;
  close_days_after: number;
  allow_streak_exclusions: boolean;
}
export type Evidence =
  | { kind: "checkbox"; complete: boolean }
  | { kind: "quantity"; amount: string }
  | { kind: "checklist"; item_id: string; complete: boolean }
  | { kind: "observe" };
export type Outcome =
  | "unknown"
  | "incomplete"
  | "provisional"
  | "complete"
  | "missed"
  | "excluded";
export const OUTCOMES: readonly Outcome[] = [
  "unknown",
  "incomplete",
  "provisional",
  "complete",
  "missed",
  "excluded",
];
export interface ProgressSummary {
  outcome: Outcome;
  amount: string | null;
  checked: string[];
}
export interface TaskEntry {
  id: string;
  evidence: Evidence;
  /** Unix seconds. */
  happened_at: number;
  recorded_by: string;
}
export interface ProgressState {
  subject_account_id: string;
  recent_entries: TaskEntry[];
  entry_count: number;
  excluded: boolean;
  action: ProgressSummary;
  period: ProgressSummary;
  aggregate_consent: boolean;
}
export interface Slot {
  key: string;
  date: string | null;
  intended_time: string | null;
  timezone: string;
  /** Unix seconds, or null for a date-only or undated slot. */
  instant: number | null;
}
export interface RotaAssignment {
  revision: number;
  ordinal: number;
  account_id: string | null;
}
export interface OccurrenceData {
  task_id: string;
  definition: TaskDefinition;
  slot: Slot;
  opens_at: number | null;
  closes_at: number | null;
  participants: string[];
  covered_by: string | null;
  resolved: boolean;
  rota?: RotaAssignment | null;
}
export interface OccurrenceView {
  id: string;
  version: number;
  can_edit: boolean;
  data: OccurrenceData;
  outcome: Outcome;
  period_outcome: Outcome;
  actionable: boolean;
}
export interface OccurrencePage {
  items: OccurrenceView[];
  next_after: string | null;
  revision: number;
  pending_tasks: string[];
}
export interface TaskPreset {
  id: string;
  title: string;
  definition: TaskDefinition;
}
export interface JournalEntry extends TaskEntry {
  sequence: number;
  logical_order: number;
  replaces: string | null;
}
export interface ProgressJournal {
  entries: JournalEntry[];
  next_after: number | null;
}
export interface Enrolment {
  version: number;
  active: boolean;
  aggregate_consent: boolean;
  policy: Policy;
}
export interface TaskDetail {
  task: CacheRow;
  execution: CacheRow | null;
  materialisation: { last_date: string | null; pending: boolean } | null;
}

// ---- primitives -------------------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Exactly `required` plus any of `optional`, nothing else. */
function keysAre(
  value: Obj,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const key of required) if (!Object.hasOwn(value, key)) return false;
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) return false;
  return true;
}
const isInt = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" &&
  [...value].length >= min &&
  [...value].length <= max;

export { isContractDate, isContractTime, isKnownZone } from "./primitives";

import { isContractDate, isContractTime } from "./primitives";

// ---- parsers ----------------------------------------------------------------------------------------------------------------------
export function parseSchedule(value: unknown): Schedule | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["start_date", "time", "timezone", "repeat"])
  )
    return null;
  const { start_date, time, timezone, repeat } = value;
  if (start_date !== null && !isContractDate(start_date)) return null;
  if (time !== null && !isContractTime(time)) return null;
  if (time !== null && start_date === null) return null;
  if (typeof timezone !== "string" || timezone.length === 0) return null;
  let cadence: Cadence | null = null;
  if (repeat !== null) {
    if (!isObject(repeat) || !keysAre(repeat, ["frequency", "interval"]))
      return null;
    if (!FREQUENCIES.includes(repeat.frequency as Frequency)) return null;
    if (!isInt(repeat.interval, 1, 366)) return null;
    if (start_date === null) return null;
    cadence = {
      frequency: repeat.frequency as Frequency,
      interval: repeat.interval as number,
    };
  }
  return {
    start_date: start_date as string | null,
    time: time as string | null,
    timezone,
    repeat: cadence,
  };
}

export function parseGoal(value: unknown): Goal | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case "checkbox":
      return keysAre(value, ["kind"]) ? { kind: "checkbox" } : null;
    case "numeric": {
      if (!keysAre(value, ["kind", "minimum", "maximum", "unit"])) return null;
      const { minimum, maximum, unit } = value;
      if (minimum !== null && !isDecimal(minimum)) return null;
      if (maximum !== null && !isDecimal(maximum)) return null;
      if (!isText(unit, 1, 40)) return null;
      return {
        kind: "numeric",
        minimum: minimum as string | null,
        maximum: maximum as string | null,
        unit,
      };
    }
    case "checklist": {
      if (!keysAre(value, ["kind", "items"]) || !Array.isArray(value.items))
        return null;
      if (value.items.length < 1 || value.items.length > 100) return null;
      const items: ChecklistItem[] = [];
      for (const item of value.items) {
        if (!isObject(item) || !keysAre(item, ["id", "label"])) return null;
        if (!isUuid(item.id) || !isText(item.label, 1, 300)) return null;
        items.push({ id: item.id, label: item.label });
      }
      return { kind: "checklist", items };
    }
    default:
      return null;
  }
}

export function parseDefinition(value: unknown): TaskDefinition | null {
  if (
    !isObject(value) ||
    !keysAre(
      value,
      [
        "schedule",
        "goal",
        "carry",
        "participation",
        "open_days_before",
        "close_days_after",
      ],
      ["allow_streak_exclusions"],
    )
  )
    return null;
  const schedule = parseSchedule(value.schedule);
  const goal = parseGoal(value.goal);
  if (schedule === null || goal === null) return null;
  if (!CARRIES.includes(value.carry as Carry)) return null;
  if (!PARTICIPATIONS.includes(value.participation as Participation))
    return null;
  if (!isInt(value.open_days_before, 0, 366)) return null;
  if (!isInt(value.close_days_after, 1, 366)) return null;
  const allow = value.allow_streak_exclusions ?? false;
  if (typeof allow !== "boolean") return null;
  return {
    schedule,
    goal,
    carry: value.carry as Carry,
    participation: value.participation as Participation,
    open_days_before: value.open_days_before as number,
    close_days_after: value.close_days_after as number,
    allow_streak_exclusions: allow,
  };
}

export function parseEvidence(value: unknown): Evidence | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case "checkbox":
      return keysAre(value, ["kind", "complete"]) &&
        typeof value.complete === "boolean"
        ? { kind: "checkbox", complete: value.complete }
        : null;
    case "quantity":
      return keysAre(value, ["kind", "amount"]) && isDecimal(value.amount)
        ? { kind: "quantity", amount: value.amount }
        : null;
    case "checklist":
      return keysAre(value, ["kind", "item_id", "complete"]) &&
        isUuid(value.item_id) &&
        typeof value.complete === "boolean"
        ? {
            kind: "checklist",
            item_id: value.item_id,
            complete: value.complete,
          }
        : null;
    case "observe":
      return keysAre(value, ["kind"]) ? { kind: "observe" } : null;
    default:
      return null;
  }
}

function parseSummary(value: unknown): ProgressSummary | null {
  if (!isObject(value) || !keysAre(value, ["outcome", "amount", "checked"]))
    return null;
  if (!OUTCOMES.includes(value.outcome as Outcome)) return null;
  if (value.amount !== null && !isDecimal(value.amount)) return null;
  if (!Array.isArray(value.checked) || !value.checked.every(isUuid))
    return null;
  return {
    outcome: value.outcome as Outcome,
    amount: value.amount as string | null,
    checked: [...value.checked] as string[],
  };
}

function parseEntry(value: unknown): TaskEntry | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["id", "evidence", "happened_at", "recorded_by"])
  )
    return null;
  const evidence = parseEvidence(value.evidence);
  if (evidence === null || !isUuid(value.id) || !isUuid(value.recorded_by))
    return null;
  if (!isInt(value.happened_at, Number.MIN_SAFE_INTEGER)) return null;
  return {
    id: value.id,
    evidence,
    happened_at: value.happened_at as number,
    recorded_by: value.recorded_by,
  };
}

export function parseProgressState(value: unknown): ProgressState | null {
  if (
    !isObject(value) ||
    !keysAre(value, [
      "subject_account_id",
      "recent_entries",
      "entry_count",
      "excluded",
      "action",
      "period",
      "aggregate_consent",
    ])
  )
    return null;
  if (!isUuid(value.subject_account_id)) return null;
  if (!Array.isArray(value.recent_entries) || value.recent_entries.length > 8)
    return null;
  const recent: TaskEntry[] = [];
  for (const item of value.recent_entries) {
    const entry = parseEntry(item);
    if (entry === null) return null;
    recent.push(entry);
  }
  if (!isInt(value.entry_count, 0)) return null;
  if (recent.length > (value.entry_count as number)) return null;
  const action = parseSummary(value.action);
  const period = parseSummary(value.period);
  if (action === null || period === null) return null;
  if (typeof value.excluded !== "boolean") return null;
  if (typeof value.aggregate_consent !== "boolean") return null;
  return {
    subject_account_id: value.subject_account_id,
    recent_entries: recent,
    entry_count: value.entry_count as number,
    excluded: value.excluded,
    action,
    period,
    aggregate_consent: value.aggregate_consent,
  };
}

export function parseSlot(value: unknown): Slot | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["key", "date", "intended_time", "timezone", "instant"])
  )
    return null;
  if (!isText(value.key, 1, 100)) return null;
  if (value.date !== null && !isContractDate(value.date)) return null;
  if (value.intended_time !== null && !isContractTime(value.intended_time))
    return null;
  if (typeof value.timezone !== "string" || value.timezone === "") return null;
  if (value.instant !== null && !isInt(value.instant, Number.MIN_SAFE_INTEGER))
    return null;
  return {
    key: value.key,
    date: value.date as string | null,
    intended_time: value.intended_time as string | null,
    timezone: value.timezone,
    instant: value.instant as number | null,
  };
}

function parseRota(value: unknown): RotaAssignment | null | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !keysAre(value, ["revision", "ordinal", "account_id"]) ||
    !isInt(value.revision, 1) ||
    !isInt(value.ordinal, 0) ||
    (value.account_id !== null && !isUuid(value.account_id))
  )
    return undefined;
  return {
    revision: value.revision as number,
    ordinal: value.ordinal as number,
    account_id: value.account_id as string | null,
  };
}

export function parseOccurrenceData(value: unknown): OccurrenceData | null {
  if (
    !isObject(value) ||
    !keysAre(
      value,
      [
        "task_id",
        "definition",
        "slot",
        "opens_at",
        "closes_at",
        "participants",
        "covered_by",
        "resolved",
      ],
      ["rota"],
    )
  )
    return null;
  const definition = parseDefinition(value.definition);
  const slot = parseSlot(value.slot);
  if (definition === null || slot === null || !isUuid(value.task_id))
    return null;
  const window = (v: unknown) =>
    v === null || isInt(v, Number.MIN_SAFE_INTEGER);
  if (!window(value.opens_at) || !window(value.closes_at)) return null;
  if (
    !Array.isArray(value.participants) ||
    value.participants.length > 8 ||
    !value.participants.every(isUuid)
  )
    return null;
  if (value.covered_by !== null && !isUuid(value.covered_by)) return null;
  if (typeof value.resolved !== "boolean") return null;
  const out: OccurrenceData = {
    task_id: value.task_id,
    definition,
    slot,
    opens_at: value.opens_at as number | null,
    closes_at: value.closes_at as number | null,
    participants: [...value.participants] as string[],
    covered_by: value.covered_by as string | null,
    resolved: value.resolved,
  };
  if (Object.hasOwn(value, "rota")) {
    const rota = parseRota(value.rota);
    if (rota === undefined) return null;
    out.rota = rota;
  }
  return out;
}

export function parseOccurrenceView(value: unknown): OccurrenceView | null {
  if (
    !isObject(value) ||
    !keysAre(value, [
      "id",
      "version",
      "can_edit",
      "data",
      "outcome",
      "period_outcome",
      "actionable",
    ])
  )
    return null;
  const data = parseOccurrenceData(value.data);
  if (data === null || !isUuid(value.id) || !isInt(value.version, 1))
    return null;
  if (
    typeof value.can_edit !== "boolean" ||
    typeof value.actionable !== "boolean"
  )
    return null;
  if (
    !OUTCOMES.includes(value.outcome as Outcome) ||
    !OUTCOMES.includes(value.period_outcome as Outcome)
  )
    return null;
  return {
    id: value.id,
    version: value.version as number,
    can_edit: value.can_edit,
    data,
    outcome: value.outcome as Outcome,
    period_outcome: value.period_outcome as Outcome,
    actionable: value.actionable,
  };
}

export function parseOccurrencePage(value: unknown): OccurrencePage | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["items", "next_after", "revision", "pending_tasks"])
  )
    return null;
  if (!Array.isArray(value.items) || value.items.length > 200) return null;
  const items: OccurrenceView[] = [];
  for (const raw of value.items) {
    const item = parseOccurrenceView(raw);
    if (item === null) return null;
    items.push(item);
  }
  if (value.next_after !== null && !isUuid(value.next_after)) return null;
  if (!isInt(value.revision, 0)) return null;
  if (!Array.isArray(value.pending_tasks) || !value.pending_tasks.every(isUuid))
    return null;
  return {
    items,
    next_after: value.next_after as string | null,
    revision: value.revision as number,
    pending_tasks: [...value.pending_tasks] as string[],
  };
}

export function parsePresets(value: unknown): TaskPreset[] | null {
  if (!isObject(value) || !keysAre(value, ["items"])) return null;
  if (!Array.isArray(value.items) || value.items.length > 50) return null;
  const out: TaskPreset[] = [];
  for (const item of value.items) {
    if (!isObject(item) || !keysAre(item, ["id", "title", "definition"]))
      return null;
    const definition = parseDefinition(item.definition);
    if (
      definition === null ||
      !isText(item.id, 1, 100) ||
      !isText(item.title, 1, 300)
    )
      return null;
    out.push({ id: item.id, title: item.title, definition });
  }
  return out;
}

export function parseJournalPage(value: unknown): ProgressJournal | null {
  if (!isObject(value) || !keysAre(value, ["entries", "next_after"]))
    return null;
  if (!Array.isArray(value.entries) || value.entries.length > 200) return null;
  const entries: JournalEntry[] = [];
  for (const raw of value.entries) {
    if (
      !isObject(raw) ||
      !keysAre(raw, [
        "id",
        "evidence",
        "happened_at",
        "recorded_by",
        "sequence",
        "logical_order",
        "replaces",
      ])
    )
      return null;
    const { sequence, logical_order, replaces, ...rest } = raw;
    const entry = parseEntry(rest);
    if (entry === null || !isInt(sequence, 1) || !isInt(logical_order, 1))
      return null;
    if (replaces !== null && !isUuid(replaces)) return null;
    entries.push({
      ...entry,
      sequence: sequence as number,
      logical_order: logical_order as number,
      replaces: replaces as string | null,
    });
  }
  if (value.next_after !== null && !isInt(value.next_after, 1)) return null;
  return { entries, next_after: value.next_after as number | null };
}

export function parseEnrolment(value: unknown): Enrolment | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["version", "active", "aggregate_consent", "policy"])
  )
    return null;
  const policy = parsePolicy(value.policy);
  if (policy === null || !isInt(value.version, 0)) return null;
  if (
    typeof value.active !== "boolean" ||
    typeof value.aggregate_consent !== "boolean"
  )
    return null;
  return {
    version: value.version as number,
    active: value.active,
    aggregate_consent: value.aggregate_consent,
    policy,
  };
}

const KINDS = [
  "person",
  "field",
  "task",
  "execution",
  "occurrence",
  "progress",
  "list",
  "calendar_source",
  "event",
  "review",
  "reminder",
];
/** A `Projection`, as a cache row (no `kind_date`: this slice derives none). */
export function parseProjection(value: unknown): CacheRow | null {
  if (
    !isObject(value) ||
    !keysAre(
      value,
      ["id", "kind", "parent_id", "label", "value", "version", "can_edit"],
      ["policy_version", "archived"],
    )
  )
    return null;
  if (!isUuid(value.id) || !KINDS.includes(value.kind as string)) return null;
  if (value.parent_id !== null && !isUuid(value.parent_id)) return null;
  if (!isText(value.label, 1, 300)) return null;
  if (value.value !== null && !isObject(value.value)) return null;
  if (!isInt(value.version, 1) || typeof value.can_edit !== "boolean")
    return null;
  if (value.policy_version !== undefined && !isInt(value.policy_version, 1))
    return null;
  if (value.archived !== undefined && typeof value.archived !== "boolean")
    return null;
  return {
    id: value.id,
    kind: value.kind as CacheRow["kind"],
    parent_id: value.parent_id as string | null,
    label: value.label,
    value: value.value as CacheRow["value"],
    version: value.version as number,
    can_edit: value.can_edit,
    ...(value.policy_version === undefined
      ? {}
      : { policy_version: value.policy_version as number }),
    archived: value.archived === true,
    kind_date: null,
  };
}

export function parseTaskDetail(value: unknown): TaskDetail | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["task", "execution", "materialisation"])
  )
    return null;
  const task = parseProjection(value.task);
  if (task === null || task.kind !== "task") return null;
  let execution: CacheRow | null = null;
  if (value.execution !== null) {
    execution = parseProjection(value.execution);
    if (execution === null || execution.kind !== "execution") return null;
  }
  let materialisation: TaskDetail["materialisation"] = null;
  if (value.materialisation !== null) {
    const m = value.materialisation;
    if (
      !isObject(m) ||
      !keysAre(m, ["last_date", "pending"]) ||
      (m.last_date !== null && !isContractDate(m.last_date)) ||
      typeof m.pending !== "boolean"
    )
      return null;
    materialisation = {
      last_date: m.last_date as string | null,
      pending: m.pending,
    };
  }
  return { task, execution, materialisation };
}

/** The most projections one page of `GET /progress` holds at `limit=200` (the released endpoint's maximum). */
export const PROGRESS_PAGE = 200;

/**
 * One page of `GET /progress?parent_id=<occurrence>&limit=200[&after=<after>]` (`ResourcePage`), or null when it is not what the released
 * endpoint answers to that request (R19). The endpoint orders the visible streams by id (byte order: ids are lower-case UUIDs), returns only
 * those after `after`, and names the last id of a FULL page as `next_after`; a page that is not full ends the collection with `null`. So a
 * page whose cursor is missing, repeats or goes back, an empty or short page with a cursor, a full page without one, or a projection of
 * another kind or occurrence is not a page of this collection: it can neither prove that a stream is absent nor lead to another request.
 */
export function parseProgressPage(
  value: unknown,
  occurrenceId: string,
  after: string | null,
): { items: CacheRow[]; next_after: string | null } | null {
  if (!isObject(value) || !keysAre(value, ["items", "next_after"])) return null;
  const items = value.items;
  if (!Array.isArray(items) || items.length > PROGRESS_PAGE) return null;
  const out: CacheRow[] = [];
  let last = after;
  for (const raw of items) {
    const row = parseProjection(raw);
    if (
      row === null ||
      row.kind !== "progress" ||
      row.parent_id !== occurrenceId ||
      (last !== null && !(row.id > last))
    )
      return null;
    out.push(row);
    last = row.id;
  }
  const next = value.next_after;
  if (out.length === PROGRESS_PAGE ? next !== last : next !== null) return null;
  return { items: out, next_after: next as string | null };
}

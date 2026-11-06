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

// ---- WEB-10c: dependencies, timers, rotas, streaks (the pinned contract `v0.29.0-rc.1`) ------------------------------------------

/** One visible prerequisite of a preview (`DependencyItem`): no title, status, date or depth; titles and days come from the cache. */
export interface DependencyItem {
  occurrence_id: string;
  task_id: string;
  complete: boolean;
  can_complete: boolean;
  progress_version: number | null;
}
/**
 * `GET /occurrences/{id}/dependencies`: the visible TRANSITIVE prerequisites in completion order, the root LAST, with a caller-specific
 * token. No edge is exposed (the server publishes no prerequisite ids), so the client cannot know the direct list (D-10c-6, E-1).
 */
export interface DependencyPreview {
  token: string;
  items: DependencyItem[];
  unavailable: boolean;
  strict: boolean;
}
/** One of my timer sessions of one occurrence (`TimerSession`). Unix seconds. */
export interface TimerSession {
  id: string;
  occurrence_id: string;
  started_at: number;
  stopped_at: number | null;
  version: number;
}
export interface TimerPage {
  items: TimerSession[];
  next_after: string | null;
}
/** A row of `GET /timer-sessions` (B6): available with its task, or restricted (no task, occurrence, title or date). */
export type AccountTimerSession =
  | {
      access: "available";
      id: string;
      occurrence_id: string;
      task_id: string;
      task_title: string;
      slot_date: string | null;
      started_at: number;
      stopped_at: number | null;
      version: number;
      can_modify: boolean;
    }
  | {
      access: "restricted";
      id: string;
      started_at: number;
      stopped_at: number | null;
      version: number;
    };
export interface AccountTimerPage {
  items: AccountTimerSession[];
  next_after: string | null;
}
/** `GET /tasks/{id}/rota`. `eligible_participants` is filled for execution editors only (empty for other readers). */
export interface RotaState {
  version: number;
  participants: string[];
  consent_version: number;
  accepted: boolean;
  eligible_participants: string[];
}
/** `GET /tasks/{id}/streak?scope=`: null when the server cannot say (an invisible period, a withheld part). Never 0 for unknown. */
export interface TaskStreak {
  current: number | null;
  longest: number | null;
}
/** The receipt of every task command (`TaskResult`). */
export interface TaskResult {
  revision: number;
}

const TOKEN = /^[0-9a-f]{64}$/;
const isToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN.test(value);
const uuidList = (value: unknown, max: number, unique: boolean) => {
  if (!Array.isArray(value) || value.length > max || !value.every(isUuid))
    return null;
  if (unique && new Set(value).size !== value.length) return null;
  return [...value] as string[];
};

export function parseTaskResult(value: unknown): TaskResult | null {
  return isObject(value) &&
    keysAre(value, ["revision"]) &&
    Number.isSafeInteger(value.revision)
    ? { revision: value.revision as number }
    : null;
}

export function parseDependencyPreview(
  value: unknown,
): DependencyPreview | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["token", "items", "unavailable", "strict"])
  )
    return null;
  if (!isToken(value.token)) return null;
  if (typeof value.unavailable !== "boolean") return null;
  if (typeof value.strict !== "boolean") return null;
  if (!Array.isArray(value.items) || value.items.length > 200) return null;
  const items: DependencyItem[] = [];
  for (const raw of value.items) {
    if (
      !isObject(raw) ||
      !keysAre(raw, [
        "occurrence_id",
        "task_id",
        "complete",
        "can_complete",
        "progress_version",
      ])
    )
      return null;
    if (!isUuid(raw.occurrence_id) || !isUuid(raw.task_id)) return null;
    if (typeof raw.complete !== "boolean") return null;
    if (typeof raw.can_complete !== "boolean") return null;
    if (raw.progress_version !== null && !isInt(raw.progress_version, 1))
      return null;
    items.push({
      occurrence_id: raw.occurrence_id,
      task_id: raw.task_id,
      complete: raw.complete,
      can_complete: raw.can_complete,
      progress_version: raw.progress_version as number | null,
    });
  }
  // One item per occurrence: a repeated one is not a preview this contract describes.
  if (new Set(items.map((i) => i.occurrence_id)).size !== items.length)
    return null;
  return {
    token: value.token,
    items,
    unavailable: value.unavailable,
    strict: value.strict,
  };
}

const isSeconds = (value: unknown) => isInt(value, Number.MIN_SAFE_INTEGER);
const isStop = (value: unknown) => value === null || isSeconds(value);

function parseTimerSession(raw: unknown): TimerSession | null {
  if (
    !isObject(raw) ||
    !keysAre(raw, [
      "id",
      "occurrence_id",
      "started_at",
      "stopped_at",
      "version",
    ])
  )
    return null;
  if (!isUuid(raw.id) || !isUuid(raw.occurrence_id)) return null;
  if (!isSeconds(raw.started_at) || !isStop(raw.stopped_at)) return null;
  if (!isInt(raw.version, 1)) return null;
  return {
    id: raw.id,
    occurrence_id: raw.occurrence_id,
    started_at: raw.started_at as number,
    stopped_at: raw.stopped_at as number | null,
    version: raw.version as number,
  };
}

/** `GET /occurrences/{id}/timers`: my uncancelled sessions of `occurrenceId`, in id order after `after`; a cursor only after a full page. */
export function parseTimerPage(
  value: unknown,
  occurrenceId: string,
  after: string | null,
  limit: number,
): TimerPage | null {
  if (!isObject(value) || !keysAre(value, ["items", "next_after"])) return null;
  if (!Array.isArray(value.items) || value.items.length > Math.min(limit, 200))
    return null;
  const items: TimerSession[] = [];
  let last = after;
  for (const raw of value.items) {
    const session = parseTimerSession(raw);
    if (session === null || session.occurrence_id !== occurrenceId) return null;
    if (last !== null && !(session.id > last)) return null;
    items.push(session);
    last = session.id;
  }
  // The released endpoint names the last id of a FULL page and nothing otherwise (`server/src/tasks.rs` `timers`).
  const next = value.next_after;
  if (items.length === limit ? next !== last : next !== null) return null;
  return { items, next_after: next as string | null };
}

/** One row of `GET /timer-sessions` (also how the running-timer copy is read back, row by row). */
export function parseAccountTimer(raw: unknown): AccountTimerSession | null {
  if (!isObject(raw)) return null;
  if (raw.access === "restricted") {
    if (!keysAre(raw, ["access", "id", "started_at", "stopped_at", "version"]))
      return null;
    if (
      !isUuid(raw.id) ||
      !isSeconds(raw.started_at) ||
      !isStop(raw.stopped_at)
    )
      return null;
    if (!isInt(raw.version, 1)) return null;
    return {
      access: "restricted",
      id: raw.id,
      started_at: raw.started_at as number,
      stopped_at: raw.stopped_at as number | null,
      version: raw.version as number,
    };
  }
  if (raw.access !== "available") return null;
  if (
    !keysAre(raw, [
      "access",
      "id",
      "occurrence_id",
      "task_id",
      "task_title",
      "slot_date",
      "started_at",
      "stopped_at",
      "version",
      "can_modify",
    ])
  )
    return null;
  if (!isUuid(raw.id) || !isUuid(raw.occurrence_id) || !isUuid(raw.task_id))
    return null;
  if (!isText(raw.task_title, 1, 300)) return null;
  if (raw.slot_date !== null && !isContractDate(raw.slot_date)) return null;
  if (!isSeconds(raw.started_at) || !isStop(raw.stopped_at)) return null;
  if (!isInt(raw.version, 1) || typeof raw.can_modify !== "boolean")
    return null;
  return {
    access: "available",
    id: raw.id,
    occurrence_id: raw.occurrence_id,
    task_id: raw.task_id,
    task_title: raw.task_title,
    slot_date: raw.slot_date as string | null,
    started_at: raw.started_at as number,
    stopped_at: raw.stopped_at as number | null,
    version: raw.version as number,
    can_modify: raw.can_modify,
  };
}

/**
 * `GET /timer-sessions?state=`: a `running` page lists only running rows, `stopped` only finished ones (the cursor is opaque). A row of the
 * wrong state is not this page.
 */
export function parseAccountTimerPage(
  value: unknown,
  state: "running" | "stopped" | "all",
  limit: number,
): AccountTimerPage | null {
  if (!isObject(value) || !keysAre(value, ["items", "next_after"])) return null;
  if (!Array.isArray(value.items) || value.items.length > Math.min(limit, 200))
    return null;
  const items: AccountTimerSession[] = [];
  for (const raw of value.items) {
    const row = parseAccountTimer(raw);
    if (row === null) return null;
    if (state === "running" && row.stopped_at !== null) return null;
    if (state === "stopped" && row.stopped_at === null) return null;
    items.push(row);
  }
  const next = value.next_after;
  if (next !== null && !isText(next, 1, 64)) return null;
  return { items, next_after: next as string | null };
}

export function parseRotaState(value: unknown): RotaState | null {
  if (
    !isObject(value) ||
    !keysAre(value, [
      "version",
      "participants",
      "consent_version",
      "accepted",
      "eligible_participants",
    ])
  )
    return null;
  if (!isInt(value.version, 0) || !isInt(value.consent_version, 0)) return null;
  if (typeof value.accepted !== "boolean") return null;
  const participants = uuidList(value.participants, 8, true);
  const eligible = uuidList(value.eligible_participants, 10_000, true);
  if (participants === null || eligible === null) return null;
  return {
    version: value.version as number,
    participants,
    consent_version: value.consent_version as number,
    accepted: value.accepted,
    eligible_participants: eligible,
  };
}

export function parseStreak(value: unknown): TaskStreak | null {
  if (!isObject(value) || !keysAre(value, ["current", "longest"])) return null;
  const figure = (v: unknown) => v === null || isInt(v, 0);
  if (!figure(value.current) || !figure(value.longest)) return null;
  return {
    current: value.current as number | null,
    longest: value.longest as number | null,
  };
}

// ---- WEB-18: the dependency graph (`getDependencyGraph`, API 0.29.1, released in `v0.31.0-rc.1`) ---------------------------------

export type DependencyRelation = "root" | "direct" | "transitive";
export type DependencyState =
  | "satisfied"
  | "waiting"
  | "restricted"
  | "ready"
  | "unknown";
const RELATIONS: readonly DependencyRelation[] = [
  "root",
  "direct",
  "transitive",
];
const DEPENDENCY_STATES: readonly DependencyState[] = [
  "satisfied",
  "waiting",
  "restricted",
  "ready",
  "unknown",
];
/** One visible occurrence of a graph (`DependencyGraphNode`). `version` is its edit precondition only, never a graph revision. */
export interface DependencyGraphNode {
  occurrence_id: string;
  task_id: string;
  slot: Slot;
  version: number;
  can_edit: boolean;
  strict: boolean;
  depth: number;
  relation: DependencyRelation;
  outcome: Outcome;
  prerequisites: "expanded" | "unexpanded";
  /** On an expanded node, whether a stored direct prerequisite is hidden from me (no id, count or progress); null when unexpanded. */
  restricted_prerequisites: boolean | null;
  dependency_state: DependencyState;
}
/** One stored direct relationship: `dependant_id` requires `prerequisite_id`. */
export interface DependencyEdge {
  prerequisite_id: string;
  dependant_id: string;
}
export interface DependencyGraphTask {
  id: string;
  title: string;
}
/**
 * `GET /occurrences/{id}/dependency-graph`: one account's WHOLE view of one root at one `max_depth`, from one snapshot. It is replaced
 * only by a whole newer answer to the same request and never merged with another (backend `docs/tasks.md` "Dependency graph").
 */
export interface DependencyGraph {
  root_id: string;
  nodes: DependencyGraphNode[];
  edges: DependencyEdge[];
  tasks: DependencyGraphTask[];
  /** The root's visible stored direct prerequisites: the editor's authoritative current list. */
  direct_prerequisites: string[];
  coverage: "complete" | "partial";
  restricted: boolean;
  max_depth: number;
}

export const GRAPH_MAX_NODES = 200;
export const GRAPH_MAX_EDGES = 6400;
export const GRAPH_MAX_DEPTH = 200;
const GRAPH_MAX_DIRECT = 32;
const NODE_KEYS = [
  "occurrence_id",
  "task_id",
  "slot",
  "version",
  "can_edit",
  "strict",
  "depth",
  "relation",
  "outcome",
  "prerequisites",
  "restricted_prerequisites",
  "dependency_state",
] as const;

function parseGraphNode(raw: unknown): DependencyGraphNode | null {
  if (!isObject(raw) || !keysAre(raw, NODE_KEYS)) return null;
  if (!isUuid(raw.occurrence_id) || !isUuid(raw.task_id)) return null;
  const slot = parseSlot(raw.slot);
  if (slot === null) return null;
  if (!isInt(raw.version, 1)) return null;
  if (typeof raw.can_edit !== "boolean" || typeof raw.strict !== "boolean")
    return null;
  if (!isInt(raw.depth, 0, GRAPH_MAX_DEPTH)) return null;
  if (!RELATIONS.includes(raw.relation as DependencyRelation)) return null;
  if (!OUTCOMES.includes(raw.outcome as Outcome)) return null;
  if (raw.prerequisites !== "expanded" && raw.prerequisites !== "unexpanded")
    return null;
  // A boolean exactly on an expanded node, null exactly on an unexpanded one.
  if (
    raw.prerequisites === "expanded"
      ? typeof raw.restricted_prerequisites !== "boolean"
      : raw.restricted_prerequisites !== null
  )
    return null;
  if (!DEPENDENCY_STATES.includes(raw.dependency_state as DependencyState))
    return null;
  return {
    occurrence_id: raw.occurrence_id,
    task_id: raw.task_id,
    slot,
    version: raw.version as number,
    can_edit: raw.can_edit,
    strict: raw.strict,
    depth: raw.depth as number,
    relation: raw.relation as DependencyRelation,
    outcome: raw.outcome as Outcome,
    prerequisites: raw.prerequisites,
    restricted_prerequisites: raw.restricted_prerequisites as boolean | null,
    dependency_state: raw.dependency_state as DependencyState,
  };
}

/**
 * A node's `dependency_state` as the contract defines it, from its own outcome, expansion and hidden flag and its VISIBLE direct
 * prerequisites in this answer (`satisfied` is an own outcome of `complete`).
 */
export function definedState(
  node: Pick<
    DependencyGraphNode,
    "outcome" | "prerequisites" | "restricted_prerequisites"
  >,
  prerequisites: readonly Pick<DependencyGraphNode, "outcome">[],
): DependencyState {
  if (node.outcome === "complete") return "satisfied";
  if (node.prerequisites === "unexpanded") return "unknown";
  if (prerequisites.some((p) => p.outcome !== "complete")) return "waiting";
  return node.restricted_prerequisites === true ? "restricted" : "ready";
}

/**
 * `GET /occurrences/{id}/dependency-graph` validated STRICTLY against the request it answers (WEB-18 plan §3.1): the shape and bounds, and
 * every definitional invariant the contract states, so the screen never draws a hierarchy the answer does not say. Null when the body is
 * not the contract's answer to THIS request (`uncertain`). Sort orders are not checked: the screen imposes its own and relies on none.
 */
export function parseDependencyGraph(
  value: unknown,
  request: { rootId: string; maxDepth: number },
): DependencyGraph | null {
  if (
    !isObject(value) ||
    !keysAre(value, [
      "root_id",
      "nodes",
      "edges",
      "tasks",
      "direct_prerequisites",
      "coverage",
      "restricted",
      "max_depth",
    ])
  )
    return null;
  if (!isUuid(value.root_id) || value.root_id !== request.rootId) return null;
  if (!isInt(value.max_depth, 1, GRAPH_MAX_DEPTH)) return null;
  if (value.max_depth !== request.maxDepth) return null;
  if (value.coverage !== "complete" && value.coverage !== "partial")
    return null;
  if (typeof value.restricted !== "boolean") return null;
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > GRAPH_MAX_NODES
  )
    return null;
  if (!Array.isArray(value.edges) || value.edges.length > GRAPH_MAX_EDGES)
    return null;
  if (
    !Array.isArray(value.tasks) ||
    value.tasks.length < 1 ||
    value.tasks.length > GRAPH_MAX_NODES
  )
    return null;
  const direct = uuidList(value.direct_prerequisites, GRAPH_MAX_DIRECT, true);
  if (direct === null) return null;

  const nodes: DependencyGraphNode[] = [];
  const byId = new Map<string, DependencyGraphNode>();
  for (const raw of value.nodes) {
    const node = parseGraphNode(raw);
    if (node === null) return null;
    if (byId.has(node.occurrence_id)) return null;
    byId.set(node.occurrence_id, node);
    nodes.push(node);
  }
  const root = nodes[0] as DependencyGraphNode;
  // The root comes first, at depth 0, and is always expanded (its at most 32 visible prerequisites always fit the budget).
  if (root.occurrence_id !== value.root_id) return null;
  if (root.depth !== 0 || root.relation !== "root") return null;
  if (root.prerequisites !== "expanded") return null;
  if (nodes.some((n, i) => i > 0 && (n.relation === "root" || n.depth === 0)))
    return null;

  const tasks: DependencyGraphTask[] = [];
  const taskIds = new Set<string>();
  for (const raw of value.tasks) {
    if (!isObject(raw) || !keysAre(raw, ["id", "title"])) return null;
    if (!isUuid(raw.id) || typeof raw.title !== "string") return null;
    if (taskIds.has(raw.id)) return null;
    taskIds.add(raw.id);
    tasks.push({ id: raw.id, title: raw.title });
  }
  // One entry per task definition with an occurrence in `nodes`: no more, no fewer.
  const nodeTasks = new Set(nodes.map((n) => n.task_id));
  if (nodeTasks.size !== taskIds.size) return null;
  for (const id of nodeTasks) if (!taskIds.has(id)) return null;

  const edges: DependencyEdge[] = [];
  const pairs = new Set<string>();
  const prerequisitesOf = new Map<string, string[]>();
  for (const raw of value.edges) {
    if (!isObject(raw) || !keysAre(raw, ["prerequisite_id", "dependant_id"]))
      return null;
    const from = raw.prerequisite_id;
    const to = raw.dependant_id;
    if (!isUuid(from) || !isUuid(to)) return null;
    if (from === to) return null;
    const prerequisite = byId.get(from);
    const dependant = byId.get(to);
    // Both ends are returned nodes, and only an expanded node has its edges.
    if (prerequisite === undefined || dependant === undefined) return null;
    if (dependant.prerequisites !== "expanded") return null;
    const pair = `${from}>${to}`;
    if (pairs.has(pair)) return null;
    pairs.add(pair);
    edges.push({ prerequisite_id: from, dependant_id: to });
    prerequisitesOf.set(to, [...(prerequisitesOf.get(to) ?? []), from]);
  }

  // The root's direct list is exactly its edges, and those are exactly the `direct` nodes.
  const rootPrerequisites = new Set(prerequisitesOf.get(root.occurrence_id));
  if (rootPrerequisites.size !== direct.length) return null;
  for (const id of direct) if (!rootPrerequisites.has(id)) return null;
  for (const node of nodes)
    if (
      node !== root &&
      (node.relation === "direct") !== rootPrerequisites.has(node.occurrence_id)
    )
      return null;

  // Every node is reachable from the root over edges, at the breadth-first shortest distance it states, within `max_depth`.
  const distance = new Map<string, number>([[root.occurrence_id, 0]]);
  const queue = [root.occurrence_id];
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at] as string;
    const d = distance.get(id) as number;
    for (const next of prerequisitesOf.get(id) ?? [])
      if (!distance.has(next)) {
        distance.set(next, d + 1);
        queue.push(next);
      }
  }
  for (const node of nodes) {
    if (distance.get(node.occurrence_id) !== node.depth) return null;
    if (node.depth > value.max_depth) return null;
  }

  // `coverage` and `restricted` are exactly their definitions.
  const partial = nodes.some((n) => n.prerequisites === "unexpanded");
  if ((value.coverage === "partial") !== partial) return null;
  const restricted = nodes.some((n) => n.restricted_prerequisites === true);
  if (value.restricted !== restricted) return null;

  // Every `dependency_state` is the one the contract defines from this answer.
  for (const node of nodes) {
    const visible = (prerequisitesOf.get(node.occurrence_id) ?? []).map(
      (id) => byId.get(id) as DependencyGraphNode,
    );
    if (node.dependency_state !== definedState(node, visible)) return null;
  }

  return {
    root_id: value.root_id,
    nodes,
    edges,
    tasks,
    direct_prerequisites: direct,
    coverage: value.coverage,
    restricted: value.restricted,
    max_depth: value.max_depth,
  };
}

import type { OccurrenceData, TaskDefinition } from "./contract";
import type { PersonalResult } from "./evaluate";

/**
 * WF-TASK-06 "How it's been going" (WEB-10c D-10c-8, escalation E-3). PURE.
 *
 * The run figures are the SERVER's (`GET /tasks/{id}/streak`, `scope=personal` and, for a shared task, `scope=joint`): a `null` figure is
 * never shown as 0 (Withheld for a joint figure, someone keeps their part private; Unknown for mine). The strip is MINE and from this
 * device: the last 30 OPENED periods of the task in the cache, each with my result as WEB-10a reapplies and finalises it (never a joint
 * result: Q8; a joint per-period strip would need an unbounded walk of `GET /occurrences`). The run's start and end dates are not
 * shown: they cannot be derived consistently with the server's exclusion bridging.
 */
export const STRIP_PERIODS = 30;

export type StripState = "done" | "missed" | "open" | "none" | "skipped";

export interface StripInput {
  id: string;
  data: OccurrenceData;
  result: PersonalResult;
}
export interface StripCell {
  id: string;
  /** The slot's date, or null (undated). */
  date: string | null;
  state: StripState;
}

/** My state for one period, from my finalised personal result. */
export function stateOf(
  result: PersonalResult,
  data: OccurrenceData,
  nowMs: number,
): StripState {
  if (result.kind !== "result") return "none";
  const closed =
    data.closes_at !== null && Math.floor(nowMs / 1000) >= data.closes_at;
  switch (result.periodOutcome) {
    case "complete":
      return "done";
    case "missed":
      return "missed";
    case "excluded":
      return "skipped";
    case "unknown":
      return closed ? "none" : "open";
    default:
      return closed ? "missed" : "open";
  }
}

/** Opened: its window has begun (no opening is "always open"). */
export const opened = (data: OccurrenceData, nowMs: number): boolean =>
  data.opens_at === null || data.opens_at * 1000 <= nowMs;

/** The order of periods: by the slot's instant, else its date, then id. */
function orderKey(data: OccurrenceData): string {
  const at =
    data.slot.instant !== null
      ? String(data.slot.instant + 1e12).padStart(14, "0")
      : null;
  return `${data.slot.date ?? "0000-00-00"}|${at ?? ""}`;
}

/** The last `STRIP_PERIODS` opened periods of `days`, oldest first (a walk keeps only these as it goes). */
export function latestPeriods<T extends { id: string; data: OccurrenceData }>(
  days: readonly T[],
  nowMs: number,
): T[] {
  return days
    .filter((day) => opened(day.data, nowMs))
    .sort(
      (a, b) =>
        orderKey(a.data).localeCompare(orderKey(b.data)) ||
        a.id.localeCompare(b.id),
    )
    .slice(-STRIP_PERIODS);
}

/** The strip: the last `STRIP_PERIODS` opened periods with my state, oldest first. */
export function strip(
  inputs: readonly StripInput[],
  nowMs: number,
): StripCell[] {
  return latestPeriods(inputs, nowMs).map((input) => ({
    id: input.id,
    date: input.data.slot.date,
    state: stateOf(input.result, input.data, nowMs),
  }));
}

/** "Last 30 {unit}: {done}/{total}, {missed} missed": only my KNOWN results count (an open period or no record is not a total). */
export function tally(cells: readonly StripCell[]): {
  done: number;
  total: number;
  missed: number;
} {
  let done = 0;
  let missed = 0;
  for (const cell of cells) {
    if (cell.state === "done") done += 1;
    if (cell.state === "missed") missed += 1;
  }
  return { done, total: done + missed, missed };
}

/** The unit a run is counted in, by the task's cadence: interval 1 of a calendar frequency, else "times". */
export function unitOf(
  definition: TaskDefinition,
  count: number | null,
): string {
  const repeat = definition.schedule.repeat;
  const one = count === 1;
  if (repeat !== null && repeat.interval === 1)
    switch (repeat.frequency) {
      case "daily":
        return one ? "day" : "days";
      case "weekly":
        return one ? "week" : "weeks";
      case "monthly":
        return one ? "month" : "months";
      case "yearly":
        return one ? "year" : "years";
      default:
        break;
    }
  return one ? "time" : "times";
}

/** A figure as shown: never 0 for unknown. */
export type Figure =
  | { kind: "count"; value: number }
  | { kind: "withheld" }
  | { kind: "unknown" };
export function figureOf(
  value: number | null,
  scope: "joint" | "personal",
): Figure {
  if (value !== null) return { kind: "count", value };
  return scope === "joint" ? { kind: "withheld" } : { kind: "unknown" };
}

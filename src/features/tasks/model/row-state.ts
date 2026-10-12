import type { OccurrenceData, Outcome, Participation } from "./contract";

/**
 * What a Today row or a task header says about MY part (D-10a-8), and how the filters and the summary count it. The first rule that
 * applies wins. A state that is not known is never counted as zero (AUDIT 572-582, TASK-19a): the summary says how many are not known.
 */
export type Pill =
  | "conflict"
  | "excluded"
  | "done"
  | "done_late"
  | "covered"
  | "closed"
  | "missed"
  | "on_track"
  | "to_do"
  | "not_open"
  | "unavailable"
  | "unknown";

export interface RowInputs {
  data: OccurrenceData;
  /** My outcome and period outcome (server or local), or null when this device has no personal result. */
  outcome: Outcome | null;
  periodOutcome: Outcome | null;
  /** My result should exist but this device cannot tell. */
  unavailable: boolean;
  actionable: boolean;
  /** An outstanding draft of mine for this row needs a decision (a conflict or a refusal). */
  attention: boolean;
  nowMs: number;
}

export function pillOf(row: RowInputs): Pill {
  const now = Math.floor(row.nowMs / 1000);
  if (row.attention) return "conflict";
  if (row.outcome === "excluded") return "excluded";
  if (row.outcome === "complete")
    return row.periodOutcome === "missed" ? "done_late" : "done";
  if (row.data.covered_by !== null) return "covered";
  if (row.data.resolved) return "closed";
  if (row.periodOutcome === "missed") return "missed";
  if (row.outcome === "provisional") return "on_track";
  if (row.actionable) return "to_do";
  if (row.data.opens_at !== null && row.data.opens_at > now) return "not_open";
  if (row.unavailable) return "unavailable";
  return "unknown";
}

export type Filter = "all" | "to_do" | "done" | "missed";
export const FILTERS: readonly Filter[] = ["all", "to_do", "done", "missed"];

export function inFilter(filter: Filter, row: RowInputs): boolean {
  switch (filter) {
    case "all":
      return true;
    case "to_do":
      return row.actionable;
    case "done":
      return row.outcome === "complete";
    case "missed":
      return row.periodOutcome === "missed";
  }
}

export interface Counts {
  total: number;
  done: number;
  toDo: number;
  /** Rows whose state is not known: never counted as done or as to do. */
  notKnown: number;
}

export function countRows(rows: readonly RowInputs[]): Counts {
  let done = 0;
  let toDo = 0;
  let notKnown = 0;
  for (const row of rows) {
    if (row.outcome === "complete") done += 1;
    else if (row.actionable) toDo += 1;
    // Not known: a row that is neither done nor to do and whose state this device cannot tell (never counted as zero).
    else if (row.outcome === null || row.outcome === "unknown") notKnown += 1;
  }
  return { total: rows.length, done, toDo, notKnown };
}

/** The joint line of a shared task (Q8: never computed here). */
export type JointLine =
  | { kind: "server"; outcome: Outcome; asOf: number }
  | { kind: "withheld" }
  | { kind: "anyone_unknown" }
  | { kind: "not_known" }
  | { kind: "last_checked"; outcome: Outcome; asOf: number }
  | { kind: "offline" };

/**
 * The joint line, from the server's last answer for this identity and what the cache shows about the participants' streams. `withheld`
 * only when the cache shows a participant whose stream is absent here or present without consent (another person's); an Anyone task
 * whose joint result is `unknown` says no one has finished it yet that you can see.
 */
export function jointLine(input: {
  participation: Participation;
  serverOutcome: Outcome | null;
  asOf: number | null;
  online: boolean;
  /** Per listed participant other than me: whether their stream is in the cache with `aggregate_consent`. */
  othersVisibleWithConsent: readonly boolean[];
}): JointLine {
  if (input.serverOutcome !== null && input.asOf !== null) {
    if (!input.online)
      return {
        kind: "last_checked",
        outcome: input.serverOutcome,
        asOf: input.asOf,
      };
    if (input.serverOutcome !== "unknown")
      return { kind: "server", outcome: input.serverOutcome, asOf: input.asOf };
    if (input.participation === "anyone") return { kind: "anyone_unknown" };
    if (input.othersVisibleWithConsent.some((visible) => !visible))
      return { kind: "withheld" };
    return { kind: "not_known" };
  }
  return input.online ? { kind: "not_known" } : { kind: "offline" };
}

import type {
  Evidence,
  Goal,
  OccurrenceData,
  Outcome,
  Participation,
  ProgressState,
  ProgressSummary,
  TaskEntry,
} from "./contract";
import { fromUnits, MAX_UNITS, toUnits } from "./decimal";
import { dateIn, dayEnd } from "./time";

/**
 * The server's evaluation, mirrored exactly (`crates/core/src/tasks/mod.rs` `evaluate`/`aggregate`, `service/reads.rs`), and the offline
 * reapplication of ARCH §3.3c over the SYNCED progress state.
 *
 * What a synced `ProgressState` holds is evaluated with `closed = false` (`progress_state`), and time passing does not refresh it. Offline
 * finalisation therefore maps the STORED outcome once a window closes (`finalise`), never re-derives it from `recent_entries` (at most eight)
 * or `entry_count`. A JOINT result is never computed by this client (Q8): `aggregate` exists for tests and documentation only.
 */

const minimumOnly = (goal: Goal): boolean =>
  goal.kind === "numeric" && goal.minimum !== null && goal.maximum === null;
/** The goals whose unobserved closed window is `missed` rather than `unknown`. */
const missedWhenUnobserved = (goal: Goal): boolean =>
  goal.kind === "checkbox" || goal.kind === "checklist" || minimumOnly(goal);

/** The running state of a stream: what `evaluate` folds, and what pending evidence is layered onto. */
export interface StreamState {
  observed: boolean;
  checkbox: boolean;
  amount: bigint;
  checked: Map<string, boolean>;
}

const emptyState = (): StreamState => ({
  observed: false,
  checkbox: false,
  amount: 0n,
  checked: new Map(),
});

/** Folds one entry (in `logical_order`). `null`: the evidence does not fit the goal or the total overflows (the server refuses it). */
function fold(state: StreamState, goal: Goal, evidence: Evidence): boolean {
  switch (evidence.kind) {
    case "checkbox":
      if (goal.kind !== "checkbox") return false;
      state.checkbox = evidence.complete;
      break;
    case "quantity": {
      if (goal.kind !== "numeric") return false;
      const units = toUnits(evidence.amount);
      if (units === null) return false;
      state.amount += units;
      if (state.amount > MAX_UNITS) return false;
      break;
    }
    case "checklist":
      if (
        goal.kind !== "checklist" ||
        !goal.items.some((item) => item.id === evidence.item_id)
      )
        return false;
      state.checked.set(evidence.item_id, evidence.complete);
      break;
    case "observe":
      if (goal.kind !== "numeric") return false;
      break;
  }
  state.observed = true;
  return true;
}

function outcomeOf(state: StreamState, goal: Goal, closed: boolean): Outcome {
  let success: boolean;
  switch (goal.kind) {
    case "checkbox":
      success = state.checkbox;
      break;
    case "checklist":
      success = goal.items.every((item) => state.checked.get(item.id) === true);
      break;
    case "numeric": {
      const min = goal.minimum === null ? null : toUnits(goal.minimum);
      const max = goal.maximum === null ? null : toUnits(goal.maximum);
      success =
        (min === null || state.amount >= min) &&
        (max === null || state.amount <= max);
      break;
    }
  }
  if (!state.observed)
    return closed && missedWhenUnobserved(goal) ? "missed" : "unknown";
  if (success && !closed && goal.kind === "numeric" && goal.maximum !== null)
    return "provisional";
  if (success) return "complete";
  return closed ? "missed" : "incomplete";
}

function summaryOf(
  state: StreamState,
  goal: Goal,
  closed: boolean,
): ProgressSummary {
  return {
    outcome: outcomeOf(state, goal, closed),
    amount:
      state.observed && goal.kind === "numeric"
        ? fromUnits(state.amount)
        : null,
    checked: [...state.checked]
      .filter(([, complete]) => complete)
      .map(([id]) => id)
      .sort(),
  };
}

/** `evaluate` of the server: evidence already ordered with corrections applied. `null` where the server would refuse the evidence. */
export function evaluate(
  goal: Goal,
  entries: readonly Evidence[],
  closed: boolean,
): ProgressSummary | null {
  const state = emptyState();
  for (const evidence of entries) if (!fold(state, goal, evidence)) return null;
  return summaryOf(state, goal, closed);
}

/**
 * `aggregate` of the server, for tests and documentation ONLY (Q8: the client never shows a joint result it computed). `null` entries are
 * streams the reader cannot use (invisible, not consented, an excluded Anyone stream).
 */
export function aggregate(
  goal: Goal,
  participation: Participation,
  streams: readonly (readonly Evidence[] | null)[],
  closed: boolean,
): Outcome | null {
  if (participation === "anyone") {
    for (const entries of streams)
      if (
        entries !== null &&
        evaluate(goal, entries, closed)?.outcome === "complete"
      )
        return "complete";
    return "unknown";
  }
  if (streams.length === 0 || streams.some((s) => s === null)) return "unknown";
  const present = streams as readonly (readonly Evidence[])[];
  if (participation === "pooled") {
    if (goal.kind !== "numeric") return null;
    if (present.some((s) => s.length === 0)) return "unknown";
    return evaluate(goal, present.flat(), closed)?.outcome ?? null;
  }
  const outcomes: Outcome[] = [];
  for (const s of present) {
    const outcome = evaluate(goal, s, closed)?.outcome;
    if (outcome === undefined) return null;
    outcomes.push(outcome);
  }
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.every((o) => o === "complete")) return "complete";
  if (outcomes.includes("provisional") && !closed) return "provisional";
  return closed ? "missed" : "incomplete";
}

/**
 * Offline finalisation of a STORED outcome (evaluated `closed = false`) once the window has closed: `provisional` → `complete`;
 * `incomplete` → `missed`; `unknown` → `missed` only for checkbox, checklist and minimum-only numeric goals; anything else stays. Exact:
 * it is what `evaluate(goal, entries, true)` gives for the same entries (TASK-31 #1).
 */
export function finalise(
  outcome: Outcome,
  goal: Goal,
  closed: boolean,
): Outcome {
  if (!closed) return outcome;
  switch (outcome) {
    case "provisional":
      return "complete";
    case "incomplete":
      return "missed";
    case "unknown":
      return missedWhenUnobserved(goal) ? "missed" : "unknown";
    default:
      return outcome;
  }
}

/** The running state a stored summary stands for (`closed = false`): exact for every goal, because each outcome says what was folded. */
export function stateOf(summary: ProgressSummary, goal: Goal): StreamState {
  const state = emptyState();
  state.observed =
    summary.outcome !== "unknown" && summary.outcome !== "excluded";
  if (goal.kind === "checkbox") state.checkbox = summary.outcome === "complete";
  if (goal.kind === "numeric" && summary.amount !== null)
    state.amount = toUnits(summary.amount) ?? 0n;
  for (const id of summary.checked) state.checked.set(id, true);
  return state;
}

/** One saved, unsent piece of evidence of MY stream, from an outstanding `record` draft. */
export interface PendingEvidence {
  entryId: string;
  evidence: Evidence;
  happenedAt: number;
  replaces: string | null;
}

export interface Layered {
  action: ProgressSummary;
  period: ProgressSummary;
  /**
   * `false`: a correction could not be layered (the replaced entry is not among the synced recent entries, or the stream has more than
   * eight entries): the result is the synced one, "waiting for the server to check the full history" (ARCH 2151-2194).
   */
  exact: boolean;
}

const inWindow = (
  happenedAt: number,
  opensAt: number | null,
  closesAt: number | null,
): boolean =>
  (opensAt === null || happenedAt >= opensAt) &&
  (closesAt === null || happenedAt < closesAt);

/**
 * The synced state with MY pending evidence layered on (ARCH §3.3c point 5). Append-only evidence is exact against the summary: a
 * checkbox value becomes the last, a quantity is added in micro-units, a checklist item is set or cleared, an observation observes. An entry
 * counts towards `period` iff `opens_at ≤ happened_at < closes_at`. A correction (`replaces`) is layered only when the WHOLE stream is
 * known (`entry_count ≤ 8` and the replaced entry is a recent or pending one); otherwise the result is not exact.
 */
export function layer(
  progress: Pick<
    ProgressState,
    "action" | "period" | "recent_entries" | "entry_count"
  > | null,
  goal: Goal,
  pending: readonly PendingEvidence[],
  window: { opensAt: number | null; closesAt: number | null },
): Layered {
  const base = progress ?? {
    action: { outcome: "unknown" as Outcome, amount: null, checked: [] },
    period: { outcome: "unknown" as Outcome, amount: null, checked: [] },
    recent_entries: [] as TaskEntry[],
    entry_count: 0,
  };
  const corrections = pending.some((p) => p.replaces !== null);
  if (!corrections) {
    const action = stateOf(base.action, goal);
    const period = stateOf(base.period, goal);
    for (const p of pending) {
      if (!fold(action, goal, p.evidence))
        return { action: base.action, period: base.period, exact: false };
      if (inWindow(p.happenedAt, window.opensAt, window.closesAt))
        fold(period, goal, p.evidence);
    }
    return {
      action: summaryOf(action, goal, false),
      period: summaryOf(period, goal, false),
      exact: true,
    };
  }
  // A correction needs every entry: only possible when the stream has no more entries than the synced recent ones.
  if (base.entry_count > 8 || base.recent_entries.length !== base.entry_count)
    return { action: base.action, period: base.period, exact: false };
  const list: Array<{ id: string; evidence: Evidence; happenedAt: number }> =
    base.recent_entries.map((e) => ({
      id: e.id,
      evidence: e.evidence,
      happenedAt: e.happened_at,
    }));
  for (const p of pending) {
    const entry = {
      id: p.entryId,
      evidence: p.evidence,
      happenedAt: p.happenedAt,
    };
    if (p.replaces === null) list.push(entry);
    else {
      // The replacement inherits the replaced entry's place (`logical_order`).
      const at = list.findIndex((e) => e.id === p.replaces);
      if (at < 0)
        return { action: base.action, period: base.period, exact: false };
      list[at] = entry;
    }
  }
  const action = evaluate(
    goal,
    list.map((e) => e.evidence),
    false,
  );
  const period = evaluate(
    goal,
    list
      .filter((e) => inWindow(e.happenedAt, window.opensAt, window.closesAt))
      .map((e) => e.evidence),
    false,
  );
  if (action === null || period === null)
    return { action: base.action, period: base.period, exact: false };
  return { action, period, exact: true };
}

/** My personal result for one occurrence, as this device can know it. */
export type PersonalResult =
  | {
      kind: "result";
      outcome: Outcome;
      periodOutcome: Outcome;
      /** The progress the result came from (layered), for amounts and checked items. */
      action: ProgressSummary;
      /** Pending evidence or a pending exclusion is part of it: shown as provisional until the server confirms. */
      provisional: boolean;
      /** A correction could not be layered: waiting for the server to check the full history. */
      stale: boolean;
    }
  /** It should exist but this device cannot tell (never a confident absence). */
  | { kind: "unavailable" }
  /** I have no part in this occurrence. */
  | { kind: "none" };

export interface PersonalInputs {
  occurrence: OccurrenceData;
  /** My progress stream by its deterministic id, as cached (with display patches applied), or null when absent. */
  stream: ProgressState | null;
  /** My outstanding evidence for this occurrence, in the order it was saved. */
  pending: readonly PendingEvidence[];
  /** Whether an outstanding draft introduces my stream (a create, or an Anyone first record). */
  streamPending: boolean;
  me: string;
  nowMs: number;
}

/** ARCH §3.3c, in order: covered, excluded, presence by deterministic id, finalisation, layering. */
export function personalResult(input: PersonalInputs): PersonalResult {
  const { occurrence: occ, stream, pending, me } = input;
  const now = Math.floor(input.nowMs / 1000);
  const closed = occ.closes_at !== null && now >= occ.closes_at;
  const goal = occ.definition.goal;
  const provisional = pending.length > 0;
  if (occ.covered_by !== null && occ.participants.includes(me)) {
    const outcome: Outcome = closed ? "missed" : "incomplete";
    const empty = { outcome, amount: null, checked: [] };
    return {
      kind: "result",
      outcome,
      periodOutcome: outcome,
      action: empty,
      provisional: false,
      stale: false,
    };
  }
  if (stream?.excluded && occ.definition.allow_streak_exclusions)
    return {
      kind: "result",
      outcome: "excluded",
      periodOutcome: "excluded",
      action: stream.action,
      provisional,
      stale: false,
    };
  if (stream === null && !input.streamPending && pending.length === 0) {
    if (occ.definition.participation === "anyone")
      return { kind: "unavailable" };
    return occ.participants.includes(me)
      ? { kind: "unavailable" }
      : { kind: "none" };
  }
  const layered = layer(stream, goal, pending, {
    opensAt: occ.opens_at,
    closesAt: occ.closes_at,
  });
  return {
    kind: "result",
    outcome: finalise(layered.action.outcome, goal, closed),
    periodOutcome: finalise(layered.period.outcome, goal, closed),
    action: layered.action,
    provisional,
    stale: !layered.exact,
  };
}

/** Whether I can record on this occurrence at all (participant, or an Anyone task I may edit). */
export function eligible(
  occurrence: OccurrenceData,
  input: { streamPresent: boolean; canEdit: boolean },
): boolean {
  return (
    input.streamPresent ||
    (occurrence.definition.participation === "anyone" && input.canEdit)
  );
}

/** The server's `actionable`, for MY result (`reads.rs`): eligible, not resolved or covered, opened, the carry rule, not done. */
export function actionable(
  occurrence: OccurrenceData,
  input: { eligible: boolean; outcome: Outcome | null; nowMs: number },
): boolean {
  const now = Math.floor(input.nowMs / 1000);
  return (
    input.eligible &&
    !occurrence.resolved &&
    occurrence.covered_by === null &&
    (occurrence.opens_at === null || occurrence.opens_at <= now) &&
    (occurrence.definition.carry !== "close_incomplete" ||
      occurrence.closes_at === null ||
      now < occurrence.closes_at) &&
    input.outcome !== "complete" &&
    input.outcome !== "excluded"
  );
}

/** Scheduled on `day` in the DISPLAY zone: the instant's date there, else the slot's own date; never an undated slot. */
export function scheduledOn(
  occurrence: Pick<OccurrenceData, "slot">,
  day: string,
  zone: string,
): boolean {
  const { slot } = occurrence;
  if (slot.instant !== null) return dateIn(slot.instant, zone) === day;
  return slot.date !== null && slot.date === day;
}

/** Day membership of `/daily`: scheduled on the day, or opened before its end and actionable now. */
export function inDayView(
  occurrence: Pick<OccurrenceData, "slot" | "opens_at">,
  day: string,
  zone: string,
  isActionable: boolean,
): boolean {
  if (scheduledOn(occurrence, day, zone)) return true;
  return (
    isActionable &&
    (occurrence.opens_at === null || occurrence.opens_at < dayEnd(day, zone))
  );
}

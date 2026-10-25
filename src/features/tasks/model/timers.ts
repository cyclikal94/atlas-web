import type { DraftWithCommand } from "../../../data";
import { commandOf } from "./commands";
import type {
  AccountTimerSession,
  OccurrenceData,
  TimerSession,
} from "./contract";

/**
 * Timers under B6 (CM-355, 394, 422; TASK-6/6a, TASK-25; WEB-10c D-10c-4). PURE.
 *
 * A person has at most ONE running timer per occurrence, across devices; timers of different occurrences run independently and at the
 * same time. A session is known from three places: this device's unsettled timer drafts (a start not sent, a stop or discard on its
 * way), an online read (the occurrence's own sessions, or the account's running ones), and the bounded copy of the last running read
 * kept on this device (W28). A stop of a session this device started uses its local version record; one only a read or the copy knows
 * uses the version they gave.
 */
export const SEVEN_DAYS = 604_800;

/** The timer is offered only for a numeric goal measured in seconds (the server refuses any other). */
export const isTimerGoal = (
  data: Pick<OccurrenceData, "definition">,
): boolean =>
  data.definition.goal.kind === "numeric" &&
  data.definition.goal.unit === "seconds";

export interface RunningSession {
  id: string;
  occurrenceId: string;
  /** Unix seconds. */
  startedAt: number;
  /** The version a stop or discard is checked against, when a read or the copy gave it; null for one only this device's start knows. */
  version: number | null;
  /** Where it is known from (the most authoritative first): a read now, this device's start, or the copy of an earlier read. */
  source: "read" | "draft" | "copy";
  /** This device's unsettled start, if any (its pending mark). */
  startDraft: DraftWithCommand | null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number";

/** A timer draft's command, as the builders wrote it. */
export function timerCommandOf(
  draft: Pick<DraftWithCommand, "kind" | "command">,
): {
  kind: string;
  occurrence: string;
  session: string;
  at: number | null;
} | null {
  if (
    draft.kind !== "start_timer" &&
    draft.kind !== "stop_timer" &&
    draft.kind !== "cancel_timer"
  )
    return null;
  const command = commandOf(draft) as Obj | null;
  if (
    command === null ||
    !str(command.occurrence_id) ||
    !str(command.session_id)
  )
    return null;
  const at =
    draft.kind === "start_timer"
      ? command.started_at
      : draft.kind === "stop_timer"
        ? command.stopped_at
        : null;
  return {
    kind: draft.kind,
    occurrence: command.occurrence_id,
    session: command.session_id,
    at: num(at) ? at : null,
  };
}

const UNSETTLED = new Set(["queued", "in_flight", "blocked", "acknowledged"]);

/**
 * The sessions running on `occurrenceId` for me, from every source, a stop or discard on its way taking a session out (the draft's own
 * conflict blocks speak for a failed one). A finished session in a read is not running whatever the copy says.
 */
export function runningOn(
  occurrenceId: string,
  input: {
    drafts: readonly DraftWithCommand[];
    read: readonly TimerSession[] | null;
    copy: readonly AccountTimerSession[] | null;
  },
): RunningSession[] {
  const out = new Map<string, RunningSession>();
  const ending = new Set<string>();
  const finished = new Set<string>();
  for (const draft of input.drafts) {
    const t = timerCommandOf(draft);
    if (t === null || t.occurrence !== occurrenceId) continue;
    if (t.kind !== "start_timer" && UNSETTLED.has(draft.status))
      ending.add(t.session);
  }
  for (const s of input.read ?? []) {
    if (s.occurrence_id !== occurrenceId) continue;
    if (s.stopped_at !== null) finished.add(s.id);
  }
  for (const s of input.copy ?? []) {
    if (s.access !== "available" || s.occurrence_id !== occurrenceId) continue;
    if (s.stopped_at !== null || finished.has(s.id)) continue;
    out.set(s.id, {
      id: s.id,
      occurrenceId,
      startedAt: s.started_at,
      version: s.version,
      source: "copy",
      startDraft: null,
    });
  }
  for (const draft of input.drafts) {
    const t = timerCommandOf(draft);
    if (t === null || t.kind !== "start_timer" || t.occurrence !== occurrenceId)
      continue;
    if (
      !UNSETTLED.has(draft.status) ||
      t.at === null ||
      finished.has(t.session)
    )
      continue;
    const known = out.get(t.session);
    out.set(t.session, {
      id: t.session,
      occurrenceId,
      startedAt: t.at,
      version: known?.version ?? null,
      source: "draft",
      startDraft: draft,
    });
  }
  for (const s of input.read ?? []) {
    if (s.occurrence_id !== occurrenceId || s.stopped_at !== null) continue;
    const draft = out.get(s.id)?.startDraft ?? null;
    out.set(s.id, {
      id: s.id,
      occurrenceId,
      startedAt: s.started_at,
      version: s.version,
      source: "read",
      startDraft: draft,
    });
  }
  for (const id of ending) out.delete(id);
  return [...out.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** `hh:mm:ss` of a running session (never negative). */
export function elapsed(startedAt: number, nowMs: number): string {
  const total = Math.max(0, Math.floor(nowMs / 1000) - startedAt);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Why Start is not offered here, or null. TASK-6a: one running session of mine on THIS occurrence (other occurrences are independent). */
export type StartBlock =
  | "not_open"
  | "covered"
  | "closed"
  | "denied"
  | "running"
  | null;
export function startBlock(input: {
  data: OccurrenceData;
  nowMs: number;
  /** My stream is editable here, or Anyone without a stream and the occurrence editable (DA17-N2). */
  mayRecord: boolean;
  running: readonly RunningSession[];
}): StartBlock {
  const now = Math.floor(input.nowMs / 1000);
  const { data } = input;
  if (data.opens_at !== null && now < data.opens_at) return "not_open";
  if (data.covered_by !== null) return "covered";
  if (
    data.definition.carry === "close_incomplete" &&
    data.closes_at !== null &&
    now >= data.closes_at
  )
    return "closed";
  if (!input.mayRecord) return "denied";
  if (input.running.length > 0) return "running";
  return null;
}

/**
 * How a stop is recorded now: as it is; for a day closed (`close_incomplete`) the time up to its close (`closes_at − 1`); or, beyond the
 * server's 7-day cap, a choice between the first 7 days and discarding the session.
 */
export type StopChoice =
  | { kind: "now"; stoppedAt: number }
  | { kind: "closed"; stoppedAt: number }
  | { kind: "seven_days"; capped: number };
export function stopChoice(
  session: Pick<RunningSession, "startedAt">,
  data: OccurrenceData,
  nowMs: number,
): StopChoice {
  const now = Math.floor(nowMs / 1000);
  let stoppedAt = Math.max(now, session.startedAt + 1);
  let closed = false;
  if (
    data.definition.carry === "close_incomplete" &&
    data.closes_at !== null &&
    stoppedAt >= data.closes_at
  ) {
    stoppedAt = Math.max(data.closes_at - 1, session.startedAt + 1);
    closed = true;
  }
  if (stoppedAt - session.startedAt > SEVEN_DAYS)
    return { kind: "seven_days", capped: session.startedAt + SEVEN_DAYS };
  return closed ? { kind: "closed", stoppedAt } : { kind: "now", stoppedAt };
}

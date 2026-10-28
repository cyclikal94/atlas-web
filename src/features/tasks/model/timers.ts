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
  /**
   * The place in the observation order (W28) of the server observation it is shown from (the read's or the copy's), or null when none
   * gave it one: only this device's start, or a read that genuinely had none. What an end of it is admitted against (revision 7, R32).
   */
  order: number | null;
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
 * What reads of one day observed, as every page of this database recorded it (W28's scope, design assessment DA-T3): the order of the
 * day's latest complete read and what it listed running, and sessions listed finished.
 */
export interface DayScope {
  order: number;
  running: readonly string[];
  ended: readonly string[];
}

/**
 * What decides whether a server-derived running session still stands, as ONE snapshot of this database (W28; revision 4, review R19):
 * every day's scope and the floor. `null` while it is not read (loading, or the store could not be read): nothing is known to be retired,
 * so no ordered positive is trusted (`stillRunning`), never "no corrections".
 */
export interface TimerAuthority {
  scopes: Readonly<Record<string, DayScope>>;
  floor: number;
  /**
   * Revision 5 (review R23): the latest COMPLETE observation of the account's running sessions (kept when a later partial page replaced
   * the copy): a session it does not list was not running at its order, whichever day it belongs to.
   */
  account?: AccountObservation | null;
  /** Sessions any read listed finished (the account's history, a day's read): they never run again, whatever else says so. */
  ended?: ReadonlySet<string>;
  /** A finished session was not kept: a positive whose order is unknown can no longer be told apart, so it is not trusted. */
  endedLost?: boolean;
  /**
   * Revision 6 (review R27): a finished session was not kept, and any positive of this order or an EARLIER one may have listed it running,
   * so none of them is trusted (inclusive; 0 or absent: none lost). The floor is the other kind of loss (a complete observation's absence,
   * which says nothing about its own order: exclusive).
   */
  endedThrough?: number;
}

/**
 * Whether a server positive of `order` may be trusted against what this database LOST (revision 6, review R27): the ONE rule both
 * resolvers apply. A lost complete observation retired only what was seen before it (`floor`, exclusive); a lost finished session may be
 * contradicted by any positive issued up to and including the order recorded with it (`endedThrough`, inclusive). A positive whose order
 * is unknown cannot be told apart from one before a lost finished session, so it is not trusted once one was lost (`endedLost`).
 */
export function positiveTrusted(
  loss: Pick<TimerAuthority, "endedLost" | "endedThrough"> & {
    floor?: number;
  },
  order: number | null,
): boolean {
  if (order === null) return loss.endedLost !== true;
  if (loss.floor !== undefined && order < loss.floor) return false;
  // 0: nothing lost (a copy written before the order existed has order 0 and is not distrusted by it).
  const through = loss.endedThrough ?? 0;
  return !(through > 0 && order <= through);
}

/** A complete observation of the account's running sessions: its place in the observation order and what it listed. */
export interface AccountObservation {
  order: number;
  running: readonly string[];
}

/**
 * Whether a session a server read listed RUNNING at `order` still stands against `authority` (revision 4, review R19; revision 5, R23):
 * the rule every consumer applies to every source (the copy, the account's live list, a day's read now or kept), so no consumer offers an
 * action another has retired. Not when any read listed it finished (the account's history or its day's reads); not when its day's latest
 * complete read is LATER and does not list it (a read of another day says nothing about it); not when the account's latest complete
 * observation is LATER and does not list it; not when what may have retired it was not kept (`positiveTrusted`: below the floor, or at or
 * below `endedThrough`). A positive whose order is unknown is retired only by a finished listing, and not trusted once a finished session
 * was lost. `occurrenceId` null: a
 * restricted row, whose day is not known (the account's observations and the floor).
 */
export function stillRunning(
  authority: TimerAuthority | null,
  occurrenceId: string | null,
  sessionId: string,
  order: number | null,
): boolean {
  if (authority === null) return order === null;
  if (authority.ended?.has(sessionId)) return false;
  const scope =
    occurrenceId === null ? undefined : authority.scopes[occurrenceId];
  if (scope?.ended.includes(sessionId)) return false;
  if (!positiveTrusted(authority, order)) return false;
  if (order === null) return true;
  const account = authority.account;
  if (
    account != null &&
    account.order > order &&
    !account.running.includes(sessionId)
  )
    return false;
  return !(
    scope !== undefined &&
    scope.order > order &&
    !scope.running.includes(sessionId)
  );
}

/**
 * The sessions running on `occurrenceId` for me, from every source, a stop or discard on its way taking a session out (the draft's own
 * conflict blocks speak for a failed one).
 *
 * ONE rule for every observation (reviews R2, R11, R14; design assessment DA-T3). What a read SAYS always counts: a session listed
 * running is known (on a first page or a later one, complete or not), and one listed FINISHED, by the day's read here or by any read of
 * the day recorded in its scope, is not running whatever else says so (a finished session never runs again). What an observation does NOT
 * say is evidence only when it is COMPLETE, and only against what was seen EARLIER in this database's observation order (W28's
 * `issueTimerOrder`; never the clock, DA-T2): the day's complete read (`readOrder`), the account's complete running list (the copy,
 * `copyOrder`, `copyComplete`: every row read) and the day's latest complete read in any page (`scope`). A session seen running at an
 * order below one of them, and not listed by it, was cancelled or stopped since. A session seen where the order is unknown is never
 * retired by absence (nothing says which came first); nor is this device's unsettled start, which stays until its draft settles (its read
 * is asked again when the draft's state changes, and a read issued before the server applied the start cannot know it). A day's read
 * issued before `floor` is not trusted for what it saw running: what may have retired it was not kept; nor is the copy (revision 4, review
 * R19: the floor is loss information about every source, not only the day's read). Revision 5 (review R23): the account's latest complete
 * observation (`account`, kept when a partial page replaced the copy) and every session listed finished (`ended`) decide here as they do
 * in `stillRunning`, so the detail and the account's list never disagree; once a finished session was lost (`endedLost`), a read whose
 * order is unknown is not trusted for what it saw running. Revision 6 (review R27): nor is a read or copy of an order at or below
 * `endedThrough` (a lost finished session's bound is inclusive); both resolvers apply `positiveTrusted`.
 */
export function runningOn(
  occurrenceId: string,
  input: {
    drafts: readonly DraftWithCommand[];
    /** The day's sessions the page accepted (every page so far), or null for none. */
    read: readonly TimerSession[] | null;
    /** The read was taken to the end of the day's list: absence in it is evidence. */
    complete?: boolean;
    copy: readonly AccountTimerSession[] | null;
    /** The read's and the copy's places in the observation order (W28); null when unknown. */
    readOrder?: number | null;
    copyOrder?: number | null;
    /** The copy lists every running session of the account its read could see, every row read (review R14). */
    copyComplete?: boolean;
    /** The day's scope (DA-T3), or null. */
    scope?: DayScope | null;
    /** The order below which the day's read is not trusted for a running session (W28's floor). */
    floor?: number;
    /** The account's latest complete observation (revision 5, R23), or null. */
    account?: AccountObservation | null;
    /** Sessions any read listed finished (revision 5, R23). */
    ended?: ReadonlySet<string>;
    /** A finished session was not kept (revision 5, R23). */
    endedLost?: boolean;
    /** Every order up to and including this one may list a finished session that was not kept (revision 6, R27). */
    endedThrough?: number;
  },
): RunningSession[] {
  const out = new Map<string, RunningSession>();
  const ending = new Set<string>();
  const finished = new Set<string>([
    ...(input.scope?.ended ?? []),
    ...(input.ended ?? []),
  ]);
  for (const draft of input.drafts) {
    const t = timerCommandOf(draft);
    if (t === null || t.occurrence !== occurrenceId) continue;
    if (t.kind !== "start_timer" && UNSETTLED.has(draft.status))
      ending.add(t.session);
  }
  const listed = new Set<string>();
  for (const s of input.read ?? []) {
    if (s.occurrence_id !== occurrenceId) continue;
    listed.add(s.id);
    if (s.stopped_at !== null) finished.add(s.id);
  }
  const known = (order: number | null | undefined): order is number =>
    order !== undefined && order !== null;
  // The complete observations, each with what it listed: a session it does not list was not running at its order.
  const complete: Array<{ order: number; lists: ReadonlySet<string> }> = [];
  if (input.read !== null && input.complete === true && known(input.readOrder))
    complete.push({ order: input.readOrder, lists: listed });
  if (
    input.copy !== null &&
    input.copyComplete === true &&
    known(input.copyOrder)
  )
    complete.push({
      order: input.copyOrder,
      lists: new Set(input.copy.map((s) => s.id)),
    });
  if (input.scope && input.scope.order > 0)
    complete.push({
      order: input.scope.order,
      lists: new Set(input.scope.running),
    });
  if (input.account != null)
    complete.push({
      order: input.account.order,
      lists: new Set(input.account.running),
    });
  const retired = (id: string, order: number | null | undefined) =>
    finished.has(id) ||
    (known(order) && complete.some((o) => o.order > order && !o.lists.has(id)));
  const trusted = (order: number | null | undefined) =>
    positiveTrusted(input, known(order) ? order : null);
  const readTrusted = trusted(input.readOrder);
  const copyTrusted = trusted(input.copyOrder);
  for (const s of input.copy ?? []) {
    if (s.access !== "available" || s.occurrence_id !== occurrenceId) continue;
    if (!copyTrusted || s.stopped_at !== null || retired(s.id, input.copyOrder))
      continue;
    out.set(s.id, {
      id: s.id,
      occurrenceId,
      startedAt: s.started_at,
      version: s.version,
      source: "copy",
      startDraft: null,
      order: known(input.copyOrder) ? input.copyOrder : null,
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
      order: known?.order ?? null,
    });
  }
  for (const s of input.read ?? []) {
    if (s.occurrence_id !== occurrenceId || s.stopped_at !== null) continue;
    if (!readTrusted || retired(s.id, input.readOrder)) continue;
    const draft = out.get(s.id)?.startDraft ?? null;
    out.set(s.id, {
      id: s.id,
      occurrenceId,
      startedAt: s.started_at,
      version: s.version,
      source: "read",
      startDraft: draft,
      order: known(input.readOrder) ? input.readOrder : null,
    });
  }
  for (const id of ending) out.delete(id);
  return [...out.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * What a person's end of a timer acted on (revision 7, review R32): the session as it was shown, with the place in the observation order
 * of the observation it was shown from (`RunningSession.order`). `occurrenceId` null: a restricted row (none offers an end).
 */
export interface EndWitness {
  occurrenceId: string | null;
  sessionId: string;
  order: number | null;
}

/**
 * Whether an end of `witness` may still be queued, judged against what is stored NOW (revision 7, review R32): inside the writing
 * transaction (`EnqueueRequest.expectTimer`), so a retirement any page stored before it, notified or not, refuses the end. Not when an end
 * of the session is already on its way (`drafts`: this database's other drafts of the session); not when any read listed it finished; then,
 * this device's own unsettled start stands by itself (a read issued before the server applied it cannot list it, as in `runningOn`);
 * otherwise the server observation it was shown from must still stand (`stillRunning`: absence, the floor and terminal loss alike).
 */
export function endStands(
  authority: TimerAuthority,
  drafts: ReadonlyArray<{ kind: string; status: string }>,
  witness: EndWitness,
): boolean {
  let starting = false;
  for (const draft of drafts) {
    if (!UNSETTLED.has(draft.status)) continue;
    if (draft.kind === "stop_timer" || draft.kind === "cancel_timer")
      return false;
    if (draft.kind === "start_timer") starting = true;
  }
  const scope =
    witness.occurrenceId === null
      ? undefined
      : authority.scopes[witness.occurrenceId];
  if (
    authority.ended?.has(witness.sessionId) ||
    scope?.ended.includes(witness.sessionId)
  )
    return false;
  return (
    starting ||
    stillRunning(
      authority,
      witness.occurrenceId,
      witness.sessionId,
      witness.order,
    )
  );
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

/**
 * Which rows of the copy (W28, opaque until parsed) a read of `occurrenceId`'s sessions retires (design assessment DA-T1): a session it
 * lists finished, always (a stopped session never runs again); one it does not list, only when the read is complete and was issued after
 * the copy (`newer`, decided by the plan from the observation order). Other occurrences' rows, and restricted ones, are never touched.
 */
export function copyCorrection(
  occurrenceId: string,
  sessions: readonly TimerSession[],
  complete: boolean,
): (row: Record<string, unknown>, newer: boolean) => boolean {
  const listed = new Set<string>();
  const finished = new Set<string>();
  for (const s of sessions) {
    if (s.occurrence_id !== occurrenceId) continue;
    listed.add(s.id);
    if (s.stopped_at !== null) finished.add(s.id);
  }
  return (row, newer) =>
    row.occurrence_id === occurrenceId &&
    typeof row.id === "string" &&
    (finished.has(row.id) || (complete && newer && !listed.has(row.id)));
}

/** What a read of `occurrenceId`'s sessions observed of its day (W28's scope, DA-T3): the sessions it listed running, and finished. */
export function dayObservation(
  occurrenceId: string,
  sessions: readonly TimerSession[],
  complete: boolean,
): {
  occurrence_id: string;
  complete: boolean;
  running: string[];
  ended: string[];
} {
  const running: string[] = [];
  const ended: string[] = [];
  for (const s of sessions) {
    if (s.occurrence_id !== occurrenceId) continue;
    (s.stopped_at === null ? running : ended).push(s.id);
  }
  return { occurrence_id: occurrenceId, complete, running, ended };
}

/**
 * Whether a day's read kept in page memory may stand for the database bound now (revision 3, DA-T3): one issued under ANOTHER incarnation
 * may not (its order means nothing here, and what retired its sessions there cannot be seen); one with no incarnation known, or while
 * none is bound, decides by itself as before.
 */
export const keptStands = (
  kept: { incarnation: string | null } | null,
  bound: string | null,
): boolean =>
  kept !== null &&
  (kept.incarnation === null || bound === null || kept.incarnation === bound);

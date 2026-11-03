import type {
  MaterialiseSequenceRow,
  SequenceExpectation,
} from "../../../data";
import type { RetryFacts } from "../api";
import { type Attempt, canonicalBody, nextAttempt } from "./attempt";
import {
  type Caller,
  counted,
  failed,
  gate,
  issue,
  lostPause,
  paused,
  readSchedule,
  rediscovered,
  reset,
  resumable,
  type Schedule,
  unanswered,
  WINDOW_MS,
} from "./retry";
import { addDays } from "./time";

/**
 * The catch-up of a repeating task's occurrences (WEB-04 §3.2/§5.8, WEB-10c D-10c-1/5; WF-TODAY-01 C, WF-TASK-06 E). PURE: every
 * transition of a sequence is decided here, and the runner (`catchup/runner.ts`) only reads, sends and commits what this returns through
 * W27's compare-and-set.
 *
 * A sequence is the work of bringing ONE task up to date through ONE day (`[task_id, through_date]`, the day in the task's zone). Each
 * `materialise` asks for at most 16 slots (`LIMIT`) and is followed by a read of the task's position (`GET /tasks/{id}`'s
 * `materialisation`). It ends when the position is satisfied, and stops (kept, shown, resumed only by the person's "Try again") after
 * `MAX_CALLS` counted calls (`bound`), a call that did not move the position (`no_progress`), a day beyond the server's horizon
 * (`horizon`), a definite refusal (`rejected`, the archived task's `422` included: it is terminal, never "no progress"), the slice being at
 * capacity (`capacity`) or its retry protocol pausing (`unreachable`; revision 10, Decision B, `retry.ts`: the command and the position
 * read each have their own durable schedule, the row's `schedule`, for the caller its phase names). A stop is never restarted
 * automatically, except a `window` pause on an observed reconnection (`resumeOnline`).
 *
 * The attempt (key and canonical body) is written BEFORE it is sent (`submitting`), so an uncertain answer, a reload or another tab's
 * takeover resends the SAME key (the server answers a committed one with its receipt), and a fresh key is minted only after a definite
 * answer. After a success the sequence waits for its position (`awaiting_position_read`, `read_seq` moved): recovery from there only reads
 * again, never sends another `materialise` (CM-440), and a pause there keeps it there (revision 10): a retried read is still a read.
 *
 * Revision 10 (Decision B): each transmission is ADMITTED first (`step`: the schedule's `issued`, written before it is made), so an answer
 * never recorded (a reload, another tab's takeover) counts as lost when it was issued, and the window is never restarted by a reload.
 */
export const LIMIT = 16;
/** The unattended budget of one run (TASK-13: 8 × 16 = 128 slots before the person is asked). */
export const MAX_CALLS = 8;
/** The server generates at most this many days ahead of its today in the task's zone. */
export const HORIZON_DAYS = 31;

export type Sequence = MaterialiseSequenceRow;
export type StopReason = NonNullable<Sequence["stop"]>["reason"];

/** The task's position as `GET /tasks/{id}` answers it. */
export interface Position {
  last_date: string | null;
  pending: boolean;
}

/** The answer to one `materialise`, as the runner classifies it. */
export type SendAnswer =
  | { kind: "ok" }
  | { kind: "uncertain"; requestId?: string; retry?: RetryFacts }
  | { kind: "rejected"; requestId?: string }
  | { kind: "capacity"; requestId?: string };

/** The answer to one position read. */
export type ReadAnswer =
  | { kind: "ok"; position: Position }
  | { kind: "uncertain"; requestId?: string; retry?: RetryFacts }
  | { kind: "rejected"; requestId?: string };

/** The command a sequence sends: always the whole budget (`LIMIT`), through its day. */
export function materialiseCommand(taskId: string, throughDate: string) {
  return {
    kind: "materialise" as const,
    task_id: taskId,
    through_date: throughDate,
    limit: LIMIT,
  };
}

/** The stored row's identity: what a compare-and-set of it expects (its revision included: review R20). */
export const expectationOf = (row: Sequence): SequenceExpectation => ({
  sequence_generation: row.sequence_generation,
  phase: row.phase,
  read_seq: row.read_seq,
  attempt_key: row.attempt?.key ?? null,
  // As stored; W27 reads an absent or unreadable one as 0 on both sides.
  revision: row.revision ?? 0,
});

/** The sequence is over: the server's position covers the day (nothing due through it, or generated through it). */
export function satisfied(
  position: Position,
  throughDate: string,
  today: string,
): boolean {
  if (position.last_date !== null && position.last_date >= throughDate)
    return true;
  return !position.pending && throughDate <= today;
}

/** Beyond the server's horizon: `through_date > today + 31` in the task's zone (the server refuses it with `422`; nothing is sent). */
export const beyondHorizon = (throughDate: string, today: string): boolean =>
  throughDate > addDays(today, HORIZON_DAYS);

const stopped = (
  row: Sequence,
  reason: StopReason,
  requestId?: string,
): Sequence => ({
  ...row,
  phase: "stopped",
  stop:
    requestId === undefined ? { reason } : { reason, request_id: requestId },
});

/**
 * A new sequence for a key that has none, from the position read that found work to do. `null`: nothing to do (satisfied), so nothing is
 * written. A day beyond the horizon is stopped at once (nothing is sent).
 */
export function begin(input: {
  taskId: string;
  throughDate: string;
  trigger: Sequence["trigger"];
  generation: string;
  nowMs: number;
  position: Position;
  today: string;
}): Sequence | null {
  if (satisfied(input.position, input.throughDate, input.today)) return null;
  const row: Sequence = {
    task_id: input.taskId,
    through_date: input.throughDate,
    sequence_generation: input.generation,
    phase: "ready",
    attempt: null,
    read_seq: 0,
    successful_calls: 0,
    last_known_position: input.position.last_date,
    started_at: input.nowMs,
    read_failures: 0,
    stop: null,
    trigger: input.trigger,
    schedule: null,
  };
  return beyondHorizon(input.throughDate, input.today)
    ? stopped(row, "horizon")
    : row;
}

/**
 * `ready` → `submitting`: the attempt to send, written before it is sent. An uncertain attempt of the same body is kept (same key);
 * anything else gets `newKey()`.
 */
export function submit(row: Sequence, newKey: () => string): Sequence {
  const attempt: Attempt = nextAttempt(
    row.attempt,
    materialiseCommand(row.task_id, row.through_date),
    newKey,
  );
  return { ...row, phase: "submitting", attempt };
}

/** The caller a row's phase names (revision 10): the position read after a success, else the command. */
export const callerOf = (row: Sequence): Caller =>
  row.phase === "awaiting_position_read" ||
  (row.phase === "stopped" &&
    row.stop?.reason === "unreachable" &&
    row.attempt === null)
    ? "position"
    : "command";

/** The row's schedule for its caller; an untrusted one reads as none here (`step` pauses it before anything is transmitted). */
const own = (row: Sequence): Schedule | null => {
  const s = readSchedule(row.schedule, callerOf(row));
  return s === "invalid" ? null : s;
};

/** A failure of the row's caller observed at `now`: paced, or paused (kept, with its attempt, for Try again). */
function failure(
  row: Sequence,
  facts: RetryFacts | undefined,
  now: number,
  requestId?: string,
  issued?: Schedule,
): Sequence {
  const caller = callerOf(row);
  const s = issued
    ? unanswered(issued, caller)
    : failed(own(row), caller, facts, now, caller === "position");
  const next = { ...row, read_failures: s.failures, schedule: s };
  return s.pause === null ? next : stopped(next, "unreachable", requestId);
}

/**
 * Revision 17 (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json): the row's issued call,
 * whose transport failure a page observed (its lost-answer fence stands) and whose record no page holds, counted as lost when it is
 * REDISCOVERED at `now` (`retry.ts`'s `rediscovered`: paced from now, never sooner than from its real observation). Its caller and phase
 * are kept: an uncertain command keeps its attempt (the same key and body is resent), a position read stays the row's own read (never
 * another `materialise`). `null`: the row has no call outstanding (its schedule untrusted, or nothing issued): nothing is rediscovered.
 */
export function rediscover(row: Sequence, now: number): Sequence | null {
  const caller = callerOf(row);
  if (row.phase === "stopped") return null;
  const s = readSchedule(row.schedule, caller);
  if (s === null || s === "invalid" || s.issued == null) return null;
  const lost = rediscovered(s, caller, now);
  const next = { ...row, read_failures: lost.failures, schedule: lost };
  return lost.pause === null ? next : stopped(next, "unreachable");
}

/**
 * Revision 17 (review 18's R36-K): the row's caller has no call outstanding and its last failure is recorded (`retry.ts`'s `counted`): a
 * lost-answer fence over it guards nothing. A stop is never so (it is shown, and only the person's Try again goes on from it).
 */
export function settledBehind(row: Sequence): boolean {
  if (row.phase === "stopped") return false;
  const s = readSchedule(row.schedule, callerOf(row));
  return s !== "invalid" && counted(s);
}

/**
 * Revision 18 (review 19's R36-L; design assessment C1): the row is STOPPED by its caller's retry protocol on a lost call (`unreachable`,
 * its schedule `retry.ts`'s `lostPause`, read for the caller its stop names: a held attempt is the command's, none the position read's).
 * A lost-answer fence over it guards nothing; the stop, its revision, its attempt (key and body) and its phase stay as recorded, and only
 * the person's Try again (or an observed reconnection, for a window pause) goes on from it. Any other stop, an earlier build's row (no
 * schedule) or a schedule of another caller is never so.
 */
export function pausedBehind(row: Sequence): boolean {
  if (row.phase !== "stopped" || row.stop?.reason !== "unreachable")
    return false;
  if (row.schedule === undefined) return false;
  return lostPause(readSchedule(row.schedule, callerOf(row)));
}

/** The answer to the attempt held in `submitting`, observed at `now`. */
export function onSent(
  row: Sequence,
  answer: SendAnswer,
  now: number,
): Sequence {
  switch (answer.kind) {
    case "ok":
      return {
        ...row,
        phase: "awaiting_position_read",
        read_seq: row.read_seq + 1,
        attempt: null,
        read_failures: 0,
        schedule: null,
      };
    case "uncertain":
      // It may have committed: the same attempt (key and body) is kept for the next send, or for "Try again" once stopped.
      return failure(row, answer.retry, now, answer.requestId);
    case "rejected":
      return stopped(
        { ...row, attempt: null, schedule: null },
        "rejected",
        answer.requestId,
      );
    case "capacity":
      return stopped(
        { ...row, attempt: null, schedule: null },
        "capacity",
        answer.requestId,
      );
  }
}

/**
 * A position read, admitted only by the caller for the move it was asked after (phase, `read_seq` and generation unchanged, checked by
 * the compare-and-set). In `awaiting_position_read` it counts the call and decides; in `ready` it is the read before the next call.
 * `null`: the sequence is over (delete it).
 */
export function onRead(
  row: Sequence,
  answer: ReadAnswer,
  today: string,
  now: number,
): Sequence | null {
  if (answer.kind === "uncertain")
    return failure(row, answer.retry, now, answer.requestId);
  if (answer.kind === "rejected")
    return stopped(
      { ...row, attempt: null, schedule: null },
      "rejected",
      answer.requestId,
    );
  const position = answer.position;
  if (satisfied(position, row.through_date, today)) return null;
  if (row.phase !== "awaiting_position_read")
    return beyondHorizon(row.through_date, today)
      ? stopped({ ...row, read_failures: 0, schedule: null }, "horizon")
      : {
          ...row,
          read_failures: 0,
          last_known_position: position.last_date,
          schedule: null,
        };
  const calls = row.successful_calls + 1;
  const moved =
    position.last_date !== null &&
    (row.last_known_position === null ||
      position.last_date > row.last_known_position);
  const next: Sequence = {
    ...row,
    phase: "ready",
    successful_calls: calls,
    last_known_position: position.last_date,
    read_failures: 0,
    schedule: null,
  };
  if (!moved) return stopped(next, "no_progress");
  if (calls >= MAX_CALLS) return stopped(next, "bound");
  return beyondHorizon(row.through_date, today)
    ? stopped(next, "horizon")
    : next;
}

/**
 * Where a stopped sequence carries on (revision 10): an uncertain attempt is resent (same key and body), a paused position read is read
 * again (never another `materialise`: the command it follows succeeded), anything else begins with the next command.
 */
const continuation = (row: Sequence): Sequence["phase"] =>
  row.attempt !== null
    ? "submitting"
    : callerOf(row) === "position"
      ? "awaiting_position_read"
      : "ready";

/**
 * The person's "Try again" on a stopped sequence at `now`: a fresh budget (calls and failures back to 0) from the position it reached; the
 * generation and an uncertain attempt are kept, so a held attempt is resent with its own key, and a paused position read stays a read.
 * A still-future server deadline is kept (revision 10). Anything but a stop is returned unchanged.
 */
export function tryAgain(row: Sequence, now: number): Sequence {
  if (row.phase !== "stopped") return row;
  return {
    ...row,
    phase: continuation(row),
    successful_calls: 0,
    read_failures: 0,
    stop: null,
    schedule: reset(own(row), now, true),
  };
}

/**
 * Revision 10 (Decision B): an observed reconnection at `now` resumes a sequence paused by its window only (never another stop), where it
 * stopped: its counted calls, its unrecognised streak and a server deadline are kept. Anything else is returned unchanged.
 */
export function resumeOnline(row: Sequence, now: number): Sequence {
  const s = own(row);
  if (row.phase !== "stopped" || !resumable(s)) return row;
  return {
    ...row,
    phase: continuation(row),
    read_failures: 0,
    stop: null,
    schedule: reset(s, now, false),
  };
}

/**
 * Revision 10 (Decision B): what the runner does with a row it is about to work on at `now`, BEFORE anything is transmitted: `write` a
 * transition first (a row of an earlier build whose uncertainty has no trustworthy schedule, or an untrusted schedule, stopped for the
 * person; an issue whose answer was never recorded, counted as lost; a window that ended), `wait` until the schedule admits the next
 * transmission, or `send`/`read`: the admitted row to write before transmitting (`until`: the window's end, which no hidden resend
 * crosses).
 */
export type Step =
  | { kind: "write"; next: Sequence }
  | { kind: "wait"; at: number }
  | { kind: "send" | "read"; next: Sequence; until: number };

export function step(row: Sequence, now: number, newKey: () => string): Step {
  const caller = callerOf(row);
  const stop = (s: Schedule | null, pause: Parameters<typeof paused>[2]) => ({
    kind: "write" as const,
    next: stopped(
      { ...row, schedule: paused(s, caller, pause, now) },
      "unreachable",
    ),
  });
  if (
    row.schedule === undefined &&
    (row.phase === "submitting" ||
      row.attempt !== null ||
      row.read_failures > 0)
  )
    // An earlier build's row: a held attempt (whatever its phase; revision 11, review R36), or a read that had failed, has no schedule
    // to carry on from. A row with neither (a `ready` row, an awaiting read never answered wrongly) carries on.
    return stop(null, "legacy");
  const s = readSchedule(row.schedule, caller);
  if (s === "invalid") return stop(null, "clock");
  if (s?.issued != null)
    return { kind: "write", next: failure(row, undefined, now, undefined, s) };
  const g = gate(s, now);
  if (g.kind === "pause") return stop(s, g.pause);
  if (g.kind === "wait") return g;
  const until =
    s?.since == null ? Number.POSITIVE_INFINITY : s.since + WINDOW_MS;
  // The command's attempt is written with its admission: a new one from `ready` (or a `submitting` row holding none), else the held one.
  const base =
    caller === "command" && row.attempt === null ? submit(row, newKey) : row;
  return {
    kind: caller === "position" ? "read" : "send",
    next: { ...base, schedule: issue(s, caller, now) },
    until,
  };
}

/** What a runner does with a stored sequence it finds (a reload, another tab's, a crash). */
export type Recovery = "send" | "read" | "continue" | "stopped";
export function recover(row: Sequence): Recovery {
  switch (row.phase) {
    case "submitting":
      return row.attempt === null ? "continue" : "send";
    case "awaiting_position_read":
      return "read";
    case "ready":
      return "continue";
    case "stopped":
      return "stopped";
  }
}

/** The canonical body an attempt carries (the runner sends exactly this, parsed back). */
export const attemptBody = (taskId: string, throughDate: string): string =>
  canonicalBody(materialiseCommand(taskId, throughDate));

import type {
  MaterialiseSequenceRow,
  SequenceExpectation,
} from "../../../data";
import { type Attempt, canonicalBody, nextAttempt } from "./attempt";
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
 * capacity (`capacity`) or `MAX_READ_FAILURES` consecutive uncertain answers (`unreachable`). A stop is never restarted automatically.
 *
 * The attempt (key and canonical body) is written BEFORE it is sent (`submitting`), so an uncertain answer, a reload or another tab's
 * takeover resends the SAME key (the server answers a committed one with its receipt), and a fresh key is minted only after a definite
 * answer. After a success the sequence waits for its position (`awaiting_position_read`, `read_seq` moved): recovery from there only reads
 * again, never sends another `materialise` (CM-440).
 */
export const LIMIT = 16;
/** The unattended budget of one run (TASK-13: 8 × 16 = 128 slots before the person is asked). */
export const MAX_CALLS = 8;
export const MAX_READ_FAILURES = 3;
/** The server generates at most this many days ahead of its today in the task's zone. */
export const HORIZON_DAYS = 31;
/** The waits before resending after the first and second uncertain answer (the third stops). */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

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
  | { kind: "uncertain"; requestId?: string }
  | { kind: "rejected"; requestId?: string }
  | { kind: "capacity"; requestId?: string };

/** The answer to one position read. */
export type ReadAnswer =
  | { kind: "ok"; position: Position }
  | { kind: "uncertain" }
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

/** The stored row's identity: what a compare-and-set of it expects. */
export const expectationOf = (row: Sequence): SequenceExpectation => ({
  sequence_generation: row.sequence_generation,
  phase: row.phase,
  read_seq: row.read_seq,
  attempt_key: row.attempt?.key ?? null,
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

/** The answer to the attempt held in `submitting`. */
export function onSent(row: Sequence, answer: SendAnswer): Sequence {
  switch (answer.kind) {
    case "ok":
      return {
        ...row,
        phase: "awaiting_position_read",
        read_seq: row.read_seq + 1,
        attempt: null,
        read_failures: 0,
      };
    case "uncertain": {
      // It may have committed: the same attempt (key and body) is kept for the next send, or for "Try again" once stopped.
      const failures = row.read_failures + 1;
      const next = { ...row, read_failures: failures };
      return failures >= MAX_READ_FAILURES
        ? stopped(next, "unreachable", answer.requestId)
        : next;
    }
    case "rejected":
      return stopped({ ...row, attempt: null }, "rejected", answer.requestId);
    case "capacity":
      return stopped({ ...row, attempt: null }, "capacity", answer.requestId);
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
): Sequence | null {
  if (answer.kind === "uncertain") {
    const failures = row.read_failures + 1;
    const next = { ...row, read_failures: failures };
    return failures >= MAX_READ_FAILURES ? stopped(next, "unreachable") : next;
  }
  if (answer.kind === "rejected")
    return stopped({ ...row, attempt: null }, "rejected", answer.requestId);
  const position = answer.position;
  if (satisfied(position, row.through_date, today)) return null;
  if (row.phase !== "awaiting_position_read")
    return beyondHorizon(row.through_date, today)
      ? stopped({ ...row, read_failures: 0 }, "horizon")
      : {
          ...row,
          read_failures: 0,
          last_known_position: position.last_date,
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
  };
  if (!moved) return stopped(next, "no_progress");
  if (calls >= MAX_CALLS) return stopped(next, "bound");
  return beyondHorizon(row.through_date, today)
    ? stopped(next, "horizon")
    : next;
}

/**
 * The person's "Try again" on a stopped sequence: a fresh budget (calls and failures back to 0) from the position it reached; the
 * generation and an uncertain attempt are kept, so a held attempt is resent with its own key. Anything but a stop is returned unchanged.
 */
export function tryAgain(row: Sequence): Sequence {
  if (row.phase !== "stopped") return row;
  return {
    ...row,
    phase: row.attempt === null ? "ready" : "submitting",
    successful_calls: 0,
    read_failures: 0,
    stop: null,
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

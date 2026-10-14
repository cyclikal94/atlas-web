import type { EnrolCommand } from "./api";
import { canonicalBody } from "./model/attempt";
import type { Outcome } from "./model/contract";

/**
 * Page memory of the task screens, per displayed identity (`account:epoch`), for the page's lifetime; nothing here is written to storage.
 *
 * Why it lives outside the components: an ordinary `403` closes the protected display while the session classifies it and REOPENS it,
 * which remounts the protected tree and every screen in it (D-12a-13, the WEB-13a lesson). A screen that asked again on mount would be
 * refused again, and so on. So a `403`/`404` on a mount-time read is remembered here and asked again only on an explicit "Try again", and
 * the last joint answers outlive a remount (Q8's "as of {time}").
 */
export interface JointAnswer {
  outcome: Outcome;
  periodOutcome: Outcome;
  actionable: boolean;
  /** When the answer was received (ms). */
  at: number;
}

/**
 * The enrolment change of one task this page is sending or could not confirm (revision 4, R11; design assessment C4), per identity: taken
 * SYNCHRONOUSLY before the request is made, so a second activation while it is `pending` sends nothing (never a second key for the same
 * change), and kept through a remount of the protected tree. `uncertain` (no definite answer: it may have committed) keeps the exact
 * command and key: Try again resends them unchanged. A definite answer ends it. Page memory only: a reload starts with none and never
 * resends anything (the next change is a new attempt, read against the enrolment read again).
 */
export interface EnrolmentAttempt {
  key: string;
  body: string;
  command: EnrolCommand;
  phase: "pending" | "uncertain";
}

interface IdentityMemory {
  refused: Map<string, "forbidden" | "not_found">;
  joint: Map<string, JointAnswer>;
  enrolment: Map<string, EnrolmentAttempt>;
}

const LIMIT = 2_000;
const memories = new Map<string, IdentityMemory>();

function memoryOf(identity: string): IdentityMemory {
  let memory = memories.get(identity);
  if (memory === undefined) {
    // Only the displayed identity is kept: an earlier one's answers are never shown under another (and are dropped here).
    memories.clear();
    memory = { refused: new Map(), joint: new Map(), enrolment: new Map() };
    memories.set(identity, memory);
  }
  return memory;
}

const bounded = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

/** A mount-time read (`daily:…`, `task:<id>`, `enrolment:<id>`, `journal:<id>`) that was refused for this identity. */
export const refusalOf = (
  identity: string,
  read: string,
): "forbidden" | "not_found" | null =>
  memoryOf(identity).refused.get(read) ?? null;

export function noteRefusal(
  identity: string,
  read: string,
  kind: "forbidden" | "not_found",
): void {
  bounded(memoryOf(identity).refused, read, kind);
}

/**
 * Records a refusal of a mount-time read AS SOON AS THE ANSWER ARRIVES, whatever became of the screen that asked: the session closes and
 * reopens the display on a `403` before the screen's own continuation runs, so a screen that remembered it only while mounted would be
 * remounted, ask again and be refused again, for ever (measured natively: dozens of `/daily` reads a second).
 */
export function noteIfRefused(
  identity: string,
  read: string,
  result: { ok: boolean; kind?: string },
): void {
  if (
    !result.ok &&
    (result.kind === "forbidden" || result.kind === "not_found")
  )
    noteRefusal(identity, read, result.kind);
}

/** "Try again": the person asks for the read again. */
export function forgetRefusal(identity: string, read: string): void {
  memoryOf(identity).refused.delete(read);
}

export function noteJoint(
  identity: string,
  occurrenceId: string,
  answer: JointAnswer,
): void {
  bounded(memoryOf(identity).joint, occurrenceId, answer);
}

export const jointOf = (
  identity: string,
  occurrenceId: string,
): JointAnswer | null => memoryOf(identity).joint.get(occurrenceId) ?? null;

const enrolmentListeners = new Set<() => void>();
const enrolmentChanged = (): void => {
  for (const listener of [...enrolmentListeners]) listener();
};
export function subscribeEnrolment(listener: () => void): () => void {
  enrolmentListeners.add(listener);
  return () => enrolmentListeners.delete(listener);
}

export const enrolmentAttemptOf = (
  identity: string,
  taskId: string,
): EnrolmentAttempt | null => memoryOf(identity).enrolment.get(taskId) ?? null;

/**
 * Takes the attempt for `command` before anything is sent: null while another one of the task is pending (nothing is sent). The same body
 * as an uncertain attempt keeps its key; any other body is a new attempt with a new key (it replaces the uncertain one).
 */
export function startEnrolment(
  identity: string,
  taskId: string,
  command: EnrolCommand,
  newKey: () => string,
): EnrolmentAttempt | null {
  const memory = memoryOf(identity);
  const held = memory.enrolment.get(taskId);
  if (held?.phase === "pending") return null;
  const body = canonicalBody(command);
  const attempt: EnrolmentAttempt = {
    key: held !== undefined && held.body === body ? held.key : newKey(),
    body,
    command,
    phase: "pending",
  };
  bounded(memory.enrolment, taskId, attempt);
  enrolmentChanged();
  return attempt;
}

/** The answer to `attempt`: only the attempt still held for the displayed identity is settled (another identity's is gone). */
export function settleEnrolment(
  identity: string,
  taskId: string,
  attempt: EnrolmentAttempt,
  outcome: "definite" | "uncertain",
): void {
  const memory = memories.get(identity);
  if (memory === undefined || memory.enrolment.get(taskId) !== attempt) return;
  if (outcome === "uncertain")
    memory.enrolment.set(taskId, { ...attempt, phase: "uncertain" });
  else memory.enrolment.delete(taskId);
  enrolmentChanged();
}

/** For tests: forget everything. */
export function forgetTaskMemory(): void {
  memories.clear();
}

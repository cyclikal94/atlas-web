import type { Policy } from "../../data";
import type { EnrolCommand } from "./api";
import { canonicalBody } from "./model/attempt";
import type { Enrolment, Outcome } from "./model/contract";

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
 * command and key: Try again resends them unchanged (the command is a frozen copy of the canonical body, its policy included: revision 10,
 * R22). A definite answer ends it. Page memory only: a reload starts with none and never
 * resends anything (the next change is a new attempt, read against the enrolment read again).
 */
export interface EnrolmentAttempt {
  key: string;
  body: string;
  command: EnrolCommand;
  phase: "pending" | "uncertain";
  /** The editor revision this change submitted (an audience Save or a Join), or null (Leave, the consent: they submit no draft). */
  ticket: EnrolmentTicket | null;
}

/** An editor session and the revision of it that a change submitted (revision 12, R25; design assessment C2). */
export interface EnrolmentTicket {
  session: number;
  revision: number;
}

/**
 * The unsaved change of one task's enrolment settings (revision 12, R23/R25; design assessment C1/I3): owned by the page, per identity, like
 * the attempt and the cycle, so an ordinary remount of the protected tree keeps it (the settings only show it). `base` is the enrolment read
 * when it began, whose version is the command's guard (it is never moved onto another version); `session` is never reused, and `revision`
 * counts the edits accepted (0: an editor opened and not edited, which holds nothing of the person's). It ends ONLY when a change that
 * submitted exactly this session and revision was ACKNOWLEDGED and a current read followed (`answerEnrolment`), on Discard, or when the
 * enrolment can no longer be read (a 403/404) or the identity changes. Never by being sent, refused, uncertain, or by a read showing
 * another version: then it is kept, unsaved, beside the settings read.
 */
export interface EnrolmentDraft {
  session: number;
  base: Enrolment;
  policy: Policy;
  /** The join form's consent choice; null until chosen (an enrolled person's audience edit has none). */
  consent: boolean | null;
  revision: number;
}

/**
 * The change CYCLE of one task's enrolment (revision 11, R23; design assessment C1/C2): from the moment a change is admitted until a read
 * asked after its answer is accepted, the enrolment is not edited or changed again (`sending`, then `reading`). An answer is not the
 * current state (a receipt is a revision, not the enrolment), so the read that follows it ends the cycle; a later change starts the next
 * `generation`. Reads are numbered: only one asked after the latest change was answered, and newer than the one shown, is the current
 * state. Page memory, per identity, like the attempt: an ordinary remount keeps it, a reload or another identity starts without it.
 */
export interface EnrolmentCycle {
  generation: number;
  phase: "sending" | "reading" | "done";
  asked: number;
  shown: number;
  /** The draft revision this cycle's change saved (a success answered it), consumed by the read that ends the cycle; else null. */
  acknowledged: EnrolmentTicket | null;
}

/** What a read was asked under: the latest change then, whether it had been answered, and the read's number. */
export interface EnrolmentRead {
  generation: number;
  after: boolean;
  seq: number;
}

interface IdentityMemory {
  refused: Map<string, "forbidden" | "not_found">;
  joint: Map<string, JointAnswer>;
  enrolment: Map<string, EnrolmentAttempt>;
  cycles: Map<string, EnrolmentCycle>;
  drafts: Map<string, EnrolmentDraft>;
}

let limit = 2_000;
const memories = new Map<string, IdentityMemory>();
/** Editor sessions, never reused (not even after `forgetTaskMemory`): a late answer can never match a session begun after it. */
let sessions = 0;

function memoryOf(identity: string): IdentityMemory {
  let memory = memories.get(identity);
  if (memory === undefined) {
    // Only the displayed identity is kept: an earlier one's answers are never shown under another (and are dropped here).
    memories.clear();
    memory = {
      refused: new Map(),
      joint: new Map(),
      enrolment: new Map(),
      cycles: new Map(),
      drafts: new Map(),
    };
    memories.set(identity, memory);
  }
  return memory;
}

const bounded = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
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
  const memory = memoryOf(identity);
  bounded(memory.refused, read, kind);
  // The enrolment can no longer be read: its unsaved change is not kept for a later grant of access (revision 12, design assessment Q6).
  if (read.startsWith("enrolment:") && memory.drafts.delete(read.slice(10)))
    enrolmentChanged();
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

/** Whether the task's enrolment holds anything of the person's or in progress (a change, an unsaved draft, an unconfirmed cycle). */
const owned = (memory: IdentityMemory, taskId: string): boolean =>
  memory.enrolment.has(taskId) ||
  memory.drafts.has(taskId) ||
  (memory.cycles.get(taskId)?.phase ?? "done") !== "done";

/**
 * Whether a NEW change or draft of the task must be refused because the page already holds `limit` (design assessment C6/I8): nothing the
 * person began is ever evicted to make room; a task that already holds one is never refused.
 */
function full(memory: IdentityMemory, taskId: string): boolean {
  return (
    !owned(memory, taskId) &&
    memory.enrolment.size + memory.drafts.size >= limit
  );
}

export const enrolmentFull = (identity: string, taskId: string): boolean =>
  full(memoryOf(identity), taskId);

function cycleOf(memory: IdentityMemory, taskId: string): EnrolmentCycle {
  let cycle = memory.cycles.get(taskId);
  if (cycle === undefined) {
    cycle = {
      generation: 0,
      phase: "done",
      asked: 0,
      shown: 0,
      acknowledged: null,
    };
    memory.cycles.set(taskId, cycle);
    // Only a cycle with nothing in progress or held is reclaimed, the oldest first (never one that still owns the settings).
    if (memory.cycles.size > limit)
      for (const id of memory.cycles.keys())
        if (id !== taskId && !owned(memory, id)) {
          memory.cycles.delete(id);
          break;
        }
  }
  return cycle;
}

/** The change of the task being sent or confirmed (nothing can be edited or changed meanwhile), or null. */
export function enrolmentLock(
  identity: string,
  taskId: string,
): { phase: "sending" | "reading"; generation: number } | null {
  const cycle = memoryOf(identity).cycles.get(taskId);
  return cycle === undefined || cycle.phase === "done"
    ? null
    : { phase: cycle.phase, generation: cycle.generation };
}

/** Numbers a read of the enrolment as it is asked. */
export function askEnrolment(identity: string, taskId: string): EnrolmentRead {
  const cycle = cycleOf(memoryOf(identity), taskId);
  cycle.asked += 1;
  return {
    generation: cycle.generation,
    after: cycle.phase !== "sending",
    seq: cycle.asked,
  };
}

/**
 * What the answer to `read` is: `current` (asked after the latest change was answered, nothing admitted since, and newer than the read
 * shown: the enrolment as it is), `early` (asked while that change was being sent: it may predate it) or `outdated` (a change was
 * admitted after it was asked, a newer read was shown, or the identity is gone). A successful current read (`value`, the enrolment read;
 * null: the read failed, and is only judged) records it as shown, ends that change's cycle and, with it, the draft its success acknowledged
 * (revision 12, R25).
 */
export function answerEnrolment(
  identity: string,
  taskId: string,
  read: EnrolmentRead,
  value: Enrolment | null,
): "current" | "early" | "outdated" {
  const memory = memories.get(identity);
  const cycle = memory?.cycles.get(taskId);
  if (
    memory === undefined ||
    cycle === undefined ||
    read.generation !== cycle.generation ||
    read.seq <= cycle.shown
  )
    return "outdated";
  if (!read.after) return "early";
  if (value !== null) {
    cycle.shown = read.seq;
    const draft = memory.drafts.get(taskId);
    const saved = cycle.acknowledged;
    if (cycle.phase === "reading") {
      cycle.phase = "done";
      cycle.acknowledged = null;
    }
    // The current state ends only the draft revision a success acknowledged (revision 12, R25: not one refused, uncertain or merely
    // sent; not a later revision or session), and an editor opened at another version with nothing in it.
    if (
      draft !== undefined &&
      ((saved !== null &&
        saved.session === draft.session &&
        saved.revision === draft.revision) ||
        (draft.revision === 0 && draft.base.version !== value.version))
    )
      memory.drafts.delete(taskId);
    enrolmentChanged();
  }
  return "current";
}

export const enrolmentAttemptOf = (
  identity: string,
  taskId: string,
): EnrolmentAttempt | null => memoryOf(identity).enrolment.get(taskId) ?? null;

const frozen = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
};

/**
 * Takes the attempt for `command` before anything is sent: null while another change of the task is pending or not yet confirmed by a
 * read (its cycle; nothing is sent). The same body as an uncertain attempt keeps its key; any other body is a new attempt with a new key
 * (it replaces the uncertain one).
 */
export function startEnrolment(
  identity: string,
  taskId: string,
  command: EnrolCommand,
  newKey: () => string,
  ticket: EnrolmentTicket | null = null,
): EnrolmentAttempt | null {
  const memory = memoryOf(identity);
  const held = memory.enrolment.get(taskId);
  if (full(memory, taskId)) return null;
  const cycle = cycleOf(memory, taskId);
  if (held?.phase === "pending" || cycle.phase !== "done") return null;
  cycle.generation += 1;
  cycle.phase = "sending";
  cycle.acknowledged = null;
  const body = canonicalBody(command);
  const attempt: EnrolmentAttempt = {
    key: held !== undefined && held.body === body ? held.key : newKey(),
    body,
    // Captured whole (R22): a copy of the body, nested policy included, frozen, so nothing the caller still holds can change it.
    command: frozen(JSON.parse(body)) as EnrolCommand,
    phase: "pending",
    // A retry of the held change submits what it submitted; an explicit Save/Join names its own draft revision (revision 12, C3).
    ticket: ticket ?? (held?.body === body ? held.ticket : null),
  };
  memory.enrolment.delete(taskId);
  memory.enrolment.set(taskId, attempt);
  enrolmentChanged();
  return attempt;
}

/**
 * The answer to `attempt`: only the attempt still held for the displayed identity is settled (another identity's is gone). Its cycle then
 * waits for a read asked after it (`reading`).
 */
export function settleEnrolment(
  identity: string,
  taskId: string,
  attempt: EnrolmentAttempt,
  outcome: "saved" | "refused" | "uncertain",
): void {
  const memory = memories.get(identity);
  if (memory === undefined || memory.enrolment.get(taskId) !== attempt) return;
  if (outcome === "uncertain")
    memory.enrolment.set(taskId, { ...attempt, phase: "uncertain" });
  else memory.enrolment.delete(taskId);
  const cycle = memory.cycles.get(taskId);
  if (cycle?.phase === "sending") {
    cycle.phase = "reading";
    // Only a success acknowledges what was submitted (revision 12, R25): a refusal's draft is kept, as is an uncertain one's.
    if (outcome === "saved") cycle.acknowledged = attempt.ticket;
  }
  enrolmentChanged();
}

export const enrolmentDraftOf = (
  identity: string,
  taskId: string,
): EnrolmentDraft | null => memoryOf(identity).drafts.get(taskId) ?? null;

/**
 * Opens the audience editor ("Change…"): a new session from `base`, its policy a copy. An unsaved draft is never replaced (only an opened,
 * unedited one); refused (false) while the task's change is sent or confirmed, or when the page is full.
 */
export function openEnrolmentDraft(
  identity: string,
  taskId: string,
  base: Enrolment,
): boolean {
  const memory = memoryOf(identity);
  const held = memory.drafts.get(taskId);
  if (
    (held !== undefined && held.revision > 0) ||
    enrolmentLock(identity, taskId) !== null ||
    full(memory, taskId)
  )
    return false;
  sessions += 1;
  memory.drafts.set(
    taskId,
    frozen({
      session: sessions,
      base: JSON.parse(JSON.stringify(base)) as Enrolment,
      policy: copyOf(base.policy),
      consent: null,
      revision: 0,
    }),
  );
  enrolmentChanged();
  return true;
}

const copyOf = (policy: Policy): Policy =>
  JSON.parse(JSON.stringify(policy)) as Policy;

/**
 * An edit accepted for the draft made to `base` (begun from `seed` when there is none): refused (false) while the task's change is sent or
 * confirmed (checked when it HAPPENS), when the draft held is of another version (a kept draft is never edited) or the page is full.
 */
export function editEnrolmentDraft(
  identity: string,
  taskId: string,
  base: Enrolment,
  seed: Policy,
  next: { policy?: Policy; consent?: boolean },
): boolean {
  const memory = memoryOf(identity);
  let draft = memory.drafts.get(taskId);
  if (
    enrolmentLock(identity, taskId) !== null ||
    (draft !== undefined && draft.base.version !== base.version)
  )
    return false;
  if (draft === undefined) {
    if (full(memory, taskId)) return false;
    sessions += 1;
    draft = {
      session: sessions,
      base: JSON.parse(JSON.stringify(base)) as Enrolment,
      policy: seed,
      consent: null,
      revision: 0,
    };
  }
  memory.drafts.set(
    taskId,
    frozen({
      ...draft,
      policy: copyOf(next.policy ?? draft.policy),
      consent: next.consent ?? draft.consent,
      revision: draft.revision + 1,
    }),
  );
  enrolmentChanged();
  return true;
}

/**
 * Discard/Cancel: ends `session` only (a draft begun since is not touched), and not while a change is sent or confirmed; an uncertain change
 * is not forgotten by it.
 */
export function discardEnrolmentDraft(
  identity: string,
  taskId: string,
  session: number,
): void {
  const memory = memoryOf(identity);
  if (
    enrolmentLock(identity, taskId) === null &&
    memory.drafts.get(taskId)?.session === session
  ) {
    memory.drafts.delete(taskId);
    enrolmentChanged();
  }
}

/** For tests: forget everything (and, given, hold at most `capacity` enrolment changes and drafts). */
export function forgetTaskMemory(capacity = 2_000): void {
  memories.clear();
  limit = capacity;
}

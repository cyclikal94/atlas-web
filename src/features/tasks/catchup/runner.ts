import {
  type AccountService,
  clearSatisfiedSequences,
  commitMaterialiseDiscovery,
  commitMaterialiseLift,
  commitMaterialiseSequence,
  type DataEnv,
  DISCOVERY_REQUEST_ID,
  type MaterialiseDiscovery,
  type MaterialiseSequenceRow,
  type PageDataHost,
  readMaterialiseDiscoveryNow,
  readMaterialiseSequenceNow,
  readSequencePageNow,
  readTaskSequencesNow,
  type SequenceKey,
} from "../../../data";
import type { MaterialiseCommand, TasksApi, TasksResult } from "../api";
import { noteIfRefused } from "../memory";
import { parseDefinition } from "../model/contract";
import {
  begin,
  callerOf,
  expectationOf,
  tryAgain as freshBudget,
  onRead,
  onSent,
  type Position,
  type ReadAnswer,
  resumeOnline,
  type SendAnswer,
  type Sequence,
  satisfied,
  step,
} from "../model/materialise";
import {
  failed,
  gate,
  issue,
  paused as pausedSchedule,
  readSchedule,
  reset,
  resumable,
  type Schedule,
  unanswered,
  WINDOW_MS,
  withdrawn,
} from "../model/retry";
import { todayIn } from "../model/time";
import type { PageLifecycle } from "./lifecycle";

/**
 * The catch-up RUNNER of one page for one displayed identity (D-10c-1/3/5). It is an online feature service, not outbox drafts: both
 * triggers that occur against the released backend (Today's `pending_tasks`, the streak's `materialisation_required`) are online reads,
 * and so is the position read. Every attempt is sent directly through the stamped client, and the sequence record (W27) carries the
 * attempt's key and body durably BEFORE it is sent.
 *
 * One runner per ACCOUNT across tabs: the work runs while this page holds the Web Lock `atlas-materialise:<account>` (requested and
 * waited for; a page that does not hold it shows the other page's progress from the durable records, and takes over when that page goes).
 * Never `locks.query()` (lint R2). The runner sends only while the device is online and the API contract is `supported` (B2: the same
 * fact the outbox's dispatcher reads, `TasksEnv.writable`); otherwise its work waits for `kick()`.
 *
 * One task at a time, in the order asked. At most one AUTOMATIC sequence per `(task, through_date)` per page: a stopped sequence is shown
 * and resumed only by the person's "Try again", so a stop never loops; a new day is a new key. Everything is bound to the identity and
 * the database binding it was made for: an identity that moves disposes the runner, a late answer is dropped by W27's guards, and a
 * `401`, `not_sent` or `closed` answer writes nothing.
 *
 * DISCOVERY (review R13, design assessment DA-M1): the first read of a task (its zone and position, before a day and so a sequence row
 * can exist) keeps its failures and its stop in W27's discovery entry, written BEFORE another read is made, so its budget is the task's,
 * not this call's: a pause, a reload or another tab's turn carries on from the count reached, and a stop (three uncertain answers, or a
 * definite refusal) admits no automatic read again, whichever trigger asks (Today's list, the streak, a command's retry, a kick). Only
 * the person's "Try again" admits a fresh budget, once: it is made under the account's lock, against the stop it was pressed on (a
 * second press, here or in another tab, finds the stop already lifted and adds nothing), and every write of a discovery compares the
 * entry it decided on, so a late answer of an earlier budget never changes a newer one. A stop whose write failed is kept in this page's
 * memory (`unrecorded`) and refuses automatic work here alike. An environmental pause (offline, not compatible, the session held) is
 * not a stop: it resumes.
 *
 * ADMISSION (revision 3, review R16): no first read is sent before it is ADMITTED in the task's entry (a fresh `attempt`, written first),
 * so every read's answer can be recorded: a new task's entry is admitted through the quota ledger, and one the ledger refuses sends
 * nothing (a `storage` stop of this page, with "Try again"; a reload asks again, sending nothing until it is admitted). Each answer is
 * recorded only over its own attempt, so a read another page admitted since (a page without Web Locks), or one of an entry deleted and
 * made again, changes nothing, and a lost claim never consumes another budget.
 *
 * BINDING (revision 3, review R17): each piece of work belongs to the service it began with (`Binding`: the exact service object, the
 * database incarnation it writes). It reads, writes and stamps through that service only, and checks after every wait that it is still
 * the displayed one: an answer that arrives once another service has replaced it (the same account and epoch, another database or a
 * reopened one) is dropped unrecorded, and the work is asked again under the new binding. A new binding retires what this page
 * remembered of the old one (`attempted`, `settledThrough`, `unrecorded`, paused work), and a "Try again" pressed on the old one lifts
 * nothing in the new one. A moment with no service bound is a pause.
 *
 * RETENTION AND TARGETS (revision 5, reviews R24 and R25; WEB-04 §5.8): work is per task AND day (`[task, through_date]`): a second day of
 * a task asked for while another is queued, worked on or paused is kept as its own work, never absorbed. A stopped row is never deleted
 * because a later day begins: a row goes only when a position read shows its own day covered (its sequence's, or any read of the task:
 * `clearSatisfied`, each row compared as read). A new row grows the store and is admitted through the quota ledger first; one not
 * admitted sends nothing (a `storage` stop of this page). The zone each task's read found (`zones`) lets a screen name the exact day it
 * works for.
 *
 * CONSENT (revision 5, review R26): a "Try again" names the stop the screen SHOWED by identities that never recur: a discovery stop by its
 * retry AND the claim it stopped on (a fresh claim per read, so a discovery that succeeded and stopped again is another stop), a day's
 * sequence by its generation and revision together with the discovery stop shown in front of it (or none), a page's memory stop by its
 * own id, and "no stop shown" explicitly. A press whose stop no longer stands exactly so lifts nothing and sends nothing.
 *
 * RETRY PROTOCOL (revision 10, Decision B, review R36; `model/retry.ts`): each caller (the discovery read, the command, the position read
 * after a successful command) has its own durable schedule, and every transmission is ADMITTED in its record first (`issued`), under the
 * same compare-and-set and guards as the rest of W27. A wait is never slept through holding the work: the work is parked until its
 * eligible time (`due`) and woken then, so other tasks go on, and whichever page holds the lock then (a reload, another tab) reads the same
 * schedule. An answer whose record cannot be written stops automatic work for the task on this page (a `storage` stop in memory): the
 * call it answered is never made again automatically. A discovery read is never taken as the position read of a sequence: each caller
 * reads under its own admission. `reconnected` (an observed offline-to-online change, never a generic kick) resumes `window` pauses only.
 *
 * REVISION 11 (review R36; design assessment C1–C4):
 * - PERMISSION AT ISSUE: an admitted call carries its permission to the session's send boundary (`transmits`), asked in the synchronous
 *   step that issues it, after every wait (the admission's commit, the token, the cover, the locks): its binding still displayed, the page
 *   able to run, no unrecorded outcome of its caller standing, and the clock a valid time no earlier than the admission, before the
 *   window's end and not before its schedule's time. A call it refuses is not sent, its admission is withdrawn (nothing counted) and the
 *   schedule decides again (a pause written, or a wait). An issued call is never aborted: a slow one that answers after the window's end
 *   is recorded once. Only `not_sent` and `offline` are known not to have been sent; a `closed` answer may follow a transmission, so its
 *   admission stays and counts as lost when the work is next taken up.
 * - OUTCOMES THAT CANNOT BE RECORDED: an answer's record is written again a bounded number of times (`REPAIR_MS`: persistence only, nothing
 *   is transmitted). One still not written FENCES its caller (a write-failure marker of the account's database lifetime, `fenceOf`; this
 *   page's memory of it when no marker can be written): no page transmits for that caller automatically while it stands, a reload and
 *   another tab included, and a marker that cannot be read counts as standing. The outcome is kept in this page's memory, and the
 *   person's "Try again" writes it first (revision 12: see below for what it ends, and what it never ends).
 * - MIGRATION: a discovery entry of an earlier build with a claim (`attempt`) or failures and no schedule is a visible manual stop, its
 *   claim and counts kept; a withdrawn admission keeps an explicit `schedule: null`, so it is never mistaken for one.
 * - RECONNECTION reaches every row: the account is read a keyset page at a time (`readSequencePageNow`) until a short page, and only
 *   pauses that stood at the reconnection (`seen` no later than it) are lifted. A page that cannot be read leaves the scan where it was,
 *   for the next kick under the same binding (never another binding's).
 *
 * REVISION 12 (review 13's R36-A to R36-D; design assessment C1 to C5):
 * - THE FIRST FAILURE IS FENCED AT ONCE (R36-B): an outcome (an answer's record, or the withdrawal of a call known not to have been sent)
 *   whose first write fails is a PROTECTED transition (`Protected`): its fence is published in the same step, before any repair wait,
 *   while its binding is still the displayed one (never into another lifetime), and the exact failure instance it published is kept with
 *   it. Its repairs then write the SAME transition again (persistence only; the deadline and the timestamps it was classified with). A
 *   repair that lands, or finds that very transition stored already (`landed`), ends that instance and no other. A repair that finds
 *   another record (`stale`), or never lands, keeps the fence and shows the stop. A runner that ends during a wait leaves the fence standing.
 * - EVIDENCE BEFORE RETIREMENT (R36-A): the person's "Try again" writes this page's protected outcomes of the task FIRST, before any stop is
 *   lifted, and ends only the instances they published. A fence with no outcome behind it in this page (a reload, another runner, another
 *   tab, an instance whose publication could not be named) is never ended by a press: its stop stays shown and nothing is transmitted, however
 *   long ago it was recorded, because a marker never says what the call's answer was (a 429's deadline, or a success that may only continue
 *   with its position read). Only a page that holds the outcome can end it.
 * - RETRY AUTHORITY SURVIVES COALESCING (R36-C): the person's press and an observed reconnection for the same work are kept apart (`retry`,
 *   then `edge`): a reconnection's lift never replaces a queued press (a fresh budget), and a press replaces a queued reconnection's lift
 *   only in front of it: if the stop the press saw no longer stands, the reconnection's own (as it read it) is tried, each consumed once.
 * - AN EDGE WHILE NO SERVICE IS DISPLAYED (R36-D): a reconnection observed while the service this page's work is bound to is still live
 *   but momentarily not displayed is kept, with its time, for THAT service: the next kick that finds it displayed again scans; another
 *   service (a replacement), an ended one or none ever bound takes nothing from it.
 *
 * REVISION 13 (review 14's R36-E and R36-F; design assessment C1 to C6):
 * - AN OUTCOME IS PROTECTED FROM ITS RECEIPT (C1/C4): an answer (or a withdrawal of a call known not to have been sent) is classified
 *   once, when it arrives, into one immutable transition (the record it is written over, the record it writes, the stamp of its call, the
 *   time it was observed), kept before its first write. An outcome whose loss would let a later call break the protocol (`mustKeep`: a
 *   stop, a server minimum still ahead, a command's known success) has its fence published in that same step, BEFORE the first write: a
 *   write that never lands (the page closes, the runner is disposed, the service ends while it is on its way) leaves the fence standing.
 *   Any other (a transport uncertainty, an unrecognised or transient answer, a position read, a discovery's success, a withdrawal) is
 *   fenced by its first write that does not land, as in revision 12: lost, it reads as its call lost (counted and paced), which is no less
 *   conservative, and a page that closes while its call is on its way (the browser cancels it) does not stop the work for good. Only that
 *   transition stored, written here (`written`) or found stored exactly so (`landed`), ends the instance published, and no other.
 * - THE FIRST STALE WRITE IS NOT ADOPTED (R36-E, C2/C5): a first write that finds another record (`stale`) is treated as every later one is:
 *   nothing proves its outcome was recorded, so its fence stays and the day (or the task's discovery) shows a `storage` stop; the record that
 *   stands (a peer's) is left untouched and no call is made from it. A stale write is never written again (it cannot become current).
 * - AN ANSWER DURING A MOMENT WITH NO SERVICE DISPLAYED (R36-F, C3): while the service the work is bound to has not ended and no other is
 *   displayed (`gap`), an answer is kept (`pending`, its fence published under its own binding's scope) and nothing is written or sent; the
 *   next work of the task under THAT service writes it first, before anything else of the task (a lift, a read, a call). A replacement
 *   service, an ended one or a disposed runner takes nothing from it (its fence stands). Permission to SEND is unchanged: never in a gap.
 *
 * REVISION 14 (review 15's R36-G; design assessment C1 to C3):
 * - EVERY FAILURE THE SERVER ANSWERED IS FENCED FROM ITS RECEIPT: revision 13 left unrecognised and transient answers to be fenced by
 *   their first write that did not land. A runner disposed while that write was on its way could publish nothing, and the next page read
 *   the call as lost when it was issued: no unrecognised answer counted (a fourth read before the pause) and its pace taken from the issue
 *   (a call at once after an observed 503). `receivedFailure` (from the answer's classification, never from its transition) now joins
 *   `mustKeep` for all three callers. Unchanged: no answer at all (transport), a withdrawal and a read's success are still fenced by their
 *   first unrecorded write, so a page that closes while its call is on its way (E-M2) still has it resent; a fence whose outcome no page
 *   holds still stops the work for the person (marker-only: shown, never cleared by a press). The residual case, recorded and NOT resolved
 *   (disposition web10c-r36-no-answer-disposition-20261102): a transport failure observed well after its issue whose first write is lost
 *   is paced from its issue by the next page, as every lost call is.
 * - A PAGE TORN DOWN WHILE IT WRITES LEAVES ITS CALL RECOVERABLE (I-10C-M4a on Firefox, found qualifying R38): Firefox fails the write
 *   of the outcome of a call it cancelled as the page closed, which revision 13 fenced at once, so the next page stopped for good where
 *   Chromium's (whose write never answers) recovered. An outcome not fenced at its receipt is now fenced across pages only once its
 *   repairs are spent with the page still running (persistence failing under a live page still stops every page); meanwhile this
 *   runner holds it. A stale write is still fenced at once; a received answer is fenced from its receipt. SUPERSEDED by revision 15
 *   (review 16's R36-I: that delay let another page transmit while the record could not be written).
 *
 * REVISION 15 (review 16's R36-H, R36-I and R39; design assessment C1 to C4). The current protocol for an observed outcome:
 * - WHAT A PAGE OBSERVED IS KEPT FROM ITS RECEIPT (R36-H): every failure the server answered (as revision 14) and every transport
 *   failure observed while the page was live (`observedFailure`) is fenced before its first write, with stops, server minima and a
 *   command's known success. Its deadline was taken from when it was observed; lost, nothing could recover it, so the caller stops
 *   (marker-only: shown, never cleared by a press) rather than being paced from its issue.
 * - A FAILED WRITE FENCES AT ONCE (R36-I): any other outcome (a withdrawal, a read's success) whose write fails, or finds another record,
 *   is fenced at that failure, before any repair wait, so no page transmits for the caller while its record cannot be written.
 * - THE PAGE'S TEARDOWN (`CatchUpDeps.lifecycle`, `./lifecycle`): after the page's `pagehide` (closed, reloaded, navigated away from)
 *   a transport failure is the browser cancelling the call (the order every engine gives, recorded natively by E-M12a): no page that
 *   goes on observed an outcome, so it is not fenced at receipt and its failed write publishes nothing; the next page recovers the call
 *   as lost from its admission (`unanswered`, E-M2, I-10C-M4a). A received answer is fenced however late. A page shown again (a
 *   back-forward restore) publishes what it held unpublished. A hidden tab is not torn down. SUPERSEDED by revision 16 for a
 *   `beforeunload` (review 17's R36-J: it counted as a teardown, so a page that went on after an abandoned navigation left what it
 *   observed unprotected).
 * - A RECEIVED BODY THAT IS NOT JSON (R39, `../api.ts`) is an unrecognised answer, never transport.
 *
 * REVISION 16 (review 17's R36-J; design assessment C1 to C4; Kieran's D1 decision approval/web10c-d1-preserve-rule-20261102.json:
 * the existing observed-failure protection is kept, no weaker departure limitation). The current protocol for an observed outcome:
 * - ONLY THE PAGE'S DEPARTURE CANCELS A CALL (`./lifecycle`): its `pagehide` begun since the call was issued (this page's listener ran,
 *   or the outcome is judged during the `pagehide` dispatch, as Chromium delivers its cancellation), and no `pageshow` since. An
 *   attempted departure (`beforeunload`) proves nothing: a navigation answered with 204, a download or one cancelled leaves the page
 *   running. Judged once, synchronously, in the step the answer is classified (the task it was delivered in); a failure delivered before
 *   the `pagehide` began is one the page observed, however soon the page leaves after it (R36-H): no delay or later event decides it.
 *   Firefox and WebKit deliver a navigation's cancellation before `pagehide`: it cannot be told from a genuine failure and is protected
 *   as one (its outcome, written before the page unloads, is what the next page recovers). A received answer is kept however late.
 * - WHAT IS KEPT IS DECIDED ONCE (`mustKeep`: `always`, `observed`, `never`), from the answer and its transition; an `observed` failure
 *   is fenced before its first write unless its call was cancelled by the departure (`withheld`). A fence published is never withdrawn
 *   because the page leaves later; only its outcome recorded (`written`, `landed`) ends it, its own instance.
 * - A FAILED WRITE (or a gap) FENCES AT ONCE unless the page departed (`left`), as revision 15 for a page that never attempted to leave.
 * - A PAGE SHOWN AGAIN (a back-forward restore) publishes the fence of every outcome its departure left unpublished: failed, withheld at
 *   receipt (its write possibly on its way), or kept in a gap.
 * - What a departed page's call leaves stays recoverable as a call lost, from its admission (`unanswered`, E-M2, I-10C-M4a), unchanged.
 */
export type Trigger = MaterialiseSequenceRow["trigger"];

export interface CatchUpDeps {
  api: TasksApi;
  /** `account:epoch`, the key of page memory (refusals). */
  identity: string;
  accountId: string;
  epoch: number;
  /** The displayed account's open service (W27 commits), or null. */
  service(): AccountService | null;
  online(): boolean;
  writable(): boolean;
  now(): number;
  newId(): string;
  /** The waits between uncertain answers; the page's timers when omitted (tests pass fake ones). */
  sleep?(ms: number): Promise<void>;
  /**
   * `navigator.locks`, or null where there is none. Without it, pages are not excluded from each other: each first read is still admitted
   * (claimed) in the task's entry before it is sent and recorded only over its own claim, so a page that lost the claim records nothing.
   */
  locks?: LockManager | null;
  /** The origin's quota ledger (a new task's discovery entry is admitted through it); absent: not admitted (a test of the runner alone). */
  quota?(): DataEnv["quota"] | null;
  /**
   * Revision 11 (review R36): the page's write-failure markers, which fence a caller whose answer could not be recorded (header);
   * absent: none (the fence is this runner's memory only).
   */
  markers?(): PageDataHost["markers"] | null;
  /**
   * Revision 15 (review 16's R36-H/I; design assessment C1): the page's lifecycle (`./lifecycle`), read per call: a call takes a `mark`
   * when it is issued. Revision 16 (review 17's R36-J): it was cancelled by the page's departure when `departedSince(mark)` (its
   * `pagehide` begun, never a `beforeunload` alone). Absent: the page never departs (a runner alone in a test).
   */
  lifecycle?: PageLifecycle;
}

/** What this page knows that the durable records do not show: what it is working on, and a stop it could not record. */
export interface RunnerState {
  /** Tasks queued or running on this page, in order. */
  active: readonly string[];
  /** The task being worked on now (this page holds the lock and is reading or sending for it). */
  current: string | null;
  /** This page waits for the account's lock (another page is catching up). */
  waiting: boolean;
  /** Discovery stops whose record could not be written (the store failed or is full): memory only, with "Try again". */
  unrecorded: ReadonlyMap<string, UnrecordedStop>;
  /** Tasks whose sequence finished on this page since it began (for an announcement). */
  finished: number;
  /** A stop was recorded or met on this page (its count moves once per stop, for an announcement). */
  stops: number;
  /**
   * The zone each task's read found on this page, under the binding displayed (revision 5, R24): a screen working for the task's today
   * names that exact day (`todayIn(zone, now)`); a task not read yet has none (its day is not known: never the device's own date).
   */
  zones: ReadonlyMap<string, string>;
  /**
   * The days each task was asked for EXPLICITLY on this page under the binding displayed (revision 6, review R28: a command's day), the
   * most recent `ASKED_DAYS`: a screen looks each up by its own key, so its stop is found however many later days the task holds.
   */
  asked: ReadonlyMap<string, readonly string[]>;
}

/** The most explicitly asked days of one task a runner remembers for the screens (revision 6, R28). */
export const ASKED_DAYS = 6;

export interface UnrecordedStop {
  /**
   * `storage`: the task's entry, or a new day's row, could not be admitted (the quota ledger refused its growth), so nothing was sent
   * (revision 3, R16; revision 5).
   */
  reason: "unreachable" | "rejected" | "storage";
  requestId?: string;
  /** This stop's own identity (revision 5, R26): a fresh one for every stop held, so a press on an earlier one never lifts a later one. */
  id: string;
  /** The day of the new row that could not be admitted (revision 6, R29): a press asks for THAT day again, not whichever was worked last. */
  throughDate?: string;
}

/** A discovery stop as shown (revision 5, R26): its retry and the claim it stopped on, which is never reused. */
export interface DiscoveryToken {
  retry: number;
  attempt: string | null;
}

/**
 * The stop a "Try again" was pressed on, as the screen showed it (revision 4, review R20; revision 5, R26): a day's sequence by its
 * generation and revision (every write moves the revision, so a later stop is never this one) and the discovery stop shown in front of it
 * (`null`: none was); a discovery by its retry and claim; a stop held in a page's memory by its id; or none at all (the screen showed no
 * stop of the task: a stop that appeared since is not lifted).
 */
export type SeenStop =
  | {
      kind: "sequence";
      generation: string;
      revision: number;
      discovery: DiscoveryToken | null;
    }
  | ({ kind: "discovery" } & DiscoveryToken)
  | { kind: "memory"; id: string }
  | { kind: "none" };

/** What a discovery stop shown names (revision 5, R26). One builder for every screen. */
export const discoveryToken = (
  entry: MaterialiseDiscovery,
): DiscoveryToken => ({ retry: entry.retry, attempt: entry.attempt ?? null });

/** What a press on a day's stopped sequence names, with the discovery stop shown beside it, if any (revision 5, R26). */
export const seenSequence = (
  row: MaterialiseSequenceRow,
  discovery: MaterialiseDiscovery | null | undefined,
): SeenStop => ({
  kind: "sequence",
  generation: row.sequence_generation,
  revision: row.revision ?? 0,
  discovery: discovery?.stop ? discoveryToken(discovery) : null,
});

/** What a press on a discovery stop names (revision 5, R26). */
export const seenDiscovery = (entry: MaterialiseDiscovery): SeenStop => ({
  kind: "discovery",
  ...discoveryToken(entry),
});

export interface CatchUpRunner {
  readonly identity: string;
  /** Asks for a task to be brought up to date through its today (or `throughDate`). Idempotent per task and day. */
  ensure(
    taskId: string,
    trigger: Trigger,
    options?: { throughDate?: string },
  ): void;
  /**
   * The person's "Try again" for a task's stopped sequence through `throughDate` (the record's own key, whichever page stopped it), or
   * for its memory-only stop (no day): a fresh budget, then the work resumes. `seen`: the stop the person pressed it on, as shown (review
   * R20); when it no longer stands as shown, nothing is lifted or asked (the screen shows what stands now).
   */
  tryAgain(taskId: string, throughDate?: string, seen?: SeenStop): void;
  /** Connectivity or compatibility changed: waiting work may proceed. */
  kick(): void;
  /**
   * Revision 10 (Decision B): this page OBSERVED the device go from offline to online. Besides a kick, every stop paused by its retry window
   * (a discovery's or a day's, any page's, as read now) resumes once, compared as read: never any other stop.
   */
  reconnected(): void;
  get(): RunnerState;
  subscribe(listener: () => void): () => void;
  /** Ends the runner: nothing more is sent or written; an answer on its way is dropped. Idempotent. */
  dispose(): void;
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Revision 11 (review R36): the waits before an answer's record is written again (persistence only: nothing is transmitted). */
export const REPAIR_MS: readonly number[] = [250, 1_000];

/** Revision 11 (review R36): the marker operation that fences a task's discovery, or one day's sequence of it. */
export const fenceOf = (taskId: string, day?: string) =>
  day === undefined ? `materialise:${taskId}` : `materialise:${taskId}:${day}`;

/** The task's zone from its details, as `GET /tasks/{id}` returned them. */
function zoneOf(execution: { value: unknown } | null): string | null {
  const definition = execution ? parseDefinition(execution.value) : null;
  return definition?.schedule.timezone ?? null;
}

/**
 * Nothing to record of a transmission. `unsent` (revision 11, review R36): it is known not to have been made (`not_sent`, `offline`), so
 * its admission is withdrawn; otherwise (`closed`: the identity moved, possibly after an answer) it may have been, so its admission stays.
 */
type Pause = { kind: "pause"; unsent: boolean };
const UNSENT: Pause = { kind: "pause", unsent: true };
const UNSETTLED: Pause = { kind: "pause", unsent: false };

/**
 * Revision 14 (review 15's R36-G; design assessment C1): an uncertain answer the server GAVE (classified from an HTTP answer: unrecognised,
 * which an answer without retry facts is read as, transient or rate-limited), as against no answer at all (`transport`). Read from the
 * classification only, never from the transition it leads to (a null deadline or "not a stop" says nothing of where it came from).
 */
export const receivedFailure = (answer: SendAnswer | ReadAnswer): boolean =>
  answer.kind === "uncertain" &&
  (answer.retry?.cause ?? "unrecognised") !== "transport";

/**
 * Revision 15 (review 16's R36-H; design assessment C1, invariants 1 and 3): a failure this page OBSERVED while it was live: every failure
 * the server answered (`receivedFailure`), and a transport failure (no answer) of a call the page's departure did not cancel. `departed`
 * (revision 16, review 17's R36-J: revision 15's `torn` counted a `beforeunload` too): the page's `pagehide` was seen after the call was
 * issued, and in the task its failure was delivered in (`PageLifecycle.departure`): its transport failure is the browser cancelling it
 * as the page closes, reloads or navigates away; no outcome was observed by a page that goes on, so it stays recoverable as a call lost
 * (E-M2, I-10C-M4a), from its admission. A `beforeunload` alone (a navigation answered with 204, a download, one cancelled) is not a
 * departure. Never from the error's type, a delay or a later disposal.
 */
export const observedFailure = (
  answer: SendAnswer | ReadAnswer,
  departed: boolean,
): boolean =>
  answer.kind === "uncertain" && (!departed || receivedFailure(answer));

function classifySend(result: TasksResult<unknown>): SendAnswer | Pause {
  if (result.ok) return { kind: "ok" };
  switch (result.kind) {
    case "uncertain":
      return result.code === "slice_capacity"
        ? {
            kind: "capacity",
            ...(result.requestId ? { requestId: result.requestId } : {}),
          }
        : {
            kind: "uncertain",
            ...(result.requestId ? { requestId: result.requestId } : {}),
            ...(result.retry ? { retry: result.retry } : {}),
          };
    case "not_sent":
    case "offline":
      return UNSENT;
    case "closed":
      return UNSETTLED;
    default:
      // 409 (an unmet precondition), 422 (an archived task, a day beyond the horizon), 403, 404: definite and terminal.
      return {
        kind: "rejected",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
  }
}

interface PositionRead {
  answer: ReadAnswer | Pause;
  zone: string | null;
}

function classifyRead(
  result: Awaited<ReturnType<TasksApi["readTask"]>>,
): PositionRead {
  if (result.ok) {
    const m = result.value.materialisation;
    // The details are unreadable here: the position cannot be known, so nothing can be caught up from this page.
    if (m === null)
      return {
        answer: {
          kind: "rejected",
          ...(result.requestId ? { requestId: result.requestId } : {}),
        },
        zone: null,
      };
    const position: Position = { last_date: m.last_date, pending: m.pending };
    return {
      answer: { kind: "ok", position },
      zone: zoneOf(result.value.execution),
    };
  }
  switch (result.kind) {
    case "uncertain":
      return {
        answer: {
          kind: "uncertain",
          ...(result.requestId ? { requestId: result.requestId } : {}),
          ...(result.retry ? { retry: result.retry } : {}),
        },
        zone: null,
      };
    case "not_sent":
    case "offline":
      return { answer: UNSENT, zone: null };
    case "closed":
      return { answer: UNSETTLED, zone: null };
    default:
      return {
        answer: {
          kind: "rejected",
          ...(result.requestId ? { requestId: result.requestId } : {}),
        },
        zone: null,
      };
  }
}

const POSITION_READ = (taskId: string) => `task:${taskId}`;

/**
 * One task to bring up to date, as asked. `resume`: the item of a sequence this page paused, resumed (its day is known). `retry`: the
 * person's "Try again", with the stops it was pressed on (the discovery entry and the day's sequence as they were read then), which it
 * lifts under the lock only if they still stand as seen.
 */
interface Item {
  taskId: string;
  trigger: Trigger;
  throughDate?: string;
  manual: boolean;
  resume?: boolean;
  /** Asked again once already because its binding ended (R17): another end parks it for the next kick instead of looping. */
  rebound?: boolean;
  /** Revision 10: parked until this time, when its schedule admits the next transmission (woken then; a kick does not take it up). */
  due?: number;
  /**
   * Revision 12 (R36-C): an observed reconnection's lift of this work that arrived while the person's press (`retry`) was queued for it:
   * kept beside the press, never in its place, and tried only when the stop the press saw no longer stands.
   */
  edge?: Retry;
  retry?: Retry;
}

/** A lift of one piece of work: the person's press, or an observed reconnection (`online`). */
interface Retry {
  /** Revision 10: lifted by an observed reconnection (only a `window` pause), not by the person. */
  online?: boolean;
  /** The discovery entry as read at the press: its stop is lifted only while it stands so; none (or one with no stop): none may stand. */
  discovery: MaterialiseDiscovery | null;
  sequence: Sequence | null;
  /** The service it was pressed under: a press of an ended binding lifts nothing in another (review R17). */
  service: AccountService | null;
}

/**
 * Revision 12 (R36-A/B; design assessment C1/C2): how one write of a protected transition ended. `landed`: this very transition is stored
 * already (an earlier attempt applied and its answer was lost, or, for a removal, the record is gone); `stale`: another record stands;
 * `failed`: not written (a store failure, a quota refusal, a dropped commit). Revision 13: the same for a first write and a repair.
 */
type Verdict = "written" | "landed" | "stale" | "failed";

/**
 * Revision 12 (R36-A/B), revision 13 (R36-E/F): an outcome this page holds until it is recorded, with the failure instance it published:
 * the marker's own instance (`marker`; `null` when none could be named, which nothing then ends) or this page's hold of it (`memory`).
 */
interface Protected {
  service: AccountService;
  task: string;
  /** The day of a sequence's outcome (none: the task's discovery). */
  day?: string;
  op: string;
  marker: string | null;
  memory: string | null;
  /**
   * Revision 13 (C4): its fence is published (at its receipt when `early`, otherwise at its first unrecorded write or gap). Revision 15
   * (R36-I): revision 14's delay until its repairs were spent is removed; a call cancelled by the page's teardown publishes none.
   */
  published: boolean;
  /** Revision 13 (R36-F): observed (or left mid-write) while its binding was not displayed: written by the task's next work under it. */
  pending: boolean;
  /**
   * Revision 15 (review 16's R36-I): a write of it failed (or found another record). Such a record's fence is published at that failure,
   * before any repair wait, unless the page's departure (`pagehide`, revision 16) was seen after its call was issued (`mark`); one held
   * unpublished so is published when the page is shown again.
   */
  failed: boolean;
  /** Revision 15: the page's lifecycle mark when its call was issued (or withdrawn). */
  mark: number;
  /** Revision 16: its fence at receipt was withheld only because its page's departure was confirmed (published if the page is restored). */
  withheld: boolean;
  /** Writes the same transition (persistence only, nothing is transmitted): the verdict and what the write answered. */
  attempt(): Promise<{ verdict: Verdict; out: unknown }>;
}

/**
 * Revision 16 (review 17's R36-J; design assessment C2): when an outcome's fence is published, decided once from its answer (`mustKeep`):
 * at its receipt (`always`); at its receipt unless the page's departure cancelled its call (`observed`: a transport failure); or at its
 * first write that is not recorded (`never`).
 */
type Keep = "always" | "observed" | "never";

/** Revision 13: how a protected outcome ended for its caller. */
type Protection<T> =
  | { kind: "out"; out: T; verdict: "written" | "landed" }
  /** Not recorded: kept, its fence standing (a store failure, or another record where it was to be written). */
  | { kind: "fenced" }
  /** Revision 13 (R36-F): kept for its binding, not displayed at the moment; its fence standing. */
  | { kind: "pending" }
  /** Its binding ended (another service displayed, its service ended, the runner disposed): its fence, published, stands. */
  | { kind: "ended" };
const FENCED = { kind: "fenced" } as const;
const PENDING = { kind: "pending" } as const;
const ENDED_P = { kind: "ended" } as const;

/** Revision 12 (R36, C1): two records alike, field by field (an absent field and an `undefined` one alike). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) =>
    Object.keys(o).filter((k) => o[k] !== undefined);
  const kx = keys(x);
  return kx.length === keys(y).length && kx.every((k) => same(x[k], y[k]));
}

/**
 * Revision 12 (R36, C1): the row a repair found is the transition it writes (`next` over `expected`), landed already: the same content
 * one revision after the row expected, or, for a removal, no row.
 */
function landedRow(
  expected: Sequence,
  next: Sequence | null,
  stored: Sequence | null,
): boolean {
  if (next === null || stored === null) return next === null && stored === null;
  const { revision: was, ...rest } = stored;
  const { revision: _, ...want } = next;
  return was === (expected.revision ?? 0) + 1 && same(rest, want);
}

/** The binding one piece of work began with (review R17): it reads, writes and stamps through this service only. */
interface Binding {
  service: AccountService;
}

/**
 * What a press made on `seen` lifts of what is stored now (review R20; revision 5, R26), or `null` when the stop the screen showed no
 * longer stands EXACTLY so: a day's stop only while it is that very row (generation and revision) and the discovery stop in front of it
 * is the one shown with it (or there is still none, as shown); a discovery stop only while it is that entry's stop on that very claim; a
 * memory stop only while it is the one held; "none" only while no stop of the task stands. The discovery is compared by its claim, which
 * is never reused, so a discovery that succeeded (its entry gone) and stopped again is never the stop an earlier screen showed.
 */
function pressedOn(
  seen: SeenStop,
  discovery: MaterialiseDiscovery | null,
  sequence: Sequence | null,
  memory: UnrecordedStop | undefined,
): {
  discovery: MaterialiseDiscovery | null;
  sequence: Sequence | null;
} | null {
  const stands = (token: DiscoveryToken | null) =>
    token === null
      ? !discovery?.stop
      : !!discovery?.stop &&
        discovery.retry === token.retry &&
        (discovery.attempt ?? null) === (token.attempt ?? null);
  switch (seen.kind) {
    case "sequence":
      return sequence !== null &&
        sequence.sequence_generation === seen.generation &&
        (sequence.revision ?? 0) === seen.revision &&
        stands(seen.discovery ?? null)
        ? { discovery: discovery?.stop ? discovery : null, sequence }
        : null;
    case "discovery":
      return stands(seen) ? { discovery, sequence: null } : null;
    case "memory":
      return memory?.id === seen.id
        ? { discovery: null, sequence: null }
        : null;
    case "none":
      return !discovery?.stop && sequence === null && memory === undefined
        ? { discovery: null, sequence: null }
        : null;
  }
}

/** The key of one piece of work (revision 5, R24/R25): its task and the day asked for (`""`: its today, once its zone is known). */
const workKey = (item: { taskId: string; throughDate?: string | undefined }) =>
  `${item.taskId}|${item.throughDate ?? ""}`;

const NO_DISCOVERY: MaterialiseDiscovery = {
  retry: 0,
  failures: 0,
  stop: null,
};

/**
 * A lifted discovery stop at `now` (a new `retry`: an answer decided under the old one never applies): the person's press (`manual`) or a
 * reconnection (revision 10: a `window` pause only, its unrecognised streak kept). A still-future server deadline is kept either way.
 */
const liftedDiscovery = (
  seen: MaterialiseDiscovery,
  now: number,
  manual: boolean,
): MaterialiseDiscovery => {
  const stored = readSchedule(seen.schedule, "discovery");
  const s = reset(stored === "invalid" ? null : stored, now, manual);
  // Revision 11 (R36): `schedule` always written (`null`: nothing outstanding), so a lifted entry is never one of an earlier build.
  return {
    retry: seen.retry + 1,
    failures: 0,
    stop: null,
    attempt: null,
    schedule: s,
  };
};

/**
 * How one task's work ended (review R1): `done` when nothing more is to happen without the person (complete, a stop recorded or shown,
 * already handled on this page); `paused` when it stopped part-way for a reason that can clear (offline, not compatible, the session
 * held, a write not applied, a thrown read or store), with the day of the sequence it was working on once that is known.
 */
type Outcome =
  | { kind: "done" }
  /** `at` (revision 10): the time its schedule admits the next transmission. */
  | { kind: "paused"; throughDate?: string; at?: number }
  /** The binding it began with ended (another service is displayed now): nothing more of it is written; the task is asked again. */
  | { kind: "ended" };
const DONE: Outcome = { kind: "done" };
const PAUSED: Outcome = { kind: "paused" };
const ENDED: Outcome = { kind: "ended" };
const keyed = (outcome: Outcome, throughDate: string): Outcome =>
  outcome.kind === "paused" ? { ...outcome, throughDate } : outcome;

export function createCatchUpRunner(deps: CatchUpDeps): CatchUpRunner {
  const sleep = deps.sleep ?? sleepFor;
  const locks =
    deps.locks === undefined
      ? (globalThis.navigator?.locks ?? null)
      : deps.locks;
  const listeners = new Set<() => void>();
  const queue: Item[] = [];
  /**
   * Work paused part-way, by task (review R1): a durable sequence left `ready`, `submitting` or `awaiting_position_read` that this page
   * must take up again when what paused it clears (`kick`: connectivity, compatibility or the binding moved; `ensure` of the task; "Try
   * again"). It resumes THE SAME key: its stored attempt is resent with its own key, or only its position is read (CM-440); a genuine stop
   * is never parked, so it is never restarted.
   */
  const parked = new Map<string, Item>();
  /** `task|day` of every automatic sequence this page began or found: never begun again automatically. */
  const attempted = new Set<string>();
  /** The day each task was last brought up to date (or found stopped) through, in its zone: Today asks again on every read. */
  const settledThrough = new Map<string, { zone: string; day: string }>();
  let state: RunnerState = {
    active: [],
    current: null,
    waiting: false,
    unrecorded: new Map(),
    finished: 0,
    stops: 0,
    zones: new Map(),
    asked: new Map(),
  };
  /** The key of the work being done now (revision 5): another day of the same task is other work. */
  let currentKey: string | null = null;
  let disposed = false;
  let running = false;
  const abort = new AbortController();

  const set = (patch: Partial<RunnerState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const park = (item: Item, throughDate: string | undefined, at?: number) => {
    if (disposed) return;
    const day = throughDate ?? item.throughDate;
    const { due: _, ...rest } = item;
    // Kept under the day it was found to be (revision 6, R29): an implicit today that resolved is that day's work from now on.
    parked.set(workKey({ taskId: item.taskId, throughDate: day }), {
      ...rest,
      ...(day === undefined ? {} : { throughDate: day }),
      ...(at === undefined ? {} : { due: at }),
      resume: day !== undefined,
    });
  };
  /** The work is queued or being done already (the same task and day). */
  const pending = (key: string) =>
    currentKey === key || queue.some((q) => workKey(q) === key);
  /**
   * Paused work back in the queue, first (it was asked first), unless the same task and day is queued or worked on already. Work parked
   * until a later time stays parked (revision 10): its wake takes it up.
   */
  const unpark = (taskId?: string) => {
    const now = deps.now();
    const entries = [...parked].filter(
      ([, p]) =>
        (taskId === undefined || p.taskId === taskId) &&
        !(p.due !== undefined && p.due > now),
    );
    for (const [key] of entries) parked.delete(key);
    const fresh = entries
      .filter(([, item]) => !pending(workKey(item)))
      .map(([, item]) => item);
    if (fresh.length > 0) queue.unshift(...fresh);
    return fresh.length > 0;
  };
  const publishQueue = (current: string | null = state.current) =>
    set({
      active: [
        ...new Set([
          ...(current === null ? [] : [current]),
          ...queue.map((q) => q.taskId),
          // Revision 10: work waiting for its next transmission is still being brought up to date (never "finished").
          ...[...parked.values()]
            .filter((p) => p.due !== undefined)
            .map((p) => p.taskId),
        ]),
      ],
      current,
    });
  /**
   * Revision 10: the one wake of parked work, armed for the earliest future `due` (an earlier one replaces a later one; a later one never
   * replaces an armed earlier one). It takes up what is due, if the page may run; otherwise a kick does.
   */
  let wakeAt: number | null = null;
  let wakes = 0;
  const arm = () => {
    const now = deps.now();
    let at = Number.POSITIVE_INFINITY;
    for (const p of parked.values())
      if (p.due !== undefined && p.due > now && p.due < at) at = p.due;
    if (disposed || at === Number.POSITIVE_INFINITY) return;
    if (wakeAt !== null && wakeAt <= at && wakeAt > now) return;
    wakeAt = at;
    const mine = ++wakes;
    void sleep(at - now).then(() => {
      if (disposed || mine !== wakes) return;
      wakeAt = null;
      if (!mayRun()) {
        // Its time came while the page cannot run (offline, not compatible): it waits for a kick like any other paused work.
        const now = deps.now();
        for (const [key, p] of parked)
          if (p.due !== undefined && p.due <= now) {
            const { due: _, ...rest } = p;
            parked.set(key, rest);
          }
        publishQueue();
      } else if (unpark()) publishQueue();
      pump();
      arm();
    });
  };
  const unrecord = (taskId: string, value?: Omit<UnrecordedStop, "id">) => {
    const next = new Map(state.unrecorded);
    if (value === undefined) next.delete(taskId);
    // A fresh identity for every stop held (revision 5, R26): a press on an earlier one names another.
    else next.set(taskId, { ...value, id: deps.newId() });
    set({ unrecorded: next });
  };
  /** A day asked for explicitly, for the screens (revision 6, R28): kept once, the most recent `ASKED_DAYS`. */
  const noteAsked = (taskId: string, day: string) => {
    const held = state.asked.get(taskId) ?? [];
    if (held.includes(day)) return;
    const next = [...held, day].slice(-ASKED_DAYS);
    set({ asked: new Map(state.asked).set(taskId, next) });
  };
  /** The zone a task's read found, for the screens (revision 5, R24). */
  const zoneFound = (taskId: string, zone: string) => {
    if (state.zones.get(taskId) === zone) return;
    set({ zones: new Map(state.zones).set(taskId, zone) });
  };

  /** This runner may still act: not disposed, the service it writes through still the displayed one. */
  const alive = (): AccountService | null => {
    if (disposed) return null;
    const service = deps.service();
    return service?.live && service.account === deps.accountId ? service : null;
  };
  const mayRun = () => alive() !== null && deps.online() && deps.writable();

  // ---- Revision 11 (review R36): fences of outcomes that could not be recorded ---------------------------------------------------
  const markers = () => deps.markers?.() ?? null;
  const scopeOf = (service: AccountService) => ({
    account: deps.accountId,
    incarnationId: service.incarnationId,
  });
  /** The outcomes this page could not record, by binding and operation (revision 12: each with the failure instance it published). */
  const repairs = new Map<string, Protected>();
  const repairKey = (service: AccountService, op: string) =>
    `${service.incarnationId}|${op}`;
  /**
   * Revision 15 (R36-H/I): the page's lifecycle now (a call's mark). Revision 16 (review 17's R36-J; design assessment C1; Kieran's D1
   * decision): `departed`: the page's DEPARTURE (`pagehide`) began after `mark` (seen, or being dispatched now) and it was not shown
   * again; never a `beforeunload` alone, a delay or a disposal (`./lifecycle`).
   */
  const markNow = () => deps.lifecycle?.mark() ?? 0;
  const departed = (mark: number) =>
    deps.lifecycle?.departedSince(mark) === true;
  /**
   * An outcome of `op` that could not be recorded stands (a marker, this page's hold of one, or, revision 12, an outcome this runner
   * keeps); a marker that cannot be read stands.
   */
  const fenced = (at: Binding, op: string) => {
    if (repairs.has(repairKey(at.service, op))) return true;
    const m = markers();
    if (m === null) return false;
    const scope = scopeOf(at.service);
    return m.stops.has(scope, op) || m.probe(scope, op) !== "unmarked";
  };
  /**
   * Revision 12 (R36-B, C2): fences `op` NOW, in this binding's lifetime only (`null`: that lifetime ended, nothing is written), and names
   * the failure instance published: the marker's new instance (the one its witness shows after the write and not before, in the same
   * synchronous step; none when that cannot be told), or this page's hold when no marker can be written.
   */
  const publish = (
    at: Binding,
    op: string,
  ): { marker: string | null; memory: string | null } | null => {
    // Revision 13 (R36-F): also while its binding is momentarily not displayed (`gap`): the fence is content-free and of its own scope.
    if (!entitled(at)) return null;
    const m = markers();
    if (m === null) return { marker: null, memory: null };
    const scope = scopeOf(at.service);
    const before = m.witness(scope, op);
    const out = m.set(scope, op, () => entitled(at));
    if (out.state === "obsolete") return null;
    if (out.state === "unavailable")
      return { marker: null, memory: m.stops.hold(scope, op) };
    const after = m.witness(scope, op);
    const had = new Set(before.kind === "instance" ? before.instances : []);
    const mine =
      after.kind === "instance"
        ? after.instances.filter((i) => !had.has(i))
        : [];
    return {
      marker: mine.length === 1 ? (mine[0] as string) : null,
      memory: null,
    };
  };
  /** Revision 12 (R36-A, C2): a protected outcome recorded at last ends the failure it published, and no other. */
  const reconcile = (record: Protected) => {
    const key = repairKey(record.service, record.op);
    if (repairs.get(key) === record) repairs.delete(key);
    const m = markers();
    if (m === null) return;
    const scope = scopeOf(record.service);
    if (record.memory !== null)
      m.stops.release(scope, record.op, record.memory);
    if (record.marker !== null)
      m.retire(scope, record.op, {
        kind: "instance",
        instances: [record.marker],
      });
  };
  /**
   * Revision 12 (R36-A/B), revision 13 (R36-E/F; C1/C2/C4): writes an outcome's record, PROTECTED from the moment it is observed: it is kept
   * (`repairs`) before the first write is begun. `write` writes the one transition classified (it is never recomputed) and `judge` tells what
   * that write came to. `early` (C4): an outcome whose loss would let a later call break the protocol (`mustKeep`) has its fence published
   * at once, before the first write, so a write that never lands (the page closing, the runner disposed) leaves it standing; any other is
   * fenced by the first write that does not land, a stale write or a gap (a lost one reads as its call lost: the conservative count).
   * Revision 14 (R36-G): every failure the server answered is `early` (`mustKeep`). Revision 15 (R36-H/I): so is every transport
   * failure a live page observed; a failed or stale write of any other is fenced at that write (`settle`), unless the page departed.
   * Revision 16 (review 17's R36-J; design assessment C1/C2): `keep` is decided once, from the answer (`mustKeep`); a transport failure
   * (`observed`) is early unless the page's departure (`pagehide`, begun before it is judged here, in the task it was delivered in)
   * cancelled its call, when it is `withheld` (published if the page is restored). A fence published is never withdrawn because the page
   * leaves later.
   */
  const protect = async <T>(
    at: Binding,
    task: string,
    op: string,
    write: () => Promise<T>,
    judge: (out: T) => Verdict,
    keep: Keep,
    day: string | undefined,
    mark: number,
  ): Promise<Protection<T>> => {
    // An answer for a binding that ended, or was replaced, is dropped: nothing of it is written or published in another lifetime (R17).
    if (!entitled(at)) return ENDED_P;
    // Judged once, now, in the step the answer is classified (the task it was delivered in).
    const left = keep === "observed" && departed(mark);
    const early = keep === "always" || (keep === "observed" && !left);
    const published = early
      ? publish(at, op)
      : { marker: null, memory: null, unpublished: true };
    if (published === null) return ENDED_P;
    const record: Protected = {
      service: at.service,
      task,
      ...(day === undefined ? {} : { day }),
      op,
      marker: published.marker,
      memory: published.memory,
      published: !("unpublished" in published),
      pending: false,
      failed: false,
      mark,
      withheld: left,
      attempt: async () => {
        const out = await write();
        return { verdict: judge(out), out };
      },
    };
    repairs.set(repairKey(at.service, op), record);
    return (await settle(at, record)) as Protection<T>;
  };
  /** Revision 13: publishes a protected outcome's fence once (`publish`; `false`: its lifetime ended, nothing written). */
  const fence = (at: Binding, record: Protected): boolean => {
    if (record.published) return true;
    const published = publish(at, record.op);
    if (published === null) return false;
    record.marker = published.marker;
    record.memory = published.memory;
    record.published = true;
    return true;
  };
  /**
   * Revision 13 (C4): an outcome whose loss would let a later call break the protocol, so it is fenced from its receipt: a stop (a
   * refusal, a pause), a server minimum still ahead, or (`success`) a command's known success, which may only continue with its position
   * read. Revision 14 (review 15's R36-G; design assessment C1): also every failure RECEIVED from the server (`answer`: an unrecognised
   * answer, the first and second of a read's streak included, a recognised 500/503, a 429 whatever its Retry-After): lost, it would read
   * as its call lost WHEN IT WAS ISSUED (`unanswered`), which counts no unrecognised answer (a fourth would be read) and paces from the
   * issue, not from the answer (a call sooner than its back-off after the failure observed). What remains unfenced until its first write
   * does not land (revision 15: until that write FAILS, or is stale): a call the browser cancelled as its page departed (a
   * transport failure after the page's `pagehide`, revision 16 never a `beforeunload` alone: E-M2's reload must resend it), a withdrawal of a call known not to have been made,
   * and a read's success that stops nothing. Each of those, lost,
   * reads as its call lost: a withdrawal is then counted (more conservative than uncounted); a success is read again under its own
   * admission (a discovery's never settles a position; a position read's call is counted once, by the read that is recorded).
   * Revision 15 (review 16's R36-H): the residual revision 14 recorded (disposition web10c-r36-no-answer-disposition-20261102: a transport
   * failure observed late, its first write lost, paced from its issue) is closed: a transport failure observed while the page is live is
   * kept from its receipt too (`observedFailure`); only one that arrives after the page's `pagehide` (the call cancelled by the teardown)
   * is left to be recovered as a call lost. Recovery timing of a genuinely unanswered call is unchanged.
   * Revision 16 (review 17's R36-J; design assessment C2): decided once, from the answer and its transition, never from the lifecycle:
   * `always`, `observed` (a transport failure: kept unless the page's departure cancelled its call, which `protect` judges, `departed`)
   * or `never` (kept by its first unrecorded write).
   */
  const mustKeep = (
    next: {
      phase?: string;
      stop?: unknown;
      schedule?: Schedule | null;
    } | null,
    success: boolean,
    answer: SendAnswer | ReadAnswer | undefined,
  ): Keep => {
    if (success) return "always";
    // Revision 14 (R36-G; C1): a failure the server ANSWERED is kept from its receipt too, however late (`observedFailure` with the page
    // departed is exactly that).
    if (answer !== undefined && observedFailure(answer, true)) return "always";
    if (next !== null) {
      if (next.phase === "stopped" || (next.stop ?? null) !== null)
        return "always";
      const server = next.schedule?.server ?? null;
      if (server !== null && server > deps.now()) return "always";
    }
    // Revision 15 (R36-H): a transport failure this page observed while it goes on, its deadline taken from when it was observed.
    return answer !== undefined && observedFailure(answer, false)
      ? "observed"
      : "never";
  };
  /**
   * Revision 13 (R36-E/F; C2): writes a protected outcome, while its binding is displayed, after each of `REPAIR_MS` while its writes FAIL
   * (persistence only). Written or landed ends the instance it published, whatever is displayed by then (the transition is stored). Stale
   * is final: nothing proves the outcome was recorded, and a compare-and-set that lost never wins later, so the fence stays. A binding not
   * displayed at the moment keeps it `pending`; one that ended leaves its fence standing.
   */
  const settle = async (
    at: Binding,
    record: Protected,
  ): Promise<Protection<unknown>> => {
    for (let i = 0; ; i += 1) {
      if (!owns(at)) {
        if (!gap(at)) return ENDED_P;
        // Revision 16 (R36-J): unless the page's departure (`pagehide`) cancelled its call, judged as at a failed write.
        if (!left(record) && !fence(at, record)) return ENDED_P;
        record.pending = true;
        return PENDING;
      }
      record.pending = false;
      const { verdict, out } = await record.attempt();
      if (verdict === "written" || verdict === "landed") {
        reconcile(record);
        return { kind: "out", out, verdict };
      }
      // Not recorded (another record stands, or the write failed): fenced NOW if it was not already, in its own lifetime only, before
      // any repair wait (revision 15, review 16's R36-I: revision 14 waited until its repairs were spent, and meanwhile only this
      // runner's memory held it, so another page transmitted for the caller while its record could not be written). Decision B: after a
      // failed write of retry state, no page transmits for that caller automatically. The one exception is a page that departed
      // (revision 16, R36-J: its `pagehide` begun since the call was issued, no `pageshow` since; a `beforeunload` alone is not one,
      // `left`). Firefox fails the write of a call it cancelled as the page
      // closed, which Chromium leaves unanswered; the outcome of a call no page that goes on observed is then left recoverable as a call
      // lost (E-M2, I-10C-M4a), as when nothing was observed at all. Shown again (a back-forward restore), it is published then. A stale
      // write is fenced in every case.
      record.failed = true;
      const wait = REPAIR_MS[i];
      if (verdict === "stale" || !left(record)) {
        if (!fence(at, record)) return ENDED_P;
        if (verdict === "stale") return FENCED;
      }
      if (wait === undefined) return entitled(at) ? FENCED : ENDED_P;
      await sleep(wait);
    }
  };
  /**
   * Revision 16 (review 17's R36-J; design assessment C1): the page's departure cancelled the call of `record`: its `pagehide` began
   * since the call was issued (and no `pageshow` since); a `beforeunload` alone never. A record already fenced has nothing to decide.
   */
  const left = (record: Protected): boolean =>
    !record.published && departed(record.mark);
  /**
   * The permission of one admitted transmission (header: PERMISSION AT ISSUE), asked at the send boundary and before each hidden
   * resend: `s` is the schedule written with its admission, `until` its window's end (exclusive). Never throws.
   */
  const transmits =
    (at: Binding, s: Schedule, until: number, op: string) => () => {
      try {
        const now = deps.now();
        return (
          owns(at) &&
          mayRun() &&
          Number.isSafeInteger(now) &&
          now >= s.seen &&
          now < until &&
          now >= Math.max(s.next, s.server ?? 0) &&
          !fenced(at, op)
        );
      } catch {
        return false;
      }
    };

  /** This work's binding is still the displayed one (review R17). */
  const owns = (at: Binding) =>
    !disposed && at.service.live && deps.service() === at.service;
  /**
   * Revision 13 (R36-F; C3): the binding is not displayed at the moment, and has not ended: this runner is not disposed, its service has not
   * ended, it is still the service this runner's work is bound to (no other began since), and no other service is displayed. Evidence it
   * observed is kept for it; nothing is SENT in a gap (`owns` is the permission).
   */
  const gap = (at: Binding) => {
    if (disposed || at.service.ended || bound !== at.service) return false;
    const now = deps.service();
    return now === null || now === at.service;
  };
  /** Revision 13: what may keep (and fence) an observed outcome: its displayed binding, or its binding in a gap. */
  const entitled = (at: Binding) => owns(at) || gap(at);
  /** How work whose binding is no longer the displayed one ends: another service displayed, ended; none at the moment, a pause. */
  const lost = (at: Binding): Outcome => {
    if (disposed) return DONE;
    const now = deps.service();
    return now !== null && now !== at.service ? ENDED : PAUSED;
  };
  /** A commit that did not apply: its binding ended, or a pause (a store failure, the guards of the same binding). */
  const unapplied = (at: Binding): Outcome => (owns(at) ? PAUSED : lost(at));

  /**
   * The service this page's work last began under. Another one (review R17) retires what this page remembered of the old one: the days
   * it began or settled, its memory-only stops and its paused work, which is asked again as plain work (never resumed as the old one's).
   */
  let bound: AccountService | null = null;
  const rebind = (service: AccountService | null) => {
    if (service === null || service === bound) return;
    if (bound !== null) {
      attempted.clear();
      settledThrough.clear();
      for (const [key, item] of parked)
        parked.set(key, {
          taskId: item.taskId,
          trigger: item.trigger,
          manual: false,
          ...(item.throughDate === undefined
            ? {}
            : { throughDate: item.throughDate }),
        });
      repairs.clear();
      edgeScan = null;
      if (
        state.unrecorded.size > 0 ||
        state.zones.size > 0 ||
        state.asked.size > 0
      )
        set({ unrecorded: new Map(), zones: new Map(), asked: new Map() });
    }
    bound = service;
  };

  /**
   * Commits `next` (or deletes) over `row` as stored; on `stale`, what is stored now (adopted; `written` false). `null`: not applied.
   */
  const commit = async (
    service: AccountService,
    captured: ReturnType<AccountService["capture"]>,
    key: SequenceKey,
    expected: Sequence | null,
    next: Sequence | null,
  ): Promise<{ stored: Sequence | null; written: boolean } | null> => {
    const out = await commitMaterialiseSequence(service, captured, {
      key,
      expected: expected === null ? null : expectationOf(expected),
      next,
    });
    if (out.kind !== "applied") return null;
    return { stored: out.value.stored, written: out.value.kind === "written" };
  };
  /** Revision 12 (R36, C1): what one commit of `next` over `expected` came to, for `protect`. */
  const judgeRow =
    (expected: Sequence, next: Sequence | null) =>
    (out: { stored: Sequence | null; written: boolean } | null): Verdict =>
      out === null
        ? "failed"
        : out.written
          ? "written"
          : landedRow(expected, next, out.stored)
            ? "landed"
            : "stale";
  /**
   * A NEW row (revision 5): its growth admitted through the quota ledger first. `refused`: not admitted, nothing written; `null`: not
   * applied; on `stale`, what is stored now (adopted).
   */
  const create = async (
    service: AccountService,
    captured: ReturnType<AccountService["capture"]>,
    key: SequenceKey,
    next: Sequence,
  ): Promise<{ stored: Sequence | null } | "refused" | null> => {
    const quota = deps.quota?.() ?? null;
    const out = await commitMaterialiseSequence(
      service,
      captured,
      { key, expected: null, next },
      quota === null ? null : { quota },
    );
    if (out.kind !== "applied") return null;
    if (out.value.kind === "refused") return "refused";
    return { stored: out.value.stored };
  };
  /**
   * Revision 5 (reviews R24 and R25, WEB-04 §5.8): `position`, as a read of the task answered it (`captured`: its stamp), covers these
   * rows' days too: each is removed, only while it is still the row read (another page's lift, advance or new row of it stays). Rows not
   * covered stay, whatever their phase; a store failure removes nothing (the rows stay until a later read).
   */
  const clearSatisfied = async (
    at: Binding,
    captured: ReturnType<AccountService["capture"]>,
    taskId: string,
    position: Position,
    today: string,
    except?: string,
  ) => {
    const rows = await readTaskSequencesNow(at.service, taskId);
    if (rows === undefined || !owns(at)) return;
    const done = rows.filter(
      (row) =>
        row.through_date !== except &&
        satisfied(position, row.through_date, today),
    );
    if (done.length === 0) return;
    await clearSatisfiedSequences(at.service, captured, {
      task_id: taskId,
      rows: done.map((row) => ({
        through_date: row.through_date,
        expected: expectationOf(row) as NonNullable<
          ReturnType<typeof expectationOf>
        >,
      })),
    });
  };

  const readPosition = async (
    taskId: string,
    admitted?: () => boolean,
  ): Promise<PositionRead> => {
    const result = await deps.api.readTask(taskId, admitted);
    // A refusal is noted when it arrives (WEB-10a's consumer obligation), whatever this runner does next.
    noteIfRefused(deps.identity, POSITION_READ(taskId), result);
    return classifyRead(result);
  };

  /**
   * One sequence to its end, a stop, a pause or the end of its binding. `row` is the stored sequence this runner works from; every
   * transition is committed over it through the binding's service, and a lost compare-and-set adopts what is stored instead.
   *
   * Revision 10 (Decision B): each transmission is admitted first (`step`: written before it is made), and a wait parks the work until its
   * schedule's time (`at`). Revision 11 (R36): the call is issued only while its permission holds (`transmits`), and an answer whose
   * record is not applied while the binding still stands fences the day (`storage`, in memory and by its marker): what it answered is
   * never transmitted again automatically, on this page or another, before or after a reload. Revision 12 (R36-B): fenced at the FIRST
   * failed write, before its repairs wait (`protect`); a withdrawal of a call known not to have been sent alike.
   */
  const drive = async (
    at: Binding,
    start: Sequence,
    todayOf: () => string,
  ): Promise<Outcome> => {
    let row: Sequence | null = start;
    const key: SequenceKey = {
      task_id: start.task_id,
      through_date: start.through_date,
    };
    const service = at.service;
    const op = fenceOf(key.task_id, key.through_date);
    const storage = () =>
      stopInMemory(key.task_id, {
        reason: "storage",
        throughDate: key.through_date,
      });
    // Revision 11: how many calls this drive's own permission refused (each is withdrawn and decided again; never a loop).
    let refused = 0;
    while (row !== null && row.phase !== "stopped") {
      if (!owns(at)) return lost(at);
      if (!mayRun()) return PAUSED;
      // Revision 11 (R36): an outcome of this day that could not be recorded stands: nothing is transmitted for it automatically.
      if (fenced(at, op)) return storage();
      const plan = step(row, deps.now(), deps.newId);
      if (plan.kind === "wait") return { kind: "paused", at: plan.at };
      const admitted = await commit(
        service,
        service.capture(deps.epoch),
        key,
        row,
        plan.next,
      );
      if (admitted === null) return unapplied(at);
      row = admitted.stored;
      if (!admitted.written || plan.kind === "write" || row === null) continue;
      const issued = row;
      const captured = service.capture(deps.epoch);
      const permit = transmits(at, issued.schedule as Schedule, plan.until, op);
      // Revision 15 (R36-H/I): the page's lifecycle when the call is issued (its teardown after this mark cancelled it).
      const mark = markNow();
      let next: Sequence | null;
      let read: PositionRead | null = null;
      let answered: SendAnswer | ReadAnswer | Pause;
      // The permission is asked here too, before the call is handed on (then by the client and at the boundary).
      if (!permit()) answered = UNSENT;
      else if (plan.kind === "send") {
        const attempt = issued.attempt as { key: string; body: string };
        answered = classifySend(
          await deps.api.materialise(
            JSON.parse(attempt.body) as MaterialiseCommand,
            attempt.key,
            permit,
          ),
        );
      } else {
        read = await readPosition(issued.task_id, permit);
        answered = read.answer;
      }
      if (answered.kind === "pause") {
        // `closed` may follow a transmission: its admission stays (counted as lost when the work is taken up again).
        if (!answered.unsent) return owns(at) ? PAUSED : lost(at);
        // Not transmitted: the admission is withdrawn, nothing counted. Revision 12 (R36, C2): a withdrawal that cannot be written is
        // protected like an answer, so a reload never counts a call known not to have been made as a lost one.
        const unsent: Sequence = {
          ...issued,
          schedule: withdrawn(issued.schedule as Schedule),
        };
        const back = await protect(
          at,
          key.task_id,
          op,
          () => commit(service, captured, key, issued, unsent),
          judgeRow(issued, unsent),
          "never",
          key.through_date,
          mark,
        );
        if (back.kind === "ended") return lost(at);
        // Revision 13 (R36-F): kept for this binding, which is not displayed at the moment: written first when it is again.
        if (back.kind === "pending") return PAUSED;
        if (back.kind === "fenced") return storage();
        // Refused by its own permission (the window ended, the clock moved, a fence): the schedule decides again, sending nothing
        // until it admits. Any other refusal (the session held it) waits for a kick, as before.
        if (!owns(at) || !mayRun() || permit() || refused > 1) return PAUSED;
        refused += 1;
        row = (back.out as { stored: Sequence | null }).stored;
        continue;
      }
      next =
        plan.kind === "send"
          ? onSent(issued, answered as SendAnswer, deps.now())
          : onRead(issued, answered as ReadAnswer, todayOf(), deps.now());
      const outcome = next;
      // Revision 12 (R36-B): a record that fails is fenced at once (across pages and reloads) and kept for its repairs and the person's
      // press; one never written stops the day here. Revision 13 (R36-E/F): fenced from its receipt, before the first write; a first write
      // that finds another record is never adopted (no call is made from a peer's row on this answer's behalf: the day stops, `storage`);
      // an answer that arrives in a gap of its binding is kept for it (classified now, at its receipt, and written as classified).
      const settled = await protect(
        at,
        key.task_id,
        op,
        () => commit(service, captured, key, issued, outcome),
        judgeRow(issued, outcome),
        mustKeep(
          outcome,
          plan.kind === "send" && answered.kind === "ok",
          answered as SendAnswer | ReadAnswer,
        ),
        key.through_date,
        mark,
      );
      if (settled.kind === "ended") return lost(at);
      if (settled.kind === "pending") return PAUSED;
      if (settled.kind === "fenced") return storage();
      if (!owns(at)) return lost(at);
      const out = settled.out as { stored: Sequence | null; written: boolean };
      row = out.stored;
      if (row === null) {
        // The position covers this day; the task's other days it covers are satisfied too (revision 5). Revision 13: written or landed
        // (the row was gone already: its day is covered, as this read shows).
        if (next === null && read?.answer.kind === "ok")
          await clearSatisfied(
            at,
            captured,
            key.task_id,
            read.answer.position,
            todayOf(),
            key.through_date,
          );
        set({ finished: state.finished + 1 });
        return DONE;
      }
    }
    if (row?.phase === "stopped") set({ stops: state.stops + 1 });
    return DONE;
  };

  /** A discovery stop that could not be recorded: kept in this page's memory, which refuses automatic work alike. */
  const stopInMemory = (taskId: string, stop: Omit<UnrecordedStop, "id">) => {
    unrecord(taskId, stop);
    set({ stops: state.stops + 1 });
    return DONE;
  };

  /**
   * The person's "Try again", under the lock (review R13), through the binding it was pressed under (R17): lifts the discovery stop and
   * the day's stopped sequence it was pressed on, if they still stand as seen, in ONE compare-and-set (revision 4, review R20: both or
   * neither; the sequence compared by its revision, so a stop that came back the same way after another press's budget is not the one
   * pressed on). Only a lift WRITTEN here admits a fresh budget: another press, here or in another tab, that lifted them first leaves this
   * one with nothing to add. An observed reconnection's lift (`online`) is made the same way, keeping the calls counted.
   *
   * Revision 12 (R36-A; C3): the outcomes of the task this page kept are written FIRST (a press's own act), each ending only the failure
   * it published, before anything is lifted: a lift over the record a repair must apply to would make that repair stale. A fence still
   * standing then (one with no outcome here: a reload's, another page's, a newer one) is never ended by the press: the stop stays shown and
   * nothing is lifted or transmitted. `lifted`: the work goes on; `stale`: the stop pressed on no longer stands as seen (what stands is
   * shown); `held`: a fence, or a repair not written, keeps it stopped.
   */
  const lift = async (
    at: Binding,
    item: Item,
    retry: Retry,
  ): Promise<"lifted" | "stale" | "held"> => {
    const seen = retry.discovery;
    const stopped = retry.sequence;
    const online = retry.online === true;
    const day = item.throughDate;
    const held = () => {
      if (!online && owns(at))
        stopInMemory(item.taskId, {
          reason: "storage",
          ...(day === undefined ? {} : { throughDate: day }),
        });
      return "held" as const;
    };
    if (!online)
      for (const record of [...repairs.values()]) {
        if (record.service !== at.service || record.task !== item.taskId)
          continue;
        const { verdict } = await record.attempt();
        if (!owns(at)) return "held";
        if (verdict !== "written" && verdict !== "landed") return held();
        reconcile(record);
      }
    if (
      fenced(at, fenceOf(item.taskId)) ||
      (day !== undefined && fenced(at, fenceOf(item.taskId, day)))
    )
      return held();
    const now = deps.now();
    if (seen?.stop || stopped !== null) {
      const out = await commitMaterialiseLift(
        at.service,
        at.service.capture(deps.epoch),
        {
          task_id: item.taskId,
          // Revision 6 (review R30): the discovery as the press saw it is compared inside the same transaction, a stop or NONE; a stop
          // recorded while this press waited makes the whole lift stale (nothing lifted, the sequence's stop and its attempt kept).
          discovery: seen?.stop
            ? {
                kind: "stopped",
                expected: seen,
                next: liftedDiscovery(seen, now, !online),
              }
            : { kind: "no_stop" },
          // A fresh budget from the position reached, the held attempt (if any) kept: same key, same body (CM-440).
          sequence:
            stopped === null
              ? null
              : {
                  key: {
                    task_id: stopped.task_id,
                    through_date: stopped.through_date,
                  },
                  expected: expectationOf(stopped) as NonNullable<
                    ReturnType<typeof expectationOf>
                  >,
                  // Revision 10: a reconnection resumes where it paused (its calls kept); the person's press is a fresh budget.
                  next: online
                    ? resumeOnline(stopped, now)
                    : freshBudget(stopped, now),
                },
        },
      );
      if (out.kind !== "applied" || out.value.kind !== "written")
        return "stale";
    }
    if (!owns(at)) return "held";
    unrecord(item.taskId);
    return "lifted";
  };

  /**
   * The first read of a task, ADMITTED and counted by its discovery entry (W27): its zone (its day) and position. Before each read the
   * entry claims it (a fresh `attempt`; revision 3, R16) and, since revision 10 (Decision B), records its issue in the entry's schedule, so
   * its answer can always be recorded and an answer never recorded counts as lost when it was issued; an answer is recorded only over its
   * own attempt, through the binding's service with its read's stamp (R17). A failed read is paced by the schedule (the work is parked
   * until its next time) and stops when the schedule pauses (its window, or the third unrecognised answer), as does a definite refusal. A
   * stop already standing admits no read; an entry the quota ledger would not admit sends nothing. An entry of an earlier build whose
   * failures have no schedule, or an untrusted schedule, is stopped for the person, sending nothing.
   */
  const discover = async (
    at: Binding,
    item: Item,
    again = false,
  ): Promise<
    | {
        kind: "ok";
        read: PositionRead;
        captured: ReturnType<AccountService["capture"]>;
      }
    | { kind: "end"; outcome: Outcome }
  > => {
    const end = (outcome: Outcome) => ({ kind: "end" as const, outcome });
    if (state.unrecorded.has(item.taskId)) return end(DONE);
    const op = fenceOf(item.taskId);
    // Revision 11 (R36): an answer of this discovery that could not be recorded stands (any page's, a reload's): nothing is read.
    if (fenced(at, op))
      return end(stopInMemory(item.taskId, { reason: "storage" }));
    const entries = await readMaterialiseDiscoveryNow(at.service);
    if (!owns(at)) return end(lost(at));
    if (entries === undefined) return end(PAUSED);
    let entry: MaterialiseDiscovery | null = entries[item.taskId] ?? null;
    if (entry?.stop) {
      // A stop written before claims existed names no claim: it is given one, sending nothing and changing no count, so a press can
      // name it by an identity that never recurs (revision 5, R26). Until that is written, only a press naming no claim lifts it.
      if ((entry.attempt ?? null) === null)
        await commitMaterialiseDiscovery(
          at.service,
          at.service.capture(deps.epoch),
          {
            task_id: item.taskId,
            expected: entry,
            next: { ...entry, attempt: deps.newId() },
          },
        );
      return end(DONE);
    }
    const quota = deps.quota?.() ?? null;
    /** `next` over the entry this work admitted, through its own service, stamped as given (an answer: its read's issue). */
    const record = async (
      captured: ReturnType<AccountService["capture"]>,
      next: MaterialiseDiscovery | null,
    ) => {
      const out = await commitMaterialiseDiscovery(
        at.service,
        captured,
        { task_id: item.taskId, expected: entry, next },
        quota === null ? null : { quota },
      );
      if (!owns(at)) return "lost" as const;
      // Revision 11 (R36): dropped while the binding stands (the persistence hold could not vouch for it) is not written either.
      if (out.kind !== "applied") return "failed" as const;
      if (out.value.kind !== "written") return out.value.kind;
      entry = out.value.stored;
      return "written" as const;
    };
    /**
     * An ANSWER's record (revision 11), or a withdrawal's (revision 12, C2: a call known not to have been made). Revision 12 (R36-A/B):
     * PROTECTED: a first write that fails (or that the quota ledger refuses) is written again after each of `REPAIR_MS`; one never written
     * stays fenced (header) and is kept for the person's press, which writes it first. Revision 13 (R36-E/F; C1): fenced from its receipt;
     * written over the entry as it was when the answer arrived (`expected`, never a later one), so a repair compares what the answer was
     * decided on. A write that finds this very entry stored (`landed`; for a success, no entry: its removal) is recorded; one that finds
     * another (`stale`, the first write included) proves nothing and stays fenced. `failed`: not recorded, fenced; `pending`: kept for this
     * binding, not displayed at the moment.
     */
    /** Revision 15 (R36-H/I): the page's lifecycle when this work's read was issued (taken again just before it is). */
    let mark = markNow();
    const answered = async (
      captured: ReturnType<AccountService["capture"]>,
      next: MaterialiseDiscovery | null,
      answer?: ReadAnswer,
    ) => {
      const expected = entry;
      const p = await protect(
        at,
        item.taskId,
        op,
        () =>
          commitMaterialiseDiscovery(
            at.service,
            captured,
            { task_id: item.taskId, expected, next },
            quota === null ? null : { quota },
          ),
        (out): Verdict =>
          out.kind !== "applied" || out.value.kind === "refused"
            ? "failed"
            : out.value.kind === "written"
              ? "written"
              : same(out.value.stored, next)
                ? "landed"
                : "stale",
        mustKeep(next, false, answer),
        undefined,
        mark,
      );
      if (p.kind === "ended") return "lost" as const;
      if (p.kind === "pending") return "pending" as const;
      if (p.kind === "fenced") return "failed" as const;
      if (p.out.kind === "applied") entry = p.out.value.stored;
      return "written" as const;
    };
    /** The entry with `s` as its schedule (a pause is its stop, kept with the claim it stopped on). */
    const scheduled = (
      base: MaterialiseDiscovery,
      s: Schedule,
      stop: MaterialiseDiscovery["stop"] = s.pause === null
        ? null
        : { reason: "unreachable" },
    ): MaterialiseDiscovery => ({
      retry: base.retry,
      failures: s.failures,
      stop,
      attempt: base.attempt ?? null,
      schedule: s,
    });
    /** A stop of the task's entry, recorded (or held in memory when it cannot be). `answer`: it records an answer (revision 11). */
    const stopWith = async (
      captured: ReturnType<AccountService["capture"]>,
      next: MaterialiseDiscovery,
      answer = false,
    ) => {
      const written = answer
        ? await answered(captured, next)
        : await record(captured, next);
      if (written === "lost") return end(lost(at));
      // Revision 13 (R36-F): an answer kept for its binding in a gap is written when the binding is displayed again.
      if (written === "pending") return end(PAUSED);
      if (written === "stale") return end(DONE);
      if (written !== "written")
        return end(
          stopInMemory(item.taskId, {
            reason: next.stop?.reason ?? "unreachable",
            ...(next.stop?.request_id
              ? { requestId: next.stop.request_id }
              : {}),
          }),
        );
      set({ stops: state.stops + 1 });
      return end(DONE);
    };
    const now = deps.now();
    const base = entry ?? NO_DISCOVERY;
    // Revision 10: failures of an earlier build have no schedule to carry on from; an untrusted schedule grants nothing. Revision 11
    // (R36): nor has a claim of an earlier build, which may be a read admitted and never answered (failures 0); a current entry always
    // has its `schedule` key, `null` when nothing is outstanding.
    const stored =
      entry === null
        ? null
        : entry.schedule === undefined
          ? entry.failures > 0 || (entry.attempt ?? null) !== null
            ? ("legacy" as const)
            : null
          : readSchedule(entry.schedule, "discovery");
    if (stored === "legacy" || stored === "invalid")
      // Its count of failures is kept as it was; no time is invented for it.
      return stopWith(at.service.capture(deps.epoch), {
        ...scheduled(
          base,
          pausedSchedule(
            null,
            "discovery",
            stored === "legacy" ? "legacy" : "clock",
            now,
          ),
        ),
        failures: base.failures,
      });
    let s = stored;
    if (s?.issued != null) {
      // Issued and never recorded (a reload, another tab's turn): lost, when it was issued.
      s = unanswered(s, "discovery");
      if (s.pause !== null)
        return stopWith(at.service.capture(deps.epoch), scheduled(base, s));
    }
    const g = gate(s, now);
    if (g.kind === "pause")
      return stopWith(
        at.service.capture(deps.epoch),
        scheduled(base, pausedSchedule(s, "discovery", g.pause, now)),
      );
    if (g.kind === "wait") {
      // Only the count of the lost issue is written; nothing is sent until its time.
      if (s !== stored && s !== null) {
        const written = await record(
          at.service.capture(deps.epoch),
          scheduled(base, s),
        );
        if (written === "lost") return end(lost(at));
        if (written !== "written" && written !== "stale")
          return end(stopInMemory(item.taskId, { reason: "storage" }));
      }
      return end({ kind: "paused", at: g.at });
    }
    // Admission: the read is claimed in the entry before it is sent (a new task's entry admitted through the quota ledger).
    const admitted = await record(at.service.capture(deps.epoch), {
      ...base,
      failures: s?.failures ?? base.failures,
      attempt: deps.newId(),
      schedule: issue(s, "discovery", now),
    });
    if (admitted === "lost") return end(lost(at));
    // Another page decided meanwhile (its record is what is shown); nothing was sent.
    if (admitted === "stale") return end(DONE);
    if (admitted === "failed") return end(PAUSED);
    if (admitted === "refused")
      return end(stopInMemory(item.taskId, { reason: "storage" }));
    const issued = entry as unknown as MaterialiseDiscovery;
    const until =
      s?.since == null ? Number.POSITIVE_INFINITY : s.since + WINDOW_MS;
    const captured = at.service.capture(deps.epoch);
    const permit = transmits(at, issued.schedule as Schedule, until, op);
    mark = markNow();
    const read: PositionRead = permit()
      ? await readPosition(item.taskId, permit)
      : { answer: UNSENT, zone: null };
    // An answer for an ended binding is dropped: it is never recorded in another database (R17). Revision 13 (R36-F): one that arrives
    // while its binding is momentarily not displayed is kept for it (`answered`: `pending`).
    if (read.answer.kind === "pause") {
      // `closed` may follow a transmission (revision 11): its claim stays, counted as lost when the task is taken up again.
      if (!read.answer.unsent) return end(owns(at) ? PAUSED : lost(at));
      // Not sent after all: the admission is withdrawn, nothing counted. Revision 11 (R36): with an explicit `schedule: null` when
      // nothing is outstanding, so it is never read as an earlier build's unanswered claim. Revision 12 (C2): protected like an answer.
      const back = await answered(captured, {
        ...issued,
        schedule: withdrawn(issued.schedule as Schedule),
      });
      if (back === "lost") return end(lost(at));
      if (back === "pending") return end(PAUSED);
      if (back === "failed")
        return end(stopInMemory(item.taskId, { reason: "storage" }));
      // Refused by its own permission: the schedule decides again at once (a pause written, or a wait), sending nothing.
      if (back === "written" && !again && owns(at) && mayRun() && !permit())
        return discover(at, item, true);
      return end(PAUSED);
    }
    if (read.answer.kind === "ok" && read.zone !== null) {
      // Found: the discovery's failures are over (its entry goes, only its own); a page's memory stop of it is lifted by its success.
      const done = await answered(captured, null);
      if (done === "lost") return end(lost(at));
      if (done === "pending") return end(PAUSED);
      // Revision 10: its record could not be written: nothing more is sent automatically for the task here.
      if (done !== "written")
        return end(stopInMemory(item.taskId, { reason: "storage" }));
      if (state.unrecorded.has(item.taskId)) unrecord(item.taskId);
      return { kind: "ok", read, captured };
    }
    if (read.answer.kind !== "uncertain")
      return stopWith(
        captured,
        {
          ...scheduled(issued, {
            ...(issued.schedule as Schedule),
            issued: null,
          }),
          stop: {
            reason: "rejected",
            ...(read.answer.kind === "rejected" && read.answer.requestId
              ? {
                  request_id: read.answer.requestId.slice(
                    0,
                    DISCOVERY_REQUEST_ID,
                  ),
                }
              : {}),
          },
        },
        true,
      );
    const after = failed(
      issued.schedule as Schedule,
      "discovery",
      read.answer.retry,
      deps.now(),
      true,
    );
    if (after.pause !== null)
      return stopWith(captured, scheduled(issued, after), true);
    // Revision 14 (R36-G): a failure the server answered is fenced from its receipt (its count and its pace survive a lost first write).
    const written = await answered(
      captured,
      scheduled(issued, after),
      read.answer,
    );
    if (written === "lost") return end(lost(at));
    if (written === "pending") return end(PAUSED);
    if (written !== "written")
      return end(stopInMemory(item.taskId, { reason: "unreachable" }));
    return end({ kind: "paused", at: after.next });
  };

  /** Finds or begins the sequence of one task through its day, then drives it, under the binding it began with. */
  const work = async (item: Item): Promise<Outcome> => {
    const service = alive();
    if (service === null) return PAUSED;
    rebind(service);
    const at: Binding = { service };
    // Revision 13 (R36-F; C3/C6): an outcome this binding observed while it was not displayed is written FIRST, before the task's lifts,
    // reads or calls: its work then goes on from what it recorded (a 429's deadline, a success's position read). One not written stops it.
    for (const record of [...repairs.values()]) {
      if (
        !record.pending ||
        record.service !== service ||
        record.task !== item.taskId
      )
        continue;
      const kept = await settle(at, record);
      if (kept.kind === "pending") return PAUSED;
      if (kept.kind === "ended") return lost(at);
      if (kept.kind === "fenced")
        return stopInMemory(item.taskId, {
          reason: "storage",
          ...(record.day === undefined ? {} : { throughDate: record.day }),
        });
    }
    // A press made under another binding lifts nothing here: the work is asked as the person asked it, and a stop still standing shows.
    // A press is spent once its lift is tried (revision 10): work it parks later resumes as plain work. Revision 12 (R36-C): the press
    // first, then a reconnection's lift kept beside it, only if the press's stop no longer stood; each is consumed here, once.
    const entitled = [item.retry, item.edge].filter(
      (r): r is Retry => r !== undefined && r.service === service,
    );
    delete item.retry;
    delete item.edge;
    if (entitled.length > 0) {
      let verdict: "lifted" | "stale" | "held" = "stale";
      for (const retry of entitled) {
        verdict = await lift(at, item, retry);
        if (verdict !== "stale" || !owns(at)) break;
      }
      if (verdict !== "lifted") return owns(at) ? DONE : lost(at);
    }
    if (!owns(at)) return lost(at);
    // Revision 10: paused work of a known day whose zone this page read under this binding is taken up where it stood, with no discovery
    // read (a discovery read is never the sequence's position read).
    const known =
      item.resume && item.throughDate !== undefined
        ? state.zones.get(item.taskId)
        : undefined;
    let found: Exclude<
      Awaited<ReturnType<typeof discover>>,
      { kind: "end" }
    > | null = null;
    if (known === undefined) {
      const discovered = await discover(at, item);
      if (discovered.kind === "end") return discovered.outcome;
      found = discovered;
      if (!owns(at)) return lost(at);
    }
    const read = found?.read ?? null;
    if (read !== null && (read.answer.kind !== "ok" || read.zone === null))
      return PAUSED;
    const zone = (read?.zone ?? known) as string;
    zoneFound(item.taskId, zone);
    const today = () => todayIn(zone, deps.now());
    const throughDate = item.throughDate ?? today();
    // Its today found (revision 6, R29): the work is that day's from here, so the same day asked meanwhile is not asked twice.
    currentKey = workKey({ taskId: item.taskId, throughDate });
    const captured = found?.captured ?? at.service.capture(deps.epoch);
    const answer = read?.answer.kind === "ok" ? read.answer : null;
    // What the position read covers of the task's OTHER days is satisfied (revision 5): those rows go, a stopped one included. This day's
    // own row is decided by its sequence below, as before (adopted, resent with its own key, or read).
    if (answer !== null)
      await clearSatisfied(
        at,
        captured,
        item.taskId,
        answer.position,
        today(),
        throughDate,
      );
    if (!owns(at)) return lost(at);
    const key: SequenceKey = {
      task_id: item.taskId,
      through_date: throughDate,
    };
    const mark = `${item.taskId}|${throughDate}`;
    if (!item.manual && !item.resume && attempted.has(mark)) return DONE;
    attempted.add(mark);
    settledThrough.set(item.taskId, { zone, day: throughDate });
    // From here the work is this sequence's: a pause resumes THIS key (`park`), never a new day's or a fresh attempt's. A thrown read
    // or store is such a pause too (its record says where it stands).
    const paused: Outcome = { kind: "paused", throughDate };
    try {
      return await sequence(at, item, answer, {
        key,
        throughDate,
        today,
        captured,
        paused,
      });
    } catch {
      return paused;
    }
  };

  /**
   * The sequence of one task through its day: adopted as stored, or begun (stamped with the read that found its day; with none, work taken
   * up again finds nothing to begin); then driven.
   */
  const sequence = async (
    at: Binding,
    item: Item,
    answer: Extract<ReadAnswer, { kind: "ok" }> | null,
    day: {
      key: SequenceKey;
      throughDate: string;
      today: () => string;
      captured: ReturnType<AccountService["capture"]>;
      paused: Outcome;
    },
  ): Promise<Outcome> => {
    const { key, throughDate, today, captured, paused } = day;
    const service = at.service;
    const stored = await readMaterialiseSequenceNow(service, key);
    if (!owns(at)) return lost(at);
    if (stored === undefined) return paused;
    if (stored !== null) {
      // Adopted: a sequence another page began, or one this page left on a reload. A stop is shown, never resumed automatically. A row
      // awaiting its position is read under its own admission (revision 10: one read, never another `materialise`; CM-440).
      if (stored.phase === "stopped") return DONE;
      return keyed(await drive(at, stored, today), throughDate);
    }
    if (answer === null) return DONE;
    const fresh = begin({
      taskId: item.taskId,
      throughDate,
      trigger: item.trigger,
      generation: deps.newId(),
      nowMs: deps.now(),
      position: answer.position,
      today: today(),
    });
    if (fresh === null) {
      set({ finished: state.finished + 1 });
      return DONE;
    }
    // A new row grows the store: admitted first (revision 5). Earlier days are NOT removed because this one begins (review R25): each
    // stays, with its attempt, until a read shows its own day covered.
    const created = await create(service, captured, key, fresh);
    if (created === "refused")
      return owns(at)
        ? stopInMemory(item.taskId, {
            reason: "storage",
            throughDate: key.through_date,
          })
        : lost(at);
    if (created === null) return owns(at) ? paused : lost(at);
    if (created.stored === null) return DONE;
    if (created.stored.phase === "stopped") {
      set({ stops: state.stops + 1 });
      return DONE;
    }
    return keyed(await drive(at, created.stored, today), throughDate);
  };

  const loop = async (): Promise<void> => {
    while (queue.length > 0 && mayRun()) {
      const item = queue.shift() as Item;
      currentKey = workKey(item);
      publishQueue(item.taskId);
      let outcome: Outcome;
      try {
        outcome = await work(item);
      } catch {
        // A thrown read or store: the work did not end, so it is kept as a pause (its record says where it stands).
        outcome = PAUSED;
      }
      if (outcome.kind === "paused") {
        park(item, outcome.throughDate, outcome.at);
        arm();
      }
      // Its binding ended: the task is asked again under the one displayed now, as plain work (R17); once in a row, then it waits
      // for the next kick (a binding that keeps changing must not spin this loop).
      else if (outcome.kind === "ended" && !disposed) {
        const again: Item = {
          taskId: item.taskId,
          trigger: item.trigger,
          manual: false,
          rebound: true,
          ...(item.throughDate === undefined
            ? {}
            : { throughDate: item.throughDate }),
        };
        if (item.rebound) parked.set(workKey(item), again);
        else queue.unshift(again);
      }
      currentKey = null;
      publishQueue(null);
    }
  };

  const pump = (): void => {
    if (running || disposed || queue.length === 0 || !mayRun()) return;
    running = true;
    const finish = () => {
      running = false;
      set({ waiting: false });
      // Work that arrived while the lock was held (or waited for) runs next.
      if (queue.length > 0 && mayRun()) pump();
    };
    if (locks === null) {
      void loop().finally(finish);
      return;
    }
    set({ waiting: true });
    locks
      .request(
        `atlas-materialise:${deps.accountId}`,
        { signal: abort.signal },
        async () => {
          set({ waiting: false });
          await loop();
        },
      )
      .then(finish, finish);
  };

  /** Queues the task's day as asked (its today when `throughDate` is absent), unless it is already asked, handled or refused here. */
  const admit = (
    taskId: string,
    trigger: Trigger,
    throughDate: string | undefined,
  ): boolean => {
    // The same task and day is queued or worked on already (another day of the task is other work: revision 5, R24/R25).
    if (pending(workKey({ taskId, throughDate }))) return false;
    // A discovery stop this page could not record admits nothing automatic either (a recorded one is refused where the work begins).
    if (state.unrecorded.has(taskId)) return false;
    // Brought up to date (or found stopped) through this task's today already on this page: nothing to ask again.
    const known = settledThrough.get(taskId);
    if (
      throughDate === undefined &&
      known !== undefined &&
      todayIn(known.zone, deps.now()) === known.day
    )
      return false;
    if (throughDate !== undefined && attempted.has(`${taskId}|${throughDate}`))
      return false;
    queue.push({
      taskId,
      trigger,
      ...(throughDate ? { throughDate } : {}),
      manual: false,
    });
    return true;
  };

  /**
   * Revision 11 (review R36): the lift of one observed reconnection, over EVERY row of the account (keyset pages until a short one) and
   * every discovery entry: each pause by its retry window that stood at the reconnection (`seen` no later than `edge`; a pause recorded
   * since is another one) is queued once, its lift compared as read. A page that cannot be read leaves the scan where it is (`after`), for
   * the next kick under the same binding; another binding ends it.
   */
  interface EdgeScan {
    service: AccountService;
    edge: number;
    after: readonly [string, string] | null;
    entries: Record<string, MaterialiseDiscovery> | null;
    /** The tasks whose discovery pause is lifted with one of their rows (both or neither, as before). */
    paired: Set<string>;
    busy: boolean;
  }
  let edgeScan: EdgeScan | null = null;
  const pausedAt = (
    s: ReturnType<typeof readSchedule>,
    edge: number,
  ): boolean => resumable(s) && (s as Schedule).seen <= edge;
  const scan = async (e: EdgeScan): Promise<void> => {
    if (e.busy) return;
    e.busy = true;
    const current = () =>
      edgeScan === e &&
      !disposed &&
      e.service.live &&
      deps.service() === e.service;
    const lifts = (item: Item) => {
      const key = workKey(item);
      parked.delete(key);
      const queued = queue.find((q) => workKey(q) === key);
      if (queued === undefined) {
        queue.push(item);
        return;
      }
      queued.manual = true;
      // Revision 12 (R36-C): a press queued for the work keeps its fresh budget; this lift is kept beside it, never in its place.
      if (queued.retry !== undefined && queued.retry.online !== true)
        queued.edge = item.retry as Retry;
      else queued.retry = item.retry as Retry;
    };
    try {
      if (e.entries === null) {
        const entries = await readMaterialiseDiscoveryNow(e.service);
        if (!current() || entries === undefined) return;
        e.entries = entries;
      }
      const entries = e.entries;
      const discoveryOf = (taskId: string) => {
        const entry = entries[taskId];
        if (
          entry?.stop == null ||
          e.paired.has(taskId) ||
          !pausedAt(readSchedule(entry.schedule, "discovery"), e.edge)
        )
          return null;
        e.paired.add(taskId);
        return entry;
      };
      for (;;) {
        const page = await readSequencePageNow(e.service, e.after);
        if (!current() || page === undefined) return;
        for (const row of page.rows) {
          if (
            !pausedAt(readSchedule(row.schedule, callerOf(row)), e.edge) ||
            resumeOnline(row, deps.now()) === row
          )
            continue;
          lifts({
            taskId: row.task_id,
            trigger: row.trigger,
            throughDate: row.through_date,
            manual: true,
            retry: {
              online: true,
              discovery: discoveryOf(row.task_id),
              sequence: row,
              service: e.service,
            },
          });
        }
        const last = page.rows.at(-1);
        if (page.complete || last === undefined) break;
        e.after = [last.task_id, last.through_date];
        publishQueue();
        pump();
      }
      for (const taskId of Object.keys(entries)) {
        const discovery = discoveryOf(taskId);
        if (discovery !== null)
          lifts({
            taskId,
            trigger: "daily",
            manual: true,
            retry: {
              online: true,
              discovery,
              sequence: null,
              service: e.service,
            },
          });
      }
      if (edgeScan === e) edgeScan = null;
    } finally {
      e.busy = false;
      if (!disposed) {
        publishQueue();
        pump();
      }
    }
  };

  /**
   * Revision 15 (R36-I): a page shown again (a back-forward restore) after a `pagehide` publishes the fence of every outcome it holds
   * whose write failed while it was being torn down, in that outcome's own lifetime only (`fence`). Revision 16 (review 17's R36-J;
   * design assessment C4, invariant 6): and of every other outcome its departure left unpublished, not only a failed one: one whose fence
   * at receipt was withheld (its write may be on its way still) and one kept in a gap (`pending`). The page goes on: what it observed
   * is its own again.
   */
  const unshown = deps.lifecycle?.subscribe(() => {
    if (disposed) return;
    for (const record of [...repairs.values()])
      if (
        !record.published &&
        (record.failed || record.withheld || record.pending) &&
        !departed(record.mark)
      )
        fence({ service: record.service }, record);
  });

  return {
    identity: deps.identity,
    ensure(taskId, trigger, options = {}) {
      if (disposed) return;
      rebind(alive());
      if (options.throughDate !== undefined)
        noteAsked(taskId, options.throughDate);
      // Work on this task that paused part-way is taken up again (review R1), whichever trigger asks; then the day asked for is admitted
      // ON ITS OWN (revision 6, review R29): resuming another day's work never stands in for it, and the same day is not asked twice.
      const resumed = unpark(taskId);
      const admitted = admit(taskId, trigger, options.throughDate);
      if (!resumed && !admitted) return;
      publishQueue();
      pump();
    },
    tryAgain(taskId, throughDate, seen) {
      if (disposed) return;
      void (async () => {
        // What the person pressed it on, as stored now: lifted under the lock only if it still stands so (review R13), and only if it
        // is the stop the screen showed (review R20).
        const service = alive();
        rebind(service);
        // The day pressed on: the record's own, else the day of a row this page could not admit (revision 6, R29), else the day last
        // worked here.
        const day =
          throughDate ??
          state.unrecorded.get(taskId)?.throughDate ??
          settledThrough.get(taskId)?.day;
        let discovery: MaterialiseDiscovery | null = null;
        let sequence: Sequence | null = null;
        if (service !== null) {
          const entries = await readMaterialiseDiscoveryNow(service);
          if (entries === undefined) return;
          discovery = entries[taskId] ?? null;
          if (day !== undefined) {
            const stored = await readMaterialiseSequenceNow(service, {
              task_id: taskId,
              through_date: day,
            });
            if (stored === undefined) return;
            if (stored?.phase === "stopped") sequence = stored;
          }
          if (seen !== undefined) {
            const shown = pressedOn(
              seen,
              discovery,
              sequence,
              state.unrecorded.get(taskId),
            );
            if (shown === null) return;
            ({ discovery, sequence } = shown);
          }
        } else if (
          seen !== undefined &&
          seen.kind === "memory" &&
          state.unrecorded.get(taskId)?.id !== seen.id
        )
          return;
        if (disposed) return;
        // The person's act supersedes paused work on the task and THAT day (revision 6, R29: exactly that day; another day's paused
        // work, or an implicit today not resolved yet, is other work and stays): it is asked for again, once.
        const pressed = workKey({ taskId, throughDate: day });
        for (const [key, p] of parked)
          if (workKey(p) === pressed) parked.delete(key);
        // Revision 12 (R36-A): no fence is witnessed to be ended by the press: the press ends only failures whose outcome this page writes.
        const retry: Retry = { discovery, sequence, service };
        const queued = queue.find((q) => workKey(q) === pressed);
        if (queued !== undefined) {
          queued.manual = true;
          // Revision 12 (R36-C): a reconnection's lift queued for the work stays, behind the press (an earlier press is replaced).
          if (queued.retry?.online === true) queued.edge = queued.retry;
          queued.retry = retry;
        } else
          queue.push({
            taskId,
            trigger: "daily",
            ...(day === undefined ? {} : { throughDate: day }),
            manual: true,
            retry,
          });
        publishQueue();
        pump();
      })();
    },
    kick() {
      if (disposed) return;
      const service = alive();
      rebind(service);
      if (unpark()) publishQueue();
      // Revision 11 (R36): a reconnection's scan that could not finish carries on, under the binding it was observed with only.
      if (edgeScan !== null && edgeScan.service === service)
        void scan(edgeScan);
      pump();
    },
    reconnected() {
      if (disposed) return;
      const service = alive();
      rebind(service);
      if (unpark()) publishQueue();
      // Revision 12 (R36-D): no service displayed at the moment, while the one this page's work is bound to is still live: the edge is
      // kept for THAT service, with its time, and scanned by the next kick that finds it displayed again. None bound yet, an ended one or
      // another displayed: nothing is kept.
      const owner =
        service ?? (deps.service() === null && bound?.live ? bound : null);
      if (owner === null) {
        pump();
        return;
      }
      // The stops as stored at the reconnection: each is lifted only while it still stands so (a later stop is another one). A newer
      // reconnection replaces a scan still going (its stops are a superset); revision 11: every page of the account is read.
      edgeScan = {
        service: owner,
        edge: deps.now(),
        after: null,
        entries: null,
        paired: new Set(),
        busy: false,
      };
      if (service === null) pump();
      else void scan(edgeScan);
    },
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unshown?.();
      wakes += 1;
      queue.length = 0;
      parked.clear();
      abort.abort();
      set({ active: [], current: null, waiting: false });
    },
  };
}

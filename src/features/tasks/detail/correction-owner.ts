import type { CorrectionState } from "../model/correction";
import { onTaskVisitEnded, type TaskVisit } from "../visit";

/**
 * The owner of an occurrence correction being edited (R3, revision 2; design assessment C4). It lives in page memory, never in storage, and
 * OUTLIVES the dialog's mounts: the in-dialog sync control unmounts the dialog to show the queue and the next dialog for the same day and
 * identity resumes the same editing session. Every edit, wherever it is made, advances the session's revision here.
 *
 * A save captures `{session, revision}`. Its completion consumes the entry only when the entry is still that session at that revision: an
 * edit after the submission, a discard, a new session (numbers are never reused, so discard-and-reopen cannot match) or another identity
 * leaves the newer input alone. Closing is never done by the mount that saved: the owner tells the session's CURRENT editor, if one is
 * mounted, that its submitted draft was consumed, and that editor closes itself. A failed save only clears the pending mark.
 *
 * What was submitted is not kept here: the queued operation carries it durably (the conflict choices read it from there, C5).
 *
 * The session belongs to the logical visit of the screen it was opened on (revision 22, R34 / DA22-I1..I3; `visit.ts`): a dialog that
 * unmounts without being discarded or consumed (the data hid its day, the cache gate hid the screen, the in-dialog sync control) while that
 * visit goes on keeps a session holding input, for the next dialog of the day; the visit's end drops every session it owns that no dialog
 * holds, and the task detail lets go of a day it stops showing in place (`disownCorrection`).
 */
export interface CorrectionEntry {
  readonly session: number;
  readonly revision: number;
  readonly state: CorrectionState;
  /** Kept by the in-dialog sync control: the next dialog for this day resumes the session. */
  readonly retained: boolean;
  /** The revision a save of this session is waiting on, or null. */
  readonly submitting: number | null;
}

export interface CorrectionTicket {
  readonly key: string;
  readonly session: number;
  readonly revision: number;
}

export type CorrectionEvent =
  | { kind: "consumed"; session: number }
  | { kind: "settled"; session: number };

interface Held extends CorrectionEntry {
  holders: number;
  releasing: boolean;
  /** The visit whose input it is (null: a dialog outside any router). */
  owner: TaskVisit | null;
}

const entries = new Map<string, Held>();
const listeners = new Map<string, Set<(event: CorrectionEvent) => void>>();
let sessions = 0;

// A visit that ends drops every session it owns that no dialog holds (one still held is dropped when its dialog lets go).
onTaskVisitEnded((visit) => {
  for (const [key, held] of [...entries])
    if (held.owner === visit && held.holders === 0) entries.delete(key);
});

export const correctionKey = (identity: string, occurrenceId: string) =>
  `${identity}\u0000${occurrenceId}`;

function publish(key: string, event: CorrectionEvent): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener(event);
}

/** The entry for a day, or null. */
export function correctionEntry(key: string): CorrectionEntry | null {
  return entries.get(key) ?? null;
}

/** What a dialog opening now would show: the retained (or still held) session's state, else null. */
export function resumable(key: string): CorrectionState | null {
  const held = entries.get(key);
  return held !== undefined && (held.retained || held.releasing)
    ? held.state
    : null;
}

/**
 * A dialog for `key` mounts, on `owner`'s visit: it resumes a retained session (or the one a remount of the same dialog just let go of),
 * else starts a new session with `initial`. Sessions of any other identity are dropped (only the displayed identity's edits are kept), and
 * a session left by a visit that has ended is never resumed by another.
 */
export function openCorrection(
  key: string,
  identity: string,
  initial: () => CorrectionState,
  owner: TaskVisit | null = null,
): CorrectionEntry {
  for (const other of [...entries.keys()])
    if (!other.startsWith(`${identity}\u0000`)) entries.delete(other);
  const held = entries.get(key);
  if (
    held !== undefined &&
    (held.retained || held.releasing || held.holders > 0) &&
    !(held.owner !== null && held.owner !== owner && held.owner.ended())
  ) {
    held.holders += 1;
    held.releasing = false;
    const resumed: Held = { ...held, retained: false, owner };
    entries.set(key, resumed);
    return resumed;
  }
  sessions += 1;
  const created: Held = {
    session: sessions,
    revision: 0,
    state: initial(),
    retained: false,
    submitting: null,
    holders: 1,
    releasing: false,
    owner,
  };
  entries.set(key, created);
  return created;
}

/**
 * The dialog unmounts without a discard or a consumed save. While its visit goes on, a session holding input (an edit, a pending save, or
 * one the in-dialog sync control retained) is retained for the next dialog of the day. Otherwise it is dropped once nothing holds it
 * (after the current turn, so React's development remount of the same dialog resumes it rather than losing its input).
 */
export function releaseCorrection(key: string, session: number): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  held.holders = Math.max(0, held.holders - 1);
  if (held.holders > 0) return;
  const live = held.owner !== null && !held.owner.ended();
  if (held.retained && (held.owner === null || live)) return;
  if (live && (held.revision > 0 || held.submitting !== null)) {
    entries.set(key, { ...held, retained: true });
    return;
  }
  entries.set(key, { ...held, retained: false, releasing: true });
  dropReleasing(key, session);
}

/** Drops a released session after the current turn if by then no dialog holds it and nothing retained it. */
function dropReleasing(key: string, session: number): void {
  setTimeout(() => {
    const now = entries.get(key);
    if (
      now !== undefined &&
      now.session === session &&
      now.holders === 0 &&
      now.releasing &&
      !now.retained
    )
      entries.delete(key);
  }, 0);
}

/**
 * The visit lets go of a day's correction without ending (revision 22): the task detail showing another day in place lets go of the day it
 * showed, as a departure would. A session no dialog holds is dropped; a held one is dropped when its dialog lets go.
 */
export function disownCorrection(key: string): void {
  const held = entries.get(key);
  if (held === undefined) return;
  if (held.holders === 0) entries.delete(key);
  else entries.set(key, { ...held, retained: false, owner: null });
}

/**
 * A dialog React never removed is at its address again after the person left it (revision 24, R36): the visit going on there now owns the
 * session it still holds, so it is kept for that visit as a newly opened one would be. Only that exact session, and only while a dialog
 * holds it: a session no dialog holds belongs to the visit it was left on, ended or not.
 */
export function adoptCorrection(
  key: string,
  session: number,
  owner: TaskVisit,
): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session || held.holders === 0)
    return;
  entries.set(key, { ...held, owner });
}

export function editCorrection(
  key: string,
  session: number,
  state: CorrectionState,
): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  entries.set(key, { ...held, state, revision: held.revision + 1 });
}

/** The in-dialog sync control keeps the session for the next dialog of this day. */
export function retainCorrection(key: string, session: number): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  entries.set(key, { ...held, retained: true });
}

/** Cancel, Escape, the close icon: the session ends (a save already made stays queued). */
export function discardCorrection(key: string, session: number): void {
  const held = entries.get(key);
  if (held !== undefined && held.session === session) entries.delete(key);
}

/** A save begins: the ticket names exactly the session and revision submitted. */
export function submitCorrection(
  key: string,
  session: number,
): CorrectionTicket | null {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return null;
  entries.set(key, { ...held, submitting: held.revision });
  return { key, session, revision: held.revision };
}

/**
 * A save ended. Success consumes the entry only if it is still the submitted session at the submitted revision (`consumed`); otherwise
 * the newer input stays (`kept`), and a session that no longer exists is left alone (`gone`).
 */
export function completeCorrection(
  ticket: CorrectionTicket,
  saved: boolean,
): "consumed" | "kept" | "gone" {
  const held = entries.get(ticket.key);
  if (held === undefined || held.session !== ticket.session) return "gone";
  if (saved && held.revision === ticket.revision) {
    entries.delete(ticket.key);
    publish(ticket.key, { kind: "consumed", session: ticket.session });
    return "consumed";
  }
  entries.set(ticket.key, { ...held, submitting: null });
  publish(ticket.key, { kind: "settled", session: ticket.session });
  return "kept";
}

export function subscribeCorrection(
  key: string,
  listener: (event: CorrectionEvent) => void,
): () => void {
  let set = listeners.get(key);
  if (set === undefined) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** For tests and identity changes: forget every editing session (numbers are still never reused). */
export function forgetCorrectionSessions(): void {
  entries.clear();
}

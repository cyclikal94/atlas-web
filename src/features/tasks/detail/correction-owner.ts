import type { CorrectionState } from "../model/correction";

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
}

const entries = new Map<string, Held>();
const listeners = new Map<string, Set<(event: CorrectionEvent) => void>>();
let sessions = 0;
/** Days held by an open visit of the task detail showing them (`holdCorrection`), by count. */
const visits = new Map<string, number>();

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
 * A dialog for `key` mounts: it resumes a retained session (or the one a remount of the same dialog just let go of), else starts a new
 * session with `initial`. Sessions of any other identity are dropped (only the displayed identity's edits are kept).
 */
export function openCorrection(
  key: string,
  identity: string,
  initial: () => CorrectionState,
): CorrectionEntry {
  for (const other of [...entries.keys()])
    if (!other.startsWith(`${identity}\u0000`)) entries.delete(other);
  const held = entries.get(key);
  if (
    held !== undefined &&
    (held.retained || held.releasing || held.holders > 0)
  ) {
    held.holders += 1;
    held.releasing = false;
    const resumed: Held = { ...held, retained: false };
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
  };
  entries.set(key, created);
  return created;
}

/**
 * The dialog unmounts. An unretained session is dropped once nothing holds it (after the current turn, so React's development remount of
 * the same dialog resumes it rather than losing its input).
 */
export function releaseCorrection(key: string, session: number): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  held.holders = Math.max(0, held.holders - 1);
  if (held.holders > 0 || held.retained) return;
  held.releasing = true;
  dropReleasing(key, session);
}

/** Drops a released session after the current turn if by then no dialog, sync control or visit of its day holds it. */
function dropReleasing(key: string, session: number): void {
  if (visits.has(key)) return;
  setTimeout(() => {
    const now = entries.get(key);
    if (
      now !== undefined &&
      now.session === session &&
      now.holders === 0 &&
      now.releasing &&
      !now.retained &&
      !visits.has(key)
    )
      entries.delete(key);
  }, 0);
}

/**
 * The task detail's visit of a day holds that day's correction (revision 20, DA20-I1): a dialog that unmounts because the day left this
 * device keeps its session, still resumable by the next dialog for the day. Holding ADOPTS a session the in-dialog sync control retained
 * (revision 21, DA21-I2): it is the visit's from then on (still resumable), whether or not the dialog is opened again, so the visit's end
 * ends it. Letting go: `keep` (the visit went to the sync screens, or keeps the day parked) retains a session holding input (or the one it
 * adopted) as the in-dialog sync control does; otherwise an unheld session is dropped.
 */
export function holdCorrection(key: string): (keep: boolean) => void {
  visits.set(key, (visits.get(key) ?? 0) + 1);
  const found = entries.get(key);
  const adopted =
    found?.retained === true && found.holders === 0 ? found.session : null;
  if (found !== undefined && adopted !== null)
    entries.set(key, { ...found, retained: false, releasing: true });
  let holding = true;
  return (keep) => {
    if (!holding) return;
    holding = false;
    const left = (visits.get(key) ?? 1) - 1;
    if (left > 0) visits.set(key, left);
    else visits.delete(key);
    const held = entries.get(key);
    if (held === undefined || held.holders > 0 || held.retained) return;
    if (
      keep &&
      (held.revision > 0 ||
        held.submitting !== null ||
        held.session === adopted)
    ) {
      entries.set(key, { ...held, retained: true });
      return;
    }
    if (held.releasing) dropReleasing(key, held.session);
  };
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
  visits.clear();
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  forgetTaskVisits,
  onTaskVisitEnded,
  type TaskAttachment,
  type TaskVisit,
  useTaskAttachment,
  useTaskRouteMoved,
  useTaskScreenAt,
  useTaskVisit,
} from "./visit";

/**
 * Unsaved input of a task screen kept through a visit to the sync screens (revision 18, R33; WEB-02 ia.md §1.3.3, task states I1).
 *
 * Checking sync state is a deliberate navigation away, not a discard: the shell's sync control (or any other way to `/sync`) unmounts the
 * screen, and coming back (Back, or the queue's own close control) shows the same input, raw as typed (invalid and conditionally hidden
 * values included), never a blank or reset form, and never submits anything. Page memory only, never stored: a reload forgets it.
 *
 * Every entry is an editing SESSION of one editor (a task form, a progress amount, ...) of ONE displayed identity (`account:epoch`), keyed
 * by both, and given back only to that identity and that editor. Opening an editor for an identity forgets every other identity's
 * entries. A session is held by the editor mounted for it, and OWNED by the logical visit of the screen it was opened on (revision 22,
 * R34 / DA22-I1..I3; `visit.ts`): while that visit goes on (at its own address, or at the sync screens it went to) a session holding
 * something of the person's (an edit, a pending save, or a stage they chose) is kept whether or not any editor of it is mounted, so an
 * editor the data hides, a screen the cache gate hides and a visit to the sync screens all find it again; when the visit ends (an
 * ordinary departure from the screen or from the sync screens, another identity) every session it owns is dropped, mounted again or not.
 * A session holding nothing of the person's is dropped once no editor holds it, after the current turn (so React's development remount of
 * the same editor resumes it, and a definition synced meanwhile is shown afresh). Cancel, Escape and the close icon leave for somewhere
 * else, so they end the visit. The task detail lets go of the sessions of a day it stops showing in place (`disownKept`), as a departure
 * would.
 *
 * A save takes a ticket naming the session and the revision it submitted. Its completion, whichever mount made it and whether or not any
 * editor is mounted then, consumes the session only if it is still that session at that revision; newer input stays (with the note the
 * save left), and the session's CURRENT editor, if one is mounted, is told either way. Session numbers are never reused.
 *
 * Settling a save is not permission to act on the screen (revision 23, R35 / DA23): the editor told of a consumed session moves on (its
 * form closing onto the task, a fresh amount) only if it still PRESENTS (`visit.ts`, `TaskAttachment`), that is, the person has not
 * gone elsewhere, the sync screens included, since it opened. An editor the person left, still mounted while React removes it, just lets
 * go of the settled session: no navigation, no new session. A later return finds what the settlement left (a consumed save is not offered
 * again, newer input is still there). An editor React never removed (the person went away and came back before it re-rendered) is the
 * editor the person is at again (revision 24, R36): once its router is at its address it is attached anew, on the visit going on there,
 * which now owns the session it holds (`adoptKept`), so a later explicit save acts on the screen and a later visit to the sync screens
 * keeps its input. That new attachment is for later work only: a save taken before the departure acts, if at all, by the attachment it
 * was taken with. An editor whose session was consumed meanwhile starts afresh there, as a new mount would: a new session, from what the
 * screen shows now, never the consumed input to save twice and never an editor whose Save does nothing.
 */
export interface KeptEntry<T> {
  readonly session: number;
  /** Edits accepted in this session (0: opened and not edited). */
  readonly revision: number;
  readonly value: T;
  /** The revision a pending save of this session submitted, or null. */
  readonly submitting: number | null;
  /** What the last settled save left to say (a refusal, newer edits kept), or null. */
  readonly note: string | null;
}

export interface KeptTicket {
  readonly key: string;
  readonly session: number;
  readonly revision: number;
}

export type KeptEvent =
  | { kind: "consumed"; session: number; value: unknown; detail: string | null }
  | { kind: "settled"; session: number };

interface Held {
  session: number;
  revision: number;
  value: unknown;
  submitting: number | null;
  note: string | null;
  holders: number;
  /** The visit whose input it is (null: an editor outside any router, kept only while it is mounted). */
  owner: TaskVisit | null;
  /** Kept by its visit before it is edited (a creation stage the person chose, the detail's day). */
  unedited: boolean;
}

const entries = new Map<string, Held>();
const listeners = new Map<string, Set<(event: KeptEvent) => void>>();
let sessions = 0;

/** Holding something of the person's: an edit, a pending save, or a session kept before it is edited. */
const holdsInput = (held: Held) =>
  held.revision > 0 || held.submitting !== null || held.unedited;
/** Kept with no editor holding it: its visit goes on and it holds input. */
const retained = (held: Held) =>
  held.owner !== null && !held.owner.ended() && holdsInput(held);

// A visit that ends drops every session it owns that no editor holds (one still held is dropped when its editor lets go).
onTaskVisitEnded((visit) => {
  for (const [key, held] of [...entries])
    if (held.owner === visit && held.holders === 0) entries.delete(key);
});

export const keptKey = (identity: string, editor: string) =>
  `${identity}\u0000${editor}`;

/** The session an editor opening `key` now would resume, or null (an ended visit's session is never resumed). */
export function keptEntry<T>(key: string): KeptEntry<T> | null {
  const held = entries.get(key);
  if (held === undefined || held.owner?.ended()) return null;
  return held as KeptEntry<T>;
}

/**
 * An editor for `key` mounts, on `owner`'s visit: it resumes the session there (kept by the visit, or held by a remount of the same
 * editor), else starts one. A session left by a visit that has ended is never resumed by another (it is the ended visit's input).
 */
export function openKept<T>(
  key: string,
  identity: string,
  initial: () => T,
  owner: TaskVisit | null = null,
  unedited = false,
): KeptEntry<T> {
  for (const other of [...entries.keys()])
    if (!other.startsWith(`${identity}\u0000`)) entries.delete(other);
  const held = entries.get(key);
  if (
    held !== undefined &&
    !(held.owner !== null && held.owner !== owner && held.owner.ended())
  ) {
    held.holders += 1;
    held.owner = owner;
    held.unedited = unedited;
    return { ...held } as KeptEntry<T>;
  }
  sessions += 1;
  const created: Held = {
    session: sessions,
    revision: 0,
    value: initial(),
    submitting: null,
    note: null,
    holders: 1,
    owner,
    unedited,
  };
  entries.set(key, created);
  return { ...created } as KeptEntry<T>;
}

/**
 * The editor holding `session` is at its address again without having been removed (revision 24, R36): the visit going on there owns that
 * session from now on. Only that exact session, and only while an editor holds it (a session no editor holds is its own visit's).
 */
export function adoptKept(
  key: string,
  session: number,
  owner: TaskVisit,
): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session || held.holders === 0)
    return;
  held.owner = owner;
}

/** The editor unmounts: once nothing holds the session, it stays only while its visit keeps it (see above). */
export function releaseKept(key: string, session: number): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  held.holders = Math.max(0, held.holders - 1);
  dropUnheld(key, held);
}

/** Drops a session after the current turn if by then no editor holds it and its visit does not keep it. */
function dropUnheld(key: string, held: Held): void {
  if (held.holders > 0 || retained(held)) return;
  setTimeout(() => {
    if (entries.get(key) === held && held.holders === 0 && !retained(held))
      entries.delete(key);
  }, 0);
}

/**
 * The visit lets go of `key` without ending (revision 22): the task detail showing another day in place lets go of the day it showed,
 * as a departure would. The session is dropped once no editor holds it.
 */
export function disownKept(key: string): void {
  const held = entries.get(key);
  if (held === undefined) return;
  held.owner = null;
  dropUnheld(key, held);
}

export function editKept<T>(key: string, session: number, value: T): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  held.value = value;
  held.revision += 1;
}

/** A save begins: the ticket names exactly the session and revision submitted. */
export function submitKept(key: string, session: number): KeptTicket | null {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return null;
  held.submitting = held.revision;
  return { key, session, revision: held.revision };
}

/**
 * A save ended. Success consumes the session only if it is still the submitted one at the submitted revision (`consumed`, with `detail`
 * for its editor); otherwise the newer input stays with `note` (`kept`); a session that no longer exists is left alone (`gone`).
 */
export function completeKept(
  ticket: KeptTicket,
  saved: boolean,
  outcome: { note?: string | null; detail?: string | null } = {},
): "consumed" | "kept" | "gone" {
  const held = entries.get(ticket.key);
  if (held === undefined || held.session !== ticket.session) return "gone";
  if (saved && held.revision === ticket.revision) {
    entries.delete(ticket.key);
    publish(ticket.key, {
      kind: "consumed",
      session: ticket.session,
      value: held.value,
      detail: outcome.detail ?? null,
    });
    return "consumed";
  }
  held.submitting = null;
  held.note = outcome.note ?? null;
  publish(ticket.key, { kind: "settled", session: ticket.session });
  return "kept";
}

function publish(key: string, event: KeptEvent): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener(event);
}

export function subscribeKept(
  key: string,
  listener: (event: KeptEvent) => void,
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

/** For tests: end the visit going on and forget every session (numbers are still never reused). */
export function forgetKept(): void {
  forgetTaskVisits();
  entries.clear();
}

/** What an editor holds of its session: the input shown, whether a save of it is pending, and the note a settled save left. */
export interface KeptInput<T> {
  value: T;
  busy: boolean;
  note: string | null;
  /** An edit by the person: moves the session's revision. */
  edit(change: (value: T) => T): void;
  setNote(note: string | null): void;
  /** A save begins (null: this editor holds no session, nothing to save from). */
  submit(): KeptTicket | null;
}

/**
 * The editor side of a session: mounting opens (or resumes) the session of `key` on the visit of the screen it is on, unmounting releases
 * it (kept while that visit goes on and it holds input). `consumed` is told when a save consumed this session: it returns the value of a
 * fresh session to continue with, or null to hold none (the editor is leaving); it is told only while the editor presents (the person is
 * at its screen now), else the editor holds none. `unedited`: the visit keeps the session even before it is edited.
 */
export function useKeptInput<T>(
  key: string,
  identity: string,
  initial: () => T,
  options: {
    consumed(value: T, detail: string | null): T | null;
    unedited?: boolean;
  },
): KeptInput<T> {
  const visitOf = useTaskVisit();
  const attachTo = useTaskAttachment();
  const shownAt = useTaskScreenAt();
  const onRouteMoved = useTaskRouteMoved();
  const attachment = useRef<TaskAttachment | null>(null);
  // The attachment that may act on the pending save's consumption: the one the editor had when it took (or resumed) that save (R36).
  const acting = useRef<TaskAttachment | null>(null);
  // Leaving the screen revokes the attachment as React removes the editor, before any passive cleanup (R35).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor opened for this key and identity leaves the screen
  useLayoutEffect(
    () => () => {
      attachment.current?.detach();
      attachment.current = null;
    },
    [key, identity],
  );
  const peek = (): {
    key: string;
    value: T;
    busy: boolean;
    note: string | null;
  } => {
    const entry = keptEntry<T>(key);
    return {
      key,
      value: entry === null ? initial() : entry.value,
      busy: entry !== null && entry.submitting !== null,
      note: entry?.note ?? null,
    };
  };
  const [shown, setShown] = useState(peek);
  const session = useRef<number | null>(null);
  const latest = useRef({ initial, options });
  latest.current = { initial, options };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the visit is asked for when the editor opens (the key and identity are the reason)
  useEffect(() => {
    let owner = visitOf(identity);
    let here = attachTo(owner);
    attachment.current = here;
    // Its session consumed while it did not present, and the editor still mounted (R35 follow-up, revision 23).
    let orphaned = false;
    const open = (make: () => T) => {
      const entry = openKept(
        key,
        identity,
        make,
        owner,
        latest.current.options.unedited === true,
      );
      session.current = entry.session;
      acting.current = here;
      setShown({
        key,
        value: entry.value,
        busy: entry.submitting !== null,
        note: entry.note,
      });
    };
    open(() => latest.current.initial());
    // The person is at the editor's address again and it was never removed: attached anew on the visit going on there (which owns the
    // session it holds from now on); an orphaned editor starts afresh there.
    const revive = () => {
      if (owner === null || attachment.current !== here) return;
      if (here === null || !here.presents()) {
        if (!shownAt(owner.address)) return;
        const next = visitOf(identity);
        const again = attachTo(next);
        if (next === null || again === null || !again.presents()) {
          again?.detach();
          return;
        }
        here?.detach();
        here = again;
        attachment.current = again;
        if (next !== owner && session.current !== null)
          adoptKept(key, session.current, next);
        owner = next;
      }
      if (orphaned) {
        orphaned = false;
        open(() => latest.current.initial());
      }
    };
    const unheard = onRouteMoved(revive);
    const stop = subscribeKept(key, (event) => {
      if (event.session !== session.current) return;
      if (event.kind === "settled") {
        const entry = keptEntry<T>(key);
        setShown((s) => ({ ...s, busy: false, note: entry?.note ?? null }));
        return;
      }
      session.current = null;
      // Asked now, immediately before acting: an editor the person has left since it took this save is told nothing to act on (R35).
      const by = acting.current;
      if (by !== null && !by.presents()) {
        orphaned = true;
        setShown((s) => ({ ...s, busy: false }));
        revive();
        return;
      }
      const next = latest.current.options.consumed(
        event.value as T,
        event.detail,
      );
      if (next !== null) open(() => next);
      else setShown((s) => ({ ...s, busy: false }));
    });
    return () => {
      here?.detach();
      unheard();
      stop();
      if (session.current !== null) releaseKept(key, session.current);
      session.current = null;
    };
  }, [key, identity]);
  const now = shown.key === key ? shown : peek();
  return {
    ...now,
    edit(change) {
      const entry = keptEntry<T>(key);
      const mine = session.current;
      const next = change(
        entry !== null && entry.session === mine ? entry.value : now.value,
      );
      if (mine !== null) editKept(key, mine, next);
      setShown((s) => ({ ...s, key, value: next }));
    },
    setNote(note) {
      setShown((s) => ({ ...s, note }));
    },
    submit() {
      const ticket =
        session.current === null ? null : submitKept(key, session.current);
      if (ticket !== null) {
        acting.current = attachment.current;
        setShown((s) => ({ ...s, busy: true }));
      }
      return ticket;
    },
  };
}

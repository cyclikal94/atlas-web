import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

/**
 * Unsaved input of a task screen kept through a visit to the sync screens (revision 18, R33; WEB-02 ia.md §1.3.3, task states I1).
 *
 * Checking sync state is a deliberate navigation away, not a discard: the shell's sync control (or any other way to `/sync`) unmounts the
 * screen, and coming back (Back, or the queue's own close control) shows the same input, raw as typed (invalid and conditionally hidden
 * values included), never a blank or reset form, and never submits anything. Page memory only, never stored: a reload forgets it.
 *
 * Every entry is an editing SESSION of one editor (a task form, a progress amount, ...) of ONE displayed identity (`account:epoch`), keyed
 * by both, and given back only to that identity and that editor. Opening an editor for an identity forgets every other identity's
 * entries. A session is held by the editor mounted for it; when that editor unmounts the session is KEPT only if the router has moved to
 * the sync screens and the session holds something of the person's (an edit, a pending save, or a stage they chose), otherwise it is
 * dropped after the current turn (so React's development remount of the same editor resumes it). Cancel, Escape and the close icon leave
 * for somewhere else, so they discard it; leaving for anywhere but the sync screens does, after the person came back from them too. The
 * task detail's visit also holds the sessions of the day it shows (`holdKept`, revision 20): an editor the data hides (its day gone from
 * this device) is not a departure, and its session waits for the day to come back. Holding adopts a session kept through a sync visit,
 * so the visit's own end decides for it even if its editor never mounts again (revision 21, DA21-I2; `keepVisit`/`resumeVisit` carry the
 * days the visit owns between its mounts).
 *
 * A save takes a ticket naming the session and the revision it submitted. Its completion, whichever mount made it and whether or not any
 * editor is mounted then, consumes the session only if it is still that session at that revision; newer input stays (with the note the
 * save left), and the session's CURRENT editor, if one is mounted, is told either way. Session numbers are never reused.
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
  kept: boolean;
}

const entries = new Map<string, Held>();
const listeners = new Map<string, Set<(event: KeptEvent) => void>>();
let sessions = 0;
/** Keys held by an open visit of the screen showing their editor's day (`holdKept`), by count. */
const visits = new Map<string, number>();

export const keptKey = (identity: string, editor: string) =>
  `${identity}\u0000${editor}`;

/** The sync screens' address (the shell's sync control navigates there, queue or conflicts alike). */
export const atSync = (pathname: string): boolean =>
  pathname.replace(/\/+$/, "") === "/sync";

/**
 * Where the router is now: read when a screen unmounts, after the navigation that unmounts it (the router's latest location moves before
 * the screens it shows). A component shown outside any router (a test) is nowhere ("").
 */
export function useLatestPath(): () => string {
  const router = useRouter({ warn: false }) as ReturnType<
    typeof useRouter
  > | null;
  return () => router?.latestLocation.pathname ?? "";
}

/** Whether the router is at the sync screens now (see `useLatestPath`). */
export function useLeftForSync(): () => boolean {
  const path = useLatestPath();
  return () => atSync(path());
}

/** The session an editor opening `key` now would resume, or null. */
export function keptEntry<T>(key: string): KeptEntry<T> | null {
  return (entries.get(key) as KeptEntry<T> | undefined) ?? null;
}

/** An editor for `key` mounts: it resumes the session there (kept, or held by a remount of the same editor), else starts one. */
export function openKept<T>(
  key: string,
  identity: string,
  initial: () => T,
): KeptEntry<T> {
  for (const other of [...entries.keys()])
    if (!other.startsWith(`${identity}\u0000`)) entries.delete(other);
  const held = entries.get(key);
  if (held !== undefined) {
    held.holders += 1;
    held.kept = false;
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
    kept: false,
  };
  entries.set(key, created);
  return { ...created } as KeptEntry<T>;
}

/**
 * The editor unmounts. `toSync`: the router is at the sync screens now. The session is kept for the next editor of `key` if it went to
 * the sync screens holding input (`unedited`: an unedited session counts, e.g. a creation stage the person chose); otherwise, once nothing
 * holds it, it is dropped after the current turn.
 */
export function releaseKept(
  key: string,
  session: number,
  toSync: boolean,
  unedited = false,
): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  held.holders = Math.max(0, held.holders - 1);
  if (toSync && (unedited || held.revision > 0 || held.submitting !== null)) {
    held.kept = true;
    return;
  }
  dropUnheld(key, held);
}

/** Drops a session after the current turn if by then no editor, sync visit or screen visit holds it. */
function dropUnheld(key: string, held: Held): void {
  if (held.holders > 0 || held.kept || visits.has(key)) return;
  setTimeout(() => {
    if (
      entries.get(key) === held &&
      held.holders === 0 &&
      !held.kept &&
      !visits.has(key)
    )
      entries.delete(key);
  }, 0);
}

/**
 * The visit of the screen showing the day an editor is for holds that editor's key (revision 20, DA20-I1): while it does, an editor that
 * unmounts because the data hid it (its day left this device and is shown unavailable) keeps its session, input and pending save, and the
 * next editor of the key resumes it. Holding ADOPTS a session kept through a sync visit (revision 21, DA21-I2): the visit owns it from then
 * on, whether or not an editor of it ever mounts again. The visit lets go when it ends or parks the day; `keep` (it went to the sync screens,
 * or keeps the day parked) keeps a session holding input (or the one it adopted) for the key's next editor, as a sync visit does;
 * otherwise the session is dropped once nothing holds it, as any departure drops it.
 */
export function holdKept(key: string): (keep: boolean) => void {
  visits.set(key, (visits.get(key) ?? 0) + 1);
  const found = entries.get(key);
  const adopted = found?.kept === true ? found.session : null;
  if (found !== undefined) found.kept = false;
  let holding = true;
  return (keep) => {
    if (!holding) return;
    holding = false;
    const left = (visits.get(key) ?? 1) - 1;
    if (left > 0) visits.set(key, left);
    else visits.delete(key);
    const held = entries.get(key);
    if (held === undefined) return;
    if (
      keep &&
      (held.revision > 0 ||
        held.submitting !== null ||
        held.session === adopted)
    ) {
      held.kept = true;
      return;
    }
    dropUnheld(key, held);
  };
}

/**
 * The days a screen's logical visit owns between its mounts (revision 21, DA21-I2): what it held when it went to the sync screens, and the
 * days it parked when it was remounted at its own address. The next mount of the same screen and identity takes them (`resumeVisit`) and
 * holds them, so ending THAT visit ends their input too. Page memory only; another identity's are forgotten.
 */
const visitDays = new Map<string, ReadonlyArray<readonly [string, string]>>();

export function keepVisit(
  key: string,
  days: ReadonlyArray<readonly [string, string]>,
): void {
  if (days.length > 0) visitDays.set(key, days);
  else visitDays.delete(key);
}

export function resumeVisit(
  key: string,
  identity: string,
): ReadonlyArray<readonly [string, string]> {
  for (const other of [...visitDays.keys()])
    if (!other.startsWith(`${identity}\u0000`)) visitDays.delete(other);
  const days = visitDays.get(key) ?? [];
  visitDays.delete(key);
  return days;
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

/** For tests: forget every session (numbers are still never reused). */
export function forgetKept(): void {
  entries.clear();
  visits.clear();
  visitDays.clear();
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
 * The editor side of a session: mounting opens (or resumes) the session of `key`, unmounting releases it (kept when the router is at the
 * sync screens). `consumed` is told when a save consumed this session: it returns the value of a fresh session to continue with, or null
 * to hold none (the editor is leaving). `unedited`: keep the session through a sync visit even before it is edited.
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
  const leftForSync = useLeftForSync();
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
  const latest = useRef({ initial, options, leftForSync });
  latest.current = { initial, options, leftForSync };
  useEffect(() => {
    const open = (make: () => T) => {
      const entry = openKept(key, identity, make);
      session.current = entry.session;
      setShown({
        key,
        value: entry.value,
        busy: entry.submitting !== null,
        note: entry.note,
      });
    };
    open(() => latest.current.initial());
    const stop = subscribeKept(key, (event) => {
      if (event.session !== session.current) return;
      if (event.kind === "settled") {
        const entry = keptEntry<T>(key);
        setShown((s) => ({ ...s, busy: false, note: entry?.note ?? null }));
        return;
      }
      session.current = null;
      const next = latest.current.options.consumed(
        event.value as T,
        event.detail,
      );
      if (next !== null) open(() => next);
      else setShown((s) => ({ ...s, busy: false }));
    });
    return () => {
      stop();
      if (session.current !== null)
        releaseKept(
          key,
          session.current,
          latest.current.leftForSync(),
          latest.current.options.unedited,
        );
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
      if (ticket !== null) setShown((s) => ({ ...s, busy: true }));
      return ticket;
    },
  };
}

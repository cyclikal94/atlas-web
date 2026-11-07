import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFormRecoveryPort } from "../../data";
import {
  createRecoverableModel,
  type ModelTicket,
  type ModelView,
  type RecoverableModel,
  type RecoveryControls,
} from "../../lib/form-recovery/model";
import type { DiscardResult } from "../../lib/form-recovery/port";
import { pageFormRegistry } from "../../lib/form-recovery/registry";
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
 * A save takes a ticket naming the session, the revision it submitted and its FLIGHT: a session has at most one save pending (a second
 * submit while one is pending is refused), and only that flight's completion settles it. Its completion, whichever mount made it and
 * whether or not any editor is mounted then, consumes the session only if it is still that session at that revision; newer input stays
 * (with the note the save left), and the session's CURRENT editor, if one is mounted, is told either way. Session and flight numbers are
 * never reused.
 *
 * Settling a save that keeps the session is ONE transition of the kept entry (WEB-10b revision 2, R1 / DA-P1): what the save leaves in
 * the session (`change`: an attempt's id retired or bound, say), evaluated once, the note and the end of the flight, all before any editor
 * is told. The entry is the only authority: every editor holding the session then shows the entry as it is (its value, note and busy
 * state), the one mounted now whether or not it is the one that took the save (it may have been removed for the sync screens and
 * mounted again on Back). What a save leaves is not an edit by the person: it does not move the revision.
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
/**
 * APP-UPDATE RECOVERY (WEB-14a revision 37; review of 25 October 2026, R40; design assessment C1-C3). Page memory is forgotten by a reload,
 * so an editor that declares a recovery codec (`KeptRecovery`: a form context for its target and an explicitly versioned, non-secret text
 * of its raw input) also has a RECOVERABLE MODEL (`lib/form-recovery/model.ts`) for its key: the session of the page's form registry that
 * the app-update coordinator saves, hands off and seals through. This owner stays the one authority for the input: every edit, the stage
 * an opening is, a submission's ticket and its completion, a departure that drops the input and a restore reach the model in the same step
 * (`editKept`, `openKept`, `submitKept`, `completeKept`, the visit's end). While an update reload is prepared an edit or a save is refused
 * (the editor keeps what it shows; nothing is typed after the last save). After the reload the editor's look restores the copy left to it
 * into its session (`restoreKept`; never submitted), only while that session is untouched; a screen that shows no editor yet (the new
 * task's preset picker) restores it as the stage the person had reached (`useKeptRecovery`).
 *
 * Revision 38 (review of revision 37, R40-B; design assessment C3, C5): a copy the PERSON chooses (the notice's other copies) replaces the
 * session's input whatever was typed or restored before (the model has already checked that nothing changed it since the choice), unless a
 * save of the session is pending; never submitted. What a settled save leaves in the session (`completeKept`'s `change`) reaches the
 * model in the same transition when it changes the recoverable input (a partial save's remaining selection), never as the person's edit.
 */
export interface KeptRecovery<T> {
  /** Where the copies are kept: the editor and its target (never a session number). The account is the store's. */
  readonly context: string;
  /** The input as one text (versioned; never a secret). */
  encode(value: T): string;
  /**
   * The text of a copy back into input; null when it is not one this build can read (offered, never restored in part). `start`: what the
   * editor would start from now (revision 38: what the codec does not keep, such as a new save's fresh ids, comes from it, never the copy).
   */
  decode(text: string, start: T): T | null;
}

interface Linked {
  readonly identity: string;
  readonly model: RecoverableModel;
  readonly recovery: KeptRecovery<unknown>;
  /** The visit an entry restored with no editor holding it belongs to (the screen that restores it). */
  owner: () => TaskVisit | null;
  /** What the editor starts from now (the latest caller's). */
  start: () => unknown;
  /** Opening the editor is itself input (the new task's stage). */
  opened: boolean;
}

const noSubscription = () => () => undefined;
const NO_VIEW: ModelView = {
  restored: null,
  alternatives: [],
  unavailable: false,
  ready: true,
};
const noView = () => NO_VIEW;

/** The recoverable model of each key whose editor declared a codec (per identity: another identity retires it). */
const models = new Map<string, Linked>();

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
  /** Revision 37 (R40): the recoverable model's ticket for what this save sent (its success covers exactly that). */
  readonly recovery?: ModelTicket;
  /** The pending save this ticket is (only it settles the session). */
  readonly flight: number;
}

export type KeptEvent =
  | { kind: "consumed"; session: number; value: unknown; detail: string | null }
  | { kind: "settled"; session: number }
  /** Revision 37 (R40): a copy left by the page before an update was restored into the session (or the session reset after a discard). */
  | { kind: "restored"; session: number };

interface Held {
  session: number;
  revision: number;
  value: unknown;
  submitting: number | null;
  /** The pending save's flight, or null. */
  flight: number | null;
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
let flights = 0;

/** Holding something of the person's: an edit, a pending save, or a session kept before it is edited. */
const holdsInput = (held: Held) =>
  held.revision > 0 || held.submitting !== null || held.unedited;
/** Kept with no editor holding it: its visit goes on and it holds input. */
const retained = (held: Held) =>
  held.owner !== null && !held.owner.ended() && holdsInput(held);

// A visit that ends drops every session it owns that no editor holds (one still held is dropped when its editor lets go).
onTaskVisitEnded((visit) => {
  for (const [key, held] of [...entries])
    if (held.owner === visit && held.holders === 0) drop(key);
});

/** The session of `key` is dropped (a departure, nothing of the person's): its recovery copies go with it (R40: never revived later). */
function drop(key: string): void {
  if (!entries.delete(key)) return;
  void models.get(key)?.model.end();
}

/** Revision 37 (R40): another identity's editor opened: this one's models leave the page's registry (their copies stay in their store). */
function retireOtherIdentities(identity: string): void {
  for (const [key, linked] of [...models])
    if (linked.identity !== identity) {
      linked.model.retire();
      models.delete(key);
    }
}

/**
 * Revision 37 (R40): the recoverable model of `key` for `identity`, made once (its codec and its first start are the first caller's).
 * `owner` names the visit an entry it restores while no editor holds the key belongs to.
 */
export function linkKept<T>(
  key: string,
  identity: string,
  recovery: KeptRecovery<T>,
  start: () => T,
  options: { owner?: () => TaskVisit | null; opened?: boolean } = {},
): RecoverableModel {
  retireOtherIdentities(identity);
  const known = models.get(key);
  if (known !== undefined) {
    if (options.owner) known.owner = options.owner;
    known.start = start;
    return known.model;
  }
  const entry = entries.get(key);
  const opened = options.opened === true;
  const linked: Linked = {
    identity,
    recovery: recovery as KeptRecovery<unknown>,
    owner: options.owner ?? (() => null),
    start,
    opened,
    model: createRecoverableModel({
      formContext: recovery.context,
      start: opened ? "" : recovery.encode(start()),
      restore: (text, chosen) => restoreKept(key, text, chosen),
      untouched: () => {
        const held = entries.get(key);
        return (
          held === undefined ||
          (held.revision === 0 && held.submitting === null)
        );
      },
    }),
  };
  models.set(key, linked);
  // An editor already holding a session of this key (linked late): the model starts from what it holds.
  if (entry !== undefined) {
    linked.model.begin(recovery.encode(start()), opened);
    if (entry.revision > 0)
      linked.model.edit(recovery.encode(entry.value as T));
  }
  return linked.model;
}

/**
 * Revision 37 (R40): a copy's text restored into `key`'s session (the model's look, or the person's choice of another copy). The look's
 * automatic restore only while the session is untouched (nothing typed, chosen or submitted since it opened), or with no session yet (a
 * screen restoring the stage the person had reached: a session of the restoring screen's visit, held by no editor until one opens it).
 * Revision 38 (R40-B): the person's choice (`chosen`) replaces the session's input, typed or restored, unless a save of it is pending.
 * Never submits.
 */
function restoreKept(key: string, text: string, chosen: boolean): boolean {
  const linked = models.get(key);
  if (linked === undefined) return false;
  const value = linked.recovery.decode(text, linked.start());
  if (value === null) return false;
  const held = entries.get(key);
  if (held === undefined) {
    const owner = linked.owner();
    if (owner === null || owner.ended()) return false;
    sessions += 1;
    entries.set(key, {
      session: sessions,
      revision: 1,
      value,
      submitting: null,
      flight: null,
      note: null,
      holders: 0,
      owner,
      unedited: linked.opened,
    });
    return true;
  }
  if (held.submitting !== null || (!chosen && held.revision !== 0))
    return false;
  held.value = value;
  held.revision += 1;
  publish(key, { kind: "restored", session: held.session });
  return true;
}

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
  retireOtherIdentities(identity);
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
    flight: null,
    note: null,
    holders: 1,
    owner,
    unedited,
  };
  entries.set(key, created);
  // Revision 37 (R40): a new session of a recoverable editor starts its model afresh (the stage, when opening it is input).
  const linked = models.get(key);
  if (linked !== undefined)
    linked.model.begin(linked.recovery.encode(created.value), unedited);
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
      drop(key);
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

/** Revision 37 (R40): "Discard instead": the session shows `value` again (no edit; the model has discarded its copies). */
function resetKept<T>(key: string, session: number, value: T): void {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return;
  held.value = value;
  publish(key, { kind: "restored", session });
}

/**
 * An edit of the session. Revision 37 (R40): false, and nothing changes, while an update reload is being prepared (its model refuses it:
 * nothing may be typed after the last save).
 */
export function editKept<T>(key: string, session: number, value: T): boolean {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return true;
  const linked = models.get(key);
  if (linked !== undefined && !linked.model.edit(linked.recovery.encode(value)))
    return false;
  held.value = value;
  held.revision += 1;
  return true;
}

/** A save begins: the ticket names exactly the session, revision and flight submitted (null: another save of it is still pending). */
export function submitKept(key: string, session: number): KeptTicket | null {
  const held = entries.get(key);
  if (held === undefined || held.session !== session) return null;
  if (held.flight !== null) return null;
  // Revision 37 (R40): its model's ticket, taken in the same step (none while an update reload is prepared: nothing is sent then).
  const linked = models.get(key);
  const recovery = linked?.model.submitting();
  if (recovery === null) return null;
  flights += 1;
  held.submitting = held.revision;
  held.flight = flights;
  return {
    key,
    session,
    revision: held.revision,
    flight: flights,
    ...(recovery ? { recovery } : {}),
  };
}

/**
 * A save ended. Success consumes the session only if it is still the submitted one at the submitted revision (`consumed`, with `detail`
 * for its editor); otherwise the session stays (`kept`) as `change` leaves it, with `note`, in one transition told to its editors once
 * (see above); a session that no longer exists, or a ticket that is not its pending save, is left alone (`gone`).
 */
export function completeKept<T>(
  ticket: KeptTicket,
  saved: boolean,
  outcome: {
    note?: string | null;
    detail?: string | null;
    change?: (value: T) => T;
  } = {},
): "consumed" | "kept" | "gone" {
  // Revision 37 (R40): the model acknowledges exactly what the save sent (newer input stays its own, dirty until saved); a failure covers nothing.
  if (saved) void ticket.recovery?.succeeded();
  else ticket.recovery?.failed();
  const held = entries.get(ticket.key);
  if (held === undefined || held.session !== ticket.session) return "gone";
  if (held.flight !== ticket.flight) return "gone";
  held.flight = null;
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
  const before = held.value;
  if (outcome.change !== undefined)
    held.value = outcome.change(held.value as T);
  held.submitting = null;
  held.note = outcome.note ?? null;
  publish(ticket.key, { kind: "settled", session: ticket.session });
  settleRecovery(ticket.key, before, held.value);
  return "kept";
}

/**
 * Revision 38 (design assessment C5): what a settled save left in the session reaches its recoverable model in the same synchronous
 * transition, only when it changes the recoverable input (a partial add's remaining selection; new ids or an attempt are not input), and
 * never as the person's edit (`RecoverableModel.settle`, taken even while an update reload is prepared: the update waits for this save).
 */
function settleRecovery(key: string, before: unknown, after: unknown): void {
  const linked = models.get(key);
  if (linked === undefined || after === before) return;
  const text = linked.recovery.encode(after);
  if (text !== linked.recovery.encode(before)) linked.model.settle(text);
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
  for (const linked of models.values()) linked.model.retire();
  models.clear();
}

/** What an editor holds of its session: the input shown, whether a save of it is pending, and the note a settled save left. */
/** Revision 37 (R40): what a recoverable editor shows of its recovery (`RecoveryNotice`), and its actions. */
export type KeptRecoveryState = RecoveryControls;

export interface KeptInput<T> {
  value: T;
  busy: boolean;
  note: string | null;
  /** Revision 37 (R40): null for an editor without a recovery codec. */
  recovery: KeptRecoveryState | null;
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
    /** Revision 37 (R40): the editor's input is recoverable around an app-update reload (Q4). */
    recover?: KeptRecovery<T>;
    /** Revision 37 (R40): the editor shows a native editing state its value cannot hold (`RecoverableModel.probe`). */
    unfinished?: () => boolean;
  },
): KeptInput<T> {
  const port = useFormRecoveryPort();
  const recover = options.recover;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per key and identity (its codec is the first caller's)
  const model = useMemo(
    () =>
      recover
        ? linkKept(key, identity, recover, () => latest.current.initial(), {
            opened: options.unedited === true,
          })
        : null,
    [key, identity],
  );
  // Revision 37 (R40): the model is in the page's registry while the editor shows it, and is bound to the account's store once it is open.
  useEffect(() => model?.show(), [model]);
  useEffect(() => {
    if (!model || !latest.current.options.unfinished) return;
    model.probe(() => latest.current.options.unfinished?.() ?? false);
    return () => model.probe(null);
  }, [model]);
  const view = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.view ?? noView,
    model?.view ?? noView,
  );
  const locked = useSyncExternalStore(
    pageFormRegistry.subscribe,
    pageFormRegistry.frozen,
    pageFormRegistry.frozen,
  );
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
      if (event.kind === "restored") {
        const entry = keptEntry<T>(key);
        if (entry !== null)
          setShown((s) => ({ ...s, key, value: entry.value }));
        return;
      }
      if (event.kind === "settled") {
        // The settled session as the entry now holds it (R1, revision 2): this editor may not be the one that took the save.
        const entry = keptEntry<T>(key);
        setShown((s) =>
          entry === null
            ? { ...s, busy: false, note: null }
            : { key, value: entry.value, busy: false, note: entry.note },
        );
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
  // Bound AFTER the session opened (R40): the look must find the session's start, not see it as input typed while it read.
  useEffect(() => {
    model?.bind(port);
  }, [model, port]);
  const now = shown.key === key ? shown : peek();
  const recovery: KeptRecoveryState | null =
    model === null || recover === undefined
      ? null
      : {
          view,
          locked,
          discard() {
            // Admitted at the gesture or not at all (revision 38, R40-A): the session and the model show the start in this same step.
            if (!model.accepting())
              return Promise.resolve<DiscardResult>("failed");
            const mine = session.current;
            const fresh = latest.current.initial();
            const result = model.discard(
              options.unedited ? "" : recover.encode(fresh),
            );
            if (mine !== null) {
              resetKept(key, mine, fresh);
              setShown((s) => ({ ...s, key, value: fresh }));
            }
            return result;
          },
          retry: () => model.retry(),
          checkAgain: model.checkAgain,
          restoreAlternative: (copy) =>
            model.restoreAlternative(copy.tabInstanceId),
          discardAlternative: (copy) =>
            model.discardAlternative(copy.tabInstanceId),
        };
  return {
    ...now,
    recovery,
    edit(change) {
      const entry = keptEntry<T>(key);
      const mine = session.current;
      const next = change(
        entry !== null && entry.session === mine ? entry.value : now.value,
      );
      // Refused while an update reload is prepared (R40): what the editor shows stays what was saved.
      if (mine !== null && !editKept(key, mine, next)) return;
      if (mine === null && model?.frozen()) return;
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

/**
 * Revision 37 (R40; design assessment C1): a SCREEN that shows no editor of `key` yet looks for what the page before an update left to it.
 * The new task's form opens only once a stage is chosen, so a look inside the form would never run while its picker is shown: the screen
 * makes it instead, and a copy restored (only while nothing of `key` is held) becomes a session of this screen's visit, which the form then
 * resumes at the stage the person had reached. `opened`: opening the editor is itself input. Returns the model's view.
 */
export function useKeptRecovery<T>(
  key: string,
  identity: string,
  recover: KeptRecovery<T>,
  start: () => T,
  opened: boolean,
): ModelView {
  const port = useFormRecoveryPort();
  const visitOf = useTaskVisit();
  const latest = useRef({ start, visitOf });
  latest.current = { start, visitOf };
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per key and identity (its codec is the first caller's)
  const model = useMemo(
    () =>
      linkKept(key, identity, recover, () => latest.current.start(), {
        owner: () => latest.current.visitOf(identity),
        opened,
      }),
    [key, identity],
  );
  // Bound, not shown: a screen that only looks is no editor (an editor that opens on what it restores shows the model).
  useEffect(() => {
    model.bind(port);
  }, [model, port]);
  return useSyncExternalStore(model.subscribe, model.view, model.view);
}

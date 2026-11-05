import { useCallback, useLayoutEffect, useRef } from "react";
import { isCurrentMemory, type PeopleMemory } from "./memory";

/**
 * Which form a save's completion may end (review 6, finding 1). A save is made by ONE editing SESSION: the input typed in a form, kept
 * under its draft key in page memory with the session's id, and shown by whichever mount of the form is open now (a remount of the
 * protected tree, or going away and coming back, restores the same session; Cancel, Escape and the close icon end it, and the next
 * "Add a field" or "New person" begins another). When the save completes, only THAT session ends: its kept input is forgotten and its
 * open form closes, and only if nothing was typed after the revision that was saved (otherwise the later input stays and the form says
 * so). A completion whose session ended or was replaced touches nothing: another session's kept input, dialog and route are never its
 * to close. What the save did is still told (the caller announces it before asking); an admitted save is never undone here.
 */
export interface EditingSession<Update = unknown> {
  /** The input's revision now. */
  revision(): number;
  /**
   * The session's save completed for its current input: the form closes (its route, dialog or inline form), onto `saved` when the save
   * made something to show (a new person).
   */
  close(saved: string | null): void;
  /** The session's save completed for an earlier revision: the later input stays, and the form says so. */
  keep(): void;
  /**
   * What the session's save says to the form showing the session now (a refusal, a re-binding it confirmed): the form that submitted
   * may have been remounted since (review 7, finding 1), so the save never tells only the instance that started it.
   */
  report(update: Update): void;
}

/**
 * Registers the mounted form of `session` while it is mounted (the latest mount of the session wins; a mount withdraws only itself), and
 * gives it what the session's save said while no form of it was mounted. Answers whether this mount is the session's form now: a handler
 * of a form that is not (an old one's, still reachable) has no say over the session (it neither keeps input for it nor saves it).
 */
export function useEditingSession<Update>(
  memory: PeopleMemory,
  session: string,
  view: EditingSession<Update>,
): () => boolean {
  const current = useRef(view);
  current.current = view;
  const mine = useRef<EditingSession | null>(null);
  useLayoutEffect(() => {
    const owner: EditingSession = {
      revision: () => current.current.revision(),
      close: (saved) => current.current.close(saved),
      keep: () => current.current.keep(),
      report: (update) => current.current.report(update as Update),
    };
    memory.sessions.set(session, owner);
    mine.current = owner;
    const waiting = memory.reports.get(session);
    if (waiting !== undefined) {
      memory.reports.delete(session);
      owner.report(waiting);
    }
    return () => {
      if (mine.current === owner) mine.current = null;
      if (memory.sessions.get(session) === owner)
        memory.sessions.delete(session);
    };
  }, [memory, session]);
  return useCallback(
    () =>
      isCurrentMemory(memory) &&
      mine.current !== null &&
      memory.sessions.get(session) === mine.current,
    [memory, session],
  );
}

/**
 * Whether this VIEW is still the one shown (review 9, finding 1): a handler of a view that was replaced (another field's route, the reads
 * read again) and is still reachable ends nothing and navigates nowhere; only the view shown now acts for its target.
 */
export function useShown(): () => boolean {
  const shown = useRef(false);
  useLayoutEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  return useCallback(() => shown.current, []);
}

/** The session a kept draft belongs to (undefined: none, or not a session's). */
export function sessionOf(kept: unknown): string | undefined {
  if (typeof kept !== "object" || kept === null) return undefined;
  const session = (kept as { session?: unknown }).session;
  return typeof session === "string" ? session : undefined;
}

/**
 * The person ENDED `session` (Cancel, Escape, the close icon, the overlay; review 8, finding 1): its kept input under `key`, what its last
 * save said and the request it was prepared as are forgotten, and its mounted form no longer owns it (a handler or effect of that form
 * still reachable has no say). Only that session: another session kept under the same key (a later "Add a field") is never touched, so a
 * caller names the session it SHOWS, never whichever one the key holds when it runs. Works whether or not a form of the session could be
 * drawn (an editor whose reads failed shows none). A save already admitted is not undone: it settles its own claim, and its completion
 * finds nothing to close (`completeSession` answers `gone`).
 */
export function retireSession(
  memory: PeopleMemory,
  key: string,
  session: string,
): void {
  if (sessionOf(memory.drafts.get(key)) === session) memory.drafts.delete(key);
  memory.reports.delete(session);
  memory.prepared.delete(session);
  memory.sessions.delete(session);
}

/**
 * A save of `session` (at input revision `ticket`; null: whatever was typed since, as an archive from the editor) completed, having made
 * `saved` (or null). Ends the session as described above and says what happened: `closed` (its kept input forgotten, its open form, if
 * any, closed), `kept` (later input stays), or `gone` (the session had already ended or been replaced, or the identity changed: nothing
 * was touched).
 */
export function completeSession(
  memory: PeopleMemory,
  key: string,
  session: string,
  ticket: number | null,
  revisionOf: (kept: unknown) => number,
  saved: string | null = null,
): "closed" | "kept" | "gone" {
  if (!isCurrentMemory(memory)) return "gone";
  // The request this save was prepared as is spent: a later save of the session is prepared from its own input.
  memory.prepared.delete(session);
  const owner = memory.sessions.get(session);
  const kept = memory.drafts.get(key);
  const keptHere = kept !== undefined && sessionOf(kept) === session;
  if (owner === undefined && !keptHere) return "gone";
  const revision =
    owner !== undefined ? owner.revision() : revisionOf(kept as unknown);
  if (ticket !== null && revision !== ticket) {
    owner?.keep();
    return "kept";
  }
  if (keptHere) memory.drafts.delete(key);
  memory.reports.delete(session);
  owner?.close(saved);
  return "closed";
}

/**
 * What a save of `session` (input kept under `key`) says, told to the form showing the session now, or kept for its next mount while
 * none is mounted (a remount, or the in-dialog sync control). A session that ended or was replaced (Cancel and a new form) is told
 * nothing: the new form's message is its own. Updates kept while no form is mounted are merged, later over earlier.
 */
export function reportSession<Update extends object>(
  memory: PeopleMemory,
  key: string,
  session: string,
  update: Update,
): void {
  if (!isCurrentMemory(memory)) return;
  const owner = memory.sessions.get(session);
  if (owner !== undefined) {
    owner.report(update);
    return;
  }
  if (sessionOf(memory.drafts.get(key)) !== session) return;
  const waiting = memory.reports.get(session) as Update | undefined;
  memory.reports.set(session, { ...waiting, ...update });
  memory.touch();
}

/**
 * ADMISSION (review 7, finding 1). A save is admitted for what it saves: an editing session's id (whichever mount of the session asks),
 * or an action's target (`archive:<id>`, `unlink:<id>`). While it runs, no other save is admitted for any of its keys, so a form that
 * was remounted, kept by the sync control and reopened, or pressed twice, cannot start a second save of the same input. The claim is
 * taken synchronously, before anything is awaited (a component's `saving` state is what it shows, not what excludes), and every mount
 * shows the session as saving while it runs (`isPending`, re-rendered by `useMemoryRevision`). It ends with `settle`, however the save
 * ends; an old save's settlement never ends a later save's claim. Page memory only: another page's saves are excluded by the outbox's
 * own guards (base versions, draft digests, field locks), never by this.
 */
export interface Admission {
  readonly memory: PeopleMemory;
  readonly keys: readonly string[];
  readonly token: string;
}

/** Admits one save for every key at once, or nothing (null): another save of one of them runs, or the identity changed. */
export function admit(
  memory: PeopleMemory,
  keys: readonly string[],
  newId: () => string,
): Admission | null {
  if (!isCurrentMemory(memory)) return null;
  if (keys.some((key) => memory.pending.has(key))) return null;
  const token = newId();
  for (const key of keys) memory.pending.set(key, token);
  memory.touch();
  return { memory, keys, token };
}

/** The admitted save ended: its keys are free again (only those it still holds). */
export function settle(admission: Admission): void {
  const { memory, keys, token } = admission;
  let freed = false;
  for (const key of keys)
    if (memory.pending.get(key) === token) {
      memory.pending.delete(key);
      freed = true;
    }
  if (freed) memory.touch();
}

/** Whether a save admitted for `key` runs now. */
export const isPending = (memory: PeopleMemory, key: string): boolean =>
  memory.pending.has(key);

/**
 * The request a save of `session` is made as, prepared from `basis` (what was typed and chosen, and anything captured with it): the
 * SAME request again while the basis is unchanged, so a retry of a save that may have been written (its completion was lost) carries the
 * same ids and the outbox recognises it (`localId`); a new one, with new ids, for any other input. Spent when the session's save
 * completes (`completeSession`).
 */
export function preparedFor<T>(
  memory: PeopleMemory,
  session: string,
  basis: string,
  prepare: () => T,
): T {
  const known = memory.prepared.get(session);
  if (known !== undefined && known.basis === basis) return known.value as T;
  const value = prepare();
  memory.prepared.set(session, { basis, value });
  return value;
}

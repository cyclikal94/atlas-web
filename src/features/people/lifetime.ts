import { useLayoutEffect, useRef } from "react";
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
export interface EditingSession {
  /** The input's revision now. */
  revision(): number;
  /**
   * The session's save completed for its current input: the form closes (its route, dialog or inline form), onto `saved` when the save
   * made something to show (a new person).
   */
  close(saved: string | null): void;
  /** The session's save completed for an earlier revision: the later input stays, and the form says so. */
  keep(): void;
}

/** Registers the mounted form of `session` while it is mounted (the latest mount of the session wins; a mount withdraws only itself). */
export function useEditingSession(
  memory: PeopleMemory,
  session: string,
  view: EditingSession,
): void {
  const current = useRef(view);
  current.current = view;
  useLayoutEffect(() => {
    const owner: EditingSession = {
      revision: () => current.current.revision(),
      close: (saved) => current.current.close(saved),
      keep: () => current.current.keep(),
    };
    memory.sessions.set(session, owner);
    return () => {
      if (memory.sessions.get(session) === owner)
        memory.sessions.delete(session);
    };
  }, [memory, session]);
}

/** The session a kept draft belongs to (undefined: none, or not a session's). */
export function sessionOf(kept: unknown): string | undefined {
  if (typeof kept !== "object" || kept === null) return undefined;
  const session = (kept as { session?: unknown }).session;
  return typeof session === "string" ? session : undefined;
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
  owner?.close(saved);
  return "closed";
}

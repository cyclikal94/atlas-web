import type { AnchorKept } from "../../calendars/anchors";
import { onTaskVisitEnded, type TaskVisit } from "../visit";

/**
 * The task detail's anchor panel kept by its in-dialog sync control (WEB-13b revision 1; ia.md §1.3.3, task states I1): checking sync
 * state is part of the task's visit, not a discard, so the panel's whole state (and what it was opened for: the change it supersedes and
 * the read it is checked against) is kept for the NEXT panel opened on the task while that visit goes on, at the sync screens included.
 * The visit's end (any ordinary departure, another identity) drops it, opened again or not. Page memory only: never stored, a reload
 * forgets it. One entry per displayed identity and task; taking it (the next panel opening) removes it.
 *
 * A save still being made when the panel was kept settles here (`settleKeptPanel`): when nothing was edited after what it submitted, the
 * kept state is what was saved and is dropped (never offered to be saved twice); newer input stays.
 */
export interface KeptPanel<C> extends AnchorKept {
  owner: TaskVisit;
  /** What the panel was opened for, given back with it. */
  context: C;
}

const kept = new Map<string, KeptPanel<unknown>>();

onTaskVisitEnded((visit) => {
  for (const [key, entry] of [...kept])
    if (entry.owner === visit) kept.delete(key);
});

export const keptPanelKey = (identity: string, taskId: string): string =>
  `${identity}\u0000anchor:${taskId}`;

/** Keeps the panel's state for `key` on `owner`'s visit (forgetting every other identity's entries). Ignored once the visit has ended. */
export function keepPanel<C>(
  key: string,
  owner: TaskVisit,
  value: AnchorKept & { context: C },
): void {
  if (owner.ended()) return;
  const identity = key.slice(0, key.indexOf("\u0000"));
  for (const other of [...kept.keys()])
    if (!other.startsWith(`${identity}\u0000`)) kept.delete(other);
  kept.set(key, { ...value, owner });
}

/** The kept state the next panel for `key` opens with, or null; it is removed (the panel holds it now). Never another visit's. */
export function takeKeptPanel<C>(
  key: string,
  owner: TaskVisit | null,
): KeptPanel<C> | null {
  const entry = kept.get(key);
  if (entry === undefined) return null;
  kept.delete(key);
  if (owner === null || entry.owner !== owner || entry.owner.ended())
    return null;
  return entry as KeptPanel<C>;
}

/**
 * A save the kept panel was still making is done (`revision` is what it submitted): drop what it saved, or keep the newer input with its
 * context as `newer` makes it (the done save is the panel's own: the next one is a new operation, as `AnchorDialog`'s `onKept`).
 */
export function settleKeptPanel<C>(
  key: string,
  revision: number,
  newer: (context: C) => C,
): void {
  const entry = kept.get(key);
  if (entry === undefined || entry.pending !== revision) return;
  if (entry.revision === revision) {
    kept.delete(key);
    return;
  }
  entry.pending = null;
  entry.context = newer(entry.context as C);
}

/** Tests only. */
export function forgetKeptPanels(): void {
  kept.clear();
}

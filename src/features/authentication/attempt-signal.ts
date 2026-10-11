import type { Identity } from "../../session";

/**
 * The controller's half of the `1c.ended` producer (WEB-08c, D-8c-04; the watcher is `attempt-end.ts`). A page that resolves its OWN
 * indeterminate activation can do so before `1c.resolving` is ever published, so an attempt method that answers `gating` says so here
 * with the identity read before the attempt began. Kept apart from the watcher so that the sign-in controller, which the public forms
 * and the shell load eagerly, does not carry it: the watcher is composed by boot through the lazily loaded lifecycle wiring.
 */
type IndeterminateListener = (before: Identity | null) => void;
const listeners = new Set<IndeterminateListener>();

export const attemptEnd = {
  /** This page's own attempt answered `gating`: its activation's outcome is being resolved. */
  indeterminate(before: Identity | null): void {
    for (const listener of [...listeners]) listener(before);
  },
  /** The watcher's subscription; the returned function ends it. */
  listen(listener: IndeterminateListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

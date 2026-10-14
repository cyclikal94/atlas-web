import { useSyncExternalStore } from "react";

/**
 * The app-update state of THIS tab (WEB-14a, D-P4), held where the boot path can read it without loading the coordinator: the neutral
 * root, the API compatibility screen and the shell's banner subscribe here, and the lazily loaded coordinator (`coordinator.ts`) is its
 * only writer. It is deliberately tiny: it is in the initial chunk.
 *
 *  - `none`: nothing to offer.
 *  - `available`: a newer version is installed and waiting; no tab has accepted it.
 *  - `updated_elsewhere`: another tab accepted a newer version, which is now active; this tab still runs the older one.
 *  - `saving`: this tab is saving its unfinished forms before it reloads (Q4).
 *  - `save_failed`: a save failed (`refused`: the account is being signed out); the form stays open (though a session gate may hide or
 *    unmount the shell meanwhile: the neutral root then offers the same choices, revision 12, R19), and the update stays pending.
 *  - `discard_failed`: "Discard and reload anyway" could not discard a saved copy of a form (revision 1, R6): it may come back after a reload,
 *    so nothing reloads until the person retries or chooses to reload anyway (on whichever surface is shown).
 *  - `reloading`: this tab is reloading onto the newer version.
 *  - `data_superseded`: another tab's newer version upgraded this account's local database, which this tab no longer reads or writes.
 *
 * `dismissed` hides the banner of the first two until the next return to the page; it never cancels the update. Nothing here reloads.
 */
export type UpdateState =
  | { kind: "none" }
  | { kind: "available"; dismissed: boolean }
  | { kind: "updated_elsewhere"; dismissed: boolean }
  | { kind: "saving" }
  | { kind: "save_failed"; refused: boolean }
  | { kind: "discard_failed" }
  | { kind: "reloading" }
  | { kind: "data_superseded" };

export interface AppUpdatesActions {
  /** "Reload", "Reload here", "Reload to update": save unfinished forms, let other tabs save theirs, then reload THIS tab only. */
  accept(): void;
  /** "Retry save" after a failed save. */
  retrySave(): void;
  /**
   * "Discard and reload anyway": the unsaved input of this tab is discarded, with the copies saved of it before (other tabs still save
   * theirs); a discard that does not land reloads nothing (`discard_failed`). Also "Try again" after `discard_failed`.
   */
  discardAndReload(): void;
  /** "Reload anyway" after `discard_failed`: reload knowing an earlier copy of the form may be restored. */
  reloadAnyway(): void;
  /** "Not now" / the close button: hidden until the next return to the page. */
  notNow(): void;
}

type Listener = () => void;
const NONE: UpdateState = { kind: "none" };
let state: UpdateState = NONE;
let actions: AppUpdatesActions | null = null;
const listeners = new Set<Listener>();
const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const appUpdates = {
  get: (): UpdateState => state,
  subscribe,
  actions: (): AppUpdatesActions | null => actions,
  /** The coordinator's: publishes this tab's state (and, once, its actions). */
  set(next: UpdateState, nextActions?: AppUpdatesActions): void {
    if (nextActions) actions = nextActions;
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  },
};

/** The current state, for a component. */
export const useAppUpdate = (): UpdateState =>
  useSyncExternalStore(appUpdates.subscribe, appUpdates.get, appUpdates.get);

/** Whether a newer version can be loaded by reloading this tab (the compatibility screen and banner offer it). */
export const updateReady = (current: UpdateState): boolean =>
  current.kind === "available" || current.kind === "updated_elsewhere";

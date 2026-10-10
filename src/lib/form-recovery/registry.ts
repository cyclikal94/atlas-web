import type { DiscardResult, SaveResult } from "./port";

/**
 * The open recoverable forms of THIS page (WEB-14a, D-P7). A form registers a handle while it is mounted (`useRecoverableForm`); the
 * app-update coordinator asks the registry which forms are dirty and saves each through its own handle before a reload (Q4), and when
 * another tab asks this one to save its input before an update is applied. The registry only lists; it saves nothing itself.
 *
 * A FREEZE (revision 1, R3) holds every form still from the moment the person accepts an update until the page reloads (or the reload is
 * abandoned): input typed after the last save would be lost by the reload, so none can be typed. A form that mounts while a freeze is in
 * force is frozen as it registers.
 */
export interface RecoverableFormHandle {
  readonly formContext: string;
  /** A reload would not bring back what the form shows now (see `useRecoverableForm`). */
  isDirty(): boolean;
  /** Saves a recovery copy of the form as it is now (or discards its copies when it is back to its clean state). Never submits; never throws. */
  flush(): Promise<SaveResult>;
  /** "Discard and reload anyway": the form's copies are discarded; `discarded` only when none can come back. Never throws. */
  discard?(): Promise<DiscardResult>;
  /** Holds the form still (no input); returns the release. */
  freeze?(): () => void;
}

export interface RecoverableFormRegistry {
  register(handle: RecoverableFormHandle): () => void;
  /** Every registered form, dirty or not. */
  all(): readonly RecoverableFormHandle[];
  dirty(): readonly RecoverableFormHandle[];
  /** Told when a form registers or unregisters. */
  subscribe(listener: () => void): () => void;
  /** Freezes every form, and every form that registers until the release. Returns the release (idempotent). */
  freeze(): () => void;
  /**
   * What a form that UNMOUNTED with unsaved input leaves to the form mounted again in its place in this page (revision 1: another page's
   * boot remounts the protected tree, finding F-1). Page memory only, never written anywhere; `take` hands it over once, and only to a form
   * of the same `scope` (the same account's database, the same incarnation).
   */
  carry(formContext: string, carried: CarriedForm): void;
  take(formContext: string, scope: string): CarriedForm | null;
}

/** A form's unsaved input and its recovery state, carried across a remount in the same page (see `carry`). */
export interface CarriedForm {
  scope: string;
  values: Record<string, string>;
  /** The hook's own state, opaque here. */
  state: unknown;
}

export function createRecoverableFormRegistry(): RecoverableFormRegistry {
  const handles = new Set<RecoverableFormHandle>();
  const listeners = new Set<() => void>();
  /** The releases of the forms the freezes in force hold, per freeze. */
  const freezes = new Set<Map<RecoverableFormHandle, () => void>>();
  const carried = new Map<string, CarriedForm>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const hold = (
    held: Map<RecoverableFormHandle, () => void>,
    handle: RecoverableFormHandle,
  ): void => {
    if (held.has(handle)) return;
    try {
      held.set(handle, handle.freeze?.() ?? (() => undefined));
    } catch {
      held.set(handle, () => undefined);
    }
  };
  return {
    register(handle) {
      handles.add(handle);
      for (const held of freezes) hold(held, handle);
      notify();
      return () => {
        for (const held of freezes) {
          const release = held.get(handle);
          held.delete(handle);
          release?.();
        }
        if (handles.delete(handle)) notify();
      };
    },
    all: () => [...handles],
    dirty: () =>
      [...handles].filter((handle) => {
        try {
          return handle.isDirty();
        } catch {
          // A form that cannot say is treated as dirty: saving a copy is the safe direction.
          return true;
        }
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    carry(formContext, form) {
      carried.set(formContext, form);
    },
    take(formContext, scope) {
      const form = carried.get(formContext);
      if (!form) return null;
      // Handed over once, whoever asks; another scope (another account, or the database deleted since) never sees it.
      carried.delete(formContext);
      return form.scope === scope ? form : null;
    },
    freeze() {
      const held = new Map<RecoverableFormHandle, () => void>();
      freezes.add(held);
      for (const handle of handles) hold(held, handle);
      return () => {
        if (!freezes.delete(held)) return;
        for (const release of held.values()) {
          try {
            release();
          } catch {
            // A form that cannot be released has gone.
          }
        }
        held.clear();
      };
    },
  };
}

/** The page's registry: one per page load. */
export const pageFormRegistry: RecoverableFormRegistry =
  createRecoverableFormRegistry();

/** Saves every dirty form; the results in registry order. A handle that throws counts as `failed`. */
export async function flushDirty(
  registry: RecoverableFormRegistry,
): Promise<SaveResult[]> {
  return Promise.all(
    registry
      .dirty()
      .map((handle) => handle.flush().catch((): SaveResult => "failed")),
  );
}

/**
 * "Discard and reload anyway" (revision 1, R6): discards the copies of every dirty form; the results in registry order. A form without a
 * discard (a handle written before revision 1) or one that throws counts as `failed`: nothing says its copy is gone.
 */
export async function discardDirty(
  registry: RecoverableFormRegistry,
): Promise<DiscardResult[]> {
  return Promise.all(
    registry
      .dirty()
      .map((handle) =>
        handle.discard
          ? handle.discard().catch((): DiscardResult => "failed")
          : Promise.resolve<DiscardResult>("failed"),
      ),
  );
}

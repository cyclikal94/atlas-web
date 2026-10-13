import type { DiscardResult, SaveResult } from "./port";

/**
 * The open recoverable forms of THIS page (WEB-14a, D-P7). A form registers a handle (`useRecoverableForm`: its form SESSION, `session.ts`);
 * the app-update coordinator asks the registry which forms are dirty and saves each through its own handle before a reload (Q4), and when
 * another tab asks this one to save its input before an update is applied. The registry only lists; it saves nothing itself.
 *
 * A FREEZE (revision 1, R3; revision 2) holds every form still from the moment the person accepts an update until the page reloads (or the
 * reload is abandoned): input typed after the last save would be lost by the reload, so none can be typed, and while a freeze is in force
 * (`frozen()`) the recovery actions that would change a form (restoring another copy, "Discard instead", starting a submission) are refused
 * and shown unavailable. A form that registers while a freeze is in force is frozen as it registers; one that cannot be held still is
 * counted (`unheld`), so the coordinator never takes it for safe.
 *
 * WHAT IS STILL OUTSTANDING (revision 2). A handle stays registered while its form has unfinished work, even when the form itself is not
 * mounted for a moment (a remount): `pending`/`settled` let the coordinator wait for every save, discard or submission already asked for
 * before it decides that a reload loses nothing.
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
  /** Revision 2: settles when every operation of the form outstanding NOW (a save, a discard, a submission) has settled; null when none is. */
  settled?(): Promise<void> | null;
  /**
   * Revision 6 (R13): writes the form's update hand-off for the copy it has (`handoff.ts`), before an update reload; `saved` when it needs
   * none. Never throws.
   */
  handoff?(): Promise<SaveResult>;
  /** Revision 6 (R13): the form has no copy to hand off, or its hand-off holds its current copy. */
  handedOff?(): boolean;
  /**
   * Revision 7 (R6): nothing of this page's for the form can come back after a reload (no copy, hand-off or discard owed; its newest
   * operation a landed terminal act). A handle without it counts as discarded when it is clean.
   */
  discarded?(): boolean;
  /** Revision 7 (R13): the form's look for what was left to it could not read the store; what it may restore is not known yet. */
  unresolved?(): boolean;
  /** Revision 7 (R13): makes that look again; true once it has read the store. Never throws. */
  retryRecovery?(): Promise<boolean>;
}

/** What the registry keeps of a form session (`session.ts`) for the page's life: its form context and the account database it is bound to. */
export interface PageFormSession {
  readonly formContext: string;
  readonly scope: string;
  /** Revision 6 (R13): its handle, so a kept session no mount shows still hands its copy off before an update reload. */
  readonly handle?: RecoverableFormHandle;
}

export interface RecoverableFormRegistry {
  register(handle: RecoverableFormHandle): () => void;
  /** Every registered form, dirty or not. */
  all(): readonly RecoverableFormHandle[];
  dirty(): readonly RecoverableFormHandle[];
  /** Told when a form registers or unregisters, and when a freeze starts or ends. */
  subscribe(listener: () => void): () => void;
  /** Freezes every form, and every form that registers until the release. Returns the release (idempotent). */
  freeze(): () => void;
  /** Revision 2 (R3): a freeze is in force; recovery actions that would change a form are refused. */
  frozen(): boolean;
  /** Revision 2 (R3): registered forms a freeze in force could not hold still (no `freeze`, or it threw). */
  unheld(): number;
  /** Revision 2: how many forms have operations outstanding now. */
  pending(): number;
  /** Revision 2: settles when every operation outstanding NOW has settled (later ones are not waited for). */
  settled(): Promise<void>;
  /**
   * Revision 2: the page's form sessions, one per form context (`session.ts`): what a form keeps across a remount in this page (memory only,
   * never written anywhere). `keep` makes a session the context's; `forget` removes it only if it is still the context's.
   */
  session(formContext: string): PageFormSession | undefined;
  sessions(): readonly PageFormSession[];
  keep(session: PageFormSession): void;
  forget(session: PageFormSession): void;
}

export function createRecoverableFormRegistry(): RecoverableFormRegistry {
  const handles = new Set<RecoverableFormHandle>();
  const listeners = new Set<() => void>();
  /** The releases of the forms each freeze in force holds (null: the form could not be held still). */
  const freezes = new Set<Map<RecoverableFormHandle, (() => void) | null>>();
  const sessions = new Map<string, PageFormSession>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const hold = (
    held: Map<RecoverableFormHandle, (() => void) | null>,
    handle: RecoverableFormHandle,
  ): void => {
    if (held.has(handle)) return;
    try {
      held.set(handle, handle.freeze ? handle.freeze() : null);
    } catch {
      held.set(handle, null);
    }
  };
  const outstanding = (): Promise<void>[] => {
    const waits: Promise<void>[] = [];
    for (const handle of handles) {
      let wait: Promise<void> | null | undefined = null;
      try {
        wait = handle.settled?.();
      } catch {
        wait = null;
      }
      if (wait) waits.push(wait);
    }
    return waits;
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
    freeze() {
      const held = new Map<RecoverableFormHandle, (() => void) | null>();
      freezes.add(held);
      for (const handle of handles) hold(held, handle);
      notify();
      return () => {
        if (!freezes.delete(held)) return;
        for (const release of held.values()) {
          try {
            release?.();
          } catch {
            // A form that cannot be released has gone.
          }
        }
        held.clear();
        notify();
      };
    },
    frozen: () => freezes.size > 0,
    unheld() {
      let count = 0;
      for (const handle of handles)
        for (const held of freezes)
          if (held.get(handle) === null) {
            count += 1;
            break;
          }
      return count;
    },
    pending: () => outstanding().length,
    settled: () => Promise.allSettled(outstanding()).then(() => undefined),
    session: (formContext) => sessions.get(formContext),
    sessions: () => [...sessions.values()],
    keep(session) {
      sessions.set(session.formContext, session);
    },
    forget(session) {
      if (sessions.get(session.formContext) === session)
        sessions.delete(session.formContext);
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
  handles: readonly RecoverableFormHandle[] = registry.dirty(),
): Promise<DiscardResult[]> {
  return Promise.all(
    handles.map((handle) =>
      handle.discard
        ? handle.discard().catch((): DiscardResult => "failed")
        : Promise.resolve<DiscardResult>("failed"),
    ),
  );
}

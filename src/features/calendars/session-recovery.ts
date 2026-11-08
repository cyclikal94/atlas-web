import { useCallback, useEffect, useRef, useState } from "react";
import {
  type RecoverableEditor,
  useRecoverableEditor,
} from "../../lib/form-recovery/editor";

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 (Kieran, 7 November 2026, "Fix all three in the merge"): WEB-13b's
 * dialogs whose input lives in an editing SESSION its owner keeps in page memory (the anchor panel's `anchor-editor.ts`, kept by the task
 * detail's visit or by the new-task form; the import dialog's `import-editor.ts`, kept by the import's visit) take part in WEB-14a's
 * app-update recovery (Q4; `lib/form-recovery/editor.ts`, docs/pwa.md "The product's editors") as WEB-14a's own calendar dialogs do.
 *
 * The SESSION stays the one authority for the input; the dialog showing it is the recoverable editor (`useRecoverableEditor`: registered
 * while shown, frozen while an update reload is prepared, saved by the update, restored after it), and the screen that opens the dialog is
 * its host (`useRecoveryHost`). What a session adds to a component-state editor, and how it is kept straight here:
 *
 *  - A SESSION OUTLIVES ITS DIALOG. The in-dialog sync control, a remount of the section or of the protected tree hide the dialog while the
 *    owner keeps the session for its visit: that unmount is no dismissal (`keep`), so the model stays listed and dirty, and a later update
 *    still saves the input. Only the session's END (Cancel, Escape or the close icon, its own save consuming it, a departure, another
 *    identity, a cache that expired it) ends the model's session (`end`: its copies are discarded, never restored after a later reload).
 *  - A NEW SESSION IS A NEW MODEL SESSION. A dialog that shows a session the model has not seen begins the model from what that session began
 *    from (`opening`), unless the model has just restored a copy into it; one that shows a session holding input the model does not have
 *    (left holding input while hidden) gives it that input. Every change the person makes is given to the model FIRST (`edit`): refused while
 *    an update reload is prepared, the dialog must not take it (the session does not change, so neither does what it shows).
 *  - A RESTORED COPY IS INPUT, NEVER A SUBMISSION. The host opens the dialog on a NEW session and the copy's input is put into it (`apply`);
 *    nothing is saved or queued until the person presses the dialog's own button, with its own checks.
 *
 * Page memory only, as the sessions: nothing here is written anywhere except through the recovery port.
 */
export interface OwnedSession {
  /** Never reused (`anchor-editor.ts`, `import-editor.ts`). */
  readonly session: number;
  ended(): boolean;
  onEnded(listener: () => void): () => void;
}

/** The session each identity's context was last given to its model with, and the text given (page memory). */
const given = new Map<string, { session: number; text: string }>();
/** The sessions whose end is already followed (once each, whatever dialog shows them). */
const followed = new WeakSet<OwnedSession>();

const keyOf = (identity: string, context: string) =>
  `${identity}\u0000${context}`;

/**
 * A host's opening of its dialog on a restored copy (`useRecoveryHost`'s `open`), held until the host may open it (its task or source read,
 * the person allowed to edit, no dialog shown) and then done once. The library asks a host once per copy: one asked too early would
 * otherwise never open its dialog, and the copy would only wait in the store.
 */
export function useOpenWhenReady(ready: boolean, open: () => void): () => void {
  const [asked, setAsked] = useState(false);
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!asked || !ready) return;
    setAsked(false);
    latest.current();
  }, [asked, ready]);
  return useCallback(() => setAsked(true), []);
}

/** Tests only (as `forgetRecoverableEditors`). */
export function forgetSessionRecovery(): void {
  given.clear();
}

export function useSessionRecovery<T>(options: {
  identity: string;
  context: string;
  /** The session the dialog shows. */
  owned: OwnedSession;
  /** What the session began from: its untouched input, and what "Discard instead" shows. */
  opening(): T;
  /** The session's input now. */
  current(): T;
  /** Whether the session holds input of the person's (an edit since it began, a file chosen). */
  holdsInput(): boolean;
  encode(value: T): string;
  /** Null for a text this build cannot read (offered, never restored in part). */
  decode(text: string): T | null;
  /** Puts `value` into the session (a restored copy, or "Discard instead"'s baseline). */
  apply(value: T): void;
  /** The dialog shows input the model cannot hold (a file, a date partly typed): an update stops instead of reloading over it. */
  unfinished?: () => boolean;
}): RecoverableEditor<T> {
  const { identity, context, owned } = options;
  const key = keyOf(identity, context);
  const latest = useRef(options);
  latest.current = options;
  // A copy restored into the session (at the dialog's mount, or chosen later) is what the model holds for it: given, so never begun over.
  const giveText = (session: number, value: T) =>
    given.set(key, { session, text: latest.current.encode(value) });
  const recovery = useRecoverableEditor<T>({
    identity,
    context,
    encode: (value) => latest.current.encode(value),
    decode: (text) => latest.current.decode(text),
    restored: (value) => {
      latest.current.apply(value);
      giveText(latest.current.owned.session, value);
    },
    untouched: () => !latest.current.holdsInput(),
    start: () => latest.current.opening(),
    reset: (value) => {
      latest.current.apply(value);
      giveText(latest.current.owned.session, value);
    },
    ...(options.unfinished
      ? { unfinished: () => latest.current.unfinished?.() ?? false }
      : {}),
  });
  const latestRecovery = useRef(recovery);
  latestRecovery.current = recovery;
  // Declared after `useRecoverableEditor`, so it runs after the editor's own mount (its show, its begin or resume, a pending restore).
  // biome-ignore lint/correctness/useExhaustiveDependencies: one pass per session shown (its identity and context are the reason)
  useEffect(() => {
    const shown = latest.current.owned;
    const session = shown.session;
    const model = latestRecovery.current;
    if (given.get(key)?.session !== session) {
      // A session the model has not seen: the model begins from what it began from (a stale `keep` of an earlier session included).
      model.begin(latest.current.opening());
      giveText(session, latest.current.opening());
    }
    // The session holds input the model does not have (it was left holding input while no dialog showed it): given now.
    if (latest.current.holdsInput()) {
      const now = latest.current.current();
      const text = latest.current.encode(now);
      if (given.get(key)?.text !== text && model.edit(now))
        given.set(key, { session, text });
    }
    // Its end, however it comes and whether or not a dialog shows it then, ends the model's session (a departure is a discard).
    if (!followed.has(shown)) {
      followed.add(shown);
      shown.onEnded(() => {
        if (given.get(key)?.session !== session) return;
        given.delete(key);
        void latestRecovery.current.end();
      });
    }
    return () => {
      // Hidden while its owner keeps it (the sync control, a remount): no dismissal; the model stays listed while it is dirty.
      if (!shown.ended()) latestRecovery.current.keep();
    };
  }, [key, owned]);
  return {
    ...recovery,
    edit(value) {
      if (!recovery.edit(value)) return false;
      giveText(latest.current.owned.session, value);
      return true;
    },
  };
}

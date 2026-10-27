import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFormRecoveryPort } from "../../data";
import { pageHandoffs } from "./handoff";
import {
  createRecoverableModel,
  type ModelTicket,
  type ModelView,
  type RecoverableModel,
  type RecoveryControls,
} from "./model";
import type { DiscardResult } from "./port";
import { pageFormRegistry } from "./registry";
import { getPageRecoveryTab } from "./tab-identity";
import { preAccountRecoveryPort } from "./tab-session-port";

/**
 * RECOVERABLE EDITORS WHOSE INPUT IS COMPONENT STATE (WEB-14a revision 37; review of 25 October 2026, R40; design assessment C1-C3). The
 * sharing editors, the calendar dialogs and the households' forms keep their draft in the editor itself (a dialog's state), with no
 * owner outside it. Each declares a codec and gets the page's RECOVERABLE MODEL for its context (`model.ts`), one per displayed identity
 * and context, made here and kept for the page's life:
 *
 *  - THE EDITOR (`useRecoverableEditor`) is the one authority for its input. It starts each editing session (`begin`: a fresh read, a reset)
 *    and gives every change in the same step (`edit`, refused while an update reload is prepared: the editor must not take the change), takes
 *    its submission tickets from the model (`submitting`, none while frozen) and completes them (`succeeded` only for a durable success),
 *    and ends the session when the person dismisses it (`end`: its copies go, as an explicit discard) unless it was kept for a visit to the
 *    sync screens (`keep`). It is shown while mounted (the update prompt saves first).
 *  - THE OPENER (`useRecoveryHost`) is the screen that opens the editor: a dialog is not open after a reload, so a look inside it would never
 *    run. The opener binds the model and makes the look; a copy found while no editor shows the context is held for the editor (never
 *    submitted), and the opener is told to open the editor, which takes it as its session's input (`restored`).
 *
 * The codec is the caller's: explicitly versioned, non-secret, the editor's raw input and the base it was composed against (never conferring
 * authority: a Save of restored input keeps the editor's own version/concurrency guards). Memory only, except through the port.
 *
 * Revision 38 (review of revision 37, R40-A/R40-B; design assessment C2-C3): "Discard instead" is ONE step at the gesture, here, for every
 * editor: admitted only while the model accepts input (no update reload prepared), the editor shows its typed baseline (`reset`) in the same
 * step as the model takes it and its copies' removal starts. The removal's completion changes nothing on screen (a later edit is never
 * erased by an earlier discard). A copy the person chooses replaces what the editor shows (`restored`), touched or not; only the look's
 * automatic restore needs untouched input.
 */

interface Editor {
  untouched(): boolean;
  /** `chosen`: the person chose the copy (no untouched rule; see `ModelOptions.restore`). */
  apply(text: string, chosen: boolean): boolean;
}

interface Entry {
  readonly identity: string;
  readonly model: RecoverableModel;
  /** Revision 38: a pre-account form's (its copies live in the tab's session storage, removed once restored or left). */
  readonly preAccount: boolean;
  /** A copy restored while no editor showed the context, for the next editor to take. */
  pending: string | null;
  editor: Editor | null;
  readonly hosts: Set<() => void>;
  /** The last editor's session was kept for a visit to the sync screens: the next editor resumes it (no new session at its mount). */
  kept: boolean;
  /**
   * Revision 38 (S12): the last editor unmounted in this turn; its dismissal is decided after it (an editor mounted again in the same turn,
   * as React's development remount does, resumes the session: no dismissal, no new session over what it shows).
   */
  leaving: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

const keyOf = (identity: string, context: string) =>
  `${identity}\u0000${context}`;

function entryFor(
  identity: string,
  context: string,
  preAccount = false,
): Entry {
  // Revision 38: a pre-account form is no account's: it is neither retired by an account's editor (a sign-in shown over the account,
  // switching) nor retires one; its model is only ever bound to the tab's pre-account store, and leaving it removes its copies.
  for (const [key, other] of [...entries])
    if (other.identity !== identity && !other.preAccount && !preAccount) {
      other.model.retire();
      entries.delete(key);
    }
  const key = keyOf(identity, context);
  const known = entries.get(key);
  if (known !== undefined) return known;
  const entry: Entry = {
    identity,
    preAccount,
    pending: null,
    editor: null,
    hosts: new Set(),
    kept: false,
    leaving: null,
    model: createRecoverableModel({
      formContext: context,
      start: "",
      restore: (text, chosen) => {
        if (entry.editor) return entry.editor.apply(text, chosen);
        if (entry.hosts.size === 0) return false;
        entry.pending = text;
        for (const open of [...entry.hosts]) open();
        return true;
      },
      untouched: () =>
        entry.editor ? entry.editor.untouched() : entry.pending === null,
      preAccount,
    }),
  };
  entries.set(key, entry);
  return entry;
}

/** For tests: every editor model leaves its registry and is forgotten. */
export function forgetRecoverableEditors(): void {
  for (const entry of entries.values()) entry.model.retire();
  entries.clear();
}

/**
 * The screen that opens the editor of `context`: binds its model to the account's store and looks for what the page before an update left
 * to it; `open` is called when a copy is restored for the editor (now, or already held when the opener mounts).
 */
export function useRecoveryHost(options: {
  /** Null while the screen has no displayed identity yet: nothing is looked for. */
  identity: string | null;
  context: string;
  open(): void;
}): void {
  const { identity, context } = options;
  const port = useFormRecoveryPort();
  const latest = useRef(options.open);
  latest.current = options.open;
  const entry = useMemo(
    () => (identity === null ? null : entryFor(identity, context)),
    [identity, context],
  );
  useEffect(() => {
    if (entry === null) return;
    const open = () => latest.current();
    entry.hosts.add(open);
    if (entry.pending !== null && entry.editor === null) open();
    return () => {
      entry.hosts.delete(open);
    };
  }, [entry]);
  useEffect(() => {
    entry?.model.bind(port);
  }, [entry, port]);
}

export interface RecoverableEditor<T> extends RecoveryControls {
  /** A new editing session starts from `value` (a fresh read, a reset). */
  begin(value: T): void;
  /** The person changed the input to `value`; false while an update reload is prepared (do not take the change). */
  edit(value: T): boolean;
  /** Before a submission; null while an update reload is prepared (send nothing). */
  submitting(): ModelTicket | null;
  /** The editor's session is kept for a visit to the sync screens: its unmount is not a dismissal. */
  keep(): void;
  /** The person dismissed the editor (Cancel, Close, Escape): its copies are discarded. */
  end(): Promise<DiscardResult>;
  /**
   * "Discard instead" (revision 38, R40-A): admitted now or not at all. Admitted, the editor shows its baseline (`reset`) and the model
   * holds it in this same step, and the copies' removal starts; the promise settles with that removal only (never reset anything then).
   * Not admitted (an update reload is being prepared): "failed", and nothing changes.
   */
  discard(): Promise<DiscardResult>;
}

/**
 * The editor of `context` (see above). `restored(value)` puts a copy's input into the editor (the session's input from now on, not an
 * edit); `untouched()` says whether the person has changed nothing since the session began, so a copy may be restored into it. `decode`
 * returns null for a text this build cannot read (offered, never restored in part). The model is shown while the editor is mounted; its
 * unmount ends the session (a dismissal) unless `keep` was called since the last change.
 */
export function useRecoverableEditor<T>(options: {
  identity: string;
  context: string;
  encode(value: T): string;
  decode(text: string): T | null;
  restored(value: T): void;
  untouched(): boolean;
  /** What the editor starts from when it mounts (its session begins there unless a restored copy is waiting for it). */
  start(): T;
  /** Revision 38 (R40-A): what "Discard instead" shows, as of the gesture (default: `start()`). */
  baseline?: () => T;
  /**
   * Revision 38 (R40-A): "Discard instead" shows `value` as an untouched start, in the same step as the model takes it (the editor's own
   * state: its untouched mark, a restored version, a save's identity). Never called when the discard is not admitted.
   */
  reset(value: T): void;
  /** The editor shows a native editing state its value cannot hold (`RecoverableModel.probe`). */
  unfinished?: () => boolean;
  /**
   * Input typed before any account is displayed (signing in, joining; revision 38, WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026): never
   * bound to an account's store, but to this tab's session storage (`tab-session-port.ts`, the username's text only), for an app-update
   * reload. A copy restored is removed at once and every other copy of the context in the tab once the look has read it; leaving the form
   * removes its own. Storage that cannot be written fails the save (the update stops with retry or an explicit discard).
   */
  preAccount?: boolean;
}): RecoverableEditor<T> {
  const { identity, context } = options;
  const port = useFormRecoveryPort();
  const latest = useRef(options);
  latest.current = options;
  const preAccount = options.preAccount === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per identity and context (its kind is the first caller's)
  const entry = useMemo(
    () => entryFor(identity, context, preAccount),
    [identity, context],
  );
  useEffect(() => {
    const editor: Editor = {
      untouched: () => latest.current.untouched(),
      apply: (text, chosen) => {
        const value = latest.current.decode(text);
        if (value === null || (!chosen && !latest.current.untouched()))
          return false;
        latest.current.restored(value);
        return true;
      },
    };
    entry.editor = editor;
    const resumed = entry.leaving !== null;
    if (entry.leaving !== null) clearTimeout(entry.leaving);
    entry.leaving = null;
    const hide = entry.model.show();
    if (latest.current.unfinished)
      entry.model.probe(() => latest.current.unfinished?.() ?? false);
    // A copy the opener's look restored before this editor mounted: its input from now on (the model already holds it).
    const pending = entry.pending;
    entry.pending = null;
    const waiting = pending === null ? null : latest.current.decode(pending);
    if (waiting !== null) latest.current.restored(waiting);
    // A session kept for a visit to the sync screens, or resumed by a mount in the turn its editor unmounted, goes on (its unsaved input
    // stays the model's); otherwise a new one begins.
    else if (!entry.kept && !resumed)
      entry.model.begin(latest.current.encode(latest.current.start()));
    // This editor owns the resumed session now: its unmount is a dismissal unless it is kept again.
    entry.kept = false;
    return () => {
      if (entry.editor === editor) entry.editor = null;
      entry.model.probe(null);
      hide();
      if (entry.kept) return;
      // A dismissal, decided after this turn (see `leaving`).
      entry.leaving = setTimeout(() => {
        entry.leaving = null;
        if (entry.editor === null && !entry.kept) void entry.model.end();
      }, 0);
    };
  }, [entry]);
  useEffect(() => {
    entry.model.bind(preAccount ? preAccountRecoveryPort() : port);
  }, [entry, port, preAccount]);
  const view = useSyncExternalStore(
    entry.model.subscribe,
    entry.model.view,
    entry.model.view,
  );
  // Revision 38: once a pre-account form's look has read the tab's store, nothing an earlier page of the tab left for it stays there.
  const looked = view.ready;
  useEffect(() => {
    if (!preAccount || !looked) return;
    // Never this page's own copy or a hand-off it wrote (an update may be prepared by then).
    const sweep = (id: string | null) =>
      preAccountRecoveryPort().sweep(
        context,
        (tab) => tab === id || pageHandoffs.written.has(tab),
      );
    void getPageRecoveryTab()
      .id()
      .then(sweep, () => sweep(null));
  }, [preAccount, looked, context]);
  const locked = useSyncExternalStore(
    pageFormRegistry.subscribe,
    pageFormRegistry.frozen,
    pageFormRegistry.frozen,
  );
  const model = entry.model;
  return {
    view,
    locked,
    begin(value) {
      entry.kept = false;
      model.begin(latest.current.encode(value));
    },
    edit(value) {
      if (!model.edit(latest.current.encode(value))) return false;
      entry.kept = false;
      return true;
    },
    submitting: () => model.submitting(),
    keep() {
      entry.kept = true;
    },
    end: () => model.end(),
    discard() {
      if (!model.accepting()) return Promise.resolve<DiscardResult>("failed");
      const value = (latest.current.baseline ?? latest.current.start)();
      entry.kept = false;
      const removal = model.discard(latest.current.encode(value));
      latest.current.reset(value);
      return removal;
    },
    retry: () => model.retry(),
    restoreAlternative: (copy) => model.restoreAlternative(copy.tabInstanceId),
    discardAlternative: (copy) => model.discardAlternative(copy.tabInstanceId),
  };
}

export type { ModelView };

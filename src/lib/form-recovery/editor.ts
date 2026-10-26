import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFormRecoveryPort } from "../../data";
import {
  createRecoverableModel,
  type ModelTicket,
  type ModelView,
  type RecoverableModel,
  type RecoveryControls,
} from "./model";
import type { DiscardResult } from "./port";
import { pageFormRegistry } from "./registry";

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
 */

interface Editor {
  untouched(): boolean;
  apply(text: string): boolean;
}

interface Entry {
  readonly identity: string;
  readonly model: RecoverableModel;
  /** A copy restored while no editor showed the context, for the next editor to take. */
  pending: string | null;
  editor: Editor | null;
  readonly hosts: Set<() => void>;
  /** The last editor's session was kept for a visit to the sync screens: the next editor resumes it (no new session at its mount). */
  kept: boolean;
}

const entries = new Map<string, Entry>();

const keyOf = (identity: string, context: string) =>
  `${identity}\u0000${context}`;

function entryFor(identity: string, context: string): Entry {
  for (const [key, other] of [...entries])
    if (other.identity !== identity) {
      other.model.retire();
      entries.delete(key);
    }
  const key = keyOf(identity, context);
  const known = entries.get(key);
  if (known !== undefined) return known;
  const entry: Entry = {
    identity,
    pending: null,
    editor: null,
    hosts: new Set(),
    kept: false,
    model: createRecoverableModel({
      formContext: context,
      start: "",
      restore: (text) => {
        if (entry.editor) return entry.editor.apply(text);
        if (entry.hosts.size === 0) return false;
        entry.pending = text;
        for (const open of [...entry.hosts]) open();
        return true;
      },
      untouched: () =>
        entry.editor ? entry.editor.untouched() : entry.pending === null,
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
  /** The editor shows a native editing state its value cannot hold (`RecoverableModel.probe`). */
  unfinished?: () => boolean;
  /**
   * Never bound to an account's store (input typed before any account is displayed: signing in, joining). Its unsaved input still counts
   * for an update: dirty, and its save fails (the update stops with retry or an explicit discard), never written under another account.
   */
  unbound?: boolean;
}): RecoverableEditor<T> {
  const { identity, context } = options;
  const port = useFormRecoveryPort();
  const latest = useRef(options);
  latest.current = options;
  const entry = useMemo(() => entryFor(identity, context), [identity, context]);
  useEffect(() => {
    const editor: Editor = {
      untouched: () => latest.current.untouched(),
      apply: (text) => {
        const value = latest.current.decode(text);
        if (value === null || !latest.current.untouched()) return false;
        latest.current.restored(value);
        return true;
      },
    };
    entry.editor = editor;
    const hide = entry.model.show();
    if (latest.current.unfinished)
      entry.model.probe(() => latest.current.unfinished?.() ?? false);
    // A copy the opener's look restored before this editor mounted: its input from now on (the model already holds it).
    const pending = entry.pending;
    entry.pending = null;
    const waiting = pending === null ? null : latest.current.decode(pending);
    if (waiting !== null) latest.current.restored(waiting);
    // A session kept for a visit to the sync screens goes on (its unsaved input stays the model's); otherwise a new one begins.
    else if (!entry.kept)
      entry.model.begin(latest.current.encode(latest.current.start()));
    // This editor owns the resumed session now: its unmount is a dismissal unless it is kept again.
    entry.kept = false;
    return () => {
      if (entry.editor === editor) entry.editor = null;
      entry.model.probe(null);
      hide();
      if (!entry.kept) void entry.model.end();
    };
  }, [entry]);
  const unbound = options.unbound === true;
  useEffect(() => {
    if (!unbound) entry.model.bind(port);
  }, [entry, port, unbound]);
  const view = useSyncExternalStore(
    entry.model.subscribe,
    entry.model.view,
    entry.model.view,
  );
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
    discard: () => model.discard(""),
    retry: () => model.retry(),
    restoreAlternative: (copy) => model.restoreAlternative(copy.tabInstanceId),
    discardAlternative: (copy) => model.discardAlternative(copy.tabInstanceId),
  };
}

export type { ModelView };

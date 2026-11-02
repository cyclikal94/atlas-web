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
 *
 * Revision 38 (review of revision 37, R40-A/R40-B; design assessment C2-C3): "Discard instead" is ONE step at the gesture, here, for every
 * editor: admitted only while the model accepts input (no update reload prepared), the editor shows its typed baseline (`reset`) in the same
 * step as the model takes it and its copies' removal starts. The removal's completion changes nothing on screen (a later edit is never
 * erased by an earlier discard). A copy the person chooses replaces what the editor shows (`restored`), touched or not; only the look's
 * automatic restore needs untouched input.
 *
 * Revision 40 (review of revision 39, R40-GATE; design assessment C1/C2, I1-I4): A PRE-ACCOUNT EDITOR'S INPUT BELONGS TO ITS JOURNEY, NOT
 * TO ITS MOUNT. The neutral gate removes a sign-in or join form while its attempt resolves, and a refusal brings the same host back: the
 * form's absence is not the person's dismissal. So a pre-account editor's unmount only detaches it (no `end`, no timer); the input, its
 * revision and its tickets stay the model's, and the editor that mounts again for the same journey shows that exact input (`restored`)
 * instead of beginning again. Only an authoritative event ends it: a durable success of the exact input (its ticket), the person's own
 * Back or Cancel (`end`, or `endPreAccountInput` for a host's close), another journey of the same host (`journey`: a new invitation, a
 * switch to another account), or an account displayed (`settlePreAccountInput`). Its unfinished input stops an update reload while it lasts,
 * shown or not. An account's editors keep their own closure rules: their unmount is a dialog's close, a departure or the session's
 * protective closure (session matrix 3.6.2), each a dismissal.
 */

interface Editor {
  untouched(): boolean;
  /** `chosen`: the person chose the copy (no untouched rule; see `ModelOptions.restore`). */
  apply(text: string, chosen: boolean): boolean;
}

interface Entry {
  readonly identity: string;
  readonly context: string;
  readonly model: RecoverableModel;
  /** Revision 40 (R40-GATE): a pre-account editor's journey (null until an editor mounts): another journey's input is never shown. */
  journey: string | null;
  /** Revision 38: a pre-account form's (revision 39: never bound to a store; its input is never restored after a reload). */
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
  // switching) nor retires one (revision 39: its submissions' tickets stay outstanding work, whatever account binds meanwhile).
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
    context,
    journey: null,
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

/** Revision 40 (R40-GATE; design assessment Q1): how many dismissals are scheduled and not decided yet, and who waits for them. */
let undecided = 0;
let waiting: (() => void)[] = [];
const decided = (): void => {
  undecided -= 1;
  if (undecided > 0) return;
  const told = waiting;
  waiting = [];
  for (const tell of told) tell();
};

/** For tests: settles once every editor dismissal scheduled so far has been decided (an explicit acknowledgement, not a sleep). */
export const dismissalsDecided = (): Promise<void> =>
  undecided === 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        waiting.push(resolve);
      });

/** For tests: every editor model leaves its registry and is forgotten. */
export function forgetRecoverableEditors(): void {
  for (const entry of entries.values()) entry.model.retire();
  entries.clear();
}

/**
 * Revision 40 (R40-GATE): the person closed a pre-account host (a dialog's Close or Escape) for `journey` of `context`: its input ends as
 * at the form's own Back (`end`). Another journey's input is untouched.
 */
export function endPreAccountInput(context: string, journey: string): void {
  for (const entry of entries.values())
    if (
      entry.preAccount &&
      entry.context === context &&
      entry.journey === journey
    )
      void entry.model.end();
}

/**
 * Revision 40 (R40-GATE): an account displays, the displayed one changed or signed out, or a newer invitation link replaced the join page:
 * the pre-account journeys `ends` names are over (an account is signed in; the switch or confirmation was the previous account's; the old
 * link's form can never show again). Their unfinished input ends; a ticket still out stays outstanding work until its outcome. An editor
 * shown now is the person's to finish and is left alone.
 */
export function settlePreAccountInput(
  ends: (context: string, journey: string | null) => boolean,
): void {
  for (const entry of entries.values())
    if (
      entry.preAccount &&
      entry.editor === null &&
      ends(entry.context, entry.journey)
    )
      void entry.model.end();
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
  /**
   * The editor's session is kept for a visit to the sync screens: its unmount is not a dismissal. Revision 39 (DA-DEVICE-NAME): given the
   * editor's input, the editor's host opens it again on that input when it mounts (the person comes back), as for a restored copy.
   */
  keep(value?: T): void;
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
 * unmount ends the session (a dismissal) unless `keep` was called since the last change, or (revision 40) the editor is a pre-account one.
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
   * Input typed before any account is displayed (signing in, joining; revision 38, WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026). Revision 39
   * (review of revision 38, R40-COMPOSITION; design assessment C1/C3): never bound to any store and never restored after a reload (see
   * `ModelOptions.preAccount`); its unfinished input stops an update reload, and stays on screen. Its submissions still take tickets: none
   * while an update reload is being prepared, and one taken before is outstanding work until its outcome. Revision 40 (R40-GATE): its
   * input belongs to its journey (see above): an unmount only detaches it.
   */
  preAccount?: boolean;
  /**
   * Revision 40 (R40-GATE; design assessment C1): which journey of the host a pre-account editor serves (an invitation's link, a switch's
   * target). An editor of another journey ends the previous one's input and begins its own; the same journey's comes back to it. Default "".
   */
  journey?: string;
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
    if (entry.leaving !== null) {
      clearTimeout(entry.leaving);
      decided();
    }
    entry.leaving = null;
    const hide = entry.model.show();
    if (latest.current.unfinished)
      entry.model.probe(() => latest.current.unfinished?.() ?? false);
    // A copy the opener's look restored before this editor mounted: its input from now on (the model already holds it).
    const pending = entry.pending;
    entry.pending = null;
    const waiting = pending === null ? null : latest.current.decode(pending);
    if (waiting !== null) latest.current.restored(waiting);
    else if (entry.preAccount) {
      // Revision 40 (R40-GATE): the same journey's unfinished input comes back exactly as it was (no new session over it); another
      // journey's ends, and this one begins.
      const journey = latest.current.journey ?? "";
      if (entry.journey !== null && entry.journey !== journey)
        void entry.model.end();
      const held =
        entry.journey === journey ? entry.model.unfinishedText() : null;
      entry.journey = journey;
      const value = held === null ? null : latest.current.decode(held);
      if (value !== null) latest.current.restored(value);
      else entry.model.begin(latest.current.encode(latest.current.start()));
    }
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
      // Revision 40 (R40-GATE): a pre-account editor's unmount is never its journey's end (a gate, a host replaced for a moment).
      if (entry.kept || entry.preAccount) return;
      // A dismissal, decided after this turn (see `leaving`).
      undecided += 1;
      entry.leaving = setTimeout(() => {
        entry.leaving = null;
        if (entry.editor === null && !entry.kept) void entry.model.end();
        decided();
      }, 0);
    };
  }, [entry]);
  useEffect(() => {
    entry.model.bind(port);
  }, [entry, port]);
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
    keep(value) {
      entry.kept = true;
      if (value === undefined) return;
      // The host's next mount opens the editor on it (a session kept: the editor resumes it, never a new one).
      entry.pending = latest.current.encode(value);
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

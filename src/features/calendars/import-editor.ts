import { IMPORT_QUEUED_NEWER } from "./copy-import";
import {
  defaultWindow,
  type ImportFileCheck,
  readImportFile,
} from "./model/import";
import { createSubmission, type Submission } from "./model/submission";

/**
 * ONE editing session of the import dialog (WEB-13b revision 6, review 6 R7; design assessment C1-C3, invariants 1-7; ia.md §1.3.3, the
 * J2 dialog rule). The session, not the dialog's mount, owns everything the person chose: the source (the drop zone's chooser), the raw
 * window as typed, the file and its check, the read under way, the inline messages, what the last save said, the save being made and the
 * save identity (R2). A dialog is only a presentation of it: the in-dialog sync control unmounts the dialog, and opening Import events
 * again on the same visit shows the SAME session (`import-kept.ts`); a read or a save goes on and settles here whichever dialog, if any,
 * shows it then.
 *
 *  - Only the file the person last chose can be imported (R1): choosing another forgets the previous one at once and starts a new read;
 *    until it is read nothing can be imported. A read settles only for the session's latest choice, and never once the session ended.
 *    Choosing nothing (the picker cancelled) changes nothing.
 *  - Every change of what would be imported (file, source, window) moves `revision`. At most one save at a time (`busy`): a save captures
 *    a ticket `{flight, revision}` synchronously, and only that flight settles, only while the session has not ended. Queued with nothing
 *    edited since: the session is consumed (the dialog showing it closes). Queued with newer input: the input stays and the note says the
 *    import was queued as pressed (R3). Either way that save identity is spent. Refused or failed: the words stay with the input, busy
 *    clears, and the same choices pressed again reuse the identity.
 *  - Ended (Cancel, Escape, the close icon, the visit gone, another session replacing it): nothing changes it again, and the file's text
 *    is let go of. A save it already made stays queued (ending is not a roll-back), and is still announced when it is. REVOKED (another
 *    identity, another database): not even that is said, so nothing of the previous identity is told on the next one's screen.
 *
 * Page memory only: never stored, sent, broadcast or logged; a reload or another tab has no session. Session and flight numbers are never
 * reused.
 */
export interface ChosenFile {
  readonly name: string;
  /** The read that produced it: a new one for every file read (the text itself is never hashed). */
  readonly token: number;
  readonly check: ImportFileCheck;
}

export interface ImportErrors {
  readonly file: string | null;
  readonly from: string | null;
  readonly through: string | null;
}

export interface ImportEditorState {
  /** The drop zone's chosen source (null: none chosen yet; a row's import has its source fixed by its entry). */
  readonly chosen: string | null;
  /** As typed, valid or not. */
  readonly window: { readonly from: string; readonly through: string };
  readonly file: ChosenFile | null;
  /** The latest choice is being read: nothing can be imported. */
  readonly reading: boolean;
  readonly errors: ImportErrors;
  /** What the last settled save said (a refusal's words, or that newer input stayed), or a message the dialog set. */
  readonly message: string | null;
  /** A save of this session has not settled. */
  readonly busy: boolean;
  /** Every change of what would be imported moves it. */
  readonly revision: number;
}

/** What a save answers: queued, or the words of why not. */
export type ImportSaveOutcome =
  | { readonly kind: "queued" }
  | { readonly kind: "refused"; readonly message: string };

/** The choices a save identity is pinned to (R2): the same choices pressed again are the same operation. */
export interface ImportChoice {
  readonly source: string;
  readonly from: string;
  readonly through: string;
  readonly file: number;
}

export interface ImportEditor {
  /** Never reused. */
  readonly session: number;
  state(): ImportEditorState;
  /** Consumed by its own save, or ended by its owner. */
  ended(): boolean;
  /** `listener` hears every change; `consumed` once the session's own save consumed it. */
  subscribe(listener: (event: "changed" | "consumed") => void): () => void;
  /** A file the person chose or dropped (undefined: the picker was cancelled, which changes nothing). */
  choose(file: File | undefined): void;
  /** The drop zone's source. */
  chooseSource(id: string): void;
  /** Keeps the source shown as the session's (the first one offered, or one the person paged away from) without it being an edit. */
  pinSource(id: string): void;
  editWindow(patch: Partial<{ from: string; through: string }>): void;
  /** The dialog's own validation: the messages it shows, not an edit. */
  setErrors(errors: ImportErrors): void;
  setMessage(message: string | null): void;
  /**
   * Starts a save of `choice` (refused, false, while another save of the session is being made or once it has ended): `run` is called
   * once, synchronously, with the save identity for `choice`. `onQueued` is told when it is queued and the session was not revoked.
   * The dialog refuses while the latest file is being read (no file is chosen then, so there is nothing to submit).
   */
  submit(
    choice: ImportChoice,
    run: (key: string) => Promise<ImportSaveOutcome>,
    onQueued?: () => void,
  ): boolean;
  /** `revoked`: its identity or its database is no longer the displayed one. */
  end(reason?: "discarded" | "revoked"): void;
}

let sessions = 0;
let flights = 0;
let reads = 0;

const NO_ERRORS: ImportErrors = { file: null, from: null, through: null };

export function createImportEditor({
  today,
  chosen = null,
  mintKey = () => crypto.randomUUID(),
  onConsumed,
}: {
  /** Today's date on this device (`YYYY-MM-DD`): the default window's start. */
  today: string;
  chosen?: string | null;
  mintKey?: () => string;
  onConsumed?: () => void;
}): ImportEditor {
  sessions += 1;
  const session = sessions;
  let state: ImportEditorState = {
    chosen,
    window: defaultWindow(today),
    file: null,
    reading: false,
    errors: NO_ERRORS,
    message: null,
    busy: false,
    revision: 0,
  };
  let latestRead: number | null = null;
  let waiting: { flight: number; revision: number } | null = null;
  let over = false;
  let revoked = false;
  let submission: Submission<ImportChoice> | null =
    createSubmission<ImportChoice>(mintKey);
  const listeners = new Set<(event: "changed" | "consumed") => void>();
  const publish = (event: "changed" | "consumed") => {
    for (const listener of [...listeners]) listener(event);
  };
  const change = (next: Partial<ImportEditorState>) => {
    state = { ...state, ...next };
    publish("changed");
  };
  const finish = () => {
    over = true;
    listeners.clear();
    // Let go of the file's text and the save identity (no claim of erasing what the browser itself holds).
    state = { ...state, file: null };
    submission = null;
    latestRead = null;
  };
  const settle = (
    ticket: { flight: number; revision: number },
    outcome: ImportSaveOutcome | undefined,
    onQueued: (() => void) | undefined,
  ) => {
    if (waiting?.flight !== ticket.flight) return;
    // An ended session's save that was stored is still said to be (Cancel is not a roll-back), unless the session was revoked.
    if (over) {
      if (outcome?.kind === "queued" && !revoked) onQueued?.();
      return;
    }
    waiting = null;
    if (outcome === undefined) {
      change({ busy: false });
      return;
    }
    if (outcome.kind === "refused") {
      change({ busy: false, message: outcome.message });
      return;
    }
    // Its identity is spent: pressing Import again, even for the same choices, is a new import.
    submission?.invalidate();
    onQueued?.();
    if (state.revision === ticket.revision) {
      publish("consumed");
      finish();
      onConsumed?.();
    } else change({ busy: false, message: IMPORT_QUEUED_NEWER });
  };
  return {
    session,
    state: () => state,
    ended: () => over,
    subscribe(listener) {
      if (over) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose(file) {
      if (over || file === undefined) return;
      reads += 1;
      const read = reads;
      latestRead = read;
      // The previous file is no longer the person's choice: it is forgotten now, not when the new one has been read (R1).
      change({
        file: null,
        reading: true,
        errors: { ...state.errors, file: null },
        revision: state.revision + 1,
      });
      void readImportFile(file).then((check) => {
        // A later choice wins; a read that finishes after the session ended changes nothing.
        if (over || read !== latestRead) return;
        latestRead = null;
        change({
          file: { name: file.name, token: read, check },
          reading: false,
        });
      });
    },
    chooseSource(id) {
      if (over) return;
      change({ chosen: id, revision: state.revision + 1 });
    },
    pinSource(id) {
      if (over || state.chosen !== null) return;
      change({ chosen: id });
    },
    editWindow(patch) {
      if (over) return;
      change({
        window: { ...state.window, ...patch },
        revision: state.revision + 1,
      });
    },
    setErrors(errors) {
      if (!over) change({ errors });
    },
    setMessage(message) {
      if (!over) change({ message });
    },
    submit(choice, run, onQueued) {
      if (over || waiting !== null || submission === null) return false;
      flights += 1;
      const ticket = { flight: flights, revision: state.revision };
      waiting = ticket;
      const { key } = submission.attempt(choice);
      change({ busy: true, message: null });
      // A save that throws settles nothing but the busy mark (the dialog's own refusals are its answers).
      let started: Promise<ImportSaveOutcome>;
      try {
        started = run(key);
      } catch (error) {
        started = Promise.reject(error);
      }
      void started.then(
        (outcome) => settle(ticket, outcome, onQueued),
        () => settle(ticket, undefined, undefined),
      );
      return true;
    },
    end(reason = "discarded") {
      if (over) return;
      revoked = reason === "revoked";
      finish();
    },
  };
}

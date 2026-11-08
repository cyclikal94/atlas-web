import { ANCHOR_SAVED_NEWER } from "./copy-anchor";
import type { AnchorDraft, AnchorNames } from "./model/anchor";

/**
 * ONE editing session of the anchor-configuration panel (WEB-13b revision 2, review 2 R3a/R3b; design assessment, invariants 1–5). The
 * session, not the panel's mount, owns the whole raw input (every field, hidden ones included, and the names its summary shows), its edit
 * count, the save it is making and what the last save said. A panel is only a presentation of it: the in-dialog sync control unmounts the
 * panel, a later panel on the task's visit shows the SAME session again (`tasks/detail/anchor-kept.ts`), and a save goes on and settles
 * here whichever panel, if any, shows it then.
 *
 *  - Session numbers and submission numbers are never reused. A save captures a ticket `{submission, revision}`; its completion is the
 *    session's only while the session has not ended and that submission is the one it is waiting on. A cancelled or replaced session has
 *    ended: its late completion changes nothing, and in particular never another session (R3b), whatever the two edit counts are.
 *  - At most one save at a time (`busy`): a panel shown again while one is being made shows it and cannot start another (direct, Enter or
 *    double submission alike).
 *  - Done, nothing edited since what it submitted: the session is consumed (`consumed`; the panel showing it closes, none is offered to be
 *    saved twice). Done with newer input: the input stays, the note says the save was made as pressed, and the caller's `renew` makes what
 *    the next save is checked against (R3a: whether the panel was shown again before or after the completion). Refused or failed: nothing
 *    is consumed and the refusal's words stay with the input, shown or not. A refusal can also say what the next save is checked against
 *    (`AnchorRefusal`): told that the task changed, the person's next press is a deliberate save of the task as it is then.
 *
 * Page memory only: never stored; a reload has no session. The caller's save itself (`run`) and its operation identity are the caller's.
 *
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 G-2 (Kieran, 7 November 2026): around an app-update reload the
 * panel showing a session gives its input to WEB-14a's recoverable model (`session-recovery.ts`), which saves it; the session itself stays
 * page memory. For that it tells what it began from (`opening`), takes a restored copy's input (`restore`) and says when it ends, however
 * it ends (`onEnded`: its owner's end, or its own save consuming it), so that a departure discards the copies as it discards the input.
 */
export interface AnchorEditorState {
  readonly draft: AnchorDraft;
  readonly names: AnchorNames;
  /** Every edit moves it (a pick, a weekday, a hidden field's value included). */
  readonly revision: number;
  /** A save of this session has not settled. */
  readonly busy: boolean;
  /** What the last settled save said (a refusal's words, or that newer input stayed), or null. */
  readonly note: string | null;
}

/** A refusal (its words) that also renews what the session's next save is checked against. */
export interface AnchorRefusal<C> {
  readonly refused: string;
  readonly context: C;
}

export interface AnchorEditor<C = null> {
  /** Never reused. */
  readonly session: number;
  state(): AnchorEditorState;
  /** What the session was opened for (the caller's), as renewed by its own done saves. */
  context(): C;
  /** Consumed by its own save, or ended by its owner (Cancel, the visit's end, another session replacing it). */
  ended(): boolean;
  /** The in-dialog sync control kept it for the next panel (cleared when a panel shows it again). */
  retained(): boolean;
  /** `listener` hears every change; `consumed` once the session's own save consumed it. */
  subscribe(listener: (event: "changed" | "consumed") => void): () => void;
  edit(patch: Partial<AnchorDraft>, picked?: Partial<AnchorNames>): void;
  /**
   * Starts a save: `run` is called once with the session's context and answers null when done or the words of why not (with a renewed
   * context, an `AnchorRefusal`). Refused (false) while another save of the session is being made or once it has ended.
   */
  submit(
    run: (context: C) => Promise<string | null | AnchorRefusal<C>>,
  ): boolean;
  retain(): void;
  /** A panel shows it again. */
  resume(): void;
  end(): void;
  /** M-13b-1 G-2: the draft and names the session began from (never changed by an edit). */
  opening(): { draft: AnchorDraft; names: AnchorNames };
  /**
   * M-13b-1 G-2: a restored copy's input (or "Discard instead"'s baseline) becomes the session's, as an edit (its revision moves); `context`,
   * when given, replaces what the session was opened for (a restored copy's base). Nothing while a save is being made or once it has ended.
   */
  restore(input: { draft: AnchorDraft; names: AnchorNames }, context?: C): void;
  /** M-13b-1 G-2: `listener` is told once when the session ends, by its owner or by its own save consuming it. */
  onEnded(listener: () => void): () => void;
}

let sessions = 0;
let submissions = 0;

export function createAnchorEditor<C>({
  draft,
  names,
  context,
  renew = (c) => c,
  onConsumed,
}: {
  draft: AnchorDraft;
  names: AnchorNames;
  context: C;
  /** What the next save is checked against after a done save of this session that left newer input. */
  renew?: (context: C) => C;
  onConsumed?: () => void;
}): AnchorEditor<C> {
  sessions += 1;
  const session = sessions;
  let state: AnchorEditorState = {
    draft,
    names,
    revision: 0,
    busy: false,
    note: null,
  };
  let current = context;
  let waiting: { submission: number; revision: number } | null = null;
  let over = false;
  let kept = false;
  const opening = { draft, names };
  const listeners = new Set<(event: "changed" | "consumed") => void>();
  const endings = new Set<() => void>();
  const ended = () => {
    const told = [...endings];
    endings.clear();
    for (const listener of told) listener();
  };
  const publish = (event: "changed" | "consumed") => {
    for (const listener of [...listeners]) listener(event);
  };
  const change = (next: Partial<AnchorEditorState>) => {
    state = { ...state, ...next };
    publish("changed");
  };
  const settle = (
    ticket: { submission: number; revision: number },
    refused: string | null | AnchorRefusal<C> | undefined,
  ) => {
    if (over || waiting?.submission !== ticket.submission) return;
    waiting = null;
    if (refused === undefined) change({ busy: false });
    else if (typeof refused === "object" && refused !== null) {
      current = refused.context;
      change({ busy: false, note: refused.refused });
    } else if (refused !== null) change({ busy: false, note: refused });
    else if (state.revision === ticket.revision) {
      over = true;
      publish("consumed");
      listeners.clear();
      onConsumed?.();
      ended();
    } else {
      current = renew(current);
      change({ busy: false, note: ANCHOR_SAVED_NEWER });
    }
  };
  return {
    session,
    state: () => state,
    context: () => current,
    ended: () => over,
    retained: () => kept,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit(patch, picked) {
      if (over) return;
      change({
        draft: { ...state.draft, ...patch },
        names:
          picked === undefined ? state.names : { ...state.names, ...picked },
        revision: state.revision + 1,
      });
    },
    submit(run) {
      if (over || waiting !== null) return false;
      submissions += 1;
      const ticket = { submission: submissions, revision: state.revision };
      waiting = ticket;
      change({ busy: true, note: null });
      // A save that throws settles nothing but the busy mark (the caller's own refusals are its answers).
      void run(current).then(
        (refused) => settle(ticket, refused),
        () => settle(ticket, undefined),
      );
      return true;
    },
    retain() {
      if (!over) kept = true;
    },
    resume() {
      kept = false;
    },
    end() {
      over = true;
      listeners.clear();
      ended();
    },
    opening: () => opening,
    restore(input, context) {
      if (over || waiting !== null) return;
      if (context !== undefined) current = context;
      change({
        draft: input.draft,
        names: input.names,
        revision: state.revision + 1,
        note: null,
      });
    },
    onEnded(listener) {
      // Already ended: told at once (an end is never missed by a listener that comes late).
      if (!over) {
        endings.add(listener);
        return () => {
          endings.delete(listener);
        };
      }
      listener();
      return () => undefined;
    },
  };
}

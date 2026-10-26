import type {
  Identity,
  NeutralStateId,
  Session,
  SessionView,
} from "../../session";
import { attemptEnd } from "./attempt-signal";
import { authFeedback } from "./feedback";

export { attemptEnd };

/**
 * The producer of "That sign-in didn't finish" (`1c.ended`, WEB-08c, decision D-8c-04). The 1c notices are the application's, not
 * the kernel's (D-8b-03): this watcher derives the fact from the session's own `view` and `identity` and tells the person through
 * `authFeedback` (page memory). It carries no account data, never changes protection, writes no record and consults no kernel
 * internals.
 *
 * Rule. When the view enters an INDETERMINATE RESOLUTION (`1c.resolving`: an attempt whose activation outcome is unknown is being
 * resolved by `activate/cancel` and, where required, `current()`), the identity at that moment is recorded. The resolution may pass
 * through other gating cards (`1c.offline` while resolving offline, `1c.lock_wait`); it ends when the view next leaves the 1c family.
 * The attempt "didn't finish" exactly when, at that exit:
 *  - no newer settlement happened (the identity's epoch has not advanced past the one recorded), and
 *  - the view is one where nothing else explains the outcome: the outgoing account displays again, unchanged (`not_activated` while
 *    it was still valid), or the page is plainly signed out (`not_activated` with nobody settled). A fence (`1a.*`, `1b`, `1d`, `1e.*`),
 *    catching up (2, 3) or any other card says what happened itself, and gets no second message.
 *
 * Its triggers include an attempt begun in another tab or before a reload (T5, T8): the resolution is then this page's view of it,
 * and "That sign-in didn't finish" is still the truthful wording.
 *
 * A page that resolves its OWN indeterminate activation can do so before `1c.resolving` is ever published (the cancel and the identity read
 * complete between two evaluations, found in the real engines: E-L3). The controller therefore also says so: an attempt method that
 * answers `gating` ("indeterminate or verifying: resolution continues") calls `attemptEnd.indeterminate(before)` (`attempt-signal.ts`) with the identity
 * read before the attempt began. If the view is still in the 1c family that arms the watcher; if the resolution has already ended, that exit is
 * judged now. One resolution gives at most one message, whichever signal arrives first.
 */
type IndeterminateListener = (before: Identity | null) => void;
const inOneC = (state: NeutralStateId | null): boolean =>
  state?.startsWith("1c.") === true;

const stateOf = (view: SessionView): NeutralStateId | null =>
  view.kind === "signed_out" || view.kind === "neutral" ? view.state : null;

/**
 * A view that is not an outcome yet: the resolution is still settling. Found in the real engines (E-L3): between the attempt's resolution
 * and the page displaying its account again the view passes through `1e.checking` (the display's own check) and can flash state 3 (the
 * recovery job's report of the gate, withdrawn as soon as it finds nothing fenced, K-2). The exit is judged at the next view that says
 * what happened.
 */
const interim = (view: SessionView): boolean =>
  view.kind === "neutral" &&
  (view.state === "1e.checking" ||
    view.state === "1e.waiting" ||
    view.state === "2" ||
    view.state === "3");

/** Whether `view` is an exit after which "That sign-in didn't finish" is the honest account of the resolution. */
function endedExit(view: SessionView): boolean {
  if (view.kind === "displaying") return true;
  return view.kind === "signed_out" && view.state === null;
}

export interface AttemptEndSource {
  readonly view: Session["view"];
  readonly identity: Session["identity"];
}

export function watchAttemptEnd(
  session: AttemptEndSource,
  feedback: Pick<typeof authFeedback, "add"> = authFeedback,
): () => void {
  /** The identity when the indeterminate resolution began, or `undefined` while none is being watched. */
  let armedWith: Identity | null | undefined;
  let lastWasOneC = false;
  /** The last exit from the 1c family has been judged (with or without a message): a late `gating` signal adds nothing to it. */
  let lastExitJudged = false;

  const judge = (recorded: Identity | null, view: SessionView): void => {
    lastExitJudged = true;
    const now = session.identity.get();
    const advanced =
      now !== null && (recorded === null || now.epoch > recorded.epoch);
    if (advanced || !endedExit(view)) return;
    feedback.add({ kind: "ended" });
  };

  const check = (): void => {
    const view = session.view.get();
    const state = stateOf(view);
    const oneC = inOneC(state);
    if (state === "1c.resolving" && armedWith === undefined)
      armedWith = session.identity.get();
    if (oneC) {
      if (!lastWasOneC) lastExitJudged = false;
      lastWasOneC = true;
      return;
    }
    // A booting view, or one that is still settling, is not an exit that says anything; wait for the next one.
    if (!lastWasOneC || view.kind === "booting" || interim(view)) return;
    lastWasOneC = false;
    const recorded = armedWith;
    armedWith = undefined;
    if (recorded === undefined) return;
    judge(recorded, view);
  };

  const onIndeterminate: IndeterminateListener = (before) => {
    const view = session.view.get();
    if (inOneC(stateOf(view)) || (lastWasOneC && interim(view))) {
      armedWith ??= before;
      return;
    }
    if (view.kind === "booting" || lastExitJudged) return;
    judge(before, view);
  };
  const unlisten = attemptEnd.listen(onIndeterminate);

  const offs = [
    session.view.subscribe(check),
    session.identity.subscribe(check),
    unlisten,
  ];
  check();
  return () => {
    for (const off of offs) off();
  };
}

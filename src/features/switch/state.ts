import type { Message } from "../authentication/outcome-copy";

/**
 * The account switcher's place in the journey (WEB-08c), in PAGE MEMORY and bound to the account that was displaying when it opened.
 * It carries no secret: the stage, the chosen target (an account id and its own verified username, or "another account"), and at most
 * a closed message id for a refusal. Never a password.
 *
 * It is module state rather than component state because the journey must outlive the tree that asked: a switch unmounts the
 * outgoing account's tree at the incoming attempt's `activating` write, and a refusal that arrives afterwards (an activation
 * refused, a hidden tab) belongs to the outgoing account's tree when it renders again. The binding makes that safe: the flow is shown
 * ONLY while the account it was opened for is displayed, and is dropped as soon as a DIFFERENT account displays (`SwitchHost`), so no
 * picker or form of one account ever appears over another's.
 */
export type SwitchTarget =
  | { kind: "retained"; account_id: string; name: string | null }
  | { kind: "other" };

export type SwitchStage =
  | { stage: "closed" }
  | { stage: "picker"; owner: string }
  | {
      stage: "sign-in";
      owner: string;
      target: SwitchTarget;
      /** A refusal for the form to show once (it unmounts and remounts around an activation). */
      failure: Message | null;
    };

type Listener = () => void;
const listeners = new Set<Listener>();
let state: SwitchStage = { stage: "closed" };
/** The control that opened the flow, for focus to return to when it closes on the same tree. */
let returnFocus: HTMLElement | null = null;

/**
 * The sign-in this flow has submitted and not yet heard back from (WEB-08c, R1 of the review of 11 October 2026). Leaving the credential
 * step in any way (Cancel, Back, Escape or Close, another account displaying, signing out) ABORTS it, which cancels its attempt with the
 * session before it can activate ("no change made"). Its result, whenever it arrives, is applied only while it is still this journey.
 */
export interface SwitchJourney {
  readonly id: number;
  readonly owner: string;
  readonly signal: AbortSignal;
}
let journeys = 0;
let inflight: { journey: SwitchJourney; controller: AbortController } | null =
  null;
const abandon = (): void => {
  const current = inflight;
  inflight = null;
  current?.controller.abort();
};

const set = (next: SwitchStage): void => {
  state = next;
  for (const listener of [...listeners]) listener();
};

export const switchFlow = {
  get: (): SwitchStage => state,
  returnFocus: (): HTMLElement | null => returnFocus,
  /** Opens the picker for the account displaying now. */
  open(owner: string, trigger: HTMLElement | null): void {
    returnFocus = trigger;
    set({ stage: "picker", owner });
  },
  choose(owner: string, target: SwitchTarget): void {
    if (state.stage === "closed" || state.owner !== owner) return;
    abandon();
    set({ stage: "sign-in", owner, target, failure: null });
  },
  /** Back from WF-SWITCH-02 to the picker ("Cancel — stay as …"): a sign-in in flight is cancelled. */
  back(owner: string): void {
    if (state.stage !== "sign-in" || state.owner !== owner) return;
    abandon();
    set({ stage: "picker", owner });
  },
  /** A sign-in is submitted from the credential step: the journey whose signal cancels it. Null when the step is not this owner's. */
  submit(owner: string): SwitchJourney | null {
    if (state.stage !== "sign-in" || state.owner !== owner) return null;
    abandon();
    const controller = new AbortController();
    journeys += 1;
    const journey = { id: journeys, owner, signal: controller.signal };
    inflight = { journey, controller };
    return journey;
  },
  /**
   * The journey's sign-in has an outcome: true when it is still the flow's current journey (its result may be applied), false when the
   * person has left it (the result belongs to nobody and is dropped).
   */
  finish(journey: SwitchJourney): boolean {
    if (inflight?.journey !== journey) return false;
    inflight = null;
    return !journey.signal.aborted;
  },
  /** A refusal of THIS flow's sign-in, kept for the form (whichever mount of the tree shows it). */
  fail(owner: string, message: Message): void {
    if (state.stage !== "sign-in" || state.owner !== owner) return;
    set({ ...state, failure: message });
  },
  failureShown(owner: string): void {
    if (state.stage !== "sign-in" || state.owner !== owner) return;
    if (state.failure === null) return;
    set({ ...state, failure: null });
  },
  /** Escape, Close or signing out: the flow ends, and a sign-in in flight is cancelled. */
  close(): void {
    abandon();
    returnFocus = null;
    if (state.stage === "closed") return;
    set({ stage: "closed" });
  },
  /** A different account displays: what the previous one opened is no longer anyone's. (Signing out calls `close`.) */
  dropUnless(account: string): void {
    if (state.stage === "closed") return;
    if (state.owner === account) return;
    abandon();
    returnFocus = null;
    set({ stage: "closed" });
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

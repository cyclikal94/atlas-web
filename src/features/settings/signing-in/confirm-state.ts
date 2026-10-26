import type { Message } from "../../authentication/outcome-copy";

/**
 * "Confirm it's you" (WEB-08c, G-23) in PAGE MEMORY, bound to the account AND the epoch that were displaying when it opened (R1 and R3 of
 * the review of 11 October 2026). It carries no secret: whether the section is open, at most a closed message id for a refusal, and the
 * sign-in it has submitted and not yet heard back from.
 *
 * It is module state rather than component state because the confirmation must outlive the tree that asked: the attempt's `activating`
 * write closes the protected tree, and a refusal that arrives afterwards (device capacity, a hidden tab) belongs to the SAME session's
 * tree when it mounts again; component state died with the first mount, so the refusal was lost. The binding makes that safe: the
 * section is shown open only for the session it was opened for. A settlement makes a newer epoch (the confirmation succeeded: the return
 * destination takes over), and another account displaying is someone else, so neither shows what this one left.
 *
 * Cancel ABORTS the sign-in in flight, which cancels its attempt with the session before it can activate.
 */
export interface ConfirmOwner {
  readonly account: string;
  readonly epoch: number;
}
export interface ConfirmStage extends ConfirmOwner {
  readonly failure: Message | null;
}
export interface ConfirmJourney extends ConfirmOwner {
  readonly id: number;
  readonly signal: AbortSignal;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let stage: ConfirmStage | null = null;
let journeys = 0;
let inflight: { journey: ConfirmJourney; controller: AbortController } | null =
  null;

const same = (a: ConfirmOwner, b: ConfirmOwner): boolean =>
  a.account === b.account && a.epoch === b.epoch;
const set = (next: ConfirmStage | null): void => {
  stage = next;
  for (const listener of [...listeners]) listener();
};
const abandon = (): void => {
  const current = inflight;
  inflight = null;
  current?.controller.abort();
};

export const confirmFlow = {
  get: (): ConfirmStage | null => stage,
  /** The stage for the session displaying now, or null (a stage left by another session is not shown). */
  for(owner: ConfirmOwner | null): ConfirmStage | null {
    return owner !== null && stage !== null && same(stage, owner)
      ? stage
      : null;
  },
  open(owner: ConfirmOwner): void {
    abandon();
    set({ account: owner.account, epoch: owner.epoch, failure: null });
  },
  /** Cancel: the section closes and a sign-in in flight is cancelled. */
  cancel(): void {
    abandon();
    if (stage !== null) set(null);
  },
  /** A sign-in is submitted from the open section: the journey whose signal cancels it. Null when the section is not this session's. */
  submit(owner: ConfirmOwner): ConfirmJourney | null {
    if (stage === null || !same(stage, owner)) return null;
    abandon();
    const controller = new AbortController();
    journeys += 1;
    const journey = {
      id: journeys,
      account: owner.account,
      epoch: owner.epoch,
      signal: controller.signal,
    };
    inflight = { journey, controller };
    return journey;
  },
  /** The journey's sign-in has an outcome: true while it is still the current journey and was not cancelled. */
  finish(journey: ConfirmJourney): boolean {
    if (inflight?.journey !== journey) return false;
    inflight = null;
    return !journey.signal.aborted;
  },
  /** A refusal of the journey's sign-in, kept for whichever mount of the same session's tree shows it. */
  fail(journey: ConfirmJourney, message: Message): void {
    if (stage === null || !same(stage, journey)) return;
    set({ ...stage, failure: message });
  },
  failureShown(owner: ConfirmOwner): void {
    if (stage === null || !same(stage, owner) || stage.failure === null) return;
    set({ ...stage, failure: null });
  },
  /** A settlement or another account: what the earlier session opened is over. */
  dropUnless(owner: ConfirmOwner | null): void {
    if (stage === null || (owner !== null && same(stage, owner))) return;
    abandon();
    set(null);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

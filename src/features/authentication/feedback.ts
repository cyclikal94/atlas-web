import type { Message } from "./outcome-copy";

/**
 * Facts about a sign-in the person should be told once, kept in PAGE MEMORY (the session module's own notices are
 * durable-record facts; these are not). It carries no account data and no secret: a closed `kind`, and for a message the
 * closed `MessageId` of `outcome-copy.ts` and at most an Atlas `request_id`. The kernel's state machine is not involved:
 * the 1c notices (`superseded`, `lock_wait`) are raised by the callers of the attempt methods from their outcomes
 * (decision D-8b-03), with the accepted card wording.
 */
export type FeedbackBody =
  | { kind: "superseded" }
  | { kind: "lock_wait" }
  /** `info` is good news ("linked"); `problem` is something that did not work. */
  | { kind: "message"; tone: "info" | "problem"; message: Message };

export type FeedbackItem = FeedbackBody & { readonly id: number };

type Listener = () => void;
const listeners = new Set<Listener>();
let items: readonly FeedbackItem[] = [];
/**
 * The refusal of the last password sign-in, for the form to show. It lives HERE and not in the form because the form does not
 * outlive an activation: the session view changes to the neutral gate ("Finishing sign-in") between the exchange and the
 * activation, which unmounts the form, and a refusal that arrives afterwards belongs to the form that mounts next (review R1).
 * A closed message id and at most an Atlas request id; no secret, no account data. The form takes it when it shows it.
 */
let carried: Message | null = null;
let counter = 0;
const publish = () => {
  for (const listener of [...listeners]) listener();
};

const sameFact = (a: FeedbackBody, b: FeedbackBody): boolean =>
  a.kind === b.kind &&
  (a.kind !== "message" ||
    (b.kind === "message" &&
      a.tone === b.tone &&
      a.message.id === b.message.id &&
      a.message.requestId === b.message.requestId));

export const authFeedback = {
  get: (): readonly FeedbackItem[] => items,
  add(entry: FeedbackBody): void {
    // The same fact twice in a row is one fact.
    const last = items[items.length - 1];
    if (last && sameFact(last, entry)) return;
    counter += 1;
    items = [...items, { ...entry, id: counter }];
    publish();
  },
  dismiss(id: number): void {
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return;
    items = next;
    publish();
  },
  /** A new sign-in begins: whatever the last one left behind is no longer news. */
  clearOnBegin(): void {
    if (items.length === 0 && carried === null) return;
    items = [];
    carried = null;
    publish();
  },
  carryFailure(message: Message): void {
    carried = message;
    publish();
  },
  carriedFailure: (): Message | null => carried,
  /** The form shows the carried refusal (or an account displays and it is no longer news). */
  takeFailure(): void {
    if (carried === null) return;
    carried = null;
    publish();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

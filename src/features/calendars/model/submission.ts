import type { CalendarResult } from "./result";

/**
 * One online-only submission (Link a calendar…, Replace…, Remove…; WEB-13a, D-13a-7). A submission is a PAIR, `{key, body}`, pinned
 * per attempt: "Retry" resends exactly the same pair (so a save whose answer was lost is recognised by the server and not made
 * twice), and any edit of a field mints a new pair (a changed body under an old key would be a different operation).
 *
 * Held in the form's memory only, with the form's secrets: nothing here is persisted, and a reload starts again (Q22).
 */
export interface Attempt<B> {
  key: string;
  body: B;
}

export interface Submission<B> {
  /** The pair to send for `body`: the current one when nothing changed since it was minted, else a new one. */
  attempt(body: B): Attempt<B>;
  /** The current pair, for "Retry"; null before the first attempt or after an edit. */
  current(): Attempt<B> | null;
  /** A field was edited: the next attempt is a new operation. */
  invalidate(): void;
  /** The last answer to the current pair was uncertain (it may have been applied). */
  markUncertain(): void;
  /** Whether an attempt of the current pair has been uncertain. */
  readonly uncertain: boolean;
}

export function createSubmission<B>(mint: () => string): Submission<B> {
  let pair: Attempt<B> | null = null;
  let pairBody = "";
  let uncertain = false;
  return {
    attempt(body) {
      const text = JSON.stringify(body);
      if (pair === null || text !== pairBody) {
        pair = { key: mint(), body };
        pairBody = text;
        uncertain = false;
      }
      return pair;
    },
    current: () => pair,
    invalidate() {
      pair = null;
      pairBody = "";
      uncertain = false;
    },
    markUncertain() {
      if (pair !== null) uncertain = true;
    },
    get uncertain() {
      return uncertain;
    },
  };
}

/** What a submission's answer means to the open form. */
export type SubmissionOutcome =
  | { kind: "succeeded" }
  /** It may have been applied: offer Retry (the same pair), and Check once an earlier attempt of it was uncertain. */
  | { kind: "uncertain"; check: boolean }
  | {
      kind: "refused";
      reason:
        | "conflict"
        | "access"
        | "gone"
        | "unconfigured"
        | "fetch_failed"
        | "url_refused"
        | "url_not_allowed"
        | "invalid"
        | "other";
      requestId?: string;
    }
  | { kind: "not_sent" }
  | { kind: "offline" }
  | { kind: "closed" };

/**
 * A refusal that FOLLOWS an uncertain attempt of the same pair proves nothing about that attempt (§0.1): the backend validates a
 * connection (DNS, its outbound rules, a worker slot) BEFORE it looks the key up, so a retry of a committed Link or Replace can be
 * refused for the address or for capacity although the first attempt landed. Such an answer stays uncertain.
 */
const VALIDATION_BEFORE_RECEIPT: readonly string[] = [
  "fetch_failed",
  "invalid_endpoint",
  "outbound_denied",
  "temporarily_unavailable",
  "integration_unconfigured",
];

export function classifySubmission(
  answer: CalendarResult<{ revision: number }>,
  afterUncertain: boolean,
): SubmissionOutcome {
  if (answer.ok) return { kind: "succeeded" };
  switch (answer.kind) {
    case "uncertain":
      return { kind: "uncertain", check: afterUncertain };
    case "not_sent":
      return { kind: "not_sent" };
    case "offline":
      return { kind: "offline" };
    case "closed":
      return { kind: "closed" };
    case "refused":
      break;
  }
  const { status, code, requestId } = answer;
  const id = requestId === undefined ? {} : { requestId };
  if (afterUncertain && VALIDATION_BEFORE_RECEIPT.includes(code))
    return { kind: "uncertain", check: true };
  if (status === 503 && code === "integration_unconfigured")
    return { kind: "refused", reason: "unconfigured", ...id };
  // The address could not be fetched when the server validated it: nothing was committed by THIS attempt.
  if (status === 502 && code === "fetch_failed")
    return { kind: "refused", reason: "fetch_failed", ...id };
  if (status >= 500 || status === 429)
    return { kind: "uncertain", check: afterUncertain };
  if (status === 409 && code === "conflict")
    return { kind: "refused", reason: "conflict", ...id };
  if (status === 403) return { kind: "refused", reason: "access", ...id };
  if (status === 404) return { kind: "refused", reason: "gone", ...id };
  if (status === 422 && code === "invalid_endpoint")
    return { kind: "refused", reason: "url_refused", ...id };
  if (status === 422 && code === "outbound_denied")
    return { kind: "refused", reason: "url_not_allowed", ...id };
  if (status === 422) return { kind: "refused", reason: "invalid", ...id };
  return { kind: "refused", reason: "other", ...id };
}

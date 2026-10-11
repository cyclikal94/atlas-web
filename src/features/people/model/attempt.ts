import { type Attempt, canonicalBody, nextAttempt } from "../../sharing";

/**
 * One idempotent attempt per body for the people screens' ONLINE-ONLY commands (`rename_profile`, `unlink`, a shared field create;
 * WEB-11a §4.7, WEB-12a rule 5). PURE, and the same rule as the sharing editors' (`model/submission.ts`, reused, not copied):
 *
 *  - an attempt is `{ key, body }`; the body is the canonical JSON of what is sent;
 *  - after an UNCERTAIN outcome, "Try again" resends the SAME key with the byte-identical body (a committed command answers with its
 *    original receipt instead of being made twice);
 *  - any edit makes a new body and therefore a new key (safe: the body's `expected_version` makes a committed earlier one refuse it);
 *  - a Try again that was NOT SENT (offline, held, closed) leaves the uncertain attempt as it was;
 *  - a definite answer (a receipt or a refusal) ends the attempt.
 */
export type { Attempt };
export { canonicalBody };

/** The attempt to send `body`: the uncertain one again when it is for exactly this body, else a new one. */
export const attemptFor = (
  uncertain: Attempt | null,
  body: unknown,
  newKey: () => string,
): Attempt => nextAttempt(uncertain, body, newKey);

/** What remains uncertain after an outcome: kept after `uncertain` or a send that never happened, cleared by a definite answer. */
export function afterOutcome(
  sent: Attempt,
  previous: Attempt | null,
  outcome: "ok" | "refused" | "uncertain" | "not_sent",
): Attempt | null {
  switch (outcome) {
    case "uncertain":
      return sent;
    case "not_sent":
      return previous;
    case "ok":
    case "refused":
      return null;
  }
}

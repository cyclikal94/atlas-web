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

/** The `expected_version` the retained attempt's command was made against (null when its body has none). */
export function attemptVersion(attempt: Attempt): number | null {
  try {
    const version = (
      JSON.parse(attempt.body) as { command?: { expected_version?: unknown } }
    ).command?.expected_version;
    return typeof version === "number" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The retained uncertain attempt a press resolves (review 26, R26.1/R26.2), or null: it is resolved FIRST, before anything about the person
 * as read now is asked of a new command. It is the attempt when what was submitted is unchanged: `intent` made at the attempt's OWN
 * version is byte-identical to its body. Then it is sent again exactly (its key and body; a committed one answers with its receipt).
 * Nothing read since (a newer version, another linkage, a synced name) changes what it was, and nothing is rebuilt from it.
 */
export function replayFor(
  retained: Attempt | null,
  intent: (version: number) => unknown,
): Attempt | null {
  if (retained === null) return null;
  const version = attemptVersion(retained);
  return version !== null && canonicalBody(intent(version)) === retained.body
    ? retained
    : null;
}

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

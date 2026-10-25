/**
 * One idempotent attempt per body for an online-only task command (`enrol`, D-10a-7), the pattern of WEB-12a's D-12a-2. PURE.
 *
 * When the outcome is UNCERTAIN (a network error, a time-out, a `5xx`, an answer outside the contract) the command may have committed, so
 * "Try again" resends the SAME `Idempotency-Key` with the byte-identical body and a committed command answers with its original receipt.
 * Any edit starts a new attempt with a new key: the body's `expected_version` makes the server refuse it if the first one committed. A
 * definite answer ends the attempt.
 */
export interface Attempt {
  key: string;
  body: string;
}

/** Canonical JSON: object keys sorted, so one command has exactly one body. */
export function canonicalBody(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item as object).sort())
      sorted[key] = (item as Record<string, unknown>)[key];
    return sorted;
  });
}

export function nextAttempt(
  uncertain: Attempt | null,
  command: unknown,
  newKey: () => string,
): Attempt {
  const body = canonicalBody(command);
  if (uncertain !== null && uncertain.body === body) return uncertain;
  return { key: newKey(), body };
}

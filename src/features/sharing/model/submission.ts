/**
 * One idempotent attempt per body (D-12a-2). PURE.
 *
 * An online-only sharing command is sent with an `Idempotency-Key`. When its outcome is UNCERTAIN (a network error, a time-out, a `5xx`, a
 * `429`, an answer outside the contract) the command may have committed, so "Try again" resends the SAME key with the byte-identical body:
 * a committed command then returns its original receipt instead of being made twice. Any edit after an uncertain attempt starts a new
 * attempt with a new key; that is safe because the body's `expected_version` makes the server refuse it (`conflict`) if the first one did
 * commit. A definite answer (a receipt or a refusal) ends the attempt.
 */
export interface Attempt {
  key: string;
  /** The canonical JSON of the commands: what is sent, byte for byte. */
  body: string;
}

/** The canonical JSON of a value: object keys sorted, so one draft has exactly one body. */
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

/**
 * The attempt to send `commands`: the uncertain attempt again when it is for exactly this body, otherwise a new one under a fresh key.
 * `uncertain` is the attempt whose outcome is not known (null when there is none).
 */
export function nextAttempt(
  uncertain: Attempt | null,
  commands: unknown,
  newKey: () => string,
): Attempt {
  const body = canonicalBody(commands);
  if (uncertain !== null && uncertain.body === body) return uncertain;
  return { key: newKey(), body };
}

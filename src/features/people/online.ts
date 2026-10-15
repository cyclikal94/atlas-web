import type { PeopleResult } from "./api";
import type { PeopleEnv } from "./env";
import { isCurrentMemory } from "./memory";
import { type Attempt, afterOutcome, attemptFor } from "./model/attempt";

/** Whether a command's outcome means a request may have reached the server (anything but offline, not sent or closed). */
export const sentSomething = (result: {
  ok: boolean;
  kind?: string;
}): boolean =>
  result.ok ||
  (result.kind !== "offline" &&
    result.kind !== "not_sent" &&
    result.kind !== "closed");

/**
 * Sends ONE online-only people command (§4.7): the attempt for `body` is the uncertain one kept under `key` in the identity's page memory
 * when it is for the same body, else a new one; a `not_sent` is asked again quietly, a bounded number of times; afterwards the attempt is
 * kept only while its outcome is uncertain (a Try again resends the same key and byte-identical body). Admission is the caller's: online,
 * writable, not already sending.
 */
const NOT_SENT_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000];

export async function sendOnline<T>(
  env: PeopleEnv,
  key: string,
  body: unknown,
  send: (attempt: Attempt) => Promise<PeopleResult<T>>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PeopleResult<T>> {
  const memory = env.memory;
  const previous = memory.attempts.get(key) ?? null;
  const attempt = attemptFor(previous, body, env.newId);
  let result: PeopleResult<T>;
  for (let tries = 0; ; tries += 1) {
    result = await send(attempt);
    if (result.ok || result.kind !== "not_sent") break;
    const delay = NOT_SENT_DELAYS_MS[tries];
    if (delay === undefined || !isCurrentMemory(memory)) break;
    await sleep(delay);
  }
  if (!isCurrentMemory(memory)) return result;
  // A command was sent (whatever its answer said): the summaries shown are read again (finding 8: a receipt invalidates them).
  if (sentSomething(result)) memory.invalidateSummaries();
  const kept = afterOutcome(
    attempt,
    previous,
    result.ok
      ? "ok"
      : result.kind === "uncertain"
        ? "uncertain"
        : result.kind === "not_sent" ||
            result.kind === "offline" ||
            result.kind === "closed"
          ? "not_sent"
          : "refused",
  );
  if (kept === null) memory.attempts.delete(key);
  else memory.attempts.set(key, kept);
  memory.touch();
  return result;
}

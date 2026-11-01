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

type Send<T> = (attempt: Attempt) => Promise<PeopleResult<T>>;
type Sleep = (ms: number) => Promise<void>;
const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const sendOnline = <T>(
  env: PeopleEnv,
  key: string,
  body: unknown,
  send: Send<T>,
  sleep: Sleep = wait,
): Promise<PeopleResult<T>> =>
  sendAttempt(
    env,
    key,
    attemptFor(env.memory.attempts.get(key) ?? null, body, env.newId),
    send,
    sleep,
  );

/**
 * Sends the retained uncertain attempt again EXACTLY (review 26): its key and its body, never a new key or a body built from what is read
 * now (`replayFor` chose it). Its outcome settles it like any other: a receipt or a refusal ends it, uncertainty keeps it.
 */
export const replayOnline = <T>(
  env: PeopleEnv,
  key: string,
  attempt: Attempt,
  send: Send<T>,
  sleep: Sleep = wait,
): Promise<PeopleResult<T>> => sendAttempt(env, key, attempt, send, sleep);

async function sendAttempt<T>(
  env: PeopleEnv,
  key: string,
  attempt: Attempt,
  send: Send<T>,
  sleep: Sleep,
): Promise<PeopleResult<T>> {
  const memory = env.memory;
  const previous = memory.attempts.get(key) ?? null;
  let result: PeopleResult<T>;
  for (let tries = 0; ; tries += 1) {
    result = await send(attempt);
    if (result.ok || result.kind !== "not_sent") break;
    const delay = NOT_SENT_DELAYS_MS[tries];
    if (delay === undefined || !isCurrentMemory(memory)) break;
    await sleep(delay);
    // Nothing more is sent for an identity that ended during the wait (review 26, DA26-08).
    if (!isCurrentMemory(memory)) break;
  }
  if (!isCurrentMemory(memory)) return result;
  // A command was sent (whatever its answer said): the summaries shown are read again (finding 8: a receipt invalidates them).
  if (sentSomething(result)) memory.invalidateSummaries();
  // Only while the target's attempt is still the one this send began on: a later send's outcome is never overwritten by this one's.
  if ((memory.attempts.get(key) ?? null) === previous) {
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
  }
  memory.touch();
  return result;
}

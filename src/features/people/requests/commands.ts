import type { CommandAttempt, PeopleFailure, PeopleResult } from "../api";
import type { PeopleEnv } from "../env";
import { admit, isPending, settle } from "../lifetime";
import { isCurrentMemory, type RequestReport } from "../memory";
import { replayOnline, sendOnline } from "../online";
import * as copy from "./copy";

/**
 * WEB-11b's online-only commands (§4.7, WEB-11a's rules reused, not copied): `request_link`, `request_merge`, `merge`, `respond_request`
 * and `cancel_request`, one per `/people-commands` call, never queued.
 *
 *  - ONE attempt key per target (§3.4): `request-link:<person>`, `merge:<source>:<target>` (both `merge` and `request_merge`: one per
 *    pair, whichever dialog route shows it), `respond:<request>` (Accept and Decline share it: one answer per request) and
 *    `cancel:<request>`.
 *  - A RETAINED uncertain attempt is resolved FIRST: while one is kept under the key, the only thing a press of that key sends is that
 *    attempt again, EXACTLY (its key and its byte-identical body; a committed one answers with its original receipt). Nothing is rebuilt
 *    from what is read now (a newer preview's token, another recipient), and no other command is sent under the key until a definite
 *    answer ends it. A different answer to a request whose earlier answer is uncertain is refused (`ANSWER_UNCERTAIN_FIRST`).
 *  - ADMISSION is taken synchronously at the press, before anything is awaited (`lifetime.ts` `admit`): while a command of the key runs,
 *    no other is admitted, whichever mount presses, and every mount shows it sending (`isPending`).
 *  - Every press is judged on what the page knows AT THE PRESS (`prepare` runs then, and answers null to send nothing).
 *  - `not_sent` is asked again quietly a bounded number of times (`sendOnline`); a command that was sent invalidates every summary and
 *    request read of the identity (`online.ts`), so the lists, previews and linkage are read again.
 *  - An identity change mid-flight writes into a memory nobody reads; nothing shows or sends under the new identity.
 */
export type Receipt = { revision: number; person_id: string };

/** Whether an uncertain attempt is kept under `key` (its row or dialog offers Try again). */
export const retainedUnder = (env: PeopleEnv, key: string): boolean =>
  env.memory.attempts.has(key);

/** Whether a command of `key` runs now (on any mount). */
export const sendingUnder = (env: PeopleEnv, key: string): boolean =>
  isPending(env.memory, key);

/**
 * Sends the command of `key`: the retained uncertain attempt again exactly, else the body `prepare()` makes (null: nothing is sent).
 * Admission is taken FIRST, synchronously at the press; `prepare` is then called in the same turn (it judges what the page knows at the
 * press) and may answer later (the recipient re-verification of D-11b-11 is a read). Answers null when nothing was sent (another send of
 * the key runs, the identity changed, or `prepare` refused).
 */
export async function runCommand(
  env: PeopleEnv,
  key: string,
  prepare: () => unknown | null | Promise<unknown | null>,
): Promise<PeopleResult<Receipt> | null> {
  const memory = env.memory;
  if (!isCurrentMemory(memory)) return null;
  const retained = memory.attempts.get(key) ?? null;
  const admission = admit(memory, [key], env.newId);
  if (admission === null) return null;
  const send = (attempt: CommandAttempt) => env.api.peopleCommand(attempt);
  try {
    const prepared = retained === null ? prepare() : null;
    const body = prepared instanceof Promise ? await prepared : prepared;
    if (retained === null && (body === null || !isCurrentMemory(memory)))
      return null;
    memory.requestReports.delete(key);
    memory.touch();
    return retained !== null
      ? await replayOnline(env, key, retained, send)
      : await sendOnline(env, key, body, send);
  } finally {
    settle(admission);
  }
}

/** What a request command's answer says to the row or dialog that shows its key now (D-11b-9), and keeps it for a later mount. */
export function reportOutcome(
  env: PeopleEnv,
  key: string,
  result: PeopleResult<unknown>,
  explain: (failure: PeopleFailure) => string | null,
): void {
  const memory = env.memory;
  if (!isCurrentMemory(memory) || result.ok) return;
  const text = explain(result);
  if (text === null) return;
  const report: RequestReport = {
    text,
    ...("requestId" in result && result.requestId
      ? { requestId: result.requestId }
      : {}),
    ...(result.kind === "uncertain" ? { uncertain: true } : {}),
  };
  memory.requestReports.set(key, report);
  memory.touch();
}

/** The report kept under `key` (null: none). */
export const reportUnder = (
  env: PeopleEnv,
  key: string,
): RequestReport | null => env.memory.requestReports.get(key) ?? null;

/** The copy every command shares for an outcome no command explains itself (D-11b-9). */
export function commonFailure(failure: PeopleFailure): string | null {
  switch (failure.kind) {
    case "uncertain":
      return copy.UNCERTAIN;
    case "offline":
    case "not_sent":
      return `${copy.NEEDS_CONNECTION}.`;
    case "closed":
      return null;
    case "operation_conflict":
      return copy.OPERATION_CONFLICT;
    case "forbidden":
      return copy.FORBIDDEN;
    case "invalid":
    case "identity_grant_required":
      return copy.INVALID;
    case "not_found":
    case "expired":
      return copy.ANSWERED_ELSEWHERE;
    case "conflict":
      return copy.COMPARISON_CHANGED;
    case "capacity":
      return copy.CAPACITY(copy.THE_OTHER_OWNER);
  }
}

/**
 * Why a press of `key` cannot send now, or null: read-only compatibility, no connection, a send of the key running. A retained uncertain
 * attempt needs only the connection (it is sent again as it was).
 */
export function blockedReason(env: PeopleEnv, key: string): string | null {
  if (!env.writable) return copy.READ_ONLY_COMPAT;
  if (!env.online) return copy.NEEDS_CONNECTION;
  if (sendingUnder(env, key)) return copy.SAVING;
  return null;
}

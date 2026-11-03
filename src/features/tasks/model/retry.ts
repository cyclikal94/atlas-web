import type { MaterialiseRetry } from "../../../data";
import type { RetryFacts } from "../api";

/**
 * The catch-up's retry protocol (revision 10, Decision B; WEB-04 §5.11). PURE: each of its three callers (the discovery read, the
 * `materialise` command and the position read after a successful command) keeps its own durable schedule in W27 (`MaterialiseRetry`), and
 * every transmission, answer and reset is decided here; the runner persists what this returns BEFORE it transmits.
 *
 * - A recognised transient answer (`500 internal_error`, `503 temporarily_unavailable`), no answer, a `429` and an unrecognised COMMAND
 *   answer are retried within a sustained-failure window of `WINDOW_MS` from the episode's first failure, after `DELAYS_MS` (1, 2, 4, 8,
 *   16, then 30 s each). Nothing is transmitted at or after the window's end: the caller pauses (`window`). An issued call that answers
 *   later is recorded, never resent or called failed because the clock moved.
 * - A `429`'s valid `Retry-After` is a minimum: the next transmission is no earlier than the later of it and the back-off, whoever asks
 *   (a reset included); one beyond the window pauses.
 * - An unrecognised READ answer also counts in its own streak (`unknown`): the third pauses the caller (`unrecognised`) for the person's
 *   Try again only. A recognised transient answer does not end it; only the caller's own success or the person's reset does.
 * - A `window` pause resumes on the person's Try again or an observed reconnection; no other pause resumes by itself.
 * - A clock that went back before the last time written, or a time that is not a time, pauses (`clock`) rather than granting a window.
 */
export const WINDOW_MS = 180_000;
export const DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];
export const MAX_UNRECOGNISED = 3;

export type Caller = MaterialiseRetry["caller"];
export type Pause = NonNullable<MaterialiseRetry["pause"]>;
export type Schedule = MaterialiseRetry;

const time = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const count = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * A stored schedule as the protocol reads it: `null` none (no failure or issue outstanding), the schedule, or `"invalid"` (a value this
 * build cannot trust: never a fresh budget).
 */
export function readSchedule(
  value: unknown,
  caller: Caller,
): Schedule | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return "invalid";
  const s = value as Partial<Schedule>;
  const nullableTime = (n: unknown) => n === null || time(n);
  return s.v === 1 &&
    s.caller === caller &&
    nullableTime(s.issued) &&
    nullableTime(s.since) &&
    count(s.failures) &&
    time(s.next) &&
    nullableTime(s.server) &&
    count(s.unknown) &&
    time(s.seen) &&
    [null, "transient", "transport", "rate_limited", "unrecognised"].includes(
      s.cause as string,
    ) &&
    [null, "window", "unrecognised", "clock", "legacy"].includes(
      s.pause as string,
    )
    ? (s as Schedule)
    : "invalid";
}

const fresh = (caller: Caller, now: number): Schedule => ({
  v: 1,
  caller,
  issued: null,
  since: null,
  failures: 0,
  next: 0,
  server: null,
  cause: null,
  unknown: 0,
  seen: now,
  pause: null,
});

/** A schedule that admits nothing automatic (an untrusted clock, a record of an earlier build), keeping what it counted. */
export const paused = (
  s: Schedule | null,
  caller: Caller,
  pause: Pause,
  now: number,
): Schedule => ({
  ...(s ?? fresh(caller, time(now) ? now : 0)),
  issued: null,
  pause,
  ...(time(now) ? { seen: Math.max(now, s?.seen ?? 0) } : {}),
});

/** What may happen at `now`: transmit, wait until `at`, or pause (the window ended, or the clock cannot be trusted). */
export type Gate =
  | { kind: "now" }
  | { kind: "wait"; at: number }
  | { kind: "pause"; pause: Pause };

export function gate(s: Schedule | null, now: number): Gate {
  if (!time(now)) return { kind: "pause", pause: "clock" };
  if (s === null) return { kind: "now" };
  if (s.pause !== null) return { kind: "pause", pause: s.pause };
  if (now < s.seen) return { kind: "pause", pause: "clock" };
  if (s.since !== null && now >= s.since + WINDOW_MS)
    return { kind: "pause", pause: "window" };
  const at = Math.max(s.next, s.server ?? 0);
  return now < at ? { kind: "wait", at } : { kind: "now" };
}

/** The transmission admitted at `now`, written BEFORE it is made. */
export const issue = (
  s: Schedule | null,
  caller: Caller,
  now: number,
): Schedule => ({ ...(s ?? fresh(caller, now)), issued: now, seen: now });

/** A transmission that was not made after all (the session held it, offline): nothing is counted. */
export const withdrawn = (s: Schedule): Schedule | null =>
  s.since === null && s.server === null && s.unknown === 0
    ? null
    : { ...s, issued: null };

/**
 * A failed transmission observed at `now` (`read`: the caller is a read, so an unrecognised answer counts in its streak). The episode
 * starts at its first failure; the next transmission is paced from this one, never before a server deadline; past the window, or at the
 * third unrecognised read, the caller pauses.
 */
export function failed(
  s: Schedule | null,
  caller: Caller,
  facts: RetryFacts | undefined,
  now: number,
  read: boolean,
): Schedule {
  const base = s ?? fresh(caller, now);
  if (!time(now) || now < base.seen) return paused(base, caller, "clock", now);
  const cause = facts?.cause ?? "unrecognised";
  const failures = base.failures + 1;
  const since = base.since ?? now;
  const unknown =
    read && cause === "unrecognised" ? base.unknown + 1 : base.unknown;
  const after =
    cause === "rate_limited" &&
    facts?.afterMs !== undefined &&
    Number.isSafeInteger(facts.afterMs) &&
    facts.afterMs >= 0
      ? now + facts.afterMs
      : null;
  // A still-future deadline of an earlier answer is kept (a later answer without one does not cancel it).
  const server =
    Math.max(
      after ?? 0,
      base.server !== null && base.server > now ? base.server : 0,
    ) || null;
  const next = Math.max(
    now + (DELAYS_MS[Math.min(failures, DELAYS_MS.length) - 1] as number),
    server ?? 0,
  );
  return {
    v: 1,
    caller,
    issued: null,
    since,
    failures,
    next,
    server,
    cause,
    unknown,
    seen: now,
    pause:
      unknown >= MAX_UNRECOGNISED
        ? "unrecognised"
        : next >= since + WINDOW_MS || !Number.isSafeInteger(next)
          ? "window"
          : null,
  };
}

/**
 * A transmission whose answer was never recorded (a reload, another tab's turn, an answer dropped): counted as lost, observed when it was
 * issued, so the window is never restarted from the reload.
 */
export const unanswered = (s: Schedule, caller: Caller): Schedule =>
  failed(
    { ...s, issued: null },
    caller,
    { cause: "transport" },
    s.issued as number,
    false,
  );

/**
 * Revision 17 (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json): a transmission whose
 * transport failure a page OBSERVED (its lost-answer fence stands) but whose record no page holds, REDISCOVERED at `now` by the page that
 * found the fence: counted as one transport failure observed at `now`, not at its issue, so the next transmission is paced from the
 * rediscovery. The failure was observed no later than `now`, so this is never sooner than the back-off from the real observation would
 * have allowed (the wait may be longer: accepted). The episode's window is taken from its issue when none had begun (no later than its real
 * first failure, so the window never ends later than it would have). A server minimum still ahead is kept; a clock before the schedule's
 * last time pauses (`clock`), as `failed` does.
 */
export const rediscovered = (
  s: Schedule,
  caller: Caller,
  now: number,
): Schedule =>
  failed(
    { ...s, issued: null, since: s.since ?? s.issued },
    caller,
    { cause: "transport" },
    now,
    false,
  );

/**
 * Revision 17 (review 18's R36-K): the schedule shows its caller's last call answered and counted: nothing issued is outstanding, and a
 * failure (or a pause) is recorded. A lost-answer fence over such a record guards nothing any more (its call was recorded by its own
 * page before that page went, or rediscovered by another).
 */
export const counted = (s: Schedule | null): s is Schedule =>
  s !== null && s.issued === null && (s.failures > 0 || s.pause !== null);

/**
 * Revision 18 (review 19's R36-L; design assessment C1): the schedule of a caller its retry protocol PAUSED on a lost call, as a lost
 * call's outcome (`failed` with `transport`, its own page's) or its rediscovery (`rediscovered`) leaves it: nothing issued is outstanding,
 * and the pause is the window's after a recorded transport failure, or the clock's (`failed` pauses an untrusted clock BEFORE it counts,
 * so a clock pause may show no failure and an earlier cause, even none). An unrecognised streak's pause, a record of an earlier build
 * (`legacy`) and an untrusted schedule are never so. A lost-answer fence over such a stop guards nothing: the stop records the call, and
 * what goes on from it is the person's Try again or an observed reconnection (`reset`), which keeps only a server minimum and the
 * unrecognised streak, both of RECEIVED answers, never anything of a lost call. The stop itself stays.
 */
export const lostPause = (s: Schedule | null | "invalid"): s is Schedule =>
  s !== null &&
  s !== "invalid" &&
  s.issued === null &&
  (s.pause === "clock" ||
    (s.pause === "window" && s.cause === "transport" && s.failures > 0));

/**
 * A reset of a paused caller at `now`: the person's Try again (`manual`: a new episode, its unrecognised streak ended) or an observed
 * reconnection (only a `window` pause; the streak is kept). A still-future server deadline is kept either way. `null`: nothing remains.
 */
export function reset(
  s: Schedule | null,
  now: number,
  manual: boolean,
): Schedule | null {
  if (s === null) return null;
  const server =
    s.server !== null && time(now) && s.server > now ? s.server : null;
  const unknown = manual ? 0 : s.unknown;
  if (server === null && unknown === 0) return null;
  return {
    ...fresh(s.caller, time(now) ? Math.max(now, manual ? 0 : s.seen) : s.seen),
    next: server ?? 0,
    server,
    unknown,
  };
}

/** A pause an observed reconnection may lift. */
export const resumable = (s: Schedule | null | "invalid") =>
  s !== null && s !== "invalid" && s.pause === "window";

import { DATA_CONFIG, type DataConfig } from "./config";
import type { DraftRow, ReadRetryState } from "./types";

/**
 * The retry classes this slice owns, as PURE reducers (plan 5.6): they take `now` as an argument and read no clock. Four of the
 * seven retry classes of reconciliation.md live here:
 *
 *  1. network or 5xx on a DRAFT SUBMISSION (`drafts.retry_state`, `attempts`);
 *  2. network or 5xx on a READ (`sync_state.read_retry_states[caller]`);
 *  3. UNRECOGNISED responses on a non-`/sync` read (the twin of 2, `unrecognised_streak`);
 *  4. LOCAL WRITE failure that is not a quota (`sync_state.local_write_streaks[operation]`).
 *
 * The three recovery-scoped classes (a cursor-less `/sync` failure, a current-cursor failure, the whole-attempt budget) are
 * WEB-09b's, and nothing in `src/data` writes them. `not_sent`, `not_covered`, `closed*`, `stale` and `auth_state` increment
 * NONE of these: they never reach a reducer.
 *
 * A back-off is DURATION-based: after `retrySustainedMs` of continuous failure the passive "still trying" becomes an actionable
 * "Retry now"; it never retries silently forever. The clock is durable (`since`), so a reload does not restart it.
 */
export type RetryConfig = Pick<
  DataConfig,
  | "backoffInitialMs"
  | "backoffMaxMs"
  | "backoffJitter"
  | "retrySustainedMs"
  | "unrecognisedPauseAfter"
  | "localWritePauseAfter"
>;

/**
 * The statuses of the network/5xx class of a READ (retry classes 2 and 3 of reconciliation.md, contract-hygiene item 3): the WHOLE
 * `5xx` family, whichever gateway or server answered, and `429`. There is deliberately no status-specific branch: a `502` or a `504`
 * is an outage like a `500` or a `503`. A capacity outcome that is specified by its code (`503` `device_capacity`) is decided before
 * this, from the body.
 */
export const isFailureStatus = (status: number): boolean =>
  status >= 500 || status === 429;

/** Capped exponential back-off: 2 s doubling to 60 s, with +/- 20 % jitter. `random` is in [0, 1). */
export function nextDelay(
  failures: number,
  random: number,
  config: RetryConfig = DATA_CONFIG,
): number {
  const exponent = Math.max(0, failures - 1);
  const base = Math.min(
    config.backoffMaxMs,
    config.backoffInitialMs * 2 ** Math.min(exponent, 20),
  );
  const spread = 1 + config.backoffJitter * (2 * random - 1);
  return Math.max(0, Math.round(base * spread));
}

// ---- (1) a draft submission ------------------------------------------------------------------------------------------------
export type DraftRetry = NonNullable<DraftRow["retry_state"]>;

/** A counted failure of an issued request (network error, time-out, abort, 5xx, 429, an unrecognised answer). */
export function onDraftFailure(
  retry: DraftRetry | null,
  now: number,
  config: RetryConfig = DATA_CONFIG,
): DraftRetry {
  if (retry === null) return { state: "backing_off", since: now };
  if (retry.state === "paused") return retry;
  return now - retry.since >= config.retrySustainedMs
    ? { state: "paused", since: retry.since }
    : retry;
}

/** The only things that resume a paused draft: the browser coming back online, or an explicit "Retry now" for it. */
export const onDraftResume = (): null => null;

/** True while the passive indicator is warranted: a sustained failure shows "Retry now"; a short one shows nothing. */
export function draftIsSustained(
  retry: DraftRetry | null,
  now: number,
  config: RetryConfig = DATA_CONFIG,
): boolean {
  return (
    retry !== null &&
    (retry.state === "paused" || now - retry.since >= config.retrySustainedMs)
  );
}

// ---- (2) and (3): a read caller -----------------------------------------------------------------------------------------------
export const initialReadRetry = (): ReadRetryState => ({
  backing_off_since: null,
  paused: false,
  unrecognised_streak: 0,
});

/** Network or 5xx on a read. Pauses after the sustained duration; never touches the unrecognised streak. */
export function onReadFailure(
  state: ReadRetryState,
  now: number,
  config: RetryConfig = DATA_CONFIG,
): ReadRetryState {
  if (state.paused) return state;
  const since = state.backing_off_since ?? now;
  return {
    ...state,
    backing_off_since: since,
    paused: now - since >= config.retrySustainedMs,
  };
}

/** That caller's own success: resets that caller's back-off and its unrecognised streak, and nothing else. */
export const onReadSuccess = (): ReadRetryState => initialReadRetry();

/** An unrecognised answer: three consecutive pause THAT caller (never `/sync`'s "can't proceed" state). */
export function onUnrecognised(
  state: ReadRetryState,
  config: RetryConfig = DATA_CONFIG,
): ReadRetryState {
  const streak = state.unrecognised_streak + 1;
  return {
    ...state,
    unrecognised_streak: streak,
    paused: state.paused || streak >= config.unrecognisedPauseAfter,
  };
}

/** `online`, or the caller's own "Retry now": resume. An unrelated caller's success and the passage of time do NOT. */
export function onOnline(): ReadRetryState {
  return initialReadRetry();
}
export const onRetryNow = onOnline;

/**
 * `online` for ONE caller: the browser is reachable again, so a duration-based back-off or pause ends. It does not end a pause that
 * three unrecognised answers caused (that is not a connectivity problem; only the caller's own "Retry now" leaves it), and it has
 * nothing to end when the caller is neither backing off nor paused. `null`: nothing changes.
 */
export function resumeOnOnline(
  state: ReadRetryState,
  config: Pick<RetryConfig, "unrecognisedPauseAfter"> = DATA_CONFIG,
): ReadRetryState | null {
  if (!state.paused && state.backing_off_since === null) return null;
  if (state.unrecognised_streak >= config.unrecognisedPauseAfter) return null;
  return onOnline();
}

/**
 * What a caller's entry holds once it has taken in what another record already knew (a page's memory, before its database was
 * open): the earlier start of a continuous failure, a pause either record has, the longer streak. Neither record loses anything the
 * other knew, and a caller that has never failed stays at its initial state.
 */
export function mergeReadRetry(
  a: ReadRetryState,
  b: ReadRetryState,
): ReadRetryState {
  const since =
    a.backing_off_since === null
      ? b.backing_off_since
      : b.backing_off_since === null
        ? a.backing_off_since
        : Math.min(a.backing_off_since, b.backing_off_since);
  return {
    backing_off_since: since,
    paused: a.paused || b.paused,
    unrecognised_streak: Math.max(a.unrecognised_streak, b.unrecognised_streak),
  };
}

/** Whether two records say the same thing. */
export const sameReadRetry = (a: ReadRetryState, b: ReadRetryState): boolean =>
  a.backing_off_since === b.backing_off_since &&
  a.paused === b.paused &&
  a.unrecognised_streak === b.unrecognised_streak;

/** True for the state every caller starts in, and returns to after its own success. */
export const isInitialReadRetry = (state: ReadRetryState): boolean =>
  state.backing_off_since === null &&
  !state.paused &&
  state.unrecognised_streak === 0;

// ---- (4) a local write failure ---------------------------------------------------------------------------------------------
/**
 * Keyed by operation identity (`draft:<local_id>`, `page:<expectedPosition>`, `receipt:<local_id>`), NEVER by kind: a different
 * operation's success must not reset this operation's streak.
 */
export type WriteStreaks = Record<string, number>;

export function onLocalWriteFailure(
  streaks: WriteStreaks,
  operation: string,
  config: RetryConfig = DATA_CONFIG,
): { streaks: WriteStreaks; stop: boolean } {
  const next = (streaks[operation] ?? 0) + 1;
  return {
    streaks: { ...streaks, [operation]: next },
    stop: next >= config.localWritePauseAfter,
  };
}

/**
 * The identity of the local WRITE of an admitted invalidation at a delta position: `invalidate:<cursor>` (R10, revision 8). A failure of
 * `data.invalidateCache` is counted under it, three consecutive ones stop it, and the capture gate enforces it exactly as it does a
 * page's operation (`page:<cursor>`). It is keyed apart from the page's own because the two mean different things: a cache that is
 * KNOWN to be invalid (the server said so) is hidden while its write is outstanding, whereas a page that merely failed to commit leaves
 * the cache the one it was, and visible.
 */
export const INVALIDATE_PREFIX = "invalidate:";
export const invalidateOperation = (cursor: string | null): string =>
  `${INVALIDATE_PREFIX}${cursor ?? ""}`;

/**
 * The row's local-write failure state: the streaks and, beside them, the version of the failure each stands for (R53, revision 32).
 * A streak says HOW MANY consecutive failures; its version says WHICH, so that a reset that was decided on an earlier look cannot end a
 * failure recorded after it.
 */
export interface WriteFailures {
  local_write_streaks: WriteStreaks;
  local_write_versions?: Record<string, number>;
  local_write_seq?: number;
}

/**
 * The version of the failure that stands under `operation`, or `null` when none does (no streak). A streak that has no version (a row
 * written before versions, or a streak planted by a test) is version 0, which no failure counted since is.
 */
export function failureVersion(
  failures: WriteFailures,
  operation: string,
): number | null {
  return (failures.local_write_streaks[operation] ?? 0) > 0
    ? (failures.local_write_versions?.[operation] ?? 0)
    : null;
}

/**
 * One failure of `operation`, counted: its streak grows, and it takes the next version of the row (the number is unique for the life of
 * the row, so a count that comes back to an earlier value after a reset is not the earlier failure). The versions of operations that
 * no longer have a streak are dropped here, so the record is as large as the streaks are.
 */
export function recordWriteFailure(
  failures: WriteFailures,
  operation: string,
  config: RetryConfig = DATA_CONFIG,
): {
  patch: Required<WriteFailures>;
  streak: number;
  stop: boolean;
  version: number;
} {
  const failed = onLocalWriteFailure(
    failures.local_write_streaks,
    operation,
    config,
  );
  const seq = (failures.local_write_seq ?? 0) + 1;
  const versions: Record<string, number> = {};
  for (const [other, version] of Object.entries(
    failures.local_write_versions ?? {},
  ))
    if (other !== operation && other in failed.streaks)
      versions[other] = version;
  versions[operation] = seq;
  return {
    patch: {
      local_write_streaks: failed.streaks,
      local_write_versions: versions,
      local_write_seq: seq,
    },
    streak: failed.streaks[operation] ?? 0,
    stop: failed.stop,
    version: seq,
  };
}

/**
 * The reset of `operation`'s failure state that was decided when the failure at version `expect` was the one that stood (`null`: none
 * did). It ends that failure and no other: when a newer failure stands (a version other than the one seen) NOTHING is changed and the
 * answer says so (`cleared: false`). Equal counts are not equal failures, so the comparison is on the version alone.
 */
export function resetWriteFailure(
  failures: WriteFailures,
  operation: string,
  expect: number | null,
): {
  patch: Pick<
    WriteFailures,
    "local_write_streaks" | "local_write_versions"
  > | null;
  cleared: boolean;
  version: number | null;
} {
  const version = failureVersion(failures, operation);
  if (version === null) return { patch: null, cleared: true, version };
  if (version !== expect) return { patch: null, cleared: false, version };
  const { [operation]: _version, ...versions } =
    failures.local_write_versions ?? {};
  return {
    patch: {
      local_write_streaks: onLocalWriteSuccess(
        failures.local_write_streaks,
        operation,
      ),
      local_write_versions: versions,
    },
    cleared: true,
    version,
  };
}

/** That operation's next success clears that operation's streak only. */
export function onLocalWriteSuccess(
  streaks: WriteStreaks,
  operation: string,
): WriteStreaks {
  if (!(operation in streaks)) return streaks;
  const { [operation]: _removed, ...rest } = streaks;
  return rest;
}

/**
 * The outbox's operation identities (R46 and R47, revision 26). A draft's local writes are two operations: `draft:<local_id>` (the
 * save, its edit, its supersession, its discard, and the claim that marks it in flight) and `receipt:<local_id>` (the writes that
 * record what happened to a request). The dispatcher's own read of the queue is the one operation without a draft, `queue`.
 *
 * The identity is matched EXACTLY, by the id the operation names: never by a suffix, a prefix or a pattern over the string (the id is
 * a caller-supplied string, so `draft:ba` must never answer to `a`, and an id may hold any character).
 */
export const DRAFT_OPERATION_PREFIX = "draft:";
export const RECEIPT_OPERATION_PREFIX = "receipt:";
export const QUEUE_OPERATION = "queue";

/** The two operations of one draft: what its own success, its explicit abandonment or its "Try again" retires, and nothing else. */
export const draftOperations = (localId: string): [string, string] => [
  `${DRAFT_OPERATION_PREFIX}${localId}`,
  `${RECEIPT_OPERATION_PREFIX}${localId}`,
];

/** The draft an operation names (`draft:<id>` or `receipt:<id>`), or `null` for any other operation (`queue`, `page:…`, `capture`). */
export function operationDraft(operation: string): string | null {
  for (const prefix of [DRAFT_OPERATION_PREFIX, RECEIPT_OPERATION_PREFIX])
    if (operation.startsWith(prefix) && operation.length > prefix.length)
      return operation.slice(prefix.length);
  return null;
}

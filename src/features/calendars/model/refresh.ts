import type { CalendarResult, LiveSource, LiveSources } from "./result";

/**
 * The manual refresh (WEB-13a, D-13a-6), as PURE functions: what an answer means (`classifyRefresh`) and what happens next
 * (`refreshStep`). The controller (`refresh-controller.ts`) only performs the effects this decides.
 *
 * One press is ONE operation with ONE `Idempotency-Key`: every automatic retry of it, and "Check again", reuses the key; only a new
 * press mints a new one. Automatic retries are bounded and only for what may recover (B8): a refresh still running elsewhere, a
 * transient failure, and one retry after a lease that expired with nothing newer running. They stop when the page goes offline, the
 * screen unmounts or the identity changes, and NOTHING resumes on reconnect: a refresh is never queued (Q22).
 *
 * Health is never evidence. A `200` is success whatever `health` says; a `502` stays a failure whatever `health` says (7(d)). The
 * only live signal used is the read-time `refresh_in_progress` of `GET /calendar-sources` (B8 item 4), after a `409 stale_refresh`.
 * It is evidence only for a source the read actually returned: a source the bounded walk did not reach, or a list without it, says
 * nothing, so it permits no retry and finishes nothing (R9). A newer refresh we waited for is finished only when a later read shows
 * the result it wrote (`finishedSince`): the flag turning false alone is also what a lease that lapsed with no completing write, or
 * a settings change that cleared it, looks like.
 */

/** Same-key retries after `409 refresh_in_progress`: 65 s in all, longer than the server's 60 s lease. */
export const IN_PROGRESS_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 20_000, 30_000,
];
/** Same-key retries after a transient failure (cause 2, a `5xx`, a busy server, the network). */
export const TRANSIENT_DELAYS_MS: readonly number[] = [10_000, 30_000];
/** While a newer refresh runs (causes 4 and 5): the live list is read again at this pace, for at most `SUCCESSOR_LIMIT_MS`. */
export const SUCCESSOR_POLL_MS = 5_000;
export const SUCCESSOR_LIMIT_MS = 75_000;

/** The parse refusals of a feed (`422`): the provider's calendar, not a failure of the request. */
export const FEED_CODES: readonly string[] = [
  "invalid_ics",
  "unsupported_calendar_rule",
  "unsupported_calendar_timezone",
  "calendar_limit",
];

export type RefreshClass =
  | { kind: "succeeded" }
  /** `409 refresh_in_progress`: uncertain (our own attempt, or another, holds the lease). */
  | { kind: "in_progress" }
  /** Cause 4: `409 stale_refresh` `generation_changed` (or a reason this client does not know). */
  | { kind: "superseded" }
  /** Cause 5: `409 stale_refresh` `lease_expired`. */
  | { kind: "lease_expired" }
  /** Cause 2: `502 fetch_failed`. */
  | { kind: "fetch_failed" }
  /** Cause 1: `422 connection_unavailable`. */
  | { kind: "connection_unavailable" }
  /** Cause 3: `503 integration_unconfigured`. */
  | { kind: "unconfigured" }
  /** Cause 6a: `422 invalid_value` (the source is turned off). */
  | { kind: "turned_off" }
  /** Cause 6b: `403`/`404` with an Atlas body. */
  | { kind: "unavailable" }
  | { kind: "feed_unreadable"; code: string }
  /** `500`, `503 temporarily_unavailable` (CH3, 7(f)), `429`, the network, an abort, a `4xx` without an Atlas body. */
  | { kind: "transient" }
  /** An Atlas refusal this client has no meaning for (`409 operation_conflict`, a `400`): never resent. */
  | { kind: "unconfirmed" }
  | { kind: "not_sent" }
  | { kind: "offline" }
  | { kind: "closed" };

export function classifyRefresh(
  answer: CalendarResult<{ revision: number }>,
): RefreshClass {
  if (answer.ok) return { kind: "succeeded" };
  switch (answer.kind) {
    case "offline":
      return { kind: "offline" };
    case "closed":
      return { kind: "closed" };
    case "not_sent":
      return { kind: "not_sent" };
    case "uncertain":
      return { kind: "transient" };
    case "refused":
      break;
  }
  const { status, code } = answer;
  if (status === 409 && code === "refresh_in_progress")
    return { kind: "in_progress" };
  if (status === 409 && code === "stale_refresh")
    return answer.reason === "lease_expired"
      ? { kind: "lease_expired" }
      : { kind: "superseded" };
  if (status === 502 && code === "fetch_failed")
    return { kind: "fetch_failed" };
  if (status === 422 && code === "connection_unavailable")
    return { kind: "connection_unavailable" };
  if (status === 503 && code === "integration_unconfigured")
    return { kind: "unconfigured" };
  if (status === 422 && code === "invalid_value") return { kind: "turned_off" };
  if (status === 403 || status === 404) return { kind: "unavailable" };
  if (status === 422 && FEED_CODES.includes(code))
    return { kind: "feed_unreadable", code };
  if (status >= 500 || status === 429) return { kind: "transient" };
  return { kind: "unconfirmed" };
}

/** What the row shows. */
export type RefreshView =
  | { kind: "refreshing" }
  | { kind: "succeeded" }
  /** The in-progress retries ran out: "Check again" resumes with the SAME key. */
  | { kind: "still_refreshing" }
  | {
      kind: "failed";
      cause: Exclude<
        RefreshClass["kind"],
        "succeeded" | "in_progress" | "offline" | "closed"
      >;
      code?: string;
    }
  /** A newer refresh ran while ours was superseded: ITS result, from the live list (never a reinterpretation of ours). */
  | { kind: "successor_finished"; health: string | null }
  /** A newer refresh we waited for stopped holding its lease, but no read showed that it wrote a result (or the source was gone). */
  | { kind: "successor_unconfirmed" }
  | { kind: "needs_connection" };

export interface RefreshRun {
  key: string;
  /** Automatic retries made after `in_progress`. */
  inProgress: number;
  /** Automatic retries made after a transient failure. */
  transient: number;
  /** Whether the one retry after `lease_expired` was made. */
  leaseRetried: boolean;
  /** The cause a live read is checking for, or null. */
  checking: "superseded" | "lease_expired" | null;
  /** How long a newer refresh has been waited for. */
  waitedMs: number;
  /**
   * The source as the FIRST live read that found a newer refresh running returned it, or null while none was seen. A later read can
   * only show that refresh finished by differing from this (`finishedSince`).
   */
  seen: SeenSource | null;
  view: RefreshView | null;
  /** Whether the run has ended (nothing more is sent or read). */
  ended: boolean;
}

/** What a live read said about the source, kept to compare with a later read. */
export interface SeenSource {
  health: string | null;
  lastSuccess: number | null;
}

/**
 * Whether `now` shows a refresh that finished after `seen` was read. The server writes a refresh's result in the same transaction that
 * releases its lease: a success advances `last_success` (and says `healthy`); a failure records its cause in `health`. A settings
 * change writes `pending`, and a lease that lapses writes nothing. So only an advanced `last_success`, or a new health other than
 * `pending`, is a result; anything else (the same values, or `pending`) is not known to be one.
 */
export function finishedSince(seen: SeenSource, now: LiveSource): boolean {
  if (
    now.lastSuccess !== null &&
    (seen.lastSuccess === null || now.lastSuccess > seen.lastSuccess)
  )
    return true;
  return (
    now.health !== null &&
    now.health !== "pending" &&
    now.health !== seen.health
  );
}

export type RefreshEvent =
  | { type: "answer"; answer: CalendarResult<{ revision: number }> }
  | { type: "live"; id: string; result: CalendarResult<LiveSources> }
  | { type: "offline" };

export type RefreshEffect =
  | { type: "send" }
  | { type: "live" }
  | { type: "wait"; ms: number; after: "send" | "live" }
  | { type: "stop" };

export function startRefresh(key: string): {
  run: RefreshRun;
  effect: RefreshEffect;
} {
  return {
    run: {
      key,
      inProgress: 0,
      transient: 0,
      leaseRetried: false,
      checking: null,
      waitedMs: 0,
      seen: null,
      view: { kind: "refreshing" },
      ended: false,
    },
    effect: { type: "send" },
  };
}

const end = (
  run: RefreshRun,
  view: RefreshView | null,
): { run: RefreshRun; effect: RefreshEffect } => ({
  run: { ...run, view, ended: true, checking: null },
  effect: { type: "stop" },
});

export function refreshStep(
  run: RefreshRun,
  event: RefreshEvent,
): { run: RefreshRun; effect: RefreshEffect } {
  if (run.ended) return { run, effect: { type: "stop" } };
  if (event.type === "offline") return end(run, { kind: "needs_connection" });
  if (event.type === "live") return liveStep(run, event);
  const result = classifyRefresh(event.answer);
  switch (result.kind) {
    case "succeeded":
      return end(run, { kind: "succeeded" });
    case "offline":
      return end(run, { kind: "needs_connection" });
    case "closed":
      return end(run, null);
    case "in_progress": {
      const delay = IN_PROGRESS_DELAYS_MS[run.inProgress];
      if (delay === undefined) return end(run, { kind: "still_refreshing" });
      return {
        run: {
          ...run,
          inProgress: run.inProgress + 1,
          view: { kind: "refreshing" },
        },
        effect: { type: "wait", ms: delay, after: "send" },
      };
    }
    case "fetch_failed":
    case "transient": {
      const delay = TRANSIENT_DELAYS_MS[run.transient];
      if (delay === undefined)
        return end(run, { kind: "failed", cause: result.kind });
      return {
        run: {
          ...run,
          transient: run.transient + 1,
          view: { kind: "refreshing" },
        },
        effect: { type: "wait", ms: delay, after: "send" },
      };
    }
    case "superseded":
      return {
        run: { ...run, checking: "superseded", waitedMs: 0, seen: null },
        effect: { type: "live" },
      };
    case "lease_expired":
      if (run.leaseRetried)
        return end(run, { kind: "failed", cause: "lease_expired" });
      return {
        run: { ...run, checking: "lease_expired", waitedMs: 0, seen: null },
        effect: { type: "live" },
      };
    case "feed_unreadable":
      return end(run, {
        kind: "failed",
        cause: "feed_unreadable",
        code: result.code,
      });
    default:
      return end(run, { kind: "failed", cause: result.kind });
  }
}

function liveStep(
  run: RefreshRun,
  event: Extract<RefreshEvent, { type: "live" }>,
): { run: RefreshRun; effect: RefreshEffect } {
  const checking = run.checking;
  if (checking === null) return { run, effect: { type: "stop" } };
  const result = event.result;
  if (!result.ok) {
    if (result.kind === "offline")
      return end(run, { kind: "needs_connection" });
    if (result.kind === "closed") return end(run, null);
    // The live read could not say whether anything is running: no automatic retry, the cause's own copy.
    return end(run, { kind: "failed", cause: checking });
  }
  const entry = result.value.sources.get(event.id);
  if (entry?.refreshInProgress === true) {
    // A newer refresh holds the lease: wait for ITS result (B8 item 4), bounded.
    if (run.waitedMs >= SUCCESSOR_LIMIT_MS)
      return end(run, { kind: "still_refreshing" });
    return {
      run: {
        ...run,
        waitedMs: run.waitedMs + SUCCESSOR_POLL_MS,
        seen: run.seen ?? {
          health: entry.health,
          lastSuccess: entry.lastSuccess,
        },
        view: { kind: "refreshing" },
      },
      effect: { type: "wait", ms: SUCCESSOR_POLL_MS, after: "live" },
    };
  }
  if (run.seen !== null)
    // We waited for a newer refresh and it no longer holds the lease. ITS outcome is shown only when this read shows the result it
    // wrote; a source this read did not return, or one that changed in no way a result does, is not known to have finished.
    return end(
      run,
      entry !== undefined && finishedSince(run.seen, entry)
        ? { kind: "successor_finished", health: entry.health }
        : { kind: "successor_unconfirmed" },
    );
  if (entry === undefined)
    // The read did not return this source (the bounded walk stopped before it, or the list no longer has it): whether anything is
    // running is unknown, exactly as when the read fails. No automatic retry, the cause's own copy.
    return end(run, { kind: "failed", cause: checking });
  if (checking === "lease_expired")
    // Nothing else is running: ONE retry, under the same key (a fresh attempt and a fresh lease on the server).
    return {
      run: {
        ...run,
        leaseRetried: true,
        checking: null,
        view: { kind: "refreshing" },
      },
      effect: { type: "send" },
    };
  // Cause 4 with nothing running: an ordinary stale answer. No automatic retry against settings that may just have changed.
  return end(run, { kind: "failed", cause: "superseded" });
}

/**
 * What a direct calendar request came to (WEB-13a). Classified once, at the client (`api.ts`), so the models never see a Response:
 *
 *  - `refused`: the server answered with an Atlas error body (`code`, and for `409 stale_refresh` its `reason`): a decision.
 *  - `uncertain`: it may or may not have been applied (a network error, an abort or time-out, a `5xx` or `429` without a decision, a
 *    `4xx` without an Atlas body, a `200` whose body is not the contract's). Recovered by the SAME key, never by a new one.
 *  - `not_sent`: the session did not put it on the wire (a hold that lasted the bounded wait): nothing to recover.
 *  - `offline`: not attempted (no connection).
 *  - `closed`: the session closed or moved to another identity while it ran (`auth_state`, `closed`, `stale`): show nothing new.
 *    `unsent` (revision 5) when the session refused it before its send boundary (its cover was closed), so nothing reached the
 *    server; a caller that declined its own admission knows that by itself.
 */
export type CalendarFailure =
  | {
      kind: "refused";
      status: number;
      code: string;
      reason?: "generation_changed" | "lease_expired" | string;
      requestId?: string;
    }
  | { kind: "uncertain"; status?: number; requestId?: string }
  | { kind: "not_sent" }
  | { kind: "offline" }
  | { kind: "closed"; unsent?: true };

export type CalendarResult<T> =
  | { ok: true; value: T }
  | ({ ok: false } & CalendarFailure);

/** One source as the LIVE list says it now (memory only, never persisted). */
export interface LiveSource {
  refreshInProgress: boolean;
  health: string | null;
  /** `last_success` (unix seconds), or null when the source has none (or the value does not say). */
  lastSuccess: number | null;
}

/** The live list: `complete` is false when the bounded walk stopped before its end (an absent id is then unknown, not gone). */
export interface LiveSources {
  sources: ReadonlyMap<string, LiveSource>;
  complete: boolean;
}

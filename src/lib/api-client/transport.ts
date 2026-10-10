/**
 * The shapes the send boundary and the unstamped surface exchange with the session kernel. They live here, in the
 * api-client, because `src/lib/api-client` never imports `src/session` (plan 5.2); the session's `ports/transport.ts` re-exports
 * them as the ports the kernel is written against.
 */
import type { AtlasError } from "./problem";

/** One stamped request that has passed its cover and is about to cross the send boundary. */
export interface IssueStep {
  readonly request: Request;
  /** True: send `X-Atlas-Session: 1` and no CSRF header (SA-01). */
  readonly identityRead: boolean;
  /** Null only for an identity read. */
  readonly csrf: string | null;
  /** The 30 s request time-out combined with the caller's signal. */
  readonly signal: AbortSignal;
  /** cancelled || callerAborted || (ordinary/recovery && (hold for the account || page.closing > 0)) */
  refuses(): boolean;
  /** state := ISSUED; remove from page.unsent. */
  markIssued(): void;
  /** No-op for verification and operation requests. */
  releaseIssueLock(): void;
}

export interface IssueTransport {
  /**
   * THE SEND BOUNDARY (boundary.ts): guard, issue and release in ONE synchronous function. Null means refused: the
   * issue lock was released in the same step and nothing was sent.
   */
  issue(step: IssueStep): Promise<Response> | null;
}

export interface RawAnswer {
  status: number;
  contentType: string | null;
  json: unknown | undefined;
  atlasError: AtlasError | null;
}

/** The small unstamped surface: login-family exchanges, the invitation preview, activate, activate/cancel and /health. */
export interface UnstampedApi {
  exchange(
    path: "/browser-sessions" | "/browser-registration" | "/oidc/start",
    body: unknown,
    signal: AbortSignal,
  ): Promise<RawAnswer>;
  /** `POST /registration/preview`: the invitation token travels in the body, never in a URL. */
  preview(body: { token: string }, signal: AbortSignal): Promise<RawAnswer>;
  activate(
    body: { grant: string; verifier: string },
    signal: AbortSignal,
  ): Promise<RawAnswer>;
  cancel(body: { verifier: string }, signal: AbortSignal): Promise<RawAnswer>;
  health(signal: AbortSignal): Promise<RawAnswer>;
}

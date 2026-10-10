import type { Result } from "../../../session";

/**
 * Whether the answer to a credential change (a password change, an unlink) leaves what happened UNKNOWN (review R6).
 *
 * Only an answer that proves the backend did not commit is a refusal: a `4xx`, the same rule as the sign-in exchange's own
 * (`classifyActivation`, matrix 3.4 step 5). Every other answer that is not a success cannot prove it. A request that never
 * got an answer (`offline`) obviously cannot, and neither can a `5xx`: a gateway can answer `502` or `504` AFTER the backend
 * committed and revoked the session, and a backend that fails while it commits can answer `500` or `503` for a change that went
 * through. HTTP gives the client no way to tell which. Both end in the screen's unconfirmed state, which asks the person to
 * check where things stand and never retries (the change may be done, and the session needed to retry it may be gone).
 *
 * The operations read only the status (the body is discarded: docs/session.md), so a status is all there is to classify. A
 * session that ended (`auth_state`, `closed`) and a request that was not sent are not unknown outcomes and are handled apart.
 */
export function leavesOutcomeUnknown(result: Result<unknown>): boolean {
  if (result.ok) return false;
  if (result.error === "offline") return true;
  if (result.error !== "http") return false;
  const { status } = result;
  return status === undefined || status < 400 || status >= 500;
}

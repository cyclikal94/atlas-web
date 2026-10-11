import type { Result } from "../../../session";

/**
 * After a change request (signing out another session, retiring another device): whether the server may have applied it although
 * no success was confirmed — the connection failed after sending, the server answered with an error that is not a refusal (5xx), or
 * the call threw. Such an outcome reads the lists again, as naming does (NAME_UNCONFIRMED). A definite refusal (4xx), `not_sent`
 * (nothing was sent), `closed` and `auth_state` (the identity moved on; the tree is going) changed nothing this screen should show.
 */
export const outcomeUnknown = (result: Result<unknown> | null): boolean =>
  result === null ||
  (!result.ok &&
    (result.error === "offline" ||
      (result.error === "http" &&
        (result.status === undefined ||
          result.status < 400 ||
          result.status >= 500))));

/**
 * WEB-08d (review R1): whether the lists must be read again after a change request, whoever is still looking. A confirmed answer
 * (`gone` included: the server says so now) or an outcome nobody can confirm; never `not_sent`, a definite refusal, `closed` or
 * `auth_state`. Retirement's `rejected_stale` is a definite refusal and its caller says so.
 */
export const mayHaveChanged = (result: Result<unknown> | null): boolean =>
  result?.ok === true || outcomeUnknown(result);

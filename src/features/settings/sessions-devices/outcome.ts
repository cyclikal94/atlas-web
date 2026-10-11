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

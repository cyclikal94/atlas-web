import type { Session } from "../../session";
import { StampedRequestError } from "../../session";
import type { ReadResult } from "../engine/identity-task";
import {
  parseAccountIdentity,
  parseCurrentDeviceId,
} from "../model/identity-bodies";
import { isFailureStatus } from "../model/retry";
import { parseSharingSnapshot } from "../model/sharing-snapshot";
import type { AccountId, Epoch } from "../model/types";

/**
 * The production adapters of the two identity reads over the session: `GET /me` (the verified profile) and `GET /sessions` (the
 * device mirror). They CLASSIFY what happened, because the retry budget (plan 5.6) treats the classes differently and a bare `null`
 * would make every one of them the same retry: a transport failure, a time-out, a `5xx` and a `429` are the network/5xx class;
 * any other status, or a `200` that is not the contract's body, is an unrecognised answer; a request the session did not send, or
 * an answer it dropped as no longer this identity's, counts nothing and is asked again only a few times; a request the session
 * closed (`closed`, `closed_unresolved`, `auth_state`) is not asked again until something changes.
 */

/** A status that is a failure of the network or the server (`5xx`, `429`, `408`) rather than an answer outside the contract. */
export function classifyStatus(status: number): "failure" | "unrecognised" {
  return isFailureStatus(status) || status === 408 ? "failure" : "unrecognised";
}

/** What the session's closed set of protocol outcomes means for the budget; anything else is the platform's own error. */
export function classifyFailure(
  error: unknown,
): Exclude<ReadResult<never>, { kind: "ok" }> {
  if (error instanceof StampedRequestError) {
    switch (error.kind) {
      case "not_sent":
      case "not_covered":
      case "stale":
        return { kind: "not_sent" };
      case "closed":
      case "closed_unresolved":
      case "auth_state":
        return { kind: "closed" };
    }
  }
  // The body of a successful answer that is not JSON at all is not the contract's answer either.
  if (error instanceof SyntaxError) return { kind: "unrecognised" };
  // A network error, an abort or the stamped request's time-out.
  return { kind: "failure" };
}

export function readMeThrough(
  session: Session,
): (account: AccountId, epoch: Epoch) => Promise<ReadResult<unknown>> {
  return async (account, epoch) => {
    try {
      const { data, response } = await session.api
        .client("ordinary", account, epoch)
        .GET("/me");
      if (response.ok) {
        // A `200` is not yet the contract's answer: the body must be this account's profile (`id`, and a `username` that is a string).
        // TypeScript's response type is not validation.
        return parseAccountIdentity(data, account) === null
          ? { kind: "unrecognised" }
          : { kind: "ok", value: data };
      }
      return { kind: classifyStatus(response.status) };
    } catch (error) {
      return classifyFailure(error);
    }
  };
}

export function currentDeviceThrough(
  session: Session,
): () => Promise<ReadResult<string>> {
  return async () => {
    try {
      const result = await session.operations.listSessions();
      if (result.ok) {
        // The list must be the contract's (rows that are objects with a boolean `current`), with exactly one current row whose
        // `device_id` is a non-empty string: anything else is an unrecognised answer, never a verified device.
        const deviceId = parseCurrentDeviceId(result.value.sessions);
        return deviceId === null
          ? { kind: "unrecognised" }
          : { kind: "ok", value: deviceId };
      }
      switch (result.error) {
        case "offline":
          return { kind: "failure" };
        case "http":
          return { kind: classifyStatus(result.status ?? 0) };
        case "not_sent":
          return { kind: "not_sent" };
        case "auth_state":
        case "closed":
          return { kind: "closed" };
      }
    } catch (error) {
      return classifyFailure(error);
    }
  };
}

/**
 * `GET /defaults/snapshot` (B5, WEB-12a), classified like `GET /me`: a `200` whose body is not the contract's snapshot is an
 * unrecognised answer, never a value. The account's own sharing defaults, read through the stamped client for `(account, epoch)`.
 */
export function readDefaultsSnapshotThrough(
  session: Session,
): (account: AccountId, epoch: Epoch) => Promise<ReadResult<unknown>> {
  return async (account, epoch) => {
    try {
      const { data, response } = await session.api
        .client("ordinary", account, epoch)
        .GET("/defaults/snapshot");
      if (!response.ok) {
        const kind = classifyStatus(response.status);
        return { kind };
      }
      return parseSharingSnapshot(data) === null
        ? { kind: "unrecognised" }
        : { kind: "ok", value: data };
    } catch (error) {
      return classifyFailure(error);
    }
  };
}

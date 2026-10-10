import type { AccountId } from "./types";

/**
 * The runtime check of the two identity bodies this slice reads (plan 5.8). A TypeScript response type is not validation: a `200`
 * whose body is not the contract's is an UNRECOGNISED answer (reconciliation.md: a non-`/sync` status or response-shape outcome is
 * counted and, three in a row, pauses that caller), and it is never a verification. Pure.
 */

/** The longest label this client will take from `GET /me`. */
export const USERNAME_MAX = 200;

/**
 * `GET /me` (`AccountIdentity`): `id` is the account this request was stamped for and `username` is a short, non-empty string. The
 * label is the trimmed `username`; anything else is not a profile (a missing or mistyped `username`, another account's `id`).
 */
export function parseAccountIdentity(
  body: unknown,
  account: AccountId,
): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { id, username } = body as { id?: unknown; username?: unknown };
  if (id !== account) return null;
  if (typeof username !== "string") return null;
  const trimmed = username.trim();
  return trimmed.length > 0 && trimmed.length <= USERNAME_MAX ? trimmed : null;
}

/**
 * `GET /sessions` (`Sessions`): the `device_id` of the one row whose `current` is `true`. The whole list must be the contract's
 * (an array of objects whose `current` is a boolean), exactly one row must say it is the current session, and its `device_id` must be
 * a non-empty string. A list that is not an array, a row that is not an object, a `current` that is merely truthy, no current row,
 * two current rows or a `device_id` that is missing, null or not a string is not an answer to verify a device with: `null`.
 */
export function parseCurrentDeviceId(sessions: unknown): string | null {
  if (!Array.isArray(sessions)) return null;
  let current: { device_id?: unknown } | null = null;
  for (const row of sessions as unknown[]) {
    if (typeof row !== "object" || row === null) return null;
    const flag = (row as { current?: unknown }).current;
    if (typeof flag !== "boolean") return null;
    if (flag) {
      if (current !== null) return null;
      current = row as { device_id?: unknown };
    }
  }
  const deviceId = current?.device_id;
  return typeof deviceId === "string" && deviceId.trim().length > 0
    ? deviceId
    : null;
}

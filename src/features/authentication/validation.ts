/**
 * What the forms check before anything is sent. The server enforces the same rules; these checks only spare the person a
 * round trip (and an attempt counted against a throttle) for a value that cannot be valid. Nothing here is trimmed or
 * normalised except the username's surrounding whitespace, and a password is never trimmed.
 */

/** A password's length is in BYTES (`input.password.len()` on the server), not characters. */
export const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).length;

export const USERNAME_MAX = 100;
export const PASSWORD_MIN_BYTES = 12;
export const PASSWORD_MAX_BYTES = 1024;
/** `^[a-z0-9_.-]+$` in the contract's registration schema. Sign-in constrains only the length. */
const USERNAME_PATTERN = /^[a-z0-9_.-]+$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export type FieldReason =
  | "username_empty"
  | "username_chars"
  | "username_long"
  | "password_empty"
  | "password_short"
  | "password_long";

export const FIELD_MESSAGE: Readonly<Record<FieldReason, string>> = {
  username_empty: "Enter your username.",
  username_chars:
    "Use lowercase letters, numbers, dots, dashes and underscores.",
  username_long: "Use 100 characters or fewer.",
  password_empty: "Enter your password.",
  password_short: "Use at least 12 characters.",
  password_long: "That password is too long.",
};

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: FieldReason };

/** Sign-in: any non-empty username up to 100 characters (the login schema constrains nothing else). */
export function checkSignInUsername(raw: string): Result<string> {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: "username_empty" };
  if ([...value].length > USERNAME_MAX)
    return { ok: false, reason: "username_long" };
  return { ok: true, value };
}

/** Registration: 1 to 100 characters of `[a-z0-9_.-]`. */
export function checkNewUsername(raw: string): Result<string> {
  const base = checkSignInUsername(raw);
  if (!base.ok) return base;
  if (!USERNAME_PATTERN.test(base.value))
    return { ok: false, reason: "username_chars" };
  return base;
}

/** A password that is typed to prove who you are: present and within the server's ceiling. Never trimmed. */
export function checkCurrentPassword(value: string): Result<string> {
  if (value.length === 0) return { ok: false, reason: "password_empty" };
  if (utf8Length(value) > PASSWORD_MAX_BYTES)
    return { ok: false, reason: "password_long" };
  return { ok: true, value };
}

/** A password that is being chosen: 12 to 1,024 BYTES. Never trimmed. */
export function checkNewPassword(value: string): Result<string> {
  const bytes = utf8Length(value);
  if (bytes < PASSWORD_MIN_BYTES)
    return { ok: false, reason: "password_short" };
  if (bytes > PASSWORD_MAX_BYTES) return { ok: false, reason: "password_long" };
  return { ok: true, value };
}

/**
 * Linking and unlinking single sign-on need a session created within the last five minutes. The page cannot know the
 * server's clock, so a 30 s margin keeps the control honest at the edge; a skewed clock can still reach the server's own
 * refusal, which fails closed (docs/session.md, gap G-23).
 */
export const FRESH_WINDOW_MS = 5 * 60_000;
export const FRESH_MARGIN_MS = 30_000;
/** The first instant (epoch ms) at which a session created at `createdAtIso` is no longer fresh, or null for an unreadable time. */
export function freshUntil(createdAtIso: string): number | null {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return null;
  return created + FRESH_WINDOW_MS - FRESH_MARGIN_MS;
}
export function isFresh(createdAtIso: string, nowMs: number): boolean {
  const until = freshUntil(createdAtIso);
  return until !== null && nowMs < until;
}

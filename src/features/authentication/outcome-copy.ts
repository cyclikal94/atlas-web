import { NEUTRAL_COPY } from "../../components/ui/neutral-state";

/**
 * Every message the public surfaces and the Settings forms show about an exchange, in ONE closed catalogue. A component
 * never renders text from a server: an Atlas error picks a message id here by its `code` and, at most, appends its
 * `request_id`. Provenance of each string is marked: [W] the accepted wireframe (verbatim), [D] an accepted Claude Design
 * board (verbatim), [P] provisional, written for WEB-08b because no accepted text exists (design gaps G-14 to G-24 in
 * docs/session.md; Kieran's copy acceptance is open for every [P]).
 */
export type MessageId =
  // --- sign-in and shared ---
  | "bad_credentials" // [P]
  | "rate_limited" // [P]
  | "check_details" // [P]
  | "wrong_origin" // [P]
  | "not_set_up" // [P]
  | "device_capacity" // [P]
  | "temporarily_unavailable" // [P]
  | "unreachable" // [P]
  | "hidden_tab" // [P]
  | "busy_window" // [P]
  | "interrupted" // [P]
  | "wipe_pending" // [P]
  | "storage_unavailable" // [P]
  | "generic" // [P]
  | "activation_refused" // [P]
  // --- registration ---
  | "username_taken" // [P]
  | "invitation_unavailable" // [W] adapted (G-22)
  // --- single sign-on ---
  | "sso_not_set_up" // [P]
  | "sso_unavailable" // [P]
  | "sso_link_needs_recent_sign_in" // [P]
  | "sso_landing_invalid" // [P]
  | "sso_landing_failed" // [P]
  | "sso_linked" // [P]
  // --- Settings: password and linked accounts ---
  | "unlink_refused" // [W]
  | "unconfirmed" // [D]
  | "still_unconfirmed"; // [P]

export const MESSAGE_TEXT: Readonly<Record<MessageId, string>> = {
  bad_credentials: "That username or password isn't right.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  check_details: "Check the details and try again.",
  wrong_origin:
    "This server doesn't accept sign-in from this address. Ask whoever runs it to check its public address.",
  not_set_up: "Browser sign-in isn't set up on this server.",
  device_capacity:
    "This device has too many active sign-ins for this account. End one from Settings in another session, or try again later.",
  temporarily_unavailable:
    "Atlas is temporarily unavailable. Try again shortly.",
  unreachable: "We couldn't reach Atlas. Check your connection and try again.",
  hidden_tab: "Sign-in was paused because this tab was hidden. Try again.",
  busy_window: "Another window is busy. Try again in a moment.",
  interrupted: "Something interrupted sign-in. Try again.",
  wipe_pending:
    "Atlas is still clearing earlier data from this device. Try again shortly.",
  storage_unavailable:
    "This browser wouldn't let Atlas save what it needs to sign you in.",
  generic: "Something went wrong. Try again.",
  activation_refused:
    "Your details were right, but this browser couldn't finish signing in. Try again.",
  username_taken: "That username is taken. Choose another.",
  invitation_unavailable:
    "This invitation has expired or was already used. Ask whoever invited you for a new one.",
  sso_not_set_up: "Single sign-on isn't set up on this server.",
  sso_unavailable:
    "The single sign-on provider isn't available right now. Try again shortly.",
  sso_link_needs_recent_sign_in:
    "Linking single sign-on needs a sign-in from the last few minutes. Sign out and in again, then try once more.",
  sso_landing_invalid: "That sign-in link wasn't valid. Start again.",
  sso_landing_failed: "That single sign-on attempt didn't finish. Start again.",
  sso_linked: "Single sign-on is now linked to your account.",
  unlink_refused:
    "Can't remove this identity: removing a single sign-on link requires a session created within the last five minutes and a local password already on the account, so your last login method is never removed. Log in again if your session isn't fresh enough. If this account has never had a local password, there is no self-service way to add one — ask an operator to set one via account recovery first.",
  unconfirmed:
    "We couldn't confirm that. Sign in again to see where things stand — Atlas won't retry it for you.",
  // After "Check now" found the session still working: that is NOT evidence the earlier request failed (it may still be queued
  // or executing), so the copy says the outcome is still unknown and what will happen if it does arrive.
  still_unconfirmed:
    "You're still signed in, but that doesn't show whether it went through. It may still be on its way — if it is, you'll be asked to sign in again.",
};

export interface Message {
  readonly id: MessageId;
  /** From the Atlas error body when there was one. */
  readonly requestId?: string;
}

export const textOf = (message: Message): string =>
  message.requestId
    ? `${MESSAGE_TEXT[message.id]} Request ID: ${message.requestId}`
    : MESSAGE_TEXT[message.id];

export type Context = "sign_in" | "register" | "sso";

/** What the person's own field the message belongs to, so focus and `aria-describedby` can follow it. */
export type MessageField = "username" | "password" | null;
export const fieldOf = (id: MessageId): MessageField =>
  id === "bad_credentials"
    ? "password"
    : id === "username_taken"
      ? "username"
      : null;

export interface ErrorShape {
  readonly code?: string;
  readonly request_id?: string;
}

/**
 * An Atlas error from an EXCHANGE (the login, the registration, the OIDC start) by its code. The contract's real codes are
 * `unauthenticated`, `forbidden`, `credential_mismatch`, `not_found`, `conflict`, `invalid_value`, `malformed_request`,
 * `rate_limited`, `device_capacity`, `oidc_unavailable`, `temporarily_unavailable` and `internal_error`; anything else is
 * `generic`.
 */
export function messageForError(context: Context, error: ErrorShape): Message {
  const requestId = error.request_id;
  const pick = (id: MessageId): Message =>
    requestId ? { id, requestId } : { id };
  switch (error.code) {
    case "unauthenticated":
      // The same 401 means "wrong password" to a login, "expired or used" to a registration and "too old" to a link.
      return pick(
        context === "register"
          ? "invitation_unavailable"
          : context === "sso"
            ? "sso_link_needs_recent_sign_in"
            : "bad_credentials",
      );
    case "conflict":
      return pick(context === "register" ? "username_taken" : "generic");
    case "rate_limited":
      return pick("rate_limited");
    case "invalid_value":
    case "malformed_request":
      return pick("check_details");
    case "forbidden":
    case "credential_mismatch":
      return pick("wrong_origin");
    case "not_found":
      return pick(context === "sso" ? "sso_not_set_up" : "not_set_up");
    case "device_capacity":
      return pick("device_capacity");
    case "oidc_unavailable":
      return pick("sso_unavailable");
    case "temporarily_unavailable":
    case "internal_error":
      return pick("temporarily_unavailable");
    default:
      return pick("generic");
  }
}

/** An Atlas error from the ACTIVATION that follows a good exchange (the account exists; the browser could not finish). */
export function messageForActivationRefusal(error: ErrorShape): Message {
  const requestId = error.request_id;
  const id: MessageId =
    error.code === "device_capacity"
      ? "device_capacity"
      : error.code === "rate_limited"
        ? "rate_limited"
        : error.code === "temporarily_unavailable" ||
            error.code === "internal_error"
          ? "temporarily_unavailable"
          : "activation_refused";
  return requestId ? { id, requestId } : { id };
}

export const messageForNotStarted = (
  reason:
    | "hidden"
    | "lock_timeout"
    | "closing_write_gave_up"
    | "attempt_gone"
    | "wipe_pending",
): MessageId => {
  switch (reason) {
    case "hidden":
      return "hidden_tab";
    case "closing_write_gave_up":
    case "lock_timeout":
      return "busy_window";
    case "wipe_pending":
      return "wipe_pending";
    default:
      return "interrupted";
  }
};

/** The 1c banners above a form: the accepted card wording (heading + message), without the card's own button. */
export const SUPERSEDED_BANNER = {
  heading: NEUTRAL_COPY["1c.superseded"].heading,
  message: NEUTRAL_COPY["1c.superseded"].message,
} as const;
export const LOCK_WAIT_BANNER = {
  heading: NEUTRAL_COPY["1c.lock_wait"].heading,
  message: NEUTRAL_COPY["1c.lock_wait"].message,
} as const;

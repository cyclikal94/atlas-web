import { describe, expect, test } from "vitest";
import {
  type Context,
  fieldOf,
  MESSAGE_TEXT,
  type MessageId,
  messageForActivationRefusal,
  messageForError,
  messageForNotStarted,
  textOf,
} from "../../../src/features/authentication/outcome-copy";

/** U-MAP: every Atlas code and every outcome maps to a message of the closed catalogue; no server text is ever rendered. */
const CODES = [
  "unauthenticated",
  "forbidden",
  "credential_mismatch",
  "not_found",
  "conflict",
  "invitation_expired",
  "invalid_value",
  "malformed_request",
  "rate_limited",
  "device_capacity",
  "oidc_unavailable",
  "temporarily_unavailable",
  "internal_error",
  "something_new",
  undefined,
];
const CONTEXTS: Context[] = ["sign_in", "register", "sso"];

describe("messageForError", () => {
  test.each(
    CONTEXTS.flatMap((context) =>
      CODES.map((code) => [context, code] as const),
    ),
  )("%s / %s maps into the catalogue", (context, code) => {
    const message = messageForError(context, { code });
    expect(Object.keys(MESSAGE_TEXT)).toContain(message.id);
    expect(textOf(message)).toBe(MESSAGE_TEXT[message.id]);
  });

  test("the same 401 reads differently for a login, a registration and a link", () => {
    expect(messageForError("sign_in", { code: "unauthenticated" }).id).toBe(
      "bad_credentials",
    );
    expect(messageForError("register", { code: "unauthenticated" }).id).toBe(
      "invitation_unavailable",
    );
    expect(messageForError("sso", { code: "unauthenticated" }).id).toBe(
      "sso_link_needs_recent_sign_in",
    );
  });

  test.each([
    ["register", "conflict", "username_taken"],
    ["sso", "not_found", "sso_not_set_up"],
    ["sign_in", "not_found", "not_set_up"],
    ["sign_in", "rate_limited", "rate_limited"],
    ["sign_in", "forbidden", "wrong_origin"],
    ["sign_in", "device_capacity", "device_capacity"],
    ["sso", "oidc_unavailable", "sso_unavailable"],
    ["sign_in", "invalid_value", "check_details"],
    ["sign_in", "internal_error", "temporarily_unavailable"],
    ["sign_in", "validation_failed", "generic"],
  ] as const)("%s / %s -> %s", (context, code, id) => {
    expect(messageForError(context, { code }).id).toBe(id);
  });

  test("a request id is appended, and is the only thing taken from the server", () => {
    const message = messageForError("sign_in", {
      code: "unauthenticated",
      request_id: "req-123",
    });
    expect(textOf(message)).toBe(
      `${MESSAGE_TEXT.bad_credentials} Request ID: req-123`,
    );
  });

  test("an attacker-controlled error body cannot put text on the screen", () => {
    const hostile = {
      code: "<img src=x onerror=alert(1)>",
      message: "<script>alert(1)</script>",
      request_id: undefined,
    } as { code: string; request_id?: string };
    const text = textOf(messageForError("sign_in", hostile));
    expect(text).toBe(MESSAGE_TEXT.generic);
  });
});

describe("the other mappings", () => {
  test.each([
    ["hidden", "hidden_tab"],
    ["lock_timeout", "busy_window"],
    ["closing_write_gave_up", "busy_window"],
    ["wipe_pending", "wipe_pending"],
    ["attempt_gone", "interrupted"],
  ] as const)("not started: %s -> %s", (reason, id) => {
    expect(messageForNotStarted(reason)).toBe(id);
  });

  test.each([
    ["device_capacity", "device_capacity"],
    ["rate_limited", "rate_limited"],
    ["temporarily_unavailable", "temporarily_unavailable"],
    ["unauthenticated", "activation_refused"],
    [undefined, "activation_refused"],
  ] as const)(
    "an activation refusal %s -> %s (never `bad_credentials`)",
    (code, id) => {
      expect(messageForActivationRefusal({ code }).id).toBe(id);
    },
  );

  test("the field a message belongs to", () => {
    expect(fieldOf("bad_credentials")).toBe("password");
    expect(fieldOf("username_taken")).toBe("username");
    expect(fieldOf("rate_limited")).toBeNull();
  });

  test("every message is a plain sentence: no markup, no URL, no secret-shaped text", () => {
    for (const [id, text] of Object.entries(MESSAGE_TEXT) as [
      MessageId,
      string,
    ][]) {
      expect(text, id).not.toMatch(/[<>]|https?:|[0-9a-f]{32}/i);
      expect(text.length, id).toBeGreaterThan(10);
    }
  });
});

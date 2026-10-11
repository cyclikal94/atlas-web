import { describe, expect, test } from "vitest";
import { formatExpiry } from "../../../src/features/authentication/format";
import { publicSurfaceFor } from "../../../src/features/authentication/public-route";
import {
  checkCurrentPassword,
  checkNewPassword,
  checkNewUsername,
  checkSignInUsername,
  freshUntil,
  isFresh,
  utf8Length,
} from "../../../src/features/authentication/validation";

/** U-VAL: what the forms check before anything is sent. */
describe("utf8Length: a password's length is in BYTES", () => {
  test.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["日本", 6],
    ["😀", 4],
  ])("%j is %i bytes", (value, bytes) => {
    expect(utf8Length(value)).toBe(bytes);
  });
});

describe("checkNewPassword (12 to 1,024 bytes)", () => {
  test.each([
    ["a".repeat(11), false],
    ["a".repeat(12), true],
    ["a".repeat(1024), true],
    ["a".repeat(1025), false],
    // E-16: six emoji are 24 bytes, so they pass; three are 12 bytes, so they pass too; two are 8.
    ["😀".repeat(3), true],
    ["😀".repeat(2), false],
    // 256 four-byte characters are exactly 1,024 bytes; one more is over.
    ["😀".repeat(256), true],
    ["😀".repeat(257), false],
  ])("%#: ok=%s", (value, ok) => {
    expect(checkNewPassword(value).ok).toBe(ok);
  });

  test("a password is never trimmed or normalised", () => {
    const value = `  ${"x".repeat(12)}  `;
    expect(checkNewPassword(value)).toEqual({ ok: true, value });
  });
});

describe("checkCurrentPassword", () => {
  test("empty is refused; anything up to 1,024 bytes is not judged further", () => {
    expect(checkCurrentPassword("")).toEqual({
      ok: false,
      reason: "password_empty",
    });
    expect(checkCurrentPassword("x").ok).toBe(true);
    expect(checkCurrentPassword("x".repeat(1025))).toEqual({
      ok: false,
      reason: "password_long",
    });
  });
});

describe("usernames", () => {
  test("sign-in trims and constrains only the length", () => {
    expect(checkSignInUsername("  Kieran  ")).toEqual({
      ok: true,
      value: "Kieran",
    });
    expect(checkSignInUsername("   ")).toEqual({
      ok: false,
      reason: "username_empty",
    });
    expect(checkSignInUsername("a".repeat(101))).toEqual({
      ok: false,
      reason: "username_long",
    });
  });

  test.each([
    ["kieran", true],
    ["a.b-c_d9", true],
    ["Kieran", false],
    ["with space", false],
    ["ünï", false],
    ["a/b", false],
  ])("registration %j: ok=%s", (value, ok) => {
    expect(checkNewUsername(value).ok).toBe(ok);
  });

  test("registration trims first", () => {
    expect(checkNewUsername("  newbie ")).toEqual({
      ok: true,
      value: "newbie",
    });
  });
});

describe("isFresh: the five-minute rule with a 30 s margin", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  test.each([
    ["10 s ago", "2026-10-01T11:59:50.000Z", true],
    ["4 min ago", "2026-10-01T11:56:00.000Z", true],
    ["4 min 29 s ago", "2026-10-01T11:55:31.000Z", true],
    ["4 min 31 s ago", "2026-10-01T11:55:29.000Z", false],
    ["6 min ago", "2026-10-01T11:54:00.000Z", false],
    ["unreadable", "not a date", false],
  ])("%s: %s", (_name, created, fresh) => {
    expect(isFresh(created, now)).toBe(fresh);
  });

  // Review R8: the screen schedules its own expiry from this instant, so it must be the one `isFresh` judges by.
  test("freshUntil is the first instant that is no longer fresh, and isFresh agrees on both sides of it", () => {
    const created = "2026-10-01T11:59:00.000Z";
    const until = freshUntil(created);
    expect(until).toBe(Date.parse(created) + 4.5 * 60_000);
    expect(isFresh(created, (until as number) - 1)).toBe(true);
    expect(isFresh(created, until as number)).toBe(false);
    expect(freshUntil("not a date")).toBeNull();
  });
});

describe("publicSurfaceFor", () => {
  test.each([
    ["/join", "join"],
    ["/join/", "join"],
    ["/", "sign-in"],
    ["/tasks/abc", "sign-in"],
    ["/joined", "sign-in"],
    ["/join/extra", "sign-in"],
  ])("%s -> %s", (path, surface) => {
    expect(publicSurfaceFor(path)).toBe(surface);
  });
});

describe("formatExpiry", () => {
  test("prints the wireframe's YYYY-MM-DD HH:mm in the given zone", () => {
    expect(formatExpiry("2026-09-29T17:00:00.000Z", "Europe/London")).toBe(
      "2026-09-29 18:00",
    );
    expect(formatExpiry("2026-12-29T17:00:00.000Z", "Europe/London")).toBe(
      "2026-12-29 17:00",
    );
    expect(formatExpiry("nonsense")).toBe("");
  });
});

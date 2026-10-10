import { afterEach, describe, expect, test, vi } from "vitest";
import {
  captureHandoff,
  type HandoffEnv,
  invitationMemory,
  rememberInvitation,
} from "../../../src/features/authentication/handoff";

afterEach(() => invitationMemory.clear());

const GRANT = "a".repeat(64);
const ACCOUNT = "123e4567-e89b-12d3-a456-426614174000";
const TOKEN = "b".repeat(64);

const env = (hash: string, pathname = "/", search = "") => {
  const replaceState = vi.fn<(url: string) => void>();
  const value: HandoffEnv = { pathname, search, hash, replaceState };
  return Object.assign(value, { replaceState });
};

/** U-HAND-1: what the URL fragment carries is copied out and stripped, synchronously, whether or not it is valid. */
describe("captureHandoff: the OIDC grant", () => {
  test("a valid fragment is returned and stripped exactly once, keeping the path and the query", () => {
    const e = env(
      `#atlas_grant=${GRANT}&atlas_attempt=7&atlas_account=${ACCOUNT}`,
      "/tasks/42",
      "?a=1",
    );
    expect(captureHandoff(e)).toEqual({
      oidc: {
        kind: "valid",
        fragment: { grant: GRANT, attempt: "7", account: ACCOUNT },
      },
      invitation: null,
    });
    expect(e.replaceState).toHaveBeenCalledTimes(1);
    expect(e.replaceState).toHaveBeenCalledWith("/tasks/42?a=1");
  });

  test.each([
    [
      "a short grant",
      `#atlas_grant=abc&atlas_attempt=7&atlas_account=${ACCOUNT}`,
    ],
    [
      "an upper-case grant",
      `#atlas_grant=${"A".repeat(64)}&atlas_attempt=7&atlas_account=${ACCOUNT}`,
    ],
    [
      "a non-numeric attempt",
      `#atlas_grant=${GRANT}&atlas_attempt=7x&atlas_account=${ACCOUNT}`,
    ],
    [
      "an over-long attempt",
      `#atlas_grant=${GRANT}&atlas_attempt=${"9".repeat(16)}&atlas_account=${ACCOUNT}`,
    ],
    [
      "an account that is not a UUID",
      `#atlas_grant=${GRANT}&atlas_attempt=7&atlas_account=nope`,
    ],
    ["a missing attempt", `#atlas_grant=${GRANT}&atlas_account=${ACCOUNT}`],
    ["a lone grant", `#atlas_grant=${GRANT}`],
  ])("%s is `invalid` and STILL stripped", (_name, hash) => {
    const e = env(hash);
    expect(captureHandoff(e).oidc).toEqual({ kind: "invalid" });
    expect(e.replaceState).toHaveBeenCalledTimes(1);
    expect(e.replaceState).toHaveBeenCalledWith("/");
  });

  test("the fragment is form-urlencoded: `&`, `+` and `%` inside a value do not split or shift it", () => {
    // `atlas_attempt` is validated as digits, so an encoded reserved byte makes it invalid rather than being mis-split.
    const e = env(
      `#atlas_grant=${GRANT}&atlas_attempt=1%262&atlas_account=${ACCOUNT}`,
    );
    expect(captureHandoff(e).oidc).toEqual({ kind: "invalid" });
    const plus = env(
      `#atlas_grant=${GRANT}&atlas_attempt=1+2&atlas_account=${ACCOUNT}`,
    );
    expect(captureHandoff(plus).oidc).toEqual({ kind: "invalid" });
  });

  test("a malformed hash never throws", () => {
    for (const hash of ["#%E0%A4%A", "#&&&", "#=", "##", "#atlas_grant", ""])
      expect(() => captureHandoff(env(hash))).not.toThrow();
  });
});

describe("captureHandoff: the invitation token", () => {
  test("`t` is read only at /join, and stripped", () => {
    const e = env(`#t=${TOKEN}`, "/join");
    expect(captureHandoff(e)).toEqual({
      oidc: null,
      invitation: { kind: "token", token: TOKEN },
    });
    expect(e.replaceState).toHaveBeenCalledTimes(1);
    expect(e.replaceState).toHaveBeenCalledWith("/join");
  });

  test("/join/ is /join", () => {
    const e = env(`#t=${TOKEN}`, "/join/");
    expect(captureHandoff(e).invitation).toEqual({
      kind: "token",
      token: TOKEN,
    });
  });

  test("E-3: away from /join `t` is ignored and NOT stripped (it is not ours)", () => {
    const e = env(`#t=${TOKEN}`, "/tasks");
    expect(captureHandoff(e)).toEqual({ oidc: null, invitation: null });
    expect(e.replaceState).not.toHaveBeenCalled();
  });

  test.each([
    ["too short", "#t=abc"],
    ["not hexadecimal", `#t=${"z".repeat(64)}`],
    ["empty", "#t="],
  ])("a %s token is `invalid` and stripped", (_name, hash) => {
    const e = env(hash, "/join");
    expect(captureHandoff(e).invitation).toEqual({ kind: "invalid" });
    expect(e.replaceState).toHaveBeenCalledTimes(1);
  });

  test("a reload at /join with no fragment: nothing to capture, nothing stripped", () => {
    const e = env("", "/join");
    expect(captureHandoff(e)).toEqual({ oidc: null, invitation: null });
    expect(e.replaceState).not.toHaveBeenCalled();
  });
});

describe("captureHandoff: an unrecognised fragment is left alone", () => {
  test.each(["#section-2", "#/route", "#foo=bar", "#"])("%j", (hash) => {
    const e = env(hash);
    expect(captureHandoff(e)).toEqual({ oidc: null, invitation: null });
    expect(e.replaceState).not.toHaveBeenCalled();
  });
});

describe("the invitation token lives in page memory only", () => {
  test("it is held in a module variable, not in any storage, and `clear` removes it", () => {
    rememberInvitation({ kind: "token", token: TOKEN });
    expect(invitationMemory.peek()).toBe(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    invitationMemory.clear();
    expect(invitationMemory.peek()).toBeNull();
  });

  test("an invalid link is remembered as invalid, with no token", () => {
    rememberInvitation({ kind: "invalid" });
    expect(invitationMemory.get()).toEqual({ kind: "invalid" });
    expect(invitationMemory.peek()).toBeNull();
  });
});

/**
 * Review R5. A submission's result is bound to the invitation it was submitted from: a late `restore` or `spend` must never
 * overwrite a DIFFERENT link that has since replaced it, and what the submission learned is kept as `earlier` rather than lost.
 */
describe("a redemption is bound to the invitation that was submitted (review R5)", () => {
  const OTHER = "c".repeat(64);
  const THIRD = "d".repeat(64);

  test("with no newer link, `take` removes the token, `restore` puts it back and the link generation does not change", () => {
    invitationMemory.set(TOKEN);
    const generation = invitationMemory.version();
    const redemption = invitationMemory.take(TOKEN);
    expect(invitationMemory.peek()).toBeNull();
    expect(invitationMemory.get()).toEqual({ kind: "unset" });
    redemption.restore();
    expect(invitationMemory.get()).toEqual({ kind: "token", token: TOKEN });
    expect(invitationMemory.version()).toBe(generation);
    expect(invitationMemory.earlier()).toBeNull();
  });

  test("with no newer link, `spend` retires the invitation and records nothing as earlier", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    redemption.spend("newbie");
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "newbie",
    });
    expect(invitationMemory.peek()).toBeNull();
    expect(invitationMemory.earlier()).toBeNull();
  });

  test("a refusal that would restore the earlier token leaves the newer link exactly as it is", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    invitationMemory.set(OTHER);
    const generation = invitationMemory.version();
    const heard = vi.fn();
    const stop = invitationMemory.subscribe(heard);
    redemption.restore();
    stop();
    expect(invitationMemory.get()).toEqual({ kind: "token", token: OTHER });
    expect(invitationMemory.version()).toBe(generation);
    expect(invitationMemory.earlier()).toBeNull();
    // The earlier token is gone for good: it is nowhere in page memory.
    expect(invitationMemory.peek()).toBe(OTHER);
    expect(heard).not.toHaveBeenCalled();
  });

  test("a lost response leaves the newer link usable and remembers the submission as earlier", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    invitationMemory.set(OTHER);
    const generation = invitationMemory.version();
    redemption.spend("first");
    expect(invitationMemory.get()).toEqual({ kind: "token", token: OTHER });
    expect(invitationMemory.version()).toBe(generation);
    expect(invitationMemory.earlier()).toBe("first");
    expect(JSON.stringify(invitationMemory.get())).not.toContain(TOKEN);
  });

  test("an invalid newer link is not replaced either", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    invitationMemory.markInvalid();
    redemption.restore();
    expect(invitationMemory.get()).toEqual({ kind: "invalid" });
    redemption.spend("first");
    expect(invitationMemory.get()).toEqual({ kind: "invalid" });
    expect(invitationMemory.earlier()).toBe("first");
  });

  test("the same link pasted again while it is outstanding is the same invitation: the late result retires it", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    invitationMemory.set(TOKEN);
    redemption.spend("newbie");
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "newbie",
    });
    expect(invitationMemory.earlier()).toBeNull();
  });

  test("a spent invitation that a newer link displaces is kept as earlier, and a settled account forgets both", () => {
    invitationMemory.set(TOKEN);
    invitationMemory.take(TOKEN).spend("first");
    invitationMemory.set(OTHER);
    expect(invitationMemory.get()).toEqual({ kind: "token", token: OTHER });
    expect(invitationMemory.earlier()).toBe("first");
    invitationMemory.take(OTHER).spend("second");
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "second",
    });
    expect(invitationMemory.earlier()).toBe("first");
    invitationMemory.set(THIRD);
    // The most recent displaced submission is the one carried.
    expect(invitationMemory.earlier()).toBe("second");
    invitationMemory.forgetSpent();
    expect(invitationMemory.earlier()).toBeNull();
    expect(invitationMemory.get()).toEqual({ kind: "token", token: THIRD });
  });

  test("`dismissEarlier` forgets only the earlier submission", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    invitationMemory.set(OTHER);
    redemption.spend("first");
    invitationMemory.dismissEarlier();
    expect(invitationMemory.earlier()).toBeNull();
    expect(invitationMemory.get()).toEqual({ kind: "token", token: OTHER });
  });

  test("`clear` forgets the link, a spent submission and an earlier one", () => {
    invitationMemory.set(TOKEN);
    const redemption = invitationMemory.take(TOKEN);
    invitationMemory.set(OTHER);
    redemption.spend("first");
    invitationMemory.clear();
    expect(invitationMemory.get()).toEqual({ kind: "unset" });
    expect(invitationMemory.earlier()).toBeNull();
  });

  test("taking a token that was never remembered still lets a refusal put it back (a form mounted without a fragment)", () => {
    const redemption = invitationMemory.take(TOKEN);
    redemption.restore();
    expect(invitationMemory.peek()).toBe(TOKEN);
  });
});

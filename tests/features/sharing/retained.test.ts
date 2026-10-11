// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetAllRetained,
  retainedSession,
} from "../../../src/features/sharing/retained";

/**
 * WEB-12a review 2, R5: unsaved editor input belongs to an editor SESSION (ia.md §1.3.3, §3). The sync control suspends a session and
 * reopening resumes it; a dismissal discards everything it owns and ends it, and nothing the ended session does afterwards can bring an
 * entry back or remove a later session's. Other owners and other identities are never touched by it.
 */
afterEach(forgetAllRetained);

const ME = "11111111-1111-4111-8111-111111111111:1";
const LATER = "11111111-1111-4111-8111-111111111111:2";

describe("a session owns what it kept", () => {
  test("control: a suspended session is resumed by the next opening, which gets every entry back", () => {
    const first = retainedSession(ME, "defaults");
    first.retain("defaults:personal:personal:field", "private");
    first.retain("defaults:household:H1:field", "edit");
    const again = retainedSession(ME, "defaults");
    expect(again.retained("defaults:personal:personal:field")).toBe("private");
    expect(again.retained("defaults:household:H1:field")).toBe("edit");
  });

  test("MU-S44: discard forgets EVERY entry the session owns (any target), and the next opening starts empty", () => {
    const first = retainedSession(ME, "defaults");
    first.retain("defaults:personal:personal:field", "private");
    first.retain("defaults:household:H1:task", "edit");
    const resumed = retainedSession(ME, "defaults");
    resumed.discard();
    const next = retainedSession(ME, "defaults");
    expect(next.retained("defaults:personal:personal:field")).toBeUndefined();
    expect(next.retained("defaults:household:H1:task")).toBeUndefined();
  });

  test("MU-S43: discard never touches another owner's entries", () => {
    const defaults = retainedSession(ME, "defaults");
    defaults.retain("defaults:personal:personal:field", "private");
    const policyA = retainedSession(ME, "policy:A");
    policyA.retain("policy:A", "draft A");
    const policyB = retainedSession(ME, "policy:B");
    policyB.retain("policy:B", "draft B");
    policyB.discard();
    defaults.discard();
    expect(retainedSession(ME, "policy:A").retained("policy:A")).toBe(
      "draft A",
    );
    expect(
      retainedSession(ME, "policy:B").retained("policy:B"),
    ).toBeUndefined();
  });

  test("forget removes one target only; repeating a discard does nothing", () => {
    const session = retainedSession(ME, "defaults");
    session.retain("a", 1);
    session.retain("b", 2);
    session.forget("a");
    expect(session.retained("a")).toBeUndefined();
    expect(session.retained("b")).toBe(2);
    session.discard();
    session.discard();
    expect(retainedSession(ME, "defaults").retained("b")).toBeUndefined();
  });
});

describe("an ended session can do nothing more", () => {
  test("MU-S44: after a discard, the old handle's late keep brings nothing back and its late forget removes nothing of the next session's", () => {
    const old = retainedSession(ME, "policy:A");
    old.retain("policy:A", "old draft");
    old.discard();
    old.retain("policy:A", "late keep");
    expect(
      retainedSession(ME, "policy:A").retained("policy:A"),
    ).toBeUndefined();
    const next = retainedSession(ME, "policy:A");
    next.retain("policy:A", "new draft");
    old.forget("policy:A");
    old.discard();
    expect(next.retained("policy:A")).toBe("new draft");
    expect(old.retained("policy:A")).toBeUndefined();
  });
});

describe("identities", () => {
  test("keeping for one identity ends every other identity's sessions: their entries are gone and their handles inert", () => {
    const before = retainedSession(ME, "defaults");
    before.retain("defaults:personal:personal:field", "private");
    const after = retainedSession(LATER, "defaults");
    expect(after.retained("defaults:personal:personal:field")).toBeUndefined();
    after.retain("defaults:personal:personal:task", "read");
    expect(before.retained("defaults:personal:personal:field")).toBeUndefined();
    before.retain("defaults:personal:personal:field", "late");
    expect(
      retainedSession(ME, "defaults").retained(
        "defaults:personal:personal:field",
      ),
    ).toBeUndefined();
    expect(after.retained("defaults:personal:personal:task")).toBe("read");
  });
});

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  register,
  signIn,
} from "../../../src/features/authentication/controller";
import { authFeedback } from "../../../src/features/authentication/feedback";
import { invitationMemory } from "../../../src/features/authentication/handoff";
import type { Fixture } from "../../support/session/harness";
import {
  holdAnswers,
  holdLock,
  newWorld,
} from "../../support/session/scenarios";

/**
 * The controller over the REAL session kernel and a deterministic backend (not a double of `Attempts`): the compositions the
 * review found (R1, R2) are about what the kernel actually returns, and in which order, so a mocked outcome cannot stand in.
 * Fixture evidence: it shows the application follows the module's answers, never that the real backend does (that is Layer C).
 */
const PASSWORD = "correct-horse-battery-9271";

beforeEach(() => {
  invitationMemory.clear();
  authFeedback.clearOnBegin();
});
afterEach(() => {
  invitationMemory.clear();
  authFeedback.clearOnBegin();
});

const registrations = (f: Fixture) =>
  f.server.requests.filter((r) => r.path.endsWith("/browser-registration"));
const activations = (f: Fixture) =>
  f.server.requests.filter((r) =>
    r.path.endsWith("/browser-sessions/activate"),
  );
const accountExists = (f: Fixture, username: string) =>
  [...f.server.accounts.values()].some((a) => a.username === username);

describe("R2: a registration whose redemption has committed is never available for another submission", () => {
  test("the module sends the redemption BEFORE it can report `not_started`: a hidden page after the redemption is a failed activation, not an unsent request", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const invitation = f.server.addInvitation();
    const begun = await f.runWith(page.session.attempts.begin("registration"));
    if (begun.kind !== "started") throw new Error("begin did not start");
    // Another window holds `atlas-auth`: the redemption is sent and committed, and the activation waits for the lock.
    const release = await holdLock(f, "blocker", "atlas-auth");
    const pending = page.session.attempts.registerWithInvitation(begun.handle, {
      token: invitation.token,
      username: "newbie",
      password: PASSWORD,
    });
    for (let i = 0; i < 10; i++) await f.world.runUntilIdle();
    expect(registrations(f)).toHaveLength(1);
    expect(f.server.invitations.get(invitation.token)?.state).toBe("redeemed");
    expect(accountExists(f, "newbie")).toBe(true);
    page.hide();
    release();
    const outcome = await f.runWith(pending);
    expect(outcome).toEqual({ kind: "not_started", reason: "hidden" });
    // One redemption, no activation: `not_started` here does NOT mean the invitation is untouched.
    expect(registrations(f)).toHaveLength(1);
    expect(activations(f)).toHaveLength(0);
  });

  test("the controller turns that into the sign-in recovery: the token is NOT restored and the page remembers the invitation as spent", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const invitation = f.server.addInvitation();
    invitationMemory.set(invitation.token);
    const begun = await f.runWith(page.session.attempts.begin("registration"));
    const release = await holdLock(f, "blocker", "atlas-auth");
    // `register` begins its own attempt; hand it the one begun above so the lock can be held first.
    page.session.attempts.begin = async () => begun;
    const pending = register(page.session, {
      token: invitation.token,
      username: "newbie",
      password: PASSWORD,
    });
    for (let i = 0; i < 10; i++) await f.world.runUntilIdle();
    expect(f.server.invitations.get(invitation.token)?.state).toBe("redeemed");
    page.hide();
    release();
    const result = await f.runWith(pending);
    expect(result).toEqual({ kind: "lost_response" });
    expect(invitationMemory.peek()).toBeNull();
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "newbie",
    });
    expect(registrations(f)).toHaveLength(1);
    expect(activations(f)).toHaveLength(0);
    // The account is real: the details the person chose sign in.
    const second = f.addPage();
    await f.boot(second);
    expect(await f.signIn(second, "newbie", PASSWORD)).toMatchObject({
      kind: "settled",
    });
  });

  test("a superseded registration (a newer attempt in another window failed) leaves the invitation spent, and the stale result is still discarded", async () => {
    const f = await newWorld();
    const a = f.addPage();
    const b = f.addPage();
    await f.boot(a);
    await f.boot(b);
    const invitation = f.server.addInvitation();
    invitationMemory.set(invitation.token);
    const held = holdAnswers(f, (r) =>
      r.path.endsWith("/browser-registration"),
    );
    const pending = register(a.session, {
      token: invitation.token,
      username: "newbie",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    expect(registrations(f)).toHaveLength(1);
    // The newer attempt FAILS, so no account displays: nothing in this window replaces the join page.
    const newer = await f.signIn(b, "kieran", "not-the-password");
    expect(newer).toMatchObject({ kind: "refused" });
    held.stop();
    held.release();
    const result = await f.runWith(pending);
    expect(result).toEqual({ kind: "superseded" });
    expect(authFeedback.get().map((item) => item.kind)).toEqual(["superseded"]);
    // The consumed invitation is not offered again; the person is directed to sign in with the details they chose.
    expect(invitationMemory.peek()).toBeNull();
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "newbie",
    });
    // Stale-result protection is intact: the late grant was never activated.
    expect(activations(f)).toHaveLength(0);
    expect(f.server.invitations.get(invitation.token)?.state).toBe("redeemed");
    expect(accountExists(f, "newbie")).toBe(true);
  });

  test("an activation refused after a good redemption is the same recovery", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const invitation = f.server.addInvitation();
    invitationMemory.set(invitation.token);
    f.server.deviceCapacity = 1;
    const result = await f.runWith(
      register(page.session, {
        token: invitation.token,
        username: "newbie",
        password: PASSWORD,
      }),
    );
    expect(result).toEqual({ kind: "lost_response" });
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "newbie",
    });
    expect(activations(f)).toHaveLength(1);
  });

  test("a registration that was never sent keeps its invitation (the contrast)", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const invitation = f.server.addInvitation();
    invitationMemory.set(invitation.token);
    // `begin` cannot take `atlas-auth` while another window holds it: nothing is sent.
    const release = await holdLock(f, "blocker", "atlas-auth");
    const pending = register(page.session, {
      token: invitation.token,
      username: "newbie",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    await f.world.advance(20_000);
    const result = await pending;
    release();
    expect(result).toEqual({ kind: "lock_timeout" });
    expect(registrations(f)).toHaveLength(0);
    expect(invitationMemory.peek()).toBe(invitation.token);
    expect(f.server.invitations.get(invitation.token)?.state).toBe("open");
  });
});

/**
 * Review R5, over the REAL kernel: a different invitation is opened (a fragment-only navigation) while an earlier registration is
 * outstanding. The late result is bound to the invitation it was submitted from, so it neither puts the earlier token back nor
 * retires the newer link; what the submission may have created is remembered as `earlier`, beside the newer link and never as it.
 */
describe("R5: a result that arrives after a DIFFERENT invitation was opened belongs to the invitation that was submitted", () => {
  const registrationHeld = (f: Fixture, over: { dropAfterForward?: boolean }) =>
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-registration"),
      delay: "unbounded",
      ...over,
    });

  async function twoInvitations() {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const first = f.server.addInvitation();
    const second = f.server.addInvitation();
    invitationMemory.set(first.token);
    return { f, page, first, second };
  }

  test("a LOST response: the newer link stays usable, the earlier details are remembered, and nothing is resubmitted", async () => {
    const { f, page, first, second } = await twoInvitations();
    registrationHeld(f, { dropAfterForward: true });
    const pending = register(page.session, {
      token: first.token,
      username: "firstperson",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    // The redemption reached the server and the answer is held on its way back.
    expect(registrations(f)).toHaveLength(1);
    expect(f.server.invitations.get(first.token)?.state).toBe("redeemed");
    // A different link is opened in the same tab.
    invitationMemory.set(second.token);
    f.world.release("Da");
    const result = await f.runWith(pending);
    expect(result).toEqual({ kind: "lost_response" });
    // The newer link is exactly as it was; the earlier submission is told beside it, not as it.
    expect(invitationMemory.get()).toEqual({
      kind: "token",
      token: second.token,
    });
    expect(invitationMemory.earlier()).toBe("firstperson");
    expect(invitationMemory.peek()).not.toBe(first.token);
    // The newer invitation was never submitted and is still usable on the server (its preview answers).
    expect(registrations(f)).toHaveLength(1);
    expect(f.server.invitations.get(second.token)?.state).toBe("open");
    expect(
      await f.runWith(page.session.attempts.previewInvitation(second.token)),
    ).toMatchObject({ kind: "ok" });
    // The earlier account is real: the details the person chose sign in.
    const other = f.addPage();
    await f.boot(other);
    expect(await f.signIn(other, "firstperson", PASSWORD)).toMatchObject({
      kind: "settled",
    });
  });

  test("a refusal that leaves the invitation usable would restore the earlier token: it does not, and the newer link is untouched", async () => {
    const { f, page, first, second } = await twoInvitations();
    registrationHeld(f, {});
    const pending = register(page.session, {
      token: first.token,
      // A taken username is a 409 and the invitation is preserved.
      username: "kieran",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    expect(registrations(f)).toHaveLength(1);
    invitationMemory.set(second.token);
    f.world.release("Da");
    const result = await f.runWith(pending);
    expect(result).toMatchObject({
      kind: "failed",
      message: { id: "username_taken" },
    });
    expect(invitationMemory.get()).toEqual({
      kind: "token",
      token: second.token,
    });
    expect(invitationMemory.earlier()).toBeNull();
    // Nothing was created and the first invitation is still open on the server, but this page no longer offers it.
    expect(f.server.invitations.get(first.token)?.state).toBe("open");
    expect(invitationMemory.peek()).toBe(second.token);
    expect(registrations(f)).toHaveLength(1);
  });

  test("a superseded result: the stale result is still discarded, the newer link keeps the page, and the earlier details are remembered", async () => {
    const { f, page, first, second } = await twoInvitations();
    const other = f.addPage();
    await f.boot(other);
    const held = holdAnswers(f, (r) =>
      r.path.endsWith("/browser-registration"),
    );
    const pending = register(page.session, {
      token: first.token,
      username: "firstperson",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    expect(registrations(f)).toHaveLength(1);
    invitationMemory.set(second.token);
    // A newer attempt in the other window FAILS, so no account displays here.
    expect(await f.signIn(other, "kieran", "not-the-password")).toMatchObject({
      kind: "refused",
    });
    held.stop();
    held.release();
    const result = await f.runWith(pending);
    expect(result).toEqual({ kind: "superseded" });
    expect(invitationMemory.get()).toEqual({
      kind: "token",
      token: second.token,
    });
    expect(invitationMemory.earlier()).toBe("firstperson");
    // The stale grant was never activated.
    expect(activations(f)).toHaveLength(0);
    expect(f.server.invitations.get(second.token)?.state).toBe("open");
  });

  test("a registration that SETTLES while another link waits leaves that link in page memory", async () => {
    const { f, page, first, second } = await twoInvitations();
    registrationHeld(f, {});
    const pending = register(page.session, {
      token: first.token,
      username: "firstperson",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    invitationMemory.set(second.token);
    f.world.release("Da");
    expect(await f.runWith(pending)).toEqual({ kind: "settled" });
    expect(invitationMemory.get()).toEqual({
      kind: "token",
      token: second.token,
    });
    expect(invitationMemory.earlier()).toBeNull();
  });

  test("the contrast: with no newer link the same lost response retires THIS invitation (R2 is unchanged)", async () => {
    const { f, page, first } = await twoInvitations();
    registrationHeld(f, { dropAfterForward: true });
    const pending = register(page.session, {
      token: first.token,
      username: "firstperson",
      password: PASSWORD,
    });
    await f.world.runUntilIdle();
    f.world.release("Da");
    expect(await f.runWith(pending)).toEqual({ kind: "lost_response" });
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: "firstperson",
    });
    expect(invitationMemory.earlier()).toBeNull();
    expect(invitationMemory.peek()).toBeNull();
  });
});

describe("R1: a refusal that arrives after the neutral gate is not lost with the form", () => {
  test("an activation refused after a good password is returned AND carried for the form that mounts next", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.server.deviceCapacity = 1;
    const result = await f.runWith(
      signIn(page.session, { username: "kieran", password: "pw" }),
    );
    expect(result).toMatchObject({
      kind: "failed",
      message: { id: "device_capacity" },
    });
    expect(authFeedback.carriedFailure()).toMatchObject({
      id: "device_capacity",
    });
    expect(activations(f)).toHaveLength(1);
  });
});

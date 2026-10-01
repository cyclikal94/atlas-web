// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { Fixture } from "../support/session/harness";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  holdLock,
  leaseIds,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-ACTVIS-*: hiding the page is observed for the WHOLE wait to start an activation, not only once its request is in flight
 * (matrix 3.4 step 3; WEB-08a acceptance: visible activation, cancelled at once on hiding). The wait is the request for
 * `atlas-auth`, other pages' reservations and the closing transaction; `abortActivation()` had no request to abort in that
 * interval, so the `/activate` request (which changes the cookie) was still sent by a hidden page that was about to freeze.
 */
let mark = 0;
const activations = (f: Fixture) =>
  f.server.requests
    .slice(mark)
    .filter((r) => r.path.endsWith("/browser-sessions/activate"));
const cancels = (f: Fixture) =>
  f.server.requests
    .slice(mark)
    .filter((r) => r.path.endsWith("/activate/cancel"));

async function switching() {
  const f = await newWorld();
  const l = await signedInPage(f);
  // The sign-in above made its own activation: the assertions count only what the switch sends.
  mark = f.server.requests.length;
  const begun = await f.runWith(l.page.session.attempts.begin("password"));
  if (begun.kind !== "started") throw new Error("did not begin");
  const outcome = () =>
    l.page.session.attempts.signInWithPassword(begun.handle, {
      username: "sam",
      password: "pw2",
    });
  return { f, l, outcome };
}

describe("hiding while the activation waits for atlas-auth", () => {
  test("the page hides, the lock is then released: no activation is sent, nothing was committed, the attempt is cleared and the old account stays", async () => {
    const { f, l, outcome } = await switching();
    const release = await holdLock(f, "frozen-holder", "atlas-auth");
    const before = activations(f).length;
    const result = outcome();
    await f.world.runUntilIdle();
    expect(l.page.kernel.memory.closing).toBe(1);
    l.page.hide();
    release();
    await f.world.runUntilIdle();
    expect(l.page.env.visible).toBe(false);
    expect(activations(f).length).toBe(before);
    expect(await result).toEqual({ kind: "not_started", reason: "hidden" });
    // Nothing had been committed: no `activating` phase, no fence, the settled account untouched.
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled?.account_id).toBe(l.account);
    expect(l.page.kernel.memory.closing).toBe(0);
    expect(f.locks.allHeldNames().map((h) => h.name)).not.toContain(
      "atlas-auth",
    );
    expect(checkProperties(f)).toEqual([]);
    // When the page is shown again, the first account displays again through an exposure.
    l.page.show();
    await f.world.runUntilIdle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("hiding and showing again during the wait does not revive the activation", async () => {
    const { f, l, outcome } = await switching();
    const release = await holdLock(f, "frozen-holder", "atlas-auth");
    const result = outcome();
    await f.world.runUntilIdle();
    l.page.hide();
    l.page.show();
    release();
    await f.world.runUntilIdle();
    expect(activations(f)).toEqual([]);
    expect(await result).toEqual({ kind: "not_started", reason: "hidden" });
    expect(stateOf(f).attempt).toBeNull();
  });
});

describe("hiding while the closing transaction is completing", () => {
  test("`activating` is already committed: no activation is sent, and the attempt is resolved by activate/cancel with its verifier, then cleared", async () => {
    const { f, l, outcome } = await switching();
    // The transaction commits, but its completion reaches the page late.
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.label === "closing:activating",
    );
    const result = outcome();
    await f.world.runUntilIdle();
    expect(l.page.kernel.memory.closing).toBe(1);
    const committed = stateOf(f).attempt;
    expect(committed?.phase).toBe("activating");
    const verifier = committed?.verifier;
    l.page.hide();
    f.world.clearKnobs();
    f.world.release("D0");
    await f.world.runUntilIdle();
    expect(activations(f)).toEqual([]);
    expect(await result).toEqual({ kind: "gating" });
    // The persisted phase was not discarded: it was resolved through the terminal-cancellation protocol.
    await f.world.runUntilIdle();
    expect(cancels(f).length).toBeGreaterThan(0);
    expect(cancels(f)[0]?.body).toMatchObject({ verifier });
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled?.account_id).toBe(l.account);
    // No cookie change ever reached the browser.
    expect(f.server.sessions.size).toBe(1);
    expect(leaseIds(f)).toEqual([]);
    expect(f.locks.allHeldNames().map((h) => h.name)).not.toContain(
      "atlas-auth",
    );
    expect(checkProperties(f)).toEqual([]);
  });

  test("the activation is issued when the page stays visible throughout (the control)", async () => {
    const { f, l, outcome } = await switching();
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.label === "closing:activating",
    );
    const result = outcome();
    await f.world.runUntilIdle();
    f.world.clearKnobs();
    f.world.release("D0");
    await f.world.runUntilIdle();
    expect(activations(f)).toHaveLength(1);
    expect(await result).toMatchObject({ kind: "settled" });
    expect(stateOf(f).settled?.account_id).not.toBe(l.account);
  });
});

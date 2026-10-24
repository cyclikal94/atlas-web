// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { AttemptHandle } from "../../src/session";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  holdAnswers,
  holdLock,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";
import { API } from "../support/session/server";

/**
 * WEB-08c, R1 of the review of 11 October 2026, with the REAL kernel over the fake platform: a person who cancels a sign-in (the account
 * switcher's "Cancel — stay as …", Escape or Close, "Confirm it's you"'s Cancel) cancels ITS attempt (`attempts.cancel`), and no change is
 * made: a grant that comes back afterwards is discarded and its activation is never sent, even when the clear has to wait for `atlas-auth`
 * or the activating write is already waiting for it. Once the activating write has committed, the neutral gate owns the screen and the
 * kernel's terminal resolution decides (nothing is on screen to cancel with); that boundary is pinned too.
 *
 * Fixture evidence against a stub of the contract, never integration evidence.
 */
const isExchange = (path: string) => path === `${API}/browser-sessions`;
const isActivate = (path: string) =>
  path === `${API}/browser-sessions/activate`;
const activations = (f: Fixture) =>
  f.server.requests.filter((r) => isActivate(r.path)).length;

async function begin(f: Fixture, page: FakePage): Promise<AttemptHandle> {
  const begun = await f.runWith(page.session.attempts.begin("password"));
  if (begun.kind !== "started") throw new Error(`begin: ${begun.kind}`);
  return begun.handle;
}

/** kieran is displayed; a switch to sam is begun and its exchange is held at the server. */
async function switchHeldAtExchange() {
  const f = await newWorld();
  const l = await signedInPage(f);
  const before = stateOf(f).settled;
  const held = holdAnswers(
    f,
    (r) => isExchange(r.path) && r.page === l.page.id,
  );
  const handle = await begin(f, l.page);
  const outcome = l.page.session.attempts.signInWithPassword(handle, {
    username: "sam",
    password: "pw2",
  });
  await f.settle();
  expect(stateOf(f).attempt?.phase).toBe("exchanging");
  return { f, l, before, held, handle, outcome, sent: activations(f) };
}

describe("R1: a cancelled sign-in makes no change", () => {
  test("control: the same held exchange, NOT cancelled, activates and settles the incoming account", async () => {
    const { f, l, before, held, outcome, sent } = await switchHeldAtExchange();
    held.stop();
    held.release();
    expect(await f.runWith(outcome)).toMatchObject({ kind: "settled" });
    await f.settle();
    expect(activations(f)).toBe(sent + 1);
    expect(stateOf(f).settled?.account_id).not.toBe(before?.account_id);
    expect(checkProperties(f)).toEqual([]);
    void l;
  });

  test("cancelled while the exchange is held: the late grant is discarded, no activation is sent, the outgoing account stays settled and displayed", async () => {
    const { f, l, before, held, handle, outcome, sent } =
      await switchHeldAtExchange();
    await f.runWith(l.page.session.attempts.cancel(handle));
    expect(stateOf(f).attempt).toBeNull();
    held.stop();
    held.release();
    expect(await f.runWith(outcome)).toEqual({ kind: "superseded" });
    await f.settle();
    expect(activations(f)).toBe(sent);
    expect(stateOf(f).settled).toEqual(before);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: before?.account_id,
      epoch: before?.epoch,
    });
    expect(checkProperties(f)).toEqual([]);
  });

  test("cancelled while another page holds atlas-auth (the clear cannot run yet): the grant is still discarded and nothing is activated", async () => {
    const { f, l, before, held, handle, outcome, sent } =
      await switchHeldAtExchange();
    const releaseAuth = await holdLock(f, "H", "atlas-auth");
    const cancelled = l.page.session.attempts.cancel(handle);
    await f.settle();
    held.stop();
    held.release();
    await f.world.advance(20_000);
    expect(await f.runWith(outcome)).toEqual({ kind: "superseded" });
    expect(activations(f)).toBe(sent);
    expect(stateOf(f).settled).toEqual(before);
    releaseAuth();
    await f.runWith(cancelled);
    await f.settle();
    expect(activations(f)).toBe(sent);
    expect(stateOf(f).settled).toEqual(before);
    expect(checkProperties(f)).toEqual([]);
  });

  test("cancelled while the activating write waits for atlas-auth: the write is abandoned before it commits; nothing is activated", async () => {
    const { f, l, before, held, handle, outcome, sent } =
      await switchHeldAtExchange();
    const releaseAuth = await holdLock(f, "H", "atlas-auth");
    held.stop();
    held.release();
    await f.settle();
    // The grant is recorded; the activating write is queued behind H's lock.
    expect(stateOf(f).attempt?.phase).toBe("exchanging");
    expect(stateOf(f).attempt?.target_account_id).not.toBeNull();
    const cancelled = l.page.session.attempts.cancel(handle);
    releaseAuth();
    expect(await f.runWith(outcome)).toEqual({ kind: "superseded" });
    await f.runWith(cancelled);
    await f.settle();
    expect(activations(f)).toBe(sent);
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled).toEqual(before);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: before?.account_id,
    });
    expect(checkProperties(f)).toEqual([]);
  });

  test("the boundary: a cancel after the activating write has committed changes nothing (the gate owns the screen; terminal resolution decides)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => isActivate(r.path));
    const handle = await begin(f, l.page);
    const outcome = l.page.session.attempts.signInWithPassword(handle, {
      username: "sam",
      password: "pw2",
    });
    await f.settle();
    expect(stateOf(f).attempt?.phase).toBe("activating");
    expect(l.page.session.view.get().kind).not.toBe("displaying");
    // Its clear waits for `atlas-auth`, which the activation holds until it has an answer.
    const cancelled = l.page.session.attempts.cancel(handle);
    await f.settle();
    expect(stateOf(f).attempt?.phase).toBe("activating");
    held.stop();
    held.release();
    expect(await f.runWith(outcome)).toMatchObject({ kind: "settled" });
    await f.runWith(cancelled);
    await f.settle();
    expect(stateOf(f).settled?.account_id).not.toBe(l.account);
    expect(checkProperties(f)).toEqual([]);
  });
});

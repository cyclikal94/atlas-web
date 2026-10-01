// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  installAttempt,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-ATT-reload (T5): a reload (the page that owns the attempt is destroyed and a fresh page loads) during EVERY phase of an
 * attempt. A fresh page resolves what it finds by the rules of 3.4.3, never by elapsed time alone, and never loses a verifier that
 * a gating attempt still needs (I1). Account C is settled and displaying throughout; X is the attempt's target.
 */
async function world() {
  const f = await newWorld();
  const l = await signedInPage(f);
  const x = [...f.server.accounts.values()].find((a) => a.username === "sam");
  if (!x) throw new Error("no X");
  return { f, l, x };
}

describe("a fresh page after the owner is gone", () => {
  test("exchanging: cleared at once (nothing was sent that could change the cookie); C keeps displaying", async () => {
    const { f, l } = await world();
    installAttempt(f, { epoch: 2, phase: "exchanging" });
    l.page.destroy();
    const fresh = await openPage(f);
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(fresh.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f)).toEqual([]);
  });

  test("redirected: NOT cleared by the owner's absence; cleared by expiry (720 s)", async () => {
    const { f, l } = await world();
    installAttempt(f, { epoch: 2, phase: "redirected" });
    // installAttempt gives an exchanging-style expiry; a redirected attempt carries the longer one.
    const attempt = stateOf(f).attempt;
    if (attempt)
      attempt.expires_at = new Date(
        Date.UTC(2026, 8, 30, 12, 0, 0) + 720_000,
      ).toISOString();
    l.page.destroy();
    await openPage(f);
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).not.toBeNull();
    await f.world.advance(725_000);
    expect(stateOf(f).attempt).toBeNull();
  });

  test.each(["activating", "indeterminate"] as const)(
    "%s: the gate is raised, nothing is shown until activate/cancel says what became of the grant; then C shows again",
    async (phase) => {
      const { f, l, x } = await world();
      installAttempt(f, {
        epoch: 2,
        phase,
        serverGrant: { account: x.id, state: "issued" },
      });
      l.page.destroy();
      const fresh = await openPage(f);
      await f.world.runUntilIdle();
      // The attempt was resolved by activate/cancel (not_activated: the grant was never redeemed), with no inference from the cookie.
      expect(stateOf(f).attempt).toBeNull();
      expect(stateOf(f).settled?.account_id).toBe(l.account);
      expect(
        f.server.requests.some((r) => r.path.endsWith("/activate/cancel")),
      ).toBe(true);
      expect(fresh.session.view.get().kind).toBe("displaying");
      expect(checkProperties(f)).toEqual([]);
    },
  );

  test("verifying: continues where it stopped (one leased current()), never settles the target", async () => {
    const { f, l, x } = await world();
    installAttempt(f, {
      epoch: 2,
      phase: "verifying",
      cancel: "session_revoked",
      serverGrant: { account: x.id, state: "redeemed", session: null },
    });
    l.page.destroy();
    await openPage(f);
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled?.account_id).toBe(l.account); // the target is NEVER adopted
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("a gating attempt is never cleared by time alone, however long the fresh page stays offline", async () => {
    const { f, l, x } = await world();
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: x.id, state: "issued" },
    });
    l.page.destroy();
    const fresh = f.addPage();
    fresh.env.online = false;
    await f.boot(fresh);
    await f.world.advance(6 * 60 * 60_000);
    expect(stateOf(f).attempt?.phase).toBe("indeterminate");
    expect(stateOf(f).attempt?.verifier).toMatch(/\S{43}/); // I1: the verifier is still there
    expect(fresh.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1c.offline",
    });
    // Connectivity returns: the attempt resolves by activate/cancel, not by the passage of time.
    fresh.goOnline();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
  });
});

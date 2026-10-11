import {
  bootHarness,
  expect,
  exposeSession,
  finishSignIn,
  proxy,
  recordMeasurement,
  records,
  signIn,
  startSignIn,
  test,
  untilHeld,
  untilView,
} from "./helpers";
import {
  ACTIVATE,
  beginOnly,
  CELLS,
  EXCHANGE,
  identityOf,
  pinVisible,
  runOrderingCell,
  sessionCookie,
  signInWithBegun,
  startWrongSignIn,
  wire,
} from "./web08b-support";

/**
 * I-20, I-22 and I-23 (WEB-08b plan 9.3): the ordering traces of the account-lifecycle matrix that WEB-08b owns (T1, T3, T15), run
 * through the session module and its PRODUCTION adapters in a real engine against the RELEASED backend (the version in contract-pin.json, SQLite),
 * with the delaying proxy ordering when the backend PROCESSES a request (`hold_request`) and when its answer is DELIVERED (`hold`).
 *
 * What they prove: in every ordering the cookie changes only at the newest attempt's own activation, a late grant or a late error is
 * discarded without touching the newer attempt, and no `Set-Cookie` arrives except on an `activate` the browser sent. What they do
 * NOT prove: real Safari, a genuine freeze or bfcache (visibility is pinned), a different backend or database, or any account-switch
 * journey (WEB-08c). Visibility is pinned to "visible" so the ORDER of answers is the only variable (see `pinVisible`).
 */
const A_WHO = [
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "frank",
  "grace",
] as const;
const B_WHO = ["heidi", "ivan", "judy", "kate", "liam", "mia", "nora"] as const;

test.describe("I-20: T1, a delayed password login response (server order x delivery window)", () => {
  for (const [i, cell] of CELLS.entries()) {
    test(`I-20 server order ${cell.order} x A's answer delivered ${cell.window}`, async ({
      context,
    }) => {
      await pinVisible(context);
      const aWho = A_WHO[i] as (typeof A_WHO)[number];
      const bWho = B_WHO[i] as (typeof B_WHO)[number];
      const r = await runOrderingCell(context, {
        a: { kind: "password", who: aWho },
        bWho,
        ...cell,
      });
      const writers = r.seen
        .filter((entry) => entry.setCookie)
        .map((e) => e.path);
      expect(r.outcomeB.kind).toBe("settled");
      if (cell.window === "before-B-starts") {
        // A was still the newest attempt: it settled, and B's later start superseded it (settled-A, gated, settled-B).
        expect(r.outcomeA.kind).toBe("settled");
        expect(writers).toEqual([ACTIVATE, ACTIVATE]);
        expect(r.activations).toBe(2);
        const held = r.cookies.filter((c): c is string => c !== null);
        expect(new Set(held).size).toBe(2);
      } else {
        // A's late grant is discarded: it is not redeemed and nothing changes.
        expect(r.outcomeA).toEqual({ kind: "superseded" });
        expect(writers).toEqual([ACTIVATE]); // the only response that set the cookie was B's own activation
        expect(r.activations).toBe(1); // G_A was never redeemed
        const held = r.cookies.filter((c): c is string => c !== null);
        expect(new Set(held).size).toBe(1); // the cookie changed exactly once, and A's late answer did not change it
      }
      // Both tabs end on B's account, with no attempt left, and no grant ever sat in an address.
      const settled = (await records(r.tab1)).auth_state;
      expect(settled.attempt).toBeNull();
      expect(await identityOf(r.tab1)).toBe(r.outcomeB.account_id);
      expect(await identityOf(r.tab2)).toBe(r.outcomeB.account_id);
      expect(r.tab1.url()).not.toContain("atlas_grant");
      // B's account has exactly the session B activated (listed through B's own stamped read).
      const listed = await r.tab2.evaluate(() =>
        window.__retry(() => window.__s.operations.listSessions()),
      );
      expect(listed.ok && listed.value.sessions.length).toBe(
        cell.window === "before-B-starts" ? 1 : 1,
      );
    });
  }

  test("I-20 impossible cell, recorded: server order B-first x A's answer delivered before B starts", async () => {
    // B's login cannot be processed before B has started, and B starts only after A's answer was delivered. Reported, not run.
    test.skip(
      true,
      "structurally impossible ordering (no B request exists before B starts)",
    );
  });

  test("I-20u the superseded notice reaches tab 1 through the real UI, and the form is replaced by the account", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    // Tab 1's form is driven through the UI; tab 2 signs in through the kernel. A's answer is held until B has settled.
    const tab1 = await context.newPage();
    await tab1.goto("/__session?route=%2Ftoday");
    await tab1.getByLabel("Username").waitFor();
    await exposeSession(tab1);
    const tab2 = await bootHarness(context);
    const rule = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await tab1.getByLabel("Username").fill("olga");
    await tab1.getByLabel("Password").fill("a-wrong-password-for-olga");
    await tab1.getByRole("button", { name: "Sign in", exact: true }).click();
    await untilHeld(rule.id);
    expect((await signIn(tab2, "pete")).kind).toBe("settled");
    await untilView(tab2, "displaying");
    await proxy.release(rule.id);
    // A's stale ERROR is discarded: not "That username or password isn't right.", but the superseded notice, over B's account.
    await expect(
      tab1.locator('[data-notice="feedback-superseded"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      tab1.getByText("That username or password isn't right."),
    ).toHaveCount(0);
    expect(await identityOf(tab1)).toBe(await identityOf(tab2));
  });
});

test.describe("I-22: T3, a stale result fails the epoch check in a live tab", () => {
  test("I-22 a stale ERROR (wrong password) while B is still exchanging does not clear B's attempt", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const ruleA = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startWrongSignIn(tab1, "carol");
    await untilHeld(ruleA.id); // the backend answered 401; the answer is held
    const ruleB = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab2, "dave");
    await untilHeld(ruleB.id);
    const before = (await records(tab2)).auth_state.attempt;
    expect(before).toMatchObject({ epoch: 2, phase: "exchanging" });
    await proxy.release(ruleA.id);
    // The caller is told the result was discarded, never "wrong password" for an attempt nobody is waiting on (K-1).
    expect(await finishSignIn(tab1)).toEqual({ kind: "superseded" });
    expect((await records(tab2)).auth_state.attempt).toEqual(before);
    await proxy.release(ruleB.id);
    expect((await finishSignIn(tab2)).kind).toBe("settled");
  });

  test("I-22 a stale ERROR after B settled does not touch B's settlement, and nothing is broadcast to change a tab", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const ruleA = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startWrongSignIn(tab1, "erin");
    await untilHeld(ruleA.id);
    expect((await signIn(tab2, "frank")).kind).toBe("settled");
    await untilView(tab2, "displaying");
    const settled = (await records(tab2)).auth_state.settled;
    const cookie = await sessionCookie(context);
    await proxy.release(ruleA.id);
    expect(await finishSignIn(tab1)).toEqual({ kind: "superseded" });
    const after = (await records(tab2)).auth_state;
    expect(after.settled).toEqual(settled);
    expect(after.attempt).toBeNull();
    expect(await sessionCookie(context)).toBe(cookie);
    expect(await identityOf(tab1)).toBe(settled?.account_id);
  });

  test("I-22 a stale GRANT after B's attempt exists is discarded and redeemed nowhere", async ({
    context,
  }) => {
    await pinVisible(context);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const seen = wire(tab1);
    const ruleA = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab1, "grace");
    await untilHeld(ruleA.id);
    const ruleB = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab2, "heidi");
    await untilHeld(ruleB.id);
    const before = (await records(tab2)).auth_state.attempt;
    await proxy.release(ruleA.id);
    expect(await finishSignIn(tab1)).toEqual({ kind: "superseded" });
    expect((await records(tab2)).auth_state.attempt).toEqual(before);
    expect(seen.filter((e) => e.path === ACTIVATE)).toHaveLength(0);
    await proxy.release(ruleB.id);
    expect((await finishSignIn(tab2)).kind).toBe("settled");
  });
});

test.describe("I-23: T15, two live tabs start sign-ins at once", () => {
  test("I-23a both exchange: the older attempt's grant is discarded, the newer settles", async ({
    context,
  }) => {
    await pinVisible(context);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const first = await beginOnly(tab1, "password");
    const second = await beginOnly(tab2, "password");
    expect([first.epoch, second.epoch]).toEqual([1, 2]);
    const [a, b] = await Promise.all([
      signInWithBegun(tab1, "alice"),
      signInWithBegun(tab2, "bob"),
    ]);
    expect(a).toEqual({ kind: "superseded" });
    expect(b.kind).toBe("settled");
    await untilView(tab1, "displaying");
    expect(await identityOf(tab1)).toBe(b.account_id);
  });

  test("I-23b tab 2 fails: its attempt clears, the previous identity still renders, tab 1 is superseded", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const tab0 = await bootHarness(context);
    expect((await signIn(tab0, "carol")).kind).toBe("settled");
    await untilView(tab0, "displaying");
    const previous = await identityOf(tab0);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    await beginOnly(tab1, "password");
    await beginOnly(tab2, "password");
    const failed = await signInWithBegun(tab2, "dave", "not-dave's-password");
    expect(failed).toMatchObject({ kind: "refused", definitive: true });
    expect((await records(tab2)).auth_state.attempt).toBeNull();
    const late = await signInWithBegun(tab1, "erin");
    expect(late).toEqual({ kind: "superseded" });
    for (const tab of [tab0, tab1, tab2])
      expect(await identityOf(tab)).toBe(previous);
  });

  test("I-23c tab 2 is activating when tab 1 begins: tab 1 waits for the lock and sends nothing, then proceeds once tab 2's activation completes", async ({
    context,
  }) => {
    await pinVisible(context);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const seen1 = wire(tab1);
    const rule = await proxy.addRule({
      method: "POST",
      path: ACTIVATE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab2, "frank");
    await untilHeld(rule.id);
    const started = Date.now();
    await tab1.evaluate(() => {
      window.__t.begin = window.__s.attempts.begin("password");
    });
    await tab1.waitForTimeout(2500);
    // Tab 1's `begin` is still waiting for atlas-auth, and it has sent nothing (no activate of its own).
    expect(
      await tab1.evaluate(
        () => (window.__t.begin as Promise<unknown>) instanceof Promise,
      ),
    ).toBe(true);
    expect(seen1.filter((e) => e.path === ACTIVATE)).toHaveLength(0);
    const log = (await proxy.log()).filter(
      (e) => e.method === "POST" && e.path === ACTIVATE,
    );
    expect(log).toHaveLength(1);
    await proxy.release(rule.id);
    const begun = await tab1.evaluate(
      () => window.__t.begin as Promise<{ kind: string }>,
    );
    const waited = Date.now() - started;
    expect(begun.kind).toBe("started");
    expect((await finishSignIn(tab2)).kind).toBe("settled");
    recordMeasurement(
      "P-8b-4 begin waits for atlas-auth while another tab activates (held 2.5 s)",
      {
        milliseconds: waited,
      },
    );
  });

  test("I-23d a holder that never releases atlas-auth (a frozen tab): the waiter gives up after about 20 s, never steals, and sends nothing", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    await pinVisible(context);
    const tab1 = await bootHarness(context);
    const seen1 = wire(tab1);
    // A real Web Lock, held by another page of the same browser context for as long as that page lives.
    const holder = await context.newPage();
    await holder.goto("/__session?boot=off");
    await holder.evaluate(
      () =>
        new Promise<void>((resolve) => {
          void navigator.locks.request("atlas-auth", () => {
            resolve();
            return new Promise<never>(() => undefined);
          });
        }),
    );
    const started = Date.now();
    const outcome = await tab1.evaluate(() =>
      window.__s.attempts.begin("password"),
    );
    const waited = Date.now() - started;
    expect(outcome.kind).toBe("lock_timeout");
    expect(waited).toBeGreaterThanOrEqual(19_500);
    expect(waited).toBeLessThan(30_000);
    expect(seen1).toHaveLength(0); // nothing was sent
    // The lock is still the holder's: it was not stolen, and no attempt exists.
    expect((await records(tab1)).auth_state.attempt).toBeNull();
    recordMeasurement(
      "P-8b-4 begin gives up against a holder that never releases atlas-auth",
      {
        milliseconds: waited,
        configured_wait_ms: 20_000,
      },
    );
    await holder.close();
    // Once the holder is gone a sign-in proceeds.
    expect((await signIn(tab1, "judy")).kind).toBe("settled");
  });
});

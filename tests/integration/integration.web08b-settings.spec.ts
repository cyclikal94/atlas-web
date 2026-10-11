import {
  ACCOUNTS,
  bootHarness,
  challengeFor,
  expect,
  exposeSession,
  freshVerifier,
  liftedAt,
  proxy,
  raw,
  recordMeasurement,
  records,
  test,
  untilView,
  watchLift,
} from "./helpers";
import {
  ACTIVATE,
  credentialsWork,
  EXCHANGE,
  pinVisible,
  strongPassword,
  uiSignIn,
} from "./web08b-support";

/**
 * I-29 and I-30 (WEB-08b plan 9.3): the Settings account card and "Signing in" dialog, and the production sign-in surface, through the
 * real UI against the RELEASED backend (the version in contract-pin.json, SQLite). What passing proves: the contract's own `GET /me` fields are what the
 * screens show; a password change signs the session out everywhere and the new password works; a WRONG current password is a `401`
 * that ends the session into "Reconnect to keep going" (design gap G-16, recorded not fixed); the sign-in surface refuses, throttles
 * and recovers as designed. What it does NOT prove: recovery after re-authentication (state 2 stays until WEB-09b), real Safari, or
 * assistive technology.
 */
async function openSigningIn(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.locator('[data-settings-link="signing-in"]').click();
  const dialog = page.getByRole("dialog", { name: "Signing in" });
  await dialog.getByLabel("Current password").waitFor();
  return dialog;
}

test.describe("I-29: Settings against the real backend", () => {
  test("I-29a GET /me is rendered as text with exactly the contract's fields; one read through the module costs a measured amount", async ({
    context,
  }) => {
    await pinVisible(context);
    const page = await bootHarness(context, "/");
    await uiSignIn(page, "mia");
    await untilView(page, "displaying");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("[data-account-card]")).toContainText(
      ACCOUNTS.mia.username,
    );
    await expect(page.locator("[data-account-card]")).toContainText(
      /^.*Signed in since \d{2}:\d{2} · /s,
    );
    const account = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.readAccount()),
    );
    expect(account.ok).toBe(true);
    if (account.ok) {
      expect(Object.keys(account.value).sort()).toEqual([
        "has_password",
        "id",
        "oidc_issuers",
        "username",
      ]);
      expect(account.value).toMatchObject({
        username: ACCOUNTS.mia.username,
        has_password: true,
        oidc_issuers: [],
      });
    }
    // P-8b-5: one GET /me through `ordinary()` (the cover, the lease, the two durable checks), 20 in sequence.
    const timings = await page.evaluate(async () => {
      const out: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const t = performance.now();
        await window.__retry(() => window.__s.operations.readAccount());
        out.push(performance.now() - t);
      }
      return out;
    });
    const sorted = [...timings].sort((a, b) => a - b);
    recordMeasurement("P-8b-5 one GET /me through ordinary() (20 reads)", {
      median_ms: sorted[10],
      p90_ms: sorted[18],
      max_ms: sorted[19],
      min_ms: sorted[0],
    });
    // The same read, sealed against the identity: nothing is returned for an account that is no longer settled.
    const dialog = await openSigningIn(page);
    await expect(
      dialog.getByText("No single sign-on is linked to this account."),
    ).toBeVisible();
  });

  test("I-29b the right current password: 204, every session ends, the view is 'Reconnect to keep going', and ONLY the new password signs in", async ({
    context,
  }) => {
    await pinVisible(context);
    const who = "nora";
    const oldPassword = ACCOUNTS[who].password;
    const next = strongPassword();
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    await dialog.getByLabel("Current password").fill(oldPassword);
    await dialog.getByLabel("New password").fill(next);
    await dialog.getByRole("button", { name: "Change password" }).click();
    await untilView(page, "neutral", "1b");
    await expect(
      page.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible();
    // Nothing of the account is on the screen, and the old password no longer works.
    expect(await credentialsWork(ACCOUNTS[who].username, oldPassword)).toBe(
      false,
    );
    expect(await credentialsWork(ACCOUNTS[who].username, next)).toBe(true);
    // Reconnect with the new password: the same account, in state 2 (recovery is WEB-09b's).
    await page.getByRole("button", { name: "Reconnect" }).click();
    await uiSignIn(page, who, next);
    await untilView(page, "neutral", "2");
    expect((await records(page)).auth_state.settled).not.toBeNull();
  });

  test("I-29d a password change held by a gateway past the app's time-out stays UNCONFIRMED when 'Check now' finds the session working; the late request then commits (review R3)", async ({
    context,
    provokes,
  }) => {
    // The check after the commit finds the session revoked: a 401, which is the answer, not a fault.
    provokes(401);
    test.setTimeout(150_000);
    await pinVisible(context);
    const who = "quinn";
    const oldPassword = ACCOUNTS[who].password;
    const next = strongPassword();
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    await dialog.getByLabel("Current password").fill(oldPassword);
    await dialog.getByLabel("New password").fill(next);
    // A gateway that has ACCEPTED the whole request and delivers it late: unlike `hold_request` it forwards it even after the
    // application has timed out and gone, which is exactly the case a successful `GET /me` cannot see.
    const { id } = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/password",
      action: "buffer_request",
      ordinal: 1,
    });
    await dialog.getByRole("button", { name: "Change password" }).click();
    await expect.poll(async () => (await proxy.held())[id] ?? 0).toBe(1);
    // The application's own request time-out (30 s) ends the wait: the outcome is unknown.
    const unconfirmed = page.locator("[data-unconfirmed]");
    await expect(unconfirmed).toBeVisible({ timeout: 60_000 });
    // The session still works NOW: the read succeeds. That is not evidence about the request still sitting at the gateway.
    await unconfirmed.getByRole("button", { name: "Check now" }).click();
    await expect(unconfirmed.locator("[data-still-unconfirmed]")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      /nothing changed|didn't go through/i,
    );
    await expect(unconfirmed).toContainText("We couldn't confirm that.");
    // The gateway delivers the request; the backend commits it. The claim that nothing changed would now be false.
    await proxy.release(id);
    await expect
      .poll(
        async () => (await proxy.log()).find((e) => e.rule === id)?.status,
        {
          timeout: 15_000,
        },
      )
      .toBe(204);
    expect(await credentialsWork(ACCOUNTS[who].username, next)).toBe(true);
    expect(await credentialsWork(ACCOUNTS[who].username, oldPassword)).toBe(
      false,
    );
    // The next check finds the session gone, and the neutral state is the honest end of the uncertainty.
    await unconfirmed.getByRole("button", { name: "Check now" }).click();
    await untilView(page, "neutral", "1b");
    recordMeasurement(
      "I-29d R3 evidence: a working session did not prove the held change failed",
      {
        upstream_status: 204,
        new_password_works: true,
        old_password_works: false,
        view: "neutral/1b",
      },
    );
  });

  test("I-29e a password change the backend COMMITTED, whose answer a gateway replaced with 502, is UNCONFIRMED and never 'try again shortly' (review R6)", async ({
    context,
    provokes,
  }) => {
    // The 502 is the gateway's; the check after the commit finds the session revoked, a 401, which is the answer and not a fault.
    provokes(502, 401);
    await pinVisible(context);
    const who = "liam";
    const oldPassword = ACCOUNTS[who].password;
    const next = strongPassword();
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    await dialog.getByLabel("Current password").fill(oldPassword);
    await dialog.getByLabel("New password").fill(next);
    // The proxy forwards the request, so the backend EXECUTES it, and then answers 502 with none of the backend's headers.
    const { id } = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/password",
      ordinal: 1,
      action: "rewrite_status",
      status: 502,
    });
    await dialog.getByRole("button", { name: "Change password" }).click();
    await expect
      .poll(async () =>
        (await proxy.log())
          .find((e) => e.rule === id)
          ?.events.some((e) => e.event === "delivered" && e.status === 502),
      )
      .toBe(true);
    const entry = (await proxy.log()).find((e) => e.rule === id);
    expect(entry?.status, "the status the backend answered").toBe(204);
    // What the backend did, proved independently of the page: the new password works and the old one does not.
    expect(await credentialsWork(ACCOUNTS[who].username, next)).toBe(true);
    expect(await credentialsWork(ACCOUNTS[who].username, oldPassword)).toBe(
      false,
    );
    const unconfirmed = page.locator("[data-unconfirmed]");
    await expect(unconfirmed).toBeVisible();
    await expect(unconfirmed).toContainText("We couldn't confirm that.");
    await expect(dialog).not.toContainText("Try again shortly");
    await expect(dialog.locator("[data-error]")).toHaveCount(0);
    // Nothing was sent again, and the check finds the session gone: the neutral state is the honest end.
    expect(
      (await proxy.log()).filter(
        (e) =>
          e.method === "POST" && e.path === "/api/experimental/v1/password",
      ),
    ).toHaveLength(1);
    await unconfirmed.getByRole("button", { name: "Check now" }).click();
    await untilView(page, "neutral", "1b");
    recordMeasurement(
      "I-29e R6 evidence: a committed password change answered 502 by a gateway",
      {
        upstream_status: 204,
        delivered_status: 502,
        new_password_works: true,
        old_password_works: false,
        view: "neutral/1b",
      },
    );
  });

  test("I-29c a WRONG current password is a 401, and the 401 ends the session: 'Reconnect to keep going' (design gap G-16, characterised)", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const who = "olga";
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    await expect(
      dialog.getByText(
        "If your current password is wrong, this session will also end.",
      ),
    ).toBeVisible();
    await dialog
      .getByLabel("Current password")
      .fill("definitely-not-the-password");
    await dialog.getByLabel("New password").fill(strongPassword());
    await dialog.getByRole("button", { name: "Change password" }).click();
    await untilView(page, "neutral", "1b");
    const fences = Object.values(
      (await records(page)).auth_state.fences,
    ).flat();
    expect(fences.some((f) => f.kind === "invalid_session")).toBe(true);
    recordMeasurement(
      "I-29c G-16 evidence: a wrong current password ends the session",
      {
        view: "neutral/1b",
        fence: "invalid_session",
      },
    );
    // Nothing changed on the server: the OLD password still signs in.
    expect(
      await credentialsWork(ACCOUNTS[who].username, ACCOUNTS[who].password),
    ).toBe(true);
  });
});

test.describe("I-30: the sign-in surface against the real backend", () => {
  test("I-30a a wrong password is refused under the password field with the request id; nothing is on the page about any account", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const page = await bootHarness(context, "/");
    const before = await page.locator("body").innerText();
    for (const who of Object.values(ACCOUNTS))
      expect(before).not.toContain(who.username);
    expect(
      await page
        .locator("#protected-root")
        .evaluate((el) => el.childElementCount),
    ).toBe(0);
    await uiSignIn(page, "ivan", "this-is-not-ivans-password");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("That username or password isn't right.");
    await expect(alert).toContainText(/Request ID: [0-9a-f-]{36}/);
    await expect(page.getByLabel("Password")).toBeFocused();
    await expect(page.getByLabel("Password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel("Password")).toHaveValue("");
    expect((await records(page)).auth_state.settled).toBeNull();
  });

  test("I-30b after the per-account window the backend answers 429 and the surface says so (one bounded probe)", async ({
    context,
    provokes,
  }) => {
    provokes(401, 429);
    await pinVisible(context);
    const who = "pete";
    let reached = 0;
    // At most 12 wrong exchanges (the backend allows 10 per account per window): stop at the first 429.
    for (let i = 0; i < 12 && reached === 0; i += 1) {
      const answer = await raw("POST", "/browser-sessions", {
        body: {
          username: ACCOUNTS[who].username,
          password: `wrong-${i}`,
          attempt_challenge: await challengeFor(freshVerifier()),
          device_id: "i30b",
        },
      });
      if (answer.status === 429) reached = i + 1;
    }
    expect(reached, "the backend throttled within 12 attempts").toBeGreaterThan(
      0,
    );
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who, "wrong-again");
    await expect(page.getByRole("alert")).toContainText(
      "Too many attempts. Wait a minute, then try again.",
    );
    recordMeasurement("I-30b the attempt at which the backend answered 429", {
      attempts: reached,
    });
  });

  test("I-30c offline: the form is greyed with the reason, nothing is sent, and it recovers when the connection returns", async ({
    context,
  }) => {
    await pinVisible(context);
    const page = await bootHarness(context, "/");
    const sent = (await proxy.log()).length;
    await context.setOffline(true);
    await expect(
      page.getByText("Signing in needs a connection."),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    expect((await proxy.log()).length).toBe(sent);
    await context.setOffline(false);
    await expect(page.getByLabel("Username")).toBeEnabled();
  });

  test("I-30d a deep link keeps its URL through sign-in and opens after it", async ({
    context,
  }) => {
    await pinVisible(context);
    const page = await bootHarness(context, "/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/settings");
    await uiSignIn(page, "judy");
    await untilView(page, "displaying");
    expect(new URL(page.url()).pathname).toBe("/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await expect(page.locator("[data-account-card]")).toContainText(
      ACCOUNTS.judy.username,
    );
  });

  test("I-30e where the time goes in a password sign-in (measurement, not a threshold)", async ({
    context,
  }) => {
    await pinVisible(context);
    const page = await bootHarness(context, "/");
    await watchLift(page);
    const started = Date.now();
    const steps = await page.evaluate(async (c) => {
      const t0 = performance.now();
      const begun = await window.__s.attempts.begin("password");
      const t1 = performance.now();
      if (begun.kind !== "started") throw new Error(begun.kind);
      const outcome = await window.__s.attempts.signInWithPassword(
        begun.handle,
        c,
      );
      const t2 = performance.now();
      return {
        outcome: outcome.kind,
        begin_ms: t1 - t0,
        exchange_activate_settle_ms: t2 - t1,
      };
    }, ACCOUNTS.kate);
    expect(steps.outcome).toBe("settled");
    await untilView(page, "displaying");
    const log = await proxy.log();
    const tail = (path: string) =>
      [...log].reverse().find((e) => e.method === "POST" && e.path === path);
    const delivered = (entry?: {
      events: Array<{ t: number; event: string }>;
    }) => entry?.events.find((e) => e.event === "delivered")?.t;
    await expect.poll(() => liftedAt(page)).not.toBeNull();
    recordMeasurement("P-8b-1 password sign-in per step", {
      begin_ms: Math.round(steps.begin_ms),
      exchange_activate_settle_ms: Math.round(
        steps.exchange_activate_settle_ms,
      ),
      exchange_request_ms: delivered(tail(EXCHANGE)),
      activate_request_ms: delivered(tail(ACTIVATE)),
      first_protected_paint_ms: ((await liftedAt(page)) ?? started) - started,
    });
    void exposeSession;
  });
});

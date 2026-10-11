import { captureHandoff } from "../../src/features/authentication/handoff";
import {
  ACCOUNTS,
  bootHarness,
  challengeFor,
  expect,
  exposeSession,
  finishSignIn,
  freshVerifier,
  OIDC,
  ORIGIN,
  provider,
  proxy,
  raw,
  rawSignIn,
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
  addressLog,
  EXCHANGE,
  followNavigation,
  identityOf,
  linkIdentity,
  pinVisible,
  sessionCookie,
  startAtProvider,
  uiSignIn,
  watchAddress,
} from "./web08b-support";

/**
 * I-21, I-27 and I-28a (WEB-08b plan 9.3): browser OIDC against the RELEASED backend (the version in contract-pin.json) and a STUB identity provider
 * (`scripts/integration/oidc-provider.mjs`, loopback, S256 PKCE, RS256 ID token with a correct `at_hash`). The stub satisfies the
 * released backend's own `openidconnect` validation; a real provider's claims, key rotation, consent screens and failure redirects
 * are NOT exercised. The callback's redirect target is the preview origin's root, which the integration build serves with the
 * production composition (the fixture harness), so the landing is the real boot path.
 */
const CALLBACK = "/api/experimental/v1/oidc/callback";
const unique = (label: string) =>
  `${label}-${Math.random().toString(36).slice(2, 10)}`;

/** How many `activate` requests the backend has seen so far (set-up sign-ins included, so assert a DELTA from a baseline). */
const activationCount = async () =>
  (await proxy.log()).filter((e) => e.method === "POST" && e.path === ACTIVATE)
    .length;

/**
 * Park the provider (optionally), send the page to it, and return the pending navigation INSIDE an object: an async function
 * that returned the promise itself would be awaited by its caller, and the navigation does not finish until the provider answers.
 */
async function sendToProvider(
  page: import("@playwright/test").Page,
  hold: boolean,
) {
  if (hold) await provider.hold(true);
  const url = await startAtProvider(page);
  const navigation = page.goto(url).catch(() => undefined);
  if (hold)
    await expect.poll(() => provider.waiting(), { timeout: 15_000 }).toBe(1);
  return { navigation };
}

test.describe("I-21: T2, a stale OIDC redirect arriving after B has started or settled", () => {
  test.beforeEach(() => {
    test.skip(
      !OIDC,
      "this stack did not configure the stub OpenID Connect provider",
    );
  });

  test("I-21a the provider completes after B settled: the landing tab (with B's identity) discards it; nothing changes; the grant is never redeemed", async ({
    context,
  }) => {
    await pinVisible(context);
    await watchAddress(context);
    const sub = unique("t2a");
    await linkIdentity("alice", sub);
    await provider.subject(sub);
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const { navigation } = await sendToProvider(tab1, true);
    expect((await signIn(tab2, "bob")).kind).toBe("settled");
    await untilView(tab2, "displaying");
    const cookie = await sessionCookie(context);
    const settled = (await records(tab2)).auth_state.settled;
    const activationsBefore = await activationCount();
    await provider.release();
    await navigation;
    await exposeSession(tab1);
    // The landing document stripped the fragment before any request it made, and the grant is nowhere in the address.
    expect(tab1.url()).not.toContain("atlas_grant");
    const log = await addressLog(tab1);
    expect(log.replaces.length).toBeGreaterThanOrEqual(1);
    for (const url of log.urls) expect(url).not.toContain("atlas_grant");
    // The landing was discarded: no cookie change, no new settlement, no activation (the grant was not redeemed).
    expect(await sessionCookie(context)).toBe(cookie);
    expect((await records(tab1)).auth_state.settled).toEqual(settled);
    expect((await proxy.log()).filter((e) => e.path === ACTIVATE).length).toBe(
      activationsBefore,
    );
    expect(await identityOf(tab1)).toBe(settled?.account_id);
    // The person is told, over B's account.
    await expect(
      tab1.locator('[data-notice="feedback-superseded"]'),
    ).toBeVisible({ timeout: 30_000 });
    // B's account has only B's own session: the provider's account got none.
    const listed = await tab1.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    expect(listed.ok && listed.value.sessions.length).toBe(1);
  });

  test("I-21b the provider completes while B is exchanging: the landing tab with NO settled identity discards it and shows the superseded banner on the sign-in page", async ({
    context,
  }) => {
    await pinVisible(context);
    await watchAddress(context);
    const sub = unique("t2b");
    await linkIdentity("carol", sub);
    await provider.subject(sub);
    const baseline = await activationCount();
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    const { navigation } = await sendToProvider(tab1, true);
    const rule = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab2, "dave");
    await untilHeld(rule.id);
    const attempt = (await records(tab2)).auth_state.attempt;
    expect(attempt).toMatchObject({ epoch: 2, phase: "exchanging" });
    await provider.release();
    await navigation;
    await exposeSession(tab1);
    expect(tab1.url()).not.toContain("atlas_grant");
    // Nobody is settled, so the landing tab is on the sign-in page, with the banner; B's attempt is untouched.
    expect((await records(tab1)).auth_state.settled).toBeNull();
    expect((await records(tab1)).auth_state.attempt).toEqual(attempt);
    expect(await sessionCookie(context)).toBeNull();
    await expect(tab1.locator('[data-feedback="superseded"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(tab1.getByLabel("Username")).toBeVisible();
    await proxy.release(rule.id);
    expect((await finishSignIn(tab2)).kind).toBe("settled");
    expect((await activationCount()) - baseline).toBe(1); // only B's: the provider's grant was never redeemed
  });

  test("I-21c the callback was processed before B started but its redirect is delivered after B settled: discarded", async ({
    context,
  }) => {
    await pinVisible(context);
    await watchAddress(context);
    const sub = unique("t2c");
    await linkIdentity("erin", sub);
    await provider.subject(sub);
    const baseline = await activationCount();
    const tab1 = await bootHarness(context);
    const tab2 = await bootHarness(context);
    // The backend processes the callback (issuing the grant) at once; its answer is held at the proxy.
    const rule = await proxy.addRule({
      method: "GET",
      path: CALLBACK,
      action: "hold",
      ordinal: 1,
    });
    const { navigation } = await sendToProvider(tab1, false);
    await untilHeld(rule.id);
    expect((await signIn(tab2, "frank")).kind).toBe("settled");
    await untilView(tab2, "displaying");
    const cookie = await sessionCookie(context);
    const settled = (await records(tab2)).auth_state.settled;
    await proxy.release(rule.id);
    await navigation;
    await exposeSession(tab1);
    expect(tab1.url()).not.toContain("atlas_grant");
    expect(await sessionCookie(context)).toBe(cookie);
    expect((await records(tab1)).auth_state.settled).toEqual(settled);
    expect((await activationCount()) - baseline).toBe(1); // only B's
    await expect(
      tab1.locator('[data-notice="feedback-superseded"]'),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("I-27: single sign-on through the real UI, and the attempt id round trip", () => {
  test.beforeEach(() => {
    test.skip(
      !OIDC,
      "this stack did not configure the stub OpenID Connect provider",
    );
  });

  test("I-27 password sign-in, LINK single sign-on, sign out, sign in WITH single sign-on as the same account, then REMOVE the link", async ({
    context,
  }) => {
    test.setTimeout(150_000);
    await pinVisible(context);
    await watchAddress(context);
    const who = "kate";
    const sub = unique("t27");
    await provider.subject(sub);
    const page = await context.newPage();
    await page.goto("/__session?route=%2F");
    await exposeSession(page);

    // 1. Password sign-in through the form, then Settings > Signing in > Link single sign-on.
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.locator('[data-settings-link="signing-in"]').click();
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await expect(
      dialog.getByText("No single sign-on is linked to this account."),
    ).toBeVisible();
    // The browser goes to the provider and comes back to the origin with the grant in the fragment: a NEW document.
    await followNavigation(page, () =>
      dialog.getByRole("button", { name: "Link single sign-on" }).click(),
    );
    await untilView(page, "displaying");
    await expect(
      page.locator('[data-notice="feedback-message"]'),
    ).toContainText("Single sign-on is now linked to your account.", {
      timeout: 30_000,
    });
    expect(page.url()).not.toContain("atlas_grant");
    for (const url of (await addressLog(page)).urls)
      expect(url).not.toContain("atlas_grant");
    // listSessions now shows an `oidc` row; the issuer is shown as its HOST.
    const listed = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    expect(
      listed.ok &&
        listed.value.sessions.some((row) => row.authentication === "oidc"),
    ).toBe(true);
    const account = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.readAccount()),
    );
    expect(account.ok && account.value.oidc_issuers).toEqual([OIDC?.issuer]);
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.locator('[data-settings-link="signing-in"]').click();
    await expect(
      page.getByRole("dialog", { name: "Signing in" }).locator("[data-issuer]"),
    ).toHaveText(new URL(OIDC?.issuer ?? "").host);
    await page.keyboard.press("Escape");

    // 2. Sign out (the warning, then confirm), then sign in WITH single sign-on: the same account.
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Sign out" })
      .click();
    await page
      .getByRole("dialog", { name: "Log out?" })
      .getByRole("button", { name: "Log out", exact: true })
      .click();
    await untilView(page, "signed_out");
    await expect(page.getByLabel("Username")).toBeVisible({ timeout: 30_000 });
    const started = Date.now();
    await followNavigation(page, () =>
      page.getByRole("button", { name: "Use single sign-on instead" }).click(),
    );
    await untilView(page, "displaying");
    recordMeasurement(
      "P-8b-3 OIDC sign-in from the button to a displaying view (start, provider, callback, landing, activation, settlement)",
      {
        milliseconds: Date.now() - started,
      },
    );
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("[data-account-card]")).toContainText(
      ACCOUNTS[who].username,
    );

    // 3. Remove the link within five minutes (it needs the local password): the session ends, and the password still works.
    await page.locator('[data-settings-link="signing-in"]').click();
    await page
      .getByRole("dialog", { name: "Signing in" })
      .getByRole("button", { name: /^Remove/ })
      .click();
    await untilView(page, "neutral", "1b");
    await expect(
      page.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await uiSignIn(page, who);
    // The password signs in as the SAME account. The view is state 2 ("Catching up"), not the account: an older-epoch fence
    // remains and clearing it is the recovery job's (WEB-09b), which does not exist yet. That is the designed state for this slice,
    // and the person's content stays hidden, never shown stale (docs/session.md).
    await untilView(page, "neutral", "2");
    const settled = (await records(page)).auth_state.settled;
    const same = await rawSignIn(who);
    expect(settled?.account_id).toBe(same.accountId);
    // The link is gone on the backend, and the password still works.
    const me = await raw("GET", "/me", {
      cookie: same.cookie,
      headers: { "x-csrf-token": same.csrf },
    });
    expect(me.json).toMatchObject({
      username: ACCOUNTS[who].username,
      oidc_issuers: [],
    });
  });

  test("I-27r the attempt id round-trips through the backend's callback fragment byte for byte; the client's own ids are digits and anything else is invalid and stripped", async () => {
    const sub = unique("t27r");
    await linkIdentity("liam", sub);
    await provider.subject(sub);
    const weird = "8&=+%x ä";
    const verifier = freshVerifier();
    const start = await raw("POST", "/oidc/start", {
      body: {
        device_id: "i27r",
        link: false,
        attempt_id: weird,
        attempt_challenge: await challengeFor(verifier),
      },
    });
    expect(start.status).toBe(200);
    const binding = start.setCookie.map((c) => c.split(";")[0]).join("; ");
    const authorised = await fetch(
      (start.json as { authorization_url: string }).authorization_url,
      { redirect: "manual" },
    );
    const done = await fetch(authorised.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { cookie: binding },
    });
    expect(done.status).toBe(303);
    const location = new URL(done.headers.get("location") ?? "");
    expect(location.origin).toBe(ORIGIN);
    // `URLSearchParams` is the right decoder: the value comes back exactly.
    const params = new URLSearchParams(location.hash.slice(1));
    expect(params.get("atlas_attempt")).toBe(weird);
    // The client never produces such an id (`String(epoch)`), so this fragment is not ours: invalid, and STILL stripped.
    const replaced: string[] = [];
    const handoff = captureHandoff({
      pathname: "/",
      search: "",
      hash: location.hash,
      replaceState: (url) => replaced.push(url),
    });
    expect(handoff.oidc).toEqual({ kind: "invalid" });
    expect(replaced).toEqual(["/"]);
  });
});

test.describe("I-27 (review R6, R7, R8): the credential controls of Signing in with a linked identity", () => {
  test.beforeEach(() => {
    test.skip(
      !OIDC,
      "this stack did not configure the stub OpenID Connect provider",
    );
  });
  const openSigningIn = async (page: import("@playwright/test").Page) => {
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.locator('[data-settings-link="signing-in"]').click();
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await dialog.getByLabel("Current password").waitFor();
    await expect(dialog.locator("[data-issuer]")).toBeVisible();
    return dialog;
  };

  test("I-27g an identity removal the backend COMMITTED, whose answer a gateway replaced with 502, is UNCONFIRMED and not 'can't remove' (review R6)", async ({
    context,
    provokes,
  }) => {
    provokes(502, 401);
    await pinVisible(context);
    const who = "nora";
    await linkIdentity(who, unique("t27g"));
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    const { id } = await proxy.addRule({
      method: "DELETE",
      path: "/api/experimental/v1/oidc/identities",
      ordinal: 1,
      action: "rewrite_status",
      status: 502,
    });
    await dialog.getByRole("button", { name: /^Remove / }).click();
    await expect
      .poll(async () =>
        (await proxy.log())
          .find((e) => e.rule === id)
          ?.events.some((e) => e.event === "delivered" && e.status === 502),
      )
      .toBe(true);
    const entry = (await proxy.log()).find((e) => e.rule === id);
    expect(entry?.status, "the status the backend answered").toBe(204);
    // Proved independently of the page: the issuer is gone from the account.
    const auth = await rawSignIn(who);
    const me = await raw("GET", "/me", {
      cookie: auth.cookie,
      headers: { "x-csrf-token": auth.csrf },
    });
    expect(me.json).toMatchObject({ oidc_issuers: [] });
    const unconfirmed = page.locator("[data-unconfirmed]");
    await expect(unconfirmed).toBeVisible();
    await expect(unconfirmed).toContainText("We couldn't confirm that.");
    await expect(dialog).not.toContainText("Can't remove this identity");
    await expect(dialog.locator("[data-error]")).toHaveCount(0);
    expect(
      (await proxy.log()).filter(
        (e) =>
          e.method === "DELETE" &&
          e.path === "/api/experimental/v1/oidc/identities",
      ),
    ).toHaveLength(1);
    await unconfirmed.getByRole("button", { name: "Check now" }).click();
    await untilView(page, "neutral", "1b");
    recordMeasurement(
      "I-27g R6 evidence: a committed identity removal answered 502 by a gateway",
      {
        upstream_status: 204,
        delivered_status: 502,
        issuer_removed: true,
        view: "neutral/1b",
      },
    );
  });

  test("I-27h offline: Change password, Remove and Link single sign-on are disabled with their reasons, nothing is sent, and they return with the connection (review R7)", async ({
    context,
  }) => {
    await pinVisible(context);
    const who = "grace";
    await linkIdentity(who, unique("t27h"));
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    await dialog.getByLabel("Current password").fill(ACCOUNTS[who].password);
    await dialog.getByLabel("New password").fill("a-new-password-for-grace-1");
    const controls = [
      dialog.getByRole("button", { name: "Change password" }),
      dialog.getByRole("button", { name: /^Remove/ }),
      dialog.getByRole("button", { name: "Link single sign-on" }),
    ];
    for (const control of controls) await expect(control).toBeEnabled();
    const sent = (await proxy.log()).length;
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    for (const control of controls) await expect(control).toBeDisabled();
    for (const reason of [
      "Changing your password needs a connection.",
      "Removing a single sign-on link needs a connection.",
      "Linking single sign-on needs a connection.",
    ])
      await expect(dialog.getByText(reason)).toBeVisible();
    // What was typed is kept, and nothing reached the backend.
    await expect(dialog.getByLabel("New password")).toHaveValue(
      "a-new-password-for-grace-1",
    );
    expect((await proxy.log()).length).toBe(sent);
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    for (const control of controls) await expect(control).toBeEnabled();
  });

  // Review R8. The reason, exactly: the Link hint ("This needs a sign-in from the last few minutes.") is always on screen.
  const STALE =
    "Needs a sign-in from the last few minutes. Sign out and in again first.";

  test("I-27i the five-minute window ended while Signing in stayed open and no timer has run: an activation sends nothing to the backend and shows why (review R8; the clock is SIMULATED in the page)", async ({
    context,
  }) => {
    await pinVisible(context);
    // Playwright's clock moves time in the PAGE only. The session's `created_at` is the released backend's own and real; what is
    // simulated is how old the page believes it to be, so this shows the schedule against real data, not the backend's refusal.
    await context.clock.install({ time: Date.now() });
    const who = "ivan";
    await linkIdentity(who, unique("t27i"));
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const dialog = await openSigningIn(page);
    const remove = dialog.getByRole("button", { name: /^Remove/ });
    const link = dialog.getByRole("button", { name: "Link single sign-on" });
    await expect(remove).toBeEnabled();
    await expect(link).toBeEnabled();
    const sent = (await proxy.log()).length;
    // The time moves; no timer is run (a hidden tab, a suspended device).
    await context.clock.setSystemTime(new Date(Date.now() + 6 * 60_000));
    await remove.click();
    await expect(dialog.getByText(STALE, { exact: true })).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Remove" })).toBeDisabled();
    await expect(link).toBeDisabled();
    await expect(dialog.locator("[data-error]")).toHaveCount(0);
    await expect(dialog.locator("[data-unconfirmed]")).toHaveCount(0);
    const afterwards = (await proxy.log()).slice(sent);
    expect(
      afterwards.filter(
        (e) =>
          (e.method === "DELETE" && e.path.endsWith("/oidc/identities")) ||
          e.path.endsWith("/oidc/start"),
      ),
      "nothing reached the backend",
    ).toEqual([]);
    recordMeasurement(
      "I-27i R8 evidence: an activation after the simulated deadline",
      {
        requests_after_click: afterwards.length,
        unlink_or_link_requests: 0,
        clock: "simulated in the page (Playwright), session created_at real",
      },
    );
  });

  // The elapsed-time consequence in REAL time: about five and a half minutes, so it runs only when asked for
  // (`ATLAS_INTEGRATION_REALTIME=1 node scripts/integration/run.mjs --browsers chromium --grep I-27k`). Skipped, it is reported as
  // not run, never as passed.
  test("I-27k [real time, opt-in] the controls disable themselves at the page's deadline with the dialog left open, and the released backend itself refuses a session older than five minutes (review R8)", async ({
    context,
  }) => {
    test.skip(
      !process.env.ATLAS_INTEGRATION_REALTIME,
      "takes about five and a half minutes of real time: set ATLAS_INTEGRATION_REALTIME=1 to run it",
    );
    test.setTimeout(8 * 60_000);
    await pinVisible(context);
    const who = "judy";
    await linkIdentity(who, unique("t27k"));
    const before = Date.now();
    const page = await bootHarness(context, "/");
    await uiSignIn(page, who);
    await untilView(page, "displaying");
    const signedIn = Date.now();
    // A second session of the same account, made with raw HTTP now, ages alongside the page's: at the end it asks the SERVER the
    // question the page only estimates.
    const aging = await rawSignIn(who);
    const agingStarted = Date.now();
    const dialog = await openSigningIn(page);
    const remove = dialog.getByRole("button", { name: /^Remove/ });
    const link = dialog.getByRole("button", { name: "Link single sign-on" });
    await expect(remove).toBeEnabled();
    await expect(link).toBeEnabled();

    // The dialog stays open and nothing is pressed. The window is five minutes less a 30 s margin from the session's creation,
    // which is between `before` and `signedIn` by this machine's clock (the backend is local).
    await expect(remove).toBeDisabled({ timeout: 6 * 60_000 });
    const disabledAfter = Date.now();
    await expect(link).toBeDisabled();
    await expect(dialog.getByText(STALE, { exact: true })).toHaveCount(2);
    expect(
      disabledAfter - before,
      "not before the window ended",
    ).toBeGreaterThan(269_000);
    expect(
      disabledAfter - signedIn,
      "not much after the window ended",
    ).toBeLessThan(270_000 + 5_000);
    const pageRequests = (await proxy.log()).filter(
      (e) =>
        (e.method === "DELETE" && e.path.endsWith("/oidc/identities")) ||
        e.path.endsWith("/oidc/start"),
    );
    // Link-start and unlink requests seen so far are only the set-up's own (`linkIdentity`'s start); none is an unlink.
    expect(
      pageRequests.filter((e) => e.method === "DELETE"),
      "the page sent no removal",
    ).toEqual([]);

    // Now the server's own answer, once ITS five minutes have passed (the second session is the younger one).
    const wait = agingStarted + 300_000 + 5_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const me = await raw("GET", "/me", {
      cookie: aging.cookie,
      headers: { "x-csrf-token": aging.csrf },
    });
    const issuers = (me.json as { oidc_issuers?: string[] }).oidc_issuers ?? [];
    const issuer = issuers[0] ?? "";
    // The session is older than five minutes: its `GET /me` still answers (it is a valid session), the two operations that need a
    // fresh one do not.
    const unlink = await raw("DELETE", "/oidc/identities", {
      cookie: aging.cookie,
      headers: { "x-csrf-token": aging.csrf },
      body: { issuer },
    });
    const linkStart = await raw("POST", "/oidc/start", {
      cookie: aging.cookie,
      headers: { "x-csrf-token": aging.csrf },
      body: {
        device_id: `aged-${freshVerifier().slice(0, 8)}`,
        link: true,
        attempt_id: "1",
        attempt_challenge: await challengeFor(freshVerifier()),
      },
    });
    recordMeasurement(
      "I-27k R8 evidence: real time, the page's deadline and the server's refusal",
      {
        page_disabled_after_ms_of_sign_in_start: disabledAfter - before,
        page_disabled_after_ms_of_sign_in_end: disabledAfter - signedIn,
        aged_session_age_ms_at_request: Date.now() - agingStarted,
        aged_session_get_me_status: me.status,
        aged_session_unlink_status: unlink.status,
        aged_session_link_start_status: linkStart.status,
      },
    );
    expect(me.status).toBe(200);
    expect(issuer).not.toBe("");
    expect(unlink.status, "the server refuses the removal").toBe(401);
    expect(linkStart.status, "the server refuses the link").toBe(401);
    // Nothing was removed: a new session still sees the identity.
    const check = await rawSignIn(who);
    const after = await raw("GET", "/me", {
      cookie: check.cookie,
      headers: { "x-csrf-token": check.csrf },
    });
    expect(after.json).toMatchObject({ oidc_issuers: [issuer] });
    // And the page's own controls are still disabled with their reason.
    await expect(remove).toBeDisabled();
    await expect(dialog.getByText(STALE, { exact: true })).toHaveCount(2);
  });
});

test.describe("I-28a: a failed provider flow (G-17 characterisation, recorded and not 'fixed')", () => {
  test.beforeEach(() => {
    test.skip(
      !OIDC,
      "this stack did not configure the stub OpenID Connect provider",
    );
  });

  test("I-28a the provider denies consent: the browser is left on the BACKEND's JSON error at the callback URL; nothing signs in; the next sign-in supersedes the attempt", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const page = await context.newPage();
    await page.goto("/__session?route=%2F");
    await exposeSession(page);
    await provider.deny(true);
    await page
      .getByRole("button", { name: "Use single sign-on instead" })
      .click();
    await page.waitForURL((url) => url.pathname === CALLBACK, {
      timeout: 30_000,
    });
    // G-17: the SPA cannot intercept this: the browser shows the backend's Atlas error body as a top-level response.
    const shown = (await page.locator("body").innerText()).trim();
    expect(JSON.parse(shown)).toMatchObject({ code: "unauthenticated" });
    recordMeasurement(
      "I-28a G-17 evidence: what the browser shows after a denied consent",
      {
        url_path: new URL(page.url()).pathname,
        body_code: JSON.parse(shown).code,
      },
    );
    expect(await sessionCookie(context)).toBeNull();
    await provider.deny(false);
    // Back at the app: the redirected attempt is still recorded (it is not a gating phase) and a new sign-in supersedes it.
    await page.goto("/__session?route=%2F");
    await exposeSession(page);
    expect((await records(page)).auth_state.attempt).toMatchObject({
      phase: "redirected",
    });
    await uiSignIn(page, "mia");
    await untilView(page, "displaying");
    expect((await records(page)).auth_state.attempt).toBeNull();
  });
});

test.describe("I-28b: single sign-on is not configured on this server", () => {
  test("I-28b the button answers plainly (404 not_found) and the page keeps working", async ({
    context,
    provokes,
  }) => {
    provokes(404);
    await pinVisible(context);
    expect(OIDC).toBeNull();
    const page = await context.newPage();
    await page.goto("/__session?route=%2F");
    await exposeSession(page);
    await page
      .getByRole("button", { name: "Use single sign-on instead" })
      .click();
    await expect(
      page.getByText("Single sign-on isn't set up on this server."),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeEnabled();
    expect((await records(page)).auth_state.attempt).toBeNull();
    // And the password still works on the same page.
    await uiSignIn(page, "nora");
    await untilView(page, "displaying");
  });
});

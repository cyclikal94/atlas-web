import type { BrowserContext, Page } from "@playwright/test";
import { test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { expect, runAxe } from "./helpers";

/**
 * WEB-08c, Layer 3: composed lifecycle traces on the PRODUCTION build in a real engine (real IndexedDB, Web Locks, BroadcastChannel, the
 * production sync leader), against a STUBBED network (`auth-stub.ts`). It is NEVER integration evidence: the released backend is
 * `tests/integration/integration.lifecycle.spec.ts` (I-L*).
 *
 * The "rendered cache": the product's feature screens are placeholders, so the account-specific content a person sees is the rail's
 * VERIFIED label (persisted in the account's own database, shown offline) and the account card. Every trace gives each account a UNIQUE
 * username, used as its marker, and asserts the marker's absence or presence across the DOM text, the accessibility snapshot and
 * `document.title`. Visibility is overridden where a case needs it (a stated limitation, as in the other real-engine suites).
 */
const API = "/browser-sessions";
const ACTIVATE = "/browser-sessions/activate";
const CURRENT = "/browser-sessions/current";
const isExchange = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === API;
const isActivate = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === ACTIVATE;
const isCancel = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === `${ACTIVATE}/cancel`;

/** A unique lower-case username per test, so a marker can never be matched by another account's content. */
const marker = (stem: string) =>
  `${stem}${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9]/g, "x");

async function newStub(context: BrowserContext, ...names: string[]) {
  const stub = new AuthStub();
  const accounts = names.map((name) =>
    stub.addAccount(name, `${name}-pw-9271`),
  );
  await stub.install(context);
  return { stub, accounts };
}
const passwordOf = (name: string) => `${name}-pw-9271`;

/** Every page of the context reports itself visible and never hides (the tests that need a hidden page say so). */
async function alwaysVisible(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      get: () => "visible",
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      get: () => false,
      configurable: true,
    });
    document.addEventListener(
      "visibilitychange",
      (event) => event.stopImmediatePropagation(),
      true,
    );
  });
}

/**
 * The public sign-in form. In WebKit the form can be drawn once more in the first moments after it appears, which drops what was typed
 * (observation O-2, recorded in the WEB-08c report; WEB-08b's surface), so the fields are filled until both values hold, then submitted.
 */
async function publicSignIn(page: Page, username: string) {
  const user = page.getByLabel("Username");
  const secret = page.getByLabel("Password");
  await expect(async () => {
    await user.fill(username);
    await secret.fill(passwordOf(username));
    await expect(user).toHaveValue(username, { timeout: 250 });
    await expect(secret).toHaveValue(passwordOf(username), { timeout: 250 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The account the page DISPLAYS, by its rail control (rendered only for a label verified for the current epoch). */
async function displayedAs(page: Page, username: string, timeout = 20_000) {
  await expect(
    page.locator("#protected-root:not([inert])").getByRole("button", {
      name: `${username}, switch account`,
    }),
  ).toBeVisible({ timeout });
}

/** The marker is nowhere a person or assistive technology could perceive it: DOM text, accessibility tree, title. */
async function expectAbsent(page: Page, value: string) {
  const text = await page.evaluate(
    () => document.documentElement.textContent ?? "",
  );
  expect(text, "DOM text").not.toContain(value);
  expect(await page.title(), "title").not.toContain(value);
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree, "accessibility tree").not.toContain(value);
}

/** Opens Settings and returns once the account card is drawn (a navigation lost in a session re-check is tried again: HF-1). */
async function openSettings(page: Page) {
  await expect(async () => {
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 });
    await expect(page.locator("[data-account-card]")).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
}

async function signInAndDisplay(page: Page, username: string) {
  await page.goto("/");
  await publicSignIn(page, username);
  await displayedAs(page, username);
}

/** The switch dialog's form: the password (the username is prefilled for a retained account, typed for another). */
async function switchSignIn(
  page: Page,
  options: { username?: string; password: string; submit: string },
) {
  const dialog = page.getByRole("dialog");
  if (options.username !== undefined)
    await dialog.getByLabel("Username").fill(options.username);
  await dialog.getByLabel("Password").fill(options.password);
  await dialog
    .getByRole("button", { name: options.submit, exact: true })
    .click();
}

const csrfOf = (sessionId: string | null) =>
  sessionId === null ? null : `csrf.${sessionId}`;

test.describe("E-L1/E-L2: switching account (rows 7 and 8, WF-SWITCH-01/02)", () => {
  test("E-L1: A → B from the rail, then B → A from Settings; the outgoing account is never perceivable during 1c or after the incoming mounts; nothing is sent with the outgoing account's token after the activation", async ({
    page,
    context,
  }) => {
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    const sessionA = stub.cookie;

    // WF-SWITCH-01 from the rail's account control (the verified label names it).
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    const picker = page.getByRole("dialog", { name: "Switch account" });
    const list = picker.getByRole("listbox", { name: "Switch account" });
    await expect(list).toBeFocused();
    await expect(
      picker.getByText(/You'll need to sign in — this isn't a quick swap/),
    ).toBeVisible();
    const options = list.getByRole("option");
    await expect(options.first()).toContainText(a);
    await expect(options.first()).toContainText("Signed in now");
    // Keyboard: Down to "Add another account" (only one account has used this browser), Enter.
    await page.keyboard.press("ArrowDown");
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Sign in to another account" }),
    ).toBeVisible();

    const held = stub.hold(isActivate, 1);
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(2);
    // Row 7: from the activating write nothing of A is shown; the neutral gate says "Finishing sign-in".
    await expect(
      page.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 20_000 });
    await expectAbsent(page, a);
    const activatedAt = stub.requests.length;
    held.release();
    await displayedAs(page, b);
    await expectAbsent(page, a);
    const sessionB = stub.cookie;
    expect(sessionB).not.toBe(sessionA);
    // Nothing carrying A's token was issued after B's activation (the outgoing account's work is never sent under B).
    const after = stub.requests.slice(activatedAt);
    expect(after.filter((r) => r.csrf === csrfOf(sessionA))).toEqual([]);
    expect(after.some((r) => r.csrf === csrfOf(sessionB))).toBe(true);

    // Settings → "Switch account": A is a RETAINED account, named by its own verified profile record.
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    const picker2 = page.getByRole("dialog", { name: "Switch account" });
    const retained = picker2.locator('[data-switch-row="retained"]');
    await expect(retained).toHaveCount(1);
    await expect(retained).toContainText("Used on this computer before");
    await expect(retained).toContainText(a);
    await expect(picker2.locator('[data-switch-row="current"]')).toContainText(
      b,
    );
    await retained.click();
    const signInAsA = page.getByRole("dialog", { name: `Sign in as ${a}` });
    await expect(signInAsA.getByLabel("Username")).toHaveValue(a);
    await expect(
      signInAsA.getByRole("button", { name: `Cancel — stay as ${b}` }),
    ).toBeVisible();
    const back = stub.requests.length;
    await switchSignIn(page, {
      password: passwordOf(a),
      submit: `Sign in as ${a}`,
    });
    await displayedAs(page, a);
    await expectAbsent(page, b);
    const sessionA2 = stub.cookie;
    expect(
      stub.requests
        .slice(back)
        .filter((r) => r.csrf === csrfOf(sessionB) && r.n > back + 3),
    ).toEqual([]);
    expect(sessionA2).not.toBe(sessionA);
  });

  test("E-L2: row 7 timing across two pages: the other page shows A until B's activating write, nothing while it is in flight, then B", async ({
    context,
  }) => {
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await alwaysVisible(context);
    const one = await context.newPage();
    const two = await context.newPage();
    await signInAndDisplay(one, a);
    await two.goto("/");
    await displayedAs(two, a);
    // Page one opens the switcher and starts B: the exchange is held, so A still renders on page two (no activating write yet).
    const exchange = stub.hold(isExchange, 1);
    await one.getByRole("button", { name: `${a}, switch account` }).click();
    await one
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    const activation = stub.hold(isActivate, 1);
    await switchSignIn(one, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", API)).toBe(2);
    await displayedAs(two, a, 2_000);
    exchange.release();
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(2);
    // The activating write is committed: page two is gated and shows nothing of A (or B).
    await expect(
      two.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 20_000 });
    await expectAbsent(two, a);
    await expectAbsent(two, b);
    activation.release();
    await displayedAs(one, b);
    await displayedAs(two, b);
    await expectAbsent(two, a);
  });
});

test.describe("E-L3: T7/T20, an activation answered by a gateway, dropped or cancelled (1c.ended)", () => {
  for (const variant of ["502", "504", "dropped"] as const) {
    test(`signed out, activation ${variant}: 1c.resolving, activate/cancel: nobody settled, the 1c.ended CARD; 'Sign in again' leads to the form`, async ({
      page,
      context,
      provokes,
    }) => {
      provokes(401, 502, 504, "abort");
      const a = marker("alice");
      const { stub } = await newStub(context, a);
      stub.answerNext(
        isActivate,
        variant === "dropped"
          ? "abort"
          : {
              status: Number(variant),
              body: "<html>gateway</html>",
              contentType: "text/html",
            },
      );
      await page.goto("/");
      await publicSignIn(page, a);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "That sign-in didn't finish",
        }),
      ).toBeVisible({ timeout: 30_000 });
      // Resolved by activate/cancel; with nobody settled no identity read is needed (a `verifying` attempt with nothing settled clears,
      // D-20: nothing is inferred from a cookie).
      expect(
        stub.recordsFor(`${ACTIVATE}/cancel`).length,
      ).toBeGreaterThanOrEqual(1);
      await expectAbsent(page, a);
      await page.getByRole("button", { name: "Sign in again" }).click();
      await expect(page.getByLabel("Username")).toBeVisible();
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "That sign-in didn't finish",
        }),
      ).toHaveCount(0);
    });
  }

  test("A still valid, the switch's activation 502: A renders again (same session) with the in-tree 'That sign-in didn't finish' line; B never renders", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(502);
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    const sessionA = stub.cookie;
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    stub.answerNext(isActivate, {
      status: 502,
      body: "bad gateway",
      contentType: "text/plain",
    });
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await displayedAs(page, a, 30_000);
    expect(stub.cookie).toBe(sessionA);
    await expect(page.locator('[data-notice="feedback-ended"]')).toContainText(
      "That sign-in didn't finish",
    );
    await expect(
      page.locator('[data-notice="feedback-ended"]'),
    ).not.toContainText("Sign in again");
    await expectAbsent(page, b);
  });

  test("cookie replaced by B's session, cancel session_revoked, current() 401: A is fenced (1b); B is not adopted", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(401, 502);
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    const held = stub.hold(isActivate, 1);
    stub.answerNext(isActivate, {
      status: 502,
      body: "bad gateway",
      contentType: "text/plain",
    });
    stub.cancelResult = "session_revoked";
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(2);
    // The browser applied B's Set-Cookie, but the answer was lost behind the gateway.
    const created = [...stub.sessions.values()].at(-1);
    stub.cookie = created?.id ?? null;
    held.release();
    await expect(
      page.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAbsent(page, a);
    await expectAbsent(page, b);
    await expect(page.locator('[data-notice="feedback-ended"]')).toHaveCount(0);
  });

  test("cookie replaced by B's LIVE session, cancel unknown, current() 200 B: drift (1d) for A; the target is never adopted", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(502);
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    const held = stub.hold(isActivate, 1);
    stub.answerNext(isActivate, {
      status: 502,
      body: "bad gateway",
      contentType: "text/plain",
    });
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(2);
    const created = [...stub.sessions.values()].at(-1);
    stub.cookie = created?.id ?? null;
    held.release();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "This browser is now signed in as a different account",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAbsent(page, a);
    await expectAbsent(page, b);
  });

  test("the cancel cannot be sent (offline): 1c.offline holds the gate; back online the resolution finishes", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(502, "abort");
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await page.addInitScript(() => {
      const w = window as unknown as { __offline: boolean };
      w.__offline = false;
      Object.defineProperty(navigator, "onLine", {
        get: () => !w.__offline,
        configurable: true,
      });
    });
    await signInAndDisplay(page, a);
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    const held = stub.hold(isActivate, 1);
    stub.answerNext(isActivate, {
      status: 502,
      body: "bad gateway",
      contentType: "text/plain",
    });
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(2);
    stub.offline = true;
    await page.evaluate(() => {
      (window as unknown as { __offline: boolean }).__offline = true;
      window.dispatchEvent(new Event("offline"));
    });
    held.release();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Reconnect to finish signing in",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAbsent(page, a);
    stub.offline = false;
    await page.evaluate(() => {
      (window as unknown as { __offline: boolean }).__offline = false;
      window.dispatchEvent(new Event("online"));
    });
    await displayedAs(page, a, 30_000);
    expect(stub.requests.some((r) => isCancel(r))).toBe(true);
  });
});

/**
 * HF-4 (WEB-08c): WebKit reports the departing document's own request, cancelled by the reload, as a page error. Observed once in the first
 * three-engine run (`reload while ACTIVATING`): the page error is the old page's terminal `activate/cancel` (started by the hide on unload,
 * matrix 3.4.2), raised inside the reload, and the fresh page then resolved the attempt exactly. Any same-origin API request of the departing
 * document can be the one in flight (the back/forward-cache probe met the leader's `/sync` read the same way), so the form is anchored to the
 * stub's API on loopback, in WebKit only.
 */
const CANCELLED_BY_RELOAD =
  /^\/127\.0\.0\.1:\d+\/api\/experimental\/v1\/[\w/-]+(\?[\w=&%.-]*)? due to access control checks\.$/;

test.describe("E-L4: T5 reloads and the row 6 offline reload", () => {
  test("reload while the switch is EXCHANGING: the attempt is cleared and A renders again; B never", async ({
    page,
    context,
    toleratesNavigationAbort,
  }) => {
    toleratesNavigationAbort("webkit", CANCELLED_BY_RELOAD);
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    stub.hold(isExchange, 1);
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", API)).toBe(2);
    await page.reload();
    await displayedAs(page, a);
    await expectAbsent(page, b);
    expect(stub.count("POST", ACTIVATE)).toBe(1);
  });

  test("reload while ACTIVATING: gated until activate/cancel and current() decide, then A (its cookie never changed); B never", async ({
    page,
    context,
    toleratesNavigationAbort,
  }) => {
    toleratesNavigationAbort("webkit", CANCELLED_BY_RELOAD);
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    const sessionA = stub.cookie;
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    stub.hold(isActivate, 1);
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(2);
    await page.reload();
    await displayedAs(page, a, 30_000);
    expect(stub.cookie).toBe(sessionA);
    expect(stub.requests.some((r) => isCancel(r))).toBe(true);
    await expectAbsent(page, b);
  });

  test("row 6: settled, nothing pending, OFFLINE reload: A renders from the local check, its verified label from its own database; no request reaches the server", async ({
    page,
    context,
    provokes,
  }) => {
    provokes("abort");
    const a = marker("alice");
    const { stub } = await newStub(context, a);
    await page.addInitScript(() => {
      if (sessionStorage.getItem("offline") === "1")
        Object.defineProperty(navigator, "onLine", {
          get: () => false,
          configurable: true,
        });
    });
    await signInAndDisplay(page, a);
    // Let the profile reach the account's database (the label is shown offline only from there).
    await expect
      .poll(() => stub.recordsFor("/me").length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1_000);
    const before = stub.requests.length;
    stub.offline = true;
    await page.evaluate(() => sessionStorage.setItem("offline", "1"));
    await page.reload();
    await displayedAs(page, a, 30_000);
    expect(stub.requests.length).toBe(before);
  });
});

test.describe("E-L5: T13, switching back to an account that carries its own row 4/5 fence", () => {
  test("A fenced (1b) → B → back to A: settlement does not lift A's fence; 'Catching up' until WEB-09b's recovery finishes; then A", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(401);
    const a = marker("alice");
    const b = marker("bobby");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    // A's session ends on the server; A's next request detects it: row 4/5 fence, 1b. The Settings navigation makes such a request, but a
    // background read can come first (seen in WebKit: the page was already on 1b and the rail gone before the click), so the click is
    // only the trigger, never the assertion.
    stub.sessions.clear();
    const reconnect = page.getByRole("heading", {
      level: 1,
      name: "Reconnect to keep going",
    });
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 5_000 })
      .catch(async (error: unknown) => {
        if (!(await reconnect.isVisible())) throw error;
      });
    await expect(reconnect).toBeVisible({ timeout: 30_000 });
    // "Reconnect" leads to the form; the person signs in as B instead (row 7 from a fenced account).
    await page.getByRole("button", { name: "Reconnect" }).click();
    await publicSignIn(page, b);
    await displayedAs(page, b, 30_000);
    // Back to A from Settings: a retained account, a fresh attempt (row 8).
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]')
      .click();
    // Every /sync answer from here on is held: the recovery's read stays unanswered until released. (Sampling the heading every 50 ms
    // missed a recovery that finished faster in Firefox; holding it makes the property deterministic.)
    const from = stub.requests.length;
    const recovery = stub.hold(
      (r) => r.method === "GET" && r.path === "/sync" && r.n > from,
    );
    await switchSignIn(page, {
      password: passwordOf(a),
      submit: `Sign in as ${a}`,
    });
    // The settlement does not lift A's own fence: "Catching up" while the recovery read is outstanding, and nothing of A.
    await expect(page.locator("#neutral-root h1")).toHaveText("Catching up", {
      timeout: 30_000,
    });
    await expect
      .poll(() =>
        stub.requests.some(
          (r) => r.n > from && r.method === "GET" && r.path === "/sync",
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => document.body.textContent ?? ""),
    ).not.toContain(a);
    expect(await page.title()).not.toContain(a);
    recovery.release();
    await displayedAs(page, a, 30_000);
  });
});

test.describe("E-L6: T17 and T21 across two pages", () => {
  test("T17: a password change on page one ends every session: page one and page two both show 1b; nothing of A stays perceivable", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const a = marker("alice");
    const { stub } = await newStub(context, a);
    await alwaysVisible(context);
    const one = await context.newPage();
    const two = await context.newPage();
    await signInAndDisplay(one, a);
    await two.goto("/");
    await displayedAs(two, a);
    await openSettings(one);
    await one.getByRole("link", { name: /Signing in/ }).click();
    const dialog = one.getByRole("dialog", { name: "Signing in" });
    await dialog.getByLabel("Current password").fill(passwordOf(a));
    await dialog.getByLabel(/New password/).fill("a-brand-new-password-4410");
    await dialog.getByRole("button", { name: "Change password" }).click();
    for (const page of [one, two]) {
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Reconnect to keep going",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expectAbsent(page, a);
    }
    expect(stub.sessions.size).toBe(0);
  });

  test("T21 (and K-1): a credential_mismatch is fenced at once; the verification reads ANOTHER account: 1d, and the verification is NOT repeated without end", async ({
    context,
    provokes,
  }) => {
    test.setTimeout(60_000);
    provokes(403);
    const a = marker("alice");
    const x = marker("xavie");
    const { stub, accounts } = await newStub(context, a, x);
    await alwaysVisible(context);
    const one = await context.newPage();
    const two = await context.newPage();
    await signInAndDisplay(one, a);
    await two.goto("/");
    await displayedAs(two, a);
    stub.enforceCsrf = true;
    // The cookie now names a live session of X (a late activation that landed before its cancel).
    stub.sessions.set("sess-x", {
      id: "sess-x",
      account: accounts[1]?.id ?? "",
      device: "dev-x",
      createdAt: Date.now(),
    });
    stub.cookie = "sess-x";
    const reads = stub.recordsFor(CURRENT).length;
    await openSettings(one).catch(() => undefined);
    for (const page of [one, two]) {
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "This browser is now signed in as a different account",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expectAbsent(page, a);
      await expectAbsent(page, x);
    }
    // K-1: the fence was REPLACED by drift; no page keeps re-verifying (each page reads at most a few times).
    await one.waitForTimeout(3_000);
    const settled = stub.recordsFor(CURRENT).length;
    await one.waitForTimeout(3_000);
    expect(stub.recordsFor(CURRENT).length - settled).toBe(0);
    expect(settled - reads).toBeLessThanOrEqual(6);
  });
});

test.describe("E-L7/E-L8: 'Review this device' and 'Confirm it's you' put the person back", () => {
  test("E-L7 (G-10): a retirement refused as stale shows 1a.device_changed; 'Review this device' lands on Sessions & devices with focus on this device's Retire control", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(409);
    const a = marker("alice");
    const { stub } = await newStub(context, a);
    stub.retireOutcome = "rejected_stale";
    await signInAndDisplay(page, a);
    await openSettings(page);
    await page.getByRole("link", { name: /Sessions & devices/ }).click();
    await page.getByRole("button", { name: "Retire this device" }).click();
    const confirm = page.getByRole("dialog").last();
    await confirm
      .getByRole("button", { name: /Retire/ })
      .last()
      .click();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "This device changed after you confirmed",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Review this device" }).click();
    await displayedAs(page, a, 30_000);
    await expect(page).toHaveURL(/\/settings\/sessions$/);
    await expect(
      page.getByRole("button", { name: "Retire this device" }),
    ).toBeFocused({
      timeout: 15_000,
    });
  });

  test("E-L8 (G-23): with a session older than five minutes, 'Confirm it's you' re-authenticates in place and returns to Signing in with focus on 'Link single sign-on'", async ({
    page,
    context,
  }) => {
    const a = marker("alice");
    const { stub } = await newStub(context, a);
    await signInAndDisplay(page, a);
    const first = stub.cookie ?? "";
    const row = stub.sessions.get(first);
    if (row) row.createdAt = Date.now() - 10 * 60_000;
    await openSettings(page);
    await page.getByRole("link", { name: /Signing in/ }).click();
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await expect(
      dialog.getByRole("button", { name: "Link single sign-on" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Confirm it's you" }).click();
    const region = dialog.getByRole("region", { name: "Confirm it's you" });
    await expect(
      region.getByRole("textbox", { name: "Username" }),
    ).toHaveAttribute("readonly", "");
    await region.getByLabel("Password").fill(passwordOf(a));
    await region.getByRole("button", { name: "Confirm it's you" }).click();
    await expect.poll(() => stub.cookie).not.toBe(first);
    // The SAME account at a newer session; the page is put back on "Signing in" (a dialog: the rail behind it is inert meanwhile).
    await expect(page).toHaveURL(/\/settings\/signing-in$/, {
      timeout: 30_000,
    });
    const back = page.getByRole("dialog", { name: "Signing in" });
    await expect(back).toBeVisible({ timeout: 30_000 });
    await expect(
      back.getByRole("button", { name: "Confirm it's you" }),
    ).toHaveCount(0);
    const link = back.getByRole("button", { name: "Link single sign-on" });
    await expect(link).toBeEnabled({ timeout: 15_000 });
    await expect(link).toBeFocused({ timeout: 15_000 });
  });
});

/**
 * R1 of the review of 11 October 2026 (WF-SWITCH-02 states.md: Cancel, "no change made"; G-23's Cancel). The incoming exchange is HELD
 * at the stub; the person leaves the credential step; the held answer is then released. The late grant must activate nothing: the
 * activation is never requested, the cookie is the outgoing session's, and the outgoing account is displayed. The window after the
 * released answer is a bounded NEGATIVE observation: the control shows the same continuation activating within it.
 */
const LATE_GRANT_WINDOW_MS = 1_500;

async function switchToOtherHeld(page: Page, stub: AuthStub, b: string) {
  const exchangesBefore = stub.count("POST", API);
  await page.getByRole("button", { name: /, switch account$/ }).click();
  await page
    .getByRole("dialog", { name: "Switch account" })
    .getByRole("option")
    .last()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Sign in to another account",
  });
  const held = stub.hold(isExchange, 1);
  await dialog.getByLabel("Username").fill(b);
  await dialog.getByLabel("Password").fill(passwordOf(b));
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => stub.count("POST", API)).toBe(exchangesBefore + 1);
  return { dialog, held };
}

/** Releases the held exchange and waits for its answer to reach the page. */
async function releaseExchange(page: Page, held: { release(): void }) {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/api/experimental/v1${API}`),
  );
  held.release();
  await answered;
}

test.describe("E-L10 (R1): leaving the credential step while the exchange is held makes no change", () => {
  test("control: the same held switch, NOT cancelled, activates the incoming account within the observation window", async ({
    page,
    context,
  }) => {
    const a = marker("alice");
    const b = marker("bob");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    const original = stub.cookie;
    const activations = stub.count("POST", ACTIVATE);
    const { held } = await switchToOtherHeld(page, stub, b);
    await releaseExchange(page, held);
    await expect
      .poll(() => stub.count("POST", ACTIVATE), {
        timeout: LATE_GRANT_WINDOW_MS,
      })
      .toBe(activations + 1);
    await displayedAs(page, b);
    expect(stub.cookie).not.toBe(original);
  });

  for (const leave of ["Cancel — stay as …", "Escape"] as const)
    test(`${leave} while the switch's exchange is held: the late grant activates nothing; the outgoing account stays displayed with its own session`, async ({
      page,
      context,
    }) => {
      const a = marker("alice");
      const b = marker("bob");
      const { stub } = await newStub(context, a, b);
      await signInAndDisplay(page, a);
      const original = stub.cookie;
      const activations = stub.count("POST", ACTIVATE);
      const { dialog, held } = await switchToOtherHeld(page, stub, b);
      if (leave === "Escape") {
        await dialog.press("Escape");
        await expect(dialog).toHaveCount(0);
      } else {
        await dialog
          .getByRole("button", { name: `Cancel — stay as ${a}` })
          .click();
        await expect(
          page.getByRole("dialog", { name: "Switch account" }),
        ).toBeVisible();
      }
      await releaseExchange(page, held);
      await page.waitForTimeout(LATE_GRANT_WINDOW_MS);
      expect(stub.count("POST", ACTIVATE)).toBe(activations);
      expect(stub.cookie).toBe(original);
      // The picker (after Cancel) is closed too, so the rail behind it is perceivable again.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await displayedAs(page, a);
      await expectAbsent(page, b);
    });

  test("'Confirm it's you' Cancel while its exchange is held: the late grant activates nothing; the same session stays", async ({
    page,
    context,
  }) => {
    const a = marker("alice");
    const { stub } = await newStub(context, a);
    await signInAndDisplay(page, a);
    const original = stub.cookie ?? "";
    const row = stub.sessions.get(original);
    if (row) row.createdAt = Date.now() - 10 * 60_000;
    await openSettings(page);
    await page.getByRole("link", { name: /Signing in/ }).click();
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await dialog.getByRole("button", { name: "Confirm it's you" }).click();
    const region = dialog.getByRole("region", { name: "Confirm it's you" });
    const activations = stub.count("POST", ACTIVATE);
    const exchanges = stub.count("POST", API);
    const held = stub.hold(isExchange, 1);
    await region.getByLabel("Password").fill(passwordOf(a));
    await region.getByRole("button", { name: "Confirm it's you" }).click();
    await expect.poll(() => stub.count("POST", API)).toBe(exchanges + 1);
    await region.getByRole("button", { name: "Cancel" }).click();
    await expect(region).toHaveCount(0);
    await releaseExchange(page, held);
    await page.waitForTimeout(LATE_GRANT_WINDOW_MS);
    expect(stub.count("POST", ACTIVATE)).toBe(activations);
    expect(stub.cookie).toBe(original);
    await expect(
      dialog.getByRole("button", { name: "Link single sign-on" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await displayedAs(page, a);
  });
});

/**
 * R3 of the review of 11 October 2026 (K-2): "Confirm it's you" refused at the ACTIVATION with the supported definitive
 * `503 device_capacity`, intercepted BEFORE the stub processes it (a page route, which runs before the context's stub; an answer replaced
 * after processing is not a refusal). The page must not stay on "Couldn't finish catching up": the same account and session display
 * again, the "Signing in" dialog shows the refusal under the section, and nothing changed. The exchange refusal is the control.
 */
test.describe("E-L11 (R3): a re-authentication refused at activation returns to Settings with the refusal", () => {
  for (const stage of ["exchange", "activation"] as const)
    test(`${stage === "exchange" ? "control: refused at the exchange" : "refused at the activation (503 device_capacity)"}: the same session displays again and the refusal is under 'Confirm it's you'`, async ({
      page,
      context,
      provokes,
    }) => {
      provokes(503);
      const a = marker("alice");
      const { stub } = await newStub(context, a);
      await signInAndDisplay(page, a);
      const original = stub.cookie ?? "";
      const row = stub.sessions.get(original);
      if (row) row.createdAt = Date.now() - 10 * 60_000;
      await openSettings(page);
      await page.getByRole("link", { name: /Signing in/ }).click();
      const dialog = page.getByRole("dialog", { name: "Signing in" });
      await dialog.getByRole("button", { name: "Confirm it's you" }).click();
      const region = dialog.getByRole("region", { name: "Confirm it's you" });
      const path = stage === "exchange" ? API : ACTIVATE;
      let refused = 0;
      await page.route(`**/api/experimental/v1${path}`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        refused += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "device_capacity",
            message: "device_capacity",
            request_id: "req-e-l11",
            details: [],
          }),
        });
      });
      const activations = stub.count("POST", ACTIVATE);
      await region.getByLabel("Password").fill(passwordOf(a));
      await region.getByRole("button", { name: "Confirm it's you" }).click();
      await expect.poll(() => refused).toBe(1);
      await expect(page.getByText("Couldn't finish catching up")).toHaveCount(
        0,
        { timeout: 15_000 },
      );
      await expect(page.locator("#protected-root:not([inert])")).toHaveCount(
        1,
        { timeout: 15_000 },
      );
      const back = page.getByRole("dialog", { name: "Signing in" });
      await expect(back).toContainText(
        "This device has too many active sign-ins for this account.",
        { timeout: 15_000 },
      );
      await expect(page.getByText("Couldn't finish catching up")).toHaveCount(
        0,
      );
      expect(stub.count("POST", ACTIVATE)).toBe(activations);
      expect(stub.cookie).toBe(original);
      await page.keyboard.press("Escape");
      await expect(back).toHaveCount(0);
      await displayedAs(page, a);
    });
});

test.describe("E-L11b (R3, K-2 family): a switch refused at activation returns to the outgoing account with the refusal", () => {
  test("the switch's activation answered 503 device_capacity before processing: A displays again (never state 3), the refusal is in the switch dialog, nothing changed", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(503);
    const a = marker("alice");
    const b = marker("bob");
    const { stub } = await newStub(context, a, b);
    await signInAndDisplay(page, a);
    const original = stub.cookie;
    let refused = 0;
    await page.route(`**/api/experimental/v1${ACTIVATE}`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      refused += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "device_capacity",
          message: "device_capacity",
          request_id: "req-e-l11b",
          details: [],
        }),
      });
    });
    await page.getByRole("button", { name: `${a}, switch account` }).click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    await switchSignIn(page, {
      username: b,
      password: passwordOf(b),
      submit: "Sign in",
    });
    await expect.poll(() => refused).toBe(1);
    const dialog = page.getByRole("dialog", {
      name: "Sign in to another account",
    });
    await expect(dialog).toContainText(
      "This device has too many active sign-ins for this account.",
      { timeout: 15_000 },
    );
    await expect(page.getByText("Couldn't finish catching up")).toHaveCount(0);
    expect(stub.cookie).toBe(original);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await displayedAs(page, a);
    await expectAbsent(page, b);
  });
});

test.describe("E-L9: the neutral cards these traces reach, in light and dark at 320 and 1280 px (axe including contrast)", () => {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [320, 1280])
      test(`${scheme} ${width}px: 1c.finishing and 1c.ended`, async ({
        page,
        context,
        provokes,
      }) => {
        provokes(401, 502);
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({
          width,
          height: width === 320 ? 640 : 800,
        });
        const a = marker("alice");
        const { stub } = await newStub(context, a);
        const held = stub.hold(isActivate, 1);
        stub.answerNext(isActivate, {
          status: 502,
          body: "bad gateway",
          contentType: "text/plain",
        });
        await page.goto("/");
        await publicSignIn(page, a);
        await expect(
          page.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
        ).toBeVisible({ timeout: 20_000 });
        const check = async (label: string) => {
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth,
            ),
            `${label}: horizontal scroll`,
          ).toBe(true);
          const violations = await runAxe(page, "#neutral-root");
          expect(
            violations.map((v) => v.id),
            `${label}: axe`,
          ).toEqual([]);
        };
        await check("1c.finishing");
        held.release();
        await expect(
          page.getByRole("heading", {
            level: 1,
            name: "That sign-in didn't finish",
          }),
        ).toBeVisible({ timeout: 30_000 });
        await check("1c.ended");
      });
});

test.describe("HF-1: a navigation and the session re-check that tears the tree down", () => {
  test("control: a Settings click after the display is settled navigates", async ({
    page,
    context,
  }) => {
    const a = marker("alice");
    await newStub(context, a);
    await signInAndDisplay(page, a);
    await page.waitForTimeout(1_500);
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect(page.locator("[data-account-card]")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("forced ordering: a click delivered INSIDE a session re-check (the hint delivered first) is not acted on; the URL is kept; a second click works", async ({
    page,
    context,
  }) => {
    const a = marker("alice");
    await newStub(context, a);
    await signInAndDisplay(page, a);
    await page.waitForTimeout(1_500);
    // Another page's settlement (a hint) makes this page check its session: the tree is torn down for the check and mounted again.
    const outcome = await page.evaluate(async () => {
      const channel = new BroadcastChannel("atlas-auth-hints");
      channel.postMessage({ type: "auth_state_changed" });
      const root = document.getElementById("protected-root");
      const started = performance.now();
      while (
        root &&
        !root.hasAttribute("inert") &&
        performance.now() - started < 2_000
      )
        await new Promise((resolve) => setTimeout(resolve, 0));
      const inert = root?.hasAttribute("inert") ?? false;
      const link = document.querySelector<HTMLAnchorElement>(
        'nav a[href="/settings"]',
      );
      link?.click();
      channel.close();
      return { inert, path: location.pathname };
    });
    test
      .info()
      .annotations.push({ type: "hf1", description: JSON.stringify(outcome) });
    await displayedAs(page, a);
    if (outcome.inert) {
      // The click landed while the display was closed for the check: nothing navigated, the location was kept.
      await expect(page).not.toHaveURL(/\/settings$/);
      await expect(page.locator("[data-account-card]")).toHaveCount(0);
    }
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect(page.locator("[data-account-card]")).toBeVisible({
      timeout: 10_000,
    });
  });
});

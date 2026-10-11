import type { BrowserContext, Page } from "@playwright/test";
import { test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { expect } from "./helpers";

/**
 * WEB-08b, Layer B in a REAL ENGINE: the production build, the production IndexedDB, Web Locks and BroadcastChannel, and a
 * STUBBED network (`tests/e2e/auth-stub.ts`). It shows the module behaves as specified in Chromium, Firefox and WebKit: the
 * URL fragment is stripped before the first request, registration and the OIDC round trip complete, and the ordering traces
 * (matrix T1, T3, T15) hold with two real pages and held answers. It is NEVER integration evidence: the real backend, real
 * cookies and the real provider are Layer C (tests/integration).
 */
const PASSWORD = "correct-horse-battery-9271";
const API_EXCHANGE = "/browser-sessions";
const ACTIVATE = "/browser-sessions/activate";
const isExchange = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === API_EXCHANGE;
const isActivate = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === ACTIVATE;

async function newStub(context: BrowserContext) {
  const stub = new AuthStub();
  stub.addAccount("kieran", "pw");
  stub.addAccount("sam", "pw2");
  await stub.install(context);
  return stub;
}

/** Records the page's address at every `fetch` and every `history.replaceState`, from the first script of the document. */
async function watchAddress(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __at: { urls: string[]; replaces: string[] };
    };
    w.__at = { urls: [], replaces: [] };
    const realFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      w.__at.urls.push(location.href);
      return realFetch(...args);
    };
    const realReplace = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      w.__at.replaces.push(String(args[2]));
      return realReplace(...args);
    };
  });
}
const addressLog = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __at: { urls: string[]; replaces: string[] } })
        .__at,
  );

const signInForm = (page: Page, username: string, password: string) =>
  page
    .getByLabel("Username")
    .fill(username)
    .then(async () => {
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
    });

/** Opens Settings from the shell's navigation (no reload) and returns the username the account card shows. */
async function shownAs(page: Page, username: string | RegExp) {
  const nav = page
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first();
  await nav.click();
  await expect(page.locator("[data-account-card]")).toContainText(username, {
    timeout: 20_000,
  });
}

test.describe("the fragment is stripped before the first request (matrix 3.4 step 2)", () => {
  test("an invitation token: never in the address bar at any request, never sent in a URL, kept in the preview BODY", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await watchAddress(page);
    const token = stub.addInvitation();
    await page.goto(`/join#t=${token}`);
    await page.getByLabel("Username").waitFor();
    const log = await addressLog(page);
    expect(log.urls.length).toBeGreaterThan(0);
    for (const url of log.urls)
      expect(url, "address at a fetch").not.toContain(token);
    expect(log.replaces).toEqual(["/join"]);
    expect(page.url()).not.toContain(token);
    // The preview request carried the token in its body and nowhere in its URL.
    const preview = stub.recordsFor("/registration/preview");
    expect(preview).toHaveLength(1);
    expect(preview[0]?.body).toEqual({ token });
    expect(preview[0]?.pageUrl).not.toContain(token);
    // Not in any storage either.
    const stored = await page.evaluate(async () => {
      const dump = JSON.stringify({ ...localStorage, ...sessionStorage });
      const dbs = (await indexedDB.databases?.()) ?? [];
      return { dump, dbs: dbs.length };
    });
    expect(stored.dump).not.toContain(token);
  });

  test("a SECOND link pasted into the open page (a fragment-only navigation) is captured and stripped too, and restarts the join page", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    const first = stub.addInvitation({
      household: { id: "h1", name: "Hartley" },
    });
    const second = stub.addInvitation({
      household: { id: "h2", name: "Meadow" },
    });
    await page.goto(`/join#t=${first}`);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "You're invited to join Hartley",
      }),
    ).toBeVisible();
    await page.evaluate((token) => {
      location.hash = `t=${token}`;
    }, second);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "You're invited to join Meadow",
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe("");
    expect(page.url()).not.toContain(second);
  });

  test("an OIDC grant: stripped before any request, whether or not it is valid", async ({
    page,
    context,
  }) => {
    await newStub(context);
    await watchAddress(page);
    const grant = "f".repeat(64);
    await page.goto(
      `/#atlas_grant=${grant}&atlas_attempt=9&atlas_account=123e4567-e89b-12d3-a456-426614174000`,
    );
    await page.getByLabel("Username").waitFor();
    const log = await addressLog(page);
    for (const url of log.urls) expect(url).not.toContain(grant);
    expect(await page.evaluate(() => location.hash)).toBe("");
    // No attempt was ever begun for it, so the landing is "superseded" and nothing changed.
    await expect(page.getByText(/replaced by a newer one/)).toBeVisible();
  });
});

test.describe("password sign-in, registration and OIDC in a real engine", () => {
  test("sign-in: a deep link keeps its URL through sign-in and opens after it; nothing about an account is on the page before settlement", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await page.goto("/settings");
    await page
      .getByRole("heading", { level: 1, name: "Sign in to Atlas" })
      .waitFor();
    expect(new URL(page.url()).pathname).toBe("/settings");
    expect(
      await page
        .locator("#protected-root")
        .evaluate((el) => el.childElementCount),
    ).toBe(0);
    await signInForm(page, "kieran", "pw");
    await expect(page.locator("[data-account-card]")).toContainText("kieran", {
      timeout: 20_000,
    });
    expect(new URL(page.url()).pathname).toBe("/settings");
    // The cookie changed exactly once, at the activation.
    expect(stub.cookieHistory.length).toBe(2);
    expect(stub.count("POST", ACTIVATE)).toBe(1);
  });

  test("a wrong password is refused under the field and nothing changes", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(401);
    const stub = await newStub(context);
    await page.goto("/");
    await signInForm(page, "kieran", "WRONG");
    await expect(page.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    await expect(page.getByLabel("Password")).toBeFocused();
    expect(stub.cookie).toBeNull();
  });

  test("registration end to end: preview, redemption, settlement, first protected paint at /today; the registration answer sets no cookie", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    const token = stub.addInvitation();
    await page.goto(`/join#t=${token}`);
    await page.getByLabel("Username").fill("newbie");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe("/today");
    await shownAs(page, "newbie");
    expect(stub.invitations.get(token)?.state).toBe("redeemed");
    // Only `activate` changed the cookie.
    expect(stub.cookieHistory.length).toBe(2);
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    expect(stub.count("POST", ACTIVATE)).toBe(1);
  });

  test("a lost registration response: the account exists, the page says so, nothing is resubmitted, and the chosen details sign in", async ({
    page,
    context,
    provokes,
  }) => {
    provokes("abort");
    const stub = await newStub(context);
    const token = stub.addInvitation();
    stub.answerNext(({ path }) => path === "/browser-registration", "abort");
    await page.goto(`/join#t=${token}`);
    await page.getByLabel("Username").fill("newbie");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/lost the confirmation/)).toBeVisible();
    expect(
      [...stub.accounts.values()].some((a) => a.username === "newbie"),
    ).toBe(true);
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("Username")).toHaveValue("newbie");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#protected-root")).not.toBeEmpty({
      timeout: 20_000,
    });
    await shownAs(page, "newbie");
  });

  test("a taken username keeps the invitation: the same link still works with another name", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(409);
    const stub = await newStub(context);
    const token = stub.addInvitation();
    await page.goto(`/join#t=${token}`);
    await page.getByLabel("Username").fill("kieran");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("That username is taken. Choose another."),
    ).toBeVisible();
    expect(stub.invitations.get(token)?.state).toBe("open");
    await page.getByLabel("Username").fill("someone-else");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe("/today");
  });

  test("single sign-on round trip: start, redirect to the (stub) provider, land back with the grant, settle", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    const origin = new URL(
      test.info().project.use.baseURL ?? "http://127.0.0.1:4173",
    ).origin;
    let fragment = "";
    await context.route("https://idp.example.test/**", async (route) => {
      // The provider approves "kieran" and redirects the browser to the origin with the fragment.
      const flow = stub.oidcFlows.at(-1);
      if (!flow) return route.fulfill({ status: 500, body: "no flow" });
      fragment = stub.completeOidc(
        flow,
        [...stub.accounts.values()][0]?.id ?? "",
      );
      // WebKit cannot fulfil a route with a 302, so the provider page navigates back itself (a meta refresh: no script, so the
      // provider's origin needs no content security policy of its own).
      const back = `${origin}/${fragment}`;
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${back}"><title>Provider</title>`,
      });
    });
    await watchAddress(page);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Use single sign-on instead" })
      .click();
    await expect(
      page.locator("[data-account-card], #protected-root *").first(),
    ).toBeAttached({ timeout: 20_000 });
    await shownAs(page, "kieran");
    expect(stub.oidcFlows).toHaveLength(1);
    expect(stub.oidcFlows[0]).toMatchObject({ link: false });
    // The landing document stripped the fragment before any of ITS requests.
    expect(page.url()).not.toContain("atlas_grant");
    const log = await addressLog(page);
    for (const url of log.urls) expect(url).not.toContain("atlas_grant");
    expect(stub.cookieHistory.length).toBe(2);
  });
});

/**
 * Review R1/R2. The neutral gate ("Finishing sign-in") replaces the form while the activation is in flight; an outcome that
 * arrives after it belongs to the surface that mounts next. These hold the ACTIVATION answer until the gate is on screen, then
 * answer it, which a mocked outcome delivered to a mounted form cannot reproduce.
 */
test.describe("an outcome that arrives after the neutral gate (review R1, R2)", () => {
  const CAPACITY = {
    status: 503,
    body: {
      code: "device_capacity",
      message: "capacity",
      request_id: "req-capacity",
      details: [],
    },
  };
  const CAPACITY_TEXT =
    "This account has reached its limit of active sign-ins. Sign out of one in Settings → Sessions & devices from another session, or try again later.";
  const LOST =
    "If you already submitted this and lost the confirmation, don't try again — sign in with the details you chose.";
  const gate = (page: Page) =>
    page.getByRole("heading", { name: "Finishing sign-in", exact: true });

  test("password sign-in: an activation refused behind the gate is shown on the form that returns, not lost", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(503);
    const stub = await newStub(context);
    stub.answerNext(isActivate, CAPACITY);
    const hold = stub.hold(isActivate, 1);
    await page.goto("/");
    await signInForm(page, "kieran", "pw");
    await expect(gate(page)).toBeVisible();
    await expect(page.getByLabel("Username")).toHaveCount(0);
    hold.release();
    await expect(gate(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText(CAPACITY_TEXT);
    await expect(page.getByRole("alert")).toContainText("req-capacity");
    await expect(page.getByLabel("Password")).toHaveValue("");
    expect(stub.count("POST", ACTIVATE)).toBe(1);
  });

  test("registration: an activation refused behind the gate is the sign-in recovery, not 'ask for a new invitation'", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(503);
    const stub = await newStub(context);
    const token = stub.addInvitation();
    stub.answerNext(isActivate, CAPACITY);
    const hold = stub.hold(isActivate, 1);
    await page.goto(`/join#t=${token}`);
    await page.getByLabel("Username").fill("newbie");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(gate(page)).toBeVisible();
    hold.release();
    await expect(gate(page)).toHaveCount(0);
    await expect(page.getByText(LOST)).toBeVisible();
    await expect(
      page.getByText("This link is no longer valid — ask for a new invitation"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toHaveCount(0);
    // The account exists and the invitation is spent: the person signs in with the details they chose.
    expect(
      [...stub.accounts.values()].some((a) => a.username === "newbie"),
    ).toBe(true);
    expect(stub.invitations.get(token)?.state).toBe("redeemed");
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("Username")).toHaveValue("newbie");
  });

  test("registration: a result discarded because a newer sign-in FAILED retires the live form, which cannot be submitted again", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    // Both pages stay visible: the order of the answers is the only variable (see `twoTabs` below).
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
    const stub = await newStub(context);
    const token = stub.addInvitation();
    const held = stub.hold((r) => r.path === "/browser-registration", 1);
    const a = await context.newPage();
    await a.goto(`/join#t=${token}`);
    await a.getByLabel("Username").fill("newbie");
    await a.getByLabel("Password").fill(PASSWORD);
    await a.getByRole("button", { name: "Create account" }).click();
    await expect
      .poll(() => stub.count("POST", "/browser-registration"))
      .toBe(1);
    // A newer attempt in another tab FAILS, so no account displays anywhere.
    const b = await context.newPage();
    await b.goto("/");
    await signInForm(b, "kieran", "not-the-password");
    await expect(b.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    held.release();
    await expect(a.getByText(/replaced by a newer one/)).toBeVisible();
    await expect(a.getByText(LOST)).toBeVisible();
    await expect(a.getByRole("button", { name: "Create account" })).toHaveCount(
      0,
    );
    await expect(a.getByLabel("Password")).toHaveCount(0);
    // The consumed invitation was sent once and is not offered again; the stale grant was never activated.
    expect(stub.invitations.get(token)?.state).toBe("redeemed");
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    expect(stub.count("POST", ACTIVATE)).toBe(0);
  });
});

/**
 * Review R5. A DIFFERENT invitation is opened in the same tab (a fragment-only navigation: the application strips its token and
 * previews it) while the first registration is outstanding. The first result, when it comes, belongs to the first invitation: it
 * must not retire the second form, put the first token back or replace what the person typed, and what the first submission
 * may have created is told beside the second.
 */
test.describe("a different invitation opened while a registration is outstanding (review R5)", () => {
  const EARLIER_MESSAGE =
    "You opened another invitation, so the result of the earlier one isn't shown here. If you already submitted it, don't try again — sign in with the details you chose.";
  const LOST =
    "If you already submitted this and lost the confirmation, don't try again — sign in with the details you chose.";
  const FIRST_SUBMIT = "Create account and join First household";
  const SECOND_SUBMIT = "Create account and join Second household";
  const SECOND_PASSWORD = "second-person-password-5150";

  /** Opens the first invitation, submits it with its answer held, then opens the second in the same tab and types into it. */
  async function secondOpenedWhileFirstIsOutstanding(
    page: Page,
    stub: AuthStub,
    firstUsername: string,
  ) {
    const first = stub.addInvitation({
      household: { id: "a", name: "First household" },
    });
    const second = stub.addInvitation({
      household: { id: "b", name: "Second household" },
    });
    const held = stub.hold((r) => r.path === "/browser-registration", 1);
    await page.goto(`/join#t=${first}`);
    await page.getByLabel("Username").fill(firstUsername);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: FIRST_SUBMIT, exact: true }).click();
    await expect
      .poll(() => stub.count("POST", "/browser-registration"))
      .toBe(1);
    await page.evaluate((token) => {
      location.hash = `t=${token}`;
    }, second);
    await expect(
      page.getByRole("heading", {
        name: "You're invited to join Second household",
      }),
    ).toBeVisible();
    // The token was stripped from the address bar as it was captured.
    expect(page.url()).not.toContain(second);
    await page.getByLabel("Username").fill("secondperson");
    await page.getByLabel("Password").fill(SECOND_PASSWORD);
    return { first, second, held };
  }

  const secondFormIsIntact = async (page: Page) => {
    await expect(
      page.getByRole("heading", {
        name: "You're invited to join Second household",
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toHaveValue("secondperson");
    await expect(page.getByLabel("Password")).toHaveValue(SECOND_PASSWORD);
    await expect(
      page.getByRole("button", { name: SECOND_SUBMIT, exact: true }),
    ).toBeEnabled();
    await expect(page.getByText(LOST)).toHaveCount(0);
    await expect(
      page.getByText("This link is no longer valid — ask for a new invitation"),
    ).toHaveCount(0);
  };

  test("a lost response for the first invitation: the second form stays, nothing is resubmitted, and the first is told beside it", async ({
    page,
    context,
    provokes,
  }) => {
    provokes("abort");
    const stub = await newStub(context);
    stub.answerNext((r) => r.path === "/browser-registration", "abort");
    const { first, second, held } = await secondOpenedWhileFirstIsOutstanding(
      page,
      stub,
      "firstperson",
    );
    held.release();
    await expect
      .poll(() => stub.invitations.get(first)?.state)
      .toBe("redeemed");
    await expect(page.getByText(EARLIER_MESSAGE)).toBeVisible();
    await secondFormIsIntact(page);
    // The second invitation was never submitted and is still open; the first was sent exactly once.
    expect(stub.invitations.get(second)?.state).toBe("open");
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    expect(stub.count("POST", ACTIVATE)).toBe(0);
    // The second invitation works: its own details, its own token.
    await page
      .getByRole("button", { name: SECOND_SUBMIT, exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe("/today");
    await shownAs(page, "secondperson");
    expect(stub.invitations.get(second)?.state).toBe("redeemed");
    expect(stub.count("POST", "/browser-registration")).toBe(2);
  });

  test("the note's own 'Sign in' carries the first username, and the details chosen for the first invitation sign in", async ({
    page,
    context,
    provokes,
  }) => {
    provokes("abort");
    const stub = await newStub(context);
    stub.answerNext((r) => r.path === "/browser-registration", "abort");
    const { held } = await secondOpenedWhileFirstIsOutstanding(
      page,
      stub,
      "firstperson",
    );
    held.release();
    await expect(page.getByText(EARLIER_MESSAGE)).toBeVisible();
    await page
      .locator("[data-earlier-registration]")
      .getByRole("button", { name: "Sign in" })
      .click();
    await expect(page.getByLabel("Username")).toHaveValue("firstperson");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#protected-root")).not.toBeEmpty({
      timeout: 20_000,
    });
    await shownAs(page, "firstperson");
  });

  test("a refusal that leaves the first invitation usable does not put its token back: the second form stays and nothing is said about the first", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(409);
    const stub = await newStub(context);
    // `kieran` is taken: the stub answers 409 and the first invitation stays open on the server.
    const { first, second, held } = await secondOpenedWhileFirstIsOutstanding(
      page,
      stub,
      "kieran",
    );
    held.release();
    await expect
      .poll(() => stub.recordsFor("/browser-registration")[0]?.status)
      .toBe(409);
    await secondFormIsIntact(page);
    await expect(page.getByText(EARLIER_MESSAGE)).toHaveCount(0);
    await expect(
      page.getByText("That username is taken. Choose another."),
    ).toHaveCount(0);
    expect(stub.invitations.get(first)?.state).toBe("open");
    expect(stub.invitations.get(second)?.state).toBe("open");
    // Only the second invitation can be submitted from this page, with its own token.
    await page
      .getByRole("button", { name: SECOND_SUBMIT, exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe("/today");
    expect(stub.invitations.get(second)?.state).toBe("redeemed");
    expect(stub.invitations.get(first)?.state).toBe("open");
    expect(stub.count("POST", "/browser-registration")).toBe(2);
  });

  test("a result discarded because a newer sign-in FAILED: the second form stays, the banner says why, and the first is told beside it", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    // Both pages stay visible: the order of the answers is the only variable.
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
    const stub = await newStub(context);
    const a = await context.newPage();
    const { first, second, held } = await secondOpenedWhileFirstIsOutstanding(
      a,
      stub,
      "firstperson",
    );
    // A newer attempt in another tab FAILS, so no account displays anywhere.
    const b = await context.newPage();
    await b.goto("/");
    await signInForm(b, "kieran", "not-the-password");
    await expect(b.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    held.release();
    await expect(a.getByText(/replaced by a newer one/)).toBeVisible();
    await expect(a.getByText(EARLIER_MESSAGE)).toBeVisible();
    await secondFormIsIntact(a);
    expect(stub.invitations.get(first)?.state).toBe("redeemed");
    expect(stub.invitations.get(second)?.state).toBe("open");
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    // The stale grant was never activated.
    expect(stub.count("POST", ACTIVATE)).toBe(0);
  });
});

test.describe("ordering traces in a real engine (two pages, held answers)", () => {
  /**
   * Two real pages of one browser context. Visibility is PINNED to visible: in one headless context, interacting with one page
   * hides the other, and a hidden page aborts an in-flight activation by design (matrix 3.4 step 3), which would turn every
   * ordering trace into a hidden-tab test. Hidden-tab behaviour is covered by `tests/session/hidden-tab.test.ts` and
   * `activation-visibility.test.ts`; here both tabs stay visible so the ORDER of answers is the only variable.
   */
  async function twoTabs(context: BrowserContext) {
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
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto("/");
    await b.goto("/");
    await a.getByLabel("Username").waitFor();
    await b.getByLabel("Username").waitFor();
    return [a, b] as const;
  }
  const settled = (stub: AuthStub) => stub.sessions.size;

  test("T1 (A processed first, A's answer reaches tab 1 while B is still exchanging): A is discarded, B settles, the cookie changes once, G_A is never redeemed", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    const holdA = stub.hold(isExchange, 1);
    await signInForm(a, "kieran", "pw");
    await expect.poll(() => stub.count("POST", API_EXCHANGE)).toBe(1);
    const holdB = stub.hold(isExchange, 1);
    await signInForm(b, "sam", "pw2");
    await expect.poll(() => stub.count("POST", API_EXCHANGE)).toBe(2);
    holdA.release();
    await expect(a.getByText(/replaced by a newer one/)).toBeVisible({
      timeout: 20_000,
    });
    expect(stub.cookie).toBeNull();
    expect(settled(stub)).toBe(0);
    holdB.release();
    await shownAs(b, "sam");
    // Tab 1 shows B too, with the superseded notice in the tree.
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await shownAs(a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
    expect(stub.count("POST", ACTIVATE)).toBe(1);
    const grantForKieran = [...stub.grants.values()].find(
      (g) => stub.accounts.get(g.account)?.username === "kieran",
    );
    expect(grantForKieran?.state).toBe("issued");
  });

  test("T1 (B processed first, A's answer reaches tab 1 AFTER B has settled): the same result", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    // A's exchange is sent after B's reaches the server, and A's answer is held until B has settled.
    const holdA = stub.hold(isExchange, 1);
    // Tab 1 begins first (epoch 1) but its request is made once tab 2 has begun, so B is processed first.
    const first = signInForm(a, "kieran", "pw");
    await expect.poll(() => stub.count("POST", API_EXCHANGE)).toBe(1);
    await first;
    await signInForm(b, "sam", "pw2");
    await shownAs(b, "sam");
    holdA.release();
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await shownAs(a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
    expect(stub.count("POST", ACTIVATE)).toBe(1);
  });

  test("T3: a stale ERROR (wrong password) after tab 2 settled is discarded, never shown as 'wrong password', and B's identity is untouched", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    const holdA = stub.hold(isExchange, 1);
    await signInForm(a, "kieran", "WRONG-password");
    await expect.poll(() => stub.count("POST", API_EXCHANGE)).toBe(1);
    await signInForm(b, "sam", "pw2");
    await shownAs(b, "sam");
    holdA.release();
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      a.getByText("That username or password isn't right."),
    ).toHaveCount(0);
    await shownAs(a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
  });

  /** What a production tab shows, from the DOM alone: the account, the "different account" card, or something still in transition. */
  const tabState = (page: Page) =>
    page.evaluate(() => {
      const neutral = document
        .querySelector("[data-neutral-state]")
        ?.getAttribute("data-neutral-state");
      const protectedRoot = document.getElementById("protected-root");
      if (!neutral && protectedRoot && !protectedRoot.hasAttribute("inert"))
        return "displaying";
      if (neutral === "1d") return "different_account";
      return "transition";
    });

  test("T15 (both tabs sign in at once): whichever order the engine runs them in, at most ONE account is displayed, it is the one activated last, and a replaced tab shows nothing about it", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    // Both tabs try at once. Whichever tab's sign-in reaches the gating phase first REPLACES the other tab's form with the
    // "Finishing sign-in" card (matrix 3.7), possibly between a fill and a click. That is the designed behaviour, not a failure,
    // so an attempt whose form has gone is simply over.
    const tryOffered = async (page: Page, user: string, password: string) => {
      try {
        await page.getByLabel("Username").fill(user, { timeout: 4000 });
        await page.getByLabel("Password").fill(password, { timeout: 4000 });
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click({ timeout: 4000 });
      } catch {
        // The other tab's sign-in replaced this form first.
      }
    };
    await Promise.all([
      tryOffered(a, "kieran", "pw"),
      tryOffered(b, "sam", "pw2"),
    ]);
    // Neither order is guaranteed: if one tab finishes before the other begins it shows state 1d afterwards (the switch journey is
    // WEB-08c's); if both begin first, the older attempt is discarded. Wait until neither tab is mid-transition.
    await expect
      .poll(
        async () =>
          (await Promise.all([a, b].map(tabState))).every(
            (state) => state !== "transition",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const states = await Promise.all([a, b].map(tabState));
    const lastActivation = stub.requests
      .filter((r) => r.method === "POST" && r.path === ACTIVATE)
      .at(-1);
    const lastGrant = (lastActivation?.body as { grant?: string } | undefined)
      ?.grant;
    const lastAccount = stub.grants.get(lastGrant ?? "")?.account ?? "";
    const lastName = stub.accounts.get(lastAccount)?.username;
    expect(lastName, "the last activation names an account").toBeTruthy();
    const shown: string[] = [];
    for (const [index, tab] of [a, b].entries()) {
      if (states[index] === "displaying") {
        await shownAs(tab, /kieran|sam/);
        shown.push(
          (await tab.locator("[data-account-username]").textContent()) ?? "",
        );
      } else {
        // A replaced tab is on the "different account" card, which names no account.
        const text = await tab.locator("#neutral-root").innerText();
        expect(text).not.toMatch(/kieran|sam/);
      }
    }
    expect(new Set(shown).size, "never two different accounts displayed").toBe(
      1,
    );
    expect(shown[0]).toContain(lastName ?? "");
    // The cookie is the session of the last activation, and only activations changed it.
    expect(stub.cookieHistory.length - 1).toBe(
      stub.requests.filter((r) => r.path === ACTIVATE).length,
    );
  });

  test("T1 (A's answer reaches tab 1 while B is ACTIVATING): the form was already replaced by 'Finishing sign-in'; A is discarded, the superseded notice survives the form, and B settles", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    const holdA = stub.hold(isExchange, 1);
    await signInForm(a, "kieran", "pw");
    await expect.poll(() => stub.count("POST", API_EXCHANGE)).toBe(1);
    const holdActivate = stub.hold(isActivate, 1);
    await signInForm(b, "sam", "pw2");
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(1);
    // B's activation is in flight: every live tab is gated (matrix 3.7), tab 1's form is gone.
    await expect(
      a.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 20_000 });
    holdA.release();
    // A's late grant reaches tab 1 and is discarded: nothing is redeemed for kieran and nothing changes.
    await a.waitForTimeout(500);
    expect(stub.cookie).toBeNull();
    expect(stub.count("POST", ACTIVATE)).toBe(1);
    holdActivate.release();
    await shownAs(b, "sam");
    // The notice was published by the controller after tab 1's form had unmounted, and still reaches the person.
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await shownAs(a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
    const grantForKieran = [...stub.grants.values()].find(
      (g) => stub.accounts.get(g.account)?.username === "kieran",
    );
    expect(grantForKieran?.state).toBe("issued");
  });

  test("T15 (tab 2 is activating when tab 1 looks): tab 1 is shown 'Finishing sign-in', offers no form and sends nothing, then shows tab 2's account", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    const holdActivate = stub.hold(isActivate, 1);
    await signInForm(b, "sam", "pw2");
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(1);
    await expect(
      a.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 20_000 });
    // No form, no way to begin a second sign-in from the gated tab; and nothing was sent by it.
    await expect(a.getByLabel("Username")).toHaveCount(0);
    await expect(a.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    await a.waitForTimeout(1000);
    expect(stub.count("POST", API_EXCHANGE)).toBe(1);
    expect(stub.count("POST", ACTIVATE)).toBe(1);
    holdActivate.release();
    await shownAs(b, "sam");
    await shownAs(a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
  });
});

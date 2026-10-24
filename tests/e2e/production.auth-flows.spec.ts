import { type BrowserContext, errors, type Page } from "@playwright/test";
import { test } from "./auth-helpers";
import {
  classifyOfferError,
  delayDigest,
  delayLocks,
  expectNoArrivalsSince,
  failLeaseRetirement,
  lookAt,
  observeAuthWork,
  offerSignIn,
  pagesOf,
  recordAuthTransactions,
  releaseDigest,
  releaseLocks,
  type Settled,
  settleAuth,
  workOf,
} from "./auth-settlement";
import { AuthStub, type Hold } from "./auth-stub";
import { expect } from "./helpers";
import { gateLog, recordGateTransitions } from "./lifecycle-browser";

/**
 * WEB-14a revision 19, labelled HARNESS ADAPTATION (Kieran, 15 October 2026): the production build registers the app's service worker
 * (WEB-14a), and Playwright WebKit does not apply `context.route` to requests a worker passes on, so the AuthStub never answered there
 * and most WebKit cases failed (also on the unmodified revision-18 candidate). These specs test the authentication surfaces, not the
 * worker: they run without it. The worker in the production build is covered by production.pwa.spec.ts and production.offline.spec.ts.
 */
test.use({ serviceWorkers: "block" });

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
  // Revision 22 (R28): every page of the context reports its authentication work, so `shownAs` and the ordering traces can wait for the
  // completion boundary instead of a moment that merely looks settled.
  await observeAuthWork(context);
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

/**
 * Opens Settings from the shell's navigation (no reload) and checks the username the account card shows.
 *
 * Revision 22 (R28, C3): it first waits for the completion boundary of EVERY page of the context (`settleAuth`). The retained revision-19
 * Firefox T3 trace and the accepted-main T15 trace both show the click pressed on the shell's link and released after the protected tree
 * had been closed by a PEER's leased verification read (the designed 1e "interrupted" state of matrix 3.6): no navigation was dispatched
 * at all, and the card never came. The diagnosis and the adverse schedules are the "navigation" describe below. A click that does not
 * navigate now fails at the address, and is never retried. `parked` names holds the test keeps on purpose.
 */
async function shownAs(
  stub: AuthStub,
  page: Page,
  username: string | RegExp,
  parked: readonly Hold[] = [],
) {
  await settleAuth(stub, pagesOf(page), { parked });
  const nav = page
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first();
  await nav.click();
  await expect(page, "the Settings click navigated").toHaveURL(/\/settings$/, {
    timeout: 4000,
  });
  // Revision 23 (C5, S08): the navigation starts the Settings readers (account, devices, sessions); the card is judged only after their
  // own boundary, which never recomputes the account the caller expects.
  await settleAuth(stub, pagesOf(page), { parked });
  await expect(page.locator("[data-account-card]")).toContainText(username, {
    timeout: 20_000,
  });
}

// Keep the accepted HF-1 single-click check independent of WEB-14a settlement instrumentation.
async function shownAsDirectly(page: Page, username: string | RegExp) {
  const nav = page
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first();
  // WEB-08c revision 2, HF-1: the ORIGINAL single click, unadapted (as at `84a8361`). Revision 1 repeated the click because the other pages'
  // identity reads right after a settlement surrendered their leases and closed this page's tree for a few milliseconds; the product
  // correction (HF1-SHARED-CONFIRMATION-20261013: the settlement's token and confirmation are shared) removes those reads, so ONE click must
  // land. WEB08D-NAVIGATION-FRESHNESS-20261011: WEB-09d verifies it again in the integrated client before beta.
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
    await shownAs(stub, page, "newbie");
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
    await shownAs(stub, page, "newbie");
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
    await shownAs(stub, page, "kieran");
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
    "This device has too many active sign-ins for this account. End one from Settings in another session, or try again later.";
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
    await shownAs(stub, page, "secondperson");
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
    await shownAs(stub, page, "firstperson");
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

/**
 * Revision 22 (R28, invariants 2-4): after the completion boundary, the expected account is the one whose activation was the last
 * DELIVERED, cookie-changing 200 (never the last request to arrive, which may have been refused, aborted or never answered), and the
 * browser's cookie is that session. Only then are the tabs' UIs collected, against that one generation: each tab displays that account
 * or is on the "different account" card that names none, never two different accounts, and no exchange or activation may arrive while
 * the UI is collected (the oracle does not move).
 */
async function expectFinalIdentity(
  stub: AuthStub,
  tabs: readonly Page[],
  boundary: Settled,
  options: { otherwise?: ReadonlyArray<"different_account" | "neutral"> } = {},
) {
  const otherwise = options.otherwise ?? ["different_account"];
  // Revision 23 (invariant 4): the expected identity is the one frozen AT the boundary; anything that moves it later fails below.
  const final = boundary.activations.at(-1);
  expect(final, "a delivered, cookie-changing activation").toBeTruthy();
  const name = stub.usernameOf(final?.account ?? "");
  expect(name, "the last delivered activation names an account").toBeTruthy();
  expect(stub.cookie, "the browser holds the final activation's session").toBe(
    final?.cookie,
  );
  expect(
    boundary.cookieRevision - 1,
    "only delivered activations changed the cookie",
  ).toBe(boundary.activations.length);
  expectNoArrivalsSince(stub, boundary, [API_EXCHANGE, ACTIVATE]);
  expect(
    stub.cookieHistory.length - 1,
    "only delivered activations changed the cookie",
  ).toBe(stub.deliveredActivations().length);
  const shown: string[] = [];
  for (const [index, tab] of tabs.entries()) {
    const state = boundary.pages[index]?.dom;
    if (state === "displaying") {
      await shownAs(stub, tab, /kieran|sam/);
      shown.push(
        (await tab.locator("[data-account-username]").textContent()) ?? "",
      );
    } else {
      // A replaced tab is on the "different account" card (or, where a case allows it, another neutral card), which names no account.
      expect(
        otherwise as readonly string[],
        `tab ${index + 1} at the boundary is ${state} (${boundary.pages[index]?.neutral})`,
      ).toContain(state);
      const text = await tab.locator("#neutral-root").innerText();
      expect(text).not.toMatch(/kieran|sam/);
    }
  }
  expectNoArrivalsSince(stub, boundary, [API_EXCHANGE, ACTIVATE]);
  expect(shown.length, "at least one tab displays the account").toBeGreaterThan(
    0,
  );
  expect(new Set(shown).size, "never two different accounts displayed").toBe(1);
  expect(shown[0], "the displayed account is the final activation's").toContain(
    name ?? "",
  );
}

/** The account the ORIGINAL T15 oracle would have expected: the last activation REQUEST to arrive (kept to show where it is wrong). */
const lastArrivedActivationAccount = (stub: AuthStub) => {
  const last = stub.requests
    .filter((r) => r.method === "POST" && r.path === ACTIVATE)
    .at(-1);
  const grant = (last?.body as { grant?: string } | undefined)?.grant;
  return stub.usernameOf(stub.grants.get(grant ?? "")?.account ?? "");
};

test.describe("ordering traces in a real engine (two pages, held answers)", () => {
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
    // Server processing, not settlement (revision 22): no activation was even processed yet.
    expect(stub.serverSessions()).toBe(0);
    holdB.release();
    await shownAs(stub, b, "sam");
    // Tab 1 shows B too, with the superseded notice in the tree.
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await shownAs(stub, a, "sam");
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
    await shownAs(stub, b, "sam", [holdA]);
    holdA.release();
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await shownAs(stub, a, "sam");
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
    await shownAs(stub, b, "sam", [holdA]);
    holdA.release();
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      a.getByText("That username or password isn't right."),
    ).toHaveCount(0);
    await shownAs(stub, a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
  });

  test("T15 (both tabs sign in at once): whichever order the engine runs them in, at most ONE account is displayed, it is the one activated last, and a replaced tab shows nothing about it", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    // Both tabs try at once. Whichever tab's sign-in reaches the gating phase first REPLACES the other tab's form with the
    // "Finishing sign-in" card (matrix 3.7), possibly between a fill and a click. That is the designed behaviour, not a failure;
    // revision 22 (R28) accepts it only when it is proved (`offerSignIn`), and rethrows every other error.
    const offered = await Promise.all([
      offerSignIn(a, "kieran", "pw"),
      offerSignIn(b, "sam", "pw2"),
    ]);
    expect(offered, "at least one tab submitted").toContain("submitted");
    // Neither order is guaranteed: if one tab finishes before the other begins it shows state 1d afterwards (the switch journey is
    // WEB-08c's), or a sign-in admitted before the first tab's shell appeared is activated after it; if both begin first, the older
    // attempt is discarded. Revision 22 (R28): the expected account is fixed only at the COMPLETION BOUNDARY of every admitted attempt
    // (the old sample of a moment when neither DOM looked transitional was taken before a later activation, see S03 below).
    const boundary = await settleAuth(stub, [a, b]);
    await expectFinalIdentity(stub, [a, b], boundary);
    // The cookie is the session of the last activation, and only activations changed it (no activation is refused in this case).
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
    await shownAs(stub, b, "sam");
    // The notice was published by the controller after tab 1's form had unmounted, and still reaches the person.
    await expect(a.locator('[data-notice="feedback-superseded"]')).toBeVisible({
      timeout: 20_000,
    });
    await shownAs(stub, a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
    const grantForKieran = [...stub.grants.values()].find(
      (g) => stub.accounts.get(g.account)?.username === "kieran",
    );
    expect(grantForKieran?.state).toBe("issued");
  });

  test("HF-1 correction (HF1-SHARED-CONFIRMATION-20261013): after B settles with another page open, NO page makes an identity read, B's tree never closes again, and ONE Settings click lands", async ({
    context,
  }) => {
    const stub = await newStub(context);
    await recordGateTransitions(context);
    const [a, b] = await twoTabs(context);
    const holdActivate = stub.hold(isActivate, 1);
    await signInForm(b, "sam", "pw2");
    await expect.poll(() => stub.count("POST", ACTIVATE)).toBe(1);
    const identityReadsBefore = stub.count("GET", "/browser-sessions/current");
    holdActivate.release();
    await expect(
      b.locator("#protected-root:not([inert])").getByRole("navigation"),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      a.locator("#protected-root:not([inert])").getByRole("navigation"),
    ).toBeVisible({ timeout: 20_000 });
    // Both pages displayed; let every post-settlement request of both run (the sync start, the labels, the device list).
    await b.waitForTimeout(3_000);
    expect(
      stub.count("GET", "/browser-sessions/current") - identityReadsBefore,
      "no page makes an identity read after the settlement (the shared confirmation and token)",
    ).toBe(0);
    // Every write after the settlement carried the settled session's own token (shared, never another session's).
    const session = stub.cookie;
    for (const r of stub.requests.filter((r) => r.csrf !== null))
      expect(r.csrf).toBe(`csrf.${session}`);
    // B's protected tree, once exposed, was never closed again (no transition back to inert or to the gate).
    const log = await gateLog(b);
    const firstOpen = log.findIndex((e) => !e.inert && !e.gateOpen);
    expect(firstOpen, "B displayed").toBeGreaterThanOrEqual(0);
    expect(
      log.slice(firstOpen).filter((e) => e.inert || e.gateOpen),
      "B's tree never closed after it was first displayed",
    ).toEqual([]);
    // The original single click.
    await shownAsDirectly(b, "sam");
    await shownAsDirectly(a, "sam");
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
    await shownAs(stub, b, "sam");
    await shownAs(stub, a, "sam");
    expect(stub.cookieHistory.length).toBe(2);
  });
});

/**
 * WEB-14a revision 22, review R28 (design assessment C1-C2, schedules S01-S05): the completion boundary itself, qualified with
 * deterministic holds. Each case opens a gap the original T15 oracle did not see, shows where that oracle would have fixed its
 * expectation, and requires the corrected one to wait, take the final DELIVERED activation and compare the UI only afterwards.
 */
test.describe("revision 22, R28: the completion boundary of concurrent sign-ins", () => {
  for (const [delayed, other] of [
    ["kieran", "sam"],
    ["sam", "kieran"],
  ] as const)
    test(`S03 [digest] (the T15 reproduction): a sign-in admitted before the other tab's shell appeared, still hashing its challenge, is activated after it; ${delayed} delayed`, async ({
      context,
    }) => {
      const stub = await newStub(context);
      const [a, b] = await twoTabs(context);
      const password = (user: string) => (user === "kieran" ? "pw" : "pw2");
      await delayDigest(a);
      expect(await offerSignIn(a, delayed, password(delayed))).toBe(
        "submitted",
      );
      // Admitted, and parked BEFORE its first request: nothing of tab 1's attempt is on the wire.
      expect(stub.count("POST", API_EXCHANGE)).toBe(0);
      expect(await offerSignIn(b, other, password(other))).toBe("submitted");
      // The moment the original oracle sampled: neither tab looks transitional.
      await expect
        .poll(
          async () =>
            (await Promise.all([a, b].map((p) => workOf(p)))).map((w) => w.dom),
          { timeout: 20_000 },
        )
        .toEqual(["displaying", "displaying"]);
      expect(
        lastArrivedActivationAccount(stub),
        "what the original oracle would have fixed here",
      ).toBe(other);
      // The settled tab's own work ends (its readers, the peer's verification closure and the remount)...
      await expect
        .poll(async () => (await lookAt(stub, [a, b])).reasons[1], {
          timeout: 20_000,
        })
        .toEqual([]);
      // ...but the boundary is not reached: the delayed tab's admitted attempt has not even sent its exchange.
      const look = await lookAt(stub, [a, b]);
      expect(
        look.reasons[0],
        "the delayed tab's admitted attempt is unfinished work",
      ).toContain("1 challenge digest(s)");
      expect(stub.count("POST", API_EXCHANGE)).toBe(1);
      await releaseDigest(a);
      const boundary = await settleAuth(stub, [a, b]);
      expect(
        stub.deliveredActivations().map((d) => stub.usernameOf(d.account)),
      ).toEqual([other, delayed]);
      await expectFinalIdentity(stub, [a, b], boundary);
    });

  test("S01 [lock]: a sign-in admitted but still waiting to ask for atlas-auth keeps the boundary open; it then activates last", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    await delayLocks(a);
    expect(await offerSignIn(a, "kieran", "pw")).toBe("submitted");
    expect(stub.count("POST", API_EXCHANGE)).toBe(0);
    expect(await offerSignIn(b, "sam", "pw2")).toBe("submitted");
    await expect
      .poll(async () => (await workOf(b)).dom, { timeout: 20_000 })
      .toBe("displaying");
    await expect
      .poll(async () => (await lookAt(stub, [a, b])).reasons[1])
      .toEqual([]);
    const look = await lookAt(stub, [a, b]);
    expect(
      (look.reasons[0] ?? []).join("; "),
      "the delayed tab's lock request is unfinished work",
    ).toMatch(/pending .*atlas-auth/);
    await releaseLocks(a);
    const boundary = await settleAuth(stub, [a, b]);
    expect(
      stub.deliveredActivations().map((d) => stub.usernameOf(d.account)),
    ).toEqual(["sam", "kieran"]);
    await expectFinalIdentity(stub, [a, b], boundary);
  });

  test("S05 [refused]: a later activation that is refused does not supply the expected account; the last delivered success does", async ({
    context,
    provokes,
  }) => {
    provokes(503);
    const stub = await newStub(context);
    let activations = 0;
    stub.answerNext((r) => isActivate(r) && ++activations === 2, {
      status: 503,
      body: {
        code: "device_capacity",
        message: "capacity",
        request_id: "req-capacity",
        details: [],
      },
    });
    const [a, b] = await twoTabs(context);
    await delayDigest(a);
    expect(await offerSignIn(a, "kieran", "pw")).toBe("submitted");
    expect(await offerSignIn(b, "sam", "pw2")).toBe("submitted");
    await expect
      .poll(async () => (await workOf(b)).dom, { timeout: 20_000 })
      .toBe("displaying");
    await releaseDigest(a);
    const boundary = await settleAuth(stub, [a, b]);
    expect(
      stub.deliveries
        .filter((d) => d.path === ACTIVATE)
        .map((d) => [d.state, d.status]),
    ).toEqual([
      ["fulfilled", 200],
      ["fulfilled", 503],
    ]);
    expect(
      lastArrivedActivationAccount(stub),
      "the last ARRIVED activation is the refused one",
    ).toBe("kieran");
    // The refused tab may be left on a neutral card that names no account (observed: state 3, recorded in the revision-22 report as
    // OBS-R22-1 for its owners); what R28 requires is that it never displays the refused account and the expectation is the delivered one.
    await expectFinalIdentity(stub, [a, b], boundary, {
      otherwise: ["different_account", "neutral"],
    });
    expect(
      stub.usernameOf(stub.deliveredActivations().at(-1)?.account ?? ""),
    ).toBe("sam");
  });

  test("S05 [aborted]: a later activation whose answer is lost does not supply the expected account; the boundary waits for its resolution", async ({
    context,
    provokes,
  }) => {
    provokes("abort");
    const stub = await newStub(context);
    let activations = 0;
    stub.answerNext((r) => isActivate(r) && ++activations === 2, "abort");
    const [a, b] = await twoTabs(context);
    await delayDigest(a);
    expect(await offerSignIn(a, "kieran", "pw")).toBe("submitted");
    expect(await offerSignIn(b, "sam", "pw2")).toBe("submitted");
    await expect
      .poll(async () => (await workOf(b)).dom, { timeout: 20_000 })
      .toBe("displaying");
    await releaseDigest(a);
    const boundary = await settleAuth(stub, [a, b]);
    expect(
      stub.deliveries.filter((d) => d.path === ACTIVATE).map((d) => d.state),
    ).toEqual(["fulfilled", "aborted"]);
    expect(stub.recordsFor(ACTIVATE)[1]?.status, "processed as a 200").toBe(
      200,
    );
    expect(lastArrivedActivationAccount(stub)).toBe("kieran");
    await expectFinalIdentity(stub, [a, b], boundary, {
      otherwise: ["different_account", "neutral"],
    });
    expect(
      stub.usernameOf(stub.deliveredActivations().at(-1)?.account ?? ""),
    ).toBe("sam");
  });

  test("S04 [replaced]: a form the other tab's activation replaced before the fill is 'replaced', with no submission and no work", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    const hold = stub.hold(isActivate, 1);
    expect(await offerSignIn(b, "sam", "pw2")).toBe("submitted");
    await expect(
      a.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 20_000 });
    expect(await offerSignIn(a, "kieran", "pw")).toBe("replaced");
    expect((await workOf(a)).submits, "tab 1 submitted nothing").toEqual([]);
    hold.release();
    const boundary = await settleAuth(stub, [a, b]);
    expect(stub.count("POST", API_EXCHANGE)).toBe(1);
    await expectFinalIdentity(stub, [a, b], boundary);
  });

  test("S04 [unproved]: a time-out with the form still offered, any other error and a closed page are never 'replaced'", async ({
    context,
  }) => {
    await newStub(context);
    const [a] = await twoTabs(context);
    const timeout = new errors.TimeoutError("locator.fill: Timeout 4000ms");
    await expect(
      classifyOfferError(a, timeout, 0),
      "a time-out with the form still offered is rethrown",
    ).rejects.toBe(timeout);
    const other = new Error("strict mode violation");
    await expect(
      classifyOfferError(a, other, 0),
      "an error other than a time-out is rethrown",
    ).rejects.toBe(other);
    const closing = await context.newPage();
    await closing.goto("/");
    await closing.getByLabel("Username").waitFor();
    await closing.close();
    await expect(
      classifyOfferError(closing, timeout, 0),
      "a closed page's time-out is rethrown",
    ).rejects.toBe(timeout);
  });
});

/**
 * WEB-14a revision 22, review R28 (design assessment C3, schedule S08): the Settings navigation. The retained Firefox T3 trace
 * (revision 19) and the accepted-main T15 trace show the same thing: `shownAs` pressed the shell's Settings link, and between the press
 * and the release the tree was CLOSED by the other tab's leased verification read (1e "interrupted": matrix 3.6 forbids a display while
 * another page's request that can fence the account is unresolved). The click reached no link and no navigation was dispatched. These
 * cases pin the boundary: the initial redirect is done before the shell offers navigation; an ACCEPTED navigation survives the closure
 * and the remount; a click that the closure interrupts navigates nowhere, and the person's next click works.
 */
test.describe("revision 22, R28: the Settings navigation across the initial redirect and a peer's verification", () => {
  /** Records the address at the first moment the shell's Settings link exists, and every history write, from the first script. */
  async function watchNavigation(context: BrowserContext) {
    await context.addInitScript(() => {
      const w = window as unknown as {
        __nav: { firstLink: string | null; writes: string[] };
      };
      w.__nav = { firstLink: null, writes: [] };
      for (const method of ["pushState", "replaceState"] as const) {
        const real = history[method].bind(history);
        history[method] = (...args) => {
          w.__nav.writes.push(`${method} ${String(args[2])}`);
          return real(...args);
        };
      }
      new MutationObserver(() => {
        if (
          w.__nav.firstLink === null &&
          document.querySelector('nav a[href="/settings"]')
        )
          w.__nav.firstLink = location.pathname;
      }).observe(document, { subtree: true, childList: true });
    });
  }
  const navOf = (page: Page) =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __nav: { firstLink: string | null; writes: string[] };
          }
        ).__nav,
    );
  /**
   * Closes `b`'s display deterministically with the designed 1e "interrupted" state: tab `a` reloads, its verification reads
   * (`/browser-sessions/current`) are held, and the tab is then CLOSED while they are unresolved. Its lease lock is released with the
   * lease still in the record, so tab `b` must not display until its own verification has resolved it; that read is held too. The
   * returned release lets it go. (Closing, not navigating: a Firefox document that navigates away mid-request was observed NOT to leave
   * its lease unresolved, so only a close is the same schedule in all three engines.)
   */
  async function closeByPeerVerification(stub: AuthStub, a: Page, b: Page) {
    const current =
      (page: Page) =>
      (r: { method: string; path: string; page: Page | null }) =>
        r.method === "GET" &&
        r.path === "/browser-sessions/current" &&
        r.page === page;
    const heldA = stub.hold(current(a));
    await a.reload();
    await expect
      .poll(
        () =>
          stub.deliveries.some((d) => d.hold === heldA && d.state === "held"),
        { timeout: 20_000 },
      )
      .toBe(true);
    const heldB = stub.hold(current(b));
    await a.close();
    await expect
      .poll(
        async () => ({
          neutral: (await workOf(b)).neutral,
          verifying: stub.deliveries.some(
            (d) => d.hold === heldB && d.state === "held",
          ),
        }),
        { timeout: 20_000 },
      )
      .toEqual({ neutral: "1e.interrupted_online", verifying: true });
    await expect(
      b.locator("#protected-root"),
      "the closed display offers nothing",
    ).toHaveAttribute("inert", "");
    return {
      release() {
        heldA.release();
        heldB.release();
      },
    };
  }

  test("S08 [initial]: the redirect from / to /today is done before the shell offers its Settings link", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await watchNavigation(context);
    await page.goto("/");
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, [page]);
    const nav = await navOf(page);
    expect(nav.firstLink, "the address when the link first existed").toBe(
      "/today",
    );
    expect(nav.writes.filter((w) => w.startsWith("pushState"))).toEqual([]);
    await shownAs(stub, page, "kieran");
  });

  test("S08 [accepted]: a Settings navigation accepted before a peer's verification closes the display is kept through the closure and the remount", async ({
    context,
  }) => {
    const stub = await newStub(context);
    await watchNavigation(context);
    const [a, b] = await twoTabs(context);
    await signInForm(b, "sam", "pw2");
    await shownAs(stub, b, "sam");
    const writes = (await navOf(b)).writes.length;
    const held = await closeByPeerVerification(stub, a, b);
    held.release();
    await settleAuth(stub, [b]);
    expect((await workOf(b)).dom).toBe("displaying");
    expect(new URL(b.url()).pathname, "the accepted route is kept").toBe(
      "/settings",
    );
    expect(
      (await navOf(b)).writes.slice(writes),
      "no later history write took the person elsewhere",
    ).toEqual([]);
    await expect(b.locator("[data-account-card]")).toContainText("sam", {
      timeout: 20_000,
    });
  });

  test("S08 [interrupted] (the T3/T15 navigation reproduction): a click pressed on the link and released after the peer's verification closed the display navigates nowhere; the next click works", async ({
    context,
  }) => {
    const stub = await newStub(context);
    await watchNavigation(context);
    const [a, b] = await twoTabs(context);
    await signInForm(b, "sam", "pw2");
    await settleAuth(stub, [a, b]);
    expect(new URL(b.url()).pathname).toBe("/today");
    const link = b
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first();
    const box = await link.boundingBox();
    if (!box) throw new Error("no Settings link to press");
    const writes = (await navOf(b)).writes.length;
    await b.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await b.mouse.down();
    const held = await closeByPeerVerification(stub, a, b);
    await b.mouse.up();
    expect(
      (await navOf(b)).writes.slice(writes),
      "no navigation was dispatched",
    ).toEqual([]);
    held.release();
    await settleAuth(stub, [b]);
    expect((await workOf(b)).dom).toBe("displaying");
    expect(
      new URL(b.url()).pathname,
      "the interrupted click went nowhere",
    ).toBe("/today");
    await expect(b.locator("[data-account-card]")).toHaveCount(0);
    await shownAs(stub, b, "sam");
  });
});

/**
 * WEB-14a revision 22 (design assessment DA-H1, C4, schedule S11): the console guard watches every page of the context. Each
 * undeclared problem below must FAIL its test (`test.fail()`), on a page the fixture did not create; the controls must pass.
 */
test.describe("revision 22, C4: the console guard watches every page", () => {
  test("S11 [second tab]: an undeclared console error in a tab opened with context.newPage fails the test", async ({
    context,
  }) => {
    test.fail();
    await newStub(context);
    const other = await context.newPage();
    await other.goto("/");
    await other.getByLabel("Username").waitFor();
    await other.evaluate(() => console.error("revision 22 guard probe"));
    await expect.poll(() => true).toBe(true);
  });

  test("S11 [page error]: an uncaught error in a page opened later fails the test", async ({
    context,
  }) => {
    test.fail();
    await newStub(context);
    const other = await context.newPage();
    await other.goto("/");
    await other.getByLabel("Username").waitFor();
    await other.evaluate(() =>
      setTimeout(() => {
        throw new Error("revision 22 guard probe");
      }),
    );
    await other.waitForTimeout(200);
  });

  test("S11 [before close]: a warning a tab reports just before it closes still fails the test", async ({
    context,
  }) => {
    test.fail();
    await newStub(context);
    const other = await context.newPage();
    await other.goto("/");
    await other.getByLabel("Username").waitFor();
    await other.evaluate(() => console.warn("revision 22 guard probe"));
    await other.close();
  });

  test("S11 [control]: a status the test declares, provoked in a second tab, and Playwright's worker notice pass", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const stub = await newStub(context);
    const other = await context.newPage();
    await other.goto("/");
    await signInForm(other, "kieran", "WRONG");
    await expect(other.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    await settleAuth(stub, [other]);
  });
});

/**
 * WEB-14a revision 23, review r22 R28 (design assessment `d6673007`, C2-C5, Q01-Q11): the completion boundary covers what happens AFTER
 * an answer's headers. A body holder is installed by a LATER init script than the work observer, exactly as the reviewer's probes were,
 * so it is composed inside the observer's outermost body accessors: it lets the native read finish and then holds the consumer (or, with
 * `hold: false`, releases it at once: the matched control). Optionally it substitutes another account in an identity body (the
 * consequential schedule). Arming survives a reload of the tab (sessionStorage) for the closed-document schedule. The 750 ms windows only
 * bound how long a case watches for a premature boundary; no production timer is changed.
 */
test.describe("revision 23, R28: the boundary covers response consumption and the record's obligations", () => {
  interface Arm {
    method: "arrayBuffer" | "json";
    /** A path suffix of the response's URL, or `synthetic` for the first reconstructed Response decoded after a `/me` buffering. */
    path: string;
    hold: boolean;
    substitute?: string;
    /** The answer's status (200 when omitted). */
    status?: number;
  }
  async function holdBodies(context: BrowserContext) {
    await context.addInitScript(() => {
      // An `about:blank` page (the fixture's `page`, a fresh tab) runs no application and may not use sessionStorage.
      if (!location.protocol.startsWith("http")) return;
      const w = window as unknown as {
        __r23: {
          arm: Arm | null;
          entered: boolean;
          released: boolean;
          sawMe: boolean;
        };
        __r23release: () => void;
        __r23arm: (arm: Arm) => void;
      };
      let unlock: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const stored = sessionStorage.getItem("r23-arm");
      w.__r23 = {
        arm: stored ? (JSON.parse(stored) as Arm) : null,
        entered: false,
        released: false,
        sawMe: false,
      };
      if (stored) sessionStorage.removeItem("r23-arm");
      w.__r23arm = (arm) => {
        w.__r23.arm = arm;
      };
      w.__r23release = () => {
        w.__r23.released = true;
        unlock();
      };
      for (const method of ["arrayBuffer", "json"] as const) {
        const real = Response.prototype[method] as (
          this: Response,
        ) => Promise<unknown>;
        (Response.prototype as unknown as Record<string, unknown>)[method] =
          async function (this: Response) {
            const arm = w.__r23.arm;
            const ours =
              arm !== null &&
              !w.__r23.entered &&
              arm.method === method &&
              this.status === (arm.status ?? 200) &&
              (arm.path === "synthetic"
                ? this.url === "" && w.__r23.sawMe
                : this.url.endsWith(arm.path));
            if (method === "arrayBuffer" && this.url.endsWith("/me"))
              w.__r23.sawMe = true;
            if (!ours) return real.call(this);
            w.__r23.entered = true;
            const value = await real.call(this);
            if (arm.hold) await gate;
            return arm.substitute
              ? { ...(value as object), account_id: arm.substitute }
              : value;
          };
      }
    });
  }
  const arm = (page: Page, value: Arm) =>
    page.evaluate(
      (a) =>
        (window as unknown as { __r23arm: (arm: Arm) => void }).__r23arm(a),
      value,
    );
  const entered = (page: Page) =>
    expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __r23: { entered: boolean } }).__r23
                .entered,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
  const releaseBody = (page: Page) =>
    page.evaluate(() =>
      (window as unknown as { __r23release: () => void }).__r23release(),
    );
  /** Whether `pending` settles within the observation window (it is left running: the case awaits it later). */
  const within = async (pending: Promise<unknown>, ms = 750) =>
    Promise.race([
      pending.then(
        () => "settled" as const,
        (error: unknown) => `error: ${String(error)}`,
      ),
      new Promise<"still-waiting">((resolve) =>
        setTimeout(() => resolve("still-waiting"), ms),
      ),
    ]);
  async function signedIn(context: BrowserContext) {
    const stub = await newStub(context);
    await holdBodies(context);
    const page = await context.newPage();
    await page.goto("/");
    await page.getByLabel("Username").waitFor();
    return { stub, page };
  }
  async function toSettings(page: Page) {
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect(page, "the Settings click navigated").toHaveURL(
      /\/settings$/,
      { timeout: 4000 },
    );
  }

  for (const consequential of [true, false])
    test(`B1 [identity held] ${consequential ? "consequential" : "normal"} (the reviewer's R28 probe): a delivered identity answer whose decode is held keeps the boundary open; on release it is classified`, async ({
      context,
    }) => {
      const { stub, page } = await signedIn(context);
      const sam = [...stub.accounts.values()].find((a) => a.username === "sam");
      await arm(page, {
        method: "json",
        path: "/browser-sessions/current",
        hold: true,
        substitute: consequential ? sam?.id : undefined,
      });
      await signInForm(page, "kieran", "pw");
      await entered(page);
      const boundary = settleAuth(stub, pagesOf(page));
      expect(
        await within(boundary),
        "an undecoded identity response is unfinished work",
      ).toBe("still-waiting");
      const look = await lookAt(stub, pagesOf(page));
      expect(look.reasons[pagesOf(page).indexOf(page)]).toContain(
        "reading response bodies: json /browser-sessions/current",
      );
      expect(
        look.shared.join("; "),
        "the surrendered lease is still in the record",
      ).toMatch(/unretired request leases: verification/);
      await releaseBody(page);
      const settled = await boundary;
      const at = pagesOf(page).indexOf(page);
      expect(settled.durable?.leases, "no request lease left").toEqual({});
      if (consequential) {
        expect(settled.pages[at]?.dom).toBe("different_account");
        await expect(page.locator("#neutral-root")).not.toContainText(
          /kieran|sam/,
        );
      } else {
        expect(settled.pages[at]?.dom).toBe("displaying");
        await shownAs(stub, page, "kieran");
      }
    });

  test("B1 [control]: the same identity decode released at once settles, and the account is shown", async ({
    context,
  }) => {
    const { stub, page } = await signedIn(context);
    await arm(page, {
      method: "json",
      path: "/browser-sessions/current",
      hold: false,
    });
    await signInForm(page, "kieran", "pw");
    await entered(page);
    const settled = await settleAuth(stub, pagesOf(page));
    expect(settled.pages[pagesOf(page).indexOf(page)]?.dom).toBe("displaying");
    await shownAs(stub, page, "kieran");
  });

  for (const [tag, method, path, read] of [
    ["buffer held", "arrayBuffer", "/me", "arrayBuffer /me"],
    ["decode held", "json", "synthetic", "json synthetic"],
  ] as const)
    test(`B2 [${tag}]: an ordinary reader whose lease is already retired keeps the boundary open while its ${method === "json" ? "reconstructed response is decoded" : "body is buffered"}`, async ({
      context,
    }) => {
      const { stub, page } = await signedIn(context);
      await signInForm(page, "kieran", "pw");
      await settleAuth(stub, pagesOf(page));
      await arm(page, { method, path, hold: true });
      await toSettings(page);
      await entered(page);
      const boundary = settleAuth(stub, pagesOf(page));
      expect(
        await within(boundary),
        "the held body read is unfinished work",
      ).toBe("still-waiting");
      // The lease was retired before the body was read: the body read is then the ONLY witness of the unfinished reader.
      const at = pagesOf(page).indexOf(page);
      await expect
        .poll(async () => {
          const look = await lookAt(stub, pagesOf(page));
          return { page: look.reasons[at], shared: look.shared };
        })
        .toEqual({ page: [`reading response bodies: ${read}`], shared: [] });
      await releaseBody(page);
      await boundary;
      await expect(page.locator("[data-account-card]")).toContainText(
        "kieran",
        { timeout: 20_000 },
      );
    });

  test("B2 [control]: the same reader with its buffering released at once settles, and the card shows the account", async ({
    context,
  }) => {
    const { stub, page } = await signedIn(context);
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, pagesOf(page));
    await arm(page, { method: "arrayBuffer", path: "/me", hold: false });
    await toSettings(page);
    await entered(page);
    await settleAuth(stub, pagesOf(page));
    await expect(page.locator("[data-account-card]")).toContainText("kieran", {
      timeout: 20_000,
    });
  });

  test("B3 [retirement refused]: while a reader's lease retirement fails and retries on its back-off, the record alone keeps the boundary open", async ({
    context,
  }) => {
    const { stub, page } = await signedIn(context);
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, pagesOf(page));
    await failLeaseRetirement(page, true);
    await toSettings(page);
    const at = pagesOf(page).indexOf(page);
    // A look in the back-off gap: no fetch, body, lock wait or transaction on the page, and the lease still in the record.
    await expect
      .poll(
        async () => {
          const look = await lookAt(stub, pagesOf(page));
          return {
            page: look.reasons[at],
            // Read from the record itself, not from the reasons (the counterfactual K11 removes the reason, never the lease).
            leased: Object.keys(look.durable?.leases ?? {}).length > 0,
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({ page: [], leased: true });
    const boundary = settleAuth(stub, pagesOf(page));
    expect(
      await within(boundary),
      "an unretired request lease is unfinished work",
    ).toBe("still-waiting");
    await failLeaseRetirement(page, false);
    const settled = await boundary;
    expect(settled.durable?.leases).toEqual({});
    await expect(page.locator("[data-account-card]")).toContainText("kieran", {
      timeout: 20_000,
    });
  });

  test("B4 [peer held]: a tab's held identity decode keeps the two-tab boundary open while the other tab displays", async ({
    context,
  }) => {
    const stub = await newStub(context);
    await holdBodies(context);
    const [a, b] = await twoTabs(context);
    await arm(a, {
      method: "json",
      path: "/browser-sessions/current",
      hold: true,
    });
    await signInForm(b, "sam", "pw2");
    await entered(a);
    await expect
      .poll(async () => (await workOf(b)).dom, { timeout: 20_000 })
      .toBe("displaying");
    const boundary = settleAuth(stub, [a, b]);
    expect(
      await within(boundary),
      "the other tab's undecoded identity answer is unfinished work",
    ).toBe("still-waiting");
    await releaseBody(a);
    const settled = await boundary;
    expect(settled.pages.map((p) => p.dom)).toEqual([
      "displaying",
      "displaying",
    ]);
    await shownAs(stub, a, "sam");
    await shownAs(stub, b, "sam");
  });

  test("B5 [closed]: a tab closed while its identity decode is held: the boundary waits for it, then for the other tab's resolution of its lease", async ({
    context,
  }) => {
    const stub = await newStub(context);
    await holdBodies(context);
    const [a, b] = await twoTabs(context);
    await signInForm(b, "sam", "pw2");
    await settleAuth(stub, [a, b]);
    const verifications = () =>
      stub.deliveries.filter(
        (d) => d.page === b && d.path === "/browser-sessions/current",
      ).length;
    const before = verifications();
    await a.evaluate(
      (value) => {
        sessionStorage.setItem("r23-arm", JSON.stringify(value));
      },
      {
        method: "json",
        path: "/browser-sessions/current",
        hold: true,
      } satisfies Arm,
    );
    await a.reload();
    await entered(a);
    expect(
      await within(settleAuth(stub, [a, b])),
      "the reloaded tab's undecoded identity answer is unfinished work",
    ).toBe("still-waiting");
    // The document goes with its pending decode: what it leaves is the record, which the other tab resolves.
    await a.close();
    const settled = await settleAuth(stub, [b]);
    expect(
      settled.durable?.leases,
      "the closed tab's lease was resolved",
    ).toEqual({});
    expect(
      verifications(),
      "the remaining tab verified the surrendered lease",
    ).toBeGreaterThan(before);
    expect(settled.pages[0]?.dom).toBe("displaying");
    await shownAs(stub, b, "sam");
  });

  test("B6 [inventory]: a live page left out of the inventory, with an admitted sign-in, invalidates the boundary", async ({
    context,
  }) => {
    const stub = await newStub(context);
    const [a, b] = await twoTabs(context);
    await delayDigest(a);
    expect(await offerSignIn(a, "kieran", "pw")).toBe("submitted");
    await expect(
      settleAuth(stub, [b], { timeout: 2000 }),
      "an unnamed page invalidates the boundary",
    ).rejects.toThrow(/not in the completion boundary's inventory/);
    await releaseDigest(a);
    const settled = await settleAuth(stub, [a, b]);
    expect(settled.activations.map((d) => stub.usernameOf(d.account))).toEqual([
      "kieran",
    ]);
  });

  test("B7 [navigation readers]: `shownAs` returns only after the readers the Settings navigation started have finished", async ({
    context,
  }) => {
    const { stub, page } = await signedIn(context);
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, pagesOf(page));
    await arm(page, { method: "arrayBuffer", path: "/sessions", hold: true });
    const shown = shownAs(stub, page, "kieran");
    await entered(page);
    expect(
      await within(shown),
      "a Settings reader still being read is unfinished work",
    ).toBe("still-waiting");
    await releaseBody(page);
    await shown;
  });

  test("B9 [cloned 403]: an ordinary refusal whose CLONED error body is still being classified keeps the boundary open; it ends as a refusal", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const { stub, page } = await signedIn(context);
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, pagesOf(page));
    stub.answerNext((r) => r.method === "GET" && r.path === "/sessions", {
      status: 403,
      body: {
        code: "forbidden",
        message: "forbidden",
        request_id: "req-r23",
        details: [],
      },
    });
    await arm(page, {
      method: "json",
      path: "/sessions",
      status: 403,
      hold: true,
    });
    await toSettings(page);
    await entered(page);
    const boundary = settleAuth(stub, pagesOf(page));
    expect(
      await within(boundary),
      "a 403 still being classified is unfinished work",
    ).toBe("still-waiting");
    const look = await lookAt(stub, pagesOf(page));
    expect(look.reasons[pagesOf(page).indexOf(page)]).toContain(
      "reading response bodies: json clone of /sessions",
    );
    expect(
      Object.keys(look.durable?.leases ?? {}),
      "the surrendered lease is still in the record",
    ).toEqual(["ordinary"]);
    await releaseBody(page);
    const settled = await boundary;
    expect(settled.durable?.leases, "an ordinary refusal retires it").toEqual(
      {},
    );
    expect(
      settled.durable?.fences,
      "an ordinary refusal is not an observation",
    ).toEqual([]);
    await expect(page.locator("[data-account-card]")).toContainText("kieran", {
      timeout: 20_000,
    });
  });

  test("B8 [contract] (Q11): the observer keeps native Response semantics, follows clones, cancellations and later wrappers, reports what it cannot follow, copies no content and leaves its own record reads out of the S10 recorder", async ({
    context,
  }) => {
    // The recorder is installed BEFORE the observer here (S10 installs it after): this is the order in which the observer's own reads
    // pass through the recorder's wrapper, so its exclusion is exercised.
    const log = await recordAuthTransactions(context);
    const stub = await newStub(context);
    const page = await context.newPage();
    await page.goto("/");
    await page.getByLabel("Username").waitFor();
    await settleAuth(stub, [page]);
    const result = await page.evaluate(async () => {
      type Snap = {
        bodies: string[];
        bodyReads: Record<string, number>;
      };
      const reads = () =>
        (
          window as unknown as { __atlasAuthWork: { snapshot(): Snap } }
        ).__atlasAuthWork.snapshot();
      const nameOf = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return "resolved";
        } catch (error) {
          return (error as Error).name;
        }
      };
      const base = reads().bodyReads;
      const value = await new Response('{"a":1}').json();
      const rejected = await nameOf(() =>
        new Response("secret-body-marker, not JSON").json(),
      );
      const used = new Response("x");
      await used.text();
      const duplicate = await nameOf(() => used.text());
      const original = new Response("y");
      const copy = original.clone();
      const cloned = [await original.text(), await copy.text()];
      await new Response("z").body?.cancel();
      const illegal = await nameOf(() =>
        (Response.prototype.json as (this: unknown) => Promise<unknown>).call(
          {},
        ),
      );
      // A LATER wrapper that holds the consumer after the native decode: composed inside the observed read.
      const real = Response.prototype.json;
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      Response.prototype.json = async function (this: Response) {
        const decoded = await real.call(this);
        if (this.headers.get("x-r23") === "hold") await gate;
        return decoded;
      };
      const pending = new Response('{"b":2}', {
        headers: { "x-r23": "hold" },
      }).json();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const during = reads().bodies;
      open();
      const composed = await pending;
      const after = reads().bodies;
      const end = reads().bodyReads;
      return {
        value,
        rejected,
        duplicate,
        bodyUsed: used.bodyUsed,
        cloned,
        illegal,
        during,
        composed,
        after,
        delta: Object.fromEntries(
          Object.entries(end).map(([key, n]) => [key, n - (base[key] ?? 0)]),
        ),
        snapshot: JSON.stringify(reads()),
      };
    });
    expect(result).toMatchObject({
      value: { a: 1 },
      rejected: "SyntaxError",
      duplicate: "TypeError",
      bodyUsed: true,
      cloned: ["y", "y"],
      illegal: "TypeError",
      during: ["json synthetic"],
      composed: { b: 2 },
      after: [],
      delta: { done: 5, failed: 3, cancelled: 1, clones: 1 },
    });
    expect(result.snapshot, "no body content is kept").not.toContain(
      "secret-body-marker",
    );
    // The observer's own look at the record is labelled and left out of the application's transaction log.
    const logged = log.length;
    for (let i = 0; i < 3; i++)
      expect((await workOf(page, { durable: true })).durable?.readable).toBe(
        true,
      );
    expect(log.length, "the observer's record reads are not logged").toBe(
      logged,
    );
    // What it cannot follow fails the boundary instead of passing silently.
    const other = await context.newPage();
    await other.goto("/");
    await other.getByLabel("Username").waitFor();
    // Its own boot work first (WebKit can still be hashing when the form shows), so the look below sees only what is injected.
    await settleAuth(stub, [page, other]);
    await other.evaluate(() => {
      new Response("q").body?.getReader();
      Object.defineProperty(Response.prototype, "text", {
        configurable: true,
        value: () => Promise.resolve(""),
      });
    });
    expect((await lookAt(stub, [page, other])).reasons[1]).toEqual([
      "unobserved body consumers: getReader on the body of synthetic, Response.prototype.text displaced",
    ]);
    await expect(
      settleAuth(stub, [page, other], { timeout: 1500 }),
      "an unobserved consumer fails the boundary",
    ).rejects.toThrow(/never reached its completion boundary/);
    await other.close();
    await settleAuth(stub, [page]);
  });
});

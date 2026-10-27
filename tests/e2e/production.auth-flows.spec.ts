import { type BrowserContext, errors, type Page } from "@playwright/test";
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
import { test } from "./intercepted-auth";
import { gateLog, recordGateTransitions } from "./lifecycle-browser";
import {
  ageSharedConfirmation,
  type ConfirmationAgeing,
  type SettledIdentity,
  settledIdentityOf,
  sharedConfirmationAge,
} from "./shared-confirmation";

/**
 * WEB-14a revision 19, labelled HARNESS ADAPTATION (Kieran, 15 October 2026): the production build registers the app's service worker
 * (WEB-14a), and Playwright WebKit does not apply `context.route` to requests a worker passes on, so the AuthStub never answered there
 * and most WebKit cases failed (also on the unmodified revision-18 candidate). These specs test the authentication surfaces, not the
 * worker: they run without it. The worker in the production build is covered by production.pwa.spec.ts and production.offline.spec.ts.
 * Revision 34 (R37): the `test` of ./intercepted-auth now blocks worker registration for every AuthStub suite and refuses another
 * setting, in place of this file's own `test.use`.
 */

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

/**
 * INT-N1 (review-integration-fresh-20261024): `PublicCard` focuses its heading in an effect AFTER the form is on screen. A fill
 * that starts before that effect can be focused away between its focus and its insertion, so the field stays empty and the
 * submission is refused locally. Entry therefore waits until THIS document's public heading holds focus (the initial focus action
 * of the current surface is over), types each field once, checks the exact values and only then lets the caller submit once.
 * Not for a retry after a refusal: there focus is on the field the message belongs to, not on the heading.
 */
async function publicEntryReady(page: Page) {
  await expect(page.locator("main[data-public-surface] h1")).toBeFocused();
}
async function enterCredentials(
  page: Page,
  username: string,
  password: string,
) {
  await publicEntryReady(page);
  const user = page.getByLabel("Username");
  const secret = page.getByLabel("Password");
  await user.fill(username);
  await secret.fill(password);
  await expect(user).toHaveValue(username);
  await expect(secret).toHaveValue(password);
}
const signInForm = async (page: Page, username: string, password: string) => {
  await enterCredentials(page, username, password);
  await page.getByRole("button", { name: "Sign in" }).click();
};

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

/** Every identity read (`GET /browser-sessions/current`) the stub has received, optionally only `page`'s. */
const identityReads = (stub: AuthStub, page?: Page) =>
  stub.deliveries.filter(
    (d) =>
      d.method === "GET" &&
      d.path === "/browser-sessions/current" &&
      (page === undefined || d.page === page),
  );

interface EligibleVerification {
  settled: SettledIdentity;
  receipt: ConfirmationAgeing;
  /** The document being replaced, the stub's cookie revision and `page`'s identity reads so far. */
  doc: string;
  cookieRevision: number;
  reads: number;
}

/**
 * WEB-14a revision 35 (review R38, family `production-auth-settlement-observation-ordering`, classification `regression` of the
 * maintained premise; design assessment C3/C4). Since HF1-SHARED-CONFIRMATION-20261013 a settlement's shared confirmation spares every
 * page's resume verification for 30 s, and a reload within that time makes NO `/browser-sessions/current` read (the accepted
 * behaviour, which the R38 failures assumed away). A case that needs the read of `page`'s NEXT document prepares it here, after its
 * authentication work has finished: it reads the settled triple (which must be the stub's cookie session), ages ONLY the confirmation's
 * time (tests/e2e/shared-confirmation.ts: checked transaction, token and every other field kept) and checks no other writer refreshed it.
 * Both reads use their own connection in `page`'s CURRENT document, which the caller then replaces (`page.reload()`) before it is
 * observed again (the observer constraint in shared-confirmation.ts). A new document has no earlier verification of its own, so its
 * display's verification is eligible; `expectNewDocument` proves the replacement kept the same settlement.
 */
async function prepareEligibleVerification(
  stub: AuthStub,
  page: Page,
): Promise<EligibleVerification> {
  const settled = await settledIdentityOf(page);
  expect(
    settled.session_id,
    "setup: the record settles the stub's cookie session",
  ).toBe(stub.cookie);
  const receipt = await ageSharedConfirmation(page, settled);
  expect(
    (await sharedConfirmationAge(page, settled)).eligible,
    "setup: no other writer refreshed the confirmation after it was aged",
  ).toBe(true);
  return {
    settled,
    receipt,
    doc: (await workOf(page)).doc,
    cookieRevision: stub.cookieHistory.length,
    reads: identityReads(stub, page).length,
  };
}

/** After `page.reload()`: a new document, with the same settlement (no activation since, the same cookie, the same settled epoch). */
async function expectNewDocument(
  stub: AuthStub,
  page: Page,
  prepared: EligibleVerification,
) {
  await expect
    .poll(
      async () => {
        const work = await workOf(page, { durable: true });
        return {
          replaced: work.doc !== prepared.doc,
          readable: work.durable?.readable ?? false,
          settledEpoch: work.durable?.settledEpoch ?? null,
        };
      },
      {
        message:
          "setup (R38): a new document, reading a record that settles the same epoch",
        timeout: 20_000,
      },
    )
    .toEqual({
      replaced: true,
      readable: true,
      settledEpoch: prepared.settled.epoch,
    });
  expect(
    {
      cookieRevision: stub.cookieHistory.length,
      cookie: stub.cookie,
    },
    "setup: no activation changed the session across the reload",
  ).toEqual({
    cookieRevision: prepared.cookieRevision,
    cookie: prepared.settled.session_id,
  });
}

/** Historical D3 bounded setup adaptation, retained only for its labelled controls below. */
const SETTINGS_DEADLINE_MS = 20_000;
const SETTINGS_CLICKS = 3;
async function shownAsWithRetry(page: Page, username: string | RegExp) {
  const nav = page
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first();
  const card = page.locator("[data-account-card]");
  let clicks = 0;
  try {
    await expect(async () => {
      if (clicks < SETTINGS_CLICKS && (await card.count()) === 0) {
        clicks += 1;
        await nav.click({ timeout: 2_000 });
      }
      await expect(card).toContainText(username, { timeout: 3_000 });
    }).toPass({ timeout: SETTINGS_DEADLINE_MS });
  } finally {
    test
      .info()
      .annotations.push({ type: "settings-clicks", description: `${clicks}` });
  }
  return clicks;
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
    await enterCredentials(page, "newbie", PASSWORD);
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
    await enterCredentials(page, "newbie", PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/lost the confirmation/)).toBeVisible();
    expect(
      [...stub.accounts.values()].some((a) => a.username === "newbie"),
    ).toBe(true);
    expect(stub.count("POST", "/browser-registration")).toBe(1);
    await page.getByRole("button", { name: "Sign in" }).click();
    // A new sign-in surface, prefilled: its own initial focus comes first (INT-N1).
    await publicEntryReady(page);
    await expect(page.getByLabel("Username")).toHaveValue("newbie");
    await page.getByLabel("Password").fill(PASSWORD);
    await expect(page.getByLabel("Password")).toHaveValue(PASSWORD);
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
    await enterCredentials(page, "kieran", PASSWORD);
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
    await enterCredentials(page, "newbie", PASSWORD);
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
    await enterCredentials(a, "newbie", PASSWORD);
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
    await enterCredentials(page, firstUsername, PASSWORD);
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
    await enterCredentials(page, "secondperson", SECOND_PASSWORD);
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
    // A new sign-in surface, prefilled: its own initial focus comes first (INT-N1).
    await publicEntryReady(page);
    await expect(page.getByLabel("Username")).toHaveValue("firstperson");
    await page.getByLabel("Password").fill(PASSWORD);
    await expect(page.getByLabel("Password")).toHaveValue(PASSWORD);
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
  // Both entries finish their initial focus before the concurrent schedule begins (INT-N1).
  await publicEntryReady(a);
  await publicEntryReady(b);
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
 * WEB-14a revision 36, review R39 (family attempt-owner-lock-publication-race; design assessment S1/S2/S11, Q4): `begin` commits the
 * second sign-in's epoch and only then takes its owner lock, both under `atlas-auth`. The review's S05 failure lost that epoch to an
 * evaluator that read it in between and saw the owner lock free. These cases hold the REAL owner-lock request of tab 1 (the second
 * sign-in, epoch 2) either before the platform admits it (the name is free: another request on it is granted) or after the platform
 * granted it but before its callback runs (the name is held), and let one evaluator, tab 2's (a peer) or tab 1's own, look in that
 * interval through a real focus. Nothing is fabricated: no lock answer, no record write, no shortened timer; the gate only delays.
 * The original S05 assertions then hold: the second activation is issued and refused or aborted, and the final identity is the last
 * DELIVERED success. (The reviewer's diagnostic expected the fault on the uncorrected source; that observation stays archived in
 * `.agtx/evidence/review-r35-20261025/ownership`.)
 */
interface OwnerGateWindow {
  __ownerGate: {
    entered: boolean;
    probes: boolean[];
    log: Array<Record<string, unknown>>;
    release: () => void;
  };
}
async function installOwnerGate(
  page: Page,
  tag: "A" | "B",
  gateMode: "before-native" | "native-held",
): Promise<void> {
  await page.evaluate(
    ({ tag, gateMode }) => {
      const log: Array<Record<string, unknown>> = [];
      const add = (kind: string, data: Record<string, unknown>) =>
        log.push({ tag, t: performance.now(), kind, ...data });
      let release = () => {};
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = { entered: false, probes: [] as boolean[], log, release };
      (window as unknown as OwnerGateWindow).__ownerGate = state;
      const realPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (
          this.transaction.db.name === "atlas-auth" &&
          args[1] === "auth_state"
        ) {
          const v = args[0] as {
            latest_epoch: number;
            attempt: { epoch: number; phase: string } | null;
            settled: { epoch: number } | null;
          };
          const meta = {
            latest: v.latest_epoch,
            attempt: v.attempt
              ? { epoch: v.attempt.epoch, phase: v.attempt.phase }
              : null,
            settled: v.settled?.epoch ?? null,
          };
          this.transaction.addEventListener(
            "complete",
            () => add("commit", meta),
            { once: true },
          );
        }
        return realPut.apply(this, args);
      };
      const original = LockManager.prototype.request as (
        ...args: unknown[]
      ) => Promise<unknown>;
      LockManager.prototype.request = function (
        this: LockManager,
        ...args: unknown[]
      ) {
        const name = String(args[0]);
        const options = (args.length === 3 ? args[1] : {}) as LockOptions;
        const callback = args[args.length - 1] as (
          lock: Lock | null,
        ) => unknown;
        if (!/^atlas-(auth$|attempt-)/.test(name))
          return original.apply(this, args);
        const owner =
          tag === "A" && name === "atlas-attempt-2" && !options.ifAvailable;
        add("lock-request", {
          name,
          ifAvailable: options.ifAvailable === true,
        });
        const wrapped = (lock: Lock | null) => {
          add("lock-callback", {
            name,
            granted: lock !== null,
            ifAvailable: options.ifAvailable === true,
          });
          if (name === "atlas-attempt-2" && options.ifAvailable)
            state.probes.push(lock !== null);
          if (owner && gateMode === "native-held") {
            state.entered = true;
            add("gate-entered", { mode: gateMode });
            return opened.then(() => callback(lock));
          }
          return callback(lock);
        };
        const run = () => original.apply(this, [...args.slice(0, -1), wrapped]);
        if (owner && gateMode === "before-native") {
          state.entered = true;
          add("gate-entered", { mode: gateMode });
          return opened.then(run);
        }
        return run();
      } as LockManager["request"];
    },
    { tag, gateMode },
  );
}
const ownerGate = (page: Page) =>
  page.evaluate(() => {
    const { entered, probes, log } = (window as unknown as OwnerGateWindow)
      .__ownerGate;
    return { entered, probes, log };
  });

test.describe("revision 36, R39: a second sign-in's epoch is published before its owner lock is held", () => {
  for (const result of ["refused", "aborted"] as const)
    for (const gateMode of ["before-native", "native-held"] as const)
      for (const evaluator of ["peer", "own"] as const)
        test(`R39 owner publication [${result}/${gateMode}/${evaluator}]: an evaluator looking in the interval leaves the live attempt to activate`, async ({
          context,
          provokes,
        }, testInfo) => {
          provokes(result === "refused" ? 503 : "abort");
          const stub = await newStub(context);
          let activations = 0;
          stub.answerNext(
            (r) => isActivate(r) && ++activations === 2,
            result === "aborted"
              ? "abort"
              : {
                  status: 503,
                  body: {
                    code: "device_capacity",
                    message: "capacity",
                    request_id: "req-capacity",
                    details: [],
                  },
                },
          );
          const [a, b] = await twoTabs(context);
          await installOwnerGate(a, "A", gateMode);
          await installOwnerGate(b, "B", gateMode);
          const looker = evaluator === "peer" ? b : a;
          try {
            await delayDigest(a);
            expect(await offerSignIn(a, "kieran", "pw")).toBe("submitted");
            expect(await offerSignIn(b, "sam", "pw2")).toBe("submitted");
            await expect
              .poll(async () => (await workOf(b)).dom, { timeout: 20_000 })
              .toBe("displaying");
            await releaseDigest(a);
            await expect
              .poll(async () => (await ownerGate(a)).entered, {
                message: "tab 1's owner-lock request reached the gate",
              })
              .toBe(true);
            // Tab 1 holds atlas-auth across the whole interval; a real focus starts the looking tab's ordinary evaluator. Only probes
            // made after the gate was reached count, and any single `ifAvailable` answer can be "held" because another evaluator (tab 1's
            // own, say) is probing at that instant (revision-36 qualification attempt 1, WebKit): so before admission the proof is that
            // some focused look found the name free (focus again until one does), and once natively granted that every look found it held.
            expect((await workOf(a)).held).toContain("atlas-auth");
            const before = (await ownerGate(looker)).probes.length;
            const focus = () =>
              looker.evaluate(() => window.dispatchEvent(new Event("focus")));
            const looks = async () =>
              (await ownerGate(looker)).probes.slice(before);
            if (gateMode === "before-native")
              await expect
                .poll(
                  async () => {
                    await focus();
                    return (await looks()).some(Boolean);
                  },
                  {
                    message:
                      "a focused look found the owner lock free before admission",
                  },
                )
                .toBe(true);
            else {
              await focus();
              await expect
                .poll(async () => (await looks()).length, {
                  message: "the evaluator probed the second epoch's owner lock",
                })
                .toBeGreaterThan(0);
              expect(
                await looks(),
                "every look found the natively granted owner lock held",
              ).not.toContain(true);
            }
            if (gateMode === "before-native")
              // A free lock seen outside atlas-auth is not acted on: the decision waits for atlas-auth, which tab 1 still holds.
              await expect
                .poll(async () => (await workOf(looker)).pending)
                .toContain("atlas-auth");
            await a.evaluate(() =>
              (window as unknown as OwnerGateWindow).__ownerGate.release(),
            );
            const boundary = await settleAuth(stub, [a, b]);
            expect(
              stub.deliveries
                .filter((d) => d.path === ACTIVATE)
                .map((d) => [d.state, d.status ?? null]),
              "the second sign-in's activation is issued",
            ).toEqual([
              ["fulfilled", 200],
              result === "refused" ? ["fulfilled", 503] : ["aborted", null],
            ]);
            expect(lastArrivedActivationAccount(stub)).toBe("kieran");
            await expectFinalIdentity(stub, [a, b], boundary, {
              otherwise: ["different_account", "neutral"],
            });
            expect(
              stub.usernameOf(
                stub.deliveredActivations().at(-1)?.account ?? "",
              ),
            ).toBe("sam");
          } finally {
            const metadata = await Promise.all(
              [a, b].map((page) =>
                page
                  .evaluate(
                    () =>
                      (window as unknown as Partial<OwnerGateWindow>)
                        .__ownerGate?.log ?? null,
                  )
                  .catch(() => null),
              ),
            );
            await testInfo.attach("owner-publication-metadata", {
              body: JSON.stringify(
                { result, gateMode, evaluator, metadata },
                null,
                2,
              ),
              contentType: "application/json",
            });
          }
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
   *
   * Revision 35 (R38, C4): tab `a`'s reloaded document verifies only because the caller made that verification eligible first
   * (`prepareEligibleVerification`, before its own decisive window: a fresh shared confirmation spares the reload's read). Here the
   * new document, the same settlement and exactly ONE held verification of `a` are proven before `b`'s hold and the close.
   */
  async function closeByPeerVerification(
    stub: AuthStub,
    a: Page,
    b: Page,
    prepared: EligibleVerification,
  ) {
    const current =
      (page: Page) =>
      (r: { method: string; path: string; page: Page | null }) =>
        r.method === "GET" &&
        r.path === "/browser-sessions/current" &&
        r.page === page;
    const heldA = stub.hold(current(a));
    await a.reload();
    await expectNewDocument(stub, a, prepared);
    await expect
      .poll(
        () =>
          stub.deliveries.some((d) => d.hold === heldA && d.state === "held"),
        {
          message:
            "setup (R38): the reloaded document's eligible verification is asked and held",
          timeout: 20_000,
        },
      )
      .toBe(true);
    expect(
      identityReads(stub, a)
        .slice(prepared.reads)
        .map((d) => d.state),
      "exactly one verification of the new document, still held",
    ).toEqual(["held"]);
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
    const prepared = await prepareEligibleVerification(stub, a);
    const held = await closeByPeerVerification(stub, a, b, prepared);
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
    // Revision 35 (R38): prepared before the press, so nothing between the mouse-down and the closure is setup.
    const prepared = await prepareEligibleVerification(stub, a);
    const link = b
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first();
    const box = await link.boundingBox();
    if (!box) throw new Error("no Settings link to press");
    const writes = (await navOf(b)).writes.length;
    await b.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await b.mouse.down();
    const held = await closeByPeerVerification(stub, a, b, prepared);
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
  /** Arms the NEXT document of this tab: the init script reads (and removes) it from sessionStorage before any application script. */
  const armNextDocument = (page: Page, value: Arm) =>
    page.evaluate((a) => {
      sessionStorage.setItem("r23-arm", JSON.stringify(a));
    }, value);
  /** The arm the CURRENT document's hook took from sessionStorage (the hook was installed and armed before the application ran). */
  const armedPath = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __r23: { arm: Arm | null } }).__r23.arm?.path ??
        null,
    );
  /**
   * Revision 35 (R38, C3): the identity decode B1/B4/B5 hold is the eligible verification of `page`'s next document (the settlement's
   * fresh confirmation spares every read before it). After the caller's authentication work has finished: prepare it, arm that
   * document's hook, reload, and prove a new document with the same settlement and an armed hook.
   */
  async function reloadForHeldIdentityDecode(
    stub: AuthStub,
    page: Page,
    value: Arm,
  ) {
    const prepared = await prepareEligibleVerification(stub, page);
    await armNextDocument(page, value);
    await page.reload();
    await expectNewDocument(stub, page, prepared);
    expect(
      await armedPath(page),
      "setup: the new document's hook is armed",
    ).toBe(value.path);
    await expect
      .poll(() => identityReads(stub, page).length - prepared.reads, {
        message:
          "setup (R38): the new document made its identity read (none: the premise of the held decode is absent)",
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(1);
    return prepared;
  }
  /** After `entered`: the decode is the new document's ONE identity read. */
  const expectOneVerification = (
    stub: AuthStub,
    page: Page,
    prepared: EligibleVerification,
  ) =>
    expect(
      identityReads(stub, page).length - prepared.reads,
      "the new document made exactly one identity read: the one whose decode is held",
    ).toBe(1);
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
      await signInForm(page, "kieran", "pw");
      await settleAuth(stub, pagesOf(page));
      // Revision 35 (R38): the settlement made no identity read (its fresh shared confirmation); the held decode is that of the read
      // a new document makes once the confirmation is older than the interval.
      expect(
        identityReads(stub),
        "the settlement made no identity read",
      ).toEqual([]);
      const prepared = await reloadForHeldIdentityDecode(stub, page, {
        method: "json",
        path: "/browser-sessions/current",
        hold: true,
        substitute: consequential ? sam?.id : undefined,
      });
      await entered(page);
      expectOneVerification(stub, page, prepared);
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
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, pagesOf(page));
    expect(identityReads(stub), "the settlement made no identity read").toEqual(
      [],
    );
    const prepared = await reloadForHeldIdentityDecode(stub, page, {
      method: "json",
      path: "/browser-sessions/current",
      hold: false,
    });
    await entered(page);
    expectOneVerification(stub, page, prepared);
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
    await signInForm(b, "sam", "pw2");
    await settleAuth(stub, [a, b]);
    // Revision 35 (R38): neither tab made an identity read after the settlement (HF-1). Only tab A's next document is made eligible.
    expect(identityReads(stub), "the settlement made no identity read").toEqual(
      [],
    );
    const peerReads = identityReads(stub, b).length;
    const prepared = await reloadForHeldIdentityDecode(stub, a, {
      method: "json",
      path: "/browser-sessions/current",
      hold: true,
    });
    await entered(a);
    expectOneVerification(stub, a, prepared);
    // A's answer SURRENDERED its lease before the held decode, so B, watching that lock, may verify the lease and close and reopen
    // its display meanwhile. Whatever B did, it is back on display with its own work finished, and A's decode is still held.
    await expect
      .poll(
        async () => ({
          dom: (await workOf(b)).dom,
          peerReadsPending: identityReads(stub, b)
            .slice(peerReads)
            .filter(
              (d) => !["fulfilled", "aborted", "failed"].includes(d.state),
            ).length,
        }),
        { timeout: 20_000 },
      )
      .toEqual({ dom: "displaying", peerReadsPending: 0 });
    const peerVerifications = identityReads(stub, b).slice(peerReads);
    expect(
      peerVerifications.map((d) => [d.state, d.status]),
      "B's verifications of A's surrendered lease (if any) were answered cleanly",
    ).toEqual(peerVerifications.map(() => ["fulfilled", 200]));
    const boundary = settleAuth(stub, [a, b]);
    expect(
      await within(boundary),
      "the other tab's undecoded identity answer is unfinished work",
    ).toBe("still-waiting");
    const look = await lookAt(stub, [a, b]);
    expect(
      look.reasons[0],
      "A's held decode alone keeps the boundary open",
    ).toContain("reading response bodies: json /browser-sessions/current");
    expect(
      look.shared.some((r) => /unretired request leases: verification/.test(r)),
      peerVerifications.length > 0
        ? "B resolved A's surrendered lease: it is no longer in the record"
        : "B did not verify: A's surrendered lease is still in the record",
    ).toBe(peerVerifications.length === 0);
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
    // Revision 35 (R38): no identity read after the settlement (HF-1); tab A's reloaded document verifies because it is made eligible.
    expect(identityReads(stub), "the settlement made no identity read").toEqual(
      [],
    );
    const verifications = () => identityReads(stub, b).length;
    const before = verifications();
    // B's resolving read is held from BEFORE A's verification exists: A's answer surrenders its lease before the held decode, and B,
    // watching that lock, would otherwise resolve it at once and finish the schedule unseen.
    const heldB = stub.hold(
      (r) =>
        r.method === "GET" &&
        r.path === "/browser-sessions/current" &&
        r.page === b,
    );
    const prepared = await reloadForHeldIdentityDecode(stub, a, {
      method: "json",
      path: "/browser-sessions/current",
      hold: true,
    });
    await entered(a);
    expectOneVerification(stub, a, prepared);
    const ofA = identityReads(stub, a).at(-1);
    // B's attributed unresolved work: its verification of A's surrendered lease, asked after A's and held.
    await expect
      .poll(
        () =>
          identityReads(stub, b)
            .slice(before)
            .map((d) => ({ held: d.hold === heldB, state: d.state })),
        {
          message:
            "B's verification of A's surrendered lease is asked and held",
          timeout: 20_000,
        },
      )
      .toEqual([{ held: true, state: "held" }]);
    expect(
      (identityReads(stub, b).at(-1)?.n ?? 0) > (ofA?.n ?? Infinity),
      "B's verification arrived after A's",
    ).toBe(true);
    expect(
      await within(settleAuth(stub, [a, b])),
      "the reloaded tab's undecoded identity answer is unfinished work",
    ).toBe("still-waiting");
    // B's held read keeps that boundary open too, so A's own decode is attributed directly.
    expect(
      (await lookAt(stub, [a, b])).reasons[0],
      "the reloaded tab's held decode is its own unfinished work",
    ).toContain("reading response bodies: json /browser-sessions/current");
    // The document goes with its pending decode: what it leaves is the record, which the other tab resolves.
    await a.close();
    const boundary = settleAuth(stub, [b]);
    expect(
      await within(boundary),
      "the closed tab's lease, being resolved by B's held read, is unfinished work",
    ).toBe("still-waiting");
    expect(
      (await lookAt(stub, [b])).shared.join("; "),
      "the closed tab's surrendered lease is still in the record",
    ).toMatch(/unretired request leases: verification/);
    heldB.release();
    const settled = await boundary;
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

/**
 * WEB-14a revision 35 (review R38, design assessment Q1/Q2 in a real engine): the premise the corrected schedules rest on, as one
 * control pair on the same page. A reload within the interval makes NO identity read (the settlement's fresh shared confirmation: the
 * accepted HF1-SHARED-CONFIRMATION-20261013 behaviour, so this half fails if the freshness guard is removed), and its token is adopted
 * (the new document's stamped readers need no identity read for it). Once only the confirmation's time is aged, the same reload's new
 * document makes exactly one identity read, its resume verification, and the account is shown.
 */
test.describe("revision 35, R38: a reload's verification and the shared confirmation's age", () => {
  test("R38 [reload controls]: a reload within the interval makes no identity read; once only the confirmation's time is aged, the reloaded document makes exactly one, and the account is shown", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await page.goto("/");
    await signInForm(page, "kieran", "pw");
    await settleAuth(stub, pagesOf(page));
    expect(identityReads(stub), "the settlement made no identity read").toEqual(
      [],
    );
    // Fresh: a new document of the same settlement neither verifies nor reads an identity for its token.
    const fresh = (await workOf(page)).doc;
    await page.reload();
    await expect
      .poll(async () => (await workOf(page)).doc !== fresh, { timeout: 20_000 })
      .toBe(true);
    const freshBoundary = await settleAuth(stub, pagesOf(page));
    expect(freshBoundary.pages[0]?.dom).toBe("displaying");
    expect(
      identityReads(stub),
      "a reload within the interval makes no identity read",
    ).toEqual([]);
    // Aged: the same reload's document verifies once.
    const prepared = await prepareEligibleVerification(stub, page);
    expect(prepared.receipt).toMatchObject({
      aged: true,
      settlement_matched: true,
      confirmation_matched: true,
      other_fields_unchanged: true,
    });
    await page.reload();
    await expectNewDocument(stub, page, prepared);
    const agedBoundary = await settleAuth(stub, pagesOf(page));
    expect(agedBoundary.pages[0]?.dom).toBe("displaying");
    expect(
      identityReads(stub).map((d) => [d.page === page, d.state, d.status]),
      "the aged reload's document made exactly one identity read, answered cleanly",
    ).toEqual([[true, "fulfilled", 200]]);
    expect(
      stub.requests
        .filter((r) => r.csrf !== null)
        .every((r) => r.csrf === `csrf.${stub.cookie}`),
      "every stamped request carried the settled session's own token",
    ).toBe(true);
    await shownAs(stub, page, "kieran");
  });
});

test.describe("R5 / HF-1: a Settings click delivered while the protected tree is closed for a check (WEB-08c's open regression)", () => {
  /**
   * WEB08D-NAVIGATION-FRESHNESS-20261011. The forced order: tab A has a held device read (a REQUEST lease in the shared record)
   * when it is closed, so tab B finds the lease orphaned, closes its protected tree (`1e.interrupted_online`) and verifies the
   * session (`GET /browser-sessions/current`); that answer is held, so B stays closed for as long as the test holds it, well under
   * the 5 s stall limits. A REAL pointer click on where B's Settings link was is delivered in that interval. These cases record the
   * original one-click outcome separately from the adapted helper; they do not claim the precise cause of the r3 failure.
   */
  const settingsLink = (page: Page) =>
    page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first();
  const treeState = (page: Page) =>
    page.evaluate(() => {
      const root = document.getElementById("protected-root");
      return {
        neutral:
          document
            .querySelector("[data-neutral-state]")
            ?.getAttribute("data-neutral-state") ?? null,
        open:
          root !== null &&
          !root.hasAttribute("inert") &&
          document.querySelector('nav a[href="/settings"]') !== null,
      };
    });
  const isCheck = (r: { method: string; path: string }) =>
    r.method === "GET" && r.path === "/browser-sessions/current";

  /** Tab B displays "sam" (tab A signed in first), visibility pinned as in the ordering traces. */
  async function displayedInTwoTabs(context: BrowserContext) {
    const stub = await newStub(context);
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
    await a.goto("/");
    await signInForm(a, "sam", "pw2");
    await expect(settingsLink(a)).toBeVisible({ timeout: 20_000 });
    const b = await context.newPage();
    await b.goto("/");
    await expect
      .poll(async () => (await treeState(b)).open, { timeout: 20_000 })
      .toBe(true);
    return { stub, a, b };
  }

  /**
   * READ-ONLY barrier probe from tab B (WEB-10a revision 5, R15; design assessment C4): the Web Locks state (`navigator.locks.query()`,
   * allowed in a spec, never in `src`) with each lease lock marked as B's own or another page's, and the REQUEST leases of the durable
   * `atlas-auth` record (a read-only transaction; nothing is written). It is how the forced order below is ESTABLISHED, not assumed.
   */
  const sessionProbe = (page: Page) =>
    page.evaluate(async () => {
      const mine = `r15-probe-${Math.random()}`;
      let me: string | undefined;
      const view = await navigator.locks.request(mine, async () => {
        const q = await navigator.locks.query();
        me = q.held?.find((l) => l.name === mine)?.clientId;
        return q;
      });
      const leases = await new Promise<Record<string, string> | null>(
        (resolve) => {
          const open = indexedDB.open("atlas-auth", 1);
          open.onerror = () => resolve(null);
          open.onsuccess = () => {
            const db = open.result;
            try {
              const get = db
                .transaction("records", "readonly")
                .objectStore("records")
                .get("auth_state");
              get.onsuccess = () => {
                const all =
                  (get.result as { leases?: Record<string, { class: string }> })
                    ?.leases ?? {};
                resolve(
                  Object.fromEntries(
                    Object.entries(all).map(([id, l]) => [id, l.class]),
                  ),
                );
                db.close();
              };
              get.onerror = () => {
                resolve(null);
                db.close();
              };
            } catch {
              resolve(null);
              db.close();
            }
          };
        },
      );
      const lease = (list: LockInfo[] | undefined) =>
        (list ?? [])
          .filter((l) => l.name?.startsWith("atlas-lease-"))
          .map((l) => ({
            id: (l.name as string).slice("atlas-lease-".length),
            mine: l.clientId === me,
          }));
      return { held: lease(view.held), pending: lease(view.pending), leases };
    });

  /** Holds tab A's OWN `GET /sessions` (a route on page A only; the stub answers it when released, unless A is gone). */
  async function holdOwnRead(a: Page) {
    let arrived = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await a.route(
      (url) => url.pathname === "/api/experimental/v1/sessions",
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        arrived = true;
        await gate;
        await route.fallback().catch(() => undefined);
      },
    );
    return { arrived: () => arrived, release };
  }

  /**
   * Barrier: a REQUEST lease in the record whose lock another page (A) holds and tab B WAITS for (B watches it), seen in two consecutive
   * looks (so a short-lived lease, such as the leader's `/sync` in A, is not taken for the held read).
   */
  async function watchedLease(b: Page): Promise<string> {
    let before = new Set<string>();
    let lease: string | null = null;
    await expect
      .poll(
        async () => {
          const p = await sessionProbe(b);
          const now = new Set(
            p.held
              .filter(
                (h) =>
                  !h.mine &&
                  p.leases?.[h.id] !== undefined &&
                  p.leases?.[h.id] !== "exposure" &&
                  p.pending.some((w) => w.mine && w.id === h.id),
              )
              .map((h) => h.id),
          );
          lease = [...now].find((id) => before.has(id)) ?? null;
          before = now;
          return lease !== null;
        },
        {
          timeout: 10_000,
          message:
            "A's held read has a REQUEST lease held by A and waited for by B",
        },
      )
      .toBe(true);
    return lease as unknown as string;
  }

  /**
   * Closes tab A with ITS OWN device read held; returns once tab B is closed for its held check. The order is established by barriers,
   * each within the original 10 s bound (WEB-10a revision 5, R15): (1) A's `GET /sessions` is held by a route on page A only — a
   * context-wide hold of "the first `/sessions`" also caught tab B's own device read in 2 of 10 WebKit executions (diagnosed with the
   * probe above), and then A retired its lease cleanly and B rightly verified nothing; (2) that read's REQUEST lease is in the record, its
   * lock held by another page and WAITED FOR by B (B watches it); (3) after A's destruction the lease record remains while its lock is
   * released (orphaned, not cleanly retired); (4) B's check is held and B is closed behind `1e.interrupted_online`. The check hold and
   * its count begin only after (2): B's second boot check can come ~50 ms after it displays, and a hold set before it caught that one.
   */
  async function closeForHeldCheck(stub: AuthStub, a: Page, b: Page) {
    const read = await holdOwnRead(a);
    await settingsLink(a).click();
    await expect.poll(() => read.arrived(), { timeout: 10_000 }).toBe(true);
    const lease = await watchedLease(b);
    // Only now: B's own boot checks are over, so the one check held (and counted) is the verification A's closure causes.
    const checksBefore = stub.count("GET", "/browser-sessions/current");
    const holdCheck = stub.hold(isCheck, 1);
    await a.close();
    read.release();
    await expect
      .poll(
        async () => {
          const p = await sessionProbe(b);
          return (
            p.leases?.[lease] !== undefined &&
            !p.held.some((h) => h.id === lease && !h.mine)
          );
        },
        {
          timeout: 10_000,
          message:
            "A's destruction released the lease's lock and left its record (orphaned, not cleanly retired)",
        },
      )
      .toBe(true);
    await expect
      .poll(() => stub.count("GET", "/browser-sessions/current"), {
        timeout: 10_000,
      })
      .toBeGreaterThan(checksBefore);
    expect(await treeState(b)).toEqual({
      neutral: "1e.interrupted_online",
      open: false,
    });
    test.info().annotations.push({
      type: "r15-forced-order",
      description: `lease ${lease} held by A, watched by B, orphaned at A's close; B's check held`,
    });
    return holdCheck;
  }

  test("control: on a settled display, one click opens Settings and the adapted helper uses exactly one", async ({
    context,
  }) => {
    const { b } = await displayedInTwoTabs(context);
    expect(await shownAsWithRetry(b, "sam")).toBe(1);
    await expect(b).toHaveURL(/\/settings$/);
  });

  test("original (UNADAPTED, expected to change when WEB-08c corrects it): one real click inside the held check completes, nothing navigates and the tab stays on Today", async ({
    context,
  }) => {
    const { stub, a, b } = await displayedInTwoTabs(context);
    const box = await settingsLink(b).boundingBox();
    expect(box).not.toBeNull();
    const holdCheck = await closeForHeldCheck(stub, a, b);
    if (box) await b.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    holdCheck.release();
    await expect
      .poll(async () => (await treeState(b)).open, { timeout: 20_000 })
      .toBe(true);
    // The observed one-click outcome (WEB-08c HF-1 / R5): the click was delivered and is gone; no Settings, no account card.
    await expect(b).toHaveURL(/\/today$/);
    await expect(b.locator("[data-account-card]")).toHaveCount(0);
    test.info().annotations.push({
      type: "hf1-original-one-click",
      description: "not acted on (stayed on /today)",
    });
  });

  test("adapted helper after the same lost click: no card is drawn, so it opens Settings and reads the identity within the original deadline", async ({
    context,
  }) => {
    const { stub, a, b } = await displayedInTwoTabs(context);
    const box = await settingsLink(b).boundingBox();
    expect(box).not.toBeNull();
    const holdCheck = await closeForHeldCheck(stub, a, b);
    if (box) await b.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    holdCheck.release();
    expect(await shownAsWithRetry(b, "sam")).toBeLessThanOrEqual(
      SETTINGS_CLICKS,
    );
    await expect(b).toHaveURL(/\/settings$/);
  });

  test("adapted helper whose OWN first click is not acted on: it clicks once more only because no card is drawn (the original one-click helper fails here)", async ({
    context,
  }) => {
    const { b } = await displayedInTwoTabs(context);
    // HARNESS STAND-IN, not a product mechanism: Playwright's click cannot be timed into the few milliseconds of a real check from
    // outside the page, so the first click on the Settings link is swallowed before the application sees it. The case above shows a
    // real check losing a real click; this one shows what the adapted helper does with a click that had no effect.
    await b.evaluate(() => {
      const w = window as unknown as { __swallowed: number };
      w.__swallowed = 0;
      window.addEventListener(
        "click",
        (event) => {
          const target = event.target as Element | null;
          if (w.__swallowed > 0 || !target?.closest('nav a[href="/settings"]'))
            return;
          w.__swallowed += 1;
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
    });
    expect(await shownAsWithRetry(b, "sam")).toBe(2);
    expect(
      await b.evaluate(
        () => (window as unknown as { __swallowed: number }).__swallowed,
      ),
    ).toBe(1);
    await expect(b).toHaveURL(/\/settings$/);
  });

  test("control (clean retirement, R15): A's held device read is ANSWERED while A stays open: B watched its lease, finds it retired and verifies nothing", async ({
    context,
  }) => {
    // A deterministic negative control of the barriers above. (Closing A after its read was answered is NOT one: A is the data leader,
    // and a `/sync` of A in flight at its closure is a genuinely orphaned lease that B rightly verifies — observed once in WebKit.)
    const { stub, a, b } = await displayedInTwoTabs(context);
    const read = await holdOwnRead(a);
    await settingsLink(a).click();
    await expect.poll(() => read.arrived(), { timeout: 10_000 }).toBe(true);
    const lease = await watchedLease(b);
    // From here on, every closure of B's protected tree is recorded, and every check counted (B's own boot checks are long over: the
    // first version of this control took its baseline right after B displayed and counted B's second boot check, observed once in WebKit).
    await b.evaluate(() => {
      const w = window as unknown as { __closures: string[] };
      w.__closures = [];
      const look = () => {
        const neutral = document
          .querySelector("[data-neutral-state]")
          ?.getAttribute("data-neutral-state");
        if (neutral) w.__closures.push(neutral);
        if (document.getElementById("protected-root")?.hasAttribute("inert"))
          w.__closures.push("inert");
      };
      new MutationObserver(look).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      look();
    });
    const checksAtWatch = stub.count("GET", "/browser-sessions/current");
    read.release();
    // Barrier: the lease was retired (its record gone) and B waits for it no more.
    await expect
      .poll(
        async () => {
          const p = await sessionProbe(b);
          return (
            p.leases !== null &&
            p.leases[lease] === undefined &&
            !p.pending.some((w) => w.id === lease)
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(a.locator("[data-account-card]")).toContainText("sam", {
      timeout: 20_000,
    });
    expect(stub.count("GET", "/browser-sessions/current")).toBe(checksAtWatch);
    expect(
      await b.evaluate(
        () => (window as unknown as { __closures: string[] }).__closures,
      ),
    ).toEqual([]);
    expect(await treeState(b)).toEqual({ neutral: null, open: true });
  });

  /** Counts the clicks that reach the Settings link (`swallow`: and keeps them from the application — a HARNESS stand-in). */
  const countSettingsClicks = (page: Page, swallow: boolean) =>
    page.evaluate((swallowing) => {
      const w = window as unknown as { __settingsClicks: number };
      w.__settingsClicks = 0;
      window.addEventListener(
        "click",
        (event) => {
          const target = event.target as Element | null;
          if (!target?.closest('nav a[href="/settings"]')) return;
          w.__settingsClicks += 1;
          if (!swallowing) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
    }, swallow);
  const settingsClicks = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __settingsClicks: number }).__settingsClicks,
    );

  test("adapted helper (qualification, R15): a card naming ANOTHER account fails within the original deadline, after one click only (no click while a card is drawn)", async ({
    context,
  }) => {
    const { b } = await displayedInTwoTabs(context);
    await countSettingsClicks(b, false);
    await expect(shownAsWithRetry(b, "kieran")).rejects.toThrow();
    expect(await settingsClicks(b)).toBe(1);
    await expect(b.locator("[data-account-card]")).toContainText("sam");
  });

  test("adapted helper (qualification, R15): clicks that never take effect: at most three, then it fails within the original deadline", async ({
    context,
  }) => {
    const { b } = await displayedInTwoTabs(context);
    // HARNESS STAND-IN, as above: every click on the Settings link is kept from the application.
    await countSettingsClicks(b, true);
    await expect(shownAsWithRetry(b, "sam")).rejects.toThrow();
    // D3's bound, written out: the helper may never click more than three times.
    expect(await settingsClicks(b)).toBe(3);
    await expect(b).toHaveURL(/\/today$/);
  });
});

test.describe("INT-N1 qualification: public entry waits for the surface's own initial focus", () => {
  /**
   * The intervention of the review's forced-order probe (review-integration-fresh-20261024/probe-source/focus.spec.ts), kept in
   * the maintained file: the FIRST heading focus that `PublicCard` asks for is held (the application's own call, nothing else is
   * focused for it) until the test releases it; every focus and input event is recorded in page order. Nothing clears a value.
   * `armed` releases the held focus in a microtask queued by the username field's `focusin`: Playwright's `fill` focuses the field
   * (twice) in one evaluation and inserts the text in a later protocol command, so the microtask lands the heading's focus after the
   * field's last focus and before the insertion, the order that lost the review's input. (The review's probe used `setTimeout(0)`,
   * which reached that order in WebKit but not in Chromium; a synchronous release is undone by `fill`'s second focus.)
   */
  type EntryEvent = { type: string; tag: string; name: string; value: string };
  type EntryWatch = {
    __entry: {
      events: EntryEvent[];
      held: boolean;
      armed: boolean;
      release: (() => void) | null;
    };
  };
  async function watchEntry(page: Page, hold: boolean) {
    await page.addInitScript((hold) => {
      const w = window as unknown as EntryWatch;
      w.__entry = { events: [], held: false, armed: false, release: null };
      const record = (type: string, el: Element) =>
        w.__entry.events.push({
          type,
          tag: el.tagName,
          name: (el as HTMLInputElement).name ?? "",
          value: (el as HTMLInputElement).value ?? "",
        });
      if (hold) {
        const native = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (
          this: HTMLElement,
          ...args: Parameters<HTMLElement["focus"]>
        ) {
          if (
            !w.__entry.held &&
            this.tagName === "H1" &&
            this.closest("main[data-public-surface]") !== null
          ) {
            w.__entry.held = true;
            record("heading-focus-held", this);
            w.__entry.release = () => {
              w.__entry.release = null;
              native.apply(this, args);
            };
            return;
          }
          return native.apply(this, args);
        };
      }
      for (const kind of ["focusin", "input"])
        document.addEventListener(
          kind,
          (event) => {
            const el = event.target as Element;
            record(kind, el);
            if (
              kind === "focusin" &&
              w.__entry.armed &&
              (el as HTMLInputElement).name === "username"
            ) {
              w.__entry.armed = false;
              queueMicrotask(() => w.__entry.release?.());
            }
          },
          true,
        );
    }, hold);
  }
  const entryEvents = (page: Page) =>
    page.evaluate(() => (window as unknown as EntryWatch).__entry.events);
  const headingHeld = (page: Page) =>
    page.waitForFunction(
      () => (window as unknown as EntryWatch).__entry.release !== null,
    );
  const release = (page: Page) =>
    page.evaluate(() => (window as unknown as EntryWatch).__entry.release?.());
  const firstIndex = (events: EntryEvent[], type: string, tagOrName: string) =>
    events.findIndex(
      (e) => e.type === type && (e.tag === tagOrName || e.name === tagOrName),
    );
  const settingsLinkOf = (page: Page) =>
    page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first();
  /** How long the adverse schedule keeps the heading's focus pending while the corrected entry is already running. */
  const PENDING_MS = 1_000;

  test("INT-N1 adverse control (diagnostic, expected outcome): with the heading's initial focus landing between the former fill's focus and its insertion, Firefox and WebKit lose the username; Chromium inserts at the field's selection", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    const engine = page.context().browser()?.browserType().name();
    await watchEntry(page, true);
    await page.goto("/");
    await headingHeld(page);
    await page.evaluate(() => {
      (window as unknown as EntryWatch).__entry.armed = true;
    });
    // The FORMER `signInForm`, kept here only as this labelled control: fill, fill, submit, with no entry boundary.
    await page.getByLabel("Username").fill("sam");
    await page.getByLabel("Password").fill("pw2");
    await page.getByRole("button", { name: "Sign in" }).click();
    const events = await entryEvents(page);
    await test.info().attach("entry-events", {
      body: JSON.stringify(events, null, 1),
      contentType: "application/json",
    });
    // The intervention took effect in every engine: the username was focused, THEN the heading's held focus landed, and no
    // username input came before it.
    const userFocus = firstIndex(events, "focusin", "username");
    const headingFocus = firstIndex(events, "focusin", "H1");
    const userInput = firstIndex(events, "input", "username");
    expect(userFocus).toBeGreaterThanOrEqual(0);
    expect(headingFocus).toBeGreaterThan(userFocus);
    if (engine === "chromium") {
      // Chromium's insertion follows the selection `fill` left in the field, not the focused heading, so the text still lands
      // there (revision-31 diagnostic d5); the review's lost input is a Firefox/WebKit outcome of the same order.
      expect(userInput).toBeGreaterThan(headingFocus);
      await expect(settingsLinkOf(page)).toBeVisible({ timeout: 20_000 });
      expect(stub.count("POST", API_EXCHANGE)).toBe(1);
    } else {
      // The review's symptom: no username input at all, the local refusal, and nothing sent.
      expect(userInput).toBe(-1);
      await expect(
        page.getByText("Enter your username.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Username")).toHaveValue("");
      expect(stub.count("POST", API_EXCHANGE)).toBe(0);
    }
  });

  test("INT-N1 corrected sign-in: started while the heading's initial focus is pending, entry types nothing until it lands, then signs in ONCE as the typed account", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await watchEntry(page, true);
    await page.goto("/");
    await headingHeld(page);
    const entry = signInForm(page, "sam", "pw2");
    // The adversary's window: the heading's focus stays pending while the entry runs. Nothing may be typed or sent in it.
    await page.waitForTimeout(PENDING_MS);
    const pending = await entryEvents(page);
    expect(pending.filter((e) => e.tag === "INPUT")).toEqual([]);
    expect(stub.count("POST", API_EXCHANGE)).toBe(0);
    await release(page);
    await entry;
    await expect(settingsLinkOf(page)).toBeVisible({ timeout: 20_000 });
    const events = await entryEvents(page);
    const headingFocus = firstIndex(events, "focusin", "H1");
    expect(headingFocus).toBeGreaterThanOrEqual(0);
    expect(firstIndex(events, "focusin", "username")).toBeGreaterThan(
      headingFocus,
    );
    const userInputs = events.filter(
      (e) => e.type === "input" && e.name === "username",
    );
    expect(userInputs.at(-1)?.value).toBe("sam");
    expect(
      events.filter((e) => e.type === "input" && e.name === "password").at(-1)
        ?.value,
    ).toBe("pw2");
    const exchanges = stub.recordsFor(API_EXCHANGE, "POST");
    expect(exchanges).toHaveLength(1);
    expect(
      (exchanges[0]?.body as { username?: string } | undefined)?.username,
    ).toBe("sam");
    await shownAs(stub, page, "sam");
  });

  test("INT-N1 corrected join: on a ready invitation whose heading focus is pending, entry waits for it and the registration is sent ONCE with the typed name", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    const token = stub.addInvitation();
    await watchEntry(page, true);
    await page.goto(`/join#t=${token}`);
    // The loading skeleton never asks for focus; the first held request is the READY heading's.
    await headingHeld(page);
    await expect(page.getByLabel("Username")).toBeVisible();
    const entry = enterCredentials(page, "newbie", PASSWORD);
    await page.waitForTimeout(PENDING_MS);
    expect((await entryEvents(page)).filter((e) => e.tag === "INPUT")).toEqual(
      [],
    );
    await release(page);
    await entry;
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe("/today");
    const registrations = stub.recordsFor("/browser-registration", "POST");
    expect(registrations).toHaveLength(1);
    expect(
      (registrations[0]?.body as { username?: string } | undefined)?.username,
    ).toBe("newbie");
    await shownAs(stub, page, "newbie");
  });

  test("INT-N1 bound: a heading focus that never lands fails entry within the expect deadline, and nothing is typed or sent", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await watchEntry(page, true);
    await page.goto("/");
    await headingHeld(page);
    await expect(signInForm(page, "sam", "pw2")).rejects.toThrow(/toBeFocused/);
    expect((await entryEvents(page)).filter((e) => e.tag === "INPUT")).toEqual(
      [],
    );
    expect(stub.count("POST", API_EXCHANGE)).toBe(0);
    await release(page);
  });

  test("INT-N1 healthy control: with the heading's focus left alone, it lands before the username's first focus and input, and one exchange signs in the typed account", async ({
    page,
    context,
  }) => {
    const stub = await newStub(context);
    await watchEntry(page, false);
    await page.goto("/");
    await signInForm(page, "sam", "pw2");
    await expect(settingsLinkOf(page)).toBeVisible({ timeout: 20_000 });
    const events = await entryEvents(page);
    const headingFocus = firstIndex(events, "focusin", "H1");
    expect(headingFocus).toBeGreaterThanOrEqual(0);
    expect(firstIndex(events, "focusin", "username")).toBeGreaterThan(
      headingFocus,
    );
    expect(firstIndex(events, "input", "username")).toBeGreaterThan(
      headingFocus,
    );
    const exchanges = stub.recordsFor(API_EXCHANGE, "POST");
    expect(exchanges).toHaveLength(1);
    expect(
      (exchanges[0]?.body as { username?: string } | undefined)?.username,
    ).toBe("sam");
    await shownAs(stub, page, "sam");
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  ACCOUNTS,
  expect,
  exposeSession,
  OIDC,
  ORIGIN,
  provider,
  proxy,
  raw,
  rawSignIn as rawSignInUnpaced,
  signIn as signInUnpaced,
  swapCookie,
  test,
  untilView,
  type Who,
} from "./helpers";
import { followNavigation } from "./web08b-support";

/**
 * WEB-08c, Layer 4: composed lifecycle journeys against the RELEASED backend (v0.27.0-rc.1, SHA-256 verified by the runner) on a disposable
 * SQLite database, behind the delaying proxy, in a real engine: the PRODUCTION boot composition on the session harness page (its protected
 * tree with WF-SWITCH-01/02, the account card, "Confirm it's you" and the neutral states), mostly with the PRODUCTION sync leader
 * (`?leader=production`). Anything the proxy injects is labelled PROXY-INJECTED. Each account's username is its marker (the rail's verified
 * label is the account-specific content a person sees; the feature screens are placeholders).
 *
 * It does NOT close the backend gates BE-Q19, BE-Q11-B7 or BE-CH2 (no completion record exists; this runs against the pinned release), and it
 * is not PostgreSQL, HTTPS, real Safari, a device or assistive-technology evidence. The module-level counterparts it builds on are cited, not
 * repeated: I-04 (T8), I-05 (credential_mismatch), I-06/I-07 (the logout and retirement ledgers), I-08 (password change), I-14 (switch and
 * return, rows 7/8), I-15 (hiding aborts a real activate), I-N4/I-N5 (T24), I-O5/I-W1/I-S1 (WEB-09a's queue, consent and late answers).
 */
const API = "/api/experimental/v1";

// The released backend allows 10 password attempts per account per minute: the same paced ledger as the other specs, keyed by stack.
const LEDGER = join(
  tmpdir(),
  `atlas-signin-ledger-${new URL(ORIGIN || "http://x").port}.json`,
);
async function budget(who: Who): Promise<void> {
  for (;;) {
    let all: Record<string, number[]> = {};
    try {
      all = JSON.parse(readFileSync(LEDGER, "utf8")) as Record<
        string,
        number[]
      >;
    } catch {
      all = {};
    }
    const now = Date.now();
    const recent = (all[who] ?? []).filter((t) => now - t < 60_000);
    if (recent.length < 8) {
      all[who] = [...recent, now];
      writeFileSync(LEDGER, JSON.stringify(all));
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 60_000 - (now - (recent[0] ?? now)) + 250),
    );
  }
}
const signIn = async (page: Page, who: Who) => {
  await budget(who);
  return signInUnpaced(page, who);
};
const rawSignIn = async (who: Who) => {
  await budget(who);
  return rawSignInUnpaced(who);
};

test.beforeEach(async ({ context }, info) => {
  void context;
  info.setTimeout(150_000);
});

/** The harness page with the PRODUCTION leader, booted, `window.__s` exposed. */
async function leaderPage(context: BrowserContext, route = "/today") {
  const page = await context.newPage();
  await page.goto(
    `/__session?route=${encodeURIComponent(route)}&leader=production`,
  );
  await exposeSession(page);
  return page;
}
const identity = (page: Page) =>
  page.evaluate(
    () =>
      window.__s.identity.get() as {
        account_id: string;
        epoch: number;
        session_id: string;
      } | null,
  );
async function signedIn(page: Page, who: Who) {
  expect((await signIn(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = await identity(page);
  if (!id) throw new Error("no identity after sign-in");
  return id;
}
const name = (who: Who) => ACCOUNTS[who].username;
const password = (who: Who) => ACCOUNTS[who].password;

/** The rail's control names the VERIFIED label of the displayed account; it is the account-specific content of the shell. */
async function railShows(page: Page, who: Who, timeout = 30_000) {
  await expect(
    page.locator("#protected-root:not([inert])").getByRole("button", {
      name: `${name(who)}, switch account`,
    }),
  ).toBeVisible({ timeout });
}
async function expectAbsent(page: Page, value: string) {
  const text = await page.evaluate(
    () => document.documentElement.textContent ?? "",
  );
  expect(text, "DOM text").not.toContain(value);
  expect(await page.title(), "title").not.toContain(value);
  expect(await page.locator("body").ariaSnapshot(), "a11y").not.toContain(
    value,
  );
}
async function openSwitchFromRail(page: Page, who: Who) {
  await page
    .getByRole("button", { name: `${name(who)}, switch account` })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Switch account" }),
  ).toBeVisible();
}
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
/** WF-SWITCH-02's form, for "another account" (the username typed). */
async function switchToNew(page: Page, who: Who) {
  await page
    .getByRole("dialog", { name: "Switch account" })
    .getByRole("option")
    .last()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Sign in to another account",
  });
  await budget(who);
  await dialog.getByLabel("Username").fill(name(who));
  await dialog.getByLabel("Password").fill(password(who));
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
}
const proxyLog = async (since = 0) => (await proxy.log()).slice(since);
const deliveredStatus = (entry: {
  events: Array<{ event: string; status?: number }>;
}) => entry.events.find((e) => e.event === "delivered")?.status;

test.describe("I-L1: WF-SWITCH A→B→A against the backend (rows 7/8, check (h), amendment 25 case (f))", () => {
  test("I-L1: the switch through the rail and Settings: A is not perceivable during 1c or under B; nothing carrying A's session is accepted while B is settled; A's retained row is named by A's own verified profile", async ({
    context,
  }) => {
    const page = await leaderPage(context);
    const a = await signedIn(page, "frank");
    await railShows(page, "frank");
    const since = (await proxy.log()).length;
    await openSwitchFromRail(page, "frank");
    const held = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions/activate`,
      action: "hold",
    });
    await switchToNew(page, "grace");
    await expect
      .poll(async () => (await proxy.held())[held.id] ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(
      page.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAbsent(page, name("frank"));
    await proxy.release(held.id);
    await proxy.removeRule(held.id);
    await railShows(page, "grace");
    await expectAbsent(page, name("frank"));
    const b = await identity(page);
    expect(b?.account_id).not.toBe(a.account_id);
    // grace's own verified read was made under grace's session (the outgoing account's QUEUE under the incoming identity is WEB-09a's
    // I-O5, cited and run in the same final integration run).
    const meReads = (await proxyLog(since)).filter(
      (e) => e.method === "GET" && e.path === `${API}/me`,
    );
    expect(meReads.length).toBeGreaterThanOrEqual(1);

    // Settings → "Switch account": frank is a RETAINED account, named by its own verified profile record.
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    const retained = page
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]');
    await expect(retained).toContainText(name("frank"));
    await expect(retained).toContainText("Used on this computer before");
    await retained.click();
    const dialog = page.getByRole("dialog", {
      name: `Sign in as ${name("frank")}`,
    });
    await expect(dialog.getByLabel("Username")).toHaveValue(name("frank"));
    await budget("frank");
    await dialog.getByLabel("Password").fill(password("frank"));
    await dialog
      .getByRole("button", { name: `Sign in as ${name("frank")}` })
      .click();
    await railShows(page, "frank");
    await expectAbsent(page, name("grace"));
    const back = await identity(page);
    expect(back?.account_id).toBe(a.account_id);
    expect(back?.epoch).toBeGreaterThan(b?.epoch ?? 0);
  });
});

test.describe("I-L2: T7/T20 against the real activate and activate/cancel", () => {
  for (const action of ["rewrite_status", "drop_after_forward"] as const)
    test(`I-L2 (${action}, PROXY-INJECTED): the switch's activation is lost after the backend committed it; the real cancel and current() resolve it exactly: A (its cookie unchanged) renders again with 'That sign-in didn't finish'; B is never adopted`, async ({
      context,
      provokes,
    }) => {
      provokes(502);
      const page = await leaderPage(context);
      const a = await signedIn(page, "heidi");
      await railShows(page, "heidi");
      const since = (await proxy.log()).length;
      await openSwitchFromRail(page, "heidi");
      const rule = await proxy.addRule({
        method: "POST",
        path: `${API}/browser-sessions/activate`,
        action,
        ...(action === "rewrite_status" ? { status: 502 } : {}),
      });
      await switchToNew(page, "ivan");
      await railShows(page, "heidi", 60_000);
      await proxy.removeRule(rule.id);
      await expect(
        page.locator('[data-notice="feedback-ended"]'),
      ).toContainText("That sign-in didn't finish");
      await expectAbsent(page, name("ivan"));
      const again = await identity(page);
      expect(again?.account_id).toBe(a.account_id);
      expect(again?.epoch).toBe(a.epoch);
      const log = await proxyLog(since);
      const cancel = log.filter(
        (e) =>
          e.method === "POST" &&
          e.path === `${API}/browser-sessions/activate/cancel`,
      );
      expect(cancel.length).toBeGreaterThanOrEqual(1);
      expect(cancel.every((e) => deliveredStatus(e) === 200)).toBe(true);
    });
});

test.describe("I-L3: T8, the lock holder destroyed mid-activation", () => {
  test("I-L3: the page that activates is closed while the backend's answer is held; another page resolves the owner-less attempt and shows A; the held answer changes nothing", async ({
    context,
  }) => {
    const one = await leaderPage(context);
    const a = await signedIn(one, "judy");
    const two = await leaderPage(context);
    await untilView(two, "displaying");
    const before = (await context.cookies()).map((c) => c.value).sort();
    const held = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions/activate`,
      action: "hold",
    });
    await railShows(one, "judy");
    await openSwitchFromRail(one, "judy");
    await switchToNew(one, "kate");
    await expect
      .poll(async () => (await proxy.held())[held.id] ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await one.close();
    await two.evaluate(() => window.__s.actions.retry());
    await untilView(two, "displaying", undefined, 60_000);
    expect((await identity(two))?.account_id).toBe(a.account_id);
    await proxy.release(held.id);
    await proxy.removeRule(held.id);
    await two.waitForTimeout(1_000);
    expect((await identity(two))?.account_id).toBe(a.account_id);
    expect((await context.cookies()).map((c) => c.value).sort()).toEqual(
      before,
    );
  });
});

test.describe("I-L4: T12, an interrupted switch", () => {
  test("I-L4 (PROXY-INJECTED drop of the exchange's answer): the attempt fails, A stays settled and rendered, nothing changed; the next try switches", async ({
    context,
  }) => {
    const page = await leaderPage(context);
    const a = await signedIn(page, "liam");
    await railShows(page, "liam");
    const cookies = (await context.cookies()).map((c) => c.value).sort();
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions`,
      action: "drop_after_forward",
    });
    await openSwitchFromRail(page, "liam");
    await switchToNew(page, "mia");
    await expect(
      page.getByRole("dialog", { name: "Sign in to another account" }),
    ).toContainText("We couldn't reach Atlas", { timeout: 30_000 });
    await proxy.removeRule(rule.id);
    expect((await identity(page))?.account_id).toBe(a.account_id);
    expect((await context.cookies()).map((c) => c.value).sort()).toEqual(
      cookies,
    );
    // (mia's username is still in the form the person typed it into; nothing of mia's ACCOUNT is shown: the dialog still offers to stay
    // as liam, the account that is settled.)
    await expect(
      page.getByRole("button", { name: `Cancel — stay as ${name("liam")}` }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", {
      name: "Sign in to another account",
    });
    await budget("mia");
    await dialog.getByLabel("Password").fill(password("mia"));
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await railShows(page, "mia");
  });
});

test.describe("I-L5: T13/T24 composed with switching", () => {
  test("I-L5: A is invalidated (a real 401: its session revoked elsewhere) → 1b; the person signs in as B instead; back to A from Settings: A's fence stands, 'Catching up', the production recovery job catches up with recovery-class reads, then A", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    await signedIn(page, "nora");
    await railShows(page, "nora");
    // Revoke nora's browser session from another client: the backend's own 401 at nora's next request.
    const other = await rawSignIn("nora");
    const sessions = await raw("GET", "/sessions", {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    const list = (
      sessions.json as { sessions: Array<{ id: string; current: boolean }> }
    ).sessions;
    for (const row of list.filter((s) => !s.current))
      await raw("DELETE", `/sessions/${row.id}`, {
        cookie: other.cookie,
        headers: { "x-csrf-token": other.csrf },
      });
    // A TRIGGER only: the page's own sync leader may meet the 401 first, and the navigation is then gone (Firefox, campaign
    // 2026-10-11T13-30-08.975Z-c180297a; the same race as I-L7 and I-L10).
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await untilView(page, "neutral", "1b", 60_000);
    await expectAbsent(page, name("nora"));
    await page.getByRole("button", { name: "Reconnect" }).click();
    await budget("olga");
    await page.getByLabel("Username").fill(name("olga"));
    await page.getByLabel("Password").fill(password("olga"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await railShows(page, "olga");
    const since = (await proxy.log()).length;
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]')
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Sign in as ${name("nora")}`,
    });
    await budget("nora");
    await dialog.getByLabel("Password").fill(password("nora"));
    await dialog
      .getByRole("button", { name: `Sign in as ${name("nora")}` })
      .click();
    await railShows(page, "nora", 60_000);
    const syncs = (await proxyLog(since)).filter(
      (e) => e.method === "GET" && e.path.startsWith(`${API}/sync`),
    );
    expect(syncs.length).toBeGreaterThanOrEqual(1);
    await expectAbsent(page, name("olga"));
  });
});

test.describe("I-L6: T17 across two pages", () => {
  test("I-L6: a password change on page one (the backend's 204) ends every session; page one and page two show 1b; the old password is refused", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const one = await leaderPage(context);
    await signedIn(one, "pete");
    const two = await leaderPage(context);
    await untilView(two, "displaying");
    await openSettings(one);
    await one.getByRole("link", { name: /Signing in/ }).click();
    const dialog = one.getByRole("dialog", { name: "Signing in" });
    await dialog.getByLabel("Current password").fill(password("pete"));
    const fresh = `${password("pete")}-I-L6-new`;
    await dialog.getByLabel(/New password/).fill(fresh);
    await dialog.getByRole("button", { name: "Change password" }).click();
    for (const page of [one, two]) {
      await untilView(page, "neutral", "1b", 60_000);
      await expectAbsent(page, name("pete"));
    }
    const refused = await raw("POST", "/browser-sessions", {
      body: {
        username: name("pete"),
        password: password("pete"),
        device_id: crypto.randomUUID(),
        attempt_challenge: "x".repeat(43),
      },
    });
    expect(refused.status).toBe(401);
  });
});

test.describe("I-L7: T21 and K-1 against the backend", () => {
  test("I-L7: another account's live cookie under this page's stamp: the backend's credential_mismatch fences at once; the verification reads the other account: 1d; the verification is not repeated without end", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await leaderPage(context);
    await signedIn(page, "quinn");
    await railShows(page, "quinn");
    const other = await rawSignIn("alice");
    await swapCookie(context, other);
    const since = (await proxy.log()).length;
    // A TRIGGER only: the page's own sync leader may make the next request first and detect the mismatch itself, after which the
    // navigation is gone (Firefox, campaign 2026-10-11T12-53-28.484Z-7b30b88e); either request is the backend's own answer.
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await untilView(page, "neutral", "1d", 60_000);
    await expectAbsent(page, name("quinn"));
    await expectAbsent(page, name("alice"));
    await page.waitForTimeout(3_000);
    const settled = (await proxyLog(since)).filter(
      (e) => e.path === `${API}/browser-sessions/current`,
    ).length;
    await page.waitForTimeout(5_000);
    const later = (await proxyLog(since)).filter(
      (e) => e.path === `${API}/browser-sessions/current`,
    ).length;
    expect(later - settled).toBe(0);
    expect(settled).toBeLessThanOrEqual(6);
  });
});

test.describe("I-L9: G-23, 'Confirm it's you' against the backend's own five-minute rule (opt-in, REAL time)", () => {
  test("I-L9: after 305 s of real time Link is disabled with its reason; 'Confirm it's you' re-authenticates in place (a new session at a newer epoch); back on Signing in, Link is enabled and focused; the backend then LINKS single sign-on and, within the five minutes, UNLINKS it", async ({
    context,
  }) => {
    test.skip(
      process.env.ATLAS_INTEGRATION_REALTIME !== "1",
      "opt-in: about 5½ minutes of REAL time per engine (ATLAS_INTEGRATION_REALTIME=1)",
    );
    test.setTimeout(600_000);
    const page = await leaderPage(context);
    const first = await signedIn(page, "bob");
    await page.waitForTimeout(305_000);
    await openSettings(page);
    await page.getByRole("link", { name: /Signing in/ }).click();
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await expect(
      dialog.getByRole("button", { name: "Link single sign-on" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Confirm it's you" }).click();
    const region = dialog.getByRole("region", { name: "Confirm it's you" });
    await budget("bob");
    await region.getByLabel("Password").fill(password("bob"));
    await region.getByRole("button", { name: "Confirm it's you" }).click();
    await expect(page).toHaveURL(/\/settings\/signing-in$/, {
      timeout: 60_000,
    });
    const link = page
      .getByRole("dialog", { name: "Signing in" })
      .getByRole("button", { name: "Link single sign-on" });
    await expect(link).toBeEnabled({ timeout: 30_000 });
    await expect(link).toBeFocused({ timeout: 30_000 });
    const after = await identity(page);
    expect(after?.account_id).toBe(first.account_id);
    expect(after?.epoch).toBeGreaterThan(first.epoch);

    // R5 of the review of 11 October 2026 (plan §6.5): the confirmation is what makes the backend's link AND unlink possible.
    test.skip(
      !OIDC,
      "the link and unlink need the stub OpenID Connect provider (run with --oidc on)",
    );
    await provider.subject(`il9-${Date.now().toString(36)}`);
    await followNavigation(page, () => link.click());
    await untilView(page, "displaying");
    await expect(
      page.locator('[data-notice="feedback-message"]'),
    ).toContainText("Single sign-on is now linked to your account.", {
      timeout: 30_000,
    });
    const readMe = async () => {
      const probe = await rawSignIn("bob");
      return (
        await raw("GET", "/me", {
          cookie: probe.cookie,
          headers: { "x-csrf-token": probe.csrf },
        })
      ).json as { oidc_issuers: string[] };
    };
    expect((await readMe()).oidc_issuers).toEqual([OIDC?.issuer]);
    // Within the five minutes the confirmation started, the link is removed: the backend removes it and ends the session (1b).
    await openSettings(page);
    await page.getByRole("link", { name: /Signing in/ }).click();
    await page
      .getByRole("dialog", { name: "Signing in" })
      .getByRole("button", { name: /^Remove / })
      .click();
    await untilView(page, "neutral", "1b", 60_000);
    expect((await readMe()).oidc_issuers).toEqual([]);
  });
});

test.describe("I-L10: T23 E/F/L composed: a recording that cannot be saved, every page gone, an offline reopening", () => {
  test("I-L10: a real 401 whose recording write fails (named IndexedDB fault, test-only): every page is closed; a new page offline shows the interrupted-request card (1e) and nothing of A; online it verifies: the backend's 401 → 1b", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    // TEST-ONLY fault, named and scoped: while `window.__failAuthRecords` is true, the `atlas-auth` write that would ADD an
    // `invalid_session` fence (the recording of the observation, matrix 3.6.1 step 2) is aborted inside its transaction, so nothing of it
    // commits; every other write (the request's own cover and lease) is untouched. No product hook exists; nothing ships.
    await context.addInitScript(() => {
      const w = window as unknown as { __failAuthRecords?: boolean };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (
          w.__failAuthRecords &&
          this.transaction.db.name === "atlas-auth" &&
          args[1] === "auth_state" &&
          JSON.stringify(args[0]).includes('"invalid_session"')
        ) {
          this.transaction.abort();
          throw new DOMException(
            "injected: the recording write fails",
            "AbortError",
          );
        }
        return put.apply(this, args);
      } as typeof put;
    });
    const page = await leaderPage(context);
    await signedIn(page, "carol");
    await railShows(page, "carol");
    // The named fault is armed BEFORE carol's session ends: the page's own sync leader may meet the 401 first (it matches only the write
    // that adds an `invalid_session` fence, so nothing earlier is affected).
    await page.evaluate(() => {
      (window as unknown as { __failAuthRecords: boolean }).__failAuthRecords =
        true;
    });
    // carol's session ends elsewhere (the backend's own 401 at the next request).
    const other = await rawSignIn("carol");
    const sessions = await raw("GET", "/sessions", {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    for (const row of (
      sessions.json as { sessions: Array<{ id: string; current: boolean }> }
    ).sessions.filter((s) => !s.current))
      await raw("DELETE", `/sessions/${row.id}`, {
        cookie: other.cookie,
        headers: { "x-csrf-token": other.csrf },
      });
    // A TRIGGER only: the leader's own request may detect it first, and the navigation is then gone.
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await expect
      .poll(
        () =>
          untilView(page, "neutral")
            .then(() => true)
            .catch(() => false),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    await expectAbsent(page, name("carol"));
    await page.close();
    // A new page, OFFLINE (emulated at the application's boundary: `navigator.onLine` false and every API request failing before the
    // network, so the static application still loads): the lease left by the unrecorded request keeps the account hidden (row 9).
    await context.route(`**${API}/**`, (route) =>
      route.abort("internetdisconnected"),
    );
    const reopened = await context.newPage();
    await reopened.addInitScript(() => {
      const w = window as unknown as { __online?: boolean };
      Object.defineProperty(navigator, "onLine", {
        get: () => w.__online === true,
        configurable: true,
      });
    });
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await expect
      .poll(
        async () =>
          (await reopened.evaluate(() => window.__s.view.get())) as {
            kind: string;
            state?: string;
          },
        { timeout: 30_000 },
      )
      .toMatchObject({ kind: "neutral", state: "1e.interrupted_offline" });
    await expectAbsent(reopened, name("carol"));
    // Online again: one verification; the backend's own 401 → 1b.
    await context.unroute(`**${API}/**`);
    await reopened.evaluate(() => {
      (window as unknown as { __online: boolean }).__online = true;
      window.dispatchEvent(new Event("online"));
    });
    await untilView(reopened, "neutral", "1b", 60_000);
    await expectAbsent(reopened, name("carol"));
  });
});

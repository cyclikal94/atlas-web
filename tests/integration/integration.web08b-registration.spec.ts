import {
  bootHarness,
  expect,
  exposeSession,
  ORIGIN,
  proxy,
  raw,
  recordMeasurement,
  records,
  test,
  untilView,
} from "./helpers";
import {
  ACTIVATE,
  CELLS,
  credentialsWork,
  identityOf,
  invitation,
  pinVisible,
  previewStatus,
  REGISTRATION,
  runOrderingCell,
  strongPassword,
  uiSignIn,
  uniqueName,
  wire,
} from "./web08b-support";

/**
 * I-24, I-25 and I-26 (WEB-08b plan 9.3): invitation registration against the RELEASED backend (v0.27.0-rc.1, SQLite). Invitations
 * are the backend's own operator invitations (`atlas-server invite`), one per slot, so no test depends on another's.
 *
 * What they prove: the registration answer carries a grant and NO cookie, only `activate` sets one; an unknown outcome leaves the
 * account created and the invitation consumed, so the chosen credentials sign in; a taken username preserves the invitation; the
 * invitation token never appears in a request URL or any storage. What they do NOT prove: a HOUSEHOLD invitation (the released
 * binary and API give an account no household to invite to, see I-25h), another database, or a real mail or messaging delivery.
 */
const B_WHO = ["heidi", "ivan", "judy", "kate", "liam", "mia", "nora"] as const;

test.describe("I-24: T16, registration by invitation, delayed response", () => {
  for (const [i, cell] of CELLS.entries()) {
    test(`I-24 registration, server order ${cell.order} x answer delivered ${cell.window}`, async ({
      context,
    }) => {
      await pinVisible(context);
      const token = invitation(i);
      const username = uniqueName("t16", i);
      const password = strongPassword();
      const started = Date.now();
      const r = await runOrderingCell(context, {
        a: { kind: "registration", token, username, password },
        bWho: B_WHO[i] as (typeof B_WHO)[number],
        ...cell,
      });
      // The registration answer carried a grant and no cookie; the only responses that set one were activations.
      const registrations = r.seen.filter((e) => e.path === REGISTRATION);
      expect(registrations.length).toBeGreaterThanOrEqual(1);
      for (const response of registrations) {
        expect(response.status).toBe(200);
        expect(response.setCookie).toBe(false);
      }
      const writers = r.seen.filter((e) => e.setCookie).map((e) => e.path);
      if (cell.window === "before-B-starts") {
        expect(r.outcomeA).toMatchObject({
          kind: "settled",
          method: "registration",
        });
        expect(writers).toEqual([ACTIVATE, ACTIVATE]);
      } else {
        expect(r.outcomeA).toEqual({ kind: "superseded" }); // discarded exactly as in T1
        expect(writers).toEqual([ACTIVATE]);
        expect(r.activations).toBe(1);
      }
      expect(r.outcomeB.kind).toBe("settled");
      expect(await identityOf(r.tab1)).toBe(r.outcomeB.account_id);
      // The account and the invitation were committed regardless of what happened to the answer.
      expect(await credentialsWork(username, password)).toBe(true);
      expect(await previewStatus(token)).toBe(401); // consumed
      if (i === 0)
        recordMeasurement(
          "P-8b-2 registration cell, from start to B settled (includes Argon2 work on the backend)",
          {
            milliseconds: Date.now() - started,
          },
        );
    });
  }
});

test.describe("I-25: registration end to end through the real UI", () => {
  test("I-25 a standalone invitation: preview, redemption, settlement, first protected paint; the token is never in a URL or in storage", async ({
    context,
  }) => {
    await pinVisible(context);
    const token = invitation(7);
    const username = uniqueName("ui", 7);
    const password = strongPassword();
    const page = await context.newPage();
    const requests: Array<{
      method: string;
      url: string;
      body: string | null;
    }> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        requests.push({
          method: request.method(),
          url: request.url(),
          body: request.postData(),
        });
    });
    await page.goto(`/__session?route=%2Fjoin#t=${token}`);
    await exposeSession(page);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "You're invited to join Atlas",
      }),
    ).toBeVisible();
    expect(page.url()).not.toContain(token);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    const started = Date.now();
    await page.getByRole("button", { name: "Create account" }).click();
    await untilView(page, "displaying");
    recordMeasurement(
      "P-8b-2 registration through the UI, from submit to a displaying view",
      {
        milliseconds: Date.now() - started,
      },
    );
    await expect.poll(() => new URL(page.url()).pathname).toBe("/today");
    // The account card names the account the person just made.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("[data-account-card]")).toContainText(username);
    // The token travelled in two request BODIES (preview, registration) and in no URL.
    for (const request of requests) expect(request.url).not.toContain(token);
    const withToken = requests.filter((r) => r.body?.includes(token));
    expect(withToken.map((r) => new URL(r.url).pathname).sort()).toEqual([
      "/api/experimental/v1/browser-registration",
      "/api/experimental/v1/registration/preview",
    ]);
    // The password travelled in one body only.
    expect(requests.filter((r) => r.body?.includes(password))).toHaveLength(1);
    // Neither is in any storage the page holds.
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    const durable = JSON.stringify(await records(page));
    for (const secret of [token, password]) {
      expect(stored).not.toContain(secret);
      expect(durable).not.toContain(secret);
    }
    expect(await previewStatus(token)).toBe(401);
  });

  test("I-25 a registration discarded because a newer sign-in FAILED retires the live form: the consumed invitation is not offered again, and the chosen details sign in (review R2)", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const token = invitation(14);
    const username = uniqueName("sup", 14);
    const password = strongPassword();
    // The backend COMMITS the registration; its answer is held until released.
    const { id } = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-registration",
      action: "hold",
      ordinal: 1,
    });
    const a = await context.newPage();
    await a.goto(`/__session?route=%2Fjoin#t=${token}`);
    await exposeSession(a);
    await a.getByLabel("Username").fill(username);
    await a.getByLabel("Password").fill(password);
    await a.getByRole("button", { name: "Create account" }).click();
    await expect.poll(async () => (await proxy.held())[id] ?? 0).toBe(1);
    // A newer attempt in another tab FAILS, so no account displays anywhere and nothing replaces this page.
    const b = await bootHarness(context, "/");
    await uiSignIn(b, "olga", "this-is-not-olgas-password");
    await expect(b.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    await proxy.release(id);
    // The stale result is discarded (the notice says why) and the form is RETIRED: the invitation is consumed.
    await expect(a.getByText(/replaced by a newer one/)).toBeVisible();
    await expect(a.getByText(/lost the confirmation/)).toBeVisible();
    await expect(a.getByRole("button", { name: "Create account" })).toHaveCount(
      0,
    );
    await expect(a.getByLabel("Password")).toHaveCount(0);
    expect(await previewStatus(token)).toBe(401);
    // The account exists: the details the person chose sign in.
    expect(await credentialsWork(username, password)).toBe(true);
  });

  /**
   * Review R5, against the released backend. A DIFFERENT invitation is opened in the same tab (a fragment-only navigation) while
   * the first registration's answer is held at the proxy. The first answer, when it comes, belongs to the first invitation.
   */
  test("I-25 a result discarded because a newer sign-in FAILED, arriving after a DIFFERENT invitation was opened: the second form and invitation are untouched, and the first is told beside it (review R5)", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const first = invitation(15);
    const second = invitation(16);
    const firstName = uniqueName("r5a", 15);
    const firstPassword = strongPassword();
    const secondName = uniqueName("r5b", 16);
    const secondPassword = strongPassword();
    // The backend COMMITS the first registration; its answer is held until released.
    const { id } = await proxy.addRule({
      method: "POST",
      path: REGISTRATION,
      action: "hold",
      ordinal: 1,
    });
    const a = await context.newPage();
    await a.goto(`/__session?route=%2Fjoin#t=${first}`);
    await exposeSession(a);
    await a.getByLabel("Username").fill(firstName);
    await a.getByLabel("Password").fill(firstPassword);
    await a.getByRole("button", { name: "Create account" }).click();
    await expect.poll(async () => (await proxy.held())[id] ?? 0).toBe(1);
    // A different invitation is pasted into the address bar of this open page: the application strips it and previews it.
    await a.evaluate((token) => {
      location.hash = `t=${token}`;
    }, second);
    await expect(
      a.getByRole("heading", {
        level: 1,
        name: "You're invited to join Atlas",
      }),
    ).toBeVisible();
    expect(a.url()).not.toContain(second);
    await a.getByLabel("Username").fill(secondName);
    await a.getByLabel("Password").fill(secondPassword);
    // A newer attempt in another tab FAILS, so no account displays anywhere.
    const b = await bootHarness(context, "/");
    await uiSignIn(b, "olga", "this-is-not-olgas-password");
    await expect(b.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    await proxy.release(id);
    // The stale result is discarded (the notice says why), the first is told beside the second, and the second form is intact.
    await expect(a.getByText(/replaced by a newer one/)).toBeVisible();
    await expect(a.getByText(/You opened another invitation/)).toBeVisible();
    await expect(a.getByText(/lost the confirmation/)).toHaveCount(0);
    await expect(a.getByLabel("Username")).toHaveValue(secondName);
    await expect(a.getByLabel("Password")).toHaveValue(secondPassword);
    await expect(
      a.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    // On the backend: the first is consumed and its account exists; the second is untouched. The first was sent once.
    expect(await previewStatus(first)).toBe(401);
    expect(await previewStatus(second)).toBe(200);
    expect(await credentialsWork(firstName, firstPassword)).toBe(true);
    expect(
      (await proxy.log()).filter(
        (e) => e.method === "POST" && e.path === REGISTRATION,
      ),
    ).toHaveLength(1);
    // The second invitation still works from this page, with its own token.
    await a.getByRole("button", { name: "Create account" }).click();
    await untilView(a, "displaying");
    expect(await previewStatus(second)).toBe(401);
    expect(await credentialsWork(secondName, secondPassword)).toBe(true);
  });

  test("I-25 a refusal that leaves the first invitation usable, arriving after a DIFFERENT invitation was opened, changes nothing: the second form stays and the first token is not put back (review R5)", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    await pinVisible(context);
    const first = invitation(17);
    const second = invitation(18);
    const secondName = uniqueName("r5c", 18);
    const secondPassword = strongPassword();
    const { id } = await proxy.addRule({
      method: "POST",
      path: REGISTRATION,
      action: "hold",
      ordinal: 1,
    });
    const a = await context.newPage();
    const seen = wire(a);
    await a.goto(`/__session?route=%2Fjoin#t=${first}`);
    await exposeSession(a);
    await a.getByLabel("Username").fill("alice"); // an account the stack already has: the backend answers 409
    await a.getByLabel("Password").fill(strongPassword());
    await a.getByRole("button", { name: "Create account" }).click();
    await expect.poll(async () => (await proxy.held())[id] ?? 0).toBe(1);
    await a.evaluate((token) => {
      location.hash = `t=${token}`;
    }, second);
    await expect(
      a.getByRole("heading", {
        level: 1,
        name: "You're invited to join Atlas",
      }),
    ).toBeVisible();
    await a.getByLabel("Username").fill(secondName);
    await a.getByLabel("Password").fill(secondPassword);
    await proxy.release(id);
    await expect
      .poll(
        () =>
          seen.filter((w) => w.path === REGISTRATION && w.status === 409)
            .length,
      )
      .toBe(1);
    // Nothing about the first reaches this form, and the second form is intact.
    await expect(
      a.getByText("That username is taken. Choose another."),
    ).toHaveCount(0);
    await expect(a.getByText(/You opened another invitation/)).toHaveCount(0);
    await expect(a.getByLabel("Username")).toHaveValue(secondName);
    await expect(a.getByLabel("Password")).toHaveValue(secondPassword);
    await expect(
      a.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    // Both invitations are still open on the backend; only the second can be submitted from this page.
    expect(await previewStatus(first)).toBe(200);
    expect(await previewStatus(second)).toBe(200);
    await a.getByRole("button", { name: "Create account" }).click();
    await untilView(a, "displaying");
    expect(await previewStatus(second)).toBe(401);
    expect(await previewStatus(first)).toBe(200);
    expect(await credentialsWork(secondName, secondPassword)).toBe(true);
    expect(
      (await proxy.log()).filter(
        (e) => e.method === "POST" && e.path === REGISTRATION,
      ),
    ).toHaveLength(2);
  });

  test("I-25 a taken username keeps the invitation: the same link still works with another name", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    await pinVisible(context);
    const token = invitation(8);
    const page = await context.newPage();
    await page.goto(`/__session?route=%2Fjoin#t=${token}`);
    await exposeSession(page);
    await page.getByLabel("Username").fill("alice"); // an account the stack already has
    await page.getByLabel("Password").fill(strongPassword());
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("That username is taken. Choose another."),
    ).toBeVisible();
    expect(page.getByLabel("Username")).toBeFocused();
    expect(await previewStatus(token)).toBe(200); // the invitation is preserved
    const username = uniqueName("ui", 8);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(strongPassword());
    await page.getByRole("button", { name: "Create account" }).click();
    await untilView(page, "displaying");
    expect(await previewStatus(token)).toBe(401);
  });

  test("I-25 an invitation that was already used shows the single honest state and no form", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const token = invitation(9);
    const made = await raw("POST", "/browser-registration", {
      body: {
        token,
        username: uniqueName("used", 9),
        password: strongPassword(),
        device_id: "i25-used",
        attempt_challenge: "a".repeat(43),
      },
    });
    expect(made.status).toBe(200);
    const page = await bootHarness(context, "/join", `#t=${token}`);
    await expect(
      page.getByText(
        "This invitation has expired or was already used. Ask whoever invited you for a new one.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toHaveCount(0);
  });

  test("I-25 a response lost after the backend committed: the page says so, nothing is resubmitted, and the chosen details sign in", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    await pinVisible(context);
    const token = invitation(10);
    const username = uniqueName("lost", 10);
    const password = strongPassword();
    const rule = await proxy.addRule({
      method: "POST",
      path: REGISTRATION,
      action: "drop_after_forward",
      ordinal: 1,
    });
    expect(rule.id).toBeTruthy();
    const page = await bootHarness(context, "/join", `#t=${token}`);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/lost the confirmation/)).toBeVisible();
    expect(
      (await proxy.log()).filter(
        (e) => e.method === "POST" && e.path === REGISTRATION,
      ),
    ).toHaveLength(1); // never resubmitted
    expect(await credentialsWork(username, password)).toBe(true); // the account exists
    expect(await previewStatus(token)).toBe(401); // the invitation is consumed
    // "Sign in" carries the chosen username (never the password) to the real form.
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByLabel("Username")).toHaveValue(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await untilView(page, "displaying");
  });

  test("I-25h a HOUSEHOLD invitation is exercised only if an account has a household it manages", async () => {
    // The released binary's `account` command makes accounts with no household, and the API has no way to create one
    // (GET /households only). So a household invitation cannot be issued here: the household heading is Layer B only.
    const { rawSignIn } = await import("./helpers");
    const alice = await rawSignIn("alice");
    const households = await raw("GET", "/households", {
      cookie: alice.cookie,
      headers: { "x-csrf-token": alice.csrf },
    });
    expect(households.status).toBe(200);
    const items = JSON.stringify(households.json);
    test.skip(
      !/manager/.test(items),
      `NOT RUN: no bootstrap account manages a household (GET /households answered ${items.slice(0, 120)}); the household heading is covered at Layer B only`,
    );
  });
});

test.describe("I-26: the dedicated /browser-registration Origin and grant test (raw HTTP)", () => {
  const body = (token: string, over: Record<string, unknown> = {}) => ({
    token,
    username: uniqueName("raw", 11),
    password: strongPassword(),
    device_id: "i26-device",
    attempt_challenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ".slice(
      0,
      43,
    ),
    ...over,
  });

  test("I-26 Origin is checked first: none or a wrong one is 403 forbidden, even with a malformed body", async ({
    provokes,
  }) => {
    provokes(403);
    const token = invitation(11);
    for (const origin of [
      null,
      "http://evil.example.test",
      `${ORIGIN}.evil.test`,
    ]) {
      const refused = await raw("POST", "/browser-registration", {
        origin,
        body: body(token),
      });
      expect(refused.status, String(origin)).toBe(403);
      expect(refused.json).toMatchObject({ code: "forbidden" });
      expect(refused.setCookie).toEqual([]);
    }
    // Origin before body shape: a wrong Origin with a garbage body is still 403, not 422.
    const garbled = await raw("POST", "/browser-registration", {
      origin: "http://evil.example.test",
      body: { token: "nope" },
    });
    expect(garbled.status).toBe(403);
    expect(await previewStatus(token)).toBe(200); // nothing was consumed
  });

  test("I-26 malformed shapes are 400 or 422 and consume nothing", async ({
    provokes,
  }) => {
    provokes(400, 422);
    const token = invitation(12);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a short password", { password: "short" }],
      ["upper-case username characters", { username: "NotAllowed" }],
      ["an empty username", { username: "" }],
      ["a non-hex token", { token: "z".repeat(64) }],
      ["a bad challenge", { attempt_challenge: "not-a-challenge" }],
      ["an unknown field", { surprise: true }],
    ];
    for (const [name, over] of cases) {
      const refused = await raw("POST", "/browser-registration", {
        body: body(token, over),
      });
      expect([400, 422], name).toContain(refused.status);
      expect((refused.json as { code?: string })?.code, name).toMatch(
        /^(invalid_value|malformed_request)$/,
      );
      expect(refused.setCookie, name).toEqual([]);
    }
    expect(await previewStatus(token)).toBe(200); // still usable
  });

  test("I-26 a valid token redeems to a grant with NO Set-Cookie; a reused token is 401; activate is the only response that sets the cookie, with the contracted flags", async ({
    provokes,
  }) => {
    provokes(401);
    const token = invitation(13);
    const verifier = (await import("./helpers")).freshVerifier();
    const { challengeFor } = await import("./helpers");
    const username = uniqueName("raw", 13);
    const password = strongPassword();
    const redeemed = await raw("POST", "/browser-registration", {
      body: body(token, {
        username,
        password,
        attempt_challenge: await challengeFor(verifier),
      }),
    });
    expect(redeemed.status).toBe(200);
    expect(Object.keys(redeemed.json as object).sort()).toEqual([
      "account_id",
      "grant",
      "grant_expires_at",
    ]);
    expect(redeemed.setCookie).toEqual([]); // the registration answer sets NO cookie (matrix G1)
    // A reused token is refused, and tells the caller nothing about why.
    const again = await raw("POST", "/browser-registration", {
      body: body(token, { username: uniqueName("raw", 14) }),
    });
    expect(again.status).toBe(401);
    expect(again.json).toMatchObject({ code: "unauthenticated" });
    expect(again.setCookie).toEqual([]);
    // Activation is where the cookie appears, and its flags are the contracted ones (plain HTTP on loopback).
    const activated = await raw("POST", "/browser-sessions/activate", {
      body: { grant: (redeemed.json as { grant: string }).grant, verifier },
    });
    expect(activated.status).toBe(200);
    expect(activated.setCookie).toHaveLength(1);
    const cookie = activated.setCookie[0] ?? "";
    expect(cookie).toMatch(/^atlas_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
    // The account is the one registered: its own session sees its username.
    expect(await credentialsWork(username, password)).toBe(true);
  });

  test("I-26 a duplicate username is 409 and the invitation stays usable", async ({
    provokes,
  }) => {
    provokes(409);
    const token = invitation(12);
    const taken = await raw("POST", "/browser-registration", {
      body: body(token, { username: "bob" }),
    });
    expect(taken.status).toBe(409);
    expect(taken.json).toMatchObject({ code: "conflict" });
    expect(taken.setCookie).toEqual([]);
    expect(await previewStatus(token)).toBe(200);
  });

  test("I-26 preview needs no Origin and answers the same 401 for unknown, malformed-but-shaped and used tokens", async ({
    provokes,
  }) => {
    provokes(401);
    const unknown = await raw("POST", "/registration/preview", {
      origin: null,
      body: { token: "e".repeat(64) },
    });
    expect(unknown.status).toBe(401);
    const open = await raw("POST", "/registration/preview", {
      origin: null,
      body: { token: invitation(12) },
    });
    expect(open.status).toBe(200);
    expect(Object.keys(open.json as object).sort()).toEqual([
      "expires_at",
      "household",
    ]);
    expect((open.json as { household: unknown }).household).toBeNull();
  });
});

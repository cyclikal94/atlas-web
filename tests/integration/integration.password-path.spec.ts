import type { Page } from "@playwright/test";
import {
  ACCOUNTS,
  API,
  bootHarness,
  challengeFor,
  expect,
  exposeSession,
  freshVerifier,
  ORIGIN,
  proxy,
  raw,
  records,
  signIn,
  test,
  untilRecord,
  type Who,
} from "./helpers";

/**
 * I-01 to I-03 (plan 14.3). The session module and its production adapters in a real engine against the RELEASED backend
 * (v0.27.0-rc.1) on a disposable SQLite database. What each asserts on the wire, and what it does not prove, is stated per test.
 * `Set-Cookie` presence is read from response headers, never from `document.cookie` (the cookie is HttpOnly).
 */
const wire = (page: Page) => {
  const seen: Array<{
    method: string;
    path: string;
    status: number;
    setCookie: boolean;
    headers: Record<string, string>;
  }> = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const headers = await response.allHeaders();
    seen.push({
      method: response.request().method(),
      path: url.pathname.replace("/api/experimental/v1", ""),
      status: response.status(),
      setCookie: "set-cookie" in headers,
      headers: await response.request().allHeaders(),
    });
  });
  return seen;
};

test.describe("I-01: the password path through the module", () => {
  test("exchange sets no cookie; activate is the only response that does; session_id matches the current row; wire headers as contracted", async ({
    context,
  }) => {
    const page = await context.newPage();
    const seen = wire(page);
    await page.goto("/__session?route=/today");
    await exposeSession(page);
    const outcome = await signIn(page, "alice");
    expect(outcome.kind).toBe("settled");
    await page.waitForFunction(
      () => window.__s.view.get().kind === "displaying",
    );

    const exchange = seen.find(
      (r) => r.path === "/browser-sessions" && r.method === "POST",
    );
    const activate = seen.find((r) => r.path === "/browser-sessions/activate");
    expect(exchange?.status).toBe(200);
    expect(exchange?.setCookie).toBe(false); // the exchange returns a grant and NO cookie
    expect(activate?.status).toBe(200);
    expect(activate?.setCookie).toBe(true); // activation is the ONE response that sets the cookie
    expect(seen.filter((r) => r.setCookie).map((r) => r.path)).toEqual([
      "/browser-sessions/activate",
    ]);

    // settled.session_id equals the `current` row of GET /sessions.
    const listed = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    const rows = listed.ok ? listed.value.sessions : [];
    const current = rows.find((row) => row.current);
    const state = (await records(page)).auth_state;
    expect(current).toBeDefined();
    expect(state.settled?.session_id).toBe(current?.id);
    expect(state.settled?.epoch).toBe(1);
    expect(state.attempt).toBeNull(); // the verifier is gone at settlement

    // current() is accepted with X-Atlas-Session: 1 and NO CSRF header; a stamped GET carries X-CSRF-Token (SA-01).
    const currentCall = seen.find(
      (r) => r.path === "/browser-sessions/current",
    );
    expect(currentCall?.status).toBe(200);
    expect(currentCall?.headers["x-atlas-session"]).toBe("1");
    expect(currentCall?.headers["x-csrf-token"]).toBeUndefined();
    const sessionsCall = seen.find(
      (r) => r.path === "/sessions" && r.method === "GET",
    );
    expect(sessionsCall?.headers["x-csrf-token"]).toMatch(/\S+/);
    expect(sessionsCall?.headers["x-atlas-session"]).toBeUndefined();
  });

  test("the device id is created once and reused for the next sign-in", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    expect((await signIn(page, "alice")).kind).toBe("settled");
    const first = (await records(page)).device?.device_id;
    expect(first).toMatch(/[0-9a-f-]{36}/);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    expect((await records(page)).device?.device_id).toBe(first);
  });
});

/** How many sessions the account has, seen through a temporary raw session that is revoked again (so it leaves no trace). */
async function sessionCount(who: Who): Promise<number> {
  const verifier = freshVerifier();
  const exchange = await raw("POST", "/browser-sessions", {
    body: {
      username: ACCOUNTS[who].username,
      password: ACCOUNTS[who].password,
      attempt_challenge: await challengeFor(verifier),
      device_id: `count-${who}`,
    },
  });
  const grant = (exchange.json as { grant: string }).grant;
  const activated = await raw("POST", "/browser-sessions/activate", {
    body: { grant, verifier },
  });
  const cookie = activated.setCookie.map((c) => c.split(";")[0]).join("; ");
  const current = await raw("GET", "/browser-sessions/current", {
    cookie,
    headers: { "x-atlas-session": "1" },
  });
  const { csrf_token: csrf, session_id: own } = current.json as {
    csrf_token: string;
    session_id: string;
  };
  const listed = await raw("GET", "/sessions", {
    cookie,
    headers: { "x-csrf-token": csrf },
  });
  const count = (listed.json as { sessions: unknown[] }).sessions.length;
  await raw("DELETE", `/sessions/${own}`, {
    cookie,
    headers: { "x-csrf-token": csrf },
  });
  return count;
}

test.describe("I-02: definitive versus indeterminate", () => {
  test("a wrong password is refused before any activation: nothing settles, the attempt clears", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    const outcome = await page.evaluate(async (c) => {
      const begun = await window.__s.attempts.begin("password");
      if (begun.kind !== "started") return { kind: `begin:${begun.kind}` };
      return window.__s.attempts.signInWithPassword(begun.handle, {
        username: c.username,
        password: `${c.password}-wrong`,
      });
    }, ACCOUNTS.alice);
    // An Atlas-formatted 4xx to the exchange is a DEFINITIVE refusal.
    expect(outcome).toMatchObject({
      kind: "refused",
      definitive: true,
      error: { code: "unauthenticated" },
    });
    const state = (await records(page)).auth_state;
    expect(state.settled).toBeNull();
    expect(state.attempt).toBeNull();
    expect(state.fences).toEqual({});
  });

  test("an activate whose response is lost AFTER the backend committed is indeterminate; activate/cancel then reports session_revoked and nothing is left behind", async ({
    context,
    provokes,
  }) => {
    provokes(401, 502);
    const before = await sessionCount("bob");
    const page = await bootHarness(context);
    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions/activate",
      action: "rewrite_status",
      status: 502,
      ordinal: 1,
    });
    expect(rule.id).toBeTruthy();
    const outcome = await signIn(page, "bob");
    // The 502 is not a definitive refusal: the attempt gates until the backend says what became of the grant.
    expect(outcome.kind).toBe("gating");
    await untilRecord(page, (s) => s.attempt === null, "the attempt resolves");
    const state = (await records(page)).auth_state;
    expect(state.settled).toBeNull(); // the target is NEVER adopted from a lost response
    // The backend did commit a session and the resolution revoked it: a fresh sign-in works and yields a fresh epoch.
    const log = await proxy.log();
    expect(
      log.some((entry) =>
        entry.path.endsWith("/browser-sessions/activate/cancel"),
      ),
    ).toBe(true);
    // The session the lost activation made was revoked by the cancel: the account has exactly the sessions it had before.
    expect(await sessionCount("bob")).toBe(before);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    const after = (await records(page)).auth_state;
    expect(after.settled?.epoch).toBeGreaterThan(1);
    expect(await sessionCount("bob")).toBe(before + 1);
  });
});

test.describe("I-03: activate/cancel results", () => {
  const exchange = async (who: Who = "alice") => {
    const verifier = freshVerifier();
    const response = await raw("POST", "/browser-sessions", {
      body: {
        username: ACCOUNTS[who].username,
        password: ACCOUNTS[who].password,
        attempt_challenge: await challengeFor(verifier),
        device_id: `raw-${verifier.slice(0, 8)}`,
      },
    });
    expect(response.status).toBe(200);
    return { verifier, grant: (response.json as { grant: string }).grant };
  };
  const cancel = (verifier: string) =>
    raw("POST", "/browser-sessions/activate/cancel", { body: { verifier } });

  test("not_activated: a grant that was issued and never redeemed; repeating returns the same result", async () => {
    const { verifier } = await exchange();
    const first = await cancel(verifier);
    const second = await cancel(verifier);
    expect(first.json).toEqual({ result: "not_activated" });
    expect(second.json).toEqual({ result: "not_activated" });
  });

  test("session_revoked: a grant that was redeemed; the session it made is revoked; repeating returns the same result", async () => {
    const { verifier, grant } = await exchange();
    const activated = await raw("POST", "/browser-sessions/activate", {
      body: { grant, verifier },
    });
    expect(activated.status).toBe(200);
    expect(activated.setCookie.length).toBeGreaterThan(0);
    const cookie = activated.setCookie.map((c) => c.split(";")[0]).join("; ");
    expect(
      (
        await raw("GET", "/browser-sessions/current", {
          cookie,
          headers: { "x-atlas-session": "1" },
        })
      ).status,
    ).toBe(200);
    expect((await cancel(verifier)).json).toEqual({
      result: "session_revoked",
    });
    expect((await cancel(verifier)).json).toEqual({
      result: "session_revoked",
    });
    expect(
      (
        await raw("GET", "/browser-sessions/current", {
          cookie,
          headers: { "x-atlas-session": "1" },
        })
      ).status,
    ).toBe(401);
  });

  test("unknown: a verifier no grant was ever made for", async () => {
    expect((await cancel(freshVerifier())).json).toEqual({ result: "unknown" });
  });

  test("a wrong verifier does not redeem, and the fifth wrong attempt cancels the grant", async ({
    provokes,
  }) => {
    provokes(422);
    const { verifier, grant } = await exchange();
    const wrong = freshVerifier();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1)
      statuses.push(
        (
          await raw("POST", "/browser-sessions/activate", {
            body: { grant, verifier: wrong },
          })
        ).status,
      );
    expect(statuses.every((s) => s >= 400 && s < 500)).toBe(true);
    // The genuine verifier can no longer redeem it.
    const late = await raw("POST", "/browser-sessions/activate", {
      body: { grant, verifier },
    });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.setCookie).toEqual([]);
    expect(API).toContain(ORIGIN);
  });
});

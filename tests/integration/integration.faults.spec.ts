import {
  bootHarness,
  expect,
  finishSignIn,
  proxy,
  raw,
  rawSignIn,
  records,
  startSignIn,
  swapCookie,
  test,
  untilHeld,
  untilRecord,
  untilView,
} from "./helpers";

/**
 * I-04, I-05 and I-08 (plan 14.3): a late activation after a cancel, a credential mismatch, and a password change. Real backend,
 * real cookies, real CSRF; the delaying proxy makes the schedule.
 */
test.describe("I-04: late activation after cancel (T8 at module level)", () => {
  test("the late response installs a DEAD cookie; the next stamped request is a 401; the fence is recorded; the reconnect card shows", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions/activate",
      action: "hold",
      ordinal: 1,
    });
    // The backend redeems the grant and creates a session; the proxy holds the answer.
    await startSignIn(page, "alice");
    await untilHeld(rule.id);
    // Meanwhile the attempt is cancelled by someone holding the verifier (another window's resolution): the backend revokes the session.
    const verifier = (await records(page)).auth_state.attempt?.verifier;
    expect(verifier).toMatch(/\S{43}/);
    const cancelled = await raw("POST", "/browser-sessions/activate/cancel", {
      body: { verifier },
    });
    expect(cancelled.json).toEqual({ result: "session_revoked" });
    // The late answer arrives: it is a 200 with a cookie for a session that is already dead.
    await proxy.release(rule.id);
    const outcome = await finishSignIn(page);
    expect(outcome.kind).toBe("settled");
    // The next stamped request is a 401. The observation is recorded, the display closes, the card is "Reconnect to keep going".
    const listed = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    // ADAPTED (WEB-08c revision 14, family `i04-first-stamped-request-premise`; the original assertion was
    // `expect(listed).toMatchObject({ ok: false, error: "auth_state" })`). It assumed THIS call is the first stamped request after the
    // late activation. The page's own post-display read (the data layer's `GET /me`) can be issued first: it then observes the 401, the
    // session closes, and this call is refused `closed` without being sent (revision-14 continuation run, kernel trace and network log).
    // The original intent is kept: the FIRST stamped request after the late activation, whichever it is, is the backend's 401; this
    // call never succeeds; it answers `auth_state` itself unless an earlier stamped request observed the 401 first.
    const log = await proxy.log();
    const activated = log.findIndex(
      (e) =>
        e.method === "POST" && /\/browser-sessions\/activate$/.test(e.path),
    );
    const stamped = log
      .slice(activated + 1)
      .filter(
        (e) =>
          e.path.startsWith("/api/") &&
          !/\/browser-sessions(\/|\?|$)|\/health(\?|$)/.test(e.path),
      );
    expect(
      stamped[0]?.status,
      "the first stamped request after the late activation is the backend's 401",
    ).toBe(401);
    expect(listed.ok, "the call never succeeds").toBe(false);
    if (!listed.ok && listed.error === "closed")
      expect(
        stamped[0]?.path,
        "an earlier stamped request observed the 401",
      ).not.toMatch(/\/sessions(\?|$)/);
    else expect(listed).toMatchObject({ ok: false, error: "auth_state" });
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "an invalid_session fence is recorded",
    );
    await untilView(page, "neutral", "1b");
    await expect(
      page.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible();
    // Nothing was wiped and no data port was touched: no deletion record exists.
    expect((await records(page)).pending_deletions).toEqual({});
  });
});

test.describe("I-05: credential_mismatch", () => {
  const signedIn = async (
    context: import("@playwright/test").BrowserContext,
  ) => {
    const page = await bootHarness(context);
    expect((await (await import("./helpers")).signIn(page, "alice")).kind).toBe(
      "settled",
    );
    await untilView(page, "displaying");
    return page;
  };

  test("session A's CSRF token with session B's cookie of the SAME account: 403 credential_mismatch, recorded durably, verified, cleared, tokens refreshed", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await signedIn(context);
    const before = (await records(page)).auth_state.settled;
    const other = await rawSignIn("alice");
    // Hold the verification's answer so the fence is observable while it is outstanding.
    const rule = await proxy.addRule({
      method: "GET",
      path: "/api/experimental/v1/browser-sessions/current",
      action: "hold",
      ordinal: 1,
    });
    await swapCookie(context, other);
    const listed = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    expect(listed).toMatchObject({ ok: false, error: "auth_state" });
    // While the check is outstanding the account is closed durably: credential_unverified, and the neutral card.
    await untilHeld(rule.id);
    const during = (await records(page)).auth_state;
    expect(
      Object.values(during.fences)
        .flat()
        .map((f) => f.kind),
    ).toContain("credential_unverified");
    await untilView(page, "neutral");
    expect(await page.evaluate(() => window.__s.view.get())).toMatchObject({
      state: expect.stringMatching(/^1e\.session_/),
    });
    // The check says: same account. The fence clears, the session id and token refresh, and the account is shown again.
    await proxy.release(rule.id);
    await untilRecord(
      page,
      (s) => Object.keys(s.fences).length === 0,
      "the credential_unverified fence clears",
    );
    const after = (await records(page)).auth_state.settled;
    expect(after?.account_id).toBe(before?.account_id);
    expect(after?.session_id).toBe(other.sessionId);
    await untilView(page, "displaying");
  });

  test("session B belongs to ANOTHER account: the check adds drift, the display stays closed, the card names the different account without naming it", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await signedIn(context);
    const stranger = await rawSignIn("bob");
    await swapCookie(context, stranger);
    const listed = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    expect(listed).toMatchObject({ ok: false, error: "auth_state" });
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "drift"),
      "a drift fence is recorded",
    );
    await untilView(page, "neutral", "1d");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "This browser is now signed in as a different account",
      }),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/bob/i);
  });
});

test.describe("I-08: password change", () => {
  test("204 with no Set-Cookie; the O14 fence password_changed; the person is asked to reconnect", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const { ACCOUNTS } = await import("./helpers");
    const { signIn } = await import("./helpers");
    expect((await signIn(page, "carol")).kind).toBe("settled");
    await untilView(page, "displaying");
    const seen: Array<{ path: string; status: number; setCookie: boolean }> =
      [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname.endsWith("/password"))
        seen.push({
          path: "/password",
          status: response.status(),
          setCookie: "set-cookie" in (await response.allHeaders()),
        });
    });
    const next = `${ACCOUNTS.carol.password}-changed`;
    // NOT_SENT (a hold or a closing write in force for a moment) counts no attempt: retry it as a queue would.
    const result = await page.evaluate(
      async (c) => {
        const call = () =>
          window.__s.operations.changePassword({
            current: c.password,
            next: c.next,
          });
        let last = await call();
        for (
          let i = 0;
          i < 40 && !last.ok && last.error === "not_sent";
          i += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          last = await call();
        }
        return last;
      },
      { password: ACCOUNTS.carol.password, next },
    );
    expect(result).toEqual({ ok: true, value: "changed" });
    expect(seen).toEqual([
      { path: "/password", status: 204, setCookie: false },
    ]);
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some(
            (f) =>
              f.kind === "invalid_session" && f.reason === "password_changed",
          ),
      "the password_changed fence is recorded",
    );
    await untilView(page, "neutral", "1b");
  });

  test("a WRONG current password: the observed status is recorded for the backend team, and the client fails closed", async ({
    context,
    provokes,
  }, testInfo) => {
    provokes(400, 401, 403, 422);
    const page = await bootHarness(context);
    const { signIn } = await import("./helpers");
    expect((await signIn(page, "erin")).kind).toBe("settled");
    // An ordinary request issued while the settlement's closing write is still finishing is NOT_SENT by design: wait to display.
    await untilView(page, "displaying");
    const calls: Array<{ status: number; body: string }> = [];
    page.on("response", (response) => {
      if (!new URL(response.url()).pathname.endsWith("/password")) return;
      const call = { status: response.status(), body: "" };
      calls.push(call);
      void response.text().then(
        (text) => {
          call.body = text;
        },
        () => undefined,
      );
    });
    const result = await page.evaluate(async () => {
      const call = () =>
        window.__s.operations.changePassword({
          current: "definitely-not-the-password",
          next: "another-password-1",
        });
      let last = await call();
      for (let i = 0; i < 40 && !last.ok && last.error === "not_sent"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await call();
      }
      return last;
    });
    await expect
      .poll(() => calls.length, {
        message: `no /password response; result was ${JSON.stringify(result)}`,
      })
      .toBeGreaterThan(0);
    testInfo.annotations.push({
      type: "observed",
      description: `POST /password with a wrong current password answered ${calls[0]?.status}: ${calls[0]?.body}`,
    });
    // Whatever the status, the outcome is either a refusal the person can retry or a fail-closed observation; never a silent success.
    expect(result.ok).toBe(false);
    expect([400, 401, 403, 422]).toContain(calls[0]?.status);
  });
});

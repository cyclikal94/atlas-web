import type { BrowserContext, Page } from "@playwright/test";
import {
  type CallAttempt,
  credentialMismatchObservations,
  type FirstObserverInput,
  isStampedPath,
  judgeFirstObserver,
  type KernelEvent,
  type PageAnswer,
} from "./first-observer";
import {
  bootHarness,
  expect,
  finishSignIn,
  proxy,
  type RawSession,
  type RecordsLike,
  raw,
  rawSignIn,
  records,
  signIn,
  startSignIn,
  swapCookie,
  test,
  untilHeld,
  untilRecord,
  untilView,
  view,
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

/**
 * I-05, corrected in WEB-08d revision 32 (review 33 R33-N1, family `i04-first-stamped-request-premise`). The original two cases
 * swapped the cookie and asserted that the explicit `listSessions()` answers `auth_state`, which assumed it is the first stamped
 * request to meet the swapped cookie. The page's own readers can be first (review 33, WebKit: `/defaults/snapshot` and `/daily`
 * answered 403 `credential_mismatch`, the observation closed admission, and the list call was refused `closed` without being sent;
 * its drift, card and no-name assertions never ran). Both orders are correct, so each is now FORCED, and each outcome is judged
 * with its evidence (first-observer.ts), never by the error string alone:
 *
 * - "the list call observes first": every other stamped answer is held at the proxy after the backend answered it, so the list
 *   call's own 403 is the first the page can observe: it answers `auth_state` (the original assertion, now a fact of the schedule);
 * - "a competing read observes first": a read the test starts (a second `listSessions()`, or the stamped client's
 *   `GET /defaults/snapshot`, the reader that observed first in review 33) is answered, classified and durably recorded before the
 *   list call is made: the list call is refused `closed`, unsent.
 *
 * Every original assertion is kept in every schedule: the held verification, `credential_unverified` and the neutral card while it
 * is outstanding; for the same account the fence clears, the session id and token refresh (a later stamped read now succeeds) and
 * the account is shown again; for another account the drift fence, card 1d and no account name. The schedules rest on what the
 * harness page's `/today` composition reads after display (diagnostic, all three engines: `/me`, one `/defaults/snapshot`, two
 * `/daily`, no `/sessions`); the witness checks that no other caller used the routes left free, so a change there fails loudly.
 */
test.describe("I-05: credential_mismatch", () => {
  const API_ROOT = "/api/experimental/v1";
  /** Alice, settled and displayed in a harness page. */
  const signedIn = async (context: BrowserContext) => {
    const page = await bootHarness(context);
    expect((await signIn(page, "alice")).kind).toBe("settled");
    await untilView(page, "displaying");
    return page;
  };
  const traceOf = (page: Page) =>
    page.evaluate(() => window.__atlasFixture?.session?.trace ?? []) as Promise<
      KernelEvent[]
    >;

  /**
   * Armed AFTER the raw sign-in (its own identity read must not be held) and before the swap. `check`: every browser identity read
   * (the mismatch's verification) is held, so the fence and card can be asserted while it is outstanding. `others`: every other
   * stamped answer, except on the `free` routes, is held after the backend answered it, so no reader the test did not start can
   * observe the swapped cookie first. `others` is released as soon as the first observer has been judged (`judge`): a held answer
   * keeps its connection, and an engine opens six per host, so answers held for the rest of the test starve later requests (seen
   * in WebKit, revision 32 diagnostic d4: seven held answers, and the next request was never sent). For the same reason the page's
   * own reads that have already reached the proxy are first answered, so arming holds none of them.
   */
  const arm = async (free: string[]) => {
    await expect
      .poll(
        async () =>
          (await proxy.log())
            .filter(
              (entry) =>
                isStampedPath(entry.path) &&
                !entry.events.some((e) => e.event === "delivered"),
            )
            .map((entry) => `${entry.method} ${entry.path}`),
        {
          message: "every stamped request that reached the proxy is answered",
          timeout: 15_000,
        },
      )
      .toEqual([]);
    const check = await proxy.addRule({
      method: "GET",
      path: `${API_ROOT}/browser-sessions/current`,
      action: "hold",
    });
    const others = await proxy.addRule({
      path: `/^${API_ROOT}/(?!(?:browser-sessions(?:/|$)|health$${free
        .map((route) => `|${route}$`)
        .join("")})).+$/`,
      action: "hold",
    });
    return { check: check.id, others: others.id };
  };

  interface Cut {
    token: string;
    trace: number;
    wire: number;
    account: string;
    epoch: number;
    answers: PageAnswer[];
    reading: Promise<void>[];
  }
  /** The cut, taken immediately before the cookie swap: the document's token, its trace length, the proxy's last arrival. */
  const cutHere = async (page: Page): Promise<Cut> => {
    const answers: PageAnswer[] = [];
    const reading: Promise<void>[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith(`${API_ROOT}/`)) return;
      const answer: PageAnswer = {
        method: response.request().method(),
        path: `${url.pathname}${url.search}`,
        status: response.status(),
        code: null,
      };
      answers.push(answer);
      if (response.status() >= 400)
        reading.push(
          response.json().then(
            (body: { code?: unknown } | null) => {
              answer.code = typeof body?.code === "string" ? body.code : null;
            },
            () => undefined,
          ),
        );
    });
    const at = await page.evaluate(() => {
      const token = crypto.randomUUID();
      window.__t.i05 = token;
      const identity = window.__s.identity.get();
      return {
        token,
        trace: window.__atlasFixture?.session?.trace.length ?? -1,
        account: identity?.account_id ?? "",
        epoch: identity?.epoch ?? -1,
      };
    });
    const wire = Math.max(0, ...(await proxy.log()).map((entry) => entry.id));
    answers.length = 0;
    return { ...at, wire, answers, reading };
  };

  /** The explicit call: `listSessions()` retried while NOT_SENT exactly as `__retry`, recording each attempt's kernel activity. */
  const listWitnessed = (page: Page) =>
    page.evaluate(async () => {
      const trace = window.__atlasFixture?.session?.trace ?? [];
      const attempts: CallAttempt[] = [];
      const once = async () => {
        const from = trace.length;
        const pending = window.__s.operations.listSessions();
        // `send` creates the activity in its first statement, synchronously inside this call.
        const created = trace
          .slice(from)
          .find((entry) => entry.event === "activity.create");
        const result = await pending;
        attempts.push({
          n: typeof created?.data?.n === "number" ? created.data.n : null,
          result: result.ok ? { ok: true } : { ok: false, error: result.error },
        });
        return result;
      };
      let last = await once();
      for (let i = 1; i < 60 && !last.ok && last.error === "not_sent"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await once();
      }
      return attempts;
    });

  /** Starts the competing read (one attempt, not awaited) and answers its kernel activity. */
  const startCompetitor = (page: Page, kind: "list" | "typed") =>
    page.evaluate((which) => {
      const trace = window.__atlasFixture?.session?.trace ?? [];
      const identity = window.__s.identity.get();
      if (!identity)
        throw new Error("setup: no identity at the competing read");
      const from = trace.length;
      const pending: Promise<{ ok: boolean; error?: string }> =
        which === "list"
          ? window.__s.operations
              .listSessions()
              .then((r) =>
                r.ok ? { ok: true } : { ok: false, error: r.error },
              )
          : window.__s.api
              .fetchFor(
                "ordinary",
                identity.account_id,
                identity.epoch,
              )(
                new Request(
                  `${location.origin}/api/experimental/v1/defaults/snapshot`,
                ),
              )
              .then(
                () => ({ ok: true }),
                (error: { kind?: string }) => ({
                  ok: false,
                  error: error?.kind ?? String(error),
                }),
              );
      const created = trace
        .slice(from)
        .find((entry) => entry.event === "activity.create");
      window.__t.competitor = pending;
      return typeof created?.data?.n === "number" ? created.data.n : null;
    }, kind);
  const competitorResult = (page: Page) =>
    page.evaluate(
      () => window.__t.competitor as Promise<{ ok: boolean; error?: string }>,
    );

  /** Judges the first observer, then releases `others`: the order is established, and nothing later depends on the hold. */
  const judge = async (
    page: Page,
    cut: Cut,
    others: string,
    call: CallAttempt[],
    exclusive: NonNullable<FirstObserverInput["exclusive"]>,
  ) => {
    await Promise.all(cut.reading);
    const verdict = judgeFirstObserver({
      identity: { account: cut.account, epoch: cut.epoch },
      document: {
        atCut: cut.token,
        atJudgement: await page.evaluate(
          () => (window.__t?.i05 as string | undefined) ?? null,
        ),
      },
      trace: await traceOf(page),
      cut: cut.trace,
      call,
      wire: await proxy.log(),
      wireCut: cut.wire,
      answers: cut.answers,
      exclusive,
    });
    await proxy.removeRule(others);
    await proxy.release(others);
    expect(verdict.problems, "the first-observer witness").toEqual([]);
    return verdict;
  };

  /** The verification held at the proxy is this document's: issued after the cut, after the observation it verifies. */
  const verificationHeld = async (
    page: Page,
    cut: Cut,
    rule: string,
    after: number,
  ) => {
    await untilHeld(rule);
    expect(
      (await proxy.log()).some(
        (entry) =>
          entry.id > cut.wire &&
          entry.rule === rule &&
          entry.events.some((e) => e.event === "held"),
      ),
      "the held identity read arrived after the cut",
    ).toBe(true);
    const trace = await traceOf(page);
    expect(
      trace
        .slice(after)
        .some(
          (entry) =>
            entry.event === "request.issued" &&
            entry.data?.klass === "verification",
        ),
      "the page issued a verification after the observation",
    ).toBe(true);
  };
  const releaseCheck = async (rule: string) => {
    await proxy.removeRule(rule);
    await proxy.release(rule);
  };
  const fenceKinds = async (page: Page) =>
    Object.values((await records(page)).auth_state.fences)
      .flat()
      .map((f) => f.kind);

  /** While the check is outstanding the account is closed durably: credential_unverified, and the neutral card. */
  const closedWhileChecking = async (page: Page) => {
    expect(await fenceKinds(page)).toContain("credential_unverified");
    await untilView(page, "neutral");
    expect(await page.evaluate(() => window.__s.view.get())).toMatchObject({
      state: expect.stringMatching(/^1e\.session_/),
    });
  };
  /** The check says: same account. The fence clears, the session id and token refresh, and the account is shown again. */
  const sameAccountRecovers = async (
    page: Page,
    rule: string,
    before: RecordsLike["auth_state"]["settled"],
    other: RawSession,
  ) => {
    await releaseCheck(rule);
    await untilRecord(
      page,
      (s) => Object.keys(s.fences).length === 0,
      "the credential_unverified fence clears",
    );
    const after = (await records(page)).auth_state.settled;
    expect(after?.account_id).toBe(before?.account_id);
    expect(after?.session_id).toBe(other.sessionId);
    await untilView(page, "displaying");
    // The refreshed token works with the new cookie: a stamped read is answered (`/sessions` is not held).
    expect(
      await page.evaluate(() =>
        window.__retry(() => window.__s.operations.listSessions()),
      ),
    ).toMatchObject({ ok: true });
  };
  /** The check says: another account. Drift, the display stays closed, the card names the different account without naming it. */
  const otherAccountDrifts = async (page: Page, rule: string) => {
    await releaseCheck(rule);
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
  };
  const listRoute = `${API_ROOT}/sessions`;

  test("session A's CSRF token with session B's cookie of the SAME account: 403 credential_mismatch, recorded durably, verified, cleared, tokens refreshed", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await signedIn(context);
    const before = (await records(page)).auth_state.settled;
    const other = await rawSignIn("alice");
    const rules = await arm(["sessions"]);
    const cut = await cutHere(page);
    await swapCookie(context, other);
    // The list call observes first: its own 403 is the only stamped answer the page can receive.
    const listed = await listWitnessed(page);
    expect(listed.at(-1)?.result).toMatchObject({
      ok: false,
      error: "auth_state",
    });
    const verdict = await judge(page, cut, rules.others, listed, [
      { method: "GET", path: listRoute, calls: [listed] },
    ]);
    expect(verdict.observer).toBe("self");
    expect(
      verdict.first?.n,
      "the list call's own answer is observed first",
    ).toBe(listed.at(-1)?.n);
    await verificationHeld(
      page,
      cut,
      rules.check,
      verdict.first?.classified ?? 0,
    );
    await closedWhileChecking(page);
    await sameAccountRecovers(page, rules.check, before, other);
  });

  test("I-05 SAME account, a competing read observes first: the list call is refused closed, unsent, after the recorded observation; verified, cleared, tokens refreshed", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await signedIn(context);
    const before = (await records(page)).auth_state.settled;
    const other = await rawSignIn("alice");
    const rules = await arm(["sessions"]);
    const cut = await cutHere(page);
    await swapCookie(context, other);
    // Another invocation of the SAME route observes first: the route does not identify the caller, the activity does.
    const competitor = await startCompetitor(page, "list");
    expect(competitor, "the competing read created an activity").not.toBeNull();
    await expect
      .poll(
        async () =>
          credentialMismatchObservations(
            await traceOf(page),
            cut.trace,
            cut,
          ).some((o) => o.n === competitor && o.recorded !== null),
        {
          message:
            "the competing read's own credential_mismatch observation is durably recorded",
          timeout: 15_000,
        },
      )
      .toBe(true);
    const listed = await listWitnessed(page);
    expect(listed.at(-1)?.result).toEqual({ ok: false, error: "closed" });
    const raced = await competitorResult(page);
    expect(raced).toEqual({ ok: false, error: "auth_state" });
    const verdict = await judge(page, cut, rules.others, listed, [
      {
        method: "GET",
        path: listRoute,
        calls: [listed, [{ n: competitor, result: raced }]],
      },
    ]);
    expect(verdict.observer).toBe("other");
    expect(verdict.witness?.n).toBe(competitor);
    expect(verdict.first?.n).toBe(competitor);
    await verificationHeld(
      page,
      cut,
      rules.check,
      verdict.first?.classified ?? 0,
    );
    await closedWhileChecking(page);
    await sameAccountRecovers(page, rules.check, before, other);
  });

  test("session B belongs to ANOTHER account: the check adds drift, the display stays closed, the card names the different account without naming it", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await signedIn(context);
    const stranger = await rawSignIn("bob");
    const rules = await arm(["sessions"]);
    const cut = await cutHere(page);
    await swapCookie(context, stranger);
    const listed = await listWitnessed(page);
    expect(listed.at(-1)?.result).toMatchObject({
      ok: false,
      error: "auth_state",
    });
    const verdict = await judge(page, cut, rules.others, listed, [
      { method: "GET", path: listRoute, calls: [listed] },
    ]);
    expect(verdict.observer).toBe("self");
    expect(
      verdict.first?.n,
      "the list call's own answer is observed first",
    ).toBe(listed.at(-1)?.n);
    await verificationHeld(
      page,
      cut,
      rules.check,
      verdict.first?.classified ?? 0,
    );
    await closedWhileChecking(page);
    await otherAccountDrifts(page, rules.check);
  });

  test("I-05 ANOTHER account, the stamped client's /defaults/snapshot observes first (review 33's order): the list call is refused closed, unsent; drift, card 1d, no account name", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await signedIn(context);
    // The page's own first /defaults/snapshot read (one per display, diagnostic) has been answered, so after the cut that route is
    // the competing read's alone (the witness checks it).
    await expect
      .poll(
        async () =>
          (await proxy.log()).some(
            (entry) =>
              entry.method === "GET" &&
              entry.path.split("?")[0] === `${API_ROOT}/defaults/snapshot` &&
              entry.events.some(
                (e) => e.event === "delivered" && e.status === 200,
              ),
          ),
        {
          message: "the page's own /defaults/snapshot read is answered",
          timeout: 15_000,
        },
      )
      .toBe(true);
    const stranger = await rawSignIn("bob");
    const rules = await arm(["sessions", "defaults/snapshot"]);
    const cut = await cutHere(page);
    await swapCookie(context, stranger);
    const competitor = await startCompetitor(page, "typed");
    expect(competitor, "the competing read created an activity").not.toBeNull();
    await expect
      .poll(
        async () =>
          credentialMismatchObservations(
            await traceOf(page),
            cut.trace,
            cut,
          ).some((o) => o.n === competitor && o.recorded !== null),
        {
          message:
            "the competing read's own credential_mismatch observation is durably recorded",
          timeout: 15_000,
        },
      )
      .toBe(true);
    const listed = await listWitnessed(page);
    expect(listed.at(-1)?.result).toEqual({ ok: false, error: "closed" });
    const raced = await competitorResult(page);
    expect(raced).toEqual({ ok: false, error: "auth_state" });
    const verdict = await judge(page, cut, rules.others, listed, [
      { method: "GET", path: listRoute, calls: [listed] },
      {
        method: "GET",
        path: `${API_ROOT}/defaults/snapshot`,
        calls: [[{ n: competitor, result: raced }]],
      },
    ]);
    expect(verdict.observer).toBe("other");
    expect(verdict.witness?.n).toBe(competitor);
    expect(verdict.first?.n).toBe(competitor);
    await verificationHeld(
      page,
      cut,
      rules.check,
      verdict.first?.classified ?? 0,
    );
    await closedWhileChecking(page);
    await otherAccountDrifts(page, rules.check);
  });

  test("I-05 control: the same schedule with the cookie UNCHANGED lists normally; nothing is observed, fenced or verified", async ({
    context,
  }) => {
    const page = await signedIn(context);
    const rules = await arm(["sessions"]);
    const cut = await cutHere(page);
    const listed = await listWitnessed(page);
    expect(listed.at(-1)?.result).toEqual({ ok: true });
    await Promise.all(cut.reading);
    expect(
      credentialMismatchObservations(await traceOf(page), cut.trace, cut),
    ).toEqual([]);
    expect(
      cut.answers.filter((answer) => answer.status >= 400),
      "no refused answer",
    ).toEqual([]);
    expect(await fenceKinds(page)).toEqual([]);
    expect((await proxy.held())[rules.check] ?? 0).toBe(0);
    expect(await view(page)).toMatchObject({ kind: "displaying" });
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

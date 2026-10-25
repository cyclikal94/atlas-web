import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import {
  ageSharedConfirmation,
  sharedConfirmationAge,
} from "../e2e/shared-confirmation";
import {
  bootHarness,
  expect,
  finishSignIn,
  type ProxyLogEntry,
  proxy,
  raw,
  rawSignIn,
  records,
  type SettledLike,
  setVisibility,
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

const V1 = "/api/experimental/v1";
const CURRENT = `${V1}/browser-sessions/current`;
const ME = `${V1}/me`;
const SESSIONS = `${V1}/sessions`;
/**
 * WEB-14a revision 36: the shell merged with accepted WEB-10a shows Today at `/`, whose readers ask for the day (`/daily`, joint and
 * personal: the proxy matches the path, so one gate holds both) and the defaults snapshot as soon as the display lifts. They are
 * background readers like `/me`: an undelivered gate keeps their answers (a 401 with a revoked cookie) from closing the display before
 * the schedule's chosen order. Found by the revision-36 qualification (I-04 "list first": the list was `closed`, not `auth_state`).
 */
const TODAY_READERS = [`${V1}/daily`, `${V1}/defaults/snapshot`];
/**
 * Every endpoint a fresh I-04 page reaches (WEB-14a revision 18, review R25). After settlement the production composition reads `/me`
 * (the profile source) and, once the schedule has made it eligible (revision 35, below), `/browser-sessions/current` (the resume
 * verification); nothing else in this boundary reads with the new cookie: the device mirror needs an open account database (none
 * exists in a fresh context), the sharing defaults are read on demand, no settings screen is mounted, and the harness starts no
 * production leader. A change that adds a reader fails the inventory assertion instead of silently deciding which request sees the
 * dead cookie first. Revision 36: the merge of accepted WEB-10a added Today's readers (`TODAY_READERS`, above), which this inventory
 * found; they are listed here and held by the schedule like `/me`.
 */
const I04_ENDPOINTS = new Set([
  "/health",
  `${V1}/browser-sessions`,
  `${V1}/browser-sessions/activate`,
  `${V1}/browser-sessions/activate/cancel`,
  CURRENT,
  ME,
  SESSIONS,
  ...TODAY_READERS,
]);
/** The proxy events after which a response can no longer reach the page. */
const FINAL = new Set([
  "delivered",
  "client_gone",
  "upstream_error",
  "dropped",
]);
const pathOf = (entry: ProxyLogEntry) =>
  new URL(entry.path, "http://x").pathname;
const deliveredTo = (entry: ProxyLogEntry) =>
  entry.events.some((e) => e.event === "delivered");

interface TraceEvent {
  at: number;
  event: string;
  data?: Record<string, unknown>;
}
const traceOf = (page: Page) =>
  page.evaluate(
    () => (window.__atlasFixture?.session?.trace ?? []) as TraceEvent[],
  );

/**
 * The response gates of one I-04 schedule. A gate holds EVERY response of one background reader (no ordinal: a repeated read is
 * held too). The proxy forwards each request, so the backend answers it, and holds the answer until the test opens the gate. A
 * response the page never received cannot have told it anything. Opening a gate removes its rule, then releases until every response
 * the rule had claimed has reached its client, including one that was still upstream when the rule went.
 */
function responseGates() {
  const rules = new Map<string, string>();
  const settle = async (ids: string[]): Promise<string | null> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      for (const id of ids) await proxy.release(id);
      const pending = (await proxy.log()).filter(
        (e) =>
          e.rule !== undefined &&
          ids.includes(e.rule) &&
          !e.events.some((x) => FINAL.has(x.event)),
      );
      if (pending.length === 0) return null;
      if (Date.now() > deadline)
        return `${pending.length} gated response(s) never reached their client: ${pending.map(pathOf).join(", ")}`;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const idOf = (path: string): string => {
    const id = rules.get(path);
    if (id === undefined) throw new Error(`no gate holds ${path}`);
    return id;
  };
  return {
    async hold(path: string): Promise<string> {
      const { id } = await proxy.addRule({
        method: "GET",
        path,
        action: "hold",
      });
      rules.set(path, id);
      return id;
    },
    id: idOf,
    async open(path: string): Promise<void> {
      const id = idOf(path);
      rules.delete(path);
      await proxy.removeRule(id);
      const left = await settle([id]);
      if (left !== null) throw new Error(left);
    },
    /** Open every gate still closed. Null when everything was delivered, otherwise what was left (the caller fails on it). */
    async drain(): Promise<string | null> {
      const ids = [...rules.values()];
      rules.clear();
      for (const id of ids) await proxy.removeRule(id);
      return ids.length === 0 ? null : settle(ids);
    },
  };
}

/** Wait until the page has taken a gated answer, as its kernel traced it after `mark` (the length of the trace before the gate opened). */
async function untilTaken(
  page: Page,
  mark: number,
  taken: (event: TraceEvent) => boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => (await traceOf(page)).slice(mark).some(taken), {
      message,
      timeout: 15_000,
    })
    .toBe(true);
}

/** What the first reader of the dead cookie must have recorded: an ordinary request's 401 or the verification's. */
const FENCE_REASON = {
  list: "unauthenticated",
  verification: "current_401",
  profile: "unauthenticated",
} as const;
type First = keyof typeof FENCE_REASON;

/** The I-04 boundary: one fresh page on Today, nothing settled, no fence, no deletion, no production leader. */
async function expectFreshBoundary(context: BrowserContext, page: Page) {
  // The test fixture's own page is never navigated; no other tab of the app exists.
  expect(
    context
      .pages()
      .filter((other) => other !== page)
      .map((other) => other.url()),
  ).toEqual(["about:blank"]);
  expect(await page.evaluate(() => location.pathname)).toBe("/today");
  const state = await records(page);
  expect(state.auth_state.settled).toBeNull();
  expect(state.auth_state.attempt).toBeNull();
  expect(state.auth_state.fences).toEqual({});
  expect(state.pending_deletions).toEqual({});
  expect(
    await page.evaluate(() => window.__atlasFixture?.session?.leader().role),
  ).toBe("none");
}

/**
 * One schedule: the activation's answer is held after the backend created the session; when `revoked`, the attempt is cancelled
 * with its verifier (the backend revokes that session) before the late 200 delivers its cookie. Both background readers are gated
 * from before the cookie exists, so which one (or the explicit list) sees the server's answer first is the test's choice, `first`.
 *
 * WEB-14a revision 35 (review R38, family `integration-late-activation-observation-ordering`, classification `regression` of the
 * maintained premise; design assessment C2): the settlement no longer starts the resume verification. Since
 * HF1-SHARED-CONFIRMATION-20261013 it writes a shared confirmation of exactly the settled session, and while that is less than the
 * interval (30 s) old a displaying page makes no `/browser-sessions/current` read (src/session/session.ts `confirmedRecently`: the
 * accepted behaviour, kept). The schedule therefore establishes the read it gates, in the SAME document (a reload would orphan the held
 * `/me` and load the app route without the harness bridge):
 *  1. it observes the premise: the page displays, `/me` is held, the confirmation is fresh and no verification was issued;
 *  2. it ages only the confirmation's time (tests/e2e/shared-confirmation.ts: checked transaction, token and every other field kept);
 *  3. it re-checks that no other writer refreshed it, then hides and re-exposes the page (`setVisibility`: the labelled synthetic
 *     visibility lifecycle of docs/browser-support.md). The lift's evaluation reads the aged record and the display's publication
 *     asks for the verification. This premise holds only because this fresh document has never made or attempted a verification
 *     (the fresh confirmation returned before `lastVerifiedAt` was set), which step 1 shows;
 *  4. it waits for the real verification request, its lease and the proxy's held answer before any response is chosen.
 * Each step that fails is a setup failure named as such; nothing is retried and no bound changed.
 */
async function lateActivation(
  page: Page,
  gates: ReturnType<typeof responseGates>,
  first: First,
  revoked: boolean,
) {
  const activation = await proxy.addRule({
    method: "POST",
    path: `${V1}/browser-sessions/activate`,
    action: "hold",
    ordinal: 1,
  });
  await gates.hold(CURRENT);
  await gates.hold(ME);
  for (const path of TODAY_READERS) await gates.hold(path);
  // The backend redeems the grant and creates a session; the proxy holds the answer.
  await startSignIn(page, "alice");
  await untilHeld(activation.id);
  if (revoked) {
    // Meanwhile the attempt is cancelled by someone holding the verifier (another window's resolution): the backend revokes the session.
    const verifier = (await records(page)).auth_state.attempt?.verifier;
    expect(verifier).toMatch(/\S{43}/);
    const cancelled = await raw("POST", "/browser-sessions/activate/cancel", {
      body: { verifier },
    });
    expect(cancelled.json).toEqual({ result: "session_revoked" });
  }
  // The late answer arrives: a 200 whose cookie is for a session that is already dead when `revoked`.
  await proxy.release(activation.id);
  expect((await finishSignIn(page)).kind).toBe("settled");
  const settled = (await records(page)).auth_state.settled as SettledLike;
  const account = settled?.account_id;
  expect(account).toBeTruthy();
  // Revision 35 (R38), step 1: settlement starts the profile reader, whose answer is held; it does NOT start the resume verification.
  await untilHeld(gates.id(ME));
  await untilView(page, "displaying");
  const verificationsIssued = (events: TraceEvent[]) =>
    events.filter(
      (e) => e.event === "request.issued" && e.data?.klass === "verification",
    );
  expect(
    await sharedConfirmationAge(page, settled),
    "setup: the settlement's shared confirmation is fresh (the premise)",
  ).toMatchObject({
    settlement_matched: true,
    confirmation_matched: true,
    eligible: false,
  });
  expect(
    verificationsIssued(await traceOf(page)),
    "setup: this document has made no verification (the fresh confirmation spared it)",
  ).toEqual([]);
  expect(
    (await proxy.log()).filter((e) => pathOf(e) === CURRENT),
    "setup: no identity read reached the proxy",
  ).toEqual([]);
  // Step 2: only the confirmation's time is rewritten.
  expect(await ageSharedConfirmation(page, settled)).toMatchObject({
    aged: true,
    other_fields_unchanged: true,
  });
  // Step 3: still aged (no other writer), then the display is gated and lifted in this same document.
  expect(
    (await sharedConfirmationAge(page, settled)).eligible,
    "setup: no other writer refreshed the confirmation before the lift",
  ).toBe(true);
  const liftMark = (await traceOf(page)).length;
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  // Step 4: the lift's own verification, issued once, leased, asked of the backend and held by the proxy.
  await expect
    .poll(
      async () => {
        const since = (await traceOf(page)).slice(liftMark);
        return {
          gated: since.some((e) => e.event === "gate.level0"),
          evaluated: since.some(
            (e) => e.event === "evaluate" && e.data?.reason === "visible",
          ),
          verifications: verificationsIssued(since).length,
        };
      },
      {
        message:
          "setup (R38): the lift re-evaluates the aged record and issues one verification",
        timeout: 15_000,
      },
    )
    .toEqual({ gated: true, evaluated: true, verifications: 1 });
  await untilHeld(gates.id(CURRENT));
  expect(
    Object.values((await records(page)).auth_state.leases).filter(
      (lease) =>
        lease.class === "verification" &&
        lease.account_id === account &&
        lease.epoch === settled.epoch,
    ),
    "the verification's own request lease is in the record",
  ).toHaveLength(1);
  expect(
    (await proxy.log()).filter((e) => pathOf(e) === CURRENT),
    "exactly one identity read reached the proxy",
  ).toHaveLength(1);
  // Each reader has asked, and the backend has answered, but neither answer has been delivered.
  const status = revoked ? 401 : 200;
  const background = (await proxy.log()).filter(
    (e) => [CURRENT, ME].includes(pathOf(e)) && e.status !== undefined,
  );
  expect(new Set(background.map(pathOf))).toEqual(new Set([CURRENT, ME]));
  for (const entry of background) {
    expect(entry.status, `${pathOf(entry)}: the backend's answer`).toBe(status);
    expect(deliveredTo(entry), `${pathOf(entry)} is still held`).toBe(false);
  }

  // The chosen background reader takes its answer first; with `revoked`, its 401 is recorded before the list is made.
  let held = [CURRENT, ME, ...TODAY_READERS];
  if (first !== "list") {
    const path = first === "verification" ? CURRENT : ME;
    held = held.filter((p) => p !== path);
    const mark = (await traceOf(page)).length;
    await gates.open(path);
    await untilTaken(
      page,
      mark,
      (e) =>
        first === "verification"
          ? e.event === "surrender" &&
            e.data?.klass === "verification" &&
            e.data?.status === status
          : revoked
            ? e.event === "surrender" &&
              e.data?.klass === "ordinary" &&
              e.data?.status === 401
            : e.event === "response.released" && e.data?.account === account,
      `the page takes the ${first === "verification" ? "/browser-sessions/current" : "/me"} answer`,
    );
    if (revoked)
      await untilRecord(
        page,
        (s) =>
          Object.values(s.fences)
            .flat()
            .some(
              (f) =>
                f.kind === "invalid_session" &&
                f.reason === FENCE_REASON[first],
            ),
        `the ${first} reader's 401 is recorded before the list is made`,
        15_000,
      );
  }

  // The explicit list, and only what it caused.
  const traceMark = (await traceOf(page)).length;
  const logMark = Math.max(0, ...(await proxy.log()).map((e) => e.id));
  const listed = await page.evaluate(() =>
    window.__retry(() => window.__s.operations.listSessions()),
  );
  const log = await proxy.log();
  const since = log.filter((e) => e.id > logMark);
  const traced = (await traceOf(page)).slice(traceMark);
  // A gate that is still closed has delivered nothing: the page cannot have learnt anything from it.
  for (const entry of log.filter((e) => held.includes(pathOf(e))))
    expect(deliveredTo(entry), `${pathOf(entry)} stayed held`).toBe(false);
  const sessions = since.filter((e) => pathOf(e) === SESSIONS);
  if (revoked && first !== "list") {
    // The account was fenced before the call: the cover refuses it and nothing is sent.
    expect(listed).toEqual({ ok: false, error: "closed" });
    expect(sessions).toEqual([]);
    expect(
      traced.filter(
        (e) => e.event === "request.issued" && e.data?.klass === "ordinary",
      ),
    ).toEqual([]);
  } else {
    // The exact outcome first, then the proof of it: the list's own request reached the backend and its answer reached the page.
    if (revoked) expect(listed).toEqual({ ok: false, error: "auth_state" });
    else expect(listed).toMatchObject({ ok: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe(status);
    expect(sessions[0] && deliveredTo(sessions[0])).toBe(true);
    if (revoked) {
      // It is the one invalidating answer the page took: an ordinary request it issued after the mark.
      const surrendered = traced.filter((e) => e.event === "surrender");
      expect(surrendered.map((e) => [e.data?.klass, e.data?.status])).toEqual([
        ["ordinary", 401],
      ]);
      expect(
        traced.some(
          (e) =>
            e.event === "request.issued" &&
            e.data?.n === surrendered[0]?.data?.n,
        ),
      ).toBe(true);
    } else {
      const rows = (
        listed as { value?: { sessions?: Array<{ current?: boolean }> } }
      ).value?.sessions;
      expect(rows?.filter((row) => row.current)).toHaveLength(1);
    }
  }

  if (revoked) {
    // One invalid-session fence, for this account and epoch, and it names the reader that saw the dead cookie first. Recording is
    // asynchronous to the answer (the hold comes first), so the durable record is waited for, within a deadline for missing progress.
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "an invalid_session fence is recorded",
      15_000,
    );
    const fences = Object.values((await records(page)).auth_state.fences)
      .flat()
      .filter((f) => f.kind === "invalid_session");
    expect(fences.map((f) => f.reason)).toEqual([FENCE_REASON[first]]);
    expect(Object.keys((await records(page)).auth_state.fences)).toEqual([
      account,
    ]);
    // The display closes; the card is "Reconnect to keep going".
    await untilView(page, "neutral", "1b");
    await expect(
      page.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible();
  } else {
    // The control: the same gates with a live cookie fence nothing, and the account is shown.
    expect(await gates.drain(), "every gated response is delivered").toBeNull();
    await untilView(page, "displaying");
    expect((await records(page)).auth_state.fences).toEqual({});
  }
  // Nothing was wiped and no data port was touched: no deletion record exists.
  expect((await records(page)).pending_deletions).toEqual({});
  // No reader outside the boundary asked anything, and the only /sessions request is the list's own.
  const inventory = await proxy.log();
  expect(inventory.map(pathOf).filter((p) => !I04_ENDPOINTS.has(p))).toEqual(
    [],
  );
  expect(inventory.filter((e) => pathOf(e) === SESSIONS)).toHaveLength(
    sessions.length,
  );
}

const I04_TITLES: Record<First, string> = {
  list: "list first: with /current and /me held, the explicit list's own 401 is auth_state",
  verification:
    "verification first: the /current 401 is recorded before the list, which is closed and sends nothing",
  profile:
    "profile first: the /me 401 is recorded before the list, which is closed and sends nothing",
};

test.describe("I-04: late activation after cancel (T8 at module level)", () => {
  for (const first of ["list", "verification", "profile"] as const)
    for (const revoked of [true, false])
      test(
        revoked
          ? `${I04_TITLES[first]}; the late cookie is dead, the fence is recorded, the reconnect card shows, nothing is wiped`
          : `live-cookie control, ${first} first: the same gates, the list succeeds and nothing is fenced`,
        async ({ context, provokes }, info: TestInfo) => {
          if (revoked) provokes(401);
          const page = await bootHarness(context);
          await expectFreshBoundary(context, page);
          const gates = responseGates();
          let left: string | null = null;
          try {
            await lateActivation(page, gates, first, revoked);
          } finally {
            // What the schedule saw, before any gate is opened: every request, the kernel's trace and the records.
            const seen = {
              first,
              revoked,
              requests: await proxy.log().catch(() => null),
              trace: await traceOf(page).catch(() => null),
              records: await records(page).catch(() => null),
            };
            await info.attach("i04-schedule", {
              body: JSON.stringify(seen, null, 1),
              contentType: "application/json",
            });
            left = await gates.drain();
            // And after: the gates are open, nothing they held is still on its way (also when the schedule failed).
            await info.attach("i04-gates", {
              body: JSON.stringify(
                { left, requests: await proxy.log().catch(() => null) },
                null,
                1,
              ),
              contentType: "application/json",
            });
          }
          expect(left, "every gated response reached its client").toBeNull();
        },
      );
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

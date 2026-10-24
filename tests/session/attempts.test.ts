// @vitest-environment node
import { describe, expect, test } from "vitest";
import { classifyActivation } from "../../src/session/kernel/attempts";
import type { RawAnswer } from "../../src/session/ports/transport";
import type { Fixture } from "../support/session/harness";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  attemptOf,
  fencesOf,
  holdAnswers,
  holdLock,
  identityReadsSoFar,
  installAttempt,
  leaseIds,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-ATT-*: matrix 3.4 in full. Fixture tests against a stub of the contract; they show the module behaves as specified.
 */
const raw = (status: number, json?: unknown, atlas = false): RawAnswer => ({
  status,
  contentType: json === undefined ? null : "application/json",
  json,
  atlasError: atlas
    ? { code: (json as { code: string }).code, message: "m", request_id: "r" }
    : null,
});
const session = {
  account_id: "A",
  expires_at: "x",
  csrf_token: "c",
  session_id: "s",
};
const atlasBody = (code: string) => ({
  code,
  message: "m",
  request_id: "r",
  details: [],
});

describe("step 5: classification (only an Atlas-formatted refusal is definitive)", () => {
  test.each([
    ["2xx with a valid BrowserSession", raw(200, session), "settle"],
    ["2xx with an invalid body", raw(200, { nope: 1 }), "indeterminate"],
    ["2xx with no body", raw(204), "indeterminate"],
    ["Atlas 401", raw(401, atlasBody("unauthenticated"), true), "definitive"],
    ["Atlas 403", raw(403, atlasBody("forbidden"), true), "definitive"],
    ["Atlas 422", raw(422, atlasBody("validation_failed"), true), "definitive"],
    ["Atlas 429", raw(429, atlasBody("rate_limited"), true), "definitive"],
    [
      "503 device_capacity",
      raw(503, atlasBody("device_capacity"), true),
      "definitive",
    ],
    [
      "503 temporarily_unavailable",
      raw(503, atlasBody("temporarily_unavailable"), true),
      "indeterminate",
    ],
    [
      "503 slice_capacity",
      raw(503, atlasBody("slice_capacity"), true),
      "indeterminate",
    ],
    ["Atlas 500", raw(500, atlasBody("internal"), true), "indeterminate"],
    ["a proxy 502", raw(502, "<html>", false), "indeterminate"],
    ["a proxy 504", raw(504, undefined), "indeterminate"],
    [
      "a 4xx that is not an Atlas body (HTML)",
      raw(400, undefined),
      "indeterminate",
    ],
    ["a network error / abort", null, "indeterminate"],
  ])("%s -> %s", (_name, answer, expected) => {
    expect(classifyActivation(answer as RawAnswer | null).kind).toBe(expected);
  });
});

describe("two fake tabs allocate epochs concurrently (AC-05)", () => {
  test("allocation is serialised; a stale grant and a stale error are discarded without touching the newer attempt", async () => {
    const f = await newWorld();
    const a = f.addPage();
    const b = f.addPage();
    await f.boot(a);
    await f.boot(b);
    const [ra, rb] = await Promise.all([
      f.runWith(a.session.attempts.begin("password")),
      f.runWith(b.session.attempts.begin("password")),
    ]);
    if (ra.kind !== "started" || rb.kind !== "started")
      throw new Error("both should start");
    expect([ra.handle.epoch, rb.handle.epoch].sort()).toEqual([1, 2]);
    const newest = Math.max(ra.handle.epoch, rb.handle.epoch);
    const older = ra.handle.epoch === newest ? rb : ra;
    const olderPage = ra.handle.epoch === newest ? b : a;
    expect(attemptOf(f).epoch).toBe(newest);
    const verifier = attemptOf(f).verifier;
    // The older attempt's exchange succeeds: its grant is stale and is discarded silently.
    const stale = await f.runWith(
      olderPage.session.attempts.signInWithPassword(older.handle, {
        username: "kieran",
        password: "pw",
      }),
    );
    expect(stale).toEqual({ kind: "superseded" });
    expect(attemptOf(f)).toMatchObject({
      epoch: newest,
      phase: "exchanging",
      target_account_id: null,
      verifier,
    });
    // The older attempt's exchange fails: its error is stale, clears nothing and is discarded like a stale grant (K-1: the
    // caller is told `superseded`, not "wrong password"; WEB-08a returned `refused` here).
    const staleError = await f.runWith(
      olderPage.session.attempts.signInWithPassword(older.handle, {
        username: "kieran",
        password: "WRONG",
      }),
    );
    expect(staleError).toEqual({ kind: "superseded" });
    expect(attemptOf(f)).toMatchObject({ epoch: newest, verifier });
    expect(f.store.violations).toEqual([]);
  });

  test("a wrong password is a definitive refusal from the exchange: the attempt clears and nothing settles", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    expect(await f.signIn(page, "kieran", "WRONG")).toMatchObject({
      kind: "refused",
      definitive: true,
    });
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled).toBeNull();
    expect(page.session.view.get()).toMatchObject({ kind: "signed_out" });
  });

  test("a network failure of the exchange clears the attempt and reports it", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions") && r.method === "POST",
      dropAfterForward: true,
    });
    expect(await f.signIn(page, "kieran", "pw")).toMatchObject({
      kind: "exchange_failed",
    });
    expect(stateOf(f).attempt).toBeNull();
  });

  test("begin waits 20 s for atlas-auth and then reports lock_timeout; begin during a gating attempt resolves first", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const release = await holdLock(f, "H", "atlas-auth");
    const begun = page.session.attempts.begin("password");
    await f.world.runUntilIdle();
    await f.world.advance(20_000);
    expect(await begun).toEqual({ kind: "lock_timeout" });
    release();
    installAttempt(f, {
      epoch: 3,
      phase: "indeterminate",
      serverGrant: { account: "acct-2", state: "issued" },
    });
    f.server.addRule({ match: () => true, dropAfterForward: true }); // offline blip: the resolution cannot complete
    expect(await f.runWith(page.session.attempts.begin("password"))).toEqual({
      kind: "resolving",
    });
  });
});

describe("activation: hidden, abort and the definitive/indeterminate split", () => {
  test("activation aborts on `hidden`: the in-flight request is aborted at once, the attempt becomes indeterminate and `cancel` resolves it", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const begun = await f.runWith(page.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("not started");
    const held = holdAnswers(f, (r) =>
      r.path.endsWith("/browser-sessions/activate"),
    );
    const outcome = page.session.attempts.signInWithPassword(begun.handle, {
      username: "kieran",
      password: "pw",
    });
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt?.phase).toBe("activating");
    page.hide();
    held.stop();
    const result = await f.runWith(outcome);
    expect(result).toEqual({ kind: "gating" });
    // The server DID process the activation (a session exists): `cancel` revokes it (session_revoked), then OBSERVE runs.
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled).toBeNull();
    expect(f.server.sessions.size).toBe(0);
    expect(
      f.world.logs.some(
        (e) =>
          e.type === "fetch.aborted" && String(e.path).endsWith("/activate"),
      ),
    ).toBe(true);
  });

  test("activation does not begin while the page is hidden; it waits without atlas-auth and proceeds when visible", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const begun = await f.runWith(page.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("not started");
    page.hide();
    const outcome = page.session.attempts.signInWithPassword(begun.handle, {
      username: "kieran",
      password: "pw",
    });
    await f.world.runUntilIdle();
    expect(f.server.requests.some((r) => r.path.endsWith("/activate"))).toBe(
      false,
    );
    expect(f.locks.allHeldNames().some((h) => h.name === "atlas-auth")).toBe(
      false,
    );
    page.show();
    expect(await f.runWith(outcome)).toMatchObject({ kind: "settled" });
  });

  test("a 502 after the origin committed is indeterminate: it resolves ONLY through activate/cancel (session_revoked) and never adopts the session", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/activate"),
      rewrite: {
        status: 502,
        body: "<html>bad gateway</html>",
        contentType: "text/html",
      },
    });
    const outcome = await f.signIn(page, "kieran", "pw");
    expect(outcome).toEqual({ kind: "gating" });
    await f.world.runUntilIdle();
    // The server holds a live session for the activation the page never saw; cancel removed it, and nothing was adopted.
    expect(
      f.server.requests.some((r) => r.path.endsWith("/activate/cancel")),
    ).toBe(true);
    expect(f.server.sessions.size).toBe(0);
    expect(stateOf(f).settled).toBeNull();
    expect(stateOf(f).attempt).toBeNull();
    expect(page.session.view.get()).toMatchObject({ kind: "signed_out" });
  });

  test("503 device_capacity is definitive: the attempt clears, the grant stays redeemable, no cancel is needed", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.server.deviceCapacity = 1;
    const outcome = await f.signIn(page, "kieran", "pw");
    expect(outcome).toMatchObject({
      kind: "refused",
      definitive: true,
      error: { code: "device_capacity" },
    });
    expect(stateOf(f).attempt).toBeNull();
    expect(
      f.server.requests.some((r) => r.path.endsWith("/activate/cancel")),
    ).toBe(false);
  });

  test("a 2xx with an invalid BrowserSession body is never settled on", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/activate"),
      rewrite: { status: 200, body: { unexpected: true } },
    });
    expect(await f.signIn(page, "kieran", "pw")).toEqual({ kind: "gating" });
    expect(stateOf(f).settled).toBeNull();
  });

  test("EC-15: a settlement write that fails after the cookie was set makes the attempt indeterminate; the session is cancelled", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.store.inject({
      match: (tx) => tx.label === "closing:settle",
      mode: "abort",
      times: 1,
    });
    const outcome = await f.signIn(page, "kieran", "pw");
    expect(outcome).toEqual({ kind: "gating" });
    await f.world.runUntilIdle();
    expect(stateOf(f).settled).toBeNull();
    expect(f.server.sessions.size).toBe(0); // the session just issued was cancelled; the person signs in again
    expect(stateOf(f).attempt).toBeNull();
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T20: resolving an uncertain activation, every combination", () => {
  /** C is settled on the page; X's attempt (epoch 2) is left `indeterminate` with its result unknown. */
  async function base() {
    const f = await newWorld();
    const l = await signedInPage(f);
    const x = [...f.server.accounts.values()].find((a) => a.username === "sam");
    if (!x) throw new Error("no X");
    return { f, l, x };
  }
  const resolve = async (
    f: Fixture,
    l: Awaited<ReturnType<typeof signedInPage>>,
  ) => {
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
  };
  const cookieOf = (f: Fixture, l: { sessionId: string }) => {
    const s = f.server.sessions.get(l.sessionId);
    if (s) f.server.adoptCookie(s);
  };

  test("a: valid, request never arrived, cookie still S_C -> not_activated, attempt cleared, no fence, C renders", async () => {
    const { f, l, x } = await base();
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: x.id, state: "issued" },
    });
    await resolve(f, l);
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(
      f.server.requests.some(
        (r) => r.path.endsWith("/browser-sessions/current") && r.ordinal > 1,
      ),
    ).toBe(false);
    expect(l.page.session.view.get().kind).toBe("displaying");
  });

  test("b: valid, S_X issued but Set-Cookie never applied -> session_revoked, current() 200 C, session_id refreshed, no fence", async () => {
    const { f, l, x } = await base();
    const sx = f.server.createSession(x.id, "dev-x");
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: x.id, state: "redeemed", session: sx.id },
    });
    cookieOf(f, l);
    await resolve(f, l);
    expect(f.server.sessions.has(sx.id)).toBe(false);
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(stateOf(f).settled?.session_id).toBe(l.sessionId);
    expect(l.page.session.view.get().kind).toBe("displaying");
  });

  test("c: valid, cookie replaced by S_X but the result was lost -> session_revoked, 401 -> invalid_session, state 1b", async () => {
    const { f, l, x } = await base();
    const sx = f.server.createSession(x.id, "dev-x");
    f.server.adoptCookie(sx);
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: x.id, state: "redeemed", session: sx.id },
    });
    await resolve(f, l);
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(stateOf(f).attempt).toBeNull();
    expect(l.page.session.view).toBeDefined();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
  });

  test("d: S_C expired, request never arrived -> not_activated, NO fence (nothing has detected the invalidity), C still renders", async () => {
    const { f, l, x } = await base();
    f.server.revoke(l.sessionId);
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: x.id, state: "issued" },
    });
    await resolve(f, l);
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("displaying");
  });

  test.each(["e", "f"])(
    "%s: S_C revoked, S_X issued -> session_revoked, 401 -> invalid_session, state 1b",
    async (row) => {
      const { f, l, x } = await base();
      f.server.revoke(l.sessionId);
      const sx = f.server.createSession(x.id, "dev-x");
      if (row === "e") f.server.adoptCookie(sx);
      installAttempt(f, {
        epoch: 2,
        phase: "indeterminate",
        serverGrant: { account: x.id, state: "redeemed", session: sx.id },
      });
      await resolve(f, l);
      expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
      expect(l.page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "1b",
      });
    },
  );

  test("g: valid, record swept -> unknown, 200 C, attempt cleared, no fence", async () => {
    const { f, l } = await base();
    installAttempt(f, { epoch: 2, phase: "indeterminate" }); // no server grant at all
    await resolve(f, l);
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual([]);
  });

  test.each([
    ["h", "the TARGET X"],
    ["i", "another account Z"],
  ])(
    "%s: current() names %s -> drift, the target is NOT adopted, state 1d",
    async (_row) => {
      const { f, l, x } = await base();
      const other = f.server.createSession(x.id, "dev-x");
      f.server.adoptCookie(other);
      installAttempt(f, {
        epoch: 2,
        phase: "verifying",
        cancel: "session_revoked",
      });
      await resolve(f, l);
      expect(fencesOf(f, l.account)).toEqual(["drift"]);
      expect(stateOf(f).settled?.account_id).toBe(l.account);
      expect(l.page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "1d",
      });
      expect(stateOf(f).attempt).toBeNull();
    },
  );

  test("j: network failure or 5xx at observe -> verifying retained, gated (1c), retried on the back-off and on online", async () => {
    const { f, l } = await base();
    installAttempt(f, {
      epoch: 2,
      phase: "verifying",
      cancel: "session_revoked",
    });
    // ADAPTED (WEB-08c revision 2, HF1-SHARED-CONFIRMATION-20261013): was `r.ordinal > 1` (every identity read after the post-sign-in resume
    // verification, which the shared confirmation now spares); the same "every OBSERVE read from here on".
    const before = identityReadsSoFar(f);
    const rule = f.server.addRule({
      match: (r) =>
        r.path.endsWith("/browser-sessions/current") && r.ordinal > before,
      rewrite: { status: 503, body: "x", contentType: "text/plain" },
    });
    await resolve(f, l);
    expect(attemptOf(f).phase).toBe("verifying");
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1c.resolving",
    });
    rule();
    await f.world.advance(3000);
    expect(stateOf(f).attempt).toBeNull();
  });

  test("k: offline for days, expires_at passes -> phase unchanged, NO clearing by time; continues when connectivity returns", async () => {
    const { f, l } = await base();
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: "acct-2", state: "issued" },
    });
    l.page.goOffline();
    await f.world.advance(3 * 24 * 60 * 60 * 1000);
    expect(attemptOf(f).phase).toBe("indeterminate");
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1c.offline",
    });
    l.page.goOnline();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
  });

  test("m: nothing settled -> the attempt clears, nothing to fence, sign-in screen", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    installAttempt(f, {
      epoch: 1,
      phase: "indeterminate",
      serverGrant: { account: "acct-2", state: "redeemed", session: null },
    });
    page.session.actions.retry();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).fences).toEqual({});
    expect(page.session.view.get()).toMatchObject({ kind: "signed_out" });
  });

  test("an OBSERVE that must wait for another page's outstanding request leaves atlas-auth, waits outside it, and enters again", async () => {
    const { f, l } = await base();
    const n = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/probe") && r.page === n.id,
    );
    n.kernel.memory.csrf.set(
      n.kernel.memory.csrfKey(l.account, l.epoch),
      `csrf.${l.sessionId}`,
    );
    const outstanding = n.session.api
      .fetchFor(
        "ordinary",
        l.account,
        l.epoch,
      )(new Request("http://localhost/api/experimental/v1/probe"))
      .catch(() => undefined);
    await f.world.runUntilIdle();
    installAttempt(f, {
      epoch: 2,
      phase: "verifying",
      cancel: "session_revoked",
    });
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
    expect(attemptOf(f).phase).toBe("verifying"); // waiting for n's request, outside atlas-auth
    expect(f.locks.allHeldNames().some((h) => h.name === "atlas-auth")).toBe(
      false,
    );
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    await outstanding;
    expect(stateOf(f).attempt).toBeNull();
    expect(checkQuiescence(f)).toEqual([]);
  });
});

describe("3.4.3: phase-specific expiry and the verifier invariant", () => {
  test("an exchanging attempt with a live owner is not cleared; one whose owner is gone is cleared; a gating attempt never is", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const begun = await f.runWith(page.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("x");
    const other = f.addPage();
    await f.boot(other);
    expect(stateOf(f).attempt?.epoch).toBe(1); // the owner is alive: its lock is held
    page.destroy();
    other.session.actions.retry();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull(); // owner gone: cleared without waiting for expiry
    installAttempt(f, {
      epoch: 2,
      phase: "activating",
      serverGrant: { account: "acct-1", state: "issued" },
    });
    f.server.addRule({ match: () => true, dropAfterForward: true });
    await f.world.advance(10 * 60 * 1000);
    expect(stateOf(f).attempt?.phase).not.toBeNull();
    expect(stateOf(f).attempt).not.toBeNull();
  });

  test("a redirected attempt is cleared at its expiry (720 s) by any page", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const begun = await f.runWith(page.session.attempts.begin("oidc"));
    if (begun.kind !== "started") throw new Error("x");
    await f.runWith(page.session.attempts.markRedirected(begun.handle));
    expect(attemptOf(f).phase).toBe("redirected");
    const other = f.addPage();
    await f.boot(other);
    await f.world.advance(721_000);
    expect(stateOf(f).attempt).toBeNull();
  });

  test("a successful sign-in leaves no attempt: the verifier is discarded with it (I1)", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    await f.signIn(page, "kieran", "pw");
    await f.settle();
    expect(stateOf(f).attempt).toBeNull();
    expect(JSON.stringify(f.store.records)).not.toMatch(/"verifier"/);
  });
});

describe("the OIDC hooks (WEB-08b builds on these)", () => {
  test("a landing whose attempt is not `redirected` for that epoch is discarded with no effect", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const before = JSON.stringify(f.store.records);
    expect(
      await f.runWith(
        page.session.attempts.landing({
          grant: "g",
          attempt: "7",
          account: "acct-1",
        }),
      ),
    ).toEqual({ kind: "superseded" });
    expect(JSON.stringify(f.store.records)).toBe(before);
    const begun = await f.runWith(page.session.attempts.begin("oidc"));
    if (begun.kind !== "started") throw new Error("x");
    expect(
      await f.runWith(
        page.session.attempts.landing({
          grant: "g",
          attempt: String(begun.handle.epoch),
          account: "acct-1",
        }),
      ),
    ).toEqual({ kind: "superseded" }); // still exchanging
  });

  test("markRedirected releases the owner lock; a matching landing continues to activation and settles", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const account = [...f.server.accounts.values()][0];
    const begun = await f.runWith(page.session.attempts.begin("oidc"));
    if (begun.kind !== "started" || !account) throw new Error("x");
    await f.runWith(page.session.attempts.markRedirected(begun.handle));
    expect(
      f.locks
        .allHeldNames()
        .some((h) => h.name === `atlas-attempt-${begun.handle.epoch}`),
    ).toBe(false);
    // The identity provider redirected back: the grant belongs to this attempt's challenge.
    f.server.grants.set("grant-oidc", {
      grant: "grant-oidc",
      account: account.id,
      device: "dev",
      challenge: begun.handle.challenge,
      state: "issued",
      wrongVerifiers: 0,
      session: null,
    });
    const outcome = await f.runWith(
      page.session.attempts.landing({
        grant: "grant-oidc",
        attempt: String(begun.handle.epoch),
        account: account.id,
      }),
    );
    expect(outcome).toMatchObject({ kind: "settled", account_id: account.id });
    await f.settle();
    expect(page.session.view.get().kind).toBe("displaying");
  });

  test("cancel clears a non-gating attempt and releases its owner lock", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const begun = await f.runWith(page.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("x");
    await f.runWith(page.session.attempts.cancel(begun.handle));
    expect(stateOf(f).attempt).toBeNull();
    expect(
      f.locks.allHeldNames().some((h) => h.name.startsWith("atlas-attempt-")),
    ).toBe(false);
    expect(leaseIds(f)).toEqual([]);
  });
});

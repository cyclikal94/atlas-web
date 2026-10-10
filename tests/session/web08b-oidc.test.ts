// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AttemptHandle } from "../../src/session/api";
import { LOCKS } from "../../src/session/constants";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  attemptOf,
  fencesOf,
  holdAnswers,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";
import { API } from "../support/session/server";

afterEach(() => vi.restoreAllMocks());

/**
 * F-OIDC-* and F-LAND-*: browser OIDC start, the redirect and the landing against a stub of the contract. The "provider"
 * is `StubServer.completeOidc`. Fixture evidence only; the stub provider of Layer C is `scripts/integration/oidc-provider.mjs`.
 */
async function begin(
  f: Fixture,
  page: FakePage,
  method: "oidc" | "oidc_link" | "password",
): Promise<AttemptHandle> {
  const begun = await f.runWith(page.session.attempts.begin(method));
  if (begun.kind !== "started") throw new Error("begin did not start");
  return begun.handle;
}

const fresh = async (f: Fixture) => {
  const page = f.addPage();
  await f.boot(page);
  return page;
};

describe("F-OIDC-1: the redirect is returned only after the attempt is durably `redirected`", () => {
  test("the record holds phase `redirected` and the verifier, and the owner lock is free, when `redirect` is returned", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    const verifier = attemptOf(f).verifier;
    // While the page is exchanging it owns `atlas-attempt-<epoch>`: it is not free.
    expect(
      await f.runWith(
        page.kernel.ports.locks.probe(LOCKS.attempt(handle.epoch)),
      ),
    ).toBe(false);
    const outcome = await f.runWith(page.session.attempts.startOidc(handle));
    expect(outcome).toMatchObject({ kind: "redirect" });
    expect(attemptOf(f)).toMatchObject({
      epoch: handle.epoch,
      method: "oidc",
      phase: "redirected",
      verifier,
    });
    expect(
      await f.runWith(
        page.kernel.ports.locks.probe(LOCKS.attempt(handle.epoch)),
      ),
    ).toBe(true);
    // The display is not gated by a `redirected` attempt, and nothing set a cookie.
    expect(page.session.view.get().kind).toBe("signed_out");
    expect(f.server.requests.some((r) => r.hadSetCookie)).toBe(false);
    expect(f.store.violations).toEqual([]);
  });

  test("the answer is held until the `redirected` transaction has completed: nothing is returned early", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    f.world.setKnob("D0", "unbounded", (meta) => meta.label === "redirected");
    let settled = false;
    const pending = page.session.attempts.startOidc(handle).then((value) => {
      settled = true;
      return value;
    });
    await f.world.runUntilIdle();
    expect(settled).toBe(false);
    f.world.release("D0");
    f.world.clearKnobs();
    const outcome = await f.runWith(pending);
    expect(outcome.kind).toBe("redirect");
    expect(attemptOf(f).phase).toBe("redirected");
  });

  test("a store failure while recording the redirect gives no redirect", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    f.store.inject({
      match: (tx) => tx.label === "redirected",
      mode: "error",
      times: 1,
    });
    const outcome = await f.runWith(page.session.attempts.startOidc(handle));
    expect(outcome).toEqual({ kind: "not_started", reason: "attempt_gone" });
    // The owner lock is released so a later page can clear the attempt.
    expect(
      await f.runWith(
        page.kernel.ports.locks.probe(LOCKS.attempt(handle.epoch)),
      ),
    ).toBe(true);
  });
});

describe("F-OIDC-2: the request body", () => {
  test("a sign-in sends link:false and a link sends link:true; attempt_id is the epoch as a string", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const signIn = await begin(f, l.page, "oidc");
    await f.runWith(l.page.session.attempts.startOidc(signIn));
    const link = await begin(f, l.page, "oidc_link");
    await f.runWith(l.page.session.attempts.startOidc(link));
    const sent = f.server.recordsFor(`${API}/oidc/start`);
    expect(sent).toHaveLength(2);
    const [first, second] = sent.map((r) => r.body as Record<string, unknown>);
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "attempt_challenge",
      "attempt_id",
      "device_id",
      "link",
    ]);
    expect(first).toMatchObject({
      link: false,
      attempt_id: String(signIn.epoch),
      attempt_challenge: signIn.challenge,
    });
    expect(second).toMatchObject({
      link: true,
      attempt_id: String(link.epoch),
    });
    expect(sent.some((r) => r.hadSetCookie)).toBe(false);
  });

  test("a handle for another method is refused with a TypeError and nothing is sent", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "password");
    await expect(page.session.attempts.startOidc(handle)).rejects.toThrow(
      TypeError,
    );
    expect(f.server.recordsFor(`${API}/oidc/start`)).toHaveLength(0);
  });
});

describe("F-OIDC-3: the authorisation URL is checked before anyone navigates to it", () => {
  test.each([
    ["a relative path", "/authorize"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["http to a remote host", "http://evil.example.test/a"],
    ["ftp", "ftp://idp.example.test/a"],
    ["not a string", 7],
    ["missing", undefined],
  ])(
    "%s is not followed: `exchange_failed`, the attempt clears",
    async (_name, url) => {
      const f = await newWorld();
      const page = await fresh(f);
      const handle = await begin(f, page, "oidc");
      f.server.addRule({
        match: ({ path }) => path.endsWith("/oidc/start"),
        rewrite: { status: 200, body: { authorization_url: url } },
        times: 1,
      });
      const outcome = await f.runWith(page.session.attempts.startOidc(handle));
      expect(outcome).toEqual({ kind: "exchange_failed", status: 200 });
      expect(stateOf(f).attempt).toBeNull();
    },
  );

  test.each([
    "https://idp.example.test/authorize?x=1",
    "http://127.0.0.1:9000/authorize",
    "http://localhost/authorize",
    "http://[::1]:9000/authorize",
  ])("%s is followed", async (url) => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    f.server.addRule({
      match: ({ path }) => path.endsWith("/oidc/start"),
      rewrite: { status: 200, body: { authorization_url: url } },
      times: 1,
    });
    const outcome = await f.runWith(page.session.attempts.startOidc(handle));
    expect(outcome).toMatchObject({ kind: "redirect" });
  });
});

describe("F-OIDC-4: a stale start never navigates (T3)", () => {
  test("a newer attempt exists: `superseded`, and the newer attempt is untouched", async () => {
    const f = await newWorld();
    const a = await fresh(f);
    const b = await fresh(f);
    const handleA = await begin(f, a, "oidc");
    const handleB = await begin(f, b, "password");
    expect(handleB.epoch).toBeGreaterThan(handleA.epoch);
    const before = structuredClone(attemptOf(f));
    const outcome = await f.runWith(a.session.attempts.startOidc(handleA));
    expect(outcome).toEqual({ kind: "superseded" });
    expect(attemptOf(f)).toEqual(before);
    expect(attemptOf(f).phase).toBe("exchanging");
  });

  test("a stale start that fails is also `superseded` (K-1), not a refusal", async () => {
    const f = await newWorld();
    f.server.oidcConfigured = false;
    const a = await fresh(f);
    const b = await fresh(f);
    const handleA = await begin(f, a, "oidc");
    await begin(f, b, "password");
    expect(await f.runWith(a.session.attempts.startOidc(handleA))).toEqual({
      kind: "superseded",
    });
  });
});

describe("F-OIDC-5: failures", () => {
  test("a server without OIDC answers 404 not_found: `refused`, the attempt clears", async () => {
    const f = await newWorld();
    f.server.oidcConfigured = false;
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    expect(
      await f.runWith(page.session.attempts.startOidc(handle)),
    ).toMatchObject({
      kind: "refused",
      status: 404,
      error: { code: "not_found" },
    });
    expect(stateOf(f).attempt).toBeNull();
  });

  test("a provider outage (502 oidc_unavailable with an Atlas body) is `refused` with its status", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    f.server.addRule({
      match: ({ path }) => path.endsWith("/oidc/start"),
      rewrite: {
        status: 502,
        body: {
          code: "oidc_unavailable",
          message: "m",
          request_id: "r",
          details: [],
        },
      },
      times: 1,
    });
    expect(
      await f.runWith(page.session.attempts.startOidc(handle)),
    ).toMatchObject({
      kind: "refused",
      status: 502,
      error: { code: "oidc_unavailable" },
    });
  });

  test("a gateway 502 with no Atlas body and a dropped request are `exchange_failed`", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    f.server.addRule({
      match: ({ path }) => path.endsWith("/oidc/start"),
      rewrite: { status: 502, body: "<html>", contentType: "text/html" },
      times: 1,
    });
    const first = await begin(f, page, "oidc");
    expect(await f.runWith(page.session.attempts.startOidc(first))).toEqual({
      kind: "exchange_failed",
      status: 502,
    });
    f.server.addRule({
      match: ({ path }) => path.endsWith("/oidc/start"),
      dropBeforeForward: true,
      times: 1,
    });
    const second = await begin(f, page, "oidc");
    expect(await f.runWith(page.session.attempts.startOidc(second))).toEqual({
      kind: "exchange_failed",
      status: null,
    });
    expect(stateOf(f).attempt).toBeNull();
  });

  test("a link start with a session older than five minutes is a 401 OBSERVATION: the session fails closed (state 1b), exactly as a password change's 401 does (D-8b-04 revised)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.world.time += 301_000;
    const handle = await begin(f, l.page, "oidc_link");
    expect(await f.runWith(l.page.session.attempts.startOidc(handle))).toEqual({
      kind: "session_ended",
    });
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
  });

  test("the link start is an ORDINARY stamped request: it carries the session's CSRF token and no login-family marker (found by Layer C: the released backend answers 403 without it)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const handle = await begin(f, l.page, "oidc_link");
    expect(
      await f.runWith(l.page.session.attempts.startOidc(handle)),
    ).toMatchObject({ kind: "redirect" });
    const [sent] = f.server.recordsFor(`${API}/oidc/start`);
    expect(sent?.headers["x-csrf-token"]).toBe(`csrf.${l.sessionId}`);
    expect(sent?.headers["x-atlas-session"]).toBeUndefined();
    // And the plain sign-in start carries neither: it has no session to authenticate.
    const other = await fresh(f);
    const plain = await begin(f, other, "oidc");
    await f.runWith(other.session.attempts.startOidc(plain));
    const starts = f.server.recordsFor(`${API}/oidc/start`);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.headers["x-csrf-token"]).toBeUndefined();
  });

  test("a link needs a settled session: nobody signed in is `not_started`, nothing is sent and the attempt clears", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc_link");
    expect(await f.runWith(page.session.attempts.startOidc(handle))).toEqual({
      kind: "not_started",
      reason: "not_settled",
    });
    expect(f.server.recordsFor(`${API}/oidc/start`)).toHaveLength(0);
    expect(stateOf(f).attempt).toBeNull();
  });

  test("a link start whose answer is lost is `exchange_failed`, the attempt clears and the person is still signed in", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.addRule({
      match: ({ path }) => path.endsWith("/oidc/start"),
      dropAfterForward: true,
      times: 1,
    });
    const handle = await begin(f, l.page, "oidc_link");
    expect(await f.runWith(l.page.session.attempts.startOidc(handle))).toEqual({
      kind: "exchange_failed",
      status: null,
    });
    expect(stateOf(f).attempt).toBeNull();
    expect(l.page.session.view.get()).toMatchObject({ kind: "displaying" });
  });

  test("a link start that moved on to a newer attempt is `superseded` and never navigates", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const rule = holdAnswers(f, (r) => r.path.endsWith("/oidc/start"));
    const handle = await begin(f, l.page, "oidc_link");
    const pending = l.page.session.attempts.startOidc(handle);
    await f.world.runUntilIdle();
    const other = await openPage(f);
    await begin(f, other, "password");
    rule.stop();
    rule.release();
    expect(await f.runWith(pending)).toEqual({ kind: "superseded" });
  });
});

describe("F-LAND-*: the landing", () => {
  const providerCompletes = (f: Fixture, subject: string) =>
    f.server.completeOidc(f.server.latestOidcFlow(), subject);

  test("F-LAND-1: a landing for the redirected epoch activates and settles with method `oidc`; only `activate` sets the cookie", async () => {
    const f = await newWorld();
    const first = await fresh(f);
    const handle = await begin(f, first, "oidc");
    await f.runWith(first.session.attempts.startOidc(handle));
    const account = [...f.server.accounts.values()][0];
    if (!account) throw new Error("no account");
    const fragment = providerCompletes(f, account.id);
    expect(fragment.attempt).toBe(String(handle.epoch));
    // The browser leaves the page and a NEW page loads at the origin: it has only the fragment and the durable record.
    first.destroy("commit");
    const landing = await fresh(f);
    const outcome = await f.runWith(landing.session.attempts.landing(fragment));
    expect(outcome).toMatchObject({
      kind: "settled",
      method: "oidc",
      account_id: account.id,
    });
    await f.settle();
    expect(landing.session.identity.get()?.account_id).toBe(account.id);
    expect(
      f.server.requests.filter((r) => r.hadSetCookie).map((r) => r.path),
    ).toEqual([`${API}/browser-sessions/activate`]);
    expect(stateOf(f).attempt).toBeNull();
  });

  test("F-LAND-5: the grant, the verifier and the provider URL's state never reach a log, the console or the durable record (EC-48)", async () => {
    const consoleCalls: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        consoleCalls.push(args.map((a) => JSON.stringify(a)).join(" "));
      });
    const f = await newWorld();
    const first = await fresh(f);
    const handle = await begin(f, first, "oidc");
    const verifier = attemptOf(f).verifier;
    const started = await f.runWith(first.session.attempts.startOidc(handle));
    if (started.kind !== "redirect") throw new Error("no redirect");
    const account = [...f.server.accounts.values()][0];
    if (!account) throw new Error("no account");
    const fragment = providerCompletes(f, account.id);
    first.destroy("commit");
    const landing = await fresh(f);
    expect(
      (await f.runWith(landing.session.attempts.landing(fragment))).kind,
    ).toBe("settled");
    await f.settle();
    const secrets = [fragment.grant, verifier, started.authorization_url];
    const emitted = f.world.logs.filter((e) => !e.type.startsWith("store."));
    const haystack = JSON.stringify(emitted) + consoleCalls.join("\n");
    for (const secret of secrets) expect(haystack).not.toContain(secret);
    const atRest = JSON.stringify(f.store.records);
    for (const secret of secrets) expect(atRest).not.toContain(secret);
  });

  test("F-LAND-2: a link landing settles with method `oidc_link` and the issuer is linked", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const handle = await begin(f, l.page, "oidc_link");
    await f.runWith(l.page.session.attempts.startOidc(handle));
    const fragment = providerCompletes(f, l.account);
    expect(f.server.accounts.get(l.account)?.oidcIssuers).toEqual([
      f.server.oidcIssuer,
    ]);
    const landing = await openPage(f);
    const outcome = await f.runWith(landing.session.attempts.landing(fragment));
    expect(outcome).toMatchObject({
      kind: "settled",
      method: "oidc_link",
      account_id: l.account,
    });
  });

  test("F-LAND-3: a landing whose epoch is not the latest is discarded: nothing changes, the grant is never redeemed", async () => {
    const f = await newWorld();
    const first = await fresh(f);
    const handle = await begin(f, first, "oidc");
    await f.runWith(first.session.attempts.startOidc(handle));
    const account = [...f.server.accounts.values()][0];
    if (!account) throw new Error("no account");
    const fragment = providerCompletes(f, account.id);
    // Another attempt starts and replaces the redirected one.
    const other = await openPage(f);
    const newer = await begin(f, other, "password");
    const before = structuredClone(attemptOf(f));
    const cookieBefore = f.server.cookie;
    const landing = await openPage(f);
    const outcome = await f.runWith(landing.session.attempts.landing(fragment));
    expect(outcome).toEqual({ kind: "superseded" });
    expect(attemptOf(f)).toEqual(before);
    expect(attemptOf(f).epoch).toBe(newer.epoch);
    expect(f.server.cookie).toBe(cookieBefore);
    expect(f.server.grants.get(fragment.grant)?.state).toBe("issued");
    expect(
      f.server.recordsFor(`${API}/browser-sessions/activate`),
    ).toHaveLength(0);
    expect(f.store.violations).toEqual([]);
  });

  test("F-LAND-4: a landing for an attempt that is not `redirected` (still exchanging) or that does not exist is discarded", async () => {
    const f = await newWorld();
    const page = await fresh(f);
    const handle = await begin(f, page, "oidc");
    const account = [...f.server.accounts.values()][0];
    if (!account) throw new Error("no account");
    const exchanging = {
      grant: "g".repeat(64),
      attempt: String(handle.epoch),
      account: account.id,
    };
    expect(await f.runWith(page.session.attempts.landing(exchanging))).toEqual({
      kind: "superseded",
    });
    expect(attemptOf(f).phase).toBe("exchanging");
    await f.runWith(page.session.attempts.cancel(handle));
    expect(await f.runWith(page.session.attempts.landing(exchanging))).toEqual({
      kind: "superseded",
    });
    expect(
      await f.runWith(
        page.session.attempts.landing({
          ...exchanging,
          attempt: "not-a-number",
        }),
      ),
    ).toEqual({ kind: "superseded" });
    expect(f.server.requests.some((r) => r.hadSetCookie)).toBe(false);
  });
});

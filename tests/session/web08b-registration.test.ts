// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AttemptHandle } from "../../src/session/api";
import { sha256Base64url } from "../support/session/env";
import type { Fixture } from "../support/session/harness";
import {
  attemptOf,
  holdAnswers,
  newWorld,
  stateOf,
} from "../support/session/scenarios";
import { API } from "../support/session/server";

afterEach(() => vi.restoreAllMocks());

/**
 * F-REG-*: invitation registration and the preview against a stub of the contract. Fixture evidence only: it shows the
 * module follows matrix 3.4 for the `registration` method and never that the real backend does (that is Layer C).
 */
const PASSWORD = "correct-horse-battery-9271";

async function start(f: Fixture, method: "registration" | "password") {
  const page = f.addPage();
  await f.boot(page);
  const begun = await f.runWith(page.session.attempts.begin(method));
  if (begun.kind !== "started") throw new Error("begin did not start");
  return { page, handle: begun.handle };
}

const registration = (f: Fixture, username = "newbie") => ({
  token: f.server.addInvitation().token,
  username,
  password: PASSWORD,
});

describe("F-REG-1: the verifier is durable before the request, and the body is exactly the contract's", () => {
  test("the record holds the verifier while the request is in flight; the body has the five contract fields and no more", async () => {
    const f = await newWorld();
    const { page, handle } = await start(f, "registration");
    const input = registration(f);
    const held = holdAnswers(f, (r) =>
      r.path.endsWith("/browser-registration"),
    );
    const pending = page.session.attempts.registerWithInvitation(handle, input);
    await f.world.runUntilIdle();
    const sent = f.server.recordsFor(`${API}/browser-registration`);
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "attempt_challenge",
      "device_id",
      "password",
      "token",
      "username",
    ]);
    expect(body).toMatchObject({
      token: input.token,
      username: input.username,
      password: input.password,
    });
    const attempt = attemptOf(f);
    expect(attempt.phase).toBe("exchanging");
    expect(attempt.method).toBe("registration");
    expect(sha256Base64url(attempt.verifier)).toBe(body.attempt_challenge);
    // The device id is the one the browser holds (created in one transaction), and it is not in the handle.
    expect(body.device_id).toBe(f.store.records.device?.device_id);
    expect(Object.keys(handle).sort()).toEqual([
      "challenge",
      "epoch",
      "method",
    ]);
    held.stop();
    held.release();
    await f.runWith(pending);
  });

  test("a handle for another method is refused with a TypeError and nothing is sent", async () => {
    const f = await newWorld();
    const { page, handle } = await start(f, "password");
    await expect(
      page.session.attempts.registerWithInvitation(handle, registration(f)),
    ).rejects.toThrow(TypeError);
    expect(f.server.recordsFor(`${API}/browser-registration`)).toHaveLength(0);
  });
});

describe("F-REG-2: grant, activation, settlement", () => {
  test("a valid invitation settles the new account; only `activate` sets the cookie", async () => {
    const f = await newWorld();
    const { page, handle } = await start(f, "registration");
    const input = registration(f);
    const outcome = await f.runWith(
      page.session.attempts.registerWithInvitation(handle, input),
    );
    expect(outcome).toMatchObject({ kind: "settled", method: "registration" });
    await f.settle();
    const account = [...f.server.accounts.values()].find(
      (a) => a.username === input.username,
    );
    expect(account).toBeDefined();
    expect(page.session.identity.get()?.account_id).toBe(account?.id);
    expect(page.session.view.get()).toMatchObject({ kind: "displaying" });
    // G1: no response except `activate` sets or clears the session cookie.
    const withCookie = f.server.requests
      .filter((r) => r.hadSetCookie)
      .map((r) => r.path);
    expect(withCookie).toEqual([`${API}/browser-sessions/activate`]);
    expect(
      f.server.recordsFor(`${API}/browser-registration`)[0]?.hadSetCookie,
    ).toBe(false);
    // The invitation is consumed and the attempt is over.
    expect(f.server.invitations.get(input.token)?.state).toBe("redeemed");
    expect(stateOf(f).attempt).toBeNull();
    expect(f.store.violations).toEqual([]);
  });
});

describe("F-REG-3: definitive refusals clear the attempt and settle nothing", () => {
  test.each([
    ["an unknown invitation", 401, "unauthenticated"],
    ["a username already taken", 409, "conflict"],
    ["a malformed value", 422, "invalid_value"],
  ] as const)(
    "%s answers %i and reports `refused` with the code",
    async (name, status, code) => {
      const f = await newWorld();
      const { page, handle } = await start(f, "registration");
      const input = registration(f);
      if (status === 401) input.token = "b".repeat(64);
      if (status === 409) input.username = "kieran";
      if (status === 422) input.password = "short";
      const outcome = await f.runWith(
        page.session.attempts.registerWithInvitation(handle, input),
      );
      expect(outcome, name).toMatchObject({
        kind: "refused",
        definitive: true,
        error: { code },
      });
      expect(stateOf(f).attempt).toBeNull();
      expect(stateOf(f).settled).toBeNull();
      expect(page.session.view.get()).toMatchObject({ kind: "signed_out" });
    },
  );

  test("a taken username preserves the invitation: the same token still previews and redeems", async () => {
    const f = await newWorld();
    const { page, handle } = await start(f, "registration");
    const input = registration(f, "kieran");
    expect(
      await f.runWith(
        page.session.attempts.registerWithInvitation(handle, input),
      ),
    ).toMatchObject({ kind: "refused", error: { code: "conflict" } });
    expect(f.server.invitations.get(input.token)?.state).toBe("open");
    const preview = await f.runWith(
      page.session.attempts.previewInvitation(input.token),
    );
    expect(preview).toMatchObject({ kind: "ok" });
    const again = await f.runWith(page.session.attempts.begin("registration"));
    if (again.kind !== "started") throw new Error("not started");
    expect(
      await f.runWith(
        page.session.attempts.registerWithInvitation(again.handle, {
          ...input,
          username: "someone-else",
        }),
      ),
    ).toMatchObject({ kind: "settled", method: "registration" });
  });

  test("a throttled request (429) is a definitive refusal too", async () => {
    const f = await newWorld();
    const { page, handle } = await start(f, "registration");
    f.server.addRule({
      match: ({ path }) => path.endsWith("/browser-registration"),
      rewrite: {
        status: 429,
        body: {
          code: "rate_limited",
          message: "m",
          request_id: "r",
          details: [],
        },
      },
    });
    expect(
      await f.runWith(
        page.session.attempts.registerWithInvitation(handle, registration(f)),
      ),
    ).toMatchObject({ kind: "refused", error: { code: "rate_limited" } });
  });
});

describe("F-REG-4: an unknown outcome is reported as a failed exchange, never retried", () => {
  test.each([
    ["the request never leaves", { dropBeforeForward: true }, null, false],
    [
      "the connection drops after the server acted",
      { dropAfterForward: true },
      null,
      true,
    ],
    [
      "a gateway replaces the answer with a 502",
      { rewrite: { status: 502, body: "<html>", contentType: "text/html" } },
      502,
      true,
    ],
  ] as const)("%s", async (_name, rule, status, committed) => {
    const f = await newWorld();
    const { page, handle } = await start(f, "registration");
    const input = registration(f);
    f.server.addRule({
      match: ({ path }) => path.endsWith("/browser-registration"),
      ...rule,
      times: 1,
    });
    const outcome = await f.runWith(
      page.session.attempts.registerWithInvitation(handle, input),
    );
    expect(outcome).toEqual({ kind: "exchange_failed", status });
    // Exactly one request: the module never retries a registration by itself.
    expect(f.server.recordsFor(`${API}/browser-registration`)).toHaveLength(
      committed ? 1 : 0,
    );
    // When the server acted, the account exists and the invitation is gone: the person signs in with the details chosen.
    expect(
      [...f.server.accounts.values()].some(
        (a) => a.username === input.username,
      ),
    ).toBe(committed);
    expect(f.server.invitations.get(input.token)?.state).toBe(
      committed ? "redeemed" : "open",
    );
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled).toBeNull();
  });

  test("the account created by a lost response can sign in with the chosen credentials", async () => {
    const f = await newWorld();
    const { page, handle } = await start(f, "registration");
    const input = registration(f);
    f.server.addRule({
      match: ({ path }) => path.endsWith("/browser-registration"),
      dropAfterForward: true,
      times: 1,
    });
    await f.runWith(
      page.session.attempts.registerWithInvitation(handle, input),
    );
    const outcome = await f.signIn(page, input.username, input.password);
    expect(outcome).toMatchObject({ kind: "settled", method: "password" });
  });
});

describe("F-REG-5: no secret reaches a log, the console or the durable record", () => {
  test("token, password, grant and verifier stay out of everything the product emits", async () => {
    const consoleCalls: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        consoleCalls.push(args.map((a) => JSON.stringify(a)).join(" "));
      });
    const f = await newWorld();
    const page = f.addPage();
    const verifiers: string[] = [];
    const ids = page.kernel.ports.ids;
    const original = ids.verifier.bind(ids);
    ids.verifier = () => {
      const value = original();
      verifiers.push(value);
      return value;
    };
    await f.boot(page);
    const begun = await f.runWith(page.session.attempts.begin("registration"));
    if (begun.kind !== "started") throw new Error("not started");
    const input = registration(f);
    const outcome = await f.runWith(
      page.session.attempts.registerWithInvitation(begun.handle, input),
    );
    expect(outcome.kind).toBe("settled");
    await f.settle();
    const secrets = [
      input.token,
      input.password,
      ...f.server.grants.keys(),
      ...verifiers,
    ];
    expect(secrets.length).toBeGreaterThan(3);
    const emitted = f.world.logs.filter((e) => !e.type.startsWith("store."));
    const haystack = JSON.stringify(emitted) + consoleCalls.join("\n");
    for (const secret of secrets) expect(haystack).not.toContain(secret);
    const atRest = JSON.stringify(f.store.records);
    for (const secret of secrets) expect(atRest).not.toContain(secret);
  });
});

describe("previewInvitation", () => {
  const preview = (f: Fixture, token: string, signal?: AbortSignal) => {
    const page = f.pages[0];
    if (!page) throw new Error("no page");
    return f.runWith(page.session.attempts.previewInvitation(token, signal));
  };
  const boot = async (f: Fixture) => {
    const page = f.addPage();
    await f.boot(page);
    return page;
  };

  test("an open household invitation previews with the household and the expiry; the token is in the BODY only", async () => {
    const f = await newWorld();
    await boot(f);
    const invitation = f.server.addInvitation({
      household: { id: "h1", name: "Hartley" },
    });
    const result = await preview(f, invitation.token);
    expect(result).toMatchObject({
      kind: "ok",
      household: { id: "h1", name: "Hartley" },
    });
    const sent = f.server.recordsFor(`${API}/registration/preview`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ token: invitation.token });
    expect(sent[0]?.path).not.toContain(invitation.token);
    expect(sent[0]?.method).toBe("POST");
  });

  test("a standalone invitation previews with a null household", async () => {
    const f = await newWorld();
    await boot(f);
    const invitation = f.server.addInvitation();
    expect(await preview(f, invitation.token)).toMatchObject({
      kind: "ok",
      household: null,
    });
  });

  test("it is not an attempt: no epoch is allocated and nothing is written to the durable record", async () => {
    const f = await newWorld();
    await boot(f);
    const before = JSON.stringify(f.store.records);
    await preview(f, f.server.addInvitation().token);
    expect(JSON.stringify(f.store.records)).toBe(before);
    expect(stateOf(f).attempt).toBeNull();
  });

  test.each([
    ["unknown", () => "c".repeat(64)],
    [
      "already used",
      (f: Fixture) => {
        const invitation = f.server.addInvitation();
        invitation.state = "redeemed";
        return invitation.token;
      },
    ],
    [
      "revoked",
      (f: Fixture) => {
        const invitation = f.server.addInvitation();
        invitation.state = "revoked";
        return invitation.token;
      },
    ],
    ["expired", (f: Fixture) => f.server.addInvitation({ ttlMs: -1 }).token],
  ])(
    "%s answers 401 and is `unavailable` (the server does not say which)",
    async (_name, token) => {
      const f = await newWorld();
      await boot(f);
      expect(await preview(f, token(f))).toEqual({ kind: "unavailable" });
    },
  );

  test("another Atlas error is `refused` with its status; no answer or a non-Atlas body is a network failure", async () => {
    const f = await newWorld();
    await boot(f);
    const token = f.server.addInvitation().token;
    const rule = f.server.addRule({
      match: ({ path }) => path.endsWith("/registration/preview"),
      rewrite: {
        status: 429,
        body: {
          code: "rate_limited",
          message: "m",
          request_id: "r",
          details: [],
        },
      },
      times: 1,
    });
    expect(await preview(f, token)).toMatchObject({
      kind: "refused",
      status: 429,
      error: { code: "rate_limited" },
    });
    rule();
    f.server.addRule({
      match: ({ path }) => path.endsWith("/registration/preview"),
      dropBeforeForward: true,
      times: 1,
    });
    expect(await preview(f, token)).toEqual({ kind: "network_failure" });
    f.server.addRule({
      match: ({ path }) => path.endsWith("/registration/preview"),
      rewrite: { status: 200, body: "not json", contentType: "text/plain" },
      times: 1,
    });
    expect(await preview(f, token)).toEqual({ kind: "network_failure" });
    f.server.addRule({
      match: ({ path }) => path.endsWith("/registration/preview"),
      rewrite: { status: 200, body: { household: "x", expires_at: 7 } },
      times: 1,
    });
    expect(await preview(f, token)).toEqual({ kind: "network_failure" });
  });

  test("the caller's abort ends the request", async () => {
    const f = await newWorld();
    await boot(f);
    const token = f.server.addInvitation().token;
    const controller = new AbortController();
    const held = holdAnswers(f, (r) =>
      r.path.endsWith("/registration/preview"),
    );
    const pending = f.pages[0]?.session.attempts.previewInvitation(
      token,
      controller.signal,
    ) as Promise<unknown>;
    await f.world.runUntilIdle();
    controller.abort();
    held.stop();
    expect(await f.runWith(pending)).toEqual({ kind: "network_failure" });
  });
});

describe("handle shape", () => {
  test("`begin` returns a handle without the device id and without the verifier", async () => {
    const f = await newWorld();
    const { handle } = await start(f, "registration");
    const keys = Object.keys(handle as AttemptHandle).sort();
    expect(keys).toEqual(["challenge", "epoch", "method"]);
  });
});

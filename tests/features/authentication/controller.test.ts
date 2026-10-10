import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeLanding,
  register,
  signIn,
  startSso,
} from "../../../src/features/authentication/controller";
import { authFeedback } from "../../../src/features/authentication/feedback";
import { invitationMemory } from "../../../src/features/authentication/handoff";
import type { AttemptOutcome } from "../../../src/session";
import { attemptsDouble, sessionDouble } from "../../helpers/session-double";

const TOKEN = "b".repeat(64);
const atlasError = (code: string, request_id = "req-1") => ({
  code,
  message: "ignored",
  request_id,
});
const refused = (
  code: string,
  stage: "exchange" | "activation" = "exchange",
): AttemptOutcome => ({
  kind: "refused",
  definitive: true,
  stage,
  error: atlasError(code),
});

const session = (over: Parameters<typeof attemptsDouble>[0] = {}) =>
  sessionDouble({}, { attempts: attemptsDouble(over) });

beforeEach(() => {
  authFeedback.clearOnBegin();
  invitationMemory.clear();
});
afterEach(() => {
  authFeedback.clearOnBegin();
  invitationMemory.clear();
});

const feedbackKinds = () => authFeedback.get().map((item) => item.kind);

describe("signIn", () => {
  const credentials = { username: "kieran", password: "pw" };

  test("a settled attempt is `settled` with its method", async () => {
    expect(await signIn(session(), credentials)).toEqual({
      kind: "settled",
      method: "password",
    });
  });

  test.each([
    ["a wrong password", refused("unauthenticated"), "bad_credentials"],
    ["a throttle", refused("rate_limited"), "rate_limited"],
    [
      "an activation refusal after a good password",
      refused("unauthenticated", "activation"),
      "activation_refused",
    ],
    [
      "device capacity at activation",
      refused("device_capacity", "activation"),
      "device_capacity",
    ],
    [
      "a failed exchange",
      { kind: "exchange_failed", status: null } as const,
      "unreachable",
    ],
    [
      "a hidden tab",
      { kind: "not_started", reason: "hidden" } as const,
      "hidden_tab",
    ],
    [
      "a pending wipe",
      { kind: "not_started", reason: "wipe_pending" } as const,
      "wipe_pending",
    ],
  ])("%s -> %s", async (_name, outcome, id) => {
    const result = await signIn(
      session({ signInWithPassword: vi.fn(async () => outcome) }),
      credentials,
    );
    expect(result).toMatchObject({ kind: "failed", message: { id } });
  });

  test("a refusal is carried in page memory for the form that mounts next, and the next sign-in clears it (review R1)", async () => {
    const result = await signIn(
      session({
        signInWithPassword: vi.fn(async () =>
          refused("device_capacity", "activation"),
        ),
      }),
      credentials,
    );
    expect(result).toMatchObject({ kind: "failed" });
    expect(authFeedback.carriedFailure()).toEqual({
      id: "device_capacity",
      requestId: "req-1",
    });
    await signIn(session(), credentials);
    expect(authFeedback.carriedFailure()).toBeNull();
  });

  test.each([
    ["a stale result", { kind: "superseded" } as const],
    ["a gating attempt", { kind: "gating" } as const],
    ["a settled attempt", { kind: "settled" } as never],
  ])("%s carries no refusal", async (_name, outcome) => {
    await signIn(
      session({ signInWithPassword: vi.fn(async () => outcome) }),
      credentials,
    );
    expect(authFeedback.carriedFailure()).toBeNull();
  });

  test("a sign-in that could not begin is carried too", async () => {
    await signIn(
      session({
        begin: vi.fn(async () => ({ kind: "storage_unavailable" as const })),
      }),
      credentials,
    );
    expect(authFeedback.carriedFailure()).toEqual({
      id: "storage_unavailable",
    });
  });

  test("a refusal carries the Atlas request id", async () => {
    const result = await signIn(
      session({
        signInWithPassword: vi.fn(async () => refused("unauthenticated")),
      }),
      credentials,
    );
    expect(result).toMatchObject({ message: { requestId: "req-1" } });
  });

  test("`superseded` publishes the banner and reports nothing for the form", async () => {
    const result = await signIn(
      session({
        signInWithPassword: vi.fn(async () => ({
          kind: "superseded" as const,
        })),
      }),
      credentials,
    );
    expect(result).toEqual({ kind: "superseded" });
    expect(feedbackKinds()).toEqual(["superseded"]);
  });

  test("a busy lock publishes the banner, whether `begin` or the activation timed out", async () => {
    const begun = await signIn(
      session({
        begin: vi.fn(async () => ({ kind: "lock_timeout" as const })),
      }),
      credentials,
    );
    expect(begun).toEqual({ kind: "lock_timeout" });
    expect(feedbackKinds()).toEqual(["lock_wait"]);
    authFeedback.clearOnBegin();
    const activating = await signIn(
      session({
        signInWithPassword: vi.fn(async () => ({
          kind: "not_started" as const,
          reason: "lock_timeout" as const,
        })),
      }),
      credentials,
    );
    expect(activating).toEqual({ kind: "lock_timeout" });
    expect(feedbackKinds()).toEqual(["lock_wait"]);
  });

  test("a gating attempt takes over: the form has nothing to show", async () => {
    expect(
      await signIn(
        session({ begin: vi.fn(async () => ({ kind: "resolving" as const })) }),
        credentials,
      ),
    ).toEqual({ kind: "gating" });
    expect(
      await signIn(
        session({
          signInWithPassword: vi.fn(async () => ({ kind: "gating" as const })),
        }),
        credentials,
      ),
    ).toEqual({ kind: "gating" });
  });

  test("storage that will not open is its own message", async () => {
    expect(
      await signIn(
        session({
          begin: vi.fn(async () => ({ kind: "storage_unavailable" as const })),
        }),
        credentials,
      ),
    ).toMatchObject({ kind: "failed", message: { id: "storage_unavailable" } });
  });

  test("a new sign-in clears what the last one left behind", async () => {
    authFeedback.add({ kind: "superseded" });
    await signIn(session(), credentials);
    expect(authFeedback.get()).toEqual([]);
  });

  test("the credentials go to the module and nowhere else", async () => {
    const attempts = attemptsDouble();
    await signIn(sessionDouble({}, { attempts }), credentials);
    expect(attempts.signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ method: "password" }),
      credentials,
    );
    expect(JSON.stringify(authFeedback.get())).not.toContain("pw");
  });
});

describe("register", () => {
  const input = {
    token: TOKEN,
    username: "newbie",
    password: "correct-horse-9271",
  };
  beforeEach(() => invitationMemory.set(TOKEN));

  test("settled: the token has left memory and is not restored", async () => {
    expect(await register(session(), input)).toEqual({ kind: "settled" });
    expect(invitationMemory.peek()).toBeNull();
  });

  test("the token is out of memory DURING the exchange (so a tree mounted by settlement does not see an unused invitation)", async () => {
    let during: string | null = "unset";
    await register(
      session({
        registerWithInvitation: vi.fn(async () => {
          during = invitationMemory.peek();
          return {
            kind: "settled" as const,
            account_id: "a",
            epoch: 1,
            method: "registration" as const,
          };
        }),
      }),
      input,
    );
    expect(during).toBeNull();
  });

  test.each([
    "conflict",
    "invalid_value",
    "rate_limited",
    "forbidden",
    "not_found",
  ])(
    "a %s refusal leaves the invitation usable: the token is restored and the form stays",
    async (code) => {
      const result = await register(
        session({ registerWithInvitation: vi.fn(async () => refused(code)) }),
        input,
      );
      expect(result.kind).toBe("failed");
      expect(invitationMemory.peek()).toBe(TOKEN);
    },
  );

  test("a taken username is the username's own message", async () => {
    expect(
      await register(
        session({
          registerWithInvitation: vi.fn(async () => refused("conflict")),
        }),
        input,
      ),
    ).toMatchObject({ kind: "failed", message: { id: "username_taken" } });
  });

  test("a 401 means expired, used or revoked: the token is dropped", async () => {
    expect(
      await register(
        session({
          registerWithInvitation: vi.fn(async () => refused("unauthenticated")),
        }),
        input,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(invitationMemory.peek()).toBeNull();
  });

  test.each([
    ["a failed exchange", { kind: "exchange_failed", status: null } as const],
    ["a gateway 502", { kind: "exchange_failed", status: 502 } as const],
    [
      "an activation refusal (the account exists)",
      refused("device_capacity", "activation"),
    ],
    // These two would take the `unavailable` and the keep-the-token branches if the stage were not consulted: the grant WAS
    // good, so the account exists and the invitation is spent.
    [
      "an activation 401 (not 'expired or used': the invitation was redeemed)",
      refused("unauthenticated", "activation"),
    ],
    [
      "an activation 409 (not 'username taken': the account exists)",
      refused("conflict", "activation"),
    ],
    ["an unknown code", refused("something_new")],
    // The session module sends the redemption BEFORE it can report `not_started` (pinned over the real kernel in
    // registration-recovery.test.ts), so every one of these is a failure to ACTIVATE a grant the redemption already returned.
    [
      "a pause with the attempt gone",
      { kind: "not_started", reason: "attempt_gone" } as const,
    ],
    [
      "a hidden page after the redemption",
      { kind: "not_started", reason: "hidden" } as const,
    ],
    [
      "a wipe still pending after the redemption",
      { kind: "not_started", reason: "wipe_pending" } as const,
    ],
    [
      "a busy lock at the activation (after the redemption)",
      { kind: "not_started", reason: "lock_timeout" } as const,
    ],
    [
      "a closing write that gave up (after the redemption)",
      { kind: "not_started", reason: "closing_write_gave_up" } as const,
    ],
    ["an indeterminate activation", { kind: "gating" } as const],
  ])(
    "%s: lost response, token dropped, NOT retried",
    async (_name, outcome) => {
      const registerWithInvitation = vi.fn(async () => outcome);
      const result = await register(session({ registerWithInvitation }), input);
      // A gating attempt is the gate's to resolve; every other outcome is the sign-in recovery.
      expect(result).toEqual(
        outcome.kind === "gating"
          ? { kind: "gating" }
          : { kind: "lost_response" },
      );
      expect(invitationMemory.peek()).toBeNull();
      // The page remembers the invitation as spent, with the username the person chose and nothing else.
      expect(invitationMemory.get()).toEqual({
        kind: "spent",
        username: input.username,
      });
      expect(registerWithInvitation).toHaveBeenCalledTimes(1);
    },
  );

  test("not sent at all (`begin` could not start): the invitation is untouched and restored", async () => {
    const registerWithInvitation = vi.fn();
    const busy = await register(
      session({
        begin: vi.fn(async () => ({ kind: "lock_timeout" as const })),
        registerWithInvitation,
      }),
      input,
    );
    expect(busy).toEqual({ kind: "lock_timeout" });
    expect(registerWithInvitation).not.toHaveBeenCalled();
    expect(invitationMemory.peek()).toBe(TOKEN);
    expect(feedbackKinds()).toContain("lock_wait");
    invitationMemory.clear();
    const resolving = await register(
      session({
        begin: vi.fn(async () => ({ kind: "resolving" as const })),
        registerWithInvitation,
      }),
      input,
    );
    expect(resolving).toEqual({ kind: "gating" });
    expect(invitationMemory.peek()).toBe(TOKEN);
    expect(registerWithInvitation).not.toHaveBeenCalled();
  });

  test("T16: a stale response is `superseded`; the account exists, so the person signs in with the details they chose", async () => {
    const result = await register(
      session({
        registerWithInvitation: vi.fn(async () => ({
          kind: "superseded" as const,
        })),
      }),
      input,
    );
    expect(result).toEqual({ kind: "superseded" });
    expect(feedbackKinds()).toEqual(["superseded"]);
    expect(invitationMemory.peek()).toBeNull();
    // The LIVE form must not stay usable either (review R2): the shared memory says the invitation is spent, and the join
    // surface draws its sign-in recovery from that (join.test.tsx asserts the surface).
    expect(invitationMemory.get()).toEqual({
      kind: "spent",
      username: input.username,
    });
  });

  test("a refusal that leaves the invitation usable does not mark it spent", async () => {
    await register(
      session({
        registerWithInvitation: vi.fn(async () => refused("conflict")),
      }),
      input,
    );
    expect(invitationMemory.get()).toEqual({ kind: "token", token: TOKEN });
    invitationMemory.clear();
    invitationMemory.set(TOKEN);
    await register(
      session({
        registerWithInvitation: vi.fn(async () => refused("unauthenticated")),
      }),
      input,
    );
    // A `401` is "unusable", not "spent by us": the surface says so and offers sign-in, but the memory holds nothing to draw from.
    expect(invitationMemory.get()).toEqual({ kind: "unset" });
  });
});

describe("startSso", () => {
  const navigate = vi.fn();
  beforeEach(() => navigate.mockClear());

  test("navigates only on a `redirect`, to the URL the module returned", async () => {
    expect(await startSso(session(), { link: false }, { navigate })).toEqual({
      kind: "navigating",
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "https://idp.example.test/authorize",
    );
  });

  test("a link begins an `oidc_link` attempt, a sign-in an `oidc` one", async () => {
    const attempts = attemptsDouble();
    await startSso(
      sessionDouble({}, { attempts }),
      { link: true },
      { navigate },
    );
    await startSso(
      sessionDouble({}, { attempts }),
      { link: false },
      { navigate },
    );
    expect(attempts.begin).toHaveBeenNthCalledWith(1, "oidc_link");
    expect(attempts.begin).toHaveBeenNthCalledWith(2, "oidc");
  });

  test.each([
    [
      "a refusal",
      { kind: "refused", error: atlasError("not_found"), status: 404 } as const,
      "sso_not_set_up",
    ],
    [
      "an outage",
      {
        kind: "refused",
        error: atlasError("oidc_unavailable"),
        status: 502,
      } as const,
      "sso_unavailable",
    ],
    [
      "a failed exchange",
      { kind: "exchange_failed", status: null } as const,
      "unreachable",
    ],
    [
      "an attempt that is gone",
      { kind: "not_started", reason: "attempt_gone" } as const,
      "interrupted",
    ],
  ])("%s: no navigation, and the message is %s", async (_name, outcome, id) => {
    const result = await startSso(
      session({ startOidc: vi.fn(async () => outcome) }),
      { link: false },
      { navigate },
    );
    expect(result).toMatchObject({ kind: "failed", message: { id } });
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a stale start is never followed", async () => {
    const result = await startSso(
      session({
        startOidc: vi.fn(async () => ({ kind: "superseded" as const })),
      }),
      { link: false },
      { navigate },
    );
    expect(result).toEqual({ kind: "superseded" });
    expect(navigate).not.toHaveBeenCalled();
    expect(feedbackKinds()).toEqual(["superseded"]);
  });
});

describe("completeLanding", () => {
  const fragment = {
    grant: "a".repeat(64),
    attempt: "3",
    account: "123e4567-e89b-12d3-a456-426614174000",
  };

  test("an invalid landing never reaches the module", async () => {
    const attempts = attemptsDouble();
    await completeLanding(sessionDouble({}, { attempts }), { kind: "invalid" });
    expect(attempts.landing).not.toHaveBeenCalled();
    expect(authFeedback.get()[0]).toMatchObject({
      kind: "message",
      tone: "problem",
      message: { id: "sso_landing_invalid" },
    });
  });

  test("a sign-in landing that settles says nothing (the tree mounts)", async () => {
    await completeLanding(session(), { kind: "valid", fragment });
    expect(authFeedback.get()).toEqual([]);
  });

  test("a link landing that settles says linking worked", async () => {
    await completeLanding(
      session({
        landing: vi.fn(async () => ({
          kind: "settled" as const,
          account_id: "a",
          epoch: 3,
          method: "oidc_link" as const,
        })),
      }),
      { kind: "valid", fragment },
    );
    expect(authFeedback.get()[0]).toMatchObject({
      kind: "message",
      tone: "info",
      message: { id: "sso_linked" },
    });
  });

  test("T2: a stale landing is `superseded`", async () => {
    await completeLanding(
      session({
        landing: vi.fn(async () => ({ kind: "superseded" as const })),
      }),
      { kind: "valid", fragment },
    );
    expect(feedbackKinds()).toEqual(["superseded"]);
  });

  test.each([
    [
      "an activation refusal",
      refused("device_capacity", "activation"),
      "device_capacity",
    ],
    ["a refusal", refused("not_found"), "sso_not_set_up"],
    [
      "a failed exchange",
      { kind: "exchange_failed", status: null } as const,
      "sso_landing_failed",
    ],
    [
      "a pause",
      { kind: "not_started", reason: "hidden" } as const,
      "sso_landing_failed",
    ],
  ])("%s publishes a problem message", async (_name, outcome, id) => {
    await completeLanding(session({ landing: vi.fn(async () => outcome) }), {
      kind: "valid",
      fragment,
    });
    expect(authFeedback.get()[0]).toMatchObject({
      tone: "problem",
      message: { id },
    });
  });

  test("a gating attempt publishes nothing: the 1c card owns the screen", async () => {
    await completeLanding(
      session({ landing: vi.fn(async () => ({ kind: "gating" as const })) }),
      { kind: "valid", fragment },
    );
    expect(authFeedback.get()).toEqual([]);
  });
});

describe("feedback store", () => {
  test("the same fact twice in a row is one fact; dismissal removes it", () => {
    authFeedback.add({ kind: "superseded" });
    authFeedback.add({ kind: "superseded" });
    expect(authFeedback.get()).toHaveLength(1);
    const [only] = authFeedback.get();
    if (!only) throw new Error("no item");
    authFeedback.dismiss(only.id);
    expect(authFeedback.get()).toEqual([]);
  });
});

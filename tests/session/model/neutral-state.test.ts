import { describe, expect, test } from "vitest";
import {
  deriveNeutral,
  deriveSignedOut,
  EMPTY_MEMORY,
  type NeutralMemory,
} from "../../../src/session/model/neutral-state";
import {
  drift,
  invalid,
  logoutEnvelope,
  NOW,
  operation,
  records,
  unverified,
} from "../../support/session/records";

/** F-NS-*: the precedence of decision D-05 and every state, online and offline. */
const online = { online: true };
const offline = { online: false };
const derive = (
  recs: ReturnType<typeof records>,
  memory: Partial<NeutralMemory> = {},
  env = online,
) => deriveNeutral(recs.auth_state, { ...EMPTY_MEMORY, ...memory }, env);
const attempt = (
  phase: "exchanging" | "activating" | "indeterminate" | "verifying",
) => ({
  phase,
  epoch: 2,
  verifier: "v".repeat(43),
  cancel_result: phase === "verifying" ? ("unknown" as const) : null,
});

describe("deriveNeutral", () => {
  test("nothing closes an ordinary settled account", () => {
    expect(derive(records({ settled: {} }))).toBeNull();
    expect(
      derive(records({ settled: {}, attempt: attempt("exchanging") })),
    ).toBeNull();
  });
  test("1a: an operation fence, confirming until a call is under way", () => {
    const recs = records({
      settled: {},
      fences: { A: [operation(1, logoutEnvelope())] },
    });
    expect(derive(recs)).toBe("1a.confirming");
    expect(derive(recs, { operationCallInFlight: true })).toBe("1a.checking");
    expect(derive(recs, {}, offline)).toBe("1a.confirming");
  });
  test("1a.ended_elsewhere: only removed_elsewhere entries; 1b otherwise", () => {
    expect(
      derive(
        records({
          settled: {},
          fences: { A: [invalid(1, 1, "removed_elsewhere")] },
        }),
      ),
    ).toBe("1a.ended_elsewhere");
    expect(
      derive(
        records({
          settled: {},
          fences: { A: [invalid(1, 1, "removed_elsewhere"), invalid(2, 1)] },
        }),
      ),
    ).toBe("1b");
  });
  test("1c: a gating attempt; resolving online and offline for the indeterminate phases; finishing while activating", () => {
    expect(
      derive(records({ settled: {}, attempt: attempt("activating") })),
    ).toBe("1c.finishing");
    expect(
      derive(records({ settled: {}, attempt: attempt("indeterminate") })),
    ).toBe("1c.resolving");
    expect(
      derive(records({ settled: {}, attempt: attempt("verifying") })),
    ).toBe("1c.resolving");
    expect(
      derive(
        records({ settled: {}, attempt: attempt("verifying") }),
        {},
        offline,
      ),
    ).toBe("1c.offline");
    expect(
      derive(
        records({ settled: {}, attempt: attempt("activating") }),
        {},
        offline,
      ),
    ).toBe("1c.offline");
  });
  test("1d and 1b and 1e session check", () => {
    expect(derive(records({ settled: {}, fences: { A: [drift(1, 1)] } }))).toBe(
      "1d",
    );
    expect(
      derive(records({ settled: {}, fences: { A: [invalid(1, 1)] } })),
    ).toBe("1b");
    expect(
      derive(records({ settled: {}, fences: { A: [unverified(1, 1)] } })),
    ).toBe("1e.session_online");
    expect(
      derive(
        records({ settled: {}, fences: { A: [unverified(1, 1)] } }),
        {},
        offline,
      ),
    ).toBe("1e.session_offline");
  });
  test("1e interrupted request, waiting, read failure and the catch-up states", () => {
    const recs = records({ settled: {} });
    expect(derive(recs, { unresolvedLeaseKnown: true })).toBe(
      "1e.interrupted_online",
    );
    expect(derive(recs, { unresolvedLeaseKnown: true }, offline)).toBe(
      "1e.interrupted_offline",
    );
    expect(derive(recs, { waitingOnOtherWindow: true })).toBe("1e.waiting");
    expect(derive(recs, { readFailure: true })).toBe("1e.read_failure");
    expect(derive(recs, { recovery: "catching_up" })).toBe("2");
    expect(derive(recs, { recovery: "failed" })).toBe("3");
    expect(derive(recs, { notice: "1a.device_changed" })).toBe(
      "1a.device_changed",
    );
  });
  test("after a re-authentication, older-epoch fences are what recovery clears: state 2 (or 3), not the reconnect card", () => {
    // Settled again at epoch 3; the invalidation was recorded under epoch 1 (matrix 3.7.3, decision D-05 as amended).
    const older = (
      fence: ReturnType<typeof invalid> | ReturnType<typeof drift>,
    ) => records({ settled: { epoch: 3 }, fences: { A: [fence] } });
    expect(derive(older(invalid(1, 1)))).toBe("2");
    expect(derive(older(drift(1, 1)))).toBe("2");
    expect(derive(older(invalid(1, 1)), { recovery: "failed" })).toBe("3");
    // The current epoch's own entry still needs a re-authentication first: it is the reconnect card, never catch-up.
    expect(
      derive(
        records({ settled: { epoch: 3 }, fences: { A: [invalid(1, 3)] } }),
      ),
    ).toBe("1b");
    // A credential-unverified entry, or an operation fence, is never a catch-up.
    expect(
      derive(
        records({ settled: { epoch: 3 }, fences: { A: [unverified(1, 1)] } }),
      ),
    ).toBe("1e.session_online");
    // A mixture that includes a current-epoch entry is not recoverable yet.
    expect(
      derive(
        records({
          settled: { epoch: 3 },
          fences: { A: [invalid(1, 1), invalid(2, 3)] },
        }),
      ),
    ).toBe("1b");
  });
  test("D-05 precedence: 1a > 1c > 1d > 1b > 1e session > 1e interrupted > 1e waiting", () => {
    const all = (extra: Partial<Parameters<typeof records>[0]>) =>
      records({
        settled: {},
        attempt: attempt("verifying"),
        fences: {
          A: [
            operation(1, logoutEnvelope()),
            drift(2, 1),
            invalid(3, 1),
            unverified(4, 1),
          ],
        },
        ...extra,
      });
    const memory = { unresolvedLeaseKnown: true, waitingOnOtherWindow: true };
    expect(derive(all({}), memory)).toBe("1a.confirming");
    expect(
      derive(
        all({ fences: { A: [drift(2, 1), invalid(3, 1), unverified(4, 1)] } }),
        memory,
      ),
    ).toBe("1c.resolving");
    expect(
      derive(
        all({
          attempt: null,
          fences: { A: [drift(2, 1), invalid(3, 1), unverified(4, 1)] },
        }),
        memory,
      ),
    ).toBe("1d");
    expect(
      derive(
        all({
          attempt: null,
          fences: { A: [invalid(3, 1), unverified(4, 1)] },
        }),
        memory,
      ),
    ).toBe("1b");
    expect(
      derive(all({ attempt: null, fences: { A: [unverified(4, 1)] } }), memory),
    ).toBe("1e.session_online");
    expect(derive(all({ attempt: null, fences: {} }), memory)).toBe(
      "1e.interrupted_online",
    );
    expect(
      derive(all({ attempt: null, fences: {} }), {
        waitingOnOtherWindow: true,
      }),
    ).toBe("1e.waiting");
    expect(
      derive(all({ attempt: null, fences: {} }), {
        ...memory,
        readFailure: true,
      }),
    ).toBe("1e.read_failure");
  });
  test("signed out: a gating attempt still names 1c; a notice names its own card; otherwise nothing", () => {
    const signedOut = (
      recs: ReturnType<typeof records>,
      memory: Partial<NeutralMemory> = {},
      env = online,
    ) => deriveSignedOut(recs.auth_state, { ...EMPTY_MEMORY, ...memory }, env);
    expect(signedOut(records({}))).toBeNull();
    expect(signedOut(records({ attempt: attempt("verifying") }))).toBe(
      "1c.resolving",
    );
    expect(
      signedOut(records({ attempt: attempt("verifying") }), {}, offline),
    ).toBe("1c.offline");
    expect(signedOut(records({}), { notice: "1c.superseded" })).toBe(
      "1c.superseded",
    );
    expect(signedOut(records({}), { notice: "1c.ended" })).toBe("1c.ended");
    expect(signedOut(records({}), { notice: "1c.lock_wait" })).toBe(
      "1c.lock_wait",
    );
  });
  test("the time is irrelevant to the derivation", () => {
    expect(NOW).toBeTruthy();
  });
});

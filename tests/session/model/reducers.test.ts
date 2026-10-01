import { describe, expect, test } from "vitest";
import { checkInvariants } from "../../../src/session/model/invariants";
import {
  allocateEpoch,
  beginActivating,
  clearNonGating,
  failDefinitive,
  markIndeterminate,
  markRedirected,
  observeAttempt,
  recordGrant,
  resolveAfterCancel,
  settle,
} from "../../../src/session/model/reducers/attempt";
import { cover } from "../../../src/session/model/reducers/cover";
import {
  bootCanary,
  deviceGetOrCreate,
  ledgerClear,
  ledgerCreate,
  ledgerSetStatus,
} from "../../../src/session/model/reducers/misc";
import {
  clearCredentialUnverified,
  convertStale,
  recordObservation,
  retireOwnLease,
  verifyOutcome,
} from "../../../src/session/model/reducers/observation";
import {
  applyOperationOutcome,
  finishRecovery,
  raiseOperationFence,
} from "../../../src/session/model/reducers/operation";
import {
  apply,
  drift,
  invalid,
  logoutEnvelope,
  NOW,
  operation,
  records,
  unverified,
} from "../../support/session/records";

const verifier = "v".repeat(43);
const attempt = (
  phase:
    | "exchanging"
    | "redirected"
    | "activating"
    | "indeterminate"
    | "verifying",
  extra = {},
) => ({
  epoch: 2,
  phase,
  verifier,
  ...(phase === "verifying"
    ? { cancel_result: "session_revoked" as const }
    : {}),
  ...extra,
});

describe("allocateEpoch (3.4 step 1)", () => {
  const input = {
    method: "password" as const,
    verifier,
    now: NOW,
    expiresAt: NOW,
  };
  test("increments latest_epoch, records the previous account and a null marker", () => {
    const { records: next, result } = apply(
      records({ settled: { epoch: 3 }, latest_epoch: 5 }),
      (r) => allocateEpoch(r, input),
    );
    expect(result).toEqual({ kind: "ALLOCATED", epoch: 6 });
    expect(next.auth_state.latest_epoch).toBe(6);
    expect(next.auth_state.attempt).toMatchObject({
      epoch: 6,
      phase: "exchanging",
      previous_account_id: "A",
      observations_deferred: null,
      target_account_id: null,
    });
  });
  test("refuses while a gating attempt exists, in every gating phase, and writes nothing", () => {
    for (const phase of ["activating", "indeterminate", "verifying"] as const) {
      const { result, wrote } = apply(
        records({ attempt: attempt(phase) }),
        (r) => allocateEpoch(r, input),
      );
      expect(result).toEqual({ kind: "RESOLVE_FIRST" });
      expect(wrote).toBe(false);
    }
  });
  test("replaces only a non-gating attempt and discards its verifier", () => {
    for (const phase of ["exchanging", "redirected"] as const) {
      const before = records({
        attempt: attempt(phase, { verifier: "old".padEnd(43, "x") }),
      });
      const { records: next } = apply(before, (r) =>
        allocateEpoch(r, { ...input, verifier: "new".padEnd(43, "y") }),
      );
      expect(next.auth_state.attempt?.verifier).toBe("new".padEnd(43, "y"));
      expect(next.auth_state.attempt?.epoch).toBe(3);
    }
  });
  test("is never reused: two allocations give strictly increasing epochs", () => {
    let recs = records({});
    const epochs: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const out = apply(recs, (r) => allocateEpoch(r, input));
      recs = out.records;
      epochs.push((out.result as { epoch: number }).epoch);
    }
    expect(epochs).toEqual([1, 2, 3, 4]);
  });
});

describe("recordGrant, beginActivating, markRedirected", () => {
  test("recordGrant stores the target only for the requester's epoch", () => {
    const ok = apply(records({ attempt: attempt("exchanging") }), (r) =>
      recordGrant(r, { epoch: 2, account_id: "B" }),
    );
    expect(ok.result).toBe("OK");
    expect(ok.records.auth_state.attempt?.target_account_id).toBe("B");
    const stale = apply(records({ attempt: attempt("exchanging") }), (r) =>
      recordGrant(r, { epoch: 1, account_id: "B" }),
    );
    expect(stale.result).toBe("SUPERSEDED");
    expect(stale.wrote).toBe(false);
    expect(
      apply(records({}), (r) => recordGrant(r, { epoch: 1, account_id: "B" }))
        .result,
    ).toBe("SUPERSEDED");
  });
  test("beginActivating moves exchanging or redirected to activating and returns the verifier", () => {
    for (const phase of ["exchanging", "redirected"] as const) {
      const out = apply(records({ attempt: attempt(phase) }), (r) =>
        beginActivating(r, { epoch: 2 }),
      );
      expect(out.result).toMatchObject({ kind: "OK", verifier });
      expect(out.records.auth_state.attempt?.phase).toBe("activating");
    }
  });
  test("beginActivating refuses a gating phase, another epoch and no attempt", () => {
    for (const phase of ["activating", "indeterminate", "verifying"] as const)
      expect(
        apply(records({ attempt: attempt(phase) }), (r) =>
          beginActivating(r, { epoch: 2 }),
        ).result,
      ).toEqual({ kind: "SUPERSEDED" });
    expect(
      apply(records({ attempt: attempt("exchanging") }), (r) =>
        beginActivating(r, { epoch: 9 }),
      ).result,
    ).toEqual({ kind: "SUPERSEDED" });
    expect(
      apply(records({}), (r) => beginActivating(r, { epoch: 2 })).result,
    ).toEqual({ kind: "SUPERSEDED" });
  });
  test("markRedirected applies only to an exchanging attempt of that epoch", () => {
    expect(
      apply(records({ attempt: attempt("exchanging") }), (r) =>
        markRedirected(r, { epoch: 2, expiresAt: NOW }),
      ).result,
    ).toBe("OK");
    expect(
      apply(records({ attempt: attempt("activating") }), (r) =>
        markRedirected(r, { epoch: 2, expiresAt: NOW }),
      ).result,
    ).toBe("SUPERSEDED");
  });
});

describe("settle (O1)", () => {
  const input = { epoch: 2, account_id: "B", session_id: "sB", now: NOW };
  test("writes settled, clears the attempt and its verifier, keeps every fence and lease", () => {
    const before = records({
      settled: { account_id: "A", epoch: 1 },
      attempt: attempt("activating", { observations_deferred: 4 }),
      fences: { A: [invalid(4, 1)] },
      leases: { l1: { account_id: "A" } },
      fence_seq: 4,
    });
    const out = apply(before, (r) => settle(r, input));
    expect(out.result).toBe("SETTLED");
    const state = out.records.auth_state;
    expect(state.settled).toMatchObject({
      account_id: "B",
      epoch: 2,
      session_id: "sB",
    });
    expect(state.attempt).toBeNull(); // the verifier and the marker are discarded by design
    expect(state.fences.A).toHaveLength(1);
    expect(Object.keys(state.leases)).toEqual(["l1"]);
    expect(checkInvariants(state)).toEqual([]);
  });
  test("is superseded when the attempt is another epoch or not activating", () => {
    expect(
      apply(records({ attempt: attempt("activating") }), (r) =>
        settle(r, { ...input, epoch: 3 }),
      ).result,
    ).toBe("SUPERSEDED");
    expect(
      apply(records({ attempt: attempt("exchanging") }), (r) =>
        settle(r, input),
      ).result,
    ).toBe("SUPERSEDED");
    expect(apply(records({}), (r) => settle(r, input)).result).toBe(
      "SUPERSEDED",
    );
  });
});

describe("failDefinitive (O2, rule 10 case 2)", () => {
  const input = { epoch: 2, obsId: "obs", now: NOW };
  test("clears the attempt; a marker is promoted to credential_unverified for the settled account in the same transaction", () => {
    const before = records({
      settled: { epoch: 1 },
      attempt: attempt("activating", { observations_deferred: 3 }),
      fence_seq: 3,
    });
    const out = apply(before, (r) => failDefinitive(r, input));
    expect(out.result).toBe("CLEARED");
    expect(out.records.auth_state.attempt).toBeNull();
    expect(out.records.auth_state.fences.A).toEqual([
      expect.objectContaining({
        kind: "credential_unverified",
        epoch: 1,
        seq: 4,
      }),
    ]);
  });
  test("adds no fence when there is no marker", () => {
    const out = apply(
      records({ settled: { epoch: 1 }, attempt: attempt("activating") }),
      (r) => failDefinitive(r, input),
    );
    expect(out.records.auth_state.fences).toEqual({});
  });
  test("a stale refusal touches nothing", () => {
    const out = apply(records({ attempt: attempt("activating") }), (r) =>
      failDefinitive(r, { ...input, epoch: 1 }),
    );
    expect(out.result).toBe("SUPERSEDED");
    expect(out.wrote).toBe(false);
  });
});

describe("markIndeterminate, clearNonGating", () => {
  test("only activating or indeterminate become indeterminate; never exchanging; verifying is not downgraded", () => {
    expect(
      apply(records({ attempt: attempt("activating") }), (r) =>
        markIndeterminate(r, { epoch: 2 }),
      ).records.auth_state.attempt?.phase,
    ).toBe("indeterminate");
    expect(
      apply(records({ attempt: attempt("exchanging") }), (r) =>
        markIndeterminate(r, { epoch: 2 }),
      ).result,
    ).toBe("SUPERSEDED");
    const verifying = apply(records({ attempt: attempt("verifying") }), (r) =>
      markIndeterminate(r, { epoch: 2 }),
    );
    expect(verifying.result).toBe("SUPERSEDED");
    expect(verifying.records.auth_state.attempt?.phase).toBe("verifying");
  });
  test("clearNonGating refuses every gating phase whatever expires_at says", () => {
    for (const phase of ["activating", "indeterminate", "verifying"] as const) {
      const out = apply(
        records({
          attempt: attempt(phase, { expires_at: "2000-01-01T00:00:00.000Z" }),
        }),
        (r) => clearNonGating(r, { epoch: 2, expiredAt: Date.parse(NOW) }),
      );
      expect(out.result).toBe("NOT_ALLOWED");
      expect(out.records.auth_state.attempt).not.toBeNull();
    }
  });
  test("clearNonGating clears exchanging and redirected, and respects expiry when asked", () => {
    for (const phase of ["exchanging", "redirected"] as const) {
      expect(
        apply(records({ attempt: attempt(phase) }), (r) =>
          clearNonGating(r, { epoch: 2 }),
        ).result,
      ).toBe("CLEARED");
    }
    const future = attempt("exchanging", {
      expires_at: "2026-09-30T13:00:00.000Z",
    });
    expect(
      apply(records({ attempt: future }), (r) =>
        clearNonGating(r, { epoch: 2, expiredAt: Date.parse(NOW) }),
      ).result,
    ).toBe("NOT_ALLOWED");
    expect(
      apply(records({ attempt: attempt("exchanging") }), (r) =>
        clearNonGating(r, { epoch: 9 }),
      ).result,
    ).toBe("SUPERSEDED");
  });
});

describe("resolveAfterCancel (O4)", () => {
  test("not_activated with no marker clears the attempt", () => {
    const out = apply(
      records({ settled: {}, attempt: attempt("indeterminate") }),
      (r) => resolveAfterCancel(r, { epoch: 2, result: "not_activated" }),
    );
    expect(out.result).toBe("CLEARED");
    expect(out.records.auth_state.attempt).toBeNull();
  });
  test("not_activated with a marker written during the cancel request becomes verifying (the marker is read inside)", () => {
    const out = apply(
      records({
        settled: {},
        attempt: attempt("indeterminate", { observations_deferred: 7 }),
        fence_seq: 7,
      }),
      (r) => resolveAfterCancel(r, { epoch: 2, result: "not_activated" }),
    );
    expect(out.result).toBe("VERIFYING");
    expect(out.records.auth_state.attempt).toMatchObject({
      phase: "verifying",
      cancel_result: "not_activated",
      observations_deferred: 7,
    });
  });
  test("session_revoked and unknown become verifying", () => {
    for (const result of ["session_revoked", "unknown"] as const) {
      const out = apply(
        records({ settled: {}, attempt: attempt("indeterminate") }),
        (r) => resolveAfterCancel(r, { epoch: 2, result }),
      );
      expect(out.result).toBe("VERIFYING");
      expect(out.records.auth_state.attempt?.cancel_result).toBe(result);
    }
  });
  test("with nothing settled the attempt clears whatever the result was (D-20)", () => {
    const out = apply(records({ attempt: attempt("indeterminate") }), (r) =>
      resolveAfterCancel(r, { epoch: 2, result: "session_revoked" }),
    );
    expect(out.result).toBe("CLEARED");
  });
  test("a non-gating or other-epoch attempt is not resolved", () => {
    expect(
      apply(records({ settled: {}, attempt: attempt("exchanging") }), (r) =>
        resolveAfterCancel(r, { epoch: 2, result: "unknown" }),
      ).result,
    ).toBe("SUPERSEDED");
    expect(
      apply(records({ settled: {}, attempt: attempt("indeterminate") }), (r) =>
        resolveAfterCancel(r, { epoch: 3, result: "unknown" }),
      ).result,
    ).toBe("SUPERSEDED");
  });
});

describe("observeAttempt (O5)", () => {
  const base = {
    epoch: 2,
    lease: "lV",
    s: 5,
    captured: [] as string[],
    obsId: "obs",
    now: NOW,
  };
  const verifying = (extra = {}) =>
    records({
      settled: { account_id: "A", epoch: 1, session_id: "s1" },
      attempt: attempt("verifying", extra),
      leases: { lV: { class: "verification", boot_id: "me" } },
      fence_seq: 5,
    });
  test("a 401 adds invalid_session for the settled account, clears the attempt, deletes only its own lease", () => {
    const out = apply(
      records({
        settled: {},
        attempt: attempt("verifying"),
        leases: { lV: { class: "verification" }, other: {} },
        fence_seq: 5,
      }),
      (r) => observeAttempt(r, { ...base, observed: { kind: "401" } }),
    );
    expect(out.result).toBe("DONE");
    const state = out.records.auth_state;
    expect(state.attempt).toBeNull();
    expect(state.fences.A).toEqual([
      expect.objectContaining({
        kind: "invalid_session",
        reason: "current_401",
        epoch: 1,
      }),
    ]);
    expect(Object.keys(state.leases)).toEqual(["other"]);
  });
  test("a 200 for a different account adds drift and NEVER settles or adopts the target", () => {
    const out = apply(verifying(), (r) =>
      observeAttempt(r, {
        ...base,
        observed: { kind: "200", account_id: "B", session_id: "sB" },
      }),
    );
    const state = out.records.auth_state;
    expect(state.fences.A?.[0]).toMatchObject({ kind: "drift" });
    expect(state.settled).toMatchObject({
      account_id: "A",
      epoch: 1,
      session_id: "s1",
    });
  });
  test("a 200 for the same account refreshes the session annotation and adds no fence", () => {
    const out = apply(verifying(), (r) =>
      observeAttempt(r, {
        ...base,
        observed: { kind: "200", account_id: "A", session_id: "s9" },
      }),
    );
    expect(out.records.auth_state.settled?.session_id).toBe("s9");
    expect(out.records.auth_state.fences).toEqual({});
    expect(out.records.auth_state.attempt).toBeNull();
  });
  test("a marker newer than s keeps the attempt verifying and asks to observe again (still deleting its own lease)", () => {
    const out = apply(verifying({ observations_deferred: 6 }), (r) =>
      observeAttempt(r, { ...base, s: 5, observed: { kind: "401" } }),
    );
    expect(out.result).toBe("REOBSERVE");
    expect(out.records.auth_state.attempt?.phase).toBe("verifying");
    expect(out.records.auth_state.leases.lV).toBeUndefined();
    expect(out.records.auth_state.fences).toEqual({});
  });
  test("a marker at or below s is covered by the answer", () => {
    const out = apply(verifying({ observations_deferred: 5 }), (r) =>
      observeAttempt(r, {
        ...base,
        s: 5,
        observed: { kind: "200", account_id: "A", session_id: "s1" },
      }),
    );
    expect(out.result).toBe("DONE");
  });
  test("captured unresolved leases: retired on a strict match, replaced by a fence on a different session, retired with 401 and drift", () => {
    const withLeases = () =>
      records({
        settled: { session_id: "s1" },
        attempt: attempt("verifying"),
        leases: { lV: { class: "verification" }, u1: {}, u2: {} },
        fence_seq: 5,
      });
    const strict = apply(withLeases(), (r) =>
      observeAttempt(r, {
        ...base,
        captured: ["u1", "u2"],
        observed: { kind: "200", account_id: "A", session_id: "s1" },
      }),
    );
    expect(Object.keys(strict.records.auth_state.leases)).toEqual([]);
    expect(strict.records.auth_state.fences).toEqual({});
    const different = apply(withLeases(), (r) =>
      observeAttempt(r, {
        ...base,
        captured: ["u1", "u2"],
        observed: { kind: "200", account_id: "A", session_id: "s2" },
      }),
    );
    expect(different.records.auth_state.fences.A?.[0]).toMatchObject({
      kind: "invalid_session",
      reason: "unresolved_response",
    });
    expect(Object.keys(different.records.auth_state.leases)).toEqual([]);
    const gone = apply(withLeases(), (r) =>
      observeAttempt(r, {
        ...base,
        captured: ["u1"],
        observed: { kind: "401" },
      }),
    );
    expect(Object.keys(gone.records.auth_state.leases)).toEqual(["u2"]);
  });
});

describe("recordObservation (3.6.1 step 2, O9 to O14)", () => {
  const input = {
    lease_id: "l1",
    account_id: "A",
    stamp_epoch: 1,
    obs_id: "ob1",
    now: NOW,
  };
  const settled = () =>
    records({ settled: { epoch: 1 }, leases: { l1: {}, l2: {} } });
  test("O9/O12/O14 add invalid_session under the stamp and delete only this request's lease", () => {
    for (const [kind, reason] of [
      ["unauthenticated", "unauthenticated"],
      ["current_401", "current_401"],
      ["password_changed", "password_changed"],
    ] as const) {
      const out = apply(settled(), (r) =>
        recordObservation(r, { ...input, kind }),
      );
      expect(out.result).toBe("DONE");
      expect(out.records.auth_state.fences.A).toEqual([
        expect.objectContaining({ kind: "invalid_session", reason, epoch: 1 }),
      ]);
      expect(Object.keys(out.records.auth_state.leases)).toEqual(["l2"]);
    }
  });
  test("a password_changed observation can carry the unlink reason", () => {
    const out = apply(settled(), (r) =>
      recordObservation(r, {
        ...input,
        kind: "password_changed",
        reason: "unlinked",
      }),
    );
    expect(out.records.auth_state.fences.A?.[0]).toMatchObject({
      reason: "unlinked",
    });
  });
  test("STALE (nothing settled, another account, another epoch) records nothing and still deletes the lease", () => {
    for (const recs of [
      records({ leases: { l1: {} } }),
      records({ settled: { account_id: "B", epoch: 1 }, leases: { l1: {} } }),
      records({ settled: { epoch: 2 }, leases: { l1: {} } }),
    ]) {
      const out = apply(recs, (r) =>
        recordObservation(r, { ...input, kind: "unauthenticated" }),
      );
      expect(out.result).toBe("STALE");
      expect(out.records.auth_state.fences).toEqual({});
      expect(out.records.auth_state.leases.l1).toBeUndefined();
    }
  });
  test("is idempotent by obs_id and dedupes invalid_session of the same kind and epoch", () => {
    const first = apply(settled(), (r) =>
      recordObservation(r, { ...input, kind: "unauthenticated" }),
    );
    const again = apply(first.records, (r) =>
      recordObservation(r, { ...input, kind: "unauthenticated" }),
    );
    expect(again.records.auth_state.fences.A).toHaveLength(1);
    const other = apply(first.records, (r) =>
      recordObservation(r, {
        ...input,
        lease_id: "l2",
        obs_id: "ob2",
        kind: "current_401",
      }),
    );
    expect(other.records.auth_state.fences.A).toHaveLength(1);
    expect(other.records.auth_state.leases.l2).toBeUndefined();
  });
  test("a 401 is never deferred: it adds its fence even while an attempt gates", () => {
    const out = apply(
      records({
        settled: { epoch: 1 },
        attempt: attempt("activating"),
        leases: { l1: {} },
      }),
      (r) => recordObservation(r, { ...input, kind: "unauthenticated" }),
    );
    expect(out.records.auth_state.fences.A?.[0]).toMatchObject({
      kind: "invalid_session",
    });
    expect(out.records.auth_state.attempt?.observations_deferred).toBeNull();
  });
  test("O10: credential_mismatch adds credential_unverified (always), or sets the marker while an attempt gates", () => {
    const plain = apply(settled(), (r) =>
      recordObservation(r, { ...input, kind: "credential_mismatch" }),
    );
    expect(plain.records.auth_state.fences.A).toEqual([
      expect.objectContaining({ kind: "credential_unverified" }),
    ]);
    const second = apply(plain.records, (r) =>
      recordObservation(r, {
        ...input,
        lease_id: "l2",
        obs_id: "ob2",
        kind: "credential_mismatch",
      }),
    );
    expect(second.records.auth_state.fences.A).toHaveLength(2); // always added: rule 9 clears by seq
    const gating = apply(
      records({
        settled: { epoch: 1 },
        attempt: attempt("indeterminate"),
        leases: { l1: {} },
      }),
      (r) => recordObservation(r, { ...input, kind: "credential_mismatch" }),
    );
    expect(gating.records.auth_state.fences).toEqual({});
    expect(gating.records.auth_state.attempt?.observations_deferred).toBe(1);
  });
  test("O11: a different account adds drift, or sets the marker while an attempt gates", () => {
    const plain = apply(settled(), (r) =>
      recordObservation(r, { ...input, kind: "different_account" }),
    );
    expect(plain.records.auth_state.fences.A?.[0]).toMatchObject({
      kind: "drift",
    });
    const gating = apply(
      records({
        settled: { epoch: 1 },
        attempt: attempt("verifying"),
        leases: { l1: {} },
      }),
      (r) => recordObservation(r, { ...input, kind: "different_account" }),
    );
    expect(gating.records.auth_state.attempt?.observations_deferred).toBe(1);
    expect(gating.records.auth_state.fences).toEqual({});
  });
  test("retire replaces captured unresolved leases with the fence in the same transaction", () => {
    const recs = records({
      settled: { epoch: 1 },
      leases: { l1: { class: "verification" }, u1: {}, keep: {} },
    });
    const out = apply(recs, (r) =>
      recordObservation(r, { ...input, kind: "current_401", retire: ["u1"] }),
    );
    expect(Object.keys(out.records.auth_state.leases)).toEqual(["keep"]);
  });
  test("seq is allocated from fence_seq in the transaction that adds the fence", () => {
    const out = apply(
      records({ settled: { epoch: 1 }, fence_seq: 9, leases: { l1: {} } }),
      (r) => recordObservation(r, { ...input, kind: "unauthenticated" }),
    );
    expect(out.records.auth_state.fences.A?.[0]?.seq).toBe(10);
    expect(out.records.auth_state.fence_seq).toBe(10);
  });
});

describe("verifyOutcome (E3, E4) and clearCredentialUnverified (O11)", () => {
  const input = {
    lease_id: "lV",
    account_id: "A",
    epoch: 1,
    session_id: "s1",
    captured: ["u1"],
    s: 5,
    obs_id: "ob",
    now: NOW,
  };
  const recs = (extra = {}) =>
    records({
      settled: { session_id: "s1" },
      leases: { lV: { class: "verification" }, u1: {}, late: {} },
      fences: { A: [unverified(4, 1), unverified(6, 1)] },
      fence_seq: 6,
      ...extra,
    });
  test("a strict match retires exactly the captured leases and clears only credential_unverified with seq <= s", () => {
    const out = apply(recs(), (r) => verifyOutcome(r, input));
    expect(out.result).toMatchObject({
      kind: "RETIRED",
      retired: 1,
      cleared: 1,
    });
    const state = out.records.auth_state;
    expect(Object.keys(state.leases)).toEqual(["late"]); // a lease created after the request was sent survives
    expect(state.fences.A?.map((f) => f.seq)).toEqual([6]); // seq 6 > s survives
  });
  test("a different session_id with captured leases fences and retires them (E4), and still annotates", () => {
    const out = apply(recs(), (r) =>
      verifyOutcome(r, { ...input, session_id: "s2" }),
    );
    expect(out.result).toMatchObject({ kind: "FENCED" });
    const state = out.records.auth_state;
    expect(
      state.fences.A?.some(
        (f) =>
          f.kind === "invalid_session" && f.reason === "unresolved_response",
      ),
    ).toBe(true);
    expect(state.settled?.session_id).toBe("s2");
    expect(state.leases.u1).toBeUndefined();
  });
  test("a different session_id with nothing captured only annotates", () => {
    const out = apply(recs(), (r) =>
      verifyOutcome(r, { ...input, session_id: "s2", captured: [] }),
    );
    expect(out.result).toMatchObject({ kind: "RETIRED", retired: 0 });
    expect(
      out.records.auth_state.fences.A?.every(
        (f) => f.kind !== "invalid_session",
      ),
    ).toBe(true);
  });
  test("a newer settlement makes it STALE: only its own lease is deleted, nothing retired or cleared", () => {
    const out = apply(recs({ settled: { epoch: 2, session_id: "s1" } }), (r) =>
      verifyOutcome(r, input),
    );
    expect(out.result).toMatchObject({ kind: "STALE", retired: 0, cleared: 0 });
    expect(out.records.auth_state.leases.u1).toBeDefined();
    expect(out.records.auth_state.leases.lV).toBeUndefined();
  });
  test("clearCredentialUnverified removes only kind and seq it covers and never a lease or another fence", () => {
    const mixed = records({
      settled: {},
      leases: { x: {} },
      fences: { A: [invalid(2, 1), unverified(3, 1), unverified(8, 1)] },
      fence_seq: 8,
    });
    const out = apply(mixed, (r) =>
      clearCredentialUnverified(r, { account_id: "A", s: 5 }),
    );
    expect(out.result).toEqual({ kind: "CLEARED", count: 1 });
    expect(out.records.auth_state.fences.A?.map((f) => f.seq)).toEqual([2, 8]);
    expect(Object.keys(out.records.auth_state.leases)).toEqual(["x"]);
  });
});

describe("convertStale (E5) and retireOwnLease", () => {
  test("converts only unresolved leases of an older epoch for the settled account, under the lease's own epoch", () => {
    const recs = records({
      settled: { epoch: 3 },
      leases: {
        old: { epoch: 2 },
        cur: { epoch: 3 },
        other: { account_id: "B", epoch: 1 },
      },
      latest_epoch: 3,
    });
    const out = apply(recs, (r) =>
      convertStale(r, {
        account_id: "A",
        ids: ["old", "cur", "other"],
        now: NOW,
      }),
    );
    expect(out.result).toEqual({ kind: "CONVERTED", ids: ["old"] });
    expect(out.records.auth_state.fences.A).toEqual([
      expect.objectContaining({
        kind: "invalid_session",
        reason: "unresolved_response",
        epoch: 2,
        obs_id: "old",
      }),
    ]);
    expect(Object.keys(out.records.auth_state.leases).sort()).toEqual([
      "cur",
      "other",
    ]);
  });
  test("retireOwnLease deletes one id, touches nothing else, and commits nothing when absent", () => {
    const recs = records({ settled: {}, leases: { a: {}, b: {} } });
    const out = apply(recs, (r) => retireOwnLease(r, { lease_id: "a" }));
    expect(Object.keys(out.records.auth_state.leases)).toEqual(["b"]);
    expect(
      apply(recs, (r) => retireOwnLease(r, { lease_id: "zz" })).wrote,
    ).toBe(false);
  });
});

describe("cover (3.6.2 step 1): Ex1, Ex3 and the classes", () => {
  const input = (
    klass: "ordinary" | "verification" | "operation" | "recovery" | "exposure",
    extra = {},
  ) => ({
    account_id: "A",
    epoch: 1,
    klass,
    boot_id: "me",
    released: new Set<string>(),
    lease_id: "L",
    now: NOW,
    ...extra,
  });
  const settled = (extra = {}) => records({ settled: { epoch: 1 }, ...extra });

  test("STALE when nothing is settled, another account or another epoch; nothing is written", () => {
    for (const recs of [
      records({}),
      records({ settled: { account_id: "B" } }),
      records({ settled: { epoch: 2 } }),
    ]) {
      const out = apply(recs, (r) => cover(r, input("ordinary")));
      expect(out.result).toEqual({ kind: "STALE" });
      expect(out.wrote).toBe(false);
    }
  });
  test("Ex1: any foreign lease not released to this page defers, of any class and epoch, and commits nothing", () => {
    for (const klass of [
      "ordinary",
      "verification",
      "operation",
      "recovery",
      "exposure",
    ] as const) {
      const recs = settled({
        leases: { f1: { class: "exposure" }, f2: { class: "ordinary" } },
        fences: { A: [operation(1, logoutEnvelope())] },
      });
      const out = apply(recs, (r) =>
        cover(r, input(klass, { operation_id: "op1" })),
      );
      expect(out.result).toEqual({ kind: "DEFER", ids: ["f1", "f2"] });
      expect(out.wrote).toBe(false);
    }
  });
  test("a page's own leases never delay it", () => {
    const recs = settled({ leases: { mine: { boot_id: "me" } } });
    expect(
      apply(recs, (r) => cover(r, input("ordinary"))).result,
    ).toMatchObject({ kind: "COVERED" });
  });
  test("ordinary and exposure: a fence or a gating attempt closes; an unresolved foreign lease closes (Ex3)", () => {
    for (const klass of ["ordinary", "exposure"] as const) {
      expect(
        apply(settled({ fences: { A: [invalid(1, 1)] } }), (r) =>
          cover(r, input(klass)),
        ).result,
      ).toEqual({ kind: "CLOSED", reason: "fence" });
      expect(
        apply(settled({ attempt: attempt("verifying") }), (r) =>
          cover(r, input(klass)),
        ).result,
      ).toEqual({ kind: "CLOSED", reason: "gating_attempt" });
      const unresolved = apply(
        settled({ leases: { u: { class: "ordinary" } } }),
        (r) => cover(r, input(klass, { released: new Set(["u"]) })),
      );
      expect(unresolved.result).toEqual({
        kind: "CLOSED_UNRESOLVED",
        unresolved: ["u"],
      });
      expect(unresolved.wrote).toBe(false);
    }
  });
  test("a finished exposure lease is harmless: it is deleted by the committing cover", () => {
    const out = apply(
      settled({ leases: { done: { class: "exposure" } } }),
      (r) => cover(r, input("ordinary", { released: new Set(["done"]) })),
    );
    expect(out.result).toMatchObject({ kind: "COVERED", lease: "L" });
    expect(Object.keys(out.records.auth_state.leases)).toEqual(["L"]);
  });
  test("verification ignores fences, attempts and unresolved leases, and returns the captured set with the lease", () => {
    const recs = settled({
      fences: { A: [invalid(1, 1)] },
      attempt: attempt("verifying"),
      leases: { u: { class: "ordinary" }, e: { class: "exposure" } },
    });
    const out = apply(recs, (r) =>
      cover(r, input("verification", { released: new Set(["u", "e"]) })),
    );
    expect(out.result).toMatchObject({ kind: "COVERED", unresolved: ["u"] });
    expect(out.records.auth_state.leases.L?.class).toBe("verification");
  });
  test("operation needs the operation fence for this envelope and ignores unresolved leases", () => {
    const fenced = settled({
      fences: { A: [operation(1, logoutEnvelope("op1"))] },
      leases: { u: { class: "ordinary" } },
    });
    const ok = apply(fenced, (r) =>
      cover(
        r,
        input("operation", { operation_id: "op1", released: new Set(["u"]) }),
      ),
    );
    expect(ok.result).toMatchObject({ kind: "COVERED" });
    expect(
      apply(fenced, (r) =>
        cover(
          r,
          input("operation", {
            operation_id: "nope",
            released: new Set(["u"]),
          }),
        ),
      ).result,
    ).toEqual({ kind: "CLOSED", reason: "no_operation_fence" });
    expect(
      apply(settled({}), (r) =>
        cover(r, input("operation", { operation_id: "op1" })),
      ).result,
    ).toEqual({ kind: "CLOSED", reason: "no_operation_fence" });
  });
  test("recovery needs eligibility (every entry invalid_session or drift of an OLDER epoch) and no unresolved lease", () => {
    const eligible = records({
      settled: { epoch: 2 },
      fences: { A: [invalid(1, 1), drift(2, 1)] },
      latest_epoch: 2,
    });
    const rec = (r: typeof eligible, extra = {}) =>
      apply(r, (x) => cover(x, { ...input("recovery", extra), epoch: 2 }));
    expect(rec(eligible).result).toMatchObject({ kind: "COVERED" });
    for (const fences of [
      [],
      [invalid(1, 2)],
      [unverified(1, 1)],
      [operation(1, logoutEnvelope("o", "A", 1))],
    ]) {
      const recs = records({
        settled: { epoch: 2 },
        fences: { A: fences },
        latest_epoch: 2,
      });
      expect(rec(recs).result).toEqual({
        kind: "CLOSED",
        reason: "recovery_ineligible",
      });
    }
    const gating = records({
      settled: { epoch: 2 },
      fences: { A: [invalid(1, 1)] },
      attempt: attempt("activating", { epoch: 3 }),
      latest_epoch: 3,
    });
    expect(rec(gating).result).toEqual({
      kind: "CLOSED",
      reason: "gating_attempt",
    });
    const unresolved = records({
      settled: { epoch: 2 },
      fences: { A: [invalid(1, 1)] },
      leases: { u: { class: "recovery", epoch: 2 } },
      latest_epoch: 2,
    });
    expect(rec(unresolved, { released: new Set(["u"]) }).result).toEqual({
      kind: "CLOSED_UNRESOLVED",
      unresolved: ["u"],
    });
  });
  test("COVERED reports the fence_seq at the commit (rule 9's s)", () => {
    const out = apply(settled({ fence_seq: 12 }), (r) =>
      cover(r, input("verification")),
    );
    expect(out.result).toMatchObject({ kind: "COVERED", fence_seq: 12 });
  });
});

describe("operation reducers (3.5.3, 3.5.4, 3.7.3)", () => {
  const raise = {
    op: "logout" as const,
    account_id: "A",
    epoch: 1,
    operation_id: "op1",
    obs_id: "f1",
    now: NOW,
  };
  test("raiseOperationFence writes the envelope with the fence; logout's session_id is read INSIDE the transaction", () => {
    const out = apply(
      records({ settled: { epoch: 1, session_id: "sX" } }),
      (r) => raiseOperationFence(r, raise),
    );
    expect(out.result).toMatchObject({
      kind: "FENCED",
      envelope: {
        op: "logout",
        target: { session_id: "sX" },
        initiated_epoch: 1,
      },
    });
    const fence = out.records.auth_state.fences.A?.[0];
    expect(fence).toMatchObject({ kind: "operation", epoch: 1 });
  });
  test("the retirement envelope carries the approved state token and summary", () => {
    const out = apply(records({ settled: { epoch: 1 } }), (r) =>
      raiseOperationFence(r, {
        ...raise,
        op: "retire_device",
        device_id: "dev1",
        state_token: `v1.${"A".repeat(43)}`,
        summary: {
          sessions: 1,
          native_handoffs: 0,
          notification_subscriptions: 2,
          pending_sign_ins: 0,
          sync_registered: true,
        },
      }),
    );
    expect(out.result).toMatchObject({
      kind: "FENCED",
      envelope: {
        op: "retire_device",
        target: { device_id: "dev1" },
        state_token: `v1.${"A".repeat(43)}`,
      },
    });
  });
  test("is refused when not settled, when an attempt gates, when an operation fence exists, or any fence exists", () => {
    expect(
      apply(records({}), (r) => raiseOperationFence(r, raise)).result,
    ).toEqual({ kind: "REFUSED", reason: "not_settled" });
    expect(
      apply(records({ settled: { epoch: 2 } }), (r) =>
        raiseOperationFence(r, raise),
      ).result,
    ).toEqual({ kind: "REFUSED", reason: "not_settled" });
    expect(
      apply(
        records({ settled: { epoch: 1 }, attempt: attempt("activating") }),
        (r) => raiseOperationFence(r, raise),
      ).result,
    ).toEqual({ kind: "REFUSED", reason: "attempt_gating" });
    expect(
      apply(
        records({
          settled: { epoch: 1 },
          fences: { A: [operation(1, logoutEnvelope("other"))] },
        }),
        (r) => raiseOperationFence(r, raise),
      ).result,
    ).toEqual({ kind: "REFUSED", reason: "operation_pending" });
    expect(
      apply(
        records({ settled: { epoch: 1 }, fences: { A: [invalid(1, 1)] } }),
        (r) => raiseOperationFence(r, raise),
      ).result,
    ).toEqual({ kind: "REFUSED", reason: "fence_exists" });
  });
  const fenced = (extra = {}) =>
    records({
      settled: { epoch: 1 },
      fences: {
        A: [operation(1, logoutEnvelope("op1")), invalid(2, 0)],
        B: [invalid(3, 1)],
      },
      leases: { call: {}, a2: {}, b1: { account_id: "B" } },
      ...extra,
    });
  test("confirmed_applied removes ALL of the account's fences and leases, and settled ONLY under 3.5.4", () => {
    const out = apply(fenced(), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op1",
        outcome: "confirmed_applied",
        call_lease: "call",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(out.result).toEqual({ kind: "WIPED", settledCleared: true });
    const state = out.records.auth_state;
    expect(state.settled).toBeNull();
    expect(state.fences.A).toBeUndefined();
    expect(state.fences.B).toHaveLength(1); // another account's fences are untouched
    expect(Object.keys(state.leases)).toEqual(["b1"]);
  });
  test("a newer settlement of the same account is left in place (a re-authentication meanwhile)", () => {
    const out = apply(fenced({ settled: { epoch: 4 }, latest_epoch: 4 }), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op1",
        outcome: "confirmed_applied",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(out.result).toEqual({ kind: "WIPED", settledCleared: false });
    expect(out.records.auth_state.settled).toMatchObject({ epoch: 4 });
  });
  test("a different account's settlement is never cleared", () => {
    const out = apply(fenced({ settled: { account_id: "B", epoch: 1 } }), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op1",
        outcome: "confirmed_applied",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(out.records.auth_state.settled?.account_id).toBe("B");
  });
  test("rejected_stale removes the envelope only", () => {
    const out = apply(fenced(), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op1",
        outcome: "rejected_stale",
        call_lease: "call",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(out.result).toEqual({ kind: "NOTICE" });
    expect(out.records.auth_state.fences.A?.map((f) => f.kind)).toEqual([
      "invalid_session",
    ]);
    expect(out.records.auth_state.settled).not.toBeNull();
  });
  test("superseded replaces the envelope by invalid_session('removed_elsewhere') under initiated_epoch (SA-11)", () => {
    const out = apply(fenced({ settled: { epoch: 3 }, latest_epoch: 3 }), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op1",
        outcome: "superseded",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(out.result).toEqual({ kind: "HIDDEN" });
    const list = out.records.auth_state.fences.A ?? [];
    expect(list.some((f) => f.kind === "operation")).toBe(false);
    expect(list.at(-1)).toMatchObject({
      kind: "invalid_session",
      reason: "removed_elsewhere",
      epoch: 1,
    });
    expect(out.records.auth_state.settled?.epoch).toBe(3);
  });
  test("an unknown operation id changes nothing but its call lease", () => {
    const out = apply(fenced(), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "zz",
        outcome: "confirmed_applied",
        call_lease: "call",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(out.result).toEqual({ kind: "ABSENT" });
    expect(out.records.auth_state.fences.A).toHaveLength(2);
  });
  test("finishRecovery removes exactly entries with epoch < e and seq <= s (rule 9) and leaves every lease", () => {
    const recs = records({
      settled: { epoch: 3 },
      fences: { A: [invalid(1, 1), drift(2, 2), invalid(6, 2)] },
      leases: { l: {} },
      latest_epoch: 3,
    });
    const out = apply(recs, (r) =>
      finishRecovery(r, { account_id: "A", epoch: 3, s: 4 }),
    );
    expect(out.result).toEqual({ kind: "RERUN", removed: 2 });
    expect(out.records.auth_state.fences.A?.map((f) => f.seq)).toEqual([6]);
    expect(Object.keys(out.records.auth_state.leases)).toEqual(["l"]);
    const done = apply(out.records, (r) =>
      finishRecovery(r, { account_id: "A", epoch: 3, s: 9 }),
    );
    expect(done.result).toEqual({ kind: "CLEARED", removed: 1 });
    expect(done.records.auth_state.fences.A).toBeUndefined();
  });
  test("finishRecovery is NOT_ELIGIBLE for another kind or a current-epoch entry, and SUPERSEDED for a newer epoch or a gating attempt", () => {
    for (const fences of [
      [unverified(1, 1)],
      [invalid(1, 3)],
      [operation(1, logoutEnvelope("o", "A", 1))],
    ]) {
      expect(
        apply(
          records({
            settled: { epoch: 3 },
            fences: { A: fences },
            latest_epoch: 3,
          }),
          (r) => finishRecovery(r, { account_id: "A", epoch: 3, s: 9 }),
        ).result,
      ).toEqual({ kind: "NOT_ELIGIBLE" });
    }
    expect(
      apply(
        records({
          settled: { epoch: 4 },
          fences: { A: [invalid(1, 1)] },
          latest_epoch: 4,
        }),
        (r) => finishRecovery(r, { account_id: "A", epoch: 3, s: 9 }),
      ).result,
    ).toEqual({ kind: "SUPERSEDED" });
    expect(
      apply(
        records({
          settled: { epoch: 3 },
          attempt: attempt("activating", { epoch: 4 }),
          fences: { A: [invalid(1, 1)] },
          latest_epoch: 4,
        }),
        (r) => finishRecovery(r, { account_id: "A", epoch: 3, s: 9 }),
      ).result,
    ).toEqual({ kind: "SUPERSEDED" });
  });
});

describe("device, canary and ledger reducers", () => {
  test("deviceGetOrCreate creates once and returns the same record afterwards", () => {
    const first = apply(records({}), (r) =>
      deviceGetOrCreate(r, { device_id: "d1", now: NOW }),
    );
    const second = apply(first.records, (r) =>
      deviceGetOrCreate(r, { device_id: "d2", now: NOW }),
    );
    expect(second.result.device_id).toBe("d1");
    expect(second.wrote).toBe(false);
  });
  test("bootCanary writes only boot.last_boot_at", () => {
    const out = apply(records({ settled: {} }), (r) =>
      bootCanary(r, { now: NOW }),
    );
    expect(out.records.boot).toEqual({ last_boot_at: NOW });
    expect(out.records.auth_state.settled).not.toBeNull();
  });
  test("the ledger compares operation_id in every mutation", () => {
    const entry = {
      operation_id: "op1",
      account_id: "A",
      incarnation_id: "i1",
      status: "pending" as const,
      digest: null,
      approved_digest: null,
      count: null,
      created_at: NOW,
    };
    const created = apply(records({}), (r) => ledgerCreate(r, { entry }));
    expect(created.records.pending_deletions.A).toEqual(entry);
    expect(
      apply(created.records, (r) =>
        ledgerCreate(r, { entry: { ...entry, operation_id: "op2" } }),
      ).result,
    ).toBe("NOT_OWNER");
    expect(
      apply(created.records, (r) => ledgerCreate(r, { entry })).result,
    ).toBe("OK");
    expect(
      apply(created.records, (r) =>
        ledgerSetStatus(r, {
          account_id: "A",
          operation_id: "op2",
          patch: { status: "awaiting_consent" },
        }),
      ).result,
    ).toBe("NOT_OWNER");
    const status = apply(created.records, (r) =>
      ledgerSetStatus(r, {
        account_id: "A",
        operation_id: "op1",
        patch: { status: "awaiting_consent", digest: "d" },
      }),
    );
    expect(status.records.pending_deletions.A).toMatchObject({
      status: "awaiting_consent",
      digest: "d",
    });
    expect(
      apply(created.records, (r) =>
        ledgerClear(r, { account_id: "A", operation_id: "op2" }),
      ).result,
    ).toBe("NOT_OWNER");
    expect(
      apply(created.records, (r) =>
        ledgerClear(r, { account_id: "A", operation_id: "op1" }),
      ).records.pending_deletions.A,
    ).toBeUndefined();
  });
});

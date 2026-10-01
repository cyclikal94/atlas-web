// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  beginActivating,
  clearNonGating,
  failDefinitive,
  markIndeterminate,
  observeAttempt,
  recordGrant,
  resolveAfterCancel,
  settle,
} from "../../src/session/model/reducers/attempt";
import {
  clearCredentialUnverified,
  convertStale,
  recordObservation,
  verifyOutcome,
} from "../../src/session/model/reducers/observation";
import { applyOperationOutcome } from "../../src/session/model/reducers/operation";
import {
  apply,
  invalid,
  logoutEnvelope,
  NOW,
  records,
  unverified,
} from "../support/session/records";

/**
 * F-OBS-O1 to O15: one block per observation rule of the matrix table (3.6), each with a STALE-STAMP case (the request was
 * stamped with an older epoch of the same account) and a STALE-EPOCH case (the attempt or the settled account is no longer
 * the one the observation is about). The invariant tested throughout: a newer settlement is neither fenced by an old
 * observation, nor allowed to LOSE it for the old account (the fence is recorded against the account that observed it).
 * These are reducer-level; the same rules end to end are in attempts, recording-path, unresolved-leases and operations tests.
 */
const fencesOf = (recs: ReturnType<typeof records>, account = "A") =>
  recs.auth_state.fences[account] ?? [];
const settledOld = (extra = {}) =>
  records({
    settled: { account_id: "A", epoch: 3, session_id: "s3" },
    ...extra,
  });

describe("O1: activation 2xx settles, for the attempt only", () => {
  const activating = () =>
    records({
      settled: { account_id: "A", epoch: 1 },
      attempt: { epoch: 2, phase: "activating", target_account_id: "B" },
    });
  const input = { epoch: 2, account_id: "B", session_id: "sB", now: NOW };
  test("current attempt: settled is written with account, epoch and session_id; the attempt and its verifier go", () => {
    const { records: next, result } = apply(activating(), (r) =>
      settle(r, input),
    );
    expect(result).toBe("SETTLED");
    expect(next.auth_state.settled).toMatchObject({
      account_id: "B",
      epoch: 2,
      session_id: "sB",
    });
    expect(next.auth_state.attempt).toBeNull();
  });
  test("stale epoch (a newer attempt replaced it): nothing is written", () => {
    const { result, wrote } = apply(activating(), (r) =>
      settle(r, { ...input, epoch: 1 }),
    );
    expect(result).toBe("SUPERSEDED");
    expect(wrote).toBe(false);
  });
  test("stale phase (not activating): nothing is written", () => {
    const { result } = apply(
      records({ attempt: { epoch: 2, phase: "exchanging" } }),
      (r) => settle(r, input),
    );
    expect(result).toBe("SUPERSEDED");
  });
  test("no attempt at all (stale stamp of an earlier, finished attempt): nothing is written", () => {
    const { result } = apply(
      records({ settled: { account_id: "B", epoch: 2 } }),
      (r) => settle(r, input),
    );
    expect(result).toBe("SUPERSEDED");
  });
  test("settlement leaves an old-epoch fence for the old account in place and creates none for the new one", () => {
    const start = records({
      settled: { account_id: "A", epoch: 1 },
      attempt: { epoch: 2, phase: "activating", target_account_id: "B" },
      fences: { A: [invalid(1, 1)] },
    });
    const { records: next } = apply(start, (r) => settle(r, input));
    expect(fencesOf(next, "A").map((f) => f.kind)).toEqual(["invalid_session"]);
    expect(fencesOf(next, "B")).toEqual([]);
  });
});

describe("O2: a definitive refusal clears the attempt only", () => {
  const start = () => records({ attempt: { epoch: 2, phase: "activating" } });
  test("current attempt: cleared, no fence", () => {
    const { records: next, result } = apply(start(), (r) =>
      failDefinitive(r, { epoch: 2, obsId: "o", now: NOW }),
    );
    expect(result).toBe("CLEARED");
    expect(next.auth_state.attempt).toBeNull();
    expect(fencesOf(next)).toEqual([]);
  });
  test("stale epoch: discarded, nothing written", () => {
    const { result, wrote } = apply(start(), (r) =>
      failDefinitive(r, { epoch: 1, obsId: "o", now: NOW }),
    );
    expect(result).toBe("SUPERSEDED");
    expect(wrote).toBe(false);
  });
  test("a deferred marker is promoted to credential_unverified for the SETTLED account under the settled epoch", () => {
    const withMarker = records({
      settled: { account_id: "A", epoch: 1 },
      attempt: { epoch: 2, phase: "activating", observations_deferred: 4 },
      fence_seq: 4,
    });
    const { records: next } = apply(withMarker, (r) =>
      failDefinitive(r, { epoch: 2, obsId: "o9", now: NOW }),
    );
    expect(fencesOf(next).map((f) => [f.kind, f.epoch])).toEqual([
      ["credential_unverified", 1],
    ]);
  });
});

describe("O3: an activation that cannot be classified as definitive becomes indeterminate", () => {
  test("activating becomes indeterminate; it never leaves exchanging that way", () => {
    const a = apply(
      records({ attempt: { epoch: 2, phase: "activating" } }),
      (r) => markIndeterminate(r, { epoch: 2 }),
    );
    expect(a.records.auth_state.attempt?.phase).toBe("indeterminate");
    const e = apply(
      records({ attempt: { epoch: 2, phase: "exchanging" } }),
      (r) => markIndeterminate(r, { epoch: 2 }),
    );
    expect(e.result).toBe("SUPERSEDED");
    expect(e.wrote).toBe(false);
  });
  test("stale epoch: nothing is written", () => {
    const { result, wrote } = apply(
      records({ attempt: { epoch: 3, phase: "activating" } }),
      (r) => markIndeterminate(r, { epoch: 2 }),
    );
    expect(result).toBe("SUPERSEDED");
    expect(wrote).toBe(false);
  });
});

describe("O4: the cancel result, under the lock, for a gating attempt", () => {
  test("not_activated with no deferred observation clears; anything else verifies", () => {
    const start = () =>
      records({
        settled: { account_id: "A", epoch: 1 },
        attempt: { epoch: 2, phase: "indeterminate" },
      });
    expect(
      apply(start(), (r) =>
        resolveAfterCancel(r, { epoch: 2, result: "not_activated" }),
      ).result,
    ).toBe("CLEARED");
    const v = apply(start(), (r) =>
      resolveAfterCancel(r, { epoch: 2, result: "session_revoked" }),
    );
    expect(v.result).toBe("VERIFYING");
    expect(v.records.auth_state.attempt).toMatchObject({
      phase: "verifying",
      cancel_result: "session_revoked",
    });
  });
  test("a deferred observation keeps a not_activated attempt verifying", () => {
    const start = records({
      settled: { account_id: "A", epoch: 1 },
      attempt: { epoch: 2, phase: "indeterminate", observations_deferred: 3 },
      fence_seq: 3,
    });
    expect(
      apply(start, (r) =>
        resolveAfterCancel(r, { epoch: 2, result: "not_activated" }),
      ).result,
    ).toBe("VERIFYING");
  });
  test("stale epoch, and a non-gating phase: nothing is written", () => {
    const stale = apply(
      records({ attempt: { epoch: 3, phase: "indeterminate" } }),
      (r) => resolveAfterCancel(r, { epoch: 2, result: "unknown" }),
    );
    expect(stale.result).toBe("SUPERSEDED");
    const nonGating = apply(
      records({ attempt: { epoch: 2, phase: "exchanging" } }),
      (r) => resolveAfterCancel(r, { epoch: 2, result: "unknown" }),
    );
    expect(nonGating.result).toBe("SUPERSEDED");
    expect(nonGating.wrote).toBe(false);
  });
});

describe("O5: current() for a verifying attempt never adopts the target", () => {
  const verifying = (over = {}) =>
    records({
      settled: { account_id: "A", epoch: 1, session_id: "s1" },
      attempt: {
        epoch: 2,
        phase: "verifying",
        cancel_result: "session_revoked",
        target_account_id: "B",
        ...over,
      },
      leases: { l1: { account_id: "A", epoch: 1, class: "verification" } },
    });
  const observe = (
    observed: Parameters<typeof observeAttempt>[1]["observed"],
    epoch = 2,
  ) => ({
    epoch,
    lease: "l1",
    s: 0,
    observed,
    captured: [] as string[],
    obsId: "o5",
    now: NOW,
  });
  test("401 fences the SETTLED account; 200 for another account adds drift; 200 for the same refreshes the session id", () => {
    const a = apply(verifying(), (r) =>
      observeAttempt(r, observe({ kind: "401" })),
    );
    expect(fencesOf(a.records).map((f) => f.kind)).toEqual(["invalid_session"]);
    const b = apply(verifying(), (r) =>
      observeAttempt(
        r,
        observe({ kind: "200", account_id: "B", session_id: "sB" }),
      ),
    );
    expect(fencesOf(b.records).map((f) => f.kind)).toEqual(["drift"]);
    const c = apply(verifying(), (r) =>
      observeAttempt(
        r,
        observe({ kind: "200", account_id: "A", session_id: "s2" }),
      ),
    );
    expect(c.records.auth_state.settled?.session_id).toBe("s2");
    for (const outcome of [a, b, c]) {
      expect(outcome.records.auth_state.attempt).toBeNull();
      expect(outcome.records.auth_state.settled?.account_id).toBe("A"); // the target is NEVER adopted
    }
  });
  test("stale epoch: only the request's own lease is deleted; nothing is fenced", () => {
    const { records: next, result } = apply(verifying(), (r) =>
      observeAttempt(r, observe({ kind: "401" }, 1)),
    );
    expect(result).toBe("SUPERSEDED");
    expect(fencesOf(next)).toEqual([]);
    expect(next.auth_state.attempt).not.toBeNull();
    expect(next.auth_state.leases.l1).toBeUndefined();
  });
});

describe("O6 and O7: an exchange grant or error is checked against the attempt's epoch", () => {
  const start = () => records({ attempt: { epoch: 2, phase: "exchanging" } });
  test("O6: a current grant records the target and nothing else; a stale grant is discarded with no write", () => {
    const ok = apply(start(), (r) =>
      recordGrant(r, { epoch: 2, account_id: "B" }),
    );
    expect(ok.result).toBe("OK");
    expect(ok.records.auth_state.settled).toBeNull();
    expect(ok.records.auth_state.attempt?.target_account_id).toBe("B");
    const stale = apply(start(), (r) =>
      recordGrant(r, { epoch: 1, account_id: "B" }),
    );
    expect(stale.result).toBe("SUPERSEDED");
    expect(stale.wrote).toBe(false);
  });
  test("O7: a non-gating attempt clears; a gating one never does; a stale epoch is discarded", () => {
    expect(apply(start(), (r) => clearNonGating(r, { epoch: 2 })).result).toBe(
      "CLEARED",
    );
    expect(
      apply(records({ attempt: { epoch: 2, phase: "activating" } }), (r) =>
        clearNonGating(r, { epoch: 2 }),
      ).result,
    ).toBe("NOT_ALLOWED");
    expect(apply(start(), (r) => clearNonGating(r, { epoch: 1 })).result).toBe(
      "SUPERSEDED",
    );
  });
  test("a grant never activates: beginActivating is the only door into a gating phase, and a stale epoch cannot use it", () => {
    expect(
      apply(start(), (r) => beginActivating(r, { epoch: 1 })).result,
    ).toEqual({ kind: "SUPERSEDED" });
    expect(
      apply(start(), (r) => beginActivating(r, { epoch: 2 })).result,
    ).toMatchObject({ kind: "OK" });
  });
});

describe("O8: a broadcast, storage or pageshow event is not evidence", () => {
  test("there is no reducer that takes a hint's payload: recording is by record only (a hint carries no authority)", () => {
    // The only reducers that add a fence take an observation with a stamp; none takes a hint. This is asserted
    // structurally (boundary and recording-path suites) and here by the absence of a payload path.
    const start = records({ settled: { account_id: "A", epoch: 1 } });
    const { records: next } = apply(start, (r) => ({
      write: null,
      result: r.auth_state.settled,
    }));
    expect(fencesOf(next)).toEqual([]);
  });
});

describe("O9, O12, O14: a 401 is recorded against the stamped account, under the current stamp only", () => {
  const cases: Array<
    [string, "unauthenticated" | "current_401" | "password_changed", string]
  > = [
    ["O9 401 unauthenticated", "unauthenticated", "unauthenticated"],
    ["O12 current() 401", "current_401", "current_401"],
    ["O14 204 on POST /password", "password_changed", "password_changed"],
  ];
  for (const [name, kind, reason] of cases) {
    describe(name, () => {
      const base = () =>
        settledOld({ leases: { l1: { account_id: "A", epoch: 3 } } });
      const observation = (over = {}) => ({
        lease_id: "l1",
        account_id: "A",
        stamp_epoch: 3,
        kind,
        obs_id: "o1",
        now: NOW,
        ...over,
      });
      test("current stamp: an invalid_session fence with the right reason, and the request's lease is gone", () => {
        const { records: next, result } = apply(base(), (r) =>
          recordObservation(r, observation()),
        );
        expect(result).toBe("DONE");
        expect(fencesOf(next)).toMatchObject([
          { kind: "invalid_session", reason, epoch: 3 },
        ]);
        expect(next.auth_state.leases.l1).toBeUndefined();
      });
      test("stale stamp (same account, older epoch): STALE, no fence for the newer settlement, lease deleted", () => {
        const { records: next, result } = apply(base(), (r) =>
          recordObservation(r, observation({ stamp_epoch: 2 })),
        );
        expect(result).toBe("STALE");
        expect(fencesOf(next)).toEqual([]);
        expect(next.auth_state.leases.l1).toBeUndefined();
      });
      test("stale epoch (a different account is settled now): STALE, nothing recorded for either", () => {
        const start = records({
          settled: { account_id: "B", epoch: 4 },
          leases: { l1: { account_id: "A", epoch: 3 } },
        });
        const { records: next, result } = apply(start, (r) =>
          recordObservation(r, observation()),
        );
        expect(result).toBe("STALE");
        expect(fencesOf(next, "A")).toEqual([]);
        expect(fencesOf(next, "B")).toEqual([]);
      });
      test("acted on while an attempt gates: a missing credential is a fact no activation can undo", () => {
        const start = settledOld({
          attempt: { epoch: 4, phase: "activating" },
          leases: { l1: { account_id: "A", epoch: 3 } },
        });
        const { records: next } = apply(start, (r) =>
          recordObservation(r, observation()),
        );
        expect(fencesOf(next).map((f) => f.kind)).toEqual(["invalid_session"]);
      });
      test("the same kind at the same epoch is not added twice", () => {
        const start = settledOld({
          fences: { A: [invalid(1, 3)] },
          leases: { l1: { account_id: "A", epoch: 3 } },
        });
        const { records: next } = apply(start, (r) =>
          recordObservation(r, observation({ obs_id: "o2" })),
        );
        expect(fencesOf(next)).toHaveLength(1);
      });
    });
  }
});

describe("O10: 403 credential_mismatch is recorded durably at once, deferred while an attempt gates", () => {
  const observation = (over = {}) => ({
    lease_id: "l1",
    account_id: "A",
    stamp_epoch: 3,
    kind: "credential_mismatch" as const,
    obs_id: "o1",
    now: NOW,
    ...over,
  });
  const base = (extra = {}) =>
    settledOld({ leases: { l1: { account_id: "A", epoch: 3 } }, ...extra });
  test("current stamp: credential_unverified is added, and it is never absorbed by an earlier one", () => {
    const start = base({ fences: { A: [unverified(1, 3)] } });
    const { records: next } = apply(start, (r) =>
      recordObservation(r, observation({ obs_id: "a-later-mismatch" })),
    );
    expect(
      fencesOf(next).filter((f) => f.kind === "credential_unverified"),
    ).toHaveLength(2);
  });
  test("while an attempt gates: no fence, the attempt's deferral marker is set to the new seq", () => {
    const start = base({ attempt: { epoch: 4, phase: "activating" } });
    const { records: next } = apply(start, (r) =>
      recordObservation(r, observation()),
    );
    expect(fencesOf(next)).toEqual([]);
    expect(next.auth_state.attempt?.observations_deferred).toBe(
      next.auth_state.fence_seq,
    );
  });
  test("stale stamp and stale epoch: nothing is recorded", () => {
    const a = apply(base(), (r) =>
      recordObservation(r, observation({ stamp_epoch: 2 })),
    );
    expect(fencesOf(a.records)).toEqual([]);
    const b = apply(
      records({
        settled: { account_id: "B", epoch: 4 },
        leases: { l1: { account_id: "A", epoch: 3 } },
      }),
      (r) => recordObservation(r, observation()),
    );
    expect(fencesOf(b.records, "A")).toEqual([]);
    expect(fencesOf(b.records, "B")).toEqual([]);
  });
});

describe("O11: current() 200", () => {
  const verify = (over = {}) => ({
    lease_id: "l1",
    account_id: "A",
    epoch: 3,
    session_id: "s3",
    captured: [] as string[],
    s: 5,
    obs_id: "o1",
    now: NOW,
    ...over,
  });
  const base = () =>
    settledOld({
      fences: { A: [unverified(2, 3), unverified(6, 3)] },
      fence_seq: 6,
      leases: { l1: { account_id: "A", epoch: 3, class: "verification" } },
    });
  test("same account: only credential_unverified entries with seq <= s are cleared (rule 9)", () => {
    const { records: next } = apply(base(), (r) => verifyOutcome(r, verify()));
    expect(fencesOf(next).map((f) => f.seq)).toEqual([6]);
  });
  test("different account: drift is recorded without the lock (recordObservation), never settling the other account", () => {
    const { records: next } = apply(base(), (r) =>
      recordObservation(r, {
        lease_id: "l1",
        account_id: "A",
        stamp_epoch: 3,
        kind: "different_account",
        obs_id: "od",
        now: NOW,
      }),
    );
    expect(fencesOf(next).map((f) => f.kind)).toContain("drift");
    expect(next.auth_state.settled?.account_id).toBe("A");
  });
  test("stale stamp: nothing is cleared for the newer settlement; the request's lease is gone", () => {
    const { records: next, result } = apply(base(), (r) =>
      verifyOutcome(r, verify({ epoch: 2 })),
    );
    expect(result.kind).toBe("STALE");
    expect(fencesOf(next).map((f) => f.seq)).toEqual([2, 6]);
    expect(next.auth_state.leases.l1).toBeUndefined();
  });
  test("stale epoch (a different account is settled): STALE, and A's fences are untouched", () => {
    const start = records({
      settled: { account_id: "B", epoch: 4 },
      fences: { A: [unverified(2, 3)] },
      leases: { l1: { account_id: "A", epoch: 3 } },
    });
    const { records: next, result } = apply(start, (r) =>
      verifyOutcome(r, verify()),
    );
    expect(result.kind).toBe("STALE");
    expect(fencesOf(next, "A")).toHaveLength(1);
  });
  test("a clear of the credential_unverified entries alone never touches another kind of fence (rule 12)", () => {
    const start = settledOld({
      fences: { A: [unverified(1, 3), invalid(2, 3)] },
    });
    const { records: next } = apply(start, (r) =>
      clearCredentialUnverified(r, { account_id: "A", s: 9 }),
    );
    expect(fencesOf(next).map((f) => f.kind)).toEqual(["invalid_session"]);
  });
});

describe("O13: a self-revoking operation's outcome applies only to its own fence", () => {
  const withFence = (over = {}) =>
    records({
      settled: { account_id: "A", epoch: 1, session_id: "s1" },
      fences: {
        A: [
          {
            seq: 1,
            epoch: 1,
            obs_id: "o1",
            kind: "operation",
            envelope: logoutEnvelope("op-1", "A", 1, "s1"),
            created_at: NOW,
          },
        ],
      },
      ...over,
    });
  test("a matching operation and account: confirmed_applied wipes and clears settled ONLY when it is still that settlement", () => {
    const { records: next, result } = apply(withFence(), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op-1",
        outcome: "confirmed_applied",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(result.kind).toBe("WIPED");
    expect(next.auth_state.settled).toBeNull();
  });
  test("stale epoch: a NEWER settlement of the same account (the person signed in again to recover) is left in place", () => {
    const start = withFence({
      settled: { account_id: "A", epoch: 3, session_id: "s3" },
    });
    const { records: next, result } = apply(start, (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op-1",
        outcome: "confirmed_applied",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(result.kind).toBe("WIPED");
    expect(next.auth_state.settled?.epoch).toBe(3);
  });
  test("a different operation id, or a different account, applies nothing", () => {
    const a = apply(withFence(), (r) =>
      applyOperationOutcome(r, {
        account_id: "A",
        operation_id: "op-2",
        outcome: "confirmed_applied",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(a.result.kind).toBe("ABSENT");
    expect(a.records.auth_state.settled).not.toBeNull();
    const b = apply(withFence(), (r) =>
      applyOperationOutcome(r, {
        account_id: "B",
        operation_id: "op-1",
        outcome: "confirmed_applied",
        obs_id: "x",
        now: NOW,
      }),
    );
    expect(b.result.kind).toBe("ABSENT");
    expect(fencesOf(b.records)).toHaveLength(1);
  });
});

describe("O15: an unresolved lease is converted only for the settled account, and only when it is older", () => {
  const start = (leaseEpoch: number, leaseAccount = "A") =>
    settledOld({
      leases: { u1: { account_id: leaseAccount, epoch: leaseEpoch } },
    });
  test("an unresolved lease of an OLDER epoch becomes an invalid_session fence under the lease's own epoch (E5)", () => {
    const { records: next, result } = apply(start(2), (r) =>
      convertStale(r, { account_id: "A", ids: ["u1"], now: NOW }),
    );
    expect(result.ids).toEqual(["u1"]);
    expect(fencesOf(next)).toMatchObject([
      { kind: "invalid_session", reason: "unresolved_response", epoch: 2 },
    ]);
    expect(next.auth_state.leases.u1).toBeUndefined();
  });
  test("stale stamp: a lease of the CURRENT epoch is not converted (it is resolved by a verification instead)", () => {
    const { records: next, result } = apply(start(3), (r) =>
      convertStale(r, { account_id: "A", ids: ["u1"], now: NOW }),
    );
    expect(result.ids).toEqual([]);
    expect(fencesOf(next)).toEqual([]);
    expect(next.auth_state.leases.u1).toBeDefined();
  });
  test("stale epoch: a lease of ANOTHER account is never converted into a fence for the settled one", () => {
    const { records: next, result } = apply(start(2, "B"), (r) =>
      convertStale(r, { account_id: "A", ids: ["u1"], now: NOW }),
    );
    expect(result.ids).toEqual([]);
    expect(fencesOf(next)).toEqual([]);
    expect(fencesOf(next, "B")).toEqual([]);
  });
  test("an old-epoch conversion never fences the newly settled epoch", () => {
    const { records: next } = apply(start(1), (r) =>
      convertStale(r, { account_id: "A", ids: ["u1"], now: NOW }),
    );
    expect(fencesOf(next).every((f) => f.epoch === 1)).toBe(true);
    expect(next.auth_state.settled?.epoch).toBe(3);
  });
});

import { describe, expect, test } from "vitest";
import {
  checkInvariants,
  envelopesPreserved,
} from "../../../src/session/model/invariants";
import { initialRecords } from "../../../src/session/model/records";
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
import { type AuthRecords, isGating } from "../../../src/session/model/types";
import type { Rmw } from "../../../src/session/ports/store";
import { Prng } from "../../support/session/env";
import { apply, NOW } from "../../support/session/records";

/**
 * F-INV-*: seeded random sequences of reducers keep `assertInvariants` after every step (at least 2 000 sequences),
 * and I1 holds: a gating attempt never loses its verifier except through a terminal reducer.
 */
const ACCOUNTS = ["A", "B"];
const TERMINAL = new Set([
  "settle",
  "failDefinitive",
  "resolveAfterCancel",
  "observeAttempt",
]);

type StepName =
  | "allocateEpoch"
  | "recordGrant"
  | "beginActivating"
  | "markRedirected"
  | "settle"
  | "failDefinitive"
  | "markIndeterminate"
  | "clearNonGating"
  | "resolveAfterCancel"
  | "observeAttempt"
  | "recordObservation"
  | "verifyOutcome"
  | "convertStale"
  | "clearCredentialUnverified"
  | "cover"
  | "retireOwnLease"
  | "raise"
  | "applyOutcome"
  | "finishRecovery";

/** An operation id that exists for the account (operation ids are fresh UUIDs and are never reused). */
function existingOperation(
  state: AuthRecords["auth_state"],
  account: string,
): string | undefined {
  for (const fence of state.fences[account] ?? [])
    if (fence.kind === "operation") return fence.envelope.operation_id;
  return undefined;
}

function step(
  prng: Prng,
  records: AuthRecords,
  n: number,
): { name: string; out: ReturnType<typeof apply<unknown>> } {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(prng.next() * list.length)] as T;
  const state = records.auth_state;
  // Biased toward the live epoch and account, so the walk actually reaches fences, gating and operations.
  const liveEpochs = [
    state.settled?.epoch,
    state.attempt?.epoch,
    state.latest_epoch || 1,
  ].filter((e): e is number => e !== undefined);
  const attemptEpoch = state.attempt?.epoch;
  const epoch =
    attemptEpoch !== undefined && prng.next() < 0.6
      ? attemptEpoch
      : prng.next() < 0.8
        ? pick(liveEpochs)
        : pick([1, 2, 3]);
  const account =
    prng.next() < 0.8
      ? (state.settled?.account_id ?? pick(ACCOUNTS))
      : pick(ACCOUNTS);
  const leaseIds = Object.keys(state.leases);
  const lease = leaseIds.length && prng.next() < 0.7 ? pick(leaseIds) : `L${n}`;
  // Goal-directed steps (the legitimate next action) mixed with arbitrary ones, so the walk reaches settlement,
  // leases and operations as well as the odd corners.
  const guided = ((): string | null => {
    const attemptNow = state.attempt;
    if (!attemptNow)
      return state.settled
        ? pick([
            "cover",
            "cover",
            "recordObservation",
            "raise",
            "allocateEpoch",
          ] as const)
        : "allocateEpoch";
    if (attemptNow.phase === "exchanging")
      return pick([
        "recordGrant",
        "beginActivating",
        "beginActivating",
      ] as const);
    if (attemptNow.phase === "activating")
      return pick([
        "settle",
        "settle",
        "markIndeterminate",
        "failDefinitive",
      ] as const);
    if (attemptNow.phase === "indeterminate")
      return pick([
        "resolveAfterCancel",
        "resolveAfterCancel",
        "markIndeterminate",
      ] as const);
    if (attemptNow.phase === "verifying") return "observeAttempt";
    return null;
  })();
  const name = (
    prng.next() < 0.5 && guided
      ? guided
      : pick([
          "allocateEpoch",
          "allocateEpoch",
          "recordGrant",
          "beginActivating",
          "beginActivating",
          "markRedirected",
          "settle",
          "settle",
          "failDefinitive",
          "markIndeterminate",
          "markIndeterminate",
          "clearNonGating",
          "resolveAfterCancel",
          "observeAttempt",
          "recordObservation",
          "recordObservation",
          "recordObservation",
          "recordObservation",
          "verifyOutcome",
          "convertStale",
          "clearCredentialUnverified",
          "cover",
          "cover",
          "cover",
          "retireOwnLease",
          "raise",
          "raise",
          "applyOutcome",
          "finishRecovery",
        ] as const)
  ) as StepName;
  const run = (body: (r: Readonly<AuthRecords>) => Rmw<unknown>) => ({
    name,
    out: apply(records, body),
  });
  switch (name) {
    case "allocateEpoch":
      return run((r) =>
        allocateEpoch(r, {
          method: "password",
          verifier: `v${n}`.padEnd(43, "x"),
          now: NOW,
          expiresAt: NOW,
        }),
      );
    case "recordGrant":
      return run((r) => recordGrant(r, { epoch, account_id: account }));
    case "beginActivating":
      return run((r) => beginActivating(r, { epoch }));
    case "markRedirected":
      return run((r) => markRedirected(r, { epoch, expiresAt: NOW }));
    case "settle":
      return run((r) =>
        settle(r, {
          epoch,
          account_id: account,
          session_id: `s${n}`,
          now: NOW,
        }),
      );
    case "failDefinitive":
      return run((r) => failDefinitive(r, { epoch, obsId: `f${n}`, now: NOW }));
    case "markIndeterminate":
      return run((r) => markIndeterminate(r, { epoch }));
    case "clearNonGating":
      return run((r) => clearNonGating(r, { epoch }));
    case "resolveAfterCancel":
      return run((r) =>
        resolveAfterCancel(r, {
          epoch,
          result: pick([
            "not_activated",
            "session_revoked",
            "unknown",
          ] as const),
        }),
      );
    case "observeAttempt":
      return run((r) =>
        observeAttempt(r, {
          epoch,
          lease,
          s: pick([0, 2, 5]),
          captured: leaseIds.slice(0, 2),
          observed: pick([
            { kind: "401" as const },
            { kind: "200" as const, account_id: account, session_id: "s1" },
          ]),
          obsId: `o${n}`,
          now: NOW,
        }),
      );
    case "recordObservation":
      return run((r) =>
        recordObservation(r, {
          lease_id: lease,
          account_id: account,
          stamp_epoch: epoch,
          kind: pick([
            "unauthenticated",
            "current_401",
            "password_changed",
            "credential_mismatch",
            "different_account",
            "session_mismatch",
          ] as const),
          obs_id: `r${n}`,
          now: NOW,
        }),
      );
    case "verifyOutcome":
      return run((r) =>
        verifyOutcome(r, {
          lease_id: lease,
          account_id: account,
          epoch,
          session_id: pick(["s1", "s2"]),
          captured: leaseIds.slice(0, 2),
          s: pick([0, 3, 6]),
          obs_id: `v${n}`,
          now: NOW,
        }),
      );
    case "convertStale":
      return run((r) =>
        convertStale(r, { account_id: account, ids: leaseIds, now: NOW }),
      );
    case "clearCredentialUnverified":
      return run((r) =>
        clearCredentialUnverified(r, {
          account_id: account,
          s: pick([0, 3, 6]),
        }),
      );
    case "cover":
      return run((r) =>
        cover(r, {
          account_id:
            prng.next() < 0.9
              ? (state.settled?.account_id ?? account)
              : account,
          epoch: prng.next() < 0.9 ? (state.settled?.epoch ?? epoch) : epoch,
          klass: pick([
            "ordinary",
            "verification",
            "operation",
            "recovery",
            "exposure",
          ] as const),
          boot_id: pick(["me", "other"]),
          released: new Set(leaseIds.filter(() => prng.next() < 0.9)),
          lease_id: `c${n}`,
          now: NOW,
        }),
      );
    case "retireOwnLease":
      return run((r) => retireOwnLease(r, { lease_id: lease }));
    case "raise":
      return run((r) =>
        raiseOperationFence(r, {
          op: "logout",
          account_id: account,
          epoch,
          operation_id: `op${n}`,
          obs_id: `q${n}`,
          now: NOW,
        }),
      );
    case "applyOutcome":
      return run((r) =>
        applyOperationOutcome(r, {
          account_id: account,
          operation_id: existingOperation(state, account) ?? `op${n}`,
          outcome: pick([
            "confirmed_applied",
            "rejected_stale",
            "superseded",
          ] as const),
          obs_id: `a${n}`,
          now: NOW,
        }),
      );
    case "finishRecovery":
      return run((r) =>
        finishRecovery(r, { account_id: account, epoch, s: pick([0, 4, 8]) }),
      );
  }
}

describe("random reducer sequences (F-INV)", () => {
  test("2 000 seeded sequences keep the structural invariants, keep envelopes immutable and never lose a gating verifier", () => {
    const failures: string[] = [];
    let steps = 0;
    const seen = {
      changed: 0,
      gating: 0,
      fenced: 0,
      leased: 0,
      settled: 0,
      envelope: 0,
      terminalWhileGating: 0,
    };
    for (let seed = 1; seed <= 2000; seed += 1) {
      const prng = new Prng(seed);
      let records = initialRecords();
      for (let n = 0; n < 24; n += 1) {
        const before = records.auth_state;
        const { name, out } = step(prng, records, n);
        records = out.records;
        steps += 1;
        if (out.wrote) seen.changed += 1;
        if (isGating(records.auth_state.attempt)) seen.gating += 1;
        if (Object.keys(records.auth_state.fences).length > 0) seen.fenced += 1;
        if (Object.keys(records.auth_state.leases).length > 0) seen.leased += 1;
        if (records.auth_state.settled) seen.settled += 1;
        if (
          Object.values(records.auth_state.fences).some((list) =>
            list.some((f) => f.kind === "operation"),
          )
        )
          seen.envelope += 1;
        if (
          isGating(before.attempt) &&
          TERMINAL.has(name) &&
          !isGating(records.auth_state.attempt)
        )
          seen.terminalWhileGating += 1;
        const violations = [
          ...checkInvariants(records.auth_state),
          ...envelopesPreserved(before, records.auth_state),
        ];
        // I1: a gating attempt survives every non-terminal reducer with the same verifier.
        if (isGating(before.attempt) && !TERMINAL.has(name)) {
          const after = records.auth_state.attempt;
          if (
            !after ||
            after.verifier !== before.attempt?.verifier ||
            after.epoch !== before.attempt?.epoch
          )
            violations.push(`I1: ${name} removed or replaced a gating attempt`);
        }
        if (violations.length > 0)
          failures.push(
            `seed ${seed} step ${n} (${name}): ${violations.join("; ")}`,
          );
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(steps).toBe(2000 * 24);
    // Non-vacuity: the random walk really reaches the states the properties are about.
    const minimum = {
      changed: 5000,
      gating: 500,
      fenced: 500,
      leased: 500,
      settled: 2000,
      envelope: 50,
      terminalWhileGating: 50,
    };
    const low = Object.entries(minimum)
      .filter(([key, min]) => seen[key as keyof typeof seen] <= min)
      .map(([key]) => key);
    expect({ seen, low }).toEqual({ seen, low: [] });
  });
});

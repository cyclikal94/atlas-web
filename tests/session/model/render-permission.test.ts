import { describe, expect, test } from "vitest";
import {
  firstFailingClause,
  mayRender,
} from "../../../src/session/model/render-permission";
import type { AttemptPhase, Fence } from "../../../src/session/model/types";

/**
 * F-RP-*: the TRUTH TABLE of the render-permission function (matrix 3.7): settled-match (2) x attempt phase (none and
 * five phases) x fences (none and each of the four kinds) x hold (2) x exposure-lease (2) = 240 rows. Exactly the rows
 * with every clause true are `true`.
 */
const phases: Array<AttemptPhase | null> = [
  null,
  "exchanging",
  "redirected",
  "activating",
  "indeterminate",
  "verifying",
];
const fenceKinds: Array<Fence["kind"] | null> = [
  null,
  "invalid_session",
  "credential_unverified",
  "drift",
  "operation",
];

describe("render permission truth table", () => {
  const rows: Array<{
    input: Parameters<typeof mayRender>[0];
    expected: boolean;
    first: string | null;
  }> = [];
  for (const settledMatches of [true, false])
    for (const attemptPhase of phases)
      for (const fence of fenceKinds)
        for (const hold of [false, true])
          for (const exposureLease of [true, false]) {
            const gatesAttempt =
              attemptPhase === "activating" ||
              attemptPhase === "indeterminate" ||
              attemptPhase === "verifying";
            const expected =
              settledMatches &&
              !gatesAttempt &&
              fence === null &&
              !hold &&
              exposureLease;
            const first = !settledMatches
              ? "settled"
              : gatesAttempt
                ? "attempt"
                : fence !== null
                  ? "fences"
                  : hold
                    ? "hold"
                    : !exposureLease
                      ? "exposure_lease"
                      : null;
            rows.push({
              input: {
                settledMatches,
                attemptPhase,
                fences: fence ? [{ kind: fence }] : [],
                hold,
                exposureLease,
              },
              expected,
              first,
            });
          }

  test("has exactly 240 rows", () => {
    expect(rows).toHaveLength(240);
  });
  test("every row has its expected value and first failing clause", () => {
    const wrong = rows.filter(
      (row) =>
        mayRender(row.input) !== row.expected ||
        firstFailingClause(row.input) !== row.first,
    );
    expect(wrong).toEqual([]);
  });
  test("exactly the rows with every clause true are true (2 x ... = 1 x 3 x 1 x 1 x 1 = 3)", () => {
    expect(rows.filter((row) => row.expected)).toHaveLength(3); // no attempt, exchanging, redirected
    expect(rows.filter((row) => mayRender(row.input))).toHaveLength(3);
  });
  test("an exchanging or redirected attempt does not hide the outgoing account", () => {
    for (const phase of ["exchanging", "redirected"] as const)
      expect(
        mayRender({
          settledMatches: true,
          attemptPhase: phase,
          fences: [],
          hold: false,
          exposureLease: true,
        }),
      ).toBe(true);
  });
});

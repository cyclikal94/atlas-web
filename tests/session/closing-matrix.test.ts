// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  CLOSING_FACTORS,
  type ClosingParams,
  EXPOSURE_OWN_FACTORS,
  REQUEST_FACTORS,
  runClosing,
} from "../support/session/matrix-closing";
import { allCombinations, pairwise } from "../support/session/pairwise";

/**
 * F-CLS-* (check 14, P5-N), F-ACT-K (check 13 (a), P5-K) and the Theorem-3 controls. `pnpm test` runs a
 * pairwise-covering selection over every outcome PLUS the full product for the committing outcome (so closing writes
 * really commit in a large share of the runs); the full product over every outcome is run by
 * `pnpm test:session-matrix`.
 */
function family(
  name: string,
  factors: Record<string, readonly unknown[]>,
  seed: number,
  expectIssued: boolean,
) {
  describe(name, () => {
    const rows = [
      ...(pairwise(factors, seed) as unknown as ClosingParams[]),
      ...(allCombinations({
        ...factors,
        outcome: ["commit"],
      }) as unknown as ClosingParams[]),
    ];
    test("the selection is a strict subset of the full product", () => {
      expect(allCombinations(factors).length).toBeGreaterThan(rows.length);
    });
    test("no violation in any selected scenario, and the run is not vacuous", async () => {
      const failures: unknown[] = [];
      let committed = 0;
      let issued = 0;
      for (const params of rows) {
        const result = await runClosing(params);
        if (result.violations.length > 0)
          failures.push({ params, violations: result.violations.slice(0, 3) });
        if (result.stats.committed > 0) committed += 1;
        if (result.stats.issued > 0) issued += 1;
      }
      expect(failures.slice(0, 3)).toEqual([]);
      expect(committed).toBeGreaterThan(rows.length / 4);
      if (expectIssued) expect(issued).toBeGreaterThan(0);
    }, 300_000);
  });
}

family(
  "check 14: a request against a closing write (P5-N)",
  REQUEST_FACTORS,
  3,
  true,
);
family(
  "check 13 (a): the page's own exposure attempt against its own closing write (P5-K)",
  EXPOSURE_OWN_FACTORS,
  4,
  false,
);
family(
  "Theorem 3 controls: a foreign closing write against an exposure attempt",
  {
    ...CLOSING_FACTORS,
    victim: ["exposure"],
    writer: ["foreign"],
    klass: ["ordinary"],
  },
  5,
  false,
);

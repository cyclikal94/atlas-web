// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  EXPOSURE_FACTORS,
  EXPOSURE_SCENARIO_COUNT,
  type ExposureParams,
  runExposure,
} from "../support/session/matrix-exposure";
import { allCombinations, pairwise } from "../support/session/pairwise";

/**
 * F-EXP-*: check 12 - exposure. `pnpm test` runs a PAIRWISE-covering selection (every pair of parameter values
 * appears; every single-delay extreme and the all-unbounded corner are included). `pnpm test:session-matrix` runs
 * every one of the 52 488 scenarios and writes the evidence.
 */
function selection(): ExposureParams[] {
  const rows = pairwise(EXPOSURE_FACTORS, 12) as ExposureParams[];
  const base: ExposureParams = {
    d0N: 0,
    d0L: 0,
    d1: 0,
    d2: 0,
    d3: 0,
    da: 0,
    order: "L_first",
    d4: "commit",
    klass: "ordinary",
    pageType: "cold_offline",
  };
  const extremes: ExposureParams[] = [];
  for (const knob of ["d0N", "d0L", "d1", "d2", "d3", "da"] as const)
    for (const value of [10, "unbounded"] as const)
      for (const pageType of EXPOSURE_FACTORS.pageType)
        for (const d4 of EXPOSURE_FACTORS.d4)
          extremes.push({ ...base, [knob]: value, pageType, d4 });
  const corner = allCombinations({
    order: EXPOSURE_FACTORS.order,
    d4: EXPOSURE_FACTORS.d4,
    pageType: EXPOSURE_FACTORS.pageType,
    klass: EXPOSURE_FACTORS.klass,
  }).map(
    (c) =>
      ({
        ...base,
        d0N: "unbounded",
        d0L: "unbounded",
        d1: "unbounded",
        d2: "unbounded",
        d3: "unbounded",
        da: "unbounded",
        ...c,
      }) as ExposureParams,
  );
  const zero = allCombinations({
    order: EXPOSURE_FACTORS.order,
    d4: EXPOSURE_FACTORS.d4,
    pageType: EXPOSURE_FACTORS.pageType,
    klass: EXPOSURE_FACTORS.klass,
  }).map((c) => ({ ...base, ...c }) as ExposureParams);
  return [...rows, ...extremes, ...corner, ...zero];
}

describe("check 12: exposure (pairwise selection)", () => {
  const scenarios = selection();
  test("the full matrix has 52 488 scenarios and the selection is a sound subset", () => {
    expect(EXPOSURE_SCENARIO_COUNT).toBe(52_488);
    expect(scenarios.length).toBeGreaterThan(100);
    expect(scenarios.length).toBeLessThan(2000);
  });
  test("no violation in any selected scenario, and the run is not vacuous", async () => {
    const failures: unknown[] = [];
    let actedBeforeDetection = 0;
    let refusedAfterDetection = 0;
    let detected = 0;
    for (const params of scenarios) {
      const result = await runExposure(params);
      if (result.violations.length > 0)
        failures.push({ params, violations: result.violations.slice(0, 3) });
      if (result.stats.detected) detected += 1;
      if (result.stats.nActedBeforeDetection) actedBeforeDetection += 1;
      if (result.stats.detected && !result.stats.nActed)
        refusedAfterDetection += 1;
    }
    expect(failures.slice(0, 3)).toEqual([]);
    // Non-vacuity: detections happened; some pages had already displayed (the notification interval, stated not closed);
    // many were refused. Both must occur or the properties say nothing.
    expect(detected).toBeGreaterThan(scenarios.length / 2);
    expect(refusedAfterDetection).toBeGreaterThan(20);
    expect(actedBeforeDetection).toBeGreaterThan(0);
  }, 300_000);
});

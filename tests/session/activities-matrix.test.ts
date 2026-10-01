// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  OWN_DETECTION_FACTORS,
  type OwnDetectionParams,
  runOwnDetection,
  runStageTrigger,
  STAGE_TRIGGER_FACTORS,
  type StageTriggerParams,
} from "../support/session/matrix-activities";
import { allCombinations, pairwise } from "../support/session/pairwise";

/**
 * F-ACT-* (check 13): the page's own later events against its own earlier, asynchronous decision.
 * (b) P5-L: stages x triggers x delivery of the older completion; (c) P5-M: a queued second request against the page's
 * own detection through its first. Pairwise selections here; the full products run in `pnpm test:session-matrix`.
 */
describe("check 13 (c): P5-M, a queued second request against the page's own detection", () => {
  test("no violation in any selected scenario; B is issued after the detection in none", async () => {
    const rows = [
      ...(pairwise(OWN_DETECTION_FACTORS, 31) as OwnDetectionParams[]),
      ...(allCombinations({
        ...OWN_DETECTION_FACTORS,
        daA: [0],
        klass: ["ordinary"],
        pageState: ["visible"],
      }) as OwnDetectionParams[]),
    ];
    const failures: unknown[] = [];
    let detected = 0;
    for (const params of rows) {
      const result = await runOwnDetection(params);
      if (result.violations.length > 0)
        failures.push({ params, violations: result.violations.slice(0, 3) });
      if (result.stats.detected) detected += 1;
    }
    expect(failures.slice(0, 3)).toEqual([]);
    expect(detected).toBeGreaterThan(rows.length / 2);
  }, 300_000);
});

describe("check 13 (b): P5-L, every stage against every trigger", () => {
  test("no violation in any selected scenario", async () => {
    const rows = pairwise(STAGE_TRIGGER_FACTORS, 32) as StageTriggerParams[];
    const failures: unknown[] = [];
    for (const params of rows) {
      const result = await runStageTrigger(params);
      if (result.violations.length > 0)
        failures.push({ params, violations: result.violations.slice(0, 3) });
    }
    expect(failures.slice(0, 3)).toEqual([]);
    expect(rows.length).toBeGreaterThan(20);
  }, 300_000);
});

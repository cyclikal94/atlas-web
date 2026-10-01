import {
  OWN_DETECTION_FACTORS,
  runOwnDetection,
  runStageTrigger,
  STAGE_TRIGGER_FACTORS,
} from "./matrix-activities";
import {
  CLOSING_FACTORS,
  EXPOSURE_OWN_FACTORS,
  REQUEST_FACTORS,
  runClosing,
} from "./matrix-closing";
import {
  EXPOSURE_FACTORS,
  EXPOSURE_SCENARIO_COUNT,
  runExposure,
} from "./matrix-exposure";
import type { Modules } from "./modules";
import { allCombinations } from "./pairwise";

/**
 * The scenario matrices of plan section 13.4, as data. `pnpm test` runs a pairwise selection of each (the `*-matrix`
 * suites); `pnpm test:session-matrix` runs EVERY combination of every part, sharded across processes, and writes the
 * counts and failures to `.agtx/evidence/WEB-08a/fixture/matrix-<check>.json`.
 *
 * `expected` is the product of the factor sizes, computed independently of the enumeration, so that a defect in the
 * generator cannot make a matrix look complete.
 */
export interface ScenarioOutcome {
  violations: string[];
  stats: object;
}
export interface MatrixPart {
  id: string;
  check: "12" | "13" | "14";
  label: string;
  factors: Record<string, readonly unknown[]>;
  expected: number;
  run(params: never, modules?: Modules): Promise<ScenarioOutcome>;
}

const product = (factors: Record<string, readonly unknown[]>): number =>
  Object.values(factors).reduce((n, values) => n * values.length, 1);

const part = (
  id: string,
  check: MatrixPart["check"],
  label: string,
  factors: Record<string, readonly unknown[]>,
  run: MatrixPart["run"],
  expected: number = product(factors),
): MatrixPart => ({ id, check, label, factors, expected, run });

export const FOREIGN_CONTROL_FACTORS = {
  ...CLOSING_FACTORS,
  victim: ["exposure"] as const,
  writer: ["foreign"] as const,
  klass: ["ordinary"] as const,
};

export const MATRIX_PARTS: readonly MatrixPart[] = [
  part(
    "exposure",
    "12",
    "P1 to P7 and P5-A to P5-J: exposure against every delay, creation order, recording outcome, request class and page type",
    EXPOSURE_FACTORS,
    runExposure as MatrixPart["run"],
    EXPOSURE_SCENARIO_COUNT,
  ),
  part(
    "own-exposure-vs-own-closing-write",
    "13",
    "(a) P5-K: the page's own exposure attempt against its own closing write",
    EXPOSURE_OWN_FACTORS,
    runClosing as MatrixPart["run"],
  ),
  part(
    "foreign-closing-write-vs-exposure",
    "13",
    "(a) Theorem 3 controls: a foreign closing write against an exposure attempt",
    FOREIGN_CONTROL_FACTORS,
    runClosing as MatrixPart["run"],
  ),
  part(
    "stage-vs-trigger",
    "13",
    "(b) P5-L: every stage of an exposure attempt against every cancellation trigger and older-completion delivery",
    STAGE_TRIGGER_FACTORS,
    runStageTrigger as MatrixPart["run"],
  ),
  part(
    "own-detection-vs-queued-request",
    "13",
    "(c) P5-M: a queued second request against the page's own detection through its first",
    OWN_DETECTION_FACTORS,
    runOwnDetection as MatrixPart["run"],
  ),
  part(
    "request-vs-closing-write",
    "14",
    "P5-N: a covered-but-unsent request against a closing write (activating attempt, settlement, operation fence)",
    REQUEST_FACTORS,
    runClosing as MatrixPart["run"],
  ),
];

/** Every scenario of a part, in a fixed order. Scenario `i` is the same on every process. */
export function* scenarios(
  matrixPart: MatrixPart,
): Generator<{ index: number; params: unknown }> {
  let index = 0;
  for (const params of allCombinations(matrixPart.factors))
    yield { index: index++, params };
}

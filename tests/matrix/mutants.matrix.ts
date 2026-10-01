// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  OWN_DETECTION_FACTORS,
  runOwnDetection,
  runStageTrigger,
  STAGE_TRIGGER_FACTORS,
} from "../support/session/matrix-activities";
import {
  EXPOSURE_OWN_FACTORS,
  REQUEST_FACTORS,
  runClosing,
} from "../support/session/matrix-closing";
import {
  EXPOSURE_FACTORS,
  runExposure,
} from "../support/session/matrix-exposure";
import { FOREIGN_CONTROL_FACTORS } from "../support/session/matrix-registry";
import { type Modules, srcModules } from "../support/session/modules";
import { buildMutant, MUTANTS } from "../support/session/mutants";
import { allCombinations, pairwise } from "../support/session/pairwise";

/**
 * Mutation detection over the FULL products (plan WP0 exit criteria; `tests/support/session/mutation-detection.test.ts`
 * replays the recorded witnesses in `pnpm test`). For each of the 16 mutations, search the scenario families, cheapest
 * first, until two scenarios violate the property the mutation is meant to break; the search fails if it exhausts the
 * families without finding one. Every witness is then replayed on the unmutated source and must be clean.
 * The exposure family is the pairwise selection of check 12 (the full product is 52 488 scenarios per mutation).
 */
type Row = { family: string; params: unknown };
type Run = (
  params: never,
  modules: Modules,
) => Promise<{ violations: string[] }>;
const FAMILIES: Array<{ family: string; rows: () => unknown[]; run: Run }> = [
  {
    family: "detection",
    rows: () => allCombinations(OWN_DETECTION_FACTORS),
    run: runOwnDetection as Run,
  },
  {
    family: "stage",
    rows: () => allCombinations(STAGE_TRIGGER_FACTORS),
    run: runStageTrigger as Run,
  },
  {
    family: "own",
    rows: () => allCombinations(EXPOSURE_OWN_FACTORS),
    run: runClosing as Run,
  },
  {
    family: "foreign",
    rows: () => allCombinations(FOREIGN_CONTROL_FACTORS),
    run: runClosing as Run,
  },
  {
    family: "request",
    rows: () => allCombinations(REQUEST_FACTORS),
    run: runClosing as Run,
  },
  {
    family: "exposure",
    rows: () => pairwise(EXPOSURE_FACTORS, 12),
    run: runExposure as Run,
  },
];

const shard = Number(process.env.MATRIX_SHARD ?? 0);
const shards = Number(process.env.MATRIX_SHARDS ?? 1);
const out = process.env.MATRIX_OUT;

MUTANTS.forEach((mutant, index) => {
  if (index % shards !== shard) return;
  test(`mutation ${mutant.name} is caught`, async () => {
    const started = Date.now();
    const modules = await buildMutant(mutant);
    const wanted = mutant.expect.split(" or ");
    const witnesses: Array<Row & { violation: string }> = [];
    let examined = 0;
    for (const { family, rows, run } of FAMILIES) {
      for (const params of rows()) {
        examined += 1;
        const result = await run(params as never, modules);
        const hit = result.violations.find((v) =>
          wanted.some((w) => v.startsWith(w) || v.includes(w)),
        );
        if (hit) {
          witnesses.push({ family, params, violation: hit.slice(0, 80) });
          break;
        }
      }
      if (witnesses.length >= 2) break;
    }
    // The same scenarios on the unmutated source must be clean.
    let controlClean = true;
    for (const witness of witnesses) {
      const family = FAMILIES.find((f) => f.family === witness.family);
      const control = await (family as (typeof FAMILIES)[number]).run(
        witness.params as never,
        srcModules,
      );
      if (control.violations.length > 0) controlClean = false;
    }
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `mutant.${mutant.name}.json`),
        JSON.stringify({
          mutant: mutant.name,
          rule: mutant.rule,
          expect: mutant.expect,
          caught: witnesses.length > 0,
          control_clean: controlClean,
          examined,
          witnesses,
          wall_ms: Date.now() - started,
        }),
      );
    }
    expect(witnesses.length).toBeGreaterThan(0);
    expect(controlClean).toBe(true);
  });
});

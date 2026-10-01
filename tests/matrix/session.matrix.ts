// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MATRIX_PARTS, scenarios } from "../support/session/matrix-registry";

/**
 * One shard of the full scenario matrices. The driver (`scripts/run-session-matrix.mjs`) starts `MATRIX_SHARDS` processes
 * with `MATRIX_SHARD` = 0 .. n-1; scenario `i` of a part belongs to shard `i mod n`. Each writes one JSON file per
 * part; the driver merges them and checks that the counts add up to the product.
 */
const shard = Number(process.env.MATRIX_SHARD ?? 0);
const shards = Number(process.env.MATRIX_SHARDS ?? 1);
const out = process.env.MATRIX_OUT;
const only = process.env.MATRIX_PARTS?.split(",").filter(Boolean);

for (const part of MATRIX_PARTS) {
  if (only && !only.includes(part.id)) continue;
  test(`${part.check} ${part.id} (shard ${shard + 1}/${shards})`, async () => {
    const started = Date.now();
    let run = 0;
    const failures: unknown[] = [];
    let failed = 0;
    const stats: Record<string, number> = {};
    for (const { index, params } of scenarios(part)) {
      if (index % shards !== shard) continue;
      const result = await part.run(params as never);
      run += 1;
      if (result.violations.length > 0) {
        failed += 1;
        if (failures.length < 10)
          failures.push({
            index,
            params,
            violations: result.violations.slice(0, 3),
          });
      }
      for (const [key, value] of Object.entries(result.stats)) {
        if (typeof value === "number") stats[key] = (stats[key] ?? 0) + value;
        else if (value === true) stats[key] = (stats[key] ?? 0) + 1;
        else if (value === false) stats[key] = stats[key] ?? 0;
      }
    }
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `${part.id}.${shard}.json`),
        JSON.stringify({
          part: part.id,
          shard,
          shards,
          run,
          failed,
          failures,
          stats,
          wall_ms: Date.now() - started,
        }),
      );
    }
    expect(failures).toEqual([]);
  });
}

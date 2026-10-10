#!/usr/bin/env node
import { writeFileSync } from "node:fs";
// Partition the unchanged complete suite into bounded independent UI work and
// its serial complement. Build once before invoking this runner. No retries are
// introduced. Custom --project/spec/grep/repeat selectors apply to both lanes.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, json, newRun, processes } from "./validation/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (process.env.ATLAS_PROFILE)
  throw new Error("Use the dedicated isolated profiling runner");
if (
  args.some(
    (a) =>
      /^-(?:j|c)/.test(a) ||
      /^--(?:workers|config|output|reporter|pass-with-no-tests|retries)(?:=|$)/.test(
        a,
      ),
  )
)
  throw new Error(
    "Worker/config/output/report controls belong to this runner; use Playwright directly for custom runs",
  );
const runDir = newRun(join(root, ".agtx/evidence/e2e"));
const before = fingerprint(root);
json(join(runDir, "inputs.json"), before);
const proc = processes(root);
let interrupted = false;
const results = [];
try {
  for (const lane of ["parallel-ui", "serial"]) {
    const env = {
      ATLAS_E2E_LANE: lane,
      ATLAS_EVIDENCE_DIR: join(runDir, lane, "evidence"),
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(runDir, `${lane}.json`),
    };
    const started = Date.now();
    const r = await proc.run(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        ...args,
        "--pass-with-no-tests",
        "--retries=0",
        "--reporter=json",
        `--output=${join(runDir, lane, "test-results")}`,
      ],
      env,
    );
    writeFileSync(join(runDir, `${lane}.log`), r.output);
    results.push({ lane, exit: r.code, elapsed_ms: Date.now() - started });
    console.log(`${lane}: exit ${r.code}; evidence ${runDir}`);
    if (r.code) break;
  }
} finally {
  interrupted = proc.cancelled;
  await proc.close();
}
// A selector that matches neither lane must fail, as normal Playwright does.
const { readFileSync } = await import("node:fs");
let count = 0;
let clean = true;
for (const r of results) {
  const report = JSON.parse(
    readFileSync(join(runDir, `${r.lane}.json`), "utf8"),
  );
  clean =
    clean &&
    !report.errors?.length &&
    (report.stats?.flaky ?? 0) === 0 &&
    (report.stats?.unexpected ?? 0) === 0;
  count +=
    (report.stats?.expected ?? 0) +
    (report.stats?.unexpected ?? 0) +
    (report.stats?.flaky ?? 0);
}
const after = fingerprint(root);
json(join(runDir, "inputs-after.json"), after);
const unchanged = before.sha256 === after.sha256;
const passed =
  !interrupted &&
  unchanged &&
  clean &&
  results.length === 2 &&
  results.every((r) => r.exit === 0) &&
  count > 0;
json(join(runDir, "results.json"), {
  passed,
  source_unchanged: unchanged,
  executed: count,
  results,
});
process.exitCode = passed ? 0 : 1;

#!/usr/bin/env node
// `pnpm profile:session` (plan 12.3): MEASUREMENTS, not budgets, in real Chromium, Firefox and WebKit, written to
// .agtx/evidence/WEB-08a/profiling/. It records the machine first. Nothing here is an acceptance figure; WEB-09a owns per-request write
// cost and unresolved-lease frequency, WEB-08c owns waits against a back-to-back leader and a frozen owner, WEB-15 owns the version matrix.
//
//   P-1 bundle delta (built separately: pnpm build && pnpm build:fixture && node scripts/check-budgets.mjs ...)   -> bundle-delta.json
//   P-2 IndexedDB micro-costs, P-4 boot to first exposure   (fixture specs, no backend)
//   P-3 stamped overhead, P-5 lock publication seed          (integration specs, released backend on loopback)
//   P-6 fake-matrix cost                                     (pairwise: vitest; full: .agtx/evidence/WEB-08a/fixture/matrix-*.json)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".agtx/evidence/WEB-08a/profiling");
mkdirSync(out, { recursive: true });
const run = (command, args, env = {}) =>
  spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

// Machine
const browsers = spawnSync(
  process.execPath,
  [join(root, "node_modules/@playwright/test/cli.js"), "--version"],
  { encoding: "utf8" },
).stdout.trim();
const versions = spawnSync(
  process.execPath,
  [
    "-e",
    `const pw=require("@playwright/test");(async()=>{const o={};for(const n of ["chromium","firefox","webkit"]){const b=await pw[n].launch();o[n]=b.version();await b.close();}console.log(JSON.stringify(o));})()`,
  ],
  { cwd: root, encoding: "utf8" },
).stdout.trim();
writeFileSync(
  join(out, "machine.json"),
  `${JSON.stringify({ recorded_at: new Date().toISOString(), os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30), node: process.version, playwright: browsers, engines: versions ? JSON.parse(versions) : null, note: "Playwright contexts are ephemeral profiles: IndexedDB durability ('strict') is not measured against a real on-disk profile, and loopback removes the network. The figures are for comparison between runs on this machine, not for any other." }, null, 2)}\n`,
);

rmSync(join(out, "measurements.jsonl"), { force: true });
let status = 0;

// P-2 and P-4
status ||=
  run(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--project=fixture-chromium",
      "--project=fixture-firefox",
      "--project=fixture-webkit",
      "tests/e2e/fixture.profile-session.spec.ts",
    ],
    { ATLAS_PROFILE: "1", ATLAS_E2E_BROWSERS: "all" },
  ).status ?? 1;
// P-3 and P-5 (a separate evidence directory so the integration evidence is not overwritten)
status ||=
  run(
    process.execPath,
    [
      join(root, "scripts/integration/run.mjs"),
      "--browsers",
      "chromium,firefox,webkit",
      "--evidence",
      ".agtx/evidence/WEB-08a/profiling/integration-run",
      "--",
      "integration.profile",
    ],
    { ATLAS_PROFILE: "1" },
  ).status ?? 1;

// P-6: the pairwise suites' wall time (vitest's own report) and the full matrices' (the evidence written by pnpm test:session-matrix)
const json = join(out, "pairwise-vitest.json");
run(process.execPath, [
  join(root, "node_modules/vitest/vitest.mjs"),
  "run",
  "tests/session/exposure-matrix.test.ts",
  "tests/session/closing-matrix.test.ts",
  "tests/session/activities-matrix.test.ts",
  "--reporter=json",
  `--outputFile=${json}`,
]);
const pairwise = {};
try {
  for (const file of JSON.parse(readFileSync(json, "utf8")).testResults) {
    const tests = file.assertionResults.length;
    pairwise[file.name.split("/").pop()] = {
      tests,
      wall_ms: Math.round(file.endTime - file.startTime),
    };
  }
} catch {
  // reported below
}
const full = {};
for (const check of ["12", "13", "14"]) {
  try {
    const m = JSON.parse(
      readFileSync(
        join(root, `.agtx/evidence/WEB-08a/fixture/matrix-${check}.json`),
        "utf8",
      ),
    );
    full[`check ${check}`] = {
      scenarios: m.scenarios_run,
      cpu_seconds: m.parts.reduce((n, p) => n + p.cpu_seconds, 0),
      wall_seconds_all_checks_together: m.wall_seconds,
      shards: m.shards,
    };
  } catch {
    full[`check ${check}`] = "run pnpm test:session-matrix first";
  }
}
writeFileSync(
  join(out, "p6-matrix-cost.json"),
  `${JSON.stringify({ pairwise_selection_in_pnpm_test: pairwise, full_matrices_in_pnpm_test_session_matrix: full }, null, 2)}\n`,
);

// Summary table
const lines = readFileSync(join(out, "measurements.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const rows = lines.map(
  (m) =>
    `| ${m.name} | ${m.engine} | ${m.n} | ${m.p50_ms} | ${m.p95_ms} | ${m.max_ms} |`,
);
writeFileSync(
  join(out, "summary.md"),
  `# WEB-08a profiling (measurements, not budgets)\n\nMachine: see machine.json. Milliseconds.\n\n| Measurement | Engine | n | p50 | p95 | max |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`,
);
console.log(`profiling written to ${out}`);
process.exit(status);

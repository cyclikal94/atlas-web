#!/usr/bin/env node
// `pnpm test:session-matrix`: run EVERY combination of every scenario matrix (plan 13.4), sharded across processes, then
// the full-product mutation search, and write the evidence to .agtx/evidence/WEB-08a/fixture/matrix-<check>.json.
//
//   node scripts/run-session-matrix.mjs [--shards N] [--parts a,b] [--skip-mutants] [--only-mutants]
//
// The parts, their factors and their expected counts are in tests/support/session/matrix-registry.ts; the driver reads
// the expected counts from the shard files' own report and from a fixed table below, and fails when a total differs.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `ATLAS_MATRIX_EVIDENCE` keeps a later task's run from overwriting an earlier task's evidence (the default is WEB-08a's folder).
const evidence = process.env.ATLAS_MATRIX_EVIDENCE
  ? resolve(root, process.env.ATLAS_MATRIX_EVIDENCE)
  : join(root, ".agtx/evidence/WEB-08a/fixture");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const shards = Number(
  value("--shards", Math.max(1, Math.min(cpus().length - 2, 12))),
);
const partFilter = value("--parts", "");

// The product of the factor sizes, restated here so that a defect in the enumerator cannot hide.
// 12: 3^2 (D0 on each cover) x 3^4 (D1, D2, D3, Da) x 2 (creation order) x 3 (recording outcome) x 4 (request class) x 3 (page type)
// 13/14: see the registry; each is the product of its own factor list.
const EXPECTED = {
  exposure: 52488,
  "own-exposure-vs-own-closing-write": 2160,
  "foreign-closing-write-vs-exposure": 2160,
  "stage-vs-trigger": 240,
  "own-detection-vs-queued-request": 192,
  "request-vs-closing-write": 2880,
};
const CHECK_OF = {
  exposure: "12",
  "own-exposure-vs-own-closing-write": "13",
  "foreign-closing-write-vs-exposure": "13",
  "stage-vs-trigger": "13",
  "own-detection-vs-queued-request": "13",
  "request-vs-closing-write": "14",
};

const work = mkdtempSync(join(tmpdir(), "session-matrix-"));
const vitest = join(root, "node_modules/vitest/vitest.mjs");

function runShards(file, extraEnv) {
  return Promise.all(
    Array.from(
      { length: shards },
      (_, shard) =>
        new Promise((resolveRun) => {
          const child = spawn(
            process.execPath,
            [vitest, "run", "--config", "vitest.matrix.config.ts", file],
            {
              cwd: root,
              env: {
                ...process.env,
                ...extraEnv,
                MATRIX_SHARD: String(shard),
                MATRIX_SHARDS: String(shards),
                MATRIX_OUT: work,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let log = "";
          child.stdout.on("data", (d) => (log += d));
          child.stderr.on("data", (d) => (log += d));
          child.on("close", (code) => resolveRun({ shard, code, log }));
        }),
    ),
  );
}

const started = Date.now();
let ok = true;
const problems = [];
const generatedAt = new Date().toISOString();
mkdirSync(evidence, { recursive: true });

if (!flag("--only-mutants")) {
  const runs = await runShards(
    "tests/matrix/session.matrix.ts",
    partFilter ? { MATRIX_PARTS: partFilter } : {},
  );
  for (const r of runs)
    if (r.code !== 0) {
      ok = false;
      problems.push(
        `scenario shard ${r.shard} exited ${r.code}\n${r.log.slice(-3000)}`,
      );
    }
  const files = readdirSync(work).filter(
    (f) => !f.startsWith("mutant.") && f.endsWith(".json"),
  );
  const byPart = new Map();
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(work, f), "utf8"));
    const list = byPart.get(data.part) ?? [];
    list.push(data);
    byPart.set(data.part, list);
  }
  const byCheck = new Map();
  for (const [id, expected] of Object.entries(EXPECTED)) {
    if (partFilter && !partFilter.split(",").includes(id)) continue;
    const list = byPart.get(id) ?? [];
    const run = list.reduce((n, s) => n + s.run, 0);
    const failed = list.reduce((n, s) => n + s.failed, 0);
    const stats = {};
    for (const s of list)
      for (const [k, v] of Object.entries(s.stats))
        stats[k] = (stats[k] ?? 0) + v;
    const failures = list.flatMap((s) => s.failures).slice(0, 10);
    const complete = list.length === shards && run === expected;
    if (!complete || failed > 0) {
      ok = false;
      problems.push(
        `${id}: ran ${run} of ${expected} scenarios in ${list.length}/${shards} shards, ${failed} failing`,
      );
    }
    const entry = {
      part: id,
      scenarios_expected: expected,
      scenarios_run: run,
      failing: failed,
      failing_configurations: failures,
      shards: list.length,
      cpu_seconds:
        Math.round(list.reduce((n, s) => n + s.wall_ms, 0) / 100) / 10,
      non_vacuity_counters: stats,
    };
    const check = CHECK_OF[id];
    byCheck.set(check, [...(byCheck.get(check) ?? []), entry]);
  }
  for (const [check, parts] of byCheck) {
    writeFileSync(
      join(evidence, `matrix-${check}.json`),
      `${JSON.stringify(
        {
          check,
          layer:
            "fixture (deterministic fake platform); does not prove real-engine behaviour or integration",
          generated_at: generatedAt,
          shards,
          scenarios_expected: parts.reduce(
            (n, p) => n + p.scenarios_expected,
            0,
          ),
          scenarios_run: parts.reduce((n, p) => n + p.scenarios_run, 0),
          failing: parts.reduce((n, p) => n + p.failing, 0),
          wall_seconds: Math.round((Date.now() - started) / 100) / 10,
          parts,
        },
        null,
        2,
      )}\n`,
    );
  }
}

if (!flag("--skip-mutants") && !partFilter) {
  const before = Date.now();
  for (const f of readdirSync(work))
    if (f.startsWith("mutant.")) rmSync(join(work, f));
  const runs = await runShards("tests/matrix/mutants.matrix.ts", {});
  for (const r of runs)
    if (r.code !== 0) {
      ok = false;
      problems.push(
        `mutation shard ${r.shard} exited ${r.code}\n${r.log.slice(-3000)}`,
      );
    }
  const mutants = readdirSync(work)
    .filter((f) => f.startsWith("mutant."))
    .map((f) => JSON.parse(readFileSync(join(work, f), "utf8")));
  const uncaught = mutants.filter((m) => !m.caught || !m.control_clean);
  if (uncaught.length > 0 || mutants.length !== 16) {
    ok = false;
    problems.push(
      `mutation search: ${mutants.length} of 16 reported, uncaught or dirty control: ${uncaught.map((m) => m.mutant).join(", ")}`,
    );
  }
  writeFileSync(
    join(evidence, "matrix-mutants.json"),
    `${JSON.stringify(
      {
        layer: "fixture (deterministic fake platform)",
        generated_at: generatedAt,
        mutants_expected: 16,
        mutants_reported: mutants.length,
        caught: mutants.filter((m) => m.caught).length,
        control_clean: mutants.filter((m) => m.control_clean).length,
        wall_seconds: Math.round((Date.now() - before) / 100) / 10,
        mutants: mutants.sort((a, b) => a.mutant.localeCompare(b.mutant)),
      },
      null,
      2,
    )}\n`,
  );
}

rmSync(work, { recursive: true, force: true });
const seconds = Math.round((Date.now() - started) / 100) / 10;
if (!ok) {
  console.error(
    `session matrix FAILED after ${seconds}s:\n${problems.join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `session matrix passed in ${seconds}s (${shards} shards); evidence in ${evidence}`,
);

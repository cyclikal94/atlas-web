#!/usr/bin/env node
// `pnpm test:session-matrix`: run EVERY combination of every scenario matrix (plan 13.4), sharded across processes, then
// the full-product mutation search, and write the evidence to .agtx/evidence/WEB-08a/fixture/matrix-<check>.json.
//
//   node scripts/run-session-matrix.mjs [--shards N] [--parts a,b] [--skip-mutants] [--only-mutants]
//
// The parts, their factors and their expected counts are in tests/support/session/matrix-registry.ts; the driver reads
// the expected counts from the shard files' own report and from a fixed table below, and fails when a total differs.
//
// The mutation search runs only after a COMPLETE, CLEAN scenario phase (WEB-08d revision 17, review r16 H7): every shard exited 0, and
// every selected part has exactly one sound record per shard, the expected number of scenarios and no violation. Otherwise the mutation
// phase is not started and is recorded as not run, with the reason. `--parts`, `--skip-mutants` and `--only-mutants` are diagnostics:
// their evidence is labelled partial and never stands for the full check. Each shard's records and output are kept under the evidence
// folder's `raw/` before the scratch folder is removed; `matrix-run.json` is the run's own account.
import { spawn } from "node:child_process";
import {
  cpSync,
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
// The 16 mutations of tests/support/session/mutants.ts, restated for the same reason (a mutation that reports nothing cannot hide).
const EXPECTED_MUTANTS = [
  "cancel-keeps-exposure-lock",
  "cancel-only-reserved",
  "cancelled-keeps-issue-lock",
  "closing-no-cancel-unsent",
  "closing-no-issue-wait",
  "closing-not-refused",
  "completion-accepted-for-cancelled",
  "exposure-lock-released-before-act",
  "hold-only-guard",
  "issue-lock-released-early",
  "no-boundary-guard",
  "no-closing-block",
  "no-ex1",
  "no-ex2-exposure",
  "no-ex3",
  "refused-lease-kept",
];

function usage(message) {
  console.error(`run-session-matrix: ${message}`);
  process.exit(2);
}
const known = new Set([
  "--shards",
  "--parts",
  "--skip-mutants",
  "--only-mutants",
]);
for (let i = 0; i < args.length; i += 1) {
  if (!known.has(args[i])) usage(`unknown argument ${args[i]}`);
  if (args[i] === "--shards" || args[i] === "--parts") {
    if (args[i + 1] === undefined || args[i + 1].startsWith("--"))
      usage(`${args[i]} needs a value`);
    i += 1;
  }
}
const shards = Number(
  value("--shards", Math.max(1, Math.min(cpus().length - 2, 12))),
);
if (!Number.isInteger(shards) || shards < 1)
  usage("--shards must be a positive integer");
const partFilter = value("--parts", "");
const selectedParts = partFilter
  ? partFilter.split(",")
  : Object.keys(EXPECTED);
if (selectedParts.some((p) => !(p in EXPECTED)))
  usage(
    `--parts names unknown parts: ${selectedParts.filter((p) => !(p in EXPECTED)).join(", ")}`,
  );
if (flag("--skip-mutants") && flag("--only-mutants"))
  usage("--skip-mutants and --only-mutants exclude each other");
const runScenarios = !flag("--only-mutants");
const wantMutants = !flag("--skip-mutants") && !partFilter;
const partial =
  Boolean(partFilter) || flag("--skip-mutants") || flag("--only-mutants");

const work = mkdtempSync(join(tmpdir(), "session-matrix-"));
const vitest = join(root, "node_modules/vitest/vitest.mjs");

function runShards(file, extraEnv) {
  return Promise.all(
    Array.from(
      { length: shards },
      (_, shard) =>
        new Promise((resolveRun) => {
          let log = "";
          let settled = false;
          const finish = (result) => {
            if (settled) return;
            settled = true;
            resolveRun({ shard, log, ...result });
          };
          let child;
          try {
            child = spawn(
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
          } catch (error) {
            finish({
              code: null,
              signal: null,
              spawnError: String(error.message ?? error),
            });
            return;
          }
          child.stdout.on("data", (d) => (log += d));
          child.stderr.on("data", (d) => (log += d));
          child.on("error", (error) =>
            finish({
              code: null,
              signal: null,
              spawnError: String(error.message ?? error),
            }),
          );
          child.on("close", (code, signal) => finish({ code, signal }));
        }),
    ),
  );
}

/** A shard child that did not end cleanly, as a problem. */
const childProblem = (kind, r) =>
  r.spawnError
    ? `${kind} shard ${r.shard} did not start: ${r.spawnError}`
    : r.code !== 0
      ? `${kind} shard ${r.shard} exited ${r.code ?? r.signal}\n${r.log.slice(-3000)}`
      : null;

/** Reads one record file; a file that cannot be read or parsed is a problem, never skipped. */
function readRecord(name, problems) {
  try {
    return JSON.parse(readFileSync(join(work, name), "utf8"));
  } catch (error) {
    problems.push(
      `record ${name} is unreadable: ${error.code ?? error.message}`,
    );
    return undefined;
  }
}

const count = (n) => Number.isInteger(n) && n >= 0;
const scenarioRecordOk = (d, name) =>
  d !== null &&
  typeof d === "object" &&
  typeof d.part === "string" &&
  Number.isInteger(d.shard) &&
  d.shard >= 0 &&
  d.shard < shards &&
  d.shards === shards &&
  count(d.run) &&
  count(d.failed) &&
  d.failed <= d.run &&
  Array.isArray(d.failures) &&
  d.stats !== null &&
  typeof d.stats === "object" &&
  typeof d.wall_ms === "number" &&
  name === `${d.part}.${d.shard}.json`;
const mutantRecordOk = (d, name) =>
  d !== null &&
  typeof d === "object" &&
  typeof d.mutant === "string" &&
  typeof d.caught === "boolean" &&
  typeof d.control_clean === "boolean" &&
  name === `mutant.${d.mutant}.json`;

/** Keeps what the shards wrote and said beside the evidence, before the scratch folder goes. */
function keepRaw(phase, runs, files, problems) {
  try {
    const dir = join(evidence, "raw", phase);
    mkdirSync(dir, { recursive: true });
    for (const f of files) cpSync(join(work, f), join(dir, f));
    for (const r of runs)
      writeFileSync(join(dir, `shard-${r.shard}.log`), r.log);
  } catch (error) {
    problems.push(
      `the ${phase} records could not be kept: ${error.code ?? error.message}`,
    );
  }
}

const started = Date.now();
const problems = [];
const generatedAt = new Date().toISOString();
const phases = {};
let exitCode = 1;
try {
  mkdirSync(evidence, { recursive: true });

  if (runScenarios) {
    const before = problems.length;
    const runs = await runShards(
      "tests/matrix/session.matrix.ts",
      partFilter ? { MATRIX_PARTS: partFilter } : {},
    );
    for (const r of runs) {
      const p = childProblem("scenario", r);
      if (p) problems.push(p);
    }
    const files = readdirSync(work).filter(
      (f) => !f.startsWith("mutant.") && f.endsWith(".json"),
    );
    keepRaw("scenarios", runs, files, problems);
    const byPart = new Map();
    for (const f of files) {
      const data = readRecord(f, problems);
      if (data === undefined) continue;
      if (!scenarioRecordOk(data, f)) {
        problems.push(`record ${f} is not a scenario record of this run`);
        continue;
      }
      if (!selectedParts.includes(data.part)) {
        problems.push(`record ${f} is for a part that was not selected`);
        continue;
      }
      const list = byPart.get(data.part) ?? [];
      list.push(data);
      byPart.set(data.part, list);
    }
    const byCheck = new Map();
    for (const id of selectedParts) {
      const expected = EXPECTED[id];
      const list = byPart.get(id) ?? [];
      const shardIds = new Set(list.map((s) => s.shard));
      const run = list.reduce((n, s) => n + s.run, 0);
      const failed = list.reduce((n, s) => n + s.failed, 0);
      const stats = {};
      for (const s of list)
        for (const [k, v] of Object.entries(s.stats))
          stats[k] = (stats[k] ?? 0) + v;
      const failures = list.flatMap((s) => s.failures).slice(0, 10);
      const complete =
        list.length === shards && shardIds.size === shards && run === expected;
      if (!complete || failed > 0)
        problems.push(
          `${id}: ran ${run} of ${expected} scenarios in ${list.length} records for ${shardIds.size}/${shards} shards, ${failed} failing`,
        );
      const entry = {
        part: id,
        scenarios_expected: expected,
        scenarios_run: run,
        failing: failed,
        complete,
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
            partial,
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
    phases.scenarios = {
      status: problems.length === before ? "passed" : "failed",
      parts: selectedParts,
      problems: problems.slice(before),
    };
  } else phases.scenarios = { status: "not_run", reason: "--only-mutants" };

  if (wantMutants && problems.length > 0) {
    // The gate: no mutation is admitted after an incomplete or failing scenario phase.
    const reason =
      "not started: the scenario phase did not pass (see problems)";
    phases.mutants = { status: "not_run", reason, not_run: EXPECTED_MUTANTS };
    writeFileSync(
      join(evidence, "matrix-mutants.json"),
      `${JSON.stringify(
        {
          layer: "fixture (deterministic fake platform)",
          generated_at: generatedAt,
          not_run: true,
          reason,
          mutants_expected: 16,
          mutants_reported: 0,
          not_run_mutants: EXPECTED_MUTANTS,
        },
        null,
        2,
      )}\n`,
    );
    console.error(`STOPPING: ${reason}. The mutation search is not started.`);
  } else if (wantMutants) {
    const before = Date.now();
    const already = problems.length;
    for (const f of readdirSync(work))
      if (f.startsWith("mutant.")) rmSync(join(work, f));
    const runs = await runShards("tests/matrix/mutants.matrix.ts", {});
    for (const r of runs) {
      const p = childProblem("mutation", r);
      if (p) problems.push(p);
    }
    const files = readdirSync(work).filter(
      (f) => f.startsWith("mutant.") && f.endsWith(".json"),
    );
    keepRaw("mutants", runs, files, problems);
    const mutants = [];
    for (const f of files) {
      const data = readRecord(f, problems);
      if (data === undefined) continue;
      if (!mutantRecordOk(data, f))
        problems.push(`record ${f} is not a mutation record`);
      else mutants.push(data);
    }
    const names = mutants.map((m) => m.mutant).sort();
    const missing = EXPECTED_MUTANTS.filter((n) => !names.includes(n));
    const unknown = names.filter((n) => !EXPECTED_MUTANTS.includes(n));
    const uncaught = mutants.filter((m) => !m.caught || !m.control_clean);
    if (
      uncaught.length > 0 ||
      missing.length > 0 ||
      unknown.length > 0 ||
      new Set(names).size !== names.length
    )
      problems.push(
        `mutation search: ${mutants.length} of 16 reported (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}), uncaught or dirty control: ${uncaught.map((m) => m.mutant).join(", ") || "none"}`,
      );
    phases.mutants = {
      status: problems.length === already ? "passed" : "failed",
      problems: problems.slice(already),
    };
    writeFileSync(
      join(evidence, "matrix-mutants.json"),
      `${JSON.stringify(
        {
          layer: "fixture (deterministic fake platform)",
          generated_at: generatedAt,
          mutants_expected: 16,
          mutants_reported: mutants.length,
          missing,
          caught: mutants.filter((m) => m.caught).length,
          control_clean: mutants.filter((m) => m.control_clean).length,
          wall_seconds: Math.round((Date.now() - before) / 100) / 10,
          mutants: mutants.sort((a, b) => a.mutant.localeCompare(b.mutant)),
        },
        null,
        2,
      )}\n`,
    );
  } else
    phases.mutants = {
      status: "not_run",
      reason: partFilter ? "--parts selects a subset" : "--skip-mutants",
    };
  exitCode = problems.length === 0 ? 0 : 1;
} catch (error) {
  problems.push(`the driver failed: ${error.stack ?? error}`);
  exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

const seconds = Math.round((Date.now() - started) / 100) / 10;
try {
  writeFileSync(
    join(evidence, "matrix-run.json"),
    `${JSON.stringify(
      {
        generated_at: generatedAt,
        partial,
        shards,
        passed: exitCode === 0,
        phases,
        problems,
        wall_seconds: seconds,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  console.error(
    `run-session-matrix: matrix-run.json could not be written: ${error.code ?? error.message}`,
  );
  exitCode = 1;
}
if (exitCode !== 0) {
  console.error(
    `session matrix FAILED after ${seconds}s:\n${problems.join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `session matrix ${partial ? "PARTIAL diagnostic " : ""}passed in ${seconds}s (${shards} shards); evidence in ${evidence}`,
);

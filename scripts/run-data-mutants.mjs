#!/usr/bin/env node
// WEB-09a plan 8.12 / S-7: runs the mutation catalogue (scripts/mutation/data-catalogue.mjs) on PATCHED COPIES of the source, never
// the tree, with an unmutated CONTROL for every distinct set of tests, and asserts the number of mutants.
//
//   node scripts/run-data-mutants.mjs [--only MU-01,MU-02] [--check] [--jobs N] [--out <dir>]
//
//   --check   only apply every patch (and fail if an anchor moved): no tests run
//   --jobs    mutants run at the same time (default 3)
//
// A mutant is CAUGHT when the named tests FAIL on it by an ASSERTION (vitest exits non-zero and at least one test is reported failed
// with an AssertionError). An unrelated crash (a test that throws something else, a suite that does not load) or a timeout is NOT
// evidence that a mutant was caught (validation policy VP-20261003), so each failure is classified:
//
//   assertion   an `AssertionError`, or the plain `Error` that vitest's `rejects`, `resolves` and the jest-dom matchers throw (recognised
//               by their assertion frames): the test said the behaviour is wrong
//   timeout     the test timed out
//   error       anything else the test threw (a TypeError of the mutated code, a setup failure)
//   suite       the file did not load at all
//
// A mutant with an `expect` pattern (every mutant since revision 12) is caught only if one of its ASSERTION failures matches it, so the
// test that was written for the defect is the one that fails. A mutant of an earlier revision without `expect` is reported by kind:
// one caught by crashes alone is listed as `crash_only_legacy` (it is never counted as an assertion catch, and the list is part of the
// evidence). A mutant that SURVIVES, one with a crash-only catch where `expect` is given, a patch that does not apply, and a control
// that fails are all failures of the run.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE, UNIT } from "./mutation/data-catalogue.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const outDir = resolve(root, value("--out", ".agtx/evidence/WEB-09a/mutants"));
const work = join(outDir, "work");
const only = value("--only", "").split(",").filter(Boolean);
const jobs = Number(value("--jobs", "3"));
const check = flag("--check");

const EXPECTED_UNIT = 1032;
const EXPECTED_ENGINE = 154;

const selected = UNIT.filter((m) => only.length === 0 || only.includes(m.id));
mkdirSync(outDir, { recursive: true });

function run(command, commandArgs, env) {
  return new Promise((done) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

const vitest = (files, report, env = {}) =>
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.mutant.config.ts",
      "--reporter=json",
      `--outputFile=${report}`,
      ...files,
    ],
    env,
  );

/** What kind of failure a test's messages describe (see the header). */
function kindOf(messages) {
  const text = (messages ?? []).join("\n");
  if (/timed out|timeout/i.test(text.split("\n")[0] ?? "")) return "timeout";
  // An expectation: vitest throws an `AssertionError` for `expect(...)`, and a plain `Error` that carries its own assertion frames for
  // `rejects`, `resolves` and the jest-dom matchers (`__VITEST_REJECTS__`, `__VITEST_RESOLVES__`, `__VITEST_EXTEND_ASSERTION__`).
  if (
    /^AssertionError\b/m.test(text) ||
    /__VITEST_[A-Z_]+__|\b_Assertion\./.test(text)
  )
    return "assertion";
  return "error";
}

function failedTests(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const names = [];
    const failures = [];
    for (const file of report.testResults ?? [])
      for (const test of file.assertionResults ?? [])
        if (test.status === "failed") {
          const name = `${file.name.replace(`${root}/`, "")} > ${test.fullName}`;
          names.push(name);
          failures.push({
            name,
            kind: kindOf(test.failureMessages),
            full: test.fullName,
          });
        }
    return {
      names,
      failures,
      total: report.numTotalTests ?? 0,
      failed: report.numFailedTests ?? 0,
      suitesFailed: (report.testResults ?? []).filter(
        (f) => f.status === "failed" && (f.assertionResults ?? []).length === 0,
      ).length,
    };
  } catch {
    return { names: [], failures: [], total: 0, failed: 0, suitesFailed: 0 };
  }
}

const results = [];

async function patchAll() {
  rmSync(work, { recursive: true, force: true });
  const out = [];
  for (const mutant of selected) {
    const path = join(root, mutant.file);
    const text = readFileSync(path, "utf8");
    try {
      const patched = mutant.patch(text);
      if (patched === text) throw new Error("the patch changed nothing");
      const target = join(work, mutant.id, mutant.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, patched);
      out.push({ mutant, applied: true });
    } catch (error) {
      out.push({
        mutant,
        applied: false,
        error: String(error.message ?? error),
      });
    }
  }
  return out;
}

const patches = await patchAll();
const unapplied = patches.filter((p) => !p.applied);
for (const p of unapplied)
  console.error(`PATCH FAILED ${p.mutant.id}: ${p.error}`);
if (check) {
  console.log(
    `${patches.length - unapplied.length} of ${patches.length} patches apply.`,
  );
  process.exit(unapplied.length === 0 ? 0 : 1);
}

// The unmutated control, once per distinct set of tests.
const controls = new Map();
for (const { mutant } of patches) {
  const key = [...mutant.tests].sort().join(",");
  if (!controls.has(key)) controls.set(key, mutant.tests);
}
const controlResults = [];
for (const [key, files] of controls) {
  const report = join(work, `control-${controlResults.length}.json`);
  const { code } = await vitest(files, report);
  const r = failedTests(report);
  controlResults.push({
    tests: files,
    passed: code === 0,
    total: r.total,
    failed: r.failed,
  });
  console.log(
    `control ${code === 0 ? "passes" : "FAILS"} (${r.total} tests): ${files.map((f) => f.replace("tests/data/", "")).join(" ")}`,
  );
  void key;
}

// The mutants, a few at a time.
const queue = patches.filter((p) => p.applied);
async function worker() {
  while (queue.length > 0) {
    const { mutant } = queue.shift();
    const dir = join(work, mutant.id);
    const report = join(dir, "report.json");
    const started = Date.now();
    const { code, output } = await vitest(mutant.tests, report, {
      ATLAS_MUTANT_DIR: dir,
    });
    const r = failedTests(report);
    const kinds = { assertion: 0, timeout: 0, error: 0, suite: r.suitesFailed };
    for (const failure of r.failures) kinds[failure.kind] += 1;
    const anyFailure = code !== 0 && (r.failed > 0 || r.suitesFailed > 0);
    const assertions = r.failures.filter((f) => f.kind === "assertion");
    // A mutant with `expect` is caught only by an assertion of the test written for it; one without it (an earlier revision's) by any
    // assertion, and a catch by crashes alone is reported, not counted as an assertion catch.
    const caught =
      code !== 0 &&
      (mutant.expect
        ? assertions.some((f) => mutant.expect.test(f.full))
        : assertions.length > 0);
    const crashOnly = anyFailure && assertions.length === 0;
    results.push({
      id: mutant.id,
      title: mutant.title,
      file: mutant.file,
      tests: mutant.tests,
      caught,
      crashOnly,
      expect: mutant.expect ? String(mutant.expect) : undefined,
      exit: code,
      kinds,
      failedTests: r.names.slice(0, 12),
      failedCount: r.failed,
      suitesFailed: r.suitesFailed,
      ms: Date.now() - started,
      ...(caught ? {} : { tail: output.slice(-400) }),
    });
    console.log(
      `${caught ? "caught  " : crashOnly ? "CRASH   " : "SURVIVED"} ${mutant.id} (${kinds.assertion} assertion, ${kinds.timeout} timeout, ${kinds.error} error, ${kinds.suite} suite failure(s))  ${mutant.title}`,
    );
  }
}
await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
results.sort((a, b) => a.id.localeCompare(b.id));

// An earlier revision's mutant that only crashed (no `expect`) is not an assertion catch: it is reported and does not fail the run
// (each is named in the evidence); a new mutant (with `expect`) that only crashed, or whose own test did not fail, does.
const legacyCrashOnly = results.filter(
  (r) => !r.caught && r.crashOnly && r.expect === undefined,
);
const survived = results.filter(
  (r) => !r.caught && !legacyCrashOnly.includes(r),
);
const countOk =
  only.length > 0 || results.length + unapplied.length === EXPECTED_UNIT;
const summary = {
  layer: "L1a/L1b (vitest, patched copies, unmutated control per test set)",
  expected_unit_mutants: EXPECTED_UNIT,
  expected_engine_mutants: EXPECTED_ENGINE,
  unit_mutants_run: results.length,
  patch_failures: unapplied.map((p) => ({ id: p.mutant.id, error: p.error })),
  caught: results.filter((r) => r.caught).length,
  crash_only_legacy: legacyCrashOnly.map((r) => r.id),
  survived: survived.map((r) => r.id),
  controls: controlResults,
  count_ok: countOk,
  engine_catalogue: ENGINE.map((m) => ({
    id: m.id,
    title: m.title,
    spec: m.spec,
    grep: m.grep,
  })),
  at: new Date().toISOString(),
};
writeFileSync(
  join(outDir, "unit-results.json"),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
);
console.log(
  `\n${summary.caught} of ${results.length} caught by an assertion; ${legacyCrashOnly.length} earlier mutant(s) caught by crashes alone (listed, not counted); ${survived.length} survived or caught by the wrong test; ${unapplied.length} patches failed; controls ${controlResults.every((c) => c.passed) ? "all pass" : "NOT all passing"}; count ${countOk ? "ok" : "WRONG"}`,
);
process.exit(
  survived.length === 0 &&
    unapplied.length === 0 &&
    controlResults.every((c) => c.passed) &&
    countOk
    ? 0
    : 1,
);

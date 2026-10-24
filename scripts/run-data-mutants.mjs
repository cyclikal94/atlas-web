#!/usr/bin/env node
// WEB-09a plan 8.12 / S-7: runs the mutation catalogue (scripts/mutation/data-catalogue.mjs) on PATCHED COPIES of the source, never
// the tree, with an unmutated CONTROL for every distinct set of tests, and asserts the number of mutants.
//
//   node scripts/run-data-mutants.mjs --out <new dir> [--only MU-01,MU-02] [--check] [--jobs N]
//
//   --out     a directory this run owns: it must not hold an earlier run's `unit-results.json` or `work` (nothing is overwritten)
//   --check   only apply every patch (and fail if an anchor moved): no tests run
//   --jobs    mutants run at the same time (default 3)
//   --only    a subset of the catalogue; the result is labelled `partial` and never stands for the whole catalogue
//
// A mutant is CAUGHT when the named tests FAIL on it by an ASSERTION and the run is otherwise sound (WEB-08d revision 17, review r16
// H6; scripts/validation/unit-results.mjs has the rules). Each failure MESSAGE is classified on its own (revision 18, review r17 H6a: a
// failed test can report several, for example its assertion and an error of its teardown):
//
//   assertion   an `AssertionError`, or the plain `Error` that vitest's `rejects`, `resolves` and the jest-dom matchers throw (recognised
//               by their assertion frames): the test said the behaviour is wrong
//   timeout     the test timed out
//   error       anything else the test threw (a TypeError of the mutated code, a setup failure)
//   suite       a file-level error (the file did not load, a hook failed)
//
// A timeout, an error, a suite error, an unhandled error, a damaged or incomplete report, a signal or a command that did not start makes
// the mutant INVALID even beside the expected assertion (that assertion is kept as an observation), in the same test or another. The
// only exception is an `error` message listed for that mutant, by exact test and message, in scripts/mutation/attributed-errors.mjs
// after a focused check; it is reported as attributed and never counted as a catch, and it covers that message alone. The ledger keeps
// every message (`failures`: test, ordinal, kind, headline, whole text) apart from the failed tests (`failedTests`, `failedCount`).
// A mutant with an `expect` pattern (every mutant since revision 12) is caught only by an assertion of the test written for it. A mutant
// of an earlier revision without `expect` is caught by any assertion; one whose only failures are crashes is listed as
// `crash_only_legacy` (never counted as an assertion catch, and the list is part of the evidence).
//
// FAIL FAST (review r16 H7): the first failure of the run (a patch that does not apply, a control that fails, a mutant that is not
// caught, a report or ledger that cannot be written, a signal) stops admission at once. Nothing new is started; mutants already running
// finish and keep their own results; everything else selected is recorded as `not_run` with the reason. Exit 0 only when every
// selected mutant ran and is caught (or a listed legacy crash), every control passed, and the ledger was written.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTRIBUTED,
  checkAttributions,
} from "./mutation/attributed-errors.mjs";
import { ENGINE, UNIT } from "./mutation/data-catalogue.mjs";
import {
  classifyControl,
  classifyMutant,
  failedTests,
  inspectRun,
} from "./validation/unit-results.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const EXPECTED_UNIT = 1392; // Accepted WEB-13a/API 0.29 main (1219) plus WEB-08d MU-1600 to MU-1709 (105) and accepted WEB-08c MU-8C-* (68, merged in revision 30).
const EXPECTED_ENGINE = 198; // 181 + WEB-08d (5) + accepted WEB-08c (12).

/** The command line, checked before anything is written or started: a selection that cannot run never passes vacuously. */
function options() {
  const known = new Set(["--out", "--only", "--jobs", "--check"]);
  const takesValue = new Set(["--out", "--only", "--jobs"]);
  const seen = {};
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (!known.has(name)) throw new Error(`unknown argument ${name}`);
    if (name in seen) throw new Error(`${name} given twice`);
    if (takesValue.has(name)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--"))
        throw new Error(`${name} needs a value`);
      seen[name] = v;
      i += 1;
    } else seen[name] = true;
  }
  if (!seen["--out"])
    throw new Error(
      "--out <new dir> is required (a run never writes into an earlier run's evidence)",
    );
  const jobs = Number(seen["--jobs"] ?? "3");
  if (!Number.isInteger(jobs) || jobs < 1)
    throw new Error("--jobs must be a positive integer");
  let only = [];
  if (seen["--only"] !== undefined) {
    only = seen["--only"].split(",");
    if (only.some((id) => id === "")) throw new Error("--only has an empty id");
    if (new Set(only).size !== only.length)
      throw new Error("--only names an id twice");
    const ids = new Set(UNIT.map((m) => m.id));
    const unknown = only.filter((id) => !ids.has(id));
    if (unknown.length > 0)
      throw new Error(
        `--only names ids not in the catalogue: ${unknown.join(", ")}`,
      );
  }
  const outDir = resolve(root, seen["--out"]);
  for (const owned of ["unit-results.json", "work"])
    if (existsSync(join(outDir, owned)))
      throw new Error(
        `${join(outDir, owned)} exists: give a new --out (an earlier run's evidence is never overwritten)`,
      );
  return { outDir, jobs, only, check: seen["--check"] === true };
}

let opts;
try {
  opts = options();
  checkAttributions(ATTRIBUTED, UNIT);
} catch (error) {
  console.error(`run-data-mutants: ${error.message}`);
  process.exit(2);
}
const { outDir, jobs, only, check } = opts;
const work = join(outDir, "work");
const partial = only.length > 0;
const selected = UNIT.filter((m) => !partial || only.includes(m.id));
mkdirSync(work, { recursive: true });

// ---- the stop latch: set synchronously, consulted before every new patch, control or mutant ------------------------------------------
const stop = { reason: null, at: null };
function halt(reason) {
  if (stop.reason !== null) return;
  stop.reason = reason;
  stop.at = new Date().toISOString();
  console.error(`STOPPING: ${reason}. Nothing new is started.`);
}

const children = new Set();
function forward(signal) {
  halt(`interrupted by ${signal}`);
  for (const child of children) child.kill(signal);
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 10_000).unref();
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

function run(command, commandArgs, env) {
  return new Promise((done) => {
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      done({ ...result, output });
    };
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) =>
      finish({
        code: null,
        signal: null,
        spawnError: String(error.message ?? error),
      }),
    );
    child.on("close", (code, signal) => finish({ code, signal }));
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

/** Reads what a finished run left (synchronously, so the verdict is latched before the scheduler can admit anything else). */
function inspect(files, report, result) {
  let text;
  let readError;
  try {
    text = readFileSync(report, "utf8");
  } catch (error) {
    readError = error.code ?? String(error.message ?? error);
  }
  return inspectRun({ ...result, text, readError, files, root });
}

/** Keeps the child's whole output beside its report; a write that fails is a failure of the run, never ignored. */
function keepLog(path, output) {
  try {
    writeFileSync(path, output);
    return path;
  } catch (error) {
    halt(`could not keep ${path}: ${error.code ?? error.message}`);
    return null;
  }
}

const rel = (path) => path.replace(`${root}/`, "");

// ---- patches: a copy of the source per mutant; the first that does not apply stops the run (all are tried under --check) -------------
const patches = [];
for (const mutant of selected) {
  if (!check && stop.reason !== null) break;
  try {
    const text = readFileSync(join(root, mutant.file), "utf8");
    const patched = mutant.patch(text);
    if (patched === text) throw new Error("the patch changed nothing");
    const target = join(work, mutant.id, mutant.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, patched);
    patches.push({ mutant, applied: true });
  } catch (error) {
    patches.push({
      mutant,
      applied: false,
      error: String(error.message ?? error),
    });
    console.error(`PATCH FAILED ${mutant.id}: ${error.message ?? error}`);
    if (!check) halt(`the patch of ${mutant.id} does not apply`);
  }
}
const unapplied = patches.filter((p) => !p.applied);
if (check) {
  console.log(
    `${patches.length - unapplied.length} of ${patches.length} patches apply.`,
  );
  process.exit(unapplied.length === 0 ? 0 : 1);
}

// ---- controls: the unmutated tests, once per distinct set, one at a time; a failure stops before any mutant -------------------------
const controlSets = new Map();
for (const mutant of selected) {
  const key = [...mutant.tests].sort().join(",");
  if (!controlSets.has(key)) controlSets.set(key, mutant.tests);
}
const controls = [];
const inventories = new Map();
for (const [key, files] of controlSets) {
  const index = controls.length;
  if (stop.reason !== null) {
    controls.push({ index, tests: files, status: "not_run", passed: false });
    continue;
  }
  const report = join(work, `control-${index}.json`);
  let result;
  let verdict;
  try {
    result = await vitest(files, report);
    verdict = classifyControl(inspect(files, report, result));
  } catch (error) {
    result ??= { code: null, signal: null, output: "" };
    verdict = {
      passed: false,
      problems: [
        `the runner could not judge this control: ${error.message ?? error}`,
      ],
      inventory: {},
      total: 0,
      passing: 0,
      failed: 0,
      skipped: 0,
    };
  }
  if (!verdict.passed) halt(`control ${index} failed (${verdict.problems[0]})`);
  const log = keepLog(join(work, `control-${index}.log`), result.output);
  inventories.set(key, verdict.inventory);
  controls.push({
    index,
    tests: files,
    status: verdict.passed ? "passed" : "failed",
    passed: verdict.passed,
    exit: result.code,
    signal: result.signal ?? null,
    total: verdict.total,
    passing: verdict.passing,
    skipped: verdict.skipped,
    failed: verdict.failed,
    problems: verdict.problems,
    report: rel(report),
    log: log && rel(log),
  });
  console.log(
    `control ${verdict.passed ? "passes" : "FAILS"} (${verdict.total} tests): ${files.map((f) => f.replace("tests/data/", "")).join(" ")}${verdict.passed ? "" : ` — ${verdict.problems.join("; ")}`}`,
  );
}

// ---- mutants: a bounded pool; each worker checks the latch before taking the next one --------------------------------------------
const results = [];
const queue = patches.filter((p) => p.applied).map((p) => p.mutant);
async function worker() {
  while (stop.reason === null && queue.length > 0) {
    const mutant = queue.shift();
    const dir = join(work, mutant.id);
    const report = join(dir, "report.json");
    const started = Date.now();
    let result;
    let seen;
    let verdict;
    try {
      result = await vitest(mutant.tests, report, { ATLAS_MUTANT_DIR: dir });
      // From here to the end of the iteration everything is synchronous: the verdict and the latch come before any other admission.
      seen = inspect(mutant.tests, report, result);
      verdict = classifyMutant(
        mutant,
        seen,
        inventories.get([...mutant.tests].sort().join(",")),
        ATTRIBUTED[mutant.id]?.failures ?? [],
      );
    } catch (error) {
      result ??= { code: null, signal: null, output: "" };
      seen ??= { tests: [], errors: [] };
      verdict = {
        status: "invalid",
        ok: false,
        caught: false,
        expected_assertion_observed: false,
        crashOnly: false,
        failed_tests: 0,
        kinds: { assertion: 0, timeout: 0, error: 0, suite: 0 },
        problems: [
          `the runner could not judge this mutant: ${error.message ?? error}`,
        ],
        unexpected: [],
        attributed: [],
      };
    }
    if (!verdict.ok) halt(`${mutant.id} is ${verdict.status}`);
    const log = keepLog(join(dir, "output.log"), result.output);
    // Every reported message, each with its test occurrence and ordinal; the failed tests are counted from the tests themselves.
    const failures = seen.errors.map((f) => ({
      name: f.name,
      test: f.test,
      ordinal: f.ordinal,
      kind: f.kind,
      message: f.message,
      text: f.text,
    }));
    const failed = failedTests(seen);
    results.push({
      id: mutant.id,
      title: mutant.title,
      file: mutant.file,
      tests: mutant.tests,
      status: verdict.status,
      caught: verdict.caught,
      expected_assertion_observed: verdict.expected_assertion_observed,
      crashOnly: verdict.crashOnly,
      expect: mutant.expect ? String(mutant.expect) : undefined,
      exit: result.code,
      signal: result.signal ?? null,
      kinds: verdict.kinds,
      problems: verdict.problems,
      unexpected: verdict.unexpected,
      attributed: verdict.attributed,
      failures,
      failedTests: failed.map((t) => t.name),
      failedCount: failed.length,
      messageCount: failures.length,
      ms: Date.now() - started,
      report: rel(report),
      log: log && rel(log),
    });
    console.log(
      `${verdict.status.toUpperCase().padEnd(17)} ${mutant.id} (${failed.length} failed test(s): ${verdict.kinds.assertion} assertion, ${verdict.kinds.timeout} timeout, ${verdict.kinds.error} error message(s)${verdict.attributed.length ? ` (${verdict.attributed.length} attributed)` : ""}; ${verdict.kinds.suite} suite failure(s))  ${mutant.title}${verdict.problems.length ? ` — ${verdict.problems[0]}` : ""}`,
    );
  }
}

if (stop.reason === null)
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, worker),
  );
results.sort((a, b) => a.id.localeCompare(b.id));

// ---- one account of every selected mutant ---------------------------------------------------------------------------------------
const ran = new Set(results.map((r) => r.id));
const failedPatch = new Set(unapplied.map((p) => p.mutant.id));
const notRun = selected
  .map((m) => m.id)
  .filter((id) => !ran.has(id) && !failedPatch.has(id));
const by = (status) =>
  results.filter((r) => r.status === status).map((r) => r.id);
const ok = (r) => r.status === "caught" || r.status === "crash_only_legacy";
const catalogueOk = UNIT.length === EXPECTED_UNIT;
const complete = notRun.length === 0 && failedPatch.size === 0;
const passed =
  stop.reason === null &&
  complete &&
  results.every(ok) &&
  controls.every((c) => c.passed) &&
  catalogueOk;
const summary = {
  layer: "L1a/L1b (vitest, patched copies, unmutated control per test set)",
  rules:
    "revision 18: a catch needs the intended assertion AND a sound run (no unexpected failure of another kind, judged per failure message, in any test); fail fast",
  partial,
  selected: selected.length,
  expected_unit_mutants: EXPECTED_UNIT,
  catalogue_size: UNIT.length,
  catalogue_ok: catalogueOk,
  expected_engine_mutants: EXPECTED_ENGINE,
  unit_mutants_run: results.length,
  patch_failures: unapplied.map((p) => ({ id: p.mutant.id, error: p.error })),
  caught: by("caught").length,
  crash_only_legacy: by("crash_only_legacy"),
  survived: [
    ...by("survived"),
    ...by("wrong_test"),
    ...by("crash_only"),
  ].sort(),
  invalid: by("invalid"),
  expected_assertion_with_unexpected_failures: results
    .filter((r) => r.status === "invalid" && r.expected_assertion_observed)
    .map((r) => r.id),
  attributed: results
    .filter((r) => r.attributed.length > 0)
    .map((r) => ({ id: r.id, failures: r.attributed })),
  not_run: notRun,
  states: Object.fromEntries(
    [
      "caught",
      "crash_only_legacy",
      "survived",
      "wrong_test",
      "crash_only",
      "invalid",
    ].map((s) => [s, by(s).length]),
  ),
  stopped: stop.reason === null ? null : stop,
  controls,
  count_ok: partial || (catalogueOk && complete),
  passed,
  engine_catalogue: ENGINE.map((m) => ({
    id: m.id,
    title: m.title,
    spec: m.spec,
    grep: m.grep,
  })),
  at: new Date().toISOString(),
};
let written = false;
try {
  const ledger = join(outDir, "unit-results.json");
  writeFileSync(
    `${ledger}.partial`,
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );
  renameSync(`${ledger}.partial`, ledger);
  written = true;
} catch (error) {
  console.error(
    `run-data-mutants: the ledger could not be written: ${error.code ?? error.message}`,
  );
}
console.log(
  `\n${summary.caught} of ${results.length} caught by an assertion in a sound run; ${summary.crash_only_legacy.length} earlier mutant(s) caught by crashes alone (listed, not counted); ${summary.survived.length} survived or caught by the wrong test; ${summary.invalid.length} invalid (${summary.expected_assertion_with_unexpected_failures.length} of them beside the expected assertion); ${summary.attributed.length} with attributed errors; ${unapplied.length} patches failed; ${notRun.length} not run; controls ${controls.every((c) => c.passed) ? "all pass" : "NOT all passing"}; ${partial ? "partial selection" : `count ${summary.count_ok ? "ok" : "WRONG"}`}${stop.reason ? `; STOPPED: ${stop.reason}` : ""}`,
);
process.exit(passed && written ? 0 : 1);

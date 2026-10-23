// WEB-14a revision 27 (review r26 R31, design assessment DA-H2, C1-C4): the evidence contract shared by every consumer that judges a
// Vitest run by its failures (scripts/run-data-mutants.mjs and the WEB-14a counterfactual runner). Pure: nothing here spawns or
// writes, so the self-test (vitest-evidence.test.mjs) drives it with synthetic envelopes and the supervised child
// (vitest-supervised.mjs) uses `project` for its records.
//
// Why: Vitest 5.0.1's JSON reporter keeps only the first top-level file error's MESSAGE (an empty message reads as no error), drops the
// nested suite errors and the unhandled errors, and is written before shutdown, whose failures Vitest only logs. Judging from it alone
// admitted runs with errors beside an intended assertion. Here an error is present because it was COUNTED, never because its value
// printed as something (invariant I1), every channel is counted (I2), and only a terminal envelope written after an owned shutdown can
// be admitted (I3).
import { existsSync, readFileSync, statSync } from "node:fs";

export const REQUEST_SCHEMA = "atlas-vitest-request/1";
export const ENVELOPE_SCHEMA = "atlas-vitest-evidence/1";
/** The lifecycle this adapter was qualified against. Any other version is refused, not assumed compatible. */
export const PINNED_VITEST = "5.0.1";

/**
 * A JSON-safe record of one thrown value. Presence is never decided here: callers count the values before projecting them, and a
 * value that cannot be read is still one occurrence (`kind: "unserialisable"`).
 */
export function project(value) {
  try {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return {
        kind: value === null ? "null" : typeof value,
        text: safeString(value),
      };
    const text = (key) => {
      const v = value[key];
      return typeof v === "string" ? v : v === undefined ? null : safeString(v);
    };
    return {
      kind: "object",
      name: text("name"),
      message: text("message"),
      type: text("type"),
      stack: text("stack"),
    };
  } catch {
    return { kind: "unserialisable" };
  }
}

function safeString(value) {
  try {
    return typeof value === "symbol" ? value.toString() : String(value);
  } catch {
    return "<unprintable>";
  }
}

/** The first line Vitest's JSON reporter prints for a failure (`stack || message`), which named-message oracles match. */
export function firstLine(error) {
  if (error?.kind !== "object") return String(error?.text ?? "");
  return String(error.stack || error.message || "").split("\n")[0] ?? "";
}

/**
 * The kind of ONE error of a test (each error is classified separately, so an assertion never conceals another error, DA-H2):
 *   assertion  an AssertionError, or the plain Error that `rejects`, `resolves` and extended matchers throw (their assertion frames)
 *   inverted   Vitest's own failure of a `test.fails` case that passed: that case's assertion, admissible only for a test.fails case
 *   timeout    a test or hook time-out
 *   error      anything else, whatever its text says
 */
export function classify(error, { fails = false } = {}) {
  if (error?.kind !== "object") return "error";
  const message = error.message ?? "";
  if (/timed out/i.test(message.split("\n")[0] ?? "")) return "timeout";
  if (fails && error.name === "Error" && message === "Expect test to fail")
    return "inverted";
  if (error.name === "AssertionError") return "assertion";
  if (
    /__VITEST_(REJECTS|RESOLVES|EXTEND_ASSERTION)__|\b_Assertion\./.test(
      error.stack ?? "",
    )
  )
    return "assertion";
  return "error";
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * Validate a terminal envelope against the request it must answer. Returns the problems (empty when admissible as COMPLETE evidence;
 * whether the run was clean is decided by `readRun`). Anything missing, extra, inconsistent or of another version is a problem.
 */
export function validateEnvelope(
  envelope,
  { nonce, label, vitest = PINNED_VITEST } = {},
) {
  const problems = [];
  const fail = (text) => problems.push(text);
  if (envelope === null || typeof envelope !== "object")
    return ["envelope is not an object"];
  if (envelope.schema !== ENVELOPE_SCHEMA)
    fail(`unsupported envelope schema ${JSON.stringify(envelope.schema)}`);
  if (nonce !== undefined && envelope.nonce !== nonce)
    fail("envelope answers another request (nonce)");
  if (label !== undefined && envelope.label !== label)
    fail(
      `envelope is for ${JSON.stringify(envelope.label)}, not ${JSON.stringify(label)}`,
    );
  if (envelope.vitest !== vitest)
    fail(
      `Vitest ${JSON.stringify(envelope.vitest)} is not the qualified ${vitest}`,
    );
  if (envelope.supported !== true)
    fail(
      `unsupported lifecycle: ${(envelope.unsupported ?? ["unknown"]).join("; ")}`,
    );
  if (envelope.complete !== true)
    fail("envelope does not record a completed run and shutdown");
  if (!isCount(envelope.exitCode)) fail("exit code missing");
  const w = envelope.witness;
  if (!w || typeof w !== "object") {
    fail("no witness record");
    return problems;
  }
  if (w.onTestRunEndCalls !== 1)
    fail(
      `onTestRunEnd reported ${JSON.stringify(w.onTestRunEndCalls)} time(s), expected once`,
    );
  if (!["passed", "failed"].includes(w.reason))
    fail(`run ended ${JSON.stringify(w.reason)}`);
  for (const [key, list] of [
    ["modules", w.modules],
    ["suites", w.suites],
    ["tests", w.tests],
  ]) {
    if (!Array.isArray(list)) {
      fail(`witness ${key} missing`);
      continue;
    }
    for (const node of list) {
      if (
        !node ||
        typeof node !== "object" ||
        !isCount(node.errorCount) ||
        !Array.isArray(node.errors) ||
        node.errors.length !== node.errorCount
      )
        fail(
          `witness ${key} entry with inconsistent errors: ${JSON.stringify(node?.fullName ?? node?.id ?? node).slice(0, 120)}`,
        );
    }
  }
  if (!Array.isArray(w.modules) || w.modules.length === 0)
    fail("no test module was reported");
  for (const [key, count, list] of [
    ["unhandled", w.unhandledCount, w.unhandled],
    ["witness failures", w.failureCount, w.failures],
    ["late unhandled", envelope.lateUnhandledCount, envelope.lateUnhandled],
    ["logged", envelope.logged?.count, envelope.logged?.calls],
    ["process", envelope.processEvents?.count, envelope.processEvents?.events],
  ])
    if (!isCount(count) || !Array.isArray(list) || list.length !== count)
      fail(`${key} count is missing or disagrees with its occurrences`);
  if (
    typeof envelope.startError !== "object" ||
    typeof envelope.closeError !== "object"
  )
    fail("start/close error records missing");
  if (typeof envelope.closeTimedOut !== "boolean")
    fail("close time-out record missing");
  return problems;
}

/**
 * Read one supervised child's complete evidence: process outcome, terminal envelope and JSON report, bound together. `child` is
 * `{ code, signal, spawnError }`. Returns `{ complete, problems, cases, taint, exitCode }`: `cases` lists each case (`name` is
 * `ancestors > title`; titles may repeat) with its module, status, mode and classified errors; `taint` lists every error outside a test (module, suite,
 * unhandled, late, logged, process, start, close, witness), each counted, never inferred from text.
 */
export function readRun({
  child,
  envelopePath,
  reportPath,
  startedMs,
  nonce,
  label,
}) {
  const problems = [];
  if (child?.spawnError)
    return { complete: false, problems: [`spawn error: ${child.spawnError}`] };
  if (child?.signal)
    return { complete: false, problems: [`terminated by ${child.signal}`] };
  const envelope = readJson(envelopePath, startedMs, "envelope");
  if (envelope.problem)
    return { complete: false, problems: [envelope.problem] };
  problems.push(...validateEnvelope(envelope, { nonce, label }));
  if (child?.code !== envelope.exitCode)
    problems.push(
      `child exited ${child?.code}, envelope records ${envelope.exitCode}`,
    );
  const report = readJson(reportPath, startedMs, "JSON report");
  if (report.problem) problems.push(report.problem);
  if (problems.length > 0) return { complete: false, problems };

  const w = envelope.witness;
  // Case titles need not be unique (parametrised tests repeat them, files share them): cases are a list, matched to the JSON report
  // by module and name in order of appearance.
  const cases = w.tests.map((t) => ({
    name: [...t.ancestors, t.name].join(" > "),
    jsonName: [...t.ancestors, t.name].join(" "),
    module: t.module,
    moduleId: t.moduleId,
    status: t.state,
    fails: t.fails === true,
    ms: t.ms ?? null,
    errors: t.errors.map((e) => ({
      kind: classify(e, { fails: t.fails === true }),
      firstLine: firstLine(e),
    })),
  }));
  // The JSON report is kept for inspection and must describe exactly the same cases, outcomes and number of failures.
  const keyOf = (moduleId, name) => `${moduleId}\u0000${name}`;
  const jsonCases = new Map();
  let jsonCount = 0;
  if (!Array.isArray(report.testResults))
    problems.push("JSON report has no testResults");
  for (const file of Array.isArray(report.testResults)
    ? report.testResults
    : [])
    for (const t of file.assertionResults ?? []) {
      const key = keyOf(
        file.name,
        [...(t.ancestorTitles ?? []), t.title].join(" > "),
      );
      jsonCases.set(key, [...(jsonCases.get(key) ?? []), t]);
      jsonCount += 1;
    }
  if (jsonCount !== cases.length)
    problems.push(
      `JSON report lists ${jsonCount} case(s), the witness ${cases.length}`,
    );
  const taken = new Map();
  for (const c of cases) {
    const key = keyOf(c.moduleId, c.name);
    const index = taken.get(key) ?? 0;
    taken.set(key, index + 1);
    const j = jsonCases.get(key)?.[index];
    if (!j) {
      problems.push(`JSON report lacks ${c.module} > ${c.name}`);
      continue;
    }
    if (j.status !== c.status)
      problems.push(`${c.name}: JSON status ${j.status}, witness ${c.status}`);
    if ((j.failureMessages ?? []).length !== c.errors.length)
      problems.push(
        `${c.name}: JSON reports ${(j.failureMessages ?? []).length} failure(s), witness ${c.errors.length}`,
      );
  }
  if (problems.length > 0) return { complete: false, problems };

  const taint = [];
  for (const m of w.modules)
    if (m.errorCount > 0)
      taint.push(`module ${m.id}: ${m.errorCount} error(s)`);
  for (const s of w.suites)
    if (s.errorCount > 0)
      taint.push(`suite ${s.fullName}: ${s.errorCount} error(s)`);
  if (w.unhandledCount > 0)
    taint.push(`${w.unhandledCount} unhandled error(s)`);
  if (w.failureCount > 0) taint.push(`${w.failureCount} witness failure(s)`);
  if (envelope.lateUnhandledCount > 0)
    taint.push(
      `${envelope.lateUnhandledCount} unhandled error(s) after the run`,
    );
  if (envelope.logged.count > 0)
    taint.push(
      `${envelope.logged.count} error(s) logged by Vitest (${[...new Set(envelope.logged.calls.map((c) => c.phase))].join(", ")})`,
    );
  if (envelope.processEvents.count > 0)
    taint.push(`${envelope.processEvents.count} process-level error event(s)`);
  if (envelope.startError !== null) taint.push("the run itself threw");
  if (envelope.closeError !== null) taint.push("shutdown threw");
  if (envelope.closeTimedOut) taint.push("shutdown timed out");
  // Counts per channel (module and suite errors are the earlier runner's `suite` kind).
  const outside = {
    suite:
      w.modules.reduce((n, m) => n + m.errorCount, 0) +
      w.suites.reduce((n, s) => n + s.errorCount, 0),
    unhandled: w.unhandledCount + envelope.lateUnhandledCount,
    logged: envelope.logged.count,
    process: envelope.processEvents.count,
    lifecycle:
      w.failureCount +
      (envelope.startError === null ? 0 : 1) +
      (envelope.closeError === null ? 0 : 1) +
      (envelope.closeTimedOut ? 1 : 0),
  };
  return {
    complete: true,
    problems: [],
    cases,
    taint,
    outside,
    exitCode: envelope.exitCode,
    reason: w.reason,
  };
}

function readJson(path, startedMs, what) {
  if (!path || !existsSync(path)) return { problem: `${what} missing` };
  if (statSync(path).mtimeMs < startedMs)
    return { problem: `${what} stale (older than its child)` };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problem: `${what} malformed: ${error?.message ?? error}` };
  }
}

/** Counts of each kind over the failed cases, and whether any case failed by something other than an assertion. */
export function failureKinds(cases) {
  const kinds = { assertion: 0, inverted: 0, timeout: 0, error: 0 };
  const failed = [];
  for (const c of cases) {
    if (c.status !== "failed") continue;
    if (c.errors.length === 0) kinds.error += 1;
    for (const e of c.errors) kinds[e.kind] += 1;
    failed.push(c);
  }
  return { kinds, failed };
}

/**
 * A clean healthy control: complete evidence, no taint, every case passed or skipped (designed skips stay visible in `skipped`),
 * exit code 0.
 */
export function controlVerdict(run) {
  if (!run.complete) return { verdict: "incomplete", reasons: run.problems };
  if (run.taint.length > 0) return { verdict: "error", reasons: run.taint };
  const bad = run.cases.filter(
    (c) => c.status !== "passed" && c.status !== "skipped",
  );
  const skipped = run.cases.filter((c) => c.status === "skipped").length;
  if (bad.length > 0 || run.exitCode !== 0)
    return {
      verdict: "fail",
      reasons: [
        `exit ${run.exitCode}; ${bad.length} case(s) not passed: ${bad
          .slice(0, 5)
          .map((c) => `${c.name} (${c.status})`)
          .join("; ")}`,
      ],
      skipped,
    };
  return { verdict: "pass", reasons: [], skipped, total: run.cases.length };
}

/**
 * A unit mutant (scripts/run-data-mutants.mjs). The catalogue's existing rule is kept: with `expect`, an ASSERTION failure of a test
 * whose JSON full name matches it; without (an earlier revision's mutant), any assertion, and a run with failures but no assertion is
 * `crash_only` (listed, never counted). New with DA-H2: a catch must also be clean, so any time-out, non-assertion error or error
 * outside a test beside the assertions makes the run `tainted` (never caught), and incomplete evidence is `incomplete`. A `test.fails`
 * inversion counts as an assertion only for a case the mutant's own `expect` names (I5).
 */
export function unitVerdict(run, mutant) {
  if (!run.complete) return { verdict: "incomplete", reasons: run.problems };
  const { kinds, failed } = failureKinds(run.cases);
  const base = {
    // `suite` keeps the earlier runner's field (module and suite errors); `outside` counts every error outside a test.
    kinds: {
      ...kinds,
      suite: run.outside?.suite ?? 0,
      outside: Object.values(run.outside ?? {}).reduce((a, b) => a + b, 0),
    },
    failedTests: failed.map((c) => `${c.module} > ${c.jsonName}`),
  };
  // A test.fails inversion is Vitest's assertion of an expected failure: it counts toward a catch only for a case the mutant's
  // `expect` names, and elsewhere stands like an unrelated assertion (neither a catch nor a veto), as the earlier runner had it.
  const admissible = (c, e) =>
    e.kind === "assertion" ||
    (e.kind === "inverted" && mutant.expect?.test(c.jsonName) === true);
  const clean = (e) => e.kind === "assertion" || e.kind === "inverted";
  const assertions = failed.filter(
    (c) => c.errors.length > 0 && c.errors.every((e) => admissible(c, e)),
  );
  const dirty =
    run.taint.length > 0 ||
    failed.some(
      (c) => c.errors.length === 0 || c.errors.some((e) => !clean(e)),
    );
  if (failed.length === 0 && run.taint.length === 0)
    return { ...base, verdict: "survived", reasons: ["no test failed"] };
  const anyAssertion = failed.some((c) =>
    c.errors.some((e) => admissible(c, e)),
  );
  if (!anyAssertion)
    return {
      ...base,
      verdict: "crash_only",
      reasons: [
        ...run.taint,
        `${kinds.timeout} time-out(s), ${kinds.error} error(s), ${kinds.inverted} inversion(s) no oracle names, no assertion`,
      ],
    };
  if (dirty)
    return {
      ...base,
      verdict: "tainted",
      reasons: [
        ...run.taint,
        `${kinds.timeout} time-out(s) and ${kinds.error} non-assertion error(s) beside the assertions`,
      ],
    };
  if (run.exitCode === 0)
    return {
      ...base,
      verdict: "incomplete",
      reasons: ["failed cases but exit code 0"],
    };
  if (mutant.expect && !assertions.some((c) => mutant.expect.test(c.jsonName)))
    return {
      ...base,
      verdict: "wrong_test",
      reasons: [`no assertion failure matches ${mutant.expect}`],
    };
  return { ...base, verdict: "caught", reasons: [] };
}

/** A Vitest `testNamePattern` (as `{ source, flags }`) selecting exactly these full test names (`describe > … > title`). */
export function namePatternOf(names) {
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    source: `^(?:${[...new Set(names)].map(literal).join("|")})$`,
    flags: "",
  };
}

/**
 * A narrowed selection (scripts/mutation/unit-selections.mjs) must have run EXACTLY its declared cases: every declared `{ module,
 * name }` once and nothing else (every other case of the files skipped by the name filter). Returns the problems (empty when exact).
 */
export function selectionProblems(run, cases) {
  if (!run.complete) return [];
  const key = (c) => `${c.module} :: ${c.name}`;
  const ran = run.cases
    .filter((c) => c.status !== "skipped")
    .map(key)
    .sort();
  const declared = cases.map(key).sort();
  const problems = [];
  const missing = declared.filter(
    (k, i) => declared.indexOf(k) === i && !ran.includes(k),
  );
  const extra = ran.filter((k) => !declared.includes(k));
  if (missing.length > 0)
    problems.push(`declared case(s) not run: ${missing.join("; ")}`);
  if (extra.length > 0)
    problems.push(`undeclared case(s) run: ${extra.join("; ")}`);
  if (ran.length !== declared.length)
    problems.push(`ran ${ran.length} case(s), declared ${declared.length}`);
  return problems;
}

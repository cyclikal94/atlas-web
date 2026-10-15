// What one Vitest run of the unit mutation runner (scripts/run-data-mutants.mjs) establishes (WEB-08d revision 17, review r16 H6).
//
// Two questions are kept apart:
//
//   sensitivity  did the test written for the defect fail by an ASSERTION (`expected_assertion_observed`)?
//   validity     is the run a readable, complete, attributable execution with no failure of any other kind?
//
// A mutant is CAUGHT only when both hold. An expected assertion beside an unexpected error, timeout, file-level (suite) error, unhandled
// error or a damaged report is INVALID: the assertion is kept as an observation, and the other failure fails the run. This is the same
// rule as the native runner (scripts/validation/engine-results.mjs: every failure must be an assertion). The one exception is narrow and
// explicit: an `error` failure listed for that mutant in scripts/mutation/attributed-errors.mjs, by exact test, kind and message, after a
// focused check showed it is a consequence of that mutation. Such a failure is ATTRIBUTED, kept beside the catch and never counted as one.
//
// A control (the same tests, unmutated) passes only with exit 0, a complete readable report, at least one passing test, every selected
// test file present and no failure of any kind. Its passing tests are the inventory a mutant run must account for: each one is reported
// again, passed or failed (a test that is skipped or missing on the mutant did not run, so the run is incomplete).

/** The kind of failure a failed test's messages describe. The recognition rules are the runner's since WEB-09a (unchanged). */
export function kindOf(messages) {
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

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const STATUSES = new Set(["passed", "failed", "skipped", "pending", "todo"]);
const integer = (n) => Number.isInteger(n) && n >= 0;

/** Vitest prints these for errors outside any test; the JSON report has no field for them, so the output is read. */
export function unhandledErrors(output) {
  const text = String(output ?? "").replace(ANSI, "");
  const caught = /Vitest caught (\d+) unhandled errors?/.exec(text);
  const count = caught ? Number(caught[1]) : 0;
  return /There were unhandled errors during test collection/.test(text)
    ? Math.max(count, 1)
    : count;
}

/**
 * Everything one run says, with every problem that makes it unusable as evidence. Pure: the caller reads the report file and passes its
 * text (or the read error), the exit code or signal, any spawn error, and the child's output.
 */
export function inspectRun({
  text,
  readError,
  files,
  root,
  code,
  signal,
  spawnError,
  output,
}) {
  const problems = [];
  const tests = [];
  const failures = [];
  const fileErrors = [];
  const reported = new Set();
  if (spawnError)
    problems.push(`the test command did not start: ${spawnError}`);
  if (signal) problems.push(`the test command ended by ${signal}`);
  const unhandled = unhandledErrors(output);
  if (unhandled > 0)
    problems.push(`${unhandled} unhandled error(s) outside any test`);
  let report;
  if (readError !== undefined)
    problems.push(`the report could not be read: ${readError}`);
  else
    try {
      report = JSON.parse(text);
    } catch (error) {
      problems.push(`the report is not JSON: ${error.message}`);
    }
  if (report !== undefined) {
    const shapeOk =
      report !== null &&
      typeof report === "object" &&
      Array.isArray(report.testResults) &&
      integer(report.numTotalTests) &&
      integer(report.numPassedTests) &&
      integer(report.numFailedTests) &&
      typeof report.success === "boolean";
    if (!shapeOk) problems.push("the report is not a Vitest JSON report");
    else {
      for (const file of report.testResults) {
        if (
          !file ||
          typeof file.name !== "string" ||
          !Array.isArray(file.assertionResults)
        ) {
          problems.push("a test file entry is malformed");
          continue;
        }
        const name = file.name.startsWith(`${root}/`)
          ? file.name.slice(root.length + 1)
          : file.name;
        reported.add(name);
        let failedHere = 0;
        for (const test of file.assertionResults) {
          if (
            !test ||
            typeof test.fullName !== "string" ||
            !STATUSES.has(test.status)
          ) {
            problems.push(`a test entry in ${name} is malformed`);
            continue;
          }
          const key = `${name} > ${test.fullName}`;
          tests.push({ key, status: test.status });
          if (test.status !== "failed") continue;
          failedHere += 1;
          const messages = Array.isArray(test.failureMessages)
            ? test.failureMessages.map(String)
            : [];
          failures.push({
            name: key,
            full: test.fullName,
            kind: kindOf(messages),
            message: (messages[0] ?? "").split("\n")[0].replace(ANSI, ""),
          });
        }
        if (
          (typeof file.message === "string" && file.message !== "") ||
          (file.status === "failed" && failedHere === 0)
        )
          fileErrors.push({
            file: name,
            message: String(
              file.message || "the file failed with no failed test",
            ),
          });
      }
      const count = (status) => tests.filter((t) => t.status === status).length;
      if (
        report.numTotalTests !== tests.length ||
        report.numPassedTests !== count("passed") ||
        report.numFailedTests !== count("failed")
      )
        problems.push(
          `the report's totals disagree with its tests (${report.numTotalTests} total, ${report.numPassedTests} passed, ${report.numFailedTests} failed; listed ${tests.length}, ${count("passed")}, ${count("failed")})`,
        );
      if (report.success && failures.length > 0)
        problems.push("the report says success with failed tests");
      if (!report.success && failures.length === 0 && fileErrors.length === 0)
        problems.push("the report says the run failed with no failed test");
      for (const file of files)
        if (!reported.has(file))
          problems.push(`the selected test file ${file} is not in the report`);
    }
  }
  for (const f of fileErrors)
    problems.push(
      `file-level (suite) error in ${f.file}: ${f.message.split("\n")[0]}`,
    );
  const failed = failures.length > 0 || fileErrors.length > 0;
  if (!spawnError && !signal && report !== undefined) {
    if (code === 0 && failed) problems.push("exit 0 with failures");
    if (code !== 0 && !failed && unhandled === 0)
      problems.push(`exit ${code} with no failed test`);
  }
  return {
    code: code ?? null,
    signal: signal ?? null,
    readable:
      report !== undefined &&
      !problems.some((p) => p.startsWith("the report is not")),
    problems,
    tests,
    failures,
    fileErrors,
    unhandled,
  };
}

/** A control's verdict, and the passing tests every mutant run of the same set must account for. */
export function classifyControl(run) {
  const problems = [...run.problems];
  const passed = run.tests.filter((t) => t.status === "passed").length;
  if (run.code !== 0) problems.push(`exit ${run.code ?? run.signal}`);
  if (run.failures.length > 0)
    problems.push(`${run.failures.length} failed test(s)`);
  if (passed === 0)
    problems.push("no test passed (an empty control proves nothing)");
  const inventory = {};
  for (const t of run.tests)
    if (t.status === "passed") inventory[t.key] = (inventory[t.key] ?? 0) + 1;
  return {
    passed: problems.length === 0,
    problems: [...new Set(problems)],
    inventory,
    total: run.tests.length,
    passing: passed,
    skipped: run.tests.length - passed - run.failures.length,
  };
}

/** Normalises a catalogue `expect` so `test` keeps no state between calls (a `g` or `y` flag would). */
export function expectation(pattern) {
  return pattern
    ? new RegExp(
        pattern.source,
        pattern.flags.replaceAll("g", "").replaceAll("y", ""),
      )
    : undefined;
}

/** The control tests a mutant run did not report as passed or failed: they did not run. */
export function missingFromInventory(run, inventory) {
  const seen = {};
  for (const t of run.tests)
    if (t.status === "passed" || t.status === "failed")
      seen[t.key] = (seen[t.key] ?? 0) + 1;
  return Object.entries(inventory)
    .filter(([key, n]) => (seen[key] ?? 0) < n)
    .map(([key]) => key);
}

/** Whether a listed attribution covers this failure: exact test, the kind `error`, and a message pattern on its first line. */
export function attributes(entry, failure) {
  return (
    entry.kind === "error" &&
    failure.kind === "error" &&
    entry.test === failure.name &&
    entry.message.test(failure.message)
  );
}

/**
 * A mutant's disposition. `ok` dispositions are `caught` and the retained legacy `crash_only_legacy` (a mutant from before revision 12,
 * with no `expect`, whose only failures are crashes: listed, never counted as a catch). Every other disposition fails the run:
 *
 *   survived     nothing failed
 *   wrong_test   assertions failed, but not the one written for the defect
 *   crash_only   only crashes (an `expect` mutant): no assertion at all
 *   invalid      the run is not usable evidence, or a failure other than an assertion (and not attributed) occurred
 */
export function classifyMutant(mutant, run, inventory, attributions = []) {
  const problems = [...run.problems];
  for (const key of missingFromInventory(run, inventory))
    problems.push(`a control test did not run: ${key}`);
  const assertions = run.failures.filter((f) => f.kind === "assertion");
  const expect = expectation(mutant.expect);
  const matching = assertions.filter((f) => !expect || expect.test(f.full));
  const others = run.failures.filter((f) => f.kind !== "assertion");
  const attributed = others.filter((f) =>
    attributions.some((entry) => attributes(entry, f)),
  );
  const unexpected = others.filter((f) => !attributed.includes(f));
  const kinds = {
    assertion: 0,
    timeout: 0,
    error: 0,
    suite: run.fileErrors.length,
  };
  for (const f of run.failures) kinds[f.kind] += 1;
  const anyFailure = run.failures.length > 0 || run.fileErrors.length > 0;
  let status;
  if (
    !mutant.expect &&
    run.readable &&
    !run.signal &&
    !run.problems.some(
      (p) => p.startsWith("the report") || p.startsWith("the test command"),
    ) &&
    run.code !== 0 &&
    anyFailure &&
    assertions.length === 0
  )
    status = "crash_only_legacy";
  else if (problems.length > 0 || unexpected.length > 0) status = "invalid";
  else if (!anyFailure) status = "survived";
  else if (matching.length > 0) status = "caught";
  else if (assertions.length > 0) status = "wrong_test";
  else status = "crash_only";
  return {
    status,
    ok: status === "caught" || status === "crash_only_legacy",
    caught: status === "caught",
    expected_assertion_observed: matching.length > 0,
    crashOnly: anyFailure && assertions.length === 0,
    kinds,
    problems: [...new Set(problems)],
    unexpected,
    attributed,
  };
}

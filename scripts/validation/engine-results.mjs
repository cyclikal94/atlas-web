// Parse Playwright's structured report, not terminal glyphs/colours. Missing, skipped,
// flaky/retried or interrupted cases cannot make a control/mutant pass.
//
// Every error of a case is judged on its own (WEB-08d revision 18, design assessment DA-N1). Playwright
// reports each error of a test (its body, its hooks and fixtures) as one entry of the result's `errors`,
// so a case can carry the intended `expect` failure AND an unrelated TypeError of its teardown. A case
// counts as an assertion only when it failed, reported at least one error, and EVERY error is an
// assertion; one other error makes it an `error` case, which no catch can contain. A timed-out case is
// a timeout whatever its errors say. `error` (the first error alone) is read only when a reporter gives
// no `errors` array, never as a second copy.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The kind of ONE Playwright error: an `expect` failure is an assertion, anything else an error. */
export function errorKind(error) {
  const text = `${error?.message ?? ""}\n${error?.stack ?? ""}`.replace(
    ANSI,
    "",
  );
  return /(?:Error:\s*expect\(|^\s*expect\()/m.test(text)
    ? "assertion"
    : "error";
}

export function inspectReport(report, browsers, exit) {
  const cases = [];
  function visit(suite, parents = []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results.at(-1);
        const reported = Array.isArray(last?.errors)
          ? last.errors
          : last?.error
            ? [last.error]
            : [];
        const errors = reported.map((e, ordinal) => ({
          ordinal,
          kind: errorKind(e),
          message: String(e?.message ?? "")
            .replace(ANSI, "")
            .split("\n")[0],
        }));
        const kind =
          last?.status === "timedOut"
            ? "timeout"
            : errors.length > 0 && errors.every((e) => e.kind === "assertion")
              ? "assertion"
              : "error";
        cases.push({
          engine: test.projectName,
          title: [...parents, suite.title, spec.title]
            .filter(Boolean)
            .join(" › "),
          status: last?.status,
          attempts: results.length,
          expectedStatus: test.expectedStatus,
          kind,
          errors,
        });
      }
    }
    for (const child of suite.suites ?? [])
      visit(child, [...parents, suite.title].filter(Boolean));
  }
  for (const suite of report.suites ?? []) visit(suite);
  const complete =
    browsers.every((b) => cases.some((c) => c.engine === `fixture-${b}`)) &&
    cases.every(
      (c) =>
        c.attempts === 1 &&
        c.expectedStatus === "passed" &&
        ["passed", "failed", "timedOut"].includes(c.status) &&
        // A passing case that reports errors is a damaged result, not a pass.
        (c.status !== "passed" || c.errors.length === 0),
    ) &&
    !report.errors?.length;
  return {
    code: exit,
    complete,
    cases,
    failures: cases.filter((c) => c.status !== "passed"),
    passed: cases.filter((c) => c.status === "passed").map((c) => c.engine),
    failed: cases.filter((c) => c.status !== "passed").map((c) => c.engine),
    controlOk:
      exit === 0 && complete && cases.every((c) => c.status === "passed"),
  };
}
export function classifyMutant(mutant, result, browsers) {
  const assertions = result.failures.filter(
    (f) => f.kind === "assertion" && f.status === "failed",
  );
  const matching = assertions.filter(
    (f) =>
      !mutant.expect ||
      new RegExp(
        mutant.expect.source,
        mutant.expect.flags.replaceAll("g", "").replaceAll("y", ""),
      ).test(f.title),
  );
  const engines = [...new Set(matching.map((f) => f.engine))];
  // Observation only: engines whose intended case reported the assertion, even beside another error.
  const observed = [
    ...new Set(
      result.failures
        .filter(
          (f) =>
            f.errors?.some((e) => e.kind === "assertion") &&
            (!mutant.expect ||
              new RegExp(
                mutant.expect.source,
                mutant.expect.flags.replaceAll("g", "").replaceAll("y", ""),
              ).test(f.title)),
        )
        .map((f) => f.engine),
    ),
  ];
  const caught =
    result.code !== 0 &&
    result.complete &&
    result.failures.every(
      (f) => f.kind === "assertion" && f.status === "failed",
    ) &&
    (mutant.expect
      ? browsers.every((b) => engines.includes(`fixture-${b}`))
      : engines.length > 0);
  return {
    caught,
    engines_with_expected_assertion: engines,
    engines_with_expected_assertion_observed: observed,
    crashOnly: result.failed.length > 0 && assertions.length === 0,
    kinds: Object.fromEntries(
      ["assertion", "timeout", "error"].map((kind) => [
        kind,
        result.failures.filter((f) => f.kind === kind).length,
      ]),
    ),
    // Every reported error of a failing case, by kind (cases above, errors here).
    error_kinds: Object.fromEntries(
      ["assertion", "error"].map((kind) => [
        kind,
        result.failures
          .flatMap((f) => f.errors ?? [])
          .filter((e) => e.kind === kind).length,
      ]),
    ),
  };
}

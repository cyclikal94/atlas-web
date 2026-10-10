// Parse Playwright's structured report, not terminal glyphs/colours. Missing, skipped,
// flaky/retried or interrupted cases cannot make a control/mutant pass.
export function inspectReport(report, browsers, exit) {
  const cases = [];
  function visit(suite, parents = []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results.at(-1);
        const errors = last?.errors ?? (last?.error ? [last.error] : []);
        const messages = errors
          .map((e) => `${e.message ?? ""}\n${e.stack ?? ""}`)
          .join("\n")
          .replace(
            new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
            "",
          );
        const kind =
          last?.status === "timedOut"
            ? "timeout"
            : /(?:Error:\s*expect\(|^\s*expect\()/m.test(messages)
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
        ["passed", "failed", "timedOut"].includes(c.status),
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
    crashOnly: result.failed.length > 0 && assertions.length === 0,
    kinds: Object.fromEntries(
      ["assertion", "timeout", "error"].map((kind) => [
        kind,
        result.failures.filter((f) => f.kind === kind).length,
      ]),
    ),
  };
}

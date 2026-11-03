// Strict accounting of a Playwright selection against a pinned list of case identities (scripts/smoke-image.sh, I4).
//
// A case's identity is its project, spec file and full title path (describe titles, then the test title); line numbers are
// not part of it, so an edit that moves a test does not change it. A pass needs the discovered inventory to be exactly the
// pinned list and the run to hold exactly one passing, expected, unretried result for each of those cases and nothing else.
// A count alone proves nothing: a missing, extra, duplicated, skipped, retried, flaky, interrupted or failed case, or an
// error the reporter recorded outside any test, is a problem. A legitimate change to the selection changes the pinned list
// in the same commit (explicit reconciliation), never this check.

const SEPARATOR = " › ";

/** Every test in a Playwright JSON report, with its identity and its results. */
export function casesOf(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.suites))
    throw new Error("not a Playwright JSON report (no suites)");
  const cases = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const path = [...titles, spec.title];
        cases.push({
          id: [test.projectName, spec.file, ...path].join(SEPARATOR),
          project: test.projectName,
          file: spec.file,
          line: spec.line,
          title: path,
          status: test.status,
          expectedStatus: test.expectedStatus,
          results: (test.results ?? []).map((result) => ({
            status: result.status,
            retry: result.retry,
          })),
        });
      }
    }
    for (const child of suite.suites ?? [])
      walk(child, child.title ? [...titles, child.title] : titles);
  };
  // The top-level suites are spec files: their title is the file, already part of the identity.
  for (const suite of report.suites) walk(suite, []);
  return cases;
}

function compareIds(label, expected, found, problems) {
  const counts = new Map();
  for (const id of found) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts)
    if (count > 1) problems.push(`${label}: ${id} appears ${count} times`);
  const pinned = new Set(expected);
  for (const id of expected)
    if (!counts.has(id)) problems.push(`${label}: ${id} is missing`);
  for (const id of counts.keys())
    if (!pinned.has(id))
      problems.push(`${label}: ${id} is not in the pinned list`);
}

function reportErrors(label, report, problems) {
  for (const error of report.errors ?? [])
    problems.push(
      `${label}: reporter error ${String(error?.message ?? JSON.stringify(error)).split("\n")[0]}`,
    );
}

/**
 * Judge an inventory (`--list`) and, when given, a run against the pinned identities. Returns every problem found, never
 * only the first, and a summary for the evidence.
 */
export function reconcile({ expected, inventory, results }) {
  const problems = [];
  if (!Array.isArray(expected) || expected.length === 0)
    throw new Error("the pinned case list is empty");
  if (new Set(expected).size !== expected.length)
    throw new Error("the pinned case list holds a duplicate");
  const listed = casesOf(inventory);
  reportErrors("inventory", inventory, problems);
  compareIds(
    "inventory",
    expected,
    listed.map((c) => c.id),
    problems,
  );
  const summary = {
    pinned: expected.length,
    discovered: listed.length,
  };
  if (results !== undefined) {
    const ran = casesOf(results);
    reportErrors("run", results, problems);
    compareIds(
      "run",
      expected,
      ran.map((c) => c.id),
      problems,
    );
    const outcome = {};
    for (const test of ran) {
      outcome[test.status] = (outcome[test.status] ?? 0) + 1;
      const statuses = test.results.map((r) => r.status);
      if (test.expectedStatus !== "passed")
        problems.push(
          `run: ${test.id} expects "${test.expectedStatus}", not a pass`,
        );
      if (test.status !== "expected")
        problems.push(
          `run: ${test.id} is "${test.status}" (${statuses.join(", ") || "no result"})`,
        );
      if (test.results.length !== 1)
        problems.push(
          `run: ${test.id} has ${test.results.length} results (retries or no run)`,
        );
      for (const result of test.results) {
        if (result.status !== "passed")
          problems.push(
            `run: ${test.id} result ${result.retry} is "${result.status}"`,
          );
        if (result.retry !== 0)
          problems.push(`run: ${test.id} was retried (retry ${result.retry})`);
      }
    }
    const stats = results.stats ?? {};
    for (const key of ["unexpected", "flaky", "skipped"])
      if (stats[key] !== 0)
        problems.push(
          `run: the reporter counts ${key} = ${JSON.stringify(stats[key])}`,
        );
    if (stats.expected !== expected.length)
      problems.push(
        `run: the reporter counts expected = ${JSON.stringify(stats.expected)}, not ${expected.length}`,
      );
    Object.assign(summary, { ran: ran.length, outcome, stats });
  }
  return { passed: problems.length === 0, problems, summary };
}

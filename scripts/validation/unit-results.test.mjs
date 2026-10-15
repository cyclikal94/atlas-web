import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTRIBUTED,
  checkAttributions,
} from "../mutation/attributed-errors.mjs";
import { UNIT } from "../mutation/data-catalogue.mjs";
import {
  attributes,
  classifyControl,
  classifyMutant,
  expectation,
  inspectRun,
  kindOf,
  unhandledErrors,
} from "./unit-results.mjs";

// WEB-08d revision 17 (review r16 H6): the unit mutation runner's verdict on one Vitest run, over reports in the shape Vitest 5's JSON
// reporter writes (numTotalTests/numPassedTests/numFailedTests/success/testResults[].assertionResults[]).
const root = "/repo";
const FILE = "tests/a.test.ts";
const OTHER = "tests/b.test.ts";
const ASSERT =
  "AssertionError: expected 1 to be 2 // Object.is equality\n    at /repo/tests/a.test.ts:3:4";
const TYPE =
  "TypeError: deliberately simulated unrelated setup defect\n    at /repo/tests/a.test.ts:9:1";
const TIMEOUT = "Error: Test timed out in 5000ms.";

/** A Vitest JSON report: `tests` are [file, fullName, status, message?]. */
function vitest(tests, extra = {}) {
  const files = [...new Set(tests.map(([f]) => f))];
  const all = tests.map(([file, fullName, status, message]) => ({
    file,
    fullName,
    status,
    failureMessages: message ? [message] : [],
  }));
  const failed = all.filter((t) => t.status === "failed").length;
  return {
    numTotalTests: all.length,
    numPassedTests: all.filter((t) => t.status === "passed").length,
    numFailedTests: failed,
    success: failed === 0,
    testResults: files.map((f) => ({
      name: `${root}/${f}`,
      status: all.some((t) => t.file === f && t.status === "failed")
        ? "failed"
        : "passed",
      message: "",
      assertionResults: all
        .filter((t) => t.file === f)
        .map(({ file: _f, ...t }) => t),
    })),
    ...extra,
  };
}
const CONTROL = [
  [FILE, "the intended test", "passed"],
  [FILE, "a neighbour", "passed"],
  [OTHER, "another file's test", "passed"],
];
const run = (report, over = {}) =>
  inspectRun({
    text: typeof report === "string" ? report : JSON.stringify(report),
    files: [FILE, OTHER],
    root,
    code: report?.success === false ? 1 : 0,
    output: "",
    ...over,
  });
const inventory = classifyControl(run(vitest(CONTROL))).inventory;
const mutant = { id: "MU-X", expect: /the intended test/ };
const mutantRun = (statuses, over) =>
  run(
    vitest(
      CONTROL.map(([f, n]) =>
        statuses[n] ? [f, n, "failed", statuses[n]] : [f, n, "passed"],
      ),
    ),
    over,
  );

test("Q1 a clean, complete, non-empty control passes and its passing tests are the inventory", () => {
  const verdict = classifyControl(run(vitest(CONTROL)));
  assert.equal(verdict.passed, true, verdict.problems.join("; "));
  assert.deepEqual(verdict.inventory, {
    "tests/a.test.ts > the intended test": 1,
    "tests/a.test.ts > a neighbour": 1,
    "tests/b.test.ts > another file's test": 1,
  });
});

test("Q1 a control fails on anything short of a clean complete run (including exit 0 with no or a damaged report)", () => {
  const cases = {
    "a failed test": run(
      vitest([
        ...CONTROL.slice(1),
        [FILE, "the intended test", "failed", ASSERT],
      ]),
    ),
    "a missing report (exit 0)": inspectRun({
      readError: "ENOENT",
      files: [FILE, OTHER],
      root,
      code: 0,
      output: "",
    }),
    "an unparsable report": run("{"),
    "not a Vitest report": run({ testResults: [] }),
    "an empty run": run(vitest([]), { files: [] }),
    "a selected file missing": run(vitest(CONTROL.slice(0, 2))),
    "totals that disagree": run(vitest(CONTROL, { numTotalTests: 4 })),
    "an unhandled error": run(vitest(CONTROL), {
      output:
        "\u001b[31mVitest caught 1 unhandled error during the test run.\u001b[39m",
    }),
    "a signal": run(vitest(CONTROL), { code: null, signal: "SIGKILL" }),
    "a command that did not start": inspectRun({
      readError: "ENOENT",
      files: [FILE],
      root,
      code: null,
      spawnError: "spawn pnpm ENOENT",
      output: "",
    }),
    "a non-zero exit with no failed test": run(vitest(CONTROL), { code: 1 }),
    "a file-level (suite) error": run(
      {
        ...vitest(CONTROL),
        success: false,
        testResults: vitest(CONTROL).testResults.map((f, i) =>
          i === 0
            ? { ...f, status: "failed", message: "afterAll hook failed" }
            : f,
        ),
      },
      { code: 1 },
    ),
    "a skipped control test only": run(
      vitest([
        [FILE, "x", "skipped"],
        [OTHER, "y", "skipped"],
      ]),
    ),
  };
  for (const [name, r] of Object.entries(cases))
    assert.equal(
      classifyControl(r).passed,
      false,
      `${name} must fail the control`,
    );
});

test("Q1 an expected assertion alone, in a complete sound run, is a catch", () => {
  const v = classifyMutant(
    mutant,
    mutantRun({ "the intended test": ASSERT }, { code: 1 }),
    inventory,
  );
  assert.equal(v.status, "caught");
  assert.equal(v.ok, true);
  assert.equal(v.expected_assertion_observed, true);
  assert.deepEqual(v.unexpected, []);
  // Other assertion failures beside it are part of the mutation's effect, not a defect of the run.
  const two = classifyMutant(
    mutant,
    mutantRun(
      { "the intended test": ASSERT, "a neighbour": ASSERT },
      { code: 1 },
    ),
    inventory,
  );
  assert.equal(two.status, "caught");
});

test("H6: an expected assertion beside any other kind of failure is INVALID, and both facts are kept", () => {
  const mixed = {
    "an unrelated error in another test": [
      mutantRun(
        { "the intended test": ASSERT, "a neighbour": TYPE },
        { code: 1 },
      ),
      "error",
    ],
    "a timeout in another test": [
      mutantRun(
        { "the intended test": ASSERT, "a neighbour": TIMEOUT },
        { code: 1 },
      ),
      "timeout",
    ],
    "an unhandled error": [
      mutantRun(
        { "the intended test": ASSERT },
        {
          code: 1,
          output: "Vitest caught 2 unhandled errors during the test run.",
        },
      ),
      null,
    ],
    "a signal": [
      mutantRun(
        { "the intended test": ASSERT },
        { code: null, signal: "SIGTERM" },
      ),
      null,
    ],
    "inconsistent totals": [
      run(
        {
          ...vitest(
            CONTROL.map(([f, n]) => [
              f,
              n,
              n === "the intended test" ? "failed" : "passed",
              ASSERT,
            ]),
          ),
          numFailedTests: 0,
        },
        { code: 1 },
      ),
      null,
    ],
    "a control test that did not run": [
      run(
        vitest([
          [FILE, "the intended test", "failed", ASSERT],
          [FILE, "a neighbour", "skipped"],
          [OTHER, "another file's test", "passed"],
        ]),
        { code: 1 },
      ),
      null,
    ],
  };
  for (const [name, [r, kind]] of Object.entries(mixed)) {
    const v = classifyMutant(mutant, r, inventory);
    assert.equal(v.status, "invalid", name);
    assert.equal(v.ok, false, name);
    assert.equal(v.caught, false, name);
    assert.equal(
      v.expected_assertion_observed,
      true,
      `${name}: the assertion is still observed`,
    );
    if (kind)
      assert.deepEqual(
        v.unexpected.map((f) => f.kind),
        [kind],
        name,
      );
    else assert.ok(v.problems.length > 0, name);
  }
});

test("Q1 survivors, wrong tests and crash-only runs of an expect mutant all fail the run", () => {
  assert.equal(
    classifyMutant(mutant, mutantRun({}), inventory).status,
    "survived",
  );
  assert.equal(
    classifyMutant(
      mutant,
      mutantRun({ "a neighbour": ASSERT }, { code: 1 }),
      inventory,
    ).status,
    "wrong_test",
  );
  const crash = classifyMutant(
    mutant,
    mutantRun({ "the intended test": TYPE }, { code: 1 }),
    inventory,
  );
  assert.equal(crash.status, "invalid");
  assert.equal(crash.expected_assertion_observed, false);
  assert.equal(classifyMutant(mutant, mutantRun({}), inventory).ok, false);
  assert.equal(
    classifyMutant(
      mutant,
      mutantRun({ "a neighbour": ASSERT }, { code: 1 }),
      inventory,
    ).ok,
    false,
  );
});

test("Q2 legacy (no expect): any assertion catches; crashes alone stay `crash_only_legacy`; a mix with a crash is INVALID", () => {
  const legacy = { id: "MU-L" };
  assert.equal(
    classifyMutant(
      legacy,
      mutantRun({ "a neighbour": ASSERT }, { code: 1 }),
      inventory,
    ).status,
    "caught",
  );
  const crash = classifyMutant(
    legacy,
    mutantRun({ "a neighbour": TYPE }, { code: 1 }),
    inventory,
  );
  assert.equal(crash.status, "crash_only_legacy");
  assert.equal(crash.ok, true);
  assert.equal(
    crash.caught,
    false,
    "a legacy crash is never counted as a catch",
  );
  const mixed = classifyMutant(
    legacy,
    mutantRun(
      { "the intended test": ASSERT, "a neighbour": TYPE },
      { code: 1 },
    ),
    inventory,
  );
  assert.equal(
    mixed.status,
    "invalid",
    "the legacy label never absorbs an assertion beside a crash",
  );
  // An unreadable report is not a legacy crash.
  const lost = classifyMutant(
    legacy,
    inspectRun({
      readError: "ENOENT",
      files: [FILE, OTHER],
      root,
      code: 1,
      output: "",
    }),
    inventory,
  );
  assert.equal(lost.status, "invalid");
});

test("H6: a listed attribution covers only its exact test, kind `error` and message; anything else stays unexpected", () => {
  const entry = {
    test: "tests/a.test.ts > a neighbour",
    kind: "error",
    message: /^TypeError: deliberately simulated/,
  };
  const r = mutantRun(
    { "the intended test": ASSERT, "a neighbour": TYPE },
    { code: 1 },
  );
  const v = classifyMutant(mutant, r, inventory, [entry]);
  assert.equal(v.status, "caught");
  assert.equal(v.caught, true);
  assert.deepEqual(
    v.attributed.map((f) => f.name),
    ["tests/a.test.ts > a neighbour"],
  );
  assert.deepEqual(v.unexpected, []);
  // Another test, another message, a timeout, or the attribution alone without the expected assertion.
  assert.equal(
    classifyMutant(mutant, r, inventory, [
      { ...entry, test: "tests/a.test.ts > the intended test" },
    ]).status,
    "invalid",
  );
  assert.equal(
    classifyMutant(mutant, r, inventory, [{ ...entry, message: /^RangeError/ }])
      .status,
    "invalid",
  );
  const timeout = mutantRun(
    { "the intended test": ASSERT, "a neighbour": TIMEOUT },
    { code: 1 },
  );
  assert.equal(
    classifyMutant(mutant, timeout, inventory, [
      { ...entry, kind: "timeout", message: /timed out/ },
    ]).status,
    "invalid",
  );
  const onlyAttributed = classifyMutant(
    mutant,
    mutantRun({ "a neighbour": TYPE }, { code: 1 }),
    inventory,
    [entry],
  );
  assert.equal(onlyAttributed.status, "crash_only");
  assert.equal(onlyAttributed.ok, false);
  assert.equal(
    attributes(entry, {
      name: entry.test,
      kind: "error",
      message: "TypeError: deliberately simulated x",
    }),
    true,
  );
  assert.equal(
    attributes(entry, {
      name: entry.test,
      kind: "assertion",
      message: "TypeError: deliberately simulated x",
    }),
    false,
  );
});

test("the recognition rules are the runner's since WEB-09a; a stateful expect pattern is normalised", () => {
  assert.equal(kindOf([ASSERT]), "assertion");
  assert.equal(
    kindOf(["Error: rejected\n    at __VITEST_REJECTS__ (x)"]),
    "assertion",
  );
  assert.equal(kindOf([TIMEOUT]), "timeout");
  assert.equal(kindOf([TYPE]), "error");
  assert.equal(
    kindOf(["TestingLibraryElementError: Unable to find an element"]),
    "error",
  );
  const g = expectation(/intended/g);
  assert.equal(g.test("the intended test"), true);
  assert.equal(
    g.test("the intended test"),
    true,
    "a `g` pattern would fail on the second call",
  );
  assert.equal(
    unhandledErrors("There were unhandled errors during test collection"),
    1,
  );
  assert.equal(unhandledErrors("all fine"), 0);
});

test("the attribution table is narrow and names catalogue mutants only", () => {
  assert.doesNotThrow(() => checkAttributions(ATTRIBUTED, UNIT));
  const ok = {
    why: "the mutated decoder returns undefined, which this test parses",
    established: "focused run",
    failures: [
      { test: "tests/a.test.ts > x", kind: "error", message: /^TypeError/ },
    ],
  };
  assert.doesNotThrow(() => checkAttributions({ "MU-01": ok }, UNIT));
  assert.throws(
    () => checkAttributions({ "MU-NOPE": ok }, UNIT),
    /not in the unit catalogue/,
  );
  assert.throws(
    () =>
      checkAttributions(
        {
          "MU-01": {
            ...ok,
            failures: [{ ...ok.failures[0], kind: "timeout" }],
          },
        },
        UNIT,
      ),
    /only kind "error"/,
  );
  assert.throws(
    () =>
      checkAttributions(
        {
          "MU-01": { ...ok, failures: [{ ...ok.failures[0], message: /x/g }] },
        },
        UNIT,
      ),
    /without g or y/,
  );
  assert.throws(
    () => checkAttributions({ "MU-01": { ...ok, why: "" } }, UNIT),
    /why/,
  );
  assert.throws(
    () => checkAttributions({ "MU-01": { ...ok, established: "" } }, UNIT),
    /established/,
  );
  assert.throws(
    () => checkAttributions({ "MU-01": { ...ok, failures: [] } }, UNIT),
    /no failures/,
  );
});

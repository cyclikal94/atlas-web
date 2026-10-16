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
  failedTests,
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

/** A Vitest JSON report: `tests` are [file, fullName, status, message?]; an array message is the test's whole `failureMessages`. */
function vitest(tests, extra = {}) {
  const files = [...new Set(tests.map(([f]) => f))];
  const all = tests.map(([file, fullName, status, message]) => ({
    file,
    fullName,
    status,
    failureMessages:
      message === undefined ? [] : Array.isArray(message) ? message : [message],
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
  assert.equal(kindOf(ASSERT), "assertion");
  assert.equal(
    kindOf("Error: rejected\n    at __VITEST_REJECTS__ (x)"),
    "assertion",
  );
  assert.equal(kindOf(TIMEOUT), "timeout");
  assert.equal(kindOf(TYPE), "error");
  assert.equal(
    kindOf("TestingLibraryElementError: Unable to find an element"),
    "error",
  );
  // Revision 18 (H6a): one message at a time; a joined list would let one message's kind stand for another's.
  assert.throws(() => kindOf([ASSERT, TYPE]), TypeError);
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

// ---- WEB-08d revision 18 (review r17 H6a; design assessment C1-C3, Q2-Q5): every message of a failed test is judged on its own --------
const TEARDOWN =
  "TypeError: independent teardown failure\n    at /repo/tests/a.test.ts:20:9";
const HOOK_TIMEOUT = "Error: Hook timed out in 10000ms.";
const ASSERT2 =
  "AssertionError: expected [] to have a length of 1 but got +0\n    at /repo/tests/a.test.ts:5:6";

test("H6a Q2: an intended assertion beside an error or timeout of the SAME test is invalid in either order, and both are kept", () => {
  const cells = {
    "assertion, then teardown error": [[ASSERT, TEARDOWN], ["error"]],
    "teardown error, then assertion": [[TEARDOWN, ASSERT], ["error"]],
    "assertion, then hook timeout": [[ASSERT, HOOK_TIMEOUT], ["timeout"]],
    "hook timeout, then assertion": [[HOOK_TIMEOUT, ASSERT], ["timeout"]],
    "assertion, error and timeout": [
      [ASSERT, TEARDOWN, HOOK_TIMEOUT],
      ["error", "timeout"],
    ],
    "the same error twice is two errors": [
      [ASSERT, TEARDOWN, TEARDOWN],
      ["error", "error"],
    ],
  };
  for (const [name, [messages, unexpectedKinds]] of Object.entries(cells)) {
    const r = mutantRun({ "the intended test": messages }, { code: 1 });
    assert.equal(
      r.errors.length,
      messages.length,
      `${name}: every message is kept`,
    );
    assert.deepEqual(
      r.errors.map((e) => e.ordinal),
      messages.map((_, i) => i),
      name,
    );
    assert.deepEqual(
      r.errors.map((e) => e.text),
      messages,
      `${name}: the whole text of each message is kept`,
    );
    const v = classifyMutant(mutant, r, inventory);
    assert.equal(v.status, "invalid", name);
    assert.equal(v.ok, false, name);
    assert.equal(v.caught, false, name);
    assert.equal(v.expected_assertion_observed, true, name);
    assert.deepEqual(
      v.unexpected.map((f) => f.kind),
      unexpectedKinds,
      name,
    );
    assert.equal(v.failed_tests, 1, `${name}: one failed test`);
    assert.equal(
      v.kinds.assertion + v.kinds.error + v.kinds.timeout,
      messages.length,
      `${name}: kinds count messages`,
    );
  }
});

test("H6a Q2: two assertions of one test stay a sound catch; a second test's assertion beside them too", () => {
  for (const messages of [
    [ASSERT, ASSERT2],
    [ASSERT2, ASSERT],
  ]) {
    const v = classifyMutant(
      mutant,
      mutantRun(
        { "the intended test": messages, "a neighbour": ASSERT },
        { code: 1 },
      ),
      inventory,
    );
    assert.equal(v.status, "caught");
    assert.equal(v.kinds.assertion, 3);
    assert.equal(v.failed_tests, 2);
    assert.deepEqual(v.unexpected, []);
  }
});

test("H6a Q3: an attribution covers only the message it names; a second error of that test, in either order, stays unexpected", () => {
  const ATTRIBUTED_ERROR = "TypeError: expected consequence of this mutation";
  const entry = {
    test: "tests/a.test.ts > a neighbour",
    kind: "error",
    message: /^TypeError: expected consequence of this mutation$/,
  };
  // The positive control: the attributed message alone is attributed and the run is a catch.
  const alone = classifyMutant(
    mutant,
    mutantRun(
      { "the intended test": ASSERT, "a neighbour": ATTRIBUTED_ERROR },
      { code: 1 },
    ),
    inventory,
    [entry],
  );
  assert.equal(alone.status, "caught");
  assert.equal(alone.attributed.length, 1);
  for (const messages of [
    [ATTRIBUTED_ERROR, TEARDOWN],
    [TEARDOWN, ATTRIBUTED_ERROR],
    [ATTRIBUTED_ERROR, HOOK_TIMEOUT],
  ]) {
    const v = classifyMutant(
      mutant,
      mutantRun(
        { "the intended test": ASSERT, "a neighbour": messages },
        { code: 1 },
      ),
      inventory,
      [entry],
    );
    assert.equal(v.status, "invalid", messages.join(" | "));
    assert.equal(v.expected_assertion_observed, true);
    assert.deepEqual(
      v.attributed.map((f) => f.message),
      [ATTRIBUTED_ERROR],
      "the attributed message stays visible",
    );
    assert.equal(v.unexpected.length, 1, "the other message is never covered");
    assert.notEqual(v.unexpected[0].message, ATTRIBUTED_ERROR);
  }
  // The expected assertion, the attributed error and an unrelated error all in the intended test.
  const own = { ...entry, test: "tests/a.test.ts > the intended test" };
  const v = classifyMutant(
    mutant,
    mutantRun(
      { "the intended test": [ASSERT, ATTRIBUTED_ERROR, TEARDOWN] },
      { code: 1 },
    ),
    inventory,
    [own],
  );
  assert.equal(v.status, "invalid");
  assert.equal(v.attributed.length, 1);
  assert.equal(v.unexpected.length, 1);
  // ... and without the unrelated error, the same attribution is accepted beside the assertion of its own test.
  assert.equal(
    classifyMutant(
      mutant,
      mutantRun(
        { "the intended test": [ASSERT, ATTRIBUTED_ERROR] },
        { code: 1 },
      ),
      inventory,
      [own],
    ).status,
    "caught",
  );
  // An attribution alone is no catch, even with several attributed messages.
  assert.equal(
    classifyMutant(
      mutant,
      mutantRun(
        { "a neighbour": [ATTRIBUTED_ERROR, ATTRIBUTED_ERROR] },
        { code: 1 },
      ),
      inventory,
      [entry],
    ).status,
    "crash_only",
  );
});

test("H6a Q4: tests and messages are counted apart; duplicates are occurrences; unusable messages are unusable evidence", () => {
  // One failed test with three messages among passing and skipped tests: counts come from the tests.
  const r = run(
    vitest([
      [FILE, "the intended test", "failed", [ASSERT, TEARDOWN, HOOK_TIMEOUT]],
      [FILE, "a neighbour", "passed"],
      [OTHER, "another file's test", "skipped"],
      [OTHER, "a second skipped test", "skipped"],
    ]),
    { code: 1 },
  );
  assert.deepEqual(r.problems, []);
  assert.equal(r.errors.length, 3);
  assert.deepEqual(
    failedTests(r).map((t) => [t.name, t.errors.length]),
    [["tests/a.test.ts > the intended test", 3]],
  );
  const control = classifyControl(r);
  assert.equal(control.passed, false);
  assert.equal(control.failed, 1);
  assert.equal(
    control.skipped,
    2,
    "skipped never derives from the message count",
  );
  assert.equal(control.passing, 1);
  assert.equal(control.total, 4);
  // Two tests with the same full name are two occurrences in the inventory and both must run again.
  const dup = classifyControl(
    run(
      vitest([
        [FILE, "the intended test", "passed"],
        [FILE, "the intended test", "passed"],
        [OTHER, "another file's test", "passed"],
      ]),
    ),
  );
  assert.equal(dup.passed, true, dup.problems.join("; "));
  assert.equal(dup.inventory["tests/a.test.ts > the intended test"], 2);
  const once = classifyMutant(
    mutant,
    run(
      vitest([
        [FILE, "the intended test", "failed", ASSERT],
        [OTHER, "another file's test", "passed"],
      ]),
      { code: 1 },
    ),
    dup.inventory,
  );
  assert.equal(
    once.status,
    "invalid",
    "one occurrence of a duplicated test did not run",
  );
  const both = classifyMutant(
    mutant,
    run(
      vitest([
        [FILE, "the intended test", "failed", [ASSERT, ASSERT2]],
        [FILE, "the intended test", "failed", ASSERT],
        [OTHER, "another file's test", "passed"],
      ]),
      { code: 1 },
    ),
    dup.inventory,
  );
  assert.equal(both.status, "caught");
  assert.equal(both.failed_tests, 2);
  assert.equal(both.kinds.assertion, 3);
  // A failed test with missing, empty or unusable messages, or a passing test with messages, is a damaged report.
  const damaged = {
    "no failureMessages": (t) => {
      delete t.failureMessages;
    },
    "an empty failureMessages": (t) => {
      t.failureMessages = [];
    },
    "a non-array failureMessages": (t) => {
      t.failureMessages = ASSERT;
    },
    "a null message beside the assertion": (t) => {
      t.failureMessages = [ASSERT, null];
    },
    "an empty message beside the assertion": (t) => {
      t.failureMessages = [ASSERT, ""];
    },
  };
  for (const [name, damage] of Object.entries(damaged)) {
    const report = vitest(
      CONTROL.map(([f, n]) =>
        n === "the intended test" ? [f, n, "failed", ASSERT] : [f, n, "passed"],
      ),
    );
    damage(
      report.testResults[0].assertionResults.find(
        (t) => t.fullName === "the intended test",
      ),
    );
    const seen = run(report, { code: 1 });
    assert.ok(
      seen.problems.some((p) => p.startsWith("the report gives")),
      `${name}: named as unusable evidence`,
    );
    assert.equal(
      classifyMutant(mutant, seen, inventory).status,
      "invalid",
      name,
    );
    assert.equal(
      classifyMutant({ id: "MU-L" }, seen, inventory).status,
      "invalid",
      `${name}: never a legacy crash either`,
    );
  }
  const passedWithMessages = vitest(CONTROL);
  passedWithMessages.testResults[0].assertionResults[1].failureMessages = [
    TEARDOWN,
  ];
  const pm = run(passedWithMessages);
  assert.ok(
    pm.problems.some((p) => p.startsWith("the report gives a passed test")),
  );
  assert.equal(classifyControl(pm).passed, false);
});

test("H6a Q5: legacy (no expect) keeps its rules per message: crashes alone stay `crash_only_legacy`; an assertion with a crash in one test is INVALID", () => {
  const legacy = { id: "MU-L" };
  const crashes = classifyMutant(
    legacy,
    mutantRun({ "a neighbour": [TYPE, TEARDOWN] }, { code: 1 }),
    inventory,
  );
  assert.equal(crashes.status, "crash_only_legacy");
  assert.equal(crashes.caught, false);
  for (const messages of [
    [ASSERT, TYPE],
    [TYPE, ASSERT],
  ]) {
    const mixed = classifyMutant(
      legacy,
      mutantRun({ "a neighbour": messages }, { code: 1 }),
      inventory,
    );
    assert.equal(mixed.status, "invalid", messages.join(" | "));
    assert.equal(mixed.ok, false);
  }
  assert.equal(
    classifyMutant(
      legacy,
      mutantRun({ "a neighbour": [ASSERT, ASSERT2] }, { code: 1 }),
      inventory,
    ).status,
    "caught",
  );
});

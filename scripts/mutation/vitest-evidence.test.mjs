// Pure controls of the supervised-evidence contract (vitest-evidence.mjs) and the unit runner's verdict rule (WEB-14a revision 27,
// review r26 R31 / design assessment DA-H2, Q3/Q4/Q6; revision 28, review r27 R31: assertion origin, C1-C3; revision 29, review r28
// R31: per-occurrence site receipts bound to the test and adapter, schema 3). The real Vitest boundary is qualified separately with
// actual runs.
//   node --test scripts/mutation/vitest-evidence.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { failsRun, unauthorisedSelections } from "./unit-runner.mjs";
import {
  admission,
  classify,
  controlVerdict,
  currentAdapter,
  ENVELOPE_SCHEMA,
  namePatternOf,
  ORIGIN_KEY,
  ORIGIN_SCHEMA,
  project,
  readRun,
  selectionProblems,
  unitVerdict,
  validateEnvelope,
} from "./vitest-evidence.mjs";

// A serialised error as Vitest hands it over, with the receipt an audited site attaches in the worker (vitest-origin-runtime.mjs).
// `test`/`current` "@case" stand for the id of the case the error is placed in (caseOf binds them).
const ADAPTER = currentAdapter();
const receiptOf = (site, role, over = {}) => ({
  schema: ORIGIN_SCHEMA,
  nonce: "n",
  adapter: ADAPTER,
  site,
  role,
  root: 1,
  test: "@case",
  current: "@case",
  ...over,
});
const chaiError = (receipt, message = "expected 1 to be 2") =>
  project({
    name: "AssertionError",
    message,
    stack: `AssertionError: ${message}`,
    [ORIGIN_KEY]: receipt,
  });
const assertion = chaiError(receiptOf("chai.Assertion#assert", "comparison"));
const extended = project({
  name: "Error",
  message: "expect(element).toBeVisible()",
  stack:
    "Error: expect(element).toBeVisible()\n at Proxy.__VITEST_EXTEND_ASSERTION__ (x)",
  constructor: "Function<JestExtendError>",
  __vitest_error_context__: { assertionName: "toBeVisible" },
  [ORIGIN_KEY]: receiptOf("vitest.extend.result", "comparison"),
});
const invertedError = (over = {}) =>
  project(
    Object.assign(new Error("Expect test to fail"), {
      [ORIGIN_KEY]: receiptOf("vitest.runner.fails-inversion", "inversion", {
        root: null,
        current: null,
        ...over,
      }),
    }),
  );
const plain = project(new Error("boom"));
const errors = (list) => ({ errorCount: list.length, errors: list });
const bind = (error, id) =>
  error?.origin && typeof error.origin === "object" && !error.origin.invalid
    ? {
        ...error,
        origin: {
          ...error.origin,
          test: error.origin.test === "@case" ? id : error.origin.test,
          current: error.origin.current === "@case" ? id : error.origin.current,
        },
      }
    : error;
const caseOf = (name, state, list = [], extra = {}) => ({
  id: `t-${name}`,
  module: "tests/a.test.ts",
  moduleId: "/r/tests/a.test.ts",
  ancestors: ["S"],
  name,
  state,
  fails: false,
  ms: 1,
  ...errors(list.map((e) => bind(e, extra.id ?? `t-${name}`))),
  ...extra,
});
function envelope(over = {}, witness = {}) {
  return {
    schema: ENVELOPE_SCHEMA,
    nonce: "n",
    label: "L",
    vitest: "5.0.1",
    supported: true,
    unsupported: [],
    witness: {
      onTestRunEndCalls: 1,
      reason: "failed",
      modules: [{ id: "tests/a.test.ts", state: "failed", ...errors([]) }],
      suites: [{ module: "tests/a.test.ts", fullName: "S", ...errors([]) }],
      tests: [
        caseOf("oracle", "failed", [assertion]),
        caseOf("other", "passed"),
      ],
      unhandledCount: 0,
      unhandled: [],
      failureCount: 0,
      failures: [],
      ...witness,
    },
    lateUnhandledCount: 0,
    lateUnhandled: [],
    logged: { count: 0, calls: [] },
    processEvents: { count: 0, events: [] },
    startError: null,
    closeError: null,
    closeTimedOut: false,
    origin: {
      schema: ORIGIN_SCHEMA,
      adapter: ADAPTER,
      projects: [{ name: "", setupFiles: ["/r/setup.mjs"], pool: "forks" }],
      installed: true,
    },
    exitCode: 1,
    complete: true,
    ...over,
  };
}
const jsonOf = (env) => ({
  testResults: [
    {
      name: "/r/tests/a.test.ts",
      assertionResults: env.witness.tests.map((t) => ({
        ancestorTitles: t.ancestors,
        title: t.name,
        status: t.state,
        failureMessages: t.errors.map(() => "x"),
      })),
    },
  ],
});

function withRun(
  env,
  {
    json = env?.witness ? jsonOf(env) : undefined,
    child = { code: env?.exitCode ?? 1, signal: null, spawnError: null },
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "vitest-evidence-"));
  try {
    const envelopePath = join(dir, "envelope.json");
    const reportPath = join(dir, "report.json");
    if (env !== undefined)
      writeFileSync(
        envelopePath,
        typeof env === "string" ? env : JSON.stringify(env),
      );
    if (json !== undefined && json !== null)
      writeFileSync(
        reportPath,
        typeof json === "string" ? json : JSON.stringify(json),
      );
    return readRun({
      child,
      envelopePath,
      reportPath,
      startedMs: Date.now() - 60_000,
      nonce: "n",
      label: "L",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("project keeps one occurrence for every thrown value, whatever it is", () => {
  for (const value of [
    null,
    undefined,
    false,
    0,
    "",
    Symbol("s"),
    {},
    new Error(),
  ])
    assert.equal(typeof project(value), "object");
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("getter");
      },
    },
  );
  assert.deepEqual(project(hostile), { kind: "unserialisable" });
  assert.equal(project(Symbol("s")).text, "Symbol(s)");
});

test("admission (revision 29): an assertion only by the receipt of a completed comparison of THIS test, never by class, name, frames or text", () => {
  const ok = { nonce: "n", adapter: ADAPTER, testId: "t-oracle" };
  const bound = (e) => bind(e, "t-oracle");
  assert.equal(classify(bound(assertion), ok), "assertion");
  assert.equal(classify(bound(extended), ok), "assertion");
  assert.equal(classify(plain, ok), "error");
  // Every audited comparison site of the installed framework is admissible when its receipt binds; an explicit fail by its current test.
  for (const site of [
    "chai.callable",
    "vitest.toMatchObject",
    "vitest.toHaveBeenCalled",
    "vitest.toHaveBeenCalledWith",
    "vitest.toThrow.did-not-throw",
    "vitest.resolves.rejected",
    "vitest.rejects.resolved",
  ])
    assert.equal(
      classify(bound(chaiError(receiptOf(site, "comparison"))), ok),
      "assertion",
      site,
    );
  assert.equal(
    classify(
      bound(
        chaiError(
          receiptOf("chai.expect.fail", "explicit", { root: null, test: null }),
        ),
      ),
      ok,
    ),
    "assertion",
  );
  // What revision 27 admitted by name or wrapper frame, and what revision 28 admitted by CLASS, is refused without a site receipt.
  assert.equal(
    classify(
      project(
        Object.assign(new Error("expected 1 to be 2"), {
          name: "AssertionError",
        }),
      ),
      ok,
    ),
    "error",
  );
  for (const frame of [
    "__VITEST_REJECTS__",
    "__VITEST_RESOLVES__",
    "Proxy.__VITEST_EXTEND_ASSERTION__",
    "_Assertion.toBe",
  ])
    assert.equal(
      classify(
        project({
          name: "Error",
          message: "matcher crashed before comparing",
          stack: `Error: matcher crashed before comparing\n at ${frame} (x)`,
        }),
        ok,
      ),
      "error",
      frame,
    );
  // Review r28's framework-made AssertionErrors: argument validation, a wrapped predicate TypeError, internal and nested assertions.
  const refused = [
    [
      chaiError(
        receiptOf("chai.instanceOf.predicate-type-error", "execution"),
        "The instanceof assertion needs a constructor but null was given.",
      ),
      /execution site/,
    ],
    [
      chaiError(
        receiptOf("chai.property.name", "precondition"),
        "the argument to property must be a string, number, or symbol",
      ),
      /precondition site/,
    ],
    [
      chaiError(
        receiptOf("chai.property.target", "precondition"),
        "Target cannot be null or undefined.",
      ),
      /precondition site/,
    ],
    [
      chaiError(receiptOf("chai.include.invalid-combination", "precondition")),
      /precondition site/,
    ],
    [
      chaiError(receiptOf("chai.Assertion#assert", "internal", { root: null })),
      /internal \(precondition\) assertion/,
    ],
    [
      chaiError(receiptOf("chai.Assertion#assert", "nested")),
      /nested in another matcher/,
    ],
    [
      chaiError(receiptOf("chai.should.fail", "unsupported", { root: null })),
      /unsupported site/,
    ],
  ];
  for (const [error, pattern] of refused) {
    const a = admission(bound(error), ok);
    assert.equal(a.kind, "error", JSON.stringify(error.origin));
    assert.match(a.why, pattern);
  }
  // The receipt must be of this run, this adapter, a known site, a role that site can have, this test, and fit the site's class.
  assert.equal(classify(bound(assertion)), "error");
  assert.equal(classify(bound(assertion), { ...ok, nonce: "m" }), "error");
  const variants = [
    [{ ...assertion, origin: { invalid: true } }, /invalid/],
    [
      chaiError(
        receiptOf("chai.Assertion#assert", "comparison", {
          schema: "atlas-assertion-origin/1",
        }),
      ),
      /schema/,
    ],
    [
      chaiError(
        receiptOf("chai.Assertion#assert", "comparison", { nonce: "m" }),
      ),
      /another run/,
    ],
    [
      chaiError(
        receiptOf("chai.Assertion#assert", "comparison", {
          adapter: "0".repeat(64),
        }),
      ),
      /another adapter/,
    ],
    [chaiError(receiptOf("node:assert", "comparison")), /unknown site/],
    [
      chaiError(receiptOf("chai.property.target", "comparison")),
      /is not chai.property.target's/,
    ],
    [
      chaiError(receiptOf("chai.Assertion#assert", "explicit")),
      /is not chai.Assertion#assert's/,
    ],
    [
      chaiError(
        receiptOf("chai.Assertion#assert", "comparison", { test: "t-other" }),
      ),
      /another test/,
    ],
    [
      chaiError(
        receiptOf("chai.Assertion#assert", "comparison", {
          current: "t-other",
        }),
      ),
      /another test/,
    ],
    [
      chaiError(
        receiptOf("chai.Assertion#assert", "comparison", {
          test: null,
          current: null,
        }),
      ),
      /another test/,
    ],
    [
      chaiError(receiptOf("chai.expect.fail", "explicit", { current: null })),
      /outside this test/,
    ],
    [{ ...bound(assertion), name: "TypeError" }, /not named AssertionError/],
    [
      { ...bound(extended), constructor: "Function<TypeError>" },
      /class or assertion name/,
    ],
    [{ ...bound(extended), assertionName: null }, /class or assertion name/],
    [{ ...bound(extended), assertionName: "" }, /class or assertion name/],
    [
      project({
        name: "AssertionError",
        message: "x",
        [ORIGIN_KEY]: receiptOf("vitest.extend.result", "comparison", {
          test: "t-oracle",
          current: "t-oracle",
        }),
      }),
      /class or assertion name/,
    ],
    [plain, /no assertion origin/],
  ];
  for (const [error, pattern] of variants) {
    const a = admission(bound(error), ok);
    assert.equal(a.kind, "error", JSON.stringify(error.origin));
    assert.match(a.why, pattern);
  }
  // An unreadable or malformed receipt is an occurrence with no proof, never an assertion.
  const hostileOrigin = project({
    name: "AssertionError",
    get [ORIGIN_KEY]() {
      throw new Error("origin getter");
    },
  });
  assert.deepEqual(hostileOrigin.origin, { invalid: true });
  assert.equal(classify(hostileOrigin, ok), "error");
  for (const bad of [
    { schema: 1 },
    { ...receiptOf("chai.Assertion#assert", "comparison"), root: "1" },
    { ...receiptOf("chai.Assertion#assert", "comparison"), test: 3 },
    { ...receiptOf("chai.Assertion#assert", "comparison"), site: undefined },
  ])
    assert.deepEqual(project({ [ORIGIN_KEY]: bad }).origin, { invalid: true });
  assert.equal(project(new Error("x")).origin, null);
  // Time-outs are a veto recognised by text, before origin (text can only refuse, never admit).
  assert.equal(
    classify(project(new Error("Test timed out in 5000ms.")), ok),
    "timeout",
  );
  assert.equal(
    classify(
      { ...bound(assertion), message: "Hook timed out in 10000ms." },
      ok,
    ),
    "timeout",
  );
  // The test.fails inversion: from the runner site's receipt for this very test.fails case, no longer from its text.
  const inverted = bound(invertedError());
  assert.equal(classify(inverted, { ...ok, fails: true }), "inverted");
  assert.equal(classify(inverted, { ...ok, fails: false }), "error");
  assert.equal(
    classify(bound(invertedError({ test: "t-other" })), { ...ok, fails: true }),
    "error",
  );
  assert.equal(
    classify(project(new Error("Expect test to fail")), { ...ok, fails: true }),
    "error",
  );
  for (const value of [null, undefined, "", 0, false])
    assert.equal(classify(project(value), ok), "error");
});

test("project records a live function constructor by its name only", () => {
  class JestExtendError extends Error {}
  assert.equal(
    project(new JestExtendError("x")).constructor,
    "Function<JestExtendError>",
  );
  assert.equal(project(new TypeError("x")).constructor, "Function<TypeError>");
});

test("a valid envelope validates; every tampered field is a problem", () => {
  assert.deepEqual(
    validateEnvelope(envelope(), { nonce: "n", label: "L" }),
    [],
  );
  const cases = [
    [envelope({ schema: "other" }), /schema/],
    [envelope({ nonce: "m" }), /nonce/],
    [envelope({ label: "K" }), /envelope is for/],
    [envelope({ vitest: "5.0.2" }), /not the qualified/],
    [
      envelope({ supported: false, unsupported: ["x"] }),
      /unsupported lifecycle/,
    ],
    [envelope({ complete: false }), /completed run/],
    [envelope({ exitCode: undefined }), /exit code/],
    [envelope({}, { onTestRunEndCalls: 0 }), /onTestRunEnd/],
    [envelope({}, { onTestRunEndCalls: 2 }), /onTestRunEnd/],
    [envelope({}, { reason: "interrupted" }), /run ended/],
    [envelope({}, { modules: [] }), /no test module/],
    [
      envelope({}, { suites: [{ fullName: "S", errorCount: 1, errors: [] }] }),
      /inconsistent errors/,
    ],
    [
      envelope(
        {},
        {
          tests: [
            { ...caseOf("oracle", "failed", [assertion]), errorCount: 0 },
          ],
        },
      ),
      /inconsistent errors/,
    ],
    [
      envelope({}, { unhandledCount: 0, unhandled: [plain] }),
      /unhandled count/,
    ],
    [envelope({}, { unhandledCount: 1, unhandled: [] }), /unhandled count/],
    [envelope({ logged: { count: 1, calls: [] } }), /logged count/],
    [envelope({ processEvents: { count: 0 } }), /process count/],
    [envelope({ lateUnhandledCount: 1, lateUnhandled: [] }), /late unhandled/],
    [envelope({ closeTimedOut: undefined }), /time-out record/],
    [envelope({ witness: undefined }), /no witness/],
    [envelope({ schema: "atlas-vitest-evidence/1" }), /schema/],
    [envelope({ origin: undefined }), /no assertion-origin record/],
    [envelope({ schema: "atlas-vitest-evidence/2" }), /schema/],
    [
      envelope({ origin: { ...envelope().origin, installed: false } }),
      /not installed/,
    ],
    [
      envelope({ origin: { ...envelope().origin, schema: "x" } }),
      /assertion-origin schema/,
    ],
    [
      envelope({ origin: { ...envelope().origin, adapter: "0".repeat(64) } }),
      /is not the current/,
    ],
    [
      envelope({ origin: { ...envelope().origin, adapter: undefined } }),
      /is not the current/,
    ],
    [
      envelope(
        {},
        { tests: [{ ...caseOf("oracle", "failed", [assertion]), id: "" }] },
      ),
      /without an id/,
    ],
  ];
  for (const [env, pattern] of cases)
    assert.match(
      validateEnvelope(env, { nonce: "n", label: "L" }).join("\n"),
      pattern,
    );
  assert.deepEqual(validateEnvelope(null), ["envelope is not an object"]);
});

test("readRun refuses missing, stale, malformed or mismatched evidence", () => {
  assert.match(withRun(undefined).problems.join(), /envelope missing/);
  assert.match(withRun("{").problems.join(), /envelope malformed/);
  assert.match(
    withRun(envelope(), { json: null }).problems.join(),
    /JSON report missing/,
  );
  assert.match(
    withRun(envelope(), { json: "nope" }).problems.join(),
    /JSON report malformed/,
  );
  assert.match(
    withRun(envelope(), {
      child: { code: 0, signal: null, spawnError: null },
    }).problems.join(),
    /child exited 0/,
  );
  assert.match(
    withRun(envelope(), {
      child: { code: null, signal: "SIGKILL", spawnError: null },
    }).problems.join(),
    /SIGKILL/,
  );
  assert.match(
    withRun(envelope(), {
      child: { code: null, signal: null, spawnError: "ENOENT" },
    }).problems.join(),
    /spawn error/,
  );
  const env = envelope();
  const json = jsonOf(env);
  json.testResults[0].assertionResults[0].status = "passed";
  assert.match(withRun(env, { json }).problems.join(), /JSON status passed/);
  const fewer = jsonOf(env);
  fewer.testResults[0].assertionResults[0].failureMessages = [];
  assert.match(
    withRun(env, { json: fewer }).problems.join(),
    /JSON reports 0 failure/,
  );
  const extra = jsonOf(env);
  extra.testResults[0].assertionResults.push({
    ancestorTitles: ["S"],
    title: "third",
    status: "passed",
    failureMessages: [],
  });
  assert.match(
    withRun(env, { json: extra }).problems.join(),
    /JSON report lists 3/,
  );
  assert.equal(withRun(envelope({ nonce: "other" })).complete, false);
});

test("readRun refuses an envelope older than its child", () => {
  const dir = mkdtempSync(join(tmpdir(), "vitest-evidence-"));
  try {
    const env = envelope();
    writeFileSync(join(dir, "e.json"), JSON.stringify(env));
    writeFileSync(join(dir, "r.json"), JSON.stringify(jsonOf(env)));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "e.json"), old, old);
    const run = readRun({
      child: { code: 1 },
      envelopePath: join(dir, "e.json"),
      reportPath: join(dir, "r.json"),
      startedMs: Date.now() - 1000,
      nonce: "n",
      label: "L",
    });
    assert.match(run.problems.join(), /envelope stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRun counts an error in every channel outside a test, independently of its value", () => {
  const empty = project("");
  const channels = [
    envelope(
      {},
      {
        modules: [
          { id: "tests/a.test.ts", state: "failed", ...errors([empty]) },
        ],
      },
    ),
    envelope(
      {},
      {
        suites: [
          { module: "m", fullName: "S > inner", ...errors([project(null)]) },
        ],
      },
    ),
    envelope({}, { unhandledCount: 1, unhandled: [project(undefined)] }),
    envelope({}, { failureCount: 1, failures: [plain] }),
    envelope({ lateUnhandledCount: 1, lateUnhandled: [project(0)] }),
    envelope({
      logged: {
        count: 1,
        calls: [
          {
            phase: "close",
            method: "error",
            first: project("error during close"),
          },
        ],
      },
    }),
    envelope({
      processEvents: {
        count: 1,
        events: [
          { phase: "run", type: "uncaughtException", error: project(false) },
        ],
      },
    }),
    envelope({ startError: project("") }),
    envelope({ closeError: project(null) }),
  ];
  for (const env of channels) {
    const run = withRun(env);
    assert.equal(run.complete, true);
    assert.equal(run.taint.length, 1, JSON.stringify(run.taint));
  }
  assert.deepEqual(withRun(envelope()).taint, []);
});

test("repeated case titles are matched to the JSON report in order", () => {
  const env = envelope(
    {},
    {
      tests: [caseOf("same", "failed", [assertion]), caseOf("same", "passed")],
    },
  );
  const run = withRun(env);
  assert.equal(run.complete, true);
  assert.deepEqual(
    run.cases.map((c) => c.status),
    ["failed", "passed"],
  );
  const swapped = jsonOf(env);
  swapped.testResults[0].assertionResults.reverse();
  assert.equal(withRun(env, { json: swapped }).complete, false);
});

const runWith = (tests, over = {}, w = {}) =>
  withRun(envelope(over, { tests, ...w }));
const legacy = { expect: undefined };
const named = { expect: /S oracle/ };

test("unitVerdict: a clean named assertion is the only catch", () => {
  assert.equal(
    unitVerdict(
      runWith([
        caseOf("oracle", "failed", [assertion]),
        caseOf("other", "passed"),
      ]),
      named,
    ).verdict,
    "caught",
  );
  assert.equal(
    unitVerdict(runWith([caseOf("oracle", "failed", [assertion])]), legacy)
      .verdict,
    "caught",
  );
  assert.equal(
    unitVerdict(runWith([caseOf("other", "failed", [assertion])]), named)
      .verdict,
    "wrong_test",
  );
  assert.equal(
    unitVerdict(
      runWith(
        [caseOf("oracle", "passed")],
        { exitCode: 0 },
        { reason: "passed" },
      ),
      named,
    ).verdict,
    "survived",
  );
});

test("unitVerdict: errors beside the assertions taint the catch, in the same case, another case or outside every test", () => {
  const tainted = [
    runWith([caseOf("oracle", "failed", [assertion, project("")])]),
    runWith([
      caseOf("oracle", "failed", [assertion]),
      caseOf("other", "failed", [project(null)]),
    ]),
    runWith([
      caseOf("oracle", "failed", [assertion]),
      caseOf("other", "failed", [
        project(new Error("Test timed out in 5000ms.")),
      ]),
    ]),
    runWith(
      [caseOf("oracle", "failed", [assertion])],
      {},
      { unhandledCount: 1, unhandled: [project(null)] },
    ),
    runWith([caseOf("oracle", "failed", [assertion])], {
      logged: { count: 1, calls: [{ phase: "close" }] },
    }),
    runWith(
      [caseOf("oracle", "failed", [assertion])],
      {},
      {
        suites: [
          { module: "m", fullName: "S", ...errors([project(new Error())]) },
        ],
      },
    ),
  ];
  for (const run of tainted) {
    assert.equal(unitVerdict(run, named).verdict, "tainted");
    assert.equal(unitVerdict(run, legacy).verdict, "tainted");
  }
  assert.equal(
    unitVerdict(runWith([caseOf("oracle", "failed", [plain])]), legacy).verdict,
    "crash_only",
  );
  assert.equal(
    unitVerdict(
      runWith(
        [caseOf("oracle", "passed")],
        { exitCode: 1 },
        { modules: [{ id: "m", ...errors([plain]) }] },
      ),
      legacy,
    ).verdict,
    "crash_only",
  );
});

test("unitVerdict (revision 28): a matcher crash with assertion frames is an error, alone or beside a named assertion", () => {
  const crash = project({
    name: "TypeError",
    message: "matcher crashed before comparing",
    stack:
      "TypeError: matcher crashed before comparing\n at Proxy.__VITEST_EXTEND_ASSERTION__ (x)",
    constructor: "Function<TypeError>",
  });
  const alone = unitVerdict(
    runWith([caseOf("oracle", "failed", [crash])]),
    named,
  );
  assert.equal(alone.verdict, "crash_only");
  assert.match(alone.reasons.join("\n"), /1x no assertion origin/);
  for (const list of [
    [assertion, crash],
    [crash, assertion],
    [extended, crash],
  ])
    assert.equal(
      unitVerdict(runWith([caseOf("oracle", "failed", list)]), named).verdict,
      "tainted",
    );
  assert.equal(
    unitVerdict(
      runWith([
        caseOf("oracle", "failed", [assertion]),
        caseOf("other", "failed", [crash]),
      ]),
      named,
    ).verdict,
    "tainted",
  );
  // An extended matcher's genuine comparison failure is a clean catch, and readRun records its site and role.
  const run = runWith([caseOf("oracle", "failed", [extended])]);
  assert.equal(unitVerdict(run, named).verdict, "caught");
  assert.deepEqual(
    [run.cases[0].errors[0].site, run.cases[0].errors[0].role],
    ["vitest.extend.result", "comparison"],
  );
  // An assertion recorded in ANOTHER run's worker is not this run's assertion.
  const foreign = runWith([
    caseOf("oracle", "failed", [
      { ...assertion, origin: { ...assertion.origin, nonce: "m" } },
    ]),
  ]);
  assert.equal(unitVerdict(foreign, named).verdict, "crash_only");
  assert.equal(
    foreign.cases[0].errors[0].why,
    "assertion origin of another run",
  );
});

test("unitVerdict (revision 29): review r28's framework-made errors are refused alone and taint a named assertion beside them", () => {
  const execution = chaiError(
    receiptOf("chai.instanceOf.predicate-type-error", "execution"),
  );
  const precondition = chaiError(
    receiptOf("chai.property.name", "precondition"),
  );
  for (const error of [execution, precondition]) {
    assert.equal(
      unitVerdict(runWith([caseOf("oracle", "failed", [error])]), named)
        .verdict,
      "crash_only",
    );
    // The mixed review case: the intended body assertion plus an afterEach predicate TypeError wrapped by the framework.
    assert.equal(
      unitVerdict(
        runWith([caseOf("oracle", "failed", [assertion, error])]),
        named,
      ).verdict,
      "tainted",
    );
  }
  // An assertion of the test is not borrowed by another test's case.
  const borrowed = unitVerdict(
    runWith([
      caseOf("oracle", "failed", [
        chaiError(
          receiptOf("chai.Assertion#assert", "comparison", {
            test: "t-other",
            current: "t-other",
          }),
        ),
      ]),
    ]),
    named,
  );
  assert.equal(borrowed.verdict, "crash_only");
  assert.match(borrowed.reasons.join("\n"), /comparison of another test/);
});

test("unitVerdict: a test.fails inversion counts only for a case the mutant's expect names", () => {
  const inverted = invertedError();
  const run = runWith([
    caseOf("oracle", "failed", [inverted], { fails: true }),
  ]);
  assert.equal(unitVerdict(run, named).verdict, "caught");
  assert.equal(unitVerdict(run, { expect: /elsewhere/ }).verdict, "crash_only");
  assert.equal(unitVerdict(run, legacy).verdict, "crash_only");
  // Elsewhere it stands like an unrelated assertion: no catch by itself, no veto beside the named assertion.
  const beside = runWith([
    caseOf("oracle", "failed", [assertion]),
    caseOf("other", "failed", [inverted], { fails: true }),
  ]);
  assert.equal(unitVerdict(beside, named).verdict, "caught");
});

test("unitVerdict keeps the earlier runner's kinds fields (suite) and counts every error outside a test", () => {
  const run = runWith(
    [caseOf("oracle", "failed", [assertion])],
    {},
    {
      modules: [{ id: "m", ...errors([project("")]) }],
      unhandledCount: 1,
      unhandled: [project(null)],
    },
  );
  const v = unitVerdict(run, named);
  assert.equal(v.verdict, "tainted");
  assert.deepEqual(
    [v.kinds.suite, v.kinds.outside, v.kinds.assertion],
    [1, 2, 1],
  );
  assert.equal(
    unitVerdict(runWith([caseOf("oracle", "failed", [assertion])]), named).kinds
      .suite,
    0,
  );
});

test("unitVerdict and controlVerdict refuse incomplete evidence", () => {
  const run = withRun(undefined);
  assert.equal(unitVerdict(run, named).verdict, "incomplete");
  assert.equal(controlVerdict(run).verdict, "incomplete");
});

test("controlVerdict: clean all-pass (designed skips counted) passes; a failure, an error anywhere or a non-zero exit does not", () => {
  const pass = runWith(
    [caseOf("a", "passed"), caseOf("b", "skipped")],
    { exitCode: 0 },
    { reason: "passed" },
  );
  assert.deepEqual(
    [controlVerdict(pass).verdict, controlVerdict(pass).skipped],
    ["pass", 1],
  );
  assert.equal(
    controlVerdict(runWith([caseOf("a", "failed", [assertion])])).verdict,
    "fail",
  );
  assert.equal(
    controlVerdict(
      runWith(
        [caseOf("a", "passed")],
        { exitCode: 0, closeError: project("") },
        { reason: "passed" },
      ),
    ).verdict,
    "error",
  );
  assert.equal(
    controlVerdict(
      runWith([caseOf("a", "passed")], { exitCode: 1 }, { reason: "passed" }),
    ).verdict,
    "fail",
  );
});

test("failsRun: an earlier revision's mutant that is not cleanly caught is listed, never a pass for one with expect", () => {
  for (const v of ["crash_only", "tainted"]) {
    assert.equal(failsRun(v, legacy), false);
    assert.equal(failsRun(v, named), true);
  }
  for (const v of ["survived", "incomplete", "wrong_test", "infrastructure"])
    assert.equal(failsRun(v, legacy), true);
  assert.equal(failsRun("caught", named), false);
});

test("namePatternOf selects exactly the declared full names, whatever characters they contain", () => {
  const names = ["S > a (b) [c] + d? $1", "S > e.f*g|h"];
  const r = new RegExp(namePatternOf(names).source);
  for (const n of names) assert.equal(r.test(n), true);
  for (const n of ["S > a (b) [c] + d? $1 and more", "x S > e.f*g|h", "S > e"])
    assert.equal(r.test(n), false);
});

test("selectionProblems: exactly the declared cases ran, each once, and nothing else", () => {
  const declared = [{ module: "tests/a.test.ts", name: "S > oracle" }];
  const exact = runWith([
    caseOf("oracle", "failed", [assertion]),
    caseOf("other", "skipped"),
  ]);
  assert.deepEqual(selectionProblems(exact, declared), []);
  assert.match(
    selectionProblems(
      runWith([caseOf("oracle", "skipped"), caseOf("other", "skipped")]),
      declared,
    ).join(),
    /not run/,
  );
  assert.match(
    selectionProblems(
      runWith([
        caseOf("oracle", "failed", [assertion]),
        caseOf("other", "passed"),
      ]),
      declared,
    ).join(),
    /undeclared/,
  );
  assert.match(
    selectionProblems(
      runWith([caseOf("oracle", "passed"), caseOf("oracle", "passed")]),
      declared,
    ).join(),
    /ran 2 case\(s\), declared 1/,
  );
  assert.match(
    selectionProblems(exact, [
      { module: "tests/b.test.ts", name: "S > oracle" },
    ]).join(),
    /not run/,
  );
});

test("unauthorisedSelections: a narrowed selection is refused for a mutant outside its decision or the catalogue", () => {
  const catalogue = [{ id: "MU-1" }, { id: "MU-2" }];
  assert.deepEqual(
    unauthorisedSelections({ "MU-1": {} }, ["MU-1"], catalogue),
    [],
  );
  assert.deepEqual(
    unauthorisedSelections({ "MU-2": {} }, ["MU-1"], catalogue),
    ["MU-2"],
  );
  assert.deepEqual(
    unauthorisedSelections({ "MU-3": {} }, ["MU-3"], catalogue),
    ["MU-3"],
  );
});

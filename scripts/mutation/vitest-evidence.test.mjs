// Pure controls of the supervised-evidence contract (vitest-evidence.mjs) and the unit runner's verdict rule (WEB-14a revision 27,
// review r26 R31 / design assessment DA-H2, Q3/Q4/Q6; revision 28, review r27 R31: assertion origin, C1-C3; revision 29, review r28
// R31: per-occurrence site receipts bound to the test and adapter, schema 3; revision 30, review r29 R31: occurrence records with
// collection phase, attempt, propagation edges and the worker's health attestation, schema 4). The real Vitest boundary is qualified
// separately with actual runs.
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
  OCCURRENCE_KEY,
  ORIGIN_SCHEMA,
  project,
  readRun,
  SITES,
  selectionProblems,
  unitVerdict,
  validateEnvelope,
} from "./vitest-evidence.mjs";

// A serialised error as Vitest hands it over, with the OCCURRENCE record the runner attaches in the worker (vitest-origin-runtime.mjs,
// revision 30): the construction receipt of the object, the phase and attempt it was collected in, and the invocations it left.
// `test`/`current` "@case" stand for the id of the case the error is placed in (caseOf binds them).
const ADAPTER = currentAdapter();
const FRAMELESS = new Set([
  "vitest.resolves.rejected",
  "vitest.rejects.resolved",
  "chai.expect.fail",
  "chai.assert.fail",
  "vitest.runner.fails-inversion",
]);
const receiptOf = (site, role, over = {}) => ({
  schema: ORIGIN_SCHEMA,
  nonce: "n",
  adapter: ADAPTER,
  site,
  role,
  invocation: 7,
  framed: !FRAMELESS.has(site),
  root: 1,
  test: "@case",
  current: "@case",
  phase: "body",
  attempt: 1,
  concurrent: false,
  ...over,
});
/** The edge by which a framed construction left its own invocation (none for a frameless one). */
const terminalOf = (receipt) =>
  receipt?.framed === true && Number.isInteger(receipt.invocation)
    ? [
        {
          invocation: receipt.invocation,
          kind: SITES[receipt.site]?.handler ? "async-result" : "sync",
        },
      ]
    : [];
const occurrenceOf = (receipt, over = {}) => ({
  schema: ORIGIN_SCHEMA,
  nonce: "n",
  adapter: ADAPTER,
  id: 1,
  test: "@case",
  phase: "body",
  attempt: 1,
  concurrent: false,
  opaque: [],
  complete: true,
  path: [],
  receipt,
  edges: terminalOf(receipt),
  ...over,
});
const chaiError = (receipt, message = "expected 1 to be 2", over = {}) =>
  project({
    name: "AssertionError",
    message,
    stack: `AssertionError: ${message}`,
    [OCCURRENCE_KEY]: occurrenceOf(receipt, over),
  });
const assertion = chaiError(receiptOf("chai.Assertion#assert", "comparison"));
const extended = project({
  name: "Error",
  message: "expect(element).toBeVisible()",
  stack:
    "Error: expect(element).toBeVisible()\n at Proxy.__VITEST_EXTEND_ASSERTION__ (x)",
  constructor: "Function<JestExtendError>",
  __vitest_error_context__: { assertionName: "toBeVisible" },
  [OCCURRENCE_KEY]: occurrenceOf(
    receiptOf("vitest.extend.result", "comparison"),
  ),
});
const invertedError = (over = {}) =>
  project(
    Object.assign(new Error("Expect test to fail"), {
      [OCCURRENCE_KEY]: occurrenceOf(
        receiptOf("vitest.runner.fails-inversion", "inversion", {
          invocation: null,
          root: null,
          current: null,
          phase: "after-try",
          ...over,
        }),
        { phase: "inversion" },
      ),
    }),
  );
const plain = project(
  Object.assign(new Error("boom"), {
    [OCCURRENCE_KEY]: occurrenceOf(null),
  }),
);
const errors = (list) => ({ errorCount: list.length, errors: list });
const bindId = (value, id) => (value === "@case" ? id : value);
const bind = (error, id) => {
  const o = error?.occurrence;
  if (!o || typeof o !== "object" || o.invalid) return error;
  return {
    ...error,
    occurrence: {
      ...o,
      test: bindId(o.test, id),
      receipt:
        o.receipt === null
          ? null
          : {
              ...o.receipt,
              test: bindId(o.receipt.test, id),
              current: bindId(o.receipt.current, id),
            },
    },
  };
};
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
/** The worker's per-file attestation: every occurrence id of the module's tests, per test (revision 30). */
const healthOf = (tests, module) => ({
  schema: ORIGIN_SCHEMA,
  nonce: "n",
  adapter: ADAPTER,
  failures: [],
  depth: 0,
  invocations: 9,
  occurrences: 9,
  issued: Object.fromEntries(
    tests
      .filter((t) => t.module === module)
      .map((t) => [
        t.id,
        t.errors.map((e) => e?.occurrence?.id).filter(Number.isInteger),
      ]),
  ),
});
function envelope(over = {}, witness = {}) {
  const w = {
    onTestRunEndCalls: 1,
    reason: "failed",
    modules: [{ id: "tests/a.test.ts", state: "failed", ...errors([]) }],
    suites: [{ module: "tests/a.test.ts", fullName: "S", ...errors([]) }],
    tests: [caseOf("oracle", "failed", [assertion]), caseOf("other", "passed")],
    unhandledCount: 0,
    unhandled: [],
    failureCount: 0,
    failures: [],
    ...witness,
  };
  // A module that names no health of its own gets the attestation of its tests (an explicit `health` is kept as given).
  if (Array.isArray(w.modules))
    w.modules = w.modules.map((m) =>
      m && typeof m === "object" && !("health" in m)
        ? {
            ...m,
            health: healthOf(Array.isArray(w.tests) ? w.tests : [], m.id),
          }
        : m,
    );
  return {
    schema: ENVELOPE_SCHEMA,
    nonce: "n",
    label: "L",
    vitest: "5.0.1",
    supported: true,
    unsupported: [],
    witness: w,
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

test("admission (revision 29, kept in revision 30): an assertion only by the receipt of a completed comparison of THIS test, never by class, name, frames or text", () => {
  const ok = { nonce: "n", adapter: ADAPTER, testId: "t-oracle", issued: [1] };
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
          [OCCURRENCE_KEY]: occurrenceOf(null),
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
          [OCCURRENCE_KEY]: occurrenceOf(null),
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
    assert.equal(a.kind, "error", JSON.stringify(error.occurrence));
    assert.match(a.why, pattern);
  }
  // The receipt must be of this run, this adapter, a known site, a role that site can have, this test, and fit the site's class.
  assert.equal(classify(bound(assertion)), "error");
  assert.equal(classify(bound(assertion), { ...ok, nonce: "m" }), "error");
  const variants = [
    [{ ...assertion, occurrence: { invalid: true } }, /invalid occurrence/],
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
        [OCCURRENCE_KEY]: occurrenceOf(
          receiptOf("vitest.extend.result", "comparison", {
            test: "t-oracle",
            current: "t-oracle",
          }),
        ),
      }),
      /class or assertion name/,
    ],
    [plain, /no assertion origin/],
  ];
  for (const [error, pattern] of variants) {
    const a = admission(bound(error), ok);
    assert.equal(a.kind, "error", JSON.stringify(error.occurrence));
    assert.match(a.why, pattern);
  }
  // An unreadable or malformed occurrence (or receipt inside it) is an occurrence with no proof, never an assertion.
  const hostileOrigin = project({
    name: "AssertionError",
    get [OCCURRENCE_KEY]() {
      throw new Error("occurrence getter");
    },
  });
  assert.deepEqual(hostileOrigin.occurrence, { invalid: true });
  assert.equal(classify(hostileOrigin, ok), "error");
  const r = receiptOf("chai.Assertion#assert", "comparison");
  for (const bad of [
    { schema: 1 },
    occurrenceOf({ ...r, root: "1" }),
    occurrenceOf({ ...r, test: 3 }),
    occurrenceOf({ ...r, site: undefined }),
    occurrenceOf({ ...r, framed: "yes" }),
    occurrenceOf({ ...r, concurrent: undefined }),
    occurrenceOf(r, { id: "1" }),
    occurrenceOf(r, { edges: [{ invocation: 7, kind: "other" }] }),
    occurrenceOf(r, { edges: "none" }),
    occurrenceOf(r, { opaque: [null] }),
    // revision 31: the collection path and completeness are part of the shape
    occurrenceOf(r, { complete: "yes" }),
    occurrenceOf(r, { complete: undefined }),
    occurrenceOf(r, { path: "none" }),
    occurrenceOf(r, { path: undefined }),
    occurrenceOf(r, { path: [null] }),
    occurrenceOf(r, {
      path: [{ kind: "tuple", object: true, receipt: null, edges: [] }],
    }),
    occurrenceOf(r, {
      path: [{ kind: "array", object: "yes", receipt: null, edges: [] }],
    }),
    occurrenceOf(r, {
      path: [
        {
          kind: "array",
          object: true,
          receipt: null,
          edges: [{ invocation: "7", kind: "sync" }],
        },
      ],
    }),
    occurrenceOf(r, {
      path: [
        {
          kind: "array",
          object: true,
          receipt: { ...r, root: "1" },
          edges: [],
        },
      ],
    }),
    occurrenceOf(r, {
      path: [
        { kind: "aggregate", object: true, receipt: null, edges: [] },
        { kind: "array", object: true, receipt: null, edges: [] },
      ],
    }),
    occurrenceOf(r, {
      path: [
        { kind: "array", object: true, receipt: null, edges: [] },
        { kind: "aggregate", object: true, receipt: null, edges: [] },
        { kind: "aggregate", object: true, receipt: null, edges: [] },
      ],
    }),
    occurrenceOf(r, { phase: undefined }),
    occurrenceOf("receipt"),
    // Revision 32: only the six edge kinds of origin schema 5 exist.
    occurrenceOf(r, { edges: [{ invocation: 1, kind: "async-route" }] }),
  ])
    assert.deepEqual(project({ [OCCURRENCE_KEY]: bad }).occurrence, {
      invalid: true,
    });
  assert.equal(project(new Error("x")).occurrence, null);
  assert.match(
    admission(project(new Error("x")), ok).why,
    /no occurrence record/,
  );
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

test("admission (revision 30): per occurrence, by its collection phase, attempt, propagation edges and worker attestation", () => {
  const ok = { nonce: "n", adapter: ADAPTER, testId: "t-oracle", issued: [1] };
  const bound = (e) => bind(e, "t-oracle");
  const r = receiptOf("chai.Assertion#assert", "comparison");
  const genuine = (over) => bound(chaiError(r, "expected 1 to be 2", over));
  assert.equal(classify(genuine(), ok), "assertion");
  // The asynchronous extended matcher's failing result left through its handler; the frameless promise sites need no edge of their own.
  const asyncResult = receiptOf("vitest.extend.async-result", "comparison");
  const asyncError = (over) =>
    bound(
      project({
        name: "Error",
        message: "genuine mismatch",
        constructor: "Function<JestExtendError>",
        __vitest_error_context__: { assertionName: "toCustom" },
        [OCCURRENCE_KEY]: occurrenceOf(asyncResult, over),
      }),
    );
  assert.equal(classify(asyncError(), ok), "assertion");
  assert.equal(
    admission(asyncError({ edges: [{ invocation: 7, kind: "sync" }] }), ok).why,
    "never left its own invocation as that invocation's failure",
  );
  assert.equal(
    classify(
      bound(chaiError(receiptOf("vitest.resolves.rejected", "comparison"))),
      ok,
    ),
    "assertion",
  );
  const refusedBy = [
    // Review r29: a genuine error rethrown from another matcher's body, message function or getter left THAT invocation.
    [
      genuine({
        edges: [
          { invocation: 7, kind: "sync" },
          { invocation: 9, kind: "sync" },
        ],
      }),
      /propagated out of another matcher invocation/,
    ],
    [
      genuine({
        edges: [
          { invocation: 7, kind: "sync" },
          { invocation: 9, kind: "async-result" },
        ],
      }),
      /propagated out of another matcher invocation/,
    ],
    [
      genuine({
        edges: [
          { invocation: 7, kind: "sync" },
          { invocation: 9, kind: "async-rejection" },
        ],
      }),
      /rejection of an asynchronous matcher/,
    ],
    [genuine({ edges: [] }), /never left its own invocation/],
    // Revision 32 (review r31 R31): a `.resolves`/`.rejects` route vetoes what it did not produce or did not carry to its consumer,
    // whatever the donor's own clean edges, and so does a route edge on a container the framework expanded.
    ...["async-settlement", "async-delivery"].map((kind) => [
      genuine({
        edges: [
          { invocation: 7, kind: "sync" },
          { invocation: 11, kind },
        ],
      }),
      /through a \.resolves\/\.rejects route that did not produce it/,
    ]),
    [
      genuine({
        path: [
          {
            kind: "array",
            object: true,
            receipt: null,
            edges: [{ invocation: 11, kind: "async-delivery" }],
          },
        ],
      }),
      /collected out of an array that left a matcher invocation/,
    ],
    // A hook, cleanup or lifecycle collection is a veto, whatever it carries.
    ...[
      "beforeEach",
      "afterEach",
      "aroundEach",
      "fixture-cleanup",
      "task-finished",
      "test-hook",
      "after-try",
      "after-body",
      "before-try",
      "prepare",
      "unknown",
    ].map((phase) => [genuine({ phase }), new RegExp(`the ${phase} phase`)]),
    [genuine({ phase: "elsewhere" }), /unknown collection phase/],
    [genuine({ opaque: [5] }), /non-intrinsic thenable/],
    [genuine({ concurrent: true }), /another test was running/],
    [genuine({ id: 2 }), /did not attest/],
    [genuine({ test: "t-other" }), /collected for another test/],
    [genuine({ test: null }), /collected for another test/],
    [genuine({ attempt: 2 }), /outside this attempt's test body/],
    [
      bound(chaiError({ ...r, phase: "beforeEach" })),
      /outside this attempt's test body/,
    ],
    [
      bound(chaiError({ ...r, concurrent: true })),
      /outside this attempt's test body/,
    ],
    [
      bound(chaiError({ ...r, invocation: null, framed: false })),
      /without an invocation/,
    ],
    [
      bound(chaiError(receiptOf("chai.expect.fail", "nested"))),
      /nested in another matcher/,
    ],
    [
      bound(
        project({
          name: "Error",
          message: "x",
          constructor: "Function<JestExtendError>",
          __vitest_error_context__: { assertionName: "toCustom" },
          [OCCURRENCE_KEY]: occurrenceOf({
            ...asyncResult,
            role: "unattributed",
          }),
        }),
      ),
      /outside its matcher's handler/,
    ],
    [genuine({ schema: "atlas-assertion-origin/2" }), /occurrence schema/],
    [genuine({ nonce: "m" }), /occurrence of another run/],
    [genuine({ adapter: "0".repeat(64) }), /occurrence of another adapter/],
    [bound(chaiError({ ...r, nonce: "m" })), /assertion origin of another run/],
    [
      bound(chaiError({ ...r, adapter: "0".repeat(64) })),
      /assertion origin of another adapter/,
    ],
    [bound(chaiError({ ...r, schema: "x" })), /unsupported origin schema/],
  ];
  for (const [error, pattern] of refusedBy) {
    const a = admission(error, ok);
    assert.equal(a.kind, "error", JSON.stringify(error.occurrence));
    assert.match(a.why, pattern, JSON.stringify(error.occurrence));
  }
  // No attestation at all, or one of another shape, is no attestation.
  assert.match(
    admission(genuine(), { ...ok, issued: null }).why,
    /did not attest/,
  );
  assert.match(
    admission(genuine(), { ...ok, issued: [] }).why,
    /did not attest/,
  );
  // The inversion is collected in its own phase with no edge; anything else carrying its receipt is refused.
  assert.equal(
    classify(bound(invertedError()), { ...ok, fails: true }),
    "inverted",
  );
  const inversionWithEdge = bound(invertedError());
  inversionWithEdge.occurrence.edges = [{ invocation: 3, kind: "sync" }];
  assert.equal(classify(inversionWithEdge, { ...ok, fails: true }), "error");
  // The phase is reported for every kind, so a refusal says where the error was collected.
  assert.equal(
    admission(genuine({ phase: "afterEach" }), ok).phase,
    "afterEach",
  );
  assert.equal(admission(genuine(), ok).phase, "body");
});

test("admission (revision 31): the framework's array/aggregate expansion keeps every container's veto; opaque asynchronous matchers refuse", () => {
  const ok = { nonce: "n", adapter: ADAPTER, testId: "t-oracle", issued: [1] };
  const bound = (e) => bind(e, "t-oracle");
  const r = receiptOf("chai.Assertion#assert", "comparison");
  const genuine = (over) => bound(chaiError(r, "expected 1 to be 2", over));
  const container = (kind, edges = [], receipt = null) => ({
    kind,
    object: true,
    receipt,
    edges,
  });
  // A genuine comparison wrapped by TEST code (no container left an invocation) stays a clean catch, through either expansion.
  for (const path of [
    [container("aggregate")],
    [container("array")],
    [container("array"), container("aggregate")],
  ])
    assert.equal(
      classify(genuine({ path }), ok),
      "assertion",
      JSON.stringify(path),
    );
  // A container that left another matcher (thrown, its handler's throw, its rejection, or soft-collected in it) vetoes the child.
  for (const kind of ["sync", "async-result", "async-rejection", "soft"]) {
    for (const path of [
      [container("aggregate", [{ invocation: 9, kind }])],
      [container("array", [{ invocation: 9, kind }])],
      [container("array", [{ invocation: 9, kind }]), container("aggregate")],
      [container("array"), container("aggregate", [{ invocation: 9, kind }])],
    ]) {
      const a = admission(genuine({ path }), ok);
      assert.equal(a.kind, "error", JSON.stringify(path));
      assert.match(a.why, /that left a matcher invocation/);
    }
    // Even an edge naming the child's own invocation: a container is never a comparison.
    assert.equal(
      classify(
        genuine({ path: [container("aggregate", [{ invocation: 7, kind }])] }),
        ok,
      ),
      "error",
    );
  }
  assert.match(
    admission(genuine({ path: [container("array", [], r)] }), ok).why,
    /carrying a construction receipt/,
  );
  // An incomplete record (a snapshot or the collection context failed) is never admitted.
  assert.match(
    admission(genuine({ complete: false }), ok).why,
    /incomplete occurrence record/,
  );
  // An opaque asynchronous matcher earlier in the attempt refuses every later occurrence, whatever else it carries.
  assert.match(
    admission(genuine({ opaque: [3] }), ok).why,
    /non-intrinsic thenable/,
  );
  // The container veto also applies to an occurrence without a receipt and to the inversion phase.
  assert.match(
    admission(
      bound(
        project({
          name: "Error",
          message: "x",
          [OCCURRENCE_KEY]: occurrenceOf(null, {
            path: [container("aggregate", [{ invocation: 9, kind: "sync" }])],
          }),
        }),
      ),
      ok,
    ).why,
    /that left a matcher invocation/,
  );
  const inversionInPath = bound(invertedError());
  inversionInPath.occurrence.path = [container("aggregate")];
  assert.equal(classify(inversionInPath, { ...ok, fails: true }), "error");
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
    [OCCURRENCE_KEY]: occurrenceOf(null),
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
      {
        ...assertion,
        occurrence: {
          ...assertion.occurrence,
          receipt: { ...assertion.occurrence.receipt, nonce: "m" },
        },
      },
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
      // Revision 30: the module is the tests' own (its worker attests their occurrences).
      modules: [{ id: "tests/a.test.ts", ...errors([project("")]) }],
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

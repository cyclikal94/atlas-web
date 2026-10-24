// WEB-14a revision 31 (review r30 R31/R33 incomplete_fix, design assessment 34d402c4 C1-C4): schema 4. `failTask` now gives every
// child it collects the snapshot of the array it iterated and of the AggregateError it expanded (the framework's own decisions, read
// from its own variables: no second `Array.isArray`/`instanceof`, no traversal), so a container's edge reaches its children (RC1). The
// extended matcher's one `result.then(handler)` call keeps its column and its first argument; an intrinsic promise result (decided at
// the end of the previous line, before the framework reads `result.then`) also gets an explicit rethrowing rejection handler, spread from
// an own-property iterable (none for any other thenable), replacing revision 30's second `then` (RC2). `handleTestError` takes the soft
// context before serialising. An asynchronous result or `.resolves`/`.rejects` subject whose path is not intrinsic makes the worker opaque.
//
// WEB-14a revision 30 (review r29 R31 incomplete_fix / R33 harness, design assessment b8e8e25d C1-C4): a construction site's role is now
// DIAGNOSTIC origin only. The edits below also give the runtime (vitest-origin-runtime.mjs) every invocation boundary (chai's wrappers,
// with a rethrowing catch that records the edge), the asynchronous extended matcher's single subscription (`subscribe`, R33: replaces
// revision 29's second `then`), and the runner's test phases, attempts and error collection (`failTask`, `expect.soft`, the `test.fails`
// inversion), where each collected error gets its OCCURRENCE record. Schema 3; the receipts no longer touch the error objects.
//
// WEB-14a revision 29 (review r28 R31 incomplete_fix, design assessment C1-C3): the AUDITED assertion-producing sites of the installed
// framework, and the exact load-time edits that record, on the one error object each site constructs, which site made it and in
// what role. Pure data plus a pure transform: the loader (vitest-origin-loader.mjs) applies it in each Vitest worker, the worker
// runtime (vitest-origin-runtime.mjs) reads the roles, and the evidence reader (vitest-evidence.mjs) binds the adapter digest.
//
// Why not a class: revision 28 branded every instance of chai's AssertionError, but chai constructs that class for argument
// validation (`.property(null)`, `.include` on undefined, "Target cannot be null or undefined.") and to WRAP an execution error
// (`instanceof` whose predicate throws a TypeError, before any comparison). Class membership, frames and messages cannot tell those from
// a completed comparison. A site can: each `new AssertionError(...)` / `new JestExtendError(...)` below is one audited statement of
// chai 6.2.2 or Vitest 5.0.1 with a fixed role, and only the object that statement constructs gets the site's receipt.
//
// Roles:
//   comparison    the statement runs only after the intended comparison completed with a failing outcome (chai's `Assertion#assert`,
//                 Vitest's direct mismatch sites, promise wrong-settlement, an extended matcher's failing result after its message).
//                 The runtime still decides per occurrence: a comparison counts only on an `expect()` root (not chai's internal
//                 `new Assertion(..., true)` preconditions: `internal`), not created or evaluated inside another matcher (`nested`).
//   explicit      an explicit failure the test wrote (`expect.fail`, `assert.fail`); inside a matcher's execution it is `nested`
//   inversion     Vitest's runner failing a `test.fails` case that passed
//   precondition  argument/subject validation before any comparison (never an assertion)
//   execution     an execution error wrapped by the framework (never an assertion)
//   unsupported   a site of an interface the population does not use (chai `should`, chai's `assert.isIterable`): fails closed
//
// Every module is pinned by the SHA-256 of its installed bytes and every edit must match exactly `count` times: any other version,
// file or anchor refuses to load (the worker cannot start), never a silently uninstrumented run. Edits never add or remove a line, so
// stack line numbers are unchanged; instrumentation calls run before or after the framework's own frames, never between them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ORIGIN_SCHEMA = "atlas-assertion-origin/4";
export const ORIGIN_KEY = "__atlasAssertionOrigin";
/** The property of a SERIALISED error copy holding its occurrence record (the runner's copy; the original error is never changed). */
export const OCCURRENCE_KEY = "__atlasAssertionOccurrence";
/** The file task's meta key of the runtime's per-file health attestation (vitest-origin-setup.mjs → witness → reader). */
export const HEALTH_META_KEY = "atlasAssertionOriginHealth";
/** Every worker runs with this Node option: AsyncLocalStorage without promise hooks (the runtime's asynchronous invocation context). */
export const ASYNC_CONTEXT_FLAG = "--experimental-async-context-frame";
export const ORIGIN_NONCE_ENV = "ATLAS_VITEST_ORIGIN_NONCE";
/** The worker-realm registry (runtime → setup). Not a source of evidence: admission reads the occurrence records on serialised errors. */
export const REGISTRY = Symbol.for("atlas.assertion-origin/4");
/** The chai flag holding an `expect()` root's record (copied along a chain by chai's transferFlags, absent on internal assertions). */
export const ROOT_FLAG = "atlas-origin-root";

const here = dirname(fileURLToPath(import.meta.url));
export const ORIGIN_FILES = Object.freeze({
  sites: join(here, "vitest-origin-sites.mjs"),
  runtime: join(here, "vitest-origin-runtime.mjs"),
  loader: join(here, "vitest-origin-loader.mjs"),
  register: join(here, "vitest-origin-register.mjs"),
  setup: join(here, "vitest-origin-setup.mjs"),
});

export const ROLES = Object.freeze([
  "comparison",
  "explicit",
  "inversion",
  "precondition",
  "execution",
  "unsupported",
]);
/** Roles the runtime may assign to a `comparison` site's occurrence instead (each a refusal). */
export const DERIVED_ROLES = Object.freeze([
  "internal",
  "nested",
  "unattributed",
]);
/** Where the runner collects a test's error (vitest-origin-runtime.mjs `failing`); only `body` (and `inversion`) can be admitted. */
export const PHASES = Object.freeze([
  "prepare",
  "before-try",
  "beforeEach",
  "body",
  "after-try",
  "after-body",
  "task-finished",
  "afterEach",
  "aroundEach",
  "fixture-cleanup",
  "test-hook",
  "inversion",
  "unknown",
]);

// One construction site: `ids` names each occurrence of `text` in source order (identical statements share a role).
const site = (role, receiver, text, ...ids) => ({ role, receiver, text, ids });
// Revision 30: a site inside the extended matcher's asynchronous result handler (its invocation is the handler's, not a frame's).
const inHandler = (s) => ({ ...s, handler: true });

const CHAI_SITES = [
  site(
    "precondition",
    "none",
    'new AssertionError(\n      flagMsg + "object tested must be " + str + ", but " + objType + " given",\n      void 0,\n      ssfi\n    )',
    "chai.expectTypes",
  ),
  site(
    "comparison",
    "assertion",
    'new AssertionError(\n        msg,\n        assertionErrorObjectProperties,\n        // @ts-expect-error Not sure what to do about these types yet\n        config.includeStack ? this.assert : flag(this, "ssfi")\n      )',
    "chai.Assertion#assert",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n          flagMsg + "unable to use .deep.include with WeakSet",\n          void 0,\n          ssfi\n        )',
    "chai.include.deep-weakset",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n          flagMsg + "the given combination of arguments (" + objType + " and " + type(val).toLowerCase() + ") is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a " + type(val).toLowerCase(),\n          void 0,\n          ssfi\n        )',
    "chai.include.invalid-combination",
  ),
  site(
    "comparison",
    "assertion",
    "new AssertionError(assertionMessage, void 0, ssfi)",
    "chai.callable",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n        flagMsg + ".empty was passed a weak collection",\n        void 0,\n        ssfi\n      )',
    "chai.empty.weak-collection",
  ),
  site(
    "precondition",
    "assertion",
    "new AssertionError(msg.trim(), void 0, ssfi)",
    "chai.empty.function",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n          flagMsg + ".empty was passed non-string primitive " + inspect2(val),\n          void 0,\n          ssfi\n        )',
    "chai.empty.primitive",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n      msgPrefix + "the argument to above must be a date",\n      void 0,\n      ssfi\n    )',
    "chai.above.date-argument",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n      msgPrefix + "the argument to above must be a number",\n      void 0,\n      ssfi\n    )',
    "chai.above.number-argument",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n      msgPrefix + "expected " + printObj + " to be a number or a date",\n      void 0,\n      ssfi\n    )',
    "chai.above.subject",
  ),
  site(
    "precondition",
    "assertion",
    "new AssertionError(errorMessage, void 0, ssfi)",
    "chai.least.arguments",
    "chai.below.arguments",
    "chai.most.arguments",
    "chai.within.arguments",
  ),
  site(
    "execution",
    "assertion",
    'new AssertionError(\n        flagMsg + "The instanceof assertion needs a constructor but " + type(constructor) + " was given.",\n        void 0,\n        ssfi\n      )',
    "chai.instanceOf.predicate-type-error",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n        flagMsg + "the argument to property must be a string when using nested syntax",\n        void 0,\n        ssfi\n      )',
    "chai.property.nested-name",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n        flagMsg + "the argument to property must be a string, number, or symbol",\n        void 0,\n        ssfi\n      )',
    "chai.property.name",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n      flagMsg + \'The "nested" and "own" flags cannot be combined.\',\n      void 0,\n      ssfi\n    )',
    "chai.property.flags",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(\n      flagMsg + "Target cannot be null or undefined.",\n      void 0,\n      ssfi\n    )',
    "chai.property.target",
  ),
  site(
    "precondition",
    "assertion",
    "new AssertionError(mixedArgsMsg, void 0, ssfi)",
    "chai.keys.mixed-array",
    "chai.keys.mixed-object",
  ),
  site(
    "precondition",
    "assertion",
    'new AssertionError(flagMsg + "keys required", void 0, ssfi)',
    "chai.keys.required",
  ),
  site(
    "precondition",
    "assertion",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the audited source text, matched literally
    "new AssertionError(\n      flagMsg ? `${flagMsg}: ${message}` : message,\n      void 0,\n      ssfi\n    )",
    "chai.closeTo.delta",
    "chai.closeTo.expected",
  ),
  site(
    "explicit",
    "none",
    "new AssertionError(\n    message,\n    {\n      actual,\n      expected,\n      operator\n    },\n    expect.fail\n  )",
    "chai.expect.fail",
  ),
  site(
    "unsupported",
    "none",
    "new AssertionError(\n      message,\n      {\n        actual,\n        expected,\n        operator\n      },\n      should2.fail\n    )",
    "chai.should.fail",
  ),
  site(
    "explicit",
    "none",
    "new AssertionError(\n    message,\n    {\n      actual,\n      expected,\n      operator\n    },\n    assert.fail\n  )",
    "chai.assert.fail",
  ),
  site(
    "precondition",
    "none",
    "new AssertionError(\n        msg + 'Invalid operator \"' + operator + '\"',\n        void 0,\n        assert.operator\n      )",
    "chai.assert.operator.invalid",
  ),
  site(
    "unsupported",
    "none",
    "new AssertionError(msg, void 0, assert.isIterable)",
    "chai.assert.isIterable",
  ),
];

const VITEST_SITES = [
  site(
    "comparison",
    "assertion",
    'new AssertionError(message, { showDiff: false }, utils.flag(this, "ssfi"))',
    "vitest.throws.resolved-non-function",
    "vitest.toThrow.resolved-non-function",
    "vitest.toThrow.did-not-throw",
  ),
  site(
    "comparison",
    "assertion",
    "new AssertionError(message, {\n\t\t\t\tshowDiff: true,\n\t\t\t\texpected,\n\t\t\t\tactual: actualSubset\n\t\t\t})",
    "vitest.toMatchObject",
  ),
  site(
    "comparison",
    "assertion",
    "new AssertionError(msg)",
    "vitest.toHaveBeenCalled",
  ),
  site(
    "comparison",
    "assertion",
    "new AssertionError(formatCalls(spy, msg, args))",
    "vitest.toHaveBeenCalledWith",
    "vitest.toHaveBeenCalledExactlyOnceWith",
  ),
  site(
    "comparison",
    "assertion",
    "new AssertionError(formatReturns(spy, results, msg, value))",
    "vitest.toHaveReturnedWith",
  ),
  site(
    "comparison",
    "assertion",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the audited source text, matched literally
    'new AssertionError(`promise rejected "${utils.inspect(err)}" instead of resolving`, { showDiff: false })',
    "vitest.resolves.rejected",
  ),
  site(
    "comparison",
    "assertion",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the audited source text, matched literally
    'new AssertionError(`promise resolved "${utils.inspect(value)}" instead of rejecting`, {\n\t\t\t\t\t\tshowDiff: true,\n\t\t\t\t\t\texpected: /* @__PURE__ */ new Error("rejected promise"),\n\t\t\t\t\t\tactual: value\n\t\t\t\t\t})',
    "vitest.rejects.resolved",
  ),
  inHandler(
    site(
      "comparison",
      "assertion",
      "new JestExtendError(errorMessage, actual, expected, {\n\t\t\t\t\t\t\tassertionName: expectAssertionName,\n\t\t\t\t\t\t\tmeta\n\t\t\t\t\t\t})",
      "vitest.extend.async-result",
    ),
  ),
  site(
    "comparison",
    "assertion",
    "new JestExtendError(errorMessage, actual, expected, {\n\t\t\t\t\t\tassertionName: expectAssertionName,\n\t\t\t\t\t\tmeta\n\t\t\t\t\t})",
    "vitest.extend.result",
  ),
];

const RUNNER_SITES = [
  site(
    "inversion",
    "task",
    '/* @__PURE__ */ new Error("Expect test to fail")',
    "vitest.runner.fails-inversion",
  ),
];

/** `new X(...)` at a site → the same expression wrapped so the runtime marks exactly the object it constructs. */
const markEdits = (sites) =>
  sites.map((s) => ({
    from: s.text,
    count: s.ids.length,
    to: s.ids.map(
      (id) =>
        `__atlasOrigin.mark(${JSON.stringify(id)}, ${s.receiver === "none" ? "void 0" : s.receiver === "task" ? "test" : "this"}, ${s.text})`,
    ),
  }));

// chai's chain wrappers: the body of every assertion method/property runs between enter(this) and exit(), so the runtime knows
// which invocation is executing (an `expect()` created inside one is nested). No function is added to the stack. Revision 30: a
// rethrowing catch tells the runtime what left the frame (the same object is rethrown; nothing else happens there), and the call keeps
// its exact line AND column (so every stack frame of a wrapper is unchanged): `enter` and `try {` end the previous line, and
// `let result` becomes the same-length `var result` (its only declaration in that function), read after the block as before.
const frame = (before, indent, call) => ({
  from: `${before}\n${indent}let result = ${call};`,
  count: 1,
  to: [
    `${before} __atlasOrigin.enter(this); try {\n${indent}var result = ${call}; } catch (__atlasThrown) { __atlasOrigin.threw(__atlasThrown); throw __atlasThrown; } finally { __atlasOrigin.exit(); }`,
  ],
});
// One exact edit (`from` found exactly `to.length` times, each occurrence replaced in order).
const edit = (from, ...to) => ({ from, count: to.length, to });

/** The pinned modules: `path` is matched as a suffix of the loaded file's real path, `sha256` against its exact bytes. */
export const MODULES = Object.freeze([
  {
    name: "chai",
    path: "/node_modules/.pnpm/chai@6.2.2/node_modules/chai/index.js",
    sha256: "5261e5ed7e75365c2a5d832c220ff409daf704a3088b5511de34694e881d5edb",
    sites: CHAI_SITES,
    edits: [
      ...markEdits(CHAI_SITES),
      frame("      }", "      ", "getter.call(this)"),
      frame("    }", "    ", "method.apply(this, arguments)"),
      frame(
        '      flag(this, "lockSsfi", true);',
        "      ",
        "getter(_super).call(this)",
      ),
      frame(
        '    flag(this, "lockSsfi", true);',
        "    ",
        "method(_super).apply(this, arguments)",
      ),
      frame(
        "        }",
        "        ",
        "chainableBehavior.method.apply(this, arguments)",
      ),
      edit(
        "    get: /* @__PURE__ */ __name(function chainableMethodGetter() {\n      chainableBehavior.chainingBehavior.call(this);\n",
        "    get: /* @__PURE__ */ __name(function chainableMethodGetter() { __atlasOrigin.enter(this); try {\n      chainableBehavior.chainingBehavior.call(this); } catch (__atlasThrown) { __atlasOrigin.threw(__atlasThrown); throw __atlasThrown; } finally { __atlasOrigin.exit(); }\n",
      ),
    ],
    exports: ["AssertionError", "Assertion"],
  },
  {
    name: "vitest-expect",
    path: "/node_modules/vitest/dist/chunks/index.m3L2HgmY.js",
    sha256: "f56631635acaf90deb3b99e037afd8a2431ef685781ae3aa1109bb33d1d02702",
    sites: VITEST_SITES,
    edits: [
      // The two JestExtendError sites are marked from the class's constructor (below), so their construction keeps its column.
      ...markEdits(
        VITEST_SITES.filter((s) => s.text.startsWith("new AssertionError(")),
      ),
      {
        from: "const assert = chai.expect(value, message);",
        count: 1,
        to: ["const assert = __atlasOrigin.root(chai.expect(value, message));"],
      },
      // R33 (revision 30): the framework's one `result.then(handler)` call stays exactly that call, at its column, with its one
      // argument (revision 29 subscribed a second time). Its handler is edited IN PLACE: built by an arrow that captures the matcher's
      // invocation (`async`, evaluated with the arguments, after the framework's own `then` read), its body runs in that invocation and
      // records a throw as that invocation's edge; the destructuring of the result moves into the body so that a throwing result
      // getter is covered too. `async` also observes the rejection of a genuine native promise (an inert reaction, no user code).
      // Revision 31 (RC2): whether the result is an intrinsic promise is decided at the end of the line that produced it, before the
      // framework's own `typeof result.then` and `result.then` reads.
      edit(
        "const result = expectAssertion.call(state, obj, ...args);",
        "const result = expectAssertion.call(state, obj, ...args); const __atlasIntrinsic = __atlasOrigin.intrinsic(result);",
      ),
      edit(
        "return result.then(({ pass, message, actual, expected, meta }) => {",
        "return result.then(((__atlasInvocation) => (__atlasResult) => { __atlasOrigin.handling(__atlasInvocation); try { const { pass, message, actual, expected, meta } = __atlasResult;",
      ),
      // Revision 31 (RC2): no second subscription. After the handler, the call's remaining arguments are spread from `rejection()`:
      // none (a custom thenable's `then` still sees one argument), or, for an intrinsic promise, the rethrowing rejection handler.
      edit(
        "\t\t\t\t});\n\t\t\t\tconst { pass, message, actual, expected, meta } = result;",
        "\t\t\t\t} catch (__atlasThrown) { __atlasOrigin.handlerThrew(__atlasInvocation, __atlasThrown); throw __atlasThrown; } finally { __atlasOrigin.handled(__atlasInvocation); } })(__atlasOrigin.async(result, __atlasIntrinsic)), ...__atlasOrigin.rejection());\n\t\t\t\tconst { pass, message, actual, expected, meta } = result;",
      ),
      // Revision 31 (RC2): `.resolves`/`.rejects` consume their subject with `Promise.resolve(subject).then(...)`; whether that path is
      // intrinsic is decided at the end of the line before (no user code runs between), and a non-intrinsic one makes the worker opaque.
      edit(
        '\t\t\t\tutils.flag(this, "_name", key);\n\t\t\t\tconst promise = Promise.resolve(obj).then((value) => {',
        '\t\t\t\tutils.flag(this, "_name", key); __atlasOrigin.consuming(obj);\n\t\t\t\tconst promise = Promise.resolve(obj).then((value) => {',
      ),
      edit(
        '\t\t\t\tutils.flag(this, "_name", key);\n\t\t\t\tconst promise = Promise.resolve(wrapper).then((value) => {',
        '\t\t\t\tutils.flag(this, "_name", key); __atlasOrigin.consuming(wrapper);\n\t\t\t\tconst promise = Promise.resolve(wrapper).then((value) => {',
      ),
      // Both JestExtendError sites: the error marks itself when its fields are set (the runtime tells the sites apart).
      edit(
        "\t\tthis.__vitest_error_context__ = __vitest_error_context__;\n\t}\n}",
        "\t\tthis.__vitest_error_context__ = __vitest_error_context__; __atlasOrigin.extendError(this);\n\t}\n}",
      ),
      // `expect.soft` collects its failure itself, inside the soft matcher's own invocation (that is its terminal edge): an occurrence
      // in the phase the test is in. Revision 31: the soft context and the error's snapshot are taken before `processError` runs.
      edit(
        "\ttest.result.errors ||= [];\n\ttest.result.errors.push(processError(err));",
        "\ttest.result.errors ||= []; const __atlasSoft = __atlasOrigin.soft(test, err);\n\ttest.result.errors.push(__atlasOrigin.occurrence(void 0, processError(err), __atlasSoft, null));",
      ),
    ],
    exports: ["JestExtendError"],
  },
  {
    name: "vitest-runner",
    path: "/node_modules/vitest/dist/chunks/run.C5UmxDPh.js",
    sha256: "890fef0254ad442f55902adc9a7d0e639bb9ba5a78ef4fc53a30f10f1aa9f77c",
    sites: RUNNER_SITES,
    // Revision 30: the runner's phases of each attempt, its running tests and each error it collects for a test (an occurrence, with
    // the phase it was collected in). The six identical `failTask(test.result, e, ...)` statements are, in source order: the parallel
    // and sequential test hooks (onFinished/onFailed), the first try (before-try, beforeEach, body, after-try: its phase is the one
    // reached), onTaskFinished, afterEach with its cleanups and fixtures, and the fixture cleanup after aroundEach. Every insertion
    // ends a line (or follows the last argument of a call), so no runner frame of any stack moves.
    edits: [
      edit(
        "const cleanupRunningTest = addRunningTest(test);",
        "const cleanupRunningTest = addRunningTest(test); __atlasOrigin.running(test);",
      ),
      edit(
        "cleanupRunningTest();",
        "cleanupRunningTest(); __atlasOrigin.ended(test);",
        "cleanupRunningTest(); __atlasOrigin.ended(test);",
      ),
      edit(
        "try {\n\t\t\t\t\tawait runner.onBeforeTryTask?.(test, {",
        'try { __atlasOrigin.phase(test, "before-try");\n\t\t\t\t\tawait runner.onBeforeTryTask?.(test, {',
      ),
      edit(
        'test.result.repeatCount = repeatCount;\n\t\t\t\t\tbeforeEachCleanups = await $("test.beforeEach"',
        'test.result.repeatCount = repeatCount; __atlasOrigin.phase(test, "beforeEach");\n\t\t\t\t\tbeforeEachCleanups = await $("test.beforeEach"',
      ),
      edit(
        'beforeEachCleanups = await $("test.beforeEach", () => callSuiteHook(suite, test, "beforeEach", runner, [test.context, suite]));\n',
        'beforeEachCleanups = await $("test.beforeEach", () => callSuiteHook(suite, test, "beforeEach", runner, [test.context, suite])); __atlasOrigin.phase(test, "body");\n',
      ),
      edit(
        "}\n\t\t\t\t\tawait runner.onAfterTryTask?.(test, {",
        '} __atlasOrigin.phase(test, "after-try");\n\t\t\t\t\tawait runner.onAfterTryTask?.(test, {',
      ),
      edit(
        "failTask(test.result, e, runner.config._diffOptions);",
        ...[
          "test-hook",
          "test-hook",
          null,
          "task-finished",
          "afterEach",
          "fixture-cleanup",
        ].map(
          (name) =>
            `failTask(test.result, e, runner.config._diffOptions, __atlasOrigin.failing(test, ${JSON.stringify(name)}));`,
        ),
      ),
      edit(
        "failTask(test.result, error, runner.config._diffOptions);",
        'failTask(test.result, error, runner.config._diffOptions, __atlasOrigin.failing(test, "aroundEach"));',
      ),
      edit(
        "function failTask(result, err, diffOptions) {",
        "function failTask(result, err, diffOptions, __atlasFailing) {",
      ),
      // Revision 31 (RC1, C1/C2): the collection starts after the framework decided whether `err` is an array (`errors === err` reads
      // that decision back without calling `Array.isArray` again); each entry the framework iterates is snapshotted before anything is
      // serialised (`__atlasEntry`, a per-iteration constant, so a callback run later still sees its own entry); an aggregate's children
      // carry that entry as their wrapper, a plain entry is its own leaf. `e.errors.map` is still the framework's one call.
      edit(
        "\tconst errors = Array.isArray(err) ? err : [err];\n\tfor (const e of errors) {\n\t\tconst errors = e instanceof AggregateError ? e.errors.map((e) => processError(e, diffOptions)) : [processError(e, diffOptions)];",
        "\tconst errors = Array.isArray(err) ? err : [err]; const __atlasPath = __atlasOrigin.collection(__atlasFailing, err, errors === err);\n\tfor (const e of errors) { const __atlasEntry = __atlasOrigin.snapshot(e);\n\t\tconst errors = e instanceof AggregateError ? e.errors.map((e) => __atlasOrigin.occurrence(__atlasOrigin.snapshot(e), processError(e, diffOptions), __atlasPath, __atlasEntry)) : [__atlasOrigin.occurrence(__atlasEntry, processError(e, diffOptions), __atlasPath, null)];",
      ),
      edit(
        'const error = processError(/* @__PURE__ */ new Error("Expect test to fail"));',
        'const error = processError(/* @__PURE__ */ new Error("Expect test to fail")); __atlasOrigin.inversion(test, error);',
      ),
      // The file's health attestation, after every afterAll hook, cleanup and fixture cleanup of the file suite has run (or failed).
      edit(
        "\t\t\t\t\t} catch (e) {\n\t\t\t\t\t\tfailTask(suite.result, e, runner.config._diffOptions);\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t});",
        "\t\t\t\t\t} catch (e) {\n\t\t\t\t\t\tfailTask(suite.result, e, runner.config._diffOptions);\n\t\t\t\t\t} if (suite.file === suite) __atlasOrigin.attest(suite, failTask, runner.config._diffOptions);\n\t\t\t\t}\n\t\t\t});",
      ),
    ],
    exports: ["getCurrentTest"],
  },
]);

/** Every site id → `{ module, role, receiver }`. */
export const SITES = Object.freeze(
  Object.fromEntries(
    MODULES.flatMap((m) =>
      m.sites.flatMap((s) =>
        s.ids.map((id) => [
          id,
          Object.freeze({
            module: m.name,
            role: s.role,
            receiver: s.receiver,
            handler: s.handler === true,
            constructs: s.text.match(/new (\w+)\(/)[1],
          }),
        ]),
      ),
    ),
  ),
);

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The transformed source of one pinned module, or a thrown refusal. `runtimeUrl` is the file URL the instrumentation imports. The
 * import is put on the first line and everything else replaces text within its own lines, so line numbers are unchanged.
 */
export function transform(entry, source, runtimeUrl) {
  const actual = sha256(source);
  if (actual !== entry.sha256)
    throw new Error(
      `assertion-origin adapter: ${entry.name} is ${actual}, not the audited ${entry.sha256}`,
    );
  let text = source;
  for (const edit of entry.edits) {
    const parts = text.split(edit.from);
    if (parts.length - 1 !== edit.count)
      throw new Error(
        `assertion-origin adapter: ${entry.name} anchor found ${parts.length - 1} time(s), expected ${edit.count}: ${JSON.stringify(edit.from.slice(0, 80))}`,
      );
    for (const to of edit.to)
      if (to.split("\n").length !== edit.from.split("\n").length)
        throw new Error(
          `assertion-origin adapter: an edit of ${entry.name} changes its line count`,
        );
    text = parts.reduce((acc, part, i) => acc + edit.to[i - 1] + part);
  }
  const exported = entry.exports.map((name) => `${name}`).join(", ");
  return `import * as __atlasOrigin from ${JSON.stringify(runtimeUrl)}; ${text}\n__atlasOrigin.loaded(${JSON.stringify(entry.name)}, ${JSON.stringify(actual)}, { ${exported} });\n`;
}

/** What every receipt and envelope must name: the table above plus the exact bytes of every file of the adapter. */
export function adapterDigest() {
  const files = Object.fromEntries(
    Object.entries(ORIGIN_FILES).map(([name, path]) => [
      name,
      sha256(readFileSync(path)),
    ]),
  );
  const table = MODULES.map((m) => ({
    name: m.name,
    path: m.path,
    sha256: m.sha256,
    edits: m.edits,
    exports: m.exports,
  }));
  return {
    digest: sha256(
      JSON.stringify({ schema: ORIGIN_SCHEMA, files, table, sites: SITES }),
    ),
    files,
  };
}

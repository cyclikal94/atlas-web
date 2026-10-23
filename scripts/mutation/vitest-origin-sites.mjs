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
//   explicit      an explicit failure the test wrote (`expect.fail`, `assert.fail`)
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

export const ORIGIN_SCHEMA = "atlas-assertion-origin/2";
export const ORIGIN_KEY = "__atlasAssertionOrigin";
export const ORIGIN_NONCE_ENV = "ATLAS_VITEST_ORIGIN_NONCE";
/** The worker-realm registry (runtime → setup). Not a source of evidence: receipts are read from the errors themselves. */
export const REGISTRY = Symbol.for("atlas.assertion-origin/2");
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
export const DERIVED_ROLES = Object.freeze(["internal", "nested"]);

// One construction site: `ids` names each occurrence of `text` in source order (identical statements share a role).
const site = (role, receiver, text, ...ids) => ({ role, receiver, text, ids });

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
  site(
    "comparison",
    "assertion",
    "new JestExtendError(errorMessage, actual, expected, {\n\t\t\t\t\t\t\tassertionName: expectAssertionName,\n\t\t\t\t\t\t\tmeta\n\t\t\t\t\t\t})",
    "vitest.extend.async-result",
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
// which root's matcher is executing (an `expect()` created inside one is nested). No function is added to the stack.
const frame = (call) => ({
  from: `let result = ${call};`,
  count: 1,
  to: [
    `__atlasOrigin.enter(this); let result; try { result = ${call}; } finally { __atlasOrigin.exit(); }`,
  ],
});

/** The pinned modules: `path` is matched as a suffix of the loaded file's real path, `sha256` against its exact bytes. */
export const MODULES = Object.freeze([
  {
    name: "chai",
    path: "/node_modules/.pnpm/chai@6.2.2/node_modules/chai/index.js",
    sha256: "5261e5ed7e75365c2a5d832c220ff409daf704a3088b5511de34694e881d5edb",
    sites: CHAI_SITES,
    edits: [
      ...markEdits(CHAI_SITES),
      frame("getter.call(this)"),
      frame("method.apply(this, arguments)"),
      frame("getter(_super).call(this)"),
      frame("method(_super).apply(this, arguments)"),
      frame("chainableBehavior.method.apply(this, arguments)"),
      {
        from: "      chainableBehavior.chainingBehavior.call(this);\n",
        count: 1,
        to: [
          "      __atlasOrigin.enter(this); try { chainableBehavior.chainingBehavior.call(this); } finally { __atlasOrigin.exit(); }\n",
        ],
      },
    ],
    exports: ["AssertionError", "Assertion"],
  },
  {
    name: "vitest-expect",
    path: "/node_modules/vitest/dist/chunks/index.m3L2HgmY.js",
    sha256: "f56631635acaf90deb3b99e037afd8a2431ef685781ae3aa1109bb33d1d02702",
    sites: VITEST_SITES,
    edits: [
      ...markEdits(VITEST_SITES),
      {
        from: "const assert = chai.expect(value, message);",
        count: 1,
        to: ["const assert = __atlasOrigin.root(chai.expect(value, message));"],
      },
      {
        from: "return result.then(({ pass, message, actual, expected, meta }) => {",
        count: 1,
        to: [
          "return __atlasOrigin.asyncExtension(result) || result.then(({ pass, message, actual, expected, meta }) => {",
        ],
      },
    ],
    exports: ["JestExtendError"],
  },
  {
    name: "vitest-runner",
    path: "/node_modules/vitest/dist/chunks/run.C5UmxDPh.js",
    sha256: "890fef0254ad442f55902adc9a7d0e639bb9ba5a78ef4fc53a30f10f1aa9f77c",
    sites: RUNNER_SITES,
    edits: markEdits(RUNNER_SITES),
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

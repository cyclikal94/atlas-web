// Pure controls of the assertion-origin adapter's audited table and transform (WEB-14a revision 29, review r28 R31, design assessment
// C1/C3): the installed framework files are the pinned ones and instrument with every site exactly once and no line moved; any byte of
// drift or anchor mismatch refuses; the roles and digest are what the reader binds. The worker behaviour is qualified with real runs.
// Revision 30 (review r29 R31/R33): also every invocation boundary with its rethrowing catch, the single `subscribe` call (no second
// `then`), and the runner's phases, error collection and inversion.
//   node --test scripts/mutation/vitest-origin-sites.test.mjs
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  adapterDigest,
  DERIVED_ROLES,
  MODULES,
  ROLES,
  SITES,
  sha256,
  transform,
} from "./vitest-origin-sites.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const vitestDir = dirname(realpathSync(require.resolve("vitest/package.json")));
const installed = {
  chai: realpathSync(
    createRequire(join(vitestDir, "package.json")).resolve("chai"),
  ),
  "vitest-expect": join(vitestDir, "dist/chunks/index.m3L2HgmY.js"),
  "vitest-runner": join(vitestDir, "dist/chunks/run.C5UmxDPh.js"),
};
const URL_ = "file:///runtime.mjs";

test("the installed framework files are exactly the pinned ones, at the pinned paths", () => {
  for (const m of MODULES) {
    const path = installed[m.name];
    assert.ok(path.endsWith(m.path), `${m.name}: ${path}`);
    assert.equal(sha256(readFileSync(path)), m.sha256, m.name);
  }
});

test("each module instruments with every site exactly once, the runtime import on line 1, and no line moved", () => {
  for (const m of MODULES) {
    const source = readFileSync(installed[m.name], "utf8");
    const out = transform(m, source, URL_);
    const before = source.split("\n");
    const after = out.split("\n");
    // One appended `loaded` line (and the final newline); every original line keeps its number.
    assert.equal(after.length, before.length + 2);
    assert.ok(
      after[0].startsWith(`import * as __atlasOrigin from "${URL_}"; `),
    );
    for (const s of m.sites)
      for (const id of s.ids)
        assert.equal(
          out.split(
            id === "vitest.runner.fails-inversion"
              ? '/* @__PURE__ */ new Error("Expect test to fail")); __atlasOrigin.inversion(test, error);'
              : s.text.startsWith("new JestExtendError(")
                ? s.text
                : `__atlasOrigin.mark(${JSON.stringify(id)},`,
          ).length - 1,
          1,
          id,
        );
    assert.match(
      after.at(-2),
      new RegExp(`^__atlasOrigin\\.loaded\\("${m.name}"`),
    );
  }
  const chai = transform(
    MODULES[0],
    readFileSync(installed.chai, "utf8"),
    URL_,
  );
  assert.equal(chai.split("__atlasOrigin.enter(this);").length - 1, 6);
  assert.equal(
    chai.split(
      "catch (__atlasThrown) { __atlasOrigin.threw(__atlasThrown); throw __atlasThrown; } finally { __atlasOrigin.exit(); }",
    ).length - 1,
    6,
  );
  // Revision 30: every wrapper's call keeps its line and column (only `let` became the same-length `var`).
  const chaiSource = readFileSync(installed.chai, "utf8").split("\n");
  const chaiLines = chai.split("\n");
  for (const call of [
    "getter.call(this)",
    "method.apply(this, arguments)",
    "getter(_super).call(this)",
    "method(_super).apply(this, arguments)",
    "chainableBehavior.method.apply(this, arguments)",
    "chainableBehavior.chainingBehavior.call(this);",
  ]) {
    const line = chaiSource.findIndex(
      (l) => l.includes(call) && !l.includes("_chainingBehavior"),
    );
    assert.ok(line > 0, call);
    assert.equal(
      chaiLines[line].indexOf(call),
      chaiSource[line].indexOf(call),
      call,
    );
  }
  const expect = transform(
    MODULES[1],
    readFileSync(installed["vitest-expect"], "utf8"),
    URL_,
  );
  assert.equal(expect.split("__atlasOrigin.root(chai.expect(").length - 1, 1);
  // R33: the framework's one `result.then(` call stays, at its column, with the handler edited in place; no second subscription.
  const expectSource = readFileSync(installed["vitest-expect"], "utf8").split(
    "\n",
  );
  const expectLines = expect.split("\n");
  const thenLine = expectSource.findIndex((l) =>
    l.includes(
      "return result.then(({ pass, message, actual, expected, meta }) => {",
    ),
  );
  assert.equal(
    expectLines[thenLine].indexOf("return result.then("),
    expectSource[thenLine].indexOf("return result.then("),
  );
  assert.equal(
    expect.split(
      "return result.then(((__atlasInvocation) => (__atlasResult) => {",
    ).length - 1,
    1,
  );
  // Revision 31 (RC2): no second subscription and no Reflect/native `then` of our own; the intrinsic decision ends the line before, and
  // the call's remaining arguments are spread from the runtime's own-property iterable.
  assert.equal(
    expect.split(
      "})(__atlasOrigin.async(result, __atlasIntrinsic)), ...__atlasOrigin.rejection());",
    ).length - 1,
    1,
  );
  const resultLine = expectSource.findIndex((l) =>
    l.includes("const result = expectAssertion.call(state, obj, ...args);"),
  );
  assert.equal(resultLine, thenLine - 1);
  assert.equal(
    expectLines[resultLine],
    `${expectSource[resultLine]} const __atlasIntrinsic = __atlasOrigin.intrinsic(result);`,
  );
  assert.equal(
    expect.split(".then(").length,
    expectSource.join("\n").split(".then(").length,
  );
  assert.equal(
    expect.split("Reflect.apply").length,
    expectSource.join("\n").split("Reflect.apply").length,
  );
  // Revision 32 (review r31 R31): each `.resolves`/`.rejects` call opens its route at the end of the line before its own
  // `Promise.resolve` (revision 31's bare `consuming` call there did not cover assimilation; the runtime now proves it).
  for (const subject of ["obj", "wrapper"]) {
    const line = expectSource.findIndex(
      (l, i) =>
        l.includes('utils.flag(this, "_name", key);') &&
        expectSource[i + 1]?.includes(
          `const promise = Promise.resolve(${subject}).then(`,
        ),
    );
    assert.ok(line > 0, subject);
    assert.equal(
      expectLines[line],
      `${expectSource[line]} const __atlasRoute = __atlasOrigin.consuming(${subject});`,
    );
  }
  // No framework text moves and no Promise operation is added: every edited line of the two wrappers and of `recordAsyncExpect` keeps
  // the framework's text up to its last call or brace (only appended), except the returned wrapper's `onRejected` argument slot.
  const sourceText = expectSource.join("\n");
  for (const call of [
    "Promise.resolve(",
    ".then(",
    ".catch(",
    ".finally(",
    "instanceof Promise",
  ])
    assert.equal(
      expect.split(call).length,
      sourceText.split(call).length,
      call,
    );
  const at = (text) => expectSource.findIndex((l) => l.includes(text));
  const scanned = [
    [at("function recordAsyncExpect("), at("function handleTestError(")],
    [
      at('utils.addProperty(chai.Assertion.prototype, "resolves"'),
      at("function formatCalls("),
    ],
  ].flatMap(([from, to]) => {
    assert.ok(from > 0 && to > from);
    return Array.from({ length: to - from }, (_, k) => from + k);
  });
  for (const i of scanned) {
    if (expectLines[i] === expectSource[i]) continue;
    if (/return promise\.(then|catch)\(/.test(expectSource[i])) {
      const head = expectSource[i].slice(
        0,
        expectSource[i].indexOf("onRejected);"),
      );
      assert.ok(expectLines[i].startsWith(head), `line ${i + 1}`);
      assert.ok(
        expectLines[i].endsWith(
          "__atlasOrigin.receiving(__atlasRoute, onRejected));",
        ),
        `line ${i + 1}`,
      );
      continue;
    }
    const mark = expectLines[i].includes("__atlasOrigin.mark(");
    if (mark) continue; // a site wrapped by the marking edits (revision 29)
    if (expectSource[i].trimEnd().endsWith("}));")) continue;
    assert.ok(
      expectLines[i].startsWith(expectSource[i]) ||
        // the rejects site's closing line, already wrapped by its mark edit
        expectLines[i].startsWith(`${expectSource[i].slice(0, -2)}));`),
      `line ${i + 1} is not append-only: ${JSON.stringify(expectSource[i])}`,
    );
  }
  for (const [text, count] of [
    ["__atlasOrigin.consuming(", 2],
    ["__atlasOrigin.settling(__atlasRoute)", 4],
    ['__atlasOrigin.settled(__atlasRoute, __atlasStart, "matcher")', 2],
    [
      '__atlasOrigin.settled(__atlasRoute, __atlasStart, "vitest.resolves.rejected")',
      1,
    ],
    [
      '__atlasOrigin.settled(__atlasRoute, __atlasStart, "vitest.rejects.resolved")',
      1,
    ],
    [
      "throw err; } catch (__atlasThrown) { __atlasOrigin.caught(__atlasRoute, err, __atlasThrown); throw __atlasThrown; }",
      2,
    ],
    ["}); __atlasOrigin.route(promise, __atlasRoute);", 2],
    ["const __atlasRoute = __atlasOrigin.recording(promise);", 1],
    ['__atlasOrigin.operating(__atlasRoute, promise, "finally");', 1],
    ['if (isSoft) __atlasOrigin.operating(__atlasRoute, promise, "then");', 1],
    [
      'resolved = true; __atlasOrigin.operating(__atlasRoute, promise, "then");',
      1,
    ],
    [
      'resolved = true; __atlasOrigin.operating(__atlasRoute, promise, "catch");',
      1,
    ],
    ["__atlasOrigin.delivered(__atlasRoute, err);", 1],
    ["__atlasOrigin.receiving(__atlasRoute, onRejected)", 2],
    ["resolved = true; __atlasOrigin.unqualified(__atlasRoute);", 1],
    ["__atlasOrigin.softening(", 0],
  ])
    assert.equal(expect.split(text).length - 1, count, text);
  assert.equal(expect.split("asyncExtension").length - 1, 0);
  assert.equal(expect.split("subscribe").length - 1, 0);
  // The JestExtendError constructions are untouched (they mark themselves in the constructor).
  assert.equal(expect.split("new JestExtendError(").length - 1, 2);
  assert.equal(expect.split("__atlasOrigin.extendError(this);").length - 1, 1);
  assert.equal(
    expect.split(
      "\ttest.result.errors ||= []; const __atlasSoft = __atlasOrigin.soft(test, err);\n\ttest.result.errors.push(__atlasOrigin.occurrence(void 0, processError(err), __atlasSoft, null));",
    ).length - 1,
    1,
  );
  const runner = transform(
    MODULES[2],
    readFileSync(installed["vitest-runner"], "utf8"),
    URL_,
  );
  for (const [text, count] of [
    [
      "const cleanupRunningTest = addRunningTest(test); __atlasOrigin.running(test);",
      1,
    ],
    ["cleanupRunningTest(); __atlasOrigin.ended(test);", 2],
    ['__atlasOrigin.phase(test, "before-try");', 1],
    ['__atlasOrigin.phase(test, "beforeEach");', 1],
    ['__atlasOrigin.phase(test, "body");', 1],
    ['__atlasOrigin.phase(test, "after-try");', 1],
    ['__atlasOrigin.failing(test, "test-hook")', 2],
    ["__atlasOrigin.failing(test, null)", 1],
    ['__atlasOrigin.failing(test, "task-finished")', 1],
    ['__atlasOrigin.failing(test, "afterEach")', 1],
    ['__atlasOrigin.failing(test, "aroundEach")', 1],
    ['__atlasOrigin.failing(test, "fixture-cleanup")', 1],
    ["function failTask(result, err, diffOptions, __atlasFailing) {", 1],
    // Revision 31 (RC1): the framework's own decisions (`errors === err`, its loop variable, its one `e.errors.map`) feed the path.
    [
      "const errors = Array.isArray(err) ? err : [err]; const __atlasPath = __atlasOrigin.collection(__atlasFailing, err, errors === err);",
      1,
    ],
    [
      "for (const e of errors) { const __atlasEntry = __atlasOrigin.snapshot(e);",
      1,
    ],
    [
      "e.errors.map((e) => __atlasOrigin.occurrence(__atlasOrigin.snapshot(e), processError(e, diffOptions), __atlasPath, __atlasEntry))",
      1,
    ],
    [
      "[__atlasOrigin.occurrence(__atlasEntry, processError(e, diffOptions), __atlasPath, null)]",
      1,
    ],
    [
      "} if (suite.file === suite) __atlasOrigin.attest(suite, failTask, runner.config._diffOptions);",
      1,
    ],
    // Every test-level collection names its phase; suite-level ones carry none (their errors are outside every test).
    ["failTask(test.result, e, runner.config._diffOptions);", 0],
    ["failTask(test.result, error, runner.config._diffOptions);", 0],
  ])
    assert.equal(runner.split(text).length - 1, count, text);
  // Revision 31: the adapter adds no array test, prototype check or traversal of its own to the runner.
  const runnerSource = readFileSync(installed["vitest-runner"], "utf8");
  for (const text of [
    "Array.isArray(",
    "instanceof AggregateError",
    ".errors",
    "for (const ",
  ])
    assert.equal(
      runner.split(text).length,
      runnerSource.split(text).length,
      text,
    );
});

test("any drift refuses: one changed byte, a pinned hash that matches changed text, an anchor count that differs", () => {
  const m = MODULES[0];
  const source = readFileSync(installed.chai, "utf8");
  assert.throws(() => transform(m, `${source} `, URL_), /not the audited/);
  // Even with a pin updated to the changed bytes, an anchor that no longer occurs exactly as audited is refused.
  const moved = source.replace(
    'flagMsg + "Target cannot be null or undefined.",',
    'flagMsg + "Target cannot be null.",',
  );
  assert.throws(
    () => transform({ ...m, sha256: sha256(moved) }, moved, URL_),
    /anchor found 0 time\(s\)/,
  );
  // Revision 30: the wrapper anchors include the line before the call.
  const doubled = `${source}\nconst x = () => {\n      }\n      let result = getter.call(this);\n};\n`;
  assert.throws(
    () => transform({ ...m, sha256: sha256(doubled) }, doubled, URL_),
    /anchor found 2 time\(s\)/,
  );
  assert.throws(
    () =>
      transform(
        {
          ...m,
          edits: [
            {
              from: "var AssertionError = _AssertionError;",
              count: 1,
              to: ["a\nb"],
            },
          ],
        },
        source,
        URL_,
      ),
    /changes its line count/,
  );
});

test("every site has a known role and receiver; comparison sites read their assertion; the digest covers table and files", () => {
  for (const [id, spec] of Object.entries(SITES)) {
    assert.ok(ROLES.includes(spec.role), id);
    assert.ok(["assertion", "none", "task"].includes(spec.receiver), id);
    if (spec.role === "comparison")
      assert.equal(spec.receiver, "assertion", id);
    assert.ok(
      ["AssertionError", "JestExtendError", "Error"].includes(spec.constructs),
      id,
    );
  }
  assert.deepEqual(DERIVED_ROLES, ["internal", "nested", "unattributed"]);
  // Only the extended matcher's asynchronous result is made inside its handler.
  assert.deepEqual(
    Object.entries(SITES)
      .filter(([, spec]) => spec.handler)
      .map(([id]) => id),
    ["vitest.extend.async-result"],
  );
  // The review's two framework-made constructions are refusals by site.
  assert.equal(SITES["chai.instanceOf.predicate-type-error"].role, "execution");
  assert.equal(SITES["chai.property.name"].role, "precondition");
  assert.equal(SITES["chai.property.target"].role, "precondition");
  const { digest, files } = adapterDigest();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(files).sort(), [
    "loader",
    "register",
    "runtime",
    "setup",
    "sites",
  ]);
});

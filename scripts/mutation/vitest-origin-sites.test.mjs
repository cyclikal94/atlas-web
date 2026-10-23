// Pure controls of the assertion-origin adapter's audited table and transform (WEB-14a revision 29, review r28 R31, design assessment
// C1/C3): the installed framework files are the pinned ones and instrument with every site exactly once and no line moved; any byte of
// drift or anchor mismatch refuses; the roles and digest are what the reader binds. The worker behaviour is qualified with real runs.
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
          out.split(`__atlasOrigin.mark(${JSON.stringify(id)},`).length - 1,
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
  const expect = transform(
    MODULES[1],
    readFileSync(installed["vitest-expect"], "utf8"),
    URL_,
  );
  assert.equal(expect.split("__atlasOrigin.root(chai.expect(").length - 1, 1);
  assert.equal(
    expect.split("__atlasOrigin.asyncExtension(result)").length - 1,
    1,
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
  const doubled = `${source}\nconst x = () => { let result = getter.call(this); };\n`;
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
  assert.deepEqual(DERIVED_ROLES, ["internal", "nested"]);
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

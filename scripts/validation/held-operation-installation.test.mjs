// WEB-08d revision 27 (review r26 R26-N1; design assessment eff76566 Q1, Q3, Q4): the installation boundary's disk checks
// (held-operation-installation-checks.mjs), each as its own test over the real modules. The same checks run under every evaluator mutant
// in held-operation-qualification.test.mjs Q3. Revision 28: with the execution module (held-operation-execution.mjs) too.
import assert from "node:assert/strict";
import test from "node:test";
import * as applicability from "./held-operation-applicability.mjs";
import * as execution from "./held-operation-execution.mjs";
import * as installation from "./held-operation-installation.mjs";
import { installationAssessments } from "./held-operation-installation-checks.mjs";
import * as qualification from "./held-operation-qualification.mjs";

const results = [];
installationAssessments(
  installation,
  applicability,
  qualification,
  (name, ok) => {
    let outcome;
    try {
      outcome = ok() ? null : "returned false";
    } catch (error) {
      outcome = `threw ${error.stack ?? error}`;
    }
    results.push([name, outcome]);
  },
  execution,
);

test("the installation checks are a non-trivial, uniquely named inventory", () => {
  assert.ok(results.length >= 60, `${results.length} checks`);
  assert.equal(new Set(results.map(([n]) => n)).size, results.length);
});
for (const [name, outcome] of results)
  test(name, () => {
    assert.equal(outcome, null, outcome ?? "");
  });

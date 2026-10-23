#!/usr/bin/env node
// WEB-09a plan 8.12 / S-7: runs the mutation catalogue (scripts/mutation/data-catalogue.mjs) on PATCHED COPIES of the source, never
// the tree, with an unmutated CONTROL for every distinct set of tests, and asserts the number of mutants.
//
//   node scripts/run-data-mutants.mjs --out <fresh dir> [--only MU-01,MU-02] [--check] [--jobs N]
//
//   --out     a directory that does not exist yet (an existing one is refused, so a run never rewrites earlier evidence)
//   --check   only apply every patch (and fail if an anchor moved): no tests run
//   --jobs    mutants run at the same time (default 3)
//
// A mutant is CAUGHT when the named tests FAIL on it by an ASSERTION and nothing else went wrong. An unrelated crash (a test that
// throws something else, a suite that does not load) or a timeout is NOT evidence that a mutant was caught (validation policy
// VP-20261003), so each failure is classified:
//
//   assertion   an `AssertionError`, or the plain `Error` that vitest's `rejects`, `resolves` and the jest-dom matchers throw (recognised
//               by their assertion frames): the test said the behaviour is wrong
//   timeout     the test timed out
//   error       anything else the test threw (a TypeError of the mutated code, a setup failure)
//
// and, since WEB-14a revision 27 (DA-H2), every error OUTSIDE a test is counted too: a module or nested suite error (a file that does
// not load, a failing beforeAll/afterAll), an unhandled error, an error Vitest logs while shutting down. Each run is a supervised child
// (scripts/mutation/vitest-supervised.mjs) judged only from its terminal evidence envelope, and a catch must be CLEAN: any time-out or
// error beside the assertions makes it `tainted` (scripts/mutation/vitest-evidence.mjs).
//
// A mutant with an `expect` pattern (every mutant since revision 12) is caught only if one of its ASSERTION failures matches it, so the
// test that was written for the defect is the one that fails. A mutant of an earlier revision without `expect` that is not cleanly
// caught is listed by kind (`crash_only_legacy`, `tainted_legacy`): it is never counted as an assertion catch, and the list is part of
// the evidence. A mutant with `expect` that survives, fails the wrong test, is caught by crashes alone or with errors beside its
// assertions, incomplete evidence, a patch that does not apply and a control that is not cleanly passing are all failures of the run,
// and the FIRST of them stops it: nothing new starts, running mutants are joined, the rest is recorded `not_run`. A few mutants run a
// declared, narrowed selection of their files' cases (scripts/mutation/unit-selections.mjs, a recorded human decision), each against
// a control over the same selection and an exact check of the cases that ran.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE, UNIT } from "./mutation/data-catalogue.mjs";
import {
  runUnitMutants,
  unauthorisedSelections,
} from "./mutation/unit-runner.mjs";
import { AUTHORISED_MUTANTS, SELECTIONS } from "./mutation/unit-selections.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const outDir = resolve(root, value("--out", ".agtx/evidence/WEB-09a/mutants"));
const only = value("--only", "").split(",").filter(Boolean);
const jobs = Number(value("--jobs", "3"));
const check = flag("--check");

const EXPECTED_UNIT = 1540;
const EXPECTED_ENGINE = 186;

const unknown = only.filter((id) => !UNIT.some((m) => m.id === id));
if (unknown.length > 0) {
  console.error(`unknown --only id(s): ${unknown.join(", ")}`);
  process.exit(2);
}
// The declared, narrowed selections (scripts/mutation/unit-selections.mjs) apply only to the mutants their human decision covers.
const unauthorised = unauthorisedSelections(
  SELECTIONS,
  AUTHORISED_MUTANTS,
  UNIT,
);
if (unauthorised.length > 0) {
  console.error(
    `unauthorised or unknown selection(s): ${unauthorised.join(", ")}`,
  );
  process.exit(2);
}
const selected = UNIT.filter(
  (m) => only.length === 0 || only.includes(m.id),
).map((m) => (SELECTIONS[m.id] ? { ...m, selection: SELECTIONS[m.id] } : m));

const { code } = await runUnitMutants({
  root,
  mutants: selected,
  outDir,
  config: join(root, "vitest.mutant.config.ts"),
  jobs,
  check,
  expectedCount: only.length > 0 ? null : EXPECTED_UNIT,
  extraSummary: {
    expected_unit_mutants: EXPECTED_UNIT,
    expected_engine_mutants: EXPECTED_ENGINE,
    engine_catalogue: ENGINE.map((m) => ({
      id: m.id,
      title: m.title,
      spec: m.spec,
      grep: m.grep,
    })),
  },
});
process.exit(code);

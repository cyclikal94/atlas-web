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
//   assertion   an error constructed by an audited framework site AFTER the intended comparison completed with a failing outcome
//               (chai's `Assertion#assert` on an `expect()` root, Vitest's mismatch and promise-settlement sites, an `expect.extend`
//               matcher's failing result such as jest-dom's) or by an explicit `expect.fail`, bound to that test: since WEB-14a
//               revision 29 recognised only by the per-occurrence receipt the worker attaches at that site (vitest-origin-sites.mjs),
//               never by class, name, frames or text: the test said the behaviour is wrong. chai's argument validation, its wrapping
//               of an execution error, its internal precondition assertions and assertions made inside another matcher are errors
//   timeout     the test timed out
//   error       anything else the test threw (a TypeError of the mutated code, a setup failure, a matcher that crashed or refused its
//               input before comparing, such as jest-dom given `null` or chai's "Target cannot be null or undefined.")
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
//
// Every control and mutant child runs each test under the runner's fixed per-test limit (20 s, `MUTANT_TEST_TIMEOUT_MS` in
// scripts/mutation/unit-runner.mjs; Vitest's default is 5 s), so a test slowed by host load is judged by its assertions; a test's own
// explicit timeout is kept, and a test that hangs still ends as a time-out. `pnpm test` keeps Vitest's limits (docs/data-layer.md).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogueProblems,
  selectionProblems,
} from "./lib/mutation-inventory.mjs";
import { ENGINE, UNIT } from "./mutation/data-catalogue.mjs";
import { EXPECTED_ENGINE, EXPECTED_UNIT } from "./mutation/expected.mjs";
import {
  runUnitMutants,
  unauthorisedSelections,
} from "./mutation/unit-runner.mjs";
import { AUTHORISED_MUTANTS, SELECTIONS } from "./mutation/unit-selections.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// WEB-14a revision 41 (review r40 R40-TOOLS): the command line is checked before anything is claimed or started, as the accepted
// WEB-08d runner did (scripts/validation/unit-runner.test.mjs Q3/Q15), so a selection that cannot run never runs something else: an
// unknown or repeated argument, a missing value, a `--jobs` that is not a positive integer and an `--only` with an empty id are refused
// (exit 2). An unknown or repeated catalogue id stays an INVENTORY problem (exit 1, below).
function options() {
  const known = new Set(["--out", "--only", "--jobs", "--check"]);
  const takesValue = new Set(["--out", "--only", "--jobs"]);
  const seen = {};
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (!known.has(name)) throw new Error(`unknown argument ${name}`);
    if (name in seen) throw new Error(`${name} given twice`);
    if (takesValue.has(name)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--"))
        throw new Error(`${name} needs a value`);
      seen[name] = v;
      i += 1;
    } else seen[name] = true;
  }
  const jobs = Number(seen["--jobs"] ?? "3");
  if (!Number.isInteger(jobs) || jobs < 1)
    throw new Error("--jobs must be a positive integer");
  const only = seen["--only"] === undefined ? [] : seen["--only"].split(",");
  if (only.some((id) => id === "")) throw new Error("--only has an empty id");
  return {
    outDir: resolve(root, seen["--out"] ?? ".agtx/evidence/WEB-09a/mutants"),
    only,
    jobs,
    check: seen["--check"] === true,
  };
}
let opts;
try {
  opts = options();
} catch (error) {
  console.error(`run-data-mutants: ${error.message}`);
  process.exit(2);
}
const { outDir, only, jobs, check } = opts;

// Check the complete inventory before any patch or child runs, including narrowed and patch-only invocations.
const inventory = [
  ...catalogueProblems(UNIT, EXPECTED_UNIT),
  ...catalogueProblems(ENGINE, EXPECTED_ENGINE, "engine"),
  ...selectionProblems(UNIT, only),
];
if (inventory.length > 0) {
  for (const problem of inventory) console.error(`INVENTORY ${problem}`);
  process.exit(1);
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

// Revision 41: SIGINT/SIGTERM stop admission, end the running children and still write the account (exit 1); a second one is fatal.
const interruption = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => interruption.abort(signal));

const { code } = await runUnitMutants({
  root,
  mutants: selected,
  outDir,
  config: join(root, "vitest.mutant.config.ts"),
  jobs,
  check,
  interrupt: interruption.signal,
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

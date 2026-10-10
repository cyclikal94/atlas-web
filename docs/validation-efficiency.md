# Faster validation without reduced acceptance

Use the pinned Node version. Run from this repository's task worktree.

## Focused authoring, complete final review

`node scripts/run-validation.mjs .agtx/validation-commands.json` runs preflight and
focused steps, preserving logs, elapsed times, full tracked/untracked source hashes
and a ledger of deferred final/profiling steps. Add `--final` to run every stage.
Every unexpected non-zero exit stops later work. Source changes invalidate the run.
The runner never emits a phase-completion marker or decides acceptance coverage.

A task-owned plan uses argv arrays, not shell fragments:

```json
{
  "version": 1,
  "steps": [
    {"id":"anchors","stage":"preflight","requirement":"S-7 patch validity","argv":["node","scripts/run-engine-mutants.mjs","--check"]},
    {"id":"types","stage":"focused","requirement":"S-1","argv":["pnpm","typecheck"]},
    {"id":"native","stage":"final","requirement":"S-7 real-engine mutants","argv":["node","scripts/run-engine-mutants.mjs","--jobs","2"]}
  ]
}
```

This is a syntax example, not WEB-09a's complete acceptance inventory. Add the
reviewer's reproductions, controls, related regressions and all required final
checks using the task's validation plan. Preserve expected historical failures and
assert their exact expected outcomes in a separate reviewed wrapper; do not ignore
arbitrary exits. Profiling runs alone, after ordinary validation, with full samples.

## Native mutations

```sh
node scripts/run-engine-mutants.mjs --check
node scripts/run-engine-mutants.mjs --only MU-48,MU-100 --jobs 1
node scripts/run-engine-mutants.mjs --only MU-48,MU-100 --jobs 2
```

Preflight validates every selected patch before builds or browsers. Unknown IDs,
invalid engine lists and empty selections fail. Each invocation preserves a unique
`runs/` directory below `--out`, including full reports/logs and before/after input
fingerprints. There is one unmodified control build per invocation, with a passing
control required for each selected spec/grep group. Every mutant has private source,
bundle, server port, Playwright output and evidence. The default remains serial until a same-inventory benchmark qualifies concurrency;
`--jobs 1` is the serial diagnostic/reference mode. Legacy `--port` defaults to one
job and cannot be combined with parallel jobs. No failed control, missing result,
timeout or crash is counted as a successful assertion catch. Existing legacy
mutants retain their any-engine assertion rule; mutants with named assertions
retain their all-selected-engine requirement. Required final engine coverage is
still set by the plan, not by choosing a smaller `--browsers` list.

A failed mutant stops new jobs; already running jobs finish and retain evidence.
An interrupted or source-changing invocation cannot count as a complete pass.
Retain failed evidence while diagnosing; reruns create additional directories.

## Browser suites

`pnpm test:e2e:efficient` builds production and fixture once, runs the independent
appearance/chip/controls/scroll/shell specs in a separate lane, then every remaining
spec with one worker. `ATLAS_E2E_BROWSERS=all` retains the three-engine selection.
The complement includes newly added files automatically. Use
`node scripts/run-e2e-efficient.mjs` when the exact source has already been built.
The caller must prove build applicability; this command is not a persistent cache.
`ATLAS_E2E_WORKERS=1` is the initial serial default. Set it to 2 for an
equivalent-scope benchmark; 2–4 are available, but raise concurrency only after measuring the same inventory.

Timing-sensitive, multi-tab, backend integration and profiling tests remain serial.
An investigation of a flaky UI case uses ordinary Playwright with `--workers=1`,
not the fast lane. New-case and affected-engine repetition minima stay unchanged;
120 repeats required on one affected engine does not imply 120 on every engine.
No production timer or duration assertion has been shortened. Screenshots/data
evidence include project, test ID, repeat and retry where concurrent runs need it.

A short benchmark qualifies the runner only for its selected sample. It cannot
prove the whole suite is stable or provide a guaranteed total speed-up. Record
machine load, browser versions, exact source and selected inventory. Keep these
runs separate from profiling and active flake investigations.

## Reuse and adoption

Even with `--jobs 2`, only E-A3 adapter conformance jobs may overlap. Every other
control/mutant runs behind a barrier, with no competing jobs from this runner.

The control bundle is reused within one fingerprinted invocation only. Reuse across
revisions still requires preserved source/dependency/harness/browser/environment
provenance and an affectedness assessment. A matching log hash or unchanged Git
HEAD is insufficient, particularly while deliverable files are untracked.

Apply this patch at an idle authoring boundary; do not edit active run inputs.
Include runner changes in independent review. These tools do not accept WEB-09a,
change task ownership, or waive later backend/device/release checks.

## Evidence preservation EH-20261005

Ordinary Playwright invocations now allocate a fresh directory beneath
`.agtx/evidence/browser/runs/`. `ATLAS_EVIDENCE_DIR` selects the parent, not a
reusable output directory. Global setup prints the actual directory and shares it
with every worker. Browser JSON records and helper screenshots include the
project, test, repetition and retry; duplicate logical records fail without
replacing the first file. Screenshot APIs receive a path inside an exclusively
reserved directory. Allocation manifests are not evidence of a passing check.

Default Playwright traces/results are inside that invocation directory. Explicit
`--output` remains supported only for a fresh directory; an occupied or already
claimed destination is refused during configuration, before Playwright can delete
it. Use a new destination for a rerun. Failed and interrupted invocations remain
available, and CI uploads the new browser evidence tree on failure.

Older/custom configs that import these evidence helpers without this global setup
get fresh worker-local directories for JSON records and screenshots. Their own
Playwright output configuration is still their responsibility. The repository
configuration's guard applies to normal Playwright commands and older launchers
that use it, including when they set `ATLAS_EVIDENCE_DIR` or `--output`.

The specialised profiling, session-matrix and build-report programmes have
separate aggregate formats and fixed paths. This change does not migrate their
producers/readers. Continue the existing copy-and-hash preservation protocol before
those commands; record the backup location and compare afterwards. Do not present
this browser safeguard as protection for arbitrary file writers.

Run `pnpm test:validation-tools` for actual Playwright runner preservation checks
(no browser fixture by default), duplicate-write refusal, warnings and forced
failure/process cleanup. For a small real Chromium screenshot and failed-trace
check, run:

```sh
ATLAS_EVIDENCE_BROWSER_SMOKE=1 node --test scripts/validation/evidence.test.mjs
```

This smoke checks the tooling only. It does not replace product, native engine,
profiling, device or integration acceptance and does not qualify parallelism.

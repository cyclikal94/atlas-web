# Validation throughput — VT-20261008

Kieran authorised the first implementation group on 8 October: pool expensive
single-pass checks and prevent avoidable validation restarts. This package does
not cache browser results, narrow the affected selection, change repetition
requirements or accept WEB-09a. It is staged separately from active work.

## One authoring campaign

Build the complete version-2 plan before running it. Invoke the shared driver
once, with qualification and focused steps in that plan. The existing stage
barrier moves directly from passing qualification to focused work. A failure or
source edit prevents broader execution. Final and profiling steps remain deferred
unless `--final` is explicitly requested.

Do not run a qualification-only copy and then start the complete plan from the
beginning on unchanged inputs. If an edit is necessary after qualification, the
new source requires fresh applicable checks. This package does not resume a dead
process or reuse qualification/browser evidence across invocations. That would
require the separate evidence-reuse proposal and is outside this change.

Use the literal `${RUN_DIR}` in structured argument or environment paths:

```json
{
  "id": "native-focused",
  "stage": "focused",
  "requirement": "The selected browser regressions",
  "argv": ["pnpm", "exec", "playwright", "test",
    "tests/e2e/fixture.example.spec.ts", "--workers=1",
    "--output", "${RUN_DIR}/native-focused/output"],
  "env": {"ATLAS_EVIDENCE_DIR": "${RUN_DIR}/native-focused/evidence"}
}
```

The driver expands the token into its newly allocated run directory under
`.agtx/evidence`. Use the same token for a later structured argument reading that
artefact. Do not embed it in shell or JavaScript source strings. Keep source probe
and fixture paths unchanged. Each step needs its own browser output directory.
The requested plan, expanded plan and path mapping are saved together. Existing
occupied `--output` paths or claim files are rejected before any qualification
work, as are overlapping declared output destinations between steps. Earlier
evidence is never deleted to permit a rerun.

If another step consumes a declared browser output, evidence directory or JSON
report through a structured argument/environment path (including a parent
directory that contains it), the producer stays local
with a recorded dependency reason. An explicitly pooled producer with such a
consumer is refused before qualification. Pooled artefacts remain in the pool's
per-attempt directories; discover them through routing/result receipts, not the
original `${RUN_DIR}` destination. Undeclared outputs and paths embedded inside
scripts cannot be inferred: use a justified local constraint or an explicit
pool-evidence collection step for those dependencies.

## Single-pass browser routing

The new driver enables the router's throughput policy. Existing drivers retain
their previous policy until the bundle is adopted. Recognised ordinary fixture
commands are inventoried even when their repetition count is one. An automatic
single-pass selection with fewer than 12 case/browser entries stays local to
avoid remote setup overhead. This is a conservative size heuristic, not a
guaranteed runtime estimate. Explicit `routing.mode = "pool"` can route a smaller
but measured-expensive selection.

For larger single-pass selections, each selected browser receives **all selected
files together**, with one worker, one execution of each case and zero retries.
Only engines run in parallel; file selection and within-engine serial execution
remain intact. Dependency installation and fixture build happen once per engine.
The controller's exact inventory must match the worker's inventory and results.
Repeated and native-mutation grouping is unchanged.

On macOS, automatic single-pass routing defaults to `darwin` for every browser.
Linux applicability still requires an explicit requirement-specific platforms
mapping and basis. Existing macOS regression history cannot be weakened. A
different native runner remains subject to the existing pinned-runtime checks
and independent evidence review. Profiling and production/backend integration
keep their original runners. Unknown launchers, flags and meaningful environment
changes retain their existing refusal/exception rules.

Explicit local exceptions in the new driver require both a specific reason and
`routing.constraint`: `controller-specific`, `timing-sensitive`, `specialised`
or `small-selection`. A multi-spec fixture selection cannot use `small-selection`.
"Single pass" alone is not a reason to reserve an expensive selection to the
controller. This declaration remains reviewable; it is not proof that a command
is cheap. Availability fallback before submission is still automatic and logged.
Once work is submitted, failure or uncertainty never triggers a silent local
rerun. Offline runners keep the existing bounded fallback behaviour.

## Adoption and qualification

The frontend bundle changes only the shared driver, adds the campaign helper and
this usage guide. The scheduler applies it at an idle boundary into Running after
the existing reliability package. The new receipt is
`.agtx/validation-throughput-adoption.json`; all earlier receipts and reports
remain intact. Hash or lifecycle drift stops adoption. Successors can recognise
exact committed inherited tooling without rewriting accepted source.

The first author after adoption reconciles existing plans: replace fixed output
prefixes with `${RUN_DIR}`, use one complete plan, and supply justified local
constraints or let fixture selections use the pool. Reviewers reconcile adoption
inventories before establishing their baseline; they do not install the bundle.

The orchestrator changes require the existing independent-review and committed-
input gates. Activate only when there are no live pool requests, because workers
bind the tool hashes. Do not interrupt WEB-09a to adopt or benchmark this package.
Before activation, validate the exact grouped selection on a frozen source,
compare original and partitioned inventories and verdicts, and retain known-
failure checks. Measure elapsed setup and execution separately. A representative
end-to-end before/after benchmark is required before claiming an hours-saved
estimate; a small smoke test is not that benchmark.

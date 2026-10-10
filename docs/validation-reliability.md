# Validation reliability — VR-20261007

Kieran authorised these improvements on 7 October 2026. Product requirements,
repetitions, native-browser coverage, mutation verdicts and independent acceptance
remain unchanged. WEB-09a's active review is not modified or interrupted.

## Order new validation work first

The shared driver accepts version 2 plans. Authors reconcile existing plans before
using the new driver. Inventory changed tests/fixtures in `qualification.changed_files`.
For those changes, supply early `qualification` steps with `qualification_kind`
`control`, `case` and `mutation`: passing unmodified controls, the new/changed cases,
and the specific faults those cases must catch. Add a bounded `stability` diagnostic
when investigating a fixture race; state its purpose and stopping rule. Broader work
starts only after these steps pass. Do not fill these entries with whole catalogues.
An empty changed-file list requires a reason which the reviewer checks against the
source diff. This is an explicit declaration, not an automatic affectedness proof.

Stages are preflight, qualification, focused, final and profiling. Optional `after`
step IDs impose dependencies within those stage barriers. Cycles, backwards stage
dependencies and unmet prerequisites fail before broad execution. A failed check
stops new work; deferred and not-run checks never count as passed.

```json
{
  "version": 2,
  "qualification": {"changed_files": [], "no_changes_reason": "Static checks of unchanged test inputs"},
  "steps": [{
    "id": "types", "stage": "focused", "argv": ["pnpm", "typecheck"],
    "requirement": "Type safety",
    "reuse": {"kind": "pure", "basis": "Static compiler with complete local inputs",
      "runtime_files": [], "artifacts": []}
  }]
}
```

## Reuse and exact duplicates

Reuse is opt-in for audited static commands only: `pnpm typecheck`, `pnpm lint` and
`pnpm check:contract`. Matching checks within or across invocations share intact
successful evidence. Keys bind the whole Git source inventory (including untracked
non-ignored source), environment, command, installed dependency content and symlink
resolution graph, actual Node/pnpm/Corepack payload, OS/host and declared ignored
runtime files. Runtime inputs are rechecked after execution. Missing provenance
means a fresh check, not a passing result. Declared generated artefacts and the
original log must still exist and match their hashes. Every reused record points
to the original evidence and retains its own requirement mapping. A later failed
execution invalidates that key. No old evidence is imported as trusted automatically.

This deliberately does not infer unaffected source subsets or merge partially
overlapping test commands. Test/browser/mutation/integration/repetition/profiling
results always run; final and qualification stages never use the cache. The whole
source key is conservative: a fixture edit invalidates static-check reuse too.
This is an initial safe implementation, not permission to skip final acceptance.

The driver assigns owned temporary directories to local children without putting
controller paths into pool applicability metadata. Process-group shutdown precedes
removal. Pool workers use short private `/private/tmp/atlas-r-*` directories on macOS and `/tmp/atlas-r-*` in Linux containers, with ownership receipts under `.runner-input`. These avoid Unix-socket path limits and stay outside the source index. Native cleanup verifies owner, host and inode after collection; container teardown removes container temporary files.

## Shared fixture barriers

`tests/e2e/data-operation-barriers.ts` distinguishes invocation from durable commit
and wraps peer creation with existing-page readiness checks. The E-O10 spec uses
these shared helpers. Assertions, timeouts and observation windows are retained;
there are no added fixed sleeps. The existing settled-tree helper remains authoritative.

## Storage

Every runner readiness check holds its existing capacity lock. It removes at most
one acknowledged completed job's disposable dependencies/build/temp trees, retaining
source, source archives, all evidence and every failed or uncertain job. Captured
source beneath a generated-looking directory prevents its removal. A persistent
cursor prevents a malformed/retained job starving later cleanup. The controller
publishes an atomic acknowledgement only after collecting and validating passing
evidence. Live worker PIDs and locked runners prevent cleanup. Remote timeouts
retain files and use existing bounded fallback. Cleanup does not change verdicts.

Admission reserves 20 GiB on the runner; a capacity rejection before any test is
an infrastructure rejection eligible for another host. Existing historical jobs
without collection acknowledgements remain retained. This does not prune Time
Machine snapshots or unrelated system temporary files automatically.

## Repeated review findings

Reviewers append `<!-- ATLAS_FINDING_FAMILY: stable-mechanism-name -->` beside each
finding, and classify it as new, incomplete_fix, regression or harness. Reuse family
IDs from earlier reviews. For historical reports, repeated named implementation
files in finding sections conservatively trigger investigation; overlap is not a
claim that the underlying defects are identical.

After two consecutive failed reviews match, the supervisor keeps the card in
Review and launches one pinned Codex source-only design assessment before resuming
Claude. It preserves the original failed verdict. The assessor traces all callers,
tabs/reloads/failure paths and supplies a correction plan, invariants and focused
qualification matrix. No full test campaign is requested. Only a matching launch
receipt, result token, idle agent and unchanged protected inputs complete this step.
The next author must reconcile that plan before coding. This neither accepts the
task nor limits revisions. Genuine product/scope questions retain existing human gates.

## Roll-out

The source lives in a separate orchestrator checkout while WEB-09a reviews. A new
immutable bundle supersedes the driver only at an idle transition into Running;
review phases are not patched. Prior routing/adoption receipts remain unchanged.
The bundle refuses source drift and preserves original files and complete before/
after inventories. Future frontend tasks use the same policy and adoption path;
backend tasks receive sequencing/design-assessment guidance without frontend files.

Source must pass independent review and the committed-input gate before activation.
An active pool request binds its tool hashes, so pool tooling is deployed only when
there are no active requests. Healthy task sessions are never restarted to install it.

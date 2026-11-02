# Sync measurements: the `WEB-09a:sync-profiling` hand-over (WEB-09c)

*WEB-09c, 10 October 2026 (acceptance scope revised 12 October 2026). UK English. For the authors of BE-B1 and BE-Q23, and for WEB-09b and WEB-09d. The evidence
key is unchanged; WEB-09c has owned it since the WEB-09a closure (BC-20261009). Every figure here was measured on ONE macOS developer machine with Playwright's
desktop engines (Chromium, Firefox, WebKit): it is desktop-scoped evidence. None is a pass mark and none stands for a device class. The physical-device
measurements are WEB-09d's and have not run (STAGED-ACCEPTANCE-20261011, which supersedes the timing of OD-1); missing phone and tablet results alone no longer
block BE-B1/BE-Q23 scoped technical completion, but those cards still need the reviewed desktop hand-over of the final programme and their own backend checks.*

> **Status after review 1 (revision 1, 10 October 2026).** The figures below come from attempt 4, and **none of them is an isolated measurement**. The isolation
> labels first published with them judged each row by when it was written out, not by when its figures were collected, so they are withdrawn (review finding R1).
> Under the corrected method (every row judged over the test that collected it, with the load sampled every 5 s throughout each stage), attempt 4 has no isolated
> series: its rows carry no collection window, and every one of its stages had other cards' heavy work in it. Its hand-over also predates the completeness inventory
> (R2) and the device page's W2 route (R3), so the corrected validator refuses it. The record of reference for BE-B1 and BE-Q23 will be the hand-over of the isolated
> final run (`handoff/report.md` and `results.json` there state the completeness and isolation of every figure). Until then, use the figures below as indicative
> desktop observations only. The admission outcomes, shapes, bytes and hashes do not depend on isolation and stand.
>
> **Status after review 2 (revision 2, 10 October 2026).** Review 2 and the independent design assessment found that the shell boot escaped the isolation check
> (R1), that case completion still stood in for measurement completeness and a timed-out W7 control counted as a refusal (R2), and that the browser RSS left out
> macOS WebKit's renderer (R4). Revision 2 replaces the completeness predicate with a finite **evidence contract** (`scripts/lib/profile-contract.mjs`: 796
> required cells, each resolved against the evidence itself), binds every load-dependent cell to its own stage's load samples (the shell's 24 runs included),
> carries the evidence inside the hand-over so the validator resolves it again, and attributes WebKit's WebContent, Networking and GPU processes through its host's
> launchd PID domain. **Every RSS figure of attempt 4 below is descendant-only**: for WebKit it omits the renderer and is withdrawn as browser memory; for
> Chromium and Firefox it is indicative only. No figure below is current-tree evidence; the final run's hand-over is.
>
> **Status after review 3 (revision 3, 10 October 2026).** Review 3 found that the contract still accepted observations by their cardinality alone (60 null quota
> outcomes, empty ladder rows and retirement conditions, a per-run memory peak disagreeing with its series) and that the hand-over's published figures were not
> reconciled with its evidence (R2), and that the device page let a manual run collect beside an active protocol and could not restore a lost tab's capture (R5).
> Revision 3 makes the contract (version 2) check every observation's **contents** and recompute every derived figure from its retained support, builds every
> field of `results.json` and `report.md` by one **projection** of the carried evidence that the validator repeats field for field, and gives the device page **one
> collector per origin** with owner-only restoration of the pinned capture. Version-1 evidence (every attempt so far) resolves incomplete under version 2: it lacks
> the support the contract now recomputes from, and stays history, unchanged.
>
> **Status after review 4 (revision 4, 10 October 2026).** Review 4 found that a correctly hashed capture that was not a sync page (`null`), or whose 199
> checklist fields were empty, still made the hand-over complete (R2), and that a manual collection whose tab was lost could not be taken over, cleared or
> recovered (R5). Revision 4 reads every W2 capture's **contents** with one observer (`scripts/lib/profile-w2-capture.mjs`, used by the writer, the contract
> and the device validator): a valid sync page whose one batch holding the seeded person is that person and its 199 distinct checklist fields of 100 items and 40
> checked ids each; the device validator accepts a capture's hash only after certifying it from its hand-over. The device page gives the protocol **and** a
> manual collection one recorded recovery (take-over or the owner's own), records a reserved attempt once as `killed` and never runs it again, resolves every
> action against a chosen collection, and stops a run's engine whatever its observation throws. Nothing in the contract's evidence format changed; every
> historical measurement stays history.
>
> **Status after review 5 (revision 5, 11 October 2026).** Review 5 found that the observer still certified a capture whose BYTES production refuses but whose
> parsed form looked right (a duplicated page or batch key, a revision written `12e0`), so such a hand-over could still be complete (R2), and that H9 still said
> this client sends no snapshot, which stopped being true when production leadership was merged (R6). The design assessment added that production's nesting,
> element-size and element-node gates were never applied (a companion batch included) and that the writer read the capture with `Response.text()`, which drops a
> byte order mark and replaces invalid UTF-8 before anything is hashed. Revision 5 puts every capture, as its bytes, through the **candidate's own receive path**
> (`scripts/lib/production-page-reader.mjs` loads `scan.ts`, `validate.ts` and `config.ts` of the candidate: the response bound, the byte scan, every element's
> decoder and gates) before any W2 check, in the writer, the contract and both validator modes alike; a refused capture yields no page figures and no target, and
> the reader refuses to start (so nothing is certified) if it cannot load those modules or the production decode composition changes. The writer now keeps the
> response body's exact bytes (`tests/e2e/profile-sync-read.ts`), and the cold replays and the device page's store give them back unchanged. H9's snapshot answer
> is read from the candidate's source (`scripts/lib/profile-source-facts.mjs`), checked again by the validator against its own candidate, and kept apart from what
> the programme measured (no production snapshot). The final programme runs against the candidate's pinned backend, now **v0.28.0-rc.1** (main's API 0.28 merge);
> every 0.27.0-rc.1 figure below is history.
>
> **Status after review 6 (revision 6, 12 October 2026).** Review 6 found that the generated hand-over still made physical-device results a prerequisite of
> BE-B1/BE-Q23 technical completion ("the BE-B1/BE-Q23 measurement gate remains held until the roster runs"; OD-1's "BE-B1/BE-Q23 remain blocked"), which
> STAGED-ACCEPTANCE-20261011 (Kieran, 11 October 2026; `delivery/handoffs/staged-acceptance-20261011.md`, SHA-256 `ed8bc85b…c1ca3`, authority
> `approval/staged-acceptance-20261011.json`, `812002ba…a63`) superseded (R7). Revision 6 makes the hand-over state its **acceptance scope**
> (`results.json` `acceptance_scope`, and a report section) in the decision's three parts: what its desktop evidence can support (only a complete, isolated
> programme with no failure, and only once an independent review accepts the hand-over, together with each backend card's own checks; otherwise nothing), the
> physical-device rows transferred to WEB-09d (BE-B1 items 2 to 7, BE-Q23 M1, M2, M4, M5, M7 to M9; not run), and the choices that need a person (the roster;
> any material contract or product choice the desktop evidence cannot settle). Failures, failed controls and invalid evidence are listed as held. A generated
> hand-over records no review and no acceptance. The validator checks this scope against the decision as it pins it, independently of the projection. OD-1 is
> kept as the decision of record for the desktop scope and the roster's open items, its timing labelled superseded. The statements earlier in this document and
> in the earlier reports are kept as they were written.
>
> **Status after review 7 (revision 7, 12 October 2026).** The first complete Air attempt after revision 6 (request `profile-20261012-195422-1b32a3d1`) failed
> its P-1 bundle budgets: production 169,656 B and fixture 338,980 B initial JS gzip, both **development** builds (R8). Loading the production page reader
> resolves a serve-mode Vite configuration, which sets an unset `NODE_ENV` to `development` on the process; the driver imports the reader before anything
> else, so its `pnpm build` and `build:fixture` (and its browser stages and preview server) inherited it. Revision 7 restores the process environment after
> the reader's loads, whether or not they succeed, and refuses to start if it cannot; a `NODE_ENV` the caller supplied is kept unchanged. Each build record
> (`bundle/build-production.json`, `bundle/build-fixture.json`, `fixture-build.json`) now states the `NODE_ENV` the build was given (`null` when absent).
> `scripts/validation/profile-build-environment.test.mjs` checks the public import chains and the driver's two build paths from an environment with and
> without `NODE_ENV`, and the bundle stage's real builds and budgets without it. The failed attempt is kept as a failed attempt: it measured nothing, and
> the budgets that caught it are unchanged.
>
> **Status after review 8 (revision 8, 12 October 2026).** The complete Air programme after revision 7 (request `profile-20261012-211000-fb04d06e`) ran every
> stage and all 57 functional cases passed, but its strict validation refused it: **113 of 796 cells were not isolated** (112 contention cells and WebKit's
> P-10 sync-page cell, all `idle_foreign`), so it supports no desktop decision (R1). Two attribution boundaries were wrong. The nested contention driver
> sampled from its own pid, so the launcher's `caffeinate -is` helper (a child of the programme's process) counted as a foreign sibling; and the transport's
> status reader (`python3 - <job>`) counted as heavy work because its data argument names an `atlas-runner` directory. Revision 8 makes the invocation's
> **isolation context** explicit: the evidence claim records the invocation, the canonical evidence directory and the root process by pid **and start**;
> every sampler attributes by that root, a nested driver takes the context only after proving the root is its live ancestor, and the stage owner still governs
> the sampler's lifetime. A process outside the tree is **support**, not foreign, only when the launcher's support pin (`ATLAS_PROFILE_SUPPORT`) names its
> exact command, its script's SHA-256 and a maximum age; no interpreter, path or spelling is exempt by itself. Every sample now records its context and the
> identities behind its verdict (whole foreign commands, support records, the own tree), and the contract (version 3) refuses samples that are not bound to
> their stage's context. Whether the status reader is recognised depends on the transport supplying that pin, a change for its tooling owner. The failed
> package stays failed; its P-1 and P-1S cells (all `ok`) are used below, as labelled component observations, for the budget successor (C11).
>
> **Status after review 9 (revision 9, 13 October 2026).** The complete Air programme after revision 8 (request `profile-20261013-013915-cf05e051`) was
> isolated (387 of 387 judged cells clean) and structurally complete, but two WebKit cold runs (P-11 W4 run 2, P-W2 run 5) recorded `refused` with the state
> `running`: they were not refusals (R2). The cold-run helper took any state but `running` or `not_started` as the end, which includes the engine's own
> `waiting` before its first step, then read the state again and called whatever it saw then a refusal. Revision 9 observes once. The fixture harness keeps
> every state the engine publishes, in order, with its trace position; the observed operation is the measured request (the first `running` after the run
> begins), and its outcome is the state the engine showed when that request's step ended (`data.sync_next`, following a page with `has_more`). The run keeps
> that observation. `admitted` needs the served page's applied commit (its bytes) and idle; `refused` needs the engine's own refusal (stopped, backing off,
> paused, or waiting for a valid cache); anything else is an `error`, and the scan and commit figures are the measured page's first commit. The live W2
> application keeps the one evaluation that found its end. The contract (version 4) checks every recorded outcome against its observation, and P-11 and W2
> fail their stage on an error or time-out after writing every run, so a programme stops there. The two runs stay failed in that package; nothing in it is
> reclassified, and it supports no desktop decision.
>
> **Status after review 10 (revision 10, 13 October 2026).** Review 10 found revision 9's corroboration optional: a cold record whose first commit had no
> bytes, whose terminal state was the request's own entry or preceded it, or whose step failed but ended idle still resolved as an admission, and a live
> dense commit of zero or invented size, absent from the retained trace, did too, so each could derive desktop support (synthetic diagnostics; no Air
> programme ran on revision 9). The design assessment added device results whose engine detail contradicted their outcome. Revision 10 makes the evidence
> required (contract version 5, below); no measurement was taken under version 4, and no figure here changes.
>
> **Status after review 11 (revision 11, 13 October 2026).** Review 11 found the live W2 witness's terminal state never related to the step end of the same
> observation: replacing only the idle step end in the retained trace by a stopped, failed or running end, every commit unchanged, still resolved as an
> admission and supported the desktop decision (synthetic diagnostics; no Air programme ran on revision 10). Revision 11 corroborates the live terminal state
> with the step end that completes the observation (contract version 6, below); no measurement was taken under version 5, and no figure here changes.
>
> **Status after review 12 (revision 12, 13 October 2026).** Review 12 found that cold and device admission accepted a measured commit that wrote no page:
> `kind: "applied"` is the transaction's result, and the page plan's own result can be `not_ready` or `lease_lapsed`. After a lapsed hold the engine asks
> again without publishing anything, so the stub's later empty page committed and published idle, and that idle was taken as the measured workload's
> admission; P-2 took the retry's timings, and P-4/P-10 could pair a step with another request (synthetic diagnostics and a source assessment; no Air
> programme ran on revision 11). Revision 12 binds every admission and timed sample to its own operation (contract version 7, below); no measurement was
> taken under version 6, and no figure here changes.
>
> **Status after review 13 (revision 13, 14 October 2026).** Review 13 found that revision 12's P-4/P-10 sync sampler still let an earlier step that ended
> without a request (a local-storage stop, an offline or session gate) donate its start to a later step's request and commit (synthetic schedule: a 92 ms
> pre-issue instead of 2), and that its three selected lines let no consumer see the end in between; the design assessment also found the P-4 draft path
> taking the FIRST send of a retried draft. Revision 13 retains each sample's bounded witness and derives the operation from it in the writer and again in
> the consumer (contract version 8, below). No measurement was taken under version 7, and no figure here changes.
>
> **Status after review 14 (revision 14, 15 October 2026).** Review 14 found revision 13's P-4 draft sample closed on a later, unfenced queue read: any
> status but queued/in-flight passed, so a read that threw, a replacement page's empty queue and a row a later retry acknowledged each completed the first
> attempt and supported the desktop decision (synthetic actual-collector diagnostics; no Air programme ran on revision 13). Production emits the answer event
> BEFORE it awaits the receipt transaction, so the answer is not the end of the operation. Revision 14 closes each draft sample on the observed dispatcher's
> own admitted receipt of that draft, with the binding checked across every await (contract version 9, below). No measurement was taken under version 8,
> and no figure here changes.
>
> **Status after review 15 (revision 15, 15 October 2026).** Review 15 found that the consumer still accepted contradictory completion records (a receipt
> result that omitted its service, named another plan or epoch than its call, carried no time or a time after the completion read, and a completion read
> timed before the enqueue all completed the sample and supported the desktop decision in an otherwise complete synthetic package), and that a stage
> whose load sampler died after readiness sealed `exit_status: 0` and let the next stage start. Revision 15 checks every dispatch record against its kind
> and every result against its call, requires one ordered interval and the receipt's result before the completion read's recorded start
> (`draft-request-sample/3`, contract version 10, below), and makes a stage's status the reduction of its action and its required sampler. No
> measurement was taken under version 9, and no figure here changes.
>
> **Status after review 16 (revision 16, 16 October 2026).** Review 16 found the sync counterpart unchecked: a sync witness whose read was timed before its
> mark, whose mark and read times were both missing, whose step end was traced before its tick, or whose one entry was named `/not-sync` still completed
> its sample and supported the desktop decision in an otherwise complete synthetic package (P-4 and P-10, all three engines). The design assessment added a
> whole witness translated earlier in time and a draft whose request, result and entry agree on another endpoint. Revision 16 closes each sync sample's
> observation interval and requires the exact endpoint pathname for both request kinds (`sync-request-sample/3`, `draft-request-sample/4`, contract
> version 11, below). No measurement was taken under version 10, and no figure here changes.
>
> **Status after review 17 (revision 17, 22 October 2026).** Review 17 found two further draft omissions: a selected `/commands` entry that had finished
> before the dispatcher's observed call began still completed its sample, and the timing read's buffer total was never checked (missing, zero below its one
> counted request, or full while the later total was 1), nor the completion read's total against its retained entry. Each still supported the desktop
> decision in an otherwise complete synthetic package (all three engines). Revision 17 binds the entry to its call causally and validates both buffer
> snapshots as one uninterrupted buffer (`draft-request-sample/5`, contract version 12, below). No measurement was taken under version 11, and no figure
> here changes.
>
> **Status after review 18 (revision 18, 24 October 2026).** Review 18 found that P-2 skipped each WARM-UP before validating that iteration's own page: a
> warm-up whose admission rounds all lapsed (`applied/lease_lapsed`) was followed by the engine's empty retry reaching idle, and the collection carried on.
> Its support named measured samples only, so an otherwise complete package (all three engines) still resolved 796 cells and supported the desktop
> decision. Revision 18 validates every iteration, warm-ups included, and keeps the whole collection with its first failure (`p2-sample/2`, contract
> version 13, below). No measurement was taken under version 12, and no figure here changes.
>
> **Status after review 19 (revision 19, 26 October 2026).** Review 19 found that the P-2 rule checked each iteration's frames and trace positions but
> not the trace's times: a read claiming to end before the commit it retains, a mark after that commit, a step end timed before its commit and a negative
> commit time each still resolved 758 ok + 38 unavailable cells and supported the desktop decision, and the actual writer accepted an edited read on all
> three engines. Revision 19 holds every line of an iteration's slice to its own observation (`p2-sample/4`, contract version 15, below). This was an
> evidence-integrity defect under labelled witness corruption, not an observed browser-clock failure. No measurement was taken under version 14, and no
> figure here changes.

## Segmented delivery: the tuning and overhead hand-over (BOUNDED-SYNC-PAGINATION-20261027)

*28 October 2026. This section answers the smaller, decision-focused package that the newer authority asks for
(`approval/bounded-sync-pagination-20261027.json`, SHA-256 `d1298d3e…370b58`; hand-over `delivery/handoffs/bounded-sync-pagination-approved-20261027.md`,
SHA-256 `43ba7d9f…a0d9d`). Finer pagination is implemented as a safeguard; the measurements choose practical settings, they do not decide whether it may exist.
The legacy programme below is historical and its open items are NOT passed. The client half is described in `docs/data-layer.md`, "Segmented delta delivery".*

**What is measured, and how.** `tests/e2e/fixture.profile-segments.spec.ts` (runs only with `ATLAS_SEGMENT_SWEEP=<dir>`): the PRODUCTION engine, plans and session
wrapper in Chromium, Firefox and macOS WebKit, with `/sync` STUBBED by a server that answers BE-Q23's PROVISIONAL contract by splitting exact, hashed fixture bytes.
Workloads: W1 (the approved 800 x 100-item checklist batch, 6,108,899 bytes, SHA-256 `dfb06a8f…df56e6`) and R201 (one person ancestor and 200 dense checklist fields,
the ancestor repeated at the head of every segment and counted against the budget, as BE-Q23's closure rule requires). Predeclared sweep: `max_changes` 4, 25, 100,
200 and whole-batch delivery; five cold runs per cell; per run the request count, the engine's span from its first tick to the activation, each page's bytes, scan and
commit milliseconds (the engine's own trace), and in Chromium only the sampled JS heap high-water mark above the idle page (a 20 ms sample of the whole heap,
garbage included: an upper indication, NOT a per-segment memory figure). Host load is recorded at the start and end of every run.

**Status of the figures: NOT tuning evidence yet.** The only runs so far are one-run smoke cells (4, 100, whole) of the qualification plan
(`.agtx/evidence/WEB-09c/pagination/plan-run-5`), taken on this shared machine with a one-minute load of about 9 to 11 from other cards' work. They show the tool works
and the shape of the result; they settle nothing. The full sweep must run on an exclusive host (load recorded, no other heavy work) before a value is fixed:
`ATLAS_E2E_BROWSERS=all ATLAS_SEGMENT_SWEEP=<dir> pnpm exec playwright test tests/e2e/fixture.profile-segments.spec.ts --project fixture-chromium --project
fixture-firefox --project fixture-webkit --workers 1 --retries 0 --output <dir>/pw` (150 runs; about 10 minutes on this machine).

| Smoke, one run, shared host (indicative only) | requests | largest response | largest staged-segment commit | activation commit | engine span |
| --- | --- | --- | --- | --- | --- |
| W1 whole (Chromium / Firefox / WebKit) | 1 | 6,108,895 B | — | 47 / 176 / 137 ms | 197 / 278 / 310 ms |
| W1 at 100 | 8 | 763,730 B | 10 / 16 / 25 ms | 68 / 123 / 121 ms | 324 / 659 / 502 ms |
| W1 at 4 | 200 | 30,678 B | 5 / 49 / 20 ms | 70 / 130 / 129 ms | 1,193 / 3,775 / 2,524 ms |
| R201 whole | 1 | 1,527,497 B | — | 14 / 25 / 32 ms | 60 / 55 / 75 ms |
| R201 at 100 | 3 | 756,296 B | 10 / 50 / 24 ms | 24 / 100 / 39 ms | 123 / 455 / 164 ms |
| R201 at 4 | 67 | 23,242 B | 4 / 44 / 14 ms | 25 / 56 / 33 ms | 468 / 3,753 / 874 ms |

**The answers, as far as they go.**
1. *Starting setting:* `segmentedMaxChanges = 100` (provisional). Reason: it bounds the largest single response to about 0.76 MB for the densest shapes (an
   eighth of W1's whole batch) and every staged segment's own write to at most about 50 ms on desktop, while costing 8 requests for W1 and 3 for R201; at 4
   the response is about 30 KB but W1 takes 200 requests and roughly six to fourteen times the whole-batch span. A device signal steps it down (halving) to 4 at
   `limit = 1` before the floor is counted. It is an engineering choice to be confirmed or changed by the exclusive sweep and then by WEB-09d's devices.
2. *Per-chunk parse/stage/activation cost:* recorded per page by the tool (above, indicative). **Known bound that segmentation does not remove:** the ACTIVATION is
   one IndexedDB transaction over the whole revision (that is what makes it atomic). Its JavaScript working set is bounded (staged words are moved a window of
   `queueWorkingSet` at a time, never as one array), but the transaction's own size in the engine is that of the whole revision, and its commit time is about the
   whole-batch commit's (above). A device that cannot hold one transaction of one whole revision is not helped by a smaller `max_changes`; that is the floor this
   design keeps, alongside BE-Q23's single-resource minimum (one change and at most three ancestors).
3. *Request count and overhead against whole-batch delivery:* `ceil(changes / (m - ancestors))` requests per oversized revision; each is a lease and a round trip
   (BE-Q23 records the server's per-request cost). Indicative desktop spans above.
4. *Completion of the real server-generated dense update:* **not run.** Decision D of 29 October 2026 approved the exact development pair (the unreleased
   BE-Q23 backend at `633edd4f…`, executable `a6a73bbf…`); the maintained recipe that runs it is below ("The development pairing"), and its paired execution
   waits for the independent review of that recipe, as Decision D requires. The synthetic W1 control and R201 complete in every engine at every budget tried
   (rows checked; FIXTURE evidence).
5. *Interrupted and resumed behaviour:* N1-N4 of `tests/e2e/fixture.data-segmented.spec.ts` (a real reload between segments, an IndexedDB fault during the
   activation, a second page adopting the staged revision, no partial view), passing in all three engines (FIXTURE, stubbed `/sync`).
6. *Known unmeasured bounds:* any device (WEB-09d); the real backend's segment sizes and timing (BE-Q23); memory per segment beyond the sampled Chromium heap;
   multi-tab contention during a long staged revision; the exclusive-host sweep itself.


### The development pairing (R23-PAIR; Decision D, 29 October 2026)

**Status: recipe authored and qualified; paired execution NOT run.** Decision D permits isolated qualification of this frontend against the independently
reviewed, UNRELEASED BE-Q23 backend, and requires the exact recipe, source applicability, fixture ownership and client evidence matrix to be independently
reviewed **before** paired execution. Nothing below is integration, activation or acceptance evidence; the production pin (`0.29.0-rc.1`), API types and
opt-in (`segmentedMinApiVersion: null`) are unchanged.

* **Runner:** `node scripts/integration/run-development-pair.mjs --backend development|released|diagnostic [--browsers …] [--evidence <fresh dir>] [--grep …] [--check]`.
  `development` selects the approved artefacts through `scripts/integration/pair-selection.mjs` (the orchestrator's `backend-pairing/manifest.json`,
  SHA-256 `f434df4a…`, and every file it names: executable, OpenAPI, bounded contract, backend review, dense fixture, generator lock, types tarball
  `0.0.0-pairing.20261029`; backend HEAD and tree; tracked-clean checkout; darwin/arm64). Any difference refuses the run. The executable is copied into the
  run's own directory, the copy re-hashed and launched, and the kernel's view of the launched process checked. `released` is the released-backend CONTROL
  (the unchanged `fetch-backend.mjs`, verified against SHA256SUMS, into the pair runner's own cache), which runs only the whole-revision cases.
  `--check` verifies selection, source and discovery and starts nothing. The frontend source must be committed (`--diagnostic-dirty` labels a run NOT
  evidence); the fixture build is made by the invocation from that source.
* **Composition:** the session harness page with `?leader=production` (the production election, sync engine, recovery job, production quota, session
  persistence, W27/W1) plus the DIAGNOSTIC boot option `?segmented=capable&maxChanges=m` (`DiagnosticSegmentation`, `src/data/leader/start.ts`), which hands
  `segmentedCapable` to both request callers. `main.tsx` never passes it (`tests/static/pair-recipe.test.ts`); the leader-world test SEG-1 to SEG-3 shows
  both callers opt in only when given it.
* **Fixture ownership:** one fresh disposable SQLite stack per engine; accounts made by the backend's own `account` command (a writer, one reader per case,
  one foreign account); every workload seeded through PUBLIC routes BEFORE the reader signs in, so the reader's snapshot, device and durable pre-grant cursor
  come from real authentication and synchronisation, with unrelated sentinel rows in the old state. W-real = one person + 199 dense checklist fields revealed
  by ONE public grant (200 changes); W-synthetic (LABELLED SYNTHETIC) = 799 fields + their person re-sent by ONE notice row inserted directly into the
  disposable database (800 changes). Neither is W1 (800 synthetic checklist changes) or R201 (one person + 200 fields). The backend's own
  `sync_dense_fixture.py` is not used as the bootstrap (it drains reader cursors before serving).
* **Observation:** a passive tap between the delaying proxy and the backend records every `/sync` body's exact bytes, SHA-256, length, request cursor and
  budget, segment and timings, and writes the bodies after delivery. One-shot, labelled tap faults (tamper, substitute, index/revision change, replay, 410,
  dropped connection) are recorded apart from the server's unaltered body. The tap sits UPSTREAM of the holding proxy, so it never sees the browser's
  connection: the runner gives both one correlation header (`x-atlas-pair-proxy-id`, stripped before the backend), and each tap exchange is joined to the
  proxy log entry that carried it and its downstream outcome (`delivered` is a socket write towards the preview server's hop, not the page's receipt; a
  held answer whose page departed is normally `client_gone`, and a loss is corroborated by the unchanged stored cursor and stage at the retry). The
  driver keeps every attempt (received, LOST to a departed page, DROPPED by the tap) and judges the bounded sequence over the answers the client received
  (`scripts/integration/pair-attempts.mjs`, revision 24: R23-PAIR.a). **Revision 25 (R24-PAIR.c):** the common driver and its opening
  (`scripts/integration/pair-driver.mjs`) name the workload independently of the feed, by the grant's public receipt revision (or the revision the
  synthetic transaction inserted; A1's revocation is a later milestone): a feed completion before the target (an ordinary poll answered during the grant,
  as in the reviewed WebKit T1 failure) is an incidental answer and never ends the drive. The hold is armed by the interval's opening, BEFORE the tap's
  label, after every earlier /sync settled, and stays in force through follower set-up, the grant and the whole drive; hooks act on the server's piece
  (revision and segment index), never on an attempt's ordinal; an activation is observed durably while every later answer is still held, and the drive
  ends only at a received completion after the last milestone's activation. B1-B3 close the tap's request-side gate while the foreign continuation and the
  fault are prepared. Each case's interval record (`web09c-pair-interval/3`; schema 2 refused, never upgraded) binds its complete tap window
  (every exchange listed once, no log truncation, no failed or pending body write), every upstream AND altered body re-read, hash-, length- and
  metadata-checked, the attempts, barriers (pre-grant complete, grant complete, each received piece persisted once, final released, activation complete),
  the terminal references (the answer that activated the applied revision and the feed's completion, both received; a revision's last piece may precede a
  later completion), an independent content oracle (against what the writer wrote, key-order-insensitive) and memory (Chromium: whole-page CDP JS heap
  samples, scoped as such; Firefox/WebKit: null with a reason; native IndexedDB transaction memory unmeasured everywhere). It is validated by
  `scripts/integration/pair-evidence.mjs` before the case asserts anything else, and again by the runner, which also checks it is the record of its case,
  engine, backend and selection (R23-PAIR.b) and that it was driven as the matrix says (`full`, `prefix` to an explicit hand-off, or `none`). Schema 3
  (DA-PAIR-E) derives and cross-checks what the record advertises: its target bound to the grant, every received batch and the terminal; every exchange up
  to the drive's end an attempt, joined both ways; every driven answer held, every other held answer a recorded release of the hold; exactly one
  persistence witness per received staged piece with a later held request; one durable activation witness per activating attempt; and T1's follower
  observations at the actual last piece and after the activation. A case that fails first leaves an `.incomplete.json` record, never counted.
* **Matrix (`scripts/integration/pair-matrix.mjs`, 20 cases per engine on the development backend; 25 in all since revision 27, the five X0/X2/XR0/XR2/XL0
  cases being diagnostic-only and designed skips elsewhere):** P0 selection witness; W1 whole (both backends); W2/W3 W-real at 4 and 100 with a
  barrier at every piece; S1/S2 W-synthetic at 100 and whole; R1 reload mid-revision; R2 connection dropped after the server answered; T1 second tab across
  the held activation; T2 leader closed mid-revision and real takeover; A1 revocation between pieces (no never-sent identifier disclosed); B1/B2/B3 tampered,
  foreign-device and foreign-account continuations refused by the SERVER (410); G1/G2/G3 gap, repeat and revision change (tap-injected, restart at the
  boundary); X1 tap-injected 410 (client-only, NOT server expiry/pruning); RC1 the fenced recovery catch-up in pieces; L1 the same account's session
  replaced mid-revision. **Unrun, with owners:** a retired own device (B4) and an account switch or confirmed Keep/Delete logout mid-revision (L2) —
  WEB-09d's composed lifecycle. (Before 1 November 2026 real expiry (X0) and pruning (X2) were listed here as a capability limit of the normal executables;
  they are no longer a backend capability request — see the next item.)
* **Real expiry and pruning: the approved DIAGNOSTIC selection (1 November 2026; revisions 26 and 27).** The backend owner supplied, and the approval of
  1 November 2026 authorised, the exact `atlas-sync-diagnostic` executable (frozen sync clock, real collector, private stdin controls). WEB-09c owns its
  client adapter (`--backend diagnostic`; `scripts/integration/diagnostic-fixture.mjs`, `diagnostic-evidence.mjs`, `causal-journal.mjs`,
  `pair-recovery.mjs`) and five causal cases, each in its own fresh fixture attempt: **X0** (real continuation expiry: the continuation queued at the tap's
  request gate while the sync clock moves to E−1, where the same token is still answered, and to E), **X2** (real pruning: the gate drained before the grant,
  the target batch aged in setup, the real collector at the sync start while the token is unexpired and an untouched account keeps its history), **XR0/XR2**
  (the same causes reaching the FENCED RECOVERY caller's catch-up, so the refusal is W24's server restart, not the ordinary W18) and **XL0** (X0 with one
  named create_person of the reader admitted through the production outbox and receipted before the clock steps, and a reload after E). Every order a case
  claims is between positions of the attempt's causal journal (the runner's tap, control and bridge events and the spec's acknowledged markers), never
  between clocks (revision 27, R27-DIAG.a). After the server's real 410 the hold stays armed and the recovery is observed at held snapshot pages by the leader
  and an independent follower page: invalidated, staged hidden, the last page held, and one atomic exposure (R27-DIAG.b). Since revision 28 (R28-DIAG.a/b)
  the shared schedule is one maintained module (`pair-schedule.mjs`: the continuation is handed to the expiry control and to XL0's reload hook before they
  run), and what each page SHOWS is observed separately from its stored cache status (session view, protected root, visible cache-gate placeholder,
  attachment and document identity; an unavailable observation is incomplete, never hidden), at every held page by both pages; the atomic data activation
  (`recovery_activated`) and the later moment both pages show the recovered cache (`recovery_rendered`; for the fenced caller only once its fence is cleared)
  are separate observations. Since revision 29 (R29-DIAG) each page's rendering is judged against its OWN auth fence at every sample, in the live observer
  and in the saved-evidence reader, independently of the other page: a page whose fence stands must show the neutral state over a covered protected tree,
  also at the data activation (complete data while fenced is legal only while hidden) and while its peer is still hidden; each page may show the recovered
  cache once its own fence is clear. Each sample is bracketed (the fences and the stored state read before and after one synchronous capture of the page).
  Since revision 30 (R30-DIAG) the two brackets and the rendering's availability are SEPARATE outcomes of one maintained composition
  (`pair-capture.mjs`, observation contract `/4`, with the database incarnation): a capture is first judged for what it establishes on its own — an
  unavailable or malformed rendering, a wrong account, role, document or database incarnation, a failed second read, and a page that displays while a
  stable fence stands or that no phase the moving storage allows would admit, all fail on that capture — and only a lawful capture whose fence or stored
  state moved is re-read (at most 20 in a row, counted by cause), never published. A bracket detects some uncertainty; it neither serialises the product's
  writers nor proves that every transient state was observed. Since revision 31 (R31-DIAG) each stored read is judged as the coherent IndexedDB
  transaction it is: BOTH stored transactions of every capture (the first read and the bracket's second, retained as `stored_after`; contract `/5`) are
  checked against the barrier's frozen expectations — the invalidated tuple, the staged generation/row floor/old live cache, the wholly-staged-or-wholly-
  complete activation (never backwards once a complete cache was validated), the activated cache at the follower, row-bearing and settlement reads, and the
  caller's oracle on the requested rows — BEFORE any re-read, so a composition write, an auth change or a legal activation around a capture never discards
  an already invalid transaction; only the rendering's association with the data still needs a stable bracket. Since revision 32 (R32-DIAG; contract
  `/6`) the progress one observation has validated — the bound recovery generation and the staged-row floor, each with its origin — persists across
  captures, reads, both readers, held pages and activation polls (an unresolved capture's validated facts are not forgotten; only a new observation starts
  empty), and the notice and fence facts a held barrier decides on its own (the recovery fence standing for BOTH readers before the complete data commit,
  the leader's restart notice, the ordinary leader unfenced) are judged on every capture before any re-read; the saved reader also requires both readers'
  recovery fence and a serial row floor at every recorded held page, and checks the recorded progress against the samples. The observer's re-read captures and
  settlement polls are not persisted, so the reader can judge only the recorded samples; the live observer's first failure, with its predicate, endpoint,
  expectations and both transactions, is kept in the incomplete interval (`observation_failure`). The fixture is removed only after the attempt's evidence was validated (DA-DIAG-F). **Status: the adapter and the five cases
  are qualified with stand-ins, and the rendering adapter against the fixture DOM, only; the approved executable has NOT been launched and no diagnostic case
  has run in a browser.** The approval requires an independent review of the exact client source, selection and
  recipe BEFORE any execution (design assessment Q6), then the three-engine qualification (Q7). Nothing here is expiry/pruning evidence yet.
* **Qualified so far (revision 23):** the selection, matrix accounting, tap and validator with doubles (`scripts/integration/pair-*.test.mjs`); real
  discovery of the matrix; the released-backend control (P0, W1) in Chromium, Firefox and WebKit; targeted mutants of the seam and of the spec's precondition
  and oracle. **Revision 24:** the attempt accounting at the real stand-in backend → tap → holding proxy → departed client boundary, the schema-2 validator's
  positive controls (whole, pieces, last piece before a later completion, empty live-edge completion, lost/retried, dropped, injected 200/410, real 410,
  non-barriered catch-up) and negatives, and 16 targeted mutants. **Revision 25:** the maintained driver and opening themselves, with deterministic
  worlds (empty prefix pages, renewed cursors, a last piece before the feed's completion, an empty final segment, a missing or unrelated target, lost,
  dropped, restarted, reload/takeover/revocation/hand-off and follower schedules) and at the real hop (an empty answer held through the grant, a /sync
  admitted before the hold, a request reaching the tap just before the label, the tap's gate before a fault); schema-3 positives and negatives; 34
  targeted mutants (the 16 of revision 24 carried over). The independent review's partial development run (WebKit T1 failed; the R24-PAIR.c mechanism)
  stays a failed run; the corrected recipe has NOT been executed against the development backend (Decision D: independent review of the corrected recipe
  first).

## Read this first

* **Desktop only.** No real device, floor device, installed web app or browser without a device-memory signal was profiled. BE-B1 item 2 and BE-Q23 M1 are
  `transferred` to WEB-09d (not run; `escalated` under OD-1 until 11 October 2026), and `needs_finer_pagination` is **undetermined for supported devices**. No
  mobile-safe limit, supported-device floor or all-platform conclusion is drawn from desktop figures.
* **What this hand-over can support.** Under STAGED-ACCEPTANCE-20261011 the final programme's hand-over, once complete, isolated, free of failures and accepted
  by an independent review, can support BE-B1/BE-Q23 scoped technical acceptance together with each card's own backend checks; device-sensitive choices stay
  provisional and a material unresolved contract or product choice goes to Kieran. It does not record that acceptance. No such hand-over exists yet: the
  figures below are attempt 4's history.
* **Fixture and real backend are kept apart.** P-2, P-3, P-5, P-11, P-13, P-Q and P-Q2 use a stub network (the real stamped wrapper and the production engine). P-4,
  P-10 and P-W2 use the released backend (attempt 4: v0.27.0-rc.1; the final programme: the candidate's pin, v0.28.0-rc.1; disposable SQLite, loopback, behind the
  delaying proxy). The sync leader in every case is the FIXTURE test leader: production leadership, which the production build now starts (WEB-09b), is not what
  this programme measures.
* **Memory labels.** "JS heap" is Chromium's own heap (CDP). "RSS" is the browser's own processes from `ps`. From revision 2 that is the test worker's descendants
  plus, for WebKit on macOS, every service in its host's launchd PID domain (`scripts/lib/browser-processes.mjs`); each run records its process set, sample count,
  failed samples and whether its attribution was complete, and a run without complete attribution is not memory evidence. Attempt 4's RSS (below) was
  descendant-only: WebKit's figures omit its renderer. It is **not device memory** and **not server RSS**, and it is not comparable between engines.
* **Isolation.** The controller is shared with other cards. No timing, rate, memory or footprint figure below is an isolated measurement (see the status note above
  and "Attempts and isolation"). The `(m)` and `(X)` marks in the tables are the withdrawn labels, kept only so that rows can be compared with the original
  annotation; an unmarked figure is **not** clean either. Their **outcomes** stand.
* **`deviceMemory`.** Chromium reported `navigator.deviceMemory` on this desktop; Firefox and WebKit report none. That null is those engines' desktop behaviour, not
  evidence from a supported device without the signal: no such device was profiled.

## Where the evidence is

The latest complete data are the fourth run of the programme (attempt 4; every profiling stage began behind a quiet gate). It is **not** the record of reference
(see the status note above):

* `.agtx/evidence/WEB-09c/validation/runs/2026-10-10T07-27-07.489Z-3e1a60d9/profiling/` (the four transferred commands, the shell stage and the hand-over), `handoff/results.json` (with the BE-B1/BE-Q23 consumer map), `handoff/report.md`,
  `handoff/constants.md` (P-12), `handoff/fixtures/` (the generator source, the workload hashes, the six W2 captures), `handoff/SHA256SUMS`;
* `.agtx/evidence/WEB-09c/validation/runs/2026-10-10T07-27-07.489Z-3e1a60d9/isolation-annotation.json` (the WITHDRAWN per-series labels), the continuous load samples
  `.agtx/evidence/WEB-09c/validation/attempt-4-load/load-samples-tree.jsonl`, and the corrected re-annotation
  `.agtx/evidence/WEB-09c/revision-1/attempt-4-reannotation/reannotation.json` (every row `unknown`, every stage `contaminated`).

`shasum -a 256 -c SHA256SUMS` passes in attempt 4's `handoff/`. The validator that accepted it (exit 0) did not check completeness or isolation; the corrected
`node scripts/validate-profile-handoff.mjs --handoff <dir>` refuses it (exit 1: no completeness inventory). A hand-over of the current programme states, in
`results.json` (`desktop_programme`, `isolation`) and at the top of `report.md`, whether it is complete and isolated; a partial one is refused unless
`--allow-partial` is given (exit 2). The evidence is ignored (`.agtx/`), so it is kept on the controller and in the reviewed record, not in the repository.

From revision 2 the hand-over is self-contained: `handoff/evidence/` is a copy of the whole evidence directory (raw samples, per-run memory, the device page's
results, the contention files, the shell runs, the stage records and the load samples), `handoff/resolution.json` is every required cell with its status and
reasons, and `results.json` (`schema: 3`) takes every completeness, isolation, item status and desktop conclusion from that resolution. The validator resolves
`evidence/` again and refuses a hand-over whose statements differ from it, whatever `SHA256SUMS` says. One invocation at a time holds an evidence directory
(`writer.lock`, created exclusively; released into `writers/`); an interrupted invocation leaves it held, and a fresh directory is then the only route.

From revision 3 (review 3 R2) every field of `results.json` and the whole of `report.md` come from one projection of the carried evidence and its resolution
(`scripts/lib/profile-projection.mjs`), with a small recorded context (the candidate at hand-over, the machine, the API-types pin, the provisional constants).
The validator projects them again and refuses any difference, so a published figure, admission list, failure, count, consumer status or identity cannot
disagree with the evidence even when `SHA256SUMS` was regenerated; the context itself is checked (the pin is the candidate's, every stage ran on the candidate
named, the constants are those `constants.md` shows). An invalid cell or an unfulfilled control exits 1 even with `--allow-partial`; only a consistent
programme that is merely incomplete or not isolated is a partial hand-over (2 when allowed).

## The decisions, and what the desktop evidence can and cannot settle

| # | Consumer and decision | What the desktop evidence shows | What it cannot settle |
| --- | --- | --- | --- |
| C1 | BE-B1 M1: `N` in [the largest client `limit` in either phase and the default 50, 80] | This client sends `limit` 4 at the unconstrained initial rung and 1 for every other class, step-down only, never above 80 (`src/data/model/config.ts`). The engine asked for `limit=1` in every run here. **Current source (revision 5):** the production build also sends snapshot requests: boot starts the leader by default and its recovery job asks `/sync` for snapshot pages with the limit captured from the same persistent sizing ladder, so the same rungs apply in both phases (H9 `limit_in_use`, read from the candidate's code). *(Historical, attempt 4: "It sends no snapshot request: the first snapshot is WEB-09b's" was true of that candidate and is no longer current.)* Snapshot-shaped pages of 1 to 80 batches (W5) were processed on all three desktop engines; no production snapshot was measured | The rung of each device class; the limits production snapshots really use and their cost (not measured: WEB-09b, WEB-09d) |
| C2 | BE-B1 D6 / BE-Q23 D1 (joint approver decision): is the 800-change W1 binding, or is the server-reachable W2 enough? | In attempt 4 both were admitted on every desktop engine, in every cold run (W2 also live). W1 is 6,108,903 bytes, 800 changes and 455,214 nodes. W2 from the released server is 1,520,162 bytes and 200 changes (199 dense checklists plus their person), about a quarter of W1 | The decision itself (Kieran); any device |
| C3 | BE-Q23 §4.2: *D(c, b)*, `needs_finer_pagination`, the smallest failing unit | In attempt 4, desktop *D* = 800 dense changes on all three engines (the largest rung of the ladder) and no valid workload failed on a desktop engine. That run predates the completeness inventory, so the hand-over's desktop answer (H8, H9) is drawn only from the final run, and only if its programme is complete | **Every supported device class.** Until WEB-09d's physical-device runs, `needs_finer_pagination` stays undetermined |
| C4 | BE-Q23 M7: the cost of finer requests (per-request lease and lock) | Per sync page against the real backend on loopback: about 4 to 7 ms in total (p50), of which pre-issue (capture, lease cover, stamping) is 1.5 to 3 ms. A draft submission: 17 to 33 ms (p50). Behind a 250 ms proxy delay the request is 254 to 255 ms | A 10,000-resource snapshot (WEB-09b); device CPU |
| C5 | BE-B1 item 6 / BE-Q23 M9 (V3): does the client's runtime validator use `SyncPage.batches.maxItems`? | **No.** The scanner enforces its own bounds (80 batches, 800 changes per batch; decision D-10). No file under `src/` reads `maxItems` | — |
| C6 | Frontend: initial rungs 4/1, `floorAfter` 3, step-up disabled, `markerMinBytes`, `syncApplyWatchdogMs`, `maxResponseBytesFor` | W2 at `limit=1` (1.52 MB) is about 1/7 of `maxResponseBytesFor(1)` (11,124,736 bytes). It is above `markerMinBytes` (256 KiB), so the crash-loop marker is written for it. The slowest desktop commit of W1 is far below the 20 s apply watchdog. Nothing was refused, so the floor was never reached | The device classes: every constant stays provisional and unchanged |
| C7 | Q9: `queueWarnAt` 200, `queueWorkingSet` 100, `listPage` 100 | A 200-draft queue drains in about 1.2 to 2.8 s (p50, maxInFlight 1, a stub). 200 dense drafts plus one 1 MiB import drain in about the same time | Devices; a real server's latency |
| C8 | R1: `quotaReserveBytes` (8 MiB) protecting `atlas-auth` | Three pages' stamped requests did not all go out together: 20 of 60 were in flight at once, because another page's requests wait. The `atlas-auth` burst was below what the engines' storage figures resolve. The estimate moves in steps of 4 KiB (Chromium), about 16 KiB (Firefox) and about 1 KiB (WebKit). The derived desktop figure, `max(burst x 4, step x 2)` (an engineering margin, not a measurement), is at most about 150 KB, far below 8 MiB. **The constant is not changed** | Real Safari/iOS estimate behaviour and genuine exhaustion (WEB-09d's physical-device runs) |
| C9 | Matrix §3.6.2/§3.6.3: unresolved leases, waits, give-ups, retirements, yield | Desktop figures with a FIXTURE leader, synthetic delays and a synthetic freeze (P-6 to P-9 in the hand-over). The production 20 s give-up was observed at the bound and never earlier | The production leader (WEB-09b), a real freeze or bfcache (WEB-08c), devices |
| C10 | R60 follow-up: the healthy-follower reads that `atlas-sync` hints cause | **Every committed sync page posts `data_changed [cache, sync_state]`, and `sync_state` is also the stop-record store**, so a healthy follower re-reads on every leader page: about 11 IndexedDB transactions per page hint (9 of them on `sync_state`), about 12 to 20 ms per hint (p50). A stop-record hint costs one transaction, and a draft or receipt hint 5. The leader's catch-up throughput was unchanged by followers in Chromium; in WebKit it fell from 70 to 52 and 40 pages/s with one and two followers (series marked `(m)`/`(X)`: a signal to re-take, not a finding) | Devices; the production leader (WEB-09b) |
| C11 | Bundle budgets (OD-2, FB-20261010) | **Revision 8, the reasoned successor:** one shared ceiling per figure, the signed-in shell's (dist-fixture) measurement plus 10 %: **289,142 / 8,078 / 92,110** bytes (initial JS gzip / CSS gzip / fonts) from the Air programme's P-1, 262,856 / 7,344 / 83,736; the fixture baseline is that measurement, so its guard binds at 289,141. The production build (108,391 / 7,344 / 83,736) keeps its own baseline 99,814 / 6,708 / 83,736 + 10 %. Why 10 % is kept, the loading beside size and the effective bounds: "Bundle budgets: the reasoned successor" below. (Revision 1's ceilings 241,540 / 7,560 / 92,110 and the accepted base's temporary 266,057 are history.) | Device boot timing (WEB-09d); the combined-build remeasurement after WEB-08c/08d/13a/14a are integrated; any production-baseline decision |

## Bundle budgets: the reasoned successor (C11, revision 8)

Kieran approved **FB-20261010** on 10 October 2026 (`atlas-orchestrator/approval/fixture-budget-20261010.json`, SHA-256
`7414b09a5fa9dcb094a5e5cbaf4645f24fee413f49999c13a975ac888aa584bc`; hand-off `delivery/handoffs/fixture-budget-20261010.md`, SHA-256
`d2852ad606f8759f2f41f24043a38df02e6fcb2a77b67ecc859fe769682ec430`) and applied it to WEB-12a as **FB-20261010-WEB12A**
(`delivery/handoffs/web12a-fixture-budget-20261010.md`, SHA-256 `73cac22e13e30743c6a4b899161d1ffccadae8e12b29ff25b79ed4243619b52f`), then to WEB-08c and
WEB-14a as **FB-20261010-08C-14A** (`approval/web08c-web14a-fixture-budgets-20261010.json`, SHA-256
`777f7db96d3c30abd00f6bc9706c2630b3a5d2e4d867d6ad93d04d69914e1223`; hand-off `delivery/handoffs/web08c-web14a-fixture-budgets-20261010.md`, SHA-256
`8507fa8cee064014c42f39a13c972b2e3aaaec7e32ac93c3b2a33431a110e963`), and on 11 October 2026 to WEB-08d as **FB-20261011-08D**
(`approval/web08d-fixture-budget-20261011.json`, SHA-256 `2006d78812da545b5161a5e74a4f50b88337b5462d505cbc76a38e3fd1bcc2b0`; hand-off
`delivery/handoffs/web08d-fixture-budget-20261011.md`, SHA-256 `41c1451937d28ffb5d39ca87fcc2ee0a7df447268e2d85158f172cd2ce038173`). These later inputs
reach this task through the operator addenda of its `.agtx/plan.md` (dispatch repair `docs/budget-handoff-dispatch-repair-20261010.md`, SHA-256
`7e337a4f74fb93a2213ab2967ce1c1cadcd4028ea852ee6b8ca5db8f511f88db`). Five feature cards got one-off, temporary `dist-fixture` re-records, and **WEB-09c
owns replacing that temporary policy with a reasoned size budget**. There is no universal correct byte count and no demonstrated performance cliff; the
fixture is a proxy for the signed-in shell. `perf-budget.json` (`budget_basis`) carries what follows in machine-readable form.

### The measurement and its provenance

P-1 of the complete Air programme, request `profile-20261012-211000-fb04d06e` (m4-air: Apple M4, macOS 26.3.1, Node 22.23.2, pnpm 12.4.2; 12 October
2026), on the parentless execution commit `39a26cfb84c0cd5b8d05c64e7e57185d12aa0ab1` (manifest fingerprint
`c48de57ed0a7048d22a7f20c7b1f9cada949d0a6ce28b212c0765c14c8fae215`) of this branch at `e87859f`: `bundle/bundle-profile-dist-fixture.json` SHA-256
`bfe53dba03c786dd94aaa790d2e061788f35a8d37b4e4f692707ebfb3e3d8c8c`, `bundle/bundle-profile-dist.json` SHA-256
`9051dc9fba4d265b361b21558b4c9383344c845f0985f0b93ac43c80cce2ac7d`; both builds recorded `node_env: null` and passed their budget checks. That package
**failed** its strict validation (113 contention/P-10 cells not isolated, R1); its P-1 cells and all 24 P-1S cells are `ok` in its resolution and are used
here as **component observations**, not as an accepted hand-over.

The bytes are reproducible: a build of `git archive e87859f` without `.agents/` and `.mcp.json` (the tracked files the Air snapshot excludes) measures
exactly 108,391 / 262,856 / 7,344 / 83,736 on the controller. With those files present it measures 108,393 / 262,853 / 7,358: **Tailwind CSS v4 scans every
non-ignored text file of the repository** (documents, scripts and tests included) for class names, so the CSS, and through the hashed asset names a few bytes
of initial JavaScript gzip, can change with text outside `src/`. Accepted main (`38b7db9`: WEB-07, WEB-08a, WEB-08b, WEB-09a, WEB-09b, WEB-12a) measures
108,389 / 262,856 / 7,338 the same way: this branch adds nothing measurable to the initial JavaScript (its device-page modules are lazy, fixture-only
chunks). The growth from the accepted base's 241,870 to 262,856 is main's merged WEB-08b/WEB-09b authentication and recovery baseline; WEB-12a's
integration report attributes 842 B to WEB-12a's last revision.

| Build (Air P-1) | Initial JS gzip | CSS gzip | Fonts |
| --- | --- | --- | --- |
| `dist` (the neutral production entry) | 108,391 | 7,344 | 83,736 |
| `dist-fixture` (the signed-in shell, fixture data, test leader and harness, eager) | 262,856 | 7,344 | 83,736 |
| Fixture-only overhead as C11 defines it (fixture entry minus production entry) | 154,465 | 0 | 0 |

Most of that overhead is signed-in application code that production loads **lazily** after sign-in: production's lazy chunks sum to about 215 kB gzip
(entry plus lazy about 324 kB), against the fixture entry's 263 kB plus 117 kB lazy (per-chunk gzip sums, approximate).

### Loading beside size (P-1S)

Chromium, CDP-emulated throttling with 4× CPU on the Air desktop, three cold runs per condition; median [range], ms. **Emulated, not a device.**

| Build | Viewport | Network | First contentful paint | Largest contentful paint | Transferred |
| --- | --- | --- | --- | --- | --- |
| `dist` | mobile | fast 4G | 168 [164–176] | 492 [488–524] | 365,433 B |
| `dist` | mobile | slow 4G | 568 [568–572] | 2,040 [2,016–2,040] | 365,433 B |
| `dist` | desktop | fast 4G | 168 [168–184] | 496 [492–504] | 365,433 B |
| `dist` | desktop | slow 4G | 564 [556–584] | 2,032 [2,024–2,036] | 365,433 B |
| `dist-fixture` | mobile | fast 4G | 300 [288–332] | 476 [464–512] | 309,389 B |
| `dist-fixture` | mobile | slow 4G | 796 [772–800] | 1,952 [1,944–1,960] | 309,389 B |
| `dist-fixture` | desktop | fast 4G | 300 [292–300] | 468 [460–472] | 332,817 B |
| `dist-fixture` | desktop | slow 4G | 788 [780–792] | 1,956 [1,952–1,960] | 332,817 B |

The fixture entry paints first about 132 ms later than production on fast 4G and about 225 ms later on slow 4G; largest contentful paint is about 0.5 s
(fast 4G) and 2.0 s (slow 4G) for both. Read as a linear order of magnitude (two builds, not a model), that is about **1.5 ms of slow-4G first contentful
paint per kB** of initial JavaScript gzip.

### The successor and why

**Shared ceilings: 289,142 / 8,078 / 92,110** (round(measurement × 1.10)); the `dist-fixture` baseline is re-recorded as 262,856 / 7,344 / 83,736, so
its guard and the shared ceiling coincide (to rounding).

* **Headroom.** 10 % of 262,856 is 26,286 B: by the reading above, about 38–39 ms of emulated slow-4G first contentful paint if all of it were used, within
  twice the run-to-run range observed (up to 28 ms on slow 4G, 44 ms on fast 4G). No cliff was observed or is claimed; no responsiveness target is set.
* **Expected growth.** The four named branches not in this build recorded their growth: WEB-13a about 2.6 kB (243,097 against the 240,479-byte main of
  10 October, its decision's comparison) and WEB-08d 4,234 B (its author's attribution); WEB-14a and WEB-08c recorded overruns of 2,021 and 426 B over the
  old 241,544 ceiling, about 3.1 and 1.5 kB above that main (an approximation: their own bases are not recorded). As an estimate of **deltas** only (the
  branch bundles are not additive, and none measures the combined application), about 11.4 kB of the 26.3 kB, leaving about 14.9 kB (about 5.7 %) for
  chunk-layout effects and unattributed growth before an explicit decision is needed.
* **Why 10 %, not less or more.** 5 % (13.1 kB) would leave about 1.7 kB after the named branches, so the first integration would need another decision
  with no evidence of benefit; a larger figure has no measured basis and would weaken the guard as a regression detector. OD-2's 10 % is kept for these
  reasons, not by default.

| Figure | `dist` effective bound | `dist-fixture` effective bound |
| --- | --- | --- |
| Initial JS gzip | **109,795** (its baseline 99,814 + 10 %, under the shared 289,142); measured 108,391, headroom 1,404 B | **289,141** (its baseline + 10 %, one byte under the shared 289,142); measured 262,856 |
| CSS gzip | **7,378** (its baseline 6,708 + 10 %, under the shared 8,078); measured 7,344 (34 B headroom; 7,358 and 20 B with `.agents/` scanned) | 8,078; measured 7,344 |
| Fonts | 92,109; measured 83,736 | 92,109; measured 83,736 |

The **production** baseline and its regression guard are unchanged; only Kieran can raise them. Its headroom is small: 1,404 B of JavaScript, and 34 B of
CSS (20 B in a checkout that scans `.agents/`), which Tailwind's repository-wide scan can consume with documentation or test text alone. Named branches
already measured production entries of 108,567 (WEB-08d), 108,620 (WEB-08c) and 109,128 B (WEB-14a), so the combined build may need a **production
decision** that this successor does not make.

| Feature branch (its decision) | Fixture initial JS, measured by its author | Temporary ceiling it holds | In this build? |
| --- | --- | --- | --- |
| Accepted base (FB-20261010-WEB12A, carried into main) | 241,870 (CSS 7,059) | 266,057 | yes, as accepted main; **replaced** by the successor |
| WEB-13a (FB-20261010) | 243,097 (CSS 7,240) | 267,406 | **no**: not measured or profiled here |
| WEB-08c (FB-20261010-08C-14A) | 241,970 (CSS 7,227; production 108,620) | 266,167 | **no** |
| WEB-14a (FB-20261010-08C-14A) | 243,565 (CSS 7,193; production 109,128) | 267,921 | **no** |
| WEB-08d (FB-20261011-08D) | 244,712 (CSS 7,191; production 108,567); 4,234 B attributed to device naming/labels | 269,183 | **no** |

### Obligations and limitations

1. **Combined-build remeasurement:** when WEB-08c, WEB-08d, WEB-13a and WEB-14a are integrated with this successor, rebuild `dist` and `dist-fixture`, run
   `node scripts/check-budgets.mjs dist` and `node scripts/check-budgets.mjs dist-fixture` and the P-1 attribution
   (`node scripts/profile-sync.mjs --evidence <fresh dir> --only bundle`) on that combined candidate. Branch sizes are not additive. This creates no
   dependency between active cards and authorises no merge.
2. **Budget metadata at that integration:** those branches carry `provisional_by_build["dist-fixture"]` ceilings, which this branch's checker refuses;
   reconcile them deliberately into this shared budget. No branch may restore an older ceiling or carry a temporary one forward unexamined.
3. **Increases need a decision:** any figure above these, and any change to the production baseline, needs attributed growth and an explicit decision;
   there is no automatic reset per card.
4. **Re-measurement:** the final WEB-09c Air programme measures P-1/P-1S again on the revision-8 candidate. Its P-1 must equal the measurement above to the
   byte, or the difference must be attributed (Tailwind's scan of changed text outside `src/`) before this basis is relied on.
5. **Scope:** desktop/emulated evidence only. Supported-device boot and responsiveness remain WEB-09d's; no device threshold is inferred. The repository-wide
   Tailwind scan is recorded here as a risk to the production CSS guard; changing it is a production-source decision outside this card.

## Measured on desktop

### Provenance

* Run directory: `.agtx/evidence/WEB-09c/validation/runs/2026-10-10T07-27-07.489Z-3e1a60d9` (validation driver `results.json` SHA-256 `6c9bb1b1ab8376ea9f6fedc7ce1dc4f5d2b88f819d0fa39922c9f9d97eafa6d3`).
* Hand-over: `profiling/handoff/results.json` SHA-256 `aaf2f3811796ea7090fb72e304879284d4e046ea7df3dca3f14e4fecb647b0b5`; `SHA256SUMS` SHA-256 `465903fa0f4ca9656f714d55ae110330337266a11a0cf3602bdbaf32a1993f20`; `report.md` SHA-256 `970d8224ef4b388fabbaa42b4bf0b60934b730e3a31d3eacd29a6ae338f77d7e`.
* Candidate: commit `8e24e0aa478d4ab3b83b3a410456cce572a28fc1`, tree `fe0190ba513807c4c74e546773663ac9f7ccc019`, source fingerprint `4007cf0bdf63288d7a1610bf93e2017da7dc34e20a347404042ebfe09e78e39f` (every stage ran on it; the working tree carried the WEB-09c changes, listed in the hand-over).
* Backend: `v0.27.0-rc.1` (`7621f2fe8e033e67004a7f0767f38db26c6a46b8`), API types `0.27.0-rc.1`; the release archive `atlas-aarch64-apple-darwin.tar.gz` that the integration runner verified, SHA-256 `83294dc21d846ce90404627b44097cd582209ac5c38527d1e0419257507911db`; `/health` answered `{'api_version': '0.27.0', 'status': 'ok'}` in every engine; disposable SQLite, loopback, behind the delaying proxy.
* Machine: darwin 25.6.0 arm64, Apple M4 Pro, 14 cores, 48 GiB; Node v22.23.2; Version 1.63.0; engines {"chromium": "153.0.8010.12", "firefox": "155.0", "webkit": "26.6"}. One worker; Playwright contexts are ephemeral profiles.

### Page application by shape (P-2; fixture stub network, the real stamped wrapper and the production engine): commit ms, p50 / p95 / max

| Shape | Bytes | chromium | firefox | webkit |
| --- | --- | --- | --- | --- |
| ordinary-100 | 27666 | 2.5 / 3 / 8.2 (m) | 5 / 7 / 25 (X) | 4 / 13 / 26 (m) |
| ordinary-200 | 55446 | 4.2 / 5 / 28.5 | 8 / 24 / 69 (X) | 7 / 17 / 29 (m) |
| ordinary-400 | 111006 | 8 / 9.6 / 45.8 | 35 / 64 / 129 (X) | 14 / 22 / 31 (X) |
| ordinary-800 | 222126 | 15.3 / 20.1 / 27.9 | 28 / 34 / 44 | 28 / 36 / 95 (m) |
| dense-100 | 763703 | 5.4 / 6.7 / 20.3 | 10 / 19 / 39 | 15 / 25 / 26 (m) |
| dense-200 | 1527303 | 10.3 / 14.3 / 16.6 | 18 / 24 / 30 | 28 / 35 / 44 (m) |
| dense-400 | 3054503 | 20.4 / 22.2 / 23 | 38 / 43 / 44 | 58 / 62 / 64 (m) |
| dense-800-W1 | 6108903 | 40.8 / 44.2 / 44.2 | 73 / 81 / 81 | 103 / 109 / 109 (X) |

Scan ms (the byte scan, pass 1), p50 / p95 / max:

| Shape | chromium | firefox | webkit |
| --- | --- | --- | --- |
| ordinary-800 | 0.6 / 0.8 / 1.6 | 1 / 2 / 10 | 0 / 1 / 1 (m) |
| dense-400 | 7.5 / 9 / 9.3 | 12 / 17 / 18 | 4 / 5 / 5 (m) |
| dense-800-W1 | 15.2 / 17.5 / 17.5 | 25 / 42 / 42 | 9 / 10 / 10 (X) |

Wall ms (nudge to idle, including the stub's own transfer), p50 / p95 / max:

| Shape | chromium | firefox | webkit |
| --- | --- | --- | --- |
| ordinary-800 | 27 / 55 / 66 | 55 / 66 / 120 | 63 / 81 / 136 (X) |
| dense-400 | 98 / 101 / 101 | 108 / 124 / 126 | 143 / 162 / 184 (m) |
| dense-800-W1 | 207 / 220 / 220 | 182 / 247 / 247 | 256 / 268 / 268 (m) |

### Dense workloads, five cold runs each (P-11; a new browser context per run)

| Workload | Engine | Outcomes | Elapsed ms p50 / max | Browser-process RSS peak KiB p50 / max | JS heap peak bytes p50 / max |
| --- | --- | --- | --- | --- | --- |
| W1 (5.83 MiB) | chromium | 5 x admitted | 204 / 209 | 636704 / 637216 | 21301768 / 24146820 |
| W3 (3.38 MiB) | chromium | 5 x admitted | 203 / 204 | 640336 / 640672 | 5785988 / 12781648 |
| W4 (1.37 MiB) | chromium | 5 x admitted | 125 / 126 | 621712 / 622272 | 7071996 / 7206352 |
| W6 (0.05 MiB) | chromium | 5 x admitted | 40 / 41 | 606256 / 607936 | 6061296 / 6075216 |
| W7 negative controls (6) | chromium | truncated: refused, deep_value: refused, unknown_field: refused, bad_kind: refused, raw_control_char: refused, oversize_change: refused | | | |
| W1 (5.83 MiB) | firefox | 5 x admitted | 191 / 206 | 1597168 / 1646592 | not available |
| W3 (3.38 MiB) | firefox | 5 x admitted | 139 / 148 | 1623248 / 1759024 | not available |
| W4 (1.37 MiB) | firefox | 5 x admitted | 97 / 127 | 1677760 / 1735792 | not available |
| W6 (0.05 MiB) | firefox | 5 x admitted | 46 / 54 | 1530464 / 1757360 | not available |
| W7 negative controls (6) | firefox | truncated: refused, deep_value: refused, unknown_field: refused, bad_kind: refused, raw_control_char: refused, oversize_change: refused | | | |
| W1 (5.83 MiB) | webkit | 5 x admitted | 284 / 301 (m) | 295792 / 303808 (m) | not available |
| W3 (3.38 MiB) | webkit | 5 x admitted | 177 / 196 (m) | 308336 / 308528 (m) | not available |
| W4 (1.37 MiB) | webkit | 5 x admitted | 128 / 134 (m) | 309360 / 309408 (m) | not available |
| W6 (0.05 MiB) | webkit | 5 x admitted | 48 / 60 (m) | 309312 / 312048 (m) | not available |
| W7 negative controls (6) | webkit | truncated: refused, deep_value: refused, unknown_field: refused, bad_kind: refused, raw_control_char: refused, oversize_change: refused | | | |

RSS here is attempt 4's descendant-only figure, sampled with `ps` (browser-process RSS: not device memory, not server RSS, not comparable between engines).
**WebKit's RSS column omits its WebContent, Networking and GPU processes** (launchd children; review R4) and is withdrawn as browser memory; revision 2's collector
counts them, and the final run recollects every memory figure.

### The server-maximal dense batch from the released backend (P-W2)

| Engine | Captured at limit 1 | Batches / changes / checklist upserts | SHA-256 (limit 1) | Live, real `/sync` (outcome, ms, limits asked) | Live dense commit (scan ms / commit ms) | Five cold runs of the captured bytes | Cold elapsed ms p50 / max | Cold RSS peak KiB p50 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | 1520162 B (1.45 MiB) | 1 / 200 / 199 (+ person: True) | `30248eabc7ec8228…` | admitted, 870 ms, limit 1 | 4.4 / 10.7; 3.6 / 11.6 | admitted x 5 | 67 / 68 | 714688 / 714800 |
| firefox | 1520162 B (1.45 MiB) | 1 / 200 / 199 (+ person: True) | `bd87d462c8e4a343…` | admitted, 1627 ms, limit 1 | 4 / 19; 5 / 24 | admitted x 5 | 77 / 82 | 1970432 / 1998528 (m) |
| webkit | 1520162 B (1.45 MiB) | 1 / 200 / 199 (+ person: True) | `be42531ff7afe506…` | admitted, 1899 ms, limit 1 | 2 / 26; 2 / 37 | admitted x 5 | 138 / 142 | 258512 / 265440 |

Observed bound (recorded, not a client requirement): revoking a person whose 200 dense fields are shared with the reader (201 changes in one revision) was answered `200`, and the reader's next `/sync` from the position after W2 was answered `410` resync_required in every engine: the released server turns an over-200 access change into a snapshot recovery for that account.

### Requests and leases against the released backend (P-4, P-10; loopback): ms, p50 / p95 / max

| Segment | chromium | firefox | webkit |
| --- | --- | --- | --- |
| P-4 sync page pre_issue_ms | 1.6 / 2.1 / 3.6 | 3 / 4 / 12 | 3 / 12 / 17 (m) |
| P-4 sync page request_ms | 1.3 / 1.6 / 2.1 | 1 / 2 / 3 | 1 / 2 / 2 (X) |
| P-4 sync page post_response_ms | 1.1 / 1.7 / 2 | 2 / 3 / 8 | 2 / 10 / 19 (X) |
| P-4 sync page total_ms | 4 / 5 / 7 | 7 / 8 / 21 | 7 / 16 / 26 (X) |
| P-4 draft enqueue_ms | 1.6 / 2.2 / 11.5 | 3 / 4 / 96 | 2 / 6 / 17 (X) |
| P-4 draft claim_ms | 3.7 / 6.4 / 10.4 | 6 / 10 / 26 | 9 / 14 / 17 (X) |
| P-4 draft stamping_ms | 1.4 / 2 / 5.7 | 2 / 3 / 37 | 3 / 11 / 22 (X) |
| P-4 draft request_ms | 1.8 / 2.3 / 11 | 2 / 3 / 6 | 2 / 2 / 8 (X) |
| P-4 draft record_ms | 0.6 / 1.1 / 4.6 | 1 / 2 / 20 | 1 / 2 / 3 (X) |
| P-4 draft total_ms | 16.6 / 20.4 / 31.4 | 20 / 34 / 114 | 33 / 49 / 59 (X) |
| P-10 sync page duration_ms (proxy delay 250 ms) | 254.5 / 257.2 / 259.4 | 253 / 255 / 255 | 254 / 255 / 257 |

### Queue drains (P-5; fixture stub, maxInFlight 1, 20 runs): ms, p50 / p95 / max

| Queue | chromium | firefox | webkit |
| --- | --- | --- | --- |
| P-5 drain_200_ms | 1226 / 1339 / 1339 | 1984 / 2089 / 2089 | 2551 / 2754 / 2754 (X) |
| P-5 per_draft_ms | 6.13 / 6.695 / 6.695 | 9.92 / 10.445 / 10.445 | 12.755 / 13.77 / 13.77 (m) |
| P-5 dense drain_201_ms | 1333 / 1447 / 1447 | 2042 / 2433 / 2433 | 2739 / 2882 / 2882 (X) |
| P-5 dense per_draft_ms | 6.632 / 7.199 / 7.199 | 10.159 / 12.104 / 12.104 | 13.627 / 14.338 / 14.338 (m) |

### Durability (P-3; ephemeral profiles, so `strict` and `default` are not told apart on disk): write ms, p50 / p95 / max

| Write | chromium | firefox | webkit |
| --- | --- | --- | --- |
| draft strict | 0.4 / 0.8 / 3.3 | 1 / 2 / 3 | 1 / 1 / 3 (X) |
| draft default | 0.4 / 0.5 / 3.7 | 1 / 2 / 3 | 1 / 1 / 3 (X) |
| fence strict | 3.7 / 4.9 / 8.4 | 6 / 11 / 93 | 5 / 6 / 9 (X) |
| fence default | 3.8 / 5 / 19.1 | 6 / 11 / 12 | 5 / 7 / 9 (X) |
| form_recovery strict | 0.2 / 0.3 / 0.3 | 0 / 1 / 7 | 0 / 1 / 1 (X) |
| form_recovery default | 0.1 / 0.2 / 1.2 | 0 / 1 / 31 | 0 / 1 / 1 (X) |

### Healthy-follower reads on `atlas-sync` hints (P-13; FIXTURE leader)

| Condition | Engine | Hints | IndexedDB transactions | Per hint | `sync_state` transactions | Read ms per hint p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- |
| none (control) | chromium (m) | 0 | 32 | None | 18 | no hints |
| leader pages | chromium (m) | 201 | 2252 | 11.204 | 1850 | 11.6 / 14.2 / 32.6 |
| stop-record hints (synthetic) | chromium (m) | 200 | 200 | 1 | 200 | 0.3 / 0.4 / 0.5 |
| drafts and receipts | chromium (m) | 400 | 2000 | 5 | 1600 | 6.2 / 16.3 / 28.7 |
| none (control) | firefox (X) | 0 | 32 | None | 18 | no hints |
| leader pages | firefox (X) | 201 | 2244 | 11.164 | 1842 | 14 / 20 / 33 (X) |
| stop-record hints (synthetic) | firefox (X) | 200 | 200 | 1 | 200 | 1 / 2 / 4 (X) |
| drafts and receipts | firefox (X) | 400 | 2000 | 5 | 1600 | 9 / 22 / 61 (X) |
| none (control) | webkit (X) | 0 | 38 | None | 22 | no hints |
| leader pages | webkit (X) | 201 | 2240 | 11.144 | 1838 | 20 / 39 / 54 (X) |
| stop-record hints (synthetic) | webkit (X) | 200 | 200 | 1 | 200 | 0 / 1 / 2 (X) |
| drafts and receipts | webkit (X) | 400 | 2000 | 5 | 1600 | 11 / 35 / 51 (X) |

Leader catch-up throughput (pages/s, 200 pages, 5 ms synthetic latency), p50 of three runs, by number of followers:

| Followers | chromium | firefox | webkit |
| --- | --- | --- | --- |
| 0 | 70.255 (m) | 52.032 (X) | 70.059 (X) |
| 1 | 70.304 (m) | 52.032 (X) | 52.019 (m) |
| 2 | 70.206 (m) | 51.978 (X) | 40.321 (m) |

### Quota reserve inputs (P-Q2) and footprints (P-Q)

| Engine | Stamped requests out together (of 60) | Burst growth (exact / estimate) | Estimate step (first write that moved it, and by how much) | 100 reservations: growth (exact / estimate) | Derived desktop figure (bytes) |
| --- | --- | --- | --- | --- | --- |
| chromium | 20 | 0 / 0 | 4096 B write, step 4096 B | 0 / 0 | 8192 |
| firefox | 20 | None / -185432 | 1024 B write, step 16480 B | None / 0 | 32960 |
| webkit (X) | 20 | None / 38158 | 1024 B write, step 1051 B | None / 0 | 152632 |

* P-Q chromium: per-draft bytes (Chromium exact only) 2458; 200 drafts estimate 638976 vs empty 147456; a 1 MiB import draft: queued.

* P-Q firefox: per-draft bytes (Chromium exact only) None; 200 drafts estimate 11131632 vs empty 176552; a 1 MiB import draft: queued.

* P-Q webkit: per-draft bytes (Chromium exact only) None; 200 drafts estimate 460160 vs empty 6015; a 1 MiB import draft: queued.

### Bundles and throttled boot (P-1, P-1S)

* `dist`: {"initial_js_gzip": 107948, "css_gzip": 6873, "fonts": 83736} (check exit 0; `bundle/bundle-profile-dist.json` SHA-256 `a2784b183a3b29bfe4fc1e00fc6e7ea187353c92715ba1b1ef7e4c44b6affbd9`).
* `dist-fixture`: {"initial_js_gzip": 219586, "css_gzip": 6873, "fonts": 83736} (check exit 0; `bundle/bundle-profile-dist-fixture.json` SHA-256 `b9bdf8578b8add25e03bfb3a240a87ff33e5b7bf45ac53a3ad77a3d2cc86310e`).
* Dexie in the initial chunk: False (production) / False (fixture).

| Build | Viewport | Network (CDP, 4x CPU) | LCP ms | FCP ms | CLS | Font window ms | Transfer KB | Script encodings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dist | mobile | fast-4g | 480 | 184 | 0 | 0 | 251 | {"gzip": 12} |
| dist | mobile | slow-4g | 1824 | 568 | 0 | 86 | 251 | {"gzip": 12} |
| dist | desktop | fast-4g | 480 | 176 | 0 | 0 | 251 | {"gzip": 12} |
| dist | desktop | slow-4g | 1824 | 556 | 0 | 92 | 251 | {"gzip": 12} |
| dist-fixture | mobile | fast-4g | 448 | 272 | 0 | 0 | 255 | {"identity": 3, "gzip": 21} |
| dist-fixture | mobile | slow-4g | 1704 | 728 | 0 | 335 | 255 | {"gzip": 21, "identity": 3} |
| dist-fixture | desktop | fast-4g | 452 | 272 | 0 | 246 | 278 | {"gzip": 21, "identity": 3} |
| dist-fixture | desktop | slow-4g | 1704 | 728 | 0 | 1249 | 278 | {"identity": 3, "gzip": 21} |

### Contention with a FIXTURE leader (P-6 to P-9): see the hand-over

* **P-6** (measured, chromium, firefox, webkit): desktop; two or more pages of one context through the real stamped wrapper; the network is a stub. A closed tab is the real cause (clean: the session's own pagehide retires the lease; killed: SIMULATED by neutralising that handler; crashed: a REAL Chromium renderer crash); a slowed response and a failing recording write are INJECTED. 'precondition_met' counts the scenarios in which the record alre
* **P-7** (measured, chromium, firefox, webkit): waits of an ordinary request, an exposure, an atlas-auth writer and a closing write (a logout's initiation) of one page against a back-to-back FIXTURE leader (pages 5 ms apart, a synthetic server latency) and with no leader; see the measurement rows named P-7 and contention/waits.jsonl. A frozen owner is a main-thread block in a page that holds atlas-auth (SYNTHETIC: a Playwright engine cannot fre
* **P-8** (measured, chromium, firefox, webkit): counted from the kernel's own trace in each page (activity.cancel, lease.retired, lease.retire_failed) while the P-7 scenarios ran
* **P-9** (measured, chromium, firefox, webkit): the FIXTURE leader with each yield policy (none, macrotask, scheduler.yield, idle); policies are fixture code (production supplies its own at WEB-09b); 'scheduler_yield' falls back to a macrotask where the engine has no scheduler.yield (engine_support in each file)

### Isolation of these figures

**None of the 384 series is an isolated measurement.** The original annotation (205 "clean", 70 "minor" `(m)`, 109 "contaminated" `(X)`, by the peak foreign CPU
between one exported row and the next, sampled every 15 s) is **withdrawn**: rows are written out after their figures are collected, sometimes several series at
once and in another order, so those windows did not cover the collection (review R1; the reviewer's synthetic control showed contention during a collection labelled
clean). Its tiers were also this author's proposal, not an approved relaxation. Re-annotated with the corrected method
(`.agtx/evidence/WEB-09c/revision-1/attempt-4-reannotation/reannotation.json`): every row is `unknown` (it carries no collection window) and every stage it falls in
(bundle, fixture, shell, contention, integration) is `contaminated` over its own samples.

From revision 1, every row carries its collection window (the test that collected it), the drivers sample the load every 5 s through every stage with this run's own
process tree and its own WebKit services excluded, and the hand-over carries a verdict for every series (`clean`, `idle_foreign`, `contaminated` or `unknown`; only
`clean` is isolated) and states whether the whole programme is isolated.

From revision 2 (review 2, design assessment), the unit of evidence is a **cell** of the evidence contract (`scripts/lib/profile-contract.mjs`), not a row:

* every load-dependent cell (every distribution, the shell's 24 cold runs, the footprints and quota inputs, the P-6 counts, the production lock wait and the device
  protocol) is judged over its own window by the samples of **its own stage only**; another stage's samples never fill a gap;
* a stage's action runs between its sampler's barriers: the sampler must have written a valid first sample before it (otherwise the stage fails before its action),
  and writes a final one after it; the stage record is sealed whatever happens, with the action's interval, the sampler's state and any failure;
* (revision 15, review 15 R15-S1) a sampled stage succeeds only if its action succeeds AND its sampler finished successfully: exit 0 after the stop and a
  valid final sample of its own process, stage, invocation and root written after the stop began (a final marker on an error row is not one); otherwise a
  zero action status becomes 1 and the sampler's problem is sealed beside any action failure (a non-zero action status is kept). A sampler that gives no
  ready handle is a startup failure. Both drivers continue or exit on that status, so a stage whose sampler died is never followed by the next stage;
* a stage whose sampler was not ready, wrote no final sample, wrote a malformed sample, whose clock went backwards or that left a gap of more than two intervals
  judges its cells `unknown`; only `clean` is isolated, and there is still no CPU tolerance;
* a 5 s poll cannot prove that no short foreign job ran between two samples: final timings need a protected controller.

From revision 3 (review 3 R2; contract version 2) a cell is complete only when its observation's **contents** are, and every representation of it agrees:

* P-Q2: the burst's idle, during and after readings, every request's outcome, the estimate ladder from its initial usage (each write's size, cumulative total,
  usage and delta), the ledger's readings before and after its 100 typed verdicts, the growths, the first estimate step and the recommendation
  `max(burst x 4, step x 2)` are recomputed (a coarse or absent estimate stays an explicit `null`; nothing is assumed); P-Q uses the writer's reading shape;
* P-8: both named conditions, every counter recounted from the trace events kept beside it (`contention/retirements-trace.<engine>.json`), the rate from its pages
  and duration, the value row the same; P-6: the by-cause summary recomputed from the scenario rows (the precondition and the later covers stay two different
  observations); P-7 and P-9: every wait series the samples of its JSONL support, give-ups their outcomes, throughput the copies'; P-13: every figure recomputed
  from the observed hints and transactions (`contention/follower-reads-raw.<engine>.json`), the read series those very reads;
* memory: every sample is kept, the peak is the largest of them, the processes at the peak add up to it, the top-level copies and the P-11/P-W2 series are the
  per-run figures in run order, and the heap peak is the largest heap sample;
* W2: the captured bytes are parsed and their phase, batches, changes and shapes recomputed against the seeded person, so metadata cannot make a small batch dense;
  revision 4: the bytes must also BE the seed (a valid sync page whose one batch holding the seeded person is that person and its 199 distinct checklist fields of
  100 items labelled "x" and 40 checked ids each, 200 changes; the seeding's field count and value size are the observed ones; both limits show the same seeded
  batch), and an engine's device cells depend on its limit-1 capture being valid;
  the bound and the limits ladder have their recorded forms; the live application and the cold outcomes agree with their copies;
* P-4: each sync-page total is the sum of its segments (a draft total at least theirs); the shell's medians and every derived figure follow from its runs;
* the device page's file is a protocol's, in plan order, with a terminal state and planned count that agree with it, and every run carries its path's figures
  (schema 4: an engine run carries the observation its outcome was classified from and the cache it left, both judged as a cold run's are);
* P-2's scan and commit series are recomputed from their per-sample support (contract version 7), and the P-4/P-10 sync segments and the P-4
  draft segments from each sample's bounded witness (contract version 8; the draft witness's completion evidence, version 9, below);
* every row lies in the lines its stage sealed; malformed nested evidence is a named finding of its cell, never a crash or an empty success.

From revision 9 (review 9 R2; contract version 4) every admitted or refused P-11 and P-W2 cold run carries the one observation it was classified from
(`tests/e2e/profile-cold-outcome.ts`): the request's step, the state published when that step ended and the trace line that ended it, and the commits since
the request. The contract refuses a record whose observation does not show its outcome, whose detail is not the observed state, whose first commit is not
the served page or whose figures are not that commit's; the live W2 application is checked against its own observation the same way.

From revision 10 (review 10's R2 follow-up; contract version 5) that observation is a witness, judged by one rule set shared by the classifiers, the contract
and the device reader (`scripts/lib/profile-outcome-rules.mjs`), against facts the test knows independently of it:

* **One page, one engine start.** The fixture harness names its page instance and logs every engine start (`restartSync` included) and each published
  state's start. An observation names both; a reload or a second start while observing ends the run as an `error`, never a verdict.
* **Everything it rests on is kept and recomputed.** A cold run keeps every state published since its mark (none truncated, however long a `has_more`
  schedule) and every commit and step-end trace event up to the step's end. The request, its end, the terminal state and the commits are recomputed from
  them and must equal what the record claims, in the engine's order: a normal end publishes its state and then traces it; a failed step traces its failure
  and then publishes `stopped/local_storage`; a commit precedes the state it leads to.
* **The served bytes are bound.** The first commit after the request must record the bytes served: a P-11 workload's recorded size, or W2's limit-1 capture
  as its capture row records it (which the capture cell certifies against the file). Idle needs that commit applied and traced before the idle. A refusal
  may have no commit, and keeps the one it had after a `has_more` continuation.
* **The live dense commit is the trace's.** It must be the retained trace's line at its recorded position, inside the epoch and before the observation, the
  first there of at least 90% of the captured limit-1 bytes, with the idle published after it; the recorded live commits are the trace's.
* **The live end is corroborated (revision 11; contract version 6).** The live witness (`live-dense-commit/3`) keeps, from the one evaluation that found
  its end, every state published since its mark and the raw line of every commit and step end of its engine start before its boundary. The step end that
  completes it is derived from that slice: a normal end (`data.sync_next`) must record the state published last at its line, and a failed step
  (`data.sync_step_failed`) must be followed by its `stopped/local_storage` stop with nothing between. Running after a `has_more` page, a back-off, a pause, a
  wait, or idle before the dense page continue the observation; idle with the dense commit traced before it admits, any stop refuses, and a contradictory
  end is an `error`. The claims (dense commit, step end, the publication it rests on) must equal what is derived. The retained lines must be the trace
  file's at their positions, no step event inside the boundary may be missing, and the trace must have been read from the observation's page instance
  (`trace_page`). Lines after the boundary (a later poll, a failure, another start) neither change nor repair the verdict. An applied dense commit must
  have written its page (`value: "committed"`).
* **A measured page is admitted only if it was written (revision 12; contract version 7).** A commit wrote its page only when the transaction applied
  AND the page plan committed (`value: "committed"`); `not_ready`, `lease_lapsed`, a missing or unknown value, a dropped or failed transaction wrote
  nothing, and a missing value is never read as committed. The cold witness (`engine-state-log/3`) follows the MEASURED attempt: the step that made the first
  request ends at its own step end, and only a written page continues past a `running` end (`has_more`); an attempt that wrote nothing and asked again
  completes the observation as no verdict (`error`), so no later response can stand for it. An internal admission round that lapsed before a committed
  round is one committed commit and stays valid. A committed measured page whose own step ended in a refusal is a contradiction; a refusal after its
  continuation stays a refusal.
* **What an admission left is corroborated (revision 12).** Every cold run and device engine run records the cache it left once its measurements are taken
  (`effects`, `cache-rows/1`: the row count and the SHA-256 of the sorted `id@version` of every cache row; a device run reads it after stopping its engine).
  The reader derives what the served bytes leave in the run's new, empty database (applied in order: an upsert replaces, a remove deletes, the last write
  wins) from the regenerated workload or the certified W2 capture, never from the record, and an admission must match it. W4's 800 changes leave 80 rows.
  `changes_written` keeps its meaning (the final row count) and must equal the effects' count. A negative control's admission fails the control whatever it
  wrote, and a W2 run whose capture is itself invalid leaves that defect to the capture cell (the programme is incomplete either way).
* **Each timed sample is one operation (revision 12).** P-2: a sample's scan and commit times are those of the FIRST commit after its start, of its served
  bytes, written, and ended idle; anything else fails the sample (none is dropped or replaced). `raw/P-2.samples.<engine>.json` names each sample's trace
  start, commit and end in `raw/P-2.trace.<engine>.txt`, and the contract recomputes both series from them. (Revision 18 extends this to every warm-up and
  keeps the whole collection: `p2-sample/2`, below.) P-4/P-10 (sync): one page evaluation after the
  step's end reads the trace and the `/sync` ResourceTiming entries; the step start is the first non-coalesced `data.sync_tick`, the commit the first after
  it, and the request the ONE `/sync` entry between them (1 ms trace rounding). A latency sample does not need a written page. The support
  (`samples/P-4.sync.<engine>.json`, `samples/P-10.sync.<engine>.json`) is retained and the segments are recomputed from it.
* **Each request sample is the first step after its mark, closed by its own end (revision 13; contract version 8).** P-4/P-10 (sync): one page call
  waits until no real step is open, then clears ResourceTiming, records the mark (page instance, time origin, engine starts, trace position) and nudges;
  one later evaluation copies together the contiguous trace slice from the mark, every `/sync` entry and the page/engine identity
  (`sync-request-sample/2`). The sample is the FIRST non-coalesced step after the mark: its own first `data.sync_next`/`data.sync_step_failed` closes it
  before its commit or request is looked for. A step that ends with no commit fails the sample at that end (a later step can never stand for it); a
  second real start or commit inside it, a commit or end before any start, a reload or engine start since the mark, a `/sync` entry that began before the
  step or overlaps it without lying inside [tick, commit] (1 ms rounding), not exactly one entry inside, an entry without usable timing or a full
  ResourceTiming buffer are each invalid. Coalesced ticks are retained and never split a step; a later step's lines after the end are retained and
  ignored. Warm-ups follow the same rule; the first incomplete sample stops the collection and is written, with its witness, into the support file
  (`failure`) before the test fails. P-4 draft: one page call waits for an empty queue, marks and enqueues; the sample is the first send
  (`resend: false`) after the enqueue, its first answer with no second send or failed step between, the one `/commands` entry inside them and the draft's
  own recorded outcome (`draft-request-sample/1`, `samples/P-4.draft.<engine>.json`; its completion rule is superseded by revision 14, below); a first attempt that got no answer (not sent, aborted) never donates
  its send. The draft total runs to the observation that read the answer (its line's 1 ms rounding allowed). The contract re-derives every selection from
  the witness with the writers' own rule (`scripts/lib/profile-sample-rules.mjs`), binds each file to its series' engine, stage, invocation and test, and
  recomputes every value; segment definitions are unchanged. Version-7 evidence resolves incomplete and stays history. Limits: ResourceTiming carries no
  request identity, so uniqueness is established by the bounded window (cleared at the mark, no open step, one draft in the queue), not by a request key.
* **A draft sample is complete only by its own dispatch's receipt (revision 14; contract version 9).** The P-4 draft caller starts the fixture outbox with
  `observeDispatch` (`src/fixture/data-harness/dispatch-observer.ts`, a lazy fixture-only chunk): the dispatcher's own commits (claim, receipt, outcome)
  with their ACTUAL outer and inner results, its writer runs, its stamped requests by `Idempotency-Key` and its lifecycle are recorded with a monotone
  sequence, the dispatcher serial and start count and the service serial captured from the actor at the call. The wrappers return the production promises
  unchanged and only append to a bounded log (measured overhead at most about 4 microseconds per wrapped call in Firefox, under 1 in Chromium and WebKit;
  three wrapped calls per sample). The witness (`draft-request-sample/2`) carries the dispatch identity (page, time origin, account and epoch, service
  serial and liveness, dispatcher serial, start count, running) read before and after the queue read (a change refuses before anything is enqueued), after
  the enqueue, at the timing read and on both sides of the completion read; the enqueue's result; the timing read (unchanged: the observation that read the
  answer and its request; `done` is its time); and the completion read, made once the observed receipt has delivered its result: the row read through the
  bound service, then the outbox trace, the dispatch records and the `/commands` entries from the mark. Rule: the identity is complete and unchanged; the
  outbox trace up to the completion read is one first send and one answer of kind `receipt` (a non-receipt answer is outside the measured healthy
  population, a further send, answer or failed step is invalid); the dispatch records are exactly the claim of that draft (applied/claimed), one request
  keyed by it with a response, and one `data.admitReceipt` of it, applied/admitted, all by the sample's dispatcher, start and service at its epoch, and
  nothing else (another draft's dispatch, an unclaim, a failure record, a local-write outcome, a lifecycle change or a second request is invalid); a
  receipt still running, or gated before its transaction is admitted, is pending, never complete; the row corroborates (`removed` means gone, otherwise
  `acknowledged`; a read failure, another waiting draft or a contradiction is invalid, never absence); exactly one `/commands` entry since the mark, inside
  [send, answer] and seen by the timing read. Each mark follows the previous completion read. Segments unchanged: `record` ends at the answer event and so
  does NOT include the receipt transaction (the method text says so); completion time is evidence, not an endpoint. Version-8 draft support resolves
  incomplete and stays history.
* **Completion evidence is checked against its own calls and one interval (revision 15; contract version 10).** The witness is `draft-request-sample/3`.
  Every dispatch record is parsed by its kind (a commit always names its service, plan, local ID and epoch; a request its key and path; a result its call,
  outcome and that outcome's fields); a missing, null, non-finite or mistyped field is malformed, never a wildcard. Every result is its call's only one and
  repeats its call's identity (dispatcher, service, plan, local ID and epoch; a request's key and path); the delivery run is kept and must be the
  sample's. The records' times never go back and lie between the mark and the completion read's end; the outbox lines likewise within their 1 ms
  rounding; each read's record position and its time agree (every earlier record no later, every later one no earlier). The completion read records
  its start (`started_at`, `log_before`) before it awaits the row, and the receipt's result must lie before it: a result delivered during the read cannot
  be corroborated by it. The dispatcher's request path must be its `/commands` entry's. The consumer also refuses a mark taken before the previous
  sample's completion read ended. The six values and P-10's reuse are unchanged; version-9 draft support resolves incomplete and stays history.
* **Every request sample is one closed observation of its exact endpoint (revision 16; contract version 11).** Sync (`sync-request-sample/3`): the mark's
  and the read's own times (`performance.now()`, unrounded) must be finite, non-negative numbers with the mark no later than the read; every retained trace
  line must be timed (the engine trace stamps every line), its rounded times never go back (no allowance between two rounded lines), and each lies inside
  [mark, read] within the trace's 1 ms rounding, judged on the WHOLE retained slice (a later step's lines too) separately from the selection, which is
  unchanged. The engine must have been started (a recorded start and an integer generation; two matching absent generations are not an engine), and the
  buffer count must cover the retained entries. Both request kinds: every retained ResourceTiming entry must be named exactly the pathname the writer
  stores (`/api/experimental/v1/sync`, `/api/experimental/v1/commands`, the API client's `API_BASE`; a query is never part of it; a suffix or substring test
  would admit `/not-sync`) and lie inside the observation on the page clock (sync: [mark, read]; draft (`draft-request-sample/4`): [t0, completion read],
  the selected entry ending by the timing read). Malformed or foreign entries are refused, never filtered out. The draft's request, its result and its entry
  agreeing on another endpoint is refused by the entry's pathname; the dispatcher's request path must still be its entry's. The consumer also refuses a sync
  mark taken before the previous sample's read (a tie is valid), so a whole witness translated earlier with its durations kept is refused; the collector
  refuses such a mark too. Every metric definition, count, workload, throttle and timer is unchanged; version-10 support resolves incomplete and stays
  history. The synthetic programme's sync reads now close after the last line they retain (a labelled harness correction: a later step's tick previously
  followed its read).
* **A draft request is causally its call's, and both buffer snapshots are one buffer (revision 17; contract version 12).** The draft witness is
  `draft-request-sample/5`. The fixture observer records the dispatcher's `request_begin` before it calls the stamped sender, so the call must begin no later
  than its selected entry's `startTime`; it records `request_end` once the stamped sender returned, which needs at least the response headers, so the call
  must return no earlier than the entry's `requestStart`. Both are raw page-clock comparisons with no allowance (`RAW_CLOCK_ALLOWANCE_MS = 0`) and ties valid:
  the 1 ms trace rounding is not a timestamp tolerance. The rule does not require the call to return after the entry's `responseEnd`: a generic fetch may
  return with its headers. The production stamped sender (`fetchFor`) in fact returns a fully read response, which the native control shows (a body held
  at the page's fetch boundary keeps `request_end` unrecorded until it is released); whether the contract should also encode that stronger ordering is left
  to independent review. Each ResourceTiming snapshot must be credible on its own: the timing read's total and its counted requests, and the completion
  read's total, are integers below the 250-entry buffer, the timing read's request count is within its total and the completion read's retained entries
  within its total. Nothing clears the buffer between the two reads (the sample's one clear precedes its mark), so the total must not shrink and entries
  other than the requests must not leave (`bufferLifetimeProblem`); in a complete witness both reads hold exactly the one request, so the second relation
  adds nothing to the first there. Native qualification (Chromium, Firefox, macOS WebKit; 100 healthy samples each, not cross-origin isolated): Chromium
  clamps to 0.1 ms and Firefox and WebKit to 1 ms, so a call and its entry often share a millisecond there (ties); no inversion has been observed. Every
  metric definition, sample count, workload, throttle and timer is unchanged; sync support stays `sync-request-sample/3`; version-11 support resolves
  incomplete and stays history.
* **Every P-2 iteration, warm-ups included, is its own written page, and the whole collection is kept (revision 18; contract version 13).** One collector
  (`collectP2Iterations`, tests/e2e/profile-samples.ts) runs every iteration of every shape: mark, queue the iteration's own body, take the wall start,
  nudge, the unchanged nudge-to-idle wait (the wall end), then one page read. The shared rule (`p2IterationSelection`) judges the iteration before any
  warm-up timing is dropped. It requires one page lifetime and engine start, the body served once with nothing else queued, and the FIRST commit from the
  mark on, applied and committed, of the served bytes, with finite, non-negative scan and commit times. That commit's own step must end idle. Each mark must
  follow the previous read on the same lifetime (`p2SequenceProblem`). Admission rounds that lapse and are retried inside the request leave one committed
  result and remain valid. Three exhausted rounds fail that iteration whatever the engine's later retry does. The first failure in any phase (mark, nudge,
  idle wait, read, selection, long-task read) stops the whole collection, later shapes included; nothing is skipped, replaced or retried. The writer first
  writes the raw trace (create-once) and the stamped `raw/P-2.samples.<engine>.json` (`p2-sample/2`; `/4` since revision 19), then asserts. That file holds the schedule, every
  attempted iteration's mark, read, served-body observation and selection, the first failure, any secondary error, and the trace's line count and
  SHA-256. The writer publishes series only after a complete collection. The contract re-derives every iteration from the trace with the same rules. In
  strict mode it takes the schedule from the programme (four ordinary shapes 20 + 300; dense 5 + 60, 5 + 40, 3 + 25, 3 + 15), never from a row. One
  collection verdict governs every P-2 cell (all four metric families, long-task capability values and the trace cell), so a failed collection with no
  series is invalid, never merely missing. Wall, scan, commit and long-task definitions, sample counts and timers are unchanged. `p2-sample/1` support
  resolves incomplete and stays history. The long-task observer is installed only where the engine lists `longtask` in
  `PerformanceObserver.supportedEntryTypes`. `observe` ignores an unknown type without throwing (Firefox 155 and WebKit 26.6 list none), so the earlier
  writer published an all-zero long-task series there. Those engines now carry the typed `unavailable` capability record. The P-2 lifetime is
  the page instance (the harness's per-load id) plus the engine starts and generation. The time origin is recorded, never compared: macOS
  WebKit derives `performance.timeOrigin` from the disciplined wall clock and moves it on a still page (+1 ms every 92 s under a 10.84 ppm NTP
  frequency correction, measured), so equality would refuse every WebKit collection longer than that.
* **One page lifetime is the page instance, for every sample method (revision 18, A18-T2; contract version 14; Kieran's measurement
  identity decision of 25 October 2026).** `sync-request-sample/4`, `draft-request-sample/6` and `p2-sample/3` bind a sample to the harness's
  per-load page id and, exactly as before, to its engine starts and generation (sync, P-2) or its dispatcher, run, service, account and epoch
  (draft). Every mark, read and dispatch identity still records `performance.timeOrigin`, and a missing or non-finite one is refused, but it
  is never compared: within a sample, across a support file, or in the writer's own early-read and binding checks. A reload or replacement
  always brings a new page id and is refused as before; an engine or dispatcher restart is refused as before. Values, selections, sample
  counts, warm-ups, workloads, timers and thresholds are unchanged: no figure is derived from the time origin (they rest on the page clock,
  ResourceTiming and the engine trace). Version-13 support (`sync-request-sample/3`, `draft-request-sample/5`, `p2-sample/2`) compared the
  time origin, so it resolves incomplete and stays history.
* **Each P-2 iteration's trace lies inside its own observation (revision 19, review 19 R19-P2; contract version 15).** `p2-sample/4` adds
  one relation to the iteration rule, judged on the WHOLE slice from the mark to the read (lines before the selected commit and after its
  end included) by the writer's collector, for the normal poll and the forced read alike, and again by the contract: every line carries a
  time and an event; the times are non-negative (the trace is the page clock's `Math.round(performance.now())`); they never go back
  (equal rounded times are valid, with no allowance between two rounded lines); and each lies within [mark, read] widened only by the
  trace's own 1 ms rounding (the frames carry the page clock unrounded). A contradiction is that iteration's failure: the collection stops
  there with the witness kept, and every P-2 cell of the engine is invalid. The first commit from the mark, earlier noncommitting steps,
  admission retries inside one request, the page/engine identity, the finite recorded time origin (never compared), values, counts,
  workloads and timers are unchanged; P-2 still takes no operation from a tick. `p2-sample/3` (contract 14) accepted such contradictions,
  so it resolves incomplete and stays history. The P-2 writer keeps ONE measuring page: its seeding page closes before collection, and the
  stubbed `/sync` script is the browser context's, not a page's, so served counts and bytes do not prove request ownership among several
  active sync writers. Measuring concurrent writers would need per-request ownership and an agreed workload; that is outside this card's
  current scope, and the chronology relation does not certify it.
* **Device results are schema 4 (revision 12; schema 3 below is its predecessor).** An engine run's detail is the state it ended in and must show its outcome (an admitted run idle; a refused one stopped,
  backing off, paused or waiting for a valid cache; waiting for the session or the network is no verdict), and every run carries its first commit, which an
  admitted run's figures must equal; W5 and killed attempts carry none. Schema 4 adds the run's own observation (made by the page with the same cold
  observer, `src/fixture/data-harness/profile-observation.ts`, and classified with the shared rules BEFORE the result is stored) and its effects.
  Schema-2 and schema-3 files and stored envelopes are history: read as unusable, never upgraded or spliced into a schema-4 protocol.

## What the released backend does (read from its source at the pinned commit, then measured)

* **Sharing gates fields by their person.** A field is visible only while it is shared **and** every ancestor is visible. A field may be shared only with an account that can
  already see its person (`identity_grant_required`). A grant or revocation of a person publishes the person and all of its children in **one** revision
  (`crates/core/src/policy.rs` `put_policy`; `resources/mod.rs` `Grant`/`Revoke`).
* **The densest batch a reader can be sent** is therefore reached by granting a person, creating its dense fields shared with the reader, revoking the person and
  granting it again: one batch of 200 changes (199 checklist fields of 7,402 bytes each, plus the person), 1,520,162 bytes. The legacy `create_field` cannot carry a
  checklist (`400 malformed_request`). A field created with a sharing policy is an online command (`/task-access-commands`); `/task-commands` refuses it as
  `invalid_value`. `/task-commands` takes one command per request and `/commands` at most 20.
* **The 200-change bound.** A revision of more than 200 changes for one account is refused (`batch_too_large`), unless access changed, in which case that account is
  sent into snapshot recovery. Measured: revoking a person with 200 shared dense fields (201 changes) was accepted, and the reader's next `/sync` was answered
  `410 resync_required`. That is the publisher's behaviour, owned by BE-B1; it is not a client requirement.
* **Batches are rendered when read.** A batch is rendered against the reader's current visibility. Earlier batches of the grant/revoke sequence read back empty while
  the person was revoked, and dense after it was granted again (the live engine run committed two dense pages).
* **Oversized bodies.** The backend answers `400 malformed_request` to more than 20 content commands. For bodies of about 0.85 MB and more it answers before it has read
  the whole body, and whether the sender then sees that answer is a race: the delaying proxy reports its own `502`, and a direct Node `fetch` sometimes gets a transport
  error. This is a limitation of the test harness, not of the client: no measured request comes near that size.

## Not measured, and who owns it

* The physical-device measurements and every device-class figure: transferred to WEB-09d before beta (STAGED-ACCEPTANCE-20261011; OD-1 had escalated the
  roster); the package is `docs/profiling-devices.md`.
* The production leader, the first snapshot, a takeover mid-snapshot and a 10,000-resource snapshot: WEB-09b. The production build sends snapshot requests (H9's
  source answer); their measurement is not part of this programme.
* A real freeze or back/forward-cache restore and the composed lifecycle: WEB-08c, with WEB-09d's final acceptance.
* Integrated released-backend acceptance, PostgreSQL, HTTPS deployment, real Safari, installed apps and supported-device dense workloads: WEB-09d.
* `maxInFlight` 2 and 3 (decision D-18 fixes 1).
* `durability: "strict"` against a real on-disk profile (Playwright contexts are ephemeral).
* Delta pages at `limit` 50, and mixed ordinary/dense delta pages (BE-B1 3(d)): not generated.
* **An isolated run of the whole programme.** No figure here is isolated (see above). The final validation runs the programme again on a controller protected from
  other heavy work (about two hours), and its hand-over replaces these figures as the record of reference.

## The device roster (OD-1; the device runs transferred to WEB-09d)

On 10 October 2026 Kieran chose "Desktop now; escalate roster". On 11 October 2026 STAGED-ACCEPTANCE-20261011 moved the physical-device measurements to WEB-09d,
which prepares and runs them on a more complete integrated app before beta; they no longer gate BE-B1/BE-Q23 scoped technical completion. Before a device run, these
are needed: the named floor device for each family (model, RAM, OS); the
mid-range mobile; who runs the protocol, and where; and the HTTPS hosting choice (a local CA the device trusts, or Android `adb reverse`; an external tunnel is the
operator's call). The families are those of Q12: Chrome, Edge, Firefox and Safari on desktop (current and previous majors), Chrome on Android, and Safari on iOS and
iPadOS including the installed web app. They must include the lowest-memory supported device of each family, a mid-range mobile, one desktop, and browsers without a
device-memory signal. The procedure, the validator and the log templates are in `docs/profiling-devices.md`. The device page's protocol now includes **W2**: the
operator picks the hand-over's captured W2 file on the page, every W2 run reads it back and verifies its SHA-256, and the validator checks it against the
hand-over's `W2-hashes.json` (`--w2-hashes`). The programme's `device` stage runs that whole protocol on the three desktop engines with the run's own captures; in a
revision-1 control with attempt 4's captures every engine validated (39 runs over 19 workloads, W2 admitted in five cold runs). Attempt 4's own device-page results
(34 runs over 18 workloads, no W2) are incomplete under the corrected validator.

## Re-take on the composed client

When WEB-09b composes the production leader, the owner it names re-takes P-6 to P-9 and P-13 (the FIXTURE leader becomes the production one), P-4 (the per-request lease
cost under production leadership) and the multi-tab H5 cases (a takeover mid-snapshot; an installed app plus a tab). The WebKit catch-up slowdown with followers (C10) is
one of those re-takes.

## Attempts and isolation

The programme ran completely four times on the same candidate (source fingerprint `4007cf0b…`); every attempt is kept. Attempts 1 and 2 overlapped other cards' work
throughout, which the stage records and, for attempt 2, the continuous samples show. Attempt 3 stopped at its first quiet gate, before any measurement, because the gate
mistook an agent's command line for heavy work; the gate was corrected. Attempt 4 started every profiling stage on a quiet controller. Another card's work still arrived
during parts of its fixture, contention and integration stages. Of its 384 series, 205 are clean, 70 minor and 109 contaminated (`isolation-annotation.json`). The
outcome-type results (admitted or refused, the W2 shape, bytes and live and cold outcomes, the 410 bound) are identical in attempts 1, 2 and 4. The re-takes were bounded at two beyond attempt 2, as
recorded in the execution report.

Review 1 found that the per-series labels did not describe the collection intervals (R1), that the hand-over could state a desktop conclusion without complete
evidence (R2), and that the device package could not run W2 (R3). Revision 1 corrected all three in the tooling; under the corrected method attempt 4 has no
isolated series. An isolated run of the whole programme is part of the final validation; it is listed in the execution report and is not passed until it has run.

Review 2 found that the shell boot was outside the isolation check (R1), that the completeness check accepted a programme without its measurements and a timed-out
negative control (R2), and that WebKit's RSS omitted its renderer (R4); the design assessment added the device page's persistence and ownership (DA-1) and concurrent
writers of one evidence directory (DA-2). Revision 2 corrected all five (`.agtx/execute.md`). Attempt 4 remains history: its rows carry no stage, invocation or raw
linkage, so the evidence contract resolves none of its cells, and its memory is descendant-only.

Review 3 found that observation contents and published figures were still not part of completeness (R2) and that the device page's ownership did not cover manual
runs or a lost tab's capture (R5). Revision 3 corrected both (`.agtx/execute.md`); the complete desktop programme then runs on the MacBook Air under the
operator's hand-over of 10 October 2026, after an independent source assessment. Nothing measured so far is evidence under contract version 2.

Review 4 found that a capture's contents (a non-object page, empty checklists) were still not part of completeness (R2) and that a manual collection had no
recovery once its tab was lost (R5). Revision 4 corrected both (`.agtx/execute.md`); the Air programme still runs only after an independent source assessment.

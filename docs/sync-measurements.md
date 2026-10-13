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
* the device page's file is a protocol's, in plan order, with a terminal state and planned count that agree with it, and every run carries its path's figures;
* every row lies in the lines its stage sealed; malformed nested evidence is a named finding of its cell, never a crash or an empty success.

From revision 9 (review 9 R2; contract version 4) every admitted or refused P-11 and P-W2 cold run carries the one observation it was classified from
(`tests/e2e/profile-cold-outcome.ts`): the request's step, the state published when that step ended and the trace line that ended it, and the commits since
the request. The contract refuses a record whose observation does not show its outcome, whose detail is not the observed state, whose first commit is not
the served page or whose figures are not that commit's; the live W2 application is checked against its own observation the same way.

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

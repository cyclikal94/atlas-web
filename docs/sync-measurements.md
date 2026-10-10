# Sync measurements: the `WEB-09a:sync-profiling` hand-over (WEB-09c)

*WEB-09c, 10 October 2026. UK English. For the authors of BE-B1 and BE-Q23, and for WEB-09b and WEB-09d. The evidence key is unchanged; WEB-09c has owned it since
the WEB-09a closure (BC-20261009). Every figure here was measured on ONE macOS developer machine with Playwright's desktop engines (Chromium, Firefox, WebKit). None
is a pass mark, none stands for a device class, and BE-B1 and BE-Q23 remain blocked: the device roster was escalated (OD-1) and has not run.*

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

## Read this first

* **Desktop only.** No real device, floor device, installed web app or browser without a device-memory signal was profiled. BE-B1 item 2 and BE-Q23 M1 are
  `escalated`, and `needs_finer_pagination` is **undetermined for supported devices**.
* **Fixture and real backend are kept apart.** P-2, P-3, P-5, P-11, P-13, P-Q and P-Q2 use a stub network (the real stamped wrapper and the production engine). P-4,
  P-10 and P-W2 use the released backend (v0.27.0-rc.1, disposable SQLite, loopback, behind the delaying proxy). The sync leader in every case is the FIXTURE test
  leader: production leadership is WEB-09b's.
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

## The decisions, and what the desktop evidence can and cannot settle

| # | Consumer and decision | What the desktop evidence shows | What it cannot settle |
| --- | --- | --- | --- |
| C1 | BE-B1 M1: `N` in [the largest client `limit` in either phase and the default 50, 80] | This client sends `limit` 4 at the unconstrained initial rung and 1 for every other class, step-down only, never above 80 (`src/data/model/config.ts`). The engine asked for `limit=1` in every run here. It sends no snapshot request: the first snapshot is WEB-09b's. Snapshot-shaped pages of 1 to 80 batches (W5) were processed on all three desktop engines | The rung of each device class; the snapshot-phase `limit` (WEB-09b) |
| C2 | BE-B1 D6 / BE-Q23 D1 (joint approver decision): is the 800-change W1 binding, or is the server-reachable W2 enough? | In attempt 4 both were admitted on every desktop engine, in every cold run (W2 also live). W1 is 6,108,903 bytes, 800 changes and 455,214 nodes. W2 from the released server is 1,520,162 bytes and 200 changes (199 dense checklists plus their person), about a quarter of W1 | The decision itself (Kieran); any device |
| C3 | BE-Q23 §4.2: *D(c, b)*, `needs_finer_pagination`, the smallest failing unit | In attempt 4, desktop *D* = 800 dense changes on all three engines (the largest rung of the ladder) and no valid workload failed on a desktop engine. That run predates the completeness inventory, so the hand-over's desktop answer (H8, H9) is drawn only from the final run, and only if its programme is complete | **Every supported device class.** Without the roster, `needs_finer_pagination` stays undetermined |
| C4 | BE-Q23 M7: the cost of finer requests (per-request lease and lock) | Per sync page against the real backend on loopback: about 4 to 7 ms in total (p50), of which pre-issue (capture, lease cover, stamping) is 1.5 to 3 ms. A draft submission: 17 to 33 ms (p50). Behind a 250 ms proxy delay the request is 254 to 255 ms | A 10,000-resource snapshot (WEB-09b); device CPU |
| C5 | BE-B1 item 6 / BE-Q23 M9 (V3): does the client's runtime validator use `SyncPage.batches.maxItems`? | **No.** The scanner enforces its own bounds (80 batches, 800 changes per batch; decision D-10). No file under `src/` reads `maxItems` | — |
| C6 | Frontend: initial rungs 4/1, `floorAfter` 3, step-up disabled, `markerMinBytes`, `syncApplyWatchdogMs`, `maxResponseBytesFor` | W2 at `limit=1` (1.52 MB) is about 1/7 of `maxResponseBytesFor(1)` (11,124,736 bytes). It is above `markerMinBytes` (256 KiB), so the crash-loop marker is written for it. The slowest desktop commit of W1 is far below the 20 s apply watchdog. Nothing was refused, so the floor was never reached | The device classes: every constant stays provisional and unchanged |
| C7 | Q9: `queueWarnAt` 200, `queueWorkingSet` 100, `listPage` 100 | A 200-draft queue drains in about 1.2 to 2.8 s (p50, maxInFlight 1, a stub). 200 dense drafts plus one 1 MiB import drain in about the same time | Devices; a real server's latency |
| C8 | R1: `quotaReserveBytes` (8 MiB) protecting `atlas-auth` | Three pages' stamped requests did not all go out together: 20 of 60 were in flight at once, because another page's requests wait. The `atlas-auth` burst was below what the engines' storage figures resolve. The estimate moves in steps of 4 KiB (Chromium), about 16 KiB (Firefox) and about 1 KiB (WebKit). The derived desktop figure, `max(burst x 4, step x 2)` (an engineering margin, not a measurement), is at most about 150 KB, far below 8 MiB. **The constant is not changed** | Real Safari/iOS estimate behaviour and genuine exhaustion (the roster) |
| C9 | Matrix §3.6.2/§3.6.3: unresolved leases, waits, give-ups, retirements, yield | Desktop figures with a FIXTURE leader, synthetic delays and a synthetic freeze (P-6 to P-9 in the hand-over). The production 20 s give-up was observed at the bound and never earlier | The production leader (WEB-09b), a real freeze or bfcache (WEB-08c), devices |
| C10 | R60 follow-up: the healthy-follower reads that `atlas-sync` hints cause | **Every committed sync page posts `data_changed [cache, sync_state]`, and `sync_state` is also the stop-record store**, so a healthy follower re-reads on every leader page: about 11 IndexedDB transactions per page hint (9 of them on `sync_state`), about 12 to 20 ms per hint (p50). A stop-record hint costs one transaction, and a draft or receipt hint 5. The leader's catch-up throughput was unchanged by followers in Chromium; in WebKit it fell from 70 to 52 and 40 pages/s with one and two followers (series marked `(m)`/`(X)`: a signal to re-take, not a finding) | Devices; the production leader (WEB-09b) |
| C11 | Bundle budgets (OD-2) | One shared ceiling per figure, the signed-in shell's measurement plus 10 %: 241,540 / 7,560 / 92,110 bytes (initial JS gzip / CSS gzip / fonts) from the current candidate's fixture build, 219,582 / 6,873 / 83,736 (revision 1: the device page's lazy W2 route changed the chunk names the fixture entry references; attempt 4 measured 219,586 and the ceiling was 241,545). The production build (107,948 / 6,873 / 83,736) passes it and its own baseline + 10 %. Throttled boot figures are reported below, not judged | Device boot timing (WEB-09d) |

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

* The device roster and every device-class figure: escalated (OD-1); the package is `docs/profiling-devices.md`.
* The production leader, the first snapshot, a takeover mid-snapshot and a 10,000-resource snapshot: WEB-09b.
* A real freeze or back/forward-cache restore and the composed lifecycle: WEB-08c, with WEB-09d's final acceptance.
* Integrated released-backend acceptance, PostgreSQL, HTTPS deployment, real Safari, installed apps and supported-device dense workloads: WEB-09d.
* `maxInFlight` 2 and 3 (decision D-18 fixes 1).
* `durability: "strict"` against a real on-disk profile (Playwright contexts are ephemeral).
* Delta pages at `limit` 50, and mixed ordinary/dense delta pages (BE-B1 3(d)): not generated.
* **An isolated run of the whole programme.** No figure here is isolated (see above). The final validation runs the programme again on a controller protected from
  other heavy work (about two hours), and its hand-over replaces these figures as the record of reference.

## The device roster (escalated, OD-1)

On 10 October 2026 Kieran chose "Desktop now; escalate roster". Before a device run, these are needed: the named floor device for each family (model, RAM, OS); the
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

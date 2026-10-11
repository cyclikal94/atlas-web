# Account-lifecycle evidence (WEB-08c)

The ledger of the composed lifecycle evidence WEB-08c owns (frontend plan §WEB-08c; `account-lifecycle-matrix.md` §2 and traces T4–T14, T17–T24). For each
obligation: where the evidence is, its **layer**, the engines, and what it does not show. Run identifiers and results are in the WEB-08c phase report
(`.agtx/execute.md`) and the review; this file names the evidence so that a later card (WEB-09d, WEB-15) can find and re-run it.

**Layers, never mixed:** L1 unit/component; L2 the real kernel in the fake world (`tests/support/session`, `tests/support/data`); L3 the PRODUCTION build in a real engine
with a STUBBED network (`tests/e2e/auth-stub.ts`: never integration evidence); L4 the RELEASED backend `v0.27.0-rc.1` (SHA-256 verified) on disposable SQLite behind
the delaying proxy (`scripts/integration/run.mjs`, stack `-lifecycle`); L5 real-browser lifecycle and Web Locks (production build, stubbed network); L6 manual
assistive technology; D measurements. Engines are Playwright's desktop Chromium, Firefox and WebKit on macOS unless stated.

**Markers.** The feature screens are placeholders, so the account-specific content a person sees is the rail's verified label (persisted in the account's own database
and shown offline), the account card and the switcher's rows. Every composed trace gives each account a unique username and asserts its absence or presence in the DOM
text, the accessibility snapshot and `document.title`.

## Matrix §2 rows

| Row | Evidence | Layer |
| --- | --- | --- |
| 1/2 confirmed logout / retirement wipe | `operations-logout.test.ts`, `operations-retirement.test.ts` (cited); WEB-09a I-W1 (Keep/Delete consent with real data, cited); T9 (`web08c-traces.test.ts`) | L2; L4 (I-W1) |
| 3 uncertain outcome, 1a | T18/T19 (cited); T10 (`web08c-traces.test.ts`: the retry's `401` is not an outcome; re-authentication on this device → `rejected_stale`, nothing wiped; an empty device → `superseded`, no wipe); E-L7 (`rejected_stale` → 1a.device_changed → "Review this device") | L2; L3 |
| 4/5 hide gate, 1b | T17 (L2 and E-L6, I-L6: password change in another page), T21 (`credential_mismatch`), I-L5 (a real `401`) | L2, L3, L4 |
| 6 ordinary offline not gated | T6 (L2), E-L4 (offline reload renders from the local check; no request) | L2, L3 |
| 7/8 switch and switch back | E-L1 (rail and Settings entry points; outgoing account never perceivable during 1c or under the incoming; no request with the outgoing account's token after the activation), E-L2 (row 7 timing across two pages), I-L1 (the same against the released backend), I-14 and I-O5 (cited: queue isolation) | L3, L4 |
| 9 unresolved lease, 1e | T23 matrices (cited); I-L10 (a real `401` whose recording write fails; every page closed; offline reopening shows 1e.interrupted_offline and nothing of the account; online → the backend's `401` → 1b) | L2, L4 |

## Traces

| Trace | Evidence | Layer |
| --- | --- | --- |
| T4 frozen/resumed tab with an older attempt | `web08c-traces.test.ts` T4; `production.lifecycle-browser.spec.ts` (hidden, then frozen over CDP in Chromium: first frame inert and hidden, nothing focusable, A never shown again, B shown) | L2, L5 |
| T5 reload in each phase | `attempt-reload.test.ts` (cited); E-L4 (reload while exchanging and while activating; HF-4 below) | L2, L3 |
| T6 eligible offline reload | `web08c-traces.test.ts` T6; E-L4 | L2, L3 |
| T7 activation lost or gateway-answered | `web08c-traces.test.ts` T7 (502, 504, dropped, never arrived); `activation-visibility.test.ts` (hidden, cited); E-L3 (502/504/dropped signed out → the 1c.ended card; A valid → A again with the in-tree notice; cookie replaced + `session_revoked` → 1b; live other account → 1d; the cancel offline → 1c.offline, then resolved); I-L2 (real `activate/cancel`, `rewrite_status` and `drop_after_forward`) | L2, L3, L4 |
| T8 holder destroyed mid-activation | `web08c-traces.test.ts` T8 (the late cookie is dead: 1b at the next request); I-L3 (the activating page closed while the backend's answer is held; another page shows A; the cookie unchanged); I-04 (cited) | L2, L4 |
| T9 retirement vs a newer sign-in | `web08c-traces.test.ts` T9 (`rejected_stale` processed after the newer session; `confirmed_applied` delayed past it: no `Set-Cookie`, the newer settlement unchanged, the retired account wiped) | L2 |
| T10 independent retirement, then retry | `web08c-traces.test.ts` T10 | L2 |
| T12 interrupted switch | `web08c-traces.test.ts` T12; I-L4 (the exchange's answer dropped: nothing changed; the next try switches) | L2, L4 |
| T13 retained account with its own fence | `web08c-traces.test.ts` T13; E-L5; I-L5 (the production recovery job catches up with recovery-class reads before the display) | L2, L3, L4 |
| T14 stale identity read | `web08c-traces.test.ts` T14; `stale-response.test.ts` (cited) | L2 |
| T17 password change in another tab | `web08c-traces.test.ts` T17 (and the stale row-5 answer after re-authentication); E-L6; I-L6 | L2, L3, L4 |
| T18/T19 | `operations-logout.test.ts`, `operations-retirement.test.ts` (cited); I-06/I-07 (cited) | L2, L4 |
| T20 | `attempts.test.ts` (cited); E-L3; I-L2 | L2, L3, L4 |
| T21 `credential_mismatch` | `web08c-traces.test.ts` T21; `web08c-k1.test.ts` (K-1); E-L6; I-L7 | L2, L3, L4 |
| T22 resume gate and assistive technology | `production.lifecycle-a11y.spec.ts` (automated counterpart, NOT assistive-technology evidence: branches i, ii, iii with an open protected modal dialog and a held local check; O-3); the manual script in `docs/accessibility.md` (**not run**: OD-1) | L5; L6 open |
| T23 A–P5-N, checks 1–14 | the matrices and suites of WEB-08a (cited; the session matrix runs again in Review because K-1 changed the kernel); real pages: T23 A–D in `production.lifecycle-browser.spec.ts` (a `401` recorded while `atlas-auth` is held by a page whose callback never resolves, surviving the observing page's closure), E/F/L in I-L10; check 13 is fake-matrix only (as the brief states) | L2, L4, L5 |
| T24 and the Q20(c) display gate | `recovery-api.test.ts`, `tests/data/recovery-job.test.ts` (cited); E-L5, I-L5; I-N4/I-N5 (cited) | L2, L3, L4 |

## Checks (a)–(j) of the frontend plan

(a) T5, T6, T23 E–H/L/M/O/P (above); (b) T13; (c) T24; (d) T10, T18, T19 (the Q11/B7 ledger of the released binary; BE-Q11-B7 has no completion record and is not
claimed); (e) T4, T5, T7, T8, T14, T20, T21, T23; (f) T9, T18, T19; (g) T6, T23 J/I4/P3/P5-J/K; (h) T12, E-L1, I-L1 (and I-O5 for the queue); (i) T13; (j) T22.

## Real-browser requirements

| Requirement | Evidence | Status |
| --- | --- | --- |
| The resume gate's first frame is neutral and inert | `production.lifecycle-browser.spec.ts` T4 (Chromium CDP freeze; Firefox and WebKit hidden by `visibilityState` override) | desktop engines; native backgrounding in real Safari/Firefox is WEB-09d's |
| A lock held by a frozen page: waiters wait 20 s, see "Another tab is finishing a sign-in", never steal | `production.lifecycle-browser.spec.ts` (a page frozen inside its `atlas-auth` callback; the product's own sign-in waits the full 20 s); I-23d (cited) | three engines |
| The held lock neither delays nor drops an observation (T23 A–D) | `production.lifecycle-browser.spec.ts` | three engines |
| P-lock-a (liveness after the owner went) | close: three engines; crash: **unavailable** under Playwright (the CDP crash disposes or hangs the shared context, observed twice) | crash → WEB-09d |
| P-lock-c (held while frozen / in the back/forward cache) | frozen: Chromium (CDP); back/forward cache: probed per engine (recorded as an annotation; not restored in these engines → unavailable, handed to WEB-09d) | Chromium only |
| P-lock-b (latency, a measurement) | `production.lifecycle-browser.spec.ts` `@measure` (five samples per engine, written to the run's evidence tree) | measured |
| A frozen owner with a request outstanding (the §2.6 waits decision) | `production.lifecycle-browser.spec.ts` `@measure` (Chromium): another page shows "Waiting for another window", never displays on the held lease, and displays once the owner resumes and its request ends | decision: no change (`docs/data-handover.md`) |

## Findings and historical failure families recorded by WEB-08c

* **K-1** (kernel, fixed): `credential_unverified` not replaced by `drift`/`invalid_session`, an unbounded re-verification (docs/session.md, revision 6).
* **K-2** (WEB-09b's recovery job, fixed): a `failed` report made during a gate stranded the page on state 3 (`docs/data-handover.md`).
* **HF-1** (WEB-08b's Firefox Settings navigation after settlement): a click delivered inside the session re-check that follows a settlement (a few ms of `1e.checking`, the
  tree torn down and mounted again with a new router at the current URL) navigates nowhere; the location is kept. Trace-proven (`.agtx/evidence/WEB-08c/hf1/`), a test-ordering
  defect of the helper `shownAs` (now repeats the click until the card is drawn); the forced ordering and its control are in `production.lifecycle.spec.ts`.
* **HF-2** (Firefox): "An IndexedDB transaction that was not yet complete has been aborted due to page navigation", when a test navigates a page away on purpose (the
  back/forward-cache probe). An aborted transaction commits nothing; tolerated in exactly that test, in Firefox, with the exact message.
* **HF-4** (WebKit): a fetch that the departing document's own reload cancelled ("… due to access control checks") reported as a page error (the old page's terminal
  `activate/cancel`); tolerated in exactly the two reload cases, in WebKit, with the exact message.
* **HF-5** (harness): the delaying proxy's `rewrite_status` and `replace_response` forwarded the backend's headers (including `Set-Cookie`) although documented not to; corrected.
* **HF-6** (WEB-08b's `boot-handoff.test.tsx`): an unhandled "window is not defined" after every test passed: the never-unmounted neutral
  root's scheduled passive-effect flush outlived the file's jsdom on a loaded host; that test's roots are now inert (it asserts call order only).
* **HF-7** (`protected-tree-join.test.tsx`): a "text gone after dismissal" query also matched the announcer's live region, which receives the
  same words one animation frame later by design; the test now checks the notice itself.
* **HF-8** (WEB-08b's `production.auth-public.spec.ts`, sign-in-offline; a flake of the accepted base: Firefox 3 of 30 runs on the base, 2 of 30
  on the candidate): the test's own offline step cuts the lazily loaded sync leader's module loads (the product retries on `online`), and its own
  navigation then aborts the retried leader's first transaction. That one surface tolerates exactly those messages (Firefox; WebKit's
  "Failed to load resource: WebKit encountered an internal error", whose text names no URL).
* **HF-9** (open, for the review): once, in Firefox, T22 (i)'s page stopped answering right after the resume with its held local check; Firefox
  then killed eight scripts, each at a trivial first statement (the signature of a stalled content process, not of a loop). Not reproduced in
  50 runs (30 at the usual load, 20 at a load average near 400). Cause not established; not re-run for a pass.
* **The fixture bundle**: WEB-08c's shell-side code took the fixture build's initial JavaScript from 240,479 B (base) to 241,970 B after three
  reductions (`.agtx/evidence/WEB-08c/budget/`); operator decision FB-20261010-08C-14A re-recorded the fixture baseline and fixed its ceiling at
  266,167 B (`docs/packaging.md`). The production build is within its unchanged budget (108,620 B ≤ 109,795 B).
* **Measurements** (the campaign's `@measure` cases; figures, not thresholds): P-lock-b, from the owner's `401` answer to the grant of another
  page's pending request for the owner's lease lock, five samples per engine: Chromium 3.1–3.5 ms, Firefox 3–4 ms, WebKit 4–13 ms. A frozen owner
  with a request outstanding (Chromium): the other page waits ("Waiting for another window"), never displays on the held lease, and displays
  within 38 ms (an upper bound including the test's polling) of the owner's request ending.
* **O-1**: a brief state-3 flash between a gate's end and the recovery job's next step (K-2 withdraws it within milliseconds).
* **O-2** (WebKit): the public sign-in form can be drawn once more just after it appears, dropping a value typed in the first ~50 ms.
* **O-3**: a local check held for 5 s or more meets the kernel's 5 s cover-stall bound and fails closed (the tree is closed and the account displayed again through a new
  exposure; unsaved text and focus are not restored). The matrix's T22 illustrates its delay with "5 s"; the property (j) is shown with a 4 s hold. A decision on the
  bound is not WEB-08c's to take (it is WEB-08a's reviewed constant).
* **O-4**: after an account change the new account's tree opens at the current URL, so a Settings dialog route opens again for the new account; focus lands in that
  dialog (never in the old account's tree), not on the main heading.

## What none of this shows

Real Safari, mobile devices or installed apps; native backgrounding; a crashed renderer; assistive technology itself (T22's manual runs are open); PostgreSQL; HTTPS
with a real certificate; a real identity provider; the formal completion of BE-Q19, BE-Q11-B7 or BE-CH2 (L4 runs against the pinned release and closes no gate).

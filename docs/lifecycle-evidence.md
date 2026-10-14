# Account-lifecycle evidence (WEB-08c)

The ledger of the composed lifecycle evidence WEB-08c owns (frontend plan §WEB-08c; `account-lifecycle-matrix.md` §2 and traces T4–T14, T17–T24). For each
obligation: where the evidence is, its **layer**, the engines, and what it does not show. Run identifiers and results are in the WEB-08c phase report
(`.agtx/execute.md`) and the review; this file names the evidence so that a later card (WEB-09d, WEB-15) can find and re-run it.

**Layers, never mixed:** L1 unit/component; L2 the real kernel in the fake world (`tests/support/session`, `tests/support/data`); L3 the PRODUCTION build in a real engine
with a STUBBED network (`tests/e2e/auth-stub.ts`: never integration evidence); L4 the RELEASED backend pinned by `contract-pin.json` (`v0.28.0-rc.1` since the merge of
11 October 2026; earlier L4 runs were `v0.27.0-rc.1`; SHA-256 verified by the runner) on disposable SQLite behind the delaying proxy (`scripts/integration/run.mjs`, stacks
`-lifecycle` and `-lifecycle-restart`); L5 real-browser lifecycle and Web Locks (production build, stubbed network); L6 manual
assistive technology; D measurements. Engines are Playwright's desktop Chromium, Firefox and WebKit on macOS unless stated.

**Markers.** The feature screens are placeholders, so the account-specific content a person sees is the rail's verified label (persisted in the account's own database
and shown offline), the account card and the switcher's rows. Every composed trace gives each account a unique username and asserts its absence or presence in the DOM
text, the accessibility snapshot and `document.title`.

## Matrix §2 rows

| Row | Evidence | Layer |
| --- | --- | --- |
| 1/2 confirmed logout / retirement wipe | `operations-logout.test.ts`, `operations-retirement.test.ts` (cited); WEB-09a I-W1 (Keep/Delete consent with real data, cited); T9 (`web08c-traces.test.ts`, I-L8 T9); **I-L11** (trace 7: Keep/Delete after an initiator crash either side of the durable `awaiting_consent` write, every page closed) | L2; L4 |
| 3 uncertain outcome, 1a | T18/T19 (cited, and **I-L8**: every variant a browser can reach, with the account's database and a draft, every page closed, a new page); T10 (`web08c-traces.test.ts`; I-L8 T19 Q3 is its same-device retry); E-L7 (`rejected_stale` → 1a.device_changed → "Review this device") | L2; L3; L4 |
| 4/5 hide gate, 1b | T17 (L2 and E-L6, I-L6: password change in another page), T21 (`credential_mismatch`), I-L5 (a real `401`) | L2, L3, L4 |
| 6 ordinary offline not gated | T6 (L2), E-L4 (offline reload renders from the local check; no request) | L2, L3 |
| 7/8 switch and switch back | E-L1 (rail and Settings entry points; outgoing account never perceivable during 1c or under the incoming; no request with the outgoing account's token after the activation), E-L2 (row 7 timing across two pages), I-L1 (the same against the released backend); **I-L12** (revision 2, Q-L1: the PRODUCTION leader, a ready queued command of A whose first attempt a gateway refused before the backend; nothing of A (key or body) while B is settled; B's own command accepted; after the return ONE replay, byte-identical body and key, A's new session's token, applied once to A only) and its variants I-L12b/I-L12c (below); I-14 cited; I-O5 cited for its OWN scope only (a test-owned outbox the test stops and starts, so it cannot detect a production ownership failure) | L3, L4 |
| 9 unresolved lease, 1e | T23 matrices (cited); I-L10 (a real `401` whose recording write fails; every page closed; offline reopening shows 1e.interrupted_offline and nothing of the account; online → the backend's `401` → 1b) | L2, L4 |

## Traces

| Trace | Evidence | Layer |
| --- | --- | --- |
| T4 frozen/resumed tab with an older attempt | `web08c-traces.test.ts` T4; `production.lifecycle-browser.spec.ts` (hidden, then frozen over CDP in Chromium: first frame inert and hidden, nothing focusable, A never shown again, B shown) | L2, L5 |
| T5 reload in each phase | `attempt-reload.test.ts` (cited); E-L4 (reload while exchanging and while activating; HF-4 below) | L2, L3 |
| T6 eligible offline reload | `web08c-traces.test.ts` T6; E-L4 | L2, L3 |
| T7 activation lost or gateway-answered | `web08c-traces.test.ts` T7 (502, 504, dropped, never arrived); `activation-visibility.test.ts` (hidden, cited); E-L3 (502/504/dropped signed out → the 1c.ended card; A valid → A again with the in-tree notice; cookie replaced + `session_revoked` → 1b; live other account → 1d; the cancel offline → 1c.offline, then resolved); I-L2 (real `activate/cancel`, `rewrite_status` and `drop_after_forward`) | L2, L3, L4 |
| T8 holder destroyed mid-activation | `web08c-traces.test.ts` T8 (the late cookie is dead: 1b at the next request); I-L3 (the activating page closed while the backend's answer is held; another page shows A; the cookie unchanged); I-04 (cited) | L2, L4 |
| T9 retirement vs a newer sign-in | `web08c-traces.test.ts` T9 (`rejected_stale` processed after the newer session; `confirmed_applied` delayed past it: no `Set-Cookie`, the newer settlement unchanged, the retired account wiped); **I-L8 T9** (both orders against the backend, with a second page signing in on the same device; the database and draft kept, or the old data wiped and the newer session alive) | L2, L4 |
| T10 independent retirement, then retry | `web08c-traces.test.ts` T10 (both branches); **I-L8 T19 Q3** is the same-device retry (re-authentication on this device → `rejected_stale`, the recovery session never deleted, nothing wiped). The different-device branch is L2 only: see "Reconciliation" below | L2, L4 |
| T12 interrupted switch | `web08c-traces.test.ts` T12; I-L4 (the exchange's answer dropped: nothing changed; the next try switches) | L2, L4 |
| T13 retained account with its own fence | `web08c-traces.test.ts` T13; E-L5 (revision 2: the retained name is a precondition, `untilRetainedName`); I-L5 (the production recovery job catches up with recovery-class reads before the display); **I-L13** (revision 2, below) | L2, L3, L4 |
| T14 stale identity read | `web08c-traces.test.ts` T14; `stale-response.test.ts` (cited) | L2 |
| T17 password change in another tab | `web08c-traces.test.ts` T17 (and the stale row-5 answer after re-authentication); E-L6; I-L6 | L2, L3, L4 |
| T18/T19 | `operations-logout.test.ts`, `operations-retirement.test.ts` (cited); I-06/I-07 (cited: the ledgers without a restart); **I-L8** (`integration.lifecycle-restart.spec.ts`: T18 A, B, C, D and T19 P, Q1/Q2, Q3, S3/S4, each with the account's database and a draft, every page closed, a new page; the identical keyed call, the ledger and the browser's database list asserted) | L2, L4 |
| T20 | `attempts.test.ts` (cited); E-L3; I-L2 | L2, L3, L4 |
| T21 `credential_mismatch` | `web08c-traces.test.ts` T21; `web08c-k1.test.ts` (K-1); E-L6; I-L7 | L2, L3, L4 |
| T22 resume gate and assistive technology | `production.lifecycle-a11y.spec.ts` (automated counterpart, NOT assistive-technology evidence). Revision 2: the hold targets the IDENTIFIED display read only (the `atlas-auth` transaction the `visible` handler creates inside the dispatch, held 5 s from its creation; exactly one read-only transaction asserted), and every gate/inert change is logged, so the oracle (`holdViolations`) covers the whole interval: nothing exposed before the held read was delivered or before 5 s after `visible`; branches i, ii, iii with an open protected modal dialog; "Checking your account" announced politely exactly once; (i) Y's main heading focused with one polite "different account" line and no name; (iii) the keyed field and its text, and in a separate run the scroll position, restored; a no-hold control; sensitivity: synthetic 4.9 s release/lift cases and a real-engine 4.0 s case the oracle must flag; O-3 at 6.5 s, beyond the display read's 6 s bound (human decision T22-READ-BOUND-20261012). The manual script in `docs/accessibility.md` holds the same transaction (manual runs transferred to WEB-09d, WEB-15 collecting: **not run**) | L5; manual open |
| T23 A–P5-N, checks 1–14 | the matrices and suites of WEB-08a (cited; the session matrix runs again in Review because K-1 changed the kernel); real pages: T23 A–D in `production.lifecycle-browser.spec.ts` (a `401` recorded while `atlas-auth` is held by a page whose callback never resolves, surviving the observing page's closure), E/F/L in I-L10; check 13 is fake-matrix only (as the brief states) | L2, L4, L5 |
| T24 and the Q20(c) display gate | `recovery-api.test.ts`, `tests/data/recovery-job.test.ts` (cited); E-L5, I-L5; I-N4/I-N5 (cited for their own stimuli); **I-L13 R1/R2** (revision 2: composed with A→B→A, a queued command and an unfinished form; revision 3: under the continuous display oracle); revision 3: **LR-1 to LR-10** (`fixture.lifecycle-recovery.spec.ts`) and the WEB-09b E-R cases under the oracle; branch by branch in "T24 branches" below | L2, L4, L5 (production leader, real engines) |

## Checks (a)–(j) of the frontend plan

(a) T5, T6, T23 E–H/L/M/O/P (above); (b) T13; (c) T24 (I-L13 and the branch table below); (d) T10, T18, T19 (the Q11/B7 ledger of the released binary, I-L8; BE-Q11-B7 has no completion record and
is not claimed); (e) T4, T5, T7, T8, T14, T20, T21, T23; (f) T9, T18, T19; (g) T6, T23 J/I4/P3/P5-J/K; (h) T12, E-L1, I-L1, I-L12, I-L12b, I-L12c (I-O5 cited for its own scope); (i) T13; (j) T22.

## Reconciliation of the T9, T10, T18, T19 variants and trace 7 (R5 of the review of 11 October 2026)

Every variant is placed once. "I-L8"/"I-L11" are composed L4 cases (released backend, production boot and leader, the account's database and a draft, every page closed
where the variant says so); "L2" is the fake world's case, cited by name.

| Variant | Evidence | Why not L4, where it is not |
| --- | --- | --- |
| T18 A (never reached, session valid) | I-L8 T18 A; `operations-logout.test.ts` variant A | — |
| T18 B (never reached, session revoked) | I-L8 T18 B; L2 variant B | — |
| T18 C (committed, response lost, cookie dead) | I-L8 T18 C; L2 variant C | — |
| T18 D (another account when the person returns) | I-L8 T18 D; L2 variant D | — |
| T19 P1–P4 (applied, response lost) | I-L8 T19 P1–P4; L2 "P1 to P4" | — |
| T19 Q1/Q2 (not processed, cookie valid) | I-L8 T19 Q1/Q2; L2 | — |
| T19 Q3 (not processed, re-authenticated on the device) | I-L8 T19 Q3; L2 "Q3" | — |
| T19 S3 (a grant issued for this device, not redeemed) | I-L8 T19 S3 (revision 2: its own baseline; after the `rejected_stale` the SAME grant G1 with its own verifier V1 activates, and `current()` identifies the new session; the cancelled-grant control is refused, so the oracle detects a destroyed grant); L2 S1–S8 | — |
| T19 S4 (that grant redeemed before the retirement is processed) | I-L8 T19 S4 (revision 2: G1 itself redeemed; `rejected_stale`, nothing deleted, no fresh-token retry, and G1's session still answers `current()` afterwards); L2 | — |
| T19 S5 (retired elsewhere and recreated) and the I-07 STALE case (a new session on the device) | I-07 STALE (cited, component 1); L2 | the restart adds nothing to a stale answer, which never retries |
| T19 S1, S2, S6, S8 (a subscription, a native handoff, retention cleanup, a session expiry) | L2 S1–S8 | not driven through the browser API in a test run (no web subscription or native handoff surface; retention cleanup and expiry are server time) |
| T19 S7 and T10's different-device branch (`superseded`) | L2 S7, T10 | any re-authentication in this browser adds a session to its own device, so its identical call can only be `rejected_stale` (I-L8 T19 Q3) |
| T9, both orders | I-L8 T9 (two cases); L2 T9 | — |
| Trace 7, crash before / after the durable `awaiting_consent` write, "Delete them" / "Keep for now" | I-L11 (four cases); WEB-09a I-W1 (cited) | — |

The crash is the page being closed with a named, test-only IndexedDB fault that aborts the `awaiting_consent` write (I-L11, "before"), never a product hook. After a crash
before that write the outcome is already recorded (`pending`): the reopened page waits in 1a, and the person's fresh sign-in runs the canonical procedure FIRST (EC-42),
which re-checks the digest and asks; nothing is deleted or rendered meanwhile.

## T24 branches (revision 3, R5 of the review of 14 October 2026)

The revision-2 table left B′, C2, C3, D, F, G and H(i)–(iv) "L2 only". Revision 3 maps every branch to COMPOSED evidence: the production session,
boot and leader (`/__session?leader=production`) in Chromium, Firefox and macOS WebKit with real Web Locks, IndexedDB and BroadcastChannel and a
scripted `/sync` (the working-client checks T24 itself specifies), plus the released-backend journeys of `integration.lifecycle.spec.ts` where the
backend, the cookie or the switch is the point.

**The continuous display oracle** (`tests/e2e/display-oracle.ts`; qualified by `fixture.lifecycle-oracle.spec.ts`: a healthy held recovery reports
nothing; a mount, an `inert` removal by attribute and by property, an `aria-hidden` removal, a protected title and an account name shown elsewhere,
each made AND undone in one task, are each reported; a page that escaped enrolment fails the setup check; a kernel that lets an exposure through a
fence (two-site build mutant) is reported). It decides, in every page of the context, that the page mounted or lifted an account only while the last
`atlas-auth` record THAT PAGE saw committed (followed at each transaction's `complete`) names the account settled with no fence entry, from before the
application boots to the end of the case. It is T24's "`#protected-root` is never mounted before step t6", observed over the whole interval rather
than at the end. It runs in every case below, in every case of `fixture.data-recovery.spec.ts` and `fixture.data-leader.spec.ts` (an added
end-of-case check; their own assertions are unchanged), and in I-L13 R1/R2, I-L14 and I-L15.

**Revision 4 (R5 of the review of 14 October 2026; design assessment P1, DA-H1, S13-S16).** The revision-3 observer saw only `inert`/`aria-hidden` and
read a text node at its final value, so an existing control's accessible name and a text set and reset in one task went unseen (the review's two probes).
It now watches every name-bearing attribute (`aria-label`, `aria-description`, `aria-roledescription`, `aria-valuetext`, `aria-placeholder`,
`aria-labelledby`/`aria-describedby` resolved to their targets' text, `title`, `alt`, `placeholder`, `value`, `label`) on every element, keeps
character-data old values, and judges EVERY value written, reconstructed per target (attribute: element + namespace + name; text: node); a node inserted
while no episode is open is judged on its earlier values and again when it is removed; nested insertions are judged on their whole subtree; a direct
write to the `<title>` text node is judged on the value written; `aria-hidden="false"` is a lift; the title setter no longer discards other records.
Coverage counts every DOCUMENT each page loaded (closed and replaced ones too) against its enrolments, asks every open document to drain and acknowledge
what it holds, and treats an uninspectable document or a reached recorder limit as incomplete, never clean. What the PERSON enters into a form field is not a disclosure (HF-14: the first form of this revision reported the
usernames the I-L13 journeys type into the sign-in form while the other account is fenced, because React mirrors a controlled input's value into its
`value` attribute): the value of each `input` event is recorded per element and a `value` written equal to it is not judged; a value the page writes
without the person's input still is (qualified both ways; mutant OR-8). Every production-session fixture caller
checks the account's verified name (`FIXTURE_ACCOUNT_MARKERS`): LR, and now E-R/E-B too. Qualified in three engines (`fixture.lifecycle-oracle.spec.ts`
"Q1 (revision 4)": persistent and transient accessible names, transient text, replaced text, nested attribute-only marker, insert-change-remove,
per-target attribute and text, title text node, `aria-hidden="false"`, an aborted `atlas-auth` write that authorises nothing, the consumer vocabulary, a
replaced unenrolled document, a closed page's violation, and a healthy control of safe writes), with eight harness mutants OR-1 to OR-8 (each caught
in three engines, with its unmutated control) and the revision-3 product mutant rebuilt on this source (AB-1: reported). The review's own probes pass
unchanged. An injected DOM value is a conservative proxy: it does not prove a person perceived it, and none of this is manual assistive-technology evidence.

**Retained work** is compared WHOLE (drafts, command bodies, pending effects, unfinished forms; canonical JSON) at every boundary before the display;
replay is allowed only after it (T24 E).

| Branch | Composed evidence (three engines) | Stimulus and assertions | Differences from the trace, and why they cannot change the invariant |
| --- | --- | --- | --- |
| A valid cursor | **LR-1**; E-R1; I-L5 (released backend, switch); I-N4 (cited) | Two catch-up pages, the first with an ACCESS REMOVAL; the final page held, then `finish` held after the final data commit; a follower opened mid-recovery. Each data commit is atomic with its cursor; the fence stands and both pages are hidden at both held boundaries; the work is byte-identical; the follower reads nothing; each page displays through its own exposure; the queued draft is sent once, after, with its own key | The fenced record and the database are seeded (T24's setup, not the UI's re-authentication, which I-L13/I-L5 compose against the backend) |
| B 410 → replacement | **I-L13 R1** (released backend, A→B→A, under the oracle); E-R2; LR-2's first half | 410 on the return's first recovery page; the replacement activated, `finish` cleared, then the send; body and form byte-identical | — |
| B′ 409 mid-snapshot | **LR-2** (recovery mode) | 410, a snapshot whose second staged page answers `409 access_changed`: the staged generation is abandoned and never active, the old cache stays and is hidden, a new generation is asked cursor-less, the replacement is activated whole, only then the clear | E-B9 is the ordinary-mode counterpart (not fenced) |
| C recovery-time 401 | **LR-3**; I-L13 R2 and E-R3 keep their own (first-read) scope | The FIRST page commits, the SECOND answers 401: the recovery request's own surrender (kernel `surrender`, class `recovery`, status 401, epoch 2) records a current-epoch entry; the committed page stays; nothing more is read; hidden; a re-authentication at epoch 3 keeping both entries resumes from the committed position and clears both | Re-authentication is another tab's settlement (`settleElsewhere`); the backend's revocation is I-L13 R2's |
| C2 aborted recording, every page gone, offline reload | **E-R3b** (WEB-09b, now under the oracle); I-L10 (released backend, ordinary class) | The recovery's 401 whose recording is ABORTED; every tab closed; an offline reload reads and counts nothing; online, the session's own verification records the current-epoch entry and the account stays hidden | The recording path is the same for both classes (`handleOrdinaryAnswer`); E-R3b exercises it for the RECOVERY class |
| C3 `finish` NOT_ELIGIBLE | **LR-4** | After the final data commit, while `finish` waits for its lock, another tab records a current-epoch entry: `finish` answers `not_eligible`, both entries stay, nothing is shown or sent | — |
| C3 (RERUN) | **LR-5** | The entry added is of the OLDER epoch above the captured `s`: `finish` answers `rerun`, keeps it, a second catch-up clears both | — |
| D failed page commit | **E-R4** (DataError ×3, state 3, the visible "Try again", under the oracle); **LR-6** (quota) | LR-6, per **WEB08C-T24D-QUOTA-20261014**: an injected `QuotaExceededError` on the page's second row: none of the page is durable (one transaction), the cursor stays, the fence stands, `storage_full` and state 3 at once, no automatic retry; a FOLLOWER page shows state 3 too and its "Try again" makes the leader ask for the whole page again, which applies; then the clear and the display | Decision WEB08C-T24D-QUOTA-20261014 (`atlas-orchestrator/delivery/handoffs/web08c-t24d-quota-20261014.md`, SHA-256 `b96141c4…3430`; authority `approval/WEB-08c-T24D-quota-20261014.json`, `211fce9d…5ffbb`) replaces the quota-specific automatic-retry wording only. The follower's state 3 needed the revision-3 correction K-3 (`docs/data-handover.md`) |
| D, follower and quota stop (revision 4) | **LR-11** to **LR-16** | LR-11 (the review's R9 schedule and its control): the leader's completion report is LOST, the follower displays from its own read; LR-12: the follower's "failed" is lost while it shows "Catching up", it keeps asking and shows state 3 and Try again; LR-13: every recovery report and auth hint of the leader is lost, the visible follower displays by its scan; LR-14 (DA-N1): offline/online, visibility and time send nothing after a quota stop, Try again fetches the page once from the same position; LR-15: the stop survives a reload of the tab (its marker); LR-16 (accepted limit D2): a refused marker gives a memory-only stop, no retry in the surviving page, ONE attempt after a reload, which stops again | Per WEB08C-T24D-QUOTA-20261014 and RECOVERY-NAVIGATION-ENROLMENT-20261014 (D1/D2) |
| E retained drafts | every LR case; E-R11; I-L12/I-L12b/I-L12c, I-L13 R1/R2, I-L14, I-L15 | Whole retained work byte-identical until the display; recovery sends no write and no ordinary request | — |
| F crash between commit and clear; failed t5 | **LR-7** (offline reopening); E-R6 (online reopening); E-R7 (lock timeout), E-R7b (aborted release transaction) | LR-7: the page closes after the data commit and before the clear; the next page boots OFFLINE: the fence stands, nothing is ASKED (counted before the stub's offline refusal) or shown; online, the recovery reads from the committed position and clears at once | — |
| G second re-authentication | **LR-10** (the old epoch's read in flight); E-R7/E-R7b (after a failed `finish`); LR-3's epoch 3 (after a recovery-time 401) | LR-10: the epoch-2 answer, released after the epoch-3 settlement, is dropped and writes nothing; the new epoch reads from the saved position, catches up and clears | — |
| H(i) current-epoch unresolved lease | E-R13 | resolved by the session's verification before anything is read | — |
| H(ii) operation entry | **LR-8** | the leader binds nothing for the account (row 3): no read, the job idle, the operation's card (`1a.*`) shown; its resolution (T18/T19) is I-L8's | — |
| H(iii) `credential_unverified` | E-R10, E-R14 | refused, then resolved by the session's own O11 verification in the same epoch, then the recovery runs | — |
| H(iv) older-epoch orphan lease | **LR-9** | the dead page's epoch-1 lease is converted (E5) and cleared by the recovery's `finish` | — |
| H, other refusals | E-R12 (gating attempt), E-R8 (current-epoch entry) | as titled | — |

Recorded survivors of revision 2 stay as they were: QL1-F and QL1-G (the forbidden-send oracle; blocked by the dispatcher's identity/epoch checks and the
session stamp, caught only by the B save) and QR2-a (an ordinary 401 not recorded; another detector recorded the fence). Revision 3 attributes the
recovery-class 401 directly (LR-3's kernel `surrender` of class `recovery`).

## Outgoing-session variants of the switch (revision 2, Q-L1–Q-L3; revision 3, S2/S3)

| Variant | Evidence |
| --- | --- |
| Valid outgoing session, ready queued command, no logout | **I-L12** (and the restart variant I-L12c) |
| The switch refused at the activation (failed attempt) | **I-L12b** (`refuse` 503 `device_capacity`, never forwarded: A stays, its command is sent once under A's ORIGINAL session); E-L11b (production stub, without a queued command) |
| Outgoing session revoked/expired | I-L5, **I-L13 R1/R2** (A's session revoked, then B, then A: the queue and form survive; one send after the recovery) |
| All pages closed while B is settled | **I-L12c** (reopened page shows B and sends nothing of A; back to A, one send) |
| Confirmed logout instead of a switch | I-W1 (cited: the consent count, the database and queue deleted, nothing sent, an empty queue at the next sign-in); I-L11 |
| Ordinary OFFLINE queue, then reconnect, across a switch | **I-L14** (revision 3, S2): A's command queued while the page is offline at the application's boundary (nothing leaves it; the body is durable); back online every attempt is refused at a gateway until B is settled (a one-shot refusal let the dispatcher apply it to A before the switch: a correct send, but no switch); nothing of A while B, B's own command accepted; back to A: one replay, identical body and key, applied once to A only |
| Lost answer / leader takeover with the same key (Q-L2) | **I-L15** (revision 3, S3): the backend APPLIES A's command and the answer is lost (`drop_after_forward`); the leading page closes before its retry; the other page takes over and retries A's command (refused at a gateway until A → B); nothing of A while B; back to A the retry carries the identical key and body and the backend applied it ONCE, to A only. I-O1 (cited) is the same-page lost answer |

Sensitivity (integration A/B, `.agtx/evidence/WEB-08c/revision-2/ql1-ab/`): a save that does not wake the leader's dispatcher (MU-1232) fails I-L12's B control; a
410 handled as a plain failed read fails I-L13 R1. Two leader faults that bind the previous account's queue (QL1-F, and QL1-G which also presents it as the new account's
service) did NOT produce a forbidden send: the dispatcher's own identity/epoch checks and the session's stamp blocked A's body (recorded survivors of that oracle; caught by
the B save). A 401 not recorded by the ordinary-request path (QR2-a) did not fail I-L13 R2: the current-epoch fence was still recorded (another detector; not traced).

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
* **K-2** (WEB-09b's recovery job, fixed): a `failed` report made during a gate stranded the page on state 3 (`docs/data-handover.md`). **Completed in revision 1
  (R3 of the review of 11 October 2026):** when the gate ended BEFORE the admission wait's first probe (an activation refused at once), that probe took the ungated record
  as its baseline and the wait never saw a change; `recovery.begin` now returns the admission revision of the read it decided on, the wait starts from it, and the revision
  covers `latest_epoch`. E-L11 (re-authentication refused at the activation, before processing) and E-L11b (a switch refused likewise) return to the account with the
  refusal in three engines.
* **R1** (revision 1): cancelling a switch or "Confirm it's you" while the exchange was outstanding did not cancel the attempt, and the late grant activated. Leaving the
  credential step now cancels the owned attempt (`attempts.cancel`, which also marks it in page memory so a late grant is discarded and its activation never issued);
  E-L10 in three engines, `web08c-cancel.test.ts`.
* **R2** (revision 1): an indeterminate re-authentication dropped its return destination; it is kept, and a request's terminal cleanup drops only its own.
* **HF-1** (WEB-08b's Firefox Settings navigation after settlement): revision 1 called it a test-ordering defect and repeated the click. Revision 2 traced the
  cause on a temporarily kernel-traced production build (`.agtx/evidence/WEB-08c/revision-2/hf1-probe/`): after a settlement, and at any page's boot, every OTHER
  displaying page made identity reads of its own (its resume verification and its CSRF token); each answer surrenders its lease (§3.6.1 rule 14), so the page that had
  just signed in, watching that lease, found it unresolved and closed its tree for 4–11 ms (Chromium, Firefox). A click in that window never reached a link. A
  product defect (WEB08D-NAVIGATION-FRESHNESS-20261011), corrected by human decision HF1-SHARED-CONFIRMATION-20261013: the settlement's CSRF token and confirmation are
  shared through `auth_state.confirmation` (`docs/session.md`), so no page needs an identity read for 30 s after a settlement. The single click is restored, unadapted,
  in `production.auth-flows`, `production.lifecycle` and `integration.lifecycle`; "HF-1 correction" asserts the mechanism (no identity read after the settlement, the
  signing-in page's tree never closes, one click lands). The forced-ordering hint case remains. WEB-09d verifies the original single click again in the integrated
  client before beta. A later page boot or resume verification can still close other pages briefly (at most once per 30 s per browser).
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
  "Failed to load resource: WebKit encountered an internal error", whose text names no URL). Revision 1: Firefox once cut `browser-env`, the next
  module of the same lazy chain (its warning names `browser-leader` as the importer); the Firefox tolerance now names the chain's three modules
  (`browser-leader`, `browser-env`, `dexie-adapter`, as the WebKit trace listed them) and nothing else.
* **HF-9** (open, for the review): once, in Firefox, T22 (i)'s page stopped answering right after the resume with its held local check; Firefox
  then killed eight scripts, each at a trivial first statement (the signature of a stalled content process, not of a loop). Not reproduced in
  50 runs (30 at the usual load, 20 at a load average near 400). Cause not established; not re-run for a pass. Revision 1 adds a bounded,
  instrumented diagnostic of the original schedule (in-page heartbeat; on a stall, the Firefox processes' states and native stacks): see the
  WEB-08c report. **Revision 3 (R6 of the review of 14 October 2026):** the external watchdog is qualified for its result handling (its exit
  status is the child's, 3 when it fired; a capture running when the child exits is awaited and marked complete or not; the Playwright runner
  and worker processes are sampled beside the browser's; four self-checks met their declared outcomes) and the bounded diagnosis ran: both
  reference schedules 10 times each and the UNCHANGED T22 (i) test 10 times under the watchdog with every protocol message logged: no stall.
  The original log's distinctive lines (the password manager's synchronous-message fallback, "Script terminated by timeout" at the hide)
  appear in EVERY healthy run, so they do not discriminate; its `FormHandlerChild … destroyed` lines belong to the forced teardown. No mechanism
  is established. **Human decision WEB08C-HF9-HF13-20261014** (`atlas-orchestrator/delivery/handoffs/web08c-hf9-hf13-20261014.md`, SHA-256
  `4d6c6616…bc15`): an unresolved, unreproduced diagnostic risk (not passed); the investigation transfers to WEB-17 (named outstanding item; hand-over in
  `docs/data-handover.md`); WEB-09d keeps its ordinary pre-beta Firefox acceptance; any recurrence (WEB-08c's Review, WEB-09d's Firefox acceptance, later campaigns) reopens it, captured with the qualified
  watchdog. Not D5's disposition; no assertion, timer or engine coverage relaxed.
* **HF-10** (revision 2, Firefox, `fixture.session-neutral`): a web font's download started 1 ms before the test's next `goto` was cancelled by that navigation, and
  Firefox logged it as a console error. Test ordering: each width now waits for `document.fonts.ready` before navigating again; no message is tolerated.
* **HF-11** (revision 2, WebKit, E-L10): "index-….js was preloaded using link preload but not used within a few seconds". The lazy chunks (`react`, `sections`,
  `SwitchFlow`) listed the ENTRY chunk among their `modulepreload` dependencies (already so in the merged base); the entry is always already executed, so the preload
  was never used. `vite.config.ts` now drops the entry (`index`, `fixture`) from dynamic-import preloads (`tests/static/module-preload.test.ts`); budgets unchanged.
* **HF-12** (revision 2, Firefox, `production.auth-public` "join-offline"): the loop set the context online and navigated 2 ms later; the `online` event had started the
  offline page's session re-check read, which the navigation aborted (the HF-2 message). Test ordering: the page now leaves before going back online; nothing tolerated.
* **HF-13** (revision 2, OPEN, Chromium, `fixture.session-gate` "visible … focus returns to the control that had it"): once, on a pool runner, focus was not on the
  keyed control after the lift (1 failure in 62 pool runs of that case). Not reproduced by targeted probes (identity reads answered while hidden or 0–40 ms after the
  resume, three engines) or 40 repeats of the original schedule; cause not established. A failure now attaches every page's kernel trace (diagnostic only).
  **Revision 3 (R8 of the review of 14 October 2026): a product defect that produces exactly this failure, corrected.** The original trace shows the keyed
  link still in the DOM after the lift (no remount; the saved target existed). The protected surface's deferred heading focus (waiting up to 120
  animation frames for the router's heading after a mount) was not cancelled by the level-0 gate and focused the heading even after focus had moved
  inside the tree, so an attempt still waiting from the mount could run after the restoring lift and take focus (key `null`). Shown deterministically:
  jsdom (`resume-gate.test.tsx`, HF-13 describe) and real engines (`fixture.session-gate.spec.ts`, every animation frame held from boot: fails on the
  previous build in three engines, passes on the corrected one); MU-8C-HF13b–d; a build with the restoration suppressed fails the original assertion in
  three engines. Excluded by measurement (`.agtx/evidence/WEB-08c/revision-3/hf13-probe/`): the neutral heading's effect decides in its own sync-lane
  commit while the gate is open (React 19.3 flushes those passive effects in the commit), and in the unmodified schedule the mount's attempt runs in the
  same frame as Playwright's successful poll. Which path campaign 7 took cannot be proved from its trace (Playwright snapshots carry no focus); the
  original assertion is unchanged, its precondition is now asserted at the focus step and at the hide, and a failure attaches a record of every focus
  writer with its stack. **Human decision WEB08C-HF9-HF13-20261014** (same hand-off): accepted as resolved by the product correction, subject to independent
  verification of the correction, its before/after evidence and detector sensitivity, the residual uncertainty stated; a recurrence
  reopens it.
* **The fixture bundle**: WEB-08c's shell-side code took the fixture build's initial JavaScript from 240,479 B (base) to 241,970 B after three
  reductions (`.agtx/evidence/WEB-08c/budget/`); operator decision FB-20261010-08C-14A re-recorded the fixture baseline and fixed its ceiling at
  266,167 B (`docs/packaging.md`). The production build is within its unchanged budget (108,620 B ≤ 109,795 B).
* **Measurements** (the campaign's `@measure` cases; figures, not thresholds): P-lock-b, from the owner's `401` answer to the grant of another
  page's pending request for the owner's lease lock, five samples per engine: Chromium 3.1–3.5 ms, Firefox 3–4 ms, WebKit 4–13 ms. A frozen owner
  with a request outstanding (Chromium): the other page waits ("Waiting for another window"), never displays on the held lease, and displays
  within 38 ms (an upper bound including the test's polling) of the owner's request ending.
* **O-1**: a brief state-3 flash between a gate's end and the recovery job's next step (K-2 withdraws it within milliseconds). Revision 1: the review showed the
  flash could become permanent (R3); with the baseline fix the withdrawal no longer depends on a probe seeing a change.
* **O-2** (WebKit): the public sign-in form can be drawn once more just after it appears, dropping a value typed in the first ~50 ms.
* **O-3** (revised in revisions 1 and 2): a display read held BEYOND its bound is a stalled store and fails closed (the tree is closed and the account displayed again
  through a new exposure; unsaved text and focus are not restored). A check held for EXACTLY 5 s used to meet the 5 s bound's timer in the same batch, and the engine's
  timer order decided (restore failed in 2 of 5 Firefox and 4 of 5 WebKit runs). Revision 1's general 250 ms grace was withdrawn in revision 2 (it let an ordinary lease
  completing at 5,200 ms send: R4); the display read alone now waits 6 s (human decision T22-READ-BOUND-20261012), every other bound is a hard 5 s, and O-3 runs at 6.5 s.
* **O-4** (fixed in revision 1): after an account change the new account's tree opened at the old account's address, so a Settings dialog route opened again for the
  new account and focus went into it. A tree for a DIFFERENT account than the page mounted last now starts at `/` (matrix 3.7.2, lifecycle row 7); T22 (i) asserts the
  main heading's focus.
* **The resume gate's polite status** (revision 1, R4): the gate's `role="status"` message was empty while the local check was pending, so "Checking your account" was
  never announced as a status (the first cycle's test accepted none). It now says so once per opening when the page is shown again with the gate up (matrix 3.7.2
  "Read pending", T22 t4).

## What none of this shows

Real Safari, mobile devices or installed apps; native backgrounding; a crashed renderer; assistive technology itself (T22's manual runs are open); PostgreSQL; HTTPS
with a real certificate; a real identity provider; the formal completion of BE-Q19, BE-Q11-B7 or BE-CH2 (L4 runs against the pinned release and closes no gate).

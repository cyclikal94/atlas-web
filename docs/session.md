# The session module (`src/session/`)

The session module is the one place that decides **who this browser is signed in as, whether a request may be sent, and whether anything may be shown**. It
implements the account lifecycle matrix (`account-lifecycle-matrix.md`, section 3) and the canonical deletion procedure of WEB-04 section 7.8. Everything else in the
application asks it; nothing else reads `atlas-auth`, sends a credentialed request, or lifts the gate on `#protected-root`.

**Authoritative account-isolation mechanism.** WEB-04 design section 7 (`web-offline-privacy-design.md`, "Account isolation") is the authoritative statement of how one account's local data is kept
from another: one database per account, the canonical `indexedDB.deleteDatabase()` procedure (section 7.8, steps 0 to 5, implemented in `kernel/wipe.ts`), and the rule that a person sees nothing
of an account until the lifecycle says so. Its `atlas-active-account`, `atlas-session-generation` and `atlas-transition-intent` bookkeeping is **superseded** by the matrix's `auth_state` record (matrix
section 5); the deletion procedure itself is not.

Sources, in order of authority: the lifecycle matrix (protocol), the pinned OpenAPI contract `v0.27.0-rc.1` (wire), WEB-04 section 7.8 (deletion procedure only).
Where this document says "the matrix" it means that file; its wording is not restated here.

## Public interface

`src/session/index.ts` is the **only** import path other slices may use (`tests/session/boundary.test.ts` fails the build on a deep import). It exports:

- `createSession(ports, options)` and the React bindings (`SessionProvider`, `useSession`, `useSessionView`, `useIdentity`, `useApiCompatibility`, `useSessionNotices`);
- the production assembly: `openAuthStore`, `runAuthCanary`, `browserPorts`, `createProtectedSurface`;
- the types of the public surface: `Session`, `SessionView`, `NeutralStateId`, `Attempts`, `Operations`, `Recovery`, `Wipe`, `StampedApi`, `StampedRequestError`, `ApiCompatibility`.

A `Session` carries no account data. `session.view` says what to render; `session.identity` is a **fact** for consumers (the drafts store keys its database by it), **never a
permission**: do not decide to send, render or write on it (matrix G3).

### What each consumer may rely on

| Consumer | Relies on |
| --- | --- |
| WEB-09a (cache, drafts, outbox) | `session.api.client('ordinary', account, epoch)`; the `StampedRequestError` kinds (`not_sent` never counts an attempt; `auth_state` pauses the queue, the session view has already switched to a neutral state; `stale` drops the request **and** an answer that arrives after the identity it was sent under has been replaced. The record is read, and the verdict taken, in **one step**: the body of the store transaction that reads the record decides and hands the answer over there, not at the later delivery of that transaction's completion and not on this page's possibly delayed notice of another page's transition. A transition is therefore ordered before that read (the answer is `stale`, whatever the page has been told) or after the release (the caller already holds the answer, and the transition is not held up by it); a record that cannot be read in time is `stale`. **That read is taken after the call's last decode.** Decoding a buffered body is still asynchronous (`Response.json()` returns a promise and queues the processing as a fetch task), so the typed client (`session.api.client`) and the public Settings operations validate **twice**: when the Response is handed on (which spares decoding an answer nobody will receive) and again, at the record, after the decode (`sealResult`); the application never receives a result decoded under account A after a transition the store had committed before that last read (`closed` is the operations' spelling of `stale`). The two things that are the **caller's** work, because they happen after the caller holds the answer, are the use of a `session.api.fetchFor` Response (its decode and persistence) and the reading of a `parseAs: "stream"` body; they must check the stamp again inside their own atomic commit, see obligation 4); `closed`, `closed_unresolved`, `not_covered`); `session.identity` to key its database; `compat` for the queued-submission pause; it must **register** the wipe's data ports (below) |
| WEB-09b (recovery) | `session.api.client('recovery', …)`; `recovery.begin(account)` and `recovery.finish(handle)`; `recovery.report('catching_up' \| 'failed' \| null)` drives neutral states 2 and 3 |
| WEB-08b (registration, OIDC) | `attempts.begin / completeExchange / markRedirected / landing / cancel`; `AttemptOutcome`; the 1c cards; `start({ beforeStart })` is where the OIDC fragment capture goes (before anything else runs) |
| WEB-08c (lifecycle traces) | everything above, the fake platform (`tests/support/session/`), the integration harness and delaying proxy (`scripts/integration/`, `tests/integration/`) |
| WEB-13a (calendar) | the Settings registry entry point and the named `calendarLine` slot (below) |

### Obligations this slice creates for WEB-09a

1. Register an `AccountDatabasePort`, a `LocalWorkPort` and a `WipeCoordinationPort` (including `setDraftFence`) through `browserPorts({ deletion })`. The defaults
   (`adapters/default-deletion.ts`, decision D-14) say "no local stores yet": `exists` **refuses** (`adapter_missing`) when an `atlas-<account>` database exists, so the wipe
   can never conclude "nothing to delete, nothing unsynced" about data it cannot see.
2. Pass the count of unsynced changes through `LocalWorkPort.summarise`; the logout and retirement dialogs recheck it at confirmation and show "Actually N changes - still log out?"
   when it moved.
3. Honour `StampedRequestError` kinds and `compat` (pause submissions when the status is `unsupported` or `missing`).
4. Check the stamp again **inside the atomic commit** of every response the cache, the drafts store or the recovery job applies (matrix 3.7.3: "the stamp is re-checked at the commit"). The wrapper drops an answer that arrives after a
   transition: the record is read and the verdict taken in **one step** (the body of the store transaction that reads the record), so a transition the store ordered before that read is seen by it, and one ordered after it happens after
   the answer was handed back; no notice and no completion is waited for. For `session.api.client` and the public Settings operations that read is taken **after their last decode** (`sealResult`; revision 4), so the decode of the body is
   inside the validated call and nothing but microtasks lies between the verdict and the application's promise. **What remains, and is the reason this obligation stays, is the caller's own asynchronous work after it holds the result or
   the Response:** a transition committed by another page after the answer was handed back is ordered after it, but the cache write, the draft update or the next page of a recovery runs later still, and only the persistence commit can be
   ordered against a transition that falls between. That includes the decode of a Response obtained from `session.api.fetchFor` (a buffered body whose `json()` is still asynchronous) and the reading of a `parseAs: "stream"` body.
   (Revision 3 stated that the typed client's decode was caller work after the release; that was wrong for the typed client and the operations, and is corrected by revision 4 below.)
   An invalidating answer (`401`, `credential_mismatch`) hands back nothing, so it is classified by the page's own copy of the settled identity and its recording is stamp-checked where it commits: it is never applied to the new account, but
   with a delayed notice it can be reported as `auth_state` rather than `stale`.

## Module map

```
src/session/
  index.ts          the public interface
  model/            pure: types, records, invariants, reducers (one per transaction body), render permission, neutral-state derivation, API version
  ports/            interfaces only: store, locks, hints, clock/ids, page, surface, transport, deletion, trace
  adapters/         browser implementations: idb-auth-store, web-locks, broadcast-hints, browser-page, protected-surface (the ONLY importer of the gate),
                    canary, deletion-ledger, default-deletion, browser-ports
  kernel/           the protocol against ports: state, activity, cover, observation, send, identity, expose, evaluate, closing, attempts,
                    operations, recovery, wipe, compat
  ui/               React bindings (no gate imports)
src/lib/api-client/ boundary.ts (THE send boundary), unstamped.ts (login-family calls and /health), wire.ts, problem.ts, transport.ts
src/components/ui/  neutral-state.tsx, gate-dialog.ts
src/features/settings/  sections.ts (registry), sessions-devices/, your-data/
src/fixture/        FIXTURE ONLY: session-harness, neutral-page, session-double (never packaged: `check-no-fixture`)
```

Dependency direction: `model` imports no I/O (its only repository imports are two **type-only** ones, `ports/store` for `Rmw` and `app/capabilities` for `CapabilityIssue`);
`kernel` imports `model`, `ports` and the pure api-client helpers, and touches no DOM, `navigator`, `indexedDB` or `fetch`; `adapters` assemble ports from browser globals.
`src/lib/api-client` never imports the session (the transport port types live in `api-client/transport.ts` and the session port re-exports them).

## Boot sequence (`src/app/boot.tsx`, called by `src/main.tsx` and by the fixture harness)

1. The static shell has already loaded gated (`#protected-root` inert and `aria-hidden`, neutral gate visible). Nothing below lifts it except `act`.
2. Synchronous `checkCapabilities()`, then `probeCapabilities()` including the **`atlas-auth` canary** (one small write of `boot.last_boot_at`; a failure is `indexeddb: failed`).
   Any issue: `CompatibilityScreen`, nothing else, and `start()` is not called.
3. The protected tree is loaded by a dynamic import (D-10), so `act` mounts it in one synchronous step with `flushSync`.
4. `createSession(browserPorts(...))` and `session.start()` run **outside** any component effect (React `StrictMode` double-invokes effects); the neutral root only subscribes.
5. `start()` registers the page listeners once, reads `auth_state`, resolves any attempt, re-drives operation fences, recovers pending deletions, starts the API-version check
   in the background, then derives the view: settled and nothing closing it → `expose`; otherwise the neutral state the record names; nothing settled → signed out.

A valid cookie with nothing settled never signs anyone in (matrix 3.4, "Never inferred").

## State inventory and copy map (A1)

Copy is **verbatim** from `wireframes/behaviour/reconnect-to-confirm.html` (decision D-15); its "Engineering note (not product copy)" paragraphs never ship. A test compares every
rendered state with a copy deck extracted from the wireframe **by script** (`tests/components/neutral-copy-deck.ts`), and asserts no engineering-note text and that no state-1a
text promises that unsent changes "will send" (row 3 may end in a wipe). The heading is the programmatic focus target (`tabindex="-1"`). Component: `NeutralState`.

| State | Wireframe card | Live region | When |
| --- | --- | --- | --- |
| `1a.confirming` | 1a, "Confirming your last action" | status | an operation fence exists and no call is in flight |
| `1a.checking` | 1a, "Checking what happened" | status | the fence's call is being (re)sent |
| `1a.device_changed` | 1a, "This device changed after you confirmed" | status | a retirement was `rejected_stale`; nothing was removed |
| `1a.ended_elsewhere` | 1a, "This session had already ended" | status | the session was already removed by another cause |
| `1b` | 1b, "Reconnect to keep going" | alert | a detected invalidation (`invalid_session`) |
| `1c.finishing` / `1c.offline` / `1c.lock_wait` / `1c.superseded` / `1c.resolving` / `1c.ended` | 1c cards | status | a sign-in attempt is gating, or ended |
| `1d` | 1d, "This browser is now signed in as a different account" | alert | `drift` (no name is ever shown) |
| `1e.checking` | 1e, "Checking your account" | status | the resume gate's neutral screen, or a hold |
| `1e.session_online` / `1e.session_offline` | 1e, "Checking your session" / "Reconnect to check your session" | alert | an unverified `credential_mismatch` |
| `1e.read_failure` | 1e, "We couldn't check your account" | alert | `atlas-auth` could not be read or written. **Fails closed:** whatever is displayed, mounted or being reserved is closed in the same step, before the card is published, and the page displays again only through a new exposure |
| `1e.interrupted_online` / `1e.interrupted_offline` | 1e, interrupted-request cards | status (never an alert) | an unresolved request lease |
| `1e.waiting` | 1e, "Waiting for another window" | status | another window's request is outstanding (after 2 s) |
| `2` / `3` | "Catching up" / "Couldn't finish catching up" | status | recovery (WEB-09b drives it); also shown after a re-authentication while older-epoch fences remain |
| `wipe.consent` | WEB-04 wireframe 4 | status | a confirmed wipe found changes saved after the confirmation; carries a **count only**, and an opaque `ticket` that names this prompt: the choice is applied to the account, operation and consent digest the ticket names, never to "the first entry waiting", and a choice on a prompt that has been resolved or replaced applies nothing and re-derives the prompt (`prompt_superseded`). Validation, the status change and "Keep for now"'s three writes all run inside the account's `atlas-delete:<account>` critical section, so they are serialised with the deletion procedure and with the other page's choice |

The level-0 resume gate is a separate surface (`components/ui/gate-dialog.ts`): a modal `<dialog aria-labelledby>` opened with `showModal()` (so topmost), heading "Checking your
account" focused, a `role="status"` message, Escape does not dismiss it. It is built with the DOM, not React, because it must close over the page **synchronously** inside
`visibilitychange` and `pagehide`.

Precedence when several records hold at once (D-05): operation fence (1a) → gating attempt (1c) → `drift` (1d) → `invalid_session` (1b) → `credential_unverified` (1e) →
unresolved lease (1e) → waiting (1e) → read failure (1e). After a re-authentication, fences of an **older epoch** show 2 (or 3), not 1b.

## Gap report (design and contract)

None blocks anything; G-1 to G-3 are material and need Kieran's acceptance.

| ID | Gap | Treatment |
| --- | --- | --- |
| G-1 | Session rows: the design shows "Chrome on macOS"; `GET /sessions` has no label field | "This browser" / "Another sign-in"; "Password" / "Single sign-on"; signed-in and expiry times. **Material** |
| G-2 | "You have room for 5": the API exposes no device capacity | Omitted; the count the API returns is shown. **Material** |
| G-3 | Device names: `device_id` is opaque and client-chosen | "This device" / "Another device", session count, last sync. **Material** |
| G-4 | The logout/retirement warning and the consent prompt exist only as ASCII in WEB-04 | Implemented verbatim; a rendered wireframe is requested |
| G-5 | Retirement dialog's `DeviceSummary` lines have no accepted copy | Proposed: one line per non-zero component. Not accepted |
| G-6 | The API-version compatibility screen has no accepted copy | Proposed: "Atlas can't work with this server yet" with an unsupported and a missing wording. Not accepted |
| G-7 | WF-SETTINGS-02 says an interrupted retirement is "never an automatic retry" | The matrix governs: the retry is automatic from the envelope and never against changed state |
| G-8 | Unassigned screens: the sign-in form, WF-SETTINGS-01 (account card, "Sign out", "Switch account"), WF-SETTINGS-03, WF-SWITCH-01/02 | Not built; recommended owners in section 1.3 of the plan: sign-in and 03 to WEB-08b, the switcher to WEB-08c |
| G-9 | The rail account slot has no name source (`BrowserSession` carries only `account_id`) | Empty until a profile read exists |
| G-10 | State 1a "Review this device" needs a signed-in Settings surface | `actions.reviewDevice`; the composition root supplies it |
| G-11 | The light theme and narrow widths of the neutral states were unverified in the design files | Measured: both themes at 320, 390, 768 and 1280 px, axe including contrast, in three engines. Visual sign-off remains Kieran's |
| G-12 | WF-SETTINGS-02 says "Sign out" on the current row "takes effect immediately"; Q20(a) requires a warning before a wipe-producing action | A confirmation is always shown; it names unsynced work when there is any |
| G-13 | Wording with no accepted source: why an operation could not start (`REFUSAL`), "still signed in" after a recovered logout (`REMAINED_SIGNED_IN`), the retirement of another device | Proposed wording; flagged for review |

## Settings composition (for WEB-13a)

`src/features/settings/sections.ts` holds the registry; `SettingsHome` renders it and `settingsRoute` builds its child routes from it. To add a section, **append one
entry** (`id`, `label`, `description`, `route`, `order`, `owner: 'WEB-13'`, and a `build(settings)` that returns a route with `staticData: { settingsPage: true }`). Do not
edit `SettingsHome`, `settingsRoute` or another entry. The typed router deliberately does not know registry routes (an `AnyRoute` in the tree would widen every `Link`
in the application); `sectionPath` is the one place that says so. The "Your data" screen exposes the `calendarLine` slot in `your-data/slots.ts`; replace that constant
(WF-SETTINGS-06 tags the line "owner: WEB-13"). The section descriptions are static: they need no request.

## Decisions taken beyond the matrix

- **D-01** raw IndexedDB, no dependency; **D-02** the device id is a record in `atlas-auth` (atomic get-or-create across pages); **D-03** the deletion ledger is in `atlas-auth`.
- **D-05** neutral-state precedence (above); **D-06** the stamped API returns a `Response` or throws `StampedRequestError`; a `401` or `403 credential_mismatch` is never
  returned as a response; **D-07** `recovery.begin` and `finish` belong here; **D-08** the client supports `>=0.27.0 <0.28.0`, derived from `contract-pin.json`.
- **D-10** the protected tree loads before `expose`; **D-12** `neutral-state.tsx` is on the R6 live-region allowlist; **D-13** no `localStorage`, `sessionStorage` or cookie
  in the session or the api-client; **D-14** the default deletion ports refuse when a database exists; **D-19** the tree `act` mounts is the shell with the sync chip reading
  "Updates stopped" (true: nothing syncs), never "Up to date".
- **D-20** a `verifying` attempt with nothing settled clears (nothing is inferred from a cookie); **D-21** an identity read's interim hold refuses requests but closes an
  already displaying tree only once the answer is classified as an observation; **SA-13** a `403` to an identity read carries no CSRF token, so it is a clean, retried outcome.
- **Revision 1 (independent review of WEB-08a, five findings; each has a regression test that fails on the previous behaviour):**
  (1) the renewed-consent choice was applied to the first `awaiting_consent` entry in the ledger, so with two accounts waiting the prompt of one deleted the data of the other: the view now carries
  an opaque ticket, `NeutralActions.consent(choice, ticket)` and `Wipe.resolveConsent(ticket, choice)` verify account, operation and digest (`tests/session/consent-binding.test.ts`);
  (2) a failed read of `atlas-auth` changed the view but left a displayed tree mounted, visible and exposed to assistive technology: `evaluate` now closes the exposure attempt and the tree first
  (`tests/session/read-failure.test.ts`); (3) an answer that arrived after a transition was returned to its caller: `createStampedFetch` reads the body itself and checks the stamp after it (`tests/session/stale-response.test.ts`; the fake
  world gained a `Db` delivery for a late body); (4) a second watch on an orphaned lease was told `in_flight` and its `w:<lease>` hold was never released: the second caller now joins the running verification, reads the record afterwards
  and releases only what was resolved, repeating on the back-off otherwise (`tests/session/watch-holds.test.ts`); (5) hiding the page while the activation waited for `atlas-auth` or its transaction did not stop
  the `/activate` request: hiding marks the activation window, the closing write is abandoned before it commits if the page hid, and the boundary before the request checks again, resolving an already committed `activating` phase by
  the terminal-cancellation protocol (`tests/session/activation-visibility.test.ts`).
  Found by the all-engine suite on the revised code, not by the review: a neutral state rendered while the page is hidden (the provisional `1e.checking` after a late resume verification) took focus from the level-0 gate's heading, which
  WebKit turns into focus on `body` (about 1 run in 20 on a busy machine; the gate spec failed once in a full run). `NeutralState` no longer focuses its heading while the gate is open (`isGateOpen`, `gate-dialog.ts`): the gate owns focus until it lifts (matrix 3.7.2 step 3, "Read pending").
- **Revision 2 (second independent review of WEB-08a, two findings; each has regression tests that fail on the previous behaviour):**
  (1) **the consent choice ran outside the account's critical section.** It read and validated the ledger entry before `atlas-delete:<account>`, ignored the refused status update, and the Delete branch re-entered `run`, which
  recreated a missing entry as `pending` before taking the lock: with two pages showing the same prompt, a page that had captured the entry before the other page's "Keep for now" completed deleted the database the person had just
  chosen to keep, with the work saved after that choice. Now `run` and `resolveConsent` take `atlas-delete:<account>` **first** and perform their whole sequence inside it (the Delete choice continues into the procedure under the same held lock;
  nothing acquires it twice); the status change is committed **against the entry the person answered** (`expect` status and digest, in the transaction), and a refused update is `prompt_superseded`; an entry is created for a
  confirmed operation only while that operation's envelope fence is still in `atlas-auth` (checked in the creating transaction), and a continuation of an entry seen earlier (a fresh sign-in, recovery at boot) never creates one
  (`run(…, { create })`; `tests/session/consent-serialised.test.ts`). **The schedule of the review's reproduction R2 is therefore no longer reachable:** the other page's Keep cannot complete while the first page's Delete holds the lock with its
  read result in flight; it waits, and is refused as superseded after the deletion the person asked for. The test file holds the equivalent schedules (delayed read, delayed status completion, delayed Keep completion, the record changed by a writer that does not take the lock).
  (2) **a response was checked against this page's copy of the settled identity**, which another page's transition reaches only by a notice that can be delayed or lost. `releaseResponse` now reads the durable record in its own
  transaction after the body has been decoded and treats an unreadable or stalled record as `stale`; when the record differs from the page's copy, the page re-reads at once
  (`tests/session/stale-response.test.ts`: delayed, dropped and read-delayed notices; body decoding; recovery and ordinary clients; a failed and a stalled read). The surrender, hold and lease-retirement order is unchanged and runs first.
  The cost is one extra `atlas-auth` transaction per released response (re-profiled, `profiling/`).
- **Revision 3 (third independent review of WEB-08a, two findings; each has regression tests that fail on the previous behaviour):**
  (1) **the read that judged an answer was separated from its release by the delivery of its own completion.** Revision 2 read the record in its own transaction and judged the answer when the transaction's `complete` reached the page; a
  page that was busy (or, in the review's schedule, a completion that was held) let another page settle a different account in between, with that page's notices delayed or absent, and the answer was still released. An additional read
  at delivery would only have moved the interval. The verdict is now taken **in the step that reads**: the transaction body decides and hands the answer over (`checkAtTheRecord`, `releaseResponse` in `send.ts`). IndexedDB runs
  transactions on the store in creation order, so a write that another page created later waits for this one to finish and cannot fall between the read and the release (this page's own settlement is such a transaction too), and a write
  created earlier is seen by the read. **What the review's schedule does now:** the answer is released at the read, before the other page's sign-in (it is not held up by the delayed completion), and the review's unmodified R1 file therefore
  ends with `returned`, not `stale`; the same schedule with the other page's settlement ordered *before* the read (held at the store) ends `stale`. There is no schedule in which an answer is handed back after a transition the store had
  committed before it. Property V6 states this and is checked on every scenario (`tests/support/session/properties.ts`; its own self-test is in `stale-response.test.ts`). **Correction (revision 4): this holds for the Response the wrapper hands on, not for a public call that decodes it afterwards; see revision 4.**
  (2) **the public Settings operations bypassed the check.** `operations.ts` called `send` directly, returned the raw response and decoded it later, so `listSessions()` and `readDevices()` could hand account A's list to a page that
  had settled B. `ordinary()` now passes every clean answer through `releaseResponse`, the boundary of the typed client: the body is read inside the call (a call that needs only the status, such as `revokeOtherSession`, `changePassword`
  and `unlinkOidc`, discards it), and a stale answer is `closed`; the surrender, hold and lease-retirement first step of a self-revoking answer is unchanged and runs before (`tests/session/operations-stale-response.test.ts`). **(Correction, revision 4: the decode of the list that these operations then made was not covered; it is now validated, see revision 4.)** A body that
  cannot be read after its headers arrived (the connection dropped) is `offline` for the operations, where it used to surface as an `http` error from the later decode.
- **Revision 4 (fourth independent review of WEB-08a, one finding; its regression tests fail on the previous behaviour):**
  **the final decode of a public call lay outside the validated boundary.** `releaseResponse` buffered the original body and checked the record, but `operations.ts` then awaited `response.json()` on the released Response, and the typed
  client (openapi-fetch) awaited `response[parseAs]()` after the stamped `fetch` had returned it. Both are asynchronous steps inside the public call, before its promise resolves: `Response.json()` returns a promise and the processing of
  a buffered body is queued as a fetch task ([Fetch Standard, body consumption](https://fetch.spec.whatwg.org/#concept-body-consume-body)), so the decode cannot be assumed to stay inside the read transaction's ordering. A transition
  that completed while it ran (a sign-in as B on the same page, a re-authentication, or another page's, with this page's notices delayed or absent) left `listSessions()`, `readDevices()` and
  `session.api.client('ordinary', A, epoch).GET('/sessions')` resolving with account A's list while the record and the page's identity named B. The fix keeps all decoding before the final validation: the public operations decode inside
  their `read` step and the typed client is wrapped (`createStampedClient`, `src/session/stamped-client.ts`), and each then resolves through `sealResult` (`send.ts`), which reads the identity **at the record after the decode**, in the
  step that decides (the same `checkAtTheRecord`: the transaction body decides and hands the verdict over; a record that cannot be read in time is `stale`), and returns the result with only microtasks between the verdict and the caller's
  promise. The check made when the Response is handed on is kept (it spares decoding an answer nobody will receive, and it serves `fetchFor`). The account/epoch stamp, the first-step surrender and the lease retirement are unchanged,
  and the persistence consumer's own stamp check inside its atomic commit (WEB-09a, obligation 4) is still required. A call that needs only the status (`readBody: false`) decodes nothing, so its first check is its last.
  Tests: `tests/session/public-decode.test.ts` holds the PUBLIC promise unresolved while the decode is held (by wrapping `Response.prototype.json`: instrumentation that places the interval, not a measured delay) for the ordinary typed
  client, the recovery typed client and `listSessions`, `readDevices` and `retireOtherDevice`, across a same-page sign-in as B, a same-account re-authentication (epoch 1 to 2 and, for recovery, 2 to 3), another page's transition with this
  page's notices delayed or absent, a sign-out, a transition ordered before the final read and one ordered after it, plus the typed client's error and empty results; property V7 (a result's release names the decode it follows, and the read
  of the record was made after it) is evaluated on every scenario, with self-tests. Real engines: I-14e (`tests/integration/integration.pages.spec.ts`), the same schedules against the released backend with the production adapters,
  real IndexedDB and Web Locks, in Chromium, Firefox and WebKit. **Still not covered:** the caller's work after it holds the answer (`fetchFor`, `parseAs: "stream"`, the cache write), as above.
- Found by the real-engine gate spec after the fake matrices had passed: a **hidden** page whose tree is still mounted behind the level-0 gate is unmounted when the record
  then closes the **same** account (a fence, a gating attempt). `tests/session/hidden-tab.test.ts` pins it.
- Found by the integration run on WebKit: (1) **Playwright's WebKit left a `fetch` pending after `AbortController.abort()`** (an activation aborted because the page became hidden, response not yet received), so
  the page kept `atlas-auth` and `atlas-attempt-<epoch>` and the attempt stayed `activating`. The page no longer relies on the engine: `src/lib/api-client/abortable.ts` settles every request made through the
  production transports, and the unstamped body read, at the signal's abort (`tests/session/abortable.test.ts`; the protocol already treats an abort as "outcome unknown"). (2) **The Settings lists were
  requested in the moment after display, while the resume verification's interim hold was in force, and `not_sent` was shown as a load error.** `not_sent` means nothing was sent and no attempt was counted, so the
  screens call again (`sessions-devices/until-sent.ts`: bounded, about six seconds) for the two lists, "Sign out" of another sign-in and the retirement of another device; only a window that long is shown as an error.

## Lint rules

R1 (narrowed to the send boundary and the unstamped surface), R4 (only the surface adapter imports the gate) and R6 (live regions) are Biome/GritQL rules; **R7 to R12 are a
syntactic checker**, `scripts/check-session-conventions.mjs`, run by `pnpm lint`, because GritQL cannot express them (see `docs/lint-rules.md`).

## Testing, and what each layer does not prove

| Layer | Where | Proves | Does not prove |
| --- | --- | --- | --- |
| Reducers and model | `tests/session/model/` | every transaction body, invariants I1 to I3 over 2 000 random sequences, the render-permission truth table (240 rows) | anything about time or ordering |
| Fake platform | `tests/session/`, `tests/support/session/` | the protocol against a deterministic world: delays on every completion, both creation orders, crashes; properties V1 to V7, W1 to W3 and P-A to P-I checked on the logs; 16 mutations of the source are each caught | real IndexedDB, Web Locks or BroadcastChannel behaviour |
| Full matrices | `pnpm test:session-matrix` | check 12 (52 488 scenarios), check 13 (4 752), check 14 (2 880) with no violation; the 16 mutations caught over the full products | as above |
| Real-engine fixture | `tests/e2e/fixture.session-*.spec.ts` | the production adapters, the level-0 gate with real `inert` and the real top layer, the rendered screens in both themes at four widths, in Chromium, Firefox and WebKit | a backend; real Safari; assistive technology; freeze and bfcache |
| Integration | `pnpm test:integration` | the session and its adapters in a real engine (Chromium, Firefox and WebKit: 44 specs each, run in two fresh stacks per engine because the backend throttles password sign-ins per source and minute) against the **released** backend `v0.27.0-rc.1` (SHA-256 verified), on a disposable SQLite database, behind a delaying proxy | the WEB-08c traces on a rendered cache; real Safari or a device; assistive technology; PostgreSQL (unless `--postgres` was run: see `.agtx/execute.md`); the unmodified Compose or Ingress arrangement |

Visibility in the real-engine specs is driven by overriding `document.visibilityState` and dispatching `visibilitychange`: a limitation, stated wherever it applies.

## Running things

```
pnpm test                   # unit, component and pairwise fake-world suites
pnpm test:session-matrix    # every scenario of checks 12 to 14 and the mutation search; evidence in .agtx/evidence/WEB-08a/fixture/
pnpm test:e2e               # (ATLAS_E2E_BROWSERS=all for Firefox and WebKit) includes the fixture session specs
pnpm test:integration       # downloads and SHA-256-verifies the released backend, starts it with the proxy on loopback, runs the three engines (two fresh stacks each: everything but I-14e, then I-14e), cleans up
pnpm profile:session        # measurements (not budgets): P-2 to P-6; P-1 is scripts/check-budgets.mjs
```

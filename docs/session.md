# The session module (`src/session/`)

The session module is the one place that decides **who this browser is signed in as, whether a request may be sent, and whether anything may be shown**. It
implements the account lifecycle matrix (`account-lifecycle-matrix.md`, section 3) and the canonical deletion procedure of WEB-04 section 7.8. Everything else in the
application asks it; nothing else reads `atlas-auth`, sends a credentialed request, or lifts the gate on `#protected-root`.

**Authoritative account-isolation mechanism.** WEB-04 design section 7 (`web-offline-privacy-design.md`, "Account isolation") is the authoritative statement of how one account's local data is kept
from another: one database per account, the canonical `indexedDB.deleteDatabase()` procedure (section 7.8, steps 0 to 5, implemented in `kernel/wipe.ts`), and the rule that a person sees nothing
of an account until the lifecycle says so. Its `atlas-active-account`, `atlas-session-generation` and `atlas-transition-intent` bookkeeping is **superseded** by the matrix's `auth_state` record (matrix
section 5); the deletion procedure itself is not.

The current client targets API 0.28.0. Historical integration results below remain attributed to their original 0.27 release; upgrading the pin does not establish new full integration acceptance. WEB-08d owns acceptance of the new management features.

Sources, in order of authority: the lifecycle matrix (protocol), the pinned OpenAPI contract `v0.28.0-rc.1` (wire), WEB-04 section 7.8 (deletion procedure only).
Where this document says "the matrix" it means that file; its wording is not restated here.

## Public interface

`src/session/index.ts` is the **only** import path other slices may use (`tests/session/boundary.test.ts` fails the build on a deep import). It exports:

- `createSession(ports, options)` and the React bindings (`SessionProvider`, `useSession`, `useSessionView`, `useIdentity`, `useApiCompatibility`, `useSessionNotices`);
- `session.persistence.hold(account, epoch)` (revisions 5 and 6, obligation 4 below), the types `Persistence` and `PersistenceHold`, and `unrevokedHold` (a hold that is never revoked, for a double of the session); `LockPort` gained `acquireShared`;
- the production assembly: `openAuthStore`, `runAuthCanary`, `browserPorts`, `createProtectedSurface`;
- the types of the public surface: `Session`, `SessionView`, `NeutralStateId`, `Attempts`, `Operations`, `Recovery`, `Wipe`, `StampedApi`, `StampedRequestError`, `ApiCompatibility`,
  and (revision 5) `RegistrationInput`, `InvitationPreview`, `OidcStartOutcome` and `AccountSummary`, and (WEB-08d) `SessionsRead`.

A `Session` carries no account data. `session.view` says what to render; `session.identity` is a **fact** for consumers (the drafts store keys its database by it), **never a
permission**: do not decide to send, render or write on it (matrix G3).

### What each consumer may rely on

| Consumer | Relies on |
| --- | --- |
| WEB-09a (cache, drafts, outbox) | `session.api.client('ordinary', account, epoch)`; the `StampedRequestError` kinds (`not_sent` never counts an attempt; `auth_state` pauses the queue, the session view has already switched to a neutral state; `stale` drops the request **and** an answer that arrives after the identity it was sent under has been replaced. The record is read, and the verdict taken, in **one step**: the body of the store transaction that reads the record decides and hands the answer over there, not at the later delivery of that transaction's completion and not on this page's possibly delayed notice of another page's transition. A transition is therefore ordered before that read (the answer is `stale`, whatever the page has been told) or after the release (the caller already holds the answer, and the transition is not held up by it); a record that cannot be read in time is `stale`. **That read is taken after the call's last decode.** Decoding a buffered body is still asynchronous (`Response.json()` returns a promise and queues the processing as a fetch task), so the typed client (`session.api.client`) and the public Settings operations validate **twice**: when the Response is handed on (which spares decoding an answer nobody will receive) and again, at the record, after the decode (`sealResult`); the application never receives a result decoded under account A after a transition the store had committed before that last read (`closed` is the operations' spelling of `stale`). The two things that are the **caller's** work, because they happen after the caller holds the answer, are the use of a `session.api.fetchFor` Response (its decode and persistence) and the reading of a `parseAs: "stream"` body; they must check the stamp again inside their own atomic commit, see obligation 4); `closed`, `closed_unresolved`, `not_covered`); `session.identity` to key its database; `compat` for the queued-submission pause; it must **register** the wipe's data ports (below) |
| WEB-09b (recovery) | `session.api.client('recovery', …)`; `recovery.begin(account)` and `recovery.finish(handle)`; `recovery.report('catching_up' \| 'failed' \| null)` drives neutral states 2 and 3; `recovery.onRetry(listener)` (added by WEB-09b review cycle 1, R2) is told when the person presses the neutral state's "Try again" (`actions.retry`), so state 3 reaches the recovery job; it is a request, never a permission, and changes no protection; `api.admission(klass, account, epoch)` (review cycle 2, R3) is a READ of what admits a request now (an opaque digest of the settled stamp, a gating attempt, the account's fences and `fence_seq`, other pages' request leases, and this page's hold, closing write and CSRF token, plus `blocked`), for a caller that was refused before sending and waits for that to change: it writes nothing, takes no lease or lock, and is never a permission; `api.seal(account, epoch, pending)` (review cycle 2, R7) is the public form of `sealResult` for a caller that interprets `fetchFor` responses itself (the data layer's authorised current read): the record is read after the caller's whole result, in the step that decides, and it refuses (`stale`) once the session is disposed |
| WEB-08b (registration, OIDC, sign-in, account and sign-in settings; **delivered, revision 5**) | `attempts.begin`, `signInWithPassword`, `previewInvitation(token)`, `registerWithInvitation(handle, input)`, `startOidc(handle)`, `landing(fragment)`, `cancel`; `AttemptOutcome` (`settled.method`, `refused.stage`) and `OidcStartOutcome`; `operations.readAccount()` and `unlinkOidc(issuer)`. The fragment is captured by `captureHandoff`, the **first statement of `boot()`** (not `start({ beforeStart })`); see "Authentication surfaces" below |
| WEB-08c (lifecycle traces, account switching) | everything above, the fake platform (`tests/support/session/`), the integration harness and delaying proxy (`scripts/integration/`, `tests/integration/`); the seam `settings/account/slots.ts` (`accountActions`, empty: append "Switch account" there); no in-place same-account re-authentication exists yet (gap G-23); `1c.ended` is raised by nothing yet |
| WEB-08d (labels and capacity, BE-Q25; **delivered for review**) | `operations.listSessions()` and `readDevices()` return the BE-Q25 members as received (`client`, `device_name`, `name` and, only when the answer carries them, `session_capacity` and `sync_capacity`), all typed `unknown` and decoded by the Settings feature; `operations.nameDevice(id, name \| null, send?)`; every ordinary change request takes an optional `SendOptions` (`{ withdraw?: AbortSignal }`, revision 2: withdrawn before it is issued, a request is never sent). BE-Q25 derives a label from the activation request's own User-Agent and takes no name at sign-in or registration, so the WEB-08b forms are unchanged and D-8b-13 still holds **for the forms**; naming lives on the device row of WF-SETTINGS-02, and the seam `settings/signing-in/slots.ts` (`signingInExtras`) **stays empty** (D-8d-08) |
| WEB-13a (calendar) | the Settings registry entry point and the named `calendarLine` slot (below) |

### Obligations this slice creates for WEB-09a

WEB-09a has met these four obligations; `docs/data-layer.md` says how (the registered ports, the layered commit guard **and the persistence hold of revision 5 below, which orders every persistence commit against every settlement**, the outbox's handling of `StampedRequestError` and `compat`). An earlier statement that all four were met while a residual window remained was wrong for obligation 4: the window was characterised, not closed. Revision 5 closes it.

1. Register an `AccountDatabasePort`, a `LocalWorkPort` and a `WipeCoordinationPort` (including `setDraftFence`) through `browserPorts({ deletion })`. The defaults
   (`adapters/default-deletion.ts`, decision D-14) say "no local stores yet": `exists` **refuses** (`adapter_missing`) when an `atlas-<account>` database exists, so the wipe
   can never conclude "nothing to delete, nothing unsynced" about data it cannot see. **Revision 8:** `WipeCoordinationPort.setClosing` returns a `ClosingOutcome` (`closing` or `unconfirmed`) instead of nothing, and the wipe does not go on without exactly `closing`: it asks up to `SessionConfig.closingWriteAttempts` (3) times, and then reads no digest, closes no connection, deletes nothing and
   reports `retry_later` with the new reason `closing_unconfirmed`, leaving the ledger entry, the draft fence and the work where they are, so the next entry repeats step 3a and recomputes the consent population. A port that swallows its failure and resolves with nothing cannot authorise a deletion (the third revision review's R12).
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

   **Revision 5: how the persistence commit is ordered against a transition (`session.persistence.hold`).** A commit in `atlas-<account>` cannot be atomic with a read of `atlas-auth` (IndexedDB transactions never span two databases), and a read
   followed by a commit leaves a gap in which another page can settle a transition this page has not been told of; a notice, a hint or a broadcast cannot close it. What can be ordered across databases is a Web Lock, and **every write that
   changes `auth_state.settled` is made while the writing page holds `atlas-auth` exclusively** (`settleAttempt`, which is given the held handle, and the completion of a wipe, `WipeService.complete`). So a persistence consumer asks
   `session.persistence.hold(account, epoch)` (a `PersistenceHold`) before it creates its data transaction:

   - the hold is a **shared** request for `atlas-auth` (granted together with other holds, never alongside a settlement, in queue order) followed, inside it, by the **verdict at the durable record** (`checkAtTheRecord`, the same authority the stamped
     wrapper's release uses: the body of the store transaction that reads `settled`, whatever this page has been told);
   - `held` means the record says `(account, epoch)` is settled **and no settlement can begin until `release()`**: the consumer creates its transaction, waits for its completion (or failure) and releases. A transition committed before the verdict is seen
     by it, and one that has not yet begun is ordered after the persistence, which finishes inside the hold;
   - `stale` means the record names another identity or none: persist nothing. `unavailable` means the lock could not be had within `persistenceWaitMs` (20 s) or the record could not be read: persist nothing, count nothing, ask again. It is
     not an answer about identity;
   - **Revision 6: the end of a hold is a REVOCATION, not a release. Revision 7: and the lock is never given up while registered work is unresolved.** A hold that outlives `persistenceHoldMs` (30 s: a transaction queued behind a long one, a stalled apply) must never leave a
     commit able to persist on a verdict nobody is vouching for any longer. The first version simply gave the lock up at the bound, so a transaction that was still queued in the engine could run after another page's settlement and be applied (the
     second revision review's R2: queue a commit behind a blocking transaction, withhold the other page's notices, wait 31 s, settle another account on that page, release the transaction: `applied`). At the bound, in this order, the hold is
     **revoked**: `valid()` is false and `revoked` (an `AbortSignal`) fires, synchronously, so the data layer aborts a transaction that has not started, is reading or is applying (nothing of it is durable) and starts none; the lock is **kept until
     every promise registered with `track` has settled**, so a transaction that is already committing (it cannot be aborted) completes while the lock is still held and is ordered before any settlement, exactly as an unexpired commit is; and only then is
     the lock released (traced `persistence.timed_out`, then `persistence.released`). A consumer calls `valid()`, starts its transaction with `revoked` and `track`s it in the **same synchronous step**. A holder that registered no work is released at
     once, and `release()` itself waits for registered work, so a consumer cannot give the lock up under a transaction it has not seen end.
     **The wait has no deadline (revision 7).** The second revision gave the lock up `persistenceDrainMs` (10 s) after the revocation even when work was still unresolved, which the third revision review's R2 showed waives the invariant for exactly the transaction it exists
     for: a commit that is already **committing** (its data is not durable yet and will be) cannot be aborted, and from this page cannot be told from one that is durable whose completion has not been delivered; once the lock was gone another page could settle a switch, a
     re-authentication or a sign-out and the old commit could still land after it, with no later ordering fence, and a successful store result was still returned `applied`. Nothing on this page can force a committing transaction to end, so the only safe rule is to wait for it.
     `persistenceStallMs` (10 s, replacing `persistenceDrainMs`) after the revocation, if work is still unresolved, the stall is **traced** once (`persistence.stalled`, replacing `persistence.abandoned`); it releases nothing. **The cost is availability, not privacy**: a settlement
     requested on another page waits for the lock, gives up after `lockWaitMs` (20 s) and retries as every `atlas-auth` request does (a sign-out is refused as `closing_write_gave_up`, a sign-in or switch reports `lock_timeout`), so while an old commit is outstanding the browser shows the
     paused state and the settlement is not made; it is made as soon as the commit ends (whatever its outcome: completed, failed, or the store refusing it) or the page that holds it is closed or reloaded (a Web Lock does not outlive its page). A commit is `applied` only if its
     transaction completed while the lock was still held, so no settlement can be ordered ahead of it. What is NOT shown: a real native IndexedDB commit that stalls for longer than the bound in a real engine (the double's `stall_commit` models it; no real engine was made to), so the real-world duration of such a stall, and
     whether it can occur on a supported device, are unmeasured. The bound (30 s) is kept above the data layer's own apply watchdog (`syncApplyWatchdogMs`, 20 s, which measures the apply alone) with room for the verdict read and the queue, so a slow apply meets the watchdog's step-down and never an endless
     retry (`tests/data/commit-guard-expiry.test.ts` holds the margin at 10 s or more).

   **The premise is tested, not assumed**: the store double of the fake platform records every commit that changes `settled` and the lock manager records who held what, so every scenario of every fake-world suite and of the full matrices is also a check that
   no settlement is made without the exclusive lock (`tests/support/session/store.ts`, property P-F). `tests/session/persistence.test.ts` drives the real kernel; `tests/data/commit-guard-expiry.test.ts` drives the real kernel and the real `DataRuntime` over the store double through every position of a commit at the moment its hold runs out
   (queued, applying, committing and **unfinished** (the engine is still committing, the data is not durable yet), committing with the data durable and only the completion **delayed**, each for far longer than the bound and the stall report) against every kind of transition, with the other page's notices withheld or delivered; `tests/e2e/fixture.data-sync.spec.ts` (E-P1) drives real Web Locks and the real
   `atlas-auth` store, and `tests/e2e/fixture.data-store.spec.ts` (E-P2) the revoked hold over real Web Locks, a real timer and a real Dexie transaction queued behind a real one, all in three engines. What the hold does **not** do: it does not put the data transaction inside the record's transaction (nothing can), it does not cover an invalidation (`401`, `credential_mismatch`) that adds a fence without
   changing `settled`, and a consumer that does not call it has no ordering at all (the data layer's runtime requires it, and a static test keeps the production composition passing `session.persistence`).

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
3. The protected tree, neutral forms and authentication controller load together after the canary and before the session starts (D-10), so `act` mounts synchronously with `flushSync` and no form waits for an import during a session transition. Fragment capture has already run synchronously.
4. `createSession(browserPorts(...))` and `session.start()` run **outside** any component effect (React `StrictMode` double-invokes effects); the neutral root only subscribes.
5. `start()` registers the page listeners once, reads `auth_state`, resolves any attempt, re-drives operation fences, recovers pending deletions, starts the API-version check
   in the background, then derives the view: settled and nothing closing it → `expose`; otherwise the neutral state the record names; nothing settled → signed out.

A valid cookie with nothing settled never signs anyone in (matrix 3.4, "Never inferred").

## Authentication surfaces (WEB-08b, `src/features/authentication/`)

The public surfaces live in `#neutral-root`, drawn by `SessionRoot` (there is no router there). They import neither the gate (R4) nor the portal dialog (R3), and they show **nothing about any account**: before
settlement no name, id or cookie state is known, and nothing is rendered from one.

- **Hand-off capture.** `captureHandoff` is the **first statement of `boot()`**, synchronous, before the capability probes and before any request. It reads the OIDC fragment (`atlas_grant`, `atlas_attempt`,
  `atlas_account`) and, at `/join` only, the invitation token (`t`), and strips the fragment with `history.replaceState(null, '', pathname + search)` **whenever a recognised key is present, valid or not**. An
  unrecognised fragment is left alone. Values are validated (grant and token 64 lower-case hex, attempt digits only, account a UUID): the client always sends `String(epoch)`, so any other attempt is not ours and is
  `invalid` (the backend round-trips arbitrary bytes, I-27r). The fragment is form-urlencoded, so it is parsed with `URLSearchParams`. A fragment-only navigation (another link pasted into the open page) is handled the same way
  (`hashchange`). The token is held in a module variable only: never in storage, the URL, the trace or a log. The OIDC landing continues only after `session.start()`, from the durable record (epoch and phase), never from the order
  things happened in.
- **`SessionRoot`.** Signed out with no state: the compatibility screen if the API refuses it, otherwise `/join` or the sign-in surface (both loaded before the session starts; the 10 October integration splits this whole pre-start load from the capability/boot bundle, without lazily importing an individual form during a transition). A neutral state whose button leads to sign-in
  (`SIGN_IN_STATES`: 1a.confirming, 1a.ended_elsewhere, 1b, 1d, 1c.ended) shows the form on request with **Back** to the card; every other state (all the gating cards, 1e.\*, 2, 3, the consent prompt) **never** shows a form and
  drops the request. A deep link keeps its URL through sign-in (no `next` parameter, so no open redirect); `/join` becomes `/` inside the protected-tree factory, synchronously, before the router exists.
- **The controller** (`controller.ts`) begins an attempt, runs the one exchange the method needs and maps the outcome to a closed result a form can render. Facts that must outlive the form that asked
  (`superseded`, a busy lock, a landing's outcome) go to `authFeedback` (page memory), so they reach the person after the form has unmounted. The kernel's state machine is not involved (D-8b-03).
  **The neutral gate unmounts the form** between the exchange and the activation ("Finishing sign-in"), so a refusal that arrives after the activation belongs to the form that mounts next, not to the one that asked.
  A password refusal is therefore both returned and **carried** (`authFeedback.carryFailure`): the sign-in form shows the carried message, once, and takes it; it is dropped by the next attempt and when an account displays.
  The form does not read `onSubmit`'s return value (review R1).
- **Messages** (`outcome-copy.ts`) are one closed catalogue chosen by the Atlas `code`; the only thing taken from a server is the `request_id`, rendered as text on its own line. Provenance of every string is marked
  [W] accepted wireframe, [D] accepted Claude Design board, or [P] provisional; `tests/features/authentication/copy-conformance.test.ts` compares every [W]/[D] string with the staged files and lists every [P].
- **Registration is never retried by the client** (D-8b-06). An outcome that is not `settled` or a definitive refusal that leaves the invitation usable (a network failure, a non-Atlas answer, an activation refusal after a good
  exchange) shows the wireframe's lost-response state, **drops the token from memory** and offers "Sign in" with the chosen username (never the password). `409`, `422`, `429` and similar keep the form and the token; `401` drops it.
  From the moment the redemption request has been **sent** the only outcomes are "refused and usable" (token restored), "refused as unusable" (`401`) and **spent**: `registerWithInvitation` sends the redemption first, so every
  `not_started` it returns (`hidden`, `lock_timeout`, `wipe_pending`, `closing_write_gave_up`, `attempt_gone`), a `gating` attempt and a `superseded` result describe the **activation of a grant the redemption already returned**,
  never an unsent request. (Only `attempts.begin` can fail before anything is sent; that restores the token.) `invitationMemory` then holds `{ kind: "spent", username }`, a page-memory fact, and `JoinSurface` draws its sign-in
  recovery from it: a surface that mounts after the gate finds the recovery waiting, and a form that is still on screen when a stale result is discarded (a newer attempt failed, so no account replaces the page) is retired
  rather than left submittable. The stale result itself is still discarded (T1); the superseded banner says why this window is not showing the new account. `spent` is forgotten when an account displays (review R1/R2).
  **A result belongs to the invitation that was submitted** (review R5). A different link can replace the open one while a registration is outstanding (a fragment-only navigation: the application strips its token and previews it).
  `invitationMemory.take(token)` therefore returns a per-submission `Redemption` that captures the link generation before anything is sent, and the controller changes page memory only through it: `restore` and `spend` apply only while the
  page still holds the invitation that was submitted (the same generation, or the same token pasted again). Otherwise the newer link is left exactly as it is: the first token is **not** put back, the newer form is **not** retired, and
  what the first submission may have created is remembered as `earlier` (the username only) and told **beside** the newer link, never as it: a fixed [P] status with its own "Sign in" (carrying that username, never a password) and
  "Dismiss", rendered in the banner slot so the form below keeps what the person typed. A recovery card that a newer link displaces becomes `earlier` the same way. `earlier` is forgotten when an account displays or when it is dismissed;
  only the most recent displaced submission is carried. The unbound `restore` and `spend` no longer exist, so no caller can bypass the binding.
- **An unconfirmed credential change stays unconfirmed** (review R3). After a lost response to a password change or an unlink, "Check now" reads `GET /me`. A read that **fails because the session ended** hands the screen to the
  neutral state (success revokes every session), which is the honest end. A read that **succeeds** shows only that the session works *now*: the earlier request may still be queued at a gateway or executing at the backend and
  commit afterwards, so the outcome stays unconfirmed and the screen says so ("You're still signed in, but that doesn't show whether it went through…"). It never says "nothing changed" and never sends the change again.
  The delivered plan (`.agtx/plan.md`, the *Unknown outcome* row) took a working session as proof of failure; that inference is invalid and is superseded by this rule. Released-backend evidence: I-29d.
- **What enters the unconfirmed state** (review R6). A lost answer is not the only way to be unsure. Only an answer that proves the backend did not commit is a refusal: a `4xx`, the same rule as the sign-in exchange's
  (`classifyActivation`, matrix 3.4 step 5). Every other answer to a password change or an unlink that is not a success (`offline`, any `5xx`, a status below 400, an `http` failure with no status) cannot show the change was not made:
  a gateway can answer `502` or `504` after the backend committed it and revoked the session, and a server can fail while it commits. `leavesOutcomeUnknown` (`src/features/settings/signing-in/outcome.ts`) is the one place that says so,
  and both forms use it: such an answer shows the same unconfirmed panel and "Check now" as a lost one, never "try again shortly" (a password change) and never "Can't remove this identity" (an unlink), and nothing is sent again.
  A `4xx` stays a refusal with its own message, so a refusal and an unconfirmed outcome still read differently. The operations read only the status (the body is discarded), so the status is all there is to classify; this changes the delivered
  mapping, in which a `500`, `502`, `503` or `504` on a password change said "Atlas is temporarily unavailable. Try again shortly." Released-backend evidence: I-29e (password) and I-27g (unlink), each with the proxy's upstream `204`
  delivered as `502` and the account state proved independently.
- **Credential controls need a connection** (review R7). While the browser reports none, "Change password", "Remove", "Link single sign-on" and the unconfirmed panel's "Check now" are disabled with a visible reason that is also their
  accessible description ("Changing your password needs a connection.", "Removing a single sign-on link needs a connection.", "Linking single sign-on needs a connection.", "Checking needs a connection.": all [P]); Remove keeps the
  sign-out consequence as a second description. The fields stay editable and keep what was typed, so the form is ready when the connection returns. Offline is the reason shown for Remove and Link ahead of "no password" and "old session",
  which are still there to read when it returns; a request already on the wire keeps its own reason ("Changing your password…", "Removing…"). The report is a **hint, never the evidence**: a request that starts online is judged by its answer
  (a refusal is shown as a refusal, a lost answer is unconfirmed), and each handler asks the browser as well as the rendered state (`isOnlineNow`), because the hook's state can lag the browser's by a render, so an activation in that
  window sends nothing. Released-backend evidence: I-27h. This is within WF-SETTINGS-03; it needs no offline data store (WEB-09).
- **Passwords** exist in component state for one submit: each is measured in **bytes** (12 to 1,024; E-16), never trimmed or normalised, cleared after every outcome, and never leave the call.

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

None blocks anything. G-1 to G-3 were material; WEB-08d replaced them with BE-Q25's labels, names and capacities (below). The neutral rows remain the fallback for a
label-less row, and Kieran's visual and copy sign-off of the replacement is open.

| ID | Gap | Treatment |
| --- | --- | --- |
| G-1 | Session rows: the design shows "Chrome on macOS"; `GET /sessions` has no label field | "This browser" / "Another sign-in"; "Password" / "Single sign-on"; signed-in and expiry times. **Replaced by WEB-08d** (BE-Q25 `client`); the neutral titles are the fallback |
| G-2 | "You have room for 5": the API exposes no device capacity | Omitted; the count the API returns is shown. **Replaced by WEB-08d**: the two capacities BE-Q25 reports (`session_capacity`, `sync_capacity`), never a hard-coded figure, never a reservation |
| G-3 | Device names: `device_id` is opaque and client-chosen | "This device" / "Another device", session count, last sync. **Replaced by WEB-08d** (BE-Q25 `name` and `client`, and naming); the neutral titles are the fallback |
| G-4 | The logout/retirement warning and the consent prompt exist only as ASCII in WEB-04 | Implemented verbatim; a rendered wireframe is requested |
| G-5 | Retirement dialog's `DeviceSummary` lines have no accepted copy | Proposed: one line per non-zero component. Not accepted |
| G-6 | The API-version compatibility screen has no accepted copy | Proposed: "Atlas can't work with this server yet" with an unsupported and a missing wording. Not accepted |
| G-7 | WF-SETTINGS-02 says an interrupted retirement is "never an automatic retry" | The matrix governs: the retry is automatic from the envelope and never against changed state |
| G-8 | Unassigned screens: the sign-in form, WF-SETTINGS-01 (account card, "Sign out", "Switch account"), WF-SETTINGS-03, WF-SWITCH-01/02 | Assigned by the 1 October hand-off. **Built in WEB-08b** (revision 5): the sign-in form, the account card with "Sign out", and "Signing in". **Still WEB-08c's:** WF-SWITCH-01/02 and "Switch account" (omitted, not disabled and not faked: D-8b-08) |
| G-9 | The rail account slot has no name source (`BrowserSession` carries only `account_id`) | Empty until a profile read exists |
| G-10 | State 1a "Review this device" needs a signed-in Settings surface | `actions.reviewDevice`; the composition root supplies it |
| G-11 | The light theme and narrow widths of the neutral states were unverified in the design files | Measured: both themes at 320, 390, 768 and 1280 px, axe including contrast, in three engines. Visual sign-off remains Kieran's |
| G-12 | WF-SETTINGS-02 says "Sign out" on the current row "takes effect immediately"; Q20(a) requires a warning before a wipe-producing action | A confirmation is always shown; it names unsynced work when there is any |
| G-13 | Wording with no accepted source: why an operation could not start (`REFUSAL`), "still signed in" after a recovered logout (`REMAINED_SIGNED_IN`), the retirement of another device | Proposed wording; flagged for review |
| G-14 | No wireframe exists for the **standalone** sign-in page | Built from the accepted WF-SWITCH-02 form (Username, Password, "Use single sign-on instead", the error under the password field, the offline reason) inside the join page's card. Heading and button copy are provisional |
| G-15 | The API gives no signal that OpenID Connect is configured (`/health` is `{status, api_version}`) | "Use single sign-on instead" is always offered, as a secondary control; an unconfigured server answers `404 not_found` and the page says "Single sign-on isn't set up on this server." |
| G-16 | **A wrong current password is `401 unauthenticated`**, which WEB-08a fails closed (O9): the session ends into "Reconnect to keep going" | Disclosed beside the form (provisional line). Characterised against the released backend (I-29c). Recommended backend follow-up: a distinct non-`401` code. Not a frontend fix |
| G-17 | A failed OIDC callback (consent refused, state expired) answers the **Atlas JSON error as the response to a top-level navigation**: the browser shows raw JSON at an `/api/` URL | Cannot be intercepted by the SPA. Characterised against the released backend (I-28a). The redirected attempt expires after 720 s and the next sign-in supersedes it. Recommended backend follow-up: redirect to the origin with an error fragment |
| G-18 | The design shows "linked 14 Feb 2026" and "corp-sso"; `GET /me` has neither a link date nor a provider name | The issuer **host** is shown as text; the date is omitted; the "also signs you out" sentence drops the design's cause-naming clause (a neutral state shows nothing about any account) |
| G-19 | WF-SETTINGS-03 has **Remove** only; the card requires `oidc_link` start | A **Link single sign-on** control is added (no accepted wireframe). Provisional copy |
| G-20 | "Switch account" in the SETTINGS-01 card | Omitted until WEB-08c (D-8b-08) |
| G-21 | An account label | `GET /me.username` in the overview card only. The rail stays empty (G-9); no display name exists in the contract |
| G-22 | Wireframe: "Ask kieran for a new one" | `RegistrationPreview` carries no inviter: "Ask whoever invited you for a new one." |
| G-23 | Link and unlink need a session created in the last five minutes; in-place same-account re-authentication is WEB-08c's | The controls disable with a reason when the current session is older (a 30 s margin), **including when it becomes older while the screen stays open** (review R8: a timer renders again at the deadline, and each handler reads the clock again before it starts anything); a start time that could not be read never expires and the server decides; a skewed clock can still reach the backend's `401`, which fails closed. The person signs out and in, or WEB-08c adds re-authentication in place |
| G-24 | SETTINGS-01 shows per-row current values ("3 places signed in · 2 devices syncing") and names the provider in "Signing in" | Static one-line descriptions are kept (the registry's rule): "Your password and single sign-on link." Not reopened here |

## Settings composition (for WEB-13a)

`src/features/settings/sections.ts` holds the registry; `SettingsHome` renders it and `settingsRoute` builds its child routes from it. To add a section, **append one
entry** (`id`, `label`, `description`, `route`, `order`, `owner: 'WEB-13'`, and a `build(settings)` that returns a route with `staticData: { settingsPage: true }`). Do not
edit `SettingsHome`, `settingsRoute` or another entry. The typed router deliberately does not know registry routes (an `AnyRoute` in the tree would widen every `Link`
in the application); `sectionPath` is the one place that says so. The "Your data" screen exposes the `calendarLine` slot in `your-data/slots.ts`; replace that constant
(WF-SETTINGS-06 tags the line "owner: WEB-13"). The section descriptions are static: they need no request.

WEB-08b added one registry entry, **Signing in** (`id: "signing-in"`, `owner: "WEB-08"`, order 20), a dialog route like Appearance, and the **account card** at the top of the home list
(`settings/account/AccountCard.tsx`; it is the only part of the home that issues a request, under a skeleton, so the list still paints at once). Two empty, ordered seams are left for
other slices: `settings/account/slots.ts` (`accountActions`: WEB-08c appends "Switch account") and `settings/signing-in/slots.ts` (`signingInExtras`: WEB-08d needed no control there, D-8d-08).

## Recognisable sessions and devices (WEB-08d, BE-Q25, API 0.28.0)

The released contract (`v0.28.0-rc.1`) adds a coarse `client` label to every session (`channel`, `browser`, `platform`, derived by the server from the activation
request's User-Agent: a recognition hint, never identity), `device_name` to sessions and `name`/`client` to devices, `session_capacity` to `GET /sessions` and
`sync_capacity` to `GET /devices` (`{limit, used, remaining}`; `limit: null` is unlimited; an absent member, on an older server, is unavailable), and
`PUT`/`DELETE /devices/{id}/name`.

- **The session kernel stays thin (D-8d-02).** The lists copy a capacity member only when the answer carries it, inside the same sealed result, so absent stays
  distinguishable from `null` and a capacity of account A is never returned after a transition to B (`tests/session/public-decode.test.ts`). `nameDevice` is an ordinary
  stamped call (CSRF, cover, lease, identity), released and sealed after its error body is decoded; the name is sent exactly as given; `204` is `named`/`cleared`, a
  `404 not_found` is `gone`, any other answer `http`. No Idempotency-Key: a repeat is harmless.
- **Decoding lives in the lazy Settings chunk** (`settings/sessions-devices/labels.ts`): unknown or future enum values read as `unknown`; a name is shown only if it
  passes the server's own `DeviceName` rules (by code point, Rust `char::is_whitespace`), so a value a correct server never sends falls back; capacity readings that are
  inconsistent are `unavailable`.
- **Titles (D-8d-03/04):** a session by its label ("Chrome on macOS", "Atlas app on iOS"); a device by its name, then its label, then WEB-08a's fallback. The current
  rows keep exactly one "This browser"/"This device" indicator (D-8d-05). Identifiers and tokens are never shown; every row action's accessible name carries the title,
  any device name and the row's own time (D-8d-06). Names are text in `<bdi>`, and isolated (U+2068/U+2069) in composed strings (D-8d-07).
- **Capacity (D-8d-11):** each line comes from its own list's READY answer only (none while loading or after an error), uses the server's figures (never 5 or 32, never
  the number of listed devices) and never promises a place.
- **Naming (D-8d-09/10):** offered only when the devices answer carries `sync_capacity`; disabled offline with its reason; validated before sending; an unconfirmed
  outcome (a lost answer, a `5xx`) says so and reads the list again; `closed`/`auth_state` and an answer after the dialog closed say nothing. A name is display metadata:
  it is not part of `state_token`, so a rename never stales a retirement (the confirmation still sends the token of the read that supplied the row).
- **Both lists after a change (review R1):** one server change touches both lists (retiring a device ends its sessions; signing out a never-synced device's last
  session removes the device and changes a synced device's session count; a name is shown on both). So a confirmed sign-out, retirement or naming change, or one
  whose outcome is unknown (a lost answer, a `5xx`, the same rule as naming), reads BOTH lists again through the composed screen (`SessionsDevices`), each with its
  own loading and error state. A definite refusal, `rejected_stale`, `not_sent`, `closed` and `auth_state` read nothing again.
- **Three lifetimes (review R1 and R3, revision 2; design assessment of 11 October 2026).** An ordinary change request, the lists on screen and the person's
  interaction with a dialog or row live for different times, so they are kept apart (`settings/sessions-devices/ownership.ts`):
  - an **interaction** is one opening of a dialog (naming, retiring another device, the wipe warnings) or one press of a row's Sign out. It is begun in the event
    handler, keys its dialog (reopening the same row is a new dialog) and ends at once when the dialog is dismissed (Cancel, Keep, Escape, Close, the sync control),
    replaced, its screen is left, or the identity (account and epoch) moves on. Only a current interaction makes another `not_sent` attempt (`untilSent` asks
    before every call, the first included) or shows its outcome; a dialog closes only itself, so a late answer of an older dialog never closes or changes a newer
    one. Each row of the sessions list has its own pending and failure state. **Revision 3 (review R4, design assessment A4/A5):** a completion asks whether
    its interaction is still current BEFORE it ends it, and only then changes what the person sees (fields, busy state, a message, focus, an announcement: the
    announcer outlives every form, so an obsolete answer would otherwise speak over a newer one); ending its own operation needs no permission. This covers the
    Signing in callers too: the password change, each linked-identity removal and the link (each its own action, with its own progress and failure), and "Check
    now" (its read is still observed by the session; a dismissed check says nothing). Signing in is dismissed by navigating away, so its forms would unmount a
    moment later: its close handler ends every interaction begun inside it first (`DismissalScopeProvider`), and an answer in between shows nothing.
  - what an **issued** request may have changed (a confirmed answer, `gone`, or an outcome nobody can confirm) is reported with `reconcileLists` for the identity
    it was made under, **even after its dialog was dismissed**: dismissing a dialog does not undo a request already sent. Every list on the page for that identity
    reads again, whichever screen made the change (a screen left and returned to included; a newly mounted screen reads anyway). Nothing is read for an identity
    that is no longer settled. Page memory only: no name, row or credential is kept, nothing is broadcast to other tabs, and no list is patched optimistically.
  - the request carries the interaction's **`withdraw`** signal (`SendOptions`, accepted by `nameDevice`, `revokeOtherSession`, `retireOtherDevice`,
    `changePassword` and `unlinkOidc`). Aborted before the request is issued, wherever it was waiting (CSRF, cover, a lock), the request is never sent and the call
    is `not_sent`; the kernel's top guard, lock waits and the boundary's `refuses()` all see it. It grants nothing and it is never passed to the transport: a request
    already issued is not aborted and its answer is handled as before (`tests/session/operations-withdraw.test.ts`).
  This supersedes the plan's D-8d-10 sentence "a result after the dialog has gone changes nothing": a dismissed interaction receives no local feedback; the lists
  for the same identity still reconcile a sent outcome. The current-device wipe warnings keep their durable protocol unchanged (a started operation is not
  cancelled by closing the warning); only their closing is owned.
- **Reading again on return (Q8, revision 4; Kieran's decision WEB08D-NAVIGATION-FRESHNESS-20261011).** Besides entry, Retry and a change made on this page, both
  lists read again, quietly, when the person comes back to the tab (it becomes visible) or to its window (focus while visible) (`useReturnRefresh` in
  `ownership.ts`, `useLoad`'s `refresh`). One return is one read per list: the page is away from `hidden` or the window's `blur` until the first return
  notification, and a read in flight is never doubled. What is on screen stays while it is read (no loading state; rows keep their identity, so keyboard focus
  stays; an open dialog and what is typed in it are untouched); the answer replaces the list as a load's would, through the same load generation and only while
  the identity the return happened under is still settled, so an older or other-identity answer never replaces a newer one. A failed read shows the usual error and
  its Retry; it is never presented as fresh data. Nothing is read while no identity is settled, while the browser says it is offline (the offline presentation
  stays), from an error (it keeps its Retry), or after the screen is left (the listeners live as long as the list). **Limit, by decision:** there is no polling,
  push or cross-tab notification and no backend change, so there is no maximum staleness: a tab left visible, a suspended or offline browser, or a change
  committed after the return's read is not seen until the next return, entry, Retry or change made on this page (`tests/features/settings/return-refresh.test.tsx`,
  I-8d-16).
- **Confirmations name the item (D-8d-12):** "Retire {name}?" (the name isolated) for another device; one identifying line above the unchanged WEB-04 warning for this device and logout.
  Signing out another session keeps its direct action (WF-SETTINGS-02 draws no dialog); its accessible name and announcements name the row.
- **Privacy (D-8d-14):** names and labels are never persisted by the client (not in `atlas-auth`, not in the retirement envelope, which keeps only `state_token` and
  `summary`), nor logged, nor sent anywhere but the `PUT` body.
- All new copy is PROPOSED (`label-copy.ts`, provenance-marked) and awaits Kieran's sign-off. The two capacity strings of WEB-08b and WEB-09a were corrected to the
  defined semantics (D-8d-13): the sign-in limit is per account, and only a retirement frees a place for syncing.

## Decisions taken beyond the matrix

- **D-01** raw IndexedDB, no dependency; **D-02** the device id is a record in `atlas-auth` (atomic get-or-create across pages); **D-03** the deletion ledger is in `atlas-auth`.
- **D-05** neutral-state precedence (above); **D-06** the stamped API returns a `Response` or throws `StampedRequestError`; a `401` or `403 credential_mismatch` is never
  returned as a response; **D-07** `recovery.begin` and `finish` belong here; **D-08** the client supports `>=0.28.0 <0.29.0`, derived from `contract-pin.json`.
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
- **Revision 5 (WEB-08b: registration, invitation redemption, browser OIDC, production sign-in, account overview and sign-in settings).** Additive public interface, four findings in the delivered WEB-08a code, and
  the decisions taken inside the approved scope. Each defect has a test that fails on the previous behaviour (`tests/session/web08b-defects.test.ts`, `web08b-oidc.test.ts`).
  - **K-1 (matrix O7, T3):** `completeExchange` cleared a stale attempt and then returned `refused` or `exchange_failed` even when the attempt was **no longer this epoch's**, so a stale wrong-password `401` was reported as
    "wrong password". It now returns `superseded`; B's attempt and settlement are untouched. **K-2:** `AttemptOutcome.settled` carries `method`, so a landing can say that linking worked. **K-3:** `AttemptOutcome.refused`
    carries `stage` (`exchange` or `activation`): an activation refused after a good grant means the account exists (for a registration the invitation is spent), which must not read as "wrong password" or "invitation used".
  - **K-4 (found by the Layer C integration run, not by any fake):** `POST /oidc/start` with `link: true` is authenticated by the session cookie and so needs that session's **CSRF token**; the released backend answers `403`
    without it. WEB-08b first sent it as a login-family exchange (no stamp, no token). It is now an **ordinary stamped request** (`ordinaryCall`, extracted from `OperationService` and shared with the attempt service), with the
    cover, lease and identity checks of any other, so its `401` (a session older than five minutes) is an **observation** that fails closed to "Reconnect to keep going", exactly as a password change's `401` does
    (this revises D-8b-04 and resolves matrix ambiguity 6). `OidcStartOutcome` gained `session_ended` and `not_started: not_settled`. The fake backends now enforce the same rule.
  - **C-4:** `unlinkOidc(issuer)` sends the body `{ issuer }` the contract requires (the delivered `unlinkOidc()` sent none and would have answered `400`). The issuer is taken verbatim from `GET /me`.
  - **Decisions:** D-8b-01 public surfaces in the neutral root; D-8b-02 sign-in is a mode of it; D-8b-03 the 1c notices come from the application, not the kernel (`1c.ended` is WEB-08c's); D-8b-05 capture first;
    D-8b-06 registration never retried; D-8b-07 `GET /me` is read fresh, every time; D-8b-08 "Switch account" omitted; D-8b-09/10 password length in bytes; D-8b-11 `neutral-status.tsx` is added to the **R6 allowlist**
    (a reviewed widening: it renders only the closed catalogue of messages on surfaces that show nothing about any account); D-8b-13 no label, device-name or capacity field; D-8b-14 single sign-on always offered;
    the join page was tried as a lazily loaded chunk (about 0.6 kB gzip saved) and **reverted**: a shared module the chunk needs became a `modulepreload` link, and Chromium then logged a "cross-world service worker resource mismatch"
    warning in `production.offline.spec.ts`, which the console guard (rightly) refuses. The initial JS is 109,034 B gzip in the final build, +9.2% over the recorded 99,814 B baseline: inside the 10% tolerance, with **761 B of headroom**
    (`.agtx/evidence/WEB-08b/profiling/bundle.json`). `perf-budget.json` is not edited; WEB-09 replaces its provisional figures with measured ones.
  - **Not touched:** `kernel/{send,cover,activity,closing,expose}.ts` and the reducers; no dependency, contract or vendored file changed.
  - **Review revision (four findings, application only; the session module is unchanged).** R1: a password refusal and a submitted invitation now outlive the form that the neutral gate unmounts (`authFeedback.carryFailure`,
    `invitationMemory` `spent`); R2: every outcome after a sent redemption retires the join form and offers the sign-in recovery, and the stale-result protection is unchanged; R3: "Check now" can no longer conclude that a change
    failed; R4: the Remove control is described by the sign-out consequence (`Button` now keeps a caller's `aria-describedby` after a disabled control's reason). Regression coverage: `tests/features/authentication/registration-recovery.test.ts`
    (the controller over the real kernel), `tests/app/session-root.test.tsx` (the real `SessionRoot` with a view that changes mid-submit), `production.auth-flows.spec.ts` and `fixture.auth-settings.spec.ts` in three engines, and
    I-29d (a password change held by a gateway past the app's time-out) and I-25 (a registration discarded because a newer sign-in failed) against the released backend (the proxy gained `buffer_request`, which forwards a request after the client has timed out; the stack gained the account `quinn` and a fifteenth invitation). R1's activation refusal (`device_capacity`) is **not** reproduced against the released backend: the backend's cap is 32 sessions per account, which the per-account sign-in throttle makes impractical to reach in this suite, so R1 is covered in the fake world, the controller and surface tests, the real `SessionRoot` composition and real engines with a stubbed network.
  - **Second review revision (one finding, application only; the session module is unchanged).** R5: a registration result that arrives after a **different** invitation was opened in the same tab no longer retires that invitation's form or puts the
    earlier token back (`invitationMemory.take` / `Redemption`, `earlier`, `EarlierRegistration` in `JoinSurface.tsx`). Regression coverage: `tests/features/authentication/{handoff,registration-recovery,join}.test.ts*` (the memory, and the controller over the real
    kernel for a lost response, a refusal that would restore the token, a superseded result and a settled one), `tests/app/session-root.test.tsx` (the real `SessionRoot` composition, including the gate and an invalid link), `production.auth-flows.spec.ts`
    in three engines (stubbed network), and two released-backend specs in `integration.web08b-registration.spec.ts` (the stack now makes nineteen invitations). The browser case for a refusal that would restore the token cannot show a difference
    on screen (a wrongly restored token only lives in page memory); the memory-level tests pin it.
  - **Third review revision (two findings, application only; the session module is unchanged).** R6: an answer that cannot show a credential change was not made (a `5xx`, not only a lost answer) is unconfirmed, for a password change and for an
    unlink (`leavesOutcomeUnknown`); R7: Change password, Remove, Link single sign-on and "Check now" are disabled with a reason while offline, and their handlers refuse to send (`isOnlineNow`). Regression coverage:
    `tests/features/settings/signing-in.test.tsx` (the rule as a table, the real forms, a committed change followed by a gateway error, losing and restoring the connection with the dialog open, a request that starts online, the handlers' own check),
    `tests/e2e/fixture.auth-settings.spec.ts` in three engines (stubbed network; real offline emulation; the offline surface at 320, 390, 768 and 1280 px in both themes), and I-29e, I-27g and I-27h against the released backend
    (no proxy or stack change: `rewrite_status` already existed, and I-27g and I-27h use accounts the OIDC stack had not used).
  - **Fourth review revision (one finding, application only; the session module is unchanged).** R8: the five-minute window for Remove and Link was read from the clock only when the screen rendered, so a "Signing in" dialog opened soon after signing in and left open kept both enabled
    past the point at which they stop being eligible. `useStaleSession` (`signing-in/use-stale-session.ts`) renders again at the deadline (`freshUntil`, the same instant `isFresh` judges by; a timer that runs early waits for what remains; the delay is held within what a
    timer honours, so a start far in the future, a clock set back, is waited for in steps rather than fired at once), and `remove` and `link` read the clock again before they start anything, because a timer can run late (a suspended device, a hidden tab). The server stays
    authoritative, a start time that could not be read never expires, and the existing visible reason is unchanged. Regression coverage: `tests/features/settings/signing-in.test.tsx` (fake timers: the deadline crossed without remounting, the two
    handler boundaries, a timer that runs early, an unknown start, a start that arrives late, a start far in the future, the timer dropped on leaving, and the real dialog) and `tests/e2e/fixture.auth-settings.spec.ts` in three engines (Playwright's clock: timers run
    through the deadline at 320 and 1280 px, a clock that jumps, an activation after the clock passed the deadline), and against the released backend I-27i (the page's clock simulated, a click after the deadline sends nothing) and the opt-in I-27k
    (**real** time, about 5½ minutes per engine: the page disables both controls at its deadline, 270 s after the session began, with nothing pressed, and the backend itself answers `401` to `DELETE /oidc/identities` and to `POST /oidc/start` with `link` for a session of the same age at 305 s,
    while its `GET /me` is still `200`). **Not shown here:** what the page does with a real `401` for an old session when a request does go out (the controls are disabled by then; that path is the earlier fail-closed behaviour of G-23), and any clock but this machine's.
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
| Real-engine fixture | `tests/e2e/fixture.session-*.spec.ts`, `fixture.auth-settings.spec.ts`; `production.auth-public.spec.ts` and `production.auth-flows.spec.ts` (WEB-08b: the PRODUCTION build against a STUBBED network, `tests/e2e/auth-stub.ts`) | the production adapters, the level-0 gate with real `inert` and the real top layer, the rendered screens (including the sign-in, join, account-card and "Signing in" states) in both themes at four widths with axe including contrast, the fragment stripped before the first request, registration, the OIDC round trip with a stub provider, and the T1/T3/T15 orderings with two real pages and held answers, in Chromium, Firefox and WebKit | a backend; the real cookie; a real provider; real Safari; assistive technology; freeze and bfcache |
| WEB-08d labels | `tests/features/settings/{session-labels,labels-contract,name-device}.test.*`, `tests/session/operations-device-name.test.ts`, `tests/e2e/fixture.session-labels.spec.ts`, `tests/integration/integration.web08d-labels.spec.ts` (I-8d, its own stack) | the decoders against the 30fec6a contract extract and the backend's own name vectors, and the released `openapi.json` byte for byte; the screens' every answer; naming over the stand-in's opt-in `beq25` mode with held answers across transitions; the rendered states in three engines; labels, names and capacities against the RELEASED `v0.28.0-rc.1` backend | a legacy (pre-0.28) row against a real backend (a fresh 0.28 database has none: fixture-only); real Safari or a device; assistive technology; Kieran's visual and copy sign-off |
| Integration | `pnpm test:integration` | the session and its adapters in a real engine (Chromium, Firefox and WebKit: 46 specs from WEB-08a and 57 WEB-08b specs each, one of them (I-27k) opt-in and skipped unless asked for, run in fresh stacks per engine because the backend throttles sign-in, activation, registration and single-sign-on requests per source and minute (120 in a window), consumes invitations and needs one stack with single sign-on configured and one without; since WEB-08d revision 6 the runner first gives every discovered case exactly one stack (`scripts/integration/stacks.mjs`: the sharing, snapshot, pages and password-path specs and the I-25 registration cases on stacks of their own, because the earlier base stack alone went over the budget and one of its cases passed on 429 answers), records each stack's sign-in traffic against that budget (`admissions-*.json`) and fails a stack whose busiest 60 s went over it, stops at the first stack that does not pass and records the rest `not_run`, and owns and stops Playwright's processes as well as the services; since revision 7 (review r6 H4) each stack's resources live in one scope (`scripts/integration/scope.mjs`) whose clean-up first stops and waits for the stack's preparation, so a signal part-way through starting PostgreSQL, a listener or the backend leaves nothing behind; every process carries an inherited ownership mark and is stopped with everything that carries it, frozen before it is killed (`ownership.mjs`); Docker containers, networks and volumes are labelled and found again by label, only the two pinned images are ever removed and only when the generation of users that found them absent ends (since revision 8, review r7 DA-1: a durable owner record per pin on the daemon, decided under one host lock per daemon and pin that the runner, its reaper and other invocations share, `host-lock.mjs`, in `/tmp/atlas-integration-coordination-<uid>` whatever TMPDIR each was given; a failed removal keeps the record, so the obligation passes to the next user; since revision 9, review r8 DA-1a: that lock is the kernel's exclusive open-file lock (`O_EXLOCK`, macOS and the BSDs only) on a file that is never moved or removed, so nothing ever takes it over, and every docker command issued under it holds it too, so a holder that dies mid-command keeps the pin locked until that command ends; each transaction notes its unfinished work beside the lock and the next holder settles it from fresh reads before deciding anything, or refuses; a record created under the lock is read back. Not covered: a request a dead command had already sent that the daemon completes only after a later holder has looked) (`docker-resources.mjs`); a clean-up is ok only when an independent look finds nothing left; a reaper started first in a group of its own finishes the clean-up and the summary when the runner itself is killed (`reaper.mjs`); since revision 8 (review r7 H4c) a stack's outcome comes from one reducer of failure facts (`outcome.mjs` `settleStack`, used by the stack's end, the runner's finaliser and the reaper from a journalled checkpoint): a failed case, an error in the report, a preparation error before the stop or an incomplete report with no stop before it stays a failure through a later stop, and a budget excess, an unverified clean-up or unwritten evidence outranks a cancellation; since revision 9 (review r8 H4d) each stack's record is committed to a file of its own (`stack-records.mjs`, `<run dir>/stacks/<browser>-<index>.json`, replaced atomically and merged with its earlier version so no fact is lost) whenever it establishes something, BEFORE the reaper is told the stack ended (with the committed sequence: the reaper keeps one checkpoint per stack and retires it only against that committed, settled record); the summaries are replaced atomically and are projections of those records, which a reaper take-over merges with its checkpoints (judging a raw report when only the launch was committed); a record or summary that cannot be written stops the run and is an evidence failure, and the reaper's own unwritten evidence fails it whatever its clean-up did. Known limit: a process that both starts with an environment without the mark and leaves the tree before it is seen cannot be attributed (no process of the programme does; holding the runner's pipes it still makes the clean-up not ok); containment that does not depend on this would need a launchd job per run, a decision for the owner) against the **released** backend `v0.28.0-rc.1` (SHA-256 verified), on a disposable SQLite database, behind a delaying proxy (it can hold, delay, drop, rewrite and swap, and `buffer_request` accepts a request and forwards it after the client has timed out); the WEB-08b specs include T1, T2, T3, T15, T16 cell by cell, registration with the backend's own operator invitations, and the OIDC round trip against a **stub** provider (`scripts/integration/oidc-provider.mjs`) | the WEB-08c traces on a rendered cache; a real identity provider; a household invitation (the released binary gives no account a household); real Safari or a device; assistive technology; PostgreSQL (unless `--postgres` was run: see `.agtx/execute.md`); the unmodified Compose or Ingress arrangement |

Visibility in the real-engine specs is driven by overriding `document.visibilityState` and dispatching `visibilitychange`: a limitation, stated wherever it applies.

## Running things

```
pnpm test                   # unit, component and pairwise fake-world suites
pnpm test:session-matrix    # every scenario of checks 12 to 14 and the mutation search; evidence in .agtx/evidence/WEB-08a/fixture/ (ATLAS_MATRIX_EVIDENCE=<dir> keeps a later task's run from overwriting it)
pnpm test:e2e               # (ATLAS_E2E_BROWSERS=all for Firefox and WebKit) includes the fixture session specs
pnpm test:integration       # downloads and SHA-256-verifies the released backend, starts it with the proxy on loopback, plans every case onto one stack, runs the three engines (fifteen fresh stacks each, stopping at the first that does not pass, or whose sign-in traffic went over the backend's budget; `--oidc off` narrows a run to a stack without the stub provider), cleans up and verifies the clean-up (a reaper finishes it if the runner is killed); the evidence of each run is in a fresh `<evidence>/runs/<invocation>/`
pnpm profile:session        # measurements (not budgets): P-2 to P-6; P-1 is scripts/check-budgets.mjs
ATLAS_INTEGRATION_REALTIME=1 node scripts/integration/run.mjs --browsers chromium --grep I-27k   # opt-in, about 5½ minutes of REAL time per engine: the page's five-minute deadline and the released backend's own refusal of a session older than five minutes (review R8)
```

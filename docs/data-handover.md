# WEB-09a data foundation: consumer handover

*Revision 38, 9 October 2026 (bundle notes updated in revision 39, 10 October 2026), under the bounded closure decision BC-20261009 (`atlas-orchestrator/docs/web09a-closure-20261009.md`). UK English. This is the short contract for the cards that build on the data layer; `docs/data-layer.md` is the full design record and remains authoritative where the two differ in detail. Nothing here is an acceptance claim: the foundation's verdict belongs to the independent review, and WEB-09a stays `integration_passed: false` until an integrated record exists (WEB-09d).*

## What you may import

Only `src/data/index.ts` (lint rule R15). It provides:

* **Composition:** `createDataEnv` / `DataEnv` / `DataEnvDeps` (no React), `DataProvider`, `DataEnvProvider`, `useDataEnv`, `useOptionalDataEnv`, `useDataActions`. The browser composition is a dynamic import inside the provider; nothing on the boot path may reach Dexie (`pnpm check:artefacts` checks the initial chunk). A module that both the boot path and a lazy chunk import is placed whole in the initial chunk, so the boot path takes only the deletion shims and small constant modules such as `model/unreadable-digests.ts` (R61, revision 39). The production initial JavaScript is held to its recorded baseline plus 10%.
* **The outbox:** the `Outbox` facade type and its outcomes (`EnqueueOutcome`, `EditOutcome`, `DiscardOutcome`, `SupersedeOutcome`), `EnqueueRequest` / `TargetSpec` / `Bases` / `BuildResult`, `OutboxRequestError`, and the registries a feature slice registers into: `createCommandRegistry` / `commandKind` / `CommandSpec`, `createConflictHandlerRegistry` / `ConflictContext` / `ConflictDecision`.
* **Read models and status:** `useCachedResource`, `useResourceList`, `useDraftQueue`, `useQueueSummary`, `useConflictInbox`, `useCommandDescription`, `useCacheGate`, `useNotices`, `useStatusInputs`, `useSyncStatusModel`, `useAccountLabel`, and their types (`CacheRow`, `DraftRow`, `MergedResource`, `QueueSummary`, `Notice`, `StatusInputs`, `GateState`, `CacheState`, `Loadable`, …).
* **Session integration:** `createDataDeletionPorts` (the wipe's data ports; a static shim that loads lazily) and `accountDatabaseName`.

Every outcome type is a closed union. A refusal is a value, never an exception, except `OutboxRequestError` for a request that cannot be built or measured. A warning (`storage_not_responding`, memory-only) is a **display**, never permission to send: the dispatcher's claim and issue checks decide.

## What a consumer must uphold

* **One database per account, opened only through the runtime.** Never create, open or delete an account database outside `src/data/store` and `account-database` (R13, R16). A binding that ended is **unknown, not absent**: wait for the controller's next look; do not read absence into it and do not reopen through a wipe latch.
* **Every persistence commit is ordered against the session** (`docs/session.md`, obligation 4): it goes through `AccountService.commit`, which takes `session.persistence.hold(account, epoch)`, checks the verdict at the durable record, starts the transaction in the same synchronous step (`valid()`, `revoked`, `track`), and drops a commit whose hold is `stale` or `unavailable` (nothing persisted, nothing counted). Do not write response-derived data any other way.
* **Account, epoch and incarnation guards.** A response decoded under `(account, epoch)` is applied only under the same identity and database incarnation (the layered commit guard). A late answer is dropped, never applied to a successor. Identity reads (`/me`, the device mirror) are admitted only by the binding that stands **in the turn that asks** (R59, revision 38).
* **Ordinary sync ownership.** Only the owner holding the ownership token, at the expected position and recovery generation, applies a page. Applying a page is atomic: one transaction, or nothing.
* **Drafts are retained until acknowledged or explicitly abandoned.** `Idempotency-Key` is the draft's `local_id`, and a retry reuses it. Discard, supersession and logout Keep/Delete are the person's decisions: logout deletion happens only after confirmed consent, and work that arrives during a logout renews the prompt.
* **Writes are compatibility-gated.** A queued submission pauses while `compat` says the server contract changed (`defaults_changed` goes to review, not resend).

## Shared cross-page state (other writers must join it, not duplicate it)

* **`atlas-sync` channel** (`src/data/engine/sync-channel.ts`): a closed union (`wipe_imminent`, `closed_ack`, `presence_query`, `presence`, `data_changed`). `data_changed { account, stores }` is a content-free **request to re-read**, never authority, and receivers filter by account. A writer that records or ends a durable stop names `sync_state` (`LOCAL_WRITE_STOPS_STORE`). Since revision 38 that includes every exit that **commits** such a change: a not_found discard, a no-answer record, and a commit delivered after its producer ended. A facade reads its stop records on such a hint whatever it shows. Delivery is best effort; cold reads remain the recovery.
* **Durable stops** live in three places: `sync_state.local_write_streaks` with failure versions (durable, per incarnation); immutable fallback markers in `localStorage` (`atlas-write-failing:<account>:<incarnation>:<operation>#<page>.<count>`, discovered by one `Object.keys` snapshot plus the slotted directories `atlas-write-dir:…`, whose slots are the Web Locks `atlas-write-slot:<n>`); and a page's memory (`LocalStops`, disclosed as memory-only). Retire only the exact instances and versions an act witnessed. Never read-modify-write a shared `localStorage` record across pages (measured to lose updates in Firefox and WebKit). Never call `navigator.locks.query()` in product code.
* **Quota:** every input write is admitted by the origin's quota ledger (`quota-ledger.ts`) as a lease the guard renews. Input is refused last; never write around the reservation.

## Production leadership, snapshot and recovery (WEB-09b, 10 October 2026)

*Fixture-evidenced contract; not integration or release evidence. `docs/data-layer.md` ("Snapshot, production leadership and recovery") is the full record.*

* **Production leads.** `boot.tsx` starts ONE sync leader per page at session level (`startDataLeader`, a dynamic import; `BootOptions.dataLeader` defaults to true and
  `main.tsx` never turns it off). The leader holds the fixed origin-wide Web Lock `atlas-sync-leader` for the page's life and runs the engine, the dispatcher and the recovery
  job in that page only; other pages follow (their request is queued) and send nothing. Do not start another engine or dispatcher in a production page.
* **Register once, into the page host.** Feature slices register command kinds and conflict handlers into `getPageDataHost().commands` / `.conflicts` (the leader's
  dispatcher and every screen read the same registries), not into a registry of their own. `CommandSpec.rebuild(draft, current)` offers "Resend as a new operation" /
  "Review, then save as new" in WF-QUEUE-02 (nothing is offered without it); `CommandSpec.onlineOnly` selects the dialog's online-only variant.
* **One runtime and one markers object per page.** With a leader on the page the provider uses the page's runtime (never disposed while the page lives) and the page's markers
  (`getPageDataHost().markers`, its directory slot leased); anything that needs a writer on that page uses them too.
* **Recovery is automatic and runs while fenced.** After a re-authentication the job asks `session.recovery.begin`, reads with the recovery class only, makes the data commit,
  then `finish`; WEB-08c's exposure decides display afterwards. Unsent drafts, their bodies and effects are byte-identical through a recovery; nothing is replayed or deleted.
* **Status.** `StatusInputs.recovery` may carry the job's `state` and Q24 `notice`; `follower` and `recoveryBlocked` are optional. `DataActions` gained `acknowledgeResync`
  and `saveAsNew`; `retryUpdates` reaches the job while it holds a stop, pause or the blocking budget.

## What each following card owns

* **WEB-09b** — the initial snapshot, **production leadership** (`start(ownership)` for the engine and the dispatcher) and recovery (`RecoverySeam`; without it a `410` stops the engine honestly), plus the `sync_state` fields that are its own. Its leader facade and dispatcher must use the same markers, channel, persistence hold and stop publication as above. *Delivered for review on 10 October 2026: see the section above.*
* **WEB-08c** — composed lifecycle journeys and the production waits against a back-to-back leader and a frozen owner (desktop fixture measurements exist; a real freeze, mobile devices and the production leader remain gates).
* **WEB-09c** — R9/Q9/Q23 measurements and the `WEB-09a:sync-profiling` evidence key for BE-B1/BE-Q23 (page size, dense valid content, memory, queue/quota reserve, request/lock costs, including the healthy-follower reads that `sync_state` hints cause), and the measured bundle budgets that replace the provisional figures in `perf-budget.json`. The fixture build's own initial JavaScript ceiling (its re-recorded baseline plus 10%, authorised for R61 in revision 39) holds only until then. Desktop evidence is not device acceptance.
* **WEB-09d** — the retained whole functional browser suite, the session matrix, the full released-backend integration, affected performance acceptance, supported-device dense workloads, real lifecycle/freeze and accessibility ownership, and integrated acceptance (gates BE-B1, BE-Q23, BE-B2, BE-CH3).
* **WEB-17** — post-beta hardening: D5's causal investigation (the revision-34 WebKit stall stays **unresolved, accepted as a deferred diagnostic risk**; the revision-38 collector `tests/e2e/d5-collector.ts` and its controls are the starting point), the full mutation catalogues (932 unit, 141 real-engine at revision 38) and extended stress/soak. A consequential product failure found there is an ordinary bug, not a deferral.

## Not claimed

No PostgreSQL, HTTPS deployment, production-leader integration evidence (WEB-09b's leader is fixture-evidenced; its focused integration against the released backend is reported separately and is not WEB-08c's composed acceptance), real device, real Safari or installed-app evidence. No guarantee of hint delivery after a page is killed. No cross-page serialisation of identity reads (two pages may overlap by one request before a shared pause is read). Fixture evidence is never integration evidence.

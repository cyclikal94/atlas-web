# The installable app, the service worker and app updates (WEB-14a)

What the client does about installation, offline navigation, new versions and the server's API version, and what a feature slice must do
to take part. Fixture-level evidence is described in each section; none of it is integration or release evidence unless it says so.

## Installation

- `manifest.webmanifest` (from `build/web-manifest.ts`): `id` and `start_url` `/`, scope `/`, `display: standalone`, theme and background
  `#08090A`, icons 192 and 512 px, a maskable 512 px icon (the mark inside the 80 % safe zone) and the SVG mark. `index.html` links the
  180 px Apple touch icon. The PNGs are rendered from `public/favicon.svg` by `node scripts/generate-icons.mjs` and committed;
  `tests/static/pwa.test.ts` checks their sizes against the manifest.
- nginx serves the manifest `no-cache` as `application/manifest+json`; the production policy already allows `manifest-src 'self'` and
  `worker-src 'self'`. Chromium reports no installability error (`production.pwa.spec.ts` P-P4). Installation on Safari/iOS, Android and
  desktop browsers, and VoiceOver with the installed app, are release evidence (WEB-15, WEB-09d), not claimed here.
- Installation and offline loading never depend on notification permission (WEB-14b owns notifications).

## The worker (`src/sw.ts`, `src/sw/*`)

- One worker per origin, registered by the app (`src/lib/pwa/start.ts`, a lazy chunk imported from `boot.tsx` after `session.start()`) as a
  classic script, scope `/`, `updateViaCache: "none"`. Only the production build and the `pwa-fixture` test build register it; development,
  Vitest and the ordinary fixture build never do.
- It serves the precached shell and the build's static files and NOTHING else: it never calls `fetch` (lint R1), never answers a backend
  path (`/api`, `/health`, `/ready`, `/auth`, `/oidc`, the OIDC callback included), a non-GET or a cross-origin request, so the browser's own
  network path handles those, online or offline. Its only requests are `Cache.addAll` of its own static files at installation (and
  `Cache.add` of one of them if its cache entry was lost). It holds no account data and sends no stamped request (the lifecycle constraint
  of WEB-05.5: if a later card makes the worker call the API it must adopt the write-ahead lease protocol first).
- Navigations use Workbox's `NavigationRoute` (Q10) with the backend paths denied, answered with the ACTIVE generation's `/index.html`, so a
  cold start, a reload and a deep link never visited open offline. `workbox-precaching` is not used: its activation deletes every file
  absent from the new manifest, which would break the retention rule below.
- It never calls `skipWaiting()` on its own (only when the tab whose person accepted the update says so) and never `clients.claim()`
  (WEB-07 F11, WEB-08a F-12): the first installation controls pages from their next navigation.

### Generations and retention (WEB-04 8, no fixed cap)

A generation is one build's precache, named by a hash of its manifest (`atlas-precache-<generation>`). Every page reports which build it runs
(its entry script) to the worker, which writes one record per window client in its own Cache Storage (`atlas-sw-state`) and answers only
after the write; a page retries an unanswered report (1 s doubling to 60 s). A pass after each acknowledged report and at activation keeps the
active generation, every generation not yet retired, every generation retired less than `PURGE_GRACE_MS` (10 s) ago, every generation an
open window reported, and EVERYTHING while any open window has no acknowledged report; the rest are purged. An old tab can therefore load a
lazy chunk of its own build after the server has moved on (`fixture.pwa-retention.spec.ts` P-R1). Storage is bounded only by the
generations open tabs are spread across (OD-P2: no cap; revisit only with a measured problem). The grace covers a navigation answered by the
old worker in the instant another tab's activation runs.

## Updates (`src/lib/pwa/coordinator.ts`, `store.ts`, `UpdateBanner.tsx`)

Per tab: `none`, `available` (a newer version is installed and waiting), `updated_elsewhere` (another tab applied a newer one; this tab still
runs the older), `saving`, `save_failed` (`refused` while signing out), `discard_failed` (revision 1, below), `reloading`, `data_superseded`
(below). The banner is in the shell
(`AppUpdateBanner`) and in the neutral root (`NeutralUpdateBanner`, signed out). It is dismissible until the next return to the page, never
takes focus, is announced once, and NEVER reloads on its own:

- "A new version of Atlas is available. [Reload]" / "Atlas updated in another tab. [Reload here]" (wireframe 6). With a recoverable form
  open it is Q4 state 1 ("Save and reload"); a failed save is state 2 ("Retry save" / "Discard and reload anyway"), the form stays open and
  the update stays pending. Q4's save-first flow replaces the wireframe's "Reload and lose unsaved input?" confirm.
- Accepting: this tab saves its dirty forms; every other tab is asked on `BroadcastChannel("atlas-app-update")` to save its own (a copy,
  never a submission, never a reload) and the acting tab waits for the tabs that answer within `FLUSH_START_GRACE_MS` (500 ms), at most
  `FLUSH_MAX_MS` (5 s); then the WAITING worker is told to skip waiting and this tab alone reloads at activation (or after
  `ACTIVATION_FALLBACK_MS`, 10 s, against whatever is active). The other tabs say "updated in another tab" and choose for themselves (WEB-03
  5's "every tab reloads" is replaced by per-tab choice, Q4 and WEB-04 8).
- **Nothing can be typed between the last save and the reload (revision 1, R3).** From the moment the person accepts until the page reloads,
  every form of the acting tab is frozen (`inert`, `aria-busy`; the registry freezes a form that mounts meanwhile too): the waits above can
  last seconds, and input typed after the save would be lost. A failed save or discard releases them (the person keeps working). Other tabs
  are never frozen: they save a copy and keep working.
- **The freeze is a lock, and a reload needs a checkpoint (revision 2, R3).** While the acting tab is frozen, `registry.frozen()` is true:
  the recovery actions that would change a form are refused at the API (`restoreAlternative`, "Discard instead", a new submission
  ticket) and their controls outside the form are disabled with a reason (PROPOSED copy: "Unavailable while Atlas saves your form and
  reloads."). Work already outstanding when the person accepts (a save, a discard, a submission sent before, `submitting()`) is waited
  for first. EVERY way to the reload (the activation, the controller change, the 10 s fallback, no waiting worker, a refused skip-waiting
  message) passes one check made in the same step as the reload: nothing is outstanding, every form is held still, none is dirty. Work that
  arrived during the waits (a form mounted again, a submission's success) is settled first (up to three rounds); what cannot be settled
  stops this tab's reload ("Couldn't save your unfinished form…", the forms released, "Retry save" available), even if the worker has
  activated for the other tabs. A form that cannot be held still is never taken for safe.
- **"Discard and reload anyway" discards (revision 1, R6).** It discards the copies of every dirty form (this page's own earlier copy and the
  one the form was restored from), so none comes back after the reload. A discard that cannot be written says so (`discard_failed`,
  PROPOSED copy: "Couldn't clear the saved copy of your unfinished form. If you reload now, that copy may be restored afterwards. Your form
  is still here. [Try again] [Reload anyway]") and reloads nothing; a refusal while signing out proceeds (the database is deleted with every
  copy).
- Update checks: at registration, on `online`, on a return to the page at most every 15 minutes, every hour while visible, and when the
  server's API version is `unsupported` (at most every 60 s).
- `getAppRegistration()` (`start.ts`) gives WEB-14b the registration.

### A newer schema in another tab (declared-then-probe, WEB-03 5)

The Dexie adapter opens an account database and reads the version the engine actually opened. Above this build's declared version
(`DECLARED_IDB_VERSION`, IndexedDB 20 for schema 2) another tab's newer build upgraded it: the open fails `closed` before reading anything,
the account is latched `upgrade_pending`, `upgraded` is reported once, and every later open on the page is refused. An upgrading
`versionchange` while the page holds the database does the same. The tab then shows "Atlas was updated in another tab and needs to reload here
to keep working. [Reload here]" (PROPOSED). Dexie 4 alone would open the newer database silently (the real-engine spec and mutant MU-1166
show it).

**The person's form keeps a recovery path (revision 1, R7; WEB-04 8).** The superseded page uses the database for nothing else, but its open
forms still save, restore, list and discard their copies through the RECOVERY CONNECTION (`src/data/store/recovery-store.ts`): every call
opens a fresh connection WITHOUT a version (so it never upgrades, never creates, and opens whatever version the database now has, after any
upgrade in progress), checks the `form_recovery` contract (the store, its key path `[form_context, tab_instance_id]`, its `form_context`
index, and `sync_state`), runs one of the four W9 recovery plans in one transaction, and closes (a `versionchange` closes it at once). Any
other plan is refused before anything is opened. The plans keep their own guards in the transaction (the incarnation this page last had
open, `closing`, the order of captures), the quota reserve is the port's, and the controller hands the port to a form only while that
account is still the displayed one and latched `upgrade_pending` (a deletion's or an identity change's closure is never stood in for; a
page that never had the database open has nothing to continue). So "Reload here" saves the edits made after the last copy; a migration that
failed (rolled back) leaves the old version, which the same path uses; a newer schema that broke the contract fails the save like any failed
local write, and the form stays with "Retry save" / "Discard and reload anyway" (WEB-04 8's keep-working/discard). Real engines:
`fixture.data-schema-probe.spec.ts` E-R7 and `fixture.pwa-schema.spec.ts` (revision 1).

**Binding on every future schema change:** `form_recovery`'s key path and `form_context` index never change in a way an old-shaped row
would not satisfy, a field it gains is optional from the reader's side, and `sync_state` keeps the singleton key and the fields the W9 plans
read (`incarnation_id`, `draft_fence.closing`, `form_writer_gen`). **OD-P1 (narrowed in revision 1)** stays binding on the first card that
raises `SCHEMA_VERSION`: the "update failed, your data is safe" banner, `blocked` handling, and a real-engine test of an actual migration
under open tabs.

## The API version gate, re-checked (D-P9)

The session asks `/health` at boot, at EVERY `online`, on a return to the page (`visible`, `focus`, `pageshow`, `resume`) once
`compatRecheckMinIntervalMs` (5 minutes) has passed, and, while the answer is `missing`, `unsupported` or `unreachable`, on a paced timer
(`compatRetryInitialMs` 30 s doubling to `compatRetryMaxMs` 10 minutes, starting again when the answer changes). One check is in flight; a
trigger during it asks for exactly one more after it. `session.recheckCompatibility()` asks at once. A missing version stays paused until the
server reports a supported one (no update can lift it); a mismatch lifts when a client build whose range includes the server's version is
loaded (the compatibility screen and the `compat_paused` banner offer "Reload to update" while one is ready). Fixture cases 1-3:
`fixture.pwa-compat.spec.ts`; real backend: I-U1 (the pause legs' version field is proxy-supplied), I-11, I-O3.

**A reconnect admits nothing until its own answer (revision 1, R1).** In the same synchronous step as the `online` event, before any
dispatcher can run, a `supported` fact becomes `unknown` (queued writes are held quietly, `compat_unconfirmed`), and only an answer to a check
asked AFTER the latest reconnect is applied: an answer to a check asked before it (in flight, or queued behind one that was) is dropped, and
the rerun decides. A pause (`unsupported`, `missing`) stays as it is until the fresh answer. Real backend: I-U1 (revision 1), a draft queued
offline with the reconnect's `/health` held (matching, and proxy-supplied mismatched and missing answers). Integrated acceptance of
cases 2-3 against a backend whose version really varies stays with BE-B2 and WEB-09d.

## Recoverable forms: the contract for feature slices (D-P7)

```ts
const port = useFormRecoveryPort(); // src/data: the displayed account's store, or null while it has no open database
const recovery = useRecoverableForm({ formContext: `task-edit:${path}`, allow, formRef, port });
// render <RecoveryBanner state={{ kind: "restored", onDiscard: recovery.discard, disabled: recovery.locked }} firstFieldRef={...} />
// offer recovery.alternatives (other copies, newest first) with recovery.restoreAlternative(tabInstanceId), disabled while recovery.locked
// submitting (revision 2): take a ticket BEFORE sending; none while an update reload is prepared (send nothing then)
const ticket = recovery.submitting(); // in the same task as reading the values you send (revision 3)
if (ticket) send(values).then(() => ticket.succeeded(), () => ticket.failed()); // "discarded" | "kept" | "failed" | "refused"
```

- Only allow-listed fields are captured, never a sensitive one (`guard.ts`: development builds throw, production drops it).
- **Dirty means a reload would not bring back what the form shows (revision 1, R2; revision 4, R3):** its values differ from this page's own
  latest durable copy, else from the copy it was restored from; with no copy, some value is UNFINISHED. A value needs no copy only when the
  next page starts from it anyway (the field's initial value) or a terminal act covers exactly it and the field has not been edited since
  (`fields.ts`, `resolved`). A flush of a form whose every value needs no copy discards its copies instead of saving one.
- **Order (revision 1, R4):** a flush captures the values and takes its place when it is CALLED; a submission or discard asked for while it
  still waits for the page's identifier overtakes it, and it writes nothing (`failed`). The port's `(writer_gen, capture_seq)` order is kept.
- **Discards answer (revision 1, R6):** `onSubmitted()` and `discard()` answer `discarded` (no copy can come back), `failed` (one may: the
  form stays dirty and the next flush discards again) or `refused` (signing out). `FormRecoveryPort.discard` answers the same.
- **Every copy is listed (revision 1, R5):** `list` walks all of a form's rows in pages of 50 inside one readonly transaction and answers
  every restorable copy; terminal rows (kept on purpose) never hide one.
- The recovery identifier is minted at the page's FIRST save (`crypto.randomUUID()`, memory only, never `sessionStorage`), and the page holds
  the Web Lock `atlas-recovery-tab-<id>` for its life. A form restores, once per mount and never over input typed meanwhile, this page's own
  copy first (the tree may be mounted again), then the newest copy of a tab that has GONE; another open tab's copy is never taken over.
  After this page's own copy is saved, the copy it was restored from is discarded; a submission or "Discard instead" discards both.
- **One session per form, whatever mounts it (revision 2; R2, R4, DA-1, DA-2; `src/lib/form-recovery/session.ts`).** The form's state
  belongs to a SESSION in the page's registry, bound to the account's database (account and incarnation, `FormRecoveryPort.pin().scope`)
  when the form first has a port; a mount of the hook is only a view of it. One order numbers every save and discard of the session when it
  is asked for, so a submission or discard in any mount overtakes every earlier save, whichever mount asked for it (R4), and the durable
  baseline only moves to a newer save's values when that save lands (R2: a late save never makes an older copy look current). A form that
  unmounts (another page's boot remounts the protected tree, F-1) leaves its input to the session, in memory only (nothing is written while
  the tree is torn down), and the same form mounted again in this page for the same scope shows it again with its restored copy and
  alternatives, offering copies other tabs left since. The session stays in the registry's list while it is dirty, owes a discard or has
  an operation outstanding, so a remount never takes unfinished work out of the update coordinator's sight; a clean idle one is kept, not
  listed, for the next mount. A look for copies answered after any save, discard or submission of the session, or while an update reload
  is prepared, restores nothing (it offers the copies; DA-1). When a form binds to another scope (another account, or the database deleted
  and created again), the sessions of the old scope that no mount shows are retired: their memory-only input is dropped, never shown or
  written there. A session stays bound to its scope: a form that stays mounted while its database is re-created writes nothing into the new
  one (DA-2). Two mounts of the same form at once are not supported (the second has a session of its own; they share one durable row).
  Playwright's WebKit shows no remount on a peer's boot; the browser cases force the remount (`__atlasRemountForm`, fixture only).
- **Pinned writes (revision 1; revision 2: the whole scope):** every flush and discard pins the port when it is asked for (`pin()`), so a
  write that waits for the page's identifier can never land in another account's store or another incarnation, and none is made for a
  scope other than the session's.
- **A submission acknowledges what it SENT (revision 3; R3, R10; revision 4).** `submitting()` records, when it is called, the form's session
  (account and incarnation included), its input revision (moved by the person's `input`/`change`/`reset` events in the form and by the
  hook's own restores and discards, recording which field each changed) and everything the form held, field by field. `succeeded()`
  reconciles in THAT session only, never in whatever the hook shows by then (another form context, a remount, another account): if the form
  still holds exactly what was sent, what was sent is COVERED (needs no copy) and its copies are discarded (`discarded`); if the person
  changed the form after sending, the change stays theirs and stays dirty (`kept`) WHATEVER TEXT IT HOLDS, including the text of this or an
  EARLIER successful submission (revision 4, R3: coverage belongs to the field as the act left it, and any later edit of the field ends it);
  only the fields not edited since the send are covered. A copy of the later input replaces any obsolete one, and an update reload saves it
  first and restores it. An older
  response never undoes a newer acknowledgement. A ticket completes once: a later `succeeded()`/`failed()` answers the first outcome and does
  nothing. A ticket taken before the form had a database is still waited for by the update coordinator, and joins only the session the same
  mount binds for the same form context. `onSubmitted()` acknowledges what the form holds when it is called: only in the same task as the
  send's success. A change made by the caller's code without an `input` event, that returns the form to exactly the sent values, cannot be
  told apart from no change: dispatch an `input` event (or take a new ticket) when code changes the form during a send.
- **The committed allow-list is the schema; a hidden field keeps its value (revision 3, R11; revision 4; `src/lib/form-recovery/fields.ts`;
  PRODUCT-DECISIONS-20261011 item 2).** Every read, capture and restore admits the fields of the allow-list the mount COMMITTED (a layout
  effect at the commit; the empty list is a list like any other; the same fields in another order are the same list); a mount with another
  list, or a list changed while mounted, makes a transition, and a capture already made keeps its own list. The session keeps a LEDGER: the
  latest value of every admitted field, read at each input event in the capture phase (before the page's own handlers can remove the field),
  at every read, and while the hook renders. A field that leaves the page (a conditional field hidden, its admission removed, or both in one
  render) keeps its value, retained in memory; content typed into a field that is not admitted is never read. When the field is shown again
  untouched its value comes back into it (the owner's decision: retained while editing, restored if the field reappears); if the person has
  typed something else into it, their text stays and the retained value stays owed. Retained input that is not covered cannot be written into
  a copy (it is not admitted, or not on the page to be checked) and is never silently dropped: the form stays dirty and its saves fail, so an
  update stops with "Couldn't save your unfinished form…" and offers "Retry save" (after showing the field again) or "Discard and reload
  anyway" (explicit). A successful submission of the form's visible state covers the hidden values of the state it saved (no warning, no
  block: the owner's decision); a failed or uncertain one covers nothing, and edits made after the send are never covered by it. Comparisons
  with durable copies: a field the copy lacks would show its initial value, and no field the copy holds may bring back another value than the
  form holds. Code that changes a field's value must do it through the DOM with an `input` event, or before the hook's component renders
  again; a value changed silently in the same commit that removes its field cannot be kept.
- **Ownership precedes exposure (revision 3; R12).** A page's recovery identifier is its own only once its Web Lock is GRANTED: a candidate
  being acquired is not reported (`current()` is null), and a lock request that rejects or throws fails every waiter with
  `RecoveryIdentityError`, so the save fails honestly (`failed`, input kept, nothing written) and the next save makes a new acquisition. A page
  without `navigator.locks` has no recovery identity: it saves no copy, and every copy it finds belongs to another tab. (`locks: null` in
  `createRecoveryTab` is a test double only.)
- **What this does not cover.** Only the app-update reload is guarded. The sync-recovery "Reload" action (`SyncBlocked`, through the session's
  own reload) and browser reload/close are outside the update coordinator; they are not claimed protected (design assessment, 10 October
  2026; the owning slice decides). The newest eligible copy stays the default after a reload (WEB-04 8): another tab can save a newer copy
  after this tab's last save, so "this tab's input" is preserved as an available copy, not guaranteed to be the one selected.

## Test builds and constants

`node scripts/build-pwa-generations.mjs` builds `dist-pwa/` (ignored, never packaged): `production-a` (a copy of `dist`), `production-b`,
and `fixture-a/b/c` (`vite build --mode pwa-fixture`: the fixture entry with the worker; the label written to `data-atlas-build` makes each a
generation of its own; HTML `modulepreload` hints are omitted, as in production, see `.agtx/evidence/WEB-14a/qualification/preload-warning.md`).
`scripts/serve-generations.mjs` serves one at a time with nginx's semantics and the production headers, `Cross-Origin-Opener-Policy`
included, to every engine (revision 1, R9: revision 0 omitted COOP for Firefox; that run's evidence is kept as adapted evidence). The first
navigation of a fresh Firefox page is made by the page itself (`navigate` in `tests/e2e/pwa-world.ts`; `docs/browser-support.md`). Every
timing above is a production constant; no test shortens one.

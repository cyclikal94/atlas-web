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
(below). The banner is in the shell (`AppUpdateBanner`) and in the neutral root (`NeutralUpdateBanner`, signed out). It is dismissible
until the next in-app navigation (the router rendered a destination with a different address: a link, a programmatic navigation or a
history step; `src/lib/pwa/navigation.ts`, revision 17, R24) or return to the page. It is announced once and NEVER reloads on its own.
Focus (revision 19, R26/R27; `src/lib/form-recovery/focus.ts`; form-recovery-reload.html "Focus order"):

| Presentation | Where focus goes |
| --- | --- |
| A plain notice (no recoverable form open; "updated elsewhere"; "Saving…"; "Reloading…"; superseded data) | Nowhere: it is announced, focus stays where it is |
| Q4 state 1, the prompt appears (a recoverable form is open) | "Save and reload" |
| Q4 state 2, a failed save, on either surface | "Retry save" |
| A refused save (only "Discard and reload anyway" is offered) | The banner region itself, never the destructive choice |
| A discard that failed | "Try again" |
| Q4 state 3, a restored form | Its first field (`RecoveryBanner`'s `firstFieldRef`), also after "Discard instead" (revision 51: the owner's destination, see "Restored-form focus" below) |
| A choice made in the banner whose button goes ("Save and reload", "Retry save", "Discard and reload anyway", "Try again", "Reload anyway") | The banner region, until a failure focuses its own action (or the page reloads) |
| "Not now" or the close button, used from the banner | Where the prompt took focus from, when that is still on the same surface and focusable; otherwise the surface's page heading |

A presentation takes focus ONCE: a change of what the update state says is a new presentation; a re-render, a remount of the shell, the move
of a failure to the neutral root or the same state published again is not. Each of these is a focus REQUEST (revision 20): pending until
its target really became the active element. Behind the session gate (`inert` and its modal dialog), an app dialog or a form's hold the
browser refuses focus, and the gate usually lifts an existing tree without another render, so a pending request is attempted again
whenever the document's eligibility can have changed: ANY attribute or the node tree changed (one MutationObserver on the whole document,
kept only while a request is pending, run once per batch of changes at the microtask checkpoint after the step that changed the document; no
timer or polling). Revision 21 (R26/R27) widened this from `inert`, `open`, `hidden` and `disabled`: a target or an ancestor revealed by its
`class`, its `style` or any attribute a stylesheet selects on is focused at that reveal. A reveal that changes no part of the document (a
stylesheet edit, a media query, the end of a transition) is not seen; no current caller reveals a target that way (the shell's layouts are
chosen by rendering), and a future one would have to signal it. A request belongs to the component that made it, so an unmount (another account, another route, the shell going) withdraws it.
Where both surfaces hold one for the same failure, the shell's goes first. An app dialog's return of focus to its opener yields to focus
placed since it closed. Focus never chooses anything: no action, save, discard or reload follows from it. DA-F1 (Kieran, 15 October 2026):
a restored form's first field wins over a state-1 prompt of the same arrival, in either order, until the next in-app navigation; the prompt
waits while a restored field in the page is still pending. DA-F2 (Kieran, 16 October 2026, approval
`FIXTURE-BUDGETS-FOCUS-PRECEDENCE-20261016`): a failure of the person's save or discard cancels a restored-field request still pending, so
the failure's recovery action has focus and the older request never takes it later. The protected surface's heading focus after a mount and RouteFocus's heading focus after a
navigation are fallbacks: focus placed in the tree meanwhile (a restored field, an update action, the person) is kept, and the session gate,
an unmount or another account's tree ends a pending one.

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
- **The update hands each form to the next page of the tab (revision 6, R13; owner decision of 12 October 2026; `src/lib/form-recovery/handoff.ts`).**
  A page's own copy protects its input only while the page lives: once the update reload unloads it, any other tab could restore that copy
  and, by saving different input, submitting or discarding, remove it before the replacement page read it (the replacement opened blank,
  and divergent saves or discards lost the input). So after the saves, "Reload" and "Retry save" write each form's UPDATE HAND-OFF: the
  form's copy again under a new random hand-off identifier (never the page's writer identity), stored under the form's hand-off context
  (`atlas-update-handoff:<form context>`, which no ordinary read lists), holding the Web Lock `atlas-recovery-handoff-<id>` before it is
  written; then a reference in this tab's `sessionStorage` (`atlas-update-handoff`: the form context, the account database's scope and the
  hand-off identifier only, never a value). The checkpoint above also requires every form with a copy (a clean one with a copy, and a kept
  session no mount shows, included) to have handed off its current copy; a hand-off or reference that cannot be written is a failed save.
  The next page of the tab takes the hand-off's lock FIRST, then reads it (revision 7, R15: nothing read before the lock is shown) and
  restores it (never submitting it). Until revision 40 it then removed it once its own copy was saved, or at its own submission or discard;
  **revision 40 (R42) makes the hand-off non-consuming** (see "Who may remove a hand-off" below). **Revision 8 (R16): what a
  hand-off owes is written with it, never guessed.** Every capture has an identity (`RecoverySnapshot.capture`, written with the row), and
  the hand-off carries its LINEAGE: the exact copies (key and capture) its page owed the removal of (its own ordinary copy, holding the same
  input, and every clean-up it had not finished). The next page removes exactly those, each only while it still holds that capture (a
  conditional W9 removal decided in one transaction, `saveFormRecovery` with `expect`), and the hand-off LAST, so until everything it names is
  settled the hand-off stays the durable record of it; a removal that does not land stays owed (`debts`: tried again at the next save or
  terminal act, written into the next hand-off, and an explicit discard answers `failed` meanwhile). Revision 7 took the first gone copy
  holding equal TEXT for that predecessor: an unrelated tab's equal copy was removed and the real predecessor came back after an explicit
  discard. Equal text, equal times and list order confer nothing; every other copy (an equal one included, and an abandoned hand-off whatever
  another copy holds) stays offered by its own identity. A hand-off written before revision 8 names nothing: only it is removed for it, and
  its predecessor stays an ordinary copy, offered. Other tabs never see a hand-off a live page holds and can never remove one by their own saves, submissions or
  discards. A duplicated or opener-copied tab carrying the same reference that cannot take the lock within `HANDOFF_CLAIM_WAIT_MS` (2 s:
  the page holding it lives) neither reads nor shows the hand-off: it falls back to ordinary selection (the owner's decision; revision 6
  showed the hand-off's input there too). A hand-off found resolved already (submitted or discarded) also falls back, and its stale
  reference goes. The reference record is never rewritten from a record that could not be read or is not a list (revision 7, DA-A: an
  entry this build cannot read is kept as it is), and the checkpoint certifies each form's reference in the record itself, not a flag. Only
  the form context's own session writes the reference; a second simultaneous mount of the same form context hands its copy off unreferenced
  (the next page offers it as an abandoned hand-off). A hand-off nobody holds (its page never came back: the tab was closed or crashed
  during the reload) is offered to later pages of the form as an alternative they may restore but never remove; only its explicit "Discard
  this copy" (`discardAlternative`) removes it. Choosing an alternative reads it again first (revision 7, DA-B; an abandoned hand-off while
  holding its lock), and shows it only if it is still there and the form has not changed meanwhile: `restoreAlternative` answers
  `restored`, `incomplete` (revision 9: shown except fields it cannot show, which stay owed), `gone`, `unavailable` or `refused`.
- **A read that fails is not an empty answer (revision 7, R13).** `FormRecoveryPort.load`/`list` resolve only with what a read FOUND (null,
  [] included) and reject when the store cannot be read (no store open, an aborted transaction, a closed handle); `readCopy`/`readCopies`
  type them (`found`/`absent`/`listed` vs `unavailable`). A look (all of whose reads go through the port pinned when it begins) that cannot
  make any read is `unavailable`: not `ready`, nothing restored, offered, claimed, removed or forgotten; the form shows `RecoveryBanner`
  "unavailable" (PROPOSED copy: "Couldn't check for a saved copy of this form. Nothing was removed — try again before you start. [Try
  again]") and `retry()` looks again. While a form is unresolved an update's "Save and reload" asks it to look once more and, if it still
  cannot read the store, stops with "Couldn't save…" ("Retry save" / "Discard and reload anyway"): the hand-off and its reference stay for
  the next page either way. A look still being made counts as outstanding work of the form. No timer removes a hand-off. An
  ordinary browser reload, closing a tab and the sync-recovery reload write none (their copies are the ordinary ones, as before);
  "Discard and reload anyway" and "Reload anyway" write none (the person chose not to keep the input). Hand-offs are ordinary
  `form_recovery` rows written by the same four W9 plans (so the restricted recovery connection, quota admission, ordering, tombstones and
  the wipe consent summary all apply); an older client's `list` of the form never reaches them.
- **"Discard and reload anyway" discards (revision 1, R6; revision 7, R6).** It discards the copies of every form of the act, not only the
  dirty ones: a save that failed part of the way (the form's own copy saved, then its hand-off or reference not written) leaves the form
  clean with copies that would come back. The coordinator keeps the act's forms (`participants`, also a form that left the registry since)
  and every form of the page with a copy, calls each form's own discard (its own copy, the copy it was restored from with the copies its hand-off
  names (revision 8), its own hand-off and reference; never another page's), and reloads only when each says nothing of it can come back (`discarded()`), so none comes
  back after the reload. A discard that cannot be written says so (`discard_failed`,
  PROPOSED copy: "Couldn't clear the saved copy of your unfinished form. If you reload now, that copy may be restored afterwards. Your form
  is still here. [Try again] [Reload anyway]") and reloads nothing; a refusal while signing out proceeds (the database is deleted with every
  copy).
- Update checks: at registration, on `online`, on a return to the page at most every 15 minutes, every hour while visible, and when the
  server's API version is `unsupported` (at most every 60 s).
- `getAppRegistration()` (`start.ts`) gives WEB-14b the registration.

### A newer schema in another tab (declared-then-probe, WEB-03 5)

The Dexie adapter opens an account database and reads the version the engine actually opened. Above this build's declared version
(`DECLARED_IDB_VERSION`, IndexedDB `n * 10` for schema `n`: 40 for schema 4) another tab's newer build upgraded it: the open fails `closed` before reading anything,
the account is latched `upgrade_pending`, `upgraded` is reported once, and every later open on the page is refused. An upgrading
`versionchange` while the page holds the database does the same. The tab then shows "Atlas was updated in another tab and needs to reload here
to keep working. [Reload here]" (PROPOSED). Dexie 4 alone would open the newer database silently (the real-engine spec and mutant MU-1817
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

## Recoverable forms: the contract for feature slices (D-P7; product editors: see below)

```ts
const port = useFormRecoveryPort(); // src/data: the displayed account's store, or null while it has no open database
const recovery = useRecoverableForm({ formContext: `task-edit:${path}`, allow, formRef, port });
// render <RecoveryBanner state={{ kind: "restored", onDiscard: recovery.discard, disabled: recovery.locked }} firstFieldRef={...} />
// revision 19: firstFieldRef is the field focus goes to on restore (Q4 state 3); render it with the restored form. A screen with several
// restored forms passes the one it means: mount order chooses nothing for it.
// offer recovery.alternatives (other copies, newest first) with recovery.restoreAlternative(tabInstanceId), disabled while recovery.locked
// revision 6: an alternative with isHandoff(copy) also offers "Discard this copy": recovery.discardAlternative(tabInstanceId)
// submitting (revision 2): take a ticket BEFORE sending; none while an update reload is prepared (send nothing then)
const ticket = recovery.submitting(); // in the same task as reading the values you send (revision 3)
if (ticket) send(values).then(() => ticket.succeeded(), () => ticket.failed()); // "discarded" | "kept" | "failed" | "refused"
```

- Only allow-listed fields are captured, never a sensitive one (`guard.ts`: development builds throw, production drops it).
- **A field is its whole state (revision 8, R17; `controls.ts`).** Every admitted field is read, compared, retained, captured and restored as
  one canonical state: text inputs, text areas and single selects as their text (stored copies unchanged); a checkbox's checked state, a
  radio group's choice (or none), same-named checkboxes (the checked values) and a multiple select's selections (none included) as control
  state, stored versioned in the copy's `controls` (never as text: a stored text that looks like a state stays literal). Revision 7 read only
  `.value`, so checking a box or adding a selection looked clean and was lost at the reload. A group with any sensitive member is sensitive
  as a whole. An admitted control that cannot be represented unambiguously (a file input, same-named controls of different kinds, repeated
  option or member values) is never captured: untouched it needs nothing; once edited the form stays dirty and an update's save fails
  (retry, or "Discard and reload anyway"), never a silent clean reload. A copy's state that a field can no longer show (another kind of
  control, an option gone) stays owed in the same way, and a copy holding control state this build cannot read (another version) is offered
  as it is and never restored in part. An older build reading a copy with control state restores its texts only (no stronger downgrade
  guarantee is claimed).
- **A field's shape is part of what it holds (revision 9, R17; `controls.ts` `Shape`, `fields.ts` `reconcile`).** Removing only the selected
  option of a select, or the checked member of a radio or checkbox group (the control and its first member staying), changing an option's or
  member's value, or an input's type or sanitising attributes, makes the browser show another state without any event. Every reader (an
  input event, the observer, which now also watches those attributes, a render, a capture, a dirty check, an adoption) reconciles by ONE
  rule: the same element in the same shape is read as it is; in another shape, what the field held is never replaced by what it now shows.
  A value the field cannot show is OWED (each one, in a list per field: a second never replaces the first): the form is dirty and an
  update's save fails (retry, or "Discard and reload anyway"), so the normal update never reloads without it (the reload's own check sees it
  too, also for a change made while the tab is held). While the person has not edited the field since, the value comes back as soon as the
  field can show it exactly (B shown again is chosen again); once they choose something else, their choice stays and the owed value stays
  owed until they choose it again, a successful submission that sent it covers it (PRODUCT-DECISIONS-20261011), or the form is discarded.
  What a field shows only because it could not show an owed value (the browser's first option, no choice) is never itself taken for input.
- **Every write is exact (revision 9, R17-B; C2).** `FieldAccess.write` succeeds only if the field reads the state back exactly; otherwise it
  changes nothing (it is checked first: a single select needs that option, an input's text is tried on a copy of the input so a number, date,
  range or colour never takes a text its type would change, and a value the browser still shows differently is put back). A restore that a
  field cannot show is reported: `useRecoverableForm().incomplete` names the fields (`restoreAlternative` answers `incomplete`), their values
  stay owed (dirty, not saved), and the copies they came from are not removed until a save holds them (A's copy and its update hand-off
  survive a successor that cannot show A's choice). "Discard instead" leaves a field whose initial state it cannot show as it shows it, and
  never claims it reset. Validity is not representability: an input keeps text that fails its `pattern` or `required` constraint. Selections
  keep their order (the options' order): a reordered select is not taken to show the same sequence (owed until its order returns, submitted
  or discarded). Limitations: the PROPOSED "restored" banner copy is unchanged (a form that names `incomplete` fields should say so; WEB-15
  copy sign-off), and no state is persisted for input that was never capturable (unchanged policy).
- **Dirty means a reload is not certain to bring back what the form shows (revision 1, R2; revision 4, R3; revision 5, R13):** its values
  differ from this page's own latest durable copy; with no copy of its own, the form is dirty if it was RESTORED from another tab's copy
  (whatever its values), and otherwise if some value is UNFINISHED. A restored copy is shared: every page that restored the same gone tab's
  copy holds the same row, and any of them may discard it (its own save cleans it up, a submission or "Discard instead" terminates it)
  without the others knowing, so it is never a page's reload protection (revision 5, R13: two pages restored one copy, one saved different
  input, and the other's update reload lost its original input). Only a copy saved under this page's own identifier, whose owner lock no other
  live page can take over, protects it; that save captures what the form holds, never the shared row, so it works whether the row still
  exists or not. A value needs no copy only when the next page starts from it anyway (the field's initial value) or a terminal act covers
  exactly it and the field has not been edited since (`fields.ts`, `resolved`). A flush of a form whose every value needs no copy discards
  its copies instead of saving one. Saving and cleaning up stay separate: a failed own save never removes the restored copy, and a failed
  clean-up never undoes a landed save (the next save or terminal act tries again).
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
  Revision 6 (R13): the update hand-off left to this page of the tab comes before any gone tab's copy (above); a `formContext` starting
  with `atlas-update-handoff:` is refused (reserved).
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
- **A submission acknowledges what it SENT (revision 3; R3, R10; revision 4; revision 5).** `submitting()` records, when it is called, the
  form's session (account and incarnation included), its input revision (moved by the person's `input`/`reset` events in the form, by a
  `change` event that reports a value no `input` event reported, and by the hook's own restores and discards, recording which field each
  changed) and everything the form held, field by field. A `change` event that only commits the value the field's last edit event reported is
  not an edit (revision 5): every engine fires one when focus leaves an edited field, and Chromium also when a focused edited field is
  removed, possibly after a submission covered that very value (it made the submitted text look unfinished, so an update would have saved
  and restored already-submitted input; `.agtx/evidence/WEB-14a/revision-5/diag-chromium`). `succeeded()`
  reconciles in THAT session only, never in whatever the hook shows by then (another form context, a remount, another account): if the form
  still holds exactly what was sent, what was sent is COVERED (needs no copy) and its copies are discarded (`discarded`); if the person
  changed the form after sending, the change stays theirs and stays dirty (`kept`) WHATEVER TEXT IT HOLDS, including the text of this or an
  EARLIER successful submission (revision 4, R3: coverage belongs to the field as the act left it, and any later edit of the field ends it);
  only the fields not edited since the send are covered. A copy of the later input replaces any obsolete one, and an update reload saves it
  first and restores it. An older
  response never undoes a newer acknowledgement. A ticket completes once: a later `succeeded()`/`failed()` answers the first outcome and does
  nothing. A ticket taken before the form had a database is still waited for by the update coordinator, and joins only the session the same
  mount binds for the same form context, at its own place in the session's order (revision 5, R3: binding translates the mount's revisions
  into the session's, `base + r`, so every edit typed before binding, even to the session's own text or the text of an earlier submission,
  is newer than anything the session knew and no earlier act covers it; a ticket whose translated revision an earlier acknowledgement already
  reaches covers nothing rather than take that acknowledgement's answer). An edit typed into a remount before it binds wins over the
  session's value even when it returns the field to where it starts; the session's value then stays owed unless a successful submission sent
  it before it was typed over. `onSubmitted()` acknowledges what the form holds when it is called: only in the same task as the
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
- **Observing an owner never makes the observer one (revision 52; Review52 F-R52-1, design assessment DA-N1/C1).** Every form of a page
  saves under the page's one identifier, so a tab that closed with several forms saved leaves several copies with one id, and the new page's
  forms (or several new tabs) look at that one id at once. Whether a copy's tab, or an abandoned hand-off's page, is still open is therefore
  a PASSIVE observation: a `shared`, `ifAvailable` Web Lock request (`tab-identity.ts`, `observe`), compatible with every other observation
  and refused only while a real owner holds the lock exclusively or waits for it. (An exclusive probe made each observer a momentary owner,
  so a concurrent observer saw a live tab and the closed tab's second copy was neither restored nor offered.) Authority stays exclusive and
  unchanged: the page's identifier, a hand-off claim (`holdHandoff`) and an action over an abandoned hand-off (`whileFree`, two actions
  still exclude each other). An observation is never authority to remove or change a copy; a refused or throwing lock manager still says
  "open"/"held". A page of an OLDER build still probes exclusively, and during its probe the lock is indistinguishable from a live
  owner's, so its brief overlap can omit a copy from a newer page's look (nothing is removed). Coverage: `tests/lib/recovery-observation.test.tsx`
  (primitive, both adapters, two tabs, a choice, hand-offs), the same-tab Defaults and household cases in
  `tests/features/recovery-owner-discard.test.tsx`, and a native diagnostic in Chromium, Firefox and WebKit (revision 52 evidence).
- **"Check saved copies again" (revision 53; decision D-R53-1, Kieran, 3 November 2026).** A look that withheld a listed copy because
  another page seemed to hold it (`look.ts`, `Found.withheld`: an ordinary copy whose tab looked open, or an abandoned hand-off that looked
  held, never this page's own claimed hand-off) says so in the form's recovery notice ("A saved copy of this form may still be open in
  another tab.") with the action "Check saved copies again" (`RecoveryNotice`, `RecoverableModel.checkAgain`; the DOM adapter has the same
  `checkAgain`/`withheld`). The check is the person's explicit repeat of the finished look in `offer` mode: the same pinned reads,
  observations and guards; what it finds is OFFERED beside what is shown, never restored, submitted or removed (restoring it is the
  ordinary guarded choice, read again). A genuine owner still withholds. Nothing looks again by itself: no polling, timer or automatic
  re-offer. A later check replaces one still reading; it reads nothing while an update reload is prepared (shown unavailable with its
  reason), before the first look has finished, while the look is unavailable (that is "Try again") or once retired; a database replaced
  meanwhile applies nothing. An offer look never offers the copy this session was restored from (shown, or discarded while the check
  read). Revision 55 (Review 54, F-R54-2; design assessment C-L1 to C-L3): every offer look (this check, "Try again" after a finished look
  in both adapters, and the DOM adapter's resumed mount) also reads the update hand-off THIS page claimed, under the claim it already holds
  (no lock request, no wait, no new claim), so a claimed, still-valid hand-off that was offered rather than restored (input before the look
  finished, an owner whose opening is input, or a restored hand-off the person then replaced by another copy) stays offered and restorable,
  and its lineage keeps the copies it names out of the offer. A claimed hand-off this page restored and then resolved by a terminal act (a
  discard, an acknowledged submission) is not offered again by this page (`claimedResolved`); R42 keeps it in the store, and a later page
  offers it as abandoned. A claimed hand-off that cannot be read makes the whole look unknown. Once used, the action stays in that notice (focus stays on it) and each finished check is said politely (copies listed, none
  found, or still withheld). The wording is PROPOSED, not accepted. Coverage: `tests/lib/recovery-check-again.test.tsx` (both adapters,
  an older build's exclusive probe modelled exactly, omitted-all/omitted-one, live owner, repeats, late reads, guards, hand-offs),
  `tests/lib/recovery-claimed-handoff-offer.test.tsx` (revision 55: this page's claimed hand-off in every offer look, both adapters),
  `tests/features/recovery-check-again.test.tsx` (the household dialogs, since WEB-12b's merge) and the native household journey in
  `tests/e2e/fixture.pwa-editors.spec.ts` (Chromium, Firefox, WebKit).
- **What this does not cover.** Only the app-update reload is guarded. The sync-recovery "Reload" action (`SyncBlocked`, through the session's
  own reload) and browser reload/close are outside the update coordinator; they are not claimed protected (design assessment, 10 October
  2026; the owning slice decides). The newest eligible copy stays the default after a reload (WEB-04 8): another tab can save a newer copy
  after this tab's last save, so "this tab's input" is preserved as an available copy, not guaranteed to be the one selected.

## The product's editors (revision 37; review of 25 October 2026, R40)

D-P7 assumed no product form existed. The merged application ships editors whose input is a MODEL held by a feature owner and shown
through controlled inputs, which `useRecoverableForm` (a form element's named fields) cannot read. None of them was registered, so the
update banner offered a plain Reload, the coordinator found the page sealed, and the reload lost a typed task (R40). Each now takes part:

- **One recovery protocol.** `src/lib/form-recovery/model.ts` is the same form session (`session.ts`: saves, update hand-offs, ordered
  discards, exact submission acknowledgement, account/incarnation pinning, copy lineage and debts) with one admitted field whose value the
  OWNER gives: an explicitly versioned, non-secret text of its raw input (invalid text, hidden values, stage and the baseline it was composed
  against). The owner stays the one authority for the input and gives every change in the same step (`edit`); while an update reload is
  prepared `edit`, `submitting`, `discard` and the recovery actions refuse, and the owner must not take the change (React puts a controlled
  input back). A native editing state the model cannot hold (a date or time field partly typed) is unfinished input (`probe`): dirty, never
  saved as the last value. Before the account's store is open a provisional handle is dirty by the same rule and its save fails. The look
  for what was left (`look.ts`, shared with the hook) restores the newest copy only into an untouched owner, after the owner's session has
  opened (a look begun before it would take the session's start for input and only offer the copy); anything else is offered
  (`RecoveryNotice`). A copy the owner's codec cannot read is offered as it is, never restored in part, never removed.
- **Owners adopted.** The task feature's kept-input owner (`kept-input.ts`: the new and edit task form `task-form:new` / `task-form:<id>`,
  the preset picker's choice, the Record progress amount `record:<progress>`, and, since the maintenance merge of WEB-10c, the dependency
  editor `dependency-editor:<occurrence>:<new|replaced set>` and the turn order `rota-order:<task>`), the occurrence correction
  (`occurrence-correction:<id>`),
  the entry history's fix drafts (`entry-fix:<progress>`), the calendar Add, Link (label and timezone only) and Manage (settings edited)
  forms, the household dialogs (since the maintenance merge of WEB-12b: New household `household-create`, Rename
  `household-rename:<id>` with the version it was composed against, and a household's Invitations `household-invite:<id>`), the sharing
  policy editor (`sharing-policy:<id>`, with the version it was composed against) and each defaults layer form
  (`sharing-defaults:<layer>:<household|personal>:<kind>`), and, since WEB-13b's maintenance merge (correction M-13b-1, below), the new
  task's calendar anchor in the task form's own text (version 2), WEB-13b's anchor panel (`task-form:new:anchor`, `task-anchor:<task>`)
  and its import dialog (`calendar-import:<source>`, `calendar-import:chooser`). Component-state editors use `editor.ts`
  (`useRecoverableEditor`); the People forms and the household dialogs, whose drafts live in their feature's page memory, have their own
  owners (`people/form-recovery.ts`, `sharing/households/form-recovery.ts`); WEB-13b's page-memory editing sessions use `editor.ts`
  through `calendars/session-recovery.ts`.
- **Restore hosts.** A dialog or stage that is not open after a reload cannot look: the screen that opens it does (`useKeptRecovery` for
  the new task's preset stage, `CorrectionRecoveryHost` and `PolicyEditorRecoveryHost` on the task detail, `DependencyEditorRecoveryHost`
  in the day's work, the conflict block of a refused `set_dependencies` and the rota panel, `useRecoveryHost` on the calendar screen and
  its rows, and, since M-13b-1, the new task form's and a task's "Calendar anchor" sections, each source's "Import events" and the import
  drop zone). A copy found is held for the editor (never submitted) and the editor is opened on it. A route-addressed dialog needs no host:
  the update's reload keeps the URL, so the dialog mounts again and looks itself (the defaults layers, the household dialogs).
- **Departure, discard and submission.** A departure that drops an owner's input (the visit's end, Cancel, another day) discards its
  copies (`end`), so it never returns after a later reload; a session kept for a visit to the sync screens stays dirty and listed. A save
  takes the model's ticket in the same step as the feature's own ticket; only a durable success covers what it sent, an uncertain or
  refused one keeps the input, and recovery never replays an uncertain operation.
- **Not recovered.** Passwords and calendar connection secrets (Q4, Q22); the change-password form holds nothing else. Directory searches
  are presentation, not committed input. (Revision 37 left the sign-in and join username unwritten pending an owner decision; revision 38
  applied that decision; revision 39 takes its preservation branch instead, below.)

**WEB-10c's editors (merge correction D-1, 6 November 2026; Kieran's decision "Fix in WEB-14a merge").** Accepted main `3f8fdf94` brought
two kept-input editors that took no part in the protocol, so an accepted update would have reloaded over their input with a plain Reload
(R40's class). Both now declare a codec on their `useKeptInput`, as the Record amount does, and so are registered while open (the update
offers "Save and reload"), frozen while it is prepared, saved by it and restored into an untouched session:

- **The dependency editor** ("Set what this waits for", `Dependencies.tsx`) keeps its chosen list and strict rule (`{ v: 1, list, strict }`
  in the build of that correction; version 2 since WEB-18's maintenance merge, below), per day and per conflicted set it replaces ("Keep editing"). A task or day picked in the selects but not yet added is not input (WEB-10c
  keeps only the list; a visit to the sync screens does not keep the picks either). The day's work reopens a new list's editor on a copy
  (`DependencyEditorRecoveryHost`); the conflict block, which holds the refused set, reopens "Keep editing" on it. The editor reads the
  preview again when it opens, so a restored list is saved only on the answer of now, and only by the person.
  **Codec version 2 (WEB-18 maintenance merge of 2f42ac35, 7 November 2026; Kieran's decision (a)(b)(c),
  `approval/web18-d1-correction-decision-20261107.json` in the orchestrator).** WEB-18 builds the edit from the editor's own depth-one
  graph read (its base: the root's version and direct list) and fills an untouched edit from it. A touched edit is kept with that base,
  `{ v: 2, list, strict, base }`, and restored as a touched edit on it. (a) An edit the person has not touched, whatever WEB-18 filled it
  with, is one constant text, the editor's start: it is never dirty and nothing is saved for it. (b) A restore onto a server list that has
  moved meets WEB-18's own "changed" block: Save is withheld until "Start again from the current list", never a silent overwrite and never
  a silent replacement. (c) A version-1 copy (the build before this merge, no base) and a touched edit with no base yet are offered as they
  are, never restored in part. "Discard instead" resets the editor to its start, and it is built again from the graph answer shown.
  Fixture evidence: `tests/features/tasks/web10c-editors-recovery.test.tsx` (mutants MU-3817..MU-3821; MU-3804 and MU-3805 re-anchored);
  real engines: `fixture.pwa-task-editors.spec.ts`, whose seeded world answers the editor's graph read (`tests/e2e/pwa-reads.ts`).
- **The turn order** (`Rota.tsx`) keeps the order and the roster version it was edited on (`{ v: 1, base, order }`, as the sharing editor
  keeps the version it was composed against). The rota panel reopens the dialog on a copy once the rota is read and only for someone who may
  still edit the order. Save sends `expected_version: base`, so an order edited on a roster someone has since changed meets the server's
  conflict and its "Reload", never a silent overwrite.

Cancel keeps WEB-10c's reviewed rule: what was typed stays with the screen's visit (it is not a discard), so a copy saved while the editor
was open still reopens it after an update. Each host opens its editor ONCE per restored copy (`detail/restore-once.ts`): the restored
session still holds input after a Cancel, and reopening on it would undo the person's Cancel; any later opening is the person's own. A
text either codec cannot read is offered, never restored in part. Fixture evidence: `tests/features/tasks/web10c-editors-recovery.test.tsx`
(the production coordinator's accepted update, its save and its one reload; the screens reopening each editor once; mutants
MU-3801..MU-3810). Native-engine evidence (revision 57, Review 57 F-R57-4): `tests/e2e/fixture.pwa-task-editors.spec.ts`, in Chromium,
Firefox and WebKit, generation A updated to B with each editor left by its sync control and by Cancel: reopened on the copy with the
restored notice, focus on the editor's own first field (below), nothing sent, and Save sending the restored list and strict rule
(`set_dependencies`, queued) or `set_rota` at the roster version the order was edited on, also after the roster moved. Its seeded task
days and their reads come from `tests/e2e/pwa-reads.ts`. The case reads what Save sends by HOLDING the page's write at its own `fetch`
(the generation server refuses every write), never by excusing the page from the console guard.

**Their restored focus (revision 57, Review 57 F-R57-1).** The turn order's first field is the first usable control of the ORDER (a move
or a remove), else of the people who could be added, read in those two sections only (`[data-rota-editor]`), else the dialog's own opening
focus (D1). Before, it was the first enabled button of the dialog's body, which also holds the notice: focus landed on the restored banner's
own "Discard instead" in every engine, and one Enter discarded the restored order. The dependency editor's is its Task select (a ref): its
first field proper, always shown and enabled, never a chosen day's Remove.

**WEB-12b's household dialogs (maintenance merge correction M-1, 6 November 2026; Kieran's decision "Fix in the second merge").** WEB-12b
replaced `HouseholdsMinimal`, whose inline create and invitation forms revision 37 had made recoverable, with route-addressed dialogs whose
drafts live in the households PAGE memory (they outlive a dialog's close and a `403` remount, never a reload). `households/form-recovery.ts`
follows the People forms' owner (`people/form-recovery.ts`): page memory stays the authority and one recoverable model follows each draft
key, for the displayed identity only.

- **New household** keeps the name (`household-create`, `{ v: 1, text }`: WEB-14a's own context and text, so a copy saved by the old
  inline form is restored into the dialog), **Rename** the name and the household version it was composed against
  (`household-rename:<id>`, `{ v: 1, text, base }`), and **a household's Invitations** the username (`household-invite:<id>`), whether
  typed or chosen in the directory lookup (the lookup's queries are presentation; the signup link is a credential: neither is kept).
- Each model is registered while its field is shown and while a draft kept after Cancel is dirty, so an update saves it either way; it is
  frozen while an update reload is prepared (typing is refused, Create, Save and Invite send nothing), and bound, so looking, only once its
  field is shown (Rename and the invitation wait for the household list). After the reload the same route's dialog restores the copy into
  an untouched field, never submitted; a dialog opened again later offers what other tabs left (an offer look).
- A submission takes the model's ticket with the values it sends; only a durable success covers what it sent, and the draft is cleared
  only while it is still what was sent (I7). An uncertain answer covers nothing (Decision H: the unresolved attempt itself is page memory
  only and never part of a copy; a restored name is a new operation, and New household's same-name check still asks first). A restored
  rename is saved under its base, so a household renamed since meets the server's conflict ("changed elsewhere") and is read again; the
  next Save is against the version read then.
- When page memory drops a draft (a success, a Try again that completed the form, Rename's Escape) its session follows: with the dialog
  shown the copies are discarded and the field shows its start; with none, the session ends. A restored rename's base goes with its draft
  (dropped, or reset by "Discard instead"), so a fresh rename afterwards is saved under the household's version of now. When another
  identity's memory is asked for, the previous identity's household models leave the registry.
- **Try again.** I7 is a FIRST-TRY rule. A Try again that is now known to have made the change completes the form as `docs/sharing.md`
  D-12b-18 is written: it forgets the field's text even when the person typed a different name or username after the lost attempt (that
  text is not saved by a later update). Whether a successful Try again should keep such newer text (I7 on the retry path), and whether a
  Try again and Rename's Escape should be refused while an update reload is prepared (the latent DA-2 of the design assessment of
  7 November 2026: no product path reaches it while the dialogs are modal), was decision **D-1**: Kieran decided on 7 November 2026
  (`WEB12B-D1-ANSWER-20261107`, `approval/web12b-d1-answer-20261107.json` in the orchestrator) to keep the behaviour as written, with no
  product change in WEB-12b; keeping the newer text, together with DA-2, is recorded for a follow-up card. The tests below pin the decided
  behaviour, so a later change of it changes them visibly.
- The household dialogs are modal, so while one is open the update banner behind it is inert: a person closes the dialog first (the draft
  stays), or another tab's update asks the page to save (the peer flush).

**The rules, cell by cell** (WEB-12b revisions 2 and 3, Reviews 3 and 4: F-R3-1, F-R4-1; the second design assessment of 7 November 2026,
Branch B′). A cell is one rule for one input under one answer class, event or path. `tests/static/household-draft-writers.test.ts`
machine-checks the whole table together with every WRITER of the drafts, bases and tickets (each tied to the catalogued mutants whose patch
changes its line, or given a reason from a closed set) and every decision EXIT of `run`, `sendAttempt`, `retry`, `invite`, `dropped` and
`completeTicket` (each tied to its cells, or given a reason): each cell names its test and the catalogued mutants whose `expect` names it,
and a mutant of one input's cell names no other input's cell of that rule. A title there is the naming check only; that a test FAILS
when its mutant is applied is the qualification run (`qmut`, every mutant below with its control). "Rules" is
`households-submission-rules.test.tsx`, "Cells" `households-submission-cells.test.tsx` (each title begins with its cell id), "M-1"
`households-recovery.test.tsx`, "Owner" `recovery-owner-discard.test.tsx`, "Page" and "Invitations" the household page and invitations
suites:

| Rule | New household | Rename | Invitation |
| --- | --- | --- | --- |
| R1 frozen: typing (or a directory choice) changes nothing, the press sends (and looks up) nothing | M-1 "while an update reload is being prepared…" (MU-6240, MU-6241) | Rules "R1 Rename…" ×2 (MU-6252, MU-6254, MU-6292, MU-6295) | Rules "R1 Invite…" ×3 (MU-6253, MU-6255, MU-6256, MU-6285, MU-6292, MU-6295) |
| R2 I7: a durable first-try success clears only what was sent | M-1 "I7: a create answered…" (MU-6242) | Rules "R2 Rename I7" (MU-6257) | Rules "R2 Invite I7" (MU-6258) |
| O1 a durable success with nothing typed since clears the draft and its copy | Rules "O1 New household" (MU-6293) | Rules "O1 Rename" (MU-6259, MU-6293) | Rules "O1 Invite" (MU-6293) |
| R3 uncertain, and uncertain then an accepted update (restored, never resent) | Rules ×2 (MU-6261, MU-6307) | Rules ×2 (MU-6262, MU-6311) | Rules ×2 (MU-6263, MU-6315) |
| R3 a definite refusal | Rules (MU-6261, MU-6308) | Rules (MU-6262, MU-6312) | Rules (MU-6263, MU-6316) |
| R3 refusals of other kinds, one after the other | Cells `R3.create.refused-other-kinds` (MU-6319) | Cells `R3.rename.refused-other-kinds` (MU-6320) | Cells `R3.invite.refused-other-kinds` (MU-6321) |
| R3 `closed` (nothing sent, no attempt kept) | Cells `R3.create.closed` (MU-6276) | Cells `R3.rename.closed` (MU-6277) | Cells `R3.invite.closed` (MU-6278) |
| R3 `offline` | Cells `R3.create.offline` (MU-6309) | Cells `R3.rename.offline` (MU-6313) | Cells `R3.invite.offline` (MU-6317) |
| R3 `not_sent` after the quiet retries (held back for Try again) | Cells `R3.create.not-sent` (MU-6310) | Cells `R3.rename.not-sent` (MU-6314) | Cells `R3.invite.not-sent` (MU-6318) |
| R3 Invite's own exits: the lookup finds nobody, the lookup FAILED, inviting yourself | n/a | n/a | Rules (MU-6263); Cells `R3.invite.lookup-failed` (MU-6269), `R3.invite.self` (MU-6270) |
| R4 a restored rename's base: Save under it; Escape and "Discard instead" drop it; a first-try conflict forgets it | n/a | Rules "R4 Rename…" ×3 (MU-6264, MU-6265, MU-6288..MU-6291, MU-6297, MU-6298); M-1 (MU-6243, MU-6244) | n/a |
| R4 typed into after a restore (and after Cancel and reopen) keeps it; a refusal that is not a conflict, or an answer `closed`, `offline` or `not_sent`, keeps it | n/a | Cells `R4.rename.typed-after-restore` (+`-reopened`) (MU-6271), `R4.rename.keep-on-refusal` (MU-6279), `R4.rename.keep-when-not-sent` (MU-6325); control `R4.rename.typed-control` | n/a |
| G a press the dialog refuses (the form submitted by Enter) sends, and looks up, nothing | Cells `G.create.refused-press` (MU-6322) | Cells `G.rename.refused-press` (MU-6323) | Cells `G.invite.empty-press` (MU-6324) |
| W1 the form's start: its own name typed back is resolved by the next save; a form closed untouched begins again from what it then shows | n/a | Cells `W1.rename.typed-back-to-start` (MU-6329), `W1.rename.reopened-after-rename-elsewhere` (MU-6330) | n/a |
| O1 after a success the form takes new input (the session goes on from its start) | (the dialog closes) | (the dialog closes) | Cells `O1.invite.typed-after-success` (MU-6328) |
| W1 to W4: typing, a choice from an EMPTY field, a restored copy, "Discard instead" | M-1 (MU-6240, MU-6286); Owner "CONTROL create…" (MU-6287) | (R1, R4 above) | Cells `W2.invite.choice-from-empty-field` (MU-6274, MU-6284), M-1 (MU-6283), Cells `W4.invite.discard-instead` (MU-6272, MU-6296) |
| D binding: no model for a household you do not manage | n/a | Cells `D.rename.non-manager-not-bound` (MU-6275) | Cells `D.invite.non-manager-not-bound` (MU-6332) |
| W7 Try again on the PAGE after Cancel or Close ends the session (opened again, the dialog begins a new one) | Cells `W7.create.page-after-cancel` | Cells `W7.rename.page-after-cancel` | Cells `W7.invite.page-after-close` (all three MU-6273, MU-6294; Rename's, where the retried name lands, also MU-6331) |
| W7 a Try again REFUSED, not sent (`closed`), or answered uncertain, offline, `not_sent` or forbidden completes nothing | Cells `W7.create.refused-completes-nothing`, `W7.create.try-again-not-sent` (MU-6281), `W7.create.try-again-other-answers` (MU-6326) | Cells `W7.rename.refused-completes-nothing` | Cells `W7.invite.refused-completes-nothing` (MU-6281) |
| W7 a detail action's Try again (a member promoted) is not the invitation's: its draft stays | n/a | n/a | Cells `W7.invite.detail-action-keeps-draft` (MU-6327) |
| W7 where it is pressed: Rename's own dialog closes; another dialog's change leaves Rename open; the detail and Invitations forget | (D-1 below) | Page MU-6233, MU-6238 | Cells `W7.invite.retried-in-rename-dialog` (MU-6280); Invitations MU-6232 |
| W8 Rename's Escape ends the session (copy discarded) | n/a | M-1 (MU-6247, MU-6294, MU-6299) | n/a |
| D-1 (decided: keep as written) a successful Try again forgets text typed since | Rules "D-1 New household" (MU-6266) | Rules "D-1 Rename" (MU-6267) | Rules "D-1 Invite" (MU-6268) |

The shared completion (`completeTicket`) is MU-6260 over every R3 test; that a durable success also FINISHES its ticket is not pinned
(deferred, below). Exits with no cell carry an argued reason in the inventory:
`run()`'s and `invite()`'s refused admission and `retry()`'s guard (no UI path: the buttons are disabled while the same refusal holds),
another identity displayed after a send, a lookup or a conflict's reads (no UI path: its models retire with page memory), and a connection
lost while the lookup is on its way (a race). Off-diagonal Try again pairs other than the one above are not cells: a create's Try again
shows the household it made from wherever it is pressed (D-1 New household), and the Invitations dialog closes nothing on a Try again.
Rename's `value()` base reader is unreachable (a session never begins over a kept rename draft). **Known asymmetries**, listed in the
inventory, not pinned as correct: a first-try conflict forgets the base in page memory only (O-R3-3: the model's last copy keeps it until
the next keystroke; the server's version guard backstops it); DA-2 (latent, with D-1's follow-up card); and **N-1** (the second design
assessment, class `new`, low): a restored rename whose Try again is refused as a conflict keeps its stale base, so the next Save is sent
under it and refused again (never an overwrite), because `retry()` has no writer that forgets it. Whether to fix N-1 is decision **D-2**,
open with the coordinator; cell `R4.rename.retry-conflict-keeps-stale-base` pins the product as it is, and MU-6282 (the fix applied
without its decision) turns it red, so a fix must change that cell and this paragraph.

**Not pinned, deferred to a follow-up card** (Review 5 of 7 November 2026, F-R5-1 and F-R5-2; Kieran's decision
`WEB12B-R5-FINDINGS-TO-FOLLOW-UP-20261107`, `approval/web12b-r5-followup-20261107.json` in the orchestrator: test-sensitivity gaps on
correct, unchanged product behaviour). The product does each of the following, but no test above fails when it breaks: a durable success
finishes its ticket, so a later accepted update's "Save and reload" proceeds (F-R5-1); the Rename and Invitations drafts are kept per
household; a copy of another codec version is offered, not restored; a rename base must be an integer of at least 1; a name of exactly
300 characters and a username of exactly 100 restore, one more does not; after a held-back Try again, a Try again answered `closed`
still says the earlier attempt may have been made (R8) (F-R5-2).

Fixture evidence: `tests/features/sharing/households-recovery.test.tsx` (the production coordinator's accepted update, its save and its one
reload, per dialog; mutants MU-6239..MU-6251), `households-submission-rules.test.tsx` and `households-submission-cells.test.tsx` (the cells above; MU-6252..MU-6299, MU-6307..MU-6332), the
household cases of `tests/features/recovery-owner-discard.test.tsx`,
`recovery-owner-contract.test.tsx` and `recovery-check-again.test.tsx` (ported from `HouseholdsMinimal`), and the native household cases of
`tests/e2e/fixture.pwa-editors.spec.ts` (revisions 52, 53 and 55 over the dialogs). The old screen's composition of several household
forms on one page is gone: F-R52-1's overlapping looks, F-R52-2's three restored invitations and F-R54-1's late earlier restore are carried
by the defaults layers and the library suites (`tests/lib/recovery-observation.test.tsx`, `recovery-discard-focus.test.tsx`).

**WEB-13b's editors (merge correction M-13b-1, 7 November 2026; Kieran's decision "Fix all three in the merge",
`approval/web13b-m13b1-decision-20261107.json` in the orchestrator).** WEB-13b was built before this protocol and kept its input in
page-memory editing sessions only, so on the merged tree an accepted update reloaded over it (R40's class). Now:

- **G-1, the new task's anchor.** The task form's text is version 2 (`tasks/form/form-input.ts`): what the session began from, what is
  typed, and WEB-13b's calendar ANCHOR (the draft the panel saved, the anchor it validated to, the names its summary shows) and the panel
  its in-dialog sync control kept. Version 1 dropped both: the form came back without its anchor, saying nothing, and Save then created a
  task with no anchor whose first day came from its own schedule. A saved anchor is read back only if its draft still validates to exactly
  it (`calendars/anchor-recovery.ts`); a version-1 copy restores with none (that build held none); anything else is offered, never
  restored in part.
- **G-2, the anchor panel** (`AnchorDialog.tsx`, on the new task form and on a task's detail). The panel is a recoverable editor over its
  editing session (`calendars/session-recovery.ts`): registered while shown, every change given to the model first (refused, unchanged,
  while an update reload is prepared; Save and Remove are unavailable then, and the panel never closes as if it had saved), a save
  taking the model's ticket in the same step as it reads what it sends. A session kept for the visit (the sync control) stays dirty and
  listed; its END (Cancel, its own save, the visit's end, another identity) ends the copies. A detail panel's copy keeps its BASE: the read
  of the task its change is checked against, the conflicted change it supersedes and whether a done save renewed it, so a task changed
  meanwhile meets the outbox's own "changed" refusal, never a silent overwrite; the identities of changes pressed are not kept (a restored
  change is a new operation). After the reload the section reopens the panel ONCE on the copy (for someone who may still edit, once the
  task is read), with the restored notice and focus on the panel's first field (the dialog's `initialFocusSelector`: a modal takes focus
  inside it, and the form behind it may have taken focus for its own restore in the same arrival, D2).
- **G-3, the import dialog** (`ImportDialog.tsx`). The same, over the import's editing session: a copy holds the source the drop zone's
  dialog chose and the window AS TYPED, version 1 (`calendars/import-recovery.ts`), under the entry that opened it; the row's "Import
  events" or the drop zone reopens the dialog on it, focus on From. NEVER THE FILE: its text stays page memory (E11) and a file control
  cannot be captured (D-P7), so while a file is chosen or read (or a date is partly typed) the model is unfinished and the update STOPS
  (retry, or "Discard and reload anyway") instead of reloading over it. That holds whether the dialog is shown or its session is KEPT
  with no dialog showing it (the person left by the sync control: the only way to the update banner from a modal dialog). The file is
  the session's, so the model goes on asking the SESSION while it is kept (`editor.ts` `keep(value, unfinished)`, wired by
  `session-recovery.ts`), until a dialog shows it again or the session ends (Cancel, its own save, the visit's end, another identity):
  an ended session holds the update no longer. Before revision 37 (Review 46, F-R46-1) the dialog's unmount dropped that check, and the
  update reloaded over the file unless something had happened to ask the model while the dialog was still shown. A partly typed date is
  the dialog's own state and goes with the dialog. No import is begun while an update reload is prepared.

Evidence: `tests/features/tasks/web13b-anchor-recovery.test.tsx` and `tests/features/calendars/web13b-import-recovery.test.tsx` (the
production coordinator's accepted update, its save and its one reload, the hosts reopening each editor, freeze, the base, and the Cancel
and visit-end controls; on the merge without the correction 11 of their 14 cases fail by assertion), the pure codec suite
`tests/features/calendars/web13b-recovery-codecs.test.ts`, mutants MU-5276..MU-5295 (`scripts/mutation/catalogue-web13b-m1.mjs`), and the
native case "WEB-13b M-13b-1 G-1" in `tests/e2e/fixture.pwa-editors.spec.ts` (generation A updated to B: the new task form restored WITH
its anchor, nothing sent). Revision 57's focus-site registry has the two new sites (23).

Revision 37 (Review 46, F-R46-1/F-R46-2): the import suite's STOP cases leave the dialog by its sync control with nothing asking the model
in between (a file chosen; a file still being read, no window typed), with the control that a kept session's end holds the update no
longer; on the tree before revision 37 both STOP cases fail by assertion (the update reloads). Native cases, generation A updated to B, in
`tests/e2e/fixture.pwa-editors.spec.ts`: "WEB-13b M-13b-1 G-3" (kept with a window typed: reopened on the copy, restored notice, focus on
From, no file, nothing sent; kept with a FILE chosen: the update stops with "Retry save" and "Discard and reload anyway", the page does not
reload, and Back shows the kept file and window) and "WEB-13b M-13b-1 G-2" (a task's panel kept: reopened on its copy, restored notice,
focus on its first field, nothing sent; the task changed while the page reloaded: Save says so and sends nothing). E-IMP7's revision-37
case in `tests/e2e/fixture.calendar-import.spec.ts` reaches the same rule in the fixture build (the save an accepted update makes first
fails), so a real-engine mutant can reach it. Mutants MU-5296..MU-5299 (unit) and MU-5300 (real engine).

## The owners' actions (revision 38; review of revision 37, R40-A/R40-B; design assessment C1-C5)

Revision 37's owners took the recovery model's actions correctly but applied their own effects at the wrong moment or by the wrong rule:
a "Discard instead" whose storage removal completed after newer input erased that input (R40-A), and a copy the person chose was refused
once a copy had been restored automatically (R40-B). Each action is now one step of the owner and the model together:

- **Discard at the gesture.** "Discard instead" is admitted only while the model accepts input (`accepting`: no update reload prepared,
  not retired); admitted, the owner shows its typed baseline and the model holds it in the same synchronous step, and the copies' ordered
  removal starts. Its completion only reports how the removal went (`RecoveryNotice` says when a copy could not be removed; the session
  keeps the debt); it never resets the owner. Component-state editors get this from `editor.ts` (`RecoverableEditor.discard`, with each
  editor's `reset` and optional `baseline`), so no caller awaits the removal; kept-input, the correction and the entry history do the same.
- **Automatic restore and the person's choice.** The look's restore is automatic: only into untouched input, only if nothing happened in
  the session since the look began. A copy the person chooses (`restoreAlternative`) replaces what the owner shows at the choice, a copy
  restored before included (owners get `restore(text, chosen)`); it is applied only if nothing changed the input, the session or the
  choices since it was made (an edit, a discard, a new session, a later choice or a freeze wins), and an owner with a submission pending
  refuses it. A choice not applied is reported, never shown as restored. Nothing restored is ever submitted.
- **Lineage.** The hand-off left to this page and held by it brings the copies its lineage names whether it is restored at once or chosen
  again later (as the DOM form does), so discarding or submitting it removes its predecessors before the carrier (DA-R40-C).
- **Submission and settlement.** A submission's ticket is `current` until the input changes (even back to the same text); a success clears
  the owner only while it is (the households' forms). What a settled save leaves in the recoverable input (a partial add's remaining
  selection) reaches the model in the same synchronous transition as the session (`settle`), never as the person's edit.
- **Remount in the same turn.** A component-state editor's or the entry history's unmount is a dismissal decided after the current turn,
  as kept-input's sessions are: an editor mounted again in that turn (React's development remount) resumes the session, so a copy its host
  restored is neither discarded nor overwritten by a new session.
- **Owners added.** The merged Lists dialogs (WEB-10b): create (`list-form:new:dialog`, one stable context), rename (`list-form:<list>`) and
  the task picker (`list-picker:<list>`: the search and the tasks selected with their titles), through WEB-10b's raw form helpers. Ids, the
  queued create first seen and any save whose outcome is not known are not kept (docs/lists.md: page memory only): a restored name or
  selection is a new save with the ids and the read of now. The Lists pane and the list's detail open the dialog on a copy found after a
  reload. The preset picker now shows its recovery notice, and while an update reload is prepared its footer opens no form.
- **Observed, not changed: a modal dialog keeps the update region out of reach.** While a dialog editor is open (Lists, calendars, the
  correction, the policy editor) the page's update region is outside the modal, so its "Save and reload" cannot be reached; leaving with
  Cancel discards the input, and the input-preserving way out is the dialog's own sync control, which keeps the session for the visit: the
  update is then accepted from the queue, saves it, and Back reopens the dialog on it (`fixture.pwa-editors.spec.ts`). Whether the update
  should be reachable from inside a dialog is a design decision for its owner (WEB-15), not made here.
- **The pre-account username** (Kieran's decision WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026, 26 October 2026). Revision 38 kept the
  sign-in and join username in this tab's session storage and restored the hand-off left to the next page. Revision 39 replaced that with
  the decision's preservation branch (below): restoration could not be shown to reach the person.

## Input no reload brings back; admission while preparing (revision 39; review of revision 38, R40-COMPOSITION/R40-FREEZE; design assessment C1-C4)

- **A saved copy is not a restoration.** A form handle may say that nothing it holds can come back after a reload (`restorable` false).
  The coordinator checks it while preparing a save's reload, before anything is saved or handed off for it, and again in the reload's own
  checkpoint (every exit: the activation, a controller change, the fallback, a refused skip-waiting, an update another tab applied). While
  such a form holds unfinished input (dirty, or a copy not discarded) the tab does not reload: the banner says so (`kept_input`, proposed
  copy: "Reloading now would lose what you've entered here…") with "Reload" (which checks again) and "Discard and reload anyway" (the
  person's explicit choice). A handle that cannot say counts as not restorable.
- **The pre-account forms.** Join's form is mounted only while the page holds the invitation, which boot strips from the address and
  keeps in memory, so a reload shows "This link is no longer valid". A sign-in requested from Join or from a neutral state, a switch and a
  confirmation are page-memory flows too. And a duplicated tab inherits this tab's session storage, hand-off reference included, so
  holding the hand-off's lock proves no same-tab continuation. Their models (`preAccount`) are therefore bound to no store at all, write
  nothing anywhere, and say they are not restorable: their unfinished username keeps the page (the password never leaves the page). Each
  host has its own context (`sign-in`, `sign-in:again`, `sign-in:switch`, `sign-in:confirm`, `join`). Join's sign-in guidance after a
  submission whose result is unknown (spent, refused after submitting, an earlier link's outcome) and a username carried into sign-in from
  Join are page memory too, and hold the update the same way (`holdUnrestorable`; revision 40: held by that page memory itself) until the
  person acts on them. Restoring a username
  across an update again would need a proven same-tab continuation (for example a navigation-bound proof qualified in every engine); that
  is a product decision, not made here.
- **Admission at the gesture.** While an update reload is being prepared (the registry's freeze), no new authentication work starts: the
  password sign-in and the registration take the username's submission ticket (none while frozen) in the same step as they start, from a
  button, Enter or a script alike; single sign-on (the form's, and linking from Settings) takes an outstanding activity
  (`form-recovery/activity.ts`). Work admitted before the freeze is outstanding until its outcome (the update waits for it, whatever unmounts
  meanwhile: the activation gate is not a cancellation); only a durable success consumes the username. Single sign-on leaving for its
  provider stays outstanding until the page is shown again (a return from the back-forward cache), so no reload is made over the
  navigation. The OIDC landing and the session kernel's settlement are protocol continuations, not new submissions: they are not refused.
- **The device name** (merged from WEB-08d). `NameDeviceDialog` keeps the typed name as recoverable raw text per device
  (`device-name:<device>`) of the displayed identity; Save, Enter and Remove name are admitted at the gesture (the footer is shown
  unavailable while frozen); a late success acknowledges only what it sent. The devices list opens the dialog again on a name left before a
  reload, or kept by the dialog's sync control, once the device is listed with naming; a name for a device no longer listed stays in the
  account's recovery store, neither sent nor removed. Cancel, Close and Escape discard it.

## Journeys and continuation authority (revision 40; review of revision 39, R40-GATE and R42; design assessment ae2a506e… C1-C3)

- **A pre-account form's username belongs to its journey, not its mount (R40-GATE).** The neutral gate removes the sign-in or join form
  while its attempt resolves (`1c.finishing` and the other neutral states), and a refusal brings the same host back. Revision 39 still took
  that unmount for the person's dismissal: after one turn the editor ended the model and reset the username, so a refusal that arrived
  later left nothing unfinished and an accepted update reloaded over the form. Now a pre-account editor's unmount only detaches it
  (`editor.ts`): the exact username, its input revision and its submission tickets stay the model's, the handle stays registered (shown
  or not, its unfinished input keeps the page: `kept_input`), and the editor that mounts again for the same journey shows that exact
  username instead of beginning again. Either delivery order (the signed-out view before the refusal, or the refusal first) ends the same
  way. Only an authoritative event ends the input: a durable success of exactly what was sent (its ticket), the person's Back or Cancel
  (the form's Back, a switch dialog's Close or Escape: `endPreAccountInput`), another journey of the same host (a newer invitation link, a
  switch to another target), or an account displayed (`settlePreAccountInput` from `SessionRoot`: the public sign-in, neutral sign-in
  and join journeys end once an account displays; a switch or confirmation ends when the displayed account changes or signs out). An
  editor shown at that moment is left alone. `gating` is not a success: the username stays unfinished until the attempt's real outcome.
  Each host renders its own form instance (keyed by host and journey), so one host's typed state never reaches another's. Account editors
  are unchanged: their unmount is a dialog's close, a departure or the session's protective closure (session matrix 3.6.2), each a dismissal.
- **Page-memory guidance is held by the page memory (C2).** Join's guidance after a submission (spent, unusable after submitting, an
  earlier link's outcome) and a username carried into sign-in from Join hold the update from the store that keeps them
  (`invitationMemory`, `signInRequest`), taken and released in the same step as the memory changes, never by a mounted surface's effect:
  the gate unmounting the join page no longer releases it, and the guidance hands the username to the sign-in request with no moment
  unheld. "Unusable after submitting" (a `401` after the submission) is page memory too (`invitationMemory.unusable`), so the join page
  that comes back after a gate still says it.
- **Who may remove a hand-off (R42; owner decision WEB14A-R42-NON-CONSUMING-20261028, Kieran, 28 October 2026).** A page that took a referenced
  hand-off over proved only that it held a copy of the tab's `sessionStorage` and, once the writer had gone, its lock: a tab duplicated or
  opener-copied from the writer holds the same reference, can take the lock first, and no signal this build reads tells it from the writer's
  real replacement (session storage, the address, history and `window.name` are all copied; automation cannot perform a duplicate-tab
  gesture to qualify any other signal; this is the design's limit, not a claim that no engine could ever tell them apart; authority record
  `atlas-orchestrator/approval/web14a-r42-native-decision-20261028.json`, SHA-256
  `745424702265256c116ac0bfe5887242fedd2ed8c2aad8387303267f9a59c60f`). Revision 39 let that claimant remove the hand-off and its lineage by its own discard, submission
  or save, so a copied tab could erase the input that justified the writer's reload. Now no page removes a hand-off it did not write
  (`session.ts`, `removable`): not by `end`, "Discard instead", a successful submission, its own save's clean-up (debts), "Discard and reload
  anyway" or a later choice of an alternative, in the model and the DOM form alike. It restores it; the ordinary copies its lineage names
  may still go (the hand-off, which stays, holds everything they hold). Its reference is used up when the look that read it is applied
  (`claimLeft`), so an ordinary reload of the tab does not restore it again. The page that wrote a hand-off still removes it of its own
  accord while it lives (a reload that did not happen), and a hand-off no live page holds is offered to later pages of the form, where
  the person's explicit "Discard this copy" removes it. **The accepted cost:** after a restored form is finished or discarded, its
  pre-update copy is offered once more on a later visit to that form until the person discards it there, and until then it counts in the
  local-work, wipe and quota totals; a tab copied from the writer restores it too. A form's `discarded` result means every copy that page
  may remove has gone, not that the retained hand-off has. No released build wrote or read hand-offs before this rule (WEB-14a is
  unreleased), so there is no older consumer to migrate.

## The People forms (integration revision; review of 2 November 2026, F-INT-PEOPLE-Q4)

The accepted People implementation (WEB-11a) merged three editors whose input lives in People PAGE memory with an editing session
(`src/features/people/memory.ts` `drafts`, `lifetime.ts`): new person, rename and the field editor. None was registered, so an accepted
update reloaded over typed input (the review's witness: `registry=[]`, one reload). Each now takes part through `src/features/people/
form-recovery.ts`, one recoverable model (`model.ts`) per displayed identity and Q4 context, owned by People memory as kept-input is by
the task feature:

- **One model session per People session.** A form beginning a new editing session begins the model's; a session kept in page memory
  (a remount, the dialog's sync control, leaving and coming back) resumes it. A session that ends without a save (Cancel, Escape, the
  close icon, "Discard mine", leaving an unread editor: `retireSession`; the editor's archive) ends the model's and discards its copies.
- **Every change in the same step.** The person's change goes to the model before the form takes it and is refused while an update
  reload is being prepared (Save shows "unavailable while reloading"). A save's report that re-binds the form is `settle`, not an edit.
- **Listed while it matters.** Shown while mounted; while dirty or with a save outstanding it stays listed with no form mounted, so a
  session the sync control kept is still saved by the update (the review's unmounted case).
- **A save is a ticket.** Taken in the same step as the People admission (none while frozen: nothing sent, nothing admitted); only a
  durable success (queued, a receipt, a durable hold) covers what it sent; a refusal, an uncertain online attempt, a stale binding or a
  partial save keeps the input. The update waits for a ticket outstanding before its last save.
- **Every other admitted operation of a session is outstanding too** (revision 50; review of revision 49, F-R49-1). The field editor's
  "Save mine on the current version" (it sends the stored conflicted save) and its Archive admit, in the same step as their People
  admission, page work (`lib/form-recovery/activity.ts` `admitActivity`; none while frozen: nothing admitted or sent). The update waits for
  it whatever shows the editor meanwhile (its sync control, a remount), until its outcome is told and, for a successful archive, the
  session's input ended. Neither is the model's ticket: neither sends the editor's input, so neither marks it saved (input typed before
  "Save mine" stays unfinished, and the update saves it).
- **A success with no form mounted ends the session's model** (revision 50, F-R49-2). A save that completes for the session's current
  input (`completeSession` "closed") while no form of the session is mounted ends that session's model as a mounted form's close does: a
  re-binding the save itself made (`settle`, a confirmed audience) moves the model's input past the ticket, so the ticket alone could not
  cover it. Only that session's model (a later session under the same key is never ended); later typed input (`kept`), refusals,
  uncertain and partial saves, another identity and the held operations are unchanged.
- **Codecs** (`model/recovery.ts`): one canonical, versioned (`v: 1`) text holding the WEB-11a serialisers' fields (the field editor's
  hidden typed slots included) and what the input was composed against: the rename's and field edit's binding (`snapshot`), where a
  field edit began (`origin`) and a new field's id (`newFieldId`, so a retried create of restored input is the same field). Never an
  attempt, request id or secret. A copy that does not read back with its shape is offered, never restored in part.
- **Restore hosts.** The people list reopens "New person", the identity header reopens Rename, on a copy found while no form shows the
  context and page memory keeps no input for it (kept as a new editing session; never submitted). The field editor is route-addressed:
  its own mount looks. Restored rename and field edits keep their original binding, so a person or field changed since is reviewed
  ("changed since"), never silently overwritten.
- **Not changed.** The held audience changes (`people-held:`) remain operations of the conditional port (compare-and-set by content
  digest); no model, look, save or discard touches them. Uncertain online attempts stay in page memory, unchanged; after a reload a
  restored save is a new attempt under the original binding and ids. Other identities' models retire with their page memory.
- **Native coverage** (`tests/e2e/fixture.pwa-people.spec.ts`, three engines): New person, Rename and the field editor on a typed field,
  each saved by "Save and reload" and restored on B without being submitted (nothing written, nothing queued), and each refusing the
  reload when the save fails, then saving on "Retry save". Rename and the field editor live on a person's page: since revision 50 the PWA
  world SEEDS a synced person (`seedAccount` `rows`) and the generation server answers that person's People reads (the list's summaries,
  the person, its summary and duplicates) from its CANNED READS (`POST /reads` of `scripts/serve-generations.mjs`: GET only, set per
  test, none by default). Fixture evidence of the client, not of a released backend. Running person pages offline remains unsupported
  in this world (WebKit's Playwright build fails worker-served loads under `setOffline`).

## Restored-form focus: every product editor names its destination (revision 51; review of revision 50, F-R51-1; design assessment of 3 November 2026)

Review51 found the restored People forms and the sharing editors showing the right values while focus stayed on the page heading or a
dialog's sync control, and a keyboard "Discard instead" leaving focus on the body: their `RecoveryNotice` named no field, and a dialog's
own initial focus hid some of it. The approved behaviour (form-recovery-reload.html "Focus order": focus returns to the restored form's
first field on mount, and `RecoveryBanner`'s revision-19 "Discard instead" contract) is now a REQUIRED part of the caller contract:

- **`RecoveryNotice` requires `firstFieldRef`** (a `FocusTarget`, `lib/form-recovery/focus.ts`): a ref to the control itself (never a
  wrapper), or a resolver the owner answers from its committed DOM at each attempt, for a target its state chooses. Optional
  `discardFocus` names a different destination after a discard, for an owner whose discard removes the editor. Type checking makes a
  forgotten destination a build error; behaviour tests catch a target that is null, conditional or gone.
- **"Discard instead" from the keyboard** returns focus through a request held by the OWNER (`useDiscardFocus`, in `RecoveryNotice`), not
  by the banner, which goes with the copy. It is admitted at the gesture and resolved after the owner's reset is committed (a target the
  reset inserts or replaces is the one focused), never when the copy's removal completes. It ends without focusing as soon as focus is
  placed anywhere else (the person, a prompt, a failure), at a navigation, at a newer discard or the owner's unmount; a discard that was
  not admitted (the banner still there once the gesture's commit is done) leaves focus on its button. A pointer discard that did not
  focus the button moves nothing. Not a restored request: DA-F1 and DA-F2 are unchanged.
- **Destinations.** People New person, Rename and the field editor, list Create/Rename: Name. The task picker: its search. Record
  progress: the amount when "Log an amount" is chosen, else the chosen mode (design assessment DA-N1: "Just checked on it" has no amount
  field; its discard focuses the amount field the reset brings back). The preset picker: the checked preset. Sharing defaults: the
  layer's chosen option. A resource's policy: its first grant's chosen access, or the grants' first control ("Add account grant") for a
  policy with none. Focusing never chooses a value. Calendar, device name, households, the task form and the correction already named
  theirs.
- **Decision D1 (Kieran, 3 November 2026): no field to focus, the owner's surviving control, else its heading.** The entry history: an
  opened restored fix focuses its new value (a tick or an item, its first action); a PARKED fix (its entry cannot be fixed now; nothing is
  opened by the restore) focuses that entry's "Fix this entry" when shown, else the history's heading; after a discard (the fix goes, open
  or parked), the same. The preset picker with no choice to show (offline, failed, no presets): the dialog's own opening focus, never the
  banner; while the presets are read nothing is focused yet.
- **Decision D2 (Kieran, 3 November 2026): restored forms of one arrival, the first in the page.** Requests pending together are attempted
  in page order. One restored later takes focus from another only when it comes first in the page AND focus is still on that other form's
  field; otherwise its request ends, so focus the person moved is never taken by a later restore and nothing goes back and forth.
  Revision 52 (Review52 F-R52-2): the comparison is with the CURRENT grant, the restore that most recently took focus (and the element
  focus actually landed on), never the first restore that once did; a successful pre-emption replaces it. So any number of restored forms,
  in any order, settle on the first in the page (three restored forms released C, B, A end on A; `recovery-discard-focus.test.tsx`). Focus moved elsewhere, including
  onto an earlier, superseded restored field, is never taken. When the current grant's owner withdraws its restore (its copy discarded, or
  it unmounted) with focus nowhere or where the arbiter put it, the grant ends; with focus moved elsewhere by anyone else, it stays until
  the next navigation, so a later restore still takes nothing. When the granted field itself is replaced and focus is nowhere, a later
  restore may take focus (it takes nobody's). Completed requests remain history only (a same-arrival prompt stays suppressed, DA-F1).
- **Never a recovery surface (revision 57; Review 57 F-R57-1; design assessment of 6 November 2026, C-F2/C-F3, I-F1/I-F2/I-F4).** The
  restored banner, the other saved copies and the check again (`RECOVERY_SURFACE`: `[data-recovery-state]`, `[data-recovery-alternatives]`,
  `[data-recovery-check]`) hold actions that discard or replace the input the person came back to. A restored, chosen or returned
  request's target inside one is REFUSED (`recoveryTarget`): treated as no target yet, so nothing is focused for it and DA-F1's pending
  restore does not hold a prompt back; development and test builds report it (`tests/setup.ts` fails the test whose editor named it), a
  production build never throws. `firstControl`/`openingFocus` skip all three surfaces (before, another copy's Restore could be a dialog's
  "first control"). The banner's own fallback after a keyboard discard goes through the same check. Every `<RecoveryNotice>` site is
  registered with the kind of its target (`tests/static/recovery-focus-sites.test.ts`: a ref; a region of the editor that never holds the
  notice; or a closure over a body that does) and a region or closure site names the jsdom case that asserts its focus after a restore;
  a new site, a changed target or a missing case fails there.
- **Coverage.** `tests/lib/recovery-discard-focus.test.tsx` (the request and D2), each caller's restore and keyboard discard in the
  People, lists, preset, owner-discard and owner-host tests, and `tests/e2e/fixture.pwa-people.spec.ts`: on B the restored form's first
  field has focus before any test gesture, native keyboard traversal reaches "Discard instead" and Enter leaves focus on that field, in
  Chromium, Firefox and WebKit.
- **Another copy chosen while a copy is restored (revision 53; decision D-R53-2, Kieran, 3 November 2026; design assessment Q7).** The
  restored banner stays mounted, so `useRestoredFocus` sees no new presentation. The notice's choice of another saved copy therefore makes
  a fresh "chosen" request (`useChoiceFocus`) once the choice is APPLIED, for the restored form's first eligible field (`firstFieldRef`;
  D1's owner-control or heading fallback where it has none), never the removed button. It follows the discard return's rules: pending
  until the target can take focus and the used control has gone; ended without focusing once focus is placed anywhere other than where it
  was at the choice (a browser that does not focus a clicked button keeps focus where it was), by a navigation, a newer choice or the
  owner's unmount. A choice not applied (refused, gone, unreadable) requests nothing. A landed choice supersedes an automatic restore still
  waiting. Revision 55 (Review 54, F-R54-1; design assessment of 5 November 2026, C-F1): a landed choice is the person's placement, so it
  becomes the arrival's current grant with its own kind ("chosen"), whichever form held the automatic grant before (the chosen form
  itself, or another whose restore is withdrawn later). No automatic restore of the arrival pre-empts it while focus is on its field, as
  focus moved by hand is never taken; it ends only at a navigation or when focus is nowhere (its field went), never at another owner's
  withdrawal or while a newer choice is still being read. D1, D2 among automatic restores, DA-F1/DA-F2 and the discard return are
  unchanged (a keyboard discard's return is still not protected like a choice: that parity is an owner question). A choice made with no
  restored banner shown is focused by the banner's own arrival (D2), as before. Coverage: `tests/lib/recovery-discard-focus.test.tsx`
  (revision 53 cases), `tests/features/recovery-check-again.test.tsx` (household and policy editors) and the native household journey.

## Test builds and constants

`node scripts/build-pwa-generations.mjs` builds `dist-pwa/` (ignored, never packaged): `production-a` (a copy of `dist`), `production-b`,
and `fixture-a/b/c` (`vite build --mode pwa-fixture`: the fixture entry with the worker; the label written to `data-atlas-build` makes each a
generation of its own; HTML `modulepreload` hints are omitted, as in production, see `.agtx/evidence/WEB-14a/qualification/preload-warning.md`).
`scripts/serve-generations.mjs` serves one at a time with nginx's semantics and the production headers, `Cross-Origin-Opener-Policy`
included, to every engine (revision 1, R9: revision 0 omitted COOP for Firefox; that run's evidence is kept as adapted evidence). The first
navigation of a fresh Firefox page is made by the page itself (`navigate` in `tests/e2e/pwa-world.ts`; `docs/browser-support.md`). Every
timing above is a production constant; no test shortens one.

The checks that the worker never asks for a backend path (WEB-14a revision 43, F-FRESH-2) judge each request, not the server's whole log:
open signed-in tabs keep reading (Today's sharing defaults and both daily scopes, among others), so neither "nothing else was requested" nor
a list of allowed paths can tell a page's read from a worker's. The server numbers every request and returns the number in
`X-Atlas-Fixture-Request` (test builds only; its append-only `/ledger` is never cleared). `tests/e2e/request-origin.ts` joins each number
to Playwright's own record of the response: a backend request passes only if a page's frame made it and the server, not a worker's fetch
handler, answered it. Qualified per engine: Firefox and WebKit never report a worker's own request (it stays unattributed and fails),
Chromium reports it as the worker's, and `fromServiceWorker` marks a forwarded answer in all three
(`.agtx/evidence/revision-r43-20261102`).

Revision 44 (review r43: F-FRESH-2 incompletely fixed) makes the accounting total. Every request admitted to a window must also END inside
its bound. The browser must report `requestfinished` (response headers alone are not an end) and, for a backend request, the server
must have finished its own receipt; a request still pending, failed (before or after headers), of unknown origin or without its receipt is
a problem, never a pass. One function, `reconcile` in `tests/e2e/request-origin-judge.ts`, decides both when the wait may stop and whether
the window passes. Its domain is the window's server ids plus every receipt its backend records name, and the window's browser records plus
every record still unfinished when it opened. Windows are handed out one at a time. The opening browser cut is taken before the ledger
read, and each close judges exactly one ledger reply and the browser snapshot copied after it. One unchanged 5,000 ms bound covers the
close, its abortable ledger reads included. The last window is `final`: it has no successor to pass unfinished work to. What a window
proves is the interval it observed, not the absence of later traffic. Engine limits found by native qualification
(`.agtx/evidence/revision-r44-20261102`):

- Chromium reports a `fetch()` as finished only once its body is read. The app's transports read every body.
- Firefox does not report a page request whose worker `respondWith` never settles. That case cannot be admitted there; a server-held
  request is Firefox's native witness of an unfinished request.

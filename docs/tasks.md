# Today and tasks (WEB-10a)

*Written by WEB-10a, 12 October 2026, against the pinned contract `v0.28.0-rc.1`. Consumers: WEB-10b (lists), WEB-10c (materialisation,
dependencies, timers, rotas, streaks), WEB-14b (reminders), WEB-11a (people names). Fixture-stage work: `integration_passed` is false.*

## What this slice does

- **Today (`/today?day=YYYY-MM-DD&tz=Area/City`, WF-TODAY-01).** The day's occurrences in a display zone: filters All / To do / Done /
  Missed, the summary "{done} of {total} done · {to do} still to do" (with "· {n} not known" when a state is not known: unknown is never
  counted as zero), time-of-day groups, one row per occurrence with my state, a pending mark, the carry consequence, who takes part and the
  quick action ("Mark done" for a tick goal; "Record" opens the task). States: loading, empty, error (banner with request ID and Try again;
  cached rows stay under it), offline, and the `pending_tasks` notice.
- **Tasks (`/tasks`, `/tasks/new`, `/tasks/<id>?occurrence=<id>`, `/tasks/<id>/edit`, WF-TASK-01/02/03).** The list (100 a page, an
  Archived filter), the detail (record card for every goal kind, history with corrections, participation and the joint line, enrolment,
  closure and streak exclusion, archive/restore, sharing through WEB-12a's editor), the form with presets, and the one-day correction.
- **Commands.** `create_task`, `revise_task`, `record`, `exclude`, `resolve`, `revise_occurrence` and `archive` are queued through the
  outbox (`model/commands.ts`); `enrol` is online-only (`/task-access-commands`, one attempt per body).

## Public interface (`src/features/tasks/index.ts`)

Import only from the index.

| Export | What it is |
| --- | --- |
| `model/contract.ts` types and parsers | `TaskDefinition`, `OccurrenceData`, `ProgressState`, `OccurrenceView`, … and `parseDefinition`, `parseOccurrenceData`, `parseProgressState`, `parseOccurrencePage`, `parsePresets`, `parseJournalPage`, `parseEnrolment`, `parseTaskDetail`, `parseProjection`. Strict: exact keys, every bound; `null` on any mismatch. |
| `evaluate`, `aggregate`, `finalise`, `layer`, `personalResult`, `eligible`, `actionable`, `scheduledOn`, `inDayView` | The server's evaluation mirrored (`crates/core/src/tasks/mod.rs`, `service/reads.rs`). `aggregate` is for tests and documentation only: **the client never shows a joint result it computed (Q8).** |
| `uuidV5`, `occurrenceId`, `progressId`, `slotKey` | The deterministic ids (async, SHA-1 through `crypto.subtle`): compute them BEFORE enqueueing. |
| `model/time.ts` | `resolveWallTime` (fold → earlier; gap → forward by the change of offset), `windows`, `firstSlot`, `slotOn`, `dateIn`, `todayIn`, `dayEnd`, `gapShifted`. |
| `model/commands.ts` | The request builders (`createTask`, `reviseTask`, `record`, `exclude`, `resolve`, `reviseOccurrence`, `archive`), `QUEUED_KINDS`, `commandOf`, `pendingEvidenceOf`, `canonicalDefinition`. |
| `registerTaskCommands(registry)` | Describe / project / current read / rebuild for every queued kind; idempotent per registry. The protected tree registers into the page's registry. |
| `TasksBoundary`, `TasksEnvProvider`, `useTasksEnv` | The environment (the `SharingEnv` pattern): the stamped client for the displayed `(account, epoch)`, `identity`, `online`, `writable`, clock and ids. |
| `useTaskActions`, `RecordCard`, `TodayRow`, `composeRow`, `RowModel` | The acts and the shared components. |
| `taskPath(id, occurrence?)`, `todayPath(day?, zone?)` | Route helpers. |

### Obligations of a consumer

- A command for a task resource goes through the builders here, or follows the same targets and version bases (table in the plan §3.3):
  `record` is checked against **my progress stream** only for checkbox and checklist evidence without `replaces`; quantity, observe and
  corrections raise the stream as a side effect and send no `expected_version`. `exclude` is checked against my stream, `resolve`,
  `revise_occurrence` and `archive` against their own resource, `revise_task` against the task with `expected_policy_version`.
- Never record for another person (TASK-18): `subject_account_id` is the signed-in account.
- `happened_at` is the instant of the person's act (Unix seconds), taken when it happens, never at send.
- A value from the cache or the server is parsed with the strict parsers at READ time. No page-level value validator is registered for a
  task kind (D-10a-3): one bad value would fail a whole sync page.
- A screen that reads on mount records a `403`/`404` with `noteIfRefused` **when the answer arrives**, not after checking it is still
  mounted: a `403` remounts the protected tree before the screen's continuation runs (measured: dozens of `/daily` reads a second).
- **Read every page of the outstanding work** (revision 1, R4): `useAllOutstandingByKind` / `useAllOutstanding` follow the reads' cursors and
  are `loading` until the whole overlay is read; a view never composes my result from the first window alone. The single-page hooks remain
  for a caller that pages explicitly (`next` is `{id, after}` for `readOutstanding`, a `created_seq` for `readOutstandingByKind`; a page may be
  empty and still continue).
- **A deep link names its write target** (revision 1, R1): an `occurrence` in the address is shown only if it is this task's; otherwise the
  detail says it is unavailable and offers nothing to record. A consumer linking to a day passes the id it means; it is never replaced.
- **A save acknowledges what it submitted** (revision 1, R3): an input editable while its save is pending is cleared, closed or forgotten
  only if it was not edited after it was submitted (the task form, the record amount, the correction dialog and the entry fix all do this).
- **"Save as new" of a task command** (revision 1, R5) rebuilds the request with its own builder on the REVIEWED version (`reviewedBase`), keeps
  every target and the captured defaults, and is conditional on the draft not having changed. `resolve` offers no rebuild (no authorised
  single-occurrence read exists for its draft).

## Decisions taken in this slice (D-10a-1 … D-10a-15)

1. **Sources.** Resources from the cache; derived fields (`outcome`, `period_outcome`, `actionable`, membership, `pending_tasks`) from `GET /daily`
   while online, in page memory for the displayed identity only. Two reads per view (`scope=joint`, `scope=personal`), both `state=all`. Offline the
   day is derived from the cache (§ offline below).
2. **No `kind_date` deriver, no schema change.** The offline day is a bounded walk of every cached occurrence (`scanResources`, 100 rows a
   window, a macrotask between windows). A recorded departure from WEB-04 D's `by_kind_date`. The cost at large caches is a diagnostic for
   WEB-09c/09d (trigger: a desktop full walk of 10,000 occurrences over 2 s in Chromium).
3. **Strict parsing at read time**, never a page-level validator. An unparseable row says "This item can't be shown on this device".
4. **Create sharing**: "Use my defaults" (the task audience from the B5 record) or "Only me" (an explicit empty policy, still queueable).
   Choosing people is done after save through Sharing on the task (WEB-12a's editor); there is no second policy editor.
5. **Online reads are this slice's own loader**, bound to `(account, epoch)`; refusals are remembered per identity (`memory.ts`).
6. **`pending_tasks` disclosure without catch-up.** A non-blocking notice; `materialise` and "Catch up" are WEB-10c's (escalation E-1 below).
7. **Enrolment** is online-only, one attempt per body (`model/attempt.ts`).
8. **Status vocabulary** (first rule wins): Conflict, Excluded, Done (Done late), Waiting on an earlier day, Closed not completed, Missed, On
   track, To do, Not open yet, Not available offline, Not known.
9. **Pending marks**: "Not sent yet" (queued, or held for a review), "Sending…" (in flight), "Waiting for the server" (acknowledged, effect not in
   the cache). The locally layered result is labelled "provisional".
10. **Display zone and day in the address**; the default zone is the device's, shown on the chip and changeable; the default day rolls over at
    local midnight.
11. **Time-of-day groups** by the slot instant in the display zone: Morning before 12:00, Afternoon to 17:59, Evening; date-only, undated and
    overdue rows in "Any time today" (an overdue row shows "From {day}"). Within a group: by instant, title, id.
12. **"Record" opens the task** for that day and focuses the record card; "Mark done" records in place (tick goals only).
13. **Queued-edit coalescing.** Saving the form of a task whose `create_task` is still `queued` edits that draft in place; a second
    `revise_task` that is still queued and never sent is edited. The defaults review block is kept or widened, never cleared by an edit.
14. **No `happened_at` editor.**
15. **WF-QUEUE-02 current reads**: task-level kinds read `GET /tasks/{id}`; `record`/`exclude` read `GET /progress?parent_id=<occurrence>`
    (my stream is found among the primary targets AND the side effects: an amount names it as a side effect). `resolve` and
    `revise_occurrence` register none (no single-occurrence read in the contract), so neither is rebuilt.

Revision 1 (review of 13 October 2026) adds:

16. **Freshness of my result from `/daily` (R2).** It applies only while the device is online, for the cache generation its read began under
    (a committed sync page makes it stale until the re-read answers), and, row by row, until a window boundary of the row passes after it was
    answered (`answerCovers`). Otherwise the row shows the personal reapplication with its finalisation. Offline, the day is the device's (the
    last answer does not list it); the joint result stays the server's alone (Q8), shown with its time by the detail.
17. **The displayed day of the detail (R1).** The address's occurrence by its own id (parent = the task's details, task id = the task);
    unavailable otherwise. Without one: today's slot read by id, else the latest by date of every saved day (a bounded walk). The picker lists
    a page of 100 saved days at a time ("More saved days" / "Previous saved days"), plus the selected day.
18. **The default day's midnight timer (R6)** re-arms itself on every six-hourly wake and re-reads the day when the page is shown or focused; a
    day in the address never moves.

Revision 2 (review of 13 October 2026 and its design assessment) adds:

19. **Whole-input freshness (R2; supersedes the time and generation rules of 16).** A `/daily` answer carries its provenance: when each scope's
    accepted page chain was DISPATCHED (a `409` restart counts from the restart), each scope's `revision`, and the durable cache position read
    when the read was dispatched (`readCacheRevisionNow`, the content revision: an empty delta page changes nothing and asks for no re-read). A row's STRUCTURE (definition, window, participants, `can_edit`, version) and its DERIVED
    fields are chosen separately (`structureOf`, `composeRow`): the committed cache row wins unless the daily item is ahead of it (a newer
    version; the same version read after the cache's last commit; or a row the cache does not hold that this view never held, so an old answer
    cannot bring back a removed one). My result is the server's only when no cache page was committed since dispatch, no window boundary of the
    row passed since dispatch (delivery never renews an answer), and the server's item is of the structure's version; otherwise it is the
    personal reapplication with its finalisation. The server's membership of the day applies only while its answer for the row is current. An
    answer already stale when it arrives is asked for again once (its re-read is dispatched after the boundary). Joint results stay the server's.
20. **Coherent composition (C2).** Today composes from the occurrence, task and progress rows of ONE related read (the durable position is read
    before and after; a read that spans a commit is read again, at most three times), for the current candidate ids; otherwise it keeps the last
    coherent composition and marks the list `data-today-refreshing`. The walk only discovers candidates. The queue key includes each draft's
    `command_digest`, so a queued edit under the same id and status re-walks. A pending entry the synced stream already lists is not counted
    again.
21. **One boundary clock for Today and the detail (R8).** `useBoundaryClock` holds the time a screen evaluates against and wakes at the next
    opening or closing of the windows shown (Today: every candidate row; the detail: the displayed day, its queued correction applied), capped
    at six hours with waits that arm themselves, re-reads the clock on `visibilitychange`, `focus` and `pageshow`, evaluates at once when new
    data brings a boundary that has already passed, and moves its epoch (Today asks `/daily` again) when a boundary is crossed or the clock went
    back. The detail's `now` feeds its result, pill and record card. The detail's default day is chosen once per visit: moving it at midnight
    would retarget an open record card or correction; the record card, entry history and correction dialog are keyed by the day shown.
22. **Correction editing has an owner that outlives the dialog (R3).** `detail/correction-owner.ts`: per identity and day, a session (numbers
    never reused) with a revision every edit advances, wherever it is made. A save captures `{session, revision}`; its completion consumes the
    entry only if it is still that session at that revision, and the session's CURRENT editor (if one is mounted) closes itself on that
    notification: no mount ever closes through an earlier mount's callback. Cancel, Escape and the close icon end the session (a save already
    made stays queued); the in-dialog sync control retains it; another identity's sessions are dropped. The entry fix carries a session number
    from its parent (a reopened fix of the same entry is never closed by an earlier one's save), and the task form navigates only while it is
    still mounted.
23. **The conflict choices read the queued operation (DA-N1).** "Someone else corrected this day first" reads the conflicted draft WITH its
    command (`useDraftWithCommand`, the existing `readDraftWithCommand` plan) and shows and resends what was SUBMITTED (`submittedCorrection`):
    the full definition, date and time, rebuilt in full on the version shown (`reviewedBase`) and only if the stored operation is still the one
    read (`expectDraft`: id, status, digest). A reload, another tab, or a second conflict of the replacement all work from the durable
    operation; page memory is not used. "Save mine" is offered only once a version newer than the one the operation was built on is on the
    device; an unreadable command says so. "Discard mine" is always offered.
25. **Today asks `/daily` again only when committed CONTENT changed (a regression of revisions 0–1, found in revision 2).** It followed
    `page_seq`, which an empty delta page also moves. With the production leader every stamped read changes the session's view, which wakes
    the idle engine; its empty page moved `page_seq`; Today read again 750 ms later: two reads per tab and one sync every ~0.8 s, for ever
    (E-C13's healthy engine never went quiet; E-C8's follower kept seeing its gate re-read). Two generations now: every committed page
    (`page_seq`) re-reads the LOCAL rows (cheap, whatever the page carried); only committed content (the applied revision,
    `readCacheRevisionNow`) asks the SERVER again and decides whether an answer is still current. Tests: `freshness-provenance.test.tsx` (an empty page asks nothing; content asks again; MU-2102), E-C13 and E-C8
    unchanged (MU-2103 natively).
24. **The destinations' heading is the route's (a regression of revisions 0–1, found in revision 2).** Today and the task list replaced
    placeholders whose level-one heading was always there; the screens then put it inside the cache gate and the lazy chunk, so a gated or
    still-loading page had no h1 (the sync-screen specs' axe "page-has-heading-one") and a route change found no heading to focus (the shell's
    route-focus case). Both routes now render their heading outside the gate and the lazy screen; `CacheGate` takes an optional `heading` that a
    gated task page shows (its own heading is part of the hidden content). Tests: `route-headings.test.tsx` (MU-2091…MU-2094); the shell and
    sync-screen specs.

## Personal results offline (ARCH §3.3c, TASK-31)

In order: covered (and I am listed) → incomplete, then missed when closed; my stream excluded and the task allows it → excluded; my stream
by its DETERMINISTIC id (never `participants`): absent with nothing pending → "Not available offline" (listed, or Anyone) or no result (not
listed); present → the stored outcome finalised when the window has closed (provisional → complete, incomplete → missed, unknown → missed only
for checkbox, checklist and minimum-only goals), never re-derived from `recent_entries` (at most eight) or `entry_count`; my pending evidence
layered on (exact for appended evidence; a correction only when the whole stream is known, otherwise "waiting for the server to check the full
history").

## Deviations and additions, for the connected-app checkpoint (STAGED-ACCEPTANCE-20261011)

Provisional copy and these choices do not block; they are collected for the human review after WEB-10a/10b/11a and Settings are integrated.
Each can be reproduced with the fixture states of `tests/e2e/fixture.tasks.spec.ts` (the case named).

| Item | Route and fixture state |
| --- | --- |
| Pill words beyond the drawings, "· n not known" | `/today` (E-T1, E-T9; jsdom `today-page.test.tsx`) |
| `pending_tasks` notice without "Catch up" | `/today` with `pending_tasks` (E-T1) |
| Error banner keeps cached rows under it ("Showing what's on this device") | `/today` with a failing `/daily` |
| Joint-line wording ("Withheld — …", "No one has finished it yet that you can see", "Shared result not known yet", "last checked …") | `/tasks/<id>` of a shared task |
| Pending marks | `/today` after "Mark done" offline (E-T2) |
| Time-of-day boundaries; overdue rows "From {day}" | `/today` (E-T12) |
| "Record" navigates to the task | `/today` numeric row |
| Create sharing as "Use my defaults / Only me" | `/tasks/new` (E-T3) |
| No search in the list; an "Archived" filter instead of the Settings ledger | `/tasks` (E-T6) |
| Time of day added to the correction dialog | `/tasks/<id>` → Correct this day (E-T7) |
| No `happened_at` editor | — |
| "Let people skip a day without breaking their streak" toggle (required by Q21, absent from the drawings) | `/tasks/new` |
| Time zone and participation fields from the baseline | `/tasks/new` |
| Participants as counts ("You and 2 others"), names are WEB-11a's | `/tasks/<id>` |
| The header says "Who can see this is set in Sharing." instead of naming the audience (the policy is readable by its owner only, online) | `/tasks/<id>` |
| The "‹ Tasks" link shows at every width (the CSS budget had no room for a desktop-only rule); the mobile tab bar stays on the detail | `/tasks/<id>` |
| Status colour only for Missed and Conflict (Done uses the neutral pill: the CSS budget); the words always say the state | `/today` |
| Preset subtexts are built by the client from the definition | `/tasks/new` (E-T4) |
| Tablet landscape at 1180×820 and 1112×834 both tested | E-T1 |
| Revision 1: "This day isn't saved on this device, or isn't one of this task's days. Nothing can be recorded for it here." with "Show this task's days" | `/tasks/<id>?occurrence=<another id>` (jsdom `detail-selection.test.tsx`) |
| Revision 1: "Loading this day"; the picker's "More saved days" / "Previous saved days" (saved days are listed by id a page at a time, each page shown by date) | `/tasks/<id>` with over 100 saved days (jsdom) |
| Revision 1: a correction or fix saved while the person kept editing stays open with the newer value (the announcement says the earlier one was saved) | `/tasks/<id>` → Correct this day (jsdom `save-acknowledgement.test.tsx`) |
| Revision 2: "The other correction hasn't reached this device yet." (no "Save mine" until the newer version is synced) and "Your saved correction can't be read on this device." | `/tasks/<id>` with a correction in conflict (jsdom `conflict-context.test.tsx`) |
| Revision 2: while a newer composition is read, Today keeps the last one on screen (marked `data-today-refreshing`, no visible text) | `/today` after a sync page (jsdom `freshness-provenance.test.tsx`) |
| Revision 1: "Who sees my progress" offers any account, and the server refuses one who cannot see the day with its generic "Check the request fields and values." (it reports `IdentityGrantRequired` as `invalid_value`); a clearer message is WEB-12a's editor and the contract's | `/tasks/<id>` of a personal task → Who sees my progress (I-T20 notes) |

## Escalation E-1 (material, not blocking WEB-10a)

No fixed-recurrence task gets a second occurrence until WEB-10c's `materialise` exists: the server makes only the start-date slot at
`create_task`. At the connected-app checkpoint recurring tasks would show only on their first day, with the `pending_tasks` notice. The options
are the operator's (schedule WEB-10c before the checkpoint, or approve a minimal catch-up here by a scope change). Nothing here adds
`materialise`.

## Limits

- **Paging the saved days by id.** No day index exists (D-10a-2), so the picker's pages are in id order, each shown by date; the latest day
  is found by a walk of every saved day of the task (F-1's cost applies to it).
- **The native E-T10 cannot see the hook's own layers.** On a real account switch the protected tree remounts, which discards the old view
  before a late answer could be applied (an A/B with the three-layer mutant passed). The hook's layers are mutation-tested in jsdom (MU-2025),
  where the identity changes without a remount.
- **The first answer on a device without a database.** An answer dispatched before the database existed is not current for my result; Today
  asks again once its rows are read at a cache position (the `behind` re-read). That path has no separate test (the jsdom world cannot create
  the database after mount); its effect is limited to one extra `/daily` read.
- **Other cards' specs that used Today as a neutral page.** E-SH15 (WEB-12a's sharing spec) held every `GET /defaults/snapshot` on a page
  showing Today, whose own defaults read (now needed by its quick actions) was then released in place of the gate's: it boots on the task list
  instead (labelled adaptation, assertions unchanged). The shell and sync-screen specs needed no change once the heading regression was fixed.
- **The dialog reveals a focused control whole** (`src/components/ui/dialog.tsx`, revision 2): a shared component changed for R7's keyboard
  evidence; every dialog benefits. Covered by `tests/components/dialog-reveal.test.tsx` (MU-2090) and E-T8d in WebKit.
- **Shared files with WEB-11a.** `plans/outstanding-reads.ts` and `ui/outstanding.tsx` also carry WEB-11a's `readOutstandingCreates`; the
  integration of the two branches is an add/add merge (recorded in WEB-11a's `docs/people.md`).

- **Client "today" vs server "today".** A create's first occurrence is projected from the device's day in the task's zone; after a long offline
  period the server may make another slot. The next sync replaces the projection; a record queued against the projected id meets a real
  `404`/`409` and shows in the queue. It is never silently retargeted.
- **Device time-zone data** can differ from the server's bundled data; server values win wherever they exist.
- **Two `/daily` reads per view**, not profiled here (WEB-09c owns measurements).
- **A `403` re-check of the session** closes and reopens the display: a screen remounts, by design of the session.

## Not claimed

No PostgreSQL, HTTPS deployment, physical device, installed PWA or manual screen-reader evidence (WEB-09d, collected by WEB-15). The
production leader is exercised by one fixture case (E-T2b: a save in the tree is sent by the production dispatcher); the composed
production-leader journey against a backend is WEB-09d's. Browser viewport and colour-scheme emulation is not device evidence. Fixture evidence (stubbed `/daily`,
`/task-presets`, the fixture leader) is never integration evidence. Backend gates BE-Q1 and BE-CH1 have no completion record.

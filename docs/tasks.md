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
    (Revision 3: the "never held" exception is withdrawn, decision 29; the clock's generation and symmetric coverage are added, decision 28.)
20. **Coherent composition (C2; superseded by decisions 26 and 27 in revision 3).** Today composes from the occurrence, task and progress rows of ONE related read (the durable position is read
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

Revision 3 (review of 14 October 2026, findings R2, R8 and R9, and its recurring-finding design assessment C1–C3) adds:

26. **A durable local composition generation (R9, C3).** `sync_state.composition_seq` (`data/model/composition.ts`) is advanced by the STORE (the
    Dexie adapter and the test double, one shared rule) in the same transaction as every write to `cache`, `pending_effects`, `drafts` or
    `draft_commands`, after the plan's writes, so every writer is covered by construction and a refused or aborted transaction advances
    nothing. Schema version 3 (no store change) is the barrier against an older build that would write without advancing it: opening it closes
    an older build's connections (`upgrade_pending`), and an older build cannot open it. The certificate a screen reads (`readLocalBasis`: the
    incarnation, the generation, the cache status and recovery generation, the content revision) before and after its reads proves that nothing
    it read was written in between, in this tab or another (`readCoherently`, three attempts). It supersedes decision 20's single related read
    bracketed by the content revision, which a queue write, a receipt or reconciliation after recovery did not move.
27. **Honest publication (R9).** Today reads everything the day needs as one certified snapshot: every page of the outstanding task work, the
    walk that discovers the candidates, then their related rows (the occurrence, its task and my progress). Only a complete snapshot is shown. A
    read that failed (`failed`) or kept changing on every attempt (`unstable`) is never an empty day: the last complete snapshot of the same
    identity, day and zone stays, marked stale (`data-today-stale`), with a notice and "Try again"; without one the notice shows alone. Rows
    are composed from the retained snapshot with the CURRENT time, so a stale day still finalises at its close. A new snapshot is read when the
    generation moves (any local commit, an empty sync page included: only a local re-read); the server is asked again only for committed
    content, the clock or a retry (decision 25 stands). The detail composes its day's row from a certified read of its own inputs (`rowError`
    says why when it cannot); the task list says when its read failed instead of "No tasks here yet."; the task form saves no edit while the
    queue (its write target) is unread.
28. **The clock's own generation (R2, C1).** `useBoundaryClock` moves a synchronous generation when the device clock goes BACKWARDS. A `/daily`
    answer records the generation it was asked in; its derived fields apply only while it is still the clock's (a clock that went back and
    returned to the same time is caught), and an answer asked before a backward step is not taken as the joint result's "as of". Coverage is
    symmetric: a boundary between the dispatch and now, in either direction, makes the server's fields stale. Structure is chosen separately.
29. **No structure from an answer that is not current (R2, C1).** A daily item supplies the structure of a row the cache lacks only while its
    answer is current against the snapshot (no content committed since its dispatch). The revision 2 exception for a row "this view never
    held" is gone: not having seen a row is no evidence that it was never removed. The row is withheld until a current answer (asked once).
30. **One effective structure for composition and the clock (R8, C2).** `effectiveOccurrence` (view.ts) resolves the committed or daily row and
    then the outstanding drafts' projection and display patches; `composeRow` and Today's clock windows both use it, for every candidate: walked,
    listed, projected by an outstanding create, or named by an outstanding draft (a queued correction can bring an occurrence into the day). A day
    created offline is therefore woken at its opening and closing with no other event.

Tests: `tests/data/composition-generation.test.ts` (the writers), `tests/features/tasks/local-coherence.test.tsx` (the composed screens with real
commits and failures placed between their reads), native E-T9f, E-T14 (another tab commits between Today's reads) and E-CG1/E-CG2; unit
MU-2104, MU-2106…MU-2118 and real-engine MU-2119…MU-2122. Considered and rejected: one read transaction for the whole walk (it would hold every
writer for the length of a full walk, and the 10,000-occurrence walk already exceeds the diagnostic trigger, F-1), and a generation advanced by
the plan builders (it cost initial-bundle bytes the fixture budget does not have, and advanced on decisions that wrote nothing).

Revision 4 (review of 14 October 2026, findings R9, R10, R11 and R12, and its recurring-finding design assessment C1–C4) adds:

31. **The task detail is one certified read (R9, C1).** The task, its details, the displayed day's selection (the address's day, the visit's
    default, today's slot or the walk over every saved day), the queue and the outstanding work naming them, the day and my progress rows, the
    picker's first page and every progress stream of the day are read as ONE composition (`readCoherently`). "This task isn't on this device",
    "no day" and "This day isn't saved on this device…" are said only by a complete read; a read that failed or kept changing with nothing
    complete is an error with "Try again" (`data-task-detail="error"`), never absence; with a complete read it stays, marked stale, with "Try
    again" (`data-detail-row-stale`), which reads everything again. The edit page uses the same read (an error with "Try again"; a stale
    refresh keeps the open form and what was typed) and reads its write target (the queue) before the form shows. A later page of the day
    picker is a read of its own, whose failure says so with "Try again" (`data-day-picker-error`) and never "no more days". The default day is
    chosen once for the visit and kept while it is still this task's day.
32. **The open full history is a bounded, owned window (R10, R12, C3).** At most three pages (`MAX_PAGES`, Q9) are retained; the page-start
    cursors visited are kept (numbers), so an earlier page is read again from its own start ("Earlier entries") and a later one by "Load
    more", each letting go of the page at the other end. Every request belongs to the history's current authority (decision 36): an answer of
    an ended one never replaces anything. The window
    follows its stream's committed version (`RowModel.progressVersion`): a new version reads the window's pages again, once per version and
    online; offline it waits for the connection. A refresh replaces each page in place as its answer arrives (revision 5: never a second window
    behind the first). A failed refresh keeps the pages, marked stale, with "Try again"; a refusal of any read drops them (decision 36);
    another identity starts over. "Refresh" and "Back to recent entries" are always offered while it is open. Saved entries newer than the
    pages (the stream's recent tail) show until the journal is read again, never fixable.
33. **Corrections across pages (R10, C3).** A window that reaches the journal's end knows every correction of its entries (a correction is
    appended after what it corrects). Outside it, "Fix this entry" first walks the rest of the journal for a correction of THAT entry, keeping
    only the answer: corrected since, the entry is marked "Corrected" and no fix opens; otherwise the fix opens. There is no automatic walk.
    An entry known only from the full history is fixable only while the window is current: online, not failed, read at the stream's committed
    version (revision 5; offline only the recent entries can be fixed, as before).
34. **The open fix is the history's, not its page's (C3, J5).** The entry, the session, the typed value and its edit count live in the history:
    letting a page go or refreshing it never erases a fix (shown apart while its entry's page is not shown). A fix whose entry has a saved
    correction since cannot be saved, and says why. Revision 2's session and edit-count rules are kept. A fix known only from the full history
    has that history's authority (revision 5): "Back to recent entries" or a refusal closes it (nothing is saved); what was typed is kept in
    memory for the same identity and entry and restored when that entry's fix is opened again under a new authority — never persisted or sent.
35. **One enrolment attempt per change, owned before it is sent (R11, C4).** The attempt (`{key, body, command, phase}`) is taken
    synchronously in page memory per identity and task (`startEnrolment`) before the request: while it is pending, Join/Leave and the consent
    are disabled with "Sending your change…" and a second activation sends nothing; it outlives a same-identity remount and is dropped with the
    identity. An uncertain answer keeps the exact command and key, and "Try again" resends them unchanged; a definite answer ends it and the
    next change is a new attempt. Every answer is followed by a read of the enrolment; a read asked before a change was sent is not shown, and
    one answered while a change is pending never replaces what is shown. A reload starts with no attempt and resends nothing (decided:
    RECOVERY-NAVIGATION-ENROLMENT-20261014 D4, below).

36. **One owner of the journal's state; only the latest Fix opens an editor; a refusal of any read ends the authority (R13, R14; revision 5,
    design assessment C1–C3).** The history's continuations read its CURRENT journal, never one captured before an await, and check what they
    were started under: the authority (begun by opening the full history; ended by "Back to recent entries" and by a refusal), the correction
    selection (taken synchronously by every "Fix this entry" and by Cancel), for a check the stream's committed version, and the mounted
    lifetime. So an older check of the rest of the journal never opens or retargets an editor over a newer one or its typed value, and stops at
    its next answer once anything it depends on moved. A valid refusal (403/404/410) of ANY read of the current authority — the first page,
    Refresh, Load more, Earlier entries or a check, current or superseded — drops the full history, its cursors and check facts at once, and no
    earlier success restores them; "Full history" is offered again, so only a new explicit read begins another authority. Uncertain, offline
    and not-sent answers certify nothing (stale pages kept, or "Couldn't check…"); a closed request is abandoned; a page whose cursor does not
    move is a failed read. At most two journal requests are in flight per view (a further one waits holding numbers only, and is never sent if
    no longer wanted), so the retained payload is at most the three window pages plus two answers in flight. The number of requests in flight is
    shown as `data-journal-requests` (for tests: 0 once every answer has been taken in).
37. **What was typed belongs to its draft; one save decision for the Save shown and the save admitted (R16, R17; revision 6, design
    assessment items 1–7).** A fix's input is held by a DRAFT (raw value, a revision counting edits across every editor of it, whether it is
    unsaved, and the revision a pending save submitted), not by the editor showing it. Closing the full history ("Back to recent entries" or a
    refusal) parks a draft that holds unsaved input — typed or restored — and opening that entry's fix again moves it back, however many times,
    until Cancel discards it, a save of exactly that revision acknowledges it, or the view ends (route change, protected-tree remount, reload,
    another identity). Memory only: never persisted, never sent, never an authority. A save's answer settles only the draft and revision it
    submitted wherever the draft is now (the submitting editor closes; a newer editor of the same draft stays, marked saved; a parked draft is
    retired; anything edited since is kept); one save at a time per draft. `saveBlock` decides for the Save shown and, synchronously, when Save
    is pressed: not writable; a COMMITTED correction of the entry (for good); a recent entry is saved on its own authority (offline and while
    the history is read again); otherwise the full history must be current (online, read without failure at the stream's committed version,
    the detail's local read current — `useTaskDetail().current`) and there must be evidence about THIS entry: a check at the current version,
    or a window that reaches the end and holds it (kept as the entry's check when Fix is chosen there). Without it Save says why — "This fix
    can be saved once you're online again.", "This fix can be saved once the full history is up to date.", "Check whether this entry was
    corrected since, then save the fix." with "Check again" (a check from the entry's own place in the journal, keeping the open fix) — and
    the input is kept. A pending correction of the entry by me does not block a newer value (R3). A check answered after the connection went
    opens nothing. The history shows `data-stream-version` and `data-journal-version` for native barriers.
38. **Every enrolment change sends the complete enrolment, its audience explicit (R22; revision 10, design assessment C1–C5; task
    `states.md` R2/F1).** `enrol` replaces the whole enrolment, and an omitted `initial_policy` is read by the server as "resolve my CURRENT
    progress defaults", which would silently replace a private or custom audience (and the progress generated from then on would follow it).
    So `EnrolCommand.initial_policy` is required and every command is built by `enrolCommand` from the enrolment as read with only the
    person's change applied: Leave and the consent keep the audience; "Change…" edits the audience (WEB-12a's `AudienceChooser`, Save and
    Cancel; Cancel sends nothing) and keeps active and the consent. Aggregate consent and who can read progress are independent: neither
    sets the other, and Private is an explicit empty policy. Joining asks the consent explicitly (no choice implied; Join waits for it) and
    shows the audience first: rejoining starts from the audience last used, the first Join (version 0, whose read policy is only a
    placeholder) from the CURRENT default for progress, from a defaults snapshot asked for when the form opened (`progressDefaultPolicy`,
    resolved as the server resolves it); a default that cannot be read is said so with "Try again", never shown as Private, and Join cannot
    send. A choice belongs to the enrolment version it was made on and is never rebased; a stale version is refused by `expected_version`
    (revision 11, decision 39: a choice whose edits were not all sent is kept, unsaved, rather than dropped). The attempt (decision 35) captures a frozen copy of the
    canonical body, nested policy included, and that body is what is sent, now and on "Try again", whatever changed since (the read, the
    defaults, the object the request was built from). The audience applies to days from now on; "Who sees my progress" still edits a day's
    own progress. The chooser is imported from `sharing/AudienceChooser` (not the barrel, whose editors are in the shell's first load).
39. **An enrolment change owns the settings until the read after its answer (R23; revision 11, design assessment C1–C3, DA-1).** A save's
    answer, and the read that follows it, may end only the edits that were sent. So from the moment a change is admitted (`startEnrolment`)
    until a read asked AFTER its answer is accepted, nothing in "Your settings" is edited, chosen or sent: the change's cycle (`sending`, then
    `reading`) is page memory beside the attempt, so a same-identity remount is still bound by it and a reload or another identity starts
    without it. Every control says why ("Sending your change…", then "Checking your settings…"), an already open directory lookup included:
    its Choose buttons are disabled with the reason (`DirectoryLookup`'s optional `blocked`; the resource and defaults editors pass none), and
    every edit is also refused when it HAPPENS (`admitted()`), since a control rendered before the change was sent can still be pressed in
    the same turn. A read is numbered and judged by the change it was asked under (`askEnrolment`/`answerEnrolment`): one asked before the
    answer is never the current state (shown only when nothing is, disabled) and never ends the cycle; a failed read leaves it open, with its
    "Try again" (a read, never a send). The draft lives in the settings (the enrolment it began on, an edit count and the count last sent; the
    detail's identity- and task-scoped read remounts it with the settings), not in a child keyed by version, so a hidden form (offline, a failed read) keeps it. When the current state shows
    another version, a draft whose edits were all sent ends (saved, or refused); one with an edit not yet sent is KEPT, unsaved, as "Not
    saved: your settings changed after you started this change, so it can't be sent. Discard it to change the settings shown." with
    "Discard this change", and the rest waits ("Discard the unsaved change first"): never dropped, never moved onto the new version. Leave
    and the consent wait while an audience edit is unsaved ("Save or cancel the sharing change first"). A retry that finds the page offline
    is not a definite answer (DA-1): only `conflict`, `operation_conflict`, `forbidden`, `not_found` and `invalid` end an attempt, so an
    uncertain change keeps its body and key whatever a later retry finds. No cross-tab lock, rebase or persistence across a reload is added.

    Revision 12 (review 12: R23 `task-save-acknowledgement-consumes-newer-edits`, R25 `task-enrolment-refusal-discards-input`; design
    assessment I3/I4, C1-C7): the draft is no longer the settings' React state but the PAGE's (`EnrolmentDraft` in `memory.ts`, per identity
    and task: a never-reused editor `session`, its `revision` (edits accepted), the enrolment it was made to, a frozen copy of the policy and
    the consent), so an ordinary same-identity remount of the protected tree shows it again, after the remounted settings' own authorised
    read. Being sent is not being saved: Save/Join captures the draft's session and revision with the change (`EnrolmentTicket`, kept on the
    attempt; a Try again keeps the ticket of what it resends), only a SUCCESS records it as acknowledged, and only the current read that
    follows ends that exact draft revision (`answerEnrolment`). A refused (`conflict`, `operation_conflict`, `invalid`, ...) or uncertain
    change keeps the submitted values, unsaved, beside the settings read: editable on the same version (Save again), kept with "Discard this
    change" on another; never resent, rebased or merged, and Leave and the consent wait for it. A version that moved, or a server state that
    looks equal, is not an acknowledgement. Every edit, opening and Cancel/Discard is admitted by the owner when it happens (not while a
    change is sent or confirmed); Discard ends only its own session and never forgets an uncertain change. A refused enrolment read
    (`403`/`404`) removes the draft; another identity never sees it (page memory is per identity); a reload starts without it and resends
    nothing. A first Join already begun keeps its own audience and consent whatever a later defaults read says. The page holds at most 2,000
    changes and drafts: a NEW one beyond that is refused with "Too many unsaved changes on this page: save or discard one first", and
    nothing held is evicted to make room (only cycles with nothing in progress are reclaimed).

    Revision 13 (review 13: R26 `task-enrolment-first-choice-focus`; design assessment C1/C2, I7): the first choice of a first Join (consent
    or audience) begins the draft without replacing its form. `FirstJoin` renders the same join form in the same place before and after
    (from the draft once begun, from the defaults seed before), so the control chosen stays in the page and keeps keyboard focus. The
    defaults snapshot is read only while nothing is begun (`SeedRead`), so a begun first Join neither waits for nor asks for one, as before.

Tests: `tests/features/tasks/detail-read-coherence.test.tsx` (D1–D4, D9, the visit's default), `journal-window.test.tsx` (J1–J5),
`enrolment-attempt.test.tsx` (E1–E4), local-coherence Q17's form case (adapted, labelled) and its open-form case; native E-T15 (the open journal
follows a committed correction), E-T16 (an enrolment change pressed again while pending) and E-T17 (another tab commits between the detail's
reads); unit MU-2123…MU-2148 and real-engine MU-2149…MU-2151; MU-2034/2035/2037/2045/2046/2083/2118 re-expressed (same intent). Revision 5:
`journal-ownership.test.tsx` (Q1–Q9, Q13–Q15), native E-T18 (an older check never replaces a newer editor) and E-T19 (a refused check drops the
full history); unit MU-2152…MU-2155, MU-2157…MU-2168 and real-engine MU-2169/MU-2170; MU-2133/2135/2136/2139/2140 re-expressed (same intent). Revision 6:
`journal-drafts.test.tsx` (Q1–Q3, Q15), `journal-save-authority.test.tsx` (Q4–Q6, Q9–Q11), native E-T20 (another tab commits while a check's
answer is held), E-T21 (another tab commits while the fix is open and its re-read is held), E-T22 (the other tab's hint late and twice),
E-T23 (a 404, a remounting 403 and a reload end the transient state; the queued correction stays), E-T24/E-T25 (review 6's witnesses);
unit MU-2171…MU-2190 and real-engine MU-2191…MU-2194; MU-2045/2046/2083/2138/2153 re-expressed (same intent).
Revision 10 (R22): `enrolment-policy.test.tsx` (Q1–Q5, Q8, X3), `enrolment-attempt.test.tsx` adapted (labelled: Join first chooses the
consent), native E-T16 adapted, E-T27 (the wire body keeps a shared audience and exclusion) and E-T28 (two tabs: the stale change is refused and the next one keeps the other tab's audience), released-backend I-T23 (a consent change in
the UI keeps a private audience, so another reader of the task cannot read progress generated afterwards; with an explicitly shared control);
unit MU-2213…MU-2222; MU-2143 re-anchored (same mechanism).
Revision 11 (R23, R24, DA-1): `enrolment-ownership.test.tsx` (S1–S9, S13, X4: all three callers × grant/exclusion while sent and while
confirmed, every writer frozen, same-turn choice refused, Leave/consent beside an unsaved edit, early reads, remounts, offline retry, kept
draft, failed follow-up reads, another identity), `tests/static/mutation-inventory.test.ts` (the catalogue's expected count and the
membership check, R24), native E-T29 (an open lookup frozen while sent and confirmed, pointer and keyboard), E-T30 (two tabs, the other
winner order) and E-T31 (a lost answer replayed after another tab's change; a reload sends nothing); unit MU-2223…MU-2236 (MU-2232 retired: its guard was unreachable and removed); MU-2142,
MU-2143, MU-2146…MU-2148 and MU-2220…MU-2222 re-anchored and real-engine MU-2150 re-expressed (same intent).
Revision 13 (R26): `enrolment-focus.test.tsx` (F1–F6: the first consent Yes/No, Private from a shared and an already-private default, a
grant's permission and a consent choice with the directory lookup open, each keeping the same connected control focussed with nothing sent;
rejoining, enrolled and rerender controls; no defaults snapshot asked for once begun), native E-T34 (real Tab, Option+Tab in WebKit, and Space
in three engines, with rejoin controls); unit MU-2251…MU-2253 and real-engine MU-2254; MU-2243 re-anchored (same intent).

**Decided: enrolment after a full reload or crash (RECOVERY-NAVIGATION-ENROLMENT-20261014 D4, Kieran, 14 October 2026).** A15 does not
require a persistent same-key attempt across a full reload or crash. On reopening, the authorised enrolment is read again; the old
Join/Leave/consent command is never resent, never said to have failed, and a newly keyed change is never labelled a retry of it. A failed or
unavailable read offers no change and resends nothing ("Try again" reads again); once the read succeeds the person may make a fresh, explicit
change under the normal identity and `expected_version` checks. Within the page's lifetime, including same-identity remounts of the protected
tree, the exact body and key are kept for an uncertain retry (decision 35). Covered by `enrolment-attempt.test.tsx` E4 and E4b.

**HF-1 setup adaptation (RECOVERY-NAVIGATION-ENROLMENT-20261014 D3).** `tests/e2e/production.auth-flows.spec.ts` uses WEB-08d's bounded
Settings-navigation helper (`shownAs`: a click only while no account card is drawn, at most three, within the original 20 s deadline,
annotated `settings-clicks`) and its "R5 / HF-1" cases, byte-identical to WEB-08d `e88085b` (its capacity-message wording, a WEB-08d product
change, is not adopted). This is labelled test setup: the single-click regression is WEB-08c's to correct, WEB-09d verifies the original
single click before beta and WEB-15 enforces that gate; the adaptation fixes nothing.

**R15 (revision 5): the forced order is established, not assumed.** Diagnosed with read-only probes from tab B (`navigator.locks.query()` and a
read-only `atlas-auth` transaction): in the WebKit executions that failed the setup, the context-wide hold of "the first `GET /sessions`"
had caught tab B's OWN device read, so A's read was answered, A retired its lease cleanly and B rightly verified nothing. The cases now hold A's
own read (a route on page A) and pass three barriers within the original 10 s bounds before the real click: A's held read has a REQUEST lease
whose lock A holds and B waits for (seen in two consecutive looks); after A's destruction that lease's record remains while its lock is
released (orphaned); B's check — held and counted only from then on, past B's own boot checks — closes B behind `1e.interrupted_online`. A
clean-retirement control (A's held read answered while A stays open: B watched the lease, finds it retired, never closes) and two helper
qualification cases (a card naming another account fails after one click; clicks that never take effect stop at three) are added. The helper,
its three-click bound, its identity assertion, the 20 s deadline and zero retries are unchanged.

38. **The current read of a progress-level kind walks the whole collection (R19; revision 7, design assessment C1–C4).** `GET /progress?parent_id=`
    is paged by the released endpoint (ids in order, 200 a page, `next_after` the last id of a FULL page, null otherwise), so my stream can be on
    any page. `readProgressCurrent` (`record`, `exclude`) asks page after page, following each page's own cursor, stops at my stream, and says
    `inaccessible` only when a valid page ends the collection without it. A page that is not one of this collection (`parseProgressPage`: a
    missing or extra member, ids out of order or not after the cursor, a full page without a cursor or a short page with one, another kind or
    occurrence) is `indeterminate`: never absence, never another request. A later page's refusal or error is that page's answer. Only the page in
    hand is kept; there is no page cap; the data layer seals the whole walk, and a scope that ended sends nothing more. The unused
    `TasksApi.listProgress`, which dropped the cursor, is removed.
39. **Kieran's decisions WEB10A-ANNOUNCEMENT-NAVIGATION-R43-20261015 (revision 7).** D1: dismissing a notice withdraws its own announcement
    (the shared announcer's `announce` returns an `Announcement` whose `retract` cancels its pending frame and clears its text only while it
    still owns the region, so a later message, even with the same words, is kept; speech already delivered cannot be undone). D2: the public
    production spec leaves a page before going online (a labelled readiness correction) and keeps a deliberate case in which the online
    re-check of the sign-in record — a read — is interrupted by navigation without any write. D3: the historical R43 double closure is an
    accepted diagnostic risk owned by WEB-17 (its exact-one assertion unchanged); HF-1's own pre-beta verification is separate and unchanged.
40. **A notice is announced when it arrives, never because the list moved (R20; revision 8).** `SessionNotices` records every notice it has
    shown in this presentation by id (with the announcement it made, if any) and reconciles the whole lists on each change: a removed notice
    withdraws its own announcement (D1) and announces nothing; only an id not seen before is announced (the first new session notice, the latest
    new sign-in fact). Dismissing one of two notices therefore never replays the other over a later message or cancels that message's frame. A
    new session notice arriving while another is shown is now announced (it was not before). The record ends with the presentation; nothing is
    persisted or shared between tabs.
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
| Revision 3: "Couldn't read this device's tasks" with "Atlas couldn't read the tasks saved on this device." or "The tasks saved on this device kept changing while they were read.", "Showing what was last read on this device." and "Try again" (Today, as a section; the detail and the list as a line; the task form as the disabled Save's reason) | `/today` with a failing local read (jsdom `local-coherence.test.tsx`, Q9/Q10/Q17) |
| Revision 4: the detail and the edit page with a failed local read: "Atlas couldn't read the tasks saved on this device." (or "kept changing") with "Try again"; stale: the same with "Showing what was last read on this device."; the picker's "Couldn't read this task's saved days." with "Try again" | `/tasks/<id>` with a failing local read (jsdom `detail-read-coherence.test.tsx`) |
| Revision 4: the full history's "Earlier entries", "Load more", "Refresh", "Back to recent entries", "Couldn't refresh the full history. Showing what was last loaded.", "Checking whether this entry was corrected", "Couldn't check whether this entry was corrected since.", "This entry has been corrected since. Fix its correction instead."; a fix whose page is not shown appears above the list as "Fix this entry: {value}" | `/tasks/<id>` → Full history (jsdom `journal-window.test.tsx`, native E-T15) |
| Revision 5: after "This history isn't available to you." the "Full history" button is offered again; "Back to recent entries" (or a refusal) closes a fix of an entry known only from the full history, and opening that entry's fix again restores what was typed; offline, or while the full history is being read again for a newer version, such an entry offers no "Fix this entry" | `/tasks/<id>` → Full history (jsdom `journal-ownership.test.tsx`, native E-T18/E-T19) |
| Revision 6: an open fix whose Save waits says why: "This fix can be saved once you're online again.", "This fix can be saved once the full history is up to date.", "Check whether this entry was corrected since, then save the fix." with "Check again" (and "Checking whether this entry was corrected" while it runs); what was typed survives every "Back to recent entries" or refusal until Cancel or a save | `/tasks/<id>` → Full history → Fix this entry (jsdom `journal-save-authority.test.tsx`, `journal-drafts.test.tsx`, native E-T21/E-T24/E-T25) |
| Revision 4: enrolment "Sending your change…" (the disabled reason while a change is pending) and "Try again" beside "Couldn't confirm the change. Try again." | `/tasks/<id>` of a shared task (jsdom `enrolment-attempt.test.tsx`, native E-T16) |
| Revision 10: joining asks "Count your contribution in the shared total?" ("Yes, include my contribution" / "No, leave my contribution out of the shared total"; Join waits with "Choose whether to count your contribution first"), then "Who sees your progress from now on" with "This starts from your default sharing." (first Join) or "This starts from the sharing you had before." (rejoining) and "This applies to days from now on. A day already started keeps its own sharing (Who sees my progress)."; the default loading/unreadable lines "Loading your default sharing" / "Your default sharing couldn't be loaded." with "Try again" (Join's reason: "Who would see your progress isn't known yet"); enrolled: "Who sees your progress from now on: only you" (or "you and 1 household and 2 people, 1 excluded"), "Change…", the chooser's "Only me (private)", "Cancel" and "Save sharing" ("Nothing has changed" while unchanged) | `/tasks/<id>` of a shared task (jsdom `enrolment-policy.test.tsx`, native E-T16/E-T27/E-T28) |
| Revision 11: while a change is answered and its read is awaited every control says "Checking your settings…" (after "Sending your change…"), an open lookup's Choose included; Leave and the consent beside an unsaved audience edit: "Save or cancel the sharing change first"; a kept draft: "Not saved: your settings changed after you started this change, so it can't be sent. Discard it to change the settings shown." with "Discard this change", and elsewhere "Discard the unsaved change first" | `/tasks/<id>` of a shared task (jsdom `enrolment-ownership.test.tsx`, native E-T29–E-T31) |
| Revision 12: after a refused change the submitted audience (and a join's consent) stays: on another version as the kept draft above beside "This change wasn't accepted. The latest settings are shown.", on the same version in the editor; a page holding 2,000 unsaved changes refuses a new one with "Too many unsaved changes on this page: save or discard one first" | `/tasks/<id>` of a shared task (jsdom `enrolment-retention.test.tsx`, native E-T30/E-T32/E-T33) |
| Revision 1: "Who sees my progress" offers any account, and the server refuses one who cannot see the day with its generic "Check the request fields and values." (it reports `IdentityGrantRequired` as `invalid_value`); a clearer message is WEB-12a's editor and the contract's | `/tasks/<id>` of a personal task → Who sees my progress (I-T20 notes) |

## Escalation E-1 (material, not blocking WEB-10a)

No fixed-recurrence task gets a second occurrence until WEB-10c's `materialise` exists: the server makes only the start-date slot at
`create_task`. At the connected-app checkpoint recurring tasks would show only on their first day, with the `pending_tasks` notice. The options
are the operator's (schedule WEB-10c before the checkpoint, or approve a minimal catch-up here by a scope change). Nothing here adds
`materialise`.

## Limits

- **The journal endpoint has no snapshot or reverse cursor (revision 4).** Pages are read by `sequence` from remembered starts, so an earlier page
  is read again when the person goes back, and a fix outside a window that reaches the end walks the rest of the journal (one request per
  later page, keeping only the answer). Neither is a remote snapshot: a correction committed after the walk is seen at the next committed
  version (the window is read again). A reverse or snapshot endpoint would be a backend scope decision; none is assumed.
- **A refusal reaches only the tab that met it (revision 5).** Each tab owns its own open history; a refusal in one tab is not broadcast. Another
  tab learns of it at its own next read (a newer committed version reads its window again) — no cross-tab access cache is introduced.
- **Transient journal payload (revision 5).** Retained: at most the three window pages; in flight: at most two answers (pages or checks); a
  waiting request holds numbers only. Not measured here (WEB-09c owns measurements).
- **The detail reads more per local commit (revision 4).** Its one certified read includes the picker's first page and every progress stream
  of the day, read again when the composition generation moves (as Today's is); the walk over every saved day runs only until the visit's
  default day is chosen. Not profiled here (WEB-09c owns measurements; F-1's cost of the walk applies).

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

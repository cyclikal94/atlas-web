# Lists (WEB-10b)

*Written by WEB-10b, 25 October 2026, against the pinned contract `v0.29.0-rc.1` (backend commit `4396c99`). Built on accepted WEB-10a
(`b9fd602`), WEB-12a (sharing) and WEB-09a (the data layer). Fixture-stage work: `integration_passed` is false. Nothing here is an acceptance
claim; BE-Q1 and BE-CH1 have no completion record, and WEB-09d owns integrated, device and assistive-technology acceptance.*

## What this slice does

- **Routes.** `/tasks/lists` (the Lists pane: active lists, an "Archived" filter, an empty state) and `/tasks/lists/<id>` (a list). They are
  a root-level branch whose path starts `tasks/lists`, so the Tasks destination stays highlighted and titled "Tasks" (D-10b-1); the static
  segment outranks `/tasks/$taskId`. The pane's h1 "Lists" is the route's, outside the cache gate and the lazy chunk; a list's page has
  its own h1 (its name), and the gate shows the pane's while it hides the page. From 1280 px the pane sits beside the list (300 px); below,
  one column with "‹ Lists" (D-10b-2). The Tasks pane links to the Lists.
- **Commands** (queued through the outbox to `/task-commands`):
  - `create_list` captures the person's `list` sharing defaults at the act; defaults this device never fetched hold the create for review
    (D-10b-3). No `initial_policy` is sent: the server applies the resolved defaults, checked against the captured revision.
  - `edit_list` renames a cached list with its `policy_version` (Q1). A list whose create is still `queued` is renamed by editing that
    create in place, conditionally on it being the one this dialog first saw (D-10b-8).
  - `list_item` adds or removes a task; `archive` archives or restores a list.
- **The 100-reference cap**, the access boundary (the load-bearing caption and the withheld row) and sharing through WEB-12a's
  `ResourcePolicyEditor`.
- **Unsaved input** of the create and rename dialogs and the task picker is the screen visit's (WEB-10a's `kept-input.ts` and `visit.ts`).

## Public interface (from `src/features/tasks/index.ts`)

| Export | What it is |
| --- | --- |
| `LIST_KINDS`, `LIST_CAPACITY` (100), `LIST_NAME_MAX` (300) | The list command kinds and the server's bounds. |
| `listNameProblem(name)` | The server's name rule exactly (`lib.rs` 159-165): blank is Unicode `White_Space` only (U+0085 is, U+FEFF is not: `String.prototype.trim` differs), the length is in code points. `"blank" \| "too_long" \| null`. |
| `parseListValue(value)` | A list projection's value `{"task_ids": [...]}`: exact key, UUIDs, unique, at most 100. `null` otherwise. |
| `createList`, `renameQueuedCreate`, `editList`, `listItem` | The request builders. Bodies carry exactly the contract's keys (a unit test validates each against the vendored `TaskCommandInput`). |
| `archiveResource({ id, archived })` | `archive` of any archivable resource (also what `archive({ taskId })` delegates to). |
| `projectCreateList(draft, id)` | The projection of an outstanding `create_list`, for its own id only. |
| `composeList`, `listRows`, `listItemOf`, `atCapacity`, `roomFor` | The single composition rule (below). |
| Q4 readiness: `newListFormContext`, `listFormContext`, `listPickerContext`, `listFormRecoveryValues`, `restoreListForm`, `pickerRecoveryValues`, `restorePicker` | Recoverable list forms, raw; restoring never submits (WEB-14a wires the capture). |
| `listPath(id?)` | The route helper. |

### The composition (D-10b-4, `model/list-view.ts`)

A list as every screen shows it: the cached row (with its effects' overlays) or, when the cache does not hold it, the projection of this
device's outstanding `create_list`; then, in queue order (`created_seq`), every outstanding draft naming the list:

- `edit_list` and `archive` through their display patches (`label`, `archived`);
- `list_item` applied to the membership as a set operation when it is `queued`, `in_flight` or `acknowledged` while its effect stands
  (re-applying a change a committed page already carries changes nothing). A `blocked` one (`503 slice_capacity`) is not applied: it is
  listed as refused. Conflicted and rejected drafts are attention only, never applied.

**`list_item` has no display patch, and a consumer must never write one**: a patch built from the array a screen saw drops another tab's
queued add while it is shown. The pane's counts, the detail's rows, the capacity pre-check and the picker's exclusions all use this rule.

### Obligations of a consumer

- Build list commands with these builders, or follow the same targets: every list command names only the LIST as its target
  (`requiresEdit`, version-checked; `create_list` seeded at 1). A `list_item` for a task this device has not sent yet names that task's
  `create_task` in `dependsOnExtra` (D-10b-11); the task is otherwise not a target, so a list change never waits behind an unrelated task.
- The cap is the server's and counts tasks the reader cannot see: the client's at-limit state is a pre-check, never a promise. Handle a
  refusal (`blocked`, `slice_capacity`) as this slice does.
- A reader never receives another person's task through a list: `task_ids` holds only the ids the reader can see (`service.rs`
  `list_value`, the production `VISIBLE` rule). Never imply otherwise in copy.

## Decisions (planning D-10b-1 … D-10b-13, as built)

1. **D-10b-1** Routes under Tasks (above). The routes declare no second lazy screen: the lazy layout draws the list from the matched id, which
   kept the fixture's first load within its ceiling (below).
2. **D-10b-2** Pane width 300 px (the existing Tasks class), not the drawn 220 px; tablets use the generic one-column rule.
3. **D-10b-3** The create dialog is as drawn (Name, "Create list") with the caption "New lists use your sharing defaults for lists. Choose
   people later with Sharing."; no "Only me" choice.
4. **D-10b-4** Membership composed by the slice, never patched (above).
5. **D-10b-5** Rows by title (numeric, base sensitivity), then id; withheld rows last by id. The pane: this device's unsent creates first
   (first page only), then the cached page by name; pages are read by id, 100 at a time, with "More lists".
6. **D-10b-5a / E-10b-1** The drawn row checkbox is not implemented; each readable row links to its task, where recording lives. Flagged for
   Kieran at the next checkpoint: recording from a list would need WEB-10a's per-row occurrence composition for every row.
7. **D-10b-6** The withheld row ("Task you can't open (withheld)") appears for a task id this device holds neither a cached row nor an
   outstanding create for. No link; it keeps Remove (the server decides).
8. **D-10b-7** Archive and Restore have no confirmation; archived lists appear under the pane's "Archived" filter; an archived list's page
   works as an active one's.
9. **D-10b-8** Rename: a queued create is edited in place; a cached list is renamed with `edit_list`; otherwise (the create sent, the list not
   received) "You can rename this list once it has synced." **Running addition:** the in-place edit is conditional on the create still being
   the one the dialog FIRST saw (its digest is kept with the session through a sync visit). Another tab's edit shown since is refused once
   with "This list's unsent change was edited somewhere else. What you typed is kept here: check it, then save again."; the next Save is the
   person's decision on what is there.
10. **D-10b-9** The caption: "Lists don't change who can see a task. People who can see this list see only the tasks they can already open."
11. **D-10b-10** Capacity: "Add task to list" disabled at 100 composed with the drawn reason; the picker allows at most the room left ("This list
    can take {n} more."), and "Add selected" checks the room again against the latest composition ("This list can now take only {n} more.
    Choose fewer tasks.", nothing saved). **Running correction of the refused-capacity copy:** the plan's "Remove a task, then retry it in
    Sync" cannot work on this device: a `blocked` draft is not terminal and holds every later draft that shares its list (the data layer's
    `selectCandidate`), so a removal queued after it waits behind it. The notice now reads "Couldn't add “{title}”: this list is full. It may
    also hold tasks you can't see. Your other changes to this list wait until you retry or discard this one in Sync." with "Open Sync",
    which opens the "Needs a decision" tab where the refused change is.
12. **D-10b-11** A task known only through an outstanding `create_task` is offered ("Not sent yet") and its add depends on that create.
13. **D-10b-12** The picker: this device's cached tasks (not archived, not already members) and its unsent creates, with this device's queued
    renames and archives applied; a case- and accent-insensitive substring search (NFD, combining marks removed, lower case); exactly 100
    cached matches a page ("More tasks" resumes at the next match), each page a certified read. A selection the search hides stays selected
    and counted. Each selected task's add has its own local id, chosen when it is selected; an add whose answer was lost is looked up,
    never sent again (D1, below).
14. **D-10b-13** No online reads on mount: the Lists screens read only this device; the sharing editor keeps its own `403` memo.

## Registrations (`register.ts`)

| Kind | Describe | Current read (WF-QUEUE-02) | Rebuild ("Save as new") | Admission |
| --- | --- | --- | --- | --- |
| `create_list` | New list | — | — | none (its row is its own) |
| `edit_list` | List name change | `readListCurrent` | on the reviewed list's version and `policy_version`; never under `can_edit: false` | the list |
| `list_item` | List change | `readListCurrent` | the same task and direction on the reviewed version; no `dependsOnExtra` | the list |
| `archive` | Archive or restore | `readArchiveCurrent` (task first; a `404` reads the list) | a reviewed `task` or `list` row | the resource |

`readListCurrent` walks `GET /lists?archived=<b>&limit=200[&after=]` (the endpoint filters by `archived`, default `false`, and pages by id
with `next_after` the last id of a FULL page): the collection the draft expects first (for an archive, the state before it), each cursor
followed, until the list is found. A valid page holding a larger id ends that collection. Absent (`inaccessible`) only once both
collections ended without it; a refusal or error of any page is that page's answer; a page that is not one of the collection
(`parseListPage`, strict) is `indeterminate`; an ended scope sends nothing more.

## Copy beyond the drawing, for the connected-app checkpoint (STAGED-ACCEPTANCE-20261011 §5)

Every item is reproducible with the fixture states of `tests/e2e/fixture.lists.spec.ts` (E-LS1 also records screenshots per invocation) and
the jsdom `tests/features/tasks/lists-*.test.tsx`.

| Item | Route and fixture state |
| --- | --- |
| Lists at `/tasks/lists` under Tasks; a "Lists" link on the Tasks pane (no rail or tab item) | `/tasks`, `/tasks/lists` (E-LS1) |
| Pane width 300 px (drawn 220 px); the dashed "+ New list" uses existing classes | `/tasks/lists` (E-LS1) |
| The drawn row checkbox not implemented (E-10b-1) | `/tasks/lists/<id>` (E-LS1) |
| Caption corrected (D-10b-9) | `/tasks/lists/<id>` (E-LS1) |
| The refused-capacity notice, corrected (D-10b-10) | `/tasks/lists/<id>` after a `503 slice_capacity` (E-LS5) |
| Added: "Choose a list to see its tasks.", "No lists here.", "No archived lists.", "No tasks in this list yet.", "This list isn't on this device.", "This list can't be shown on this device.", "This list is archived.", "You can't change this list", "You can rename this list once it has synced.", "Change the name to save it.", "You can share this list once it has synced.", the create caption, "Only tasks you can already see are shown.", "No tasks to add.", "No tasks match your search.", "Choose the tasks to add first.", "{n} selected", "This list can take {n} more.", "This list can now take only {n} more. Choose fewer tasks.", "Added {k} of {n}. The others weren't saved: {reason}", "A change to your lists needs your attention in Sync." / "A change to this list needs your attention in Sync." with "Open Sync", "This list's unsent change was edited somewhere else. …", "This list isn't on this device any more. What you typed is kept here.", "Saved. Your newer changes are still here.", "Your earlier save created “{name}”. What you typed since is still here: saving it creates another list.", "Your earlier save renamed this list “{name}”. What you typed since is still here: save again to use it." (revision 1, R1), "One task you chose had already been added by an earlier save, so it wasn't added again. If it isn't in the list now, choose it again to add it." / "{n} tasks you chose …" (revision 2, R2), the D1 notes and decisions of revision 3 ("This device can't tell whether your earlier save created “{name}”: it may already have. Create list won't send it again.", "… renamed this list “{name}” …", "This device can't tell whether an earlier add to this list was made …" / "{n} earlier adds …", "Your earlier save of “{name}” was changed, refused or discarded since (see Sync), so it wasn't sent again." and their rename/picker forms, "Create as a new list", "Rename as a new change", "Add as new adds" and their explanations), the announcements ("List created. Not sent yet.", "List renamed. Not sent yet.", "Removed “{title}” from {list}. Not sent yet.", "Added {n} tasks to {list}. Not sent yet.", "Archived. Not sent yet.", "Restored. Not sent yet."), "Remove {title}" / "Remove this task", the queue descriptions "New list" / "List name change" / "List change" | E-LS1–E-LS9; `lists-*.test.tsx` |
| Name order within a page; pages by id ("More lists") | `/tasks/lists` with over 100 lists (`lists-screens.test.tsx`) |
| No "Only me" at creation (defaults apply; Sharing afterwards) | `/tasks/lists` → "+ New list" (E-LS2) |
| An archived list's page stays editable | `/tasks/lists/<archived id>` (E-LS6) |

## Budgets

Measured on this candidate (revision 3, author builds; the managed figures are in `.agtx/execute.md`; no ceiling changed): production
initial JS 109,421 B gzip (ceiling 109,795), production CSS 7,343 B (ceiling 7,378; **byte-identical CSS**: the screens use only classes
the baseline already had), fixture initial JS 272,572 B (one-off ceiling 272,600 from WEB-10a revision 25). The route declarations cost 96 B of the fixture's first load after the trim that lets
the lazy layout draw the list; revision 1 (R1-R4) costs 28 B more, chiefly the heading while a child page's lazy screen loads (R4).
Revision 2 is 4 B smaller (managed build of this candidate); its exact draft read has modules of its own
(`ui/draft-read.ts`, `plans/draft-header.ts`) because a first version in the shared `ui/scan.ts` put the fixture 18 B over its ceiling.
Revision 3 (D1) adds only lazy Lists code and one export of the shared outbox model (`isSameSave`): production +1 B, fixture -7 B.
28 B of fixture headroom remain for the next slice; WEB-09c owns the reasoned successor budget.

## Limits

- **An archive of an unreadable task costs a list walk.** `readArchiveCurrent` cannot tell a list from a task that is no longer readable
  until `GET /tasks/{id}` answers `404`, then walks both list collections before saying `inaccessible`.
- **The pane pages by id and sorts within a page.** A name order across pages would need an index the cache does not have (D-10a-2).
- **The picker walks the cached tasks** a window (100) at a time until a page of matches; every keystroke reads again (deferred). Not
  profiled here (WEB-09c owns measurements; WEB-10a's F-1 cost of `pageByKey` applies).
- **A save whose outcome is not known** (a store that failed or threw after the write may have committed, or a service that ended during
  it: `SaveOutcome.uncertain`) stays with the dialog's session as its ATTEMPT: its exact request, ids and the database it was issued to
  (revision 1, R1). It is never sent again (revision 3, D1, below). A definite refusal leaves no attempt. A rename of a list whose create
  is still queued edits that create in place, so it leaves no attempt: if that edit's answer is lost after it was written, the dialog never
  says it saved, keeps what was typed, and its digest (`seen`) still guards a later edit, which is asked to be checked first ("edited
  somewhere else"); the refusal stays visible (design assessment P2).
- **A save's settlement is one transition of its editing session** (revision 2, review 2 R1): what it leaves (an attempt, its finding, or
  new ids) is set in the session together with its note and the end of the save, before any editor is told, and the editor holding the
  session WHEN it settles shows exactly that, whether it is the dialog that took the save, the one mounted again on Back from the sync
  screens while the save was pending, or one opened later. A session has one save pending at a time; a completion that is not that
  save's settles nothing.
- **A picker selection, not the task, names an add** (revision 2, review 2 R2): each selection gets its own local id, so a task deselected
  and chosen again is a new add, after whatever happened to the list meanwhile. An add whose answer was lost is kept APART from the
  selection (revision 3), so deselecting or choosing the task again, the list's membership, the search or a page hiding it never drops
  it. The list's membership is never taken as proof of which add made it, and nothing is added that the person did not choose.
- **D1: an earlier outcome this device cannot establish** (revision 3; Kieran's approval of 25 October 2026,
  `atlas-orchestrator/delivery/handoffs/web10b-d1-recovery-approved-20261025.md`). A held local id is no lifetime guarantee: the outbox
  recognises a repeat only while a draft is stored under it, and an acknowledged draft is removed once its effect is applied, Sync's
  discard or replacement removes one, and a draft can be edited in place elsewhere. So an ordinary Save (or Enter, or Add selected) of a
  session holding an attempt only LOOKS IT UP, read only (`readSaveEvidence` / `readDraftEvidence`: the draft under its id in the
  database it was issued to, compared with the request as sent, `isSameSave`; it cannot insert, so a writer acting just after the look
  cannot turn it into a write):
  - **stored** (that save as sent, in any state but a refusal): settled as the earlier request's success, as before; it says what this
    device recorded, not that the server applied it. A picker add found so is done ("… had already been added by an earlier save …").
  - **changed, refused or discarded** (edited since, `rejected`, a discarded conflict, `superseded`), or **unknown** (nothing under its
    id, a read that failed, another database: wiped and recreated, or another service): NOTHING is written; what was typed, selected and
    searched stays; the dialog says the earlier outcome is unknown (or changed) and may already have happened, and offers a separate,
    explained control: "Create as a new list", "Rename as a new change", "Add as new adds". In the picker one earlier add not settled holds
    every add back, whether its task is selected, deselected, hidden by the search or already a member.
  - **The decision** is the only way to a new change: new ids (a new list id and local id; a new local id for a rename or for each add,
    never the predecessor's), and the defaults, policy version, access and room of NOW (the ordinary admission of a first save). It
    neither cancels nor proves the earlier save, and says so. The picker's decision adds only what is selected now; earlier adds whose task
    is not selected are let go, never made again. Dismissing it (Cancel, Escape, the close icon) sends nothing. A decision whose save is
    refused definitely leaves the earlier attempt as it was; one whose own answer is lost is an attempt of its own, looked up next.
  - **Boundaries recorded, not guessed.** (1) A Sync discard or replacement made in THIS document is not handed to the editor: after one
    that removes the draft, the editor reports the outcome as unknown (its note names a discard in Sync as one possibility) and the
    decision is still required; nothing is sent again, so the known discard stands. (2) The attempt lives in page memory with the rest of
    the session (L16): a reload, a crash or another tab keeps no attempt, no warning and no decision; the durable queue goes on
    independently (WEB-14a owns Q4 app-update recovery). A predecessor-specific decision across a reload or tab would need persistent
    attempt history, which the approval excludes. (3) A race the other way (a draft discarded just after the look found it) settles on
    what the look found: the dialog closes as saved on this device and nothing is written afterwards.
- **A capacity-refused add holds the list's later changes on this device** until it is retried or discarded in Sync (the data layer's queue
  order); the notice says so.
- **Native ordering is by transaction creation** (revision 1, R5; replaces the earlier claim that no real engine can place a commit
  between two stages of one read). IndexedDB starts a transaction only after every overlapping one created before it, and every plan's
  scope includes `sync_state`, so E-LS8 (a) stops the fixture leader at its quota read (`holdQuota`; nothing reaches the account database
  between that read and the commit), holds the queue store with a transaction of the spec's own, opens the detail (its work stage waits),
  and lets the leader create its commit behind that stage: the detail's list stage runs before the commit and its task stages after it.
  E-LS8 (b) creates a hold right behind the leader's commit of a denial, so the screen's re-read waits while Remove is admitted from the
  earlier read; the writing transaction then refuses it. A wrapper of `IDBDatabase.prototype.transaction`, installed before the page opens
  its database, only RECORDS creation. Both have healthy controls and real-engine mutants (N-LS1 MU-2547, N-LS2 MU-2548); the unit proofs
  (`lists-reads.test.tsx` MU-2535, the outbox tests MU-2506/MU-2536) remain.
- **A Lists address names a list only** (revision 1, R3): a cached resource of another kind at that id composes no list ("This list isn't
  on this device"), so no list action can name it; a cached list whose value does not parse is still a list.

## Evidence (fixture unless stated)

- Unit and component (jsdom, production data controller over the IndexedDB double): `lists-model`, `list-view`, `lists-register`,
  `lists-screens`, `lists-dialogs`, `lists-reads`, `lists-routes`, `lists-recovery`, `lists-attempts`, and the shared session's
  `kept-settlement` (`tests/features/tasks/`).
- Native (Chromium, Firefox, WebKit; real IndexedDB, fixture leader, stubbed network): `tests/e2e/fixture.lists.spec.ts` E-LS1–E-LS12 and
  E-LS7b, 40 cases per engine (revision 1: E-LS8 (a)/(b) real-engine ordering with their controls, E-LS10 the detail's heading and
  focus; revision 2: E-LS11, review 2's R1 and R2 schedules with their controls, over a labelled TEST-ONLY fault in which a committed
  draft write's answer is lost: the write is real, Dexie is told it aborted; revision 3: E-LS12, D1 with the lost answer's draft discarded
  by another tab's production discard, create and picker, each with its retained control). Viewports and themes are browser emulation, not devices; no screen-reader pass is claimed.
- Focused real backend (released `v0.29.0-rc.1`, disposable SQLite, delaying proxy, the fixture leader; the `lists` stack):
  `tests/integration/integration.lists.spec.ts` I-LS1–I-LS8. Not integration acceptance.
- Mutants: `scripts/mutation/catalogue-web10b.mjs` (67 unit, 9 real-engine), each with the test written for it.

## Headings (revision 1, R4)

Every state of a list's page has one level-one heading: the list's name once it is read, otherwise the destination's ("Lists", nothing of
the list) while it loads, after a failed first read, when this device does not hold it, and while the lazy screen loads. Loading, failed,
absent and read states draw it as the same element, so the focus an in-app navigation gives it stays when the name arrives (E-LS10).
While loading, the frame carries `data-list-loading`, never `data-list-detail` (which names a read list, or `absent`/`error`): a reader of
the list's id never takes a state for it (a pool run of revision 1 caught exactly that, see `.agtx/execute.md`).

## Not claimed

Integration acceptance (`integration_passed` stays false), PostgreSQL, HTTPS, the production leader journey, real devices, real Safari,
installed PWA, manual screen-reader passes (T22 is WEB-09d's; WEB-15 collects them), copy and visual sign-off (WEB-15), measurements or
budgets beyond the figures above (WEB-09c), exhaustive mutation and stress (WEB-17), recording from a list (E-10b-1), list-filtered Today
views, the Settings "Archived items" ledger and household management (WEB-12b).

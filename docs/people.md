# People: profiles and typed fields (WEB-11a)

The People destination (`/people`): who you have added or can see, each person's typed fields, who controls a profile, renaming and unlinking,
duplicate suggestions, and archiving. Built on the WEB-09a data layer (`src/data`) and WEB-12a's sharing editors (`src/features/sharing`).
Pinned contract: `v0.29.0-rc.1` (API 0.29.0, schema 1006; adopted by `1adadae`, merged here by `7d71ba7` on 15 October 2026). Evidence
recorded earlier against `v0.28.0-rc.1` stays historical and is not re-attributed to 0.29.

## What the pinned contract provides (and does not)

- Projections of `person` and `field` sync like every resource. A projection carries **no linkage, owner or policy summary**. A person
  linked to another account syncs with `can_edit: false`, exactly like an ordinary read-only share.
- **Viewer-safe summaries (API 0.29, BE-PEOPLE-SUMMARY; backend `docs/people.md` "Viewer-safe summaries" at `4396c99`):**
  `GET /people/summaries?scope=&archived=&after=&limit=` (the reader's visible people, `scope` = `all` / `in_home` / `shared_with_me` /
  `not_linked` applied over the WHOLE visible set before pagination, 1–100 per page in ascending id order), `GET /people/{id}/summary` (one
  person and its "Shared with" rail) and `GET /people/{id}/field-audiences` (each visible field's own sharing and who can actually see it).
  Online-only, `private, no-store`, identity-bound display data, never a permission; no owner-only branch, so no `403` from sharing. The
  owner's audience is `complete`; every other reader's is `partial`, always (product decisions of 14 October 2026).
- **Linkage is online only:** `GET /people/{id}` → `{ person, linked_account_id }`. `GET /policies/{id}` is owner-only (`403` otherwise).
- Field values are the seven `FieldValue` kinds: `text`, `quantity`, `date`, `url`, `boolean`, `choices`, `checklist` (bounds in
  `model/values.ts`, transcribed from the server's own validation).
- Queued (offline-capable): `/commands` `create_person`, `create_field` (a text value), `edit` (a content rename, both versions); `/task-commands`
  `put_field` (create or update, typed) and `archive`. Online-only: `/people-commands` (`rename_profile`, `unlink`, and WEB-11b's link and merge
  requests), `/task-access-commands` (a field created with a grant), `/management-commands` (`replace_policy`).
- `GET /people/{id}/duplicates?after&limit` scans at most `limit` visible people per page: a page can be empty and still have a `next_after`.

## Public interface

Import from `src/features/people` only:

```ts
peopleSlots: { headerActions?(personId), duplicateActions?(personId, otherId) }   // WEB-11b fills them ("Ask to link…", "Compare & merge")
usePersonLinkage(personId): { linkage, retry() }       // from GET /people/{id} only; unknown is never "unlinked"
personPath(id), duplicatesPath(id)                     // deep links
parseFieldValue, valueProblem, labelProblem, formatValue, formatDate, type FieldValue, type FieldKind
PeopleBoundary, PeopleEnvProvider, type PeopleEnv      // the people env (over the sharing env); a test or fixture may provide its own
archivedLedgerKinds.register({ id, order, Rows })      // add a kind to Settings → "Archived items"; Rows reports a LedgerReport (or null)
registerPeopleCommands(registry)                       // the queue registrations; called once by the protected tree
type LinkageState, type PersonDetailSlots, type ArchivedLedgerKind, type LedgerReport
```

The screens are one lazy chunk (`screens.tsx`, Settings → "Archived items" included): `route.tsx` and `archived/section.tsx` import only
the router, `titles.ts` and `slots.ts`, so no people screen is in an initial bundle. The queue registrations stay static (a dynamic import of
`register.ts`, like a lazy chunk of the ledger's own, made the bundler split shared modules out of the fixture entry, measured).

Routes: `/people`, `/people/$personId` (beside the list from 1280 px, alone below it), `/people/$personId/duplicates`,
`/people/$personId/fields/new` and `/people/$personId/fields/$fieldId` (the field editor, route-addressed so a remount of the protected tree
reopens it with its draft), and `/settings/archived`.

## What a consumer must do

1. **WEB-11b** fills `peopleSlots` before the tree renders; it never forks the detail page. Its link and merge commands are its own; the
   linkage line updates after any people command because `usePersonLinkage` reads again on `retry()`.
2. **The `archive` command kind is registered once**, by `src/features/content/archive-registration.ts`. A slice that archives another kind
   (WEB-10a tasks, WEB-10b lists) adds a current reader with `registerArchiveReader(read)` (answer `null` for a target that is not its kind) and
   calls `registerArchiveKind(registry)`, which does nothing the second time. A second `registry.register("archive", …)` throws. If WEB-10a lands
   with its own `archive` spec first, the integration moves its task reader into `registerArchiveReader` and removes the duplicate; a test
   asserts exactly one registration (`tests/features/people/register.test.ts`).
3. **`readOutstandingCreates`/`useOutstandingCreates`** (src/data). WEB-10a's branch (as of `d4f54e8`, 13 October 2026) ships the same read
   under other names, `readOutstandingByKind`/`useOutstandingByKind`, in the same files (`plans/outstanding-reads.ts`, `ui/outstanding.tsx`):
   the same input (`incarnationId`, `kinds`, `after`), the same statuses (queued, in flight, blocked; acknowledged while its own
   `pending_effects` row on the first target stands), windows of 100 by `created_seq`, plus the drafts needing a decision as headers. Whichever
   card integrates second keeps the first's plan and hook, moves its callers to it (here: `reads.tsx` `OutstandingChain`), and both cards'
   tests must pass against it.
4. **Summaries after a command** (finding 8): every online people command sent through `online.ts` `sendOnline` (WEB-11b's link and merge
   commands included) and every audience change invalidates the viewer-safe summaries shown (`memory.invalidateSummaries`); a new online
   command path must do the same. Queued commands are covered by the queue's counts and the applied revision (`useAppliedRevision`).
5. **Q4 recovery contexts** (`model/recovery.ts`): `people-field:<personId>:<fieldId|new:<formId>>`, `people-rename:<personId>`,
   `people-new:<formId>`. WEB-14a captures them; WEB-11a does not touch `src/lib/form-recovery`. A restore fills a form and never submits.

## Decisions (D-11a-1 to D-11a-23)

- **D-11a-1** Every field write is a typed `put_field`; `create_field` only for the new person's first note (SHARE-10 batch); `edit` only to
  rename a person whose profile is not linked.
- **D-11a-2** Linkage is read online (`GET /people/{id}`) and kept in the identity's page memory (outlives a remount; a `403`/`404` is remembered
  until Try again). Unknown linkage is shown as unknown, with the reason; it is never inferred from `can_edit`.
- **D-11a-3** (superseded by D-11a-20 for API 0.29) List rows show the name, initials, the cached field count, the pending mark and
  "Archived". The 0.28 prefetch of 25 linkage reads is REMOVED: the account line comes from the summaries for every row, and the list makes
  no `GET /people/{id}` at all.
- **D-11a-4** Lists are read in BOUNDED STEPS with a continuation (Q9; revision 1, finding 7): a step (`reads.tsx` `ResourceScan`) walks live
  pages of 100 (`useResourceList`) from a cursor and keeps at most 100 rows that match the view and the search, reading at most 20 pages for the
  people list, 10 for a person's fields and 50 per kind for the ledger. "Next people" / "Keep searching" / "Next fields" / "Next items"
  continue from the row the step stopped at; "Previous …" goes back. Every row stays reachable and nothing past the step is read. The cache
  lists by id, so a step is sorted by name within itself (base sensitivity, surrounding spaces ignored), then id. This device's queued creates
  are shown with the first step. The outstanding drafts are read in up to 10 windows of 100; beyond them the list says so and points to Sync,
  where every draft is listed.
- **D-11a-5** Rename: known self → `rename_profile` (online, 1–200); known unlinked → the content `edit` (queueable, 1–300); known other →
  disabled ("{name} owns this name"); unknown → disabled ("Needs a connection to check who controls this name").
- **D-11a-6** Unlink: enabled for the linked self only (online, one attempt per body, a confirmation); disabled with the drawn reason for
  another account's profile; absent for an unlinked person.
- **D-11a-7** A new field's audience: "Use my defaults — {resolved}" (queued, captures `field`), "Only you" (queued, explicit empty policy),
  "Home · can view" (online, `/task-access-commands`; disabled offline or without a primary household). "Choose people…" is offered after
  saving. The PPL-6 note appears when the person is known to be linked to another account.
- **D-11a-8** A quick audience change of an existing field is `applyPolicyChange` from the sharing slice (read, version guard, one
  `replace_policy`, confirming read), never a second editor; the content update that follows carries the confirmed policy version.
- **D-11a-9** "Not the same" is page memory: nothing is stored or sent.
- **D-11a-10** Archive and restore are queued `archive` commands with no confirmation. A person's archive does not archive its fields.
- **D-11a-11** Settings → "Archived items" (order 72, owner WEB-11): "Kind | Name" and Restore, no date (the projection has none). A field is
  listed only under a person this device holds. Each kind REPORTS an inventory state, not a number (review 4, finding 5: `LedgerReport`
  `{ count, state: "loading" | "failed" | "complete" }`, re-reported on every change and withdrawn with `null` when it unmounts):
  `complete` only when its rows, the outstanding drafts folded over them and every person a field's visibility depends on were read
  whole. "Nothing archived" is said only when every kind of the current reading is `complete` with nothing shown; any `failed` kind says
  "Couldn't read every archived item on this device. Anything that could be read is listed." with "Try again", which mounts every kind
  afresh (a failed live read has ended; clearing the message alone would read nothing). A person that could not be read still hides its
  field (never disclosed) and makes the inventory incomplete.
  - **A report belongs to its current read** (review 5 of 23 October 2026, finding 2; the fourth design assessment's C12). A field's
    parent report is `loading | shown | hidden | failed`, owned by that row's CURRENT read of THAT parent (a new owner for every mount
    and every parent read; a later owner outranks an earlier one). It is published, including `loading`, and withdrawn on unmount,
    before the browser paints (layout effects; store-driven commits also flush passive effects synchronously in React 19, so this is
    belt and braces). A report counts only while its field is listed with that parent; anything else is `loading`. So an answer about
    an earlier parent (a synced projection may move a field: the backend's person merge does), an earlier mount (a step back, a restore
    queued then discarded) or another service binding never completes the inventory. An earlier owner's late report or cleanup is
    ignored when APPLIED, and so is a kind's report of an earlier reading: the ledger's reading and its reports are one state.
  - Every registered kind follows the same contract (`archived/ledger.ts`): report `loading` until each read it needs answered for its
    current inputs, never keep an answer of an earlier input, and withdraw on unmount.
- **D-11a-12** "Hold it as a draft until I'm online" is DURABLE for its account (revision 1, finding 6; Kieran's decision of 13 October 2026:
  durable, in WEB-11a). A held change is a form copy of the account's own database (`field/held-store.ts`: `form_context`
  `people-held:<person>:<field>`, `tab_instance_id` the hold's id), written through WEB-09a's `FormRecoveryPort` and listed live by
  `readFormCopies`/`useFormCopies`. It therefore survives a reload, an account switch without logout, session expiry and a password change
  (Q3, Q20(a)); it is counted in the unsynced work a logout warns about (`form_copy`) and is deleted only with the account's data (a confirmed
  logout or self-retirement); it is admitted by the quota guard and refused while signing out; it is read only inside the account's
  protected tree (Q20(b)). On reconnect, on the person's page: one page of the browser runs it at a time (Web Locks, `exclusive`); the field
  must still be at the content version the edit began on (checked before AND after the policy step, and the content step's base is guarded in
  its transaction); the policy changes first (`applyPolicyChange`, the uncertain attempt kept with the hold); only then is the content queued
  with the confirmed policy version, under the hold's id as its local id. Every failure keeps the held draft with its reason, Try again and
  Discard. Discard while it runs stops it at the next admission boundary (before the policy write, after it, before and inside the content
  write); a policy change already made, or possibly made, is said so, and its attempt is kept for recovery (finding 2).
- **D-11a-12a** (review 2 of 22 October 2026, findings 2 and 4) A hold is an OPERATION, not a form. Its copy is written only through the
  conditional port (`src/data/ports/conditional-form.ts`): every write is a compare-and-set of the stored row (`content_digest`; the
  record's `rev` grows with each write, so a digest never comes back), an end is a terminal write from the state read, and every answer is
  typed (`saved`/`ended`, `changed`, `refused`, `failed`). The rows hold the highest writer generation, so the ordinary form port cannot
  claim or revive them. A run holds the FIELD's lock (`atlas-people-held:<account>:<field>`) until its last write, reads the hold again under
  it and runs only the state shown; the exact policy attempt is written BEFORE it may be sent (`applyPolicyChange`'s `admit`), the confirmed
  audience after it, and (until review 4, D-11a-12c) the content step was recorded as admitted (`queued`) before it was queued. A discard
  is said only when the end
  committed; a failed or refused end keeps the row visible with its reason. An end from another page before an admission makes the run's
  next write fail (`changed`, nothing more sent); after one, that page says what may already have happened (audience may have changed,
  edit may be queued). A new hold of a field ends the earlier ones from their stored states under the field's lock (a bounded, resumable
  read of that field's own copies); one it cannot end is kept, and said so. The held list is a bounded page of `readFormCopies` with "Show
  more held changes"/"Back to the first": its keyset cursor (`[form_context, tab_instance_id]`) crosses ranges of terminal rows of any
  length, and an empty page with a cursor is never "nothing held".
- **D-11a-12b** (review 3 of 22 October 2026, findings 1 and 2; the second design assessment's C3a-C3c) Three corrections of the hold's
  lifecycle (`field/held.ts`):
  - **Leaving is not discarding.** A run stops at its next admission boundary when its row leaves the page (another person, the list,
    another page of held changes) or another identity is displayed, and ends NOTHING (`suspended`): the input stays as stored, an admitted
    policy attempt and its answer are written as progress (same identity only), and an admitted content step that queued nothing is
    withdrawn. Only the person's Discard (here or in another page), a replacement or a completed content hand-off ends a hold. With this
    page's authority (D1) it runs again when its row is shown again.
  - **One current hold per field.** "Hold as draft" is ONE operation under the field's lock, from before the new copy is written until its
    earlier holds are retired (`holdChange`): it reads every live hold of the field (bounded), writes the new one as the field's next
    generation (`seq`, in the same write as its content; copies of the first shapes are generation 0), and only while the new copy is still
    stored as written retires the earlier ones, each from the state it was read in. A taken lock writes nothing and keeps the edit open
    ("Another change to this field is being saved or sent. Try again in a moment."); an incomplete read writes nothing. A run runs only
    the field's current hold: an earlier hold still kept (a page closed between the two steps, a refused retirement) is retired by the
    run that finds the later one, never run; the current hold's run retires such leftovers first. Copies this page cannot read are kept
    (shown, discardable, never run; explicit Discard ends the copy as it is, by its digest).
  - **An unresolved attempt outlives its content.** A hold whose policy step may have been made is never ended by a discard or a
    replacement: it is RETIRED (`discardHold`, `retireForReplacement`), a reconciliation record that keeps the attempt, the audience asked
    for and its guard version, with the content cleared, counted as unsynced local work like any form copy. It is shown as "An earlier
    change to who can see {name} may already have been made. Check it to be sure." with "Check now" and "Discard" (forgets THAT record
    only, `forgetRecord`). "Check now" is observational since review 4 (D-11a-12c). A new hold of EXACTLY the same
    change (same policy version, same audience asked for) takes the attempt over (same key and body) and the earlier hold then ends; a
    direct change of the same audience in the editor sends the kept attempt's key and body too. A retry of an identical attempt is sent only
    while the hold is still stored as the run read it (a discard elsewhere wins, as it does against a write). No background policy change.
- **D-11a-12c** (review 4 of 23 October 2026, findings 1–4; the third design assessment's C7–C10) What may run, and what already
  happened, are durable facts, never inferred from which copies are still live (`field/held-store.ts`, `field/held.ts`):
  - **The field's head.** Each field has a HEAD: a terminal form row `[people-held:<person>:<field>, "~head"]` (never listed, restored or
    counted as unsynced work) holding the field's generation and its CURRENT hold. "Hold as draft" writes the new hold AND the head naming
    it in ONE transaction (`HeldStore.create` through the conditional port's `apply`, `data.saveFormOperation`), only while the head is as
    read, under the field's lock. The head never goes back: ending, retiring or handing off the current hold leaves it in place, so an
    earlier hold (one whose cleanup failed) can never run again. A run runs only the head's current hold; any other live hold of the field
    is retired as its predecessor (housekeeping, never authority: a field whose holds cannot all be listed is cleaned up by a later run).
  - **One transaction to the outbox.** The content is HANDED OFF: the draft (the hold's id as its local id, the confirmed policy version)
    and the end of the hold's copy are ONE transaction (`outbox.enqueue(request, handOff)` → `data.transferDraft`, a W2 writer with the
    form copy's CLS guard), only while the copy and the head are as read. There is no content admission (`queued`) any more. The ended copy
    keeps a TOMBSTONE (`held_end`: generation, cause `transferred`, local id), so a lost answer is read back from the copy and a retry never
    queues it again, whatever Sync did with the draft since (edited, discarded, superseded, sent). A draft that already has the id is never
    adopted. Every ended hold keeps its cause (`discarded`, `replaced`, `forgotten`, `transferred`).
  - **Three transitions, not one end.** `discardHold` (the person's Discard of a hold: retires it when its attempt is unresolved, else
    ends it), `retireForReplacement` (automatic cleanup: a reconciliation record is KEPT unless the successor carries its exact attempt)
    and `forgetRecord` (the person's Discard of one record: only that record ends). Unresolved attempts are kept by their records only (no
    copy into the page's memory slot of the field, where one could replace another).
  - **"Check now" observes.** One owner-only read of the policy, noted with its time. It says only what the audience IS now ("…hasn't
    changed since this was asked for, so it may still be made…", "…is now what this asked for. Whether this change made it can't be told
    from here.", "…has changed since to something else, so this can't be made any more."), sends nothing and ENDS NOTHING: an unchanged
    version may still be changed by the attempt, a matching policy may be someone else's change, a different one may have followed it.
  - **Lookups are found, none or unknown.** `heldAttemptOf` matches the canonical body of exactly this change; a failed or bounded read,
    a copy this page cannot read, or two different attempts are `unknown`, and the direct editor then sends nothing ("Couldn't check this
    device for an earlier try of this change. Try again."). The page's own attempt counts only for exactly the same body.
  - **One binding per operation.** A run, a "Hold as draft" and a Check take ONE binding of the store (`HeldStore.pinned`, over the
    conditional port's `pinned`): once another account or database is displayed every later call fails; nothing reaches the new one.
  - **Legacy copies.** Copies of the earlier shapes (v 1–3: before heads and tombstones) cannot say whether they were already queued and
    discarded in Sync or replaced by a hold that has since ended. They are shown ("A held change to who can see {name} from an earlier
    version of Atlas is kept on this device. It can't be sent from here: discard it, or make the change again."), never run, never written
    again (except retired by Discard, keeping an unresolved attempt) and never retired automatically. No action recreates their content.
  - A row waiting while another row of the page runs looks again when that run ends (before, a second authorised hold never started).
    However the run ends (review 5 of 23 October 2026, finding 1; C13): after its outcome is applied, the runner removes its own entry and
    publishes the end to the SAME identity's memory, also when the run was only suspended (its row left the page: navigation, another page
    of held changes). It grants nothing: a recovered hold still waits for Send now, a discarded one never runs, and another identity's
    memory is never touched.
- **D-11a-13a** (review 3 of 22 October 2026, finding 3; C6) The page's own policy read names a field's audience only while no later
  policy version of the field is known (the cached row's `policy_version` or a version a summary applied), a late older read never
  replaces a later one (`notePolicy`), closing the shared policy editor withdraws it (it may have changed the policy), and it is said with
  the time it was read ("Checked at {time}"), never as live. Otherwise the button reads "Who can see it?".
- **D1** (design assessment of 22 October 2026; answered "explicit Send now" in the Running session's question on 22 October 2026) A hold
  runs by itself only in the page that made it, or after the person chose "Send now" or "Try again" there (`memory.heldAuthority`). A
  recovered hold (after a reload, an account switch back, in another page, a legacy v1 copy, one whose discard could not be written) is shown
  as "Waiting to change who can see {name}. Send it when you're ready." and sends nothing until "Send now".
- **D-11a-13** (revised by D-11a-21) A field's audience comes from the field audiences summary while online and not older than the
  cached field; else from a policy this page read in the editor; else the button reads "Who can see it?". It opens the policy editor, which
  shows its own owner-only state. No owner-only policy is read to fill the table.
- **D-11a-14** Online reads are this slice's own small reads through the stamped client, bound to the displayed identity; a read the session
  held back (`not_sent`) is asked again, bounded.
- **D-11a-15** A save while the item's previous draft is still queued and unsent edits that draft in place (its review block kept), but only
  the draft the edit BEGAN on, while it is stored as it was (`expectDraft`); an unsent create is edited in its own body.
- **D-11a-17** (revision 1, finding 1) An edit is BOUND to what it began on (`model/snapshot.ts`): the content and policy versions it opened
  on, and the outbox base its command must resolve (this device's own chain, or the cached version). Its `expected_policy_version` is the
  snapshot's, never the live row's; its build refuses inside the outbox transaction when another base is resolved (`BaseGuard`; the outbox's
  size estimate is never judged). A field whose content or policy moved since, or whose audience read is of another policy version, is not
  saved: the editor shows "This field changed since you opened it" with the current value, the audience now (when it changed) and the
  person's own, and only "Save mine on the current version" (withheld while a changed audience cannot be shown) re-binds the edit. A rename
  is bound the same way (Q21: the version is captured when the form opens).
- **D-11a-18** (revision 1, finding 3) A version conflict shows the CONFLICTED save's own content ("Yours", read from the queue with
  `useDraftWithCommand`) beside the current value; "Save mine on the current version" supersedes with that content on the current version,
  after the current audience is shown when the save was made under another policy version.
- **D-11a-19** (revision 1, finding 4) A person's screen is keyed by the person (`screens.tsx`), as is the duplicates view: an open rename and
  its typed name, the fields' step and the duplicates' pages never carry over to another person; a typed rename is kept under its own person.
- **D-11a-16** Master-detail from 1280 px; one column below. Dialogs are sheets below 768 px.
- **D-11a-20** (finding 8, API 0.29) The drawn views and lines. Chips "All", "In Home", "Shared with me", "Not linked" (drawn) and
  "Archived" (Q21). All and Archived are the CACHE's (offline-capable, this device's unsent saves folded in); while online each step's
  people are joined by id to `GET /people/summaries` (`scope=all`, the step's own `archived`) read from the step's start until every person
  of the step was seen, a page passed its last id, the end, or the step's page bound (20). In Home, Shared with me and Not linked are the
  SERVER's: each step walks the summary pages themselves (100 kept, at most 20 pages, search over the names read, "Next people" / "Keep
  searching" continue from the server's cursor), so nothing cached is filtered and called complete; offline they say they need a
  connection. In Home with no primary household is the explained empty state (product decision 3). Each row says who added the person
  ("You" when linked to you; "Added by you" only for `yes`; "Shared with you by {owner}" for another owner, the owner's visible person's
  name or their username; nothing for `unknown`: product decision 1), the account ("Linked to your account" / "Linked · they control their
  name" / "Not linked to an account") and "Visible to: {audience}". A list that shows a partial audience says once that the owner may have
  shared them more widely (product decision 2).
- **D-11a-21** (finding 8) Who can see a person and a field. The owner's audience: "Only you", one household with its role ("Home · can
  view", "· N excluded"), or the counts ("2 households, 1 person", "· mixed" across households). A reader's partial audience names only
  what reaches them ("Shared from Home", "Shared with you", "… and with you"), never "Only you", never other access. Household SIZE is never
  said as an audience. A field's tag is its own sharing (an upper bound); under it, "N other people can see it" (and how many it is shared
  with cannot see the person) only when `effective` is `complete`, else "Only people who can also see {person} can see it." The detail's
  "Shared with" (`GET /people/{id}/summary`): the owner, each account and household with its role, the household's size said as its size
  ("4 members in the household"), and for the owner the members of a household they belong to (excluded ones marked "can't see it") and
  "Excluded: …"; a reader's rail is partial and says "{owner} owns this person. You see only how it's shared with you; {owner} may have
  shared it more widely." Unknown, failed or offline is never "Only you".
- **D-11a-22** (finding 8) How the summaries are read (`summaries.tsx`). For the displayed identity only (the env and its page memory);
  in memory only, per query, for the current invalidation generation. An invalidation supersedes every earlier read (an answer that arrives
  after it is dropped) and a traversal it interrupts starts again from its own first page. The pages of one traversal must share one
  `preferences_version` or it restarts; an answer whose `preferences_version` is lower than one applied in this epoch is not applied (read
  again, at most three times, then "Couldn't check"); a higher one makes every other summary out of date; a row is never replaced by one
  with a lower `version` or `policy_version`; a summary older than the cached projection is not shown beside it. INVALIDATED (re-read) on
  any synced change (`useAppliedRevision`: `sync_state.applied_revision`, which moves on any committed batch, a superset of person and field
  changes), any change of the queue's counts (a command receipt), every online command sent and every close of the policy editor, a
  change of the B5 record's households or primary household, reconnection, every 60 seconds while shown online and visible, and whenever
  the page becomes visible again. Offline a summary is unavailable (never an old one); every view says when it was checked ("Sharing
  checked at {time}. Atlas checks again every minute while you're online."), never live.
- **D-11a-23** (finding 8) Layout within the budgets (production CSS within 5 bytes of its limit): the list shares the desktop screen with
  the detail (380 px), so "Account" and "Visible to" are labelled lines of each row rather than table columns; "Shared with" is a section
  of the detail below the fields rather than a right rail. No new utility class was added.

What is shown of unsent changes: a queued draft has no overlay until it is claimed, so the screens fold the bodies of the outstanding drafts
(`useOutstandingCreates`) over the cache (`model/project.ts`): a create is projected and marked "Not sent yet"; a later rename, field update or
archive is folded over its row. A projected row is never a base for a version-checked command.

## Limits

- The summaries are as fresh as their snapshot: up to the 60-second refresh behind a household or primary household change made elsewhere
  (the contract's own bound). Each invalidation re-reads every summary shown (a list step's join, the person's summary, the fields' step).
- Search in In Home / Shared with me / Not linked matches the names the server returned: a rename not sent yet is shown folded over the
  row but is not searched there until it is sent.
- "Recent changes" (the drawn rail's second panel) is still not built: no history endpoint exists.

- Hidden form values (PRODUCT-DECISIONS-20261011 item 2): the field type switch keeps each type's value; the new person's hidden note keeps
  its text; a save sends only what applies, with no warning. A refused or uncertain save keeps everything. Inputs are locked while saving.
- The page memory (linkage answers, policies read, editor drafts) is per identity and dropped for any other identity; the held audience
  changes are not in it (they are durable, D-11a-12). An open, unsaved editor's typed text is page memory: it survives a remount, not an
  account switch or a reload (WEB-14a's Q4 recovery covers the update reload).
- A held change whose content was handed off is no longer a hold: its draft is an ordinary queued change, shown in Sync and discardable,
  and nothing on the person's page queues it again (D-11a-12c). A LEGACY copy (v 3) whose content admission was recorded may still have
  been queued; its Discard says so ("may already be queued. Check Sync").
- A new draft that FOLLOWS a still-queued save the edit began on (held for the defaults review, or after the audience was just changed) is
  allowed only while the outstanding read shows that save with the body the edit read; another page's edit of it in the one transaction's
  window before the new draft is written is not detected (an edit in place is judged inside its own transaction, `reviewedDraft`).
- A field update that changes type patches only the label in the overlay (the overlay's value merge is shallow); the screens show the saved
  value from the draft body.
- Rebuilds offered by the sync queue ("save as new") are built on the authorised current read's CONTENT version, under the policy version
  the person saved them with; a field change or rename whose audience moved since is not rebuilt there (review 2, finding 1, Q1): the
  dialog shows the retained and current content (`review`) and says to review it in People (the field editor's comparison) or, for a
  rename, to discard it and rename again. A resend is bound to the body the dialog showed (`saveAsNew`'s reviewed digest).
- An edit in place of a queued save (field update, rename, unsent create) replaces only the body the edit read (`latestDigest` /
  `createDigest`, compared inside the writing transaction). Another page's newer edit of the same draft is never overwritten, and the
  refusal never falls back to queuing the older form after it: the field or rename is reviewed again (review 2, finding 3).
- Summary labels (person, owner's person, household and primary household names) are limited to 300 characters as the server counts them
  (Unicode scalar values), never UTF-16 units (review 2, finding 5).

## Not claimed

Fixture evidence (component tests, `tests/e2e/fixture.people.spec.ts`) is not integration evidence. The real-backend cases
(`tests/integration/integration.people.spec.ts`, I-PPL1 to I-PPL16, against `v0.29.0-rc.1`; I-PPL1 to I-PPL14's earlier runs against
`v0.28.0-rc.1` stay historical) are focused evidence for a fixture-stage task on SQLite through the delaying proxy, with the fixture test leader; `integration_passed` stays false (BE-Q1 and BE-CH1 have no completion record). No PostgreSQL, HTTPS, device
or screen-reader evidence (WEB-09d), no production-leader integration beyond the fixture case E-P2b, no copy approval (STAGED-ACCEPTANCE §5).

## Additions and deviations for the copy and visual checkpoint (plan §9)

Collected for the connected-app checkpoint after WEB-10a/10b/11a plus Settings; none is approved by being listed. Each can be reproduced in
the fixture spec named.

| Item | Route | Reproduce |
| --- | --- | --- |
| Linkage unknown: "Who controls this profile isn't known on this device." with its reason; rename reason "Needs a connection to check who controls this name" | `/people/$id` | E-P7 (one column, offline) |
| An unlinked person's rename queues offline; a linked rename stays online-only | `/people/$id` | E-P7 |
| Unlink confirmation: "Unlink your account from this profile?" and its body | `/people/$id` | E-P7 |
| The drawn chips plus "Archived"; "Account" and "Visible to: …" as labelled lines of each row, not columns (D-11a-23); "Added by you", "Shared with you by {owner}", "You"; "Visible to: Shared from {household}" for a partial audience; "For people someone else owns, you see only how they're shared with you. The owner may have shared them more widely."; "Sharing checked at {time}. Atlas checks again every minute while you're online."; "Who can see each person and their account links are checked when you're online."; "Checking who can see these people…"; "Couldn't check who can see these people." | `/people` | E-P1, E-P19 |
| Server views' states: "This view needs a connection. All and Archived work offline."; "You haven't chosen a primary household, so nobody is In Home. Everyone you can see is still under All."; "Nobody is shared with {home} yet."; "Nobody has shared a person with you yet."; "Everyone here is linked to an account."; "Couldn't load this view." | `/people` | E-P19, component tests |
| "Shared with" as a section below the fields (D-11a-23), household size as "{n} members in the household", members "(can't see it)", "Excluded: …", "Only you can see this person.", the partial rail's sentence, offline/checking/failed/not found copy; no "Recent changes" (no history endpoint) | `/people/$id` | E-P20 |
| Field tags from the field audiences; "N other people can see it.", "N people it's shared with can't see {person}.", "Only people who can also see {person} can see it.", "The owner may have shared it more widely.", "For fields someone else owns, …"; "Who can see each field is checked when you're online." | `/people/$id` | E-P20 |
| Owner audiences: "Home · can view" for a person (drawn "Home · 4 people": a household's size is not an audience count, so it is not said as one) | `/people`, `/people/$id` | E-P19, E-P20 |
| Pending marks "Not sent yet", "Sending…", "Waiting for the server", "Waiting for your review" | `/people/$id` | E-P2, E-P10 |
| Bounded steps: "Next people", "Previous people", "Keep searching", "Showing {n} so far. There may be more further on.", "No one matches “{q}” so far. There are more people to check.", "Next fields", "Next items"; a step is sorted by name within itself; "More unsent changes are waiting than this page shows. All of them are in Sync."; "This value can't be shown on this device" | `/people`, `/people/$id`, `/settings/archived` | E-P18, component tests |
| The review of a changed field: "This field changed since you opened it", "Current: …", "Who can see it now: …", "Yours: …", "Check who can see it first: that needs a connection"; the rename's "This person changed since you started. Review the name, then save again." | `/people/$id/fields/$fid`, `/people/$id` | E-P14, E-P5 |
| Field types "Text, Amount, Date, Link, Yes or no, Choices, Checklist" and their inputs | `/people/$id/fields/new` | E-P3 |
| New field audiences "Use my defaults — {…}", "Only you", "{Home} · can view"; "Save it as Only you first; then choose who can see it…" | `/people/$id/fields/new` | E-P2, E-P3 |
| PPL-6 notes ("{name} won't see this field unless you share it with them", "{name} is in {Home} and will be able to see it", "may be able to see it") | `/people/$id/fields/new` | component tests |
| Held change copy "Kept on this device until then, even if you reload or switch accounts." and §9 row 2's caveat; "Waiting to change who can see {name}"; "Stopping the held change to {name}…"; the discard outcomes ("…was discarded. Nothing was sent.", "…had already changed…", "…may already have been made…"); "Couldn't keep this on the device." | `/people/$id/fields/$fid`, `/people/$id` | E-P6, E-P15, E-P16 |
| Duplicates: "No similar names found so far. There are more people to check." with "Check more"; footer adjusted to page memory | `/people/$id/duplicates` | E-P9 |
| Settings "Archived items" placement, empty state, archived-person banner copy | `/settings/archived` | E-P8 |
| New person dialog (not drawn): name, "Who can see this person", "Add a first note" / "Don't add a note" | `/people` | E-P10 |
| People on tablet use one column (no tablet frames exist for people); the editor is a sheet below 768 px | `/people/$id` | E-P12 |
| Bundle-budget adjustments (production CSS within 4 bytes of its limit): list rows and skeletons 48 px high (drawn 56 px), Amount and Unit side by side at equal widths (drawn 2:1), Day/Month/Year as an equal flex row, "Show more" and link-style buttons underlined in the text colour (drawn hairline), the selected row and chip marked with the existing `data-[status=active]` tint | `/people`, `/people/$id/fields/$fid` | E-P1, E-P3, E-P12 |

Escalations and their decisions (revision 1, 13 October 2026):

- **E-1** (finding 6) — DECIDED by Kieran: durable, in WEB-11a. Implemented over the account database's form copies (D-11a-12); no schema
  change was needed (the `form_recovery` store and its port already carry the account's unsent form content with every Q20 rule). The
  integration owner of WEB-14a (Q4 recovery) must keep `people-held:` copies out of any form it restores or discards by family.
- **E-2** (finding 8) — DECIDED by Kieran (13–14 October 2026): a dependency hold until BE-PEOPLE-SUMMARY was accepted, shipped and its
  API types adopted. **RESOLVED 15 October 2026:** BE-PEOPLE-SUMMARY shipped as `v0.29.0-rc.1` (backend `4396c99`), adopted by `1adadae`
  and merged here by `7d71ba7` (the operator's handover PEOPLE-API-029-20261015, `frontend-adoption.md` and
  `released-contract-handoff.md`). The drawn views, lines, tags and "Shared with" are built on the three viewer-safe reads (D-11a-20 to
  D-11a-23), with the product decisions of 14 October (`delivery/handoffs/people-summary-product-decisions-20261014.md`); no owner-only
  policy read fills any of them. The independent review of the complete result follows.
- **E-3** the list's duplicate banner (one read per person) and the Requests entry (WEB-11b) are not built; recorded for the checkpoint.

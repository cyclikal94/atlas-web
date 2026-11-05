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
requestsPath(), mergePath(personId, otherId)           // WEB-11b: WF-PEOPLE-06; "Compare & merge" (otherId merged into personId)
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

## Decisions (D-11a-1 to D-11a-26)

- **D-11a-1** Every field write is a typed `put_field`; `create_field` only for the new person's first note (SHARE-10 batch); `edit` only to
  rename a person whose profile is not linked.
- **D-11a-2** Linkage is read online (`GET /people/{id}`) and kept in the identity's page memory (outlives a remount; a `403`/`404` is remembered
  until Try again). Unknown linkage is shown as unknown, with the reason; it is never inferred from `can_edit`. An ordinary read joins the
  one on its way; a read asked after a command, Reload or Try again supersedes it, and only the latest read of a person changes what the
  page knows (review 20, R20.1): an answer read before an unlink never replaces the one read after it. Offline, Try again asks nothing and
  forgets nothing. An answer is CURRENT only at the latest version of the person this page knows (review 25, R25.1: `personFloor`, from
  the linkage answers, the synced row and the summaries applied; never lowered by a refusal or a summary read again). A later version (an
  unlink increments it) withdraws the answer at once from the header line, Rename, Unlink and the field editor's subject note (unknown,
  "Checking…", never "unlinked"), and ONE read is asked for that version, shared by every caller; an answer still older stops there
  ("couldn't check", Try again) until a later version or a reconnection after a failure. Rename and the open unlink confirmation judge the
  current linkage at the press; the confirmation stays bound to the version it was opened on, and is bound again only to the signed-in
  account's own linkage read after its own unlink conflicted. The summary itself is never the linkage (D-11a-3's prefetch is gone).
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
  another account's profile; absent for an unlinked person. An unlink whose outcome is uncertain is the exception (D-11a-32).
- **D-11a-7** A new field's audience: "Use my defaults — {resolved}" (queued, captures `field`), "Only you" (queued, explicit empty policy),
  "Home · can view" (online, `/task-access-commands`; disabled offline or without a primary household). "Choose people…" is offered after
  saving. The PPL-6 note appears when the person is known to be linked to another account. It describes the policy the save leaves
  (`selectedPolicy`, the same derivation the save sends; review 22, R22.1): a subject that policy excludes "won't see it" whatever it
  grants (a change to Home keeps the field's exclusions), and a Home member is "included" only as far as the page can know, since the
  subject must also be able to see the person the field is on. An unknown policy or membership says "may".
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
  - **The save a hold's value was typed over** (review 12, R12.1; v 5). A hold records it (`predecessor`: the save's id and the digest of
    its body as the editor showed it, or null when nothing was outstanding), and its content step names it to the hand-off's transaction,
    which refuses stale content (`content_changed`, the hold kept with its actual audience outcome). A page that already sees that save
    changed changes no audience first. A v 4 copy never recorded it: it is shown with its value and any audience attempt ("This held
    change to {name} was kept before Atlas recorded what it was typed over, so it won't be sent. Edit the field to review it and save it
    again, or discard it."), never sent automatically, by Send now or by Try again, and never given a guessed binding; saving the field
    again replaces it through the ordinary hold path, and Discard ends it or keeps an unresolved attempt as a reconciliation record
    (`delivery/handoffs/web11a-v4-held-review-before-send-20261024.md`, SHA-256 `ac6bda2c…6c116f14`).
  - A row waiting while another row of the page runs looks again when that run ends (before, a second authorised hold never started).
    However the run ends (review 5 of 23 October 2026, finding 1; C13): after its outcome is applied, the runner removes its own entry and
    publishes the end to the SAME identity's memory, also when the run was only suspended (its row left the page: navigation, another page
    of held changes). It grants nothing: a recovered hold still waits for Send now, a discarded one never runs, and another identity's
    memory is never touched.
- **D-11a-13a** (review 3 of 22 October 2026, finding 3; C6) The page's own policy read names a field's audience only while no later
  policy version of the field is known (the cached row's `policy_version` or a version a summary applied), a late older read never
  replaces a later one (`notePolicy`), closing the shared policy editor withdraws it (it may have changed the policy), and it is said with
  the time it was read ("Checked at {time}"), never as live. Otherwise the button reads "Who can see it?".
- **D-11a-13b** (review 23, R23.1) The shared sharing editor ("Choose people…" in the field editor, the field row's audience button) reads
  and saves the field's policy on its own. Whatever it read is this page's read too (`onPolicyRead`, monotonic through `notePolicy`); however
  it closes (saved, cancelled, or a save whose answer was lost), the page's read is DOUBTED (`doubtPolicy`): its version stays as the floor
  nothing lower replaces, but it is not shown as who can see the field now until a read asked after the doubt answers (a FRESH read, which a
  read already on its way cannot answer; only the latest read of a field ends or refuses it). An edit restored on a later mount (Sync and
  back, the Sharing screen) is doubted the same way. While doubted the field editor says "Checking who can see this field…", or offline
  "Who can see this field may have changed. It's checked again when you're online."; a policy that moved shows "Who can see this field
  changed since you opened it" with the input kept, and the edit is bound to it only by "Save mine on the current version" once the field
  has synced to that version ("Who can see it now is shown here once this field has finished syncing." until then). A chosen audience is
  never dropped by a content-only save while the current audience is unknown. A quick change's confirming read is fresh as well.
- **D-11a-13c** (review 24, R24.1) The field editor honours every version of the field's policy this page has observed: the synced row's,
  its own kept read's and one a field audiences summary applied (`summaryFloors`, the same evidence the field row already uses, D-11a-13a).
  A kept read below any of them is not said as who can see the field now (the subject's exclusion note included); a LATER version alone
  says the policy moved (`policyMovedFrom`), before any read or sync of it. The editor then asks one FRESH read per required version (an
  answer below it neither revives the note nor is asked again; a newer version that arrives while a read runs is asked once after it),
  keeps the input, session, exclusions and binding, and waits for the field to sync ("Who can see it now is shown here once this field has
  finished syncing."); the edit is bound to the newer policy only by "Save mine on the current version" once the synced row and the read
  agree. The ordinary save and a conflicted save check the version known when pressed, not as last rendered. A summary is evidence of a
  move only: never a policy, an exclusion, a permission or consent; a remembered owner-only `403` is not read again because of it.
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
  (Revision 10, review 10 finding 1) An edit that began on a field's unsent create keeps that ORIGIN (the create's local id and body
  digest) for its session; it is not bound to the published field, since no version or audience of it was ever reviewed. Once the create
  is published the editor keeps the input and shows "This field has finished syncing" with the field and who can see it as they are now
  (read at the field's policy version: an unknown, unreadable or newer audience withholds the action with its reason); Save waits for the
  review, and only "Save mine on the current version" binds the edit, after which the save is an update of the same field on the reviewed
  versions. Nothing binds or saves because the create was published. While still unsent, only the create the edit began on (its local id
  and body) is edited in place; a create being sent is said as such ("being sent"), the input kept, never a second create.
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
- **D-11a-24** (review 6 of 23 October 2026, finding 1) A save's completion ends only the EDITING SESSION it was made in (`lifetime.ts`).
  The field editor, New person and the rename form keep their input under a draft key with a session id; a remount of the tree or going
  away and back restores the same session, while Cancel, Escape and the close icon end it (the next "Add a field", "New person" or Rename
  begins another). Each keeps its input AS IT IS TYPED, not only when the sync control is used (review 19, finding 1: New person kept
  only the sync control's snapshot, so a remount lost later input and began a new session beside a running save); an untouched New
  person keeps nothing. The mounted form of a session registers itself in page memory (`memory.sessions`, the latest mount wins, a mount
  withdraws only itself). When a save completes, `completeSession` ends that session only: its kept input is forgotten and the form that
  shows it now (if any) closes, onto the saved person for New person; input typed after the saved revision stays, with "Saved. Your later
  changes are still here and aren't saved yet."; a session that already ended or was replaced, or another identity, is not touched (the
  save is still announced, and an admitted save is never undone). Archive from the editor ends its session whatever was typed. An unlink
  answer closes only the confirmation it was asked from.
- **D-11a-25** (review 6, finding 2) The person detail claims absence only from a COMPLETED read. "This person isn't on this device" needs
  the person's read to have completed without them and every unsent change of this device read (an absent database holds none); a failed
  or closed read says "Couldn't read this person on this device." with "Try again", a later window of unsent changes still loading shows
  the skeleton, and more unsent changes than the 10 windows read says the person can't be shown. "No fields yet." needs the field step
  settled and every unsent change read; a failed step keeps the readable rows and says "Couldn't read every field of this person on this
  device. Anything that could be read is listed." with "Try again" (a new read of the same step); unreadable unsent changes beside a shown
  person say so with "Try again". Each Try again mounts its reads afresh (a failed live read has ended). A field under a person that could
  not be read is never shown.
- **D-11a-26** (review 6, finding 3) A press is never lost to a read that answers during it (`detail/steady.ts`). While a pointer is down,
  the detail's read-dependent boxes above its actions (the header with the outstanding-change notice and conflicts, the field list and
  each field row, `[data-steady]`) keep the height they had when the press began; what they show changes at once (a taller answer
  overflows for that moment). They are released after the click has been delivered, at once when the press is cancelled, or 500 ms after
  a pointer released elsewhere. Keyboard activation is unaffected. Revision 7 extends this to the pressed action itself (D-11a-29).
- **D-11a-27** (review 7 of 23 October 2026, finding 1) An editing session saves ONCE at a time (`lifetime.ts` `admit`). The claim is taken
  synchronously, before anything is awaited, in the identity's page memory (`memory.pending`), keyed by the session id (or, for an
  action without input, by its target: `archive:<id>`, `unlink:<id>`); every mount of the session shows it saving and admits nothing
  until the save settles, however it ends, and an old save's settlement never frees a later claim. So a New person kept by the sync
  control and reopened, a remounted field editor or rename form, an unlink asked again, or a second press of Archive starts no second
  operation. The editor's Archive is admitted with its session (neither runs beside the other); the audience step, its confirmation and
  the content update of a field are one admission. What a save says (a refusal, a confirmed re-binding) is told to the form showing the
  session NOW (`reportSession`), or kept for its next mount; a session that ended (Cancel) is told nothing. A retry of the SAME input is
  the same request: New person's person, note and local ids, and a queued field create's local id, are prepared once per input
  (`preparedFor`), so a save that was written but whose answer was lost is recognised by the outbox (`localId`), never made twice; a
  changed input is a new request. This is page memory only: a reload forgets a running save's claim (the queue keeps what was written),
  and another page is excluded by the outbox's own guards (base versions, draft digests, the field lock), never by this. Restore in the
  Settings ledger (outside the people screens' memory) is latched by its row.
- **D-11a-28** (review 7, finding 2) The People list claims nobody only from complete inventories. What it shows is the cache AND this
  device's unsent changes (a queued new person exists only in the queue), so "No one here yet", "Nobody is archived." and a final "No one
  matches" need both read to their end: while the unsent changes are read the list is loading; when they could not be read (a failed or
  CLOSED database: `reads.tsx` `statusOf` counts only a database known not to exist as absent) the list says "Couldn't read every unsent
  change on this device. What's shown may not include them." with "Try again", beside whatever could be read; more unsent changes than it
  reads says so and claims no absence. A failed cache read keeps any readable rows under its banner. "Try again" mounts the list's reads
  afresh (new watches) and asks the data layer to retry an unavailable database. In In Home / Shared with me / Not linked, who is listed
  is the server's; a search there matches the names SHOWN (this device's unsent renames over the server's), and its "No one matches" also
  needs the unsent changes read. The field editor opens only on a complete read of the unsent changes: a failed or capped one says the
  field can't be edited yet, with "Try again", and any kept input stays kept. The separate live reads of the cache and of the unsent
  changes are delivered separately, so when ONE commit moves a new person (or field) from the queue to the cache, the queue's read can
  answer first and, for that moment, neither shows it (the design assessment's DA7-12, reproduced). So an absence the separate reads
  suggest ("No one here yet", "Nobody is archived.", "No one matches", "This person isn't on this device", "No fields yet.") is said
  only when one read of both in a single transaction (`data.readInventory`, bounded like the reads it confirms: the step's pages and 10
  windows) agrees (`reads.tsx` `ConfirmedAbsence`); meanwhile the screen shows its loading state.
- **D-11a-29** (review 7, finding 3) The pressed ACTION keeps its place and size (`detail/steady.ts`). A fixed outer box is not enough: in
  the narrow layout a field row stacks its audience and reach above Edit and Archive, which then move inside the row (22 px in the
  review), and on wider layouts the row recentres. So while a pointer is down on an enabled action inside the detail, the People list or
  the archive ledger, the action is measured when the press begins, its width and height are held, and after every change inside the
  root it is translated back to where it was, before the next input is hit-tested (a translated element is painted, and hit, above what
  moved under it). What is shown still changes at once. Everything is restored after the click is delivered, at once on cancel of that
  pointer, when the page is hidden, or when the action is removed or disabled (a withdrawn action is never kept for a click), and 500 ms
  after its pointer was released elsewhere; a second pointer starts nothing.
- **D-11a-30** (review 15 of 25 October 2026, R15.1; PPL-5/A14) A field count is shown only under a person the cache holds now. A
  duplicate hint the duplicates answer listed stays listed after its person is removed (the answer is not withdrawn, and no new answer is
  needed), but its count is not: `useVisibleChildren` reads the person and the first page of their fields in ONE transaction
  (`readVisibleChildren`) and answers null when the cache holds no person of that id, whatever fields are still cached. A removal of the
  person alone answers again, so neither a retained count nor one of fields cached later is shown. Loading, a failed read and a hidden person
  all show no count, never "0 fields". The People list's cached count uses the same read: its row comes from the list's own read, which
  can answer a commit later than the count's. A read-only or archived person is still visible. The detail and the Settings ledger keep
  their own parent gates. Tests: `duplicate-visibility.test.tsx`, `tests/data/visible-children.test.ts`, E-P39 (two real pages).

- **D-11a-31** (review 16 of 26 October 2026, R16.1, and its design assessment's DA16-S1; PPL-5/A14) Whatever is shown of a field comes with
  evidence, from the SAME read, that its person is visible. Two live reads are delivered separately: a person read that has not yet answered
  for the commit that removed the person, beside a field read that has, would pair an earlier person with a later field (a new field, a new
  label or value). So:
  - the detail and the Settings ledger read each page of fields WITH the persons of its fields and this device's unsent changes over them
    (`useChildPage` / `readChildPage`, through `ChildScan`): a field is shown, counted, labelled and named only from that one answer, and a
    detail page read without the person shows nothing of the step (not the fields an earlier page kept, not this device's own unsent fields,
    not "No fields yet"); the walk moves on by the page READ, so hidden rows never keep a later field out of reach;
  - the field editor reads the field and its person in ONE read (`useMergedUnder`); a cached field is edited only under the person that read
    holds (a person only this device creates has no server fields), and a failure of that read is said as the field's;
  - the outstanding drafts' read (the detail's and the editor's) also reads the person's cached row in each window's transaction: what it
    shows of unsent changes (a rename, this device's new fields) waits while a window was read from a state without the person, unless the
    drafts create the person themselves;
  - held audience changes are listed only when their read of the copies also held the person (`useFormCopiesUnder`);
  - the shared sharing dialog (embedded and at `/sharing/items/<id>`) names, reads and offers a resource that has a parent only while the
    same read (`useMergedUnder`) holds the parent: a late policy answer never reopens its editing view.
  Not shown is not discarded: typed input, retained sessions, held copies and their authority stay; a person who returns shows them again.
  Visibility is not write authority: every write keeps its own guards. Tests: `parent-read-coherence.test.tsx` (every surface, both orders,
  every rendered state recorded), `tests/data/child-reads.test.ts` (the production plans and page commit), `world-child-reads.test.tsx` (the
  double against the plans), `tests/data/hooks.test.tsx`, E-P40 (two real pages).
- **D-11a-32** (review 26 of 1 November 2026, R26.1/R26.2, and its design assessment; §4.7, A10/A17) An online Rename or Unlink whose
  outcome is UNCERTAIN is resolved with its own request before anything about the person as read now is asked of a new command. What the
  page learns afterwards (its own commit read back as "Not linked to an account", a later version, another linkage, the synced new name)
  is not evidence of its outcome, and is never adopted into it:
  - the kept attempt (`memory.attempts`, `rename:<id>` / `unlink:<id>`) is chosen by what was SUBMITTED, made at the attempt's OWN version
    (`replayFor`): any unlink of the person, or a rename of exactly the same name (surrounding spaces ignored, as when it was sent). It is
    sent again EXACTLY (`replayOnline`: its key and byte-identical body, the online endpoint), never with a new key, never rebuilt from the
    person as read now, never through the queued content edit of an unlinked person;
  - the confirmation's Unlink and the form's Save need only the connection, compatibility and single admission for it; the linkage, the
    version and the form's binding read now are not asked (`unlinkBlocked`, the rename route and `stillBound` judge NEW commands only);
  - it stays reachable after its dialog or form closed (as after a remount): the header still offers Unlink and Rename while it is kept,
    whatever the linkage read now offers; a confirmation opened on it is bound to its version and says it is uncertain;
  - its answer settles it as any other: a receipt ends it (success); a refusal ends it (shown, the typed name kept), and what follows is a
    NEW command judged on the person read now (the existing conflict re-binding and stale-rename rules); uncertainty, offline, closed and
    a not_sent kept it unchanged;
  - a changed name is a new rename (bound again, then a new key); a later send's attempt is never overwritten by an earlier one's late
    outcome, and a quiet not_sent resend stops when the identity ended during the wait.
  The attempt lives in the page's memory only: a reload, a crash or another account forgets it (nothing is replayed or guessed; the
  person is read again), and another tab has its own. The backend answers a matching key and body with the original receipt before any
  new-command check. A shared field create keeps the existing one-attempt-per-body rule: its Home policy is the one the editor shows, so a
  changed primary household is a new body (a second create of the same id is refused by the server, never made twice). Tests:
  `uncertain-replay.test.tsx` (every arrival order of detail, summary and sync before the retry; later states; every answer; edits;
  offline; reopening), `replay.test.ts`. Revision 27 (review 28, R28.1): a page restored from the back/forward cache keeps that memory
  (the same heap) and must cross the session gate first. E-P50 (`bfcache.people-restore.spec.ts`, the full Chromium build, which alone
  restores a persisted page under test) leaves the page with an uncertain Rename, changes the linkage, goes Back and saves by a real click:
  the original key and body are sent. It found the closed gate still covering the page (the fix is in `src/styles/base.css`; see
  docs/session.md). E-P51 (`fixture.people.spec.ts`, three engines) is the reload: the attempt and the typed name are forgotten.

What is shown of unsent changes: a queued draft has no overlay until it is claimed, so the screens fold the bodies of the outstanding drafts
(`useOutstandingCreates`) over the cache (`model/project.ts`): a create is projected and marked "Not sent yet"; a later rename, field update or
archive is folded over its row. A projected row is never a base for a version-checked command.

## Limits

- The summaries are as fresh as their snapshot: up to the 60-second refresh behind a household or primary household change made elsewhere
  (the contract's own bound). Each invalidation re-reads every summary shown (a list step's join, the person's summary, the fields' step).
- Search in In Home / Shared with me / Not linked matches the names shown, this device's unsent renames folded over the server's (revision
  7); who is in each view is still the server's, so a new person not sent yet is in none of them.
- "Recent changes" (the drawn rail's second panel) is still not built: no history endpoint exists.

- Hidden form values (PRODUCT-DECISIONS-20261011 item 2): the field type switch keeps each type's value; the new person's hidden note keeps
  its text; a save sends only what applies, with no warning. A refused or uncertain save keeps everything. Inputs are locked while saving.
- The first note is checked as a text value before the save is admitted, as every other field value is (`valueProblem`, review 21): at
  most 4,096 characters and 8,192 bytes once encoded. A note over either limit stays as typed, with its error, and nothing is queued.
- The page memory (linkage answers, policies read, editor drafts) is per identity and dropped for any other identity; the held audience
  changes are not in it (they are durable, D-11a-12). An open, unsaved editor's typed text is page memory: it survives a remount, not an
  account switch or a reload (WEB-14a's Q4 recovery covers the update reload).
- A held change whose content was handed off is no longer a hold: its draft is an ordinary queued change, shown in Sync and discardable,
  and nothing on the person's page queues it again (D-11a-12c). A LEGACY copy (v 3) whose content admission was recorded may still have
  been queued; its Discard says so ("may already be queued. Check Sync").
- A new draft that FOLLOWS the save the edit began on (that save in flight, held for the defaults review, or after the audience was just
  changed) names it (`expectPredecessor`: its local id and the digest of the body the edit read), and the writing transaction writes the
  new draft only while that save is stored with exactly that body, raised the item from the base the transaction resolves, and is the
  save the new draft waits on (or was acknowledged). Otherwise nothing is written (`predecessor_changed`), the input is kept and the item
  is reviewed (review 12, R12.1). A claimed body is not frozen: a first claim that definitely did not send returns it to `queued`, where
  another page can edit it. The page's earlier check (`successorFollows`) is only an early answer.
- An edit in place applies only to the item's NEWEST outstanding save (D-11a-15; review 12): it asks `expectLatest`, and the writing
  transaction refuses it (`not_latest`) once a later save of the same item is queued after it, because that later save was built over
  the body being edited. The input is kept and the item is reviewed. The defaults review's confirmation goes on behind a later save only
  because it changes nothing but the top-level `defaults_revision` (the transaction compares the bodies); a content change never does
  (`delivery/handoffs/web11a-chain-latest-only-20261024.md`, SHA-256 `33c1109a…e56e45`).
- These guarantees hold at each writing transaction of one device's database. They are fixture/component and production-plan evidence
  over the IndexedDB double; independent native pages, real aborts and crashes are qualified separately (see the execution report).
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
| The review of a changed field: "This field changed since you opened it", "Current: …", "Who can see it now: …", "Yours: …", "Check who can see it first: that needs a connection"; after the sharing editor (D-11a-13b): "Who can see this field changed since you opened it", "Who can see it now is shown here once this field has finished syncing.", "Who can see this field changed since you opened it. Check the change above before saving yours.", "Who can see this field may have changed. It's checked again when you're online."; the rename's "This person changed since you started. Review the name, then save again." | `/people/$id/fields/$fid`, `/people/$id` | E-P14, E-P5, E-P46, E-P47 |
| Field types "Text, Amount, Date, Link, Yes or no, Choices, Checklist" and their inputs | `/people/$id/fields/new` | E-P3 |
| New field audiences "Use my defaults — {…}", "Only you", "{Home} · can view"; "Save it as Only you first; then choose who can see it…" | `/people/$id/fields/new` | E-P2, E-P3 |
| PPL-6 notes ("{name} won't see this field unless you share it with them", "{name} is in {Home}, so this sharing includes them. They'll see it if they can also see this profile.", "{name} is excluded from this field's sharing, so they won't see it.", "may be able to see it"; review 22 replaced "{name} is in {Home} and will be able to see it") | `/people/$id/fields/new`, `/people/$id/fields/$fid` | component tests, E-P45 |
| Held change copy "Kept on this device until then, even if you reload or switch accounts." and §9 row 2's caveat; "Waiting to change who can see {name}"; "Stopping the held change to {name}…"; the discard outcomes ("…was discarded. Nothing was sent.", "…had already changed…", "…may already have been made…"); "Couldn't keep this on the device." | `/people/$id/fields/$fid`, `/people/$id` | E-P6, E-P15, E-P16 |
| A held change without a recorded predecessor (review 12; v 4): "This held change to {name} was kept before Atlas recorded what it was typed over, so it won't be sent. Edit the field to review it and save it again, or discard it."; "The change to who can see {name} may already have been made."; "Who can see {name} was already changed as asked."; its failure "This change can't be sent as it is. Edit the field to review it and save it again." | `/people/$id` | component tests (`review-findings.test.tsx`, review 12) |
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

# WEB-11b: merges, links and requests (WF-PEOPLE-05/06)

Built on WEB-11a's public interface; backend `v0.29.0-rc.1` (API 0.29.0), whose Q16 reads (recipient-safe merge preview, server-backed sent
history) are in the pinned contract. Plan: `.agtx/plan.md` of the WEB-11b task (decisions D-11b-1 to D-11b-13).

## Routes and modules

| Route | Screen |
| --- | --- |
| `/people/requests` | WF-PEOPLE-06: "Waiting for you", "Sent", "New request" (two columns from 1280 px; below, "For you · N" / "Sent" tabs and a "New request" sheet) |
| `/people/requests/$requestId` | the recipient's review of a merge request (WF-PEOPLE-05, recipient) |
| `/people/requests/merge/$sourceId/$targetId` | a merge chosen in "Ask to merge" (WF-PEOPLE-05, sender) |
| `/people/$personId/duplicates/$otherId` | "Compare & merge" over the duplicates: `$otherId` merged into `$personId` (kept) |

Every dialog is route-addressed and keeps its state in page memory, so a `403` remount of the protected tree reopens it as it was (D-11b-1).
The four routes share ONE lazy component; `requests/screens.tsx` picks the screen by its own match. The screens are in the people chunk,
not a chunk of their own: a nested chunk importing the people chunk's modules was measured to split ten shared modules out of the fixture
entry (+5.3 KB of first-load gzip). The first load carries only the four route definitions (+86 B; see "Budget" below).

`src/features/people/requests/`: `screens.tsx` (route dispatcher), `RequestsScreen.tsx` (incoming, sent, tabs), `NewRequest.tsx` (the two
forms, the person picker, `DirectoryLookup` as a view), `MergeDialog.tsx` (sender and recipient), `entries.tsx` (People 01's "Requests"
entry and banner, the slots, the merged-alias note), `reads.ts`, `commands.ts`, `sender.ts`, `copy.ts`. Pure model: `model/requests.ts`.

## Decisions as built

- **D-11b-2 slots.** `requests/entries.tsx`, imported by `screens.tsx`, fills `peopleSlots.headerActions` (the merged alias's note, else
  "Ask to link…") and `peopleSlots.duplicateActions` ("Compare & merge") when it is evaluated; `slots.ts` is unchanged. "Ask to link…" is
  offered only for a person known (online `GET /people/{id}`) to be unlinked and known (its viewer-safe summary) to be the reader's own,
  not archived; while either is unknown it is disabled with "Needs a connection to check who controls this profile."; it is absent when
  linked. It opens the Requests page with the person chosen (page memory, not a search parameter: no first-load bytes).
- **D-11b-3/4 reads.** The incoming requests, each page of the sent history and both previews are read with the summaries' machinery
  (`useSummary`, keys `requests:incoming`, `requests:sent:<after>`, `requests:review:<id>`, `merge:<source>:<target>`), so they share its
  generation: any people command that was sent, any receipt or synced change, reconnection, the 60-second refresh and the page becoming
  visible read them again; a late answer of an earlier generation or another identity is dropped; offline nothing is shown. (The plan's
  separate requests generation and `invalidateRequests()` are therefore not needed: `sendOnline` already invalidates the generation they
  share.) A refusal the screens explain (`404`, `410`, `403`, `422`, `409`) is kept as the read's value with its reference; anything else
  is the view's failure with Try again. The page says "Checked at {time}" with Refresh. The count in People 01's header is the latest
  successful read ("99+" above 99; nothing while unknown, offline or failed). Sent: 50 a page in the server's id order, Next/Previous over a
  cursor stack, "Nothing on this page — there are more to check" for an empty page with a cursor, "No sent requests yet" only for a first
  page that is also the last; each state verbatim; Cancel only on pending; no device caveat (§4c, Q16 landed). Only the page SHOWN is
  kept (review 2's design assessment, DA-N1; Q9 allows three): Next or Previous lets go of it (`releaseSummary`), and Previous reads the
  earlier page again by its kept cursor (the cursors, not the pages, survive a remount). A retained uncertain cancel is kept apart from
  the page and is offered again when its row is shown again.
- **D-11b-5 sender.** From the B5 snapshot's household members, then the summaries this page read; otherwise "Someone outside your
  households" with "Atlas can't show who sent this request. Only accept it if you were expecting it." An account id is never shown.
- **D-11b-6 comparison.** The kept person's column first. A field's value only from a synced row with the same id at the preview's
  version or later (`useCachedResources`, which reads at most 100 ids: a preview of more than 100 fields shows the rest as "Not on this
  device yet"); "—" where a side has no such field; "Not visible to you" for a side the recipient cannot see. Conflicts: a label both sides
  have (trimmed, case-insensitive) gets "Both have a {label}. You'll keep both — …nothing is deleted."
- **D-11b-7 linkage.** Both linkages are read before the action is offered. Both linked: the cause, no action, Reload. One linked: its
  name, fixed, with "A profile linked to an account keeps its account's name.", sent exactly. Unknown: disabled, "Needs a connection to
  check who controls these profiles.", Try again. Neither: a choice of the two labels, the kept person's by default (kept in page memory).
  The recipient's review checks the sides it can see the same way; a hidden side cannot be checked ("The server checks when you accept.").
- **D-11b-8.** `merge` or `request_merge` is chosen only by the preview's `requires_approval`; the owner named from the other side's
  summary (`owner.you === false`), else "the other owner".
- **D-11b-9 outcomes and §4.7.** `requests/commands.ts` `runCommand`: one key per target (`request-link:<person>`, `merge:<s>:<t>`,
  `respond:<request>`, `cancel:<request>`); admission is taken synchronously at the press, then the body is prepared in the same turn (the
  `request_link` re-verification may answer later); a retained uncertain attempt is the only thing a press of its key sends, exactly; a
  different answer to a request whose answer is uncertain is refused ("Your earlier answer may already have been recorded. Try it again
  first."). Every press uses the comparison SHOWN: the preview object this render drew, and only while it is still the current read.
  What a command said is kept by key (`memory.requestReports`) for whichever row or dialog shows it now; an answer whose row is gone (a
  `404` after the list was read again) stays said above the list until closed. A command's COMPLETION belongs to the attempt it completes
  (revision 1, R1): `runCommandFrom` keeps the input an attempt was made of (its origin: the form's revision, the person and recipient; a
  merge's request-or-merge, name and owner) beside the retained attempt, and a replay completes with that origin, so a success names
  whom it actually went to and clears only the input it was made of. **The sender's name choice is owned by its edit** (review 4, R1;
  `requests/mergeName.ts`): every real edit of "Name after merging" stores a new frozen record for the ordered pair (`merge-name:<source>:<target>`,
  page memory only), even when it chooses the value already chosen. A fresh attempt captures the record current at its original
  preparation (a default never chosen is made an explicit record; a stale render's record sends nothing), takes the body's name from
  it and keeps it in the merge's origin; a replay keeps that capture. A success consumes the choice only while that exact record is
  still the pair's current one in the identity's current memory, then notifies readers: a choice made after the capture (in the same
  dialog while the command runs, in a reopened comparison of the pair through either entry, or before Try again) stays, and an
  unchanged choice is consumed by its own success. Failures, uncertainty and unsent attempts consume nothing. `PeopleRefusal` gains
  `expired` (`410`; no longer folded into `not_found`) and `capacity` (a people command's `503 slice_capacity`,
  `classifyPeopleAnswer(…, { capacity: true })`).
- **D-11b-10/11 New request.** Ask to link: a picker over `GET /people/summaries?scope=not_linked` (owner, not archived), 100 a page, at most
  three pages KEPT (Q9) and every later person reachable (revision 1, R2): "Show more" reads the window's next page while it has fewer
  than three, "Show the next people" starts a new window where it ended and "Show earlier people" returns (it reads that window
  again); the name filter applies to the window shown and says so while the window is not the whole list, and "none can be offered" or
  "no one matches" is claimed only for a whole list; the recipient from the shared `DirectoryLookup` as a view; at the
  press the person's linkage must be known unlinked, its version is `expected_version`, and the recipient is checked again with the exact
  lookup (the shared sharing client's `lookup`, not a second people client): only exactly one entry with the same id sends. Ask to merge:
  "One of your people" (owner) and "The same person" (any visible, not the first); "Compare" opens the sender's dialog. The two forms keep
  their values while the other is shown (PRODUCT-DECISIONS item 2); a success clears only the input it sent.
- **Pickers.** Each picker's read is keyed by its purpose, its mounted picker and its window
  (`picker:<scope>:<purpose>:<owner>:<start>:<pages>`): Ask to merge's two pickers read the same scope but keep different people (found by
  I-PPL19 against the released backend; MU-4135). The picker OWNS its read (review 2, R2; `useOwnedSummary`): only the current window's
  walk is kept, at most three pages of rows (every row read, kept or not), and a step to another window, Show more, a change of purpose
  or closing the picker releases the earlier walk; a page of it still on its way applies nothing and reads no further. `useSummary` lets go
  of a previous answer once its view shows another key.
- **An answer whose request is no longer listed** (answered elsewhere, withdrawn, or an uncertain answer that committed) stays said above
  the list with its reference until closed; an UNCERTAIN one also offers Try again, which resends it exactly (found by I-PPL23). The list
  above the requests is built from the reports AND the retained attempts, and Close is offered only once nothing is left to resolve, so
  dismissing a notice never hides an unresolved attempt (revision 1, R4).
- **Retained attempts stay reachable from the attempt** (revision 1, R1/R4): a row's Try again is offered on the action the attempt
  carried (an uncertain Decline is retried by its own Decline, never wired to Accept); a cancel that committed while its answer was lost
  keeps Try again on its now-Cancelled Sent row; an uncertain link request for a person the form no longer shows is listed above the form
  with Try again; while the form names another recipient, the form says Try again sends the earlier request, as it was.
- **People 01's "Requests" entry** is shown on every layout, whatever the count says (revision 1, R3); below 1280 px the "N requests
  waiting for you" banner is added when requests wait.
- **The comparison's columns are bounded** (revision 1, R5): fixed widths, and a value's text may break anywhere inside its cell (the
  shared value renderer's `break-words` kept a whole unbroken word as its minimum width).
- **A read refused `403` is remembered** for the page (revision 1, N1; D-12a-13): an ordinary `403` re-evaluates the session, which
  remounts the protected tree and reads the summaries again, so a preview that asked again by itself did so without end (found by
  I-PPL21 against the released backend: about 4,500 `POST /people/merge-preview` in 30 seconds for a pair the reader owns neither of).
  It is asked again only by the refusal's Reload (or a failed read's Try again); the recipient's review reads the lists again only for a
  `404` or `410`. The refusal is kept in `memory.requestRefusals` (display suppression for this page and identity, never a permission).
  **Only the key's newest answer counts** (review 2, R7): each dispatch of a key is numbered (`memory.requestReads`); an answer is obsolete
  once a later dispatch of the key has answered or the person asked again after it was sent, and an obsolete answer has no effect, so a
  late `403` never refuses a newer comparison or list. A newer definite answer ends a refusal an earlier dispatch remembered, and a read
  that finds a refusal while a newer dispatch is on its way waits for that answer. Answers that are not the server's (uncertain, not sent,
  offline, closed) change nothing. The owner is the newest answer rather than the summaries' generation because the `403` itself
  re-evaluates the session (and so invalidates every summary) BEFORE it reaches the read (`ordinaryCall`): a generation-owned refusal
  could be superseded by its own consequence, every time (the storm-ordering test; MU-4152). The value shown still obeys the generation.
  **Every explicit retry retires before it reads** (review 3, R7): a failed read's Try again is the request adapter's own `retry`
  (`useRequestRead` → `retryRequestRead`) for the sender's comparison (both of its routes), the recipient's review, the incoming list and
  every Sent page; it retires the key's refusal and every earlier dispatch and then makes the forced read, in one step, so a `403` sent
  before it can neither refuse that read nor come back after it. It is admitted only while this identity's memory is current, the page is
  online and the key's read is still failed: a second press of the same button does not make the first press's read (and its own `403`)
  obsolete. Tests: `request-retry.test.tsx` (Q1/Q2/Q8 and controls for each adapter), E-R20 (production session, sender and recipient).
- **D-11b-12 aliases.** An archived person whose value names `canonical_person_id` says "Merged into {name}" (a link when this device
  holds that person, else "another person"); WEB-11a's Archive/Restore is disabled for it with "This person was merged into another;
  restore isn't available." (the backend redirects `archive` of an alias to its canonical person).
- **D-11b-13 recovery** (`model/recovery.ts`): `people-request-link:<formId>`, `people-request-merge:<formId>`,
  `people-merge-name:<sourceId>:<targetId>`; pure, WEB-14a captures them.
- **Shared change:** `usePersonLinkage(null)` reads nothing and answers unknown (a hidden side of a merge).

## Limits (WEB-11b)

- Senders outside the reader's households, whose people the reader cannot see, cannot be named (no sender username in the contract; E-2b).
- `request_link` to an account deleted after the re-verification answers `401` (backend), which the session treats as an invalidation
  (E-2a). An over-200-resource scope answers `500`, shown as uncertain (E-2c). Both-linked and linked-name refusals happen only when the merge
  commits (E-2d); the sender is checked first, the recipient's accept can still be refused `409`.
- No push: the incoming list is as of its "Checked at" time (and the summaries' refresh rules).
- Self-link, `reference_account` UI and a "swap" of which person is kept are not built.
- Household invitation history (`/invitations/sent`) is WEB-12b's; no household screen changes here.

## Not claimed (WEB-11b)

Component tests and `tests/e2e/fixture.people-requests.spec.ts` are fixture evidence. The real-backend cases I-PPL17 to I-PPL23
(`tests/integration/integration.people.spec.ts`) are focused consumer evidence against the released `v0.29.0-rc.1` on SQLite, not BE-Q16's
acceptance and not integration acceptance; `integration_passed` stays false. No PostgreSQL, HTTPS, device or manual screen-reader evidence
(WEB-09d), no copy or visual approval (WEB-15).

## Budget

WEB-11b-FIXTURE-JS-20261102 (Kieran, 2 November 2026): one-off dist-fixture initial JavaScript ceiling 279,900 B for this candidate (its
route definitions, +86 B over HEAD's 279,783 B), baseline the final measured candidate; production unchanged.

## Additions and deviations for the connected-app checkpoint (WEB-11b plan §9)

Collected for WEB-15's sign-off; none is approved by being listed. Strings marked provisional are in `requests/copy.ts`.

| Item | Route | Reproduce |
| --- | --- | --- |
| "Sent" heading and states without "from this device"; "Nothing on this page — there are more to check"; "No sent requests yet" | `/people/requests` | E-R6, `requests-screen.test.tsx` |
| Mobile "Sent" tab without a count (the total is unknown without reading every page) | `/people/requests` (390 px) | E-R15 |
| "Requests need a connection."; "Checked at {time}"; Refresh; "Checking for requests…"; "Atlas couldn't check your requests." | `/people/requests` | E-R1 |
| Unnamed sender "Someone outside your households" and its caution | `/people/requests` | E-R2 |
| Link-row copy perspective corrected (E-3): "{sender} wants to link “{name}” to your profile … If you already have a profile, the two become one." | `/people/requests` | E-R3 |
| No "asked N days ago" (the contract gives only `expires_at`); time left "N days left", "N hours left", "Less than an hour left", "Expires soon" | `/people/requests` | E-R1 |
| Recipient review: "Not visible to you" column; the drawn "Accept is checked against what Kieran can see, not what you can" replaced by "accepting checks both what {sender} can see and what you can see now"; stale, expired and withdrawn banners | `/people/requests/$id` | E-R4, E-R5 |
| "Note (optional)" removed from Ask to link (the contract has no note) | `/people/requests` | E-R8 |
| Pickers ("Which of your people", "One of your people", "The same person", "Filter by name", "Show more", "Show the next people", "Show earlier people", the partial-window and partial-filter sentences), "Choose", "Compare"; the Ask to merge intro sentence | `/people/requests` | E-R8 |
| "Try again sends your earlier request to {username}, as it was."; "Your earlier request to {username} to link {person}." | `/people/requests` | requests-screen R1 |
| A refused comparison's "Reload" | `/people/$id/duplicates/$other`, `/people/requests/$id` | E-R17, E-R18, E-R19 |
| Sent's Previous and the picker's "Show earlier people" read the earlier page or window again ("Checking for requests…" meanwhile) | `/people/requests` | `requests-screen.test.tsx` (review 2) |
| Both-linked banner; fixed linked name with its sentence; "Not on this device yet"; "Loading the comparison…"; "Load the comparison first." | `/people/$id/duplicates/$other` | E-R9, E-R11 |
| Merged-alias note "Merged into {name}" and disabled Archive/Restore with its reason | `/people/$alias` | E-R10 |
| Outcome copy of D-11b-9 (capacity, out of date, already answered, couldn't confirm, answer uncertain first, account no longer exists) | all | E-R3, E-R5, E-R7, E-R8, E-R13 |
| People 01: "Requests" with its count beside the list header (every layout); "N requests waiting for you →" banner below 1280 px | `/people` | E-R1, E-R1b |
| The merge dialog uses the shared 440 px dialog (the drawn comparison is wider) | `/people/$id/duplicates/$other` | E-R15 |
| "Your answer was recorded." after an uncertain answer is tried again from above the list | `/people/requests` | `requests-screen.test.tsx`, I-PPL23 |
| Not built: self-link, `reference_account` UI, a "Swap" of the kept person | — | — |

# WEB-19: the activity timeline ("Recent changes")

The person detail's "Recent changes" section (D-19-1: after "Shared with", before "New fields start as"; only for a published person) reads
`GET /people/{id}/activity` of the released `v0.31.0-rc.1` (BE-PEOPLE-ACTIVITY, API 0.30.2; backend `docs/people.md` "Activity timeline").
It follows Kieran's timeline-first policy of 1 November 2026 (`delivery/handoffs/people-activity-policy-20261101.md`, SHA-256
`24e48c4dea8d320b535ec6e93dc42fed423f17d62af22b9a33082312e76bffe4`; authority `approval/people-activity-timeline-policy-20261101.json`,
SHA-256 `9528779562bdda2fe1c88e50ae9f66a1d4825786d1f594d4bfd590c58c721451`): metadata only, the items' CURRENT labels, actors named only
as the server names them (you, the person's current owner or linked account; anyone else "Someone else"), and no sharing rows.

## Modules

| Module | What it does |
| --- | --- |
| `model/activity.ts` | Strict parser of `PersonActivityPage` (exact keys, the eleven types and their fixed phrases, the members each type carries, `next_after` = last id, at most `limit` items, each id once). A body that breaks it is `uncertain` and shown as failed, never in part (D-19-9). |
| `api.ts` | `readPersonActivity(id, { after, limit })`: `404` is `not_found` (access lost), `422 invalid_value` is `invalid` (a cursor the reader may no longer follow). |
| `memory.ts` | `activity` (per route person, current invalidation only) and `activityDepth` (how many events were asked for: a count, kept across invalidations and remounts). |
| `activity/timeline.ts` | `walkActivity`, `readActivity`, `extendActivity`, `collapseActivity`: the reads and their rules below. |
| `activity/useActivity.ts` | The view: offline, loading (with the previous answer of the same person and identity), ready, failed, gone, merged. |
| `activity/describe.ts`, `format.ts`, `copy.ts` | The client's sentences (D-19-5), `en-GB` dates and times, and the provisional strings. |
| `activity/ActivitySection.tsx` | The section: a list of events (each with its sentence, tags and `<time>`), the notes and the controls. |

## Rules as built

- **Preview and steps (D-19-2).** The newest 5 (`limit=5`); "Show all changes" to 50; "Show older changes" 50 more each (from
  `next_after`), at most 500 (then "Showing the 500 most recent changes."); "Show fewer" back to 5 with no read. A failed step keeps what is
  shown, says "Couldn't load older changes." and "Try again" reads that same step.
- **One piece (D-19-3).** Every read walks from the first page to the depth asked and replaces what was held in one step; pages of two
  invalidations are never stitched. While a re-read is on its way the previous answer stays (busy), except that a field row whose field this
  device no longer holds is withheld at once (access changes arrive by sync). A failure, a `404`, offline, a merge note, another person or
  another identity drops the previous rows at once.
- **Freshness (D-19-4).** The timeline is invalidated with the summaries (`memory.invalidateSummaries`): any synced change, any receipt or
  online command, reconnection, households and the primary household, every 60 seconds while shown and visible, the page becoming visible.
  A re-authentication is a new epoch, so a new memory (P-11). An answer that arrives after an invalidation or under another identity is
  never applied. The entry is not released when its view unmounts: a remount (StrictMode's rehearsal, a `403`'s remount) joins the read on
  its way instead of asking again.
- **Access.** `404` shows "You can no longer see this person's changes." and nothing else. A `422` on a later page (a cursor that became
  hidden) restarts from the first page, at most three times in a row, then fails. The server applies current access per event; the client
  adds nothing and never infers a count of hidden events.
- **Order and identity.** The server's order (commit order) is kept, never re-sorted by `occurred_at`; an event id is shown once.
- **Merged alias (D-19-7).** If the answer's `person_id` is not the route's person, nothing is listed: "This profile was merged. Its changes
  are shown on the person it was merged into." with a link to that person when this device holds it.
- **Links (D-19-6).** A field is linked (to its editor) only while the server says it is current and unarchived and this device holds it as
  an unarchived field of this person; a profile merged into this person is linked while this device holds it; the person itself never is.
  Tags beside the time: "Archived", "Merged profile".
- **Honest coverage.** "Recorded since {date}." from `coverage_started_at` (never the oldest event), "Earlier changes weren't recorded."
  once everything since then is shown, and "Shows changes to what you can see now, with current names." for every reader. Nothing is made
  from this device's own saves: a queued change is not an event until the server records it.
- **No client persistence.** The timeline lives in page memory only: never IndexedDB, `/sync`, `localStorage` or the service worker (which
  precaches the build and routes navigations only: `tests/static/sw-activity.test.ts`). The server answers `Cache-Control: private, no-store`.

## Deviations from the plan, as built

- `releaseActivity` (plan §3.4) was not kept: releasing on unmount made StrictMode's rehearsal ask twice and dropped the read on its way;
  every invalidation clears the entry, and generation plus entry identity keep a late answer out.
- Tags are shown on the line of the time, not inside the sentence (a screen reader read "Old noteArchived" as one word).
- The "Show older" announcement goes through the page's one polite live region (`useAnnouncer`, lint R6), not a region of its own.
- Real-backend cases make their changes with harness commands (the UI paths that send them are I-PPL1 to I-PPL21's); a confirmed-empty
  timeline cannot occur on the real backend for a person created since coverage began (its `person_created` is recorded), so the empty
  state is fixture evidence only.

## Not claimed (WEB-19)

`tests/features/people/activity-*.test.*` and `tests/e2e/fixture.people-activity.spec.ts` are fixture evidence. I-PPL24 to I-PPL29 are
focused consumer evidence against the released `v0.31.0-rc.1` on SQLite, not integration acceptance; `integration_passed` stays false. No
PostgreSQL, HTTPS, device or manual screen-reader evidence (WEB-09d), no copy or visual approval (WEB-15). Hard deletion does not exist
(policy), so deletion is not applicable, not passed; value history is PEOPLE-VALUE-HISTORY's (unscheduled).

## Additions for the connected-app checkpoint (WEB-19)

Every string in `activity/copy.ts` is provisional; the People 02 mock's sharing row ("narrowed … to only you") is deliberately absent. The
rename sentence says "changed the name of {current label}" (or "renamed this person") and never presents the label shown as the earlier one.

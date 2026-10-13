# People: profiles and typed fields (WEB-11a)

The People destination (`/people`): who you have added or can see, each person's typed fields, who controls a profile, renaming and unlinking,
duplicate suggestions, and archiving. Built on the WEB-09a data layer (`src/data`) and WEB-12a's sharing editors (`src/features/sharing`).
Pinned contract: `v0.28.0-rc.1`.

## What the pinned contract provides (and does not)

- Projections of `person` and `field` sync like every resource. A projection carries **no linkage, owner or policy summary**. A person
  linked to another account syncs with `can_edit: false`, exactly like an ordinary read-only share.
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
archivedLedgerKinds.register({ id, order, Rows })      // add a kind to Settings → "Archived items"
registerPeopleCommands(registry)                       // the queue registrations; called once by the protected tree
type LinkageState, type PersonDetailSlots, type ArchivedLedgerKind
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
4. **Q4 recovery contexts** (`model/recovery.ts`): `people-field:<personId>:<fieldId|new:<formId>>`, `people-rename:<personId>`,
   `people-new:<formId>`. WEB-14a captures them; WEB-11a does not touch `src/lib/form-recovery`. A restore fills a form and never submits.

## Decisions (D-11a-1 to D-11a-16)

- **D-11a-1** Every field write is a typed `put_field`; `create_field` only for the new person's first note (SHARE-10 batch); `edit` only to
  rename a person whose profile is not linked.
- **D-11a-2** Linkage is read online (`GET /people/{id}`) and kept in the identity's page memory (outlives a remount; a `403`/`404` is remembered
  until Try again). Unknown linkage is shown as unknown, with the reason; it is never inferred from `can_edit`.
- **D-11a-3** List rows show what the contract supports: the name, initials, the cached field count, the pending mark, "Archived". The account
  text appears only for people whose linkage was read: the first 25 people shown are read, two at a time, once per identity. No "Visible to"
  column, no ownership filters (E-2).
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
  listed only under a person this device holds.
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
- **D-11a-13** A field's audience is named only after this page read its policy; otherwise the button reads "Who can see it?" and opens the
  policy editor, which shows its own owner-only state.
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

What is shown of unsent changes: a queued draft has no overlay until it is claimed, so the screens fold the bodies of the outstanding drafts
(`useOutstandingCreates`) over the cache (`model/project.ts`): a create is projected and marked "Not sent yet"; a later rename, field update or
archive is folded over its row. A projected row is never a base for a version-checked command.

## Limits

- Hidden form values (PRODUCT-DECISIONS-20261011 item 2): the field type switch keeps each type's value; the new person's hidden note keeps
  its text; a save sends only what applies, with no warning. A refused or uncertain save keeps everything. Inputs are locked while saving.
- The page memory (linkage answers, policies read, editor drafts) is per identity and dropped for any other identity; the held audience
  changes are not in it (they are durable, D-11a-12). An open, unsaved editor's typed text is page memory: it survives a remount, not an
  account switch or a reload (WEB-14a's Q4 recovery covers the update reload).
- A held change discarded in one page while another page's run is between its last check and its write may still queue its content there;
  that draft is an ordinary queued change, shown in Sync and discardable (the window is one transaction).
- A field update that changes type patches only the label in the overlay (the overlay's value merge is shallow); the screens show the saved
  value from the draft body.
- Rebuilds offered by the sync queue ("save as new") are built on the authorised current read's version and policy version.

## Not claimed

Fixture evidence (component tests, `tests/e2e/fixture.people.spec.ts`) is not integration evidence. The real-backend cases
(`tests/integration/integration.people.spec.ts`, I-PPL1 to I-PPL14) are focused evidence for a fixture-stage task on SQLite through the delaying
proxy, with the fixture test leader; `integration_passed` stays false (BE-Q1 and BE-CH1 have no completion record). No PostgreSQL, HTTPS, device
or screen-reader evidence (WEB-09d), no production-leader integration beyond the fixture case E-P2b, no copy approval (STAGED-ACCEPTANCE §5).

## Additions and deviations for the copy and visual checkpoint (plan §9)

Collected for the connected-app checkpoint after WEB-10a/10b/11a plus Settings; none is approved by being listed. Each can be reproduced in
the fixture spec named.

| Item | Route | Reproduce |
| --- | --- | --- |
| Linkage unknown: "Who controls this profile isn't known on this device." with its reason; rename reason "Needs a connection to check who controls this name" | `/people/$id` | E-P7 (one column, offline) |
| An unlinked person's rename queues offline; a linked rename stays online-only | `/people/$id` | E-P7 |
| Unlink confirmation: "Unlink your account from this profile?" and its body | `/people/$id` | E-P7 |
| "All / Archived" filter in place of the drawn ownership chips; no "Visible to" or "Account" column beyond what was read (E-2: NOT a routine deviation; see the decision below) | `/people` | E-P1 |
| No detail rail ("Shared with", "Recent changes") | `/people/$id` | E-P2 |
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
- **E-2** (finding 8) — DECIDED by Kieran: **WEB-11a is on an explicit dependency hold until BE-PEOPLE-SUMMARY (a backend viewer-safe
  audience/linkage summary; created, researched and in Planning on 14 October 2026) is accepted and shipped and its verified API types are
  adopted here.** The drawn "In Home / Shared with me / Not linked" filters, the "Visible to" column, per-row audience tags and the detail
  rail's "Shared with" need what a viewer may know of each row's audience and linkage without the owner-only `GET /policies/{id}` (a
  speculative `403` remounts the protected tree, D-12a-13). The remaining implementation resumes then, followed by an independent review of
  the complete result; nothing here substitutes unsafe per-row reads.
- **E-3** the list's duplicate banner (one read per person) and the Requests entry (WEB-11b) are not built; recorded for the checkpoint.

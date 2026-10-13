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
3. **`readOutstandingCreates`/`useOutstandingCreates`** (src/data) have the same name, signature and semantics in WEB-10a's plan: whichever
   card integrates second keeps the first's implementation and both cards' tests must pass against it.
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
- **D-11a-4** Lists are bounded chains of live pages (`useResourceList`, 100 a page): people 20 pages, one person's fields 10, the ledger 50 per
  kind; at the cap the view says "Showing the first {n} on this device". Sorted by name (base sensitivity, surrounding spaces ignored), then id.
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
- **D-11a-12** "Hold it as a draft until I'm online" is page memory ("Kept while Atlas stays open on this device", E-1). On reconnect: the
  field must still be at the content version the edit began on; the policy changes first (`applyPolicyChange`); only then is the content
  queued with the confirmed policy version. Every failure keeps the held draft with its reason, Try again and Discard.
- **D-11a-13** A field's audience is named only after this page read its policy; otherwise the button reads "Who can see it?" and opens the
  policy editor, which shows its own owner-only state.
- **D-11a-14** Online reads are this slice's own small reads through the stamped client, bound to the displayed identity; a read the session
  held back (`not_sent`) is asked again, bounded.
- **D-11a-15** A save while the item's previous draft is still queued and unsent edits that draft in place (its review block kept);
  an unsent create is edited in its own body.
- **D-11a-16** Master-detail from 1280 px; one column below. Dialogs are sheets below 768 px.

What is shown of unsent changes: a queued draft has no overlay until it is claimed, so the screens fold the bodies of the outstanding drafts
(`useOutstandingCreates`) over the cache (`model/project.ts`): a create is projected and marked "Not sent yet"; a later rename, field update or
archive is folded over its row. A projected row is never a base for a version-checked command.

## Limits

- Hidden form values (PRODUCT-DECISIONS-20261011 item 2): the field type switch keeps each type's value; the new person's hidden note keeps
  its text; a save sends only what applies, with no warning. A refused or uncertain save keeps everything. Inputs are locked while saving.
- The held audience change does not survive a reload (E-1). The page memory is per identity and dropped for any other identity.
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
| "All / Archived" filter in place of the drawn ownership chips; no "Visible to" or "Account" column beyond what was read (E-2) | `/people` | E-P1 |
| No detail rail ("Shared with", "Recent changes") | `/people/$id` | E-P2 |
| Pending marks "Not sent yet", "Sending…", "Waiting for the server", "Waiting for your review" | `/people/$id` | E-P2, E-P10 |
| "Showing the first {n} on this device"; "This value can't be shown on this device" | `/people` | unit tests |
| Field types "Text, Amount, Date, Link, Yes or no, Choices, Checklist" and their inputs | `/people/$id/fields/new` | E-P3 |
| New field audiences "Use my defaults — {…}", "Only you", "{Home} · can view"; "Save it as Only you first; then choose who can see it…" | `/people/$id/fields/new` | E-P2, E-P3 |
| PPL-6 notes ("{name} won't see this field unless you share it with them", "{name} is in {Home} and will be able to see it", "may be able to see it") | `/people/$id/fields/new` | component tests |
| Held change copy with "Kept while Atlas stays open on this device" and §9 row 2's caveat; "Waiting to change who can see {name}" | `/people/$id/fields/$fid` | E-P6 |
| Duplicates: "No similar names found so far. There are more people to check." with "Check more"; footer adjusted to page memory | `/people/$id/duplicates` | E-P9 |
| Settings "Archived items" placement, empty state, archived-person banner copy | `/settings/archived` | E-P8 |
| New person dialog (not drawn): name, "Who can see this person", "Add a first note" / "Don't add a note" | `/people` | E-P10 |
| People on tablet use one column (no tablet frames exist for people); the editor is a sheet below 768 px | `/people/$id` | E-P12 |

Escalations (material, to the operator; none blocks WEB-11a on the approved scope): **E-1** the held audience change cannot be durable with
the current foundation; **E-2** the contract cannot support the drawn list/table columns without unsafe owner-only reads; **E-3** the list's
duplicate banner (one read per person) and the Requests entry (WEB-11b) are not built.

# Calendars (`src/features/calendars/`)

*WEB-13a, 10 October 2026. UK English. The consumer contract for WEB-13b (local ICS import, anchors, review resolution) and the design record of calendar source and connection management and the manual refresh. Fixture-stage work: nothing here is integration or release evidence (`integration_passed: false`), and BE-Q22, BE-B8 and BE-CH3 still have no formal completion record although the pinned release ships all three. The pin is `0.28.0-rc.1` (backend `30fec6a`) since the 11 October merge of main; its calendar routes, service, refresh worker and the OpenAPI calendar paths are unchanged from `0.27.0-rc.1` (only reminder subscriptions changed), so the behaviour described here is the same, but evidence gathered against `0.27.0-rc.1` is not `0.28.0-rc.1` evidence.*

## What it is

The Settings registry's **Calendars** entry (`/settings/calendars`, owner `WEB-13`, order 60) opens "Calendar sources" (`wireframes/q21/calendar-journeys.html`). It lists the cached `calendar_source` rows a page of 100 at a time, then this device's creates that the server has not confirmed yet ("Waiting to be created"), and offers the two entry points the wireframe separates:

| Action | Route | Offline | Secrets |
| --- | --- | --- | --- |
| **Add source** (label, timezone) | the outbox: `create_source` on `/calendar-commands` | queued | none |
| **Manage → Timezone / Enabled → Save** | the outbox: `configure_source` without `connection` or `disconnect` | queued | none |
| **Link a calendar…** (label, timezone, URL, token) | direct: `create_source` with `connection` | "Needs a connection" | form memory only |
| **Manage → Replace…** | direct: `configure_source` with `connection` | "Needs a connection" | form memory only |
| **Manage → Remove…** | direct: `configure_source` with `disconnect: true` | "Needs a connection" | none |
| **Refresh** | direct: `POST /calendar-sources/{id}/refresh` | "Needs a connection" | none |

The route is chosen **per command, never per connectivity** (D-13a-2). A queued body is built by `createSourceRequest` or `configureSourceRequest`, which have no parameter that could carry a secret; the direct bodies are built by `linkCommand`, `replaceCommand` and `removeCommand` and sent through the session's stamped client for the displayed identity (`createCalendarApi`). A manual refresh is never queued (Q22) and nothing is sent on reconnect.

## Public surface (`src/features/calendars/index.ts`)

* **Builders** (`model/commands.ts`): `createSourceRequest`, `configureSourceRequest`, `importRequest` (below), the constants `CALENDAR_COMMANDS`, `IMPORT_ENDPOINT`, `CREATE_SOURCE`, `CONFIGURE_SOURCE`, and `sourceValue` (the projection's `{health, last_success (unix seconds), timezone, refresh_in_progress?}` read defensively).
* **Registry:** `registerCalendarCommands(registry)` (descriptions "Add a calendar" and "Change calendar settings", and `projectCreate` for a pending create), registered once at composition by `src/app/commands.ts` (`appCommands()`), which `protected-tree.tsx` passes to `DataProvider` (D-13a-5). `projectSourceCreate` is the projection itself.
* **Row actions:** `calendarRowActions()` is an APPEND-ONLY registry (`row-actions.ts`), like the Settings registry. WEB-13b adds ONE entry (`{ id, owner: "WEB-13", Render }`) for "Import events"; it renders after Manage on every row, cached and pending, with a `CalendarSourceView` (`id`, `label`, `row`, `pending`). Do not edit the rows themselves.
* **Direct client:** `createCalendarApi(session, account, epoch)` / `useCalendarApi()` (null while no identity is displayed): `command(command, key, live?)`, `refresh(id, key, live?)`, `liveSources(live?)` (at most 5 pages of 200, memory only) and `capabilities(live?)`. `live` is the caller's lifetime (its form is open, its run current, the page online): it is asked before EVERY admission of the request, the first and each one after a `not_sent`, and once it says no nothing more is sent and the answer is `closed`. Pass one from every caller (`useLive` for a form): the session's stamp alone cannot end a request whose screen or form closed while the same identity is displayed. Every answer is classified once (`CalendarResult`: `refused` with the Atlas `code` and, for `409 stale_refresh`, its `reason`; `uncertain`; `not_sent` after the bounded wait; `offline`; `closed` for `auth_state`, `closed` and a `stale` answer the session dropped) and every body is validated strictly.

## The import draft recipe (WEB-13b; case 2)

```ts
outbox.enqueue(importRequest({ sourceId, ics, from, through, localId }))
// endpoint "/calendar-sources/{id}/import", targetId = sourceId,
// targets: [{ resourceId: sourceId, role: "primary", basis: "resource", versionChecked: false, seedIfUntracked: 1,
//             requiresEdit: true /* WEB-13b: a known view-only source refuses the save as `denied` */ }],
// build: () => ({ command: { ics, from, through } })
```

* The source is an **unversioned primary target**, so the draft depends on the latest unsettled draft against the source (`depends_on`): a pending `create_source` (and any settings change queued after it) is sent and receipted first, and the dispatcher never sends the import ahead of them. Composition is never blocked: an import can be saved against a source that is still pending.
* The endpoint is resolved from `target_id` at dispatch (`resolveEndpoint`), and the body is stored canonically once, so every resend after a lost response is the **byte-identical** body under the **same** `Idempotency-Key` (the draft's `local_id`).
* A refused create takes its dependants with it (they are retained as `rejected` for the person, never sent).
* Evidence: `tests/data/outbox-calendar-extension.test.ts` (the production facade, plans and dispatcher over the double: held behind the create, routed, resent identically, a revision-0 receipt) and the real-backend case I-CAL9. The import screen, its 1 MiB / 730-day / 20,000-line / 256-component checks, its parse outcomes (7(c) import side, 7(e), 7(g)), anchors and case 3 are WEB-13b's.

## The manual refresh (D-13a-6; B8, CH3)

One press is one operation with one `Idempotency-Key`; every automatic retry of it and "Check again" reuse the key, and only a new press mints a new one. `model/refresh.ts` decides (`classifyRefresh`, `refreshStep`); `refresh-controller.ts` performs (one controller per mounted screen, built per calendar client so an identity change replaces it, disposed on unmount; memory only). Which press of a source may record or show an outcome is decided by admission across those controllers (`refresh-ownership.ts`, revision 6, below).

| Answer | Automatic action | Shown |
| --- | --- | --- |
| `200 {revision}` (0 included) | none | "Refreshed. New events appear after the next sync." |
| `409 refresh_in_progress` | same key at 5, 10, 20, 30 s (65 s, beyond the 60 s lease) | "Refreshing…", then "Still refreshing — check again shortly." with **Check again** |
| `409 stale_refresh` `generation_changed` (cause 4) | one live `GET /calendar-sources` read of `refresh_in_progress`; while true, again every 5 s for at most 75 s, then that refresh's own result if a read shows it wrote one | cause 4 copy, "The newer refresh finished: …", or "We couldn't confirm that the newer refresh finished — refresh again to check." |
| `409 stale_refresh` `lease_expired` (cause 5) | the same read; if it RETURNED the source with `false`, ONE same-key retry | cause 5 copy if it fails again (or if the read did not return the source) |
| `502 fetch_failed` (cause 2) | same key at 10 and 30 s | "Couldn't reach the calendar provider just now." |
| `422 connection_unavailable` (cause 1) | none | cause 1 copy with **Update connection** (Manage, Replace… open) |
| `503 integration_unconfigured` (cause 3) | none | cause 3 copy |
| `422 invalid_value` (cause 6a) | none | cause 6a copy with **Turn on** |
| `403` / `404` with an Atlas body (cause 6b) | none | cause 6b copy |
| `422 invalid_ics`, `unsupported_calendar_rule`, `unsupported_calendar_timezone`, `calendar_limit` | none | "This calendar's feed couldn't be read: …. Your existing events are unchanged." |
| `500`, `503 temporarily_unavailable` (CH3, 7(f)), `429`, network, abort, time-out, a `4xx` without an Atlas body | same key at 10 and 30 s | "Couldn't refresh right now — try again." |
| any other Atlas refusal (`409 operation_conflict`, `400`) | none | "We couldn't confirm this refresh." |

**Health is never evidence** (7(b), 7(d)): a `200` is success whatever `health` says, a `502` stays a failure whatever it says, and the row's health line is history ("Last success …", "Last refresh: …"). The live list's read-time `refresh_in_progress` (with, since revision 3, its `health` and `last_success` as result evidence) is read in two places only, both read-only: a run's recovery after a stale answer (B8 item 4) and the screen's observation when it opens (below, revision 4); the cache never holds the flag. Refresh code has no capacity-specific branch (7(c); a static test). Offline, an unmount or an identity change stops every run, including a request still waiting to be sent (`not_sent`): every send and live read is admitted only while its run is current. While offline no run starts, whichever action asks; **nothing resumes on reconnect**. **Check again** starts a request as Refresh does, so it is offered exactly when Refresh would be (online, a supported server, an editable source that is on) with the same reason beside it, and it keeps the run's key. A refresh that was in flight at a reload is not resent (D-13a-13): after the reload the live list says whether a lease is held, and the synced health says the rest (the observation, below).

**The live read is evidence only of what it returned (R9, revision 3).** `liveSources` walks at most five pages of 200 and says whether it reached the end (`complete`). A source the read did not return (beyond the walk, or no longer listed) is NOT `refresh_in_progress: false`: it permits no retry and ends the run with the cause's own copy, exactly as a failed read does. A source found in an incomplete walk is evidence. A newer refresh we waited for is finished only when a later read shows the result it wrote, compared with the FIRST read that saw it running (`finishedSince`): the server writes a refresh's result in the same transaction that releases its lease, so a success moves `last_success` on, and a failure records its cause in `health`. The flag turning false alone is also what a lease that lapsed with no completing write looks like, and a settings change clears the lease and writes only `pending`; a source missing from the later read says nothing. Those runs end "We couldn't confirm that the newer refresh finished — refresh again to check." (provisional), with no automatic retry: a new press is a new operation. The live list keeps `last_success` (memory only) for this comparison; it is never shown as the outcome of our own press.

**Refresh activity seen when the screen opens (D-13a-13; revision 4, R10).** A fresh document has no run: the refresh controller and its same-document memory (`memory.ts`) live and die with the document, so a reload, another tab or a return to the screen would otherwise show nothing while a refresh still holds the lease. The screen therefore OBSERVES activity separately from its own runs (`model/observation.ts`, `observation-controller.ts`); the three authorities stay apart: a run owns its key and its answer, the observation owns what the live list showed, and the cache owns history and which rows are shown.

* **What it reads, and when.** One observer per VISIT of the screen (`visit.ts`, revision 5, below), which a mounted screen attaches to. Once the server is known compatible and the page is online, it reads `GET /calendar-sources` (the same bounded walk: five pages of 200) for the sources the current page of the list shows, cached rows only (no pending create, nothing without a database, nothing while the cache gate is closed). One walk serves every source; walks never overlap. A source listed later (another page, a create the cache now holds, the cache gate opening again) is read at once, or with the next walk if one is out; an ordinary re-render reads nothing. Reading is not acting: a view-only, turned-off or calendar-links-off source is observed too, while its actions keep their own rules.
* **What it shows.** A source the read returned with the lease held shows "Refreshing…" (the same words as a run) and holds Refresh back with that reason, with no **Check again** (an observation has no run and no key). It is read again every 5 s until a read returns it not holding the lease; then the row shows its synced history again, with no success claimed (the flag going false is also what a lapsed lease or a settings change looks like). A source the read did not return (beyond the walk, or no longer listed) or a failed read is unknown, never idle: nothing is shown unless it had been seen running, when the row says "We couldn't check whether this calendar is still refreshing." (provisional) and Refresh is available again. The same happens when a source is still running 75 s after its first walk: reading stops, and a read still out then is not waited for (no later page of it is admitted, and its answer changes nothing).
* **What it never does.** It mints no key and sends no refresh, command or draft; it writes nothing (no cache, storage or form); a live answer never overrides the cached row, its version or its settings. Going offline (or the server ceasing to be compatible) ends it for good, and coming back online reads nothing more until the screen is opened again; leaving the screen or another identity drops a read still out, while a remount of the tree continues the visit (below). A press of Refresh or **Check again** on this screen ends that source's observation before its request is sent (`onBegin`), so a read made before the press cannot change what the run shows. An ended run kept across a same-document remount is shown beside a later observation, never as its continuation.
* **What it is not.** Not continuous detection: a refresh that starts after the screen's reads have settled is seen only when the screen is opened again (or the run's own recovery reads). Not exact: the API names no writer, so a lease held by another tab, another device, the server's scheduled refresh or an import looks the same. Not unbounded: a source beyond the five-page walk is unknown. These are the limits of the read-only contract (design assessment C1–C5).
* Evidence: `tests/features/calendars/observation.test.ts` (the model and the observer, its clock and timers driven by hand), `tests/features/calendars/observation-screen.test.tsx` (the production screen over the double), native E-CAL4 "a refresh holding the lease when the screen opens" in Chromium, Firefox and WebKit (a reload with the lease held and its idle and no-reload controls, another tab with its data hints held, a press over a held read, offline, leaving the screen), and the unit and real-engine mutants MU-1397 to MU-1413 (five re-anchored in revision 5 with their meaning unchanged).

## The online-only forms (D-13a-7)

* The URL and token are `data-atlas-sensitive`, `autocomplete="off"`, typed `url` and `password`, and **uncontrolled** (React mirrors a controlled input's value into its `value` attribute, which a DOM snapshot or error report would carry). They live in the form's state alone and leave with it on success, close and unmount; a reload requires re-entry (Q22). `buildSnapshot` refuses them (strict mode throws, production drops them), and WEB-14a's recovery (revision 37: `recovery.ts`, `lib/form-recovery/editor.ts`) keeps only `label` and `timezone` (Add source, Link) and the edited `timezone` and `enabled` (Manage), never the connection fields.
* Each submission is a **pair** `{key, body}` pinned per attempt (`model/submission.ts`): **Retry** resends the identical pair, and any edit of a field mints a new pair (and, for Link, a new source id). For Replace and Remove, Retry after an uncertain attempt resends THAT pair **whatever the cache has learnt since** (a newer version, other settings): the backend looks the key up before it checks the version, so an attempt that landed returns its receipt, while a new key against the newer version would apply the change a second time. Only an edit or a conflict makes the next attempt a new operation, built from the row as it is then. The wait before the next Save (below) is measured from the version the operation was built on.
* A form's request is admitted only while the form is open, under the client it was opened with, online, and still permitted by the form's own current rule (`useLive`; revision 2 adds the rule: Link's availability, or Manage's current Replace/Remove enablement): closing the panel or Manage, another identity, going offline, or the source gaining a waiting change or becoming view-only during a `not_sent` wait sends nothing more (offline says "Needs a connection"). A request already sent may finish after its form has gone: its answer is recorded where it must be (a connection change's version, the announcement) but closes nothing on screen, where another form may be open by then; only the panel that sent a Replace or Remove closes on its answer.
* **Entry is online only too** (Q22; revision 2, R8). Offline, the URL and token fields of Link and of Replace are disabled with "Needs a connection" as their accessible description, and a change that arrives anyway is put back; what was entered before stays in the open form, and nothing is sent until the person asks again once back online. The non-secret fields (Link's label and timezone, Manage's Timezone and Enabled) stay editable offline.
* **Every route that acts is admitted by the rule that disables its control** (revision 2, R7). The Enter key submits a form implicitly: Manage's Save handler checks the same `manageActions` result as the button (and a synchronous latch, so two submissions before a render act once), and a disabled Save stays the form's submit button, so a browser does not submit the form by Enter at all. Add source, Link and Check have the same latch. While a Replace or Remove is being sent, Save waits ("Waiting for the connection change to finish"): its answer decides the version the next change is built on.
* The backend validates a connection (DNS, its outbound rules, a worker slot) **before** it looks the key up, so a refusal that follows an uncertain attempt of the same pair (`502 fetch_failed`, `422 invalid_endpoint`/`outbound_denied`, `503`) proves nothing about that attempt and stays uncertain. For Link, **Check** reads the live list: if the source id is there the create committed; if not (and the list was complete), Retry is safe. Replace and Remove have no such check (the id exists either way); Retry with the same pair is idempotent.
* A `409 conflict` (stale `expected_version`) shows the wireframe's conflict copy and the next attempt is built from the row as it is now, never resent blind. A `403` is re-checked by the session, which closes Manage with its panel (the protected tree is remounted, below); the row (or the list, for Link) then says "You no longer have access to make this change." with **Dismiss**, and nothing that was typed is kept.

## Queued and online changes never interleave (D-13a-8)

Replace and Remove restate the current timezone and enabled from the merged row and send the cached `expected_version`. They are unavailable while the source has unsettled drafts ("Send or discard this calendar's waiting changes first") and until those drafts have been read. After one succeeds, Save (a queued settings change) waits, in this screen's memory, until the cache's version passes the one the command was based on ("Waiting for your last change to sync"): an online change does not raise the outbox's version record, so a queued change built before the cache caught up would conflict. After a reload such a change takes the generic `version_conflict` path: **Review** on the row opens Manage from the current row and Save there **supersedes** the conflicted draft (D-13a-12).

Manage's Timezone and Enabled start from the values the person last asked for: the newest waiting settings change **that still applies** (queued, sent or receipted; never one that needs a decision) over the row, as the row shows them (`displayedRow`). It is chosen among the settings changes alone (`latestOfKind`), so a later draft of another kind (an import) never hides it; the row uses the same choice. An untouched field follows them; an edited one keeps what was typed. Save waits until the source's waiting changes have been read ("Checking for changes waiting to send…"), so a second change made before the first is sent restates the first's values instead of reverting them, and saving the waiting values again is "Nothing to save."

**A Save is written only from what Manage showed** (revision 2; the design assessment's A1). The values shown, the outstanding drafts and an observation token come from ONE read of the source (`useResourceView`); Save states that observation (`EnqueueRequest.observed`), and the enqueue or supersede transaction, which also chooses the version and the dependencies, reads the same facts again and writes the change only if they are unchanged. Otherwise nothing is stored, the form says "Not saved — this calendar changed while you were saving. Check the values and save again.", the untouched fields show the new values, the edited ones keep what was typed, and saving again is the person's decision: another tab's change is never silently undone by a value this tab showed before it, and nothing is resubmitted on the person's behalf. The token is conservative (a draft being claimed for sending also changes it). A retry of a save that was made (its answer lost) is still recognised by its local id first.

## What an open Manage shows, and on what authority (`model/visibility.ts`)

Revision 2 (R6): the row Manage was opened with is context for its first moment only; from then on the source's lifecycle, read in one transaction, decides (`sourceAuthority`). A **pending** source (this device's create, not cached) is shown from its create **as it stands now** (an edit of the queued create shows). When the create is published, Manage stays open and is **promoted** to the cached source: its untouched fields follow the published values, the cached rules apply (Replace/Remove become the source's, `can_edit` governs Save), and from then on it is cache content and never falls back to the create, even if the create is still in the outbox. A pending source whose create leaves the outbox without the cache holding it (discarded, superseded, or receipted and not published to this account) closes as "can no longer be shown". Until a read has answered, or while the read of a never-cached source is unavailable, the last row shown stands in and nothing may be saved or sent. A source that becomes view-only while Manage is open stops Save and the connection actions with the view-only reason.

A cached source's Manage is shown only while the list could show it: the cache gate is open and the source's own read holds it. When the cache is being brought up to date (invalid, unverified, a recovery under way) or the source leaves the cache (removed, or access to it was), Manage closes, with any connection panel inside it, and the announcer says why ("Manage closed while your calendar sources are brought up to date." / "Manage closed: this calendar source can no longer be shown."); it never falls back to the row it was opened with. An uncertain Replace or Remove in a panel closed this way is not retried: the source's state is read again when the list returns. Offline with a valid cache Manage stays open, and it follows a newer version of its source. A pending source (this device's create) is not cache content and is shown from its create.

## What the screen reads

`useResourceList({kind: "calendar_source"})` (a page of 100 with Show next/previous), `usePendingCreates("create_source")` (this device's creates the cache does not hold: a queued create has no overlay until it is claimed), one `useOutstanding(id, "configure_source")` per visible row (exact counts by status, the newest draft with its body, and the newest settings change that still applies, which is what the row shows as "Queued — will apply once synced" or "Saving — will confirm on next sync"), `useResourceView(id, {create, settings})` for an open Manage, the cache gate around the cached rows, `useStatusInputs().online`, `session.compat` (B2: the direct actions need `supported`), and `GET /notification-capabilities` once per visit while online (D-13a-10; revision 5: a read never sent is made by a later mount, one sent is not made again within the visit; `calendar_links: false` disables Link and Replace with the cause 3 copy; unknown pre-disables nothing). "Add source" needs the account database (D-13a-9): without one it says "Available once this device has synced"; Link works without one.

## A `403` remounts the screen (`memory.ts`)

An Atlas `401` or `403` is classified by the session, which closes the protected display and opens it again (session matrix 3.6.2), so the Calendars screen, its refresh controller and any open form are unmounted by the very answer they were waiting for. Measured natively before the fix: a refresh refused `403` (cause 6b) ended with nothing shown. `identityMemory(account, epoch)` keeps, in memory only and per displayed identity, the ENDED refresh runs (their outcome and key, so "Check again" still reuses the key) and the words of a form's access refusal ("You no longer have access to make this change…", shown on the row or above the list with **Dismiss**). An answer that arrives after the controller was disposed records its outcome there if it ENDS the run and no newer press of that source was admitted since, and performs nothing (no send, no read, no wait); a run that was only waiting to retry ends with nothing remembered, and an answer that does not end its run is dropped (nothing is resumed). The remount can finish before that answer arrives, so the controller of the screen mounted by then shows the recorded outcome as it is recorded (revision 5; found by the native E-CAL14 Q4 case, where the screen then showed nothing). Taking another identity's memory (another account, or a new epoch) drops every other and revokes its refresh ownership, so a late answer cannot be shown under the new identity.

**Who may record a refresh's outcome is decided by admission (revision 6, R12; design assessment C1).** Controllers count their own runs, so they cannot order runs across screens: the review pressed Refresh A (held), went to Settings and back, pressed Refresh B (a new key) refused `422 invalid_ics`, then released A's success, and the row and the memory switched from B's failure to A's "Refreshed". `identityMemory(account, epoch).refresh` (`refresh-ownership.ts`) therefore keeps, per source, the latest ADMISSION:

* Every admitted execution, a press of Refresh and every **Check again** (which reuses the run's key), `claim`s the source with a new local ticket before anything is sent (before the observer's yield and the request). The ticket is opaque and is never the wire key.
* The latest ticket owns the source for as long as the identity's memory lives: an older ticket can never record or show an outcome again, not when the newer run ends, goes offline, is forgotten or loses its screen, and not when the person leaves the screen. Only the owner's ended run is remembered and shown by a screen built later; ordinary and late answers alike pass the same check, and a controller shows a run only while its ticket owns the source.
* With no newer press, an older run's late terminal answer (a success, a refusal, the end of its successor check) is still recorded and shown by the screen mounted then: the legitimate late outcome is kept. Nothing is resumed or sent for it.
* It is document memory: a reload or another tab has none, and this tab never infers another tab's key or ownership from the live list. It never holds a form's values, so a secret is never kept across the remount: the person re-enters it (Q22).

**What the screen reads by itself is read once per VISIT (revision 5, R11; design assessment C1–C4).** The screen makes two automatic reads, the live list (the observation above) and the capability. Made per mount, they formed a loop: a read refused `403` remounts the tree, the new screen reads again, is refused again, and so on for as long as the server refuses, with the observation's time limit restarting each time (the review measured seven list reads in three seconds in each engine). Both reads therefore belong to a visit (`visit.ts`), kept in `identityMemory(account, epoch)`, memory only:

* **A visit starts** when the screen is mounted and none is current, and **ends** when the DOCUMENT leaves the screen (revision 6, R13; design assessment C2): the document's path stops being `/settings/calendars` (with or without a trailing slash). That is observed by the document, not by the screen or its router (`src/lib/route-changes.ts`, installed once by `createProtectedTree` before the first router: `popstate` and every `pushState`/`replaceState`, whoever calls them), and counted by the calendar slice's `VisitBoundary` (`visit.ts`), which disposes the visit at the departure as it happens. So Back pressed while the session's protective closure has the tree unmounted ends the visit exactly as Back on the screen does, as does leaving and coming back before any screen is mounted again (revision 5 noticed a departure only at the screen's own cleanup, so the review's Back during the closure left the visit, and its yielded source, in place). A same-document remount at the same address (the session's re-check of a `401` or `403`, a router made again, React Strict Mode) only detaches the screen and attaches the next one: the visit goes on; so does a change of only the query or the fragment. A new document (a reload, another tab) has no visit and reads afresh, as does opening the screen again after leaving it. Ending a visit ends only what the screen reads by itself: the refresh ownership above is the identity's and outlives visits. Another account or a new epoch disposes the old identity's visit with its memory, so a read still out for it changes nothing. Focus, visibility, coming back online, a compatibility notification and a re-render start nothing.
* **The observer outlives its screens.** Its entries, their 75 s limits (from the first walk that included them), their final states and a read still out all belong to the visit. A walk's answer is the visit's whichever screen is attached when it arrives, so the remount it causes never reads again: a first read refused `403` is one read in all, and a refresh seen running whose 5 s poll is refused is two. While no screen is attached nothing is read (a walk's next page or not-sent retry is declined), and a busy source is polled again 5 s after the next screen attaches, within its first limit. **A read that SENT nothing is not consumed**: a walk whose admission was declined, or that the session refused at its cover before the send boundary (the client's `closed` with `unsent`, e.g. while a new document's tree is still being mounted), leaves its sources unread; the next screen reads them once, and the same screen never retries them (no loop). Only an answer the server gave (or a `closed` after sending) is final. Found in revision 5 by the native two-tab case in Firefox, where a new tab's first read was refused at its cover and the tab then showed nothing. A source the SAME screen stops listing (the cache gate closing, another page) keeps what was observed; listed again by that screen while still observed it is read at once (the cache-recovery read), and once final (idle, unknown, refused, offline, at its limit) it is not read again within the visit. A press yields its source for the visit.
* **The capability is read once per visit while online.** It is taken before the request is made, so a mount while it is out does not read it again; its answer, a refusal or a failure included, is the visit's (a failure is unknown, which pre-disables nothing). A read that was never SENT (offline, the screen gone before it was admitted, the session's `not_sent` hold throughout, or `closed` at its cover) leaves it unread for a later mount, and a read out across a remount asks the screen mounted now whether it is still wanted.
* **The protective closure is unchanged.** The remount still closes Manage, its connection panel and any typed value, secrets included (the session's required behaviour); nothing of a form is kept to survive it (an app update's recovery, WEB-14a revision 37, is a separate guarantee: docs/pwa.md). The visit holds no form, secret, key, row or setting, and nothing is persisted.
* Evidence (revision 6): `refresh-ownership.test.ts` (both result orders, running, finished, offline, forgotten and unmounted successors, an older late live read, other sources, the same-key **Check again** ticket, another identity), the revision-6 cases of `visit.test.ts` (departures attached and detached, leaving and returning, terminal visits, ownership untouched), `tests/lib/route-changes.test.ts` (raw and router writes, Back/Forward, routers made after the record and torn down) and of `visit-screen.test.tsx` (the production screen through the document's real history: a press refused `403`, the tree closed, Back to Settings while closed, then Calendars, with its same-address control; Back/Forward, raw writes and same-path controls while unmounted; mounted Back; the late-answer orders), native E-CAL15 in Chromium, Firefox and WebKit, and the revision-6 unit and real-engine mutants.
* Evidence (revision 5): `tests/features/calendars/visit.test.ts` (the visit and the capability read), the revision-5 cases of `observation.test.ts` (remounts while a read is out, in either cleanup order and with Strict Mode; answers while detached; no admission while detached; limits not restarted; re-listing by the same and by a new screen; a yield kept), `visit-screen.test.tsx` (the production screen remounted at the same address and navigated away and back), native E-CAL14 in Chromium, Firefox and WebKit through the real session and protected tree (first read refused `403` with its `200` and `503` controls, a poll refused `403` with Manage edited or Replace's URL typed and its `503`/idle controls, the capability refused `403`, a manual Refresh refused while the screen's read is held, leaving and returning, and an invalidating `403`), unit mutants MU-1414 to MU-1425, MU-1429 to MU-1437 and real-engine mutants MU-1426 to MU-1428.

## WEB-13b: local ICS import, task anchors and review items

*WEB-13b, 25 October 2026. Fixture-stage work (`integration_passed: false`; BE-Q22, BE-B8 and BE-CH3 still have no completion record). The
current pin is **`0.29.0-rc.1`** (backend `4396c99`, `contract-pin.json`; the WEB-13a paragraph above records its own, older pin). Copy
marked "provisional" in `copy-import.ts`, `copy-anchor.ts` and `copy-review.ts` is collected for the working-app checkpoint and WEB-15.*

**Import** (`model/import.ts`, `ImportDialog.tsx`, `ImportDropZone.tsx`, `ImportsPanel.tsx`, `import-action.tsx`, the one row-action entry).
"Import events" on a source row (cached or pending; unavailable on a view-only or turned-off source, with the reason) or the page's drop
zone ("browse" is a real file control; dropping is an enhancement) opens the dialog: the file is read and checked **on this device**
(UTF-8 bytes ≤ 1 MiB, Rust `str::lines` before unfolding ≤ 20,000, `VEVENT`s with overrides ≤ 256 on the parser's content lines
(below), a fatal UTF-8 decode, a
`YYYY-MM-DD` window with years 1900–9999 and `0 ≤ through − from ≤ 730` days inclusive, the JSON body ≤ 2 MiB), and Import stores ONE
draft (`importRequest`; offline included; a synchronous latch; the same press after a local refusal reuses its identity; a QUEUED
import's identity is spent, so a later Import is a new operation). Only the latest file chosen can be imported: choosing another forgets
the previous one at once, and nothing is admitted (the button, Enter, a direct submission) until it has been read (revision 1, R1). A save
settles only what it submitted (R3): a file, source or window changed while it was being stored keeps the dialog open with the newer
choices and "Import queued as it was when you pressed Import. Your newer changes are still here." The drop zone's dialog offers one page of
cached sources (100) with "Show previous/next calendars" (`source-pages.tsx`, R4), the chosen one staying an option while another page is
shown. The file's text lives in page memory only, in the dialog's editing session (revision 6, R7, below), never in storage, a trace, a log, the
address or another tab. The **Imports** panel lists this device's outstanding imports from draft HEADERS only
(`useDraftHeaders` / `readDraftHeaders`; an import's body is never read for a list, and `readOutstanding` asked for a kind no longer
loads a newer draft of another kind: E6): Queued, Sent (trying again), Sent — couldn't confirm yet (link to the queue), Import accepted,
refused with its reason (Dismiss), or the capacity words (link to the queue). No count of imported events is ever claimed.

**Which lines are components** (revision 14, review 15 R12, family `calendar-import-logical-line-validation`). The byte and line
bounds measure the decoded text exactly as stored, before unfolding. Components are then recognised as the server's parser reads them:
`ical` 0.11.0's `LineReader` and `PropertyParser`, ported in `model/import.ts`. A line starting with a space or tab continues the one
before it, with that character removed. Empty lines are skipped, even inside a fold, and trailing white space (Rust's `White_Space`, not
JavaScript's) is trimmed. A value loses every leading `:`, and parameters (quoted ones too) come before it. `BEGIN:` folded onto the
next line, `BEGIN:VEVENT ` with trailing white space, `BEGIN::VEVENT` and `BEGIN;X-A=1:VEVENT` therefore each count as one event, as
they do on the server. Text inside a property (`DESCRIPTION:… BEGIN:VEVENT`, folded or not) does not count. After the calendar's END,
the parser stops at a whitespace-only line and ignores the rest, so the count stops there too. This remains a pre-check, not a parser:
names and values are still compared in upper case, the header is recognised anywhere, and counting continues where the parser would
refuse the file. So a pre-check can refuse a file early or let the server refuse it, but it never refuses a file the server accepts or
passes one with more than 256 events. The text is never normalised: what was checked is what is stored and sent. Evidence:
`tests/fixtures/ics-parser/ical-0.11.0.json`, 65 recipes and the pinned parser's own answer for each, written offline by
`scripts/generate-ics-parser-corpus.mjs` (`--check` rebuilds and compares), asserted case by case in `import-model.test.ts`. The
rendered paths (the row's chooser, the drop zone's Browse, a page drop, a replaced file still being read) are covered in `import-ui.test.tsx`
"review 15 R12". This is reference evidence of the parser, not a backend import run.

**How much work the check does** (revision 15, review 16 R13, family `calendar-import-parameter-scan-complexity`). The check runs
synchronously on the page's main thread after the file is read, so its work must grow with the file. The parser looks for `;`, `:` and
`,` across the whole rest of a line for every parameter value; copying that made a line of many parameters quadratic (a 256 KB file
blocked Firefox for 4.6 s). The port keeps the parser's rules (where a name, a key, a raw or quoted value and a list end; the ten-value
limit of a list; every leading `:` removed) but scans with one position that only moves forward, each search stopping at the parser's
nearest delimiter. Ordinary properties and `BEGIN`/`END` lines are scanned alike: no parameter is capped and no accepted file is
refused. `import-model.test.ts` "review 16 R13" counts the code units read and written (`tests/support/work-meter.ts`) and holds them to
22N + 16P + 16 for a text of N code units in P lines, a bound worked out from the algorithm, with SUMMARY, BEGIN and END parameter
shapes at n, 2n and 4n and Review 16's 1 MiB files. The corpus adds the parameter rules the scanner keeps, each answered by the parser.

**The import's answers on the current wire** (`answers.ts`, the dispatcher's seam in `src/data/engine/outbox-dispatcher.ts`):

| Answer | Treatment |
| --- | --- |
| `200 {revision}` | receipt |
| `409 refresh_in_progress`, `503 temporarily_unavailable` (the two calendar permits are taken first, before the receipt lookup), `500`, `429`, a gateway `5xx` without an Atlas body, network | the generic same-key retry (uncertain; reload-safe) |
| `409 stale_refresh` (`generation_changed`, `lease_expired`), `502 fetch_failed` with an Atlas body (the parser's `InvalidValue`: a title over 300 characters, a bad window date) | **terminal** (`rejected`), by the two handlers `registerImportAnswers` adds for import drafts only |
| `422` (`invalid_ics`, `unsupported_calendar_rule`, `unsupported_calendar_timezone`, `calendar_limit`, `invalid_value` for a turned-off source), `403`, `404`, `400` | the generic rejection |
| `503 slice_capacity` | blocked for the person (never "your account is full") |

The seam: in the dispatcher's generic-retry branch an Atlas-coded answer consults the conflict registry, and only `reclassify` as
`rejected` is honoured. The handlers are registered into the PAGE HOST's registry by `appCommands()`, which `createProtectedTree` calls
before boot starts the page's leader, and into the fixture harness's own registry. A rejected import rejects the source's later queued
drafts (`dependency_rejected`), the foundation's chain rule; the panel says so and nothing is resent.

**Anchors** (`model/anchor.ts`, `AnchorDialog.tsx`, `pickers.tsx`; the surface for other slices is `anchors.ts`). The panel edits a
reference (an event series chosen from the source's cached events, or a person's date field from the cache), an offset (whole days
−366..366 at an optional `HH:MM` sent as `HH:MM:SS`, or ±31,622,400 seconds for a TIMED event series only), weekdays (1 = Monday) and, for
an event series, a title filter (1–100 bytes). The event picker pages its calendars as it pages events (R4). An anchor's own time is sent
EXACTLY (seconds included) until the person edits or clears the time field (`keptTime`, R5, the task correction's rule). A done save
closes the panel only when nothing was edited in it meanwhile; otherwise the newer input stays (hidden fields included) with "Saved as it
was when you pressed it…", and the next save is an ordinary, new change after it (R3). Every field keeps its value while hidden; Save sends only what applies; a year-less date
field always repeats annually; a task that repeats on its own schedule cannot be anchored. A new task carries its anchor in `create_task`
(no projected first occurrence: the server makes none from the schedule). An existing task's "Calendar anchor" section (task detail,
after the day) reads the binding ONLINE once per visit and identity (`tasks/detail/anchor-binding.ts`; a refusal is kept when it arrives;
offline it says "Binding details need a connection." and the rest of the task stays as the cache shows it) and queues `set_anchor` on the
task's version (`anchor: null` removes it), with its waiting, saving, conflict ("Review" supersedes it) and refused states. A refused change is explained ONLY by what its refusal recorded (revision 22, review 26 F26-1): a `422` names no rule, so it gets the generic reason whatever binding, task or reference the page has read since (the server keeps the old binding when it refuses a change, and a reference can change before the change is handled); a `403`/`404` says something the change needs is not available, which may be the task itself (a refused removal included). The recurrence and seconds rules are explained in the panel, before saving, from the person's own input. Evidence: `anchor-section.test.tsx` "revision 22", E-ANC3's revision-22 case, MU-5219 to MU-5225. A change pressed
again after a refusal (or a failure that may have stored it) keeps its identity; a STORED change's identity is retired, so A, B, then A
again is three changes (R2). The panel PRESENTS one editing session (`anchor-editor.ts`, revision 2, R3a/R3b): the session, not the panel's mount,
owns the input, the save being made (one at a time) and what it said; a save settles on its own session (never numbers re-used, so a
cancelled panel's late save changes nothing) whichever panel shows it then. Told that the task changed, the person's next press saves the
task as it is then (still checked when written). Every change is checked against a read of the task (revision 13, review 14 R11:
`setAnchorRequest` requires the observation): the read the session was opened on or, once renewed, the task as the section shows it at
the press. A panel opened before the section's read of the task arrived has none, and a renewed session has none while the task is not
readable: that press writes nothing ("This task's details are still loading — check the anchor and save again."), keeps the input and any
conflict being replaced, and makes the next press a deliberate save of the task as it is then. A read arriving never saves by itself.
Evidence: `anchor-section.test.tsx` "revision 13" (the subscribed read held and released, another device's change before the write, Save,
Remove, Review's replacement, renewal after a done save and after a changed refusal, a kept session shown by a new mount, Enter), the
pending create's detail in `task-form-anchor.test.tsx`, and mutants MU-5187 to MU-5196. The in-dialog sync control keeps the session for the next panel opened while the task's
visit goes on (ia.md §1.3.3, I1; `tasks/detail/anchor-kept.ts`, owned by the visit, for the task detail; a panel that left without Cancel
leaves its input there too; the panel belongs to the visit going on when it opens, even in a section React kept mounted through a departure
and return, revision 3 R3c; the form's own session for the new-task form).

**The import dialog keeps its input through the in-dialog sync control** (revision 6, review 6 R7; ia.md §1.3.3, the J2 dialog rule). The
dialog PRESENTS one editing session (`import-editor.ts`): the source (the drop zone's chooser, the source shown kept as its own), the raw
window, the file and its check, a read under way (one ticket per choice: the latest wins), the inline messages, what the last save said, the
save being made (one at a time, a ticket captured at the press) and its identity. The session belongs to the import's VISIT
(`import-kept.ts`): it begins at the Calendars screen, goes on at `/sync` (queue or conflicts) and ends at any other address the document
reaches, mounted or not. It is NOT the Calendars screen's automatic-read visit (`visit.ts`), which still ends at the sync screens. Back and
Import events again from the same entry (the same row; the drop zone's Browse, which then asks for no file; a file dropped on the zone is a
new choice in it) show the same session, with a read or a save that went on meanwhile settled in it: a queued save with nothing edited since
consumes it, newer input stays with "Import queued as it was…", a refusal stays with its words. A different row is a new import. Cancel,
Escape and the close icon end it (a save already made stays queued and is announced). Another account or epoch, signing out (observed while
it is kept), another database incarnation (checked when it is shown or saved) and, while it is kept, the cache being invalidated to be brought
up to date end it; a revoked session's late save is not announced. **Revision 7 (review 7 R7):** the cache is observed through the PAGE's
cache lifetime (`pageCacheLifetime`, `src/data/ui/cache-lifetime.ts`), which every mounted controller publishes in turn, never through the
controller mounted when the session opened (a remount of the protected tree disposes it while the page's leader goes on syncing). The session
keeps the cache's durable INVALIDATION WITNESS (revision 8, review 8 R7b: `sync_state.cache_invalidation_seq`, moved only by a committed
invalidation; revision 7 kept `recovery_generation`, which a first fill moves too) of the database it was opened or last shown against; once
hidden, a cache known to be invalid, or a witness past it (invalidated, and perhaps refilled, while no controller, or only a follower's
coalesced read, was there to see it), ends it. A session opened on an EMPTY cache (a pending source before the first snapshot) is kept through
the first fill and ended by an invalidation after it. It is also observed through the page runtime's service in hand when it opened
(`observeCache`), which outlives the protected tree. **Revision 9 (C2):** Import states the history the session was verified against
(`EnqueueRequest.continuity`, its database and basis, captured at the press) and the enqueue's own transaction refuses it (`expired`, nothing
stored) when another page invalidated the cache in between, whatever this page has heard; the session then ends and the dialog closes with
the same announcement. A save already queued is never undone, and a retry of it is still recognised. **Revision 8 (R7a):** shown again, it WAITS until a read of the witness made then
verifies its basis (**revision 9, review 9 R7c:** ONLY that read, made for this showing through a live service of its database; a
publication that agrees, such as an old controller's, may end it but never makes it ready, so nothing is queued before that read lands; a
read that fails, or no live service, keeps it waiting; a remount of the dialog after a real hiding waits the same way): unknown facts (a replacement controller's first read, a failed read) neither discard it nor let it be
saved; its file and window stay shown, its source is not, Import explains why it waits and Enter stores nothing; a witness past its basis then
ends it and the dialog closes with "Import closed while your calendar sources are brought up to date." **Revision 10 (review 10 R7d/R7e):** a
showing's read is judged against the basis it was ASKED for, never the basis as it is when it lands, so an earlier showing's read of the old
witness does not end a later showing that was verified and then followed an ordinary refresh (a pending source's dialog stays open through
one); what an earlier read says against its own basis (an invalid cache, a durable streak) still ends it. A NEW session is `acquiring` until
its opening read, or a reading published while it is shown, tells its database and witness: its source, file and window are shown, Import
explains why it waits, and nothing reaches the enqueue whatever submits the form; the press then captures that pair (`importAuthority`), and
`importRequest` requires it. **Revision 11 (review 11 R7f):** the reading that makes it ready tells the dialog (`subscribeImports`), so
Import is enabled as soon as the history is known, with no other edit or render needed. A CACHED source's open dialog whose cache
is only unverified waits the same way; a cache known to be invalid is the E9 close. The source's state is read afresh whenever it is shown.
**What this protection covers, and what it does not (C4; revision 12, review 13 R10).** Kieran's decision WEB13B-R11-BUDGET-C4-20261028
(28 October 2026; orchestrator `approval/web13b-r11-budget-c4-20261028.json`, SHA-256
`3d0a95bb853624bca8a4439a79e8768dae895d08c5986c6bbee16ec979106a88`, and `delivery/handoffs/web13b-r11-budget-c4-approved-20261028.md`, SHA-256
`f61e6a8feb91b5cf1f03657623ee8fac3a586e5d30d029a85b93e088706c0058`) limits it to COMMITTED invalidations (the witness) and failure evidence
the page can still observe (the cache's durable invalidation streak, its scoped marker, a stop held in a page's memory). An invalidation
that was admitted but whose write failed and never committed leaves only that evidence: once every streak, marker and peer-memory record
of it has gone while the committed history is unchanged, an unfinished import can stay open, or resume, and be saved. That is an ACCEPTED
RESIDUAL RISK, not a pass of the stronger earlier requirement (any admitted reset ends the session), which no revision or review has
passed and which stays recorded as history with its failures. Nothing else is relaxed: a committed invalidation still ends the session;
unknown facts still wait and never save; the press still captures its pair, and W2 still compares it in its own transaction on every
attempt (fence retries included); another account, incarnation or old writer is still refused; a save already admitted, and a retry of
it, still stand; Cancel and discard are unchanged. No record is deleted or kept shorter, nothing is submitted automatically, and no failure
history is persisted for this (a stronger guarantee would need a new, separately approved protocol).
Sync, reopening and a read completing never store anything; a reload or another tab has no session. `tests/features/calendars/import-retention.test.tsx` (I1-I13
through the production router; revision 7: L1/L2/L5 through the production `DataProvider` and writers W18/W20/W21/W23; revision 8: the
waiting session, the pending-source first fill versus invalidation, the marker-only L5 and the unverified cached source; revision 9: R7c, an
old agreeing publication with the showing's read held, row and chooser, click/Enter/programmatic submission, with its unchanged control; C2/T5,
another page's W18 and refill unheard before Import, fresh and resumed, with controls; revision 10: R7d, an earlier showing's read delivered
before and after the later showing's, with and without a visible refresh, and R7e, a new row import with every facts read held, at witness 0
and 1, then one press with and without W18 before W2, the chooser's entry absent until the cache gate opens; `tests/data/outbox-continuity.test.ts` for W2),
`import-editor.test.ts`, `import-kept.test.ts`, E-IMP7 and E-IMP8 (a 403 remount then 410/W18/W23, row and chooser, with controls; two pages
with the follower's cross-tab wakes delivered or held; revision 8: E-IMP9, a pending source on an empty cache, first fill alone versus fill,
410 and refill, the follower's wakes held) in `tests/e2e/fixture.calendar-import.spec.ts`; mutants MU-5110 to MU-5128, MU-5129 to MU-5141
(revision 8: re-anchored, MU-5139 re-expressed), MU-5142 to MU-5160, MU-5161 to MU-5180 (revision 9) and MU-5181, MU-5182 and MU-5257 to MU-5260 (revision 10;
its MU-2713 retired as equivalent after it ran). WEB-13a's own calendar dialogs (Add source, Link a calendar…, Manage) are unchanged by this revision. The binding read is the task screen's: `readAnchor(taskId, live)` asks whether the person is at the task's screen and the device's
connectivity before EVERY admission, so a read never sent is never sent after the person left the task (R6, `untilSentWhile`).

**Review items** (`model/review.ts`, `ReviewPanel.tsx`). "Anchor review needed" lists the cached unresolved `review` rows (private to the
binding's author), read strictly (`{reason, resolved, slot}`; a slot only for `moved`, the previous slot, and `work_started`, the proposed
one). Acknowledge queues `resolve_review` on the review's version with the observation of the card's one read (a review that changed
between showing and pressing is refused as changed). **Revision 12 (review 13 R8):** the card SHOWS that same read too (its reason, slot,
privacy, occurrence and links, whether it may be acknowledged, its waiting or conflicted acknowledgement); the list row only names which
review it is. The list and the card's read are published separately, so a card drawn from the list could show an older review than the
one Acknowledge resolved. Until its read arrives the card says it is loading and offers nothing; a review the read no longer finds is "no
longer available", and one it sees resolved goes, before the list says so. `tests/features/calendars/review-panel.test.tsx` (revision 12:
both publication orders for Acknowledge, Acknowledge (keep current timing) and Acknowledge again, a change inside the replacement's write,
privacy, navigation, permission, gone, resolved and loading, through the production `DataProvider`), mutants MU-5263, MU-5264 and MU-5183 to MU-5186; "Review this move…" (a `work_started` review) links to the task's day with `?move=`,
which the task screen reads strictly and consumes once to fill a NEW correction session (it never resolves the review); a
`context_unavailable` review shows no date, title or task; one that leaves the cache while shown is "no longer available". The panel
reads a page (100) at a time; "Show more reviews" shows 20 more and then the next page, and "Show previous reviews" goes back a page,
showing it whole (R4); a later page with nothing unresolved still shows the way back. A stored acknowledgement's identity is spent too.
**Revision 23 (review 27 F27-1):** a page is a bounded slice of the cache, so a review missing from it has not necessarily left the cache
(a review whose id sorts earlier moves the 100th to the next page). The panel remembers, per page and account service, only the ids of the
cards it actually drew (never every row the page fetched, and never a copy of a review's content); a remembered review missing from its
page is asked for by its own id (one id per read, so nothing is clipped to a working set). Only the cache's answer that it holds no such row
makes it "no longer available"; a review it still holds shows nothing there (it is on its own page, open and actionable); one whose
PUBLISHED base is resolved is forgotten (a local acknowledgement waiting to be sent or confirmed is not a resolution); while the answer is
not known nothing is claimed. A new panel (a remount, or the cache gate closing and reopening) remembers nothing. Evidence:
`review-panel.test.tsx` "revision 23", the revision-23 case of `fixture.calendar-reviews.spec.ts`, MU-5226 to MU-5234.
**Revision 24 (review 28 F28-1):** one review can have been shown on several pages (shown on page one, moved on to page two and shown
there). A published resolution seen by any of the panel's readings (a page's list, a card's own read, a departed review's id read) retires
it from EVERY page that showed it, so no page later says it is "no longer available". The panel keeps, per account service, the newest
version of each review it saw and whether it was resolved then: an OLDER reading still arriving (a slower list or card read) is neither
drawn nor remembered, and a card whose read then finds no row says nothing; a NEWER unresolved version (the server allows reopening) is
shown and remembered again; an older resolved reading does not retire a review seen reopened since. A local acknowledgement is still not
a resolution. Ids and versions only; nothing persists beyond the panel. Evidence: `review-panel.test.tsx` "revision 24", the revision-24
case of `fixture.calendar-reviews.spec.ts`, MU-5235 to MU-5246.
**Revision 25 (review 29 F29-1):** the page's list and a card's own read are published separately, so a card can still be listed when its
read finds no row. It says "no longer available" only when the current page's history holds the review (a card on that page drew it),
the same rule a departed review follows. A review whose card was only ever loading (inserted, then deleted before its first read arrived)
was never shown, so it simply goes; another page's history, or an earlier panel's, does not count. Evidence: `review-panel.test.tsx`
"revision 25", MU-5247 to MU-5249.
**Revision 33 (review 40 F40-1, F40-2):** the import dialog's file refusal ("Choose an .ics file to import." and every bound's
refusal) is the browse button's own error: the error has an id, the button is described by its label and then by the error while one is
shown, and it is `aria-invalid` while the file is refused (the slice's `Field` pattern; the input itself stays hidden). Both anchor pickers
show the read's own state: while a page is loading (every opening and every "Show next/previous") they say "Loading events…" / "Loading
date fields…" (`aria-busy`), an unreadable database says "This list can't be shown on this device.", and "No events yet" / "No date
fields on this device yet" only for a ready, empty page (provisional copy). Evidence: `import-ui.test.tsx` "F40-1",
`anchor-section.test.tsx` "revision 33", MU-5250 to MU-5256. The base merge of 5 November 2026 renumbered this card's colliding mutant
IDs (`scripts/mutation/web13b-id-map-20261105.json`) and its invalidation-witness barrier to schema version 5.

**Historical finding (F-13b-1; as recorded on 25 October 2026 at the first Running checkpoint `bfe4118`, pre-existing at `b9fd602`, not
fixed in that checkpoint; kept as it was written):** an ordinary `403` to ANY queued command sent by the production
leader makes the session re-check the display; the leader stops and restarts its dispatcher, the answer is dropped and the draft is resent
at once under the same key, in a loop (31 sends in 0.4 s against a stub, for a settings change as for an import). A `403` to an import is
therefore classified `rejected` by the dispatcher (unit evidence) but is not recorded through the production composition. See
`.agtx/execute.md` of the WEB-13b worktree. **Since corrected in this card's scope:** revision 3 (handover
`delivery/handoffs/web13b-foundation-403-approved-20261025.md`) records an answer the dispatcher had already issued into its draft while
its run is stopped that way, and revisions 4 and 5 (F-13b-1a/1b/1c, N1) its failed settlement and the owed-retry and stop authority; see
`docs/data-layer.md`. The original failure evidence stays in the card's evidence; the final shared regression is still owed.

**Around an app update (WEB-13b's maintenance merge of accepted main, correction M-13b-1; Kieran, 7 November 2026).** WEB-13b's
editing sessions stay page memory, and their dialogs take part in WEB-14a's app-update recovery (Q4; docs/pwa.md "WEB-13b's editors"): the
anchor panel and the import dialog are registered while shown (an update offers "Save and reload"), frozen while the reload is prepared,
saved by it and reopened on their copy by the screen that opens them (the task's or the new task form's "Calendar anchor" section, the
source's "Import events", the drop zone), restored and never saved until the person presses Save or Import; the new task's anchor is in
the task form's own text (version 2). A detail panel's copy keeps the read of the task it is checked against, so a task changed meanwhile
is refused as "changed", never overwritten. An import copy holds the source and the window as typed, NEVER the file: with a file chosen the
update stops instead of reloading over it.

## Limits and what is not claimed

* **Refreshes publish new versions.** A refresh (the worker's, every 15 minutes for a linked source, or a manual one) publishes the source's new health as a new version, and a queued settings change is built on the version the outbox assumes, the cache's. A change saved before the cache has caught up with a refresh is therefore answered `409 conflict` and shown as needing a decision (**Review**, which supersedes it). This is the contract's `expected_version` rule, not a client defect; it is listed for Kieran's review because offline settings changes to a linked source will often meet it (a backend change would be needed to exempt health from the version).
* **The leader wakes on another writer's save.** The screen saves through the tree's outbox facade, which posts `atlas-sync` `data_changed {stores: ["drafts", …]}`; a dispatcher is woken by saves of its own facade. The production leader (WEB-09b, merged: `app/data-leader.ts`, `data/leader/leader.ts`) wakes on that hint. The fixture specs keep their test leader, woken explicitly (`retryOutbox()`), so fixture evidence does not exercise production leadership.
* **Queued commands are sent by this device's leader.** A queued create or settings change is stored and shown as pending, and the production leader sends it when it runs (WEB-09b). Created sources appear only after sync, and "Add source" waits for the account database (WEB-09b's snapshot). The lifecycle and platform acceptance of that composition remain WEB-08c's and WEB-09d's.
* **Ownership is not visible client-side** (D-13a-11): the projection carries no owner and no "has a connection" flag. Manage is offered when `can_edit`; a non-owner's queued configure is refused `403` and the row says only the person who added the calendar can change its settings; a non-owner's refresh is `422 connection_unavailable` and shows cause 1's copy, because the two cannot be told apart. Refresh is offered on every editable source (the wireframe drew it only on linked rows; a backend field would be needed to do better).
* Provisional copy is marked in `copy.ts` for Kieran's copy and visual review (no new gate). Live announcements go through the shell's announcer (lint R6), not a region of their own.
* Sharing a source (WEB-12a/12b), PostgreSQL, real devices, real Safari and screen readers (WEB-09d, WEB-15) are not claimed.

## Tests

Unit and component (jsdom, the production controller and plans over the IndexedDB double): `tests/features/calendars/*` (builders and validation, the refresh classifier and reducer, the controller, submissions, the status table, the client, the screen, the connection forms), `tests/data/pending-reads.test.ts`, `tests/data/outbox-calendar-extension.test.ts`, `tests/data/outbox-model.test.ts` (`commandKindOf`), `tests/features/sync/screens.test.tsx` (the queue's calendar descriptions) and the Settings registry tests. Real engines: `tests/e2e/fixture.calendars.spec.ts` (E-CAL1 to E-CAL13, network stubbed; E-CAL12 is R9's live read, E-CAL13 two tabs of the same origin saving the same source, the second tab's observation of the first held through Dexie's cross-tab channel). Released backend: `tests/integration/integration.calendars.spec.ts` (I-CAL1 to I-CAL10, `-calendar` stack with a loopback feed).

WEB-13b: `tests/features/calendars/{import-model,anchor-model}.test.ts`, `{import-ui,review-panel}.test.tsx`,
`tests/features/tasks/{anchor-section,task-form-anchor}.test.tsx`, `tests/data/{outbox-calendar-extension,outbox-answers,pending-reads,plan-inventory}.test.ts`
(the answers, the seam, E6 and the header read); native `tests/e2e/fixture.calendar-{import,anchors,reviews}.spec.ts` (E-IMP1–6, E-ANC1–4,
E-REV1–3; helpers in `calendar-13b-helpers.ts`); released backend I-CAL-IMP1–4, I-CAL-ANC1 and I-CAL-REV1 in the calendar integration spec; mutants
MU-5001..MU-5033 (`scripts/mutation/catalogue-web13b.mjs`; revisions 1–3 in `catalogue-web13b-r{1,2,3}.mjs`, revision 3's owner alone in
`tests/features/tasks/anchor-kept.test.ts`).

Offline composition with a native file (WEB-13b revision 18): E-IMP1, the E-IMP3 dependency case and I-CAL-IMP1 lose HTTP on the opt-in
native transport lane (`tests/e2e/native-transport.ts`; its controller `scripts/integration/http-transport-loss.mjs`). The case's context
talks to a loopback front origin that carries all of the page's HTTP and, while the transport is lost, drops every request before any
origin receives it. Each loss is witnessed by a failing uncached probe that no origin records. The UI connectivity stimulus
(`navigator.onLine`) is separate and recorded beside the engine's own value. File reads stay native: WebKit's `context.setOffline`
fails every File read, and Playwright's WebKit cannot load the application through an HTTP forward proxy. E-IMP11 covers Browse, drop, a
row's dialog and a replacement on two pages, online, lost and restored, plus the lane's own negatives. It is browser transport loss for the
application's origin, not OS connectivity, a real device or a loss-time offline reload (the fixture build has no service worker).

The lane's console guard (revision 19) judges a journal of what each lane page did: every console error, warning and page error with its
page and document, every browser request with its own response or failure, and every front attempt. A page error or warning always fails.
An engine's network-failure message is excused only for its own page and document's request whose every attempt the front dropped in a
loss, once. An HTTP-status message is excused only for a request the case declared beforehand (`lane.expectHttp`: method, path, status,
exact count), which the front saw answered with that status. Anything ambiguous fails. The scripted origin owns what it dispatches and
forwards: a closed downstream cancels its request, and the origin's close cancels, joins and reports anything it could not end. Its own
qualification is `tests/static/native-transport.test.ts`, `scripts/integration/http-transport-loss.test.mjs` and
`tests/e2e/fixture.native-transport-guard.spec.ts` (real engines).

A page's document moves on when its main frame commits one, not when a navigation is answered (revision 26). A redirect hop, a 204 and
a download are answered but commit nothing. A request keeps the document it was issued from. A navigation also records the document it
committed, and only that navigation's own declared HTTP-status message may be excused in that document. This matters because Chromium
logs the status after the commit and WebKit before it; Firefox logs none, so no message is excused that way there. Each console problem
is captured, with its page and document, at the moment the browser delivers it to the lane. A message the browser delivers only after a
later commit belongs to that later document.

Revision 27 takes that commit from Playwright's own navigation event for the main frame (the client's `navigated` event, which
distinguishes a new document, a same-document change and an aborted navigation, and names the navigation request it links), not from a
URL. A history change to a stopped or still-pending navigation's URL therefore keeps the document, and a stopped navigation commits
nothing. Chromium's and Firefox's error pages are new documents linked to no request. The event is a private interface of the pinned
Playwright version (1.63.0): the lane checks the installed version and the event's shape, and an unavailable source, an unreadable event
or an event naming a request the lane did not record (or had already ended) fails the case by name. The lane detaches its listener when
it seals the journal. Qualified on macOS in Chromium, Firefox and WebKit: stops by the page's `window.stop()` in all three engines and by
the browser's Stop in Chromium, history while a navigation is still pending, same-URL supersession and two pages.

Revision 28 records from the lane's context, not from each page. A popup that a page opens itself (`window.open`) sends its first request,
receives the response and commits its first document before Playwright announces the page. Revision 27 listened only from that
announcement, so the popup's first document went unrecorded and a status declared for it matched nothing. The lane now attaches its
recorder as soon as the context exists. It attributes every request to its page by the identity of the request's top frame, numbers a page
when it first meets that frame, and listens for that frame's navigation events from that moment. For a popup's first request this reads
the request's client frame, which Playwright's public `frame()` does not yet expose (pinned to Playwright 1.63.0, like the navigation
event). The later announcement joins the same record. These fail the case by name, and nothing is invented for them:
- a page first met already showing a document;
- a request whose frame cannot be identified;
- a response, failure or end of a request the lane never saw;
- a navigation event naming another page's request.

A service worker's request has no frame and is recorded apart, never credited to a page. A page error or console message that arrives
before its page is announced is still recorded with that page. Every engine reuses a popup's initial blank window for its first
same-origin document, and WebKit runs the lane's start-up script in both. The UI connectivity stimulus now recognises its own earlier
installation instead of failing, and keeps its value per document, so a new document starts with a new id and no stimulus. A conflicting
installation fails visibly. Qualified on macOS in all three engines: Review 33's popup with a declared 503 (immediate and held at the
origin), a redirect and reload, a named window reused twice, an opener closed first, an undeclared status, and a plain popup's UI state.

Revision 29 also records a document that starts without any request. Firefox opens a same-origin `blob:` popup without one, and commits it
before the popup has any representation in Playwright's client. Playwright's client is therefore never told about that document, and the
lane met the popup already showing it. The lane now also listens to Playwright's own in-process server context for the same lane. That
listener attaches before the context has any page, and it hears every main-frame document commit. Playwright's own dispatch decides which
record is authoritative, never a URL or a time:
- **A commit Playwright did not send to its client:** it is applied to its page when the lane first meets that page, at its original
  position in the journal. It is a requestless new document, or, for the window's first blank document, the page's initial document 0.
- **A commit Playwright did send:** it is matched with the client's own navigation event, and both must name the same request.

These fail the case by name:
- a sent commit whose client event never arrived;
- a client event without a server commit;
- a mismatched request;
- a commit naming a request the lane never saw;
- a commit of a window the lane never met;
- a source that attached late;
- a page whose current document is not the last commit observed.

This depends on Playwright running in-process with the tests (the default) and is pinned to Playwright 1.63.0. A remote or connected
Playwright client, or another version, makes every lane fail by name until the source is requalified. Qualified on macOS in all three
engines: Review 34's blob popup and an explicit-page control, a named blank popup, and every earlier guard case.

Revision 30 makes the lane's own listeners and its context cleanup complete.
- **Every listener is owned before it is attached.** This covers the server listener, the context's listeners, each page's navigation and
  problem listeners, and the lane's own foreign-request and route-guard listeners. Each listener's removal is recorded before it is
  attached, and it is removed by its exact callback; another owner's listeners on the same objects are never touched.
- **A failed installation is undone.** If one of these attachments fails, even after an earlier one succeeded, everything attached so far
  is removed in reverse order. The open then fails with the original cause and any removal that also failed.
- **A failed page listener stays local.** If one of a page's own listeners fails, only that page's listeners are removed, and its
  uncaptured problems fail the case by name.
- **The context has one owner.** The lane takes ownership of the context as soon as Playwright returns it, before anything else can fail.
  A failed open, settlement and a late arrival therefore all share one cleanup.
- **Cleanup is bounded.** It closes the context while the listeners still record its final events, then removes every listener whatever
  the close did. A close still running after the 10-second bound fails by name, its eventual result is recorded as late, and the
  listeners are removed anyway.
- **Every cleanup failure is reported.** A failed close and a failed removal are both reported, each by name, in the teardown record and
  the case's error.
- **A late context is only closed.** One that arrives after settlement began gets no listeners.

Revision 31 makes a renderer crash fail the case. Before it, a lane page whose renderer crashed left no trace, and a case could pass.
- **A crash is its page's failure.** It is recorded with its page and document and always fails, whatever was declared or lost. A healthy
  close is not a crash.
- **It is taken from Playwright's server page.** Playwright tells its client about a crash only once it has announced the page, and does
  not repeat it later. The lane therefore listens on the server page, from the page's first document commit or the lane's first meeting
  with it, whichever comes first. Firefox's requestless popup is covered before Playwright announces it. A page that had already crashed
  when the lane reached it is recorded at once. A crash of a window the lane never met fails by name.
- **One source per page.** Playwright's public client crash event is used only when the server page cannot be read, and that gap already
  fails by name. The crash is never inferred from a closed page, a URL or a page error.
- **A crash can kill more than one page.** A same-origin popup shares its opener's renderer, so crashing one crashes both, and each is
  recorded on its own page.
- **Late callbacks are refused.** A listener that fires after cleanup, because its removal failed or it was rolled back, is recorded as a
  late line and never as a new problem. Revision 30 dropped late context console messages silently.

Qualified on macOS in all three engines with each engine's own crash command and a healthy close beside it, through the lane manager and
the case fixture itself. The engines report the crash after the announcement even when the command is sent at the popup's first commit,
so a genuine crash before Playwright announces a page has not been reproduced. That boundary is covered by the static tests only.

Revision 32 makes every listener check its permission before it reads anything. Before it, two of the lane's own adapters (navigation
and the server activation source) kept recording after a failed removal, and some refused callbacks still read their event to describe it.
- **Every callback is checked first.** Each of the lane's listeners, on the context, its pages, the main frame and Playwright's server
  context and pages, is wrapped. The wrapper checks permission before the event is read, recorded or used to change a page. This includes
  the two lane listeners that watch for foreign requests and refuse page routes.
- **Permission is withdrawn before anything is removed.** Once a context's close has finished (or failed, or run past its bound), all of
  its listeners lose permission together, and only then are they removed. A removal that fails, or that sets off another event while it
  runs, therefore meets refused listeners only. One that has not been removed yet is refused too, because its owner has already been
  refused. A listener whose own setup failed is refused from that moment, even if undoing the setup also failed.
- **A refused callback leaves a note, never evidence.** It reads nothing, not even to name the event. It writes a late line naming only
  the kind of event and never adds a problem, request, navigation, document change, foreign request or page change. One that arrives
  while its own listener is still being added fails the case by name.
- **Captured problems are delivered separately.** A console problem the lane captured earlier, and is still holding, can still be
  delivered once, with its original page and document, until the journal is sealed. Withdrawing permission from listeners does not
  discard it. The sealing rules are unchanged.

Qualified on macOS in all three engines on Playwright's real objects: every one of the lane's listeners is called again with a counting
version of a real event, while the lane is open, during its first real removal and after cleanup. While open it reads; refused, it reads
and records nothing, and the report stays clean.

The lane manager (revision 20) owns each open from the moment it is admitted, before anything is acquired. Every stage (witness, scripted
origin, front, context, init script, publication) is registered with its disposer before it starts. Settlement enters a closing state at
once: no open or stage is admitted after that, a result that arrives is closed rather than used, and no lane is published. It then joins
every pending acquisition within a harness bound and closes each lane's context before its network. If the bound expires, settlement fails
by name and the late result is still closed when it arrives. Opens that never finished are reported with their stage, and each lane's
report checks run whatever the others did.

Revision 21 corrects whose outcome confers ownership. A qualification wrapper may hold or fail a stage, but the scope owns what the stage
genuinely acquired the moment it arrives, before the wrapper sees it. So a wrapper that fails after the acquisition, or is still held when
settlement begins, never leaves that resource open: it is closed at once, exactly once, and the open fails with the wrapper's own error.
The acquisition, the wrapper's outcome and the disposal are recorded separately, and a join bound names whichever of them is still
pending. A failed open admits nothing more and unwinds immediately, without waiting for settlement. The acquisition handed to a wrapper is
single-use, and the wrapper must deliver exactly what it acquired. Application cases never use the wrapper.

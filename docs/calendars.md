# Calendars (`src/features/calendars/`)

*WEB-13a, 10 October 2026. UK English. The consumer contract for WEB-13b (local ICS import, anchors, review resolution) and the design record of calendar source and connection management and the manual refresh. Fixture-stage work: nothing here is integration or release evidence (`integration_passed: false`), and BE-Q22, BE-B8 and BE-CH3 still have no formal completion record although the pinned release (`0.27.0-rc.1`) ships all three.*

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
// targets: [{ resourceId: sourceId, role: "primary", basis: "resource", versionChecked: false, seedIfUntracked: 1 }],
// build: () => ({ command: { ics, from, through } })
```

* The source is an **unversioned primary target**, so the draft depends on the latest unsettled draft against the source (`depends_on`): a pending `create_source` (and any settings change queued after it) is sent and receipted first, and the dispatcher never sends the import ahead of them. Composition is never blocked: an import can be saved against a source that is still pending.
* The endpoint is resolved from `target_id` at dispatch (`resolveEndpoint`), and the body is stored canonically once, so every resend after a lost response is the **byte-identical** body under the **same** `Idempotency-Key` (the draft's `local_id`).
* A refused create takes its dependants with it (they are retained as `rejected` for the person, never sent).
* Evidence: `tests/data/outbox-calendar-extension.test.ts` (the production facade, plans and dispatcher over the double: held behind the create, routed, resent identically, a revision-0 receipt) and the real-backend case I-CAL9. The import screen, its 1 MiB / 730-day / 20,000-line / 256-component checks, its parse outcomes (7(c) import side, 7(e), 7(g)), anchors and case 3 are WEB-13b's.

## The manual refresh (D-13a-6; B8, CH3)

One press is one operation with one `Idempotency-Key`; every automatic retry of it and "Check again" reuse the key, and only a new press mints a new one. `model/refresh.ts` decides (`classifyRefresh`, `refreshStep`); `refresh-controller.ts` performs (one controller per mounted screen, built per calendar client so an identity change replaces it, disposed on unmount; memory only).

| Answer | Automatic action | Shown |
| --- | --- | --- |
| `200 {revision}` (0 included) | none | "Refreshed. New events appear after the next sync." |
| `409 refresh_in_progress` | same key at 5, 10, 20, 30 s (65 s, beyond the 60 s lease) | "Refreshing…", then "Still refreshing — check again shortly." with **Check again** |
| `409 stale_refresh` `generation_changed` (cause 4) | one live `GET /calendar-sources` read of `refresh_in_progress`; while true, again every 5 s for at most 75 s, then that refresh's own health | cause 4 copy, or "The newer refresh finished: …" |
| `409 stale_refresh` `lease_expired` (cause 5) | the same read; if false, ONE same-key retry | cause 5 copy if it fails again |
| `502 fetch_failed` (cause 2) | same key at 10 and 30 s | "Couldn't reach the calendar provider just now." |
| `422 connection_unavailable` (cause 1) | none | cause 1 copy with **Update connection** (Manage, Replace… open) |
| `503 integration_unconfigured` (cause 3) | none | cause 3 copy |
| `422 invalid_value` (cause 6a) | none | cause 6a copy with **Turn on** |
| `403` / `404` with an Atlas body (cause 6b) | none | cause 6b copy |
| `422 invalid_ics`, `unsupported_calendar_rule`, `unsupported_calendar_timezone`, `calendar_limit` | none | "This calendar's feed couldn't be read: …. Your existing events are unchanged." |
| `500`, `503 temporarily_unavailable` (CH3, 7(f)), `429`, network, abort, time-out, a `4xx` without an Atlas body | same key at 10 and 30 s | "Couldn't refresh right now — try again." |
| any other Atlas refusal (`409 operation_conflict`, `400`) | none | "We couldn't confirm this refresh." |

**Health is never evidence** (7(b), 7(d)): a `200` is success whatever `health` says, a `502` stays a failure whatever it says, and the row's health line is history ("Last success …", "Last refresh: …"). The only live signal used is `refresh_in_progress`, after a stale answer (B8 item 4). Refresh code has no capacity-specific branch (7(c); a static test). Offline, an unmount or an identity change stops every run, including a request still waiting to be sent (`not_sent`): every send and live read is admitted only while its run is current. While offline no run starts, whichever action asks; **nothing resumes on reconnect**. **Check again** starts a request as Refresh does, so it is offered exactly when Refresh would be (online, a supported server, an editable source that is on) with the same reason beside it, and it keeps the run's key. A refresh that was in flight at a reload is not resent (D-13a-13): after the reload the live list says whether a lease is held, and the synced health says the rest.

## The online-only forms (D-13a-7)

* The URL and token are `data-atlas-sensitive`, `autocomplete="off"`, typed `url` and `password`, and **uncontrolled** (React mirrors a controlled input's value into its `value` attribute, which a DOM snapshot or error report would carry). They live in the form's state alone and leave with it on success, close and unmount; a reload requires re-entry (Q22). `buildSnapshot` refuses them (strict mode throws, production drops them), so WEB-14a's recoverable-form registration may allow-list `label` and `timezone` (Add source, Link) and `timezone` and `enabled` (Manage), never the connection fields.
* Each submission is a **pair** `{key, body}` pinned per attempt (`model/submission.ts`): **Retry** resends the identical pair, and any edit of a field mints a new pair (and, for Link, a new source id). For Replace and Remove, Retry after an uncertain attempt resends THAT pair **whatever the cache has learnt since** (a newer version, other settings): the backend looks the key up before it checks the version, so an attempt that landed returns its receipt, while a new key against the newer version would apply the change a second time. Only an edit or a conflict makes the next attempt a new operation, built from the row as it is then. The wait before the next Save (below) is measured from the version the operation was built on.
* A form's request is admitted only while the form is open, under the client it was opened with, and online (`useLive`): closing the panel or Manage, another identity, or going offline during a `not_sent` wait sends nothing more (offline says "Needs a connection").
* The backend validates a connection (DNS, its outbound rules, a worker slot) **before** it looks the key up, so a refusal that follows an uncertain attempt of the same pair (`502 fetch_failed`, `422 invalid_endpoint`/`outbound_denied`, `503`) proves nothing about that attempt and stays uncertain. For Link, **Check** reads the live list: if the source id is there the create committed; if not (and the list was complete), Retry is safe. Replace and Remove have no such check (the id exists either way); Retry with the same pair is idempotent.
* A `409 conflict` (stale `expected_version`) shows the wireframe's conflict copy and the next attempt is built from the row as it is now, never resent blind. `403` keeps the panel open with "You no longer have access to make this change".

## Queued and online changes never interleave (D-13a-8)

Replace and Remove restate the current timezone and enabled from the merged row and send the cached `expected_version`. They are unavailable while the source has unsettled drafts ("Send or discard this calendar's waiting changes first") and until those drafts have been read. After one succeeds, Save (a queued settings change) waits, in this screen's memory, until the cache's version passes the one the command was based on ("Waiting for your last change to sync"): an online change does not raise the outbox's version record, so a queued change built before the cache caught up would conflict. After a reload such a change takes the generic `version_conflict` path: **Review** on the row opens Manage from the current row and Save there **supersedes** the conflicted draft (D-13a-12).

Manage's Timezone and Enabled start from the values the person last asked for: the newest waiting settings change over the cached row, as the row shows them (`displayedRow`). An untouched field follows them; an edited one keeps what was typed. Save waits until the source's waiting changes have been read ("Checking for changes waiting to send…"), so a second change made before the first is sent restates the first's values instead of reverting them, and saving the waiting values again is "Nothing to save."

## An open Manage is cache content (`model/visibility.ts`)

A cached source's Manage is shown only while the list could show it: the cache gate is open and the source's own read holds it. When the cache is being brought up to date (invalid, unverified, a recovery under way) or the source leaves the cache (removed, or access to it was), Manage closes, with any connection panel inside it, and the announcer says why ("Manage closed while your calendar sources are brought up to date." / "Manage closed: this calendar source can no longer be shown."); it never falls back to the row it was opened with. An uncertain Replace or Remove in a panel closed this way is not retried: the source's state is read again when the list returns. Offline with a valid cache Manage stays open, and it follows a newer version of its source. A pending source (this device's create) is not cache content and is shown from its create.

## What the screen reads

`useResourceList({kind: "calendar_source"})` (a page of 100 with Show next/previous), `usePendingCreates("create_source")` (this device's creates the cache does not hold: a queued create has no overlay until it is claimed), one `useOutstanding(id)` per visible row (exact counts by status and the newest draft with its body, which is what the row shows as "Queued — will apply once synced" or "Saving — will confirm on next sync"), the cache gate around the cached rows, `useStatusInputs().online`, `session.compat` (B2: the direct actions need `supported`), and `GET /notification-capabilities` once per client while online (D-13a-10: `calendar_links: false` disables Link and Replace with the cause 3 copy; unknown pre-disables nothing). "Add source" needs the account database (D-13a-9): without one it says "Available once this device has synced"; Link works without one.

## A `403` remounts the screen (`memory.ts`)

An Atlas `401` or `403` is classified by the session, which closes the protected display and opens it again (session matrix 3.6.2), so the Calendars screen, its refresh controller and any open form are unmounted by the very answer they were waiting for. Measured natively before the fix: a refresh refused `403` (cause 6b) ended with nothing shown. `identityMemory(account, epoch)` keeps, in memory only and per displayed identity, the ENDED refresh runs (their outcome and key, so "Check again" still reuses the key) and the words of a form's access refusal ("You no longer have access to make this change…", shown on the row or above the list with **Dismiss**). An answer that arrives after the controller was disposed records its outcome there and performs nothing (no send, no read, no wait); a run that was only waiting to retry ends with nothing remembered. Taking another identity's memory (another account, or a new epoch) drops every other. It never holds a form's values, so a secret is never kept across the remount: the person re-enters it (Q22).

## Limits and what is not claimed

* **Refreshes publish new versions.** A refresh (the worker's, every 15 minutes for a linked source, or a manual one) publishes the source's new health as a new version, and a queued settings change is built on the version the outbox assumes, the cache's. A change saved before the cache has caught up with a refresh is therefore answered `409 conflict` and shown as needing a decision (**Review**, which supersedes it). This is the contract's `expected_version` rule, not a client defect; it is listed for Kieran's review because offline settings changes to a linked source will often meet it (a backend change would be needed to exempt health from the version).
* **The leader must wake on another writer's save (hand-off to WEB-09b).** The screen saves through the tree's outbox facade, which posts `atlas-sync` `data_changed {stores: ["drafts", …]}`; a dispatcher is woken by saves of its own facade. The fixture leader is woken explicitly by the specs (`retryOutbox()`); WEB-09b's production leader must wake on that hint.

* **Production sends no queued calendar command yet.** Until WEB-09b supplies leadership, production starts no dispatcher: a queued create or settings change is stored and shown as pending, and a leader sends it. The online-only actions work now. Created sources appear only after sync, and "Add source" waits for the account database (WEB-09b's snapshot).
* **Ownership is not visible client-side** (D-13a-11): the projection carries no owner and no "has a connection" flag. Manage is offered when `can_edit`; a non-owner's queued configure is refused `403` and the row says only the person who added the calendar can change its settings; a non-owner's refresh is `422 connection_unavailable` and shows cause 1's copy, because the two cannot be told apart. Refresh is offered on every editable source (the wireframe drew it only on linked rows; a backend field would be needed to do better).
* Provisional copy is marked in `copy.ts` for Kieran's copy and visual review (no new gate). Live announcements go through the shell's announcer (lint R6), not a region of their own.
* Recoverable-form registration (WEB-14a), sharing a source (WEB-12a/12b), PostgreSQL, real devices, real Safari and screen readers (WEB-09d, WEB-15) are not claimed.

## Tests

Unit and component (jsdom, the production controller and plans over the IndexedDB double): `tests/features/calendars/*` (builders and validation, the refresh classifier and reducer, the controller, submissions, the status table, the client, the screen, the connection forms), `tests/data/pending-reads.test.ts`, `tests/data/outbox-calendar-extension.test.ts`, `tests/data/outbox-model.test.ts` (`commandKindOf`), `tests/features/sync/screens.test.tsx` (the queue's calendar descriptions) and the Settings registry tests. Real engines: `tests/e2e/fixture.calendars.spec.ts` (E-CAL1 to E-CAL6, network stubbed). Released backend: `tests/integration/integration.calendars.spec.ts` (I-CAL1 to I-CAL10, `-calendar` stack with a loopback feed).

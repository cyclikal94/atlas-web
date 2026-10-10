# Sharing: the policy and defaults editors (WEB-12a)

*10 October 2026. UK English. This is the contract WEB-10, WEB-11 and WEB-12b build against. Nothing here is an acceptance claim: the verdict belongs to the independent review, and the evidence is fixture-stage (the task's integration gates BE-Q1, BE-B5 and BE-CH1 have no formal completion record, so `integration_passed` stays false; see "Not claimed").*

## What the pinned contract provides

The vendored contract (`0.27.0-rc.1`, `contract-pin.json`) already contains the three backend briefs this card names:

* **B5:** `GET /defaults/snapshot` returns `SharingSnapshot { defaults, households }` from ONE database snapshot. `defaults.revision` is the revision of exactly those defaults and household versions. The client stores it as one record and never combines it with separately timed reads.
* **Q1:** a content `edit` requires `expected_policy_version`; a sharing change since then is a `409 conflict` and nothing is written. A content edit never advances `policy_version`.
* **CH1:** `/management-commands`, `/access-commands` and `/commands` take 1 to 20 commands.

Sharing commands (`replace_policy`, `set_defaults`, household commands on `/management-commands`; `grant`/`revoke` on `/access-commands`) are **online-only**: they are sent through the session's stamped client, never queued in the outbox (D-12a-1).

## Public interface

Import from `src/features/sharing` (the editors) and `src/data` (the defaults record and its capture). Nothing else.

```ts
// src/features/sharing
<ResourcePolicyEditor resourceId open onOpenChange onSaved? />   // WF-SHARING-04, any cached resource kind
sharingItemPath(resourceId)                                     // "/sharing/items/<id>": a link instead of embedding
<DefaultsReview draft onClose />                                // WEB-04 §5.7's review (the /sync queue opens it)
SharingBoundary, SharingEnvProvider, type SharingEnv            // a test or a fixture may provide its own env
type SharingApi, type SharingResult

// src/data
useSharingDefaults(): { record, status: "loading" | "ready" | "none", refresh() }
captureDefaults(record, kinds): DefaultsCapture                  // { kind, defaultsRevision, defaultsContext, defaultsReview }
defaultsReviewCase, reviewKinds, parseDefaultsContext, TEMPLATE_KINDS and the snapshot types
```

**`ResourcePolicyEditor`** opens on a resource the cache holds (`useCachedResource`), reads `GET /policies/{id}` (owner only; `403` shows "Only the owner can change who can see this", `404` "no longer available") and `GET /households` for labels, shows the effective visibility of the policy as edited, and saves with one `replace_policy` guarded by the policy version it read (never the cache's `policy_version`, which may lag: D-12a-3). It renders its own absent, offline, owner-only, gone, conflict and uncertain states. It knows nothing about any resource kind. `onSaved` receives the receipt's revision; return `false` to keep the dialog open.

**Routes** (D-12a-7): `/sharing` (the resolved defaults per kind, item-sharing explanation, the household demonstration), `/sharing/defaults?kind=person|field|task|list|progress` (WF-SHARING-03) and `/sharing/items/<id>` (WF-SHARING-04). The directory lookup (WF-SHARING-05) is a view inside those dialogs (D-12a-11).

## What a consumer must do

1. **A queued create that relies on implicit defaults captures them** and passes the capture to the outbox in its build:

   ```ts
   const { record } = useSharingDefaults();               // mount it where the create is made: it also starts the read
   build: (bases) => {
     const capture = captureDefaults(record, ["task", "progress"]); // EVERY template kind the command consumes
     return {
       command: { ...body, ...(capture.defaultsRevision ? { defaults_revision: capture.defaultsRevision } : {}) },
       defaultsRevision: capture.defaultsRevision,
       defaultsContext: capture.defaultsContext,
       defaultsReview: capture.defaultsReview,          // non-empty: queued BLOCKED on review, never sent with an omitted guard
     };
   }
   ```

   Which commands consume which kinds (`create_task` → `task` unless its own policy is explicit, and `progress` always; `record`/`start_timer` → `progress`; …, WEB-04 §5.7 items 2 to 4) is the consuming card's decision. A create with an explicit, fully private initial policy consumes no template.
2. **Never omit the guard on a queued create.** With no record ever fetched the capture is `never_fetched` and the draft is queued blocked; a later background fetch does NOT unblock it. Only the person's confirmation in `DefaultsReview` does (WEB-04 §5.7, "fetching a list is not approval").
3. **An edit of a queued draft keeps its review block** unless the build says otherwise: omit `defaultsReview` in an edit (or pass the same list). Passing `[]` clears the block and is reserved for the review's confirmation.
4. **Every authored-text content edit carries `expected_policy_version`** from the cache (`Projection.policy_version`), as Q1 requires. A sharing change since then makes the edit a `version_conflict`; the policy editor warns that queued edits of the item will need review.
5. **Online-only commands use one attempt per body** (D-12a-2): keep `{ key, body }`; after an uncertain outcome resend the same key and byte-identical body; after any edit use a new key. `model/submission.ts` does this for the editors.
6. **Form recovery (Q4):** the editors expose `sharing-policy:<id>` and `sharing-defaults:<kind>:<layer>` contexts with the draft as canonical JSON (`model/recovery-fields.ts`). WEB-14a's update event captures them; restoring never submits.
7. **One editor per target** (review cycle 1, R1). `ResourcePolicyEditor` is keyed by the displayed identity and `resourceId`: another resource is another editor, with its own read, draft and attempt, and an answer for the previous resource never lands in it. Every sharing read is bound to its target (`useSharingLoad`'s `target`: the client, which is per account and epoch, and the resource or household), so the defaults editor's household layer is read again for a new primary household before anything can be saved for it.
8. **Unsaved input survives the in-dialog sync control and a lost connection** (review cycle 1, R5; ia.md §1.3.3, §3). The sync control keeps each editor's unsaved draft, with the version it was composed against and an uncertain attempt, in this page's memory for the displayed identity and its target only (`retained.ts`); reopening the same editor on the same target shows it again with a note, and Save stays guarded by that version (a policy that moved meanwhile is a conflict, never overwritten); restoring never sends. Cancel, Done, Escape, the close icon and a successful save discard it. Going offline while editing keeps the defaults editor's forms (Save waits for the connection); the policy editor already kept its draft. `SharingEnv.identity` (`account:epoch`) is what kept input belongs to.

## The defaults review

Reached from the `/sync` queue's defaults-review rows ("Review sharing"). It shows one "Was / Now" section for **every template kind the draft consumes**: the kinds its captured context holds AND the kinds its block names (`reviewKinds`; review cycle 1, R3). A block can name only some of them (`captureDefaults` blocks only a kind whose household nobody here has seen, and a server refusal names none), but the confirmation replaces the draft's revision of ALL the defaults, so a kind whose audience was known at capture is reviewed too: its audience may have changed since. Each side is shown **principal by principal** (R4): each household the template names with its access (Read or Edit) and its members, each account granted directly with its access, and each exclusion. "Was" is named only from what was captured with the draft (the named households' members and, from the same snapshot, the names of the accounts the template names directly: `CapturedKind.accounts`); "Now" only from the current snapshot. An account neither names is shown by an abbreviated id, never by a name looked up today. "Now" comes only from a snapshot whose request was issued after the review opened. The copy is one of WEB-04 §5.7's four cases, and only a draft that was sent and refused is told the defaults "have changed". Confirm calls `DataActions.confirmDefaultsReview` with the row it showed (`reviewed: reviewedOf(draft)`) and a capture of every consumed kind (an edit in place for a draft never sent, a supersession for one refused); Discard removes the draft (dependants become `rejected`, retained). A draft whose versions moved is refused (`rebuild_refused`) and is reviewed from its own screen: the generic confirmation never sends a body on versions it was not built on. **A draft that changed while it was reviewed** (another page edited it, or its review changed) is refused (`draft_changed`, R2): the newer edit stands, still blocked, and the person reviews the draft as it now is; the confirmation never applies to a draft other than the one shown.

## Limits and decisions

* **D-12a-10, demand-driven defaults.** The defaults are read only while a screen uses them (`useSharingDefaults`), not at every boot: no request on the boot path or by a page that never shows sharing. A page that never used them captures from the persisted record, or queues blocked on review (the safe direction).
* **D-12a-11, the lookup is a view.** WF-SHARING-05 is drawn as a dialog over the Sharing page; here it is a view inside the open editor dialog or sheet (same sections, order and copy), so there is never a modal inside a modal.
* **D-12a-12, the editors are full-bleed sheets below the desktop breakpoint** (review cycle 1, R6; supersedes the cycle-0 "one dialog rule"). The accepted tablet frames draw the policy editor as a full-bleed sheet at 834×1112 and 1112×834 (WEB-05.5 `tablet/sharing-portrait.html`, `sharing-landscape.html`, Q14), so the policy and defaults editors pass `sheetBelow="desktop"` to the shared `Dialog`: a full-bleed sheet below 1280 px and the centred 440 px dialog from it. Every other dialog keeps the generic 768 px rule (the default); focus, the in-dialog sync control and dismissal are unchanged. E-SH8 measures both editors at 390×844, 834×1112, 1112×834 (full-bleed: x 0, y 0, the viewport's width and height) and 1440×900 (centred, 440 px wide).
* **D-12a-13, a 403 remounts the protected tree.** Any ordinary `403` closes the protected display while the session classifies it and reopens it (session matrix 3.6.2: 401 and 403 are possibly invalidating), which remounts the tree. A non-owner's editor therefore asked `GET /policies/{id}` again on every remount (measured natively: 173 reads in three seconds, E-SH9). The client remembers a refused policy per account for the page's lifetime and shares a read still on its way, so it asks once. **Any consumer that reads something on mount that can answer `403` must do the same** (or not read on mount).
* The policy editor's member labels come from `GET /households`, a separately timed read from `GET /policies/{id}`: it says "Household members as of …" and that the server checks membership live (D-12a-9). The defaults displays use the B5 record only.
* The household UI is WEB-12a's **demonstration subset** (list, create, invite by exact username, accept or decline). WEB-12b owns WF-SHARING-01/02.
* Copy is proposed (D-12a-8); visual and copy sign-off stay open.
* Production has no sync leader until WEB-09b: after a save the cache's `policy_version` follows only when sync runs. The editor does not depend on it.

## Not claimed

No PostgreSQL, HTTPS deployment, production leader, real device, real Safari or real assistive technology evidence (WEB-15, WEB-09d). The I-SH journeys run against the released backend `v0.27.0-rc.1` on disposable SQLite with the fixture leader: they are focused real-backend evidence for a fixture-stage task, **not** integration acceptance, and `integration_passed` stays false.

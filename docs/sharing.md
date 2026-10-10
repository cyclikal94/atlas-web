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

## The defaults review

Reached from the `/sync` queue's defaults-review rows ("Review sharing"). It shows one "Was / Now" section per template kind, each with the members of every household the template names (a membership-only change is visible). "Was" is the captured context; "Now" only a snapshot whose request was issued after the review opened. The copy is one of WEB-04 §5.7's four cases, and only a draft that was sent and refused is told the defaults "have changed". Confirm calls `DataActions.confirmDefaultsReview` (an edit in place for a draft never sent, a supersession for one refused); Discard removes the draft (dependants become `rejected`, retained). A draft whose versions moved is refused (`rebuild_refused`) and is reviewed from its own screen: the generic confirmation never sends a body on versions it was not built on.

## Limits and decisions

* **D-12a-10, demand-driven defaults.** The defaults are read only while a screen uses them (`useSharingDefaults`), not at every boot: no request on the boot path or by a page that never shows sharing. A page that never used them captures from the persisted record, or queues blocked on review (the safe direction).
* **D-12a-11, the lookup is a view.** WF-SHARING-05 is drawn as a dialog over the Sharing page; here it is a view inside the open editor dialog or sheet (same sections, order and copy), so there is never a modal inside a modal.
* **D-12a-12, one dialog rule.** The editors use the shared `Dialog`: a centred dialog from the tablet breakpoint (768 px) up and a full-bleed sheet below it. WEB-05.5's tablet frame (`tablet/sharing-portrait.html`) draws the policy editor as a full-bleed sheet at 834×1112; a sharing-only override would make these dialogs behave unlike every other D+sheet dialog. The difference is left to visual sign-off; E-SH8 checks fit, no horizontal overflow and 44 px targets at 390, 834 and 1112 px.
* **D-12a-13, a 403 remounts the protected tree.** Any ordinary `403` closes the protected display while the session classifies it and reopens it (session matrix 3.6.2: 401 and 403 are possibly invalidating), which remounts the tree. A non-owner's editor therefore asked `GET /policies/{id}` again on every remount (measured natively: 173 reads in three seconds, E-SH9). The client remembers a refused policy per account for the page's lifetime and shares a read still on its way, so it asks once. **Any consumer that reads something on mount that can answer `403` must do the same** (or not read on mount).
* The policy editor's member labels come from `GET /households`, a separately timed read from `GET /policies/{id}`: it says "Household members as of …" and that the server checks membership live (D-12a-9). The defaults displays use the B5 record only.
* The household UI is WEB-12a's **demonstration subset** (list, create, invite by exact username, accept or decline). WEB-12b owns WF-SHARING-01/02.
* Copy is proposed (D-12a-8); visual and copy sign-off stay open.
* Production has no sync leader until WEB-09b: after a save the cache's `policy_version` follows only when sync runs. The editor does not depend on it.

## Not claimed

No PostgreSQL, HTTPS deployment, production leader, real device, real Safari or real assistive technology evidence (WEB-15, WEB-09d). The I-SH journeys run against the released backend `v0.27.0-rc.1` on disposable SQLite with the fixture leader: they are focused real-backend evidence for a fixture-stage task, **not** integration acceptance, and `integration_passed` stays false.

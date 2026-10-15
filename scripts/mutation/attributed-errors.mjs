// Failures other than assertions that a FOCUSED CHECK showed to be a consequence of one unit mutation (WEB-08d revision 17; Kieran's
// decision of 15 October 2026 on review r16 H6). scripts/run-data-mutants.mjs otherwise rejects every failure that is not an assertion,
// even beside the expected assertion (scripts/validation/unit-results.mjs). An entry here does not make a catch: the mutant must still
// fail its own test by an assertion, and the listed failures are reported as ATTRIBUTED, apart from the catch.
//
// Each entry is narrow: one mutant, one exact test (`<file> > <full name>`), the kind `error` only (never a timeout, a file-level error,
// an unhandled error or a damaged report), and a pattern for the first line of that test's failure. Anything the entry does not name
// still fails the run. `why` says how the mutation produces the error; `established` names the evidence (focused run and analysis).
// New entries need the same evidence and independent review; nothing here is a blanket exemption.

// Revision 17's evidence for every entry below (24 inherited mutants of earlier cards; WEB-08d's own six were fixed in their tests
// instead): a read-only causal trace from the patch to each throw site (.agtx/evidence/revision-17/inherited/analysis.md), and two
// independent runs with the same failures (the review-r5 full run's raw report, and a revision-17 run of the mutant alone). The three
// inherited mutants whose extra failure is a TIMEOUT (MU-500, MU-801, MU-1277) are not here: a timeout is never attributed.
const ESTABLISHED =
  "WEB-08d revision 17: causal trace (.agtx/evidence/revision-17/inherited/analysis.md) and identical failures in two runs (review-r5 raw report; inherited/reruns-1)";

export const ATTRIBUTED = {
  "MU-101": {
    why: "the closing confirmation is skipped, so the wipe deletes the database; the test helper lateWrite then finds no database and throws (wipe-closing.test.ts:46)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/wipe-closing.test.ts > a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived abort: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted",
        kind: "error",
        message: /^Error: missing database$/,
      },
      {
        test: "tests/data/wipe-closing.test.ts > a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived error: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted",
        kind: "error",
        message: /^Error: missing database$/,
      },
      {
        test: "tests/data/wipe-closing.test.ts > a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived quota: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted",
        kind: "error",
        message: /^Error: missing database$/,
      },
    ],
  },
  "MU-1017": {
    why: "the slot is taken without awaiting the lock, the synchronous ordering leaves directory 0 unwritten, and the test JSON.parse of the missing directory throws",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/marker-directories.test.ts > the slot protocol: one writer for each directory a failure recorded before the slot is held is durable AT ONCE, and is listed when the slot arrives (revision 34: it was `pending` in revision 33)",
        kind: "error",
        message: /^SyntaxError: "undefined" is not valid JSON$/,
      },
    ],
  },
  "MU-1029": {
    why: "marker keys lose the incarnation, so markerKeys finds none and the test reads an undefined key (Vitest toMatch type guard, .slice of undefined)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/marker-instances.test.ts > a failure is an instance with its own name every `set` writes a NEW name, even over a marker that stands, and the page's pages do not share a name",
        kind: "error",
        message:
          /^TypeError: \.toMatch\(\) expects to receive a string, but got undefined$/,
      },
      {
        test: "tests/data/marker-instances.test.ts > a marker that cannot be read clearing an account forgets what it was owed: a marker that appears later is read as it is, whatever its name",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'slice'\)$/,
      },
    ],
  },
  "MU-1048": {
    why: "publish without a slot writes no key and no directory, so the test JSON.parse of the missing directory throws",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/marker-durable-at-once.test.ts > the primitive: a recovered failure is not published when the lock is delivered (Q-P1, Q-P2) a recovery of one operation never reaches the pending listing of another",
        kind: "error",
        message: /^SyntaxError: "undefined" is not valid JSON$/,
      },
    ],
  },
  "MU-105": {
    why: "a failed setClosing transaction is confirmed, so the wipe deletes the database; the test helper lateWrite finds none and throws (wipe-closing.test.ts:46)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/wipe-closing.test.ts > a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived abort: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted",
        kind: "error",
        message: /^Error: missing database$/,
      },
      {
        test: "tests/data/wipe-closing.test.ts > a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived error: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted",
        kind: "error",
        message: /^Error: missing database$/,
      },
      {
        test: "tests/data/wipe-closing.test.ts > a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived quota: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted",
        kind: "error",
        message: /^Error: missing database$/,
      },
    ],
  },
  "MU-1126": {
    why: "an edit never clears review_block, so the draft is never sent and the test JSON.parse of the missing body throws",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/outbox-defaults-review.test.ts > R2: the confirmation never overwrites a newer committed edit MU-S24: the row the review SHOWED is what is checked: an edit before the confirmation's read is refused too, and a renewed review confirms the newer body",
        kind: "error",
        message: /^SyntaxError: "undefined" is not valid JSON$/,
      },
    ],
  },
  "MU-1135": {
    why: "a policy conflict is silently re-read and resent, so the conflict banner the test waits for can never render",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed MU-S42: Reload after a conflict abandons the kept draft even when the new read fails: the sync control then keeps nothing and reopening shows the read policy",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: This policy changed since you opened it\. Reload to see the current grants before replacing the policy\., which matches selector '\[data-sharing-banner\] p'\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed control: Reload whose read succeeds shows the read policy (and the conflict's edit is not kept)",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: This policy changed since you opened it\. Reload to see the current grants before replacing the policy\., which matches selector '\[data-sharing-banner\] p'\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
    ],
  },
  "MU-1150": {
    why: "the household load compares targets by length only, never re-targets, and the test waitFor callback throws no household form",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/defaults-editor.test.tsx > R1: the household layer belongs to the primary household it was read for MU-S32: H1's read answered AFTER the switch never becomes H2's template or version",
        kind: "error",
        message: /^Error: no household form$/,
      },
    ],
  },
  "MU-1151": {
    why: "the editor is not keyed by resource and reads only [env.api], so it neither re-reads nor restores and the awaited text never renders",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R1: everything the editor reads, edits and sends belongs to the resource it was opened on MU-S30: A's read answered AFTER the switch never lands in B's editor",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Effective visibility once saved\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5: the dialog's sync control keeps the unsaved draft; Cancel discards it target isolation: a draft kept for A is never shown on B, and A still has it afterwards",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
    ],
  },
  "MU-1152": {
    why: "the dialog never retains the draft, so the restored-draft note the tests wait for never renders",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed MU-S42: Reload after a conflict abandons the kept draft even when the new read fails: the sync control then keeps nothing and reopening shows the read policy",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed MU-S43: a dismissal discards only its own resource's draft: another resource's kept draft survives",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed control: Reload whose read succeeds shows the read policy (and the conflict's edit is not kept)",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed control: reopened offline and closed WITHOUT a dismissal (the page navigates away), the kept draft is still restored online",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed control: reopened with its read held, the kept draft is restored when the read lands (nothing is sent)",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5: the dialog's sync control keeps the unsaved draft; Cancel discards it MU-S36: a kept draft whose policy moved meanwhile stays guarded by its OWN version (Save sends that version, which a server that moved on refuses): never sent at the newer one",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5: the dialog's sync control keeps the unsaved draft; Cancel discards it MU-S37: Cancel discards a KEPT draft: reopening starts from the read policy",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5: the dialog's sync control keeps the unsaved draft; Cancel discards it MU-S38: Escape discards a kept draft too",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5: the dialog's sync control keeps the unsaved draft; Cancel discards it an uncertain attempt kept through the sync control is resent with the SAME key and body",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5: the dialog's sync control keeps the unsaved draft; Cancel discards it target isolation: a draft kept for A is never shown on B, and A still has it afterwards",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
    ],
  },
  "MU-1153": {
    why: "the offline snapshot replaces the read forms whenever offline, so Try again is absent and the test helper reasonOf dereferences a null button",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/defaults-editor.test.tsx > R11: an explicit default can grant any household you are in (the complete membership list, never B5's subset) MU-S73 (Q5): coming back online reads the list again (the last one names grants meanwhile); the draft, its version and the templates stay",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of null \(reading 'getAttribute'\)$/,
      },
      {
        test: "tests/features/sharing/defaults-editor.test.tsx > R8 (review 3): a defaults Try again is admitted like Save, and one not sent keeps the uncertain attempt MU-S62: offline with an uncertain save, Try again is disabled with the connection reason and sends nothing; back online it resends the same key and body",
        kind: "error",
        message:
          /^TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "Try again"$/,
      },
    ],
  },
  "MU-1154": {
    why: "the defaults editor never retains its drafts, so no restored-draft note renders for the synchronous getAllByText",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/defaults-editor.test.tsx > R5 (review 2): what the session kept is discarded by a dismissal, whichever forms are on screen MU-S47: saving one layer forgets only that layer: the other layer's kept choice is still restored (an unmount is not a dismissal)",
        kind: "error",
        message:
          /^TestingLibraryElementError: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
    ],
  },
  "MU-1163": {
    why: "discard() clears every owner's retained entries, so the other resource's kept draft is gone and its restored note never renders",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed MU-S43: a dismissal discards only its own resource's draft: another resource's kept draft survives",
        kind: "error",
        message:
          /^Error: Unable to find an element with the text: Your unsaved changes are shown again\. Nothing has been saved yet\.\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
    ],
  },
  "MU-1283": {
    why: "membership is never read after going online, so the household group is named as not loaded and the synchronous getByRole for its name throws",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/features/sharing/policy-editor.test.tsx > R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed control: reopened offline and closed WITHOUT a dismissal (the page navigates away), the kept draft is still restored online",
        kind: "error",
        message:
          /^TestingLibraryElementError: Unable to find an accessible element with the role "radiogroup" and name "Home: Read or Edit"$/,
      },
    ],
  },
  "MU-15": {
    why: "sync_state is out of the saveFormRecovery scope, so the read in singletonPlan fails in the IndexedDB double and the direct store.run rejects with StoreFailure",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/form-recovery.test.ts > FormRecoveryPort over the form_recovery store admission inside the transaction: a late write of an older capture cannot overwrite a newer one (non-terminal needs `>`)",
        kind: "error",
        message: /^StoreFailure: store failure: error$/,
      },
      {
        test: "tests/data/form-recovery.test.ts > a page context that loads after another saved: its first capture is the later one, with no reconciliation (R1) an older capture can never overwrite a newer one, whichever order they reach the store in (sequence within a generation, and generation across them)",
        kind: "error",
        message: /^StoreFailure: store failure: error$/,
      },
    ],
  },
  "MU-169": {
    why: "the first page read ignores its cursor, so the walk re-reads page 1 until the test walk guard throws (resource-list.test.ts:57)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/resource-list.test.ts > a page, a continuation, and the whole list a list that is exactly a whole number of pages ends on its last page, not on an empty one",
        kind: "error",
        message: /^Error: the walk did not end$/,
      },
      {
        test: "tests/data/resource-list.test.ts > a page, a continuation, and the whole list a list under a parent holds the kind to the one asked for, however the kinds are interleaved, and pages through the rest",
        kind: "error",
        message: /^Error: the walk did not end$/,
      },
      {
        test: "tests/data/resource-list.test.ts > a page, a continuation, and the whole list a page smaller than the bound can be asked for, and a larger one is held to it",
        kind: "error",
        message: /^Error: the walk did not end$/,
      },
      {
        test: "tests/data/resource-list.test.ts > a page, a continuation, and the whole list a walk of 350 rows meets each once, in order, in pages of 100, 100, 100 and 50, and the last says there is no more",
        kind: "error",
        message: /^Error: the walk did not end$/,
      },
    ],
  },
  "MU-182": {
    why: "the guard for a storage without a feed is removed, so subscribe dereferences an undefined feed",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/marker-events.test.ts > what is reported, and the question a listener asks a storage with no feed (a caller's own, or no window) never reports, and unsubscribing it is harmless",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'subscribe'\)$/,
      },
    ],
  },
  "MU-186": {
    why: "verifyFacts no longer starts a fresh sync-facts read, so the facts stay unestablished and the retained content is never shown to the synchronous getByText",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/cache-gate-marker.test.tsx > recovery and the notification's limits, on the screen a marker another page removes opens nothing by itself: the content returns only when a read begun after it lands",
        kind: "error",
        message:
          /^TestingLibraryElementError: Unable to find an element with the text: REVIEW RETAINED CONTENT\. This could be because the text is broken up by multiple elements\. In this case, you can provide a function for your text matcher to make your matcher more flexible\.$/,
      },
    ],
  },
  "MU-196": {
    why: "every identity notification starts new identity-read work, so tabs feed each other hints (or the 401 fence re-evaluates) without end and the world idle guard throws (world.ts:252)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/identity-reads-session.test.ts > R16 (revision 9): the database binds late, in the production composition control: no database at all: the page asks `/me` once it has looked and found none, the mirror asks nothing, and nothing is created",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, no database for the account a 404 is counted in each page's memory, bounded, and still creates nothing",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, no database for the account a 503 is counted in each page's memory, bounded, and still creates nothing",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, no database for the account a healthy control asks once per tab, and creates nothing",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, one account, a database that exists a healthy control: one read of each endpoint per tab, the label shown, and nothing more for a minute",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, one account, a database that exists a new epoch is new work: it is asked at once, held by nothing of the earlier sign-in, and leaves nothing of it behind",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, one account, a database that exists a reload after a healthy run asks once more per tab, as a new page does, and never more",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
      {
        test: "tests/data/identity-reads-session.test.ts > two real tabs, one account, a database that exists a request the session closed (the credential was revoked) counts nothing and is not asked again",
        kind: "error",
        message: /^Error: world did not reach idle$/,
      },
    ],
  },
  "MU-233": {
    why: "the username guard only rejects undefined, so a non-string username reaches .trim()",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/identity-bodies.test.ts > parseAccountIdentity a null username is not a profile",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of null \(reading 'trim'\)$/,
      },
      {
        test: "tests/data/identity-bodies.test.ts > parseAccountIdentity a numeric username is not a profile",
        kind: "error",
        message: /^TypeError: username\.trim is not a function$/,
      },
      {
        test: "tests/data/identity-bodies.test.ts > parseAccountIdentity an object username is not a profile",
        kind: "error",
        message: /^TypeError: username\.trim is not a function$/,
      },
      {
        test: 'tests/data/profile.test.ts > F-P1: the profile label is shown only while it is verified for THIS epoch the shape is validated: {"id":"11111111-1111-4111-8111-111111111111","username":42}',
        kind: "error",
        message: /^TypeError: username\.trim is not a function$/,
      },
    ],
  },
  "MU-397": {
    why: "an edit is never measured against maxBytes, so the plan reports edited and the test helper measured() throws its setup guard",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/outbox-quota-context.test.ts > R25 (revision 14): a named property of an array is part of the write edit, the array with the property is a member of an object in the context: the exact boundary (the transaction's own figure) is the same as the ordinary payload's",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > R25 (revision 14): a named property of an array is part of the write edit, the array with the property is an element of an array in the context: the exact boundary (the transaction's own figure) is the same as the ordinary payload's",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > R25 (revision 14): a named property of an array is part of the write edit, the defaults context itself is an array with a named property: the exact boundary (the transaction's own figure) is the same as the ordinary payload's",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size command kind (derived into the header once more): edit: the transaction's measure grows by at least 2 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size command text: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size command: a named property of an array member: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size defaults context (opaque, unbounded): edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size defaults context as a list of many short strings: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size defaults context: a NAMED property of an array (kept by a clone, invisible to JSON and to its members): edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size defaults context: a named property of an array inside an object inside an array: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size defaults revision: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size display patch: a named property of an array in its value: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size display patch: edit: the transaction's measure grows by at least 1 x its size",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > every caller-sized contribution raises the estimate AND the transaction's measure by at least its own size the old figure (the command and its display patch) is a floor under the whole write, and the allowance a floor under both",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
      {
        test: "tests/data/outbox-quota-context.test.ts > the reviewer's matrix: a large defaults context on enqueue, an edit and a supersession edit: the exact boundary: one byte short of the write is refused, the write itself fits (the transaction's own figure)",
        kind: "error",
        message:
          /^Error: setup: edit reported \{"kind":"edited","localId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"\}$/,
      },
    ],
  },
  "MU-416": {
    why: "the IndexedDB ledger is never written, so the tests read holds/landed of the undefined record",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/production-quota.test.ts > a production guard that opens after a step of the wall clock keeps the debit another page wrote (R28b, revision 18) the writing page has closed: the second save is refused where it would not fit, and the debit is still in the origin's record",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'landed'\)$/,
      },
      {
        test: "tests/data/production-quota.test.ts > a production guard that opens after a step of the wall clock keeps the debit another page wrote (R28b, revision 18) the writing page is still open: the second save is refused where it would not fit, and the debit is still in the origin's record",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'landed'\)$/,
      },
      {
        test: "tests/data/production-quota.test.ts > the production guard follows the wall clock by the page's monotonic clock (R28, revision 17) with the page's own clocks a step of `Date.now()` is not time: the debit still caps the lagging estimate",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'landed'\)$/,
      },
      {
        test: "tests/data/production-quota.test.ts > the production guard is wired to the origin's ledger a page whose open of the ledger fails ONCE is answered by the origin's ledger all the same: the call is asked again (adapted, revisions 14 and 15)",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'holds'\)$/,
      },
      {
        test: "tests/data/production-quota.test.ts > the production guard is wired to the origin's ledger a reservation is recorded in the IndexedDB record that every page reads, and settling removes it",
        kind: "error",
        message:
          /^TypeError: Cannot read properties of undefined \(reading 'holds'\)$/,
      },
    ],
  },
  "MU-64": {
    why: "the hold signal is dropped, the unaborted commit keeps the shared atlas-auth lock, and the harness runWith guard throws when B never gets it (harness.ts:353)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once the reviewer's schedule, unchanged: queued behind a blocking sync_state transaction, the other page's notices withheld, 31 s, settle B, release the blocker",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
    ],
  },
  "MU-90": {
    why: "a rejected tracked promise is never counted settled, the atlas-auth lock is never returned, and the harness runWith guard throws (harness.ts:353)",
    established: ESTABLISHED,
    failures: [
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, reauth, after it, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, reauth, after it, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, reauth, settlement requested before the bound, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, reauth, settlement requested before the bound, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, signout, after it, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, signout, after it, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, signout, settlement requested before the bound, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, signout, settlement requested before the bound, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, switch, after it, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, switch, after it, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, switch, settlement requested before the bound, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once applying, switch, settlement requested before the bound, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, reauth, after it, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, reauth, after it, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, reauth, settlement requested before the bound, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, reauth, settlement requested before the bound, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, signout, after it, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, signout, after it, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, signout, settlement requested before the bound, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, signout, settlement requested before the bound, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, switch, after it, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, switch, after it, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, switch, settlement requested before the bound, notices delivered",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once queued, switch, settlement requested before the bound, notices withheld",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
      {
        test: "tests/data/commit-guard-expiry.test.ts > the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once the reviewer's schedule, unchanged: queued behind a blocking sync_state transaction, the other page's notices withheld, 31 s, settle B, release the blocker",
        kind: "error",
        message: /^Error: promise did not settle while the world was idle$/,
      },
    ],
  },
};

/** Throws if an entry is not as narrow as the header requires. */
export function checkAttributions(table, catalogue) {
  const ids = new Set(catalogue.map((m) => m.id));
  for (const [id, entry] of Object.entries(table)) {
    if (!ids.has(id)) throw new Error(`${id}: not in the unit catalogue`);
    if (typeof entry.why !== "string" || entry.why.length < 20)
      throw new Error(
        `${id}: \`why\` must say how the mutation causes the error`,
      );
    if (typeof entry.established !== "string" || entry.established === "")
      throw new Error(`${id}: \`established\` must name the focused evidence`);
    if (!Array.isArray(entry.failures) || entry.failures.length === 0)
      throw new Error(`${id}: no failures listed`);
    for (const f of entry.failures) {
      if (f.kind !== "error")
        throw new Error(
          `${id}: only kind "error" can be attributed (not ${f.kind})`,
        );
      if (typeof f.test !== "string" || !f.test.includes(" > "))
        throw new Error(`${id}: \`test\` must be "<file> > <full name>"`);
      if (!(f.message instanceof RegExp) || /[gy]/.test(f.message.flags))
        throw new Error(`${id}: \`message\` must be a RegExp without g or y`);
    }
  }
  return table;
}

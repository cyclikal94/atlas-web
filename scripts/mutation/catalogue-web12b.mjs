// WEB-12b's mutants (plan §8.5: household membership and the full sharing surface), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Each is ONE deliberate defect on a copy of one source file;
// its named tests must fail on it by an assertion and pass on the unmutated control. `sub` is the catalogue's own exactly-one-occurrence
// patcher. WEB-12a's ten household mutants (MU-1174, MU-1178..MU-1183, MU-1293, MU-1294; real-engine MU-1188) are RE-ANCHORED in
// `data-catalogue.mjs` itself (same defect, the new files), not repeated here.
//
// Not catalogued, with the reason (recorded in the WEB-12b hand-off):
//  - MU-6222 (an accept sent with the household's version instead of the invitation's): a pending invitation for you is never for a
//    household you are already in (the server refuses a second one: `conflict`), so the page never knows a household version for it;
//    the command builder's own counter is MU-6201's, over the same line.
//
// WEB-12b maintenance merge of accepted main 2f42ac35, correction M-1: +13 unit (MU-6239..MU-6251) over `households/form-recovery.ts` and the
// three household dialogs (WEB-14a's app-update recovery, ported from the deleted `HouseholdsMinimal`): +12 unit (MU-6239..MU-6248,
// MU-6250, MU-6251). Not catalogued, with the reason:
//  - MU-6249 (the look's automatic restore over a name typed before it answered, the owner's untouched guards removed): the guards in
//    `form-recovery.ts` are defence in depth. WEB-14a's model itself offers instead of restoring once the session's input changed after
//    the look began (DA-1), and page memory's draft is given to the model before any look, so no schedule observes their loss (an
//    equivalent mutant: run once, survived, `onto-2f42ac35/evidence/checks/m1-mutants-run-2-MU-6249-equivalent.log`).
//
// WEB-12b revision 2 (Review 3 F-R3-1, finding family `m1-household-submission-rules-without-sensitive-tests`; design assessment of
// 7 November 2026, Branch B, test-only): +17 unit (MU-6252..MU-6268), one per rule per household input over
// `tests/features/sharing/households-submission-rules.test.tsx`, each `expect` naming only its own rule and site (a Create test cannot
// catch a Rename mutant): R1 frozen (Rename and Invite send nothing, typing and a directory choice change nothing), R2 I7 (Rename,
// Invite), O1 (Rename's success clears), R3 (each call site's ticket and the shared `completeTicket`), R4 (the base forgotten by
// Escape and by "Discard instead"), and the Try again path as decision D-1 / D-12b-18 leaves it. MU-6249 stays uncatalogued.
//
// WEB-12b revision 3 (Review 4 F-R4-1, the same family; second design assessment of 7 November 2026, Branch B′, test-only): +31 unit
// (MU-6269..MU-6299). Decision D-1 is decided (Kieran, 7 November 2026, WEB12B-D1-ANSWER-20261107: D-12b-18 as written, no product
// change), so MU-6266..MU-6268 pin the decided behaviour. Two groups:
//  - CELLS (MU-6269..MU-6282): one mutant per cell of `tests/features/sharing/households-submission-cells.test.tsx` whose `expect`
//    names that cell's id (a cell common to the inputs is named per input, and the run shows each input's cell failing): Review 4's five
//    (a failed lookup, inviting yourself, a restored rename typed into, Invite's "Discard instead", the page's Try again after Cancel),
//    the assessment's eight (a choice from an empty field, Rename bound for a non-manager, `closed` counted durable per input, a base
//    forgotten on any refusal, another dialog's Try again closing Rename, a refused Try again completing the form), and MU-6282, the
//    fix of N-1 applied without its decision (decision D-2 is open: the cell pins the product as it is, so a fix must change it).
//  - SITES (MU-6283..MU-6299): every rule-bearing writer site of `tests/static/household-draft-writers.test.ts` that no catalogued
//    mutant changed (Review 4 item 2), plus `dropped()`'s form-shown branch (an exit). That inventory checks each link statically: the
//    mutant exists, its patch changes the registered line, its `tests` hold the pinned file and its `expect` names the pinned test.
//  - CLASSES (MU-6307..MU-6318; MU-62xx is full, so the unit IDs go on after WEB-12b's six real-engine IDs MU-6301..MU-6306): the
//    assessment's I-11, one mutant per answer class at each of the three ticket completions (`completeTicket(ticket, result?.ok ===
//    true)` in New household and Rename, `invite()`'s `return result?.ok === true`), widening "durable" by exactly one class:
//    uncertain, a definite refusal, offline, not_sent (`closed` is MU-6276..MU-6278).
//  - SWEEP (MU-6319..MU-6332): the second design assessment's operator sweep (WP-5, qualification evidence in the author's report) left
//    reachable survivors; each got a cell and one of its survivors is catalogued here (refusal kinds per input, the three dialogs' refused
//    presses, a restored base kept on `closed`, a Try again answered uncertain, a detail action's Try again, the session's begin and end).
import { sub } from "./data-catalogue.mjs";

const D = "src/features/sharing/households";
const MODEL = "tests/features/sharing/households-model.test.ts";
const PAGE = "tests/features/sharing/households-page.test.tsx";
const INVITATIONS = "tests/features/sharing/households-invitations.test.tsx";
const SIGNUP = "tests/features/sharing/households-signup.test.tsx";
const LEGACY = "tests/features/sharing/sharing-page.test.tsx";
// WEB-12b maintenance merge of 2f42ac35, correction M-1 (WEB-14a's app-update recovery of the household dialogs).
const RECOVERY = "tests/features/sharing/households-recovery.test.tsx";
const OWNER_DISCARD = "tests/features/recovery-owner-discard.test.tsx";
// WEB-12b revision 2 (Review 3 F-R3-1): M-1's submission rules, one test per rule per household input.
const RULES = "tests/features/sharing/households-submission-rules.test.tsx";
// WEB-12b revision 3 (Review 4 F-R4-1): the cells of those rules (rule × input × class or path), each title beginning with its cell id.
const CELLS = "tests/features/sharing/households-submission-cells.test.tsx";
/** A ticket the model never gave (a submission the freeze should have refused): the same shape as MU-6252's. */
const FORGED_TICKET =
  '({ current: () => true, succeeded: async () => "discarded", failed: () => undefined })';

export const UNIT_WEB12B = [
  {
    id: "MU-6201",
    title:
      "WEB-12b SHARE-9: a response to an invitation is not guarded by the invitation's own version",
    file: `${D}/model.ts`,
    tests: [MODEL, INVITATIONS],
    expect: /MU-6201/,
    patch: (t) =>
      sub(
        t,
        "    expected_version: invitation.version,\n",
        "    expected_version: 1,\n",
      ),
  },
  {
    id: "MU-6202",
    title:
      "WEB-12b SHARE-9: revoking a sent invitation is not guarded by its own version",
    file: `${D}/model.ts`,
    tests: [MODEL],
    expect: /MU-6202/,
    patch: (t) =>
      sub(
        t,
        "    expected_version: sent.version,\n",
        "    expected_version: 1,\n",
      ),
  },
  {
    id: "MU-6203",
    title:
      "WEB-12b SHARE-9: setting the main household is not guarded by B5's preferences_version",
    file: `${D}/model.ts`,
    tests: [MODEL],
    expect: /MU-6203/,
    patch: (t) =>
      sub(
        t,
        "    expected_version: preferencesVersion,\n",
        "    expected_version: 1,\n",
      ),
  },
  {
    id: "MU-6204",
    title:
      "WEB-12b D-12b-10: a 503 slice_capacity is left uncertain (offered as a Try again) instead of the capacity refusal",
    file: `${D}/api.ts`,
    tests: [MODEL],
    expect: /MU-6204/,
    patch: (t) =>
      sub(
        t,
        '  if (which === "command" && status === 503 && atlas.code === "slice_capacity")\n',
        "  if (false as boolean)\n",
      ),
  },
  {
    id: "MU-6205",
    title:
      "WEB-12b D-12b-10: a 429 rate_limited issuance is left uncertain instead of the limit refusal",
    file: `${D}/api.ts`,
    tests: [MODEL],
    expect: /MU-6205/,
    patch: (t) =>
      sub(
        t,
        '  if (which === "issue" && status === 429 && atlas.code === "rate_limited")\n',
        "  if (false as boolean)\n",
      ),
  },
  {
    id: "MU-6206",
    title:
      "WEB-12b SHARE-7: a signup issuance whose answer was lost is sent again (a second invitation may be made)",
    file: `${D}/operations.ts`,
    tests: [SIGNUP],
    expect: /MU-6206/,
    patch: (t) =>
      sub(
        t,
        "    memory.note(surface, {\n      message: copy.SIGNUP_UNCERTAIN,\n",
        "    void api.signupIssue(householdId);\n    memory.note(surface, {\n      message: copy.SIGNUP_UNCERTAIN,\n",
      ),
  },
  {
    id: "MU-6207",
    title:
      "WEB-12b R7: the signup token is put in a query string (?t=) instead of the fragment",
    file: `${D}/model.ts`,
    tests: [MODEL, SIGNUP],
    expect: /MU-6207/,
    patch: (t) =>
      sub(
        t,
        "  return `${origin}${JOIN_PATH}#t=${token}`;\n",
        "  return `${origin}${JOIN_PATH}?t=${token}`;\n",
      ),
  },
  {
    id: "MU-6208",
    title:
      "WEB-12b D-12b-9: Done does not forget the issued link (it stays in page memory and is shown again)",
    file: `${D}/SignupDialog.tsx`,
    tests: [SIGNUP],
    expect: /MU-6208/,
    patch: (t) =>
      sub(
        t,
        "    if (memory.issued.delete(householdId)) memory.touch();\n",
        "    memory.touch();\n",
      ),
  },
  {
    id: "MU-6209",
    title:
      "WEB-12b Q16 (answers item 3): every non-waiting sent invitation is labelled Expired",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [INVITATIONS],
    expect: /MU-6209/,
    patch: (t) =>
      sub(
        t,
        "              : copy.STATUS[s.status]}\n",
        "              : copy.STATUS.expired}\n",
      ),
  },
  {
    id: "MU-6210",
    title: "WEB-12b Q16: the sent history keeps only the waiting invitations",
    file: `${D}/memory.ts`,
    tests: [INVITATIONS],
    expect: /MU-6210/,
    patch: (t) =>
      sub(
        t,
        "        items = items.concat(page.value.items);\n",
        '        items = items.concat(page.value.items.filter((s) => s.status === "pending"));\n',
      ),
  },
  {
    id: "MU-6211",
    title:
      "WEB-12b D-12b-4: the sent walk stops at an empty page that still has a cursor",
    file: `${D}/memory.ts`,
    tests: [INVITATIONS],
    expect: /MU-6211/,
    patch: (t) =>
      sub(
        t,
        "        if (page.value.next_after === null)\n",
        "        if (page.value.next_after === null || page.value.items.length === 0)\n",
      ),
  },
  {
    id: "MU-6212",
    title:
      "WEB-12b D-12b-4: Revoke is offered on a sent invitation that is no longer waiting",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [INVITATIONS],
    expect: /MU-6212/,
    patch: (t) =>
      sub(
        t,
        '          {s.status === "pending" && canRevoke ? (\n',
        "          {canRevoke ? (\n",
      ),
  },
  {
    id: "MU-6213",
    title: "WEB-12b SHARE-6a: a member is shown the manager actions",
    file: `${D}/HouseholdDetail.tsx`,
    tests: [PAGE],
    expect: /MU-6213/,
    patch: (t) =>
      sub(
        t,
        '  const manager = complete && shown.role === "manager";\n',
        "  const manager = complete;\n",
      ),
  },
  {
    id: "MU-6214",
    title: "WEB-12b SHARE-6: the last manager's Leave is offered",
    file: `${D}/HouseholdDetail.tsx`,
    tests: [PAGE],
    expect: /MU-6214/,
    patch: (t) =>
      sub(
        t,
        "    : onlyManager\n      ? copy.LAST_MANAGER(shown.name)\n      : null;\n",
        "    : null;\n",
      ),
  },
  {
    id: "MU-6215",
    title:
      "WEB-12b D-12b-3: the households page memory is kept across identities",
    file: `${D}/memory.ts`,
    tests: [PAGE],
    expect: /MU-6215/,
    patch: (t) =>
      sub(
        t,
        "  if (current === null || current.identity !== identity) {\n",
        "  if (current === null) {\n",
      ),
  },
  {
    id: "MU-6216",
    title:
      "WEB-12b D-12b-5: a directory 403 (disabled) is not remembered for the page",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [INVITATIONS],
    expect: /MU-6216/,
    patch: (t) =>
      sub(
        t,
        "            memory.browseRefused = true;\n",
        "            memory.browseRefused = false;\n",
      ),
  },
  {
    id: "MU-6217",
    title: "WEB-12b D-12b-5: the browse search offers your own account",
    file: "src/features/sharing/DirectoryLookup.tsx",
    tests: [INVITATIONS],
    expect: /MU-6217/,
    patch: (t) =>
      sub(
        t,
        "          entry.id !== env.accountId &&\n",
        "          (browsing || entry.id !== env.accountId) &&\n",
      ),
  },
  {
    id: "MU-6218",
    title: "WEB-12b R7: B5 is not read again after a household change",
    file: `${D}/operations.ts`,
    tests: [PAGE, LEGACY],
    expect: /MU-6218|MU-S53/,
    patch: (t) =>
      sub(
        t,
        "  void ctx.defaults.acquire(ctx.defaults.boundary());\n}\n",
        "}\n",
      ),
  },
  {
    id: "MU-6219",
    title:
      "WEB-12b DA-M2: the capacity line counts B5's subset instead of the complete list",
    file: `${D}/HouseholdsPane.tsx`,
    tests: [PAGE],
    expect: /MU-6219/,
    patch: (t) =>
      sub(
        t,
        "              {copy.CAPACITY(shown.list.length)}\n",
        "              {copy.CAPACITY(snapshot?.list.length ?? shown.list.length)}\n",
      ),
  },
  {
    id: "MU-6220",
    title:
      "WEB-12b Decision H (D-12b-2): a same-named create is sent without asking",
    file: `${D}/NameDialogs.tsx`,
    tests: [PAGE],
    expect: /MU-6220/,
    patch: (t) =>
      sub(
        t,
        "    if (duplicate !== null && asked !== name.trim()) {\n",
        "    if (false as boolean) {\n",
      ),
  },
  {
    id: "MU-6221",
    title:
      "WEB-12b D-12b-7: a loss of manager rights is not detected on the signup screen (it stays editable)",
    file: `${D}/SignupDialog.tsx`,
    tests: [SIGNUP],
    expect: /MU-6221/,
    patch: (t) =>
      sub(
        t,
        '  const manager = household?.role === "manager";\n',
        "  const manager = household !== null;\n",
      ),
  },
  {
    id: "MU-6223",
    title:
      "WEB-12b SHARE-9: removing a member is not guarded by the household's version",
    file: `${D}/model.ts`,
    tests: [MODEL],
    expect: /MU-6223/,
    patch: (t) =>
      sub(
        t,
        "    account_id: accountId,\n    expected_version: h.version,\n  }),\n",
        "    account_id: accountId,\n    expected_version: 1,\n  }),\n",
      ),
  },
  {
    id: "MU-6224",
    title:
      "WEB-12b D-12b-14: an invite refused because they are already a member is explained as 'the household changed'",
    file: `${D}/model.ts`,
    tests: [MODEL, INVITATIONS],
    expect: /MU-6224|already in the household/,
    patch: (t) =>
      sub(
        t,
        '  if (after.household?.members.some((m) => m.account_id === recipientId))\n    return "member";\n',
        "",
      ),
  },
  {
    id: "MU-6225",
    title:
      "WEB-12b D-12b-5: the browse mode's exact-only state reaches every consumer (the search is hidden without `browse`)",
    file: "src/features/sharing/DirectoryLookup.tsx",
    tests: [INVITATIONS],
    expect: /MU-6225/,
    patch: (t) =>
      sub(
        t,
        "        {browse?.refused ? (\n          <p",
        "        {browse?.refused !== false ? (\n          <p",
      ),
  },
  // ---- revision 1 (Independent Review 1: F-R1-1 failed reads, F-R1-2 retry completion, F-R1-3 capacity wording, F-R1-4 prompt) ----
  {
    id: "MU-6226",
    title:
      "WEB-12b review 1 F-R1-1: the detail shown alone (below 1280 px) draws a failed list read as nothing or B5's view, with no failure and no Try again",
    file: `${D}/HouseholdDetail.tsx`,
    tests: [PAGE],
    expect: /MU-6226/,
    patch: (t) =>
      sub(
        t,
        "  const listFailedHere = withoutPane && failedUnread(read, online);\n",
        "  const listFailedHere = withoutPane && false && failedUnread(read, online);\n",
      ),
  },
  {
    id: "MU-6227",
    title:
      "WEB-12b review 1 F-R1-1: a failed sent walk is drawn as 'Loading what you sent…' in 'Invited by you, waiting', with no Try again",
    file: `${D}/HouseholdDetail.tsx`,
    tests: [PAGE],
    expect: /MU-6227/,
    patch: (t) =>
      sub(
        t,
        "          {failedUnread(memory.sent, online) ? (\n",
        "          {false ? (\n",
      ),
  },
  {
    id: "MU-6228",
    title:
      "WEB-12b review 1 F-R1-1: Rename draws a failed list read as 'Loading…', with no Try again",
    file: `${D}/NameDialogs.tsx`,
    tests: [PAGE],
    expect: /MU-6228/,
    patch: (t) =>
      sub(
        t,
        "        {household === null && failedUnread(memory.households, online) ? (\n",
        "        {false ? (\n",
      ),
  },
  {
    id: "MU-6229",
    title:
      "WEB-12b review 1 F-R1-1: the signup dialog draws a failed list read as 'Loading…', with no Try again",
    file: `${D}/SignupDialog.tsx`,
    tests: [SIGNUP],
    expect: /MU-6229/,
    patch: (t) =>
      sub(
        t,
        "        {household === null && failedUnread(memory.households, online) ? (\n",
        "        {false ? (\n",
      ),
  },
  {
    id: "MU-6230",
    title:
      "WEB-12b review 1 F-R1-1: New household does not show a failed list read or its Try again (Create only waits)",
    file: `${D}/NameDialogs.tsx`,
    tests: [PAGE],
    expect: /MU-6230/,
    patch: (t) => sub(t, "        {listFailed ? (\n", "        {false ? (\n"),
  },
  {
    id: "MU-6231",
    title:
      "WEB-12b review 1 F-R1-1: the household's invitations dialog silently drops its Invite section when the list read has failed",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [INVITATIONS],
    expect: /MU-6231/,
    patch: (t) =>
      sub(
        t,
        "              {failedUnread(memory.households, online) ? (\n",
        "              {false ? (\n",
      ),
  },
  {
    id: "MU-6232",
    title:
      "WEB-12b review 1 F-R1-2: a successful Try again of a lost invite keeps the username typed (a first try clears it)",
    file: `${D}/operations.ts`,
    tests: [INVITATIONS],
    expect: /MU-6232/,
    patch: (t) =>
      sub(
        t,
        "    memory.draft(formContext.invite(target), null);\n",
        "    undefined;\n",
      ),
  },
  {
    id: "MU-6233",
    title:
      "WEB-12b review 1 F-R1-2: a successful Try again of a lost rename leaves its dialog open (a first try closes it)",
    file: `${D}/NameDialogs.tsx`,
    tests: [PAGE],
    expect: /MU-6233/,
    patch: (t) =>
      sub(
        t,
        "            if (completed.surface === `rename:${householdId}`) onClose();\n",
        "            if (completed.surface === `rename:${householdId}`) undefined;\n",
      ),
  },
  {
    id: "MU-6234",
    title:
      "WEB-12b review 1 F-R1-3: an invitation refused for the recipient's waiting invitations (503 slice_capacity) is worded as your own 32-household cap",
    file: `${D}/operations.ts`,
    tests: [MODEL, INVITATIONS],
    expect: /MU-6234/,
    patch: (t) =>
      sub(
        t,
        "          ? copy.INVITE_CAPACITY_REFUSED\n",
        "          ? copy.CAPACITY_REFUSED\n",
      ),
  },
  {
    id: "MU-6235",
    title:
      "WEB-12b review 1 F-R1-4: with nothing to choose (the list loading, failed or empty) the desktop detail column says 'Choose a household'",
    file: `${D}/screens.tsx`,
    tests: [PAGE],
    expect: /MU-6235/,
    patch: (t) =>
      sub(
        t,
        "              implicit === null ? null : detail(implicit)\n",
        "              implicit === null ? <p>Choose a household to see its members.</p> : detail(implicit)\n",
      ),
  },
  {
    id: "MU-6236",
    title:
      "WEB-12b review 1 F-R1-1: a failed read's Try again does not read again",
    file: `${D}/parts.tsx`,
    tests: [PAGE],
    expect: /MU-6236/,
    patch: (t) =>
      sub(
        t,
        "          <Button onClick={() => void READERS[kind](ctx.memory, ctx.api)}>\n",
        "          <Button onClick={() => undefined}>\n",
      ),
  },
  {
    id: "MU-6237",
    title:
      "WEB-12b review 1 F-R1-1: a failed read is shown without its request id",
    file: `${D}/parts.tsx`,
    tests: [PAGE],
    expect: /MU-6237/,
    patch: (t) =>
      sub(
        t,
        '          failure !== null && "requestId" in failure\n            ? failure.requestId\n            : undefined\n',
        "          undefined\n",
      ),
  },
  {
    id: "MU-6238",
    title:
      "WEB-12b review 1 F-R1-2: a successful Try again of a lost rename keeps the typed name as a draft (Rename reopens on it, not the household's name)",
    file: `${D}/operations.ts`,
    tests: [PAGE],
    expect: /MU-6238/,
    patch: (t) =>
      sub(
        t,
        "    memory.draft(formContext.rename(target), null);\n",
        "    undefined;\n",
      ),
  },
  // ---- WEB-12b maintenance merge of 2f42ac35, correction M-1 (Kieran, 6 November 2026): the household dialogs' app-update recovery ----
  {
    id: "MU-6239",
    title:
      "WEB-12b M-1: New household declares no recovery (its dialog is no registered form: an update offers a plain Reload and loses the name)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY],
    expect: /M-1 New household: registered while open/,
    patch: (t) => sub(t, "    shown: true,\n", "    shown: false,\n"),
  },
  {
    id: "MU-6240",
    title:
      "WEB-12b M-1: New household's typing is not given to the model (never dirty, never saved; taken while an update reload is prepared)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY],
    expect:
      /M-1 New household: registered while open|M-1 while an update reload/,
    patch: (t) =>
      sub(
        t,
        "            if (recovery.edit(event.target.value))\n              memory.draft(key, event.target.value);\n",
        "            memory.draft(key, event.target.value);\n",
      ),
  },
  {
    id: "MU-6241",
    title:
      "WEB-12b M-1: Create sends while an update reload is being prepared (the model's refused ticket is ignored)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY],
    expect: /M-1 while an update reload is being prepared/,
    patch: (t) =>
      sub(
        t,
        "    const ticket = recovery.submitting();\n    if (ticket === null) return;\n    void run(ctx, cmd.create(id, trimmed), {\n",
        '    const ticket = recovery.submitting() ?? { current: () => true, succeeded: async () => "discarded", failed: () => undefined };\n    void run(ctx, cmd.create(id, trimmed), {\n',
      ),
  },
  {
    id: "MU-6242",
    title:
      "WEB-12b M-1 (WEB-14a I7): a successful create clears the name even when a newer name was typed while it was on its way",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY, OWNER_DISCARD],
    expect: /M-1 I7: a create answered|I7: a create answered after newer input/,
    patch: (t) =>
      sub(
        t,
        "        if (unchanged) memory.draft(key, null);\n        ctx.go(householdPath(id));\n",
        "        memory.draft(key, null);\n        ctx.go(householdPath(id));\n",
      ),
  },
  {
    id: "MU-6243",
    title:
      "WEB-12b M-1: a restored rename is saved under the household's version of now (a household renamed since is silently overwritten)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY],
    expect: /M-1 Rename: a restored rename is saved under the version/,
    patch: (t) =>
      sub(
        t,
        "            base === undefined ? household : { ...household, version: base };\n",
        "            household;\n",
      ),
  },
  {
    id: "MU-6244",
    title:
      "WEB-12b M-1: after a restored rename's conflict the old version is kept (every later Save conflicts again)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY],
    expect: /M-1 Rename: a restored rename is saved under the version/,
    patch: (t) =>
      sub(
        t,
        "              memory.bases.delete(key);\n",
        "              undefined;\n",
      ),
  },
  {
    id: "MU-6245",
    title:
      "WEB-12b M-1: an invitation's typed username is not given to the model (never dirty, never saved by an update)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RECOVERY],
    expect: /M-1 Invite: the username typed/,
    patch: (t) =>
      sub(
        t,
        "                          if (recovery?.edit(event.target.value) ?? true)\n",
        "                          if (true)\n",
      ),
  },
  {
    id: "MU-6246",
    title:
      "WEB-12b M-1: an account chosen in the directory lookup bypasses the model (the invitation's input is not saved by an update)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RECOVERY],
    expect: /M-1 Invite: an account chosen in the directory lookup/,
    patch: (t) =>
      sub(
        t,
        "          if (draftKey !== null && (recovery?.edit(entry.username) ?? true))\n",
        "          if (draftKey !== null)\n",
      ),
  },
  {
    id: "MU-6247",
    title:
      "WEB-12b M-1: a draft page memory drops (Rename's Escape) keeps its recovery session: its copy stays and an update saves it again",
    file: `${D}/form-recovery.ts`,
    tests: [RECOVERY],
    expect: /M-1 Rename: Escape/,
    patch: (t) =>
      sub(
        t,
        "  if (linked === undefined || !linked.active) return;\n",
        '  if (linked === undefined || !linked.active || key !== "") return;\n',
      ),
  },
  {
    id: "MU-6248",
    title:
      "WEB-12b M-1 (F-INT-PEOPLE-Q4's rule): another identity's page memory leaves the previous identity's household models in the registry",
    file: `${D}/memory.ts`,
    tests: [RECOVERY],
    expect: /M-1 another identity/,
    patch: (t) =>
      sub(
        t,
        "    retireHouseholdRecoveryExcept(identity);\n    current = new HouseholdsMemory(identity);\n",
        "    current = new HouseholdsMemory(identity);\n",
      ),
  },
  {
    id: "MU-6250",
    title:
      "WEB-12b M-1: Rename looks before its form is shown (after the update's reload the copy is only offered, never restored)",
    file: `${D}/form-recovery.ts`,
    tests: [RECOVERY],
    expect: /M-1 Rename: the accepted update saves the name/,
    patch: (t) =>
      sub(
        t,
        "    if (linked !== null && shown) linked.model.bind(port);\n",
        "    if (linked !== null) linked.model.bind(port);\n",
      ),
  },
  {
    id: "MU-6251",
    title:
      "WEB-12b M-1: the household codecs accept any text (a name over 300 characters is restored)",
    file: `${D}/form-recovery.ts`,
    tests: [RECOVERY],
    expect: /M-1 a copy this build cannot read/,
    patch: (t) =>
      sub(
        t,
        "      return valid({ [field]: parsed.text });\n",
        "      return parsed.text;\n",
      ),
  },
  // ---- WEB-12b revision 2 (Review 3 F-R3-1; design assessment of 7 November 2026, Branch B): M-1's rules per input ----
  {
    id: "MU-6252",
    title:
      "WEB-12b revision 2 (F-R3-1, R1): Rename sends while an update reload is being prepared (the model's refused ticket is ignored)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect:
      /R1 Rename: while an update reload is being prepared Save name sends nothing/,
    patch: (t) =>
      sub(
        t,
        "          const ticket = recovery.submitting();\n          if (ticket === null) return;\n          void run(ctx, cmd.rename(target, trimmed), {\n",
        '          const ticket = recovery.submitting() ?? { current: () => true, succeeded: async () => "discarded", failed: () => undefined };\n          void run(ctx, cmd.rename(target, trimmed), {\n',
      ),
  },
  {
    id: "MU-6253",
    title:
      "WEB-12b revision 2 (F-R3-1, R1): Invite looks up and sends while an update reload is being prepared (the model's refused ticket is ignored)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RULES],
    expect:
      /R1 Invite: while an update reload is being prepared Invite looks nothing up/,
    patch: (t) =>
      sub(
        t,
        "                      const ticket = recovery?.submitting() ?? null;\n                      if (ticket === null) return;\n",
        '                      const ticket = recovery?.submitting() ?? { current: () => true, succeeded: async () => "discarded", failed: () => undefined };\n',
      ),
  },
  {
    id: "MU-6254",
    title:
      "WEB-12b revision 2 (F-R3-1, R1): Rename's typing is given to the model but its refusal is ignored (the field takes text while an update reload is being prepared)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect:
      /R1 Rename: while an update reload is being prepared typing changes nothing/,
    patch: (t) =>
      sub(
        t,
        "                if (\n                  recovery.edit({\n                    text: event.target.value,\n                    base: memory.bases.get(key) ?? household.version,\n                  })\n                )\n                  memory.draft(key, event.target.value);\n",
        "                recovery.edit({\n                  text: event.target.value,\n                  base: memory.bases.get(key) ?? household.version,\n                });\n                memory.draft(key, event.target.value);\n",
      ),
  },
  {
    id: "MU-6255",
    title:
      "WEB-12b revision 2 (F-R3-1, R1): an invitation's typing is given to the model but its refusal is ignored (the field takes text while an update reload is being prepared)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RULES],
    expect:
      /R1 Invite: while an update reload is being prepared typing changes nothing/,
    patch: (t) =>
      sub(
        t,
        "                          if (recovery?.edit(event.target.value) ?? true)\n",
        "                          if ((recovery?.edit(event.target.value), true))\n",
      ),
  },
  {
    id: "MU-6256",
    title:
      "WEB-12b revision 2 (F-R3-1, R1): an account chosen in the directory lookup is taken while an update reload is being prepared (the model's refusal is ignored)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RULES],
    expect:
      /R1 Invite: while an update reload is being prepared an account chosen in the directory lookup changes nothing/,
    patch: (t) =>
      sub(
        t,
        "          if (draftKey !== null && (recovery?.edit(entry.username) ?? true))\n",
        "          if (draftKey !== null && (recovery?.edit(entry.username), true))\n",
      ),
  },
  {
    id: "MU-6257",
    title:
      "WEB-12b revision 2 (F-R3-1, R2 I7): a successful rename clears the draft even when a newer name was typed while it was on its way",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R2 Rename I7/,
    patch: (t) =>
      sub(
        t,
        "              if (unchanged) memory.draft(key, null);\n              onClose();\n",
        "              memory.draft(key, null);\n              onClose();\n",
      ),
  },
  {
    id: "MU-6258",
    title:
      "WEB-12b revision 2 (F-R3-1, R2 I7): a successful invitation clears the field even when a newer username was typed while it was on its way",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RULES],
    expect: /R2 Invite I7/,
    patch: (t) =>
      sub(
        t,
        "                        if (ok && unchanged) memory.draft(draftKey, null);\n",
        "                        if (ok) memory.draft(draftKey, null);\n",
      ),
  },
  {
    id: "MU-6259",
    title:
      "WEB-12b revision 2 (F-R3-1, O1): a successful rename with nothing typed since never clears its draft (Rename reopens on the sent name, an update saves it again)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /O1 Rename/,
    patch: (t) =>
      sub(
        t,
        "              if (unchanged) memory.draft(key, null);\n              onClose();\n",
        '              if (unchanged && key === "") memory.draft(key, null);\n              onClose();\n',
      ),
  },
  {
    id: "MU-6260",
    title:
      "WEB-12b revision 2 (F-R3-1, R3): every household submission's ticket is completed as a durable success (an uncertain or refused answer covers the input: an update loses it)",
    file: `${D}/form-recovery.ts`,
    tests: [RULES],
    expect: /R3 New household|R3 Rename|R3 Invite/,
    patch: (t) =>
      sub(
        t,
        "  if (durable) void ticket.succeeded();\n  else ticket.failed();\n",
        "  void durable;\n  void ticket.succeeded();\n",
      ),
  },
  {
    id: "MU-6261",
    title:
      "WEB-12b revision 2 (F-R3-1, R3): New household completes its ticket as a durable success whatever the answer",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R3 New household/,
    patch: (t) =>
      sub(
        t,
        "      const unchanged = ticket.current();\n      completeTicket(ticket, result?.ok === true);\n",
        "      const unchanged = ticket.current();\n      completeTicket(ticket, true);\n",
      ),
  },
  {
    id: "MU-6262",
    title:
      "WEB-12b revision 2 (F-R3-1, R3): Rename completes its ticket as a durable success whatever the answer",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R3 Rename/,
    patch: (t) =>
      sub(
        t,
        "            const unchanged = ticket.current();\n            completeTicket(ticket, result?.ok === true);\n",
        "            const unchanged = ticket.current();\n            completeTicket(ticket, true);\n",
      ),
  },
  {
    id: "MU-6263",
    title:
      "WEB-12b revision 2 (F-R3-1, R3): an invitation completes its ticket as a durable success whatever the answer (a lookup that found nobody included)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RULES],
    expect: /R3 Invite/,
    patch: (t) =>
      sub(
        t,
        "                        completeTicket(ticket, ok);\n",
        "                        completeTicket(ticket, true);\n",
      ),
  },
  {
    id: "MU-6264",
    title:
      "WEB-12b revision 2 (F-R3-1, R4): a draft page memory drops keeps its restored rename base (a fresh rename after Escape is saved under the stale version)",
    file: `${D}/memory.ts`,
    tests: [RULES],
    expect: /R4 Rename Escape/,
    patch: (t) =>
      sub(
        t,
        "      this.drafts.delete(key);\n      this.bases.delete(key);\n",
        "      this.drafts.delete(key);\n",
      ),
  },
  {
    id: "MU-6265",
    title:
      'WEB-12b revision 2 (F-R3-1, R4): "Discard instead" keeps the restored rename\'s base (a fresh rename is saved under the stale version)',
    file: `${D}/memory.ts`,
    tests: [RULES],
    expect: /R4 Rename Discard instead/,
    patch: (t) =>
      sub(
        t,
        "    if (base === null) this.bases.delete(key);\n",
        "    if (base === null) undefined;\n",
      ),
  },
  {
    id: "MU-6266",
    title:
      "WEB-12b revision 2 (F-R3-1, D-1 as D-12b-18 is written): a successful Try again of a lost create keeps the name in New household",
    file: `${D}/operations.ts`,
    tests: [RULES],
    expect: /D-1 New household/,
    patch: (t) =>
      sub(
        t,
        "    memory.draft(formContext.create(), null);\n    ctx.go(",
        "    ctx.go(",
      ),
  },
  {
    id: "MU-6267",
    title:
      "WEB-12b revision 2 (F-R3-1, D-1 as D-12b-18 is written): a successful Try again of a lost rename keeps the name typed since (Rename reopens on it)",
    file: `${D}/operations.ts`,
    tests: [RULES],
    expect: /D-1 Rename/,
    patch: (t) =>
      sub(
        t,
        "  } else if (target !== null && earlier.surface === `rename:",
        "  } else if (target !== null && earlier.surface === `rename-never:",
      ),
  },
  {
    id: "MU-6268",
    title:
      "WEB-12b revision 2 (F-R3-1, D-1 as D-12b-18 is written): a successful Try again of a lost invitation keeps the username typed since",
    file: `${D}/operations.ts`,
    tests: [RULES],
    expect: /D-1 Invite/,
    patch: (t) =>
      sub(
        t,
        "  else if (target !== null && earlier.surface === `invite:",
        "  else if (target !== null && earlier.surface === `invite-never:",
      ),
  },
  // ---- WEB-12b revision 3 (Review 4 F-R4-1; second design assessment, Branch B′): CELLS, one mutant per cell ----
  {
    id: "MU-6269",
    title:
      "WEB-12b revision 3 (F-R4-1 #1, R3): Invite counts a lookup that FAILED as a durable success (the username is covered and lost by an update)",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R3\.invite\.lookup-failed:/,
    patch: (t) =>
      sub(
        t,
        "    );\n    return false;\n  }\n  if (match.id === ctx.accountId) {",
        "    );\n    return !found.ok;\n  }\n  if (match.id === ctx.accountId) {",
      ),
  },
  {
    id: "MU-6270",
    title:
      "WEB-12b revision 3 (F-R4-1 #2, R3): Invite counts inviting yourself as a durable success (the username is covered and lost by an update)",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R3\.invite\.self:/,
    patch: (t) =>
      sub(
        t,
        "    memory.note(surface, { message: copy.INVITE_SELF });\n    return false;\n",
        "    memory.note(surface, { message: copy.INVITE_SELF });\n    return true;\n",
      ),
  },
  {
    id: "MU-6271",
    title:
      "WEB-12b revision 3 (F-R4-1 #3, R4): typing into a restored rename gives the model the household's version of now, not the version it was composed against",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R4\.rename\.typed-after-restore(-reopened)?:/,
    patch: (t) =>
      sub(
        t,
        "                    base: memory.bases.get(key) ?? household.version,\n",
        "                    base: household.version,\n",
      ),
  },
  {
    id: "MU-6272",
    title:
      'WEB-12b revision 3 (F-R4-1 #4, W4): Invite\'s "Discard instead" does not reset the field (the restored username stays, still dirty)',
    file: `${D}/InvitationsDialog.tsx`,
    tests: [CELLS],
    expect: /W4\.invite\.discard-instead:/,
    patch: (t) =>
      sub(
        t,
        "      if (draftKey !== null) memory.recovered(draftKey, null);\n",
        "      void 0;\n",
      ),
  },
  {
    id: "MU-6273",
    title:
      "WEB-12b revision 3 (F-R4-1 #5, W7): page memory dropping a draft no form shows does not end its recovery session (a Try again on the page after Cancel leaves the input dirty)",
    file: `${D}/form-recovery.ts`,
    tests: [CELLS],
    expect:
      /W7\.create\.page-after-cancel:|W7\.rename\.page-after-cancel:|W7\.invite\.page-after-close:/,
    patch: (t) =>
      sub(
        t,
        "    linked.active = false;\n    void linked.model.end();\n",
        "    linked.active = false;\n",
      ),
  },
  {
    id: "MU-6274",
    title:
      "WEB-12b revision 3 (assessment E-13, W2): a session that begins over a draft page memory already keeps is not given it (an account chosen from an empty field is not dirty)",
    file: `${D}/form-recovery.ts`,
    tests: [CELLS],
    expect: /W2\.invite\.choice-from-empty-field:/,
    patch: (t) =>
      sub(
        t,
        "        if (now !== start) linked.model.edit(now);\n",
        "        void now;\n",
      ),
  },
  {
    id: "MU-6275",
    title:
      "WEB-12b revision 3 (assessment E-27, D): Rename's model is bound for a household you do not manage (a copy is restored into a form nobody sees)",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /D\.rename\.non-manager-not-bound:/,
    patch: (t) =>
      sub(
        t,
        "    shown: household !== null && manager,\n",
        "    shown: household !== null,\n",
      ),
  },
  {
    id: "MU-6276",
    title:
      "WEB-12b revision 3 (assessment E-28, R3): New household counts an answer of kind closed (nothing sent) as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.create\.closed:/,
    patch: (t) =>
      sub(
        t,
        "      completeTicket(ticket, result?.ok === true);\n      if (result?.ok) {\n        if (unchanged)",
        '      completeTicket(ticket, result !== null && (result.ok || result.kind === "closed"));\n      if (result?.ok) {\n        if (unchanged)',
      ),
  },
  {
    id: "MU-6277",
    title:
      "WEB-12b revision 3 (assessment E-29, R3): Rename counts an answer of kind closed (nothing sent) as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.rename\.closed:/,
    patch: (t) =>
      sub(
        t,
        "            completeTicket(ticket, result?.ok === true);\n",
        '            completeTicket(ticket, result !== null && (result.ok || result.kind === "closed"));\n',
      ),
  },
  {
    id: "MU-6278",
    title:
      "WEB-12b revision 3 (assessment E-30, R3): an invitation counts an answer of kind closed (nothing sent) as a durable success",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R3\.invite\.closed:/,
    patch: (t) =>
      sub(
        t,
        "  return result?.ok === true;\n}",
        '  return result !== null && (result.ok || result.kind === "closed");\n}',
      ),
  },
  {
    id: "MU-6279",
    title:
      "WEB-12b revision 3 (assessment E-04, R4): Rename forgets a restored base on ANY answer that is not a success, not only a conflict (the next Save is not guarded by it)",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R4\.rename\.keep-on-refusal:/,
    patch: (t) =>
      sub(
        t,
        '            } else if (result !== null && result.kind === "conflict")\n',
        "            } else if (result !== null)\n",
      ),
  },
  {
    id: "MU-6280",
    title:
      "WEB-12b revision 3 (assessment E-05, W7): the Rename dialog closes when its banner's Try again completes ANOTHER surface's lost change (an invitation)",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /W7\.invite\.retried-in-rename-dialog:/,
    patch: (t) =>
      sub(
        t,
        "            if (completed.surface === `rename:",
        "            if (completed.surface !== `rename-never:",
      ),
  },
  {
    id: "MU-6281",
    title:
      "WEB-12b revision 3 (assessment E-06, W7): a Try again that was REFUSED still completes the form it came from (the input is dropped, a create shows the household)",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect:
      /W7\.create\.refused-completes-nothing:|W7\.rename\.refused-completes-nothing:|W7\.invite\.refused-completes-nothing:|W7\.create\.try-again-not-sent:/,
    patch: (t) =>
      sub(
        t,
        "  if (!result?.ok) return null;\n  const { memory } = ctx;\n",
        "  const { memory } = ctx;\n",
      ),
  },
  {
    id: "MU-6282",
    title:
      "WEB-12b revision 3 (assessment N-1, decision D-2 open): Try again refused as a conflict forgets a restored rename's base (the N-1 fix applied without its decision: the pinned cell must change with it)",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R4\.rename\.retry-conflict-keeps-stale-base:/,
    patch: (t) =>
      sub(
        t,
        "  if (!result?.ok) return null;\n  const { memory } = ctx;\n",
        '  if (!result?.ok) {\n    if (result?.kind === "conflict" && earlier.target !== null)\n      ctx.memory.bases.delete(formContext.rename(earlier.target));\n    return null;\n  }\n  const { memory } = ctx;\n',
      ),
  },
  // ---- WEB-12b revision 3 (Review 4 F-R4-1 item 2): SITES, every rule-bearing writer site no catalogued mutant changed ----
  {
    id: "MU-6283",
    title:
      "WEB-12b revision 3 (site W3): a restored invitation copy is never put into page memory (the field stays empty after the update's reload)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RECOVERY],
    expect:
      /M-1 Invite: the username typed in the household's Invitations is saved by the accepted update and restored/,
    patch: (t) =>
      sub(
        t,
        "      if (draftKey !== null) memory.recovered(draftKey, value);\n",
        "      void value;\n",
      ),
  },
  {
    id: "MU-6284",
    title:
      "WEB-12b revision 3 (site W2): the account chosen in the directory lookup is given to the model but never put into page memory (the field keeps what it had)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [CELLS],
    expect: /W2\.invite\.choice-from-empty-field:/,
    patch: (t) =>
      sub(
        t,
        "            memory.draft(draftKey, entry.username);\n",
        "            void entry;\n",
      ),
  },
  {
    id: "MU-6285",
    title:
      "WEB-12b revision 3 (site W1): an invitation's typing is given to the model but never put into page memory (the field shows nothing typed)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [RULES],
    expect:
      /R1 Invite: while an update reload is being prepared typing changes nothing/,
    patch: (t) =>
      sub(
        t,
        "                            memory.draft(draftKey, event.target.value);\n",
        "                            void event;\n",
      ),
  },
  {
    id: "MU-6286",
    title:
      "WEB-12b revision 3 (site W3): a restored New household copy is never put into page memory (the dialog stays empty after the update's reload)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RECOVERY],
    expect:
      /M-1 New household: registered while open, dirty once typed; the accepted update saves the name and reloads once/,
    patch: (t) =>
      sub(
        t,
        "    restored: (value) => memory.recovered(key, value),\n",
        "    restored: () => undefined,\n",
      ),
  },
  {
    id: "MU-6287",
    title:
      'WEB-12b revision 3 (site W4): New household\'s "Discard instead" does not reset the name (the restored name stays, still dirty)',
    file: `${D}/NameDialogs.tsx`,
    tests: [OWNER_DISCARD],
    expect: /CONTROL create: with no newer input the discard clears the name/,
    patch: (t) =>
      sub(
        t,
        "    reset: () => memory.recovered(key, null),\n  });\n  const [asked",
        "    reset: () => undefined,\n  });\n  const [asked",
      ),
  },
  {
    id: "MU-6288",
    title:
      "WEB-12b revision 3 (site W3): a restored rename loses the version it was composed against (it is saved under the household's version of now)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R4 Rename CONTROL/,
    patch: (t) =>
      sub(
        t,
        "    restored: (value) => memory.recovered(key, value.text, value.base),\n",
        "    restored: (value) => memory.recovered(key, value.text),\n",
      ),
  },
  {
    id: "MU-6289",
    title:
      'WEB-12b revision 3 (site W4): Rename\'s "Discard instead" does not reset the name or its base',
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R4 Rename Discard instead/,
    patch: (t) =>
      sub(
        t,
        "    reset: () => memory.recovered(key, null),\n  });\n  const reason =",
        "    reset: () => undefined,\n  });\n  const reason =",
      ),
  },
  {
    id: "MU-6290",
    title:
      "WEB-12b revision 3 (site W8): Rename's Escape keeps the draft (and its base): a fresh rename opens on the restored name",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R4 Rename Escape/,
    patch: (t) =>
      sub(t, "      onDiscard={() => memory.draft(key, null)}\n", ""),
  },
  {
    id: "MU-6291",
    title:
      "WEB-12b revision 3 (site R): Save name ignores a restored rename's base (it is sent under the household's version of now: an overwrite)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R4 Rename CONTROL/,
    patch: (t) =>
      sub(
        t,
        "          const base = memory.bases.get(key);\n",
        "          const base: number | undefined = undefined;\n",
      ),
  },
  {
    id: "MU-6292",
    title:
      "WEB-12b revision 3 (site T): the hook hands out a ticket even while an update reload is being prepared (every household submission sends while frozen)",
    file: `${D}/form-recovery.ts`,
    tests: [RULES],
    expect:
      /R1 Rename: while an update reload is being prepared Save name sends nothing|R1 Invite: while an update reload is being prepared Invite looks nothing up/,
    patch: (t) =>
      sub(
        t,
        "    submitting: () => model.submitting(),\n",
        `    submitting: () => model.submitting() ?? ${FORGED_TICKET},\n`,
      ),
  },
  {
    id: "MU-6293",
    title:
      "WEB-12b revision 3 (site P): page memory's draft(key, null) keeps the text (only the base and the model's session go)",
    file: `${D}/memory.ts`,
    tests: [RULES],
    expect: /O1 New household|O1 Rename|O1 Invite/,
    patch: (t) =>
      sub(
        t,
        "      this.drafts.delete(key);\n      this.bases.delete(key);\n",
        "      this.bases.delete(key);\n",
      ),
  },
  {
    id: "MU-6294",
    title:
      "WEB-12b revision 3 (site P): page memory dropping a draft no longer tells its recovery model (the model stays dirty, its copy stays)",
    file: `${D}/memory.ts`,
    tests: [CELLS, RECOVERY],
    expect:
      /W7\.create\.page-after-cancel:|W7\.rename\.page-after-cancel:|W7\.invite\.page-after-close:|M-1 Rename: Escape \(the dialog's discard\) drops the draft/,
    patch: (t) => sub(t, "      dropped(this.identity, key);\n", ""),
  },
  {
    id: "MU-6295",
    title:
      "WEB-12b revision 3 (site P): page memory's draft(key, text) stores nothing (every typed input is lost from page memory)",
    file: `${D}/memory.ts`,
    tests: [RULES],
    expect:
      /R1 Rename: while an update reload is being prepared typing changes nothing|R1 Invite: while an update reload is being prepared typing changes nothing/,
    patch: (t) =>
      sub(
        t,
        "    } else this.drafts.set(key, value);\n",
        "    } else void value;\n",
      ),
  },
  {
    id: "MU-6296",
    title:
      'WEB-12b revision 3 (site P): page memory\'s recovered(key, null) keeps the text ("Discard instead" leaves the restored input)',
    file: `${D}/memory.ts`,
    tests: [CELLS],
    expect: /W4\.invite\.discard-instead:/,
    patch: (t) =>
      sub(
        t,
        "    if (value === null) this.drafts.delete(key);\n",
        "    if (value === null) undefined;\n",
      ),
  },
  {
    id: "MU-6297",
    title:
      "WEB-12b revision 3 (site P): page memory's recovered(key, text) stores nothing (a restored copy never shows)",
    file: `${D}/memory.ts`,
    tests: [RULES],
    expect: /R4 Rename CONTROL/,
    patch: (t) =>
      sub(
        t,
        "    else this.drafts.set(key, value);\n    if (base === null)",
        "    else undefined;\n    if (base === null)",
      ),
  },
  {
    id: "MU-6298",
    title:
      "WEB-12b revision 3 (site P): page memory's recovered(key, text, base) keeps no base (a restored rename is saved under the household's version of now)",
    file: `${D}/memory.ts`,
    tests: [RULES],
    expect: /R4 Rename CONTROL/,
    patch: (t) =>
      sub(t, "    else this.bases.set(key, base);\n", "    else void base;\n"),
  },
  {
    id: "MU-6299",
    title:
      "WEB-12b revision 3 (exit of dropped(), form shown): page memory dropping the draft a form shows does not discard the model's copies (Rename's Escape leaves a copy for an update)",
    file: `${D}/form-recovery.ts`,
    tests: [RECOVERY],
    expect: /M-1 Rename: Escape \(the dialog's discard\) drops the draft/,
    patch: (t) =>
      sub(
        t,
        "  if (linked.shown !== null) void linked.model.discard(linked.shown.start());\n",
        "  if (linked.shown !== null) void linked.shown;\n",
      ),
  },
  // ---- WEB-12b revision 3 (assessment I-11): CLASSES, one mutant per answer class at each ticket completion ----
  {
    id: "MU-6307",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class uncertain): New household counts an uncertain answer as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R3 New household, uncertain/,
    patch: (t) =>
      sub(
        t,
        "      completeTicket(ticket, result?.ok === true);\n      if (result?.ok) {\n        if (unchanged)",
        '      completeTicket(ticket, (result?.ok === true || result?.kind === "uncertain"));\n      if (result?.ok) {\n        if (unchanged)',
      ),
  },
  {
    id: "MU-6308",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class refused): New household counts a definite refusal as a durable success (capacity)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R3 New household, a definite refusal/,
    patch: (t) =>
      sub(
        t,
        "      completeTicket(ticket, result?.ok === true);\n      if (result?.ok) {\n        if (unchanged)",
        '      completeTicket(ticket, (result?.ok === true || result?.kind === "capacity"));\n      if (result?.ok) {\n        if (unchanged)',
      ),
  },
  {
    id: "MU-6309",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class offline): New household counts an answer of kind offline (nothing sent) as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.create\.offline:/,
    patch: (t) =>
      sub(
        t,
        "      completeTicket(ticket, result?.ok === true);\n      if (result?.ok) {\n        if (unchanged)",
        '      completeTicket(ticket, (result?.ok === true || result?.kind === "offline"));\n      if (result?.ok) {\n        if (unchanged)',
      ),
  },
  {
    id: "MU-6310",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class not-sent): New household counts not_sent after the quiet retries (held back) as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.create\.not-sent:/,
    patch: (t) =>
      sub(
        t,
        "      completeTicket(ticket, result?.ok === true);\n      if (result?.ok) {\n        if (unchanged)",
        '      completeTicket(ticket, (result?.ok === true || result?.kind === "not_sent"));\n      if (result?.ok) {\n        if (unchanged)',
      ),
  },
  {
    id: "MU-6311",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class uncertain): Rename counts an uncertain answer as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R3 Rename, uncertain/,
    patch: (t) =>
      sub(
        t,
        "            completeTicket(ticket, result?.ok === true);\n",
        '            completeTicket(ticket, (result?.ok === true || result?.kind === "uncertain"));\n',
      ),
  },
  {
    id: "MU-6312",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class refused): Rename counts a definite refusal as a durable success (conflict)",
    file: `${D}/NameDialogs.tsx`,
    tests: [RULES],
    expect: /R3 Rename, a definite refusal/,
    patch: (t) =>
      sub(
        t,
        "            completeTicket(ticket, result?.ok === true);\n",
        '            completeTicket(ticket, (result?.ok === true || result?.kind === "conflict"));\n',
      ),
  },
  {
    id: "MU-6313",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class offline): Rename counts an answer of kind offline (nothing sent) as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.rename\.offline:/,
    patch: (t) =>
      sub(
        t,
        "            completeTicket(ticket, result?.ok === true);\n",
        '            completeTicket(ticket, (result?.ok === true || result?.kind === "offline"));\n',
      ),
  },
  {
    id: "MU-6314",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class not-sent): Rename counts not_sent after the quiet retries (held back) as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.rename\.not-sent:/,
    patch: (t) =>
      sub(
        t,
        "            completeTicket(ticket, result?.ok === true);\n",
        '            completeTicket(ticket, (result?.ok === true || result?.kind === "not_sent"));\n',
      ),
  },
  {
    id: "MU-6315",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class uncertain): an invitation counts an uncertain answer as a durable success",
    file: `${D}/operations.ts`,
    tests: [RULES],
    expect: /R3 Invite, uncertain/,
    patch: (t) =>
      sub(
        t,
        "  return result?.ok === true;\n}",
        '  return (result?.ok === true || result?.kind === "uncertain");\n}',
      ),
  },
  {
    id: "MU-6316",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class refused): an invitation counts a definite refusal as a durable success (capacity)",
    file: `${D}/operations.ts`,
    tests: [RULES],
    expect: /R3 Invite, a definite refusal/,
    patch: (t) =>
      sub(
        t,
        "  return result?.ok === true;\n}",
        '  return (result?.ok === true || result?.kind === "capacity");\n}',
      ),
  },
  {
    id: "MU-6317",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class offline): an invitation counts an answer of kind offline (nothing sent) as a durable success",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R3\.invite\.offline:/,
    patch: (t) =>
      sub(
        t,
        "  return result?.ok === true;\n}",
        '  return (result?.ok === true || result?.kind === "offline");\n}',
      ),
  },
  {
    id: "MU-6318",
    title:
      "WEB-12b revision 3 (assessment I-11, R3 class not-sent): an invitation counts not_sent after the quiet retries (held back) as a durable success",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R3\.invite\.not-sent:/,
    patch: (t) =>
      sub(
        t,
        "  return result?.ok === true;\n}",
        '  return (result?.ok === true || result?.kind === "not_sent");\n}',
      ),
  },
  // ---- WEB-12b revision 3 (the operator sweep's reachable survivors, WP-5): one mutant per cell written for them ----
  {
    id: "MU-6319",
    title:
      "WEB-12b revision 3 (sweep W, R3 refusal kinds): New household counts a forbidden refusal as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.create\.refused-other-kinds:/,
    patch: (t) =>
      sub(
        t,
        "      completeTicket(ticket, result?.ok === true);\n      if (result?.ok) {\n        if (unchanged)",
        '      completeTicket(ticket, result?.ok === true || result?.kind === "forbidden");\n      if (result?.ok) {\n        if (unchanged)',
      ),
  },
  {
    id: "MU-6320",
    title:
      "WEB-12b revision 3 (sweep W, R3 refusal kinds): Rename counts a forbidden refusal as a durable success",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R3\.rename\.refused-other-kinds:/,
    patch: (t) =>
      sub(
        t,
        "            completeTicket(ticket, result?.ok === true);\n",
        '            completeTicket(ticket, result?.ok === true || result?.kind === "forbidden");\n',
      ),
  },
  {
    id: "MU-6321",
    title:
      "WEB-12b revision 3 (sweep W, R3 refusal kinds): an invitation counts a changed-elsewhere refusal as a durable success",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /R3\.invite\.refused-other-kinds:/,
    patch: (t) =>
      sub(
        t,
        "  return result?.ok === true;\n}",
        '  return result?.ok === true || result?.kind === "conflict";\n}',
      ),
  },
  {
    id: "MU-6322",
    title:
      "WEB-12b revision 3 (sweep G): New household's form, submitted while Create is refused (no name), creates anyway",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /G\.create\.refused-press:/,
    patch: (t) =>
      sub(
        t,
        "    if (reason !== null) return;\n    if (duplicate !== null && asked",
        "    if (duplicate !== null && asked",
      ),
  },
  {
    id: "MU-6323",
    title:
      "WEB-12b revision 3 (sweep C, drop an operand): Rename's form, submitted while Save name is refused (the household's own name), sends anyway",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /G\.rename\.refused-press:/,
    patch: (t) =>
      sub(
        t,
        "          if (reason !== null || household === null || !manager) return;\n",
        "          if (household === null || !manager) return;\n",
      ),
  },
  {
    id: "MU-6324",
    title:
      "WEB-12b revision 3 (sweep C, drop an operand): the invitation form, submitted with no username, looks up an empty username",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [CELLS],
    expect: /G\.invite\.empty-press:/,
    patch: (t) =>
      sub(
        t,
        '                      if (blocked !== null || name === "") return;\n',
        "                      if (blocked !== null) return;\n",
      ),
  },
  {
    id: "MU-6325",
    title:
      "WEB-12b revision 3 (sweep W, R4): Rename forgets a restored base when its Save is answered closed (nothing sent)",
    file: `${D}/NameDialogs.tsx`,
    tests: [CELLS],
    expect: /R4\.rename\.keep-when-not-sent:/,
    patch: (t) =>
      sub(
        t,
        '            } else if (result !== null && result.kind === "conflict")\n',
        '            } else if (result !== null && (result.kind === "conflict" || result.kind === "closed"))\n',
      ),
  },
  {
    id: "MU-6326",
    title:
      "WEB-12b revision 3 (sweep W, W7): a Try again answered uncertain completes the form it came from",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /W7\.create\.try-again-other-answers:/,
    patch: (t) =>
      sub(
        t,
        "  if (!result?.ok) return null;\n  const { memory } = ctx;\n",
        '  if (!result?.ok && result?.kind !== "uncertain") return null;\n  const { memory } = ctx;\n',
      ),
  },
  {
    id: "MU-6327",
    title:
      "WEB-12b revision 3 (sweep C, W7): a successful Try again of a detail action (a member promoted) forgets the household's invitation draft",
    file: `${D}/operations.ts`,
    tests: [CELLS],
    expect: /W7\.invite\.detail-action-keeps-draft:/,
    patch: (t) =>
      sub(
        t,
        "  else if (target !== null && earlier.surface === `invite:",
        "  else if (target !== null || earlier.surface === `invite:",
      ),
  },
  {
    id: "MU-6328",
    title:
      "WEB-12b revision 3 (sweep C, exit of dropped()): page memory dropping the draft a form still shows ENDS the session instead of discarding to its start (typing after a successful invitation is not saved)",
    file: `${D}/form-recovery.ts`,
    tests: [CELLS],
    expect: /O1\.invite\.typed-after-success:/,
    patch: (t) =>
      sub(
        t,
        "  if (linked.shown !== null) void linked.model.discard(linked.shown.start());\n  else {",
        "  if (linked.shown === undefined) void linked.model.discard(linked.shown.start());\n  else {",
      ),
  },
  {
    id: "MU-6329",
    title:
      "WEB-12b revision 3 (sweep S, W1): a session is never begun from what the form shows untouched (Rename's start stays empty: its own name typed back is kept as input)",
    file: `${D}/form-recovery.ts`,
    tests: [CELLS],
    expect: /W1\.rename\.typed-back-to-start:/,
    patch: (t) =>
      sub(t, "      linked.model.begin(start);\n", "      void start;\n"),
  },
  {
    id: "MU-6330",
    title:
      "WEB-12b revision 3 (sweep C, W1): a form closed with nothing kept never ends its session (opened again, Rename resumes the old start)",
    file: `${D}/form-recovery.ts`,
    tests: [CELLS],
    expect: /W1\.rename\.reopened-after-rename-elsewhere:/,
    patch: (t) =>
      sub(
        t,
        "      if (memory.drafts.has(draftKey)) return;\n      linked.leaving = setTimeout(",
        "      if (draftKey !== null) return;\n      linked.leaving = setTimeout(",
      ),
  },
  {
    id: "MU-6331",
    title:
      "WEB-12b revision 3 (sweep S, W7): page memory dropping a draft no form shows ends the model's session but keeps it marked active (the Rename dialog opened again resumes the ended session and its old start: the landed name typed back stays a copy)",
    file: `${D}/form-recovery.ts`,
    tests: [CELLS],
    expect: /W7\.rename\.page-after-cancel:/,
    patch: (t) =>
      sub(
        t,
        "    linked.active = false;\n    void linked.model.end();\n",
        "    void linked.model.end();\n",
      ),
  },
  {
    id: "MU-6332",
    title:
      "WEB-12b revision 3 (sweep C, drop an operand, D): the invitation form's model is bound for a household you do not manage (a copy is restored into a form nobody sees)",
    file: `${D}/InvitationsDialog.tsx`,
    tests: [CELLS],
    expect: /D\.invite\.non-manager-not-bound:/,
    patch: (t) =>
      sub(
        t,
        "    shown: draftKey !== null && household !== null && manager && !lookupOpen,\n",
        "    shown: draftKey !== null && household !== null && !lookupOpen,\n",
      ),
  },
];

export const ENGINE_WEB12B = [
  {
    id: "MU-6301",
    title:
      "WEB-12b D-12b-3: (REAL ENGINE) the operation is owned by the mounted screen: the 403 remount drops the refused rename's continuation (no problem, no re-read)",
    file: `${D}/parts.tsx`,
    spec: "tests/e2e/fixture.households.spec.ts",
    grep: "E-HH4:",
    expect: /E-HH4:/,
    patch: (t) =>
      sub(
        t,
        "  const memory = useHouseholdsMemory(env.identity);\n",
        "  const memory = useHouseholdsMemory(env.identity);\n  useEffect(\n    () => () => {\n      memory.operation = null;\n    },\n    [memory],\n  );\n",
      ),
  },
  {
    id: "MU-6302",
    title:
      "WEB-12b D-12b-1: (REAL ENGINE) the lookup's typed input is not kept outside the view: the 403 remount loses it",
    file: `${D}/InvitationsDialog.tsx`,
    spec: "tests/e2e/fixture.households.spec.ts",
    grep: "E-HH9:",
    expect: /E-HH9:/,
    patch: (t) => sub(t, "        keep={{\n", "        keep={undefined && {\n"),
  },
  {
    id: "MU-6303",
    title:
      "WEB-12b D-12a-12: (REAL ENGINE) the invitations dialog is a centred dialog from 768 px instead of a full-bleed sheet below 1280 px",
    file: `${D}/InvitationsDialog.tsx`,
    spec: "tests/e2e/fixture.households.spec.ts",
    grep: "E-HH1:",
    expect: /E-HH1:/,
    patch: (t) =>
      sub(t, '      sheetBelow="desktop"\n', '      sheetBelow="tablet"\n'),
  },
  {
    id: "MU-6304",
    title:
      "WEB-12b R7: (REAL ENGINE) the issued signup token is left in the address bar",
    file: `${D}/operations.ts`,
    spec: "tests/e2e/fixture.households.spec.ts",
    grep: "E-HH7:",
    expect: /E-HH7:/,
    patch: (t) =>
      sub(
        t,
        "    memory.issued.set(householdId, {\n",
        '    window.history.replaceState(window.history.state, "", `#t=${result.value.token}`);\n    memory.issued.set(householdId, {\n',
      ),
  },
  {
    id: "MU-6305",
    title:
      "WEB-12b D-12a-13: (REAL ENGINE) a remounted lookup asks the directory's browse read again by itself (a 403 read loop)",
    file: "src/features/sharing/DirectoryLookup.tsx",
    spec: "tests/e2e/fixture.households.spec.ts",
    grep: "E-HH9:",
    expect: /E-HH9:/,
    patch: (t) =>
      sub(
        sub(
          t,
          'import { useId, useRef, useState } from "react";\n',
          'import { useEffect, useId, useRef, useState } from "react";\n',
        ),
        "  const latest = useRef({ search: 0, exact: 0 });\n",
        '  const latest = useRef({ search: 0, exact: 0 });\n  // biome-ignore lint/correctness/useExhaustiveDependencies: mutant\n  useEffect(() => {\n    const kept = keep?.get("search") ?? "";\n    if (browse && kept.trim() !== "") void ask("search", kept.trim(), setSearch);\n  }, []);\n',
      ),
  },
  {
    id: "MU-6306",
    title:
      "WEB-12b review 1 F-R1-1: (REAL ENGINE) at 390 px the detail alone draws a failed households read with no failure and no Try again",
    file: `${D}/HouseholdDetail.tsx`,
    spec: "tests/e2e/fixture.households.spec.ts",
    grep: "E-HH12:",
    expect: /E-HH12:/,
    patch: (t) =>
      sub(
        t,
        "  const listFailedHere = withoutPane && failedUnread(read, online);\n",
        "  const listFailedHere = withoutPane && false && failedUnread(read, online);\n",
      ),
  },
];

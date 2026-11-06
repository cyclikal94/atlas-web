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
import { sub } from "./data-catalogue.mjs";

const D = "src/features/sharing/households";
const MODEL = "tests/features/sharing/households-model.test.ts";
const PAGE = "tests/features/sharing/households-page.test.tsx";
const INVITATIONS = "tests/features/sharing/households-invitations.test.tsx";
const SIGNUP = "tests/features/sharing/households-signup.test.tsx";
const LEGACY = "tests/features/sharing/sharing-page.test.tsx";

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
];

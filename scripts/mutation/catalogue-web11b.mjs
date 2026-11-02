// WEB-11b's mutants (plan §7.4: merges, links and requests), in the form and under the rules of `data-catalogue.mjs`, which spreads them
// into its `UNIT` and `ENGINE` lists. Each is ONE deliberate defect on a copy of one source file; its named tests must fail on it and
// pass on the unmutated control. `sub` is the catalogue's own exactly-one-occurrence patcher.
//
// Not catalogued, with the reason (recorded in the WEB-11b hand-off):
//  - MU-4122 (a late read of an earlier generation is applied): the requests reads use the summaries' machinery unchanged
//    (`summaries.tsx` `readSummary`, its `current()` checks); its supersession is WEB-11a's, with its own mutants and tests.
//  - MU-4125 (a press uses the token of an earlier render): the guard compares the preview this render drew with the current read in
//    the same turn; no jsdom schedule separates them. The native MU-4132 (N-R2) holds the observable defect: a stale token after a 409.
//  - MU-4127 (the link picker offers linked people): the picker reads `scope=not_linked`, which the server filters before paging; the
//    client's own linkage check is defence in depth and is equivalent under a contract-conforming answer.
import { sub } from "./data-catalogue.mjs";

const MODEL = "tests/features/people/requests-model.test.ts";
const SCREEN = "tests/features/people/requests-screen.test.tsx";
const DIALOG = "tests/features/people/merge-dialog.test.tsx";

export const UNIT_WEB11B = [
  {
    id: "MU-4101",
    title: "WEB-11b: accepting a merge omits the recipient's preview token",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, DIALOG],
    expect:
      /only accepting a merge carries the recipient's token|Accept echoes THIS preview's token/,
    patch: (t) =>
      sub(
        t,
        "...(input.accept && input.recipientToken",
        "...(false && input.recipientToken",
      ),
  },
  {
    id: "MU-4102",
    title: "WEB-11b: accepting a LINK request sends a preview token",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /Confirm accept sends respond_request without a token/,
    patch: (t) =>
      sub(
        t,
        "respondBody({ requestId: request.id, accept }),",
        'respondBody({ requestId: request.id, accept, recipientToken: "f".repeat(64) }),',
      ),
  },
  {
    id: "MU-4103",
    title:
      "WEB-11b: a retained uncertain command is never sent again as it was (each press prepares a new body and key)",
    file: "src/features/people/requests/commands.ts",
    tests: [SCREEN, DIALOG],
    expect:
      /tried again exactly|tried again with the same key and body|Try again resends/,
    patch: (t) =>
      sub(
        t,
        "  const retained = memory.attempts.get(key) ?? null;\n",
        "  const retained = null as never as ReturnType<typeof memory.attempts.get> | null;\n",
      ),
  },
  {
    id: "MU-4104",
    title: "WEB-11b: a merge that needs approval is sent as a direct `merge`",
    file: "src/features/people/requests/MergeDialog.tsx",
    tests: [DIALOG],
    expect: /approval needed/,
    patch: (t) =>
      sub(
        t,
        "      return drawnPreview.requires_approval\n        ? requestMergeBody({",
        "      return false\n        ? requestMergeBody({",
      ),
  },
  {
    id: "MU-4105",
    title:
      "WEB-11b: a merge of two people the reader owns is sent as a `request_merge`",
    file: "src/features/people/requests/MergeDialog.tsx",
    tests: [DIALOG],
    expect: /one exact merge, then the kept person/,
    patch: (t) =>
      sub(
        t,
        "      return drawnPreview.requires_approval\n        ? requestMergeBody({",
        "      return true\n        ? requestMergeBody({",
      ),
  },
  {
    id: "MU-4106",
    title:
      "WEB-11b: the both-linked pre-check is skipped (two account-linked identities are offered a merge)",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, DIALOG],
    expect: /both linked/,
    patch: (t) =>
      sub(
        t,
        '  if (sourceLinked && targetLinked) return { kind: "both_linked" };\n',
        "",
      ),
  },
  {
    id: "MU-4107",
    title:
      "WEB-11b: with one identity linked, the name is still a free choice (not the linked identity's label)",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, DIALOG],
    expect: /one linked/,
    patch: (t) =>
      sub(
        t,
        '  if (sourceLinked) return { kind: "fixed", name: labels.source };\n',
        "",
      ),
  },
  {
    id: "MU-4108",
    title: "WEB-11b: an unknown linkage is taken for 'not linked'",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, DIALOG],
    expect: /unknown: nothing offered|a linkage that cannot be read/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            '  if (!source.known || !target.known) return { kind: "unknown" };\n',
            "",
          ),
          '  const sourceLinked = source.kind !== "unlinked";\n',
          '  const sourceLinked = source.known && source.kind !== "unlinked";\n',
        ),
        '  const targetLinked = target.kind !== "unlinked";\n',
        '  const targetLinked = target.known && target.kind !== "unlinked";\n',
      ),
  },
  {
    id: "MU-4109",
    title:
      "WEB-11b: a comparison value is taken from a cached row of a LOWER version than the preview names",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, DIALOG],
    expect: /values only from/,
    patch: (t) =>
      sub(
        t,
        'row.kind === "field" && row.version >= field.version',
        'row.kind === "field" && row.version >= 1',
      ),
  },
  {
    id: "MU-4110",
    title:
      "WEB-11b: the conflict note compares labels without trimming or case folding",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, DIALOG],
    expect: /trimmed and case-insensitive|the conflict note/,
    patch: (t) =>
      sub(
        t,
        "const labelKey = (label: string): string => label.trim().toLocaleLowerCase();",
        "const labelKey = (label: string): string => label;",
      ),
  },
  {
    id: "MU-4111",
    title:
      "WEB-11b: a 410 is folded into not_found (an expired request reads as withdrawn)",
    file: "src/features/people/api.ts",
    tests: [MODEL, DIALOG],
    expect: /410 is expired|410: expired/,
    patch: (t) =>
      sub(
        t,
        '    case "gone":\n      return { ...failure, kind: "expired" };',
        '    case "gone":\n      return { ...failure, kind: "not_found" };',
      ),
  },
  {
    id: "MU-4112",
    title:
      "WEB-11b: a people command's 503 slice_capacity is treated as uncertain",
    file: "src/features/people/api.ts",
    tests: [MODEL],
    expect: /slice_capacity is a definite refusal/,
    patch: (t) =>
      sub(
        t,
        'if (options.capacity && status === 503 && atlas?.code === "slice_capacity")',
        'if (false && options.capacity && status === 503 && atlas?.code === "slice_capacity")',
      ),
  },
  {
    id: "MU-4113",
    title:
      "WEB-11b: any 503 with an Atlas body is taken as the capacity refusal",
    file: "src/features/people/api.ts",
    tests: [MODEL],
    expect: /any other 503 is uncertain/,
    patch: (t) =>
      sub(
        t,
        'if (options.capacity && status === 503 && atlas?.code === "slice_capacity")',
        "if (options.capacity && status === 503 && atlas !== null)",
      ),
  },
  {
    id: "MU-4114",
    title:
      "WEB-11b: Sent: an empty page with a cursor claims there are no sent requests",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /an empty page with a cursor says there are more/,
    patch: (t) =>
      sub(
        t,
        "{page.next_after === null && first ? copy.NO_SENT : copy.PAGE_MORE}",
        "{page.items.length === 0 ? copy.NO_SENT : copy.PAGE_MORE}",
      ),
  },
  {
    id: "MU-4115",
    title: "WEB-11b: Sent: a cancelled request is labelled Expired",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /every state verbatim/,
    patch: (t) =>
      sub(
        t,
        "{copy.STATE[request.state]}",
        '{request.state === "cancelled" ? copy.STATE.expired : copy.STATE[request.state]}',
      ),
  },
  {
    id: "MU-4116",
    title:
      "WEB-11b: the Requests entry claims a count of 0 before any read answered",
    file: "src/features/people/requests/entries.tsx",
    tests: [SCREEN],
    expect: /no count before a successful read/,
    patch: (t) =>
      sub(
        t,
        "  const count = shown?.value.ok ? shown.value.value.length : null;\n",
        "  const count = shown?.value.ok ? shown.value.value.length : 0;\n",
      ),
  },
  {
    id: "MU-4117",
    title:
      "WEB-11b: offline, the incoming list is not said to need a connection",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /offline: unavailable/,
    patch: (t) =>
      sub(
        t,
        '        <p className="text-[13.5px] text-ink-1" data-requests-state="offline">',
        '        <p className="text-[13.5px] text-ink-1" data-requests-state="loading">',
      ),
  },
  {
    id: "MU-4118",
    title: "WEB-11b: a sender Atlas cannot name is shown by their account id",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, SCREEN],
    expect: /never the id|never by id/,
    patch: (t) =>
      sub(
        t,
        "    if (summary.owner.account_id === senderId) return summary.owner.username;\n  return null;\n",
        "    if (summary.owner.account_id === senderId) return summary.owner.username;\n  return senderId;\n",
      ),
  },
  {
    id: "MU-4119",
    title: "WEB-11b: the recipient is not checked again before request_link",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /an account that no longer exists sends nothing/,
    patch: (t) =>
      sub(
        t,
        "if (same.length !== 1 || same[0]?.id !== recipient.id) {",
        "if (false) {",
      ),
  },
  {
    id: "MU-4120",
    title:
      "WEB-11b: the re-check accepts the same username naming ANOTHER account",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /naming ANOTHER account sends nothing/,
    patch: (t) =>
      sub(
        t,
        "if (same.length !== 1 || same[0]?.id !== recipient.id) {",
        "if (same.length !== 1) {",
      ),
  },
  {
    id: "MU-4121",
    title:
      "WEB-11b: a people command that was sent does not invalidate the reads shown (the lists are not read again)",
    file: "src/features/people/online.ts",
    tests: [SCREEN],
    expect:
      /Decline sends accept:false; a 404|exactly once|sends respond_request without a token, once/,
    patch: (t) =>
      sub(
        t,
        "  if (sentSomething(result)) memory.invalidateSummaries();\n",
        "  void sentSomething;\n",
      ),
  },
  {
    id: "MU-4123",
    title:
      "WEB-11b: Decline is sent while an earlier Accept's outcome is uncertain (two contradictory answers)",
    file: "src/features/people/requests/MergeDialog.tsx",
    tests: [SCREEN],
    expect: /a Decline meanwhile is refused/,
    patch: (t) =>
      sub(t, "if (earlier !== null && earlier !== accept) {", "if (false) {"),
  },
  {
    id: "MU-4124",
    title:
      "WEB-11b: Try again rebuilds the command from what is known now (a new request id and key) instead of the retained attempt",
    file: "src/features/people/requests/commands.ts",
    tests: [SCREEN],
    expect: /the same request id/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    const prepared = retained === null ? prepare() : null;\n",
          "    const prepared = prepare();\n",
        ),
        "    return retained !== null\n      ? await replayOnline(env, key, retained, send)\n      : await sendOnline(env, key, body, send);\n",
        "    void replayOnline;\n    memory.attempts.delete(key);\n    return await sendOnline(env, key, body, send);\n",
      ),
  },
  {
    id: "MU-4126",
    title: "WEB-11b: Ask to link offers people the reader does not own",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /only owned, unlinked, unarchived people are offered/,
    patch: (t) =>
      sub(
        t,
        '          summary.your_access === "owner" &&\n',
        "          true &&\n",
      ),
  },
  {
    id: "MU-4128",
    title:
      "WEB-11b: a merged alias's Archive/Restore stays enabled (it would act on the canonical person)",
    file: "src/features/people/detail/IdentityHeader.tsx",
    tests: [DIALOG],
    expect: /a merged alias/,
    patch: (t) =>
      sub(t, "  if (isMergedAlias(person) !== null)\n", "  if (false)\n"),
  },
  {
    id: "MU-4129",
    title: "WEB-11b: time left treats expires_at (seconds) as milliseconds",
    file: "src/features/people/model/requests.ts",
    tests: [MODEL, SCREEN],
    expect: /time left|rows by expiry with time left/,
    patch: (t) =>
      sub(
        t,
        "  const left = expiresAtSeconds * 1000 - nowMs;\n",
        "  const left = expiresAtSeconds - nowMs;\n",
      ),
  },
  {
    id: "MU-4130",
    title:
      "WEB-11b: a successful request_link clears input chosen after it was captured",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /a success clears only what it sent/,
    patch: (t) =>
      sub(
        t,
        "      if (draftOf(env).revision === captured)\n",
        "      if (captured === captured)\n",
      ),
  },
  {
    id: "MU-4135",
    title:
      "WEB-11b: Ask to merge's two pickers share one read (the second keeps the first one's owner-only rows)",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /'The same person' then offers anyone visible but the first/,
    patch: (t) =>
      sub(
        t,
        "    `picker:${scope}:${purpose}:${pages}`,\n",
        "    `picker:${scope}:${pages}`,\n",
      ),
  },
];

const SPEC = "tests/e2e/fixture.people-requests.spec.ts";

export const ENGINE_WEB11B = [
  {
    id: "MU-4131",
    title:
      "WEB-11b N-R1: (REAL ENGINE) the remounted merge dialog does not offer its retained uncertain merge (it is not kept for the route)",
    file: "src/features/people/requests/MergeDialog.tsx",
    spec: SPEC,
    grep: "E-R13:",
    expect:
      /E-R13: .*an uncertain merge: the remounted dialog says it may have happened/,
    patch: (t) =>
      sub(
        t,
        "  const key = mergeKey(sourceId, targetId);\n  const view = useMergePreview(env, sourceId, targetId);\n",
        '  const key = mergeKey(sourceId, targetId);\n  const view = useMergePreview(env, sourceId, targetId);\n  if (typeof window !== "undefined") env.memory.attempts.delete(key);\n',
      ),
  },
  {
    id: "MU-4132",
    title:
      "WEB-11b N-R2: (REAL ENGINE) after a 409 the recipient's Accept carries the token of the FIRST preview shown",
    file: "src/features/people/requests/MergeDialog.tsx",
    spec: SPEC,
    grep: "E-R5:",
    expect: /E-R5: .*409 on accept/,
    patch: (t) =>
      sub(
        t,
        "        recipientToken: drawnPreview.token,\n",
        "        recipientToken: ((globalThis as { __firstToken?: string }).__firstToken ??= drawnPreview.token),\n",
      ),
  },
  {
    id: "MU-4133",
    title:
      "WEB-11b N-R3: (REAL ENGINE) the consequence note comes AFTER the merge action (DOM and focus order)",
    file: "src/features/people/requests/MergeDialog.tsx",
    spec: SPEC,
    grep: "E-R9:",
    expect: /E-R9: /,
    patch: (t) =>
      sub(
        sub(
          t,
          "        <Comparison preview={preview} />\n        <ConflictNote preview={preview} />\n        <FreezeNote id={consequence} freezes={preview.freezes_field_policies} />\n      </>\n    );\n    const label",
          "        <Comparison preview={preview} />\n        <ConflictNote preview={preview} />\n      </>\n    );\n    const label",
        ),
        "            {retained ? copy.TRY_AGAIN : label}\n          </Button>\n        )}\n      </>\n    );\n  }\n",
        "            {retained ? copy.TRY_AGAIN : label}\n          </Button>\n        )}\n        <FreezeNote id={consequence} freezes={preview.freezes_field_policies} />\n      </>\n    );\n  }\n",
      ),
  },
  {
    id: "MU-4134",
    title:
      "WEB-11b N-R4: (REAL ENGINE) request_link is sent without waiting for the recipient's re-check (the lookup follows the command)",
    file: "src/features/people/requests/NewRequest.tsx",
    spec: SPEC,
    grep: "E-R8:",
    expect: /E-R8: /,
    patch: (t) =>
      sub(
        t,
        "      const verified = await untilSent(\n",
        "      setTimeout(() => void env.sharing.lookup(recipient.username), 300);\n      const verified = await ((..._ignored: unknown[]) =>\n        Promise.resolve({ ok: true as const, value: [recipient] }))(\n",
      ),
  },
];

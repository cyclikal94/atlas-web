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
const RETRY = "tests/features/people/request-retry.test.tsx";
const OWNED = "tests/features/people/merge-name-ownership.test.tsx";
const NAME = "tests/features/people/merge-name.test.ts";

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
        "        body: drawnPreview.requires_approval\n          ? requestMergeBody({",
        "        body: false\n          ? requestMergeBody({",
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
        "        body: drawnPreview.requires_approval\n          ? requestMergeBody({",
        "        body: true\n          ? requestMergeBody({",
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
        "    const result =\n      retained !== null\n        ? await replayOnline(env, key, retained, send)\n        : await sendOnline(env, key, made?.body, send);\n",
        "    void replayOnline;\n    memory.attempts.delete(key);\n    const result = await sendOnline(env, key, made?.body, send);\n",
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
        "    if (draft.revision === origin.revision) {\n",
        "    if (origin.revision === origin.revision) {\n",
      ),
  },
  {
    id: "MU-4135",
    title:
      "WEB-11b: Ask to merge's two pickers share one read (the second keeps the first one's owner-only rows)",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /'The same person' then offers anyone visible but the first/,
    // Re-anchored in revision 2: the picker's read is now OWNED (released when it closes), which by itself keeps the two pickers apart; the
    // same defect needs both its key without the purpose AND an unowned (shared, never released) read, as before revision 2.
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            'import { useOwnedSummary, type WalkedPages, walkPages } from "../summaries";\n',
            'import { useOwnedSummary, useSummary, type WalkedPages, walkPages } from "../summaries";\n',
          ),
          "  const view = useOwnedSummary<WalkedPages<PersonSummary>>(\n",
          "  const view = useSummary<WalkedPages<PersonSummary>>(\n",
        ),
        '    `picker:${scope}:${purpose}:${owner}:${start ?? ""}:${pages}`,\n',
        '    `picker:${scope}:${start ?? ""}:${pages}`,\n',
      ),
  },
  // ---- revision 1 (review 1 of 2 November 2026, R1–R4): one mutant per corrected mechanism ----
  {
    id: "MU-4136",
    title:
      "WEB-11b R1: a replayed link request completes with the form shown at Try again (announces the newer recipient, clears the newer input)",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /the recipient changed between attempts/,
    patch: (t) =>
      sub(
        t,
        "    completeLink(env, key, sent, announce);\n",
        "    completeLink(\n      env,\n      key,\n      sent === null ? null : { ...sent, origin: capture },\n      announce,\n    );\n",
      ),
  },
  {
    id: "MU-4137",
    title:
      "WEB-11b R1: a replayed merge announces the name chosen at Try again, not the name its attempt carried",
    file: "src/features/people/requests/MergeDialog.tsx",
    tests: [DIALOG],
    expect: /R1: a replayed merge completes as ITS attempt/,
    patch: (t) =>
      sub(
        t,
        '          announcer.announce(copy.MERGED_INTO(origin.name), "polite");\n',
        '          announcer.announce(\n            copy.MERGED_INTO(preview ? nameOf(preview, chosen) : origin.name),\n            "polite",\n          );\n',
      ),
  },
  {
    id: "MU-4138",
    title:
      "WEB-11b R1: an uncertain link request for a person the form no longer shows is not offered (unreachable once the person changes)",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /the person changed after an uncertain send/,
    patch: (t) =>
      sub(
        t,
        "  const others = retainedKeys(env, LINK_PREFIX).filter(\n",
        "  const others = ([] as string[]).filter(\n",
      ),
  },
  {
    id: "MU-4139",
    title:
      "WEB-11b R2: the picker offers no continuation after three pages (people after the 300th are unreachable)",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /301 people/,
    patch: (t) =>
      sub(t, "          ) : more ? (\n", "          ) : false ? (\n"),
  },
  {
    id: "MU-4140",
    title:
      "WEB-11b R2: a partly read list is treated as exhausted (no match / none offered claimed for people never read)",
    file: "src/features/people/requests/NewRequest.tsx",
    tests: [SCREEN],
    expect: /301 people|all filtered out/,
    patch: (t) =>
      sub(
        t,
        "  const whole = starts.length === 1 && shown !== null && shown.end;\n",
        "  const whole = shown !== null;\n",
      ),
  },
  {
    id: "MU-4141",
    title:
      "WEB-11b R3: below 1280 px the Requests entry exists only while requests wait (Sent and New request unreachable from People)",
    file: "src/features/people/requests/entries.tsx",
    tests: [SCREEN],
    expect: /none waiting, unknown and offline/,
    patch: (t) =>
      sub(
        t,
        '  if (mode === "desktop" || count === null || count < 1) return entry;\n',
        '  if (mode === "desktop") return entry;\n  if (count === null || count < 1) return null;\n',
      ),
  },
  {
    id: "MU-4142",
    title:
      "WEB-11b R4: a retained uncertain cancel loses its Try again once the row is no longer pending",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /that committed \(the row now says Cancelled\)/,
    patch: (t) =>
      sub(
        t,
        "            {retained ? action : null}\n",
        "            {null}\n",
      ),
  },
  {
    id: "MU-4143",
    title:
      "WEB-11b R4: a row's Try again after an uncertain Decline is wired to Accept (the kept answer is not what it dispatches)",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /an uncertain Decline whose row is still listed/,
    patch: (t) =>
      sub(
        t,
        "  const kept = retainedAnswer(env, key);\n",
        "  const kept = retainedAnswer(env, key) === null ? null : true;\n",
      ),
  },
  {
    id: "MU-4144",
    title:
      "WEB-11b R4: an unlisted request's retained answer is offered only while its report is kept (dismissing the report hides it)",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /that committed \(the row is gone\)/,
    patch: (t) => sub(t, "      ...retainedKeys(env, RESPOND_PREFIX),\n", ""),
  },
  // ---- revision 1, N1 (found by the I-PPL21 both-linked case against the released backend) ----
  {
    id: "MU-4148",
    title:
      "WEB-11b N1: a preview refused 403 is not remembered (asked again after every remount: an unbounded request storm)",
    file: "src/features/people/requests/reads.ts",
    tests: [DIALOG],
    expect:
      /a remount and an invalidation do not ask again|a 403 review is remembered/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored in revision 2 (the refusal now has its own store and owner): the same defect, no 403 is remembered.
        '  if (!result.ok && result.kind === "forbidden")\n    memory.requestRefusals.set(key, {\n      refusal: { ...result, kind: "forbidden" },\n      dispatch,\n    });\n',
        '  if (!result.ok && result.kind === "forbidden") {\n  }\n',
      ),
  },
  {
    id: "MU-4149",
    title:
      "WEB-11b N1: the recipient's review reads the lists again on ANY refusal (a 403 does so on every remount)",
    file: "src/features/people/requests/MergeDialog.tsx",
    tests: [DIALOG],
    expect: /a 403 review is remembered/,
    patch: (t) =>
      sub(
        t,
        '    !drawn.value.ok &&\n    (drawn.value.refusal.kind === "not_found" ||\n      drawn.value.refusal.kind === "expired")\n      ? drawn.value.refusal.kind\n',
        "    !drawn.value.ok\n      ? drawn.value.refusal.kind\n",
      ),
  },
  {
    id: "MU-4151",
    title:
      "WEB-11b R7: an OBSOLETE answer counts (a 403 released after a newer dispatch answered is remembered and refuses the next read)",
    file: "src/features/people/requests/reads.ts",
    tests: [DIALOG, SCREEN],
    expect: /S1 sender|S1 recipient|incoming S1|Sent S1/,
    patch: (t) =>
      sub(
        t,
        "  if (ledger === undefined || dispatch <= ledger.answered) return;\n",
        "  if (ledger === undefined) return;\n",
      ),
  },
  {
    id: "MU-4152",
    title:
      "WEB-11b R7/N1: a 403 is remembered only if no invalidation came since its dispatch (its own re-evaluation supersedes it: the storm returns)",
    file: "src/features/people/requests/reads.ts",
    tests: [DIALOG],
    expect: /storm ordering/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  const dispatch = ledger.issued;\n",
          "  const dispatch = ledger.issued;\n  const generation = memory.summaryGeneration;\n",
        ),
        "    noteAnswer(memory, key, dispatch, result);\n",
        "    if (memory.summaryGeneration === generation)\n      noteAnswer(memory, key, dispatch, result);\n",
      ),
  },
  {
    id: "MU-4153",
    title:
      "WEB-11b R7: an explicit Try again does not retire the dispatches before it (a 403 sent before it is remembered afterwards)",
    file: "src/features/people/requests/reads.ts",
    tests: [SCREEN],
    expect: /incoming S4/,
    patch: (t) =>
      sub(
        t,
        "  if (ledger !== undefined) ledger.answered = ledger.issued;\n",
        "",
      ),
  },
  {
    id: "MU-4154",
    title:
      "WEB-11b R7: a remembered refusal is shown while a NEWER dispatch of its key is still on its way",
    file: "src/features/people/requests/reads.ts",
    tests: [DIALOG],
    expect: /S2 sender/,
    patch: (t) =>
      sub(
        t,
        "      latest.dispatch > refused.dispatch\n",
        "      latest.dispatch < 0\n",
      ),
  },
  {
    id: "MU-4155",
    title:
      "WEB-11b R7: a newer success does not end the refusal an earlier dispatch remembered (it refuses the next read)",
    file: "src/features/people/requests/reads.ts",
    tests: [DIALOG],
    expect: /S2 sender/,
    patch: (t) => sub(t, "  else memory.requestRefusals.delete(key);\n", ""),
  },
  {
    id: "MU-4156",
    title:
      "WEB-11b R2: an owned summary is never released (every window, Show more and closed picker keeps its walk)",
    file: "src/features/people/summaries.tsx",
    tests: [SCREEN],
    expect: /R2 \(review 2\)/,
    patch: (t) =>
      sub(
        t,
        "    return () => releaseSummary(memory, key);\n",
        "    return;\n",
      ),
  },
  {
    id: "MU-4157",
    title:
      "WEB-11b DA-N1: Sent keeps every page visited (moving to another page does not let go of the one shown)",
    file: "src/features/people/requests/RequestsScreen.tsx",
    tests: [SCREEN],
    expect: /seven pages forward|S9: an uncertain cancel/,
    patch: (t) =>
      sub(t, "    releaseSummary(env.memory, sentKey(after));\n", ""),
  },
  // ---- revision 3 (review 3, R7: every failed request read's Try again retires before it reads) ----
  {
    id: "MU-4159",
    title:
      "WEB-11b R7 (review 3): the sender's comparison offers the bare forced read as its failed Try again (no retirement: an obsolete 403 refuses the retry or comes back after it)",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 sender|Q2 sender/,
    patch: (t) =>
      sub(
        t,
        "  return useRequestRead(\n    env,\n    previewKey(sourceId, targetId),\n",
        "  return useSummary(previewKey(sourceId, targetId), (current) =>\n    asRead(\n      env,\n      previewKey(sourceId, targetId),\n      () => env.api.previewMerge(sourceId, targetId),\n      current,\n      true,\n    ),\n  );\n  return useRequestRead(\n    env,\n    previewKey(sourceId, targetId),\n",
      ),
  },
  {
    id: "MU-4160",
    title:
      "WEB-11b R7 (review 3): the recipient's review offers the bare forced read as its failed Try again",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 recipient|Q2 recipient/,
    patch: (t) =>
      sub(
        t,
        "  return useRequestRead(\n    env,\n    reviewKey(requestId),\n",
        "  return useSummary(reviewKey(requestId), (current) =>\n    asRead(\n      env,\n      reviewKey(requestId),\n      () => env.api.readRecipientPreview(requestId),\n      current,\n      true,\n    ),\n  );\n  return useRequestRead(\n    env,\n    reviewKey(requestId),\n",
      ),
  },
  {
    id: "MU-4161",
    title:
      "WEB-11b R7 (review 3): the incoming list offers the bare forced read as its failed Try again",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 incoming|Q2 incoming/,
    patch: (t) =>
      sub(
        t,
        "  return useRequestRead(env, INCOMING_KEY, () => env.api.readRequests(), false);\n",
        "  return useSummary(INCOMING_KEY, (current) =>\n    asRead(env, INCOMING_KEY, () => env.api.readRequests(), current, false),\n  );\n",
      ),
  },
  {
    id: "MU-4162",
    title:
      "WEB-11b R7 (review 3): a Sent page offers the bare forced read as its failed Try again (the first page and every later one)",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 Sent|Q2 Sent/,
    patch: (t) =>
      sub(
        t,
        "  return useRequestRead(\n    env,\n    sentKey(after),\n",
        "  return useSummary(sentKey(after), (current) =>\n    asRead(\n      env,\n      sentKey(after),\n      () => env.api.readSentRequests({ after, limit: SENT_LIMIT }),\n      current,\n      false,\n    ),\n  );\n  return useRequestRead(\n    env,\n    sentKey(after),\n",
      ),
  },
  {
    id: "MU-4163",
    title:
      "WEB-11b R7 (review 3): the explicit retry is not bound to a failed entry (a second press of the same button retires the read the first press made: its own 403 is forgotten and asked again)",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q8 |not failed/,
    patch: (t) =>
      sub(
        t,
        '    !env.online ||\n    memory.summaries.get(key)?.state.kind !== "failed"\n',
        "    !env.online\n",
      ),
  },
  {
    id: "MU-4164",
    title:
      "WEB-11b R7 (review 3): a retry kept from before another identity was shown still retires and reads",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /another identity/,
    patch: (t) =>
      sub(
        t,
        "    !isCurrentMemory(memory) ||\n    !env.online ||\n",
        "    !env.online ||\n",
      ),
  },
  {
    id: "MU-4165",
    title:
      "WEB-11b R7 (review 3): offline, the explicit retry still retires the refusal",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /offline: nothing is retired/,
    patch: (t) =>
      sub(
        t,
        "    !isCurrentMemory(memory) ||\n    !env.online ||\n",
        "    !isCurrentMemory(memory) ||\n",
      ),
  },
  {
    id: "MU-4166",
    title:
      "WEB-11b R7 (review 3): the retry reads FIRST and retires after (the read finds the obsolete refusal; its own answer is made obsolete)",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 |Q8 |BEFORE the forced read/,
    patch: (t) =>
      sub(
        t,
        "  retire(memory, key);\n  forced();\n",
        "  forced();\n  retire(memory, key);\n",
      ),
  },
  {
    id: "MU-4167",
    title:
      "WEB-11b R7 (review 3): the retry retires another key (the incoming list's) instead of its own",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 sender|Q1 recipient|Q1 Sent/,
    patch: (t) =>
      sub(
        t,
        "  retire(memory, key);\n  forced();\n",
        "  retire(memory, INCOMING_KEY);\n  forced();\n",
      ),
  },
  {
    id: "MU-4168",
    title:
      "WEB-11b R7 (review 3): an explicit retry keeps the remembered refusal (it only makes earlier dispatches obsolete)",
    file: "src/features/people/requests/reads.ts",
    tests: [RETRY],
    expect: /Q1 /,
    patch: (t) =>
      sub(
        t,
        "  memory.requestRefusals.delete(key);\n  const ledger",
        "  const ledger",
      ),
  },
  // ---- revision 4 (review 4, R1: the sender's name choice is owned by its edit; requests/mergeName.ts) ----
  {
    id: "MU-4171",
    title:
      "WEB-11b R1 (review 4): a sender's success consumes the pair's name choice unconditionally (a choice made after its capture is lost)",
    file: "src/features/people/requests/mergeName.ts",
    tests: [OWNED, NAME],
    expect:
      /S03 .*a choice made while the command is held survives its success|S04 .*the earlier success keeps the newer visible choice|S06: an uncertain merge, a newer choice|a newer record \(even of the same value\) is kept/,
    patch: (t) =>
      sub(
        t,
        '  if (owned === null || memory.drafts.get(owned.key) !== owned) return "kept";\n',
        '  if (owned === null) return "kept";\n',
      ),
  },
  {
    id: "MU-4172",
    title:
      "WEB-11b R1 (review 4): a success compares the name choice by VALUE, not by its edit (changed away and back, the newer edit is consumed)",
    file: "src/features/people/requests/mergeName.ts",
    tests: [OWNED, NAME],
    expect:
      /S08: changed away and back to the captured value|a newer record \(even of the same value\) is kept/,
    patch: (t) =>
      sub(
        t,
        '  if (owned === null || memory.drafts.get(owned.key) !== owned) return "kept";\n',
        '  const now = memory.drafts.get(owned?.key ?? "") as MergeNameDraft | undefined;\n  if (owned === null || now?.choice !== owned.choice) return "kept";\n',
      ),
  },
  {
    id: "MU-4173",
    title:
      "WEB-11b R1 (review 4): a merge's success adopts the name choice current when it completes or is tried again, not the one its attempt captured",
    file: "src/features/people/requests/MergeDialog.tsx",
    tests: [OWNED, DIALOG],
    expect:
      /S06: an uncertain merge, a newer choice, then Try again|S07: uncertain, a newer choice|R1: a replayed merge completes as ITS attempt/,
    patch: (t) =>
      sub(
        t,
        "      consumeMergeName(memory, origin?.draft ?? null);\n",
        "      consumeMergeName(memory, mergeNameDraft(memory, sourceId, targetId));\n",
      ),
  },
  {
    id: "MU-4174",
    title:
      "WEB-11b R1 (review 4): a success never consumes the name choice it was made of (an unchanged choice outlives its own success)",
    file: "src/features/people/requests/mergeName.ts",
    tests: [OWNED, NAME],
    expect:
      /S01\/S02 .*the unchanged chosen name is sent, said and consumed|its own, still current record: consumed/,
    patch: (t) => sub(t, "  memory.drafts.delete(owned.key);\n", ""),
  },
  {
    id: "MU-4175",
    title:
      "WEB-11b R1 (review 4): the cleanup does not check that its memory is still the identity's current one (a continuation of another identity acts)",
    file: "src/features/people/requests/mergeName.ts",
    tests: [NAME],
    expect: /a continuation of a replaced memory \(another identity\)/,
    patch: (t) =>
      sub(t, '  if (!isCurrentMemory(memory)) return "stale";\n', ""),
  },
  {
    id: "MU-4176",
    title:
      "WEB-11b R1 (review 4): a consumed name choice is removed without notifying its readers (another mount keeps showing it)",
    file: "src/features/people/requests/mergeName.ts",
    tests: [NAME],
    expect: /its own, still current record: consumed, and readers are notified/,
    patch: (t) =>
      sub(
        t,
        '  memory.touch();\n  return "consumed";\n',
        '  return "consumed";\n',
      ),
  },
  {
    id: "MU-4177",
    title:
      "WEB-11b R1 (review 4): a press captures the pair's current name choice even when its render drew an earlier one (a stale render's ticket)",
    file: "src/features/people/requests/mergeName.ts",
    tests: [NAME],
    expect:
      /a stale render \(its record is no longer the current one\) captures nothing/,
    patch: (t) => sub(t, "  if (current !== rendered) return null;\n", ""),
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
  // ---- revision 1 (review 1, R5 and R6) ----
  {
    id: "MU-4145",
    title:
      "WEB-11b R5: (REAL ENGINE) a comparison cell's value keeps its unbroken minimum width (a long value spills out of its column)",
    file: "src/features/people/requests/MergeDialog.tsx",
    spec: SPEC,
    grep: "E-R15b:",
    expect: /E-R15b: /,
    patch: (t) =>
      sub(
        t,
        "  return <FieldValueView raw={cell.row.value} anywhere />;\n",
        "  return <FieldValueView raw={cell.row.value} />;\n",
      ),
  },
  {
    id: "MU-4146",
    title:
      "WEB-11b R5: (REAL ENGINE) the comparison's columns are not bounded (laid out automatically, a column is squeezed beside a long value)",
    file: "src/features/people/requests/MergeDialog.tsx",
    spec: SPEC,
    grep: "E-R15b:",
    expect: /E-R15b: /,
    patch: (t) =>
      sub(t, '      style={{ tableLayout: "fixed" }}\n', "")
        .replace('style={{ width: "28%" }}', "")
        .replaceAll('style={{ width: "36%" }}', ""),
  },
  {
    id: "MU-4147",
    title:
      "WEB-11b R6/A10: (REAL ENGINE) the people page memory is not replaced when another account is displayed (the held read of the first account is applied under the next)",
    file: "src/features/people/memory.ts",
    spec: SPEC,
    grep: "E-R14:",
    expect: /E-R14: .*another tab signs in as someone else/,
    patch: (t) =>
      sub(
        t,
        "  if (current === null || current.identity !== identity) {\n",
        "  if (current === null) {\n",
      ),
  },
  {
    id: "MU-4150",
    title:
      "WEB-11b N1: (REAL ENGINE) a preview refused 403 is not remembered: the production session's re-evaluation remounts the tree and it is asked again, without end",
    file: "src/features/people/requests/reads.ts",
    spec: SPEC,
    grep: "E-R17:",
    expect: /E-R17: /,
    patch: (t) =>
      sub(
        t,
        // Re-anchored in revision 2 (the refusal now has its own store and owner): the same defect, no 403 is remembered.
        '  if (!result.ok && result.kind === "forbidden")\n    memory.requestRefusals.set(key, {\n      refusal: { ...result, kind: "forbidden" },\n      dispatch,\n    });\n',
        '  if (!result.ok && result.kind === "forbidden") {\n  }\n',
      ),
  },
  {
    id: "MU-4158",
    title:
      "WEB-11b R7: (REAL ENGINE) an OBSOLETE 403 counts: released after a newer comparison was read, it is remembered and refuses the next read",
    file: "src/features/people/requests/reads.ts",
    spec: SPEC,
    grep: "E-R18:",
    expect: /E-R18: /,
    patch: (t) =>
      sub(
        t,
        "  if (ledger === undefined || dispatch <= ledger.answered) return;\n",
        "  if (ledger === undefined) return;\n",
      ),
  },
  {
    id: "MU-4169",
    title:
      "WEB-11b R7 (review 3): (REAL ENGINE) the sender's comparison offers the bare forced read as its failed Try again: a 403 dispatched before it, answered after it, is remembered and refuses the next read",
    file: "src/features/people/requests/reads.ts",
    spec: SPEC,
    grep: "E-R20:",
    expect: /E-R20: .*the sender's comparison/,
    patch: (t) =>
      sub(
        t,
        "  return useRequestRead(\n    env,\n    previewKey(sourceId, targetId),\n",
        "  return useSummary(previewKey(sourceId, targetId), (current) =>\n    asRead(\n      env,\n      previewKey(sourceId, targetId),\n      () => env.api.previewMerge(sourceId, targetId),\n      current,\n      true,\n    ),\n  );\n  return useRequestRead(\n    env,\n    previewKey(sourceId, targetId),\n",
      ),
  },
  {
    id: "MU-4170",
    title:
      "WEB-11b R7 (review 3): (REAL ENGINE) the recipient's review offers the bare forced read as its failed Try again: a 403 dispatched before it, answered after it, is remembered and refuses the next read",
    file: "src/features/people/requests/reads.ts",
    spec: SPEC,
    grep: "E-R20:",
    expect: /E-R20: .*the recipient's review/,
    patch: (t) =>
      sub(
        t,
        "  return useRequestRead(\n    env,\n    reviewKey(requestId),\n",
        "  return useSummary(reviewKey(requestId), (current) =>\n    asRead(\n      env,\n      reviewKey(requestId),\n      () => env.api.readRecipientPreview(requestId),\n      current,\n      true,\n    ),\n  );\n  return useRequestRead(\n    env,\n    reviewKey(requestId),\n",
      ),
  },
  // ---- revision 4 (review 4, R1) ----
  {
    id: "MU-4178",
    title:
      "WEB-11b R1 (review 4): (REAL ENGINE) a sender's success consumes the pair's name choice unconditionally: a comparison reopened and changed while the request is held loses the newer choice",
    file: "src/features/people/requests/mergeName.ts",
    spec: SPEC,
    grep: "E-R21:.*the earlier success",
    expect: /E-R21: .*the earlier success keeps the newer visible choice/,
    patch: (t) =>
      sub(
        t,
        '  if (owned === null || memory.drafts.get(owned.key) !== owned) return "kept";\n',
        '  if (owned === null) return "kept";\n',
      ),
  },
];

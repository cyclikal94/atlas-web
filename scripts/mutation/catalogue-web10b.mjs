// WEB-10b's mutants (plan §7.4: finite and targeted; the full catalogues stay WEB-17's), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Each names the test written for its defect (`expect`, matched
// against an ASSERTION failure's full name). `sub` is the catalogue's own exactly-one-occurrence patcher.
//
// Departures from the plan's table, recorded in .agtx/execute.md and docs/lists.md: MU-2523 is re-expressed (an `archive` of a task now
// delegates to `archiveResource`, so "the task builder for a list row" is an equivalent mutant; the defect that remains possible is a
// rebuild that refuses a list row). N-LS1 (the certificate) and N-LS2 (list_item without `requiresEdit`) are unit mutants (MU-2535; MU-2506
// and MU-2536 for `edit_list`) AND, since revision 1 (review R5), real-engine mutants (MU-2547, MU-2548) caught by E-LS8 (a)/(b), which
// order a real commit of the fixture leader between two stages of one read, and behind a stale admission, by transaction creation order.
// The real-engine mutants are MU-2534 (N-LS3), MU-2537, MU-2538, MU-2547 (N-LS1), MU-2548 (N-LS2), and (revision 2) MU-2560 and MU-2561
// over E-LS11. Revision 1 re-expressed MU-2518,
// MU-2526 and MU-2534 against the save settlement that replaced their anchors (R1), and added MU-2539..MU-2546, MU-2549 and MU-2550
// for R1-R4. Revision 2 (review 2 R1/R2, design assessment Q5) re-anchors MU-2515..MU-2517, MU-2526, MU-2534, MU-2539..MU-2541 and
// MU-2544 (same intents) on the one-transition settlement and the picker's selections, and adds MU-2551..MU-2559 and MU-2562 for their mechanisms and
// the real-engine MU-2560 (MU-2551's patch) and MU-2561 (MU-2544's). Revision 3 (D1, the approved earlier-outcome-unknown flow) re-anchors
// MU-2516..MU-2518, MU-2526, MU-2539, MU-2557..MU-2559 and MU-2562 on the read-only look-up and the attempts kept apart from the input (same
// intents, MU-2518 and MU-2557..MU-2559/MU-2562 re-expressed where the retry they named is now a look-up), and adds MU-2563..MU-2575 for
// the D1 guards and the real-engine MU-2576 (an ordinary Save sends a create's attempt again) and MU-2577 (MU-2563's patch) over E-LS12.
// Revision 4 (review 4, D1 / DA-N1: an add waits for the task's CURRENT create) re-anchors MU-2515 (on `ListActions.prepareAdd`) and
// MU-2543 (the refusal now carries its reason), and adds MU-2578..MU-2583 for the admission read and its observation, and the
// real-engine MU-2584 (MU-2578's patch) and MU-2585 (MU-2579's) over E-LS13.
import { sub } from "./data-catalogue.mjs";

const LISTS = "src/features/tasks/model/lists.ts";
const VIEW = "src/features/tasks/model/list-view.ts";
const REGISTER = "src/features/tasks/register.ts";
const READS = "src/features/tasks/lists/reads.ts";
const DIALOGS = "src/features/tasks/lists/dialogs.tsx";
const PICKER = "src/features/tasks/lists/TaskPicker.tsx";
const KEPT = "src/features/tasks/kept-input.ts";
const DRAFT_READ = "src/data/ui/draft-read.ts";
const DRAFT_HEADER = "src/data/plans/draft-header.ts";
const LIST_ACTIONS = "src/features/tasks/lists/actions.ts";
const DETAIL = "src/features/tasks/lists/ListDetail.tsx";
const LAYOUT = "src/features/tasks/lists/ListsLayout.tsx";
const T = (name) => `tests/features/tasks/${name}`;
const MODEL_TEST = T("lists-model.test.ts");
const VIEW_TEST = T("list-view.test.ts");
const REGISTER_TEST = T("lists-register.test.ts");
const SCREENS_TEST = T("lists-screens.test.tsx");
const DIALOGS_TEST = T("lists-dialogs.test.tsx");
const READS_TEST = T("lists-reads.test.tsx");
const ATTEMPTS_TEST = T("lists-attempts.test.tsx");
const ROUTES_TEST = T("lists-routes.test.tsx");
const SETTLEMENT_TEST = T("kept-settlement.test.tsx");
const ADMISSION_TEST = T("lists-admission.test.tsx");
const ACTIONS = "src/features/tasks/actions.ts";
const LIST_ITEM_TARGETS =
  "    targets: [primary(input.listId)],\n    ...(input.after ? { dependsOnExtra: [input.after] } : {}),\n";
const EDIT_LIST_TARGETS =
  '    targets: [primary(input.listId)],\n    ...(input.localId === undefined ? {} : { localId: input.localId }),\n    build: (bases: Bases) => ({\n      command: {\n        command: {\n          kind: "edit_list",';
const WITHHELD_OPEN =
  '                      <span\n                        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[14px] text-ink-2"\n                        data-list-withheld=""\n                      >';
const WITHHELD_CLOSE =
  "                          {DETAIL.withheldTag}\n                        </span>\n                      </span>\n                    )}";
const withheldAsLink = (t) =>
  sub(
    sub(
      t,
      WITHHELD_OPEN,
      '                      <Link\n                        to="/tasks/$taskId"\n                        params={{ taskId: item.id }}\n                        search={{}}\n                        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[14px] text-ink-2"\n                        data-list-withheld=""\n                      >',
    ),
    WITHHELD_CLOSE,
    "                          {DETAIL.withheldTag}\n                        </span>\n                      </Link>\n                    )}",
  );
const pickerOffersMembers = (t) =>
  sub(
    t,
    "        !row.archived &&\n        !options.excluded.has(row.id) &&\n",
    "",
  );
/** Review 2 R1: the editor mounted when a save settles keeps its own (stale) value; only its busy state and note follow the session. */
const staleSettledValue = (t) =>
  sub(
    t,
    "            : { key, value: entry.value, busy: false, note: entry.note },",
    "            : { ...s, busy: false, note: entry.note },",
  );
/** Review 2 R2: an add's id belongs to the task for the session (the revision-1 lifetime), not to the selection. */
const idPerTask = (t) =>
  sub(
    sub(
      t,
      "  const latest = useRef(list);\n",
      "  const latest = useRef(list);\n  const ids = useRef<Record<string, string>>({});\n",
    ),
    "        localId: env.newId(),\n",
    "        localId: (ids.current[task] ??= env.newId()),\n",
  );
const createNavigatesUngated = (t) =>
  sub(
    t,
    "      settleSave<CreateInput>(\n        ticket,",
    '      if (outcome.ok) void navigate({ to: "/tasks/lists/$listId", params: { listId } });\n      settleSave<CreateInput>(\n        ticket,',
  );

/** Revision 4: the add states nothing of what its read saw of the task (MU-2578's patch). */
const addUnobserved = (t) =>
  sub(t, "            observed: read.value.view.observation,\n", "");
/** Revision 4: a task nothing on this device makes is taken as already sent (MU-2579's patch). */
const goneTakenAsSent = (t) =>
  sub(
    t,
    '  return { kind: "gone" };\n}',
    '  return { kind: "ready", after: null };\n}',
  );

export const UNIT_WEB10B = [
  {
    id: "MU-2501",
    title:
      "WEB-10b L1: a blank name is judged by String.prototype.trim (U+FEFF called blank; the server keeps it)",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /L1: the name rule is the server's .*→ null/,
    patch: (t) =>
      sub(
        t,
        '  if (/^\\p{White_Space}*$/u.test(name)) return "blank";',
        '  if (name.trim() === "") return "blank";',
      ),
  },
  {
    id: "MU-2502",
    title:
      "WEB-10b L1: a name's length is counted in UTF-16 units, not code points",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /length is counted in code points/,
    patch: (t) =>
      sub(
        t,
        "  return [...name].length > LIST_NAME_MAX",
        "  return name.length > LIST_NAME_MAX",
      ),
  },
  {
    id: "MU-2503",
    title: "WEB-10b L2: edit_list omits expected_policy_version (Q1)",
    file: LISTS,
    tests: [MODEL_TEST],
    expect:
      /L2: every body is a valid TaskCommandInput .*edit_list|the exact bodies/,
    patch: (t) =>
      sub(t, "          expected_policy_version: input.policyVersion,\n", ""),
  },
  {
    id: "MU-2504",
    title:
      "WEB-10b L2: edit_list's expected_version is not the base the enqueue read",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /the exact bodies/,
    patch: (t) =>
      sub(
        t,
        "          expected_version: bases[input.listId] as number,\n          expected_policy_version:",
        "          expected_version: 1,\n          expected_policy_version:",
      ),
  },
  {
    id: "MU-2505",
    title:
      "WEB-10b L2: list_item is not version-checked (two adds do not chain)",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /chain their versions/,
    patch: (t) =>
      sub(
        t,
        LIST_ITEM_TARGETS,
        "    targets: [{ ...primary(input.listId), versionChecked: false }],\n    ...(input.after ? { dependsOnExtra: [input.after] } : {}),\n",
      ),
  },
  {
    id: "MU-2506",
    title:
      "WEB-10b L2/N-LS2: list_item drops requiresEdit (a known denial no longer refuses an add)",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /read-only refuses a rename, an add and an archive/,
    patch: (t) =>
      sub(
        t,
        LIST_ITEM_TARGETS,
        "    targets: [{ ...primary(input.listId), requiresEdit: false }],\n    ...(input.after ? { dependsOnExtra: [input.after] } : {}),\n",
      ),
  },
  {
    id: "MU-2507",
    title:
      "WEB-10b L2/D-10b-3: create_list captures no `list` defaults (never-fetched defaults are not held for review)",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /held for review of the `list` kind|captures the `list` defaults/,
    patch: (t) =>
      sub(
        t,
        'captureDefaults(input.defaults, ["list"])',
        "captureDefaults(input.defaults, [])",
      ),
  },
  {
    id: "MU-2508",
    title:
      "WEB-10b L3: the composition applies a capacity-refused (blocked) list_item",
    file: VIEW,
    tests: [VIEW_TEST],
    expect: /blocked \(capacity\) add is NOT applied|refused add: room for 1/,
    patch: (t) =>
      sub(
        t,
        "      refused.push(draft);\n      continue;\n    }\n    if (!APPLIED.includes(draft.status)) continue;",
        '      refused.push(draft);\n    }\n    if (!APPLIED.includes(draft.status) && draft.status !== "blocked") continue;',
      ),
  },
  {
    id: "MU-2509",
    title: "WEB-10b L3: the composition applies conflicted and rejected drafts",
    file: VIEW,
    tests: [VIEW_TEST],
    expect: /attention drafts are counted, never applied/,
    patch: (t) =>
      sub(
        t,
        '  "queued",\n  "in_flight",\n  "acknowledged",\n];',
        '  "queued",\n  "in_flight",\n  "acknowledged",\n  "version_conflict",\n  "rejected",\n];',
      ),
  },
  {
    id: "MU-2510",
    title: "WEB-10b L3: the composition ignores queue order (created_seq)",
    file: VIEW,
    tests: [VIEW_TEST],
    expect: /queue order decides/,
    patch: (t) =>
      sub(
        t,
        "    .filter((d) => d.index_targets.includes(listId))\n    .sort((a, b) => a.created_seq - b.created_seq);",
        "    .filter((d) => d.index_targets.includes(listId));",
      ),
  },
  {
    id: "MU-2511",
    title:
      "WEB-10b L10: the capacity pre-check counts the cached ids only (a pending add is not counted)",
    file: VIEW,
    tests: [VIEW_TEST, SCREENS_TEST],
    expect: /99 cached \+ 1 queued add|100 composed/,
    patch: (t) =>
      sub(
        t,
        "  (c.members?.length ?? 0) >= LIST_CAPACITY;",
        "  (parseListValue(c.row.value)?.task_ids.length ?? 0) >= LIST_CAPACITY;",
      ),
  },
  {
    id: "MU-2512",
    title: "WEB-10b L10: Add stays enabled at exactly 100",
    file: VIEW,
    tests: [VIEW_TEST, SCREENS_TEST],
    expect: /99 cached \+ 1 queued add|100 composed/,
    patch: (t) =>
      sub(
        t,
        "  (c.members?.length ?? 0) >= LIST_CAPACITY;",
        "  (c.members?.length ?? 0) > LIST_CAPACITY;",
      ),
  },
  {
    id: "MU-2513",
    title:
      "WEB-10b L9/L11: the picker offers the list's members and archived tasks",
    file: READS,
    tests: [DIALOGS_TEST],
    expect: /source: cached tasks not archived, not members/,
    patch: pickerOffersMembers,
  },
  {
    id: "MU-2514",
    title:
      "WEB-10b L9/D-10b-10: the picker's selection is not capped by the room left",
    file: PICKER,
    tests: [DIALOGS_TEST],
    expect: /selection is capped by the room left/,
    patch: (t) => sub(t, "disabled={!checked && full}", "disabled={false}"),
  },
  {
    id: "MU-2515",
    title:
      "WEB-10b L9/D-10b-11: an add of a task not sent yet does not wait for its create",
    tests: [DIALOGS_TEST],
    expect: /waits for its create/,
    // Re-anchored in revision 4 (same intent): what an add waits for is read when it is made (`ListActions.prepareAdd`).
    file: LIST_ACTIONS,
    patch: (t) =>
      sub(t, "            after: admitted.after,", "            after: null,"),
  },
  {
    id: "MU-2516",
    title:
      "WEB-10b L9: a partial Add selected clears the selections that were not saved",
    file: PICKER,
    tests: [DIALOGS_TEST],
    expect: /partial save keeps the rest selected/,
    patch: (t) =>
      sub(
        t,
        "          .filter((c) => !queued.has(c.localId) && !found.has(c.localId))",
        "          .filter(() => false)",
      ),
  },
  {
    id: "MU-2517",
    title:
      "WEB-10b L9: the picker's retry uses a new local id per task (a lost completion is added twice)",
    file: PICKER,
    tests: [DIALOGS_TEST],
    expect: /reuses each task's local id/,
    patch: (t) =>
      sub(
        t,
        "          const localId = renamed.get(choice.localId) ?? choice.localId;",
        "          const localId = crypto.randomUUID();",
      ),
  },
  {
    id: "MU-2518",
    title:
      "WEB-10b L6/D1: a create's attempt is kept under another id than the request it sent (its stored list is never recognised)",
    file: DIALOGS,
    tests: [DIALOGS_TEST],
    expect: /looked up, never sent again: found as sent/,
    // Re-expressed in revision 1 (a retry sent the bound request) and in revision 3 (D1: the retry is a look-up by the attempt's id, so
    // the defect left is an attempt that does not name the id its request was sent under).
    patch: (t) =>
      sub(
        t,
        "    const sent: Attempt = {\n      name,\n      localId: ids.localId,\n      request: createList({",
        "    const sent: Attempt = {\n      name,\n      localId: env.newId(),\n      request: createList({",
      ),
  },
  {
    id: "MU-2519",
    title:
      "WEB-10b L4: readListCurrent says inaccessible after the first collection",
    file: REGISTER,
    tests: [REGISTER_TEST],
    expect: /found in the ARCHIVED collection after the active one ended/,
    patch: (t) =>
      sub(
        t,
        "  for (const archived of [first, !first]) {",
        "  for (const archived of [first]) {",
      ),
  },
  {
    id: "MU-2520",
    title:
      "WEB-10b L4: parseListPage accepts a page without the full-page cursor rule",
    file: REGISTER,
    tests: [REGISTER_TEST],
    expect:
      /parseListPage is strict refuses a (short page with a cursor|full page)/,
    patch: (t) =>
      sub(
        t,
        "  if (out.length === LIST_PAGE ? next !== last : next !== null) return null;\n",
        "",
      ),
  },
  {
    id: "MU-2521",
    title:
      "WEB-10b L4: readArchiveCurrent ends at the task read's 404 (a list's archive is never read)",
    file: REGISTER,
    tests: [REGISTER_TEST],
    expect: /found in the ARCHIVED collection|restore \(expects archived\)/,
    patch: (t) =>
      sub(t, "  if (status === 404) return readListCurrent(draft, io);\n", ""),
  },
  {
    id: "MU-2522",
    title:
      "WEB-10b L4: rebuildEditList rebuilds under a reviewed denial (can_edit false)",
    file: REGISTER,
    tests: [REGISTER_TEST],
    expect: /edit_list is not rebuilt on no edit access/,
    patch: (t) =>
      sub(
        t,
        "    current.policy_version === undefined ||\n    current.can_edit === false ||\n    !isString(command.name)",
        "    current.policy_version === undefined ||\n    !isString(command.name)",
      ),
  },
  {
    id: "MU-2523",
    title: "WEB-10b L4 (re-expressed): rebuildArchive refuses a list row",
    file: REGISTER,
    tests: [REGISTER_TEST],
    expect: /archive of a list: rebuilt on the list/,
    patch: (t) =>
      sub(
        t,
        '    (current.kind !== "task" && current.kind !== "list") ||',
        '    current.kind !== "task" ||',
      ),
  },
  {
    id: "MU-2524",
    title: "WEB-10b L5: a failed pane read is shown as 'No lists yet'",
    file: LAYOUT,
    tests: [READS_TEST],
    expect: /a failed read is never 'No lists yet'/,
    patch: (t) =>
      sub(
        t,
        "        pane.noDatabase ? (",
        "        pane.noDatabase || pane.error !== null ? (",
      ),
  },
  {
    id: "MU-2525",
    title:
      "WEB-10b L7: a rename edits the queued create without checking it is the one read (expectDraft)",
    file: LISTS,
    tests: [MODEL_TEST, DIALOGS_TEST],
    expect:
      /refuses a draft edited since|another tab edited the queued create since this dialog read it/,
    patch: (t) =>
      sub(
        t,
        '    expectDraft: (now) =>\n      now.local_id === draft.local_id &&\n      now.status === "queued" &&\n      now.command_digest === draft.command_digest,\n',
        "",
      ),
  },
  {
    id: "MU-2526",
    title: "WEB-10b L7: a rename's settlement consumes input typed after Save",
    file: DIALOGS,
    tests: [DIALOGS_TEST, ATTEMPTS_TEST],
    expect: /ticket acknowledgement|edits while the save is pending/,
    // Re-expressed in revision 1 against `settleSave`, which both dialogs now settle through; re-anchored in revision 2 (one transition)
    // and in revision 3 on `settleSave`'s success (the earlier request's success is `settleLookup`'s, MU-2540).
    patch: (t) =>
      sub(
        t,
        "    completeKept<T>(ticket, true, {",
        "    completeKept<T>({ ...ticket, revision: keptEntry<T>(ticket.key)?.revision ?? ticket.revision }, true, {",
      ),
  },
  {
    id: "MU-2527",
    title:
      "WEB-10b L16: the create dialog discards its input on any close (the in-dialog sync control included)",
    file: DIALOGS,
    tests: [DIALOGS_TEST],
    expect: /kept through the in-dialog sync control and Back/,
    patch: (t) =>
      sub(
        t,
        "      onClose={onClose}\n      onDiscard={discard}\n      title={CREATE.title}",
        "      onClose={() => {\n        discard();\n        onClose();\n      }}\n      onDiscard={discard}\n      title={CREATE.title}",
      ),
  },
  {
    id: "MU-2528",
    title: "WEB-10b L8/L11: a withheld row is a link to the task",
    file: DETAIL,
    tests: [SCREENS_TEST],
    expect: /a withheld row last/,
    patch: withheldAsLink,
  },
  {
    id: "MU-2529",
    title: "WEB-10b L8: a withheld row offers no Remove",
    file: DETAIL,
    tests: [SCREENS_TEST],
    expect: /a withheld row last/,
    patch: (t) =>
      sub(
        t,
        '                    {editable ? (\n                      <Button\n                        variant="quiet"\n                        data-list-remove={item.id}',
        '                    {editable && item.kind === "task" ? (\n                      <Button\n                        variant="quiet"\n                        data-list-remove={item.id}',
      ),
  },
  {
    id: "MU-2530",
    title:
      "WEB-10b L5: a list created here and not received yet is missing from the pane",
    file: READS,
    tests: [SCREENS_TEST],
    expect: /created here and not received yet is listed first/,
    patch: (t) =>
      sub(
        t,
        "      if (options.after === null)\n        for (const create of creates) {",
        '      if (options.after === "-")\n        for (const create of creates) {',
      ),
  },
  {
    id: "MU-2531",
    title:
      "WEB-10b L8: a read-only list offers Rename, Remove, Add and Archive",
    file: DETAIL,
    tests: [SCREENS_TEST],
    expect: /a read-only list/,
    patch: (t) =>
      sub(
        t,
        "  const editable = row.can_edit && env.writable;",
        "  const editable = env.writable;",
      ),
  },
  {
    id: "MU-2532",
    title: "WEB-10b L1: parseListValue accepts duplicate ids",
    file: LISTS,
    tests: [MODEL_TEST],
    expect: /rejects a duplicate id/,
    patch: (t) =>
      sub(
        t,
        "  if (!ids.every((id) => isUuid(id)) || new Set(ids).size !== ids.length)",
        "  if (!ids.every((id) => isUuid(id)))",
      ),
  },
  {
    id: "MU-2535",
    title:
      "WEB-10b L3 (N-LS1 as a unit mutant): the Lists' reads are not certified (one pass, no basis check)",
    file: READS,
    tests: [READS_TEST],
    expect: /never shown mixed/,
    patch: (t) =>
      sub(
        t,
        "    (signal) => readCoherently(data, () => run(data, signal), { signal }),",
        '    (signal) =>\n      run(data, signal).then((stage) =>\n        stage.ok ? { kind: "complete" as const, value: stage.value, basis: null as never } : { kind: stage.why },\n      ),',
      ),
  },
  {
    id: "MU-2536",
    title:
      "WEB-10b L7 (N-LS2's rename half): edit_list drops requiresEdit (a denial committed after the screen was drawn is not refused)",
    file: LISTS,
    tests: [DIALOGS_TEST, MODEL_TEST],
    expect: /denial committed by another tab|read-only refuses a rename/,
    patch: (t) =>
      sub(
        t,
        EDIT_LIST_TARGETS,
        '    targets: [{ ...primary(input.listId), requiresEdit: false }],\n    ...(input.localId === undefined ? {} : { localId: input.localId }),\n    build: (bases: Bases) => ({\n      command: {\n        command: {\n          kind: "edit_list",',
      ),
  },
  {
    id: "MU-2539",
    title:
      "WEB-10b R1: a save that may have been stored does not bind the session to its request (a retry sends what is typed now)",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /edited retry|edits while the save is pending/,
    patch: (t) =>
      sub(
        t,
        "    change: (value) => (uncertain ? { ...bind(value), attempt: sent } : value),",
        "    change: (value) => value,",
      ),
  },
  {
    id: "MU-2540",
    title:
      "WEB-10b R1: an earlier request's success consumes what was typed since (the dialog closes on the newer input)",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /edited retry|edits while the save is pending/,
    patch: (t) =>
      sub(
        t,
        "    completeKept<T>(ticket, current, {",
        "    completeKept<T>(ticket, true, {",
      ),
  },
  {
    id: "MU-2541",
    title:
      "WEB-10b R1: a definite refusal binds the session too (the newer name is never sent under the unused ids)",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /a definite refusal binds nothing/,
    patch: (t) =>
      sub(
        t,
        "  const uncertain = outcome.uncertain === true;",
        "  const uncertain = true;",
      ),
  },
  {
    id: "MU-2542",
    title: "WEB-10b R1: a save that threw is reported as certainly not stored",
    file: ACTIONS,
    tests: [ATTEMPTS_TEST],
    expect: /lost-after-commit|lost-before-commit/,
    patch: (t) =>
      sub(
        t,
        "          uncertain: !(\n            error instanceof OutboxRequestError || error instanceof TypeError\n          ),",
        "          uncertain: false,",
      ),
  },
  {
    id: "MU-2543",
    title:
      "WEB-10b R1: the outbox's `storage` refusal (a store that failed after the write) is reported as certainly not stored",
    file: ACTIONS,
    tests: [ATTEMPTS_TEST],
    expect: /storage-after-commit/,
    patch: (t) =>
      sub(
        t,
        "        uncertain: UNCERTAIN.has(outcome.reason),\n        reason: outcome.reason,",
        "        uncertain: false,\n        reason: outcome.reason,",
      ),
  },
  {
    id: "MU-2544",
    title:
      "WEB-10b R2: an add's id belongs to the task for the session (a later add of the same task is deduplicated against an earlier one)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect: /R2.*(chosen again|retires it too)/,
    // Re-expressed in revision 2 (same intent): the selection, not the task, names the add; the mutant restores an id per task.
    patch: idPerTask,
  },
  {
    id: "MU-2545",
    title:
      "WEB-10b R3: a cached resource of another kind at a list's id is composed as a list (its Archive archives a task)",
    file: VIEW,
    tests: [VIEW_TEST, SCREENS_TEST],
    expect: /R3: a cached/,
    patch: (t) =>
      sub(
        t,
        '  if (cached !== null && cached.kind !== "list") return null;\n',
        "",
      ),
  },
  {
    id: "MU-2546",
    title:
      "WEB-10b R4: the detail's heading is drawn only once the list is read (none while loading, failed or absent)",
    file: DETAIL,
    tests: [ROUTES_TEST, SCREENS_TEST],
    expect: /R4: one h1|R3: a cached task's id/,
    patch: (t) =>
      sub(
        t,
        "        <PageHeading>{heading}</PageHeading>",
        "        {heading === LISTS_TITLE ? null : <PageHeading>{heading}</PageHeading>}",
      ),
  },
  {
    id: "MU-2549",
    title:
      "WEB-10b R4: the loading detail's heading is another element than the read list's (a focus given to it is lost)",
    file: DETAIL,
    tests: [ROUTES_TEST],
    expect: /R4: one h1/,
    patch: (t) =>
      sub(
        t,
        '      <Frame state="loading">',
        '      <Frame key="loading" state="loading">',
      ),
  },
  {
    id: "MU-2550",
    title:
      'WEB-10b R4: the loading detail names itself `data-list-detail="loading"` (a reader of the list\'s id takes "loading")',
    file: DETAIL,
    tests: [ROUTES_TEST],
    expect: /R4: one h1/,
    patch: (t) =>
      sub(
        t,
        '      data-list-detail={state === "loading" ? undefined : state}',
        "      data-list-detail={state}",
      ),
  },
  {
    id: "MU-2551",
    title:
      "WEB-10b R1 (review 2): a settled save updates the busy state and note of the editor mounted now, not its value (a dialog mounted again on Back keeps the earlier request's ids)",
    file: KEPT,
    tests: [SETTLEMENT_TEST, ATTEMPTS_TEST],
    expect:
      /editor mounted after the save was taken|the editor that took the save|remounted while pending/,
    patch: staleSettledValue,
  },
  {
    id: "MU-2552",
    title:
      "WEB-10b R1 (review 2): the settlement is told to the editors before what the save leaves is in the session",
    file: KEPT,
    tests: [SETTLEMENT_TEST, ATTEMPTS_TEST],
    expect:
      /before the editors are told|editor mounted after the save was taken|the editor that took the save|same mount|remounted while pending/,
    patch: (t) =>
      sub(
        t,
        '  if (outcome.change !== undefined)\n    held.value = outcome.change(held.value as T);\n  held.submitting = null;\n  held.note = outcome.note ?? null;\n  publish(ticket.key, { kind: "settled", session: ticket.session });\n',
        '  held.submitting = null;\n  held.note = outcome.note ?? null;\n  publish(ticket.key, { kind: "settled", session: ticket.session });\n  if (outcome.change !== undefined)\n    held.value = outcome.change(held.value as T);\n',
      ),
  },
  {
    id: "MU-2553",
    title:
      "WEB-10b R1 (review 2): what a save leaves is evaluated twice (its new ids allocated twice)",
    file: KEPT,
    tests: [SETTLEMENT_TEST],
    expect: /the change runs once/,
    patch: (t) =>
      sub(
        t,
        "    held.value = outcome.change(held.value as T);\n",
        "    held.value = outcome.change(outcome.change(held.value as T));\n",
      ),
  },
  {
    id: "MU-2554",
    title:
      "WEB-10b R1 (review 2): a ticket that is not the session's pending save settles it (a late completion ends a newer flight)",
    file: KEPT,
    tests: [SETTLEMENT_TEST],
    expect: /a ticket that is not the pending save settles nothing/,
    patch: (t) =>
      sub(t, '  if (held.flight !== ticket.flight) return "gone";\n', ""),
  },
  {
    id: "MU-2555",
    title:
      "WEB-10b R1 (review 2): a second submit is taken while a save of the session is pending",
    file: KEPT,
    tests: [SETTLEMENT_TEST],
    expect: /a second submit while a save is pending is refused/,
    patch: (t) => sub(t, "  if (held.flight !== null) return null;\n", ""),
  },
  {
    id: "MU-2556",
    title:
      "WEB-10b R1 (review 2): what a save leaves in the session counts as an edit by the person (it moves the revision)",
    file: KEPT,
    tests: [SETTLEMENT_TEST],
    expect: /it does not move the revision/,
    patch: (t) =>
      sub(
        t,
        "  if (outcome.change !== undefined)\n    held.value = outcome.change(held.value as T);\n",
        "  if (outcome.change !== undefined) {\n    held.value = outcome.change(held.value as T);\n    held.revision += 1;\n  }\n",
      ),
  },
  {
    id: "MU-2557",
    title:
      "WEB-10b R2 (review 2): an add whose answer was lost is not marked so (its retry is never settled by what is stored)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect: /the earlier selection shown again and Add pressed/,
    patch: (t) =>
      sub(
        t,
        "            if (outcome.uncertain === true)\n              issued.push({",
        "            if (false as boolean)\n              issued.push({",
      ),
  },
  {
    id: "MU-2558",
    title:
      "WEB-10b R2 (review 2), D1: an add whose answer was lost is taken as saved without asking what is stored (one never stored is never sent)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect:
      /NOT stored: membership settles nothing|lost-before-commit: the add is seen as made/,
    // Re-anchored in revision 3 on the look-up of every earlier add.
    patch: (t) =>
      sub(
        t,
        "        const evidence = await actions.reconcile(earlier);",
        '        const evidence: Evidence = "stored";',
      ),
  },
  {
    id: "MU-2562",
    title:
      "WEB-10b R2 (review 2), D1: an exact read of a lost add's draft that failed is taken as finding it stored (the add is never sent)",
    file: LIST_ACTIONS,
    tests: [ATTEMPTS_TEST],
    expect: /the exact read of a lost add's draft fails/,
    // Re-anchored in revision 3 on the Lists' reading of the evidence.
    patch: (t) =>
      sub(
        t,
        '        if (!read.ok || read.value === "absent") return "unknown";',
        '        if (!read.ok) return "stored";\n        if (read.value === "absent") return "unknown";',
      ),
  },
  {
    id: "MU-2559",
    title:
      "WEB-10b R2 (review 2), D1: the exact read of a stored draft answers that none is stored",
    file: DRAFT_HEADER,
    tests: [ATTEMPTS_TEST],
    expect: /the earlier selection shown again and Add pressed/,
    // Re-anchored in revision 3 on the typed evidence plan.
    patch: (t) =>
      sub(
        t,
        '    if (draft === undefined) return "absent";',
        '    if (draft !== null) return "absent";',
      ),
  },
  {
    id: "MU-2563",
    title:
      "WEB-10b D1: an earlier add not settled does not hold Add selected back (its task selected under the old id is sent again, a hidden one is passed over)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect:
      /nothing is sent until the decision adds it anew|deselecting is not deciding|B is held back/,
    patch: (t) =>
      sub(
        t,
        "      if (unsettled.size === 0)\n",
        "      if (true as boolean)\n",
      ),
  },
  {
    id: "MU-2564",
    title:
      "WEB-10b D1: deselecting a task drops its earlier add not settled (a selection change bypasses the decision)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect: /deselecting is not deciding/,
    patch: (t) =>
      sub(
        t,
        "          selected: value.selected.filter((c) => c.task !== task),\n",
        "          selected: value.selected.filter((c) => c.task !== task),\n          unresolved: value.unresolved.filter((u) => u.task !== task),\n",
      ),
  },
  {
    id: "MU-2565",
    title:
      "WEB-10b D1: only the earlier adds of tasks chosen now are looked up (one deselected or hidden by membership is passed over)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect: /deselecting is not deciding|B is held back/,
    patch: (t) =>
      sub(
        t,
        "      : unresolved;\n",
        "      : unresolved.filter((u) => chosen.some((c) => c.localId === u.localId));\n",
      ),
  },
  {
    id: "MU-2566",
    title:
      "WEB-10b D1: the picker's decision adds a task under its earlier add's id (the predecessor's id reused)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect:
      /nothing is sent until the decision adds it anew|reselection is not the decision|exact read of a lost add's draft fails/,
    patch: (t) =>
      sub(
        t,
        "          renamed.set(c.localId, env.newId());",
        "          renamed.set(c.localId, c.localId);",
      ),
  },
  {
    id: "MU-2567",
    title:
      "WEB-10b D1: a look-up that finds no exact evidence drops the attempt (the next ordinary Save is taken as the decision, under the old ids)",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /Save writes nothing and says the outcome is unknown|still unknown/,
    patch: (t) =>
      sub(
        t,
        "        ? { ...value, attempt: { ...attempt, state: evidence } }",
        "        ? { ...value, attempt: null }",
      ),
  },
  {
    id: "MU-2568",
    title:
      "WEB-10b D1: the create's decision reuses the earlier save's list id and local id",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect:
      /only the separate decision creates the list, under new ids|creates a separate list under new ids/,
    patch: (t) =>
      sub(
        t,
        "      ? { listId: env.newId(), localId: env.newId() }\n      : { listId, localId };",
        "      ? { listId, localId }\n      : { listId, localId };",
      ),
  },
  {
    id: "MU-2569",
    title:
      "WEB-10b D1: the rename's decision sends the earlier rename's request (its id and policy version) instead of a new one",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /the policy version of now/,
    patch: (t) =>
      sub(
        t,
        "    const request =\n      create !== null\n        ? renameQueuedCreate(create, name)",
        "    const request =\n      again && attempt !== null\n        ? attempt.request\n        : create !== null\n        ? renameQueuedCreate(create, name)",
      ),
  },
  {
    id: "MU-2570",
    title:
      "WEB-10b D1: a draft changed since under the save's id is taken as that save as sent",
    file: DRAFT_HEADER,
    tests: [ATTEMPTS_TEST],
    expect: /edited in place elsewhere|stored, changed, refused and absent/,
    patch: (t) =>
      sub(
        t,
        '    return isSameSave(input.request, draft) ? "stored" : "changed";',
        '    return "stored";',
      ),
  },
  {
    id: "MU-2571",
    title:
      "WEB-10b D1: a refused or discarded draft under the save's id is taken as that save stored",
    file: DRAFT_HEADER,
    tests: [ATTEMPTS_TEST],
    expect: /stays as rejected|stored, changed, refused and absent/,
    patch: (t) =>
      sub(
        t,
        '    if (draft.status === "rejected" || draft.status === "superseded")\n      return "refused";\n',
        "",
      ),
  },
  {
    id: "MU-2572",
    title:
      "WEB-10b D1: evidence read in another database than the one the save was issued to is accepted",
    file: DRAFT_READ,
    tests: [ATTEMPTS_TEST],
    expect: /stored, changed, refused and absent/,
    patch: (t) =>
      sub(
        t,
        "  if (service === null || service.incarnationId !== save.scope)",
        "  if (service === null)",
      ),
  },
  {
    id: "MU-2573",
    title:
      "WEB-10b D1: the decision is offered before the earlier save has been looked up",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /not decided yet: looked up first|the decision's own answer lost/,
    patch: (t) =>
      sub(
        t,
        '  attempt !== null && attempt.state !== "uncertain";',
        "  attempt !== null;",
      ),
  },
  {
    id: "MU-2574",
    title:
      "WEB-10b D1: a create's attempt found stored is sent again after the look-up (a check, then an unconditional insertion)",
    file: DIALOGS,
    tests: [ATTEMPTS_TEST],
    expect: /discarded right AFTER the look-up read it/,
    patch: (t) =>
      sub(
        t,
        "        evidence = await actions.reconcile(attempt);\n      } finally {\n        const notes = {\n          newer: RENAME.newer,\n          earlier: CREATE.earlier(attempt.name),",
        '        evidence = await actions.reconcile(attempt);\n        if (evidence === "stored") await actions.enqueue(attempt.request);\n      } finally {\n        const notes = {\n          newer: RENAME.newer,\n          earlier: CREATE.earlier(attempt.name),',
      ),
  },
  {
    id: "MU-2575",
    title:
      "WEB-10b D1: an earlier add the picker's decision was about is kept after the decision was acted on (the next Add is held back again)",
    file: PICKER,
    tests: [ATTEMPTS_TEST],
    expect: /a later Add of another task is not held back again/,
    patch: (t) =>
      sub(
        t,
        "          ...(decided ? [] : value.unresolved)",
        "          ...value.unresolved",
      ),
  },
  // Revision 4 (review 4, D1 / DA-N1): an add waits for the task's CURRENT create, read when the add is made.
  {
    id: "MU-2578",
    title:
      "WEB-10b D1/DA-N1: an add does not state what its admission read saw of the task (a create replaced or discarded after the read is still named)",
    file: LIST_ACTIONS,
    tests: [ADMISSION_TEST],
    expect: /BETWEEN the admission read and the write: refused/,
    patch: addUnobserved,
  },
  {
    id: "MU-2579",
    title:
      "WEB-10b D1/DA-N1: a task nothing on this device makes is taken as already sent (the add is written with no create to wait for)",
    file: LIST_ACTIONS,
    tests: [ADMISSION_TEST],
    expect: /before Add: nothing written|nothing makes the task/,
    patch: goneTakenAsSent,
  },
  {
    id: "MU-2580",
    title:
      "WEB-10b D1/DA-N1: a refused (rejected) create is taken as still making its task (the add waits for a create that never goes)",
    file: LIST_ACTIONS,
    tests: [ADMISSION_TEST],
    expect: /rejected before Add/,
    patch: (t) =>
      sub(
        t,
        "    MAKING.has(create.status) &&\n",
        "    (true as boolean) &&\n",
      ),
  },
  {
    id: "MU-2581",
    title:
      "WEB-10b D1/DA-N1: a selection whose task is gone is kept but not shown (it cannot be deselected, and blocks the others)",
    file: PICKER,
    tests: [ADMISSION_TEST],
    expect: /before Add: nothing written, the selection kept and shown/,
    patch: (t) =>
      sub(
        t,
        '            if (prepared.kind === "gone") missing = choice.localId;',
        "            if (false as boolean) missing = choice.localId;",
      ),
  },
  {
    id: "MU-2582",
    title:
      "WEB-10b D1/DA-N1: a refusal because the task changed after its read is reported as a storage failure (the person is not told why)",
    file: PICKER,
    tests: [ADMISSION_TEST],
    expect: /BETWEEN the admission read and the write: refused/,
    patch: (t) =>
      sub(
        t,
        '              outcome.reason === "changed"\n',
        "              (false as boolean)\n",
      ),
  },
  {
    id: "MU-2583",
    title:
      "WEB-10b D1/DA-N1: an add not admitted (task gone, or its read failed) is dropped from the selection as if it had been added",
    file: PICKER,
    tests: [ADMISSION_TEST],
    expect: /failed admission read|before Add: nothing written/,
    patch: (t) =>
      sub(
        t,
        '            refused = true;\n            reason = prepared.kind === "gone" ? PICKER.gone : PICKER.unread;',
        '            queued.add(choice.localId);\n            refused = true;\n            reason = prepared.kind === "gone" ? PICKER.gone : PICKER.unread;',
      ),
  },
];

/** D1: an ordinary Save of a create holding an attempt makes a new save of it under the attempt's ids (the revision-2 retry, unlooked-up). */
const createSendsAttemptAgain = (t) =>
  sub(
    t,
    "    const ticket = kept.submit();\n    if (ticket === null) return;\n    if (attempt !== null && !again) {",
    "    const ticket = kept.submit();\n    if (ticket === null) return;\n    if (false as boolean) {",
  );
const pickerUnsettledNotHeld = (t) =>
  sub(t, "      if (unsettled.size === 0)\n", "      if (true as boolean)\n");

const SPEC = "tests/e2e/fixture.lists.spec.ts";
export const ENGINE_WEB10B = [
  {
    id: "MU-2534",
    title:
      "WEB-10b N-LS3: (REAL ENGINE) the create navigates on a consumed save whether or not the person is still at the dialog",
    file: DIALOGS,
    spec: SPEC,
    grep: "E-LS7b:",
    expect: /E-LS7b:/,
    patch: createNavigatesUngated,
  },
  {
    id: "MU-2537",
    title: "WEB-10b (REAL ENGINE) L11: a withheld row is a link to the task",
    file: DETAIL,
    spec: SPEC,
    grep: "E-LS1: .* counts, a withheld row",
    expect: /E-LS1:/,
    patch: withheldAsLink,
  },
  {
    id: "MU-2538",
    title:
      "WEB-10b (REAL ENGINE) L9/L11: the picker offers the list's members and archived tasks",
    file: READS,
    spec: SPEC,
    grep: "E-LS1: .* counts, a withheld row",
    expect: /E-LS1:/,
    patch: pickerOffersMembers,
  },
  {
    id: "MU-2547",
    title:
      "WEB-10b N-LS1: (REAL ENGINE) the Lists' reads are not certified: a commit between the detail's stages is shown mixed",
    file: READS,
    spec: SPEC,
    grep: "E-LS8 \\(a\\), \\(b\\): .* \\(a\\) a commit placed",
    expect: /E-LS8 \(a\), \(b\):/,
    patch: (t) =>
      sub(
        t,
        "    (signal) => readCoherently(data, () => run(data, signal), { signal }),",
        '    (signal) =>\n      run(data, signal).then((stage) =>\n        stage.ok ? { kind: "complete" as const, value: stage.value, basis: null as never } : { kind: stage.why },\n      ),',
      ),
  },
  {
    id: "MU-2548",
    title:
      "WEB-10b N-LS2: (REAL ENGINE) list_item drops requiresEdit: a denial committed after the screen's last read does not refuse a remove",
    file: LISTS,
    spec: SPEC,
    grep: "E-LS8 \\(a\\), \\(b\\): .* \\(b\\) a denial committed",
    expect: /E-LS8 \(a\), \(b\):/,
    patch: (t) =>
      sub(
        t,
        LIST_ITEM_TARGETS,
        "    targets: [{ ...primary(input.listId), requiresEdit: false }],\n    ...(input.after ? { dependsOnExtra: [input.after] } : {}),\n",
      ),
  },
  {
    id: "MU-2560",
    title:
      "WEB-10b R1 (review 2): (REAL ENGINE) the dialog Back mounts again keeps its own value when the earlier request's retry settles (the next Save sends it again)",
    file: KEPT,
    spec: SPEC,
    grep: "E-LS11: .* create: .* mounted again by Sync and Back",
    expect: /E-LS11:/,
    patch: staleSettledValue,
  },
  {
    id: "MU-2561",
    title:
      "WEB-10b R2 (review 2): (REAL ENGINE) an add's id belongs to the task: A chosen again after another tab's remove is deduplicated against its lost add",
    file: PICKER,
    spec: SPEC,
    grep: "E-LS11: .* picker: A's add written but its answer lost",
    expect: /E-LS11:/,
    patch: idPerTask,
  },
  {
    id: "MU-2576",
    title:
      "WEB-10b D1: (REAL ENGINE) an ordinary Save sends a create's lost-answer attempt again under its old ids after another tab discarded it",
    file: DIALOGS,
    spec: SPEC,
    grep: "E-LS12: .* create: the stored create of a lost answer discarded in another tab",
    expect: /E-LS12:/,
    patch: createSendsAttemptAgain,
  },
  {
    id: "MU-2577",
    title:
      "WEB-10b D1: (REAL ENGINE) an earlier add not settled does not hold Add selected back: A is sent again under its old id after another tab discarded it",
    file: PICKER,
    spec: SPEC,
    grep: "E-LS12: .* picker: A's lost add discarded in another tab",
    expect: /E-LS12:/,
    patch: pickerUnsettledNotHeld,
  },
  {
    id: "MU-2584",
    title:
      "WEB-10b D1/DA-N1: (REAL ENGINE) an add does not state what its read of the task saw: a create discarded in another tab between that read and the write is still named",
    file: LIST_ACTIONS,
    spec: SPEC,
    grep: "E-LS13: .* the create discarded in another tab BETWEEN",
    expect: /E-LS13:/,
    patch: addUnobserved,
  },
  {
    id: "MU-2585",
    title:
      "WEB-10b D1/DA-N1: (REAL ENGINE) a task whose create another tab discarded is taken as already sent: the add is written",
    file: LIST_ACTIONS,
    spec: SPEC,
    grep: "E-LS13: .* the create discarded in another tab BEFORE Add",
    expect: /E-LS13:/,
    patch: goneTakenAsSent,
  },
];

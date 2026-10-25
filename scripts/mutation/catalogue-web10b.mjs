// WEB-10b's mutants (plan §7.4: finite and targeted; the full catalogues stay WEB-17's), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Each names the test written for its defect (`expect`, matched
// against an ASSERTION failure's full name). `sub` is the catalogue's own exactly-one-occurrence patcher.
//
// Departures from the plan's table, recorded in .agtx/execute.md and docs/lists.md: MU-2523 is re-expressed (an `archive` of a task now
// delegates to `archiveResource`, so "the task builder for a list row" is an equivalent mutant; the defect that remains possible is a
// rebuild that refuses a list row); N-LS1 (the certificate) is the UNIT mutant MU-2535, caught by a deterministic interleaving over the
// production composition, because no real engine lets a spec place a commit between two stages of one read; N-LS2 (list_item without
// `requiresEdit`) is caught by the unit tests of the production outbox (MU-2506, and MU-2536 for `edit_list`): a real engine shows a denial
// committed BEFORE the act, which the screen's own check already refuses. The real-engine mutants are MU-2534 (N-LS3), MU-2537 and MU-2538.
import { sub } from "./data-catalogue.mjs";

const LISTS = "src/features/tasks/model/lists.ts";
const VIEW = "src/features/tasks/model/list-view.ts";
const REGISTER = "src/features/tasks/register.ts";
const READS = "src/features/tasks/lists/reads.ts";
const DIALOGS = "src/features/tasks/lists/dialogs.tsx";
const PICKER = "src/features/tasks/lists/TaskPicker.tsx";
const DETAIL = "src/features/tasks/lists/ListDetail.tsx";
const LAYOUT = "src/features/tasks/lists/ListsLayout.tsx";
const T = (name) => `tests/features/tasks/${name}`;
const MODEL_TEST = T("lists-model.test.ts");
const VIEW_TEST = T("list-view.test.ts");
const REGISTER_TEST = T("lists-register.test.ts");
const SCREENS_TEST = T("lists-screens.test.tsx");
const DIALOGS_TEST = T("lists-dialogs.test.tsx");
const READS_TEST = T("lists-reads.test.tsx");
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
const createNavigatesUngated = (t) =>
  sub(
    t,
    '        note: ok ? RENAME.newer : note,\n      });\n      if (ok && settled === "kept")\n        renew<CreateInput>(',
    '        note: ok ? RENAME.newer : note,\n      });\n      if (ok) void navigate({ to: "/tasks/lists/$listId", params: { listId } });\n      if (ok && settled === "kept")\n        renew<CreateInput>(',
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
    file: PICKER,
    tests: [DIALOGS_TEST],
    expect: /waits for its create/,
    patch: (t) =>
      sub(
        t,
        "            after: input.after[taskId] ?? null,",
        "            after: null,",
      ),
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
        "        if (queued.size > 0) editSession(key, ticket.session, leave, kept.edit);",
        "        if (queued.size > 0)\n          editSession(key, ticket.session, (v) => ({ ...v, selected: [] }), kept.edit);",
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
        "            localId: input.attempts[taskId] as string,",
        "            localId: crypto.randomUUID(),",
      ),
  },
  {
    id: "MU-2518",
    title:
      "WEB-10b L6: the create's retry uses a new list id and local id (a lost completion makes two lists)",
    file: DIALOGS,
    tests: [DIALOGS_TEST],
    expect: /retried with the SAME list id and local id/,
    patch: (t) =>
      sub(
        t,
        "        createList({ listId, name, defaults: defaults.record, localId }),",
        "        createList({ listId: env.newId(), name, defaults: defaults.record, localId: env.newId() }),",
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
    tests: [DIALOGS_TEST],
    expect: /ticket acknowledgement/,
    patch: (t) =>
      sub(
        t,
        '      const settled = completeKept(ticket, ok, {\n        note: ok ? RENAME.newer : note,\n      });\n      if (ok && settled === "kept")\n        renew<RenameInput>(',
        '      const settled = completeKept(\n        { ...ticket, revision: keptEntry<RenameInput>(key)?.revision ?? ticket.revision },\n        ok,\n        { note: ok ? RENAME.newer : note },\n      );\n      if (ok && settled === "kept")\n        renew<RenameInput>(',
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
];

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
];

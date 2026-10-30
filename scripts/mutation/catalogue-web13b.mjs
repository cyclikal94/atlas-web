// WEB-13b's mutants (local ICS import, task anchors, review items; plan §9.5), in the form and under the rules of `data-catalogue.mjs`,
// which spreads them into its `UNIT` and `ENGINE` lists. Kept in their own module as WEB-10a's revisions are (the catalogue is at Biome's
// 1 MiB file-size limit). `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const IMPORT_MODEL = "src/features/calendars/model/import.ts";
const ANCHOR_MODEL = "src/features/calendars/model/anchor.ts";
const REVIEW_MODEL = "src/features/calendars/model/review.ts";
const ANSWERS = "src/features/calendars/answers.ts";
const DISPATCHER = "src/data/engine/outbox-dispatcher.ts";
const PENDING_READS = "src/data/plans/pending-reads.ts";
const TASK_FORM = "src/features/tasks/form/TaskFormPage.tsx";
const T_IMPORT_MODEL = "tests/features/calendars/import-model.test.ts";
const T_ANCHOR_MODEL = "tests/features/calendars/anchor-model.test.ts";
const T_REVIEWS = "tests/features/calendars/review-panel.test.tsx";
const T_IMPORT_UI = "tests/features/calendars/import-ui.test.tsx";
const T_EXTENSION = "tests/data/outbox-calendar-extension.test.ts";
const T_ANSWERS = "tests/data/outbox-answers.test.ts";
const T_PENDING = "tests/data/pending-reads.test.ts";
const T_TASK_COMMANDS = "tests/features/tasks/commands.test.ts";
const T_FORM = "tests/features/tasks/task-form-anchor.test.tsx";
const T_SECTION = "tests/features/tasks/anchor-section.test.tsx";

/** The import's two terminal answers: only `fetch_failed` is registered (a `409 stale_refresh` takes the generic retry). */
const staleRetried = (t) =>
  sub(
    t,
    '  for (const code of ["stale_refresh", "fetch_failed"])\n',
    '  for (const code of ["fetch_failed"])\n',
  );
/** The binding is read again on every mount (the visit's read is not kept). */
// Re-anchored in revision 1 (R6 added the lifetime to the same guard, which is kept): the same defect.
const readEveryMount = (t) =>
  sub(
    t,
    "  if (own.reads.has(key) || !live()) return;\n",
    "  if (!live()) return;\n",
  );

/** Unit mutants (layers L1a pure, L1b the production composition over the IndexedDB double), MU-2437..MU-2465 and MU-2470. */
export const UNIT_13B = [
  {
    id: "MU-2437",
    title:
      "WEB-13b §4.1: lines are counted with a trailing newline's empty segment (Rust `str::lines` drops it)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /has 1 lines|20,000 lines are accepted/,
    patch: (t) =>
      sub(
        t,
        '  return text.endsWith("\\n") ? newlines : newlines + 1;\n',
        "  return newlines + 1;\n",
      ),
  },
  {
    id: "MU-2438",
    title:
      "WEB-13b §4.1: the size is measured in characters, not UTF-8 bytes (a multibyte file under 1 MiB of characters passes)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /multibyte text is measured in bytes/,
    patch: (t) =>
      sub(
        t,
        "  const bytes = utf8Bytes(ics);\n",
        "  const bytes = ics.length;\n",
      ),
  },
  {
    id: "MU-2439",
    title:
      "WEB-13b §4.1: VEVENT lines are matched case-sensitively (a lower-case component is not counted)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /lower-case component lines are counted/,
    // Re-anchored in revision 14 (R12 moved recognition onto the parser's content lines): the same defect, a lower-case component
    // value no longer counted.
    patch: (t) =>
      sub(
        t,
        "      const component = property.value.toUpperCase();\n",
        "      const component = property.value;\n",
      ),
  },
  {
    id: "MU-2440",
    title:
      "WEB-13b §4.1: a 730-day window is refused (`>=` for `>`): coverage is inclusive",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /2026-01-01 to 2028-01-01/,
    patch: (t) =>
      sub(
        t,
        "  if (span < 0 || span > IMPORT_LIMITS.spanDays)\n",
        "  if (span < 0 || span >= IMPORT_LIMITS.spanDays)\n",
      ),
  },
  {
    id: "MU-2441",
    title:
      "WEB-13b §4.1: a reversed window is accepted (the server answers `422 calendar_limit`)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /2026-01-02 to 2026-01-01/,
    patch: (t) =>
      sub(
        t,
        "  if (span < 0 || span > IMPORT_LIMITS.spanDays)\n",
        "  if (span > IMPORT_LIMITS.spanDays)\n",
      ),
  },
  {
    id: "MU-2442",
    title:
      "WEB-13b §4.1: the envelope is measured as the text alone (JSON escaping can take a 1 MiB file over the 2 MiB route limit)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /escaping can take a 1 MiB file over 2 MiB/,
    patch: (t) => sub(t, "    JSON.stringify({", "    String({"),
  },
  {
    id: "MU-2443",
    title:
      "WEB-13b §5.2: the import's terminal answers reclassify EVERY draft (a settings change's 502 fetch_failed is rejected)",
    file: ANSWERS,
    tests: [T_EXTENSION],
    expect: /the registered answers touch only imports/,
    patch: (t) =>
      sub(t, "      draft.endpoint === IMPORT_ENDPOINT\n", "      true\n"),
  },
  {
    id: "MU-2444",
    title:
      "WEB-13b §5.2: `409 stale_refresh` is not registered (an import that did not commit is retried under the same key for ever)",
    file: ANSWERS,
    tests: [T_EXTENSION],
    expect: /409 stale_refresh/,
    patch: staleRetried,
  },
  {
    id: "MU-2445",
    title:
      "WEB-13b §5.2 (the seam): any reclassification of an Atlas-coded retried answer is honoured as terminal (`retry`, `version_conflict`)",
    file: DISPATCHER,
    tests: [T_ANSWERS],
    expect: /keeps the generic retry/,
    patch: (t) =>
      sub(
        t,
        '        if (handled?.kind === "reclassify" && handled.as === "rejected")\n',
        '        if (handled?.kind === "reclassify")\n',
      ),
  },
  {
    id: "MU-2446",
    title:
      "WEB-13b §5.2 (the seam): the generic retry never consults a handler (an import's 502 fetch_failed is retried)",
    file: DISPATCHER,
    tests: [T_ANSWERS, T_EXTENSION],
    expect:
      /may make it terminal|502 fetch_failed \(the server could not read the file\) is terminal/,
    patch: (t) =>
      sub(
        t,
        "            : deps.conflicts.decide({ draft, status, code: outcome.code });\n",
        "            : null;\n",
      ),
  },
  {
    id: "MU-2447",
    title:
      "WEB-13b §4.2: the import recipe does not require edit access (a known view-only source is imported into)",
    file: "src/features/calendars/model/commands.ts",
    tests: [T_EXTENSION],
    expect: /refuses the import as denied/,
    patch: (t) =>
      sub(
        t,
        "        seedIfUntracked: 1,\n        requiresEdit: true,\n      },\n    ],\n    build: () => ({ command: { ics, from, through } }),\n",
        "        seedIfUntracked: 1,\n      },\n    ],\n    build: () => ({ command: { ics, from, through } }),\n",
      ),
  },
  {
    id: "MU-2448",
    title:
      "WEB-13b E6: a row asking for its settings change loads a newer import's body (1 MiB) again",
    file: PENDING_READS,
    tests: [T_PENDING, T_IMPORT_UI],
    expect: /E6/,
    patch: (t) =>
      sub(
        t,
        "  const headerOnly =\n    newest !== null && kind !== undefined && newest.kind !== kind;\n",
        "  const headerOnly = false as boolean;\n",
      ),
  },
  {
    id: "MU-2449",
    title:
      "WEB-13b §4.2: the Imports list's header read keeps superseded drafts",
    file: PENDING_READS,
    tests: [T_PENDING],
    expect: /lists the unsettled drafts of the kind, oldest first, as headers/,
    patch: (t) =>
      sub(
        t,
        "        if (row.kind !== input.kind || !unsettled(row)) continue;\n",
        "        if (row.kind !== input.kind) continue;\n",
      ),
  },
  {
    id: "MU-2450",
    title:
      "WEB-13b R15: `create_task` sends `anchor: null` when there is none (an absent field is omitted, never null)",
    file: "src/features/tasks/model/commands.ts",
    tests: [T_TASK_COMMANDS],
    expect: /the field is OMITTED/,
    patch: (t) =>
      sub(
        t,
        "    ...(input.anchor ? { anchor: input.anchor as unknown as JsonObject } : {}),\n",
        "    anchor: (input.anchor ?? null) as unknown as JsonObject,\n",
      ),
  },
  {
    id: "MU-2451",
    title:
      "WEB-13b R15: an anchored create projects a first occurrence from its schedule (the server makes none)",
    file: TASK_FORM,
    tests: [T_FORM],
    expect: /makes no first occurrence/,
    patch: (t) =>
      sub(
        t,
        "          anchor === null ? firstSlot(result.definition, env.now()) : null;\n",
        "          firstSlot(result.definition, env.now());\n",
      ),
  },
  {
    id: "MU-2452",
    title:
      "WEB-13b PRODUCT-DECISIONS: a repeating save still sends the kept anchor (the server answers 422)",
    file: TASK_FORM,
    tests: [T_FORM],
    expect: /a repeating save omits it with no warning/,
    patch: (t) =>
      sub(
        t,
        '  mode.kind === "new" && input.state.repeat === "none"\n',
        '  mode.kind === "new"\n',
      ),
  },
  {
    id: "MU-2453",
    title:
      "WEB-13b §4.3: title-contains is sent for a person date (the hidden value is not omitted on save)",
    file: ANCHOR_MODEL,
    tests: [T_ANCHOR_MODEL],
    expect: /a person date never sends title contains/,
    patch: (t) =>
      sub(
        t,
        '  const sendTitle = eventSeries && title.trim() !== "";\n',
        '  const sendTitle = title.trim() !== "";\n',
      ),
  },
  {
    id: "MU-2454",
    title:
      "WEB-13b §4.3: a seconds offset is allowed for an untimed (all-day) event (the whole command fails at reconcile)",
    file: ANCHOR_MODEL,
    tests: [T_ANCHOR_MODEL, T_SECTION],
    expect: /seconds only for a TIMED event series|seconds need a timed event/,
    patch: (t) =>
      sub(
        t,
        '  draft.reference === "event_series" && draft.event?.timed === true;\n',
        '  draft.reference === "event_series" && draft.event !== null;\n',
      ),
  },
  {
    id: "MU-2455",
    title:
      "WEB-13b §4.3: a year-less date field may be saved as not annual (the server answers 422)",
    file: ANCHOR_MODEL,
    tests: [T_ANCHOR_MODEL],
    expect: /one without a year always repeats annually/,
    patch: (t) =>
      sub(
        t,
        "        annual: annualForced(draft) ? true : draft.annual,\n",
        "        annual: draft.annual,\n",
      ),
  },
  {
    id: "MU-2456",
    title:
      "WEB-13b §4.3: the offset's time is sent as typed (`HH:MM`; the contract requires `HH:MM:SS`)",
    file: ANCHOR_MODEL,
    tests: [T_ANCHOR_MODEL],
    expect: /days -366 at "07:05"|an event series names its source and uid/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored in revision 1 (R5 moved the minute's `:00` into `timeToSend`); the same defect.
        "    : `${time}:00`;\n",
        "    : time;\n",
      ),
  },
  {
    id: "MU-2457",
    title:
      "WEB-13b §4.5: resolve_review is sent on version 1 instead of the review's own base",
    file: REVIEW_MODEL,
    tests: [T_REVIEWS],
    expect: /resolve_review is version-checked on the REVIEW/,
    patch: (t) =>
      sub(
        t,
        "          expected_version: bases[id] as number,\n          resolved: true,\n",
        "          expected_version: 1,\n          resolved: true,\n",
      ),
  },
  {
    id: "MU-2458",
    title:
      "WEB-13b D-13b-10: Acknowledge is enqueued without the card's observation (a review that changed between showing and pressing is acknowledged blindly)",
    file: "src/features/calendars/ReviewPanel.tsx",
    tests: [T_REVIEWS],
    expect: /refused as changed/,
    patch: (t) =>
      sub(t, "      view.value.observation,\n", "      undefined,\n"),
  },
  {
    id: "MU-2459",
    title:
      "WEB-13b D-13b-12: the private generic review looks its task up and names it",
    file: "src/features/calendars/ReviewPanel.tsx",
    tests: [T_REVIEWS],
    expect:
      /the private generic review shows no date, no title and no task name/,
    // Both lookups are gated (the occurrence, then its task and reference): a leak needs both gates gone, so the mutant removes both.
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "    occurrenceId === null || generic ? [] : [occurrenceId],\n",
            "    occurrenceId === null ? [] : [occurrenceId],\n",
          ),
          "    facts === null || generic\n",
          "    facts === null\n",
        ),
        "        title = PRIVATE_TITLE;\n",
        "        title = movedTitle(taskName);\n",
      ),
  },
  {
    id: "MU-2460",
    title:
      "WEB-13b D-13b-11: the seed from a review overrides a correction session that already holds input",
    file: "src/features/tasks/detail/CorrectionDialog.tsx",
    tests: [T_FORM],
    expect: /resumed unchanged: the seed fills only a NEW session/,
    patch: (t) =>
      sub(
        t,
        "      setState(opened.state);\n",
        "      setState(latest.current.fresh(latest.current.row.data));\n",
      ),
  },
  {
    id: "MU-2461",
    title:
      "WEB-13b §4.5: `?move=` is left in the address once the correction has opened (Back or a reload opens it again)",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: [T_FORM],
    expect: /leaves the address|an invalid move is ignored/,
    patch: (t) =>
      sub(
        t,
        '    void navigate({\n      to: "/tasks/$taskId",\n      params: { taskId },\n      search: occurrence === undefined ? {} : { occurrence },\n      replace: true,\n    });\n',
        "",
      ),
  },
  {
    id: "MU-2462",
    title:
      "WEB-13b D-13b-9: the binding is read again on every mount (a 403's remount reads again)",
    file: "src/features/tasks/detail/anchor-binding.ts",
    tests: [T_SECTION],
    expect: /reads nothing more|a remount does not read again/,
    patch: readEveryMount,
  },
  {
    id: "MU-2463",
    title:
      "WEB-13b §4.2: Import events is offered on a view-only source (the server answers 403)",
    file: "src/features/calendars/import-action.tsx",
    tests: [T_IMPORT_UI],
    expect:
      /a view-only source and a turned-off source cannot be imported into/,
    patch: (t) =>
      sub(
        t,
        "  if (!input.canEdit) return { enabled: false, reason: VIEW_ONLY_IMPORT };\n",
        "",
      ),
  },
  {
    id: "MU-2464",
    title:
      "WEB-13b §4.2: the import dialog has no synchronous latch (a double press stores two imports)",
    // Revision 6 (R7): re-expressed in the editing session, which now holds the one-save-at-a-time latch (same defect).
    file: "src/features/calendars/import-editor.ts",
    tests: [T_IMPORT_UI],
    expect: /two submissions in the same task enqueue once/,
    patch: (t) =>
      sub(
        t,
        "      if (over || waiting !== null || submission === null) return false;\n",
        "      if (over || submission === null) return false;\n",
      ),
  },
  {
    id: "MU-2465",
    title:
      "WEB-13b §4.3: the anchor panel's submission reaches the new-task form around it (Save anchor saves the task)",
    file: "src/features/calendars/AnchorDialog.tsx",
    tests: [T_FORM],
    expect: /makes no first occurrence|KEEPS it|Remove takes it away/,
    patch: (t) => sub(t, "            event.stopPropagation();\n", ""),
  },
  {
    id: "MU-2470",
    title:
      "WEB-13b (I-ANC1 finding): the binding is read for a task the server does not have yet (the 404 is kept for the visit)",
    file: "src/features/tasks/detail/AnchorSection.tsx",
    tests: [T_FORM],
    expect:
      /the binding is not read while the task is only this device's pending create/,
    patch: (t) =>
      sub(
        t,
        "    if (visit === null || repeats || !synced || !env.online || !env.writable)\n",
        "    if (visit === null || repeats || !env.online || !env.writable)\n",
      ),
  },
];

/** Real-engine mutants (one isolated whole-mutant job each, all three browsers, its own unmutated control), MU-2466..MU-2469. */
export const ENGINE_13B = [
  {
    id: "MU-2466",
    title:
      "WEB-13b case 2: (REAL ENGINE) the import does not wait for its source's pending create (it is sent before the create's receipt)",
    file: "src/features/calendars/model/commands.ts",
    spec: "tests/e2e/fixture.calendar-import.spec.ts",
    grep: "E-IMP1: .*composed offline against this device's pending create",
    expect: /E-IMP1:/,
    patch: (t) =>
      sub(
        t,
        '        resourceId: sourceId,\n        role: "primary",\n        basis: "resource",\n        versionChecked: false,\n        seedIfUntracked: 1,\n        requiresEdit: true,\n',
        '        resourceId: crypto.randomUUID(),\n        role: "primary",\n        basis: "resource",\n        versionChecked: false,\n        seedIfUntracked: 1,\n        requiresEdit: true,\n',
      ),
  },
  {
    id: "MU-2467",
    title:
      "WEB-13b §5.2: (REAL ENGINE) `409 stale_refresh` of an import is retried (the harness and page host registries both lose it)",
    file: ANSWERS,
    spec: "tests/e2e/fixture.calendar-import.spec.ts",
    grep: "409 stale_refresh",
    expect: /409 stale_refresh/,
    patch: staleRetried,
  },
  {
    id: "MU-2468",
    title:
      "WEB-13b D-13b-4: (REAL ENGINE) the PAGE HOST does not register the import's terminal answers (the production leader retries them)",
    file: "src/app/commands.ts",
    spec: "tests/e2e/fixture.calendar-import.spec.ts",
    grep: "E-IMP6: .*through the production leader: sent once, terminal",
    expect: /E-IMP6:/,
    patch: (t) => sub(t, "    registerImportAnswers(host.conflicts);\n", ""),
  },
  {
    id: "MU-2469",
    title:
      "WEB-13b D-13b-9: (REAL ENGINE) the binding is read again after the session's 403 re-check remounts the tree (neither the visit's read nor the refusal is kept)",
    file: "src/features/tasks/detail/anchor-binding.ts",
    spec: "tests/e2e/fixture.calendar-anchors.spec.ts",
    grep: "E-ANC2: .*a 403 on the read",
    expect: /E-ANC2:/,
    // Two independent guards stop a re-read after a 403 (the visit's read, the refusal noted on arrival): the unit MU-2462 removes the
    // first with a successful read; natively a 403's remount needs both gone (one alone was equivalent: run 2 of the author's driver).
    patch: (t) =>
      sub(
        readEveryMount(t),
        "  if (refusalOf(identity, anchorReadKey(taskId)) !== null) {\n",
        "  if (refusalOf(identity, anchorReadKey(taskId)) !== null && (false as boolean)) {\n",
      ),
  },
];

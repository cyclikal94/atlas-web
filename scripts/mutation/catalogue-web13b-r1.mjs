// Main reconciliation, 26 October 2026: WEB-13b MU-2501..MU-2551 are now MU-2586..MU-2636 (+85).
// Historical reports keep their original IDs; mutation patches, selectors and assertions are unchanged.
// WEB-13b revision 1's mutants (review 1, R1–R6), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its
// `UNIT` list after `catalogue-web13b.mjs`. Each removes ONE guard the revision added; `expect` names the test written for it, so only an
// assertion of that test catches it. `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const IMPORT_DIALOG = "src/features/calendars/ImportDialog.tsx";
const DROP_ZONE = "src/features/calendars/ImportDropZone.tsx";
const IMPORT_EDITOR = "src/features/calendars/import-editor.ts";
const ANCHOR_DIALOG = "src/features/calendars/AnchorDialog.tsx";
const ANCHOR_MODEL = "src/features/calendars/model/anchor.ts";
const PICKERS = "src/features/calendars/pickers.tsx";
const SOURCE_PAGES = "src/features/calendars/source-pages.tsx";
const REVIEW_PANEL = "src/features/calendars/ReviewPanel.tsx";
const SECTION = "src/features/tasks/detail/AnchorSection.tsx";
const TASKS_API = "src/features/tasks/api.ts";
const KEPT = "src/features/tasks/detail/anchor-kept.ts";
const EDITOR = "src/features/calendars/anchor-editor.ts";
const TASK_FORM = "src/features/tasks/form/TaskFormPage.tsx";
const T_IMPORT_UI = "tests/features/calendars/import-ui.test.tsx";
const T_ANCHOR_MODEL = "tests/features/calendars/anchor-model.test.ts";
const T_REVIEWS = "tests/features/calendars/review-panel.test.tsx";
const T_SECTION = "tests/features/tasks/anchor-section.test.tsx";
const T_FORM = "tests/features/tasks/task-form-anchor.test.tsx";

/**
 * Unit mutants (layer L1b, the production composition over the IndexedDB double; L1a for the model), MU-2471..MU-2589. Clear time's own
 * end of the kept time has no mutant: the time field's edit ends it too, so removing it changes nothing observable (an equivalent mutant,
 * recorded in the revision report).
 */
export const UNIT_13B_R1 = [
  {
    id: "MU-2471",
    title:
      "WEB-13b R1: a submission while the latest file is being read is not refused (the dialog says a file is missing)",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT_UI],
    expect: /R1: choosing another file forgets the previous one at once/,
    // Revision 6 (R7): re-expressed at the corrected text (the dialog now asks its editing session whether the latest file is read).
    patch: (t) => sub(t, "    if (editor.state().reading) return;\n", ""),
  },
  {
    id: "MU-2472",
    title:
      "WEB-13b R1: choosing another file keeps the previous one until the new one has been read",
    // Revision 6 (R7): re-expressed in the editing session, which now owns the chosen file (same defect).
    file: IMPORT_EDITOR,
    tests: [T_IMPORT_UI],
    expect: /R1: choosing another file forgets the previous one at once/,
    patch: (t) =>
      sub(
        t,
        "        file: null,\n        reading: true,\n",
        "        reading: true,\n",
      ),
  },
  {
    id: "MU-2473",
    title:
      "WEB-13b R1: Import is offered (enabled) while the file just chosen is being read",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT_UI],
    expect: /R1: choosing another file forgets the previous one at once/,
    patch: (t) =>
      sub(t, "          ) : reading ? (\n", "          ) : false ? (\n"),
  },
  {
    id: "MU-2474",
    title:
      "WEB-13b R3: a queued import closes the dialog whatever was changed in it while it was being stored",
    // Revision 6 (R7): re-expressed in the editing session, which now settles the save it made (same defect).
    file: IMPORT_EDITOR,
    tests: [T_IMPORT_UI],
    expect:
      /R3: a save that completes after the window was changed|R3: changed and changed back|R3: a file chosen while the save/,
    patch: (t) =>
      sub(
        t,
        "    if (state.revision === ticket.revision) {\n",
        "    if (ticket.revision >= 0) {\n",
      ),
  },
  {
    id: "MU-2475",
    title:
      "WEB-13b R3/R2's rule: a stored import's identity is not spent (Import again with the same choices is taken for the stored one)",
    // Revision 6 (R7): re-expressed in the editing session, which now holds the save identity (same defect).
    file: IMPORT_EDITOR,
    tests: [T_IMPORT_UI],
    expect: /R3: changed and changed back/,
    patch: (t) => sub(t, "    submission?.invalidate();\n", ""),
  },
  {
    id: "MU-2476",
    title:
      "WEB-13b R4: the drop zone is unavailable when the first page of sources holds none to import into",
    file: DROP_ZONE,
    tests: [T_IMPORT_UI],
    expect: /100 view-only sources and an editable 101st/,
    patch: (t) =>
      sub(
        t,
        "    open !== null && (sources.rows.length > 0 || sources.page.partial);\n",
        "    open !== null && sources.rows.length > 0;\n",
      ),
  },
  {
    id: "MU-2477",
    title:
      "WEB-13b R4: the import dialog's chosen source is not an option while another page of sources is shown",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT_UI],
    expect: /101 sources: the 101st is reached with Show next calendars/,
    patch: (t) =>
      sub(
        t,
        "                {source !== null &&\n                !importable.rows.some((row) => row.id === source.id) ? (\n",
        "                {false ? (\n",
      ),
  },
  {
    id: "MU-2478",
    title:
      "WEB-13b R4: a chooser shows one page of sources only (no Show previous/next calendars)",
    file: SOURCE_PAGES,
    tests: [T_IMPORT_UI, T_SECTION],
    expect:
      /101 sources: the 101st is reached with Show next calendars|100 view-only sources and an editable 101st|101 sources: Show next calendars reaches the 101st/,
    patch: (t) =>
      sub(
        t,
        "  if (previous === null && next === null) return null;\n",
        "  return null;\n",
      ),
  },
  {
    id: "MU-2479",
    title:
      "WEB-13b R4: the event picker's chosen source is not an option while another page of sources is shown",
    file: PICKERS,
    tests: [T_SECTION],
    expect: /101 sources: Show next calendars reaches the 101st/,
    patch: (t) =>
      sub(
        t,
        "    offPageRow === null ? pageRows : [offPageRow, ...pageRows];\n",
        "    pageRows;\n",
      ),
  },
  {
    id: "MU-2480",
    title:
      "WEB-13b R4: paging the event picker's calendars changes the source shown by default (its events' cursor goes stale)",
    file: PICKERS,
    tests: [T_SECTION],
    expect: /101 sources: Show next calendars reaches the 101st/,
    patch: (t) =>
      sub(
        t,
        "            if (chosen === null && sourceId !== null) setChosen(sourceId);\n",
        "",
      ),
  },
  {
    id: "MU-2481",
    title:
      "WEB-13b R4: the review panel has no way back to an earlier page (Show previous reviews)",
    file: REVIEW_PANEL,
    tests: [T_REVIEWS],
    expect:
      /101 reviews: Show more through page one|a later page holding only resolved reviews/,
    patch: (t) =>
      sub(
        t,
        '          {cursors.length > 1 ? (\n            <Button\n              variant="quiet"\n              onClick={() => {\n                setCursors((list) => list.slice(0, -1));\n',
        '          {false ? (\n            <Button\n              variant="quiet"\n              onClick={() => {\n                setCursors((list) => list.slice(0, -1));\n',
      ),
  },
  {
    id: "MU-2482",
    title:
      "WEB-13b R4: a later page with nothing unresolved hides the whole panel (and its way back)",
    file: REVIEW_PANEL,
    tests: [T_REVIEWS],
    expect: /a later page holding only resolved reviews/,
    patch: (t) =>
      sub(
        t,
        "    next === null &&\n    cursors.length === 1\n  )\n",
        "    next === null\n  )\n",
      ),
  },
  {
    id: "MU-2483",
    title:
      "WEB-13b R2's rule: a stored acknowledgement's identity is not spent (Acknowledge again reuses it)",
    file: REVIEW_PANEL,
    tests: [T_REVIEWS],
    expect: /an acknowledgement stored then discarded/,
    patch: (t) => sub(t, "        keys.current.delete(what);\n", ""),
  },
  {
    id: "MU-2484",
    title:
      "WEB-13b R2: a stored anchor change's identity is not retired (A, B, then A again is taken for the first A)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R2: A, B, then A again|R2: remove, then set the same anchor again/,
    // Re-anchored in revision 2 (the identities live with the task's visit: `operationKeys`).
    patch: (t) => sub(t, "        keys.delete(what);\n", ""),
  },
  {
    id: "MU-2485",
    title:
      "WEB-13b R2: every press is a new change (the same change pressed again after a failure that may have stored it is stored twice)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R2 retry: the SAME change pressed again/,
    patch: (t) =>
      sub(
        t,
        "    let key = keys.get(what);\n",
        "    let key: string | undefined;\n",
      ),
  },
  {
    id: "MU-2486",
    title:
      "WEB-13b R3: a done anchor save closes the panel whatever was edited in it meanwhile",
    // Re-expressed in revision 2: a done save consumes the editing session (whose consumption closes the panel) at any edit count.
    file: EDITOR,
    tests: [T_SECTION],
    expect:
      /R3: a save that completes after a hidden field was edited|R3: after a superseding Review save/,
    patch: (t) =>
      sub(
        t,
        "    else if (state.revision === ticket.revision) {\n",
        "    else if (ticket.revision >= 0) {\n",
      ),
  },
  {
    id: "MU-2487",
    title:
      "WEB-13b R3: after a superseding save that kept newer input, the next save supersedes the same (already replaced) change again",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R3: after a superseding Review save/,
    patch: (t) =>
      sub(
        t,
        "      (context) => ({ ...context, supersede: null, renewed: true }),\n",
        "      (context) => ({ ...context, renewed: true }),\n",
      ),
  },
  {
    id: "MU-2488",
    title:
      "WEB-13b R3: the save after a kept one is checked against the read the panel was opened from (refused as changed by its own change)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /R3: a save that completes after a hidden field was edited|R3: after a superseding Review save/,
    patch: (t) =>
      sub(
        t,
        "    const observed = context.renewed ? observedNow : context.observed;\n",
        "    const observed = context.observed;\n",
      ),
  },
  {
    id: "MU-2489",
    title:
      "WEB-13b R5: an anchor's own time is always rebuilt from its minutes (seconds dropped when anything else is edited)",
    file: ANCHOR_MODEL,
    tests: [T_ANCHOR_MODEL, T_SECTION],
    expect:
      /R5: an anchor's own time is kept exactly|R5: changing only the days keeps the anchor's own time 18:00:37|R5: an edited time is sent as typed/,
    patch: (t) =>
      sub(
        t,
        "  kept !== null && CLOCK_SECONDS.test(kept) && kept.slice(0, 5) === time\n",
        "  false\n",
      ),
  },
  {
    id: "MU-2490",
    title:
      "WEB-13b R5: editing the time field keeps the anchor's own exact time (typed back to the same minute, the old seconds are sent)",
    file: ANCHOR_DIALOG,
    tests: [T_SECTION],
    expect: /R5: an edited time is sent as typed/,
    patch: (t) =>
      sub(
        t,
        "                    edit({ time: event.target.value, keptTime: null })\n",
        "                    edit({ time: event.target.value })\n",
      ),
  },
  {
    id: "MU-2491",
    title:
      "WEB-13b R6: the binding read is not given its caller's lifetime (a not_sent retry is admitted after the visit ended)",
    file: TASKS_API,
    tests: [T_SECTION],
    expect: /a held read answered not_sent while the person leaves the task/,
    patch: (t) =>
      sub(
        t,
        '      get("/tasks/{id}/anchor", { path: { id: taskId } }, parseBinding, live),\n',
        '      get("/tasks/{id}/anchor", { path: { id: taskId } }, parseBinding),\n',
      ),
  },
  {
    id: "MU-2492",
    title:
      "WEB-13b R6: a lifetime-bound read never asks its caller's lifetime (admitted before and after every wait)",
    file: TASKS_API,
    tests: [T_SECTION],
    expect:
      /untilSentWhile asks live and connectivity|a held read answered not_sent while the person leaves the task/,
    patch: (t) =>
      sub(
        t,
        '    if (!live()) return { ok: false, kind: "closed" };\n    const away = offline();\n',
        "    const away = offline();\n",
      ),
  },
  {
    id: "MU-2493",
    title:
      "WEB-13b R6: a lifetime-bound read retried after a not_sent wait ignores going offline meanwhile (it is admitted again)",
    file: TASKS_API,
    tests: [T_SECTION],
    expect: /untilSentWhile asks live and connectivity/,
    patch: (t) => sub(t, "    if (away !== null) return away;\n", ""),
  },
  {
    id: "MU-2494",
    title:
      "WEB-13b R6: the section's lifetime is always live (leaving the task's screen does not stop the read's admissions)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /a held read answered not_sent while the person leaves the task/,
    patch: (t) =>
      sub(
        t,
        "    live.current = () => screenAt(address);\n",
        "    live.current = () => true;\n",
      ),
  },
  {
    id: "MU-2495",
    title:
      "WEB-13b R6 (I-CAL-ANC1 finding): the read's lifetime is the visit's, not the task screen's (revision 3: a section kept mounted across away-and-back follows the visit going on, so the same patch now sends an unsent read from the sync screens, where the visit goes on but the person is not at the task)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /away from the task and back in one turn|while the person checks the sync screens/,
    patch: (t) =>
      sub(
        t,
        "    live.current = () => screenAt(address);\n",
        "    live.current = () => !going.ended();\n",
      ),
  },
  {
    id: "MU-2496",
    title:
      "WEB-13b I1 (R3's family): the anchor panel's in-dialog sync control keeps nothing (its input is lost at the sync screens)",
    file: ANCHOR_DIALOG,
    tests: [T_SECTION, T_FORM],
    expect:
      /kept through the sync screens and back|a save still being made when the panel was kept/,
    patch: (t) =>
      sub(t, "      {...(onRetain === undefined\n", "      {...(true\n"),
  },
  {
    id: "MU-2497",
    title:
      "WEB-13b I1: the task detail does not resume a kept panel (the next panel starts from the binding)",
    // Re-expressed in revision 2: the task's visit never shows a kept session again (`openPanel`).
    file: KEPT,
    tests: [T_SECTION],
    expect:
      /kept through the sync screens and back: the next panel resumes every field|a save still being made when the panel was kept|Cancel discards/,
    patch: (t) =>
      sub(
        t,
        "    (held.editor.retained() || holdsInput(held.editor))\n",
        "    false\n",
      ),
  },
  {
    id: "MU-2498",
    title:
      "WEB-13b I1: the visit's end does not drop a kept panel (another visit resumes it)",
    file: KEPT,
    tests: [T_SECTION],
    expect: /an ordinary departure from the sync screens ends the visit/,
    // Re-expressed in revision 2: the visit's end ends nothing, and a session is shown again on any visit.
    patch: (t) =>
      sub(
        sub(
          t,
          "    if (held.owner === visit) {\n      held.editor.end();\n      panels.delete(key);\n    }\n",
          "    void [key, held, visit];\n",
        ),
        "    held.owner === owner &&\n",
        "",
      ),
  },
  {
    id: "MU-2499",
    title:
      "WEB-13b I1: a resumed panel is not taken (a Cancel of it does not discard: the next panel resumes it again)",
    // Re-expressed in revision 2: a session shown again stays marked as kept by the sync control, so its Cancel does not end it.
    file: EDITOR,
    tests: [T_SECTION],
    expect: /Cancel discards/,
    patch: (t) =>
      sub(
        t,
        "    resume() {\n      kept = false;\n    },\n",
        "    resume() {},\n",
      ),
  },
  {
    id: "MU-2500",
    title:
      "WEB-13b I1: a kept panel whose pending save stored exactly what it held is still resumed (offered to be saved twice)",
    // Re-expressed in revision 2: a session whose save stored exactly what it held is not consumed.
    file: EDITOR,
    tests: [T_SECTION],
    expect: /a save still being made when the panel was kept/,
    patch: (t) =>
      sub(
        t,
        '      over = true;\n      publish("consumed");\n      listeners.clear();\n      onConsumed?.();\n',
        "      change({ busy: false });\n",
      ),
  },
  {
    id: "MU-2586",
    title:
      "WEB-13b I1: a kept panel's newer input after its own save keeps the old context (its save is refused as changed by its own change)",
    // Re-expressed in revision 2: the session's own done save does not renew what its next save is checked against.
    file: EDITOR,
    tests: [T_SECTION],
    expect: /a save still being made when the panel was kept/,
    patch: (t) => sub(t, "      current = renew(current);\n", ""),
  },
  {
    id: "MU-2587",
    title:
      "WEB-13b I1: a save done after the panel was kept is never settled (the kept state of a saved change is resumed)",
    // Re-expressed in revision 2: the session never hears its save's completion.
    file: EDITOR,
    tests: [T_SECTION],
    expect: /a save still being made when the panel was kept/,
    patch: (t) =>
      sub(
        t,
        "        (refused) => settle(ticket, refused),\n",
        "        () => undefined,\n",
      ),
  },
  {
    id: "MU-2588",
    title: "WEB-13b I1: the new-task form does not resume its kept panel",
    file: TASK_FORM,
    tests: [T_FORM],
    expect: /kept through the sync screens and back: the next panel resumes it/,
    // Re-anchored in revision 2 (the kept panel starts the panel's own session).
    patch: (t) => sub(t, "        ...(panel ?? {\n", "        ...({\n"),
  },
  {
    id: "MU-2589",
    title:
      "WEB-13b I1: the new-task form's resumed panel, cancelled, is resumed again (Cancel does not discard it)",
    file: TASK_FORM,
    tests: [T_FORM],
    expect: /kept through the sync screens and back: the next panel resumes it/,
    patch: (t) => sub(t, "    if (panel !== null) onPanel(null);\n", ""),
  },
];

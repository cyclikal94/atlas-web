// WEB-13b revision 6's mutants (review 6 R7, family task-sync-navigation-draft-loss; the design assessment's Stage 2 sensitivity list), in
// the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r5.mjs`. Each
// restores ONE part of the defect the revision corrected (the import dialog's input belonged to its mount) or removes one boundary of the
// editing session's ownership; `expect` names the tests written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): clearing the screen's import dialog without comparing the session it shows is
// equivalent here, because only a mounted dialog's own consumption or press calls it and a replaced dialog is unmounted; a consumed
// session that stays held is equivalent, because the next open finds it ended and starts a new one.
import { sub } from "./data-catalogue.mjs";

const DIALOG = "src/features/calendars/ImportDialog.tsx";
const EDITOR = "src/features/calendars/import-editor.ts";
const KEPT = "src/features/calendars/import-kept.ts";
const DROP_ZONE = "src/features/calendars/ImportDropZone.tsx";
const SOURCES = "src/features/calendars/CalendarSources.tsx";
const T_RET = "tests/features/calendars/import-retention.test.tsx";
const T_EDITOR = "tests/features/calendars/import-editor.test.ts";
const T_KEPT = "tests/features/calendars/import-kept.test.ts";

export const UNIT_13B_R6 = [
  {
    id: "MU-5110",
    title:
      "WEB-13b R7: the import dialog discards its session whenever it unmounts (the in-dialog sync control loses the file and the window)",
    file: DIALOG,
    tests: [T_RET],
    expect: /I1\/I2: chosen file and edited window/,
    patch: (t) =>
      sub(t, "      hideImport(editor);\n", "      discardImport(editor);\n"),
  },
  {
    id: "MU-5111",
    title:
      "WEB-13b R7: opening Import events again always starts a new session (the kept one is never shown again)",
    file: KEPT,
    tests: [T_RET, T_KEPT],
    expect:
      /I1\/I2: chosen file and edited window|the same row shows the SAME session/,
    patch: (t) =>
      sub(t, "    sameEntry(which.entry, entry) &&\n", "    false &&\n"),
  },
  {
    id: "MU-5112",
    title:
      "WEB-13b R7: a file read settles only while a dialog shows the session (a read finished while away is lost, the session stuck reading)",
    file: EDITOR,
    tests: [T_RET, T_EDITOR],
    expect: /I5: a read still under way|I5: a read held while nothing shows/,
    patch: (t) =>
      sub(
        t,
        "        if (over || read !== latestRead) return;\n",
        "        if (over || read !== latestRead || listeners.size === 0) return;\n",
      ),
  },
  {
    id: "MU-5113",
    title:
      "WEB-13b R7/R1: a read settles whichever choice it was for (an older file's late read replaces the newer choice)",
    file: EDITOR,
    tests: [T_EDITOR],
    expect: /I7: read A pending, choose B/,
    patch: (t) =>
      sub(
        t,
        "        if (over || read !== latestRead) return;\n",
        "        if (over) return;\n",
      ),
  },
  {
    id: "MU-5114",
    title:
      "WEB-13b R7/R3b: an ended session's save settles it (Cancel's old save changes, consumes or announces into an ended session)",
    file: EDITOR,
    tests: [T_EDITOR],
    expect:
      /I11\/I12: a save pending when the session is|I11: a refused save of an ended session/,
    patch: (t) => sub(t, "    if (over) {\n", "    if (false) {\n"),
  },
  {
    id: "MU-5115",
    title:
      "WEB-13b R7/R2: every press is a new operation (a refused or uncertain save pressed again gets a new identity)",
    file: EDITOR,
    tests: [T_EDITOR, T_RET],
    expect:
      /I10: a refused save keeps the input|I10: a refusal answered while away/,
    patch: (t) =>
      sub(
        t,
        "      const { key } = submission.attempt(choice);\n",
        "      submission.invalidate();\n      const { key } = submission.attempt(choice);\n",
      ),
  },
  {
    id: "MU-5116",
    title:
      "WEB-13b R7: a kept session does not observe the identity (A→B→A gives A's old input back)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect: /A→B→A/,
    patch: (t) =>
      sub(
        t,
        '      if (identityOf(context.identities.get()) !== which.identity)\n        release(which, "revoked");\n',
        "",
      ),
  },
  {
    id: "MU-5117",
    title:
      "WEB-13b R7: the import's visit does not end at an ordinary departure (input outlives leaving the screen and the sync screens)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /an ordinary departure|rapid away and back|a session ended by its visit holds no subscription|I13: leaving the sync screens/,
    patch: (t) =>
      sub(
        t,
        "      if (!which.inside || (!isCalendarsPath(pathname) && !atSync(pathname)))\n",
        "      if (!which.inside)\n",
      ),
  },
  {
    id: "MU-5118",
    title:
      "WEB-13b R7: the database a session was composed against is not compared (another incarnation shows or saves the old input)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /another database for the same identity|another incarnation\) is never saved into/,
    patch: (t) =>
      sub(
        t,
        "  return which.incarnation !== context.incarnation;\n",
        "  return false;\n",
      ),
  },
  {
    id: "MU-5119",
    title:
      "WEB-13b R7: a kept session does not observe the cache being brought up to date (the open dialog's E9 rule skipped while away)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect: /cache hidden to be brought up to date/,
    patch: (t) =>
      // Re-anchored in revision 7 (R7): the same defect at the corrected observation of the page's cache lifetime. Re-anchored again in
      // revision 8 (R7a/R7b): the kept session's subscription to the page's cache lifetime is not made.
      sub(
        t,
        "  if (context.cache !== null)\n    which.offs.push(context.cache.subscribe(which.judge));\n",
        "",
      ),
  },
  {
    id: "MU-5120",
    title:
      "WEB-13b R7: a revoked session's stored save is still announced (the previous identity's feedback on the next one's screen)",
    file: EDITOR,
    tests: [T_EDITOR, T_RET],
    expect:
      /I11\/I12: a save pending when the session is revoked|I12: a save held across A→B→A/,
    patch: (t) =>
      sub(
        t,
        '      if (outcome?.kind === "queued" && !revoked) onQueued?.();\n',
        '      if (outcome?.kind === "queued") onQueued?.();\n',
      ),
  },
  {
    id: "MU-5121",
    title:
      "WEB-13b R7: the in-dialog sync control saves the import (retention queues an unconsented import)",
    file: DIALOG,
    tests: [T_RET],
    expect: /I1\/I2: chosen file and edited window/,
    patch: (t) =>
      sub(
        t,
        "        if (sourceId === null && selected !== null) editor.pinSource(selected);\n",
        "        submit();\n        if (sourceId === null && selected !== null) editor.pinSource(selected);\n",
      ),
  },
  {
    id: "MU-5122",
    title:
      "WEB-13b R7: the chooser's shown source is not kept with its session (a different first source is offered on return)",
    file: DIALOG,
    tests: [T_RET],
    expect: /the first source offered is kept/,
    patch: (t) =>
      sub(
        t,
        "        if (sourceId === null && selected !== null) editor.pinSource(selected);\n",
        "",
      ),
  },
  {
    id: "MU-5123",
    title:
      "WEB-13b R7: the drop zone's Browse never shows its kept import (it asks for another file)",
    file: DROP_ZONE,
    tests: [T_RET],
    expect: /I4: the drop zone's import .*Browse shows it again/,
    patch: (t) =>
      sub(
        t,
        "                if (open?.resumeChooser() === true) return;\n",
        "",
      ),
  },
  {
    id: "MU-5124",
    title:
      "WEB-13b R7: a kept row import is shown for ANY row (another source's Import events borrows its input)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /a different row is a deliberate new edit|a row's kept import is not the drop zone's/,
    patch: (t) =>
      sub(
        t,
        '    ? b.kind === "row" && b.sourceId === a.sourceId\n',
        '    ? b.kind === "row"\n',
      ),
  },
  {
    id: "MU-5125",
    title: "WEB-13b R7: Cancel keeps the session (it is shown again)",
    file: DIALOG,
    tests: [T_RET],
    expect: /I1 control: Cancel discards/,
    patch: (t) =>
      sub(
        t,
        "            onClick={() => {\n              discard();\n              onClose();\n            }}\n",
        "            onClick={onClose}\n",
      ),
  },
  {
    id: "MU-5126",
    title:
      "WEB-13b R7: Escape and the close icon keep the session (they must discard, as Cancel does)",
    file: DIALOG,
    tests: [T_RET],
    expect: /discards like Cancel/,
    patch: (t) => sub(t, "      onDiscard={discard}\n", ""),
  },
  {
    id: "MU-5127",
    title:
      "WEB-13b R7: a file dropped while the drop zone's import is kept is not chosen in it",
    file: SOURCES,
    tests: [T_RET],
    expect: /a file dropped while the drop zone's import is kept/,
    patch: (t) =>
      sub(t, "        if (file !== undefined) editor.choose(file);\n", ""),
  },
  {
    id: "MU-5128",
    title:
      "WEB-13b R7: Import does not ask whether the session is still the displayed database's (saved into another incarnation)",
    file: DIALOG,
    tests: [T_RET],
    expect: /another incarnation\) is never saved into/,
    patch: (t) => sub(t, "    if (!owned()) {\n", "    if (false) {\n"),
  },
];

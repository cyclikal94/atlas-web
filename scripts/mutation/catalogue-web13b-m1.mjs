// WEB-13b's maintenance merge of accepted main, correction M-13b-1 (Kieran, 7 November 2026, "Fix all three in the merge":
// approval/web13b-m13b1-decision-20261107.json in the orchestrator): WEB-13b's editors take part in WEB-14a's app-update recovery (Q4). In
// the form and under the rules of `data-catalogue.mjs`, which spreads `UNIT_13B_M1` into its `UNIT` list after `catalogue-web13b-r36.mjs`.
// Each removes ONE part of the correction; `expect` names the case written for it, so only an assertion of that case catches it. The IDs
// MU-5276..MU-5295 follow WEB-13b's last (MU-5275) and are unused on accepted main, WEB-18 (4bd32ac, 6dbc9a0) and WEB-12b's prepared tree.
//
// G-1 (the task form's text keeps the new task's anchor): MU-5276..MU-5280. G-2 (the anchor panel, `AnchorDialog`, through
// `session-recovery.ts`, on the new-task form and a task's detail): MU-5281..MU-5286, MU-5293..MU-5295. G-3 (the import dialog):
// MU-5287..MU-5292.
//
// Considered and not selected (recorded for the reviewer):
// - `useSessionRecovery` not beginning the model for a session it has not seen: the editor's own mount begins it whenever no stale `keep`
//   stands, so no case here tells the two apart (the stale `keep` of an ended, kept session is the case the begin is for; it is covered by
//   the visit-end control's next panel only in composition, not in an assertion of its own).
// - `useOpenWhenReady` opening at once (without waiting for the host to be ready): the hosts tested here are ready by the time the look
//   restores, so the early opening is equivalent in these cases; the wait is a robustness rule for a host still reading its task.
//
// Revision 37 (Review 46 F-R46-1/F-R46-2, family `kept-session-unfinished-marker-lost`): a kept import session's file (chosen or still being
// read) outlives its dialog, and the model goes on asking the session while it is kept (`editor.ts` `keep(value, unfinished)`, wired by
// `session-recovery.ts`). Unit MU-5296..MU-5299 over `web13b-import-recovery.test.tsx`, whose STOP cases leave the dialog by its sync
// control with nothing asking the model in between (the old case asked `pageFormRegistry.dirty()` while the dialog was shown, which alone
// kept MU-5287 caught); real-engine MU-5300 over E-IMP7's revision-37 case (`fixture.calendar-import.spec.ts`, the fixture build the engine
// runner serves: the PWA generations of `fixture.pwa-editors.spec.ts` are built apart from it, so no engine mutant can reach those cases).
// Considered and not selected (revision 37):
// - the editor's mount not forgetting a kept check (`entry.keptProbe = null`), or its `else` that stops asking one for an editor with no
//   check of its own: a session's dialog always has its own check, and every later way out of the mount (`begin`, `edit`, a keep, an end)
//   sets the kept check again or releases it, so no case can tell either from its absence (defence of the invariant "a kept check only while
//   kept").
// - `begin` not releasing: `begin` comes only from a dialog that is shown, whose mount has already forgotten the kept check.
// - the unmount asking `entry.keptProbe` when kept before it: the session bridge keeps after the editor's own unmount (React runs the
//   cleanups in order), so this branch serves a `keep` made while shown, which no production caller makes with a check.
import { sub } from "./data-catalogue.mjs";

const FORM_INPUT = "src/features/tasks/form/form-input.ts";
const ANCHOR_RECOVERY = "src/features/calendars/anchor-recovery.ts";
const IMPORT_RECOVERY = "src/features/calendars/import-recovery.ts";
const ANCHOR_DIALOG = "src/features/calendars/AnchorDialog.tsx";
const IMPORT_DIALOG = "src/features/calendars/ImportDialog.tsx";
const SESSION = "src/features/calendars/session-recovery.ts";
const DETAIL = "src/features/tasks/detail/AnchorSection.tsx";
const FORM = "src/features/tasks/form/TaskFormPage.tsx";
const ACTION = "src/features/calendars/import-action.tsx";

const T_ANCHOR = "tests/features/tasks/web13b-anchor-recovery.test.tsx";
const T_IMPORT = "tests/features/calendars/web13b-import-recovery.test.tsx";
const T_CODECS = "tests/features/calendars/web13b-recovery-codecs.test.ts";
const EDITOR = "src/lib/form-recovery/editor.ts";
const IMPORT_SPEC = "tests/e2e/fixture.calendar-import.spec.ts";
/** Revision 37: the two STOP cases (a file chosen, a file still being read), each with the dialog left by its sync control. */
const IMPORT_STOPS =
  /left by its sync control.*the accepted update STOPS|the accepted update STOPS.*left by its sync control/;
const IMPORT_KEPT_END =
  /CONTROL: a kept session that ENDS \(the person goes elsewhere\) while its file is still being read/;

const FORM_PANEL_CASE =
  /open and edited: registered \(Save and reload\) and dirty; the accepted update saves its draft; after the reload the form comes back/;
const DETAIL_CASE =
  /left by its sync control it stays registered and dirty; the accepted update saves its draft and the read of the task/;
const IMPORT_FREEZE =
  /while an update reload is prepared the dialog takes no window edit and no file, and Import stores nothing/;

export const UNIT_13B_M1 = [
  // ---- G-1 -------------------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-5276",
    title:
      "WEB-13b M-13b-1 G-1: the task form's text drops the new task's anchor (WEB-14a's version 1 did): restored without it, saved unanchored",
    file: FORM_INPUT,
    tests: [T_ANCHOR],
    expect:
      /an anchored new task: the accepted update saves the form WITH its anchor/,
    patch: (t) =>
      sub(t, "    anchor: input.anchor ?? null,\n", "    anchor: null,\n"),
  },
  {
    id: "MU-5277",
    title:
      "WEB-13b M-13b-1 G-1: a copy's anchor is taken as it is stored, without reading it back (an anchor no check has passed is restored)",
    file: FORM_INPUT,
    tests: [T_CODECS],
    expect:
      /an anchor its draft does not validate to, another version, or a malformed panel is unreadable/,
    patch: (t) =>
      sub(
        t,
        "    const anchor = raw.anchor === null ? null : readFormAnchor(raw.anchor);\n",
        "    const anchor = raw.anchor === null ? null : (raw.anchor as never);\n",
      ),
  },
  {
    id: "MU-5278",
    title:
      "WEB-13b M-13b-1 G-1: a version-1 copy (a build without anchors) is unreadable instead of restoring with no anchor",
    file: FORM_INPUT,
    tests: [T_CODECS, T_ANCHOR],
    expect: /a version-1 (text|copy)/,
    patch: (t) =>
      sub(
        t,
        "    if (raw.v === 1) return decodeTaskFormInput(text);\n",
        "    if (raw.v === 1) return null;\n",
      ),
  },
  {
    id: "MU-5279",
    title:
      "WEB-13b M-13b-1 G-1: the task form's text drops the panel its in-dialog sync control kept",
    file: FORM_INPUT,
    tests: [T_CODECS],
    expect: /keeps the anchor and the kept panel, and reads them back/,
    patch: (t) =>
      sub(t, "    panel: input.panel ?? null,\n", "    panel: null,\n"),
  },
  {
    id: "MU-5280",
    title:
      "WEB-13b M-13b-1 G-1: a stored anchor is read back without checking that its draft validates to exactly it",
    file: ANCHOR_RECOVERY,
    tests: [T_CODECS],
    expect:
      /a stored anchor is read only when its draft validates to exactly it/,
    patch: (t) =>
      sub(
        t,
        "  if (canonical(validated.anchor) !== canonical(raw.anchor)) return null;\n",
        "",
      ),
  },
  // ---- G-2 -------------------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-5281",
    title:
      "WEB-13b M-13b-1 G-2: the panel's edits are not given to its recoverable model (never dirty: an update reloads over them)",
    file: ANCHOR_DIALOG,
    tests: [T_ANCHOR],
    expect: FORM_PANEL_CASE,
    patch: (t) =>
      sub(
        t,
        "    if (!panel.edit(next)) return;\n    editor.edit(patch, picked);\n",
        "    editor.edit(patch, picked);\n",
      ),
  },
  {
    id: "MU-5282",
    title:
      "WEB-13b M-13b-1 G-2: the panel's Save stays available while an update reload is prepared",
    file: ANCHOR_DIALOG,
    tests: [T_ANCHOR],
    expect:
      /while an update reload is prepared the panel takes no edit and no Save/,
    patch: (t) =>
      sub(t, "            ) : locked ? (\n", "            ) : false ? (\n"),
  },
  {
    id: "MU-5283",
    title:
      "WEB-13b M-13b-1 G-2: a panel hidden while its owner keeps the session (the sync control) is dismissed: its copies go, an update saves nothing",
    file: SESSION,
    tests: [T_ANCHOR],
    expect: DETAIL_CASE,
    // Revision 37: re-anchored to the keep that now also hands the session's own check (the same fault: the hidden session is not kept).
    patch: (t) =>
      sub(
        t,
        "      if (!shown.ended())\n        latestRecovery.current.keep(\n          undefined,\n          latest.current.unfinished\n            ? () => latest.current.unfinished?.() ?? false\n            : undefined,\n        );\n",
        "",
      ),
  },
  {
    id: "MU-5284",
    title:
      "WEB-13b M-13b-1 G-2: the owner's end of a kept session (the visit's end) leaves its copies (a departure restored after a later reload)",
    file: SESSION,
    tests: [T_ANCHOR],
    expect: /CONTROL: the task visit's end ends a kept panel's copies/,
    patch: (t) =>
      sub(
        t,
        "        given.delete(key);\n        void latestRecovery.current.end();\n",
        "        given.delete(key);\n",
      ),
  },
  {
    id: "MU-5285",
    title:
      "WEB-13b M-13b-1 G-2: the task detail never reopens the panel on a restored copy (the copy only waits in the store)",
    file: DETAIL,
    tests: [T_ANCHOR],
    expect: DETAIL_CASE,
    patch: (t) =>
      sub(
        t,
        "      () => open(anchor, null),\n    ),\n",
        "      () => undefined,\n    ),\n",
      ),
  },
  {
    id: "MU-5286",
    title:
      "WEB-13b M-13b-1 G-2: a restored detail panel is checked against the task as it is NOW, not as it was read when composed (a silent overwrite)",
    file: DETAIL,
    tests: [T_ANCHOR],
    expect:
      /a restored change of a task that changed since it was composed is never saved over it/,
    patch: (t) =>
      sub(
        t,
        "        observed: read,\n        renewed,\n",
        "        observed: read,\n        renewed: true,\n",
      ),
  },
  // ---- G-3 -------------------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-5287",
    title:
      "WEB-13b M-13b-1 G-3: a chosen file is not input the model cannot hold: the update saves the window and reloads over the file",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT],
    expect:
      /a file chosen is input no copy can hold: the accepted update STOPS/,
    patch: (t) =>
      sub(t, "        now.file !== null ||\n        now.reading ||\n", ""),
  },
  {
    id: "MU-5288",
    title:
      "WEB-13b M-13b-1 G-3: From is changed without the model's admission (taken while an update reload is prepared)",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT],
    expect: IMPORT_FREEZE,
    patch: (t) =>
      sub(
        t,
        "            if (admit({ from })) editor.editWindow({ from });\n",
        "            editor.editWindow({ from });\n",
      ),
  },
  {
    id: "MU-5289",
    title:
      "WEB-13b M-13b-1 G-3: a source's row never reopens the import dialog on a restored copy",
    file: ACTION,
    tests: [T_IMPORT],
    expect: /a row's dialog: registered and dirty once its window is edited/,
    patch: (t) =>
      sub(
        t,
        "    open: useOpenWhenReady(enablement.enabled, () => open?.open(source.id)),\n",
        "    open: useOpenWhenReady(enablement.enabled, () => undefined),\n",
      ),
  },
  {
    id: "MU-5290",
    title:
      "WEB-13b M-13b-1 G-3: Import stays available while an update reload is prepared",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT],
    expect: IMPORT_FREEZE,
    patch: (t) =>
      sub(t, "          ) : locked ? (\n", "          ) : false ? (\n"),
  },
  {
    id: "MU-5291",
    title:
      "WEB-13b M-13b-1 G-3: an import copy of another version is read as this one's",
    file: IMPORT_RECOVERY,
    tests: [T_CODECS],
    expect: /another version, another shape or an overlong field is null/,
    patch: (t) =>
      sub(t, "    if (raw.v !== IMPORT_INPUT_VERSION) return null;\n", ""),
  },
  {
    id: "MU-5292",
    title:
      "WEB-13b M-13b-1 G-3: a file is chosen without the model's admission (taken while an update reload is prepared)",
    file: IMPORT_DIALOG,
    tests: [T_IMPORT],
    expect: IMPORT_FREEZE,
    patch: (t) =>
      sub(
        t,
        "              if (chosenFile !== undefined && admit({}))\n",
        "              if (chosenFile !== undefined)\n",
      ),
  },
  // ---- G-2, continued ----------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-5293",
    title:
      "WEB-13b M-13b-1 G-2: an anchor panel copy of another version is read as this one's",
    file: ANCHOR_RECOVERY,
    tests: [T_CODECS],
    expect: /version 1 with the host's base; another version/,
    patch: (t) =>
      sub(
        t,
        "    if (!isRaw(raw) || raw.v !== ANCHOR_PANEL_VERSION) return null;\n",
        "    if (!isRaw(raw)) return null;\n",
      ),
  },
  {
    id: "MU-5294",
    title:
      "WEB-13b M-13b-1 G-2: the new-task form never reopens the panel on a restored copy",
    file: FORM,
    tests: [T_ANCHOR],
    expect: FORM_PANEL_CASE,
    patch: (t) =>
      sub(
        t,
        "    open: useOpenWhenReady(open === null, openPanel),\n",
        "    open: useOpenWhenReady(false, openPanel),\n",
      ),
  },
  {
    id: "MU-5295",
    title:
      "WEB-13b M-13b-1 G-2: a panel reopened on a restored copy opens with the dialog's default focus, not its first field",
    file: ANCHOR_DIALOG,
    tests: [T_ANCHOR],
    expect: FORM_PANEL_CASE,
    patch: (t) =>
      sub(
        t,
        "  const [restoredAtOpen] = useState(() => panel.view.restored !== null);\n",
        "  const [restoredAtOpen] = useState(() => false);\n",
      ),
  },
  // ---- revision 37 (Review 46 F-R46-1): a kept session's input no copy can hold -----------------------------------------------------------
  {
    id: "MU-5296",
    title:
      "WEB-13b revision 37 (F-R46-1): the session bridge keeps a hidden session without its own check (the review's defect: a file chosen is dropped from the model with the dialog, and the update reloads over it)",
    file: SESSION,
    tests: [T_IMPORT],
    expect: IMPORT_STOPS,
    patch: (t) =>
      sub(
        t,
        "          latest.current.unfinished\n            ? () => latest.current.unfinished?.() ?? false\n            : undefined,\n",
        "          undefined,\n",
      ),
  },
  {
    id: "MU-5297",
    title:
      "WEB-13b revision 37 (F-R46-1): a session kept after its editor's unmount records its check but the model is never told to ask it",
    file: EDITOR,
    tests: [T_IMPORT],
    expect: IMPORT_STOPS,
    patch: (t) =>
      sub(
        t,
        "        if (entry.editor === null) model.probe(unfinished);\n",
        "",
      ),
  },
  {
    id: "MU-5298",
    title:
      "WEB-13b revision 37 (F-R46-1): a kept session's end does not release its check (an update keeps stopping for a file the person can no longer reach)",
    file: EDITOR,
    tests: [T_IMPORT],
    expect: IMPORT_KEPT_END,
    patch: (t) =>
      sub(
        t,
        "    end: () => {\n      release();\n      return model.end();\n    },\n",
        "    end: () => model.end(),\n",
      ),
  },
  {
    id: "MU-5299",
    title:
      "WEB-13b revision 37 (F-R46-1): a released check is forgotten by the editor but the model goes on asking it",
    file: EDITOR,
    tests: [T_IMPORT],
    expect: IMPORT_KEPT_END,
    patch: (t) =>
      sub(
        t,
        "    entry.keptProbe = null;\n    if (entry.editor === null) model.probe(null);\n",
        "    entry.keptProbe = null;\n",
      ),
  },
];

export const ENGINE_13B_M1 = [
  {
    id: "MU-5300",
    title:
      "WEB-13b revision 37 (F-R46-1): (REAL ENGINE) the session bridge keeps a hidden import session without its own check: after the sync control the update's save writes the window and reports success over the chosen file",
    file: SESSION,
    spec: IMPORT_SPEC,
    grep: "E-IMP7.*revision 37 \\(Review 46 F-R46-1\\)",
    expect: /revision 37 \(Review 46 F-R46-1\)/,
    patch: (t) =>
      sub(
        t,
        "          latest.current.unfinished\n            ? () => latest.current.unfinished?.() ?? false\n            : undefined,\n",
        "          undefined,\n",
      ),
  },
];

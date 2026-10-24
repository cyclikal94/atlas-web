// WEB-10a revision 18's mutants (Review 18 R33, family `task-sync-navigation-draft-loss`: checking sync state discards unfinished task
// input), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Kept in their
// own module as revisions 16 and 17's are (the catalogue is at Biome's 1 MiB file-size limit). `sub` is the catalogue's own
// exactly-one-occurrence patcher (a function declaration, so the circular import is safe).
import { sub } from "./data-catalogue.mjs";

const RETENTION = "tests/features/tasks/sync-visit-retention.test.tsx";
const ACK = "tests/features/tasks/save-acknowledgement.test.tsx";
const OWNERSHIP = "tests/features/tasks/correction-ownership.test.tsx";
const KEPT = "src/features/tasks/kept-input.ts";
const FORM = "src/features/tasks/form/TaskFormPage.tsx";
const HISTORY = "src/features/tasks/detail/EntryHistory.tsx";

/** Unit mutants (layer L1b: the app's router over the production data controller and the IndexedDB double), MU-2330..MU-2349. */
export const UNIT_R18 = [
  {
    id: "MU-2330",
    title:
      "WEB-10a rev 18 (R33): a visit to the sync screens keeps nothing (review 18's defect: every editor's input is dropped)",
    file: KEPT,
    tests: [RETENTION],
    expect:
      /left for the sync queue and back|stage chosen and nothing typed|raw \(here invalid, empty\) name|amount being typed \(raw\)|record mode is kept/,
    patch: (t) =>
      sub(
        t,
        `  if (toSync && (unedited || held.revision > 0 || held.submitting !== null)) {`,
        `  if (false as boolean) {`,
      ),
  },

  {
    id: "MU-2331",
    title:
      "WEB-10a rev 18 (R33): every departure keeps the input, not only a visit to the sync screens",
    file: KEPT,
    tests: [RETENTION],
    expect:
      /control: left for the task list instead|control: left for the task's detail instead|control: left for Today instead/,
    patch: (t) =>
      sub(
        t,
        `  if (toSync && (unedited || held.revision > 0 || held.submitting !== null)) {`,
        `  if (unedited || held.revision > 0 || held.submitting !== null) {`,
      ),
  },

  {
    id: "MU-2332",
    title:
      "WEB-10a rev 18 (R33): an unedited session is kept through a sync visit (a newer synced definition is hidden behind it)",
    file: KEPT,
    tests: [RETENTION],
    expect: /an unedited form holds nothing of the person's/,
    patch: (t) =>
      sub(
        t,
        `  if (toSync && (unedited || held.revision > 0 || held.submitting !== null)) {`,
        `  if (toSync) {`,
      ),
  },

  {
    id: "MU-2333",
    title:
      "WEB-10a rev 18 (R33): a creation stage the person chose is not kept until something is typed (the picker comes back)",
    file: KEPT,
    tests: [RETENTION],
    expect: /stage chosen and nothing typed yet is kept/,
    patch: (t) =>
      sub(
        t,
        `  if (toSync && (unedited || held.revision > 0 || held.submitting !== null)) {`,
        `  if (toSync && (held.revision > 0 || held.submitting !== null)) {`,
      ),
  },

  {
    id: "MU-2334",
    title:
      "WEB-10a rev 18 (R33): opening an editor no longer forgets other identities' kept input",
    file: KEPT,
    tests: [RETENTION],
    expect: /another identity never sees it/,
    patch: (t) =>
      sub(
        t,
        `    if (!other.startsWith(\`\${identity}\\u0000\`)) entries.delete(other);\n`,
        "    if (false as boolean) entries.delete(other);\n",
      ),
  },

  {
    id: "MU-2335",
    title:
      "WEB-10a rev 18 (R33): a save's success consumes the session whatever was typed after it (newer input lost)",
    file: KEPT,
    tests: [RETENTION, ACK],
    expect:
      /with a newer edit: the newer title stays|clears only the amount it submitted|success closes it unless a newer value|amount typed while the save was pending stays/,
    patch: (t) =>
      sub(
        t,
        `  if (saved && held.revision === ticket.revision) {`,
        `  if (saved) {`,
      ),
  },

  {
    id: "MU-2336",
    title:
      "WEB-10a rev 18 (R33): a successful save never consumes the session (the saved input comes back, a second create offered)",
    file: KEPT,
    tests: [RETENTION, ACK, OWNERSHIP],
    expect:
      /its success consumes the form|clears only the amount it submitted|a success with nothing typed since clears the field|the success opens the new task's detail/,
    patch: (t) =>
      sub(
        t,
        `  if (saved && held.revision === ticket.revision) {`,
        `  if (saved && (false as boolean)) {`,
      ),
  },

  {
    id: "MU-2337",
    title:
      "WEB-10a rev 18 (R33): a settled save leaves no note (the refusal or the newer-edits note is lost on the way back)",
    file: KEPT,
    tests: [RETENTION],
    expect:
      /a refused save: the input and the refusal are kept|with a newer edit: the newer title stays, with the note/,
    patch: (t) =>
      sub(t, `  held.note = outcome.note ?? null;\n`, `  held.note = null;\n`),
  },

  {
    id: "MU-2338",
    title:
      "WEB-10a rev 18 (R33): a session resumed after the visit stays kept for good (leaving elsewhere no longer drops it)",
    file: KEPT,
    tests: [RETENTION],
    expect: /after coming back, leaving for anywhere else drops it/,
    patch: (t) =>
      sub(
        t,
        `    held.holders += 1;\n    held.kept = false;\n`,
        `    held.holders += 1;\n`,
      ),
  },

  {
    id: "MU-2339",
    title:
      "WEB-10a rev 18 (R33): after a save consumed the session the editor holds none (what is typed next is not kept)",
    file: KEPT,
    tests: [RETENTION],
    expect: /the next amount typed is kept through a visit too/,
    patch: (t) =>
      sub(
        t,
        `      if (next !== null) open(() => next);`,
        `      if (next !== null && (false as boolean)) open(() => next);`,
      ),
  },

  {
    id: "MU-2340",
    title:
      "WEB-10a rev 18 (R33): the editor's unmount never reads where the router went (the sync screens look like any departure)",
    file: KEPT,
    tests: [RETENTION],
    expect:
      /left for the sync queue and back|amount being typed \(raw\)|raw \(here invalid, empty\) name/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored in revision 21 (same intent): the router's path is read through \`useLatestPath\`.
        "  return () => atSync(path());",
        `  return () => atSync("");`,
      ),
  },

  {
    id: "MU-2341",
    title:
      "WEB-10a rev 18 (R33): a new-task form kept through the visit is not resumed (the picker is shown again)",
    file: FORM,
    tests: [RETENTION],
    expect:
      /left for the sync queue and back|stage chosen and nothing typed|the kept form saves what is shown|with a newer edit|a refused save/,
    patch: (t) =>
      sub(
        t,
        `    keptEntry(keptKey(env.identity, NEW_FORM)) === null ? "pick" : "kept",`,
        `    keptEntry(keptKey(env.identity, NEW_FORM)) === null ? "pick" : "pick",`,
      ),
  },

  {
    id: "MU-2342",
    title:
      "WEB-10a rev 18 (R33): a history of another identity does not forget the kept fixes (the first identity gets its fix back later)",
    file: HISTORY,
    tests: [RETENTION],
    expect: /a kept fix is the displayed identity's/,
    patch: (t) =>
      sub(
        t,
        `      if (!other.startsWith(\`\${env.identity}\\u0000\`)) keptFixes.delete(other);\n`,
        "      if (false as boolean) keptFixes.delete(other);\n",
      ),
  },

  {
    id: "MU-2343",
    title:
      "WEB-10a rev 18 (R33): a consumed form save does not name its task (the form the person is on never closes onto it)",
    file: FORM,
    tests: [OWNERSHIP, RETENTION],
    expect:
      /control: still on the form, the success opens the new task's detail|the kept form saves what is shown, once/,
    patch: (t) =>
      sub(t, `        detail: taskId,\n`, `        detail: null,\n`),
  },

  {
    id: "MU-2344",
    title:
      "WEB-10a rev 18 (R33): a record's amount is never consumed by its save (the recorded amount stays in the field)",
    file: "src/features/tasks/detail/RecordCard.tsx",
    tests: [RETENTION, ACK],
    expect:
      /clears only the amount it submitted|a success with nothing typed since clears the field|the next amount typed is kept/,
    patch: (t) =>
      sub(
        t,
        `                        completeKept(ticket, ok);`,
        `                        completeKept(ticket, false);`,
      ),
  },

  {
    id: "MU-2345",
    title:
      "WEB-10a rev 18 (R33): an open fix is not kept when the person leaves for the sync screens",
    file: HISTORY,
    tests: [RETENTION],
    expect: /an open fix is open again|success closes it unless a newer value/,
    patch: (t) =>
      // Re-anchored in revision 20 (same intent): the cleanup also keeps the fix for the detail's visit of its day (DA20-I1).
      sub(
        t,
        `      if (!leftForSync() && !fixVisits.has(owner)) return;\n`,
        `      return;\n`,
      ),
  },

  {
    id: "MU-2346",
    title:
      "WEB-10a rev 18 (R33): a kept open fix comes back parked, not open (the person has to find and press Fix again)",
    file: HISTORY,
    tests: [RETENTION],
    expect: /an open fix is open again|success closes it unless a newer value/,
    patch: (t) =>
      sub(
        t,
        `        back !== null &&\n        writableRef.current &&\n        recentRef.current.has(back.entry.id)\n`,
        `        back !== null &&\n        writableRef.current &&\n        (false as boolean)\n`,
      ),
  },

  {
    id: "MU-2347",
    title:
      "WEB-10a rev 18 (R33): a save's answer does not reach the kept fix (a fix saved while away comes back still pending)",
    file: HISTORY,
    tests: [RETENTION],
    expect: /success closes it unless a newer value was typed/,
    patch: (t) =>
      sub(
        t,
        `    if (open === null && parked === null) keptFixes.delete(owner);\n    else keptFixes.set(owner, { open, parked });\n`,
        ``,
      ),
  },

  {
    id: "MU-2348",
    title:
      "WEB-10a rev 18 (R33): a save's answer is told to no mounted history (the history that saved never settles its fix)",
    file: HISTORY,
    tests: [ACK, RETENTION],
    expect:
      /a success with nothing typed since closes the fix|a value typed while the save was pending stays in the open fix|success closes it unless a newer value/,
    patch: (t) =>
      sub(
        t,
        `  for (const listener of [...fixSettled]) listener(answer);\n`,
        ``,
      ),
  },

  {
    id: "MU-2349",
    title:
      "WEB-10a rev 18 (R33): the preset picker ignores the person's kept choice (always the first preset)",
    file: "src/features/tasks/form/PresetPicker.tsx",
    tests: [RETENTION],
    expect: /a preset chosen is kept through the picker's own sync control/,
    patch: (t) =>
      sub(
        t,
        `      : state.presets.some((p) => p.id === choice.value)`,
        `      : state.presets.some((p) => p.id === choice.value) && false`,
      ),
  },
];

/** Real-engine mutants (whole-mutant native runs in all three engines over E-T40's visit cases), MU-2350..MU-2352. */
export const ENGINE_R18 = [
  {
    id: "MU-2350",
    title:
      "WEB-10a N-T40: (REAL ENGINE) a visit to the sync screens keeps nothing (review 18's R33: form, amount and fix input lost)",
    file: KEPT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T40: .*(new task|edit task|progress amount): the",
    expect: /E-T40:/,
    patch: (t) =>
      sub(
        t,
        `  if (toSync && (unedited || held.revision > 0 || held.submitting !== null)) {`,
        `  if (false as boolean) {`,
      ),
  },

  {
    id: "MU-2351",
    title:
      "WEB-10a N-T40: (REAL ENGINE) an open entry fix is not kept when the person leaves for the sync screens",
    file: HISTORY,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T40: .*entry fix: the open fix",
    expect: /E-T40:/,
    patch: (t) =>
      // Re-anchored in revision 20 (same intent): the cleanup also keeps the fix for the detail's visit of its day (DA20-I1).
      sub(
        t,
        `      if (!leftForSync() && !fixVisits.has(owner)) return;\n`,
        `      return;\n`,
      ),
  },

  {
    id: "MU-2352",
    title:
      "WEB-10a N-T40: (REAL ENGINE) the editor's unmount never reads where the router went (the real sync control looks like any departure)",
    file: KEPT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T40: .*(new task|edit task|progress amount): the",
    expect: /E-T40:/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored in revision 21 (same intent): the router's path is read through \`useLatestPath\`.
        "  return () => atSync(path());",
        `  return () => atSync("");`,
      ),
  },
];

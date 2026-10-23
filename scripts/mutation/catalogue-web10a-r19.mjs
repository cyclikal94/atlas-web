// WEB-10a revision 19's mutants (the design assessment of Review 19: DA19-I1, the day the detail shows is part of the draft kept through a
// visit to the sync screens; DA19-N1, a correction of an entry queued on this device blocks its fix wherever the fix is decided), in the form
// and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Kept in their own module as revisions
// 16 to 18's are (the catalogue is at Biome's 1 MiB file-size limit). `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const RETURN = "tests/features/tasks/sync-return-context.test.tsx";
const DETAIL = "src/features/tasks/detail/useTaskDetail.ts";
const HISTORY = "src/features/tasks/detail/EntryHistory.tsx";
const SCREEN = "src/features/tasks/detail/TaskDetail.tsx";

/** Unit mutants (layer L1b: the app's router over the production data controller and the IndexedDB double), MU-2353..MU-2363 and MU-2366. */
export const UNIT_R19 = [
  {
    id: "MU-2353",
    title:
      "WEB-10a rev 19 (DA19-I1): the day kept with the screen is never read back (the default is chosen afresh after every sync visit)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /typed for day A is shown on day A|fix typed on day A is open again|correction kept by the dialog's sync control|the view says the day is unavailable/,
    patch: (t) =>
      sub(
        t,
        `              returned: pinned.current === null ? day.value : null,`,
        `              returned: null,`,
      ),
  },

  {
    id: "MU-2354",
    title:
      "WEB-10a rev 19 (DA19-I1): the kept day is taken back with nothing typed for it (a visit with no input never chooses afresh)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /control: with nothing typed, the visit chooses afresh|control: with nothing typed, the visit after midnight/,
    patch: (t) =>
      sub(
        t,
        `      input.keeps(back, await progressIdFor(back, input.me))`,
        `      (await progressIdFor(back, input.me)) !== ""`,
      ),
  },

  {
    id: "MU-2355",
    title:
      "WEB-10a rev 19 (DA19-I1 Q4): a kept day that is gone is replaced by the default day (another day shown in its place)",
    file: DETAIL,
    tests: [RETURN],
    expect: /the view says the day is unavailable/,
    patch: (t) =>
      sub(
        t,
        `        selection = "unavailable";\n        returned = true;\n`,
        ``,
      ),
  },

  {
    id: "MU-2356",
    title:
      "WEB-10a rev 19 (DA19-I1): the visit's default day is never written to the screen's kept session",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /typed for day A is shown on day A|fix typed on day A is open again|correction kept by the dialog's sync control/,
    patch: (t) =>
      sub(
        t,
        `      if (dayRef.current.value !== chosen) dayRef.current.edit(() => chosen);\n`,
        ``,
      ),
  },

  {
    id: "MU-2357",
    title:
      "WEB-10a rev 19 (DA19-I1): a kept progress amount does not count as input for the day",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /amount typed for day A is shown on day A|the view says the day is unavailable/,
    patch: (t) =>
      sub(
        t,
        "      (amount !== null &&\n        (amount.revision > 0 || amount.submitting !== null)) ||\n",
        "",
      ),
  },

  {
    id: "MU-2358",
    title:
      "WEB-10a rev 19 (DA19-I1): a kept entry fix does not count as input for the day",
    file: DETAIL,
    tests: [RETURN],
    expect: /fix typed on day A is open again/,
    patch: (t) =>
      sub(
        t,
        `    hasKeptFix(\`\${env.identity}\\u0000\${progressId}\`) ||\n`,
        "",
      ),
  },

  {
    id: "MU-2359",
    title:
      "WEB-10a rev 19 (DA19-I1): a correction kept by the dialog's sync control does not count as input for the day",
    file: DETAIL,
    tests: [RETURN],
    expect: /correction kept by the dialog's sync control/,
    patch: (t) =>
      sub(
        t,
        "      resumable(correctionKey(env.identity, occurrenceId)) !== null\n",
        "      false\n",
      ),
  },

  {
    id: "MU-2360",
    title:
      "WEB-10a rev 19 (DA19-N1): the save decision ignores corrections queued on this device (revision 18: a kept fix saves over another tab's)",
    file: HISTORY,
    tests: [RETURN],
    expect:
      /its Save is refused and no command is added|recovery: the other tab's correction discarded|stays mounted blocks its Save too|Save handler taken while Save was enabled/,
    patch: (t) => sub(t, `    f.pendingReplaced.has(entryId) ||\n`, ``),
  },

  {
    id: "MU-2361",
    title:
      "WEB-10a rev 19 (DA19-N1): Fix is offered for an entry whose queued correction is already among the recent entries",
    file: HISTORY,
    tests: [RETURN],
    expect: /already among the recent entries/,
    patch: (t) => sub(t, `    !pendingReplaced.has(entry.id) &&\n`, ``),
  },

  {
    id: "MU-2362",
    title:
      "WEB-10a rev 19 (DA19-N1): the Save handler decides without the queued corrections (a stale or programmatic press saves)",
    file: HISTORY,
    tests: [RETURN],
    expect: /Save handler taken while Save was enabled/,
    patch: (t) =>
      sub(
        t,
        `    pendingReplaced: pendingReplacedRef.current,`,
        `    pendingReplaced: new Set(),`,
      ),
  },

  {
    id: "MU-2363",
    title:
      "WEB-10a rev 19 (DA19-N1): a kept fix of an entry corrected meanwhile is parked unreadable instead of reopened with its Save withheld",
    file: HISTORY,
    tests: [RETURN],
    expect: /the editor is back with 7, its Save is refused/,
    patch: (t) =>
      sub(
        t,
        `        recentRef.current.has(back.entry.id)\n`,
        `        recentRef.current.has(back.entry.id) &&\n        !pendingReplacedRef.current.has(back.entry.id)\n`,
      ),
  },

  {
    id: "MU-2366",
    title:
      "WEB-10a rev 19 (DA19-I1 Q4): choosing the default day again in place leaves focus on the removed control (the page's body)",
    file: SCREEN,
    tests: [RETURN],
    expect: /the view says the day is unavailable/,
    patch: (t) =>
      sub(
        t,
        `            focus={focusRecord === true || choseAgain}`,
        `            focus={focusRecord === true}`,
      ),
  },
];

/** Real-engine mutants (whole-mutant native runs in all three engines over E-T41's cases), MU-2364..MU-2365. */
export const ENGINE_R19 = [
  {
    id: "MU-2364",
    title:
      "WEB-10a N-T41: (REAL ENGINE) the day kept with the screen is never read back (the input typed for day A is not found after the visit)",
    file: DETAIL,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T41: .*Q3: the amount typed",
    expect: /E-T41:/,
    patch: (t) =>
      sub(
        t,
        `              returned: pinned.current === null ? day.value : null,`,
        `              returned: null,`,
      ),
  },

  {
    id: "MU-2365",
    title:
      "WEB-10a N-T41: (REAL ENGINE) the save decision ignores corrections queued by another tab (the kept fix saves over it)",
    file: HISTORY,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T41: .*Q6: the other tab queued",
    expect: /E-T41:/,
    patch: (t) => sub(t, `    f.pendingReplaced.has(entryId) ||\n`, ``),
  },
];

// WEB-10a revision 20's mutants (the design assessment of Review 20: DA20-I1, the visit's day and the input typed for it have one
// lifetime: a day that leaves after the person came back is shown unavailable, never replaced by another day, and the editors the data
// hides keep their sessions), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE`
// lists. Kept in their own module as revisions 16 to 19's are (the catalogue is at Biome's 1 MiB file-size limit). `sub` is the
// catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const RETURN = "tests/features/tasks/sync-return-context.test.tsx";
const DETAIL = "src/features/tasks/detail/useTaskDetail.ts";
const HISTORY = "src/features/tasks/detail/EntryHistory.tsx";
const KEPT = "src/features/tasks/kept-input.ts";
const CORRECTION = "src/features/tasks/detail/correction-owner.ts";

/** Restores revision 19's fallback: the visit's day, gone, is replaced by the default day (another day shown in its place). */
const fallback = (t) =>
  sub(
    t,
    `        chosen = input.pinned;\n        chosenRow = kept.value;\n      } else {\n        selection = "unavailable";\n        lost = true;\n      }\n`,
    `        chosen = input.pinned;\n        chosenRow = kept.value;\n      }\n`,
  );
/** The visit does not hold the day's progress amount (revision 19: the card's unmount drops it). */
const noAmountHold = (t) =>
  sub(
    t,
    `      holdKept(keptKey(env.identity, \`record:\${targetProgress}\`)),\n`,
    "",
  );

/** Unit mutants (layer L1b: the app's router over the production data controller and the IndexedDB double), MU-2367..MU-2376. */
export const UNIT_R20 = [
  {
    id: "MU-2367",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit's day, gone after the person came back, is replaced by the default day (revision 19's fallback)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /day A leaves, the view says so|keeps its value through day A leaving|not only after a visit|pending when day A leaves|the visit's day leaving is said too|choosing again after day A left/,
    patch: fallback,
  },

  {
    id: "MU-2368",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit does not hold its day's progress amount (the record card the data hides drops it)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /day A leaves, the view says so|not only after a visit|a day named in the address: the amount survives|a record pending when day A leaves/,
    patch: noAmountHold,
  },

  {
    id: "MU-2369",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit does not hold its day's fix input (the history the data hides drops the open fix)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /the fix open again after the visit keeps its value|a fix pending when day A leaves/,
    patch: (t) =>
      sub(
        t,
        `      holdKeptFix(\`\${env.identity}\\u0000\${targetProgress}\`),\n`,
        "",
      ),
  },

  {
    id: "MU-2370",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit does not hold its day's correction (the reopened dialog the data hides drops it)",
    file: DETAIL,
    tests: [RETURN],
    expect: /the correction reopened after the visit keeps its value/,
    patch: (t) =>
      sub(
        t,
        "      holdCorrection(correctionKey(env.identity, target)),\n",
        "",
      ),
  },

  {
    id: "MU-2371",
    title:
      "WEB-10a rev 20 (DA20-I1): the kept-input owner ignores the visit's hold when an editor unmounts (its session is dropped after the turn)",
    file: KEPT,
    tests: [RETURN],
    expect:
      /day A leaves, the view says so|not only after a visit|a day named in the address: the amount survives|a record pending when day A leaves/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  if (held.holders > 0 || held.kept || visits.has(key)) return;\n",
          "  if (held.holders > 0 || held.kept) return;\n",
        ),
        "      !held.kept &&\n      !visits.has(key)\n",
        "      !held.kept\n",
      ),
  },

  {
    id: "MU-2372",
    title:
      "WEB-10a rev 20 (DA20-I1): a history the data hides keeps its fix only for the sync screens (the visit's hold is ignored)",
    file: HISTORY,
    tests: [RETURN],
    expect:
      /the fix open again after the visit keeps its value|a fix pending when day A leaves/,
    patch: (t) =>
      sub(
        t,
        "      if (!leftForSync() && !fixVisits.has(owner)) return;\n",
        "      if (!leftForSync()) return;\n",
      ),
  },

  {
    id: "MU-2373",
    title:
      "WEB-10a rev 20 (DA20-I1): the correction owner drops a released session the visit holds (the dialog the data hides loses it)",
    file: CORRECTION,
    tests: [RETURN],
    expect: /the correction reopened after the visit keeps its value/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  if (visits.has(key)) return;\n  setTimeout(",
          "  setTimeout(",
        ),
        "      !now.retained &&\n      !visits.has(key)\n",
        "      !now.retained\n",
      ),
  },

  {
    id: "MU-2374",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit letting go for the sync screens does not keep a hidden editor's input (dropped as by any departure)",
    file: KEPT,
    tests: [RETURN],
    expect:
      /leaving for the sync screens while day A is gone keeps its amount|choosing again keeps day A's amount with day A/,
    patch: (t) =>
      sub(
        t,
        "    if (keep && (held.revision > 0 || held.submitting !== null)) {\n      held.kept = true;\n      return;\n    }\n    dropUnheld(key, held);\n",
        "    dropUnheld(key, held);\n",
      ),
  },

  {
    id: "MU-2375",
    title:
      "WEB-10a rev 20 (DA20-I1): choosing another day in place drops the gone day's input instead of keeping it with its own day",
    file: DETAIL,
    tests: [RETURN],
    expect: /choosing again keeps day A's amount with day A/,
    patch: (t) => sub(t, "      keepOnRelease.current = target;\n", ""),
  },

  {
    id: "MU-2376",
    title:
      "WEB-10a rev 20 (DA20-I1): choosing again keeps the mount's pin on the gone day (the view stays unavailable)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /the visit's day leaving is said too|choosing again after day A left|choosing again keeps day A's amount/,
    patch: (t) =>
      sub(
        t,
        "      keepOnRelease.current = target;\n      pinned.current = null;\n",
        "      keepOnRelease.current = target;\n",
      ),
  },
];

/** Real-engine mutants (whole-mutant native runs in all three engines over E-T42's removal case), MU-2377..MU-2378. */
export const ENGINE_R20 = [
  {
    id: "MU-2377",
    title:
      "WEB-10a N-T42: (REAL ENGINE) the visit's day removed by another tab's sync page is replaced by the default day",
    file: DETAIL,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T42: .*another tab's sync page removes day A",
    expect: /E-T42:/,
    patch: fallback,
  },

  {
    id: "MU-2378",
    title:
      "WEB-10a N-T42: (REAL ENGINE) the visit does not hold its day's amount (day A back after another tab removed it shows none)",
    file: DETAIL,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T42: .*another tab's sync page removes day A",
    expect: /E-T42:/,
    patch: noAmountHold,
  },
];

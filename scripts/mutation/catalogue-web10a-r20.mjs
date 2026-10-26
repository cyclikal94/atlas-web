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
const VISIT = "src/features/tasks/visit.ts";

/** Restores revision 19's fallback: the visit's day, gone, is replaced by the default day (another day shown in its place). */
const fallback = (t) =>
  sub(
    t,
    `        chosen = input.pinned;\n        chosenRow = kept.value;\n      } else {\n        selection = "unavailable";\n        lost = true;\n      }\n`,
    `        chosen = input.pinned;\n        chosenRow = kept.value;\n      }\n`,
  );
/**
 * The visit does not hold the day's progress amount (revision 19: the card's unmount drops it). Re-anchored in revision 21 (`holdDay`) and
 * revision 22 (same intent): a session is the mount's, not the visit's (its last editor letting go disowns it).
 */
const noAmountHold = (t) =>
  sub(
    t,
    "  held.holders = Math.max(0, held.holders - 1);\n  dropUnheld(key, held);\n",
    "  held.holders = Math.max(0, held.holders - 1);\n  if (held.holders === 0) held.owner = null;\n  dropUnheld(key, held);\n",
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
    file: KEPT,
    tests: [RETURN],
    expect:
      /day A leaves, the view says so|not only after a visit|a day named in the address: the amount survives|a record pending when day A leaves/,
    patch: noAmountHold,
  },

  {
    id: "MU-2369",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit does not hold its day's fix input (the history the data hides drops the open fix)",
    file: HISTORY,
    tests: [RETURN],
    expect:
      /the fix open again after the visit keeps its value|a fix pending when day A leaves/,
    // Re-anchored in revision 22 (same intent): the visit going on keeps the fix of a history the data hides (its unmount), there being no per-day hold any more.
    patch: (t) =>
      sub(
        t,
        "      if (visit === null || visit.ended()) return;\n",
        "      return;\n",
      ),
  },

  {
    id: "MU-2370",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit does not hold its day's correction (the reopened dialog the data hides drops it)",
    file: CORRECTION,
    tests: [RETURN],
    expect: /the correction reopened after the visit keeps its value/,
    // Re-anchored in revision 22 (same intent): a dialog the data hides keeps its session while the visit goes on (`releaseCorrection`).
    patch: (t) =>
      sub(
        t,
        "  if (live && (held.revision > 0 || held.submitting !== null)) {\n    entries.set(key, { ...held, retained: true });\n    return;\n  }\n",
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
    // Re-anchored in revision 22 (same intent): the drop after an editor unmounts ignores the visit's keeping (`retained`, both checks).
    patch: (t) =>
      sub(
        sub(
          t,
          "  if (held.holders > 0 || retained(held)) return;\n",
          "  if (held.holders > 0) return;\n",
        ),
        "    if (entries.get(key) === held && held.holders === 0 && !retained(held))\n",
        "    if (entries.get(key) === held && held.holders === 0)\n",
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
    // Re-anchored in revision 22 (same intent): the history's unmount keeps the fix only for a visit that goes on (inverted: kept only once it ended).
    patch: (t) =>
      sub(
        t,
        "      if (visit === null || visit.ended()) return;\n",
        "      if (visit === null || !visit.ended()) return;\n",
      ),
  },

  {
    id: "MU-2373",
    title:
      "WEB-10a rev 20 (DA20-I1): the correction owner drops a released session the visit holds (the dialog the data hides loses it)",
    file: CORRECTION,
    tests: [RETURN],
    expect: /the correction reopened after the visit keeps its value/,
    // Re-anchored in revision 22 (same intent): the correction owner treats the visit as ended when a dialog lets go (a retained or edited session is dropped).
    patch: (t) =>
      sub(
        t,
        "  const live = held.owner !== null && !held.owner.ended();\n",
        "  const live = false as boolean;\n",
      ),
  },

  {
    id: "MU-2374",
    title:
      "WEB-10a rev 20 (DA20-I1): the visit letting go for the sync screens does not keep a hidden editor's input (dropped as by any departure)",
    file: VISIT,
    tests: [RETURN],
    expect:
      /leaving for the sync screens while day A is gone keeps its amount|choosing again keeps day A's amount with day A/,
    // Re-anchored in revision 22 (same intent): the visit going to the sync screens keeps a hidden editor's input; ended there, it is dropped as by any departure.
    patch: (t) =>
      sub(
        t,
        "  if (at !== visit.address && !atSync(at)) end(visit);\n",
        "  if (at !== visit.address) end(visit);\n",
      ),
  },

  {
    id: "MU-2375",
    title:
      "WEB-10a rev 20 (DA20-I1): choosing another day in place drops the gone day's input instead of keeping it with its own day",
    file: DETAIL,
    tests: [RETURN],
    expect: /choosing again keeps day A's amount with day A/,
    // Re-anchored in revision 21 (same intent): choosing again parks the day in the visit instead of marking it kept on release.
    // Re-anchored in revision 22 (same intent): choosing again parks the shown day in the visit (`shownBy(...).target = null`).
    patch: (t) =>
      sub(
        t,
        "      if (mine !== null && mine.identity === env.identity)\n        shownBy(mine, taskId).target = null;\n",
        "",
      ),
  },

  {
    id: "MU-2376",
    title:
      "WEB-10a rev 20 (DA20-I1): choosing again keeps the mount's pin on the gone day (the view stays unavailable)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /the visit's day leaving is said too|choosing again after day A left|choosing again keeps day A's amount/,
    // Re-anchored in revision 22 (same intent): choosing again also clears the mount's pin.
    patch: (t) =>
      sub(
        t,
        "      alone.current.target = null;\n      pinned.current = null;\n",
        "      alone.current.target = null;\n",
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
    file: KEPT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T42: .*another tab's sync page removes day A",
    expect: /E-T42:/,
    patch: noAmountHold,
  },
];

// WEB-13b revision 24's mutants (review 28 F28-1 `incomplete_fix`, family calendar-review-page-membership; design assessment C1/C2,
// invariants 2–5 and P04a–P05), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r23.mjs`. Each restores ONE way the review panel could again say "no longer available" of a review it already saw
// published resolved (the defect: the resolution retired the review only from the CURRENT page's history, although one review can have been
// shown on several pages), or breaks one part of the version-aware decision the revision adds; `expect` names the tests written for it, so
// only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer):
// - "remember ignores a resolution already seen": `remember` is called only for a drawn card, and `drawnAt` already excludes a superseded
//   reading (MU-2778); a card and another reader of the same review never run their effects in one commit (a list row that says resolved
//   unmounts the card; a departed slot exists only for an id absent from the page). The separate guard was removed rather than kept as an
//   equivalent mutant.
// - "retire removes only from the FIRST page set by `some`/`find`": the same mechanism as MU-2772 (stop after the first deletion).
import { sub } from "./data-catalogue.mjs";

const PANEL = "src/features/calendars/ReviewPanel.tsx";
const T_PANEL = "tests/features/calendars/review-panel.test.tsx";

const EVERY_PAGE =
  "        for (const members of seen.byPage.values())\n          if (members.delete(id)) retired = true;\n";
const CURRENT_PAGE_ONLY =
  "        if (shownHere?.delete(id) === true) retired = true;\n";

export const UNIT_13B_R24 = [
  {
    id: "MU-2771",
    title:
      "WEB-13b F28-1 (revision 24): the original defect — a published resolution retires the review only from the CURRENT page's history",
    file: PANEL,
    tests: [T_PANEL],
    expect:
      /F28-1 (the review's own schedule .*published resolved on page two|three pages showed it|two reviews each shown on two pages)/,
    patch: (t) => sub(t, EVERY_PAGE, CURRENT_PAGE_ONLY),
  },
  {
    id: "MU-2772",
    title:
      "WEB-13b F28-1 (revision 24): retiring stops at the first page whose history held the review",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 three pages showed it/,
    patch: (t) =>
      sub(
        t,
        "          if (members.delete(id)) retired = true;\n",
        "          if (members.delete(id)) {\n            retired = true;\n            break;\n          }\n",
      ),
  },
  {
    id: "MU-2773",
    title:
      "WEB-13b F28-1 (revision 24): a short-circuiting `retired ||= members.delete(id)` skips every page once the resolution is recorded",
    file: PANEL,
    tests: [T_PANEL],
    expect:
      /F28-1 (the review's own schedule .*published resolved on page two|three pages showed it|two reviews each shown on two pages)/,
    patch: (t) =>
      sub(
        t,
        "          if (members.delete(id)) retired = true;\n",
        "          retired ||= members.delete(id);\n",
      ),
  },
  {
    id: "MU-2774",
    title:
      "WEB-13b F28-1 (revision 24): a departed review's id read that sees the published resolution retires nothing (middle and first pages)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 three pages showed it, resolved seen on the (middle|first)/,
    patch: (t) =>
      sub(
        t,
        "    if (resolvedAt !== null) retire(id, resolvedAt);\n",
        "    if (resolvedAt !== null) void 0;\n",
      ),
  },
  {
    id: "MU-2775",
    title:
      "WEB-13b F28-1 (revision 24): the page's list seeing a published resolution retires nothing (the card's reading held; a fetched row never shown)",
    file: PANEL,
    tests: [T_PANEL],
    expect:
      /F28-1 (the LIST alone sees|a review the current page fetched resolved but never showed)/,
    patch: (t) =>
      sub(
        t,
        "        memory.retire(row.base.id, row.base.version);\n",
        "        void 0;\n",
      ),
  },
  {
    id: "MU-2776",
    title:
      "WEB-13b F28-1 (revision 24): the card's own reading of the published resolution retires nothing (the list held)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 the CARD alone sees/,
    patch: (t) =>
      sub(
        t,
        "    if (settledAt !== null) retire(id, settledAt);\n",
        "    if (settledAt !== null) void 0;\n",
      ),
  },
  {
    id: "MU-2777",
    title:
      "WEB-13b F28-1 (revision 24): a card whose reading finds no row after the panel saw it resolved says 'no longer available' (an older reading is drawn)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 (the CARD alone sees|an OLDER unresolved reading)/,
    patch: (t) => sub(t, "  if (superseded) return null;\n", ""),
  },
  {
    id: "MU-2778",
    title:
      "WEB-13b F28-1 (revision 24): an older unresolved reading after the resolution is remembered again (deleted, it is 'gone')",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 an OLDER unresolved reading/,
    patch: (t) =>
      sub(
        t,
        "    base?.resolved !== true &&\n    !superseded\n",
        "    base?.resolved !== true\n",
      ),
  },
  {
    id: "MU-2779",
    title:
      "WEB-13b F28-1 (revision 24): an id-only blacklist — a review once seen resolved stays hidden at every later version (reopened)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 reopened/,
    patch: (t) =>
      sub(
        t,
        "          (version === null || version <= known.version)\n",
        "          (version === null || version >= 0)\n",
      ),
  },
  {
    id: "MU-2780",
    title:
      "WEB-13b F28-1 (revision 24): an OLDER resolved reading retires a review the panel has since seen reopened",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F28-1 an OLDER resolved reading after a reopening/,
    patch: (t) =>
      sub(
        t,
        "        if (known !== undefined && version < known.version) return;\n",
        "",
      ),
  },
  {
    id: "MU-2781",
    title:
      "WEB-13b F28-1 (revision 24): a card's LOCAL acknowledgement (the merged overlay) retires the review from every page",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 a LOCAL acknowledgement/,
    patch: (t) =>
      sub(
        t,
        '    view.status === "ready" && shownRow !== null && base?.resolved === true\n',
        '    view.status === "ready" && shownRow !== null && value?.resolved === true\n',
      ),
  },
];

/**
 * Real-engine mutant (one isolated whole-mutant job, all three browsers, its own unmutated control): the original F28-1 defect again (the
 * same patch as MU-2771), judged by the revision-24 case of `fixture.calendar-reviews.spec.ts`, where a review shown on page one and on
 * page two is published resolved and then deleted by `/sync` pages through the fixture leader.
 */
export const ENGINE_13B_R24 = [
  {
    id: "MU-2782",
    title:
      "WEB-13b F28-1 (revision 24): (REAL ENGINE) the original defect — a published resolution retires the review only from the current page",
    file: PANEL,
    spec: "tests/e2e/fixture.calendar-reviews.spec.ts",
    grep: "revision 24 \\(review 28 F28-1\\)",
    expect: /revision 24 \(review 28 F28-1\)/,
    patch: (t) => sub(t, EVERY_PAGE, CURRENT_PAGE_ONLY),
  },
];

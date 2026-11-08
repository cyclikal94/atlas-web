// WEB-13b revision 23's mutants (review 27 F27-1 `new`, family calendar-review-page-membership; design assessment C1, invariants 1–7 and
// P01–P12), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r22.mjs`. Each restores ONE way the review panel could again mistake leaving a bounded page for leaving the cache (the
// defect: a remembered review missing from the current 100-row page was said to be "no longer available", and every FETCHED unresolved
// review was remembered although only 20 may have been shown), or breaks one part of the membership decision the revision adds; `expect`
// names the tests written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer):
// - "an id the answer does not cover is taken as absent" (assessment: omitted batch key as null). Every membership read asks for ONE id
//   (`Departed` → `useCachedResources([id])`), and `readResourcesById` answers every id it was asked for up to 100, so a patch that turns a
//   missing key into `null` is equivalent on every reachable schedule. The one-id shape is itself asserted ("many remembered reviews").
// - remembering across account services (`byService` keyed by one constant): the panel sits under `WhileCacheOpen` inside the protected
//   tree, so in the component world every service change also unmounts it (a new panel remembers nothing either way); no reachable schedule
//   distinguishes the patch. The per-service key stays as defence in depth.
//
// Revision 24 (review 28 F28-1) re-anchored MU-5227, MU-5229, MU-5230, MU-5231, MU-5232 and MU-5233 at the corrected code: `remember`,
// `forget`, `drawn` and `settled` became `memory.remember`/`retire`, `drawnAt`/`settledAt`, and the per-service history became
// `seen.byPage`. Each restores the SAME defect as before and keeps its title and oracle (`expect`).
import { sub } from "./data-catalogue.mjs";

const PANEL = "src/features/calendars/ReviewPanel.tsx";
const T_PANEL = "tests/features/calendars/review-panel.test.tsx";

const DEPARTED_RETURN =
  "  return known === null ? <GoneItem id={id} /> : null;\n";

export const UNIT_13B_R23 = [
  {
    id: "MU-5226",
    title:
      "WEB-13b F27-1 (revision 23): the original defect — a remembered review missing from the current page is said to be gone without asking the cache for it",
    file: PANEL,
    tests: [T_PANEL],
    expect:
      /F27-1 (boundary shift|shown, moved off the page, then published resolved|a LOCAL acknowledgement|the id read decides)/,
    patch: (t) => sub(t, DEPARTED_RETURN, "  return <GoneItem id={id} />;\n"),
  },
  {
    id: "MU-5227",
    title:
      "WEB-13b F27-1 (revision 23): the original defect's other half — every FETCHED unresolved review is remembered, shown or not",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 never shown/,
    patch: (t) =>
      sub(
        t,
        '    if (page.status !== "ready") return;\n',
        '    if (page.status !== "ready") return;\n    for (const row of unresolved) memory.remember(row.base.id, row.base.version);\n',
      ),
  },
  {
    id: "MU-5228",
    title:
      "WEB-13b F27-1 (revision 23): an unanswered membership read (loading, held, no service) is taken as 'the cache holds none'",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 the id read decides/,
    patch: (t) =>
      sub(
        t,
        "      ? read.value[id]\n      : undefined;\n",
        "      ? read.value[id]\n      : null;\n",
      ),
  },
  {
    id: "MU-5229",
    title:
      "WEB-13b F27-1 (revision 23): a remembered review published resolved off its page is not forgotten (a later deletion says it is gone)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 shown, moved off the page, then published resolved/,
    patch: (t) =>
      sub(
        t,
        "    if (resolvedAt !== null) retire(id, resolvedAt);\n",
        "    if (resolvedAt !== null) return;\n",
      ),
  },
  {
    id: "MU-5230",
    title:
      "WEB-13b F27-1 (revision 23): a LOCAL acknowledgement (the merged overlay) is taken as the published resolution and forgets the review",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 a LOCAL acknowledgement/,
    patch: (t) =>
      sub(
        t,
        "    parseReview(known.base.value)?.resolved === true\n",
        "    parseReview(known.merged.value)?.resolved === true\n",
      ),
  },
  {
    id: "MU-5231",
    title:
      "WEB-13b F27-1 (revision 23): a card is remembered before it draws its own reading (shown only as loading)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 a card that never drew/,
    patch: (t) =>
      sub(
        t,
        '  const drawnAt =\n    view.status === "ready" &&\n    shownRow !== null &&\n    view.value.merged !== null &&\n    base?.resolved !== true &&\n    !superseded\n      ? shownRow.version\n      : null;\n',
        "  const drawnAt = superseded ? null : row.base.version;\n",
      ),
  },
  {
    id: "MU-5232",
    title:
      "WEB-13b F27-1 (revision 23): a card whose own reading sees the published resolution does not forget it (the list's later removal says gone)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 published resolved then deleted while the LIST is held/,
    patch: (t) =>
      sub(
        t,
        "    if (settledAt !== null) retire(id, settledAt);\n",
        "    if (settledAt !== null) return;\n",
      ),
  },
  {
    id: "MU-5233",
    title:
      "WEB-13b F27-1 (revision 23): what the panel showed is remembered for every page as one (not by the page's cursor)",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F27-1 page two/,
    patch: (t) =>
      sub(
        t,
        "  let shownHere = seen?.byPage.get(after) ?? null;\n",
        "  let shownHere = seen?.byPage.get(null) ?? null;\n",
      ),
  },
];

/**
 * Real-engine mutant (one isolated whole-mutant job, all three browsers, its own unmutated control): the original F27-1 defect again (the
 * same patch as MU-5226), judged by the revision-23 case of `fixture.calendar-reviews.spec.ts`, where a sync page publishes a review whose
 * id sorts first and the 100th shown review moves to page two.
 */
export const ENGINE_13B_R23 = [
  {
    id: "MU-5234",
    title:
      "WEB-13b F27-1 (revision 23): (REAL ENGINE) the original defect — a remembered review missing from the current page is said to be gone",
    file: PANEL,
    spec: "tests/e2e/fixture.calendar-reviews.spec.ts",
    grep: "revision 23 \\(review 27 F27-1\\)",
    expect: /revision 23 \(review 27 F27-1\)/,
    patch: (t) => sub(t, DEPARTED_RETURN, "  return <GoneItem id={id} />;\n"),
  },
];

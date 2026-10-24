// WEB-10a revision 25's mutants (Review 25 R37 and the design assessment after it, P1-P3: a task detail React never removed is the screen
// the person is at again once they are back at its address; its entry history's fix input and the detail's record of the day it shows
// belong to the visit going on there), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list.
// Kept in their own module as revisions 16 to 24's are. `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const SURVIVING = "tests/features/tasks/surviving-return.test.tsx";
const HISTORY = "src/features/tasks/detail/EntryHistory.tsx";
const DETAIL = "src/features/tasks/detail/useTaskDetail.ts";

/** What the R37 entry-history cases report when a fix made after the surviving return is lost at the sync screens. */
const LOST_FIX =
  /same-instance-tasks: 7\.125 typed after it is open again|the closed state is not the loss|two sync visits in a row keep it|the second return's visit owns it|parked \(Back to recent\) after the return/;

/**
 * Unit mutants (layer L1b, the app's router over the production data controller and the IndexedDB double): MU-2430, MU-2432..MU-2435.
 * MU-2431 (renewing to a visit at another address) was withdrawn as EQUIVALENT: a history renews only once its router is at its address,
 * which is where `visitOf` asks, so no other address can be returned (its surviving diagnostic run is kept in the revision's evidence).
 */
export const UNIT_R25 = [
  {
    id: "MU-2430",
    title:
      "WEB-10a rev 25 (R37): the entry history is never told the person is back (its visit stays the ended one; a fix made after the return is dropped at the sync screens)",
    file: HISTORY,
    tests: [SURVIVING],
    expect: LOST_FIX,
    patch: (t) =>
      sub(
        t,
        "    const unheard = onRouteMoved(renew);\n",
        "    const unheard = () => {};\n",
      ),
  },

  {
    id: "MU-2432",
    title:
      "WEB-10a rev 25 (R37 / DA invariant 2): an ended visit's fix is kept and given back (a history removed by an ordinary departure resurrects its input)",
    file: HISTORY,
    tests: [SURVIVING],
    expect:
      /an ordinary departure that removes the history ends it|typed before, the history removed by the departure/,
    patch: (t) =>
      sub(
        sub(
          t,
          "      if (visit === null || visit.ended()) return;\n      const held = fixRef.current;\n",
          "      if (visit === null) return;\n      const held = fixRef.current;\n",
        ),
        "    if (kept !== undefined && kept.visit === visit) {\n",
        "    if (kept !== undefined) {\n",
      ),
  },

  {
    id: "MU-2433",
    title:
      "WEB-10a rev 25 (P3 / Q5): the renewed detail does not tell the visit going on which day it shows (a day let go later in its place keeps its input)",
    file: DETAIL,
    tests: [SURVIVING],
    expect: /the same instance returned to: B is blank when picked again/,
    patch: (t) =>
      sub(
        t,
        "      now.target = was.target;\n      now.progress = was.progress;\n",
        "",
      ),
  },

  {
    id: "MU-2434",
    title:
      "WEB-10a rev 25 (P3 / Q5): the renewed detail keeps recording on the ended visit (a day parked after the return is let go at the next mount)",
    file: DETAIL,
    tests: [SURVIVING],
    expect:
      /the same instance returned to: A parked after the return keeps its amount/,
    patch: (t) =>
      sub(
        t,
        "      mine = next;\n      visit.current = next;\n",
        "      mine = next;\n",
      ),
  },

  {
    id: "MU-2435",
    title:
      "WEB-10a rev 25 (P3 / Q5): the detail is never told the person is back (its day records stay with the ended visit)",
    file: DETAIL,
    tests: [SURVIVING],
    expect:
      /the same instance returned to: B is blank when picked again|the same instance returned to: A parked after the return keeps its amount/,
    patch: (t) =>
      sub(t, "    return onRouteMoved(() => {\n", "    void (() => {\n"),
  },
];

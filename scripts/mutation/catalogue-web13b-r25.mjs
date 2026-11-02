// WEB-13b revision 25's mutants (review 29 F29-1 `incomplete_fix`, family calendar-review-page-membership; design assessment C1/C2/C5,
// invariants 1–2 and P02a–P02f), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r24.mjs`. Each restores ONE way a card could again say "no longer available" of a review its page never showed (the
// defect: a card whose first reading found no row drew the unavailable item without asking the page's history), or breaks the genuine
// unavailable feedback the guard must keep; `expect` names the tests written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer):
// - "a card that is only loading is remembered" and "every FETCHED row is remembered": MU-2767 and MU-2763 (revision 23) already restore
//   them, with their original oracles; with this revision's guard they also reach the card's own branch.
// - "the departed review asks `shown` too": a departed slot exists only for an id in the current page's history, so the extra check is
//   equivalent; it was not added to the product.
import { sub } from "./data-catalogue.mjs";

const PANEL = "src/features/calendars/ReviewPanel.tsx";
const T_PANEL = "tests/features/calendars/review-panel.test.tsx";

const GUARDED = "    return memory.shown(id) ? <GoneItem id={id} /> : null;\n";

export const UNIT_13B_R25 = [
  {
    id: "MU-2783",
    title:
      "WEB-13b F29-1 (revision 25): the original defect — a card whose reading finds no row is 'no longer available' whether or not its page showed it",
    file: PANEL,
    tests: [T_PANEL],
    expect:
      /F29-1 (the review's own schedule|ANOTHER page's history|lifetime: shown by an EARLIER panel)/,
    patch: (t) => sub(t, GUARDED, "    return <GoneItem id={id} />;\n"),
  },
  {
    id: "MU-2784",
    title:
      "WEB-13b F29-1 (revision 25): a card whose reading finds no row never says 'no longer available', even of a review its page showed",
    file: PANEL,
    tests: [T_PANEL],
    expect:
      /F29-1 (control: a review its card SHOWED|control: an UNREADABLE review|the PAGE's history decides)/,
    patch: (t) =>
      sub(t, GUARDED, "    return false ? <GoneItem id={id} /> : null;\n"),
  },
  {
    id: "MU-2785",
    title:
      "WEB-13b F29-1 (revision 25): `shown` answers from EVERY page's history, so a review shown on another page is gone on this one",
    file: PANEL,
    tests: [T_PANEL],
    expect: /F29-1 ANOTHER page's history/,
    patch: (t) =>
      sub(
        t,
        "      shown: (id) => shownHere?.has(id) === true,\n",
        "      shown: (id) =>\n        [...(seen?.byPage.values() ?? [])].some((members) => members.has(id)),\n",
      ),
  },
];

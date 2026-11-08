// WEB-13b revision 12's mutants (review 13 R8 `new`, family calendar-review-display-observation-split; design assessment C1 and its
// mutation list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r11.mjs`. Each restores ONE part of the split the revision removed (a review card drawn from the list while its
// acknowledgement is built from the card's own reading); `expect` names the tests written for it, so only an assertion of those tests
// catches it.
//
// Considered and not selected (recorded for the reviewer): dropping the loading branch leaves no reading to draw from (`view.value` is
// undefined while loading), so the card throws while rendering, a crash and never a catch; the conflict an acknowledgement replaces
// (`conflictId`) has no other source (a list row carries only a count of waiting changes), so it cannot be taken "from another observation"
// without inventing one; dropping the observation from the request is MU-5022's, whose `expect` already names the revision 12 refusals
// ("refused as changed") as well as the original one.
import { sub } from "./data-catalogue.mjs";

const PANEL = "src/features/calendars/ReviewPanel.tsx";
const T_REVIEWS = "tests/features/calendars/review-panel.test.tsx";

export const UNIT_13B_R12 = [
  {
    id: "MU-5263",
    title:
      "WEB-13b R8 (revision 12): the card shows the list's copy of the review while Acknowledge is built from the card's own reading (a newer, unseen review is acknowledged; an older one is shown while the newer is known)",
    file: PANEL,
    tests: [T_REVIEWS],
    expect:
      /R8 \(view first, list held\)|R8 \(list first, view held\)|R8 Acknowledge \(keep current timing\)|R8 conflict, Acknowledge again with the/,
    patch: (t) =>
      sub(
        sub(
          t,
          '  const shownRow = view.status === "ready" ? view.value.base : null;\n',
          '  const shownRow = view.status === "ready" ? row.base : null;\n',
        ),
        "      ? parseReview(view.value.merged.value)\n",
        "      ? parseReview(row.merged.value)\n",
      ),
  },
  {
    id: "MU-5264",
    title:
      "WEB-13b R8 (revision 12): whether the review may be acknowledged comes from the list's copy (edit access lost is still offered)",
    file: PANEL,
    tests: [T_REVIEWS],
    expect: /R8 permission \(list held\)/,
    patch: (t) =>
      sub(
        t,
        "  const canAct = view.value.merged.can_edit;\n",
        "  const canAct = row.merged.can_edit;\n",
      ),
  },
  {
    id: "MU-5183",
    title:
      "WEB-13b R8 (revision 12): the card's reason and privacy come from the list's copy (a review that became private still names its task)",
    file: PANEL,
    tests: [T_REVIEWS],
    expect: /R8 privacy \(list held\)/,
    patch: (t) =>
      sub(
        t,
        "  const base = shownRow === null ? null : parseReview(shownRow.value);\n",
        "  const base = shownRow === null ? null : parseReview(row.base.value);\n",
      ),
  },
  {
    id: "MU-5184",
    title:
      "WEB-13b R8 (revision 12): the card's occurrence (its task, Open task, Review this move…) comes from the list's copy (a moved review links to its old occurrence)",
    file: PANEL,
    tests: [T_REVIEWS],
    expect: /R8 navigation \(list held\)/,
    patch: (t) =>
      sub(
        t,
        "  const occurrenceId = shownRow?.parent_id ?? null;\n",
        "  const occurrenceId = row.base.parent_id;\n",
      ),
  },
  {
    id: "MU-5185",
    title:
      "WEB-13b R8 (revision 12): a review the card's reading no longer finds falls back to the list's older copy (still offered, still linked)",
    file: PANEL,
    tests: [T_REVIEWS],
    expect: /R8 gone \(list held\)/,
    patch: (t) =>
      sub(
        sub(
          sub(
            sub(
              t,
              '  const shownRow = view.status === "ready" ? view.value.base : null;\n',
              '  const shownRow = view.status === "ready" ? (view.value.base ?? row.base) : null;\n',
            ),
            "      ? parseReview(view.value.merged.value)\n",
            "      ? parseReview((view.value.merged ?? row.merged).value)\n",
          ),
          "  if (shownRow === null || view.value.merged === null)\n",
          "  if (shownRow === null)\n",
        ),
        "  const canAct = view.value.merged.can_edit;\n",
        "  const canAct = (view.value.merged ?? row.merged).can_edit;\n",
      ),
  },
  {
    id: "MU-5186",
    title:
      "WEB-13b R8 (revision 12): a review the card's reading saw published resolved stays on the screen until the list says so",
    file: PANEL,
    tests: [T_REVIEWS],
    expect: /R8 resolved \(list held\)/,
    patch: (t) => sub(t, "  if (base?.resolved === true) return null;\n", ""),
  },
];

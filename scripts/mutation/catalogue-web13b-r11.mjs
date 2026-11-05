// WEB-13b revision 11's mutants (review 11 R7f `regression`, family task-sync-navigation-draft-loss; design assessment C1, C2 and its
// mutation list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r10.mjs`. Each removes ONE boundary of the correction; `expect` names the tests written for it, so only an assertion of
// those tests catches it.
//
// Considered and not selected (recorded for the reviewer): taking the status before `judged` AFTER the database is adopted is equivalent
// (a session with no database has no basis either: its observation, and every reading, needs its database, so adopting one alone leaves it
// `acquiring`); dropping `held === which` only repeats the notification `release` already gave (an ended session's status does not change
// again), which no dialog can tell apart. The opening read and a publication reach the status through the one `judgeNow`, so one mutant
// of its notification covers both paths, and the tests of both catch it.
import { sub } from "./data-catalogue.mjs";

const KEPT = "src/features/calendars/import-kept.ts";
const T_KEPT = "tests/features/calendars/import-kept.test.ts";
const T_RET = "tests/features/calendars/import-retention.test.tsx";

export const UNIT_13B_R11 = [
  {
    id: "MU-5261",
    title:
      "WEB-13b R7f (revision 11): what a reading establishes (the opening read, a publication, the first database adopted) makes a new session ready without telling the dialog showing it (it stays `acquiring` until something else renders it)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /R7f \((?:row|chooser)\): the (?:opening read|shown page's publication) that makes a new session ready TELLS it|R7f: the displayed account's first database|R7f \(row, witness \d\): a new import's opening read delivered alone/,
    patch: (t) =>
      sub(
        t,
        "  if (held === which && importStatus(which.editor) !== before) changed();\n",
        "",
      ),
  },
  {
    id: "MU-5262",
    title:
      "WEB-13b R7f (revision 11): every reading judged is told, whether or not the session's status changed (a repeated or an advancing publication tells a ready session again)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /R7f controls: a failed opening read, unknown facts/,
    patch: (t) =>
      sub(
        t,
        "  if (held === which && importStatus(which.editor) !== before) changed();\n",
        "  if (held === which) changed();\n",
      ),
  },
];

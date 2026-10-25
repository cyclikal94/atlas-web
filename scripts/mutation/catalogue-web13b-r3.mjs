// WEB-13b revision 3's mutants (review 3, R3c; the design assessment's sensitivity list), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r2.mjs`. Each removes ONE part of the detail
// section's choice of the visit going on (`AnchorSection.tsx`), its owner's refusal of an ended visit (`anchor-kept.ts`) or the binding
// read's admission (`anchor-binding.ts`); `expect` names the tests written for it, so only an assertion of those tests catches it. `sub` is
// the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const BINDING = "src/features/tasks/detail/anchor-binding.ts";
const KEPT = "src/features/tasks/detail/anchor-kept.ts";
const SECTION = "src/features/tasks/detail/AnchorSection.tsx";
const T_KEPT = "tests/features/tasks/anchor-kept.test.ts";
const T_SECTION = "tests/features/tasks/anchor-section.test.tsx";

/**
 * Unit mutants (layer L1b, the production composition over the IndexedDB double; L1a for the owner alone), MU-2517, MU-2518 and
 * MU-2520..MU-2522. Withdrawn as equivalent after an exploratory run (no test of either layer can tell them apart; recorded in the revision
 * report with that run's evidence), their ids never reused: MU-2519 (the visit taken without checking that the person is at the section's
 * address: in every schedule the router, its history and the document reach, the visit asked for is the task's), MU-2523 (no re-check as
 * a panel opens: the route's own re-check always comes first in the component tests; the open-time one is the guard for a browser's
 * ordering, which E-ANC4 drives natively), MU-2524 (the save's identities taken from the section's visit at the press: a panel is never
 * shown once its visit has ended, so the two are the same visit) and MU-2525 (Try again with the section's last recorded visit: the same).
 */
export const UNIT_13B_R3 = [
  {
    id: "MU-2517",
    title:
      "WEB-13b R3c: the section keeps the visit it was first shown on (a panel opened after a departure and return the section outlived is the ended visit's, and its kept input is discarded)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /input typed in a panel opened after away and back|away and back in one turn by|R3a after away and back|R3b after away and back|after away and back in one turn, a save that may have been stored/,
    patch: (t) =>
      sub(
        t,
        "    if (was === null || !was.ended() || !screenAt(was.address)) return was;\n",
        "    return was;\n",
      ),
  },
  {
    id: "MU-2518",
    title:
      "WEB-13b R3c: the section follows the visit going on only when a panel opens (its binding stays the ended visit's read)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /away and back in one turn reads it again, once|goes away and back in one turn \(the section kept mounted\) is admitted again/,
    patch: (t) =>
      sub(t, "    return onRouteMoved(() => {\n      rebind();\n    });\n", ""),
  },
  {
    id: "MU-2520",
    title:
      "WEB-13b R3c: a panel opens on a visit that has ended (its session is kept by nothing, and its input lost at the next close)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /no panel opens on a visit that has ended/,
    patch: (t) => sub(t, "  if (owner?.ended()) return null;\n", ""),
  },
  {
    id: "MU-2521",
    title:
      "WEB-13b R3c: a panel shown when its visit ends stays open, showing input its ended session can no longer save",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /a panel open when the person goes away and back in one turn|a panel open when another identity is shown closes/,
    patch: (t) =>
      sub(
        t,
        "    const on = shown?.visit ?? null;\n    if (on === null) return;\n",
        "    const on = shown?.visit ?? null;\n    if (on === null || shown !== null) return;\n",
      ),
  },
  {
    id: "MU-2522",
    title:
      "WEB-13b R3c: an unsent binding read a newer visit's read replaced is still sent while the person is at the task (two requests for one read)",
    file: BINDING,
    tests: [T_SECTION],
    expect:
      /goes away and back in one turn \(the section kept mounted\) is admitted again/,
    patch: (t) =>
      sub(
        t,
        "    live() && memory === own && own.reads.get(key)?.token === token;\n",
        "    live();\n",
      ),
  },
];

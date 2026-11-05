// Main reconciliation, 26 October 2026: WEB-13b MU-2501..MU-2551 are now MU-5065..MU-5109 (+85).
// Historical reports keep their original IDs; mutation patches, selectors and assertions are unchanged.
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
const DISPATCHER = "src/data/engine/outbox-dispatcher.ts";
const T_FORBIDDEN = "tests/data/leader-forbidden.test.ts";
const LATE =
  /an ordinary 403 forbidden|a 422 answered under the same interruption|a receipt under the same interruption|while the display stays closed/;

/**
 * Unit mutants (layer L1b, the production composition over the IndexedDB double; L1a for the owner alone), MU-5081, MU-5082 and
 * MU-5083..MU-5085. Withdrawn as equivalent after an exploratory run (no test of either layer can tell them apart; recorded in the revision
 * report with that run's evidence), their ids never reused: MU-2604 (the visit taken without checking that the person is at the section's
 * address: in every schedule the router, its history and the document reach, the visit asked for is the task's), MU-2608 (no re-check as
 * a panel opens: the route's own re-check always comes first in the component tests; the open-time one is the guard for a browser's
 * ordering, which E-ANC4 drives natively), MU-2609 (the save's identities taken from the section's visit at the press: a panel is never
 * shown once its visit has ended, so the two are the same visit) and MU-2610 (Try again with the section's last recorded visit: the same).
 */
export const UNIT_13B_R3 = [
  {
    id: "MU-5081",
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
    id: "MU-5082",
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
    id: "MU-5083",
    title:
      "WEB-13b R3c: a panel opens on a visit that has ended (its session is kept by nothing, and its input lost at the next close)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /no panel opens on a visit that has ended/,
    patch: (t) => sub(t, "  if (owner?.ended()) return null;\n", ""),
  },
  {
    id: "MU-5084",
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
    id: "MU-5085",
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
  // F-13b-1 (handover `delivery/handoffs/web13b-foundation-403-approved-20261025.md`): the issued answer of a stopped run (L1b, production
  // leadership over the deterministic world). Withdrawn as equivalent after an exploratory run, its id never reused: MU-2613 (the answer of
  // an ENDED binding settled too: the commit's own guards, identity, epoch, incarnation and ownership, refuse it all the same, F-2).
  {
    id: "MU-5086",
    title:
      "WEB-13b F-13b-1: an issued command's answer is dropped with the run the display's interim hold stopped (resent at once, as found)",
    file: DISPATCHER,
    tests: [T_FORBIDDEN],
    expect: LATE,
    patch: (t) =>
      sub(
        t,
        '    if (!settles(id, run)) return { when: "event" };\n    if (alive(id)) {\n',
        '    if (!alive(id)) return { when: "event" };\n    if (alive(id)) {\n',
      ),
  },
  {
    id: "MU-5087",
    title:
      "WEB-13b F-13b-1: the decoded answer of a stopped run is dropped before it is recorded",
    file: DISPATCHER,
    tests: [T_FORBIDDEN],
    expect: LATE,
    patch: (t) =>
      sub(
        t,
        '    deps.trace?.emit("data.outbox_answer", { kind: outcome.kind });\n    if (!settles(id, run)) return { when: "event" };\n',
        '    deps.trace?.emit("data.outbox_answer", { kind: outcome.kind });\n    if (!alive(id)) return { when: "event" };\n',
      ),
  },
];

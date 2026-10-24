// WEB-10a revision 23's mutants (Review 23 R35 and its design assessment DA23: settling a save is not permission to act on the screen;
// only an editor's attachment that still presents may close a saved form onto its task), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Kept in their own module as revisions 16 to 22's are (the
// catalogue is at Biome's 1 MiB file-size limit). `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const SAVES = "tests/features/tasks/save-presentation.test.tsx";
const ATTACHMENTS = "tests/features/tasks/task-attachment.test.tsx";
const KEPT = "src/features/tasks/kept-input.ts";
const VISIT = "src/features/tasks/visit.ts";

/** A consumed save's editor acts whether or not the person is still at its screen (revision 22's behaviour: R35). */
const ungated = (t) =>
  sub(t, "        here === null || here.presents()\n", "        true\n");
/** The visit's own router never revokes an attachment (only the document's later record would). */
const noRouterRevocation = (t) =>
  sub(
    t,
    "    if (history !== undefined)\n      stop = history.subscribe(",
    "    if (history !== undefined && false)\n      stop = history.subscribe(",
  );

/** Unit mutants (layers L1b, the app's router over the production data controller and the IndexedDB double, and L1a), MU-2402..MU-2407. */
export const UNIT_R23 = [
  {
    id: "MU-2402",
    title:
      "WEB-10a rev 23 (R35): a consumed save's form navigates whether or not the person is still at it (the task list or the sync screens)",
    file: KEPT,
    tests: [SAVES],
    expect:
      /acknowledged before the old form is removed, the person stays|the queued change is edited once, acknowledged before the old form is removed/,
    patch: ungated,
  },

  {
    id: "MU-2403",
    title:
      "WEB-10a rev 23 (R35 / DA23 Q5): an attachment presents while its visit has not ended (the sync screens, which keep the visit, still redirected)",
    file: VISIT,
    tests: [SAVES, ATTACHMENTS],
    expect:
      /the sync screens: acknowledged before the old form is removed|queued (create|revise)_task, \/sync|a navigation to \/sync: not presenting|the old attachment never presents again/,
    patch: (t) =>
      sub(
        t,
        "      presents: () =>\n        !revoked &&\n        !visit.ended() &&\n        current === visit &&\n        !away(routes().pathname()) &&\n        (router === null ||\n          (!away(router.latestLocation.pathname) &&\n            (history === undefined || !away(history.location.pathname)))),\n",
        "      presents: () => !visit.ended(),\n",
      ),
  },

  {
    id: "MU-2404",
    title:
      "WEB-10a rev 23 (DA23 Q2, N < A < D): only the document's address decides (an acknowledgement after the router moved, before the document's write, presents)",
    file: VISIT,
    tests: [ATTACHMENTS],
    expect: /before the document's address is written/,
    patch: (t) =>
      sub(
        noRouterRevocation(t),
        "        !away(routes().pathname()) &&\n        (router === null ||\n          (!away(router.latestLocation.pathname) &&\n            (history === undefined || !away(history.location.pathname)))),\n",
        "        !away(routes().pathname()),\n",
      ),
  },

  {
    id: "MU-2405",
    title:
      "WEB-10a rev 23 (DA23 invariant 3): a departure never revokes an attachment (Back to the same address restores the old editor's authority)",
    file: VISIT,
    tests: [ATTACHMENTS],
    expect: /the old attachment never presents again/,
    patch: (t) =>
      sub(
        noRouterRevocation(t),
        "  for (const [revoke, on] of [...attached]) if (at !== on.address) revoke();\n",
        "",
      ),
  },

  {
    id: "MU-2406",
    title:
      "WEB-10a rev 23 (DA23 invariant 4): a save is not consumed while an editor still holds its session (settlement waits for the form, and a save settled at the sync screens is left pending)",
    file: KEPT,
    tests: [SAVES],
    expect:
      /acknowledged before the old form is removed|closes the form onto its task|the queued change is edited once/,
    patch: (t) =>
      sub(
        t,
        "  if (saved && held.revision === ticket.revision) {\n",
        "  if (saved && held.revision === ticket.revision && held.holders === 0) {\n",
      ),
  },

  {
    id: "MU-2407",
    title:
      "WEB-10a rev 23 (DA23 invariant 3): only the mount that submitted may act on its save (the person back at the pending form is not closed onto the task)",
    file: KEPT,
    tests: [SAVES],
    expect: /Back to the pending form, then acknowledged/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const session = useRef<number | null>(null);\n",
            "  const session = useRef<number | null>(null);\n  const submittedHere = useRef(false);\n",
          ),
          "        here === null || here.presents()\n",
          "        (here === null || here.presents()) && submittedHere.current\n",
        ),
        "      if (ticket !== null) setShown((s) => ({ ...s, busy: true }));\n",
        "      if (ticket !== null) {\n        submittedHere.current = true;\n        setShown((s) => ({ ...s, busy: true }));\n      }\n",
      ),
  },
];

/** Real-engine mutants (whole-mutant native runs in all three engines over E-T45), MU-2408. */
export const ENGINE_R23 = [
  {
    id: "MU-2408",
    title:
      "WEB-10a N-T45: (REAL ENGINE) a consumed save's form navigates whether or not the person is still at it (the Tasks link or the sync control before the acknowledgement)",
    file: KEPT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T45: .*(the Tasks link|the sync control) before the acknowledgement",
    expect: /E-T45:/,
    patch: ungated,
  },
];

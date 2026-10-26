// WEB-10a revision 24's mutants (Review 24 R36 and the design assessment after it: an editor React never removed is the editor the person
// is at again once they are back at its address; it is attached anew there for later work, the visit going on there takes over its
// session, and a dialog or form whose save was consumed meanwhile starts afresh), in the form and under the rules of `data-catalogue.mjs`,
// which spreads them into its `UNIT` list. Kept in their own module as revisions 16 to 23's are. `sub` is the catalogue's own
// exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const RETURNS = "tests/features/tasks/correction-return.test.tsx";
const SAVES = "tests/features/tasks/save-presentation.test.tsx";
const ADOPTION = "tests/features/tasks/session-adoption.test.ts";
const MOVED = "tests/features/tasks/task-route-moved.test.tsx";
const DIALOG = "src/features/tasks/detail/CorrectionDialog.tsx";
const OWNER = "src/features/tasks/detail/correction-owner.ts";
const KEPT = "src/features/tasks/kept-input.ts";
const VISIT = "src/features/tasks/visit.ts";

const ADOPT_GUARD =
  "  if (held === undefined || held.session !== session || held.holders === 0)\n    return;\n";

/** Unit mutants (layers L1b, the app's router over the production data controller and the IndexedDB double, and L1a), MU-2410..MU-2423. */
export const UNIT_R24 = [
  {
    id: "MU-2410",
    title:
      "WEB-10a rev 24 (R36): a correction dialog whose save was consumed while the person was away never starts afresh when they are back (its Save does nothing)",
    file: DIALOG,
    tests: [RETURNS],
    expect:
      /the same dialog starts afresh|starts afresh on the return|three explicit saves/,
    patch: (t) => sub(t, "      if (spent) {\n", "      if (false) {\n"),
  },

  {
    id: "MU-2411",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 10): the dialog listens only for the session it first opened (a fresh session's success is never heard: it stays pending and open)",
    file: DIALOG,
    tests: [RETURNS],
    expect: /the next Save writes 13 and closes it|three explicit saves/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    open();\n    // The person is at the dialog's address again",
          "    open();\n    const first = session.current;\n    // The person is at the dialog's address again",
        ),
        "      if (event.session !== session.current) return;\n",
        "      if (event.session !== first) return;\n",
      ),
  },

  {
    id: "MU-2412",
    title:
      "WEB-10a rev 24 (R36): the correction dialog is never told the person is back (acknowledged while away it stays without a session; a kept input's later save never closes it)",
    file: DIALOG,
    tests: [RETURNS],
    expect:
      /acknowledged there before the dialog was removed|Save again writes 12 once and closes|15 is kept; Save writes 15 and closes|Correct resumes 16/,
    patch: (t) =>
      sub(
        t,
        "    const unheard = onRouteMoved(renew);\n",
        "    const unheard = () => {};\n",
      ),
  },

  {
    id: "MU-2413",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 6): the dialog's new attachment lets the save taken before the departure close it (the old acknowledgement acts on the returned screen)",
    file: DIALOG,
    tests: [RETURNS],
    expect: /and back, then acknowledged: one correction|three explicit saves/,
    patch: (t) =>
      sub(
        t,
        "      const by = acting.current;\n",
        "      const by = attachment.current;\n",
      ),
  },

  {
    id: "MU-2414",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 7): the visit going on at the returned dialog's address never takes over its session (input typed after a return through the task list is lost at the sync screens)",
    file: DIALOG,
    tests: [RETURNS],
    expect: /Correct resumes 16/,
    patch: (t) =>
      sub(
        t,
        "        if (next !== owner && session.current !== null)\n          adoptCorrection(key, session.current, next);\n",
        "",
      ),
  },

  {
    id: "MU-2415",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 7): any correction session is taken over, another session of the day or one no dialog holds included (an ended visit's input is kept)",
    file: OWNER,
    tests: [ADOPTION],
    expect: /adoptCorrection.*not taken over/,
    patch: (t) => sub(t, ADOPT_GUARD, "  if (held === undefined) return;\n"),
  },

  {
    id: "MU-2416",
    title:
      "WEB-10a rev 24 (R36): a form is never told the person is back (acknowledged while away it keeps the consumed input and no session; a refused save's retry never closes it)",
    file: KEPT,
    tests: [SAVES],
    expect:
      /before the form was removed, then back: fresh|Save again writes it once and closes the form|the input typed is kept/,
    patch: (t) =>
      sub(
        t,
        "    const unheard = onRouteMoved(revive);\n",
        "    const unheard = () => {};\n",
      ),
  },

  {
    id: "MU-2417",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 6): a form's new attachment lets the save taken before the departure act (the old acknowledgement closes the returned form onto its task)",
    file: KEPT,
    tests: [SAVES],
    expect: /away and back before React removed the form/,
    patch: (t) =>
      sub(
        t,
        "      const by = acting.current;\n",
        "      const by = attachment.current;\n",
      ),
  },

  {
    id: "MU-2418",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 7): the visit going on at the returned form's address never takes over its session (input typed after a return through the task list is lost at the sync screens)",
    file: KEPT,
    tests: [SAVES],
    expect: /the input typed is kept/,
    patch: (t) =>
      sub(
        t,
        "        if (next !== owner && session.current !== null)\n          adoptKept(key, session.current, next);\n",
        "",
      ),
  },

  {
    id: "MU-2419",
    title:
      "WEB-10a rev 24 (R36 / DA invariant 7): any kept session is taken over, another session or one no editor holds included (an ended visit's input is kept)",
    file: KEPT,
    tests: [ADOPTION],
    expect: /adoptKept.*not taken over/,
    patch: (t) => sub(t, ADOPT_GUARD, "  if (held === undefined) return;\n"),
  },

  {
    id: "MU-2420",
    title:
      "WEB-10a rev 24 (R36): an editor is told only by its router's history (a browser push writes the document's address later: the person back by a push is never seen at the address)",
    file: VISIT,
    tests: [MOVED],
    expect: /then a push back: told/,
    patch: (t) =>
      sub(
        t,
        "    const stopRoutes = routes().subscribe(() => listener());\n",
        "    const stopRoutes = () => {};\n",
      ),
  },

  {
    id: "MU-2421",
    title:
      "WEB-10a rev 24 (R36): an editor is told only by the observed address (revision 23's trigger: Back, and the component tests' memory history, reach it before the router has moved)",
    file: VISIT,
    tests: [MOVED, RETURNS],
    expect:
      /then Back: told|acknowledged there before the dialog was removed|Save again writes 12 once and closes/,
    patch: (t) =>
      sub(
        t,
        "    const stopHistory = router?.history?.subscribe(() => listener());\n",
        "    const stopHistory = undefined as (() => void) | undefined;\n",
      ),
  },

  {
    id: "MU-2422",
    title:
      "WEB-10a rev 24 (R36): a form's save acts by the attachment it had when it opened, not the one it was saved from (a retry after a return never closes the form onto its task)",
    file: KEPT,
    tests: [SAVES],
    expect: /Save again writes it once and closes the form onto its task/,
    patch: (t) => sub(t, "        acting.current = attachment.current;\n", ""),
  },

  {
    id: "MU-2423",
    title:
      "WEB-10a rev 24 (R36): a correction's save acts by the attachment the dialog had when it opened, not the one it was saved from (a retry after a return never closes it)",
    file: DIALOG,
    tests: [RETURNS],
    expect:
      /Save again writes 12 once and closes the dialog|15 is kept; Save writes 15 and closes/,
    patch: (t) => sub(t, "    acting.current = attachment.current;\n", ""),
  },
];

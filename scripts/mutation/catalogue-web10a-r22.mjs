// WEB-10a revision 22's mutants (Review 22 R34 and its design assessment: DA22-I1, the edit form's input is the edit visit's, not the
// form's the data can show; DA22-I2, the cache gate hiding the whole screen is not a departure; DA22-I3, leaving the sync screens for
// anywhere but the editor's address ends the visit), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its
// `UNIT` and `ENGINE` lists. Kept in their own module as revisions 16 to 21's are (the catalogue is at Biome's 1 MiB file-size limit).
// `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const OWN = "tests/features/tasks/task-visit-ownership.test.tsx";
const VISITS = "tests/features/tasks/task-visit.test.ts";
const ROUTE_TESTS = "tests/lib/route-changes.test.ts";
const DETAIL = "src/features/tasks/detail/useTaskDetail.ts";
const HISTORY = "src/features/tasks/detail/EntryHistory.tsx";
const KEPT = "src/features/tasks/kept-input.ts";
const CORRECTION = "src/features/tasks/detail/correction-owner.ts";
const PICKER = "src/features/tasks/form/PresetPicker.tsx";
const VISIT = "src/features/tasks/visit.ts";
const ROUTES = "src/lib/route-changes.ts";

/** An editor's session belongs to no visit: only its mount keeps it (revision 21's edit form, R34: the form the data hides drops it). */
const noOwner = (t) =>
  sub(t, "    const owner = visitOf(identity);\n", "    const owner = null;\n");
/** The visits never hear a departure: a visit ends only when a task screen asks for another address or identity (DA22-I3). */
const unobserved = (t) =>
  sub(
    t,
    "  unsubscribe = next.subscribe(heard);\n",
    "  unsubscribe = () => undefined;\n",
  );

/** Unit mutants (layer L1b: the app's router over the production data controller and the IndexedDB double), MU-2390..MU-2399. */
export const UNIT_R22 = [
  {
    id: "MU-2390",
    title:
      "WEB-10a rev 22 (DA22-I1, R34): an editor's session belongs to no visit (the edit form the data hides drops the typed title)",
    file: KEPT,
    tests: [OWN],
    expect:
      /the details leave and come back while the person stays|after sync and Back, the details leave and come back|refused while they are gone|the cache gate hides the whole screen and opens again/,
    patch: noOwner,
  },

  {
    id: "MU-2391",
    title:
      "WEB-10a rev 22 (DA22-I3): departures are not observed (a visit left from the sync screens or while hidden resumes on a later visit)",
    file: VISIT,
    tests: [OWN, VISITS],
    expect:
      /DA22-I3: sync, then the task list|details gone when Back returns, then an ordinary departure|DA22-I3: an open fix, sync, then the task list|DA22-I3: a correction kept by its sync control|ends on any other address/,
    patch: unobserved,
  },

  {
    id: "MU-2392",
    title:
      "WEB-10a rev 22 (DA22-I2): a mount of the detail ending at its own address lets go of the day it shows (the gate's recovery loses its input)",
    file: DETAIL,
    tests: [OWN],
    expect:
      /the gate hides and shows the detail again: day A's typed amount|the protected tree remounted at the detail's address|Correct resumes the person's 12/,
    patch: (t) =>
      sub(
        t,
        "    visit.current = visitOf(env.identity);\n    alone.current = { target: null, progress: null };\n  }, [env.identity, taskId]);\n",
        "    visit.current = visitOf(env.identity);\n    alone.current = { target: null, progress: null };\n    return () => {\n      const mine = visit.current;\n      if (mine !== null) show(shownBy(mine, taskId), env.identity, null, null);\n    };\n  }, [env.identity, taskId]);\n",
      ),
  },

  {
    id: "MU-2393",
    title:
      "WEB-10a rev 22 (DA22-I2): a new mount shows its read before the read is complete (no day yet: the visit's day is let go)",
    file: DETAIL,
    tests: [OWN],
    expect:
      /the gate hides and shows the detail again: day A's typed amount|the protected tree remounted at the detail's address/,
    patch: (t) => sub(t, "    if (!complete) return;\n", ""),
  },

  {
    id: "MU-2394",
    title:
      "WEB-10a rev 22 (DA22-I3): the picker's in-dialog sync control passes through the task list (a departure: the choice is lost, Back misses the picker)",
    file: PICKER,
    tests: [OWN],
    expect:
      /the picker's in-dialog sync control goes to the sync screens straight/,
    patch: (t) =>
      sub(
        t,
        "        if (toSync.current) toSync.current = false;\n        else onClose();\n",
        "        onClose();\n",
      ),
  },

  {
    id: "MU-2395",
    title:
      "WEB-10a rev 22 (DA22 Q3): the memory-history route record tells changes of only the query or the fragment (not the document's semantics)",
    file: ROUTES,
    tests: [ROUTE_TESTS],
    expect: /push and replace are told once per path change/,
    patch: (t) =>
      sub(
        t,
        "    const now = history.location.pathname;\n    if (now === last) return;\n",
        "    const now = history.location.pathname;\n",
      ),
  },

  {
    id: "MU-2396",
    title:
      "WEB-10a rev 22 (DA22-I2): a history the cache gate hides keeps no fix input (the gate's recovery shows no fix open)",
    file: HISTORY,
    tests: [OWN],
    expect: /the gate hides and shows the detail again: the open fix/,
    patch: (t) =>
      sub(
        t,
        "      if (visit === null || visit.ended()) return;\n",
        "      return;\n",
      ),
  },

  {
    id: "MU-2397",
    title:
      "WEB-10a rev 22 (DA22-I2): a correction dialog the cache gate hides drops its session (Correct after the gate starts afresh)",
    file: CORRECTION,
    tests: [OWN],
    expect: /Correct resumes the person's 12/,
    patch: (t) =>
      sub(
        t,
        "  if (live && (held.revision > 0 || held.submitting !== null)) {\n    entries.set(key, { ...held, retained: true });\n    return;\n  }\n",
        "",
      ),
  },

  {
    id: "MU-2398",
    title:
      "WEB-10a rev 22 (DA22-I2): an unheld session is never kept by its visit (the gate hiding the edit or new form loses what was typed)",
    file: KEPT,
    tests: [OWN],
    expect:
      /the cache gate hides the whole screen and opens again|the cache gate hides and shows the screen again: the same form|the protected tree remounted at the same address/,
    patch: (t) =>
      sub(
        t,
        "  held.owner !== null && !held.owner.ended() && holdsInput(held);\n",
        "  false as boolean;\n",
      ),
  },

  {
    id: "MU-2399",
    title:
      "WEB-10a rev 22 (DA22 invariant 3): the visit ends at the sync screens (checking sync state is treated as any departure)",
    file: VISIT,
    tests: [OWN, VISITS],
    expect:
      /control: sync and Back keep the edit|control: sync, then the queue's own way back|goes on at its own address and through the sync screens/,
    patch: (t) =>
      sub(
        t,
        "  if (at !== visit.address && !atSync(at)) end(visit);\n",
        "  if (at !== visit.address) end(visit);\n",
      ),
  },
];

/** Real-engine mutants (whole-mutant native runs in all three engines over E-T44), MU-2400..MU-2401. */
export const ENGINE_R22 = [
  {
    id: "MU-2400",
    title:
      "WEB-10a N-T44: (REAL ENGINE) an editor's session belongs to no visit (another tab removing the task's details drops the typed title)",
    file: KEPT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T44: .*R34: sync and Back keep the typed title",
    expect: /E-T44:/,
    patch: noOwner,
  },

  {
    id: "MU-2401",
    title:
      "WEB-10a N-T44: (REAL ENGINE) the document's departures are not observed (Back to the edit form after leaving it brings back the abandoned title)",
    file: VISIT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T44: .*(the Tasks link: details back|DA22-I3: the sync control)",
    expect: /E-T44:/,
    patch: unobserved,
  },
];

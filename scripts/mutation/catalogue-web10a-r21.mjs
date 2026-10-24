// WEB-10a revision 21's mutants (the design assessment of Review 21: DA21-I1, the visit's target is established before its parent is
// known to be readable; DA21-I2, the logical visit owns, and its ordinary end retires, every session it took back from the sync screens or
// parked), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. Kept in their
// own module as revisions 16 to 20's are (the catalogue is at Biome's 1 MiB file-size limit). `sub` is the catalogue's own
// exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const RETURN = "tests/features/tasks/sync-return-context.test.tsx";
const DETAIL = "src/features/tasks/detail/useTaskDetail.ts";
const HISTORY = "src/features/tasks/detail/EntryHistory.tsx";
const KEPT = "src/features/tasks/kept-input.ts";
const CORRECTION = "src/features/tasks/detail/correction-owner.ts";

/** Restores revision 20's guard: the visit's own day is resolved only while the task's details can be read (else no target, no hold). */
const targetNeedsDetails = (t) =>
  sub(
    t,
    "    if (input.pinned !== null) {\n      // The visit's day, resolved",
    "    if (input.pinned !== null && definition !== null && executionId !== null) {\n      // The visit's day, resolved",
  );
/** Holding a key no longer adopts a session kept through a sync visit (revision 20: its `kept` mark outlives the visit). */
const noAdoption = (t) =>
  sub(t, "  if (found !== undefined) found.kept = false;\n", "");

/** Unit mutants (layer L1b: the app's router over the production data controller and the IndexedDB double), MU-2379..MU-2387. */
export const UNIT_R21 = [
  {
    id: "MU-2379",
    title:
      "WEB-10a rev 21 (DA21-I1): the visit's day is its target only while the task's details can be read (the details leaving release its input)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /the task's details leave this device|the task's details unreadable|the open fix keeps its value through the task's details|the open correction \(not kept by its sync control\)/,
    patch: targetNeedsDetails,
  },

  {
    id: "MU-2380",
    title:
      "WEB-10a rev 21 (DA21-I1): the visit's day is shown while the task's details are unreadable (recording offered against an unverified day)",
    file: DETAIL,
    tests: [RETURN],
    expect: /the task's details unreadable/,
    patch: (t) =>
      sub(
        t,
        "      definition !== null && belongs(row);\n",
        "      belongs(row);\n",
      ),
  },

  {
    id: "MU-2381",
    title:
      "WEB-10a rev 21 (DA21-I2): the visit holding a day does not adopt the amount kept through a sync visit (an ordinary departure leaves it kept)",
    file: KEPT,
    tests: [RETURN],
    expect:
      /day A removed while the person is in the sync screens, Back \(unavailable\), an ordinary departure|a day parked before a sync visit is still the visit's after Back/,
    patch: noAdoption,
  },

  {
    id: "MU-2382",
    title:
      "WEB-10a rev 21 (DA21-I2): the visit holding a day does not adopt the correction its sync control retained (never reopened, it outlives the visit)",
    file: CORRECTION,
    tests: [RETURN],
    expect:
      /a correction kept by the dialog's sync control and never reopened ends|a correction kept through the sync screens while day A left/,
    patch: (t) =>
      sub(
        t,
        "  if (found !== undefined && adopted !== null)\n    entries.set(key, { ...found, retained: false, releasing: true });\n",
        "",
      ),
  },

  {
    id: "MU-2383",
    title:
      "WEB-10a rev 21 (DA21-I2): a kept fix is dropped only if it is still the same object (a save's answer rewriting it meanwhile keeps it alive)",
    file: HISTORY,
    tests: [RETURN],
    expect: /a fix save answered after the visit ended/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    const keeps = fixKeeps.get(owner) ?? 0;\n",
          "    const keeps = fixKeeps.get(owner) ?? 0;\n    const kept = keptFixes.get(owner);\n",
        ),
        "      if (!fixVisits.has(owner) && (fixKeeps.get(owner) ?? 0) === keeps)\n",
        "      if (\n        !fixVisits.has(owner) &&\n        (fixKeeps.get(owner) ?? 0) === keeps &&\n        keptFixes.get(owner) === kept\n      )\n",
      ),
  },

  {
    id: "MU-2384",
    title:
      "WEB-10a rev 21 (DA21-I2): an ordinary end of the visit keeps the days it parked (choosing again leaves their input for a later visit)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /choosing again parks day A's|a parked correction is the identity's/,
    patch: (t) =>
      sub(
        t,
        '      how === "sync" || (how === "stays" && occurrence !== visit.target);\n',
        '      how === "sync" || occurrence !== visit.target;\n',
      ),
  },

  {
    id: "MU-2385",
    title:
      "WEB-10a rev 21 (DA21-I2): a mount does not take back the days its visit held at the sync screens (a day parked before the visit outlives it)",
    file: DETAIL,
    tests: [RETURN],
    expect: /a day parked before a sync visit is still the visit's after Back/,
    patch: (t) =>
      sub(
        t,
        "    for (const [occurrence, progress] of resumeVisit(key, env.identity))\n",
        "    for (const [occurrence, progress] of resumeVisit(key, env.identity).slice(0, 0))\n",
      ),
  },

  {
    id: "MU-2386",
    title:
      "WEB-10a rev 21 (DA21-I2): another identity at the same address does not end the visit (its parked correction is kept for the old identity)",
    file: DETAIL,
    tests: [RETURN],
    expect: /a parked correction is the identity's/,
    patch: (t) =>
      sub(
        t,
        '        identityRef.current !== mine.identity\n          ? "ended"\n          : endsAt(pathRef.current(), taskId),\n',
        "        endsAt(pathRef.current(), taskId),\n",
      ),
  },

  {
    id: "MU-2387",
    title:
      "WEB-10a rev 21 (DA21-I2): the day picker's address within the task ends the visit (the days it parked are dropped)",
    file: DETAIL,
    tests: [RETURN],
    expect:
      /picked again within the visit|picked again after Back once it is back|picking day A once it is back shows it/,
    patch: (t) =>
      sub(
        t,
        '    ? "stays"\n    : "ended";\n',
        '    ? "ended"\n    : "ended";\n',
      ),
  },
];

/** Real-engine mutants (whole-mutant native runs in all three engines over E-T43), MU-2388..MU-2389. */
export const ENGINE_R21 = [
  {
    id: "MU-2388",
    title:
      "WEB-10a N-T43: (REAL ENGINE) the visit's day is its target only while the task's details can be read (another tab removing them drops the amount)",
    file: DETAIL,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T43: .*another tab's sync page removes the task's details",
    expect: /E-T43:/,
    patch: targetNeedsDetails,
  },

  {
    id: "MU-2389",
    title:
      "WEB-10a N-T43: (REAL ENGINE) the visit does not adopt the amount kept through a sync visit (leaving the returned visit keeps it for the next)",
    file: KEPT,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T43: .*leaving that visit ends its amount",
    expect: /E-T43:/,
    patch: noAdoption,
  },
];

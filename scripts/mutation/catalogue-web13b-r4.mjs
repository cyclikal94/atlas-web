// WEB-13b revision 4's mutants (review 4, F-13b-1a; the design assessment's sensitivity list, Q4), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r3.mjs`. Each removes ONE part of the dispatcher's
// settlement of an issued answer after the run that sent it ended (`retained`) or of what that settlement owes the binding's runs (`owed`);
// `expect` names the tests written for it, so only an assertion of those tests catches it. Every test holds each send until it answers it
// and runs on fake time, so a mutant that would send in a loop is seen by an assertion of the count, never by a time-out. `sub` is the
// catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const DISPATCHER = "src/data/engine/outbox-dispatcher.ts";
const T_SETTLE = "tests/data/outbox-retained-settlement.test.ts";
const T_FORBIDDEN = "tests/data/leader-forbidden.test.ts";

/**
 * Withdrawn as equivalent before any campaign (id never reused): MU-2540 (a closed store's failure of a stopped run's record handled as a
 * failure): `AccountService.commit` reports a closed store as a drop (`closed`), so no failed result with that cause reaches `retained`;
 * the guard it removed was taken out of the dispatcher with it.
 *
 * Unit mutants (layer L1b, the production dispatcher and facade over the IndexedDB double; the leader's composition for T_FORBIDDEN). */
export const UNIT_13B_R4 = [
  {
    id: "MU-2529",
    title:
      "WEB-13b F-13b-1a: a stopped run's failed record of an issued answer is not counted (no streak, no pause, no stop: the draft is resent at once, as review 4 found)",
    file: DISPATCHER,
    tests: [T_SETTLE, T_FORBIDDEN],
    expect:
      /three failed records, the run restarted with the same binding|three failed records, the display closed and opened|the pause still holds when|the counter fails: a fallback marker|neither the counter nor the marker/,
    patch: (t) =>
      sub(
        t,
        '      case "failed":\n        // (A store that closed never arrives here: the commit reports it as a drop, `closed`.)\n        if (stands)\n',
        '      case "failed":\n        // (A store that closed never arrives here: the commit reports it as a drop, `closed`.)\n        if (false)\n',
      ),
  },
  {
    id: "MU-2530",
    title:
      "WEB-13b F-13b-1a: a run that starts for the same binding does not take over the pause a stopped run's failed record owes",
    file: DISPATCHER,
    tests: [T_SETTLE],
    expect: /the pause still holds when the run starts again 100 ms/,
    patch: (t) =>
      // Re-expressed in WEB-13b revision 5 (F-13b-1b/1c, N1): the same defect, anchored on the corrected text.
      sub(
        t,
        "        if (until <= now) owed.delete(localId);\n",
        "        if (Number.isFinite(until)) owed.delete(localId);\n",
      ),
  },
  {
    id: "MU-2531",
    title:
      "WEB-13b F-13b-1a: a below-bound failure to record an answer owes no pause (the run of the binding that stands sends the draft again at once)",
    file: DISPATCHER,
    tests: [T_SETTLE, T_FORBIDDEN],
    expect:
      /three failed records, the run restarted with the same binding|three failed records, the display closed and opened|the pause still holds when the run starts again 100 ms|during the pause sends nothing early/,
    patch: (t) =>
      sub(
        t,
        "      if (answering !== null) owe(run, answering, deps.clock.now() + 250);\n",
        "",
      ),
  },
  {
    id: "MU-2532",
    title:
      "WEB-13b F-13b-1a: every start forgets what the binding is owed (a restart lifts the hold of a full disk and the pause of a failed record)",
    file: DISPATCHER,
    tests: [T_SETTLE, T_FORBIDDEN],
    expect:
      /storage full through wakes, `online`, restarts of the binding|a full disk met again by the retried send|the pause still holds when the run starts again 100 ms|storage full after the display opens/,
    patch: (t) =>
      // Re-expressed in WEB-13b revision 5 (F-13b-1b/1c, N1): the same defect, anchored on the corrected text.
      sub(
        t,
        "      if (bound !== next) owed.clear();\n",
        "      owed.clear();\n",
      ),
  },
  {
    id: "MU-2533",
    title:
      "WEB-13b F-13b-1a: a full disk met recording an answer holds nothing (a wake or a restart sends the draft again)",
    file: DISPATCHER,
    tests: [T_SETTLE, T_FORBIDDEN],
    expect:
      /storage full through wakes, `online`, restarts of the binding|a full disk met again by the retried send|storage full after the display opens|another binding \(a new ownership\) inherits no hold|made offline, is not undone/,
    patch: (t) =>
      sub(
        t,
        "      if (answering !== null) owe(run, answering, Number.POSITIVE_INFINITY);\n",
        "",
      ),
  },
  {
    id: "MU-2534",
    title:
      "WEB-13b F-13b-1a: `online` lifts what the binding is owed (a draft paced after a failed record is sent early)",
    file: DISPATCHER,
    tests: [T_SETTLE],
    expect:
      /during the pause sends nothing early|storage full through wakes, `online`/,
    patch: (t) =>
      // Re-expressed in WEB-13b revision 5 (F-13b-1b/1c, N1): the same defect, anchored on the corrected text.
      sub(
        t,
        "    if (owedSeen !== null) retireOwed(owedSeen);\n",
        "    if (owedSeen !== null) retireOwed(owedSeen);\n    else owed.clear();\n",
      ),
  },
  {
    id: "MU-2535",
    title:
      "WEB-13b F-13b-1a: the person's retry does not lift the hold of a full disk (a restart before the retry is acted on puts it back)",
    file: DISPATCHER,
    tests: [T_SETTLE],
    expect: /made offline, is not undone by a restart/,
    patch: (t) =>
      // Re-expressed in WEB-13b revision 5 (F-13b-1b/1c, N1): the same defect, anchored on the corrected text.
      sub(t, "    if (owedSeen !== null) retireOwed(owedSeen);\n", ""),
  },
  {
    id: "MU-2536",
    title:
      "WEB-13b F-13b-1a: a failed record delivered after the binding ENDED is counted for it all the same",
    file: DISPATCHER,
    tests: [T_SETTLE],
    expect: /the binding ends while its failed record is under way/,
    patch: (t) =>
      // Re-expressed in WEB-13b revision 5 (F-13b-1b/1c, N1): the same defect, anchored on the corrected text.
      sub(
        sub(
          t,
          "    const stands = run !== null && !run.signal.aborted && service.live;\n",
          "    const stands = run !== null;\n",
        ),
        '    if (!authorised()) return { when: "event" };\n    failedOperations.add(operation);',
        "    failedOperations.add(operation);",
      ),
  },
  {
    id: "MU-2537",
    title:
      "WEB-13b F-13b-1a: a step that finds only a paced draft sets no wake (the draft waits for some other event)",
    file: DISPATCHER,
    tests: [T_SETTLE, T_FORBIDDEN],
    expect:
      /three failed records, the run restarted with the same binding|three failed records, the display closed and opened|the pause still holds when the run starts again 100 ms|could not verify while the run was stopped/,
    patch: (t) =>
      sub(
        t,
        "      const paced = owedWake();\n",
        "      const paced = null;\n",
      ),
  },
  {
    id: "MU-2538",
    title:
      "WEB-13b F-13b-1a: a run of the binding that finds only a draft held for a full disk shows nothing stopped",
    file: DISPATCHER,
    tests: [T_SETTLE, T_FORBIDDEN],
    expect:
      /storage full through wakes, `online`, restarts of the binding|a full disk met again by the retried send|storage full after the display opens/,
    patch: (t) =>
      sub(
        t,
        '      else if (owedFull()) setState({ kind: "stopped", cause: "storage_full" });\n',
        "",
      ),
  },
  {
    id: "MU-2539",
    title:
      "WEB-13b F-13b-1a: a stopped run's commit that could not be verified owes no pause (the draft is resent at once)",
    file: DISPATCHER,
    tests: [T_SETTLE],
    expect: /could not verify while the run was stopped/,
    patch: (t) =>
      sub(
        t,
        '        if (stands && out.reason === "unverified")\n',
        '        if (false && out.reason === "unverified")\n',
      ),
  },
];

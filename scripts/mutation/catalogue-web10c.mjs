// WEB-10c's mutants (plan §7.4: catch-up, streak, dependencies, timers, rotas and the W28/W29 records), numbered MU-3001… (the plan's
// MU-10C-nn is MU-30nn; its N-10C-nn is MU-305n), each title starting with the plan's id. In the form and under the rules
// of `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists. `sub` is the catalogue's own exactly-one-occurrence
// patcher. Every unit mutant names the test written for it (`expect`, matched against the failing test's full name): only an assertion of
// that test counts as a catch.
//
// Retired from the plan's list, with the reason (never counted as caught):
//  - MU-10C-25 (`set_rota` queued offline): no queued path exists for an access command; offline the turn order and the consent are
//    disabled before any send (`RotaPanel`), so a mutant of `sendAccess`'s own offline check is unreachable from the screens.
//  - MU-10C-30 (joint strip from cached streams): the strip reads only MY stream by its deterministic id; no other stream is read, so
//    no patch can make it joint without adding a read (the shape the decision rules out).
//  - N-10C-03 (the copy read from another account after a switch): the copy lives in the account's own database and is written only
//    through W29's guards; the identity cases are MU-10C-12 (plan) and MU-10C-12 (screen), so a native switch adds no sensitivity.
//  - MU-3164 (revision 6, R29: work whose implicit today resolved keeps its unresolved `currentKey`): the only schedule it changes is the
//    same day asked explicitly during the `clearSatisfied` await between the zone being found and the day being marked `attempted`; there
//    the duplicate is ended by `attempted` after one more position read (no send). The IndexedDB double has no resumable hold for that
//    transaction, so no deterministic test can observe it; the re-key stays as bookkeeping, and its control test passes before and after.
//  - MU-3303 (revision 15, REAL ENGINE, E-M2: the page's `beforeunload` not marking its teardown): run once by the revision-15 driver
//    (run 2026-11-02T10-10-26.198Z-89411876) and caught on Chromium only (E-M2's two cases fail by assertion); Firefox and WebKit pass,
//    because there the rejected call's outcome is written before the page unloads and its receipt fence retired, so the fault has no
//    consequence. The real-engine classifier requires the expected assertion on every engine, so it is not an engine mutant; the fault
//    is MU-3301's (unit, the production lifecycle module), and Chromium's E-M2 is its native witness. Its result is kept, never counted.
//  - MU-3301 (revision 15: the page's `beforeunload` not observed), retired in revision 16 (review 17's R36-J; Kieran's D1 decision
//    approval/web10c-d1-preserve-rule-20261102.json): the lifecycle observes no `beforeunload` at all (an attempted departure proves
//    nothing), so the fault has no subject. Its revision-15 and revision-16 results are kept, never counted. Its intent (a call Chromium
//    cancels during the page's pagehide dispatch stays recoverable) is MU-3307's and MU-3314's.
//  - MU-3309, MU-3311 and MU-3312 (revision 16's first design: an attempted departure judged at the page's next task, with its disposal
//    and failed-write judgements), retired with that design: Kieran's D1 decision rejected the next-task boundary (a genuine failure
//    delivered just before the page's pagehide must stay protected), so the departure is now judged synchronously and those faults
//    have no subject. Their first-design run (data-mutants-focused-1: MU-3309 and MU-3312 caught, MU-3311 SURVIVED) is kept in the
//    revision-16 evidence, never counted.
import { sub } from "./data-catalogue.mjs";

const MODEL = "src/features/tasks/model/materialise.ts";
const RUNNER_TESTS = [
  "tests/features/tasks/materialise-model.test.ts",
  "tests/features/tasks/catchup-runner.test.ts",
];
/** Revision 10 (Decision B): the retry protocol's own tests, with the runner's. */
const RETRY_TESTS = [
  ...RUNNER_TESTS,
  "tests/features/tasks/retry-policy.test.ts",
  "tests/features/tasks/catchup-retry.test.ts",
];

export const UNIT_10C = [
  // ---- catch-up --------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-3001",
    title:
      "MU-10C-01: WEB-10c A2: the unattended budget is nine calls, not eight",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-01/,
    patch: (t) =>
      sub(t, "export const MAX_CALLS = 8;", "export const MAX_CALLS = 9;"),
  },
  {
    id: "MU-3002",
    title:
      "MU-10C-02: WEB-10c A2: a call that did not move the position is not a stop",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-02/,
    patch: (t) =>
      sub(t, '  if (!moved) return stopped(next, "no_progress");\n', ""),
  },
  {
    id: "MU-3003",
    title: "MU-10C-03: WEB-10c A2: Try again forgets the position reached",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-01/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10): Try again's phase is the stop's continuation.
        "    phase: continuation(row),\n    successful_calls: 0,",
        "    phase: continuation(row),\n    last_known_position: null,\n    successful_calls: 0,",
      ),
  },
  {
    id: "MU-3004",
    title: "MU-10C-04: WEB-10c A2: Try again keeps the spent budget",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-01/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10): Try again's phase is the stop's continuation.
        "    phase: continuation(row),\n    successful_calls: 0,",
        "    phase: continuation(row),\n    successful_calls: row.successful_calls,",
      ),
  },
  {
    id: "MU-3005",
    title:
      "MU-10C-05: WEB-10c A3 (CM-440): recovery from awaiting the position sends another materialise",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-05/,
    patch: (t) =>
      sub(
        t,
        '    case "awaiting_position_read":\n      return "read";',
        '    case "awaiting_position_read":\n      return "send";',
      ),
  },
  {
    id: "MU-3006",
    title:
      "MU-10C-06: WEB-10c A19: an uncertain answer drops its attempt, so the resend has a fresh key",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-06/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10, Decision B): a failure of the row's caller is recorded by `failure`; the fault drops its attempt.
        "  const next = { ...row, read_failures: s.failures, schedule: s };",
        "  const next = { ...row, attempt: null, read_failures: s.failures, schedule: s };",
      ),
  },
  {
    id: "MU-3007",
    title:
      "MU-10C-07: WEB-10c W28: the compare-and-set ignores the sequence's generation",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /a transition applies only to the row it was decided on/,
    patch: (t) =>
      sub(
        t,
        "    stored.sequence_generation === expected.sequence_generation &&\n",
        "",
      ),
  },
  {
    id: "MU-3008",
    title:
      "MU-10C-08: WEB-10c A2: a stopped sequence found by an automatic ensure is driven again",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/catchup-runner.test.ts",
      "tests/features/tasks/catchup-banner.test.tsx",
    ],
    expect: /MU-10C-02 \(runner\)|a stop is shown with its task/,
    // Deleting the guard alone is equivalent (`drive` does nothing with a stopped row); the fault is an ensure that resumes it.
    patch: (t) =>
      sub(
        t,
        // Revision 18 (R36-L): re-anchored after the stopped row's fence settling (the same fault: an ensure resumes the stop).
        "        return owns(at) ? DONE : lost(at);\n      }\n",
        "        const again = await commit(service, captured, key, stored, freshBudget(stored));\n" +
          "        if (again?.stored) await drive(at, again.stored, today);\n" +
          "        return owns(at) ? DONE : lost(at);\n" +
          "      }\n",
      ),
  },
  {
    id: "MU-3009",
    title:
      "MU-10C-09: WEB-10c A2: the horizon is today + 31 inclusive (>= instead of >)",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-09/,
    patch: (t) =>
      sub(
        t,
        "  throughDate > addDays(today, HORIZON_DAYS);",
        "  throughDate >= addDays(today, HORIZON_DAYS);",
      ),
  },
  {
    id: "MU-3010",
    title:
      "MU-10C-10: WEB-10c A4 (CM-434): the archived task's 422 is taken for no progress",
    file: MODEL,
    tests: RUNNER_TESTS,
    expect: /MU-10C-10/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10): the refusal also clears the schedule.
        '    case "rejected":\n      return stopped(\n        { ...row, attempt: null, schedule: null },\n        "rejected",',
        '    case "rejected":\n      return stopped(\n        { ...row, attempt: null, schedule: null },\n        "no_progress",',
      ),
  },
  {
    id: "MU-3011",
    title:
      "MU-10C-11: WEB-10c W28: a compare-and-set writes over a row it did not decide on",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /MU-10C-11|a transition applies only to the row/,
    patch: (t) =>
      sub(
        t,
        '    if (!matchesExpectation(reads, input.expected))\n      return { result: { kind: "stale", stored } };\n',
        "",
      ),
  },
  {
    id: "MU-3012",
    title:
      "MU-10C-12: WEB-10c W29: the timer copy's write applies no guard (another incarnation or an earlier epoch is written)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /MU-10C-12/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3): two W29 plans are admitted now; this is the copy's write.
        'name: "data.writeTimerCopy",\n  meta: { writer: "W29", guards: ["INC", "CLS", "EPO"], quota: "cache" },',
        'name: "data.writeTimerCopy",\n  meta: { writer: "W29", guards: [], quota: "cache" },',
      ),
  },
  {
    id: "MU-3013",
    title:
      "MU-10C-13: WEB-10c A15 (D-10c-4): offline, a copied row is titled although its day is not on this device",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /MU-10C-13/,
    patch: (t) =>
      sub(
        t,
        "    return day ? row.task_title : null;",
        "    return row.task_title;",
      ),
  },
  // ---- dependencies ----------------------------------------------------------------------------------------------------------------
  {
    id: "MU-3014",
    title:
      "MU-10C-14: WEB-10c A14 (WEB-04 §5.7 item 4): complete_dependencies captures no defaults",
    file: "src/features/tasks/model/commands.ts",
    tests: ["tests/features/tasks/commands-10c.test.ts"],
    expect: /MU-10C-15\/14/,
    patch: (t) =>
      sub(
        t,
        '  const captured = capture(input.defaults, ["progress"]);\n  const root = input.occurrenceId;',
        "  const captured = capture(null, []);\n  const root = input.occurrenceId;",
      ),
  },
  {
    id: "MU-3015",
    title:
      "MU-10C-15: WEB-10c A9: complete_prerequisites raises none of the prerequisites' streams",
    file: "src/features/tasks/model/commands.ts",
    tests: ["tests/features/tasks/commands-10c.test.ts"],
    expect: /MU-10C-15/,
    patch: (t) =>
      sub(
        t,
        "        item.stream === null\n",
        "        item.stream === null || true\n",
      ),
  },
  {
    id: "MU-3016",
    title: "MU-10C-16: WEB-10c A8: Start anyway is offered under a strict rule",
    file: "src/features/tasks/model/dependencies.ts",
    tests: [
      "tests/features/tasks/dependency-model.test.ts",
      "tests/features/tasks/dependency-dialog.test.tsx",
    ],
    expect: /MU-10C-16/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3, R15): the same fault, the strict rule unread, over the root's admission.
        '    advisory_override: preview.strict ? "strict" : root,',
        "    advisory_override: root,",
      ),
  },
  {
    id: "MU-3017",
    title:
      "MU-10C-17: WEB-10c A10 (D-10c-7): the editor opens while something is private",
    file: "src/features/tasks/model/dependencies.ts",
    tests: ["tests/features/tasks/dependency-model.test.ts"],
    expect: /MU-10C-17/,
    patch: (t) =>
      sub(t, '  if (input.preview.unavailable) return "unavailable";\n', ""),
  },
  {
    id: "MU-3018",
    title:
      "MU-10C-18: WEB-10c D-10c-7: the editor starts from the transitive preview instead of empty",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /MU-10C-18/,
    patch: (t) =>
      // Re-anchored by WEB-18 (D-18-7): the editor's start is built from its own graph read in `build`; the same fault (the start taken
      // from the transitive preview) over the moved line.
      sub(
        t,
        "      list: keepList ? v.list : [...g.direct_prerequisites],",
        "      list: keepList\n        ? v.list\n        : preview\n          ? prerequisitesOf(preview, row.id).map((i) => i.occurrence_id)\n          : [],",
      ),
  },
  {
    id: "MU-3019",
    title:
      "MU-10C-19: WEB-10c A11: the conflict of set_dependencies names what was submitted",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /MU-10C-19/,
    patch: (t) =>
      sub(
        t,
        '      <p className="text-[13px] text-ink-1">{DEPENDENCY_COPY.setConflict}</p>',
        '      <p className="text-[13px] text-ink-1">{DEPENDENCY_COPY.setConflict}{" "}{draft ? String(commandOf(draft)?.prerequisites ?? "") : ""}</p>',
      ),
  },
  // ---- timers ----------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-3020",
    title:
      "MU-10C-20: WEB-10c A13 (CM-422): the timer conflict claims an overlap",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /MU-10C-20/,
    patch: (t) =>
      sub(
        t,
        '  conflictTitle: "This timer action couldn\'t be completed as sent.",',
        '  conflictTitle: "This timer overlaps another session.",',
      ),
  },
  {
    id: "MU-3021",
    title:
      "MU-10C-21: WEB-10c A14: a stop is checked against the occurrence's version, not the session's",
    file: "src/features/tasks/model/commands.ts",
    tests: ["tests/features/tasks/commands-10c.test.ts"],
    expect: /MU-10C-21/,
    patch: (t) =>
      sub(
        t,
        "          expected_version: bases[input.sessionId] as number,\n          stopped_at: input.stoppedAt,",
        "          expected_version: bases[input.occurrenceId] as number,\n          stopped_at: input.stoppedAt,",
      ),
  },
  {
    id: "MU-3022",
    title:
      "MU-10C-22: WEB-10c A12 (B6): a timer on another day withholds Start here (the pre-B6 rule)",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /MU-10C-22/,
    patch: (t) =>
      sub(
        t,
        '    if (s.access !== "available" || s.occurrence_id !== occurrenceId) continue;',
        '    if (s.access !== "available") continue;',
      ),
  },
  {
    id: "MU-3023",
    title:
      "MU-10C-23: WEB-10c A12: a stop beyond 7 days is sent as it is (no clamp, no choice)",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /MU-10C-23/,
    patch: (t) =>
      sub(
        t,
        "  if (stoppedAt - session.startedAt > SEVEN_DAYS)",
        "  if (stoppedAt - session.startedAt > SEVEN_DAYS * 1000)",
      ),
  },
  {
    id: "MU-3024",
    title: "MU-10C-24: WEB-10c A14: a start does not raise my stream",
    file: "src/features/tasks/model/commands.ts",
    tests: ["tests/features/tasks/commands-10c.test.ts"],
    expect: /MU-10C-24/,
    patch: (t) =>
      sub(
        t,
        '      {\n        resourceId: input.progressId,\n        role: "side_effect",\n        basis: "progress_stream",\n        versionChecked: true,\n        requiresEdit: true,\n        joinRequiresEdit: occurrenceId,\n        ...(input.firstAnyoneStream ? { seedIfUntracked: 1 } : {}),\n      },\n',
        "",
      ),
  },
  // ---- rotas -----------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-3026",
    title:
      "MU-10C-26: WEB-10c A17 (D-10c-9): an uncertain consent is retried with a new key",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /MU-10C-25\/26/,
    // Re-anchored (revision 8, R33): the attempt is taken by `memory.ts` `startRota`; the fault forgets the held one, so every send
    // (Try again included) is a new key.
    file: "src/features/tasks/memory.ts",
    patch: (t) =>
      sub(
        t,
        "  const next = nextAttempt(held, body, newKey);",
        "  const next = nextAttempt(null, body, newKey);",
      ),
  },
  {
    id: "MU-3027",
    title:
      "MU-10C-27: WEB-10c A17: an unsaved order is projected from the saved next turn (ignoring the reset)",
    file: "src/features/tasks/model/rota.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /MU-10C-27/,
    patch: (t) =>
      sub(
        t,
        "  const start = input.saved ? input.ordinal : 0;",
        "  const start = input.ordinal;",
      ),
  },
  {
    id: "MU-3028",
    title:
      "MU-10C-28: WEB-10c A17 (TASK-32): a task that is not Anyone offers a rota",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /MU-10C-28/,
    patch: (t) =>
      sub(
        t,
        '          {row.data.definition.participation === "anyone" ? (',
        "          {true ? (",
      ),
  },
  // ---- streak ----------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-3029",
    title:
      "MU-10C-29: WEB-10c A6: a figure the server could not give is shown as 0",
    file: "src/features/tasks/model/streak.ts",
    tests: [
      "tests/features/tasks/streak-model.test.ts",
      "tests/features/tasks/streak-page.test.tsx",
    ],
    expect: /MU-10C-29/,
    patch: (t) =>
      sub(
        t,
        '  if (value !== null) return { kind: "count", value };',
        '  return { kind: "count", value: value ?? 0 };',
      ),
  },
  {
    id: "MU-3031",
    title:
      "MU-10C-31: WEB-10c A5: a second materialisation_required in the visit is not a stop",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /MU-10C-31/,
    patch: (t) =>
      sub(
        t,
        '        if (visit.current.reread)\n          return { kind: "stopped", reason: "no_progress" };\n',
        "",
      ),
  },
  {
    id: "MU-3032",
    title:
      "MU-10C-32: WEB-10c A8 (PRODUCT-DECISIONS item 2): the root evidence entered is dropped from the completion",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /MU-10C-32/,
    patch: (t) =>
      sub(
        t,
        '        goal.kind === "checkbox" ? null : (rootEvidence?.evidence ?? null),',
        "        null,",
      ),
  },
  {
    id: "MU-3033",
    title:
      "MU-10C-33: WEB-10c A18 (CM-384): a preview answered for another identity is shown",
    file: "src/features/tasks/detail/usePreview.ts",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /MU-10C-33/,
    patch: (t) =>
      // The guard and the scope stamp are two defences of one rule; the fault removes both (the answer is kept as the current scope's).
      sub(
        t,
        // Re-anchored by revision 2 (the published read now carries its number, `seq`).
        "    if (latest.current === mine && current.current === asked)\n      setState({ scope: asked, read, seq: mine });\n",
        "    setState({ scope: current.current, read, seq: mine });\n",
      ),
  },
  {
    id: "MU-3034",
    title:
      "MU-10C-34: WEB-10c A7: the materialisation_required handler retries another slice's draft",
    file: "src/features/tasks/catchup/useCatchUp.ts",
    tests: ["tests/features/tasks/catchup-conflicts.test.ts"],
    expect: /the materialisation_required handler/,
    patch: (t) =>
      sub(
        t,
        '    if (!TASK_KINDS.has(draft.kind)) return { kind: "default" };\n',
        "",
      ),
  },
  {
    id: "MU-3035",
    title:
      "MU-10C-35: WEB-10c: a queued completion with its prerequisites carries no pending evidence",
    file: "src/features/tasks/model/commands.ts",
    tests: ["tests/features/tasks/commands-10c.test.ts"],
    expect: /MU-10C-35/,
    patch: (t) =>
      sub(
        t,
        '  if (draft.kind !== "complete_dependencies" || draft.account_id !== me)\n    return [];',
        "  if (true) return [];",
      ),
  },
  // ---- revision 1 (review of 25 October 2026, R1–R9): one or more per correction, each caught by the test written for it --------------
  {
    id: "MU-3036",
    title:
      "R1: WEB-10c A3: work paused part-way is dropped, not parked for resumption",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /R1: paused work resumes/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3): an ended binding's branch follows this one, so the fault keeps the statement and parks nothing.
        // Re-anchored (revision 10): parking carries the time its schedule admits; the fault still arms the wake and parks nothing.
        "        park(item, outcome.throughDate, outcome.at);\n",
        "        void item;\n",
      ),
  },
  {
    id: "MU-3037",
    title:
      "R1: WEB-10c A3: a read or store that throws part-way ends the sequence's work on this page",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /a read that throws part-way/,
    patch: (t) =>
      sub(
        t,
        "    } catch {\n      return paused;\n    }",
        "    } catch {\n      return DONE;\n    }",
      ),
  },
  {
    id: "MU-3062",
    title:
      "R1: WEB-10c A3: Today's next ensure does not take up the task's paused work",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /online again \(ensure\)/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the paused work is taken up, then the day asked is admitted on its own).
        "      const resumed = unpark(taskId);\n",
        "      const resumed = false;\n",
      ),
  },
  {
    id: "MU-3063",
    title:
      "R1: WEB-10c A3: a kick (connectivity, compatibility, binding) does not take up paused work",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /online again \(kick\)|not_sent|compatibility lost|throws part-way/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10): `reconnected` unparks too; the fault is the kick's own. Re-anchored (revision 11): the kick's lines
        // moved (it carries an unfinished reconnection scan on).
        "      rebind(service);\n      if (unpark()) publishQueue();\n      // Revision 11 (R36): a reconnection's scan",
        "      rebind(service);\n      // Revision 11 (R36): a reconnection's scan",
      ),
  },
  {
    id: "MU-3038",
    title:
      "R2: WEB-10c A15 (B6): a current complete read never supersedes an older copied session",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /R2/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3, R14): the read's complete observation is no longer one of those that retire.
        "  if (input.read !== null && input.complete === true && known(input.readOrder))\n    complete.push({ order: input.readOrder, lists: listed });\n",
        "",
      ),
  },
  {
    id: "MU-3039",
    title:
      "R3: WEB-10c A12/A15: the account list's Stop beyond 7 days records the first 7 days without asking",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /beyond 7 days, Stop queues nothing/,
    patch: (t) =>
      sub(
        t,
        '      if (choice.kind === "seven_days") {\n        setChoosing(row.id);\n        return;\n      }',
        '      if (choice.kind === "seven_days") {\n        await actions.enqueue(\n          stopTimer({ ...input, stoppedAt: choice.capped }),\n          TIMER_COPY.saved,\n        );\n        setAgain((n) => n + 1);\n        return;\n      }',
      ),
  },
  {
    id: "MU-3040",
    title:
      "R3: WEB-10c A15: a session whose stop is on its way is offered another Stop on the account list",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /a stop on its way/,
    patch: (t) =>
      sub(
        t,
        "      ...(ending.has(row.id) ? { pending: ending.get(row.id) } : {}),\n",
        "",
      ),
  },
  {
    id: "MU-3041",
    title:
      "R4: WEB-10c A10 (D-10c-7): Keep editing's save is admitted on connectivity alone",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect:
      /Keep editing on a day whose prerequisites became private|Keep editing on a day this person may no longer edit/,
    patch: (t) =>
      sub(
        t,
        "  const block = editorBlock({\n    online: env.online,",
        '  const block = replacing\n    ? env.online\n      ? null\n      : ("offline" as const)\n    : editorBlock({\n    online: env.online,',
      ),
  },
  {
    id: "MU-3042",
    title:
      "R4: WEB-10c A10 (D-10c-7): the editor admits a save on the preview it was opened from, not a fresh one",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /a NEW list opened from a preview that has since become private/,
    patch: (t) =>
      sub(t, "    preview: refreshed ? preview : null,\n", "    preview,\n"),
  },
  {
    id: "MU-3043",
    title:
      "R5: WEB-10c A17: a month without the anchor's day is clamped, not skipped",
    file: "src/features/tasks/model/rota.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /next dates are the server's/,
    patch: (t) =>
      sub(
        t,
        "      candidate = sd > last ? null : isoOf(year, month, sd);",
        "      candidate = isoOf(year, month, Math.min(sd, last));",
      ),
  },
  {
    id: "MU-3044",
    title:
      "R5: WEB-10c A17: daily dates are counted from the known day, not the schedule's start (off its grid)",
    file: "src/features/tasks/model/rota.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /stay on the schedule's grid/,
    patch: (t) =>
      sub(
        t,
        '    if (repeat.frequency === "daily") candidate = addDays(start, step);',
        '    if (repeat.frequency === "daily")\n      candidate = addDays(after, (out.length + 1) * n);',
      ),
  },
  {
    id: "MU-3045",
    title:
      "R6: WEB-10c A20 (F4): a completion's entries are named by the draft, not as the server names them",
    file: "src/features/tasks/model/commands.ts",
    tests: [
      "tests/features/tasks/freshness-provenance.test.tsx",
      "tests/features/tasks/streak-page.test.tsx",
    ],
    expect:
      /F4 for a completion|the completion's own entry in the stream|R6 \(history\)/,
    patch: (t) =>
      sub(
        t,
        "    const entryId = completionEntryId(draft.local_id, occurrenceId, me);",
        // The draft-and-day name of the first version (the "$" is split only so the source text is not read as a placeholder).
        "    const entryId: string | null = `$" +
          "{draft.local_id}:$" +
          "{occurrenceId}`;",
      ),
  },
  {
    id: "MU-3046",
    title:
      "R6: WEB-10c A6/A20 (F4): the streak strip layers evidence its synced stream already lists",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /the completion's own entry in the stream/,
    patch: (t) =>
      sub(
        t,
        "      const pending = pendingOn(ordered, me, day.id, state);",
        "      const pending = pendingOn(ordered, me, day.id, null);",
      ),
  },
  {
    id: "MU-3047",
    title:
      "R6: WEB-10c: the synchronous SHA-1 encodes the message length in bytes, not bits",
    file: "src/features/tasks/model/ids.ts",
    tests: ["tests/features/tasks/ids.test.ts"],
    expect: /dependency completion entry ids/,
    patch: (t) =>
      sub(
        t,
        "  view.setUint32(padded.length - 4, (length * 8) >>> 0);",
        "  view.setUint32(padded.length - 4, length >>> 0);",
      ),
  },
  {
    id: "MU-3048",
    title:
      "R7: WEB-10c A17 (TASK-15): an editor's empty eligibility list is taken as unknown",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /NO ONE eligible now/,
    patch: (t) =>
      sub(
        t,
        "    eligible: editor ? state.eligible_participants : null,",
        "    eligible:\n      state.eligible_participants.length > 0\n        ? state.eligible_participants\n        : null,",
      ),
  },
  {
    id: "MU-3049",
    title:
      "R8: WEB-10c A7: the task screens other than Today and the streak hold no catch-up service",
    file: "src/features/tasks/screens.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect:
      /the account's timers \(no catch-up shown there\) hold the service too/,
    patch: (t) =>
      sub(
        t,
        "  // directly opened detail, the list or the account's timers finds a runner for the displayed identity.\n  useCatchUpService();\n",
        "  // directly opened detail, the list or the account's timers finds a runner for the displayed identity.\n",
      ),
  },
  {
    id: "MU-3050",
    title:
      "R8: WEB-10c A7 (WEB-04 §5.8): a command on one day asks for no catch-up (its task and date are not derived)",
    file: "src/features/tasks/catchup/useCatchUp.ts",
    tests: ["tests/features/tasks/catchup-conflicts.test.ts"],
    expect: /A7:|a day's command|the materialisation_required handler/,
    patch: (t) =>
      sub(
        t,
        '  if (typeof command.occurrence_id === "string")\n    return { kind: "occurrence", occurrenceId: command.occurrence_id };\n',
        "",
      ),
  },
  {
    id: "MU-3060",
    title:
      "R8: WEB-10c A7 (WEB-04 §5.8): a stopped catch-up is not shown on the task's detail",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /a stopped catch-up of the task is shown on its detail/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the notice is keyed by the task and given the selected day).
        "      <CatchUpNotice\n        key={task.id}\n        taskId={task.id}\n        title={task.label}\n        day={row?.data.slot.date ?? undefined}\n      />\n",
        "",
      ),
  },
  {
    id: "MU-3061",
    title:
      "R9 (A18; CM-384): a rota answer asked under one identity is applied under another",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /A18: a late rota answer|A18 \(hook\): one reader/,
    // The guard alone is backed by the render-time scope check; the fault is an answer applied under the CURRENT scope.
    // Re-anchored (revision 3, R18): one owner and the render-time scope replace the identity ref; the fault applies an answer under
    // whatever identity is shown, so both go.
    patch: (t) =>
      sub(
        sub(t, "      if (owner.current !== mine) return;\n", ""),
        "  const value = state.scope === scope ? state : null;",
        "  const value = state;",
      ),
  },
  {
    id: "MU-3064",
    title:
      "I-10C-TM5 (rev 1): a refused draft's rebuilt SIDE EFFECT loses the base it seeded (refused no_base)",
    file: "src/data/model/review-confirmation.ts",
    tests: ["tests/data/outbox-defaults-review.test.ts"],
    expect:
      /confirmed by a supersession on the seeded base|the side effect version-checked with its recorded basis and its own base/,
    patch: (t) => sub(t, "      seedIfUntracked: base,\n", ""),
  },
  {
    id: "MU-3065",
    title:
      "I-10C-TM5 (rev 1): a refused draft's rebuilt version-checked PRIMARY loses the base it seeded (refused no_base)",
    file: "src/data/model/review-confirmation.ts",
    tests: ["tests/data/outbox-defaults-review.test.ts"],
    expect: /a version-checked PRIMARY it seeded/,
    patch: (t) =>
      sub(
        t,
        "      ...(base === undefined ? {} : { seedIfUntracked: base }),",
        "      ...(versionChecked || base === undefined\n        ? {}\n        : { seedIfUntracked: base }),",
      ),
  },

  // ---- revision 2 (review R10–R13; design assessment DA-T1, DA-T2, DA-M1) ---------------------------------------------------------
  {
    id: "MU-3066",
    title:
      "R10: WEB-10c A12/A15: the detail publishes an earlier read's answer (success or failure) over a newer one",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /REVIEW2 T2 \(ported\)|older read's FAILURE|old chain's page/,
    patch: (t) =>
      sub(
        t,
        "    if (owner.current !== link.owner || chain.current !== link) return;\n",
        "",
      ),
  },
  {
    id: "MU-3067",
    title:
      "R10: WEB-10c A15: the detail's Load more asks for the same further page twice",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /a second press asks for one page/,
    patch: (t) =>
      sub(
        t,
        "        held.next !== after ||\n        held.loading\n",
        "        held.next !== after\n",
      ),
  },
  {
    id: "MU-3068",
    title:
      "R11: WEB-10c A12/A13: a running session on a page that is not the last is not known (the pre-revision rule)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /REVIEW2 T1 \(ported\)|STOPPED ends it/,
    patch: (t) =>
      sub(
        t,
        "    read: day.sessions,\n",
        "    read: day.complete ? day.sessions : null,\n",
      ),
  },
  {
    id: "MU-3069",
    title:
      "DA-T1: WEB-10c A15 (D-10c-4): a complete day read retires the cancelled session on screen only, never in the kept copy",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /the cancelled session leaves the copy/,
    patch: (t) =>
      sub(
        t,
        "    if (read !== null && data.service() === read.service)\n      void commitTimerCorrection(",
        "    if (false as boolean)\n      void commitTimerCorrection(",
      ),
  },
  {
    id: "MU-3070",
    title:
      "DA-T1: WEB-10c W29: a replacement is compared with the copy alone, not the fence a day's correction moved",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /DA-T1: a day's correction|removes it on null/,
    patch: (t) =>
      sub(
        t,
        "    if (copy !== null && copy.order <= floor)\n",
        "    if (copy !== null && copy.order <= (stored?.order ?? 0))\n",
      ),
  },
  {
    id: "MU-3071",
    title:
      "DA-T2: WEB-10c W29: two reads are ordered by the device clock of their issue (the pre-revision rule)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /DA-T2|keeps a copy of a LATER order/,
    patch: (t) =>
      sub(
        t,
        "    if (copy !== null && copy.order <= floor)\n",
        "    if (copy !== null && stored !== null && stored.read_at > copy.read_at)\n",
      ),
  },
  {
    id: "MU-3072",
    title:
      "DA-T2: WEB-10c A15: a complete read of the copy's own order (a tie) retires a copied session",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /no tie decides/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3): one rule compares every complete observation with the order a session was seen at.
        "complete.some((o) => o.order > order && !o.lists.has(id))",
        "complete.some((o) => o.order >= order && !o.lists.has(id))",
      ),
  },
  {
    id: "MU-3073",
    title:
      "R10: WEB-10c A15: the account list publishes an earlier read's answer over a newer one (and keeps it)",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /REVIEW2 T3 \(ported\)|reconnect and Retry|old read's further page/,
    patch: (t) =>
      sub(
        t,
        "    if (owner.current !== link.owner || chain.current !== link) return;\n",
        "",
      ),
  },
  {
    id: "MU-3074",
    title:
      "R10: WEB-10c A15: the account list is not read again when a stop of mine moves on or leaves the outbox",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /leaving the outbox/,
    patch: (t) =>
      sub(
        t,
        '  const again = `${asked}|${drafts.map((d) => `${d.local_id}:${d.status}`).join(",")}`;',
        "  const again = String(asked);",
      ),
  },
  {
    id: "MU-3075",
    title:
      "R12: WEB-10c A9/A11: the remembered mode is offered as chosen, whatever the current preview allows",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect:
      /REVIEW2 D1 \(ported\)|REVIEW2 D2 \(ported\)|remembered plain completion/,
    patch: (t) =>
      sub(
        t,
        '      : (admittedMode(preview, row.id, rootCompletable, mode) ?? "wait");',
        "      : mode;",
      ),
  },
  {
    id: "MU-3076",
    title:
      "R12: WEB-10c A9: the send does not check again after its own awaits",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /the preview changing while the send prepares \((strict|token)\)/,
    patch: (t) =>
      sub(
        t,
        "        after.seq !== at.seq ||\n        after.identity !== at.identity ||\n        after.service !== at.service ||\n        !admits(after, chosen)\n",
        "        false as boolean\n",
      ),
  },
  {
    id: "MU-3077",
    title:
      "R12: WEB-10c A9: a newer preview answer during the send's preparation is not noticed when it still admits the mode",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /the preview changing while the send prepares \(token\)/,
    patch: (t) => sub(t, "        after.seq !== at.seq ||\n", ""),
  },
  {
    id: "MU-3078",
    title:
      "R12: WEB-10c A9: the dialog acts on the preview shown before its own opening read answered",
    file: "src/features/tasks/detail/Dependencies.tsx",
    tests: ["tests/features/tasks/dependency-dialog.test.tsx"],
    expect: /the read it asked when it opened/,
    patch: (t) =>
      sub(
        t,
        "  const fresh = opening !== null && state.seq >= opening;",
        "  const fresh = opening === opening;",
      ),
  },
  {
    id: "MU-3079",
    title:
      "R13: WEB-10c A19: a recorded discovery stop admits automatic reads again",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect:
      /REVIEW2 M1 \(ported\)|definite refusal of the first read|a reload \(another runner/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revisions 3 and 5).
        "    if (entry?.stop) {\n",
        "    if (false as boolean && entry?.stop) {\n",
      ),
  },
  {
    id: "MU-3080",
    title:
      "DA-M1: WEB-10c A19: a discovery taken up again (a pause, a reload) does not carry on from its recorded count",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /a pause between uncertain reads|a reload \(another runner/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3, R16): the read is admitted over the entry; the fault admits it from a zero count.
        // Re-anchored (revision 10, Decision B): the count is the entry's schedule; the fault admits the read from none.
        '      failures: s?.failures ?? base.failures,\n      attempt: deps.newId(),\n      schedule: issue(s, "discovery", now),',
        '      failures: 0,\n      attempt: deps.newId(),\n      schedule: issue(null, "discovery", now),',
      ),
  },
  {
    id: "MU-3081",
    title:
      "R13: WEB-10c A19: Try again does not move the retry generation, so a second press admits a second budget",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /two Try again presses/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3).
        // Re-anchored (revision 10): the lifted entry is `liftedDiscovery`'s.
        "    retry: seen.retry + 1,\n",
        "    retry: seen.retry,\n",
      ),
  },
  {
    id: "MU-3082",
    title:
      "R13: WEB-10c A19: a stop kept in page memory (its record failed) admits automatic work",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /cannot be written/,
    patch: (t) =>
      sub(
        sub(
          t,
          // Re-anchored (revision 3).
          "    if (state.unrecorded.has(item.taskId)) return end(DONE);\n",
          "",
        ),
        // Re-anchored (revision 6: the admission of a day asked is its own function).
        "    if (state.unrecorded.has(taskId)) return false;\n",
        "",
      ),
  },
  {
    id: "MU-3083",
    title:
      "R13: WEB-10c A5: the streak reads past a stopped discovery as if the catch-up had finished",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    // Revision 5: while the task's day is unknown the streak waits anyway; the stop must still hold once the day is known.
    expect:
      /the streak shows the recorded stop|a stop another page records AFTER this page knew the task's day/,
    patch: (t) => sub(t, "      discovery[taskId]?.stop != null ||\n", ""),
  },
  {
    id: "MU-3084",
    title:
      "R13: WEB-10c A1/A19: a recorded discovery stop is not shown (another page's, or after a reload)",
    file: "src/features/tasks/today/CatchUpBanner.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /Today shows another page's stop|the task's detail shows it too/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 5: `stopsFor`).
        "  if (found?.stop)\n    return [",
        "  if (false as boolean && found?.stop)\n    return [",
      ),
  },
  {
    id: "MU-3085",
    title:
      "R15: WEB-10c A9: Mark done is offered and sent without the root's own admission",
    file: "src/features/tasks/model/dependencies.ts",
    tests: [
      "tests/features/tasks/dependency-model.test.ts",
      "tests/features/tasks/dependency-dialog.test.tsx",
    ],
    expect:
      /REVIEW3 D3 \(ported\)|modesOf: without the root|numeric root with nothing entered|admittedMode: no mode/,
    patch: (t) =>
      sub(
        t,
        '    require_satisfied: !satisfiedPreview(preview, rootId) ? "open" : root,',
        '    require_satisfied: !satisfiedPreview(preview, rootId) ? "open" : null,',
      ),
  },
  {
    id: "MU-3086",
    title:
      "R15: WEB-10c A9: Start anyway is offered and sent without the root's own admission",
    file: "src/features/tasks/model/dependencies.ts",
    tests: [
      "tests/features/tasks/dependency-model.test.ts",
      "tests/features/tasks/dependency-dialog.test.tsx",
    ],
    expect:
      /REVIEW3 D3 \(ported\)|modesOf: without the root|admittedMode: no mode|refused advisory_override/,
    patch: (t) =>
      sub(
        t,
        '    advisory_override: preview.strict ? "strict" : root,',
        '    advisory_override: preview.strict ? "strict" : null,',
      ),
  },
  {
    id: "MU-3087",
    title:
      "R15: WEB-10c A9: a numeric or checklist root is admitted by its can_complete (a tick its goal refuses)",
    file: "src/features/tasks/model/dependencies.ts",
    tests: ["tests/features/tasks/dependency-model.test.ts"],
    expect: /rootAdmitted/,
    patch: (t) =>
      sub(
        t,
        '  return goalKind === "checkbox" ? root.can_complete : evidence;',
        '  return goalKind === "checkbox" ? root.can_complete : evidence || root.can_complete;',
      ),
  },
  {
    id: "MU-3088",
    title:
      "R18: WEB-10c A17/A18: the rota shows any answer of the same task and identity, an earlier read's included",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /REVIEW3 R4|FAILS after a later one|the enrolment is the same pair/,
    patch: (t) => sub(t, "      if (owner.current !== mine) return;\n", ""),
  },
  {
    id: "MU-3089",
    title:
      "R18: WEB-10c A17: going offline (or any new read) does not move the rota's owner",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /going offline invalidates|REVIEW3 R4-P/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    owner.current += 1;\n    const mine = owner.current;",
          "    const mine = owner.current;",
        ),
        "    return () => {\n      owner.current += 1;\n    };\n  }, [scope, env.online, again]);",
        "  }, [scope, env.online, again]);",
      ),
  },
  {
    id: "MU-3090",
    title:
      "R14: WEB-10c A15: a later complete account copy never retires what an earlier day read saw",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect:
      /REVIEW3 T4 \(ported\)|REVIEW3 T4's rule|every row reads, none is this session/,
    patch: (t) =>
      sub(
        t,
        "  if (\n    input.copy !== null &&\n    input.copyComplete === true &&\n    known(input.copyOrder)\n  )\n    complete.push({\n      order: input.copyOrder,\n      lists: new Set(input.copy.map((s) => s.id)),\n    });\n",
        "",
      ),
  },
  {
    id: "MU-3091",
    title:
      "R14: WEB-10c A15: a copy whose rows did not all read still counts as complete (absence from what was lost)",
    file: "src/features/tasks/timers/copy.ts",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /a row of it does not read/,
    patch: (t) =>
      sub(
        t,
        "    complete: copy.complete && !lost,",
        "    complete: copy.complete,",
      ),
  },
  {
    id: "MU-3092",
    title:
      "DA-T3: WEB-10c A15: a later complete read of the day in another page is not consulted",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /DA-T3/,
    patch: (t) =>
      sub(
        t,
        "  if (input.scope && input.scope.order > 0)\n    complete.push({\n      order: input.scope.order,\n      lists: new Set(input.scope.running),\n    });\n",
        "",
      ),
  },
  {
    id: "MU-3093",
    title:
      "DA-T3: WEB-10c A15: a day read issued before the floor is still trusted for a running session",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /the floor/,
    patch: (t) =>
      sub(
        t,
        "    if (!readTrusted || retired(s.id, input.readOrder)) continue;",
        "    if (retired(s.id, input.readOrder)) continue;",
      ),
  },
  {
    id: "MU-3094",
    title:
      "DA-T3: WEB-10c A15: a read kept under another database incarnation stands",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /a kept read belongs/,
    patch: (t) =>
      sub(
        t,
        "  (kept.incarnation === null || bound === null || kept.incarnation === bound);",
        "  true;",
      ),
  },
  {
    id: "MU-3095",
    title:
      "DA-T3: WEB-10c W29: a day's observation is recorded although its growth was not admitted",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /growth the quota ledger refused/,
    patch: (t) =>
      sub(t, "      if (admitted) {", "      if (true as boolean) {"),
  },
  {
    id: "MU-3096",
    title:
      "DA-T3: WEB-10c W29: an evicted day's observation is dropped without raising the floor",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /at most 100 days/,
    patch: (t) =>
      sub(t, "      floor = Math.max(floor, out[id]?.seen ?? 0);\n", ""),
  },
  {
    id: "MU-3097",
    title:
      "R16: WEB-10c W28: a new task's discovery entry is written although the quota ledger refused it",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /admitted, not capped/,
    patch: (t) =>
      sub(t, "        (input.admitted === false ||", "        (false ||"),
  },
  {
    id: "MU-3098",
    title:
      "R16: WEB-10c A19: a first read whose record was not admitted is sent anyway",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /the quota ledger refuses the task's record/,
    patch: (t) =>
      sub(
        t,
        '    if (admitted === "refused")\n      return end(stopInMemory(item.taskId, { reason: "storage" }));\n',
        "",
      ),
  },
  {
    id: "MU-3099",
    title:
      "R16: WEB-10c W28: an answer is recorded over another page's admitted read (the attempt is not compared)",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /only over its own admitted attempt|two pages without Web Locks/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10): the schedule is compared after it.
        "      (a.stop === null) === (b.stop === null) &&\n      (a.attempt ?? null) === (b.attempt ?? null) &&\n",
        "      (a.stop === null) === (b.stop === null) &&\n",
      ),
  },
  {
    id: "MU-3100",
    title:
      "R17: WEB-10c A19: a discovery answer is recorded through whichever service is displayed when it lands (revision 2's fault)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /REVIEW3 M3 \(ported\)|of the ended binding writes nothing/,
    patch: (t) =>
      sub(
        sub(
          t,
          "!disposed && at.service.live && deps.service() === at.service;",
          "!disposed && deps.service() !== null;",
        ),
        "      const out = await commitMaterialiseDiscovery(\n        at.service,\n        captured,\n        { task_id: item.taskId, expected: entry, next },",
        "      const out = await commitMaterialiseDiscovery(\n        (deps.service() ?? at.service),\n        (deps.service() ?? at.service).capture(deps.epoch),\n        { task_id: item.taskId, expected: entry, next },",
      ),
  },
  {
    id: "MU-3101",
    title:
      "R17: WEB-10c A19: a Try again pressed under an ended binding lifts the replacement's stop",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /Try again pressed under the ended binding/,
    // Re-anchored (revision 10): the press is taken off the item before its lift is tried. Revision 12: the press and a reconnection's
    // lift beside it are both filtered by their binding; the same fault (the binding not compared).
    patch: (t) =>
      sub(
        t,
        "      (r): r is Retry => r !== undefined && r.service === service,",
        "      (r): r is Retry => r !== undefined,",
      ),
  },
  // ---- revision 4 (review 4 R19-R22, design assessment of 27 October 2026): one fault per new guard ---------------------------
  {
    id: "MU-3102",
    title:
      "R19: WEB-10c A15: offline, the account list shows the raw copy, unjudged by the day scopes and the floor",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /REVIEW4 T5 \(ported\)|below the floor a copied row/,
    patch: (t) =>
      sub(
        t,
        "(copied?.rows ?? []).filter((r) => stands(r, copied?.order ?? null))",
        "(copied?.rows ?? []).filter((r) => true || stands(r, copied?.order ?? null))",
      ),
  },
  {
    id: "MU-3103",
    title:
      "R19: WEB-10c A15: online, the account list shows its live rows unjudged by a later day read",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /online: a later complete read/,
    patch: (t) =>
      sub(
        t,
        "running.value.rows.filter((r) =>",
        "running.value.rows.filter((r) => true ||",
      ),
  },
  {
    id: "MU-3104",
    title:
      "R19: WEB-10c A15: a session the page's own history lists stopped is still shown running",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    // Revision 5: the durable finished record hides it too; the page's own history still must when that record cannot be written.
    expect: /history has listed stopped|the store fails it/,
    patch: (t) => sub(t, "    !stopped.has(row.id) &&\n", ""),
  },
  {
    id: "MU-3105",
    title:
      "R19: WEB-10c A12/A15: a Stop queued after its row was retired while the act waited",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /is retired while the act waits/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 5: the whole re-check after the act's waits).
        "        order === undefined ||\n        stored === undefined ||\n        !stillRunning(authorityOf(stored), row.occurrence_id, row.id, order) ||\n        !standing.current.has(row.id)\n      ) {",
        "        false as boolean\n      ) {",
      ),
  },
  {
    id: "MU-3106",
    title:
      "R19: WEB-10c A15: the floor is not the copy's rule (the detail keeps a copied session below it)",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /the floor|REVIEW4 T6 \(ported\)|a copy below the floor/,
    patch: (t) =>
      sub(
        t,
        "    if (!copyTrusted || s.stopped_at !== null",
        "    if (s.stopped_at !== null",
      ),
  },
  {
    id: "MU-3107",
    title:
      "R19: WEB-10c A15: an unread authority is taken as no corrections (every ordered positive stands)",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /authority not read yet/,
    patch: (t) =>
      sub(
        t,
        "  if (authority === null) return order === null;",
        "  if (authority === null) return true;",
      ),
  },
  {
    id: "MU-3108",
    title:
      "R19: WEB-10c A15: a day read of the SAME order retires a session it does not list",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /its day's read is not later/,
    patch: (t) =>
      sub(t, "    scope.order > order &&", "    scope.order >= order &&"),
  },
  {
    id: "MU-3109",
    title:
      "R19: WEB-10c A15: a day's correction is fenced out by a later read of ANOTHER day (the copy keeps the session)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /REVIEW4 T5 at the plan/,
    patch: (t) =>
      sub(
        t,
        "    const fence = floorOf(sync);\n    const stored = parseTimerCopy(sync.timer_copy ?? null);",
        "    const fence = floorOf(sync);\n    if (input.order < fence)\n      return {\n        ...(next === sync ? {} : { sync: next }),\n        result: { removed: 0, applied: false, scoped },\n      };\n    const stored = parseTimerCopy(sync.timer_copy ?? null);",
      ),
  },
  {
    id: "MU-3110",
    title:
      "R19: WEB-10c A15: an earlier day's correction moves the fence back (an older account read replaces the copy)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /REVIEW4 T5 at the plan/,
    patch: (t) =>
      sub(
        t,
        "        timer_fence: Math.max(fence, input.order),",
        "        timer_fence: input.order,",
      ),
  },
  {
    id: "MU-3111",
    title:
      "R19: WEB-10c A15: the authority drops an unreadable scope without raising the floor",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /one snapshot/,
    patch: (t) =>
      sub(t, "    else floor = Math.max(floor, lostAt(value, issued));\n", ""),
  },
  {
    id: "MU-3112",
    title:
      "R19: WEB-10c A15: a scopes map that is not a map is read as none recorded (no floor)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /one snapshot/,
    patch: (t) =>
      sub(
        t,
        "  raw !== undefined && raw !== null && !isObject(raw) ? issued : 0;",
        "  0;",
      ),
  },
  {
    id: "MU-3113",
    title:
      "R20: WEB-10c A3/A19: the sequence compare-and-set ignores the revision (a later stop passes as the one pressed on)",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect:
      /REVIEW4 M4 \(ported\)|presses carrying the stop shown|attempt key and revision/,
    patch: (t) =>
      sub(
        t,
        "    sequenceRevision(stored) === sequenceRevision(expected)",
        "    true",
      ),
  },
  {
    id: "MU-3114",
    title:
      "R20: WEB-10c A3/A19: a sequence write keeps the caller's revision instead of moving it",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect:
      /REVIEW4 M4 \(ported\)|every write moves the revision|presses carrying the stop shown/,
    patch: (t) =>
      sub(
        t,
        "    const row: MaterialiseSequenceRow = { ...next, revision: revision + 1 };",
        "    const row: MaterialiseSequenceRow = { ...next };",
      ),
  },
  {
    id: "MU-3115",
    title:
      "R20: WEB-10c A19: a lift writes the sequence although the discovery it was pressed on no longer stands",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /a lift writes both stops or neither/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the expectation is tagged; the stopped one is compared as before).
        "      if (!(input.task_id in entries) || !sameDiscovery(current, lift.expected))",
        "      if (!(input.task_id in entries) || false)",
      ),
  },
  {
    id: "MU-3116",
    title:
      "R20: WEB-10c A19: a press naming an earlier stop lifts the later one stored now",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /a genuinely later press/,
    patch: (t) =>
      sub(
        t,
        "        (sequence.revision ?? 0) === seen.revision",
        "        true",
      ),
  },
  {
    id: "MU-3117",
    title:
      "R20: WEB-10c A1/A19: Today's Try again does not name the stop it was pressed on",
    file: "src/features/tasks/today/CatchUpBanner.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /names the stop it was pressed on Today's banner/,
    patch: (t) =>
      sub(
        t,
        "runner.tryAgain(stop.taskId, stop.throughDate, stop.seen)",
        "runner.tryAgain(stop.taskId, stop.throughDate)",
      ),
  },
  {
    id: "MU-3118",
    title:
      "R20: WEB-10c A19: the detail's Try again does not name the stop it was pressed on",
    file: "src/features/tasks/catchup/CatchUpNotice.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /names the stop it was pressed on the task's detail/,
    patch: (t) =>
      sub(
        t,
        "runner.tryAgain(taskId, stop.throughDate, stop.seen)",
        "runner.tryAgain(taskId, stop.throughDate)",
      ),
  },
  {
    id: "MU-3119",
    title:
      "R21: WEB-10c A1/A19: a task's FIRST day is read as its latest (a later day's stop or progress hidden)",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    // Re-anchored (revision 5: the task's latest days are read from its end).
    expect: /the exact day past any number/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the window's length may be asked for).
        "              Math.max(0, n - limit),\n",
        "              0,\n",
      ),
  },
  {
    id: "MU-3120",
    title:
      "R22: WEB-10c A6/A18: a held streak read publishes whatever happened since it was asked (only the identity is checked)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /REVIEW4 S1 \(ported\)|a held 409 released once offline/,
    patch: (t) =>
      sub(
        t,
        "        if (!mine.live || owner.current !== mine || identity.current !== asked)",
        "        if (identity.current !== asked)",
      ),
  },
  // ---- revision 5 (review 5 R23-R26) -------------------------------------------------------------------------------------
  {
    id: "MU-3121",
    title:
      "R23: WEB-10c A12/A15: the account's later complete observation does not retire a running row it omits",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timers-page.test.tsx",
    ],
    expect:
      /REVIEW5 T7 \(ported\)|the account's later complete observation omits it/,
    patch: (t) =>
      sub(
        t,
        "    account != null &&\n    account.order > order &&",
        "    false as boolean &&\n    account != null &&\n    account.order > order &&",
      ),
  },
  {
    id: "MU-3122",
    title:
      "R23: WEB-10c A12/A15: a session any read listed finished still runs for the account's list (its history forgotten)",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timers-page.test.tsx",
    ],
    expect:
      /REVIEW5 T8 \(ported\)|listed finished by any read|a restricted session the history lists stopped/,
    patch: (t) =>
      sub(t, "  if (authority.ended?.has(sessionId)) return false;\n", ""),
  },
  {
    id: "MU-3123",
    title:
      "R23: WEB-10c A15: once a finished session was lost, a positive of unknown order is still trusted",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /a finished session lost: not trusted/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the loss rule is shared, `positiveTrusted`; the same fault in this resolver's use of it).
        "  if (!positiveTrusted(authority, order)) return false;",
        "  if (order !== null && !positiveTrusted(authority, order)) return false;",
      ),
  },
  {
    id: "MU-3124",
    title:
      "R23: WEB-10c A15: the detail keeps running a session the account's history listed finished",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect:
      /the account's history recorded it finished|listed finished by any read/,
    patch: (t) => sub(t, "    ...(input.ended ?? []),\n", ""),
  },
  {
    id: "MU-3125",
    title:
      "R23: WEB-10c A15: the detail trusts a read of unknown order after a finished session was lost",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /a finished session lost: not trusted/,
    // Re-anchored (revision 6: the loss rule is shared; the same fault in this resolver's use of it).
    patch: (t) =>
      sub(
        t,
        "    positiveTrusted(input, known(order) ? order : null);",
        "    known(order) ? positiveTrusted(input, order) : true;",
      ),
  },
  {
    id: "MU-3126",
    title:
      "R23: WEB-10c A12/A15: a later PARTIAL first page erases what the complete observation proved",
    file: "src/data/plans/timer-copy.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/timers-page.test.tsx",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect:
      /never the observation|a later PARTIAL first page|then a PARTIAL one/,
    patch: (t) =>
      sub(
        t,
        "        ...account,\n",
        "        ...(copy?.complete ? account : { timer_account: null }),\n",
      ),
  },
  {
    id: "MU-3127",
    title:
      "R23: WEB-10c A15: the history's finished sessions are left in the copy",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /history's finished sessions are recorded/,
    patch: (t) =>
      sub(
        t,
        "    const out = copyWithout(sync, new Set(ids));",
        "    const out = null as ReturnType<typeof copyWithout>;",
      ),
  },
  {
    id: "MU-3128",
    title:
      "R23: WEB-10c A15: a finished record the quota ledger refused records no loss",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /history's finished sessions are recorded/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the refused record also carries its inclusive bound).
        "        timer_ended: ended?.ended ?? {\n          ...held.ended,\n          lost: true,\n          through: Math.max(held.ended.through, high),\n        },",
        "        timer_ended: ended?.ended ?? held.ended,",
      ),
  },
  {
    id: "MU-3129",
    title:
      "R23: WEB-10c A15: a finished session evicted beyond the bound raises no floor",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /beyond the bound the one recorded longest ago goes/,
    patch: (t) => sub(t, "    floor = Math.max(floor, gone[1]);\n", ""),
  },
  {
    id: "MU-3130",
    title:
      "R23: WEB-10c A15: a day's read does not record its finished sessions for the account",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /a day's read records the sessions it listed finished/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: recorded at the high-water).
        "          finished.length === 0 ? null : withEnded(held.ended, finished, high);",
        "          null;",
      ),
  },
  {
    id: "MU-3131",
    title:
      "R23: WEB-10c A15: a page of the account's history records nothing (its finished sessions known to this page alone)",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect:
      /REVIEW5 T8 \(ported\)|a restricted session the history lists stopped|listed stopped on a LATER page/,
    patch: (t) =>
      sub(
        t,
        "        void commitTimerEnded(data, history.service, history.captured, ids);",
        "        void ids;",
      ),
  },
  {
    id: "MU-3132",
    title:
      "R23: WEB-10c A12/A15: an act re-checks only what the screen rendered, not the authority stored by then",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect:
      /a Stop whose session is recorded finished while the act waits|the 7-day question/,
    patch: (t) =>
      sub(
        t,
        "        !stillRunning(authorityOf(stored), row.occurrence_id, row.id, order) ||",
        "        false ||",
      ),
  },
  {
    id: "MU-3133",
    title:
      "R25: WEB-10c A3/A4 (WEB-04 §5.8): another day's row is removed without its need being covered",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /REVIEW5 M7 \(ported\)|a later day it does not cover stays/,
    patch: (t) =>
      sub(
        t,
        "        satisfied(position, row.through_date, today),",
        "        true,",
      ),
  },
  {
    id: "MU-3134",
    title:
      "R25: WEB-10c A3/A4: a satisfied row is removed though another page changed it since",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /satisfied rows are removed only as decided on/,
    patch: (t) =>
      sub(
        t,
        "      matchesExpectation(reads[i], row.expected),",
        "      reads[i] !== undefined,",
      ),
  },
  {
    id: "MU-3135",
    title:
      "R25: WEB-10c A3: a new day's row is written without the quota ledger's admission",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /a new day's row the quota ledger refused/,
    patch: (t) =>
      sub(
        t,
        "      { key, expected: null, next },\n      quota === null ? null : { quota },",
        "      { key, expected: null, next },\n      null,",
      ),
  },
  {
    id: "MU-3136",
    title:
      "R25: WEB-10c A3: a new row the ledger did not admit is written anyway",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /a NEW row is admitted/,
    patch: (t) =>
      sub(
        t,
        "    if (\n      reads === undefined &&\n      (input.admitted === false ||",
        "    if (\n      false as boolean &&\n      reads === undefined &&\n      (input.admitted === false ||",
      ),
  },
  {
    id: "MU-3137",
    title:
      "R24: WEB-10c A1/A19: the recovery read reports a task's latest days as all of them",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /the exact day past any number/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the window's length may be asked for).
        "        complete: n <= limit,",
        "        complete: true,",
      ),
  },
  {
    id: "MU-3138",
    title:
      "R24: WEB-10c A1/A19: Today shows its task's LATEST day in place of the day it works for (a horizon stop hides it)",
    file: "src/features/tasks/today/CatchUpBanner.tsx",
    tests: [
      "tests/features/tasks/catchup-banner.test.tsx",
      "tests/features/tasks/streak-page.test.tsx",
    ],
    expect:
      /REVIEW5 M6 \(ported\)|a later horizon stop beside today's bound stop/,
    // Re-anchored (revision 6: the exact days are added between the two).
    patch: (t) =>
      sub(
        sub(
          t,
          "  if (target !== undefined && found.target) rows.push(found.target);\n",
          "  const last = found.rows[found.rows.length - 1];\n  if (last) rows.push(last);\n",
        ),
        "  if (target === undefined || every) for (const row of found.rows) add(row);",
        "  if (every) for (const row of found.rows) add(row);",
      ),
  },
  {
    id: "MU-3139",
    title:
      "R24: WEB-10c A1: the zone a read found is not published, so no screen knows the exact day",
    file: "src/features/tasks/catchup/runner.ts",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /once its day is known, Today shows that day's stop/,
    patch: (t) =>
      sub(
        t,
        "    if (state.zones.get(taskId) === zone) return;",
        "    return;",
      ),
  },
  {
    id: "MU-3140",
    title:
      "R24: WEB-10c A1/A3: another day of a task asked while one is worked on is absorbed",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /two days asked together/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 6: the admission of a day asked is its own function).
        "    if (pending(workKey({ taskId, throughDate }))) return false;",
        "    if (queue.some((q) => q.taskId === taskId) || state.current === taskId)\n      return false;",
      ),
  },
  {
    id: "MU-3141",
    title:
      "R26: WEB-10c A18/A19: a discovery press is matched by its retry alone (a later stop of a reset counter lifted)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /REVIEW5 M8 \(ported/,
    patch: (t) =>
      sub(
        t,
        "        discovery.retry === token.retry &&\n        (discovery.attempt ?? null) === (token.attempt ?? null);",
        "        discovery.retry === token.retry;",
      ),
  },
  {
    id: "MU-3142",
    title:
      "R26: WEB-10c A19: a day's stop press lifts a discovery stop recorded after the screen showed none",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /shown without one: a discovery stop recorded since is not lifted/,
    patch: (t) =>
      sub(t, "        stands(seen.discovery ?? null)", "        true"),
  },
  {
    id: "MU-3143",
    title:
      "R26: WEB-10c A19: a press on an earlier memory stop lifts the one held now",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /a memory stop's press names it/,
    patch: (t) =>
      sub(t, "      return memory?.id === seen.id\n", "      return true\n"),
  },
  {
    id: "MU-3144",
    title:
      "R26: WEB-10c A19: a press made where no stop was shown lifts a stop that stands since",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /a stop stands since: nothing is lifted or asked/,
    patch: (t) =>
      sub(
        t,
        "      return !discovery?.stop && sequence === null && memory === undefined\n",
        "      return true\n",
      ),
  },
  {
    id: "MU-3145",
    title:
      "R26: WEB-10c A19: a discovery stop written before claims is never given one (its press names no identity)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [
      "tests/features/tasks/materialise-model.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /a discovery stop written before claims/,
    patch: (t) =>
      sub(
        t,
        "      if ((entry.attempt ?? null) === null)",
        "      if (false as boolean)",
      ),
  },
  {
    id: "MU-3146",
    title:
      "R27: WEB-10c A15: a lost finished session distrusts only positives strictly BELOW its order (the one at it stays running)",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /terminal loss n, positive n: at the bound|REVIEW6 T9/,
    patch: (t) =>
      sub(
        t,
        "  return !(through > 0 && order <= through);",
        "  return !(through > 0 && order < through);",
      ),
  },
  {
    id: "MU-3147",
    title:
      "R27: WEB-10c A15: a day read's refused finished sessions are lost only through its own order (a later running read in flight stays trusted)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /a day read at i refused with a finished session/,
    patch: (t) =>
      sub(
        t,
        "      const high = Math.max(highWater(sync), input.order);",
        "      const high = input.order;",
      ),
  },
  {
    id: "MU-3148",
    title:
      "R27: WEB-10c A15: a lost complete observation distrusts the positive AT its order too (absence made inclusive)",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /absence lost at n \(floor\), positive n: trusted/,
    patch: (t) =>
      sub(
        t,
        "  if (loss.floor !== undefined && order < loss.floor) return false;",
        "  if (loss.floor !== undefined && order <= loss.floor) return false;",
      ),
  },
  {
    id: "MU-3149",
    title: "R27: WEB-10c A15: the detail is not given the terminal-loss bound",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /REVIEW6 T9/,
    patch: (t) =>
      sub(t, "    endedThrough: evidence.authority?.endedThrough ?? 0,\n", ""),
  },
  {
    id: "MU-3150",
    title:
      "R27: WEB-10c A15: the stored authority carries no terminal-loss bound (the account's list and the act's re-check)",
    file: "src/features/tasks/timers/copy.ts",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /R27: the account's list at the loss boundary/,
    patch: (t) => sub(t, "    endedThrough: record.endedThrough,\n", ""),
  },
  {
    id: "MU-3151",
    title:
      "R27: WEB-10c A15: a finished session evicted from the bound leaves no inclusive loss",
    file: "src/data/plans/timer-copy.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /eviction: lost through the order|REVIEW6 T9/,
    patch: (t) => sub(t, "    through = Math.max(through, gone[1]);\n", ""),
  },
  {
    id: "MU-3152",
    title:
      "R27: WEB-10c A15: the history's refused finished record leaves no inclusive loss",
    file: "src/data/plans/timer-copy.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /refused history growth|REVIEW6 T9/,
    patch: (t) =>
      sub(
        t,
        "          lost: true,\n          through: Math.max(held.ended.through, high),\n        },\n        timer_scope_floor",
        "          lost: true,\n          through: held.ended.through,\n        },\n        timer_scope_floor",
      ),
  },
  {
    id: "MU-3153",
    title:
      "R27: WEB-10c A15: a finished record written before revision 6 is never settled (its bound moves with every order issued)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /settled ONCE/,
    patch: (t) =>
      sub(
        t,
        "      stored === null || (stored !== undefined && stored.through === null)",
        "      false",
      ),
  },
  {
    id: "MU-3154",
    title:
      "R27: WEB-10c A15: a finished record written before revision 6 that lost a session reads as nothing lost",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /written before revision 6 that lost a session/,
    patch: (t) =>
      sub(
        t,
        "        : { ...ended, through: ended.through ?? (ended.lost ? high : 0) },",
        "        : { ...ended, through: ended.through ?? 0 },",
      ),
  },
  {
    id: "MU-3155",
    title:
      "R28: WEB-10c A1/A19: the detail never offers the days beyond its window",
    file: "src/features/tasks/catchup/CatchUpNotice.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /REVIEW6 M9 \(ported|Show earlier days reads/,
    patch: (t) =>
      sub(
        t,
        "  const more = found !== undefined && !found.complete;",
        "  const more = false;",
      ),
  },
  {
    id: "MU-3156",
    title:
      "R28: WEB-10c A1/A19: the detail's selected day is not read by its own key",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /the selected day is read by its own key/,
    patch: (t) =>
      sub(t, "        day={row?.data.slot.date ?? undefined}\n", ""),
  },
  {
    id: "MU-3157",
    title:
      "R28: WEB-10c A1/A7: a day a command asked the runner for is not read by its own key",
    file: "src/features/tasks/catchup/useCatchUp.ts",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /a day a command asked/,
    patch: (t) =>
      sub(
        t,
        "              ...[...(state.asked.get(taskId) ?? [])].reverse(),\n",
        "",
      ),
  },
  {
    id: "MU-3158",
    title:
      "R28: WEB-10c A1/A19: the recovery read's further exact days are always absent",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-banner.test.tsx",
    ],
    expect:
      /exact days are found past the window|the selected day is read by its own key/,
    patch: (t) =>
      sub(
        t,
        '        exact[day] =\n          (await reader.get("materialise_sequences", [taskId, day])) ?? null;',
        "        exact[day] = null;",
      ),
  },
  {
    id: "MU-3159",
    title:
      "R28: WEB-10c A1/A19: a longer window asked for is read at the default length",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-banner.test.tsx",
    ],
    expect: /a longer window is one read|Show earlier days reads/,
    patch: (t) =>
      sub(
        t,
        "      const limit = asked ?? TASK_SEQUENCE_ROWS;",
        "      const limit = TASK_SEQUENCE_ROWS;",
      ),
  },
  {
    id: "MU-3160",
    title:
      "R28: WEB-10c A1/A19: Today never offers the task's page while its day is not known and more days are retained",
    file: "src/features/tasks/today/CatchUpBanner.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /Today, its day not known yet/,
    patch: (t) =>
      sub(
        t,
        "            todayOf(taskId) === undefined &&\n            found.get(taskId)?.complete === false,",
        "            false,",
      ),
  },
  {
    id: "MU-3161",
    title:
      "R28: WEB-10c A22: once every day is shown the focus is left on the page's body",
    file: "src/features/tasks/catchup/CatchUpNotice.tsx",
    tests: ["tests/features/tasks/catchup-banner.test.tsx"],
    expect: /the notice keeps the focus/,
    patch: (t) => sub(t, "      notice.current?.focus();\n", ""),
  },
  {
    id: "MU-3162",
    title:
      "R29: WEB-10c A1/A3: resuming a task's paused work stands in for another day asked of it",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /REVIEW6 M10 \(ported/,
    patch: (t) =>
      sub(
        t,
        "      const admitted = admit(taskId, trigger, options.throughDate);",
        "      const admitted = !resumed && admit(taskId, trigger, options.throughDate);",
      ),
  },
  {
    id: "MU-3163",
    title:
      "R29: WEB-10c A1/A3: a press on one day drops paused work of the task whose day was not known (wildcard)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /a press on one day leaves work paused before its day was known/,
    patch: (t) =>
      sub(
        t,
        "          if (workKey(p) === pressed) parked.delete(key);",
        "          if (\n            p.taskId === taskId &&\n            (day === undefined ||\n              p.throughDate === undefined ||\n              p.throughDate === day)\n          )\n            parked.delete(key);",
      ),
  },
  {
    id: "MU-3165",
    title:
      "R29: WEB-10c A19: a stop of a new row the ledger refused does not name its day",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RUNNER_TESTS,
    expect: /names its day/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 10): a storage stop of an answer whose record failed names its day too.
        '        ? stopInMemory(item.taskId, {\n            reason: "storage",\n            throughDate: key.through_date,\n',
        '        ? stopInMemory(item.taskId, {\n            reason: "storage",\n',
      ),
  },
  {
    id: "MU-3166",
    title:
      "R30: WEB-10c A19: a press that saw no discovery stop lifts the sequence beside one recorded since (no_stop not compared)",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /no_stop expected; a stopped discovery entry|REVIEW6 M11/,
    patch: (t) => sub(t, "      if (current?.stop) return stale;\n", ""),
  },
  // ---- revision 7 (review 7 R31/R32): accepted-read provenance and the transactional admission of a timer's end ----------------------
  {
    id: "MU-3167",
    title:
      "R31: WEB-10c A12: a failed request keeps the accepted rows but drops their order (the error state's provenance)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /REVIEW7 T11|FIRST page asked again/,
    patch: (t) =>
      sub(
        t,
        "accepted: prev.scope === scope ? prev.accepted : null,",
        "accepted: prev.scope === scope && prev.accepted ? { ...prev.accepted, order: null } : null,",
      ),
  },
  {
    id: "MU-3168",
    title:
      "R31: WEB-10c A12: the shown read's order is exported only while the newest request is ready (status-dependent provenance)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /REVIEW7 T11|FIRST page asked again/,
    patch: (t) =>
      sub(
        t,
        "order: kept !== null ? kept.order : (accepted?.order ?? null),",
        'order: kept !== null ? kept.order : shown?.status === "ready" ? (accepted?.order ?? null) : null,',
      ),
  },
  {
    id: "MU-3169",
    title:
      "R31: WEB-10c A15: a read ordered in another incarnation is shown as one with no order (foreign provenance downgraded)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /bound database changed/,
    patch: (t) =>
      sub(
        t,
        "const accepted = foreign ? null : (shown?.accepted ?? null);",
        "const accepted = foreign && shown?.accepted ? { ...shown.accepted, order: null } : (shown?.accepted ?? null);",
      ),
  },
  {
    id: "MU-3170",
    title:
      "R31: WEB-10c A15: the day is not read again when the bound database changed under its read",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /bound database changed/,
    patch: (t) => sub(t, "    if (foreign) void load(null);\n", ""),
  },
  {
    id: "MU-3171",
    title:
      "R31: WEB-10c A12: a failed first page drops what was accepted (hides retained positive sessions)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect: /FIRST page asked again/,
    patch: (t) =>
      sub(
        t,
        "accepted: prev.scope === scope ? prev.accepted : null,",
        "accepted: null,",
      ),
  },
  {
    id: "MU-3172",
    title:
      "R32: WEB-10c A13: the detail's ends are queued without their precondition (the rendered session decides)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect:
      /REVIEW7 T10|stored retirement|unsettled start|save waits for its admission/,
    patch: (t) =>
      sub(t, "        withEndExpectation(\n", "        ((r) => r)(\n"),
  },
  {
    id: "MU-3173",
    title:
      "R32: WEB-10c A13: the list's Stop is queued without the precondition (its own earlier re-check decides)",
    file: "src/features/tasks/timers/TimersPage.tsx",
    tests: ["tests/features/tasks/timers-page.test.tsx"],
    expect: /during the save's admission/,
    patch: (t) =>
      sub(
        t,
        "        withEndExpectation(\n          stopTimer({ ...input, stoppedAt: choice.stoppedAt }),",
        "        ((r) => r)(\n          stopTimer({ ...input, stoppedAt: choice.stoppedAt }),",
      ),
  },
  {
    id: "MU-3174",
    title:
      "R32: WEB-10c A13: the enqueue transaction does not ask a timer end's precondition",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/data/outbox-timer-expectation.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
      "tests/features/tasks/timers-page.test.tsx",
    ],
    expect:
      /refused: nothing is written|re-admission asks again|stored retirement = terminal|during the save's admission/,
    patch: (t) =>
      sub(t, "      !timer.admit({", "      false && !timer.admit({"),
  },
  {
    id: "MU-3175",
    title:
      "R32: WEB-10c A15: a timer end's precondition admits in another database incarnation than the one its observation was ordered in",
    file: "src/features/tasks/timers/copy.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /incarnation it was shown in only/,
    patch: (t) =>
      sub(t, "        seen.incarnationId === incarnationId &&\n", ""),
  },
  {
    id: "MU-3176",
    title:
      "R32: WEB-10c A13: a timer end's precondition is asked before a retry of a save already made is recognised",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-timer-expectation.test.ts"],
    expect: /recognised FIRST/,
    patch: (t) =>
      sub(
        t,
        '    if (planned.kind === "duplicate") {',
        '    if (input.request.expectTimer && !input.request.expectTimer.admit({ incarnationId: input.incarnationId, sync, drafts: reads.timer ?? [] }))\n      return { result: { kind: "refused", reason: "timer_ended" } };\n    if (planned.kind === "duplicate") {',
      ),
  },
  {
    id: "MU-3177",
    title:
      "R32: WEB-10c A13: a timer end is checked only against the server observation (this device's unsettled start ignored)",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /unsettled start/,
    patch: (t) => sub(t, "    starting ||\n", "    false ||\n"),
  },
  {
    id: "MU-3178",
    title:
      "R32: WEB-10c A13: an end already on its way does not refuse another",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /already on its way|already queued/,
    patch: (t) =>
      sub(
        t,
        '    if (draft.kind === "stop_timer" || draft.kind === "cancel_timer")\n      return false;\n',
        "",
      ),
  },
  {
    id: "MU-3179",
    title:
      "R32: WEB-10c A13: this device's unsettled start is ended although a read listed it finished",
    file: "src/features/tasks/model/timers.ts",
    tests: [
      "tests/features/tasks/timer-model.test.ts",
      "tests/features/tasks/timer-block.test.tsx",
    ],
    expect: /unsettled start/,
    patch: (t) =>
      sub(
        t,
        "    authority.ended?.has(witness.sessionId) ||\n    scope?.ended.includes(witness.sessionId)\n",
        "    false\n",
      ),
  },
  {
    id: "MU-3180",
    title:
      "R32: WEB-10c A13: a session shown from a read carries the copy's order (provenance relabelled)",
    file: "src/features/tasks/model/timers.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /RunningSession\.order/,
    patch: (t) =>
      sub(
        t,
        "order: known(input.readOrder) ? input.readOrder : null,",
        "order: known(input.copyOrder) ? input.copyOrder : null,",
      ),
  },
  {
    id: "MU-3181",
    title:
      "R32: WEB-10c A13: a timer end's precondition admits a request that ends another session than the one acted on",
    file: "src/features/tasks/timers/copy.ts",
    tests: ["tests/features/tasks/timer-model.test.ts"],
    expect: /never another resource/,
    patch: (t) => sub(t, "        session === witness.sessionId &&\n", ""),
  },
  {
    id: "MU-3182",
    title:
      "R32: WEB-10c A13: the request's snapshot drops its timer precondition",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-timer-expectation.test.ts"],
    expect: /snapshotted with the request|refused: nothing is written/,
    patch: (t) =>
      sub(
        t,
        "    ...(request.expectTimer && { expectTimer: { ...request.expectTimer } }),\n",
        "",
      ),
  },
  // ---- revision 8 (review 8, R33: a rota answer settles only its own attempt) ----------------------------------------------------
  {
    id: "MU-3183",
    title:
      "R33: WEB-10c A17 (D-10c-9): any answer of a rota command settles whatever attempt is held (an earlier change's ends a later one)",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /REVIEW8 T1[35]/,
    patch: (t) =>
      sub(
        t,
        '    attempt.phase !== "pending" ||\n    memory.rota.get(command)?.attempt !== attempt\n',
        '    attempt.phase !== "pending"\n',
      ),
  },
  {
    id: "MU-3184",
    title:
      "R33: WEB-10c A17/A18: a rota answer activates its identity's page memory (another identity's attempt is dropped)",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /an earlier identity's answer neither reaches/,
    patch: (t) =>
      sub(
        t,
        '  const memory = memories.get(identity);\n  if (\n    memory === undefined ||\n    attempt.phase !== "pending" ||',
        '  const memory = memoryOf(identity);\n  if (\n    memory === undefined ||\n    attempt.phase !== "pending" ||',
      ),
  },
  {
    id: "MU-3185",
    title:
      "R33: WEB-10c A17: a rota answer settles the attempt held with the same BODY (a later attempt's new key is ended by an earlier one)",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /settles its attempt, not a body/,
    patch: (t) =>
      sub(
        t,
        "    memory.rota.get(command)?.attempt !== attempt\n",
        "    memory.rota.get(command)?.attempt?.body !== attempt.body\n",
      ),
  },
  {
    id: "MU-3186",
    title:
      "R33: WEB-10c A17: a settled rota answer is not told to the screens (only the mount that sent it, if still there, shows it)",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    // The task screen re-renders for other reasons in jsdom (its own reads), which picks the hold up anyway: the witnesses are the
    // owner's subscribers and the rota hook (revision 8 diag/mutants-1: SURVIVED against the screen case alone; kept).
    expect: /a settlement is told once|told, not polled/,
    patch: (t) =>
      sub(t, "  rotaChanged();\n  return true;\n}", "  return true;\n}"),
  },
  {
    id: "MU-3187",
    title:
      "R33: WEB-10c A17: a late UNCERTAIN rota answer is kept whatever is held (it downgrades a definite answer or replaces a later change)",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /REVIEW8 T1[35].*uncertain|settles its attempt, not a body/,
    patch: (t) =>
      sub(
        t,
        "    memory.rota.get(command)?.attempt !== attempt\n",
        '    (outcome.kind !== "uncertain" &&\n      memory.rota.get(command)?.attempt !== attempt)\n',
      ),
  },
  {
    id: "MU-3188",
    title:
      "R33: WEB-10c A17 (WEB-10a decision 44): a successful order save closes the dialog although the person edited past it",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /edited past while it was pending/,
    // Re-anchored (revision 9, R34): the completion now also asks whether the ticket is the input the sent change was made from.
    patch: (t) =>
      sub(
        t,
        '    completeKept(ticket, out.kind === "ok" && represents(origin, ticket));\n',
        '    completeKept(ticket, out.kind === "ok" && represents(origin, ticket));\n    if (out.kind === "ok") onClose();\n',
      ),
  },
  {
    id: "MU-3189",
    title:
      "R33: WEB-10c A17 (D-10c-9): the same rota change asked again while it is pending is sent again (a second flight of one key)",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /asked again while it is pending/,
    patch: (t) => sub(t, "  if (flying !== undefined) return flying;\n", ""),
  },
  {
    id: "MU-3190",
    title:
      "R33: WEB-10c A17 (B2): the consent's Try again is offered while the page cannot write",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /Try again sends nothing while the page cannot write/,
    patch: (t) =>
      sub(t, "          {blocked !== null ? (", "          {false ? ("),
  },
  {
    id: "MU-3191",
    title:
      "R33: WEB-10c A17: a rota change answered by success is not read again by the screen showing the task now",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /the screen showing the task NOW|edited past while it was pending/,
    patch: (t) =>
      sub(
        t,
        "        reread.includes(out.kind) ? taskId : null,",
        "        null,",
      ),
  },
  {
    id: "MU-3192",
    title:
      "R33: WEB-10c A17: an order save that consumed the order the person is at leaves the dialog open",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /edited past while it was pending/,
    patch: (t) =>
      sub(
        t,
        "        onClose();\n        return null;\n",
        "        return null;\n",
      ),
  },
  {
    id: "MU-3193",
    title:
      "R33: WEB-10c A17: a rota answer given before the screen mounted is said again there",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /not said again there/,
    patch: (t) =>
      sub(
        t,
        "hold.outcome !== null && hold.outcome.serial > since",
        "hold.outcome !== null && hold.outcome.serial >= 0",
      ),
  },
  {
    id: "MU-3194",
    title:
      "R34: WEB-10c A17 (WEB-10a decision 44): Try again claims the editor's CURRENT input (its ticket), not the input the resent change was made from",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect:
      /REVIEW9 R34.*witness|repeated uncertainty keeps A's origin|edited away and back.*= retry|sync screens keeps the newer order/,
    patch: (t) =>
      sub(
        t,
        "        ? held.origin\n",
        "        ? { editor: ticket.key, session: ticket.session, revision: ticket.revision }\n",
      ),
  },
  {
    id: "MU-3195",
    title:
      "R34: WEB-10c A17: a successful order change consumes the editor's input whatever input it was made from",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect:
      /REVIEW9 R34.*witness|repeated uncertainty keeps A's origin|edited away and back.*= retry|sync screens keeps the newer order/,
    patch: (t) =>
      sub(
        t,
        '    completeKept(ticket, out.kind === "ok" && represents(origin, ticket));\n',
        '    completeKept(ticket, out.kind === "ok");\n',
      ),
  },
  {
    id: "MU-3196",
    title:
      "R34: WEB-10c A17: the input a change represents is matched by editor and session only (a later revision of the same session is consumed)",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect:
      /REVIEW9 R34.*witness|repeated uncertainty keeps A's origin|edited away and back.*= retry|sync screens keeps the newer order/,
    patch: (t) =>
      sub(
        t,
        "  origin.session === ticket.session &&\n  origin.revision === ticket.revision;\n",
        "  origin.session === ticket.session;\n",
      ),
  },
  {
    id: "MU-3197",
    title:
      "R34: WEB-10c A17: an uncertain rota answer forgets the input its attempt was made from (Try again's success then consumes nothing)",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /closes an unchanged order|keeps the input it was submitted from/,
    patch: (t) =>
      sub(
        t,
        '          ? Object.freeze({ ...attempt, phase: "uncertain" as const })\n',
        '          ? Object.freeze({ ...attempt, phase: "uncertain" as const, origin: null })\n',
      ),
  },
  {
    id: "MU-3198",
    title:
      "R34: WEB-10c A17: a rota attempt is taken without the input it was submitted from",
    file: "src/features/tasks/memory.ts",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /closes an unchanged order|keeps the input it was submitted from/,
    patch: (t) =>
      sub(
        t,
        "    origin: origin === null ? null : Object.freeze({ ...origin }),\n",
        "    origin: null,\n",
      ),
  },
  {
    id: "MU-3199",
    title:
      "R34: WEB-10c A17: an order dialog left open by a save of an earlier order does not say that order was saved and the newer one was not",
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /REVIEW9 R34.*(A's own success keeps a newer edit|witness)/,
    patch: (t) =>
      sub(
        t,
        '          {outcome?.kind === "saved" ? (\n',
        "          {false ? (\n",
      ),
  },
  // ---- revision 10 (review 11 R36, Decision B; design assessment of 29 October 2026): one fault per protection of the retry protocol ----
  {
    id: "MU-3200",
    title:
      "R36: WEB-10c A19 (Decision B): a 500 internal_error is not a recognised transient answer",
    file: "src/features/tasks/api.ts",
    tests: RETRY_TESTS,
    expect:
      /recognised transient answers|WITNESS: discovery 500|Q-M1.*transient 500/,
    patch: (t) => sub(t, '  500: "internal_error",\n', ""),
  },
  {
    id: "MU-3201",
    title:
      "R36: WEB-10c A19 (Decision B): a 503 temporarily_unavailable is not a recognised transient answer",
    file: "src/features/tasks/api.ts",
    tests: RETRY_TESTS,
    expect:
      /recognised transient answers|WITNESS: discovery 503|Q-M1.*transient 503/,
    patch: (t) => sub(t, '  503: "temporarily_unavailable",\n', ""),
  },
  {
    id: "MU-3202",
    title:
      "R36: WEB-10c A19 (Decision B): a recognised transient read answer counts in the unrecognised streak (the causes collapsed)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect:
      /WITNESS: discovery|Q-M2: the unrecognised read streak|recognised transient answers between them/,
    patch: (t) =>
      sub(
        t,
        '    read && cause === "unrecognised" ? base.unknown + 1 : base.unknown;',
        '    read && (cause === "unrecognised" || cause === "transient")\n      ? base.unknown + 1\n      : base.unknown;',
      ),
  },
  {
    id: "MU-3203",
    title:
      "R36: WEB-10c A19 (Decision B): an unrecognised COMMAND answer counts in a read's streak (three stop it)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /unrecognised COMMAND answer is duration-governed|MU-10C-06/,
    patch: (t) =>
      sub(
        t,
        '    read && cause === "unrecognised" ? base.unknown + 1 : base.unknown;',
        '    cause === "unrecognised" ? base.unknown + 1 : base.unknown;',
      ),
  },
  {
    id: "MU-3204",
    title:
      "R36: WEB-10c A19 (Decision B): a 429's server deadline is not a minimum (the back-off alone paces)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /429|Retry-After|server deadline/,
    patch: (t) =>
      sub(
        t,
        "  const next = Math.max(\n    now + (DELAYS_MS[Math.min(failures, DELAYS_MS.length) - 1] as number),\n    server ?? 0,\n  );",
        "  const next = now + (DELAYS_MS[Math.min(failures, DELAYS_MS.length) - 1] as number);",
      ),
  },
  {
    id: "MU-3205",
    title:
      "R36: WEB-10c A19 (Decision B): the window's end itself still admits a transmission (>= became >)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /the window's end admits nothing/,
    patch: (t) =>
      sub(
        t,
        "  if (s.since !== null && now >= s.since + WINDOW_MS)",
        "  if (s.since !== null && now > s.since + WINDOW_MS)",
      ),
  },
  {
    id: "MU-3206",
    title:
      "R36: WEB-10c A19 (Decision B): a failure whose pace ends exactly at the window's end waits for it instead of pausing",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /pace falls at or after the window/,
    patch: (t) =>
      sub(
        t,
        "        : next >= since + WINDOW_MS || !Number.isSafeInteger(next)",
        "        : next > since + WINDOW_MS || !Number.isSafeInteger(next)",
      ),
  },
  {
    id: "MU-3207",
    title: "R36: WEB-10c A19 (Decision B): the pacing caps at 60 s, not 30 s",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect:
      /delays 1, 2, 4, 8, 16, then 30 s|Q-M1|WITNESS: an uncertain command|MU-10C-06/,
    patch: (t) =>
      sub(
        t,
        "  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,",
        "  1_000, 2_000, 4_000, 8_000, 16_000, 60_000,",
      ),
  },
  {
    id: "MU-3208",
    title:
      "R36: WEB-10c A19 (Decision B): the sustained-failure window is 240 s, not 180 s",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /delays 1, 2, 4, 8, 16, then 30 s|Q-M1|window's end|WITNESS/,
    patch: (t) =>
      sub(
        t,
        "export const WINDOW_MS = 180_000;",
        "export const WINDOW_MS = 240_000;",
      ),
  },
  {
    id: "MU-3209",
    title:
      "R36: WEB-10c A19 (Decision B): a reconnection ends the unrecognised streak too",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /only the person's reset ends the streak/,
    patch: (t) =>
      sub(
        t,
        "  const unknown = manual ? 0 : s.unknown;",
        "  const unknown = 0;",
      ),
  },
  {
    id: "MU-3210",
    title:
      "R36: WEB-10c A19 (Decision B): a reconnection lifts any retry pause, not only a window's",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect:
      /pause, and stops that are not retry pauses|three unrecognised first reads stop it; a reconnection|only the person's reset ends the streak/,
    patch: (t) =>
      sub(
        t,
        '  s !== null && s !== "invalid" && s.pause === "window";',
        '  s !== null && s !== "invalid" && s.pause !== null;',
      ),
  },
  {
    id: "MU-3211",
    title:
      "R36: WEB-10c A19 (Decision B): a clock behind the last time written is trusted (no clock pause)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /clock behind|backwards clock/,
    patch: (t) =>
      sub(
        t,
        '  if (now < s.seen) return { kind: "pause", pause: "clock" };\n',
        "",
      ),
  },
  {
    id: "MU-3212",
    title: "R36: WEB-10c A19 (Decision B): a 429's Retry-After is not read",
    file: "src/features/tasks/api.ts",
    tests: RETRY_TESTS,
    expect: /429|Retry-After/,
    patch: (t) =>
      sub(
        t,
        "    status === 429 ? retryAfterMs(retryAfter, Date.now()) : undefined;",
        "    undefined;",
      ),
  },
  {
    id: "MU-3213",
    title:
      "R36: WEB-10c A3 (Decision B): a command issued and never answered (a reload) is resent at once, not counted as lost when issued",
    file: MODEL,
    tests: RETRY_TESTS,
    expect: /issued and never answered|Q-M4|takeover/,
    patch: (t) =>
      sub(
        t,
        '  if (s?.issued != null)\n    return { kind: "write", next: failure(row, undefined, now, undefined, s) };\n',
        "",
      ),
  },
  {
    id: "MU-3214",
    title:
      "R36: WEB-10c A3 (Decision B): a discovery read issued and never answered (a reload) is not counted",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /a reload \(another runner on the same database\) adopts|two pages without Web Locks/,
    patch: (t) => sub(t, "    if (s?.issued != null) {", "    if (false) {"),
  },
  {
    id: "MU-3215",
    title:
      "R36: WEB-10c A3 (Decision B): a row of an earlier build holding an attempt or a failed read is carried on, not stopped for the person",
    file: MODEL,
    tests: RETRY_TESTS,
    expect: /earlier build|Q-M11/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the condition moved (it also names a held attempt in any phase); the same fault.
        '    (row.phase === "submitting" ||\n      row.attempt !== null ||\n      row.read_failures > 0)',
        "    false",
      ),
  },
  {
    id: "MU-3216",
    title:
      "R36: WEB-10c A3 (Decision B): a discovery entry of an earlier build with failures is carried on, not stopped for the person",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /Q-M11.*discovery entry with failures|an entry of revision 2 \(failures, no claim field/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the condition moved (it also names an earlier build's claim); the same fault (failures ignored).
        "          ? entry.failures > 0 || (entry.attempt ?? null) !== null",
        "          ? (entry.attempt ?? null) !== null",
      ),
  },
  {
    id: "MU-3217",
    title:
      "R36: WEB-10c A3 (Decision B): a paused position read's Try again begins the next command (the read's continuation lost)",
    file: MODEL,
    tests: RETRY_TESTS,
    expect: /uncertain reads keep the phase|Q-M11|Q-M12/,
    patch: (t) =>
      sub(
        t,
        '      ? "awaiting_position_read"\n      : "ready";',
        '      ? "ready"\n      : "ready";',
      ),
  },
  {
    id: "MU-3218",
    title:
      "R36: WEB-10c A2 (Decision B): a reconnection resets the counted calls (an unattended budget past eight)",
    file: MODEL,
    tests: RETRY_TESTS,
    expect: /resumes on a reconnection WHERE it stopped/,
    patch: (t) =>
      sub(
        t,
        "    phase: continuation(row),\n    read_failures: 0,",
        "    phase: continuation(row),\n    successful_calls: 0,\n    read_failures: 0,",
      ),
  },
  {
    id: "MU-3219",
    title:
      "R36: WEB-10c A19 (Decision B): an answer whose record failed pauses the work (a kick transmits again) instead of stopping it",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /cannot be written: a storage stop/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the stop is now `storage()` after the fence; the same fault (a pause, taken up by a kick). Revision
        // 12: the outcome is written through `protect`; the same fault over its `fenced` answer.
        '      if (settled.kind === "fenced") return storage();',
        '      if (settled.kind === "fenced") return unapplied(at);',
      ),
  },
  {
    id: "MU-3220",
    title:
      "R36: WEB-10c A19 (Decision B): a resend the session held back is made after the discovery's window ended",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /session holds back is not made|discovery: its admission's commit delayed until \+100[01] ms/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the discovery's permission is `transmits` (asked at the send boundary); the same fault.
        "    const permit = transmits(at, issued.schedule as Schedule, until, op);",
        "    const permit = transmits(\n      at,\n      issued.schedule as Schedule,\n      Number.POSITIVE_INFINITY,\n      op,\n    );",
      ),
  },
  {
    id: "MU-3221",
    title:
      "R36: WEB-10c A19 (Decision B): a discovery read not sent after all keeps its admission (counted as lost later)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /session holds back is not made/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the withdrawal now writes an explicit schedule; the same fault (the admission kept). Revision 12:
        // the withdrawal is written as a protected outcome (`answered`); the same fault.
        "      const back = await answered(captured, {\n        ...issued,\n        schedule: withdrawn(issued.schedule as Schedule),\n      });",
        "      const back = await answered(captured, issued);",
      ),
  },
  {
    id: "MU-3222",
    title:
      "R36: WEB-10c A19 (Decision B): a reconnection does not resume a discovery paused by its window",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /a reconnection does, once|two pages consume the same reconnection|deadline beyond the window pauses at once/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the reconnection's scan pairs entries in `scan`; the same fault.
        "          entry?.stop == null ||\n          e.paired.has(taskId) ||",
        "          true ||\n          e.paired.has(taskId) ||",
      ),
  },
  {
    id: "MU-3223",
    title:
      "R36: WEB-10c A19 (Decision B): the discovery's compare-and-set ignores its schedule (an issue, a deadline, a pause)",
    file: "src/data/plans/materialise.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /differ only in their schedule/,
    patch: (t) =>
      sub(
        t,
        "      (a.attempt ?? null) === (b.attempt ?? null) &&\n      scheduleOf(a) === scheduleOf(b);",
        "      (a.attempt ?? null) === (b.attempt ?? null);",
      ),
  },
  {
    id: "MU-3224",
    title:
      "R36: WEB-10c A19 (Decision B): the page's first online render, or any online render, is taken for a reconnection",
    file: "src/features/tasks/catchup/useCatchUp.ts",
    tests: RETRY_TESTS,
    expect: /only an observed offline-to-online change/,
    patch: (t) =>
      sub(
        t,
        "    const reconnected = !held.online && env.online;",
        "    const reconnected = env.online;",
      ),
  },
  {
    id: "MU-3225",
    title:
      "R36: WEB-10c A3 (Decision B): a discovery read is taken as the position read of a sequence awaiting it (the discovery-as-position bypass)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /awaiting its position with a future schedule|held in awaiting_position_read: its own position read/,
    patch: (t) =>
      sub(
        t,
        // Revision 18 (R36-L): re-anchored after the stopped row's fence settling (the same bypass).
        "        return owns(at) ? DONE : lost(at);\n      }\n      return keyed(await drive(at, stored, today), throughDate);",
        '        return owns(at) ? DONE : lost(at);\n      }\n      if (answer !== null && stored.phase === "awaiting_position_read") {\n        const next = onRead(stored, answer, today(), deps.now());\n        const out = await commit(service, captured, key, stored, next);\n        if (out === null) return paused;\n        if (out.stored === null) return DONE;\n        return keyed(await drive(at, out.stored, today), throughDate);\n      }\n      return keyed(await drive(at, stored, today), throughDate);',
      ),
  },
  {
    id: "MU-3226",
    title:
      "R36: WEB-10c A19 (Decision B): a schedule's admission is not required: a stale admission is transmitted",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /lost admission/,
    patch: (t) =>
      sub(
        t,
        '      if (!admitted.written || plan.kind === "write" || row === null) continue;',
        '      if (plan.kind === "write" || row === null) continue;',
      ),
  },
  // ---- revision 11 (review 12 R36; design assessment C1-C4, Q1-Q11) ----------------------------------------------------------
  {
    id: "MU-3227",
    title:
      "R36-1: WEB-10c A19 (review 12): an admitted call's permission always holds: it is issued whatever happened while its admission committed",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /admission's commit delayed until \+100[01] ms/,
    patch: (t) =>
      sub(
        t,
        "        return (\n          owns(at) &&",
        "        return true || (\n          owns(at) &&",
      ),
  },
  {
    id: "MU-3228",
    title:
      "R36-1: WEB-10c A19 (review 12): the permission at issue does not ask the window's end",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /admission's commit delayed until \+100[01] ms/,
    patch: (t) =>
      sub(
        t,
        "          now >= s.seen &&\n          now < until &&\n",
        "          now >= s.seen &&\n",
      ),
  },
  {
    id: "MU-3229",
    title:
      "R36-1: WEB-10c A19: the permission at issue does not ask whether the clock went back before the admission",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a clock that goes back, or stops being a time/,
    patch: (t) =>
      sub(
        t,
        "          Number.isSafeInteger(now) &&\n          now >= s.seen &&\n",
        "          Number.isSafeInteger(now) &&\n",
      ),
  },
  {
    id: "MU-3230",
    title:
      "R36-2: WEB-10c A19: the permission at issue does not ask the caller's fence (a fence recorded while the admission commits)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a fence recorded by another page while a call's admission commits/,
    patch: (t) =>
      sub(
        t,
        "          now >= Math.max(s.next, s.server ?? 0) &&\n          !fenced(at, op)\n",
        "          now >= Math.max(s.next, s.server ?? 0)\n",
      ),
  },
  {
    id: "MU-3231",
    title:
      "R36-1: WEB-10c A19: the sequence's call is handed on without its permission being asked first",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /admission's commit delayed until \+100[01] ms/,
    patch: (t) =>
      sub(
        t,
        '      if (!permit()) answered = UNSENT;\n      else if (plan.kind === "send") {',
        '      if (plan.kind === "send") {',
      ),
  },
  {
    id: "MU-3232",
    title:
      "R36-1: WEB-10c A19: the discovery read is handed on without its permission being asked first",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /discovery: its admission's commit delayed until \+100[01] ms/,
    patch: (t) =>
      sub(
        t,
        "    const read: PositionRead = permit()\n      ? await readPosition(item.taskId, permit)\n      : { answer: UNSENT, zone: null };",
        "    const read: PositionRead = await readPosition(item.taskId, permit);",
      ),
  },
  {
    id: "MU-3233",
    title:
      "R36-1: WEB-10c A19: the command's permission is not carried to the client (the session issues it after the window ended)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /the command \(command\) held in the session until \+1001 ms/,
    patch: (t) =>
      sub(
        t,
        "            attempt.key,\n            permit,\n          ),",
        "            attempt.key,\n          ),",
      ),
  },
  {
    id: "MU-3234",
    title:
      "R36-1: WEB-10c A19 (review 12): the task client's first call ignores its permission (only hidden resends ask it)",
    file: "src/features/tasks/api.ts",
    tests: ["tests/features/tasks/catchup-retry.test.ts"],
    expect:
      /the production readTask asks an initial permission of false|a hidden resend after `not_sent` asks the permission again/,
    patch: (t) =>
      sub(
        t,
        '    if (!isCurrent()) return { ok: false, kind: "not_sent" };\n    const result = await run();',
        "    const result = await run();\n    if (!isCurrent() && attempt > 0) return result;",
      ),
  },
  {
    id: "MU-3235",
    title:
      "R36-1: WEB-10c A19: the task client's materialise ignores an initial false permission",
    file: "src/features/tasks/api.ts",
    tests: ["tests/features/tasks/catchup-retry.test.ts"],
    expect: /the production materialise asks an initial permission of false/,
    patch: (t) =>
      sub(
        t,
        '      (admitted?.() === false\n        ? { ok: false, kind: "not_sent" }\n        : call(',
        '      (false\n        ? { ok: false, kind: "not_sent" }\n        : call(',
      ),
  },
  {
    id: "MU-3236",
    title:
      "R36-1: WEB-10c A19: the task client's reads do not carry their permission to the session",
    file: "src/features/tasks/api.ts",
    tests: ["tests/features/tasks/catchup-retry.test.ts"],
    expect:
      /the position read \(position\) held in the session until \+1001 ms|the discovery read held past its window's end/,
    patch: (t) =>
      sub(
        t,
        "                  client(admitted) as unknown as {",
        "                  client() as unknown as {",
      ),
  },
  {
    id: "MU-3237",
    title:
      "R36-1: WEB-10c A19 (session kernel): `SendOptions.admits` is not asked by the top guard or at the boundary",
    file: "src/session/kernel/send.ts",
    tests: ["tests/session/stamped-admits.test.ts"],
    expect:
      /false from the start|turned false after every step|asked in the step that issues/,
    patch: (t) =>
      sub(
        t,
        "    spec.withdraw?.aborted === true ||\n    spec.admits?.() === false;",
        "    spec.withdraw?.aborted === true;",
      ),
  },
  {
    id: "MU-3238",
    title:
      "R36-1: WEB-10c A19 (session kernel): the stamped fetch drops the caller's permission",
    file: "src/session/kernel/send.ts",
    tests: ["tests/session/stamped-admits.test.ts"],
    expect:
      /false from the start|turned false after every step|asked in the step that issues/,
    patch: (t) =>
      sub(
        t,
        "      callerSignal: request.signal,\n      ...permission,\n",
        "      callerSignal: request.signal,\n",
      ),
  },
  {
    id: "MU-3239",
    title:
      "R36-1: WEB-10c A19 (session): the typed client is built without the caller's send options",
    file: "src/session/stamped-client.ts",
    tests: ["tests/session/stamped-admits.test.ts"],
    expect:
      /false from the start|turned false after every step|asked in the step that issues/,
    patch: (t) =>
      sub(
        t,
        'createStampedFetch(k, klass, account, epoch, "library", send),',
        'createStampedFetch(k, klass, account, epoch, "library"),',
      ),
  },
  {
    id: "MU-3240",
    title:
      "R36-1: WEB-10c A19: a `closed` command answer (possibly after a transmission) is taken as not sent: its admission is withdrawn",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a `closed` answer \(possibly after a transmission\)/,
    patch: (t) =>
      sub(
        t,
        '    case "closed":\n      return UNSETTLED;',
        '    case "closed":\n      return UNSENT;',
      ),
  },
  {
    id: "MU-3241",
    title:
      "R36-1: WEB-10c A19: a call its own permission refused is not decided again (no pause written; it waits for a kick)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /admission's commit delayed until \+100[01] ms/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 12): the withdrawal's failure is answered by `protect` before this decision; the same fault.
        "        if (!owns(at) || !mayRun() || permit() || refused > 1) return PAUSED;",
        "        if (back !== undefined) return PAUSED;",
      ),
  },
  {
    id: "MU-3242",
    title:
      "R36-2: WEB-10c A19 (review 12): an answer whose record failed once is never written again (no repair)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /ONE failed record of a 429|a discovery answer recorded at its repair/,
    patch: (t) =>
      sub(
        t,
        "export const REPAIR_MS: readonly number[] = [250, 1_000];",
        "export const REPAIR_MS: readonly number[] = [];",
      ),
  },
  {
    id: "MU-3243",
    title:
      "R36-2: WEB-10c A19: an answer never written fences nothing (no marker, no page hold)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /never written: a marker fences the day|a discovery answer whose record never lands|after a reload only the marker survives/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 12): the fence is published by `publish`; the same fault (no marker written, no page hold taken).
        // Re-anchored (revision 13): its lifetime check is `entitled` (a gap included); the same fault.
        "    const out = m.set(scope, op, () => entitled(at));",
        '    const out = { state: "recorded" as const };',
      ),
  },
  {
    id: "MU-3244",
    title: "R36-2: WEB-10c A19: a standing fence is never consulted",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /never written: a marker fences the day|a marker of the task's discovery in the page host \(true\)/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 17, R36-K): the caller is fenced under its own or its lost-answer operation; the same fault, on both.
        '      (o) => m.stops.has(scope, o) || m.probe(scope, o) !== "unmarked",',
        "      (o) => m.stops.has(scope, o) && false,",
      ),
  },
  {
    id: "MU-3245",
    title:
      "R36-2: WEB-10c A19: a marker that cannot be read is taken as absent",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a marker that cannot be read stands/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 17, R36-K): the caller is fenced under its own or its lost-answer operation; the same fault, on both.
        'm.probe(scope, o) !== "unmarked",',
        'm.probe(scope, o) === "marked",',
      ),
  },
  {
    id: "MU-3246",
    title:
      "R36-2: WEB-10c A19: the page's own hold of a fence (no marker could be written) is not consulted",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a marker that cannot be read stands/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 17, R36-K): the caller is fenced under its own or its lost-answer operation; the same fault, on both.
        "      (o) => m.stops.has(scope, o) || m.probe(scope, o)",
        "      (o) => m.probe(scope, o)",
      ),
  },
  {
    id: "MU-3247",
    title:
      "R36-2: WEB-10c A19: the person's press does not write the outcome this page kept (its 429 deadline, its success) before going on",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /writes the kept 429 first|a successful command whose record never lands/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 12): the kept outcome is a `Protected` record written by the press first; the same fault (taken as
        // written without writing it, so its fence ends and the work carries on from the issued record).
        // Re-anchored (revision 13): the record is written by its `attempt`; the same fault.
        "        const { verdict } = await record.attempt();",
        '        const verdict: Verdict = "written";',
      ),
  },
  {
    id: "MU-3248",
    title:
      "R36-2: WEB-10c A19: the person's press ends every fence of the operation, not only the instances it saw",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /a press ends only the fence instances it saw|Q6: a repair ends only the instance it published/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 12, R36-A): a press no longer ends the instances it witnessed; an outcome written at last ends the one
        // instance it published (`reconcile`). The same fault: every marker of the operation ended, another page's included.
        // Re-anchored (revision 17, R36-K): a protected outcome's fence is published under its marker operation (`marks`); the same fault.
        '      m.retire(scope, record.marks, {\n        kind: "instance",\n        instances: [record.marker],\n      });',
        "      m.clear(scope, record.marks);",
      ),
  },
  {
    id: "MU-3249",
    title:
      "R36-3: WEB-10c A19 (review 12): a legacy discovery claim with zero failures is taken as fresh",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a legacy claim with zero failures stops for the person/,
    patch: (t) =>
      sub(
        t,
        "          ? entry.failures > 0 || (entry.attempt ?? null) !== null",
        "          ? entry.failures > 0",
      ),
  },
  {
    id: "MU-3250",
    title:
      "R36-3: WEB-10c A19: a withdrawn discovery admission drops its schedule key (and is then read as an earlier build's claim)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a current withdrawn admission/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 12): the withdrawal is written through `answered`; the same fault.
        "      const back = await answered(captured, {\n        ...issued,\n        schedule: withdrawn(issued.schedule as Schedule),\n      });",
        "      const { schedule: _, ...rest } = issued;\n      const kept = withdrawn(issued.schedule as Schedule);\n      const back = await answered(\n        captured,\n        kept === null ? rest : { ...rest, schedule: kept },\n      );",
      ),
  },
  {
    id: "MU-3251",
    title:
      "R36-3: WEB-10c A19: an earlier build's row holding an attempt in `ready` carries on (its uncertainty resent with no schedule)",
    file: "src/features/tasks/model/materialise.ts",
    tests: RETRY_TESTS,
    expect: /a legacy row in `ready` holding an attempt/,
    patch: (t) =>
      sub(
        t,
        '    (row.phase === "submitting" ||\n      row.attempt !== null ||\n      row.read_failures > 0)',
        '    (row.phase === "submitting" || row.read_failures > 0)',
      ),
  },
  {
    id: "MU-3252",
    title:
      "R36-4: WEB-10c A19 (review 12): a reconnection reads only the first page of the account's rows",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /earlier unrelated retained rows|several paused tasks and days beyond the first page/,
    patch: (t) =>
      sub(
        t,
        "        if (page.complete || last === undefined) break;",
        "        if (page.complete || last !== null) break;",
      ),
  },
  {
    id: "MU-3253",
    title:
      "R36-4: WEB-10c A19: a reconnection also lifts pauses recorded after it",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a pause recorded after the reconnection/,
    patch: (t) =>
      sub(
        t,
        "  ): boolean => resumable(s) && (s as Schedule).seen <= edge;",
        "  ): boolean => resumable(s) && edge === edge;",
      ),
  },
  {
    id: "MU-3254",
    title:
      "R36-4: WEB-10c A19: a page that cannot be read ends the reconnection's scan (the rest is never reached)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a page that cannot be read leaves the scan where it was/,
    patch: (t) =>
      sub(
        t,
        "        if (!current() || page === undefined) return;",
        "        if (!current() || page === undefined) {\n          edgeScan = null;\n          return;\n        }",
      ),
  },
  {
    id: "MU-3255",
    title:
      "R36-4: WEB-10c A19: a kick does not carry an unfinished reconnection scan on",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a page that cannot be read leaves the scan where it was/,
    patch: (t) =>
      sub(
        t,
        "      if (edgeScan !== null && edgeScan.service === service)\n        void scan(edgeScan);\n",
        "      void service;\n",
      ),
  },
  {
    id: "MU-3256",
    title:
      "R36-2: WEB-10c A19 (production composition): the page's markers are not given to its runner",
    file: "src/features/tasks/catchup/useCatchUp.ts",
    tests: RETRY_TESTS,
    expect: /a marker of the task's discovery in the page host \(true\)/,
    patch: (t) => sub(t, "    markers: () => getPageDataHost().markers,\n", ""),
  },
  {
    id: "MU-3257",
    title: "R36-2: WEB-10c A19: a discovery answer's record is not repaired",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a discovery answer recorded at its repair/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 12): the answer is written through `protect`; the same fault (a failed write is given up, not repaired).
        // Re-anchored (revision 13): the discovery answer's own verdict; given up = classified final (`stale`), never written again.
        '          out.kind !== "applied" || out.value.kind === "refused"\n            ? "failed"',
        '          out.kind !== "applied" || out.value.kind === "refused"\n            ? "stale"',
      ),
  },
  {
    id: "MU-3258",
    title:
      "R36-2: WEB-10c A19: the discovery does not consult its fence before it reads (only the permission refuses, and no stop is shown)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /a discovery answer whose record never lands fences the discovery|a marker of the task's discovery in the page host \(true\)|a marker that cannot be read stands/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 17, R36-K): the check now lets a rediscoverable fence through (`orphaned`); the same fault: none is consulted.
        '    if (orphaned === null && fenced(at, op))\n      return end(stopInMemory(item.taskId, { reason: "storage" }));\n',
        "",
      ),
  },
  {
    id: "MU-3259",
    title:
      "R36-2: WEB-10c A19: a sequence does not consult its day's fence before it is admitted (only the permission refuses, and no stop is shown)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /never written: a marker fences the day|after a reload only the marker survives/,
    // Re-anchored (revision 17, R36-K): a rediscovery's own fence check (deeper) contains the same text; the anchor names its comment.
    patch: (t) =>
      sub(
        t,
        "      // Revision 11 (R36): an outcome of this day that could not be recorded stands: nothing is transmitted for it automatically.\n      if (fenced(at, op)) return storage();\n",
        "      // Revision 11 (R36): an outcome of this day that could not be recorded stands: nothing is transmitted for it automatically.\n",
      ),
  },
  // ---- Revision 12 (review 13 R36-A to R36-D; design assessment Q1 to Q9) ------------------------------------------------------
  {
    id: "MU-3262",
    title:
      "R36-B: WEB-10c A19 (review 13): a failed outcome write is fenced only after its repairs are spent (unfenced during the waits)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    // Revision 15: an outcome kept from its receipt is published then, so the fault is observable for the others (a withdrawal, a read's
    // success) and for a store that keeps failing.
    expect:
      /WITNESS \(R36-B\)|Q2 (discovery|command|position): the first failed outcome write is fenced before|never recorded: fenced at the first failure|while the page is LIVE, a peer|every page is fenced from the first failure/,
    patch: (t) =>
      // Re-anchored (revision 13): publication is at receipt for an outcome that must be kept (`protect`), otherwise at the first
      // unrecorded write (`fence` in `settle`); the same fault (nothing published until the repairs are spent). Re-anchored again
      // (revision 14): a failed write of an outcome not fenced at receipt is published once its repairs are spent (the design), so the
      // same fault was then the receipt publication withheld from every outcome. Re-anchored again (revision 15, review 16's R36-I):
      // the first failed write is fenced at once under a live page, so this mutant is the original fault again (revision 14's delay);
      // the receipt publication withheld is MU-3290. Revision 16 (R36-J): the departure is judged by `left` (`gone`); the same fault.
      sub(
        t,
        '      if (verdict === "stale" || !left(record)) {',
        '      if (verdict === "stale" || (!left(record) && wait === undefined)) {',
      ),
  },

  {
    id: "MU-3263",
    title:
      "R36-A: WEB-10c A19 (review 13): the person's press ends a fence whose outcome this page does not hold (a reload's marker only)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /WITNESS \(R36-A\) recreated runner|after a reload only the marker survives \(/,
    patch: (t) =>
      sub(
        t,
        "      return held();\n    const now = deps.now();",
        "      for (const op of [fenceOf(item.taskId), ...(day === undefined ? [] : [fenceOf(item.taskId, day)])])\n        markers()?.clear(scopeOf(at.service), op);\n    const now = deps.now();",
      ),
  },
  {
    id: "MU-3264",
    title:
      "R36-A/C1: WEB-10c A19 (review 13): a repair that finds another record stored is taken as its outcome recorded (its fence ends)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /Q5: a repair that finds ANOTHER row stored/,
    patch: (t) =>
      sub(
        t,
        '      if (verdict === "written" || verdict === "landed") {\n        reconcile(record);',
        '      if (verdict !== "failed") {\n        reconcile(record);',
      ),
  },
  {
    id: "MU-3265",
    title:
      "R36/C1: WEB-10c A19 (review 13): a repair never recognises its own transition already stored (an applied write whose answer was lost stays fenced)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /Q5 control: a first write that applied but answered `failed`/,
    patch: (t) =>
      sub(
        t,
        '          : landedRow(expected, next, out.stored)\n            ? "landed"',
        '          : false\n            ? "landed"',
      ),
  },
  {
    id: "MU-3266",
    title:
      "R36-C: WEB-10c A19 (review 13): a reconnection's scan replaces the person's queued press (the fresh budget lost)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /WITNESS \(R36-C\)/,
    patch: (t) =>
      sub(
        t,
        "      if (queued.retry !== undefined && queued.retry.online !== true)\n        queued.edge = item.retry as Retry;\n      else queued.retry = item.retry as Retry;",
        "      queued.retry = item.retry as Retry;",
      ),
  },
  {
    id: "MU-3267",
    title:
      "R36-C: WEB-10c A19 (review 13): a reconnection's lift kept beside a press is never tried when the press's stop no longer stands",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /Q8: a press whose stop no longer stands/,
    patch: (t) =>
      sub(
        t,
        "    const entitled = [item.retry, item.edge].filter(",
        "    const entitled = [item.retry].filter(",
      ),
  },
  {
    id: "MU-3268",
    title:
      "R36-D: WEB-10c A19 (review 13): a reconnection observed while the bound service is momentarily not displayed is dropped",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /WITNESS \(R36-D\)|Q9: the kept edge is consumed once/,
    patch: (t) =>
      sub(
        t,
        "        service ?? (deps.service() === null && bound?.live ? bound : null);",
        "        service;",
      ),
  },
  {
    id: "MU-3269",
    title:
      "R36/C2: WEB-10c A19 (review 13): a command known not to have been sent whose withdrawal fails is given up unfenced (a reload counts it as lost)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /Q7 command: a call known not to have been sent/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 13): verdicts no longer include `ended` (every unwritten verdict is repaired), so the same fault is the
        // withdrawal written outside `protect`: nothing published, a failed write given up as a pause. Revision 15: `protect` also takes
        // the call's lifecycle mark (the same fault over the extended call). Revision 16: its `keep` is named (`"never"`).
        '        const back = await protect(\n          at,\n          key.task_id,\n          op,\n          () => commit(service, captured, key, issued, unsent),\n          judgeRow(issued, unsent),\n          "never",\n          key.through_date,\n          mark,\n        );',
        '        const plain = await commit(service, captured, key, issued, unsent);\n        const back = (plain === null ? { kind: "ended" } : { kind: "out", out: plain, verdict: "written" }) as { kind: string; out?: unknown };',
      ),
  },
  {
    id: "MU-3270",
    title:
      "R36/Q4: WEB-10c A19 (review 13): a position read's outcome that cannot be recorded is fenced under an operation no caller consults",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /Q4 position|Q2 position: the first failed outcome write is fenced before/,
    patch: (t) =>
      sub(
        t,
        "        op,\n        () => commit(service, captured, key, issued, outcome),",
        '        plan.kind === "read" ? `${op}:read` : op,\n        () => commit(service, captured, key, issued, outcome),',
      ),
  },

  // ---- Revision 13 (review 14 R36-E/R36-F; design assessment Q2 to Q6, Q10) -------------------------------------------------------
  {
    id: "MU-3271",
    title:
      "R36-E: WEB-10c A19 (review 14): a FIRST outcome write that finds another record (stale) is adopted as recorded (its fence ends, the work goes on from the peer's row)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /STALE-OUTCOME WITNESS \(R36-E\)|Q3 (discovery|command|position) (429|ok): the first write of a's answer finds b's admission/,
    patch: (t) =>
      // Re-anchored (revision 14): the stale and spent verdicts share one return.
      sub(
        t,
        "      const wait = REPAIR_MS[i];\n",
        '      if (verdict === "stale" && i === 0) {\n        reconcile(record);\n        return { kind: "out", out, verdict: "written" };\n      }\n      const wait = REPAIR_MS[i];\n',
      ),
  },
  {
    id: "MU-3272",
    title:
      "R36-F: WEB-10c A19 (review 14): an answer that arrives while no service is displayed (its own still live) is dropped unrecorded",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /BINDING-ANSWER WITNESS \(R36-F\)/,
    patch: (t) =>
      sub(
        t,
        "    if (!entitled(at)) return ENDED_P;",
        "    if (!owns(at)) return ENDED_P;",
      ),
  },
  {
    id: "MU-3273",
    title:
      "R36-F: WEB-10c A19 (review 14): an outcome left mid-write by a gap is forgotten by the runner (its fence stands, nothing writes it on the return)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /Q4 (discovery|command|position): a gap while the first outcome write is on its way \(it fails\)/,
    patch: (t) =>
      sub(
        t,
        "        record.pending = true;\n        return PENDING;",
        "        repairs.delete(repairKey(record.service, record.op));\n        return PENDING;",
      ),
  },
  {
    id: "MU-3274",
    title:
      "R36-F/C1: WEB-10c A19 (review 14): a command's answer kept through a gap is classified again when it is written (its deadline recomputed from the return)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /Q4 command: an answer kept through a gap is written as it was observed/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 14): `mustKeep` also takes the answer (R36-G).
        "        () => commit(service, captured, key, issued, outcome),\n        judgeRow(issued, outcome),\n        mustKeep(\n",
        '        () => commit(service, captured, key, issued, plan.kind === "send" ? onSent(issued, answered as SendAnswer, deps.now()) : outcome),\n        judgeRow(issued, outcome),\n        mustKeep(\n',
      ),
  },
  {
    id: "MU-3275",
    title:
      "R36-E/C5: WEB-10c A19 (review 14): a stored row with the same attempt key is taken as this outcome landed (a peer's admission of the same command)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /STALE-OUTCOME WITNESS \(R36-E\)|Q3 command (429|ok): the first write of a's answer finds b's admission/,
    patch: (t) =>
      sub(
        t,
        "  return was === (expected.revision ?? 0) + 1 && same(rest, want);",
        "  return (was === (expected.revision ?? 0) + 1 && same(rest, want)) || (rest.attempt != null && same(rest.attempt, want.attempt));",
      ),
  },
  {
    id: "MU-3276",
    title:
      "R36-F/invariant 11: WEB-10c A19 (review 14): a call's permission at issue accepts a gap of its binding (sent while no service is displayed)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a call admitted just before a gap is never sent in it/,
    patch: (t) =>
      sub(
        t,
        "          owns(at) &&\n          mayRun() &&",
        "          entitled(at) &&\n          deps.online() &&\n          deps.writable() &&",
      ),
  },
  {
    id: "MU-3277",
    title:
      "R36/C4: WEB-10c A19 (review 14): nothing is published before the first outcome write answers (a write that never lands leaves no fence)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /Q5 (discovery|command|position): (the fence stands while the FIRST outcome write|a runner disposed while its first outcome write)/,
    patch: (t) =>
      // Revision 13 (after the native E-M2 failure): only an outcome that must be kept is published at receipt; the fault: none is.
      sub(
        t,
        // Re-anchored (revision 17, R36-K): published under its marker operation (`marks`); the same fault.
        "    const published = early\n      ? publish(at, marks)\n      : { marker: null, memory: null, unpublished: true };",
        "    const published = { marker: null, memory: null, unpublished: true };",
      ),
  },

  {
    id: "MU-3278",
    title:
      "R36-F/C6: WEB-10c A19 (review 14): the task's work does not write an outcome kept through a gap before it goes on (the day stays stopped)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /Q4 (discovery|command|position): a gap while the first outcome write is on its way/,
    patch: (t) => sub(t, "        !record.pending ||\n", "        true ||\n"),
  },
  {
    id: "MU-3279",
    title:
      "R36-F/C3: WEB-10c A19 (review 14): an answer that arrives while ANOTHER service is displayed (a replacement) is kept as if in a gap",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /an answer that arrives while ANOTHER service is displayed/,
    patch: (t) =>
      sub(
        t,
        "    return now === null || now === at.service;",
        "    return true;",
      ),
  },
  {
    id: "MU-3280",
    title:
      "R36-F/C3: WEB-10c A19 (review 14): an ended service counts as a gap (its answer publishes a fence into a lifetime that ended)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /an answer that arrives after its service ended/,
    patch: (t) =>
      sub(
        t,
        "    if (disposed || at.service.ended || bound !== at.service) return false;",
        "    if (disposed || bound !== at.service) return false;",
      ),
  },
  {
    id: "MU-3282",
    title:
      "R36/C4: WEB-10c A19 (revision 13): every outcome is fenced at its receipt (a call the browser cancels as its page closes stops the work for good)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    // Revision 15: the case it names is the call cancelled AFTER the page's teardown (its old title modelled the close as a disposal).
    expect:
      /a transport failure whose record never lands, arriving after the page's pagehide|AFTER THE PAGE'S PAGEHIDE whose first write is lost is not fenced/,
    patch: (t) =>
      // Revision 16: `mustKeep` names its decision (`Keep`); the same fault (every outcome kept at its receipt).
      sub(t, '    if (success) return "always";\n', '    return "always";\n'),
  },
  {
    id: "MU-3281",
    title:
      "F-10C-13a: WEB-10c A19 (revision 13): the outbox's Try again of all drafts ends every stop the page holds in memory (the task catch-up's fence too)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-foreign-stops.test.ts"],
    expect:
      /a catch-up fence \(memory hold\) held beside the outbox's own stop stays/,
    patch: (t) =>
      sub(
        t,
        "            (operation) => outboxOperation(operation) && covers(operation),",
        "            (operation) => covers(operation),",
      ),
  },
  {
    id: "MU-3283",
    title:
      "R36-G: WEB-10c A19 (review 15): a failure the server answered is fenced only if it stops the caller or holds a server minimum (revision 13's selection)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /REVIEW15 Q1|Q2 (discovery|command|position), (an unrecognised answer|a 500|a 503|a 429)/,
    patch: (t) =>
      // Revision 16: a received failure is `always`; without that line it would be `observed` (kept on a live page), so the same fault
      // also leaves it out of `observed`: kept only by a stop or a server minimum (revision 13's selection).
      sub(
        sub(
          t,
          '    if (answer !== undefined && observedFailure(answer, true)) return "always";\n',
          "",
        ),
        "    return answer !== undefined && observedFailure(answer, false)\n",
        "    return answer !== undefined && observedFailure(answer, false) && !receivedFailure(answer)\n",
      ),
  },
  {
    id: "MU-3284",
    title:
      "R36-G: WEB-10c A19 (review 15): an uncertain answer without retry facts is taken for no answer at all (transport), so an unrecognised one is not fenced at receipt",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    // Revision 15: a live page keeps every observed failure from its receipt (R36-H), so the fault is observable after a `pagehide` only.
    expect:
      /Q2 (discovery|command|position), an unrecognised answer|REVIEW15 Q1 (discovery|position) (CONTROL|WITNESS)|the FIRST unrecognised answer|Q2 (discovery|command|position): an unrecognised answer without retry facts after the page's pagehide/,
    patch: (t) =>
      sub(
        t,
        '  (answer.retry?.cause ?? "unrecognised") !== "transport";',
        '  (answer.retry?.cause ?? "transport") !== "transport";',
      ),
  },
  {
    id: "MU-3285",
    title:
      "R36-G/C1: WEB-10c A19 (review 15; relabelled in revision 15): no answer at all (transport) is fenced at receipt like a received one EVEN AFTER the page's pagehide, so a call cancelled as its page closes stops the work for good (E-M2)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /a transport failure \(no answer\) arriving|no answer \(transport\): its first write FAILS after the page's pagehide|a transport failure whose record never lands, arriving after|the page's pagehide THEN a transport failure/,
    patch: (t) =>
      sub(
        t,
        '  (answer.retry?.cause ?? "unrecognised") !== "transport";',
        '  (answer.retry?.cause ?? "unrecognised") !== "never";',
      ),
  },
  {
    id: "MU-3286",
    title:
      "R36-G: WEB-10c A19 (review 15): a discovery read's received failure is not given to its receipt protection",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /Q2 discovery, |REVIEW15 Q1 discovery/,
    patch: (t) =>
      sub(
        t,
        "      scheduled(issued, after),\n      read.answer,\n    );",
        "      scheduled(issued, after),\n    );",
      ),
  },
  {
    id: "MU-3287",
    title:
      "R36-G: WEB-10c A19 (review 15): a command's or position read's received failure is not given to its receipt protection",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /Q2 (command|position), |REVIEW15 Q1 (command|position)/,
    patch: (t) =>
      sub(
        t,
        "          answered as SendAnswer | ReadAnswer,\n",
        "          undefined,\n",
      ),
  },
  {
    id: "MU-3288",
    title:
      "R36/Firefox teardown: WEB-10c A19 (revision 14; re-anchored and relabelled in revision 15, R36-I): an outcome not fenced at receipt is fenced across pages at its first failed write EVEN AFTER the page's pagehide (a page torn down mid-write stops the work for good)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /its first write FAILS after the page's pagehide|the page's pagehide THEN a transport failure/,
    patch: (t) =>
      // Revision 16: re-anchored on `left` (the page's departure since the call), the same fault.
      sub(
        t,
        '      if (verdict === "stale" || !left(record)) {',
        '      if (verdict === "stale" || true) {',
      ),
  },
  {
    id: "MU-3289",
    title:
      "R36/Decision B: WEB-10c A19 (revision 14; re-anchored in revision 15): an outcome whose write fails under a live page is never fenced across pages (another page transmits after a failed retry-state write)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a store that keeps failing under a LIVE page/,
    patch: (t) =>
      // Revision 16: re-anchored on `left` (the page's departure since the call), the same fault.
      sub(
        t,
        '      if (verdict === "stale" || !left(record)) {',
        '      if (verdict === "stale") {',
      ),
  },
  // ---- Revision 15 (review 16's R36-H, R36-I and R39; design assessment Q7) --------------------------------------------------------
  {
    id: "MU-3290",
    title:
      "R36-H: WEB-10c A19 (review 16): an outcome kept from its receipt (`mustKeep`) is not published then (a first write lost with its runner leaves no fence)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /lost-pending: the write lost across disposal|observed by a LIVE page whose runner is then disposed|observed while live THEN the page's pagehide|whose first write is lost: fenced at receipt|WITNESS lost: fenced at receipt/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 17, R36-K): published under its marker operation (`marks`); the same fault.
        "    const published = early\n      ? publish(at, marks)",
        "    const published = false\n      ? publish(at, marks)",
      ),
  },
  {
    id: "MU-3291",
    title:
      "R36-H: WEB-10c A19 (review 16): a transport failure a live page observed is not kept from its receipt (revision 14's received-only selection; a lost write is recovered from the issue)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [...RETRY_TESTS, "tests/features/tasks/catchup-lifecycle.test.ts"],
    expect:
      /REVIEW16 Q1 (discovery|command|position) transport lost-pending|observed by a LIVE page whose runner is then disposed|observed while live THEN the page's pagehide|a live page: the transport failure is fenced from its receipt/,
    patch: (t) =>
      // Revision 16: the parameter is `departed` (a `pagehide`, never a `beforeunload` alone); the same fault.
      sub(
        t,
        '  answer.kind === "uncertain" && (!departed || receivedFailure(answer));',
        '  answer.kind === "uncertain" && receivedFailure(answer);',
      ),
  },
  {
    id: "MU-3292",
    title:
      "R36-I: WEB-10c A19 (review 16): a page shown again (a back-forward restore) does not publish the fence of an outcome whose write failed while it was torn down",
    file: "src/features/tasks/catchup/runner.ts",
    tests: [...RETRY_TESTS, "tests/features/tasks/catchup-lifecycle.test.ts"],
    expect: /back-forward restore/,
    patch: (t) =>
      // Revision 16: the restore publishes every outcome the departure left unpublished; the same fault (none published).
      sub(
        t,
        "        fence({ service: record.service }, record);\n  });",
        "        void record;\n  });",
      ),
  },
  {
    id: "MU-3293",
    title:
      "R36-F/R36-I: WEB-10c A19 (review 16): an outcome kept in a gap of its binding is fenced even after the page's pagehide (a call cancelled by the teardown stops the work for good)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /arriving in a GAP of its binding \(no service displayed\) after/,
    patch: (t) =>
      // Revision 16: re-anchored on `left` (the page's departure since the call), the same fault.
      sub(
        t,
        "        if (!left(record) && !fence(at, record)) return ENDED_P;",
        "        if (!fence(at, record)) return ENDED_P;",
      ),
  },
  {
    id: "MU-3294",
    title:
      "R36-H/I: WEB-10c A19 (review 16): the production runner is not given the page's lifecycle (a call cancelled by the page's teardown is fenced for good)",
    file: "src/features/tasks/catchup/useCatchUp.ts",
    tests: ["tests/features/tasks/catchup-lifecycle.test.ts"],
    expect: /a pagehide first \(the call cancelled/,
    patch: (t) => sub(t, "    lifecycle: pageLifecycle(),\n", ""),
  },
  {
    id: "MU-3295",
    title:
      "R36-H/I: WEB-10c A19 (review 16): a hidden tab (visibilitychange) is taken for a page torn down",
    file: "src/features/tasks/catchup/lifecycle.ts",
    tests: ["tests/features/tasks/catchup-lifecycle.test.ts"],
    // Revision 16: the test's title names a departure, not a teardown (R36-J).
    expect: /a hidden tab is no departure/,
    patch: (t) =>
      sub(
        t,
        '      window.addEventListener("pagehide", () => created.pagehide());',
        '      window.addEventListener("pagehide", () => created.pagehide());\n      window.addEventListener("visibilitychange", () => created.pagehide());',
      ),
  },
  {
    id: "MU-3296",
    title:
      "R36-H/I: WEB-10c A19 (review 16): a pageshow (a back-forward restore) does not end the teardown",
    file: "src/features/tasks/catchup/lifecycle.ts",
    tests: ["tests/features/tasks/catchup-lifecycle.test.ts"],
    expect: /until the next pageshow|publishes it/,
    patch: (t) =>
      sub(
        t,
        '      window.addEventListener("pageshow", () => created.pageshow());\n',
        "",
      ),
  },
  {
    id: "MU-3297",
    title:
      "R39: WEB-10c A19 (review 16): a task read's successful body is decoded by the client library as JSON again (a malformed 200 reads as no answer)",
    file: "src/features/tasks/api.ts",
    tests: [
      "tests/features/tasks/api-decoding.test.ts",
      "tests/features/tasks/catchup-retry.test.ts",
    ],
    expect: /R39/,
    patch: (t) =>
      sub(
        t,
        '                ).GET(path, { params, parseAs: "text" }),',
        "                ).GET(path, { params }),",
      ),
  },
  {
    id: "MU-3298",
    title:
      "R39: WEB-10c A19 (review 16): the materialise command's successful body is decoded by the client library as JSON again",
    file: "src/features/tasks/api.ts",
    tests: [
      "tests/features/tasks/api-decoding.test.ts",
      "tests/features/tasks/catchup-retry.test.ts",
    ],
    expect: /POST \/task-commands \(materialise\)|R39 command/,
    patch: (t) =>
      sub(
        t,
        '                body: { command } as never,\n                parseAs: "text",\n',
        "                body: { command } as never,\n",
      ),
  },
  {
    id: "MU-3299",
    title:
      "R39: WEB-10c A19 (review 16): an access command's successful body is decoded by the client library as JSON again",
    file: "src/features/tasks/api.ts",
    tests: ["tests/features/tasks/api-decoding.test.ts"],
    expect: /POST \/task-access-commands \(access\)/,
    patch: (t) =>
      sub(
        t,
        '          body: { command } as never,\n          parseAs: "text",\n',
        "          body: { command } as never,\n",
      ),
  },
  {
    id: "MU-3300",
    title:
      "R39: WEB-10c A19 (review 16): a received body that is not JSON is taken for no answer at all (transport)",
    file: "src/features/tasks/api.ts",
    tests: [
      "tests/features/tasks/api-decoding.test.ts",
      "tests/features/tasks/catchup-retry.test.ts",
    ],
    expect: /R39/,
    patch: (t) =>
      sub(t, "    return NOT_JSON;", '    throw new TypeError("not JSON");'),
  },
  {
    id: "MU-3302",
    title:
      "R36-H/I: WEB-10c A19 (review 16; re-anchored in revision 16): the departure is read for the page, not per call (a call issued after a departure the page came back from, or after its pagehide, is taken for one that departure cancelled)",
    file: "src/features/tasks/catchup/lifecycle.ts",
    tests: [...RETRY_TESTS, "tests/features/tasks/catchup-lifecycle.test.ts"],
    expect: /a hidden tab is no departure/,
    patch: (t) =>
      sub(
        t,
        "        (hidden > mark && hidden > shown) || dispatching(),",
        "        (mark >= 0 && hidden > 0 && hidden > shown) || dispatching(),",
      ),
  },
  // ---- Revision 16 (review 17's R36-J; design assessment Q7) -----------------------------------------------------------------------
  {
    id: "MU-3306",
    title:
      "R36-J: WEB-10c A19 (review 17): a beforeunload is taken for the page's departure (revision 15's teardown: a page that goes on after a navigation answered with 204, a download or one cancelled leaves the failure it observed unprotected)",
    file: "src/features/tasks/catchup/lifecycle.ts",
    tests: [...RETRY_TESTS, "tests/features/tasks/catchup-lifecycle.test.ts"],
    expect:
      /R36-J (discovery|command|position) (lost-pending|failed-live): a beforeunload while the call is on its way|a beforeunload alone \(an abandoned navigation\): the page goes on|a beforeunload alone is none/,
    patch: (t) =>
      sub(
        t,
        "  const beforeunload = () => undefined;",
        "  const beforeunload = () => {\n    seq += 1;\n    hidden = seq;\n  };",
      ),
  },
  {
    id: "MU-3307",
    title:
      "R36-J: WEB-10c A19 (review 17; revision 16's native order): a judgement made during the page's pagehide dispatch is not a departure (a call Chromium cancels between the page's pagehide listeners, before the lifecycle's own runs, is taken for a failure observed live and stops the work for good)",
    file: "src/features/tasks/catchup/lifecycle.ts",
    tests: [...RETRY_TESTS, "tests/features/tasks/catchup-lifecycle.test.ts"],
    expect:
      /R36-J (discovery|command|position) order in-dispatch|a pagehide is a departure from its dispatch/,
    patch: (t) =>
      sub(
        t,
        "        (hidden > mark && hidden > shown) || dispatching(),",
        "        hidden > mark && hidden > shown,",
      ),
  },
  {
    id: "MU-3308",
    title:
      "R36-J/D1: WEB-10c A19 (review 17; Kieran's D1 decision): a transport failure the page observed is fenced only at its failed write, and only if the page has not departed by then (a page that leaves while its write is on its way, or whose runner ends first, leaves no stop)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /R36-J (discovery|command|position) (lost-pending: a beforeunload|order left-in-write|order after-a-task|order twice)/,
    patch: (t) =>
      sub(
        t,
        '    const early = keep === "always" || (keep === "observed" && !left);',
        '    const early = keep === "always";',
      ),
  },
  {
    id: "MU-3310",
    title:
      "R36-J: WEB-10c A19 (review 17; design assessment C4, invariant 6): a back-forward restore publishes only an outcome whose write failed (one withheld at its departure, its write on its way, is left unfenced)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /then a back-forward restore: fenced at the restore; the write fails/,
    patch: (t) =>
      sub(
        t,
        "        (record.failed || record.withheld || record.pending) &&",
        "        record.failed &&",
      ),
  },
  {
    id: "MU-3314",
    title:
      "R36-J: WEB-10c A19 (review 17; revision 16's native order): the production lifecycle never sees a pagehide being dispatched (its `window.event` reader always answers no)",
    file: "src/features/tasks/catchup/lifecycle.ts",
    tests: ["tests/features/tasks/catchup-lifecycle.test.ts"],
    expect: /a pagehide is a departure from its dispatch/,
    patch: (t) =>
      sub(
        t,
        '  return (window as { event?: Event }).event?.type === "pagehide";',
        "  return false;",
      ),
  },
  // ---- Revision 17 (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json; design assessment Q7)
  {
    id: "MU-3316",
    title:
      "R36-K: WEB-10c A19 (review 18): a lost-answer fence is rediscovered by work that does not hold the account's lock (a peer during the owner's repair transmits)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /failed-live: the write failed under the live owner: a peer in the first repair wait calls nothing|lost-pending: the write lost across disposal/,
    // Revision 17 (the owner's fence lock): without Web Locks no owner can be told gone either (`ownerGone`), which alone masks this
    // fault; the fault is made in both guards.
    patch: (t) =>
      sub(
        sub(t, "    if (locks === null) return null;\n", ""),
        "      if (locks === null) {\n        resolve(false);",
        "      if (locks === null) {\n        resolve(true);",
      ),
  },
  {
    id: "MU-3317",
    title:
      "R36-K: WEB-10c A19 (review 18): a rediscovered lost answer is counted at its ISSUE (paced from the issue, sooner than from its real observation)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /REVISION17 R36-K/,
    patch: (t) =>
      sub(
        t,
        '    { cause: "transport" },\n    now,\n    false,\n  );',
        '    { cause: "transport" },\n    s.issued as number,\n    false,\n  );',
      ),
  },
  {
    id: "MU-3318",
    title:
      "R36-K: WEB-10c A19 (review 18): an observed transport failure is fenced under its caller's own operation (never rediscovered: the reload stops for good)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /REVISION17 R36-K .*K WITNESS/,
    patch: (t) =>
      sub(
        t,
        '    const marks = keep === "observed" ? lostOf(op) : op;',
        "    const marks = op;",
      ),
  },
  {
    id: "MU-3319",
    title:
      "R36-K: WEB-10c A19 (review 18): a rediscovery ends every lost-answer fence of the caller, not only the instances it found",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /EXACT RETIREMENT/,
    patch: (t) =>
      sub(
        t,
        "    markers()?.retire(scopeOf(at.service), lostOf(op), seen);",
        "    markers()?.clear(scopeOf(at.service), lostOf(op));",
      ),
  },
  {
    id: "MU-3320",
    title:
      "R36-K: WEB-10c A19 (review 18): a lost-answer fence is rediscovered beside a fence of the caller's own operation (an earlier build's, a received answer's)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a fence under the caller's OWN operation/,
    patch: (t) =>
      sub(t, '    if (m.probe(scope, op) !== "unmarked") return null;\n', ""),
  },
  {
    id: "MU-3321",
    title:
      "R36-K: WEB-10c A19 (review 18): markers that cannot be read are taken as an orphaned fence (both guards: the caller's own fence unknown, the lost-answer fence unread)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /markers that cannot be read are not absence/,
    // Each guard alone is redundant for unreadable markers (each masks the other's fault), so the fault is made in both.
    patch: (t) =>
      sub(
        sub(
          t,
          '    if (m.probe(scope, op) !== "unmarked") return null;',
          '    if (m.probe(scope, op) === "marked") return null;',
        ),
        '    return seen.kind === "instance" && seen.instances.length > 0 ? seen : null;',
        '    return seen.kind !== "none" ? (seen as never) : null;',
      ),
  },
  {
    id: "MU-3322",
    title:
      "R36-K: WEB-10c A19 (review 18): a day's rediscovery whose write failed ends the fence it found (the outcome is then recorded nowhere)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /(command|position): a rediscovery whose write FAILS/,
    patch: (t) =>
      sub(
        t,
        "        if (out === null) return owns(at) ? storage() : lost(at);\n        if (!out.written) return storage();\n        retireLost(at, op, orphaned);",
        "        if (out === null || !out.written) retireLost(at, op, orphaned);\n        if (out === null) return owns(at) ? storage() : lost(at);\n        if (!out.written) return storage();",
      ),
  },
  {
    id: "MU-3323",
    title:
      "R36-K: WEB-10c A19 (review 18): a discovery's rediscovery whose write failed ends the fence it found",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /discovery: a rediscovery whose write FAILS/,
    patch: (t) =>
      sub(
        t,
        '      if (written === "lost") return end(lost(at));\n      if (written !== "written")\n        return end(stopInMemory(item.taskId, { reason: "storage" }));\n      retireLost(at, op, orphaned);',
        '      retireLost(at, op, orphaned);\n      if (written === "lost") return end(lost(at));\n      if (written !== "written")\n        return end(stopInMemory(item.taskId, { reason: "storage" }));',
      ),
  },
  {
    id: "MU-3324",
    title:
      "R36-K: WEB-10c A19 (review 18): the person's Try again on a memory stop is held by a fence that would be rediscovered (the page stays stopped until a reload)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a rediscovery whose write FAILS/,
    patch: (t) =>
      sub(
        t,
        // Revision 18 (R36-L): re-anchored over the per-caller rule (the same fault: any standing fence holds the press).
        "      fenced(at, op) && (lifts || orphan(at, op) === null);",
        "      fenced(at, op) && true;",
      ),
  },
  {
    id: "MU-3325",
    title:
      "R36-K: WEB-10c A19 (review 18): a rediscovered uncertain command loses its attempt (a new key is minted: the server cannot tell it from a second command)",
    file: MODEL,
    tests: RETRY_TESTS,
    expect: /REVISION17 R36-K/,
    patch: (t) =>
      sub(
        t,
        "  const next = { ...row, read_failures: lost.failures, schedule: lost };",
        "  const next = {\n    ...row,\n    attempt: null,\n    read_failures: lost.failures,\n    schedule: lost,\n  };",
      ),
  },
  {
    id: "MU-3326",
    title:
      "R36-K: WEB-10c A19 (review 18): a rediscovery begins the episode's window at the rediscovery (the window ends later than from the real first failure)",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /REVISION17 R36-K/,
    patch: (t) =>
      sub(
        t,
        "    { ...s, issued: null, since: s.since ?? s.issued },",
        "    { ...s, issued: null },",
      ),
  },
  {
    id: "MU-3327",
    title:
      "R36-K: WEB-10c A19 (review 18; the R36-I original found failing in the revision-17 replay): the page that keeps a lost-answer outcome never holds its fence's lock (a live owner whose repairs are spent is taken for gone)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a LIVE owner whose outcome cannot be written/,
    patch: (t) =>
      sub(
        t,
        "    if (locks === null || record.hold !== null) return;",
        "    return;",
      ),
  },
  {
    id: "MU-3328",
    title:
      "R36-K: WEB-10c A19 (review 18): a lost-answer fence is rediscovered while a live page holds its lock (the owner is always taken for gone)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a LIVE owner whose outcome cannot be written/,
    patch: (t) =>
      sub(
        t,
        "            resolve(lock !== null);",
        "            resolve(true);",
      ),
  },
  {
    id: "MU-3329",
    title:
      "R36-K: WEB-10c A19 (review 18; Firefox's crash cut found in the revision-17 replay): a day's fence whose outcome landed before its page went is kept (the reload stops for good)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /(command|position): CRASH CUT/,
    patch: (t) =>
      sub(
        t,
        "          if (!settledBehind(row)) return storage();",
        "          return storage();",
      ),
  },
  {
    id: "MU-3330",
    title:
      "R36-K: WEB-10c A19 (review 18; Firefox's crash cut): a discovery's fence whose outcome landed before its page went is kept (the reload stops for good)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /discovery: CRASH CUT/,
    patch: (t) =>
      sub(
        t,
        "        if (!counted(s))\n",
        "        if (!counted(s) || s !== undefined)\n",
      ),
  },
  {
    id: "MU-3331",
    title:
      "R36-K: WEB-10c A19 (review 18): a day's lost-answer fence over a row whose call is not recorded and counted (none outstanding, none counted) is ended",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a day's lost-answer fence over a row with no call outstanding/,
    patch: (t) =>
      sub(t, "          if (!settledBehind(row)) return storage();\n", ""),
  },
  {
    id: "MU-3332",
    title:
      "R36-K: WEB-10c A19 (review 18): a discovery's lost-answer fence with no entry behind it (nothing recorded, nothing counted) is ended",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /a lost-answer fence with NO call outstanding/,
    patch: (t) =>
      sub(
        t,
        '        if (!counted(s))\n          return end(stopInMemory(item.taskId, { reason: "storage" }));\n',
        "",
      ),
  },
  {
    id: "MU-3333",
    title:
      "R36-L: WEB-10c A19 (review 19): a discovery stop recorded on a lost call is shown without settling its standing lost-answer fence",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /REVISION18 R36-L discovery WITNESS \((crash|refused)\): a committed window pause/,
    patch: (t) =>
      sub(
        t,
        "      else if (orphaned !== null) {\n        await settleLost(at, op, discoveryStopped(at, item.taskId));\n        if (!owns(at)) return end(lost(at));\n      }\n",
        "",
      ),
  },
  {
    id: "MU-3334",
    title:
      "R36-L: WEB-10c A19 (review 19): a stopped row adopted on a lost call keeps its standing lost-answer fence",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /REVISION18 R36-L (command|position) WITNESS \((crash|refused)\): a committed window pause/,
    patch: (t) =>
      sub(
        t,
        "        await settleLost(\n          at,\n          fenceOf(key.task_id, key.through_date),\n          sequenceStopped(at, key),\n        );\n",
        "",
      ),
  },
  {
    id: "MU-3335",
    title:
      "R36-L: WEB-10c A19 (review 19): the person's Try again on a discovery stop does not settle its lost-answer fence before the lift",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /REVISION18 R36-L discovery WITNESS \(crash\): the person's Try again BEFORE/,
    patch: (t) =>
      sub(
        t,
        "      await settleLost(\n        at,\n        fenceOf(item.taskId),\n        discoveryStopped(at, item.taskId),\n      );\n",
        "",
      ),
  },
  {
    id: "MU-3336",
    title:
      "R36-L: WEB-10c A19 (review 19): the person's Try again on a day's stop does not settle its lost-answer fence before the lift",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /REVISION18 R36-L (command|position) WITNESS \(crash\): the person's Try again BEFORE/,
    patch: (t) =>
      sub(
        t,
        "      await settleLost(\n        at,\n        fenceOf(stopped.task_id, stopped.through_date),\n        sequenceStopped(at, {\n          task_id: stopped.task_id,\n          through_date: stopped.through_date,\n        }),\n      );\n",
        "",
      ),
  },
  {
    id: "MU-3337",
    title:
      "R36-L: WEB-10c A19 (review 19): a lost-answer fence is ended beside ANY record (the current record is not checked to be a lost call's stop)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /is NOT a lost call's stop/,
    patch: (t) =>
      sub(
        t,
        '          if (!(await stopped()) || !owns(at)) return "held";\n',
        '          if (!owns(at)) return "held";\n',
      ),
  },
  {
    id: "MU-3338",
    title:
      "R36-L: WEB-10c A19 (review 19): the settling of a paused record's fence does not ask for the fence's lock (a live owner's fence is ended)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /a LIVE page holding the fence's lock keeps the fence beside the paused record/,
    patch: (t) => sub(t, '          if (lock === null) return "held";\n', ""),
  },
  {
    id: "MU-3339",
    title:
      "R36-L: WEB-10c A19 (review 19): the fence is witnessed again AFTER the record is read (a newer instance published meanwhile is ended)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /EXACT INSTANCES: a newer lost-answer instance published while the paused record is read/,
    patch: (t) =>
      sub(
        t,
        "          retireLost(at, op, seen);\n          return fenced(at, op)",
        "          retireLost(at, op, orphan(at, op) ?? seen);\n          return fenced(at, op)",
      ),
  },
  {
    id: "MU-3340",
    title:
      "R36-L: WEB-10c A19 (review 19): a window pause after RECEIVED failures counts as a lost call's stop",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /anything else is not|RECEIVED failures \(503\)/,
    patch: (t) =>
      sub(
        t,
        '(s.pause === "window" && s.cause === "transport" && s.failures > 0)',
        '(s.pause === "window" && s.failures > 0)',
      ),
  },
  {
    id: "MU-3341",
    title:
      "R36-L: WEB-10c A19 (review 19): a window pause with no failure recorded counts as a lost call's stop",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /anything else is not|a window pause with no failure recorded/,
    patch: (t) =>
      sub(
        t,
        '(s.pause === "window" && s.cause === "transport" && s.failures > 0)',
        '(s.pause === "window" && s.cause === "transport")',
      ),
  },
  {
    id: "MU-3342",
    title:
      "R36-L: WEB-10c A19 (review 19): a lost call's CLOCK pause (no failure counted) is not recognised: its fence stands for good",
    file: "src/features/tasks/model/retry.ts",
    tests: RETRY_TESTS,
    expect: /CLOCK pause|under a clock moved back/,
    patch: (t) => sub(t, '  (s.pause === "clock" ||\n', "  (false ||\n"),
  },
  {
    id: "MU-3343",
    title:
      "R36-L: WEB-10c A19 (review 19): any stopped row (not only an unreachable one) with a lost call's schedule counts as a lost call's stop",
    file: MODEL,
    tests: RETRY_TESTS,
    expect: /no other row is/,
    patch: (t) =>
      sub(
        t,
        '  if (row.phase !== "stopped" || row.stop?.reason !== "unreachable")\n    return false;\n',
        '  if (row.phase !== "stopped") return false;\n',
      ),
  },
  {
    id: "MU-3344",
    title:
      "R36-L: WEB-10c A19 (review 19): a lift is held by another caller's lost-answer fence over a call still outstanding (revision 17's rule kept for both)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /is not held by the DAY's lost-answer fence/,
    patch: (t) =>
      sub(
        t,
        "      fenced(at, op) && (lifts || orphan(at, op) === null);",
        "      fenced(at, op) &&\n      (lifts || Boolean(seen?.stop) || stopped !== null || orphan(at, op) === null);",
      ),
  },
  {
    id: "MU-3345",
    title:
      "R36-L: WEB-10c A19 (review 19): settling a discovery stop's fence counts its lost call again (the recorded stop is rewritten)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect:
      /REVISION18 R36-L discovery WITNESS \((crash|refused)\): a committed window pause/,
    patch: (t) =>
      sub(
        t,
        "      else if (orphaned !== null) {\n        await settleLost(at, op, discoveryStopped(at, item.taskId));\n",
        "      else if (orphaned !== null) {\n        await commitMaterialiseDiscovery(at.service, at.service.capture(deps.epoch), {\n          task_id: item.taskId,\n          expected: entry,\n          next: { ...entry, failures: entry.failures + 1 },\n        });\n        await settleLost(at, op, discoveryStopped(at, item.taskId));\n",
      ),
  },
  {
    id: "MU-3346",
    title:
      "R36-L: WEB-10c A19 (review 19): the settling decision does not check its binding after its waits (a fence is ended in a gap of the binding)",
    file: "src/features/tasks/catchup/runner.ts",
    tests: RETRY_TESTS,
    expect: /the binding goes while the decision reads the paused record/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            '          if (!(await stopped()) || !owns(at)) return "held";\n',
            '          if (!(await stopped())) return "held";\n',
          ),
          "    if (entries === undefined || !owns(at)) return false;\n    const entry = entries[taskId] ?? null;\n",
          "    if (entries === undefined) return false;\n    const entry = entries[taskId] ?? null;\n",
        ),
        "    if (row == null || !owns(at)) return false;\n",
        "    if (row == null) return false;\n",
      ),
  },
  {
    id: "MU-3347",
    title:
      "R40: WEB-10c A12/A20 (review 20): the idle timer's clock knows no window boundary (Start keeps the state it was mounted with until a wake)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect:
      /by scheduled: the retained idle block changes Start at the boundary/,
    patch: (t) =>
      sub(
        t,
        "  const clock = useBoundaryClock(read, [occurrence]);\n",
        "  const clock = useBoundaryClock(read, []);\n",
      ),
  },
  {
    id: "MU-3348",
    title:
      "R40: WEB-10c A12/A20 (review 20): Start is not judged again when pressed (a control rendered before closure queues a start after it)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect:
      /a Start rendered before closure and pressed after it queues nothing/,
    patch: (t) =>
      sub(
        t,
        "    if (startBlock({ data: row.data, nowMs: at, mayRecord, running }) !== null)\n      return;\n",
        "",
      ),
  },
  {
    id: "MU-3349",
    title:
      "R40: WEB-10c A12/A20 (review 20): Start is judged at the instant it was RENDERED, not the instant it is pressed (and recorded)",
    file: "src/features/tasks/detail/Timer.tsx",
    tests: ["tests/features/tasks/timer-block.test.tsx"],
    expect:
      /a Start rendered before closure and pressed after it queues nothing/,
    patch: (t) =>
      sub(
        t,
        "    if (startBlock({ data: row.data, nowMs: at, mayRecord, running }) !== null)\n",
        "    if (startBlock({ data: row.data, nowMs: now, mayRecord, running }) !== null)\n",
      ),
  },
  {
    id: "MU-3350",
    title:
      "R41: WEB-10c A6 (review 20): the opening of a saved period not shown yet is not a boundary of the strip (it joins only at another change)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /a period opening that the strip does not show yet still ends the strip's validity/,
    patch: (t) =>
      sub(
        t,
        "          if (opening === null || at < opening) opening = at;\n",
        "          void at;\n",
      ),
  },
  {
    id: "MU-3351",
    title:
      "R41: WEB-10c A6 (review 20): the closing of a shown period is not a boundary of the strip (an open period stays open after it closed)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /close by scheduled: the retained strip finalises the period that closed/,
    patch: (t) => sub(t, "      next = closes;\n", "      void closes;\n"),
  },
  {
    id: "MU-3352",
    title:
      "R41: WEB-10c A6 (review 20): a local read that a boundary overtook is published as current",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /a read that a boundary overtakes is not published/,
    patch: (t) =>
      sub(
        t,
        '        if (read.kind !== "complete" || localCurrent(read.value, env.now()))\n',
        '        if (read.kind !== "complete" || true)\n',
      ),
  },
  {
    id: "MU-3353",
    title:
      "R41: WEB-10c A6 (review 20): the strip's validity is not checked on return to the page (focus, visible visibilitychange, pageshow)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /by (focus|visibilitychange|pageshow): the retained strip/,
    patch: (t) =>
      sub(
        t,
        '    document.addEventListener("visibilitychange", resume);\n    window.addEventListener("focus", resume);\n    window.addEventListener("pageshow", resume);\n',
        "",
      ),
  },
  {
    id: "MU-3354",
    title:
      "R41: WEB-10c A6 (review 20): no wait is armed for the strip's next boundary (an actively viewed page stays stale until a wake)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /by scheduled: the retained strip/,
    patch: (t) =>
      sub(
        t,
        "      timer = setTimeout(arm, Math.min(value.next * 1000 - t + 50, CAP));\n",
        "",
      ),
  },
  {
    id: "MU-3355",
    title:
      "R41: WEB-10c A6 (review 20): a clock that went back before the strip's evaluation does not end its validity (no reselection)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /a clock that goes back before a shown period opened selects again/,
    patch: (t) => sub(t, "  nowMs >= value.at && (", "  (true) && ("),
  },
  // Revision 20 (review 22 R42; design assessment of 5 November 2026, Q1-Q4 and Q7): the strip's failed or unstable read with a strip retained,
  // the paced attempts after a lapsed strip's re-read did not complete, their ownership, and the no-database presentation.
  {
    id: "MU-3356",
    title:
      "R42: WEB-10c A6 (review 22): the old status rule: a failed or unstable read is shown only when no strip is retained (a kept strip is shown as current)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 retained strip, a committed change's re-read fails: the cells are kept and marked as last read/,
    patch: (t) =>
      sub(
        t,
        "  const localError = noDatabase\n    ? null\n",
        "  const localError =\n    noDatabase || local.complete !== null\n    ? null\n",
      ),
  },
  {
    id: "MU-3357",
    title:
      "R42: WEB-10c A6 (review 22): the stale strip's Try again asks the server's figures again instead of reading the strip",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 figures (offline|ready|error): the stale strip has exactly one Try again of its own/,
    patch: (t) =>
      sub(
        t,
        "{copy.SHOWING_LAST_READ}</p>\n            <span>\n              <Button onClick={retryLocal}>",
        "{copy.SHOWING_LAST_READ}</p>\n            <span>\n              <Button onClick={figures.retry}>",
      ),
  },
  {
    id: "MU-3358",
    title:
      "R42: WEB-10c A6 (review 22): no paced attempt after a lapsed strip's re-read failed (the actively viewed page stays stale until a wake)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 scheduled boundary, ONE failed re-read: the lapsed strip is marked at once and the first paced attempt/,
    patch: (t) =>
      sub(
        t,
        "    const delay = expiryRetryDelay(step.current);\n",
        "    const delay = null as number | null;\n",
      ),
  },
  {
    id: "MU-3359",
    title:
      "R42: WEB-10c A6 (review 22): the paced attempts are not paced (each is asked at once: the occurrence walk repeated back to back)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 scheduled boundary, (a fault that stays: .*the paced attempts are bounded|ONE failed re-read: .*first paced attempt)/,
    // Re-anchored in revision 20 (the unified watcher, after the scheduled unstable case found a dormant watcher): the same fault (attempts at once).
    patch: (t) =>
      sub(
        t,
        "            latest.current.expire();\n          }, delay);\n",
        "            latest.current.expire();\n          }, 0);\n",
      ),
  },
  {
    id: "MU-3360",
    title:
      "R42: WEB-10c A6 (review 22): a paced attempt does not advance the ladder (the first wait repeats for ever while the fault stays)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 scheduled boundary, a fault that stays: the strip stays marked with its Try again and the paced attempts are bounded/,
    // Re-anchored in revision 20 (the unified watcher, after the scheduled unstable case found a dormant watcher): the same fault (the ladder not advanced).
    patch: (t) =>
      sub(
        t,
        "            step.current += 1;\n            latest.current.expire();\n",
        "            latest.current.expire();\n",
      ),
  },
  {
    id: "MU-3361",
    title:
      "R42: WEB-10c A6 (review 22): the ladder never ends (after the last wait the longest one repeats for ever)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /R42 the paced attempts are finite: 2 s, 10 s and 60 s, then none/,
    patch: (t) =>
      sub(
        t,
        "  step >= 0 && step < EXPIRY_RETRIES_MS.length\n",
        "  step >= 0 && step < EXPIRY_RETRIES_MS.length + Number.MAX_SAFE_INTEGER\n",
      ),
  },
  {
    id: "MU-3362",
    title:
      "R42: WEB-10c A6 (review 22): a failed re-read detaches the return-to-page listeners (a later wake no longer reads the strip again)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 (focus|visibilitychange|pageshow) after a period (opened|closed) with a fault: .*a later wake with the fault gone is current/,
    // Re-anchored in revision 20 (the unified watcher, after the scheduled unstable case found a dormant watcher): the same fault, more exactly: only the return-to-page listeners are left off while the last read did not complete.
    patch: (t) =>
      sub(
        t,
        '    document.addEventListener("visibilitychange", resume);\n    window.addEventListener("focus", resume);\n    window.addEventListener("pageshow", resume);\n',
        '    if (!failing) {\n      document.addEventListener("visibilitychange", resume);\n      window.addEventListener("focus", resume);\n      window.addEventListener("pageshow", resume);\n    }\n',
      ),
  },
  {
    id: "MU-3363",
    title:
      "R42: WEB-10c A6 (review 22): a due paced attempt is not cancelled when the scope changes (another identity or task reads again for it)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 another (identity|task) while a paced attempt is due: the old scope's attempt never runs/,
    // Re-anchored in revision 20 (the unified watcher, after the scheduled unstable case found a dormant watcher): the same fault: the cleanup no longer cancels a due wait (the listeners are still removed).
    patch: (t) =>
      sub(
        t,
        "    return () => {\n      clearTimeout(timer);\n      document.removeEventListener",
        "    return () => {\n      document.removeEventListener",
      ),
  },
  {
    id: "MU-3364",
    title:
      "R42: WEB-10c A6 (review 22): a kept empty strip whose re-read failed says 'Nothing to show yet.' (unknown shown as empty)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 (focus|visibilitychange|pageshow) after a period opened with a fault: the kept strip is marked at once/,
    patch: (t) =>
      sub(t, "          stale ? null : (\n", "          false ? null : (\n"),
  },
  {
    id: "MU-3365",
    title:
      "R42: WEB-10c A6 (review 22, Q7): with no database on this device the strip shows its loading skeleton for ever",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 no database on this device: the page says the task is not on this device/,
    patch: (t) =>
      sub(
        t,
        "        {noDatabase || failed ? null : value === null ? (\n",
        "        {failed ? null : value === null ? (\n",
      ),
  },
  {
    id: "MU-3368",
    title:
      "R42: WEB-10c A6 (review 22): a kept strip still current after a read that did not complete never waits for its boundary again (the watcher goes dormant once an expiry consumed its wait)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect:
      /R42 scheduled boundary whose expiry re-read keeps changing, the clock last read before it: .*the watcher stays armed/,
    patch: (t) =>
      sub(
        t,
        "      if (value.next === null) return;\n      timer = setTimeout(arm, Math.min(",
        "      if (value.next === null || failing) return;\n      timer = setTimeout(arm, Math.min(",
      ),
  },
];

/** Real-engine mutants (all three engines on macOS, one job with its control; `grep` names the native case written for each). */
export const ENGINE_10C = [
  {
    id: "MU-3051",
    title:
      "N-10C-01: WEB-10c N-M4: (REAL ENGINE) the account's lock is ignored, so two tabs run the same sequence",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M4:",
    expect: /E-M4:/,
    patch: (t) =>
      sub(
        t,
        "  const locks =\n    deps.locks === undefined\n      ? (globalThis.navigator?.locks ?? null)\n      : deps.locks;",
        "  const locks = null as LockManager | null;",
      ),
  },
  {
    id: "MU-3052",
    title:
      "N-10C-02: WEB-10c N-M2: (REAL ENGINE) the attempt sent is not the one written before the send (a reload resends another key)",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M2: .*held in submitting",
    expect: /E-M2:/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 11): the call is indented one level deeper (its permission is asked first); the same fault.
        "            JSON.parse(attempt.body) as MaterialiseCommand,\n            attempt.key,",
        "            JSON.parse(attempt.body) as MaterialiseCommand,\n            deps.newId(),",
      ),
  },
  {
    id: "MU-3054",
    title:
      "N-10C-04: WEB-10c N-D1: (REAL ENGINE) the dialog's opener is replaced on every render, so focus cannot return to it",
    file: "src/features/tasks/detail/Dependencies.tsx",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-D1:",
    expect: /E-D1:/,
    patch: (t) =>
      sub(
        t,
        "            <Button onClick={onSee}>{DEPENDENCY_COPY.see}</Button>",
        "            <Button key={String(Math.random())} onClick={onSee}>{DEPENDENCY_COPY.see}</Button>",
      ),
  },
  {
    id: "MU-3260",
    title:
      "N-10C-R36a: WEB-10c A19 (review 12): (REAL ENGINE) a reconnection reads only the first page of the account's rows",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M11:",
    expect: /150 other tasks' rows sort first/,
    patch: (t) =>
      sub(
        t,
        "        if (page.complete || last === undefined) break;",
        "        if (page.complete || last !== null) break;",
      ),
  },
  {
    id: "MU-3261",
    title:
      "N-10C-R36b: WEB-10c A19 (review 12): (REAL ENGINE) a standing fence (a marker in localStorage) is never consulted after a reload",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M11:",
    expect: /fences it across a full reload/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 17, R36-K): the caller is fenced under its own or its lost-answer operation; the same fault, on both.
        '      (o) => m.stops.has(scope, o) || m.probe(scope, o) !== "unmarked",',
        "      (o) => m.stops.has(scope, o) && false,",
      ),
  },
  // ---- Revision 15 (review 16's R36-H/I; design assessment Q5/Q7): the native lifecycle and first-outcome-write cases ----------------
  {
    id: "MU-3304",
    title:
      "N-10C-R15b: WEB-10c A19 (review 16): (REAL ENGINE) a transport failure a live page observed is not fenced before its outcome is first written",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M12b",
    expect: /E-M12b/,
    patch: (t) =>
      // Revision 16: the parameter is `departed` (a `pagehide`, never a `beforeunload` alone); the same fault.
      sub(
        t,
        '  answer.kind === "uncertain" && (!departed || receivedFailure(answer));',
        '  answer.kind === "uncertain" && receivedFailure(answer);',
      ),
  },
  {
    id: "MU-3305",
    title:
      "N-10C-R15c: WEB-10c A19 (review 16): (REAL ENGINE) a failed outcome write on a live page is fenced only once its repairs are spent (revision 14's delay)",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M12c",
    expect: /E-M12c/,
    patch: (t) =>
      // Revision 16: re-anchored on `left` (the page's departure since the call), the same fault.
      sub(
        t,
        '      if (verdict === "stale" || !left(record)) {',
        '      if (verdict === "stale" || (!left(record) && wait === undefined)) {',
      ),
  },
  {
    id: "MU-3313",
    title:
      "N-10C-R16a: WEB-10c A19 (review 17's R36-J): (REAL ENGINE) the page's beforeunload is taken for its departure (revision 15's listener: a navigation answered with 204 leaves a live page's failed outcome write unfenced, and another tab reads again)",
    file: "src/features/tasks/catchup/lifecycle.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M12f",
    expect: /E-M12f/,
    // Re-anchored in revision 16 after driver run 2026-11-02T15-53-47.777Z-77b6acb5 (kept: not caught, all three engines passed): its
    // first patch changed the lifecycle double's `beforeunload` input, which the production page never calls (it observes no
    // `beforeunload`), so it was equivalent in the composed app. The production fault is revision 15's listener.
    patch: (t) =>
      sub(
        t,
        '      window.addEventListener("pagehide", () => created.pagehide());',
        '      window.addEventListener("beforeunload", () => created.pagehide());\n      window.addEventListener("pagehide", () => created.pagehide());',
      ),
  },
  {
    id: "MU-3315",
    title:
      "N-10C-R16b: WEB-10c A19 (review 17's R36-J; Kieran's D1 decision): (REAL ENGINE) a discovery's answer is judged a task after it is delivered (a genuine failure the page observed just before its pagehide is taken for a departure and left unfenced)",
    file: "src/features/tasks/catchup/runner.ts",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-M12h",
    expect: /E-M12h \(R36-J\) discovery/,
    patch: (t) =>
      sub(
        t,
        "      ? await readPosition(item.taskId, permit)\n      : { answer: UNSENT, zone: null };\n",
        "      ? await readPosition(item.taskId, permit)\n      : { answer: UNSENT, zone: null };\n    await new Promise<void>((r) => setTimeout(r, 0));\n",
      ),
  },
  // Revision 20 (review 22 R42; design assessment Q6): the stale strip's status rule and its paced attempt over real IndexedDB.
  {
    id: "MU-3366",
    title:
      "N-10C-R20a: WEB-10c A6 (review 22's R42): (REAL ENGINE) the old status rule: a kept strip whose re-read failed is shown as current (no stale marking, no local Try again)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-S4 close by focus, a fault that stays",
    expect: /E-S4 close by focus, a fault that stays/,
    patch: (t) =>
      sub(
        t,
        "  const localError = noDatabase\n    ? null\n",
        "  const localError =\n    noDatabase || local.complete !== null\n    ? null\n",
      ),
  },
  {
    id: "MU-3367",
    title:
      "N-10C-R20b: WEB-10c A6 (review 22's R42): (REAL ENGINE) no paced attempt after a lapsed strip's re-read failed (an actively viewed page stays stale until a wake)",
    file: "src/features/tasks/streak/StreakPage.tsx",
    spec: "tests/e2e/fixture.tasks-10c.spec.ts",
    grep: "E-S4 close scheduled, ONE failed re-read",
    expect: /E-S4 close scheduled, ONE failed re-read/,
    patch: (t) =>
      sub(
        t,
        "    const delay = expiryRetryDelay(step.current);\n",
        "    const delay = null as number | null;\n",
      ),
  },
];

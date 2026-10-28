// WEB-10c's mutants (plan §7.4: catch-up, streak, dependencies, timers, rotas and the W27/W28 records), numbered MU-3001… (the plan's
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
//    through W28's guards; the identity cases are MU-10C-12 (plan) and MU-10C-12 (screen), so a native switch adds no sensitivity.
//  - MU-3164 (revision 6, R29: work whose implicit today resolved keeps its unresolved `currentKey`): the only schedule it changes is the
//    same day asked explicitly during the `clearSatisfied` await between the zone being found and the day being marked `attempted`; there
//    the duplicate is ended by `attempted` after one more position read (no send). The IndexedDB double has no resumable hold for that
//    transaction, so no deterministic test can observe it; the re-key stays as bookkeeping, and its control test passes before and after.
import { sub } from "./data-catalogue.mjs";

const MODEL = "src/features/tasks/model/materialise.ts";
const RUNNER_TESTS = [
  "tests/features/tasks/materialise-model.test.ts",
  "tests/features/tasks/catchup-runner.test.ts",
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
        '    phase: row.attempt === null ? "ready" : "submitting",\n    successful_calls: 0,',
        '    phase: row.attempt === null ? "ready" : "submitting",\n    last_known_position: null,\n    successful_calls: 0,',
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
        '    phase: row.attempt === null ? "ready" : "submitting",\n    successful_calls: 0,',
        '    phase: row.attempt === null ? "ready" : "submitting",\n    successful_calls: row.successful_calls,',
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
        '      const failures = row.read_failures + 1;\n      const next = { ...row, read_failures: failures };\n      return failures >= MAX_READ_FAILURES\n        ? stopped(next, "unreachable", answer.requestId)',
        '      const failures = row.read_failures + 1;\n      const next = { ...row, attempt: null, read_failures: failures };\n      return failures >= MAX_READ_FAILURES\n        ? stopped(next, "unreachable", answer.requestId)',
      ),
  },
  {
    id: "MU-3007",
    title:
      "MU-10C-07: WEB-10c W27: the compare-and-set ignores the sequence's generation",
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
        '      if (stored.phase === "stopped") return DONE;\n',
        '      if (stored.phase === "stopped") {\n' +
          "        const again = await commit(service, captured, key, stored, freshBudget(stored));\n" +
          "        if (again?.stored) await drive(at, again.stored, today);\n" +
          "        return DONE;\n" +
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
        '    case "rejected":\n      return stopped({ ...row, attempt: null }, "rejected", answer.requestId);\n    case "capacity":',
        '    case "rejected":\n      return stopped({ ...row, attempt: null }, "no_progress", answer.requestId);\n    case "capacity":',
      ),
  },
  {
    id: "MU-3011",
    title:
      "MU-10C-11: WEB-10c W27: a compare-and-set writes over a row it did not decide on",
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
      "MU-10C-12: WEB-10c W28: the timer copy's write applies no guard (another incarnation or an earlier epoch is written)",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /MU-10C-12/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored (revision 3): two W28 plans are admitted now; this is the copy's write.
        'name: "data.writeTimerCopy",\n  meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: "cache" },',
        'name: "data.writeTimerCopy",\n  meta: { writer: "W28", guards: [], quota: "cache" },',
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
      sub(
        t,
        "        ? (submitted.prerequisites as string[])\n        : [],",
        "        ? (submitted.prerequisites as string[])\n        : preview\n          ? prerequisitesOf(preview, row.id).map((i) => i.occurrence_id)\n          : [],",
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
    file: "src/features/tasks/detail/Rota.tsx",
    tests: ["tests/features/tasks/rota.test.tsx"],
    expect: /MU-10C-25\/26/,
    patch: (t) =>
      sub(
        t,
        "  const attempt = nextAttempt(\n    attemptOf(env.identity, memoryKey),\n    command,\n    env.newId,\n  );",
        "  const attempt = nextAttempt(null, command, env.newId);",
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
        '      if (outcome.kind === "paused") park(item, outcome.throughDate);\n',
        '      if (outcome.kind === "paused") void item;\n',
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
    patch: (t) => sub(t, "      if (unpark()) publishQueue();\n", ""),
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
      "DA-T1: WEB-10c W28: a replacement is compared with the copy alone, not the fence a day's correction moved",
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
      "DA-T2: WEB-10c W28: two reads are ordered by the device clock of their issue (the pre-revision rule)",
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
        "      ...(entry ?? NO_DISCOVERY),\n      attempt: deps.newId(),",
        "      ...NO_DISCOVERY,\n      retry: entry?.retry ?? 0,\n      attempt: deps.newId(),",
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
        "            retry: seen.retry + 1,\n",
        "            retry: seen.retry,\n",
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
      "DA-T3: WEB-10c W28: a day's observation is recorded although its growth was not admitted",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /growth the quota ledger refused/,
    patch: (t) =>
      sub(t, "      if (admitted) {", "      if (true as boolean) {"),
  },
  {
    id: "MU-3096",
    title:
      "DA-T3: WEB-10c W28: an evicted day's observation is dropped without raising the floor",
    file: "src/data/plans/timer-copy.ts",
    tests: ["tests/data/materialise-plans.test.ts"],
    expect: /at most 100 days/,
    patch: (t) =>
      sub(t, "      floor = Math.max(floor, out[id]?.seen ?? 0);\n", ""),
  },
  {
    id: "MU-3097",
    title:
      "R16: WEB-10c W27: a new task's discovery entry is written although the quota ledger refused it",
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
      "R16: WEB-10c W27: an answer is recorded over another page's admitted read (the attempt is not compared)",
    file: "src/data/plans/materialise.ts",
    tests: [
      "tests/data/materialise-plans.test.ts",
      "tests/features/tasks/catchup-runner.test.ts",
    ],
    expect: /only over its own admitted attempt|two pages without Web Locks/,
    patch: (t) =>
      sub(
        t,
        "      (a.stop === null) === (b.stop === null) &&\n      (a.attempt ?? null) === (b.attempt ?? null);",
        "      (a.stop === null) === (b.stop === null);",
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
    patch: (t) => sub(t, "      item.retry.service === service &&\n", ""),
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
      sub(
        t,
        "      else floor = Math.max(floor, lostAt(value, issued));\n",
        "",
      ),
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
    expect: /a Stop whose session is recorded finished while the act waits/,
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
    patch: (t) => sub(t, "            throughDate: key.through_date,\n", ""),
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
        "          JSON.parse(attempt.body) as MaterialiseCommand,\n          attempt.key,",
        "          JSON.parse(attempt.body) as MaterialiseCommand,\n          deps.newId(),",
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
];

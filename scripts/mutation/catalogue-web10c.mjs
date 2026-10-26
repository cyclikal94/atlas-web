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
          "        if (again?.stored) await drive(again.stored, today);\n" +
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
        'meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: "cache" },',
        'meta: { writer: "W28", guards: [], quota: "cache" },',
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
        '    advisory_override: preview.strict ? "strict" : null,',
        "    advisory_override: null,",
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
        '      if (outcome.kind === "paused") park(item, outcome.throughDate);\n',
        "",
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
        "      if (unpark(taskId)) {\n        publishQueue();\n        pump();\n        return;\n      }\n",
        "",
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
        "    if (readSupersedesCopy && !listed.has(s.id)) continue;\n",
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
        "      <CatchUpNotice taskId={task.id} title={task.label} />\n",
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
    patch: (t) =>
      sub(
        t,
        "      if (current.current !== asked) return;\n      setState({\n        scope: asked,",
        "      setState({\n        scope: current.current,",
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
        "    input.readOrder > input.copyOrder;",
        "    input.readOrder >= input.copyOrder;",
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
        '    if (entry?.stop) return { kind: "end", outcome: DONE };\n',
        "",
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
        '    if (entry?.stop) return { kind: "end", outcome: DONE };\n',
        '    if (entry?.stop) return { kind: "end", outcome: DONE };\n    if (entry !== null) entry = null;\n',
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
        "          next: { retry: seen.retry + 1, failures: 0, stop: null },\n",
        "          next: { retry: seen.retry, failures: 0, stop: null },\n",
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
          '    if (state.unrecorded.has(item.taskId))\n      return { kind: "end", outcome: DONE };\n',
          "",
        ),
        "      if (state.unrecorded.has(taskId)) return;\n",
        "",
      ),
  },
  {
    id: "MU-3083",
    title:
      "R13: WEB-10c A5: the streak reads past a stopped discovery as if the catch-up had finished",
    file: "src/features/tasks/streak/StreakPage.tsx",
    tests: ["tests/features/tasks/streak-page.test.tsx"],
    expect: /the streak shows the recorded stop/,
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
        "  const found = discovery[taskId]?.stop;\n  if (found)",
        "  const found = discovery[taskId]?.stop;\n  if (false as boolean && found)",
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBudget,
  judge,
  mergeFacts,
  overall,
  project,
  schedule,
  settleStack,
  withCancellation,
} from "./outcome.mjs";

const at = Date.parse("2026-10-13T12:00:00.000Z");
const spec = (id, status, project = "integration-chromium") => ({
  id,
  title: id,
  file: "a.spec.ts",
  tests: [
    {
      projectName: project,
      status,
      results: status === "skipped" ? [] : [{ status: "passed" }],
    },
  ],
});
const report = (specs, startTime = new Date(at + 500).toISOString()) => ({
  stats: { startTime },
  errors: [],
  suites: [{ title: "a.spec.ts", specs }],
});
const expected = (...ids) =>
  ids.map((id) => ({ key: `integration-chromium|${id}`, title: id }));
const clean = { code: 0, signal: null };

test("a complete fresh report of the planned cases and a clean exit is a pass; skipped stays skipped", () => {
  const r = judge({
    expected: expected("a", "b"),
    report: report([spec("a", "expected"), spec("b", "skipped")]),
    exit: clean,
    launchedAt: at,
  });
  assert.equal(r.outcome, "passed");
  assert.deepEqual(r.counts, {
    passed: 1,
    failed: 0,
    skipped: 1,
    flaky: 0,
    interrupted: 0,
    not_run: 0,
  });
  assert.deepEqual(r.skipped, ["b"]);
});

test("a failed, flaky, missing or unplanned case is not a pass", () => {
  const failed = judge({
    expected: expected("a", "b"),
    report: report([spec("a", "expected"), spec("b", "unexpected")]),
    exit: { code: 1, signal: null },
    launchedAt: at,
  });
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.failed, ["b"]);
  const flaky = judge({
    expected: expected("a"),
    report: report([spec("a", "flaky")]),
    exit: clean,
    launchedAt: at,
  });
  assert.equal(flaky.outcome, "failed");
  const missing = judge({
    expected: expected("a", "b"),
    report: report([spec("a", "expected")]),
    exit: clean,
    launchedAt: at,
  });
  assert.equal(missing.outcome, "incomplete");
  assert.deepEqual(missing.missing, ["b"]);
  const extra = judge({
    expected: expected("a"),
    report: report([spec("a", "expected"), spec("z", "expected")]),
    exit: clean,
    launchedAt: at,
  });
  assert.equal(extra.outcome, "incomplete");
  assert.deepEqual(extra.extra, ["z"]);
});

test("a missing, unreadable or earlier report is never this launch's pass", () => {
  assert.equal(
    judge({
      expected: expected("a"),
      report: null,
      readError: "ENOENT",
      exit: { code: null, signal: "SIGTERM" },
      launchedAt: at,
    }).outcome,
    "incomplete",
  );
  const stale = judge({
    expected: expected("a"),
    report: report(
      [spec("a", "expected")],
      new Date(at - 60_000).toISOString(),
    ),
    exit: clean,
    launchedAt: at,
  });
  assert.equal(stale.outcome, "incomplete");
  assert.match(stale.reason, /not written by this launch/);
});

test("the exit and the report must agree", () => {
  const nonZero = judge({
    expected: expected("a"),
    report: report([spec("a", "expected")]),
    exit: { code: 1, signal: null },
    launchedAt: at,
  });
  assert.equal(nonZero.outcome, "failed");
  const signal = judge({
    expected: expected("a"),
    report: report([spec("a", "expected")]),
    exit: { code: null, signal: "SIGKILL" },
    launchedAt: at,
  });
  assert.equal(signal.outcome, "failed");
  const errors = judge({
    expected: expected("a"),
    report: {
      ...report([spec("a", "expected")]),
      errors: [{ message: "reporter broke" }],
    },
    exit: clean,
    launchedAt: at,
  });
  assert.equal(errors.outcome, "failed");
  const spawn = judge({
    expected: expected("a"),
    report: null,
    exit: { code: null, signal: null, spawnError: "ENOENT" },
    launchedAt: at,
  });
  assert.equal(spawn.outcome, "error");
});

/** A launch adapter that records what it launched and answers from a script. */
function adapter(script = {}) {
  const launched = [];
  return {
    launched,
    launch: async (browser, stack) => {
      const name = `${browser}${stack.suffix}`;
      launched.push(name);
      const answer = script[name];
      if (answer instanceof Error) throw answer;
      return answer ?? { outcome: "passed" };
    },
  };
}
const STACKS = [{ suffix: "" }, { suffix: "-a" }, { suffix: "-b" }];
const BROWSERS = ["chromium", "firefox", "webkit"];

test("a healthy plan launches every stack of every browser exactly once, in order", async () => {
  const a = adapter();
  const r = await schedule({
    browsers: BROWSERS,
    stacks: STACKS,
    launch: a.launch,
  });
  assert.equal(r.passed, true);
  assert.deepEqual(a.launched, [
    "chromium",
    "chromium-a",
    "chromium-b",
    "firefox",
    "firefox-a",
    "firefox-b",
    "webkit",
    "webkit-a",
    "webkit-b",
  ]);
  assert.equal(r.records.length, 9);
});

for (const [where, name] of [
  ["the first stack", "chromium"],
  [
    "the last stack of a browser (the next browser is not launched)",
    "chromium-b",
  ],
  ["a stack of the last browser", "webkit-a"],
])
  for (const [kind, answer, outcome] of [
    [
      "an assertion failure",
      { outcome: "failed", reason: "1 failed" },
      "failed",
    ],
    ["a preparation error", new Error("backend did not become ready"), "error"],
    [
      "a missing report",
      { outcome: "incomplete", reason: "no readable report" },
      "incomplete",
    ],
    [
      "a clean-up failure",
      { outcome: "cleanup_failed", reason: "listener" },
      "cleanup_failed",
    ],
  ])
    test(`${kind} at ${where} launches nothing after it and records the rest not_run`, async () => {
      const a = adapter({ [name]: answer });
      const seen = [];
      const r = await schedule({
        browsers: BROWSERS,
        stacks: STACKS,
        launch: a.launch,
        onRecord: (record) => seen.push(record.outcome),
      });
      assert.equal(r.passed, false);
      assert.equal(a.launched.at(-1), name);
      const failedAt = a.launched.length - 1;
      assert.equal(r.records[failedAt].outcome, outcome);
      assert.equal(r.records.length, 9);
      for (const later of r.records.slice(failedAt + 1)) {
        assert.equal(later.outcome, "not_run");
        assert.match(
          later.reason,
          new RegExp(`not launched: integration-${name.split("-")[0]}`),
        );
      }
      assert.equal(seen.length, 9);
    });

test("a latched stop (a signal) launches nothing further", async () => {
  let latch = null;
  const a = adapter();
  const r = await schedule({
    browsers: BROWSERS,
    stacks: STACKS,
    latched: () => latch,
    launch: async (browser, stack) => {
      const out = await a.launch(browser, stack);
      latch = "received SIGTERM";
      return out;
    },
  });
  assert.deepEqual(a.launched, ["chromium"]);
  assert.equal(r.passed, false);
  assert.equal(r.records[1].reason, "not launched: received SIGTERM");
});

test("a cancelled preparation is recorded as cancelled, not as an error", async () => {
  const cancelled = new Error("stopped: received SIGINT");
  cancelled.name = "Cancelled";
  const a = adapter({ chromium: cancelled });
  const r = await schedule({
    browsers: ["chromium"],
    stacks: STACKS,
    launch: a.launch,
  });
  assert.equal(r.records[0].outcome, "cancelled");
  assert.deepEqual(a.launched, ["chromium"]);
});

test("a case interrupted part-way is counted as interrupted, not skipped, and the run is incomplete", () => {
  const stopped = {
    id: "b",
    title: "b",
    file: "a.spec.ts",
    tests: [
      {
        projectName: "integration-chromium",
        status: "skipped",
        results: [{ status: "interrupted" }],
      },
    ],
  };
  const r = judge({
    expected: expected("a", "b"),
    report: report([spec("a", "expected"), stopped]),
    exit: { code: 130, signal: null },
    launchedAt: at,
  });
  assert.equal(r.outcome, "incomplete");
  assert.equal(r.counts.interrupted, 1);
  assert.equal(r.counts.skipped, 0);
  assert.deepEqual(r.interrupted, ["b"]);
});

const admissions = (peak, refused = 0) => ({
  sliding_peak_60s: peak,
  limit: 120,
  within_limit: peak <= 120,
  rate_limited: Array.from({ length: refused }, () => ({ kind: "activation" })),
});

test("a passing stack whose sign-in traffic went over the source budget is not a pass", () => {
  assert.equal(
    applyBudget({ outcome: "passed" }, admissions(120)).outcome,
    "passed",
  );
  const over = applyBudget({ outcome: "passed" }, admissions(126, 6));
  assert.equal(over.outcome, "budget_exceeded");
  assert.match(over.reason, /126 source uses within 60 s .* 6 answered 429/);
  // A failure keeps its own outcome; the budget is recorded beside it.
  // Adapted, labelled (review r7 H4c, revision 8): the hand-made record now carries the counts every failed-case record from
  // `judge` has. A `failed` label with no failure fact is what a stop may have caused (an exit with nothing failed in the report),
  // and an excess outranks that, as it outranks a cancellation; the intent (a failed case keeps its outcome) is unchanged.
  const failed = applyBudget(
    { outcome: "failed", reason: "1 failed", counts: { failed: 1, flaky: 0 } },
    admissions(126, 6),
  );
  assert.equal(failed.outcome, "failed");
  assert.match(failed.budget_exceeded, /126 source uses/);
  // A principal refusal (I-30b's) within the source budget changes nothing.
  assert.equal(
    applyBudget({ outcome: "passed" }, admissions(44, 2)).outcome,
    "passed",
  );
});

test("I4: a stop keeps what the stack established; only what the stop itself caused becomes cancelled", () => {
  const failedReport = {
    outcome: "failed",
    reason: "1 failed",
    counts: { failed: 1, flaky: 0 },
  };
  assert.deepEqual(withCancellation(failedReport, "received SIGTERM"), {
    ...failedReport,
    cancellation: "received SIGTERM",
  });
  const passed = { outcome: "passed", reason: null };
  assert.equal(withCancellation(passed, "received SIGTERM").outcome, "passed");
  assert.equal(
    withCancellation({ outcome: "budget_exceeded" }, "x").outcome,
    "budget_exceeded",
  );
  const interrupted = {
    outcome: "incomplete",
    reason: "0 planned case(s) missing, 0 unplanned, 1 interrupted, 0 not run",
  };
  assert.deepEqual(withCancellation(interrupted, "received SIGTERM"), {
    outcome: "cancelled",
    reason: "stopped: received SIGTERM",
    cancellation: "received SIGTERM",
    before_cancellation: interrupted,
  });
  // An exit failure with no failed case (Playwright stopped by the signal) is the stop's doing.
  assert.equal(
    withCancellation(
      { outcome: "failed", counts: { failed: 0, flaky: 0 } },
      "x",
    ).outcome,
    "cancelled",
  );
  assert.equal(withCancellation(failedReport, null), failedReport);
});

test("I4: the run's outcome: a failure before a signal stays a failure; a cancellation is never a pass; incomplete is a failure", () => {
  const rec = (outcome) => ({ outcome });
  assert.equal(
    overall([rec("failed"), rec("cancelled"), rec("not_run")], {
      signalled: "SIGTERM",
      planned: 3,
    }),
    "failed",
  );
  assert.equal(
    overall([rec("passed"), rec("cancelled"), rec("not_run")], {
      signalled: "SIGTERM",
      planned: 3,
    }),
    "cancelled",
  );
  assert.equal(
    overall([rec("passed"), rec("passed")], {
      signalled: "SIGINT",
      planned: 2,
    }),
    "cancelled",
  );
  assert.equal(
    overall([rec("passed"), rec("passed")], { planned: 2 }),
    "passed",
  );
  assert.equal(
    overall([rec("passed")], { planned: 2 }),
    "failed",
    "a plan not fully run is not a pass",
  );
  for (const outcome of [
    "cleanup_failed",
    "evidence_failed",
    "budget_exceeded",
    "error",
    "incomplete",
  ])
    assert.equal(
      overall([rec("passed"), rec(outcome)], { planned: 2 }),
      "failed",
      outcome,
    );
});

// ---- review r7 H4c (revision 8): an established failure survives every later stop, audit, clean-up and finaliser ---------------
const oneCase = expected("probe");
const reportOf = (status, result, errors = []) => ({
  ...report([
    {
      id: "probe",
      title: "probe",
      file: "a.spec.ts",
      tests: [
        {
          projectName: "integration-chromium",
          status,
          results: [{ status: result }],
        },
      ],
    },
  ]),
  errors,
});
const judged = (r, exit, stop) =>
  judge({ expected: oneCase, report: r, exit, launchedAt: at, stop });
const SIGTERM = "received SIGTERM";
const within = admissions(40);
const over = admissions(121, 1);
const verified = { ok: true };
const unverified = { ok: false, errors: ["a container is left"] };
/** The run as the runner sees it: the stack settled with a later stop, then the run's outcome after a signal. */
const run = (record, extra = {}) => {
  const settled = settleStack(record, {
    stop: SIGTERM,
    cleanup: verified,
    ...extra,
  });
  return {
    settled,
    overall: overall([settled], { signalled: "SIGTERM", planned: 1 }),
  };
};

test("H4c control: a failed case stays failed through a later stop", () => {
  const { settled, overall: o } = run(
    judged(reportOf("unexpected", "failed"), { code: 1 }, null),
  );
  assert.equal(settled.outcome, "failed");
  assert.equal(settled.cancellation, SIGTERM);
  assert.deepEqual(
    settled.failures?.map((f) => f.kind),
    ["cases"],
  );
  assert.equal(o, "failed");
});

test("H4c control: a case interrupted by the stop is cancelled, and so is the run", () => {
  const { settled, overall: o } = run(
    judged(reportOf("skipped", "interrupted"), { code: 130 }, SIGTERM),
  );
  assert.equal(settled.outcome, "cancelled");
  assert.equal(settled.before_cancellation?.outcome, "incomplete");
  assert.deepEqual(settled.failures, []);
  assert.equal(o, "cancelled");
});

test("H4c: every case passed but the report has an error; a later stop leaves it failed (the reviewer's case)", () => {
  const r = judged(
    reportOf("expected", "passed", [
      { message: "Independent teardown error recorded before cancellation" },
    ]),
    { code: 1 },
    null,
  );
  assert.equal(r.outcome, "failed");
  assert.deepEqual(r.failure, {
    kind: "report_errors",
    reason: "the report has errors",
  });
  for (const stop of [null, SIGTERM]) {
    // Attached directly, or through the reducer, the stop changes nothing.
    assert.equal(withCancellation(r, stop ?? SIGTERM).outcome, "failed");
    const { settled, overall: o } = run(r);
    assert.equal(settled.outcome, "failed");
    assert.deepEqual(settled.report_errors, [
      "Independent teardown error recorded before cancellation",
    ]);
    assert.equal(o, "failed");
  }
  // Even when the stop came before Playwright ended, an error the report recorded is not the stop's to explain away.
  const afterStop = judged(
    reportOf("expected", "passed", [{ message: "teardown" }]),
    { code: 130 },
    SIGTERM,
  );
  assert.equal(run(afterStop).overall, "failed");
});

test("H4c: a preparation error raised before the stop stays an error; one raised after it is the stop's", () => {
  const before = {
    outcome: "error",
    reason: "the backend did not become ready",
    failure: {
      kind: "preparation_error",
      reason: "the backend did not become ready",
    },
  };
  const { settled, overall: o } = run(before);
  assert.equal(settled.outcome, "error");
  assert.equal(settled.cancellation, SIGTERM);
  assert.equal(o, "failed");
  const after = { outcome: "error", reason: "docker run exited 143" };
  const stopped = run(after);
  assert.equal(stopped.settled.outcome, "cancelled");
  assert.equal(
    stopped.settled.before_cancellation?.reason,
    "docker run exited 143",
  );
  assert.equal(stopped.overall, "cancelled");
});

test("H4c: a missing report or a failing exit with no stop before it is a failure; after a stop it is a cancellation", () => {
  const missing = judge({
    expected: oneCase,
    report: null,
    readError: "ENOENT",
    exit: { code: 1 },
    launchedAt: at,
    stop: null,
  });
  assert.equal(missing.failure?.kind, "report_missing");
  assert.equal(run(missing).settled.outcome, "incomplete");
  assert.equal(run(missing).overall, "failed");
  const stoppedMissing = judge({
    expected: oneCase,
    report: null,
    readError: "ENOENT",
    exit: { signal: "SIGINT" },
    launchedAt: at,
    stop: SIGTERM,
  });
  assert.equal(run(stoppedMissing).settled.outcome, "cancelled");
  const exitOnly = judged(reportOf("expected", "passed"), { code: 1 }, null);
  assert.equal(exitOnly.failure?.kind, "exit");
  assert.equal(run(exitOnly).overall, "failed");
  assert.equal(
    run(judged(reportOf("expected", "passed"), { code: 130 }, SIGTERM)).overall,
    "cancelled",
  );
  const stale = judge({
    expected: oneCase,
    report: report([], new Date(at - 60_000).toISOString()),
    exit: clean,
    launchedAt: at,
    stop: null,
  });
  assert.equal(stale.failure?.kind, "report_stale");
  assert.equal(run(stale).overall, "failed");
});

test("H4c: a budget excess, an unverified clean-up or an evidence error outranks a cancellation and a pass", () => {
  const interrupted = judged(
    reportOf("skipped", "interrupted"),
    { code: 130 },
    SIGTERM,
  );
  const budget = run(interrupted, { admissions: over });
  assert.equal(budget.settled.outcome, "budget_exceeded");
  assert.equal(budget.settled.cancellation, SIGTERM);
  assert.equal(budget.settled.before_budget?.outcome, "cancelled");
  assert.equal(budget.overall, "failed");
  const cleanup = run(interrupted, { cleanup: unverified });
  assert.equal(cleanup.settled.outcome, "cleanup_failed");
  assert.equal(cleanup.settled.before_settling?.outcome, "cancelled");
  assert.equal(cleanup.overall, "failed");
  const evidence = run(interrupted, { evidenceErrors: ["admissions: EACCES"] });
  assert.equal(evidence.settled.outcome, "evidence_failed");
  assert.equal(evidence.overall, "failed");
  const passed = judged(reportOf("expected", "passed"), clean, null);
  assert.equal(run(passed, { admissions: within }).settled.outcome, "passed");
  assert.equal(
    run(passed, { cleanup: unverified }).settled.outcome,
    "cleanup_failed",
  );
  // A failure keeps its outcome and its first cause; the later facts are listed beside it.
  const failed = run(
    judged(reportOf("unexpected", "failed"), { code: 1 }, null),
    {
      admissions: over,
      cleanup: unverified,
      evidenceErrors: ["admissions: EACCES"],
    },
  );
  assert.equal(failed.settled.outcome, "failed");
  assert.equal(failed.settled.reason, "1 failed");
  assert.deepEqual(
    failed.settled.failures?.map((f) => f.kind),
    ["cases", "budget", "cleanup", "evidence"],
  );
});

test("H4c: the order the stop is attached in does not change the outcome", () => {
  for (const [r, extra] of [
    [
      judged(
        reportOf("expected", "passed", [{ message: "x" }]),
        { code: 1 },
        null,
      ),
      {},
    ],
    [
      judged(reportOf("skipped", "interrupted"), { code: 130 }, SIGTERM),
      { admissions: over },
    ],
    [
      judged(reportOf("expected", "passed"), clean, null),
      { cleanup: unverified },
    ],
  ]) {
    const early = settleStack(withCancellation(r, SIGTERM), {
      cleanup: verified,
      ...extra,
    });
    const late = settleStack(settleStack(r, { cleanup: verified, ...extra }), {
      stop: SIGTERM,
      cleanup: extra.cleanup ?? verified,
    });
    assert.equal(early.outcome, late.outcome);
  }
});

test("H4c: the run is failed when any record carries a failure fact or the run could not write its evidence", () => {
  assert.equal(
    overall([{ outcome: "cancelled", budget_exceeded: "121 within 60 s" }], {
      signalled: "SIGTERM",
      planned: 1,
    }),
    "failed",
  );
  assert.equal(
    overall([{ outcome: "cancelled", cleanup: { ok: false } }], {
      signalled: "SIGTERM",
      planned: 1,
    }),
    "failed",
  );
  assert.equal(
    overall([{ outcome: "passed" }], {
      planned: 1,
      failures: ["summary: EACCES"],
    }),
    "failed",
  );
  assert.equal(
    overall([{ outcome: "cancelled", report_errors: ["teardown"] }], {
      signalled: "SIGTERM",
      planned: 1,
    }),
    "failed",
  );
});

// ---- review r8 H4d (revision 9): facts accumulate across every settlement and version ---------------------------------------------

test("H4d: a stack settled again (its own end, then the finaliser or the reaper) keeps every fact it had and adds new ones once", () => {
  const failed = settleStack(
    { outcome: "passed", reason: null, counts: { passed: 1, failed: 0 } },
    { evidenceErrors: ["admissions: disk full"] },
  );
  assert.equal(failed.outcome, "evidence_failed");
  const again = settleStack(failed, {
    stop: "received SIGTERM",
    cleanup: { ok: false, errors: ["port 1"] },
    evidenceErrors: ["admissions: disk full"],
  });
  assert.deepEqual(
    again.failures?.map((f) => f.kind),
    ["evidence", "cleanup"],
  );
  const third = settleStack(again, { cleanup: { by: "reaper", ok: true } });
  assert.deepEqual(
    third.failures?.map((f) => f.kind),
    ["evidence", "cleanup"],
    "a later verified clean-up does not erase the earlier unverified one",
  );
  assert.deepEqual(third.earlier_cleanups, [{ ok: false, errors: ["port 1"] }]);
  assert.deepEqual(third.evidence_errors, ["admissions: disk full"]);
  assert.equal(
    overall([{ browser: "chromium", index: 0, ...third }], { planned: 1 }),
    "failed",
  );
});

test("H4d: merging two versions keeps every fact of either; a later label that would hide a failure becomes failed", () => {
  const earlier = {
    outcome: "failed",
    reason: "the report has errors",
    failure: { kind: "report_errors", reason: "the report has errors" },
    failures: [{ kind: "report_errors", reason: "the report has errors" }],
    cleanup: { ok: false },
  };
  const later = {
    outcome: "cancelled",
    reason: "stopped: x",
    cleanup: { ok: true },
  };
  const merged = mergeFacts(earlier, later);
  assert.equal(merged.outcome, "failed");
  assert.deepEqual(merged.before_merge, {
    outcome: "cancelled",
    reason: "stopped: x",
  });
  assert.deepEqual(merged.failure, earlier.failure);
  assert.deepEqual(merged.earlier_cleanups, [{ ok: false }]);
  assert.equal(mergeFacts(null, later), later);
  // The earlier version's own failure label is kept (not a generic one).
  const evidence = settleStack(
    { outcome: "passed", reason: null },
    { evidenceErrors: ["record: disk full"] },
  );
  assert.equal(
    mergeFacts(evidence, { outcome: "passed", reason: null }).outcome,
    "evidence_failed",
  );
  // Control: two versions without a fact merge to the later one's label.
  assert.equal(
    mergeFacts({ outcome: "running" }, { outcome: "passed", reason: null })
      .outcome,
    "passed",
  );
  assert.equal(
    mergeFacts({ outcome: "running" }, { outcome: "passed", reason: null })
      .failures?.length,
    0,
  );
});

test("H4e: the projection (first failure, engine counts, completeness) is computed from the records it is given", () => {
  const records = [
    {
      browser: "chromium",
      stack: "base",
      index: 0,
      outcome: "passed",
      counts: { passed: 2, failed: 0 },
    },
    {
      browser: "chromium",
      stack: "-labels",
      index: 1,
      outcome: "evidence_failed",
      reason: "x",
      counts: { passed: 1 },
    },
    { browser: "firefox", stack: "base", index: 0, outcome: "not_run" },
  ];
  const p = project(records, { browsers: ["chromium", "firefox"], planned: 2 });
  assert.equal(
    p.first_failure,
    "integration-chromium -labels evidence_failed (x)",
  );
  assert.equal(p.engines.chromium.counts.passed, 3);
  assert.equal(p.engines.chromium.complete, false);
  assert.equal(p.engines.firefox.complete, false);
  const passed = project(records.slice(0, 1), {
    browsers: ["chromium"],
    planned: 1,
  });
  assert.equal(passed.first_failure, null);
  assert.equal(passed.engines.chromium.complete, true);
});

// ---- review r10 H4f (revision 11): an earlier unverified clean-up counts after a later one succeeded --------------------------------
import { cleanupFailed as cleanupNotVerified } from "./outcome.mjs";

test("H4f: a stack settled again with a verified clean-up keeps the earlier unverified one, and the run counts it", () => {
  const first = settleStack(
    { browser: "chromium", stack: "base", index: 0, outcome: "passed" },
    { cleanup: { ok: false, errors: ["container left"] } },
  );
  const again = settleStack(first, {
    stop: "the reaper received SIGTERM",
    cleanup: { by: "reaper", ok: true },
  });
  assert.equal(again.cleanup.ok, true);
  assert.equal(again.earlier_cleanups?.[0]?.ok, false);
  assert.equal(cleanupNotVerified(again), true);
  // Even a record whose label and facts were lost on the way keeps failing the run by its earlier clean-up alone.
  const bare = {
    browser: "chromium",
    stack: "base",
    index: 0,
    outcome: "passed",
    cleanup: { ok: true },
    earlier_cleanups: [{ ok: false }],
  };
  assert.equal(overall([bare], { planned: 1 }), "failed");
  // Controls.
  assert.equal(cleanupNotVerified({ cleanup: { ok: true } }), false);
  assert.equal(cleanupNotVerified({ outcome: "not_run" }), false);
  assert.equal(
    overall([{ ...bare, earlier_cleanups: undefined }], { planned: 1 }),
    "passed",
  );
});

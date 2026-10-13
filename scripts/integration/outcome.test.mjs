import assert from "node:assert/strict";
import test from "node:test";
import { applyBudget, judge, schedule } from "./outcome.mjs";

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
  const failed = applyBudget(
    { outcome: "failed", reason: "1 failed" },
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

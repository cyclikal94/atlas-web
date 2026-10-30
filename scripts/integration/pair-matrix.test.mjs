// WEB-09c R23-PAIR: every discovered case is assigned once, every selected result is accounted once, and nothing that is not a real pass
// (a skip, a failure, a retry, an interruption, a missing result) becomes one.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountNames,
  BROWSERS,
  CASES,
  designedSkipReason,
  discoveryProblems,
  judgeResults,
  SPEC,
  UNSUPPORTED,
} from "./pair-matrix.mjs";

const stats = {
  startTime: "2026-10-30T00:00:00.000Z",
  duration: 1,
  expected: 0,
  skipped: 0,
  unexpected: 0,
  flaky: 0,
};
const passed = () => ({
  status: "expected",
  expectedStatus: "passed",
  annotations: [],
  results: [{ status: "passed", retry: 0, annotations: [] }],
});
const skipped = (reason) => ({
  status: "skipped",
  expectedStatus: "skipped",
  annotations: [{ type: "skip", description: reason }],
  results: [{ status: "skipped", retry: 0, annotations: [] }],
});
const listedOnly = () => ({
  status: "expected",
  expectedStatus: "passed",
  annotations: [],
  results: [],
});
/** A Playwright JSON report: one spec per (title, browser), each test given by `shape(id, browser)`. */
function report(entries, { file = SPEC } = {}) {
  return {
    stats,
    errors: [],
    suites: [
      {
        title: file,
        file,
        specs: entries.map(({ title, browser, test: t }) => ({
          title,
          file,
          tests: [{ projectName: `pair-${browser}`, ...t }],
        })),
      },
    ],
  };
}
const every = (browsers, shape, cases = CASES) =>
  browsers.flatMap((browser) =>
    cases.map((c) => ({
      title: `${c.id}: a title`,
      browser,
      test: shape(c, browser),
    })),
  );

test("the matrix: unique ids, every case on the development backend, the released control whole-revision only, accounts per case", () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(CASES.every((c) => c.backends.includes("development")));
  for (const c of CASES.filter((x) => x.backends.includes("released")))
    assert.equal(c.m, null, `${c.id} needs max_changes`);
  assert.equal(new Set(accountNames()).size, accountNames().length);
  assert.ok(
    UNSUPPORTED.every(
      (u) =>
        ["capability", "transferred"].includes(u.kind) && u.owner && u.reason,
    ),
  );
  assert.ok(UNSUPPORTED.every((u) => !ids.includes(u.id)));
});

test("revision 25: every workload case names how its record must be driven, and T1 alone its required observations", () => {
  const mode = Object.fromEntries(CASES.map((c) => [c.id, c.driven]));
  assert.equal(mode["PAIR-P0"], null);
  for (const id of ["PAIR-B1", "PAIR-B2", "PAIR-B3", "PAIR-X1", "PAIR-L1"])
    assert.equal(mode[id], "prefix", id);
  assert.equal(mode["PAIR-RC1"], "none");
  for (const c of CASES.filter(
    (x) => x.workload !== null && !["prefix", "none"].includes(x.driven),
  ))
    assert.equal(c.driven, "full", c.id);
  for (const c of CASES)
    assert.deepEqual(
      c.observations,
      c.id === "PAIR-T1"
        ? ["follower_old_at_last_piece", "follower_new_after_activation"]
        : [],
      c.id,
    );
});

test("discovery: exactly the matrix in every selected engine is accepted", () => {
  assert.deepEqual(
    discoveryProblems(report(every(BROWSERS, listedOnly)), {
      browsers: BROWSERS,
    }),
    [],
  );
  assert.deepEqual(
    discoveryProblems(report(every(["webkit"], listedOnly)), {
      browsers: ["webkit"],
    }),
    [],
  );
});

for (const [name, mutate, expected] of [
  [
    "a missing case",
    (e) =>
      e.filter(
        (x) => !(x.browser === "firefox" && x.title.startsWith("PAIR-W2:")),
      ),
    /missing PAIR-W2 in pair-firefox/,
  ],
  [
    "a duplicate case",
    (e) => [...e, e[0]],
    /duplicate PAIR-P0 in pair-chromium/,
  ],
  [
    "an unassigned case",
    (e) => [
      ...e,
      { title: "a case with no id", browser: "chromium", test: listedOnly() },
    ],
    /unassigned case/,
  ],
  [
    "a case outside the matrix",
    (e) => [
      ...e,
      { title: "PAIR-Z9: new", browser: "chromium", test: listedOnly() },
    ],
    /unassigned case "PAIR-Z9/,
  ],
  [
    "an unselected engine's project",
    (e) => e,
    /unexpected project pair-webkit/,
  ],
])
  test(`discovery refused: ${name}`, () => {
    const browsers =
      name === "an unselected engine's project"
        ? ["chromium", "firefox"]
        : BROWSERS;
    const entries = mutate(every(BROWSERS, listedOnly));
    const problems = discoveryProblems(report(entries), { browsers });
    assert.ok(
      problems.some((p) => expected.test(p)),
      JSON.stringify(problems),
    );
  });

test("discovery refused: zero cases, another file, a malformed report", () => {
  assert.deepEqual(discoveryProblems(report([]), { browsers: BROWSERS }), [
    "the listing holds no case",
  ]);
  assert.ok(
    discoveryProblems(
      report(every(["chromium"], listedOnly), { file: "other.spec.ts" }),
      { browsers: ["chromium"] },
    ).some((p) => /unexpected file/.test(p)),
  );
  assert.ok(
    discoveryProblems({ suites: "no" }, { browsers: BROWSERS }).length > 0,
  );
});

const judged = (backend, shape, mutate = (e) => e) =>
  judgeResults(report(mutate(every(["chromium"], shape))), {
    browser: "chromium",
    backend,
  });
const designed = (c, backend) =>
  c.backends.includes(backend)
    ? passed()
    : skipped(designedSkipReason(backend));

test("judge: development, every case passed: complete; the unsupported rows are carried as unrun", () => {
  const out = judged("development", (c) => designed(c, "development"));
  assert.deepEqual(out.problems, []);
  assert.equal(out.complete, true);
  assert.equal(out.counts.passed, CASES.length);
  assert.ok(
    out.unsupported.length > 0 &&
      out.unsupported.every((u) => u.outcome === "unrun"),
  );
});

test("judge: released, applicable cases passed and the rest skipped by design: complete", () => {
  const out = judged("released", (c) => designed(c, "released"));
  assert.deepEqual(out.problems, []);
  assert.equal(out.complete, true);
  assert.equal(
    out.counts.designed_skip,
    CASES.filter((c) => !c.backends.includes("released")).length,
  );
});

for (const [name, shape, outcome] of [
  [
    "a failure",
    (c) =>
      c.id === "PAIR-W2"
        ? {
            ...passed(),
            status: "unexpected",
            results: [{ status: "failed", retry: 0 }],
          }
        : designed(c, "development"),
    "failed",
  ],
  [
    "a time-out",
    (c) =>
      c.id === "PAIR-W2"
        ? {
            ...passed(),
            status: "unexpected",
            results: [{ status: "timedOut", retry: 0 }],
          }
        : designed(c, "development"),
    "failed",
  ],
  [
    "a retry that passed",
    (c) =>
      c.id === "PAIR-W2"
        ? {
            ...passed(),
            status: "flaky",
            results: [
              { status: "failed", retry: 0 },
              { status: "passed", retry: 1 },
            ],
          }
        : designed(c, "development"),
    "failed",
  ],
  [
    "an interruption",
    (c) =>
      c.id === "PAIR-W2"
        ? {
            ...passed(),
            status: "unexpected",
            results: [{ status: "interrupted", retry: 0 }],
          }
        : designed(c, "development"),
    "interrupted",
  ],
  [
    "no result",
    (c) => (c.id === "PAIR-W2" ? listedOnly() : designed(c, "development")),
    "unrun",
  ],
  [
    "a skip with another reason",
    (c) =>
      c.id === "PAIR-W2"
        ? skipped("something else")
        : designed(c, "development"),
    "failed",
  ],
  [
    "a designed-looking skip of an applicable case",
    (c) =>
      c.id === "PAIR-W2"
        ? skipped(designedSkipReason("development"))
        : designed(c, "development"),
    "failed",
  ],
])
  test(`judge: ${name} is never a pass`, () => {
    const out = judged("development", shape);
    assert.equal(out.complete, false);
    assert.equal(out.outcomes["PAIR-W2"], outcome);
  });

test("judge: a released run that PASSED a development-only case is a failure (it should have been skipped)", () => {
  const out = judged("released", () => passed());
  assert.equal(out.complete, false);
  assert.equal(out.outcomes["PAIR-W2"], "failed");
});

test("judge: a missing case, a duplicate result and a result outside the matrix are problems", () => {
  const missing = judged(
    "development",
    (c) => designed(c, "development"),
    (e) => e.filter((x) => !x.title.startsWith("PAIR-A1:")),
  );
  assert.equal(missing.outcomes["PAIR-A1"], "unrun");
  assert.equal(missing.complete, false);
  const dup = judged(
    "development",
    (c) => designed(c, "development"),
    (e) => [...e, e[1]],
  );
  assert.ok(dup.problems.some((p) => /duplicate result/.test(p)));
  const extra = judged(
    "development",
    (c) => designed(c, "development"),
    (e) => [...e, { title: "PAIR-Z9: x", browser: "chromium", test: passed() }],
  );
  assert.ok(extra.problems.some((p) => /outside the matrix/.test(p)));
  assert.equal(extra.complete, false);
});

test("judge: a NARROWED run is judged on its selection: unselected cases are not_selected, never complete, never a pass", () => {
  const only = (e) => e.filter((x) => x.title.startsWith("PAIR-W1:"));
  const run = judgeResults(
    report(only(every(["chromium"], (c) => designed(c, "released")))),
    {
      browser: "chromium",
      backend: "released",
      narrowed: true,
    },
  );
  assert.deepEqual(run.problems, []);
  assert.equal(run.selected_ok, true);
  assert.equal(run.complete, false);
  assert.equal(run.outcomes["PAIR-W1"], "passed");
  assert.equal(run.outcomes["PAIR-W2"], "not_selected");
  const failing = judgeResults(
    report([
      {
        title: "PAIR-W1: x",
        browser: "chromium",
        test: {
          ...passed(),
          status: "unexpected",
          results: [{ status: "failed", retry: 0 }],
        },
      },
    ]),
    { browser: "chromium", backend: "released", narrowed: true },
  );
  assert.equal(failing.selected_ok, false);
  const nothing = judgeResults(report([]), {
    browser: "chromium",
    backend: "released",
    narrowed: true,
  });
  assert.equal(
    nothing.selected_ok,
    false,
    "a narrowed run that selected nothing is not a pass",
  );
  // The same absence in a FULL run is unrun.
  const full = judgeResults(
    report(only(every(["chromium"], (c) => designed(c, "released")))),
    { browser: "chromium", backend: "released" },
  );
  assert.equal(full.outcomes["PAIR-W2"], "unrun");
  assert.equal(full.complete, false);
});

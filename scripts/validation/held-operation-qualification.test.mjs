// WEB-08d revision 23 (review r22 R22-N1; design assessment 3bef3bd4 Q1-Q3, Q9): the held-operation qualification's evaluator, judged
// against GENUINE saved reports (fixtures/held-operation-*.json.gz: trimmed copies of revision 22's two full campaigns and review r22's
// real-browser negative controls, with source hashes in fixtures/held-operation-provenance.json). The adversarial cases below are
// SYNTHETIC edits of those real reports, labelled as such: they qualify the reader, not any browser behaviour.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import * as evaluator from "./held-operation-qualification.mjs";

const B = ["chromium", "firefox", "webkit"];
const root = resolve(import.meta.dirname, "../..");
/** A bundle of saved runs; each run carries the exact text of the probe spec it ran (hash-checked when the bundle was built). */
function fixture(name) {
  const bundle = JSON.parse(
    gunzipSync(
      readFileSync(
        join(import.meta.dirname, "fixtures", `held-operation-${name}.json.gz`),
      ),
    ).toString("utf8"),
  );
  const runs = [
    bundle.control,
    bundle.copy_control,
    ...Object.values(bundle.mutants ?? {}),
    bundle.runtime,
    bundle.timeout,
  ].filter(Boolean);
  for (const run of runs) run.spec = bundle.spec.text;
  return bundle;
}
const A6 = fixture("r22-attempt-6");
const A3 = fixture("r22-attempt-3");
const REVIEW = fixture("review-r22");

// --- report editing (synthetic adversarial cases are edits of real reports) ---------------------------------------------------------
function* specsOf(report) {
  const walk = function* (suite) {
    for (const spec of suite.specs ?? []) yield { suite, spec };
    for (const child of suite.suites ?? []) yield* walk(child);
  };
  for (const suite of report.suites) yield* walk(suite);
}
const idOf = (spec) => spec.title.split(" ")[0];
/** A copy of `entry` whose matching cases (`id`, engine, parameter index) `change(result, test, spec)` edits. */
function edit(entry, { id, engine, param = 0 }, change) {
  const copy = structuredClone(entry);
  let hits = 0;
  const seen = new Map();
  for (const { spec } of specsOf(copy.report)) {
    if (idOf(spec) !== id) continue;
    for (const t of spec.tests) {
      if (engine && t.projectName !== `fixture-${engine}`) continue;
      const key = t.projectName;
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      if (index !== param) continue;
      change(t.results.at(-1), t, spec);
      hits += 1;
    }
  }
  assert.ok(hits > 0, `no case ${id}/${engine}/${param} to edit`);
  return copy;
}
/** A copy of `entry` keeping only the cases of `ids` (as a `-g` selection of them would report), with the exit Playwright would give. */
function select(entry, ids) {
  const copy = structuredClone(entry);
  const keep = (suite) => {
    suite.specs = (suite.specs ?? []).filter((s) => ids.includes(idOf(s)));
    for (const child of suite.suites ?? []) keep(child);
  };
  for (const suite of copy.report.suites) keep(suite);
  const failing = [...specsOf(copy.report)].some(({ spec }) =>
    spec.tests.some((t) => t.results.at(-1).status !== "passed"),
  );
  copy.exit = failing ? 1 : 0;
  return copy;
}
/** Replaces one engine's case of `id` in `entry` with that case from `from`. */
function transplant(entry, from, id, engine) {
  let donor;
  for (const { spec } of specsOf(from.report))
    if (idOf(spec) === id)
      donor ??= spec.tests.find((t) => t.projectName === `fixture-${engine}`);
  return edit(entry, { id, engine }, (_r, t) => {
    t.results = structuredClone(donor.results);
  });
}
const ledgerOf = (result) =>
  JSON.parse(
    Buffer.from(
      result.attachments.find((a) => a.name === "held-operations").body,
      "base64",
    ),
  );
const setLedger = (result, ledger) => {
  result.attachments.find((a) => a.name === "held-operations").body =
    Buffer.from(JSON.stringify(ledger)).toString("base64");
};
const specPath = (entry) => {
  for (const { spec } of specsOf(entry.report))
    for (const t of spec.tests)
      for (const e of t.results.at(-1).errors ?? [])
        if (e.location?.file?.endsWith("probe.held-operation.spec.ts"))
          return e.location.file;
  throw new Error("no spec location");
};

const judge = (q, mutant, entry, probes) =>
  q.judgeMutant(
    mutant,
    q.normalise(entry.report, B, entry.exit, entry.spec),
    B,
    probes,
  );

/** SYNTHETIC unrelated faults beside or instead of a genuine delta (design assessment Q2). Every one must be judged invalid. */
const ADVERSARIAL = [
  {
    name: "a P control fails at a setup assertion, not its intended one",
    mutant: "HM1",
    entry: () =>
      edit(A6.mutants.HM1, { id: "P03", engine: "chromium" }, (r) => {
        r.errors = [
          {
            message:
              "Error: expect(received).toMatchObject(expected)\n\n- Expected\n+ Received\n\n  126 |   );\n> 127 |   expect(\n      |   ^",
            location: { file: specPath(A6.mutants.HM1), line: 127, column: 3 },
          },
        ];
      }),
  },
  {
    name: "a shape's intended assertion text, failing on another test's line",
    mutant: "HM2",
    entry: () =>
      edit(A6.mutants.HM2, { id: "S1", engine: "firefox" }, (r) => {
        r.errors[0].message = r.errors[0].message.replace("> 644 |", "> 670 |");
        r.errors[0].location.line = 670;
      }),
  },
  {
    name: "an ordinary runtime error after the probe reached its checkpoint",
    mutant: "HM4",
    entry: () =>
      edit(A6.mutants.HM4, { id: "S3", engine: "webkit" }, (r) => {
        r.errors.push({
          message:
            "TypeError: an unrelated runtime failure after the checkpoint",
          location: { file: specPath(A6.mutants.HM4), line: 671, column: 7 },
        });
      }),
  },
  {
    name: "an unrelated timeout after the checkpoint",
    mutant: "HM2",
    entry: () =>
      edit(A6.mutants.HM2, { id: "S1", engine: "chromium" }, (r) => {
        r.status = "timedOut";
        r.errors.unshift({ message: "Test timeout of 30000ms exceeded." });
      }),
  },
  {
    name: "the intended delta plus an extra teardown error",
    mutant: "HM7",
    entry: () =>
      edit(A6.mutants.HM7, { id: "S3", engine: "firefox" }, (r) => {
        r.errors.push({
          message:
            "Error: negative control: an unrelated teardown error after the probe body",
          location: { file: specPath(A6.mutants.HM7), line: 950, column: 11 },
        });
      }),
  },
  {
    name: "an extra cleanup entry in the publisher's error",
    mutant: "HM2",
    entry: () =>
      edit(A6.mutants.HM2, { id: "S1", engine: "webkit" }, (r) => {
        r.errors[1].message = r.errors[1].message.replace(
          "\n",
          " | the operation another call failed: unrelated\n",
        );
      }),
  },
  {
    name: "S6 timed out in a hook instead of inside its scope",
    mutant: "HM7",
    entry: () =>
      edit(A6.mutants.HM7, { id: "S6", engine: "chromium" }, (r) => {
        r.errors[0].message =
          'Test timeout of 30000ms exceeded while running "beforeEach" hook.';
      }),
  },
  {
    name: "a ledger swapped in from another probe",
    mutant: "HM10",
    entry: () => {
      let other;
      edit(A6.mutants.HM10, { id: "S11", engine: "chromium" }, (r) => {
        other = ledgerOf(r);
      });
      return edit(A6.mutants.HM10, { id: "S10", engine: "chromium" }, (r) =>
        setLedger(r, other),
      );
    },
  },
  {
    name: "a duplicated held-operations attachment",
    mutant: "HM14",
    entry: () =>
      edit(A6.mutants.HM14, { id: "S10", engine: "webkit" }, (r) => {
        r.attachments.push(
          structuredClone(
            r.attachments.find((a) => a.name === "held-operations"),
          ),
        );
      }),
  },
  {
    name: "an unparseable held-operations attachment",
    mutant: "HM14",
    entry: () =>
      edit(A6.mutants.HM14, { id: "S12", engine: "chromium" }, (r) => {
        r.attachments.find((a) => a.name === "held-operations").body =
          Buffer.from("{ not json").toString("base64");
      }),
  },
  {
    name: "a missing held-operations attachment",
    mutant: "HM7",
    entry: () =>
      edit(A6.mutants.HM7, { id: "S4", engine: "webkit" }, (r) => {
        r.attachments = r.attachments.filter(
          (a) => a.name !== "held-operations",
        );
      }),
  },
  {
    name: "a page error that reads as an assertion in Firefox",
    mutant: "HM12",
    entry: () =>
      edit(A6.mutants.HM12, { id: "S21", engine: "firefox" }, (r) => {
        r.errors[0].message = r.errors[0].message.replace(
          "page.evaluate: expect(",
          "page.evaluate: Error: expect(",
        );
      }),
  },
  {
    name: "a spec text that is not the one that ran (every line shifted by one)",
    mutant: "HM3",
    entry: () => {
      const copy = structuredClone(A6.mutants.HM3);
      copy.spec = `\n${copy.spec}`;
      return copy;
    },
  },
  {
    name: "a run whose exit says it passed",
    mutant: "HM3",
    entry: () => ({ ...structuredClone(A6.mutants.HM3), exit: 0 }),
  },
  {
    name: "a report-level error",
    mutant: "HM3",
    entry: () => {
      const copy = structuredClone(A6.mutants.HM3);
      copy.report.errors = [{ message: "Error: a worker crashed" }];
      return copy;
    },
  },
  {
    name: "a retried case",
    mutant: "HM3",
    entry: () =>
      edit(A6.mutants.HM3, { id: "P06", engine: "chromium" }, (_r, t) => {
        t.results = [structuredClone(t.results[0]), ...t.results];
      }),
  },
  {
    name: "a skipped case",
    mutant: "HM9",
    entry: () =>
      edit(A6.mutants.HM9, { id: "P13", engine: "webkit" }, (r) => {
        r.status = "skipped";
        r.errors = [];
      }),
  },
  {
    name: "an interrupted case",
    mutant: "HM5",
    entry: () =>
      edit(A6.mutants.HM5, { id: "P09", engine: "firefox" }, (r) => {
        r.status = "interrupted";
      }),
  },
  {
    name: "a missing engine's case",
    mutant: "HM3",
    entry: () => {
      const copy = structuredClone(A6.mutants.HM3);
      for (const { spec } of specsOf(copy.report))
        spec.tests = spec.tests.filter(
          (t) => t.projectName !== "fixture-webkit",
        );
      return copy;
    },
  },
  {
    name: "an extra case outside the contract",
    mutant: "HM3",
    entry: () => {
      const copy = structuredClone(A6.mutants.HM3);
      const extra = [...specsOf(A6.control.report)].find(
        ({ spec }) => idOf(spec) === "P01",
      );
      copy.report.suites[0].suites[0].specs.push(structuredClone(extra.spec));
      return copy;
    },
  },
  {
    name: "a P03 parameterisation substituted by a second copy of the other",
    mutant: "HM1",
    entry: () => {
      let first;
      const copy = edit(A6.mutants.HM1, { id: "P03" }, (_r, _t, spec) => {
        first ??= spec.title;
      });
      for (const { spec } of specsOf(copy.report))
        if (idOf(spec) === "P03") spec.title = first;
      return copy;
    },
  },
];

/** Every check the evaluator must pass, by name: the evaluator's own mutants must fail at least one (design assessment Q3). */
function assessments(q) {
  const failed = [];
  const check = (name, ok) => {
    try {
      if (!ok()) failed.push(name);
    } catch (error) {
      failed.push(`${name} (threw ${error.message})`);
    }
  };
  for (const [label, campaign] of [
    ["attempt 6", A6],
    ["attempt 3", A3],
  ]) {
    for (const part of ["control", "copy_control"])
      check(
        `${label} ${part} healthy`,
        () =>
          q.judgeControl(
            q.normalise(
              campaign[part].report,
              B,
              campaign[part].exit,
              campaign[part].spec,
            ),
            q.PROBE_IDS,
            B,
          ).ok,
      );
    for (const m of q.MUTANTS)
      check(
        `${label} ${m.id} caught`,
        () => judge(q, m.id, campaign.mutants[m.id]).verdict === "caught",
      );
  }
  for (const [name, nc] of [
    ["runtime", "NC1"],
    ["timeout", "NC2"],
  ])
    check(`review ${name} refused`, () => {
      const control = q.NEGATIVE_CONTROLS.find((n) => n.id === nc);
      const run = q.normalise(
        REVIEW[name].report,
        B,
        REVIEW[name].exit,
        REVIEW[name].spec,
      );
      return (
        q.judgeNegative(control, run, B).refused &&
        q.judgeMutant(control.contract, run, B).verdict === "invalid"
      );
    });
  for (const a of ADVERSARIAL)
    check(
      `adversarial: ${a.name}`,
      () => judge(q, a.mutant, a.entry()).verdict === "invalid",
    );
  check(
    "one engine unchanged survives",
    () =>
      judge(q, "HM10", transplant(A6.mutants.HM10, A6.control, "S12", "webkit"))
        .verdict === "survived",
  );
  for (const m of q.MUTANTS)
    check(
      `${m.id} on healthy evidence survives`,
      () => judge(q, m.id, select(A6.control, m.probes)).verdict === "survived",
    );
  return failed;
}

test("Q3: every contract is total, the inventory is exact, and every patch applies once to the current source", () => {
  assert.deepEqual(evaluator.validateContracts(), []);
  assert.deepEqual(evaluator.MUTANT_IDS.toSorted(), [
    "FM1",
    "FM2",
    "FM3",
    "HM1",
    "HM10",
    "HM11",
    "HM12",
    "HM13",
    "HM14",
    "HM2",
    "HM3",
    "HM4",
    "HM5",
    "HM6",
    "HM7",
    "HM8",
    "HM9",
  ]);
  assert.equal(
    Object.values(evaluator.TITLES).flat().length,
    37,
    "37 cases per engine (P03 twice)",
  );
  for (const m of evaluator.MUTANTS) {
    const text = readFileSync(join(root, m.file), "utf8");
    assert.notEqual(m.patch(text), text, m.id);
  }
  assert.deepEqual(
    evaluator.NEGATIVE_CONTROLS.map((n) => n.id),
    ["NC1", "NC2", "NC3", "NC4"],
  );
});

test("Q3: revision 22's two genuine full campaigns support every healthy profile and every mutant's contract, case by case", () => {
  for (const campaign of [A6, A3]) {
    for (const part of ["control", "copy_control"]) {
      const judged = evaluator.judgeControl(
        evaluator.normalise(
          campaign[part].report,
          B,
          campaign[part].exit,
          campaign[part].spec,
        ),
        evaluator.PROBE_IDS,
        B,
      );
      assert.deepEqual(judged.problems, [], part);
      assert.equal(judged.cases.length, 111);
    }
    for (const m of evaluator.MUTANTS) {
      const judged = judge(evaluator, m.id, campaign.mutants[m.id]);
      assert.deepEqual(judged.problems, [], m.id);
      assert.equal(judged.verdict, "caught", m.id);
      assert.ok(
        judged.cases.every((c) => c.role === "delta"),
        m.id,
      );
      assert.equal(
        judged.cases.length,
        3 * m.probes.reduce((n, id) => n + evaluator.TITLES[id].length, 0),
      );
    }
  }
});

test("Q1: review r22's real preparation-error and hook-timeout reports are invalid, never caught", () => {
  const runtime = evaluator.normalise(
    REVIEW.runtime.report,
    B,
    REVIEW.runtime.exit,
    REVIEW.runtime.spec,
  );
  const hm10 = evaluator.judgeMutant("HM10", runtime, B);
  assert.equal(hm10.verdict, "invalid");
  assert.equal(hm10.caught, false);
  assert.equal(hm10.cases.length, 18);
  assert.ok(hm10.cases.every((c) => c.role === "invalid"));
  assert.ok(hm10.problems.some((p) => p.includes("no held-operations ledger")));
  assert.ok(
    evaluator.judgeNegative(evaluator.NEGATIVE_CONTROLS[0], runtime, B).refused,
  );
  const timeout = evaluator.normalise(
    REVIEW.timeout.report,
    B,
    REVIEW.timeout.exit,
    REVIEW.timeout.spec,
  );
  const hm12 = evaluator.judgeMutant("HM12", timeout, B);
  assert.equal(hm12.verdict, "invalid");
  assert.equal(hm12.cases.length, 3);
  assert.ok(hm12.cases.every((c) => c.role === "invalid"));
  assert.ok(
    evaluator.judgeNegative(evaluator.NEGATIVE_CONTROLS[1], timeout, B).refused,
  );
  // The review's healthy selection (P01/P14 and S7/S10-S14/S17-S21) is healthy under the same profiles.
  const control = evaluator.normalise(
    REVIEW.control.report,
    B,
    REVIEW.control.exit,
    REVIEW.control.spec,
  );
  const ids = [...new Set(control.cases.map((c) => c.id))];
  assert.equal(ids.length, 13);
  assert.deepEqual(evaluator.judgeControl(control, ids, B).problems, []);
});

test("Q1: an empty report, and missing, duplicated or unparseable ledgers are invalid", () => {
  const empty = evaluator.judgeMutant(
    "HM10",
    evaluator.normalise({ suites: [] }, B, 1, A6.spec.text),
    B,
  );
  assert.equal(empty.verdict, "invalid");
  assert.ok(empty.problems.some((p) => p.startsWith("incomplete report")));
});

for (const a of ADVERSARIAL)
  test(`Q2 (synthetic): ${a.name} is invalid`, () => {
    const judged = judge(evaluator, a.mutant, a.entry());
    assert.equal(judged.verdict, "invalid");
    assert.equal(judged.caught, false);
    assert.ok(judged.problems.length > 0);
  });

test("Q2: an engine that does not notice the mutation is a survivor, and an unknown contract refuses before judging", () => {
  const disagreeing = judge(
    evaluator,
    "HM10",
    transplant(A6.mutants.HM10, A6.control, "S12", "webkit"),
  );
  assert.equal(disagreeing.verdict, "survived");
  assert.deepEqual(
    disagreeing.cases.filter((c) => c.role !== "delta").map((c) => c.engine),
    ["fixture-webkit"],
  );
  assert.throws(
    () => judge(evaluator, "HM99", A6.mutants.HM10),
    /No contract for mutant HM99/,
  );
  assert.throws(
    () => judge(evaluator, "HM1", A6.mutants.HM1, ["S7"]),
    /HM1 has no contract for S7/,
  );
  assert.throws(
    () =>
      evaluator.judgeControl(
        evaluator.normalise({ suites: [] }, B, 1, A6.spec.text),
        ["X9"],
        B,
      ),
    /Unknown probe X9/,
  );
});

test("Q3: healthy evidence under every mutant's contract survives; removing a required piece of a delta invalidates it", () => {
  for (const m of evaluator.MUTANTS) {
    const judged = judge(evaluator, m.id, select(A6.control, m.probes));
    assert.equal(judged.verdict, "survived", m.id);
    assert.ok(
      judged.cases.every((c) => c.role === "unchanged"),
      m.id,
    );
  }
  const missingCheckpoint = edit(
    A6.mutants.HM7,
    { id: "S6", engine: "webkit" },
    (r) => {
      const ledger = ledgerOf(r);
      ledger.scopes[0].holds[0].events =
        ledger.scopes[0].holds[0].events.filter((e) => e.event !== "held");
      setLedger(r, ledger);
    },
  );
  assert.equal(judge(evaluator, "HM7", missingCheckpoint).verdict, "invalid");
  const missingPrimary = edit(
    A6.mutants.HM10,
    { id: "S11", engine: "chromium" },
    (r) => {
      r.errors = [];
    },
  );
  assert.equal(judge(evaluator, "HM10", missingPrimary).verdict, "invalid");
  const missingIndependent = edit(
    A6.mutants.HM14,
    { id: "S15", engine: "firefox" },
    (r) => {
      r.errors = r.errors.slice(0, 1);
    },
  );
  assert.equal(judge(evaluator, "HM14", missingIndependent).verdict, "invalid");
  const witnessStillPublished = transplant(
    A6.mutants.HM14,
    A6.control,
    "S10",
    "chromium",
  );
  assert.equal(
    judge(evaluator, "HM14", witnessStillPublished).verdict,
    "survived",
  );
});

/** The evaluator's own sensitivity mutants (design assessment Q3: "mutate the new evaluator itself back to any deviation"). */
const EVALUATOR_MUTANTS = [
  [
    "EM1 any case that is not healthy is a delta",
    '  else role = "invalid";',
    '  else role = "delta";',
  ],
  [
    "EM2 extra errors are ignored",
    "  if (c.errors.length !== profile.errors.length)",
    "  if (c.errors.length < profile.errors.length)",
  ],
  [
    "EM3 the inventory is not checked",
    "  problems.push(...inventoryProblems(run, ids, browsers));\n",
    "",
  ],
  [
    "EM4 a P control's failing line is not checked",
    "  if (spec.frame !== undefined) {",
    '  if (spec.frame === Symbol.for("frame")) {',
  ],
  [
    "EM5 a duplicated attachment is read as one",
    '    else if (ledgers.length > 1) ledger = { damaged: "duplicate attachment" };',
    '    else if (ledgers.length > 9) ledger = { damaged: "duplicate attachment" };',
  ],
  [
    "EM6 a survivor is reported as caught",
    '      : cases.length > 0 && cases.every((c) => c.role === "delta")',
    '      : cases.length > 0 && cases.some((c) => c.role === "delta")',
  ],
  [
    "EM7 publisher entries are not counted",
    "      if (entries.length !== cleanup.length)",
    "      if (entries.length < cleanup.length)",
  ],
  [
    "EM8 an assertion's own test is not checked",
    "      spec.own &&\n",
    '      spec.own === Symbol.for("own") &&\n',
  ],
  [
    "EM9 a timeout in a hook passes for one in the scope",
    "  match: /^Test timeout of \\d+ms exceeded\\.$/,",
    "  match: /^Test timeout of \\d+ms exceeded/,",
  ],
  [
    "EM10 a missing ledger is taken as an empty one",
    '  } else if (c.ledger === undefined) problems.push("no held-operations ledger");',
    "  } else if (c.ledger === undefined) c.ledger = { scopes: [], errors: [], escaped: [] };",
  ],
];

test("Q3: every evaluator mutant fails at least one of these checks; the evaluator itself passes all", async (t) => {
  assert.deepEqual(assessments(evaluator), []);
  const dir = mkdtempSync(join(tmpdir(), "atlas-held-operation-evaluator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(
    join(import.meta.dirname, "engine-results.mjs"),
    join(dir, "engine-results.mjs"),
  );
  const source = readFileSync(
    join(import.meta.dirname, "held-operation-qualification.mjs"),
    "utf8",
  );
  const caughtBy = {};
  for (const [name, from, to] of EVALUATOR_MUTANTS) {
    assert.equal(source.split(from).length - 1, 1, `${name}: anchor`);
    const file = join(dir, `${name.split(" ")[0]}.mjs`);
    writeFileSync(file, source.replace(from, to));
    const mutated = await import(pathToFileURL(file).href);
    caughtBy[name] = assessments(mutated);
    assert.ok(caughtBy[name].length > 0, `${name} survived`);
  }
  // Evidence for the reviewer: the checks each evaluator mutant fails (opt-in; the test writes nothing otherwise).
  if (process.env.ATLAS_EVALUATOR_MUTANTS_OUT)
    writeFileSync(
      process.env.ATLAS_EVALUATOR_MUTANTS_OUT,
      `${JSON.stringify(caughtBy, null, 2)}\n`,
    );
});

test("Q9: the campaign passes only when every planned part ran and is sound", () => {
  const base = {
    preflight: true,
    fatal: null,
    interrupted: false,
    sourceUnchanged: true,
    planned: { controls: 2, negatives: ["NC1"], mutants: ["HM1", "HM2"] },
    controls: [
      { name: "control", ok: true },
      { name: "copy-control", ok: true },
    ],
    negatives: [{ negative_control: "NC1", verdict: "invalid", refused: true }],
    mutants: [
      { mutant: "HM1", verdict: "caught" },
      { mutant: "HM2", verdict: "caught" },
    ],
  };
  assert.deepEqual(evaluator.campaignOutcome(base), {
    passed: true,
    exitCode: 0,
    reasons: [],
  });
  const failing = [
    { mutants: [base.mutants[0], { mutant: "HM2", verdict: "survived" }] },
    { mutants: [base.mutants[0], { mutant: "HM2", verdict: "invalid" }] },
    { mutants: [base.mutants[0]] },
    {
      negatives: [
        { negative_control: "NC1", verdict: "caught", refused: false },
      ],
    },
    { negatives: [] },
    { controls: [base.controls[0]] },
    { controls: [base.controls[0], { name: "copy-control", ok: false }] },
    { interrupted: true },
    { fatal: "Error: preview readiness failed" },
    { sourceUnchanged: false },
    { preflight: false },
  ];
  for (const change of failing) {
    const outcome = evaluator.campaignOutcome({ ...base, ...change });
    assert.equal(outcome.exitCode, 1, JSON.stringify(change));
    assert.ok(outcome.reasons.length > 0);
  }
});

function driverFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-held-operation-driver-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".agtx/\n");
  mkdirSync(join(dir, "scripts"));
  cpSync(
    resolve(import.meta.dirname, "../run-validation.mjs"),
    join(dir, "scripts/run-validation.mjs"),
  );
  cpSync(import.meta.dirname, join(dir, "scripts/validation"), {
    recursive: true,
  });
  execFileSync("git", ["add", "."], { cwd: dir });
  mkdirSync(join(dir, ".agtx"));
  writeFileSync(
    join(dir, ".agtx/runtime-report.json"),
    JSON.stringify(REVIEW.runtime.report),
  );
  writeFileSync(join(dir, ".agtx/probe.spec.ts"), REVIEW.spec.text);
  return dir;
}
function driver(dir, steps) {
  writeFileSync(
    join(dir, ".agtx/plan.json"),
    JSON.stringify({
      version: 2,
      qualification: {
        changed_files: [],
        no_changes_reason:
          "Verdict-to-exit-to-driver propagation of the held-operation judge; no product test inputs are changed",
      },
      steps,
    }),
  );
  let output;
  try {
    output = execFileSync(
      process.execPath,
      ["scripts/run-validation.mjs", ".agtx/plan.json"],
      { cwd: dir, encoding: "utf8" },
    );
  } catch (error) {
    output = error.stdout;
  }
  const path = /Validation evidence: (.+)/.exec(output)?.[1];
  assert.ok(path, output);
  return JSON.parse(readFileSync(join(path, "results.json"), "utf8"));
}
const judgeStep = (id, ...extra) => ({
  id,
  stage: "focused",
  requirement: "held-operation judge propagation",
  argv: [
    process.execPath,
    "scripts/validation/held-operation-judge.mjs",
    "--report",
    ".agtx/runtime-report.json",
    "--exit",
    "1",
    "--spec",
    ".agtx/probe.spec.ts",
    ...extra,
  ],
});
const laterStep = {
  id: "later",
  stage: "focused",
  requirement: "work admitted only after the judgement",
  argv: [
    process.execPath,
    "-e",
    "require('fs').writeFileSync('.agtx/later','ran')",
  ],
  after: ["judge"],
};

test("Q9: a judgement that is not the expected one exits 1 and the shared driver admits no later work", (t) => {
  const dir = driverFixture(t);
  const result = driver(dir, [
    judgeStep("judge", "--mutant", "HM10"),
    laterStep,
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.records[0].exit, 1);
  assert.equal(result.records[1].status, "not_run");
  assert.equal(existsSync(join(dir, ".agtx/later")), false);
});

test("Q9: the expected refusal of a negative control exits 0 and admits the next step", (t) => {
  const dir = driverFixture(t);
  const result = driver(dir, [
    judgeStep("judge", "--negative", "NC1"),
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  assert.equal(result.passed, true);
  assert.equal(readFileSync(join(dir, ".agtx/later"), "utf8"), "ran");
});

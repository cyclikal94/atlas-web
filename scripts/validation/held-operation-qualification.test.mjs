// WEB-08d revision 23 (review r22 R22-N1; design assessment 3bef3bd4 Q1-Q3, Q9): the held-operation qualification's evaluator, judged
// against GENUINE saved reports (fixtures/held-operation-*.json.gz: trimmed copies of revision 22's two full campaigns and review r22's
// real-browser negative controls, with source hashes in fixtures/held-operation-provenance.json). The adversarial cases below are
// SYNTHETIC edits of those real reports, labelled as such: they qualify the reader, not any browser behaviour.
//
// Revision 24 (review r23 R23-N1; design assessment e228174c Q1, Q2, Q6, Q7): fixtures/held-operation-negatives-r23.json.gz holds trimmed
// copies of the GENUINE reports of revision 23's eight real negative-control runs (two credited runs of NC1-NC4) and review r23's
// independent diagnostic (its genuine NC1 and its two wrong-fault reports, an ordinary setup error in place of NC2's timeout and of NC4's
// delta and teardown error). A negative control must be `qualified` (integrity, its own scenario, the classifier's refusal); the
// adversarial negative cases below are SYNTHETIC edits of those real reports, each naming the judgement it must fail.
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
/** Revision 23's genuine negative-control runs and review r23's diagnostic: each run is { exit, report, spec } like the others. */
const NEG = (() => {
  const bundle = JSON.parse(
    gunzipSync(
      readFileSync(
        join(
          import.meta.dirname,
          "fixtures",
          "held-operation-negatives-r23.json.gz",
        ),
      ),
    ).toString("utf8"),
  );
  return Object.fromEntries(
    Object.entries(bundle.runs).map(([name, run]) => [
      name,
      { exit: run.exit, report: run.report, spec: bundle.specs[run.spec] },
    ]),
  );
})();
const GENUINE = Object.keys(NEG).filter((n) => n.startsWith("author-"));

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

const ncOf = (q, id) => q.NEGATIVE_CONTROLS.find((n) => n.id === id);
/** A negative control's judgement of a saved run (`signal` and `browsers` as the run would record them). */
const judgeNeg = (q, id, entry, { browsers = B, provenance } = {}) =>
  q.judgeNegative(
    ncOf(q, id),
    q.normalise(entry.report, browsers, entry.exit, entry.spec, entry.signal),
    browsers,
    provenance,
  );
/** A runner's recorded invocation of a negative control that matches it (SYNTHETIC: the genuine reports' runs predate provenance). */
const provenanceOf = (nc, change = {}) => ({
  negative_control: nc.id,
  fault: nc.fault,
  fault_ids: [...nc.probes],
  installed: nc.mutant ? [nc.mutant] : [],
  live_spec_sha256: "live",
  expected_spec_sha256: "copied",
  copied_spec_sha256: "copied",
  copy_problems: { before: [], after: [] },
  signal: null,
  ...change,
});
/** One engine's case `id` with every reported error moved to `line` of the spec (its code frame too). */
const movedTo = (entry, id, line) =>
  edit(entry, { id, engine: "firefox" }, (r) => {
    for (const e of r.errors) {
      e.message = e.message.replace(/^> *\d+ \|/m, `> ${line} |`);
      e.location.line = line;
    }
  });
const NC1_ERROR = () => {
  let error;
  edit(NEG["author-negatives/NC1"], { id: "S21", engine: "webkit" }, (r) => {
    error = structuredClone(r.errors[0]);
  });
  return error;
};

/**
 * SYNTHETIC wrong, incomplete or damaged negative-control evidence (design assessment Q2): edits of the GENUINE runs, each unqualified.
 * `fails` names the judgement that must be invalid (it may not be the only one).
 */
const NEGATIVE_ADVERSARIAL = [
  {
    name: "a missing engine",
    nc: "NC1",
    fails: "integrity",
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC1"]);
      for (const { spec } of specsOf(copy.report))
        spec.tests = spec.tests.filter(
          (t) => t.projectName !== "fixture-webkit",
        );
      return copy;
    },
  },
  {
    name: "a Chromium-only selection (a narrow diagnostic, complete for its engine)",
    nc: "NC1",
    fails: "integrity",
    browsers: ["chromium"],
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC1"]);
      for (const { spec } of specsOf(copy.report))
        spec.tests = spec.tests.filter(
          (t) => t.projectName === "fixture-chromium",
        );
      return copy;
    },
  },
  {
    name: "one P03 parameterisation missing",
    nc: "NC3",
    fails: "integrity",
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC3"]);
      let dropped = false;
      const drop = (suite) => {
        suite.specs = (suite.specs ?? []).filter((sp) => {
          if (dropped || idOf(sp) !== "P03") return true;
          dropped = true;
          return false;
        });
        for (const child of suite.suites ?? []) drop(child);
      };
      for (const suite of copy.report.suites) drop(suite);
      return copy;
    },
  },
  {
    name: "a P03 parameterisation substituted by a second copy of the other",
    nc: "NC3",
    fails: "integrity",
    entry: () => {
      let first;
      const copy = edit(
        NEG["author-negatives/NC3"],
        { id: "P03" },
        (_r, _t, spec) => {
          first ??= spec.title;
        },
      );
      for (const { spec } of specsOf(copy.report))
        if (idOf(spec) === "P03") spec.title = first;
      return copy;
    },
  },
  {
    name: "an extra case beside the selection",
    nc: "NC2",
    fails: "integrity",
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC2"]);
      const extra = [...specsOf(NEG["author-negatives/NC1"].report)].find(
        ({ spec }) => idOf(spec) === "S10",
      );
      copy.report.suites[0].suites[0].specs.push(structuredClone(extra.spec));
      return copy;
    },
  },
  {
    name: "a retried case",
    nc: "NC2",
    fails: "integrity",
    entry: () =>
      edit(
        NEG["author-negatives/NC2"],
        { id: "S21", engine: "webkit" },
        (_r, t) => {
          t.results = [structuredClone(t.results[0]), ...t.results];
        },
      ),
  },
  {
    name: "a skipped case",
    nc: "NC1",
    fails: "integrity",
    entry: () =>
      edit(
        NEG["author-negatives/NC1"],
        { id: "S13", engine: "chromium" },
        (r) => {
          r.status = "skipped";
          r.errors = [];
        },
      ),
  },
  {
    name: "an interrupted case",
    nc: "NC3",
    fails: "integrity",
    entry: () =>
      edit(
        NEG["author-negatives/NC3"],
        { id: "P03", engine: "firefox" },
        (r) => {
          r.status = "interrupted";
        },
      ),
  },
  {
    name: "a report-level error",
    nc: "NC4",
    fails: "integrity",
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC4"]);
      copy.report.errors = [{ message: "Error: a worker crashed" }];
      return copy;
    },
  },
  {
    name: "a run whose exit says it passed",
    nc: "NC1",
    fails: "integrity",
    entry: () => ({ ...structuredClone(NEG["author-negatives/NC1"]), exit: 0 }),
  },
  {
    name: "a run that exited 2, not 1",
    nc: "NC1",
    fails: "integrity",
    entry: () => ({ ...structuredClone(NEG["author-negatives/NC1"]), exit: 2 }),
  },
  {
    name: "a run ended by a signal",
    nc: "NC2",
    fails: "integrity",
    entry: () => ({
      ...structuredClone(NEG["author-negatives/NC2"]),
      signal: "SIGKILL",
    }),
  },
  {
    name: "a spec with something appended after the hook",
    nc: "NC1",
    fails: "integrity",
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC1"]);
      copy.spec = `${copy.spec}test.beforeEach(async () => undefined);\n`;
      return copy;
    },
  },
  {
    name: "a spec with the hook appended twice",
    nc: "NC3",
    fails: "integrity",
    entry: () => {
      const copy = structuredClone(NEG["author-negatives/NC3"]);
      copy.spec = `${copy.spec}${evaluator.FAULT_HOOK}`;
      return copy;
    },
  },
  {
    name: "the live spec, without the hook",
    nc: "NC1",
    fails: "integrity",
    entry: () => ({
      ...structuredClone(NEG["author-negatives/NC1"]),
      spec: A6.spec.text,
    }),
  },
  {
    name: "the fault's own statement and text, raised on a line of the case's body",
    nc: "NC1",
    fails: "scenario",
    entry: () => movedTo(NEG["author-negatives/NC1"], "S10", 750),
  },
  {
    name: "the setup assertion's text, raised on a line of P03's body",
    nc: "NC3",
    fails: "scenario",
    entry: () => movedTo(NEG["author-negatives/NC3"], "P03", 230),
  },
  {
    name: "the intended fault, then an unrelated runtime error",
    nc: "NC1",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC1"],
        { id: "S12", engine: "chromium" },
        (r) => {
          r.errors.push({
            message: "TypeError: an unrelated runtime failure",
            location: { ...r.errors[0].location, line: 783 },
          });
        },
      ),
  },
  {
    name: "an unrelated runtime error, then the intended fault",
    nc: "NC1",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC1"],
        { id: "S14", engine: "webkit" },
        (r) => {
          r.errors.unshift({
            message: "TypeError: an unrelated runtime failure",
            location: { ...r.errors[0].location, line: 807 },
          });
        },
      ),
  },
  {
    name: "a timeout in the body, not in the appended beforeEach",
    nc: "NC2",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC2"],
        { id: "S21", engine: "chromium" },
        (r) => {
          r.errors = [{ message: "Test timeout of 30000ms exceeded." }];
        },
      ),
  },
  {
    name: "a beforeEach timeout of 5000 ms, not the original 30000 ms",
    nc: "NC2",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC2"],
        { id: "S21", engine: "firefox" },
        (r) => {
          r.errors[0].message = r.errors[0].message.replace(
            "30000ms",
            "5000ms",
          );
          r.duration = 5012;
        },
      ),
  },
  {
    name: "the right timeout message after less than 30 s",
    nc: "NC2",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC2"],
        { id: "S21", engine: "webkit" },
        (r) => {
          r.duration = 1200;
        },
      ),
  },
  {
    name: "the hook's timeout reported as an ordinary failure",
    nc: "NC2",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC2"],
        { id: "S21", engine: "chromium" },
        (r) => {
          r.status = "failed";
        },
      ),
  },
  {
    name: "a setup assertion with other values",
    nc: "NC3",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC3"],
        { id: "P03", engine: "webkit", param: 1 },
        (r) => {
          r.errors[0].message = r.errors[0].message.replace(
            new RegExp(`Received: (${String.fromCharCode(27)}\\[[0-9;]*m)?1`),
            "Received: $13",
          );
        },
      ),
  },
  {
    name: "NC4 without HM2's unjoined-call error (the call joined)",
    nc: "NC4",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC4"],
        { id: "S1", engine: "chromium" },
        (r) => {
          r.errors = r.errors.slice(0, 2);
          const ledger = ledgerOf(r);
          ledger.scopes[0].calls[0].joined = true;
          setLedger(r, ledger);
        },
      ),
  },
  {
    name: "NC4 without the teardown error",
    nc: "NC4",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC4"],
        { id: "S1", engine: "firefox" },
        (r) => {
          r.errors.splice(1, 1);
        },
      ),
  },
  {
    name: "NC4 without its held-operations ledger",
    nc: "NC4",
    fails: "scenario",
    entry: () =>
      edit(NEG["author-negatives/NC4"], { id: "S1", engine: "webkit" }, (r) => {
        r.attachments = r.attachments.filter(
          (a) => a.name !== "held-operations",
        );
      }),
  },
  {
    name: "NC4 whose ledger says the call was joined",
    nc: "NC4",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC4"],
        { id: "S1", engine: "chromium" },
        (r) => {
          const ledger = ledgerOf(r);
          ledger.scopes[0].calls[0].joined = true;
          setLedger(r, ledger);
        },
      ),
  },
  {
    name: "NC4's teardown error before the intended assertion",
    nc: "NC4",
    fails: "scenario",
    entry: () =>
      edit(
        NEG["author-negatives/NC4"],
        { id: "S1", engine: "firefox" },
        (r) => {
          r.errors = [r.errors[1], r.errors[0], r.errors[2]];
        },
      ),
  },
  {
    name: "NC4 replaced by a setup runtime error before S1's body",
    nc: "NC4",
    fails: "scenario",
    entry: () => {
      const error = NC1_ERROR();
      return edit(
        NEG["author-negatives/NC4"],
        { id: "S1", engine: "webkit" },
        (r) => {
          r.errors = [error];
          r.attachments = r.attachments.filter(
            (a) => a.name !== "held-operations",
          );
        },
      );
    },
  },
  {
    name: "healthy S21 evidence in every engine, under NC2",
    nc: "NC2",
    fails: "scenario",
    entry: () => {
      let copy = NEG["author-negatives/NC2"];
      for (const engine of B)
        copy = transplant(copy, A6.control, "S21", engine);
      return copy;
    },
  },
  ...[
    ["the hook was given another fault", () => ({ fault: "runtime" })],
    ["the hook was given other probes", () => ({ fault_ids: ["S1", "S2"] })],
    ["NC4's mutant was not installed", () => ({ installed: [] })],
    [
      "the copy's spec is not the live spec plus the hook",
      () => ({ copied_spec_sha256: "other" }),
    ],
    [
      "the copied tree changed during the run",
      () => ({
        copy_problems: {
          before: [],
          after: ["tests/e2e/helpers.ts: differs from what was copied"],
        },
      }),
    ],
    ["the copied tree was never checked", () => ({ copy_problems: undefined })],
    [
      "the recorded invocation is another control's",
      () => ({ negative_control: "NC1" }),
    ],
  ].map(([name, change]) => ({
    name: `provenance: ${name}`,
    nc: "NC4",
    fails: "integrity",
    provenance: (nc) => provenanceOf(nc, change(nc)),
    entry: () => NEG["author-negatives/NC4"],
  })),
];
const negativeOf = (q, a) =>
  judgeNeg(q, a.nc, a.entry(), {
    browsers: a.browsers,
    provenance: a.provenance?.(ncOf(q, a.nc)),
  });

/** A campaign's recorded parts as the runner records them (genuine judgements of genuine runs). */
function campaignParts(q) {
  return {
    preflight: true,
    fatal: null,
    interrupted: false,
    sourceUnchanged: true,
    prerequisite: null,
    planned: {
      controls: ["control", "copy-control"],
      negatives: ["NC1", "NC2", "NC3", "NC4"],
      mutants: ["HM1", "HM2"],
    },
    controls: [
      { name: "control", ok: true },
      { name: "copy-control", ok: true },
    ],
    negatives: ["NC1", "NC2", "NC3", "NC4"].map((id) =>
      judgeNeg(q, id, NEG[`author-negatives/${id}`]),
    ),
    mutants: ["HM1", "HM2"].map((id) => judge(q, id, A6.mutants[id])),
  };
}
const CONTROLS_SUMMARY = {
  passed: true,
  stage: "controls",
  contract: evaluator.CONTRACT_VERSION,
  source_unchanged: true,
  browsers: B,
  control_probes: [
    "P01",
    "P03",
    "P14",
    "S1",
    "S7",
    "S10",
    "S11",
    "S12",
    "S13",
    "S14",
    "S21",
  ],
  controls: [
    { name: "control", ok: true },
    { name: "copy-control", ok: true },
  ],
};
const NEGATIVE_PROBES = ["S10", "S11", "S12", "S13", "S14", "S21", "P03", "S1"];
const prerequisite = (q, summary = {}, source = "same") =>
  q.prerequisiteProblems(
    { summary: { ...CONTROLS_SUMMARY, ...summary }, source },
    { source: "same", browsers: B, probes: NEGATIVE_PROBES },
  );

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
  // Review r22's real reports (its own hook): the classifier refuses them; as negative controls they are historical, never qualified.
  for (const [name, nc] of [
    ["runtime", "NC1"],
    ["timeout", "NC2"],
  ])
    check(
      `review r22 ${name}: refused by the classifier, not qualified`,
      () => {
        const control = ncOf(q, nc);
        const run = q.normalise(
          REVIEW[name].report,
          B,
          REVIEW[name].exit,
          REVIEW[name].spec,
        );
        return (
          q.judgeMutant(control.contract, run, B).verdict === "invalid" &&
          !q.judgeNegative(control, run, B).qualified
        );
      },
    );
  for (const name of GENUINE)
    check(`genuine ${name} qualified`, () => {
      const judged = judgeNeg(q, name.split("/")[1], NEG[name]);
      return (
        judged.qualified &&
        judged.outcome === "qualified" &&
        judged.integrity.valid &&
        judged.scenario.valid &&
        judged.classifier.refused
      );
    });
  check(
    "genuine NC4 with its recorded invocation qualified",
    () =>
      judgeNeg(q, "NC4", NEG["author-negatives/NC4"], {
        provenance: provenanceOf(ncOf(q, "NC4")),
      }).qualified,
  );
  for (const [name, nc] of [
    ["review/unexpected-setup-NC2", "NC2"],
    ["review/unexpected-setup-NC4", "NC4"],
  ])
    check(`review r23 ${name}: wrong fault, not qualified`, () => {
      const judged = judgeNeg(q, nc, NEG[name]);
      return (
        !judged.qualified &&
        !judged.scenario.valid &&
        judged.scenario.cases.every((c) => !c.valid) &&
        judged.classifier.refused
      );
    });
  check("review r23 genuine NC1 in its extended tree: not qualified", () => {
    const judged = judgeNeg(q, "NC1", NEG["review/genuine-NC1"]);
    return (
      !judged.qualified && !judged.integrity.valid && judged.scenario.valid
    );
  });
  check("a genuine runtime fault on S21 is not NC2's timeout", () => {
    const judged = judgeNeg(
      q,
      "NC2",
      select(NEG["author-negatives/NC1"], ["S21"]),
    );
    return (
      !judged.qualified &&
      judged.integrity.valid &&
      !judged.scenario.valid &&
      judged.classifier.refused
    );
  });
  for (const a of NEGATIVE_ADVERSARIAL)
    check(`negative adversarial: ${a.name}`, () => {
      const judged = negativeOf(q, a);
      return !judged.qualified && !judged[a.fails].valid;
    });
  check(
    "the campaign of genuine parts passes",
    () => q.campaignOutcome(campaignParts(q)).passed,
  );
  for (const [name, change] of [
    [
      "one NC1 judgement standing for all four",
      (p) => ({ negatives: p.negatives.map(() => p.negatives[0]) }),
    ],
    [
      "a refused but unqualified negative control",
      (p) => ({
        negatives: [
          p.negatives[0],
          judgeNeg(q, "NC2", NEG["review/unexpected-setup-NC2"]),
          ...p.negatives.slice(2),
        ],
      }),
    ],
    [
      "revision 23's record of a refused negative control",
      (p) => ({
        negatives: [
          { negative_control: "NC1", verdict: "invalid", refused: true },
          ...p.negatives.slice(1),
        ],
      }),
    ],
    [
      "a negative control recorded twice beside the others",
      (p) => ({ negatives: [...p.negatives, p.negatives[0]] }),
    ],
    [
      "a mutant recorded twice in place of another",
      (p) => ({ mutants: [p.mutants[0], p.mutants[0]] }),
    ],
    [
      "an unplanned control",
      (p) => ({ controls: [...p.controls, { name: "extra", ok: true }] }),
    ],
    [
      "an unmet prerequisite",
      () => ({ prerequisite: { problems: ["the controls run did not pass"] } }),
    ],
  ])
    check(`campaign: ${name} fails`, () => {
      const parts = campaignParts(q);
      return q.campaignOutcome({ ...parts, ...change(parts) }).exitCode === 1;
    });
  check(
    "prerequisite: a matching controls run is met",
    () => prerequisite(q).length === 0,
  );
  for (const [name, summary, source] of [
    ["a failed controls run", { passed: false }],
    ["a negatives run", { stage: "negatives" }],
    ["other source", {}, "other"],
    ["other engines", { browsers: ["chromium"] }],
    ["no copy control", { controls: [{ name: "control", ok: true }] }],
    [
      "controls that did not cover S1 and P03",
      { control_probes: ["S10", "S11", "S12", "S13", "S14", "S21"] },
    ],
    ["revision 23's summary (no probe list)", { control_probes: undefined }],
  ])
    check(
      `prerequisite: ${name} is not met`,
      () => prerequisite(q, summary, source).length > 0,
    );
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

test("Q1: review r22's real preparation-error and hook-timeout reports are invalid, never caught, and qualify no negative control", () => {
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
  // Its own hook (other text) is not the runner's: a classifier diagnostic only (design assessment C5), never a qualified NC1.
  const nc1 = evaluator.judgeNegative(
    evaluator.NEGATIVE_CONTROLS[0],
    runtime,
    B,
  );
  assert.equal(nc1.classifier.refused, true);
  assert.equal(nc1.qualified, false);
  assert.ok(
    nc1.integrity.problems.includes(
      "the spec that ran has no negative-control fault hook",
    ),
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
  const nc2 = evaluator.judgeNegative(
    evaluator.NEGATIVE_CONTROLS[1],
    timeout,
    B,
  );
  assert.equal(nc2.classifier.refused, true);
  assert.equal(nc2.qualified, false);
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
  // Revision 24 (design assessment Q6): each removes one predicate of a negative control's qualification or its admission.
  [
    "EM11 a negative control qualifies without its scenario",
    "  const qualified = integrity.length === 0 && scenario.length === 0 && refused;",
    "  const qualified = integrity.length === 0 && refused;",
  ],
  [
    "EM12 a negative control qualifies without the run's integrity",
    "  const qualified = integrity.length === 0 && scenario.length === 0 && refused;",
    "  const qualified = scenario.length === 0 && refused;",
  ],
  [
    "EM13 the classifier's refusal is inverted",
    "  const qualified = integrity.length === 0 && scenario.length === 0 && refused;",
    "  const qualified = integrity.length === 0 && scenario.length === 0 && !refused;",
  ],
  [
    "EM14 the fault hook's error may be raised on any line",
    "      error.location.line !== line ||\n      error.frame?.line !== line ||\n",
    "",
  ],
  [
    "EM15 a narrow engine selection qualifies",
    '      : "narrow";',
    '      : "full";',
  ],
  [
    "EM16 NC4's ledger is not read",
    "      ledger: HM2_S1.ledger,",
    "      ledger: {},",
  ],
  [
    "EM17 NC2 need not spend its 30 s",
    "      minDuration: 30000,",
    "      minDuration: 0,",
  ],
  [
    "EM18 a planned part may run more than once",
    "    else if (have !== want)",
    "    else if (have < want)",
  ],
  [
    "EM19 a recorded invocation is not checked",
    "  if (provenance !== undefined)\n    integrity.push(...provenanceProblems(nc, provenance));",
    "",
  ],
  [
    "EM20 the hook need not end the spec",
    "  else if (!run.fault_hook.once || !run.fault_hook.appended)",
    "  else if (!run.fault_hook.once)",
  ],
  [
    "EM21 a signal is ignored",
    "  if (run.signal) problems.push(`Playwright was ended by ${run.signal}`);",
    "",
  ],
  [
    "EM22 the campaign admits a refused negative control",
    "    if (n.contract !== NEGATIVE_CONTRACT_VERSION || n.qualified !== true)",
    "    if (n.classifier?.refused !== true && n.refused !== true)",
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

test("Q9: the campaign passes only when exactly the planned parts ran, each once and sound", () => {
  const base = campaignParts(evaluator);
  assert.deepEqual(evaluator.campaignOutcome(base), {
    passed: true,
    exitCode: 0,
    reasons: [],
  });
  const nc = base.negatives;
  const failing = [
    { mutants: [base.mutants[0], { ...base.mutants[1], verdict: "survived" }] },
    { mutants: [base.mutants[0], { ...base.mutants[1], verdict: "invalid" }] },
    { mutants: [base.mutants[0]] },
    { mutants: [base.mutants[0], base.mutants[0]] },
    { mutants: [base.mutants[0], { ...base.mutants[1], contract: "older/0" }] },
    { negatives: nc.slice(1) },
    { negatives: [] },
    { negatives: [...nc, nc[0]] },
    { negatives: nc.map(() => nc[0]) },
    {
      negatives: [
        { ...nc[0], qualified: false, outcome: "unqualified" },
        ...nc.slice(1),
      ],
    },
    {
      negatives: [
        { ...nc[0], contract: "web08d-held-operation-qualification/1" },
        ...nc.slice(1),
      ],
    },
    {
      negatives: [
        { negative_control: "NC1", verdict: "invalid", refused: true },
        ...nc.slice(1),
      ],
    },
    { negatives: [...nc.slice(0, 3), { ...nc[3], negative_control: "NC9" }] },
    { controls: [base.controls[0]] },
    { controls: [base.controls[0], base.controls[0]] },
    { controls: [base.controls[0], { name: "copy-control", ok: false }] },
    { prerequisite: { problems: ["its controls did not cover S1"] } },
    { interrupted: true },
    { fatal: "Error: preview readiness failed" },
    { sourceUnchanged: false },
    { preflight: false },
  ];
  for (const change of failing) {
    const outcome = evaluator.campaignOutcome({ ...base, ...change });
    assert.equal(outcome.exitCode, 1, JSON.stringify(Object.keys(change)));
    assert.ok(outcome.reasons.length > 0);
  }
  // Review r23's synthetic campaign: NC1's genuine evidence judged under all four controls' contracts. Only NC1 qualifies.
  const nc1Everywhere = ["NC1", "NC2", "NC3", "NC4"].map((id) =>
    judgeNeg(evaluator, id, NEG["author-negatives/NC1"]),
  );
  assert.deepEqual(
    nc1Everywhere.map((n) => n.qualified),
    [true, false, false, false],
  );
  assert.equal(
    evaluator.campaignOutcome({ ...base, negatives: nc1Everywhere }).exitCode,
    1,
  );
});

test("Q1 (genuine): revision 23's eight real negative-control runs qualify, case by case, in all three engines", () => {
  const sizes = { NC1: 18, NC2: 3, NC3: 6, NC4: 3 };
  for (const name of GENUINE) {
    const id = name.split("/")[1];
    const judged = judgeNeg(evaluator, id, NEG[name]);
    assert.deepEqual(judged.problems, [], name);
    assert.equal(judged.qualified, true, name);
    assert.equal(judged.contract, evaluator.NEGATIVE_CONTRACT_VERSION);
    assert.equal(judged.coverage, "full");
    assert.equal(judged.scenario.cases.length, sizes[id], name);
    assert.ok(
      judged.scenario.cases.every((c) => c.valid),
      name,
    );
    assert.equal(judged.classifier.verdict, "invalid", name);
    assert.ok(
      judged.classifier.cases.every((c) => c.role === "invalid"),
      name,
    );
  }
});

test("Q1 (genuine): review r23's wrong-fault reports are unqualified by their scenario in every case; the classifier still refuses them", () => {
  for (const [name, id] of [
    ["review/unexpected-setup-NC2", "NC2"],
    ["review/unexpected-setup-NC4", "NC4"],
  ]) {
    const judged = judgeNeg(evaluator, id, NEG[name]);
    assert.equal(judged.qualified, false, name);
    assert.equal(judged.outcome, "unqualified");
    assert.equal(judged.classifier.refused, true, name);
    assert.equal(judged.scenario.cases.length, 3);
    assert.ok(
      judged.scenario.cases.every((c) => !c.valid),
      name,
    );
    // Its tree also carried the review's own extra hook after the runner's: not the runner's copy either.
    assert.ok(
      judged.integrity.problems.includes(
        "the spec that ran is not a spec with exactly the fault hook appended once at its end",
      ),
    );
  }
  const nc2 = judgeNeg(evaluator, "NC2", NEG["review/unexpected-setup-NC2"]);
  assert.ok(
    nc2.scenario.problems.every((p) =>
      p.includes("status failed, expected timedOut"),
    ),
  );
  const nc4 = judgeNeg(evaluator, "NC4", NEG["review/unexpected-setup-NC4"]);
  assert.ok(
    nc4.scenario.problems.every((p) => p.includes("1 error(s), expected 3")),
  );
  assert.ok(
    nc4.scenario.problems.every((p) => p.includes("no held-operations ledger")),
  );
  // Its genuine NC1 is the right scenario in a tree that is not the runner's copy.
  const nc1 = judgeNeg(evaluator, "NC1", NEG["review/genuine-NC1"]);
  assert.equal(nc1.scenario.valid, true);
  assert.equal(nc1.integrity.valid, false);
  assert.equal(nc1.qualified, false);
});

test("Q1 (genuine): a real runtime fault on S21 is not NC2's timeout, though the run's integrity holds", () => {
  const judged = judgeNeg(
    evaluator,
    "NC2",
    select(NEG["author-negatives/NC1"], ["S21"]),
  );
  assert.equal(judged.integrity.valid, true);
  assert.equal(judged.classifier.refused, true);
  assert.equal(judged.scenario.valid, false);
  assert.equal(judged.qualified, false);
});

for (const a of NEGATIVE_ADVERSARIAL)
  test(`Q2 (synthetic): ${a.name} leaves ${a.nc} unqualified (${a.fails})`, () => {
    const judged = negativeOf(evaluator, a);
    assert.equal(judged.qualified, false);
    assert.equal(judged[a.fails].valid, false);
    assert.ok(judged.problems.length > 0);
  });

test("Q2: a matching recorded invocation keeps a genuine run qualified; a scenario needs every engine", () => {
  for (const id of ["NC1", "NC2", "NC3", "NC4"]) {
    const nc = ncOf(evaluator, id);
    const judged = judgeNeg(evaluator, id, NEG[`author-negatives/${id}`], {
      provenance: provenanceOf(nc),
    });
    assert.equal(judged.provenance_checked, true);
    assert.equal(judged.qualified, true, id);
  }
  assert.deepEqual(
    evaluator.provenanceProblems(ncOf(evaluator, "NC1"), undefined),
    ["no invocation provenance"],
  );
});

test("Q2: the negative contracts are total, and their hook lines are the runner's hook", () => {
  const hook = evaluator.faultHookOf(`${A6.spec.text}${evaluator.FAULT_HOOK}`);
  assert.equal(hook.appended, true);
  assert.equal(hook.once, true);
  const base = A6.spec.text.split("\n").length;
  assert.equal(hook.from, base + 1);
  assert.equal(
    hook.lines[
      'throw new Error("negative control: an ordinary runtime error before the probe body");'
    ],
    948,
  );
  assert.equal(hook.lines["test.beforeEach(async ({}, info) => {"], 945);
  assert.equal(evaluator.faultHookOf(A6.spec.text), null);
  for (const nc of evaluator.NEGATIVE_CONTROLS) {
    assert.ok(
      nc.scenario.errors.some((e) => e.hook),
      nc.id,
    );
    assert.ok(evaluator.FAULTS.includes(nc.fault), nc.id);
  }
  // The appended hook ends the last test's own lines.
  const run = evaluator.normalise(
    NEG["author-negatives/NC1"].report,
    B,
    1,
    NEG["author-negatives/NC1"].spec,
  );
  assert.ok(run.cases.every((c) => c.range.to <= hook.from));
});

test("Q3/C3: a --stage negatives prerequisite is a passed controls run of this source and engines covering every injected probe", () => {
  assert.deepEqual(prerequisite(evaluator), []);
  assert.deepEqual(
    evaluator.prerequisiteProblems(null, {
      source: "s",
      browsers: B,
      probes: [],
    }),
    ["no controls evidence"],
  );
  for (const [summary, source] of [
    [{ passed: false }],
    [{ stage: "all" }],
    [{ contract: "older/0" }],
    [{ source_unchanged: false }],
    [{}, "other"],
    [{ browsers: ["chromium", "firefox"] }],
    [
      {
        controls: [
          { name: "control", ok: true },
          { name: "control", ok: true },
        ],
      },
    ],
    [
      {
        controls: [
          { name: "control", ok: true },
          { name: "copy-control", ok: false },
        ],
      },
    ],
    [{ control_probes: ["S10", "S11", "S12", "S13", "S14", "S21", "P03"] }],
    [{ control_probes: undefined }],
  ])
    assert.ok(
      prerequisite(evaluator, summary, source).length > 0,
      JSON.stringify(summary),
    );
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
  // Revision 24: genuine negative-control reports and the spec texts they ran.
  for (const [file, name] of [
    ["nc1", "author-negatives/NC1"],
    ["wrong-nc2", "review/unexpected-setup-NC2"],
  ]) {
    writeFileSync(
      join(dir, `.agtx/${file}-report.json`),
      JSON.stringify(NEG[name].report),
    );
    writeFileSync(join(dir, `.agtx/${file}.spec.ts`), NEG[name].spec);
  }
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
/** The judge over one of the revision 24 reports written by driverFixture. */
const negativeStep = (file, ...extra) => ({
  id: "judge",
  stage: "focused",
  requirement: "negative-control qualification propagation",
  argv: [
    process.execPath,
    "scripts/validation/held-operation-judge.mjs",
    "--report",
    `.agtx/${file}-report.json`,
    "--exit",
    "1",
    "--spec",
    `.agtx/${file}.spec.ts`,
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

test("Q7: a qualified genuine negative control exits 0 and admits the next step", (t) => {
  const dir = driverFixture(t);
  const result = driver(dir, [
    negativeStep("nc1", "--negative", "NC1"),
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  assert.equal(result.passed, true);
  assert.equal(readFileSync(join(dir, ".agtx/later"), "utf8"), "ran");
});

for (const [name, steps] of [
  [
    "review r23's wrong-fault NC2 (its reproduction of R23-N1)",
    [negativeStep("wrong-nc2", "--negative", "NC2")],
  ],
  [
    "review r22's runtime report as NC1 (another hook: a classifier diagnostic only)",
    [judgeStep("judge", "--negative", "NC1")],
  ],
  [
    "a genuine NC1 report judged as NC2",
    [negativeStep("nc1", "--negative", "NC2")],
  ],
  [
    "a genuine NC1 report narrowed to Chromium",
    [negativeStep("nc1", "--negative", "NC1", "--browsers", "chromium")],
  ],
  [
    "a negative control asked to expect anything but qualified",
    [negativeStep("wrong-nc2", "--negative", "NC2", "--expect", "unqualified")],
  ],
  ["a missing report", [negativeStep("absent", "--negative", "NC1")]],
])
  test(`Q7: ${name} exits non-zero and the shared driver admits no later work`, (t) => {
    const dir = driverFixture(t);
    const result = driver(dir, [...steps, laterStep]);
    assert.equal(result.passed, false);
    assert.notEqual(result.records[0].exit, 0);
    assert.equal(result.records[1].status, "not_run");
    assert.equal(existsSync(join(dir, ".agtx/later")), false);
  });

test("Q7: a classifier diagnostic of a wrong-fault report still says the mutant contract refuses it", (t) => {
  const dir = driverFixture(t);
  const result = driver(dir, [
    negativeStep(
      "wrong-nc2",
      "--mutant",
      "HM12",
      "--probes",
      "S21",
      "--expect",
      "invalid",
    ),
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  assert.equal(result.passed, true);
});

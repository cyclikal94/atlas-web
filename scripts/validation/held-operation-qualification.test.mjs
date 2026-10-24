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
//
// Revision 25 (review r24 R24-N1; design assessment 91d0404c Q0-Q9): a negative control qualifies only from a VERIFIED evidence bundle
// (held-operation-evidence.mjs). The genuine runs above are now judged two ways: without evidence, as labelled diagnostics that never
// qualify; and through SYNTHETIC-CONSISTENT bundles (held-operation-test-bundles.mjs: the genuine report bytes with real digests and a
// controller-shaped execution record), as the runner and the replay CLI judge them. Every binding the bundle makes is then broken one at a
// time, consistently (the derived relation must refuse it) and inconsistently (the digest must), and evaluator mutants remove each check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import * as applicabilityModule from "./held-operation-applicability.mjs";
import {
  canonical,
  compareApplicability,
} from "./held-operation-applicability.mjs";
import * as evidenceModule from "./held-operation-evidence.mjs";
import * as installationModule from "./held-operation-installation.mjs";
import { installationAssessments } from "./held-operation-installation-checks.mjs";
import * as evaluator from "./held-operation-qualification.mjs";
import {
  applicabilityRecord,
  controlBundle,
  INVOCATION,
  legacyRecord,
  negativeBundle,
  OTHER_INVOCATION,
  snapshotRecord,
  sourceOf,
  TARGET,
  withManifest,
  writeBundle,
} from "./held-operation-test-bundles.mjs";

const B = ["chromium", "firefox", "webkit"];
const root = resolve(import.meta.dirname, "../..");
/** Revision 26: the consumer's applicability target of every bound judgement here, its digest, and its comparison with itself. */
const TARGET_SHA = evidenceModule.targetDigest(TARGET);
const APPLICABLE = compareApplicability(TARGET, TARGET);
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
/** A negative control's DIAGNOSTIC judgement of a saved run, without evidence (`signal` and `browsers` as the run would record them). */
const judgeNeg = (q, id, entry, { browsers = B } = {}) =>
  q.judgeNegative(
    ncOf(q, id),
    q.normalise(entry.report, browsers, entry.exit, entry.spec, entry.signal),
    browsers,
  );
/**
 * A negative control judged from its (synthetic-consistent) bundle over a saved run, as the runner and the replay CLI judge it. Revision
 * 26: the consumer's target is named explicitly (TARGET, the record the bundle carries) unless `expect` replaces it.
 */
const bound = (q, e, id, entry, options = {}, expect = {}) =>
  e.qualifyNegative(ncOf(q, id), negativeBundle(ncOf(q, id), entry, options), {
    invocation: options.invocation ?? INVOCATION,
    target: TARGET,
    ...expect,
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
];
/** An adversarial run judged bound (revision 25): its own consistent bundle, so integrity and scenario are judged, not the evidence. */
const negativeOf = (q, e, a) =>
  bound(q, e, a.nc, a.entry(), { browsers: a.browsers ?? B });
/** The integrity problems other than the evidence's own: what the run itself shows. */
const runIntegrity = (judged) =>
  judged.integrity.problems.filter(
    (p) =>
      !p.startsWith("evidence: ") &&
      p !== "the invocation evidence is refused" &&
      p !== evaluator.NO_EVIDENCE,
  );

/** The genuine control runs' bundles (revision 22 attempt 6, all probes) and their source. */
const CONTROL_SOURCE = sourceOf(A6.spec.text);
const controlOf = (e, part, options = {}) =>
  e.judgeControlEvidence(
    controlBundle(
      part,
      part === "control" ? A6.control : A6.copy_control,
      evaluator.PROBE_IDS,
      options,
    ),
    {
      part,
      invocation: options.invocation ?? INVOCATION,
      source: (options.source ?? CONTROL_SOURCE).sha256,
      target: TARGET,
    },
  );
/** A campaign's recorded parts as the runner records them (genuine judgements of genuine runs, each from its own bundle). */
function campaignParts(q, e) {
  return {
    preflight: true,
    fatal: null,
    interrupted: false,
    sourceUnchanged: true,
    applicability: {
      target_sha256: TARGET_SHA,
      record: TARGET,
      after: APPLICABLE,
    },
    snapshot: snapshotRecord(),
    prerequisite: null,
    planned: {
      invocation: INVOCATION,
      applicability: TARGET_SHA,
      controls: ["control", "copy-control"],
      negatives: ["NC1", "NC2", "NC3", "NC4"],
      mutants: ["HM1", "HM2"],
    },
    controls: ["control", "copy-control"].map((part) => controlOf(e, part)),
    negatives: ["NC1", "NC2", "NC3", "NC4"].map((id) =>
      bound(q, e, id, NEG[`author-negatives/${id}`]),
    ),
    mutants: ["HM1", "HM2"].map((id) => judge(q, id, A6.mutants[id])),
  };
}
const CONTROLS_SUMMARY = {
  passed: true,
  applicability_sha256: TARGET_SHA,
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
/** A --stage negatives prerequisite over controls whose RAW bundles (revision 25) ran `controlIds` and are re-judged here. */
const prerequisite = (
  q,
  e,
  summary = {},
  source = CONTROL_SOURCE.sha256,
  controls,
) =>
  q.prerequisiteProblems(
    {
      summary: { ...CONTROLS_SUMMARY, ...summary },
      source,
      invocation: INVOCATION,
      controls:
        controls ??
        ["control", "copy-control"].map((part) =>
          e.judgeControlEvidence(
            controlBundle(
              part,
              select(
                part === "control" ? A6.control : A6.copy_control,
                CONTROLS_SUMMARY.control_probes,
              ),
              CONTROLS_SUMMARY.control_probes,
              { invocation: INVOCATION, source: CONTROL_SOURCE },
            ),
            {
              part,
              invocation: INVOCATION,
              source: CONTROL_SOURCE.sha256,
              target: TARGET,
            },
          ),
        ),
      applicability: {
        before: { sha256: TARGET_SHA, record: TARGET },
        after: { sha256: TARGET_SHA, record: TARGET },
      },
      snapshot: snapshotRecord(),
      inputs_runtime: { node: "v22.23.2", platform: "darwin", arch: "arm64" },
    },
    {
      source: CONTROL_SOURCE.sha256,
      browsers: B,
      probes: NEGATIVE_PROBES,
      target: TARGET,
    },
  );

// --- revision 25: the evidence boundary (design assessment 91d0404c Q2-Q5) ------------------------------------------------------------
const ENTRY = (id) => NEG[`author-negatives/${id}`];
/** The other genuine invocation's run of the same control (revision 23's second credited campaign). */
const OTHER_ENTRY = (id) => NEG[`author-probes/${id}`];
const baseOf = (entry) =>
  entry.spec.slice(0, entry.spec.indexOf(evaluator.FAULT_HOOK));
const sha = evidenceModule.sha256;
/** The same number of lines, other bytes: an alteration that leaves every case's attribution intact. */
const alter = (text) => text.replace("\n", " // altered\n");
const json = (bytes) => JSON.parse(bytes.toString("utf8"));
const rewrite = (bytes, change) => {
  const v = json(bytes);
  change(v);
  return Buffer.from(JSON.stringify(v, null, 2));
};
const judgeBundle = (q, e, id, bundle, expect = {}) =>
  e.qualifyNegative(ncOf(q, id), bundle, {
    invocation: INVOCATION,
    target: TARGET,
    ...expect,
  });
/** Replaces the copy's spec consistently: its bytes, and the inventory that records the copied tree. */
const ranSpec = (p, text) => {
  p.files.spec.bytes = Buffer.from(text);
  const inv = p.files.inventory.bytes;
  for (const when of ["before", "after"])
    inv[when] = { ...inv[when], [evaluator.PROBE_SPEC]: sha(text) };
};
const HM2_FILE = evaluator.HELPER;
const installedName = `installed:${HM2_FILE}`;
function withDisk(action) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-held-operation-evidence-"));
  try {
    return action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/**
 * SYNTHETIC evidence faults (design assessment Q2-Q5): each breaks ONE binding of a genuine run's bundle, either after its manifest (the
 * bytes are no longer the digest) or consistently before it (a derived relation must refuse it), and names the reason it must be refused.
 */
const each = (ids, make) => ids.flatMap((id) => make(id));
const ALL = ["NC1", "NC2", "NC3", "NC4"];
const EVIDENCE_CASES = [
  ...each(ALL, (id) => [
    {
      name: `${id}: the report's bytes are another genuine run's, the manifest unchanged`,
      why: /report: its bytes/,
      judge: (q, e) =>
        judgeBundle(
          q,
          e,
          id,
          negativeBundle(ncOf(q, id), ENTRY(id), {
            tamper: (b) => {
              b.files.report = negativeBundle(
                ncOf(q, id),
                OTHER_ENTRY(id),
              ).files.report;
            },
          }),
        ),
    },
    {
      name: `${id}: a recorded exit of 0 beside the failing report (review r24's mixed receipt)`,
      why: /exit 0/,
      judge: (q, e) =>
        judgeBundle(
          q,
          e,
          id,
          negativeBundle(ncOf(q, id), ENTRY(id), {
            edit: (p) => {
              p.execution.exit = 0;
            },
          }),
        ),
    },
    {
      name: `${id}: another genuine invocation's report supplied beside this bundle (cross-invocation)`,
      why: /the supplied report/,
      judge: (q, e) =>
        judgeBundle(q, e, id, negativeBundle(ncOf(q, id), ENTRY(id)), {
          report_sha256: sha(
            negativeBundle(ncOf(q, id), OTHER_ENTRY(id), {
              invocation: OTHER_INVOCATION,
            }).files.report,
          ),
        }),
    },
    {
      name: `${id}: this run's report and execution beside another invocation's manifest (cross-invocation)`,
      why: /its bytes/,
      judge: (q, e) => {
        const mine = negativeBundle(ncOf(q, id), ENTRY(id));
        return judgeBundle(
          q,
          e,
          id,
          negativeBundle(ncOf(q, id), OTHER_ENTRY(id), {
            invocation: OTHER_INVOCATION,
            tamper: (b) => {
              b.files.report = mine.files.report;
              b.files.execution = mine.files.execution;
            },
          }),
          { invocation: OTHER_INVOCATION },
        );
      },
    },
  ]),
  ...[
    [
      "the report reformatted (the same JSON, other bytes)",
      /report: its bytes/,
      (b) => {
        b.files.report = Buffer.from(
          JSON.stringify(json(b.files.report), null, 1),
        );
      },
    ],
    [
      "the execution record's bytes say exit 0",
      /execution: its bytes/,
      (b) => {
        b.files.execution = rewrite(b.files.execution, (x) => {
          x.exit = 0;
        });
      },
    ],
    [
      "the copy's spec bytes are the live spec",
      /spec: its bytes/,
      (b) => {
        b.files.spec = b.files[`base:${evaluator.PROBE_SPEC}`];
      },
    ],
    [
      "the source fingerprint's bytes changed",
      /source: its bytes/,
      (b) => {
        b.files.source = rewrite(b.files.source, (x) => {
          x.node = "v0";
        });
      },
    ],
    [
      "the inventory's bytes changed",
      /inventory: its bytes/,
      (b) => {
        b.files.inventory = rewrite(b.files.inventory, (x) => {
          x.after = {};
        });
      },
    ],
    [
      "the unmutated helper's bytes in place of the installed HM2",
      /installed:.*its bytes/,
      (b) => {
        b.files[installedName] = b.files[`base:${HM2_FILE}`];
      },
    ],
    [
      "no bytes read for the spec",
      /spec: not read/,
      (b) => {
        delete b.files.spec;
      },
    ],
  ].map(([name, why, tamper]) => ({
    name: `NC4: ${name}, the manifest unchanged`,
    why,
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC4",
        negativeBundle(ncOf(q, "NC4"), ENTRY("NC4"), { tamper }),
      ),
  })),
  ...[
    [
      "a recorded exit of 2",
      /exit 2, expected 1/,
      (p) => {
        p.execution.exit = 2;
      },
    ],
    [
      "no recorded signal (not even null)",
      /no signal/,
      (p) => {
        delete p.execution.signal;
      },
    ],
    [
      "a recorded SIGTERM",
      /SIGTERM/,
      (p) => {
        p.execution.signal = "SIGTERM";
      },
    ],
    [
      "the execution saw another report",
      /the execution saw report/,
      (p) => {
        p.execution.report_sha256 = sha("another report");
      },
    ],
    [
      "the hook was given another fault",
      /given fault runtime/,
      (p) => {
        p.execution.env.ATLAS_PROBE_FAULT = "runtime";
      },
    ],
    [
      "the hook was given other probes",
      /given probes S1,S2/,
      (p) => {
        p.execution.env.ATLAS_PROBE_FAULT_IDS = "S1,S2";
      },
    ],
    [
      "a Chromium-only run",
      /narrow engine selection/,
      (p) => {
        p.execution.argv = p.execution.argv.filter(
          (a) =>
            !a.startsWith("--project=") || a === "--project=fixture-chromium",
        );
      },
    ],
    [
      "a run with one retry",
      /--retries=/,
      (p) => {
        p.execution.argv = p.execution.argv.map((a) =>
          a === "--retries=0" ? "--retries=1" : a,
        );
      },
    ],
    [
      "a run with two workers",
      /--workers=/,
      (p) => {
        p.execution.argv = p.execution.argv.map((a) =>
          a === "--workers=1" ? "--workers=2" : a,
        );
      },
    ],
    [
      "a run of another probe selection",
      /the run selected/,
      (p) => {
        const g = p.execution.argv.indexOf("-g");
        p.execution.argv[g + 1] = evidenceModule.grepOf(["S1", "S2"]);
      },
    ],
    [
      "an environment that is not selection",
      /environment has ATLAS_FIXTURE_URL/,
      (p) => {
        p.execution.env.ATLAS_FIXTURE_URL = "http://127.0.0.1:1";
      },
    ],
    [
      "no argv",
      /no argv/,
      (p) => {
        p.execution.argv = undefined;
      },
    ],
    [
      "the copy ran the live spec without the hook",
      /not the source's spec with exactly/,
      (p) => {
        ranSpec(
          p,
          p.files[`base:${evaluator.PROBE_SPEC}`].bytes.toString("utf8"),
        );
      },
    ],
    [
      "the copy ran another hook",
      /not the source's spec with exactly/,
      (p) => {
        ranSpec(
          p,
          `${p.files[`base:${evaluator.PROBE_SPEC}`].bytes}${evaluator.FAULT_HOOK.replace("negative control: an unrelated", "negative control: an unrelated (other)")}`,
        );
      },
    ],
    [
      "the live snapshot and the copy altered alike (equal but wrong)",
      /live spec snapshot is not the source's/,
      (p) => {
        const base = alter(
          p.files[`base:${evaluator.PROBE_SPEC}`].bytes.toString("utf8"),
        );
        p.files[`base:${evaluator.PROBE_SPEC}`].bytes = Buffer.from(base);
        ranSpec(p, `${base}${evaluator.FAULT_HOOK}`);
      },
    ],
    [
      "the fingerprint's spec digest edited without the fingerprint's digest",
      /files are not its digest/,
      (p) => {
        const base = alter(
          p.files[`base:${evaluator.PROBE_SPEC}`].bytes.toString("utf8"),
        );
        p.files[`base:${evaluator.PROBE_SPEC}`].bytes = Buffer.from(base);
        ranSpec(p, `${base}${evaluator.FAULT_HOOK}`);
        p.files.source.bytes = {
          ...p.files.source.bytes,
          files: {
            ...p.files.source.bytes.files,
            [evaluator.PROBE_SPEC]: sha(base),
          },
        };
      },
    ],
    [
      "an extra file in the copy before the run",
      /before: tests\/e2e\/extra\.ts is not in the source's tree/,
      (p) => {
        const inv = p.files.inventory.bytes;
        inv.before = { ...inv.before, "tests/e2e/extra.ts": sha("x") };
      },
    ],
    [
      "a file of the copy lost during the run",
      /after: tests\/e2e\/helpers\.ts is missing/,
      (p) => {
        const inv = p.files.inventory.bytes;
        inv.after = { ...inv.after };
        delete inv.after["tests/e2e/helpers.ts"];
      },
    ],
    [
      "a file of the copy changed during the run",
      /after: tests\/e2e\/helpers\.ts is not the expected bytes/,
      (p) => {
        const inv = p.files.inventory.bytes;
        inv.after = { ...inv.after, "tests/e2e/helpers.ts": sha("changed") };
      },
    ],
    [
      "a non-regular file in the copy",
      /not a regular file/,
      (p) => {
        const inv = p.files.inventory.bytes;
        inv.after = { ...inv.after, "tests/e2e/helpers.ts": null };
      },
    ],
    [
      "no inventory after the run",
      /no after inventory/,
      (p) => {
        p.files.inventory.bytes = { before: p.files.inventory.bytes.before };
      },
    ],
    [
      "HM3 installed in place of HM2",
      /is not HM2 applied once/,
      (p) => {
        const text = evaluator
          .mutantOf("HM3")
          .patch(p.files[`base:${HM2_FILE}`].bytes.toString("utf8"));
        p.files[installedName].bytes = Buffer.from(text);
        const inv = p.files.inventory.bytes;
        for (const when of ["before", "after"])
          inv[when] = { ...inv[when], [HM2_FILE]: sha(text) };
      },
    ],
    [
      "the unmutated helper installed while the inventory claims HM2",
      /is not HM2 applied once/,
      (p) => {
        p.files[installedName].bytes = p.files[`base:${HM2_FILE}`].bytes;
      },
    ],
    [
      "a helper snapshot that is not the source's",
      /snapshot is not the source's/,
      (p) => {
        const base = alter(p.files[`base:${HM2_FILE}`].bytes.toString("utf8"));
        const text = evaluator.mutantOf("HM2").patch(base);
        p.files[`base:${HM2_FILE}`].bytes = Buffer.from(base);
        p.files[installedName].bytes = Buffer.from(text);
        const inv = p.files.inventory.bytes;
        for (const when of ["before", "after"])
          inv[when] = { ...inv[when], [HM2_FILE]: sha(text) };
      },
    ],
    [
      "no installed helper",
      /no installed:/,
      (p) => {
        delete p.files[installedName];
      },
    ],
    [
      "another control's part name",
      /the bundle is part NC1/,
      (p) => {
        p.header.part = "NC1";
      },
    ],
    [
      "a control part",
      /control part/,
      (p) => {
        p.header.kind = "control";
      },
    ],
    [
      "the revision 24 negative contract",
      /contract is web08d-held-operation-negative\/1/,
      (p) => {
        p.header.contract = "web08d-held-operation-negative/1";
      },
    ],
    [
      "no invocation",
      /names no invocation/,
      (p) => {
        p.header.invocation = "";
      },
    ],
    [
      "the report's evidence run is another invocation's",
      /evidence run/,
      (p) => {
        const report = json(p.files.report.bytes);
        report.config.metadata.atlasEvidenceRun =
          report.config.metadata.atlasEvidenceRun.replace(
            INVOCATION,
            OTHER_INVOCATION,
          );
        p.files.report.bytes = Buffer.from(JSON.stringify(report));
        p.execution.report_sha256 = sha(p.files.report.bytes);
      },
    ],
    [
      "no inventory artefact",
      /no inventory artefact/,
      (p) => {
        delete p.files.inventory;
      },
    ],
  ].map(([name, why, edit]) => ({
    name: `NC4: ${name}`,
    why,
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC4",
        negativeBundle(ncOf(q, "NC4"), ENTRY("NC4"), { edit }),
      ),
  })),
  {
    name: "NC1: an installed helper beside a control that installs nothing",
    why: /unexpected installed:/,
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC1",
        negativeBundle(ncOf(q, "NC1"), ENTRY("NC1"), {
          edit: (p) => {
            p.files[installedName] = {
              path: `bundle/installed/${HM2_FILE}`,
              bytes: Buffer.from("x"),
            };
          },
        }),
      ),
  },
  {
    name: "NC1: another invocation's complete bundle, judged for this invocation",
    why: /the bundle is invocation/,
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC1",
        negativeBundle(ncOf(q, "NC1"), OTHER_ENTRY("NC1"), {
          invocation: OTHER_INVOCATION,
        }),
      ),
  },
  {
    name: "NC1: a self-consistent bundle of another source, the expected source named",
    why: /ran on source/,
    judge: (q, e) => {
      const base = NEG["author-negatives/NC1"].spec.slice(
        0,
        -evaluator.FAULT_HOOK.length,
      );
      return judgeBundle(
        q,
        e,
        "NC1",
        negativeBundle(ncOf(q, "NC1"), ENTRY("NC1"), {
          source: sourceOf(base, { "src/other.ts": sha("other") }),
        }),
        { source: sourceOf(base).sha256 },
      );
    },
  },
  ...[
    ["a supplied exit of 0", /the supplied exit 0/, { exit: 0 }],
    [
      "a supplied spec that is not the bundle's",
      /the supplied spec/,
      { spec_sha256: sha("another spec") },
    ],
    ["an unexpected source named", /ran on source/, { source: "0".repeat(64) }],
  ].map(([name, why, expect]) => ({
    name: `NC1: ${name}`,
    why,
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC1",
        negativeBundle(ncOf(q, "NC1"), ENTRY("NC1")),
        expect,
      ),
  })),
  ...[
    [
      "a wrong report digest in the manifest",
      /report: its bytes/,
      (m) => {
        m.artefacts.report.sha256 = sha("another report");
      },
    ],
    [
      "an absolute artefact path",
      /absolute path/,
      (m) => {
        m.artefacts.report.path = "/etc/report.json";
      },
    ],
    [
      "a parent artefact path",
      /not a plain relative path/,
      (m) => {
        m.artefacts.report.path = "../report.json";
      },
    ],
    [
      "a malformed digest",
      /report: no digest/,
      (m) => {
        m.artefacts.report.sha256 = "abc";
      },
    ],
    [
      "no artefact list",
      /lists no artefacts/,
      (m) => {
        delete m.artefacts;
      },
    ],
    [
      "an older schema",
      /schema/,
      (m) => {
        m.schema = "web08d-held-operation-evidence/0";
      },
    ],
    [
      "no schema",
      /schema/,
      (m) => {
        delete m.schema;
      },
    ],
  ].map(([name, why, change]) => ({
    name: `NC1: ${name}`,
    why,
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC1",
        withManifest(negativeBundle(ncOf(q, "NC1"), ENTRY("NC1")), change),
      ),
  })),
  ...[
    [
      "a truncated manifest",
      /not JSON/,
      (b) => b.manifest_bytes.subarray(0, 40),
    ],
    ["an empty manifest", /not JSON/, () => Buffer.alloc(0)],
    ["no manifest (an unfinished part)", /no published manifest/, () => null],
    [
      "a revision 24 receipt in place of the manifest",
      /schema/,
      () =>
        Buffer.from(
          JSON.stringify({
            title: "NC1",
            provenance: { negative_control: "NC1", exit: 1, signal: null },
            qualified: true,
          }),
        ),
    ],
  ].map(([name, why, bytes]) => ({
    name: `NC1: ${name}`,
    why,
    judge: (q, e) => {
      const b = negativeBundle(ncOf(q, "NC1"), ENTRY("NC1"));
      return judgeBundle(q, e, "NC1", { ...b, manifest_bytes: bytes(b) });
    },
  })),
];
/** Bound positives besides the genuine runs: the other invocation's own bundle, and the exact supplied bindings. */
const EVIDENCE_POSITIVES = [
  {
    name: "another invocation's complete bundle, judged for that invocation",
    judge: (q, e) =>
      judgeBundle(
        q,
        e,
        "NC3",
        negativeBundle(ncOf(q, "NC3"), OTHER_ENTRY("NC3"), {
          invocation: OTHER_INVOCATION,
        }),
        { invocation: OTHER_INVOCATION },
      ),
  },
  {
    name: "the bundle's own report, spec, exit and source supplied",
    judge: (q, e) => {
      const b = negativeBundle(ncOf(q, "NC4"), ENTRY("NC4"));
      return judgeBundle(q, e, "NC4", b, {
        report_sha256: sha(b.files.report),
        spec_sha256: sha(b.files.spec),
        exit: 1,
        source: json(b.files.source).sha256,
      });
    },
  },
];
/** judgeNegative given a genuine run and evidence that is not that run's verified bundle (each a SYNTHETIC record). */
const FORGED_EVIDENCE = [
  [
    "evidence the verifier refused (with no problems listed)",
    (ev) => ({ ...ev, status: "refused", problems: [] }),
  ],
  [
    "evidence of another report",
    (ev) => ({ ...ev, report_sha256: sha("another report") }),
  ],
  [
    "evidence of another spec",
    (ev) => ({ ...ev, spec_sha256: sha("another spec") }),
  ],
  [
    "evidence whose execution exited 0",
    (ev) => ({ ...ev, execution: { exit: 0, signal: null } }),
  ],
  [
    "evidence whose execution recorded no signal",
    (ev) => ({ ...ev, execution: { exit: 1 } }),
  ],
  ["evidence of another negative control", (ev) => ({ ...ev, part: "NC2" })],
  ["evidence of a control part", (ev) => ({ ...ev, kind: "control" })],
  [
    "evidence of another schema",
    (ev) => ({ ...ev, schema: "web08d-held-operation-evidence/0" }),
  ],
  [
    "evidence without a problems list",
    (ev) => ({ ...ev, problems: undefined }),
  ],
  [
    "evidence without a manifest digest",
    (ev) => ({ ...ev, manifest_sha256: null }),
  ],
  ["evidence without an invocation", (ev) => ({ ...ev, invocation: null })],
  ["null evidence", () => null],
];

// --- revision 26: runtime applicability (review r25 R25-N1; design assessment 26f1a626 Q1, Q2, Q5) -------------------------------------
/** A copy of TARGET with `field` (a dotted path) set to `value`, or deleted when `value` is DELETE. */
const DELETE = Symbol("delete");
function withField(record, field, value) {
  const copy = structuredClone(record);
  const keys = field.split(".");
  let at = copy;
  for (const k of keys.slice(0, -1)) at = at[k];
  if (value === DELETE) delete at[keys.at(-1)];
  else at[keys.at(-1)] = value;
  return copy;
}
/** A value of the same shape as `v` that is not `v` (a different runtime fact, still well formed). */
const otherValue = (field, v) => {
  const rule = applicabilityModule.FIELDS.find(([f]) => f === field)?.[1];
  return /node$/.test(field)
    ? "v22.18.0"
    : rule === "count"
      ? v + 1
      : /sha256$/.test(field) || rule === "digest-or-none"
        ? sha(`other ${field}`)
        : `${v} (other)`;
};
/** The comparison with its digests, as a bundle's verifier would judge `record` for the consumer `target`. */
const decided = (a, target, record) => a.compareApplicability(target, record);
/** The canonical list of compared fields (from the unmutated module: a mutant that drops a field must not drop its check). */
const REQUIRED_FIELDS = applicabilityModule.FIELDS;

/** Every applicability check (comparator, verifier, judgements, prerequisite, campaign) the evaluator must pass. */
function applicabilityAssessments(q, e, a, check) {
  const T = TARGET;
  check(
    "applicability: identical complete records are applicable",
    () => decided(a, T, structuredClone(T)).decision === "applicable",
  );
  for (const [field] of REQUIRED_FIELDS) {
    check(`applicability: a changed ${field} is incompatible`, () => {
      const v = field.split(".").reduce((o, k) => o?.[k], T);
      const c = decided(a, T, withField(T, field, otherValue(field, v)));
      return (
        c.decision === "incompatible" &&
        c.differences.some((d) => d.field === field)
      );
    });
    check(`applicability: a missing ${field} is unknown`, () => {
      const c = decided(a, T, withField(T, field, DELETE));
      return (
        c.decision === "unknown" &&
        c.unknown.some((u) => u.field === field && u.side === "record")
      );
    });
  }
  check(
    "applicability: two records missing the same field are unknown, never equal",
    () => {
      const r = withField(T, "child.node", DELETE);
      const c = decided(a, r, structuredClone(r));
      return c.decision === "unknown" && c.unknown.length === 2;
    },
  );
  check("applicability: a mistyped version is unknown", () => {
    const c = decided(a, T, withField(T, "controller.node", 22));
    return c.decision === "unknown";
  });
  check("applicability: an 'unknown' word is unknown, not a value", () => {
    const c = decided(a, T, withField(T, "child.user_agent", "unknown"));
    return c.decision === "unknown";
  });
  check("applicability: a malformed digest is unknown", () => {
    const c = decided(a, T, withField(T, "child.exec_sha256", "abc"));
    return c.decision === "unknown";
  });
  check("applicability: an unsupported schema is unknown on its side", () => {
    const c = decided(a, T, { ...structuredClone(T), schema: "other/9" });
    return (
      c.decision === "unknown" &&
      c.unknown.some((u) => u.field === "schema" && u.side === "record")
    );
  });
  check("applicability: no target is unknown", () => {
    const c = decided(a, undefined, T);
    return (
      c.decision === "unknown" &&
      c.unknown.some((u) => u.field === "schema" && u.side === "target")
    );
  });
  check(
    "applicability: another supported Node patch (v22.22.2) is incompatible",
    () =>
      decided(a, T, withField(T, "controller.node", "v22.22.2")).decision ===
      "incompatible",
  );
  check(
    "applicability: a location alone is no difference, and is reported",
    () => {
      const c = decided(
        a,
        T,
        withField(T, "controller.exec_path", "/elsewhere/node"),
      );
      return (
        c.decision === "applicable" &&
        c.locations.some((l) => l.field === "controller.exec_path")
      );
    },
  );
  check("applicability: Corepack in the chain or not differs", () => {
    const c = decided(a, T, withField(T, "child.corepack_tree_sha256", "none"));
    return c.decision === "incompatible";
  });
  check("applicability: another browser build is incompatible", () => {
    const c = decided(
      a,
      T,
      withField(T, "browsers.webkit.directories", {
        "webkit-2251": sha("old"),
      }),
    );
    return (
      c.decision === "incompatible" &&
      c.differences.some((d) => d.field.startsWith("browsers.webkit"))
    );
  });
  check("applicability: a changed browser installation is incompatible", () => {
    const c = decided(
      a,
      T,
      withField(
        T,
        "browsers.chromium.directories.chromium_headless_shell-1243",
        sha("x"),
      ),
    );
    return c.decision === "incompatible";
  });
  check(
    "applicability: an engine missing from one side is incompatible",
    () => {
      const r = structuredClone(T);
      delete r.browsers.firefox;
      return decided(a, T, r).decision === "incompatible";
    },
  );
  check("applicability: malformed browsers are unknown", () => {
    const c = decided(a, T, withField(T, "browsers", []));
    return c.decision === "unknown";
  });
  check("applicability: an added behavioural variable is incompatible", () => {
    const c = decided(
      a,
      T,
      withField(T, "env", { ...T.env, FORCE_COLOR: "1" }),
    );
    return (
      c.decision === "incompatible" &&
      c.differences.some((d) => d.field === "env.FORCE_COLOR")
    );
  });
  check("applicability: a changed behavioural variable is incompatible", () => {
    const c = decided(a, T, withField(T, "env", { LANG: "C" }));
    return c.decision === "incompatible";
  });
  check("applicability: a non-string variable is unknown", () => {
    const c = decided(a, T, withField(T, "env", { LANG: 1 }));
    return c.decision === "unknown";
  });
  check(
    "applicability: the behavioural environment leaves locations and selections out",
    () => {
      const env = a.behaviouralEnv({
        NODE_OPTIONS: "--x",
        PLAYWRIGHT_JSON_OUTPUT_FILE: "/r.json",
        ATLAS_PROBE_FAULT: "runtime",
        ATLAS_E2E_WORKERS: "1",
        TMPDIR: "/t",
        HOME: "/h",
        LANG: "C",
      });
      return (
        JSON.stringify(env) ===
        JSON.stringify({
          ATLAS_E2E_WORKERS: "1",
          LANG: "C",
          NODE_OPTIONS: "--x",
        })
      );
    },
  );
  check("applicability: canonical bytes do not depend on key order", () => {
    const shuffled = Object.fromEntries(Object.entries(T).reverse());
    return a.canonical(shuffled) === a.canonical(T);
  });

  // The verifier: the record is a required artefact, read as JSON, and the report's own witness must agree with it.
  const nc1 = ncOf(q, "NC1");
  const verify = (b) =>
    e.verifyBundle(b, { kind: "negative", part: "NC1", nc: nc1 });
  const witnessEdit = (change) => (p) => {
    const r = json(p.files.report.bytes);
    change(r.config.metadata);
    p.files.report.bytes = Buffer.from(JSON.stringify(r));
    p.execution.report_sha256 = sha(p.files.report.bytes);
  };
  check("verifier: a `/2` bundle with its record verifies", () => {
    const v = verify(negativeBundle(nc1, ENTRY("NC1")));
    return (
      v.status === "verified" &&
      v.legacy === false &&
      v.applicability?.sha256 === TARGET_SHA
    );
  });
  check("verifier: a report witness of another Node is refused", () => {
    const v = verify(
      negativeBundle(nc1, ENTRY("NC1"), {
        edit: witnessEdit((m) => {
          m.atlasRuntime.node = "v22.18.0";
        }),
      }),
    );
    return (
      v.status === "refused" &&
      v.problems.some((p) => p.includes("runtime witness has node"))
    );
  });
  check("verifier: a report witness of another Playwright is refused", () => {
    const v = verify(
      negativeBundle(nc1, ENTRY("NC1"), {
        edit: witnessEdit((m) => {
          m.atlasRuntime.playwright = "1.62.0";
        }),
      }),
    );
    return v.status === "refused";
  });
  check("verifier: a `/2` report without a witness is refused", () => {
    const v = verify(
      negativeBundle(nc1, ENTRY("NC1"), {
        edit: witnessEdit((m) => {
          delete m.atlasRuntime;
        }),
      }),
    );
    return (
      v.status === "refused" &&
      v.problems.some((p) => p.includes("no runtime witness"))
    );
  });
  check("verifier: a `/2` bundle without its record is refused", () => {
    const v = verify(
      negativeBundle(nc1, ENTRY("NC1"), {
        edit: (p) => {
          delete p.files.applicability;
        },
      }),
    );
    return (
      v.status === "refused" &&
      v.problems.some((p) => p.includes("no applicability artefact"))
    );
  });
  check("verifier: a record that is not JSON is refused", () => {
    const v = verify(
      negativeBundle(nc1, ENTRY("NC1"), {
        edit: (p) => {
          p.files.applicability.bytes = Buffer.from("{ not json");
        },
      }),
    );
    return (
      v.status === "refused" &&
      v.problems.includes("the applicability record is not JSON")
    );
  });
  check(
    "verifier: a `/2` bundle under the earlier negative contract is refused",
    () => {
      const v = verify(
        negativeBundle(nc1, ENTRY("NC1"), {
          edit: (p) => {
            p.header.contract = "web08d-held-operation-negative/2";
          },
        }),
      );
      return (
        v.status === "refused" &&
        v.problems.some((p) => p.includes("the bundle's contract is"))
      );
    },
  );
  check("verifier: a revision 25 `/1` bundle still verifies, as legacy", () => {
    const v = verify(negativeBundle(nc1, ENTRY("NC1"), { legacy: true }));
    return v.status === "verified" && v.legacy === true && !v.applicability;
  });

  // The judgements: applicability is a fact of its own (I2), against the consumer's target only.
  const judgedWith = (options, target) =>
    e.qualifyNegative(nc1, negativeBundle(nc1, ENTRY("NC1"), options), {
      invocation: INVOCATION,
      ...(target === undefined ? {} : { target }),
    });
  const node25 = applicabilityRecord((r) => {
    r.controller.node = "v25.8.2";
  });
  check("judgement: the bundle's own runtime as target qualifies", () => {
    const j = judgedWith({}, T);
    return (
      j.qualified &&
      j.outcome === "qualified" &&
      j.applicability.decision === "applicable" &&
      j.applicability.target_sha256 === TARGET_SHA &&
      j.applicability.record_sha256 === TARGET_SHA
    );
  });
  check("judgement: without a target it is historical, never qualified", () => {
    const j = judgedWith({});
    return (
      !j.qualified &&
      j.outcome === "historical" &&
      j.applicability.decision === "unassessed"
    );
  });
  check(
    "judgement: genuine controls under Node 22 judged for a Node 25 consumer are inapplicable (review r25's counterexample)",
    () => {
      const j = judgedWith({}, node25);
      return (
        !j.qualified &&
        j.outcome === "inapplicable" &&
        j.applicability.decision === "incompatible" &&
        j.applicability.differences.some(
          (d) => d.field === "controller.node",
        ) &&
        j.problems.some((p) => p.includes("controller.node"))
      );
    },
  );
  check(
    "judgement: a bundle of another runtime is inapplicable to this target",
    () => !judgedWith({ applicability: node25 }, T).qualified,
  );
  check(
    "judgement: the target's digest is the target's own, not the record's",
    () =>
      judgedWith({}, node25).applicability.target_sha256 ===
      e.targetDigest(node25),
  );
  check(
    "judgement: a revision 25 bundle is never qualified, even with a target",
    () => {
      const j = judgedWith({ legacy: true }, T);
      return !j.qualified && j.applicability.decision === "unknown";
    },
  );
  check(
    "judgement: a revision 25 bundle is historical without a target",
    () => {
      const j = judgedWith({ legacy: true });
      return j.outcome === "historical";
    },
  );
  check(
    "judgement: evidence carrying no applicability decision is unknown, not qualified",
    () => {
      const j = judgedWith({}, T);
      const run = q.normalise(
        ENTRY("NC1").report,
        B,
        ENTRY("NC1").exit,
        ENTRY("NC1").spec,
        null,
      );
      run.report_sha256 = j.evidence.report_sha256;
      run.spec_sha256 = j.evidence.spec_sha256;
      const { applicability: _a, ...bare } = j.evidence;
      const again = q.judgeNegative(nc1, run, B, bare);
      return !again.qualified && again.applicability.decision === "unknown";
    },
  );
  check(
    "control: healthy bytes for another consumer are healthy but not admitted",
    () => {
      const c = e.judgeControlEvidence(
        controlBundle("control", A6.control, q.PROBE_IDS),
        {
          part: "control",
          invocation: INVOCATION,
          source: CONTROL_SOURCE.sha256,
          target: node25,
        },
      );
      return c.healthy === true && c.ok === false;
    },
  );
  check("control: without a target it is never admitted", () => {
    const c = e.judgeControlEvidence(
      controlBundle("control", A6.control, q.PROBE_IDS),
      {
        part: "control",
        invocation: INVOCATION,
        source: CONTROL_SOURCE.sha256,
      },
    );
    return c.healthy === true && c.ok === false;
  });

  // The split-stage prerequisite: the producing run's own records, both controls' bundles and this consumer's target.
  const prereq = (change = (x) => x, target = T) => {
    const evidence = {
      summary: { ...CONTROLS_SUMMARY },
      source: CONTROL_SOURCE.sha256,
      invocation: INVOCATION,
      controls: ["control", "copy-control"].map((part) =>
        e.judgeControlEvidence(
          controlBundle(
            part,
            select(
              part === "control" ? A6.control : A6.copy_control,
              CONTROLS_SUMMARY.control_probes,
            ),
            CONTROLS_SUMMARY.control_probes,
            { invocation: INVOCATION, source: CONTROL_SOURCE },
          ),
          {
            part,
            invocation: INVOCATION,
            source: CONTROL_SOURCE.sha256,
            target,
          },
        ),
      ),
      applicability: {
        before: { sha256: TARGET_SHA, record: T },
        after: { sha256: TARGET_SHA, record: T },
      },
      snapshot: snapshotRecord(T),
      inputs_runtime: { node: "v22.23.2", platform: "darwin", arch: "arm64" },
    };
    change(evidence);
    return q.prerequisiteProblems(evidence, {
      source: CONTROL_SOURCE.sha256,
      browsers: B,
      probes: NEGATIVE_PROBES,
      target,
    });
  };
  check(
    "prerequisite: matching controls, records and target are met",
    () => prereq().length === 0,
  );
  // Revision 27: the producing run's execution snapshot record.
  check(
    "prerequisite: a controls run with no execution snapshot record (revision 26 or earlier) is not met",
    () =>
      prereq((ev) => {
        ev.snapshot = null;
      }).some((p) => p.includes("no execution snapshot record")),
  );
  check(
    "prerequisite: a controls run whose snapshot changed before a child is not met",
    () =>
      prereq((ev) => {
        ev.snapshot = snapshotRecord(T, (x) => {
          x.checks.push({ when: "before Playwright", sha256: sha("other") });
        });
      }).some((p) => p.includes("changed (before Playwright)")),
  );
  check(
    "prerequisite: a controls run whose snapshot measured another installation is not met",
    () =>
      prereq((ev) => {
        ev.snapshot = snapshotRecord(T, (x) => {
          x.installation_sha256 = sha("another installation");
        });
      }).some((p) => p.includes("measured installation")),
  );
  check("prerequisite: no consumer target is not met", () =>
    prereq(undefined, null).some((p) => p.includes("no consuming target")),
  );
  check(
    "prerequisite: a Node 25 consumer of Node 22 controls is not met, by field",
    () =>
      prereq(undefined, node25).some(
        (p) =>
          p.includes("do not apply to this consumer") &&
          p.includes("controller.node"),
      ),
  );
  check("prerequisite: controls judged without a target are not met", () =>
    prereq((ev) => {
      ev.controls = ev.controls.map((c) => ({
        ...c,
        applicability: { decision: "unassessed", reasons: [] },
      }));
    }).some((p) => p.includes("unassessed for this consumer")),
  );
  check(
    "prerequisite: controls judged against another target object are not met",
    () =>
      prereq((ev) => {
        ev.controls = ev.controls.map((c) => ({
          ...c,
          applicability: { ...c.applicability, target_sha256: sha("other") },
        }));
      }).some((p) => p.includes("was judged against applicability target")),
  );
  check("prerequisite: a run with no record before it ran is not met", () =>
    prereq((ev) => {
      ev.applicability.before = null;
    }).some((p) => p.includes("no applicability before it ran")),
  );
  check("prerequisite: a run with no record after it ran is not met", () =>
    prereq((ev) => {
      ev.applicability.after = null;
    }).some((p) => p.includes("no applicability after it ran")),
  );
  check("prerequisite: a runtime that changed during the run is not met", () =>
    prereq((ev) => {
      ev.applicability.after = {
        sha256: sha("after"),
        record: withField(T, "child.node", "v22.18.0"),
      };
    }).some(
      (p) => p.includes("changed during the run") && p.includes("child.node"),
    ),
  );
  check(
    "prerequisite: a run whose inputs name another Node than its record is not met",
    () =>
      prereq((ev) => {
        ev.inputs_runtime = { ...ev.inputs_runtime, node: "v25.8.2" };
      }).some((p) => p.includes("its inputs record node")),
  );
  check("prerequisite: a summary naming another record is not met", () =>
    prereq((ev) => {
      ev.summary.applicability_sha256 = sha("other");
    }).some((p) => p.includes("its summary names applicability")),
  );
  check(
    "prerequisite: a control whose bundle carries other record bytes is not met, though they compare applicable",
    () =>
      prereq((ev) => {
        ev.controls[1] = e.judgeControlEvidence(
          controlBundle(
            "copy-control",
            select(A6.copy_control, CONTROLS_SUMMARY.control_probes),
            CONTROLS_SUMMARY.control_probes,
            {
              invocation: INVOCATION,
              source: CONTROL_SOURCE,
              applicability: withField(T, "controller.exec_path", "/elsewhere"),
            },
          ),
          {
            part: "copy-control",
            invocation: INVOCATION,
            source: CONTROL_SOURCE.sha256,
            target: T,
          },
        );
      }).some((p) => p.includes("copy-control's bundle carries applicability")),
  );
  check(
    "prerequisite: a control of another runtime among good ones is not met",
    () =>
      prereq((ev) => {
        ev.controls[0] = e.judgeControlEvidence(
          controlBundle(
            "control",
            select(A6.control, CONTROLS_SUMMARY.control_probes),
            CONTROLS_SUMMARY.control_probes,
            {
              invocation: INVOCATION,
              source: CONTROL_SOURCE,
              applicability: node25,
            },
          ),
          {
            part: "control",
            invocation: INVOCATION,
            source: CONTROL_SOURCE.sha256,
            target: T,
          },
        );
      }).some((p) =>
        p.includes("control control's raw evidence is incompatible"),
      ),
  );

  // The campaign: every admitted part applicable to exactly this run's record, and the record unchanged at the end.
  const base = campaignParts(q, e);
  const passes = (c) => q.campaignOutcome(c).passed;
  check("campaign: applicable parts and an unchanged runtime pass", () =>
    passes(base),
  );
  check(
    "campaign: an empty plan naming no applicability target fails",
    () =>
      !passes({
        ...base,
        planned: {
          invocation: INVOCATION,
          applicability: null,
          controls: [],
          negatives: [],
          mutants: [],
        },
        controls: [],
        negatives: [],
        mutants: [],
      }),
  );
  check(
    "campaign: a plan naming no applicability target fails",
    () =>
      !passes({ ...base, planned: { ...base.planned, applicability: null } }),
  );
  check(
    "campaign: a runtime that changed during the run fails",
    () =>
      !passes({
        ...base,
        applicability: {
          ...base.applicability,
          after: a.compareApplicability(
            T,
            withField(T, "child.node", "v22.18.0"),
          ),
        },
      }),
  );
  check(
    "campaign: a runtime not collected again fails",
    () =>
      !passes({
        ...base,
        applicability: { ...base.applicability, after: null },
      }),
  );
  // Revision 27: this run's own execution snapshot.
  check(
    "campaign: a run with no execution snapshot record fails",
    () => !passes({ ...base, snapshot: null }),
  );
  check(
    "campaign: a run whose snapshot changed by the end fails",
    () =>
      !passes({
        ...base,
        snapshot: snapshotRecord(T, (x) => {
          x.end_sha256 = sha("changed");
          x.unchanged = false;
        }),
      }),
  );
  check(
    "campaign: a run whose snapshot was not removed fails",
    () =>
      !passes({
        ...base,
        snapshot: snapshotRecord(T, (x) => {
          x.removed = false;
          x.removal_error = "EBUSY";
        }),
      }),
  );
  check(
    "campaign: a negative control judged for another target fails",
    () =>
      !passes({
        ...base,
        negatives: base.negatives.map((n, i) =>
          i
            ? n
            : {
                ...n,
                evidence: {
                  ...n.evidence,
                  applicability: {
                    ...n.evidence.applicability,
                    target_sha256: sha("x"),
                  },
                },
              },
        ),
      }),
  );
  check(
    "campaign: a control carrying another record fails",
    () =>
      !passes({
        ...base,
        controls: base.controls.map((c, i) =>
          i
            ? c
            : {
                ...c,
                evidence: { ...c.evidence, applicability_sha256: sha("x") },
              },
        ),
      }),
  );
  check(
    "campaign: a part whose comparison names another record fails",
    () =>
      !passes({
        ...base,
        controls: base.controls.map((c, i) =>
          i
            ? c
            : {
                ...c,
                evidence: {
                  ...c.evidence,
                  applicability: {
                    ...c.evidence.applicability,
                    record_sha256: sha("x"),
                  },
                },
              },
        ),
      }),
  );
  check(
    "campaign: a part claimed qualified whose applicability is unknown fails",
    () =>
      !passes({
        ...base,
        negatives: base.negatives.map((n, i) =>
          i
            ? n
            : {
                ...n,
                qualified: true,
                evidence: {
                  ...n.evidence,
                  applicability: {
                    ...n.evidence.applicability,
                    decision: "unknown",
                  },
                },
              },
        ),
      }),
  );
}

/** Every check the evaluator must pass, by name: the evaluator's own mutants must fail at least one (design assessment Q3). */
function assessments(q, e, a = applicabilityModule, i = installationModule) {
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
  for (const name of GENUINE) {
    const id = name.split("/")[1];
    check(
      `genuine ${name}: a diagnostic without evidence, never qualified`,
      () => {
        const judged = judgeNeg(q, id, NEG[name]);
        return (
          !judged.qualified &&
          judged.mode === "diagnostic" &&
          judged.integrity.problems.length === 1 &&
          judged.integrity.problems[0] === q.NO_EVIDENCE &&
          judged.scenario.valid &&
          judged.classifier.refused
        );
      },
    );
    check(`genuine ${name} qualified from its bundle`, () => {
      const judged = bound(q, e, id, NEG[name]);
      return (
        judged.qualified &&
        judged.outcome === "qualified" &&
        judged.mode === "bound" &&
        judged.evidence.status === "verified" &&
        judged.integrity.valid &&
        judged.scenario.valid &&
        judged.classifier.refused
      );
    });
  }
  for (const [name, nc] of [
    ["review/unexpected-setup-NC2", "NC2"],
    ["review/unexpected-setup-NC4", "NC4"],
  ])
    check(`review r23 ${name}: wrong fault, not qualified`, () => {
      const judged = bound(q, e, nc, NEG[name]);
      return (
        !judged.qualified &&
        !judged.scenario.valid &&
        judged.scenario.cases.every((c) => !c.valid) &&
        judged.classifier.refused
      );
    });
  check("review r23 genuine NC1 in its extended tree: not qualified", () => {
    const judged = bound(q, e, "NC1", NEG["review/genuine-NC1"]);
    return (
      !judged.qualified &&
      runIntegrity(judged).length > 0 &&
      judged.scenario.valid
    );
  });
  check("a genuine runtime fault on S21 is not NC2's timeout", () => {
    const judged = bound(
      q,
      e,
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
      const judged = negativeOf(q, e, a);
      return (
        !judged.qualified &&
        !judged[a.fails].valid &&
        (a.fails !== "integrity" || runIntegrity(judged).length > 0)
      );
    });
  // Revision 25: every binding of the evidence, broken alone (design assessment Q2, Q3, Q5), must leave the control unqualified.
  for (const c of EVIDENCE_CASES)
    check(`evidence: ${c.name}`, () => {
      const judged = c.judge(q, e);
      return !judged.qualified && judged.problems.some((p) => c.why.test(p));
    });
  for (const c of EVIDENCE_POSITIVES)
    check(`evidence positive: ${c.name}`, () => c.judge(q, e).qualified);
  for (const [name, evidence] of FORGED_EVIDENCE)
    check(`judgeNegative refuses ${name}`, () => {
      const nc = ncOf(q, "NC1");
      const genuine = bound(q, e, "NC1", NEG["author-negatives/NC1"]);
      const run = q.normalise(
        NEG["author-negatives/NC1"].report,
        B,
        1,
        NEG["author-negatives/NC1"].spec,
      );
      Object.assign(run, {
        report_sha256: genuine.evidence.report_sha256,
        spec_sha256: genuine.evidence.spec_sha256,
      });
      return !q.judgeNegative(nc, run, B, evidence(genuine.evidence)).qualified;
    });
  check("a matching judged run and evidence qualify", () => {
    const nc = ncOf(q, "NC1");
    const genuine = bound(q, e, "NC1", NEG["author-negatives/NC1"]);
    const run = q.normalise(
      NEG["author-negatives/NC1"].report,
      B,
      1,
      NEG["author-negatives/NC1"].spec,
    );
    Object.assign(run, {
      report_sha256: genuine.evidence.report_sha256,
      spec_sha256: genuine.evidence.spec_sha256,
    });
    return q.judgeNegative(nc, run, B, genuine.evidence).qualified;
  });
  check("a disk bundle whose artefact path leaves it is refused", () =>
    withDisk((dir) => {
      const nc = ncOf(q, "NC1");
      const b = negativeBundle(nc, NEG["author-negatives/NC1"]);
      writeBundle(join(dir, "part"), b);
      // The report moved beside the bundle and named by "../": its bytes and digest are the bundle's own.
      mkdirSync(join(dir, "outside"), { recursive: true });
      writeFileSync(join(dir, "outside/report.json"), b.files.report);
      const m = JSON.parse(b.manifest_bytes.toString("utf8"));
      m.artefacts.report.path = "../outside/report.json";
      writeFileSync(join(dir, "part", e.MANIFEST), JSON.stringify(m));
      return !e.qualifyNegative(
        nc,
        e.readBundle(join(dir, "part", e.MANIFEST)),
        {
          invocation: INVOCATION,
          target: TARGET,
        },
      ).qualified;
    }),
  );
  check("a disk bundle reread from another directory still qualifies", () =>
    withDisk((dir) => {
      const nc = ncOf(q, "NC4");
      writeBundle(
        join(dir, "a"),
        negativeBundle(nc, NEG["author-negatives/NC4"]),
      );
      cpSync(join(dir, "a"), join(dir, "b"), { recursive: true });
      return e.qualifyNegative(nc, e.readBundle(join(dir, "b", e.MANIFEST)), {
        invocation: INVOCATION,
        target: TARGET,
      }).qualified;
    }),
  );
  check(
    "the campaign of genuine parts passes",
    () => q.campaignOutcome(campaignParts(q, e)).passed,
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
          bound(q, e, "NC2", NEG["review/unexpected-setup-NC2"]),
          ...p.negatives.slice(2),
        ],
      }),
    ],
    [
      "a verified, classifier-refused negative control whose scenario failed",
      (p) => ({
        negatives: [
          p.negatives[0],
          bound(q, e, "NC2", select(NEG["author-negatives/NC1"], ["S21"])),
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
      "a diagnostic (no evidence) in place of a bound negative control",
      (p) => ({
        negatives: [
          {
            ...judgeNeg(q, "NC1", NEG["author-negatives/NC1"]),
            qualified: true,
          },
          ...p.negatives.slice(1),
        ],
      }),
    ],
    [
      "a qualified negative control bound to another invocation",
      (p) => ({
        negatives: [
          bound(q, e, "NC1", NEG["author-negatives/NC1"], {
            invocation: OTHER_INVOCATION,
          }),
          ...p.negatives.slice(1),
        ],
      }),
    ],
    [
      "a qualified negative control whose evidence was refused",
      (p) => ({
        negatives: [
          {
            ...p.negatives[0],
            evidence: { ...p.negatives[0].evidence, status: "refused" },
          },
          ...p.negatives.slice(1),
        ],
      }),
    ],
    [
      "a healthy control without verified evidence",
      (p) => ({
        controls: [{ name: "control", ok: true }, p.controls[1]],
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
      "a mutant recorded twice beside the others",
      (p) => ({ mutants: [...p.mutants, p.mutants[0]] }),
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
      const parts = campaignParts(q, e);
      return q.campaignOutcome({ ...parts, ...change(parts) }).exitCode === 1;
    });
  check(
    "prerequisite: a matching controls run is met",
    () => prerequisite(q, e).length === 0,
  );
  for (const [name, summary, source, controls] of [
    ["a failed controls run", { passed: false }],
    ["a negatives run", { stage: "negatives" }],
    ["other source", {}, "0".repeat(64)],
    ["other engines", { browsers: ["chromium"] }],
    ["no copy control", { controls: [{ name: "control", ok: true }] }],
    [
      "controls that did not cover S1 and P03",
      { control_probes: ["S10", "S11", "S12", "S13", "S14", "S21"] },
    ],
    ["revision 23's summary (no probe list)", { control_probes: undefined }],
    [
      "a summary whose raw controls are not healthy",
      {},
      undefined,
      () =>
        ["control", "copy-control"].map((part) =>
          e.judgeControlEvidence(
            controlBundle(
              part,
              select(A6.mutants.HM10, CONTROLS_SUMMARY.control_probes),
              CONTROLS_SUMMARY.control_probes,
              { source: CONTROL_SOURCE },
            ),
            {
              target: TARGET,
              part,
              invocation: INVOCATION,
              source: CONTROL_SOURCE.sha256,
            },
          ),
        ),
    ],
    ["a summary without raw controls", {}, undefined, () => []],
    [
      "raw controls of another run",
      {},
      undefined,
      () =>
        ["control", "copy-control"].map((part) =>
          e.judgeControlEvidence(
            controlBundle(
              part,
              select(
                part === "control" ? A6.control : A6.copy_control,
                CONTROLS_SUMMARY.control_probes,
              ),
              CONTROLS_SUMMARY.control_probes,
              { invocation: OTHER_INVOCATION, source: CONTROL_SOURCE },
            ),
            { target: TARGET, part, source: CONTROL_SOURCE.sha256 },
          ),
        ),
    ],
  ])
    check(
      `prerequisite: ${name} is not met`,
      () => prerequisite(q, e, summary, source, controls?.()).length > 0,
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
  applicabilityAssessments(q, e, a, check);
  // Revision 27: the installation boundary on disk, with this mutant's own modules (held-operation-installation-checks.mjs).
  installationAssessments(i, a, q, check);
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
    "  const holds = integrity.length === 0 && scenario.length === 0 && refused;",
    "  const holds = integrity.length === 0 && refused;",
  ],
  [
    "EM12 a negative control qualifies without the run's integrity",
    "  const holds = integrity.length === 0 && scenario.length === 0 && refused;",
    "  const holds = scenario.length === 0 && refused;",
  ],
  [
    "EM13 the classifier's refusal is inverted",
    "  const holds = integrity.length === 0 && scenario.length === 0 && refused;",
    "  const holds = integrity.length === 0 && scenario.length === 0 && !refused;",
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
  // Revision 25: EM19's revision 24 anchor (the optional provenance) is gone; the same weakening of the new mandatory binding.
  [
    "EM19 the invocation evidence is not checked",
    "  if (evidence === undefined) integrity.push(NO_EVIDENCE);\n  else integrity.push(...evidenceProblems(nc, run, evidence));",
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
  // Revision 25 (design assessment 91d0404c Q9): each removes one binding of the evidence boundary (E: held-operation-evidence.mjs).
  [
    "EM23 an artefact's bytes need not be its manifest digest",
    "    if (actual !== a.sha256)\n      problems.push(",
    "    if (false)\n      problems.push(",
    "E",
  ],
  [
    "EM24 the judged exit need not be the recorded execution's",
    "  if (run.exit !== evidence.execution?.exit)",
    "  if (false)",
  ],
  [
    "EM25 the verifier's refusal is not read",
    '  if (evidence.status !== "verified")',
    "  if (false)",
  ],
  [
    "EM26 an execution record may omit its signal",
    '      if (!("signal" in x))\n        problems.push("the execution record has no signal (not even null)");',
    "      if (false) void 0;",
    "E",
  ],
  [
    "EM27 the execution's report digest is not linked to the report",
    "      if (x.report_sha256 !== artefacts.report?.sha256)",
    "      if (false)",
    "E",
  ],
  [
    "EM28 the spec that ran need not be the snapshot with this hook",
    "      if (expectedSpec && !bytes.spec.equals(expectedSpec))",
    "      if (false)",
    "E",
  ],
  [
    "EM29 the live snapshot need not be the source's spec",
    "      if (sha256(base) !== files[PROBE_SPEC])",
    "      if (false)",
    "E",
  ],
  [
    "EM30 the installed file need not be the mutant's patch",
    "          else if (want && installed && !installed.equals(want))",
    "          else if (false)",
    "E",
  ],
  [
    "EM31 the copied tree's inventories are not compared",
    "        problems.push(...inventoryProblems(when, expected, inv?.[when]));",
    "        void when;",
    "E",
  ],
  [
    "EM32 an unexpected artefact is allowed",
    `    if (!required.includes(name))\n      problems.push(\`an unexpected \${name} artefact\`);`,
    "    void name;",
    "E",
  ],
  [
    "EM33 the report's evidence run is not checked",
    `        !run.includes(\`/\${m.invocation}/\${m.part}/\`)`,
    "        false",
    "E",
  ],
  [
    "EM34 the source fingerprint's own digest is not checked",
    "      if (sha256(JSON.stringify(source.files)) !== source.sha256)",
    "      if (false)",
    "E",
  ],
  [
    "EM35 one worker and no retries are not checked",
    `        if (given.length !== 1 || given[0] !== \`\${flag}\${value}\`)`,
    "        if (false)",
    "E",
  ],
  [
    "EM36 the fault given to the hook is not checked",
    "        if (env.ATLAS_PROBE_FAULT !== nc.fault)",
    "        if (false)",
    "E",
  ],
  [
    "EM37 a supplied report need not be the bundle's",
    "      expect.report_sha256 !== undefined &&\n      expect.report_sha256 !== out.report_sha256",
    "      false",
    "E",
  ],
  [
    "EM38 an artefact path may leave the bundle",
    '  if (rel.split(/[\\\\/]/).some((p) => p === "" || p === "." || p === ".."))',
    "  if (false)",
    "E",
  ],
  [
    "EM39 the prerequisite trusts its summary over its raw controls",
    "  for (const c of raw) {",
    "  for (const c of []) {",
  ],
  [
    "EM40 the campaign ignores which invocation a part's evidence is",
    "      e.invocation !== planned.invocation ||",
    "",
  ],
  [
    "EM41 the campaign admits a part whose evidence was refused",
    '      e?.status !== "verified" ||',
    "      !e ||",
  ],
  [
    "EM42 the judged report need not be the bundle's",
    "    run.report_sha256 !== evidence.report_sha256",
    "    false",
  ],
  [
    "EM43 a supplied exit is not compared",
    "      if (expect.exit !== undefined && x.exit !== expect.exit)",
    "      if (false)",
    "E",
  ],
  [
    "EM44 a missing artefact is allowed",
    `    if (!(name in artefacts)) problems.push(\`no \${name} artefact\`);`,
    "",
    "E",
  ],
  [
    "EM45 the expected source is not compared",
    "  if (expect.source !== undefined && m.source_sha256 !== expect.source)",
    "  if (false)",
    "E",
  ],
  [
    "EM46 the expected invocation is not compared",
    "  if (expect.invocation !== undefined && m.invocation !== expect.invocation)",
    "  if (false)",
    "E",
  ],
  [
    "EM47 a manifest of another schema is read",
    "    m.schema !== EVIDENCE_SCHEMA &&\n    !LEGACY_EVIDENCE_SCHEMAS.includes(m.schema)\n",
    "    false &&\n    !LEGACY_EVIDENCE_SCHEMAS.includes(m.schema)\n",
    "E",
  ],
  // Revision 26 (review r25 R25-N1; design assessment 26f1a626 Q5): each applicability comparison and its forwarding removed or
  // redirected. "A" mutates held-operation-applicability.mjs; the others import that same mutated instance.
  [
    "EM48 a changed applicability field is ignored",
    "        out.differences.push({ field, target: a, record: b });",
    "        void 0;",
    "A",
  ],
  [
    "EM49 the controller's Node is not compared",
    '  ["controller.node", "version"],\n',
    "",
    "A",
  ],
  [
    "EM50 the child's Node is not compared",
    '  ["child.node", "version"],\n',
    "",
    "A",
  ],
  [
    "EM51 the Node executable's bytes are not compared",
    '  ["child.exec_sha256", "digest"],\n',
    "",
    "A",
  ],
  [
    "EM52 the launched pnpm's bytes are not compared",
    '  ["child.pnpm_sha256", "digest"],\n',
    "",
    "A",
  ],
  [
    "EM53 the browser installations are not compared",
    "    if (!bt && !br)\n",
    "    if (false)\n",
    "A",
  ],
  [
    "EM54 the behavioural environment is not compared",
    "    if (!et && !er)\n",
    "    if (false)\n",
    "A",
  ],
  [
    "EM55 an unknown field is taken as applicable",
    '      ? "unknown"\n      : "applicable";',
    '      ? "applicable"\n      : "applicable";',
    "A",
  ],
  [
    "EM56 any value is a version",
    '  version: (v) => typeof v === "string" && VERSION.test(v),',
    "  version: (v) => v !== undefined,",
    "A",
  ],
  [
    "EM57 a record of another schema is compared as if supported",
    "    if (!object(r) || r.schema !== APPLICABILITY_SCHEMA)",
    "    if (!object(r))",
    "A",
  ],
  [
    "EM58 locations are compared as behaviour",
    "        out.locations.push({ field, target: a ?? null, record: b ?? null });",
    "        out.differences.push({ field, target: a ?? null, record: b ?? null });",
    "A",
  ],
  [
    "EM59 the word 'unknown' is a value",
    '  word: (v) => typeof v === "string" && v.trim() !== "" && v !== "unknown",',
    '  word: (v) => typeof v === "string" && v.trim() !== "",',
    "A",
  ],
  [
    "EM60 locations and selections are recorded as behaviour",
    "          !NOT_BEHAVIOUR_ENV.includes(k) &&",
    "          true &&",
    "A",
  ],
  [
    "EM61 the report's runtime witness is not checked",
    "        problems.push(...witnessProblems(metadata?.atlasRuntime, record));",
    "        void 0;",
    "E",
  ],
  [
    "EM62 a `/2` bundle need not carry its record",
    '  if (schema === EVIDENCE_SCHEMA) names.push("applicability");',
    '  if (schema === "none") names.push("applicability");',
    "E",
  ],
  [
    "EM63 the evidence is compared with itself, not with the consumer",
    "    : compareApplicability(target, v.applicability?.record);",
    "    : compareApplicability(v.applicability?.record, v.applicability?.record);",
    "E",
  ],
  [
    "EM64 a replay without a target is admitted",
    '      decision: "unassessed",',
    '      decision: "applicable",',
    "E",
  ],
  [
    "EM65 a revision 25 bundle is admitted",
    '        decision: "unknown",',
    '        decision: "applicable",',
    "E",
  ],
  [
    "EM66 a control is admitted on health alone",
    '    result.healthy && evidence.applicability.decision === "applicable";',
    "    result.healthy;",
    "E",
  ],
  [
    "EM67 the target's digest is taken from the record",
    '    target && typeof target === "object" ? targetDigest(target) : null;',
    '    target && typeof target === "object" ? record_sha256 : null;',
    "E",
  ],
  [
    "EM68 a negative control qualifies without applicability",
    '  const qualified = holds && applicability.decision === "applicable";',
    "  const qualified = holds;",
    "Q",
  ],
  [
    "EM69 the controls run's records before and after are not compared",
    "  if (before?.record && after?.record) {",
    "  if (false) {",
    "Q",
  ],
  [
    "EM70 the controls run's record is not compared with the consumer",
    "  if (before?.record && targetSha) {",
    "  if (false) {",
    "Q",
  ],
  [
    "EM71 a control's applicability decision is ignored",
    '    if (a?.decision !== "applicable")\n',
    "    if (false)\n",
    "Q",
  ],
  [
    "EM72 the target a control was judged against is not checked",
    "    if (!targetSha || a?.target_sha256 !== targetSha)",
    "    if (!targetSha)",
    "Q",
  ],
  [
    "EM73 the record a control's bundle carries is not checked",
    "    if (!before?.sha256 || e?.applicability_sha256 !== before.sha256)",
    "    if (!before?.sha256)",
    "Q",
  ],
  [
    "EM74 the inputs' runtime is not checked against the record",
    "      if (evidence.inputs_runtime?.[key] !== before.record.controller?.[key])",
    "      if (false)",
    "Q",
  ],
  [
    "EM75 the summary's record is not checked",
    "  if (summary.applicability_sha256 !== before?.sha256)",
    "  if (false)",
    "Q",
  ],
  [
    "EM76 a campaign need not name its target",
    "  if (!DIGEST.test(String(planned.applicability)))\n    reasons.push(",
    "  if (false)\n    reasons.push(",
    "Q",
  ],
  [
    "EM77 a runtime that changed during the run is ignored",
    '  if (applicability?.after?.decision !== "applicable")',
    "  if (false)",
    "Q",
  ],
  [
    "EM78 a part's applicability decision is ignored by the campaign",
    '      a?.decision !== "applicable" ||',
    "      false ||",
    "Q",
  ],
  [
    "EM79 a revision 25 bundle is checked against the current negative contract",
    "        ? LEGACY_NEGATIVE_CONTRACTS[m.schema]\n",
    "        ? NEGATIVE_CONTRACT_VERSION\n",
    "E",
  ],
  [
    "EM80 a current bundle may name the earlier negative contract",
    "      : out.legacy\n",
    "      : true\n",
    "E",
  ],
  // Revision 27 (review r26 R26-N1; design assessment eff76566 Q5): the installation boundary. "I" mutates
  // held-operation-installation.mjs, which the applicability module and the evaluator import as the same mutated instance.
  [
    "EM81 a link is identified by its text, not the entry it resolves to",
    'posix(relative(base, real)) || "."',
    "text",
    "I",
  ],
  [
    "EM82 a link out of the installation is admitted",
    "        if (!inside(base, real))\n",
    "        if (false)\n",
    "I",
  ],
  [
    "EM83 a dangling link is admitted",
    "          refuse(r, `a dangling link",
    "          real = full; // refuse(r, `a dangling link",
    "I",
  ],
  [
    "EM84 a hard link is admitted",
    "        if (st.nlink !== 1)",
    "        if (st.nlink < 1)",
    "I",
  ],
  ["EM85 a file's bytes are not hashed", "sha256(n.bytes)", "sha256(r)", "I"],
  [
    "EM86 the executable bit is ignored",
    'st.mode & 0o111 ? "x" : "-"',
    '"-"',
    "I",
  ],
  [
    "EM87 the pnpm virtual store is not walked",
    "      if (!rel && CACHE_DIRS.includes(e.name)) continue;\n      const full = join(dir, e.name);\n      const st = lstatSync(full);",
    '      if (!rel && [...CACHE_DIRS, ".pnpm"].includes(e.name)) continue;\n      const full = join(dir, e.name);\n      const st = lstatSync(full);',
    "I",
  ],
  [
    "EM88 a shim's NODE_PATH is not checked",
    "        if (/(^|\\/)\\.bin\\//.test(r))",
    "        if (false)",
    "I",
  ],
  [
    "EM89 a file naming the live installation is admitted",
    '          if (bytes.indexOf(join(f, "node_modules")) >= 0)',
    "          if (false)",
    "I",
  ],
  [
    "EM90 the execution root is not normalised",
    "    if (out.indexOf(needle) < 0) continue;\n    const parts = [];\n    let from = 0;",
    "    if (true) continue;\n    const parts = [];\n    let from = 0;",
    "I",
  ],
  [
    "EM91 the top-level .bin shims are treated as a cache",
    'export const CACHE_DIRS = [".vite", ".vite-temp"];',
    'export const CACHE_DIRS = [".vite", ".vite-temp", ".bin"];',
    "I",
  ],
  [
    "EM92 the whole workspace state is normalised away",
    "          delete state.lastValidatedTimestamp;",
    "          for (const k of Object.keys(state)) delete state[k];",
    "I",
  ],
  [
    "EM93 another node_modules on the way up is not checked",
    "          if (existsSync(candidate) && realpathSync(candidate) !== own)",
    "          if (false)",
    "I",
  ],
  [
    "EM94 Node's global folders are not checked",
    "    if (existsSync(g)) problems.push",
    "    if (false) problems.push",
    "I",
  ],
  [
    "EM95 a sealed snapshot always verifies",
    "  if (now.sha256 === baseline.sha256) return now;",
    "  return now;",
    "I",
  ],
  [
    "EM96 the stat inventory ignores change times",
    "st.ctimeNs",
    "st.size",
    "I",
  ],
  [
    "EM97 sealing leaves the installation writable",
    "      } else chmodSync(full, lstatSync(full).mode & 0o555);",
    "      } else void full;",
    "I",
  ],
  [
    "EM98 relocation rewrites nothing",
    "        if (out !== bytes) {",
    "        if (false) {",
    "I",
  ],
  [
    "EM99 a snapshot's source copy is not checked against the fingerprint",
    "    if (sha256(readFileSync(join(dir, name))) !== digest)",
    "    if (false)",
    "I",
  ],
  [
    "EM100 a snapshot copies the tool caches",
    "    filter: (from) => !CACHE_DIRS.some((c) => from === join(modules, c)),",
    "    filter: () => true,",
    "I",
  ],
  [
    "EM101 the installation digest is not compared",
    '  ["installation.sha256", "digest"],\n',
    "",
    "A",
  ],
  [
    "EM102 the resolution digest is not compared",
    '  ["installation.resolution_sha256", "digest"],\n',
    "",
    "A",
  ],
  [
    "EM103 the user's npmrc is not compared",
    'export const CONFIG_FILES = [\n  "npmrc_user",\n',
    "export const CONFIG_FILES = [\n",
    "A",
  ],
  [
    "EM104 the children's NODE_OPTIONS is ignored",
    "  if (child?.node_options)",
    "  if (false)",
    "A",
  ],
  [
    "EM105 the children's NODE_PATH is ignored",
    "    if (entry && !isInside(base, resolve(entry)))",
    "    if (false)",
    "A",
  ],
  [
    "EM106 a dependency resolving differently from a copy origin is admitted",
    "      if (dirs.some((d) => d !== dirs[0]))",
    "      if (false)",
    "A",
  ],
  [
    "EM107 a dependency resolving outside the installation is admitted",
    "      else if (!isInside(base, dirs[0]))",
    "      else if (false)",
    "A",
  ],
  [
    "EM108 the collector ignores a resolution path out of the installation",
    "  if (leaks.length)",
    "  if (false)",
    "A",
  ],
  [
    "EM109 the collector does not forbid the live installation",
    "    foreign: source && resolve(source) !== resolve(root) ? [source] : [],",
    "    foreign: [],",
    "A",
  ],
  [
    "EM110 the report's @playwright/test directory is not witnessed",
    '      ? [["playwright_dir", "packages.@playwright/test.dir"]]',
    "      ? []",
    "A",
  ],
  [
    "EM111 a record of the revision 26 schema is compared as current",
    "    if (!object(r) || r.schema !== APPLICABILITY_SCHEMA)",
    "    if (!object(r))",
    "A",
  ],
  [
    "EM112 a snapshot of another schema is accepted",
    "  if (snapshot.schema !== SNAPSHOT_SCHEMA)",
    "  if (false)",
  ],
  [
    "EM113 a snapshot check that saw a change is ignored",
    "    if (c?.sha256 !== snapshot.sealed_sha256)",
    "    if (false)",
  ],
  [
    "EM114 a snapshot changed by the end is accepted",
    "  if (snapshot.end_sha256 !== snapshot.sealed_sha256)",
    "  if (false)",
  ],
  [
    "EM115 a snapshot not removed is accepted",
    "  if (snapshot.removed !== true)",
    "  if (false)",
  ],
  [
    "EM116 a snapshot of another installation is accepted",
    "    if (snapshot.installation_sha256 !== record.installation?.sha256)",
    "    if (false)",
  ],
  [
    "EM117 the prerequisite ignores the producing run's snapshot",
    "    ...snapshotProblems(evidence.snapshot, before?.record).map(",
    "    ...[].map(",
  ],
  [
    "EM118 the campaign ignores its own snapshot",
    "    ...snapshotProblems(snapshot, applicability?.record).map(",
    "    ...[].map(",
  ],
  [
    "EM119 a recorded package's digest covers none of its entries",
    "          return path === rel || path.startsWith(",
    "          return false && path.startsWith(",
    "A",
  ],
  [
    "EM120 a recorded package is digested where it stands (revision 26's tree digest), not from the normalised inventory",
    "      tree_sha256: inventoryDigest(",
    "      tree_sha256: treeDigest(dir) || inventoryDigest(",
    "A",
  ],
];

test("Q3: every evaluator mutant fails at least one of these checks; the evaluator itself passes all", async (t) => {
  assert.deepEqual(assessments(evaluator, evidenceModule), []);
  const dir = mkdtempSync(join(tmpdir(), "atlas-held-operation-evaluator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Each mutant's own directory holds the reader, the evaluator and the evidence module, one of them mutated (revision 25: "E" names
  // held-operation-evidence.mjs); the evidence module imports that directory's evaluator, so both are the same mutated instance.
  const sources = {
    Q: readFileSync(
      join(import.meta.dirname, "held-operation-qualification.mjs"),
      "utf8",
    ),
    E: readFileSync(
      join(import.meta.dirname, "held-operation-evidence.mjs"),
      "utf8",
    ),
    A: readFileSync(
      join(import.meta.dirname, "held-operation-applicability.mjs"),
      "utf8",
    ),
    I: readFileSync(
      join(import.meta.dirname, "held-operation-installation.mjs"),
      "utf8",
    ),
  };
  // Revision 26: "A" names held-operation-applicability.mjs, which both of the others import (one mutated instance for all three).
  const names = {
    Q: "held-operation-qualification.mjs",
    E: "held-operation-evidence.mjs",
    A: "held-operation-applicability.mjs",
    I: "held-operation-installation.mjs",
  };
  const caughtBy = {};
  for (const [name, from, to, which = "Q"] of EVALUATOR_MUTANTS) {
    assert.equal(sources[which].split(from).length - 1, 1, `${name}: anchor`);
    const sub = join(dir, name.split(" ")[0]);
    mkdirSync(sub);
    cpSync(
      join(import.meta.dirname, "engine-results.mjs"),
      join(sub, "engine-results.mjs"),
    );
    for (const k of ["Q", "E", "A", "I"])
      writeFileSync(
        join(sub, names[k]),
        k === which ? sources[k].replace(from, to) : sources[k],
      );
    const q = await import(pathToFileURL(join(sub, names.Q)).href);
    const e = await import(pathToFileURL(join(sub, names.E)).href);
    const a = await import(pathToFileURL(join(sub, names.A)).href);
    const i = await import(pathToFileURL(join(sub, names.I)).href);
    caughtBy[name] = assessments(q, e, a, i);
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
  const base = campaignParts(evaluator, evidenceModule);
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
    // Revision 25: verified parts of THIS invocation only.
    { planned: { ...base.planned, invocation: OTHER_INVOCATION } },
    { planned: { ...base.planned, invocation: undefined } },
    {
      negatives: [
        {
          ...judgeNeg(evaluator, "NC1", NEG["author-negatives/NC1"]),
          qualified: true,
        },
        ...nc.slice(1),
      ],
    },
    { negatives: [{ ...nc[0], evidence: null }, ...nc.slice(1)] },
    {
      negatives: [
        { ...nc[0], evidence: { ...nc[0].evidence, part: "NC2" } },
        ...nc.slice(1),
      ],
    },
    { controls: [{ name: "control", ok: true }, base.controls[1]] },
    {
      controls: [
        base.controls[0],
        { ...base.controls[1], evidence: base.controls[0].evidence },
      ],
    },
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
  // Review r23's synthetic campaign: NC1's genuine evidence judged under all four controls' contracts (each in a bundle recording that
  // control's own selection). Only NC1 qualifies.
  const nc1Everywhere = ["NC1", "NC2", "NC3", "NC4"].map((id) =>
    bound(evaluator, evidenceModule, id, NEG["author-negatives/NC1"]),
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

test("Q1 (genuine): revision 23's eight real negative-control runs are diagnostics without evidence, and qualify from their bundles", () => {
  const sizes = { NC1: 18, NC2: 3, NC3: 6, NC4: 3 };
  for (const name of GENUINE) {
    const id = name.split("/")[1];
    // Without evidence: the scenario holds and the classifier refuses, but it is a labelled diagnostic, never qualified (Q4).
    const diagnostic = judgeNeg(evaluator, id, NEG[name]);
    assert.equal(diagnostic.qualified, false, name);
    assert.equal(diagnostic.mode, "diagnostic");
    assert.equal(diagnostic.evidence, null);
    assert.deepEqual(diagnostic.integrity.problems, [evaluator.NO_EVIDENCE]);
    assert.equal(diagnostic.scenario.valid, true, name);
    assert.equal(diagnostic.classifier.refused, true, name);
    // From its synthetic-consistent bundle (Q1): verified, bound and qualified.
    const judged = bound(evaluator, evidenceModule, id, NEG[name]);
    assert.deepEqual(judged.problems, [], name);
    assert.equal(judged.qualified, true, name);
    assert.equal(judged.mode, "bound");
    assert.equal(judged.evidence.status, "verified");
    assert.equal(judged.evidence.invocation, INVOCATION);
    assert.match(judged.evidence.manifest_sha256, /^[0-9a-f]{64}$/);
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
  // Bound to bundles recording their trees' specs, they are refused by the evidence as well (the spec is not the snapshot plus the hook).
  for (const [name, id] of [
    ["review/unexpected-setup-NC2", "NC2"],
    ["review/unexpected-setup-NC4", "NC4"],
    ["review/genuine-NC1", "NC1"],
  ]) {
    const judged = bound(evaluator, evidenceModule, id, NEG[name]);
    assert.equal(judged.qualified, false, name);
    assert.equal(judged.evidence.status, "refused", name);
    assert.ok(
      judged.evidence.problems.includes(
        "the spec that ran is not the source's spec with exactly this evaluator's fault hook appended",
      ),
      name,
    );
  }
});

test("Q1 (genuine): a real runtime fault on S21 is not NC2's timeout, though the run's integrity and evidence hold", () => {
  const judged = bound(
    evaluator,
    evidenceModule,
    "NC2",
    select(NEG["author-negatives/NC1"], ["S21"]),
  );
  assert.equal(judged.evidence.status, "verified");
  assert.equal(judged.integrity.valid, true);
  assert.equal(judged.classifier.refused, true);
  assert.equal(judged.scenario.valid, false);
  assert.equal(judged.qualified, false);
});

for (const a of NEGATIVE_ADVERSARIAL)
  test(`Q2 (synthetic): ${a.name} leaves ${a.nc} unqualified (${a.fails})`, () => {
    // Judged bound (revision 25), so the run's own integrity or scenario, not missing evidence, is what refuses it.
    const judged = negativeOf(evaluator, evidenceModule, a);
    assert.equal(judged.qualified, false);
    assert.equal(judged[a.fails].valid, false);
    if (a.fails === "integrity") assert.ok(runIntegrity(judged).length > 0);
    assert.ok(judged.problems.length > 0);
  });

for (const c of EVIDENCE_CASES)
  test(`Q2/Q3 (synthetic): ${c.name}: unqualified`, () => {
    const judged = c.judge(evaluator, evidenceModule);
    assert.equal(judged.qualified, false);
    assert.equal(judged.integrity.valid, false);
    assert.ok(
      judged.problems.some((p) => c.why.test(p)),
      `${c.why}: ${judged.problems.join(" | ")}`,
    );
  });

test("Q1/Q2: each broken binding is refused while the run's scenario and classifier would still hold (the evidence alone refuses it)", () => {
  // Cases that leave the genuine report as it ran: the scenario and the classifier judge it as the genuine run, yet it is unqualified.
  const unchangedReport = EVIDENCE_CASES.filter(
    (c) =>
      !/report|exit|signal|Chromium|probe selection|ran the live spec|ran another hook|manifest|schema|artefact list|no argv|no invocation|parent|absolute|malformed|NC3|NC2/.test(
        c.name,
      ),
  );
  assert.ok(unchangedReport.length >= 20, String(unchangedReport.length));
  for (const c of unchangedReport) {
    const judged = c.judge(evaluator, evidenceModule);
    if (judged.classifier.verdict === "unjudged") continue;
    assert.equal(judged.scenario.valid, true, c.name);
    assert.equal(judged.classifier.refused, true, c.name);
    assert.equal(judged.qualified, false, c.name);
  }
  for (const c of EVIDENCE_POSITIVES)
    assert.equal(c.judge(evaluator, evidenceModule).qualified, true, c.name);
});

test("Q2: judgeNegative refuses a genuine run with evidence that is not its verified bundle", () => {
  const nc = ncOf(evaluator, "NC1");
  const genuine = bound(
    evaluator,
    evidenceModule,
    "NC1",
    NEG["author-negatives/NC1"],
  );
  const run = evaluator.normalise(
    NEG["author-negatives/NC1"].report,
    B,
    1,
    NEG["author-negatives/NC1"].spec,
  );
  Object.assign(run, {
    report_sha256: genuine.evidence.report_sha256,
    spec_sha256: genuine.evidence.spec_sha256,
  });
  assert.equal(
    evaluator.judgeNegative(nc, run, B, genuine.evidence).qualified,
    true,
  );
  for (const [name, forge] of FORGED_EVIDENCE) {
    const judged = evaluator.judgeNegative(nc, run, B, forge(genuine.evidence));
    assert.equal(judged.qualified, false, name);
    assert.equal(judged.integrity.valid, false, name);
  }
  // Another genuine run of the same control with this run's verified evidence: the digests differ.
  const other = bound(
    evaluator,
    evidenceModule,
    "NC1",
    NEG["author-probes/NC1"],
  );
  assert.notEqual(other.evidence.report_sha256, genuine.evidence.report_sha256);
  assert.equal(
    evaluator.judgeNegative(nc, run, B, other.evidence).qualified,
    false,
  );
});

test("Q2 (limit, labelled): a self-consistent bundle of another source verifies only when no source is named; the runner and the plan name it", () => {
  const base = baseOf(NEG["author-negatives/NC1"]);
  const other = negativeBundle(
    ncOf(evaluator, "NC1"),
    NEG["author-negatives/NC1"],
    {
      source: sourceOf(base, {
        "src/other.ts": evidenceModule.sha256("other"),
      }),
    },
  );
  const unnamed = evidenceModule.qualifyNegative(
    ncOf(evaluator, "NC1"),
    other,
    {
      invocation: INVOCATION,
      target: TARGET,
    },
  );
  assert.equal(unnamed.qualified, true);
  assert.notEqual(unnamed.evidence.source_sha256, sourceOf(base).sha256);
  const named = evidenceModule.qualifyNegative(ncOf(evaluator, "NC1"), other, {
    invocation: INVOCATION,
    source: sourceOf(base).sha256,
  });
  assert.equal(named.qualified, false);
});

test("Q4: a judgement without evidence, a legacy receipt or a trimmed fixture is never admissible", () => {
  const nc = ncOf(evaluator, "NC4");
  const diagnostic = judgeNeg(evaluator, "NC4", NEG["author-negatives/NC4"]);
  assert.equal(diagnostic.qualified, false);
  assert.equal(diagnostic.outcome, "unqualified");
  assert.equal(diagnostic.mode, "diagnostic");
  // Revision 24's genuine receipt shape (its own result.json) offered as a manifest.
  const legacy = Buffer.from(
    JSON.stringify({
      title: nc.title,
      provenance: {
        negative_control: "NC4",
        fault: "teardown-error",
        exit: 1,
        signal: null,
        report_sha256:
          "5537f0cb0babe0e08a86a6bdee40ee0cddf5d496f7896f44a85fbdbc356c81d3",
      },
      qualified: true,
      outcome: "qualified",
    }),
  );
  const judged = evidenceModule.qualifyNegative(nc, {
    manifest_bytes: legacy,
    files: {},
    read_problems: [],
  });
  assert.equal(judged.qualified, false);
  assert.ok(judged.problems.some((p) => p.includes("legacy receipt")));
  // Nothing at all.
  assert.equal(evidenceModule.qualifyNegative(nc, undefined).qualified, false);
  assert.equal(evidenceModule.qualifyNegative(nc, {}).qualified, false);
});

test("Q5: a bundle is published exclusively and last, read once, and relocates intact", () => {
  withDisk((dir) => {
    const nc = ncOf(evaluator, "NC4");
    const b = negativeBundle(nc, NEG["author-negatives/NC4"]);
    // The runner's own publication: artefacts first, the manifest last and exclusively.
    const part = join(dir, "NC4");
    writeBundle(part, b, { manifest: false });
    const unpublished = evidenceModule.qualifyNegative(
      nc,
      evidenceModule.readBundle(join(part, evidenceModule.MANIFEST)),
      { invocation: INVOCATION, target: TARGET },
    );
    assert.equal(unpublished.qualified, false);
    assert.ok(
      unpublished.problems.some((p) => p.includes("no published manifest")),
    );
    const manifest = evidenceModule.publishBundle(
      part,
      {
        kind: "negative",
        part: "NC4",
        contract: evaluator.NEGATIVE_CONTRACT_VERSION,
        invocation: INVOCATION,
        source_sha256: JSON.parse(b.files.source.toString("utf8")).sha256,
      },
      b.paths,
    );
    assert.equal(manifest.schema, evaluator.EVIDENCE_SCHEMA);
    assert.equal(
      existsSync(join(part, `${evidenceModule.MANIFEST}.partial`)),
      false,
    );
    const path = join(part, evidenceModule.MANIFEST);
    const published = readFileSync(path);
    assert.throws(
      () => evidenceModule.publishBundle(part, {}, b.paths),
      /EEXIST/,
    );
    assert.deepEqual(readFileSync(path), published);
    const read = evidenceModule.readBundle(path);
    assert.equal(
      evidenceModule.qualifyNegative(nc, read, {
        invocation: INVOCATION,
        target: TARGET,
      }).qualified,
      true,
    );
    // Judged from the bytes read: a later change on disk does not change that judgement, and a new read refuses it.
    writeFileSync(join(part, "browser/report.json"), "{}");
    assert.equal(
      evidenceModule.qualifyNegative(nc, read, {
        invocation: INVOCATION,
        target: TARGET,
      }).qualified,
      true,
    );
    assert.equal(
      evidenceModule.qualifyNegative(nc, evidenceModule.readBundle(path), {
        invocation: INVOCATION,
        target: TARGET,
      }).qualified,
      false,
    );
    writeFileSync(join(part, "browser/report.json"), b.files.report);
    // An artefact replaced between the manifest's read and its own: the bytes read are not the digest.
    const raced = evidenceModule.readBundle(path, {
      beforeArtefact: (name) => {
        if (name === "execution")
          writeFileSync(
            join(part, "execution.json"),
            rewrite(b.files.execution, (x) => {
              x.exit = 0;
            }),
          );
      },
    });
    const racedJudged = evidenceModule.qualifyNegative(nc, raced, {
      invocation: INVOCATION,
      target: TARGET,
    });
    assert.equal(racedJudged.qualified, false);
    assert.ok(
      racedJudged.problems.some((p) => p.includes("execution: its bytes")),
    );
    writeFileSync(join(part, "execution.json"), b.files.execution);
    // The whole part copied elsewhere is the same evidence.
    cpSync(part, join(dir, "moved", "NC4"), { recursive: true });
    const moved = evidenceModule.qualifyNegative(
      nc,
      evidenceModule.readBundle(
        join(dir, "moved", "NC4", evidenceModule.MANIFEST),
      ),
      { invocation: INVOCATION, target: TARGET },
    );
    assert.equal(moved.qualified, true);
    assert.equal(moved.evidence.manifest_sha256, sha(published));
    // A truncated manifest, a missing artefact and a linked artefact are refused.
    const variants = {
      truncated: (p) =>
        writeFileSync(
          join(p, evidenceModule.MANIFEST),
          published.subarray(0, 50),
        ),
      missing: (p) => rmSync(join(p, "bundle/inventory.json")),
      linked: (p) => {
        rmSync(join(p, "browser/report.json"));
        symlinkSync(
          join(part, "browser/report.json"),
          join(p, "browser/report.json"),
        );
      },
    };
    for (const [name, damage] of Object.entries(variants)) {
      const copy = join(dir, name);
      cpSync(part, copy, { recursive: true });
      damage(copy);
      const v = evidenceModule.qualifyNegative(
        nc,
        evidenceModule.readBundle(join(copy, evidenceModule.MANIFEST)),
        { invocation: INVOCATION, target: TARGET },
      );
      assert.equal(v.qualified, false, name);
    }
    // Two producers of the same control, each in its own directory: each verifies as itself; crossed, neither does.
    const other = negativeBundle(nc, NEG["author-probes/NC4"], {
      invocation: OTHER_INVOCATION,
    });
    const otherPath = writeBundle(join(dir, "other", "NC4"), other);
    assert.equal(
      evidenceModule.qualifyNegative(nc, evidenceModule.readBundle(otherPath), {
        invocation: OTHER_INVOCATION,
        target: TARGET,
      }).qualified,
      true,
    );
    cpSync(
      join(part, "browser/report.json"),
      join(dir, "other/NC4/browser/report.json"),
    );
    assert.equal(
      evidenceModule.qualifyNegative(nc, evidenceModule.readBundle(otherPath), {
        invocation: OTHER_INVOCATION,
        target: TARGET,
      }).qualified,
      false,
    );
  });
});

test("Q7: a control part is judged healthy only from its verified raw bundle", () => {
  for (const part of ["control", "copy-control"]) {
    const ok = controlOf(evidenceModule, part);
    assert.equal(ok.ok, true, part);
    assert.equal(ok.evidence.status, "verified");
    assert.deepEqual(ok.probes, evaluator.PROBE_IDS);
  }
  const faulty = [
    [
      "a fault given to a control",
      (p) => {
        p.execution.env.ATLAS_PROBE_FAULT = "runtime";
      },
    ],
    [
      "a control whose spec is not the source's",
      (p) => {
        p.files.spec.bytes = Buffer.from(alter(A6.spec.text));
      },
    ],
    [
      "a copy control whose tree changed",
      (p) => {
        if (p.files.inventory)
          p.files.inventory.bytes = {
            ...p.files.inventory.bytes,
            after: {
              ...p.files.inventory.bytes.after,
              "tests/e2e/helpers.ts": sha("x"),
            },
          };
        else p.header.part = "other";
      },
    ],
    [
      "a negative part offered as a control",
      (p) => {
        p.header.kind = "negative";
      },
    ],
  ];
  for (const part of ["control", "copy-control"])
    for (const [name, edit] of faulty) {
      const judged = evidenceModule.judgeControlEvidence(
        controlBundle(
          part,
          part === "control" ? A6.control : A6.copy_control,
          evaluator.PROBE_IDS,
          { edit },
        ),
        {
          target: TARGET,
          part,
          invocation: INVOCATION,
          source: CONTROL_SOURCE.sha256,
        },
      );
      assert.equal(judged.ok, false, `${part}: ${name}`);
    }
  // A healthy-looking report that is not a healthy profile (HM10's genuine mutant run) is not healthy, however it is bundled.
  const hm10 = evidenceModule.judgeControlEvidence(
    controlBundle(
      "control",
      A6.mutants.HM10,
      evaluator.mutantOf("HM10").probes,
    ),
    { part: "control", invocation: INVOCATION, target: TARGET },
  );
  assert.equal(hm10.evidence.status, "verified");
  assert.equal(hm10.ok, false);
  assert.equal(hm10.healthy, false);
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
  assert.deepEqual(prerequisite(evaluator, evidenceModule), []);
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
    [{}, "0".repeat(64)],
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
      prerequisite(evaluator, evidenceModule, summary, source).length > 0,
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
  // Revision 25: synthetic-consistent bundles of genuine runs (held-operation-test-bundles.mjs), and faulty ones, as the CLI reads them.
  const nc = (id) => ncOf(evaluator, id);
  const bundles = {
    nc1: negativeBundle(nc("NC1"), ENTRY("NC1")),
    "nc1-other": negativeBundle(nc("NC1"), OTHER_ENTRY("NC1"), {
      invocation: OTHER_INVOCATION,
    }),
    "nc1-exit0": negativeBundle(nc("NC1"), ENTRY("NC1"), {
      edit: (p) => {
        p.execution.exit = 0;
      },
    }),
    "nc4-hm3": negativeBundle(nc("NC4"), ENTRY("NC4"), {
      edit: (p) => {
        p.files[installedName].bytes = Buffer.from(
          evaluator.mutantOf("HM3").patch(HELPER_TEXT),
        );
      },
    }),
  };
  // Revision 26: the legacy (revision 25 `/1`) bundle of the same run, and bundles recorded under other runtimes.
  bundles["nc1-legacy"] = negativeBundle(nc("NC1"), ENTRY("NC1"), {
    legacy: true,
  });
  bundles["nc1-node25"] = negativeBundle(nc("NC1"), ENTRY("NC1"), {
    applicability: applicabilityRecord((r) => {
      r.controller.node = "v25.8.2";
      r.controller.exec_sha256 = sha("node 25.8.2");
    }),
  });
  // Revision 27: a revision 26 bundle (a genuine-shaped /1 record of four package trees, no installation content).
  bundles["nc1-r26"] = negativeBundle(nc("NC1"), ENTRY("NC1"), {
    applicability: legacyRecord(),
  });
  for (const [name, b] of Object.entries(bundles))
    writeBundle(join(dir, ".agtx", name), b);
  // Revision 27: the same NC1 bundle published by a run that left no snapshot record (one still going, or a revision 26 run), and by a
  // run whose snapshot changed before a child started.
  writeBundle(join(dir, ".agtx/norun/nc1"), bundles.nc1);
  writeBundle(join(dir, ".agtx/changedrun/nc1"), bundles.nc1);
  writeFileSync(
    join(dir, ".agtx/changedrun/snapshot.json"),
    `${JSON.stringify(
      snapshotRecord(TARGET, (x) => {
        x.checks.push({ when: "before Playwright", sha256: sha("changed") });
        x.unchanged = false;
      }),
      null,
      2,
    )}\n`,
  );
  // Revision 27: the producing run's completion witness beside the parts (their run directory is .agtx): a sealed, unchanged,
  // removed snapshot of TARGET.
  writeFileSync(
    join(dir, ".agtx/snapshot.json"),
    `${JSON.stringify(snapshotRecord(), null, 2)}\n`,
  );
  // The consumer's own record (TARGET), as `--target <applicability.json>` reads it.
  writeFileSync(join(dir, ".agtx/target.json"), canonical(TARGET));
  writeFileSync(
    join(dir, ".agtx/nc1-report-bytes.json"),
    bundles.nc1.files.report,
  );
  mkdirSync(join(dir, ".agtx/truncated"));
  writeFileSync(
    join(dir, ".agtx/truncated", evidenceModule.MANIFEST),
    bundles.nc1.manifest_bytes.subarray(0, 60),
  );
  return dir;
}
const HELPER_TEXT = readFileSync(join(root, evaluator.HELPER), "utf8");
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

/**
 * The judge over a bundle written by driverFixture (revision 25). Revision 26: an admission names the consumer's target (`--target
 * .agtx/target.json`, TARGET) unless the step names its own target or `--historical`, so each case is refused for its own reason.
 */
const evidenceStep = (bundle, ...extra) => ({
  id: "judge",
  stage: "focused",
  requirement:
    "negative-control qualification propagation from verified evidence",
  argv: [
    process.execPath,
    "scripts/validation/held-operation-judge.mjs",
    "--evidence",
    `.agtx/${bundle}/${evidenceModule.MANIFEST}`,
    ...(extra.includes("--historical") || extra.includes("--target")
      ? []
      : ["--target", ".agtx/target.json"]),
    ...extra,
  ],
});

test("Q8: a qualified genuine negative control, from its verified bundle, exits 0 and admits the next step", (t) => {
  const dir = driverFixture(t);
  const result = driver(dir, [
    evidenceStep(
      "nc1",
      "--negative",
      "NC1",
      "--invocation",
      INVOCATION,
      "--exit",
      "1",
    ),
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  assert.equal(result.passed, true);
  assert.equal(readFileSync(join(dir, ".agtx/later"), "utf8"), "ran");
});

test("Q4/Q8: a labelled diagnostic of a genuine report exits 0 only as a diagnostic: never admission-eligible", (t) => {
  const dir = driverFixture(t);
  const result = driver(dir, [
    {
      ...negativeStep("nc1", "--negative", "NC1", "--diagnostic"),
      argv: [
        ...negativeStep("nc1", "--negative", "NC1", "--diagnostic").argv,
        "--out",
        ".agtx/diagnostic.json",
      ],
    },
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  const out = JSON.parse(
    readFileSync(join(dir, ".agtx/diagnostic.json"), "utf8"),
  );
  assert.equal(out.outcome, "diagnostic-holds");
  assert.equal(out.admission_eligible, false);
  assert.equal(out.judgement.qualified, false);
  assert.match(out.replay, /never admissible/);
});

for (const [bundle, label] of [
  ["nc1", "a `/2` bundle"],
  ["nc1-legacy", "a revision 25 `/1` bundle"],
  ["nc1-node25", "a bundle of another runtime"],
])
  test(`H7 (revision 26): a historical replay of ${label} exits 0 only as historical-holds: never admission-eligible`, (t) => {
    const dir = driverFixture(t);
    const step = evidenceStep(bundle, "--negative", "NC1", "--historical");
    const result = driver(dir, [
      { ...step, argv: [...step.argv, "--out", ".agtx/historical.json"] },
      laterStep,
    ]);
    assert.equal(result.records[0].exit, 0);
    const out = JSON.parse(
      readFileSync(join(dir, ".agtx/historical.json"), "utf8"),
    );
    assert.equal(out.outcome, "historical-holds");
    assert.equal(out.admission_eligible, false);
    assert.equal(out.judgement.qualified, false);
    assert.equal(out.judgement.applicability.decision, "unassessed");
    assert.match(out.replay, /HISTORICAL replay/);
  });

test("H8 (revision 26): an admission to the bundle's own runtime record is admission-eligible", (t) => {
  const dir = driverFixture(t);
  const step = evidenceStep("nc1", "--negative", "NC1");
  const result = driver(dir, [
    { ...step, argv: [...step.argv, "--out", ".agtx/admitted.json"] },
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  const out = JSON.parse(
    readFileSync(join(dir, ".agtx/admitted.json"), "utf8"),
  );
  assert.equal(out.outcome, "qualified");
  assert.equal(out.admission_eligible, true);
  assert.equal(out.applicability.decision, "applicable");
  assert.equal(out.applicability.target_sha256, TARGET_SHA);
});

for (const [label, bundle, why] of [
  [
    "a run that left no snapshot record",
    "norun/nc1",
    "no execution snapshot record",
  ],
  [
    "a run whose snapshot changed before a child",
    "changedrun/nc1",
    "changed (before Playwright)",
  ],
  ["a revision 26 run (a /1 record)", "nc1-r26", "applicability"],
])
  test(`H11 (revision 27): an admission of a bundle published by ${label} exits 1, never admission-eligible`, (t) => {
    const dir = driverFixture(t);
    const step = evidenceStep(bundle, "--negative", "NC1");
    const result = driver(dir, [
      { ...step, argv: [...step.argv, "--out", ".agtx/refused.json"] },
      laterStep,
    ]);
    assert.equal(result.records[0].exit, 1);
    assert.equal(result.records[1].status, "not_run");
    assert.equal(existsSync(join(dir, ".agtx/later")), false);
    const out = JSON.parse(
      readFileSync(join(dir, ".agtx/refused.json"), "utf8"),
    );
    assert.equal(out.admission_eligible, false);
    assert.equal(out.passed, false);
    const reasons = [
      ...(out.producing_run?.problems ?? []),
      ...(out.judgement?.problems ?? []),
    ];
    assert.ok(
      reasons.some((r) => r.includes(why)),
      JSON.stringify(reasons),
    );
  });
test("H11 (revision 27): a revision 26 bundle still replays as history, never admission-eligible", (t) => {
  const dir = driverFixture(t);
  const step = evidenceStep("nc1-r26", "--negative", "NC1", "--historical");
  const result = driver(dir, [
    { ...step, argv: [...step.argv, "--out", ".agtx/history.json"] },
    laterStep,
  ]);
  assert.equal(result.records[0].exit, 0);
  const out = JSON.parse(readFileSync(join(dir, ".agtx/history.json"), "utf8"));
  assert.equal(out.outcome, "historical-holds");
  assert.equal(out.admission_eligible, false);
  assert.equal(out.producing_run, null);
});

for (const [name, steps] of [
  [
    "review r23's wrong-fault NC2 (its reproduction of R23-N1), as a diagnostic",
    [negativeStep("wrong-nc2", "--negative", "NC2", "--diagnostic")],
  ],
  [
    "review r22's runtime report as NC1 (another hook), as a diagnostic",
    [judgeStep("judge", "--negative", "NC1", "--diagnostic")],
  ],
  [
    "a genuine NC1 report judged as NC2, as a diagnostic",
    [negativeStep("nc1", "--negative", "NC2", "--diagnostic")],
  ],
  [
    "a genuine NC1 report narrowed to Chromium, as a diagnostic",
    [
      negativeStep(
        "nc1",
        "--negative",
        "NC1",
        "--diagnostic",
        "--browsers",
        "chromium",
      ),
    ],
  ],
  [
    "a negative control asked to expect anything but qualified",
    [negativeStep("wrong-nc2", "--negative", "NC2", "--expect", "unqualified")],
  ],
  [
    "a missing report",
    [negativeStep("absent", "--negative", "NC1", "--diagnostic")],
  ],
  // Revision 25 (review r24 R24-N1; design assessment Q8): the actual CLI and the actual shared driver.
  [
    "a negative control with neither evidence nor --diagnostic",
    [negativeStep("nc1", "--negative", "NC1")],
  ],
  [
    "a revision 24 receipt (--provenance)",
    [
      negativeStep(
        "nc1",
        "--negative",
        "NC1",
        "--provenance",
        ".agtx/nc1/execution.json",
      ),
    ],
  ],
  [
    "a supplied exit of 0 against the bundle's recorded 1 (review r24's CLI reproduction)",
    [evidenceStep("nc1", "--negative", "NC1", "--exit", "0")],
  ],
  [
    "a bundle whose recorded execution exited 0",
    [evidenceStep("nc1-exit0", "--negative", "NC1")],
  ],
  [
    "another report supplied beside the bundle",
    [
      evidenceStep(
        "nc1",
        "--negative",
        "NC1",
        "--report",
        ".agtx/wrong-nc2-report.json",
      ),
    ],
  ],
  [
    "another invocation's bundle beside this invocation's report (cross-invocation)",
    [
      evidenceStep(
        "nc1-other",
        "--negative",
        "NC1",
        "--report",
        ".agtx/nc1-report-bytes.json",
      ),
    ],
  ],
  [
    "another invocation's complete bundle judged for this invocation",
    [
      evidenceStep(
        "nc1-other",
        "--negative",
        "NC1",
        "--invocation",
        INVOCATION,
      ),
    ],
  ],
  [
    "HM3 installed in NC4's bundle",
    [evidenceStep("nc4-hm3", "--negative", "NC4")],
  ],
  ["a truncated manifest", [evidenceStep("truncated", "--negative", "NC1")]],
  ["no manifest at all", [evidenceStep("absent", "--negative", "NC1")]],
  ["NC1's bundle judged as NC2", [evidenceStep("nc1", "--negative", "NC2")]],
  [
    "a bundle given an engine selection",
    [evidenceStep("nc1", "--negative", "NC1", "--browsers", "chromium")],
  ],
  // Revision 26 (review r25 R25-N1; design assessment 26f1a626 Q2, Q4, H7, H8): the actual CLI and the actual shared driver.
  [
    "a bundle judged with neither --target nor --historical (no applicability decision can be made)",
    [
      {
        ...evidenceStep("nc1", "--negative", "NC1", "--historical"),
        argv: evidenceStep(
          "nc1",
          "--negative",
          "NC1",
          "--historical",
        ).argv.filter((a) => a !== "--historical"),
      },
    ],
  ],
  [
    "both --target and --historical",
    [
      evidenceStep(
        "nc1",
        "--negative",
        "NC1",
        "--historical",
        "--target",
        ".agtx/target.json",
      ),
    ],
  ],
  [
    "a bundle recorded under Node v25.8.2 admitted to a v22.23.2 target (review r25's counterexample)",
    [evidenceStep("nc1-node25", "--negative", "NC1")],
  ],
  [
    "a revision 25 bundle (no applicability recorded) admitted to a target",
    [evidenceStep("nc1-legacy", "--negative", "NC1")],
  ],
  [
    "a target that is not an applicability record",
    [
      evidenceStep(
        "nc1",
        "--negative",
        "NC1",
        "--target",
        ".agtx/nc1-report-bytes.json",
      ),
    ],
  ],
  [
    "a control bundle judged without a target or --historical",
    [
      {
        id: "judge",
        stage: "focused",
        requirement: "control admission propagation",
        argv: [
          process.execPath,
          "scripts/validation/held-operation-judge.mjs",
          "--control",
          "--evidence",
          `.agtx/nc1/${evidenceModule.MANIFEST}`,
          "--part",
          "control",
        ],
      },
    ],
  ],
])
  test(`Q7/Q8: ${name} exits non-zero and the shared driver admits no later work`, (t) => {
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

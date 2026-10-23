#!/usr/bin/env node
// WEB-08d revision 23 (review r22 R22-N1; design assessment 3bef3bd4 Q1, Q9): judges one saved Playwright JSON report of the
// held-operation probes with the qualification's contracts, without a browser. It exits 0 only when the judgement is the expected one,
// so a validation step built on it stops the shared driver (scripts/run-validation.mjs) on any other outcome, a missing report or an
// unreadable one.
//
// Revision 24 (review r23 R23-N1; design assessment e228174c C5): `--negative` succeeds only for a `qualified` negative control
// (integrity, its own scenario and the classifier's refusal; held-operation-qualification.mjs judgeNegative), and takes no --expect: no
// other outcome of a negative control is admissible. A classifier diagnostic (`--mutant <contract> --expect invalid`) remains, and says
// nothing about whether a negative scenario ran. A replay is not a fresh browser run; `--provenance` checks a runner's recorded
// invocation (a negative control's result.json) as well.
//
// Revision 25 (review r24 R24-N1; design assessment 91d0404c C1, C4): a recorded invocation was checked only against itself, so a receipt
// with a wrong report digest, a contradicting exit, or another invocation's receipt still qualified. `--negative` now qualifies only
// from a published evidence bundle (`--evidence <manifest.json>`, verified by held-operation-evidence.mjs exactly as the live runner
// verifies it): its report, spec and execution come from the bundle, and a report, spec or exit also given here must be the bundle's own.
// `--diagnostic` judges a saved report's scenario and classifier without evidence: labelled, never admissible (`admission_eligible:
// false`); its exit 0 means only that the scenario held and the classifier refused. The revision 24 receipt (`--provenance`) is refused.
//
// Usage: node scripts/validation/held-operation-judge.mjs
//          --negative <NC id> --evidence <manifest.json> [--report <report.json>] [--spec <spec>] [--exit <n>]
//                             [--invocation <run id>] [--source <fingerprint sha256 | current>]
//        | --negative <NC id> --diagnostic --report <report.json> --exit <n> --spec <spec> [--browsers ...]
//        | --control --evidence <manifest.json> --part control|copy-control [--invocation <id>] [--source <sha256 | current>]
//        | --control --report <report.json> --exit <n> --spec <spec> [--probes P01,...] [--expect healthy|unhealthy] [--browsers ...]
//        | --mutant <ID> --report <report.json> --exit <n> --spec <spec> [--probes S10,...] [--expect caught|survived|invalid] [--browsers ...]
//        [--out <judgement.json>]
// Defaults: a mutant is expected `caught`, a control `healthy`; a negative control must be `qualified` (a diagnostic, `diagnostic-holds`).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  judgeControlEvidence,
  qualifyNegative,
  readBundle,
  sha256,
} from "./held-operation-evidence.mjs";
import {
  CONTRACT_VERSION,
  judgeControl,
  judgeMutant,
  judgeNegative,
  NEGATIVE_CONTRACT_VERSION,
  NEGATIVE_CONTROLS,
  NO_EVIDENCE,
  normalise,
  PROBE_IDS,
} from "./held-operation-qualification.mjs";
import { fingerprint } from "./runtime.mjs";

const args = process.argv.slice(2);
const flags = new Set(["--control", "--diagnostic"]);
const options = new Map();
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) {
    options.set(args[i], true);
    continue;
  }
  if (args[i] === "--provenance")
    throw new Error(
      "--provenance (a revision 24 receipt) is not verifiable evidence: qualify from --evidence <manifest.json>, or judge with --diagnostic",
    );
  if (
    ![
      "--report",
      "--exit",
      "--spec",
      "--mutant",
      "--negative",
      "--probes",
      "--expect",
      "--browsers",
      "--out",
      "--evidence",
      "--part",
      "--invocation",
      "--source",
    ].includes(args[i])
  )
    throw new Error(`Unknown option: ${args[i]}`);
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--"))
    throw new Error(`Missing value for ${args[i]}`);
  options.set(args[i], v);
  i += 1;
}
const modes = ["--mutant", "--negative", "--control"].filter((m) =>
  options.has(m),
);
if (modes.length !== 1)
  throw new Error("Name exactly one of --mutant, --negative and --control");
const mode = modes[0];
const bound = options.has("--evidence");
if (bound && mode === "--mutant")
  throw new Error("--evidence binds a control or a negative control");
if (bound && options.has("--diagnostic"))
  throw new Error("--evidence and --diagnostic exclude each other");
if (options.has("--diagnostic") && mode !== "--negative")
  throw new Error("--diagnostic judges a negative control without evidence");
if (mode === "--negative" && !bound && !options.has("--diagnostic"))
  throw new Error(
    "a negative control qualifies only from --evidence <manifest.json>; --diagnostic judges a saved report without admitting it",
  );
if (
  !bound &&
  (!options.has("--report") || !options.has("--exit") || !options.has("--spec"))
)
  throw new Error(
    "--report, --exit and --spec are required without --evidence",
  );
if (bound)
  for (const o of ["--browsers", "--probes", "--expect"])
    if (options.has(o))
      throw new Error(`${o}: a bundle's selection is its own recorded run's`);
if (!bound)
  for (const o of ["--part", "--invocation", "--source"])
    if (options.has(o)) throw new Error(`${o} binds --evidence`);
if (
  bound &&
  mode === "--control" &&
  !["control", "copy-control"].includes(options.get("--part"))
)
  throw new Error("--control --evidence needs --part control|copy-control");
if (mode === "--negative" && options.has("--expect"))
  throw new Error(
    "--negative takes no --expect: a negative control must be qualified; a classifier diagnostic is --mutant <contract> --expect invalid",
  );
if (mode === "--negative" && options.has("--probes"))
  throw new Error("--negative judges its control's own probes: no --probes");
const allowed = {
  "--mutant": ["caught", "survived", "invalid"],
  "--control": ["healthy", "unhealthy"],
};
if (options.has("--expect") && !allowed[mode].includes(options.get("--expect")))
  throw new Error(
    `${mode} --expect must be one of ${allowed[mode].join(", ")}`,
  );
let exit;
if (options.has("--exit")) {
  exit = Number(options.get("--exit"));
  if (!Number.isInteger(exit)) throw new Error("--exit must be an integer");
}
const browsers = (options.get("--browsers") ?? "chromium,firefox,webkit").split(
  ",",
);
const probes = options.get("--probes")?.split(",").filter(Boolean);
// Each file named here is read once; its bytes are what is hashed and judged.
const reportBytes = options.has("--report")
  ? readFileSync(options.get("--report"))
  : undefined;
const specBytes = options.has("--spec")
  ? readFileSync(options.get("--spec"))
  : undefined;
const nc =
  mode === "--negative"
    ? NEGATIVE_CONTROLS.find((n) => n.id === options.get("--negative"))
    : null;
if (mode === "--negative" && !nc)
  throw new Error(`Unknown negative control ${options.get("--negative")}`);

let judgement;
let outcome;
let expected;
let label;
if (bound) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const expect = {
    invocation: options.get("--invocation"),
    source:
      options.get("--source") === "current"
        ? fingerprint(root).sha256
        : options.get("--source"),
    report_sha256: reportBytes ? sha256(reportBytes) : undefined,
    spec_sha256: specBytes ? sha256(specBytes) : undefined,
    exit,
  };
  const bundle = readBundle(options.get("--evidence"));
  label =
    "a verified replay of a published evidence bundle: its own recorded run, not a fresh browser run";
  if (nc) {
    judgement = qualifyNegative(nc, bundle, expect);
    outcome = judgement.outcome;
    expected = "qualified";
  } else {
    judgement = judgeControlEvidence(bundle, {
      ...expect,
      part: options.get("--part"),
    });
    outcome = judgement.ok ? "healthy" : "unhealthy";
    expected = "healthy";
  }
} else {
  const run = normalise(
    JSON.parse(reportBytes.toString("utf8")),
    browsers,
    exit,
    specBytes.toString("utf8"),
  );
  label = "a saved report judged without a browser, not a fresh browser run";
  if (mode === "--mutant") {
    judgement = judgeMutant(options.get("--mutant"), run, browsers, probes);
    outcome = judgement.verdict;
    expected = options.get("--expect") ?? "caught";
  } else if (nc) {
    // A diagnostic: the scenario and the classifier, without evidence; never qualified, never a prerequisite.
    judgement = judgeNegative(nc, run, browsers);
    const otherwise = judgement.integrity.problems.filter(
      (p) => p !== NO_EVIDENCE,
    );
    outcome =
      otherwise.length === 0 &&
      judgement.scenario.valid &&
      judgement.classifier.refused
        ? "diagnostic-holds"
        : "diagnostic-fails";
    expected = "diagnostic-holds";
    label =
      "a saved report judged WITHOUT verified evidence: a labelled diagnostic, never admissible as a qualified negative control, not a fresh browser run";
  } else {
    judgement = judgeControl(run, probes ?? PROBE_IDS, browsers);
    outcome = judgement.ok ? "healthy" : "unhealthy";
    expected = options.get("--expect") ?? "healthy";
  }
}
const result = {
  contract:
    mode === "--negative" ? NEGATIVE_CONTRACT_VERSION : CONTRACT_VERSION,
  replay: label,
  evidence: options.get("--evidence") ?? null,
  report: options.get("--report") ?? null,
  exit: exit ?? null,
  outcome,
  expected,
  passed: outcome === expected,
  admission_eligible: bound && outcome === expected,
  judgement,
};
const text = `${JSON.stringify(result, null, 2)}\n`;
if (options.has("--out")) writeFileSync(options.get("--out"), text);
console.log(
  `${result.passed ? "as expected" : "NOT AS EXPECTED"}: ${outcome} (expected ${expected})`,
);
for (const problem of judgement.problems.slice(0, 20))
  console.log(`  ${problem}`);
process.exitCode = result.passed ? 0 : 1;

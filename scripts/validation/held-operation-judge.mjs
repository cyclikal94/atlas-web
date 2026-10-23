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
// Usage: node scripts/validation/held-operation-judge.mjs --report <report.json> --exit <playwright exit code> --spec <the probe spec that ran>
//          (--mutant <ID> [--probes S10,...] [--expect caught|survived|invalid]
//           | --negative <NC id> [--provenance <result.json>]
//           | --control [--probes P01,...] [--expect healthy|unhealthy])
//          [--browsers chromium,firefox,webkit] [--out <judgement.json>]
// Defaults: a mutant is expected `caught`, a control `healthy`; a negative control must be `qualified`.
import { readFileSync, writeFileSync } from "node:fs";
import {
  CONTRACT_VERSION,
  judgeControl,
  judgeMutant,
  judgeNegative,
  NEGATIVE_CONTRACT_VERSION,
  NEGATIVE_CONTROLS,
  normalise,
  PROBE_IDS,
} from "./held-operation-qualification.mjs";

const args = process.argv.slice(2);
const flags = new Set(["--control"]);
const options = new Map();
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) {
    options.set(args[i], true);
    continue;
  }
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
      "--provenance",
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
if (
  !options.has("--report") ||
  !options.has("--exit") ||
  !options.has("--spec")
)
  throw new Error("--report, --exit and --spec are required");
if (options.has("--negative") && options.has("--expect"))
  throw new Error(
    "--negative takes no --expect: a negative control must be qualified; a classifier diagnostic is --mutant <contract> --expect invalid",
  );
if (options.has("--negative") && options.has("--probes"))
  throw new Error("--negative judges its control's own probes: no --probes");
if (options.has("--provenance") && !options.has("--negative"))
  throw new Error("--provenance is a negative control's recorded invocation");
const allowed = {
  "--mutant": ["caught", "survived", "invalid"],
  "--control": ["healthy", "unhealthy"],
};
if (
  options.has("--expect") &&
  !allowed[modes[0]].includes(options.get("--expect"))
)
  throw new Error(
    `${modes[0]} --expect must be one of ${allowed[modes[0]].join(", ")}`,
  );
const exit = Number(options.get("--exit"));
if (!Number.isInteger(exit)) throw new Error("--exit must be an integer");
const browsers = (options.get("--browsers") ?? "chromium,firefox,webkit").split(
  ",",
);
const probes = options.get("--probes")?.split(",").filter(Boolean);
const run = normalise(
  JSON.parse(readFileSync(options.get("--report"), "utf8")),
  browsers,
  exit,
  readFileSync(options.get("--spec"), "utf8"),
);
let judgement;
let outcome;
if (options.has("--mutant")) {
  judgement = judgeMutant(options.get("--mutant"), run, browsers, probes);
  outcome = judgement.verdict;
} else if (options.has("--negative")) {
  const nc = NEGATIVE_CONTROLS.find((n) => n.id === options.get("--negative"));
  if (!nc)
    throw new Error(`Unknown negative control ${options.get("--negative")}`);
  const provenance = options.has("--provenance")
    ? JSON.parse(readFileSync(options.get("--provenance"), "utf8")).provenance
    : undefined;
  if (options.has("--provenance") && provenance === undefined)
    throw new Error(`${options.get("--provenance")} records no provenance`);
  judgement = judgeNegative(nc, run, browsers, provenance);
  outcome = judgement.outcome;
} else {
  judgement = judgeControl(run, probes ?? PROBE_IDS, browsers);
  outcome = judgement.ok ? "healthy" : "unhealthy";
}
const expected =
  options.get("--expect") ??
  { "--mutant": "caught", "--negative": "qualified", "--control": "healthy" }[
    modes[0]
  ];
const result = {
  contract: options.has("--negative")
    ? NEGATIVE_CONTRACT_VERSION
    : CONTRACT_VERSION,
  replay: "a saved report judged without a browser, not a fresh browser run",
  report: options.get("--report"),
  exit,
  outcome,
  expected,
  passed: outcome === expected,
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

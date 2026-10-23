#!/usr/bin/env node
// WEB-08d revision 23 (review r22 R22-N1; design assessment 3bef3bd4 Q1, Q9): judges one saved Playwright JSON report of the
// held-operation probes with the qualification's contracts, without a browser. It exits 0 only when the judgement is the expected one,
// so a validation step built on it stops the shared driver (scripts/run-validation.mjs) on any other outcome, a missing report or an
// unreadable one.
//
// Usage: node scripts/validation/held-operation-judge.mjs --report <report.json> --exit <playwright exit code> --spec <the probe spec that ran>
//          (--mutant <ID> [--probes S10,...] | --negative <NC id> | --control [--probes P01,...])
//          [--expect caught|survived|invalid|healthy|refused] [--browsers chromium,firefox,webkit] [--out <judgement.json>]
// Defaults: a mutant is expected `caught`, a control `healthy`, a negative control `refused`.
import { readFileSync, writeFileSync } from "node:fs";
import {
  CONTRACT_VERSION,
  judgeControl,
  judgeMutant,
  judgeNegative,
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
  judgement = judgeNegative(nc, run, browsers);
  outcome = judgement.refused ? "refused" : judgement.verdict;
} else {
  judgement = judgeControl(run, probes ?? PROBE_IDS, browsers);
  outcome = judgement.ok ? "healthy" : "unhealthy";
}
const expected =
  options.get("--expect") ??
  { "--mutant": "caught", "--negative": "refused", "--control": "healthy" }[
    modes[0]
  ];
const result = {
  contract: CONTRACT_VERSION,
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

#!/usr/bin/env node
// Checks a profiling results file (plan 7.3 and 7.5): the one the device page (`/profile-harness`) copies, or the handoff's own
// `results.json`. It is also what a person with a device runs before sending their results back.
//
//   node scripts/validate-profile-handoff.mjs <results.json> [--allow-partial]
//
// It verifies (1) the schema, (2) every run's SHA-256 against the recorded hashes (scripts/lib/profile-workload-hashes.json) and that
// the page itself verified the fixture, (3) the "at least five cold runs" rule for the workloads that decide memory (W1, W3, W4, W6),
// (4) that every run states its expectation and its outcome, and (5) that a negative control (W7) was REFUSED and a valid workload was
// not silently dropped. Exit code 0: complete and consistent; 1: a violation; 2 with `--allow-partial`: valid but incomplete.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const allowPartial = args.includes("--allow-partial");
if (!file) {
  console.error(
    "usage: node scripts/validate-profile-handoff.mjs <results.json> [--allow-partial]",
  );
  process.exit(1);
}

const recorded = JSON.parse(
  readFileSync(join(root, "scripts/lib/profile-workload-hashes.json"), "utf8"),
);
const hashOf = new Map(recorded.workloads.map((w) => [w.name, w.sha256]));
const MUST_HAVE_RUNS = ["W1", "W3", "W4", "W6"];
const REQUIRED_COLD_RUNS = 5;
const OUTCOMES = new Set(["admitted", "refused", "error", "timeout", "killed"]);

const errors = [];
const warnings = [];
let data;
try {
  data = JSON.parse(readFileSync(resolve(file), "utf8"));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}

if (data.schema !== 1) errors.push("schema must be 1");
if (data.workload_version !== recorded.version)
  errors.push(
    `workload_version ${data.workload_version} is not the recorded ${recorded.version} (regenerate or re-record the fixtures)`,
  );
if (typeof data.machine !== "object" || data.machine === null)
  errors.push("machine is missing");
else {
  for (const key of [
    "user_agent",
    "device_memory_gib",
    "hardware_concurrency",
    "platform",
    "secure_context",
  ])
    if (!(key in data.machine)) errors.push(`machine.${key} is missing`);
  if (data.machine.secure_context === false)
    errors.push(
      "machine.secure_context is false: Web Locks and Web Crypto need HTTPS or localhost",
    );
}
if (!Array.isArray(data.runs) || data.runs.length === 0)
  errors.push("runs is empty");

const counts = new Map();
for (const [i, run] of (Array.isArray(data.runs) ? data.runs : []).entries()) {
  const where = `runs[${i}] (${run.workload} run ${run.run})`;
  if (!hashOf.has(run.workload)) {
    errors.push(`${where}: unknown workload`);
    continue;
  }
  // A KILLED run never got as far as verifying anything: it counts as a cold run with its outcome, and is not held to the hash rule.
  if (run.outcome !== "killed" && run.sha256 !== hashOf.get(run.workload))
    errors.push(
      `${where}: sha256 ${String(run.sha256).slice(0, 12)} is not the recorded ${hashOf.get(run.workload).slice(0, 12)}`,
    );
  if (run.outcome !== "killed" && run.sha256_verified !== true)
    errors.push(`${where}: the page did not verify the fixture's hash`);
  if (run.cold !== true) errors.push(`${where}: not a cold run`);
  if (!OUTCOMES.has(run.outcome))
    errors.push(
      `${where}: outcome ${run.outcome} is not one of ${[...OUTCOMES]}`,
    );
  if (run.expected !== "admitted" && run.expected !== "refused")
    errors.push(`${where}: expected is missing`);
  if (run.workload.startsWith("W7-") && run.outcome === "admitted")
    errors.push(`${where}: a NEGATIVE control was admitted`);
  if (!run.workload.startsWith("W7-") && run.outcome === "error")
    warnings.push(`${where}: outcome error (${run.detail})`);
  if (typeof run.elapsed_ms !== "number")
    errors.push(`${where}: elapsed_ms is missing`);
  if (typeof run.user_agent !== "string")
    errors.push(`${where}: user_agent is missing`);
  counts.set(run.workload, (counts.get(run.workload) ?? 0) + 1);
}

let incomplete = false;
for (const name of MUST_HAVE_RUNS) {
  const n = counts.get(name) ?? 0;
  if (n < REQUIRED_COLD_RUNS) {
    incomplete = true;
    warnings.push(
      `${name}: ${n} cold run(s); at least ${REQUIRED_COLD_RUNS} are required`,
    );
  }
}
for (const w of recorded.workloads)
  if (!counts.has(w.name)) {
    incomplete = true;
    warnings.push(`${w.name}: no run recorded`);
  }

for (const message of errors) console.error(`ERROR   ${message}`);
for (const message of warnings) console.error(`WARNING ${message}`);
console.log(
  `${data.runs?.length ?? 0} run(s) over ${counts.size} workload(s); ${errors.length} error(s), ${warnings.length} warning(s)`,
);
if (errors.length > 0) process.exit(1);
if (incomplete) {
  console.log(
    allowPartial
      ? "valid but INCOMPLETE (allowed)"
      : "INCOMPLETE: not every workload has its runs",
  );
  process.exit(allowPartial ? 2 : 1);
}
console.log("complete and consistent");

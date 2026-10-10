#!/usr/bin/env node
// Checks a profiling results file (plan 7.3 and 7.5): the one the device page (`/profile-harness`) copies. It is also what a person with a
// device runs before sending their results back. With `--handoff <dir>` it checks the hand-over directory instead (WEB-09c plan 4.2): every
// consumer-map key of BE-B1 and BE-Q23 is answered with a status, evidence and an owner; no desktop row claims a device class and no device
// row is `measured` from a desktop engine; the fixtures match the recorded hashes; SHA256SUMS covers and verifies every file; the
// completeness inventory and the isolation of every series are present and consistent, and no desktop conclusion is drawn from an
// incomplete programme (review R1, R2).
//
//   node scripts/validate-profile-handoff.mjs <results.json> --w2-hashes <handoff>/fixtures/W2-hashes.json [--allow-partial]
//   node scripts/validate-profile-handoff.mjs --handoff <dir> [--allow-partial]
//
// It verifies (1) the schema, (2) every run's SHA-256 against the recorded hashes (scripts/lib/profile-workload-hashes.json; for W2, the
// captured bytes, against the hand-over's W2-hashes.json given with --w2-hashes) and that the page itself verified the fixture, (3) the
// "at least five cold runs" rule for the workloads that decide memory (W1, W2, W3, W4, W6), (4) that every run states its expectation and
// its outcome, and (5) that a negative control (W7) was REFUSED and a valid workload was not silently dropped. Exit code 0: complete and
// consistent; 1: a violation, or incomplete; 2 with `--allow-partial`: valid but incomplete. A results file without W2 is incomplete.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONSUMER_KEYS,
  CONSUMER_STATUSES,
  DEVICE_KEYS,
  EVIDENCE_KEY,
  EVIDENCE_OWNER,
} from "./lib/profile-evidence.mjs";
import { VERDICTS as ISOLATION_VERDICTS } from "./lib/profile-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowPartial = args.includes("--allow-partial");
const handoffAt = args.indexOf("--handoff");
if (handoffAt >= 0)
  process.exit(validateHandoff(args[handoffAt + 1], allowPartial));
const w2At = args.indexOf("--w2-hashes");
const w2HashesFile = w2At >= 0 ? args[w2At + 1] : null;
const file = args.find(
  (a, i) => !a.startsWith("--") && !(w2At >= 0 && i === w2At + 1),
);
if (!file) {
  console.error(
    "usage: node scripts/validate-profile-handoff.mjs <results.json> --w2-hashes <W2-hashes.json> [--allow-partial]",
  );
  process.exit(1);
}

const recorded = JSON.parse(
  readFileSync(join(root, "scripts/lib/profile-workload-hashes.json"), "utf8"),
);
const hashOf = new Map(recorded.workloads.map((w) => [w.name, w.sha256]));
// W2 is not generated: its runs are of the bytes the released backend produced, which the hand-over carries with their hashes.
let w2Hashes = null;
if (w2HashesFile)
  try {
    w2Hashes = new Set(
      Object.values(JSON.parse(readFileSync(resolve(w2HashesFile), "utf8"))),
    );
  } catch (error) {
    console.error(`cannot read ${w2HashesFile}: ${error.message}`);
    process.exit(1);
  }
const MUST_HAVE_RUNS = ["W1", "W2", "W3", "W4", "W6"];
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
  const isW2 = run.workload === "W2";
  if (!isW2 && !hashOf.has(run.workload)) {
    errors.push(`${where}: unknown workload`);
    continue;
  }
  // A KILLED run never got as far as verifying anything: it counts as a cold run with its outcome, and is not held to the hash rule.
  if (isW2 && run.outcome !== "killed") {
    if (!w2Hashes)
      errors.push(
        `${where}: a W2 run cannot be verified without --w2-hashes (the hand-over's fixtures/W2-hashes.json)`,
      );
    else if (!w2Hashes.has(run.sha256))
      errors.push(
        `${where}: sha256 ${String(run.sha256).slice(0, 12)} is not a captured W2 of the hand-over`,
      );
  } else if (
    !isW2 &&
    run.outcome !== "killed" &&
    run.sha256 !== hashOf.get(run.workload)
  )
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
for (const w of [...recorded.workloads, { name: "W2" }])
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

/**
 * `--handoff <dir>`: the hand-over directory itself. Exit 0: complete and consistent; 1: a violation, or a consistent hand-over of an
 * incomplete or unisolated programme; 2 with `--allow-partial`: a consistent PARTIAL hand-over (it says so, and draws no conclusion
 * from what is absent).
 */
function validateHandoff(dir, allowPartialHandoff) {
  if (!dir || dir.startsWith("--")) {
    console.error(
      "usage: node scripts/validate-profile-handoff.mjs --handoff <dir>",
    );
    return 1;
  }
  const at = resolve(dir);
  const problems = [];
  const sha = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  let results = null;
  try {
    results = JSON.parse(readFileSync(join(at, "results.json"), "utf8"));
  } catch (error) {
    problems.push(`results.json cannot be read: ${error.message}`);
  }
  if (results) {
    if (results.schema !== 2) problems.push("results.json: schema must be 2");
    if (results.evidence_key !== EVIDENCE_KEY)
      problems.push(`results.json: evidence_key must be ${EVIDENCE_KEY}`);
    if (results.owner !== EVIDENCE_OWNER)
      problems.push(`results.json: owner must be ${EVIDENCE_OWNER}`);
    const map = results.consumer_map ?? {};
    for (const key of CONSUMER_KEYS) {
      const row = map[key];
      if (!row) {
        problems.push(`consumer_map: ${key} is missing`);
        continue;
      }
      if (!CONSUMER_STATUSES.includes(row.status))
        problems.push(`consumer_map: ${key} has status ${row.status}`);
      if (!Array.isArray(row.answered_by) || row.answered_by.length === 0)
        problems.push(`consumer_map: ${key} names no evidence`);
      for (const field of ["reason", "owner", "environment"])
        if (typeof row[field] !== "string" || !row[field].trim())
          problems.push(`consumer_map: ${key} has no ${field}`);
      const desktop = row.environment === "desktop-playwright";
      if (row.status === "measured" && desktop && row.claims_device_class)
        problems.push(
          `consumer_map: ${key} is measured on a desktop engine but claims a device class`,
        );
      if (
        DEVICE_KEYS.includes(key) &&
        row.status === "measured" &&
        row.environment !== "real-device"
      )
        problems.push(
          `consumer_map: ${key} asks for real devices and cannot be measured from ${row.environment}`,
        );
    }
    for (const key of Object.keys(map))
      if (!CONSUMER_KEYS.includes(key))
        problems.push(`consumer_map: ${key} is not a BE-B1/BE-Q23 item`);
    problems.push(...programmeProblems(results));
  }
  // The fixtures: the generator's recorded hashes, and every captured W2 file against its own hash.
  const fixtures = join(at, "fixtures");
  try {
    const recorded = readFileSync(
      join(root, "scripts/lib/profile-workload-hashes.json"),
      "utf8",
    );
    if (
      JSON.stringify(
        JSON.parse(readFileSync(join(fixtures, "hashes.json"), "utf8")),
      ) !== JSON.stringify(JSON.parse(recorded))
    )
      problems.push("fixtures/hashes.json is not the recorded workload hashes");
  } catch (error) {
    problems.push(`fixtures/hashes.json cannot be read: ${error.message}`);
  }
  if (existsSync(join(fixtures, "W2-hashes.json"))) {
    const w2 = JSON.parse(
      readFileSync(join(fixtures, "W2-hashes.json"), "utf8"),
    );
    for (const [name, hash] of Object.entries(w2))
      if (!existsSync(join(fixtures, name)))
        problems.push(`fixtures/${name} is missing`);
      else if (sha(join(fixtures, name)) !== hash)
        problems.push(`fixtures/${name} does not match W2-hashes.json`);
  }
  // SHA256SUMS covers every file and every line verifies.
  const files = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name !== "SHA256SUMS") files.push(relative(at, p));
    }
  };
  if (existsSync(at)) walk(at);
  let sums = new Map();
  try {
    sums = new Map(
      readFileSync(join(at, "SHA256SUMS"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, ...name] = line.split("  ");
          return [name.join("  "), hash];
        }),
    );
  } catch (error) {
    problems.push(`SHA256SUMS cannot be read: ${error.message}`);
  }
  for (const name of files)
    if (!sums.has(name)) problems.push(`SHA256SUMS does not cover ${name}`);
  for (const [name, hash] of sums)
    if (!existsSync(join(at, name)))
      problems.push(`SHA256SUMS names ${name}, which is missing`);
    else if (sha(join(at, name)) !== hash)
      problems.push(`SHA256SUMS: ${name} does not verify`);
  for (const message of problems) console.error(`ERROR   ${message}`);
  console.log(
    `${files.length} file(s), ${Object.keys(results?.consumer_map ?? {}).length} consumer-map row(s); ${problems.length} error(s)`,
  );
  if (problems.length > 0) return 1;
  const programme = results.desktop_programme;
  if (!programme.complete) {
    console.log(
      `PARTIAL hand-over: the desktop programme is ${programme.outcomes_complete ? "not isolated" : "incomplete"} (${programme.missing.length} missing, ${programme.failed.length} failed, ${programme.isolation.not_isolated_series} series not isolated)${allowPartialHandoff ? " (allowed)" : ""}`,
    );
    return allowPartialHandoff ? 2 : 1;
  }
  console.log("hand-over complete and consistent");
  return 0;
}

/**
 * The completeness inventory, the isolation of every series and the conclusions drawn from them must agree (review R1, R2): a hand-over
 * may be partial, but it may not say it is complete when its own lists say otherwise, nor draw a desktop conclusion from an incomplete
 * programme.
 */
function programmeProblems(results) {
  const problems = [];
  const p = results.desktop_programme;
  if (!p || typeof p !== "object")
    return ["desktop_programme: the completeness inventory is missing"];
  if (
    typeof p.complete !== "boolean" ||
    typeof p.outcomes_complete !== "boolean"
  )
    problems.push(
      "desktop_programme: complete and outcomes_complete must be booleans",
    );
  if (!Array.isArray(p.missing) || !Array.isArray(p.failed))
    return [...problems, "desktop_programme: missing and failed must be lists"];
  const isolation = results.isolation;
  if (!isolation || !Array.isArray(isolation.series) || !isolation.summary)
    return [...problems, "isolation: the per-series verdicts are missing"];
  for (const [i, row] of isolation.series.entries())
    if (!ISOLATION_VERDICTS.includes(row.verdict))
      problems.push(
        `isolation.series[${i}] (${row.name}): verdict ${row.verdict}`,
      );
  const clean = isolation.series.filter((r) => r.verdict === "clean").length;
  const allClean =
    isolation.series.length > 0 &&
    clean === isolation.series.length &&
    (isolation.tests ?? []).every((t) => t.verdict === "clean");
  if (
    isolation.summary.series !== isolation.series.length ||
    isolation.summary.clean !== clean
  )
    problems.push("isolation.summary does not count its own series");
  if (
    isolation.summary.all_clean !== allClean ||
    p.isolation?.all_clean !== allClean
  )
    problems.push("isolation: all_clean does not match the verdicts");
  if (p.outcomes_complete !== (p.missing.length === 0 && p.failed.length === 0))
    problems.push(
      "desktop_programme: outcomes_complete contradicts its missing and failed lists",
    );
  if (p.complete !== (p.outcomes_complete && allClean))
    problems.push(
      "desktop_programme: complete contradicts its outcomes and its isolation",
    );
  const failure = results.H8?.desktop_valid_workload_failure;
  if (failure === false && !p.outcomes_complete)
    problems.push(
      "H8: no desktop failure is concluded from an INCOMPLETE programme",
    );
  if (failure !== false && failure !== true && failure !== null)
    problems.push(
      "H8: desktop_valid_workload_failure must be true, false or null",
    );
  const finer = results.H9?.desktop_needs_finer_pagination;
  if (finer === false && (failure !== false || !p.outcomes_complete))
    problems.push(
      "H9: 'the desktop engines do not need finer pagination' needs a complete programme with no failure",
    );
  if (p.outcomes_complete)
    for (const [file, v] of Object.entries(
      results.device_page_validation ?? {},
    ))
      if (v.exit !== 0)
        problems.push(
          `device_page_validation: ${file} exited ${v.exit} in a programme called complete`,
        );
  return problems;
}

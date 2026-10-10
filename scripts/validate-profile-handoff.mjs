#!/usr/bin/env node
// Checks a profiling results file (plan 7.3 and 7.5): the one the device page (`/profile-harness`) copies. It is also what a person with a
// device runs before sending their results back. With `--handoff <dir>` it checks the hand-over directory instead (WEB-09c plan 4.2): every
// consumer-map key of BE-B1 and BE-Q23 is answered with a status, evidence and an owner; no desktop row claims a device class and no device
// row is `measured` from a desktop engine; the fixtures match the recorded hashes; SHA256SUMS covers and verifies every file; and the
// evidence the hand-over CARRIES (`evidence/`) is resolved again against the evidence contract (scripts/lib/profile-contract.mjs), so its
// completeness, isolation, item statuses and desktop conclusions are recomputed here and compared with what the hand-over says (review R1,
// R2; design assessment D). A hand-over is never trusted for its own booleans.
//
//   node scripts/validate-profile-handoff.mjs <results.json> --w2-hashes <handoff>/fixtures/W2-hashes.json [--allow-partial]
//   node scripts/validate-profile-handoff.mjs --handoff <dir> [--allow-partial]
//
// A results file (schema 2, scripts/lib/profile-device-results.mjs): one protocol identity, every (workload, run) once, every run's SHA-256
// against the recorded hashes (W2: the hand-over's captures given with --w2-hashes), the page's own verification, at least five DISTINCT
// cold runs of W1, W2, W3, W4 and W6, expectations from the workload contract, and every W7 negative control REFUSED (an admitted, timed-out,
// failed or killed control is kept in the file and fails the control). Exit 0: complete and consistent; 1: a violation, a control that was
// not fulfilled, or incomplete; 2 with `--allow-partial`: valid but incomplete. Invalid evidence or a failed control exits 1 even with
// `--allow-partial`.
//
// Revision 3 (review 3 R2, design assessment A7/E9/E10): the hand-over's `results.json` and `report.md` are projected AGAIN from the carried
// evidence and its fresh resolution (scripts/lib/profile-projection.mjs) with the context `results.json` records, and must be identical,
// field for field and byte for byte: a published figure, admission list, failure, count, consumer status or candidate identity that
// disagrees with the evidence is refused even when SHA256SUMS was regenerated after the edit. The recorded context is itself checked (the
// pin is this candidate's, every stage ran on the candidate named at hand-over, the constants are the ones constants.md shows). In both
// modes an INVALID cell or a failed control exits 1, `--allow-partial` or not: only a consistent programme that is merely incomplete or
// not isolated is a partial hand-over (2 when allowed).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  canonical,
  RECORDED,
  resolveEvidence,
} from "./lib/profile-contract.mjs";
import { checkDeviceResults } from "./lib/profile-device-results.mjs";
import {
  CONSUMER_KEYS,
  CONSUMER_STATUSES,
  DEVICE_KEYS,
  EVIDENCE_KEY,
  EVIDENCE_OWNER,
} from "./lib/profile-evidence.mjs";
import {
  contextOf,
  projectResults,
  renderReport,
} from "./lib/profile-projection.mjs";

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
let data;
try {
  data = JSON.parse(readFileSync(resolve(file), "utf8"));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}
const checked = checkDeviceResults(data, { recorded: RECORDED, w2Hashes });
for (const message of checked.errors) console.error(`ERROR   ${message}`);
for (const message of checked.failed_controls)
  console.error(`FAILED CONTROL ${message}`);
for (const message of checked.warnings) console.error(`WARNING ${message}`);
const counted = Object.values(checked.runs).reduce((n, r) => n + r.length, 0);
console.log(
  `${data.runs?.length ?? 0} run(s), ${counted} distinct, over ${Object.keys(checked.runs).length} workload(s); ${checked.errors.length} error(s), ${checked.failed_controls.length} failed control(s), ${checked.warnings.length} warning(s)`,
);
if (checked.errors.length > 0 || checked.failed_controls.length > 0)
  process.exit(1);
if (checked.incomplete) {
  console.log(
    allowPartial
      ? "valid but INCOMPLETE (allowed)"
      : "INCOMPLETE: not every workload has its distinct runs",
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
  let recomputed = null;
  if (results) {
    if (results.schema !== 3) problems.push("results.json: schema must be 3");
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
    if (!existsSync(join(at, "evidence")))
      problems.push(
        "evidence/ is missing: the hand-over carries no evidence its statements can be checked against",
      );
    else {
      recomputed = resolveEvidence(join(at, "evidence"));
      problems.push(...programmeProblems(results, recomputed, at));
    }
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
      else if (
        !existsSync(join(at, "evidence", "w2", name)) ||
        sha(join(at, "evidence", "w2", name)) !== hash
      )
        problems.push(`fixtures/${name} is not the capture the evidence holds`);
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
  // Invalid evidence and unfulfilled controls are never a partial hand-over: they are findings, whatever --allow-partial says.
  const refused = recomputed.cells.filter(
    (c) => c.status === "invalid" || c.status === "failed_control",
  );
  if (refused.length > 0) {
    for (const c of refused.slice(0, 40))
      console.error(
        `${c.status === "invalid" ? "INVALID" : "FAILED CONTROL"} ${c.id}: ${c.reasons.join("; ")}`,
      );
    console.log(
      `REFUSED: ${recomputed.counts.invalid} invalid cell(s) and ${recomputed.counts.failed_control} failed control(s) in the carried evidence${refused.length > 40 ? ` (first 40 shown; resolution.json lists all)` : ""}`,
    );
    return 1;
  }
  if (!recomputed.complete) {
    const c = recomputed.counts;
    console.log(
      `PARTIAL hand-over: the desktop programme is ${recomputed.outcomes_complete ? "not isolated" : "incomplete"} (of ${recomputed.cells.length} required cells: ${c.missing} missing, ${c.invalid} invalid, ${c.failed} failed, ${c.failed_control} failed control(s), ${c.not_isolated} not isolated)${allowPartialHandoff ? " (allowed)" : ""}`,
    );
    return allowPartialHandoff ? 2 : 1;
  }
  console.log("hand-over complete and consistent");
  return 0;
}

// A function declaration: the hand-over mode runs while this module is still being evaluated.
function idsOf(list) {
  return JSON.stringify(
    (Array.isArray(list) ? list : []).map((c) => c?.id ?? c).sort(),
  );
}

/**
 * What the hand-over says against what its own evidence resolves to (review R1, R2): the contract, every cell's status, the lists, the
 * item statuses and the desktop conclusions. A forged summary, a dropped raw file or a "complete" programme holding a not-run item is
 * refused here, whatever SHA256SUMS says.
 */
function programmeProblems(results, recomputed, at) {
  const problems = [];
  const p = results.desktop_programme;
  if (!p || typeof p !== "object")
    return ["desktop_programme: the completeness inventory is missing"];
  if (p.contract_version !== CONTRACT_VERSION)
    problems.push(
      `desktop_programme: contract ${p.contract_version}, not ${CONTRACT_VERSION}`,
    );
  if (p.complete !== recomputed.complete)
    problems.push(
      `desktop_programme: complete is ${p.complete}, but the evidence resolves to ${recomputed.complete}`,
    );
  if (p.outcomes_complete !== recomputed.outcomes_complete)
    problems.push(
      `desktop_programme: outcomes_complete is ${p.outcomes_complete}, but the evidence resolves to ${recomputed.outcomes_complete}`,
    );
  for (const [key, status] of [
    ["missing", "missing"],
    ["invalid", "invalid"],
    ["failed", "failed"],
    ["failed_controls", "failed_control"],
    ["not_isolated", "not_isolated"],
    ["unavailable", "unavailable"],
  ])
    if (
      idsOf(p[key]) !==
      idsOf(recomputed.cells.filter((c) => c.status === status))
    )
      problems.push(
        `desktop_programme: its ${key} list is not what the evidence resolves to`,
      );
  let stated = null;
  try {
    stated = JSON.parse(readFileSync(join(at, "resolution.json"), "utf8"));
  } catch (error) {
    problems.push(`resolution.json cannot be read: ${error.message}`);
  }
  if (stated) {
    const statusOf = new Map((stated.cells ?? []).map((c) => [c.id, c.status]));
    const differing = recomputed.cells.filter(
      (c) => statusOf.get(c.id) !== c.status,
    );
    if (differing.length || statusOf.size !== recomputed.cells.length)
      problems.push(
        `resolution.json: ${differing.length} cell(s) differ from the evidence (first: ${differing[0]?.id ?? "a cell outside the contract"})`,
      );
  }
  const d = recomputed.derived;
  if (
    results.H8?.desktop_valid_workload_failure !==
    d.desktop_valid_workload_failure
  )
    problems.push(
      `H8: desktop_valid_workload_failure is ${results.H8?.desktop_valid_workload_failure}; the evidence gives ${d.desktop_valid_workload_failure}`,
    );
  if (
    results.H9?.desktop_needs_finer_pagination !==
    d.desktop_needs_finer_pagination
  )
    problems.push(
      `H9: desktop_needs_finer_pagination is ${results.H9?.desktop_needs_finer_pagination}; the evidence gives ${d.desktop_needs_finer_pagination}`,
    );
  if (
    JSON.stringify(results.H9?.desktop_D_largest_dense_changes_committed) !==
    JSON.stringify(d.desktop_D_largest_dense_changes_committed)
  )
    problems.push(
      "H9: the desktop dense bound D is not what the evidence gives",
    );
  for (const [item, resolved] of Object.entries(recomputed.items)) {
    if (item === "stages" || item === "cases") continue;
    const stated = results.programme?.[item]?.status;
    if (stated !== resolved.status)
      problems.push(
        `programme: ${item} is ${stated}, but its evidence resolves to ${resolved.status}`,
      );
  }
  if (recomputed.complete)
    for (const [item, entry] of Object.entries(results.programme ?? {}))
      if (entry?.status === "not_run" || entry?.status === "partial")
        problems.push(
          `programme: ${item} is ${entry.status} in a programme called complete`,
        );
  const verdicts = recomputed.cells.filter((c) => c.isolation);
  const clean = verdicts.filter((c) => c.isolation.verdict === "clean").length;
  if (
    results.isolation?.summary?.judged_cells !== verdicts.length ||
    results.isolation?.summary?.clean !== clean ||
    results.isolation?.summary?.all_clean !==
      (verdicts.length > 0 && clean === verdicts.length)
  )
    problems.push(
      "isolation: the summary does not count the resolved verdicts",
    );
  for (const c of recomputed.cells.filter((x) => x.kind === "device-file")) {
    const stated = results.device_page_validation?.[`results.${c.engine}.json`];
    if (stated?.status !== c.status)
      problems.push(
        `device_page_validation: results.${c.engine}.json is ${stated?.status}; the evidence resolves to ${c.status}`,
      );
  }
  problems.push(...publicationProblems(results, recomputed, at));
  return problems;
}

/** The paths (up to `limit`) at which two JSON values differ. */
function differences(a, b, path = "", out = [], limit = 12) {
  if (out.length >= limit) return out;
  if (canonical(a) === canonical(b)) return out;
  const isObject = (x) => typeof x === "object" && x !== null;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    for (let i = 0; i < a.length; i += 1)
      differences(a[i], b[i], `${path}[${i}]`, out, limit);
  else if (isObject(a) && isObject(b) && !Array.isArray(a) && !Array.isArray(b))
    for (const key of [
      ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ].sort())
      differences(a[key], b[key], path ? `${path}.${key}` : key, out, limit);
  else out.push(path || "(the whole document)");
  return out;
}

/**
 * Every published field against the projection of the carried evidence (review 3 R2; design assessment A7/E9), the report against its
 * regeneration, and the recorded context against what can be checked of it.
 */
function publicationProblems(results, recomputed, at) {
  const problems = [];
  const context = contextOf(results);
  const pin = JSON.parse(readFileSync(join(root, "contract-pin.json"), "utf8"));
  if (canonical(context.pinned) !== canonical(pin))
    problems.push("backend.pin is not this candidate's contract-pin.json");
  const fingerprint = context.now?.source_fingerprint;
  const stagesDir = join(at, "evidence", "stages");
  if (existsSync(stagesDir))
    for (const f of readdirSync(stagesDir).filter((x) => x.endsWith(".json"))) {
      let record = null;
      try {
        record = JSON.parse(readFileSync(join(stagesDir, f), "utf8"));
      } catch {
        continue;
      }
      if (record?.candidate?.source_fingerprint !== fingerprint)
        problems.push(
          `candidate: stage ${f.replace(/\.json$/, "")} ran on ${record?.candidate?.source_fingerprint}, not the candidate named at hand-over (${fingerprint})`,
        );
    }
  let shown = null;
  try {
    const text = readFileSync(join(at, "constants.md"), "utf8");
    shown = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "null");
  } catch (error) {
    problems.push(`constants.md cannot be read: ${error.message}`);
  }
  if (canonical(shown) !== canonical(context.configValues))
    problems.push(
      "programme.P-12.values are not the constants constants.md shows",
    );
  let projected = null;
  try {
    projected = JSON.parse(
      JSON.stringify(
        projectResults({
          evidenceDir: join(at, "evidence"),
          resolution: recomputed,
          context,
        }),
      ),
    );
  } catch (error) {
    return [
      ...problems,
      `results.json cannot be projected from its evidence: ${error.message}`,
    ];
  }
  const differing = differences(results, projected);
  if (differing.length)
    problems.push(
      `results.json is not what its evidence projects to, at ${differing.join(", ")}`,
    );
  let report = null;
  try {
    report = readFileSync(join(at, "report.md"), "utf8");
  } catch (error) {
    problems.push(`report.md cannot be read: ${error.message}`);
  }
  if (
    report !== null &&
    report !==
      renderReport({
        results: projected,
        resolution: recomputed,
        evidenceDir: join(at, "evidence"),
      })
  )
    problems.push(
      "report.md is not the report its evidence and results generate",
    );
  return problems;
}

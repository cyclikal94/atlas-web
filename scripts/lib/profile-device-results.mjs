// The device page's results file (`/profile-harness`, plan 7.3 and 7.5): what one protocol on one device or desktop engine must hold. Shared
// by the validator's file mode (what an operator runs before sending results back) and the hand-over's evidence resolver
// (scripts/lib/profile-contract.mjs), so both judge a results file the same way.
//
// Schema 2 (WEB-09c revision 2; design assessment DA-1): every run belongs to ONE protocol (`protocol_id`), every (workload, run) appears
// once, and the runs a workload needs are counted as DISTINCT run numbers, so five copies of one run never stand for five cold runs. What a
// run is expected to do comes from the workload contract (a W7 control must be refused; every other workload admitted), never from the
// file's own `expected` field. A W7 control fulfils its control only when it was REFUSED: an admitted, timed-out, failed or killed control
// stays in the file as recorded and fails the control. A valid workload that failed is a FACT (reported), not a malformed file.
//
// Schema 1 files (before revision 2) are historical: they are refused here, and remain unchanged where they were recorded.
//
// Revision 3 (review 3 R2, design assessment E12): the file's lifecycle and every run's payload are checked as well. A protocol file holds
// the protocol's attempts in plan order (its planned count is the plan's, with or without W2), its terminal state agrees with how many it
// holds, and each run carries the figures its path and outcome produce: an engine run that was admitted or refused made its request and
// has its timings, W5 (processing only) made none and committed nothing, a killed attempt measured nothing, an error may lack figures but
// says so. Absence is explicit (null), never a missing field, and never successful processing evidence.
//
// Schema 3 (WEB-09c revision 10, design assessment DA-3): an engine run's outcome is corroborated, not trusted. Its detail is the JSON
// state the engine ended in and must show the recorded outcome (an admitted run idle; a refused one stopped, backing off, paused or
// waiting for a valid cache); and every run carries `first_commit`, the first commit after its request (the served body's: its bytes, kind
// and timings) or an explicit null, which an admitted run's figures must equal. W5 and killed attempts have none. Schema-2 files (before
// revision 10) are historical: refused here, never rewritten. The rules are shared with the cold-run classifier and the contract
// (scripts/lib/profile-outcome-rules.mjs).

//
// Schema 4 (WEB-09c revision 12, review 12 R2, design assessment DA-D1): schema 3 accepted a run whose first commit was applied but
// wrote no page (`lease_lapsed`, `not_ready`) and whose later empty page published idle. Every engine run now carries the observation it
// was classified from (`engine-state-log/3`) and the cache it left (`effects`); the shared rules judge the observation against the run's
// bytes and requests, an admission needs the measured page committed, and its effects must be what the VERIFIED served bytes leave in
// the run's new, empty database, derived here from the regenerated workload or the certified W2 capture (never from the file). Schema-3
// files are historical: refused here, never rewritten.

import { createHash } from "node:crypto";
import { effectsText, entriesOfPage } from "./profile-effects.mjs";
import { deviceRunOutcomeProblems } from "./profile-outcome-rules.mjs";
import { VALID } from "./profile-workloads.mjs";

/** What a served body leaves in a new, empty cache (`cache-rows/1`), or null when it is not a page. */
export function expectedEffectsOfBody(body) {
  const text =
    typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const { entries } = entriesOfPage(text);
  return entries
    ? {
        rows: entries.length,
        entries_sha256: createHash("sha256")
          .update(effectsText(entries), "utf8")
          .digest("hex"),
      }
    : null;
}

/**
 * The expected effects of a generated workload by name, or null: only the valid engine workloads (W1, W3, W4, W6) are admitted evidence
 * with effects (W5 is processing only, a W7 control's admission fails it whatever it wrote). Each is regenerated once, on first use: the
 * bytes the recorded hashes pin.
 */
const generated = new Map();
export function effectsOfWorkload(name) {
  if (!Object.hasOwn(VALID, name)) return null;
  if (!generated.has(name))
    generated.set(name, expectedEffectsOfBody(VALID[name]()));
  return generated.get(name);
}

export const DEVICE_SCHEMA = 4;
export const MUST_HAVE_RUNS = ["W1", "W2", "W3", "W4", "W6"];
export const REQUIRED_COLD_RUNS = 5;
export const OUTCOMES = ["admitted", "refused", "error", "timeout", "killed"];
export const W2 = "W2";

/** What the workload contract expects of a run: a W7 negative control is refused, everything else is admitted. */
export const expectedOutcome = (workload) =>
  String(workload).startsWith("W7-") ? "refused" : "admitted";

/** Every workload the protocol runs, in the contract's terms: the generated ones (recorded hashes) and W2 (captured). */
export function protocolWorkloads(recorded) {
  return [...recorded.workloads.map((w) => w.name), W2];
}

/** How many distinct cold runs each workload of the protocol needs. */
export const runsRequired = (workload) =>
  MUST_HAVE_RUNS.includes(workload) ? REQUIRED_COLD_RUNS : 1;

/** The protocol's attempts in the page's order (src/fixture/data-harness/profile-capture.ts `protocolPlan`): W2 after W1 when named. */
export function protocolOrder(recorded, withW2) {
  const names = recorded.workloads.map((w) => w.name);
  const order = withW2
    ? names.flatMap((name) => (name === "W1" ? [name, W2] : [name]))
    : names;
  return order.flatMap((name) =>
    Array.from({ length: runsRequired(name) }, (_, i) => ({
      name,
      run: i + 1,
    })),
  );
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const nonNeg = (x) => isNum(x) && x >= 0;
const count = (x) => Number.isInteger(x) && x >= 0;
const nullOr = (test) => (x) => x === null || test(x);
/** What one run must carry for its path and outcome; returns the problems (each names the field). */
function payloadProblems(run, bytesOf) {
  const problems = [];
  for (const key of ["bytes", "request_count"])
    if (!count(run[key])) problems.push(`${key} is not a count`);
  if (!nonNeg(run.elapsed_ms)) problems.push("elapsed_ms is missing");
  if (typeof run.detail !== "string") problems.push("detail is missing");
  if (typeof run.at !== "string") problems.push("at is missing");
  if (typeof run.sha256_verified !== "boolean")
    problems.push("sha256_verified is not recorded");
  for (const key of [
    "scan_ms",
    "commit_ms",
    "heap_baseline_bytes",
    "heap_peak_bytes",
    "heap_after_bytes",
  ])
    if (!(key in run) || !nullOr(nonNeg)(run[key]))
      problems.push(`${key} is neither a figure nor an explicit null`);
  for (const [key, test] of [
    ["limit", nullOr(count)],
    ["changes_written", nullOr(count)],
    ["cursor_after", nullOr((x) => typeof x === "string")],
  ])
    if (!(key in run) || !test(run[key]))
      problems.push(`${key} is neither a value nor an explicit null`);
  const processingOnly = String(run.workload).startsWith("W5-");
  if (run.outcome === "killed") {
    if (run.elapsed_ms !== 0 || run.request_count !== 0 || run.sha256_verified)
      problems.push(
        "a killed attempt cannot have measured or verified anything",
      );
  } else if (processingOnly) {
    if (run.request_count !== 0 || run.commit_ms !== null || run.limit !== null)
      problems.push("W5 is the processing path only: no request, no commit");
    if (
      run.outcome === "admitted" &&
      (!nonNeg(run.scan_ms) || !count(run.changes_written))
    )
      problems.push(
        "an admitted W5 run without its scan time and decoded count",
      );
  } else if (run.outcome === "admitted" || run.outcome === "refused") {
    if (!(run.request_count >= 1) || !count(run.limit))
      problems.push(
        `an ${run.outcome} engine run without its request and limit`,
      );
    if (
      run.outcome === "admitted" &&
      (!nonNeg(run.scan_ms) ||
        !nonNeg(run.commit_ms) ||
        !count(run.changes_written))
    )
      problems.push(
        "an admitted engine run without its scan, commit and written count",
      );
  }
  if (run.sha256_verified === true && bytesOf !== null && run.bytes !== bytesOf)
    problems.push(`${run.bytes} bytes, not the workload's ${bytesOf}`);
  if (
    run.workload === W2 &&
    run.sha256_verified === true &&
    typeof run.source !== "string"
  )
    problems.push("a verified W2 run does not name the capture file it read");
  return problems;
}

/**
 * Checks one results file. `recorded` is scripts/lib/profile-workload-hashes.json; `w2Hashes` the hand-over's CERTIFIED W2 hashes (a Set)
 * or null; `w2Bytes` the certified captures' bytes by SHA-256 (schema 4: an admitted W2 run's effects are derived from them, so a W2
 * admission cannot be accepted without them; `w2EffectsExempt`, a reason, when the caller has found the capture itself invalid, which then
 * stays that capture's finding); `w2Uncertified` the listed hashes that were not certified, with why (revision 4); `w2Expected`, when given, is the one capture
 * this protocol must have run (the desktop stage knows which engine's capture it picked).
 *
 * Returns `errors` (the file is malformed, inconsistent or names other bytes), `failed_controls` (a W7 control that was not refused),
 * `warnings`, `incomplete` (a required run is absent), the valid-workload `failures` (facts) and the distinct runs per workload.
 */
export function checkDeviceResults(
  data,
  {
    recorded,
    w2Hashes = null,
    w2Expected = null,
    w2Uncertified = new Map(),
    w2Bytes = new Map(),
    w2EffectsExempt = null,
  },
) {
  const errors = [];
  const warnings = [];
  const failedControls = [];
  const failures = [];
  const hashOf = new Map(recorded.workloads.map((w) => [w.name, w.sha256]));
  if (typeof data !== "object" || data === null)
    return {
      errors: ["the results are not a JSON object"],
      warnings,
      failed_controls: failedControls,
      failures,
      incomplete: true,
      runs: {},
    };
  if (data.schema !== DEVICE_SCHEMA)
    errors.push(
      `schema must be ${DEVICE_SCHEMA} (schema ${data.schema} is a historical record: one protocol identity, distinct runs and corroborated engine outcomes are required)`,
    );
  if (typeof data.protocol_id !== "string" || !data.protocol_id.trim())
    errors.push(
      "protocol_id is missing: the runs cannot be tied to one protocol",
    );
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
  const w2sha256 = data.w2sha256 ?? null;
  if (w2sha256 !== null && !/^[0-9a-f]{64}$/.test(String(w2sha256)))
    errors.push("w2sha256 is not a SHA-256");
  if (w2Expected && w2sha256 !== w2Expected)
    errors.push(
      `the protocol ran capture ${String(w2sha256).slice(0, 12)}, not the expected ${w2Expected.slice(0, 12)}`,
    );
  if (!Array.isArray(data.runs) || data.runs.length === 0)
    errors.push("runs is empty");
  // The lifecycle: a protocol's file, its planned count the plan's, its attempts the plan's in order, its terminal state their count's.
  const plan = protocolOrder(recorded, w2sha256 !== null);
  const held = Array.isArray(data.runs) ? data.runs.length : 0;
  if (data.kind !== "protocol")
    errors.push(
      `kind ${data.kind}: only a protocol's results are a results file (a manual collection is not)`,
    );
  if (data.planned_runs !== plan.length)
    errors.push(
      `planned_runs ${data.planned_runs} is not the protocol's ${plan.length} attempts`,
    );
  if (held > plan.length)
    errors.push(`${held} runs for a plan of ${plan.length}`);
  if (data.terminal === "complete" && held !== plan.length)
    errors.push(`terminal "complete" with ${held} of ${plan.length} attempts`);
  else if (data.terminal === null && held === plan.length)
    errors.push(
      "every attempt is held but the protocol is not marked complete",
    );
  else if (data.terminal === "error")
    warnings.push(
      `the protocol stopped with an error: ${String(data.error).slice(0, 160)}`,
    );
  else if (
    !(
      data.terminal === null ||
      data.terminal === "complete" ||
      data.terminal === "error"
    )
  )
    errors.push(`terminal ${data.terminal} is not a lifecycle state`);
  if (
    !Array.isArray(data.takeovers) ||
    !data.takeovers.every((t) =>
      ["at", "from", "to"].every((k) => typeof t?.[k] === "string"),
    )
  )
    errors.push("the take-over record is missing or malformed");
  const bytesOf = new Map(recorded.workloads.map((w) => [w.name, w.bytes]));

  const seen = new Map();
  const distinct = new Map();
  for (const [i, run] of (Array.isArray(data.runs)
    ? data.runs
    : []
  ).entries()) {
    const where = `runs[${i}] (${run?.workload} run ${run?.run})`;
    if (typeof run !== "object" || run === null) {
      errors.push(`${where}: not an object`);
      continue;
    }
    const isW2 = run.workload === W2;
    if (!isW2 && !hashOf.has(run.workload)) {
      errors.push(`${where}: unknown workload`);
      continue;
    }
    if (run.protocol_id !== data.protocol_id)
      errors.push(
        `${where}: protocol ${run.protocol_id} is not this file's ${data.protocol_id} (runs of different protocols cannot be counted together)`,
      );
    if (
      !Number.isInteger(run.run) ||
      run.run < 1 ||
      run.run > runsRequired(run.workload)
    )
      errors.push(
        `${where}: run number ${run.run} is outside 1..${runsRequired(run.workload)}`,
      );
    const key = `${run.workload}#${run.run}`;
    if (seen.has(key)) {
      errors.push(
        `${where}: a duplicate of runs[${seen.get(key)}]; one attempt counts once`,
      );
      continue;
    }
    seen.set(key, i);
    // The identity of the bytes: a W2 run is of the capture the protocol named (killed runs too: that identity is durable before the run
    // starts); a generated workload of its recorded hash. Only a run that got as far as reading its bytes can have verified them.
    if (isW2) {
      if (!w2Hashes)
        errors.push(
          `${where}: a W2 run cannot be verified without --w2-hashes (the hand-over's fixtures/W2-hashes.json)`,
        );
      else if (w2Uncertified.has(run.sha256))
        errors.push(
          `${where}: sha256 ${String(run.sha256).slice(0, 12)} is listed, but ${w2Uncertified.get(run.sha256)}`,
        );
      else if (!w2Hashes.has(run.sha256))
        errors.push(
          `${where}: sha256 ${String(run.sha256).slice(0, 12)} is not a captured W2 of the hand-over`,
        );
      if (w2sha256 !== null && run.sha256 !== w2sha256)
        errors.push(
          `${where}: sha256 ${String(run.sha256).slice(0, 12)} is not the protocol's capture ${String(w2sha256).slice(0, 12)}`,
        );
    } else if (run.sha256 !== hashOf.get(run.workload))
      errors.push(
        `${where}: sha256 ${String(run.sha256).slice(0, 12)} is not the recorded ${hashOf.get(run.workload).slice(0, 12)}`,
      );
    if (run.outcome !== "killed" && run.sha256_verified !== true)
      errors.push(`${where}: the page did not verify the fixture's hash`);
    if (run.cold !== true) errors.push(`${where}: not a cold run`);
    if (!OUTCOMES.includes(run.outcome))
      errors.push(`${where}: outcome ${run.outcome} is not one of ${OUTCOMES}`);
    const expected = expectedOutcome(run.workload);
    if (run.expected !== expected)
      errors.push(
        `${where}: declares expected ${run.expected}; the workload contract expects ${expected}`,
      );
    if (expected === "refused") {
      if (run.outcome === "admitted")
        failedControls.push(`${where}: a NEGATIVE control was admitted`);
      else if (run.outcome !== "refused")
        failedControls.push(
          `${where}: the negative control was not refused (outcome ${run.outcome}): recorded, but it does not fulfil the control`,
        );
    } else if (run.outcome !== "admitted") {
      failures.push({
        workload: run.workload,
        run: run.run,
        outcome: run.outcome,
        detail: String(run.detail ?? "").slice(0, 160),
      });
      warnings.push(`${where}: outcome ${run.outcome} (${run.detail})`);
    }
    if (typeof run.user_agent !== "string")
      errors.push(`${where}: user_agent is missing`);
    // The effects the run's served bytes leave: the regenerated workload's, or the certified capture's (`w2Bytes`, by SHA-256).
    const expectedEffects = isW2
      ? w2Bytes.has(run.sha256)
        ? expectedEffectsOfBody(w2Bytes.get(run.sha256))
        : null
      : effectsOfWorkload(run.workload);
    for (const problem of [
      ...payloadProblems(run, bytesOf.get(run.workload) ?? null),
      ...deviceRunOutcomeProblems(run, {
        expectedEffects,
        // A negative control's admission fails its control whatever it wrote (counted above): its effects are not the evidence.
        effectsExempt:
          expected === "refused"
            ? "a negative control: an admission fails the control"
            : isW2
              ? w2EffectsExempt
              : null,
      }),
    ])
      errors.push(`${where}: ${problem}`);
    const planned = plan[i];
    if (planned && (planned.name !== run.workload || planned.run !== run.run))
      errors.push(
        `${where}: attempt ${i + 1} of the plan is ${planned.name} run ${planned.run}`,
      );
    distinct.set(run.workload, [
      ...(distinct.get(run.workload) ?? []),
      run.run,
    ]);
  }

  let incomplete = false;
  const workloads = protocolWorkloads(recorded);
  for (const name of workloads) {
    const n = new Set(distinct.get(name) ?? []).size;
    if (n < runsRequired(name)) {
      incomplete = true;
      warnings.push(
        n === 0
          ? `${name}: no run recorded`
          : `${name}: ${n} distinct cold run(s); ${runsRequired(name)} are required`,
      );
    }
  }
  return {
    errors,
    warnings,
    failed_controls: failedControls,
    failures,
    incomplete,
    runs: Object.fromEntries(
      [...distinct].map(([name, runs]) => [name, [...new Set(runs)].sort()]),
    ),
  };
}

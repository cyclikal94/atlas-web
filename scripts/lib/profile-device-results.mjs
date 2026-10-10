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

export const DEVICE_SCHEMA = 2;
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

/**
 * Checks one results file. `recorded` is scripts/lib/profile-workload-hashes.json; `w2Hashes` the hand-over's captured W2 hashes (a Set) or
 * null; `w2Expected`, when given, is the one capture this protocol must have run (the desktop stage knows which engine's capture it picked).
 *
 * Returns `errors` (the file is malformed, inconsistent or names other bytes), `failed_controls` (a W7 control that was not refused),
 * `warnings`, `incomplete` (a required run is absent), the valid-workload `failures` (facts) and the distinct runs per workload.
 */
export function checkDeviceResults(
  data,
  { recorded, w2Hashes = null, w2Expected = null },
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
      `schema must be ${DEVICE_SCHEMA} (schema ${data.schema} is a historical record: one protocol identity and distinct runs are required)`,
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
    if (typeof run.elapsed_ms !== "number" || !Number.isFinite(run.elapsed_ms))
      errors.push(`${where}: elapsed_ms is missing`);
    if (typeof run.user_agent !== "string")
      errors.push(`${where}: user_agent is missing`);
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

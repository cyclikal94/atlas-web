// The finite evidence contract of the desktop sync-profiling programme (WEB-09c revision 2; review findings R1 and R2, design assessment
// sections A, C and D). A desktop conclusion is drawn only from evidence this contract RESOLVES, never from a stage's exit status, a case
// that passed, a file that exists or a hand-over's own booleans.
//
// `requiredCells()` is the closed set of required observations, fixed BEFORE anything is read: every stage, case, engine, workload,
// condition, metric, cold run, control and capture the programme's writers produce today, with the sample counts those writers take (the
// plan's counts; nothing here is a new threshold). `resolveEvidence(dir)` resolves every cell against the artefacts actually in an
// evidence directory and returns one status per cell:
//
//   ok            present, well formed, its counts and raw samples agree, its window lies in its stage, and (where the figure depends on
//                 the machine's load) its window was ISOLATED (`clean` over its own stage's load samples)
//   unavailable   a declared capability alternative with its typed reason (no long-task observer; no JS heap signal outside Chromium)
//   missing       nothing was recorded for it
//   invalid       something was recorded but it is not the evidence the cell needs (short or duplicated distribution, raw samples that
//                 disagree with the summary, a value outside its window or stage, a malformed file, incomplete memory attribution, ...)
//   failed        a stage that did not finish with exit 0, a case that was not collected exactly once and passed
//   failed_control  a negative control (W7) that was not REFUSED: the attempt stays recorded, it does not fulfil the control
//   not_isolated  valid evidence whose collection window was not clean (contaminated, idle_foreign or unknown)
//
// `complete` holds only when every cell is `ok` or `unavailable`. Outcomes of valid workloads are FACTS: a W2 live time-out or a refused
// W1 is reported as a failure (H8) whatever else is missing; its absence is evidence only in a complete programme.
//
// The validator re-runs this resolution on the evidence the hand-over carries (`handoff/evidence/`) and refuses a hand-over whose results
// disagree. The qualification suite holds an independently written copy of the expected inventory, so dropping a requirement here fails.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDeviceResults,
  expectedOutcome,
  OUTCOMES,
  protocolWorkloads,
  runsRequired,
} from "./profile-device-results.mjs";
import {
  COLLECTION_LOG,
  ENGINES,
  PROGRAMME_STAGES,
  REQUIRED_CASES,
} from "./profile-evidence.mjs";
import { classifyWindow, SAMPLE_INTERVAL_MS } from "./profile-isolation.mjs";

export const CONTRACT_VERSION = 1;
export const CELL_STATUSES = [
  "ok",
  "unavailable",
  "missing",
  "invalid",
  "failed",
  "failed_control",
  "not_isolated",
];
const SATISFIED = new Set(["ok", "unavailable"]);

const here = dirname(fileURLToPath(import.meta.url));
export const RECORDED = JSON.parse(
  readFileSync(join(here, "profile-workload-hashes.json"), "utf8"),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---- the required set -----------------------------------------------------------------------------------------------------------------
export const P2_SHAPES = [
  ["ordinary-100", 300],
  ["ordinary-200", 300],
  ["ordinary-400", 300],
  ["ordinary-800", 300],
  ["dense-100", 60],
  ["dense-200", 40],
  ["dense-400", 25],
  ["dense-800-W1", 15],
];
export const DENSE_SIZES = {
  "dense-100": 100,
  "dense-200": 200,
  "dense-400": 400,
  "dense-800-W1": 800,
};
export const P11_VALID = ["W1", "W3", "W4", "W6"];
export const W7_CONTROLS = RECORDED.workloads
  .map((w) => w.name)
  .filter((n) => n.startsWith("W7-"));
export const SHELL = {
  builds: ["dist", "dist-fixture"],
  viewports: ["mobile", "desktop"],
  networks: ["fast-4g", "slow-4g"],
  runs: 3,
};
export const P6_CAUSES = {
  tab_closed_cleanly_mid_request: 40,
  tab_killed_mid_request_simulated: 100,
  slow_handling_injected: 50,
  failing_recording_injected: 50,
};
export const P6_CHROMIUM_ONLY = { tab_crashed_mid_request_chromium: 60 };
export const P7_CONDITIONS = [
  "no leader",
  "back-to-back leader, 5 ms apart (platform yield)",
];
export const P7_WAITS = [
  "ordinary request",
  "exposure (visible to lifted)",
  "atlas-auth writer (begin)",
];
export const P7_FREEZES = [100, 250, 500, 750, 1000, 1500, 2500];
export const P9_POLICIES = ["none", "macrotask", "scheduler_yield", "idle"];
export const P9_WAITS = ["ordinary request", "exposure", "atlas-auth writer"];
export const P13_CONDITIONS = [
  "none (control)",
  "leader pages",
  "stop-record hints (synthetic)",
  "drafts and receipts",
];

const CASE = {
  p2: "P-2:",
  p3: "P-3:",
  p5: "P-5:",
  p5dense: "P-5 (dense):",
  p11: "P-11:",
  pq: "P-Q:",
  pq2: "P-Q2:",
  device: "P-11 (device page):",
  p78: "P-7 and P-8:",
  frozen: "P-7: a frozen owner",
  production: "P-7: the PRODUCTION lock wait",
  p6: "P-6:",
  p9: "P-9:",
  p13: "P-13:",
  p4sync: "P-4: what the page does around ONE sync page",
  p4draft: "P-4: what the page does around ONE draft submission",
  p10: "P-10:",
  w2: "W2:",
  w2limits: "W2-limits:",
};

/**
 * The closed set of required observations of a complete desktop programme. Every id is unique and names its item, its dimensions and
 * its engine. Nothing in an evidence directory can add to or remove from this set.
 */
export function requiredCells(engines = ENGINES) {
  const cells = [];
  const add = (cell) => cells.push(cell);
  for (const stage of PROGRAMME_STAGES)
    add({ id: `stage:${stage}`, item: "stages", stage, kind: "stage" });
  for (const [stage, prefixes] of Object.entries(REQUIRED_CASES))
    for (const engine of engines)
      for (const prefix of prefixes)
        add({
          id: `case:${prefix}[${engine}]`,
          item: "cases",
          stage,
          engine,
          kind: "case",
          prefix,
        });
  // P-1: both builds' budget measurements and the production composition (sizes: not load dependent).
  for (const build of SHELL.builds)
    add({
      id: `P-1:budget:${build}`,
      item: "P-1",
      stage: "bundle",
      kind: "budget",
      build,
    });
  add({
    id: "P-1:composition",
    item: "P-1",
    stage: "bundle",
    kind: "composition",
  });
  // P-1S: Chromium only, both builds x two viewports x two networks x three cold runs, every run in its own window.
  for (const build of SHELL.builds)
    for (const viewport of SHELL.viewports)
      for (const network of SHELL.networks)
        for (let run = 1; run <= SHELL.runs; run += 1)
          add({
            id: `P-1S:${build}:${viewport}:${network}:run-${run}[chromium]`,
            item: "P-1S",
            stage: "shell",
            engine: "chromium",
            kind: "shell-run",
            build,
            viewport,
            network,
            run,
          });
  for (const engine of engines) {
    const m = (item, stage, name, n, caseKey, extra = {}) =>
      add({
        id: `${name}[${engine}]`,
        item,
        stage,
        engine,
        kind: "measurement",
        name,
        n,
        case: CASE[caseKey],
        ...extra,
      });
    const v = (item, stage, name, caseKey, check, extra = {}) =>
      add({
        id: `${name}[${engine}]`,
        item,
        stage,
        engine,
        kind: "value",
        name,
        case: CASE[caseKey],
        check,
        ...extra,
      });
    // P-2
    for (const [shape, n] of P2_SHAPES) {
      for (const metric of ["wall_ms", "scan_ms", "commit_ms"])
        m("P-2", "fixture", `P-2 ${shape} ${metric}`, n, "p2");
      m("P-2", "fixture", `P-2 ${shape} long_task_ms_per_page`, n, "p2", {
        capability: "longtask",
      });
    }
    add({
      id: `P-2:trace[${engine}]`,
      item: "P-2",
      stage: "fixture",
      engine,
      kind: "text-file",
      path: `raw/P-2.trace.${engine}.txt`,
    });
    // P-3
    for (const kind of ["draft", "fence", "form_recovery"])
      for (const durability of ["strict", "default"])
        m("P-3", "fixture", `P-3 ${kind} ${durability} write_ms`, 300, "p3");
    // P-5 and P-5 dense
    m("P-5", "fixture", "P-5 drain_200_ms", 20, "p5");
    m("P-5", "fixture", "P-5 per_draft_ms", 20, "p5", {
      derived: { from: "P-5 drain_200_ms", divide: 200 },
    });
    v("P-5", "fixture", "P-5 maxInFlight_2_and_3", "p5", checkDeclaredOmission);
    m("P-5", "fixture", "P-5 dense drain_201_ms", 20, "p5dense");
    m("P-5", "fixture", "P-5 dense per_draft_ms", 20, "p5dense", {
      derived: { from: "P-5 dense drain_201_ms", divide: 201 },
    });
    // P-11: five cold runs of each valid workload, every W7 control once, and their summaries
    for (const workload of P11_VALID) {
      for (let run = 1; run <= 5; run += 1) {
        add(outcomeCell("P-11", "fixture", engine, "p11", workload, run));
        add(memoryCell("P-11", "fixture", engine, "p11", workload, run));
      }
    }
    for (const workload of W7_CONTROLS)
      add(outcomeCell("P-11", "fixture", engine, "p11", workload, 1));
    for (const workload of [...P11_VALID, ...W7_CONTROLS]) {
      const n = P11_VALID.includes(workload) ? 5 : 1;
      m("P-11", "fixture", `P-11 ${workload} elapsed_ms`, n, "p11");
      m("P-11", "fixture", `P-11 ${workload} rss_peak_kib`, n, "p11");
      m("P-11", "fixture", `P-11 ${workload} heap_peak_bytes`, n, "p11", {
        capability: "heap",
      });
    }
    // P-Q, P-Q2
    v("P-Q", "fixture", "P-Q footprints", "pq", checkFootprints, {
      isolation: true,
    });
    v("P-Q2", "fixture", "P-Q2 quota reserve inputs", "pq2", checkQuotaInputs, {
      isolation: true,
    });
    // P-6 to P-9, P-13 (contention)
    for (const [cause, n] of Object.entries({
      ...P6_CAUSES,
      ...(engine === "chromium" ? P6_CHROMIUM_ONLY : {}),
    }))
      add({
        id: `P-6 ${cause}[${engine}]`,
        item: "P-6",
        stage: "contention",
        engine,
        kind: "p6-cause",
        name: `P-6 ${cause}`,
        cause,
        n,
        case: CASE.p6,
        isolation: true,
      });
    for (const condition of P7_CONDITIONS) {
      for (const wait of P7_WAITS)
        m("P-7", "contention", `P-7 ${wait}, ${condition}`, 100, "p78");
      m(
        "P-7",
        "contention",
        `P-7 closing write (logout initiation), ${condition}`,
        30,
        "p78",
      );
    }
    add({
      id: `P-8 retirements[${engine}]`,
      item: "P-8",
      stage: "contention",
      engine,
      kind: "json-file",
      path: `contention/retirements.${engine}.json`,
      check: checkRetirements,
      case: CASE.p78,
    });
    m(
      "P-7",
      "contention",
      "P-7 frozen owner: writer wait (scaled 1 s)",
      105,
      "frozen",
    );
    add({
      id: `P-7 frozen owner rows[${engine}]`,
      item: "P-7",
      stage: "contention",
      engine,
      kind: "json-file",
      path: `contention/frozen-owner.${engine}.json`,
      check: checkFrozenOwner,
      case: CASE.frozen,
    });
    add({
      id: `P-7 production lock wait[${engine}]`,
      item: "P-7",
      stage: "contention",
      engine,
      kind: "json-file",
      path: `contention/frozen-owner-production-wait.${engine}.json`,
      check: checkProductionWait,
      case: CASE.production,
      isolation: true,
    });
    for (const policy of P9_POLICIES) {
      for (const wait of P9_WAITS)
        m("P-9", "contention", `P-9 ${policy}: ${wait} wait`, 50, "p9");
      m(
        "P-9",
        "contention",
        `P-9 ${policy}: catch-up throughput (pages/s, 200 pages, no probe)`,
        5,
        "p9",
      );
    }
    add({
      id: `P-9 engine support[${engine}]`,
      item: "P-9",
      stage: "contention",
      engine,
      kind: "json-file",
      path: `contention/yield-policy.${engine}.json`,
      check: checkYieldPolicy,
      case: CASE.p9,
    });
    for (const condition of P13_CONDITIONS)
      add({
        id: `P-13 reads, ${condition}[${engine}]`,
        item: "P-13",
        stage: "contention",
        engine,
        kind: "p13-reads",
        condition,
        case: CASE.p13,
      });
    for (const followers of [0, 1, 2])
      m(
        "P-13",
        "contention",
        `P-13 leader catch-up throughput (pages/s, 200 pages), ${followers} follower(s)`,
        3,
        "p13",
      );
    // P-4, P-10 (integration)
    for (const segment of [
      "pre_issue_ms",
      "request_ms",
      "post_response_ms",
      "total_ms",
    ])
      m("P-4", "integration", `P-4 sync page ${segment}`, 300, "p4sync");
    for (const segment of [
      "enqueue_ms",
      "claim_ms",
      "stamping_ms",
      "request_ms",
      "record_ms",
      "total_ms",
    ])
      m("P-4", "integration", `P-4 draft ${segment}`, 300, "p4draft");
    m(
      "P-10",
      "integration",
      "P-10 sync page request_ms (unthrottled loopback)",
      300,
      "p4sync",
      {
        same_samples_as: "P-4 sync page request_ms",
      },
    );
    m(
      "P-10",
      "integration",
      "P-10 draft request_ms (unthrottled loopback)",
      300,
      "p4draft",
      {
        same_samples_as: "P-4 draft request_ms",
      },
    );
    m(
      "P-10",
      "integration",
      "P-10 sync page duration_ms (proxy delay 250 ms)",
      100,
      "p10",
    );
    // P-W2: the released backend's dense batch: six captures, the live application, five cold runs, the bound and the limits probe
    v("P-W2", "integration", "backend", "w2", checkBackend);
    for (const limit of [1, 80])
      add({
        id: `P-W2 capture limit ${limit}[${engine}]`,
        item: "P-W2",
        stage: "integration",
        engine,
        kind: "w2-capture",
        limit,
        case: CASE.w2,
      });
    add(outcomeCell("P-W2", "integration", engine, "w2-live", "W2", 0));
    add(memoryCell("P-W2", "integration", engine, "w2-live", "W2", 0));
    for (let run = 1; run <= 5; run += 1) {
      add(outcomeCell("P-W2", "integration", engine, "w2-cold", "W2", run));
      add(memoryCell("P-W2", "integration", engine, "w2-cold", "W2", run));
    }
    m("P-W2", "integration", "P-W2 elapsed_ms", 5, "w2");
    m("P-W2", "integration", "P-W2 rss_peak_kib", 5, "w2");
    m("P-W2", "integration", "P-W2 heap_peak_bytes", 5, "w2", {
      capability: "heap",
    });
    v("P-W2", "integration", "P-W2 observed bound", "w2", checkBound);
    v("W2-limits", "integration", "W2-limits", "w2limits", checkLimits);
    // The device page's protocol on this engine: 39 distinct runs over 19 workloads, one protocol, this engine's capture
    add({
      id: `device page results[${engine}]`,
      item: "device",
      stage: "device",
      engine,
      kind: "device-file",
      case: CASE.device,
      isolation: true,
    });
    for (const workload of protocolWorkloads(RECORDED))
      for (let run = 1; run <= runsRequired(workload); run += 1)
        add({
          id: `device ${workload} run ${run}[${engine}]`,
          item: "device",
          stage: "device",
          engine,
          kind: "device-run",
          workload,
          run,
          control: expectedOutcome(workload) === "refused",
        });
  }
  return cells;
}

function outcomeCell(item, stage, engine, source, workload, run) {
  const control = expectedOutcome(workload) === "refused";
  const what = source === "w2-live" ? "live application" : `cold run ${run}`;
  return {
    id: `${item} ${workload} ${control ? "control" : what}[${engine}]`,
    item,
    stage,
    engine,
    kind: "outcome",
    source,
    workload,
    run,
    control,
  };
}
function memoryCell(item, stage, engine, source, workload, run) {
  const what = source === "w2-live" ? "live application" : `cold run ${run}`;
  return {
    id: `${item} ${workload} memory, ${what}[${engine}]`,
    item,
    stage,
    engine,
    kind: "memory",
    source,
    workload,
    run,
  };
}

// ---- value and file checks: each returns the problems it found (an empty list is a pass) ----------------------------------------------------
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x) => x === null || isNum(x);
function checkDeclaredOmission(value) {
  return value.status === "not_run" &&
    typeof value.reason === "string" &&
    value.reason.trim()
    ? []
    : [
        "the declared omission (D-18 fixes maxInFlight at 1) has no not_run status and reason",
      ];
}
function checkFootprints(value, cell) {
  const problems = [];
  for (const key of [
    "baseline",
    "empty_account_database",
    "with_200_drafts",
    "one_draft_with_1_mib_payload",
    "atlas_auth_steady",
    "atlas_auth_100_fences_200_leases",
  ]) {
    const f = value[key];
    if (typeof f !== "object" || f === null) {
      problems.push(`${key} is missing`);
      continue;
    }
    for (const field of ["usage", "quota", "indexeddb"])
      if (!(field in f) || !isNumOrNull(f[field]))
        problems.push(`${key}.${field} is not a number or an explicit null`);
    if (cell.engine === "chromium" && !isNum(f.indexeddb))
      problems.push(`${key}.indexeddb: Chromium's exact CDP figure is missing`);
  }
  if (typeof value.note !== "string")
    problems.push("the estimate method is not stated");
  return problems;
}
function checkQuotaInputs(value) {
  const problems = [];
  const burst = value.atlas_auth_burst ?? {};
  if (burst.pages !== 3 || burst.requests_per_page !== 20)
    problems.push("the burst is not three pages of twenty stamped requests");
  if (
    !Number.isInteger(burst.held_at_once) ||
    burst.held_at_once < 1 ||
    burst.held_at_once > 60
  )
    problems.push("held_at_once (the requests out together) is not recorded");
  if (!Array.isArray(burst.outcomes) || burst.outcomes.length !== 60)
    problems.push(
      `${burst.outcomes?.length ?? 0} of 60 request outcomes recorded`,
    );
  const rows = value.estimate_granularity?.rows;
  if (!Array.isArray(rows) || rows.length !== 15)
    problems.push(`${rows?.length ?? 0} of 15 estimate-ladder writes recorded`);
  const ledger = value.ledger ?? {};
  const verdicts = Object.values(ledger.verdicts ?? {}).reduce(
    (n, x) => n + x,
    0,
  );
  if (
    ledger.reservations !== 100 ||
    ledger.bytes_each !== 1024 ||
    verdicts !== 100
  )
    problems.push(
      `the ledger holds ${verdicts} of 100 reservation verdicts of 1,024 bytes`,
    );
  if (value.quota_reserve_bytes_in_use !== 8 * 1024 * 1024)
    problems.push("the reserve in use (8 MiB) is not recorded");
  return problems;
}
function checkBackend(value) {
  return value.health?.status === 200
    ? []
    : [`the backend's /health answered ${value.health?.status}`];
}
function checkBound(value) {
  const problems = [];
  if (!isNum(value.revoke?.status))
    problems.push("the bound write's answer is not recorded");
  if (typeof value.delivered !== "object" || value.delivered === null)
    problems.push("what the server then delivered is not recorded");
  return problems;
}
function checkLimits(value) {
  return value.status === "measured" &&
    typeof value.probe === "object" &&
    value.probe !== null
    ? []
    : ["the limits probe is not recorded"];
}
function checkRetirements(file) {
  return Array.isArray(file.conditions) &&
    file.conditions.length === P7_CONDITIONS.length
    ? []
    : [
        `${file.conditions?.length ?? 0} of ${P7_CONDITIONS.length} retirement conditions`,
      ];
}
function checkFrozenOwner(file) {
  const problems = [];
  const rows = Array.isArray(file.rows) ? file.rows : [];
  for (const freeze of P7_FREEZES) {
    const n = rows.filter((r) => r.freeze_ms === freeze).length;
    if (n !== 15) problems.push(`freeze ${freeze} ms: ${n} of 15 samples`);
  }
  if (rows.length !== P7_FREEZES.length * 15)
    problems.push(`${rows.length} of 105 rows`);
  if (file.scaled_lock_wait_ms !== 1000)
    problems.push("the scaled lock wait is not 1 s");
  return problems;
}
function checkProductionWait(file) {
  const problems = [];
  if (file.lock_wait_ms !== 20_000 || file.freeze_ms !== 23_000)
    problems.push("not the production 20 s wait against a 23 s freeze");
  const rows = Array.isArray(file.rows) ? file.rows : [];
  if (rows.length !== 2)
    problems.push(`${rows.length} of 2 production-wait runs`);
  for (const [i, row] of rows.entries())
    if (row.outcome !== "lock_timeout" || !(row.waited_ms >= 19_500))
      problems.push(
        `run ${i + 1}: ${row.outcome} after ${row.waited_ms} ms (the writer must give up at the bound, never earlier)`,
      );
  return problems;
}
function checkYieldPolicy(file) {
  const problems = [];
  if (typeof file.engine_support !== "object" || file.engine_support === null)
    problems.push("the engine's yield support is not recorded");
  const policies = (file.rows ?? []).map((r) => r.policy);
  if (JSON.stringify(policies) !== JSON.stringify(P9_POLICIES))
    problems.push(`policies ${policies.join(", ")}`);
  return problems;
}

// ---- reading an evidence directory ---------------------------------------------------------------------------------------------------------
function readJsonl(file) {
  const rows = [];
  const errors = [];
  if (!existsSync(file)) return { rows, errors, present: false };
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      rows.push({ ...JSON.parse(line), __line: i });
    } catch (error) {
      errors.push(`line ${i + 1}: ${error.message}`);
    }
  }
  return { rows, errors, present: true };
}

/** Everything a resolution reads, read once. Parse failures are kept as such, never turned into an empty collection. */
export function loadEvidence(dir) {
  const json = new Map();
  const readJson = (rel) => {
    if (json.has(rel)) return json.get(rel);
    const file = join(dir, rel);
    let entry;
    if (!existsSync(file)) entry = { present: false };
    else
      try {
        const bytes = readFileSync(file);
        entry = {
          present: true,
          value: JSON.parse(bytes.toString("utf8")),
          sha256: sha256(bytes),
        };
      } catch (error) {
        entry = { present: true, error: error.message };
      }
    json.set(rel, entry);
    return entry;
  };
  const stages = {};
  const stageDir = join(dir, "stages");
  if (existsSync(stageDir))
    for (const f of readdirSync(stageDir).filter((x) => x.endsWith(".json"))) {
      const entry = readJson(`stages/${f}`);
      stages[f.replace(/\.json$/, "")] = entry;
    }
  const samples = new Map();
  const stageSamples = (stage) => {
    if (samples.has(stage)) return samples.get(stage);
    const read = readJsonl(join(dir, "isolation", `${stage}.jsonl`));
    const record = stages[stage]?.value;
    let problem = null;
    if (!read.present) problem = "no load samples were recorded for this stage";
    else if (read.errors.length)
      problem = `the load samples are malformed (${read.errors[0]})`;
    else {
      for (let i = 1; i < read.rows.length; i += 1)
        if (!(Date.parse(read.rows[i].at) >= Date.parse(read.rows[i - 1].at))) {
          problem = "the load samples' clock went backwards";
          break;
        }
      const sampler = record?.sampler;
      if (!problem && sampler?.ready !== true)
        problem =
          "the stage record does not show a sampler that was ready before its action";
      else if (!problem && sampler.final_sample !== true)
        problem = "the sampler did not write its final sample after the action";
    }
    const entry = {
      rows: read.rows,
      problem,
      interval: read.rows[0]?.interval_ms ?? SAMPLE_INTERVAL_MS,
    };
    samples.set(stage, entry);
    return entry;
  };
  return {
    dir,
    stages,
    measurements: readJsonl(join(dir, "measurements.jsonl")),
    values: readJsonl(join(dir, "values.jsonl")),
    collection: readJsonl(join(dir, COLLECTION_LOG)),
    readJson,
    stageSamples,
    exists: (rel) => existsSync(join(dir, rel)),
    bytes: (rel) => readFileSync(join(dir, rel)),
  };
}

// ---- resolution ----------------------------------------------------------------------------------------------------------------------------
const quantile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
  Number.NaN;
const fix3 = (x) => +Number(x).toFixed(3);
/** The summary `record()` writes for these samples (tests/e2e/profile-helpers.ts): what a row's figures must equal. */
export function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    min: fix3(sorted[0] ?? 0),
    p50: fix3(quantile(sorted, 0.5)),
    p95: fix3(quantile(sorted, 0.95)),
    p99: fix3(quantile(sorted, 0.99)),
    max: fix3(sorted.at(-1) ?? 0),
  };
}

const result = (cell, status, reasons = [], extra = {}) => ({
  id: cell.id,
  item: cell.item,
  stage: cell.stage,
  engine: cell.engine ?? null,
  status,
  reasons,
  ...extra,
});

function stageOf(ev, stage) {
  const entry = ev.stages[stage];
  return entry?.present && !entry.error ? entry.value : null;
}

/** The problems of a row's identity and collection window: its stage, its invocation, its case, and the window inside the stage. */
function windowProblems(ev, cell, row, window) {
  const problems = [];
  const stage = stageOf(ev, cell.stage);
  if (row && row.stage !== cell.stage)
    problems.push(`written by stage ${row.stage}, not ${cell.stage}`);
  if (row && stage && row.invocation !== stage.invocation)
    problems.push(
      `written by invocation ${row.invocation}, not the stage's ${stage.invocation}`,
    );
  if (!window?.from || !window.to) return [...problems, "no collection window"];
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!(from <= to))
    problems.push("the collection window is not a valid interval");
  if (cell.case && !String(window.test ?? "").startsWith(cell.case))
    problems.push(
      `collected by "${window.test}", not by the case "${cell.case}"`,
    );
  if (stage) {
    const begun = Date.parse(stage.action_started_at);
    const ended = Date.parse(stage.action_finished_at);
    if (!(from >= begun && to <= ended))
      problems.push("the collection window lies outside its stage's action");
  }
  return problems;
}

/** The isolation verdict of a window, over its OWN stage's samples only (another stage's samples never cover it). */
function isolationOf(ev, cell, window) {
  const samples = ev.stageSamples(cell.stage);
  if (samples.problem) return { verdict: "unknown", basis: samples.problem };
  return classifyWindow(
    samples.rows,
    Date.parse(window.from),
    Date.parse(window.to),
    samples.interval,
  );
}

function judged(cell, problems, ev, window, extra = {}) {
  if (problems.length) return result(cell, "invalid", problems, extra);
  if (
    !cell.isolation &&
    cell.kind !== "measurement" &&
    cell.kind !== "shell-run"
  )
    return result(cell, "ok", [], extra);
  const isolation = isolationOf(ev, cell, window);
  return result(
    cell,
    isolation.verdict === "clean" ? "ok" : "not_isolated",
    isolation.verdict === "clean"
      ? []
      : [`${isolation.verdict}: ${isolation.basis}`],
    { ...extra, isolation },
  );
}

const rowsNamed = (list, name, engine) =>
  list.rows.filter((r) => r.name === name && r.engine === engine);

function resolveMeasurement(ev, cell) {
  if (ev.measurements.errors.length)
    return result(cell, "invalid", [
      `measurements.jsonl is malformed (${ev.measurements.errors[0]})`,
    ]);
  const rows = rowsNamed(ev.measurements, cell.name, cell.engine);
  if (rows.length === 0) {
    if (cell.capability) {
      const declared = rowsNamed(ev.values, cell.name, cell.engine);
      if (
        declared.length === 1 &&
        declared[0].capability === "unavailable" &&
        typeof declared[0].reason === "string" &&
        (cell.capability !== "heap" || cell.engine !== "chromium") &&
        (cell.capability !== "longtask" || cell.engine !== "chromium")
      ) {
        const problems = windowProblems(
          ev,
          cell,
          declared[0],
          declared[0].collection,
        );
        return problems.length
          ? result(cell, "invalid", problems)
          : result(cell, "unavailable", [declared[0].reason]);
      }
    }
    return result(cell, "missing", ["no row"]);
  }
  if (rows.length > 1)
    return result(cell, "invalid", [
      `${rows.length} rows: a series is recorded once`,
    ]);
  const row = rows[0];
  const problems = windowProblems(ev, cell, row, row.collection);
  if (row.n !== cell.n)
    problems.push(`n ${row.n}; the programme takes ${cell.n}`);
  let samples = null;
  if (typeof row.raw !== "string") problems.push("no raw samples are linked");
  else if (!ev.exists(row.raw))
    problems.push(`the raw file ${row.raw} is missing`);
  else {
    const raw = ev.readJson(row.raw);
    if (raw.error || !Array.isArray(raw.value?.samples))
      problems.push(`the raw file ${row.raw} is malformed`);
    else {
      samples = raw.value.samples;
      if (raw.sha256 !== row.raw_sha256)
        problems.push(
          "the raw file's SHA-256 is not the one the summary recorded",
        );
      if (raw.value.name !== cell.name || raw.value.engine !== cell.engine)
        problems.push("the raw file is another series'");
      if (!samples.every(isNum))
        problems.push("a raw sample is not a finite number");
      else {
        const again = summarise(samples);
        for (const key of ["n", "min", "p50", "p95", "p99", "max"])
          if (row[key] !== again[key])
            problems.push(
              `${key} ${row[key]} does not follow from the raw samples (${again[key]})`,
            );
      }
    }
  }
  if (samples && cell.same_samples_as) {
    const other = rowsNamed(
      ev.measurements,
      cell.same_samples_as,
      cell.engine,
    )[0];
    const otherRaw =
      other && typeof other.raw === "string"
        ? ev.readJson(other.raw).value
        : null;
    if (JSON.stringify(otherRaw?.samples) !== JSON.stringify(samples))
      problems.push(
        `its samples are not the ones of "${cell.same_samples_as}"`,
      );
  }
  if (samples && cell.derived) {
    const from = rowsNamed(ev.measurements, cell.derived.from, cell.engine)[0];
    const base =
      from && typeof from.raw === "string"
        ? ev.readJson(from.raw).value?.samples
        : null;
    if (
      !Array.isArray(base) ||
      base.length !== samples.length ||
      base.some((x, i) => Math.abs(x / cell.derived.divide - samples[i]) > 1e-9)
    )
      problems.push(
        `its samples are not "${cell.derived.from}" / ${cell.derived.divide}`,
      );
  }
  return judged(cell, problems, ev, row.collection);
}

function resolveValue(ev, cell) {
  if (ev.values.errors.length)
    return result(cell, "invalid", [
      `values.jsonl is malformed (${ev.values.errors[0]})`,
    ]);
  const rows = rowsNamed(ev.values, cell.name, cell.engine);
  if (rows.length === 0) return result(cell, "missing", ["no row"]);
  if (rows.length > 1)
    return result(cell, "invalid", [
      `${rows.length} rows: a value is recorded once`,
    ]);
  const problems = [
    ...windowProblems(ev, cell, rows[0], rows[0].collection),
    ...cell.check(rows[0], cell),
  ];
  return judged(cell, problems, ev, rows[0].collection);
}

/** The window of a case in the collection log (for files a spec writes directly: their enclosing test). */
function caseWindow(ev, cell) {
  const found = ev.collection.rows.filter(
    (t) => t.engine === cell.engine && String(t.test).startsWith(cell.case),
  );
  return found.length === 1 ? found[0] : null;
}

/** A file a spec wrote directly: stamped with its stage and invocation, judged over its enclosing test's window. */
function resolveJsonFile(ev, cell) {
  const entry = ev.readJson(cell.path);
  if (!entry.present)
    return result(cell, "missing", [`${cell.path} is missing`]);
  if (entry.error)
    return result(cell, "invalid", [
      `${cell.path} is malformed: ${entry.error}`,
    ]);
  const window = caseWindow(ev, cell);
  const problems = [
    ...windowProblems(ev, cell, entry.value.evidence ?? {}, window),
    ...(cell.check ? cell.check(entry.value, cell) : []),
  ];
  if (!window)
    problems.push(`its case "${cell.case}" is not collected exactly once`);
  return judged(cell, problems, ev, window);
}

function resolveTextFile(ev, cell) {
  if (!ev.exists(cell.path))
    return result(cell, "missing", [`${cell.path} is missing`]);
  return ev.bytes(cell.path).length > 0
    ? result(cell, "ok")
    : result(cell, "invalid", [`${cell.path} is empty`]);
}

function resolveStage(ev, cell) {
  const entry = ev.stages[cell.stage];
  if (!entry) return result(cell, "missing", ["not recorded"]);
  if (entry.error)
    return result(cell, "invalid", [
      `the stage record is malformed: ${entry.error}`,
    ]);
  const r = entry.value;
  const problems = [];
  if (!r.finished_at)
    return result(cell, "failed", [
      "never finished (interrupted, or still running)",
    ]);
  if (r.exit_status !== 0)
    return result(cell, "failed", [`exit status ${r.exit_status}`]);
  if (r.sealed !== true) problems.push("the stage is not sealed");
  if (r.contract_version !== CONTRACT_VERSION)
    problems.push(
      `recorded under contract ${r.contract_version}, not ${CONTRACT_VERSION}`,
    );
  if (!r.action_started_at || !r.action_finished_at)
    problems.push("the stage's action interval is not recorded");
  if (r.debugging_samples)
    problems.push("a shortened DEBUGGING run is never evidence");
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

function resolveCase(ev, cell) {
  const found = ev.collection.rows.filter(
    (t) => t.engine === cell.engine && String(t.test).startsWith(cell.prefix),
  );
  if (ev.collection.errors.length)
    return result(cell, "invalid", [
      `the collection log is malformed (${ev.collection.errors[0]})`,
    ]);
  if (found.length === 0) return result(cell, "missing", ["not collected"]);
  if (found.length > 1)
    return result(cell, "failed", [`collected ${found.length} times`]);
  if (found[0].status !== "passed")
    return result(cell, "failed", [found[0].status]);
  const problems = windowProblems(ev, cell, found[0], found[0]);
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

function resolveBudget(ev, cell) {
  const delta = ev.readJson("bundle-delta.json");
  if (!delta.present)
    return result(cell, "missing", ["bundle-delta.json is missing"]);
  if (delta.error)
    return result(cell, "invalid", [`bundle-delta.json: ${delta.error}`]);
  const b = delta.value.budgets?.[cell.build];
  if (!b) return result(cell, "missing", [`no budget check of ${cell.build}`]);
  const problems = [];
  if (b.exit !== 0)
    return result(cell, "failed", [
      `the budget check of ${cell.build} exited ${b.exit}`,
    ]);
  const file = ev.readJson(b.file ?? "");
  if (!file.present || file.error)
    problems.push(`its profile ${b.file} is missing or malformed`);
  else {
    if (file.sha256 !== b.sha256)
      problems.push("its profile is not the one recorded");
    for (const key of ["initial_js_gzip", "css_gzip", "fonts"])
      if (!isNum(file.value.measured?.[key]))
        problems.push(`measured.${key} is missing`);
    if (Array.isArray(file.value.failures) && file.value.failures.length)
      problems.push(
        `the profile records failures: ${file.value.failures.join("; ")}`,
      );
  }
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

function resolveComposition(ev, cell) {
  const delta = ev.readJson("bundle-delta.json");
  if (!delta.present)
    return result(cell, "missing", ["bundle-delta.json is missing"]);
  if (delta.error) return result(cell, "invalid", [delta.error]);
  const d = delta.value;
  const problems = [];
  if (!Array.isArray(d.initial_chunks) || d.initial_chunks.length === 0)
    problems.push("the production initial chunk is not listed");
  if (typeof d.dexie_in_initial_chunk !== "boolean")
    problems.push("whether Dexie is in the initial chunk is not recorded");
  if (!isNum(d.initial_js_gzip))
    problems.push("the initial JS size is missing");
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

/** One cold run of the throttled shell boot: its figures, and its own window inside the shell stage. */
function resolveShellRun(ev, cell) {
  const entry = ev.readJson(`shell/${cell.build}.json`);
  if (!entry.present)
    return result(cell, "missing", [`shell/${cell.build}.json is missing`]);
  if (entry.error) return result(cell, "invalid", [entry.error]);
  const file = entry.value;
  const problems = [];
  if (file.build !== cell.build)
    problems.push(`the file measures ${file.build}`);
  const row = (file.results ?? []).filter(
    (r) => r.viewport === cell.viewport && r.network === cell.network,
  );
  if (row.length !== 1)
    return result(cell, row.length ? "invalid" : "missing", [
      `${row.length} rows for ${cell.viewport} ${cell.network}`,
    ]);
  const runs = (row[0].raw ?? []).filter((r) => r.run === cell.run);
  if (runs.length === 0) return result(cell, "missing", ["no such cold run"]);
  if (runs.length > 1)
    return result(cell, "invalid", ["the cold run is recorded twice"]);
  const run = runs[0];
  for (const key of ["lcp", "fcp", "cls", "transferBytes", "requests"])
    if (!isNum(run[key])) problems.push(`${key} is not a finite number`);
  // The cell's medians must follow from its runs once all three are there (a missing run is its own cell's finding).
  if (
    (row[0].raw ?? []).length === SHELL.runs &&
    row[0].raw.every((r) => isNum(r.lcp) && isNum(r.fcp))
  ) {
    const median = (xs) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    if (row[0].lcp_ms !== Math.round(median(row[0].raw.map((r) => r.lcp))))
      problems.push("the cell's median LCP does not follow from its runs");
    if (row[0].fcp_ms !== Math.round(median(row[0].raw.map((r) => r.fcp))))
      problems.push("the cell's median FCP does not follow from its runs");
  }
  const window = { test: null, from: run.from, to: run.to };
  problems.push(
    ...windowProblems(ev, { ...cell, case: null }, file.evidence ?? {}, window),
  );
  return judged(cell, problems, ev, window);
}

function resolveP6(ev, cell) {
  const value = resolveValue(ev, { ...cell, check: () => [] });
  if (value.status === "missing" || value.status === "invalid") return value;
  const row = rowsNamed(ev.values, cell.name, cell.engine)[0];
  const problems = [];
  if (row.n !== cell.n)
    problems.push(`${row.n} scenarios; the programme takes ${cell.n}`);
  const file = ev.readJson(`contention/unresolved-leases.${cell.engine}.json`);
  if (!file.present || file.error)
    problems.push("contention/unresolved-leases file is missing or malformed");
  else {
    const raw = (file.value.rows ?? []).filter(
      (r) => r.cause === cell.cause,
    ).length;
    if (raw !== row.n || file.value.by_cause?.[cell.cause]?.n !== row.n)
      problems.push(
        `the raw scenarios (${raw}) and the by-cause count (${file.value.by_cause?.[cell.cause]?.n}) do not agree with ${row.n}`,
      );
    for (const key of ["precondition_met", "saw_unresolved", "never_resolved"])
      if (file.value.by_cause?.[cell.cause]?.[key] !== row[key])
        problems.push(`${key} differs between the summary and the raw file`);
  }
  return judged(cell, problems, ev, row.collection);
}

function resolveP13(ev, cell) {
  const entry = ev.readJson(`contention/follower-reads.${cell.engine}.json`);
  if (!entry.present)
    return result(cell, "missing", ["follower-reads file is missing"]);
  if (entry.error) return result(cell, "invalid", [entry.error]);
  const conditions = (entry.value.conditions ?? []).filter(
    (c) => c.condition === cell.condition,
  );
  if (conditions.length !== 1)
    return result(cell, "missing", [
      `${conditions.length} records of the condition`,
    ]);
  const c = conditions[0];
  const problems = windowProblems(
    ev,
    cell,
    entry.value.evidence ?? {},
    caseWindow(ev, cell),
  );
  if (!isNum(c.hints) || !isNum(c.hints_followed_by_reads))
    problems.push("the hint and read counts are not recorded");
  if (cell.condition === "none (control)" && c.hints !== 0)
    problems.push(`the no-hint control heard ${c.hints} hint(s)`);
  if (
    ["leader pages", "stop-record hints (synthetic)"].includes(
      cell.condition,
    ) &&
    !(c.hints >= 200)
  )
    problems.push(`${c.hints} of 200 hints reached the follower`);
  const rows = rowsNamed(
    ev.measurements,
    `P-13 ${cell.condition}: follower read_ms per hint`,
    cell.engine,
  );
  if (problems.length) return result(cell, "invalid", problems);
  // Observations exist: their distribution must be recorded with exactly that many samples. None: the explicit zero, and no row.
  if (c.hints_followed_by_reads === 0)
    return rows.length === 0
      ? judged({ ...cell, isolation: true }, [], ev, caseWindow(ev, cell), {
          zero_reads: true,
        })
      : result(cell, "invalid", [
          "a read distribution is recorded for a condition with no reads",
        ]);
  return resolveMeasurement(ev, {
    ...cell,
    kind: "measurement",
    name: `P-13 ${cell.condition}: follower read_ms per hint`,
    n: c.hints_followed_by_reads,
  });
}

/** The cold-run file of an outcome or memory cell, and its row for the workload. */
function runsSource(ev, cell) {
  const path =
    cell.source === "p11"
      ? `memory/P-11.${cell.engine}.json`
      : `w2/P-W2.${cell.engine}.json`;
  const entry = ev.readJson(path);
  if (!entry.present) return { missing: `${path} is missing` };
  if (entry.error) return { invalid: `${path} is malformed: ${entry.error}` };
  const file = entry.value;
  const caseKey = cell.source === "p11" ? CASE.p11 : CASE.w2;
  const identity = windowProblems(
    ev,
    { ...cell, case: caseKey },
    file.evidence ?? {},
    caseWindow(ev, { ...cell, case: caseKey }),
  );
  if (cell.source === "w2-live")
    return file.live
      ? { run: file.live, identity }
      : { missing: "no live application recorded" };
  const rows = (file.rows ?? []).filter((r) => r.workload === cell.workload);
  if (rows.length !== 1)
    return { missing: `${rows.length} rows for ${cell.workload}` };
  const runs = rows[0].runs ?? [];
  const want =
    cell.source === "p11" && !P11_VALID.includes(cell.workload) ? 1 : 5;
  if (runs.length !== want)
    return {
      invalid: `${runs.length} cold runs recorded; the programme takes ${want}`,
      identity,
    };
  const run = runs[cell.run - 1];
  return run
    ? { run, identity }
    : { missing: `cold run ${cell.run} is missing` };
}

function resolveOutcome(ev, cell) {
  const source = runsSource(ev, cell);
  if (source.missing) return result(cell, "missing", [source.missing]);
  if (source.invalid) return result(cell, "invalid", [source.invalid]);
  const run = source.run;
  const problems = [...source.identity];
  if (!OUTCOMES.includes(run.outcome)) problems.push(`outcome ${run.outcome}`);
  if (!isNum(run.elapsed_ms)) problems.push("elapsed_ms is missing");
  if (run.outcome === "admitted" && cell.source !== "w2-live")
    for (const key of ["scan_ms", "commit_ms"])
      if (!isNum(run[key]))
        problems.push(`an admitted run without its engine ${key}`);
  if (problems.length) return result(cell, "invalid", problems);
  if (cell.control && run.outcome !== "refused")
    return result(
      cell,
      "failed_control",
      [
        `the negative control was ${run.outcome}: recorded, but it does not fulfil the control`,
      ],
      { outcome: run.outcome },
    );
  return result(cell, "ok", [], { outcome: run.outcome });
}

/** A run's browser memory: renderer-inclusive attribution, complete in every sample, at least one sample, and its declared scope. */
function resolveMemory(ev, cell) {
  const source = runsSource(ev, cell);
  if (source.missing) return result(cell, "missing", [source.missing]);
  if (source.invalid) return result(cell, "invalid", [source.invalid]);
  const rss = source.run.rss;
  const problems = [...source.identity];
  if (typeof rss !== "object" || rss === null)
    return result(cell, "invalid", [
      ...problems,
      "no attributed browser memory (rss) record: descendant-only figures are not browser memory",
    ]);
  if (!(rss.samples >= 1)) problems.push("no memory sample was taken");
  if (rss.failed_samples !== 0)
    problems.push(`${rss.failed_samples} memory sample(s) failed`);
  if (rss.complete !== true)
    problems.push(
      `the browser's processes were not all attributed (${(rss.errors ?? []).join("; ") || "incomplete"})`,
    );
  if (!isNum(rss.peak_kib) || !isNum(rss.baseline_kib))
    problems.push("the peak or baseline is missing");
  if (
    cell.engine === "webkit" &&
    rss.platform === "darwin" &&
    !(rss.webkit_hosts >= 1)
  )
    problems.push(
      "WebKit on macOS without its host's launchd services: the renderer is not counted",
    );
  if (cell.engine === "chromium" && !isNum(source.run.heap_peak_bytes))
    problems.push("Chromium's JS heap peak is missing");
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

function resolveCapture(ev, cell) {
  const path = `w2/W2-captured.${cell.engine}.limit-${cell.limit}.json`;
  if (!ev.exists(path)) return result(cell, "missing", [`${path} is missing`]);
  const value = rowsNamed(ev.values, "P-W2 capture", cell.engine);
  if (value.length !== 1)
    return result(cell, "invalid", [`${value.length} "P-W2 capture" rows`]);
  const recorded = value[0].captures?.[`limit_${cell.limit}`];
  const bytes = ev.bytes(path);
  const problems = windowProblems(ev, cell, value[0], value[0].collection);
  if (!recorded) problems.push("the capture is not recorded in its value row");
  else {
    if (recorded.sha256 !== sha256(bytes))
      problems.push("the capture's SHA-256 is not the recorded one");
    if (recorded.bytes !== bytes.length)
      problems.push("the capture's size is not the recorded one");
    if (!(recorded.changes >= 200))
      problems.push(`${recorded.changes} changes: not the dense batch`);
    if (
      !(recorded.batch_shapes ?? []).some(
        (b) => b.checklist_upserts >= 199 && b.person_ancestor,
      )
    )
      problems.push("no batch of 199 dense checklists with their person");
  }
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

/** The device page's results of one engine, checked as an operator's file is, against THIS engine's limit-1 capture. */
function deviceCheck(ev, engine) {
  const cacheKey = `device:${engine}`;
  if (ev[cacheKey]) return ev[cacheKey];
  const path = `device-page/results.${engine}.json`;
  const entry = ev.readJson(path);
  let out;
  if (!entry.present) out = { missing: `${path} is missing` };
  else if (entry.error)
    out = { invalid: [`${path} is malformed: ${entry.error}`] };
  else {
    const capture = `w2/W2-captured.${engine}.limit-1.json`;
    const w2 = ev.exists(capture) ? sha256(ev.bytes(capture)) : null;
    const checked = checkDeviceResults(entry.value, {
      recorded: RECORDED,
      w2Hashes: new Set(w2 ? [w2] : []),
      w2Expected: w2,
    });
    const binder = rowsNamed(ev.values, "P-11 device page", engine);
    const invalid = [...checked.errors];
    if (!w2) invalid.push("this engine's W2 capture is missing");
    if (binder.length !== 1)
      invalid.push(
        `${binder.length} "P-11 device page" rows bind the file to its run`,
      );
    else if (binder[0].results_sha256 !== entry.sha256)
      invalid.push("the results file is not the one its run recorded");
    out = { checked, data: entry.value, binder: binder[0], invalid };
  }
  ev[cacheKey] = out;
  return out;
}

function resolveDeviceFile(ev, cell) {
  const d = deviceCheck(ev, cell.engine);
  if (d.missing) return result(cell, "missing", [d.missing]);
  const problems = [...d.invalid];
  if (d.binder)
    problems.push(...windowProblems(ev, cell, d.binder, d.binder.collection));
  return judged(cell, problems, ev, d.binder?.collection ?? null);
}

function resolveDeviceRun(ev, cell) {
  const d = deviceCheck(ev, cell.engine);
  if (d.missing) return result(cell, "missing", [d.missing]);
  if (d.invalid.length)
    return result(cell, "invalid", [
      "the engine's results file is refused (see its file cell)",
    ]);
  const runs = (d.data.runs ?? []).filter(
    (r) => r.workload === cell.workload && r.run === cell.run,
  );
  if (runs.length === 0) return result(cell, "missing", ["no such run"]);
  const run = runs[0];
  if (cell.control && run.outcome !== "refused")
    return result(
      cell,
      "failed_control",
      [
        `the negative control was ${run.outcome}: recorded, but it does not fulfil the control`,
      ],
      { outcome: run.outcome },
    );
  return result(cell, "ok", [], { outcome: run.outcome });
}

const RESOLVERS = {
  stage: resolveStage,
  case: resolveCase,
  budget: resolveBudget,
  composition: resolveComposition,
  "shell-run": resolveShellRun,
  measurement: resolveMeasurement,
  value: resolveValue,
  "json-file": resolveJsonFile,
  "text-file": resolveTextFile,
  "p6-cause": resolveP6,
  "p13-reads": resolveP13,
  outcome: resolveOutcome,
  memory: resolveMemory,
  "w2-capture": resolveCapture,
  "device-file": resolveDeviceFile,
  "device-run": resolveDeviceRun,
};

/** The valid-workload outcomes that were not `admitted`: facts, whatever else is missing. */
function failuresOf(ev, cells) {
  const failures = [];
  for (const c of cells)
    if (
      c.kind === "outcome" &&
      !c.control &&
      c.status === "ok" &&
      c.outcome !== "admitted"
    )
      failures.push({
        engine: c.engine,
        workload: c.workload,
        path:
          c.source === "w2-live"
            ? "live application by the production engine"
            : "cold run",
        run: c.run,
        outcome: c.outcome,
      });
    else if (
      c.kind === "device-run" &&
      !c.control &&
      c.status === "ok" &&
      c.outcome !== "admitted"
    )
      failures.push({
        engine: c.engine,
        workload: c.workload,
        path: "device page (in-page transport)",
        run: c.run,
        outcome: c.outcome,
      });
  void ev;
  return failures;
}

/**
 * Resolves the whole contract against an evidence directory: one status per required cell, the lists by status, the derived desktop
 * conclusions and the item statuses. Unknown or duplicate evidence never substitutes for a required cell.
 */
export function resolveEvidence(dir, { engines = ENGINES } = {}) {
  const ev = loadEvidence(dir);
  const required = requiredCells(engines);
  const cells = required.map((cell) => {
    const resolved = RESOLVERS[cell.kind](ev, cell);
    return {
      ...resolved,
      kind: cell.kind,
      ...pick(cell, ["workload", "run", "control", "source"]),
    };
  });
  const ids = (status) =>
    cells.filter((c) => c.status === status).map((c) => c.id);
  const failures = failuresOf(ev, cells);
  const outcomesComplete = cells.every(
    (c) => SATISFIED.has(c.status) || c.status === "not_isolated",
  );
  const complete = cells.every((c) => SATISFIED.has(c.status));
  const items = {};
  for (const c of cells) {
    if (!items[c.item])
      items[c.item] = { cells: 0, satisfied: 0, absent: 0, not_isolated: 0 };
    const it = items[c.item];
    it.cells += 1;
    if (SATISFIED.has(c.status)) it.satisfied += 1;
    if (c.status === "missing") it.absent += 1;
    if (c.status === "not_isolated") it.not_isolated += 1;
  }
  for (const it of Object.values(items))
    it.status =
      it.satisfied === it.cells
        ? "measured"
        : it.absent === it.cells
          ? "not_run"
          : "partial";
  return {
    contract_version: CONTRACT_VERSION,
    cells,
    counts: Object.fromEntries(CELL_STATUSES.map((s) => [s, ids(s).length])),
    missing: ids("missing"),
    invalid: ids("invalid"),
    failed: ids("failed"),
    failed_controls: ids("failed_control"),
    not_isolated: ids("not_isolated"),
    unavailable: ids("unavailable"),
    outcomes_complete: outcomesComplete,
    complete,
    items,
    failures,
    derived: derive(cells, failures, outcomesComplete, complete),
  };
}

const pick = (o, keys) =>
  Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  );

/**
 * The desktop conclusions, from resolved cells only. H8: a valid-workload failure held is a fact (true); "none failed" (false) only in a
 * programme whose outcomes are complete; otherwise undetermined (null). H9: "the desktop engines do not need finer pagination" (false)
 * only from a COMPLETE (and isolated) programme with no failure; a failure is reported, but does not by itself establish that finer
 * pagination is the remedy, so H9 stays null. D(engine): the largest dense page whose commit series, and every smaller one's, resolved.
 */
export function derive(cells, failures, outcomesComplete, complete) {
  const failure = failures.length > 0 ? true : outcomesComplete ? false : null;
  const dense = {};
  for (const engine of ENGINES) {
    let largest = null;
    for (const [shape, size] of Object.entries(DENSE_SIZES)) {
      const cell = cells.find(
        (c) => c.id === `P-2 ${shape} commit_ms[${engine}]`,
      );
      if (cell?.status !== "ok") break;
      largest = size;
    }
    dense[engine] = largest;
  }
  return {
    desktop_valid_workload_failure: failure,
    desktop_needs_finer_pagination:
      complete && failure === false ? false : null,
    desktop_D_largest_dense_changes_committed: dense,
  };
}

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
  effectsOfWorkload,
  expectedEffectsOfBody,
  expectedOutcome,
  OUTCOMES,
  protocolWorkloads,
  runsRequired,
} from "./profile-device-results.mjs";
import {
  COLLECTION_LOG,
  CONTRACT_VERSION,
  ENGINES,
  PROGRAMME_STAGES,
  REQUIRED_CASES,
  SHARED_ROWS,
} from "./profile-evidence.mjs";
import {
  classifyWindow,
  SAMPLE_INTERVAL_MS,
  sampleIdentityProblem,
} from "./profile-isolation.mjs";
import {
  coldObservationRules,
  commitsOfTrace,
  liveObservationRules,
  pageCommitted,
  traceEvent,
  tracePayload,
} from "./profile-outcome-rules.mjs";
import {
  DRAFT_WITNESS_METHOD,
  draftWitnessSelection,
  SYNC_WITNESS_METHOD,
  syncWitnessSelection,
  TRACE_ROUNDING_MS,
} from "./profile-sample-rules.mjs";
import {
  observeW2Capture,
  sameTargetProblems,
  W2_SEED,
} from "./profile-w2-capture.mjs";
import { denseChecklistPage, ordinaryPage } from "./profile-workloads.mjs";

export { CONTRACT_VERSION };
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
// Revision 3 (review 3 R2; design assessment A1-A8, E1-E12): a check validates the observation's CONTENTS (identity, units, domain,
// capability state, cardinality) and recomputes every derived figure from the observations it was derived from, so a row that keeps its
// counts but loses its contents, or a summary that disagrees with its own raw support, is never complete. `opts.counts` (default true)
// gates the programme's sample counts only: a qualification run of a real writer with shortened samples checks the same contents.
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isCount = (x) => Number.isInteger(x) && x >= 0;
const isNonNeg = (x) => isNum(x) && x >= 0;
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isText = (x) => typeof x === "string" && x.trim().length > 0;
/** JSON with sorted keys: two representations of one observation are the same only if this text is. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObj(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const same = (a, b) => canonical(a) === canonical(b);
const countsOn = (opts) => opts?.counts !== false;
/** One value row (not a required cell itself) that another representation must agree with. */
const oneValue = (ev, name, engine) =>
  ev.values.rows.filter((r) => r.name === name && r.engine === engine);
const stripIdentity = (row) => {
  const {
    id: _id,
    name: _name,
    engine: _engine,
    stage: _stage,
    invocation: _invocation,
    at: _at,
    collection: _collection,
    __line: _line,
    __ordinal: _ordinal,
    __file: _file,
    ...rest
  } = row;
  return rest;
};
const rawSamples = (ev, name, engine) => {
  const row = rowsNamed(ev.measurements, name, engine)[0];
  if (!row || typeof row.raw !== "string") return null;
  const raw = ev.readJson(row.raw);
  return Array.isArray(raw.value?.samples) ? raw.value.samples : null;
};

function checkDeclaredOmission(value) {
  return value.status === "not_run" &&
    typeof value.reason === "string" &&
    value.reason.trim()
    ? []
    : [
        "the declared omission (D-18 fixes maxInFlight at 1) has no not_run status and reason",
      ];
}

/** A storage reading: every figure present, a byte count or an explicit null (a capability the engine lacks), Chromium's exact one. */
function footprintProblems(f, where, engine, flat) {
  if (!isObj(f)) return [`${where} is missing`];
  const problems = [];
  const estimate = flat ? f : f.estimate;
  if (!isObj(estimate)) return [`${where}.estimate is missing`];
  for (const field of ["usage", "quota"])
    if (
      !(field in estimate) ||
      !(estimate[field] === null || isNonNeg(estimate[field]))
    )
      problems.push(
        `${where}${flat ? "" : ".estimate"}.${field} is not a byte count or an explicit null`,
      );
  if (!("indexeddb" in f) || !(f.indexeddb === null || isNonNeg(f.indexeddb)))
    problems.push(`${where}.indexeddb is not a byte count or an explicit null`);
  if (engine === "chromium" && !isNonNeg(f.indexeddb))
    problems.push(`${where}.indexeddb: Chromium's exact CDP figure is missing`);
  return problems;
}
/** P-Q: the writer's readings ({estimate: {usage, quota}, indexeddb}), and the per-draft figure derived from two of them. */
function checkFootprints(value, cell) {
  const problems = [];
  for (const key of [
    "baseline",
    "empty_account_database",
    "with_200_drafts",
    "one_draft_with_1_mib_payload",
    "atlas_auth_steady",
    "atlas_auth_100_fences_200_leases",
  ])
    problems.push(...footprintProblems(value[key], key, cell.engine, false));
  if (!isText(value.one_draft_with_1_mib_payload?.outcome))
    problems.push("the 1 MiB import draft's enqueue outcome is not recorded");
  const empty = value.empty_account_database?.indexeddb ?? null;
  const drafts = value.with_200_drafts?.indexeddb ?? null;
  const perDraft =
    isNum(empty) && isNum(drafts) ? Math.round((drafts - empty) / 200) : null;
  if (value.per_draft_bytes_chromium !== perDraft)
    problems.push(
      `per_draft_bytes_chromium ${value.per_draft_bytes_chromium} does not follow from its readings (${perDraft})`,
    );
  if (typeof value.note !== "string")
    problems.push("the estimate method is not stated");
  return problems;
}

/**
 * P-Q2 (C8): the burst's footprints and every request's outcome, the estimate ladder from its initial usage, the ledger's readings before
 * and after its 100 reservations, and the desktop recommendation recomputed from them (nullable estimates stay null; nothing is assumed).
 */
function checkQuotaInputs(value, cell) {
  const problems = [];
  const engine = cell.engine;
  const burst = value.atlas_auth_burst;
  if (!isObj(burst)) return ["the atlas-auth burst is not recorded"];
  if (burst.pages !== 3 || burst.requests_per_page !== 20)
    problems.push("the burst is not three pages of twenty stamped requests");
  if (
    !Number.isInteger(burst.held_at_once) ||
    burst.held_at_once < 20 ||
    burst.held_at_once > 60
  )
    problems.push(
      `held_at_once ${burst.held_at_once}: the writer holds at least one page's twenty requests out together (20 to 60)`,
    );
  if (!Array.isArray(burst.outcomes) || burst.outcomes.length !== 60)
    problems.push(
      `${Array.isArray(burst.outcomes) ? burst.outcomes.length : 0} of 60 request outcomes recorded`,
    );
  else if (!burst.outcomes.every(isText))
    problems.push(
      "a request outcome is not one the writer records ('released' or the stamped wrapper's error kind)",
    );
  for (const key of ["idle", "during", "after"])
    problems.push(
      ...footprintProblems(burst[key], `atlas_auth_burst.${key}`, engine, true),
    );
  const growth = (from, to) => ({
    estimate:
      isNum(to?.usage) && isNum(from?.usage) ? to.usage - from.usage : null,
    indexeddb_exact:
      isNum(to?.indexeddb) && isNum(from?.indexeddb)
        ? to.indexeddb - from.indexeddb
        : null,
  });
  if (!same(burst.growth_during, growth(burst.idle, burst.during)))
    problems.push(
      "growth_during does not follow from the idle and during readings",
    );
  if (!same(burst.growth_after, growth(burst.idle, burst.after)))
    problems.push(
      "growth_after does not follow from the idle and after readings",
    );
  const ladder = value.estimate_granularity;
  let firstChange;
  if (!isObj(ladder)) problems.push("the estimate ladder is not recorded");
  else {
    if (
      !("initial_usage" in ladder) ||
      !(ladder.initial_usage === null || isNonNeg(ladder.initial_usage))
    )
      problems.push(
        "the ladder's initial usage is not a byte count or an explicit null",
      );
    const rows = ladder.rows;
    if (!Array.isArray(rows) || rows.length !== 15)
      problems.push(
        `${Array.isArray(rows) ? rows.length : 0} of 15 estimate-ladder writes recorded`,
      );
    else {
      let previous = ladder.initial_usage ?? null;
      let written = 0;
      for (const [k, row] of rows.entries()) {
        if (!isObj(row)) {
          problems.push(`ladder write ${k + 1} is not a reading`);
          previous = null;
          continue;
        }
        written += 1024 * 2 ** k;
        if (row.added_bytes !== 1024 * 2 ** k)
          problems.push(
            `ladder write ${k + 1}: added ${row.added_bytes} bytes, not 1 KiB x 2^${k}`,
          );
        if (row.total_written !== written)
          problems.push(
            `ladder write ${k + 1}: total_written ${row.total_written}, not ${written}`,
          );
        if (!("usage" in row) || !(row.usage === null || isNonNeg(row.usage)))
          problems.push(
            `ladder write ${k + 1}: usage is not a byte count or an explicit null`,
          );
        const delta =
          isNum(row.usage) && isNum(previous) ? row.usage - previous : null;
        if (row.delta !== delta)
          problems.push(
            `ladder write ${k + 1}: delta ${row.delta} does not follow from the usage readings (${delta})`,
          );
        previous = row.usage ?? null;
      }
      firstChange = rows.find((row) => (row?.delta ?? 0) > 0);
      if (
        ladder.smallest_write_that_moved_the_estimate !==
        (firstChange?.added_bytes ?? null)
      )
        problems.push(
          "the smallest write that moved the estimate does not follow from the ladder",
        );
      if (ladder.estimate_step_bytes !== (firstChange?.delta ?? null))
        problems.push("the estimate step does not follow from the ladder");
    }
  }
  const ledger = value.ledger;
  if (!isObj(ledger)) problems.push("the ledger is not recorded");
  else {
    if (ledger.reservations !== 100 || ledger.bytes_each !== 1024)
      problems.push("the ledger is not 100 reservations of 1,024 bytes");
    const verdicts = isObj(ledger.verdicts)
      ? Object.entries(ledger.verdicts)
      : null;
    if (
      !verdicts?.every(([k, n]) => isText(k) && isCount(n)) ||
      verdicts.reduce((n, [, x]) => n + (isCount(x) ? x : 0), 0) !== 100
    )
      problems.push("the ledger does not hold 100 typed reservation verdicts");
    problems.push(
      ...footprintProblems(ledger.before, "ledger.before", engine, true),
      ...footprintProblems(ledger.after, "ledger.after", engine, true),
    );
    if (!same(ledger.growth, growth(ledger.before, ledger.after)))
      problems.push(
        "the ledger's growth does not follow from its before and after readings",
      );
  }
  const during = growth(burst.idle, burst.during);
  const burstBytes = during.indexeddb_exact ?? during.estimate ?? null;
  const step = firstChange?.delta ?? null;
  const recommendation =
    burstBytes === null || step === null
      ? null
      : Math.max(burstBytes * 4, step * 2);
  if (value.derived_desktop_recommendation_bytes !== recommendation)
    problems.push(
      `the derived recommendation ${value.derived_desktop_recommendation_bytes} does not follow from the burst and the estimate step (${recommendation})`,
    );
  if (value.quota_reserve_bytes_in_use !== 8 * 1024 * 1024)
    problems.push("the reserve in use (8 MiB) is not recorded");
  return problems;
}

function checkBackend(value) {
  const problems = [];
  if (value.health?.status !== 200)
    problems.push(`the backend's /health answered ${value.health?.status}`);
  if (!isObj(value.health?.body))
    problems.push("the /health body is not recorded");
  if (!isObj(value.revision))
    problems.push(
      "the backend revision the integration runner verified is not recorded",
    );
  return problems;
}

const shapeProblems = (shape, where) =>
  isObj(shape) &&
  isCount(shape.changes) &&
  isCount(shape.checklist_upserts) &&
  shape.checklist_upserts <= shape.changes &&
  typeof shape.person_ancestor === "boolean"
    ? []
    : [
        `${where} is not a batch shape (changes, checklist upserts, the person present)`,
      ];
/** The bound write's answer and what the reader was then delivered: one of the writer's three recorded forms. */
function checkBound(value) {
  const problems = [];
  if (!isText(value.bound_person))
    problems.push("the bound's person is not recorded");
  if (!isObj(value.revoke) || !Number.isInteger(value.revoke.status))
    return [...problems, "the bound write's answer is not recorded"];
  const d = value.delivered;
  if (!isObj(d))
    return [...problems, "what the server then delivered is not recorded"];
  if (value.revoke.status !== 200) {
    if (!same(d, { status: "not_read" }))
      problems.push(
        "a refused bound write cannot have been followed by a read",
      );
  } else if (d.status === 200) {
    if (!Array.isArray(d.batch_shapes))
      problems.push("the delivered batch shapes are not recorded");
    else
      for (const [i, shape] of d.batch_shapes.entries())
        problems.push(...shapeProblems(shape, `delivered batch ${i + 1}`));
    if (typeof d.has_more !== "boolean")
      problems.push("has_more is not recorded");
    if (!isCount(d.bytes)) problems.push("the delivered size is not recorded");
  } else if (!Number.isInteger(d.status) || typeof d.body !== "string")
    problems.push(
      "the read's refusal is not recorded with its status and body",
    );
  return problems;
}

const LIMIT_COMMANDS = [800, 400, 200, 100, 40, 21, 20];
const answerOf = (x) =>
  isObj(x) && Number.isInteger(x.status) && typeof x.body === "string";
/** The finite limits probe: the legacy answer, the value-length ladder, and the command-count ladder in its order (proxy and direct). */
function checkLimits(value) {
  const problems = [];
  if (value.status !== "measured" || !isObj(value.probe))
    return ["the limits probe is not recorded"];
  const p = value.probe;
  if (!answerOf(p.legacy_create_field_checklist))
    problems.push("the legacy create_field answer is not recorded");
  if (
    ![0, 4096, 2000, 1000, 500, 100].includes(
      p.largest_text_value_accepted_of_tried,
    )
  )
    problems.push(
      "the largest accepted text value is not one of the lengths tried",
    );
  const rows = p.command_count_rows;
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    rows.length > LIMIT_COMMANDS.length
  )
    return [...problems, "the command-count ladder is not recorded"];
  for (const [i, row] of rows.entries()) {
    const where = `command-count row ${i + 1}`;
    if (!isObj(row)) {
      problems.push(`${where} is not a row`);
      continue;
    }
    if (row.commands !== LIMIT_COMMANDS[i])
      problems.push(
        `${where}: ${row.commands} commands, not the ladder's ${LIMIT_COMMANDS[i]}`,
      );
    if (!isCount(row.body_bytes) || row.body_bytes === 0)
      problems.push(`${where}: no body size`);
    if (!answerOf(row.proxied))
      problems.push(`${where}: the proxied answer is not recorded`);
    else if (row.proxied.status === 200) {
      if (row.direct !== null)
        problems.push(`${where}: an accepted body has no direct probe`);
      if (i !== rows.length - 1)
        problems.push(`${where}: the ladder goes on after an accepted body`);
    } else if (!answerOf(row.direct))
      problems.push(
        `${where}: a refused body has no direct answer (proxy and backend cannot be told apart)`,
      );
  }
  if (
    rows.length < LIMIT_COMMANDS.length &&
    rows.at(-1)?.proxied?.status !== 200
  )
    problems.push("the ladder stopped before an accepted body or its end");
  return problems;
}

const RETIREMENT_COUNTS = {
  leader_cover_commits: ["leader", "cover.committed"],
  leader_requests_issued: ["leader", "request.issued"],
  leader_leases_retired: ["leader", "lease.retired"],
  leader_activity_cancelled: ["leader", "activity.cancel"],
  probe_activity_cancelled: ["probe", "activity.cancel"],
  probe_leases_retired: ["probe", "lease.retired"],
  probe_retire_failed: ["probe", "lease.retire_failed"],
  probe_closing_gave_up: ["probe", "closing.gave_up"],
};
/** P-8: both conditions with every counter, the rate from its pages and duration, every counter recounted from its trace support. */
function checkRetirements(file, cell, ev) {
  const problems = [];
  const conditions = file.conditions;
  if (!Array.isArray(conditions) || conditions.length !== P7_CONDITIONS.length)
    return [
      `${Array.isArray(conditions) ? conditions.length : 0} of ${P7_CONDITIONS.length} retirement conditions`,
    ];
  const trace = ev.readJson(`contention/retirements-trace.${cell.engine}.json`);
  const support =
    trace.present && !trace.error && Array.isArray(trace.value?.conditions)
      ? trace.value.conditions
      : null;
  if (!support)
    problems.push("the retirements' trace support is missing or malformed");
  for (const [i, c] of conditions.entries()) {
    const where = `retirements, ${P7_CONDITIONS[i]}`;
    if (!isObj(c) || c.condition !== P7_CONDITIONS[i]) {
      problems.push(`${where}: the condition is not recorded under its name`);
      continue;
    }
    if (!isCount(c.leader_pages))
      problems.push(`${where}: leader_pages is not a count`);
    if (!isNum(c.elapsed_s) || c.elapsed_s <= 0)
      problems.push(`${where}: the duration is not recorded`);
    else if (
      c.leader_pages_per_second !== +(c.leader_pages / c.elapsed_s).toFixed(1)
    )
      problems.push(
        `${where}: leader_pages_per_second does not follow from its pages and duration`,
      );
    const slice = support?.find((s) => s?.condition === c.condition);
    if (
      support &&
      (!slice || !Array.isArray(slice.leader) || !Array.isArray(slice.probe))
    )
      problems.push(`${where}: no trace support for the condition`);
    for (const [key, [page, event]] of Object.entries(RETIREMENT_COUNTS)) {
      if (!isCount(c[key])) {
        problems.push(`${where}: ${key} is not a count`);
        continue;
      }
      if (slice && Array.isArray(slice[page])) {
        const counted = slice[page].filter((e) => e?.event === event).length;
        if (counted !== c[key])
          problems.push(
            `${where}: ${key} ${c[key]} is not what its trace support counts (${counted})`,
          );
      }
    }
  }
  const row = oneValue(ev, "P-8 retirements", cell.engine);
  if (row.length !== 1 || !same(row[0].conditions, conditions))
    problems.push("the P-8 value row does not hold the file's conditions");
  return problems;
}

/** P-7 frozen owner: every row's give-up is its outcome, the summary counts the rows, and the wait series is the rows' waits. */
function checkFrozenOwner(file, cell, ev, opts) {
  const problems = [];
  const rows = Array.isArray(file.rows) ? file.rows : null;
  if (!rows) return ["the frozen-owner rows are not recorded"];
  const per = countsOn(opts) ? 15 : file.samples_per_freeze;
  if (!isCount(per) || per === 0)
    problems.push("the samples per freeze are not recorded");
  for (const [i, freeze] of P7_FREEZES.entries()) {
    const block = rows.slice(i * per, (i + 1) * per);
    if (block.length !== per || !block.every((r) => r?.freeze_ms === freeze))
      problems.push(
        `freeze ${freeze} ms: not ${per} samples in the ladder's order`,
      );
  }
  if (rows.length !== P7_FREEZES.length * per)
    problems.push(`${rows.length} of ${P7_FREEZES.length * per} rows`);
  for (const [i, r] of rows.entries()) {
    if (!isObj(r) || !isText(r.outcome) || !isNonNeg(r.waited_ms)) {
      problems.push(`row ${i + 1} has no outcome or wait`);
      continue;
    }
    if (r.gave_up !== (r.outcome === "lock_timeout"))
      problems.push(
        `row ${i + 1}: gave_up ${r.gave_up} does not follow from its outcome ${r.outcome}`,
      );
  }
  const gaveUp = rows.filter((r) => r?.gave_up === true).length;
  if (file.gave_up !== gaveUp || file.of !== rows.length)
    problems.push("the give-up count does not follow from the rows");
  if (file.scaled_lock_wait_ms !== 1000)
    problems.push("the scaled lock wait is not 1 s");
  if (!same(file.freezes_ms, P7_FREEZES))
    problems.push("the freeze ladder is not recorded");
  if (file.samples_per_freeze !== per)
    problems.push("samples_per_freeze is not the rows'");
  const series = rawSamples(
    ev,
    "P-7 frozen owner: writer wait (scaled 1 s)",
    cell.engine,
  );
  // A representation that is itself an absent required cell is that cell's finding; one that is there must agree.
  if (
    series &&
    !same(
      series,
      rows.map((r) => r?.waited_ms),
    )
  )
    problems.push("the scaled writer-wait series is not the rows' waits");
  const value = oneValue(ev, "P-7 frozen owner give-ups", cell.engine);
  if (
    value.length !== 1 ||
    !same(stripIdentity(value[0]), {
      gave_up: gaveUp,
      of: rows.length,
      scaled_lock_wait_ms: 1000,
    })
  )
    problems.push("the give-ups value row does not agree with the rows");
  return problems;
}
function checkProductionWait(file, _cell, _ev, opts) {
  const problems = [];
  if (file.lock_wait_ms !== 20_000 || file.freeze_ms !== 23_000)
    problems.push("not the production 20 s wait against a 23 s freeze");
  const rows = Array.isArray(file.rows) ? file.rows : [];
  if (countsOn(opts) ? rows.length !== 2 : rows.length === 0)
    problems.push(`${rows.length} of 2 production-wait runs`);
  for (const [i, row] of rows.entries())
    if (
      !isObj(row) ||
      row.outcome !== "lock_timeout" ||
      !(isNum(row.waited_ms) && row.waited_ms >= 19_500)
    )
      problems.push(
        `run ${i + 1}: ${row?.outcome} after ${row?.waited_ms} ms (the writer must give up at the bound, never earlier)`,
      );
  return problems;
}
/** P-9: the engine's support, every policy in order, and each policy's throughput the very samples of its series. */
function checkYieldPolicy(file, cell, ev) {
  const problems = [];
  const support = file.engine_support;
  if (
    !isObj(support) ||
    typeof support.scheduler_yield !== "boolean" ||
    typeof support.request_idle_callback !== "boolean"
  )
    problems.push("the engine's yield support is not recorded");
  const rows = Array.isArray(file.rows) ? file.rows : [];
  if (
    !same(
      rows.map((r) => r?.policy),
      P9_POLICIES,
    )
  )
    problems.push(`policies ${rows.map((r) => r?.policy).join(", ")}`);
  for (const row of rows) {
    const t = row?.throughput_pages_per_second;
    if (!Array.isArray(t) || !t.every((x) => isNum(x) && x > 0)) {
      problems.push(`${row?.policy}: the throughput samples are not recorded`);
      continue;
    }
    const series = rawSamples(
      ev,
      `P-9 ${row.policy}: catch-up throughput (pages/s, 200 pages, no probe)`,
      cell.engine,
    );
    if (series && !same(series, t))
      problems.push(`${row.policy}: the throughput is not its series' samples`);
  }
  return problems;
}

/** What a JSONL support file says about one series: exactly one row, its samples and outcome counts those of the series' raw file. */
function jsonlAgrees(ev, file, match, samples, row) {
  const read = ev.jsonl(file);
  if (!read.present) return [`${file} is missing`];
  if (read.errors.length) return [`${file} is malformed (${read.errors[0]})`];
  const found = read.rows.filter((r) =>
    Object.entries(match).every(([k, v]) => r[k] === v),
  );
  if (found.length !== 1)
    return [`${found.length} rows of ${file} for this series`];
  const f = found[0];
  const problems = [];
  if (f.n !== samples.length || !same(f.ms, samples))
    problems.push(`its samples in ${file} are not the series' raw samples`);
  const outcomes = isObj(f.outcomes) ? Object.values(f.outcomes) : null;
  if (
    !outcomes?.every(isCount) ||
    outcomes.reduce((n, x) => n + x, 0) !== samples.length
  )
    problems.push(`its outcomes in ${file} do not count its samples`);
  if (!same(f.outcomes, row.outcomes))
    problems.push("the series' outcomes are not those of its support file");
  return problems;
}

/**
 * Cross-representation checks of a measurement series (design assessment A4/A6, E5-E7): the same observation recorded elsewhere must be
 * the same samples, in the same order. Keyed by the series name.
 */
function crossChecks(ev, cell, samples, row) {
  const name = cell.name;
  const engine = cell.engine;
  let m =
    /^P-7 (.*), (no leader|back-to-back leader, 5 ms apart \(platform yield\))$/.exec(
      name,
    );
  if (m)
    return jsonlAgrees(
      ev,
      "contention/waits.jsonl",
      { probe: m[1], condition: m[2], engine },
      samples,
      row,
    );
  m =
    /^P-9 (none|macrotask|scheduler_yield|idle): (ordinary request|exposure|atlas-auth writer) wait$/.exec(
      name,
    );
  if (m)
    return jsonlAgrees(
      ev,
      "contention/yield-policy.jsonl",
      { policy: m[1], probe: m[2], engine },
      samples,
      row,
    );
  m =
    /^P-13 leader catch-up throughput \(pages\/s, \d+ pages\), (\d) follower\(s\)$/.exec(
      name,
    );
  if (m) {
    const file = ev.readJson(`contention/follower-reads.${engine}.json`).value;
    if (!isObj(file)) return [];
    return same(file.leader_throughput_pages_per_second?.[m[1]], samples)
      ? []
      : ["the follower file's throughput is not this series' samples"];
  }
  m = /^(P-11 (\S+)|P-W2) (elapsed_ms|rss_peak_kib|heap_peak_bytes)$/.exec(
    name,
  );
  if (m) {
    const path = m[2] ? `memory/P-11.${engine}.json` : `w2/P-W2.${engine}.json`;
    const workload = m[2] ?? "W2";
    const file = ev.readJson(path).value;
    if (!isObj(file)) return [];
    const runs = (Array.isArray(file.rows) ? file.rows : []).filter(
      (r) => r?.workload === workload,
    )[0]?.runs;
    return Array.isArray(runs) &&
      same(
        runs.map((r) => r?.[m[3]]),
        samples,
      )
      ? []
      : [`its samples are not the per-run ${m[3]} of ${path}, in run order`];
  }
  m = /^P-2 (\S+) (scan_ms|commit_ms)$/.exec(name);
  if (m) return p2SupportProblems(ev, engine, m[1], m[2], samples, row);
  m =
    /^(?:P-4 sync page (pre_issue_ms|request_ms|post_response_ms|total_ms)|P-10 sync page (request_ms) \(unthrottled loopback\)|P-10 sync page (duration_ms) \(proxy delay 250 ms\))$/.exec(
      name,
    );
  if (m) {
    const segment = m[1] ?? m[2] ?? m[3];
    const file = m[3]
      ? `samples/P-10.sync.${engine}.json`
      : `samples/P-4.sync.${engine}.json`;
    const problems = syncSupportProblems(
      ev,
      file,
      segment,
      samples,
      row,
      engine,
    );
    if (problems.length || name !== "P-4 sync page total_ms") return problems;
  }
  m =
    /^(?:P-4 draft (enqueue_ms|claim_ms|stamping_ms|request_ms|record_ms|total_ms)|P-10 draft (request_ms) \(unthrottled loopback\))$/.exec(
      name,
    );
  if (m) {
    const problems = draftSupportProblems(
      ev,
      `samples/P-4.draft.${engine}.json`,
      m[1] ?? m[2],
      samples,
      row,
      engine,
    );
    if (problems.length || name !== "P-4 draft total_ms") return problems;
  }
  if (name === "P-4 sync page total_ms") {
    const parts = ["pre_issue_ms", "request_ms", "post_response_ms"].map((s) =>
      rawSamples(ev, `P-4 sync page ${s}`, engine),
    );
    if (parts.some((p) => !p)) return [];
    if (parts.some((p) => p.length !== samples.length))
      return ["its segment series do not match it sample for sample"];
    return samples.every(
      (t, i) =>
        Math.abs(parts.reduce((n, p) => n + p[i], 0) - t) <=
        1e-6 * Math.max(1, Math.abs(t)),
    )
      ? []
      : [
          "a total is not the sum of its pre-issue, request and post-response segments",
        ];
  }
  if (name === "P-4 draft total_ms") {
    const parts = [
      "enqueue_ms",
      "claim_ms",
      "stamping_ms",
      "request_ms",
      "record_ms",
    ].map((s) => rawSamples(ev, `P-4 draft ${s}`, engine));
    if (parts.some((p) => !p)) return [];
    if (parts.some((p) => p.length !== samples.length))
      return ["its segment series do not match it sample for sample"];
    // The draft total runs to the observation that read the answer, so it is at least the sum of the segments that lie inside it, up to
    // the answer line's own 1 ms rounding (revision 13: the observation now reads the answer and the time in ONE evaluation, so the
    // rounded line can lie up to half a millisecond after it).
    return samples.every(
      (t, i) =>
        parts.reduce((n, p) => n + p[i], 0) <=
        t + TRACE_ROUNDING_MS + 1e-6 * Math.max(1, Math.abs(t)),
    )
      ? []
      : ["a total is shorter than the segments inside it"];
  }
  return [];
}

/** The served byte length of P-2 sample `index` (warm-ups included) of a shape: the writer's own generator, regenerated here. */
const P2_BYTES = new Map();
function p2Bytes(shape, index) {
  const key = shape.startsWith("dense-") ? shape : `${shape}#${index}`;
  if (!P2_BYTES.has(key)) {
    const dense = /^dense-(\d+)/.exec(shape);
    const ordinary = /^ordinary-(\d+)$/.exec(shape);
    const body = dense
      ? denseChecklistPage(Number(dense[1]))
      : ordinary
        ? ordinaryPage(Number(ordinary[1]), index)
        : null;
    P2_BYTES.set(key, body === null ? null : Buffer.byteLength(body));
  }
  return P2_BYTES.get(key);
}

/**
 * P-2's scan and commit series against their per-sample operations (revision 12, review 12, design assessment DA-M1; contract version 7).
 * `raw/P-2.samples.<engine>.json` names each recorded sample's trace start, commit and step end in `raw/P-2.trace.<engine>.txt`; the
 * commit must be the FIRST after its start, of the sample's served bytes (regenerated here), applied and committed, followed by an idle
 * step end, the samples in order without overlap, and the series value that commit's own timing. A later commit (the retry of an empty
 * page after a lapsed hold) can never supply a sample.
 */
function p2SupportProblems(ev, engine, shape, metric, samples, row) {
  const key = `p2support:${engine}`;
  if (!ev[key]) {
    const support = ev.readJson(`raw/P-2.samples.${engine}.json`);
    const tracePath = `raw/P-2.trace.${engine}.txt`;
    ev[key] = {
      support,
      lines: ev.exists(tracePath)
        ? ev.bytes(tracePath).toString("utf8").split("\n")
        : null,
    };
  }
  const { support, lines } = ev[key];
  if (!support.present || support.error || !isObj(support.value))
    return ["its per-sample support (raw/P-2.samples) is missing or malformed"];
  if (support.value.method !== "p2-sample/1" || support.value.engine !== engine)
    return ["its per-sample support is not this engine's p2-sample/1"];
  if (!lines) return ["its trace (raw/P-2.trace) is missing"];
  const entries = support.value.shapes?.[shape];
  if (!Array.isArray(entries) || entries.length !== samples.length)
    return ["its per-sample support does not name one operation per sample"];
  const warmup = row?.warmup;
  for (const [k, e] of entries.entries()) {
    const where = `sample ${k}`;
    if (
      !isObj(e) ||
      !isCount(e.from) ||
      !isCount(e.commit) ||
      !isCount(e.end) ||
      !(e.from <= e.commit && e.commit < e.end)
    )
      return [`${where}: its support is malformed`];
    if (!isCount(warmup) || e.index !== warmup + k)
      return [`${where}: its support is not the sample after the warm-ups`];
    if (k > 0 && !(e.from > entries[k - 1].end))
      return [`${where}: it overlaps the previous sample's operation`];
    const commits = [];
    for (let t = e.from; t <= e.commit; t += 1)
      if (traceEvent(lines[t]) === "data.sync_commit") commits.push(t);
    if (commits[0] !== e.commit)
      return [`${where}: its commit is not the first after the sample began`];
    const commit = tracePayload(lines[e.commit]);
    if (!pageCommitted(commit)) return [`${where}: its commit wrote no page`];
    const bytes = p2Bytes(shape, e.index);
    if (commit.bytes !== bytes || e.bytes !== bytes)
      return [
        `${where}: its commit is ${commit.bytes} bytes, not the served ${bytes}`,
      ];
    for (let t = e.commit + 1; t < e.end; t += 1)
      if (
        ["data.sync_next", "data.sync_step_failed"].includes(
          traceEvent(lines[t]),
        )
      )
        return [`${where}: its step end is not the first after its commit`];
    if (
      traceEvent(lines[e.end]) !== "data.sync_next" ||
      tracePayload(lines[e.end])?.state !== "idle"
    )
      return [`${where}: its step did not end idle`];
    if (samples[k] !== commit[metric])
      return [
        `${where}: ${samples[k]} is not its commit's ${metric} (${commit[metric]})`,
      ];
  }
  return [];
}

/**
 * The common frame of a per-sample support file (revision 13, review 13 R2; contract version 8): its method, its engine (the series'), its
 * stamp (the series row's stage, invocation and collection test), no recorded failure, one entry per sample after the warm-ups, in order,
 * each mark at or after the previous sample's read, and one page instance and time origin for the whole file. `closeOf` names the read that
 * ends a sample: a sync sample's read; a draft sample's completion read (revision 14, contract version 9), whose dispatch record position
 * the next mark must also follow.
 */
function supportFrameProblems(
  ev,
  file,
  method,
  samples,
  row,
  engine,
  closeOf = (e) => e.read,
) {
  const entry = ev.readJson(file);
  if (!entry.present || entry.error || !isObj(entry.value))
    return {
      problems: [`its per-sample support (${file}) is missing or malformed`],
    };
  const v = entry.value;
  if (v.method !== method || !Array.isArray(v.samples))
    return { problems: [`${file} is not ${method}`] };
  if (v.engine !== engine)
    return { problems: [`${file} is ${v.engine}'s support, not ${engine}'s`] };
  if (
    !ev.relaxed &&
    (!isObj(v.evidence) ||
      v.evidence.stage !== row?.stage ||
      v.evidence.invocation !== row?.invocation ||
      !isObj(v.evidence.collection) ||
      v.evidence.collection.test !== row?.collection?.test)
  )
    return {
      problems: [
        `${file} was not written by this series' stage, invocation and test`,
      ],
    };
  if (v.failure !== null)
    return {
      problems: [
        `${file} records an incomplete sample: ${String(v.failure?.problem ?? v.failure)}`,
      ],
    };
  if (v.samples.length !== samples.length)
    return {
      problems: [
        "its per-sample support does not name one operation per sample",
      ],
    };
  const warmup = isCount(row?.warmup) ? row.warmup : 0;
  if (v.warmup !== warmup)
    return { problems: [`${file} records another warm-up count`] };
  for (const [k, e] of v.samples.entries()) {
    const where = `sample ${k}`;
    if (
      !isObj(e) ||
      e.index !== warmup + k ||
      !isObj(e.mark) ||
      !isObj(closeOf(e))
    )
      return { problems: [`${where}: its support is malformed`] };
    if (
      e.mark.page !== v.samples[0].mark.page ||
      e.mark.time_origin !== v.samples[0].mark.time_origin
    )
      return {
        problems: [`${where}: it was collected on another page instance`],
      };
    const previous = k > 0 ? closeOf(v.samples[k - 1]) : null;
    if (
      k > 0 &&
      (!(e.mark.from >= previous?.to) ||
        (previous?.log_to !== undefined &&
          !(e.mark.log_from >= previous.log_to)))
    )
      return {
        problems: [`${where}: it overlaps the previous sample's operation`],
      };
  }
  return { problems: [], v };
}

/** The selection a witness entry records equals the one the rule derives, and the series value is the derived one. */
function derivedProblems(where, e, selection, segment, value) {
  if (selection.status !== "complete")
    return [
      `${where}: its operation is ${selection.status}: ${selection.problem}`,
    ];
  if (canonical(e.selected) !== canonical(selection.selected))
    return [
      `${where}: its recorded selection is not the operation its witness shows`,
    ];
  const derived = selection.values[segment];
  return Math.abs(derived - value) <= 1e-6 * Math.max(1, Math.abs(derived))
    ? []
    : [`${where}: ${value} is not its operation's ${segment} (${derived})`];
}

/**
 * A P-4/P-10 sync series against its per-sample witnesses (revision 13, review 13 R2, design assessment DA-R2-A/DA-R2-B; contract version
 * 8): each sample's bounded witness (`sync-request-sample/2`: page and engine identity, the contiguous trace slice from its mark, every
 * `/sync` entry) is re-derived with the writers' own rule (scripts/lib/profile-sample-rules.mjs): the first real step after the mark,
 * closed by its own end, one commit, the one request inside it and none before or overlapping it. A step that ended without a commit, an
 * earlier step's start, a second request, a reload or an engine start never yields a value. Latency does not require a written page.
 * Contract version 11 (`sync-request-sample/3`, revision 16, review 16 R16-SYNC, design assessment DA16-S1/S2, invariants I1-I5): the rule
 * also requires the mark's and the read's typed times as an interval enclosing every retained line and entry, and the exact `/sync`
 * pathname; here each mark must also follow the previous sample's read in time (positions were already framed; a tie is valid), so a
 * whole witness translated earlier with its durations kept is refused.
 */
function syncSupportProblems(ev, file, segment, samples, row, engine) {
  const { problems, v } = supportFrameProblems(
    ev,
    file,
    SYNC_WITNESS_METHOD,
    samples,
    row,
    engine,
  );
  if (problems.length) return problems;
  for (const [k, e] of v.samples.entries()) {
    // The page's clock: a mark taken before the previous sample's read overlaps it (the frame compares positions).
    if (k > 0 && !(e.mark.at >= v.samples[k - 1].read.at))
      return [
        `sample ${k}: it overlaps the previous sample's operation in time`,
      ];
    const found = derivedProblems(
      `sample ${k}`,
      e,
      syncWitnessSelection(e),
      segment,
      samples[k],
    );
    if (found.length) return found;
  }
  return [];
}

/**
 * The P-4 draft series (and P-10's unthrottled draft requests) against their per-sample witnesses (revision 13, design assessment DA-N1;
 * contract version 9, `draft-request-sample/2`, revision 14, review 14 R2, DA-R14-A/B/C): no draft waiting at the mark, one first send after
 * the enqueue, its answer (a receipt) with no second send or failed step, the one `/commands` entry inside them, and completion by the
 * observed dispatcher's own applied/admitted receipt of that draft (same dispatcher, run, service and epoch; nothing else recorded or traced
 * up to the completion read; the binding unchanged across every await; the row through the bound service corroborating), re-derived with
 * the writers' rule. Each mark follows the previous completion read. A first attempt that got no answer never donates its send time, and
 * no later attempt, replacement page or unreadable read completes one. Contract version 10 (`draft-request-sample/3`, revision 15, review
 * 15 R2, DA15-R2a/R2b): the rule also checks every record's schema and its call, the closed time interval and the completion read's
 * recorded start; here each mark's `t0` must not precede the previous sample's completion read in time either. Contract version 11
 * (`draft-request-sample/4`, revision 16, DA16-D1): the dispatcher's request and every retained entry are the exact `/commands` pathname,
 * and every entry lies inside [t0, completion.at].
 */
function draftSupportProblems(ev, file, segment, samples, row, engine) {
  const { problems, v } = supportFrameProblems(
    ev,
    file,
    DRAFT_WITNESS_METHOD,
    samples,
    row,
    engine,
    (e) => (isObj(e) ? e.completion : null),
  );
  if (problems.length) return problems;
  for (const [k, e] of v.samples.entries()) {
    // The page's clock: a mark taken before the previous sample's completion read ended overlaps it (the frame compares positions).
    if (k > 0 && !(e.mark.t0 >= v.samples[k - 1].completion.at))
      return [
        `sample ${k}: it overlaps the previous sample's operation in time`,
      ];
    const found = derivedProblems(
      `sample ${k}`,
      e,
      draftWitnessSelection(e),
      segment,
      samples[k],
    );
    if (found.length) return found;
  }
  return [];
}

// ---- reading an evidence directory ---------------------------------------------------------------------------------------------------------
function readJsonl(file, name) {
  const rows = [];
  const errors = [];
  if (!existsSync(file)) return { rows, errors, present: false };
  const lines = readFileSync(file, "utf8").split("\n");
  let ordinal = 0;
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!isObj(row)) throw new Error("not a JSON object");
      rows.push({ ...row, __line: i, __ordinal: ordinal, __file: name });
    } catch (error) {
      errors.push(`line ${i + 1}: ${error.message}`);
    }
    ordinal += 1;
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
  const jsonl = new Map();
  const readRows = (rel) => {
    if (!jsonl.has(rel)) jsonl.set(rel, readJsonl(join(dir, rel), rel));
    return jsonl.get(rel);
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
    const read = readRows(`isolation/${stage}.jsonl`);
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
      // Revision 8 (review 8 R1): the samples must be this stage's sampler's, taken by the invocation's isolation context (its root by pid
      // and start), and record the identities their verdicts rest on; a support process must be one the context's pin authorises.
      if (!problem)
        problem = sampleIdentityProblem({
          context: record?.isolation_context,
          invocation: record?.invocation,
          stage,
          sampler,
          rows: read.rows,
        });
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
    measurements: readRows("measurements.jsonl"),
    values: readRows("values.jsonl"),
    collection: readRows(COLLECTION_LOG),
    jsonl: readRows,
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

/**
 * The problems of a row's identity and collection window: its stage, its invocation, its case, the window inside the stage, and (a row
 * of a shared file) its line inside the range its stage sealed as its own (design assessment E11).
 */
function windowProblems(ev, cell, row, window) {
  if (ev.relaxed) return [];
  const problems = [];
  const stage = stageOf(ev, cell.stage);
  if (row && row.stage !== cell.stage)
    problems.push(`written by stage ${row.stage}, not ${cell.stage}`);
  if (row && stage && row.invocation !== stage.invocation)
    problems.push(
      `written by invocation ${row.invocation}, not the stage's ${stage.invocation}`,
    );
  if (row && stage && row.__file && Number.isInteger(row.__ordinal)) {
    const from = stage.rows_at_start?.[row.__file];
    const to = stage.rows_at_end?.[row.__file];
    if (!isCount(from) || !isCount(to))
      problems.push(`the stage did not seal its range of ${row.__file}`);
    else if (!(row.__ordinal >= from && row.__ordinal < to))
      problems.push(
        `line ${row.__ordinal + 1} of ${row.__file} lies outside the lines its stage sealed (${from + 1} to ${to})`,
      );
  }
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
    ev.relaxed ||
    (!cell.isolation &&
      cell.kind !== "measurement" &&
      cell.kind !== "shell-run")
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
        isText(declared[0].reason) &&
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
  if (countsOn(ev.opts) && row.n !== cell.n)
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
      if (!samples.every(isNum)) {
        problems.push("a raw sample is not a finite number");
        samples = null;
      } else {
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
    const other = rawSamples(ev, cell.same_samples_as, cell.engine);
    if (!same(other, samples))
      problems.push(
        `its samples are not the ones of "${cell.same_samples_as}"`,
      );
  }
  if (samples && cell.derived) {
    const base = rawSamples(ev, cell.derived.from, cell.engine);
    if (
      !Array.isArray(base) ||
      base.length !== samples.length ||
      base.some((x, i) => Math.abs(x / cell.derived.divide - samples[i]) > 1e-9)
    )
      problems.push(
        `its samples are not "${cell.derived.from}" / ${cell.derived.divide}`,
      );
  }
  if (samples) problems.push(...crossChecks(ev, cell, samples, row));
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
    ...cell.check(rows[0], cell, ev, ev.opts),
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
  if (!isObj(entry.value))
    return result(cell, "invalid", [`${cell.path} is not a JSON object`]);
  const window = caseWindow(ev, cell);
  const problems = [
    ...windowProblems(ev, cell, entry.value.evidence ?? {}, window),
    ...(cell.check ? cell.check(entry.value, cell, ev, ev.opts) : []),
  ];
  if (!window && !ev.relaxed)
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
  if (!isObj(r))
    return result(cell, "invalid", ["the stage record is not an object"]);
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
  for (const file of SHARED_ROWS)
    if (
      !isCount(r.rows_at_start?.[file]) ||
      !isCount(r.rows_at_end?.[file]) ||
      r.rows_at_end[file] < r.rows_at_start[file]
    )
      problems.push(`the stage's range of ${file} is not recorded`);
  if (r.debugging_samples)
    problems.push("a shortened DEBUGGING run is never evidence");
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

function resolveCase(ev, cell) {
  if (ev.collection.errors.length)
    return result(cell, "invalid", [
      `the collection log is malformed (${ev.collection.errors[0]})`,
    ]);
  const found = ev.collection.rows.filter(
    (t) => t.engine === cell.engine && String(t.test).startsWith(cell.prefix),
  );
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
  const b = delta.value?.budgets?.[cell.build];
  if (!isObj(b))
    return result(cell, "missing", [`no budget check of ${cell.build}`]);
  const problems = [];
  if (b.exit !== 0)
    return result(cell, "failed", [
      `the budget check of ${cell.build} exited ${b.exit}`,
    ]);
  const file = ev.readJson(typeof b.file === "string" ? b.file : "");
  if (!file.present || file.error || !isObj(file.value))
    problems.push(`its profile ${b.file} is missing or malformed`);
  else {
    if (file.sha256 !== b.sha256)
      problems.push("its profile is not the one recorded");
    for (const key of ["initial_js_gzip", "css_gzip", "fonts"])
      if (!isCount(file.value.measured?.[key]))
        problems.push(`measured.${key} is not a byte count`);
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
  if (
    !Array.isArray(d?.initial_chunks) ||
    d.initial_chunks.length === 0 ||
    !d.initial_chunks.every(isText)
  )
    problems.push("the production initial chunk is not listed");
  if (typeof d?.dexie_in_initial_chunk !== "boolean")
    problems.push("whether Dexie is in the initial chunk is not recorded");
  if (!isCount(d?.initial_js_gzip))
    problems.push("the initial JS size is not a byte count");
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const SHELL_RUN_FIGURES = [
  "lcp",
  "fcp",
  "cls",
  "transferBytes",
  "requests",
  "fonts",
  "fontsLoaded",
  "fontsStart",
  "fontsDone",
  "fout",
];
/** One cold run of the throttled shell boot: its figures, and its own window inside the shell stage; the cell's medians from its runs. */
function resolveShellRun(ev, cell) {
  const entry = ev.readJson(`shell/${cell.build}.json`);
  if (!entry.present)
    return result(cell, "missing", [`shell/${cell.build}.json is missing`]);
  if (entry.error) return result(cell, "invalid", [entry.error]);
  const file = entry.value;
  const problems = [];
  if (file.build !== cell.build)
    problems.push(`the file measures ${file.build}`);
  const row = (Array.isArray(file.results) ? file.results : []).filter(
    (r) => r?.viewport === cell.viewport && r?.network === cell.network,
  );
  if (row.length !== 1)
    return result(cell, row.length ? "invalid" : "missing", [
      `${row.length} rows for ${cell.viewport} ${cell.network}`,
    ]);
  const raw = Array.isArray(row[0].raw) ? row[0].raw : [];
  const runs = raw.filter((r) => r?.run === cell.run);
  if (runs.length === 0) return result(cell, "missing", ["no such cold run"]);
  if (runs.length > 1)
    return result(cell, "invalid", ["the cold run is recorded twice"]);
  const run = runs[0];
  if (run.error) problems.push(`the cold run failed: ${run.error}`);
  for (const key of SHELL_RUN_FIGURES)
    if (!isNonNeg(run[key]))
      problems.push(`${key} is not a non-negative number`);
  if (
    isNum(run.fontsDone) &&
    isNum(run.fcp) &&
    run.fout !== Math.max(0, run.fontsDone - run.fcp)
  )
    problems.push("fout does not follow from fontsDone and fcp");
  if (!isObj(run.script_encodings))
    problems.push("the scripts' encodings are not recorded");
  // The cell's published figures must follow from its runs once all three are there (a missing run is its own cell's finding).
  const r = row[0];
  if (
    raw.length === SHELL.runs &&
    raw.every((x) => !x?.error && SHELL_RUN_FIGURES.every((k) => isNum(x?.[k])))
  ) {
    const m = (key) => median(raw.map((x) => x[key]));
    const derived = {
      runs: SHELL.runs,
      runs_completed: SHELL.runs,
      cpuThrottle: 4,
      lcp_ms: Math.round(m("lcp")),
      fcp_ms: Math.round(m("fcp")),
      cls: Number(m("cls").toFixed(4)),
      fout_window_ms: Math.round(m("fout")),
      transfer_kb: Math.round(m("transferBytes") / 1024),
      requests: m("requests"),
      fonts_loaded: `${m("fontsLoaded")}/${m("fonts")}`,
    };
    for (const [key, want] of Object.entries(derived))
      if (r[key] !== want)
        problems.push(
          `the cell's ${key} ${r[key]} does not follow from its runs (${want})`,
        );
  }
  const window = { test: null, from: run.from, to: run.to };
  problems.push(
    ...windowProblems(ev, { ...cell, case: null }, file.evidence ?? {}, window),
  );
  return judged(cell, problems, ev, window);
}

const P6_KNOWN = new Set([
  ...Object.keys(P6_CAUSES),
  ...Object.keys(P6_CHROMIUM_ONLY),
]);
/** P-6's summary per cause, exactly as the writer derives it from its scenario rows (tests/e2e/fixture.profile-contention.spec.ts). */
function p6ByCause(rows) {
  const byCause = {};
  for (const row of rows) {
    const entry = byCause[row.cause] ?? {
      n: 0,
      precondition_met: 0,
      injection_took_effect: 0,
      saw_unresolved: 0,
      first: {},
      unresolved_then_resolved: 0,
      never_resolved: 0,
      resolve_ms: [],
    };
    byCause[row.cause] = entry;
    entry.n += 1;
    if (row.foreign_leases > 0) entry.precondition_met += 1;
    if (row.sender_retire_failed > 0) entry.injection_took_effect += 1;
    if (row.covers_with_unresolved > 0) entry.saw_unresolved += 1;
    entry.first[row.first] = (entry.first[row.first] ?? 0) + 1;
    if (row.first !== "released" && row.resolved)
      entry.unresolved_then_resolved += 1;
    if (!row.resolved) entry.never_resolved += 1;
    if (row.resolve_ms !== null && row.first !== "released")
      entry.resolve_ms.push(row.resolve_ms);
  }
  return byCause;
}
const p6RowProblems = (row, i) => {
  const where = `scenario ${i + 1}`;
  if (!isObj(row)) return [`${where} is not a row`];
  const problems = [];
  if (!P6_KNOWN.has(row.cause)) problems.push(`${where}: cause ${row.cause}`);
  for (const key of [
    "foreign_leases",
    "sender_retire_failed",
    "covers_with_unresolved",
    "retired_by_observer",
  ])
    if (!isCount(row[key])) problems.push(`${where}: ${key} is not a count`);
  if (!isText(row.first)) problems.push(`${where}: no first verdict`);
  if (typeof row.resolved !== "boolean")
    problems.push(`${where}: resolved is not recorded`);
  else if (
    row.resolved
      ? !(row.resolve_ms === null && row.first === "released") &&
        !isNonNeg(row.resolve_ms)
      : row.resolve_ms !== null
  )
    problems.push(`${where}: resolve_ms does not agree with resolved`);
  if (row.first === "released" && row.resolved !== true)
    problems.push(`${where}: a request released at once is resolved`);
  return problems;
};
/** P-6 per cause: the scenario rows typed, the by-cause summary recomputed from them, the value row the same, the programme's count. */
function resolveP6(ev, cell) {
  const value = resolveValue(ev, { ...cell, check: () => [] });
  if (value.status === "missing" || value.status === "invalid") return value;
  const row = rowsNamed(ev.values, cell.name, cell.engine)[0];
  const problems = [];
  const file = ev.readJson(`contention/unresolved-leases.${cell.engine}.json`);
  if (!file.present || file.error || !isObj(file.value))
    problems.push("contention/unresolved-leases file is missing or malformed");
  else {
    const rows = Array.isArray(file.value.rows) ? file.value.rows : null;
    if (!rows) problems.push("the scenario rows are not recorded");
    else {
      // A scenario's typing is its own cause's finding (a row of no known cause is every cause's).
      for (const [i, r] of rows.entries())
        if (!isObj(r) || !P6_KNOWN.has(r.cause) || r.cause === cell.cause)
          problems.push(...p6RowProblems(r, i));
      const byCause = p6ByCause(rows.filter(isObj));
      if (file.value.scenarios !== rows.length)
        problems.push("the scenario count is not the rows'");
      if (!same(file.value.by_cause?.[cell.cause], byCause[cell.cause]))
        problems.push(
          "the by-cause summary does not follow from the scenario rows",
        );
      if (
        !same(
          Object.keys(file.value.by_cause ?? {}).sort(),
          Object.keys(byCause).sort(),
        )
      )
        problems.push(
          "the by-cause summary names causes the scenario rows do not",
        );
      const mine = byCause[cell.cause];
      const want = mine
        ? {
            n: mine.n,
            precondition_met: mine.precondition_met,
            injection_took_effect: mine.injection_took_effect,
            saw_unresolved: mine.saw_unresolved,
            first_verdicts: mine.first,
            unresolved_then_resolved: mine.unresolved_then_resolved,
            never_resolved: mine.never_resolved,
          }
        : null;
      if (!want || !same(stripIdentity(row), want))
        problems.push("the value row does not follow from the scenario rows");
      if (countsOn(ev.opts) && mine?.n !== cell.n)
        problems.push(
          `${mine?.n ?? 0} scenarios; the programme takes ${cell.n}`,
        );
    }
  }
  return judged(cell, problems, ev, row.collection);
}

/** P-13's figures of one condition, exactly as the writer derives them from the hints and transactions it observed. */
function p13Summary(hints, tx) {
  const byHintKind = {};
  for (const h of hints) byHintKind[h.stores] = (byHintKind[h.stores] ?? 0) + 1;
  const byStores = {};
  for (const t of tx) byStores[t.stores] = (byStores[t.stores] ?? 0) + 1;
  const readMs = [];
  let hintsWithReads = 0;
  for (const [i, h] of hints.entries()) {
    const until = hints[i + 1]?.at ?? Number.POSITIVE_INFINITY;
    const started = tx.filter((t) => t.at >= h.at && t.at < until);
    if (started.length === 0) continue;
    hintsWithReads += 1;
    readMs.push(Math.max(...started.map((t) => t.done ?? t.at)) - h.at);
  }
  return {
    summary: {
      hints: hints.length,
      hints_by_kind: byHintKind,
      transactions: tx.length,
      transactions_by_stores: byStores,
      sync_state_transactions: tx.filter((t) =>
        t.stores.split(",").includes("sync_state"),
      ).length,
      transactions_per_hint: hints.length
        ? +(tx.length / hints.length).toFixed(3)
        : null,
      hints_followed_by_reads: hintsWithReads,
    },
    readMs,
  };
}
/** P-13, one condition: every figure recomputed from the observed hints and transactions, and the read series those very reads. */
function resolveP13(ev, cell) {
  const entry = ev.readJson(`contention/follower-reads.${cell.engine}.json`);
  if (!entry.present)
    return result(cell, "missing", ["follower-reads file is missing"]);
  if (entry.error || !isObj(entry.value))
    return result(cell, "invalid", [entry.error ?? "not a JSON object"]);
  const conditions = (
    Array.isArray(entry.value.conditions) ? entry.value.conditions : []
  ).filter((c) => c?.condition === cell.condition);
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
  const support = ev.readJson(
    `contention/follower-reads-raw.${cell.engine}.json`,
  );
  const raw = (
    support.present &&
    !support.error &&
    Array.isArray(support.value?.conditions)
      ? support.value.conditions
      : []
  ).filter((x) => x?.condition === cell.condition);
  let readMs = null;
  if (
    raw.length !== 1 ||
    !Array.isArray(raw[0].hints) ||
    !Array.isArray(raw[0].tx)
  )
    problems.push(
      "the observed hints and transactions of the condition are not retained",
    );
  else if (
    !raw[0].hints.every((h) => isNum(h?.at) && typeof h?.stores === "string") ||
    !raw[0].tx.every(
      (t) =>
        isNum(t?.at) &&
        typeof t?.stores === "string" &&
        isText(t?.mode) &&
        (t?.done === null || isNum(t?.done)),
    )
  )
    problems.push("an observed hint or transaction is malformed");
  else {
    const again = p13Summary(raw[0].hints, raw[0].tx);
    readMs = again.readMs;
    for (const [key, want] of Object.entries(again.summary))
      if (!same(c[key], want))
        problems.push(
          `${key} does not follow from the observed hints and transactions`,
        );
  }
  if (!isCount(c.own_posts))
    problems.push("the follower's own posts are not counted");
  if (!isNonNeg(c.elapsed_ms))
    problems.push("the condition's duration is not recorded");
  if (
    !(
      c.controller_reads === null ||
      (isObj(c.controller_reads) &&
        ["starts", "emissions", "calls"].every((k) =>
          isCount(c.controller_reads[k]),
        ))
    )
  )
    problems.push(
      "the controller's reads are neither counted nor an explicit null",
    );
  if (cell.condition === "none (control)") {
    if (c.hints !== 0)
      problems.push(`the no-hint control heard ${c.hints} hint(s)`);
    if (!(c.elapsed_ms >= 5000))
      problems.push("the no-hint control did not last its five seconds");
  }
  if (
    countsOn(ev.opts) &&
    ["leader pages", "stop-record hints (synthetic)"].includes(
      cell.condition,
    ) &&
    !(c.hints >= 200)
  )
    problems.push(`${c.hints} of 200 hints reached the follower`);
  const value = oneValue(ev, "P-13 follower reads", cell.engine);
  if (
    value.length !== 1 ||
    !same(value[0].conditions, entry.value.conditions) ||
    !same(
      value[0].leader_throughput_pages_per_second,
      entry.value.leader_throughput_pages_per_second,
    )
  )
    problems.push("the P-13 value row does not hold the file's figures");
  const rows = rowsNamed(
    ev.measurements,
    `P-13 ${cell.condition}: follower read_ms per hint`,
    cell.engine,
  );
  if (problems.length) return result(cell, "invalid", problems);
  // Observations exist: their distribution must be recorded with exactly those samples. None: the explicit zero, and no row.
  if (c.hints_followed_by_reads === 0)
    return rows.length === 0
      ? judged({ ...cell, isolation: true }, [], ev, caseWindow(ev, cell), {
          zero_reads: true,
        })
      : result(cell, "invalid", [
          "a read distribution is recorded for a condition with no reads",
        ]);
  const measured = resolveMeasurement(ev, {
    ...cell,
    kind: "measurement",
    name: `P-13 ${cell.condition}: follower read_ms per hint`,
    n: c.hints_followed_by_reads,
  });
  const samples = rawSamples(
    ev,
    `P-13 ${cell.condition}: follower read_ms per hint`,
    cell.engine,
  );
  if (measured.status !== "missing" && !same(samples, readMs))
    return result(cell, "invalid", [
      ...measured.reasons.filter(Boolean),
      "the read series is not the reads the observed transactions give",
    ]);
  return measured;
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
  if (!isObj(file)) return { invalid: `${path} is not a JSON object` };
  const caseKey = cell.source === "p11" ? CASE.p11 : CASE.w2;
  const identity = windowProblems(
    ev,
    { ...cell, case: caseKey },
    file.evidence ?? {},
    caseWindow(ev, { ...cell, case: caseKey }),
  );
  if (cell.source === "w2-live")
    return isObj(file.live)
      ? { run: file.live, identity }
      : { missing: "no live application recorded" };
  const rows = (Array.isArray(file.rows) ? file.rows : []).filter(
    (r) => r?.workload === cell.workload,
  );
  if (rows.length !== 1)
    return { missing: `${rows.length} rows for ${cell.workload}` };
  const runs = Array.isArray(rows[0].runs) ? rows[0].runs : [];
  const want =
    cell.source === "p11" && !P11_VALID.includes(cell.workload) ? 1 : 5;
  if (countsOn(ev.opts) && runs.length !== want)
    return {
      invalid: `${runs.length} cold runs recorded; the programme takes ${want}`,
      identity,
    };
  const run = runs[cell.run - 1];
  if (!isObj(run)) return { missing: `cold run ${cell.run} is missing` };
  const served = servedBytesOf(ev, cell);
  if (served.problem) identity.push(served.problem);
  else if (rows[0].bytes !== served.bytes)
    identity.push(
      `the row records ${rows[0].bytes} served bytes; ${served.what} is ${served.bytes}`,
    );
  return {
    run,
    identity,
    servedBytes: served.bytes ?? null,
    expectedEffects: servedEffectsOf(ev, cell),
  };
}

/**
 * What a cold run's served bytes leave in its new, empty cache (revision 12, review 12 R2, invariant 5), from the same independent
 * sources as `servedBytesOf`: the regenerated workload a P-11 cell names, or the engine's limit-1 W2 capture file (certified by its
 * capture cell). Null when unknown: an admission then cannot be corroborated.
 */
function servedEffectsOf(ev, cell) {
  if (cell.control)
    return {
      exempt:
        "a negative control: an admission fails the control whatever it wrote",
    };
  if (cell.source === "p11")
    return { expected: effectsOfWorkload(cell.workload) };
  const path = `w2/W2-captured.${cell.engine}.limit-1.json`;
  // As for the served bytes (`capturedLimit1`): a defect of the capture stays the capture cell's finding (the programme is incomplete
  // either way), so a W2 run's effects are judged against a capture that is itself a valid W2 capture.
  if (!ev.exists(path)) return { expected: null };
  const capture = captureContent(ev, cell.engine, 1);
  if (
    !capture.row ||
    capture.problems.length > 0 ||
    !(capture.observed?.problems.length === 0)
  )
    return {
      exempt:
        "the limit-1 capture is not a valid W2 capture: its defect is the capture cell's finding",
    };
  return { expected: expectedEffectsOfBody(ev.bytes(path)) };
}

/**
 * The byte length of what a cold run was served, from a source independent of the run's own record (revision 10, review 10 R2 follow-up,
 * design assessment DA-1 and invariant 4): a P-11 workload's recorded size (scripts/lib/profile-workload-hashes.json, the bytes the
 * generator's hash pins), and W2's limit-1 capture, the exact bytes every W2 cold run replays.
 */
function servedBytesOf(ev, cell) {
  if (cell.source === "p11") {
    const workload = RECORDED.workloads.find((w) => w.name === cell.workload);
    return workload
      ? { bytes: workload.bytes, what: `the recorded ${cell.workload}` }
      : { problem: `${cell.workload} is not a recorded workload` };
  }
  return capturedLimit1(ev, cell.engine);
}

/**
 * The limit-1 W2 capture's byte length as the capture value row records it (revision 10, DA-1/DA-2): the W2 cold runs' served bytes and
 * the live density basis. The capture cell certifies that record against the file's own bytes (size, MiB and SHA-256, and its content
 * as the seeded dense batch), so a run is bound to the verified capture through it, and a defect of the capture file stays that cell's
 * finding (and its device dependants') rather than reappearing in every W2 cell; the programme is incomplete either way.
 */
function capturedLimit1(ev, engine) {
  const rows = rowsNamed(ev.values, "P-W2 capture", engine);
  const bytes =
    rows.length === 1 ? rows[0].captures?.limit_1?.bytes : undefined;
  return isCount(bytes) && bytes > 0
    ? {
        bytes,
        what: "the recorded limit-1 capture (certified against its file by the capture cell)",
      }
    : {
        problem:
          "no recorded limit-1 W2 capture size: the served and captured bytes cannot be bound to it",
      };
}

/**
 * Revision 9 (review 9 R2): a cold run's outcome is a verdict only when the ONE observation it was classified from shows it. Revision 10
 * (review 10's R2 follow-up, design assessment DA-1): the observation is a witness whose relations are REQUIRED, judged by the shared rules
 * (scripts/lib/profile-outcome-rules.mjs, the classifier's own): one page instance and one engine start since the mark; every state
 * published since the mark and every commit/step-end event to the step's end retained; the request, its end, the terminal state and the
 * commits recomputed from them and equal to the claims, in the engine's order (a normal end records the published state; a failed step
 * ends in the stop published after it); the first commit after the request of the SERVED bytes (`servedBytes`: the recorded workload or
 * the captured W2 file, never the row's own figure), with its timings; idle only with that commit applied and traced before it. Then the
 * record: its outcome is the one shown, its detail the observed terminal state and an admitted run's figures the first commit's. Revision 12
 * (review 12 R2, contract version 7): the witness is `engine-state-log/3` (a measured attempt that wrote nothing ends it with no verdict),
 * an admission needs the measured page committed, and the run's recorded `effects` must be what its served bytes leave in a new, empty
 * cache (`expectedEffects`, from the regenerated workload or the capture file, never from the run).
 */
function coldObservationProblems(run, servedBytes, servedEffects) {
  if (!["admitted", "refused"].includes(run.outcome)) return [];
  const o = run.observation;
  if (!isObj(o))
    return [
      `a ${run.outcome} run without the observation it was classified from`,
    ];
  const { shows, problems, first } = coldObservationRules(o, {
    servedBytes,
    requests: run.requests,
    effects: run.effects ?? null,
    expectedEffects: servedEffects?.expected ?? null,
    effectsExempt: servedEffects?.exempt ?? null,
  });
  const state = o.terminal?.state;
  if (shows !== run.outcome)
    problems.push(
      `recorded ${run.outcome}, but the observation shows ${shows ?? `no verdict (${isObj(state) ? state.kind : "no terminal state"})`}`,
    );
  if (run.detail !== JSON.stringify(state ?? null).slice(0, 200))
    problems.push("the detail is not the observed terminal state");
  if (run.outcome === "admitted")
    for (const key of ["scan_ms", "commit_ms"])
      if (run[key] !== (first?.[key] ?? null))
        problems.push(
          `${key} ${run[key]} is not the served page's commit (${first?.[key]})`,
        );
  return problems;
}

/**
 * The live application's outcome against its one observation (revision 10, DA-2): judged by the shared rules against the verified
 * limit-1 capture's recorded size (`capturedBytes`, the density basis, never the asserted commit; see `capturedLimit1`) and the page's
 * retained engine trace (the dense commit must be that trace's line at its recorded position, inside the epoch, before the
 * observation's boundary, the first there that met the density, and the idle published after it). The recorded commits are the
 * retained trace's. Revision 11 (review 11's R2 follow-up, DA-L1; contract version 6): the observation (`live-dense-commit/3`) retains
 * its publications and step-event lines; the rules derive the step end that completes it and the publication that end rests on (a normal
 * end records the state published last; a failed step is followed by its local_storage stop), require the claims to equal them, and bind
 * the retained lines to this trace file and the page instance the writer read it from (`trace_page`).
 */
function liveObservationProblems(ev, cell, run) {
  if (!["admitted", "refused"].includes(run.outcome)) return [];
  const o = run.observation;
  if (!isObj(o))
    return [
      `a ${run.outcome} live application without the observation it was classified from`,
    ];
  const tracePath = `w2/P-W2.${cell.engine}.live-engine-trace.txt`;
  const traceLines = ev.exists(tracePath)
    ? ev.bytes(tracePath).toString("utf8").split("\n")
    : null;
  const captured = capturedLimit1(ev, cell.engine);
  const { shows, problems } = liveObservationRules(o, {
    capturedBytes: captured.bytes ?? null,
    traceLines,
    tracePage: run.trace_page ?? null,
  });
  if (captured.problem) problems.unshift(captured.problem);
  if (shows !== run.outcome)
    problems.push(
      `recorded ${run.outcome}, but the observation shows ${shows ?? `no verdict (${o.state_entry?.state?.kind})`}`,
    );
  if (traceLines && !same(run.commits, commitsOfTrace(traceLines)))
    problems.push("the recorded commits are not the retained live trace's");
  return problems;
}

/** W2's capture value row repeats the live application and the cold outcomes: the same, or the representations disagree. */
function w2Duplicates(ev, cell, run) {
  if (cell.item !== "P-W2") return [];
  const value = oneValue(ev, "P-W2 capture", cell.engine);
  if (value.length === 0) return [];
  if (value.length !== 1) return [`${value.length} "P-W2 capture" rows`];
  if (cell.source === "w2-live")
    return same(value[0].live, run)
      ? []
      : ["the capture row's live application is not the file's"];
  return value[0].cold_outcomes?.[cell.run - 1] === run.outcome
    ? []
    : ["the capture row's cold outcome is not the file's"];
}

function resolveOutcome(ev, cell) {
  const source = runsSource(ev, cell);
  if (source.missing) return result(cell, "missing", [source.missing]);
  if (source.invalid) return result(cell, "invalid", [source.invalid]);
  const run = source.run;
  const problems = [...source.identity, ...w2Duplicates(ev, cell, run)];
  if (!OUTCOMES.includes(run.outcome)) problems.push(`outcome ${run.outcome}`);
  if (!isNonNeg(run.elapsed_ms)) problems.push("elapsed_ms is missing");
  if (cell.source !== "w2-live") {
    if (typeof run.detail !== "string")
      problems.push("the outcome's detail is not recorded");
    if (!(run.requests === null || isCount(run.requests)))
      problems.push("the request count is not recorded");
    if (run.outcome === "admitted")
      for (const key of ["scan_ms", "commit_ms"])
        if (!isNonNeg(run[key]))
          problems.push(`an admitted run without its engine ${key}`);
    problems.push(
      ...coldObservationProblems(
        run,
        source.servedBytes,
        source.expectedEffects,
      ),
    );
  } else {
    if (
      run.outcome === "admitted" &&
      (!Array.isArray(run.commits) || run.commits.length === 0)
    )
      problems.push("an admitted live application without its commits");
    problems.push(...liveObservationProblems(ev, cell, run));
  }
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

/**
 * A run's browser memory: renderer-inclusive attribution, complete in every sample, and its figures one observation: the peak is the
 * largest retained sample, the processes at the peak add up to it, the top-level copies equal the attributed record, and the heap peak
 * is the largest heap sample (design assessment A6/E7).
 */
function resolveMemory(ev, cell) {
  const source = runsSource(ev, cell);
  if (source.missing) return result(cell, "missing", [source.missing]);
  if (source.invalid) return result(cell, "invalid", [source.invalid]);
  const run = source.run;
  const rss = run.rss;
  const problems = [...source.identity];
  if (!isObj(rss))
    return result(cell, "invalid", [
      ...problems,
      "no attributed browser memory (rss) record: descendant-only figures are not browser memory",
    ]);
  if (!(rss.samples >= 1)) problems.push("no memory sample was taken");
  if (rss.failed_samples !== 0)
    problems.push(`${rss.failed_samples} memory sample(s) failed`);
  if (rss.complete !== true)
    problems.push(
      `the browser's processes were not all attributed (${(Array.isArray(rss.errors) ? rss.errors : []).join("; ") || "incomplete"})`,
    );
  if (!isNonNeg(rss.peak_kib) || !isNonNeg(rss.baseline_kib))
    problems.push("the peak or baseline is missing");
  if (
    !Array.isArray(rss.series_kib) ||
    rss.series_kib.length !== rss.samples ||
    !rss.series_kib.every(isNonNeg)
  )
    problems.push(
      "the memory samples themselves are not retained (one figure per sample)",
    );
  else if (
    rss.series_kib.length &&
    rss.peak_kib !== Math.max(...rss.series_kib)
  )
    problems.push(
      `the peak ${rss.peak_kib} KiB is not the largest retained sample (${Math.max(...rss.series_kib)})`,
    );
  const atPeak = Array.isArray(rss.processes_at_peak)
    ? rss.processes_at_peak
    : null;
  if (
    !atPeak ||
    atPeak.length === 0 ||
    !atPeak.every((p) => isNonNeg(p?.rss_kib) && Number.isInteger(p?.pid))
  )
    problems.push("the processes at the peak are not recorded");
  else {
    if (atPeak.reduce((n, p) => n + p.rss_kib, 0) !== rss.peak_kib)
      problems.push("the processes at the peak do not add up to the peak");
    const identities = new Set(
      Array.isArray(rss.process_identities) ? rss.process_identities : [],
    );
    if (!atPeak.every((p) => identities.has(`${p.pid}@${p.start}`)))
      problems.push(
        "a process at the peak is not among the run's recorded identities",
      );
  }
  for (const [top, nested] of [
    ["rss_peak_kib", "peak_kib"],
    ["rss_baseline_kib", "baseline_kib"],
    ...(cell.source === "w2-live" ? [] : [["rss_after_kib", "after_kib"]]),
  ])
    if (run[top] !== rss[nested])
      problems.push(`${top} is not the attributed record's ${nested}`);
  if (
    cell.engine === "webkit" &&
    rss.platform === "darwin" &&
    !(rss.webkit_hosts >= 1)
  )
    problems.push(
      "WebKit on macOS without its host's launchd services: the renderer is not counted",
    );
  const heap = run.heap_samples_bytes;
  if (!Array.isArray(heap) || !heap.every(isNonNeg))
    problems.push(
      "the heap samples are not retained (an empty list where the engine has none)",
    );
  else if (run.heap_peak_bytes !== (heap.length ? Math.max(...heap) : null))
    problems.push("the heap peak is not the largest heap sample");
  if (cell.engine === "chromium" && !isNonNeg(run.heap_peak_bytes))
    problems.push("Chromium's JS heap peak is missing");
  return problems.length
    ? result(cell, "invalid", problems)
    : result(cell, "ok");
}

/** The shape of one batch as the integration writer measures it: changes, dense checklist field upserts, and whether `person` is in it. */
function batchShape(batch, person) {
  const changes = Array.isArray(batch?.changes) ? batch.changes : [];
  return {
    changes: changes.length,
    checklist_upserts: changes.filter(
      (c) =>
        c?.kind === "upsert" &&
        c.resource?.kind === "field" &&
        c.resource.value?.kind === "checklist",
    ).length,
    person_ancestor: changes.some(
      (c) => c?.kind === "upsert" && c.resource?.id === person,
    ),
  };
}
/**
 * One engine's W2 capture at one limit, observed from its bytes (scripts/lib/profile-w2-capture.mjs; revision 4, review 4 R2, design
 * assessment A1-A4) and reconciled with what the writer recorded: the page is a valid sync page and its seeded batch is the seed exactly
 * (the person and 199 distinct dense checklists of 100 items and 40 checked ids each, in one batch of 200 changes); the recorded
 * file, size, MiB, SHA-256, phase, batch and change counts, has_more and generic batch shapes follow from the bytes; the seeding's
 * field count and value size are the observed ones; and the two limits show the same seeded batch. A matching hash or a parsed
 * document is never enough on its own. Cached per (engine, limit): the capture cells and the device cells read the same observation.
 */
function captureContent(ev, engine, limit) {
  const key = `w2:${engine}:${limit}`;
  if (ev[key]) return ev[key];
  const kept = (value) => {
    ev[key] = value;
    return value;
  };
  const path = `w2/W2-captured.${engine}.limit-${limit}.json`;
  if (!ev.exists(path)) return kept({ path, missing: true, problems: [] });
  const rows = rowsNamed(ev.values, "P-W2 capture", engine);
  if (rows.length !== 1)
    return kept({
      path,
      rows,
      problems: [`${rows.length} "P-W2 capture" rows`],
    });
  const row = rows[0];
  const bytes = ev.bytes(path);
  const person = row.seeding?.person;
  const observed = observeW2Capture(bytes, { person, limit });
  const problems = [...observed.problems];
  const recorded = row.captures?.[`limit_${limit}`];
  if (!isObj(recorded))
    problems.push("the capture is not recorded in its value row");
  else {
    if (recorded.sha256 !== sha256(bytes))
      problems.push("the capture's SHA-256 is not the recorded one");
    if (recorded.bytes !== bytes.length)
      problems.push("the capture's size is not the recorded one");
    if (recorded.mib !== +(bytes.length / 1_048_576).toFixed(3))
      problems.push("the capture's MiB does not follow from its size");
    if (recorded.file !== path)
      problems.push(`the recorded file is ${recorded.file}, not ${path}`);
    if (observed.page) {
      const batches = JSON.parse(bytes.toString("utf8")).batches;
      const derived = {
        phase: observed.page.phase,
        batches: observed.page.batches,
        changes: observed.page.changes,
        has_more: observed.page.has_more,
        batch_shapes: batches.map((b) => batchShape(b, person)),
      };
      for (const [name, want] of Object.entries(derived))
        if (!same(recorded[name], want))
          problems.push(
            `the recorded ${name} does not follow from the captured bytes`,
          );
    }
  }
  const seeding = row.seeding;
  if (!isObj(seeding)) problems.push("the seeding is not recorded");
  else {
    if (seeding.dense_fields !== W2_SEED.fields)
      problems.push(
        `the seeding records ${seeding.dense_fields} dense fields; the W2 seed is ${W2_SEED.fields}`,
      );
    if (observed.target && seeding.value_bytes !== observed.target.value_bytes)
      problems.push(
        `the seeding records ${seeding.value_bytes}-byte checklist values; the captured ones are ${observed.target.value_bytes} bytes`,
      );
  }
  const out = kept({ path, row, observed, problems });
  // The other limit of the same engine must show the same seeded batch (revision and contents). It is compared only when its own bytes
  // are a valid capture: a defect of the other limit stays that limit's finding, never this one's.
  const other = captureContent(ev, engine, limit === 1 ? 80 : 1);
  if (other.observed && other.observed.problems.length === 0)
    problems.push(...sameTargetProblems(observed, other.observed));
  return out;
}

function resolveCapture(ev, cell) {
  const content = captureContent(ev, cell.engine, cell.limit);
  if (content.missing)
    return result(cell, "missing", [`${content.path} is missing`]);
  if (!content.row) return result(cell, "invalid", content.problems);
  const problems = [
    ...windowProblems(ev, cell, content.row, content.row.collection),
    ...content.problems,
  ];
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
    // Schema 4: the W2 runs' expected effects come from this engine's capture bytes, when that capture is itself valid (otherwise its
    // defect stays the capture cell's finding, as for the cold runs).
    const content = w2 ? captureContent(ev, engine, 1) : null;
    const captureValid =
      content?.row &&
      content.problems.length === 0 &&
      content.observed?.problems.length === 0;
    const checked = checkDeviceResults(entry.value, {
      recorded: RECORDED,
      w2Hashes: new Set(w2 ? [w2] : []),
      w2Expected: w2,
      w2Bytes: new Map(w2 && captureValid ? [[w2, ev.bytes(capture)]] : []),
      w2EffectsExempt:
        w2 && !captureValid
          ? "the limit-1 capture is not a valid W2 capture: its defect is the capture cell's finding"
          : null,
    });
    const binder = rowsNamed(ev.values, "P-11 device page", engine);
    const invalid = [...checked.errors];
    if (!w2) invalid.push("this engine's W2 capture is missing");
    // Its hash identifies bytes; only the observed contents make them the W2 the protocol had to run (revision 4, review 4 R2, A4).
    else if (!(captureContent(ev, engine, 1).observed?.problems.length === 0))
      invalid.push(
        "this engine's limit-1 W2 capture is not a valid W2 capture (see its capture cell): the protocol's W2 runs are not of the dense batch",
      );
    if (binder.length !== 1)
      invalid.push(
        `${binder.length} "P-11 device page" rows bind the file to its run`,
      );
    else {
      const b = binder[0];
      if (b.results_sha256 !== entry.sha256)
        invalid.push("the results file is not the one its run recorded");
      if (b.results_file !== path)
        invalid.push("the binder names another results file");
      if (b.protocol_id !== entry.value?.protocol_id)
        invalid.push("the binder names another protocol");
      if (
        b.runs !==
        (Array.isArray(entry.value?.runs) ? entry.value.runs.length : null)
      )
        invalid.push("the binder's run count is not the file's");
      if (b.w2_capture?.sha256 !== w2 || b.w2_capture?.file !== capture)
        invalid.push(
          "the binder's capture is not this engine's limit-1 capture",
        );
      if (
        !isObj(b.browser_memory_whole_protocol) ||
        typeof b.browser_memory_whole_protocol.complete !== "boolean"
      )
        invalid.push("the protocol's aggregate memory record is not recorded");
    }
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
  const runs = (Array.isArray(d.data.runs) ? d.data.runs : []).filter(
    (r) => r?.workload === cell.workload && r?.run === cell.run,
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

/** Malformed evidence is a finding of its cell, with its path, never an exception that stops the resolution (assessment A8/E10). */
function resolveCell(ev, cell) {
  try {
    return RESOLVERS[cell.kind](ev, cell);
  } catch (error) {
    return result(cell, "invalid", [
      `malformed evidence: ${String(error?.message ?? error).slice(0, 200)}`,
    ]);
  }
}

/** The valid-workload outcomes that were not `admitted`: facts, whatever else is missing. */
function failuresOf(cells) {
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
  return failures;
}

/**
 * Resolves the whole contract against an evidence directory: one status per required cell, the lists by status, the derived desktop
 * conclusions and the item statuses. Unknown or duplicate evidence never substitutes for a required cell.
 *
 * `relaxed` (qualification of a real writer with shortened samples, never a programme's evidence): sample counts, stage/invocation/window
 * identity and isolation are not judged; every content and cross-representation check still is.
 */
export function resolveEvidence(
  dir,
  { engines = ENGINES, relaxed = false } = {},
) {
  const ev = loadEvidence(dir);
  ev.relaxed = relaxed;
  ev.opts = { counts: !relaxed };
  const required = requiredCells(engines);
  const cells = required.map((cell) => {
    const resolved = resolveCell(ev, cell);
    return {
      ...resolved,
      kind: cell.kind,
      ...pick(cell, ["workload", "run", "control", "source"]),
    };
  });
  const ids = (status) =>
    cells.filter((c) => c.status === status).map((c) => c.id);
  const failures = failuresOf(cells);
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

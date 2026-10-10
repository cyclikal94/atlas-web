// A COMPLETE synthetic sync-profiling programme, for the qualification of the evidence contract (WEB-09c revision 2, design assessment
// Q1). SYNTHETIC: no browser, backend or measurement ran; every figure is made up. It is written from what the programme's WRITERS produce
// (the specs, the shell boot, the drivers), independently of scripts/lib/profile-contract.mjs: it imports nothing from the contract, so a
// requirement dropped from the contract, or a check that stops looking, is caught by the qualification cases rather than mirrored here.
//
// `writeProgramme(dir, options)` writes a whole evidence directory whose every required observation is present, well formed, consistent
// with its raw samples and windows, and (unless `busy` says otherwise) taken with no foreign heavy work. Cases then remove or alter one
// thing and expect the exact cell the contract must name.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  readFileSync(join(here, "../lib/profile-workload-hashes.json"), "utf8"),
);
const sha = (x) => createHash("sha256").update(x).digest("hex");
export const ENGINES = ["chromium", "firefox", "webkit"];
const STAGE_ORDER = [
  "bundle",
  "fixture",
  "shell",
  "contention",
  "integration",
  "device",
];
const INTERVAL = 5_000;
const W7 = recorded.workloads
  .map((w) => w.name)
  .filter((n) => n.startsWith("W7-"));

// The writers' own quantile (tests/e2e/profile-helpers.ts `record`), written out again here.
const pick = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const three = (x) => +Number(x).toFixed(3);
function summaryOf(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    min: three(s[0]),
    p50: three(pick(s, 0.5)),
    p95: three(pick(s, 0.95)),
    p99: three(pick(s, 0.99)),
    max: three(s.at(-1)),
  };
}

/**
 * Writes the programme. `candidate`: the stage records' candidate (the hand-over refuses another source fingerprint). `busy(stage, s)`:
 * the foreign heavy processes seen at second `s` of that stage. `controlOutcome`: what every W7 control did.
 */
export function writeProgramme(
  dir,
  {
    candidate,
    busy = () => [],
    controlOutcome = "refused",
    invocation = "inv-synthetic",
  } = {},
) {
  const files = new Map();
  const put = (name, text) => files.set(name, text);
  const json = (name, value) =>
    put(name, `${JSON.stringify(value, null, 2)}\n`);
  const base = Date.now() - 6 * 3600_000;
  // Each stage gets its own hour; its action runs from second 0 to second 3000 of it.
  const t = (stage, s) =>
    new Date(
      base + STAGE_ORDER.indexOf(stage) * 3600_000 + s * 1000,
    ).toISOString();
  const measurements = [];
  const values = [];
  const collection = [];
  const caseWindow = new Map();

  for (const stage of STAGE_ORDER) {
    json(`stages/${stage}.json`, {
      evidence_key: "WEB-09a:sync-profiling",
      owner: "WEB-09c",
      stage,
      contract_version: 1,
      invocation,
      started_at: t(stage, -10),
      candidate,
      debugging_samples: null,
      action_started_at: t(stage, 0),
      action_finished_at: t(stage, 3000),
      finished_at: t(stage, 3010),
      exit_status: 0,
      sealed: true,
      sampler: { ready: true, final_sample: true, exit_code: 0, samples: 603 },
      failure: null,
    });
    const samples = [];
    for (let s = -5; s <= 3005; s += INTERVAL / 1000) {
      const foreign = busy(stage, s);
      samples.push({
        at: t(stage, s),
        interval_ms: INTERVAL,
        foreign_heavy: foreign,
        foreign_heavy_cpu_percent: foreign.length ? 180 : 0,
        other_cpu_percent: 10,
      });
    }
    samples[samples.length - 1].final = true;
    put(
      `isolation/${stage}.jsonl`,
      `${samples.map((x) => JSON.stringify(x)).join("\n")}\n`,
    );
  }

  // The cases each spec runs, per engine, each in its own window of its stage.
  const CASES = {
    fixture: [
      "P-2: synthetic",
      "P-3: synthetic",
      "P-5: synthetic",
      "P-11: synthetic",
      "P-Q: synthetic",
      "P-5 (dense): synthetic",
      "P-Q2: synthetic",
    ],
    contention: [
      "P-7 and P-8: synthetic",
      "P-7: a frozen owner synthetic",
      "P-7: the PRODUCTION lock wait synthetic",
      "P-6: synthetic",
      "P-9: synthetic",
      "P-13: synthetic",
    ],
    integration: [
      "P-4: what the page does around ONE sync page synthetic",
      "P-4: what the page does around ONE draft submission synthetic",
      "P-10: synthetic",
      "W2: synthetic",
      "W2-limits: synthetic",
    ],
    device: ["P-11 (device page): synthetic"],
  };
  for (const [stage, titles] of Object.entries(CASES))
    for (const [e, engine] of ENGINES.entries())
      for (const [i, test] of titles.entries()) {
        const from = 10 + (e * titles.length + i) * 100;
        const window = { test, from: t(stage, from), to: t(stage, from + 90) };
        caseWindow.set(`${engine}|${test.split(" synthetic")[0]}`, window);
        collection.push({
          ...window,
          engine,
          status: "passed",
          expected_status: "passed",
          retry: 0,
          stage,
          invocation,
        });
      }
  const windowOf = (engine, title) => {
    const w = caseWindow.get(`${engine}|${title}`);
    if (!w) throw new Error(`no synthetic case ${title}`);
    return { test: w.test, from: w.from, to: w.to };
  };
  const ident = (stage, engine, name, title) => ({
    id: `${name}[${engine}]`,
    name,
    engine,
    stage,
    invocation,
    at: windowOf(engine, title).to,
    collection: windowOf(engine, title),
  });
  const series = (
    stage,
    engine,
    title,
    name,
    n,
    value = (i) => 10 + (i % 7),
  ) => {
    const samples = Array.from({ length: n }, (_, i) => value(i));
    const safe = `${name}.${engine}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const raw = `${JSON.stringify({ name, engine, samples })}\n`;
    put(`raw/${safe}.json`, raw);
    measurements.push({
      ...summaryOf(samples),
      raw: `raw/${safe}.json`,
      raw_sha256: sha(raw),
      ...ident(stage, engine, name, title),
    });
    return samples;
  };
  const value = (stage, engine, title, name, v) =>
    values.push({ ...v, ...ident(stage, engine, name, title) });
  const stamp = (stage, engine, title) => ({
    stage,
    invocation,
    collection: windowOf(engine, title),
  });
  const rss = (engine) => ({
    scope: "synthetic",
    platform: "darwin",
    webkit_hosts: engine === "webkit" ? 1 : 0,
    baseline_kib: 200_000,
    peak_kib: 300_000,
    after_kib: 210_000,
    samples: 40,
    failed_samples: 0,
    complete: true,
    errors: [],
    processes_at_peak: [],
    process_identities: [],
  });
  const coldRun = (engine, outcome = "admitted") => ({
    outcome,
    detail: "",
    elapsed_ms: 1200,
    scan_ms: outcome === "admitted" ? 40 : null,
    commit_ms: outcome === "admitted" ? 300 : null,
    requests: 2,
    heap_baseline_bytes: engine === "chromium" ? 1e7 : null,
    heap_peak_bytes: engine === "chromium" ? 5e7 : null,
    heap_after_gc_bytes: engine === "chromium" ? 1.1e7 : null,
    rss_baseline_kib: 200_000,
    rss_peak_kib: 300_000,
    rss_after_kib: 210_000,
    rss: rss(engine),
  });

  // ---- bundle (P-1) ----
  const budgets = {};
  for (const build of ["dist", "dist-fixture"]) {
    const profile = `${JSON.stringify({ measured: { initial_js_gzip: 100_000, css_gzip: 7000, fonts: 80_000 }, failures: [] })}\n`;
    put(`bundle/bundle-profile-${build}.json`, profile);
    budgets[build] = {
      exit: 0,
      build,
      file: `bundle/bundle-profile-${build}.json`,
      sha256: sha(profile),
    };
  }
  json("bundle-delta.json", {
    id: "P-1",
    status: "measured",
    initial_js_gzip: 100_000,
    initial_chunks: ["assets/index.js"],
    dexie_in_initial_chunk: false,
    budgets,
  });

  // ---- shell (P-1S): two builds x two viewports x two networks x three runs, each with its window ----
  let shellSecond = 20;
  for (const build of ["dist", "dist-fixture"]) {
    const results = [];
    for (const viewport of ["mobile", "desktop"])
      for (const network of ["fast-4g", "slow-4g"]) {
        const raw = [1, 2, 3].map((run) => {
          const from = t("shell", shellSecond);
          shellSecond += 30;
          return {
            run,
            lcp: 900 + run,
            cls: 0,
            fcp: 700 + run,
            fontsStart: 1,
            fontsDone: 800,
            transferBytes: 200_000,
            requests: 12,
            fonts: 2,
            fontsLoaded: 2,
            fout: 100,
            script_encodings: { gzip: 3 },
            from,
            to: t("shell", shellSecond - 5),
          };
        });
        results.push({
          viewport,
          network,
          cpuThrottle: 4,
          runs: 3,
          runs_completed: 3,
          lcp_ms: 902,
          fcp_ms: 702,
          cls: 0,
          raw,
        });
      }
    json(`shell/${build}.json`, {
      url: "http://127.0.0.1:1/",
      build,
      evidence: { stage: "shell", invocation },
      results,
    });
  }

  for (const engine of ENGINES) {
    // ---- fixture: P-2, P-3, P-5, P-11, P-Q, P-Q2 ----
    for (const [shape, n] of [
      ["ordinary-100", 300],
      ["ordinary-200", 300],
      ["ordinary-400", 300],
      ["ordinary-800", 300],
      ["dense-100", 60],
      ["dense-200", 40],
      ["dense-400", 25],
      ["dense-800-W1", 15],
    ]) {
      for (const metric of ["wall_ms", "scan_ms", "commit_ms"])
        series("fixture", engine, "P-2:", `P-2 ${shape} ${metric}`, n);
      if (engine === "chromium")
        series(
          "fixture",
          engine,
          "P-2:",
          `P-2 ${shape} long_task_ms_per_page`,
          n,
        );
      else
        value("fixture", engine, "P-2:", `P-2 ${shape} long_task_ms_per_page`, {
          capability: "unavailable",
          reason: "this engine has no longtask observer",
        });
    }
    put(`raw/P-2.trace.${engine}.txt`, "0ms data.sync_commit {}\n");
    for (const kind of ["draft", "fence", "form_recovery"])
      for (const d of ["strict", "default"])
        series("fixture", engine, "P-3:", `P-3 ${kind} ${d} write_ms`, 300);
    const drains = series(
      "fixture",
      engine,
      "P-5:",
      "P-5 drain_200_ms",
      20,
      (i) => 2000 + i,
    );
    series(
      "fixture",
      engine,
      "P-5:",
      "P-5 per_draft_ms",
      20,
      (i) => drains[i] / 200,
    );
    value("fixture", engine, "P-5:", "P-5 maxInFlight_2_and_3", {
      status: "not_run",
      reason: "decision D-18 fixes maxInFlight at 1",
    });
    const dense = series(
      "fixture",
      engine,
      "P-5 (dense):",
      "P-5 dense drain_201_ms",
      20,
      (i) => 4000 + i,
    );
    series(
      "fixture",
      engine,
      "P-5 (dense):",
      "P-5 dense per_draft_ms",
      20,
      (i) => dense[i] / 201,
    );
    const rows = [];
    for (const workload of ["W1", "W3", "W4", "W6"])
      rows.push({
        workload,
        expected: "admitted",
        runs: [1, 2, 3, 4, 5].map(() => coldRun(engine)),
      });
    for (const workload of W7)
      rows.push({
        workload,
        expected: "refused",
        runs: [coldRun(engine, controlOutcome)],
      });
    json(`memory/P-11.${engine}.json`, {
      engine,
      rows,
      evidence: stamp("fixture", engine, "P-11:"),
    });
    for (const row of rows) {
      series(
        "fixture",
        engine,
        "P-11:",
        `P-11 ${row.workload} elapsed_ms`,
        row.runs.length,
        () => 1200,
      );
      series(
        "fixture",
        engine,
        "P-11:",
        `P-11 ${row.workload} rss_peak_kib`,
        row.runs.length,
        () => 300_000,
      );
      if (engine === "chromium")
        series(
          "fixture",
          engine,
          "P-11:",
          `P-11 ${row.workload} heap_peak_bytes`,
          row.runs.length,
          () => 5e7,
        );
      else
        value(
          "fixture",
          engine,
          "P-11:",
          `P-11 ${row.workload} heap_peak_bytes`,
          {
            capability: "unavailable",
            reason: "no heap signal outside Chromium",
          },
        );
    }
    const footprint = {
      usage: 1000,
      quota: 1e9,
      indexeddb: engine === "chromium" ? 900 : null,
    };
    value("fixture", engine, "P-Q:", "P-Q footprints", {
      note: "synthetic",
      baseline: footprint,
      empty_account_database: footprint,
      with_200_drafts: footprint,
      one_draft_with_1_mib_payload: footprint,
      atlas_auth_steady: footprint,
      atlas_auth_100_fences_200_leases: footprint,
    });
    value("fixture", engine, "P-Q2:", "P-Q2 quota reserve inputs", {
      atlas_auth_burst: {
        pages: 3,
        requests_per_page: 20,
        held_at_once: 20,
        outcomes: Array.from({ length: 60 }, () => "sent"),
      },
      estimate_granularity: {
        rows: Array.from({ length: 15 }, (_, i) => ({
          added_bytes: 1024 * 2 ** i,
        })),
      },
      ledger: {
        reservations: 100,
        bytes_each: 1024,
        verdicts: { granted: 100 },
      },
      quota_reserve_bytes_in_use: 8 * 1024 * 1024,
    });

    // ---- contention: P-6 to P-9, P-13 ----
    const causes = {
      tab_closed_cleanly_mid_request: 40,
      tab_killed_mid_request_simulated: 100,
      slow_handling_injected: 50,
      failing_recording_injected: 50,
      ...(engine === "chromium"
        ? { tab_crashed_mid_request_chromium: 60 }
        : {}),
    };
    const p6rows = [];
    const byCause = {};
    for (const [cause, n] of Object.entries(causes)) {
      for (let i = 0; i < n; i += 1) p6rows.push({ cause, first: "released" });
      byCause[cause] = {
        n,
        precondition_met: n,
        saw_unresolved: 0,
        never_resolved: 0,
      };
      value("contention", engine, "P-6:", `P-6 ${cause}`, {
        ...byCause[cause],
      });
    }
    json(`contention/unresolved-leases.${engine}.json`, {
      id: "P-6",
      engine,
      scenarios: p6rows.length,
      by_cause: byCause,
      rows: p6rows,
      evidence: stamp("contention", engine, "P-6:"),
    });
    for (const condition of [
      "no leader",
      "back-to-back leader, 5 ms apart (platform yield)",
    ]) {
      for (const wait of [
        "ordinary request",
        "exposure (visible to lifted)",
        "atlas-auth writer (begin)",
      ])
        series(
          "contention",
          engine,
          "P-7 and P-8:",
          `P-7 ${wait}, ${condition}`,
          100,
        );
      series(
        "contention",
        engine,
        "P-7 and P-8:",
        `P-7 closing write (logout initiation), ${condition}`,
        30,
      );
    }
    json(`contention/retirements.${engine}.json`, {
      id: "P-8",
      engine,
      conditions: [{ condition: "no leader" }, { condition: "leader" }],
      evidence: stamp("contention", engine, "P-7 and P-8:"),
    });
    const frozen = [100, 250, 500, 750, 1000, 1500, 2500].flatMap((freeze_ms) =>
      Array.from({ length: 15 }, () => ({
        freeze_ms,
        gave_up: freeze_ms > 1000,
        waited_ms: 900,
        outcome: "x",
      })),
    );
    json(`contention/frozen-owner.${engine}.json`, {
      id: "P-7 frozen owner",
      engine,
      scaled_lock_wait_ms: 1000,
      rows: frozen,
      evidence: stamp("contention", engine, "P-7: a frozen owner"),
    });
    series(
      "contention",
      engine,
      "P-7: a frozen owner",
      "P-7 frozen owner: writer wait (scaled 1 s)",
      105,
    );
    json(`contention/frozen-owner-production-wait.${engine}.json`, {
      engine,
      lock_wait_ms: 20_000,
      freeze_ms: 23_000,
      rows: [
        { outcome: "lock_timeout", waited_ms: 20_010 },
        { outcome: "lock_timeout", waited_ms: 20_020 },
      ],
      evidence: stamp("contention", engine, "P-7: the PRODUCTION lock wait"),
    });
    for (const policy of ["none", "macrotask", "scheduler_yield", "idle"]) {
      for (const wait of ["ordinary request", "exposure", "atlas-auth writer"])
        series("contention", engine, "P-9:", `P-9 ${policy}: ${wait} wait`, 50);
      series(
        "contention",
        engine,
        "P-9:",
        `P-9 ${policy}: catch-up throughput (pages/s, 200 pages, no probe)`,
        5,
      );
    }
    json(`contention/yield-policy.${engine}.json`, {
      engine,
      engine_support: {
        scheduler_yield: engine === "chromium",
        request_idle_callback: true,
      },
      rows: ["none", "macrotask", "scheduler_yield", "idle"].map((policy) => ({
        policy,
      })),
      evidence: stamp("contention", engine, "P-9:"),
    });
    const reads = {
      "none (control)": [0, 0],
      "leader pages": [200, 150],
      "stop-record hints (synthetic)": [200, 120],
      "drafts and receipts": [400, 100],
    };
    json(`contention/follower-reads.${engine}.json`, {
      engine,
      conditions: Object.entries(reads).map(
        ([condition, [hints, withReads]]) => ({
          condition,
          hints,
          hints_followed_by_reads: withReads,
        }),
      ),
      evidence: stamp("contention", engine, "P-13:"),
    });
    for (const [condition, [, withReads]] of Object.entries(reads))
      if (withReads > 0)
        series(
          "contention",
          engine,
          "P-13:",
          `P-13 ${condition}: follower read_ms per hint`,
          withReads,
        );
    for (const followers of [0, 1, 2])
      series(
        "contention",
        engine,
        "P-13:",
        `P-13 leader catch-up throughput (pages/s, 200 pages), ${followers} follower(s)`,
        3,
      );

    // ---- integration: P-4, P-10, P-W2, W2-limits ----
    const syncRequest = Array.from({ length: 300 }, (_, i) => 5 + (i % 3));
    for (const seg of ["pre_issue_ms", "post_response_ms", "total_ms"])
      series(
        "integration",
        engine,
        "P-4: what the page does around ONE sync page",
        `P-4 sync page ${seg}`,
        300,
      );
    series(
      "integration",
      engine,
      "P-4: what the page does around ONE sync page",
      "P-4 sync page request_ms",
      300,
      (i) => syncRequest[i],
    );
    series(
      "integration",
      engine,
      "P-4: what the page does around ONE sync page",
      "P-10 sync page request_ms (unthrottled loopback)",
      300,
      (i) => syncRequest[i],
    );
    const draftRequest = Array.from({ length: 300 }, (_, i) => 6 + (i % 4));
    for (const seg of [
      "enqueue_ms",
      "claim_ms",
      "stamping_ms",
      "record_ms",
      "total_ms",
    ])
      series(
        "integration",
        engine,
        "P-4: what the page does around ONE draft submission",
        `P-4 draft ${seg}`,
        300,
      );
    series(
      "integration",
      engine,
      "P-4: what the page does around ONE draft submission",
      "P-4 draft request_ms",
      300,
      (i) => draftRequest[i],
    );
    series(
      "integration",
      engine,
      "P-4: what the page does around ONE draft submission",
      "P-10 draft request_ms (unthrottled loopback)",
      300,
      (i) => draftRequest[i],
    );
    series(
      "integration",
      engine,
      "P-10:",
      "P-10 sync page duration_ms (proxy delay 250 ms)",
      100,
      () => 260,
    );
    value("integration", engine, "W2:", "backend", {
      health: { status: 200, body: {} },
      revision: null,
    });
    const captures = {};
    for (const limit of [1, 80]) {
      const text = `{"phase":"delta","limit":${limit},"engine":"${engine}"}`;
      put(`w2/W2-captured.${engine}.limit-${limit}.json`, text);
      captures[`limit_${limit}`] = {
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
        changes: 200,
        batch_shapes: [{ checklist_upserts: 199, person_ancestor: true }],
      };
    }
    const live = {
      ...coldRun(engine),
      scan_ms: undefined,
      commit_ms: undefined,
    };
    json(`w2/P-W2.${engine}.json`, {
      engine,
      live,
      rows: [
        {
          workload: "W2",
          expected: "admitted",
          runs: [1, 2, 3, 4, 5].map(() => coldRun(engine)),
        },
      ],
      evidence: stamp("integration", engine, "W2:"),
    });
    put(`w2/P-W2.${engine}.live-engine-trace.txt`, "trace\n");
    value("integration", engine, "W2:", "P-W2 capture", {
      status: "measured",
      captures,
    });
    series("integration", engine, "W2:", "P-W2 elapsed_ms", 5, () => 1500);
    series("integration", engine, "W2:", "P-W2 rss_peak_kib", 5, () => 300_000);
    if (engine === "chromium")
      series(
        "integration",
        engine,
        "W2:",
        "P-W2 heap_peak_bytes",
        5,
        () => 5e7,
      );
    else
      value("integration", engine, "W2:", "P-W2 heap_peak_bytes", {
        capability: "unavailable",
        reason: "no heap signal outside Chromium",
      });
    value("integration", engine, "W2:", "P-W2 observed bound", {
      revoke: { status: 200 },
      delivered: { status: 200 },
    });
    value("integration", engine, "W2-limits:", "W2-limits", {
      status: "measured",
      probe: {},
    });

    // ---- device: the page's whole protocol, schema 2, one protocol, this engine's capture ----
    const w2sha = captures.limit_1.sha256;
    const protocolId = `protocol-${engine}`;
    const runs = [];
    for (const name of [...recorded.workloads.map((w) => w.name), "W2"]) {
      const n = ["W1", "W2", "W3", "W4", "W6"].includes(name) ? 5 : 1;
      for (let run = 1; run <= n; run += 1) {
        const control = name.startsWith("W7-");
        runs.push({
          protocol_id: protocolId,
          workload: name,
          run,
          cold: true,
          expected: control ? "refused" : "admitted",
          outcome: control ? controlOutcome : "admitted",
          detail: "",
          sha256:
            name === "W2"
              ? w2sha
              : recorded.workloads.find((w) => w.name === name).sha256,
          sha256_verified: true,
          bytes: 1,
          elapsed_ms: 1,
          user_agent: "synthetic",
        });
      }
    }
    const results = `${JSON.stringify(
      {
        schema: 2,
        kind: "protocol",
        protocol_id: protocolId,
        workload_version: recorded.version,
        w2sha256: w2sha,
        machine: {
          user_agent: "synthetic",
          device_memory_gib: null,
          hardware_concurrency: 8,
          platform: "synthetic",
          secure_context: true,
        },
        runs,
      },
      null,
      2,
    )}\n`;
    put(`device-page/results.${engine}.json`, results);
    value("device", engine, "P-11 (device page):", "P-11 device page", {
      runs: runs.length,
      protocol_id: protocolId,
      results_sha256: sha(results),
    });
  }
  put(
    "measurements.jsonl",
    `${measurements.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  put("values.jsonl", `${values.map((x) => JSON.stringify(x)).join("\n")}\n`);
  put(
    "collection.jsonl",
    `${collection.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  for (const [name, text] of files) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { at: t, invocation };
}

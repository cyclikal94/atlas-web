// A COMPLETE synthetic sync-profiling programme, for the qualification of the evidence contract (WEB-09c revision 2, design assessment
// Q1; revision 3, review 3 R2 and design assessment E1). SYNTHETIC: no browser, backend or measurement ran; every figure is made up. It is
// written from what the programme's WRITERS produce (the specs, the shell boot, the drivers), independently of
// scripts/lib/profile-contract.mjs and scripts/lib/profile-projection.mjs: it imports neither, so a requirement dropped from the contract, or
// a check that stops looking, is caught by the qualification cases rather than mirrored here.
//
// Revision 3: every observation carries its CONTENTS, not only its cardinality (review 3 R2: the revision-2 fixture held 60 null quota
// outcomes, empty ladder rows, condition names without retirement counts and metadata-only captures, and was accepted as complete). Related
// samples carry deliberately distinct values (every series, run, engine and condition differs), so a swapped run, engine or condition, a
// unit error or a mismatched copy cannot hide behind constant arrays. Derived figures are computed here the way each writer computes them
// (written out again, not imported), and the support each is recomputed from is kept: P-Q2's readings, P-8's trace events, P-13's
// hints and transactions, every memory and heap sample, the W2 capture's real-shaped bytes and its seeded person.
//
// Revision 8 (review 8 R1): every stage record carries the invocation's isolation context (contract version 3) and every load sample is
// bound to it: the method, the invocation, stage, root pid and start, the stage's sampler process, and the identities its verdict rests on
// (the own tree with the root in it, foreign processes as records agreeing with the display strings, support processes). The literals
// are written out here, not imported, for the same reason.
//
// `writeProgramme(dir, options)` writes a whole evidence directory whose every required observation is present, well formed, consistent
// with its raw samples and windows, and (unless `busy` says otherwise) taken with no foreign heavy work. Cases then remove or alter one
// thing and expect the exact cell the contract must name.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const SHARED = ["measurements.jsonl", "values.jsonl", "collection.jsonl"];
const INTERVAL = 5_000;
/** The synthetic invocation root (pid and `ps lstart` start) and each stage's sampler process. */
export const ROOT_PID = 4242;
export const ROOT_STARTED = "Mon Oct 12 09:00:00 2026";
const SAMPLER_PID = (stage) => 5000 + STAGE_ORDER.indexOf(stage);
const W7 = recorded.workloads
  .map((w) => w.name)
  .filter((n) => n.startsWith("W7-"));
export const PERSON = "5eed0000-0000-4000-8000-000000000001";
export const BOUND_PERSON = "5eed0000-0000-4000-8000-000000000002";

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
/** A number of its own for every (name, index): distinct series, distinct samples, reproducible. */
function seeded(name) {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}
const sampleOf = (name, i, base = 5) =>
  base + ((seeded(name) + i * 7919) % 997) / 10;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** The page's protocol order (src/fixture/data-harness/profile-capture.ts `protocolPlan`), written out again: W2 after W1. */
function plan() {
  const names = recorded.workloads.flatMap((w) =>
    w.name === "W1" ? ["W1", "W2"] : [w.name],
  );
  return names.flatMap((name) =>
    Array.from(
      { length: ["W1", "W2", "W3", "W4", "W6"].includes(name) ? 5 : 1 },
      (_, i) => ({ name, run: i + 1 }),
    ),
  );
}

/** A UUID of its own for every tag (version-4 layout, lower-case hex), reproducible. */
const uuidOf = (tag) => {
  const h = sha(tag);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** A projection as the released backend renders one in `/sync` (every field the contract requires, and the policy version). */
const projection = (id, kind, parentId, label, value, policyVersion) => ({
  id,
  kind,
  parent_id: parentId,
  label,
  value,
  version: 1,
  policy_version: policyVersion,
  can_edit: false,
  archived: false,
});
/**
 * The writer's dense checklist (tests/integration/integration.profile-sync.spec.ts `denseChecklist`), written out again: 100 items of a
 * fresh UUID and the label "x", the first 40 of them checked; keys in the order the released backend sends them.
 */
function denseChecklist(tag) {
  const items = Array.from({ length: 100 }, (_, j) => ({
    id: uuidOf(`${tag}|item|${j}`),
    label: "x",
  }));
  return {
    checked: items.slice(0, 40).map((item) => item.id),
    items,
    kind: "checklist",
  };
}
const denseBatches = new Map();
/**
 * The server-maximal dense batch of one engine (revision 4, review 4 R2 and design assessment A3: the writer's real shape, not a tag):
 * one revision publishing the seeded person and its 199 checklist fields shared with the reader, 200 changes. The same batch at both
 * limits; every engine's has ids and a revision of its own.
 */
function denseBatch(engine, person) {
  const key = `${engine}|${person}`;
  if (!denseBatches.has(key))
    denseBatches.set(key, {
      revision: 203 + ENGINES.indexOf(engine),
      changes: [
        {
          kind: "upsert",
          resource: projection(person, "person", null, "W2 person", null, 4),
        },
        ...Array.from({ length: 199 }, (_, i) => ({
          kind: "upsert",
          resource: projection(
            uuidOf(`${engine}|${person}|field|${i}`),
            "field",
            person,
            "Checklist",
            denseChecklist(`${engine}|${person}|field|${i}`),
            1,
          ),
        })),
      ],
    });
  return denseBatches.get(key);
}
/** The byte size of one dense checklist value, as the writer measures its own (`Buffer.byteLength(JSON.stringify(value))`). */
export const DENSE_VALUE_BYTES = Buffer.byteLength(
  JSON.stringify(denseChecklist("size")),
);
/**
 * A real-shaped `/sync` delta page read from the cursor before the grant: at limit 1 the dense batch alone (more to come), at limit 80 the
 * dense batch and a later ordinary batch (a removal), so the two captures differ in pagination as real ones can while the seeded batch
 * is the same.
 */
export function captureBody(engine, limit, person = PERSON) {
  const dense = denseBatch(engine, person);
  const later = {
    revision: dense.revision + 1,
    changes: [{ kind: "remove", id: uuidOf(`${engine}|later-removal`) }],
  };
  return JSON.stringify({
    phase: "delta",
    batches: limit === 80 ? [dense, later] : [dense],
    next_cursor: `d1.${engine}.limit-${limit}.0000000000cb`,
    has_more: limit !== 80,
  });
}
/** The integration writer's batch shape (tests/integration/integration.profile-sync.spec.ts `shapeOf`), written out again. */
const shapeOf = (batch, person) => ({
  changes: batch.changes.length,
  checklist_upserts: batch.changes.filter(
    (c) =>
      c.kind === "upsert" &&
      c.resource?.kind === "field" &&
      c.resource.value?.kind === "checklist",
  ).length,
  person_ancestor: batch.changes.some(
    (c) => c.kind === "upsert" && c.resource?.id === person,
  ),
});

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
  // Shared rows are appended stage by stage, as the drivers' serial stages do, so each stage's lines form its sealed range.
  const shared = Object.fromEntries(
    STAGE_ORDER.map((stage) => [
      stage,
      Object.fromEntries(SHARED.map((f) => [f, []])),
    ]),
  );
  const caseWindow = new Map();
  // The JSONL support files of P-7 (contention/waits.jsonl) and P-9 (contention/yield-policy.jsonl).
  const waitsJsonl = [];
  const policyJsonl = [];

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
        shared[stage]["collection.jsonl"].push({
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
  /** A distribution as `record()` writes it: the raw samples in their file, the summary row linked by path and hash. */
  const series = (stage, engine, title, name, samples, extra = {}) => {
    const safe = `${name}.${engine}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const raw = `${JSON.stringify({ ...extra, name, engine, samples })}\n`;
    put(`raw/${safe}.json`, raw);
    shared[stage]["measurements.jsonl"].push({
      ...extra,
      ...summaryOf(samples),
      raw: `raw/${safe}.json`,
      raw_sha256: sha(raw),
      ...ident(stage, engine, name, title),
    });
    return samples;
  };
  const distinct = (name, engine, n, baseValue = 5) =>
    Array.from({ length: n }, (_, i) =>
      three(sampleOf(`${name}|${engine}`, i, baseValue)),
    );
  const value = (stage, engine, title, name, v) =>
    shared[stage]["values.jsonl"].push({
      ...v,
      ...ident(stage, engine, name, title),
    });
  const stamp = (stage, engine, title) => ({
    stage,
    invocation,
    collection: windowOf(engine, title),
  });

  /** The attributed memory of one run as `browserMemory().record()` writes it: every sample kept, the peak among them. */
  const rssOf = (engine, key) => {
    const s = seeded(key);
    const series_kib = Array.from(
      { length: 6 + (s % 5) },
      (_, i) => 200_000 + ((s >> 3) % 50_000) + i * 1_111 + (s % 7) * i,
    );
    const peak = Math.max(...series_kib);
    const procs = [
      {
        pid: 1000 + (s % 500),
        start: "Sat Oct 10 08:00:00 2026",
        role: "browser",
      },
      {
        pid: 2000 + (s % 500),
        start: "Sat Oct 10 08:00:01 2026",
        role: "renderer",
      },
    ];
    const first = Math.floor(peak * 0.6);
    return {
      scope:
        "synthetic: the worker's descendants (and, for WebKit on macOS, its host's launchd services)",
      platform: "darwin",
      webkit_hosts: engine === "webkit" ? 1 : 0,
      baseline_kib: 190_000 + (s % 9_000),
      peak_kib: peak,
      after_kib: 195_000 + (s % 8_000),
      samples: series_kib.length,
      series_kib,
      failed_samples: 0,
      complete: true,
      errors: [],
      processes_at_peak: [
        { ...procs[0], rss_kib: first },
        { ...procs[1], rss_kib: peak - first },
      ],
      process_identities: procs.map((p) => `${p.pid}@${p.start}`).sort(),
    };
  };
  /**
   * One cold run as `oneColdRun` returns it, every figure its own; heap samples where the engine has them. Revision 9 (review 9 R2): with
   * the one observation its outcome is classified from (tests/e2e/profile-cold-outcome.ts, written out here): the request's `running`,
   * the step's end and the state it recorded, and the served page's commit (`bytes`) when it was admitted.
   */
  const coldRun = (engine, key, bytes, outcome = "admitted") => {
    const s = seeded(key);
    const rss = rssOf(engine, key);
    const heap =
      engine === "chromium"
        ? Array.from(
            { length: 5 + (s % 4) },
            (_, i) => 1e7 + (s % 1e6) + i * 3_333,
          )
        : [];
    const state =
      outcome === "admitted"
        ? { kind: "idle", lastSyncedAt: "2026-10-13T01:00:00.000Z" }
        : { kind: "stopped", cause: "floor" };
    const commits =
      outcome === "admitted"
        ? [
            {
              bytes,
              scan_ms: 30 + (s % 40),
              commit_ms: 200 + (s % 300),
              kind: "applied",
              value: "applied",
            },
          ]
        : [];
    return {
      outcome,
      detail: JSON.stringify(state),
      observation: {
        method: "engine-state-log/1",
        run: 1,
        request: { index: 2, at: 400 + (s % 50), trace: 6 },
        terminal: { index: 3, at: 600 + (s % 90), trace: 9, state },
        step_end: { trace: 9, event: "data.sync_next", recorded: state.kind },
        states: [
          "waiting/cache_not_valid",
          "waiting/cache_not_valid",
          "running",
          outcome === "admitted" ? "idle" : "stopped/floor",
        ],
        commits,
      },
      elapsed_ms: 1_000 + (s % 900),
      scan_ms: commits[0]?.scan_ms ?? null,
      commit_ms: commits[0]?.commit_ms ?? null,
      requests: 2,
      heap_baseline_bytes: engine === "chromium" ? 9e6 : null,
      heap_samples_bytes: heap,
      heap_peak_bytes: heap.length ? Math.max(...heap) : null,
      heap_after_gc_bytes: engine === "chromium" ? 9.5e6 : null,
      rss_baseline_kib: rss.baseline_kib,
      rss_peak_kib: rss.peak_kib,
      rss_after_kib: rss.after_kib,
      rss,
    };
  };

  // ---- bundle (P-1) ----
  const budgets = {};
  for (const [i, build] of ["dist", "dist-fixture"].entries()) {
    const profile = `${JSON.stringify({ measured: { initial_js_gzip: 107_948 + i * 111_641, css_gzip: 6_873 + i, fonts: 83_736 + i }, failures: [] })}\n`;
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
    initial_js_gzip: 107_948,
    initial_chunks: ["assets/index-synthetic.js"],
    dexie_in_initial_chunk: false,
    budgets,
  });

  // ---- shell (P-1S): two builds x two viewports x two networks x three runs, each with its window, every figure its own ----
  let shellSecond = 20;
  for (const build of ["dist", "dist-fixture"]) {
    const results = [];
    for (const viewport of ["mobile", "desktop"])
      for (const network of ["fast-4g", "slow-4g"]) {
        const raw = [1, 2, 3].map((run) => {
          const s = seeded(`${build}|${viewport}|${network}|${run}`);
          const from = t("shell", shellSecond);
          shellSecond += 30;
          const fcp = 600 + (s % 300) + run * 0.25;
          const fontsDone = fcp + 50 + (s % 120);
          return {
            run,
            lcp: fcp + 100 + (s % 200),
            cls: (s % 10) / 1000,
            fcp,
            fontsStart: 10 + (s % 20),
            fontsDone,
            transferBytes: 190_000 + (s % 20_000),
            requests: 10 + (s % 4),
            fonts: 2,
            fontsLoaded: 2,
            fout: Math.max(0, fontsDone - fcp),
            script_encodings: { gzip: 3 },
            from,
            to: t("shell", shellSecond - 5),
          };
        });
        const m = (key) => median(raw.map((r) => r[key]));
        results.push({
          viewport,
          network,
          cpuThrottle: 4,
          runs: 3,
          runs_completed: 3,
          lcp_ms: Math.round(m("lcp")),
          fcp_ms: Math.round(m("fcp")),
          cls: Number(m("cls").toFixed(4)),
          fout_window_ms: Math.round(m("fout")),
          transfer_kb: Math.round(m("transferBytes") / 1024),
          requests: m("requests"),
          fonts_loaded: `${m("fontsLoaded")}/${m("fonts")}`,
          raw,
        });
      }
    json(`shell/${build}.json`, {
      url: "http://127.0.0.1:1/",
      build,
      evidence: { stage: "shell", invocation },
      note: "synthetic",
      browser: "synthetic-chromium",
      results,
    });
  }

  json("integration-run/summary.json", {
    backend: {
      tag: "v0.27.0-rc.1",
      sha256: "b".repeat(64),
      note: "synthetic",
    },
  });

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
      for (const metric of ["wall_ms", "scan_ms", "commit_ms"]) {
        const name = `P-2 ${shape} ${metric}`;
        series("fixture", engine, "P-2:", name, distinct(name, engine, n));
      }
      const longTasks = `P-2 ${shape} long_task_ms_per_page`;
      if (engine === "chromium")
        series(
          "fixture",
          engine,
          "P-2:",
          longTasks,
          distinct(longTasks, engine, n, 0),
        );
      else
        value("fixture", engine, "P-2:", longTasks, {
          capability: "unavailable",
          reason: "this engine has no longtask observer",
        });
    }
    put(`raw/P-2.trace.${engine}.txt`, "0ms data.sync_commit {}\n");
    for (const kind of ["draft", "fence", "form_recovery"])
      for (const d of ["strict", "default"]) {
        const name = `P-3 ${kind} ${d} write_ms`;
        series("fixture", engine, "P-3:", name, distinct(name, engine, 300));
      }
    const drains = series(
      "fixture",
      engine,
      "P-5:",
      "P-5 drain_200_ms",
      distinct("P-5 drain_200_ms", engine, 20, 2000),
    );
    series(
      "fixture",
      engine,
      "P-5:",
      "P-5 per_draft_ms",
      drains.map((x) => x / 200),
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
      distinct("P-5 dense drain_201_ms", engine, 20, 4000),
    );
    series(
      "fixture",
      engine,
      "P-5 (dense):",
      "P-5 dense per_draft_ms",
      dense.map((x) => x / 201),
    );
    const rows = [];
    const servedBytes = (workload) =>
      100_000 + (seeded(`bytes|${workload}`) % 900_000);
    for (const workload of ["W1", "W3", "W4", "W6"])
      rows.push({
        workload,
        bytes: servedBytes(workload),
        expected: "admitted",
        runs: [1, 2, 3, 4, 5].map((run) =>
          coldRun(
            engine,
            `P-11|${engine}|${workload}|${run}`,
            servedBytes(workload),
          ),
        ),
      });
    for (const workload of W7)
      rows.push({
        workload,
        bytes: servedBytes(workload),
        expected: "refused",
        runs: [
          coldRun(
            engine,
            `P-11|${engine}|${workload}|1`,
            servedBytes(workload),
            controlOutcome,
          ),
        ],
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
        row.runs.map((r) => r.elapsed_ms),
      );
      series(
        "fixture",
        engine,
        "P-11:",
        `P-11 ${row.workload} rss_peak_kib`,
        row.runs.map((r) => r.rss_peak_kib),
      );
      if (engine === "chromium")
        series(
          "fixture",
          engine,
          "P-11:",
          `P-11 ${row.workload} heap_peak_bytes`,
          row.runs.map((r) => r.heap_peak_bytes),
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
    // P-Q: the writer's readings ({estimate: {usage, quota}, indexeddb}); Chromium's exact figure, an explicit null elsewhere.
    const reading = (k) => ({
      estimate: { usage: 10_000 + k * 4_096, quota: 2e9 },
      indexeddb: engine === "chromium" ? 8_000 + k * 3_000 : null,
    });
    const pq = {
      baseline: reading(0),
      empty_account_database: reading(1),
      with_200_drafts: reading(3),
      one_draft_with_1_mib_payload: { outcome: "queued", ...reading(9) },
      atlas_auth_steady: reading(10),
      atlas_auth_100_fences_200_leases: reading(12),
    };
    value("fixture", engine, "P-Q:", "P-Q footprints", {
      note: "synthetic: Chromium's indexeddb is exact, the estimate is obfuscated elsewhere",
      ...pq,
      per_draft_bytes_chromium:
        engine === "chromium"
          ? Math.round(
              (pq.with_200_drafts.indexeddb -
                pq.empty_account_database.indexeddb) /
                200,
            )
          : null,
    });
    // P-Q2: the burst, the estimate ladder and the ledger, every reading kept, every derived figure computed as the writer does.
    const flat = (usage, indexeddb) => ({
      usage,
      quota: 2e9,
      indexeddb: engine === "chromium" ? indexeddb : null,
    });
    const idle = flat(50_000, 40_000);
    const during = flat(66_384, 52_288);
    const after = flat(58_192, 44_100);
    const growth = (from, to) => ({
      estimate:
        to.usage !== null && from.usage !== null ? to.usage - from.usage : null,
      indexeddb_exact:
        to.indexeddb !== null && from.indexeddb !== null
          ? to.indexeddb - from.indexeddb
          : null,
    });
    // The estimate does not move until 16 KiB has been written, then moves in 16 KiB steps (a coarse but moving estimate).
    const initial = 60_000;
    let written = 0;
    let previous = initial;
    const ladder = [];
    for (let k = 0; k <= 14; k += 1) {
      written += 1024 * 2 ** k;
      const usage = initial + Math.floor(written / 16_384) * 16_384;
      ladder.push({
        added_bytes: 1024 * 2 ** k,
        total_written: written,
        usage,
        delta: usage - previous,
      });
      previous = usage;
    }
    const firstChange = ladder.find((r) => (r.delta ?? 0) > 0);
    const before = flat(70_000, 61_000);
    const ledgerAfter = flat(86_384, 64_500);
    const burstGrowth = growth(idle, during);
    const burstBytes =
      burstGrowth.indexeddb_exact ?? burstGrowth.estimate ?? null;
    value("fixture", engine, "P-Q2:", "P-Q2 quota reserve inputs", {
      note: "synthetic",
      atlas_auth_burst: {
        pages: 3,
        requests_per_page: 20,
        held_at_once: 20 + (seeded(engine) % 41),
        held_at_once_reading: "synthetic",
        outcomes: Array.from({ length: 60 }, (_, i) =>
          i % 29 === 0 ? "not_sent" : "released",
        ),
        idle,
        during,
        after,
        growth_during: burstGrowth,
        growth_after: growth(idle, after),
      },
      estimate_granularity: {
        initial_usage: initial,
        rows: ladder,
        smallest_write_that_moved_the_estimate:
          firstChange?.added_bytes ?? null,
        estimate_step_bytes: firstChange?.delta ?? null,
        reading: "the first write that changed the estimate, and by how much",
      },
      ledger: {
        reservations: 100,
        bytes_each: 1024,
        verdicts: { reserved: 97, refused: 3 },
        before,
        after: ledgerAfter,
        growth: growth(before, ledgerAfter),
      },
      derived_desktop_recommendation_bytes:
        burstBytes === null || firstChange === undefined
          ? null
          : Math.max(burstBytes * 4, firstChange.delta * 2),
      derivation: "max(burst x 4, estimate step x 2)",
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
    // Scenario rows with varied facts: the precondition read before the first request and the covers seen after it differ on purpose.
    const p6rows = [];
    for (const [cause, n] of Object.entries(causes))
      for (let i = 0; i < n; i += 1) {
        const s = seeded(`${engine}|${cause}|${i}`);
        const first = ["released", "lease_unresolved", "verify_pending"][s % 3];
        const resolved = first === "released" || s % 11 !== 0;
        p6rows.push({
          cause,
          foreign_leases: s % 4 === 0 ? 0 : 1 + (s % 3),
          sender_retire_failed:
            cause === "failing_recording_injected" && s % 5 !== 0 ? 1 : 0,
          covers_with_unresolved: s % 3 === 0 ? 0 : s % 5,
          first,
          resolved,
          resolve_ms: resolved ? 40 + (s % 400) : null,
          retired_by_observer: s % 2,
        });
      }
    // The writer's by-cause summary (tests/e2e/fixture.profile-contention.spec.ts), written out again.
    const byCause = {};
    for (const row of p6rows) {
      const e = byCause[row.cause] ?? {
        n: 0,
        precondition_met: 0,
        injection_took_effect: 0,
        saw_unresolved: 0,
        first: {},
        unresolved_then_resolved: 0,
        never_resolved: 0,
        resolve_ms: [],
      };
      byCause[row.cause] = e;
      e.n += 1;
      if (row.foreign_leases > 0) e.precondition_met += 1;
      if (row.sender_retire_failed > 0) e.injection_took_effect += 1;
      if (row.covers_with_unresolved > 0) e.saw_unresolved += 1;
      e.first[row.first] = (e.first[row.first] ?? 0) + 1;
      if (row.first !== "released" && row.resolved)
        e.unresolved_then_resolved += 1;
      if (!row.resolved) e.never_resolved += 1;
      if (row.resolve_ms !== null && row.first !== "released")
        e.resolve_ms.push(row.resolve_ms);
    }
    json(`contention/unresolved-leases.${engine}.json`, {
      id: "P-6",
      engine,
      status: "measured, with INJECTED causes labelled",
      scenarios: p6rows.length,
      by_cause: byCause,
      rows: p6rows,
      evidence: stamp("contention", engine, "P-6:"),
    });
    for (const [cause, e] of Object.entries(byCause))
      value("contention", engine, "P-6:", `P-6 ${cause}`, {
        n: e.n,
        precondition_met: e.precondition_met,
        injection_took_effect: e.injection_took_effect,
        saw_unresolved: e.saw_unresolved,
        first_verdicts: e.first,
        unresolved_then_resolved: e.unresolved_then_resolved,
        never_resolved: e.never_resolved,
      });
    // P-7 waits (series and waits.jsonl) and P-8 (counters with their trace support).
    const outcomesOf = (n, key) => {
      const timeouts = seeded(key) % 3;
      return timeouts
        ? { released: n - timeouts, lock_timeout: timeouts }
        : { released: n };
    };
    const retirements = [];
    const trace = [];
    for (const [c, condition] of [
      "no leader",
      "back-to-back leader, 5 ms apart (platform yield)",
    ].entries()) {
      for (const [probe, n] of [
        ["ordinary request", 100],
        ["exposure (visible to lifted)", 100],
        ["atlas-auth writer (begin)", 100],
        ["closing write (logout initiation)", 30],
      ]) {
        const name = `P-7 ${probe}, ${condition}`;
        const ms = distinct(name, engine, n, 2);
        const outcomes = outcomesOf(n, `${name}|${engine}`);
        series("contention", engine, "P-7 and P-8:", name, ms, {
          outcomes,
          condition,
        });
        waitsJsonl.push({ probe, condition, engine, n, outcomes, ms });
      }
      const events = (counts) =>
        Object.entries(counts).flatMap(([event, k]) =>
          Array.from({ length: k }, (_, i) => ({
            event,
            at: 1_000 * (c + 1) + i * 3 + event.length,
          })),
        );
      const s = seeded(`${engine}|${condition}`);
      const leaderCounts = c
        ? {
            "cover.committed": 400 + (s % 50),
            "request.issued": 410 + (s % 50),
            "lease.retired": 405 + (s % 50),
            "activity.cancel": s % 4,
          }
        : {};
      const probeCounts = {
        "activity.cancel": c * 3 + (s % 2),
        "lease.retired": 300 + c * 2,
        "lease.retire_failed": c,
        "closing.gave_up": s % 2,
      };
      const leaderPages = c ? 420 + (s % 40) : 0;
      const elapsed = 61.25 + c * 3.5;
      trace.push({
        condition,
        leader: events(leaderCounts),
        probe: events(probeCounts),
      });
      retirements.push({
        condition,
        leader_pages: leaderPages,
        elapsed_s: elapsed,
        leader_pages_per_second: +(leaderPages / elapsed).toFixed(1),
        leader_cover_commits: leaderCounts["cover.committed"] ?? 0,
        leader_requests_issued: leaderCounts["request.issued"] ?? 0,
        leader_leases_retired: leaderCounts["lease.retired"] ?? 0,
        leader_activity_cancelled: leaderCounts["activity.cancel"] ?? 0,
        probe_activity_cancelled: probeCounts["activity.cancel"],
        probe_leases_retired: probeCounts["lease.retired"],
        probe_retire_failed: probeCounts["lease.retire_failed"],
        probe_closing_gave_up: probeCounts["closing.gave_up"],
      });
    }
    json(`contention/retirements.${engine}.json`, {
      id: "P-8",
      engine,
      status: "measured",
      conditions: retirements,
      evidence: stamp("contention", engine, "P-7 and P-8:"),
    });
    json(`contention/retirements-trace.${engine}.json`, {
      id: "P-8 trace support",
      engine,
      conditions: trace,
      evidence: stamp("contention", engine, "P-7 and P-8:"),
    });
    value("contention", engine, "P-7 and P-8:", "P-8 retirements", {
      conditions: retirements,
    });
    // P-7 frozen owner (scaled) and the production wait.
    const frozen = [100, 250, 500, 750, 1000, 1500, 2500].flatMap((freeze_ms) =>
      Array.from({ length: 15 }, (_, i) => {
        const gaveUp = freeze_ms > 1000 || (freeze_ms === 1000 && i % 4 === 0);
        return {
          freeze_ms,
          gave_up: gaveUp,
          waited_ms: gaveUp ? 1000 + i : freeze_ms - 20 + i,
          outcome: gaveUp ? "lock_timeout" : "released",
        };
      }),
    );
    const gaveUp = frozen.filter((r) => r.gave_up).length;
    json(`contention/frozen-owner.${engine}.json`, {
      id: "P-7 frozen owner",
      engine,
      status: "measured, SYNTHETIC",
      scaled_lock_wait_ms: 1000,
      freezes_ms: [100, 250, 500, 750, 1000, 1500, 2500],
      samples_per_freeze: 15,
      gave_up: gaveUp,
      of: frozen.length,
      rows: frozen,
      evidence: stamp("contention", engine, "P-7: a frozen owner"),
    });
    series(
      "contention",
      engine,
      "P-7: a frozen owner",
      "P-7 frozen owner: writer wait (scaled 1 s)",
      frozen.map((r) => r.waited_ms),
      { gave_up: gaveUp, synthetic: true },
    );
    value(
      "contention",
      engine,
      "P-7: a frozen owner",
      "P-7 frozen owner give-ups",
      {
        gave_up: gaveUp,
        of: frozen.length,
        scaled_lock_wait_ms: 1000,
      },
    );
    json(`contention/frozen-owner-production-wait.${engine}.json`, {
      id: "P-7 frozen owner, production lock wait",
      engine,
      lock_wait_ms: 20_000,
      freeze_ms: 23_000,
      rows: [
        { outcome: "lock_timeout", waited_ms: 20_010 + (seeded(engine) % 30) },
        { outcome: "lock_timeout", waited_ms: 20_020 + (seeded(engine) % 40) },
      ],
      evidence: stamp("contention", engine, "P-7: the PRODUCTION lock wait"),
    });
    // P-9: waits per policy (series and yield-policy.jsonl) and throughput (series and the policy file).
    const policyRows = [];
    for (const policy of ["none", "macrotask", "scheduler_yield", "idle"]) {
      for (const probe of [
        "ordinary request",
        "exposure",
        "atlas-auth writer",
      ]) {
        const name = `P-9 ${policy}: ${probe} wait`;
        const ms = distinct(name, engine, 50, 1);
        const outcomes = outcomesOf(50, `${name}|${engine}`);
        series("contention", engine, "P-9:", name, ms, { policy, outcomes });
        policyJsonl.push({
          policy,
          engine,
          probe,
          n: 50,
          outcomes,
          ms,
        });
      }
      const throughputName = `P-9 ${policy}: catch-up throughput (pages/s, 200 pages, no probe)`;
      const throughput = distinct(throughputName, engine, 5, 150);
      series("contention", engine, "P-9:", throughputName, throughput, {
        policy,
      });
      policyRows.push({ policy, throughput_pages_per_second: throughput });
    }
    json(`contention/yield-policy.${engine}.json`, {
      id: "P-9",
      engine,
      status: "measured",
      engine_support: {
        scheduler_yield: engine === "chromium",
        request_idle_callback: engine !== "webkit",
      },
      rows: policyRows,
      evidence: stamp("contention", engine, "P-9:"),
    });
    // P-13: observed hints and transactions per condition; every figure computed from them as the writer does.
    const observedOf = (condition) => {
      const hints = [];
      const tx = [];
      const s = seeded(`${engine}|${condition}`);
      const nHints = {
        "none (control)": 0,
        "leader pages": 200 + (s % 5),
        "stop-record hints (synthetic)": 200 + (s % 3),
        "drafts and receipts": 120 + (s % 7),
      }[condition];
      // Background reads before any hint (the control's own reads are not hint-caused).
      tx.push({ at: 1, stores: "drafts", mode: "readonly", done: 2.5 });
      for (let i = 0; i < nHints; i += 1) {
        const at = 10 + i * 5;
        hints.push({
          at,
          stores:
            condition === "drafts and receipts"
              ? "drafts,pending_effects"
              : "cache,sync_state",
        });
        const reads = seeded(`${condition}|${i}`) % 3 === 0 ? 0 : 1 + (i % 3);
        for (let k = 0; k < reads; k += 1)
          tx.push({
            at: at + 0.5 + k * 0.25,
            stores: k % 2 ? "drafts" : "sync_state",
            mode: "readonly",
            done: i % 17 === 0 && k === 0 ? null : at + 1.5 + k * 0.5,
          });
      }
      return { hints, tx };
    };
    const summaryFrom = ({ hints, tx }) => {
      const byHintKind = {};
      for (const h of hints)
        byHintKind[h.stores] = (byHintKind[h.stores] ?? 0) + 1;
      const byStores = {};
      for (const x of tx) byStores[x.stores] = (byStores[x.stores] ?? 0) + 1;
      const readMs = [];
      let withReads = 0;
      for (const [i, h] of hints.entries()) {
        const until = hints[i + 1]?.at ?? Number.POSITIVE_INFINITY;
        const started = tx.filter((x) => x.at >= h.at && x.at < until);
        if (!started.length) continue;
        withReads += 1;
        readMs.push(Math.max(...started.map((x) => x.done ?? x.at)) - h.at);
      }
      return {
        summary: {
          hints: hints.length,
          hints_by_kind: byHintKind,
          own_posts: 0,
          transactions: tx.length,
          transactions_by_stores: byStores,
          sync_state_transactions: tx.filter((x) =>
            x.stores.split(",").includes("sync_state"),
          ).length,
          transactions_per_hint: hints.length
            ? +(tx.length / hints.length).toFixed(3)
            : null,
          hints_followed_by_reads: withReads,
          controller_reads: { starts: 0, emissions: 0, calls: 0 },
        },
        readMs,
      };
    };
    const conditions = [];
    const observed = [];
    for (const [i, condition] of [
      "none (control)",
      "leader pages",
      "stop-record hints (synthetic)",
      "drafts and receipts",
    ].entries()) {
      const raw = observedOf(condition);
      const { summary, readMs } = summaryFrom(raw);
      observed.push({ condition, ...raw });
      conditions.push({
        condition,
        label: "synthetic",
        elapsed_ms: 5_000 + i * 1_234,
        ...summary,
      });
      if (readMs.length)
        series(
          "contention",
          engine,
          "P-13:",
          `P-13 ${condition}: follower read_ms per hint`,
          readMs,
          { condition, hints: summary.hints },
        );
    }
    const throughput = {};
    for (const followers of ["2", "1", "0"]) {
      const name = `P-13 leader catch-up throughput (pages/s, 200 pages), ${followers} follower(s)`;
      throughput[followers] = series(
        "contention",
        engine,
        "P-13:",
        name,
        distinct(name, engine, 3, 120),
        { followers: Number(followers) },
      );
    }
    json(`contention/follower-reads.${engine}.json`, {
      id: "P-13",
      engine,
      status: "measured",
      follower_cache_state_at_start: "current",
      conditions,
      leader_throughput_pages_per_second: throughput,
      evidence: stamp("contention", engine, "P-13:"),
    });
    json(`contention/follower-reads-raw.${engine}.json`, {
      id: "P-13 observed hints and transactions",
      engine,
      conditions: observed,
      evidence: stamp("contention", engine, "P-13:"),
    });
    value("contention", engine, "P-13:", "P-13 follower reads", {
      conditions,
      leader_throughput_pages_per_second: throughput,
    });

    // ---- integration: P-4, P-10, P-W2, W2-limits ----
    const syncTitle = "P-4: what the page does around ONE sync page";
    const pre = distinct("P-4 sync page pre_issue_ms", engine, 300, 1);
    const syncRequest = distinct("P-4 sync page request_ms", engine, 300, 3);
    const post = distinct("P-4 sync page post_response_ms", engine, 300, 20);
    series("integration", engine, syncTitle, "P-4 sync page pre_issue_ms", pre);
    series(
      "integration",
      engine,
      syncTitle,
      "P-4 sync page request_ms",
      syncRequest,
    );
    series(
      "integration",
      engine,
      syncTitle,
      "P-4 sync page post_response_ms",
      post,
    );
    series(
      "integration",
      engine,
      syncTitle,
      "P-4 sync page total_ms",
      pre.map((x, i) => x + syncRequest[i] + post[i]),
    );
    series(
      "integration",
      engine,
      syncTitle,
      "P-10 sync page request_ms (unthrottled loopback)",
      syncRequest,
      { stampedRequestTimeoutMs: 30_000 },
    );
    const draftTitle = "P-4: what the page does around ONE draft submission";
    const segments = Object.fromEntries(
      ["enqueue_ms", "claim_ms", "stamping_ms", "request_ms", "record_ms"].map(
        (seg) => [seg, distinct(`P-4 draft ${seg}`, engine, 300, 1)],
      ),
    );
    for (const [seg, samples] of Object.entries(segments))
      series("integration", engine, draftTitle, `P-4 draft ${seg}`, samples);
    series(
      "integration",
      engine,
      draftTitle,
      "P-4 draft total_ms",
      segments.enqueue_ms.map(
        (_, i) =>
          Object.values(segments).reduce((n, s) => n + s[i], 0) + 0.5 + (i % 3),
      ),
    );
    series(
      "integration",
      engine,
      draftTitle,
      "P-10 draft request_ms (unthrottled loopback)",
      segments.request_ms,
      { stampedRequestTimeoutMs: 30_000 },
    );
    series(
      "integration",
      engine,
      "P-10:",
      "P-10 sync page duration_ms (proxy delay 250 ms)",
      distinct("P-10 delayed", engine, 100, 255),
    );
    value("integration", engine, "W2:", "backend", {
      health: {
        status: 200,
        body: { status: "ok", api_version: "0.27.0-rc.1" },
      },
      revision: { tag: "v0.27.0-rc.1", commit: "synthetic" },
    });
    const captures = {};
    let w2Body = "";
    for (const limit of [1, 80]) {
      const text = captureBody(engine, limit);
      put(`w2/W2-captured.${engine}.limit-${limit}.json`, text);
      const body = JSON.parse(text);
      const bytes = Buffer.byteLength(text);
      captures[`limit_${limit}`] = {
        phase: body.phase,
        bytes,
        mib: +(bytes / 1_048_576).toFixed(3),
        batches: body.batches.length,
        batch_shapes: body.batches.map((b) => shapeOf(b, PERSON)),
        changes: body.batches.reduce((n, b) => n + b.changes.length, 0),
        has_more: body.has_more,
        sha256: sha(text),
        file: `w2/W2-captured.${engine}.limit-${limit}.json`,
      };
      if (limit === 1) w2Body = text;
    }
    const liveRun = coldRun(
      engine,
      `P-W2|${engine}|live`,
      Buffer.byteLength(w2Body),
    );
    const live = {
      outcome: "admitted",
      observation: {
        method: "live-dense-commit/1",
        state: { kind: "idle", lastSyncedAt: "2026-10-13T01:00:00.000Z" },
        dense: {
          bytes: Buffer.byteLength(w2Body),
          scan_ms: 20,
          commit_ms: 300,
          kind: "applied",
        },
        trace: 40,
      },
      elapsed_ms: liveRun.elapsed_ms + 500,
      commits: [
        { bytes: Buffer.byteLength(w2Body), scan_ms: 20, commit_ms: 300 },
      ],
      limits_the_engine_asked_for: ["1", "1"],
      heap_baseline_bytes: liveRun.heap_baseline_bytes,
      heap_samples_bytes: liveRun.heap_samples_bytes,
      heap_peak_bytes: liveRun.heap_peak_bytes,
      rss_baseline_kib: liveRun.rss.baseline_kib,
      rss_peak_kib: liveRun.rss.peak_kib,
      rss: liveRun.rss,
      label: "synthetic",
    };
    const w2Runs = [1, 2, 3, 4, 5].map((run) =>
      coldRun(engine, `P-W2|${engine}|${run}`, Buffer.byteLength(w2Body)),
    );
    json(`w2/P-W2.${engine}.json`, {
      engine,
      live,
      rows: [
        {
          workload: "W2",
          bytes: Buffer.byteLength(w2Body),
          expected: "admitted",
          runs: w2Runs,
        },
      ],
      evidence: stamp("integration", engine, "W2:"),
    });
    put(`w2/P-W2.${engine}.live-engine-trace.txt`, "trace\n");
    series(
      "integration",
      engine,
      "W2:",
      "P-W2 elapsed_ms",
      w2Runs.map((r) => r.elapsed_ms),
    );
    series(
      "integration",
      engine,
      "W2:",
      "P-W2 rss_peak_kib",
      w2Runs.map((r) => r.rss_peak_kib),
    );
    if (engine === "chromium")
      series(
        "integration",
        engine,
        "W2:",
        "P-W2 heap_peak_bytes",
        w2Runs.map((r) => r.heap_peak_bytes),
      );
    else
      value("integration", engine, "W2:", "P-W2 heap_peak_bytes", {
        capability: "unavailable",
        reason: "no heap signal outside Chromium",
      });
    value("integration", engine, "W2:", "P-W2 capture", {
      status: "measured",
      server: "synthetic",
      seeding: {
        writer: "dave (raw HTTP)",
        reader: "carol (this page)",
        person: PERSON,
        dense_fields: 199,
        value_bytes: DENSE_VALUE_BYTES,
        seeding_ms: 12_345,
        grant_policy_version: 3,
        revoke_status: 200,
        batches_before_the_grant: [],
        capacity_retries: [],
      },
      captures,
      live,
      cold_outcomes: w2Runs.map((r) => r.outcome),
    });
    value("integration", engine, "W2:", "P-W2 observed bound", {
      bound_person: BOUND_PERSON,
      write: "synthetic",
      revoke: { status: 200, body: {} },
      delivered: {
        status: 200,
        batch_shapes: [
          { changes: 201, checklist_upserts: 200, person_ancestor: true },
        ],
        has_more: false,
        bytes: 1_530_000,
      },
      reading: "synthetic",
    });
    value("integration", engine, "W2-limits:", "W2-limits", {
      status: "measured",
      probe: {
        legacy_create_field_checklist: {
          status: 400,
          body: '{"error":"invalid_value"}',
        },
        largest_text_value_accepted_of_tried: 4096,
        command_count_rows: [
          {
            commands: 800,
            body_bytes: 3_400_000,
            proxied: { status: 502, body: "bad gateway" },
            direct: { status: 400, body: '{"error":"malformed_request"}' },
          },
          {
            commands: 400,
            body_bytes: 1_700_000,
            proxied: { status: 400, body: '{"error":"malformed_request"}' },
            direct: { status: 400, body: '{"error":"malformed_request"}' },
          },
          {
            commands: 200,
            body_bytes: 850_000,
            proxied: { status: 400, body: '{"error":"malformed_request"}' },
            direct: { status: 400, body: '{"error":"malformed_request"}' },
          },
          {
            commands: 100,
            body_bytes: 425_000,
            proxied: { status: 400, body: '{"error":"malformed_request"}' },
            direct: { status: 400, body: '{"error":"malformed_request"}' },
          },
          {
            commands: 40,
            body_bytes: 170_000,
            proxied: { status: 400, body: '{"error":"malformed_request"}' },
            direct: { status: 400, body: '{"error":"malformed_request"}' },
          },
          {
            commands: 21,
            body_bytes: 89_000,
            proxied: { status: 400, body: '{"error":"malformed_request"}' },
            direct: { status: 400, body: '{"error":"malformed_request"}' },
          },
          {
            commands: 20,
            body_bytes: 85_000,
            proxied: { status: 200, body: "{}" },
            direct: null,
          },
        ],
      },
      reading: "synthetic",
    });

    // ---- device: the page's whole protocol, schema 2, one protocol, in plan order, every payload its path's ----
    const w2sha = captures.limit_1.sha256;
    const protocolId = `protocol-${engine}`;
    const runs = plan().map(({ name, run }, i) => {
      const control = name.startsWith("W7-");
      const processing = name.startsWith("W5-");
      const outcome = control ? controlOutcome : "admitted";
      const engineRun = outcome === "admitted" || outcome === "refused";
      return {
        protocol_id: protocolId,
        workload: name,
        run,
        cold: true,
        expected: control ? "refused" : "admitted",
        outcome,
        detail: `synthetic attempt ${i + 1}`,
        sha256:
          name === "W2"
            ? w2sha
            : recorded.workloads.find((w) => w.name === name).sha256,
        sha256_verified: outcome !== "killed",
        ...(name === "W2"
          ? { source: `W2-captured.${engine}.limit-1.json` }
          : {}),
        bytes:
          name === "W2"
            ? Buffer.byteLength(w2Body)
            : recorded.workloads.find((w) => w.name === name).bytes,
        elapsed_ms: outcome === "killed" ? 0 : 10 + i,
        scan_ms: engineRun && outcome === "admitted" ? 3 + (i % 5) : null,
        commit_ms:
          engineRun && outcome === "admitted" && !processing ? 20 + i : null,
        request_count: processing || !engineRun ? 0 : 1,
        limit: processing || !engineRun ? null : 1,
        changes_written: outcome === "admitted" ? 100 + i : null,
        cursor_after: processing || !engineRun ? null : "after",
        heap_baseline_bytes: engine === "chromium" ? 9e6 + i : null,
        heap_peak_bytes: engine === "chromium" ? 2e7 + i : null,
        heap_after_bytes: engine === "chromium" ? 1e7 + i : null,
        user_agent: `synthetic ${engine}`,
        at: t("device", 20 + i),
      };
    });
    const results = `${JSON.stringify(
      {
        schema: 2,
        kind: "protocol",
        protocol_id: protocolId,
        workload_version: recorded.version,
        w2sha256: w2sha,
        recorded_at: t("device", 80),
        created_at: t("device", 15),
        machine: {
          user_agent: `synthetic ${engine}`,
          device_memory_gib: engine === "chromium" ? 8 : null,
          hardware_concurrency: 8,
          platform: "synthetic",
          secure_context: true,
        },
        planned_runs: runs.length,
        terminal: "complete",
        error: null,
        takeovers: [],
        runs,
      },
      null,
      2,
    )}\n`;
    put(`device-page/results.${engine}.json`, results);
    const memory = rssOf(engine, `device|${engine}`);
    value("device", engine, "P-11 (device page):", "P-11 device page", {
      runs: runs.length,
      protocol_id: protocolId,
      results_file: `device-page/results.${engine}.json`,
      results_sha256: sha(results),
      w2_capture: {
        file: `w2/W2-captured.${engine}.limit-1.json`,
        sha256: w2sha,
      },
      browser_memory_whole_protocol: { ...memory, reading: "synthetic" },
    });
  }

  // The JSONL support files of P-7 and P-9.
  put(
    "contention/waits.jsonl",
    `${waitsJsonl.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  put(
    "contention/yield-policy.jsonl",
    `${policyJsonl.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );

  // The shared rows, stage after stage, and each stage's record with the range of lines it sealed as its own.
  const lines = Object.fromEntries(SHARED.map((f) => [f, []]));
  for (const stage of STAGE_ORDER) {
    const start = Object.fromEntries(SHARED.map((f) => [f, lines[f].length]));
    for (const f of SHARED) lines[f].push(...shared[stage][f]);
    const end = Object.fromEntries(SHARED.map((f) => [f, lines[f].length]));
    json(`stages/${stage}.json`, {
      evidence_key: "WEB-09a:sync-profiling",
      owner: "WEB-09c",
      stage,
      contract_version: 4,
      invocation,
      isolation_context: {
        schema: "atlas-profile-isolation-context/1",
        method: "invocation-root/1",
        invocation,
        evidence_dir: resolve(dir),
        root: { pid: ROOT_PID, started: ROOT_STARTED },
        support: null,
      },
      started_at: t(stage, -10),
      rows_at_start: start,
      candidate,
      debugging_samples: null,
      action_started_at: t(stage, 0),
      action_finished_at: t(stage, 3000),
      finished_at: t(stage, 3010),
      exit_status: 0,
      sealed: true,
      rows_at_end: end,
      sampler: {
        ready: true,
        ready_at: t(stage, -5),
        pid: SAMPLER_PID(stage),
        owner_pid: ROOT_PID,
        final_sample: true,
        exit_code: 0,
        samples: 603,
      },
      failure: null,
    });
    const samples = [];
    for (let s = -5; s <= 3005; s += INTERVAL / 1000) {
      const foreign = busy(stage, s);
      samples.push({
        at: t(stage, s),
        interval_ms: INTERVAL,
        method: "invocation-root/1",
        context: {
          invocation,
          stage,
          root_pid: ROOT_PID,
          root_started: ROOT_STARTED,
        },
        sampler_pid: SAMPLER_PID(stage),
        owner_pid: ROOT_PID,
        foreign_heavy: foreign,
        foreign: foreign.map((f) => {
          const [pid, ppid, pcpu, ...command] = f.split(" ");
          return {
            pid: Number(pid),
            ppid: Number(ppid),
            pcpu: Number(pcpu),
            started: ROOT_STARTED,
            command: command.join(" "),
            heavy: "synthetic",
          };
        }),
        support: [],
        own: [
          [ROOT_PID, 1, ROOT_STARTED, 50, "/usr/local/bin/node"],
          [
            SAMPLER_PID(stage),
            ROOT_PID,
            ROOT_STARTED,
            0.1,
            "/usr/local/bin/node",
          ],
        ],
        foreign_heavy_cpu_percent: foreign.length ? 180 : 0,
        support_cpu_percent: 0,
        other_cpu_percent: 10,
      });
    }
    samples[samples.length - 1].final = true;
    put(
      `isolation/${stage}.jsonl`,
      `${samples.map((x) => JSON.stringify(x)).join("\n")}\n`,
    );
  }
  for (const f of SHARED)
    put(f, `${lines[f].map((x) => JSON.stringify(x)).join("\n")}\n`);
  for (const [name, text] of files) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { at: t, invocation };
}

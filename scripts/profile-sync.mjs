#!/usr/bin/env node
// `pnpm profile:sync` (plan 7): the WEB-09a profiling programme, MEASUREMENTS and not budgets, written to
// .agtx/evidence/WEB-09a/profiling/ with the machine recorded first. It never claims more than it measured: every figure is
// `measured`, `modelled` or `not_run` with the reason, and the handoff says in its first paragraph that it does not meet the roster.
//
//   node scripts/profile-sync.mjs [--skip-build] [--only bundle,fixture,contention,integration,handoff] [--evidence <dir>]
//
//   P-1  bundle delta                       (pnpm build, check-budgets, the initial-chunk check)
//   P-2 P-3 P-5 P-11 P-Q  fixture specs     (real Chromium, Firefox, WebKit; one worker; the session's real stamped wrapper; the network a stub)
//   P-4 P-10 W2           integration specs (the released backend on SQLite behind the delaying proxy, loopback)
//   P-6 to P-9             the desktop CONTENTION programme (scripts/profile-contention.mjs, run here as the `contention` stage): the real
//                          stamped wrapper and ordinary engine, two or more pages, a FIXTURE leader, SYNTHETIC delays, a SYNTHETIC freeze
//   P-12                   provisional
//   handoff               results.json, report.md, SHA256SUMS, fixtures/ (generator source and hashes)
//
// Playwright contexts are ephemeral profiles: `durability: "strict"` is NOT measured against a real on-disk profile.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { withFixtureServer as serveFixture } from "./lib/fixture-server.mjs";
import { initialScripts } from "./lib/initial-chunk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const out = resolve(
  root,
  value("--evidence", ".agtx/evidence/WEB-09a/profiling"),
);
const only = value(
  "--only",
  "bundle,fixture,contention,integration,handoff",
).split(",");
const handoff = join(out, "handoff");
mkdirSync(handoff, { recursive: true });

const sh = (command, commandArgs, env = {}) =>
  spawnSync(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const log = (message) => console.log(`[profile:sync] ${message}`);

// ---- the machine, first ------------------------------------------------------------------------------------------------------------------
function machine() {
  const versions = sh(process.execPath, [
    "-e",
    `const pw=require("@playwright/test");(async()=>{const o={};for(const n of ["chromium","firefox","webkit"]){const b=await pw[n].launch();o[n]=b.version();await b.close();}console.log(JSON.stringify(o));})()`,
  ]).stdout.trim();
  const git = (...a) => sh("git", a).stdout.trim();
  const record = {
    recorded_at: new Date().toISOString(),
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memory_gib: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    playwright: sh(process.execPath, [
      join(root, "node_modules/@playwright/test/cli.js"),
      "--version",
    ]).stdout.trim(),
    engines: versions ? JSON.parse(versions) : null,
    atlas_web: {
      base_commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      working_tree_dirty: git("status", "--porcelain").length > 0,
    },
    note: "Playwright contexts are ephemeral profiles: IndexedDB durability ('strict') is not measured against a real on-disk profile, and loopback removes the network. The figures are for comparison between runs on this machine, not for any other. This is a developer machine, not a roster device.",
  };
  writeFileSync(
    join(out, "machine.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
const machineRecord = machine();

// ---- P-1: the bundle ---------------------------------------------------------------------------------------------------------------------
function bundle() {
  if (!flag("--skip-build")) {
    log("pnpm build (production)");
    const built = sh("pnpm", ["build"]);
    if (built.status !== 0) {
      console.error(built.stdout, built.stderr);
      process.exit(1);
    }
  }
  const baseline = JSON.parse(
    readFileSync(join(root, "perf-budget.json"), "utf8"),
  ).baseline.dist;
  const dist = join(root, "dist");
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const initial = new Set(
    initialScripts(html).map((s) => s.replace(/^\//, "")),
  );
  const gz = (file) => gzipSync(readFileSync(file)).length;
  const assets = readdirSync(join(dist, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({
      file: `assets/${f}`,
      raw: statSync(join(dist, "assets", f)).size,
      gzip: gz(join(dist, "assets", f)),
      initial: initial.has(`assets/${f}`),
      dexie: readFileSync(join(dist, "assets", f), "utf8").includes("Dexie"),
    }));
  const initialGzip = assets
    .filter((a) => a.initial)
    .reduce((n, a) => n + a.gzip, 0);
  const record = {
    id: "P-1",
    status: "measured",
    baseline_initial_js_gzip: baseline.initial_js_gzip,
    initial_js_gzip: initialGzip,
    delta_bytes: initialGzip - baseline.initial_js_gzip,
    delta_percent: +(
      ((initialGzip - baseline.initial_js_gzip) / baseline.initial_js_gzip) *
      100
    ).toFixed(2),
    initial_chunks: assets.filter((a) => a.initial).map((a) => a.file),
    dexie_in_initial_chunk: assets.some((a) => a.initial && a.dexie),
    lazy_chunks: assets
      .filter((a) => !a.initial)
      .map(({ file, raw, gzip, dexie }) => ({
        file,
        raw,
        gzip,
        contains_dexie: dexie,
      })),
    method:
      "gzip of each built JS chunk; 'initial' is what index.html loads (the entry and its modulepreloads); Dexie detected by its class name in the chunk text",
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(out, "bundle-delta.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  log(
    `P-1 initial JS ${record.initial_js_gzip} B gzip (baseline ${record.baseline_initial_js_gzip}, ${record.delta_percent} %); dexie in initial chunk: ${record.dexie_in_initial_chunk}`,
  );
  return record;
}

// ---- the fixture and integration measurements ---------------------------------------------------------------------------------------------
const withFixtureServer = (run) => serveFixture(root, run);

async function fixture() {
  if (!flag("--skip-build")) {
    log("pnpm build:fixture");
    const started = Date.now();
    const built = sh("pnpm", ["build:fixture"]);
    if (built.status !== 0) {
      console.error(built.stdout, built.stderr);
      process.exit(1);
    }
    writeFileSync(
      join(out, "fixture-build.json"),
      `${JSON.stringify({ seconds: +((Date.now() - started) / 1000).toFixed(1) })}\n`,
    );
  }
  for (const file of ["measurements.jsonl", "values.jsonl"])
    rmSync(join(out, file), { force: true });
  rmSync(join(out, "raw"), { recursive: true, force: true });
  rmSync(join(out, "memory"), { recursive: true, force: true });
  rmSync(join(out, "device-page"), { recursive: true, force: true });
  return withFixtureServer(async (url) => {
    log(`fixture profiling against ${url} (one worker, three engines)`);
    const ran = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--project=fixture-chromium",
        "--project=fixture-firefox",
        "--project=fixture-webkit",
        "--workers=1",
        "tests/e2e/fixture.profile-sync.spec.ts",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          ATLAS_PROFILE: "1",
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_FIXTURE_URL: url,
        },
      },
    );
    return ran.status ?? 1;
  });
}

function integration() {
  log("integration profiling (released backend, SQLite, loopback)");
  const ran = spawnSync(
    process.execPath,
    [
      join(root, "scripts/integration/run.mjs"),
      "--browsers",
      "chromium,firefox,webkit",
      "--evidence",
      join(out, "integration-run"),
      "--",
      "integration.profile-sync",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ATLAS_PROFILE: "1" },
    },
  );
  return ran.status ?? 1;
}

function contention() {
  log("contention profiling (P-6 to P-9)");
  const ran = spawnSync(
    process.execPath,
    [join(root, "scripts/profile-contention.mjs"), "--skip-build"],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  return ran.status ?? 1;
}

// ---- the handoff -------------------------------------------------------------------------------------------------------------------------
/** What the contention programme (scripts/profile-contention.mjs) left: one JSON per engine per programme item. */
function contentionEvidence() {
  const dir = join(out, "contention");
  const read = (prefix) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
      : [];
  return {
    unresolved: read("unresolved-leases."),
    retirements: read("retirements."),
    frozen: read("frozen-owner.").filter((r) => r.id === "P-7 frozen owner"),
    frozenProduction: read("frozen-owner-production-wait."),
    yieldPolicy: read("yield-policy."),
  };
}
const notRunContention =
  "not run in this record: run `pnpm profile:contention` (or `pnpm profile:sync`, which includes it) and then the handoff stage";

function contentionProgramme() {
  const e = contentionEvidence();
  const engines = (rows) => rows.map((r) => r.engine).sort();
  const p6 = e.unresolved.length
    ? {
        status: "measured",
        engines: engines(e.unresolved),
        label:
          "desktop; two or more pages of one context through the real stamped wrapper; the network is a stub. A closed tab is the real cause (clean: the session's own pagehide retires the lease; killed: SIMULATED by neutralising that handler; crashed: a REAL Chromium renderer crash); a slowed response and a failing recording write are INJECTED. 'saw_unresolved' counts scenarios in which the observing page's own cover carried another page's unresolved lease",
        by_engine: Object.fromEntries(
          e.unresolved.map((r) => [
            r.engine,
            { scenarios: r.scenarios, by_cause: r.by_cause },
          ]),
        ),
        files: "contention/unresolved-leases.<engine>.json",
      }
    : { status: "not_run", reason: notRunContention };
  const p7 = e.retirements.length
    ? {
        status: "measured",
        engines: engines(e.retirements),
        label:
          "waits of an ordinary request, an exposure, an atlas-auth writer and a closing write (a logout's initiation) of one page against a back-to-back FIXTURE leader (pages 5 ms apart, a synthetic server latency) and with no leader; see the measurement rows named P-7 and contention/waits.jsonl. A frozen owner is a main-thread block in a page that holds atlas-auth (SYNTHETIC: a Playwright engine cannot freeze a page), with the writer's lock wait SCALED to 1 s so the give-up is observed many times, and a few runs at the PRODUCTION 20 s wait",
        frozen_owner: Object.fromEntries(
          e.frozen.map((r) => [
            r.engine,
            {
              gave_up: r.gave_up,
              of: r.of,
              scaled_lock_wait_ms: r.scaled_lock_wait_ms,
            },
          ]),
        ),
        frozen_owner_production_wait: Object.fromEntries(
          e.frozenProduction.map((r) => [r.engine, r.rows]),
        ),
        files: "contention/waits.jsonl, contention/frozen-owner*.json",
      }
    : { status: "not_run", reason: notRunContention };
  const p8 = e.retirements.length
    ? {
        status: "measured",
        engines: engines(e.retirements),
        label:
          "counted from the kernel's own trace in each page (activity.cancel, lease.retired, lease.retire_failed) while the P-7 scenarios ran",
        by_engine: Object.fromEntries(
          e.retirements.map((r) => [r.engine, r.conditions]),
        ),
        files: "contention/retirements.<engine>.json",
      }
    : { status: "not_run", reason: notRunContention };
  const p9 = e.yieldPolicy.length
    ? {
        status: "measured",
        engines: engines(e.yieldPolicy),
        label:
          "the FIXTURE leader with each yield policy (none, macrotask, scheduler.yield, idle); policies are fixture code (production supplies its own at WEB-09b); 'scheduler_yield' falls back to a macrotask where the engine has no scheduler.yield (engine_support in each file)",
        by_engine: Object.fromEntries(
          e.yieldPolicy.map((r) => [
            r.engine,
            { engine_support: r.engine_support, rows: r.rows },
          ]),
        ),
        files:
          "contention/yield-policy.<engine>.json, contention/yield-policy.jsonl",
      }
    : { status: "not_run", reason: notRunContention };
  return { "P-6": p6, "P-7": p7, "P-8": p8, "P-9": p9 };
}

function readJsonl(file) {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}

function assembleHandoff(bundleRecord) {
  // The fixture and integration specs append to the same two files (tests/e2e/profile-helpers.ts).
  const measurements = readJsonl(join(out, "measurements.jsonl"));
  const values = readJsonl(join(out, "values.jsonl"));
  const hashes = JSON.parse(
    readFileSync(
      join(root, "scripts/lib/profile-workload-hashes.json"),
      "utf8",
    ),
  );
  const fixtures = join(handoff, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  copyFileSync(
    join(root, "scripts/lib/profile-workloads.mjs"),
    join(fixtures, "profile-workloads.mjs"),
  );
  writeFileSync(
    join(fixtures, "hashes.json"),
    `${JSON.stringify(hashes, null, 2)}\n`,
  );

  // Desktop results of the device page, validated by the same tool a device operator uses.
  const validated = {};
  const devicePageDir = join(out, "device-page");
  if (existsSync(devicePageDir))
    for (const file of readdirSync(devicePageDir)) {
      const v = sh(process.execPath, [
        join(root, "scripts/validate-profile-handoff.mjs"),
        join(devicePageDir, file),
      ]);
      validated[file] = {
        exit: v.status,
        output: `${v.stdout}${v.stderr}`.trim().split("\n").slice(-6),
      };
    }

  const memoryDir = join(out, "memory");
  const memory = existsSync(memoryDir)
    ? readdirSync(memoryDir).map((f) =>
        JSON.parse(readFileSync(join(memoryDir, f), "utf8")),
      )
    : [];

  // H8: the smallest valid response the client could not process on any desktop engine of this run.
  const failures = [];
  for (const m of memory)
    for (const row of m.rows ?? [])
      if (row.expected === "admitted")
        for (const run of row.runs)
          if (run.outcome !== "admitted")
            failures.push({
              engine: m.engine,
              workload: row.workload,
              outcome: run.outcome,
            });
  const negativeAdmitted = [];
  for (const m of memory)
    for (const row of m.rows ?? [])
      if (row.expected === "refused")
        for (const run of row.runs)
          if (run.outcome === "admitted")
            negativeAdmitted.push({ engine: m.engine, workload: row.workload });

  const w2 = values.find((v) => v.name === "W2 feasibility");
  const results = {
    schema: 1,
    first_paragraph:
      "This record was taken on a macOS developer machine with Playwright engines; it does not meet the roster in H1; the B1/Q23 measurement gate remains held until the roster runs.",
    H0: {
      status: "measured",
      provenance: machineRecord.atlas_web,
      node: machineRecord.node,
      playwright: machineRecord.playwright,
      backend: "released v0.27.0-rc.1 (integration measurements only)",
      api_pin: "contract-pin.json",
      date: machineRecord.recorded_at,
      operator: "the Running-phase agent; no person has reviewed this record",
    },
    H1: {
      status: "partial",
      reason:
        "the developer machine only; the roster (real devices, installed apps, lowest-memory supported devices) needs a person",
      roster: [
        {
          device: "developer machine",
          os: machineRecord.os,
          cpu: machineRecord.cpu,
          cores: machineRecord.cores,
          memory_gib: machineRecord.memory_gib,
          engines: machineRecord.engines,
          device_memory_signal:
            "see the device-page results (machine.device_memory_gib)",
          installed_app: false,
        },
      ],
    },
    H2: {
      status: "partial",
      method:
        "peak and retained JS heap (Chromium only, CDP) and the engine process tree's RSS (ps, all three engines) across receive, scan, validate, stage and commit; five cold runs (a new browser context each); idle baseline recorded before the run; outcome per run; the modelled figure is WEB-03's (A:3483-3497) beside each measured one, labelled modelled",
      modelled: {
        "W1 at limit 1":
          "150.75 MiB (WEB-03's combined check, 120.6 % of its R, rejected by that model; this client does not apply that check, it bounds processing instead)",
      },
      memory_files: memory.map((m) => `memory/P-11.${m.engine}.json`),
    },
    H3: {
      status: "partial",
      fixtures: hashes.workloads,
      w2_captured: w2 ?? null,
      note: "W1 reproduces the design's 455,214 nodes and 5.83 MiB (tests/profiling/workloads.test.ts); W2 is what the released backend could produce, probed by the integration spec, not the W1 shape",
    },
    H4: {
      status: "partial",
      reason:
        "desktop engines only: the page-size ladder (100/200/400/800 changes, ordinary and dense) is P-2; the batch ladder 1 to 80 is W5 in the device page",
      measurement_names: measurements
        .filter((m) => m.name.startsWith("P-2"))
        .map((m) => m.name)
        .filter((n, i, a) => a.indexOf(n) === i),
    },
    H5: {
      status: "partial",
      measured:
        "two pages of one context with a FIXTURE leader syncing back to back while another page makes ordinary requests, exposures and closing writes (P-6 to P-9, desktop, synthetic delays); the outbox drain with a second tab (E-O4, functional)",
      reason:
        "three tabs, a second tab taking over mid-snapshot (WEB-09b), a REAL freeze or back/forward cache, an installed app plus a tab and every mobile class need the production leader and real devices",
    },
    H6: {
      status: "measured",
      design:
        "bounded processing as built: a byte scan builds no object graph (pass 1), one element is decoded at a time inside the commit transaction (pass 2), writes are chunked, only ids of interest to local work are remembered; the working set is one element, never the page. No backend finer-delivery parameter exists (BE-Q23 unshipped), so the build is described without one.",
    },
    H7: {
      status: "partial",
      reason:
        "only the `limit` axis exists (no finer parameter): the per-page costs are P-2 and P-4; a 10,000-resource snapshot is WEB-09b's and was not run",
      per_request_lease_cost:
        "P-4 (pre-issue, stamping and post-response segments)",
    },
    H8: {
      status: "partial",
      desktop_answer:
        failures.length === 0
          ? "no valid workload (W1, W3, W4, W6) was refused or failed on any desktop engine of this run"
          : { failures },
      negative_controls_admitted: negativeAdmitted,
      reason: "the roster's answer is needed for any supported mobile device",
    },
    H9: {
      status: "partial",
      limit_in_use: "1 at the lowest rung (unconstrained 4, floor 1)",
      client_validator_consumes_SyncPage_batches_maxItems: false,
      reason_validator:
        "decision D-10: the scanner enforces its own bounds (80 batches, 800 changes per batch) and does not rely on the contract's batches.maxItems",
      needs_finer_pagination: "not determined: needs the roster",
      w1_w2_admitted_at_current_floor:
        "W1 admitted on every desktop engine of this run (see memory/); W2 is not the W1 shape; not determined for a floor device",
    },
    programme: {
      "P-1": bundleRecord,
      "P-2": {
        status: "measured",
        engines: ["chromium", "firefox", "webkit"],
        note: "see measurements.jsonl rows named P-2",
      },
      "P-3": {
        status: "measured",
        caveat:
          "ephemeral Playwright profile; the hint is passed through Dexie's `chromeTransactionDurability` option; whether Firefox and WebKit act on it was not determined",
      },
      "P-4": {
        status: "measured",
        layer: "integration, released backend on loopback",
      },
      "P-5": {
        status: "partial",
        measured: "maxInFlight 1, 200 drafts, 20 runs",
        not_run:
          "maxInFlight 2 and 3 (D-18 fixes 1), and the outbox drain's own effect on a second page's waits (the sync leader's effect is P-7 and P-9)",
      },
      ...contentionProgramme(),
      "P-10": { status: "measured", conclusion: "measured; unchanged (30 s)" },
      "P-11": {
        status: "partial",
        note: "desktop engines through the real wrapper and through the device page; real devices not run",
      },
      "P-12": { status: "provisional", file: "constants.md" },
      "P-Q": {
        status: "partial",
        note: "footprints measured; Firefox and Safari report an obfuscated estimate; the reserve (8 MiB) remains an unmeasured engineering default",
      },
    },
    device_page_validation: validated,
    measurement_rows: measurements.length,
  };
  writeFileSync(
    join(handoff, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  const table = measurements
    .map(
      (m) =>
        `| ${m.name} | ${m.engine} | ${m.n} | ${m.p50} | ${m.p95} | ${m.max} |`,
    )
    .join("\n");
  writeFileSync(
    join(handoff, "report.md"),
    `# WEB-09a profiling handoff

${results.first_paragraph}

Every figure below is \`measured\` (taken by this programme in the stated environment), \`modelled\` (WEB-03's arithmetic) or \`not_run\` (with the reason). Nothing here is a pass mark. Playwright contexts are ephemeral profiles: \`durability: "strict"\` is not measured against a real on-disk profile. Server RSS, Node-only runs, emulated devices, single-tab results presented as multi-tab, and \`limit\`-only step-down presented as proof that finer delivery is unnecessary are **not** claimed.

Machine: ${machineRecord.os}, ${machineRecord.cpu}, ${machineRecord.cores} cores, ${machineRecord.memory_gib} GiB, Node ${machineRecord.node}, ${machineRecord.playwright}; engines ${JSON.stringify(machineRecord.engines)}.

## Status by item

${Object.entries(results)
  .filter(([k]) => /^H\d$/.test(k))
  .map(
    ([k, v]) =>
      `* **${k}**: ${v.status}${v.reason ? ` (${v.reason})` : ""}${v.measured ? ` (${v.measured})` : ""}`,
  )
  .join("\n")}

## Programme

${Object.entries(results.programme)
  .map(
    ([k, v]) =>
      `* **${k}**: ${v.status}${v.reason ? `. ${v.reason}` : ""}${v.note ? `. ${v.note}` : ""}${v.caveat ? `. ${v.caveat}` : ""}${v.label ? `. ${v.label}` : ""}`,
  )
  .join("\n")}

## Measurements (milliseconds unless the name says otherwise; p50, p95 and max)

| Measurement | Engine | n | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
${table}

Raw samples are in \`../raw/\`, per-run memory in \`../memory/\`, the device page's own results in \`../device-page/\`, and the recorded fixture hashes in \`fixtures/hashes.json\`.
`,
  );

  // SHA256SUMS over every file of the handoff
  const lines = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name !== "SHA256SUMS")
        lines.push(
          `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${relative(handoff, p)}`,
        );
    }
  };
  walk(handoff);
  writeFileSync(join(handoff, "SHA256SUMS"), `${lines.sort().join("\n")}\n`);

  // P-12: provisional constants, never presented as measured
  writeFileSync(
    join(out, "constants.md"),
    `# Provisional constants (P-12): none of these is measured\n\nThe single module is src/data/model/config.ts. Each row names its source and the figure that would settle it.\n\n| Name | Value | Source | Settled by |\n| --- | --- | --- | --- |\n| SYNC_LIMIT_MAX | 80 | D section 4.2; B1 unshipped | B1 |\n| initial rung (unconstrained / other) | 4 / 1 | WEB-03 3.3d | the P-11 roster |\n| step-up | disabled | not specified anywhere | the P-11 roster |\n| floor after | 3 | D's three-failure family | the P-11 roster |\n| marker minimum | 256 KiB | engineering default | P-2, P-4 |\n| apply watchdog | 30,000 ms | engineering default | P-2 |\n| sync idle / receipt poll | 60 s / 2 s | not specified (D leaves cadence open) | a cadence decision |\n| back-off | 2 s doubling to 60 s, +/- 20 % | the matrix schedule for covers | a cadence decision |\n| sustained threshold | 180 s | D: "a few minutes" | a cadence decision |\n| queue warn / working set | 200 / 100 | Q9, WEB-03 | P-5, P-Q |\n| queue rescan | 5 s, doubling to 60 s | this slice | P-5 on a dense queue |\n| fence stale | 120 s | engineering default | P-4 |\n| quota reserve | 8 MiB | engineering default; P-Q measured the authentication footprint (see quota.json) | the roster, and genuine exhaustion |
| persistence hold wait / bound | 20 s / 30 s | this slice (session obligation 4, revision 5) | P-7 (the hold's wait is part of the same lock) |\n| stamped request time-out | 30 s (WEB-08a) | provisional | P-10: measured; unchanged |\n| maxInFlight | 1 | D-18 | P-5 (only 1 is measurable) |\n`,
  );
}

const bundleRecord = only.includes("bundle")
  ? bundle()
  : JSON.parse(readFileSync(join(out, "bundle-delta.json"), "utf8"));
let status = 0;
if (only.includes("fixture")) status ||= await fixture();
if (only.includes("contention")) status ||= contention();
if (only.includes("integration")) status ||= integration();
if (only.includes("handoff")) assembleHandoff(bundleRecord);
log(`written to ${out}`);
process.exit(status);

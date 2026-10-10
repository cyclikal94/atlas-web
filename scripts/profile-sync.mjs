#!/usr/bin/env node
// `pnpm profile:sync`: the sync-profiling programme (evidence key `WEB-09a:sync-profiling`, owned by WEB-09c since BC-20261009). It takes
// MEASUREMENTS, not budgets, into the evidence directory the caller names, with the machine, the candidate and the load recorded first. It
// never claims more than it measured: every figure is `measured`, `partial`, `not_run` or `escalated` with the reason, and the hand-over says
// in its first paragraph that it is desktop-only and does not meet the device roster.
//
//   node scripts/profile-sync.mjs --evidence <dir> [--skip-build] [--preflight]
//                                 [--only bundle,fixture,shell,contention,integration,device,handoff]
//
//   bundle       P-1   both builds: composition, the initial chunk, Dexie never in it, and `check-budgets.mjs` for each (copied in)
//   fixture      P-2 P-3 P-5 P-11 P-Q P-Q2   fixture specs (real Chromium, Firefox, WebKit; one worker; the real stamped wrapper; a stub network)
//   shell        P-1S  throttled shell boot of `dist` and `dist-fixture` (Chromium, CDP throttling: EMULATED, not a device)
//   contention   P-6 to P-9, P-13   scripts/profile-contention.mjs (two or more pages, a FIXTURE leader, SYNTHETIC delays and freeze)
//   integration  P-4 P-10 P-W2   the released backend on SQLite behind the delaying proxy, loopback
//   device       P-11 (device page)   the device page's whole protocol on the desktop engines, W2 from this directory's captures (so after
//                integration): the route a device operator follows
//   handoff      results.json (the consumer map, the isolation of every series, the completeness inventory), report.md, constants.md
//                (P-12), fixtures/, SHA256SUMS
//
// Every stage but the handoff samples the controller's load while it runs (`isolation/<stage>.jsonl`, scripts/lib/profile-isolation.mjs);
// the handoff judges every row over its collection window and says, in the hashed package, which figures were taken in isolation. A
// conclusion about the desktop engines is drawn only from a complete programme (every stage, case, engine, workload and outcome; review R2).
//
// `--evidence` is required and nothing is ever deleted: a stage already recorded in the directory is refused (exit 2) and a fresh directory
// is the only route (plan 4.1). `--preflight` checks the arguments and the directory, prints what would run, and writes nothing.
// Playwright contexts are ephemeral profiles: `durability: "strict"` is NOT measured against a real on-disk profile.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { freePort } from "./integration/free-port.mjs";
import { withFixtureServer as serveFixture } from "./lib/fixture-server.mjs";
import { initialScripts } from "./lib/initial-chunk.mjs";
import {
  COLD_RUN_WORKLOADS,
  COLLECTION_LOG,
  candidate,
  ENGINES,
  EVIDENCE_KEY,
  EVIDENCE_OWNER,
  evidenceArg,
  finishStage,
  PROGRAMME_STAGES,
  REQUIRED_CASES,
  REQUIRED_COLD_RUNS,
  recordStage,
  refuseRecorded,
  STAGES,
} from "./lib/profile-evidence.mjs";
import {
  annotate,
  readSamples,
  startLoadSampler,
} from "./lib/profile-isolation.mjs";
import { allWorkloads } from "./lib/profile-workloads.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: node scripts/profile-sync.mjs --evidence <dir> [--skip-build] [--preflight] [--only bundle,fixture,shell,contention,integration,device,handoff]";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const out = evidenceArg(args, root, USAGE);
const only = value(
  "--only",
  "bundle,fixture,shell,contention,integration,device,handoff",
).split(",");
for (const stage of only)
  if (!STAGES.includes(stage)) {
    console.error(`unknown stage ${stage}\n${USAGE}`);
    process.exit(2);
  }
// The contention stage is recorded (and refused) by its own driver.
refuseRecorded(out, only);
const log = (message) => console.log(`[profile:sync] ${message}`);
if (flag("--preflight")) {
  log(
    `preflight: would run ${only.join(", ")} into ${out}; nothing was written`,
  );
  process.exit(0);
}
mkdirSync(out, { recursive: true });

const sh = (command, commandArgs, env = {}) =>
  spawnSync(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const childEnv = { ATLAS_PROFILE: "1", ATLAS_PROFILE_OUT: out };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;

// ---- the machine, first ------------------------------------------------------------------------------------------------------------------
function machine() {
  const versions = sh(process.execPath, [
    "-e",
    `const pw=require("@playwright/test");(async()=>{const o={};for(const n of ["chromium","firefox","webkit"]){const b=await pw[n].launch();o[n]=b.version();await b.close();}console.log(JSON.stringify(o));})()`,
  ]).stdout.trim();
  const git = (...a) => sh("git", a).stdout.trim();
  return {
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
}
const machineRecord = machine();
if (!existsSync(join(out, "machine.json")))
  writeFileSync(
    join(out, "machine.json"),
    `${JSON.stringify(machineRecord, null, 2)}\n`,
  );

// ---- P-1: the bundles --------------------------------------------------------------------------------------------------------------------
function composition(build) {
  const dir = join(root, build);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const initial = new Set(
    initialScripts(html).map((s) => s.replace(/^\//, "")),
  );
  const gz = (file) => gzipSync(readFileSync(file)).length;
  const assets = readdirSync(join(dir, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({
      file: `assets/${f}`,
      raw: statSync(join(dir, "assets", f)).size,
      gzip: gz(join(dir, "assets", f)),
      initial: initial.has(`assets/${f}`),
      dexie: readFileSync(join(dir, "assets", f), "utf8").includes("Dexie"),
    }));
  return {
    initial_js_gzip_default_level: assets
      .filter((a) => a.initial)
      .reduce((n, a) => n + a.gzip, 0),
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
  };
}

function bundle() {
  if (!flag("--skip-build"))
    for (const [script, label] of [
      ["build", "production"],
      ["build:fixture", "fixture"],
    ]) {
      log(`pnpm ${script} (${label})`);
      const started = Date.now();
      const built = sh("pnpm", [script]);
      if (built.status !== 0) {
        console.error(built.stdout, built.stderr);
        return 1;
      }
      mkdirSync(join(out, "bundle"), { recursive: true });
      writeFileSync(
        join(out, "bundle", `build-${label}.json`),
        `${JSON.stringify({ script, seconds: +((Date.now() - started) / 1000).toFixed(1) })}\n`,
      );
    }
  mkdirSync(join(out, "bundle"), { recursive: true });
  const budgets = {};
  let status = 0;
  for (const build of ["dist", "dist-fixture"]) {
    // check-budgets.mjs always writes its profile to the fixed WEB-07 path; the copy here, with its hash, is this run's record of it.
    const checked = sh(process.execPath, [
      join(root, "scripts/check-budgets.mjs"),
      build,
    ]);
    writeFileSync(
      join(out, "bundle", `check-budgets-${build}.log`),
      `${checked.stdout}${checked.stderr}`,
    );
    const source = join(
      root,
      ".agtx/evidence/WEB-07/A2",
      `bundle-profile-${build}.json`,
    );
    const target = join(out, "bundle", `bundle-profile-${build}.json`);
    copyFileSync(source, target);
    budgets[build] = {
      exit: checked.status,
      file: `bundle/bundle-profile-${build}.json`,
      sha256: sha256(readFileSync(target)),
      measured: readJson(target)?.measured ?? null,
    };
    if (checked.status !== 0) status = 1;
  }
  const perfBudget = JSON.parse(
    readFileSync(join(root, "perf-budget.json"), "utf8"),
  );
  const baseline = perfBudget.baseline.dist;
  const production = composition("dist");
  const record = {
    id: "P-1",
    status: "measured",
    baseline_initial_js_gzip: baseline.initial_js_gzip,
    initial_js_gzip: budgets.dist.measured?.initial_js_gzip ?? null,
    delta_bytes:
      (budgets.dist.measured?.initial_js_gzip ?? 0) - baseline.initial_js_gzip,
    initial_chunks: production.initial_chunks,
    dexie_in_initial_chunk: production.dexie_in_initial_chunk,
    lazy_chunks: production.lazy_chunks,
    fixture: composition("dist-fixture"),
    budgets,
    perf_budget_sha256: sha256(readFileSync(join(root, "perf-budget.json"))),
    method:
      "check-budgets.mjs (gzip level 9 of what index.html loads: the entry and its modulepreloads; CSS; font bytes) for both builds, its profile copied here; the composition is gzip at the default level of each built chunk, Dexie detected by its class name in the chunk text",
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(out, "bundle-delta.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  log(
    `P-1 initial JS ${record.initial_js_gzip} B gzip (production baseline ${record.baseline_initial_js_gzip}); fixture ${budgets["dist-fixture"].measured?.initial_js_gzip}; dexie in initial chunk: ${record.dexie_in_initial_chunk}`,
  );
  return status;
}

// ---- the fixture measurements -------------------------------------------------------------------------------------------------------------
const withFixtureServer = (run) => serveFixture(root, run);

async function fixture() {
  if (!flag("--skip-build") && !only.includes("bundle")) {
    log("pnpm build:fixture");
    const started = Date.now();
    const built = sh("pnpm", ["build:fixture"]);
    if (built.status !== 0) {
      console.error(built.stdout, built.stderr);
      return 1;
    }
    writeFileSync(
      join(out, "fixture-build.json"),
      `${JSON.stringify({ seconds: +((Date.now() - started) / 1000).toFixed(1) })}\n`,
    );
  }
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
        "--retries=0",
        // The device page's protocol is its own stage: it needs the integration stage's W2 capture.
        "--grep-invert",
        DEVICE_CASE,
        "tests/e2e/fixture.profile-sync.spec.ts",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          ...childEnv,
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_FIXTURE_URL: url,
        },
      },
    );
    return ran.status ?? 1;
  });
}

// ---- the device page's protocol on the desktop engines, W2 included (review R3) -----------------------------------------------------------
const DEVICE_CASE = "P-11 \\(device page\\)";
async function device() {
  const missing = ENGINES.filter(
    (engine) =>
      !existsSync(join(out, "w2", `W2-captured.${engine}.limit-1.json`)),
  );
  if (missing.length > 0) {
    console.error(
      `the device stage needs the integration stage's W2 captures in ${join(out, "w2")}; missing for ${missing.join(", ")}`,
    );
    return 1;
  }
  return withFixtureServer(async (url) => {
    log(`the device page's protocol (W2 included) against ${url}`);
    const ran = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--project=fixture-chromium",
        "--project=fixture-firefox",
        "--project=fixture-webkit",
        "--workers=1",
        "--retries=0",
        "--grep",
        DEVICE_CASE,
        "tests/e2e/fixture.profile-sync.spec.ts",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          ...childEnv,
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_FIXTURE_URL: url,
        },
      },
    );
    return ran.status ?? 1;
  });
}

// ---- P-1S: the throttled shell boot (Chromium; EMULATED throttling, not a device) ------------------------------------------------------------
async function shellStage() {
  const dir = join(out, "shell");
  mkdirSync(dir, { recursive: true });
  const shell = (url, file) =>
    spawnSync(
      process.execPath,
      [
        join(root, "scripts/profile-shell.mjs"),
        "--url",
        url,
        "--out",
        join(dir, file),
      ],
      { cwd: root, stdio: "inherit" },
    ).status ?? 1;
  let status = await withFixtureServer(async (url) => {
    log(`P-1S dist-fixture (the signed-in shell) at ${url}`);
    return shell(`${url}/today?pending=2`, "dist-fixture.json");
  });
  if (status !== 0) return status;
  // The production build boots against a stub that answers /health and /ready only (it asks for the API version at boot).
  const port = await freePort();
  const server = spawn(
    process.execPath,
    [
      join(root, "scripts/preview-with-stub-backend.mjs"),
      "--port",
      String(port),
    ],
    { cwd: root, stdio: "ignore", detached: true },
  );
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i += 1) {
      try {
        if ((await fetch(`${url}/`)).ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    log(`P-1S dist (the neutral production entry) at ${url}`);
    status = shell(`${url}/`, "dist.json");
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  writeFileSync(
    join(dir, "servers.json"),
    `${JSON.stringify(
      {
        "dist-fixture":
          "vite preview --mode fixture (scripts/lib/fixture-server.mjs), loopback",
        dist: "vite preview of dist with a stub backend for /health and /ready (scripts/preview-with-stub-backend.mjs), loopback",
        compression:
          "as the preview server serves it; each row records the content-encoding the page received for its first script",
        not: "the nginx configuration (deploy/nginx/web.conf) was not used: the colima runtime would need host bind mounts, which are not used on this controller",
      },
      null,
      2,
    )}\n`,
  );
  return status;
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
      env: { ...process.env, ...childEnv },
    },
  );
  return ran.status ?? 1;
}

function contention() {
  log("contention profiling (P-6 to P-9, P-13)");
  const ran = spawnSync(
    process.execPath,
    [
      join(root, "scripts/profile-contention.mjs"),
      "--skip-build",
      "--evidence",
      out,
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  return ran.status ?? 1;
}

// ---- the handoff -------------------------------------------------------------------------------------------------------------------------
function readJsonl(file) {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}
const readDir = (dir, prefix) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    : [];
const enginesOf = (rows) => [...new Set(rows.map((r) => r.engine))].sort();
const allEngines = (rows) =>
  ENGINES.every((engine) => rows.some((r) => r.engine === engine));

/** What the contention programme (scripts/profile-contention.mjs) left: one JSON per engine per programme item. */
function contentionProgramme() {
  const dir = join(out, "contention");
  const e = {
    unresolved: readDir(dir, "unresolved-leases."),
    retirements: readDir(dir, "retirements."),
    frozen: readDir(dir, "frozen-owner.").filter(
      (r) => r.id === "P-7 frozen owner",
    ),
    frozenProduction: readDir(dir, "frozen-owner-production-wait."),
    yieldPolicy: readDir(dir, "yield-policy."),
    followers: readDir(dir, "follower-reads."),
  };
  const notRun =
    "not run in this record: the contention stage (scripts/profile-contention.mjs --evidence <dir>) did not leave its files";
  const status = (rows) =>
    rows.length === 0 ? "not_run" : allEngines(rows) ? "measured" : "partial";
  return {
    "P-6": e.unresolved.length
      ? {
          status: status(e.unresolved),
          engines: enginesOf(e.unresolved),
          label:
            "desktop; two or more pages of one context through the real stamped wrapper; the network is a stub. A closed tab is the real cause (clean: the session's own pagehide retires the lease; killed: SIMULATED by neutralising that handler; crashed: a REAL Chromium renderer crash); a slowed response and a failing recording write are INJECTED. 'precondition_met' counts the scenarios in which the record already held another page's lease when the observing page was about to make its first request (read from atlas-auth just before it); 'saw_unresolved' counts the scenarios in which a cover the observing page committed AFTER the closure carried at least one unresolved lease of another page. They are read at different moments, so a lease that appears after the precondition read (a closing tab's own write racing the observer) counts in 'saw_unresolved' and not in 'precondition_met'; neither is a defect count",
          by_engine: Object.fromEntries(
            e.unresolved.map((r) => [
              r.engine,
              { scenarios: r.scenarios, by_cause: r.by_cause },
            ]),
          ),
          files: "contention/unresolved-leases.<engine>.json",
        }
      : { status: "not_run", reason: notRun },
    "P-7": e.retirements.length
      ? {
          status: status(e.retirements),
          engines: enginesOf(e.retirements),
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
      : { status: "not_run", reason: notRun },
    "P-8": e.retirements.length
      ? {
          status: status(e.retirements),
          engines: enginesOf(e.retirements),
          label:
            "counted from the kernel's own trace in each page (activity.cancel, lease.retired, lease.retire_failed) while the P-7 scenarios ran",
          by_engine: Object.fromEntries(
            e.retirements.map((r) => [r.engine, r.conditions]),
          ),
          files: "contention/retirements.<engine>.json",
        }
      : { status: "not_run", reason: notRun },
    "P-9": e.yieldPolicy.length
      ? {
          status: status(e.yieldPolicy),
          engines: enginesOf(e.yieldPolicy),
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
      : { status: "not_run", reason: notRun },
    "P-13": e.followers.length
      ? {
          status: status(e.followers),
          engines: enginesOf(e.followers),
          label:
            "healthy-follower reads caused by `atlas-sync` hints (R60): a FIXTURE leader, a healthy follower showing the outbox facade and the cache gate, and a writer recording and ending durable stops; counted by test-side instrumentation only (a wrapped BroadcastChannel and IDBDatabase.prototype.transaction in the follower page)",
          by_engine: Object.fromEntries(
            e.followers.map((r) => [r.engine, r.conditions]),
          ),
          files: "contention/follower-reads.<engine>.json",
        }
      : { status: "not_run", reason: notRun },
  };
}

/** P-12: the provisional constants as `src/data/model/config.ts` holds them on this candidate, never presented as measured. */
function constants() {
  const dumped = sh(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    "-e",
    `import("./src/data/model/config.ts").then((m) => console.log(JSON.stringify({ config: m.DATA_CONFIG, maxResponseBytesForLimit1: m.maxResponseBytesFor(1), maxResponseBytesForLimit4: m.maxResponseBytesFor(4) })))`,
  ]);
  const values = dumped.status === 0 ? JSON.parse(dumped.stdout.trim()) : null;
  const docs = readFileSync(join(root, "docs/data-layer.md"), "utf8");
  const table =
    /## Provisional constants\n[\s\S]*?(\| Name \|[\s\S]*?)\n\n/.exec(
      docs,
    )?.[1];
  writeFileSync(
    join(out, "handoff", "constants.md"),
    `# Provisional constants (P-12): none of these is measured

Generated from \`src/data/model/config.ts\` on this candidate (the values) and \`docs/data-layer.md\` (the source and what would settle each). A
desktop figure of this programme is evidence beside a constant; it does not settle one that names the device roster.

## Values (DATA_CONFIG)

\`\`\`json
${JSON.stringify(values, null, 2)}
\`\`\`

## Source and what settles each (docs/data-layer.md)

${table ?? "(the table was not found in docs/data-layer.md)"}
`,
  );
  return values;
}

/** Every stage recorded here must have run on the candidate the handoff is assembled on; otherwise nothing is assembled. */
function stageRecords() {
  const dir = join(out, "stages");
  const records = existsSync(dir)
    ? Object.fromEntries(
        readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => [
            f.replace(/\.json$/, ""),
            JSON.parse(readFileSync(join(dir, f), "utf8")),
          ]),
      )
    : {};
  return records;
}

const W_IN_BE = {
  W1: "BE-B1 3(a) / BE-Q23 M3 W1: the approved schema-maximum dense batch (800 x 100-item checklists)",
  W2: "BE-B1 3(b) / BE-Q23 M3 W2: the server-maximal dense batch produced by the real backend",
  W3: "BE-B1 3(c) / BE-Q23 M3 W3: an ordinary text-heavy batch",
  W4: "BE-Q23 M3 W4: multi-batch amplification",
  W5: "BE-B1 3(e) / BE-Q23 M3 W5: snapshot pages at each candidate limit (processing path only)",
  W6: "BE-Q23 M3 W6: the largest single projection per kind",
  W7: "BE-Q23 M3 W7: malformed and oversize negative controls",
};

/**
 * The finite inventory of a complete desktop programme (review R2), from what the directory holds: every programme stage recorded,
 * finished and exit 0; every required case collected exactly once in every engine and passed; per engine, five cold runs of W1, W3, W4
 * and W6, one run of every W7 control (each refused), W2's live outcome and five cold runs, the device page's results validated (W2
 * included); the throttled boot of both builds; both budget checks. `outcomes_complete` holds when nothing is missing or failed;
 * `complete` also needs every series isolated. Missing and failed items are listed, never inferred away.
 */
function completeness({
  stages,
  collectionLog,
  memory,
  w2Memory,
  validated,
  shellPresent,
  bundleRecord,
  negativeAdmitted,
  isolation,
}) {
  const missing = [];
  const failed = [];
  for (const stage of PROGRAMME_STAGES) {
    const r = stages[stage];
    if (!r) missing.push(`stage ${stage}: not recorded`);
    else if (!r.finished_at) failed.push(`stage ${stage}: never finished`);
    else if (r.exit_status !== 0)
      failed.push(`stage ${stage}: exit status ${r.exit_status}`);
  }
  for (const [stage, prefixes] of Object.entries(REQUIRED_CASES))
    for (const engine of ENGINES)
      for (const prefix of prefixes) {
        const found = collectionLog.filter(
          (t) => t.engine === engine && String(t.test).startsWith(prefix),
        );
        if (found.length === 0)
          missing.push(
            `case "${prefix}" [${engine}] (${stage}): not collected`,
          );
        else if (found.length > 1)
          failed.push(
            `case "${prefix}" [${engine}] (${stage}): collected ${found.length} times`,
          );
        else if (found[0].status !== "passed")
          failed.push(
            `case "${prefix}" [${engine}] (${stage}): ${found[0].status}`,
          );
      }
  const controls = allWorkloads()
    .map((w) => w.name)
    .filter((name) => name.startsWith("W7-"));
  const runsOf = (file, workload) =>
    (file?.rows ?? [])
      .filter((row) => row.workload === workload)
      .flatMap((row) => row.runs ?? []);
  for (const engine of ENGINES) {
    const p11 = memory.find((m) => m.engine === engine);
    if (!p11) missing.push(`P-11 cold runs [${engine}]: no memory file`);
    else {
      for (const workload of COLD_RUN_WORKLOADS) {
        const n = runsOf(p11, workload).filter((r) => r.outcome).length;
        if (n < REQUIRED_COLD_RUNS)
          missing.push(
            `${workload} [${engine}]: ${n} of ${REQUIRED_COLD_RUNS} cold runs with an outcome`,
          );
      }
      for (const control of controls)
        if (runsOf(p11, control).filter((r) => r.outcome).length === 0)
          missing.push(`${control} [${engine}]: no run`);
    }
    const w2 = w2Memory.find((m) => m.engine === engine);
    if (!w2) missing.push(`P-W2 [${engine}]: no file`);
    else {
      if (!w2.live?.outcome)
        missing.push(`P-W2 live application [${engine}]: no outcome`);
      const n = runsOf(w2, "W2").filter((r) => r.outcome).length;
      if (n < REQUIRED_COLD_RUNS)
        missing.push(
          `W2 [${engine}]: ${n} of ${REQUIRED_COLD_RUNS} cold runs with an outcome`,
        );
    }
    const device = validated[`results.${engine}.json`];
    if (!device) missing.push(`device page [${engine}]: no results`);
    else if (device.exit !== 0)
      failed.push(
        `device page [${engine}]: the validator exited ${device.exit} (${device.output.join(" / ")})`,
      );
  }
  for (const [build, present] of Object.entries(shellPresent))
    if (!present) missing.push(`P-1S ${build}: no result`);
  if (!bundleRecord) missing.push("P-1: no bundle record");
  else
    for (const [build, b] of Object.entries(bundleRecord.budgets ?? {}))
      if (b.exit !== 0)
        failed.push(`P-1 budget check ${build}: exit status ${b.exit}`);
  for (const n of negativeAdmitted)
    failed.push(`${n.workload} [${n.engine}]: a negative control was ADMITTED`);
  const notIsolated = isolation.series.filter((r) => r.verdict !== "clean");
  const outcomesComplete = missing.length === 0 && failed.length === 0;
  return {
    complete: outcomesComplete && isolation.summary.all_clean,
    outcomes_complete: outcomesComplete,
    missing,
    failed,
    isolation: {
      all_clean: isolation.summary.all_clean,
      not_isolated_series: notIsolated.length,
      not_isolated_tests: isolation.tests.filter((t) => t.verdict !== "clean")
        .length,
    },
    inventory: {
      stages: PROGRAMME_STAGES,
      engines: ENGINES,
      cases: REQUIRED_CASES,
      cold_runs: {
        workloads: [...COLD_RUN_WORKLOADS, "W2"],
        each: REQUIRED_COLD_RUNS,
      },
      negative_controls: controls,
      also: [
        "W2's live application in every engine",
        "the device page's results in every engine, validated with the W2 hashes",
        "P-1S for dist and dist-fixture",
        "both budget checks",
        "every measurement series and collected test isolated (clean)",
      ],
    },
    note: "a partial hand-over is valid only as a partial one: its validator exits 1 (2 with --allow-partial) and no desktop conclusion is drawn from anything missing",
  };
}

function assembleHandoff(bundleRecord) {
  const stages = stageRecords();
  const now = candidate(root);
  const mismatched = Object.entries(stages)
    .filter(
      ([stage, r]) =>
        stage !== "handoff" &&
        r.candidate?.source_fingerprint !== now.source_fingerprint,
    )
    .map(([stage]) => stage);
  if (mismatched.length > 0) {
    console.error(
      `refused: the stages ${mismatched.join(", ")} ran on a different source fingerprint than ${now.source_fingerprint}; a source edit after a measurement invalidates it (use a fresh directory)`,
    );
    return 1;
  }
  const debugging = Object.entries(stages)
    .filter(([, r]) => r.debugging_samples)
    .map(([stage]) => stage);
  if (debugging.length > 0) {
    console.error(
      `refused: the stages ${debugging.join(", ")} were shortened DEBUGGING runs (ATLAS_PROFILE_SAMPLES or --samples); they are never evidence`,
    );
    return 1;
  }
  const handoff = join(out, "handoff");
  mkdirSync(handoff, { recursive: true });
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
  // The W2 captures (the integration stage writes them under w2/): copied with their hashes, so the handoff carries the real bytes.
  const w2Dir = join(out, "w2");
  const w2Files = existsSync(w2Dir)
    ? readdirSync(w2Dir).filter((f) => /^W2-captured\..+\.json$/.test(f))
    : [];
  const w2Hashes = {};
  for (const file of w2Files) {
    copyFileSync(join(w2Dir, file), join(fixtures, file));
    w2Hashes[file] = sha256(readFileSync(join(fixtures, file)));
  }
  writeFileSync(
    join(fixtures, "W2-hashes.json"),
    `${JSON.stringify(w2Hashes, null, 2)}\n`,
  );

  // Desktop results of the device page, validated by the same tool (and the same W2 hashes) a device operator uses.
  const validated = {};
  const devicePageDir = join(out, "device-page");
  if (existsSync(devicePageDir))
    for (const file of readdirSync(devicePageDir)) {
      const v = sh(process.execPath, [
        join(root, "scripts/validate-profile-handoff.mjs"),
        join(devicePageDir, file),
        "--w2-hashes",
        join(fixtures, "W2-hashes.json"),
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
  const w2Memory = readDir(w2Dir, "P-W2.");

  // H8: the smallest valid response the client could not process on any desktop engine of this run: every cold run (P-11, P-W2), W2's
  // LIVE application by the production engine, and the device page's own runs.
  const failures = [];
  const negativeAdmitted = [];
  for (const m of [...memory, ...w2Memory])
    for (const row of m.rows ?? [])
      for (const run of row.runs ?? []) {
        if (row.expected === "admitted" && run.outcome !== "admitted")
          failures.push({
            engine: m.engine,
            workload: row.workload,
            path: "cold run",
            outcome: run.outcome,
          });
        if (row.expected === "refused" && run.outcome === "admitted")
          negativeAdmitted.push({ engine: m.engine, workload: row.workload });
      }
  for (const m of w2Memory)
    if (m.live && m.live.outcome !== "admitted")
      failures.push({
        engine: m.engine,
        workload: "W2",
        path: "live application by the production engine",
        outcome: m.live.outcome ?? "not recorded",
      });
  const devicePage = Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      readJson(join(devicePageDir, `results.${engine}.json`)),
    ]),
  );
  for (const [engine, results] of Object.entries(devicePage))
    for (const run of results?.runs ?? []) {
      if (run.expected === "admitted" && run.outcome !== "admitted")
        failures.push({
          engine,
          workload: run.workload,
          path: "device page (in-page transport)",
          outcome: run.outcome,
        });
      if (run.expected === "refused" && run.outcome === "admitted")
        negativeAdmitted.push({ engine, workload: run.workload });
    }

  // Isolation (review R1): every series judged over its collection window by the load samples of its stage.
  const collectionLog = readJsonl(join(out, COLLECTION_LOG));
  const isolationDir = join(out, "isolation");
  const samples = existsSync(isolationDir)
    ? readdirSync(isolationDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => readSamples(join(isolationDir, f)))
    : [];
  const isolation = annotate({
    rows: [
      ...measurements.map((r) => ({ ...r, file: "measurements.jsonl" })),
      ...values.map((r) => ({ ...r, file: "values.jsonl" })),
    ],
    tests: collectionLog,
    samples,
  });
  const isolationOf = (prefix) => {
    const series = isolation.series.filter((r) => r.name.startsWith(prefix));
    const counts = Object.fromEntries(
      ["clean", "idle_foreign", "contaminated", "unknown"].map((v) => [
        v,
        series.filter((r) => r.verdict === v).length,
      ]),
    );
    return {
      series: series.length,
      ...counts,
      isolated: series.length > 0 && counts.clean === series.length,
    };
  };

  // Completeness (review R2): the finite inventory a desktop conclusion needs, from what this directory actually holds.
  const desktopProgramme = completeness({
    stages,
    collectionLog,
    memory,
    w2Memory,
    validated,
    shellPresent: {
      dist: existsSync(join(out, "shell", "dist.json")),
      "dist-fixture": existsSync(join(out, "shell", "dist-fixture.json")),
    },
    bundleRecord,
    negativeAdmitted,
    isolation,
  });
  const outcomesComplete = desktopProgramme.outcomes_complete;
  // true: a valid workload failed; false: none failed in a COMPLETE programme; null: undetermined (the evidence is incomplete).
  const desktopFailure =
    failures.length > 0 ? true : outcomesComplete ? false : null;

  const w2 = values.filter((v) => v.name === "P-W2 capture");
  const w2Bound = values.filter((v) => v.name === "P-W2 observed bound");
  const w2Limits = values.filter((v) => v.name === "W2-limits");
  const backendSeen = values.filter((v) => v.name === "backend");
  const integrationSummary = readJson(
    join(out, "integration-run", "summary.json"),
  );
  const pq = values.filter((v) => v.name === "P-Q footprints");
  const pq2 = values.filter((v) => v.name === "P-Q2 quota reserve inputs");
  const shellDir = join(out, "shell");
  const shell = {
    dist: readJson(join(shellDir, "dist.json")),
    "dist-fixture": readJson(join(shellDir, "dist-fixture.json")),
  };
  const programme = contentionProgramme();
  const configValues = constants();
  const pinned = JSON.parse(
    readFileSync(join(root, "contract-pin.json"), "utf8"),
  );
  const named = (prefix) =>
    measurements
      .filter((m) => m.name.startsWith(prefix))
      .map((m) => m.name)
      .filter((n, i, a) => a.indexOf(n) === i);
  const measuredIn = (prefix) => {
    const rows = measurements.filter((m) => m.name.startsWith(prefix));
    return rows.length === 0
      ? "not_run"
      : allEngines(rows)
        ? "measured"
        : "partial";
  };
  const w2Status =
    w2.length === 0
      ? "not_run"
      : w2.every((v) => v.status === "measured") && allEngines(w2)
        ? "measured"
        : "partial";
  const desktopD = {};
  for (const engine of ENGINES) {
    const ok = measurements
      .filter(
        (m) =>
          m.engine === engine &&
          /^P-2 dense-(\d+)/.test(m.name) &&
          m.name.endsWith("commit_ms"),
      )
      .map((m) => Number(/^P-2 dense-(\d+)/.exec(m.name)[1]));
    desktopD[engine] = ok.length ? Math.max(...ok) : null;
  }
  const w1Admitted = Object.fromEntries(
    memory.map((m) => [
      m.engine,
      (m.rows ?? [])
        .filter((r) => r.workload === "W1")
        .flatMap((r) => r.runs.map((run) => run.outcome)),
    ]),
  );
  const w2Admitted = Object.fromEntries(
    w2Memory.map((m) => [
      m.engine,
      (m.rows ?? []).flatMap((r) => r.runs.map((run) => run.outcome)),
    ]),
  );

  // ---- the consumer map: every BE-B1 item (1 to 7) and BE-Q23 row (M0 to M9), with what this record answers ------------------------------
  // Provenance is complete only when every stage recorded its candidate and the backend the integration stage ran was recorded.
  const provenanceStatus =
    integrationSummary?.backend && backendSeen.length > 0 && outcomesComplete
      ? "measured"
      : "partial";
  const desktop = "desktop-playwright";
  const entry = (status, answeredBy, reason, owner, extra = {}) => ({
    status,
    answered_by: answeredBy,
    reason,
    owner,
    environment: extra.environment ?? desktop,
    claims_device_class: extra.claims_device_class ?? false,
    ...extra,
  });
  const devicesOwner =
    "Kieran names the roster (OD-1 escalation); WEB-09c's device package is run on it; WEB-09d owns supported-device acceptance";
  const consumerMap = {
    "BE-B1:1 provenance": entry(
      provenanceStatus,
      ["H0", "candidate", "backend"],
      "atlas-web commit, tree and source fingerprint, the API-types pin, the backend tag, binary hash and the api_version the server reported, date, operator, raw traces retained",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-B1:2 real devices, named": entry(
      "escalated",
      ["H1"],
      "no device was profiled: OD-1 (10 October 2026) escalated the roster; this record is one desktop machine",
      devicesOwner,
      { claims_device_class: false },
    ),
    "BE-B1:3 workloads with bytes, nodes and changes": entry(
      w2Status === "measured" ? "partial" : "partial",
      ["H3", "P-2", "P-11", "P-W2"],
      "W1, W3 to W7 generated and hashed; W2 captured from the real /sync" +
        (w2Status === "measured" ? "" : " (NOT complete: see P-W2)") +
        "; delta pages at limit 50 and mixed ordinary/dense delta pages (3(d)) are not generated; the Q9 co-resident shapes (3(g)) only as P-5 and P-Q",
      "WEB-09c (desktop); the roster for device rows",
    ),
    "BE-B1:4 multi-tab on every class": entry(
      "partial",
      ["H5", "P-6", "P-7", "P-8", "P-9", "P-13"],
      "desktop two- and three-page cases with a FIXTURE leader and synthetic delays only; takeover mid-snapshot is WEB-09b's, a real freeze WEB-08c's, the installed app plus a tab and every mobile class need the roster",
      "WEB-09b (production leader), WEB-08c (real freeze), the roster",
    ),
    "BE-B1:5 metrics per run": entry(
      "partial",
      ["H2", "P-11", "P-W2", "P-Q"],
      "desktop: Chromium heap (CDP), the engine process tree's RSS (all three engines; BROWSER-PROCESS RSS, not device memory and not server RSS), scan and commit times, outcomes, at least five cold runs; IndexedDB bytes only as Chromium's exact figure and the obfuscated estimate elsewhere; the device tools (dumpsys, Instruments, about:memory) need the roster",
      devicesOwner,
    ),
    "BE-B1:6 derived values": entry(
      "partial",
      ["H9", "C1", "C3", "C5"],
      "desktop D(engine), W1/W2 admission at limit 1 on desktop, the limit in use per phase (source), per-request overhead (P-4), the validator's use of maxItems (source); needs_finer_pagination is UNDETERMINED for supported devices",
      devicesOwner,
    ),
    "BE-B1:7 format": entry(
      "partial",
      ["results.json", "report.md", "SHA256SUMS"],
      "machine-readable results, a short report and checksums exist; the statement that every figure is measured on real hardware CANNOT be made (desktop only)",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M0 provenance": entry(
      provenanceStatus,
      ["H0", "candidate", "backend"],
      "as BE-B1:1",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M1 roster": entry(
      "escalated",
      ["H1"],
      "OD-1: no device, installed app or browser without a device-memory signal was profiled",
      devicesOwner,
    ),
    "BE-Q23:M2 method": entry(
      "partial",
      ["H2"],
      "the desktop method is stated (heap in Chromium only, process-tree RSS, GC before baseline and after, five cold runs, outcome per run); the per-platform device tools are part of the device package, not run",
      devicesOwner,
    ),
    "BE-Q23:M3 fixtures": entry(
      w2Status === "measured" ? "measured" : "partial",
      ["H3", "fixtures/hashes.json", "fixtures/W2-hashes.json"],
      w2Status === "measured"
        ? "generator source and SHA-256 of W1, W3 to W7; the W2 bytes captured from the real /sync in every engine, hashed"
        : "generator source and SHA-256 of W1, W3 to W7; W2 not captured in every engine (see P-W2)",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M4 granularity sweep": entry(
      "partial",
      ["P-2", "P-11 (W5 in the device page)", "P-W2"],
      "desktop engines: the graded dense ladder 100/200/400/800 and the batches-per-page ladder (W5 1..80); no finer parameter exists (BE-Q23 unshipped), so only the limit axis; no device class",
      devicesOwner,
    ),
    "BE-Q23:M5 multi-tab scenarios": entry(
      "partial",
      ["H5", "P-6 to P-9", "P-13"],
      "as BE-B1:4",
      "WEB-09b, WEB-08c, the roster",
    ),
    "BE-Q23:M6 bounded processing as built": entry(
      "measured",
      ["H6"],
      "a byte scan with no object graph, one element decoded at a time inside the commit, chunked writes; results only WITHOUT a finer-delivery parameter (none exists)",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M7 cost of finer requests": entry(
      measuredIn("P-4") === "measured" ? "partial" : "not_run",
      ["P-4", "P-10", "P-3", "P-9"],
      "desktop per-request overhead (pre-issue, lease and lock, request, record) on loopback and behind a 250 ms proxy delay; a 10,000-resource snapshot is WEB-09b's and was not run",
      "WEB-09b (snapshot), the roster (device CPU)",
    ),
    "BE-Q23:M8 smallest unprocessable response": entry(
      "partial",
      ["H8"],
      desktopFailure === null
        ? "desktop: UNDETERMINED, the desktop programme is incomplete (see desktop_programme); the answer for supported devices needs the roster"
        : desktopFailure
          ? "desktop: valid workloads failed (see H8.desktop_answer); the answer for supported devices needs the roster"
          : "desktop: no valid workload failed on any desktop engine of this complete programme; the answer for supported devices needs the roster",
      devicesOwner,
    ),
    "BE-Q23:M9 derived values": entry(
      "partial",
      ["H9"],
      "desktop D(engine) and W1/W2 admission at limit 1; the limit in use per phase; needs_finer_pagination undetermined for supported devices; validator and maxItems answered from source",
      devicesOwner,
    ),
  };

  const results = {
    schema: 2,
    title: `${EVIDENCE_KEY} — WEB-09c measurement hand-over`,
    evidence_key: EVIDENCE_KEY,
    owner: EVIDENCE_OWNER,
    first_paragraph:
      "This record was taken on one macOS developer machine with Playwright's desktop engines. It does not meet the roster in H1 (BE-B1 item 2, BE-Q23 M1): no real device, floor device, installed app or browser without a device-memory signal was profiled, because the operator escalated the roster (OD-1, 10 October 2026). Every desktop figure is labelled as such and none stands for a device class. The BE-B1/BE-Q23 measurement gate remains held until the roster runs.",
    candidate: {
      at_handoff: now,
      stages: Object.fromEntries(
        Object.entries(stages).map(([stage, r]) => [
          stage,
          {
            source_fingerprint: r.candidate?.source_fingerprint,
            commit: r.candidate?.commit,
            status_porcelain: r.candidate?.status_porcelain,
            started_at: r.started_at,
            finished_at: r.finished_at ?? null,
            exit_status: r.exit_status ?? null,
            load_at_start: r.load_at_start,
            load_at_end: r.load_at_end ?? null,
          },
        ]),
      ),
    },
    backend: {
      pin: pinned,
      integration_runner: integrationSummary?.backend ?? null,
      reported_by_server: backendSeen.map(({ engine, health, revision }) => ({
        engine,
        health,
        revision,
      })),
    },
    machine: machineRecord,
    H0: {
      status: "measured",
      provenance: machineRecord.atlas_web,
      candidate_fingerprint: now.source_fingerprint,
      node: machineRecord.node,
      playwright: machineRecord.playwright,
      backend: `released ${pinned.backend_tag} (${pinned.backend_commit}), integration measurements only`,
      api_pin: "contract-pin.json",
      date: machineRecord.recorded_at,
      operator: "the Running-phase agent; no person has reviewed this record",
    },
    H1: {
      status: "escalated",
      reason:
        "OD-1 (10 October 2026): desktop now, roster escalated. The roster (real devices, installed apps, the lowest-memory supported device per family, a mid-range mobile, browsers without deviceMemory) must be named by Kieran or product",
      roster: [
        {
          device: "developer machine",
          os: machineRecord.os,
          cpu: machineRecord.cpu,
          cores: machineRecord.cores,
          memory_gib: machineRecord.memory_gib,
          engines: machineRecord.engines,
          // What each desktop engine reported as navigator.deviceMemory on THIS machine. A null here is that engine's desktop behaviour,
          // not evidence from a supported device without the signal: no such device was profiled (H1 escalated).
          device_memory_signal_by_engine: Object.fromEntries(
            ENGINES.map((engine) => [
              engine,
              devicePage[engine]?.machine?.device_memory_gib ?? null,
            ]),
          ),
          installed_app: false,
        },
      ],
    },
    H2: {
      status: "partial",
      method:
        "peak and retained JS heap (Chromium only, CDP) and the engine process tree's RSS (ps, all three engines; BROWSER-PROCESS RSS: not device memory, not server RSS) across receive, scan, validate, stage and commit; five cold runs (a new browser context each); idle baseline recorded before the run; outcome per run; the modelled figure is WEB-03's (A:3483-3497) beside each measured one, labelled modelled",
      modelled: {
        "W1 at limit 1":
          "150.75 MiB (WEB-03's combined check, 120.6 % of its R, rejected by that model; this client does not apply that check, it bounds processing instead)",
      },
      memory_files: [
        ...memory.map((m) => `memory/P-11.${m.engine}.json`),
        ...w2Memory.map((m) => `w2/P-W2.${m.engine}.json`),
      ],
    },
    H3: {
      status: w2Status === "measured" ? "measured" : "partial",
      fixtures: hashes.workloads,
      w2_captured: w2,
      w2_capture_hashes: w2Hashes,
      w2_observed_bound: w2Bound,
      w2_limits_probe: w2Limits,
      in_backend_terms: W_IN_BE,
      note: "W1 reproduces the design's 455,214 nodes and 5.83 MiB (tests/profiling/workloads.test.ts); W2 is the server-maximal dense batch the released backend produced through put_field (checklist values) and a grant, captured from the real /sync",
    },
    H4: {
      status: "partial",
      reason:
        "desktop engines only: the page-size ladder (100/200/400/800 changes, ordinary and dense) is P-2; the batch ladder 1 to 80 is W5 in the device page",
      measurement_names: named("P-2"),
    },
    H5: {
      status: "partial",
      measured:
        "two and three pages of one context with a FIXTURE leader syncing back to back while another page makes ordinary requests, exposures and closing writes (P-6 to P-9), and a healthy follower reading on hints (P-13), desktop, synthetic delays; the outbox drain with a second tab (E-O4, functional)",
      reason:
        "a second tab taking over mid-snapshot (WEB-09b), a REAL freeze or back/forward cache (WEB-08c), an installed app plus a tab and every mobile class need the production leader and real devices",
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
      desktop_valid_workload_failure: desktopFailure,
      derived_from: outcomesComplete
        ? "a complete desktop programme (desktop_programme.outcomes_complete)"
        : "an INCOMPLETE desktop programme: only failures it holds are facts; their absence is not",
      desktop_answer:
        desktopFailure === null
          ? "UNDETERMINED: the desktop programme is incomplete (see desktop_programme.missing and desktop_programme.failed), so the absence of a failure in it is not evidence that none would occur"
          : desktopFailure
            ? { failures }
            : "no valid workload (W1, W3, W4, W6 in five cold runs; W2 live and in five cold runs; the device page's runs) was refused or failed on any desktop engine of this complete programme",
      negative_controls_admitted: negativeAdmitted,
      reason: "the roster's answer is needed for any supported mobile device",
    },
    H9: {
      status: "partial",
      limit_in_use: {
        delta: `${configValues?.config?.initialLimitUnconstrained ?? "?"} at the unconstrained initial rung, ${configValues?.config?.initialLimitOther ?? "?"} for every other class; step-down only (step-up ${configValues?.config?.stepUpAfterSuccesses === null ? "disabled" : "enabled"}); never above syncLimitMax ${configValues?.config?.syncLimitMax ?? "?"}`,
        snapshot:
          "not sent by this client: the first snapshot is WEB-09b's (production starts no engine yet)",
        source: "src/data/model/config.ts (constants.md)",
      },
      client_validator_consumes_SyncPage_batches_maxItems: false,
      reason_validator:
        "decision D-10: the scanner enforces its own bounds (80 batches, 800 changes per batch) and does not rely on the contract's batches.maxItems; no file under src/ reads `maxItems` (only the comment of syncLimitMax names it)",
      desktop_D_largest_dense_changes_committed: desktopD,
      desktop_D_basis: outcomesComplete
        ? "the largest dense P-2 page committed in each engine of a complete programme"
        : "the largest dense P-2 page in the rows present; the programme is INCOMPLETE, so a larger page may simply not have run",
      w1_outcomes_at_limit_1: w1Admitted,
      w2_outcomes_at_limit_1: w2Admitted,
      w2_live_outcome: Object.fromEntries(
        w2Memory.map((m) => [m.engine, m.live?.outcome ?? null]),
      ),
      // false only from a complete programme with no failure; true when a valid workload failed; null when undetermined.
      desktop_needs_finer_pagination:
        desktopFailure === null ? null : desktopFailure,
      needs_finer_pagination: `undetermined for supported devices; desktop: ${
        desktopFailure === null
          ? "UNDETERMINED, the desktop programme is incomplete (see desktop_programme)"
          : desktopFailure
            ? "a valid workload failed on a desktop engine (see H8)"
            : "no valid workload failed on a desktop engine of this complete programme, so the desktop engines do not need it"
      }`,
    },
    programme: {
      "P-1": bundleRecord ?? {
        status: "not_run",
        reason: "the bundle stage did not run in this record",
      },
      "P-1S": {
        status:
          shell.dist && shell["dist-fixture"]
            ? "measured"
            : shell.dist || shell["dist-fixture"]
              ? "partial"
              : "not_run",
        label:
          "Chromium only, CDP network and CPU throttling: EMULATED throttling, not a device; reported, not judged",
        results: shell,
      },
      "P-2": { status: measuredIn("P-2"), names: named("P-2") },
      "P-3": {
        status: measuredIn("P-3"),
        caveat:
          "ephemeral Playwright profile; the hint is passed through Dexie's `chromeTransactionDurability` option; whether Firefox and WebKit act on it was not determined",
      },
      "P-4": {
        status: measuredIn("P-4"),
        layer: "integration, released backend on loopback",
      },
      "P-5": {
        status: measuredIn("P-5") === "measured" ? "partial" : "not_run",
        measured: "maxInFlight 1, 200 drafts, 20 runs",
        not_run:
          "maxInFlight 2 and 3 (D-18 fixes 1), and the outbox drain's own effect on a second page's waits (the sync leader's effect is P-7 and P-9)",
      },
      ...programme,
      "P-10": {
        status: measuredIn("P-10"),
        conclusion:
          "the stamped request time-out (30 s) against the measured durations; see the rows named P-10",
      },
      "P-11": {
        status: memory.length === 0 ? "not_run" : "partial",
        note: "desktop engines through the real wrapper and through the device page; real devices not run",
      },
      "P-W2": {
        status: w2Status,
        layer:
          "the released backend (put_field with checklist values and a grant, then the real /sync) on a desktop engine; the captured bytes then processed through the production path in five cold runs per engine",
        captures: w2,
        processing_files: w2Memory.map((m) => `w2/P-W2.${m.engine}.json`),
      },
      "P-12": { status: "provisional", file: "handoff/constants.md" },
      "P-Q": {
        status:
          pq.length === 0 ? "not_run" : allEngines(pq) ? "measured" : "partial",
        note: "footprints measured; Firefox and Safari report an obfuscated estimate",
      },
      "P-Q2": {
        status:
          pq2.length === 0
            ? "not_run"
            : allEngines(pq2)
              ? "measured"
              : "partial",
        note: "the atlas-auth burst, each engine's estimate step and the ledger overhead; the reserve itself (8 MiB) is NOT changed: a desktop figure cannot set a device constant",
        by_engine: Object.fromEntries(pq2.map((v) => [v.engine, v])),
      },
    },
    consumer_map: consumerMap,
    desktop_programme: desktopProgramme,
    isolation: {
      ...isolation,
      by_item: Object.fromEntries(
        [
          "P-2",
          "P-3",
          "P-4",
          "P-5",
          "P-6",
          "P-7",
          "P-8",
          "P-9",
          "P-10",
          "P-11",
          "P-13",
          "P-Q",
          "P-W2",
          "W2-limits",
        ].map((p) => [p, isolationOf(p)]),
      ),
      applicability:
        "a timing, rate, memory or footprint figure is applicable as an isolated desktop measurement only when its series is `clean`; any other verdict qualifies it (it was, or may have been, taken beside other heavy work). Shapes, byte counts, hashes and admission outcomes do not depend on isolation",
    },
    escalations: [
      {
        id: "OD-1",
        decided: "Desktop now; escalate roster (Kieran, 10 October 2026)",
        needed: [
          "the named floor device for each family (model, RAM, OS)",
          "the mid-range mobile",
          "who runs the protocol and where",
          "the HTTPS hosting choice (a local CA the device trusts, or Android `adb reverse`; an external tunnel is the operator's call)",
        ],
        until_then:
          "BE-B1 item 2 and BE-Q23 M1 are escalated; needs_finer_pagination is undetermined for supported devices; BE-B1/BE-Q23 remain blocked",
      },
    ],
    retake_on_composed_client: [
      "P-6 to P-9 and P-13 (the FIXTURE leader becomes WEB-09b's production leader)",
      "P-4 (per-request lease cost with production leadership)",
      "multi-tab H5 (takeover mid-snapshot; installed app plus a tab)",
    ],
    device_page_validation: validated,
    measurement_rows: measurements.length,
  };
  writeFileSync(
    join(handoff, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  const verdictOf = new Map(
    isolation.series
      .filter((r) => r.file === "measurements.jsonl")
      .map((r, i) => [i, r.verdict]),
  );
  const table = measurements
    .map(
      (m, i) =>
        `| ${m.name} | ${m.engine} | ${m.n} | ${m.p50} | ${m.p95} | ${m.max} | ${verdictOf.get(i)} |`,
    )
    .join("\n");
  const statusLine = desktopProgramme.complete
    ? "**Desktop programme: COMPLETE and ISOLATED.** Every required stage, case, engine, workload and outcome is present and every series was taken with no other heavy work on the controller. Device evidence is still escalated (H1)."
    : `**Desktop programme: ${desktopProgramme.outcomes_complete ? "outcomes complete, NOT ISOLATED" : "INCOMPLETE"}.** This is a partial hand-over: ${desktopProgramme.missing.length} item(s) missing, ${desktopProgramme.failed.length} failed, ${isolation.summary.series - isolation.summary.clean} of ${isolation.summary.series} series not isolated. No desktop conclusion is drawn from what is absent.`;
  const completenessSection = [
    `* Desktop programme complete: **${desktopProgramme.complete}** (outcomes complete: ${desktopProgramme.outcomes_complete}; every series isolated: ${isolation.summary.all_clean}).`,
    `* Missing: ${desktopProgramme.missing.length ? desktopProgramme.missing.join("; ") : "none"}.`,
    `* Failed: ${desktopProgramme.failed.length ? desktopProgramme.failed.join("; ") : "none"}.`,
    `* Isolation of ${isolation.summary.series} series: ${isolation.summary.clean} clean, ${isolation.summary.idle_foreign} idle_foreign, ${isolation.summary.contaminated} contaminated, ${isolation.summary.unknown} unknown (${isolation.load_samples} load samples every ${isolation.sampling_interval_ms / 1000} s). Method: ${isolation.method}.`,
    `* H8 (a valid workload failed on a desktop engine): ${desktopFailure === null ? "undetermined" : desktopFailure}. H9 desktop needs finer pagination: ${desktopFailure === null ? "undetermined" : desktopFailure}.`,
  ].join("\n");
  writeFileSync(
    join(handoff, "report.md"),
    `# ${results.title}

${results.first_paragraph}

Every figure below is \`measured\` (taken by this programme in the stated environment), \`partial\`, \`not_run\` or \`escalated\` (with the reason), or \`modelled\` (WEB-03's arithmetic). Nothing here is a pass mark. Playwright contexts are ephemeral profiles: \`durability: "strict"\` is not measured against a real on-disk profile. Browser-process RSS is not device memory and not server RSS. Server RSS, Node-only runs, emulated devices, single-tab results presented as multi-tab, and \`limit\`-only step-down presented as proof that finer delivery is unnecessary are **not** claimed.

${statusLine}

Candidate: commit ${now.commit}, tree ${now.tree}, source fingerprint ${now.source_fingerprint}. Backend: ${pinned.backend_tag} (${pinned.backend_commit}); release archive SHA-256 (as the integration runner verified it) ${integrationSummary?.backend?.sha256 ?? "not recorded (integration stage not run)"}.

Machine: ${machineRecord.os}, ${machineRecord.cpu}, ${machineRecord.cores} cores, ${machineRecord.memory_gib} GiB, Node ${machineRecord.node}, ${machineRecord.playwright}; engines ${JSON.stringify(machineRecord.engines)}.

## Completeness and isolation (read before any figure)

${completenessSection}

## What the backend authors can use (consumer map)

| Item | Status | Answered by | Reason | Owner |
| --- | --- | --- | --- | --- |
${Object.entries(consumerMap)
  .map(
    ([k, v]) =>
      `| ${k} | ${v.status} | ${v.answered_by.join(", ")} | ${v.reason} | ${v.owner} |`,
  )
  .join("\n")}

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

Isolation is each series' verdict over its collection window (see above): only \`clean\` figures are isolated desktop measurements.

| Measurement | Engine | n | p50 | p95 | max | Isolation |
| --- | --- | --- | --- | --- | --- | --- |
${table}

Raw samples are in \`../raw/\`, per-run memory in \`../memory/\` and \`../w2/\`, the device page's own results in \`../device-page/\`, the contention files in \`../contention/\`, the throttled shell boot in \`../shell/\`, the stage records in \`../stages/\`, and the recorded fixture hashes in \`fixtures/hashes.json\` and \`fixtures/W2-hashes.json\`.
`,
  );

  // SHA256SUMS over every file of the handoff
  const lines = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name !== "SHA256SUMS")
        lines.push(`${sha256(readFileSync(p))}  ${relative(handoff, p)}`);
    }
  };
  walk(handoff);
  writeFileSync(join(handoff, "SHA256SUMS"), `${lines.sort().join("\n")}\n`);
  return 0;
}

// ---- the stages, in order, each recorded with its candidate and load ---------------------------------------------------------------------
let status = 0;
const run = async (stage, action) => {
  if (!only.includes(stage) || status !== 0) return;
  recordStage(out, stage, { root, machine: machineRecord });
  // The load beside every measuring stage, sampled from before its first test to after its last (the handoff measures nothing).
  const sampler =
    stage === "handoff" ? null : await startLoadSampler(out, stage);
  try {
    status = (await action()) ?? 1;
  } finally {
    await sampler?.stop();
  }
  finishStage(out, stage, status);
};
await run("bundle", bundle);
await run("fixture", fixture);
await run("shell", shellStage);
// The contention driver records (and refuses) its own stage, and samples its own load.
if (only.includes("contention") && status === 0) status = contention();
await run("integration", integration);
await run("device", device);
await run("handoff", () =>
  assembleHandoff(readJson(join(out, "bundle-delta.json"))),
);
log(`written to ${out} (exit ${status})`);
process.exit(status);

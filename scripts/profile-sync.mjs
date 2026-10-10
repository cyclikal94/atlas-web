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
  cpSync,
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
  CELL_STATUSES as CELL_STATUSES_FOR_REPORT,
  CONTRACT_VERSION,
  resolveEvidence,
} from "./lib/profile-contract.mjs";
import {
  CLAIM_FILE,
  COLLECTION_LOG,
  candidate,
  claimDirectory,
  claimHolder,
  ENGINES,
  EVIDENCE_KEY,
  EVIDENCE_OWNER,
  evidenceArg,
  recordedStages,
  refuseRecorded,
  runStage,
  STAGES,
} from "./lib/profile-evidence.mjs";
import {
  annotate,
  METHOD as ISOLATION_METHOD,
  readSamples,
  SAMPLE_INTERVAL_MS,
  startLoadSampler,
} from "./lib/profile-isolation.mjs";

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
// The contention stage is recorded (and refused) by its own driver. A recorded stage is refused before anything is written, and again
// once this invocation holds the directory (two invocations that both passed the first check cannot both pass the second).
refuseRecorded(out, only);
const log = (message) => console.log(`[profile:sync] ${message}`);
if (claimHolder(out)) {
  console.error(
    `refused: ${out} is held by another invocation, or by one that was interrupted (${CLAIM_FILE}: ${JSON.stringify(claimHolder(out))}); use a fresh evidence directory. Nothing was changed or deleted.`,
  );
  process.exit(2);
}
if (flag("--preflight")) {
  log(
    `preflight: would run ${only.join(", ")} into ${out}; nothing was written`,
  );
  process.exit(0);
}
const claim = claimDirectory(out, { stages: only });
if (recordedStages(out, only).length > 0) {
  claim.withdraw();
  refuseRecorded(out, only);
}

const sh = (command, commandArgs, env = {}) =>
  spawnSync(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const childEnv = {
  ATLAS_PROFILE: "1",
  ATLAS_PROFILE_OUT: out,
  ATLAS_PROFILE_INVOCATION: claim.invocation,
};
/** The environment of a stage's child: its rows carry the stage and this invocation. */
const stageEnv = (stage) => ({ ...childEnv, ATLAS_PROFILE_STAGE: stage });
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
    // check-budgets.mjs writes this run's profile straight into the evidence directory (`--out`, created exclusively): no shared
    // fixed path, so nothing can replace it between the check and the record (design assessment DA-2).
    const target = join(out, "bundle", `bundle-profile-${build}.json`);
    const checked = sh(process.execPath, [
      join(root, "scripts/check-budgets.mjs"),
      build,
      "--out",
      target,
    ]);
    writeFileSync(
      join(out, "bundle", `check-budgets-${build}.log`),
      `${checked.stdout}${checked.stderr}`,
    );
    if (!existsSync(target)) {
      console.error(`check-budgets wrote no profile for ${build}`);
      status = 1;
      continue;
    }
    budgets[build] = {
      exit: checked.status,
      build,
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
          ...stageEnv("fixture"),
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
          ...stageEnv("device"),
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
  // Every cold run records its own window (from before its context opens to after its figures are read), inside this stage's sampler,
  // and the file carries the stage and this invocation: the shell is judged for isolation like every other figure (review R1).
  const shell = (url, build) =>
    spawnSync(
      process.execPath,
      [
        join(root, "scripts/profile-shell.mjs"),
        "--url",
        url,
        "--build",
        build,
        "--out",
        join(dir, `${build}.json`),
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, ...stageEnv("shell") },
      },
    ).status ?? 1;
  let status = await withFixtureServer(async (url) => {
    log(`P-1S dist-fixture (the signed-in shell) at ${url}`);
    return shell(`${url}/today?pending=2`, "dist-fixture");
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
    status = shell(`${url}/`, "dist");
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
      env: { ...process.env, ...stageEnv("integration") },
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
    // The nested driver runs under this invocation's claim; it records and seals its own stage.
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ATLAS_PROFILE_CLAIM: claim.invocation },
    },
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
// A malformed file is skipped here (the report's lists); the evidence resolution names it as invalid.
const readDir = (dir, prefix) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .flatMap((f) => {
          try {
            return [JSON.parse(readFileSync(join(dir, f), "utf8"))];
          } catch {
            return [];
          }
        })
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

/** The evidence the hand-over carries (`handoff/evidence/`): every file of the directory but the hand-over itself and the live claim. */
function copyEvidence(handoff) {
  const target = join(handoff, "evidence");
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(out))
    if (name !== "handoff" && name !== CLAIM_FILE)
      cpSync(join(out, name), join(target, name), { recursive: true });
  return target;
}

/** One line per status of a resolution: what a reader must see before any figure. */
const listOf = (resolution, status) =>
  resolution.cells
    .filter((c) => c.status === status)
    .map((c) => ({ id: c.id, reasons: c.reasons }));

function assembleHandoff() {
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

  // The evidence, carried and resolved (review R2; design assessment C/D): every status and conclusion below comes from the contract's
  // resolution of the copy the hand-over carries, which the validator resolves again. Nothing is taken from a stage's exit or a test title.
  const evidenceDir = copyEvidence(handoff);
  const resolution = resolveEvidence(evidenceDir);
  writeFileSync(
    join(handoff, "resolution.json"),
    `${JSON.stringify(resolution, null, 2)}\n`,
  );
  const { derived } = resolution;
  const item = (name) =>
    resolution.items[name] ?? { status: "not_run", cells: 0, satisfied: 0 };
  const statusOf = (name) => item(name).status;
  const failure = derived.desktop_valid_workload_failure;
  const bundleRecord = readJson(join(out, "bundle-delta.json"));
  const memoryDir = join(out, "memory");
  const memory = existsSync(memoryDir)
    ? readdirSync(memoryDir).flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(memoryDir, f), "utf8"))];
        } catch {
          return [];
        }
      })
    : [];
  const w2Memory = readDir(w2Dir, "P-W2.");

  // Isolation, per cell (review R1): every timing, rate, memory and footprint cell judged over its own window by its own stage's samples.
  const judgedCells = resolution.cells.filter((c) => c.isolation);
  const verdicts = Object.fromEntries(
    ["clean", "idle_foreign", "contaminated", "unknown"].map((v) => [
      v,
      judgedCells.filter((c) => c.isolation.verdict === v).length,
    ]),
  );
  const isolationSummary = {
    judged_cells: judgedCells.length,
    ...verdicts,
    all_clean: judgedCells.length > 0 && verdicts.clean === judgedCells.length,
  };
  // The tests themselves, for the reader (informational: completeness is judged per cell above).
  const collectionLog = readJsonl(join(out, COLLECTION_LOG));
  const testsByStage = {};
  for (const t of collectionLog) {
    const stage = t.stage ?? "unknown";
    testsByStage[stage] = [...(testsByStage[stage] ?? []), t];
  }
  const tests = Object.entries(testsByStage).flatMap(([stage, list]) => {
    const file = join(out, "isolation", `${stage}.jsonl`);
    let samples = [];
    try {
      samples = existsSync(file) ? readSamples(file) : [];
    } catch {
      samples = [];
    }
    return annotate({ rows: [], tests: list, samples }).tests;
  });

  const w2 = values.filter((v) => v.name === "P-W2 capture");
  const w2Bound = values.filter((v) => v.name === "P-W2 observed bound");
  const w2Limits = values.filter((v) => v.name === "W2-limits");
  const backendSeen = values.filter((v) => v.name === "backend");
  const integrationSummary = readJson(
    join(out, "integration-run", "summary.json"),
  );
  const pq2 = values.filter((v) => v.name === "P-Q2 quota reserve inputs");
  const shellDir = join(out, "shell");
  const shell = {
    dist: readJson(join(shellDir, "dist.json")),
    "dist-fixture": readJson(join(shellDir, "dist-fixture.json")),
  };
  const programme = contentionProgramme();
  for (const id of ["P-6", "P-7", "P-8", "P-9", "P-13"])
    programme[id] = { ...programme[id], status: statusOf(id) };
  const configValues = constants();
  const pinned = JSON.parse(
    readFileSync(join(root, "contract-pin.json"), "utf8"),
  );
  const named = (prefix) =>
    measurements
      .filter((m) => m.name.startsWith(prefix))
      .map((m) => m.name)
      .filter((n, i, a) => a.indexOf(n) === i);
  const capturesResolved = resolution.cells
    .filter((c) => c.kind === "w2-capture")
    .every((c) => c.status === "ok");
  const w1Outcomes = Object.fromEntries(
    memory.map((m) => [
      m.engine,
      (m.rows ?? [])
        .filter((r) => r.workload === "W1")
        .flatMap((r) => (r.runs ?? []).map((run) => run.outcome)),
    ]),
  );
  const w2Outcomes = Object.fromEntries(
    w2Memory.map((m) => [
      m.engine,
      (m.rows ?? []).flatMap((r) => (r.runs ?? []).map((run) => run.outcome)),
    ]),
  );
  const devicePage = Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      readJson(join(out, "device-page", `results.${engine}.json`)),
    ]),
  );
  const deviceValidation = Object.fromEntries(
    resolution.cells
      .filter((c) => c.kind === "device-file")
      .map((c) => [
        `results.${c.engine}.json`,
        { status: c.status, reasons: c.reasons },
      ]),
  );

  // ---- the consumer map: every BE-B1 item (1 to 7) and BE-Q23 row (M0 to M9), with what this record answers ------------------------------
  // Provenance is complete only when every stage recorded its candidate, the backend the integration stage ran was recorded, and the
  // resolved outcomes are complete.
  const provenanceStatus =
    integrationSummary?.backend &&
    backendSeen.length > 0 &&
    resolution.outcomes_complete
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
      "partial",
      ["H3", "P-2", "P-11", "P-W2"],
      "W1, W3 to W7 generated and hashed; W2 captured from the real /sync" +
        (capturesResolved ? "" : " (NOT complete: see P-W2)") +
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
      "desktop: Chromium heap (CDP), the browser's RSS attributed per run (its own processes; on macOS WebKit with its WebContent, Networking and GPU services from the host's launchd domain; BROWSER-PROCESS RSS, not device memory and not server RSS), scan and commit times, outcomes, five cold runs; IndexedDB bytes only as Chromium's exact figure and the obfuscated estimate elsewhere; the device tools (dumpsys, Instruments, about:memory) need the roster",
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
      [
        "results.json",
        "resolution.json",
        "report.md",
        "evidence/",
        "SHA256SUMS",
      ],
      "machine-readable results, the resolved evidence contract, the evidence itself, a short report and checksums exist; the statement that every figure is measured on real hardware CANNOT be made (desktop only)",
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
      "the desktop method is stated (heap in Chromium only, the browser's attributed RSS, GC before baseline and after, five cold runs, outcome per run); the per-platform device tools are part of the device package, not run",
      devicesOwner,
    ),
    "BE-Q23:M3 fixtures": entry(
      capturesResolved ? "measured" : "partial",
      ["H3", "fixtures/hashes.json", "fixtures/W2-hashes.json"],
      capturesResolved
        ? "generator source and SHA-256 of W1, W3 to W7; the W2 bytes captured from the real /sync in every engine (limits 1 and 80), hashed and resolved against their records"
        : "generator source and SHA-256 of W1, W3 to W7; W2 not captured and resolved in every engine (see P-W2)",
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
      statusOf("P-4") === "measured" ? "partial" : "not_run",
      ["P-4", "P-10", "P-3", "P-9"],
      "desktop per-request overhead (pre-issue, lease and lock, request, record) on loopback and behind a 250 ms proxy delay; a 10,000-resource snapshot is WEB-09b's and was not run",
      "WEB-09b (snapshot), the roster (device CPU)",
    ),
    "BE-Q23:M8 smallest unprocessable response": entry(
      "partial",
      ["H8"],
      failure === null
        ? "desktop: UNDETERMINED, the desktop programme's outcomes are incomplete (see desktop_programme); the answer for supported devices needs the roster"
        : failure
          ? "desktop: valid workloads failed (see H8.desktop_answer); the answer for supported devices needs the roster"
          : "desktop: no valid workload failed on any desktop engine of this programme, whose outcomes are complete; the answer for supported devices needs the roster",
      devicesOwner,
    ),
    "BE-Q23:M9 derived values": entry(
      "partial",
      ["H9"],
      "desktop D(engine) and W1/W2 admission at limit 1; the limit in use per phase; needs_finer_pagination undetermined for supported devices; validator and maxItems answered from source",
      devicesOwner,
    ),
  };

  const desktopProgramme = {
    contract_version: CONTRACT_VERSION,
    complete: resolution.complete,
    outcomes_complete: resolution.outcomes_complete,
    counts: resolution.counts,
    cells: resolution.cells.length,
    missing: listOf(resolution, "missing"),
    invalid: listOf(resolution, "invalid"),
    failed: listOf(resolution, "failed"),
    failed_controls: listOf(resolution, "failed_control"),
    not_isolated: listOf(resolution, "not_isolated"),
    unavailable: listOf(resolution, "unavailable"),
    note: "every required observation of the evidence contract (scripts/lib/profile-contract.mjs, resolution.json) resolved against the evidence this hand-over carries (evidence/); a partial hand-over is valid only as a partial one: its validator exits 1 (2 with --allow-partial), and nothing is concluded from what is absent",
  };

  const results = {
    schema: 3,
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
            invocation: r.invocation ?? null,
            started_at: r.started_at,
            action_started_at: r.action_started_at ?? null,
            action_finished_at: r.action_finished_at ?? null,
            finished_at: r.finished_at ?? null,
            exit_status: r.exit_status ?? null,
            sealed: r.sealed === true,
            sampler: r.sampler ?? null,
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
        "peak and retained JS heap (Chromium only, CDP) and the browser's resident set (ps) across receive, scan, validate, stage and commit; the processes counted are the browser's own: the test worker's descendants and, for WebKit on macOS, every service in each WebKit host's launchd PID domain (WebContent, Networking, GPU), each checked against pid reuse (scripts/lib/browser-processes.mjs); every run records its process set, sample count, failed samples and whether its attribution was complete, and a run without complete attribution is not memory evidence. BROWSER-PROCESS RSS: not device memory, not server RSS. Five cold runs (a new browser context each); idle baseline recorded before the run; outcome per run; the modelled figure is WEB-03's (A:3483-3497) beside each measured one, labelled modelled",
      modelled: {
        "W1 at limit 1":
          "150.75 MiB (WEB-03's combined check, 120.6 % of its R, rejected by that model; this client does not apply that check, it bounds processing instead)",
      },
      memory_files: [
        ...memory.map((m) => `memory/P-11.${m.engine}.json`),
        ...w2Memory.map((m) => `w2/P-W2.${m.engine}.json`),
      ],
      memory_cells: Object.fromEntries(
        CELL_STATUSES_FOR_REPORT.map((s) => [
          s,
          resolution.cells.filter((c) => c.kind === "memory" && c.status === s)
            .length,
        ]),
      ),
    },
    H3: {
      status: capturesResolved ? "measured" : "partial",
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
      desktop_valid_workload_failure: failure,
      derived_from: resolution.outcomes_complete
        ? "a desktop programme whose outcomes are complete (desktop_programme.outcomes_complete)"
        : "an INCOMPLETE desktop programme: only failures it holds are facts; their absence is not",
      desktop_answer:
        failure === null
          ? "UNDETERMINED: the desktop programme's outcomes are incomplete (see desktop_programme), so the absence of a failure in it is not evidence that none would occur"
          : failure
            ? { failures: resolution.failures }
            : "no valid workload (W1, W3, W4, W6 in five cold runs; W2 live and in five cold runs; the device page's runs) was refused or failed on any desktop engine of this programme",
      negative_controls_not_fulfilled: desktopProgramme.failed_controls,
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
      desktop_D_largest_dense_changes_committed:
        derived.desktop_D_largest_dense_changes_committed,
      desktop_D_basis:
        "the largest dense P-2 page whose commit series, and the series of every smaller dense page, RESOLVED in that engine (exact sample count, raw support, window, isolation); null when the smallest did not",
      w1_outcomes_at_limit_1: w1Outcomes,
      w2_outcomes_at_limit_1: w2Outcomes,
      w2_live_outcome: Object.fromEntries(
        w2Memory.map((m) => [m.engine, m.live?.outcome ?? null]),
      ),
      // false only from a COMPLETE programme with no failure; otherwise null (a failure is a fact in H8, not by itself a diagnosis).
      desktop_needs_finer_pagination: derived.desktop_needs_finer_pagination,
      needs_finer_pagination: `undetermined for supported devices; desktop: ${
        derived.desktop_needs_finer_pagination === false
          ? "no valid workload failed on a desktop engine of this complete, isolated programme, so the desktop engines do not need it"
          : failure
            ? "UNDETERMINED: a valid workload failed on a desktop engine (H8); that failure is a fact, but it does not by itself establish finer pagination as the remedy"
            : "UNDETERMINED, the desktop programme is not complete (see desktop_programme)"
      }`,
    },
    programme: {
      "P-1": {
        ...(bundleRecord ?? {
          reason: "the bundle stage did not run in this record",
        }),
        status: statusOf("P-1"),
      },
      "P-1S": {
        status: statusOf("P-1S"),
        label:
          "Chromium only, CDP network and CPU throttling: EMULATED throttling, not a device; reported, not judged; every cold run judged for isolation over its own window",
        results: shell,
      },
      "P-2": { status: statusOf("P-2"), names: named("P-2") },
      "P-3": {
        status: statusOf("P-3"),
        caveat:
          "ephemeral Playwright profile; the hint is passed through Dexie's `chromeTransactionDurability` option; whether Firefox and WebKit act on it was not determined",
      },
      "P-4": {
        status: statusOf("P-4"),
        layer: "integration, released backend on loopback",
      },
      "P-5": {
        status: statusOf("P-5"),
        measured:
          "maxInFlight 1, 200 drafts and 201 dense drafts, 20 runs each",
        omitted:
          "maxInFlight 2 and 3 (D-18 fixes 1: a declared omission, not a measurement), and the outbox drain's own effect on a second page's waits (the sync leader's effect is P-7 and P-9)",
      },
      ...programme,
      "P-10": {
        status: statusOf("P-10"),
        conclusion:
          "the stamped request time-out (30 s) against the measured durations; see the rows named P-10",
      },
      "P-11": {
        status: statusOf("P-11"),
        note: "desktop engines through the real wrapper; real devices not run (H1)",
      },
      "P-W2": {
        status: statusOf("P-W2"),
        layer:
          "the released backend (put_field with checklist values and a grant, then the real /sync) on a desktop engine; the captured bytes then processed through the production path in five cold runs per engine",
        captures: w2,
        processing_files: w2Memory.map((m) => `w2/P-W2.${m.engine}.json`),
      },
      "W2-limits": { status: statusOf("W2-limits") },
      device: {
        status: statusOf("device"),
        note: "the device page's whole protocol on each desktop engine (39 distinct runs over 19 workloads, W2 from that engine's capture): the route a device operator follows, not a device run",
      },
      "P-12": { status: "provisional", file: "handoff/constants.md" },
      "P-Q": {
        status: statusOf("P-Q"),
        note: "footprints measured; Firefox and Safari report an obfuscated estimate",
      },
      "P-Q2": {
        status: statusOf("P-Q2"),
        note: "the atlas-auth burst, each engine's estimate step and the ledger overhead; the reserve itself (8 MiB) is NOT changed: a desktop figure cannot set a device constant",
        by_engine: Object.fromEntries(pq2.map((v) => [v.engine, v])),
      },
    },
    consumer_map: consumerMap,
    desktop_programme: desktopProgramme,
    isolation: {
      method: `${ISOLATION_METHOD} Each cell is judged over its own window by the load samples of its OWN stage only; a stage whose sampler was not ready before its action, did not write its final sample after it, wrote malformed samples or whose clock went backwards judges all its cells unknown.`,
      sampling_interval_ms: SAMPLE_INTERVAL_MS,
      summary: isolationSummary,
      tests,
      applicability:
        "a timing, rate, memory or footprint figure is applicable as an isolated desktop measurement only when its cell is `ok` (its window `clean`); any other verdict qualifies it (it was, or may have been, taken beside other heavy work, or its coverage is unknown). Shapes, byte counts, hashes and admission outcomes do not depend on isolation. A 5 s poll cannot prove that no short foreign job ran between two samples: final timings need a protected controller",
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
    device_page_validation: deviceValidation,
    measurement_rows: measurements.length,
  };
  writeFileSync(
    join(handoff, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  const cellOf = new Map(resolution.cells.map((c) => [c.id, c]));
  const table = measurements
    .map((m) => {
      const cell = cellOf.get(`${m.name}[${m.engine}]`);
      return `| ${m.name} | ${m.engine} | ${m.n} | ${m.p50} | ${m.p95} | ${m.max} | ${cell ? `${cell.status}${cell.isolation ? ` (${cell.isolation.verdict})` : ""}` : "not a required cell"} |`;
    })
    .join("\n");
  const statusLine = resolution.complete
    ? "**Desktop programme: COMPLETE and ISOLATED.** Every required cell of the evidence contract resolved, and every load-dependent cell was taken with no other heavy work on the controller. Device evidence is still escalated (H1)."
    : `**Desktop programme: ${resolution.outcomes_complete ? "outcomes complete, NOT ISOLATED" : "INCOMPLETE"}.** This is a partial hand-over: of ${resolution.cells.length} required cells, ${resolution.counts.missing} missing, ${resolution.counts.invalid} invalid, ${resolution.counts.failed} failed, ${resolution.counts.failed_control} failed control(s), ${resolution.counts.not_isolated} not isolated. No desktop conclusion is drawn from what is absent.`;
  const head = (list) =>
    list.length
      ? `${list
          .slice(0, 40)
          .map((c) => `${c.id} (${c.reasons.join("; ")})`)
          .join(
            "; ",
          )}${list.length > 40 ? `; and ${list.length - 40} more (resolution.json)` : ""}`
      : "none";
  const completenessSection = [
    `* Desktop programme complete: **${resolution.complete}** (outcomes complete: ${resolution.outcomes_complete}). Contract version ${CONTRACT_VERSION}; ${resolution.cells.length} required cells: ${Object.entries(
      resolution.counts,
    )
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")}.`,
    `* Missing: ${head(desktopProgramme.missing)}.`,
    `* Invalid: ${head(desktopProgramme.invalid)}.`,
    `* Failed: ${head(desktopProgramme.failed)}.`,
    `* Negative controls not fulfilled: ${head(desktopProgramme.failed_controls)}.`,
    `* Not isolated: ${head(desktopProgramme.not_isolated)}.`,
    `* Unavailable by declared capability: ${head(desktopProgramme.unavailable)}.`,
    `* Isolation of ${isolationSummary.judged_cells} judged cells: ${verdicts.clean} clean, ${verdicts.idle_foreign} idle_foreign, ${verdicts.contaminated} contaminated, ${verdicts.unknown} unknown (load samples every ${SAMPLE_INTERVAL_MS / 1000} s).`,
    `* H8 (a valid workload failed on a desktop engine): ${failure === null ? "undetermined" : failure}. H9 desktop needs finer pagination: ${derived.desktop_needs_finer_pagination === null ? "undetermined" : derived.desktop_needs_finer_pagination}. D(engine): ${JSON.stringify(derived.desktop_D_largest_dense_changes_committed)}.`,
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
      `* **${k}**: ${v.status}${v.reason ? `. ${v.reason}` : ""}${v.note ? `. ${v.note}` : ""}${v.caveat ? `. ${v.caveat}` : ""}${v.label ? `. ${v.label}` : ""}${v.omitted ? `. Not measured: ${v.omitted}` : ""}`,
  )
  .join("\n")}

## Measurements (milliseconds unless the name says otherwise; p50, p95 and max)

The last column is the row's cell in the evidence contract: \`ok\` (resolved and isolated) or why not, with its isolation verdict. Only \`ok\` figures are isolated desktop measurements.

| Measurement | Engine | n | p50 | p95 | max | Cell |
| --- | --- | --- | --- | --- | --- | --- |
${table}

The evidence itself is in \`evidence/\` (raw samples \`evidence/raw/\`, per-run memory \`evidence/memory/\` and \`evidence/w2/\`, the device page's own results \`evidence/device-page/\`, the contention files \`evidence/contention/\`, the throttled shell boot \`evidence/shell/\`, the stage records \`evidence/stages/\`, the load samples \`evidence/isolation/\`), every cell's resolution in \`resolution.json\`, and the recorded fixture hashes in \`fixtures/hashes.json\` and \`fixtures/W2-hashes.json\`. \`node scripts/validate-profile-handoff.mjs --handoff <this directory>\` resolves the evidence again.
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
  // The load beside every measuring stage, sampled from before its action to after it (the handoff measures nothing). The stage is
  // sealed whatever happens; a sampler that never becomes ready fails the stage before its action.
  status = await runStage(out, stage, action, {
    sample:
      stage === "handoff" ? null : (dir, name) => startLoadSampler(dir, name),
    invocation: claim.invocation,
    extra: { root, machine: machineRecord },
  });
};
await run("bundle", bundle);
await run("fixture", fixture);
await run("shell", shellStage);
// The contention driver records (and refuses) its own stage, and samples its own load.
if (only.includes("contention") && status === 0) status = contention();
await run("integration", integration);
await run("device", device);
await run("handoff", () => assembleHandoff());
claim.release(status);
log(`written to ${out} (exit ${status})`);
process.exit(status);

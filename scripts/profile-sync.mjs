#!/usr/bin/env node
// `pnpm profile:sync`: the sync-profiling programme (evidence key `WEB-09a:sync-profiling`, owned by WEB-09c since BC-20261009). It takes
// MEASUREMENTS, not budgets, into the evidence directory the caller names, with the machine, the candidate and the load recorded first. It
// never claims more than it measured: every figure is `measured`, `partial`, `not_run`, `transferred` or `escalated` with the reason, and the
// hand-over says in its first paragraph that it is desktop-scoped, that the physical-device measurements are WEB-09d's and have not run
// (STAGED-ACCEPTANCE-20261011; revision 6, review 6 R7), and what its own evidence can support (acceptance_scope; never a review or an acceptance).
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
import { RECORDED, resolveEvidence } from "./lib/profile-contract.mjs";
import {
  CLAIM_FILE,
  candidate,
  claimDirectory,
  claimHolder,
  ENGINES,
  evidenceArg,
  recordedStages,
  refuseRecorded,
  runStage,
  STAGES,
} from "./lib/profile-evidence.mjs";
import { startLoadSampler } from "./lib/profile-isolation.mjs";
import { projectResults, renderReport } from "./lib/profile-projection.mjs";
import { snapshotSourceFacts } from "./lib/profile-source-facts.mjs";

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
      // The NODE_ENV the build was given (review 7 R8: absent unless the caller supplied it; never one left by an imported module).
      writeFileSync(
        join(out, "bundle", `build-${label}.json`),
        `${JSON.stringify({ script, seconds: +((Date.now() - started) / 1000).toFixed(1), node_env: process.env.NODE_ENV ?? null })}\n`,
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
      `${JSON.stringify({ seconds: +((Date.now() - started) / 1000).toFixed(1), node_env: process.env.NODE_ENV ?? null })}\n`,
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
desktop figure of this programme is evidence beside a constant; it does not settle one that depends on a device class (WEB-09d's physical-device pass).

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

/** The evidence the hand-over carries (`handoff/evidence/`): every file of the directory but the hand-over itself and the live claim. */
function copyEvidence(handoff) {
  const target = join(handoff, "evidence");
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(out))
    if (name !== "handoff" && name !== CLAIM_FILE)
      cpSync(join(out, name), join(target, name), { recursive: true });
  return target;
}

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
  const fixtures = join(handoff, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  copyFileSync(
    join(root, "scripts/lib/profile-workloads.mjs"),
    join(fixtures, "profile-workloads.mjs"),
  );
  writeFileSync(
    join(fixtures, "hashes.json"),
    `${JSON.stringify(RECORDED, null, 2)}\n`,
  );

  // The evidence, carried and resolved (review R2; design assessment C/D): every status and conclusion comes from the contract's resolution
  // of the copy the hand-over carries, and (revision 3, review 3 R2) every published figure from the projection of that same copy
  // (scripts/lib/profile-projection.mjs), which the validator projects again. Nothing is read from the stage directory after this copy.
  const evidenceDir = copyEvidence(handoff);
  const resolution = resolveEvidence(evidenceDir);
  writeFileSync(
    join(handoff, "resolution.json"),
    `${JSON.stringify(resolution, null, 2)}\n`,
  );
  // The W2 captures, copied from the carried evidence with their hashes, so the hand-over's fixtures are exactly the evidence's bytes.
  const w2Dir = join(evidenceDir, "w2");
  const w2Hashes = {};
  for (const file of existsSync(w2Dir)
    ? readdirSync(w2Dir)
        .filter((f) => /^W2-captured\..+\.json$/.test(f))
        .sort()
    : []) {
    copyFileSync(join(w2Dir, file), join(fixtures, file));
    w2Hashes[file] = sha256(readFileSync(join(fixtures, file)));
  }
  writeFileSync(
    join(fixtures, "W2-hashes.json"),
    `${JSON.stringify(w2Hashes, null, 2)}\n`,
  );
  const results = projectResults({
    evidenceDir,
    resolution,
    context: {
      now,
      machine: machineRecord,
      pinned: JSON.parse(readFileSync(join(root, "contract-pin.json"), "utf8")),
      configValues: constants(),
      // Revision 5 (review 5 R6): H9's snapshot answer, read from this candidate's code; the validator reads it again from its own.
      sourceFacts: snapshotSourceFacts(root),
    },
  });
  writeFileSync(
    join(handoff, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  writeFileSync(
    join(handoff, "report.md"),
    renderReport({ results, resolution, evidenceDir }),
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

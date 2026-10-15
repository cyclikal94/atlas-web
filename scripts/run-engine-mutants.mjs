#!/usr/bin/env node
// Real-browser mutation checks on patched COPIES, with unchanged assertions/timers.
// --check validates every selected patch before any build/browser. --jobs 1..4
// isolates each concurrent job's bundle, port, Playwright output and evidence.
// A single unmutated build is shared only within this source-fingerprinted run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./integration/free-port.mjs";
import { ENGINE } from "./mutation/data-catalogue.mjs";
import { classifyMutant, inspectReport } from "./validation/engine-results.mjs";
import {
  fingerprint,
  isolatedPool,
  json,
  newRun,
  positiveInteger,
  processes,
} from "./validation/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// MP-20261006: route managed mutation invocations before any local build starts.
if (
  !process.argv.includes("--check") &&
  !process.env.ATLAS_POOL_LOCAL_MUTATION
) {
  const { existsSync: atlasExists } = await import("node:fs");
  const atlasContextFile = join(root, ".agtx/delivery-context.json");
  if (atlasExists(atlasContextFile)) {
    const atlasContext = JSON.parse(readFileSync(atlasContextFile, "utf8"));
    if (!atlasContext.orchestrator)
      throw new Error("Managed mutation context has no orchestrator");
    const { pathToFileURL: atlasURL } = await import("node:url");
    const { routeNativeInvocation } = await import(
      atlasURL(
        join(
          atlasContext.orchestrator,
          "scripts/test_runners/native-routing.mjs",
        ),
      ).href
    );
    process.exit(await routeNativeInvocation(root, process.argv.slice(2)));
  }
}
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") continue;
  if (!["--only", "--browsers", "--port", "--out", "--jobs"].includes(args[i]))
    throw new Error(`Unknown option: ${args[i]}`);
  if (!args[++i] || args[i].startsWith("--"))
    throw new Error("Missing option value");
}
const value = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return args[at + 1];
};
const outDir = resolve(root, value("--out", ".agtx/evidence/WEB-09a/mutants"));
const jobs = positiveInteger(value("--jobs", "1"), "--jobs");
const port = args.includes("--port")
  ? positiveInteger(value("--port"), "--port", 65535)
  : null;
if (port && jobs !== 1)
  throw new Error(
    "--port requires --jobs 1; parallel jobs use private OS-selected ports",
  );
const browsers = value("--browsers", "chromium,firefox,webkit").split(",");
if (
  !browsers.length ||
  browsers.some((b) => !["chromium", "firefox", "webkit"].includes(b)) ||
  new Set(browsers).size !== browsers.length
)
  throw new Error("Invalid or duplicate --browsers");
const only = value("--only", "").split(",").filter(Boolean);
if (args.includes("--only") && only.length === 0)
  throw new Error("Empty --only selection");
if (only.some((id) => !ENGINE.some((m) => m.id === id)))
  throw new Error("Unknown --only mutant ID");
const selected = ENGINE.filter((m) => !only.length || only.includes(m.id));
const EXPECTED_ENGINE = 191;
// Opt-in concurrency is restricted to native adapter conformance. Expiry/wake,
// quota/ownership, wipe and other groups have barriers even with --jobs > 1.
const mayParallelise = (m) =>
  m.spec === "tests/e2e/fixture.data-store.spec.ts" && m.grep === "E-A3";
if (!selected.length || (!only.length && ENGINE.length !== EXPECTED_ENGINE))
  throw new Error(
    "Engine catalogue count does not match the required inventory",
  );
const runDir = newRun(outDir);
const before = fingerprint(root);
json(join(runDir, "inputs.json"), before);
console.log(`Evidence: ${runDir}`);
const proc = processes(root);
let interrupted = false;
const results = [];
const controls = new Map();
let fatal = null;
let preflight = false;
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function build(mutantDir, buildDir, log) {
  const result = await proc.run(
    "pnpm",
    [
      "exec",
      "vite",
      "build",
      "--mode",
      "fixture",
      "--config",
      "vite.mutant.config.ts",
    ],
    { ATLAS_MUTANT_DIR: mutantDir ?? "", ATLAS_MUTANT_OUT_DIR: buildDir },
  );
  writeFileSync(log, result.output);
  if (result.code) throw new Error(`Build failed: ${log}`);
}
async function withPreview(buildDir, action) {
  const number = port ?? (await freePort());
  const url = `http://127.0.0.1:${number}`;
  const token = Buffer.from(buildDir).toString("base64url");
  const marker = "atlas-validation-owner.txt";
  writeFileSync(join(buildDir, marker), token);
  const server = proc.start(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--mode",
      "fixture",
      "--config",
      "vite.mutant.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(number),
      "--strictPort",
    ],
    { ATLAS_MUTANT_OUT_DIR: buildDir, ATLAS_MUTANT_DIR: "" },
  );
  let ready = false;
  try {
    for (let i = 0; i < 150 && !proc.cancelled; i++) {
      if (server.child.exitCode !== null || server.child.signalCode !== null)
        throw new Error(`Preview exited: ${server.output}`);
      try {
        if (
          (await (
            await fetch(`${url}/${marker}`, {
              signal: AbortSignal.timeout(500),
            })
          ).text()) === token
        ) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await sleep(100);
    }
    if (!ready) throw new Error("Preview readiness failed");
    // If another process won the free-port race, strictPort must have exited.
    await sleep(100);
    if (server.child.exitCode !== null || server.child.signalCode !== null)
      throw new Error(`Preview failed: ${server.output}`);
    return await action(url);
  } finally {
    try {
      process.kill(-server.child.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-server.child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, 2000);
    await server.done;
    clearTimeout(timer);
  }
}
async function playwright(mutant, url, directory) {
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, "report.json");
  const result = await proc.run(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      ...browsers.map((b) => `--project=fixture-${b}`),
      mutant.spec,
      "-g",
      mutant.grep,
      "--workers=1",
      "--retries=0",
      "--reporter=json",
      `--output=${join(directory, "test-results")}`,
    ],
    {
      ATLAS_FIXTURE_URL: url,
      ATLAS_E2E_BROWSERS: "all",
      ATLAS_EVIDENCE_DIR: join(directory, "evidence"),
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    },
  );
  writeFileSync(join(directory, "playwright.log"), result.output);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return inspectReport(report, browsers, result.code);
}
try {
  // Fail before expensive work even when a late catalogue entry has a bad anchor.
  const patches = [];
  const failures = [];
  for (const mutant of selected) {
    try {
      const text = readFileSync(join(root, mutant.file), "utf8");
      const patched = mutant.patch(text);
      if (patched === text) throw new Error("patch changed nothing");
      patches.push({ mutant, patched });
    } catch (error) {
      failures.push({
        id: mutant.id,
        patch_failed: String(error.message ?? error),
      });
    }
  }
  json(join(runDir, "preflight.json"), {
    selected: selected.map((m) => m.id),
    failures,
  });
  if (failures.length) {
    results.push(...failures);
    throw new Error(`${failures.length} mutation patch(es) failed preflight`);
  }
  preflight = true;
  if (!args.includes("--check")) {
    const controlBuild = join(runDir, "control-build");
    await build(null, controlBuild, join(runDir, "control-build.log"));
    // A control group runs once per invocation, against the same immutable build.
    const groups = [
      ...new Map(selected.map((m) => [`${m.spec}::${m.grep}`, m])).entries(),
    ];
    const checked = await isolatedPool(
      groups,
      jobs,
      ([, m]) => mayParallelise(m),
      async ([key, mutant], index) => {
        const result = await withPreview(controlBuild, (url) =>
          playwright(mutant, url, join(runDir, `control-${index}`)),
        );
        controls.set(key, result);
        console.log(`control ${result.controlOk ? "passes" : "FAILS"}: ${key}`);
        if (!result.controlOk) throw new Error(`Control failed: ${key}`);
        return result;
      },
    );
    if (checked.some((r) => r?.error) || controls.size !== groups.length)
      throw new Error("Controls failed; mutants were not started");
    const mutated = await isolatedPool(
      patches,
      jobs,
      ({ mutant }) => mayParallelise(mutant),
      async ({ mutant, patched }) => {
        const directory = join(runDir, mutant.id);
        const source = join(directory, "source");
        const target = join(source, mutant.file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, patched);
        const buildDir = join(directory, "build");
        await build(source, buildDir, join(directory, "build.log"));
        const r = await withPreview(buildDir, (url) =>
          playwright(mutant, url, join(directory, "browser")),
        );
        const control = controls.get(`${mutant.spec}::${mutant.grep}`);
        const inventory = (report) =>
          report.cases.map((c) => `${c.engine}::${c.title}`).sort();
        const inventoryMatches =
          JSON.stringify(inventory(r)) === JSON.stringify(inventory(control));
        r.complete = r.complete && inventoryMatches;
        const result = {
          inventory_matches_control: inventoryMatches,
          id: mutant.id,
          title: mutant.title,
          file: mutant.file,
          spec: mutant.spec,
          grep: mutant.grep,
          expect: mutant.expect ? String(mutant.expect) : undefined,
          ...classifyMutant(mutant, r, browsers),
          exit: r.code,
          engines_failing: [...new Set(r.failed)],
          engines_passing: [...new Set(r.passed)],
        };
        json(join(directory, "result.json"), result);
        console.log(`${result.caught ? "caught" : "FAILED"} ${mutant.id}`);
        // Stop queuing new expensive work on a survivor/crash; in-flight work finishes.
        if (!result.caught) {
          results.push(result);
          throw new Error(
            `Mutation not caught by the required assertion: ${mutant.id}`,
          );
        }
        return result;
      },
    );
    results.push(...mutated.filter((r) => r && !r.error));
    if (mutated.some((r) => r?.error)) fatal = mutated.filter((r) => r?.error);
  }
} catch (error) {
  fatal = String(error.stack ?? error);
} finally {
  interrupted = proc.cancelled;
  await proc.close();
}
const after = fingerprint(root);
json(join(runDir, "inputs-after.json"), after);
const unchanged = before.sha256 === after.sha256;
const checkOnly = args.includes("--check");
const passed =
  !interrupted &&
  !fatal &&
  preflight &&
  unchanged &&
  (checkOnly ||
    (results.length === selected.length && results.every((r) => r.caught)));
const summary = {
  layer: "L1c (real engines, mutant fixture bundle, unmutated control build)",
  browsers,
  jobs,
  check_only: checkOnly,
  preflight_pass: preflight,
  expected_engine_mutants: EXPECTED_ENGINE,
  selected: selected.map((m) => m.id),
  run: results.length,
  caught: results.filter((r) => r.caught).length,
  controls_pass:
    !checkOnly &&
    controls.size > 0 &&
    [...controls.values()].every((c) => c.controlOk),
  count_ok: !checkOnly && results.length === selected.length,
  source_unchanged: unchanged,
  passed,
  fatal,
  elapsed_ms: Date.now() - started,
  at: new Date().toISOString(),
  evidence: runDir,
};
json(join(runDir, "engine-results.json"), {
  summary,
  results,
  controls: Object.fromEntries(controls),
});
// Compatibility summary points to the immutable run; its detailed evidence is never overwritten.
json(join(outDir, "engine-results.json"), {
  summary,
  results,
  controls: Object.fromEntries(controls),
});
console.log(JSON.stringify(summary));
process.exitCode = passed ? 0 : 1;

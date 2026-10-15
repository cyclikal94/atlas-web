#!/usr/bin/env node
// Execute an explicit, task-owned validation plan. This is a fail-fast runner, not
// an acceptance oracle: it never emits phase markers or waives deferred checks.
// node scripts/run-validation.mjs plan.json [--final] [--out <ignored directory>]
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCampaign } from "./validation/campaign.mjs";
import { EvidenceCache, ordered, qualify } from "./validation/reliability.mjs";
import { fingerprint, json, newRun, processes } from "./validation/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--final") continue;
  if (args[i] !== "--out" || !args[++i] || args[i].startsWith("--"))
    throw new Error("Expected --final or --out <path>");
}
if (!args[0] || args[0].startsWith("--"))
  throw new Error("Supply a validation-plan JSON file");
const planPath = resolve(root, args[0]);
const requestedPlan = JSON.parse(readFileSync(planPath, "utf8"));
let plan = requestedPlan;
if (!Array.isArray(plan.steps) || !plan.steps.length)
  throw new Error("Expected non-empty steps");
const stages = ["preflight", "qualification", "focused", "final", "profiling"];
const ids = new Set();
for (const step of plan.steps) {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(step.id) ||
    ids.has(step.id) ||
    !stages.includes(step.stage) ||
    !Array.isArray(step.argv) ||
    !step.argv.length ||
    step.argv.some((arg) => typeof arg !== "string") ||
    typeof step.requirement !== "string" ||
    !step.requirement.trim()
  )
    throw new Error(
      "Each step needs a unique safe id, stage, argv and requirement mapping",
    );
  if (
    step.env !== undefined &&
    (step.env === null ||
      Array.isArray(step.env) ||
      typeof step.env !== "object" ||
      Object.values(step.env).some((v) => typeof v !== "string"))
  )
    throw new Error("env must map names to string values");
  ids.add(step.id);
}
qualify(plan);
ordered(plan); // Validate dependencies before creating output directories.
const outAt = args.indexOf("--out");
const parent = outAt < 0 ? ".agtx/evidence/validation" : args[outAt + 1];
if (!parent || parent.startsWith("--")) throw new Error("Missing --out path");
const runDir = newRun(resolve(root, parent));
let campaign;
try {
  campaign = prepareCampaign(plan, { root, runDir });
} catch (error) {
  json(join(runDir, "requested-plan.json"), requestedPlan);
  json(join(runDir, "preflight-error.json"), {
    passed: false,
    error: String(error),
    checks_started: 0,
  });
  console.error(`Validation preflight refused the plan; evidence: ${runDir}`);
  throw error;
}
plan = campaign.plan;
const sequence = ordered(plan);
const before = fingerprint(root);
const full = args.includes("--final");
const cache = new EvidenceCache(
  root,
  join(root, ".agtx/evidence/validation-reuse"),
  before,
);
const records = [];
let temporary = null;
let proc = null;
let interrupted = false;
let failed = false;
let failureReason = null;
let fatal = null;
try {
  // Honour an explicitly supplied allocation root. Invalid/empty roots refuse;
  // only standalone invocations without TMPDIR use the platform default.
  const suppliedRoot = process.env.TMPDIR;
  if (suppliedRoot !== undefined && !suppliedRoot.trim())
    throw new Error("The supplied TMPDIR is empty; no validation step was run");
  temporary = mkdtempSync(
    join(
      suppliedRoot === undefined
        ? process.platform === "darwin"
          ? "/private/tmp"
          : "/tmp"
        : resolve(suppliedRoot),
      "atlas-v-",
    ),
  );
  proc = processes(root);
  json(join(runDir, "temporary.json"), {
    path: temporary,
    owner_pid: process.pid,
  });
  let stepTemporary = temporary;
  const executing = {
    ...proc,
    run: (command, args, env) =>
      proc.run(command, args, {
        ...env,
        TMPDIR: stepTemporary,
        TMP: stepTemporary,
        TEMP: stepTemporary,
      }),
  };
  // AR-20261006: managed Atlas campaigns route eligible batches automatically.
  // Outside agtx the normal standalone/local validation path is unchanged.
  let router = null;
  const contextFile = join(root, ".agtx/delivery-context.json");
  if (existsSync(contextFile)) {
    const context = JSON.parse(readFileSync(contextFile, "utf8"));
    if (!context.orchestrator)
      throw new Error("Managed validation context has no orchestrator");
    const { createRouter } = await import(
      pathToFileURL(
        join(
          context.orchestrator,
          "scripts/test_runners/validation-routing.mjs",
        ),
      ).href
    );
    router = createRouter({ root, runDir, proc: executing, throughput: true });
  }
  json(join(runDir, "inputs.json"), before);
  json(join(runDir, "requested-plan.json"), requestedPlan);
  json(join(runDir, "plan.json"), plan);
  json(join(runDir, "output-mapping.json"), campaign.outputs);
  console.log(`Validation evidence: ${runDir}`);
  console.log(
    "One campaign: qualification passes directly into focused checks; final/profiling remain deferred unless --final is supplied.",
  );
  for (const stage of stages) {
    for (const step of sequence.filter((s) => s.stage === stage)) {
      if (!full && ["final", "profiling"].includes(stage)) {
        records.push({
          id: step.id,
          status: "deferred",
          requirement: step.requirement,
        });
        continue;
      }
      if (failed || proc.cancelled) {
        if (proc.cancelled) failed = true;
        records.push({
          id: step.id,
          status: "not_run",
          reason: failureReason,
          requirement: step.requirement,
        });
        continue;
      }
      // An edit during an earlier check invalidates the run before more expensive work.
      if (fingerprint(root).sha256 !== before.sha256) {
        failed = true;
        records.push({
          id: step.id,
          status: "not_run",
          reason: "source_changed",
        });
        continue;
      }
      if (
        (step.after ?? []).some(
          (id) =>
            !records.some(
              (r) => r.id === id && ["passed", "reused"].includes(r.status),
            ),
        )
      )
        throw new Error(`Unmet prerequisite for ${step.id}`);
      let key = null;
      let cacheReason = null;
      try {
        key = cache.identity(step);
      } catch (error) {
        cacheReason = String(error.message);
      }
      const reused = cache.load(key);
      if (reused) {
        records.push({
          id: step.id,
          stage,
          requirement: step.requirement,
          status: "reused",
          origin: reused.origin,
          evidence: reused.files,
          elapsed_ms: 0,
        });
        json(join(runDir, "progress.json"), records);
        continue;
      }
      console.log(`${step.id}: start (${stage})`);
      const started = Date.now();
      stepTemporary = join(temporary, String(records.length));
      mkdirSync(stepTemporary);
      const result = router
        ? await router.run(step)
        : await executing.run(step.argv[0], step.argv.slice(1), step.env);
      writeFileSync(join(runDir, `${step.id}.log`), result.output);
      records.push({
        id: step.id,
        stage,
        requirement: step.requirement,
        status: result.code === 0 ? "passed" : "failed",
        exit: result.code,
        signal: result.signal,
        routing: result.routing ?? {
          mode: "local",
          reason: "standalone validation outside agtx",
        },
        elapsed_ms: Date.now() - started,
        cache_reason: cacheReason,
      });
      console.log(
        `${step.id}: exit ${result.code}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      if (fingerprint(root).sha256 !== before.sha256) {
        records.at(-1).status = "invalidated";
        failureReason = "source_changed";
        failed = true;
      }
      if (!failed && !proc.cancelled && key) {
        if (cache.identity(step) !== key) {
          records.at(-1).status = "invalidated";
          failureReason = "runtime_changed";
          failed = true;
        }
        cache.save(key, step, records.at(-1), join(runDir, `${step.id}.log`));
      }
      if (result.code !== 0) failed = true;
      json(join(runDir, "progress.json"), records);
    }
  }
} catch (error) {
  failed = true;
  fatal = String(error.stack ?? error);
} finally {
  for (const step of sequence) {
    if (!records.some((record) => record.id === step.id))
      records.push({
        id: step.id,
        stage: step.stage,
        requirement: step.requirement,
        status:
          !full && ["final", "profiling"].includes(step.stage)
            ? "deferred"
            : "not_run",
        reason: failureReason ?? fatal ?? "interrupted",
      });
  }
  interrupted = proc?.cancelled ?? false;
  try {
    await proc?.close();
  } finally {
    if (temporary !== null) rmSync(temporary, { recursive: true, force: true });
  }
}
const after = fingerprint(root);
const unchanged = before.sha256 === after.sha256;
json(join(runDir, "inputs-after.json"), after);
json(join(runDir, "results.json"), {
  scope: full ? "planned-final-checks" : "focused-checks-only",
  passed: !failed && unchanged && !interrupted,
  source_unchanged: unchanged,
  fatal,
  records,
  acceptance:
    "Independent review must verify the complete requirement inventory and evidence applicability; this runner does not grant acceptance.",
});
console.log(
  !failed && unchanged && !interrupted
    ? "Selected checks passed; inspect the ledger for deferred acceptance."
    : "Validation stopped: inspect results.json; later checks were not run.",
);
process.exitCode = failed || !unchanged || interrupted ? 1 : 0;

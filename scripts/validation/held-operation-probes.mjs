#!/usr/bin/env node
// WEB-08d revision 21 (review r20 R20-N1; design assessment 4645b621 Q1-Q8, Q12-Q14): qualification of the
// held-operation owner (tests/e2e/held-operation.ts, held-operation-ledger.ts) and the fixture's hold seam
// (src/fixture/data-harness/main.ts) in real engines, through the opt-in probes of
// tests/e2e/probe.held-operation.spec.ts.
//
// 1. control: the live tree's probes against an unmutated fixture build. Every `P..` control must pass and
//    every `S..` reporter-shape probe must fail EXACTLY as its healthy profile says.
// 2. copy-control: the same probes from an UNMUTATED copy of the test tree (under .agtx/, never beside the live
//    specs), so that a mutant's deviation cannot come from the copy itself (review r19 H1).
// 3. helper mutants: a patched copy of the owner or its ledger; fixture mutants: a patched copy of the harness in a
//    mutant build (vite.mutant.config.ts, as the native runner builds).
// The source fingerprint must be unchanged at the end. One worker, no retries; a failed part stops the run
// before the next. Nothing is cached.
//
// Revision 22 (review r21 R21-N1; design assessment 58bc72cc Q2-Q4, Q10): each shape's profile also requires the
// whole-mutant verdict of the UNCHANGED `classifyMutant` over that probe's cases. P14/P15 and S10-S21 qualify the
// runtime-origin witness (H7); HM10-HM14 remove or misapply it.
//
// Revision 23 (review r22 R22-N1; design assessment 3bef3bd4 steps 1-7, Q4-Q9): a mutant is no longer "caught" because
// every case merely deviated from its healthy oracle (an error before the body, or a hook timeout, deviates too). The
// pure evaluator scripts/validation/held-operation-qualification.mjs holds every mutant's versioned contract and
// judges each run `caught`, `survived` or `invalid` from the full evidence (every error, its kind, origin, source line
// and own test; the ledger; the exact inventory; the unchanged reader's verdict). Before any mutant, four negative
// controls (NC1-NC4) inject an unrelated fault through a hook appended to a COPY of the probe spec, and each must be
// judged invalid. Anything but a sound control, refused negative controls and caught mutants exits 1.
//
// Revision 24 (review r23 R23-N1; design assessment e228174c C1-C5): a negative control is admitted only when it is
// `qualified`: its run's integrity (exact three-engine inventory, one attempt, exit 1, no signal, the copy's spec exactly
// the live spec with the hook appended), its own scenario (the injected fault really happened, alone, where injected) and
// the named mutant contract's refusal. Each invocation's provenance is recorded and checked: the fault and probes given
// to the hook, the installed mutant, the hashes of the live spec, the hook, the copy's spec and the installed file, the
// copied tree compared file by file with the live one before and after Playwright ran, the exit, the signal and the
// report's digest. --stage negatives needs --controls-evidence: a passed --stage controls run of the same source and
// engines whose controls covered every injected probe. Nothing is reused from an earlier run otherwise.
//
// Revision 25 (review r24 R24-N1; design assessment 91d0404c C1-C5): that provenance was a receipt checked only against itself. Each
// control and negative control is now a published evidence BUNDLE (held-operation-evidence.mjs): the execution record is written when
// Playwright closes (exit, signal, its digest of the report, argv, selection environment); the source fingerprint, the live spec (and
// NC4's live helper) snapshotted at preparation, the spec (and installed file) that ran and the copied tree's inventories before and after
// are written beside the report; the manifest naming every artefact's digest is published last and exclusively. The part is then judged
// ONLY from the bundle re-read from disk (qualifyNegative, judgeControlEvidence), exactly as a replay judges it, bound to this invocation
// and source; campaignOutcome admits only verified parts of this invocation. A --stage negatives prerequisite is re-verified and
// re-judged from its raw control bundles before anything is built.
//
// Revision 26 (review r25 R25-N1; design assessment 26f1a626 steps 1-4, I1-I6): the source digest is not the runtime. Before anything is
// admitted the runner collects its own applicability record (held-operation-applicability.mjs: controller and child Node, the pnpm that
// launches the children, the installed Playwright and Vite trees, the browser installations, the behavioural environment) into
// `applicability.json`; every bundle carries those bytes and its report's own runtime witness must agree with them; every part is judged
// applicable to exactly that record; and the record is collected again at the end (`applicability-after.json`): a change fails the run.
// A --stage negatives prerequisite is admitted only when its controls run's records before and after, and both controls' bundles, apply
// to THIS consumer's record, field by field; the refusal is written to prerequisite.json before anything is built. `admission.json` is
// written at the build boundary itself, once admission has succeeded, so a refusal is observable as its absence. With --check and
// --controls-evidence the prerequisite is admitted the same way and nothing is built (exit 0 only when admitted).
//
// Revision 27 (review r26 R26-N1; design assessment eff76566 I2-I7, steps 1-5): the record left out almost all installed content, and
// the children ran from the live worktree, whose installation any writer can change between two collections. Whenever anything may be
// admitted or built, the run now EXECUTES FROM A PRIVATE SNAPSHOT (held-operation-installation.mjs): the fingerprinted source files and
// the whole installation cloned into a new 0700 directory under TMPDIR, relocated, prepared by pnpm, sealed read-only; the applicability
// record (schema /2) is collected there and names the complete installed content (`installation-inventory.json` holds the inventory its
// digest covers). Every build, preview and Playwright child runs in the snapshot, each only after its stat inventory is found unchanged
// since sealing, and once more at the end; copy trees live inside it (and are copied back to .agtx/held-operation-probe-trees afterwards
// as before). snapshot.json records the seal, every check, the end and the removal; a change, a failed check or a failed removal fails
// the run, and a --stage negatives prerequisite admits a controls run only when its snapshot record shows exactly that.
//
// Revision 28 (review r27 R27-N1/R27-N2; design assessment 3f7047c0 RC1/RC2, I1-I10, steps C1-C5): every child still resolved `pnpm` (and
// through it Corepack, Node, the package manager's configuration and the browsers) OUTSIDE the run at its own launch, so an external
// launcher replaced, executed and restored between the two collections left the run admitted; and the snapshot copied a linked
// installation root and relocated through it. The run now goes through the shared lifecycle (held-operation-execution.mjs
// prepareExecution, the same one the judge's current target uses): a linked installation root is refused before anything is written,
// the snapshot is proved independent of its source, the supported launcher chain is cloned into a PRIVATE RUNTIME that is sealed before
// the first launch, the source installation's state is compared after preparation. Every child (pnpm's preparation, the runtime probe,
// the build, the preview, Playwright) is started by the private launcher's absolute path in the run's one frozen environment, only after
// the execution's guard has found the runtime, the snapshot and every GUARDED tree unchanged: a copied test tree is sealed once its
// patches are installed, a completed build (and a mutant's build input) once written. A change at any time is seen at the next check (the
// end check at the latest) and fails the run for good. When everything has closed, been checked, compared and removed, the run publishes
// its TERMINAL completion record (completion.json, exclusively, last): the split-stage prerequisite and the judge CLI admit a part only
// from a run whose completion record passed and binds it (held-operation-qualification.mjs completionProblems).
// Revision 29 (review r28 R28-N1): every child runs under the shared EXECUTION POLICY (held-operation-execution.mjs): the snapshot's
// Playwright adapted so that no transformed code is read from or written to disk, build and preview loading vite.mutant.config.ts in
// memory (`--configLoader runner`), Node's compile cache disabled, the environment closed and the writable directories guarded empty;
// the completion record names the policy and its digest, and every reader requires the current one.
//
// Usage: node scripts/validation/held-operation-probes.mjs [--check] [--stage all|controls|negatives]
//          [--probes P01,S7,...] [--only HM10,...] [--browsers chromium,firefox,webkit]
//          [--controls-evidence <the --out of a --stage controls run>] --out <dir>
//   --check      preflight only: every contract is total and every patch applies once; nothing is built. With --controls-evidence,
//                the prerequisite (and its runtime applicability to this consumer) is admitted too, still without building.
//   --stage      all (default): controls, negative controls, then mutants; controls: the live and copy controls;
//                negatives: the negative controls alone (with --controls-evidence).
//   --probes     restricts the controls of --stage controls to these probes (exact case titles still required).
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../integration/free-port.mjs";
import {
  applicabilityReasons,
  canonical,
  collectApplicability,
  compareApplicability,
} from "./held-operation-applicability.mjs";
import {
  inventoryOf,
  judgeControlEvidence,
  MANIFEST,
  probeArgv,
  publishBundle,
  qualifyNegative,
  readBundle,
  readRunCompletion,
  SELECTION_ENV,
  sha256,
  writeArtefact,
} from "./held-operation-evidence.mjs";
import {
  EXECUTION_POLICY,
  finishExecution,
  journalUnchanged,
  newExecution,
  prepareExecution,
  snapshotJournal,
  VITE_CONFIG_LOADER,
} from "./held-operation-execution.mjs";
import {
  installationRootProblems,
  inventoryDifferences,
  inventoryDigest,
  unsealTree,
} from "./held-operation-installation.mjs";
import {
  COMPLETION_SCHEMA,
  CONTRACT_VERSION,
  campaignOutcome,
  completionProblems,
  EVIDENCE_SCHEMA,
  FAULT_HOOK,
  HARNESS,
  judgeMutant,
  MUTANTS,
  mutantOf,
  NEGATIVE_CONTRACT_VERSION,
  NEGATIVE_CONTROLS,
  normalise,
  PROBE_IDS,
  PROBE_SPEC,
  prerequisiteProblems,
  snapshotProblems,
  validateContracts,
} from "./held-operation-qualification.mjs";
import { fingerprint, json, newRun, processes } from "./runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const v = args[at + 1];
  if (!v || v.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return v;
};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") continue;
  if (
    ![
      "--out",
      "--browsers",
      "--only",
      "--stage",
      "--probes",
      "--controls-evidence",
    ].includes(args[i])
  )
    throw new Error(`Unknown option: ${args[i]}`);
  i += 1;
}
if (!args.includes("--out"))
  throw new Error("--out is required (no default evidence directory)");
const outDir = resolve(root, value("--out"));
const browsers = value("--browsers", "chromium,firefox,webkit").split(",");
if (
  !browsers.length ||
  browsers.some((b) => !["chromium", "firefox", "webkit"].includes(b)) ||
  new Set(browsers).size !== browsers.length
)
  throw new Error("Invalid or duplicate --browsers");
const stage = value("--stage", "all");
if (!["all", "controls", "negatives"].includes(stage))
  throw new Error("--stage must be all, controls or negatives");
const only = value("--only", "").split(",").filter(Boolean);
for (const id of only) mutantOf(id);
if (only.length && stage !== "all")
  throw new Error("--only selects mutants: it needs --stage all");
const probeIds = value("--probes", "").split(",").filter(Boolean);
if (
  probeIds.some((id) => !PROBE_IDS.includes(id)) ||
  new Set(probeIds).size !== probeIds.length
)
  throw new Error("Unknown or duplicate --probes ID");
if (probeIds.length && stage !== "controls")
  throw new Error("--probes restricts the controls: it needs --stage controls");
const controlIds = probeIds.length ? probeIds : PROBE_IDS;
const selected =
  stage === "all"
    ? MUTANTS.filter((m) => !only.length || only.includes(m.id))
    : [];
const negatives = stage === "controls" ? [] : NEGATIVE_CONTROLS;
const checkOnly = args.includes("--check");
const controlsEvidence = args.includes("--controls-evidence")
  ? resolve(root, value("--controls-evidence"))
  : null;
if (controlsEvidence && stage !== "negatives")
  throw new Error(
    "--controls-evidence is the prerequisite of --stage negatives",
  );
if (stage === "negatives" && !checkOnly && !controlsEvidence)
  throw new Error(
    "--stage negatives needs --controls-evidence: a passed --stage controls run of the same source",
  );

const runDir = newRun(outDir);
// Revision 27: whenever anything may be admitted or built, every child runs from this run's private execution snapshot (revision 28:
// prepared by the shared lifecycle, with its private runtime; the roots exist once preparation has allocated them).
const needsTarget = !checkOnly || Boolean(controlsEvidence);
// This invocation's identity, as every one of its bundles records it.
const invocation = runDir.split("/").at(-1);
// Copies of the test tree live under .agtx/ (outside the source fingerprint) so that Node resolves the execution root's
// node_modules from them; never beside the live specs. They are copied back to the worktree's .agtx/ at the end (`kept`).
const TREES = join(".agtx/held-operation-probe-trees", invocation);
const kept = join(root, TREES);
// Revision 28 (R27-N2, C1): a linked installation root is refused before anything else (even the source fingerprint, which would read
// the link as a file): nothing is fingerprinted, copied, relocated or prepared; the refusal and a failed completion record are written.
const rootRefusal = needsTarget ? installationRootProblems(root) : [];
if (rootRefusal.length) {
  const why = `This run's execution cannot be prepared (nothing is admitted or built): ${rootRefusal.join("; ")}`;
  json(join(runDir, "applicability-error.json"), {
    when: "preparing the execution",
    error: rootRefusal.join("; "),
  });
  writeFileSync(
    join(runDir, "completion.json"),
    canonical({
      schema: COMPLETION_SCHEMA,
      invocation,
      stage,
      check_only: checkOnly,
      browsers,
      passed: false,
      reasons: [`failed: ${why}`],
      processes_closed: true,
      policy: EXECUTION_POLICY,
      policy_sha256: null,
      source_sha256: null,
      source_after_sha256: null,
      applicability_sha256: null,
      applicability_after_sha256: null,
      applicability_after: null,
      snapshot_sha256: null,
      summary_sha256: null,
      parts: {},
      at: new Date().toISOString(),
    }),
    { flag: "wx" },
  );
  console.error(why);
  process.exit(1);
}
const before = fingerprint(root);
json(join(runDir, "inputs.json"), before);
// This invocation's source fingerprint, as every one of its bundles records it.
const sourceBytes = readFileSync(join(runDir, "inputs.json"));
console.log(`Evidence: ${runDir}`);
/** The execution snapshot's record (revision 27; schema /2 in revision 28), rewritten after every step so an interrupted run still shows how far it got. */
const snapshot = snapshotJournal(root, needsTarget);
const saveSnapshot = () => json(join(runDir, "snapshot.json"), snapshot);
// The run's execution (revision 28): its snapshot, private runtime, frozen environment, launcher, seals and guarded trees.
const ex = newExecution({
  journal: snapshot,
  save: saveSnapshot,
  afterGuard: (what, n) => barrierSync(`guarded-${n}`, what),
});
/** The execution root every child runs from (the snapshot once prepared) and the copy trees' parent inside it. */
const execRoot = () => ex.root ?? root;
const trees = () => join(execRoot(), TREES);
// Every child gets the execution's frozen environment, never the controller's (revision 28); a child before preparation is refused.
const proc = processes(execRoot, {
  env: () => {
    if (!ex.env) throw new Error("no prepared execution: nothing is started");
    return ex.env;
  },
});
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = { controls: [], negatives: [], mutants: [] };
let fatal = null;
let preflight = false;
let interrupted = false;
let prerequisite = null;
// This run's own runtime applicability (revision 26): collected before admission whenever anything may be admitted or built.
let target = null;
let targetBytes = null;
let targetSha = null;
// A qualification seam (revision 27; design assessment Q3, Q6): with ATLAS_HELD_OPERATION_BARRIER=<dir>, the run stops at each named
// boundary, writing <dir>/<point>.reached (the snapshot and runtime roots and the runner's pid, as JSON) and waiting for <dir>/<point>.go (10 minutes at most).
// Points: `runtime` (revision 28: the private runtime sealed, pnpm not yet prepared), `sealed` (sealed, not yet measured), `collected`
// (revision 28: measured, not yet admitted), `admitted` (admission written, before the first build), `built` (revision 28: the control
// build guarded, before the first preview), `end` (after the last child and the final collection, before the final check) and
// `guarded-<n>` (revision 28: after the n-th launch's guard passed, before its child is spawned; its `.reached` also names the launch).
// It changes timing only and is recorded in snapshot.json; without it nothing waits.
const barrierDir = process.env.ATLAS_HELD_OPERATION_BARRIER || null;
snapshot.barrier = barrierDir;
/** The same seam, synchronously (revision 28): `guarded-<n>` stops between the n-th launch's guard and its spawn (H6). */
function barrierSync(point, what) {
  if (!barrierDir) return;
  writeFileSync(
    join(barrierDir, `${point}.reached`),
    JSON.stringify({
      snapshot: ex.root,
      runtime: ex.runtime,
      what,
      pid: process.pid,
    }),
  );
  const deadline = Date.now() + 600_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(barrierDir, `${point}.go`))) {
    if (Date.now() > deadline)
      throw new Error(`the ${point} barrier was never released`);
    Atomics.wait(wait, 0, 0, 50);
  }
}
async function barrier(point) {
  if (!barrierDir) return;
  writeFileSync(
    join(barrierDir, `${point}.reached`),
    JSON.stringify({
      snapshot: ex.root,
      runtime: ex.runtime,
      pid: process.pid,
    }),
  );
  const deadline = Date.now() + 600_000;
  while (!existsSync(join(barrierDir, `${point}.go`))) {
    if (Date.now() > deadline)
      throw new Error(`the ${point} barrier was never released`);
    await sleep(50);
  }
}
/**
 * Every child of the run (revision 28): started only after the execution's guard has found every seal unchanged (`what` names it in the
 * record), by the private launcher's absolute path, in the frozen environment. There is no other way to start one.
 */
const child = {
  run(what, argv, env) {
    return proc.run(ex.guarded(what), argv, env);
  },
  start(what, argv, env) {
    return proc.start(ex.guarded(what), argv, env);
  },
};
/** The installed entries a producing run's inventory and this run's differ in (diagnostics; never an admission input). */
function installationDiagnostics(dir, record) {
  if (!dir || !record?.installation?.sha256 || !target?.installation)
    return null;
  if (record.installation.sha256 === target.installation.sha256)
    return { same: true };
  const mine = recordAt(join(runDir, "installation-inventory.json"))?.record;
  const theirs = recordAt(join(dir, "installation-inventory.json"))?.record;
  if (
    !Array.isArray(theirs) ||
    inventoryDigest(theirs) !== record.installation.sha256
  )
    return {
      same: false,
      differences:
        "the producing run's inventory is missing or is not its record's",
    };
  return { same: false, differences: inventoryDifferences(theirs, mine) };
}
/** A run's recorded applicability file: its bytes' digest and the record, or null when it is absent or unreadable (unknown). */
function recordAt(path) {
  try {
    const bytes = readFileSync(path);
    return {
      sha256: sha256(bytes),
      record: JSON.parse(bytes.toString("utf8")),
    };
  } catch {
    return null;
  }
}

/** The file a preview serves to prove it serves this build (its readiness token). */
const MARKER = "atlas-validation-owner.txt";
const tokenOf = (buildDir) => Buffer.from(buildDir).toString("base64url");
async function build(mutantDir, buildDir, log) {
  const result = await child.run(
    `the build into ${buildDir}`,
    [
      "exec",
      "vite",
      "build",
      "--mode",
      "fixture",
      "--config",
      "vite.mutant.config.ts",
      // Revision 29 (the execution policy): the config is loaded in memory, never from a generated module on disk.
      ...VITE_CONFIG_LOADER,
    ],
    { ATLAS_MUTANT_DIR: mutantDir ?? "", ATLAS_MUTANT_OUT_DIR: buildDir },
  );
  writeFileSync(log, result.output);
  if (result.code) throw new Error(`Build failed: ${log}`);
  // Revision 28 (C4, H9): the completed build is what every preview serves; it is sealed and guarded from now to the end.
  writeFileSync(join(buildDir, MARKER), tokenOf(buildDir));
  ex.guard(`build ${relative(runDir, buildDir)}`, buildDir, { outside: true });
}
async function withPreview(buildDir, action) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // The build wrote and sealed its own marker (revision 28): nothing is written into a guarded build.
  const token = tokenOf(buildDir);
  const marker = MARKER;
  const server = child.start(
    `the preview of ${buildDir}`,
    [
      "exec",
      "vite",
      "preview",
      "--mode",
      "fixture",
      "--config",
      "vite.mutant.config.ts",
      // Revision 29 (the execution policy): the config is loaded in memory, never from a generated module on disk.
      ...VITE_CONFIG_LOADER,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { ATLAS_MUTANT_OUT_DIR: buildDir, ATLAS_MUTANT_DIR: "" },
  );
  try {
    let ready = false;
    for (let i = 0; i < 150 && !proc.cancelled; i++) {
      if (server.child.exitCode !== null || server.child.signalCode !== null)
        throw new Error(`Preview exited: ${server.output}`);
      try {
        const answer = await fetch(`${url}/${marker}`, {
          signal: AbortSignal.timeout(500),
        });
        if ((await answer.text()) === token) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await sleep(100);
    }
    if (!ready) throw new Error("Preview readiness failed");
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
/** An unmutated (or patched) copy of what Playwright loads: the config and tests/e2e (of the execution snapshot, revision 27). */
function copyTree(name, patches = []) {
  const tree = join(trees(), name);
  mkdirSync(tree, { recursive: true });
  cpSync(join(execRoot(), "tests/e2e"), join(tree, "tests/e2e"), {
    recursive: true,
  });
  cpSync(
    join(execRoot(), "playwright.config.ts"),
    join(tree, "playwright.config.ts"),
  );
  // The snapshot's source files are sealed read-only; the copy is this run's own scratch tree, so its files get back the owner write
  // permission the live files have (a negative control's hook and a helper mutant are written into it). Contents are untouched.
  for (const e of readdirSync(tree, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const full = join(e.parentPath ?? e.path, e.name);
      chmodSync(full, statSync(full).mode | 0o200);
    }
  for (const patch of patches)
    writeFileSync(join(tree, patch.file), patch.text);
  // Revision 28 (C4, H9): once its patches are installed the tree is what Playwright reads: sealed and guarded to the end.
  ex.guard(`copy tree ${name}`, tree);
  return tree;
}
/**
 * Runs the named probes from `cwd` in every selected engine (one worker, no retries) and returns the normalised report: every case with
 * its full evidence (scripts/validation/held-operation-qualification.mjs). A report that cannot be read is an error of the run.
 * With `part` (revision 25), the execution record is written into that bundle directory as soon as Playwright closes, before anything
 * is judged: the exit and signal observed, its own digest of the report, the argv and the selection environment.
 */
async function probes(url, cwd, ids, directory, env = {}, part = null) {
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, "report.json");
  const argv = probeArgv(
    join(cwd, "playwright.config.ts"),
    browsers,
    ids,
    join(directory, "test-results"),
  );
  const selection = { ATLAS_E2E_PROBES: "held-operation", ...env };
  const result = await child.run(`Playwright for ${directory}`, argv, {
    ...selection,
    ATLAS_FIXTURE_URL: url,
    ATLAS_E2E_BROWSERS: "all",
    ATLAS_EVIDENCE_DIR: join(directory, "evidence"),
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
  });
  writeFileSync(join(directory, "playwright.log"), result.output);
  // This invocation's own report (its directory is new): a missing or unreadable one fails the run, after its execution is recorded.
  let report = null;
  try {
    report = readFileSync(reportPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (part)
    writeArtefact(
      part,
      "execution.json",
      `${JSON.stringify(
        {
          exit: result.code,
          signal: result.signal ?? null,
          report_sha256: report ? sha256(report) : null,
          argv,
          env: Object.fromEntries(
            Object.entries(selection).filter(([k]) =>
              SELECTION_ENV.includes(k),
            ),
          ),
          closed_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  if (!report) throw new Error(`No report: ${reportPath}`);
  // The exact spec text that ran (the tree's own copy) bounds each test's lines.
  const specText = readFileSync(join(cwd, PROBE_SPEC), "utf8");
  const run = normalise(
    JSON.parse(report.toString("utf8")),
    browsers,
    result.code,
    specText,
    result.signal ?? null,
  );
  run.report_sha256 = sha256(report);
  run.spec_sha256 = sha256(specText);
  return run;
}
/**
 * Completes a part's bundle and publishes it (revision 25): the source fingerprint, the spec that ran and the installed files as they are
 * in `cwd` now, the copied tree's inventories, the live snapshots taken at preparation (`bases`), then the manifest, last. Returns the
 * bundle re-read from disk: the only thing the part is judged from.
 */
function publishPart(
  part,
  kind,
  name,
  cwd,
  report,
  { inventory, bases = [], installed = [] } = {},
) {
  const artefacts = {
    report,
    execution: "execution.json",
    source: "bundle/source.json",
    spec: `bundle/ran/${PROBE_SPEC}`,
    applicability: "bundle/applicability.json",
  };
  writeArtefact(part, artefacts.source, sourceBytes);
  writeArtefact(part, artefacts.applicability, targetBytes);
  writeArtefact(part, artefacts.spec, readFileSync(join(cwd, PROBE_SPEC)));
  if (inventory) {
    artefacts.inventory = "bundle/inventory.json";
    writeArtefact(
      part,
      artefacts.inventory,
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
  }
  for (const { file, bytes } of bases) {
    artefacts[`base:${file}`] = `bundle/base/${file}`;
    writeArtefact(part, artefacts[`base:${file}`], bytes);
  }
  for (const file of installed) {
    artefacts[`installed:${file}`] = `bundle/installed/${file}`;
    writeArtefact(
      part,
      artefacts[`installed:${file}`],
      readFileSync(join(cwd, file)),
    );
  }
  publishBundle(
    part,
    {
      kind,
      part: name,
      contract:
        kind === "negative" ? NEGATIVE_CONTRACT_VERSION : CONTRACT_VERSION,
      invocation,
      source_sha256: before.sha256,
    },
    artefacts,
  );
  return readBundle(join(part, MANIFEST));
}
/** A judged part's record: the judgement with the normalised cases' error lists kept beside it for the reviewer. */
const recorded = (name, run, judgement) => ({
  name,
  exit: run.exit,
  signal: run.signal,
  report_sha256: run.report_sha256,
  complete: run.complete,
  ...judgement,
  errors: run.cases.map((c) => ({
    engine: c.engine,
    id: c.id,
    status: c.status,
    errors: c.errors.map((e) => ({
      kind: e.kind,
      first: e.first,
      location: e.location,
    })),
  })),
});

try {
  // Every contract is total and every patch applies to the current text before anything is built.
  const contractProblems = validateContracts();
  const patches = [];
  const failures = [];
  for (const mutant of MUTANTS) {
    try {
      const base = readFileSync(join(root, mutant.file));
      const text = base.toString("utf8");
      const patched = mutant.patch(text);
      if (patched === text) throw new Error("patch changed nothing");
      patches.push({ mutant, text: patched, base });
    } catch (error) {
      failures.push({ id: mutant.id, patch_failed: String(error.message) });
    }
  }
  // The live spec's bytes, snapshotted now: a negative control's bundle binds its copy to them and them to the source fingerprint.
  const specBytes = readFileSync(join(root, PROBE_SPEC));
  const spec = specBytes.toString("utf8");
  json(join(runDir, "preflight.json"), {
    contract: CONTRACT_VERSION,
    stage,
    controls: stage === "negatives" ? [] : controlIds,
    negatives: negatives.map((n) => n.id),
    selected: selected.map((m) => m.id),
    contract_problems: contractProblems,
    failures,
  });
  if (contractProblems.length)
    throw new Error(
      `${contractProblems.length} contract problem(s): ${contractProblems[0]}`,
    );
  if (failures.length)
    throw new Error(`${failures.length} probe mutation(s) failed preflight`);
  preflight = true;
  if (needsTarget) {
    // The shared lifecycle (revision 28): the source's installation root and state checked, the snapshot copied (independent) and the
    // private runtime created and sealed, then relocated, prepared by pnpm through the guard, sealed, the source's state compared.
    try {
      prepareExecution(ex, {
        source: root,
        files: before.files,
        browsers,
        env: process.env,
        trees: TREES,
        barrier: (point) => barrierSync(point),
      });
    } catch (error) {
      saveSnapshot();
      json(join(runDir, "applicability-error.json"), {
        when: "preparing the execution",
        error: String(error.message ?? error),
      });
      throw new Error(
        `This run's execution cannot be prepared (nothing is admitted or built): ${error.message}`,
      );
    }
    const keep = {};
    try {
      target = collectApplicability({
        root: execRoot(),
        source: root,
        origins: [trees()],
        browsers,
        execution: ex,
        keep,
      });
      // The collection itself ran pnpm in the sealed snapshot: it must have changed nothing.
      ex.check("after the applicability was collected");
    } catch (error) {
      json(join(runDir, "applicability-error.json"), {
        when: "before admission",
        error: String(error.message ?? error),
      });
      throw new Error(
        `This run's runtime applicability cannot be established (nothing is admitted or built): ${error.message}`,
      );
    }
    targetBytes = canonical(target);
    targetSha = sha256(targetBytes);
    writeFileSync(join(runDir, "applicability.json"), targetBytes, {
      flag: "wx",
    });
    // The inventory the record's installation digest covers (diagnostics; a reader checks it against that digest, never trusts it).
    json(join(runDir, "installation-inventory.json"), keep.inventory);
    snapshot.installation_sha256 = target.installation.sha256;
    snapshot.runtime_sha256 = target.runtime.sha256;
    saveSnapshot();
    await barrier("collected");
  }
  if (controlsEvidence) {
    // The prerequisite controls (design assessment C3): one passed --stage controls run of this very source and these engines.
    const runs = existsSync(join(controlsEvidence, "runs"))
      ? readdirSync(join(controlsEvidence, "runs"))
      : [];
    const problems = [];
    let evidence = null;
    if (runs.length !== 1)
      problems.push(
        `${controlsEvidence} holds ${runs.length} run(s), not exactly one`,
      );
    else {
      const dir = join(controlsEvidence, "runs", runs[0]);
      try {
        evidence = {
          path: dir,
          invocation: runs[0],
          // Both controls' raw evidence, re-verified and re-judged now: the summary is only a derived view (revision 25, C5).
          controls: ["control", "copy-control"].map((name) =>
            judgeControlEvidence(readBundle(join(dir, name, MANIFEST)), {
              part: name,
              invocation: runs[0],
              source: before.sha256,
              target,
            }),
          ),
          // The producing run's own records of its runtime, before and after it ran (revision 26): the raw files, never its summary.
          applicability: {
            before: recordAt(join(dir, "applicability.json")),
            after: recordAt(join(dir, "applicability-after.json")),
          },
          // What it executed from (revision 27): its execution snapshot's record, raw; absent for a revision 26 or earlier run.
          snapshot: recordAt(join(dir, "snapshot.json"))?.record ?? null,
          // Whether it COMPLETED (revision 28): its terminal completion record and the files it binds, each read once.
          completion: readRunCompletion(dir),
          summary: JSON.parse(
            readFileSync(join(dir, "probe-results.json"), "utf8"),
          ).summary,
          source: JSON.parse(readFileSync(join(dir, "inputs.json"), "utf8"))
            .sha256,
          after: JSON.parse(
            readFileSync(join(dir, "inputs-after.json"), "utf8"),
          ).sha256,
        };
        const inputs = JSON.parse(
          readFileSync(join(dir, "inputs.json"), "utf8"),
        );
        evidence.inputs_runtime = {
          node: inputs.node,
          platform: inputs.platform,
          arch: inputs.arch,
        };
        if (evidence.after !== evidence.source)
          problems.push("its inputs changed during the run");
      } catch (error) {
        problems.push(`unreadable controls evidence: ${error.message}`);
        // Revision 28: an interrupted run leaves no summary; say whether it completed at all (its terminal completion record).
        problems.push(
          ...completionProblems(readRunCompletion(dir), {
            invocation: runs[0],
          }).map((p) => `the controls run: ${p}`),
        );
        evidence = null;
      }
    }
    if (evidence)
      problems.push(
        ...prerequisiteProblems(evidence, {
          source: before.sha256,
          browsers,
          probes: [...new Set(negatives.flatMap((n) => n.probes))],
          target,
        }),
      );
    prerequisite = {
      evidence: evidence?.path ?? controlsEvidence,
      invocation: evidence?.invocation ?? null,
      // What this consumer compared (revision 26): its own record, the producing run's before and after, and each field's decision.
      applicability: {
        target_sha256: targetSha,
        before_sha256: evidence?.applicability?.before?.sha256 ?? null,
        after_sha256: evidence?.applicability?.after?.sha256 ?? null,
        comparison: compareApplicability(
          target,
          evidence?.applicability?.before?.record,
        ),
      },
      // Which installed entries differ (revision 27, diagnostics only): the producer's saved inventory, checked against its record's
      // digest, beside this consumer's.
      installation: installationDiagnostics(
        evidence?.path,
        evidence?.applicability?.before?.record,
      ),
      controls: (evidence?.controls ?? []).map((c) => ({
        name: c.name,
        ok: c.ok,
        healthy: c.healthy,
        applicability: c.applicability?.decision,
        evidence: c.evidence,
        problems: c.problems.slice(0, 20),
      })),
      problems,
    };
    json(join(runDir, "prerequisite.json"), prerequisite);
    if (problems.length)
      throw new Error(`Prerequisite controls not met: ${problems[0]}`);
  }
  if (needsTarget)
    // The build boundary: everything before it has admitted this run. Its absence after a run is the observable refusal.
    json(join(runDir, "admission.json"), {
      admitted: true,
      stage,
      check_only: checkOnly,
      prerequisite: Boolean(controlsEvidence),
      applicability_sha256: targetSha,
      installation_sha256: target?.installation?.sha256 ?? null,
      runtime_sha256: target?.runtime?.sha256 ?? null,
      snapshot: ex.root,
      runtime: ex.runtime,
      snapshot_sealed_sha256: snapshot.sealed_sha256,
      runtime_sealed_sha256: snapshot.runtime_sealed_sha256,
      at: new Date().toISOString(),
    });
  if (needsTarget) await barrier("admitted");
  if (!checkOnly) {
    const controlBuild = join(runDir, "control-build");
    await build(null, controlBuild, join(runDir, "control-build.log"));
    await barrier("built");
    if (stage !== "negatives") {
      for (const [name, cwd] of [
        ["control", execRoot()],
        ["copy-control", copyTree("copy-control")],
      ]) {
        const part = join(runDir, name);
        const inventory =
          name === "copy-control" ? { before: inventoryOf(cwd) } : undefined;
        const run = await withPreview(controlBuild, (url) =>
          probes(url, cwd, controlIds, part, {}, part),
        );
        if (inventory) inventory.after = inventoryOf(cwd);
        const bundle = publishPart(part, "control", name, cwd, "report.json", {
          inventory,
        });
        const judged = recorded(
          name,
          run,
          judgeControlEvidence(bundle, {
            part: name,
            invocation,
            source: before.sha256,
            target,
          }),
        );
        json(join(runDir, name, "judgement.json"), judged);
        record.controls.push(judged);
        console.log(`${name} ${judged.ok ? "healthy" : "NOT HEALTHY"}`);
        if (!judged.ok) throw new Error(`Probe ${name} is not healthy`);
      }
    }
    for (const nc of negatives) {
      const directory = join(runDir, nc.id);
      const faulted = { file: PROBE_SPEC, text: `${spec}${FAULT_HOOK}` };
      const mutantPatch = nc.mutant
        ? patches.find((p) => p.mutant.id === nc.mutant)
        : null;
      const installed = mutantPatch
        ? [{ file: mutantPatch.mutant.file, text: mutantPatch.text }]
        : [];
      if (installed.some((p) => p.file === HARNESS))
        throw new Error(
          `${nc.id}: a negative control installs helper or ledger mutants only`,
        );
      const tree = copyTree(nc.id, [faulted, ...installed]);
      const env = {
        ATLAS_PROBE_FAULT: nc.fault,
        ATLAS_PROBE_FAULT_IDS: nc.probes.join(","),
      };
      mkdirSync(directory, { recursive: true });
      const inventory = { before: inventoryOf(tree) };
      const run = await withPreview(controlBuild, (url) =>
        probes(
          url,
          tree,
          nc.probes,
          join(directory, "browser"),
          env,
          directory,
        ),
      );
      inventory.after = inventoryOf(tree);
      const bundle = publishPart(
        directory,
        "negative",
        nc.id,
        tree,
        "browser/report.json",
        {
          inventory,
          bases: [
            { file: PROBE_SPEC, bytes: specBytes },
            ...(mutantPatch
              ? [{ file: mutantPatch.mutant.file, bytes: mutantPatch.base }]
              : []),
          ],
          installed: installed.map((p) => p.file),
        },
      );
      // Judged only from the bundle as re-read from disk, bound to this invocation and source (exactly as a replay judges it).
      const judged = recorded(
        nc.id,
        run,
        qualifyNegative(nc, bundle, {
          invocation,
          source: before.sha256,
          target,
        }),
      );
      json(join(directory, "result.json"), {
        title: nc.title,
        tree,
        ...judged,
      });
      record.negatives.push(judged);
      console.log(
        `${judged.qualified ? "qualified" : "NOT QUALIFIED"} ${nc.id} (evidence ${judged.evidence?.status}, integrity ${judged.integrity.valid}, scenario ${judged.scenario.valid}, ${nc.contract} ${judged.classifier.verdict})`,
      );
      if (!judged.qualified)
        throw new Error(
          `Negative control not qualified: ${nc.id}: ${judged.problems[0]}`,
        );
    }
    for (const { mutant, text } of patches.filter((p) =>
      selected.includes(p.mutant),
    )) {
      const directory = join(runDir, mutant.id);
      let run;
      if (mutant.file === HARNESS) {
        const source = join(directory, "source");
        mkdirSync(dirname(join(source, mutant.file)), { recursive: true });
        writeFileSync(join(source, mutant.file), text);
        // Revision 28: the mutant's build input is guarded from before its build to the end.
        ex.guard(`mutant source ${mutant.id}`, source, { outside: true });
        const buildDir = join(directory, "build");
        await build(source, buildDir, join(directory, "build.log"));
        run = await withPreview(buildDir, (url) =>
          probes(url, execRoot(), mutant.probes, join(directory, "browser")),
        );
      } else {
        const tree = copyTree(mutant.id, [{ file: mutant.file, text }]);
        run = await withPreview(controlBuild, (url) =>
          probes(url, tree, mutant.probes, join(directory, "browser")),
        );
      }
      const judged = recorded(
        mutant.id,
        run,
        judgeMutant(mutant.id, run, browsers),
      );
      json(join(directory, "result.json"), {
        title: mutant.title,
        file: mutant.file,
        ...judged,
      });
      record.mutants.push(judged);
      console.log(`${judged.verdict} ${mutant.id}`);
      if (judged.verdict !== "caught")
        throw new Error(`Probe mutant ${judged.verdict}: ${mutant.id}`);
    }
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
// The runtime again, at the end (revision 26): compared with the record this run was admitted and judged under. Revision 27: in the
// same snapshot, after its last check; then the snapshot's stat inventory once more, the copy trees kept, and the snapshot removed.
let applicabilityAfter = null;
let afterSha = null;
if (target) {
  try {
    const keep = {};
    const again = canonical(
      collectApplicability({
        root: execRoot(),
        source: root,
        origins: [trees()],
        browsers,
        execution: ex,
        keep,
      }),
    );
    writeFileSync(join(runDir, "applicability-after.json"), again, {
      flag: "wx",
    });
    afterSha = sha256(again);
    json(join(runDir, "installation-inventory-after.json"), keep.inventory);
    applicabilityAfter = compareApplicability(target, JSON.parse(again));
  } catch (error) {
    json(join(runDir, "applicability-error.json"), {
      when: "after the run",
      error: String(error.message ?? error),
    });
  }
}
if (needsTarget) {
  let endBarrier = null;
  try {
    await barrier("end");
  } catch (error) {
    endBarrier = String(error.message);
  }
  // The final check of every seal, the copy trees kept (unsealed first), guarded builds unsealed, the snapshot and runtime removed.
  finishExecution(ex, {
    check: !endBarrier,
    beforeRemoval: () => {
      try {
        if (ex.root && existsSync(trees())) {
          unsealTree(trees());
          cpSync(trees(), kept, { recursive: true });
        }
      } catch (error) {
        snapshot.kept_error = String(error.message);
      }
    },
  });
  if (endBarrier) snapshot.end_error = endBarrier;
  snapshot.unchanged = journalUnchanged(snapshot);
  saveSnapshot();
}
const checkReasons = checkOnly
  ? [
      ...(preflight ? [] : ["preflight did not pass"]),
      ...(fatal ? [`failed: ${fatal.split("\n")[0]}`] : []),
      ...(needsTarget
        ? snapshotProblems(snapshot, target).map((p) => `this run: ${p}`)
        : []),
      ...(interrupted ? ["interrupted"] : []),
      ...(unchanged ? [] : ["the source changed during the run"]),
      ...(needsTarget && applicabilityAfter?.decision !== "applicable"
        ? applicabilityAfter
          ? applicabilityReasons(applicabilityAfter).map(
              (r) => `the runtime changed during the run: ${r}`,
            )
          : ["the runtime after the run is unknown (not collected again)"]
        : []),
    ]
  : [];
const outcome = checkOnly
  ? { passed: checkReasons.length === 0, reasons: checkReasons }
  : campaignOutcome({
      preflight,
      fatal,
      interrupted,
      sourceUnchanged: unchanged,
      applicability: {
        target_sha256: targetSha,
        record: target,
        after: applicabilityAfter,
      },
      snapshot,
      prerequisite: controlsEvidence
        ? (prerequisite ?? { problems: ["the prerequisite was never checked"] })
        : null,
      planned: {
        invocation,
        applicability: targetSha,
        controls: stage === "negatives" ? [] : ["control", "copy-control"],
        negatives: negatives.map((n) => n.id),
        mutants: selected.map((m) => m.id),
      },
      controls: record.controls,
      negatives: record.negatives,
      mutants: record.mutants,
    });
const summary = {
  layer:
    "held-operation owner and fixture hold seam (WEB-08d r21-r25): real engines, probe controls, reporter shapes, negative controls qualified by their own scenarios over verified evidence bundles, helper/fixture mutants judged by versioned contracts",
  contract: CONTRACT_VERSION,
  negative_contract: NEGATIVE_CONTRACT_VERSION,
  evidence_schema: EVIDENCE_SCHEMA,
  invocation,
  browsers,
  check_only: checkOnly,
  stage,
  preflight_pass: preflight,
  control_probes: stage === "negatives" ? [] : controlIds,
  controls: record.controls.map((c) => ({
    name: c.name,
    ok: c.ok,
    healthy: c.healthy,
    applicability: c.applicability?.decision,
    evidence: c.evidence?.status,
    manifest_sha256: c.evidence?.manifest_sha256,
  })),
  prerequisite,
  negatives: record.negatives.map((n) => ({
    id: n.negative_control,
    outcome: n.outcome,
    qualified: n.qualified,
    integrity: n.integrity.valid,
    scenario: n.scenario.valid,
    classifier: n.classifier.verdict,
    applicability: n.applicability?.decision,
    evidence: n.evidence?.status,
    manifest_sha256: n.evidence?.manifest_sha256,
  })),
  selected: selected.map((m) => m.id),
  run: record.mutants.length,
  verdicts: Object.fromEntries(
    record.mutants.map((m) => [m.mutant, m.verdict]),
  ),
  caught: record.mutants.filter((m) => m.verdict === "caught").length,
  source_unchanged: unchanged,
  applicability_sha256: targetSha,
  applicability_after: applicabilityAfter?.decision ?? null,
  // Revision 27: the execution snapshot every child ran from, and whether it stayed exactly as sealed.
  snapshot: needsTarget
    ? {
        root: snapshot.root,
        runtime: snapshot.runtime_root,
        sealed_sha256: snapshot.sealed_sha256,
        runtime_sealed_sha256: snapshot.runtime_sealed_sha256,
        checks: snapshot.checks.length + snapshot.runtime_checks.length,
        guarded_trees: Object.keys(snapshot.trees).length,
        unchanged: snapshot.unchanged,
        removed: snapshot.removed && snapshot.runtime_removed,
      }
    : null,
  installation_sha256: target?.installation?.sha256 ?? null,
  runtime_sha256: target?.runtime?.sha256 ?? null,
  trees: needsTarget ? kept : trees(),
  passed: outcome.passed,
  reasons: outcome.reasons,
  fatal,
  elapsed_ms: Date.now() - started,
  at: new Date().toISOString(),
  evidence: runDir,
};
json(join(runDir, "probe-results.json"), { summary, ...record });
// The TERMINAL completion record (revision 28, C5): written exclusively and last, once every process has closed, the final applicability
// and every seal were checked, the source was compared and the owned directories were removed. It binds the bytes of every record a
// reader needs and each published part's manifest; a run without it (interrupted, still running) is never admitted.
const digestOf = (name) => {
  try {
    return sha256(readFileSync(join(runDir, name)));
  } catch {
    return null;
  }
};
writeFileSync(
  join(runDir, "completion.json"),
  canonical({
    schema: COMPLETION_SCHEMA,
    invocation,
    stage,
    check_only: checkOnly,
    browsers,
    passed: outcome.passed,
    reasons: outcome.reasons,
    processes_closed: true,
    // Revision 29: the execution policy every child ran under, as this run's applicability record and snapshot record name it.
    policy: EXECUTION_POLICY,
    policy_sha256: target?.runtime?.policy_sha256 ?? null,
    source_sha256: before.sha256,
    source_after_sha256: after.sha256,
    applicability_sha256: targetSha,
    applicability_after_sha256: afterSha,
    applicability_after: applicabilityAfter?.decision ?? null,
    snapshot_sha256: digestOf("snapshot.json"),
    summary_sha256: digestOf("probe-results.json"),
    parts: Object.fromEntries(
      [
        ...record.controls.map((c) => [c.name, c]),
        ...record.negatives.map((n) => [n.negative_control, n]),
      ].map(([name, p]) => [name, p.evidence?.manifest_sha256 ?? null]),
    ),
    at: new Date().toISOString(),
  }),
  { flag: "wx" },
);
console.log(JSON.stringify(summary));
process.exitCode = outcome.passed ? 0 : 1;

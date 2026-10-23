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
// Usage: node scripts/validation/held-operation-probes.mjs [--check] [--stage all|controls|negatives]
//          [--probes P01,S7,...] [--only HM10,...] [--browsers chromium,firefox,webkit]
//          [--controls-evidence <the --out of a --stage controls run>] --out <dir>
//   --check      preflight only: every contract is total and every patch applies once; nothing is built.
//   --stage      all (default): controls, negative controls, then mutants; controls: the live and copy controls;
//                negatives: the negative controls alone (with --controls-evidence).
//   --probes     restricts the controls of --stage controls to these probes (exact case titles still required).
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../integration/free-port.mjs";
import {
  CONTRACT_VERSION,
  campaignOutcome,
  FAULT_HOOK,
  HARNESS,
  judgeControl,
  judgeMutant,
  judgeNegative,
  MUTANTS,
  mutantOf,
  NEGATIVE_CONTRACT_VERSION,
  NEGATIVE_CONTROLS,
  normalise,
  PROBE_IDS,
  PROBE_SPEC,
  prerequisiteProblems,
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
// Copies of the test tree live under .agtx/ (ignored, outside the source fingerprint) so that Node resolves the
// worktree's node_modules from them; never beside the live specs.
const trees = join(
  root,
  ".agtx/held-operation-probe-trees",
  runDir.split("/").at(-1),
);
const before = fingerprint(root);
json(join(runDir, "inputs.json"), before);
console.log(`Evidence: ${runDir}`);
const proc = processes(root);
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const record = { controls: [], negatives: [], mutants: [] };
let fatal = null;
let preflight = false;
let interrupted = false;
let prerequisite = null;

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
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
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
/** Every file under `dir` (relative paths, sorted); a link or anything but a regular file is reported as such. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => {
      const rel = join(e.parentPath ?? e.path, e.name).slice(dir.length + 1);
      return e.isFile() ? rel : `${rel} (not a regular file)`;
    })
    .sort();
}
/**
 * Why a copied tree is not exactly what Playwright should load: the live config and tests/e2e, file for file, except the patched files,
 * each with exactly its patch's text (design assessment C3: checked before and after the run).
 */
function copyProblems(tree, patches) {
  const expected = new Map();
  for (const rel of filesUnder(join(root, "tests/e2e")))
    expected.set(
      join("tests/e2e", rel),
      sha256(readFileSync(join(root, "tests/e2e", rel))),
    );
  expected.set(
    "playwright.config.ts",
    sha256(readFileSync(join(root, "playwright.config.ts"))),
  );
  for (const patch of patches) expected.set(patch.file, sha256(patch.text));
  const actual = new Map();
  for (const rel of filesUnder(join(tree, "tests/e2e")))
    actual.set(
      join("tests/e2e", rel),
      rel.endsWith(")")
        ? null
        : sha256(readFileSync(join(tree, "tests/e2e", rel))),
    );
  if (existsSync(join(tree, "playwright.config.ts")))
    actual.set(
      "playwright.config.ts",
      sha256(readFileSync(join(tree, "playwright.config.ts"))),
    );
  const problems = [];
  for (const file of new Set([...expected.keys(), ...actual.keys()]))
    if (!expected.has(file)) problems.push(`${file}: not in the live tree`);
    else if (!actual.has(file)) problems.push(`${file}: missing from the copy`);
    else if (expected.get(file) !== actual.get(file))
      problems.push(`${file}: differs from what was copied`);
  return problems;
}
/** An unmutated (or patched) copy of what Playwright loads: the config and tests/e2e. */
function copyTree(name, patches = []) {
  const tree = join(trees, name);
  mkdirSync(tree, { recursive: true });
  cpSync(join(root, "tests/e2e"), join(tree, "tests/e2e"), {
    recursive: true,
  });
  cpSync(
    join(root, "playwright.config.ts"),
    join(tree, "playwright.config.ts"),
  );
  for (const patch of patches)
    writeFileSync(join(tree, patch.file), patch.text);
  return tree;
}
/**
 * Runs the named probes from `cwd` in every selected engine (one worker, no retries) and returns the normalised report: every case with
 * its full evidence (scripts/validation/held-operation-qualification.mjs). A report that cannot be read is an error of the run.
 */
async function probes(url, cwd, ids, directory, env = {}) {
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, "report.json");
  // A probe's id begins its title ("P03 ...", "S1 shape: ..."), and no other title of the file has it.
  const grep = `(?:^|\\s)(?:${ids.join("|")})\\s`;
  const result = await proc.run(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      join(cwd, "playwright.config.ts"),
      ...browsers.map((b) => `--project=fixture-${b}`),
      "-g",
      grep,
      "--workers=1",
      "--retries=0",
      "--reporter=json",
      `--output=${join(directory, "test-results")}`,
    ],
    {
      ATLAS_E2E_PROBES: "held-operation",
      ATLAS_FIXTURE_URL: url,
      ATLAS_E2E_BROWSERS: "all",
      ATLAS_EVIDENCE_DIR: join(directory, "evidence"),
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      ...env,
    },
  );
  writeFileSync(join(directory, "playwright.log"), result.output);
  // The exact spec text that ran (the tree's own copy) bounds each test's lines.
  const specText = readFileSync(join(cwd, PROBE_SPEC), "utf8");
  // This invocation's own report (its directory is new): a missing or unreadable one fails the run.
  const reportText = readFileSync(reportPath, "utf8");
  const run = normalise(
    JSON.parse(reportText),
    browsers,
    result.code,
    specText,
    result.signal ?? null,
  );
  run.report_sha256 = sha256(reportText);
  run.spec_sha256 = sha256(specText);
  return run;
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
      const text = readFileSync(join(root, mutant.file), "utf8");
      const patched = mutant.patch(text);
      if (patched === text) throw new Error("patch changed nothing");
      patches.push({ mutant, text: patched });
    } catch (error) {
      failures.push({ id: mutant.id, patch_failed: String(error.message) });
    }
  }
  const spec = readFileSync(join(root, PROBE_SPEC), "utf8");
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
  if (!checkOnly && controlsEvidence) {
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
          summary: JSON.parse(
            readFileSync(join(dir, "probe-results.json"), "utf8"),
          ).summary,
          source: JSON.parse(readFileSync(join(dir, "inputs.json"), "utf8"))
            .sha256,
          after: JSON.parse(
            readFileSync(join(dir, "inputs-after.json"), "utf8"),
          ).sha256,
        };
        if (evidence.after !== evidence.source)
          problems.push("its inputs changed during the run");
      } catch (error) {
        problems.push(`unreadable controls evidence: ${error.message}`);
      }
    }
    if (evidence)
      problems.push(
        ...prerequisiteProblems(evidence, {
          source: before.sha256,
          browsers,
          probes: [...new Set(negatives.flatMap((n) => n.probes))],
        }),
      );
    prerequisite = { evidence: evidence?.path ?? controlsEvidence, problems };
    json(join(runDir, "prerequisite.json"), prerequisite);
    if (problems.length)
      throw new Error(`Prerequisite controls not met: ${problems[0]}`);
  }
  if (!checkOnly) {
    const controlBuild = join(runDir, "control-build");
    await build(null, controlBuild, join(runDir, "control-build.log"));
    if (stage !== "negatives") {
      for (const [name, cwd] of [
        ["control", root],
        ["copy-control", copyTree("copy-control")],
      ]) {
        const run = await withPreview(controlBuild, (url) =>
          probes(url, cwd, controlIds, join(runDir, name)),
        );
        const judged = recorded(
          name,
          run,
          judgeControl(run, controlIds, browsers),
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
      const installed = nc.mutant
        ? [
            {
              file: mutantOf(nc.mutant).file,
              text: patches.find((p) => p.mutant.id === nc.mutant).text,
            },
          ]
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
      const copyBefore = copyProblems(tree, [faulted, ...installed]);
      const run = await withPreview(controlBuild, (url) =>
        probes(url, tree, nc.probes, join(directory, "browser"), env),
      );
      const provenance = {
        negative_control: nc.id,
        fault: env.ATLAS_PROBE_FAULT,
        fault_ids: env.ATLAS_PROBE_FAULT_IDS.split(","),
        installed: nc.mutant ? [nc.mutant] : [],
        live_spec_sha256: sha256(spec),
        hook_sha256: sha256(FAULT_HOOK),
        expected_spec_sha256: sha256(faulted.text),
        copied_spec_sha256: run.spec_sha256,
        installed_sha256: Object.fromEntries(
          installed.map((p) => [p.file, sha256(p.text)]),
        ),
        copy_problems: {
          before: copyBefore,
          after: copyProblems(tree, [faulted, ...installed]),
        },
        tree,
        exit: run.exit,
        signal: run.signal,
        report_sha256: run.report_sha256,
      };
      const judged = recorded(
        nc.id,
        run,
        judgeNegative(nc, run, browsers, provenance),
      );
      json(join(directory, "result.json"), {
        title: nc.title,
        provenance,
        ...judged,
      });
      record.negatives.push(judged);
      console.log(
        `${judged.qualified ? "qualified" : "NOT QUALIFIED"} ${nc.id} (integrity ${judged.integrity.valid}, scenario ${judged.scenario.valid}, ${nc.contract} ${judged.classifier.verdict})`,
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
        const buildDir = join(directory, "build");
        await build(source, buildDir, join(directory, "build.log"));
        run = await withPreview(buildDir, (url) =>
          probes(url, root, mutant.probes, join(directory, "browser")),
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
const outcome = checkOnly
  ? {
      passed: preflight && !fatal && !interrupted && unchanged,
      reasons: [],
    }
  : campaignOutcome({
      preflight,
      fatal,
      interrupted,
      sourceUnchanged: unchanged,
      prerequisite: controlsEvidence
        ? (prerequisite ?? { problems: ["the prerequisite was never checked"] })
        : null,
      planned: {
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
    "held-operation owner and fixture hold seam (WEB-08d r21-r24): real engines, probe controls, reporter shapes, negative controls qualified by their own scenarios, helper/fixture mutants judged by versioned contracts",
  contract: CONTRACT_VERSION,
  negative_contract: NEGATIVE_CONTRACT_VERSION,
  browsers,
  check_only: checkOnly,
  stage,
  preflight_pass: preflight,
  control_probes: stage === "negatives" ? [] : controlIds,
  controls: record.controls.map((c) => ({ name: c.name, ok: c.ok })),
  prerequisite,
  negatives: record.negatives.map((n) => ({
    id: n.negative_control,
    outcome: n.outcome,
    qualified: n.qualified,
    integrity: n.integrity.valid,
    scenario: n.scenario.valid,
    classifier: n.classifier.verdict,
  })),
  selected: selected.map((m) => m.id),
  run: record.mutants.length,
  verdicts: Object.fromEntries(
    record.mutants.map((m) => [m.mutant, m.verdict]),
  ),
  caught: record.mutants.filter((m) => m.verdict === "caught").length,
  source_unchanged: unchanged,
  trees,
  passed: outcome.passed,
  reasons: outcome.reasons,
  fatal,
  elapsed_ms: Date.now() - started,
  at: new Date().toISOString(),
  evidence: runDir,
};
json(join(runDir, "probe-results.json"), { summary, ...record });
console.log(JSON.stringify(summary));
process.exitCode = outcome.passed ? 0 : 1;

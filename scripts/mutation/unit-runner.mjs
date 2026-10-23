// The unit-mutation runner (WEB-09a plan 8.12 / S-7) as a library, so scripts/run-data-mutants.mjs (the real catalogue) and its
// qualification fixtures run exactly the same code. WEB-14a revision 27 (review r26 R31, design assessment DA-H2/C4):
//
// - every Vitest child is supervised (vitest-supervised.mjs) and judged only from its bound terminal envelope (vitest-evidence.mjs):
//   errors outside a test, nested suite errors, unhandled errors, errors Vitest logs while shutting down and incomplete evidence are
//   all counted, and a catch must be clean (`unitVerdict`);
// - the first failure (a control that is not cleanly passing, a survivor, a wrong-test or crash-only catch of a mutant with `expect`,
//   a tainted catch of such a mutant, incomplete evidence) LATCHES: no further control or mutant is started, mutants already running
//   are joined and recorded, and everything else is recorded `not_run`;
// - the output directory is claimed exclusively (an existing one, such as the historical default, is refused).
// Revision 28 (review r27 R31): an assertion is admitted only by its worker-recorded origin (vitest-origin-setup.mjs), so a matcher
// that crashed before comparing is an error here, alone (`crash_only`) or beside an assertion (`tainted`), and latches the run.
//
// Kept from the earlier runner: patched copies, never the tree; one unmutated control per distinct set of tests; the catalogue's
// `expect` rule; an earlier revision's mutant (no `expect`) that is not cleanly caught is LISTED (crash_only_legacy, tainted_legacy),
// never counted as caught, and does not fail the run.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  controlVerdict,
  namePatternOf,
  REQUEST_SCHEMA,
  readRun,
  selectionProblems,
  unitVerdict,
} from "./vitest-evidence.mjs";

const supervisor = join(
  dirname(new URL(import.meta.url).pathname),
  "vitest-supervised.mjs",
);

/** Claim `outDir` for this invocation only; an existing path is refused, never reused or merged. */
export function claimOutput(outDir) {
  mkdirSync(dirname(outDir), { recursive: true });
  try {
    mkdirSync(outDir);
  } catch (error) {
    if (error?.code === "EEXIST")
      return {
        ok: false,
        reason: `refusing to reuse an existing output directory (pass a fresh --out): ${outDir}`,
      };
    throw error;
  }
  writeFileSync(
    join(outDir, "claim.json"),
    `${JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: new Date().toISOString() })}\n`,
    { flag: "wx" },
  );
  return { ok: true };
}

/** Write every patched copy under `work`; returns `{ mutant, applied, error? }` per mutant. */
export function patchAll({ root, mutants, work }) {
  const out = [];
  for (const mutant of mutants) {
    try {
      const text = readFileSync(join(root, mutant.file), "utf8");
      const patched = mutant.patch(text);
      if (patched === text) throw new Error("the patch changed nothing");
      const target = join(work, mutant.id, mutant.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, patched);
      out.push({ mutant, applied: true });
    } catch (error) {
      out.push({
        mutant,
        applied: false,
        error: String(error?.message ?? error),
      });
    }
  }
  return out;
}

function spawnChild(argv, { cwd, env }) {
  return new Promise((done) => {
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        done({ ...value, output });
      }
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        spawnError: String(error?.message ?? error),
        code: null,
        signal: null,
      });
      return;
    }
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) =>
      finish({
        spawnError: String(error?.message ?? error),
        code: null,
        signal: null,
      }),
    );
    child.on("close", (code, signal) =>
      finish({ spawnError: null, code, signal }),
    );
  });
}

/** One supervised Vitest child over `files`, judged from its complete evidence. */
export async function supervisedRun({
  root,
  config,
  files,
  dir,
  label,
  env = {},
  closeTimeoutMs,
  testNamePattern,
  onLaunch,
}) {
  mkdirSync(dir, { recursive: true });
  const request = {
    schema: REQUEST_SCHEMA,
    nonce: randomUUID(),
    label,
    root,
    config,
    files,
    json: join(dir, "report.json"),
    envelope: join(dir, "envelope.json"),
    ...(closeTimeoutMs ? { closeTimeoutMs } : {}),
    ...(testNamePattern ? { testNamePattern } : {}),
  };
  const requestPath = join(dir, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  onLaunch?.(label);
  const started = Date.now();
  const child = await spawnChild([process.execPath, supervisor, requestPath], {
    cwd: root,
    env,
  });
  writeFileSync(join(dir, "output.log"), child.output);
  const run = readRun({
    child,
    envelopePath: request.envelope,
    reportPath: request.json,
    startedMs: started,
    nonce: request.nonce,
    label,
  });
  return { run, child, ms: Date.now() - started, output: child.output };
}

/** Narrowed selections that name a mutant outside their decision or outside the catalogue (refused before anything runs). */
export function unauthorisedSelections(selections, authorised, catalogue) {
  return Object.keys(selections).filter(
    (id) => !authorised.includes(id) || !catalogue.some((m) => m.id === id),
  );
}

/** Whether a mutant's verdict fails the run (and so latches the schedule). */
export function failsRun(verdict, mutant) {
  if (verdict === "caught") return false;
  if (
    mutant.expect === undefined &&
    (verdict === "crash_only" || verdict === "tainted")
  )
    return false;
  return true;
}

/**
 * Run `mutants` (each `{ id, title, file, patch, tests, expect? }`). `config` is the Vitest config path, `expectedCount` the catalogue
 * size (null to skip the count check). Returns `{ code, summary, results }` and writes `unit-results.json` into `outDir`.
 */
export async function runUnitMutants({
  root,
  mutants,
  outDir,
  config,
  jobs = 3,
  check = false,
  expectedCount = null,
  extraSummary = {},
  closeTimeoutMs,
  log = console.log,
  onRecord,
}) {
  const claim = claimOutput(outDir);
  if (!claim.ok) {
    console.error(claim.reason);
    return { code: 2, summary: null, results: [] };
  }
  const work = join(outDir, "work");
  const launches = [];
  const onLaunch = (label) => {
    launches.push({ label, at: new Date().toISOString() });
    writeFileSync(
      join(outDir, "launches.json"),
      `${JSON.stringify(launches, null, 2)}\n`,
    );
  };
  const patches = patchAll({ root, mutants, work });
  const unapplied = patches.filter((p) => !p.applied);
  for (const p of unapplied)
    console.error(`PATCH FAILED ${p.mutant.id}: ${p.error}`);
  if (check) {
    log(
      `${patches.length - unapplied.length} of ${patches.length} patches apply.`,
    );
    return { code: unapplied.length === 0 ? 0 : 1, summary: null, results: [] };
  }

  let latched =
    unapplied.length > 0
      ? `patch failed: ${unapplied.map((p) => p.mutant.id).join(", ")}`
      : null;
  // The unmutated control, once per distinct set of tests, before any mutant.
  // A mutant with a declared `selection` (scripts/mutation/unit-selections.mjs) runs only those cases of its files, so it has a control
  // of its own over exactly the same selection; every other mutant shares the control of its set of files, as before.
  const controlKey = (mutant) =>
    `${[...mutant.tests].sort().join(",")}${mutant.selection ? `|selection:${mutant.id}` : ""}`;
  const controls = new Map();
  for (const { mutant } of patches) {
    const key = controlKey(mutant);
    if (!controls.has(key))
      controls.set(key, { files: mutant.tests, selection: mutant.selection });
  }
  const pattern = (selection) =>
    selection ? namePatternOf(selection.cases.map((c) => c.name)) : undefined;
  const controlResults = [];
  for (const { files, selection } of controls.values()) {
    const index = controlResults.length;
    if (latched !== null) {
      controlResults.push({
        tests: files,
        ...(selection ? { selection: selection.cases.length } : {}),
        verdict: "not_run",
        passed: false,
        reasons: [`stopped: ${latched}`],
      });
      continue;
    }
    const { run, ms } = await supervisedRun({
      root,
      config,
      files,
      dir: join(work, `control-${index}`),
      label: `control-${index}`,
      closeTimeoutMs,
      testNamePattern: pattern(selection),
      onLaunch,
    });
    const inventory = selection ? selectionProblems(run, selection.cases) : [];
    const v =
      inventory.length > 0
        ? { verdict: "incomplete", reasons: inventory }
        : controlVerdict(run);
    const record = {
      tests: files,
      ...(selection ? { selection: selection.cases.length } : {}),
      verdict: v.verdict,
      passed: v.verdict === "pass",
      total: v.total ?? null,
      skipped: v.skipped ?? null,
      reasons: v.reasons,
      ms,
    };
    controlResults.push(record);
    if (!record.passed) latched = `control-${index}: ${v.verdict}`;
    log(
      `control ${record.passed ? "passes" : `FAILS (${v.verdict})`} (${record.total ?? "?"} tests${selection ? `, ${selection.cases.length} selected` : ""}): ${files.map((f) => f.replace("tests/data/", "")).join(" ")}`,
    );
    for (const reason of record.passed ? [] : v.reasons) log(`  ${reason}`);
    onRecord?.({ kind: "control", ...record });
  }

  // The mutants, a few at a time; nothing new starts once a failure has latched.
  const results = [];
  const queue = patches.filter((p) => p.applied).map((p) => p.mutant);
  async function worker() {
    while (latched === null && queue.length > 0) {
      const mutant = queue.shift();
      const dir = join(work, mutant.id);
      const { run, ms, output } = await supervisedRun({
        root,
        config,
        files: mutant.tests,
        dir,
        label: mutant.id,
        env: { ATLAS_MUTANT_DIR: dir },
        closeTimeoutMs,
        testNamePattern: pattern(mutant.selection),
        onLaunch,
      });
      const inventory = mutant.selection
        ? selectionProblems(run, mutant.selection.cases)
        : [];
      const v =
        inventory.length > 0
          ? { verdict: "incomplete", reasons: inventory }
          : unitVerdict(run, mutant);
      const fails = failsRun(v.verdict, mutant);
      const record = {
        id: mutant.id,
        title: mutant.title,
        file: mutant.file,
        tests: mutant.tests,
        ...(mutant.selection
          ? { selection: mutant.selection.cases.length }
          : {}),
        verdict: v.verdict,
        caught: v.verdict === "caught",
        crashOnly: v.verdict === "crash_only",
        expect: mutant.expect ? String(mutant.expect) : undefined,
        exit: run.complete ? run.exitCode : null,
        kinds: v.kinds ?? null,
        failedTests: (v.failedTests ?? []).slice(0, 12),
        failedCount: v.failedTests?.length ?? null,
        reasons: v.reasons,
        ms,
        ...(v.verdict === "caught" ? {} : { tail: output.slice(-400) }),
      };
      if (fails && latched === null) latched = `${mutant.id}: ${v.verdict}`;
      results.push(record);
      log(
        `${v.verdict === "caught" ? "caught  " : fails ? v.verdict.toUpperCase().padEnd(8) : `${v.verdict} (legacy, listed)`} ${mutant.id} (${JSON.stringify(v.kinds ?? {})})  ${mutant.title}`,
      );
      for (const reason of v.verdict === "caught" ? [] : v.reasons.slice(0, 4))
        log(`  ${reason}`);
      onRecord?.({ kind: "mutant", ...record });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  const notRun = queue.map((m) => m.id);
  results.sort((a, b) => a.id.localeCompare(b.id));

  const listedLegacy = (verdict) =>
    results
      .filter((r) => r.expect === undefined && r.verdict === verdict)
      .map((r) => r.id);
  const failures = results.filter((r) =>
    failsRun(r.verdict, { expect: r.expect }),
  );
  const countOk = expectedCount === null || patches.length === expectedCount;
  const summary = {
    layer:
      "L1a/L1b (vitest, patched copies, unmutated control per test set; supervised evidence, clean catches, failure latch)",
    selected: patches.length,
    unit_mutants_run: results.length,
    patch_failures: unapplied.map((p) => ({ id: p.mutant.id, error: p.error })),
    caught: results.filter((r) => r.caught).length,
    crash_only_legacy: listedLegacy("crash_only"),
    tainted_legacy: listedLegacy("tainted"),
    survived: failures.map((r) => r.id),
    failures: failures.map((r) => ({ id: r.id, verdict: r.verdict })),
    not_run: notRun,
    stopped: latched,
    controls: controlResults,
    count_ok: countOk,
    ...extraSummary,
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(outDir, "unit-results.json"),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );
  const controlsOk = controlResults.every((c) => c.passed);
  log(
    `\n${summary.caught} of ${results.length} caught cleanly by an assertion; ${summary.crash_only_legacy.length} earlier mutant(s) caught by crashes alone and ${summary.tainted_legacy.length} with errors beside the assertions (listed, not counted); ${failures.length} failed (survived, wrong test, crash-only, tainted or incomplete); ${notRun.length} not run; ${unapplied.length} patches failed; controls ${controlsOk ? "all pass" : "NOT all passing"}; count ${countOk ? "ok" : "WRONG"}${latched ? `; stopped at ${latched}` : ""}`,
  );
  const ok =
    latched === null &&
    failures.length === 0 &&
    unapplied.length === 0 &&
    controlsOk &&
    countOk &&
    notRun.length === 0;
  return { code: ok ? 0 : 1, summary, results };
}

#!/usr/bin/env node
// WEB-08d revision 21 (review r20 R20-N1; design assessment 4645b621 Q1-Q8, Q12-Q14): qualification of the
// held-operation owner (tests/e2e/held-operation.ts, held-operation-ledger.ts) and the fixture's hold seam
// (src/fixture/data-harness/main.ts) in real engines, through the opt-in probes of
// tests/e2e/probe.held-operation.spec.ts.
//
// 1. control: the live tree's probes against an unmutated fixture build. Every `P..` control must pass and
//    every `S..` reporter-shape probe must fail EXACTLY as its oracle says (errors, their kinds, their text, the
//    all-error reader's verdict for the case: scripts/validation/engine-results.mjs, unchanged).
// 2. copy-control: the same probes from an UNMUTATED copy of the test tree (under .agtx/, never beside the live
//    specs), so that a mutant's deviation cannot come from the copy itself (review r19 H1).
// 3. helper mutants: a patched copy of the owner or its ledger; fixture mutants: a patched copy of the harness in a
//    mutant build (vite.mutant.config.ts, as the native runner builds). A mutant is caught only when EVERY case
//    of its named probes deviates from its oracle in every engine, a control (P..) by a failed assertion of its
//    own (never a timeout or a crash), in a complete run (one attempt, the exact cases discovered).
// The source fingerprint must be unchanged at the end. One worker, no retries; a failed control stops the run
// before any mutant. Nothing is cached.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../integration/free-port.mjs";
import { inspectReport } from "./engine-results.mjs";
import { fingerprint, json, newRun, processes } from "./runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = "tests/e2e/held-operation.ts";
const LEDGER = "tests/e2e/held-operation-ledger.ts";
const HARNESS = "src/fixture/data-harness/main.ts";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const sub = (text, from, to) => {
  const count = text.split(from).length - 1;
  if (count !== 1)
    throw new Error(`anchor found ${count} times: ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

/** The cases each probe id names (P03 is parameterised twice). */
const CASES = {
  P01: 1,
  P02: 1,
  P03: 2,
  P04: 1,
  P05: 1,
  P06: 1,
  P07: 1,
  P08: 1,
  P09: 1,
  P10: 1,
  P11: 1,
  P12: 1,
  P13: 1,
  S1: 1,
  S2: 1,
  S3: 1,
  S4: 1,
  S5: 1,
  S6: 1,
  S7: 1,
  S8: 1,
  S9: 1,
};

/** What each probe must report: `null` when it does, otherwise why not. */
function oracle(id, c) {
  const kinds = c.errors.map((e) => e.kind).join(",");
  const text = (i) => c.full[i] ?? "";
  const need = (ok, why) => (ok ? null : why);
  if (id.startsWith("P"))
    return need(
      c.status === "passed" && c.errors.length === 0,
      `control ${c.status} with ${c.errors.length} error(s)`,
    );
  switch (id) {
    case "S1": {
      const ledger = c.attachments["held-operations"];
      const scope = ledger?.scopes?.[0];
      const cleanup = scope?.holds?.[0]?.events?.find(
        (e) => e.event === "cleanup-release",
      )?.detail;
      return need(
        c.status === "failed" &&
          kinds === "assertion" &&
          c.kind === "assertion" &&
          ledger?.errors?.length === 0 &&
          scope?.calls?.[0]?.state === "fulfilled" &&
          scope?.calls?.[0]?.joined === true &&
          cleanup?.outcome === "released",
        `S1: ${c.status} [${kinds}] case ${c.kind}, cleanup ${JSON.stringify(cleanup)}, call ${JSON.stringify(scope?.calls?.[0]?.state)}/${scope?.calls?.[0]?.joined}`,
      );
    }
    case "S2":
      return need(
        c.status === "failed" &&
          kinds === "error" &&
          c.kind === "error" &&
          text(0).includes("the operation the failing edit failed") &&
          text(0).includes("probe operation failure after edited"),
        `S2: ${c.status} [${kinds}] ${text(0).split("\n")[0]}`,
      );
    case "S3":
    case "S4":
    case "S5":
    case "S8": {
      const expected = {
        S3: "probe operation failure after edited",
        S4: "did not settle within 1000 ms",
        S5: "releasing the held data.editQueuedDraft answer failed",
        S8: "expect (received).toBe(expected) inside the operation",
      }[id];
      return need(
        c.status === "failed" &&
          kinds === "assertion,error" &&
          c.kind === "error" &&
          text(1).includes("held-operation cleanup failed") &&
          text(1).includes(expected),
        `${id}: ${c.status} [${kinds}] case ${c.kind}: ${text(1).split("\n")[0]}`,
      );
    }
    case "S6":
      return need(
        c.status === "timedOut" &&
          c.kind === "timeout" &&
          c.full.some((t) =>
            t.includes("a held-operation scope never finished"),
          ),
        `S6: ${c.status} case ${c.kind} [${kinds}]`,
      );
    case "S7":
      return need(
        c.status === "failed" &&
          kinds === "assertion" &&
          c.kind === "assertion",
        `S7: ${c.status} [${kinds}]`,
      );
    case "S9":
      return need(
        c.status === "failed" &&
          kinds === "error" &&
          c.kind === "error" &&
          text(0).includes(
            "expect (received).toBe(expected) inside the operation",
          ),
        `S9: ${c.status} [${kinds}] ${text(0).split("\n")[0]}`,
      );
    default:
      return `no oracle for ${id}`;
  }
}

/** Helper mutants (patched copies of the test tree) and fixture mutants (patched harness, mutant build). */
const MUTANTS = [
  {
    id: "HM1",
    title: "a failed body's cleanup releases nothing (the R20-N1 defect)",
    file: HELPER,
    probes: ["P03", "S1"],
    patch: (t) =>
      sub(
        t,
        "if (held.released && !bodyFailed) continue;",
        "if (held.released || bodyFailed) continue;",
      ),
  },
  {
    id: "HM2",
    title: "the cleanup never joins the operations",
    file: HELPER,
    probes: ["P03", "S1"],
    patch: (t) =>
      sub(
        t,
        "for (const { record: call, outcome } of calls) {",
        "for (const { record: call, outcome } of calls.slice(calls.length)) {",
      ),
  },
  {
    id: "HM3",
    title: "an operation's rejection is swallowed by `settled()`",
    file: HELPER,
    probes: ["P06"],
    patch: (t) =>
      sub(
        t,
        "if (!settled.ok) throw settled.error;",
        "if (!settled.ok) return undefined as T;",
      ),
  },
  {
    id: "HM4",
    title:
      "a failed body's cleanup failures are dropped (never reach the ledger)",
    file: HELPER,
    probes: ["P07", "S3", "S5"],
    patch: (t) =>
      sub(
        t,
        "ledger.errors.push(...(await finalise(true)));",
        "await finalise(true);",
      ),
  },
  {
    id: "HM5",
    title:
      "the cleanup releases without its token (whatever hold the page has now)",
    file: HELPER,
    probes: ["P09"],
    patch: (t) => sub(t, "{ kind, token },", "{ kind, token: undefined },"),
  },
  {
    id: "HM6",
    title: "the body's own failure is replaced by a cleanup error",
    file: HELPER,
    probes: ["P02", "S1"],
    patch: (t) =>
      sub(
        t,
        "    throw failure;",
        '    throw new Error("held operations failed");',
      ),
  },
  {
    id: "HM9",
    title: "the owner trusts a release answer that is not a hold release",
    file: HELPER,
    probes: ["P13"],
    patch: (t) =>
      sub(
        t,
        "  if (!isRelease(released))",
        "  if (released === Symbol.for(String(released)))",
      ),
  },
  {
    id: "HM7",
    title: "the ledger is attached but its failures are never reported",
    file: LEDGER,
    probes: ["S3", "S4", "S5", "S6"],
    patch: (t) =>
      sub(t, "  if (errors.length > 0)", "  if (errors.length < 0)"),
  },
  {
    id: "HM8",
    title:
      "an operation error that reads like an assertion is reported as written",
    file: LEDGER,
    probes: ["S8", "S9"],
    patch: (t) =>
      sub(t, '  text.replaceAll("expect(", "expect (");', "  text;"),
  },
  {
    id: "FM1",
    title: "the fixture's release of an unreached arm leaves it armed",
    file: HARNESS,
    probes: ["P02", "P10", "P11"],
    patch: (t) =>
      sub(
        t,
        '    hold.plan = null;\n    outcome = "disarmed";',
        '    outcome = "disarmed";',
      ),
  },
  {
    id: "FM2",
    title: "the fixture lets a second arm replace a live one",
    file: HARNESS,
    probes: ["P10"],
    patch: (t) =>
      sub(
        t,
        "  if (hold.plan !== null || hold.held)\n",
        "  if (hold.plan === Symbol.for(String(hold.held)))\n",
      ),
  },
  {
    id: "FM3",
    title: "the fixture's release ignores whose token it is",
    file: HARNESS,
    probes: ["P05", "P09", "P10"],
    patch: (t) =>
      sub(
        t,
        "  const stale =\n    token !== undefined &&",
        "  const stale =\n    token === Symbol.for(String(token)) &&",
      ),
  },
];

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
  if (!["--out", "--browsers", "--only"].includes(args[i]))
    throw new Error(`Unknown option: ${args[i]}`);
  i += 1;
}
const outDir = resolve(
  root,
  value("--out", ".agtx/evidence/held-operation-probes"),
);
const browsers = value("--browsers", "chromium,firefox,webkit").split(",");
if (
  !browsers.length ||
  browsers.some((b) => !["chromium", "firefox", "webkit"].includes(b)) ||
  new Set(browsers).size !== browsers.length
)
  throw new Error("Invalid or duplicate --browsers");
const only = value("--only", "").split(",").filter(Boolean);
if (only.some((id) => !MUTANTS.some((m) => m.id === id)))
  throw new Error("Unknown --only mutant ID");
const selected = MUTANTS.filter((m) => !only.length || only.includes(m.id));
const checkOnly = args.includes("--check");

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
const record = { control: null, copy_control: null, mutants: [] };
let fatal = null;
let preflight = false;
let interrupted = false;

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
/** An unmutated (or patched) copy of what Playwright loads: the config and tests/e2e. */
function copyTree(name, patch) {
  const tree = join(trees, name);
  mkdirSync(tree, { recursive: true });
  cpSync(join(root, "tests/e2e"), join(tree, "tests/e2e"), {
    recursive: true,
  });
  cpSync(
    join(root, "playwright.config.ts"),
    join(tree, "playwright.config.ts"),
  );
  if (patch) writeFileSync(join(tree, patch.file), patch.text);
  return tree;
}
/** Every case of the report, with what the oracle reads: each error's full text and the parsed attachments. */
function casesOf(report, exit) {
  const inspected = inspectReport(report, browsers, exit);
  const raw = new Map();
  const visit = (suite, parents = []) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const last = (test.results ?? []).at(-1);
        const title = [...parents, suite.title, spec.title]
          .filter(Boolean)
          .join(" › ");
        const attachments = {};
        for (const a of last?.attachments ?? [])
          if (a.contentType === "application/json" && a.body)
            try {
              attachments[a.name] = JSON.parse(
                Buffer.from(a.body, "base64").toString("utf8"),
              );
            } catch {
              attachments[a.name] = "unparseable";
            }
        raw.set(`${test.projectName}::${title}`, {
          full: (last?.errors ?? []).map((e) =>
            String(e?.message ?? "").replace(ANSI, ""),
          ),
          attachments,
          spec: spec.title,
        });
      }
    for (const child of suite.suites ?? [])
      visit(child, [...parents, suite.title].filter(Boolean));
  };
  for (const suite of report.suites ?? []) visit(suite);
  return {
    inspected,
    cases: inspected.cases.map((c) => {
      const extra = raw.get(`${c.engine}::${c.title}`);
      return {
        ...c,
        id: extra?.spec.split(" ")[0],
        full: extra?.full ?? [],
        attachments: extra?.attachments ?? {},
      };
    }),
  };
}
async function probes(url, cwd, ids, directory) {
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
    },
  );
  writeFileSync(join(directory, "playwright.log"), result.output);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const { inspected, cases } = casesOf(report, result.code);
  // The exact cases: every named probe, its parameterisations, in every engine; no other case.
  const expected = browsers.flatMap((b) =>
    ids.flatMap((id) =>
      Array.from({ length: CASES[id] }, () => `fixture-${b}::${id}`),
    ),
  );
  const got = cases.map((c) => `${c.engine}::${c.id}`);
  const inventory =
    JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort());
  const judged = cases.map((c) => ({
    engine: c.engine,
    id: c.id,
    title: c.title,
    status: c.status,
    attempts: c.attempts,
    kind: c.kind,
    errors: c.errors,
    deviation: oracle(c.id, c),
  }));
  return {
    exit: result.code,
    complete: inspected.complete && inventory,
    inventory_matches: inventory,
    cases: judged,
  };
}

try {
  // Every patch applies to the current text before anything is built.
  const patches = [];
  const failures = [];
  for (const mutant of selected) {
    try {
      const text = readFileSync(join(root, mutant.file), "utf8");
      const patched = mutant.patch(text);
      if (patched === text) throw new Error("patch changed nothing");
      patches.push({ mutant, text: patched });
    } catch (error) {
      failures.push({ id: mutant.id, patch_failed: String(error.message) });
    }
  }
  json(join(runDir, "preflight.json"), {
    selected: selected.map((m) => m.id),
    failures,
  });
  if (failures.length)
    throw new Error(`${failures.length} probe mutation(s) failed preflight`);
  preflight = true;
  if (!checkOnly) {
    const ALL = Object.keys(CASES);
    const controlBuild = join(runDir, "control-build");
    await build(null, controlBuild, join(runDir, "control-build.log"));
    const sound = (run) =>
      run.complete && run.cases.every((c) => c.deviation === null);
    record.control = await withPreview(controlBuild, (url) =>
      probes(url, root, ALL, join(runDir, "control")),
    );
    console.log(`control ${sound(record.control) ? "passes" : "FAILS"}`);
    if (!sound(record.control)) throw new Error("Probe control failed");
    const copy = copyTree("copy-control");
    record.copy_control = await withPreview(controlBuild, (url) =>
      probes(url, copy, ALL, join(runDir, "copy-control")),
    );
    console.log(
      `copy control ${sound(record.copy_control) ? "passes" : "FAILS"}`,
    );
    if (!sound(record.copy_control))
      throw new Error("Probe copy control failed");
    for (const { mutant, text } of patches) {
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
        const tree = copyTree(mutant.id, { file: mutant.file, text });
        run = await withPreview(controlBuild, (url) =>
          probes(url, tree, mutant.probes, join(directory, "browser")),
        );
      }
      // A control (P..) deviates only by a failed assertion of its own; a shape probe by any oracle mismatch.
      const caught =
        run.exit !== 0 &&
        run.complete &&
        run.cases.every(
          (c) =>
            c.deviation !== null &&
            (!c.id.startsWith("P") ||
              (c.status === "failed" && c.kind === "assertion")),
        );
      const result = {
        id: mutant.id,
        title: mutant.title,
        file: mutant.file,
        probes: mutant.probes,
        caught,
        ...run,
      };
      json(join(directory, "result.json"), result);
      record.mutants.push(result);
      console.log(`${caught ? "caught" : "FAILED"} ${mutant.id}`);
      if (!caught) throw new Error(`Probe mutant not caught: ${mutant.id}`);
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
const passed =
  !interrupted &&
  !fatal &&
  preflight &&
  unchanged &&
  (checkOnly ||
    (record.mutants.length === selected.length &&
      record.mutants.every((m) => m.caught)));
const summary = {
  layer:
    "held-operation owner and fixture hold seam (WEB-08d r21, R20-N1): real engines, probe controls, reporter shapes, helper/fixture mutants",
  browsers,
  check_only: checkOnly,
  preflight_pass: preflight,
  selected: selected.map((m) => m.id),
  control_ok:
    record.control?.complete === true &&
    record.control.cases.every((c) => c.deviation === null),
  copy_control_ok:
    record.copy_control?.complete === true &&
    record.copy_control.cases.every((c) => c.deviation === null),
  run: record.mutants.length,
  caught: record.mutants.filter((m) => m.caught).length,
  source_unchanged: unchanged,
  trees,
  passed,
  fatal,
  elapsed_ms: Date.now() - started,
  at: new Date().toISOString(),
  evidence: runDir,
};
json(join(runDir, "probe-results.json"), { summary, ...record });
console.log(JSON.stringify(summary));
process.exitCode = passed ? 0 : 1;

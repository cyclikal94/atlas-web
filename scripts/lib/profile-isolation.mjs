#!/usr/bin/env node
// Isolation of the sync-profiling measurements (WEB-09c plan 5.0; review finding R1). A measurement taken while another card's heavy work
// runs on the same controller is CONTAMINATED and must say so, in the hashed hand-over itself.
//
// Three parts:
//   * a SAMPLER the drivers start for each stage (`startLoadSampler`): every few seconds, every process that is not this run's and that is
//     heavy test work (a test runner, a Playwright browser, a build, a backend, a VM), appended to `<dir>/isolation/<stage>.jsonl`;
//   * the attribution of a process to this run (`attribute`): the driver's process tree, its ancestors, and the WebKit XPC services that
//     launchd starts for a Playwright WebKit host (their parent is launchd, so the tree cannot show whose they are: they are this run's only
//     while every running WebKit host is this run's);
//   * the verdict of a COLLECTION WINDOW (`classifyWindow`): every row of `measurements.jsonl` and `values.jsonl` carries the window of the
//     test that collected it (from the test's start to the row's export, which encloses the collection), so a row is judged by the samples
//     that cover the whole time its figures were taken, never by the moment it was written out.
//
// Verdicts: `clean` (no foreign heavy process in any sample covering the window), `idle_foreign` (one was present but used under 1 % of a
// core in every such sample: ps's reading of a parked process; NOT clean), `contaminated` (one used 1 % of a core or more), `unknown` (the
// samples do not cover the window: no sample at or before its start, or at or after its end, within 1.5 intervals, a gap of more than two
// intervals, or a failed sample). Only `clean` is isolated. There is no tolerance tier above the idle reading.
//
//   node scripts/lib/profile-isolation.mjs --sample --out <file.jsonl> --root-pid <pid> [--interval-ms 5000]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_INTERVAL_MS = 5_000;
/** ps's reading of a parked process stays under this (percent of one core); anything at or above it is competing for the CPU. */
export const IDLE_CPU_PERCENT = 1;
export const VERDICTS = ["clean", "idle_foreign", "contaminated", "unknown"];
export const METHOD =
  "every row is judged over its collection window (the enclosing test, from its start to the row's export) by the load samples that cover it, including the nearest sample at or before its start and at or after its end; clean = no foreign heavy process (test runner, Playwright or pool browser, build, backend, VM) in any of them; idle_foreign = one present under 1 % of a core in every sample (not clean); contaminated = one at 1 % or more; unknown = the samples do not cover the window. This run's own process tree, its ancestors and the WebKit XPC services of its own WebKit host are not foreign";

const HEAVY =
  /vitest|playwright|cli\.js test|run-validation|run-engine-mutants|run-data-mutants|atlas-runner|atlas-server|cargo|rustc|vite build|vite preview|tsc |esbuild/;
// A container or VM runtime is matched by its executable, not by a word in another program's arguments (an editor's Dockerfile language
// server is not Docker).
const VM =
  /(^|\/)(docker|dockerd|com\.docker\.[\w.]+|colima|limactl|qemu-system-\w+)$/;
// Agent and editor CLIs name test tools in their own arguments (--add-dir …/ms-playwright, …/.cargo): they are not heavy work.
const AGENT =
  /(^|\/)(claude|codex|agy)( |$)|native-binary\/claude|Claude\.app|Codex Computer Use/;
const WEBKIT_HOST = /Playwright\.app\/Contents\/MacOS\/Playwright/;
const WEBKIT_XPC = /com\.apple\.WebKit\.[A-Za-z]+\.xpc/;
const SAMPLER = /profile-isolation\.mjs --sample/;

export const isHeavy = (command) =>
  (HEAVY.test(command) || VM.test(command.split(" ")[0])) &&
  !AGENT.test(command.split(" --")[0]);

/** `ps -axo pid=,ppid=,pcpu=,command=` as rows. */
export function psRows() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, pcpu, ...command] = l.split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pcpu: Number(pcpu),
        command: command.join(" "),
      };
    });
}

/**
 * Which processes are this run's: the root's whole tree, the root's ancestors (the shell and the validation driver that launched it, but
 * not their other children), and the Playwright WebKit XPC services when every running WebKit host is in this run's tree (with no host
 * running, or with any host of another run, they cannot be told apart and count as foreign). Returns the foreign heavy processes.
 */
export function attribute(rows, rootPid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const mine = new Set(rootPid ? [rootPid] : []);
  for (let at = byPid.get(rootPid); at; at = byPid.get(at.ppid))
    mine.add(at.pid);
  const ancestors = new Set(mine);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows)
      if (
        !mine.has(r.pid) &&
        mine.has(r.ppid) &&
        (!ancestors.has(r.ppid) || r.ppid === rootPid)
      ) {
        mine.add(r.pid);
        grew = true;
      }
  }
  const hosts = rows.filter((r) => WEBKIT_HOST.test(r.command));
  const xpcMine = hosts.length > 0 && hosts.every((h) => mine.has(h.pid));
  for (const r of rows)
    if (xpcMine && WEBKIT_XPC.test(r.command) && isHeavy(r.command))
      mine.add(r.pid);
  const foreign = rows.filter(
    (r) =>
      !mine.has(r.pid) &&
      r.pid !== process.pid &&
      isHeavy(r.command) &&
      !SAMPLER.test(r.command),
  );
  return {
    mine,
    foreign,
    webkit_xpc: hosts.length === 0 ? "no_host" : xpcMine ? "own" : "foreign",
    own_cpu_percent: +rows
      .filter((r) => mine.has(r.pid))
      .reduce((n, r) => n + r.pcpu, 0)
      .toFixed(1),
    other_cpu_percent: +rows
      .filter((r) => !mine.has(r.pid) && !isHeavy(r.command))
      .reduce((n, r) => n + r.pcpu, 0)
      .toFixed(1),
  };
}

/** One sample: what ran beside this run now. */
export function sampleLoad(rootPid, intervalMs = SAMPLE_INTERVAL_MS) {
  const at = new Date().toISOString();
  try {
    const seen = attribute(psRows(), rootPid);
    return {
      at,
      interval_ms: intervalMs,
      loadavg: loadavg().map((n) => +n.toFixed(2)),
      own_tree_cpu_percent: seen.own_cpu_percent,
      other_cpu_percent: seen.other_cpu_percent,
      webkit_xpc: seen.webkit_xpc,
      foreign_heavy_cpu_percent: +seen.foreign
        .reduce((n, r) => n + r.pcpu, 0)
        .toFixed(1),
      foreign_heavy: seen.foreign.map((r) =>
        `${r.pid} ${r.ppid} ${r.pcpu} ${r.command}`.slice(0, 220),
      ),
    };
  } catch (error) {
    return { at, interval_ms: intervalMs, error: String(error).slice(0, 200) };
  }
}

/**
 * Starts the sampler for one stage as a child process (the stage's own work blocks this process's event loop). It takes a sample at once,
 * every `intervalMs` after, and one more when stopped; it ends by itself when the root process has gone. `stop()` resolves after that
 * last sample is written.
 */
export async function startLoadSampler(
  dir,
  stage,
  { intervalMs = SAMPLE_INTERVAL_MS, rootPid = process.pid } = {},
) {
  const { spawn } = await import("node:child_process");
  const file = join(dir, "isolation", `${stage}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--sample",
      "--out",
      file,
      "--root-pid",
      String(rootPid),
      "--interval-ms",
      String(intervalMs),
    ],
    { stdio: "ignore" },
  );
  // The first sample is on disk before the stage begins.
  for (let i = 0; i < 100 && !existsSync(file); i += 1)
    await new Promise((r) => setTimeout(r, 50));
  return {
    file,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("exit", (code) => resolve(code));
        child.kill("SIGTERM");
      }),
  };
}

export const readSamples = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const time = (iso) => Date.parse(iso);

/** The verdict of one window [fromMs, toMs] over `samples` (any order; every sample carries `at`). */
export function classifyWindow(
  samples,
  fromMs,
  toMs,
  intervalMs = SAMPLE_INTERVAL_MS,
) {
  const sorted = samples
    .map((s) => ({ ...s, t: time(s.at) }))
    .filter((s) => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);
  const base = { window_s: +((toMs - fromMs) / 1000).toFixed(1) };
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs)
    return { ...base, verdict: "unknown", basis: "no valid window" };
  const before = sorted.filter((s) => s.t <= fromMs).at(-1);
  const after = sorted.find((s) => s.t >= toMs);
  if (!before || !after)
    return {
      ...base,
      verdict: "unknown",
      basis:
        "no load sample at or before the window's start, or at or after its end",
    };
  const reach = 1.5 * intervalMs;
  if (fromMs - before.t > reach || after.t - toMs > reach)
    return {
      ...base,
      verdict: "unknown",
      basis: `the nearest load sample is more than ${reach / 1000} s outside the window`,
    };
  const covering = sorted.filter((s) => s.t >= before.t && s.t <= after.t);
  let gap = 0;
  for (let i = 1; i < covering.length; i += 1)
    gap = Math.max(gap, covering[i].t - covering[i - 1].t);
  const base2 = {
    ...base,
    samples: covering.length,
    largest_gap_s: +(gap / 1000).toFixed(1),
  };
  if (gap > 2 * intervalMs)
    return {
      ...base2,
      verdict: "unknown",
      basis: `a gap of ${(gap / 1000).toFixed(1)} s between load samples (more than two intervals)`,
    };
  if (covering.some((s) => s.error))
    return { ...base2, verdict: "unknown", basis: "a load sample failed" };
  const foreign = covering.filter((s) => (s.foreign_heavy ?? []).length > 0);
  const peak = Math.max(
    0,
    ...covering.map((s) =>
      Math.max(
        0,
        ...(s.foreign_heavy ?? []).map((f) => Number(f.split(/\s+/)[2]) || 0),
      ),
    ),
  );
  const verdict =
    foreign.length === 0
      ? "clean"
      : peak >= IDLE_CPU_PERCENT
        ? "contaminated"
        : "idle_foreign";
  return {
    ...base2,
    verdict,
    basis: "the load samples covering the window",
    foreign_samples: foreign.length,
    peak_foreign_process_cpu_percent: peak,
    peak_foreign_total_cpu_percent: Math.max(
      0,
      ...covering.map((s) => s.foreign_heavy_cpu_percent ?? 0),
    ),
    // Everything else that was not this run's (system daemons, editors, other agents' own processes): recorded for the reader, not a verdict.
    peak_other_cpu_percent: Math.max(
      0,
      ...covering.map((s) => s.other_cpu_percent ?? 0),
    ),
    foreign_examples: [
      ...new Set(
        foreign.flatMap((s) =>
          s.foreign_heavy.map((f) => f.split(/\s+/).slice(3).join(" ")),
        ),
      ),
    ]
      .slice(0, 3)
      .map((c) => c.slice(0, 120)),
  };
}

/**
 * Every series (a row of `measurements.jsonl` or `values.jsonl`) and every collected test, with its verdict. A row without a collection
 * window is `unknown`: its figures cannot be placed in time.
 */
export function annotate({
  rows,
  tests = [],
  samples,
  intervalMs = SAMPLE_INTERVAL_MS,
}) {
  const series = rows.map((row) => {
    const c = row.collection;
    const judged = c
      ? classifyWindow(samples, time(c.from), time(c.to), intervalMs)
      : {
          verdict: "unknown",
          basis: "the row carries no collection window",
        };
    return {
      file: row.file,
      name: row.name,
      engine: row.engine,
      test: c?.test ?? null,
      from: c?.from ?? null,
      to: c?.to ?? null,
      ...judged,
    };
  });
  const cases = tests.map((t) => ({
    test: t.test,
    engine: t.engine,
    status: t.status,
    from: t.from,
    to: t.to,
    ...classifyWindow(samples, time(t.from), time(t.to), intervalMs),
  }));
  const count = (list) =>
    Object.fromEntries(
      VERDICTS.map((v) => [v, list.filter((s) => s.verdict === v).length]),
    );
  return {
    method: METHOD,
    sampling_interval_ms: intervalMs,
    load_samples: samples.length,
    series,
    tests: cases,
    summary: {
      series: series.length,
      ...count(series),
      tests: count(cases),
      peak_other_cpu_percent: Math.max(
        0,
        ...series.map((s) => s.peak_other_cpu_percent ?? 0),
      ),
      all_clean:
        series.length > 0 &&
        series.every((s) => s.verdict === "clean") &&
        cases.every((t) => t.verdict === "clean"),
    },
  };
}

// ---- the sampler process -----------------------------------------------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : fallback;
  };
  if (!args.includes("--sample") || !value("--out")) {
    console.error(
      "usage: node scripts/lib/profile-isolation.mjs --sample --out <file.jsonl> --root-pid <pid> [--interval-ms 5000]",
    );
    process.exit(2);
  }
  const out = value("--out");
  const rootPid = Number(value("--root-pid", String(process.ppid)));
  const intervalMs = Number(value("--interval-ms", String(SAMPLE_INTERVAL_MS)));
  mkdirSync(dirname(out), { recursive: true });
  const write = () =>
    appendFileSync(out, `${JSON.stringify(sampleLoad(rootPid, intervalMs))}\n`);
  const alive = () => {
    try {
      process.kill(rootPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
    write();
    process.exit(0);
  });
  write();
  const timer = setInterval(() => {
    if (stopping) return;
    if (!alive()) {
      clearInterval(timer);
      process.exit(0);
    }
    write();
  }, intervalMs);
}

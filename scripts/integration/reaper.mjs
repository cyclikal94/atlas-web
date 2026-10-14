#!/usr/bin/env node
// The integration runner's reaper (WEB-08d review r6, H4; the design assessment's outer-deadline composition).
//
// The runner starts this process first, in a process group of its own, and keeps a journal of what it owns on this process's stdin:
// the ownership token of its processes, the members it remembered, its disposable directories, its ports, whether it used Docker,
// and which stack is current. A caller can stop the runner faster than the runner can clean up after itself (the shared validation
// driver sends SIGTERM to the runner's group and SIGKILL two seconds later, and Docker containers and Playwright's detached browsers
// are not in that group). When the runner releases the journal, this process just exits. When the journal ends WITHOUT a release
// (the runner was killed, or crashed), this process finishes the clean-up on its own: every live process carrying the runner's mark
// or remembered by it is stopped (TERM, freeze, KILL, checked by pid and start time), everything labelled with the invocation is
// removed from Docker and verified gone, the directories are removed and the ports checked. It records what it did in
// `<run dir>/reaper.json` and completes `summary.json` if the runner did not: the current stack `cancelled`, every planned stack
// that has no record `not_run`, the outcome never a pass. It holds the runner's stdout/stderr, so a caller that waits for them waits
// for this clean-up too; its own deadline bounds it.
//
//   node scripts/integration/reaper.mjs <run dir> <token> <runner pid>      (journal on stdin; started by run.mjs, never by hand)
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DOCKER_CONTEXT,
  disposeLabelled,
  dockerClient,
  LABEL_INVOCATION,
} from "./docker-resources.mjs";
import { overall, settleStack } from "./outcome.mjs";
import { membersOf, processTable, stopMembers } from "./ownership.mjs";

const [runDir, token, runnerPidText] = process.argv.slice(2);
const runnerPid = Number(runnerPidText);
const DEADLINE_MS = Number(process.env.ATLAS_REAPER_DEADLINE_MS ?? 120_000);
// Its output goes to the runner's own stdout/stderr, which may be gone: a write that fails is not an error of the clean-up.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);
const say = (text) => {
  try {
    process.stderr.write(`reaper: ${text}\n`);
  } catch {
    // nobody is listening any more
  }
};

const journal = {
  invocation: null,
  docker: false,
  tmp: new Set(),
  ports: new Set(),
  known: new Map(),
  current: null,
  judged: null,
  evidence: null,
};
let released = null;
let taking = null;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "hello") {
    journal.invocation = m.invocation;
    journal.evidence = m.evidence;
  } else if (m.type === "docker") journal.docker = true;
  else if (m.type === "tmp") journal.tmp.add(m.path);
  else if (m.type === "ports") for (const p of m.ports) journal.ports.add(p);
  else if (m.type === "process") journal.known.set(m.pid, m.started);
  else if (m.type === "stack") {
    journal.current = m;
    journal.judged = null;
  } else if (m.type === "judged") journal.judged = m;
  else if (m.type === "stack-end") {
    journal.current = null;
    journal.judged = null;
  } else if (m.type === "released") released = m;
});
lines.on("close", () => {
  if (released) process.exit(0);
  void takeOver("the runner ended without releasing its journal");
});
// It shares no group with the runner, so a terminal's Ctrl-C does not reach it; a direct TERM means "clean up now".
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => void takeOver("the reaper received SIGTERM"));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listening = (port) =>
  new Promise((resolveCheck) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });

/** A plain, bounded docker CLI call (the reaper's commands are its own; they carry no mark). */
const dockerRun = (args, { input, timeoutMs = 60_000 } = {}) =>
  new Promise((resolveRun) => {
    const child = spawn("docker", args, {
      env: { ...process.env, DOCKER_CONTEXT },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveRun({ status: null, stdout, stderr: String(error) });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({
        status,
        signal,
        stdout,
        stderr,
        timedOut: signal === "SIGKILL",
      });
    });
  });

function takeOver(why) {
  taking ??= (async () => {
    const startedAt = Date.now();
    const result = {
      controller_lost: true,
      reason: why,
      at: new Date().toISOString(),
      runner_pid: runnerPid,
    };
    say(`${why}; finishing the clean-up`);
    const hardStop = setTimeout(() => {
      result.deadline_reached = true;
      finish(result);
    }, DEADLINE_MS);
    hardStop.unref();
    // 1. The runner itself is gone (a closed journal with a live runner is recorded, and the clean-up still goes on).
    result.runner_alive = true;
    for (let i = 0; i < 50; i += 1) {
      try {
        if (!processTable().some((r) => r.pid === runnerPid && !r.zombie)) {
          result.runner_alive = false;
          break;
        }
      } catch {
        result.runner_alive = null; // unknown
        break;
      }
      await pause(100);
    }
    // 2. Every process with the runner's mark, every member it remembered (same pid AND start time) and their live descendants.
    const never = new Set([process.pid]);
    let inventory = "complete";
    const scan = () => {
      try {
        const rows = processTable();
        const marks = new Set();
        for (const row of rows)
          for (const m of row.marks)
            if (m.startsWith(`${token}=`)) marks.add(m);
        return membersOf({ table: rows, marks, known: journal.known, never });
      } catch (error) {
        inventory = "unknown";
        result.process_error = String(error?.message ?? error);
        return null;
      }
    };
    const before = scan();
    const stopped = await stopMembers({
      scan,
      graceMs: 3000,
      killWaitMs: 3000,
    });
    const left = scan();
    result.processes = {
      members: before ? [...before.keys()] : null,
      signalled: stopped.signalled,
      frozen: stopped.frozen,
      escalated: stopped.escalated,
      survivors: left ? [...left.keys()] : null,
      inventory,
      ok: inventory === "complete" && left !== null && left.size === 0,
    };
    // 3. Docker: everything labelled with the invocation, then verified.
    if (journal.docker && journal.invocation) {
      result.docker = await disposeLabelled(dockerClient(dockerRun), {
        filter: `${LABEL_INVOCATION}=${journal.invocation}`,
      });
    }
    // 4. Disposable directories and ports.
    result.tmp = [];
    for (const path of journal.tmp) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        result.tmp_error = String(error?.message ?? error);
      }
      result.tmp.push({ path, removed: !existsSync(path) });
    }
    const still = [];
    for (const port of journal.ports)
      if (await listening(port)) still.push(port);
    result.listeners_left = still;
    result.ms = Date.now() - startedAt;
    result.ok =
      result.processes.ok &&
      (result.docker?.ok ?? true) &&
      result.tmp.every((t) => t.removed) &&
      still.length === 0;
    clearTimeout(hardStop);
    finish(result);
  })();
  return taking;
}

let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  try {
    writeFileSync(
      join(runDir, "reaper.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } catch (error) {
    say(`could not write reaper.json: ${error?.message ?? error}`);
  }
  try {
    completeSummary(result);
  } catch (error) {
    say(`could not complete summary.json: ${error?.message ?? error}`);
  }
  say(
    `clean-up ${result.ok ? "verified" : "NOT verified"} (${join(runDir, "reaper.json")})`,
  );
  process.exit(result.ok ? 0 : 1);
}

/**
 * The runner's summary, completed as the runner would have (review r7 H4c: with the same reducer): never a pass, every planned stack
 * accounted for, and what the current stack had established (its journalled checkpoint) kept through this take-over. A runner that
 * may still be running owns its summary: it is not rewritten (`reaper.json` says what this process did).
 */
function completeSummary(result) {
  const path = join(runDir, "summary.json");
  if (result.runner_alive !== false) {
    say(
      `the runner may still be running (pid ${runnerPid}); its summary is left to it`,
    );
    return;
  }
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The runner died before its first summary: start from who it was.
    let invocation = { run_dir: runDir };
    try {
      invocation = JSON.parse(
        readFileSync(join(runDir, "invocation.json"), "utf8"),
      );
    } catch {
      // not even that was written
    }
    summary = { schema: 3, invocation, stacks: [] };
  }
  if (summary.invocation?.finished) {
    summary.reaper = { ok: result.ok, file: join(runDir, "reaper.json") };
    if (!result.ok) {
      // A clean-up this process could not verify is a failure of the run, whatever the runner had concluded before it died.
      summary.cleanup_failed = true;
      if (summary.outcome !== "failed" && summary.outcome !== "plan_error") {
        summary.outcome_before_reaper = summary.outcome;
        summary.outcome = "failed";
      }
    }
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const records = summary.stacks ?? [];
  const has = (browser, index) =>
    records.some((r) => r.browser === browser && r.index === index);
  const current = journal.current;
  if (current && !has(current.browser, current.index)) {
    const judged =
      journal.judged?.browser === current.browser &&
      journal.judged?.index === current.index
        ? journal.judged.record
        : null;
    records.push({
      browser: current.browser,
      stack: current.stack,
      index: current.index,
      ...settleStack(
        judged ?? { outcome: "cancelled", reason: `stopped: ${result.reason}` },
        { stop: result.reason, cleanup: { by: "reaper", ok: result.ok } },
      ),
    });
  }
  let planned = null;
  try {
    planned = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8"));
  } catch {
    // no plan was written: nothing was planned
  }
  for (const browser of planned?.browsers ?? [])
    for (const [index, { stack }] of (planned?.stacks ?? []).entries())
      if (!has(browser, index))
        records.push({
          browser,
          stack,
          index,
          outcome: "not_run",
          reason: `not launched: the runner ended (${result.reason})`,
        });
  const outcome = overall(records, {
    signalled: result.reason,
    planned: records.length,
    failures: [
      ...(summary.evidence_errors ?? []),
      ...(result.ok ? [] : ["the reaper's clean-up was not verified"]),
    ],
  });
  Object.assign(summary, {
    invocation: { ...summary.invocation, finished: true },
    // The controller was lost, so the run is never a pass.
    outcome: outcome === "passed" ? "cancelled" : outcome,
    controller_lost: true,
    stacks: records,
    cleanup_failed: !result.ok || Boolean(summary.cleanup_failed),
    reaper: { ok: result.ok, file: join(runDir, "reaper.json") },
  });
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(path, text);
  if (journal.evidence)
    try {
      writeFileSync(join(journal.evidence, "summary.json"), text, {
        flag: "wx",
      });
    } catch {
      // an existing parent summary is left as it is
    }
}

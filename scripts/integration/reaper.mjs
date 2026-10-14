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
// Review r8 H4d (revision 9): the runner COMMITS each stack's record (stack-records.mjs) before it journals that the stack ended,
// and the journal names the committed sequence. This process keeps a checkpoint per stack (never one scalar a later stack or a
// duplicate message could clear) and retires one only when it can read that stack's committed, settled record at that sequence
// (a bare or unconfirmed "stack-end" retires nothing). On a take-over the committed records are the authority: they are merged
// with the summary (a projection) and with any newer checkpoint by the one fact merger; a stack whose launch was committed but whose
// judgement was not is judged from its raw report (only what the report independently proves); an unreadable record or summary is
// an evidence failure, never a smaller run. Its own evidence that cannot be written fails it (exit 1) whatever its clean-up did.
//
// Review r9 H4e (revision 10): a checkpoint is never retired. Revision 9 deleted a stack's checkpoint on an acknowledgement of an older
// committed version and compared a failed write's `seq: null` as 0, so an older settled record hid a newer failure whose write had
// failed. Now each checkpoint accumulates every journalled observation of its stack for the whole run (joined by observation ordinal,
// stack-records.mjs), a `stack-end` is only recorded (`acknowledged`), and on a take-over a durable record is complete only when it
// COVERS the checkpoint (its ordinal is at least the newest observed); otherwise the stack is recovered from both. A summary the runner
// marked finished is kept as it is only when it says the run was quiescent and covers every record, checkpoint and run-level error this
// process knows; otherwise it is reconciled like any other (its outcome and its projection recomputed). Run-level evidence failures
// are journalled (`run-error`) and the runner's `summary-error.json` contributes its stacks too.
//
// Review r10 H4f (revision 11): revision 10 read a file that could not be read or parsed as if it were absent (`null`), so its
// terminal shortcut kept a finished summary as a pass beside a `summary-error.json` it could not read. Every run file is now read as
// absent, present or unreadable (evidence-inputs.mjs) before anything is decided; only absence is absence. Whether the finished summary
// covers the stacks decides only whether stacks must be recovered: BOTH that path and the reconciliation go through one run-level
// reduction (`render`), which takes every evidence failure known (the summary's, summary-error.json's, the journal's, and this
// process's own reads, commits and writes, a damaged journal line included) and an established failure or clean-up failure is never
// relabelled as less. A failure found after the summary was written (its parent copy, reaper.json) publishes it once more.
//
//   node scripts/integration/reaper.mjs <run dir> <token> <runner pid>      (journal on stdin; started by run.mjs, never by hand)
import { execFileSync, spawn } from "node:child_process";
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
import { readEvidence, SHAPES } from "./evidence-inputs.mjs";
import {
  cleanupFailed,
  judge,
  mergeFacts,
  overall,
  project,
  settleStack,
  withCancellation,
} from "./outcome.mjs";
import { membersOf, processTable, stopMembers } from "./ownership.mjs";
import {
  covers,
  createStackStore,
  joinVersions,
  observation,
  publishAtomically,
  readStackRecord,
  readStackRecords,
  stackFile,
  stackKey,
} from "./stack-records.mjs";

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
  // Review r8 H4d: one checkpoint per stack. Review r9 H4e: key -> { browser, index, stack, facts, obs }, every observation of the stack
  // joined, kept for the whole run (an acknowledgement is recorded, never a reason to forget what was observed).
  checkpoints: new Map(),
  acknowledged: [],
  runErrors: [],
  // Review r10 H4f (revision 11): non-empty lines that are not a journal message (torn, not JSON, not an object with a type): what they
  // said is unknown, which is an evidence failure of a take-over, never "nothing was said".
  damaged: [],
  handover: null,
  evidence: null,
};
const isMessage = (m) =>
  m !== null &&
  typeof m === "object" &&
  !Array.isArray(m) &&
  typeof m.type === "string" &&
  (!["stack", "judged", "stack-end"].includes(m.type) ||
    (typeof m.browser === "string" && Number.isInteger(m.index))) &&
  (m.type !== "judged" ||
    (m.record !== null &&
      typeof m.record === "object" &&
      !Array.isArray(m.record))) &&
  (m.type !== "run-error" || typeof m.reason === "string");
let released = null;
let taking = null;
/** Does the runner's committed record of (browser, index) show it settled at sequence `seq` or later? (Recorded, never acted on.) */
const committedSettled = (browser, index, seq) => {
  if (typeof seq !== "number") return false;
  const record = readStackRecord(stackFile(runDir, browser, index));
  return (
    record !== null &&
    !record.unreadable &&
    record.phase === "settled" &&
    (record.seq ?? 0) >= seq
  );
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    m = undefined;
  }
  if (!isMessage(m)) {
    journal.damaged.push(line.slice(0, 200));
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
    const key = stackKey(m.browser, m.index);
    if (!journal.checkpoints.has(key))
      journal.checkpoints.set(key, {
        browser: m.browser,
        index: m.index,
        stack: m.stack,
        facts: null,
        obs: -1,
      });
  } else if (m.type === "judged") {
    const key = stackKey(m.browser, m.index);
    const cp = journal.checkpoints.get(key) ?? {
      browser: m.browser,
      index: m.index,
      stack: m.record?.stack ?? null,
      facts: null,
      obs: -1,
    };
    // Every observation is joined by its ordinal: a late or repeated one adds what it knew and never reverts newer fields; one without
    // an ordinal (an older runner) is taken in the order it came.
    const facts = {
      ...m.record,
      ...(Number.isInteger(m.obs) ? { obs: m.obs } : {}),
    };
    cp.facts = joinVersions(cp.facts, facts);
    cp.obs = Math.max(cp.obs, observation(facts));
    journal.checkpoints.set(key, cp);
  } else if (m.type === "stack-end") {
    journal.acknowledged.push({
      key: stackKey(m.browser, m.index),
      seq: m.seq ?? null,
      confirmed: committedSettled(m.browser, m.index, m.seq),
    });
  } else if (m.type === "run-error") {
    if (!journal.runErrors.includes(m.reason)) journal.runErrors.push(m.reason);
  } else if (m.type === "handover") {
    journal.handover = m.reason ?? "handed over";
  } else if (m.type === "released") released = m;
});
lines.on("close", () => {
  if (released) process.exit(0);
  void takeOver("the runner ended without releasing its journal");
});
// It shares no group with the runner, so a terminal's Ctrl-C does not reach it; a direct TERM means "clean up now".
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => void takeOver("the reaper received SIGTERM"));

// The runner's identity: its pid AND its start time, read (after the handlers above, so a stop is never lost to it) while the runner
// is certainly alive (it started this process). A pid alone could be another process's later; a start time that cannot be read
// leaves the pid as the identity, as before. The same C-locale `lstart` as ownership.mjs's process table.
let runnerStarted = null;
try {
  runnerStarted =
    execFileSync("ps", ["-o", "lstart=", "-p", String(runnerPid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim() || null;
} catch {
  // unknown: the pid alone identifies it
}

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
const dockerRun = (args, { input, timeoutMs = 60_000, hold } = {}) =>
  new Promise((resolveRun) => {
    const child = spawn("docker", args, {
      env: { ...process.env, DOCKER_CONTEXT },
      // `hold`: an image lock's descriptor, kept open by the command while it runs (docker-resources.mjs).
      stdio: [
        input === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
        ...(hold === undefined ? [] : [hold]),
      ],
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
      ...(journal.handover ? { handover: journal.handover } : {}),
    };
    say(`${why}; finishing the clean-up`);
    const hardStop = setTimeout(() => {
      result.deadline_reached = true;
      finish(result);
    }, DEADLINE_MS);
    hardStop.unref();
    // 1. The runner itself is gone (a closed journal with a live runner is recorded, and the clean-up still goes on). Its identity
    // is its pid and start time: a row with that pid but another start time is another process.
    result.runner_alive = true;
    result.runner_started = runnerStarted;
    for (let i = 0; i < 50; i += 1) {
      try {
        if (
          !processTable().some(
            (r) =>
              r.pid === runnerPid &&
              !r.zombie &&
              (runnerStarted === null || r.started === runnerStarted),
          )
        ) {
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
  // Review r8 H4d: evidence that cannot be written is a failure of this process of its own, whatever its clean-up did. Review r10 H4f
  // (revision 11): each output carries every evidence failure known when it is written; a failure found after an output was written
  // (the parent copy, reaper.json, the other output) publishes that output once more. Bounded: no output is written more than twice,
  // and stderr and the exit code are the last channel.
  const evidenceErrors = [];
  let draft = null;
  try {
    draft = completeSummary(result, evidenceErrors);
  } catch (error) {
    evidenceErrors.push(`summary.json: ${String(error?.message ?? error)}`);
  }
  result.acknowledged = journal.acknowledged;
  if (journal.damaged.length > 0) result.journal_damaged = journal.damaged;
  // Whether the runner's finished summary covered every stack (only the release was lost), so no stack was recovered.
  if (draft) result.summary_covered = draft.complete;
  // How many evidence failures the output written last covers (null: never written).
  const covering = { summary: null, reaper: null };
  const publishSummary = () => {
    const known = evidenceErrors.length;
    let text = null;
    try {
      text = `${JSON.stringify(draft.render(evidenceErrors.slice(0, known)), null, 2)}\n`;
      publishAtomically(join(runDir, "summary.json"), text);
      covering.summary = known;
      return text;
    } catch (error) {
      evidenceErrors.push(`summary.json: ${String(error?.message ?? error)}`);
      return null;
    }
  };
  const publishReaper = () => {
    const known = evidenceErrors.length;
    result.evidence_errors = evidenceErrors.slice(0, known);
    try {
      publishAtomically(
        join(runDir, "reaper.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      covering.reaper = known;
    } catch (error) {
      evidenceErrors.push(`reaper.json: ${String(error?.message ?? error)}`);
    }
  };
  if (draft) {
    const text = publishSummary();
    // The parent folder's copy is a convenience (the first run's summary is kept there; this run's is in its own folder): an existing
    // one is left as it is; any other failure to write it is an evidence failure, not "it already exists".
    if (text !== null && journal.evidence)
      try {
        writeFileSync(join(journal.evidence, "summary.json"), text, {
          flag: "wx",
        });
      } catch (error) {
        if (error?.code !== "EEXIST")
          evidenceErrors.push(
            `the parent summary.json copy could not be written: ${String(error?.message ?? error)}`,
          );
      }
  }
  publishReaper();
  if (
    draft &&
    covering.summary !== null &&
    covering.summary < evidenceErrors.length
  )
    publishSummary();
  if (covering.reaper !== null && covering.reaper < evidenceErrors.length)
    publishReaper();
  for (const error of evidenceErrors) say(`evidence NOT written: ${error}`);
  say(
    `clean-up ${result.ok ? "verified" : "NOT verified"}${evidenceErrors.length > 0 ? "; its evidence was NOT completely written" : ""} (${join(runDir, "reaper.json")})`,
  );
  process.exit(result.ok && evidenceErrors.length === 0 ? 0 : 1);
}

/** The planned cases of (browser, index), from the run's plan.json (null when it cannot be read). */
function plannedCases(planned, browser, index) {
  const cases = planned?.stacks?.[index]?.cases;
  if (!Array.isArray(cases)) return null;
  return cases.filter(
    (c) => !c.project || c.project === `integration-${browser}`,
  );
}

/**
 * The record of a stack the runner did not finish, from what was committed and journalled (`base`: both joined by observation):
 * settled by the same reducer, with the take-over as its stop and this process's clean-up. A stack whose launch was committed but
 * whose judgement was not is judged from its raw report first, with the stop latched (so only what the report proves independently is
 * a failure: a failed case, an error in the report).
 */
function recoverStack(base, cp, planned, result) {
  // Started or launched, never judged: what the raw report proves on its own is all that is known.
  if (base?.outcome === "running") {
    const launched = base.launched_at ?? null;
    const expected = plannedCases(
      planned,
      cp?.browser ?? base?.browser,
      cp?.index ?? base?.index,
    );
    if (launched !== null && base?.report && expected !== null) {
      let report = null;
      let readError = null;
      try {
        report = JSON.parse(readFileSync(base.report, "utf8"));
      } catch (error) {
        readError = String(error?.message ?? error);
      }
      base = mergeFacts(base, {
        ...withCancellation(
          judge({
            expected,
            report,
            readError,
            exit: { code: null, signal: null },
            launchedAt: launched,
            stop: result.reason,
          }),
          result.reason,
        ),
        report: base.report,
        judged_by: "reaper",
      });
    }
  }
  if (!base || base.outcome === "running")
    base = mergeFacts(base, {
      outcome: "cancelled",
      reason: `stopped: ${result.reason}`,
    });
  return settleStack(base, {
    stop: result.reason,
    cleanup: { by: "reaper", ok: result.ok },
  });
}

/** The outcomes a runner's terminal summary concludes with. */
const TERMINAL = ["passed", "failed", "cancelled", "plan_error"];
/** Outcomes that are established failures: a recovery never relabels them as anything less. */
const FAILED = ["failed", "plan_error"];
const unique = (xs) => [...new Set(xs)];
const firstLine = (text) => String(text ?? "unknown").split("\n")[0];

/**
 * The runner's summary, completed as the runner would have (review r7 H4c: with the same reducer; review r8 H4d: from the committed
 * stack records): never a pass, every planned stack accounted for, and every fact any stack committed or journalled kept through this
 * take-over. A runner that may still be running owns its summary: it is not rewritten (`reaper.json` says what this process did), and
 * null is returned.
 *
 * Review r9 H4e (revision 10): every source is read before anything is decided: the summary, the committed records, the runner's
 * `summary-error.json` (its error and its stacks), the checkpoints and the journalled run-level errors. A finished summary covers its
 * stacks only when it is the runner's quiescent terminal summary and covers all of them (only the release was lost); otherwise they
 * are reconciled, and outcome, first failure and engine counts are computed again from the reconciled records.
 *
 * Review r10 H4f (revision 11): each file is read as absent, present or unreadable (a read, parse or shape failure), and every
 * unreadable one is an evidence failure; a summary-error.json in ANY state means the runner could not publish its summary. A plan that
 * cannot be read, or that is missing although the summary records a selection, leaves the planned stacks unknown (`plan_unknown`):
 * no empty plan, no invented `not_run` entries; a run lost before it planned (no plan, no selection) still plans nothing. Covering
 * decides only whether stacks are recovered. What is returned is a draft whose `render(errors)` is the ONE run-level reduction of both
 * paths: every evidence failure (the summary's, summary-error.json's, the journal's and `errors`, this process's own, which `finish`
 * passes as they are when the summary is written), the clean-up of the run and of every record, and an outcome that never goes below
 * an established failure.
 */
function completeSummary(result, evidenceErrors) {
  if (result.runner_alive !== false) {
    say(
      `the runner may still be running (pid ${runnerPid}); its summary is left to it`,
    );
    return null;
  }
  // 1. Every source, each absent, present or unreadable; nothing is decided before all of them are read.
  const read = (name, what, shape) =>
    readEvidence(join(runDir, name), { what, shape });
  const summaryIn = read(
    "summary.json",
    "the runner's summary.json",
    SHAPES.summary,
  );
  const invocationIn = read(
    "invocation.json",
    "the runner's invocation.json",
    SHAPES.invocation,
  );
  const failedIn = read(
    "summary-error.json",
    "the runner's summary-error.json",
    SHAPES.summaryError,
  );
  const planIn = read("plan.json", "the run's plan.json", SHAPES.plan);
  const { records: durable, errors: unreadable } = readStackRecords(runDir);
  for (const input of [summaryIn, invocationIn, failedIn, planIn])
    if (input.state === "unreadable") evidenceErrors.push(input.error);
  for (const e of unreadable)
    evidenceErrors.push(`a stack record could not be read: ${e}`);
  if (journal.damaged.length > 0)
    evidenceErrors.push(
      `${journal.damaged.length} journal line(s) could not be read, so what they said is unknown (the first: ${JSON.stringify(journal.damaged[0])})`,
    );
  // The runner writes summary-error.json only when it could not publish its summary: that is an evidence failure of the run, whether
  // or not the file can be read, and the stacks it could not publish are evidence too.
  const failed = failedIn.state === "present" ? failedIn.value : null;
  if (failedIn.state !== "absent")
    evidenceErrors.push(
      `the runner could not write its summary: ${failed ? firstLine(failed.error) : "its summary-error.json cannot be read"}`,
    );
  // No usable summary yet (none, or one that cannot be read: an evidence failure, recorded above): start from who the runner was.
  const summary =
    summaryIn.state === "present"
      ? summaryIn.value
      : {
          schema: 3,
          invocation:
            invocationIn.state === "present"
              ? invocationIn.value
              : { run_dir: runDir },
          stacks: [],
        };
  const planned = planIn.state === "present" ? planIn.value : null;
  let planUnknown = planIn.state === "unreadable";
  if (planIn.state === "absent" && summary.selection) {
    planUnknown = true;
    evidenceErrors.push(
      "the run's plan.json is missing although its summary records a selection: its planned stacks are unknown",
    );
  }
  const runErrors = unique([
    ...(summary.evidence_errors ?? []),
    ...(failed?.evidence_errors ?? []),
    ...journal.runErrors,
  ]);
  // The summary's records, then every committed record and every record of summary-error.json, joined by observation.
  const byKey = new Map();
  const put = (r) => {
    if (!r?.browser) return;
    const key = stackKey(r.browser, r.index);
    byKey.set(key, joinVersions(byKey.get(key), r));
  };
  const projected = new Map();
  for (const r of summary.stacks ?? []) {
    put(r);
    projected.set(stackKey(r.browser, r.index), r);
  }
  // 2. Does the finished summary cover the stacks? Only the runner's quiescent terminal summary with nothing newer or unknown beside it:
  // every record readable and covered, every checkpoint covered, no summary-error.json in any state (the stacks of one that cannot be
  // read are unknown), no damaged journal line, no journalled error it lacks. Then only the release was lost and no stack is recovered.
  const complete =
    summaryIn.state === "present" &&
    summary.invocation?.finished === true &&
    summary.terminal?.quiescent === true &&
    TERMINAL.includes(summary.outcome) &&
    unreadable.length === 0 &&
    failedIn.state === "absent" &&
    journal.damaged.length === 0 &&
    journal.runErrors.every((e) =>
      (summary.evidence_errors ?? []).includes(e),
    ) &&
    [...durable].every(([key, r]) => covers(projected.get(key), r)) &&
    [...journal.checkpoints].every(([key, cp]) =>
      covers(projected.get(key), cp.facts),
    );
  let records = summary.stacks ?? [];
  let candidate = summary.outcome;
  if (!complete) {
    for (const r of durable.values()) put(r);
    for (const r of failed?.stacks ?? []) put(r);
    const store = createStackStore(runDir);
    const keys = new Set([
      ...journal.checkpoints.keys(),
      ...[...durable.values()]
        .filter((r) => r.phase !== "settled")
        .map((r) => r.key),
    ]);
    for (const key of keys) {
      const cp = journal.checkpoints.get(key) ?? null;
      const record = durable.get(key) ?? null;
      // Complete only when committed after its own clean-up AND covering everything observed of the stack.
      if (record?.phase === "settled" && covers(record, cp?.facts ?? null))
        continue;
      const recovered = recoverStack(
        joinVersions(record, cp?.facts ?? null),
        cp,
        planned,
        result,
      );
      // The recovered version is a new observation, covering every one it joined.
      const obs =
        Math.max(
          observation(record),
          cp?.obs ?? -1,
          observation(byKey.get(key)),
        ) + 1;
      let committed = { ...recovered, obs };
      try {
        committed = store.commit(
          {
            ...recovered,
            obs,
            browser: cp?.browser ?? record?.browser,
            index: cp?.index ?? record?.index,
            stack: cp?.stack ?? record?.stack,
            recovered_by: "reaper",
          },
          "settled",
        );
      } catch (error) {
        evidenceErrors.push(
          `the recovered record of ${key} could not be committed: ${String(error?.message ?? error)}`,
        );
      }
      byKey.set(key, joinVersions(byKey.get(key), committed));
    }
    records = [...byKey.values()];
    const has = (browser, index) =>
      records.some((r) => r.browser === browser && r.index === index);
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
    records.sort(
      (a, b) =>
        (planned?.browsers ?? []).indexOf(a.browser) -
          (planned?.browsers ?? []).indexOf(b.browser) || a.index - b.index,
    );
    // The controller was lost before a terminal summary that covers everything, so the stacks never make a pass.
    const stacksOutcome = overall(records, {
      signalled: result.reason,
      planned: records.length,
    });
    candidate = stacksOutcome === "passed" ? "cancelled" : stacksOutcome;
  }
  const finishedBefore =
    summaryIn.state === "present" && summary.invocation?.finished === true;
  // 3. The one run-level reduction, for both paths.
  const render = (errors) => {
    const failures = unique([...runErrors, ...errors]);
    const cleanupNotVerified =
      !result.ok ||
      summary.cleanup_failed === true ||
      records.some(cleanupFailed);
    const outcome = FAILED.includes(summary.outcome)
      ? summary.outcome
      : failures.length > 0 || cleanupNotVerified
        ? "failed"
        : candidate;
    return {
      ...summary,
      ...(complete
        ? {}
        : {
            invocation: { ...summary.invocation, finished: true },
            ...project(records, {
              browsers: planned?.browsers ?? [
                ...new Set(records.map((r) => r.browser)),
              ],
              planned: planned?.stacks?.length,
            }),
            controller_lost: true,
            ...(finishedBefore ? { reconciled_after_finish: true } : {}),
            stacks: records,
          }),
      ...(finishedBefore && summary.outcome !== outcome
        ? { outcome_before_reaper: summary.outcome }
        : {}),
      outcome,
      ...(planUnknown ? { plan_unknown: true } : {}),
      evidence_errors: failures,
      cleanup_failed: cleanupNotVerified,
      reaper: { ok: result.ok, file: join(runDir, "reaper.json") },
    };
  };
  return { complete, render };
}

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
// Revision 12 (review r11 design assessment C3): a qualification seam for that bounded republication. Only when
// ATLAS_INTEGRATION_FAULTS names `reaper_publish_fail: { "<summary.json|reaper.json>": [n, ...] }` (faults.mjs; no maintained caller
// sets it) does the n-th publication attempt of that output fail after its complete sibling was written, recorded first as
// `<run dir>/faults/reaper-publish-<output>-<n>.failed`. The attempt is chosen by destination and ordinal, never by time.
//
// Review r12 H4g (revision 13): a later recovery of the same run erased what an earlier one had recorded. The earlier recovery's
// summary republication had failed, so its `reaper.json` was the only witness of its failures; the next recovery did not read it,
// found the old summary covered, published a pass, replaced `reaper.json` with its own (empty) failures and exited 0. Now
// (recovery-history.mjs) every recovery takes an attempt number, waits until every earlier attempt has ended (it never overtakes one
// that may still be running: it refuses to replace anything instead), and reads the previous `reaper.json` and every earlier attempt's
// record, each absent, present or unreadable, BEFORE anything is decided. What they established is one history that only grows: their
// evidence failures and unverified clean-ups, the run-level failures and outcome they published. It goes into the one run-level
// reduction (`render`), into `reaper.json` (`recovery_history`, `run_evidence_errors`, `run_outcome`; `evidence_errors` stays this
// recovery's own) and into the exit code: a recovery after a failed one never exits 0. The previous `reaper.json` is kept (hard link)
// before it is replaced, and each attempt finally writes its own record, which nothing replaces. ATLAS_REAPER_ORDER_WAIT_MS bounds the
// wait (default 30 s). Qualification seam: `reaper_hold_inputs: [n]` holds attempt n after it has read everything and before it
// publishes (faults.mjs).
//
// Review r13 H4h (revision 14): an unreadable record of a still-running earlier attempt (a directory at `recoveries/<n>.json`) let the
// next recovery publish before it, and the earlier one then replaced the failed outputs with its older pass. A recovery now goes on
// only once every earlier claimant is known to have ended, whatever its record pathname holds (recovery-history.mjs `awaitEarlier`);
// a claim that could not be read while it waited is one of its evidence failures.
//
// Review r14 H4i (revision 15): an earlier attempt's record that could not be read when this recovery was admitted, and could when its
// history was read, left no trace. What the admission read established (its error, an unverified earlier clean-up) is now joined with
// the history before anything is decided, also on a refusal; a later successful read never takes a failure away. The design
// assessment's neighbour (C3/Q9): a committed stack record that cannot be read when its `stack-end` arrives was only
// `confirmed: false`, so a later healthy read on a take-over forgot it. The acknowledgement keeps it (`unreadable`) and a take-over
// makes it one of its evidence failures; on a release this process publishes nothing (the runner's terminal summary is the evidence)
// and says it on stderr.
//
// Review r15 H4j (revision 16): on a release that failure still reached no verdict (the runner had published its summary and ignored
// how this process ended). Now what this process observes is returned to the runner through a durable receipt (observer.mjs,
// `<run dir>/observer.json`): the runner journals a `barrier` after each stack's end and before its terminal summary, and this process,
// having handled every line before it, publishes every failure it has observed (an acknowledgement read, a damaged journal line, a
// barrier of another invocation, a receipt it could not publish). On a release it publishes the terminal receipt and exits 1 when it
// holds any failure; the runner consumes that receipt and the exit. A recovery reads the receipt too (`completeSummary`). Qualification
// seam `reaper_release` ("exit", "kill", "linger"): how this process ends after its terminal receipt (faults.mjs).
//
//   node scripts/integration/reaper.mjs <run dir> <token> <runner pid>      (journal on stdin; started by run.mjs, never by hand)
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { OBSERVER_FILE, receiptText } from "./observer.mjs";
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
  awaitEarlier,
  claimAttempt,
  EMPTY,
  entryOf,
  joinHistory,
  keepPrevious,
  readHistory,
  recordAttempt,
  serialise,
  startedOf,
} from "./recovery-history.mjs";
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
// Revision 13: how long a recovery waits for an earlier recovery of the same run to end before it refuses to publish.
const ORDER_WAIT_MS = Number(process.env.ATLAS_REAPER_ORDER_WAIT_MS ?? 30_000);
// Revision 12: `reaper_publish_fail` of ATLAS_INTEGRATION_FAULTS (see the header); revision 13: `reaper_hold_inputs`. A specification
// that cannot be read applies no fault (this process's clean-up must not depend on it) and is said on stderr.
let publishFaults = {};
let holdInputs = [];
// Revision 16: `reaper_release`.
let releaseFault = null;
try {
  const spec = JSON.parse(process.env.ATLAS_INTEGRATION_FAULTS || "{}");
  publishFaults = spec?.reaper_publish_fail ?? {};
  holdInputs = spec?.reaper_hold_inputs ?? [];
  releaseFault = spec?.reaper_release ?? null;
} catch (error) {
  process.stderr.write(
    `reaper: ATLAS_INTEGRATION_FAULTS could not be read, no publication fault applies: ${String(error?.message ?? error)}\n`,
  );
}
/** Block this process for `ms` (the end of a recovery is synchronous: nothing else may run between what it reads and what it writes). */
const block = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * Revision 13 seam `reaper_hold_inputs`: attempt n, having read everything, writes `<run dir>/faults/reaper-hold-inputs-<n>.reached` and
 * waits for `...release` (at most the reaper's deadline) before it publishes.
 */
function holdAfterInputs(attempt) {
  if (attempt === null || !holdInputs.includes(attempt)) return;
  const faults = join(runDir, "faults");
  mkdirSync(faults, { recursive: true });
  const name = join(faults, `reaper-hold-inputs-${attempt}`);
  writeFileSync(`${name}.reached`, `${Date.now()}\n`);
  const until = Date.now() + DEADLINE_MS;
  while (!existsSync(`${name}.release`) && Date.now() < until) block(25);
}
const publishAttempts = new Map();
/** Publish `<run dir>/<name>` atomically; the n-th attempt fails when `reaper_publish_fail` names it. */
function publishOutput(name, text) {
  const n = (publishAttempts.get(name) ?? 0) + 1;
  publishAttempts.set(name, n);
  const injected = (publishFaults[name] ?? []).includes(n);
  publishAtomically(join(runDir, name), text, {
    fail: injected
      ? () => {
          const faults = join(runDir, "faults");
          mkdirSync(faults, { recursive: true });
          writeFileSync(
            join(
              faults,
              `reaper-publish-${name.replaceAll(/[^a-z0-9-]/gi, "-")}-${n}.failed`,
            ),
            `${Date.now()}\n`,
          );
          throw new Error(`injected failure publishing ${name} (attempt ${n})`);
        }
      : null,
  });
}
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
  // Revision 16 (review r15 H4j): barriers that do not belong to this journal (another invocation), as evidence failures.
  protocol: [],
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
  (m.type !== "run-error" || typeof m.reason === "string") &&
  (m.type !== "barrier" || Number.isInteger(m.id));
let released = null;
let taking = null;
/**
 * Does the runner's committed record of (browser, index) show it settled at sequence `seq` or later? (Recorded, never acted on.)
 * { confirmed } and, when the record could not be read, `unreadable` (why): revision 15, an observed read failure is kept.
 */
const committedSettled = (browser, index, seq) => {
  if (typeof seq !== "number") return { confirmed: false };
  const record = readStackRecord(stackFile(runDir, browser, index));
  if (record?.unreadable)
    return { confirmed: false, unreadable: record.unreadable };
  return {
    confirmed:
      record !== null && record.phase === "settled" && (record.seq ?? 0) >= seq,
  };
};
/** The acknowledgements whose committed record could not be read, as evidence failures. */
const unreadableAcknowledgements = () =>
  journal.acknowledged
    .filter((a) => a.unreadable !== undefined)
    .map(
      (a) =>
        `the committed record of ${a.key} could not be read when its stack-end was journalled: ${a.unreadable}`,
    );
/** Review r10 H4f: damaged journal lines, as one evidence failure (what they said is unknown). */
const damagedError = () =>
  `${journal.damaged.length} journal line(s) could not be read, so what they said is unknown (the first: ${JSON.stringify(journal.damaged[0])})`;
// Revision 16 (review r15 H4j): the newest barrier answered, and the receipts this process could not publish.
let barrier = 0;
const receiptErrors = [];
/** Every failure this process has observed of the run's evidence, as returned to the runner (cumulative: it never shrinks). */
const observerErrors = () =>
  unique([
    ...unreadableAcknowledgements(),
    ...(journal.damaged.length > 0 ? [damagedError()] : []),
    ...journal.protocol,
    ...receiptErrors,
  ]);
/** Publish the receipt of what this process observed up to `barrier` (observer.mjs); a failure to is kept as one more failure. */
function publishReceipt(phase) {
  try {
    publishOutput(
      OBSERVER_FILE,
      receiptText({
        invocation: journal.invocation ?? "unknown",
        barrier,
        phase,
        errors: observerErrors(),
        acknowledged: journal.acknowledged.length,
        damaged: journal.damaged.length,
      }),
    );
    return true;
  } catch (error) {
    const reason = `${OBSERVER_FILE} could not be published (${phase} ${barrier}): ${String(error?.message ?? error)}`;
    if (!receiptErrors.includes(reason)) receiptErrors.push(reason);
    say(`evidence NOT written: ${reason}`);
    return false;
  }
}
/**
 * Revision 16 (review r15 H4j): the end of a release. The terminal receipt carries every failure observed; this process exits 1 when
 * there is any (also when the receipt itself could not be published), so its status agrees with what the runner consumes.
 */
function endRelease() {
  publishReceipt("released");
  if (releaseFault === "kill") process.kill(process.pid, "SIGKILL");
  if (releaseFault === "exit") process.exit(3);
  if (releaseFault === "linger") block(DEADLINE_MS);
  const errors = observerErrors();
  if (errors.length > 0) {
    say(
      `released with ${errors.length} observed evidence failure(s) (${join(runDir, OBSERVER_FILE)})`,
    );
    process.exit(1);
  }
}

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
      ...committedSettled(m.browser, m.index, m.seq),
    });
  } else if (m.type === "run-error") {
    if (!journal.runErrors.includes(m.reason)) journal.runErrors.push(m.reason);
  } else if (m.type === "handover") {
    journal.handover = m.reason ?? "handed over";
  } else if (m.type === "barrier") {
    // Revision 16: every line before this one has been handled (its reads included); answer with all that was observed.
    if (m.invocation !== journal.invocation) {
      const reason = `a journal barrier named invocation ${m.invocation ?? "(none)"}, not this journal's ${journal.invocation ?? "(none)"}`;
      if (!journal.protocol.includes(reason)) journal.protocol.push(reason);
    }
    barrier = Math.max(barrier, m.id);
    publishReceipt("barrier");
  } else if (m.type === "released") released = m;
});
lines.on("close", () => {
  // Revision 15 (C3/Q9): a release publishes nothing; what this process could not read is said on stderr before it exits.
  if (released)
    for (const error of unique(unreadableAcknowledgements()))
      say(`after the release (the runner's summary is the evidence): ${error}`);
  // Revision 16 (review r15 H4j): the terminal receipt, and exit 1 with any observed failure.
  if (released) endRelease();
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
  // Revision 15 (design assessment r14 C3/Q9): what this process could not read when a stack-end was journalled stays a failure, also
  // when its later read of the same record succeeds.
  evidenceErrors.push(...unique(unreadableAcknowledgements()));
  // Revision 16 (review r15 H4j): and a barrier of another invocation, a receipt it could not publish.
  for (const error of [...journal.protocol, ...receiptErrors])
    if (!evidenceErrors.includes(error)) evidenceErrors.push(error);
  // Review r12 H4g (revision 13): first this recovery's place in the run's order of recoveries (it never overtakes an earlier one that
  // may still be running), then everything the earlier ones established, before anything is decided or replaced.
  let attempt = null;
  let order = { ready: false, waiting: null, errors: [], history: EMPTY };
  try {
    attempt = claimAttempt(runDir, {
      pid: process.pid,
      started: startedOf(process.pid),
      at: result.at,
    });
    order = awaitEarlier(runDir, attempt, {
      waitMs: ORDER_WAIT_MS,
      sleep: block,
    });
  } catch (error) {
    evidenceErrors.push(
      `this recovery could not take its place in the run's order of recoveries: ${String(error?.message ?? error)}`,
    );
  }
  result.attempt = attempt;
  // Review r13 H4h: every claim this recovery could not read while it waited, also one a later poll read. Review r14 H4i (revision 15):
  // and every ended attempt's record it could not read then, also one readHistory reads below.
  evidenceErrors.push(...order.errors);
  if (!order.ready) {
    result.refused = order.waiting
      ? `recovery attempt ${order.waiting.attempt} has not ended (${order.waiting.why})`
      : "its place in the run's order of recoveries is unknown";
    evidenceErrors.push(
      `this recovery replaced nothing: ${result.refused}, and replacing what that recovery writes could erase what it found`,
    );
  }
  // Review r14 H4i (revision 15): what the admission's reads established (an unverified earlier clean-up), joined with what readHistory
  // reads, before anything is decided; a refused recovery's own record carries it too. A failure both reads saw is said once.
  let history = order.history;
  let draft = null;
  if (order.ready) {
    const earlier = readHistory(runDir, attempt, order.ended);
    history = joinHistory(history, earlier.history);
    for (const error of earlier.errors)
      if (!evidenceErrors.includes(error)) evidenceErrors.push(error);
    try {
      draft = completeSummary(result, evidenceErrors, history);
    } catch (error) {
      evidenceErrors.push(`summary.json: ${String(error?.message ?? error)}`);
    }
    try {
      keepPrevious(runDir, attempt);
    } catch (error) {
      evidenceErrors.push(
        `the previous reaper.json could not be kept before it is replaced: ${String(error?.message ?? error)}`,
      );
    }
    holdAfterInputs(attempt);
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
      publishOutput("summary.json", text);
      covering.summary = known;
      return text;
    } catch (error) {
      evidenceErrors.push(`summary.json: ${String(error?.message ?? error)}`);
      return null;
    }
  };
  /**
   * This recovery's record when it knows its first `known` evidence failures: `evidence_errors` are its own (as before revision 13);
   * `recovery_history` joins them, and its clean-up, to every earlier recovery's; `run_evidence_errors` and `run_outcome` are the run's
   * as the one reduction gives them (or, when the summary is the runner's, as far as the recoveries know them).
   */
  const record = (known) => {
    const own = evidenceErrors.slice(0, known);
    const view = draft ? draft.render(own) : null;
    result.evidence_errors = own;
    result.run_evidence_errors = view
      ? view.evidence_errors
      : unique([...history.runErrors, ...history.errors, ...own]);
    result.run_outcome = view ? view.outcome : history.outcome;
    result.recovery_history = serialise(
      joinHistory(history, {
        ...EMPTY,
        errors: own,
        cleanupNotVerified: result.ok !== true,
        attempts: [entryOf(result)],
      }),
    );
    return `${JSON.stringify(result, null, 2)}\n`;
  };
  const publishReaper = () => {
    const known = evidenceErrors.length;
    try {
      publishOutput("reaper.json", record(known));
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
  // A recovery that could not take its place after every earlier one replaces nothing (its own record below is new).
  if (order.ready) publishReaper();
  if (
    draft &&
    covering.summary !== null &&
    covering.summary < evidenceErrors.length
  )
    publishSummary();
  if (covering.reaper !== null && covering.reaper < evidenceErrors.length)
    publishReaper();
  // Revision 13: every attempt leaves its own record, the last thing it writes, which no later attempt replaces. If it cannot be
  // written, a later recovery finds the claim without a record: what this attempt found is then unknown, never clean.
  if (attempt !== null)
    try {
      recordAttempt(runDir, attempt, record(evidenceErrors.length));
    } catch (error) {
      evidenceErrors.push(
        `recovery attempt ${attempt}'s record: ${String(error?.message ?? error)}`,
      );
    }
  for (const error of evidenceErrors) say(`evidence NOT written: ${error}`);
  const earlierFailed = history.errors.length > 0 || history.cleanupNotVerified;
  if (earlierFailed)
    say(
      `an earlier recovery of this run failed (${history.errors.length} evidence failure(s)${history.cleanupNotVerified ? ", a clean-up not verified" : ""}); it stays failed`,
    );
  say(
    `clean-up ${result.ok ? "verified" : "NOT verified"}${evidenceErrors.length > 0 ? "; its evidence was NOT completely written" : ""} (${join(runDir, "reaper.json")})`,
  );
  process.exit(
    result.ok && evidenceErrors.length === 0 && !earlierFailed ? 0 : 1,
  );
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
 *
 * Review r12 H4g (revision 13): `history` is what every earlier recovery of the run established (`finish` reads it first): its
 * failures, its unverified clean-ups and an established failure outcome join the same reduction, so a later recovery never makes less
 * of them, whether or not the summary covers the stacks.
 */
function completeSummary(result, evidenceErrors, history = EMPTY) {
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
  // Revision 16 (review r15 H4j): what the reaper of this run returned to the runner (this process's own, or an earlier reaper's).
  const observerIn = read(
    OBSERVER_FILE,
    "the reaper's observer.json",
    SHAPES.observer,
  );
  const { records: durable, errors: unreadable } = readStackRecords(runDir);
  for (const input of [summaryIn, invocationIn, failedIn, planIn])
    if (input.state === "unreadable") evidenceErrors.push(input.error);
  for (const e of unreadable)
    evidenceErrors.push(`a stack record could not be read: ${e}`);
  if (journal.damaged.length > 0) evidenceErrors.push(damagedError());
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
  // Revision 16: a receipt that cannot be read, of another invocation, or missing or older than the barrier the runner's summary says it
  // covered, is an evidence failure; one from before revision 16 (no barrier in the summary, no receipt) is not.
  if (observerIn.state === "unreadable") evidenceErrors.push(observerIn.error);
  const invocationId =
    journal.invocation ??
    (invocationIn.state === "present" ? invocationIn.value.id : null);
  const observer =
    observerIn.state === "present" &&
    (invocationId === null || observerIn.value.invocation === invocationId)
      ? observerIn.value
      : null;
  if (observerIn.state === "present" && observer === null)
    evidenceErrors.push(
      `the reaper's observer.json names invocation ${observerIn.value.invocation}, not ${invocationId}`,
    );
  const coveredBarrier = summary.terminal?.observer?.barrier;
  if (
    Number.isInteger(coveredBarrier) &&
    observerIn.state !== "unreadable" &&
    (observerIn.state === "absent" || observerIn.value.barrier < coveredBarrier)
  )
    evidenceErrors.push(
      `the runner's summary covers the reaper's barrier ${coveredBarrier}, but observer.json ${observerIn.state === "absent" ? "is missing" : `answers only barrier ${observerIn.value.barrier}`}`,
    );
  const planned = planIn.state === "present" ? planIn.value : null;
  let planUnknown = planIn.state === "unreadable";
  if (planIn.state === "absent" && summary.selection) {
    planUnknown = true;
    evidenceErrors.push(
      "the run's plan.json is missing although its summary records a selection: its planned stacks are unknown",
    );
  }
  // Review r12 H4g (revision 13): with every failure an earlier recovery of the run established (recovery-history.mjs), whichever output
  // it survived in.
  const runErrors = unique([
    ...(summary.evidence_errors ?? []),
    ...(failed?.evidence_errors ?? []),
    ...journal.runErrors,
    ...history.runErrors,
    ...history.errors,
  ]);
  // Revision 16: and every failure the reaper's receipt returned to the runner.
  for (const error of observer?.errors ?? [])
    if (!runErrors.includes(error)) runErrors.push(error);
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
      records.some(cleanupFailed) ||
      history.cleanupNotVerified;
    const outcome = FAILED.includes(summary.outcome)
      ? summary.outcome
      : (history.outcome ??
        (failures.length > 0 || cleanupNotVerified ? "failed" : candidate));
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
      reaper: {
        ok: result.ok,
        file: join(runDir, "reaper.json"),
        attempt: result.attempt ?? null,
      },
    };
  };
  return { complete, render };
}

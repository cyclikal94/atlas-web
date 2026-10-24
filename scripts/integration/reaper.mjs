#!/usr/bin/env node
// The integration runner's reaper: it finishes the clean-up when the runner itself is killed.
//
// WEB-08d revision 30 (DELEGATED-WEB08D-RUNNER-RECONCILIATION-20261024). The accepted WEB-08c runner (run.mjs) cleans up on every
// exit it can observe, including its first SIGINT/SIGTERM; it cannot observe a SIGKILL (the shared validation driver sends one two
// seconds after its SIGTERM) or a crash of its own process. Its owned process groups (the backend, the preview, Playwright with its
// workers and browsers) and the PostgreSQL repeat's containers are not in the runner's own group, so they would outlive it. WEB-08d
// review r6 (H4) required that a killed runner still leaves nothing behind; this is that contract, carried over from the WEB-08d
// runner's reaper without its journal of stack records and summaries (the maintained runner's schedule owns those: a killed run has
// no terminal summary and is never a pass).
//
// The runner starts this process first, in a process group of its own, with stdin a pipe and stdout/stderr inherited (so a caller
// that waits for the runner's output waits for this clean-up too), and tells it, one JSON line each:
//   { "type": "group", "pgid": <n> }        an owned process group it has just started (its leader's pid)
//   { "type": "docker", "stack": "<label>" } a stack whose Docker resources (atlas.it.stack=<label>) exist or may exist
//   { "type": "mark", "token": "<hex>" }     the ownership mark its processes inherit (`ATLAS_IT_<token>=1`, ownership.mjs)
//   { "type": "release" }                    its own clean-up is complete: exit, doing nothing
// When stdin ends WITHOUT a release, every member of every registered group is stopped (TERM, then KILL after `--grace-ms`), then
// every process still carrying the mark (one that left its group, review r6 H4b) is stopped the same way, then every registered stack's Docker resources are disposed of by label and verified (docker-resources.mjs `disposeLabelled`, which
// also releases the stack's image leases under the shared host lock). A process is signalled only when it is still in a registered
// group AND started no earlier than that group was registered, so a pgid the system has since reused is never touched. What it did
// is written to `--record` (exclusively; it never overwrites a record), and it exits 1 when anything was left behind or the record
// could not be written. `--deadline-ms` bounds the whole take-over.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dockerExec } from "./docker-exec.mjs";
import { disposeLabelled, dockerClient } from "./docker-resources.mjs";
import { membersOf, processTable, stopMembers } from "./ownership.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const record = value("--record", "");
const graceMs = Number(value("--grace-ms", "2000"));
const deadlineMs = Number(value("--deadline-ms", "120000"));
if (!record) {
  console.error("reaper: --record <file> is required");
  process.exit(2);
}

// The runner's group may be signalled by its caller; this process has its own group and finishes regardless.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => undefined);

const groups = new Map(); // pgid -> registered at (ms)
const stacks = [];
let mark = null;
const malformed = [];
let released = false;

/** `[[dd-]hh:]mm:ss` as seconds. */
function etimeSeconds(text) {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return Number(days) * 86_400 + h * 3_600 + m * 60 + s;
}

/** The live members of the registered groups: pid -> pgid, only those that started no earlier than their group's registration. */
function members() {
  const listed = spawnSync("ps", ["-axo", "pid=,pgid=,etime="], {
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error(`ps failed: ${listed.stderr}`);
  const now = Date.now();
  const out = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [pid, pgid, etime] = line.trim().split(/\s+/);
    if (!etime) continue;
    const at = groups.get(Number(pgid));
    if (at === undefined || Number(pid) === process.pid) continue;
    // `etime` has a resolution of one second: a process started up to a second before its registration still counts.
    const started = now - etimeSeconds(etime) * 1000;
    if (started >= at - 2_000) out.set(Number(pid), Number(pgid));
  }
  return out;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeOver() {
  const result = {
    released: false,
    groups: [...groups.keys()],
    stopped: [],
    survivors: [],
    docker: [],
    errors: [...malformed],
  };
  const signalAll = (signal) => {
    let found;
    try {
      found = members();
    } catch (error) {
      result.errors.push(String(error?.message ?? error));
      return null;
    }
    for (const pid of found.keys())
      try {
        process.kill(pid, signal);
        if (signal === "SIGTERM") result.stopped.push(pid);
      } catch {
        // already gone
      }
    return found;
  };
  if (groups.size > 0) {
    signalAll("SIGTERM");
    const until = Date.now() + graceMs;
    const left = () => {
      try {
        return members().size;
      } catch {
        return 0; // recorded by the signalling below
      }
    };
    while (Date.now() < until && left() > 0) await pause(50);
    signalAll("SIGKILL");
    await pause(200);
    try {
      result.survivors = [...members().keys()];
    } catch (error) {
      result.errors.push(String(error?.message ?? error));
      result.survivors = "unknown";
    }
  }
  if (mark !== null) {
    const scan = () => {
      try {
        return membersOf({
          table: processTable(),
          marks: new Set([`${mark}=1`]),
          never: new Set([process.pid]),
        });
      } catch {
        return null;
      }
    };
    const swept = await stopMembers({ scan, graceMs, killWaitMs: 2_000 });
    result.marked = {
      signalled: swept.signalled.length,
      left: swept.left === null ? "unknown" : [...swept.left.keys()],
    };
    if (swept.left === null)
      result.errors.push("the process table could not be read");
    else if (swept.left.size > 0)
      result.errors.push(
        `marked process(es) remain: ${[...swept.left.keys()].join(", ")}`,
      );
  }
  if (stacks.length > 0) {
    const commands = dockerExec({
      command: process.env.ATLAS_INTEGRATION_DOCKER ?? "docker",
    });
    const docker = dockerClient(commands.run);
    for (const stack of stacks)
      result.docker.push(
        await disposeLabelled(docker, { filter: `atlas.it.stack=${stack}` }),
      );
  }
  result.ok =
    result.errors.length === 0 &&
    Array.isArray(result.survivors) &&
    result.survivors.length === 0 &&
    result.docker.every((d) => d.ok);
  return result;
}

function publish(result) {
  try {
    writeFileSync(record, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    return true;
  } catch (error) {
    console.error(`reaper: could not write ${record}: ${error.message}`);
    return false;
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\n");
  while (at >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      malformed.push(`malformed message: ${line.slice(0, 200)}`);
      continue;
    }
    if (message.type === "group" && Number.isInteger(message.pgid))
      groups.set(message.pgid, Date.now());
    else if (message.type === "docker" && typeof message.stack === "string")
      stacks.push(message.stack);
    else if (message.type === "mark" && /^[0-9a-f]{16}$/.test(message.token))
      mark = message.token;
    else if (message.type === "release") released = true;
    else malformed.push(`unknown message: ${line.slice(0, 200)}`);
  }
});
process.stdin.on("end", async () => {
  if (released && malformed.length === 0) process.exit(0);
  const timer = setTimeout(() => {
    console.error(`reaper: take-over still running after ${deadlineMs} ms`);
    publish({
      released,
      ok: false,
      errors: ["deadline"],
      groups: [...groups.keys()],
    });
    process.exit(1);
  }, deadlineMs);
  const result = released
    ? { released: true, ok: false, errors: malformed }
    : await takeOver();
  clearTimeout(timer);
  console.error(
    `reaper: ${released ? "released with malformed messages" : "the runner ended without releasing; clean-up finished"}: ${JSON.stringify(result)}`,
  );
  const written = publish(result);
  process.exit(result.ok && written ? 0 : 1);
});

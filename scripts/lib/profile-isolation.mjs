#!/usr/bin/env node
// Isolation of the sync-profiling measurements (WEB-09c plan 5.0; review finding R1). A measurement taken while another card's heavy work
// runs on the same controller is CONTAMINATED and must say so, in the hashed hand-over itself.
//
// Three parts:
//   * a SAMPLER the drivers start for each stage (`startLoadSampler`): every few seconds, every process that is not this run's and that is
//     heavy test work (a test runner, a Playwright browser, a build, a backend, a VM), appended to `<dir>/isolation/<stage>.jsonl`;
//   * the attribution of a process to this run (`attribute`): the INVOCATION ROOT's process tree, its ancestors, and the WebKit XPC services
//     that launchd starts for a Playwright WebKit host (their parent is launchd, so the tree cannot show whose they are: they are this run's
//     only while every running WebKit host is this run's);
//   * the verdict of a COLLECTION WINDOW (`classifyWindow`): every row of `measurements.jsonl` and `values.jsonl` carries the window of the
//     test that collected it (from the test's start to the row's export, which encloses the collection), so a row is judged by the samples
//     that cover the whole time its figures were taken, never by the moment it was written out.
//
// Revision 8 (review 8 R1, family profiling-isolation-window; design assessment DA-I1/DA-I2, A1 to A3). The root is no longer whoever started
// the sampler: every sampler is given the invocation's ISOLATION CONTEXT, which the evidence claim records (scripts/lib/profile-evidence.mjs):
// the invocation, the canonical evidence directory, and the root process as its pid AND its start (`ps lstart`), so a reused pid is not the
// root. A nested driver (the contention stage under `profile-sync.mjs`) gets the context from the claim it runs under, after proving that its
// root is its own live ancestor; the stage owner (the process that started the sampler) still governs the sampler's lifetime, and a sampler
// whose owner or root has gone writes an error sample and stops. So the launcher's own helper (macOS `caffeinate -is` forks a child of the
// programme's process) is this run's, while a sibling the launcher started beside the programme stays foreign.
//
// SUPPORT processes outside the tree (a launcher's status reader) are recognised only by a support pin the launcher hands to the programme
// (`ATLAS_PROFILE_SUPPORT`, schema `atlas-profile-support/1`, recorded in the context): the process's whole command must be exactly a pinned
// executable followed by the pinned arguments, the pinned script must hash to the pinned SHA-256 at the time of the sample, and the process
// must be younger than the pin's maximum lifetime (and the pin unexpired). Anything else that is heavy stays foreign, however it is spelt: no
// executable, interpreter, path or word is exempt by itself, a support process's children are not inherited, and a refused candidate is
// recorded with the reason. Support work is recorded (its CPU too) but is not foreign heavy work.
//
// Every sample records its context (invocation, stage, root pid and start), the method version, the sampler's and the owner's pids, and the
// structured identity behind its verdict: the foreign processes (pid, parent, CPU, start, the WHOLE command and the heavy pattern it
// matched), the recognised support processes (with role, script hash and age), and the own tree (pid, parent, start, CPU, executable). The display
// strings `foreign_heavy` are kept (truncated) for readers; the verdict is taken from the structured records.
//
// Verdicts: `clean` (no foreign heavy process in any sample covering the window), `idle_foreign` (one was present but used under 1 % of a
// core in every such sample: ps's reading of a parked process; NOT clean), `contaminated` (one used 1 % of a core or more), `unknown` (the
// samples do not cover the window: no sample at or before its start, or at or after its end, within 1.5 intervals, a gap of more than two
// intervals, or a failed sample). Only `clean` is isolated. There is no tolerance tier above the idle reading.
//
//   node scripts/lib/profile-isolation.mjs --sample --out <file.jsonl> --stage <stage> --context <json> --owner-pid <pid>
//     --owner-started <lstart> [--interval-ms 5000]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_INTERVAL_MS = 5_000;
/** ps's reading of a parked process stays under this (percent of one core); anything at or above it is competing for the CPU. */
export const IDLE_CPU_PERCENT = 1;
export const VERDICTS = ["clean", "idle_foreign", "contaminated", "unknown"];
/** The attribution method a sample was taken under (revision 8): samples of any other method are not judged by this one. */
export const METHOD_VERSION = "invocation-root/1";
export const CONTEXT_SCHEMA = "atlas-profile-isolation-context/1";
export const SUPPORT_SCHEMA = "atlas-profile-support/1";
/** The longest a pinned support process may live and still be support (a status read takes well under a second). */
export const SUPPORT_MAX_LIFETIME_S = 600;
export const METHOD =
  "every row is judged over its collection window (the enclosing test, from its start to the row's export) by the load samples that cover it, including the nearest sample at or before its start and at or after its end; clean = no foreign heavy process (test runner, Playwright or pool browser, build, backend, VM) in any of them; idle_foreign = one present under 1 % of a core in every sample (not clean); contaminated = one at 1 % or more; unknown = the samples do not cover the window. Not foreign: the invocation root's process tree (the root named by pid and start in the evidence claim, whichever driver samples), its ancestors (not their other children) and the WebKit XPC services of its own WebKit host. Support: a process whose whole command is a launcher's pinned support command, whose pinned script has the pinned SHA-256 and which is younger than the pin's lifetime; it is recorded, not foreign. Every other heavy process is foreign, however it is spelt";

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

/** The heavy pattern a command matches (the word, or `vm:<executable>`), or null. */
export function heavyReason(command) {
  if (AGENT.test(command.split(" --")[0])) return null;
  const word = HEAVY.exec(command);
  if (word) return word[0];
  const executable = command.split(" ")[0];
  return VM.test(executable) ? `vm:${executable}` : null;
}
export const isHeavy = (command) => heavyReason(command) !== null;

/** A process's start as `ps lstart` prints it in the C locale, with its words single-spaced ("Mon Oct 12 21:10:33 2026"). */
const lstart = (words) => words.join(" ");

/** `ps -axo pid=,ppid=,pcpu=,lstart=,command=` (C locale) as rows; `started` is the process's start (lstart, five words). */
export function psRows() {
  return parsePsRows(
    execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,lstart=,command="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}
export function parsePsRows(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, pcpu, ...rest] = l.split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pcpu: Number(pcpu),
        started: lstart(rest.slice(0, 5)),
        command: rest.slice(5).join(" "),
      };
    })
    .filter((r) => Number.isInteger(r.pid) && Number.isInteger(r.ppid));
}

/** The start of process `pid` (lstart, C locale), or null when there is no such process. */
export function processStart(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return out ? lstart(out.split(/\s+/)) : null;
  } catch {
    return null;
  }
}

/** Whether `ancestor` is `pid` itself or one of its ancestors in `rows`. */
export function isAncestor(rows, ancestor, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set();
  for (
    let at = byPid.get(pid);
    at && !seen.has(at.pid);
    at = byPid.get(at.ppid)
  ) {
    if (at.pid === ancestor) return true;
    seen.add(at.pid);
  }
  return false;
}

const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^\S+$/;
/**
 * The support pin a launcher hands to the programme (`ATLAS_PROFILE_SUPPORT`), checked and normalised; throws with the reason when it is not
 * a valid pin. Every token is free of white space, so a `ps` command line compares with it exactly.
 */
export function parseSupport(value) {
  const pin = typeof value === "string" ? JSON.parse(value) : value;
  const fail = (why) => {
    throw new Error(`invalid support pin (${SUPPORT_SCHEMA}): ${why}`);
  };
  if (!pin || typeof pin !== "object") fail("not an object");
  if (pin.schema !== SUPPORT_SCHEMA) fail(`schema ${pin.schema}`);
  if (typeof pin.request !== "string" || !TOKEN.test(pin.request))
    fail("no request");
  if (
    pin.not_after !== undefined &&
    !Number.isFinite(Date.parse(pin.not_after))
  )
    fail("not_after is not a time");
  if (!Array.isArray(pin.roles) || pin.roles.length === 0) fail("no roles");
  const roles = pin.roles.map((r, i) => {
    if (typeof r?.role !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(r.role))
      fail(`role ${i} has no name`);
    if (
      !Array.isArray(r.executables) ||
      r.executables.length === 0 ||
      !r.executables.every(
        (e) => typeof e === "string" && TOKEN.test(e) && isAbsolute(e),
      )
    )
      fail(`role ${r.role}: executables must be absolute paths`);
    if (
      !Array.isArray(r.args) ||
      !r.args.every((a) => typeof a === "string" && TOKEN.test(a))
    )
      fail(`role ${r.role}: args must be words`);
    const at = r.script?.arg;
    if (
      !Number.isInteger(at) ||
      at < 0 ||
      at >= r.args.length ||
      !isAbsolute(r.args[at])
    )
      fail(
        `role ${r.role}: script.arg must name an absolute script among the args`,
      );
    if (!SHA256.test(r.script?.sha256 ?? ""))
      fail(`role ${r.role}: script.sha256`);
    if (
      !Number.isFinite(r.max_lifetime_s) ||
      r.max_lifetime_s <= 0 ||
      r.max_lifetime_s > SUPPORT_MAX_LIFETIME_S
    )
      fail(
        `role ${r.role}: max_lifetime_s must be in (0, ${SUPPORT_MAX_LIFETIME_S}]`,
      );
    return {
      role: r.role,
      executables: [...r.executables],
      args: [...r.args],
      script: { arg: at, sha256: r.script.sha256 },
      max_lifetime_s: r.max_lifetime_s,
    };
  });
  return {
    schema: SUPPORT_SCHEMA,
    request: pin.request,
    ...(pin.not_after !== undefined ? { not_after: pin.not_after } : {}),
    roles,
  };
}
/** The launcher's support pin from the environment, or null when there is none (then nothing outside the tree is support). */
export const supportFromEnv = (env = process.env) =>
  env.ATLAS_PROFILE_SUPPORT ? parseSupport(env.ATLAS_PROFILE_SUPPORT) : null;

/** An invocation's isolation context: what every sampler of the invocation attributes by. */
export const isolationContext = ({
  invocation,
  evidenceDir,
  rootPid,
  rootStarted,
  support = null,
}) => ({
  schema: CONTEXT_SCHEMA,
  method: METHOD_VERSION,
  invocation,
  evidence_dir: evidenceDir,
  root: { pid: rootPid, started: rootStarted },
  support,
});
/** The context of an invocation rooted at THIS process (a driver that holds its own claim, or a test). */
export function directContext({ invocation, evidenceDir, support = null }) {
  const started = processStart(process.pid);
  if (!started)
    throw new Error(`cannot read the start of process ${process.pid}`);
  return isolationContext({
    invocation,
    evidenceDir,
    rootPid: process.pid,
    rootStarted: started,
    support,
  });
}
/** What is wrong with a context (an empty list when nothing is). */
export function contextProblems(context) {
  if (!context || typeof context !== "object") return ["no isolation context"];
  const problems = [];
  if (context.schema !== CONTEXT_SCHEMA)
    problems.push(`schema ${context.schema}`);
  if (context.method !== METHOD_VERSION)
    problems.push(`method ${context.method}`);
  if (typeof context.invocation !== "string" || !context.invocation)
    problems.push("no invocation");
  if (
    typeof context.evidence_dir !== "string" ||
    !isAbsolute(context.evidence_dir)
  )
    problems.push("no absolute evidence directory");
  if (!Number.isInteger(context.root?.pid) || context.root.pid <= 0)
    problems.push("no root pid");
  if (typeof context.root?.started !== "string" || !context.root.started)
    problems.push("no root start");
  if (context.support !== null) {
    try {
      if (
        JSON.stringify(parseSupport(context.support)) !==
        JSON.stringify(context.support)
      )
        problems.push("the support pin is not in its normal form");
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}

const sha256File = (file) => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};
/**
 * Whether `row` is a process the support pin authorises at `atMs`: `{ role, script_sha256, age_s }`, `{ refused }` (its command is a pinned
 * one but a check failed), or null (no pinned command). `hashOf(path)` reads the script's SHA-256 (null when unreadable).
 */
export function supportRole(row, support, atMs, hashOf = sha256File) {
  if (!support) return null;
  for (const role of support.roles) {
    const pinned = role.executables.some(
      (e) => row.command === [e, ...role.args].join(" "),
    );
    if (!pinned) continue;
    if (support.not_after !== undefined && atMs > Date.parse(support.not_after))
      return {
        refused: `${role.role}: the support pin expired at ${support.not_after}`,
      };
    const started = Date.parse(row.started ?? "");
    if (!Number.isFinite(started))
      return { refused: `${role.role}: the process's start is unknown` };
    // lstart has whole seconds, truncated: a process started in this second reads up to one second old.
    const age = (atMs - started) / 1000;
    if (age > role.max_lifetime_s + 1)
      return {
        refused: `${role.role}: ${age.toFixed(0)} s old, longer than its ${role.max_lifetime_s} s lifetime`,
      };
    const script = role.args[role.script.arg];
    const hash = hashOf(script);
    if (hash !== role.script.sha256)
      return {
        refused: `${role.role}: ${script} ${hash ? `hashes to ${hash}` : "cannot be read"}, not the pinned ${role.script.sha256}`,
      };
    return {
      role: role.role,
      script_sha256: hash,
      age_s: +Math.max(0, age).toFixed(1),
    };
  }
  return null;
}

/**
 * Which processes are this run's: the root's whole tree, the root's ancestors (the shell and the validation driver that launched it, but
 * not their other children), and the Playwright WebKit XPC services when every running WebKit host is in this run's tree (with no host
 * running, or with any host of another run, they cannot be told apart and count as foreign). Of the rest, the heavy processes are foreign
 * unless the support pin authorises them (`supportRole`). `rootPid` is the INVOCATION root (the isolation context's), never by default the
 * caller.
 */
export function attribute(
  rows,
  rootPid,
  { support = null, at: atMs = Date.now(), hashOf = sha256File } = {},
) {
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
  const foreign = [];
  const supporting = [];
  for (const r of rows) {
    if (mine.has(r.pid) || r.pid === process.pid) continue;
    const heavy = heavyReason(r.command);
    if (!heavy) continue;
    const role = supportRole(r, support, atMs, hashOf);
    if (role && !role.refused) supporting.push({ ...r, ...role });
    else
      foreign.push({
        ...r,
        heavy,
        ...(role?.refused ? { support_refused: role.refused } : {}),
      });
  }
  const supportPids = new Set(supporting.map((r) => r.pid));
  const cpu = (list) => +list.reduce((n, r) => n + r.pcpu, 0).toFixed(1);
  return {
    mine,
    foreign,
    support: supporting,
    webkit_xpc: hosts.length === 0 ? "no_host" : xpcMine ? "own" : "foreign",
    own_cpu_percent: cpu(rows.filter((r) => mine.has(r.pid))),
    support_cpu_percent: cpu(supporting),
    other_cpu_percent: cpu(
      rows.filter(
        (r) =>
          !mine.has(r.pid) && !supportPids.has(r.pid) && !isHeavy(r.command),
      ),
    ),
  };
}

/**
 * One sample: what ran beside this run now, attributed by `context` (its root, pid and start, and its support pin). `owner` is the stage
 * owner `{ pid, started }`: the sample is an error when the root is not the recorded process, or the owner has gone or is not in the root's
 * tree (`ended` then says which, and the sampler stops).
 */
export function sampleLoad(
  context,
  {
    stage,
    owner,
    intervalMs = SAMPLE_INTERVAL_MS,
    rows: given,
    now = Date.now(),
    hashOf = sha256File,
    samplerPid = process.pid,
  },
) {
  const at = new Date(now).toISOString();
  const base = {
    at,
    interval_ms: intervalMs,
    method: METHOD_VERSION,
    context: {
      invocation: context.invocation,
      stage,
      root_pid: context.root.pid,
      root_started: context.root.started,
    },
    sampler_pid: samplerPid,
    owner_pid: owner.pid,
  };
  try {
    const rows = given ?? psRows();
    const root = rows.find((r) => r.pid === context.root.pid);
    if (!root || root.started !== context.root.started)
      return {
        ...base,
        ended: "root",
        error: `the invocation root ${context.root.pid} (started ${context.root.started}) is ${root ? `now a process started ${root.started}` : "gone"}`,
      };
    const ownerRow = rows.find((r) => r.pid === owner.pid);
    if (!ownerRow || ownerRow.started !== owner.started)
      return {
        ...base,
        ended: "owner",
        error: `the stage owner ${owner.pid} (started ${owner.started}) is ${ownerRow ? `now a process started ${ownerRow.started}` : "gone"}`,
      };
    const seen = attribute(rows, context.root.pid, {
      support: context.support,
      at: now,
      hashOf,
    });
    if (!seen.mine.has(owner.pid))
      return {
        ...base,
        ended: "owner",
        error: `the stage owner ${owner.pid} is not in the tree of the invocation root ${context.root.pid}`,
      };
    return {
      ...base,
      loadavg: loadavg().map((n) => +n.toFixed(2)),
      own_tree_cpu_percent: seen.own_cpu_percent,
      other_cpu_percent: seen.other_cpu_percent,
      support_cpu_percent: seen.support_cpu_percent,
      webkit_xpc: seen.webkit_xpc,
      foreign_heavy_cpu_percent: +seen.foreign
        .reduce((n, r) => n + r.pcpu, 0)
        .toFixed(1),
      // For readers only (truncated); the verdict reads `foreign`.
      foreign_heavy: seen.foreign.map((r) =>
        `${r.pid} ${r.ppid} ${r.pcpu} ${r.command}`.slice(0, 220),
      ),
      foreign: seen.foreign.map((r) => ({
        pid: r.pid,
        ppid: r.ppid,
        pcpu: r.pcpu,
        started: r.started,
        command: r.command,
        heavy: r.heavy,
        ...(r.support_refused ? { support_refused: r.support_refused } : {}),
      })),
      support: seen.support.map((r) => ({
        pid: r.pid,
        ppid: r.ppid,
        pcpu: r.pcpu,
        started: r.started,
        command: r.command,
        role: r.role,
        script_sha256: r.script_sha256,
        age_s: r.age_s,
      })),
      own: rows
        .filter((r) => seen.mine.has(r.pid))
        .map((r) => [
          r.pid,
          r.ppid,
          r.started,
          r.pcpu,
          r.command.split(" ")[0],
        ]),
    };
  } catch (error) {
    return { ...base, error: String(error).slice(0, 200) };
  }
}

/**
 * The first problem of a stage's load samples against its record's isolation context, or null. The context must be valid and the stage's
 * invocation's; every sample must be this method's, carry the context (invocation, stage, root pid and start) and come from the stage's
 * sampler process; the first must be the one the sampler was ready with and the last its final one; every sample that is not an error must
 * show the root (pid and start) in its own tree, give its foreign processes as records agreeing with the display strings, and every support
 * process it records must be one the context's pin authorises (its command, script hash and age, as recorded).
 */
export function sampleIdentityProblem({
  context,
  invocation,
  stage,
  sampler,
  rows,
}) {
  if (!context)
    return "the stage record carries no isolation context (recorded before the invocation-root method): its load samples cannot be attributed";
  const problems = contextProblems(context);
  if (problems.length)
    return `the stage's isolation context is invalid (${problems.join("; ")})`;
  if (context.invocation !== invocation)
    return `the stage's isolation context belongs to invocation ${context.invocation}, not the stage's ${invocation}`;
  if (!Number.isInteger(sampler?.pid) || sampler.pid <= 0)
    return "the stage record does not identify its sampler process";
  if (rows.length === 0) return "no load samples were recorded for this stage";
  if (rows[0].at !== sampler.ready_at)
    return "the first load sample is not the one the sampler was ready with";
  for (const row of rows) {
    if (row.method !== METHOD_VERSION)
      return `a load sample (${row.at}) was taken under method ${row.method}, not ${METHOD_VERSION}`;
    const c = row.context ?? {};
    if (
      c.invocation !== context.invocation ||
      c.stage !== stage ||
      c.root_pid !== context.root.pid ||
      c.root_started !== context.root.started
    )
      return `a load sample (${row.at}) belongs to another invocation, stage or root`;
    if (row.sampler_pid !== sampler.pid)
      return `a load sample (${row.at}) was written by process ${row.sampler_pid}, not the stage's sampler ${sampler.pid}`;
    if (row.error) continue;
    if (
      !Array.isArray(row.foreign) ||
      !Array.isArray(row.support) ||
      !Array.isArray(row.own)
    )
      return `a load sample (${row.at}) does not record the identities it was judged by`;
    if (
      !row.own.some(
        ([pid, , started]) =>
          pid === context.root.pid && started === context.root.started,
      )
    )
      return `a load sample (${row.at}) does not show the invocation root in its own tree`;
    if ((row.foreign_heavy ?? []).length !== row.foreign.length)
      return `a load sample (${row.at}) lists different foreign processes in its records and its display`;
    for (const s of row.support) {
      const role = supportRole(
        s,
        context.support,
        Date.parse(row.at),
        () => s.script_sha256,
      );
      if (!role || role.refused || role.role !== s.role)
        return `a load sample (${row.at}) records support work its context does not authorise (pid ${s.pid}${role?.refused ? `: ${role.refused}` : ""})`;
    }
  }
  const last = rows.at(-1);
  if (last.final !== true)
    return "the sampler did not write its final sample after the action";
  return null;
}

/**
 * Starts the sampler for one stage as a child process (the stage's own work blocks this process's event loop), attributing by `context`
 * (required: the invocation's isolation context; there is no default root). It takes a sample at once, every `intervalMs` after, and a FINAL
 * one when stopped; it ends by itself (with an error sample, not a final one) when the stage owner (this process) or the root has gone. The
 * returned sampler is `ready` only once a valid first sample of THIS sampler process, stage and context is on disk: a stage whose sampler never
 * becomes ready throws here, before its action, and so fails closed. `stop()` resolves after the final sample, with whether this sampler
 * wrote it after the stop began.
 */
export async function startLoadSampler(
  dir,
  stage,
  { context, intervalMs = SAMPLE_INTERVAL_MS, readyWithinMs = 15_000 } = {},
) {
  const problems = contextProblems(context);
  if (problems.length)
    throw new Error(
      `the load sampler of stage ${stage} has no valid isolation context (${problems.join("; ")}): the stage cannot be judged and does not run`,
    );
  const ownerStarted = processStart(process.pid);
  if (!ownerStarted)
    throw new Error(
      `the load sampler of stage ${stage} cannot read its owner's start`,
    );
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
      "--stage",
      stage,
      "--context",
      JSON.stringify(context),
      "--owner-pid",
      String(process.pid),
      "--owner-started",
      ownerStarted,
      "--interval-ms",
      String(intervalMs),
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const firstValid = () => {
    try {
      const [first] = readSamples(file);
      return first &&
        !first.error &&
        Number.isFinite(Date.parse(first.at)) &&
        first.method === METHOD_VERSION &&
        first.sampler_pid === child.pid &&
        first.context?.stage === stage &&
        first.context?.invocation === context.invocation &&
        first.context?.root_pid === context.root.pid &&
        first.context?.root_started === context.root.started
        ? first
        : null;
    } catch {
      return null;
    }
  };
  let first = null;
  for (
    let waited = 0;
    waited < readyWithinMs && !first && child.exitCode === null;
    waited += 50
  ) {
    await new Promise((r) => setTimeout(r, 50));
    first = firstValid();
  }
  if (!first) {
    child.kill("SIGTERM");
    await exited;
    throw new Error(
      `the load sampler of stage ${stage} wrote no valid first sample within ${readyWithinMs} ms: the stage cannot be judged and does not run`,
    );
  }
  return {
    file,
    ready: true,
    ready_at: first.at,
    pid: child.pid,
    owner_pid: process.pid,
    stop: async () => {
      const stopping = Date.now();
      if (child.exitCode === null) child.kill("SIGTERM");
      const code = child.exitCode ?? (await exited);
      let samples = [];
      try {
        samples = readSamples(file);
      } catch {
        samples = [];
      }
      const last = samples.at(-1);
      return {
        exit_code: code,
        samples: samples.length,
        final_sample:
          code === 0 &&
          last?.final === true &&
          last.sampler_pid === child.pid &&
          Date.parse(last.at) >= stopping,
      };
    },
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
/** A sample's foreign processes: its records (revision 8), or, for an earlier sample, its display strings. */
const foreignOf = (s) =>
  Array.isArray(s.foreign)
    ? s.foreign
    : (s.foreign_heavy ?? []).map((f) => {
        const [, , pcpu, ...command] = f.split(/\s+/);
        return { pcpu: Number(pcpu) || 0, command: command.join(" ") };
      });

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
  const foreign = covering.filter((s) => foreignOf(s).length > 0);
  const peak = Math.max(
    0,
    ...covering.map((s) =>
      Math.max(0, ...foreignOf(s).map((f) => Number(f.pcpu) || 0)),
    ),
  );
  const verdict =
    foreign.length === 0
      ? "clean"
      : peak >= IDLE_CPU_PERCENT
        ? "contaminated"
        : "idle_foreign";
  const supported = covering.filter((s) => (s.support ?? []).length > 0);
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
    // Authorised support work (a launcher's pinned status reader): recorded beside the verdict, never part of it.
    support_samples: supported.length,
    peak_support_cpu_percent: Math.max(
      0,
      ...covering.map((s) => s.support_cpu_percent ?? 0),
    ),
    // Everything else that was not this run's (system daemons, editors, other agents' own processes): recorded for the reader, not a verdict.
    peak_other_cpu_percent: Math.max(
      0,
      ...covering.map((s) => s.other_cpu_percent ?? 0),
    ),
    foreign_examples: [
      ...new Set(foreign.flatMap((s) => foreignOf(s).map((f) => f.command))),
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
  const usage =
    "usage: node scripts/lib/profile-isolation.mjs --sample --out <file.jsonl> --stage <stage> --context <json> --owner-pid <pid> --owner-started <lstart> [--interval-ms 5000]";
  let context = null;
  try {
    context = JSON.parse(value("--context", "null"));
  } catch {
    context = null;
  }
  const owner = {
    pid: Number(value("--owner-pid")),
    started: value("--owner-started"),
  };
  if (
    !args.includes("--sample") ||
    !value("--out") ||
    !value("--stage") ||
    contextProblems(context).length > 0 ||
    !Number.isInteger(owner.pid) ||
    !owner.started
  ) {
    console.error(usage);
    process.exit(2);
  }
  const out = value("--out");
  const stage = value("--stage");
  const intervalMs = Number(value("--interval-ms", String(SAMPLE_INTERVAL_MS)));
  mkdirSync(dirname(out), { recursive: true });
  const write = (final = false) => {
    const sample = sampleLoad(context, { stage, owner, intervalMs });
    appendFileSync(
      out,
      `${JSON.stringify({ ...sample, ...(final ? { final: true } : {}) })}\n`,
    );
    return sample;
  };
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
    write(true);
    process.exit(0);
  });
  // A sampler whose owner or root has gone stops with its error sample (never a final one), so its stage cannot claim enclosing samples.
  const tick = () => {
    if (stopping) return;
    if (write().ended) {
      clearInterval(timer);
      process.exit(3);
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
}

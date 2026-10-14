// What the integration runner owns, and how it stops it (WEB-08d review r5 H4, review r6 H4b).
//
// Every process the runner starts is spawned with an inherited ownership MARK in its environment: a variable whose name carries this
// owner's random token and whose value names the handle (`ATLAS_IT_<token>=<handle>`). A process's descendants inherit it whatever
// becomes of their parent, so membership does not depend on seeing the parent tree at the right moment: a child that detaches into
// a session of its own and whose parent exits before any look is still found by its mark (review r6 H4b). The process table is read
// with `ps -E`, which shows a process's initial environment to its own user; only the mark is looked for, nothing else is kept.
//
// The mark is the primary authority, and the live tree supplements it: a descendant of an identity-checked member that shows no
// mark (a platform binary whose environment `ps` cannot read, such as WebKit's `pw_run.sh` shell) is adopted and remembered by pid
// and start time. A pid is only ever signalled while it is that same process (its start time is compared, so a recycled pid is left
// alone), and traversal starts from every member whose identity still matches, never from a bare numeric root. The runner's own
// process and its parent are never members, and a process group is never signalled.
//
// Stopping a handle: an optional polite signal to its root alone, then SIGTERM to every member, rescanning for members started in
// the meantime; whatever is left is FROZEN (SIGSTOP, rescanning until no new member appears, so nothing can start another process),
// then SIGKILLed; then the members are counted again. The result says what was signalled and what survived, whether the process
// table could be read at all (`inventory: "unknown"` is never an empty survivor list) and whether the child's pipes closed. A handle
// that is not verified gone stays owned.
//
// Known limit, recorded in docs/session.md: a process that both starts with an environment that no longer contains the mark and
// leaves the tree before it is seen cannot be attributed. No process of the integration programme does so (revision 7 qualification:
// every Chromium and Firefox descendant carries the mark; WebKit's helper services are started by launchd, not by the browser, and
// end with it). Containment that does not depend on cooperation would need a launchd job per run, which escapes the agent's own
// containment and is a scope decision for the owner, not something this runner does.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MARK = /(?:^|\s)ATLAS_IT_([0-9a-f]{16})=(\d+)(?=\s|$)/g;
// `ps` in the C locale: `lstart` is always "Www Mmm dd hh:mm:ss yyyy" (24 characters), so the command that follows can be split off.
const ROW =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})(?: (.*))?$/;

/**
 * `ps` of every process: pid, parent pid, whether it is a zombie, its start time (the identity of a pid that may be recycled) and the
 * ownership marks in its environment (`<token>=<handle>`). Nothing else of the environment or the command is kept.
 */
export function processTable() {
  const out = execFileSync(
    "ps",
    ["-E", "-axww", "-o", "pid=,ppid=,stat=,lstart=,command="],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  const rows = [];
  for (const line of out.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    const marks = [];
    for (const m of (match[5] ?? "").matchAll(MARK))
      marks.push(`${m[1]}=${m[2]}`);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      zombie: match[3].startsWith("Z"),
      started: match[4],
      marks,
    });
  }
  if (rows.length === 0) throw new Error("ps listed no process");
  return rows;
}

/** `root` and every process below it in `table` (the live tree only). */
export function descendants(root, table = processTable()) {
  const children = new Map();
  for (const { pid, ppid } of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (table.some((row) => row.pid === pid)) found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The members of a set of marks in `table`: every live (not zombie) process carrying one of `marks`, every remembered process
 * (`known`: pid -> start time) that is still that same process, and every live descendant of those, found from each of them.
 * `never` is never a member. Returns pid -> { started, marked }.
 */
export function membersOf({
  table,
  marks,
  known = new Map(),
  never = new Set(),
}) {
  const live = new Map();
  for (const row of table) if (!row.zombie) live.set(row.pid, row);
  const members = new Map();
  for (const row of live.values())
    if (!never.has(row.pid) && row.marks.some((m) => marks.has(m)))
      members.set(row.pid, { started: row.started, marked: true });
  for (const [pid, started] of known) {
    const row = live.get(pid);
    if (row && row.started === started && !never.has(pid) && !members.has(pid))
      members.set(pid, { started, marked: false });
  }
  const children = new Map();
  for (const row of live.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const queue = [...members.keys()];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (never.has(child.pid) || members.has(child.pid)) continue;
      members.set(child.pid, { started: child.started, marked: false });
      queue.push(child.pid);
    }
  }
  return members;
}

/**
 * Stop every member `scan()` returns (pid -> anything; null when the table could not be read): SIGTERM to each, rescanning for members
 * started meanwhile, for up to `graceMs`; then whatever is left is FROZEN (SIGSTOP, rescanning until a round finds no new member, so
 * nothing can start another process) and SIGKILLed, and the members are counted again for up to `killWaitMs`. Shared by the runner
 * and by its reaper, which finishes the work when the runner itself is gone.
 */
export async function stopMembers({ scan, graceMs = 5000, killWaitMs = 2000 }) {
  const signalled = [];
  const frozen = [];
  const send = (pid, signal) => {
    try {
      process.kill(pid, signal);
      signalled.push({ pid, signal });
      return true;
    } catch {
      return false; // gone in between
    }
  };
  let now = scan();
  const termed = new Set();
  const deadline = Date.now() + graceMs;
  while (now && now.size > 0 && Date.now() < deadline) {
    for (const pid of now.keys())
      if (!termed.has(pid)) {
        termed.add(pid);
        send(pid, "SIGTERM");
      }
    await pause(50);
    // A member started during shutdown is still a member.
    now = scan();
  }
  let escalated = false;
  if (now === null || now.size > 0) {
    escalated = true;
    // Freeze first: a stopped process cannot start another, so the set can be completed before anything is killed.
    const stopped = new Set();
    for (let round = 0; round < 20; round += 1) {
      const current = scan() ?? new Map();
      const fresh = [...current.keys()].filter((pid) => !stopped.has(pid));
      if (fresh.length === 0) break;
      for (const pid of fresh) {
        stopped.add(pid);
        if (send(pid, "SIGSTOP")) frozen.push(pid);
      }
      await pause(20);
    }
    for (const pid of new Set([...stopped, ...(scan()?.keys() ?? [])]))
      send(pid, "SIGKILL");
    const killDeadline = Date.now() + killWaitMs;
    do {
      await pause(25);
      now = scan();
    } while (now && now.size > 0 && Date.now() < killDeadline);
  }
  return { signalled, frozen, escalated, left: now };
}

/**
 * The runner's register of owned processes plus its single stop latch. `stop(reason)` latches (first reason wins); `spawnOwned`
 * refuses once latched, so nothing is launched after a failure or a signal, except a clean-up command that says so (`whenStopped`).
 */
export function createOwner({
  graceMs = 5000,
  killWaitMs = 2000,
  token = randomBytes(8).toString("hex"),
  table = processTable,
  onMember = () => undefined,
} = {}) {
  const owned = new Set();
  let latch = null;
  let seq = 0;
  const never = new Set([process.pid, process.ppid]);
  const variable = `ATLAS_IT_${token}`;

  function spawnOwned(label, command, args, options = {}) {
    if (latch && !options.whenStopped) throw new Cancelled(latch);
    seq += 1;
    const mark = `${token}=${seq}`;
    const { whenStopped: _, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      env: { ...(options.env ?? process.env), [variable]: String(seq) },
    });
    const handle = {
      label,
      mark,
      child,
      pid: child.pid,
      known: new Map(),
      spawnError: null,
      exit: null,
      verified: false,
    };
    owned.add(handle);
    if (child.pid) {
      try {
        const rows = table();
        const row = rows.find((r) => r.pid === child.pid && !r.zombie);
        if (row) remember(handle, child.pid, row.started);
      } catch {
        // the handle is still known by its mark
      }
    }
    handle.closed = new Promise((resolve) => {
      child.once("error", (error) => {
        handle.spawnError = String(error?.message ?? error);
        if (!child.pid) {
          handle.exit = { code: null, signal: null };
          resolve(handle.exit);
        }
      });
      child.once("close", (code, signal) => {
        handle.exit = { code, signal };
        resolve(handle.exit);
      });
    });
    return handle;
  }

  function remember(handle, pid, started) {
    if (handle.known.has(pid)) return;
    handle.known.set(pid, started);
    onMember({ label: handle.label, mark: handle.mark, pid, started });
  }

  /** The handle's live members now (pid -> { started, marked }); throws when the process table cannot be read. */
  function members(handle, rows = table()) {
    const found = membersOf({
      table: rows,
      marks: new Set([handle.mark]),
      known: handle.known,
      never,
    });
    for (const [pid, { started }] of found) remember(handle, pid, started);
    return found;
  }

  /** Remember the handle's current members (kept for evidence and for a member that later loses its link to the tree). */
  function snapshot(handle) {
    try {
      members(handle);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop one owned process and every member it has; resolves with what was signalled and what survived. `polite` (a signal and a
   * time) is first sent to the owned process alone, so it can finish in order (Playwright, on SIGINT, stops its workers and browsers
   * and still writes its report); whatever is left after that time is then terminated as usual.
   */
  async function terminate(handle, grace = graceMs, polite = null) {
    const signalled = [];
    const frozen = [];
    const errors = [];
    let inventory = "complete";
    const scan = () => {
      try {
        return members(handle);
      } catch (error) {
        inventory = "unknown";
        errors.push(`process table: ${String(error?.message ?? error)}`);
        return null;
      }
    };
    const send = (pid, signal) => {
      try {
        process.kill(pid, signal);
        signalled.push({ pid, signal });
        return true;
      } catch {
        return false; // gone in between
      }
    };
    const now = scan();
    if (polite && handle.pid && handle.exit === null && now?.has(handle.pid)) {
      send(handle.pid, polite.signal);
      const politeDeadline = Date.now() + polite.ms;
      while (Date.now() < politeDeadline && handle.exit === null)
        await pause(100);
    }
    const stopped = await stopMembers({ scan, graceMs: grace, killWaitMs });
    signalled.push(...stopped.signalled);
    frozen.push(...stopped.frozen);
    const escalated = stopped.escalated;
    // The child's own 'close' (its pipes flushed), bounded: a pipe held open by a member closes when that member is gone.
    const closed = await Promise.race([
      handle.closed.then(() => true),
      pause(killWaitMs).then(() => false),
    ]);
    const final = scan();
    const survivors = final ? [...final.keys()] : [];
    handle.verified =
      inventory === "complete" && survivors.length === 0 && closed;
    if (handle.verified) owned.delete(handle);
    return {
      label: handle.label,
      pid: handle.pid ?? null,
      mark: handle.mark,
      owned_pids: [...handle.known.keys()],
      signalled,
      escalated,
      frozen,
      survivors,
      inventory,
      pipes_closed: closed,
      errors,
      exit: handle.exit,
      ok: handle.verified,
    };
  }

  /**
   * Run one command to completion as an owned process: its output collected, `input` written to its stdin, bounded by `timeoutMs`.
   * When `signal` aborts (and the command is `abortable`) the process is terminated and `Cancelled` is thrown; a command that creates
   * something outside this machine's process table (a container) is not abortable, so its creation is never left half-reported.
   */
  async function exec(label, command, args, options = {}) {
    const {
      input,
      timeoutMs = 120_000,
      signal,
      abortable = true,
      whenStopped = false,
      env,
      cwd,
      hold,
    } = options;
    if (signal?.aborted && abortable && !whenStopped)
      throw new Cancelled(String(signal.reason?.reason ?? "aborted"));
    const handle = spawnOwned(label, command, args, {
      env,
      cwd,
      whenStopped,
      // `hold`: a descriptor the command keeps open while it runs (a host lock's: the lock lasts while the command does).
      stdio: [
        input === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
        ...(hold === undefined ? [] : [hold]),
      ],
    });
    let stdout = "";
    let stderr = "";
    handle.child.stdout?.on("data", (d) => {
      stdout += d;
    });
    handle.child.stderr?.on("data", (d) => {
      stderr += d;
    });
    if (input !== undefined) {
      handle.child.stdin.on("error", () => undefined);
      handle.child.stdin.end(input);
    }
    let ended = null;
    const timer = setTimeout(() => {
      ended ??= "timeout";
    }, timeoutMs);
    const onAbort = () => {
      if (abortable) ended ??= "aborted";
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    while (handle.exit === null && ended === null)
      await Promise.race([handle.closed, pause(50)]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (ended !== null && handle.exit === null) {
      const stopped = await terminate(handle, 1000);
      if (ended === "aborted")
        throw Object.assign(
          new Cancelled(String(signal.reason?.reason ?? "aborted")),
          { stopped },
        );
      return {
        status: null,
        signal: null,
        stdout,
        stderr,
        timedOut: true,
        stopped,
      };
    }
    // Normal completion: confirm nothing it started is left (one look; anything left is stopped like any other member).
    let stopped;
    try {
      if (members(handle).size === 0 && handle.exit !== null) {
        handle.verified = true;
        owned.delete(handle);
        stopped = { label, survivors: [], inventory: "complete", ok: true };
      }
    } catch {
      // the table could not be read: terminate() records that
    }
    stopped ??= await terminate(handle, 1000);
    return {
      status: handle.exit?.code ?? null,
      signal: handle.exit?.signal ?? null,
      stdout,
      stderr,
      spawnError: handle.spawnError,
      timedOut: false,
      stopped,
    };
  }

  /** Every live process carrying any of this owner's marks (the whole invocation); throws when the table cannot be read. */
  function sweep() {
    const rows = table();
    const marks = new Set();
    for (let i = 1; i <= seq; i += 1) marks.add(`${token}=${i}`);
    const known = new Map();
    for (const handle of owned)
      for (const [pid, started] of handle.known) known.set(pid, started);
    return [...membersOf({ table: rows, marks, known, never }).keys()];
  }

  return {
    token,
    variable,
    spawnOwned,
    snapshot,
    members,
    terminate,
    exec,
    sweep,
    /** A process that is never a member (the runner's own reaper). */
    exclude(pid) {
      never.add(pid);
    },
    stop(reason) {
      latch ??= reason;
      return latch;
    },
    get latched() {
      return latch;
    },
    owned: () => [...owned],
    check() {
      if (latch) throw new Cancelled(latch);
    },
  };
}

export class Cancelled extends Error {
  constructor(reason) {
    super(`stopped: ${reason}`);
    this.name = "Cancelled";
    this.reason = reason;
  }
}

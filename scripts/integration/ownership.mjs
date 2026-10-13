// What the integration runner owns, and how it stops it (WEB-08d review r5, H4).
//
// Every process the runner starts (the backend, the preview server, Playwright) is registered the moment it is spawned. Stopping one
// takes a snapshot of its descendants first (Playwright's workers, and the browsers Playwright starts in process groups of their own),
// sends SIGTERM to each of them, waits a bounded time, sends SIGKILL to whatever is left, and then checks that every one is gone. A
// pid is only ever signalled because it was the runner's child or a descendant of one at the time of a snapshot, and only while it is
// still that same process (its start time is compared, so a recycled pid is left alone); the runner's own process and its parent are
// never signalled, and a process group is never signalled at all (a child shares the runner's group,
// so the outer validation driver's group signals still reach it). What could not be stopped is reported, never hidden.
import { execFileSync, spawn } from "node:child_process";

/** `ps` of every process: pid, parent pid, whether it is a zombie, and its start time (the identity of a pid that may be recycled). */
export function processTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,lstart="], {
    encoding: "utf8",
  });
  const rows = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        zombie: match[3].startsWith("Z"),
        started: match[4],
      });
  }
  return rows;
}

/** `root` and every process below it in `table`. */
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

/** Whether each remembered process (pid -> start time) still runs as that same process. */
function living(known, table = processTable()) {
  // An exited process its parent has not reaped yet (a zombie) holds nothing and cannot be signalled further.
  const now = new Map(
    table.filter((row) => !row.zombie).map((row) => [row.pid, row.started]),
  );
  return [...known].filter(([pid, started]) => now.get(pid) === started);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The runner's register of owned processes plus its single stop latch. `stop(reason)` latches (first reason wins); `spawnOwned`
 * refuses once latched, so nothing is launched after a failure or a signal.
 */
export function createOwner({ graceMs = 5000, killWaitMs = 2000 } = {}) {
  const owned = new Set();
  let latch = null;
  const never = new Set([process.pid, process.ppid]);

  function spawnOwned(label, command, args, options) {
    if (latch) throw new Cancelled(latch);
    const child = spawn(command, args, options);
    const handle = {
      label,
      child,
      pid: child.pid,
      known: new Map(),
      spawnError: null,
      exit: null,
    };
    owned.add(handle);
    if (child.pid) snapshot(handle);
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

  /** Remember the handle's current descendants (they can outlive their parent and then no longer be found through it). */
  function snapshot(handle) {
    if (!handle.pid) return;
    const table = processTable();
    const started = new Map(table.map((row) => [row.pid, row.started]));
    for (const pid of descendants(handle.pid, table))
      if (!never.has(pid) && !handle.known.has(pid))
        handle.known.set(pid, started.get(pid));
  }

  /**
   * Stop one owned process and every descendant it had; resolves with what was signalled and what survived. `polite` (a signal and
   * a time) is first sent to the owned process alone, so it can finish in order (Playwright, on SIGINT, stops its workers and
   * browsers and still writes its report); whatever is left after that time is then terminated as usual.
   */
  async function terminate(handle, grace = graceMs, polite = null) {
    snapshot(handle);
    const signalled = [];
    if (
      polite &&
      handle.pid &&
      living(handle.known).some(([pid]) => pid === handle.pid)
    ) {
      try {
        process.kill(handle.pid, polite.signal);
        signalled.push({ pid: handle.pid, signal: polite.signal });
      } catch {
        // gone in between
      }
      const politeDeadline = Date.now() + polite.ms;
      while (Date.now() < politeDeadline && handle.exit === null) {
        await pause(50);
        snapshot(handle);
      }
    }
    const send = (signal) => {
      for (const [pid] of living(handle.known)) {
        if (never.has(pid)) continue;
        try {
          process.kill(pid, signal);
          signalled.push({ pid, signal });
        } catch {
          // gone in between
        }
      }
    };
    send("SIGTERM");
    const deadline = Date.now() + grace;
    while (Date.now() < deadline && living(handle.known).length > 0) {
      await pause(50);
      // A descendant started during shutdown is still owned.
      if (handle.pid && handle.exit === null) snapshot(handle);
    }
    let escalated = false;
    if (living(handle.known).length > 0) {
      escalated = true;
      send("SIGKILL");
      const killDeadline = Date.now() + killWaitMs;
      while (Date.now() < killDeadline && living(handle.known).length > 0)
        await pause(25);
    }
    // The child's own 'close' (its pipes flushed), bounded: a pipe held open by a descendant that was killed closes with it.
    await Promise.race([handle.closed, pause(killWaitMs)]);
    owned.delete(handle);
    return {
      label: handle.label,
      pid: handle.pid ?? null,
      owned_pids: [...handle.known.keys()],
      signalled,
      escalated,
      survivors: living(handle.known).map(([pid]) => pid),
      exit: handle.exit,
    };
  }

  return {
    spawnOwned,
    snapshot,
    terminate,
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

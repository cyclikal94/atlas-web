// A lock shared by every process on this host that coordinates through the same directory (WEB-08d review r7 DA-1): the runner, its
// reaper and any other invocation. It is a directory, created complete (with its owner) by an atomic rename, so it never exists
// without saying who holds it. Only its owner removes it, again by an atomic rename. A lock is taken over only when its owner is
// PROVEN gone: its pid no longer exists, or that pid now belongs to a process started at another time. Anything less (the table
// cannot be read, the owner record cannot be read) is not proof, and the waiter keeps waiting until its own bound, then fails:
// nothing is decided under a lock whose holder may still be acting.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export class LockTimeout extends Error {
  constructor(path, holder) {
    super(
      `the lock ${path} was not obtained in time (held by ${holder ? `pid ${holder.pid}` : "an owner that could not be read"})`,
    );
    this.name = "LockTimeout";
    this.holder = holder ?? null;
  }
}

/** The start time of `pid` as the process table says, or null when there is no such process; throws when the table cannot be read. */
export function startedAt(pid) {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch (error) {
    // `ps -p` exits 1 when the pid does not exist (and prints only the header, which `lstart=` suppresses).
    if (error?.status === 1) return null;
    throw error;
  }
}

let self = null;
const owner = () => {
  self ??= {
    pid: process.pid,
    started: startedAt(process.pid),
    host: hostname(),
  };
  return self;
};

/** Is `holder` (an owner record) proven gone? Never true on doubt. */
export function provenGone(holder, look = startedAt) {
  if (!holder || typeof holder.pid !== "number" || !holder.started)
    return false;
  if (holder.host !== hostname()) return false;
  let now;
  try {
    now = look(holder.pid);
  } catch {
    return false;
  }
  return now === null || now !== holder.started;
}

const readOwner = (path) => {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold the lock at `path` while `fn()` runs. Waits (polling) up to `timeoutMs`; a `signal` ends the wait with its reason. `look` is the
 * process-table reader (a test seam).
 */
export async function withHostLock(
  path,
  fn,
  { signal, timeoutMs = 120_000, pollMs = 50, look = startedAt } = {},
) {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const mine = { ...owner(), token };
  const deadline = Date.now() + timeoutMs;
  let holder = null;
  for (;;) {
    signal?.throwIfAborted();
    const fresh = `${path}.new-${token}`;
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "owner.json"), `${JSON.stringify(mine)}\n`);
    try {
      renameSync(fresh, path);
      break;
    } catch (error) {
      rmSync(fresh, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
    holder = readOwner(path);
    if (holder && provenGone(holder, look)) {
      // Take over a dead owner's lock: move it aside (only one taker can), then check it was the one judged dead.
      const aside = `${path}.stale-${token}`;
      try {
        renameSync(path, aside);
      } catch {
        continue; // released or taken over meanwhile
      }
      const moved = readOwner(aside);
      if (moved?.token !== holder.token) {
        // Someone else took it over and a live owner holds it now: put it back. If that fails, two may hold it: refuse.
        try {
          renameSync(aside, path);
        } catch {
          throw new Error(
            `the lock ${path} changed hands while a dead owner's lock was being taken over; nothing was decided`,
          );
        }
      } else rmSync(aside, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeout(path, holder);
    await pause(pollMs);
  }
  try {
    return await fn();
  } finally {
    // Only the owner removes it, and only its own: move it aside first, so the path is never an empty directory.
    if (readOwner(path)?.token === token) {
      const gone = `${path}.released-${token}`;
      renameSync(path, gone);
      rmSync(gone, { recursive: true, force: true });
    }
  }
}

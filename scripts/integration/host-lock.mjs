// A lock shared by every process on this host that coordinates through the same file (WEB-08d review r7 DA-1; review r8 DA-1a): the
// runner, its reaper and any other invocation.
//
// Review r8 DA-1a (revision 9): the lock is the KERNEL's, not a path. Revision 8 moved a dead owner's lock directory aside after proving
// that owner gone; the path could meanwhile belong to a live replacement, so a stale claimant could move a live lock and let a third
// process in beside it. Now the lock is an exclusive open-file lock (BSD `flock` semantics, taken atomically by `open(2)` with
// `O_EXLOCK`) on a file that is never moved, unlinked or recreated. Nothing ever takes a lock over: the kernel gives it up when the
// last open description of the holder's file is closed, which happens when the holder closes it or when the holder AND every process
// it handed the descriptor to (`held.fd`, inherited as an extra stdio entry by the commands it issues under the lock) have exited.
// So a holder's death releases the lock only once nothing it started under the lock is still running, and a live holder is never
// displaced, whatever any waiter believes about it. A waiter that cannot get the lock keeps waiting until its own bound or its stop.
//
// The holder's identity, written into the file, is a diagnostic (a timeout names who holds it); it is never permission for anything.
//
// Unfinished work (`held.note`, `held.settle`, `held.previous`): a holder records what it is doing beside the lock (`<lock>.intent`,
// replaced atomically, only ever written by the holder). A holder that ends without settling it (it died, or an effect's answer was
// lost) leaves the record, and the NEXT holder is told (`held.previous`), so it can bring that work to a settled state before its own.
//
// Supported: macOS (Darwin) and the BSDs, which have `O_EXLOCK`. Elsewhere withHostLock refuses rather than coordinate unsafely.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

// open(2) `O_EXLOCK` on Darwin and the BSDs (Node does not name it in fs.constants).
const O_EXLOCK = 0x20;
export const supported = ["darwin", "freebsd", "openbsd", "netbsd"].includes(
  process.platform,
);

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
  if (self) return self;
  let started = null;
  try {
    started = startedAt(process.pid);
  } catch {
    // a diagnostic only: the lock does not depend on the process table
  }
  self = { pid: process.pid, started, host: hostname() };
  return self;
};

/** Who the lock file says holds it (a diagnostic, possibly stale or unreadable: null). */
export function holderOf(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The unfinished work an earlier holder left beside the lock, or null. */
export function intentOf(path) {
  try {
    return JSON.parse(readFileSync(`${path}.intent`, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // A record that exists but cannot be read is unfinished work of an unknown kind, never "nothing".
    return { unreadable: String(error?.message ?? error) };
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold the lock at `path` while `fn(held)` runs. Waits (polling) up to `timeoutMs`; a `signal` ends the wait with its reason, and `fn`
 * is then never called. `held` is { fd, token, path, previous, note(intent), settle() }: `fd` is the locked descriptor (hand it to a
 * command as an extra stdio entry and the lock lasts while that command does), `previous` the unfinished work an earlier holder left.
 */
export async function withHostLock(
  path,
  fn,
  { signal, timeoutMs = 120_000, pollMs = 50 } = {},
) {
  if (!supported)
    throw new Error(
      `no process-lifetime host lock on ${process.platform} (open(2) O_EXLOCK is needed); nothing was decided`,
    );
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  for (;;) {
    signal?.throwIfAborted();
    try {
      fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK,
        0o600,
      );
      break;
    } catch (error) {
      if (!["EAGAIN", "EWOULDBLOCK"].includes(error?.code)) throw error;
    }
    if (Date.now() >= deadline) throw new LockTimeout(path, holderOf(path));
    await pause(pollMs);
  }
  const token = randomBytes(8).toString("hex");
  const intentPath = `${path}.intent`;
  const held = {
    fd,
    token,
    path,
    previous: intentOf(path),
    /** Record (replacing atomically) what this holder is doing, before an effect whose answer could be lost. */
    note(intent) {
      const temporary = `${intentPath}.${token}`;
      const text = `${JSON.stringify({ ...intent, holder: { ...owner(), token }, at: new Date().toISOString() })}\n`;
      const out = openSync(temporary, "w", 0o600);
      try {
        writeSync(out, text);
        fsyncSync(out);
      } finally {
        closeSync(out);
      }
      renameSync(temporary, intentPath);
    },
    /** The work is settled (including any earlier holder's it took over): nothing is left for the next holder. */
    settle() {
      rmSync(intentPath, { force: true });
    },
  };
  try {
    try {
      ftruncateSync(fd, 0);
      writeSync(
        fd,
        `${JSON.stringify({ ...owner(), token, at: new Date().toISOString() })}\n`,
        0,
      );
    } catch {
      // the identity is a diagnostic; the lock is held either way
    }
    return await fn(held);
  } finally {
    try {
      ftruncateSync(fd, 0);
    } catch {
      // a diagnostic only
    }
    // The kernel releases the lock when the last descriptor of this open file is closed (commands given `fd` hold it too).
    closeSync(fd);
  }
}

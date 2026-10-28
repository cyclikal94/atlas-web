// The docker CLI runner behind scripts/integration/docker-resources.mjs `dockerClient`, for the maintained runner (run.mjs).
//
// WEB-08d revision 30 (DELEGATED-WEB08D-RUNNER-RECONCILIATION-20261024): the accepted WEB-08c runner owns its long-lived processes
// as process groups (process-groups.mjs); the image-ownership protection WEB-08d established (review r6 H4a, r7 DA-1, r8 DA-1a)
// needs, in addition, short docker commands with the contract `dockerClient` documents:
//  - every command is bounded (`timeoutMs`, default 120 s): one that does not end is stopped and reported `timedOut`, never awaited
//    for ever;
//  - `signal` ends a command that only waits (a pull, a readiness probe) at once, with `Cancelled`; a command that CREATES something
//    is passed `abortable: false` and finishes, so its creation is never left half-reported;
//  - after the stop (`stop(reason)`, the runner's first signal) nothing new starts, EXCEPT a clean-up command that says so
//    (`whenStopped`): disposal by label and the image release must still run;
//  - `hold`: a host lock's descriptor (host-lock.mjs), given to the command as its fourth stdio entry, so the lock lasts while the
//    command does, even when this process dies.
// Each command leads a process group of its own (`detached`), and stopping it signals the whole group. `active()` lists the commands
// still running, for the runner's final clean-up check.
import { spawn } from "node:child_process";
import { DOCKER_CONTEXT } from "./docker-resources.mjs";
import { Cancelled } from "./ownership.mjs";

const killGroup = (child, sig) => {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
};

export function dockerExec({
  command = "docker",
  env = process.env,
  graceMs = 1000,
} = {}) {
  const running = new Set();
  let latch = null;
  const run = (args, options = {}) => {
    const {
      timeoutMs = 120_000,
      signal,
      abortable = true,
      whenStopped = false,
      input,
      hold,
    } = options;
    if (latch !== null && !whenStopped)
      return Promise.reject(new Cancelled(latch));
    if (signal?.aborted && abortable && !whenStopped)
      return Promise.reject(
        new Cancelled(
          String(signal.reason?.reason ?? signal.reason ?? "aborted"),
        ),
      );
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, {
          env: { ...env, DOCKER_CONTEXT },
          detached: true,
          stdio: [
            input === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
            ...(hold === undefined ? [] : [hold]),
          ],
        });
      } catch (error) {
        resolve({
          status: null,
          signal: null,
          stdout: "",
          stderr: String(error?.message ?? error),
          spawnError: error,
          timedOut: false,
        });
        return;
      }
      running.add(child);
      let stdout = "";
      let stderr = "";
      let ended = null;
      let killer = null;
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      if (input !== undefined) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      }
      const stop = (why) => {
        if (ended !== null) return;
        ended = why;
        killGroup(child, "SIGTERM");
        killer = setTimeout(() => killGroup(child, "SIGKILL"), graceMs);
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      const onAbort = () => {
        if (abortable && !whenStopped) stop("aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let spawnError = null;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, sig) => {
        clearTimeout(timer);
        clearTimeout(killer);
        signal?.removeEventListener("abort", onAbort);
        running.delete(child);
        if (ended === "aborted") {
          reject(
            new Cancelled(
              String(signal?.reason?.reason ?? signal?.reason ?? "aborted"),
            ),
          );
          return;
        }
        resolve({
          status: ended === "timeout" ? null : code,
          signal: sig,
          stdout,
          stderr: spawnError
            ? `${stderr}${String(spawnError.message)}`
            : stderr,
          spawnError,
          timedOut: ended === "timeout",
        });
      });
    });
  };
  return {
    run,
    /** From now on only clean-up commands (`whenStopped`) start; returns the first reason. */
    stop(reason) {
      latch ??= String(reason);
      return latch;
    },
    /** The commands still running (their pids). */
    active: () => [...running].map((child) => child.pid),
    /** Wait, bounded, for every running command to end; returns the pids still running. */
    async settle(ms = 5_000) {
      const until = Date.now() + ms;
      while (running.size > 0 && Date.now() < until)
        await new Promise((r) => setTimeout(r, 50));
      return [...running].map((child) => child.pid);
    },
  };
}

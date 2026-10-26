// WEB-08c revision 14 (review 14, R18 `integration-runner-failfast`): the process groups the integration runner owns.
//
// Review 14 stopped the runner after its failures: its clean-up stopped the backend and the preview, but Playwright and its worker
// kept running, because the Playwright child was never registered for clean-up and its descendants were never addressed at all.
// Every process the runner spawns now LEADS A PROCESS GROUP OF ITS OWN (`detached`), so a child's whole tree (Playwright's workers
// and browsers, a server's helpers) is owned with it and can be signalled as one. Only those groups are ever signalled: never the
// runner's own group (the shared validation driver owns that one) and never anything else.
//
//   spawn(label, ...)   start an owned group; refused (phase `prepare`) once the runner has been interrupted
//   interrupt()         the first SIGINT/SIGTERM: no new group may start; each leader is asked to stop (Playwright with SIGINT, so it
//                       still writes its partial report), every group is sent SIGTERM after `interruptTermMs` and SIGKILL after
//                       `interruptKillMs` (both inside the shared validation driver's two-second grace before its own SIGKILL)
//   stopAll()           SIGTERM to every owned group, a bounded wait for EVERY member (not just the leader) to be gone, SIGKILL for
//                       survivors, a bounded wait again; a group that still has members is a PROBLEM (it fails the stack). Members
//                       found after their leader had already exited are reported as a note (the tree outlived its leader).
//                       Idempotent: a stop in progress is joined.
import { spawn as nodeSpawn } from "node:child_process";

export function ownedGroups({
  spawn = nodeSpawn,
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule = (fn, ms) => setTimeout(fn, ms).unref(),
  graceMs = 5_000,
  killWaitMs = 2_000,
  pollMs = 50,
  interruptTermMs = 900,
  interruptKillMs = 1_700,
  onSpawn = () => undefined,
} = {}) {
  /** pgid -> { label, child, interruptWith } */
  const owned = new Map();
  let closed = null;
  let stopping = null;

  /** Whether the group still has a member (ESRCH: none; any other answer, EPERM included, counts as present). */
  const present = (pgid) => {
    try {
      kill(-pgid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  };
  const signalGroup = (pgid, signal) => {
    try {
      kill(-pgid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const leaderExited = (child) =>
    child.exitCode !== null || child.signalCode !== null;

  function spawnOwned(label, command, args, options = {}, extra = {}) {
    if (closed)
      throw Object.assign(new Error(`${label} not started: ${closed}`), {
        phase: "prepare",
      });
    const child = spawn(command, args, { ...options, detached: true });
    if (child.pid) {
      owned.set(child.pid, {
        label,
        child,
        interruptWith: extra.interruptWith ?? "SIGTERM",
      });
      onSpawn({ pgid: child.pid, label });
    }
    return child;
  }

  function interrupt(reason = "interrupted") {
    if (closed) return;
    closed = reason;
    for (const [pgid, { child, interruptWith }] of owned) {
      // The leader first (Playwright reports what it ran); the whole group follows below.
      if (!leaderExited(child))
        try {
          child.kill(interruptWith);
        } catch {
          // already gone
        }
      else signalGroup(pgid, "SIGTERM");
    }
    schedule(() => {
      for (const pgid of owned.keys())
        if (present(pgid)) signalGroup(pgid, "SIGTERM");
    }, interruptTermMs);
    schedule(() => {
      for (const pgid of owned.keys())
        if (present(pgid)) signalGroup(pgid, "SIGKILL");
    }, interruptKillMs);
  }

  async function waitGone(pgids, ms) {
    const until = Date.now() + ms;
    for (;;) {
      const left = pgids.filter(present);
      if (left.length === 0 || Date.now() >= until) return left;
      await sleep(pollMs);
    }
  }

  function stopAll() {
    stopping ??= (async () => {
      const problems = [];
      const notes = [];
      const groups = [...owned.entries()];
      for (const [pgid, { label, child }] of groups)
        if (present(pgid)) {
          if (leaderExited(child))
            notes.push(
              `process group ${pgid} (${label}) still had members after its leader exited; terminated`,
            );
          signalGroup(pgid, "SIGTERM");
        }
      let left = await waitGone(
        groups.map(([pgid]) => pgid),
        graceMs,
      );
      for (const pgid of left) signalGroup(pgid, "SIGKILL");
      if (left.length > 0) left = await waitGone(left, killWaitMs);
      for (const pgid of left)
        problems.push(
          `process group ${pgid} (${owned.get(pgid)?.label}) still has members after SIGKILL`,
        );
      // Survivors stay owned (a later stop tries again); empty groups are forgotten, so a reused group id is never signalled.
      for (const [pgid] of groups) if (!left.includes(pgid)) owned.delete(pgid);
      return { problems, notes };
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  }

  return {
    spawn: spawnOwned,
    interrupt,
    stopAll,
    get closed() {
      return closed;
    },
    /** The groups still owned (for evidence and tests). */
    owned: () =>
      [...owned.entries()].map(([pgid, { label }]) => ({ pgid, label })),
  };
}

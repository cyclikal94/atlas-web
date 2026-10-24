import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Cancelled,
  createOwner,
  descendants,
  membersOf,
  processTable,
} from "./ownership.mjs";

const isLive = (pid) =>
  processTable().some((row) => row.pid === pid && !row.zombie);
const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/**
 * A process tree like Playwright's: a parent with a child in its own group, a detached grandchild in a group of its own (as
 * Playwright starts browsers), all holding the parent's stdout pipe open, and each writing its pid to `dir`.
 */
function fixture(dir, { ignoreTerm = false } = {}) {
  const leaf = `
    require("node:fs").writeFileSync(process.argv[1] + "/" + process.argv[2], String(process.pid));
    ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
    setInterval(() => {}, 1000);`;
  const parent = `
    const { spawn } = require("node:child_process");
    const leaf = ${JSON.stringify(leaf)};
    spawn(process.execPath, ["-e", leaf, ${JSON.stringify(dir)}, "child"], { stdio: "inherit" });
    spawn(process.execPath, ["-e", leaf, ${JSON.stringify(dir)}, "detached"], { stdio: "inherit", detached: true });
    ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
    require("node:fs").writeFileSync(${JSON.stringify(dir)} + "/parent", String(process.pid));
    setInterval(() => {}, 1000);`;
  return ["-e", parent];
}
/** Whatever the code under test does, every fixture process is gone when the test ends (a survivor fails an assertion, never hangs the file). */
function reap(t, dir) {
  t.after(() => {
    for (const pid of Object.values(pids(dir)))
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
  });
}
const pids = (dir) =>
  Object.fromEntries(
    ["parent", "child", "detached"].map((name) => {
      try {
        return [name, Number(readFileSync(join(dir, name), "utf8"))];
      } catch {
        return [name, null];
      }
    }),
  );

function sentinel(t) {
  const s = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => s.kill("SIGKILL"));
  return s;
}

test("terminating an owned process stops its whole tree, closes its pipes and leaves an unrelated process alone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  reap(t, dir); // registered first: it reads the pid files before the directory goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unrelated = sentinel(t);
  const owner = createOwner({ graceMs: 3000 });
  const handle = owner.spawnOwned("job", process.execPath, fixture(dir), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  handle.child.stdout.resume();
  handle.child.stderr.resume();
  assert.ok(await until(() => Object.values(pids(dir)).every(Boolean)));
  const tree = pids(dir);
  owner.snapshot(handle);
  const result = await owner.terminate(handle);
  assert.deepEqual(result.survivors, []);
  assert.equal(result.escalated, false);
  for (const pid of Object.values(tree))
    assert.equal(isLive(pid), false, `${pid}`);
  assert.notEqual(handle.exit, null, "the pipes closed and the exit was seen");
  assert.equal(isLive(unrelated.pid), true);
  assert.deepEqual(owner.owned(), []);
});

test("a process tree that ignores SIGTERM is killed after the grace period and nothing survives", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  reap(t, dir); // registered first: it reads the pid files before the directory goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 400 });
  const handle = owner.spawnOwned(
    "stubborn",
    process.execPath,
    fixture(dir, { ignoreTerm: true }),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  handle.child.stdout.resume();
  handle.child.stderr.resume();
  assert.ok(await until(() => Object.values(pids(dir)).every(Boolean)));
  const tree = pids(dir);
  const result = await owner.terminate(handle);
  assert.equal(result.escalated, true);
  assert.deepEqual(result.survivors, []);
  for (const pid of Object.values(tree)) assert.equal(isLive(pid), false);
});

test("a descendant whose parent died first is still owned once it has been seen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  reap(t, dir); // registered first: it reads the pid files before the directory goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 1000 });
  const handle = owner.spawnOwned("job", process.execPath, fixture(dir), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  handle.child.stdout.resume();
  handle.child.stderr.resume();
  assert.ok(await until(() => Object.values(pids(dir)).every(Boolean)));
  const tree = pids(dir);
  owner.snapshot(handle); // as the runner does every two seconds while Playwright runs
  process.kill(tree.parent, "SIGKILL");
  assert.ok(await until(() => !isLive(tree.parent)));
  assert.equal(
    descendants(handle.pid).includes(tree.detached),
    false,
    "orphaned: no longer found below the owned process",
  );
  const result = await owner.terminate(handle);
  assert.deepEqual(result.survivors, []);
  assert.equal(isLive(tree.detached), false);
  assert.equal(isLive(tree.child), false);
});

test("a remembered pid that is now a different process is never signalled", async (t) => {
  const unrelated = sentinel(t);
  const owner = createOwner({ graceMs: 200 });
  const handle = owner.spawnOwned(
    "short",
    process.execPath,
    ["-e", "setTimeout(() => {}, 50)"],
    { stdio: "ignore" },
  );
  await handle.closed;
  // As if the unrelated process had been given a pid this job's descendant once had, at another start time.
  handle.known.set(unrelated.pid, "Thu  1 Jan 00:00:00 1970");
  const result = await owner.terminate(handle);
  assert.equal(
    result.signalled.some((s) => s.pid === unrelated.pid),
    false,
  );
  assert.equal(isLive(unrelated.pid), true);
});

test("after the latch nothing more is started", () => {
  const owner = createOwner();
  owner.stop("first stack failed");
  owner.stop("a later reason does not replace the first");
  assert.equal(owner.latched, "first stack failed");
  assert.throws(
    () => owner.spawnOwned("late", process.execPath, ["-e", ""], {}),
    (error) =>
      error instanceof Cancelled && /first stack failed/.test(error.message),
  );
  assert.throws(() => owner.check(), Cancelled);
});

test("a spawn error is recorded and settles the handle", async () => {
  const owner = createOwner();
  const handle = owner.spawnOwned("missing", "/nonexistent/atlas-binary", [], {
    stdio: "ignore",
  });
  const exit = await handle.closed;
  assert.match(handle.spawnError, /ENOENT/);
  assert.equal(exit.code, null);
  const result = await owner.terminate(handle);
  assert.deepEqual(result.survivors, []);
});

test("the runner's own process and its parent are never part of what it owns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  reap(t, dir); // registered first: it reads the pid files before the directory goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "x"), "");
  const owner = createOwner();
  const handle = owner.spawnOwned("job", process.execPath, fixture(dir), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  handle.child.stdout.resume();
  handle.child.stderr.resume();
  assert.ok(await until(() => Object.values(pids(dir)).every(Boolean)));
  owner.snapshot(handle);
  assert.equal(handle.known.has(process.pid), false);
  assert.equal(handle.known.has(process.ppid), false);
  await owner.terminate(handle);
});

test("a polite signal lets the owned process finish in order; one that ignores it is terminated after the polite time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  reap(t, dir); // registered first: it reads the pid files before the directory goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 1000 });
  const orderly = owner.spawnOwned(
    "orderly",
    process.execPath,
    [
      "-e",
      `process.on("SIGINT", () => { require("node:fs").writeFileSync(${JSON.stringify(join(dir, "report"))}, "written"); process.exit(0); });
       require("node:fs").writeFileSync(${JSON.stringify(join(dir, "ready"))}, "");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore" },
  );
  assert.ok(
    await until(() => {
      try {
        readFileSync(join(dir, "ready"));
        return true;
      } catch {
        return false;
      }
    }),
  );
  const done = await owner.terminate(orderly, undefined, {
    signal: "SIGINT",
    ms: 3000,
  });
  assert.deepEqual(
    done.signalled.map((s) => s.signal),
    ["SIGINT"],
  );
  assert.equal(readFileSync(join(dir, "report"), "utf8"), "written");
  const deaf = owner.spawnOwned(
    "deaf",
    process.execPath,
    ["-e", 'process.on("SIGINT", () => {}); setInterval(() => {}, 1000);'],
    { stdio: "ignore" },
  );
  t.after(() => {
    orderly.child.kill("SIGKILL");
    deaf.child.kill("SIGKILL");
  });
  await new Promise((r) => setTimeout(r, 300));
  const stopped = await owner.terminate(deaf, undefined, {
    signal: "SIGINT",
    ms: 300,
  });
  assert.deepEqual(
    stopped.signalled.map((s) => s.signal),
    ["SIGINT", "SIGTERM"],
  );
  assert.deepEqual(stopped.survivors, []);
});

// Review r6 H4b and the design assessment's Q5/Q6: membership that does not depend on seeing the parent tree at the right moment.

/** Run `code` as a node script; `file(name)` is a pid file in `dir`. Every pid written there is SIGKILLed when the test ends. */
function scripted(t, dir) {
  t.after(() => {
    for (const name of readdirSync(dir))
      if (name.endsWith(".pid"))
        try {
          process.kill(
            Number(readFileSync(join(dir, name), "utf8")),
            "SIGKILL",
          );
        } catch {
          // already gone
        }
  });
  const pidOf = (name) => {
    try {
      return Number(readFileSync(join(dir, `${name}.pid`), "utf8"));
    } catch {
      return null;
    }
  };
  // A leaf that records its pid, optionally ignores SIGTERM, and runs until killed.
  const leaf = (name, { ignoreTerm = false } = {}) =>
    `require("node:fs").writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, String(process.pid));
     ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
     setInterval(() => {}, 1000);`;
  return { pidOf, leaf };
}

test("H4b: a detached child whose parent exits before any look is still owned, and stopped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unrelated = sentinel(t);
  // No periodic look at all (the runner's two-second one is not needed): the parent exits at once after starting its child.
  const owner = createOwner({ graceMs: 1000 });
  const parent = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(leaf("orphan"))}], { stdio: "ignore", detached: true }).unref();
    process.exit(0);`;
  const handle = owner.spawnOwned(
    "early-exit",
    process.execPath,
    ["-e", parent],
    { stdio: "ignore" },
  );
  await handle.closed;
  assert.ok(await until(() => pidOf("orphan")), "the child started");
  const orphan = pidOf("orphan");
  assert.equal(isLive(handle.pid), false, "the parent is gone before any look");
  assert.equal(
    processTable().find((r) => r.pid === orphan).ppid,
    1,
    "the child is no longer below the owned process",
  );
  const result = await owner.terminate(handle);
  assert.equal(isLive(orphan), false, "the orphan was stopped");
  assert.deepEqual(result.survivors, []);
  assert.equal(result.inventory, "complete");
  assert.equal(result.ok, true);
  assert.ok(result.signalled.some((s) => s.pid === orphan));
  assert.equal(
    isLive(unrelated.pid),
    true,
    "an unrelated process is never a member",
  );
});

test("H4b: the grandchild of a double fork (its parent gone before any look) and the child of an orphan are owned", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 1000 });
  // owned -> middle (starts `daemon` detached, then exits) ; daemon starts `late` after its own parent is gone.
  const daemon = `const { spawn } = require("node:child_process");
    setTimeout(() => spawn(process.execPath, ["-e", ${JSON.stringify(leaf("late"))}], { stdio: "ignore" }), 300);
    ${leaf("daemon")}`;
  const middle = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(daemon)}], { stdio: "ignore", detached: true }).unref();
    process.exit(0);`;
  const top = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { stdio: "ignore", detached: true }).unref();
    process.exit(0);`;
  const handle = owner.spawnOwned(
    "double-fork",
    process.execPath,
    ["-e", top],
    { stdio: "ignore" },
  );
  await handle.closed;
  assert.ok(await until(() => pidOf("daemon") && pidOf("late")));
  const [d, l] = [pidOf("daemon"), pidOf("late")];
  assert.equal(processTable().find((r) => r.pid === d).ppid, 1);
  const result = await owner.terminate(handle);
  assert.equal(isLive(d), false);
  assert.equal(isLive(l), false);
  assert.deepEqual(result.survivors, []);
  assert.equal(result.ok, true);
});

test("Q6: a descendant started during shutdown is owned; a member that ignores SIGTERM is frozen and killed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unrelated = sentinel(t);
  const owner = createOwner({ graceMs: 600, killWaitMs: 1000 });
  // On SIGTERM it starts a detached child (a birth during shutdown) and carries on.
  const stubborn = `const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => {
      spawn(process.execPath, ["-e", ${JSON.stringify(leaf("born", { ignoreTerm: true }))}], { stdio: "ignore", detached: true }).unref();
    });
    ${leaf("stubborn")}`;
  const handle = owner.spawnOwned(
    "stubborn",
    process.execPath,
    ["-e", stubborn],
    { stdio: "ignore" },
  );
  assert.ok(await until(() => pidOf("stubborn")));
  const result = await owner.terminate(handle);
  assert.ok(pidOf("born"), "the shutdown birth happened");
  assert.equal(
    isLive(pidOf("born")),
    false,
    "the process born during shutdown is gone",
  );
  assert.equal(isLive(pidOf("stubborn")), false);
  assert.equal(result.escalated, true);
  assert.ok(
    result.frozen.length > 0,
    "the remaining members were frozen before they were killed",
  );
  assert.deepEqual(result.survivors, []);
  assert.equal(result.ok, true);
  assert.equal(isLive(unrelated.pid), true);
});

test("Q6: a pipe inherited by a descendant that outlives its parent completes only when that descendant is gone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 1000 });
  const parent = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(leaf("holder"))}], { stdio: "inherit", detached: true }).unref();
    setTimeout(() => process.exit(0), 200);`;
  const handle = owner.spawnOwned("pipe", process.execPath, ["-e", parent], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  handle.child.stdout.resume();
  handle.child.stderr.resume();
  assert.ok(await until(() => pidOf("holder")));
  assert.ok(await until(() => !isLive(handle.pid)), "the direct child exited");
  assert.equal(
    handle.exit,
    null,
    "its pipes are still held open, so it has not closed",
  );
  const result = await owner.terminate(handle);
  assert.equal(isLive(pidOf("holder")), false);
  assert.equal(result.pipes_closed, true);
  assert.notEqual(handle.exit, null);
  assert.equal(result.ok, true);
});

test("a descendant whose environment shows no mark is adopted while it is below a member, and remembered", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 1000 });
  const parent = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(leaf("unmarked"))}], { stdio: "ignore", env: {} });
    ${leaf("parent")}`;
  const handle = owner.spawnOwned("adopt", process.execPath, ["-e", parent], {
    stdio: "ignore",
  });
  assert.ok(await until(() => pidOf("unmarked") && pidOf("parent")));
  const row = processTable().find((r) => r.pid === pidOf("unmarked"));
  assert.deepEqual(row.marks, [], "it carries no mark");
  const members = owner.members(handle);
  assert.equal(
    members.get(pidOf("unmarked"))?.marked,
    false,
    "found through the live tree",
  );
  assert.equal(members.get(pidOf("parent"))?.marked, true);
  const result = await owner.terminate(handle);
  assert.equal(isLive(pidOf("unmarked")), false);
  assert.equal(result.ok, true);
});

test("the known limit (docs/session.md): an unmarked process that left the tree before any look is not attributable; holding a pipe, it is still not reported clean", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 300, killWaitMs: 300 });
  const parent = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(leaf("stripped"))}], { stdio: ["ignore", "inherit", "inherit"], env: {}, detached: true }).unref();
    process.exit(0);`;
  const handle = owner.spawnOwned("strip", process.execPath, ["-e", parent], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  handle.child.stdout.resume();
  handle.child.stderr.resume();
  assert.ok(await until(() => pidOf("stripped")));
  assert.ok(await until(() => !isLive(handle.pid)));
  const result = await owner.terminate(handle);
  // This is the boundary the runner documents, not a guarantee it gives: the process is still alive (the test's own clean-up
  // kills it). No process of the integration programme starts this way (revision 7 qualification, real browsers). Because it
  // holds the owned child's pipes, the handle is not verified: an unattributable holder is never reported as a clean stop.
  assert.equal(isLive(pidOf("stripped")), true);
  assert.equal(result.pipes_closed, false);
  assert.equal(result.ok, false);
  assert.equal(owner.owned().includes(handle), true);
});

test("traversal starts only from members whose identity still matches; a reused root pid adopts nothing", () => {
  const table = [
    {
      pid: 100,
      ppid: 1,
      zombie: false,
      started: "Wed Oct 14 01:00:00 2026",
      marks: [],
    }, // reused pid: another process now
    {
      pid: 101,
      ppid: 100,
      zombie: false,
      started: "Wed Oct 14 01:00:01 2026",
      marks: [],
    }, // ITS child, not ours
    {
      pid: 200,
      ppid: 1,
      zombie: false,
      started: "Wed Oct 14 00:00:00 2026",
      marks: ["aaaaaaaaaaaaaaaa=3"],
    },
    {
      pid: 201,
      ppid: 200,
      zombie: false,
      started: "Wed Oct 14 00:00:01 2026",
      marks: [],
    },
    {
      pid: 202,
      ppid: 200,
      zombie: true,
      started: "Wed Oct 14 00:00:02 2026",
      marks: [],
    },
    {
      pid: 300,
      ppid: 1,
      zombie: false,
      started: "Wed Oct 14 00:00:00 2026",
      marks: ["aaaaaaaaaaaaaaaa=4"],
    },
  ];
  const found = membersOf({
    table,
    marks: new Set(["aaaaaaaaaaaaaaaa=3"]),
    known: new Map([[100, "Tue Oct 13 23:00:00 2026"]]), // the root as it was when it was ours
    never: new Set(),
  });
  assert.deepEqual(
    [...found.keys()].sort(),
    [200, 201],
    "the marked member and its live child only",
  );
  assert.equal(found.get(201).marked, false);
});

test("a process table that cannot be read is an unknown inventory, never an empty survivor list, and the handle stays owned", async () => {
  let broken = false;
  const owner = createOwner({
    graceMs: 200,
    killWaitMs: 200,
    table: () => {
      if (broken) throw new Error("ps failed");
      return processTable();
    },
  });
  const handle = owner.spawnOwned(
    "job",
    process.execPath,
    ["-e", "setTimeout(() => {}, 300)"],
    { stdio: "ignore" },
  );
  broken = true;
  const result = await owner.terminate(handle);
  assert.equal(result.inventory, "unknown");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ps failed/);
  assert.equal(owner.owned().includes(handle), true, "not forgotten");
  assert.throws(() => owner.sweep(), /ps failed/);
  broken = false;
  await handle.closed;
});

test("exec: an owned command's output, its input, a time-out and a stop", async () => {
  const owner = createOwner();
  const echoed = await owner.exec(
    "echo",
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input: "in\n" },
  );
  assert.equal(echoed.status, 0);
  assert.equal(echoed.stdout, "in\n");
  assert.equal(echoed.stopped.ok, true);
  const slow = await owner.exec(
    "slow",
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 300 },
  );
  assert.equal(slow.timedOut, true);
  assert.equal(slow.stopped.ok, true);
  const controller = new AbortController();
  const pending = owner.exec(
    "stoppable",
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Cancelled("a signal")), 200);
  await assert.rejects(
    pending,
    (error) => error instanceof Cancelled && error.stopped.ok === true,
  );
  // A creation command is not abortable: it completes, so its creation is never left half-reported.
  const firm = new AbortController();
  const creating = owner.exec(
    "create",
    process.execPath,
    ["-e", "setTimeout(() => console.log('made'), 300)"],
    {
      signal: firm.signal,
      abortable: false,
    },
  );
  firm.abort(new Cancelled("a signal"));
  assert.equal((await creating).stdout, "made\n");
  owner.stop("latched");
  await assert.rejects(
    owner.exec("late", process.execPath, ["-e", ""]),
    Cancelled,
  );
  const cleanup = await owner.exec("cleanup", process.execPath, ["-e", ""], {
    whenStopped: true,
  });
  assert.equal(
    cleanup.status,
    0,
    "a clean-up command still runs after the latch",
  );
});

test("Q5: an unmarked member that lost its parent is still traversed: a child it starts afterwards is owned", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-own-"));
  const { pidOf, leaf } = scripted(t, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = createOwner({ graceMs: 1000 });
  const go = join(dir, "go");
  // `outer` has no mark (its environment is empty); it starts `inner` (no mark either) only once the owned parent is gone.
  const outer = `const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(join(dir, "outer.pid"))}, String(process.pid));
    const wait = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(go)})) return;
      clearInterval(wait);
      spawn(process.execPath, ["-e", ${JSON.stringify(leaf("inner"))}], { stdio: "ignore", env: {} });
    }, 20);
    setInterval(() => {}, 1000);`;
  const parent = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(outer)}], { stdio: "ignore", env: {} });
    ${leaf("parent")}`;
  const handle = owner.spawnOwned(
    "orphaned-unmarked",
    process.execPath,
    ["-e", parent],
    { stdio: "ignore" },
  );
  assert.ok(await until(() => pidOf("outer") && pidOf("parent")));
  assert.equal(
    owner.members(handle).get(pidOf("outer"))?.marked,
    false,
    "remembered through the live tree",
  );
  process.kill(pidOf("parent"), "SIGKILL");
  assert.ok(
    await until(
      () => processTable().find((r) => r.pid === pidOf("outer"))?.ppid === 1,
    ),
    "outer is orphaned",
  );
  writeFileSync(go, "");
  assert.ok(await until(() => pidOf("inner")));
  const result = await owner.terminate(handle);
  assert.equal(
    isLive(pidOf("inner")),
    false,
    "found from the remembered, orphaned member",
  );
  assert.equal(isLive(pidOf("outer")), false);
  assert.equal(result.ok, true);
});

test("revision 30: a caller whose own environment carries a mark never finds the listing process itself as a marked member", () => {
  // The maintained runner sets ATLAS_IT_<token>=1 in its own process.env so every child inherits it; `ps` is one of those children.
  const token = "0123456789abcdef";
  const name = `ATLAS_IT_${token}`;
  const before = process.env[name];
  process.env[name] = "1";
  try {
    for (let i = 0; i < 3; i += 1) {
      const members = membersOf({
        table: processTable(),
        marks: new Set([`${token}=1`]),
        never: new Set([process.pid, process.ppid]),
      });
      assert.deepEqual([...members.keys()], []);
    }
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

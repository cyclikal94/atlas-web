import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Cancelled,
  createOwner,
  descendants,
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

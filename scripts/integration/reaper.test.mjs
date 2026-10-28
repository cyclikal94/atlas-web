// The maintained runner's reaper with REAL processes (WEB-08d revision 30, DELEGATED-WEB08D-RUNNER-RECONCILIATION-20261024): when the
// runner is killed before it releases the reaper, the reaper stops the owned groups, any marked process that left its group and the
// registered stacks' Docker resources; a released reaper touches nothing; a pgid registered after its process had started (a reused
// pgid) is never signalled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REAPER = join(here, "reaper.mjs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A stand-in for run.mjs's use of the reaper: it starts the reaper exactly as run.mjs does (first, detached, stdin a pipe), then
 * follows `script`: `group` starts a detached sleeper and registers its group; `bare` does the same for a sleeper WITHOUT the mark
 * (as WebKit's `pw_run.sh`, whose environment `ps` cannot read); `escapee` starts a marked sleeper in a group of its own
 * that is NOT registered (it left its group); `register <pid>` registers an existing pid as a group; `docker <label>` registers a
 * stack; `release` releases; `kill` SIGKILLs this process. The pids it started are written to `pids.json` before the last step.
 */
function runner(dir, script, env = {}) {
  const file = join(dir, "runner.mjs");
  writeFileSync(
    file,
    `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const reaper = spawn(process.execPath, [${JSON.stringify(REAPER)}, "--record", ${JSON.stringify(join(dir, "reaper.json"))}, "--grace-ms", "500"], { detached: true, stdio: ["pipe", "inherit", "inherit"] });
reaper.stdin.on("error", () => undefined);
const tell = (m) => reaper.stdin.write(JSON.stringify(m) + "\\n");
const token = ${JSON.stringify(randomBytes(8).toString("hex"))};
process.env["ATLAS_IT_" + token] = "1";
tell({ type: "mark", token });
const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
const pids = { reaper: reaper.pid, groups: [], escapees: [] };
for (const step of ${JSON.stringify(script)}) {
  const [what, arg] = step.split(" ");
  if (what === "group") { const c = sleeper(); c.unref(); tell({ type: "group", pgid: c.pid }); pids.groups.push(c.pid); }
  else if (what === "bare") { const env = { ...process.env }; delete env["ATLAS_IT_" + token]; const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env }); c.unref(); tell({ type: "group", pgid: c.pid }); pids.groups.push(c.pid); }
  else if (what === "escapee") { const c = sleeper(); c.unref(); pids.escapees.push(c.pid); }
  else if (what === "register") tell({ type: "group", pgid: Number(arg) });
  else if (what === "docker") tell({ type: "docker", stack: arg });
  else if (what === "dir") tell({ type: "dir", path: arg });
  else if (what === "raw") reaper.stdin.write(arg + "\\n");
  else if (what === "release") { tell({ type: "release" }); reaper.stdin.end(); }
  else if (what === "kill") { writeFileSync(${JSON.stringify(join(dir, "pids.json"))}, JSON.stringify(pids)); await new Promise((r) => setTimeout(r, 300)); process.kill(process.pid, "SIGKILL"); }
}
writeFileSync(${JSON.stringify(join(dir, "pids.json"))}, JSON.stringify(pids));
await new Promise((r) => reaper.once("exit", r));
`,
  );
  return spawn(process.execPath, [file], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}
const pidsOf = (dir) =>
  JSON.parse(readFileSync(join(dir, "pids.json"), "utf8"));
const exited = (child) =>
  new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
const fresh = () =>
  mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "reaper-test-"));
const kill = (pids) => {
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
};

test("a runner killed before its release: its registered groups (marked or not) and a marked process outside them are stopped, the record says so", async (t) => {
  const dir = fresh();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = runner(dir, ["group", "bare", "escapee", "kill"]);
  const end = await exited(child);
  assert.equal(end.signal, "SIGKILL");
  const pids = pidsOf(dir);
  t.after(() => kill([...pids.groups, ...pids.escapees, pids.reaper]));
  await until(
    () => existsSync(join(dir, "reaper.json")),
    15_000,
    "the reaper's record",
  );
  const record = JSON.parse(readFileSync(join(dir, "reaper.json"), "utf8"));
  assert.equal(record.released, false);
  assert.equal(record.ok, true, JSON.stringify(record));
  assert.deepEqual(record.groups.sort(), [...pids.groups].sort());
  await until(() => !alive(pids.reaper), 5_000, "the reaper to exit");
  for (const pid of [...pids.groups, ...pids.escapees])
    assert.equal(alive(pid), false, `pid ${pid} still alive`);
  assert.deepEqual(record.marked.left, []);
});

test("control: a released reaper writes nothing and leaves a registered group alone", async (t) => {
  const dir = fresh();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = runner(dir, ["group", "release"]);
  const end = await exited(child);
  assert.equal(end.code, 0);
  const pids = pidsOf(dir);
  t.after(() => kill(pids.groups));
  await until(() => !alive(pids.reaper), 5_000, "the reaper to exit");
  assert.equal(existsSync(join(dir, "reaper.json")), false);
  for (const pid of pids.groups) assert.equal(alive(pid), true);
});

test("a pgid registered after its process had started (a reused pgid) is never signalled", async (t) => {
  const dir = fresh();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const older = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => kill([older.pid]));
  // Older than the reaper's one-second resolution plus its two-second allowance.
  await pause(4_000);
  const child = runner(dir, [`register ${older.pid}`, "kill"]);
  await exited(child);
  await until(
    () => existsSync(join(dir, "reaper.json")),
    15_000,
    "the reaper's record",
  );
  const record = JSON.parse(readFileSync(join(dir, "reaper.json"), "utf8"));
  assert.deepEqual(record.stopped, []);
  assert.equal(alive(older.pid), true);
});

test("a killed runner's registered Docker stack is disposed of by its label (a recording docker double), and an unverified disposal fails the record", async (t) => {
  for (const [label, status, ok] of [
    ["stack-a", 0, true],
    ["stack-b", 1, false],
  ]) {
    const dir = fresh();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const docker = join(dir, "docker");
    const log = join(dir, "docker.log");
    // Every command answers an empty inventory; with status 1, `docker ps` fails, so the inventory is unknown.
    writeFileSync(
      docker,
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$1" in ps) exit ${status};; esac\nexit 0\n`,
    );
    chmodSync(docker, 0o755);
    const child = runner(dir, [`docker ${label}`, "kill"], {
      ATLAS_INTEGRATION_DOCKER: docker,
      ATLAS_INTEGRATION_COORDINATION_DIR: join(dir, "coordination"),
    });
    await exited(child);
    await until(
      () => existsSync(join(dir, "reaper.json")),
      30_000,
      "the reaper's record",
    );
    const record = JSON.parse(readFileSync(join(dir, "reaper.json"), "utf8"));
    assert.equal(record.docker.length, 1);
    assert.equal(record.docker[0].filter, `atlas.it.stack=${label}`);
    assert.equal(record.ok, ok, JSON.stringify(record));
    assert.match(
      readFileSync(log, "utf8"),
      new RegExp(`label=atlas.it.stack=${label}`),
    );
  }
});

test("a killed runner's registered disposable directory is removed; a released reaper leaves it; a directory outside the runner's naming is refused", async (t) => {
  for (const [release, ok] of [
    [false, true],
    [true, true],
  ]) {
    const dir = fresh();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const disposable = mkdtempSync(join(dir, "atlas-integration-"));
    writeFileSync(join(disposable, "atlas.sqlite"), "x");
    const child = runner(dir, [
      `dir ${disposable}`,
      release ? "release" : "kill",
    ]);
    await exited(child);
    if (release) {
      const pids = pidsOf(dir);
      await until(() => !alive(pids.reaper), 5_000, "the reaper to exit");
      assert.equal(existsSync(disposable), true);
      assert.equal(existsSync(join(dir, "reaper.json")), false);
    } else {
      await until(
        () => existsSync(join(dir, "reaper.json")),
        15_000,
        "the reaper's record",
      );
      const record = JSON.parse(readFileSync(join(dir, "reaper.json"), "utf8"));
      assert.equal(record.ok, ok, JSON.stringify(record));
      assert.deepEqual(record.dirs, [{ path: disposable, removed: true }]);
      assert.equal(existsSync(disposable), false);
    }
  }
  const dir = fresh();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const other = mkdtempSync(join(dir, "user-data-"));
  const child = runner(dir, [`dir ${other}`, "release"]);
  await exited(child);
  await until(
    () => existsSync(join(dir, "reaper.json")),
    10_000,
    "the reaper's record",
  );
  const record = JSON.parse(readFileSync(join(dir, "reaper.json"), "utf8"));
  assert.equal(record.ok, false);
  assert.match(record.errors.join(" "), /unknown message/);
  assert.equal(existsSync(other), true);
});

test("a malformed message is never a clean release", async (t) => {
  const dir = fresh();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = runner(dir, ["raw {not-json", "release"]);
  await exited(child);
  await until(
    () => existsSync(join(dir, "reaper.json")),
    10_000,
    "the reaper's record",
  );
  const record = JSON.parse(readFileSync(join(dir, "reaper.json"), "utf8"));
  assert.equal(record.ok, false);
  assert.match(record.errors.join(" "), /malformed message/);
});

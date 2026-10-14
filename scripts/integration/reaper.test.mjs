import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processTable } from "./ownership.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const isLive = (pid) =>
  processTable().some((row) => row.pid === pid && !row.zombie);
const until = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * A controller shaped like run.mjs: it starts the reaper first, journals what it owns (an owned process tree with a detached
 * member, a disposable directory, the current stack of a two-stack plan), writes its running summary, then either releases the
 * journal or waits to be killed.
 */
function controller(
  t,
  { release = false, judged = null, finished = false, port = null } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-"));
  const runDir = join(dir, "run");
  const scratch = join(dir, "scratch");
  mkdirSync(runDir);
  mkdirSync(scratch);
  t.after(() => {
    for (const name of ["leaf", "detached", "controller", "reaper"]) {
      const pid = Number(read(join(dir, `${name}.pid`)));
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  // The fixture scripts are files (no quoting of code inside code).
  const leaf = (name) => {
    const path = join(dir, `${name}.cjs`);
    writeFileSync(
      path,
      `require("node:fs").writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, String(process.pid)); setInterval(() => {}, 1000);\n`,
    );
    return path;
  };
  const parent = join(dir, "parent.cjs");
  writeFileSync(
    parent,
    `const { spawn } = require("node:child_process");
     spawn(process.execPath, [${JSON.stringify(leaf("detached"))}], { stdio: "ignore", detached: true }).unref();
     require(${JSON.stringify(leaf("leaf"))});\n`,
  );
  const script = join(dir, "controller.mjs");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { createOwner } from ${JSON.stringify(join(here, "ownership.mjs"))};
    const runDir = ${JSON.stringify(runDir)};
    const owner = createOwner();
    const reaper = spawn(process.execPath, [${JSON.stringify(join(here, "reaper.mjs"))}, runDir, owner.token, String(process.pid)],
      { detached: true, stdio: ["pipe", "inherit", "inherit"] });
    writeFileSync(${JSON.stringify(join(dir, "reaper.pid"))}, String(reaper.pid));
    owner.exclude(reaper.pid);
    const journal = (m) => reaper.stdin.write(JSON.stringify(m) + "\\n");
    journal({ type: "hello", invocation: "inv-test", evidence: ${JSON.stringify(dir)} });
    writeFileSync(runDir + "/plan.json", JSON.stringify({ browsers: ["chromium", "firefox"], stacks: [{ stack: "base" }, { stack: "-labels" }] }));
    writeFileSync(runDir + "/summary.json", JSON.stringify({ schema: 3, invocation: { finished: ${finished} },
      outcome: ${JSON.stringify(finished ? "passed" : "running")},
      stacks: [{ browser: "chromium", stack: "base", index: 0, outcome: "passed" }] }));
    journal({ type: "tmp", path: ${JSON.stringify(scratch)} });
    if (${JSON.stringify(port)} !== null) journal({ type: "ports", ports: [${JSON.stringify(port)}] });
    journal({ type: "stack", browser: "chromium", index: 1, stack: "-labels" });
    if (${JSON.stringify(judged)} !== null)
      journal({ type: "judged", browser: "chromium", index: 1, record: ${JSON.stringify(judged)} });
    owner.spawnOwned("tree", process.execPath, [${JSON.stringify(parent)}], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(join(dir, "controller.pid"))}, String(process.pid));
    if (${release}) {
      reaper.stdin.end(JSON.stringify({ type: "released", ok: true }) + "\\n");
      reaper.once("exit", (code) => { writeFileSync(${JSON.stringify(join(dir, "reaper.exit"))}, String(code)); process.exit(0); });
    } else setInterval(() => {}, 1000);
`,
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const pid = (name) => Number(read(join(dir, `${name}.pid`))) || null;
  return { dir, runDir, scratch, child, closed, pid, output: () => output };
}

test("a runner killed before it could clean up: its reaper stops every owned process, removes its directory and completes the summary", async (t) => {
  const c = controller(t);
  assert.ok(
    await until(
      () => c.pid("controller") && c.pid("leaf") && c.pid("detached"),
    ),
    c.output(),
  );
  const [leaf, detached, reaper] = [
    c.pid("leaf"),
    c.pid("detached"),
    c.pid("reaper"),
  ];
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => unrelated.kill("SIGKILL"));
  // As the shared validation driver does two seconds after asking: nothing of the runner gets to run any more.
  process.kill(c.pid("controller"), "SIGKILL");
  // The caller waiting for the runner's output waits for the reaper too (it holds the same pipes).
  await c.closed;
  assert.equal(
    isLive(reaper),
    false,
    "the reaper finished before the runner's pipes closed",
  );
  assert.equal(isLive(leaf), false);
  assert.equal(isLive(detached), false, "the detached member too");
  assert.equal(isLive(unrelated.pid), true);
  assert.equal(existsSync(c.scratch), false);
  const reaped = JSON.parse(read(join(c.runDir, "reaper.json")));
  assert.equal(reaped.controller_lost, true);
  assert.equal(reaped.ok, true, JSON.stringify(reaped, null, 2));
  assert.deepEqual(reaped.processes.survivors, []);
  assert.ok(
    reaped.processes.members.includes(leaf) &&
      reaped.processes.members.includes(detached),
  );
  const summary = JSON.parse(read(join(c.runDir, "summary.json")));
  assert.equal(summary.invocation.finished, true);
  assert.equal(summary.outcome, "cancelled", "never a pass");
  assert.equal(summary.controller_lost, true);
  assert.deepEqual(
    summary.stacks.map((s) => [s.browser, s.index, s.outcome]),
    [
      ["chromium", 0, "passed"],
      ["chromium", 1, "cancelled"],
      ["firefox", 0, "not_run"],
      ["firefox", 1, "not_run"],
    ],
  );
  assert.equal(
    JSON.parse(read(join(c.dir, "summary.json"))).outcome,
    "cancelled",
    "the parent summary, when absent, too",
  );
});

test("a released journal: the reaper exits at once and touches nothing", async (t) => {
  const c = controller(t, { release: true });
  await c.closed;
  assert.ok(await until(() => c.pid("leaf") && c.pid("detached")), c.output());
  assert.equal(read(join(c.dir, "reaper.exit")), "0", c.output());
  assert.equal(existsSync(join(c.runDir, "reaper.json")), false);
  assert.equal(
    existsSync(c.scratch),
    true,
    "it did not clean up what the runner had released",
  );
  assert.equal(
    JSON.parse(read(join(c.runDir, "summary.json"))).outcome,
    "running",
  );
  // The released runner's own tree is the runner's business: here it is the test's to stop.
  for (const name of ["leaf", "detached"]) process.kill(c.pid(name), "SIGKILL");
  writeFileSync(join(c.dir, "done"), "");
});

// ---- review r7 H4c (revision 8): a take-over keeps what the runner had established ------------------------------------------------
const killController = async (c) => {
  assert.ok(
    await until(
      () => c.pid("controller") && c.pid("leaf") && c.pid("detached"),
    ),
    c.output(),
  );
  process.kill(c.pid("controller"), "SIGKILL");
  await c.closed;
  return JSON.parse(read(join(c.runDir, "summary.json")) ?? "{}");
};

test("H4c: a runner killed during the clean-up of a stack whose report had an error: the reaper keeps it failed", async (t) => {
  const judged = {
    outcome: "failed",
    reason: "the report has errors",
    report_errors: ["global teardown failed"],
    failure: { kind: "report_errors", reason: "the report has errors" },
    counts: { passed: 1, failed: 0, flaky: 0 },
  };
  const summary = await killController(controller(t, { judged }));
  const current = summary.stacks?.find(
    (s) => s.index === 1 && s.browser === "chromium",
  );
  assert.equal(current?.outcome, "failed");
  assert.deepEqual(current?.report_errors, ["global teardown failed"]);
  assert.match(current?.cancellation ?? "", /without releasing its journal/);
  assert.deepEqual(current?.cleanup, { by: "reaper", ok: true });
  assert.equal(
    summary.outcome,
    "failed",
    "an established failure is not a replaceable interruption",
  );
  assert.deepEqual(
    (summary.stacks ?? [])
      .filter((s) => s.browser === "firefox")
      .map((s) => s.outcome),
    ["not_run", "not_run"],
  );
});

test("H4c control: a runner killed while its stack was still running (nothing established) is cancelled", async (t) => {
  const judged = {
    outcome: "cancelled",
    reason: "stopped: received SIGTERM",
    before_cancellation: { outcome: "incomplete", reason: "1 interrupted" },
  };
  const summary = await killController(controller(t, { judged }));
  assert.equal(
    summary.stacks?.find((s) => s.index === 1 && s.browser === "chromium")
      ?.outcome,
    "cancelled",
  );
  assert.equal(summary.outcome, "cancelled");
});

test("H4c: a clean-up the reaper cannot verify makes the run failed, even after the runner's own finished summary", async (t) => {
  const server = createServer(() => undefined);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address();
  // Not finished: the current stack, cancelled by the take-over, becomes cleanup_failed.
  const running = await killController(controller(t, { port }));
  assert.equal(running.outcome, "failed");
  assert.equal(running.cleanup_failed, true);
  assert.equal(
    running.stacks?.find((s) => s.index === 1 && s.browser === "chromium")
      ?.outcome,
    "cleanup_failed",
  );
  // Finished as passed, then killed before it released the journal: the reaper's unverified clean-up fails the run.
  const finished = await killController(
    controller(t, { port, finished: true }),
  );
  assert.equal(finished.outcome, "failed");
  assert.equal(finished.outcome_before_reaper, "passed");
  assert.equal(finished.cleanup_failed, true);
});

test("H4c: a reaper told to clean up while its runner still runs leaves the runner's summary to the runner", async (t) => {
  const c = controller(t);
  assert.ok(
    await until(() => c.pid("controller") && c.pid("leaf")),
    c.output(),
  );
  process.kill(c.pid("reaper"), "SIGTERM");
  assert.ok(
    await until(() => existsSync(join(c.runDir, "reaper.json")), 20_000),
    c.output(),
  );
  const reaped = JSON.parse(read(join(c.runDir, "reaper.json")) ?? "{}");
  assert.equal(reaped.runner_alive, true);
  assert.equal(
    JSON.parse(read(join(c.runDir, "summary.json")) ?? "{}").outcome,
    "running",
  );
  process.kill(c.pid("controller"), "SIGKILL");
  await c.closed;
});

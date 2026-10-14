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

// ---- review r8 H4d (revision 9): the committed stack records are the authority of a take-over ----------------------------------------
import { chmodSync } from "node:fs";
import { createStackStore, stackKey } from "./stack-records.mjs";

const at = Date.now();
const failedReport = (status = "unexpected") => ({
  stats: { startTime: new Date(at + 500).toISOString() },
  errors: [],
  suites: [
    {
      title: "a.spec.ts",
      specs: [
        {
          id: "a",
          title: "a",
          file: "a.spec.ts",
          tests: [
            {
              projectName: "integration-chromium",
              status,
              results: [
                { status: status === "unexpected" ? "failed" : "passed" },
              ],
            },
          ],
        },
      ],
    },
  ],
});
const PLAN = {
  browsers: ["chromium"],
  stacks: [
    {
      stack: "base",
      cases: [
        {
          key: "integration-chromium|a",
          project: "integration-chromium",
          file: "a.spec.ts",
          title: "a",
        },
      ],
    },
    { stack: "-later", cases: [] },
  ],
};
const REPORT_FAILURE = {
  outcome: "failed",
  reason: "the report has errors",
  report_errors: ["teardown failed"],
  failure: { kind: "report_errors", reason: "the report has errors" },
  counts: { passed: 1, failed: 0, flaky: 0 },
};

/** A reaper whose runner is already gone, given `messages`; resolves with what it left. `prepare(runDir)` writes the run's files. */
async function reapDead(
  t,
  { prepare = () => undefined, messages = [], summary = true } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4d-"));
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  t.after(() => {
    try {
      chmodSync(runDir, 0o755);
    } catch {
      // gone
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN));
  if (summary)
    writeFileSync(
      join(runDir, "summary.json"),
      JSON.stringify({
        schema: 3,
        invocation: { finished: false },
        outcome: "running",
        stacks: [],
      }),
    );
  prepare(runDir);
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.once("exit", r));
  const reaper = spawn(
    process.execPath,
    [
      join(here, "reaper.mjs"),
      runDir,
      `ATLAS_TEST_${Date.now()}`,
      String(gone.pid),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let log = "";
  reaper.stdout.on("data", (d) => {
    log += d;
  });
  reaper.stderr.on("data", (d) => {
    log += d;
  });
  const closed = new Promise((r) => reaper.once("close", (code) => r(code)));
  reaper.stdin.end(
    [{ type: "hello", invocation: "inv-h4d", evidence: dir }, ...messages]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join(""),
  );
  const code = await closed;
  const parse = (name) => {
    try {
      return JSON.parse(readFileSync(join(runDir, name), "utf8"));
    } catch {
      return null;
    }
  };
  return {
    code,
    log,
    runDir,
    summary: parse("summary.json"),
    reaped: parse("reaper.json"),
  };
}
const stack0 = (summary) =>
  summary?.stacks?.find((s) => s.browser === "chromium" && s.index === 0);
const name0 = { browser: "chromium", stack: "base", index: 0 };

test("H4d: a stack-end confirmed by the committed settled record retires the checkpoint; the committed failure is the result", async (t) => {
  let seq = null;
  const r = await reapDead(t, {
    prepare: (runDir) => {
      const store = createStackStore(runDir);
      store.commit({ ...name0, outcome: "running" }, "started");
      store.commit({ ...name0, ...REPORT_FAILURE }, "judged");
      seq = store.commit(
        { ...name0, ...REPORT_FAILURE, cleanup: { ok: true } },
        "settled",
      ).seq;
    },
    messages: [
      { type: "stack", browser: "chromium", index: 0, stack: "base" },
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 2,
        record: REPORT_FAILURE,
      },
      // The runner was lost after this, before its summary had the stack (the review r8 H4d gap).
      { type: "stack-end", browser: "chromium", index: 0, seq: 3 },
    ],
  });
  assert.equal(seq, 3);
  assert.deepEqual(r.reaped?.retired, [
    { key: stackKey("chromium", 0), seq: 3 },
  ]);
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.equal(stack0(r.summary)?.outcome, "failed");
  assert.equal(
    stack0(r.summary)?.recovered_by,
    undefined,
    "complete: not settled again by the reaper",
  );
  assert.equal(
    r.summary?.stacks?.find((q) => q.index === 1)?.outcome,
    "not_run",
  );
});

test("H4d: a stack-end the reaper cannot confirm (the committed record is older) retires nothing; the reaper settles the stack", async (t) => {
  const r = await reapDead(t, {
    prepare: (runDir) => {
      const store = createStackStore(runDir);
      store.commit({ ...name0, outcome: "running" }, "started");
      store.commit({ ...name0, ...REPORT_FAILURE }, "judged");
    },
    messages: [
      { type: "stack", browser: "chromium", index: 0, stack: "base" },
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 2,
        record: REPORT_FAILURE,
      },
      { type: "stack-end", browser: "chromium", index: 0, seq: 3 },
      { type: "stack-end", browser: "chromium", index: 0 },
    ],
  });
  assert.deepEqual(r.reaped?.retired, []);
  assert.equal(stack0(r.summary)?.outcome, "failed", r.log);
  assert.equal(stack0(r.summary)?.recovered_by, "reaper");
  assert.deepEqual(stack0(r.summary)?.cleanup, { by: "reaper", ok: true });
  assert.equal(r.summary?.outcome, "failed");
});

test("H4d: a late or repeated stack-end of an earlier stack never clears a later stack's checkpoint", async (t) => {
  const r = await reapDead(t, {
    prepare: (runDir) => {
      const store = createStackStore(runDir);
      store.commit({ ...name0, outcome: "passed", reason: null }, "judged");
      store.commit(
        { ...name0, outcome: "passed", reason: null, cleanup: { ok: true } },
        "settled",
      );
    },
    messages: [
      { type: "stack", browser: "chromium", index: 0, stack: "base" },
      { type: "stack-end", browser: "chromium", index: 0, seq: 2 },
      { type: "stack", browser: "chromium", index: 1, stack: "-later" },
      // The later stack's facts reached only the journal (its record could not be written).
      {
        type: "judged",
        browser: "chromium",
        index: 1,
        seq: null,
        record: { ...REPORT_FAILURE, stack: "-later" },
      },
      { type: "stack-end", browser: "chromium", index: 0, seq: 2 },
      { type: "stack-end", browser: "chromium", index: 1 },
    ],
  });
  assert.equal(stack0(r.summary)?.outcome, "passed", r.log);
  const later = r.summary?.stacks?.find((s) => s.index === 1);
  assert.equal(later?.outcome, "failed");
  assert.deepEqual(later?.report_errors, ["teardown failed"]);
  assert.equal(r.summary?.outcome, "failed");
});

test("H4d: a stack lost after its launch was committed, before its judgement: its raw report is judged; a failed case stays failed", async (t) => {
  const launched =
    (status, write = true) =>
    (runDir) => {
      const report = join(runDir, "results-chromium.json");
      if (write) writeFileSync(report, JSON.stringify(failedReport(status)));
      const store = createStackStore(runDir);
      store.commit({ ...name0, outcome: "running", report }, "started");
      store.commit(
        { ...name0, outcome: "running", launched_at: at },
        "launched",
      );
    };
  const journalled = [
    { type: "stack", browser: "chromium", index: 0, stack: "base" },
    {
      type: "judged",
      browser: "chromium",
      index: 0,
      seq: 2,
      phase: "launched",
      record: { ...name0, outcome: "running", launched_at: at },
    },
  ];
  const failed = await reapDead(t, {
    prepare: launched("unexpected"),
    messages: journalled,
  });
  assert.equal(stack0(failed.summary)?.outcome, "failed", failed.log);
  assert.equal(stack0(failed.summary)?.judged_by, "reaper");
  assert.equal(stack0(failed.summary)?.failure?.kind, "cases");
  assert.equal(failed.summary?.outcome, "failed");
  // Controls: a report whose cases passed is what the stop interrupted (cancelled, never a pass); no report at all is the stop's doing.
  const passed = await reapDead(t, {
    prepare: launched("expected"),
    messages: journalled,
  });
  assert.equal(passed.summary?.outcome, "cancelled", passed.log);
  const none = await reapDead(t, {
    prepare: launched("expected", false),
    messages: journalled,
  });
  assert.equal(stack0(none.summary)?.outcome, "cancelled", none.log);
  assert.equal(none.summary?.outcome, "cancelled");
});

test("H4d: a torn summary, with an earlier stack's failure only in its committed record: the failure survives; the tear is an evidence failure", async (t) => {
  const r = await reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      writeFileSync(
        join(runDir, "summary.json"),
        '{"schema":3,"stacks":[{"brow',
      );
      const store = createStackStore(runDir);
      store.commit(
        { ...name0, ...REPORT_FAILURE, cleanup: { ok: true } },
        "settled",
      );
    },
    messages: [
      { type: "stack", browser: "chromium", index: 1, stack: "-later" },
    ],
  });
  assert.equal(stack0(r.summary)?.outcome, "failed", r.log);
  assert.equal(
    r.summary?.stacks?.find((s) => s.index === 1)?.outcome,
    "cancelled",
  );
  assert.equal(r.summary?.outcome, "failed");
  assert.match(
    r.summary?.evidence_errors?.join("\n") ?? "",
    /summary\.json could not be read/,
  );
  assert.equal(r.code, 1, "its evidence was not complete");
  assert.equal(r.reaped?.ok, true, "its clean-up itself was verified");
});

test("H4d: evidence the reaper cannot write fails it (exit 1) even when its clean-up is verified", async (t) => {
  const r = await reapDead(t, {
    prepare: (runDir) => chmodSync(runDir, 0o555),
    messages: [{ type: "stack", browser: "chromium", index: 0, stack: "base" }],
  });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /evidence NOT written/);
  assert.match(r.log, /clean-up verified/);
});

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
  {
    prepare = () => undefined,
    messages = [],
    summary = true,
    evidence = null,
    raw = [],
    env = {},
  } = {},
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
  // Revision 10: `messages` may be computed by the preparation (the journal of commits it made).
  const sent = typeof messages === "function" ? messages() : messages;
  return reapIn(runDir, {
    messages: sent,
    evidence: evidence ?? dir,
    raw,
    env,
  });
}
/**
 * Revision 11: a reaper whose runner is already gone, over an EXISTING run directory (a second recovery of the same run), given
 * `messages` (and `raw` journal lines after them, sent as they are); `evidence` is the parent folder the hello names.
 */
async function reapIn(
  runDir,
  { messages = [], evidence, raw = [], env = {}, runner = null, execArgv = [] },
) {
  const sent = messages;
  // Revision 13: `runner`, a live process named as the runner (a recovery whose runner may still be running).
  let runnerPid = runner;
  if (runnerPid === null) {
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => gone.once("exit", r));
    runnerPid = gone.pid;
  }
  const reaper = spawn(
    process.execPath,
    [
      // Revision 15: Node options of the reaper process only (a case's labelled read-fault preload).
      ...execArgv,
      join(here, "reaper.mjs"),
      runDir,
      `ATLAS_TEST_${Date.now()}`,
      String(runnerPid),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Revision 12: a qualification seam of the reaper (`reaper_publish_fail`) is given by the case, never inherited.
      env: { ...process.env, ATLAS_INTEGRATION_FAULTS: "", ...env },
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
    [{ type: "hello", invocation: "inv-h4d", evidence }, ...sent]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join("") + raw.map((line) => `${line}\n`).join(""),
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

// Adapted, labelled (revision 10, review r9 H4e): revision 9 asserted `reaper.json` `retired` (the checkpoint deleted on a confirmed
// stack-end). A checkpoint is now never deleted: the stack-end is recorded in `acknowledged`, and the committed record is complete when
// it COVERS the checkpoint (its observation ordinal). The journal messages and records carry `obs` as the current runner's do. The
// intent (a confirmed, covering settled record is the result and is not settled again) is unchanged.
test("H4d: a stack-end confirmed by the committed settled record retires the checkpoint; the committed failure is the result", async (t) => {
  let seq = null;
  const r = await reapDead(t, {
    prepare: (runDir) => {
      const store = createStackStore(runDir);
      store.commit({ ...name0, outcome: "running", obs: 1 }, "started");
      store.commit({ ...name0, ...REPORT_FAILURE, obs: 2 }, "judged");
      seq = store.commit(
        { ...name0, ...REPORT_FAILURE, cleanup: { ok: true }, obs: 3 },
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
        obs: 2,
        record: REPORT_FAILURE,
      },
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 3,
        obs: 3,
        record: { ...REPORT_FAILURE, cleanup: { ok: true } },
      },
      // The runner was lost after this, before its summary had the stack (the review r8 H4d gap).
      { type: "stack-end", browser: "chromium", index: 0, seq: 3 },
    ],
  });
  assert.equal(seq, 3);
  assert.deepEqual(r.reaped?.acknowledged, [
    { key: stackKey("chromium", 0), seq: 3, confirmed: true },
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

// Adapted, labelled (revision 10, review r9 H4e): revision 9 asserted `retired` empty; the unconfirmed acknowledgements are now recorded
// as such (`confirmed: false`) and change nothing. Same intent.
test("H4d: a stack-end the reaper cannot confirm (the committed record is older) retires nothing; the reaper settles the stack", async (t) => {
  const r = await reapDead(t, {
    prepare: (runDir) => {
      const store = createStackStore(runDir);
      store.commit({ ...name0, outcome: "running", obs: 1 }, "started");
      store.commit({ ...name0, ...REPORT_FAILURE, obs: 2 }, "judged");
    },
    messages: [
      { type: "stack", browser: "chromium", index: 0, stack: "base" },
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 2,
        obs: 2,
        record: REPORT_FAILURE,
      },
      { type: "stack-end", browser: "chromium", index: 0, seq: 3 },
      { type: "stack-end", browser: "chromium", index: 0 },
    ],
  });
  assert.deepEqual(r.reaped?.acknowledged, [
    { key: stackKey("chromium", 0), seq: 3, confirmed: false },
    { key: stackKey("chromium", 0), seq: null, confirmed: false },
  ]);
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

// ---- review r9 H4e (revision 10): an older settled record never hides a newer observation whose write failed ------------------------
import { settleStack } from "./outcome.mjs";
import { commitObservation } from "./stack-records.mjs";

/**
 * The runner's commits of stack 0 in `runDir`, as run.mjs makes them (commitObservation over the real store and its failure seam):
 * `steps` is [phase, facts, fails?]; returns the journal messages the runner sends for them (judged, with seq and obs).
 */
function observeStack(runDir, steps) {
  let refuse = false;
  const store = createStackStore(runDir, {
    fail: () => {
      if (refuse) throw new Error("injected: record publication refused");
    },
  });
  let known = null;
  const messages = [];
  steps.forEach(([phase, facts, fails = false], i) => {
    refuse = fails;
    const result = commitObservation({
      store,
      known,
      record: { ...name0, ...facts },
      phase,
      obs: i + 1,
      describe: (error) =>
        `the record of integration-chromium base could not be committed (${phase}): ${error.message}`,
    });
    known = result.record;
    messages.push({
      type: "judged",
      browser: "chromium",
      index: 0,
      seq: known.seq,
      obs: known.obs,
      phase: known.phase,
      record: known,
    });
  });
  return messages;
}
const PASSED_SETTLED = {
  outcome: "passed",
  reason: null,
  counts: { passed: 1, failed: 0 },
  cleanup: { ok: true },
};
const evidenceFact = (s) =>
  (s?.failures ?? []).some(
    (f) => f.kind === "evidence" && /could not be committed/.test(f.reason),
  );
const STACK0 = { type: "stack", browser: "chromium", index: 0, stack: "base" };
const END0 = (seq) => ({
  type: "stack-end",
  browser: "chromium",
  index: 0,
  seq,
});

for (const [schedule, ack] of [
  ["acknowledged before the failed write", "before"],
  ["never acknowledged", "none"],
  ["acknowledged late, after the failed write", "late"],
])
  test(`H4e: a settled record ${schedule}, then a newer settled observation whose write failed: the run fails and keeps the fact`, async (t) => {
    let messages = [];
    const r = await reapDead(t, {
      prepare: (runDir) => {
        const [first, second] = observeStack(runDir, [
          ["settled", PASSED_SETTLED],
          ["settled", PASSED_SETTLED, true],
        ]);
        assert.equal(first.seq, 1);
        assert.equal(second.seq, null, "the second write failed");
        messages = [
          STACK0,
          first,
          ...(ack === "before" ? [END0(1)] : []),
          second,
          ...(ack === "late" ? [END0(1)] : []),
        ];
      },
      messages: () => messages,
    });
    assert.equal(r.summary?.outcome, "failed", r.log);
    assert.equal(stack0(r.summary)?.outcome, "evidence_failed");
    assert.ok(evidenceFact(stack0(r.summary)), "the write's failure is kept");
    assert.equal(stack0(r.summary)?.recovered_by, "reaper");
    assert.match(
      r.summary?.first_failure ?? "",
      /integration-chromium base evidence_failed/,
      "the projection is recomputed",
    );
  });

test("H4e controls: a judged record with a failed newer write fails; a settled record with nothing newer is an interruption; a committed newer failure fails", async (t) => {
  let judgedMessages = [];
  const judged = await reapDead(t, {
    prepare: (runDir) => {
      judgedMessages = [
        STACK0,
        ...observeStack(runDir, [
          ["judged", { outcome: "passed", reason: null }],
          ["settled", PASSED_SETTLED, true],
        ]),
      ];
    },
    messages: () => judgedMessages,
  });
  assert.equal(judged.summary?.outcome, "failed", judged.log);
  assert.ok(evidenceFact(stack0(judged.summary)));
  let quietMessages = [];
  const quiet = await reapDead(t, {
    prepare: (runDir) => {
      quietMessages = [
        STACK0,
        ...observeStack(runDir, [["settled", PASSED_SETTLED]]),
        END0(1),
      ];
    },
    messages: () => quietMessages,
  });
  assert.equal(quiet.summary?.outcome, "cancelled", quiet.log);
  assert.equal(stack0(quiet.summary)?.outcome, "passed");
  assert.equal(stack0(quiet.summary)?.recovered_by, undefined, "covered");
  let committedMessages = [];
  const committed = await reapDead(t, {
    prepare: (runDir) => {
      committedMessages = [
        STACK0,
        ...observeStack(runDir, [
          ["settled", PASSED_SETTLED],
          [
            "settled",
            settleStack(PASSED_SETTLED, {
              evidenceErrors: ["an earlier publication failed"],
            }),
          ],
        ]),
        END0(1),
      ];
    },
    messages: () => committedMessages,
  });
  assert.equal(committed.summary?.outcome, "failed", committed.log);
  assert.equal(stack0(committed.summary)?.recovered_by, undefined, "covered");
});

test("H4e: a failed write, then a later successful one from an older local copy: the durable record keeps the fact; old, duplicate and other stacks' acknowledgements change nothing", async (t) => {
  let messages = [];
  const r = await reapDead(t, {
    prepare: (runDir) => {
      const [a, b, c] = observeStack(runDir, [
        ["settled", PASSED_SETTLED],
        ["settled", PASSED_SETTLED, true],
        // The stack's own end, still holding the first version (it never saw the failure), commits again.
        ["settled", PASSED_SETTLED],
      ]);
      assert.equal(c.seq, 2);
      assert.ok(evidenceFact(c.record), "the later write carries the fact");
      messages = [
        STACK0,
        a,
        END0(1),
        b,
        { type: "stack", browser: "chromium", index: 1, stack: "-later" },
        c,
        END0(1),
        b,
        END0(2),
        END0(2),
        { type: "stack-end", browser: "chromium", index: 1, seq: 5 },
      ];
    },
    messages: () => messages,
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  const s = stack0(r.summary);
  assert.equal(s?.outcome, "evidence_failed");
  assert.equal(
    (s?.failures ?? []).filter((f) => f.kind === "evidence").length,
    1,
    "the fact once",
  );
  assert.equal(s?.recovered_by, undefined, "the durable record covers it");
  assert.equal(
    r.summary?.stacks?.find((q) => q.index === 1)?.outcome,
    "cancelled",
    "the later stack's own checkpoint",
  );
});

test("H4e: journal ordinals decide precedence: an older duplicate adds its facts and never reverts newer fields", async (t) => {
  const r = await reapDead(t, {
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: null,
        obs: 2,
        record: {
          ...name0,
          ...PASSED_SETTLED,
          reason: "the newer reason",
          obs: 2,
        },
      },
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: null,
        obs: 1,
        record: { ...name0, ...REPORT_FAILURE, obs: 1 },
      },
    ],
  });
  const s = stack0(r.summary);
  assert.equal(s?.outcome, "failed", r.log);
  assert.deepEqual(s?.report_errors, ["teardown failed"], "its fact kept");
  assert.equal(r.summary?.outcome, "failed");
});

test("H4e: a checkpoint without observation ordinals (an older runner) is never taken as covered", async (t) => {
  const r = await reapDead(t, {
    prepare: (runDir) =>
      createStackStore(runDir).commit(
        { ...name0, ...PASSED_SETTLED },
        "settled",
      ),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        record: PASSED_SETTLED,
      },
      END0(1),
    ],
  });
  assert.equal(stack0(r.summary)?.recovered_by, "reaper", r.log);
  assert.equal(r.summary?.outcome, "cancelled");
});

// ---- H4e: a summary the runner marked finished is kept only when it is quiescent and covers everything --------------------------------
const finishedSummary = (stacks, extra = {}) => ({
  schema: 3,
  invocation: { finished: true },
  outcome: "passed",
  first_failure: null,
  terminal: { quiescent: true, observations: 1 },
  evidence_errors: [],
  stacks,
  ...extra,
});
const PLAN0 = {
  browsers: ["chromium"],
  stacks: [{ stack: "base", cases: [] }],
};
async function reapFinished(
  t,
  { summary, prepare = () => undefined, messages = [], ...rest },
) {
  return reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
      writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary));
      prepare(runDir);
    },
    messages,
    ...rest,
  });
}
const settled0 = {
  ...name0,
  ...PASSED_SETTLED,
  key: "chromium-0",
  phase: "settled",
  seq: 1,
  obs: 1,
};

test("H4e control: a quiescent terminal summary covering every record and checkpoint keeps its outcome (only the release was lost)", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
    ],
  });
  assert.equal(r.summary?.outcome, "passed", r.log);
  assert.equal(r.summary?.reconciled_after_finish, undefined);
  assert.equal(r.summary?.reaper?.ok, true);
});

test("H4e: a finished summary older than a committed record, a newer checkpoint or summary-error.json is reconciled: outcome and projection recomputed", async (t) => {
  // A newer committed failure.
  const committed = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) => {
      const store = createStackStore(runDir);
      store.commit({ ...name0, ...PASSED_SETTLED, obs: 1 }, "settled");
      store.commit(
        { ...name0, ...REPORT_FAILURE, cleanup: { ok: true }, obs: 2 },
        "settled",
      );
    },
  });
  assert.equal(committed.summary?.outcome, "failed", committed.log);
  assert.equal(committed.summary?.outcome_before_reaper, "passed");
  assert.equal(committed.summary?.reconciled_after_finish, true);
  assert.match(committed.summary?.first_failure ?? "", /chromium base failed/);
  assert.equal(committed.summary?.engines?.chromium?.complete, false);
  // A newer observation only in the journal.
  const journalled = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: null,
        obs: 2,
        record: { ...name0, ...REPORT_FAILURE, obs: 2 },
      },
    ],
  });
  assert.equal(journalled.summary?.outcome, "failed", journalled.log);
  assert.deepEqual(stack0(journalled.summary)?.report_errors, [
    "teardown failed",
  ]);
  // A summary that the runner could not write: its error and its stacks.
  const errored = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) =>
      writeFileSync(
        join(runDir, "summary-error.json"),
        JSON.stringify({
          error: "EIO",
          stacks: [{ ...name0, ...REPORT_FAILURE, obs: 3 }],
        }),
      ),
  });
  assert.equal(errored.summary?.outcome, "failed", errored.log);
  assert.deepEqual(stack0(errored.summary)?.report_errors, ["teardown failed"]);
  assert.match(
    (errored.summary?.evidence_errors ?? []).join(" "),
    /could not write its summary: EIO/,
  );
  // A summary that does not say it was quiescent (the runner handed over work it could not join).
  const handed = await reapFinished(t, {
    summary: finishedSummary([settled0], {
      terminal: { quiescent: false, observations: 1 },
    }),
  });
  assert.equal(handed.summary?.outcome, "cancelled", handed.log);
  assert.equal(handed.summary?.reconciled_after_finish, true);
  // A finished failure stays a failure.
  const failedRun = await reapFinished(t, {
    summary: finishedSummary([{ ...settled0, ...REPORT_FAILURE }], {
      outcome: "failed",
    }),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: { ...settled0, ...REPORT_FAILURE },
      },
    ],
  });
  assert.equal(failedRun.summary?.outcome, "failed", failedRun.log);
});

test("H4e: a run-level evidence failure journalled before the controller was lost fails the run", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
      { type: "run-error", reason: "the summary could not be written: EIO" },
    ],
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.match(
    (r.summary?.evidence_errors ?? []).join(" "),
    /the summary could not be written: EIO/,
  );
});

test("H4e: a quiescent terminal summary kept as recorded still fails when the reaper's own clean-up is not verified", async (t) => {
  const server = createServer(() => undefined);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address();
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: [
      { type: "ports", ports: [port] },
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
    ],
  });
  assert.equal(r.reaped?.ok, false, r.log);
  assert.equal(
    r.summary?.reconciled_after_finish,
    undefined,
    "kept as recorded",
  );
  assert.equal(r.summary?.outcome, "failed");
  assert.equal(r.summary?.outcome_before_reaper, "passed");
  assert.equal(r.summary?.cleanup_failed, true);
});

test("H4e: a newer message that does not repeat an older one's failure never removes it from the checkpoint", async (t) => {
  const r = await reapDead(t, {
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: null,
        obs: 1,
        record: { ...name0, ...REPORT_FAILURE, obs: 1 },
      },
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: null,
        obs: 2,
        record: { ...name0, outcome: "passed", reason: null, obs: 2 },
      },
    ],
  });
  const s = stack0(r.summary);
  assert.equal(s?.outcome, "failed", r.log);
  assert.deepEqual(s?.report_errors, ["teardown failed"]);
  assert.equal(r.summary?.outcome, "failed");
});

// ---- review r10 H4f (revision 11): absent, readable and unreadable evidence, and one run-level reduction ------------------------------
import { cleanupFailed } from "./outcome.mjs";

const UNFINISHED = (stacks) => ({
  schema: 3,
  invocation: { finished: false },
  outcome: "running",
  stacks,
});
const MARKERS = {
  absent: null,
  readable: (record) => JSON.stringify({ error: "EIO", stacks: [record] }),
  truncated: () => '{"error":',
};
/** One cell: a settled, passing stack committed by the real store; a terminal or unfinished summary of it; the marker in one state. */
async function markerCell(t, { terminal, marker, extra = {} }) {
  let journalled = [];
  const r = await reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
      const record = createStackStore(runDir).commit(
        { ...name0, ...PASSED_SETTLED, obs: 1 },
        "settled",
      );
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify(
          terminal ? finishedSummary([record]) : UNFINISHED([record]),
        ),
      );
      if (MARKERS[marker])
        writeFileSync(
          join(runDir, "summary-error.json"),
          MARKERS[marker](record),
        );
      journalled = [
        STACK0,
        {
          type: "judged",
          browser: "chromium",
          index: 0,
          seq: record.seq,
          obs: 1,
          record,
        },
        END0(record.seq),
      ];
    },
    messages: () => journalled,
    ...extra,
  });
  return r;
}

for (const terminal of [true, false])
  for (const marker of ["absent", "readable", "truncated"])
    test(`H4f: a ${terminal ? "finished, quiescent terminal" : "unfinished"} summary with summary-error.json ${marker}`, async (t) => {
      const r = await markerCell(t, { terminal, marker });
      const errors = (r.summary?.evidence_errors ?? []).join("\n");
      assert.equal(r.reaped?.ok, true, r.log);
      if (marker === "absent") {
        // Controls: only the release was lost (kept as it is), or an interruption with nothing established (cancelled).
        assert.equal(r.summary?.outcome, terminal ? "passed" : "cancelled");
        assert.deepEqual(r.summary?.evidence_errors, []);
        assert.equal(r.reaped?.summary_covered, terminal);
        assert.equal(r.code, 0);
        return;
      }
      assert.equal(r.summary?.outcome, "failed", r.log);
      assert.equal(
        r.summary?.outcome_before_reaper,
        terminal ? "passed" : undefined,
      );
      assert.equal(r.reaped?.summary_covered, false);
      assert.equal(r.code, 1, "the reaper's evidence names a failure");
      if (marker === "readable")
        assert.match(errors, /the runner could not write its summary: EIO/);
      else {
        // The read failure AND the fact the marker's presence establishes (the runner could not publish its summary).
        assert.match(
          errors,
          /the runner's summary-error\.json could not be read: /,
        );
        assert.match(
          errors,
          /the runner could not write its summary: its summary-error\.json cannot be read/,
        );
        assert.match(
          (r.reaped?.evidence_errors ?? []).join("\n"),
          /summary-error\.json could not be read/,
        );
      }
      assert.equal(
        stack0(r.summary)?.outcome,
        "passed",
        "no case failure invented",
      );
    });

test("H4f: a read failure that is not 'not found' (a directory where summary-error.json should be) fails a terminal summary", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) => mkdirSync(join(runDir, "summary-error.json")),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
    ],
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /summary-error\.json could not be read: .*EISDIR/,
  );
});

test("H4f: a marker of another shape (null) is unreadable evidence, never absent", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) =>
      writeFileSync(join(runDir, "summary-error.json"), "null"),
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /summary-error\.json is not valid evidence: it is not a JSON object/,
  );
});

test("H4f: a summary of another shape is an evidence failure; the committed records are recovered", async (t) => {
  const r = await reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({ stacks: {} }),
      );
      createStackStore(runDir).commit(
        { ...name0, ...REPORT_FAILURE, cleanup: { ok: true }, obs: 1 },
        "settled",
      );
    },
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.equal(stack0(r.summary)?.outcome, "failed");
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /summary\.json is not valid evidence: `stacks` is not a list/,
  );
});

test("H4f: a plan that cannot be read leaves the planned stacks unknown (no empty plan, no invented not_run) and fails the run", async (t) => {
  for (const text of [
    '{"browsers":["chrom',
    '{"browsers":"chromium","stacks":[]}',
  ]) {
    const r = await reapDead(t, {
      prepare: (runDir) => writeFileSync(join(runDir, "plan.json"), text),
      messages: [STACK0],
    });
    assert.equal(r.summary?.outcome, "failed", r.log);
    assert.equal(r.summary?.plan_unknown, true);
    assert.match(
      (r.summary?.evidence_errors ?? []).join("\n"),
      /the run's plan\.json (could not be read|is not valid evidence)/,
    );
    assert.equal(
      (r.summary?.stacks ?? []).some((s) => s.outcome === "not_run"),
      false,
      "no not_run entry is invented for an unknown plan",
    );
    assert.equal(stack0(r.summary)?.outcome, "cancelled");
  }
});

test("H4f: a plan missing although the summary records a selection is unknown; a run lost before planning plans nothing (control)", async (t) => {
  const missing = await reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      rmSync(join(runDir, "plan.json"));
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          ...UNFINISHED([]),
          selection: { mode: "full", ok: true },
        }),
      );
    },
    messages: [STACK0],
  });
  assert.equal(missing.summary?.outcome, "failed", missing.log);
  assert.equal(missing.summary?.plan_unknown, true);
  assert.match(
    (missing.summary?.evidence_errors ?? []).join("\n"),
    /plan\.json is missing although its summary records a selection/,
  );
  // Control: lost before anything was planned or summarised (no plan, no summary, its invocation only).
  const early = await reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      rmSync(join(runDir, "plan.json"));
      writeFileSync(
        join(runDir, "invocation.json"),
        JSON.stringify({ id: "inv-early", browsers: ["chromium"] }),
      );
    },
  });
  assert.equal(early.summary?.outcome, "cancelled", early.log);
  assert.deepEqual(early.summary?.evidence_errors, []);
  assert.equal(early.summary?.plan_unknown, undefined);
  assert.equal(early.summary?.invocation?.id, "inv-early");
  assert.deepEqual(early.summary?.stacks, []);
  assert.equal(early.code, 0);
});

test("H4f: an invocation.json that cannot be read is an evidence failure, not 'nothing was written'", async (t) => {
  const r = await reapDead(t, {
    summary: false,
    prepare: (runDir) => {
      rmSync(join(runDir, "plan.json"));
      writeFileSync(join(runDir, "invocation.json"), '{"id":"inv');
    },
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /invocation\.json could not be read/,
  );
});

test("H4f: a stack record file holding no record (null) is an evidence failure, never skipped", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) => {
      mkdirSync(join(runDir, "stacks"));
      writeFileSync(join(runDir, "stacks", "chromium-1.json"), "null");
    },
  });
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /a stack record could not be read: chromium-1\.json: it is not a stack record/,
  );
});

test("H4f: damaged journal lines (torn, not an object, a message without its fields) are an evidence failure and never stop the reaper", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
    ],
    raw: [
      "null",
      '{"type":"judged","browser":"chromium","index":0,"record":nu',
      '{"type":"judged","browser":"chromium"}',
    ],
  });
  assert.equal(r.reaped?.ok, true, r.log);
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.equal(r.reaped?.journal_damaged?.length, 3);
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /3 journal line\(s\) could not be read/,
  );
});

test("H4f: established failures are monotone: a finished failed summary with a run-level error and an earlier clean-up failure stays so after a clean take-over, and again on a second recovery", async (t) => {
  const failedStack = {
    ...settled0,
    outcome: "cleanup_failed",
    cleanup: { ok: false, errors: ["container left"] },
  };
  for (const terminal of [true, false]) {
    const summary = terminal
      ? finishedSummary([failedStack], {
          outcome: "failed",
          cleanup_failed: true,
          evidence_errors: ["admissions: EIO"],
          first_failure: "integration-chromium base cleanup_failed",
        })
      : {
          ...UNFINISHED([failedStack]),
          evidence_errors: ["admissions: EIO"],
        };
    const messages = [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: failedStack,
      },
    ];
    const r = await reapFinished(t, { summary, messages });
    const check = (x, label) => {
      assert.equal(x.reaped?.ok, true, `${label}: ${x.log}`);
      assert.equal(x.summary?.outcome, "failed", `${label}: ${x.log}`);
      assert.equal(x.summary?.cleanup_failed, true, label);
      assert.ok(
        (x.summary?.evidence_errors ?? []).includes("admissions: EIO"),
        label,
      );
      // The earlier unverified clean-up is kept: as the stack's clean-up, or beside a later verified one (earlier_cleanups).
      assert.equal(cleanupFailed(stack0(x.summary) ?? {}), true, label);
      assert.ok(
        [
          stack0(x.summary)?.cleanup,
          ...(stack0(x.summary)?.earlier_cleanups ?? []),
        ].some((c) => c?.ok === false && c.errors?.includes("container left")),
        label,
      );
      assert.match(
        x.summary?.first_failure ?? "",
        /chromium base cleanup_failed/,
        label,
      );
    };
    check(r, `terminal=${terminal}`);
    // A second recovery of the same run reads what the first wrote: nothing established is lost.
    const again = await reapIn(r.runDir, { messages, evidence: r.runDir });
    check(again, `terminal=${terminal}, second recovery`);
  }
});

test("H4f: a finished plan_error is never relabelled by a reconciliation (control: the same summary covered stays plan_error too)", async (t) => {
  for (const quiescent of [false, true]) {
    const r = await reapFinished(t, {
      summary: finishedSummary([], {
        outcome: "plan_error",
        plan_error: "discovery failed",
        terminal: { quiescent, observations: 0 },
      }),
    });
    assert.equal(r.summary?.outcome, "plan_error", r.log);
    assert.equal(r.summary?.outcome_before_reaper, undefined);
    assert.equal(r.reaped?.summary_covered, quiescent);
  }
});

test("H4f: a failure found after the summary was written (reaper.json cannot be written) publishes the summary once more: never a pass", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) => mkdirSync(join(runDir, "reaper.json")),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
    ],
  });
  assert.equal(r.code, 1, r.log);
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.equal(r.summary?.outcome_before_reaper, "passed");
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /^reaper\.json: /m,
  );
  assert.match(r.log, /evidence NOT written: reaper\.json: /);
});

test("H4f: the parent copy: one that exists is left as it is (control); any other failure to write it fails the run", async (t) => {
  const messages = [
    STACK0,
    {
      type: "judged",
      browser: "chromium",
      index: 0,
      seq: 1,
      obs: 1,
      record: settled0,
    },
  ];
  const parent = mkdtempSync(join(tmpdir(), "atlas-reaper-parent-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  writeFileSync(join(parent, "summary.json"), "an earlier run's summary\n");
  const kept = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages,
    evidence: parent,
  });
  assert.equal(kept.summary?.outcome, "passed", kept.log);
  assert.equal(kept.code, 0);
  assert.equal(
    readFileSync(join(parent, "summary.json"), "utf8"),
    "an earlier run's summary\n",
  );
  // A parent "folder" that is a file: ENOTDIR, not EEXIST.
  const notFolder = join(parent, "not-a-folder");
  writeFileSync(notFolder, "");
  const failed = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages,
    evidence: notFolder,
  });
  assert.equal(failed.code, 1, failed.log);
  assert.equal(failed.summary?.outcome, "failed", failed.log);
  assert.match(
    (failed.summary?.evidence_errors ?? []).join("\n"),
    /the parent summary\.json copy could not be written: .*ENOTDIR/,
  );
  assert.match(
    (failed.reaped?.evidence_errors ?? []).join("\n"),
    /parent summary\.json copy/,
  );
});

test("H4f: a covered terminal summary still takes every read failure of this process (a torn plan.json): failed, plan unknown", async (t) => {
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    prepare: (runDir) =>
      writeFileSync(join(runDir, "plan.json"), '{"browsers":["chro'),
    messages: [
      STACK0,
      {
        type: "judged",
        browser: "chromium",
        index: 0,
        seq: 1,
        obs: 1,
        record: settled0,
      },
    ],
  });
  assert.equal(r.reaped?.summary_covered, true, r.log);
  assert.equal(r.summary?.outcome, "failed", r.log);
  assert.equal(r.summary?.outcome_before_reaper, "passed");
  assert.equal(r.summary?.plan_unknown, true);
  assert.match(
    (r.summary?.evidence_errors ?? []).join("\n"),
    /the run's plan\.json could not be read/,
  );
});

// Revision 12 (review r11 design assessment C3): the SECOND reaper.json publication. The parent copy fails (a file where its folder
// should be: ENOTDIR), so the reaper publishes reaper.json with that failure and then republishes the summary; the seam makes exactly
// that republication (summary.json, attempt 2) fail. Its failure is found after reaper.json was written, so reaper.json is published
// once more with it. Chosen by destination and ordinal (`reaper_publish_fail`), each injected failure recorded before it is thrown.
const C3_MESSAGES = [
  STACK0,
  {
    type: "judged",
    browser: "chromium",
    index: 0,
    seq: 1,
    obs: 1,
    record: settled0,
  },
];
const reapC3 = async (t, fail) => {
  const parent = mkdtempSync(join(tmpdir(), "atlas-reaper-c3-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const notFolder = join(parent, "not-a-folder");
  writeFileSync(notFolder, "");
  const r = await reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: C3_MESSAGES,
    evidence: notFolder,
    env: {
      ATLAS_INTEGRATION_FAULTS: JSON.stringify({ reaper_publish_fail: fail }),
    },
  });
  const failedAt = (output, n) =>
    existsSync(
      join(
        r.runDir,
        "faults",
        `reaper-publish-${output.replaceAll(".", "-")}-${n}.failed`,
      ),
    );
  return { ...r, failedAt };
};

test("C3: a failure of the summary's republication is published in a second reaper.json; exit 1 and stderr say it", async (t) => {
  const r = await reapC3(t, { "summary.json": [2] });
  // The boundary was reached: the republication was attempted and failed (an unreached seam is never a result).
  assert.equal(r.failedAt("summary.json", 2), true, r.log);
  assert.equal(r.failedAt("reaper.json", 1), false);
  assert.equal(r.code, 1, r.log);
  const errors = (r.reaped?.evidence_errors ?? []).join("\n");
  assert.match(errors, /the parent summary\.json copy could not be written/);
  assert.match(
    errors,
    /^summary\.json: injected failure publishing summary\.json \(attempt 2\)$/m,
  );
  assert.match(
    r.log,
    /evidence NOT written: summary\.json: injected failure publishing summary\.json \(attempt 2\)/,
  );
  // The bounded design's stated limit, kept visible: the summary whose republication failed still holds its first text, written before
  // any failure was known; reaper.json, stderr and the exit code carry the failure.
  assert.equal(r.summary?.outcome, "passed");
  assert.deepEqual(r.summary?.evidence_errors, []);
});

test("C3 controls: the seam is inert when its attempt is never reached; a failed second reaper.json leaves stderr and exit 1", async (t) => {
  // Attempt 3 of summary.json never happens: the run is the existing parent-copy failure (summary republished failed, one reaper.json).
  const inert = await reapC3(t, { "summary.json": [3] });
  assert.equal(inert.failedAt("summary.json", 3), false, inert.log);
  assert.equal(inert.code, 1, inert.log);
  assert.equal(inert.summary?.outcome, "failed", inert.log);
  assert.match(
    (inert.summary?.evidence_errors ?? []).join("\n"),
    /the parent summary\.json copy could not be written/,
  );
  assert.doesNotMatch(
    (inert.reaped?.evidence_errors ?? []).join("\n"),
    /^summary\.json: /m,
  );
  // Persistent write failure: the second reaper.json publication fails too. reaper.json keeps its first text (the copy failure only);
  // stderr and the exit code are the last channel and name both failures. No output is written a third time.
  const both = await reapC3(t, { "summary.json": [2], "reaper.json": [2] });
  assert.equal(both.failedAt("summary.json", 2), true, both.log);
  assert.equal(both.failedAt("reaper.json", 2), true, both.log);
  assert.equal(both.failedAt("reaper.json", 3), false);
  assert.equal(both.code, 1, both.log);
  assert.doesNotMatch(
    (both.reaped?.evidence_errors ?? []).join("\n"),
    /^summary\.json: /m,
  );
  assert.match(
    both.log,
    /evidence NOT written: summary\.json: injected failure publishing summary\.json \(attempt 2\)/,
  );
  assert.match(
    both.log,
    /evidence NOT written: reaper\.json: injected failure publishing reaper\.json \(attempt 2\)/,
  );
});

// ---- review r12 H4g (revision 13): a later recovery of the same run never erases what an earlier one established -----------------
// Every case is a real reaper over a real run folder; a later recovery is started by the case (the runner never starts two).
import {
  attemptFile,
  claimFile,
  previousFile,
  recordAttempt,
  recoveriesDir,
  startedOf,
} from "./recovery-history.mjs";

/** A covered, clean terminal run (only the release was lost), recovered once with `env`/`evidence`, then by `reapIn` as often as asked. */
const coveredRun = (t, { evidence, env, prepare } = {}) =>
  reapFinished(t, {
    summary: finishedSummary([settled0]),
    messages: C3_MESSAGES,
    ...(evidence ? { evidence } : {}),
    ...(env ? { env } : {}),
    ...(prepare ? { prepare } : {}),
  });
const again = (runDir, opts = {}) =>
  reapIn(runDir, { evidence: dirname(runDir), ...opts });
const faults = (spec) => ({ ATLAS_INTEGRATION_FAULTS: JSON.stringify(spec) });
const has = (list, error) => (list ?? []).includes(error);
const distinct = (list) => new Set(list ?? []).size === (list ?? []).length;

test("H4g: a failure only the first recovery's reaper.json holds survives a second and a third recovery, which fail and exit 1", async (t) => {
  // The review's schedule: the parent copy fails (ENOTDIR), then the summary's republication (attempt 2): the summary keeps its first
  // text (passed) and reaper.json is the only witness of both failures.
  const first = await reapC3(t, { "summary.json": [2] });
  assert.equal(first.failedAt("summary.json", 2), true, first.log);
  assert.equal(first.code, 1, first.log);
  assert.equal(
    first.summary?.outcome,
    "passed",
    "the bounded write's stale summary",
  );
  const established = first.reaped?.evidence_errors ?? [];
  assert.equal(established.length, 2, first.log);
  assert.deepEqual(
    first.reaped?.recovery_history?.evidence_errors,
    established,
  );
  for (const [n, run] of [
    [2, await again(first.runDir)],
    [3, await again(first.runDir)],
  ]) {
    const label = `recovery ${n}`;
    assert.equal(run.code, 1, `${label}: ${run.log}`);
    assert.equal(run.summary?.outcome, "failed", `${label}: ${run.log}`);
    assert.equal(run.summary?.outcome_before_reaper, "passed", label);
    for (const e of established) {
      assert.ok(
        has(run.summary?.evidence_errors, e),
        `${label}: summary: ${e}`,
      );
      assert.ok(
        has(run.reaped?.run_evidence_errors, e),
        `${label}: reaper.json run: ${e}`,
      );
      assert.ok(
        has(run.reaped?.recovery_history?.evidence_errors, e),
        `${label}: reaper.json history: ${e}`,
      );
    }
    assert.ok(distinct(run.summary?.evidence_errors), label);
    assert.ok(distinct(run.reaped?.recovery_history?.evidence_errors), label);
    // This recovery's own failures (none) stay apart from the history; its clean-up was verified.
    assert.deepEqual(run.reaped?.evidence_errors, [], label);
    assert.equal(run.reaped?.ok, true, label);
    assert.equal(run.reaped?.attempt, n, label);
    assert.equal(run.summary?.reaper?.attempt, n, label);
    assert.deepEqual(
      run.reaped?.recovery_history?.attempts?.map((e) => e.attempt),
      Array.from({ length: n }, (_, i) => i + 1),
      label,
    );
    assert.match(run.log, /an earlier recovery of this run failed/, label);
  }
  // Every attempt's record, and the reaper.json each later one replaced, are kept.
  for (const n of [1, 2, 3])
    assert.equal(existsSync(attemptFile(first.runDir, n)), true, `record ${n}`);
  assert.deepEqual(
    JSON.parse(read(previousFile(first.runDir, 2))),
    first.reaped,
    "the first recovery's reaper.json, kept by the second",
  );
});

test("H4g control: repeated recoveries of a clean run stay clean (exit 0, passed, nothing invented or duplicated)", async (t) => {
  const first = await coveredRun(t);
  const runs = [first, await again(first.runDir), await again(first.runDir)];
  runs.forEach((run, i) => {
    const label = `recovery ${i + 1}`;
    assert.equal(run.code, 0, `${label}: ${run.log}`);
    assert.equal(run.summary?.outcome, "passed", label);
    assert.equal(run.summary?.cleanup_failed, false, label);
    assert.deepEqual(run.summary?.evidence_errors, [], label);
    assert.deepEqual(run.reaped?.evidence_errors, [], label);
    assert.deepEqual(run.reaped?.run_evidence_errors, [], label);
    assert.equal(run.reaped?.run_outcome, "passed", label);
    assert.deepEqual(run.reaped?.recovery_history?.evidence_errors, [], label);
    assert.equal(
      run.reaped?.recovery_history?.cleanup_not_verified,
      false,
      label,
    );
    assert.deepEqual(
      run.reaped?.recovery_history?.attempts?.map((e) => [e.attempt, e.ok]),
      Array.from({ length: i + 1 }, (_, k) => [k + 1, true]),
      label,
    );
    assert.doesNotMatch(
      run.log,
      /an earlier recovery of this run failed/,
      label,
    );
  });
});

test("H4g: sole witnesses — a failure held only by a legacy reaper.json, only by an attempt record, or only by the summary is never lost", async (t) => {
  // 1. Only a reaper.json from before revision 13 (no history fields, no attempt record) knows it; this recovery's own summary
  // publication fails, so only its reaper.json and record can carry it on, and the next recovery fails because of them.
  const legacy = {
    controller_lost: true,
    ok: true,
    evidence_errors: ["legacy: lost"],
  };
  const a = await coveredRun(t, {
    env: faults({ reaper_publish_fail: { "summary.json": [1] } }),
    prepare: (runDir) =>
      writeFileSync(join(runDir, "reaper.json"), JSON.stringify(legacy)),
  });
  assert.equal(a.code, 1, a.log);
  assert.equal(a.summary?.outcome, "passed", "its summary was never replaced");
  assert.ok(has(a.reaped?.run_evidence_errors, "legacy: lost"), a.log);
  assert.ok(has(a.reaped?.recovery_history?.evidence_errors, "legacy: lost"));
  assert.deepEqual(JSON.parse(read(previousFile(a.runDir, 1))), legacy);
  const b = await again(a.runDir);
  assert.equal(b.code, 1, b.log);
  assert.equal(b.summary?.outcome, "failed", b.log);
  assert.ok(has(b.summary?.evidence_errors, "legacy: lost"), b.log);
  // 2. Only an attempt record knows it: reaper.json was never written and the summary's republication failed too.
  const c = await coveredRun(t, {
    env: faults({
      reaper_publish_fail: { "reaper.json": [1], "summary.json": [2] },
    }),
  });
  assert.equal(c.code, 1, c.log);
  assert.equal(existsSync(join(c.runDir, "reaper.json")), false, c.log);
  assert.equal(c.summary?.outcome, "passed", "the stale first summary");
  assert.equal(existsSync(attemptFile(c.runDir, 1)), true, c.log);
  const recorded = JSON.parse(read(attemptFile(c.runDir, 1)));
  assert.match(recorded.evidence_errors.join("\n"), /^reaper\.json: injected/m);
  assert.match(
    recorded.evidence_errors.join("\n"),
    /^summary\.json: injected/m,
  );
  const d = await again(c.runDir);
  assert.equal(d.code, 1, d.log);
  assert.equal(d.summary?.outcome, "failed", d.log);
  for (const e of recorded.evidence_errors)
    assert.ok(has(d.summary?.evidence_errors, e), `${e}: ${d.log}`);
  // 3. Only the summary knows a run-level failure; reaper.json carries it too, so a summary torn later does not lose it.
  const e = await reapFinished(t, {
    summary: finishedSummary([settled0], {
      outcome: "failed",
      evidence_errors: ["summary-only"],
    }),
    messages: C3_MESSAGES,
  });
  assert.ok(has(e.reaped?.run_evidence_errors, "summary-only"), e.log);
  assert.equal(e.reaped?.run_outcome, "failed");
  writeFileSync(join(e.runDir, "summary.json"), '{"schema":3,"outc');
  const f = await again(e.runDir);
  assert.equal(f.summary?.outcome, "failed", f.log);
  assert.ok(has(f.summary?.evidence_errors, "summary-only"), f.log);
  assert.match(
    f.summary?.evidence_errors.join("\n"),
    /the runner's summary\.json could not be read/,
  );
});

test("H4g: an earlier recovery's unverified clean-up (not ok, or its deadline) stays beside a later verified one; control: a verified one", async (t) => {
  for (const [label, earlier, failed] of [
    ["not verified", { ok: false, evidence_errors: [] }, true],
    ["deadline", { deadline_reached: true, evidence_errors: [] }, true],
    ["verified (control)", { ok: true, evidence_errors: [] }, false],
  ]) {
    const r = await coveredRun(t, {
      prepare: (runDir) =>
        writeFileSync(join(runDir, "reaper.json"), JSON.stringify(earlier)),
    });
    for (const [n, run] of [
      [1, r],
      [2, await again(r.runDir)],
    ]) {
      const at = `${label}, recovery ${n}`;
      assert.equal(run.reaped?.ok, true, `${at}: this clean-up was verified`);
      assert.equal(run.code, failed ? 1 : 0, `${at}: ${run.log}`);
      assert.equal(run.summary?.cleanup_failed, failed, at);
      assert.equal(run.summary?.outcome, failed ? "failed" : "passed", at);
      assert.equal(
        run.reaped?.recovery_history?.cleanup_not_verified,
        failed,
        at,
      );
    }
  }
});

test("H4g: a previous reaper.json that cannot be read is an evidence failure that later recoveries keep; its bytes are kept", async (t) => {
  for (const [label, text] of [
    ["torn", '{"ok":true,"evidence_err'],
    ["null", "null"],
    ["errors of another type", '{"ok":true,"evidence_errors":"x"}'],
  ]) {
    const r = await coveredRun(t, {
      prepare: (runDir) => writeFileSync(join(runDir, "reaper.json"), text),
    });
    assert.equal(r.code, 1, `${label}: ${r.log}`);
    assert.equal(r.summary?.outcome, "failed", label);
    const named = (r.summary?.evidence_errors ?? []).find((e) =>
      e.startsWith("the previous recovery's reaper.json "),
    );
    assert.ok(named, `${label}: ${r.log}`);
    assert.equal(read(previousFile(r.runDir, 1)), text, `${label}: kept`);
    const next = await again(r.runDir);
    assert.equal(next.code, 1, `${label}, next: ${next.log}`);
    assert.equal(next.summary?.outcome, "failed", label);
    assert.ok(has(next.summary?.evidence_errors, named), label);
    assert.ok(
      has(next.reaped?.recovery_history?.evidence_errors, named),
      label,
    );
  }
  // A directory: read as unreadable (EISDIR) and, as before, reaper.json cannot be published; the next recovery still fails.
  const dir = await coveredRun(t, {
    prepare: (runDir) => mkdirSync(join(runDir, "reaper.json")),
  });
  assert.equal(dir.code, 1, dir.log);
  assert.match(
    (dir.summary?.evidence_errors ?? []).join("\n"),
    /the previous recovery's reaper\.json could not be read: EISDIR/,
  );
  const after = await again(dir.runDir);
  assert.equal(after.code, 1, after.log);
  assert.equal(after.summary?.outcome, "failed", after.log);
  assert.match(
    (after.summary?.evidence_errors ?? []).join("\n"),
    /the previous recovery's reaper\.json could not be read: EISDIR/,
  );
});

/** A live process holding claim `n` of `runDir` (as an earlier recovery that is still running would). */
async function holdClaim(t, runDir, n) {
  const holder = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    },
  );
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((r) => holder.once("spawn", r));
  mkdirSync(recoveriesDir(runDir), { recursive: true });
  writeFileSync(
    claimFile(runDir, n),
    JSON.stringify({
      attempt: n,
      pid: holder.pid,
      started: startedOf(holder.pid),
    }),
  );
  return holder;
}

test("H4g order: a recovery never overtakes an earlier one that may still be running; it replaces nothing and its own record stays", async (t) => {
  // The first recovery runs alone (attempt 1). Then attempt 2 is held by a running process. The order's bound is shortened for the
  // refused recovery only: it bounds waiting for another recovery and is not a duration under test.
  const r = await coveredRun(t);
  assert.equal(r.code, 0, r.log);
  const reaperBefore = read(join(r.runDir, "reaper.json"));
  const summaryBefore = read(join(r.runDir, "summary.json"));
  const holder = await holdClaim(t, r.runDir, 2);
  const refused = await again(r.runDir, {
    env: { ATLAS_REAPER_ORDER_WAIT_MS: "1000" },
  });
  assert.equal(refused.code, 1, refused.log);
  assert.equal(
    read(join(r.runDir, "summary.json")),
    summaryBefore,
    "the summary is not replaced",
  );
  assert.equal(
    read(join(r.runDir, "reaper.json")),
    reaperBefore,
    "nor reaper.json",
  );
  assert.equal(existsSync(attemptFile(r.runDir, 3)), true, refused.log);
  const own = JSON.parse(read(attemptFile(r.runDir, 3)));
  assert.equal(own.attempt, 3);
  assert.match(
    own.refused,
    /^recovery attempt 2 has not ended \(its claimant \(pid \d+\) is running\)$/,
  );
  assert.match(refused.log, /this recovery replaced nothing/);
  // The holder ends without a record: the next recovery goes on; attempt 2 is unknown and attempt 3's refusal is kept.
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const next = await again(r.runDir);
  assert.equal(next.code, 1, next.log);
  assert.equal(next.reaped?.attempt, 4);
  assert.equal(next.summary?.outcome, "failed", next.log);
  const errors = (next.summary?.evidence_errors ?? []).join("\n");
  assert.match(
    errors,
    /recovery attempt 2 ended without its record \(pid \d+\): what it found and did is unknown/,
  );
  assert.match(
    errors,
    /this recovery replaced nothing: recovery attempt 2 has not ended/,
  );
});

test("H4g order: an earlier recovery that ends while this one waits: it goes on and that attempt is unknown", async (t) => {
  const r = await coveredRun(t);
  assert.equal(r.code, 0, r.log);
  const holder = await holdClaim(t, r.runDir, 2);
  const reaperBefore = read(join(r.runDir, "reaper.json"));
  const waiting = again(r.runDir);
  assert.ok(
    await until(() => existsSync(claimFile(r.runDir, 3))),
    "attempt 3 claimed",
  );
  // While attempt 2's claimant runs, attempt 3 replaces nothing (observed for a while; the order's own bound is 30 s).
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    read(join(r.runDir, "reaper.json")),
    reaperBefore,
    "nothing replaced while it waits",
  );
  assert.equal(existsSync(attemptFile(r.runDir, 3)), false);
  holder.kill("SIGKILL");
  const done = await waiting;
  assert.equal(done.code, 1, done.log);
  assert.equal(done.reaped?.attempt, 3);
  assert.equal(done.summary?.outcome, "failed", done.log);
  assert.match(
    (done.summary?.evidence_errors ?? []).join("\n"),
    /recovery attempt 2 ended without its record/,
  );
});

test("H4g order: two overlapping recoveries publish one after the other; the later one reads what the earlier one wrote", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "atlas-reaper-h4g-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const notFolder = join(parent, "not-a-folder");
  writeFileSync(notFolder, "");
  // A run folder with a covered clean terminal summary and no recovery yet.
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4g-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify(finishedSummary([settled0])),
  );
  const reached = (n) =>
    existsSync(join(runDir, "faults", `reaper-hold-inputs-${n}.reached`));
  const release = (n) =>
    writeFileSync(
      join(runDir, "faults", `reaper-hold-inputs-${n}.release`),
      "",
    );
  // A: its parent copy fails (its own failure), held after it has read everything.
  const a = reapIn(runDir, {
    messages: C3_MESSAGES,
    evidence: notFolder,
    env: faults({ reaper_hold_inputs: [1] }),
  });
  assert.ok(await until(() => reached(1)), "A holds after its inputs");
  // B starts while A holds: it takes attempt 2 and waits for A (it must not read anything A has not written yet).
  const b = reapIn(runDir, {
    messages: C3_MESSAGES,
    evidence: dir,
    env: faults({ reaper_hold_inputs: [2] }),
  });
  // Revision 14, labelled (clean-up only, no assertion changed): a failure before the releases below must not leave A or B held until
  // the reaper's deadline (with a mutant, that pushed this file past the mutation driver's time limit: a TIMEOUT, never a catch).
  t.after(async () => {
    releaseHolds(runDir, [1, 2]);
    await Promise.allSettled([a, b]);
    rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(
    await until(() => existsSync(claimFile(runDir, 2))),
    "B claimed attempt 2",
  );
  assert.equal(
    await until(() => reached(2), 1500),
    false,
    "B does not read while A may still publish",
  );
  release(1);
  const doneA = await a;
  assert.equal(doneA.code, 1, doneA.log);
  assert.ok(await until(() => reached(2)), "B reads once A has ended");
  release(2);
  const doneB = await b;
  assert.equal(doneB.code, 1, doneB.log);
  const copyFailure = (doneA.reaped?.evidence_errors ?? []).find((e) =>
    e.startsWith("the parent summary.json copy could not be written"),
  );
  assert.ok(copyFailure, doneA.log);
  // The outputs are B's, and they carry A's failure.
  const finalReaper = JSON.parse(read(join(runDir, "reaper.json")));
  assert.equal(finalReaper.attempt, 2);
  assert.ok(has(finalReaper.recovery_history?.evidence_errors, copyFailure));
  const finalSummary = JSON.parse(read(join(runDir, "summary.json")));
  assert.equal(finalSummary.outcome, "failed");
  assert.ok(has(finalSummary.evidence_errors, copyFailure));
});

test("H4g: a recovery whose runner may still be running leaves the summary to it and still carries every earlier failure (reaper.json, exit)", async (t) => {
  const runner = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    },
  );
  t.after(() => runner.kill("SIGKILL"));
  await new Promise((r) => runner.once("spawn", r));
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4g-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
  const running = JSON.stringify({
    schema: 3,
    invocation: { finished: false },
    outcome: "running",
    stacks: [],
  });
  writeFileSync(join(runDir, "summary.json"), running);
  writeFileSync(
    join(runDir, "reaper.json"),
    JSON.stringify({ ok: true, evidence_errors: ["earlier: lost"] }),
  );
  const r = await reapIn(runDir, { evidence: dir, runner: runner.pid });
  assert.equal(r.reaped?.runner_alive, true, r.log);
  assert.equal(
    read(join(runDir, "summary.json")),
    running,
    "the runner's summary is the runner's",
  );
  assert.ok(has(r.reaped?.run_evidence_errors, "earlier: lost"), r.log);
  assert.ok(has(r.reaped?.recovery_history?.evidence_errors, "earlier: lost"));
  assert.equal(r.code, 1, r.log);
});

// ---- review r13 H4h (revision 14): an earlier recovery's record pathname never admits the next while its claimant may still publish ---
/** A JSON output that must exist: its absence is an assertion failure, never a TypeError (a mutant's verdict depends on it). */
function readOutput(path, label) {
  assert.equal(existsSync(path), true, `${label}: ${path} exists`);
  return JSON.parse(read(path));
}
/** Release the hold seam's attempts `ns` of `runDir` (recreating the folder when a case's clean-up removed it first). */
function releaseHolds(runDir, ns) {
  for (const n of ns)
    try {
      mkdirSync(join(runDir, "faults"), { recursive: true });
      writeFileSync(
        join(runDir, "faults", `reaper-hold-inputs-${n}.release`),
        "",
      );
    } catch {}
}
/**
 * A run folder with a covered, clean terminal summary and no recovery yet, its hold seam's markers, and `start` (a recovery started
 * now, with whether it has ended yet). A case that fails before it releases a hold must not leave that recovery held until the
 * reaper's deadline: its clean-up releases every hold and joins every recovery it started before the folder is removed.
 */
function heldRun(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4h-"));
  const runDir = join(dir, "run");
  const runs = [];
  t.after(async () => {
    releaseHolds(runDir, [1, 2, 3]);
    await Promise.allSettled(runs.map((r) => r.result));
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(runDir);
  writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify(finishedSummary([settled0])),
  );
  const marker = (n, end) =>
    join(runDir, "faults", `reaper-hold-inputs-${n}.${end}`);
  const start = (opts) => {
    const run = { done: false };
    run.result = reapIn(runDir, { messages: C3_MESSAGES, ...opts }).then(
      (r) => {
        run.done = true;
        return r;
      },
    );
    runs.push(run);
    return run;
  };
  return {
    dir,
    runDir,
    start,
    reached: (n) => existsSync(marker(n, "reached")),
    release: (n) => writeFileSync(marker(n, "release"), ""),
  };
}

test("H4h: an unreadable record of an earlier recovery that still runs never admits the next; the outputs after both keep the failure (control: a clean overlap)", async (t) => {
  // The review's schedule: A holds after reading a clean covered run; a directory appears at A's record path (EISDIR); B starts.
  for (const mode of ["clean (control)", "unreadable record"]) {
    const { dir, runDir, start, reached, release } = heldRun(t);
    const a = start({
      evidence: dir,
      env: faults({ reaper_hold_inputs: [1] }),
    });
    assert.ok(
      await until(() => reached(1)),
      `${mode}: A holds after its inputs`,
    );
    if (mode !== "clean (control)") mkdirSync(attemptFile(runDir, 1));
    const summaryBefore = read(join(runDir, "summary.json"));
    const b = start({ evidence: dir });
    assert.ok(
      await until(() => existsSync(claimFile(runDir, 2))),
      `${mode}: B claimed attempt 2`,
    );
    // An observation window only (the order's own bound stays 30 s): B publishes nothing while A is held and running.
    assert.equal(
      await until(
        () =>
          existsSync(join(runDir, "reaper.json")) ||
          read(join(runDir, "summary.json")) !== summaryBefore ||
          existsSync(attemptFile(runDir, 2)),
        1500,
      ),
      false,
      `${mode}: B replaces nothing while A may still publish`,
    );
    assert.equal(a.done, false, `${mode}: A still running`);
    assert.equal(b.done, false, `${mode}: B still waiting`);
    release(1);
    const doneA = await a.result;
    const doneB = await b.result;
    const finalReaper = readOutput(join(runDir, "reaper.json"), mode);
    const finalSummary = readOutput(join(runDir, "summary.json"), mode);
    assert.equal(finalReaper.attempt, 2, `${mode}: the last publisher is B`);
    assert.equal(finalSummary.reaper?.attempt, 2, mode);
    if (mode === "clean (control)") {
      assert.equal(doneA.code, 0, doneA.log);
      assert.equal(doneB.code, 0, doneB.log);
      assert.equal(finalSummary.outcome, "passed", doneB.log);
      assert.deepEqual(finalSummary.evidence_errors, [], doneB.log);
      assert.deepEqual(finalReaper.recovery_history?.evidence_errors, []);
      continue;
    }
    // A could not write its record (the directory is there): its exit and stderr say so.
    assert.equal(doneA.code, 1, doneA.log);
    assert.match(
      doneA.log,
      /evidence NOT written: recovery attempt 1's record/,
    );
    // B read A's record only after A had ended: unreadable, a failure B and its outputs keep.
    assert.equal(doneB.code, 1, doneB.log);
    const eisdir = /recovery attempt 1's record could not be read: EISDIR/;
    assert.equal(finalSummary.outcome, "failed", doneB.log);
    assert.match((finalSummary.evidence_errors ?? []).join("\n"), eisdir);
    assert.match((finalReaper.evidence_errors ?? []).join("\n"), eisdir);
    assert.match(
      (finalReaper.recovery_history?.evidence_errors ?? []).join("\n"),
      eisdir,
    );
    assert.equal(finalReaper.recovery_history?.cleanup_not_verified, true);
    const own = readOutput(attemptFile(runDir, 2), mode);
    assert.match((own.evidence_errors ?? []).join("\n"), eisdir);
  }
});

test("H4h: a valid record does not admit the next recovery while its claimant still runs; once it has ended the run stays clean, not unknown", async (t) => {
  const r = await coveredRun(t);
  assert.equal(r.code, 0, r.log);
  assert.equal(
    existsSync(attemptFile(r.runDir, 1)),
    true,
    `the first recovery recorded attempt 1: ${r.log}`,
  );
  const holder = await holdClaim(t, r.runDir, 2);
  recordAttempt(
    r.runDir,
    2,
    `${JSON.stringify({ attempt: 2, ok: true, evidence_errors: [] })}\n`,
  );
  const reaperBefore = read(join(r.runDir, "reaper.json"));
  const summaryBefore = read(join(r.runDir, "summary.json"));
  const waiting = again(r.runDir);
  assert.ok(
    await until(() => existsSync(claimFile(r.runDir, 3))),
    "attempt 3 claimed",
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(read(join(r.runDir, "reaper.json")), reaperBefore);
  assert.equal(read(join(r.runDir, "summary.json")), summaryBefore);
  assert.equal(existsSync(attemptFile(r.runDir, 3)), false);
  holder.kill("SIGKILL");
  const done = await waiting;
  assert.equal(done.code, 0, done.log);
  assert.equal(done.reaped?.attempt, 3);
  assert.equal(done.summary?.outcome, "passed", done.log);
  assert.doesNotMatch(done.log, /ended without its record/);
});

test("H4h: a recovery refused while an earlier one holds its inputs replaces nothing; the recovery after both have ended keeps the refusal", async (t) => {
  const { dir, runDir, start, reached, release } = heldRun(t);
  const a = start({
    evidence: dir,
    env: faults({ reaper_hold_inputs: [1] }),
  });
  assert.ok(await until(() => reached(1)), "A holds after its inputs");
  const summaryBefore = read(join(runDir, "summary.json"));
  // B's order bound is shortened: it bounds waiting for another recovery and is not a duration under test.
  const b = await reapIn(runDir, {
    messages: C3_MESSAGES,
    evidence: dir,
    env: { ATLAS_REAPER_ORDER_WAIT_MS: "1000" },
  });
  assert.equal(b.code, 1, b.log);
  assert.equal(read(join(runDir, "summary.json")), summaryBefore);
  assert.equal(existsSync(join(runDir, "reaper.json")), false);
  const refusal = readOutput(attemptFile(runDir, 2), "B's record");
  assert.match(refusal.refused, /^recovery attempt 1 has not ended/);
  release(1);
  const doneA = await a.result;
  // A's outputs are what A read before B refused (a projection of its own inputs; A cannot know a later refusal). Recorded, not judged.
  assert.equal(
    readOutput(join(runDir, "reaper.json"), doneA.log).attempt,
    1,
    doneA.log,
  );
  const c = await again(runDir);
  assert.equal(c.code, 1, c.log);
  assert.equal(c.reaped?.attempt, 3);
  assert.equal(c.summary?.outcome, "failed", c.log);
  assert.match(
    (c.summary?.evidence_errors ?? []).join("\n"),
    /this recovery replaced nothing: recovery attempt 1 has not ended/,
  );
  assert.deepEqual(
    c.reaped?.recovery_history?.attempts?.map((e) => e.attempt),
    [1, 2, 3],
  );
});

test("H4h: a claim this recovery could not read while it waited stays one of its failures after a later poll reads it", async (t) => {
  const r = await coveredRun(t);
  assert.equal(r.code, 0, r.log);
  assert.equal(
    existsSync(attemptFile(r.runDir, 1)),
    true,
    `the first recovery recorded attempt 1: ${r.log}`,
  );
  // Labelled: a directory at claim 2 that the case later replaces by a claim of a finished process (no recovery replaces a claim).
  mkdirSync(claimFile(r.runDir, 2));
  const waiting = again(r.runDir);
  assert.ok(
    await until(() => existsSync(claimFile(r.runDir, 3))),
    "attempt 3 claimed",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(existsSync(attemptFile(r.runDir, 3)), false, "it waited");
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  rmSync(claimFile(r.runDir, 2), { recursive: true });
  writeFileSync(
    claimFile(r.runDir, 2),
    JSON.stringify({ attempt: 2, pid: gone.pid, started: null }),
  );
  const done = await waiting;
  assert.equal(done.code, 1, done.log);
  const errors = (done.summary?.evidence_errors ?? []).join("\n");
  assert.match(errors, /recovery attempt 2's claim could not be read: EISDIR/);
  assert.match(errors, /recovery attempt 2 ended without its record/);
  assert.match(
    (done.reaped?.evidence_errors ?? []).join("\n"),
    /recovery attempt 2's claim could not be read: EISDIR/,
  );
});

// ---- review r14 H4i (revision 15): a read failure observed once stays a failure when a later read of the same bytes succeeds -------
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { stackFile } from "./stack-records.mjs";

/**
 * A labelled read-fault seam for one reaper process (a Node preload given by `execArgv`; nothing in the reaper or its files changes):
 * the reads of exactly `path` are counted, each logged with its ordinal and the function that read it, and the reads numbered in
 * `fail` throw EIO. The file's bytes never change. `reads()` is the log, so a case can prove which read failed and that each read
 * site was reached.
 */
function readFault(t, path, fail) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4i-fault-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "read-fault.mjs");
  const log = join(dir, "reads.jsonl");
  writeFileSync(
    preload,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const target = ${JSON.stringify(path)};
const fail = new Set(${JSON.stringify(fail)});
const SITES = ["awaitEarlier", "readHistory", "committedSettled", "readStackRecords"];
const original = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (file, ...rest) {
  if (String(file) === target) {
    reads += 1;
    const stack = new Error().stack ?? "";
    const site = SITES.find((s) => stack.includes(\`at \${s} \`)) ?? null;
    const failed = fail.has(reads);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ read: reads, site, failed }) + "\\n");
    if (failed) {
      const error = new Error(\`EIO: injected transient read failure \${reads}\`);
      error.code = "EIO";
      throw error;
    }
  }
  return original.call(this, file, ...rest);
};
syncBuiltinESMExports();
`,
  );
  return {
    execArgv: ["--import", pathToFileURL(preload).href],
    reads: () =>
      (read(log) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const EIO =
  /recovery attempt 1's record could not be read: EIO: injected transient read failure/;
const joined = (list) => (list ?? []).join("\n");
/** Every final channel of a recovery after an observed record read failure: exit, summary, reaper.json, its own record, stderr. */
function assertKept(run, n, label) {
  assert.equal(run.code, 1, `${label}: ${run.log}`);
  assert.equal(run.summary?.outcome, "failed", `${label}: ${run.log}`);
  assert.match(joined(run.summary?.evidence_errors), EIO, `${label}: summary`);
  assert.equal(run.summary?.cleanup_failed, true, `${label}: summary`);
  assert.equal(run.reaped?.attempt, n, label);
  assert.match(
    joined(run.reaped?.evidence_errors),
    EIO,
    `${label}: reaper.json`,
  );
  assert.match(
    joined(run.reaped?.recovery_history?.evidence_errors),
    EIO,
    `${label}: reaper.json history`,
  );
  assert.equal(
    run.reaped?.recovery_history?.cleanup_not_verified,
    true,
    `${label}: attempt 1's clean-up is not verified`,
  );
  const own = readOutput(attemptFile(run.runDir, n), label);
  assert.match(joined(own.evidence_errors), EIO, `${label}: own record`);
  assert.equal(own.recovery_history?.cleanup_not_verified, true, label);
  assert.ok(distinct(run.summary?.evidence_errors), `${label}: said once`);
  assert.ok(distinct(run.reaped?.evidence_errors), `${label}: said once`);
  assert.match(
    run.log,
    /evidence NOT written: recovery attempt 1's record could not be read: EIO/,
    label,
  );
}

test("H4i: an earlier attempt's record read failure at admission or at the history read stays a failure of every final channel and of a later recovery (controls: healthy, an unreached ordinal)", async (t) => {
  // Two real, sequential reapers over a covered clean run: attempt 1 completes normally; attempt 2 reads attempt 1's record twice
  // (admission, then history) with the labelled seam failing read `fail` (0: none; 3: an ordinal never reached, the inert control).
  for (const [label, fail, site] of [
    ["healthy (control)", 0, null],
    ["an unreached ordinal (inert control)", 3, null],
    [
      "admission read fails, history read succeeds (review r14 H4i)",
      1,
      "awaitEarlier",
    ],
    ["history read fails", 2, "readHistory"],
  ]) {
    const first = await coveredRun(t);
    assert.equal(first.code, 0, `${label}: ${first.log}`);
    const record = attemptFile(first.runDir, 1);
    assert.equal(existsSync(record), true, `${label}: attempt 1 recorded`);
    const before = sha256(record);
    const fault = readFault(t, record, [fail]);
    const second = await again(first.runDir, { execArgv: fault.execArgv });
    const reads = fault.reads();
    assert.deepEqual(
      reads.map((r) => r.site),
      ["awaitEarlier", "readHistory"],
      `${label}: both read sites reached, once each`,
    );
    assert.deepEqual(
      reads.filter((r) => r.failed).map((r) => r.site),
      site === null ? [] : [site],
      `${label}: the failed read`,
    );
    assert.equal(
      sha256(record),
      before,
      `${label}: attempt 1's bytes unchanged`,
    );
    if (site === null) {
      assert.equal(second.code, 0, `${label}: ${second.log}`);
      assert.equal(second.summary?.outcome, "passed", label);
      assert.deepEqual(second.summary?.evidence_errors, [], label);
      assert.deepEqual(second.reaped?.evidence_errors, [], label);
      assert.equal(
        second.reaped?.recovery_history?.cleanup_not_verified,
        false,
        label,
      );
      continue;
    }
    assertKept(second, 2, label);
    // A third recovery, no fault: attempt 1's record now reads clean, and the failure survives through attempt 2's record and reaper.json.
    const third = await again(first.runDir);
    assert.equal(third.code, 1, `${label}: third: ${third.log}`);
    assert.equal(third.summary?.outcome, "failed", `${label}: third`);
    assert.match(
      joined(third.summary?.evidence_errors),
      EIO,
      `${label}: third summary`,
    );
    assert.match(
      joined(third.reaped?.recovery_history?.evidence_errors),
      EIO,
      `${label}: third history`,
    );
    assert.deepEqual(
      third.reaped?.evidence_errors,
      [],
      `${label}: third's own reads were clean`,
    );
    assert.equal(
      sha256(record),
      before,
      `${label}: attempt 1's bytes still unchanged`,
    );
  }
});

test("H4i: a record read failure on an early poll survives later healthy polls while another attempt runs, and a refusal's own record keeps it", async (t) => {
  for (const mode of ["the earlier attempt ends", "refused"]) {
    const first = await coveredRun(t);
    assert.equal(first.code, 0, `${mode}: ${first.log}`);
    const record = attemptFile(first.runDir, 1);
    assert.equal(existsSync(record), true, `${mode}: attempt 1 recorded`);
    const before = sha256(record);
    const holder = await holdClaim(t, first.runDir, 2);
    const reaperBefore = read(join(first.runDir, "reaper.json"));
    const summaryBefore = read(join(first.runDir, "summary.json"));
    const fault = readFault(t, record, [1]);
    // The refused recovery's order bound is shortened: it bounds waiting for another recovery and is not a duration under test.
    const waiting = again(first.runDir, {
      execArgv: fault.execArgv,
      ...(mode === "refused"
        ? { env: { ATLAS_REAPER_ORDER_WAIT_MS: "1500" } }
        : {}),
    });
    // Attempt 1's record is read on every poll while attempt 2's claimant runs: the first read failed, later ones did not.
    assert.ok(
      await until(() => fault.reads().length >= 3),
      `${mode}: it polled after the failed read`,
    );
    if (mode === "the earlier attempt ends") holder.kill("SIGKILL");
    const done = await waiting;
    const reads = fault.reads();
    assert.deepEqual(
      reads[0],
      { read: 1, site: "awaitEarlier", failed: true },
      mode,
    );
    assert.ok(
      reads.slice(1).every((r) => !r.failed),
      mode,
    );
    assert.equal(
      sha256(record),
      before,
      `${mode}: attempt 1's bytes unchanged`,
    );
    if (mode === "refused") {
      assert.equal(done.code, 1, done.log);
      assert.equal(
        reads.at(-1).site,
        "awaitEarlier",
        "no history is read on a refusal",
      );
      assert.equal(
        read(join(first.runDir, "reaper.json")),
        reaperBefore,
        "reaper.json not replaced",
      );
      assert.equal(
        read(join(first.runDir, "summary.json")),
        summaryBefore,
        "nor the summary",
      );
      const own = readOutput(attemptFile(first.runDir, 3), mode);
      assert.match(own.refused, /^recovery attempt 2 has not ended/);
      assert.match(joined(own.evidence_errors), EIO);
      assert.equal(own.recovery_history?.cleanup_not_verified, true);
      assert.match(
        done.log,
        /evidence NOT written: recovery attempt 1's record could not be read: EIO/,
      );
      continue;
    }
    assert.equal(
      reads.at(-1).site,
      "readHistory",
      `${mode}: the history read succeeded`,
    );
    assertKept(done, 3, mode);
    assert.match(
      joined(done.summary?.evidence_errors),
      /recovery attempt 2 ended without its record/,
    );
  }
});

test("H4i: an admission read failure with a failed summary publication: reaper.json and the own record are its witnesses, and the next recovery keeps it", async (t) => {
  const first = await coveredRun(t);
  assert.equal(first.code, 0, first.log);
  const record = attemptFile(first.runDir, 1);
  assert.equal(existsSync(record), true, "attempt 1 recorded");
  const summaryBefore = read(join(first.runDir, "summary.json"));
  const fault = readFault(t, record, [1]);
  const second = await again(first.runDir, {
    execArgv: fault.execArgv,
    env: faults({ reaper_publish_fail: { "summary.json": [1] } }),
  });
  assert.equal(
    existsSync(
      join(first.runDir, "faults", "reaper-publish-summary-json-1.failed"),
    ),
    true,
    `the summary publication was attempted and failed: ${second.log}`,
  );
  assert.equal(second.code, 1, second.log);
  // The bounded design's limit, kept visible: the summary is still the first recovery's.
  assert.equal(read(join(first.runDir, "summary.json")), summaryBefore);
  assert.match(joined(second.reaped?.evidence_errors), EIO);
  assert.match(
    joined(second.reaped?.evidence_errors),
    /^summary\.json: injected failure/m,
  );
  assert.equal(second.reaped?.recovery_history?.cleanup_not_verified, true);
  assert.match(
    joined(readOutput(attemptFile(first.runDir, 2), "own").evidence_errors),
    EIO,
  );
  const third = await again(first.runDir);
  assert.equal(third.code, 1, third.log);
  assert.equal(third.summary?.outcome, "failed", third.log);
  assert.match(joined(third.summary?.evidence_errors), EIO);
});

test("H4i neighbour (design assessment C3/Q9): a committed record that cannot be read when its stack-end arrives stays a failure of a take-over; a release says it (controls: healthy)", async (t) => {
  const ACK =
    /the committed record of chromium-0 could not be read when its stack-end was journalled: EIO: injected transient read failure 1/;
  const committed = (runDir) => {
    const store = createStackStore(runDir);
    store.commit({ ...name0, outcome: "running", obs: 1 }, "started");
    return store.commit(
      { ...name0, ...REPORT_FAILURE, cleanup: { ok: true }, obs: 2 },
      "settled",
    ).seq;
  };
  const journalled = (seq) => [
    { type: "stack", browser: "chromium", index: 0, stack: "base" },
    {
      type: "judged",
      browser: "chromium",
      index: 0,
      seq,
      obs: 2,
      record: { ...REPORT_FAILURE, cleanup: { ok: true } },
    },
    { type: "stack-end", browser: "chromium", index: 0, seq },
  ];
  for (const faulty of [false, true]) {
    const label = faulty
      ? "the acknowledgement's read fails"
      : "healthy (control)";
    // A take-over: the runner was lost after the stack-end.
    const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4i-ack-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const runDir = join(dir, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN));
    writeFileSync(
      join(runDir, "summary.json"),
      JSON.stringify({
        schema: 3,
        invocation: { finished: false },
        outcome: "running",
        stacks: [],
      }),
    );
    const seq = committed(runDir);
    const fault = readFault(
      t,
      stackFile(runDir, "chromium", 0),
      faulty ? [1] : [],
    );
    const r = await reapIn(runDir, {
      messages: journalled(seq),
      evidence: dir,
      execArgv: fault.execArgv,
    });
    const reads = fault.reads();
    assert.equal(
      reads[0]?.site,
      "committedSettled",
      `${label}: the acknowledgement read the record first`,
    );
    assert.equal(reads[0]?.failed, faulty, label);
    assert.ok(
      reads.some((x) => x.site === "readStackRecords" && !x.failed),
      `${label}: the take-over's later read of the record succeeded`,
    );
    // The reaper's exit is its own evidence (the stack's failure is the summary's): 1 only when what it read could not be read.
    assert.equal(r.code, faulty ? 1 : 0, `${label}: ${r.log}`);
    assert.equal(r.summary?.outcome, "failed", `${label}: the stack failed`);
    const ack = r.reaped?.acknowledged ?? [];
    assert.equal(ack.length, 1, label);
    assert.equal(ack[0].confirmed, !faulty, label);
    if (!faulty) {
      assert.equal(ack[0].unreadable, undefined, label);
      assert.doesNotMatch(
        joined(r.summary?.evidence_errors),
        /when its stack-end was journalled/,
        label,
      );
      assert.doesNotMatch(
        joined(r.reaped?.evidence_errors),
        /when its stack-end was journalled/,
        label,
      );
    } else {
      assert.match(
        ack[0].unreadable,
        /EIO: injected transient read failure 1/,
        label,
      );
      assert.match(joined(r.summary?.evidence_errors), ACK, label);
      assert.match(joined(r.reaped?.evidence_errors), ACK, label);
      assert.match(
        joined(readOutput(attemptFile(runDir, 1), label).evidence_errors),
        ACK,
        label,
      );
    }
    // A release: the runner published its summary; this process publishes no recovery output, and says what it could not read.
    // ADAPTED, labelled (revision 16, review r15 H4j): revision 15 asserted exit 0 for the release in BOTH cells and nothing more, which
    // let an observed read failure reach no verdict. The old intent (a release publishes no summary/reaper.json, the read site is the
    // acknowledgement's, the failure is said on stderr) is kept; the release now also publishes its terminal receipt (observer.json)
    // with the failure, and exits 1 when it holds one (0 in the healthy control).
    const releasedDir = mkdtempSync(
      join(tmpdir(), "atlas-reaper-h4i-release-"),
    );
    t.after(() => rmSync(releasedDir, { recursive: true, force: true }));
    const releasedRun = join(releasedDir, "run");
    mkdirSync(releasedRun);
    const releasedSeq = committed(releasedRun);
    const releasedFault = readFault(
      t,
      stackFile(releasedRun, "chromium", 0),
      faulty ? [1] : [],
    );
    const rel = await reapIn(releasedRun, {
      messages: [...journalled(releasedSeq), { type: "released", ok: true }],
      evidence: releasedDir,
      execArgv: releasedFault.execArgv,
    });
    assert.equal(rel.code, faulty ? 1 : 0, `${label}: release: ${rel.log}`);
    assert.equal(
      existsSync(join(releasedRun, "reaper.json")),
      false,
      `${label}: release publishes no recovery output`,
    );
    assert.equal(
      existsSync(join(releasedRun, "summary.json")),
      false,
      `${label}: release publishes no summary`,
    );
    const receipt = readOutput(join(releasedRun, "observer.json"), label);
    assert.equal(receipt?.phase, "released", label);
    if (faulty) assert.match(joined(receipt?.errors), ACK, label);
    else assert.deepEqual(receipt?.errors, [], label);
    assert.deepEqual(
      releasedFault.reads().map((x) => [x.site, x.failed]),
      [["committedSettled", faulty]],
      `${label}: release`,
    );
    if (faulty)
      assert.match(
        rel.log,
        /after the release \(the runner's summary is the evidence\): the committed record of chromium-0 could not be read when its stack-end was journalled: EIO/,
      );
    else assert.doesNotMatch(rel.log, /after the release/);
  }
});

// ---- review r15 H4j (revision 16): what the reaper observes reaches the runner, also on a normal release -----------------------------
import { awaitReceipt } from "./observer.mjs";

// The invocation `reapIn` journals, so a later recovery of the same run reads the receipt as this run's.
const INV16 = "inv-h4d";
const ACK16 =
  /the committed record of chromium-0 could not be read when its stack-end was journalled: EIO: injected transient read failure 1/;
/** A run folder whose stack chromium-0 has a committed settled record; returns { runDir, seq }. */
function settledRun(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-reaper-h4j-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  const store = createStackStore(runDir);
  store.commit({ ...name0, outcome: "running", obs: 1 }, "started");
  const { seq } = store.commit(
    { ...name0, ...PASSED_SETTLED, cleanup: { ok: true }, obs: 2 },
    "settled",
  );
  return { runDir, seq };
}
const stackEnd16 = (seq) => [
  { type: "stack", browser: "chromium", index: 0, stack: "base" },
  {
    type: "judged",
    browser: "chromium",
    index: 0,
    seq,
    obs: 2,
    record: { ...PASSED_SETTLED, cleanup: { ok: true } },
  },
  { type: "stack-end", browser: "chromium", index: 0, seq },
];
/**
 * A reaper whose journal stays open (as the runner's does while a run goes on): `send` journals a message, `raw` a line as it is,
 * `receipt(n, phase)` waits (bounded) for its receipt as the runner does, `release()` ends the journal with a release, and `closed` is
 * how it ended. A case that ends without a release leaves it to be killed.
 */
async function liveReaper(t, runDir, { execArgv = [], env = {} } = {}) {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.once("exit", r));
  const reaper = spawn(
    process.execPath,
    [
      ...execArgv,
      join(here, "reaper.mjs"),
      runDir,
      `ATLAS_TEST_${Date.now()}`,
      String(gone.pid),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ATLAS_INTEGRATION_FAULTS: "", ...env },
    },
  );
  let log = "";
  reaper.stdout.on("data", (d) => {
    log += d;
  });
  reaper.stderr.on("data", (d) => {
    log += d;
  });
  const closed = new Promise((r) =>
    reaper.once("close", (code, signal) => r({ code, signal })),
  );
  t.after(() => {
    try {
      reaper.kill("SIGKILL");
    } catch {
      // gone
    }
  });
  const raw = (line) => reaper.stdin.write(`${line}\n`);
  const send = (m) => raw(JSON.stringify(m));
  send({ type: "hello", invocation: INV16, evidence: dirname(runDir) });
  return {
    send,
    raw,
    receipt: (barrier, phase = "barrier", ms = 10_000) =>
      awaitReceipt(runDir, { invocation: INV16, barrier, phase, ms }),
    release: () => {
      reaper.stdin.end(`${JSON.stringify({ type: "released", ok: true })}\n`);
      return closed;
    },
    abandon: () => {
      reaper.stdin.end();
      return closed;
    },
    closed,
    log: () => log,
  };
}
const barrier16 = (id, invocation = INV16) => ({
  type: "barrier",
  id,
  invocation,
});

test("H4j: a barrier returns the acknowledgement read's failure, cumulatively, and the release ends with it (control: healthy)", async (t) => {
  for (const faulty of [false, true]) {
    const label = faulty
      ? "the acknowledgement's read fails"
      : "healthy (control)";
    const { runDir, seq } = settledRun(t);
    const fault = readFault(
      t,
      stackFile(runDir, "chromium", 0),
      faulty ? [1] : [],
    );
    const r = await liveReaper(t, runDir, { execArgv: fault.execArgv });
    for (const m of stackEnd16(seq)) r.send(m);
    r.send(barrier16(1));
    const first = await r.receipt(1);
    assert.equal(first.state, "covered", `${label}: ${first.error} ${r.log()}`);
    assert.deepEqual(
      fault.reads().map((x) => [x.site, x.failed]),
      [["committedSettled", faulty]],
      `${label}: the acknowledgement read was reached before the barrier was answered`,
    );
    if (faulty) assert.match(joined(first.receipt.errors), ACK16, label);
    else assert.deepEqual(first.receipt.errors, [], label);
    // A later barrier with nothing new still returns everything observed (a receipt never has fewer).
    r.send(barrier16(2));
    const second = await r.receipt(2);
    assert.equal(second.state, "covered", label);
    assert.deepEqual(second.receipt.errors, first.receipt.errors, label);
    const end = await r.release();
    assert.equal(end.code, faulty ? 1 : 0, `${label}: ${r.log()}`);
    const terminal = readOutput(join(runDir, "observer.json"), label);
    assert.equal(terminal.phase, "released", label);
    assert.equal(terminal.barrier, 2, label);
    assert.equal(terminal.invocation, INV16, label);
    assert.deepEqual(terminal.errors, first.receipt.errors, label);
    // A release still publishes no recovery output.
    assert.equal(existsSync(join(runDir, "reaper.json")), false, label);
    assert.equal(existsSync(join(runDir, "summary.json")), false, label);
  }
});

test("H4j: a damaged journal line, a malformed barrier and a barrier of another invocation are failures a release returns (control: none)", async (t) => {
  const cells = [
    ["healthy (control)", (r) => r.send(barrier16(1)), null],
    [
      "a damaged line",
      (r) => {
        r.raw("{ torn journal line");
        r.send(barrier16(1));
      },
      /1 journal line\(s\) could not be read, so what they said is unknown \(the first: "\{ torn journal line"\)/,
    ],
    [
      "a barrier without a number",
      (r) => {
        r.send({ type: "barrier", invocation: INV16 });
        r.send(barrier16(1));
      },
      /1 journal line\(s\) could not be read/,
    ],
    [
      "a barrier of another invocation",
      (r) => r.send(barrier16(1, "inv-other")),
      /a journal barrier named invocation inv-other, not this journal's inv-h4d/,
    ],
  ];
  for (const [label, act, error] of cells) {
    const { runDir } = settledRun(t);
    const r = await liveReaper(t, runDir);
    act(r);
    const answer = await r.receipt(1);
    assert.equal(answer.state, "covered", `${label}: ${r.log()}`);
    if (error) assert.match(joined(answer.receipt.errors), error, label);
    else assert.deepEqual(answer.receipt.errors, [], label);
    const end = await r.release();
    assert.equal(end.code, error ? 1 : 0, `${label}: ${r.log()}`);
    const terminal = readOutput(join(runDir, "observer.json"), label);
    if (error) assert.match(joined(terminal.errors), error, label);
    else assert.deepEqual(terminal.errors, [], label);
  }
});

test("H4j: a receipt that cannot be published leaves its barrier unanswered and fails the release; so does a terminal receipt that cannot be", async (t) => {
  // The first receipt fails (the n-th publication of observer.json, faults.mjs): the runner's wait is not answered; the next receipt
  // says why, and the release exits 1.
  {
    const { runDir } = settledRun(t);
    const r = await liveReaper(t, runDir, {
      env: faults({ reaper_publish_fail: { "observer.json": [1] } }),
    });
    r.send(barrier16(1));
    const missing = await r.receipt(1, "barrier", 1000);
    assert.equal(missing.state, "failed", r.log());
    assert.match(missing.error, /did not answer barrier 1 within 1000 ms/);
    assert.equal(
      existsSync(
        join(runDir, "faults", "reaper-publish-observer-json-1.failed"),
      ),
      true,
      "the first publication was attempted and failed",
    );
    r.send(barrier16(2));
    const next = await r.receipt(2);
    assert.equal(next.state, "covered", r.log());
    assert.match(
      joined(next.receipt.errors),
      /observer\.json could not be published \(barrier 1\): injected failure publishing observer\.json \(attempt 1\)/,
    );
    const end = await r.release();
    assert.equal(end.code, 1, r.log());
  }
  // The terminal receipt fails: the file stays the barrier's receipt (never `released`), the release exits 1 and says why.
  {
    const { runDir } = settledRun(t);
    const r = await liveReaper(t, runDir, {
      env: faults({ reaper_publish_fail: { "observer.json": [2] } }),
    });
    r.send(barrier16(1));
    assert.equal((await r.receipt(1)).state, "covered", r.log());
    const end = await r.release();
    assert.equal(end.code, 1, r.log());
    const left = readOutput(join(runDir, "observer.json"), "terminal failed");
    assert.equal(left.phase, "barrier");
    assert.deepEqual(left.errors, []);
    assert.match(
      r.log(),
      /evidence NOT written: observer\.json could not be published \(released 1\)/,
    );
  }
});

test("H4j qualification seam reaper_release: exit, kill and linger end a release as named (control: a clean release exits 0)", async (t) => {
  for (const [how, expect] of [
    [null, { code: 0, signal: null }],
    ["exit", { code: 3, signal: null }],
    ["kill", { code: null, signal: "SIGKILL" }],
    ["linger", { code: 0, signal: null }],
  ]) {
    const { runDir } = settledRun(t);
    const r = await liveReaper(t, runDir, {
      env: {
        ...(how ? faults({ reaper_release: how }) : {}),
        ATLAS_REAPER_DEADLINE_MS: "1500",
      },
    });
    r.send(barrier16(1));
    assert.equal((await r.receipt(1)).state, "covered", r.log());
    const started = Date.now();
    const end = await r.release();
    assert.deepEqual(end, expect, `${how}: ${r.log()}`);
    if (how === "linger") assert.ok(Date.now() - started >= 1400, "it stayed");
    // The terminal receipt is published before the seam acts.
    assert.equal(
      readOutput(join(runDir, "observer.json"), String(how)).phase,
      "released",
    );
  }
});

test("H4j: a recovery joins the receipt's failures, and a summary covering a barrier needs its receipt (control: receipt present, legacy run without one)", async (t) => {
  const covering = (barrier) =>
    finishedSummary([settled0], {
      terminal: {
        quiescent: true,
        observations: 1,
        observer: { barrier, receipt: "observer.json" },
      },
    });
  const write = (value) => (runDir) =>
    writeFileSync(
      join(runDir, "observer.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const receipt = (fields = {}) => ({
    schema: 1,
    invocation: "inv-h4d",
    barrier: 2,
    phase: "released",
    errors: [],
    ...fields,
  });
  const cells = [
    ["receipt present (control)", covering(2), write(receipt()), null],
    [
      "legacy run: no barrier, no receipt (control)",
      finishedSummary([settled0]),
      () => undefined,
      null,
    ],
    [
      "receipt missing",
      covering(2),
      () => undefined,
      /the runner's summary covers the reaper's barrier 2, but observer\.json is missing/,
    ],
    [
      "receipt older than the summary covers",
      covering(2),
      write(receipt({ barrier: 1, phase: "barrier" })),
      /the runner's summary covers the reaper's barrier 2, but observer\.json answers only barrier 1/,
    ],
    [
      "receipt unreadable",
      covering(2),
      write("{ torn"),
      /the reaper's observer\.json could not be read/,
    ],
    [
      "receipt of another invocation",
      covering(2),
      write(receipt({ invocation: "inv-other" })),
      /the reaper's observer\.json names invocation inv-other, not inv-h4d/,
    ],
    [
      "receipt returned a failure the summary does not have",
      covering(2),
      write(receipt({ errors: ["observed: EIO at the acknowledgement"] })),
      /^observed: EIO at the acknowledgement$/m,
    ],
  ];
  for (const [label, summary, prepare, error] of cells) {
    const r = await reapFinished(t, {
      summary,
      messages: C3_MESSAGES,
      prepare,
    });
    if (error) {
      assert.equal(
        r.code,
        label.startsWith("receipt returned") ? 0 : 1,
        `${label}: ${r.log}`,
      );
      assert.equal(r.summary?.outcome, "failed", `${label}: ${r.log}`);
      assert.match(joined(r.summary?.evidence_errors), error, label);
      assert.match(joined(r.reaped?.run_evidence_errors), error, label);
    } else {
      assert.equal(r.code, 0, `${label}: ${r.log}`);
      assert.equal(r.summary?.outcome, "passed", `${label}: ${r.log}`);
      assert.deepEqual(r.summary?.evidence_errors, [], label);
    }
  }
});

test("H4j: a runner lost after the reaper returned a failure and before its summary had it: the take-over's summary has it", async (t) => {
  const { runDir, seq } = settledRun(t);
  writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify({
      schema: 3,
      invocation: { finished: false },
      outcome: "running",
      stacks: [],
    }),
  );
  const fault = readFault(t, stackFile(runDir, "chromium", 0), [1]);
  const r = await liveReaper(t, runDir, { execArgv: fault.execArgv });
  for (const m of stackEnd16(seq)) r.send(m);
  r.send(barrier16(1));
  const answer = await r.receipt(1);
  assert.equal(answer.state, "covered", r.log());
  assert.match(joined(answer.receipt.errors), ACK16);
  // The journal ends without a release (the runner is gone): a take-over.
  const end = await r.abandon();
  assert.equal(end.code, 1, r.log());
  const summary = readOutput(join(runDir, "summary.json"), "take-over");
  assert.equal(summary.outcome, "failed", r.log());
  assert.match(joined(summary.evidence_errors), ACK16);
  assert.match(
    joined(
      readOutput(join(runDir, "reaper.json"), "take-over").evidence_errors,
    ),
    ACK16,
  );
  // A second recovery of the run (a fresh process, nothing journalled) still finds it (the first recovery's record and the receipt).
  const again16 = await reapIn(runDir, { evidence: dirname(runDir) });
  assert.equal(again16.summary?.outcome, "failed", again16.log);
  assert.match(joined(again16.summary?.evidence_errors), ACK16);
});

test("H4j: a receipt that could not be published and a barrier of another invocation are failures of a take-over too (control: neither)", async (t) => {
  for (const [label, env, act, error] of [
    ["healthy (control)", {}, (r) => r.send(barrier16(1)), null],
    [
      "the receipt could not be published",
      faults({ reaper_publish_fail: { "observer.json": [1] } }),
      (r) => r.send(barrier16(1)),
      /observer\.json could not be published \(barrier 1\)/,
    ],
    [
      "a barrier of another invocation",
      {},
      (r) => r.send(barrier16(1, "inv-other")),
      /a journal barrier named invocation inv-other/,
    ],
  ]) {
    const { runDir } = settledRun(t);
    writeFileSync(join(runDir, "plan.json"), JSON.stringify(PLAN0));
    writeFileSync(
      join(runDir, "summary.json"),
      JSON.stringify({
        schema: 3,
        invocation: { finished: false },
        outcome: "running",
        stacks: [],
      }),
    );
    const r = await liveReaper(t, runDir, { env });
    act(r);
    // Wait until the barrier was handled (answered, or its publication attempted).
    assert.ok(
      await until(
        () =>
          existsSync(join(runDir, "observer.json")) ||
          existsSync(join(runDir, "faults")),
      ),
      label,
    );
    const end = await r.abandon();
    const reaped = readOutput(join(runDir, "reaper.json"), label);
    if (error) {
      assert.equal(end.code, 1, `${label}: ${r.log()}`);
      assert.match(joined(reaped.evidence_errors), error, label);
      assert.match(
        joined(readOutput(join(runDir, "summary.json"), label).evidence_errors),
        error,
        label,
      );
    } else {
      assert.equal(end.code, 0, `${label}: ${r.log()}`);
      assert.deepEqual(reaped.evidence_errors, [], label);
    }
  }
});

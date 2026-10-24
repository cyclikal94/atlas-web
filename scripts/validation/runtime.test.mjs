import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { classifyMutant, inspectReport } from "./engine-results.mjs";
import { fingerprint, pool, positiveInteger, processes } from "./runtime.mjs";

const browsers = ["chromium", "firefox", "webkit"];
const report = (status, message = "", overrides = {}) => ({
  suites: [
    {
      title: "case.spec.ts",
      specs: [
        {
          title: "required assertion",
          tests: browsers.map((b) => ({
            projectName: `fixture-${b}`,
            expectedStatus: "passed",
            results: [{ status, errors: message ? [{ message }] : [] }],
            ...overrides,
          })),
        },
      ],
    },
  ],
});
test("only complete controls and intended assertion failures qualify", () => {
  assert.equal(inspectReport(report("passed"), browsers, 0).controlOk, true);
  assert.equal(inspectReport(report("skipped"), browsers, 0).controlOk, false);
  assert.equal(inspectReport({ suites: [] }, browsers, 0).controlOk, false);
  assert.equal(
    inspectReport(
      report("passed", "", {
        results: [{ status: "failed" }, { status: "passed" }],
      }),
      browsers,
      0,
    ).controlOk,
    false,
  );
  const mutant = { expect: /required assertion/ };
  const assertion = inspectReport(
    report("failed", "Error: expect(received).toBe(expected)"),
    browsers,
    1,
  );
  assert.equal(classifyMutant(mutant, assertion, browsers).caught, true);
  assert.equal(
    classifyMutant({ expect: /different assertion/ }, assertion, browsers)
      .caught,
    false,
  );
  assert.equal(
    classifyMutant(
      mutant,
      inspectReport(report("timedOut", "Error: expect(...)"), browsers, 1),
      browsers,
    ).caught,
    false,
  );
  assert.equal(
    classifyMutant(
      mutant,
      inspectReport(report("failed", "TypeError: broken setup"), browsers, 1),
      browsers,
    ).caught,
    false,
  );
  const missing = report("failed", "Error: expect(x)");
  missing.suites[0].specs[0].tests.pop();
  assert.equal(
    classifyMutant(mutant, inspectReport(missing, browsers, 1), browsers)
      .caught,
    false,
  );
  const globalFailure = report("failed", "Error: expect(x)");
  globalFailure.errors = [{ message: "global teardown failed" }];
  assert.equal(
    classifyMutant(mutant, inspectReport(globalFailure, browsers, 1), browsers)
      .caught,
    false,
  );
});
test("bounded jobs stop queuing after a failure, while preserving in-flight results", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const results = await pool([0, 1, 2, 3], 2, async (id) => {
    started.push(id);
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, id === 0 ? 10 : 30));
    active--;
    if (id === 0) throw new Error("survivor");
    return id;
  });
  assert.deepEqual(started, [0, 1]);
  assert.equal(peak, 2);
  assert.match(results[0].error, /survivor/);
  assert.equal(results[1], 1);
  assert.equal(results[2], undefined);
  for (const invalid of ["0", "-1", "1.5", "5", "NaN"])
    assert.throws(() => positiveInteger(invalid, "jobs"));
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-validation-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".agtx/\n");
  mkdirSync(join(dir, "scripts"));
  cpSync(
    resolve(import.meta.dirname, "../run-validation.mjs"),
    join(dir, "scripts/run-validation.mjs"),
  );
  cpSync(import.meta.dirname, join(dir, "scripts/validation"), {
    recursive: true,
  });
  writeFileSync(join(dir, "source.txt"), "first\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  mkdirSync(join(dir, ".agtx"));
  return dir;
}
function executePlan(dir, steps, extra = []) {
  writeFileSync(
    join(dir, ".agtx/plan.json"),
    JSON.stringify({
      version: 2,
      qualification: {
        changed_files: [],
        no_changes_reason:
          "Driver orchestration regression; no product test inputs are changed",
      },
      steps,
    }),
  );
  let output;
  try {
    output = execFileSync(
      process.execPath,
      ["scripts/run-validation.mjs", ".agtx/plan.json", ...extra],
      { cwd: dir, encoding: "utf8" },
    );
  } catch (error) {
    output = error.stdout;
  }
  const path = /Validation evidence: (.+)/.exec(output)?.[1];
  assert.ok(path);
  return JSON.parse(readFileSync(join(path, "results.json"), "utf8"));
}
const step = (id, stage, code) => ({
  id,
  stage,
  requirement: "test invariant",
  argv: [process.execPath, "-e", code],
});
test("unexpected focused failures prevent expensive final commands", (t) => {
  const dir = fixture(t);
  const result = executePlan(
    dir,
    [
      step("bad", "focused", "process.exit(7)"),
      step(
        "expensive",
        "final",
        "require('fs').writeFileSync('.agtx/unwanted','ran')",
      ),
    ],
    ["--final"],
  );
  assert.equal(result.passed, false);
  assert.equal(result.records[0].exit, 7);
  assert.equal(result.records[1].status, "not_run");
  assert.equal(existsSync(join(dir, ".agtx/unwanted")), false);
});
test("focused handoff preserves an explicit deferred ledger", (t) => {
  const result = executePlan(fixture(t), [
    step("cheap", "focused", "process.exit(0)"),
    step("full", "final", "process.exit(9)"),
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.scope, "focused-checks-only");
  assert.equal(result.records[1].status, "deferred");
});
test("untracked inputs and deletions participate in the fingerprint; mid-run edits stop work", (t) => {
  const dir = fixture(t);
  const before = fingerprint(dir);
  writeFileSync(join(dir, "new.txt"), "untracked");
  assert.notEqual(fingerprint(dir).sha256, before.sha256);
  rmSync(join(dir, "source.txt"));
  assert.equal(fingerprint(dir).files["source.txt"], "deleted");
  writeFileSync(join(dir, "source.txt"), "restored");
  const result = executePlan(
    dir,
    [
      step(
        "edit",
        "focused",
        "require('fs').writeFileSync('source.txt','changed')",
      ),
      step("later", "final", "process.exit(0)"),
    ],
    ["--final"],
  );
  assert.equal(result.passed, false);
  assert.equal(result.source_unchanged, false);
  assert.equal(result.records[1].reason, "source_changed");
});
test("missing executables fail and owned long-running children are cleaned up", async (t) => {
  const proc = processes(fixture(t));
  t.after(() => proc.close());
  const missing = await proc.run("/definitely/absent/atlas-command", []);
  assert.notEqual(missing.code, 0);
  const live = proc.start(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  await proc.close();
  await live.done;
  assert.throws(() => process.kill(live.child.pid, 0), { code: "ESRCH" });
});

// WEB-08d revision 28: the held-operation runner gives its children a frozen environment and its execution snapshot's directory (both
// read at each start); without the option every child still gets this process's environment and the fixed root.
// Revision 29 (review r28 R28-N2): `output` is the merged log, so the child's record travels in its own exclusively written file
// and the log only has to keep the launcher's lines. The child writes one deterministic warning before and one after its record,
// whatever the host's proxy mode, and a missing record, a malformed one or a non-zero exit still fails.
const INHERITANCE_WARNING =
  "(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.";
async function inheritanceRecord(proc, file) {
  const print = `const w=(s)=>process.stderr.write(s+"\\n");w(${JSON.stringify(`${INHERITANCE_WARNING} (before)`)});require("node:fs").writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),inherited:process.env.ATLAS_PROCESSES_INHERITED??null,base:process.env.ATLAS_PROCESSES_BASE??null,call:process.env.ATLAS_PROCESSES_CALL??null}),{flag:"wx"});w(${JSON.stringify(`${INHERITANCE_WARNING} (after)`)});`;
  const result = await proc.run(process.execPath, ["-e", print, file], {
    ATLAS_PROCESSES_CALL: "call",
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null, result.output);
  for (const when of ["before", "after"])
    assert.ok(
      result.output.includes(`${INHERITANCE_WARNING} (${when})`),
      `the merged log keeps the child's warning (${when}): ${result.output}`,
    );
  return JSON.parse(readFileSync(file, "utf8"));
}
test("processes() keeps the inherited environment by default and uses a given base environment and root instead", async (t) => {
  const root = fixture(t);
  const other = mkdtempSync(join(tmpdir(), "atlas-processes-root-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const records = mkdtempSync(join(tmpdir(), "atlas-processes-records-"));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  const had = Object.hasOwn(process.env, "ATLAS_PROCESSES_INHERITED");
  const previous = process.env.ATLAS_PROCESSES_INHERITED;
  process.env.ATLAS_PROCESSES_INHERITED = "inherited";
  t.after(() => {
    if (had) process.env.ATLAS_PROCESSES_INHERITED = previous;
    else delete process.env.ATLAS_PROCESSES_INHERITED;
  });
  const plain = processes(root);
  t.after(() => plain.close());
  const a = await inheritanceRecord(plain, join(records, "inherited.json"));
  assert.deepEqual(a, {
    cwd: realpathSync(root),
    inherited: "inherited",
    base: null,
    call: "call",
  });
  let dir = root;
  const frozen = processes(() => dir, {
    env: () => ({ PATH: process.env.PATH, ATLAS_PROCESSES_BASE: "base" }),
  });
  t.after(() => frozen.close());
  dir = other;
  const b = await inheritanceRecord(frozen, join(records, "frozen.json"));
  assert.deepEqual(b, {
    cwd: realpathSync(other),
    inherited: null,
    base: "base",
    call: "call",
  });
});
// The record's framing is not a log filter: a child that writes nothing, writes a malformed record or exits non-zero after a valid
// one is still a failure of this helper.
test("the environment record helper refuses a missing, malformed or failed child record", async (t) => {
  const records = mkdtempSync(join(tmpdir(), "atlas-processes-records-"));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  const proc = processes(records);
  t.after(() => proc.close());
  const fake = (body) => ({
    run: (command, args, env) =>
      proc.run(command, ["-e", body, ...args.slice(2)], env),
  });
  const warn = (when) =>
    `process.stderr.write(${JSON.stringify(`${INHERITANCE_WARNING} (${when})\n`)});`;
  await assert.rejects(
    inheritanceRecord(
      fake(`${warn("before")}${warn("after")}`),
      join(records, "missing.json"),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    inheritanceRecord(
      fake(
        `${warn("before")}require("node:fs").writeFileSync(process.argv[1],"{");${warn("after")}`,
      ),
      join(records, "malformed.json"),
    ),
    SyntaxError,
  );
  await assert.rejects(
    inheritanceRecord(
      fake(
        `${warn("before")}require("node:fs").writeFileSync(process.argv[1],"{}");${warn("after")}process.exit(3)`,
      ),
      join(records, "failed.json"),
    ),
    assert.AssertionError,
  );
});
test("a valid assertion cannot conceal an unrelated runtime timeout", () => {
  const mixed = report("failed", "Error: expect(x)");
  mixed.suites[0].specs.push({
    title: "another case",
    tests: [
      {
        projectName: "fixture-chromium",
        expectedStatus: "passed",
        results: [
          { status: "timedOut", errors: [{ message: "Test timeout" }] },
        ],
      },
    ],
  });
  assert.equal(
    classifyMutant(
      { expect: /required assertion/ },
      inspectReport(mixed, browsers, 1),
      browsers,
    ).caught,
    false,
  );
});
test("timing-sensitive jobs are isolated by barriers even when jobs is two", async () => {
  const { isolatedPool } = await import("./runtime.mjs");
  const active = new Set();
  let peak = 0;
  const results = await isolatedPool(
    ["fast1", "fast2", "sensitive", "fast3", "fast4"],
    2,
    (item) => item.startsWith("fast"),
    async (item) => {
      if (item === "sensitive") assert.equal(active.size, 0);
      if (item.startsWith("fast")) assert.equal(active.has("sensitive"), false);
      active.add(item);
      peak = Math.max(peak, active.size);
      await new Promise((r) => setTimeout(r, 10));
      active.delete(item);
      return item;
    },
  );
  assert.equal(peak, 2);
  assert.equal(results.length, 5);
});
// `processes()` deliberately merges stdout and stderr into one `output`, and a
// launcher may add its own lines to either (Node's experimental-feature warnings
// when an environment proxy is enabled, for one). A record that a test needs is
// therefore labelled and read by its label, never as "the whole output".
const DESCENDANT_RECORD = /^ATLAS_DESCENDANT_PID=(\d+)$/m;
const LEADER_WARNING =
  "(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.";
test("cleanup retains ownership of descendants after their leader exits", async (t) => {
  const proc = processes(fixture(t));
  // Registered before anything can fail: a failing assertion must not leave the
  // disposable descendant running (the hook runs whatever the test's outcome).
  t.after(() => proc.close());
  // The leader always writes a launcher warning to stderr first, so the control
  // does not depend on the environment the suite happens to run in.
  const leader = proc.start(process.execPath, [
    "-e",
    `const {spawn}=require('node:child_process');process.stderr.write(${JSON.stringify(`${LEADER_WARNING}\n`)});const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('ATLAS_DESCENDANT_PID='+c.pid);c.unref();`,
  ]);
  const result = await leader.done;
  assert.equal(result.code, 0, result.output);
  assert.ok(
    result.output.includes(LEADER_WARNING),
    `the merged output keeps the launcher's own line: ${result.output}`,
  );
  const record = DESCENDANT_RECORD.exec(result.output);
  assert.ok(record, `no labelled descendant record in: ${result.output}`);
  const descendant = Number(record[1]);
  assert.ok(descendant > 0);
  process.kill(descendant, 0);
  await proc.close();
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

test("the warning-bearing descendant test cleans up even when its assertion fails", (t) => {
  const dir = fixture(t);
  const filename = join(dir, "scripts/validation/runtime.test.mjs");
  const original = readFileSync(filename, "utf8");
  const anchor = "\n  process.kill(descendant, 0);";
  assert.equal(original.split(anchor).length, 2);
  const pidFile = join(dir, ".agtx/descendant.pid");
  let ownedPid;
  // Install the outer safety net before the deliberately failing subprocess.
  t.after(() => {
    const pid = ownedPid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  writeFileSync(
    filename,
    original.replace(
      anchor,
      `${anchor}\n  writeFileSync(${JSON.stringify(pidFile)}, String(descendant));\n  assert.fail('injected assertion failure after child exists');`,
    ),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-name-pattern=^cleanup retains ownership", filename],
    { cwd: dir, env, encoding: "utf8", timeout: 10000 },
  );
  if (existsSync(pidFile)) ownedPid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /injected assertion failure after child exists/);
  assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
  const pid = ownedPid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("interrupting a plan cannot produce a passing partial ledger", async (t) => {
  const { spawn } = await import("node:child_process");
  const dir = fixture(t);
  writeFileSync(
    join(dir, ".agtx/plan.json"),
    JSON.stringify({
      version: 2,
      qualification: {
        changed_files: [],
        no_changes_reason:
          "Driver orchestration regression; no product test inputs are changed",
      },
      steps: [
        step("slow", "focused", "setInterval(()=>{},1000)"),
        step("later", "final", "process.exit(0)"),
      ],
    }),
  );
  const child = spawn(
    process.execPath,
    ["scripts/run-validation.mjs", ".agtx/plan.json", "--final"],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let sent = false;
  child.stdout.on("data", (data) => {
    output += data;
    if (!sent && output.includes("slow: start")) {
      sent = true;
      setTimeout(() => child.kill("SIGINT"), 20);
    }
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timeout);
  assert.equal(code, 1);
  const path = /Validation evidence: (.+)/.exec(output)[1];
  const result = JSON.parse(readFileSync(join(path, "results.json"), "utf8"));
  assert.equal(result.passed, false);
  assert.equal(result.records[1].status, "not_run");
  const preserved = readFileSync(join(path, "results.json"), "utf8");
  assert.equal(
    executePlan(dir, [step("next", "focused", "process.exit(0)")]).passed,
    true,
  );
  assert.equal(readFileSync(join(path, "results.json"), "utf8"), preserved);
});

// WEB-08d revision 18 (design assessment DA-N1, Q9): every Playwright error of a case is judged on its own. Reports below follow the
// installed Playwright 1.63 JSON reporter (results[].errors[], one entry per error of the body, hooks and fixtures).
test("DA-N1: an intended assertion beside an unrelated error of the SAME case is not a catch, in either order", () => {
  const mutant = { expect: /required assertion/ };
  const EXPECT = "Error: expect(received).toBe(expected)";
  const TEARDOWN = "TypeError: independent teardown failure";
  const sameCase = (errors) => {
    const r = report("failed");
    for (const t of r.suites[0].specs[0].tests)
      t.results = [
        { status: "failed", errors: errors.map((message) => ({ message })) },
      ];
    return r;
  };
  // Positive controls: one assertion, and two assertions of the same case, in every engine.
  for (const errors of [[EXPECT], [EXPECT, EXPECT]]) {
    const v = classifyMutant(
      mutant,
      inspectReport(sameCase(errors), browsers, 1),
      browsers,
    );
    assert.equal(v.caught, true, errors.join(" | "));
    assert.equal(v.error_kinds.assertion, errors.length * browsers.length);
  }
  for (const errors of [
    [EXPECT, TEARDOWN],
    [TEARDOWN, EXPECT],
    [EXPECT, "Error: page.goto: net::ERR_CONNECTION_REFUSED"],
  ]) {
    const seen = inspectReport(sameCase(errors), browsers, 1);
    assert.ok(
      seen.cases.every((c) => c.kind === "error" && c.errors.length === 2),
      errors.join(" | "),
    );
    const v = classifyMutant(mutant, seen, browsers);
    assert.equal(v.caught, false, errors.join(" | "));
    assert.deepEqual(v.engines_with_expected_assertion, []);
    assert.deepEqual(
      v.engines_with_expected_assertion_observed.sort(),
      browsers.map((b) => `fixture-${b}`),
      "the assertion is kept as an observation",
    );
    assert.equal(v.error_kinds.error, browsers.length);
  }
  // Only one engine's case carries the extra error: still not a catch.
  const oneEngine = sameCase([EXPECT]);
  oneEngine.suites[0].specs[0].tests[2].results[0].errors.push({
    message: TEARDOWN,
  });
  assert.equal(
    classifyMutant(mutant, inspectReport(oneEngine, browsers, 1), browsers)
      .caught,
    false,
  );
  // A failed case with no error at all is not an assertion.
  assert.equal(
    classifyMutant(mutant, inspectReport(sameCase([]), browsers, 1), browsers)
      .caught,
    false,
  );
});

test("DA-N1: `error` is read only when a reporter gives no `errors` array, and a passing case that reports errors is damaged", () => {
  const legacy = report("failed");
  for (const t of legacy.suites[0].specs[0].tests)
    t.results = [
      { status: "failed", error: { message: "Error: expect(x).toBe(y)" } },
    ];
  const fallback = inspectReport(legacy, browsers, 1);
  assert.ok(
    fallback.cases.every(
      (c) => c.kind === "assertion" && c.errors.length === 1,
    ),
  );
  const both = report("failed");
  for (const t of both.suites[0].specs[0].tests)
    t.results = [
      {
        status: "failed",
        error: { message: "Error: expect(x).toBe(y)" },
        errors: [
          { message: "Error: expect(x).toBe(y)" },
          { message: "TypeError: teardown" },
        ],
      },
    ];
  const seen = inspectReport(both, browsers, 1);
  assert.ok(
    seen.cases.every((c) => c.errors.length === 2 && c.kind === "error"),
    "`error` is not a second copy",
  );
  const damaged = report("passed");
  damaged.suites[0].specs[0].tests[0].results[0].errors = [
    { message: "TypeError: late" },
  ];
  const d = inspectReport(damaged, browsers, 0);
  assert.equal(d.complete, false);
  assert.equal(d.controlOk, false);
});

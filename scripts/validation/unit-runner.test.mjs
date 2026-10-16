import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";

// WEB-08d revision 17 (review r16 H6/H7): the ACTUAL unit mutation runner (scripts/run-data-mutants.mjs, located beside this file so a
// disposable copy tests itself) over real catalogue entries, with only its `pnpm` child replaced. The stub asks this test, over a
// loopback connection, what to do: which Vitest report to write, how to end, and WHEN (a reply can be held), so every schedule below is
// a deterministic order of completions, not a sleep. These reports are labelled synthetic; they are protocol evidence for the runner's
// verdict and admission, not product-test or mutation-sensitivity evidence.
const base = resolve(import.meta.dirname, "../..");
// Every temporary folder and runner this file starts is removed or ended when the file finishes, whatever happened.
const temporary = [];
const running = new Set();
function owned(dir) {
  temporary.push(dir);
  return dir;
}
after(() => {
  for (const child of running) child.kill("SIGKILL");
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
const RUNNER = join(base, "scripts/run-data-mutants.mjs");
const SET = "tests/features/settings/session-labels.test.ts";
// The `expect` of each selected catalogue entry, as the name of the test written for it.
const NAMES = {
  "MU-1600": "a later MINOR value decodes to `unknown` itself",
  "MU-1601": "reads Atlas app on iOS",
  "MU-1602": "a null, absent or unusable label falls back",
  "MU-1604": "64 emoji (128 UTF-16 units) are accepted",
};
const ASSERT = "AssertionError: expected 'x' to be 'y' // Object.is equality";
const TYPE = "TypeError: deliberately simulated unrelated setup defect";

const STUB = `#!${process.execPath}
const net = require("node:net"), fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const at = args.findIndex((a) => a.startsWith("--outputFile="));
const out = args[at].slice("--outputFile=".length);
const files = args.slice(at + 1);
const id = process.env.ATLAS_MUTANT_DIR ? path.basename(process.env.ATLAS_MUTANT_DIR) : "control";
const socket = net.connect(Number(process.env.STUB_PORT), "127.0.0.1");
let buffer = "";
socket.on("connect", () => socket.write(JSON.stringify({ id, files, out, cwd: process.cwd(), dir: process.env.ATLAS_MUTANT_DIR ?? null, pid: process.pid }) + "\\n"));
socket.on("data", (chunk) => {
  buffer += chunk;
  const end = buffer.indexOf("\\n");
  if (end < 0) return;
  const a = JSON.parse(buffer.slice(0, end));
  for (const d of a.mkdirs ?? []) fs.mkdirSync(d, { recursive: true });
  if (typeof a.report === "string") fs.writeFileSync(out, a.report);
  else if (a.report) fs.writeFileSync(out, JSON.stringify(a.report));
  if (a.stdout) process.stdout.write(a.stdout);
  socket.end(() => (a.signal ? process.kill(process.pid, a.signal) : process.exit(a.code ?? 0)));
});
`;

/** A Vitest 5 JSON report for one launch: every selected file has a passing test, and the session-labels file has each test of NAMES. */
function report(launch, statuses = {}) {
  const tests = [];
  for (const file of launch.files) {
    tests.push([file, `${file} still loads`]);
    if (file === SET)
      for (const n of Object.values(NAMES)) tests.push([file, n]);
  }
  for (const [file, name, message] of statuses.extra ?? [])
    tests.push([file, name, message]);
  const all = tests.map(([file, fullName, message]) => {
    const m = message ?? statuses[fullName];
    return {
      file,
      fullName,
      status: m ? "failed" : "passed",
      // A test can report several messages (revision 18, H6a): an array is that test's whole `failureMessages`.
      failureMessages: m ? (Array.isArray(m) ? m : [m]) : [],
    };
  });
  const failed = all.filter((t) => t.status === "failed").length;
  return {
    numTotalTestSuites: launch.files.length,
    numTotalTests: all.length,
    numPassedTests: all.length - failed,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    success: failed === 0,
    startTime: 0,
    testResults: launch.files.map((f) => ({
      name: join(launch.cwd, f),
      status: all.some((t) => t.file === f && t.status === "failed")
        ? "failed"
        : "passed",
      message: "",
      startTime: 0,
      endTime: 0,
      assertionResults: all
        .filter((t) => t.file === f)
        .map(({ file: _f, ...t }) => t),
    })),
  };
}
const pass = (launch) => ({ report: report(launch), code: 0 });
/** The mutant's own test fails by an assertion (the healthy catch). */
const caught = (launch) => ({
  report: report(launch, { [NAMES[launch.id]]: ASSERT }),
  code: 1,
});

/** A deferred answer, released by the test. */
function later() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}

/**
 * Runs the real runner with the stub. `answer(launch)` returns (or resolves to) what the stub does. Returns the exit, output, every
 * launch in order, the ledger and helpers to wait for a launch or for output.
 */
function start({
  only,
  jobs = 1,
  answer,
  args = [],
  runner = RUNNER,
  cwd = base,
}) {
  const dir = owned(mkdtempSync(join(tmpdir(), "unit-runner-test-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), STUB, { mode: 0o755 });
  const launches = [];
  const waiters = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const launch = {
        ...JSON.parse(buffer.slice(0, end)),
        index: launches.length,
      };
      buffer = "";
      launches.push(launch);
      for (const w of [...waiters]) w();
      const reply = await answer(launch);
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => {});
  });
  const out = join(dir, "out");
  const listening = new Promise((r) => server.listen(0, "127.0.0.1", r));
  let stdout = "";
  let stderr = "";
  const outputWaiters = [];
  const done = listening.then(
    () =>
      new Promise((resolveRun) => {
        const child = spawn(
          process.execPath,
          [
            runner,
            ...(only ? ["--only", only.join(",")] : []),
            ...(jobs === null ? [] : ["--jobs", String(jobs)]),
            "--out",
            out,
            ...args,
          ],
          {
            cwd,
            env: {
              ...process.env,
              PATH: `${bin}:/usr/bin:/bin`,
              STUB_PORT: String(server.address().port),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        handle.child = child;
        running.add(child);
        child.on("close", () => running.delete(child));
        child.stdout.on("data", (d) => {
          stdout += d;
          for (const w of [...outputWaiters]) w();
        });
        child.stderr.on("data", (d) => {
          stderr += d;
          for (const w of [...outputWaiters]) w();
        });
        child.on("close", (code, signal) => {
          server.close();
          for (const s of sockets) s.destroy();
          const ledgerPath = join(out, "unit-results.json");
          const ledger = existsSync(ledgerPath)
            ? JSON.parse(readFileSync(ledgerPath, "utf8"))
            : null;
          resolveRun({
            code,
            signal,
            stdout,
            stderr,
            launches,
            ledger,
            out,
            dir,
          });
        });
      }),
  );
  const handle = {
    done,
    dir,
    out,
    launches,
    /** Resolves once `n` launches have connected. */
    launched: (n) =>
      new Promise((r) => {
        const check = () => {
          if (launches.length >= n) {
            waiters.splice(waiters.indexOf(check) >>> 0, 1);
            r();
          }
        };
        waiters.push(check);
        check();
      }),
    /** Resolves once the runner has written `text` to stdout or stderr. */
    said: (text) =>
      new Promise((r) => {
        const check = () => {
          if (stdout.includes(text) || stderr.includes(text)) {
            outputWaiters.splice(outputWaiters.indexOf(check) >>> 0, 1);
            r();
          }
        };
        outputWaiters.push(check);
        check();
      }),
  };
  return handle;
}
const ids = (r) => r.launches.map((l) => l.id);
/** The runner's ledger; its absence is an assertion failure (never a TypeError). */
function account(r) {
  assert.ok(
    r.ledger,
    `the runner wrote its account (exit ${r.code}): ${r.stderr.slice(-500)}`,
  );
  return r.ledger;
}
const cleanup = (r) => rmSync(r.dir, { recursive: true, force: true });

test("healthy control (serial): both controls, both mutants caught, exit 0, one complete account", {
  timeout: 60_000,
}, async () => {
  const r = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) => (l.id === "control" ? pass(l) : caught(l)),
  }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(r), ["control", "control", "MU-1600", "MU-1601"]);
  assert.equal(account(r).summary.passed, true);
  assert.equal(account(r).summary.partial, true);
  assert.deepEqual(account(r).summary.not_run, []);
  assert.equal(account(r).summary.caught, 2);
  assert.equal(account(r).summary.stopped, null);
  assert.deepEqual(
    account(r).summary.controls.map((c) => c.status),
    ["passed", "passed"],
  );
  for (const m of account(r).results) {
    assert.equal(m.status, "caught");
    assert.ok(
      existsSync(join(r.out, "work", m.id, "report.json")),
      "the raw report is kept",
    );
    assert.ok(
      existsSync(join(r.out, "work", m.id, "output.log")),
      "the child's whole output is kept",
    );
  }
  cleanup(r);
});

test("H7 Q3: the first control fails, so nothing else starts (one launch); every selected mutant is not run", {
  timeout: 60_000,
}, async () => {
  const r = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) => ({
      report: report(l, { [`${SET} still loads`]: ASSERT }),
      code: 1,
    }),
  }).done;
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ["control"]);
  assert.deepEqual(
    account(r).summary.controls.map((c) => c.status),
    ["failed", "not_run"],
  );
  assert.deepEqual(account(r).summary.not_run, ["MU-1600", "MU-1601"]);
  assert.match(account(r).summary.stopped.reason, /control 0 failed/);
  assert.equal(account(r).summary.passed, false);
  cleanup(r);
});

test("H7 Q3: a control that exits 0 without a sound report fails too (missing report, missing file, empty run)", {
  timeout: 60_000,
}, async () => {
  const variants = {
    "no report": () => ({ code: 0 }),
    "a selected file missing": (l) => ({
      report: report({
        ...l,
        files: ["tests/features/settings/other.test.ts"],
      }),
      code: 0,
    }),
    "no test at all": (l) => ({
      report: {
        ...report(l),
        numTotalTests: 0,
        numPassedTests: 0,
        testResults: [],
      },
      code: 0,
    }),
  };
  for (const [name, bad] of Object.entries(variants)) {
    const r = await start({
      only: ["MU-1601", "MU-1600"],
      answer: (l) => bad(l),
    }).done;
    assert.equal(r.code, 1, name);
    assert.deepEqual(ids(r), ["control"], name);
    assert.equal(account(r).summary.controls[0].status, "failed", name);
    cleanup(r);
  }
});

test("H7 Q4: a survivor, a wrong assertion or a mixed failure stops admission: the second mutant never starts", {
  timeout: 60_000,
}, async () => {
  const variants = {
    survived: [(l) => pass(l), "survived"],
    "wrong test": [
      (l) => ({ report: report(l, { [NAMES["MU-1601"]]: ASSERT }), code: 1 }),
      "wrong_test",
    ],
    "H6 mixed error": [
      (l) => ({
        report: report(l, {
          [NAMES["MU-1600"]]: ASSERT,
          extra: [[SET, "independent fixture preparation", TYPE]],
        }),
        code: 1,
      }),
      "invalid",
    ],
    "H6 mixed timeout": [
      (l) => ({
        report: report(l, {
          [NAMES["MU-1600"]]: ASSERT,
          [NAMES["MU-1602"]]: "Error: Test timed out in 5000ms.",
        }),
        code: 1,
      }),
      "invalid",
    ],
    "H6 unhandled error": [
      (l) => ({
        report: report(l, { [NAMES["MU-1600"]]: ASSERT }),
        code: 1,
        stdout: "Vitest caught 1 unhandled error during the test run.\n",
      }),
      "invalid",
    ],
    "H6 signal": [() => ({ signal: "SIGKILL" }), "invalid"],
    "H6 damaged report": [() => ({ report: "{", code: 1 }), "invalid"],
    // Review r17 H6a: the unexpected failure is a second message of the INTENDED test itself, in either order.
    "H6a same-test error after the assertion": [
      (l) => ({
        report: report(l, {
          [NAMES["MU-1600"]]: [
            ASSERT,
            "TypeError: independent teardown failure",
          ],
        }),
        code: 1,
      }),
      "invalid",
    ],
    "H6a same-test error before the assertion": [
      (l) => ({
        report: report(l, {
          [NAMES["MU-1600"]]: [
            "TypeError: independent teardown failure",
            ASSERT,
          ],
        }),
        code: 1,
      }),
      "invalid",
    ],
    "H6a same-test hook timeout": [
      (l) => ({
        report: report(l, {
          [NAMES["MU-1600"]]: [ASSERT, "Error: Hook timed out in 10000ms."],
        }),
        code: 1,
      }),
      "invalid",
    ],
  };
  for (const [name, [first, status]] of Object.entries(variants)) {
    // The healthy control with an extra test proves the "independent" test exists in the inventory; here it is only on the mutant, so
    // the inventory check is not what fails it: the TypeError is.
    const r = await start({
      only: ["MU-1600", "MU-1601"],
      answer: (l) =>
        l.id === "control"
          ? pass(l)
          : l.id === "MU-1600"
            ? first(l)
            : caught(l),
    }).done;
    assert.equal(r.code, 1, name);
    assert.deepEqual(
      ids(r),
      ["control", "control", "MU-1600"],
      `${name}: MU-1601 must not start`,
    );
    const a = account(r).results.find((m) => m.id === "MU-1600");
    assert.equal(a.status, status, name);
    assert.equal(a.caught, false, name);
    assert.deepEqual(account(r).summary.not_run, ["MU-1601"], name);
    assert.match(
      account(r).summary.stopped.reason,
      new RegExp(`MU-1600 is ${status}`),
      name,
    );
    if (name.startsWith("H6 mixed") || name.startsWith("H6a")) {
      assert.equal(
        a.expected_assertion_observed,
        true,
        `${name}: the expected assertion is kept as an observation`,
      );
      assert.deepEqual(
        account(r).summary.expected_assertion_with_unexpected_failures,
        ["MU-1600"],
      );
      assert.ok(
        a.unexpected.length === 1 && a.failures.length === 2,
        `${name}: every failure message is kept`,
      );
      // Tests and messages are counted apart: the same-test cells have ONE failed test with two messages.
      assert.equal(a.failedCount, name.startsWith("H6a") ? 1 : 2, name);
      assert.equal(a.messageCount, 2, name);
      assert.equal(a.kinds.assertion, 1, name);
      assert.equal(
        a.unexpected[0].kind,
        name.includes("timeout") ? "timeout" : "error",
        name,
      );
    }
    cleanup(r);
  }
});

test("H7 Q5 (jobs 2): A fails while B is held; C never starts; B settles and keeps its own result", {
  timeout: 60_000,
}, async () => {
  for (const order of [
    "A fails first",
    "B fails first",
    "A fails, then B fails late",
    "A fails by a same-test error first",
  ]) {
    const held = { "MU-1600": later(), "MU-1602": later() };
    const h = start({
      only: ["MU-1600", "MU-1602", "MU-1604"],
      jobs: 2,
      answer: (l) =>
        l.id === "control"
          ? pass(l)
          : held[l.id]
            ? held[l.id].promise
            : caught(l),
    });
    await h.launched(3); // the control, then A and B together
    assert.deepEqual(h.launches.map((l) => l.id).sort(), [
      "MU-1600",
      "MU-1602",
      "control",
    ]);
    const [first, second] =
      order === "B fails first"
        ? ["MU-1602", "MU-1600"]
        : ["MU-1600", "MU-1602"];
    const failure = (id) => ({
      report: report(
        h.launches.find((l) => l.id === id),
        order === "A fails by a same-test error first"
          ? { [NAMES[id]]: [ASSERT, TYPE] }
          : {
              [NAMES[id]]: ASSERT,
              extra: [[SET, "independent fixture preparation", TYPE]],
            },
      ),
      code: 1,
    });
    held[first].release(failure(first));
    // The latch is set before the other mutant answers. Without it, the third mutant starts or the runner ends instead: either is
    // observed by the assertions below, never waited out.
    await Promise.race([h.said("STOPPING"), h.launched(4), h.done]);
    held[second].release(
      order === "A fails, then B fails late"
        ? failure(second)
        : caught(h.launches.find((l) => l.id === second)),
    );
    const r = await h.done;
    assert.equal(r.code, 1, order);
    assert.ok(!ids(r).includes("MU-1604"), `${order}: C must never start`);
    assert.deepEqual(account(r).summary.not_run, ["MU-1604"], order);
    const status = (id) => account(r).results.find((m) => m.id === id).status;
    assert.equal(status(first), "invalid", order);
    assert.equal(
      status(second),
      order === "A fails, then B fails late" ? "invalid" : "caught",
      `${order}: B keeps its own result`,
    );
    assert.match(
      account(r).summary.stopped.reason,
      new RegExp(`${first} is invalid`),
      `${order}: a later success never clears the first failure`,
    );
    cleanup(r);
  }
});

test("Q5 healthy control (jobs 2): A, B and C all start and are caught; exit 0", {
  timeout: 60_000,
}, async () => {
  const r = await start({
    only: ["MU-1600", "MU-1602", "MU-1604"],
    jobs: 2,
    answer: (l) => (l.id === "control" ? pass(l) : caught(l)),
  }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(r).slice(1).sort(), ["MU-1600", "MU-1602", "MU-1604"]);
  assert.equal(account(r).summary.states.caught, 3);
  cleanup(r);
});

test("Q6: a command that does not start, an output or report that cannot be kept, and a ledger that cannot be written all fail", {
  timeout: 60_000,
}, async () => {
  // No pnpm at all: the control's spawn fails; recorded, nothing else starts.
  const missing = owned(mkdtempSync(join(tmpdir(), "unit-runner-test-")));
  const out = join(missing, "out");
  const spawnFail = await new Promise((r) => {
    const child = spawn(
      process.execPath,
      [RUNNER, "--only", "MU-1600", "--jobs", "1", "--out", out],
      {
        cwd: base,
        env: { ...process.env, PATH: join(missing, "empty") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.on("close", (code) => r(code));
  });
  assert.equal(spawnFail, 1);
  assert.ok(
    existsSync(join(out, "unit-results.json")),
    "the account is written",
  );
  const ledger = JSON.parse(
    readFileSync(join(out, "unit-results.json"), "utf8"),
  );
  assert.match(ledger.summary.controls[0].problems.join(" "), /did not start/);
  assert.deepEqual(ledger.summary.not_run, ["MU-1600"]);
  rmSync(missing, { recursive: true, force: true });

  // The mutant's output cannot be kept (its path is a directory): a failure, latched; the next mutant does not start.
  const log = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) =>
      l.id === "control"
        ? pass(l)
        : { ...caught(l), mkdirs: [join(l.dir, "output.log")] },
  }).done;
  assert.equal(log.code, 1);
  assert.deepEqual(ids(log), ["control", "control", "MU-1600"]);
  assert.match(account(log).summary.stopped.reason, /could not keep/);
  cleanup(log);

  // The report path is a directory (unreadable): invalid, not a catch.
  const unreadable = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) =>
      l.id === "control" ? pass(l) : { code: 1, mkdirs: [l.out] },
  }).done;
  assert.equal(unreadable.code, 1);
  assert.equal(account(unreadable).results[0].status, "invalid");
  assert.match(
    account(unreadable).results[0].problems.join(" "),
    /could not be read/,
  );
  cleanup(unreadable);

  // The ledger cannot be written: exit 1 even though every mutant was caught.
  const ledgerFail = await start({
    only: ["MU-1600"],
    answer: (l) =>
      l.id === "control"
        ? pass(l)
        : {
            ...caught(l),
            mkdirs: [join(l.dir, "..", "..", "unit-results.json.partial")],
          },
  }).done;
  assert.equal(ledgerFail.code, 1);
  assert.equal(ledgerFail.ledger, null);
  assert.match(ledgerFail.stderr, /ledger could not be written/);
  cleanup(ledgerFail);
});

test("Q6: an interruption stops admission, ends the running child, and still writes the account", {
  timeout: 60_000,
}, async () => {
  const hold = later();
  const h = start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) => (l.id === "control" ? pass(l) : hold.promise),
  });
  await h.launched(3);
  h.child.kill("SIGTERM");
  const r = await h.done;
  hold.release({ code: 0 });
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ["control", "control", "MU-1600"]);
  assert.match(account(r).summary.stopped.reason, /interrupted by SIGTERM/);
  assert.equal(account(r).results[0].status, "invalid");
  assert.deepEqual(account(r).summary.not_run, ["MU-1601"]);
  cleanup(r);
});

test("Q3/Q15: a selection or destination that cannot run is refused before anything starts, and earlier evidence is never overwritten", {
  timeout: 60_000,
}, async () => {
  for (const args of [
    ["--jobs", "0"],
    ["--jobs", "1.5"],
    ["--only", "MU-9999"],
    ["--only", "MU-1600,MU-1600"],
    ["--only", ""],
    ["--bogus"],
  ]) {
    const r = await start({ jobs: null, answer: pass, args }).done;
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(r.launches, [], args.join(" "));
    cleanup(r);
  }
  const first = await start({
    only: ["MU-1600"],
    answer: (l) => (l.id === "control" ? pass(l) : caught(l)),
  }).done;
  assert.equal(first.code, 0);
  const before = readFileSync(join(first.out, "unit-results.json"), "utf8");
  const again = await new Promise((r) => {
    const child = spawn(
      process.execPath,
      [RUNNER, "--only", "MU-1600", "--out", first.out],
      { cwd: base, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => r({ code, err }));
  });
  assert.equal(again.code, 2);
  assert.match(again.err, /never overwritten/);
  assert.equal(
    readFileSync(join(first.out, "unit-results.json"), "utf8"),
    before,
  );
  cleanup(first);
});

test("H7 Q3: a patch that does not apply stops the run before any control; the rest of the selection is not run", {
  timeout: 60_000,
}, async () => {
  // A disposable tree: this runner and its modules, with MU-1600's source lacking its anchor (MU-1625's file is the real one).
  const tree = owned(mkdtempSync(join(tmpdir(), "unit-runner-tree-")));
  for (const f of [
    "scripts/run-data-mutants.mjs",
    "scripts/mutation/data-catalogue.mjs",
    "scripts/mutation/attributed-errors.mjs",
    "scripts/validation/unit-results.mjs",
  ])
    cpSync(join(base, f), join(tree, f));
  const { UNIT } = await import("../mutation/data-catalogue.mjs");
  const [a, b] = ["MU-1600", "MU-1625"].map((id) =>
    UNIT.find((m) => m.id === id),
  );
  assert.notEqual(a.file, b.file);
  mkdirSync(dirname(join(tree, a.file)), { recursive: true });
  writeFileSync(
    join(tree, a.file),
    "// the code this mutant targets is gone\n",
  );
  mkdirSync(dirname(join(tree, b.file)), { recursive: true });
  cpSync(join(base, b.file), join(tree, b.file));
  const r = await start({
    only: ["MU-1600", "MU-1625"],
    runner: join(tree, "scripts/run-data-mutants.mjs"),
    cwd: tree,
    answer: (l) => (l.id === "control" ? pass(l) : caught(l)),
  }).done;
  assert.equal(r.code, 1);
  assert.deepEqual(
    r.launches,
    [],
    "no control or mutant starts after a patch failure",
  );
  assert.deepEqual(
    account(r).summary.patch_failures.map((p) => p.id),
    ["MU-1600"],
  );
  assert.deepEqual(account(r).summary.not_run, ["MU-1625"]);
  assert.deepEqual(
    account(r).summary.controls.map((c) => c.status),
    ["not_run", "not_run"],
  );
  assert.match(
    account(r).summary.stopped.reason,
    /patch of MU-1600 does not apply/,
  );
  assert.equal(
    existsSync(join(r.out, "work", "MU-1625")),
    false,
    "the later patch is not even applied",
  );
  cleanup(r);
  rmSync(tree, { recursive: true, force: true });
});

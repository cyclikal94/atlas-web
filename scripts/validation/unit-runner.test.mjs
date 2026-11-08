import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  currentAdapter,
  ENVELOPE_SCHEMA,
  OCCURRENCE_KEY,
  ORIGIN_SCHEMA,
  PINNED_VITEST,
  project,
  REQUEST_SCHEMA,
} from "../mutation/vitest-evidence.mjs";

// WEB-08d revision 17 (review r16 H6/H7): the ACTUAL unit mutation runner (scripts/run-data-mutants.mjs, located beside this file so a
// disposable copy tests itself) over real catalogue entries, with only its child replaced. The stub asks this test, over a loopback
// connection, what to do: which evidence to write, how to end, and WHEN (a reply can be held), so every schedule below is a
// deterministic order of completions, not a sleep. This evidence is labelled synthetic; it is protocol evidence for the runner's
// verdict and admission, not product-test or mutation-sensitivity evidence.
//
// WEB-14a revision 41 (review r40 R40-TOOLS, family `unit-runner-supervisor-control-boundary`): since WEB-14a revision 27 the runner's
// child is not `pnpm` but the supervised child `node scripts/mutation/vitest-supervised.mjs <request.json>` (scripts/mutation/
// unit-runner.mjs), judged only from its nonce-bound envelope and JSON report, so the earlier `pnpm` stub was never started. Every run
// below is a disposable copy of the runner whose `vitest-supervised.mjs` is the stub: it reads the runner's request, asks this test, and
// writes exactly the report and envelope it is handed (built here to the contract of scripts/mutation/vitest-evidence.mjs: the request's
// nonce and label, the adapter digest, and the per-occurrence receipt the worker attaches to a completed comparison), then ends as told.
// The real supervised child and Vitest are qualified separately (scripts/mutation/vitest-evidence.test.mjs and real control/mutant
// runs). Assertions on the earlier runner's account are mapped to this runner's, each marked `adapted (r41)`, with the old one named.
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
const SET = "tests/features/settings/session-labels.test.ts";
const LABELS = "src/features/settings/sessions-devices/labels.ts";
// The `expect` of each selected catalogue entry, as the name of the test written for it.
const NAMES = {
  "MU-1600": "a later MINOR value decodes to `unknown` itself",
  "MU-1601": "reads Atlas app on iOS",
  "MU-1602": "a null, absent or unusable label falls back",
  "MU-1604": "64 emoji (128 UTF-16 units) are accepted",
};
const ASSERT = "AssertionError: expected 'x' to be 'y' // Object.is equality";
const TYPE = "TypeError: deliberately simulated unrelated setup defect";
const ADAPTER = currentAdapter();

// The stand-in for scripts/mutation/vitest-supervised.mjs, at the path the runner starts.
const STUB = `#!/usr/bin/env node
// Synthetic supervised child (scripts/validation/unit-runner.test.mjs): reports the runner's request, writes what it is handed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
const requestPath = process.argv[2];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const dir = process.env.ATLAS_MUTANT_DIR ?? null;
const put = (path, value) => {
  if (typeof value === "string") writeFileSync(path, value);
  else if (value) writeFileSync(path, JSON.stringify(value));
};
let answered = false;
let buffer = "";
const socket = connect(Number(process.env.STUB_PORT), "127.0.0.1");
socket.on("connect", () => socket.write(JSON.stringify({ id: dir ? basename(dir) : "control", argv: process.argv.slice(1), requestPath, request, cwd: process.cwd(), dir, pid: process.pid }) + "\\n"));
socket.on("data", (chunk) => {
  buffer += chunk;
  const end = buffer.indexOf("\\n");
  if (end < 0 || answered) return;
  answered = true;
  const a = JSON.parse(buffer.slice(0, end));
  for (const d of a.mkdirs ?? []) mkdirSync(d, { recursive: true });
  put(request.json, a.report);
  put(request.envelope, a.envelope);
  if (a.stdout) process.stdout.write(a.stdout);
  socket.end(() => (a.signal ? process.kill(process.pid, a.signal) : process.exit(a.code ?? 0)));
});
// Owned cleanup: a stub whose test went away ends instead of waiting for an answer.
socket.on("close", () => {
  if (!answered) process.exit(70);
});
socket.on("error", () => process.exit(70));
`;

/**
 * A disposable copy of the runner (its CLI, the inventory checks and every mutation module) whose supervised child is the stub, with
 * `sources` copied from this tree and `edit` written over them.
 */
function runnerTree({ sources = [LABELS], edit = {} } = {}) {
  const tree = owned(mkdtempSync(join(tmpdir(), "unit-runner-tree-")));
  const copy = (f) => {
    mkdirSync(dirname(join(tree, f)), { recursive: true });
    cpSync(join(base, f), join(tree, f));
  };
  for (const f of [
    "scripts/run-data-mutants.mjs",
    "scripts/lib/mutation-inventory.mjs",
  ])
    copy(f);
  cpSync(join(base, "scripts/mutation"), join(tree, "scripts/mutation"), {
    recursive: true,
  });
  writeFileSync(join(tree, "scripts/mutation/vitest-supervised.mjs"), STUB, {
    mode: 0o755,
  });
  for (const f of sources) copy(f);
  for (const [f, text] of Object.entries(edit)) {
    mkdirSync(dirname(join(tree, f)), { recursive: true });
    writeFileSync(join(tree, f), text);
  }
  return tree;
}

/** One projected failure message, as the supervised child records it (scripts/mutation/vitest-evidence.mjs `project`). */
function errorOf(text, { nonce, test, occurrence }) {
  const colon = text.indexOf(": ");
  const name = colon > 0 ? text.slice(0, colon) : "Error";
  const message = colon > 0 ? text.slice(colon + 2) : text;
  // `AssertionError: …` is a completed comparison of THIS test, with the worker's receipt; a `… timed out …` message is a time-out by
  // its text; anything else has no assertion origin (an error).
  const receipt =
    name === "AssertionError"
      ? {
          schema: ORIGIN_SCHEMA,
          nonce,
          adapter: ADAPTER,
          site: "chai.Assertion#assert",
          role: "comparison",
          invocation: 7,
          framed: true,
          root: 1,
          test,
          current: test,
          phase: "body",
          attempt: 1,
          concurrent: false,
        }
      : null;
  return project({
    name,
    message,
    stack: text,
    [OCCURRENCE_KEY]: {
      schema: ORIGIN_SCHEMA,
      nonce,
      adapter: ADAPTER,
      id: occurrence,
      test,
      phase: "body",
      attempt: 1,
      concurrent: false,
      opaque: [],
      complete: true,
      path: [],
      receipt,
      edges: receipt ? [{ invocation: 7, kind: "sync" }] : [],
    },
  });
}

/**
 * The JSON report and terminal envelope of one launch: every file (`files`, by default the request's) has a passing test, and the
 * session-labels file has each test of NAMES. `statuses` maps a test name to its failure message(s); `extra` adds failing tests;
 * `unhandled` counts unhandled errors beside the tests. `code` is the exit code the envelope records (and the stub exits with).
 */
function evidence(launch, statuses = {}, { code, unhandled = 0, files } = {}) {
  const { nonce, label } = launch.request;
  const cases = [];
  for (const file of files ?? launch.request.files) {
    cases.push([file, `${file} still loads`]);
    if (file === SET)
      for (const n of Object.values(NAMES)) cases.push([file, n]);
  }
  for (const [file, name, message] of statuses.extra ?? [])
    cases.push([file, name, message]);
  let occurrence = 0;
  const tests = cases.map(([file, name, message], index) => {
    const m = message ?? statuses[name];
    // A test can report several messages (revision 18, H6a): an array is that test's whole list of failures.
    const messages = m ? (Array.isArray(m) ? m : [m]) : [];
    const id = `${label}_${index}`;
    const errors = messages.map((text) => {
      occurrence += 1;
      return errorOf(text, { nonce, test: id, occurrence });
    });
    return {
      id,
      module: file,
      moduleId: join(launch.cwd, file),
      ancestors: [],
      name,
      state: errors.length > 0 ? "failed" : "passed",
      fails: false,
      ms: 1,
      errorCount: errors.length,
      errors,
      messages,
    };
  });
  const moduleFiles = [...new Set(tests.map((t) => t.module))];
  const failed = tests.some((t) => t.state === "failed");
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    nonce,
    label,
    vitest: PINNED_VITEST,
    supported: true,
    unsupported: [],
    witness: {
      onTestRunEndCalls: 1,
      reason: failed ? "failed" : "passed",
      modules: moduleFiles.map((file) => ({
        id: file,
        state: tests.some((t) => t.module === file && t.state === "failed")
          ? "failed"
          : "passed",
        errorCount: 0,
        errors: [],
        health: {
          schema: ORIGIN_SCHEMA,
          nonce,
          adapter: ADAPTER,
          failures: [],
          depth: 0,
          invocations: occurrence,
          occurrences: occurrence,
          issued: Object.fromEntries(
            tests
              .filter((t) => t.module === file)
              .map((t) => [t.id, t.errors.map((e) => e.occurrence.id)]),
          ),
        },
      })),
      suites: [],
      tests: tests.map(({ messages: _m, ...t }) => t),
      unhandledCount: unhandled,
      unhandled: Array.from({ length: unhandled }, () =>
        project(new Error("synthetic unhandled error")),
      ),
      failureCount: 0,
      failures: [],
    },
    lateUnhandledCount: 0,
    lateUnhandled: [],
    logged: { count: 0, calls: [] },
    processEvents: { count: 0, events: [] },
    startError: null,
    closeError: null,
    closeTimedOut: false,
    origin: {
      schema: ORIGIN_SCHEMA,
      adapter: ADAPTER,
      projects: [
        {
          name: "",
          setupFiles: [
            join(launch.cwd, "scripts/mutation/vitest-origin-setup.mjs"),
          ],
          pool: "forks",
        },
      ],
      installed: true,
    },
    exitCode: code,
    complete: true,
  };
  const failedCount = tests.filter((t) => t.state === "failed").length;
  const report = {
    numTotalTestSuites: moduleFiles.length,
    numTotalTests: tests.length,
    numPassedTests: tests.length - failedCount,
    numFailedTests: failedCount,
    numPendingTests: 0,
    numTodoTests: 0,
    success: failedCount === 0,
    startTime: 0,
    testResults: moduleFiles.map((file) => ({
      name: join(launch.cwd, file),
      status: tests.some((t) => t.module === file && t.state === "failed")
        ? "failed"
        : "passed",
      message: "",
      startTime: 0,
      endTime: 0,
      assertionResults: tests
        .filter((t) => t.module === file)
        .map((t) => ({
          ancestorTitles: [],
          title: t.name,
          fullName: t.name,
          status: t.state,
          failureMessages: t.messages,
        })),
    })),
  };
  return { report, envelope };
}
/** A complete answer: the evidence of `statuses`, and the same exit code. */
const ending = (launch, statuses, code, options = {}) => ({
  ...evidence(launch, statuses, { code, ...options }),
  code,
});
const pass = (launch) => ending(launch, {}, 0);
/** The mutant's own test fails by an assertion (the healthy catch). */
const caught = (launch) => ending(launch, { [NAMES[launch.id]]: ASSERT }, 1);

/** A deferred answer, released by the test. */
function later() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}

/**
 * Runs the runner of `tree` (a fresh runner tree by default) with the stub. `answer(launch)` returns (or resolves to) what the stub
 * does. Returns the exit, output, every launch in order, the ledger and helpers to wait for a launch or for output.
 */
function start({ only, jobs = 1, answer, args = [], tree = runnerTree() }) {
  const dir = owned(mkdtempSync(join(tmpdir(), "unit-runner-test-")));
  const runner = join(tree, "scripts/run-data-mutants.mjs");
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
            cwd: tree,
            env: {
              ...process.env,
              // The runner starts its supervised child by its own Node binary, never by a command on PATH.
              PATH: "/usr/bin:/bin",
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
          const ledger =
            existsSync(ledgerPath) && statSync(ledgerPath).isFile()
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
            tree,
          });
        });
      }),
  );
  const handle = {
    done,
    dir,
    out,
    tree,
    launches,
    /**
     * Resolves once `n` launches have connected, or once the runner has ended without them (revision 41: the caller's assertions on
     * `launches` then fail, instead of a wait that outlives the run and cancels every later test of the file).
     */
    launched: (n) =>
      Promise.race([
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
        done,
      ]),
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
const result = (r, id) => account(r).results.find((m) => m.id === id);
const cleanup = (r) => {
  rmSync(r.dir, { recursive: true, force: true });
  rmSync(r.tree, { recursive: true, force: true });
};

test("healthy control (serial): both controls, both mutants caught, exit 0, one complete account", {
  timeout: 60_000,
}, async () => {
  const r = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) => (l.id === "control" ? pass(l) : caught(l)),
  }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ids(r), ["control", "control", "MU-1600", "MU-1601"]);
  // adapted (r41): each launch is the supervised child of THIS runner over its own request (was: `pnpm exec vitest` arguments).
  const supervisor = realpathSync(
    join(r.tree, "scripts/mutation/vitest-supervised.mjs"),
  );
  assert.deepEqual(
    r.launches.map((l) => l.request.label),
    ["control-0", "control-1", "MU-1600", "MU-1601"],
  );
  for (const l of r.launches) {
    assert.equal(realpathSync(l.argv[0]), supervisor);
    assert.deepEqual(l.argv.slice(1), [l.requestPath]);
    assert.equal(l.request.schema, REQUEST_SCHEMA);
    assert.equal(realpathSync(l.request.root), realpathSync(r.tree));
  }
  assert.deepEqual(
    r.launches.map((l) => l.request.files),
    [
      [SET],
      [SET, "tests/features/settings/labels-contract.test.ts"],
      [SET],
      [SET, "tests/features/settings/labels-contract.test.ts"],
    ],
  );
  const a = account(r);
  // adapted (r41): `summary.passed` is this runner's exit 0 with no failure, stop or unpassed control; `summary.partial` is a
  // selection's account: 2 selected, not the catalogue's expected count.
  assert.deepEqual(a.summary.failures, []);
  assert.equal(a.summary.selected, 2);
  assert.ok(a.summary.expected_unit_mutants > 2);
  assert.deepEqual(a.summary.not_run, []);
  assert.equal(a.summary.caught, 2);
  assert.equal(a.summary.stopped, null);
  // adapted (r41): a control's `status` "passed" is its `verdict` "pass".
  assert.deepEqual(
    a.summary.controls.map((c) => [c.verdict, c.passed]),
    [
      ["pass", true],
      ["pass", true],
    ],
  );
  for (const [label, launch] of [
    ["control-0", r.launches[0]],
    ["control-1", r.launches[1]],
    ["MU-1600", r.launches[2]],
    ["MU-1601", r.launches[3]],
  ]) {
    const work = join(r.out, "work", label);
    assert.ok(existsSync(join(work, "report.json")), "the raw report is kept");
    assert.ok(
      existsSync(join(work, "output.log")),
      "the child's whole output is kept",
    );
    // adapted (r41): the supervised evidence is kept too: the request and the envelope that answers it.
    assert.equal(
      realpathSync(launch.requestPath),
      join(realpathSync(work), "request.json"),
    );
    const envelope = JSON.parse(
      readFileSync(join(work, "envelope.json"), "utf8"),
    );
    assert.equal(envelope.nonce, launch.request.nonce);
    assert.equal(envelope.label, label);
  }
  // adapted (r41): a mutant's `status` "caught" is its `verdict` "caught".
  for (const m of a.results) assert.equal(m.verdict, "caught");
  cleanup(r);
});

// The mutation-runner time limit (7 November 2026, MUTATION-RUNNER-TIMEOUT-20261107): ONE per-test limit, 20 s, asked of every child,
// each control and each mutant alike, so their verdicts are comparable; written out here, not imported. Its effect on real Vitest runs
// (and that ordinary runs keep Vitest's limits) is in scripts/validation/unit-runner-time-limit.test.mjs.
test("time limit: every control and every mutant child is asked for the same 20 s per-test limit, and the account records it", {
  timeout: 60_000,
}, async () => {
  const r = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) => (l.id === "control" ? pass(l) : caught(l)),
  }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    r.launches.map((l) => [l.request.label, l.request.testTimeoutMs]),
    [
      ["control-0", 20_000],
      ["control-1", 20_000],
      ["MU-1600", 20_000],
      ["MU-1601", 20_000],
    ],
  );
  // The request kept beside each child's evidence says the same.
  for (const label of ["control-0", "control-1", "MU-1600", "MU-1601"])
    assert.equal(
      JSON.parse(
        readFileSync(join(r.out, "work", label, "request.json"), "utf8"),
      ).testTimeoutMs,
      20_000,
      label,
    );
  assert.equal(account(r).summary.test_timeout_ms, 20_000);
  cleanup(r);
});

test("H7 Q3: the first control fails, so nothing else starts (one launch); every selected mutant is not run", {
  timeout: 60_000,
}, async () => {
  const r = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) => ending(l, { [`${SET} still loads`]: ASSERT }, 1),
  }).done;
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ["control"]);
  // adapted (r41): control `status` failed/not_run is `verdict` fail/not_run; the stop "control 0 failed" is "control-0: fail".
  assert.deepEqual(
    account(r).summary.controls.map((c) => c.verdict),
    ["fail", "not_run"],
  );
  assert.deepEqual(account(r).summary.not_run, ["MU-1600", "MU-1601"]);
  assert.equal(account(r).summary.stopped, "control-0: fail");
  assert.deepEqual(account(r).results, []);
  cleanup(r);
});

test("H7 Q3: a control that exits 0 without a sound report fails too (missing report, missing file, empty run)", {
  timeout: 60_000,
}, async () => {
  // adapted (r41): each variant is now judged from the envelope and the report together, so each has its own reason; "no envelope" is
  // the supervised child's own way of exiting 0 without evidence.
  const variants = {
    "no report": [
      (l) => ({ envelope: evidence(l, {}, { code: 0 }).envelope, code: 0 }),
      /JSON report missing/,
    ],
    "no envelope": [
      (l) => ({ report: evidence(l, {}, { code: 0 }).report, code: 0 }),
      /envelope missing/,
    ],
    "a selected file missing": [
      (l) =>
        ending(l, {}, 0, { files: ["tests/features/settings/other.test.ts"] }),
      /selected test file\(s\) not run: tests\/features\/settings\/session-labels\.test\.ts$/,
    ],
    "no test at all": [
      (l) => ending(l, {}, 0, { files: [] }),
      /no test module was reported/,
    ],
  };
  for (const [name, [bad, why]] of Object.entries(variants)) {
    const r = await start({
      only: ["MU-1601", "MU-1600"],
      answer: (l) => bad(l),
    }).done;
    assert.equal(r.code, 1, name);
    assert.deepEqual(ids(r), ["control"], name);
    // adapted (r41): control `status` "failed" is `verdict` "incomplete" (not passed), with the reason.
    const control = account(r).summary.controls[0];
    assert.equal(control.verdict, "incomplete", name);
    assert.equal(control.passed, false, name);
    assert.match(control.reasons.join("\n"), why, name);
    cleanup(r);
  }
});

test("H7 Q4: a survivor, a wrong assertion or a mixed failure stops admission: the second mutant never starts", {
  timeout: 60_000,
}, async () => {
  // adapted (r41): the earlier runner's `invalid` is `tainted` for an assertion beside another failure (it counted the unhandled error
  // from Vitest's output; the supervised child counts it in the envelope) and `incomplete` for evidence that is not complete.
  const variants = {
    survived: [(l) => pass(l), "survived", /no test failed/],
    "wrong test": [
      (l) => ending(l, { [NAMES["MU-1601"]]: ASSERT }, 1),
      "wrong_test",
      /no assertion failure matches/,
    ],
    "H6 mixed error": [
      (l) =>
        ending(
          l,
          {
            [NAMES["MU-1600"]]: ASSERT,
            extra: [[SET, "independent fixture preparation", TYPE]],
          },
          1,
        ),
      "tainted",
      /beside the assertions/,
    ],
    "H6 mixed timeout": [
      (l) =>
        ending(
          l,
          {
            [NAMES["MU-1600"]]: ASSERT,
            [NAMES["MU-1602"]]: "Error: Test timed out in 5000ms.",
          },
          1,
        ),
      "tainted",
      /beside the assertions/,
    ],
    "H6 unhandled error": [
      (l) =>
        ending(l, { [NAMES["MU-1600"]]: ASSERT }, 1, {
          unhandled: 1,
        }),
      "tainted",
      /1 unhandled error\(s\)/,
    ],
    "H6 signal": [
      () => ({ signal: "SIGKILL" }),
      "incomplete",
      /terminated by SIGKILL/,
    ],
    "H6 damaged report": [
      (l) => ({ ...ending(l, {}, 1), report: "{" }),
      "incomplete",
      /JSON report malformed/,
    ],
    // Review r17 H6a: the unexpected failure is a second message of the INTENDED test itself, in either order.
    "H6a same-test error after the assertion": [
      (l) =>
        ending(
          l,
          {
            [NAMES["MU-1600"]]: [
              ASSERT,
              "TypeError: independent teardown failure",
            ],
          },
          1,
        ),
      "tainted",
      /beside the assertions/,
    ],
    "H6a same-test error before the assertion": [
      (l) =>
        ending(
          l,
          {
            [NAMES["MU-1600"]]: [
              "TypeError: independent teardown failure",
              ASSERT,
            ],
          },
          1,
        ),
      "tainted",
      /beside the assertions/,
    ],
    "H6a same-test hook timeout": [
      (l) =>
        ending(
          l,
          {
            [NAMES["MU-1600"]]: [ASSERT, "Error: Hook timed out in 10000ms."],
          },
          1,
        ),
      "tainted",
      /beside the assertions/,
    ],
  };
  for (const [name, [first, verdict, why]] of Object.entries(variants)) {
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
    const a = result(r, "MU-1600");
    assert.equal(a.verdict, verdict, name);
    assert.equal(a.caught, false, name);
    assert.match(a.reasons.join("\n"), why, name);
    assert.deepEqual(account(r).summary.not_run, ["MU-1601"], name);
    assert.equal(account(r).summary.stopped, `MU-1600: ${verdict}`, name);
    assert.deepEqual(
      account(r).summary.failures,
      [{ id: "MU-1600", verdict }],
      name,
    );
    if (name.startsWith("H6 mixed") || name.startsWith("H6a")) {
      // adapted (r41): the earlier `expected_assertion_observed`, `unexpected`, `failures`, `failedCount` and `messageCount` are this
      // runner's failed tests and its count of every message by kind: the expected test's assertion is kept, beside one other failure.
      assert.ok(
        a.failedTests.includes(`${SET} > ${NAMES["MU-1600"]}`),
        `${name}: the expected assertion is kept as an observation`,
      );
      // Tests and messages are counted apart: the same-test cells have ONE failed test with two messages.
      assert.equal(a.failedCount, name.startsWith("H6a") ? 1 : 2, name);
      assert.equal(
        a.kinds.assertion + a.kinds.timeout + a.kinds.error + a.kinds.inverted,
        2,
        name,
      );
      assert.equal(a.kinds.assertion, 1, name);
      assert.equal(
        a.kinds[name.includes("timeout") ? "timeout" : "error"],
        1,
        name,
      );
    }
    if (name === "H6 unhandled error") {
      assert.equal(a.kinds.assertion, 1, name);
      assert.equal(a.kinds.outside, 1, name);
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
    const failure = (id) =>
      ending(
        h.launches.find((l) => l.id === id),
        order === "A fails by a same-test error first"
          ? { [NAMES[id]]: [ASSERT, TYPE] }
          : {
              [NAMES[id]]: ASSERT,
              extra: [[SET, "independent fixture preparation", TYPE]],
            },
        1,
      );
    held[first].release(failure(first));
    // The latch is set before the other mutant answers. Without it, the third mutant starts or the runner ends instead: either is
    // observed by the assertions below, never waited out. adapted (r41): the earlier runner's "STOPPING" line is this runner's verdict
    // line for the first mutant, which it writes only after the latch is set.
    await Promise.race([h.said(`TAINTED  ${first}`), h.launched(4), h.done]);
    held[second].release(
      order === "A fails, then B fails late"
        ? failure(second)
        : caught(h.launches.find((l) => l.id === second)),
    );
    const r = await h.done;
    assert.equal(r.code, 1, order);
    assert.ok(!ids(r).includes("MU-1604"), `${order}: C must never start`);
    assert.deepEqual(account(r).summary.not_run, ["MU-1604"], order);
    // adapted (r41): `status` invalid/caught is `verdict` tainted/caught; the stop is the first failure's own.
    assert.equal(result(r, first).verdict, "tainted", order);
    assert.equal(
      result(r, second).verdict,
      order === "A fails, then B fails late" ? "tainted" : "caught",
      `${order}: B keeps its own result`,
    );
    assert.equal(
      account(r).summary.stopped,
      `${first}: tainted`,
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
  // adapted (r41): `summary.states.caught` is `summary.caught`.
  assert.equal(account(r).summary.caught, 3);
  cleanup(r);
});

test("Q6: a command that does not start, an output or report that cannot be kept, and a ledger that cannot be written all fail", {
  timeout: 60_000,
}, async () => {
  // adapted (r41): the child is started by the runner's own Node binary, so "no pnpm on PATH" is now a supervised child that does not
  // start (its script is missing): no evidence, the control is incomplete, recorded; nothing else starts.
  const tree = runnerTree();
  rmSync(join(tree, "scripts/mutation/vitest-supervised.mjs"));
  const missing = await start({ tree, only: ["MU-1600"], answer: pass }).done;
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.launches, []);
  assert.ok(missing.ledger, "the account is written");
  assert.equal(missing.ledger.summary.controls[0].verdict, "incomplete");
  assert.match(
    missing.ledger.summary.controls[0].reasons.join(" "),
    /envelope missing/,
  );
  assert.match(
    readFileSync(join(missing.out, "work", "control-0", "output.log"), "utf8"),
    /Cannot find module/,
  );
  assert.deepEqual(missing.ledger.summary.not_run, ["MU-1600"]);
  cleanup(missing);

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
  // adapted (r41): "could not keep" is this runner's infrastructure failure at the stage it reached.
  assert.match(
    account(log).summary.stopped,
    /^MU-1600: infrastructure failure: EISDIR/,
  );
  assert.deepEqual(
    [result(log, "MU-1600").verdict, result(log, "MU-1600").stage],
    ["infrastructure", "complete"],
  );
  assert.deepEqual(account(log).summary.not_run, ["MU-1601"]);
  cleanup(log);

  // The report path is a directory (unreadable): not a catch.
  const unreadable = await start({
    only: ["MU-1600", "MU-1601"],
    answer: (l) =>
      l.id === "control"
        ? pass(l)
        : {
            envelope: evidence(l, {}, { code: 1 }).envelope,
            code: 1,
            mkdirs: [l.request.json],
          },
  }).done;
  assert.equal(unreadable.code, 1);
  // adapted (r41): `status` "invalid" with "could not be read" is `verdict` "incomplete" with the report's read failure.
  assert.equal(account(unreadable).results[0].verdict, "incomplete");
  assert.match(
    account(unreadable).results[0].reasons.join(" "),
    /JSON report malformed: EISDIR/,
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
            // adapted (r41): this runner writes `unit-results.json` itself (the earlier one wrote `.partial` first).
            mkdirs: [join(l.dir, "..", "..", "unit-results.json")],
          },
  }).done;
  assert.equal(ledgerFail.code, 1);
  assert.equal(ledgerFail.ledger, null);
  assert.match(ledgerFail.stderr, /unit-results\.json could not be written/);
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
  assert.deepEqual(
    h.launches.map((l) => l.id),
    ["control", "control", "MU-1600"],
    "the mutant is running when the runner is interrupted",
  );
  h.child.kill("SIGTERM");
  const r = await h.done;
  hold.release({ code: 0 });
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ["control", "control", "MU-1600"]);
  // adapted (r41): the stop is the runner's own ("run: …"); the ended child's `status` "invalid" is `verdict` "incomplete".
  assert.equal(account(r).summary.stopped, "run: interrupted by SIGTERM");
  assert.equal(account(r).results[0].verdict, "incomplete");
  assert.match(
    account(r).results[0].reasons.join(" "),
    /terminated by SIGTERM/,
  );
  assert.deepEqual(account(r).summary.not_run, ["MU-1601"]);
  // The running child itself was ended (not left behind waiting for its answer).
  assert.throws(() => process.kill(r.launches[2].pid, 0), { code: "ESRCH" });
  cleanup(r);
});

test("Q3/Q15: a selection or destination that cannot run is refused before anything starts, and earlier evidence is never overwritten", {
  timeout: 60_000,
}, async () => {
  // adapted (r41): an unknown or repeated catalogue id stays this runner's INVENTORY refusal (exit 1; tests/static/mutation-inventory
  // .test.ts), the rest are refusals of the command line (exit 2). Either way nothing starts and no output is claimed.
  for (const [args, code, why] of [
    [["--jobs", "0"], 2, /--jobs must be a positive integer/],
    [["--jobs", "1.5"], 2, /--jobs must be a positive integer/],
    [["--only", "MU-9999"], 1, /INVENTORY --only names MU-9999/],
    [["--only", "MU-1600,MU-1600"], 1, /INVENTORY --only names MU-1600 twice/],
    [["--only", ""], 2, /--only has an empty id/],
    [["--bogus"], 2, /unknown argument --bogus/],
  ]) {
    const r = await start({ jobs: null, answer: pass, args }).done;
    assert.equal(r.code, code, args.join(" "));
    assert.match(r.stderr, why, args.join(" "));
    assert.deepEqual(r.launches, [], args.join(" "));
    assert.equal(existsSync(r.out), false, args.join(" "));
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
      [
        join(first.tree, "scripts/run-data-mutants.mjs"),
        "--only",
        "MU-1600",
        "--out",
        first.out,
      ],
      { cwd: first.tree, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => r({ code, err }));
  });
  assert.equal(again.code, 2);
  // adapted (r41): this runner's wording for "never overwritten".
  assert.match(again.err, /refusing to reuse an existing output directory/);
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
  const { UNIT } = await import("../mutation/data-catalogue.mjs");
  const [a, b] = ["MU-1600", "MU-1625"].map((id) =>
    UNIT.find((m) => m.id === id),
  );
  assert.notEqual(a.file, b.file);
  const tree = runnerTree({
    sources: [b.file],
    edit: { [a.file]: "// the code this mutant targets is gone\n" },
  });
  const r = await start({
    only: ["MU-1600", "MU-1625"],
    tree,
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
  // adapted (r41): control `status` is `verdict`; the stop is "patch failed: …".
  assert.deepEqual(
    account(r).summary.controls.map((c) => c.verdict),
    ["not_run", "not_run"],
  );
  assert.equal(account(r).summary.stopped, "patch failed: MU-1600");
  // adapted (r41): this runner preflights EVERY selected patch before any child (VE-20261004), so MU-1625's patched copy exists; it was
  // never run: nothing was requested of a child for it.
  assert.equal(
    existsSync(join(r.out, "work", "MU-1625", "request.json")),
    false,
    "the later mutant is never started",
  );
  cleanup(r);
});

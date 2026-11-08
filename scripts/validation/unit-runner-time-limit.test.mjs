import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import test, { after, before } from "node:test";
import { runUnitMutants } from "../mutation/unit-runner.mjs";
import { REQUEST_SCHEMA } from "../mutation/vitest-evidence.mjs";

// The mutation-runner time limit (7 November 2026, Kieran's decision MUTATION-RUNNER-TIMEOUT-20261107), at the REAL boundary: the
// unit-mutation runner (scripts/mutation/unit-runner.mjs) with its real supervised child (scripts/mutation/vitest-supervised.mjs) and
// the pinned Vitest, over a disposable fixture project, judged by the same evidence rules as the catalogue (scripts/mutation/
// vitest-evidence.mjs). The stub-child protocol tests are in scripts/validation/unit-runner.test.mjs.
//
// Every control and mutant child runs each test under 20 s (Vitest's 5 s default otherwise), unless the test states its own limit,
// which is kept, larger or smaller. Ordinary runs keep Vitest's limits. The unmutated control runs under the same limit as its mutants.
// A test that takes 6 s on a mutated path is judged by its assertion; a test that never settles still ends as a time-out (crash_only),
// at the 20 s limit. The limit below is written out, not
// imported: each case also runs against the runner as it was before this change (its negative control, notes in the delivery), where
// it must fail, and that runner has no such export.
//
// The fixture runs real time (6 s and 3 s paths, a 20 s hang). The runs start together, so the file takes about as long as its longest
// run (the hang: about 25 s on an idle machine).
const LIMIT = 20_000;
const base = resolve(import.meta.dirname, "../..");
const temporary = [];

const TESTS = "tests/answer.test.mjs";
const EVERY = "tests/every-path.test.mjs";
const SOURCE = "src/answer.mjs";
const NAMES = {
  answer: "the answer is 42",
  own30: "a test with its own 30 s limit",
  own1500: "a test with its own 1.5 s limit",
  every: "a test that takes 6 s on every path",
};

/**
 * A disposable project: one source file, two test files (TESTS: the first three NAMES; EVERY: the last), its config and a config whose
 * plugin changes the limit.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unit-time-limit-")));
  temporary.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(
    join(root, SOURCE),
    `// The fixture's source: each mutant rewrites one return.
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export async function answer() {
  return 42;
}
export async function own() {
  return "own";
}
export async function late() {
  return "late";
}
`,
  );
  writeFileSync(
    join(root, TESTS),
    `import { answer, own } from "../src/answer.mjs";
test(${JSON.stringify(NAMES.answer)}, async () => {
  expect(await answer()).toBe(42);
});
test(${JSON.stringify(NAMES.own30)}, async () => {
  expect(await own()).toBe("own");
}, 30_000);
test(${JSON.stringify(NAMES.own1500)}, async () => {
  expect(await own()).toBe("own");
}, 1_500);
`,
  );
  writeFileSync(
    join(root, EVERY),
    `import { late, pause } from "../src/answer.mjs";
test(${JSON.stringify(NAMES.every)}, async () => {
  await pause(6_000);
  expect(await late()).toBe("late");
});
`,
  );
  const redirect = JSON.stringify(
    join(base, "scripts/mutation/redirect-plugin.mjs"),
  );
  const options = `test: { environment: "node", globals: true, include: ["tests/**/*.test.mjs"] }`;
  writeFileSync(
    join(root, "vitest.fixture.config.mjs"),
    `import { mutantRedirect } from ${redirect};
export default {
  plugins: [mutantRedirect(${JSON.stringify(root)}, process.env.ATLAS_MUTANT_DIR)],
  ${options},
};
`,
  );
  // A plugin that sets another per-test limit after the configuration is resolved: the supervised child must refuse such a run.
  writeFileSync(
    join(root, "vitest.drift.config.mjs"),
    `import { mutantRedirect } from ${redirect};
export default {
  plugins: [
    mutantRedirect(${JSON.stringify(root)}, process.env.ATLAS_MUTANT_DIR),
    { name: "drift", configureVitest({ project }) { project.config.testTimeout = 7_000; } },
  ],
  ${options},
};
`,
  );
  return root;
}

const mutant = (id, title, from, to, expect, tests = [TESTS]) => ({
  id,
  title,
  file: SOURCE,
  tests,
  expect,
  patch: (text) => text.replace(from, to),
});
const MUTANTS = {
  slow: mutant(
    "MU-T1",
    "the answer takes 6 s and is wrong",
    "return 42;",
    "await pause(6_000);\n  return 41;",
    /the answer is 42/,
  ),
  hang: mutant(
    "MU-T2",
    "the answer never settles",
    "return 42;",
    "await new Promise(() => {});\n  return 41;",
    /the answer is 42/,
  ),
  own: mutant(
    "MU-T3",
    "own() takes 3 s and is wrong",
    'return "own";',
    'await pause(3_000);\n  return "not own";',
    /its own 30 s limit/,
  ),
  every: mutant(
    "MU-T4",
    "late() is wrong (its test takes 6 s on every path)",
    'return "late";',
    'return "early";',
    /takes 6 s on every path/,
    [EVERY],
  ),
};

/** One run of the real runner over one mutant (its own unmutated control first); the account, the log and each child's evidence. */
async function run(root, name, m, config = "vitest.fixture.config.mjs") {
  const outDir = join(root, ".out", name);
  const lines = [];
  const started = Date.now();
  const { code, summary, results } = await runUnitMutants({
    root,
    mutants: [m],
    outDir,
    config: join(root, config),
    jobs: 1,
    log: (line) => lines.push(line),
  });
  const read = (label, file) => {
    const path = join(outDir, "work", label, file);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  const child = (label) => ({
    request: read(label, "request.json"),
    envelope: read(label, "envelope.json"),
    report: read(label, "report.json"),
  });
  return {
    code,
    summary,
    record: results.find((r) => r.id === m.id),
    control: child("control-0"),
    mutant: child(m.id),
    log: lines.join("\n"),
    ms: Date.now() - started,
  };
}

/** Each witnessed test's limit (`timeout`) and state, by name, from one child's envelope. */
const limits = (envelope) =>
  Object.fromEntries(
    (envelope?.witness?.tests ?? []).map((t) => [
      t.name,
      { timeout: t.timeout, state: t.state },
    ]),
  );
/** The failure messages of the named test in one child's JSON report. */
const failuresOf = (report, name) =>
  (report?.testResults ?? [])
    .flatMap((f) => f.assertionResults ?? [])
    .find((t) => t.title === name)?.failureMessages ?? [];

/** An ORDINARY run (no runner, no supervised child: what `vitest run` does with this config): each test's limit and state, by name. */
async function ordinary(root) {
  const { createVitest } = await import("vitest/node");
  const seen = {};
  const capture = {
    onTestRunEnd(modules) {
      for (const m of modules)
        for (const t of m.children.allTests())
          seen[t.name] = {
            timeout: t.options.timeout,
            state: t.result().state,
            error: t.result().errors?.[0]?.message ?? null,
          };
    },
  };
  const ctx = await createVitest("test", {
    root,
    config: join(root, "vitest.fixture.config.mjs"),
    run: true,
    watch: false,
    reporters: [capture],
  });
  // The 6 s test fails here by design; Vitest's exit code for it is not this file's.
  const exitCode = process.exitCode;
  try {
    await ctx.start();
  } finally {
    await ctx.close();
    process.exitCode = exitCode;
  }
  return seen;
}

/** The repository's own configuration, resolved as an ordinary run resolves it: each project's test and hook limits. */
async function resolved(config) {
  const { createVitest } = await import("vitest/node");
  const ctx = await createVitest("test", {
    root: base,
    config: join(base, config),
    run: true,
    watch: false,
    reporters: [],
  });
  try {
    return ctx.projects.map((p) => ({
      testTimeout: p.config.testTimeout,
      hookTimeout: p.config.hookTimeout,
    }));
  } finally {
    await ctx.close();
  }
}

// Every run starts at once; each case below waits only for the runs it reads.
let runs;
before(() => {
  const root = fixture();
  runs = {
    root,
    slow: run(root, "slow", MUTANTS.slow),
    hang: run(root, "hang", MUTANTS.hang),
    own: run(root, "own", MUTANTS.own),
    every: run(root, "every", MUTANTS.every),
    drift: run(root, "drift", MUTANTS.slow, "vitest.drift.config.mjs"),
  };
  // A rejected run is reported by the case that awaits it, not as an unhandled rejection of this hook.
  for (const p of Object.values(runs)) p?.catch?.(() => {});
});
// Every run is joined before anything is removed, whichever cases ran (a name-filtered invocation awaits only some of the runs, and a
// run still in flight would write into a removed fixture).
after(async () => {
  if (runs)
    await Promise.allSettled(
      Object.values(runs).filter((p) => p instanceof Promise),
    );
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

test("time limit: every control and mutant child runs each test under 20 s unless the test states its own, which is kept; ordinary runs keep Vitest's limits", {
  timeout: 240_000,
}, async () => {
  const slow = await runs.slow;
  const own = await runs.own;
  for (const r of [slow, own]) {
    assert.equal(r.summary?.test_timeout_ms, LIMIT, r.log);
    for (const [label, child] of [
      ["control-0", r.control],
      [r.record?.id, r.mutant],
    ]) {
      // The request asks for the limit, every project resolved to it, and each test ran under it or under its own.
      assert.equal(child.request?.testTimeoutMs, LIMIT, `${label} request`);
      assert.deepEqual(
        child.envelope?.origin?.projects?.map((p) => p.testTimeout),
        [LIMIT],
        `${label} projects`,
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(limits(child.envelope)).map(([n, v]) => [
            n,
            v.timeout,
          ]),
        ),
        {
          [NAMES.answer]: LIMIT,
          [NAMES.own30]: 30_000,
          [NAMES.own1500]: 1_500,
        },
        `${label} per-test limits`,
      );
    }
    assert.equal(r.summary.controls[0].verdict, "pass", r.log);
  }
  // A test's own SMALLER limit is kept in a mutant run, not raised to the runner's: own() takes 3 s, so the 1.5 s test times out at
  // 1.5 s while the 30 s test fails by its assertion. A time-out beside the assertion taints the catch (it is never caught).
  assert.equal(own.record?.verdict, "tainted", own.log);
  assert.deepEqual(
    [own.record.kinds.assertion, own.record.kinds.timeout],
    [1, 1],
  );
  assert.match(
    failuresOf(own.mutant.report, NAMES.own1500)[0] ?? "",
    /^Error: Test timed out in 1500ms\./,
  );
  assert.match(
    failuresOf(own.mutant.report, NAMES.own30)[0] ?? "",
    /^AssertionError: expected 'not own' to be 'own'/,
  );

  // Ordinary runs: the same fixture without the runner keeps Vitest's 5 s default (so the 6 s test, which passes its control under the
  // runner, times out there), and the repository's configurations (`pnpm test` runs vitest.config.ts; the runner's own config is
  // vitest.mutant.config.ts) set no limit of their own: only the runner raises it.
  assert.deepEqual(await ordinary(runs.root), {
    [NAMES.answer]: { timeout: 5_000, state: "passed", error: null },
    [NAMES.own30]: { timeout: 30_000, state: "passed", error: null },
    [NAMES.own1500]: { timeout: 1_500, state: "passed", error: null },
    [NAMES.every]: {
      timeout: 5_000,
      state: "failed",
      error:
        'Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    },
  });
  for (const config of ["vitest.config.ts", "vitest.mutant.config.ts"])
    assert.deepEqual(
      await resolved(config),
      [{ testTimeout: 5_000, hookTimeout: 10_000 }],
      config,
    );
});

test("time limit: the unmutated control runs under the same limit as its mutants: a test that takes 6 s on every path passes its control and catches its mutant", {
  timeout: 240_000,
}, async () => {
  const r = await runs.every;
  assert.equal(r.code, 0, r.log);
  const [control] = r.summary.controls;
  assert.deepEqual([control.verdict, control.total], ["pass", 1], r.log);
  for (const [label, child, state] of [
    ["control-0", r.control, "passed"],
    [MUTANTS.every.id, r.mutant, "failed"],
  ]) {
    const [t] = child.envelope.witness.tests;
    assert.deepEqual(
      [t.name, t.timeout, t.state],
      [NAMES.every, LIMIT, state],
      label,
    );
    assert.ok(t.ms >= 6_000, `${label}: the test took ${t.ms} ms`);
  }
  assert.equal(r.record?.verdict, "caught", r.log);
  assert.equal(r.record.kinds.assertion, 1);
  assert.equal(r.record.kinds.timeout, 0);
});

test("time limit: a test that takes 6 s on a mutated path is judged by its assertion (caught), its control passing under the same limit", {
  timeout: 240_000,
}, async () => {
  const r = await runs.slow;
  assert.equal(r.code, 0, r.log);
  assert.equal(r.record?.verdict, "caught", r.log);
  assert.deepEqual(r.record.kinds, {
    assertion: 1,
    inverted: 0,
    timeout: 0,
    error: 0,
    suite: 0,
    outside: 0,
  });
  assert.deepEqual(r.record.failedTests, [`${TESTS} > ${NAMES.answer}`]);
  assert.match(
    failuresOf(r.mutant.report, NAMES.answer)[0] ?? "",
    /^AssertionError: expected 41 to be 42/,
  );
  // It really ran past Vitest's 5 s default, on the mutated path only.
  const ms = r.mutant.envelope.witness.tests.find(
    (t) => t.name === NAMES.answer,
  ).ms;
  assert.ok(ms >= 6_000, `the mutated test took ${ms} ms`);
  assert.ok(
    r.control.envelope.witness.tests.every((t) => t.ms < 5_000),
    "the control's tests are fast",
  );
});

test("time limit: a test that never settles still ends as a time-out at the 20 s limit, never as a catch, and fails the run", {
  timeout: 240_000,
}, async () => {
  const r = await runs.hang;
  assert.equal(r.code, 1, r.log);
  assert.equal(r.record?.verdict, "crash_only", r.log);
  assert.equal(r.record.caught, false);
  assert.deepEqual(r.record.kinds, {
    assertion: 0,
    inverted: 0,
    timeout: 1,
    error: 0,
    suite: 0,
    outside: 0,
  });
  assert.deepEqual(r.summary.survived, [MUTANTS.hang.id]);
  assert.deepEqual(r.summary.failures, [
    { id: MUTANTS.hang.id, verdict: "crash_only" },
  ]);
  assert.match(
    failuresOf(r.mutant.report, NAMES.answer)[0] ?? "",
    /^Error: Test timed out in 20000ms\./,
  );
  assert.equal(r.summary.controls[0].verdict, "pass");
  assert.ok(r.record.ms >= LIMIT, `the hung child took ${r.record.ms} ms`);
});

test("time limit: a project whose limit differs from the request's is refused (incomplete evidence), and nothing is admitted", {
  timeout: 240_000,
}, async () => {
  const r = await runs.drift;
  assert.equal(r.code, 1, r.log);
  const [control] = r.summary.controls;
  assert.equal(control.verdict, "incomplete", r.log);
  assert.match(
    control.reasons.join("\n"),
    /the per-test time limit 20000 ms is not the limit of every project \(7000\)/,
  );
  assert.equal(r.control.envelope?.supported, false);
  assert.deepEqual(r.summary.not_run, [MUTANTS.slow.id]);
  assert.equal(r.record, undefined);
});

test("time limit: a limit that is not a positive whole number of milliseconds is refused before anything is claimed or started", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unit-time-limit-")));
  temporary.push(root);
  for (const [i, testTimeoutMs] of [
    0,
    -1,
    1.5,
    Number.NaN,
    "20000",
  ].entries()) {
    const outDir = join(root, `out-${i}`);
    const { code, summary } = await runUnitMutants({
      root,
      mutants: [MUTANTS.slow],
      outDir,
      config: join(root, "vitest.fixture.config.mjs"),
      testTimeoutMs,
      log: () => {},
    });
    assert.equal(code, 2, `limit ${String(testTimeoutMs)}`);
    assert.equal(summary, null);
    assert.equal(existsSync(outDir), false, "nothing is claimed");
  }
});

test("time limit: the supervised child refuses a request whose limit is not a positive whole number of milliseconds, and writes no envelope", {
  timeout: 120_000,
}, async () => {
  const root = fixture();
  const supervisor = join(base, "scripts/mutation/vitest-supervised.mjs");
  for (const [i, testTimeoutMs] of [0, 2.5, "20000", null].entries()) {
    const dir = join(root, `.bad-${i}`);
    mkdirSync(dir);
    const request = {
      schema: REQUEST_SCHEMA,
      nonce: `bad-${i}`,
      label: `bad-${i}`,
      root,
      config: join(root, "vitest.fixture.config.mjs"),
      files: [TESTS],
      json: join(dir, "report.json"),
      envelope: join(dir, "envelope.json"),
      testTimeoutMs,
    };
    writeFileSync(join(dir, "request.json"), JSON.stringify(request));
    const child = spawnSync(
      process.execPath,
      [supervisor, join(dir, "request.json")],
      { cwd: root, encoding: "utf8", timeout: 90_000 },
    );
    assert.equal(
      child.status,
      70,
      `${JSON.stringify(testTimeoutMs)}: ${child.stderr}`,
    );
    assert.match(
      child.stderr,
      /the request's per-test time limit is not a positive whole number of milliseconds/,
    );
    assert.equal(existsSync(request.envelope), false, "no envelope");
  }
});

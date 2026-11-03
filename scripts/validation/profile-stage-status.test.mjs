// WEB-09c revision 15 (review 15 R15-S1; design assessment DA15-S1, invariant 8, Q5; family profiling-stage-failure-propagation): a
// sampled stage succeeds only when its action succeeds AND its required load sampler started and finished successfully. Review 15's probe
// let a stage whose sampler died after readiness seal `exit_status: 0` and return 0, so both drivers went on to the next expensive stage.
//
//   node --test scripts/validation/profile-stage-status.test.mjs
//
// Three layers, each with its healthy control: the actual `runStage` against deterministic sampler handles (every terminal result × an
// action that returns 0, returns 7 or throws, and every startup failure); one owned REAL sampler killed after readiness; and the REAL
// standalone and delegated contention drivers, loaded through a module hook that replaces only their Playwright launch and fixture server
// (nothing is built, no browser or server starts; the hook kills the stage's own sampler or returns the action's status). The expected
// statuses and messages are written here by hand. Not a measurement.
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
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.ATLAS_TOOLING_ROOT
  ? resolve(process.env.ATLAS_TOOLING_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = await import(
  pathToFileURL(join(root, "scripts/lib/profile-evidence.mjs")).href
);
const isolation = await import(
  pathToFileURL(join(root, "scripts/lib/profile-isolation.mjs")).href
);

const scratch = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "web09c-stage-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sealed = (dir, stage) =>
  JSON.parse(readFileSync(join(dir, "stages", `${stage}.json`), "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

// ---- the deterministic matrix ------------------------------------------------------------------------------------------------------------
const HEALTHY = {
  exit_code: 0,
  samples: 3,
  final_sample: true,
  final_error: null,
};
/** Sampler handles, each with the terminal result its stop gives (or how its stop fails), and the sampler problem it must seal. */
const TERMINALS = [
  ["healthy", () => HEALTHY, null],
  [
    "exit 3 (its owner or root went)",
    () => ({ ...HEALTHY, exit_code: 3, final_sample: false }),
    /^the sampler exited with 3, not 0$/,
  ],
  [
    "killed (no exit code)",
    () => ({ ...HEALTHY, exit_code: null, final_sample: false }),
    /^the sampler exited by a signal or without a code, not 0$/,
  ],
  [
    "no final sample (missing, stale or another sampler's)",
    () => ({ ...HEALTHY, final_sample: false }),
    /^the sampler wrote no valid final sample of its own after the stop$/,
  ],
  [
    "a final marker on an error row",
    () => ({
      ...HEALTHY,
      final_sample: false,
      final_error: "the stage owner 1 is gone",
    }),
    /^the sampler's final sample is an error: the stage owner 1 is gone$/,
  ],
  [
    "the stop rejects",
    () => Promise.reject(new Error("stop rejected")),
    /^the sampler could not be stopped: Error: stop rejected$/,
  ],
  [
    "the stop throws synchronously",
    () => {
      throw new Error("stop threw");
    },
    /^the sampler could not be stopped: Error: stop threw$/,
  ],
  [
    "the stop resolves nothing",
    () => undefined,
    /^the sampler's stop returned no result$/,
  ],
];
const ACTIONS = [
  ["returns 0", () => 0, 0, null],
  ["returns 7", () => 7, 7, null],
  [
    "throws",
    () => {
      throw new Error("synthetic action failure");
    },
    1,
    /synthetic action failure/,
  ],
];

test("case: every sampler terminal result x every action outcome: the stage returns and seals the reduction (0 only when both succeed; a non-zero action status kept), its primary failure and its sampler problem side by side, the stop called once, and the driver's guard runs no follow-on stage unless 0", async (t) => {
  const dir = scratch(t);
  let n = 0;
  for (const [terminal, stop, problem] of TERMINALS)
    for (const [outcome, act, actionStatus, failure] of ACTIONS) {
      n += 1;
      const stage = `s${n}`;
      const label = `${terminal} / action ${outcome}`;
      let stops = 0;
      let ran = 0;
      let status;
      // The stage itself never throws (a synchronous stop throw included): an escaping throw fails this assertion.
      await assert.doesNotReject(async () => {
        status = await evidence.runStage(
          dir,
          stage,
          async () => {
            ran += 1;
            return act();
          },
          {
            sample: async () => ({
              ready: true,
              ready_at: "2026-10-15T00:00:00.000Z",
              pid: 4242,
              owner_pid: process.pid,
              // As the real stop: a promise, except where the case makes the call itself throw synchronously.
              stop: () => {
                stops += 1;
                const result = stop();
                return result instanceof Promise
                  ? result
                  : Promise.resolve(result);
              },
            }),
            invocation: "inv",
            context: { invocation: "inv" },
          },
        );
      }, label);
      const expected = actionStatus !== 0 ? actionStatus : problem ? 1 : 0;
      assert.equal(status, expected, label);
      assert.equal(ran, 1, label);
      assert.equal(stops, 1, `${label}: the sampler is stopped exactly once`);
      const record = sealed(dir, stage);
      assert.equal(record.sealed, true, label);
      assert.equal(record.exit_status, status, label);
      if (failure) assert.match(record.failure, failure, label);
      else assert.equal(record.failure, null, label);
      if (problem) assert.match(record.sampler.problem, problem, label);
      else assert.equal(record.sampler.problem, null, label);
      // The drivers' guard (profile-sync.mjs `run`): the next stage starts only on 0.
      let followOn = false;
      if (status === 0) followOn = true;
      assert.equal(followOn, expected === 0, label);
    }
});

test("case: a requested sampler that gives no ready handle with a stop, or whose start fails, is a startup failure: the action never runs and the stage seals 1 with the reason; an unsampled stage (the handoff) is exempt from sampling only", async (t) => {
  const dir = scratch(t);
  const startups = [
    ["no handle", async () => null, /gave no ready handle \(none\)/],
    [
      "not ready",
      async () => ({ ready: false, stop: async () => HEALTHY }),
      /gave no ready handle \(not ready or no stop\)/,
    ],
    [
      "no stop",
      async () => ({ ready: true }),
      /gave no ready handle \(not ready or no stop\)/,
    ],
    [
      "the start rejects",
      async () => {
        throw new Error("wrote no valid first sample");
      },
      /wrote no valid first sample/,
    ],
  ];
  for (const [label, sample, reason] of startups) {
    let ran = false;
    const stage = label.replace(/\W+/g, "-");
    const status = await evidence.runStage(
      dir,
      stage,
      async () => {
        ran = true;
        return 0;
      },
      { sample, invocation: "inv", context: { invocation: "inv" } },
    );
    assert.equal(status, 1, label);
    assert.equal(ran, false, `${label}: the action never ran`);
    const record = sealed(dir, stage);
    assert.equal(record.exit_status, 1, label);
    assert.match(record.failure, reason, label);
    assert.equal(record.action_started_at, null, label);
    assert.equal(record.sampler, null, label);
  }
  for (const [outcome, act, expected] of [
    ["returns 0", () => 0, 0],
    ["returns 7", () => 7, 7],
  ]) {
    const stage = `handoff-${expected}`;
    const status = await evidence.runStage(dir, stage, async () => act(), {
      sample: null,
      invocation: "inv",
      context: { invocation: "inv" },
    });
    assert.equal(status, expected, `unsampled, action ${outcome}`);
    assert.equal(sealed(dir, stage).sampler, null);
    assert.equal(sealed(dir, stage).exit_status, expected);
  }
});

// ---- the final row's judgement ------------------------------------------------------------------------------------------------------------
test("case: the sampler's final row is judged by hand-written rows: only the stage's own sampler process, stage, invocation and root, at or after the stop and with no error, is a final sample; an error row's final marker reports its error", () => {
  const context = {
    invocation: "inv",
    root: { pid: 100, started: "Thu Oct 15 20:00:00 2026" },
  };
  const row = {
    at: "2026-10-15T21:00:10.000Z",
    sampler_pid: 200,
    final: true,
    context: {
      invocation: "inv",
      stage: "integration",
      root_pid: 100,
      root_started: "Thu Oct 15 20:00:00 2026",
    },
  };
  const judge = (last, stopping = Date.parse("2026-10-15T21:00:09.000Z")) =>
    isolation.finalSample([{ ...row, final: undefined }, last], {
      pid: 200,
      stage: "integration",
      context,
      stopping,
    });
  assert.deepEqual(judge(row), { final_error: null, final_sample: true });
  assert.deepEqual(judge(row, Date.parse(row.at)), {
    final_error: null,
    final_sample: true,
  });
  const refused = [
    [
      "an error row",
      { ...row, error: "the stage owner 1 is gone" },
      "the stage owner 1 is gone",
    ],
    ["no final marker", { ...row, final: undefined }, null],
    ["another sampler process", { ...row, sampler_pid: 201 }, null],
    [
      "another stage",
      { ...row, context: { ...row.context, stage: "fixture" } },
      null,
    ],
    [
      "another invocation",
      { ...row, context: { ...row.context, invocation: "other" } },
      null,
    ],
    [
      "another root",
      { ...row, context: { ...row.context, root_pid: 101 } },
      null,
    ],
    [
      "a restarted root",
      {
        ...row,
        context: { ...row.context, root_started: "Thu Oct 15 20:00:01 2026" },
      },
      null,
    ],
    [
      "written before the stop",
      { ...row, at: "2026-10-15T21:00:08.999Z" },
      null,
    ],
  ];
  for (const [label, last, error] of refused)
    assert.deepEqual(
      judge(last),
      { final_error: error, final_sample: false },
      label,
    );
  assert.deepEqual(
    isolation.finalSample([], {
      pid: 200,
      stage: "integration",
      context,
      stopping: 0,
    }),
    { final_error: null, final_sample: false },
  );
});

// ---- one owned real sampler ----------------------------------------------------------------------------------------------------------------
test("case: an owned real sampler killed after readiness while the action succeeds fails the stage (1), with its problem sealed and no follow-on stage; the healthy real sampler control returns 0 with its final sample; the killed process has exited", async (t) => {
  const dir = scratch(t);
  for (const variant of ["healthy", "killed"]) {
    const invocation = `stage-status-${variant}`;
    const context = isolation.directContext({
      invocation,
      evidenceDir: dir,
    });
    let sampler = null;
    const status = await evidence.runStage(
      dir,
      variant,
      async () => {
        if (variant === "killed") process.kill(sampler.pid, "SIGKILL");
        return 0;
      },
      {
        sample: async (d, s, c) => {
          sampler = await isolation.startLoadSampler(d, s, {
            context: c,
            intervalMs: 200,
          });
          return sampler;
        },
        invocation,
        context,
        extra: { root },
      },
    );
    let followOn = false;
    if (status === 0) followOn = true;
    const record = sealed(dir, variant);
    assert.equal(alive(sampler.pid), false, `${variant}: the sampler exited`);
    if (variant === "healthy") {
      assert.equal(status, 0);
      assert.equal(record.sampler.final_sample, true);
      assert.equal(record.sampler.exit_code, 0);
      assert.equal(record.sampler.problem, null);
      assert.equal(followOn, true);
    } else {
      assert.equal(status, 1);
      assert.equal(record.exit_status, 1);
      assert.equal(record.failure, null, "the action itself succeeded");
      assert.equal(record.sampler.final_sample, false);
      assert.equal(record.sampler.exit_code, null);
      assert.match(
        record.sampler.problem,
        /^the sampler exited by a signal or without a code, not 0$/,
      );
      assert.equal(followOn, false);
    }
  }
});

// ---- the real drivers, through a module hook -------------------------------------------------------------------------------------------------
/**
 * The hook replaces, for `scripts/profile-contention.mjs` only, `node:child_process`'s `spawnSync` of the Playwright CLI (every other call
 * is the real one) and `./lib/fixture-server.mjs` (no server). In `STAGE_PROBE=kill` the replaced launch SIGKILLs the stage's own sampler
 * (the first sample's `sampler_pid`) and returns 0; in `seven` it returns 7; in `ok` it returns 0. Each launch is logged.
 */
const writeHook = (dir) => {
  const hook = join(dir, "hook");
  mkdirSync(hook);
  writeFileSync(
    join(hook, "register.mjs"),
    `import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n`,
  );
  writeFileSync(
    join(hook, "hooks.mjs"),
    `const replaced = {
  "node:child_process": new URL("./child-process.mjs", import.meta.url).href,
  "./lib/fixture-server.mjs": new URL("./fixture-server.mjs", import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/scripts/profile-contention.mjs") && replaced[specifier])
    return { url: replaced[specifier], shortCircuit: true };
  return next(specifier, context);
}
`,
  );
  writeFileSync(
    join(hook, "child-process.mjs"),
    `import * as real from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
export * from "node:child_process";
export function spawnSync(command, args, options) {
  if (!(args ?? []).some((a) => String(a).endsWith("@playwright/test/cli.js"))) return real.spawnSync(command, args, options);
  const mode = process.env.STAGE_PROBE;
  const out = options.env.ATLAS_PROFILE_OUT;
  const first = JSON.parse(readFileSync(out + "/isolation/contention.jsonl", "utf8").split("\\n")[0]);
  appendFileSync(process.env.STAGE_PROBE_LOG, JSON.stringify({ mode, driver: process.pid, sampler: first.sampler_pid }) + "\\n");
  if (mode === "kill") process.kill(first.sampler_pid, "SIGKILL");
  return { status: mode === "seven" ? 7 : 0, signal: null, stdout: "", stderr: "", output: [] };
}
`,
  );
  writeFileSync(
    join(hook, "fixture-server.mjs"),
    `export const withFixtureServer = async (_root, run) => run("http://127.0.0.1:9");\n`,
  );
  return pathToFileURL(join(hook, "register.mjs")).href;
};
const drive = (dir, register, mode, delegated) => {
  const out = join(dir, `${delegated ? "delegated" : "standalone"}-${mode}`);
  const log = join(
    dir,
    `${delegated ? "delegated" : "standalone"}-${mode}.jsonl`,
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${register}`,
    STAGE_PROBE: mode,
    STAGE_PROBE_LOG: log,
  };
  delete env.ATLAS_PROFILE_CLAIM;
  delete env.ATLAS_PROFILE_SUPPORT;
  const run = spawnSync(
    process.execPath,
    delegated
      ? [
          join(root, "scripts/profile-sync.mjs"),
          "--evidence",
          out,
          "--only",
          "contention",
        ]
      : [
          join(root, "scripts/profile-contention.mjs"),
          "--skip-build",
          "--evidence",
          out,
        ],
    { cwd: root, env, encoding: "utf8", timeout: 120_000 },
  );
  const launches = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { run, out, launches };
};

test("case: the real standalone and delegated contention drivers exit with the stage's reduced status: 0 when the action and its sampler succeed, 1 when the sampler is killed after readiness although the action returned 0, and the action's own 7; the contention stage record agrees", async (t) => {
  const dir = scratch(t);
  const register = writeHook(dir);
  for (const delegated of [false, true])
    for (const [mode, expected, problem] of [
      ["ok", 0, null],
      ["kill", 1, /^the sampler exited by a signal or without a code, not 0$/],
      ["seven", 7, null],
    ]) {
      const label = `${delegated ? "delegated" : "standalone"} ${mode}`;
      const { run, out, launches } = drive(dir, register, mode, delegated);
      assert.equal(run.signal, null, `${label}: ${run.stdout}${run.stderr}`);
      assert.equal(
        launches.length,
        1,
        `${label}: the replaced launch ran once: ${run.stdout}${run.stderr}`,
      );
      assert.equal(
        run.status,
        expected,
        `${label}: ${run.stdout}${run.stderr}`,
      );
      const record = sealed(out, "contention");
      assert.equal(record.exit_status, expected, label);
      assert.equal(record.failure, null, label);
      if (problem) assert.match(record.sampler.problem, problem, label);
      else assert.equal(record.sampler.problem, null, label);
      assert.equal(
        alive(launches[0].sampler),
        false,
        `${label}: the sampler exited`,
      );
    }
});

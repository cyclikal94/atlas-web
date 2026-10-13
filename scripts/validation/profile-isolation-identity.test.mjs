// Who a load sample attributes work to (WEB-09c revision 8; review 8 R1, family profiling-isolation-window; design assessment DA-I1, DA-I2,
// DA-Q1, A1 to A3 and Q1 to Q4). The Air programme's 113 non-isolated cells came from two boundaries: the nested contention driver sampled
// from its own pid, so the launcher's `caffeinate -is` helper (a child of the programme's process) was a foreign sibling, and the
// transport's status reader was heavy work because its data argument named an `atlas-runner` directory. Every case states the processes it
// expects as explicit sets, independently of `attribute`:
//
//   * ownership (pure): the invocation root's tree, its ancestors (not their other children), genuine siblings and other requests;
//   * support identity (pure): a launcher's pinned status reader against same-path, same-executable, re-hashed, over-age, expired and
//     child processes, and the pin's own validation; no executable, interpreter, path or spelling is exempt by itself;
//   * delegation (pure and native): a nested driver takes the invocation's context only from a claim whose root is its live ancestor with
//     the recorded start;
//   * the launched topology (native, macOS): the public driver and its delegated contention stage under the real `/usr/bin/caffeinate -is`,
//     with a genuine sibling and a status reader held alive across the stage's first and final samples by a pipe (no sleep decides the
//     overlap), with and without the launcher's support pin; the sampler's lifetime against its owner's and its root's death; readiness that
//     a stale sample line cannot satisfy;
//   * the evidence pipeline (synthetic packages): stage context and sample identity through the contract, the projection and the strict
//     validator, with a healthy control and each missing, forged or inconsistent identity.
//
// `ATLAS_TOOLING_ROOT` points every case at another copy of the repository (the qualification runner's mutated copies); by default they are
// this repository's own.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(
  process.env.ATLAS_TOOLING_ROOT ??
    join(fileURLToPath(new URL(".", import.meta.url)), "../.."),
);
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const isolation = await load("scripts/lib/profile-isolation.mjs");
const evidence = await load("scripts/lib/profile-evidence.mjs");
const contract = await load("scripts/lib/profile-contract.mjs");
const programme = await load(
  "scripts/validation/profile-programme-fixture.mjs",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = (t) => {
  // realpath: macOS's TMPDIR is under /var, a link to /private/var; the claim records the canonical directory.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atlas-isolation-id-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sorted = (list) => [...list].sort((a, b) => a - b);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** `ps lstart` (C locale, single-spaced) of a local time. */
const lstartOf = (ms) => {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
};
const NOW = Date.parse("2026-10-12T21:01:35.000Z");
const START = lstartOf(NOW - 600_000);
const row = (pid, ppid, pcpu, command, started = START) => ({
  pid,
  ppid,
  pcpu,
  started,
  command,
});

// ---- the Air topology, as a process table -------------------------------------------------------------------------------------------------
const JOB = "/Users/runner/atlas-runner/profiles/profile-x";
const EVIDENCE = `${JOB}/evidence/profiling`;
const STATUS_SCRIPT = `${JOB}/inputs/profile_status.py`;
const LONG = `--trace ${"x".repeat(300)}`;
const topology = () => [
  row(1, 0, 0, "/sbin/launchd"),
  row(
    10,
    1,
    0.2,
    `/usr/bin/python3 ${JOB}/inputs/profile_worker.py --worker ${JOB}`,
  ),
  row(
    20,
    10,
    40,
    `/opt/node/bin/node scripts/profile-sync.mjs --evidence ${EVIDENCE}`,
  ),
  row(
    21,
    20,
    0,
    `/usr/bin/caffeinate -is node scripts/profile-sync.mjs --evidence ${EVIDENCE}`,
  ),
  row(
    30,
    20,
    5,
    `/opt/node/bin/node ${JOB}/source/scripts/profile-contention.mjs --skip-build --evidence ${EVIDENCE}`,
  ),
  row(
    31,
    30,
    0.1,
    `/opt/node/bin/node ${JOB}/source/scripts/lib/profile-isolation.mjs --sample --out ${EVIDENCE}/isolation/contention.jsonl`,
  ),
  row(
    32,
    30,
    60,
    `/opt/node/bin/node ${JOB}/source/node_modules/@playwright/test/cli.js test`,
  ),
  row(40, 10, 70, "/opt/node/bin/node node_modules/.bin/vitest run"),
  row(49, 1, 0, "/usr/sbin/sshd-session runner@notty"),
  row(50, 49, 0, `python3 - ${JOB}`),
  row(
    60,
    1,
    2,
    `/opt/node/bin/node /Users/runner/atlas-runner/jobs/other/node_modules/@playwright/test/cli.js test ${LONG}`,
  ),
  row(70, 1, 0, "/Applications/Safari.app/Contents/MacOS/Safari"),
];
const foreignOf = (rows, rootPid, options) =>
  sorted(isolation.attribute(rows, rootPid, options).foreign.map((r) => r.pid));

test("case: attributed by the invocation root, the launcher's caffeinate helper and the delegated stage are this run's; the worker's other child, an unpinned status reader and another request are foreign", () => {
  const rows = topology();
  const seen = isolation.attribute(rows, 20, { at: NOW });
  assert.deepEqual(foreignOf(rows, 20, { at: NOW }), [40, 50, 60]);
  assert.deepEqual(
    sorted(seen.mine),
    [1, 10, 20, 21, 30, 31, 32],
    "the root's tree and its ancestors, not the ancestors' other children",
  );
  assert.deepEqual(
    seen.support,
    [],
    "without a pin nothing outside the tree is support",
  );
  const reasons = Object.fromEntries(seen.foreign.map((r) => [r.pid, r.heavy]));
  assert.deepEqual(reasons, {
    40: "vitest",
    50: "atlas-runner",
    60: "atlas-runner",
  });
});

test("control: the review's reproduction holds against the unchanged classifier: from the delegate's own pid the helper is foreign, and widening to the worker absorbs its genuine sibling", () => {
  const rows = topology();
  assert.deepEqual(
    foreignOf(rows, 30, { at: NOW }),
    [21, 40, 50, 60],
    "the original R1 state: the helper is a foreign sibling",
  );
  assert.deepEqual(
    foreignOf(rows, 10, { at: NOW }),
    [50, 60],
    "the rejected alternative: the worker's other child is absorbed",
  );
});

test("case: no executable, interpreter, path or spelling is exempt by itself: a foreign caffeinate, another invocation's sampler and a same-path reader stay foreign", () => {
  const rows = [
    ...topology(),
    row(
      80,
      1,
      0,
      `/usr/bin/caffeinate -is node scripts/profile-sync.mjs --evidence /Users/runner/atlas-runner/profiles/other/evidence`,
    ),
    row(
      81,
      1,
      0,
      `/opt/node/bin/node /Users/runner/atlas-runner/profiles/other/source/scripts/lib/profile-isolation.mjs --sample --out x`,
    ),
    row(82, 1, 0, `/bin/cat ${JOB}/state.json`),
  ];
  assert.deepEqual(foreignOf(rows, 20, { at: NOW }), [40, 50, 60, 80, 81, 82]);
});

test("case: a sample records its context and the identities behind its verdict, the whole foreign command beside the truncated display", () => {
  const context = isolation.isolationContext({
    invocation: "inv-1",
    evidenceDir: EVIDENCE,
    rootPid: 20,
    rootStarted: START,
  });
  const sample = isolation.sampleLoad(context, {
    stage: "contention",
    owner: { pid: 30, started: START },
    rows: topology(),
    now: NOW,
    samplerPid: 31,
  });
  assert.equal(sample.error, undefined, sample.error);
  assert.equal(sample.method, isolation.METHOD_VERSION);
  assert.deepEqual(sample.context, {
    invocation: "inv-1",
    stage: "contention",
    root_pid: 20,
    root_started: START,
  });
  assert.equal(sample.sampler_pid, 31);
  assert.equal(sample.owner_pid, 30);
  assert.deepEqual(sorted(sample.foreign.map((f) => f.pid)), [40, 50, 60]);
  const other = sample.foreign.find((f) => f.pid === 60);
  assert.ok(other.command.endsWith(LONG), "the record keeps the whole command");
  assert.equal(sample.foreign_heavy.length, 3);
  assert.ok(
    sample.foreign_heavy.every((f) => f.length <= 220),
    "the display stays truncated",
  );
  assert.ok(
    sample.own.some(([pid, , started]) => pid === 20 && started === START),
    "the root, by pid and start, is in the own tree",
  );
  assert.ok(
    sample.own.some(([pid]) => pid === 21),
    "the helper is in the own tree",
  );
});

test("case: a sample whose root is not the recorded process, or whose owner has gone or left the root's tree, is an error that stops its sampler", () => {
  const context = isolation.isolationContext({
    invocation: "inv-1",
    evidenceDir: EVIDENCE,
    rootPid: 20,
    rootStarted: START,
  });
  const take = (rows, owner = { pid: 30, started: START }) =>
    isolation.sampleLoad(context, {
      stage: "contention",
      owner,
      rows,
      now: NOW,
      samplerPid: 31,
    });
  const reused = take(
    topology().map((r) =>
      r.pid === 20 ? { ...r, started: lstartOf(NOW - 5_000) } : r,
    ),
  );
  assert.equal(reused.ended, "root");
  assert.match(reused.error, /invocation root 20 .* is now a process started/);
  const gone = take(topology().filter((r) => r.pid !== 20));
  assert.equal(gone.ended, "root");
  assert.match(gone.error, /is gone/);
  const ownerGone = take(topology().filter((r) => r.pid !== 30));
  assert.equal(ownerGone.ended, "owner");
  assert.match(ownerGone.error, /stage owner 30 .* is gone/);
  const ownerReused = take(topology(), {
    pid: 30,
    started: lstartOf(NOW - 1_000),
  });
  assert.equal(ownerReused.ended, "owner");
  const outside = take(topology(), { pid: 70, started: START });
  assert.equal(outside.ended, "owner");
  assert.match(outside.error, /not in the tree of the invocation root 20/);
});

// ---- the launcher's support pin -----------------------------------------------------------------------------------------------------------
const STATUS_BYTES =
  "import json,sys\nprint(json.dumps({'status':'running'}))\n";
const pinFor = (overrides = {}) =>
  isolation.parseSupport({
    schema: isolation.SUPPORT_SCHEMA,
    request: "profile-x",
    roles: [
      {
        role: "status-reader",
        executables: [
          "/usr/bin/python3",
          "/Library/Developer/CommandLineTools/usr/bin/python3",
        ],
        args: [STATUS_SCRIPT, JOB],
        script: { arg: 0, sha256: sha(STATUS_BYTES) },
        max_lifetime_s: 30,
      },
    ],
    ...overrides,
  });
const hashOf = (bytes) => (path) =>
  path === STATUS_SCRIPT ? sha(bytes) : null;
const reader = (
  pid,
  command = `/usr/bin/python3 ${STATUS_SCRIPT} ${JOB}`,
  started = lstartOf(NOW - 1_000),
  pcpu = 35,
) => row(pid, 49, pcpu, command, started);

test("case: the pinned status reader is support, recorded with its role, script hash, age and CPU, and is not foreign", () => {
  const rows = [...topology().filter((r) => r.pid !== 50), reader(90)];
  const seen = isolation.attribute(rows, 20, {
    support: pinFor(),
    at: NOW,
    hashOf: hashOf(STATUS_BYTES),
  });
  assert.deepEqual(sorted(seen.foreign.map((r) => r.pid)), [40, 60]);
  assert.deepEqual(
    seen.support.map((r) => [r.pid, r.role, r.script_sha256, r.age_s]),
    [[90, "status-reader", sha(STATUS_BYTES), 1]],
  );
  assert.equal(seen.support_cpu_percent, 35, "support work stays visible");
});

test("case: what merely resembles the reader stays foreign: stdin Python, another executable, another job, an extra argument, a re-hashed script, an over-age or expired reader, and the reader's own child", () => {
  const variants = [
    ["stdin Python naming the job", reader(91, `python3 - ${JOB}`), undefined],
    [
      "the same script under an unpinned interpreter",
      reader(92, `/opt/homebrew/bin/python3 ${STATUS_SCRIPT} ${JOB}`),
      undefined,
    ],
    [
      "the pinned interpreter running another script",
      reader(93, `/usr/bin/python3 ${JOB}/inputs/other.py ${JOB}`),
      undefined,
    ],
    [
      "another job",
      reader(
        94,
        `/usr/bin/python3 ${STATUS_SCRIPT} /Users/runner/atlas-runner/profiles/other`,
      ),
      undefined,
    ],
    [
      "an extra argument",
      reader(95, `/usr/bin/python3 ${STATUS_SCRIPT} ${JOB} --loop`),
      undefined,
    ],
    ["a re-hashed script", reader(96), /hashes to/, hashOf(`${STATUS_BYTES}#`)],
    ["an unreadable script", reader(97), /cannot be read/, () => null],
    [
      "an over-age reader",
      reader(98, undefined, lstartOf(NOW - 40_000)),
      /longer than its 30 s lifetime/,
    ],
    [
      "an expired pin",
      reader(99),
      /expired/,
      undefined,
      pinFor({ not_after: new Date(NOW - 1).toISOString() }),
    ],
    [
      "an unknown start",
      reader(100, undefined, "not a time"),
      /start is unknown/,
    ],
  ];
  for (const [name, candidate, refused, hash, pin] of variants) {
    const rows = [...topology().filter((r) => r.pid !== 50), candidate];
    const seen = isolation.attribute(rows, 20, {
      support: pin ?? pinFor(),
      at: NOW,
      hashOf: hash ?? hashOf(STATUS_BYTES),
    });
    assert.deepEqual(
      sorted(seen.foreign.map((r) => r.pid)),
      sorted([40, 60, candidate.pid]),
      name,
    );
    assert.deepEqual(seen.support, [], name);
    const record = seen.foreign.find((r) => r.pid === candidate.pid);
    if (refused) assert.match(record.support_refused ?? "", refused, name);
    else assert.equal(record.support_refused, undefined, name);
  }
  const child = row(
    101,
    90,
    80,
    "/opt/node/bin/node node_modules/.bin/vitest run",
  );
  const withChild = isolation.attribute(
    [...topology().filter((r) => r.pid !== 50), reader(90), child],
    20,
    {
      support: pinFor(),
      at: NOW,
      hashOf: hashOf(STATUS_BYTES),
    },
  );
  assert.deepEqual(
    sorted(withChild.foreign.map((r) => r.pid)),
    [40, 60, 101],
    "a support process's children are not inherited",
  );
  assert.deepEqual(
    withChild.support.map((r) => r.pid),
    [90],
  );
});

test("case: an invalid support pin is refused with its reason", () => {
  const good = pinFor();
  const role = good.roles[0];
  const bad = {
    "a relative executable": { roles: [{ ...role, executables: ["python3"] }] },
    "a token with white space": {
      roles: [{ ...role, args: [STATUS_SCRIPT, "a b"] }],
    },
    "a script argument out of range": {
      roles: [{ ...role, script: { arg: 2, sha256: role.script.sha256 } }],
    },
    "a relative script": {
      roles: [
        {
          ...role,
          args: ["status.py", JOB],
          script: { arg: 0, sha256: role.script.sha256 },
        },
      ],
    },
    "no hash": { roles: [{ ...role, script: { arg: 0, sha256: "x" } }] },
    "an unbounded lifetime": { roles: [{ ...role, max_lifetime_s: 3600 }] },
    "another schema": { schema: "atlas-profile-support/0" },
    "no roles": { roles: [] },
  };
  for (const [name, change] of Object.entries(bad))
    assert.throws(
      () => isolation.parseSupport({ ...good, ...change }),
      /invalid support pin/,
      name,
    );
  assert.throws(
    () => isolation.supportFromEnv({ ATLAS_PROFILE_SUPPORT: "{" }),
    SyntaxError,
  );
  assert.equal(isolation.supportFromEnv({}), null);
});

// ---- delegation (pure) -------------------------------------------------------------------------------------------------------------------
test("case: a nested driver takes the context only from a claim whose root is its live ancestor with the recorded start, for this directory", (t) => {
  const dir = scratch(t);
  const context = isolation.isolationContext({
    invocation: "inv-1",
    evidenceDir: dir,
    rootPid: 20,
    rootStarted: START,
  });
  const holder = {
    invocation: "inv-1",
    pid: 20,
    pid_started: START,
    isolation_context: context,
  };
  const rows = topology();
  const problems = (h, self = 30, r = rows, d = dir) =>
    evidence.delegationProblems(d, "inv-1", h, r, self).join(" | ");
  assert.equal(problems(holder), "", "the contention delegate under the root");
  assert.equal(problems(holder, 32), "", "any descendant of the root");
  assert.match(problems(holder, 40), /not an ancestor of this process 40/);
  assert.match(
    problems(
      holder,
      30,
      rows.map((r) => (r.pid === 20 ? { ...r, started: lstartOf(NOW) } : r)),
    ),
    /now a process started/,
  );
  assert.match(
    problems(
      holder,
      30,
      rows.filter((r) => r.pid !== 20),
    ),
    /is gone/,
  );
  assert.match(
    problems({ invocation: "inv-1", pid: 20 }),
    /no valid isolation context/,
  );
  assert.match(
    problems({
      ...holder,
      isolation_context: { ...context, invocation: "inv-2" },
    }),
    /belongs to invocation inv-2/,
  );
  assert.match(
    problems({ ...holder, pid_started: lstartOf(NOW) }),
    /root is not the claim holder/,
  );
  const other = join(dir, "other");
  mkdirSync(other);
  assert.match(problems(holder, 30, rows, other), /names .* not /);
});

// ---- the launched topology (native) -------------------------------------------------------------------------------------------------------
const darwin =
  process.platform === "darwin" && existsSync("/usr/bin/caffeinate");
/** A `pnpm` first on PATH that fails every command at once (so a stage's action ends right after its sampler's first sample). */
const failingPnpm = (dir) => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pnpm"), `#!${process.execPath}\nprocess.exit(1);\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  return `${bin}${delimiter}${process.env.PATH}`;
};
/** A process held alive until `release()` closes its stdin: the overlap is a barrier, not a sleep. */
const held = (args, env = process.env) => {
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "ignore", "ignore"],
    env,
  });
  const exited = new Promise((r) => child.once("exit", r));
  return {
    pid: child.pid,
    release: async () => {
      child.stdin.end();
      child.kill("SIGTERM");
      await exited;
    },
  };
};
const HOLD =
  "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
/** The Air's layout in a scratch directory: an `atlas-runner` job with inputs/ (the reader's script) and evidence/profiling. */
const job = (t) => {
  const base = scratch(t);
  const jobDir = join(base, "atlas-runner", "profiles", "profile-test");
  mkdirSync(join(jobDir, "inputs"), { recursive: true });
  const script = join(jobDir, "inputs", "status-reader.mjs");
  writeFileSync(script, HOLD);
  return { base, jobDir, script, out: join(jobDir, "evidence", "profiling") };
};
const supportPin = (j) => ({
  schema: isolation.SUPPORT_SCHEMA,
  request: "profile-test",
  roles: [
    {
      role: "status-reader",
      executables: [process.execPath],
      args: [j.script, j.jobDir],
      script: { arg: 0, sha256: sha(readFileSync(j.script)) },
      max_lifetime_s: 120,
    },
  ],
});
const lines = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
/**
 * Runs `node scripts/profile-sync.mjs --evidence <job>/evidence/profiling --only <stage>` under `/usr/bin/caffeinate -is`, as the
 * transport does, beside a genuine sibling (`vitest` in its arguments) and the status reader, both started first and held until the run
 * has ended. Returns the stage's samples, record, claim record and the held pids.
 */
async function launched(t, stage, { pin = false } = {}) {
  const j = job(t);
  const sibling = held(["-e", HOLD, "vitest-sibling"]);
  const observer = held([j.script, j.jobDir]);
  try {
    const env = { ...process.env, PATH: failingPnpm(j.base) };
    delete env.ATLAS_PROFILE_CLAIM;
    if (pin) env.ATLAS_PROFILE_SUPPORT = JSON.stringify(supportPin(j));
    else delete env.ATLAS_PROFILE_SUPPORT;
    const run = spawnSync(
      "/usr/bin/caffeinate",
      [
        "-is",
        process.execPath,
        "scripts/profile-sync.mjs",
        "--evidence",
        j.out,
        "--only",
        stage,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 180_000 },
    );
    assert.equal(run.signal, null, `${run.stdout}${run.stderr}`);
    assert.notEqual(
      run.status,
      0,
      "the failing pnpm ends the stage's action with a failure",
    );
    const writers = readdirSync(join(j.out, "writers"));
    assert.equal(
      writers.length,
      1,
      `one finished invocation: ${run.stdout}${run.stderr}`,
    );
    const claim = JSON.parse(
      readFileSync(join(j.out, "writers", writers[0]), "utf8"),
    );
    const record = JSON.parse(
      readFileSync(join(j.out, "stages", `${stage}.json`), "utf8"),
    );
    const samples = lines(join(j.out, "isolation", `${stage}.jsonl`));
    return {
      j,
      claim,
      record,
      samples,
      sibling: sibling.pid,
      observer: observer.pid,
    };
  } finally {
    await sibling.release();
    await observer.release();
  }
}
/** What every sample of a launched stage must show: the claim's root, the helper owned, the sibling foreign, the reader foreign or support. */
function expectLaunched(
  { claim, record, samples, sibling, observer },
  { delegated, pin },
) {
  const context = claim.isolation_context;
  assert.equal(context.root.pid, claim.pid, "the claim holder is the root");
  assert.equal(context.root.started, claim.pid_started);
  assert.deepEqual(
    record.isolation_context,
    context,
    "the stage records the invocation's context",
  );
  if (delegated)
    assert.notEqual(
      record.sampler.owner_pid,
      claim.pid,
      "the delegate owns the sampler",
    );
  else assert.equal(record.sampler.owner_pid, claim.pid);
  assert.ok(samples.length >= 2, "a first and a final sample");
  assert.equal(samples.at(-1).final, true);
  for (const s of samples) {
    assert.equal(s.error, undefined, s.error);
    assert.equal(s.sampler_pid, record.sampler.pid);
    assert.equal(s.context.root_pid, claim.pid);
    const foreign = s.foreign.map((f) => f.pid);
    assert.ok(foreign.includes(sibling), "the genuine sibling is foreign");
    const helper = s.own.filter(
      ([, ppid, , , executable]) =>
        ppid === claim.pid && executable === "/usr/bin/caffeinate",
    );
    assert.equal(
      helper.length,
      1,
      `the launcher's helper (a child of the root) is in the own tree: ${JSON.stringify(s.own)}`,
    );
    assert.ok(
      !foreign.includes(helper[0][0]),
      `the helper is not foreign: ${JSON.stringify(s.foreign)}`,
    );
    if (pin) {
      assert.ok(
        !foreign.includes(observer),
        "the pinned reader is not foreign",
      );
      assert.deepEqual(
        s.support.map((x) => [x.pid, x.role]),
        [[observer, "status-reader"]],
      );
    } else {
      assert.ok(foreign.includes(observer), "an unpinned reader is foreign");
      assert.deepEqual(s.support, []);
    }
  }
  assert.equal(
    isolation.sampleIdentityProblem({
      context: record.isolation_context,
      invocation: record.invocation,
      stage: record.stage,
      sampler: record.sampler,
      rows: samples,
    }),
    null,
    "the contract's identity check accepts what the sampler wrote",
  );
}

test("case: native macOS: the public driver's own stage under caffeinate owns the helper; the sibling and an unpinned reader are foreign", {
  skip: !darwin,
}, async (t) => {
  expectLaunched(await launched(t, "bundle"), { delegated: false, pin: false });
});

test("case: native macOS: the delegated contention stage samples by the invocation root: the helper is owned, the sibling and an unpinned reader are foreign", {
  skip: !darwin,
}, async (t) => {
  expectLaunched(await launched(t, "contention"), {
    delegated: true,
    pin: false,
  });
});

test("case: native macOS: with the launcher's support pin the held status reader is support in the delegated stage, and the sibling stays foreign", {
  skip: !darwin,
}, async (t) => {
  expectLaunched(await launched(t, "contention", { pin: true }), {
    delegated: true,
    pin: true,
  });
});

/** A claim file written by hand, as an interrupted or forged holder would leave it. */
const forgeClaim = (dir, holder) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, evidence.CLAIM_FILE),
    `${JSON.stringify(holder, null, 2)}\n`,
  );
};
const listing = (dir) => readdirSync(dir).sort();

test("case: native: the contention driver refuses a delegated claim whose root is not its ancestor, was restarted, or carries no context, and writes nothing", (t) => {
  const base = scratch(t);
  const started = isolation.processStart(process.pid);
  const sibling = spawnSync(
    process.execPath,
    ["-e", "console.log(process.pid)"],
    { encoding: "utf8" },
  );
  const unrelated = Number(sibling.stdout.trim());
  const variants = {
    "a root that is not this driver's ancestor": (dir) => {
      const other = spawn(process.execPath, ["-e", HOLD], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      t.after(() => other.kill("SIGTERM"));
      const otherStarted = isolation.processStart(other.pid);
      return {
        holder: {
          invocation: "inv-forged",
          pid: other.pid,
          pid_started: otherStarted,
          isolation_context: isolation.isolationContext({
            invocation: "inv-forged",
            evidenceDir: dir,
            rootPid: other.pid,
            rootStarted: otherStarted,
          }),
        },
        expect: /is not an ancestor of this process/,
      };
    },
    "the right pid with another start (a reused pid)": (dir) => ({
      holder: {
        invocation: "inv-forged",
        pid: process.pid,
        pid_started: lstartOf(Date.now() - 86_400_000),
        isolation_context: isolation.isolationContext({
          invocation: "inv-forged",
          evidenceDir: dir,
          rootPid: process.pid,
          rootStarted: lstartOf(Date.now() - 86_400_000),
        }),
      },
      expect: /is now a process started/,
    }),
    "a claim without a context (written before revision 8)": () => ({
      holder: {
        invocation: "inv-forged",
        pid: process.pid,
        started_at: new Date().toISOString(),
      },
      expect: /no valid isolation context/,
    }),
    "a gone root": (dir) => ({
      holder: {
        invocation: "inv-forged",
        pid: unrelated,
        pid_started: started,
        isolation_context: isolation.isolationContext({
          invocation: "inv-forged",
          evidenceDir: dir,
          rootPid: unrelated,
          rootStarted: started,
        }),
      },
      expect: /is gone|now a process started/,
    }),
  };
  for (const [name, make] of Object.entries(variants)) {
    const dir = join(base, name.replace(/\W+/g, "-"));
    mkdirSync(dir, { recursive: true });
    const { holder, expect } = make(realpathSync(dir));
    forgeClaim(dir, holder);
    const before = listing(dir);
    const run = spawnSync(
      process.execPath,
      [
        join(root, "scripts/profile-contention.mjs"),
        "--skip-build",
        "--evidence",
        dir,
      ],
      {
        cwd: root,
        // A failing pnpm first on PATH: a claim wrongly admitted fails its stage at once (exit 1), never starting a real server.
        env: {
          ...process.env,
          ATLAS_PROFILE_CLAIM: "inv-forged",
          PATH: failingPnpm(base),
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(run.status, 2, `${name}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, expect, name);
    assert.deepEqual(listing(dir), before, `${name}: nothing was written`);
  }
});

/** A root that claims `dir` and runs `delegate.mjs` under its claim; the delegate starts a sampler and reports when it is ready. */
const ROOT_SCRIPT = (rootDir, dir) => `
import { spawn } from "node:child_process";
const { claimDirectory } = await import(${JSON.stringify(pathToFileURL(join(rootDir, "scripts/lib/profile-evidence.mjs")).href)});
const claim = claimDirectory(${JSON.stringify(dir)}, { stages: ["probe"], delegated: "" });
const child = spawn(process.execPath, [process.argv[2]], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ATLAS_PROFILE_CLAIM: claim.invocation } });
console.log(JSON.stringify({ root: process.pid, delegate: child.pid }));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;
const DELEGATE_SCRIPT = (rootDir, dir) => `
const { claimDirectory } = await import(${JSON.stringify(pathToFileURL(join(rootDir, "scripts/lib/profile-evidence.mjs")).href)});
const { startLoadSampler } = await import(${JSON.stringify(pathToFileURL(join(rootDir, "scripts/lib/profile-isolation.mjs")).href)});
const claim = claimDirectory(${JSON.stringify(dir)}, { stages: ["probe"] });
const sampler = await startLoadSampler(${JSON.stringify(dir)}, "probe", { context: claim.context, intervalMs: 250 });
console.log(JSON.stringify({ sampler: sampler.pid, ready: sampler.ready }));
setInterval(() => {}, 1000);
`;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits, by condition, until `check()` holds (bounded: a stuck sampler fails the case, it never passes it). */
const until = async (check, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
async function delegatedSampler(t) {
  const base = scratch(t);
  const dir = join(base, "evidence");
  writeFileSync(join(base, "root.mjs"), ROOT_SCRIPT(root, dir));
  writeFileSync(join(base, "delegate.mjs"), DELEGATE_SCRIPT(root, dir));
  const env = { ...process.env };
  delete env.ATLAS_PROFILE_CLAIM;
  delete env.ATLAS_PROFILE_SUPPORT;
  const rootProcess = spawn(
    process.execPath,
    [join(base, "root.mjs"), join(base, "delegate.mjs")],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env,
    },
  );
  let out = "";
  rootProcess.stdout.on("data", (b) => {
    out += b;
  });
  t.after(() => {
    rootProcess.kill("SIGKILL");
  });
  const parsed = () =>
    out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  assert.ok(
    await until(() => parsed().length >= 2),
    `the delegate's sampler became ready: ${out}`,
  );
  const [{ root: rootPid, delegate }, { sampler, ready }] = parsed();
  t.after(() => {
    for (const pid of [delegate, sampler])
      if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.equal(ready, true);
  return { dir, rootPid, delegate, sampler, rootProcess };
}

test("case: native: a delegated sampler stops with an error sample, never a final one, when its owner dies while the root lives", async (t) => {
  const { dir, rootPid, delegate, sampler } = await delegatedSampler(t);
  const first = lines(join(dir, "isolation/probe.jsonl"))[0];
  assert.equal(
    first.context.root_pid,
    rootPid,
    "the delegate samples by the root",
  );
  assert.equal(first.owner_pid, delegate);
  process.kill(delegate, "SIGKILL");
  assert.ok(
    await until(() => !alive(sampler)),
    "the sampler ended after its owner",
  );
  assert.ok(alive(rootPid), "while the root still runs");
  const last = lines(join(dir, "isolation/probe.jsonl")).at(-1);
  assert.equal(last.ended, "owner");
  assert.match(last.error, /stage owner .* is gone/);
  assert.notEqual(last.final, true);
});

test("case: native: a delegated sampler stops with an error sample when its root dies while its owner lives", async (t) => {
  const { dir, rootPid, delegate, sampler, rootProcess } =
    await delegatedSampler(t);
  rootProcess.kill("SIGKILL");
  assert.ok(
    await until(() => !alive(sampler)),
    "the sampler ended after its root",
  );
  assert.ok(alive(delegate), "while its owner still runs");
  const last = lines(join(dir, "isolation/probe.jsonl")).at(-1);
  assert.equal(last.ended, "root");
  assert.match(last.error, new RegExp(`invocation root ${rootPid} .* is gone`));
});

test("case: native: a sampler is ready only on its own first sample: a stale valid line already in the file, or no context, never makes it ready", async (t) => {
  const dir = scratch(t);
  const context = isolation.directContext({
    invocation: "inv-stale",
    evidenceDir: dir,
  });
  const stale = isolation.sampleLoad(context, {
    stage: "probe",
    owner: { pid: process.pid, started: context.root.started },
    samplerPid: 1,
  });
  assert.equal(stale.error, undefined, stale.error);
  mkdirSync(join(dir, "isolation"), { recursive: true });
  writeFileSync(
    join(dir, "isolation/probe.jsonl"),
    `${JSON.stringify(stale)}\n`,
  );
  await assert.rejects(
    isolation.startLoadSampler(dir, "probe", {
      context,
      intervalMs: 200,
      readyWithinMs: 1_500,
    }),
    /wrote no valid first sample/,
  );
  await assert.rejects(
    isolation.startLoadSampler(dir, "probe2", { intervalMs: 200 }),
    /no valid isolation context/,
  );
  let ran = false;
  const status = await evidence.runStage(
    dir,
    "unbound",
    async () => {
      ran = true;
      return 0;
    },
    {
      sample: (d, s, c) => isolation.startLoadSampler(d, s, { context: c }),
      invocation: "inv-stage",
      context,
      extra: { root },
    },
  );
  assert.equal(status, 1);
  assert.equal(
    ran,
    false,
    "a stage sampled by another invocation's context does not run",
  );
  const record = JSON.parse(
    readFileSync(join(dir, "stages/unbound.json"), "utf8"),
  );
  assert.match(
    record.failure,
    /no isolation context of its invocation inv-stage/,
  );
});

// ---- the evidence pipeline (synthetic packages) -------------------------------------------------------------------------------------------
const P10 = "P-10 sync page duration_ms (proxy delay 250 ms)[webkit]";
const P2 = "P-2 dense-100 wall_ms[chromium]";
const writeComplete = (dir) =>
  programme.writeProgramme(dir, { candidate: evidence.candidate(root) });
const resolveDir = (dir) => contract.resolveEvidence(dir);
const cell = (r, id) => {
  const found = r.cells.find((c) => c.id === id);
  assert.ok(found, `no cell ${id}`);
  return found;
};
const editJson = (file, change) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(change(value) ?? value, null, 2)}\n`);
};
const editSamples = (dir, stage, change) => {
  const file = join(dir, "isolation", `${stage}.jsonl`);
  const rows = lines(file).map((s, i, all) => change(s, i, all) ?? s);
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
};
const SYN_JOB = "/Users/runner/atlas-runner/profiles/profile-syn";
const SYN_SCRIPT = `${SYN_JOB}/inputs/profile_status.py`;
const SYN_SHA = sha("synthetic status reader");
const synPin = () =>
  isolation.parseSupport({
    schema: isolation.SUPPORT_SCHEMA,
    request: "profile-syn",
    roles: [
      {
        role: "status-reader",
        executables: ["/usr/bin/python3"],
        args: [SYN_SCRIPT, SYN_JOB],
        script: { arg: 0, sha256: SYN_SHA },
        max_lifetime_s: 30,
      },
    ],
  });
/** The reader, 1 s old at the sample, with the recorded script hash. */
const synReader = (at, pcpu = 0) => ({
  pid: 7001,
  ppid: 7000,
  pcpu,
  started: lstartOf(Date.parse(at) - 1_000),
  command: `/usr/bin/python3 ${SYN_SCRIPT} ${SYN_JOB}`,
});
/** The reader as a FOREIGN process (no pin): its display string and its record. */
const asForeign = (s, reader) => ({
  ...s,
  foreign_heavy: [
    ...s.foreign_heavy,
    `${reader.pid} ${reader.ppid} ${reader.pcpu} ${reader.command}`,
  ],
  foreign: [...s.foreign, { ...reader, heavy: "atlas-runner" }],
});
const asSupport = (s, reader) => ({
  ...s,
  support: [
    { ...reader, role: "status-reader", script_sha256: SYN_SHA, age_s: 1 },
  ],
  support_cpu_percent: reader.pcpu,
});

test("control: the synthetic programme's samples are bound to its stages' contexts and every judged cell is ok", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const r = resolveDir(dir);
  assert.equal(r.complete, true);
  assert.equal(cell(r, P10).status, "ok");
  assert.equal(cell(r, P10).isolation.verdict, "clean");
  assert.equal(cell(r, P2).status, "ok");
});

test("case: each missing, forged or inconsistent sample identity leaves its stage's cells unknown, and no other stage's", (t) => {
  const breakers = {
    "a stage without a context (recorded before revision 8)": [
      (dir) =>
        editJson(join(dir, "stages/integration.json"), (v) => {
          delete v.isolation_context;
        }),
      /carries no isolation context/,
    ],
    "a context of another invocation": [
      (dir) =>
        editJson(join(dir, "stages/integration.json"), (v) => {
          v.isolation_context.invocation = "inv-other";
        }),
      /belongs to invocation inv-other/,
    ],
    "an invalid context": [
      (dir) =>
        editJson(join(dir, "stages/integration.json"), (v) => {
          v.isolation_context.root.started = "";
        }),
      /isolation context is invalid/,
    ],
    "a stage without its sampler's pid": [
      (dir) =>
        editJson(join(dir, "stages/integration.json"), (v) => {
          delete v.sampler.pid;
        }),
      /does not identify its sampler process/,
    ],
    "a first sample that is not the ready one": [
      (dir) =>
        editJson(join(dir, "stages/integration.json"), (v) => {
          v.sampler.ready_at = "2026-01-01T00:00:00.000Z";
        }),
      /not the one the sampler was ready with/,
    ],
    "a sample of another method": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40 ? { ...s, method: "process-tree/0" } : s,
        ),
      /taken under method process-tree\/0/,
    ],
    "a sample of another root start (a reused pid)": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40
            ? {
                ...s,
                context: { ...s.context, root_started: lstartOf(Date.now()) },
              }
            : s,
        ),
      /another invocation, stage or root/,
    ],
    "a sample of another stage": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40 ? { ...s, context: { ...s.context, stage: "fixture" } } : s,
        ),
      /another invocation, stage or root/,
    ],
    "a sample of another sampler process": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40 ? { ...s, sampler_pid: 1 } : s,
        ),
      /written by process 1/,
    ],
    "a sample without its identity records (the display strings only)": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40 ? { ...s, foreign: undefined } : s,
        ),
      /does not record the identities/,
    ],
    "a sample whose own tree lacks the root": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40 ? { ...s, own: s.own.slice(1) } : s,
        ),
      /does not show the invocation root/,
    ],
    "a foreign process in the display but not in the records": [
      (dir) =>
        editSamples(dir, "integration", (s, i) =>
          i === 40
            ? { ...asForeign(s, synReader(s.at)), foreign: s.foreign }
            : s,
        ),
      /different foreign processes/,
    ],
    "support the context does not authorise (no pin)": [
      (dir) =>
        editSamples(dir, "integration", (s) => asSupport(s, synReader(s.at))),
      /records support work its context does not authorise/,
    ],
  };
  for (const [name, [breakIt, basis]] of Object.entries(breakers)) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    breakIt(dir);
    const r = resolveDir(dir);
    const c = cell(r, P10);
    assert.equal(c.status, "not_isolated", name);
    assert.equal(c.isolation.verdict, "unknown", name);
    assert.match(c.isolation.basis, basis, name);
    assert.equal(r.complete, false, name);
    assert.equal(
      cell(r, P2).status,
      "ok",
      `${name}: another stage is not affected`,
    );
  }
});

test("case: a stage recorded under contract version 2 (the Air attempt's) is not evidence of version 3", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editJson(join(dir, "stages/integration.json"), (v) => {
    v.contract_version = 2;
  });
  const r = resolveDir(dir);
  assert.equal(r.complete, false);
  assert.ok(
    r.cells.some(
      (c) =>
        c.stage === "integration" &&
        c.reasons.join(" ").includes("recorded under contract 2, not 3"),
    ),
    "the stage's own cell names the contract version",
  );
});

test("case: an unpinned idle status reader overlapping the integration stage leaves P-10 idle_foreign, and the strict validator refuses the hand-over", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editSamples(dir, "integration", (s) => asForeign(s, synReader(s.at)));
  const r = resolveDir(dir);
  assert.equal(cell(r, P10).status, "not_isolated");
  assert.equal(cell(r, P10).isolation.verdict, "idle_foreign");
  assert.equal(cell(r, P2).status, "ok");
  const assembled = spawnSync(
    process.execPath,
    [
      join(root, "scripts/profile-sync.mjs"),
      "--evidence",
      dir,
      "--only",
      "handoff",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  assert.equal(assembled.status, 0, `${assembled.stdout}${assembled.stderr}`);
  const results = JSON.parse(
    readFileSync(join(dir, "handoff/results.json"), "utf8"),
  );
  assert.equal(results.acceptance_scope.desktop_decision.supports, false);
  const validated = spawnSync(
    process.execPath,
    [
      join(root, "scripts/validate-profile-handoff.mjs"),
      "--handoff",
      join(dir, "handoff"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  assert.equal(validated.status, 1, `${validated.stdout}${validated.stderr}`);
  assert.match(`${validated.stdout}${validated.stderr}`, /not isolated/);
});

test("case: the same reader under the launcher's pin is support: P-10 is clean, the support is recorded beside the verdict, and the strict validator accepts the hand-over", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editJson(join(dir, "stages/integration.json"), (v) => {
    v.isolation_context.support = synPin();
  });
  editSamples(dir, "integration", (s) => asSupport(s, synReader(s.at, 35)));
  const r = resolveDir(dir);
  const c = cell(r, P10);
  assert.equal(c.status, "ok");
  assert.equal(c.isolation.verdict, "clean");
  assert.ok(c.isolation.support_samples > 0, "the support samples are counted");
  assert.equal(c.isolation.peak_support_cpu_percent, 35);
  const copy = join(scratch(t), "q");
  cpSync(dir, copy, { recursive: true });
  // The same support beside genuine foreign work is still contaminated.
  editSamples(copy, "integration", (s) =>
    asForeign(s, {
      pid: 9001,
      ppid: 1,
      pcpu: 180,
      started: s.support[0].started,
      command: "node vitest run",
    }),
  );
  assert.equal(cell(resolveDir(copy), P10).isolation.verdict, "contaminated");
  const assembled = spawnSync(
    process.execPath,
    [
      join(root, "scripts/profile-sync.mjs"),
      "--evidence",
      dir,
      "--only",
      "handoff",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  assert.equal(assembled.status, 0, `${assembled.stdout}${assembled.stderr}`);
  const validated = spawnSync(
    process.execPath,
    [
      join(root, "scripts/validate-profile-handoff.mjs"),
      "--handoff",
      join(dir, "handoff"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  assert.equal(validated.status, 0, `${validated.stdout}${validated.stderr}`);
});

test("case: a support record the pin does not authorise as recorded (over-age, another script hash, another command) is unknown, not clean", (t) => {
  const variants = {
    "over-age": (s) => ({
      ...synReader(s.at),
      started: lstartOf(Date.parse(s.at) - 60_000),
    }),
    "another script hash": (s) => synReader(s.at),
    "another command": (s) => ({
      ...synReader(s.at),
      command: `/usr/bin/python3 ${SYN_SCRIPT} ${SYN_JOB} --loop`,
    }),
  };
  for (const [name, make] of Object.entries(variants)) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    editJson(join(dir, "stages/integration.json"), (v) => {
      v.isolation_context.support = synPin();
    });
    editSamples(dir, "integration", (s) => {
      const record = asSupport(s, make(s));
      if (name === "another script hash")
        record.support[0].script_sha256 = sha("edited");
      return record;
    });
    const c = cell(resolveDir(dir), P10);
    assert.equal(c.status, "not_isolated", name);
    assert.match(c.isolation.basis, /does not authorise/, name);
  }
});

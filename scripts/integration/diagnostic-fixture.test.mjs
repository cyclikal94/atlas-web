// WEB-09c revision 26 (R26-DIAG; design assessment Q2/Q3): the diagnostic adapter's protocol state machine (deterministic streams) and its
// owned lifecycle (the protocol stand-in diagnostic-fake.mjs as a real child process: never the backend, never backend evidence).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createJournal } from "./causal-journal.mjs";
import {
  acquireGuard,
  CommandFailed,
  childEnvironment,
  concludeAttempt,
  continuationOf,
  controlCall,
  createControl,
  createControlServer,
  finishAttempt,
  Latched,
  launchArguments,
  launchAttempt,
  MATERIALISED_FILES,
  materialiseRetained,
  OWNERSHIP_LOST_LATCHES,
  ownedSource,
  parseLine,
  preserveFixture,
  readyProblems,
  removeParentIfEmpty,
  retentionDeps,
  verifyRetained,
} from "./diagnostic-fixture.mjs";

const FAKE = new URL("./diagnostic-fake.mjs", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "diag-test-"));
const flush = () => new Promise((r) => setImmediate(r));
const settled = async (p) => {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
};
/** Bounded: a promise a mutant leaves unsettled yields `{ timedOut: true }` (an assertion then fails), never a hung test. */
const within = (p, ms = 3000) => {
  let timer;
  return Promise.race([
    settled(p).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    }),
  ]);
};

/** A control over in-memory streams; `written` collects what the adapter wrote to stdin; time and timers are manual. */
function streams(options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written = [];
  stdin.on("data", (d) => written.push(String(d)));
  const timers = [];
  const entries = [];
  const control = createControl({
    input: stdin,
    output: stdout,
    errors: stderr,
    attempt: "a1",
    record: (e) => entries.push(e),
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    cancel: (t) => {
      if (t) t.live = false;
    },
    ...options,
  });
  const emit = (v) =>
    stdout.write(`${typeof v === "string" ? v : JSON.stringify(v)}\n`);
  const fire = (ms) => {
    for (const t of timers)
      if (t.live && t.ms === ms) {
        t.live = false;
        t.fn();
      }
  };

  return { control, stdin, stdout, stderr, written, emit, fire, entries };
}
const READY = {
  event: "ready",
  receipt: { attempt: "a1" },
  receipt_sha256: "x",
};
const ok = (seq, op, extra = {}) => ({
  attempt: "a1",
  seq,
  op,
  ok: true,
  result: {},
  effect: op === "inspect" ? "none" : "applied",
  sync_now: 1,
  ...extra,
});

test("protocol: ready split across chunks, then one command answered exactly; the sequence advances only on a written line", async () => {
  const s = streams();
  const line = JSON.stringify(READY);
  s.stdout.write(line.slice(0, 5));
  s.stdout.write(line.slice(5, 20));
  s.stdout.write(`${line.slice(20)}\n`);
  assert.equal((await s.control.ready).event, "ready");
  const sent = s.control.send("inspect", {});
  await flush();
  assert.deepEqual(JSON.parse(s.written[0]), {
    attempt: "a1",
    seq: 1,
    op: "inspect",
    args: {},
  });
  s.emit(ok(1, "inspect"));
  assert.equal((await sent).seq, 1);
  assert.equal(s.control.state().next, 2);
  assert.equal(s.control.latched(), null);
  assert.deepEqual(
    s.entries.map((e) => [e.n, e.stream]),
    [
      [1, "stdout"],
      [2, "stdin"],
      [3, "stdout"],
    ],
  );
});

test("protocol: one command at a time; an over-long command is refused locally and consumes no sequence number", async () => {
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  assert.throws(
    () => s.control.send("age_history", { batches: ["x".repeat(9000)] }),
    /over 8192 bytes; nothing was sent/,
  );
  assert.equal(s.control.state().next, 1);
  assert.equal(s.written.length, 0);
  const first = s.control.send("inspect", {});
  assert.throws(() => s.control.send("inspect", {}), /still outstanding/);
  s.emit(ok(1, "inspect"));
  await first;
  assert.equal(s.control.state().next, 2);
});

test("protocol: an accepted failure with effect none consumes its sequence number and does not latch", async () => {
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  const p = s.control.send("advance_clock", { time: 0 });
  s.emit({
    attempt: "a1",
    seq: 1,
    op: "advance_clock",
    ok: false,
    error: "the sync time only advances",
    effect: "none",
    sync_now: 1,
  });
  const r = await within(p);
  assert.ok(r.error instanceof CommandFailed);
  assert.equal(s.control.latched(), null);
  assert.equal(s.control.state().next, 2);
});

for (const [name, answer, kind] of [
  [
    "a failure with an unknown effect",
    {
      attempt: "a1",
      seq: 1,
      op: "collect",
      ok: false,
      error: "x",
      effect: "unknown",
      sync_now: 1,
    },
    "ambiguous_effect",
  ],
  [
    "a partial collection",
    {
      attempt: "a1",
      seq: 1,
      op: "collect",
      ok: false,
      error: "x",
      effect: "partial",
      partial: {},
      sync_now: 1,
    },
    "ambiguous_effect",
  ],
  [
    "an answer with ownership lost",
    {
      attempt: "a1",
      seq: 1,
      op: "collect",
      ok: false,
      error: "lost",
      effect: "none",
      ownership_lost: true,
      sync_now: 1,
    },
    "ownership_lost",
  ],
  [
    "a success with the wrong effect",
    ok(1, "collect", { effect: "none" }),
    "unexpected_effect",
  ],
  [
    "an answer to another sequence number",
    ok(2, "collect"),
    "unexpected_output",
  ],
  [
    "an answer of another attempt",
    ok(1, "collect", { attempt: "a2" }),
    "unexpected_output",
  ],
  ["an answer of another operation", ok(1, "inspect"), "unexpected_output"],
  [
    "a rejection of the line we sent",
    {
      event: "rejected",
      attempt: "a1",
      seq: 1,
      error: "expected attempt a1 seq 2",
    },
    "rejected",
  ],
  [
    "an ownership-lost event",
    {
      event: "ownership_lost",
      error: "fixture database replaced",
      stopping: true,
    },
    "ownership_lost",
  ],
  [
    "a failed event",
    { event: "failed", error: "the HTTP server stopped", stopping: true },
    "failed",
  ],
  [
    "a stop nobody asked for",
    {
      event: "stopped",
      attempt: "a1",
      seq: null,
      served: true,
      removed: null,
      cleanup_error: null,
    },
    "unexpected_stop",
  ],
  ["malformed output", "not json", "malformed_output"],
]) {
  test(`protocol: ${name} LATCHES the attempt and nothing more is sent`, async () => {
    const s = streams();
    s.emit(READY);
    await s.control.ready;
    const p = s.control.send("collect", { time: 1 });
    s.emit(answer);
    const r = await within(p);
    assert.ok(r.error, "the command does not resolve");
    assert.equal(s.control.latched()?.kind, kind);
    assert.throws(() => s.control.send("inspect", {}), Latched);
    assert.equal(s.written.length, 1, "nothing was re-sent");
  });
}

test("protocol: no acknowledgement within the bound latches and the command is NEVER re-sent; a late answer cannot revive it", async () => {
  const s = streams({ timeoutMs: 1234 });
  s.emit(READY);
  await s.control.ready;
  const p = s.control.send("advance_clock", { time: 2 });
  s.fire(1234);
  const r = await within(p);
  assert.ok(r.error instanceof Latched);
  assert.equal(s.control.latched().kind, "no_acknowledgement");
  s.emit(ok(1, "advance_clock"));
  await flush();
  assert.equal(s.control.latched().kind, "no_acknowledgement");
  assert.equal(s.written.length, 1);
});

test("protocol: a refused HTTP admission on stderr latches; ordinary log lines do not", async () => {
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  s.stderr.write(
    '{"event":"diagnostic_http","phase":"admitted","method":"GET","path":"/x"}\nplain server log line\n',
  );
  await flush();
  assert.equal(s.control.latched(), null);
  s.stderr.write(
    '{"event":"diagnostic_http","phase":"refused","method":"GET","path":"/x"}\n',
  );
  await flush();
  assert.equal(s.control.latched()?.kind, "http_refused");
});

test("protocol: the first line must be ready; failed or anything else latches the ready promise", async () => {
  for (const [first, kind] of [
    [{ event: "failed", error: "refusing inherited configuration" }, "failed"],
    [ok(1, "inspect"), "protocol"],
  ]) {
    const s = streams();
    s.emit(first);
    const r = await within(s.control.ready);
    assert.ok(r.error instanceof Latched);
    assert.equal(s.control.latched().kind, kind);
  }
  const s = streams({ readyTimeoutMs: 777 });
  s.fire(777);
  assert.equal((await within(s.control.ready)).error?.kind, "no_ready");
});

test("protocol: stdout ending before a stopped event latches (an early exit)", async () => {
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  const p = settled(s.control.send("inspect", {}));
  s.stdout.end();
  await flush();
  assert.ok((await p).error instanceof Latched);
  assert.equal(s.control.latched().kind, "exited");
});

test("protocol: shutdown is answered by ITS stopped event; a latched attempt may stop but never remove", async () => {
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  const p = s.control.shutdown(true);
  s.emit({
    event: "stopped",
    attempt: "a1",
    seq: 1,
    served: true,
    removed: ["fixture.sqlite", "receipt.json"],
    cleanup_error: null,
  });
  assert.equal((await p).served, true);
  assert.equal(s.control.state().phase, "stopped");
  const t = streams();
  t.emit(READY);
  await t.control.ready;
  const q = t.control.send("collect", { time: 1 });
  t.emit({
    attempt: "a1",
    seq: 1,
    op: "collect",
    ok: false,
    error: "x",
    effect: "unknown",
    sync_now: 1,
  });
  await within(q);
  assert.throws(() => t.control.shutdown(true), /keeps its fixture/);
  const stop = t.control.shutdown(false);
  t.emit({
    event: "stopped",
    attempt: "a1",
    seq: 2,
    served: true,
    removed: null,
    cleanup_error: null,
  });
  assert.equal((await stop).seq, 2);
});

test("parseLine keeps u64 file identities exactly (beyond 2^53)", () => {
  const v = parseLine(
    '{"receipt":{"fixture_dir":{"dev":18446744073709551615,"ino":9007199254740993},"pid":7}}',
  );
  assert.equal(v.receipt.fixture_dir.dev, "18446744073709551615");
  assert.equal(v.receipt.fixture_dir.ino, "9007199254740993");
  assert.equal(v.receipt.pid, 7);
});

test("childEnvironment passes only the allow-list and refuses to pass any ATLAS_ name", () => {
  let env;
  assert.doesNotThrow(() => {
    env = childEnvironment({
      PATH: "/bin",
      HOME: "/h",
      ATLAS_IT_abc: "1",
      ATLAS_DATABASE_URL: "x",
      OTHER: "y",
    });
  }, "the runner's own ATLAS_ variables are simply not passed");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  assert.throws(
    () => childEnvironment({ ATLAS_X: "1" }, ["ATLAS_X"]),
    /refusing to pass ATLAS_X/,
  );
});

test("launchArguments: a loopback literal bind, a canonical loopback origin, a safe absolute path and attempt id", () => {
  assert.deepEqual(
    launchArguments({
      fixtureDir: "/t/f",
      attempt: "a-1",
      publicOrigin: "http://127.0.0.1:5000",
    }),
    [
      "--fixture-dir",
      "/t/f",
      "--attempt",
      "a-1",
      "--bind",
      "127.0.0.1:0",
      "--public-origin",
      "http://127.0.0.1:5000",
    ],
  );
  assert.throws(
    () =>
      launchArguments({
        fixtureDir: "t/f",
        attempt: "a",
        publicOrigin: "http://127.0.0.1:1",
      }),
    /absolute/,
  );
  assert.throws(
    () =>
      launchArguments({
        fixtureDir: "/t/f g",
        attempt: "a",
        publicOrigin: "http://127.0.0.1:1",
      }),
    /absolute/,
  );
  assert.throws(
    () =>
      launchArguments({
        fixtureDir: "/t/f",
        attempt: "a.b",
        publicOrigin: "http://127.0.0.1:1",
      }),
    /attempt id/,
  );
  assert.throws(
    () =>
      launchArguments({
        fixtureDir: "/t/f",
        attempt: "a",
        publicOrigin: "http://localhost:1",
      }),
    /loopback origin/,
  );
  assert.throws(
    () =>
      launchArguments({
        fixtureDir: "/t/f",
        attempt: "a",
        publicOrigin: "http://127.0.0.1:1/",
      }),
    /canonical/,
  );
});

test("continuationOf reads an issued continuation's header and nothing else", () => {
  const token = `d2.${(5).toString(16).padStart(16, "0")}.${(1800000000).toString(16).padStart(16, "0")}.${(9).toString(16).padStart(16, "0")}.${(3).toString(16).padStart(8, "0")}.0000abcd.${"f".repeat(64)}`;
  assert.deepEqual(continuationOf(token), {
    boundary: 5,
    expiry: 1800000000,
    revision: 9,
    index: 3,
  });
  assert.equal(continuationOf("d1.x.y"), null);
  assert.equal(continuationOf(token.toUpperCase()), null);
  assert.equal(continuationOf(`${token}.x`), null);
});

// ---- the lifecycle, with the protocol stand-in as a real child --------------------------------------------------------------------
const statId = (p) => {
  const s = statSync(p, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino) };
};
/** The adapter's child environment for a test launch, ASSERTED free of ATLAS_ names (a mutant that leaks one fails here, by assertion). */
const cleanEnv = () => {
  let env;
  assert.doesNotThrow(() => {
    env = childEnvironment();
  }, "no ATLAS_ variable is passed to the child");
  return env;
};
/** Every stand-in child a lifecycle test started: killed in its `finally`, so a failed assertion never leaves one holding the run open. */
const children = new Set();
const reap = () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  children.clear();
};
function lifecycleDeps(mode, entries) {
  return {
    spawn: (command, args, options) => {
      const child = spawn(
        process.execPath,
        [command, "--fake-mode", mode, ...args],
        options,
      );
      children.add(child);
      return child;
    },
    realpath: realpathSync,
    exists: existsSync,
    stat: statId,
    readFile: readFileSync,
    record: (e) => entries.push(e),
  };
}
async function launch(mode, parent, overrides = {}) {
  const entries = [];
  const { createHash } = await import("node:crypto");
  const running = await launchAttempt(lifecycleDeps(mode, entries), {
    executable: FAKE,
    executableSha256: createHash("sha256")
      .update(readFileSync(FAKE))
      .digest("hex"),
    fixtureParent: parent,
    attempt: "att-1",
    publicOrigin: "http://127.0.0.1:5000",
    apiVersion: "0.30.0",
    features: { "sync-diagnostic": true, "test-hooks": false },
    env: "env" in overrides ? overrides.env : cleanEnv(),
    ...overrides,
  });
  return { running, entries };
}

test("lifecycle: launch → ready receipt verified against the files → setup and clock commands → graceful owned shutdown removes exactly the fixture", async () => {
  const parent = tmp();
  process.env.ATLAS_IT_lifecycletest = "1";
  try {
    const { running, entries } = await launch("normal", parent, {
      env: cleanEnv(),
    });
    assert.deepEqual(running.problems, []);
    assert.ok(
      !running.env.some((k) => k.startsWith("ATLAS_")),
      "no ATLAS_ variable reached the child",
    );
    assert.ok(existsSync(join(running.fixtureDir, "receipt.json")));
    const account = await running.control.send("add_account", {
      username: "u",
      password: "p",
    });
    assert.match(account.result.account, /^0{8}-/);
    await running.control.send("advance_clock", {
      time: running.ready.receipt.sync_start + 10,
    });
    const refused = await within(
      running.control.send("add_account", { username: "v", password: "p" }),
    );
    assert.ok(
      refused.error instanceof CommandFailed,
      "setup ended at the first clock step",
    );
    const done = await finishAttempt(running, { remove: true });
    assert.equal(done.stopped.served, true);
    assert.deepEqual(done.stopped.removed, ["fixture.sqlite", "receipt.json"]);
    assert.deepEqual(done.exit, { code: 0, signal: null });
    assert.equal(done.latched, null);
    assert.equal(existsSync(running.fixtureDir), false);
    assert.deepEqual(removeParentIfEmpty({ rmdir: rmdirSync }, parent), {
      removed: true,
      error: null,
    });
    assert.ok(
      entries.some(
        (e) => e.stream === "stdin" && e.line.includes('"shutdown"'),
      ),
    );
  } finally {
    delete process.env.ATLAS_IT_lifecycletest;
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lifecycle: an inherited ATLAS_ variable is refused by the executable (the adapter never passes one)", async () => {
  const parent = tmp();
  try {
    const r = await within(
      launch("normal", parent, {
        env: { ...cleanEnv(), ATLAS_IT_x: "1" },
      }),
    );
    assert.ok(r.error instanceof Latched);
    assert.equal(r.error.kind, "failed");
    assert.match(r.error.detail, /refusing inherited configuration/);
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lifecycle: an existing fixture leaf is refused before anything is launched", async () => {
  const parent = tmp();
  try {
    writeFileSync(join(parent, "fixture-att-1"), "someone else's");
    const r = await within(launch("normal", parent));
    assert.match(String(r.error?.message), /already exists/);
    assert.equal(
      readFileSync(join(parent, "fixture-att-1"), "utf8"),
      "someone else's",
    );
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

for (const [mode, expect] of [
  ["wrong-attempt", /receipt attempt/],
  ["test-hooks", /receipt features/],
]) {
  test(`lifecycle: a ready receipt that is not this attempt's is a problem (${mode})`, async () => {
    const parent = tmp();
    try {
      const { running } = await launch(mode, parent);
      assert.ok(
        running.problems.some((p) => expect.test(p)),
        running.problems.join(" | "),
      );
      const done = await finishAttempt(running, { remove: false });
      assert.equal(
        done.stopped.removed,
        null,
        "an unverified fixture is kept, not removed",
      );
    } finally {
      reap();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("lifecycle: readyProblems refuses a receipt whose file or identities differ from the ready event", async () => {
  const parent = tmp();
  try {
    const { running } = await launch("normal", parent);
    const expected = {
      attempt: "att-1",
      pid: running.child.pid,
      fixtureDir: running.fixtureDir,
      executable: {
        path: realpathSync(FAKE),
        sha256: running.ready.receipt.executable.sha256,
      },
      apiVersion: "0.30.0",
      publicOrigin: "http://127.0.0.1:5000",
      features: { "sync-diagnostic": true, "test-hooks": false },
      retentionSeconds: 7776000,
    };
    const good = {
      receiptBytes: running.receiptBytes,
      dir: statId(running.fixtureDir),
      database: statId(join(running.fixtureDir, "fixture.sqlite")),
    };
    assert.deepEqual(readyProblems(running.ready, expected, good), []);
    assert.ok(
      readyProblems(running.ready, expected, {
        ...good,
        receiptBytes: Buffer.concat([running.receiptBytes, Buffer.from(" ")]),
      }).some((p) => /receipt\.json hashes/.test(p)),
    );
    assert.ok(
      readyProblems(running.ready, expected, {
        ...good,
        database: { dev: "1", ino: "2" },
      }).some((p) => /database file's identity/.test(p)),
    );
    // Each identity field on its own: a replaced file on the same device differs only by inode.
    for (const [key, at] of [
      ["dir", running.fixtureDir],
      ["database", join(running.fixtureDir, "fixture.sqlite")],
    ]) {
      const same = statId(at);
      assert.ok(
        readyProblems(running.ready, expected, {
          ...good,
          [key]: { ...same, ino: `${same.ino}9` },
        }).length > 0,
        `${key}: another inode on the same device`,
      );
      assert.ok(
        readyProblems(running.ready, expected, {
          ...good,
          [key]: { ...same, dev: `${same.dev}9` },
        }).length > 0,
        `${key}: the same inode on another device`,
      );
    }
    assert.ok(
      readyProblems(running.ready, { ...expected, pid: 1 }, good).some((p) =>
        /receipt pid/.test(p),
      ),
    );
    assert.ok(
      readyProblems(
        running.ready,
        { ...expected, publicOrigin: "http://127.0.0.1:5001" },
        good,
      ).some((p) => /public origin/.test(p)),
    );
    assert.ok(
      readyProblems(
        running.ready,
        {
          ...expected,
          executable: { ...expected.executable, sha256: "0".repeat(64) },
        },
        good,
      ).some((p) => /executable sha256/.test(p)),
    );
    await finishAttempt(running, { remove: true });
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lifecycle: an ownership loss latches; the fixture is never removed and finish records the executable's own stop", async () => {
  const parent = tmp();
  try {
    const { running } = await launch("lose-collect", parent);
    const r = await within(
      running.control.send("collect", {
        time: running.ready.receipt.sync_start,
      }),
    );
    assert.ok(r.error instanceof Latched);
    const done = await finishAttempt(running, { remove: true });
    assert.equal(done.latched.kind, "ownership_lost");
    assert.equal(
      existsSync(running.fixtureDir),
      true,
      "a lost fixture is left for its owner",
    );
    assert.equal(
      removeParentIfEmpty({ rmdir: rmdirSync }, parent).removed,
      false,
      "the parent is never removed recursively",
    );
    assert.equal(existsSync(join(running.fixtureDir, "receipt.json")), true);
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lifecycle: a missing acknowledgement latches; finish closes stdin (EOF) instead of sending more, and the fixture is kept", async () => {
  const parent = tmp();
  try {
    const { running } = await launch("no-ack-advance_clock", parent, {
      timeoutMs: 300,
    });
    const r = await within(
      running.control.send("advance_clock", {
        time: running.ready.receipt.sync_start + 1,
      }),
    );
    assert.equal(r.error?.kind, "no_acknowledgement");
    const done = await finishAttempt(running, { remove: true });
    assert.equal(done.eof, true);
    assert.equal(done.latched.kind, "no_acknowledgement");
    assert.equal(existsSync(running.fixtureDir), true);
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lifecycle: served:false and a replacement file in the fixture are reported, never hidden; the replacement survives", async () => {
  const parent = tmp();
  try {
    const { running } = await launch("served-false", parent);
    writeFileSync(join(running.fixtureDir, "someone-elses-file"), "keep me");
    const done = await finishAttempt(running, { remove: true });
    assert.equal(done.stopped.served, false);
    assert.match(
      String(done.stopped.cleanup_error),
      /not empty; left in place/,
    );
    assert.equal(
      readFileSync(join(running.fixtureDir, "someone-elses-file"), "utf8"),
      "keep me",
    );
    assert.equal(
      removeParentIfEmpty({ rmdir: rmdirSync }, parent).removed,
      false,
    );
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---- the spec's bridge ---------------------------------------------------------------------------------------------------------------
test("bridge: only the spec's operations, only with the attempt's secret, each call recorded with its sequence number", async () => {
  const parent = tmp();
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  const calls = [];
  const socketPath = join(parent, "c.sock");
  const server = createControlServer({
    control: s.control,
    socketPath,
    token: "secret",
    onCall: (c) => calls.push(c),
  });
  await server.listen();
  try {
    const at = { socketPath, token: "secret" };
    assert.equal(
      (
        await within(
          controlCall({ socketPath, token: "wrong" }, "POST", "/command", {
            op: "inspect",
          }),
        )
      ).value?.status,
      401,
    );
    assert.equal(
      (
        await within(
          controlCall(at, "POST", "/command", {
            op: "add_account",
            args: {},
          }),
        )
      ).value?.status,
      403,
    );
    assert.equal(
      (
        await within(
          controlCall(at, "POST", "/command", {
            op: "shutdown",
            args: { remove: true },
          }),
        )
      ).value?.status,
      403,
    );
    assert.equal(s.written.length, 0, "nothing refused reached the executable");
    const pending = controlCall(at, "POST", "/command", {
      op: "inspect",
      args: {},
    });
    for (let i = 0; i < 50 && s.written.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    s.emit(ok(1, "inspect"));
    const answered = (await within(pending)).value;
    assert.equal(answered?.status, 200);
    assert.equal(answered?.body.answer.seq, 1);
    assert.deepEqual(
      calls.map((c) => [c.op, c.seq, c.outcome]),
      [["inspect", 1, "ok"]],
    );
    const failing = controlCall(at, "POST", "/command", {
      op: "advance_clock",
      args: { time: 0 },
    });
    for (let i = 0; i < 50 && s.written.length === 1; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    s.emit({
      attempt: "a1",
      seq: 2,
      op: "advance_clock",
      ok: false,
      error: "only advances",
      effect: "none",
      sync_now: 1,
    });
    assert.equal((await within(failing)).value?.status, 409);
    assert.equal(calls.at(-1).outcome, "CommandFailed");
  } finally {
    await server.close();
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---- revision 27 (R27-DIAG.a): the control and the bridge record into the attempt's causal journal ---------------------------------
test("journal: every transcript line is a journal event of its own (control.<stream>, its n), in the order the control saw them", async () => {
  const lines = [];
  const journal = createJournal({
    attempt: "a1",
    append: (l) => lines.push(JSON.parse(l)),
  });
  const s = streams({ journal });
  s.emit(READY);
  await s.control.ready;
  const pending = s.control.send("inspect", {});
  s.emit(ok(1, "inspect"));
  await pending;
  s.stderr.write("a log line\n");
  await flush();
  assert.deepEqual(
    s.entries.map((e) => [e.n, e.j, e.stream]),
    [
      [1, 1, "stdout"],
      [2, 2, "stdin"],
      [3, 3, "stdout"],
      [4, 4, "stderr"],
    ],
  );
  assert.deepEqual(
    lines.map((l) => [l.j, l.producer, l.kind, l.ref.n]),
    [
      [1, "control", "stdout", 1],
      [2, "control", "stdin", 2],
      [3, "control", "stdout", 3],
      [4, "control", "stderr", 4],
    ],
  );
  assert.deepEqual(lines[1].ref, { n: 2, seq: 1, op: "inspect" });
});
test("journal: without one, the transcript is as before (no positions)", async () => {
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  assert.equal(s.entries[0].j, undefined);
});
test("bridge: a call is bracketed in the journal (call → command → acknowledgement → answer); a marker is positioned when received", async () => {
  const parent = tmp();
  const events = [];
  const journal = createJournal({
    attempt: "a1",
    append: (l) => events.push(JSON.parse(l)),
  });
  const s = streams({ journal });
  s.emit(READY);
  await s.control.ready;
  const calls = [];
  const marks = [];
  const socketPath = join(parent, "c.sock");
  const server = createControlServer({
    control: s.control,
    socketPath,
    token: "secret",
    journal,
    onCall: (c) => calls.push(c),
    onMark: (m) => marks.push(m),
  });
  await server.listen();
  try {
    const at = { socketPath, token: "secret" };
    const m1 = (
      await within(controlCall(at, "POST", "/mark", { name: "x0:probe:begin" }))
    ).value;
    assert.equal(m1?.status, 200);
    const pending = controlCall(at, "POST", "/command", {
      op: "inspect",
      args: {},
    });
    for (let i = 0; i < 50 && s.written.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    s.emit(ok(1, "inspect"));
    const answered = (await within(pending)).value;
    assert.equal(answered?.status, 200);
    const m2 = (
      await within(controlCall(at, "POST", "/mark", { name: "x0:probe:end" }))
    ).value;
    const kinds = events.map((e) => `${e.producer}.${e.kind}`);
    assert.deepEqual(kinds, [
      "control.stdout",
      "bridge.mark",
      "bridge.call",
      "control.stdin",
      "control.stdout",
      "bridge.answer",
      "bridge.mark",
    ]);
    assert.equal(m1.body.j, 2);
    assert.equal(m2.body.j, 7);
    assert.deepEqual(
      [
        calls[0].j_request,
        calls[0].j_answer,
        answered.body.j_request,
        answered.body.j_answer,
      ],
      [3, 6, 3, 6],
    );
    assert.deepEqual(events[5].ref, { op: "inspect", seq: 1, outcome: "ok" });
    assert.deepEqual(
      marks.map((x) => [x.name, x.j]),
      [
        ["x0:probe:begin", 2],
        ["x0:probe:end", 7],
      ],
    );
    // A malformed marker name is refused and positions nothing.
    const bad = (
      await within(controlCall(at, "POST", "/mark", { name: "Not A Name" }))
    ).value;
    assert.equal(bad?.status, 400);
    assert.equal(events.length, 7);
  } finally {
    await server.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
test("bridge: without a journal a marker is refused (409), never answered with a made-up position", async () => {
  const parent = tmp();
  const s = streams();
  s.emit(READY);
  await s.control.ready;
  const socketPath = join(parent, "c.sock");
  const server = createControlServer({
    control: s.control,
    socketPath,
    token: "t",
  });
  await server.listen();
  try {
    const r = (
      await within(
        controlCall({ socketPath, token: "t" }, "POST", "/mark", {
          name: "x0:a",
        }),
      )
    ).value;
    assert.equal(r?.status, 409);
  } finally {
    await server.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---- revision 27 (DA-DIAG-F; design assessment Q4): the evidence is judged BEFORE the removal is decided --------------------------
/**
 * concludeAttempt with recording fakes: what was asked of `finish`, and in which order the steps ran.
 * Revision 35 (labelled adaptation): the order arrays below now include the two new steps (`guard` before `preserve`, `release` after
 * `finish`); every earlier step, its position relative to the others and every verdict assertion are unchanged.
 */
async function conclude({
  transport = [],
  preliminary = [],
  latched = null,
  terminal = [],
  throwIn = null,
  // Revision 34: a ready anchor by default (the healthy composition); `null` composes no preservation step at all.
  preservation = { ready: true, problems: [], dir: "/retained", anchors: [] },
  // Revision 35: a held reader guard by default; `null` composes no guard step at all.
  held = { held: true, problems: [], record: { held: true } },
} = {}) {
  const order = [];
  const step =
    (name, value) =>
    async (...args) => {
      order.push(name);
      if (throwIn === name) throw new Error(`${name} broke`);
      return typeof value === "function" ? value(...args) : value;
    };
  let asked = null;
  const seen = {};
  const out = await concludeAttempt({
    stopTransports: step("stop", transport),
    preliminary: step("preliminary", preliminary),
    latched: () => {
      order.push("latched");
      return latched;
    },
    ...(held === null ? {} : { guard: step("guard", held) }),
    ...(preservation === null
      ? {}
      : {
          preserve: step("preserve", (guard) => {
            seen.preservedWith = guard;
            return typeof preservation === "function"
              ? preservation(guard)
              : preservation;
          }),
        }),
    finish: step("finish", (eligible) => {
      asked = eligible;
      return { requested_remove: eligible };
    }),
    release: step("release", (guard, finished) => {
      seen.released = { guard, finished };
      return { released: true, lost: false, problems: [] };
    }),
    materialise: step("materialise", (kept, finished, released) => {
      seen.materialised = { kept, finished, released };
      return { status: "verified", problems: [] };
    }),
    terminal: step("terminal", (finished, retention) => {
      seen.terminal = { finished, retention };
      return terminal;
    }),
  });
  return { out, order, asked, seen };
}
test("DA-DIAG-F: a healthy attempt is judged first, then asked to remove its fixture, then judged again", async () => {
  const { out, order, asked } = await conclude();
  assert.deepEqual(order, [
    "stop",
    "preliminary",
    "latched",
    "guard",
    "preserve",
    "finish",
    "release",
    "materialise",
    "terminal",
  ]);
  assert.equal(asked, true);
  assert.equal(out.eligible, true);
  assert.deepEqual(out.terminal, []);
});
for (const [name, opts] of [
  [
    "a browser pass with a missing or corrupt proof (a reader failure)",
    { preliminary: ["interval X: the causal proof cannot be read"] },
  ],
  [
    "a diagnostic 503 among the answers",
    { preliminary: ["an answer was 503"] },
  ],
  [
    "a transport that did not stop cleanly after the preliminary pass",
    { transport: ["tap stop: EBUSY"] },
  ],
  [
    "a latched control (ownership replaced, no acknowledgement)",
    { latched: { kind: "ownership_lost" } },
  ],
  ["a preliminary validation that threw", { throwIn: "preliminary" }],
  ["a transport stop that threw", { throwIn: "stop" }],
])
  test(`DA-DIAG-F: ${name} is NEVER asked to remove its fixture`, async () => {
    const { out, asked, order } = await conclude(opts);
    assert.equal(asked, false);
    assert.equal(out.eligible, false);
    // Every step still runs: the failure's evidence is complete (its fixture anchored too), and the terminal validation is made.
    assert.deepEqual(order, [
      "stop",
      "preliminary",
      "latched",
      "guard",
      "preserve",
      "finish",
      "release",
      "materialise",
      "terminal",
    ]);
  });
// Revision 34 (R34-RET): this verdict test proves only that the late failure stays a failure; the RETAINED CONTENT of such an attempt is
// asserted with the real SQLite stand-in below ("R34-RET with real SQLite: …"). Its retention oracle is now the materialised record handed
// to the terminal judgement, not the absence of a claim.
test("DA-DIAG-F: a terminal-only failure after a healthy removal request stays a failure (the retention made before it reaches the terminal judgement)", async () => {
  const { out, asked, seen } = await conclude({
    terminal: ["attempt: shutdown #9 was not answered by its stopped event"],
  });
  assert.equal(asked, true);
  assert.equal(out.eligible, true);
  assert.deepEqual(out.terminal, [
    "attempt: shutdown #9 was not answered by its stopped event",
  ]);
  assert.equal(out.finished.requested_remove, true);
  assert.equal(seen.materialised.kept.dir, "/retained");
  assert.equal(seen.materialised.finished.requested_remove, true);
  assert.equal(seen.terminal.retention.status, "verified");
  assert.equal(out.retention.status, "verified");
});
for (const [name, opts] of [
  ["no preservation step composed", { preservation: null }],
  [
    "a preservation that refused (the anchor is not ready)",
    {
      preservation: {
        ready: false,
        problems: ["anchoring fixture.sqlite: EXDEV"],
      },
    },
  ],
  [
    "a preservation claiming ready with a problem",
    {
      preservation: { ready: true, problems: ["receipt.json is not anchored"] },
    },
  ],
  ["a preservation that threw", { throwIn: "preserve" }],
  ["a preservation that returned nothing", { preservation: () => undefined }],
])
  test(`R34-RET: a healthy attempt with ${name} is NEVER asked to remove its fixture`, async () => {
    const { out, asked } = await conclude(opts);
    assert.equal(
      out.eligible,
      true,
      "the preliminary eligibility is unchanged",
    );
    assert.equal(asked, false);
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.ok(out.preservation_problems.length > 0, "the refusal is reported");
  });
test("DA-DIAG-F with the real stand-in child: a known preliminary failure keeps the fixture (remove:false is sent), its files survive", async () => {
  const parent = tmp();
  const retained = tmp();
  try {
    const { running } = await launch("normal", parent);
    assert.deepEqual(running.problems, []);
    const sentinel = join(running.fixtureDir, "receipt.json");
    const out = await concludeAttempt({
      stopTransports: async () => [],
      preliminary: async () => [
        "interval PAIR-X0.chromium.json: the causal proof cannot be read",
      ],
      latched: () => running.control.latched(),
      preserve: async () => preserveOf(running, retained),
      finish: (eligible) => finishAttempt(running, { remove: eligible }),
      terminal: async () => [],
    });
    assert.equal(out.eligible, false);
    assert.equal(out.finished.requested_remove, false);
    assert.equal(out.finished.stopped?.removed ?? null, null);
    assert.ok(existsSync(sentinel), "the retained fixture's files survive");
    assert.deepEqual(
      removeParentIfEmpty({ rmdir: rmdirSync }, parent).removed,
      false,
    );
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
    rmSync(retained, { recursive: true, force: true });
  }
});
test("DA-DIAG-F with the real stand-in child: an outstanding unanswered command ends by EOF and keeps the fixture", async () => {
  const parent = tmp();
  const retained = tmp();
  try {
    const { running } = await launch("no-ack-inspect", parent, {
      timeoutMs: 200,
    });
    const sent = within(running.control.send("inspect", {}), 2000);
    await sent;
    const out = await concludeAttempt({
      stopTransports: async () => [],
      preliminary: async () => [],
      latched: () => running.control.latched(),
      preserve: async () => preserveOf(running, retained),
      finish: (eligible) => finishAttempt(running, { remove: eligible }),
      terminal: async () => [],
    });
    assert.equal(out.eligible, false, "a latched control is not eligible");
    assert.equal(out.finished.eof, true);
    assert.ok(existsSync(join(running.fixtureDir, "receipt.json")));
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
    rmSync(retained, { recursive: true, force: true });
  }
});

// ---- revision 34 (R34-RET; design assessment Q1-Q5): the owned fixture survives the terminal judgement ------------------------------
// The SQLite stand-in (`sqlite:` modes of diagnostic-fake.mjs) keeps a REAL WAL-mode database with committed rows; the maintained
// preservation, shutdown, materialisation and verification are composed as the runner composes them. Stand-in evidence, never backend.
function preserveOf(
  running,
  retainedParent,
  deps = retentionDeps(),
  guard = null,
  latch = null,
) {
  return preserveFixture(deps, {
    fixtureDir: running.fixtureDir,
    receipt: running.ready.receipt,
    receiptSha256: running.ready.receipt_sha256,
    retainedParent,
    attempt: "att-1",
    guard: guard?.record ?? null,
    latch,
  });
}
/** Revision 35: the reader guard on the attempt's database, spawned as the runner spawns it (a child reaped with the others). */
const guardDeps = {
  spawn: (command, args, options) => {
    const child = spawn(command, args, options);
    children.add(child);
    return child;
  },
};
/**
 * Revision 36 (R36-RET): the guard is bound to the attempt's ready-receipt authority, as the runner binds it, with its private directory
 * in `privateParent` (the attempt's retained parent; never nested with the fixture's parent).
 */
const guardOf = (running, privateParent, options = {}) =>
  acquireGuard(guardDeps, {
    attempt: "att-1",
    fixtureDir: running.fixtureDir,
    receipt: running.ready.receipt,
    receiptSha256: running.ready.receipt_sha256,
    privateParent,
    ...options,
  });
const scratch = [];
const fresh = () => {
  const dir = tmp();
  scratch.push(dir);
  return dir;
};
const clean = () => {
  reap();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
};
/** The usernames committed in a database, read from a COPY (with its WAL when given) so the read never touches the original. */
async function usernamesOf(files) {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fresh();
  for (const [name, from] of Object.entries(files))
    writeFileSync(join(dir, name), readFileSync(from));
  const db = new DatabaseSync(join(dir, "fixture.sqlite"));
  try {
    return db
      .prepare("SELECT username FROM accounts ORDER BY username")
      .all()
      .map((r) => r.username);
  } finally {
    db.close();
  }
}
/** The inspectable copy's committed usernames; its recorded tables are ASSERTED first (a missing table is an assertion, not a crash). */
const inspectedUsernames = (retention) => {
  assert.deepEqual(
    retention?.inspect?.tables,
    { accounts: 2 },
    "the inspectable copy holds the two committed accounts",
  );
  return usernamesOf({
    "fixture.sqlite": join(retention.dir, "inspect.sqlite"),
  });
};
/** One real attempt of the SQLite stand-in with two committed accounts, concluded by the maintained composition. */
async function realAttempt(
  mode,
  {
    preliminary = [],
    terminalThrows = false,
    deps = retentionDeps(),
    beforePreserve = null,
    retainedParent = null,
    nest = false,
    kill = false,
    // Revision 35: the reader guard is composed as the runner composes it unless `guarded: false` (no guard step at all).
    guarded = true,
    afterGuard = null,
    // Revision 36: the latch the conclusion reads (default: the control's own) and a step run just before the shutdown is sent.
    latched = null,
    beforeFinish = null,
  } = {},
) {
  const parent = fresh();
  let retained = retainedParent ?? fresh();
  if (nest) {
    retained = join(parent, "inner");
    mkdirSync(retained);
  }
  const { running } = await launch(
    `sqlite:${mode}`,
    parent,
    // A short acknowledgement bound where one is expected to lapse (the unanswered command; the shutdown sent to a killed child): the
    // test judges retention, not that duration, and the maintained default is unchanged.
    mode.startsWith("no-ack") || kill ? { timeoutMs: 200 } : {},
  );
  assert.deepEqual(running.problems, []);
  for (const username of ["ada", "grace"])
    await running.control.send("add_account", { username, password: "p" });
  if (mode.startsWith("no-ack"))
    await within(running.control.send("inspect", {}), 2000);
  await beforePreserve?.(running, parent);
  // Bounded (as every lifecycle test here): a mutant that leaves the conclusion unsettled fails this assertion, never hangs the file.
  const settledConclusion = await within(
    concludeAttempt({
      stopTransports: async () => [],
      preliminary: async () => preliminary,
      latched: latched ?? (() => running.control.latched()),
      ...(guarded
        ? {
            guard: async (latch) => {
              const held = await guardOf(running, retained, { latch });
              await afterGuard?.(running, held);
              return held;
            },
          }
        : {}),
      preserve: async (guard, latch) => {
        const kept = preserveOf(running, retained, deps, guard, latch);
        if (kill) {
          running.child.kill("SIGKILL");
          await running.exited;
        }
        return kept;
      },
      finish: async (remove) => {
        await beforeFinish?.(running, remove);
        return finishAttempt(running, { remove });
      },
      release: (guard, finished) =>
        guard.release({
          exitObserved: finished?.exit !== null && finished?.exit !== undefined,
        }),
      materialise: (kept, finished, released) =>
        materialiseRetained(deps, kept, {
          exit: finished?.exit ?? null,
          stopped: finished?.stopped ?? null,
          receipt: running.ready.receipt,
          receiptSha256: running.ready.receipt_sha256,
          guard: released ?? null,
        }),
      terminal: async (finished, retention) => {
        if (terminalThrows)
          throw new Error("the saved evidence cannot be re-read");
        const problems = [];
        if (finished?.stopped?.served !== true)
          problems.push("stopped with served:false");
        if (finished?.exit?.code !== 0)
          problems.push(`exited ${JSON.stringify(finished?.exit)}`);
        problems.push(...verifyRetained(retentionDeps(), retention));
        return problems;
      },
    }),
    10_000,
  );
  assert.equal(settledConclusion.timedOut, undefined, "the conclusion settles");
  if (settledConclusion.error) throw settledConclusion.error;
  const out = settledConclusion.value;
  return { out, running, parent, retained };
}
const sourceRows = (running) =>
  usernamesOf({
    "fixture.sqlite": join(running.fixtureDir, "fixture.sqlite"),
    ...(existsSync(join(running.fixtureDir, "fixture.sqlite-wal"))
      ? {
          "fixture.sqlite-wal": join(running.fixtureDir, "fixture.sqlite-wal"),
        }
      : {}),
  });

test("R34-RET with real SQLite: a healthy attempt is removed only after its anchor; the verified retained copy holds the committed rows after the source is gone", async () => {
  try {
    const { out, running, parent, retained } = await realAttempt("normal");
    assert.equal(out.eligible, true);
    assert.equal(out.preserved, true);
    assert.equal(out.remove_requested, true);
    assert.deepEqual(out.terminal, []);
    assert.equal(
      existsSync(running.fixtureDir),
      false,
      "the executable removed its owned files",
    );
    assert.equal(out.retention.status, "verified");
    assert.equal(out.retention.dir, `${realpathSync(retained)}/retained-att-1`);
    assert.deepEqual(out.retention.inspect.tables, { accounts: 2 });
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
    const db = out.retention.anchors.find((a) => a.name === "fixture.sqlite");
    assert.equal(db.dev, running.ready.receipt.database.dev);
    assert.equal(db.ino, running.ready.receipt.database.ino);
    const manifest = JSON.parse(
      readFileSync(join(out.retention.dir, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.attempt, "att-1");
    assert.equal(manifest.receipt_sha256, running.ready.receipt_sha256);
    assert.deepEqual(manifest.database, {
      dev: running.ready.receipt.database.dev,
      ino: running.ready.receipt.database.ino,
    });
    assert.deepEqual(manifest.inspect.tables, { accounts: 2 });
    assert.deepEqual(manifest.quiescence.exit, { code: 0, signal: null });
    assert.deepEqual(
      removeParentIfEmpty({ rmdir: rmdirSync }, parent),
      { removed: true, error: null },
      "the retained directory is a sibling: the fixture's parent is still removed cleanly",
    );
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: served:false after a healthy removal request stays a failure AND its fixture is retained with the committed rows", async () => {
  try {
    const { out, running } = await realAttempt("served-false");
    assert.equal(out.remove_requested, true);
    assert.deepEqual(out.terminal, ["stopped with served:false"]);
    assert.equal(
      existsSync(running.fixtureDir),
      false,
      "removed by the executable, as the backend does on served:false",
    );
    assert.equal(out.retention.status, "verified");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: a terminal evidence-reader exception stays a failure AND the fixture is retained with the committed rows", async () => {
  try {
    const { out } = await realAttempt("normal", { terminalThrows: true });
    assert.equal(out.remove_requested, true);
    assert.equal(out.terminal.length, 1);
    assert.match(out.terminal[0], /the saved evidence cannot be re-read/);
    assert.equal(out.retention.status, "verified");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: rows committed only in the WAL (no checkpoint before the removal) are in the retained copy", async () => {
  try {
    const { out, running } = await realAttempt("unclosed");
    assert.equal(existsSync(running.fixtureDir), false);
    assert.ok(
      out.retention.anchors.some((a) => a.name === "fixture.sqlite-wal"),
      "the WAL was anchored",
    );
    assert.equal(out.retention.status, "verified");
    assert.deepEqual(out.retention.inspect.tables, { accounts: 2 });
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
    // The stimulus is meaningful: the anchored database alone, without its WAL, does not hold the rows.
    await assert.rejects(
      usernamesOf({
        "fixture.sqlite": join(out.retention.dir, "fixture.sqlite"),
      }),
      /no such table: accounts/,
    );
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: a preliminary failure keeps the source (remove:false) and also retains a verified copy", async () => {
  try {
    const { out, running } = await realAttempt("normal", {
      preliminary: ["interval X: the causal proof cannot be read"],
    });
    assert.equal(out.remove_requested, false);
    assert.equal(out.finished.stopped.removed, null);
    assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
    assert.equal(out.retention.status, "verified");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: an outstanding command ends by EOF (never re-sent); the source and a verified copy are kept", async () => {
  try {
    const { out, running } = await realAttempt("no-ack-inspect");
    assert.equal(out.eligible, false);
    assert.equal(out.finished.eof, true);
    assert.equal(out.remove_requested, false);
    assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
    assert.equal(out.retention.status, "verified");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: a forced death after the anchor removes nothing; the copy is materialised from the anchors once the exit is seen", async () => {
  try {
    const { out, running } = await realAttempt("normal", { kill: true });
    assert.deepEqual(out.finished.exit, { code: null, signal: "SIGKILL" });
    assert.equal(out.finished.stopped, null);
    assert.ok(existsSync(join(running.fixtureDir, "fixture.sqlite")));
    assert.equal(out.retention.status, "verified");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
    assert.ok(out.terminal.length > 0, "still a failure");
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: a replaced database is never anchored as the fixture; removal is not asked and the replacement survives", async () => {
  try {
    const { out, running, parent } = await realAttempt("normal", {
      beforePreserve: (r, p) => {
        const db = join(r.fixtureDir, "fixture.sqlite");
        writeFileSync(join(p, "moved.sqlite"), readFileSync(db));
        rmSync(db);
        writeFileSync(db, "a replacement, not the fixture");
      },
    });
    assert.equal(parent.length > 0, true);
    assert.equal(
      out.preservation.ready,
      false,
      "preserveFixture itself is not ready",
    );
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.preservation_problems.includes(
        "the fixture database is not the receipt's: not anchored",
      ),
    );
    assert.equal(
      readFileSync(join(running.fixtureDir, "fixture.sqlite"), "utf8"),
      "a replacement, not the fixture",
    );
    // Revision 36 (labelled adaptation, R36-RET): the one owned-source check now refuses BEFORE any retained directory is made, so
    // "nothing of the replacement is anchored" is asserted as no retained directory at all (and so no anchored fixture.sqlite in it).
    assert.equal(out.preservation.dir, null, "no retained directory is made");
    assert.deepEqual(out.preservation.anchors, []);
    assert.equal(out.guard.spawned, false, "the guard is never started on it");
    assert.notEqual(out.retention?.status, "verified");
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: an anchor that cannot be made (EXDEV) keeps the source; nothing is removed", async () => {
  try {
    const deps = {
      ...retentionDeps(),
      link: (from, to) => {
        if (from.endsWith("/fixture.sqlite"))
          throw Object.assign(new Error("cross-device link"), {
            code: "EXDEV",
          });
        return retentionDeps().link(from, to);
      },
    };
    const { out, running } = await realAttempt("normal", { deps });
    assert.equal(out.eligible, true);
    assert.equal(
      out.preservation.ready,
      false,
      "preserveFixture itself is not ready",
    );
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.preservation_problems.includes("anchoring fixture.sqlite: EXDEV"),
    );
    assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
    assert.ok(out.terminal.length > 0 || out.retention.status !== "verified");
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: an existing retained directory is never reused; removal is not asked", async () => {
  try {
    const retained = fresh();
    mkdirSync(join(retained, "retained-att-1"));
    const { out, running } = await realAttempt("normal", {
      retainedParent: retained,
    });
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.match(out.preservation_problems[0], /it must not exist\): EEXIST/);
    assert.deepEqual(readdirSync(join(retained, "retained-att-1")), []);
    assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: a retained parent nested in the fixture's parent is refused; removal is not asked", async () => {
  try {
    const { out, running } = await realAttempt("normal", { nest: true });
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.match(out.preservation_problems[0], /nest$/);
    assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: a manifest that cannot be written after the removal fails the attempt; the anchored bytes survive with the rows", async () => {
  try {
    const deps = {
      ...retentionDeps(),
      writeExclusive: () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    };
    const { out, running } = await realAttempt("normal", { deps });
    assert.equal(out.remove_requested, true);
    assert.equal(existsSync(running.fixtureDir), false);
    assert.equal(out.retention.status, "failed");
    assert.deepEqual(out.retention.problems, ["writing the manifest: ENOSPC"]);
    assert.ok(
      out.terminal.some((p) => /not retained verified \(failed\)/.test(p)),
    );
    // Revision 35 (labelled adaptation): under the reader guard the executable's close cannot checkpoint, so the rows are in the anchored
    // generation (database + its guarded WAL) rather than in the database alone; the oracle reads that pair, as the selection does.
    assert.ok(
      existsSync(join(out.preservation.dir, "fixture.sqlite-wal")),
      "the anchored WAL survives (never opened in place)",
    );
    assert.deepEqual(
      await usernamesOf({
        "fixture.sqlite": join(out.preservation.dir, "fixture.sqlite"),
        "fixture.sqlite-wal": join(out.preservation.dir, "fixture.sqlite-wal"),
      }),
      ["ada", "grace"],
      "the anchored generation still holds the rows",
    );
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: before the exit is observed nothing is materialised or judged; the anchors are kept", async () => {
  try {
    const parent = fresh();
    const retained = fresh();
    const { running } = await launch("sqlite:normal", parent);
    await running.control.send("add_account", {
      username: "ada",
      password: "p",
    });
    const held = await guardOf(running, retained);
    const kept = preserveOf(running, retained, retentionDeps(), held);
    assert.equal(kept.ready, true);
    const early = await materialiseRetained(retentionDeps(), kept, {
      exit: null,
      receipt: running.ready.receipt,
      receiptSha256: running.ready.receipt_sha256,
    });
    assert.equal(early.status, "anchored_unverified");
    assert.equal(early.inspect, null);
    assert.equal(existsSync(join(kept.dir, "work")), false);
    assert.equal(existsSync(join(kept.dir, "fixture.sqlite")), true);
    assert.notDeepEqual(verifyRetained(retentionDeps(), early), []);
    await finishAttempt(running, { remove: false });
    await held.release({ exitObserved: true });
  } finally {
    clean();
  }
});
test("R34-RET with real SQLite: an anchor replaced before the materialisation is refused (failed), never materialised", async () => {
  try {
    const parent = fresh();
    const retained = fresh();
    const { running } = await launch("sqlite:normal", parent);
    await running.control.send("add_account", {
      username: "ada",
      password: "p",
    });
    const kept = preserveOf(running, retained);
    const finished = await finishAttempt(running, { remove: true });
    rmSync(join(kept.dir, "fixture.sqlite"));
    writeFileSync(join(kept.dir, "fixture.sqlite"), "another file");
    const r = await materialiseRetained(retentionDeps(), kept, {
      exit: finished.exit,
      receipt: running.ready.receipt,
      receiptSha256: running.ready.receipt_sha256,
    });
    assert.equal(r.status, "failed");
    assert.deepEqual(r.problems, ["the anchor of fixture.sqlite was replaced"]);
    assert.equal(r.inspect, null);
  } finally {
    clean();
  }
});
test("R34-RET: verifyRetained re-reads the retained copy by hash (a changed copy or manifest is reported)", async () => {
  try {
    const { out } = await realAttempt("normal");
    assert.deepEqual(verifyRetained(retentionDeps(), out.retention), []);
    writeFileSync(join(out.retention.dir, "inspect.sqlite"), "changed");
    assert.deepEqual(verifyRetained(retentionDeps(), out.retention), [
      "the retained inspectable copy changed",
    ]);
  } finally {
    clean();
  }
});
test("R34-RET: the materialised files are SQLite's own state (database, WAL, journal), never the shared-memory index", () => {
  assert.deepEqual(MATERIALISED_FILES, [
    "fixture.sqlite",
    "fixture.sqlite-wal",
    "fixture.sqlite-journal",
  ]);
});
test("R34-RET: the runner composes the maintained preservation, materialisation and re-verification, and needs a verified retention to pass", () => {
  const runner = readFileSync(
    new URL("./run-development-pair.mjs", import.meta.url),
    "utf8",
  );
  // Revision 35 (labelled adaptation): preserve now receives the guard and materialise the guard's release result.
  // Revision 36 (labelled adaptation): preserve also receives the latch, and passes it on.
  assert.match(
    runner,
    /preserve: async \(guard, latch\) =>\s+running\s+\? preserveFixture\(retentionDeps\(\), \{[\s\S]{0,240}guard: guard\?\.record \?\? null,\s+latch,/,
  );
  assert.match(
    runner,
    /materialise: async \(preservation, finished, released\) => \{[\s\S]{0,120}materialiseRetained\([\s\S]{0,400}guard: released \?\? null,/,
  );
  // Revision 35: the reader guard is an owned process on the attempt's database, acquired before the anchor and released after the exit.
  // Revision 36 (labelled adaptation, R36-RET): it is given the ready receipt's authority and the latch, never a bare database path, and
  // its private directory is the attempt's retained parent.
  assert.match(
    runner,
    /guard: async \(latch\) =>\s+running\s+\? acquireGuard\(\s+\{\s+spawn: \(command, argv, options\) =>\s+groups\.spawn\("diagnostic-guard", command, argv, options\),\s+\},\s+\{\s+attempt,\s+fixtureDir: running\.fixtureDir,\s+receipt: running\.ready\?\.receipt,\s+receiptSha256: running\.ready\?\.receipt_sha256,\s+latch,\s+privateParent: retainedParent,\s+\},/,
  );
  assert.doesNotMatch(runner, /acquireGuard\([\s\S]{0,200}database:/);
  assert.match(
    runner,
    /release: async \(guard, finished\) =>\s+guard\.release\(\{\s+exitObserved: finished\?\.exit !== null && finished\?\.exit !== undefined,/,
  );
  assert.match(runner, /verifyRetained\(retentionDeps\(\), retention\)/);
  assert.match(
    runner,
    /finish: async \(remove\) => \{\s+if \(!running\) return null;\s+const finished = await finishAttempt\(running, \{ remove \}\);/,
  );
  assert.match(
    runner,
    /concluded\.guarded &&\s+concluded\.preserved &&\s+concluded\.retention\?\.status === "verified" &&\s+concluded\.retention\?\.selection\?\.method === "guarded-anchors" &&/,
  );
  // The retained parent is a TMPDIR sibling of the fixture's parent: never inside the invocation's recursively removed tree.
  assert.match(
    runner,
    /const retainedParent = mkdtempSync\(\s+join\(process\.env\.TMPDIR \?\? tmpdir\(\), "atlas-diagnostic-retained-"\),\s+\);/,
  );
});
test("R34-RET with real SQLite: a changed receipt.json is never anchored as the ready receipt; removal is not asked", async () => {
  try {
    const { out, running } = await realAttempt("normal", {
      beforePreserve: (r) => {
        const receipt = join(r.fixtureDir, "receipt.json");
        rmSync(receipt);
        writeFileSync(receipt, "{}");
      },
    });
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.preservation_problems.includes(
        "receipt.json is not the ready receipt: not anchored",
      ),
    );
    assert.equal(existsSync(join(out.preservation.dir, "receipt.json")), false);
    // Revision 35: a refused anchor is never materialised, even though the kept source's final state could be read.
    assert.equal(out.retention.status, "anchored_unverified");
    assert.match(
      out.retention.problems[0],
      /^the anchor was refused, so it is kept and never materialised: /,
    );
    assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
  } finally {
    clean();
  }
});

// ---- revision 35 (R35-RET; design assessment T1-T4): ONE SQLite state, never a retired WAL replayed over a later database -----------
// Real node:sqlite files in disposable directories; the executable's later connections are simulated by this process (a writer), the
// guard is the maintained separate child. The ORACLE of every schedule is independent of the retention: the stopped source's named files
// are copied when the last writer has closed (before any removal) and read through their own copy: rows, values and schema.
const { DatabaseSync: Sqlite } = await import("node:sqlite");
const { createHash: hashOf } = await import("node:crypto");
const fileSha = (path) =>
  hashOf("sha256").update(readFileSync(path)).digest("hex");
const idOf = (path) => {
  const s = statSync(path, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino) };
};
const idOrNull = (path) => (existsSync(path) ? idOf(path) : null);
/** Revision 36: a fixture directory and a private parent that do not nest, as the runner lays them out. */
function guardLayout() {
  const container = fresh();
  const leaf = join(container, "source", "fixture-g");
  mkdirSync(leaf, { recursive: true });
  const privateParent = join(container, "retained");
  mkdirSync(privateParent);
  return { container, leaf, privateParent, path: join(leaf, "fixture.sqlite") };
}
/** The ready-receipt authority of `layout` (its database must exist): receipt.json is written once and hashed. */
function authorityOf(layout) {
  const receipt = {
    fixture_dir: { path: layout.leaf, ...idOf(layout.leaf) },
    database: { path: layout.path, ...idOf(layout.path) },
  };
  const file = join(layout.leaf, "receipt.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(receipt));
  return { receipt, receiptSha256: fileSha(file) };
}
/** A guard bound to `layout`'s authority (attempt `g1`), as the runner binds it. */
const boundGuard = (layout, options = {}) =>
  acquireGuard(guardDeps, {
    attempt: "g1",
    fixtureDir: layout.leaf,
    ...authorityOf(layout),
    privateParent: layout.privateParent,
    ...options,
  });
/**
 * Rows (all columns, by id) and schema of the database in `files` ({name: path}), read through a fresh copy. A database without the
 * table yields `rows: null` (so a wrong selection fails the content ASSERTION, never with an SQLite error).
 */
function contentOf(files) {
  const dir = fresh();
  for (const [name, from] of Object.entries(files))
    writeFileSync(join(dir, name), readFileSync(from));
  const db = new Sqlite(join(dir, "fixture.sqlite"));
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    return {
      integrity: integrity.integrity_check,
      schema: db
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((r) => ({ ...r })),
      rows: db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'facts'",
        )
        .get().n
        ? db
            .prepare("SELECT * FROM facts ORDER BY id")
            .all()
            .map((r) => ({ ...r }))
        : null,
    };
  } finally {
    db.close();
  }
}
const namedSet = (leaf) =>
  Object.fromEntries(
    ["fixture.sqlite", "fixture.sqlite-wal", "fixture.sqlite-journal"]
      .filter((n) => existsSync(join(leaf, n)))
      .map((n) => [n, join(leaf, n)]),
  );
const LATE =
  "UPDATE facts SET value = 'after-anchor' WHERE id = 1; DELETE FROM facts WHERE id = 2; INSERT INTO facts VALUES (3, 'committed-later')";
/** The later activity of each schedule (after the anchor), given the open writer; returns the writer still open (or null). */
const SCHEDULES = {
  "one-lifetime": (w) => w,
  "same-wal": (w) => {
    w.exec(LATE);
    return w;
  },
  rotate: (w, path) => {
    w.close();
    const next = new Sqlite(path);
    next.exec(`PRAGMA wal_autocheckpoint=0; ${LATE}`);
    return next;
  },
  "rotate-many": (w, path) => {
    let writer = w;
    for (const [i, sql] of [
      "UPDATE facts SET value = 'after-anchor' WHERE id = 1",
      "DELETE FROM facts WHERE id = 2",
      "INSERT INTO facts VALUES (3, 'committed-later')",
    ].entries()) {
      writer.close();
      writer = new Sqlite(path);
      writer.exec(`PRAGMA wal_autocheckpoint=0; ${sql}`);
      if (i === 1) writer.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
    return writer;
  },
  truncate: (w) => {
    w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    w.exec(LATE);
    return w;
  },
  restart: (w) => {
    w.exec("PRAGMA wal_checkpoint(RESTART)");
    w.exec(LATE);
    return w;
  },
  "schema-change": (w, path) => {
    w.close();
    const next = new Sqlite(path);
    next.exec(
      `PRAGMA wal_autocheckpoint=0; ${LATE}; ALTER TABLE facts ADD COLUMN note TEXT; CREATE INDEX facts_value ON facts(value); UPDATE facts SET note = 'n' WHERE id = 3`,
    );
    return next;
  },
};
/**
 * One schedule through the maintained preserve → (removal) → release → materialise, as the runner orders them. `guarded`: the reader
 * guard is held before the anchor (else none); `keep`: the source is kept (else its owned names are unlinked as the executable's
 * `remove` does, after the last writer closed); `walAbsentAtGuard`: the writer is closed (WAL retired) before the guard.
 */
async function schedule(
  name,
  {
    guarded,
    keep,
    journal = "WAL",
    walAbsentAtGuard = false,
    // Revision 36 (T5): the guard killed after the anchor (before the last writer's close) or after that close (before the removal).
    loseGuard = null,
  },
) {
  const container = fresh();
  const leaf = join(container, "source", "fixture-r35");
  mkdirSync(leaf, { recursive: true });
  const retainedParent = join(container, "retained");
  mkdirSync(retainedParent);
  const path = join(leaf, "fixture.sqlite");
  let writer = new Sqlite(path);
  writer.exec(
    `PRAGMA journal_mode=${journal}; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO facts VALUES (1, 'before-anchor'), (2, 'second')`,
  );
  if (walAbsentAtGuard) {
    writer.close();
    assert.equal(existsSync(`${path}-wal`), false, "the WAL was retired");
    writer = new Sqlite(path);
    writer.close();
    writer = null;
  }
  const receipt = {
    fixture_dir: { path: leaf, ...idOf(leaf) },
    database: { path, ...idOf(path) },
  };
  writeFileSync(join(leaf, "receipt.json"), JSON.stringify(receipt));
  const receiptSha256 = fileSha(join(leaf, "receipt.json"));
  const entriesBeforeGuard = readdirSync(leaf).sort();
  const held = guarded
    ? await acquireGuard(guardDeps, {
        attempt: "r35",
        fixtureDir: leaf,
        receipt,
        receiptSha256,
        privateParent: retainedParent,
      })
    : null;
  const entriesAfterGuard = readdirSync(leaf).sort();
  const kill = async () => {
    process.kill(held.record.pid, "SIGKILL");
    await new Promise((resolve) => {
      const poll = () => (held.alive() ? setTimeout(poll, 5) : resolve());
      poll();
    });
  };
  const anchoredWal = idOrNull(`${path}-wal`);
  const kept = preserveFixture(retentionDeps(), {
    fixtureDir: leaf,
    receipt,
    receiptSha256,
    retainedParent,
    attempt: "r35",
    guard: held?.record ?? null,
  });
  if (loseGuard === "after-anchor") await kill();
  writer ??= new Sqlite(path);
  writer = SCHEDULES[name](writer, path);
  writer.close();
  if (loseGuard === "after-final-close") await kill();
  const finalWal = idOrNull(`${path}-wal`);
  const expected = contentOf(namedSet(leaf));
  let removed = null;
  if (!keep) {
    removed = [];
    for (const n of [
      "fixture.sqlite",
      "fixture.sqlite-wal",
      "fixture.sqlite-shm",
      "fixture.sqlite-journal",
      "receipt.json",
    ])
      if (existsSync(join(leaf, n))) {
        rmSync(join(leaf, n));
        removed.push(n);
      }
    rmdirSync(leaf);
  }
  const released = held ? await held.release({ exitObserved: true }) : null;
  const retention = await materialiseRetained(retentionDeps(), kept, {
    exit: { code: 0, signal: null },
    stopped: { seq: 1, removed },
    receipt,
    receiptSha256,
    guard: released,
  });
  const observed =
    retention.status === "verified"
      ? contentOf({
          "fixture.sqlite": join(retention.dir, "inspect.sqlite"),
        })
      : null;
  return {
    retention,
    expected,
    observed,
    kept,
    held,
    released,
    anchoredWal,
    finalWal,
    removed,
    entriesBeforeGuard,
    entriesAfterGuard,
  };
}

test("R35-RET: while the reader guard is held SQLite never retires the WAL (close, reopen, write, close keep ONE inode); without it the same schedule makes a new WAL (control)", async () => {
  try {
    for (const guarded of [true, false]) {
      const layout = guardLayout();
      const { path } = layout;
      let w = new Sqlite(path);
      w.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO facts VALUES (1, 'a')",
      );
      authorityOf(layout);
      const entries = readdirSync(layout.leaf).sort();
      const held = guarded ? await boundGuard(layout) : null;
      const first = idOf(`${path}-wal`);
      if (guarded) {
        assert.equal(held.held, true, JSON.stringify(held.problems));
        // Revision 36 (labelled adaptation): the record's WAL identity now also carries its link count (SQLite's own file alone).
        assert.deepEqual(
          held.record.wal,
          { ...first, nlink: "1" },
          "the guard holds that WAL",
        );
        assert.deepEqual(held.record.database, idOf(path));
        assert.equal(held.record.journal_mode, "wal");
        // Revision 36: the connection is the guard's private link of the receipt's inode; the fixture directory gained nothing.
        assert.deepEqual(held.record.opened, {
          name: "guard.sqlite",
          ...idOf(path),
        });
        assert.equal(held.record.namespace, "private");
        assert.deepEqual(readdirSync(layout.leaf).sort(), entries);
      }
      w.close();
      assert.deepEqual(
        idOrNull(`${path}-wal`),
        guarded ? first : null,
        guarded
          ? "the last writer's close cannot retire the guarded WAL"
          : "control: unguarded, the last close retires the WAL",
      );
      w = new Sqlite(path);
      w.exec("INSERT INTO facts VALUES (2, 'b')");
      const second = idOf(`${path}-wal`);
      if (guarded) assert.deepEqual(second, first, "the same generation");
      else assert.notEqual(second.ino, first.ino, "control: a new generation");
      w.close();
      if (guarded) {
        assert.deepEqual(idOrNull(`${path}-wal`), first);
        const before = [fileSha(path), fileSha(`${path}-wal`)];
        const released = await held.release({ exitObserved: true });
        assert.deepEqual(released, {
          released: true,
          lost: false,
          exit_observed_before_release: true,
          exit: { code: 0, signal: null },
          problems: [],
        });
        assert.deepEqual(
          [fileSha(path), fileSha(`${path}-wal`)],
          before,
          "releasing the read-only guard changes no byte (it never checkpoints or deletes)",
        );
        assert.deepEqual(idOrNull(`${path}-wal`), first);
      }
    }
  } finally {
    clean();
  }
});

test("R35-RET: the guard refuses what it cannot hold (rollback journal mode, an absent database, a relative path); a refusal is never `held`", async () => {
  try {
    const layout = guardLayout();
    const { path } = layout;
    const w = new Sqlite(path);
    w.exec("PRAGMA journal_mode=DELETE; CREATE TABLE facts (id INTEGER)");
    w.close();
    const deleteMode = await boundGuard(layout);
    assert.equal(deleteMode.held, false);
    assert.match(deleteMode.problems[0], /delete journal mode, not WAL/);
    assert.equal(deleteMode.record.held, false);
    // Revision 36 (labelled adaptation): an absent database and a relative path are now refused by the owned-source check BEFORE the
    // child is started (revision 35's child reported `failed` after trying to open them).
    const { receipt, receiptSha256 } = authorityOf(layout);
    rmSync(path);
    const absent = await acquireGuard(guardDeps, {
      attempt: "g1",
      fixtureDir: layout.leaf,
      receipt,
      receiptSha256,
      privateParent: layout.privateParent,
    });
    assert.equal(absent.held, false);
    assert.equal(absent.record.spawned, false);
    assert.match(
      absent.problems[0],
      /^the guard was not started: the fixture database is not the receipt's/,
    );
    const relative = await acquireGuard(guardDeps, {
      attempt: "g1",
      fixtureDir: "fixture-g",
      receipt,
      receiptSha256,
      privateParent: layout.privateParent,
    });
    assert.equal(relative.held, false);
    assert.match(relative.problems[0], /not a safe absolute path/);
    const never = await deleteMode.release({ exitObserved: true });
    assert.equal(never.released, false);
    assert.deepEqual(never.problems, ["the guard was never held"]);
  } finally {
    clean();
  }
});

test("R35-RET: a guard that ended before its release is LOST: the release says so and proves nothing", async () => {
  try {
    const layout = guardLayout();
    const w = new Sqlite(layout.path);
    w.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (id INTEGER)");
    const held = await boundGuard(layout);
    assert.equal(held.alive(), true);
    process.kill(held.record.pid, "SIGKILL");
    const settled = await within(
      new Promise((resolve) => {
        const poll = () => (held.alive() ? setTimeout(poll, 5) : resolve());
        poll();
      }),
      3000,
    );
    assert.equal(settled.timedOut, undefined, "the death is observed");
    const released = await held.release({ exitObserved: true });
    assert.equal(released.lost, true);
    assert.equal(released.released, false);
    assert.match(released.problems[0], /ended before its release/);
    w.close();
  } finally {
    clean();
  }
});

/** Revision 36: the schedules whose anchored (earlier) WAL generation is older than pages a later generation checkpointed. */
const RETIRED_STALE = new Set(["rotate", "rotate-many", "schema-change"]);
for (const name of Object.keys(SCHEDULES)) {
  test(`R35-RET T1 ${name}: guarded, removed source — verified, and the inspectable copy IS the stopped state (rows, values, schema)`, async () => {
    try {
      const r = await schedule(name, { guarded: true, keep: false });
      assert.equal(r.held.held, true, JSON.stringify(r.held.problems));
      assert.equal(r.kept.ready, true, JSON.stringify(r.kept.guard_problems));
      assert.deepEqual(r.finalWal, r.anchoredWal, "one WAL generation");
      assert.equal(
        r.retention.status,
        "verified",
        JSON.stringify(r.retention.problems),
      );
      assert.equal(r.retention.selection.method, "guarded-anchors");
      assert.equal(r.expected.integrity, "ok");
      assert.deepEqual(r.observed, r.expected);
      assert.deepEqual(verifyRetained(retentionDeps(), r.retention), []);
    } finally {
      clean();
    }
  });
  test(`R35-RET T1 ${name}: guarded, KEPT source — verified from its final named state, equal to the stopped state`, async () => {
    try {
      const r = await schedule(name, { guarded: true, keep: true });
      assert.equal(
        r.retention.status,
        "verified",
        JSON.stringify(r.retention.problems),
      );
      assert.equal(r.retention.selection.method, "final-named-after-exit");
      assert.equal(r.retention.selection.wal_generation, "anchored");
      assert.deepEqual(r.observed, r.expected);
      assert.deepEqual(verifyRetained(retentionDeps(), r.retention), []);
    } finally {
      clean();
    }
  });
  test(`R35-RET T1 ${name}: UNGUARDED, kept source — verified from the final named state (never the retired anchor), equal to the stopped state`, async () => {
    try {
      const r = await schedule(name, { guarded: false, keep: true });
      assert.equal(r.kept.anchored, true);
      assert.equal(r.kept.ready, false, "no guard: removal would not be asked");
      assert.equal(
        r.retention.status,
        "verified",
        JSON.stringify(r.retention.problems),
      );
      assert.equal(r.retention.selection.method, "final-named-after-exit");
      assert.deepEqual(r.observed, r.expected);
    } finally {
      clean();
    }
  });
  // Revision 36 (labelled adaptation of "UNGUARDED, removed source — never verified"): the intent kept is that a removed source's anchors
  // are never PRESENTED as the stopped state without proof. Unguarded, the last writer's close retires the WAL, so the executable's removal
  // finds none and `retired-into-database` applies: the database alone, verified only when replaying the anchored WAL changes nothing.
  // Where a later generation was checkpointed over an earlier anchored one (the rotations) that corroboration fails and the anchors stay
  // raw, unverified — revision 35's refusal, now by the content check. Where it is verified, it must EQUAL the independent stopped state.
  test(`R35-RET T1 ${name}: UNGUARDED, removed source — the anchored database alone only when the anchored WAL adds nothing, equal to the stopped state; otherwise never verified`, async () => {
    try {
      const r = await schedule(name, { guarded: false, keep: false });
      assert.equal(r.finalWal, null, "the last close retired the WAL");
      assert.ok(!r.removed.includes("fixture.sqlite-wal"));
      if (RETIRED_STALE.has(name)) {
        assert.equal(r.retention.status, "failed");
        assert.equal(r.retention.inspect, null);
        assert.match(
          r.retention.problems[0],
          /^the anchored WAL changes the database it was retired into/,
        );
        assert.ok(
          existsSync(join(r.kept.dir, "fixture.sqlite")),
          "raw anchors kept",
        );
      } else {
        assert.equal(
          r.retention.status,
          "verified",
          JSON.stringify(r.retention.problems),
        );
        assert.equal(r.retention.selection.method, "retired-into-database");
        assert.equal(r.retention.selection.corroboration.equal, true);
        assert.deepEqual(r.observed, r.expected);
      }
      // Whatever the verdict, the anchored database itself holds the stopped state (the WAL was checkpointed into it before deletion).
      assert.deepEqual(
        contentOf({ "fixture.sqlite": join(r.kept.dir, "fixture.sqlite") }),
        r.expected,
      );
    } finally {
      clean();
    }
  });
}

test("R35-RET T1 (the review's own stimulus): unguarded rotation replaced the WAL and the anchor holds the RETIRED generation; replaying it would be stale, so the retention is refused", async () => {
  try {
    const r = await schedule("rotate", { guarded: false, keep: false });
    assert.notEqual(r.anchoredWal, null);
    assert.equal(
      r.finalWal,
      null,
      "the second generation was checkpointed and deleted",
    );
    // The stimulus is the reviewer's: the anchored pair alone holds only the earlier state, while the stopped state holds the later one.
    const stale = contentOf({
      "fixture.sqlite": join(r.kept.dir, "fixture.sqlite"),
      "fixture.sqlite-wal": join(r.kept.dir, "fixture.sqlite-wal"),
    });
    assert.equal(stale.integrity, "ok", "a stale replay is internally valid");
    assert.notDeepEqual(stale.rows, r.expected.rows);
    assert.deepEqual(stale.rows.length, r.expected.rows.length, "same count");
    assert.notEqual(r.retention.status, "verified");
  } finally {
    clean();
  }
});

// Revision 36 (labelled adaptation of revision 35's "no WAL at the first observation — the guard's own read opens one generation"): the
// guard no longer opens the fixture's namespace, so it can create no WAL there. Intent kept: with no WAL at acquisition no generation can
// be bound, so removal is not asked (the guard refuses, creating nothing in the fixture directory); and should the source be removed
// anyway, its later WAL was retired by the last close, so the database alone is the stopped state.
test("R35-RET T1: no WAL at the first observation — the guard creates nothing in the fixture directory and refuses (removal not asked); a source removed anyway is its database alone, equal to the stopped state", async () => {
  try {
    const r = await schedule("same-wal", {
      guarded: true,
      keep: false,
      walAbsentAtGuard: true,
    });
    assert.equal(r.held.held, false);
    assert.equal(r.held.record.stage, "observe");
    assert.match(
      r.held.problems[0],
      /no WAL file is present while the guard is held/,
    );
    assert.deepEqual(r.entriesAfterGuard, r.entriesBeforeGuard);
    assert.equal(r.anchoredWal, null);
    assert.equal(r.kept.ready, false, "removal would not be asked");
    assert.equal(
      r.retention.status,
      "verified",
      JSON.stringify(r.retention.problems),
    );
    assert.equal(r.retention.selection.method, "retired-into-database");
    assert.equal(r.retention.selection.corroboration.with_wal, null);
    assert.deepEqual(r.observed, r.expected);
  } finally {
    clean();
  }
});

test("R35-RET T1: a rollback-journal database is outside the guard: refused, so removal would not be asked; a kept source is read from its final state", async () => {
  try {
    const r = await schedule("same-wal", {
      guarded: true,
      keep: true,
      journal: "DELETE",
    });
    assert.equal(r.held.held, false);
    assert.equal(r.kept.ready, false);
    assert.match(r.kept.guard_problems[0], /no SQLite reader guard is held/);
    assert.equal(
      r.retention.status,
      "verified",
      JSON.stringify(r.retention.problems),
    );
    assert.equal(r.retention.selection.method, "final-named-after-exit");
    assert.deepEqual(r.observed, r.expected);
  } finally {
    clean();
  }
});

test("R35-RET T4: each missing part of the guard's proof refuses the anchors of a removed source", async () => {
  try {
    const base = await schedule("same-wal", { guarded: true, keep: false });
    assert.equal(base.retention.status, "verified");
    const again = (kept, options) =>
      materialiseRetained(
        {
          ...retentionDeps(),
          // a fresh materialisation of the same anchors (the first one's work/ and manifest stay)
          mkdir: (p) =>
            mkdirSync(
              p.replace(/\/(work|final)$/, `/$1-again-${Math.random()}`),
              { mode: 0o700 },
            ),
        },
        kept,
        options,
      );
    const options = {
      exit: { code: 0, signal: null },
      stopped: { seq: 1, removed: base.removed },
      receipt: base.retention.quiescence && {
        fixture_dir: { dev: "0", ino: "0" },
        database: {
          dev: base.kept.anchors.find((a) => a.name === "fixture.sqlite").dev,
          ino: base.kept.anchors.find((a) => a.name === "fixture.sqlite").ino,
        },
      },
      receiptSha256: base.kept.anchors.find((a) => a.name === "receipt.json")
        .sha256,
      guard: base.released,
    };
    for (const [why, edit, want] of [
      [
        "the guard lost before its release",
        (o) => (o.guard = { ...o.guard, lost: true }),
        /the guard was lost/,
      ],
      [
        "the guard not released",
        (o) => (o.guard = { ...o.guard, released: false }),
        /the guard was not released/,
      ],
      [
        "the guard released before the exit",
        (o) => (o.guard = { ...o.guard, exit_observed_before_release: false }),
        /not released after the exit/,
      ],
      ["no release result", (o) => (o.guard = null), /the guard was lost/],
      // Revision 36 (labelled adaptation): a removal claiming no WAL now selects `retired-into-database`, whose corroboration refuses
      // it — the guarded WAL was never checkpointed, so replaying it changes the database. Still `failed`, never the guarded anchors.
      [
        "the removal did not find the WAL",
        (o) =>
          (o.stopped = {
            seq: 1,
            removed: o.stopped.removed.filter(
              (n) => n !== "fixture.sqlite-wal",
            ),
          }),
        /^the anchored WAL changes the database it was retired into/,
      ],
      [
        "no stopped event",
        (o) => (o.stopped = null),
        /removal did not find the guarded WAL/,
      ],
      // Revision 36: a removal record lacking the WAL now reaches `retired-into-database` only when it names the database; one that
      // names neither is still judged here, by the guarded proof's own removal check.
      [
        "a removal that found neither the database nor the WAL",
        (o) =>
          (o.stopped = {
            seq: 1,
            removed: o.stopped.removed.filter(
              (n) => !["fixture.sqlite", "fixture.sqlite-wal"].includes(n),
            ),
          }),
        /removal did not find the guarded WAL/,
      ],
    ]) {
      const o = { ...options };
      edit(o);
      const r = await again(base.kept, o);
      assert.equal(r.status, "failed", why);
      assert.match(r.problems[0], want, why);
    }
    for (const [why, guard, want] of [
      [
        "another WAL generation",
        { ...base.kept.guard, wal: { dev: "1", ino: "1" } },
        /the anchored WAL is not the guarded generation/,
      ],
      [
        "another database",
        { ...base.kept.guard, database: { dev: "1", ino: "1" } },
        /the guard held another database/,
      ],
      [
        "an unknown guard method",
        { ...base.kept.guard, method: "other/1" },
        /the guard method other\/1/,
      ],
      ["no guard", null, /no reader guard was held before the anchor/],
      // Revision 36: the guard's authority and its private binding.
      [
        "a guard bound to another attempt",
        { ...base.kept.guard, attempt: "other" },
        /the guard was bound to another attempt or receipt/,
      ],
      [
        "a guard bound to another receipt",
        { ...base.kept.guard, receipt_sha256: "0".repeat(64) },
        /the guard was bound to another attempt or receipt/,
      ],
      [
        "a guard that opened the fixture's own name",
        { ...base.kept.guard, namespace: "fixture" },
        /did not open the receipt's database through its private name/,
      ],
      [
        "a guard that opened another file",
        {
          ...base.kept.guard,
          opened: { name: "guard.sqlite", dev: "1", ino: "1" },
        },
        /did not open the receipt's database through its private name/,
      ],
    ]) {
      const r = await again({ ...base.kept, guard }, options);
      assert.equal(r.status, "failed", why);
      assert.match(r.problems[0], want, why);
    }
  } finally {
    clean();
  }
});

test("R35-RET T4: a kept source whose database name was replaced after the anchor is never inspected; nor is a replaced directory", async () => {
  try {
    const r = await schedule("one-lifetime", { guarded: false, keep: true });
    const leaf = r.retention.source;
    rmSync(join(leaf, "fixture.sqlite"));
    writeFileSync(join(leaf, "fixture.sqlite"), "a replacement");
    const db = r.kept.anchors.find((a) => a.name === "fixture.sqlite");
    const receipt = {
      fixture_dir: idOf(leaf),
      database: { dev: db.dev, ino: db.ino },
    };
    const again = await materialiseRetained(
      {
        ...retentionDeps(),
        mkdir: (p) => mkdirSync(`${p}-again`, { mode: 0o700 }),
      },
      r.kept,
      { exit: { code: 0, signal: null }, stopped: null, receipt },
    );
    assert.equal(again.status, "failed");
    assert.match(
      again.problems[0],
      /^the source's final state is not the fixture's own \(directory owned, database replaced\)/,
    );
    const moved = await materialiseRetained(retentionDeps(), r.kept, {
      exit: { code: 0, signal: null },
      stopped: null,
      receipt: { ...receipt, fixture_dir: { dev: "1", ino: "1" } },
    });
    assert.equal(moved.status, "failed");
    assert.match(moved.problems[0], /\(directory replaced, database absent\)/);
    assert.equal(
      readFileSync(join(leaf, "fixture.sqlite"), "utf8"),
      "a replacement",
      "the replacement is untouched",
    );
  } finally {
    clean();
  }
});

test("R35-RET T3: verifyRetained re-reads the final files a kept source's selection names", async () => {
  try {
    const r = await schedule("same-wal", { guarded: true, keep: true });
    assert.deepEqual(verifyRetained(retentionDeps(), r.retention), []);
    const wal = r.retention.selection.files.find((f) => f.origin === "final");
    assert.ok(wal, "the kept WAL is selected from the final state");
    assert.equal(wal.name, "fixture.sqlite-wal");
    writeFileSync(join(r.retention.dir, "final", wal.name), "changed");
    // The kept WAL is the anchored inode (one generation), so its anchor and its final link both report the change.
    assert.deepEqual(verifyRetained(retentionDeps(), r.retention), [
      "the retained anchor fixture.sqlite-wal changed",
      "the retained final fixture.sqlite-wal changed",
    ]);
  } finally {
    clean();
  }
});

// Through the maintained conclusion with the real SQLite stand-in (`sqlite:rotate`: close, reopen, same-count UPDATE/DELETE/INSERT, close).
test("R35-RET with real SQLite: a healthy guarded attempt whose executable rotates its connection is removed, and the retained copy holds the LATE rows", async () => {
  try {
    const { out, running } = await realAttempt("rotate");
    assert.equal(out.guarded, true, JSON.stringify(out.guard_problems));
    assert.equal(out.remove_requested, true);
    assert.deepEqual(out.terminal, []);
    assert.equal(existsSync(running.fixtureDir), false);
    assert.ok(
      out.finished.stopped.removed.includes("fixture.sqlite-wal"),
      "the executable's removal found the guarded WAL",
    );
    assert.equal(out.retention.status, "verified");
    assert.equal(out.retention.selection.method, "guarded-anchors");
    assert.deepEqual(out.released.lost, false);
    assert.deepEqual(await inspectedUsernames(out.retention), [
      "ada-late",
      "hopper-late",
    ]);
  } finally {
    clean();
  }
});
test("R35-RET with real SQLite: the same rotation WITHOUT a guard step is never asked to remove; the kept source's final state is retained", async () => {
  try {
    const { out, running } = await realAttempt("rotate", { guarded: false });
    assert.equal(out.eligible, true);
    assert.equal(out.preserved, false);
    assert.equal(out.guarded, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.guard_problems.includes(
        "no SQLite reader guard step: the fixture's removal is never asked",
      ),
    );
    assert.ok(existsSync(join(running.fixtureDir, "fixture.sqlite")));
    assert.equal(out.retention.status, "verified");
    assert.equal(out.retention.selection.method, "final-named-after-exit");
    assert.deepEqual(await inspectedUsernames(out.retention), [
      "ada-late",
      "hopper-late",
    ]);
    assert.deepEqual(await sourceRows(running), ["ada-late", "hopper-late"]);
  } finally {
    clean();
  }
});
test("R35-RET with real SQLite: a WAL name replaced between the guard and the anchor is not the guarded generation; removal is not asked", async () => {
  try {
    const { out, running } = await realAttempt("normal", {
      afterGuard: (r) => {
        const wal = join(r.fixtureDir, "fixture.sqlite-wal");
        const copy = `${wal}.copy`;
        writeFileSync(copy, readFileSync(wal));
        rmSync(wal);
        writeFileSync(wal, readFileSync(copy));
        rmSync(copy);
      },
    });
    assert.equal(out.guarded, true);
    assert.equal(out.preserved, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.preservation_problems.includes(
        "the anchored WAL is not the generation the guard holds",
      ),
      JSON.stringify(out.preservation_problems),
    );
    assert.ok(existsSync(join(running.fixtureDir, "fixture.sqlite")));
    // The kept source is retained from its FINAL named state (never from the unguarded anchor), equal to the source itself.
    assert.equal(out.retention.selection?.method, "final-named-after-exit");
    assert.deepEqual(
      await inspectedUsernames(out.retention),
      await sourceRows(running),
    );
  } finally {
    clean();
  }
});
test("R35-RET with real SQLite: a guard that ended before the removal decision prevents the removal; the kept source is retained", async () => {
  try {
    const { out, running } = await realAttempt("normal", {
      afterGuard: async (_r, held) => {
        process.kill(held.record.pid, "SIGKILL");
        await new Promise((resolve) => {
          const poll = () => (held.alive() ? setTimeout(poll, 5) : resolve());
          poll();
        });
      },
    });
    assert.equal(out.eligible, true);
    assert.equal(out.preserved, true, "the anchor itself was bound");
    assert.equal(out.guarded, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.guard_problems.includes(
        "the SQLite reader guard ended before the removal decision",
      ),
    );
    assert.equal(out.released.lost, true);
    assert.ok(existsSync(join(running.fixtureDir, "fixture.sqlite")));
    assert.equal(out.retention.status, "verified");
    assert.equal(out.retention.selection.method, "final-named-after-exit");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});

// The conclusion's decision with recording fakes (revision 35: the guard step).
for (const [name, opts, problem] of [
  ["no guard step composed", { held: null }, /no SQLite reader guard step/],
  [
    "a guard that was not held",
    {
      held: { held: false, problems: ["the guard was not held (refused: x)"] },
    },
    /the guard was not held/,
  ],
  [
    "a guard held with a problem",
    { held: { held: true, problems: ["late"] } },
    /^late$/,
  ],
  ["a guard step that threw", { throwIn: "guard" }, /guard broke/],
  [
    "a guard that ended before the decision",
    { held: { held: true, problems: [], alive: () => false } },
    /ended before the removal decision/,
  ],
  [
    "a guard step that returned nothing",
    { held: () => undefined },
    /the SQLite reader guard is not held/,
  ],
])
  test(`R35-RET: a healthy, preserved attempt with ${name} is NEVER asked to remove its fixture`, async () => {
    const { out, asked } = await conclude(opts);
    assert.equal(out.eligible, true);
    assert.equal(asked, false);
    assert.equal(out.guarded, false);
    assert.equal(out.remove_requested, false);
    assert.ok(
      out.guard_problems.some((p) => problem.test(p)),
      JSON.stringify(out.guard_problems),
    );
  });
test("R35-RET: the guard handle reaches preserve and release; the release result reaches materialise", async () => {
  const held = { held: true, problems: [], record: { held: true, id: 7 } };
  const { out, seen, asked } = await conclude({ held });
  assert.equal(asked, true);
  assert.equal(seen.preservedWith, held);
  assert.equal(seen.released.guard, held);
  assert.equal(seen.released.finished.requested_remove, true);
  assert.deepEqual(seen.materialised.released, {
    released: true,
    lost: false,
    problems: [],
  });
  assert.deepEqual(out.guard, { held: true, id: 7 });
});
test("R35-RET: preserveFixture binds the anchor to the guard it is given (method, WAL mode, database, the anchored WAL, no journal)", async () => {
  try {
    const r = await schedule("one-lifetime", { guarded: true, keep: true });
    const leaf = r.retention.source;
    const receipt = JSON.parse(
      readFileSync(join(leaf, "receipt.json"), "utf8"),
    );
    const preserveWith = (guard, extra = () => undefined) => {
      const parent = fresh();
      extra();
      return preserveFixture(retentionDeps(), {
        fixtureDir: leaf,
        receipt,
        receiptSha256: fileSha(join(leaf, "receipt.json")),
        retainedParent: parent,
        // Revision 36 (labelled adaptation): the guard is bound to attempt `r35`, so the anchor is that attempt's.
        attempt: "r35",
        guard,
      });
    };
    const good = r.held.record;
    assert.equal(preserveWith(good).ready, true, "positive control");
    for (const [why, guard, want] of [
      ["no guard", null, /^no SQLite reader guard is held/],
      [
        "a guard not held",
        { ...good, held: false },
        /^no SQLite reader guard is held/,
      ],
      [
        "another method",
        { ...good, method: "other/1" },
        /^the guard method other\/1 is not sqlite-private-name-reader\/2$/,
      ],
      // Revision 36: bound to the attempt's authority and opened through its private name as the receipt's inode.
      [
        "another attempt",
        { ...good, attempt: "other" },
        /^the guard was bound to another attempt or receipt$/,
      ],
      [
        "another receipt digest",
        { ...good, receipt_sha256: "0".repeat(64) },
        /^the guard was bound to another attempt or receipt$/,
      ],
      [
        "the fixture's own namespace",
        { ...good, namespace: null },
        /^the guard did not open the receipt's database through its private name$/,
      ],
      [
        "another opened file",
        { ...good, opened: { name: "guard.sqlite", dev: "1", ino: "1" } },
        /^the guard did not open the receipt's database through its private name$/,
      ],
      [
        "another journal mode",
        { ...good, journal_mode: "delete" },
        /^the guarded database is in delete mode$/,
      ],
      [
        "another database",
        { ...good, database: { dev: "1", ino: "1" } },
        /^the guard holds another database than the receipt's$/,
      ],
      [
        "another WAL",
        { ...good, wal: { dev: "1", ino: "1" } },
        /^the anchored WAL is not the generation the guard holds$/,
      ],
    ]) {
      const kept = preserveWith(guard);
      assert.equal(kept.anchored, true, why);
      assert.equal(kept.ready, false, why);
      assert.ok(
        kept.guard_problems.some((p) => want.test(p)),
        `${why}: ${JSON.stringify(kept.guard_problems)}`,
      );
    }
    const journal = join(leaf, "fixture.sqlite-journal");
    const withJournal = preserveWith(good, () => writeFileSync(journal, "x"));
    rmSync(journal);
    assert.equal(withJournal.ready, false);
    assert.ok(
      withJournal.guard_problems.includes(
        "a rollback journal is anchored beside the guarded WAL",
      ),
    );
    const wal = join(leaf, "fixture.sqlite-wal");
    const saved = readFileSync(wal);
    const noWal = preserveWith(good, () => rmSync(wal));
    writeFileSync(wal, saved);
    assert.equal(noWal.ready, false);
    assert.ok(noWal.guard_problems.includes("the guarded WAL is not anchored"));
  } finally {
    clean();
  }
});
test("R35-RET: a guard released before the executable's exit was observed says so", async () => {
  try {
    const layout = guardLayout();
    const w = new Sqlite(layout.path);
    w.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (id INTEGER)");
    const held = await boundGuard(layout);
    const released = await held.release({ exitObserved: false });
    assert.equal(released.released, true);
    assert.equal(released.exit_observed_before_release, false);
    assert.deepEqual(released.problems, [
      "the guard was released before the executable's exit was observed",
    ]);
    w.close();
  } finally {
    clean();
  }
});

// ---- revision 36 (R36-RET; design assessment of 2 Nov 2026, token 41c6b27cf2ff4ddf898b1066cb9640d4, T1-T5): ownership before SQLite --------
// Real node:sqlite files in disposable directories and the maintained guard CHILD (its explicit `pause` points are the deterministic
// boundaries of T2). The oracle of every schedule is the before/after INVENTORY of every directory a replacement involves (names, kinds,
// identities, sizes, link counts, regular files' hashes, link targets), never the guard's own report alone.
const inventoryOf = (dir) =>
  existsSync(dir)
    ? Object.fromEntries(
        readdirSync(dir)
          .sort()
          .map((name) => {
            const path = join(dir, name);
            const s = lstatSync(path, { bigint: true });
            return [
              name,
              {
                kind: s.isFile()
                  ? "file"
                  : s.isDirectory()
                    ? "directory"
                    : s.isSymbolicLink()
                      ? "symlink"
                      : "other",
                ino: String(s.ino),
                size: s.isFile() ? String(s.size) : null,
                nlink: s.isFile() ? String(s.nlink) : null,
                sha256: s.isFile() ? fileSha(path) : null,
                target: s.isSymbolicLink() ? readlinkSync(path) : null,
              },
            ];
          }),
      )
    : null;
const OWNED_TRIO = [
  "fixture.sqlite",
  "fixture.sqlite-wal",
  "fixture.sqlite-shm",
];
/**
 * The R36 world: the owned WAL-mode fixture with its writer OPEN (as the executable's pool is at the conclusion), its ready-receipt
 * authority, and a FOREIGN valid WAL-mode database whose last writer closed (so its `-wal`/`-shm` names are absent), in its own directory.
 */
function r36World() {
  const layout = guardLayout();
  const writer = new Sqlite(layout.path);
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO facts VALUES (1, 'owned')",
  );
  const authority = authorityOf(layout);
  const foreignDir = join(layout.container, "foreign");
  mkdirSync(foreignDir);
  const foreign = join(foreignDir, "foreign.sqlite");
  const f = new Sqlite(foreign);
  f.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE other (v TEXT); INSERT INTO other VALUES ('foreign')",
  );
  f.close();
  assert.equal(
    existsSync(`${foreign}-wal`),
    false,
    "the foreign WAL is absent",
  );
  const aside = join(layout.container, "aside");
  mkdirSync(aside);
  const w = {
    ...layout,
    ...authority,
    writer,
    foreignDir,
    foreign,
    aside,
    /** The owned database's names moved out of the fixture directory (the writer keeps its descriptors). */
    moveOwnedAside: () => {
      for (const n of OWNED_TRIO)
        if (existsSync(join(layout.leaf, n)))
          renameSync(join(layout.leaf, n), join(aside, n));
    },
    moveOwnedBack: () => {
      for (const n of OWNED_TRIO)
        if (existsSync(join(aside, n)))
          renameSync(join(aside, n), join(layout.leaf, n));
    },
  };
  /** Each replacement of the owned source by a foreign one, made after the receipt. Returns the directories it involves. */
  w.replace = {
    database: () => {
      w.moveOwnedAside();
      renameSync(foreign, layout.path);
      return [layout.leaf, foreignDir];
    },
    directory: () => {
      renameSync(layout.leaf, `${layout.leaf}.moved`);
      mkdirSync(layout.leaf);
      renameSync(foreign, layout.path);
      writeFileSync(
        join(layout.leaf, "receipt.json"),
        readFileSync(join(`${layout.leaf}.moved`, "receipt.json")),
      );
      return [layout.leaf, foreignDir];
    },
    ancestor: () => {
      const source = join(layout.container, "source");
      renameSync(source, `${source}.moved`);
      mkdirSync(layout.leaf, { recursive: true });
      renameSync(foreign, layout.path);
      return [layout.leaf, foreignDir];
    },
    symlink: () => {
      w.moveOwnedAside();
      symlinkSync(foreign, layout.path);
      return [layout.leaf, foreignDir];
    },
  };
  /** Every directory a replacement can involve (the inventories are compared across all of them). */
  w.involved = () => [
    layout.leaf,
    foreignDir,
    aside,
    `${layout.leaf}.moved`,
    join(layout.container, "source.moved", "fixture-g"),
  ];
  return w;
}
const inventories = (dirs) =>
  Object.fromEntries(dirs.map((d) => [d, inventoryOf(d)]));
/** The guard (bound as the runner binds it) and then the anchor, in the runner's order, with optional pause stimuli. */
async function acquireAndPreserve(
  w,
  { pause = [], onPause = null, latch = null, afterGuard = null } = {},
) {
  const held = await acquireGuard(guardDeps, {
    attempt: "r36",
    fixtureDir: w.leaf,
    receipt: w.receipt,
    receiptSha256: w.receiptSha256,
    privateParent: w.privateParent,
    latch,
    pause,
    onPause,
  });
  await afterGuard?.(held);
  const kept = preserveFixture(retentionDeps(), {
    fixtureDir: w.leaf,
    receipt: w.receipt,
    receiptSha256: w.receiptSha256,
    retainedParent: w.privateParent,
    attempt: "r36",
    guard: held.record,
    latch,
  });
  return { held, kept };
}

test("R36-RET T1 control: the owned database (its writer open) — the guard is bound and held through its private name, the anchor is ready, and the fixture directory gains no name", async () => {
  try {
    const w = r36World();
    const before = inventoryOf(w.leaf);
    const { held, kept } = await acquireAndPreserve(w);
    assert.equal(held.held, true, JSON.stringify(held.problems));
    assert.deepEqual(held.record.authority, {
      attempt: "r36",
      fixture_dir: { ...w.receipt.fixture_dir },
      database: { ...w.receipt.database },
      receipt_sha256: w.receiptSha256,
    });
    assert.equal(held.record.namespace, "private");
    assert.deepEqual(held.record.opened, {
      name: "guard.sqlite",
      ...idOf(w.path),
    });
    assert.equal(
      kept.ready,
      true,
      JSON.stringify([kept.problems, kept.guard_problems]),
    );
    // The guard's private directory holds only its own link (the receipt's inode) and its own companions.
    const own = inventoryOf(join(w.privateParent, "guard-r36"));
    assert.deepEqual(Object.keys(own), [
      "guard.sqlite",
      "guard.sqlite-shm",
      "guard.sqlite-wal",
    ]);
    assert.equal(own["guard.sqlite"].ino, idOf(w.path).ino);
    // The fixture directory: the same names and identities; only the anchors raised the owned files' link counts.
    const after = inventoryOf(w.leaf);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const name of Object.keys(before))
      assert.equal(after[name].ino, before[name].ino, name);
    await held.release({ exitObserved: true });
    w.writer.close();
  } finally {
    clean();
  }
});

for (const kind of ["database", "directory", "symlink"])
  test(`R36-RET T1 ${kind} replaced after the receipt, before the acquisition: refused BEFORE the guard starts; no foreign entry, byte or companion changes; nothing is anchored`, async () => {
    try {
      const w = r36World();
      const involved = w.replace[kind]();
      const before = inventories(w.involved());
      const { held, kept } = await acquireAndPreserve(w);
      assert.equal(held.held, false);
      assert.equal(
        held.record.spawned,
        false,
        "the guard child is never started",
      );
      assert.equal(held.record.stage, "before-spawn");
      assert.match(
        held.problems[0],
        /^the guard was not started: the fixture (directory|database) is not the receipt's/,
      );
      assert.equal(kept.ready, false);
      assert.equal(kept.dir, null, "no retained directory is made");
      assert.deepEqual(kept.anchors, []);
      assert.deepEqual(
        readdirSync(w.privateParent),
        [],
        "no private directory either",
      );
      assert.deepEqual(
        inventories(w.involved()),
        before,
        "every involved directory is unchanged",
      );
      for (const dir of involved)
        for (const n of Object.keys(inventoryOf(dir) ?? {}))
          assert.ok(
            !/-(wal|shm)$/.test(n) || n.startsWith("fixture.sqlite") === false,
            `${dir}/${n}`,
          );
      assert.equal(existsSync(`${w.foreign}-wal`), false);
      assert.equal(
        existsSync(join(w.leaf, "fixture.sqlite-wal")),
        false,
        "no companion beside the replacement",
      );
      assert.equal(existsSync(join(w.leaf, "fixture.sqlite-shm")), false);
      w.writer.close();
    } finally {
      clean();
    }
  });

test("R36-RET T1 the child's own check: a replacement between the parent's check and the child's (the parent shown the receipt's identities) is refused by the child at `ownership`, before its private directory, link or any open", async () => {
  try {
    const w = r36World();
    w.replace.database();
    const before = inventories(w.involved());
    const lying = (path) => ({
      isDirectory: () => path === w.leaf,
      isFile: () => path !== w.leaf,
      ...(path === w.leaf ? w.receipt.fixture_dir : w.receipt.database),
    });
    const held = await acquireGuard(
      { ...guardDeps, lstat: lying },
      {
        attempt: "r36",
        fixtureDir: w.leaf,
        receipt: w.receipt,
        receiptSha256: w.receiptSha256,
        privateParent: w.privateParent,
      },
    );
    assert.equal(held.record.spawned, true, "the parent's check passed");
    assert.equal(held.held, false);
    assert.equal(held.record.stage, "ownership");
    assert.match(
      held.record.refused,
      /^the fixture database is not the receipt's: nothing is opened/,
    );
    assert.deepEqual(
      readdirSync(w.privateParent),
      [],
      "refused before its private directory",
    );
    assert.deepEqual(inventories(w.involved()), before);
    w.writer.close();
  } finally {
    clean();
  }
});

for (const kind of ["database", "directory", "ancestor", "symlink"])
  test(`R36-RET T2 ${kind} replaced at the child's barrier between its check and its link: the link is not the receipt's inode, so it is removed and never opened; no foreign entry, byte or companion changes`, async () => {
    try {
      const w = r36World();
      let before = null;
      const { held, kept } = await acquireAndPreserve(w, {
        pause: ["before-link"],
        onPause: (at) => {
          assert.equal(at, "before-link");
          w.replace[kind]();
          before = inventories(w.involved());
        },
      });
      assert.notEqual(before, null, "the barrier was reached");
      assert.equal(held.held, false);
      assert.equal(held.record.stage, "link");
      assert.match(
        held.record.refused,
        /^the linked file is not the receipt's database \(replaced between the check and the link\): never opened/,
      );
      assert.deepEqual(
        readdirSync(join(w.privateParent, "guard-r36")),
        [],
        "the guard's own refused link is gone; no companion",
      );
      // Every involved directory is exactly as the replacement left it: names, identities, bytes, and the foreign file's link count back.
      assert.deepEqual(inventories(w.involved()), before);
      assert.equal(
        existsSync(join(w.leaf, "fixture.sqlite-wal")),
        false,
        "no companion beside the replacement",
      );
      assert.equal(kept.ready, false);
      w.writer.close();
    } finally {
      clean();
    }
  });

test("R36-RET T2 the database name swapped AFTER the private link is bound (before the open): SQLite opens only the private link — the receipt's inode — creates nothing beside the foreign name, and the guard refuses because the fixture's name changed", async () => {
  try {
    const w = r36World();
    let before = null;
    const { held } = await acquireAndPreserve(w, {
      pause: ["before-open"],
      onPause: () => {
        w.replace.database();
        before = inventories(w.involved());
      },
    });
    assert.equal(held.held, false);
    assert.equal(held.record.stage, "observe");
    assert.match(
      held.record.refused,
      /^the fixture database name changed while the guard was acquired/,
    );
    assert.deepEqual(
      inventories(w.involved()),
      before,
      "nothing beside the foreign name",
    );
    const own = inventoryOf(join(w.privateParent, "guard-r36"));
    assert.equal(
      own["guard.sqlite"].ino,
      w.receipt.database.ino,
      "the private link is the receipt's inode",
    );
    assert.ok(
      own["guard.sqlite-shm"],
      "the connection's companions are the guard's own",
    );
    w.writer.close();
  } finally {
    clean();
  }
});

test("R36-RET T2 swapped and swapped BACK before the post-open look: the pathname looks owned again, and the proof that the CONNECTION is the receipt's inode is SQLite's own: the last writer's close cannot retire the owned WAL", async () => {
  try {
    const w = r36World();
    const firstWal = idOf(join(w.leaf, "fixture.sqlite-wal"));
    const { held, kept } = await acquireAndPreserve(w, {
      pause: ["before-open", "before-report"],
      onPause: (at) => {
        if (at === "before-open") w.replace.database();
        else {
          renameSync(w.path, w.foreign);
          w.moveOwnedBack();
        }
      },
    });
    assert.equal(held.held, true, JSON.stringify(held.problems));
    assert.deepEqual(held.record.opened, {
      name: "guard.sqlite",
      ...idOf(w.path),
    });
    assert.equal(kept.ready, true, JSON.stringify(kept.guard_problems));
    assert.equal(
      existsSync(`${w.foreign}-wal`),
      false,
      "nothing beside the foreign database",
    );
    assert.equal(existsSync(`${w.foreign}-shm`), false);
    w.writer.close();
    assert.deepEqual(
      idOrNull(join(w.leaf, "fixture.sqlite-wal")),
      firstWal,
      "the guard's connection holds the receipt's database: its WAL is not retired",
    );
    await held.release({ exitObserved: true });
  } finally {
    clean();
  }
});

for (const [name, stimulus, want] of [
  [
    "the WAL name replaced by a symlink",
    (w) => {
      writeFileSync(join(w.foreignDir, "target-wal"), "foreign bytes");
      renameSync(
        join(w.leaf, "fixture.sqlite-wal"),
        join(w.aside, "fixture.sqlite-wal"),
      );
      symlinkSync(
        join(w.foreignDir, "target-wal"),
        join(w.leaf, "fixture.sqlite-wal"),
      );
    },
    /^the WAL is not a regular file/,
  ],
  [
    "the WAL given a second link",
    (w) =>
      linkSync(
        join(w.leaf, "fixture.sqlite-wal"),
        join(w.aside, "second-link"),
      ),
    /^the WAL has 2 links: it is not SQLite's own file alone/,
  ],
  [
    "the fixture directory replaced",
    (w) => {
      renameSync(w.leaf, `${w.leaf}.moved`);
      mkdirSync(w.leaf);
    },
    /^the fixture directory changed while the guard was acquired/,
  ],
])
  test(`R36-RET T2 ${name} at the observation barrier: refused, never followed or opened (the foreign state unchanged)`, async () => {
    try {
      const w = r36World();
      let before = null;
      let afterGuard = null;
      const { held, kept } = await acquireAndPreserve(w, {
        pause: ["before-report"],
        onPause: () => {
          stimulus(w);
          before = inventories(w.involved());
        },
        // The guard's oracle is taken before the anchor (which links the owned regular files, raising their link counts).
        afterGuard: () => {
          afterGuard = inventories(w.involved());
        },
      });
      assert.equal(held.held, false);
      assert.equal(held.record.stage, "observe");
      assert.match(held.record.refused, want);
      assert.deepEqual(afterGuard, before);
      assert.ok(
        !kept.anchors.some(
          (a) => a.name === "fixture.sqlite-wal" && name.includes("symlink"),
        ),
        "a symlinked WAL is never anchored",
      );
      assert.equal(kept.ready, false);
      w.writer.close();
    } finally {
      clean();
    }
  });

test("R36-RET T1: the guard's held report must be its authority's own (a report naming another opened file, attempt or namespace is refused, never held)", async () => {
  try {
    const w = r36World();
    for (const [why, edit] of [
      [
        "another opened file",
        (r) => ({ ...r, opened: { name: "guard.sqlite", dev: "1", ino: "1" } }),
      ],
      ["another attempt", (r) => ({ ...r, attempt: "other" })],
      ["the fixture's own namespace", (r) => ({ ...r, namespace: "fixture" })],
      [
        "another receipt digest",
        (r) => ({ ...r, receipt_sha256: "0".repeat(64) }),
      ],
    ]) {
      const fake = (_command, args) => {
        const child = new EventEmitter();
        child.pid = 1;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const authority = JSON.parse(args[args.indexOf("--authority") + 1]);
        const report = edit({
          event: "held",
          method: "sqlite-private-name-reader/2",
          attempt: authority.attempt,
          receipt_sha256: authority.receipt_sha256,
          namespace: "private",
          private_dir: { path: authority.private_dir, dev: "1", ino: "2" },
          opened: {
            name: "guard.sqlite",
            dev: authority.database.dev,
            ino: authority.database.ino,
          },
          journal_mode: "wal",
          database: {
            dev: authority.database.dev,
            ino: authority.database.ino,
          },
          wal: { dev: "1", ino: "9", nlink: "1" },
          journal: false,
        });
        setImmediate(() => child.stdout.write(`${JSON.stringify(report)}\n`));
        return child;
      };
      const held = await acquireGuard(
        { spawn: fake },
        {
          attempt: "r36",
          fixtureDir: w.leaf,
          receipt: w.receipt,
          receiptSha256: w.receiptSha256,
          privateParent: w.privateParent,
        },
      );
      assert.equal(held.held, false, why);
      assert.match(
        held.problems[0],
        /^the guard's report is not bound to its authority: /,
        why,
      );
    }
    w.writer.close();
  } finally {
    clean();
  }
});

test("R36-RET T3: the owned-source check refuses a missing or wrong authority before anything (no digest, another directory path, an unsafe attempt, a lost-ownership latch) and passes the owned source", () => {
  try {
    const w = r36World();
    const deps = { lstat: (p) => lstatSync(p, { bigint: true }) };
    const base = {
      attempt: "r36",
      fixtureDir: w.leaf,
      receipt: w.receipt,
      receiptSha256: w.receiptSha256,
    };
    assert.deepEqual(ownedSource(deps, base).problems, []);
    assert.equal(ownedSource(deps, base).owned, true);
    for (const [why, edit, want] of [
      ["no digest", { receiptSha256: null }, /^no ready receipt/],
      ["no receipt", { receipt: null }, /^no ready receipt/],
      [
        "another directory",
        { fixtureDir: `${w.leaf}x` },
        /^the receipt does not name this fixture directory's database/,
      ],
      ["an unsafe attempt", { attempt: "../x" }, /is not one$/],
      ...OWNERSHIP_LOST_LATCHES.map((kind) => [
        `a ${kind} latch`,
        { latch: { kind, detail: "x" } },
        new RegExp(`^the attempt lost its fixture \\(${kind}\\)`),
      ]),
    ]) {
      const r = ownedSource(deps, { ...base, ...edit });
      assert.equal(r.owned, false, why);
      assert.match(r.problems[0], want, why);
    }
    assert.equal(
      ownedSource(deps, { ...base, latch: { kind: "exited", detail: "x" } })
        .owned,
      true,
      "an owned failure stays owned",
    );
    w.writer.close();
  } finally {
    clean();
  }
});

for (const kind of OWNERSHIP_LOST_LATCHES)
  test(`R36-RET T3 with real SQLite: a ${kind} latch at the decision — the guard is never started and nothing is anchored or removed; the source is untouched`, async () => {
    try {
      const { out, running } = await realAttempt("normal", {
        latched: () => ({ kind, detail: "x" }),
      });
      assert.equal(out.eligible, false);
      assert.equal(out.guard.spawned, false);
      assert.match(
        out.guard_problems[0],
        new RegExp(`lost its fixture \\(${kind}\\)`),
      );
      assert.equal(out.preservation.dir, null);
      assert.equal(out.remove_requested, false);
      assert.equal(out.retention.status, "unavailable");
      assert.deepEqual(await sourceRows(running), ["ada", "grace"]);
    } finally {
      clean();
    }
  });

test("R36-RET T3 with real SQLite: an OWNED failure (an exited latch) is still guarded and anchored, never removed; its kept source is retained verified", async () => {
  try {
    const { out } = await realAttempt("normal", {
      latched: () => ({ kind: "exited", detail: "x" }),
    });
    assert.equal(out.eligible, false);
    assert.equal(out.guarded, true, JSON.stringify(out.guard_problems));
    assert.equal(out.preserved, true);
    assert.equal(out.remove_requested, false);
    assert.equal(out.retention.status, "verified");
    assert.equal(out.retention.selection.method, "final-named-after-exit");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});

// T5: the guard lost after the anchor. Before the last writer's close: that close retires the WAL (the anchored database then holds every
// commit) and the removal finds none — `retired-into-database` when the anchored WAL adds nothing. After that close: the WAL was kept and
// named at the removal, the guard's proof is incomplete — `failed`, the anchored pair kept raw. In BOTH the oracle is the content that
// survives in the anchors, never the verdict alone.
for (const name of Object.keys(SCHEDULES)) {
  test(`R36-RET T5 ${name}: the guard lost after the anchor, before the last close — the coherent stopped state survives in the anchored database, and is verified unless the anchored WAL is an older generation`, async () => {
    try {
      const r = await schedule(name, {
        guarded: true,
        keep: false,
        loseGuard: "after-anchor",
      });
      assert.equal(r.held.held, true, JSON.stringify(r.held.problems));
      assert.equal(r.kept.ready, true);
      assert.equal(r.released.lost, true);
      assert.equal(
        r.finalWal,
        null,
        "with no guard the last close retired the WAL",
      );
      assert.deepEqual(
        contentOf({ "fixture.sqlite": join(r.kept.dir, "fixture.sqlite") }),
        r.expected,
        "the anchored database holds the stopped state",
      );
      if (RETIRED_STALE.has(name)) {
        assert.equal(r.retention.status, "failed");
        assert.match(
          r.retention.problems[0],
          /^the anchored WAL changes the database it was retired into/,
        );
      } else {
        assert.equal(
          r.retention.status,
          "verified",
          JSON.stringify(r.retention.problems),
        );
        assert.equal(r.retention.selection.method, "retired-into-database");
        assert.deepEqual(r.observed, r.expected);
      }
    } finally {
      clean();
    }
  });
  test(`R36-RET T5 ${name}: the guard lost after the last close, before the removal — never verified (its proof is incomplete), and the anchored database and WAL still hold the stopped state`, async () => {
    try {
      const r = await schedule(name, {
        guarded: true,
        keep: false,
        loseGuard: "after-final-close",
      });
      assert.equal(r.released.lost, true);
      assert.deepEqual(
        r.finalWal,
        r.anchoredWal,
        "the guard held through the last close: one generation",
      );
      assert.ok(r.removed.includes("fixture.sqlite-wal"));
      assert.equal(r.retention.status, "failed");
      assert.match(r.retention.problems[0], /the guard was lost/);
      assert.deepEqual(
        contentOf({
          "fixture.sqlite": join(r.kept.dir, "fixture.sqlite"),
          "fixture.sqlite-wal": join(r.kept.dir, "fixture.sqlite-wal"),
        }),
        r.expected,
        "the raw anchored pair is the stopped state (unproven, kept)",
      );
    } finally {
      clean();
    }
  });
}

test("R36-RET T5 with real SQLite: the guard killed after the removal was admitted, before the shutdown — the executable's close retires the WAL, its removal finds none, and the anchored database alone is retained verified with the committed rows", async () => {
  try {
    let killed = false;
    let guard = null;
    const { out, running } = await realAttempt("normal", {
      afterGuard: (_r, held) => {
        guard = held;
      },
      // After the removal decision (the guard was alive for it), before the shutdown command: the death is awaited, not timed.
      beforeFinish: async (_r, remove) => {
        if (!remove) return;
        process.kill(guard.record.pid, "SIGKILL");
        await new Promise((resolve) => {
          const poll = () => (guard.alive() ? setTimeout(poll, 5) : resolve());
          poll();
        });
        killed = true;
      },
    });
    assert.equal(killed, true);
    assert.equal(out.remove_requested, true);
    assert.equal(existsSync(running.fixtureDir), false);
    assert.equal(out.released.lost, true);
    assert.ok(
      !out.finished.stopped.removed.includes("fixture.sqlite-wal"),
      "the WAL was retired by the close",
    );
    assert.equal(
      out.retention.status,
      "verified",
      JSON.stringify(out.retention.problems),
    );
    assert.equal(out.retention.selection.method, "retired-into-database");
    assert.deepEqual(await inspectedUsernames(out.retention), ["ada", "grace"]);
  } finally {
    clean();
  }
});

test("R36-RET T2 the anchor: a database replaced between the owned-source check and its link is never anchored as the fixture (the loop's own identity check), and the anchor is not ready", () => {
  try {
    const w = r36World();
    w.replace.database();
    // The owned-source check is shown the receipt's database (the replacement happens just after it); every later look is real.
    let first = true;
    const deps = {
      ...retentionDeps(),
      lstat: (path) => {
        if (path === w.path && first) {
          first = false;
          return lstatSync(join(w.aside, "fixture.sqlite"), { bigint: true });
        }
        return lstatSync(path, { bigint: true });
      },
    };
    const kept = preserveFixture(deps, {
      fixtureDir: w.leaf,
      receipt: w.receipt,
      receiptSha256: w.receiptSha256,
      retainedParent: w.privateParent,
      attempt: "r36",
    });
    assert.equal(
      first,
      false,
      "the owned-source check passed on the receipt's identity",
    );
    assert.notEqual(kept.dir, null, "the anchor was begun");
    assert.ok(
      kept.problems.includes(
        "the fixture database is not the receipt's: not anchored",
      ),
      JSON.stringify(kept.problems),
    );
    assert.ok(!kept.anchors.some((a) => a.name === "fixture.sqlite"));
    assert.equal(
      existsSync(join(kept.dir, "fixture.sqlite")),
      false,
      "the replacement is never linked",
    );
    assert.equal(kept.anchored, false);
    assert.equal(kept.ready, false);
    w.writer.close();
  } finally {
    clean();
  }
});

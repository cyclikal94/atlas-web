// WEB-09c revision 26 (R26-DIAG; design assessment Q2/Q3): the diagnostic adapter's protocol state machine (deterministic streams) and its
// owned lifecycle (the protocol stand-in diagnostic-fake.mjs as a real child process: never the backend, never backend evidence).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createJournal } from "./causal-journal.mjs";
import {
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
  parseLine,
  readyProblems,
  removeParentIfEmpty,
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
/** concludeAttempt with recording fakes: what was asked of `finish`, and in which order the steps ran. */
async function conclude({
  transport = [],
  preliminary = [],
  latched = null,
  terminal = [],
  throwIn = null,
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
  const out = await concludeAttempt({
    stopTransports: step("stop", transport),
    preliminary: step("preliminary", preliminary),
    latched: () => {
      order.push("latched");
      return latched;
    },
    finish: step("finish", (eligible) => {
      asked = eligible;
      return { requested_remove: eligible };
    }),
    terminal: step("terminal", terminal),
  });
  return { out, order, asked };
}
test("DA-DIAG-F: a healthy attempt is judged first, then asked to remove its fixture, then judged again", async () => {
  const { out, order, asked } = await conclude();
  assert.deepEqual(order, [
    "stop",
    "preliminary",
    "latched",
    "finish",
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
    // Every step still runs: the failure's evidence is complete, and the terminal validation is made too.
    assert.deepEqual(order, [
      "stop",
      "preliminary",
      "latched",
      "finish",
      "terminal",
    ]);
  });
test("DA-DIAG-F: a terminal-only failure after a healthy removal request stays a failure (and is not reported as retained)", async () => {
  const { out, asked } = await conclude({
    terminal: ["attempt: shutdown #9 was not answered by its stopped event"],
  });
  assert.equal(asked, true);
  assert.equal(out.eligible, true);
  assert.deepEqual(out.terminal, [
    "attempt: shutdown #9 was not answered by its stopped event",
  ]);
  assert.equal(out.finished.requested_remove, true);
});
test("DA-DIAG-F with the real stand-in child: a known preliminary failure keeps the fixture (remove:false is sent), its files survive", async () => {
  const parent = tmp();
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
  }
});
test("DA-DIAG-F with the real stand-in child: an outstanding unanswered command ends by EOF and keeps the fixture", async () => {
  const parent = tmp();
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
      finish: (eligible) => finishAttempt(running, { remove: eligible }),
      terminal: async () => [],
    });
    assert.equal(out.eligible, false, "a latched control is not eligible");
    assert.equal(out.finished.eof, true);
    assert.ok(existsSync(join(running.fixtureDir, "receipt.json")));
  } finally {
    reap();
    rmSync(parent, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

// WEB-08d revision 17 (review r16 H7): the ACTUAL session-matrix driver (scripts/run-session-matrix.mjs, located beside this file so a
// disposable copy tests itself) with its shard children replaced by a preloaded `spawn` that asks this test, over loopback, which records
// to write and how to end, and when. The records are labelled synthetic: protocol evidence for the driver's gate and accounting, not
// scenario or mutation acceptance (that is the full `pnpm test:session-matrix`).
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
const RUNNER = join(base, "scripts/run-session-matrix.mjs");
const EXPECTED = {
  exposure: 52488,
  "own-exposure-vs-own-closing-write": 2160,
  "foreign-closing-write-vs-exposure": 2160,
  "stage-vs-trigger": 240,
  "own-detection-vs-queued-request": 192,
  "request-vs-closing-write": 2880,
};
// The 16 names, read from the source the driver restates them from, so the two cannot drift apart unnoticed.
const MUTANTS = [
  ...readFileSync(
    join(base, "tests/support/session/mutants.ts"),
    "utf8",
  ).matchAll(/^ {4}name: "([^"]+)",$/gm),
].map((m) => m[1]);

const PRELOAD = `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
cp.spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const env = options.env;
  const socket = net.connect(Number(process.env.MATRIX_STUB_PORT), "127.0.0.1");
  let buffer = "";
  socket.on("connect", () => socket.write(JSON.stringify({ file: args.at(-1), shard: Number(env.MATRIX_SHARD), shards: Number(env.MATRIX_SHARDS), parts: env.MATRIX_PARTS ?? null, out: env.MATRIX_OUT }) + "\\n"));
  socket.on("data", (chunk) => {
    buffer += chunk;
    const end = buffer.indexOf("\\n");
    if (end < 0) return;
    const a = JSON.parse(buffer.slice(0, end));
    socket.end();
    for (const r of a.records ?? []) fs.writeFileSync(path.join(env.MATRIX_OUT, r.name), r.raw ?? JSON.stringify(r.data));
    if (a.log) child.stdout.write(a.log);
    child.stdout.end();
    child.stderr.end();
    if (a.spawnError) child.emit("error", new Error(a.spawnError));
    else child.emit("close", "code" in a ? a.code : 0, a.signal ?? null);
  });
  return child;
};
syncBuiltinESMExports();
`;

/** One shard's sound scenario records (scenario i belongs to shard i mod n). */
function scenarioRecords(launch, over = {}) {
  const parts = launch.parts ? launch.parts.split(",") : Object.keys(EXPECTED);
  return parts.map((part) => {
    const run =
      Math.floor(EXPECTED[part] / launch.shards) +
      (launch.shard < EXPECTED[part] % launch.shards ? 1 : 0);
    const data = {
      part,
      shard: launch.shard,
      shards: launch.shards,
      run,
      failed: 0,
      failures: [],
      stats: { checked: run },
      wall_ms: 1,
      ...over[part],
    };
    return { name: `${part}.${launch.shard}.json`, data };
  });
}
function mutantRecords(launch, over = {}) {
  return MUTANTS.filter((_, i) => i % launch.shards === launch.shard).map(
    (mutant) => ({
      name: `mutant.${mutant}.json`,
      data: {
        mutant,
        rule: "synthetic",
        expect: "synthetic",
        caught: true,
        control_clean: true,
        examined: 1,
        witnesses: [],
        wall_ms: 1,
        ...over[mutant],
      },
    }),
  );
}
const healthy = (l) => ({
  records: l.file.includes("mutants") ? mutantRecords(l) : scenarioRecords(l),
  code: 0,
  log: `shard ${l.shard} synthetic output\n`,
});
function later() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}

function start({ args = ["--shards", "2"], answer }) {
  const dir = owned(mkdtempSync(join(tmpdir(), "session-matrix-test-")));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, PRELOAD);
  const scratch = join(dir, "tmp");
  const evidence = join(dir, "evidence");
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
      const said = JSON.parse(buffer.slice(0, end));
      const launch = {
        ...said,
        phase: said.file.includes("mutants.matrix") ? "mutants" : "scenarios",
      };
      buffer = "";
      launches.push(launch);
      for (const w of [...waiters]) w();
      const reply = await answer(launch);
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => {});
  });
  const handle = { launches, evidence, dir };
  handle.launched = (n) =>
    new Promise((r) => {
      const check = () => {
        if (launches.length >= n) r();
      };
      waiters.push(check);
      check();
    });
  handle.done = new Promise((r) => server.listen(0, "127.0.0.1", r)).then(
    () =>
      new Promise((resolveRun) => {
        mkdirSync(scratch, { recursive: true });
        const child = spawn(process.execPath, [RUNNER, ...args], {
          cwd: base,
          env: {
            ...process.env,
            TMPDIR: scratch,
            NODE_OPTIONS: `--import=${preload}`,
            MATRIX_STUB_PORT: String(server.address().port),
            ATLAS_MATRIX_EVIDENCE: evidence,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        running.add(child);
        child.on("close", () => running.delete(child));
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => {
          server.close();
          for (const s of sockets) s.destroy();
          const read = (f) =>
            existsSync(join(evidence, f))
              ? JSON.parse(readFileSync(join(evidence, f), "utf8"))
              : null;
          resolveRun({
            dir,
            code,
            stdout,
            stderr,
            launches,
            run: read("matrix-run.json"),
            mutants: read("matrix-mutants.json"),
            check12: read("matrix-12.json"),
            scratchLeft: readdirSync(scratch),
            raw: (phase) =>
              existsSync(join(evidence, "raw", phase))
                ? readdirSync(join(evidence, "raw", phase)).sort()
                : [],
          });
        });
      }),
  );
  return handle;
}
/** An evidence file the driver must have written; its absence is an assertion failure (never a TypeError). */
function got(value, what) {
  assert.ok(value, `the driver wrote ${what}`);
  return value;
}
const phases = (r) => r.launches.map((l) => `${l.phase}:${l.shard}`);
const cleanup = (r) => rmSync(r.dir, { recursive: true, force: true });

test("the driver's 16 restated mutations are exactly tests/support/session/mutants.ts's", () => {
  assert.equal(MUTANTS.length, 16);
  const driver = readFileSync(RUNNER, "utf8");
  const from = driver.indexOf("const EXPECTED_MUTANTS = [");
  assert.ok(from >= 0, "the driver restates the mutations");
  const restated = [
    ...driver
      .slice(from, driver.indexOf("];", from))
      .matchAll(/^ {2}"([^"]+)",$/gm),
  ].map((m) => m[1]);
  assert.deepEqual([...restated].sort(), [...MUTANTS].sort());
});

test("healthy control (2 shards): complete clean scenarios, then the mutation phase; exit 0; raw records kept; scratch removed", {
  timeout: 60_000,
}, async () => {
  const h = start({ answer: healthy });
  const r = await h.done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(phases(r).sort(), [
    "mutants:0",
    "mutants:1",
    "scenarios:0",
    "scenarios:1",
  ]);
  assert.ok(
    r.launches.findIndex((l) => l.phase === "mutants") >
      r.launches.findLastIndex((l) => l.phase === "scenarios"),
  );
  assert.equal(got(r.run, "matrix-run.json").passed, true);
  assert.equal(got(r.run, "matrix-run.json").partial, false);
  assert.equal(got(r.run, "matrix-run.json").phases.scenarios.status, "passed");
  assert.equal(got(r.run, "matrix-run.json").phases.mutants.status, "passed");
  assert.equal(got(r.mutants, "matrix-mutants.json").mutants_reported, 16);
  assert.equal(got(r.check12, "matrix-12.json").scenarios_run, 52488);
  assert.equal(
    r.raw("scenarios").filter((f) => f.endsWith(".json")).length,
    12,
  );
  assert.ok(r.raw("scenarios").includes("shard-1.log"));
  assert.equal(r.raw("mutants").filter((f) => f.endsWith(".json")).length, 16);
  assert.deepEqual(
    r.scratchLeft.filter((f) => f.startsWith("session-matrix-")),
    [],
  );
  cleanup(r);
});

test("H7 Q7: an incomplete or failing scenario phase never admits the mutation phase", {
  timeout: 60_000,
}, async () => {
  const variants = {
    "a shard exits 1": (l) => ({ ...healthy(l), code: 1 }),
    "a shard is killed": (l) => ({
      ...healthy(l),
      code: null,
      signal: "SIGKILL",
    }),
    "a shard does not start": () => ({ spawnError: "spawn ENOENT" }),
    "a part is missing (exit 0)": (l) => ({
      ...healthy(l),
      records: scenarioRecords(l).filter(
        (r) => !r.name.startsWith("request-vs-closing-write"),
      ),
    }),
    "an undercount (exit 0)": (l) => ({
      ...healthy(l),
      records: scenarioRecords(l, { exposure: { run: 1 } }),
    }),
    "a violation (exit 0)": (l) => ({
      ...healthy(l),
      records: scenarioRecords(l, {
        "stage-vs-trigger": { failed: 1, failures: ["synthetic violation"] },
      }),
    }),
    "a record of another shard's identity": (l) => ({
      ...healthy(l),
      records: scenarioRecords(l, { exposure: { shard: 0 } }),
    }),
    // Only the record's own identity says this: its counts still add up.
    "a record from a run with another shard count (exit 0)": (l) => ({
      ...healthy(l),
      records: scenarioRecords(l, { exposure: { shards: 3 } }),
    }),
    "a corrupt record": (l) => ({
      ...healthy(l),
      records: [
        ...scenarioRecords(l).slice(1),
        { name: `exposure.${l.shard}.json`, raw: "{" },
      ],
    }),
    "a record for an unselected part": (l) => ({
      ...healthy(l),
      records: [
        ...scenarioRecords(l),
        {
          name: `bogus.${l.shard}.json`,
          data: {
            part: "bogus",
            shard: l.shard,
            shards: l.shards,
            run: 1,
            failed: 0,
            failures: [],
            stats: {},
            wall_ms: 1,
          },
        },
      ],
    }),
  };
  for (const [name, bad] of Object.entries(variants)) {
    const r = await start({
      answer: (l) =>
        l.phase === "scenarios" && l.shard === 1 ? bad(l) : healthy(l),
    }).done;
    assert.equal(r.code, 1, name);
    assert.deepEqual(
      phases(r).filter((p) => p.startsWith("mutants")),
      [],
      `${name}: no mutation shard may start`,
    );
    assert.equal(
      got(r.run, "matrix-run.json").phases.scenarios.status,
      "failed",
      name,
    );
    assert.equal(
      got(r.run, "matrix-run.json").phases.mutants.status,
      "not_run",
      name,
    );
    assert.deepEqual(
      [...got(r.mutants, "matrix-mutants.json").not_run_mutants].sort(),
      [...MUTANTS].sort(),
      name,
    );
    assert.equal(got(r.mutants, "matrix-mutants.json").not_run, true, name);
    assert.deepEqual(
      r.scratchLeft.filter((f) => f.startsWith("session-matrix-")),
      [],
      name,
    );
    cleanup(r);
  }
});

test("H7 Q8: one shard fails while the other is held; the held shard settles and is kept; the mutation phase never begins", {
  timeout: 60_000,
}, async () => {
  const held = later();
  const h = start({
    answer: (l) =>
      l.phase === "scenarios" && l.shard === 1
        ? held.promise
        : l.phase === "scenarios"
          ? { ...healthy(l), code: 1 }
          : healthy(l),
  });
  await h.launched(2);
  held.release(healthy(h.launches.find((l) => l.shard === 1)));
  const r = await h.done;
  assert.equal(r.code, 1);
  assert.deepEqual(phases(r).sort(), ["scenarios:0", "scenarios:1"]);
  assert.ok(
    r.raw("scenarios").includes("exposure.1.json"),
    "the held shard's record is kept",
  );
  assert.ok(r.raw("scenarios").includes("shard-0.log"));
  assert.match(
    got(r.run, "matrix-run.json").problems.join("\n"),
    /scenario shard 0 exited 1/,
  );
  cleanup(r);
});

test("the mutation phase's own records are checked: missing, unknown, uncaught or dirty mutations fail", {
  timeout: 60_000,
}, async () => {
  const variants = {
    "one missing": (l) => ({
      ...healthy(l),
      records: mutantRecords(l).slice(1),
    }),
    "an unknown name": (l) => ({
      ...healthy(l),
      records: [
        ...mutantRecords(l),
        {
          name: "mutant.synthetic-00.json",
          data: { mutant: "synthetic-00", caught: true, control_clean: true },
        },
      ],
    }),
    "an uncaught one": (l) => ({
      ...healthy(l),
      records: mutantRecords(l, { [MUTANTS[0]]: { caught: false } }),
    }),
    "a dirty control": (l) => ({
      ...healthy(l),
      records: mutantRecords(l, { [MUTANTS[0]]: { control_clean: false } }),
    }),
    "a corrupt record": (l) => ({
      ...healthy(l),
      records: [
        ...mutantRecords(l).slice(1),
        { name: mutantRecords(l)[0].name, raw: "{" },
      ],
    }),
    "a shard exits 1": (l) => ({ ...healthy(l), code: 1 }),
  };
  for (const [name, bad] of Object.entries(variants)) {
    const r = await start({
      answer: (l) =>
        l.phase === "mutants" && l.shard === 0 ? bad(l) : healthy(l),
    }).done;
    assert.equal(r.code, 1, name);
    assert.equal(
      got(r.run, "matrix-run.json").phases.mutants.status,
      "failed",
      name,
    );
    cleanup(r);
  }
});

test("--parts, --skip-mutants and --only-mutants are labelled partial diagnostics; bad options are refused before any shard", {
  timeout: 60_000,
}, async () => {
  const parts = await start({
    args: ["--shards", "2", "--parts", "exposure"],
    answer: healthy,
  }).done;
  assert.equal(parts.code, 0, parts.stderr);
  assert.equal(got(parts.run, "matrix-run.json").partial, true);
  assert.equal(
    got(parts.run, "matrix-run.json").phases.mutants.status,
    "not_run",
  );
  assert.equal(got(parts.check12, "matrix-12.json").partial, true);
  assert.match(parts.stdout, /PARTIAL/);
  cleanup(parts);
  const skip = await start({
    args: ["--shards", "1", "--skip-mutants"],
    answer: healthy,
  }).done;
  assert.equal(skip.code, 0, skip.stderr);
  assert.equal(got(skip.run, "matrix-run.json").partial, true);
  assert.deepEqual(phases(skip), ["scenarios:0"]);
  cleanup(skip);
  const only = await start({
    args: ["--shards", "1", "--only-mutants"],
    answer: healthy,
  }).done;
  assert.equal(only.code, 0, only.stderr);
  assert.equal(got(only.run, "matrix-run.json").partial, true);
  assert.deepEqual(phases(only), ["mutants:0"]);
  cleanup(only);
  for (const args of [
    ["--shards", "0"],
    ["--shards", "x"],
    ["--parts", "bogus"],
    ["--bogus"],
    ["--skip-mutants", "--only-mutants"],
  ]) {
    const r = await start({ args, answer: healthy }).done;
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(r.launches, [], args.join(" "));
    cleanup(r);
  }
});

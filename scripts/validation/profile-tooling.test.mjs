// The sync-profiling tooling (WEB-09c plan 4.1, 4.2 and 4.6): the evidence directory is required, never cleaned and held by one writer at
// a time, a spec run has no default directory, the evidence contract resolves every required observation (revision 2: review R1, R2 and
// R4; design assessment Q1 to Q9 and Q13), the hand-over validator re-resolves the evidence a hand-over carries, and the budget checker
// holds both builds to the measured `budget`. Every check runs the real scripts in a child process. `ATLAS_TOOLING_ROOT` points them at another copy of the
// repository (the qualification runner's mutated copies); by default they are this repository's own.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(
  process.env.ATLAS_TOOLING_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const evidence = await import(
  pathToFileURL(join(root, "scripts/lib/profile-evidence.mjs")).href
);
const isolation = await import(
  pathToFileURL(join(root, "scripts/lib/profile-isolation.mjs")).href
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const node = (args, options = {}) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: 180_000,
  });
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-profile-tooling-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** Every file under `dir` with its hash: what a refusal must leave exactly as it was. */
const inventory = (dir) => {
  const out = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return out;
};
const populate = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
};

// ---- the evidence directory --------------------------------------------------------------------------------------------------------------
test("control: an empty evidence directory is accepted by both drivers (preflight writes nothing)", (t) => {
  const dir = join(scratch(t), "fresh");
  for (const script of [
    "scripts/profile-sync.mjs",
    "scripts/profile-contention.mjs",
  ]) {
    const run = node([join(root, script), "--evidence", dir, "--preflight"]);
    assert.equal(run.status, 0, `${script}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /preflight: would run/);
    assert.equal(existsSync(dir), false, `${script} wrote into ${dir}`);
  }
});

test("case: without --evidence both drivers refuse (exit 2): there is no default directory", () => {
  for (const script of [
    "scripts/profile-sync.mjs",
    "scripts/profile-contention.mjs",
  ]) {
    const run = node([join(root, script), "--preflight"]);
    assert.equal(run.status, 2, `${script}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /--evidence <dir> is required/);
  }
});

test("case: a directory that already records a stage is refused (exit 2) and every file in it is left exactly as it was", (t) => {
  const cases = [
    [
      "scripts/profile-sync.mjs",
      ["--only", "bundle"],
      { "bundle-delta.json": "{}\n" },
    ],
    [
      "scripts/profile-sync.mjs",
      ["--only", "fixture"],
      { "raw/P-2.chromium.json": "{}\n" },
    ],
    [
      "scripts/profile-sync.mjs",
      ["--only", "integration"],
      { "w2/W2-captured.chromium.limit-1.json": "{}\n" },
    ],
    [
      "scripts/profile-sync.mjs",
      ["--only", "handoff"],
      { "handoff/results.json": "{}\n" },
    ],
    [
      "scripts/profile-sync.mjs",
      ["--only", "shell"],
      { "stages/shell.json": "{}\n" },
    ],
    [
      "scripts/profile-contention.mjs",
      [],
      { "contention/waits.jsonl": "{}\n" },
    ],
  ];
  for (const [script, extra, files] of cases) {
    const dir = scratch(t);
    populate(dir, {
      ...files,
      "measurements.jsonl": '{"name":"P-6 x","engine":"chromium"}\n',
      "values.jsonl": '{"name":"P-7 y","engine":"webkit"}\n',
    });
    const before = inventory(dir);
    const run = node([
      join(root, script),
      "--evidence",
      dir,
      ...extra,
      "--preflight",
    ]);
    assert.equal(
      run.status,
      2,
      `${script} ${extra.join(" ")}: ${run.stdout}${run.stderr}`,
    );
    assert.match(run.stderr, /refused: .* already records/);
    assert.deepEqual(inventory(dir), before, `${script} changed the directory`);
  }
});

test("case: the fixture generator has no default directory and refuses an existing one", (t) => {
  const none = node([join(root, "scripts/generate-profile-fixtures.mjs")]);
  assert.equal(none.status, 2, none.stderr);
  const dir = scratch(t);
  populate(dir, { "fixtures/hashes.json": "{}\n" });
  const before = inventory(dir);
  const taken = node([
    join(root, "scripts/generate-profile-fixtures.mjs"),
    "--out",
    dir,
  ]);
  assert.equal(taken.status, 2, taken.stderr);
  assert.deepEqual(inventory(dir), before);
});

test("case: no profiling script or spec names the old fixed WEB-09a evidence path", () => {
  for (const file of [
    "scripts/profile-sync.mjs",
    "scripts/profile-contention.mjs",
    "scripts/generate-profile-fixtures.mjs",
    "scripts/lib/profile-evidence.mjs",
    "tests/e2e/profile-helpers.ts",
    "tests/e2e/fixture.profile-sync.spec.ts",
    "tests/e2e/fixture.profile-contention.spec.ts",
    "tests/integration/integration.profile-sync.spec.ts",
  ])
    assert.equal(
      readFileSync(join(root, file), "utf8").includes(
        ".agtx/evidence/WEB-09a/profiling",
      ),
      false,
      `${file} names .agtx/evidence/WEB-09a/profiling`,
    );
});

// ---- a spec run's directory --------------------------------------------------------------------------------------------------------------
test("control: a profiling run with an absolute ATLAS_PROFILE_OUT writes there; outside a profiling run there is no directory", () => {
  assert.equal(
    evidence.profileOutFromEnv({
      ATLAS_PROFILE: "1",
      ATLAS_PROFILE_OUT: "/tmp/run/profiling",
    }),
    "/tmp/run/profiling",
  );
  assert.equal(evidence.profileOutFromEnv({}), null);
});

test("case: a profiling run without an absolute ATLAS_PROFILE_OUT is an error, never a default path", () => {
  assert.throws(
    () => evidence.profileOutFromEnv({ ATLAS_PROFILE: "1" }),
    /ATLAS_PROFILE_OUT/,
  );
  assert.throws(
    () =>
      evidence.profileOutFromEnv({
        ATLAS_PROFILE: "1",
        ATLAS_PROFILE_OUT: "relative/dir",
      }),
    /ATLAS_PROFILE_OUT/,
  );
});

const VITEST = "9001 1 180.0 node vitest run";

// ---- the evidence contract (revision 2: review R1, R2; design assessment Q1 to Q9) ------------------------------------------------------
// The synthetic programme (profile-programme-fixture.mjs) is written from the writers' side and imports nothing from the contract. Cases
// change ONE thing and expect the exact cell the contract must name; the end-to-end cases run the real assembler and the real validator.
const contract = await import(
  pathToFileURL(join(root, "scripts/lib/profile-contract.mjs")).href
);
const programme = await import(
  pathToFileURL(join(root, "scripts/validation/profile-programme-fixture.mjs"))
    .href
);
const writeComplete = (dir, options = {}) =>
  programme.writeProgramme(dir, {
    candidate: evidence.candidate(root),
    ...options,
  });
const resolveDir = (dir) => contract.resolveEvidence(dir);
const cell = (r, id) => {
  const found = r.cells.find((c) => c.id === id);
  assert.ok(found, `no cell ${id}`);
  return found;
};
const readLines = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const writeLines = (file, rows) =>
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
const editJson = (file, change) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(change(value) ?? value, null, 2)}\n`);
};
const assemble = (dir) =>
  node([
    join(root, "scripts/profile-sync.mjs"),
    "--evidence",
    dir,
    "--only",
    "handoff",
  ]);
const resultsOf = (dir) =>
  JSON.parse(readFileSync(join(dir, "handoff/results.json"), "utf8"));
const validate = (dir, ...flags) =>
  node([
    join(root, "scripts/validate-profile-handoff.mjs"),
    "--handoff",
    dir,
    ...flags,
  ]);
/** Re-writes SHA256SUMS over a hand-over, so a semantic check is tested and not merely the checksums. */
const resum = (dir) => {
  const lines = Object.entries(inventory(dir))
    .filter(([name]) => name !== "SHA256SUMS")
    .map(([name, hash]) => `${hash}  ${name}`)
    .sort();
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
};
/** A complete hand-over, assembled once by the real assembler; cases take a copy. */
let assembledOnce = null;
const assembledCopy = (t) => {
  if (!assembledOnce) {
    const dir = join(
      mkdtempSync(join(tmpdir(), "atlas-profile-template-")),
      "p",
    );
    writeComplete(dir);
    const run = assemble(dir);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assembledOnce = dir;
  }
  const copy = join(scratch(t), "p");
  cpSync(assembledOnce, copy, { recursive: true });
  return copy;
};

/** The required observations, counted independently (plan C1-C11 and the writers' sample counts), per item and engine. */
const EXPECTED_CELLS_PER_ENGINE = {
  "P-2": 33, // 8 shapes x (wall, scan, commit, long tasks) + the raw trace
  "P-3": 6, // draft, fence, form_recovery x strict, default
  "P-5": 5, // drain, per-draft, the declared D-18 omission, dense drain, dense per-draft
  "P-11": 76, // W1/W3/W4/W6 x 5 outcomes + 5 memory; 6 W7 controls; 10 workloads x (elapsed, rss, heap)
  "P-Q": 1,
  "P-Q2": 1,
  "P-6": 4, // + the real Chromium crash: 5 in Chromium
  "P-7": 11, // 2 conditions x (3 waits + closing); scaled freeze series and rows; production wait
  "P-8": 1,
  "P-9": 17, // 4 policies x (3 waits + throughput); engine support
  "P-13": 7, // 4 read conditions; 0/1/2-follower throughput
  "P-4": 10, // sync page 4 segments; draft 6 segments
  "P-10": 3, // two unthrottled cross-checks; the 250 ms delayed sync
  "P-W2": 19, // backend; captures 1 and 80; live outcome + memory; 5 cold outcomes + memory; 3 summaries; the bound
  "W2-limits": 1,
  device: 40, // the results file; 39 distinct runs over 19 workloads
  cases: 19,
};

test("control: the contract's required set is the independently counted inventory (796 cells; every item, engine and count)", () => {
  const cells = contract.requiredCells();
  assert.equal(cells.length, 796);
  assert.equal(new Set(cells.map((c) => c.id)).size, cells.length);
  const count = (item, engine) =>
    cells.filter((c) => c.item === item && c.engine === engine).length;
  for (const engine of ["chromium", "firefox", "webkit"])
    for (const [item, n] of Object.entries(EXPECTED_CELLS_PER_ENGINE))
      assert.equal(
        count(item, engine),
        item === "P-6" && engine === "chromium" ? n + 1 : n,
        `${item} [${engine}]`,
      );
  assert.equal(cells.filter((c) => c.item === "stages").length, 6);
  assert.equal(cells.filter((c) => c.item === "P-1").length, 3);
  assert.equal(
    cells.filter((c) => c.item === "P-1S" && c.engine === "chromium").length,
    24,
  );
  const n = (name, engine = "webkit") =>
    cells.find((c) => c.id === `${name}[${engine}]`)?.n;
  assert.equal(n("P-2 ordinary-800 scan_ms"), 300);
  assert.equal(n("P-2 dense-800-W1 commit_ms"), 15);
  assert.equal(n("P-3 fence strict write_ms"), 300);
  assert.equal(n("P-4 draft stamping_ms"), 300);
  assert.equal(n("P-10 sync page duration_ms (proxy delay 250 ms)"), 100);
  assert.equal(n("P-7 frozen owner: writer wait (scaled 1 s)"), 105);
  assert.equal(
    n("P-13 leader catch-up throughput (pages/s, 200 pages), 2 follower(s)"),
    3,
  );
  assert.equal(n("P-11 W1 elapsed_ms"), 5);
  assert.equal(n("P-W2 rss_peak_kib"), 5);
});

test("control: a complete synthetic programme resolves complete: every cell ok or a declared capability", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const r = resolveDir(dir);
  assert.deepEqual(
    r.cells.filter((c) => !["ok", "unavailable"].includes(c.status)),
    [],
  );
  assert.equal(
    r.counts.unavailable,
    38,
    "long tasks and heap outside Chromium only",
  );
  assert.equal(r.complete, true);
  assert.equal(r.derived.desktop_valid_workload_failure, false);
  assert.equal(r.derived.desktop_needs_finer_pagination, false);
  assert.deepEqual(r.derived.desktop_D_largest_dense_changes_committed, {
    chromium: 800,
    firefox: 800,
    webkit: 800,
  });
});

test("control: the real assembler makes a complete hand-over of it, and the real validator resolves it again (exit 0)", (t) => {
  const dir = assembledCopy(t);
  const results = resultsOf(dir);
  assert.equal(results.desktop_programme.complete, true);
  assert.deepEqual(results.desktop_programme.missing, []);
  assert.equal(results.H8.desktop_valid_workload_failure, false);
  assert.equal(results.H9.desktop_needs_finer_pagination, false);
  assert.match(results.H9.needs_finer_pagination, /do not need it/);
  assert.match(
    readFileSync(join(dir, "handoff/report.md"), "utf8"),
    /Desktop programme: COMPLETE and ISOLATED/,
  );
  assert.ok(existsSync(join(dir, "handoff/evidence/measurements.jsonl")));
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
});

test("case: the revision-1 skeletal 'complete' programme (one generic series per case, empty shell files) is incomplete and refused", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const rows = readLines(join(dir, "measurements.jsonl"));
  writeLines(join(dir, "measurements.jsonl"), rows.slice(0, 1));
  writeFileSync(join(dir, "shell/dist.json"), "{}\n");
  writeFileSync(join(dir, "shell/dist-fixture.json"), "{}\n");
  rmSync(join(dir, "contention"), { recursive: true });
  const r = resolveDir(dir);
  assert.equal(r.complete, false);
  assert.equal(r.outcomes_complete, false);
  assert.ok(
    r.counts.missing + r.counts.invalid > 300,
    `${r.counts.missing} missing, ${r.counts.invalid} invalid`,
  );
  for (const item of ["P-1S", "P-2", "P-6", "P-13"])
    assert.notEqual(r.items[item].status, "measured", item);
  assert.equal(r.derived.desktop_valid_workload_failure, null);
  assert.equal(r.derived.desktop_needs_finer_pagination, null);
});

// ---- Q2: the shell is in the isolation domain ----
test("case: foreign work throughout the SHELL stage only (quiet before it) leaves all 24 shell runs not isolated and the hand-over partial", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir, {
    busy: (stage, s) => (stage === "shell" && s >= 0 ? [VITEST] : []),
  });
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  const shellCells = results.desktop_programme.not_isolated.filter((c) =>
    c.id.startsWith("P-1S:"),
  );
  assert.equal(shellCells.length, 24);
  assert.equal(results.desktop_programme.not_isolated.length, 24);
  assert.equal(results.desktop_programme.complete, false);
  assert.equal(results.desktop_programme.outcomes_complete, true);
  assert.equal(results.programme["P-1S"].status, "partial");
  assert.equal(results.H9.desktop_needs_finer_pagination, null);
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 1, `${checked.stdout}${checked.stderr}`);
  assert.match(
    checked.stdout,
    /PARTIAL hand-over: the desktop programme is not isolated/,
  );
});

test("case: foreign work during ONE shell run's window (quiet at its end) disqualifies that run only; the export order of rows changes nothing", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir, {
    busy: (stage, s) =>
      stage === "shell" && s >= 52 && s <= 62 ? [VITEST] : [],
  });
  const r = resolveDir(dir);
  assert.deepEqual(r.not_isolated, [
    "P-1S:dist:mobile:fast-4g:run-2[chromium]",
  ]);
  writeLines(
    join(dir, "measurements.jsonl"),
    readLines(join(dir, "measurements.jsonl")).reverse(),
  );
  const again = resolveDir(dir);
  assert.deepEqual(
    again.cells.map((c) => [c.id, c.status]),
    r.cells.map((c) => [c.id, c.status]),
  );
});

test("case: a standalone shell result copied in (no stage, no invocation) is not programme evidence", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editJson(join(dir, "shell/dist.json"), (v) => {
    v.evidence = { stage: null, invocation: null };
  });
  const r = resolveDir(dir);
  assert.equal(
    cell(r, "P-1S:dist:desktop:slow-4g:run-3[chromium]").status,
    "invalid",
  );
  assert.match(
    cell(r, "P-1S:dist:desktop:slow-4g:run-3[chromium]").reasons.join(" "),
    /written by stage null/,
  );
});

// ---- Q3: sampler barriers and stage binding ----
test("case: a stage whose sampler was not ready, wrote no final sample, wrote a malformed or backwards sample, or left a gap judges its cells unknown", (t) => {
  const breakers = {
    "not ready": (dir) =>
      editJson(join(dir, "stages/fixture.json"), (v) => {
        v.sampler.ready = false;
      }),
    "no final sample": (dir) =>
      editJson(join(dir, "stages/fixture.json"), (v) => {
        v.sampler.final_sample = false;
      }),
    malformed: (dir) =>
      writeFileSync(
        join(dir, "isolation/fixture.jsonl"),
        `${readFileSync(join(dir, "isolation/fixture.jsonl"), "utf8")}{"at":\n`,
      ),
    backwards: (dir) => {
      const rows = readLines(join(dir, "isolation/fixture.jsonl"));
      [rows[10], rows[11]] = [rows[11], rows[10]];
      writeLines(join(dir, "isolation/fixture.jsonl"), rows);
    },
    gap: (dir) =>
      writeLines(
        join(dir, "isolation/fixture.jsonl"),
        readLines(join(dir, "isolation/fixture.jsonl")).filter(
          (_, i) => i < 5 || i > 12,
        ),
      ),
  };
  const basis = {
    "not ready": /sampler that was ready/,
    "no final sample": /final sample/,
    malformed: /malformed/,
    backwards: /went backwards/,
    gap: /a gap of/,
  };
  for (const [name, breakIt] of Object.entries(breakers)) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    breakIt(dir);
    const r = resolveDir(dir);
    const c = cell(r, "P-2 dense-100 wall_ms[chromium]");
    assert.equal(c.status, "not_isolated", name);
    assert.equal(c.isolation.verdict, "unknown", name);
    assert.match(c.isolation.basis, basis[name], name);
    assert.equal(r.complete, false, name);
    assert.equal(
      cell(r, "P-4 draft claim_ms[firefox]").status,
      "ok",
      `${name}: another stage is not affected`,
    );
  }
});

test("case: another stage's samples never stand in for a stage that has none, and a window outside its stage's action is invalid", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  rmSync(join(dir, "isolation/shell.jsonl"));
  const r = resolveDir(dir);
  const c = cell(r, "P-1S:dist-fixture:mobile:slow-4g:run-1[chromium]");
  assert.equal(c.status, "not_isolated");
  assert.match(
    c.isolation.basis,
    /no load samples were recorded for this stage/,
  );
  const moved = join(scratch(t), "p");
  writeComplete(moved);
  editJson(join(moved, "stages/integration.json"), (v) => {
    v.action_started_at = v.action_finished_at;
  });
  const m = resolveDir(moved);
  assert.equal(
    cell(m, "P-10 sync page duration_ms (proxy delay 250 ms)[webkit]").status,
    "invalid",
  );
  assert.match(
    cell(
      m,
      "P-10 sync page duration_ms (proxy delay 250 ms)[webkit]",
    ).reasons.join(" "),
    /outside its stage's action/,
  );
});

test("case: the real sampler is ready only after a valid first sample and writes a final one when stopped; one that cannot get ready fails its stage before the action", async (t) => {
  const dir = scratch(t);
  const sampler = await isolation.startLoadSampler(dir, "probe", {
    intervalMs: 200,
  });
  assert.equal(sampler.ready, true);
  const first = isolation.readSamples(join(dir, "isolation/probe.jsonl"))[0];
  assert.equal(first.at, sampler.ready_at);
  const stopped = await sampler.stop();
  assert.equal(stopped.exit_code, 0);
  assert.equal(stopped.final_sample, true);
  assert.equal(
    isolation.readSamples(join(dir, "isolation/probe.jsonl")).at(-1).final,
    true,
  );
  let ran = false;
  let status;
  // The stage itself never throws: a failure is sealed into its record (an escaping throw fails this assertion).
  await assert.doesNotReject(async () => {
    status = await evidence.runStage(
      dir,
      "never-ready",
      async () => {
        ran = true;
        return 0;
      },
      {
        sample: (d, s) =>
          isolation.startLoadSampler(d, s, { readyWithinMs: 0 }),
        invocation: "inv",
        extra: { root },
      },
    );
  });
  assert.equal(status, 1);
  assert.equal(ran, false, "the action never ran");
  const record = JSON.parse(
    readFileSync(join(dir, "stages/never-ready.json"), "utf8"),
  );
  assert.equal(record.sealed, true);
  assert.match(record.failure, /wrote no valid first sample/);
  assert.equal(record.action_started_at, null);
});

test("case: an action that throws is sealed as a failure with its interval inside the sampler's samples", async (t) => {
  const dir = scratch(t);
  let status;
  // The stage itself never throws: a failure is sealed into its record (an escaping throw fails this assertion).
  await assert.doesNotReject(async () => {
    status = await evidence.runStage(
      dir,
      "throws",
      async () => {
        throw new Error("synthetic stage failure");
      },
      {
        sample: (d, s) => isolation.startLoadSampler(d, s, { intervalMs: 200 }),
        invocation: "inv",
        extra: { root },
      },
    );
  });
  assert.equal(status, 1);
  const record = JSON.parse(
    readFileSync(join(dir, "stages/throws.json"), "utf8"),
  );
  assert.equal(record.exit_status, 1);
  assert.equal(record.sealed, true);
  assert.match(record.failure, /synthetic stage failure/);
  assert.equal(record.sampler.ready, true);
  assert.equal(record.sampler.final_sample, true);
  const samples = isolation.readSamples(join(dir, "isolation/throws.jsonl"));
  assert.ok(Date.parse(samples[0].at) <= Date.parse(record.action_started_at));
  assert.ok(
    Date.parse(samples.at(-1).at) >= Date.parse(record.action_finished_at),
  );
});

// ---- Q4: one required observation removed, per writer class: the exact cell is named and no conclusion follows ----
test("case: removing one observation of each writer class names exactly that cell, and no desktop conclusion is drawn", (t) => {
  const removals = [
    [
      "a P-2 scan series",
      (dir) =>
        writeLines(
          join(dir, "measurements.jsonl"),
          readLines(join(dir, "measurements.jsonl")).filter(
            (r) =>
              !(r.name === "P-2 dense-200 scan_ms" && r.engine === "chromium"),
          ),
        ),
      "P-2 dense-200 scan_ms[chromium]",
    ],
    [
      "the P-Q2 quota inputs",
      (dir) =>
        writeLines(
          join(dir, "values.jsonl"),
          readLines(join(dir, "values.jsonl")).filter(
            (r) =>
              !(
                r.name === "P-Q2 quota reserve inputs" && r.engine === "firefox"
              ),
          ),
        ),
      "P-Q2 quota reserve inputs[firefox]",
    ],
    [
      "the production lock-wait file",
      (dir) =>
        rmSync(
          join(dir, "contention/frozen-owner-production-wait.webkit.json"),
        ),
      "P-7 production lock wait[webkit]",
    ],
    [
      "a P-13 read distribution",
      (dir) =>
        writeLines(
          join(dir, "measurements.jsonl"),
          readLines(join(dir, "measurements.jsonl")).filter(
            (r) =>
              !(
                r.name === "P-13 leader pages: follower read_ms per hint" &&
                r.engine === "firefox"
              ),
          ),
        ),
      "P-13 reads, leader pages[firefox]",
    ],
    [
      "a W2 capture",
      (dir) => rmSync(join(dir, "w2/W2-captured.chromium.limit-80.json")),
      "P-W2 capture limit 80[chromium]",
    ],
    [
      "a shell run",
      (dir) =>
        editJson(join(dir, "shell/dist-fixture.json"), (v) => {
          v.results[3].raw = v.results[3].raw.filter((r) => r.run !== 2);
        }),
      "P-1S:dist-fixture:desktop:slow-4g:run-2[chromium]",
    ],
    [
      "a device-page run",
      (dir) => {
        const file = join(dir, "device-page/results.webkit.json");
        const v = JSON.parse(readFileSync(file, "utf8"));
        v.runs = v.runs.filter((r) => !(r.workload === "W4" && r.run === 5));
        const text = `${JSON.stringify(v, null, 2)}\n`;
        writeFileSync(file, text);
        writeLines(
          join(dir, "values.jsonl"),
          readLines(join(dir, "values.jsonl")).map((r) =>
            r.name === "P-11 device page" && r.engine === "webkit"
              ? { ...r, results_sha256: sha(text) }
              : r,
          ),
        );
      },
      "device W4 run 5[webkit]",
    ],
    [
      "the budget profile of dist",
      (dir) => rmSync(join(dir, "bundle/bundle-profile-dist.json")),
      "P-1:budget:dist",
    ],
  ];
  for (const [what, remove, id] of removals) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    remove(dir);
    const r = resolveDir(dir);
    const bad = r.cells.filter(
      (c) => !["ok", "unavailable"].includes(c.status),
    );
    assert.deepEqual(
      bad.map((c) => c.id),
      [id],
      what,
    );
    assert.equal(r.complete, false, what);
    assert.equal(r.derived.desktop_needs_finer_pagination, null, what);
  }
});

test("case: the review's missing-series schedule (every measurement row removed but one) assembles incomplete; H8 and H9 undetermined; refused", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  writeLines(
    join(dir, "measurements.jsonl"),
    readLines(join(dir, "measurements.jsonl")).slice(0, 1),
  );
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.equal(results.desktop_programme.complete, false);
  assert.equal(results.desktop_programme.outcomes_complete, false);
  assert.equal(results.H8.desktop_valid_workload_failure, null);
  assert.equal(results.H9.desktop_needs_finer_pagination, null);
  for (const item of ["P-3", "P-4", "P-10"])
    assert.equal(results.programme[item].status, "not_run", item);
  // P-2 keeps its declared capabilities and raw trace: partial, never measured.
  assert.equal(results.programme["P-2"].status, "partial");
  assert.deepEqual(results.H9.desktop_D_largest_dense_changes_committed, {
    chromium: null,
    firefox: null,
    webkit: null,
  });
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 1, `${checked.stdout}${checked.stderr}`);
  assert.match(
    checked.stdout,
    /PARTIAL hand-over: the desktop programme is incomplete/,
  );
});

test("case: the dense bound D(engine) is the largest dense page whose commit series and every smaller one's resolved", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  writeLines(
    join(dir, "measurements.jsonl"),
    readLines(join(dir, "measurements.jsonl")).filter(
      (r) => !(r.name === "P-2 dense-400 commit_ms" && r.engine === "firefox"),
    ),
  );
  assert.deepEqual(
    resolveDir(dir).derived.desktop_D_largest_dense_changes_committed,
    { chromium: 800, firefox: 200, webkit: 800 },
  );
});

// ---- Q5: cardinality, schema and raw support ----
test("case: a short, duplicated, non-finite, altered, unlinked or another series' distribution is invalid for its own reason", (t) => {
  const name = "P-3 draft strict write_ms";
  const rowOf = (dir) =>
    readLines(join(dir, "measurements.jsonl")).find(
      (r) => r.name === name && r.engine === "chromium",
    );
  const rawOf = (dir) => join(dir, rowOf(dir).raw);
  const rewriteRaw = (dir, change) => {
    const file = rawOf(dir);
    const v = JSON.parse(readFileSync(file, "utf8"));
    change(v);
    writeFileSync(file, `${JSON.stringify(v)}\n`);
  };
  const resumRow = (dir, change) =>
    writeLines(
      join(dir, "measurements.jsonl"),
      readLines(join(dir, "measurements.jsonl")).map((r) =>
        r.name === name && r.engine === "chromium" ? change(r) : r,
      ),
    );
  const cases = [
    [
      "short",
      (dir) => {
        rewriteRaw(dir, (v) => v.samples.pop());
        const raw = readFileSync(rawOf(dir), "utf8");
        resumRow(dir, (r) => ({ ...r, n: 299, raw_sha256: sha(raw) }));
      },
      /n 299; the programme takes 300/,
    ],
    [
      "duplicate",
      (dir) =>
        writeLines(join(dir, "measurements.jsonl"), [
          ...readLines(join(dir, "measurements.jsonl")),
          rowOf(dir),
        ]),
      /2 rows: a series is recorded once/,
    ],
    [
      "non-finite",
      (dir) => {
        rewriteRaw(dir, (v) => {
          v.samples[3] = null;
        });
        const raw = readFileSync(rawOf(dir), "utf8");
        resumRow(dir, (r) => ({ ...r, raw_sha256: sha(raw) }));
      },
      /a raw sample is not a finite number/,
    ],
    [
      "altered percentile",
      (dir) => resumRow(dir, (r) => ({ ...r, p95: r.p95 + 1 })),
      /p95 .* does not follow from the raw samples/,
    ],
    [
      "raw changed after the summary",
      (dir) => rewriteRaw(dir, (v) => v.samples.reverse()),
      /SHA-256 is not the one the summary recorded/,
    ],
    [
      "no raw link",
      (dir) => resumRow(dir, (r) => ({ ...r, raw: undefined })),
      /no raw samples are linked/,
    ],
    [
      "another stage's row",
      (dir) => resumRow(dir, (r) => ({ ...r, stage: "integration" })),
      /written by stage integration, not fixture/,
    ],
    [
      "another invocation's row",
      (dir) => resumRow(dir, (r) => ({ ...r, invocation: "someone-else" })),
      /written by invocation someone-else/,
    ],
    [
      "another case's window",
      (dir) =>
        resumRow(dir, (r) => ({
          ...r,
          collection: { ...r.collection, test: "P-5: synthetic" },
        })),
      /not by the case "P-3:"/,
    ],
  ];
  for (const [what, breakIt, reason] of cases) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    breakIt(dir);
    const c = cell(resolveDir(dir), `${name}[chromium]`);
    assert.equal(c.status, "invalid", what);
    assert.match(c.reasons.join(" | "), reason, what);
  }
});

test("case: cross-checked series (P-10 against P-4's samples, per-draft against drain/200) and a corrupt row file are invalid, never positive empties", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  writeLines(
    join(dir, "measurements.jsonl"),
    readLines(join(dir, "measurements.jsonl")).filter(
      (r) => !(r.name === "P-4 sync page request_ms" && r.engine === "webkit"),
    ),
  );
  const derivedDir = join(scratch(t), "p");
  writeComplete(derivedDir);
  const row = readLines(join(derivedDir, "measurements.jsonl")).find(
    (r) => r.name === "P-5 drain_200_ms" && r.engine === "firefox",
  );
  const raw = JSON.parse(readFileSync(join(derivedDir, row.raw), "utf8"));
  raw.samples[0] += 1000;
  const text = `${JSON.stringify(raw)}\n`;
  writeFileSync(join(derivedDir, row.raw), text);
  writeLines(
    join(derivedDir, "measurements.jsonl"),
    readLines(join(derivedDir, "measurements.jsonl")).map((r) =>
      r.name === "P-5 drain_200_ms" && r.engine === "firefox"
        ? { ...r, raw_sha256: sha(text), ...contract.summarise(raw.samples) }
        : r,
    ),
  );
  const crossed = resolveDir(dir);
  assert.match(
    cell(
      crossed,
      "P-10 sync page request_ms (unthrottled loopback)[webkit]",
    ).reasons.join(" "),
    /not the ones of "P-4 sync page request_ms"/,
  );
  assert.match(
    cell(resolveDir(derivedDir), "P-5 per_draft_ms[firefox]").reasons.join(" "),
    /not "P-5 drain_200_ms" \/ 200/,
  );
  const corrupt = join(scratch(t), "p");
  writeComplete(corrupt);
  writeFileSync(
    join(corrupt, "measurements.jsonl"),
    `${readFileSync(join(corrupt, "measurements.jsonl"), "utf8")}{not json\n`,
  );
  const c = resolveDir(corrupt);
  assert.equal(c.complete, false);
  assert.equal(cell(c, "P-2 ordinary-100 wall_ms[webkit]").status, "invalid");
  assert.match(
    cell(c, "P-2 ordinary-100 wall_ms[webkit]").reasons[0],
    /measurements\.jsonl is malformed/,
  );
});

test("case: browser memory without complete attribution (descendant-only WebKit, a failed sample, no sample) is invalid memory evidence", (t) => {
  const variants = [
    [
      "descendant-only WebKit",
      (rss) => ({ ...rss, webkit_hosts: 0 }),
      "webkit",
      /renderer is not counted/,
    ],
    [
      "a failed sample",
      (rss) => ({ ...rss, failed_samples: 1, complete: false }),
      "chromium",
      /1 memory sample\(s\) failed/,
    ],
    [
      "no sample",
      (rss) => ({ ...rss, samples: 0, peak_kib: null }),
      "firefox",
      /no memory sample was taken/,
    ],
    [
      "no attribution record",
      () => undefined,
      "webkit",
      /descendant-only figures are not browser memory/,
    ],
  ];
  for (const [what, change, engine, reason] of variants) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    editJson(join(dir, `memory/P-11.${engine}.json`), (v) => {
      v.rows[0].runs[2].rss = change(v.rows[0].runs[2].rss);
    });
    const c = cell(resolveDir(dir), `P-11 W1 memory, cold run 3[${engine}]`);
    assert.equal(c.status, "invalid", what);
    assert.match(c.reasons.join(" "), reason, what);
  }
});

// ---- Q6: the W7 truth table, cold and device paths ----
test("case: a W7 control fulfils its control only when REFUSED: admitted, timed out, failed or killed controls stay recorded and fail it", (t) => {
  for (const outcome of ["admitted", "timeout", "error", "killed"]) {
    const dir = join(scratch(t), "p");
    writeComplete(dir, { controlOutcome: outcome });
    const r = resolveDir(dir);
    assert.equal(r.counts.failed_control, 6 * 3 * 2, outcome);
    const cold = cell(r, "P-11 W7-truncated control[webkit]");
    assert.equal(cold.status, "failed_control", outcome);
    assert.equal(cold.outcome, outcome);
    assert.equal(
      cell(r, "device W7-bad_kind run 1[chromium]").status,
      "failed_control",
      outcome,
    );
    assert.equal(r.complete, false, outcome);
    assert.equal(r.outcomes_complete, false, outcome);
    assert.equal(r.derived.desktop_valid_workload_failure, null, outcome);
  }
});

test("case: the review's W7-timeout schedule assembles with every control unfulfilled and is refused", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir, { controlOutcome: "timeout" });
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.equal(results.desktop_programme.failed_controls.length, 36);
  assert.equal(results.H8.negative_controls_not_fulfilled.length, 36);
  assert.equal(results.desktop_programme.complete, false);
  const checked = validate(join(dir, "handoff"), "--allow-partial");
  assert.equal(checked.status, 2, `${checked.stdout}${checked.stderr}`);
  assert.equal(validate(join(dir, "handoff")).status, 1);
});

// ---- Q7: valid-workload failures and partial packages ----
test("case: W2's LIVE outcome is a desktop outcome: a live time-out is a failure (H8 true) that does not by itself settle H9", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editJson(join(dir, "w2/P-W2.webkit.json"), (v) => {
    v.live.outcome = "timeout";
  });
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.equal(results.H8.desktop_valid_workload_failure, true);
  assert.deepEqual(results.H8.desktop_answer.failures, [
    {
      engine: "webkit",
      workload: "W2",
      path: "live application by the production engine",
      run: 0,
      outcome: "timeout",
    },
  ]);
  assert.equal(results.H9.desktop_needs_finer_pagination, null);
  assert.match(
    results.H9.needs_finer_pagination,
    /does not by itself establish/,
  );
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
});

test("case: a failed stage, and an empty programme, leave the programme incomplete and every conclusion undetermined; partial exits 1, 2 when allowed", (t) => {
  const failed = join(scratch(t), "p");
  writeComplete(failed);
  editJson(join(failed, "stages/integration.json"), (v) => {
    v.exit_status = 1;
  });
  const r = resolveDir(failed);
  assert.deepEqual(r.failed, ["stage:integration"]);
  assert.equal(r.derived.desktop_valid_workload_failure, null);
  const empty = join(scratch(t), "p");
  assert.equal(assemble(empty).status, 0);
  const results = resultsOf(empty);
  assert.deepEqual(
    Object.keys(results.consumer_map).sort(),
    [...evidence.CONSUMER_KEYS].sort(),
  );
  for (const key of evidence.DEVICE_KEYS)
    assert.equal(results.consumer_map[key].status, "escalated");
  assert.equal(results.desktop_programme.missing.length, 796);
  assert.equal(results.H8.desktop_valid_workload_failure, null);
  assert.match(results.H8.desktop_answer, /UNDETERMINED/);
  assert.equal(validate(join(empty, "handoff")).status, 1);
  assert.equal(validate(join(empty, "handoff"), "--allow-partial").status, 2);
});

test("case: a device-page result its checker refuses (a W2 run of other bytes) makes that engine's device cells invalid", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const file = join(dir, "device-page/results.firefox.json");
  const v = JSON.parse(readFileSync(file, "utf8"));
  v.runs.find((r) => r.workload === "W2").sha256 = "f".repeat(64);
  const text = `${JSON.stringify(v, null, 2)}\n`;
  writeFileSync(file, text);
  writeLines(
    join(dir, "values.jsonl"),
    readLines(join(dir, "values.jsonl")).map((r) =>
      r.name === "P-11 device page" && r.engine === "firefox"
        ? { ...r, results_sha256: sha(text) }
        : r,
    ),
  );
  const r = resolveDir(dir);
  const fileCell = cell(r, "device page results[firefox]");
  assert.equal(fileCell.status, "invalid");
  assert.match(fileCell.reasons.join(" "), /not the protocol's capture/);
  assert.equal(cell(r, "device W1 run 1[firefox]").status, "invalid");
  assert.equal(cell(r, "device W1 run 1[chromium]").status, "ok");
});

// ---- Q8: a hand-over that says more than its evidence, with matching checksums ----
test("case: forged statements are refused even with matching SHA256SUMS (complete, H8, H9, D, an item, isolation, device map, a cell, a dropped raw file)", (t) => {
  const forgeries = [
    [
      "complete",
      (r) => {
        r.desktop_programme.complete = false;
      },
      /complete is false, but the evidence resolves to true/,
    ],
    [
      "H8",
      (r) => {
        r.H8.desktop_valid_workload_failure = null;
      },
      /H8: desktop_valid_workload_failure is null/,
    ],
    [
      "H9",
      (r) => {
        r.H9.desktop_needs_finer_pagination = true;
      },
      /H9: desktop_needs_finer_pagination is true/,
    ],
    [
      "D",
      (r) => {
        r.H9.desktop_D_largest_dense_changes_committed.webkit = 400;
      },
      /dense bound D is not what the evidence gives/,
    ],
    [
      "an item",
      (r) => {
        r.programme["P-6"].status = "partial";
      },
      /programme: P-6 is partial, but its evidence resolves to measured/,
    ],
    [
      "isolation",
      (r) => {
        r.isolation.summary.clean -= 1;
      },
      /isolation: the summary does not count the resolved verdicts/,
    ],
    [
      "device map",
      (r) => {
        r.device_page_validation["results.webkit.json"].status = "invalid";
      },
      /device_page_validation: results\.webkit\.json is invalid/,
    ],
    [
      "a list",
      (r) => {
        r.desktop_programme.missing = [{ id: "stage:device" }];
      },
      /its missing list is not what the evidence resolves to/,
    ],
  ];
  for (const [what, forge, reason] of forgeries) {
    const dir = assembledCopy(t);
    editJson(join(dir, "handoff/results.json"), forge);
    resum(join(dir, "handoff"));
    const checked = validate(join(dir, "handoff"));
    assert.equal(checked.status, 1, `${what}: ${checked.stdout}`);
    assert.match(checked.stderr, reason, what);
  }
  const cellForged = assembledCopy(t);
  editJson(join(cellForged, "handoff/resolution.json"), (v) => {
    v.cells[100].status = "missing";
  });
  resum(join(cellForged, "handoff"));
  assert.match(
    validate(join(cellForged, "handoff")).stderr,
    /resolution\.json: 1 cell\(s\) differ/,
  );
  const dropped = assembledCopy(t);
  const rawFile = readdirSync(join(dropped, "handoff/evidence/raw")).find((f) =>
    f.startsWith("P-9_"),
  );
  rmSync(join(dropped, "handoff/evidence/raw", rawFile));
  resum(join(dropped, "handoff"));
  const checked = validate(join(dropped, "handoff"));
  assert.equal(checked.status, 1);
  assert.match(
    checked.stderr,
    /complete is true, but the evidence resolves to false/,
  );
  const none = assembledCopy(t);
  rmSync(join(none, "handoff/evidence"), { recursive: true });
  resum(join(none, "handoff"));
  assert.match(validate(join(none, "handoff")).stderr, /evidence\/ is missing/);
});

test("case: a hand-over missing a BE-B1/BE-Q23 item, claiming a device class from a desktop engine, or measuring a real-device row is refused", (t) => {
  for (const key of [
    "BE-B1:6 derived values",
    "BE-Q23:M7 cost of finer requests",
  ]) {
    const dir = assembledCopy(t);
    editJson(join(dir, "handoff/results.json"), (r) => {
      delete r.consumer_map[key];
    });
    resum(join(dir, "handoff"));
    const run = validate(join(dir, "handoff"));
    assert.equal(run.status, 1, run.stdout);
    assert.match(
      run.stderr,
      new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is missing`),
    );
  }
  const claims = assembledCopy(t);
  editJson(join(claims, "handoff/results.json"), (r) => {
    Object.assign(r.consumer_map["BE-Q23:M4 granularity sweep"], {
      status: "measured",
      claims_device_class: true,
    });
  });
  resum(join(claims, "handoff"));
  assert.match(
    validate(join(claims, "handoff")).stderr,
    /measured on a desktop engine but claims a device class/,
  );
  const roster = assembledCopy(t);
  editJson(join(roster, "handoff/results.json"), (r) => {
    r.consumer_map["BE-Q23:M1 roster"].status = "measured";
  });
  resum(join(roster, "handoff"));
  assert.match(
    validate(join(roster, "handoff")).stderr,
    /asks for real devices/,
  );
});

test("case: a file SHA256SUMS does not cover, or one that no longer verifies, is refused", (t) => {
  const gap = assembledCopy(t);
  writeFileSync(join(gap, "handoff/extra.json"), "{}\n");
  const uncovered = validate(join(gap, "handoff"));
  assert.equal(uncovered.status, 1, uncovered.stdout);
  assert.match(uncovered.stderr, /does not cover extra\.json/);
  const tampered = assembledCopy(t);
  writeFileSync(join(tampered, "handoff/report.md"), "# changed\n");
  const changed = validate(join(tampered, "handoff"));
  assert.equal(changed.status, 1, changed.stdout);
  assert.match(changed.stderr, /report\.md does not verify/);
});

// ---- Q9: one writer per evidence directory ----
test("case: two invocations claiming one directory at the same moment: exactly one holds it, the other is refused without touching it", (t) => {
  const dir = scratch(t);
  const go = join(dir, "go");
  const target = join(dir, "evidence");
  const claimant = (name) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { existsSync } from "node:fs";
           const { claimDirectory } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/lib/profile-evidence.mjs")).href)});
           while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
           const claim = claimDirectory(${JSON.stringify(target)}, { stages: ["${name}"], delegated: undefined });
           console.log("held", claim.invocation);
           await new Promise((r) => setTimeout(r, 300));`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      child.on("exit", (code) => resolve({ code, out }));
    });
  const both = Promise.all([claimant("a"), claimant("b")]);
  setTimeout(() => writeFileSync(go, ""), 300);
  return both.then((runs) => {
    const codes = runs.map((r) => r.code).sort();
    assert.deepEqual(codes, [0, 2], runs.map((r) => r.out).join("\n"));
    const loser = runs.find((r) => r.code === 2);
    assert.match(loser.out, /refused: .* is held by another invocation/);
    assert.deepEqual(Object.keys(inventory(target)), ["writer.lock"]);
  });
});

test("case: a held directory is refused by both drivers and by the assembler (exit 2), and every file is left as it was", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  writeFileSync(join(dir, "writer.lock"), '{"invocation":"other"}\n');
  const before = inventory(dir);
  const sync = node([
    join(root, "scripts/profile-sync.mjs"),
    "--evidence",
    dir,
    "--only",
    "handoff",
  ]);
  assert.equal(sync.status, 2, `${sync.stdout}${sync.stderr}`);
  assert.match(sync.stderr, /is held by another invocation/);
  assert.deepEqual(inventory(dir), before);
  const fresh = join(scratch(t), "fresh");
  mkdirSync(fresh);
  writeFileSync(join(fresh, "writer.lock"), '{"invocation":"other"}\n');
  const freshBefore = inventory(fresh);
  const direct = node([
    join(root, "scripts/profile-contention.mjs"),
    "--evidence",
    fresh,
    "--preflight",
  ]);
  assert.equal(direct.status, 2, `${direct.stdout}${direct.stderr}`);
  assert.match(direct.stderr, /is held by another invocation/);
  const delegated = node(
    [
      join(root, "scripts/profile-contention.mjs"),
      "--evidence",
      fresh,
      "--skip-build",
    ],
    { env: { ATLAS_PROFILE_CLAIM: "not-the-holder" } },
  );
  assert.equal(delegated.status, 2, `${delegated.stdout}${delegated.stderr}`);
  assert.match(delegated.stderr, /is not held by the delegating invocation/);
  assert.deepEqual(inventory(fresh), freshBefore);
});

test("case: a finished invocation releases its claim into writers/, and its stages are sealed with their invocation", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  assert.equal(assemble(dir).status, 0);
  assert.equal(existsSync(join(dir, "writer.lock")), false);
  const [record] = readdirSync(join(dir, "writers"));
  const writer = JSON.parse(readFileSync(join(dir, "writers", record), "utf8"));
  assert.equal(writer.exit_status, 0);
  const stage = JSON.parse(
    readFileSync(join(dir, "stages/handoff.json"), "utf8"),
  );
  assert.equal(stage.invocation, writer.invocation);
  assert.equal(stage.sealed, true);
});

// ---- Q13: browser memory attribution (pure process fixtures) ----
const browserProcesses = await import(
  pathToFileURL(join(root, "scripts/lib/browser-processes.mjs")).href
);
const PW = "/Users/x/Library/Caches/ms-playwright/webkit-2359";
const XPC = (kind) =>
  `${PW}/com.apple.WebKit.${kind}.xpc/Contents/MacOS/com.apple.WebKit.${kind}.Development`;
const START = "Sat Oct 10 12:54:01 2026";
const LATER = "Sat Oct 10 12:54:03 2026";
const EARLIER = "Sat Oct 10 12:00:00 2026";
const proc = (pid, ppid, rss_kib, start, command) => ({
  pid,
  ppid,
  rss_kib,
  start,
  command,
});
const worldRows = () => [
  proc(1, 0, 10, EARLIER, "/sbin/launchd"),
  proc(100, 1, 50_000, EARLIER, "node worker"),
  proc(
    101,
    100,
    100_000,
    START,
    `${PW}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless`,
  ),
  proc(102, 100, 2_000, LATER, "ps -axo pid=,ppid=,rss=,lstart=,command="),
  proc(201, 1, 150_000, LATER, XPC("WebContent")),
  proc(202, 1, 55_000, LATER, XPC("Networking")),
  proc(203, 1, 56_000, LATER, XPC("GPU")),
  // another session's WebKit on the same path, and Safari's system WebKit: never in this host's domain
  proc(
    300,
    1,
    90_000,
    START,
    `${PW}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless`,
  ),
  proc(301, 1, 140_000, LATER, XPC("WebContent")),
  proc(
    400,
    1,
    120_000,
    EARLIER,
    "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
  ),
];
const domain = {
  101: {
    ok: true,
    services: [
      { pid: 201, label: "com.apple.WebKit.WebContent.A" },
      { pid: 202, label: "com.apple.WebKit.Networking.B" },
      { pid: 203, label: "com.apple.WebKit.GPU.C" },
    ],
  },
  300: {
    ok: true,
    services: [{ pid: 301, label: "com.apple.WebKit.WebContent.D" }],
  },
};

test("control: this browser's WebKit renderer and helpers are counted through its host's launchd domain; another session's and Safari's are not", () => {
  const inv = browserProcesses.browserInventory(worldRows(), 100, {
    servicesOf: (pid) => domain[pid] ?? { ok: false, error: "unexpected host" },
  });
  assert.deepEqual(
    inv.processes.map((p) => p.pid).sort(),
    [101, 201, 202, 203],
  );
  assert.equal(inv.rss_kib, 100_000 + 150_000 + 55_000 + 56_000);
  assert.equal(inv.complete, true);
  assert.equal(inv.webkit_hosts, 1);
  assert.equal(inv.scope, browserProcesses.SCOPE_WITH_LAUNCHD);
});

test("case: an unreadable launchd domain, a reused pid or a service older than its host makes the inventory incomplete and is never counted; a vanished helper is skipped", () => {
  const unreadable = browserProcesses.browserInventory(worldRows(), 100, {
    servicesOf: () => ({ ok: false, error: "permission denied" }),
  });
  assert.equal(unreadable.complete, false);
  assert.match(unreadable.errors[0], /permission denied/);
  assert.deepEqual(
    unreadable.processes.map((p) => p.pid),
    [101],
  );
  const reused = worldRows().map((r) =>
    r.pid === 202 ? { ...r, command: "/usr/bin/some-other-program" } : r,
  );
  const older = reused.map((r) =>
    r.pid === 203 ? { ...r, start: EARLIER } : r,
  );
  const inv = browserProcesses.browserInventory(older, 100, {
    servicesOf: (pid) => domain[pid],
  });
  assert.equal(inv.complete, false);
  assert.deepEqual(inv.processes.map((p) => p.pid).sort(), [101, 201]);
  assert.equal(inv.errors.length, 2);
  const vanished = browserProcesses.browserInventory(
    worldRows().filter((r) => r.pid !== 203),
    100,
    { servicesOf: (pid) => domain[pid] },
  );
  assert.equal(vanished.complete, true);
  assert.deepEqual(
    vanished.processes.map((p) => p.pid).sort(),
    [101, 201, 202],
  );
});

test("case: Chromium and Firefox are their descendants (the sampling command excluded); launchctl's answer is parsed to the running services only", () => {
  const rows = [
    proc(100, 1, 50_000, EARLIER, "node worker"),
    proc(
      110,
      100,
      80_000,
      START,
      "/x/chrome-headless-shell --remote-debugging-pipe",
    ),
    proc(111, 110, 150_000, LATER, "/x/chrome-headless-shell --type=renderer"),
    proc(
      112,
      100,
      1_000,
      LATER,
      "/bin/ps -axo pid=,ppid=,rss=,lstart=,command=",
    ),
  ];
  const inv = browserProcesses.browserInventory(rows, 100, {
    servicesOf: () => ({ ok: false, error: "not a WebKit host" }),
  });
  assert.deepEqual(inv.processes.map((p) => p.pid).sort(), [110, 111]);
  assert.equal(inv.scope, browserProcesses.SCOPE_DESCENDANTS);
  assert.equal(inv.complete, true);
  const parsed = browserProcesses.parseLaunchdServices(
    "pid/90551 = {\n\ttype = pid\n\tservices = {\n\t\t       0      - \tcom.apple.WebKit.WebContent\n\t\t   90618      - \tcom.apple.WebKit.Networking.75C9\n\t\t   90620      - \tcom.apple.WebKit.WebContent.5882\n\t}\n\n\tservice stubs = {\n\t\tcom.apple.x\n\t}\n}\n",
  );
  assert.deepEqual(parsed, [
    { pid: 90618, label: "com.apple.WebKit.Networking.75C9" },
    { pid: 90620, label: "com.apple.WebKit.WebContent.5882" },
  ]);
  assert.equal(browserProcesses.parseLaunchdServices("no block here"), null);
});

// ---- isolation (review R1) ----------------------------------------------------------------------------------------------------------------
const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (s) => new Date(T0 + s * 1000).toISOString();
/** Load samples every 5 s from -10 s to 130 s; `busy(s)` names the foreign heavy work seen at second s. */
const loadSamples = (busy = () => [], every = 5) => {
  const out = [];
  for (let at = -10; at <= 130; at += every)
    out.push({
      at: iso(at),
      foreign_heavy: busy(at),
      foreign_heavy_cpu_percent: busy(at).reduce(
        (n, f) => n + Number(f.split(" ")[2]),
        0,
      ),
    });
  return out;
};
/** Two series collected over 0 to 60 s and exported at 100 s and 100.5 s (P-2 writes its summaries after the whole collection). */
const rows = () =>
  ["wall_ms", "scan_ms"].map((kind, i) => ({
    file: "measurements.jsonl",
    name: `P-2 shape ${kind}`,
    engine: "chromium",
    at: iso(100 + i / 2),
    collection: { test: "P-2: x", from: iso(0), to: iso(100 + i / 2) },
  }));

test("control: quiet samples over the whole collection window make every series clean", () => {
  const a = isolation.annotate({ rows: rows(), samples: loadSamples() });
  assert.deepEqual(
    a.series.map((r) => r.verdict),
    ["clean", "clean"],
  );
  assert.equal(a.summary.all_clean, true);
});

test("control: busy samples over the whole window make every series contaminated", () => {
  const a = isolation.annotate({
    rows: rows(),
    samples: loadSamples(() => [VITEST]),
  });
  assert.deepEqual(
    a.series.map((r) => r.verdict),
    ["contaminated", "contaminated"],
  );
});

test("case: work during the COLLECTION contaminates every series, however quiet the moment of export", () => {
  const a = isolation.annotate({
    rows: rows(),
    samples: loadSamples((s) => (s >= 10 && s <= 40 ? [VITEST] : [])),
  });
  assert.deepEqual(
    a.series.map((r) => r.verdict),
    ["contaminated", "contaminated"],
  );
  assert.equal(a.summary.all_clean, false);
});

test("case: an idle foreign heavy process is not clean, a row without a window and an uncovered window are unknown", () => {
  const idle = isolation.annotate({
    rows: rows(),
    samples: loadSamples(() => ["9002 1 0.0 node vitest --watch"]),
  });
  assert.deepEqual(
    idle.series.map((r) => r.verdict),
    ["idle_foreign", "idle_foreign"],
  );
  const [first] = rows();
  delete first.collection;
  const none = isolation.annotate({ rows: [first], samples: loadSamples() });
  assert.equal(none.series[0].verdict, "unknown");
  const gap = isolation.annotate({
    rows: rows(),
    samples: loadSamples().filter((x) => {
      const at = (Date.parse(x.at) - T0) / 1000;
      return at < 20 || at > 50;
    }),
  });
  assert.deepEqual(
    gap.series.map((r) => r.verdict),
    ["unknown", "unknown"],
  );
  assert.match(gap.series[0].basis, /a gap of/);
  const late = isolation.annotate({
    rows: rows(),
    samples: loadSamples().filter((x) => Date.parse(x.at) >= T0 + 30_000),
  });
  assert.equal(late.series[0].verdict, "unknown");
});

test("case: attribution: this run's tree, its ancestors and its own WebKit XPC services are not foreign; anything else heavy is", () => {
  const ps = (rows) =>
    rows.map(([pid, ppid, pcpu, command]) => ({ pid, ppid, pcpu, command }));
  const XPC =
    "/Users/x/Library/Caches/ms-playwright/webkit-2100/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent";
  const HOST =
    "/Users/x/Library/Caches/ms-playwright/webkit-2100/Playwright.app/Contents/MacOS/Playwright --inspector-pipe";
  const base = [
    [1, 0, 0, "/sbin/launchd"],
    [10, 1, 0, "/bin/zsh"],
    [11, 10, 1, "node scripts/run-validation.mjs plan.json"],
    [12, 11, 1, "node scripts/profile-sync.mjs --evidence x"],
    [13, 12, 50, "node node_modules/@playwright/test/cli.js test"],
    [14, 13, 30, HOST],
    [15, 1, 40, XPC],
    [16, 11, 70, "node node_modules/.bin/vitest run"],
    [17, 1, 0, "/opt/claude --add-dir /Users/x/Library/Caches/ms-playwright"],
  ];
  const own = isolation.attribute(ps(base), 12);
  assert.deepEqual(
    own.foreign.map((r) => r.pid),
    [16],
    "only the validation driver's OTHER child is foreign",
  );
  assert.equal(own.webkit_xpc, "own");
  const otherHost = isolation.attribute(ps([...base, [20, 1, 5, HOST]]), 12);
  assert.deepEqual(
    otherHost.foreign.map((r) => r.pid).sort(),
    [15, 16, 20],
    "with another run's WebKit host the XPC services cannot be told apart",
  );
  assert.equal(otherHost.webkit_xpc, "foreign");
  const editor = isolation.attribute(
    ps([
      ...base,
      [
        30,
        1,
        0,
        "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /x/extensions/ms-azuretools.vscode-containers/dist/dockerfile-language-server",
      ],
      [31, 1, 3, "/opt/homebrew/bin/limactl hostagent colima"],
      [32, 1, 2, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"],
      [
        33,
        1,
        1,
        "/Users/x/.local/bin/agy --project p -i run the playwright and cargo tests",
      ],
    ]),
    12,
  );
  assert.deepEqual(
    editor.foreign.map((r) => r.pid).sort(),
    [16, 31, 32],
    "a VM or container runtime is heavy by its executable; an editor's Dockerfile language server is not",
  );
  const noHost = isolation.attribute(
    ps(base.filter(([pid]) => pid !== 14)),
    12,
  );
  assert.deepEqual(noHost.foreign.map((r) => r.pid).sort(), [15, 16]);
});

// ---- the budget checker ------------------------------------------------------------------------------------------------------------------
/** A synthetic build: one module script, one stylesheet, one font. */
function build(dir, name, { js = 4000, css = 800, font = 2000 } = {}) {
  const at = join(dir, name);
  const text = (n, seed) => {
    let out = "";
    let x = seed;
    while (out.length < n) {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      out += x.toString(36);
    }
    return out.slice(0, n);
  };
  populate(at, {
    "index.html":
      '<script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/style.css">',
    "assets/entry.js": text(js, 1),
    "assets/style.css": text(css, 2),
    "assets/font.woff2": text(font, 3),
  });
  return {
    initial_js_gzip: gzipSync(readFileSync(join(at, "assets/entry.js")), {
      level: 9,
    }).length,
    css_gzip: gzipSync(readFileSync(join(at, "assets/style.css")), { level: 9 })
      .length,
    fonts: readFileSync(join(at, "assets/font.woff2")).length,
  };
}
const budgets = (dir, perf) => {
  writeFileSync(
    join(dir, "perf-budget.json"),
    `${JSON.stringify(perf, null, 2)}\n`,
  );
  return (name) =>
    node([join(root, "scripts/check-budgets.mjs"), name], { cwd: dir });
};

test("control: a build exactly at the budget passes, for both builds", (t) => {
  const dir = scratch(t);
  const fixture = build(dir, "dist-fixture");
  const production = build(dir, "dist", { js: 3000 });
  const check = budgets(dir, {
    budget: fixture,
    tolerance: 0.1,
    baseline: { dist: production, "dist-fixture": fixture },
  });
  for (const name of ["dist", "dist-fixture"]) {
    const run = check(name);
    assert.equal(run.status, 0, `${name}: ${run.stdout}${run.stderr}`);
  }
});

test("case: one byte above the budget fails, naming the budget, for either build", (t) => {
  for (const name of ["dist", "dist-fixture"]) {
    const dir = scratch(t);
    const measured = build(dir, name);
    const check = budgets(dir, {
      budget: { ...measured, initial_js_gzip: measured.initial_js_gzip - 1 },
      tolerance: 0.1,
      baseline: { [name]: measured },
    });
    const run = check(name);
    assert.equal(run.status, 1, `${name}: ${run.stdout}`);
    assert.match(run.stderr, /initial_js_gzip \d+ exceeds the budget \d+/);
  }
});

test("case: a budget file that still holds the provisional figures is refused", (t) => {
  for (const retired of ["provisional", "provisional_by_build"]) {
    const dir = scratch(t);
    const fixture = build(dir, "dist-fixture");
    const check = budgets(dir, {
      budget: fixture,
      [retired]:
        retired === "provisional" ? fixture : { "dist-fixture": fixture },
      tolerance: 0.1,
      baseline: { "dist-fixture": fixture },
    });
    const run = check("dist-fixture");
    assert.equal(run.status, 1, run.stdout);
    assert.match(
      run.stderr,
      new RegExp(`REFUSED: perf-budget\\.json still has \`${retired}\``),
    );
  }
});

test("case: the production build above its own baseline plus the tolerance fails even under the budget", (t) => {
  const dir = scratch(t);
  const production = build(dir, "dist", { js: 3000 });
  const check = budgets(dir, {
    budget: { initial_js_gzip: 10 ** 9, css_gzip: 10 ** 9, fonts: 10 ** 9 },
    tolerance: 0.1,
    baseline: {
      dist: {
        ...production,
        initial_js_gzip: Math.floor(production.initial_js_gzip / 1.2),
      },
    },
  });
  const run = check("dist");
  assert.equal(run.status, 1, run.stdout);
  assert.match(
    run.stderr,
    /initial_js_gzip \d+ is more than 10% above the baseline/,
  );
});

test("case: the budget checker writes a programme's profile only where it is told, and never over an existing one", (t) => {
  const dir = scratch(t);
  const fixture = build(dir, "dist-fixture");
  const check = (args) =>
    node([join(root, "scripts/check-budgets.mjs"), ...args], { cwd: dir });
  writeFileSync(
    join(dir, "perf-budget.json"),
    `${JSON.stringify({ budget: fixture, tolerance: 0.1, baseline: { "dist-fixture": fixture } }, null, 2)}\n`,
  );
  const target = join(dir, "run", "bundle-profile-dist-fixture.json");
  const first = check(["dist-fixture", "--out", target]);
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.equal(
    JSON.parse(readFileSync(target, "utf8")).measured.initial_js_gzip,
    fixture.initial_js_gzip,
  );
  assert.equal(
    existsSync(join(dir, ".agtx")),
    false,
    "nothing at the fixed WEB-07 path",
  );
  const before = readFileSync(target, "utf8");
  const again = check(["dist-fixture", "--out", target]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /EEXIST/);
  assert.equal(readFileSync(target, "utf8"), before);
});

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
import { basename, dirname, join, relative, resolve } from "node:path";
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
// Revision 3 (design assessment E11): every stage seals the range of lines it added to each shared row file, and a row outside its stage's
// range is not that stage's evidence. A case that removes rows simulates observations that were never recorded, so the stages are
// re-sealed as such a run would have sealed them: each row read keeps its original line (ORDINAL), and writing a shared file recounts
// every stage's range from the rows that remain. A row a case adds (no ordinal) lies outside every range, as an appended row does.
const ORDINAL = Symbol("ordinal");
const SHARED_FILES = ["measurements.jsonl", "values.jsonl", "collection.jsonl"];
const readLines = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => Object.assign(JSON.parse(l), { [ORDINAL]: i }));
const writeLines = (file, rows) => {
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const name = basename(file);
  const stages = join(dirname(file), "stages");
  if (!SHARED_FILES.includes(name) || !existsSync(stages)) return;
  const kept = rows.map((r) => r[ORDINAL]).filter((o) => o !== undefined);
  const before = (line) => kept.filter((o) => o < line).length;
  for (const f of readdirSync(stages).filter((x) => x.endsWith(".json"))) {
    const record = JSON.parse(readFileSync(join(stages, f), "utf8"));
    if (!record.rows_at_start || !record.rows_at_end) continue;
    record.rows_at_start[name] = before(record.rows_at_start[name]);
    record.rows_at_end[name] = before(record.rows_at_end[name]);
    writeFileSync(join(stages, f), `${JSON.stringify(record, null, 2)}\n`);
  }
};
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
  // Revision 3: rows are reordered within the lines their stage sealed (a row moved into another stage's lines is another case's subject).
  const stage = JSON.parse(
    readFileSync(join(dir, "stages/fixture.json"), "utf8"),
  );
  const rows = readLines(join(dir, "measurements.jsonl"));
  const from = stage.rows_at_start["measurements.jsonl"];
  const to = stage.rows_at_end["measurements.jsonl"];
  writeLines(join(dir, "measurements.jsonl"), [
    ...rows.slice(0, from),
    ...rows.slice(from, to).reverse(),
    ...rows.slice(to),
  ]);
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
      // Revision 3: a protocol records its attempts in plan order, so an attempt never recorded is the protocol's LAST one, not yet
      // done (terminal null); a run missing from the middle of a "complete" file contradicts its plan (a case of its own below).
      "a device-page run",
      (dir) => {
        const file = join(dir, "device-page/results.webkit.json");
        const v = JSON.parse(readFileSync(file, "utf8"));
        v.runs = v.runs.slice(0, -1);
        v.terminal = null;
        const text = `${JSON.stringify(v, null, 2)}\n`;
        writeFileSync(file, text);
        writeLines(
          join(dir, "values.jsonl"),
          readLines(join(dir, "values.jsonl")).map((r) =>
            r.name === "P-11 device page" && r.engine === "webkit"
              ? { ...r, results_sha256: sha(text), runs: v.runs.length }
              : r,
          ),
        );
      },
      "device W7-oversize_change run 1[webkit]",
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
  // Revision 3 (design assessment E10): an unfulfilled control is a finding, never a partial hand-over: 1 even with --allow-partial.
  const checked = validate(join(dir, "handoff"), "--allow-partial");
  assert.equal(checked.status, 1, `${checked.stdout}${checked.stderr}`);
  assert.match(
    checked.stdout,
    /REFUSED: 0 invalid cell\(s\) and 36 failed control\(s\)/,
  );
  assert.equal(validate(join(dir, "handoff")).status, 1);
});

// ---- Q7: valid-workload failures and partial packages ----
test("case: W2's LIVE outcome is a desktop outcome: a live time-out is a failure (H8 true) that does not by itself settle H9", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editJson(join(dir, "w2/P-W2.webkit.json"), (v) => {
    v.live.outcome = "timeout";
  });
  // Revision 3: the writer records the live application twice (the file and the capture's value row); both say what happened.
  writeLines(
    join(dir, "values.jsonl"),
    readLines(join(dir, "values.jsonl")).map((r) =>
      r.name === "P-W2 capture" && r.engine === "webkit"
        ? { ...r, live: { ...r.live, outcome: "timeout" } }
        : r,
    ),
  );
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

// ---- revision 3 (review 3 R2; design assessment E1-E12): observation CONTENTS and every representation of them ---------------------
// Each case alters ONE thing in a complete synthetic programme while keeping every count (and, where it matters, regenerating the hashes
// that identify the bytes), so a failure proves the contents or a relationship is checked, not that a row or a checksum went missing.
const editValue = (dir, name, engine, change) =>
  writeLines(
    join(dir, "values.jsonl"),
    readLines(join(dir, "values.jsonl")).map((r) =>
      r.name === name && (engine === null || r.engine === engine)
        ? (change(r) ?? r)
        : r,
    ),
  );
/** Rewrites a series as `record()` would have written it: new samples, its raw file, its summary and the raw file's hash together. */
const rewriteSeries = (dir, name, engine, change) => {
  const rows = readLines(join(dir, "measurements.jsonl"));
  const row = rows.find((r) => r.name === name && r.engine === engine);
  assert.ok(row, `no series ${name}`);
  const raw = JSON.parse(readFileSync(join(dir, row.raw), "utf8"));
  raw.samples = change(raw.samples);
  const text = `${JSON.stringify(raw)}\n`;
  writeFileSync(join(dir, row.raw), text);
  const s = [...raw.samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  Object.assign(row, {
    n: raw.samples.length,
    min: +s[0].toFixed(3),
    p50: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    p99: +q(0.99).toFixed(3),
    max: +s.at(-1).toFixed(3),
    raw_sha256: sha(text),
  });
  writeLines(join(dir, "measurements.jsonl"), rows);
};
const statusOf = (r, id) => cell(r, id).status;
const reasonsOf = (r, id) => cell(r, id).reasons.join(" | ");
/** Runs each variant on a fresh complete programme and expects exactly the named cells invalid, each with its reason. */
const expectInvalid = (t, variants) => {
  for (const [what, change, expected] of variants) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    change(dir);
    const r = resolveDir(dir);
    const bad = r.cells.filter(
      (c) => !["ok", "unavailable"].includes(c.status),
    );
    assert.deepEqual(
      bad.map((c) => c.id).sort(),
      Object.keys(expected).sort(),
      `${what}: ${JSON.stringify(bad.map((c) => [c.id, c.reasons]))}`,
    );
    for (const [id, pattern] of Object.entries(expected)) {
      assert.equal(statusOf(r, id), "invalid", `${what}: ${id}`);
      assert.match(reasonsOf(r, id), pattern, `${what}: ${id}`);
    }
    assert.equal(r.complete, false, what);
  }
};

test("case (E1/E2/E4): review 3's schedule - every quota outcome null, every ladder row empty and both retirement conditions empty, counts kept - is invalid, never complete, and refused", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editValue(dir, "P-Q2 quota reserve inputs", null, (r) => {
    r.atlas_auth_burst.outcomes = Array.from({ length: 60 }, () => null);
    r.estimate_granularity.rows = Array.from({ length: 15 }, () => ({}));
  });
  for (const engine of ["chromium", "firefox", "webkit"])
    editJson(join(dir, `contention/retirements.${engine}.json`), (v) => {
      v.conditions = [{}, {}];
    });
  const r = resolveDir(dir);
  for (const engine of ["chromium", "firefox", "webkit"]) {
    assert.equal(
      statusOf(r, `P-Q2 quota reserve inputs[${engine}]`),
      "invalid",
    );
    assert.match(
      reasonsOf(r, `P-Q2 quota reserve inputs[${engine}]`),
      /a request outcome is not one the writer records.*ladder write 1 is not a reading|a request outcome is not one the writer records/,
    );
    assert.equal(statusOf(r, `P-8 retirements[${engine}]`), "invalid");
    assert.match(
      reasonsOf(r, `P-8 retirements[${engine}]`),
      /the condition is not recorded under its name/,
    );
  }
  assert.equal(r.complete, false);
  assert.equal(r.items["P-Q2"].status, "partial");
  assert.equal(r.items["P-8"].status, "partial");
  assert.equal(assemble(dir).status, 0);
  const checked = validate(join(dir, "handoff"), "--allow-partial");
  assert.equal(checked.status, 1, `${checked.stdout}${checked.stderr}`);
  assert.match(checked.stdout, /REFUSED: 6 invalid cell\(s\)/);
});

test("case (E2): P-Q2's contents are checked and its figures recomputed: outcomes, ladder, readings, verdicts, growth, step and recommendation", (t) => {
  const pq2 = (change) => (dir) =>
    editValue(dir, "P-Q2 quota reserve inputs", "firefox", (r) => {
      change(r);
    });
  const id = "P-Q2 quota reserve inputs[firefox]";
  expectInvalid(t, [
    [
      "an outcome outside the writer's domain",
      pq2((r) => {
        r.atlas_auth_burst.outcomes[7] = { kind: "x" };
      }),
      { [id]: /a request outcome is not one the writer records/ },
    ],
    [
      "held_at_once below the writer's own assertion",
      pq2((r) => {
        r.atlas_auth_burst.held_at_once = 1;
      }),
      { [id]: /held_at_once 1/ },
    ],
    [
      "an empty ladder row",
      pq2((r) => {
        r.estimate_granularity.rows[3] = {};
      }),
      { [id]: /ladder write 4/ },
    ],
    [
      "the ladder's initial usage removed",
      pq2((r) => {
        delete r.estimate_granularity.initial_usage;
      }),
      { [id]: /initial usage/ },
    ],
    [
      "a wrong cumulative total",
      pq2((r) => {
        r.estimate_granularity.rows[5].total_written += 1;
      }),
      { [id]: /ladder write 6: total_written/ },
    ],
    [
      "a later ladder delta that does not follow from its usage readings (the first step unchanged)",
      pq2((r) => {
        r.estimate_granularity.rows[12].delta += 1;
      }),
      {
        [id]: /ladder write 13: delta .* does not follow from the usage readings/,
      },
    ],
    [
      "a fractional verdict count",
      pq2((r) => {
        r.ledger.verdicts = { reserved: 96.5, refused: 3.5 };
      }),
      { [id]: /100 typed reservation verdicts/ },
    ],
    [
      "the ledger's before reading removed",
      pq2((r) => {
        delete r.ledger.before;
      }),
      { [id]: /ledger\.before is missing/ },
    ],
    [
      "a changed growth",
      pq2((r) => {
        r.atlas_auth_burst.growth_during.estimate += 4096;
      }),
      { [id]: /growth_during does not follow/ },
    ],
    [
      "another first step selected",
      pq2((r) => {
        r.estimate_granularity.estimate_step_bytes = 32_768;
      }),
      { [id]: /the estimate step does not follow/ },
    ],
    [
      "a changed recommendation",
      pq2((r) => {
        r.derived_desktop_recommendation_bytes += 1;
      }),
      { [id]: /the derived recommendation .* does not follow/ },
    ],
  ]);
});

test("control (E2/E3): P-Q2's recommendation is the hand-computed figure, and a coarse estimate that never moves keeps explicit nulls without invented precision", (t) => {
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const rows = readLines(join(dir, "values.jsonl")).filter(
    (r) => r.name === "P-Q2 quota reserve inputs",
  );
  const by = Object.fromEntries(rows.map((r) => [r.engine, r]));
  // Hand-computed: Chromium's burst is its exact IndexedDB growth 52,288 - 40,000 = 12,288 B; elsewhere the estimate's 66,384 - 50,000 =
  // 16,384 B. The estimate first moves by 16,384 B. max(12,288 x 4, 16,384 x 2) = 49,152; max(16,384 x 4, 16,384 x 2) = 65,536.
  assert.equal(by.chromium.derived_desktop_recommendation_bytes, 49_152);
  assert.equal(by.firefox.derived_desktop_recommendation_bytes, 65_536);
  assert.equal(by.webkit.derived_desktop_recommendation_bytes, 65_536);
  assert.equal(by.firefox.estimate_granularity.estimate_step_bytes, 16_384);
  // A coarse estimate that never moved: every delta 0, no step, no recommendation, and that is a valid observation.
  editValue(dir, "P-Q2 quota reserve inputs", "webkit", (r) => {
    const initial = r.estimate_granularity.initial_usage;
    for (const row of r.estimate_granularity.rows) {
      row.usage = initial;
      row.delta = 0;
    }
    r.estimate_granularity.smallest_write_that_moved_the_estimate = null;
    r.estimate_granularity.estimate_step_bytes = null;
    r.derived_desktop_recommendation_bytes = null;
  });
  // Explicit nulls (an engine that gives no estimate) are a capability record, not a missing field.
  editValue(dir, "P-Q2 quota reserve inputs", "firefox", (r) => {
    r.estimate_granularity.initial_usage = null;
    for (const row of r.estimate_granularity.rows) {
      row.usage = null;
      row.delta = null;
    }
    r.estimate_granularity.smallest_write_that_moved_the_estimate = null;
    r.estimate_granularity.estimate_step_bytes = null;
    r.derived_desktop_recommendation_bytes = null;
  });
  const r = resolveDir(dir);
  assert.equal(statusOf(r, "P-Q2 quota reserve inputs[webkit]"), "ok");
  assert.equal(statusOf(r, "P-Q2 quota reserve inputs[firefox]"), "ok");
  assert.equal(r.complete, true);
});

test("case (E3): P-Q footprints are the writer's readings: an explicit null is a capability, a missing field or a flat (revision-2 fixture) shape is not, and the per-draft figure follows", (t) => {
  const id = (engine) => `P-Q footprints[${engine}]`;
  expectInvalid(t, [
    [
      "a reading's indexeddb field removed (not an explicit null)",
      (dir) =>
        editValue(dir, "P-Q footprints", "firefox", (r) => {
          delete r.with_200_drafts.indexeddb;
        }),
      {
        [id("firefox")]:
          /with_200_drafts\.indexeddb is not a byte count or an explicit null/,
      },
    ],
    [
      "Chromium's exact figure null",
      (dir) =>
        editValue(dir, "P-Q footprints", "chromium", (r) => {
          r.baseline.indexeddb = null;
        }),
      {
        [id("chromium")]:
          /baseline\.indexeddb: Chromium's exact CDP figure is missing/,
      },
    ],
    [
      "the flat shape the revision-2 fixture used ({usage, quota, indexeddb})",
      (dir) =>
        editValue(dir, "P-Q footprints", "webkit", (r) => {
          for (const key of ["baseline", "empty_account_database"])
            r[key] = { usage: 1, quota: 2, indexeddb: null };
        }),
      { [id("webkit")]: /baseline\.estimate is missing/ },
    ],
    [
      "a per-draft figure that does not follow",
      (dir) =>
        editValue(dir, "P-Q footprints", "chromium", (r) => {
          r.per_draft_bytes_chromium += 1;
        }),
      { [id("chromium")]: /per_draft_bytes_chromium .* does not follow/ },
    ],
  ]);
});

test("case (E4): P-8 needs both named conditions, every counter recounted from its trace support, its rate from pages and duration, and the value row the same", (t) => {
  const id = "P-8 retirements[webkit]";
  const file = (dir) => join(dir, "contention/retirements.webkit.json");
  expectInvalid(t, [
    [
      "the conditions swapped",
      (dir) =>
        editJson(file(dir), (v) => {
          v.conditions.reverse();
        }),
      { [id]: /not recorded under its name|value row/ },
    ],
    [
      "one counter absent",
      (dir) =>
        editJson(file(dir), (v) => {
          delete v.conditions[1].probe_retire_failed;
        }),
      { [id]: /probe_retire_failed is not a count/ },
    ],
    [
      "a counter that is not what its trace counts (value row changed too)",
      (dir) => {
        editJson(file(dir), (v) => {
          v.conditions[1].leader_leases_retired += 1;
        });
        editValue(dir, "P-8 retirements", "webkit", (r) => {
          r.conditions[1].leader_leases_retired += 1;
        });
      },
      { [id]: /leader_leases_retired .* is not what its trace support counts/ },
    ],
    [
      "a rate that does not follow from pages and duration",
      (dir) => {
        editJson(file(dir), (v) => {
          v.conditions[1].leader_pages_per_second += 0.1;
        });
        editValue(dir, "P-8 retirements", "webkit", (r) => {
          r.conditions[1].leader_pages_per_second += 0.1;
        });
      },
      { [id]: /leader_pages_per_second does not follow/ },
    ],
    [
      "the value row disagreeing with the file",
      (dir) =>
        editValue(dir, "P-8 retirements", "webkit", (r) => {
          r.conditions[0].probe_closing_gave_up += 1;
        }),
      { [id]: /the P-8 value row does not hold the file's conditions/ },
    ],
    [
      "the trace support removed",
      (dir) => rmSync(join(dir, "contention/retirements-trace.webkit.json")),
      { [id]: /trace support is missing/ },
    ],
  ]);
  // Control: legitimate zero counts (the no-leader condition has no leader events at all) are a valid observation.
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const v = JSON.parse(readFileSync(file(dir), "utf8"));
  assert.equal(v.conditions[0].leader_cover_commits, 0);
  assert.equal(statusOf(resolveDir(dir), id), "ok");
});

test("case (E5): P-6's by-cause summary is recomputed from its scenario rows; two summaries agreeing with each other cannot outvote the rows", (t) => {
  const file = (dir) => join(dir, "contention/unresolved-leases.firefox.json");
  const cause = "slow_handling_injected";
  const id = `P-6 ${cause}[firefox]`;
  expectInvalid(t, [
    [
      "a precondition changed in one row, count kept",
      (dir) =>
        editJson(file(dir), (v) => {
          const row = v.rows.find(
            (r) => r.cause === cause && r.foreign_leases === 0,
          );
          row.foreign_leases = 2;
        }),
      { [id]: /by-cause summary does not follow from the scenario rows/ },
    ],
    [
      "both summaries changed together, the rows not",
      (dir) => {
        editJson(file(dir), (v) => {
          v.by_cause[cause].never_resolved += 1;
        });
        editValue(dir, `P-6 ${cause}`, "firefox", (r) => {
          r.never_resolved += 1;
        });
      },
      { [id]: /by-cause summary does not follow|value row does not follow/ },
    ],
    [
      "a first-verdict histogram changed in the value row only",
      (dir) =>
        editValue(dir, `P-6 ${cause}`, "firefox", (r) => {
          r.first_verdicts = { released: r.n };
        }),
      { [id]: /the value row does not follow from the scenario rows/ },
    ],
    [
      "an unresolved scenario with a resolution time",
      (dir) =>
        editJson(file(dir), (v) => {
          const row = v.rows.find(
            (r) => r.cause === cause && r.resolved === false,
          );
          row.resolve_ms = 10;
        }),
      { [id]: /resolve_ms does not agree with resolved/ },
    ],
  ]);
  // Control: the observations taken at different moments differ (no subset relation is imposed), and that is valid.
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const v = JSON.parse(readFileSync(file(dir), "utf8"));
  assert.ok(
    Object.values(v.by_cause).some(
      (e) => e.saw_unresolved !== e.precondition_met,
    ),
  );
  assert.equal(statusOf(resolveDir(dir), id), "ok");
});

test("case (E6): P-7, P-9 and P-13 representations agree: give-ups with outcomes, waits with their JSONL, throughput with its copies, follower figures with the observed hints and transactions", (t) => {
  expectInvalid(t, [
    [
      "a frozen-owner give-up flipped against its outcome",
      (dir) =>
        editJson(join(dir, "contention/frozen-owner.chromium.json"), (v) => {
          v.rows[3].gave_up = !v.rows[3].gave_up;
        }),
      {
        "P-7 frozen owner rows[chromium]":
          /row 4: gave_up .* does not follow from its outcome/,
      },
    ],
    [
      "a P-7 wait sample changed in waits.jsonl only",
      (dir) =>
        writeLines(
          join(dir, "contention/waits.jsonl"),
          readLines(join(dir, "contention/waits.jsonl")).map((r, i) =>
            i === 0 ? { ...r, ms: [r.ms[0] + 1, ...r.ms.slice(1)] } : r,
          ),
        ),
      {
        "P-7 ordinary request, no leader[chromium]":
          /not the series' raw samples/,
      },
    ],
    [
      "a P-9 throughput copy changed in the policy file only",
      (dir) =>
        editJson(join(dir, "contention/yield-policy.webkit.json"), (v) => {
          v.rows[2].throughput_pages_per_second[0] += 1;
        }),
      {
        "P-9 engine support[webkit]":
          /scheduler_yield: the throughput is not its series' samples/,
      },
    ],
    [
      "the engine's yield support not a boolean",
      (dir) =>
        editJson(join(dir, "contention/yield-policy.firefox.json"), (v) => {
          v.engine_support.scheduler_yield = "maybe";
        }),
      { "P-9 engine support[firefox]": /yield support is not recorded/ },
    ],
    [
      "the no-hint control shorter than its five seconds (both representations)",
      (dir) => {
        editJson(join(dir, "contention/follower-reads.firefox.json"), (v) => {
          v.conditions[0].elapsed_ms = 4_000;
        });
        editValue(dir, "P-13 follower reads", "firefox", (r) => {
          r.conditions[0].elapsed_ms = 4_000;
        });
      },
      {
        "P-13 reads, none (control)[firefox]": /did not last its five seconds/,
      },
    ],
    [
      "one observed transaction removed from the support",
      (dir) =>
        editJson(
          join(dir, "contention/follower-reads-raw.chromium.json"),
          (v) => {
            v.conditions[1].tx.splice(5, 1);
          },
        ),
      {
        "P-13 reads, leader pages[chromium]":
          /does not follow from the observed hints and transactions/,
      },
    ],
    [
      "the follower file's throughput differing from its series",
      (dir) => {
        editJson(join(dir, "contention/follower-reads.webkit.json"), (v) => {
          v.leader_throughput_pages_per_second["1"][2] += 1;
        });
        editValue(dir, "P-13 follower reads", "webkit", (r) => {
          r.leader_throughput_pages_per_second["1"][2] += 1;
        });
      },
      {
        "P-13 leader catch-up throughput (pages/s, 200 pages), 1 follower(s)[webkit]":
          /throughput is not this series' samples/,
      },
    ],
  ]);
  // Control: a condition with no reads is the explicit zero and resolves (no distribution recorded for it).
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const r = resolveDir(dir);
  assert.equal(statusOf(r, "P-13 reads, none (control)[chromium]"), "ok");
  assert.equal(
    cell(r, "P-13 reads, none (control)[chromium]").zero_reads,
    true,
  );
});

test("case (E7): a run's memory figures are one observation: the peak is its largest kept sample, its processes add up to it, its copies and the series agree, in run order", (t) => {
  const p11 = (dir, engine, change) =>
    editJson(join(dir, `memory/P-11.${engine}.json`), (v) => {
      change(v);
    });
  const W1 = (v) => v.rows.find((r) => r.workload === "W1");
  expectInvalid(t, [
    [
      "review 3's 9,000,000 KiB peak, nested and top level, series kept",
      (dir) =>
        p11(dir, "webkit", (v) => {
          for (const run of W1(v).runs) {
            run.rss.peak_kib = 9_000_000;
            run.rss_peak_kib = 9_000_000;
          }
        }),
      {
        ...Object.fromEntries(
          [1, 2, 3, 4, 5].map((n) => [
            `P-11 W1 memory, cold run ${n}[webkit]`,
            /not the largest retained sample/,
          ]),
        ),
        "P-11 W1 rss_peak_kib[webkit]": /not the per-run rss_peak_kib/,
      },
    ],
    [
      "the nested peak only",
      (dir) =>
        p11(dir, "chromium", (v) => {
          W1(v).runs[2].rss.peak_kib += 1;
        }),
      {
        "P-11 W1 memory, cold run 3[chromium]":
          /rss_peak_kib is not the attributed record's peak_kib/,
      },
    ],
    [
      "the top-level copy only",
      (dir) =>
        p11(dir, "chromium", (v) => {
          W1(v).runs[0].rss_baseline_kib += 1;
        }),
      {
        "P-11 W1 memory, cold run 1[chromium]":
          /rss_baseline_kib is not the attributed record's baseline_kib/,
      },
    ],
    [
      "the aggregate series only (rehashed)",
      (dir) =>
        rewriteSeries(dir, "P-11 W3 rss_peak_kib", "firefox", (s) => [
          s[0] + 10,
          ...s.slice(1),
        ]),
      { "P-11 W3 rss_peak_kib[firefox]": /not the per-run rss_peak_kib/ },
    ],
    [
      "two runs swapped in the file",
      (dir) =>
        p11(dir, "webkit", (v) => {
          const runs = v.rows.find((r) => r.workload === "W4").runs;
          [runs[0], runs[1]] = [runs[1], runs[0]];
        }),
      {
        "P-11 W4 elapsed_ms[webkit]": /in run order/,
        "P-11 W4 rss_peak_kib[webkit]": /in run order/,
      },
    ],
    [
      "the processes at the peak not adding up to it",
      (dir) =>
        p11(dir, "firefox", (v) => {
          W1(v).runs[4].rss.processes_at_peak[1].rss_kib += 3;
        }),
      {
        "P-11 W1 memory, cold run 5[firefox]": /do not add up to the peak/,
      },
    ],
    [
      "a heap peak that is not its largest sample",
      (dir) =>
        p11(dir, "chromium", (v) => {
          W1(v).runs[1].heap_samples_bytes[0] =
            W1(v).runs[1].heap_peak_bytes + 1;
        }),
      {
        "P-11 W1 memory, cold run 2[chromium]":
          /heap peak is not the largest heap sample/,
      },
    ],
  ]);
});

/** A package laid out as a hand-over (fixtures/ beside the carried evidence) that certifies `engine`'s limit-1 capture; returns its W2-hashes.json. */
const certifyingPackage = (t, dir, engine) => {
  const name = `W2-captured.${engine}.limit-1.json`;
  const at = scratch(t);
  mkdirSync(join(at, "fixtures"), { recursive: true });
  mkdirSync(join(at, "evidence/w2"), { recursive: true });
  cpSync(join(dir, "w2", name), join(at, "fixtures", name));
  cpSync(join(dir, "w2", name), join(at, "evidence/w2", name));
  cpSync(join(dir, "values.jsonl"), join(at, "evidence/values.jsonl"));
  const list = join(at, "fixtures/W2-hashes.json");
  writeFileSync(
    list,
    JSON.stringify({ [name]: sha(readFileSync(join(dir, "w2", name))) }),
  );
  return list;
};
/** Every cell of one engine's device stage (its results file and its 39 runs), as the contract lists them. */
const deviceIds = (engine) =>
  contract
    .requiredCells([engine])
    .filter((c) => c.kind === "device-file" || c.kind === "device-run")
    .map((c) => c.id);

test("case (E8): a W2 capture is checked from its bytes: small or other-person bytes under dense metadata, a wrong phase, a missing person, a malformed bound or limits ladder are refused", (t) => {
  const capture = (engine, limit) =>
    `w2/W2-captured.${engine}.limit-${limit}.json`;
  /** Replaces the bytes and regenerates their identity in the value row (hash, size, MiB): only the meaning can fail. */
  const replaceBytes = (dir, engine, limit, text) => {
    writeFileSync(join(dir, capture(engine, limit)), text);
    editValue(dir, "P-W2 capture", engine, (r) => {
      Object.assign(r.captures[`limit_${limit}`], {
        sha256: sha(text),
        bytes: Buffer.byteLength(text),
        mib: +(Buffer.byteLength(text) / 1_048_576).toFixed(3),
      });
    });
  };
  const device = (engine) => [
    `device page results[${engine}]`,
    /capture|sha256|binder/,
  ];
  const small = JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: 1,
        changes: [
          {
            kind: "upsert",
            resource: { id: programme.PERSON, kind: "person" },
          },
        ],
      },
    ],
    next_cursor: "c",
    has_more: false,
  });
  expectInvalid(t, [
    [
      "a small batch under metadata claiming 200 changes (rehashed)",
      (dir) => replaceBytes(dir, "chromium", 80, small),
      {
        // Revision 4 (labelled adaptation of the revision-3 pattern; same intent, the reader's new wording): the seeded batch is not the seed.
        "P-W2 capture limit 80[chromium]":
          /lacks projection fields.*holds 1 changes, not the seed's 200.*holds 0 distinct fields of the seeded person.*does not follow from the captured bytes/,
      },
    ],
    [
      "the dense batch of ANOTHER person (rehashed)",
      (dir) =>
        replaceBytes(
          dir,
          "firefox",
          80,
          programme.captureBody("firefox", 80, programme.BOUND_PERSON),
        ),
      {
        "P-W2 capture limit 80[firefox]":
          /no batch holds the seeded person: the capture is not the seeded dense batch/,
      },
    ],
    [
      "a snapshot phase",
      (dir) =>
        replaceBytes(
          dir,
          "webkit",
          80,
          programme
            .captureBody("webkit", 80)
            .replace('"phase":"delta"', '"phase":"snapshot"'),
        ),
      {
        "P-W2 capture limit 80[webkit]": /phase "snapshot", not a delta page/,
      },
    ],
    [
      "the recorded shape altered while the bytes are the dense batch (metadata only)",
      (dir) =>
        editValue(dir, "P-W2 capture", "webkit", (r) => {
          r.captures.limit_1.changes = 300;
          r.captures.limit_1.batch_shapes[0].checklist_upserts = 250;
        }),
      {
        "P-W2 capture limit 1[webkit]":
          /the recorded changes does not follow from the captured bytes/,
      },
    ],
    [
      "the seeded person not recorded",
      (dir) =>
        editValue(dir, "P-W2 capture", "chromium", (r) => {
          delete r.seeding.person;
        }),
      {
        "P-W2 capture limit 1[chromium]":
          /seeded person's identity is not a recorded UUID/,
        "P-W2 capture limit 80[chromium]":
          /seeded person's identity is not a recorded UUID/,
        // Revision 4 (A4): without its seeded person the limit-1 capture is not certified, so neither are the protocol's W2 runs of it.
        ...Object.fromEntries(
          deviceIds("chromium").map((id) => [
            id,
            id.startsWith("device page results")
              ? /limit-1 W2 capture is not a valid W2 capture/
              : /results file is refused/,
          ]),
        ),
      },
    ],
    [
      "a delivered bound without its shapes",
      (dir) =>
        editValue(dir, "P-W2 observed bound", "webkit", (r) => {
          delete r.delivered.batch_shapes;
        }),
      {
        "P-W2 observed bound[webkit]":
          /delivered batch shapes are not recorded/,
      },
    ],
    [
      "the limits ladder out of order",
      (dir) =>
        editValue(dir, "W2-limits", "firefox", (r) => {
          const rows = r.probe.command_count_rows;
          [rows[1], rows[2]] = [rows[2], rows[1]];
        }),
      { "W2-limits[firefox]": /not the ladder's/ },
    ],
  ]);
  void device;
});

// ---- Revision 4 (review 4 R2; design assessment A1-A6, Q-C1-Q-C6): a W2 capture is valid for its CONTENTS ---------------------------------
const W2_ENGINES = ["chromium", "firefox", "webkit"];
const W2_COMBOS = W2_ENGINES.flatMap((engine) =>
  [1, 80].map((limit) => [engine, limit]),
);
const capturePath = (dir, engine, limit) =>
  join(dir, `w2/W2-captured.${engine}.limit-${limit}.json`);
/** The integration writer's generic batch statistics (`shapeOf`), written out again here. */
const statsOf = (batch, person) => ({
  changes: batch.changes.length,
  checklist_upserts: batch.changes.filter(
    (c) =>
      c?.kind === "upsert" &&
      c.resource?.kind === "field" &&
      c.resource.value?.kind === "checklist",
  ).length,
  person_ancestor: batch.changes.some(
    (c) => c?.kind === "upsert" && c.resource?.id === person,
  ),
});
/** The device page's file and binder of `engine` re-pointed at capture `hash`, so a stale hash can never be what rejects a variant. */
const rebind = (dir, engine, hash) => {
  const file = join(dir, `device-page/results.${engine}.json`);
  const v = JSON.parse(readFileSync(file, "utf8"));
  v.w2sha256 = hash;
  for (const run of v.runs) if (run.workload === "W2") run.sha256 = hash;
  const text = `${JSON.stringify(v, null, 2)}\n`;
  writeFileSync(file, text);
  editValue(dir, "P-11 device page", engine, (r) => {
    r.results_sha256 = sha(text);
    r.w2_capture.sha256 = hash;
  });
};
/**
 * Writes `bytes` as the capture and regenerates EVERY recorded figure that can follow from them (hash, size and MiB; for a page: phase,
 * batch and change counts, has_more and the batch statistics) and, at limit 1, the device file and binder that name it: only the
 * contents can then fail.
 */
const recapture = (dir, engine, limit, bytes) => {
  const buffer = Buffer.from(bytes);
  writeFileSync(capturePath(dir, engine, limit), buffer);
  let body = null;
  try {
    body = JSON.parse(buffer.toString("utf8"));
  } catch {}
  editValue(dir, "P-W2 capture", engine, (r) => {
    const c = r.captures[`limit_${limit}`];
    Object.assign(c, {
      sha256: sha(buffer),
      bytes: buffer.length,
      mib: +(buffer.length / 1_048_576).toFixed(3),
    });
    if (
      body &&
      typeof body === "object" &&
      Array.isArray(body.batches) &&
      body.batches.every((b) => Array.isArray(b?.changes))
    )
      Object.assign(c, {
        phase: body.phase,
        batches: body.batches.length,
        changes: body.batches.reduce((n, b) => n + b.changes.length, 0),
        has_more: body.has_more,
        batch_shapes: body.batches.map((b) => statsOf(b, r.seeding.person)),
      });
  });
  if (limit === 1) rebind(dir, engine, sha(buffer));
};
/** Edits the parsed capture and recaptures it (every derivable figure regenerated). */
const reshape = (dir, engine, limit, change) => {
  const body = JSON.parse(
    readFileSync(capturePath(dir, engine, limit), "utf8"),
  );
  change(body);
  recapture(dir, engine, limit, JSON.stringify(body));
};
/** The seeded batch of a parsed capture, and its fields (the person is its first change). */
const seeded = (body) =>
  body.batches.find((b) =>
    b.changes.some((c) => c.resource?.id === programme.PERSON),
  );
const fieldsOf = (body) => seeded(body).changes.slice(1);
/** The cells a capture variant must make invalid: the capture's own, and at limit 1 its engine's device cells (A4). */
const captureCells = (engine, limit, pattern) => ({
  [`P-W2 capture limit ${limit}[${engine}]`]: pattern,
  ...(limit === 1
    ? Object.fromEntries(
        deviceIds(engine).map((id) => [
          id,
          id.startsWith("device page results")
            ? /limit-1 W2 capture is not a valid W2 capture/
            : /results file is refused/,
        ]),
      )
    : {}),
});
/** A complete programme written once; every variant edits a copy of it (so a variant can never leak into the next). */
let programmeOnce = null;
const programmeCopy = (t) => {
  if (!programmeOnce) {
    programmeOnce = join(
      mkdtempSync(join(tmpdir(), "atlas-profile-w2-template-")),
      "p",
    );
    writeComplete(programmeOnce);
  }
  const copy = join(scratch(t), "p");
  cpSync(programmeOnce, copy, { recursive: true });
  return copy;
};
const expectCaptureVariants = (t, variants) => {
  for (const [what, change, expected] of variants) {
    const dir = programmeCopy(t);
    change(dir);
    const r = resolveDir(dir);
    const bad = r.cells.filter(
      (c) => !["ok", "unavailable"].includes(c.status),
    );
    assert.deepEqual(
      bad.map((c) => c.id).sort(),
      Object.keys(expected).sort(),
      `${what}: ${JSON.stringify(bad.map((c) => [c.id, c.reasons]).slice(0, 6))}`,
    );
    for (const [id, pattern] of Object.entries(expected)) {
      assert.equal(statusOf(r, id), "invalid", `${what}: ${id}`);
      assert.match(reasonsOf(r, id), pattern, `${what}: ${id}`);
    }
    assert.equal(r.complete, false, what);
    rmSync(dir, { recursive: true, force: true });
  }
};

test("control (Q-C1): the synthetic programme's W2 captures are the writer's real seed, counted here without the contract's reader, and the contract accepts them", (t) => {
  const dir = programmeCopy(t);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const engine of W2_ENGINES) {
    const pages = {};
    for (const limit of [1, 80]) {
      const body = JSON.parse(
        readFileSync(capturePath(dir, engine, limit), "utf8"),
      );
      pages[limit] = body;
      assert.deepEqual(Object.keys(body).sort(), [
        "batches",
        "has_more",
        "next_cursor",
        "phase",
      ]);
      assert.equal(body.phase, "delta");
      assert.equal(body.batches.length, limit === 1 ? 1 : 2);
      const batch = seeded(body);
      assert.equal(batch.changes.length, 200);
      const [person, ...fields] = batch.changes;
      assert.equal(person.resource.id, programme.PERSON);
      assert.equal(person.resource.kind, "person");
      assert.equal(person.resource.parent_id, null);
      assert.equal(fields.length, 199);
      assert.equal(new Set(fields.map((f) => f.resource.id)).size, 199);
      for (const f of fields) {
        assert.equal(f.kind, "upsert");
        assert.equal(f.resource.kind, "field");
        assert.equal(f.resource.parent_id, programme.PERSON);
        assert.match(f.resource.id, UUID);
        const v = f.resource.value;
        assert.deepEqual(Object.keys(v).sort(), ["checked", "items", "kind"]);
        assert.equal(v.kind, "checklist");
        assert.equal(v.items.length, 100);
        assert.equal(new Set(v.items.map((i) => i.id)).size, 100);
        assert.ok(v.items.every((i) => i.label === "x" && UUID.test(i.id)));
        assert.equal(v.checked.length, 40);
        assert.equal(new Set(v.checked).size, 40);
        const ids = new Set(v.items.map((i) => i.id));
        assert.ok(v.checked.every((id) => ids.has(id)));
        // The independent expected size of this exact seed shape (the writer's own assertion): 7,402 bytes.
        assert.equal(Buffer.byteLength(JSON.stringify(v)), 7_402);
      }
    }
    // The seeded batch is the same at both limits; their pagination differs (limit 80 also holds a later ordinary batch).
    assert.deepEqual(seeded(pages[1]), seeded(pages[80]));
    assert.equal(pages[1].has_more, true);
    assert.equal(pages[80].has_more, false);
  }
  const r = resolveDir(dir);
  for (const [engine, limit] of W2_COMBOS)
    assert.equal(statusOf(r, `P-W2 capture limit ${limit}[${engine}]`), "ok");
  assert.equal(r.complete, true);
});

test("case (Q-C2): a capture that is not a sync page - non-JSON, null, a boolean, a number, a string, an array, an empty object - is invalid at either limit in every engine, rehashed", (t) => {
  const kinds = [
    ["non-JSON", "invalid JSON", /the capture is not JSON/],
    ["null", "null", /the capture is null, not a sync page/],
    ["a boolean", "true", /the capture is a boolean, not a sync page/],
    ["a number", "3", /the capture is a number, not a sync page/],
    ["a string", '"a page"', /the capture is a string, not a sync page/],
    ["an array", "[]", /the capture is an array, not a sync page/],
    ["an empty object", "{}", /the page's fields are \[\], not exactly/],
  ];
  expectCaptureVariants(
    t,
    kinds.flatMap(([what, text, pattern]) =>
      W2_COMBOS.map(([engine, limit]) => [
        `${what} as the ${engine} limit-${limit} capture`,
        (dir) => recapture(dir, engine, limit, text),
        captureCells(engine, limit, pattern),
      ]),
    ),
  );
});

test("case (Q-C2): a page whose structure is not the contract's - bytes that are not UTF-8, missing or extra page fields, a bad cursor, has_more or revision, out-of-order batches, an invalid change - is invalid, rehashed", (t) => {
  const edit = (change) => (body) => change(body);
  const variants = [
    [
      "bytes that are not UTF-8",
      (dir, engine, limit) => {
        const text = readFileSync(capturePath(dir, engine, limit));
        const at = text.indexOf(Buffer.from('"label":"x"')) + 10;
        recapture(
          dir,
          engine,
          limit,
          Buffer.concat([
            text.subarray(0, at),
            Buffer.from([0xff]),
            text.subarray(at),
          ]),
        );
      },
      /the capture is not UTF-8/,
    ],
    [
      "no batches",
      edit((b) => delete b.batches),
      /the page's fields are \[has_more, next_cursor, phase\]/,
    ],
    [
      "an extra page field",
      edit((b) => (b.extra = 1)),
      /not exactly \[batches, has_more, next_cursor, phase\]/,
    ],
    [
      "batches that are an object",
      edit((b) => (b.batches = { 0: b.batches[0] })),
      /batches is an object, not an array/,
    ],
    [
      "has_more that is a string",
      edit((b) => (b.has_more = "no")),
      /has_more is not a boolean/,
    ],
    [
      "an empty cursor",
      edit((b) => (b.next_cursor = "")),
      /next_cursor is not an opaque string/,
    ],
    [
      "a cursor that is a number",
      edit((b) => (b.next_cursor = 7)),
      /next_cursor is not an opaque string/,
    ],
    [
      "a batch without its revision",
      edit((b) => delete b.batches[0].revision),
      /batch 1 is not exactly a revision and its changes/,
    ],
    [
      "a negative revision",
      edit((b) => (b.batches[0].revision = -1)),
      /batch 1's revision is not a non-negative integer/,
    ],
    [
      "a fractional revision",
      edit((b) => (b.batches[0].revision = 1.5)),
      /batch 1's revision is not a non-negative integer/,
    ],
    [
      "a change of an unknown kind",
      edit((b) => (b.batches[0].changes[3].kind = "update")),
      /batch 1 change 4 has kind "update"/,
    ],
    [
      "an upsert without its version",
      edit((b) => delete b.batches[0].changes[5].resource.version),
      /batch 1 change 6 lacks projection fields \(version\)/,
    ],
    [
      "an upsert with a field outside the contract",
      edit((b) => (b.batches[0].changes[7].resource.colour = "red")),
      /batch 1 change 8 has projection fields outside the contract \(colour\)/,
    ],
    [
      "a resource id that is not a UUID",
      edit((b) => (b.batches[0].changes[9].resource.id = "f-9")),
      /batch 1 change 10 has an id that is not a UUID/,
    ],
    [
      "an unknown resource kind",
      edit((b) => (b.batches[0].changes[11].resource.kind = "widget")),
      /batch 1 change 12 has resource kind "widget"/,
    ],
    [
      "an empty label",
      edit((b) => (b.batches[0].changes[13].resource.label = "")),
      /batch 1 change 14 has a label that is not 1-300 code points/,
    ],
    [
      "a snapshot phase",
      edit((b) => (b.phase = "snapshot")),
      /the page is phase "snapshot", not a delta page/,
    ],
  ];
  const at80 = [
    [
      "batches out of revision order",
      edit((b) => (b.batches[1].revision = b.batches[0].revision)),
      /batch 2's revision does not follow the one before it/,
    ],
    [
      "a removal carrying another key (the revision-3 fixture's)",
      edit((b) => (b.batches[1].changes[0].resource_kind = "field")),
      /batch 2 change 1 is not a removal of exactly a UUID id/,
    ],
  ];
  const at1 = [
    [
      "two batches on a limit-1 page",
      edit((b) =>
        b.batches.push({ revision: b.batches[0].revision + 1, changes: [] }),
      ),
      /2 batches on a page read with limit 1/,
    ],
  ];
  const list = [];
  for (const [i, [what, change, pattern]] of variants.entries()) {
    const [engine, limit] = W2_COMBOS[i % W2_COMBOS.length];
    list.push([
      `${what} (${engine} limit ${limit})`,
      (dir) =>
        change.length === 3
          ? change(dir, engine, limit)
          : reshape(dir, engine, limit, change),
      captureCells(engine, limit, pattern),
    ]);
  }
  for (const [i, [what, change, pattern]] of at80.entries()) {
    const engine = W2_ENGINES[i % 3];
    list.push([
      `${what} (${engine} limit 80)`,
      (dir) => reshape(dir, engine, 80, change),
      captureCells(engine, 80, pattern),
    ]);
  }
  for (const [what, change, pattern] of at1)
    list.push([
      `${what} (webkit)`,
      (dir) => reshape(dir, "webkit", 1, change),
      captureCells("webkit", 1, pattern),
    ]);
  expectCaptureVariants(t, list);
});

test("case (Q-C3): the seeded batch's DENSITY and relationships are checked: emptied, under-filled or mislabelled checklists, repeated or foreign ids, a wrong parent, an impostor person, unrelated fields and a split seed are each invalid, every derivable figure regenerated", (t) => {
  const f = (i, change) => (body) => change(fieldsOf(body)[i].resource, body);
  const other = "0ff0ff00-0000-4000-8000-0000000000aa";
  const variants = [
    [
      "one checklist emptied",
      f(0, (r) => Object.assign(r.value, { items: [], checked: [] })),
      /holds 0 items, not 100/,
    ],
    ["99 items", f(1, (r) => r.value.items.pop()), /holds 99 items, not 100/],
    [
      "39 checked",
      f(2, (r) => r.value.checked.pop()),
      /checks 39 items, not 40/,
    ],
    [
      'an item labelled "y"',
      f(3, (r) => (r.value.items[50].label = "y")),
      /an item is labelled "y", not "x"/,
    ],
    [
      "an item id that is not a UUID",
      f(4, (r) => (r.value.items[60].id = "item-60")),
      /an item's id is not a UUID/,
    ],
    [
      "two items with one id",
      f(5, (r) => (r.value.items[70].id = r.value.items[71].id)),
      /its item ids are not distinct/,
    ],
    [
      "a checked id listed twice",
      f(6, (r) => (r.value.checked[1] = r.value.checked[0])),
      /its checked ids are not distinct/,
    ],
    [
      "a checked id that is not an item",
      f(7, (r) => (r.value.checked[0] = other)),
      /a checked id is not one of its own items/,
    ],
    [
      "a checklist with another key",
      f(8, (r) => (r.value.note = "")),
      /not exactly a checklist's kind, items and checked/,
    ],
    [
      "a text field in place of a checklist",
      f(9, (r) => (r.value = { kind: "text", text: "x".repeat(7_380) })),
      /not exactly a checklist's kind, items and checked/,
    ],
    [
      "a field of another parent",
      f(10, (r) => (r.parent_id = other)),
      /1 change\(s\) that are not checklist fields of the seeded person.*holds 198 distinct fields/,
    ],
    [
      "a field id repeated",
      f(11, (r, body) => (r.id = fieldsOf(body)[12].resource.id)),
      /field ids are not distinct \(1 repeated\).*holds 198 distinct fields/,
    ],
    [
      "the person replaced by an impostor field with its id",
      (body) =>
        Object.assign(seeded(body).changes[0].resource, {
          kind: "field",
          parent_id: other,
        }),
      /resource with the seeded id is not a person without a parent/,
    ],
    [
      "an unrelated dense field added to the seeded batch",
      (body) =>
        seeded(body).changes.push({
          kind: "upsert",
          resource: {
            ...fieldsOf(body)[0].resource,
            id: other,
            parent_id: other,
          },
        }),
      /holds 201 changes, not the seed's 200.*1 change\(s\) that are not checklist fields/,
    ],
    [
      "one field missing",
      (body) => seeded(body).changes.pop(),
      /holds 199 changes, not the seed's 200.*holds 198 distinct fields/,
    ],
  ];
  const list = variants.map(([what, change, pattern], i) => {
    const [engine, limit] = W2_COMBOS[i % W2_COMBOS.length];
    return [
      `${what} (${engine} limit ${limit})`,
      (dir) => reshape(dir, engine, limit, change),
      captureCells(engine, limit, pattern),
    ];
  });
  list.push([
    "the seed split across two batches (firefox limit 80)",
    (dir) =>
      reshape(dir, "firefox", 80, (body) => {
        const [dense, later] = body.batches;
        const moved = dense.changes.splice(101);
        later.revision += 1;
        body.batches = [
          dense,
          { revision: dense.revision + 1, changes: moved },
          later,
        ];
      }),
    captureCells(
      "firefox",
      80,
      /holds 101 changes, not the seed's 200.*holds 100 distinct fields/,
    ),
  ]);
  // Review 4's schedule: every checklist of the limit-80 capture emptied in all three engines (tags and counts kept).
  list.push([
    "review 4's schedule: every limit-80 checklist emptied in every engine",
    (dir) => {
      for (const engine of W2_ENGINES)
        reshape(dir, engine, 80, (body) => {
          for (const b of body.batches)
            for (const c of b.changes)
              if (c.resource?.value?.kind === "checklist")
                Object.assign(c.resource.value, { items: [], checked: [] });
        });
    },
    Object.assign(
      {},
      ...W2_ENGINES.map((e) => captureCells(e, 80, /holds 0 items, not 100/)),
    ),
  ]);
  expectCaptureVariants(t, list);
});

test("case (Q-C4): the recorded metadata and the identity of the seeded batch must follow from the bytes: seeding counts, has_more, phase, file, swapped engines and a moved revision are refused; a limit-1 content defect with every downstream identity updated is still refused", (t) => {
  const both = (engine, pattern) => ({
    [`P-W2 capture limit 1[${engine}]`]: pattern,
    [`P-W2 capture limit 80[${engine}]`]: pattern,
  });
  expectCaptureVariants(t, [
    [
      "198 dense fields recorded",
      (dir) =>
        editValue(dir, "P-W2 capture", "chromium", (r) => {
          r.seeding.dense_fields = 198;
        }),
      both("chromium", /records 198 dense fields; the W2 seed is 199/),
    ],
    [
      "a 7,400-byte value recorded",
      (dir) =>
        editValue(dir, "P-W2 capture", "firefox", (r) => {
          r.seeding.value_bytes = 7_400;
        }),
      both(
        "firefox",
        /7400-byte checklist values; the captured ones are 7402 bytes/,
      ),
    ],
    [
      "has_more recorded the other way",
      (dir) =>
        editValue(dir, "P-W2 capture", "webkit", (r) => {
          r.captures.limit_1.has_more = false;
        }),
      {
        "P-W2 capture limit 1[webkit]": /the recorded has_more does not follow/,
      },
    ],
    [
      "a snapshot phase recorded over delta bytes",
      (dir) =>
        editValue(dir, "P-W2 capture", "chromium", (r) => {
          r.captures.limit_80.phase = "snapshot";
        }),
      {
        "P-W2 capture limit 80[chromium]": /the recorded phase does not follow/,
      },
    ],
    [
      "another file recorded",
      (dir) =>
        editValue(dir, "P-W2 capture", "firefox", (r) => {
          r.captures.limit_80.file = "w2/elsewhere.json";
        }),
      {
        "P-W2 capture limit 80[firefox]":
          /the recorded file is w2\/elsewhere\.json/,
      },
    ],
    [
      "the limit-1 captures of two engines swapped (rehashed and rebound)",
      (dir) => {
        const a = readFileSync(capturePath(dir, "chromium", 1));
        const b = readFileSync(capturePath(dir, "firefox", 1));
        recapture(dir, "chromium", 1, b);
        recapture(dir, "firefox", 1, a);
      },
      {
        ...both(
          "chromium",
          /the seeded batch is revision \d+ at one limit and \d+ at the other/,
        ),
        ...both(
          "firefox",
          /the seeded batch is revision \d+ at one limit and \d+ at the other/,
        ),
      },
    ],
    [
      "the seeded batch moved to another revision at limit 80 only",
      (dir) =>
        reshape(dir, "webkit", 80, (body) => {
          seeded(body).revision -= 1;
        }),
      both(
        "webkit",
        /the seeded batch is revision \d+ at one limit and \d+ at the other/,
      ),
    ],
    [
      "the seeded batch's contents changed at limit 80 only (a valid label)",
      (dir) =>
        reshape(dir, "chromium", 80, (body) => {
          fieldsOf(body)[0].resource.label = "Renamed";
        }),
      both(
        "chromium",
        /the seeded batch's contents differ between the two limits/,
      ),
    ],
    [
      "a limit-1 checklist emptied with the device file, binder and hashes all updated (A4: the stale hash is not what rejects it)",
      (dir) =>
        reshape(dir, "webkit", 1, (body) => {
          Object.assign(fieldsOf(body)[100].resource.value, {
            items: [],
            checked: [],
          });
        }),
      captureCells("webkit", 1, /holds 0 items, not 100/),
    ],
  ]);
});

test("case (Q-C5): a hand-over whose captures are invalid (review 4's null and emptied schedules) is refused with and without --allow-partial and publishes no desktop conclusion; a missing capture is a partial hand-over", (t) => {
  const schedules = [
    [
      "null captures at limit 80 in every engine",
      (dir) => {
        for (const e of W2_ENGINES) recapture(dir, e, 80, "null");
      },
      "invalid",
    ],
    [
      "every limit-80 checklist emptied in every engine",
      (dir) => {
        for (const e of W2_ENGINES)
          reshape(dir, e, 80, (body) => {
            for (const b of body.batches)
              for (const c of b.changes)
                if (c.resource?.value?.kind === "checklist")
                  Object.assign(c.resource.value, { items: [], checked: [] });
          });
      },
      "invalid",
    ],
    [
      "the firefox limit-80 capture missing",
      (dir) => rmSync(capturePath(dir, "firefox", 80)),
      "missing",
    ],
  ];
  for (const [what, change, kind] of schedules) {
    const dir = programmeCopy(t);
    change(dir);
    const run = assemble(dir);
    assert.equal(run.status, 0, `${what}: ${run.stdout}${run.stderr}`);
    const results = resultsOf(dir);
    assert.equal(results.desktop_programme.complete, false, what);
    assert.equal(results.H8.desktop_valid_workload_failure, null, what);
    assert.equal(results.H9.desktop_needs_finer_pagination, null, what);
    const handoff = join(dir, "handoff");
    const plain = validate(handoff);
    const partial = validate(handoff, "--allow-partial");
    assert.equal(plain.status, 1, `${what}: ${plain.stdout}${plain.stderr}`);
    assert.equal(
      partial.status,
      kind === "invalid" ? 1 : 2,
      `${what} (--allow-partial): ${partial.stdout}${partial.stderr}`,
    );
    const resolution = JSON.parse(
      readFileSync(join(handoff, "resolution.json"), "utf8"),
    );
    const captures = resolution.cells.filter(
      (c) => c.kind === "w2-capture" && c.status !== "ok",
    );
    assert.ok(
      captures.length > 0 && captures.every((c) => c.status === kind),
      `${what}: ${JSON.stringify(captures.map((c) => [c.id, c.status]))}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case (Q-C6): the operator's results file is accepted only with captures its hand-over certifies: a hashes file outside the hand-over, a package without its evidence, an invalid capture rehashed into every list, a limit-80 or unknown capture are refused", (t) => {
  const dir = assembledCopy(t);
  const handoff = join(dir, "handoff");
  const results = join(handoff, "evidence/device-page/results.chromium.json");
  const hashes = join(handoff, "fixtures/W2-hashes.json");
  const fileMode = (file, list) =>
    node([
      join(root, "scripts/validate-profile-handoff.mjs"),
      file,
      "--w2-hashes",
      list,
    ]);
  const control = fileMode(results, hashes);
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
  assert.match(control.stdout, /complete and consistent/);
  // A copy of the hashes outside the hand-over certifies nothing.
  const loose = join(scratch(t), "W2-hashes.json");
  cpSync(hashes, loose);
  const outside = fileMode(results, loose);
  assert.equal(outside.status, 1);
  assert.match(
    outside.stderr,
    /no capture is certified, so no W2 run can be accepted/,
  );
  assert.match(outside.stderr, /W2 run 1\): sha256 \w+ is listed, but/);
  // A hand-over copy without its carried values certifies nothing.
  const bare = join(scratch(t), "bare");
  cpSync(handoff, bare, { recursive: true });
  rmSync(join(bare, "evidence/values.jsonl"));
  const noEvidence = fileMode(
    join(bare, "evidence/device-page/results.chromium.json"),
    join(bare, "fixtures/W2-hashes.json"),
  );
  assert.equal(noEvidence.status, 1);
  assert.match(noEvidence.stderr, /no capture is certified/);
  // An invalid capture (one checklist emptied) put into the fixtures, the carried evidence, W2-hashes.json, its value row and the results.
  const name = "W2-captured.chromium.limit-1.json";
  const body = JSON.parse(
    readFileSync(join(handoff, "fixtures", name), "utf8"),
  );
  Object.assign(fieldsOf(body)[0].resource.value, { items: [], checked: [] });
  const text = JSON.stringify(body);
  const forged = join(scratch(t), "forged");
  cpSync(handoff, forged, { recursive: true });
  writeFileSync(join(forged, "fixtures", name), text);
  writeFileSync(join(forged, "evidence/w2", name), text);
  editJson(join(forged, "fixtures/W2-hashes.json"), (v) => {
    v[name] = sha(text);
  });
  editValue(join(forged, "evidence"), "P-W2 capture", "chromium", (r) => {
    r.captures.limit_1.sha256 = sha(text);
  });
  const forgedResults = join(
    forged,
    "evidence/device-page/results.chromium.json",
  );
  editJson(forgedResults, (v) => {
    v.w2sha256 = sha(text);
    for (const run of v.runs) if (run.workload === "W2") run.sha256 = sha(text);
  });
  const invalid = fileMode(
    forgedResults,
    join(forged, "fixtures/W2-hashes.json"),
  );
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stderr,
    /is listed, but W2-captured\.chromium\.limit-1\.json is NOT a certified W2 capture: .*holds 0 items, not 100/,
  );
  // A run of the limit-80 capture (listed, never the device page's) and of an unknown capture.
  const list = JSON.parse(readFileSync(hashes, "utf8"));
  for (const [what, hash, pattern] of [
    [
      "a limit-80 capture",
      list["W2-captured.chromium.limit-80.json"],
      /a limit-80 capture: the device page runs limit-1 captures/,
    ],
    [
      "an unknown capture",
      "c".repeat(64),
      /is not a captured W2 of the hand-over/,
    ],
  ]) {
    const copy = join(scratch(t), "r.json");
    const v = JSON.parse(readFileSync(results, "utf8"));
    v.w2sha256 = hash;
    for (const run of v.runs) if (run.workload === "W2") run.sha256 = hash;
    writeFileSync(copy, JSON.stringify(v));
    const refused = fileMode(copy, hashes);
    assert.equal(refused.status, 1, what);
    assert.match(refused.stderr, pattern, what);
  }
});

test("case (E9): every published figure is projected from the carried evidence: a published shell figure, admission list, quota copy, consumer status, report line, candidate identity or constant altered alone is refused even with SHA256SUMS regenerated", (t) => {
  const tamper = [
    [
      "the published shell LCP",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          for (const c of d.programme["P-1S"].results.dist.results)
            c.lcp_ms = 1;
        }),
      /results\.json is not what its evidence projects to, at programme\.P-1S/,
    ],
    [
      "H9's W1 admission list",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.H9.w1_outcomes_at_limit_1.chromium = ["refused"];
        }),
      /at H9\.w1_outcomes_at_limit_1/,
    ],
    [
      "H9's live W2 outcome",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.H9.w2_live_outcome.webkit = "timeout";
        }),
      /at H9\.w2_live_outcome/,
    ],
    [
      "a published P-Q2 copy",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.programme[
            "P-Q2"
          ].by_engine.firefox.derived_desktop_recommendation_bytes = 1;
        }),
      /at programme\.P-Q2/,
    ],
    [
      "a consumer-map status",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.consumer_map["BE-Q23:M3 fixtures"].status = "partial";
        }),
      /at consumer_map/,
    ],
    [
      "a stage's candidate identity",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.candidate.stages.fixture.invocation = "another";
        }),
      /at candidate\.stages\.fixture\.invocation/,
    ],
    [
      "a report figure only",
      (h) =>
        writeFileSync(
          join(h, "report.md"),
          readFileSync(join(h, "report.md"), "utf8").replace(
            /\| P-2 ordinary-100 wall_ms \| chromium \| 300 \| [^|]+ \|/,
            "| P-2 ordinary-100 wall_ms | chromium | 300 | 0.001 |",
          ),
        ),
      /report\.md is not the report its evidence and results generate/,
    ],
    [
      "the recorded constants against constants.md",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.programme["P-12"].values = { config: { syncLimitMax: 1 } };
        }),
      /programme\.P-12\.values are not the constants constants\.md shows/,
    ],
    [
      "the recorded pin",
      (h) =>
        editJson(join(h, "results.json"), (d) => {
          d.backend.pin = { ...d.backend.pin, backend_tag: "v0.0.0" };
        }),
      /backend\.pin is not this candidate's contract-pin\.json/,
    ],
  ];
  for (const [what, change, pattern] of tamper) {
    const dir = assembledCopy(t);
    const handoff = join(dir, "handoff");
    change(handoff);
    resum(handoff);
    const checked = validate(handoff);
    assert.equal(checked.status, 1, `${what}: ${checked.stdout}`);
    assert.match(checked.stderr, pattern, what);
  }
  // Control: the untouched copy validates (exit 0), so each refusal above is the tampered field's.
  const control = validate(join(assembledCopy(t), "handoff"));
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
});

test("case (E10): malformed nested evidence is a named finding of its cell, never a crash or an empty success; --allow-partial never accepts invalid evidence", (t) => {
  expectInvalid(t, [
    [
      "a frozen-owner row that is null",
      (dir) =>
        editJson(join(dir, "contention/frozen-owner.webkit.json"), (v) => {
          v.rows[10] = null;
        }),
      {
        "P-7 frozen owner rows[webkit]":
          /row 11 has no outcome or wait|ladder's order/,
      },
    ],
    [
      "retirement conditions that are strings",
      (dir) =>
        editJson(join(dir, "contention/retirements.firefox.json"), (v) => {
          v.conditions = ["no leader", "leader"];
        }),
      { "P-8 retirements[firefox]": /not recorded under its name/ },
    ],
    [
      "a memory record whose process list is a string",
      (dir) =>
        editJson(join(dir, "memory/P-11.chromium.json"), (v) => {
          v.rows[0].runs[0].rss.processes_at_peak = "pids";
        }),
      {
        "P-11 W1 memory, cold run 1[chromium]":
          /processes at the peak are not recorded/,
      },
    ],
  ]);
  // A torn last line of values.jsonl is a malformed file: every value cell says so (none is read as absent).
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  writeFileSync(
    join(dir, "values.jsonl"),
    `${readFileSync(join(dir, "values.jsonl"), "utf8")}{"name":"P-Q`,
  );
  const r = resolveDir(dir);
  assert.equal(statusOf(r, "P-Q footprints[webkit]"), "invalid");
  assert.match(
    reasonsOf(r, "P-Q footprints[webkit]"),
    /values\.jsonl is malformed/,
  );
  // --allow-partial: invalid evidence exits 1; a merely incomplete programme exits 2.
  assert.equal(assemble(dir).status, 0);
  const refused = validate(join(dir, "handoff"), "--allow-partial");
  assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stdout, /REFUSED: \d+ invalid cell\(s\)/);
  const partial = join(scratch(t), "p");
  writeComplete(partial);
  rmSync(join(partial, "shell"), { recursive: true });
  assert.equal(assemble(partial).status, 0);
  const allowed = validate(join(partial, "handoff"), "--allow-partial");
  assert.equal(allowed.status, 2, `${allowed.stdout}${allowed.stderr}`);
  assert.match(
    allowed.stdout,
    /PARTIAL hand-over: the desktop programme is incomplete/,
  );
});

test("case (E11): a row outside the lines its stage sealed, or a stage that sealed no range, is not that stage's evidence", (t) => {
  expectInvalid(t, [
    [
      "a fixture row appended after every stage sealed (a direct spec run copied in)",
      (dir) => {
        const rows = readLines(join(dir, "values.jsonl"));
        const moved = rows.find(
          (r) => r.name === "P-Q footprints" && r.engine === "firefox",
        );
        // The same row, moved to the end of the file: no stage sealed that line (the copy carries no original line).
        const { [ORDINAL]: _line, ...copy } = moved;
        writeLines(join(dir, "values.jsonl"), [
          ...rows.filter((r) => r !== moved),
          copy,
        ]);
      },
      {
        "P-Q footprints[firefox]": /lies outside the lines its stage sealed/,
      },
    ],
  ]);
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  editJson(join(dir, "stages/device.json"), (v) => {
    delete v.rows_at_end;
  });
  const r = resolveDir(dir);
  assert.equal(statusOf(r, "stage:device"), "invalid");
  assert.match(
    reasonsOf(r, "stage:device"),
    /range of values\.jsonl is not recorded/,
  );
  assert.match(
    reasonsOf(r, "device page results[chromium]"),
    /did not seal its range of values\.jsonl/,
  );
});

test("case (E12): a device results file's lifecycle and every run's payload are checked, in the hand-over and in the operator's file mode alike", (t) => {
  const variants = [
    [
      "an admitted engine run without its commit time",
      (v) => {
        v.runs[0].commit_ms = null;
      },
      /runs\[0\] \(W1 run 1\): an admitted engine run without its scan, commit and written count/,
    ],
    [
      "a planned count that is not the plan's",
      (v) => {
        v.planned_runs = 38;
      },
      /planned_runs 38 is not the protocol's 39 attempts/,
    ],
    [
      "a manual collection presented as a protocol's results",
      (v) => {
        v.kind = "manual";
      },
      /kind manual: only a protocol's results are a results file/,
    ],
    [
      "a killed attempt that claims a measurement",
      (v) => {
        Object.assign(v.runs[3], { outcome: "killed", elapsed_ms: 5 });
      },
      /runs\[3\] \(W1 run 4\): a killed attempt cannot have measured or verified anything/,
    ],
    [
      "two attempts out of plan order",
      (v) => {
        [v.runs[5], v.runs[6]] = [v.runs[6], v.runs[5]];
      },
      /attempt 6 of the plan is W2 run 1/,
    ],
  ];
  for (const [what, change, pattern] of variants) {
    const dir = join(scratch(t), "p");
    writeComplete(dir);
    const file = join(dir, "device-page/results.firefox.json");
    const v = JSON.parse(readFileSync(file, "utf8"));
    change(v);
    const text = `${JSON.stringify(v, null, 2)}\n`;
    writeFileSync(file, text);
    editValue(dir, "P-11 device page", "firefox", (r) => {
      r.results_sha256 = sha(text);
    });
    const r = resolveDir(dir);
    assert.equal(statusOf(r, "device page results[firefox]"), "invalid", what);
    assert.match(reasonsOf(r, "device page results[firefox]"), pattern, what);
    // The operator's file mode says the same of the same file. Revision 4 (labelled adaptation, review 4 R2/A5): the hashes come from a
    // package that certifies the capture (the hand-over layout: fixtures/ beside the carried evidence), so the variant, not an uncertified
    // capture, is what file mode must find; its control is below.
    const hashes = certifyingPackage(t, dir, "firefox");
    const fileMode = node([
      join(root, "scripts/validate-profile-handoff.mjs"),
      file,
      "--w2-hashes",
      hashes,
      "--allow-partial",
    ]);
    assert.equal(fileMode.status, 1, `${what}: ${fileMode.stdout}`);
    assert.match(fileMode.stderr, pattern, `${what} (file mode)`);
    assert.doesNotMatch(fileMode.stderr, /is listed, but/, what);
  }
  // Control: the unchanged file with the same kind of package is complete and consistent in file mode.
  const dir = join(scratch(t), "p");
  writeComplete(dir);
  const control = node([
    join(root, "scripts/validate-profile-handoff.mjs"),
    join(dir, "device-page/results.firefox.json"),
    "--w2-hashes",
    certifyingPackage(t, dir, "firefox"),
  ]);
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
});

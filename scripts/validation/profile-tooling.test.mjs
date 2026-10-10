// The sync-profiling tooling (WEB-09c plan 4.1, 4.2 and 4.6): the evidence directory is required and never cleaned, a spec run has no
// default directory, the hand-over validator holds the consumer map and the checksums, and the budget checker holds both builds to the
// measured `budget`. Every check runs the real scripts in a child process. `ATLAS_TOOLING_ROOT` points them at another copy of the
// repository (the qualification runner's mutated copies); by default they are this repository's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
const workloads = await import(
  pathToFileURL(join(root, "scripts/lib/profile-workloads.mjs")).href
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

// ---- the hand-over validator -------------------------------------------------------------------------------------------------------------
/** A complete, consistent synthetic hand-over: every consumer key, the recorded workload hashes, one W2 capture, the checksums. */
function handoff(dir, change = (results) => results) {
  const map = Object.fromEntries(
    evidence.CONSUMER_KEYS.map((key) => [
      key,
      {
        status: evidence.DEVICE_KEYS.includes(key) ? "escalated" : "partial",
        answered_by: ["H0"],
        reason: "synthetic",
        owner: "WEB-09c",
        environment: "desktop-playwright",
        claims_device_class: false,
      },
    ]),
  );
  const results = change({
    schema: 2,
    evidence_key: evidence.EVIDENCE_KEY,
    owner: evidence.EVIDENCE_OWNER,
    consumer_map: map,
    desktop_programme: {
      complete: true,
      outcomes_complete: true,
      missing: [],
      failed: [],
      isolation: { all_clean: true, not_isolated_series: 0 },
    },
    isolation: {
      series: [{ name: "P-2 x", engine: "chromium", verdict: "clean" }],
      tests: [{ test: "P-2: x", engine: "chromium", verdict: "clean" }],
      summary: { series: 1, clean: 1, all_clean: true },
    },
    H8: { desktop_valid_workload_failure: false },
    H9: { desktop_needs_finer_pagination: false },
    device_page_validation: { "results.chromium.json": { exit: 0 } },
  });
  populate(dir, {
    "results.json": `${JSON.stringify(results, null, 2)}\n`,
    "report.md": "# synthetic\n",
    "fixtures/hashes.json": readFileSync(
      join(root, "scripts/lib/profile-workload-hashes.json"),
      "utf8",
    ),
    "fixtures/W2-captured.chromium.limit-1.json": '{"phase":"delta"}\n',
  });
  writeFileSync(
    join(dir, "fixtures/W2-hashes.json"),
    `${JSON.stringify({ "W2-captured.chromium.limit-1.json": sha(readFileSync(join(dir, "fixtures/W2-captured.chromium.limit-1.json"))) })}\n`,
  );
  const lines = Object.entries(inventory(dir))
    .map(([name, hash]) => `${hash}  ${name}`)
    .sort();
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}
const validate = (dir) =>
  node([join(root, "scripts/validate-profile-handoff.mjs"), "--handoff", dir]);

test("control: a complete, consistent hand-over validates (exit 0)", (t) => {
  const dir = scratch(t);
  handoff(dir);
  const run = validate(dir);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

test("case: a hand-over missing one BE-B1/BE-Q23 item is refused", (t) => {
  for (const key of [
    "BE-B1:6 derived values",
    "BE-Q23:M7 cost of finer requests",
  ]) {
    const dir = scratch(t);
    handoff(dir, (results) => {
      delete results.consumer_map[key];
      return results;
    });
    const run = validate(dir);
    assert.equal(run.status, 1, run.stdout);
    assert.match(
      run.stderr,
      new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is missing`),
    );
  }
});

test("case: a desktop row measured while it claims a device class is refused", (t) => {
  const dir = scratch(t);
  handoff(dir, (results) => {
    Object.assign(results.consumer_map["BE-Q23:M4 granularity sweep"], {
      status: "measured",
      claims_device_class: true,
    });
    return results;
  });
  const run = validate(dir);
  assert.equal(run.status, 1, run.stdout);
  assert.match(
    run.stderr,
    /measured on a desktop engine but claims a device class/,
  );
});

test("case: a real-device row cannot be measured from a desktop engine", (t) => {
  const dir = scratch(t);
  handoff(dir, (results) => {
    results.consumer_map["BE-Q23:M1 roster"].status = "measured";
    return results;
  });
  const run = validate(dir);
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /asks for real devices/);
});

test("case: a file SHA256SUMS does not cover, or one that no longer verifies, is refused", (t) => {
  const gap = scratch(t);
  handoff(gap);
  writeFileSync(join(gap, "extra.json"), "{}\n");
  const uncovered = validate(gap);
  assert.equal(uncovered.status, 1, uncovered.stdout);
  assert.match(uncovered.stderr, /does not cover extra\.json/);
  const tampered = scratch(t);
  handoff(tampered);
  writeFileSync(join(tampered, "report.md"), "# changed\n");
  const changed = validate(tampered);
  assert.equal(changed.status, 1, changed.stdout);
  assert.match(changed.stderr, /report\.md does not verify/);
});

test("case: a hand-over that calls itself complete while its own lists say otherwise is refused", (t) => {
  const listed = scratch(t);
  handoff(listed, (results) => {
    results.desktop_programme.missing = ["stage device: not recorded"];
    return results;
  });
  const run = validate(listed);
  assert.equal(run.status, 1, run.stdout);
  assert.match(
    run.stderr,
    /outcomes_complete contradicts its missing and failed lists/,
  );
  const unisolated = scratch(t);
  handoff(unisolated, (results) => {
    results.isolation.series[0].verdict = "contaminated";
    return results;
  });
  const dirty = validate(unisolated);
  assert.equal(dirty.status, 1, dirty.stdout);
  assert.match(dirty.stderr, /all_clean does not match the verdicts/);
});

test("case: no desktop conclusion may be drawn from an incomplete programme (H8 and H9)", (t) => {
  const dir = scratch(t);
  handoff(dir, (results) => {
    Object.assign(results.desktop_programme, {
      complete: false,
      outcomes_complete: false,
      missing: ["stage integration: not recorded"],
    });
    return results;
  });
  const run = validate(dir);
  assert.equal(run.status, 1, run.stdout);
  assert.match(
    run.stderr,
    /H8: no desktop failure is concluded from an INCOMPLETE programme/,
  );
  assert.match(
    run.stderr,
    /H9: 'the desktop engines do not need finer pagination' needs a complete programme/,
  );
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
const VITEST = "9001 1 180.0 node vitest run";
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

// ---- completeness of the assembled hand-over (review R2) ----------------------------------------------------------------------------------
/** A COMPLETE synthetic programme on this candidate: every stage, case, engine, workload, outcome and validation, every series clean. */
function completeProgramme(dir, { busy = () => [] } = {}) {
  const now = evidence.candidate(root);
  const start = Date.now() - 600_000;
  const at = (s) => new Date(start + s * 1000).toISOString();
  for (const stage of evidence.PROGRAMME_STAGES)
    populate(dir, {
      [`stages/${stage}.json`]: `${JSON.stringify({
        stage,
        candidate: now,
        started_at: at(-5),
        finished_at: at(125),
        exit_status: 0,
      })}\n`,
    });
  const samples = [];
  for (let s = -10; s <= 130; s += 5)
    samples.push({
      at: at(s),
      foreign_heavy: busy(s),
      foreign_heavy_cpu_percent: busy(s).length ? 180 : 0,
    });
  const collection = [];
  const measurements = [];
  for (const [stage, prefixes] of Object.entries(evidence.REQUIRED_CASES))
    for (const engine of evidence.ENGINES)
      for (const prefix of prefixes) {
        const test = `${prefix} synthetic ${stage}`;
        collection.push({
          test,
          engine,
          from: at(10),
          to: at(100),
          status: "passed",
        });
        measurements.push({
          name: `${prefix.split(":")[0]} synthetic`,
          engine,
          n: 1,
          at: at(90),
          collection: { test, from: at(10), to: at(90) },
        });
      }
  const capture = '{"phase":"delta","batches":[]}\n';
  const captureSha = sha(capture);
  const recorded = JSON.parse(
    readFileSync(
      join(root, "scripts/lib/profile-workload-hashes.json"),
      "utf8",
    ),
  );
  const controls = workloads
    .allWorkloads()
    .map((w) => w.name)
    .filter((n) => n.startsWith("W7-"));
  const cold = (n, outcome = "admitted") =>
    Array.from({ length: n }, () => ({ outcome }));
  const files = {
    "bundle-delta.json": `${JSON.stringify({ id: "P-1", budgets: { dist: { exit: 0 }, "dist-fixture": { exit: 0 } } })}\n`,
    "shell/dist.json": "{}\n",
    "shell/dist-fixture.json": "{}\n",
    "isolation/fixture.jsonl": `${samples.map((x) => JSON.stringify(x)).join("\n")}\n`,
    [evidence.COLLECTION_LOG]: `${collection.map((x) => JSON.stringify(x)).join("\n")}\n`,
    "measurements.jsonl": `${measurements.map((x) => JSON.stringify(x)).join("\n")}\n`,
  };
  for (const engine of evidence.ENGINES) {
    files[`memory/P-11.${engine}.json`] = `${JSON.stringify({
      engine,
      rows: [
        ...evidence.COLD_RUN_WORKLOADS.map((workload) => ({
          workload,
          expected: "admitted",
          runs: cold(5),
        })),
        ...controls.map((workload) => ({
          workload,
          expected: "refused",
          runs: cold(1, "refused"),
        })),
      ],
    })}\n`;
    files[`w2/P-W2.${engine}.json`] = `${JSON.stringify({
      engine,
      live: { outcome: "admitted" },
      rows: [{ workload: "W2", expected: "admitted", runs: cold(5) }],
    })}\n`;
    files[`w2/W2-captured.${engine}.limit-1.json`] = capture;
    const run = (workload, n) => ({
      workload,
      run: n,
      cold: true,
      expected: workload.startsWith("W7-") ? "refused" : "admitted",
      outcome: workload.startsWith("W7-") ? "refused" : "admitted",
      detail: "",
      sha256:
        workload === "W2"
          ? captureSha
          : recorded.workloads.find((w) => w.name === workload).sha256,
      sha256_verified: true,
      bytes: 1,
      elapsed_ms: 1,
      user_agent: "synthetic",
    });
    files[`device-page/results.${engine}.json`] = `${JSON.stringify({
      schema: 1,
      workload_version: recorded.version,
      machine: {
        user_agent: "synthetic",
        device_memory_gib: null,
        hardware_concurrency: 8,
        platform: "synthetic",
        secure_context: true,
      },
      runs: [...recorded.workloads.map((w) => w.name), "W2"].flatMap((name) =>
        ["W1", "W2", "W3", "W4", "W6"].includes(name)
          ? [1, 2, 3, 4, 5].map((n) => run(name, n))
          : [run(name, 1)],
      ),
    })}\n`;
  }
  populate(dir, files);
}
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

test("control: a complete, isolated programme assembles into a complete hand-over whose desktop conclusions stand, and it validates (exit 0)", (t) => {
  const dir = join(scratch(t), "programme");
  completeProgramme(dir);
  const run = assemble(dir);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const results = resultsOf(dir);
  assert.deepEqual(results.desktop_programme.missing, []);
  assert.deepEqual(results.desktop_programme.failed, []);
  assert.equal(results.desktop_programme.complete, true);
  assert.equal(results.H8.desktop_valid_workload_failure, false);
  assert.equal(results.H9.desktop_needs_finer_pagination, false);
  assert.match(results.H9.needs_finer_pagination, /do not need it/);
  assert.match(
    readFileSync(join(dir, "handoff/report.md"), "utf8"),
    /Desktop programme: COMPLETE and ISOLATED/,
  );
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
});

test("case: the hand-over assembled from an empty programme carries every consumer key, says it is incomplete, concludes nothing, and is refused (1; 2 when partial is allowed)", (t) => {
  const dir = join(scratch(t), "programme");
  const run = assemble(dir);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const results = resultsOf(dir);
  assert.deepEqual(
    Object.keys(results.consumer_map).sort(),
    [...evidence.CONSUMER_KEYS].sort(),
  );
  for (const key of evidence.DEVICE_KEYS)
    assert.equal(results.consumer_map[key].status, "escalated");
  assert.equal(results.desktop_programme.complete, false);
  assert.ok(
    results.desktop_programme.missing.includes(
      "stage integration: not recorded",
    ),
  );
  assert.equal(results.H8.desktop_valid_workload_failure, null);
  assert.equal(results.H9.desktop_needs_finer_pagination, null);
  assert.doesNotMatch(results.H9.needs_finer_pagination, /do not need it/);
  assert.match(results.H8.desktop_answer, /UNDETERMINED/);
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 1, `${checked.stdout}${checked.stderr}`);
  assert.match(
    checked.stdout,
    /PARTIAL hand-over: the desktop programme is incomplete/,
  );
  const partial = node([
    join(root, "scripts/validate-profile-handoff.mjs"),
    "--handoff",
    join(dir, "handoff"),
    "--allow-partial",
  ]);
  assert.equal(partial.status, 2, `${partial.stdout}${partial.stderr}`);
});

test("case: a failed stage leaves the programme incomplete and the desktop answer undetermined", (t) => {
  const dir = join(scratch(t), "programme");
  completeProgramme(dir);
  const file = join(dir, "stages/integration.json");
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file, "utf8")),
      exit_status: 1,
    }),
  );
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.deepEqual(results.desktop_programme.failed, [
    "stage integration: exit status 1",
  ]);
  assert.equal(results.H8.desktop_valid_workload_failure, null);
  assert.equal(results.H9.desktop_needs_finer_pagination, null);
  assert.equal(validate(join(dir, "handoff")).status, 1);
});

test("case: W2's LIVE outcome is a desktop outcome: a live time-out is a failure, never 'no valid workload failed'", (t) => {
  const dir = join(scratch(t), "programme");
  completeProgramme(dir);
  const file = join(dir, "w2/P-W2.webkit.json");
  const w2 = JSON.parse(readFileSync(file, "utf8"));
  w2.live.outcome = "timeout";
  writeFileSync(file, JSON.stringify(w2));
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.equal(results.H8.desktop_valid_workload_failure, true);
  assert.deepEqual(results.H8.desktop_answer.failures, [
    {
      engine: "webkit",
      workload: "W2",
      path: "live application by the production engine",
      outcome: "timeout",
    },
  ]);
  assert.notEqual(results.H9.desktop_needs_finer_pagination, false);
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
});

test("case: a device page result its validator refuses (a W2 run of other bytes) makes the programme incomplete", (t) => {
  const dir = join(scratch(t), "programme");
  completeProgramme(dir);
  const file = join(dir, "device-page/results.firefox.json");
  const device = JSON.parse(readFileSync(file, "utf8"));
  device.runs.find((r) => r.workload === "W2").sha256 = "f".repeat(64);
  writeFileSync(file, JSON.stringify(device));
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.equal(results.desktop_programme.failed.length, 1);
  assert.match(
    results.desktop_programme.failed[0],
    /^device page \[firefox\]: the validator exited 1/,
  );
  assert.equal(results.H8.desktop_valid_workload_failure, null);
});

test("case: other heavy work during the collection makes a complete programme NOT isolated: a partial hand-over, refused unless partial is allowed", (t) => {
  const dir = join(scratch(t), "programme");
  completeProgramme(dir, { busy: (s) => (s >= 40 && s <= 50 ? [VITEST] : []) });
  assert.equal(assemble(dir).status, 0);
  const results = resultsOf(dir);
  assert.equal(results.desktop_programme.outcomes_complete, true);
  assert.equal(results.desktop_programme.complete, false);
  assert.ok(results.isolation.summary.contaminated > 0);
  assert.equal(results.isolation.summary.clean, 0);
  assert.match(
    readFileSync(join(dir, "handoff/report.md"), "utf8"),
    /outcomes complete, NOT ISOLATED/,
  );
  const checked = validate(join(dir, "handoff"));
  assert.equal(checked.status, 1, `${checked.stdout}${checked.stderr}`);
  assert.match(
    checked.stdout,
    /PARTIAL hand-over: the desktop programme is not isolated/,
  );
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

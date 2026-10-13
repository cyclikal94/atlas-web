// WEB-09c revision 9 (review 9 R2; family profiling-evidence-completeness): a cold run's or live application's outcome is evidence only
// when the ONE observation it was classified from shows it. Review 9 found two WebKit cold runs of the Air request
// profile-20261013-013915-cf05e051 recorded `refused` with the detail {"kind":"running","catchingUp":true}: the old helper took any
// non-running state (a start's `waiting` included) as the end, then read the state again and called whatever it saw a refusal. The
// contract (scripts/lib/profile-contract.mjs, version 4) refuses such records, and the strict validator refuses a hand-over carrying them.
//
// Each case edits one record of a complete synthetic programme (scripts/validation/profile-programme-fixture.mjs, which imports neither
// the contract nor the projection) and resolves it. Positive controls: the complete programme, a valid workload GENUINELY refused (a
// finding the contract keeps as `refused`, not a structural fault) and a waiting-for-a-valid-cache refusal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(
  process.env.ATLAS_TOOLING_ROOT ??
    join(fileURLToPath(new URL(".", import.meta.url)), "../.."),
);
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const evidence = await load("scripts/lib/profile-evidence.mjs");
const contract = await load("scripts/lib/profile-contract.mjs");
const programme = await load(
  "scripts/validation/profile-programme-fixture.mjs",
);

const scratch = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atlas-outcome-obs-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "p");
};
const writeComplete = (dir) =>
  programme.writeProgramme(dir, { candidate: evidence.candidate(root) });
const cell = (r, id) => {
  const found = r.cells.find((c) => c.id === id);
  assert.ok(found, `no cell ${id}`);
  return found;
};
const editJson = (file, change) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(change(value) ?? value, null, 2)}\n`);
};
/** Edits cold run `run` (1-based) of `workload` in the engine's P-11 file. */
const editP11 = (dir, engine, workload, run, change) =>
  editJson(join(dir, `memory/P-11.${engine}.json`), (file) => {
    const row = file.rows.find((r) => r.workload === workload);
    change(row.runs[run - 1], row);
  });
const P11_W4_2 = "P-11 W4 cold run 2[webkit]";
const W2_5 = "P-W2 W2 cold run 5[webkit]";
const LIVE = "P-W2 W2 live application[chromium]";
const reasons = (c) => c.reasons.join(" | ");
/** The Air record as review 9 retained it: refused, its detail a `running` state, no observation (contract version 3 had none). */
const airRecord = (run) => {
  run.outcome = "refused";
  run.detail = JSON.stringify({ kind: "running", catchingUp: true });
  delete run.observation;
};
/** The same contradiction with an observation that records it (a classifier that kept the old rule). */
const runningObserved = (run) => {
  const state = { kind: "running", catchingUp: true };
  run.outcome = "refused";
  run.detail = JSON.stringify(state);
  run.observation.terminal.state = state;
  run.observation.step_end.recorded = "running";
  run.observation.commits = [];
  run.scan_ms = null;
  run.commit_ms = null;
};

test("control: the complete synthetic programme's every outcome cell is ok under contract version 4", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const r = contract.resolveEvidence(dir);
  assert.equal(r.complete, true);
  const outcomes = r.cells.filter((c) => c.kind === "outcome");
  // Three engines x (W1, W3, W4, W6 five cold runs each + six W7 controls + five W2 cold runs + the live application).
  assert.equal(outcomes.length, 96);
  assert.deepEqual(
    outcomes.filter((c) => c.status !== "ok").map((c) => c.id),
    [],
  );
  assert.equal(evidence.CONTRACT_VERSION, 4);
});

test("case: review 9's Air record (refused over a running state, no observation) is invalid in P-11 and P-W2, and the strict validator refuses the hand-over", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editP11(dir, "webkit", "W4", 2, airRecord);
  editJson(join(dir, "w2/P-W2.webkit.json"), (file) => {
    airRecord(file.rows[0].runs[4]);
  });
  const r = contract.resolveEvidence(dir);
  for (const id of [P11_W4_2]) {
    const c = cell(r, id);
    assert.equal(c.status, "invalid", id);
    assert.match(
      reasons(c),
      /a refused run without the observation it was classified from/,
    );
  }
  const w2 = cell(r, W2_5);
  assert.equal(w2.status, "invalid");
  assert.match(reasons(w2), /without the observation it was classified from/);
  assert.equal(r.complete, false);
  const assembled = spawnSync(
    process.execPath,
    [
      join(root, "scripts/profile-sync.mjs"),
      "--evidence",
      dir,
      "--only",
      "handoff",
    ],
    { cwd: root, encoding: "utf8", timeout: 180_000 },
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
    { cwd: root, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(validated.status, 1, `${validated.stdout}${validated.stderr}`);
});

test("case: a refusal whose observation ends in running is invalid: running is not a verdict on the page", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editP11(dir, "webkit", "W4", 2, runningObserved);
  const c = cell(contract.resolveEvidence(dir), P11_W4_2);
  assert.equal(c.status, "invalid");
  assert.match(reasons(c), /the step ended in running/);
  assert.match(
    reasons(c),
    /recorded refused, but the observation shows no verdict \(running\)/,
  );
});

test("case: a startup waiting state observed before the request is not a refusal (the terminal precedes the request)", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editP11(dir, "webkit", "W4", 2, (run) => {
    const state = { kind: "waiting", reason: "cache_not_valid" };
    run.outcome = "refused";
    run.detail = JSON.stringify(state);
    run.observation.terminal = { index: 0, at: 10, trace: 0, state };
    run.observation.step_end.recorded = "waiting";
    run.observation.commits = [];
    run.scan_ms = null;
    run.commit_ms = null;
  });
  const c = cell(contract.resolveEvidence(dir), P11_W4_2);
  assert.equal(c.status, "invalid");
  assert.match(reasons(c), /the terminal state precedes the request/);
});

test("case: an outcome its observation does not show, or a detail that is not the observed state, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  // Admitted recorded as refused.
  editP11(dir, "webkit", "W4", 2, (run) => {
    run.outcome = "refused";
  });
  // A detail read separately (another state than the observation's).
  editP11(dir, "webkit", "W4", 3, (run) => {
    run.detail = JSON.stringify({ kind: "running", catchingUp: false });
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11_W4_2)),
    /recorded refused, but the observation shows admitted/,
  );
  const c3 = cell(r, "P-11 W4 cold run 3[webkit]");
  assert.equal(c3.status, "invalid");
  assert.match(reasons(c3), /the detail is not the observed terminal state/);
});

test("case: a step end that records another state than the one published is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editP11(dir, "webkit", "W4", 2, (run) => {
    run.observation.step_end.recorded = "backing_off";
  });
  const c = cell(contract.resolveEvidence(dir), P11_W4_2);
  assert.equal(c.status, "invalid");
  assert.match(reasons(c), /does not record the published idle/);
});

test("case: admitted without the served page's applied commit, with another page's bytes, or with figures that are not that commit's, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editP11(dir, "webkit", "W4", 1, (run) => {
    run.observation.commits[0].kind = "dropped";
  });
  editP11(dir, "webkit", "W4", 2, (run) => {
    run.observation.commits[0].bytes += 1;
  });
  editP11(dir, "webkit", "W4", 3, (run) => {
    // The old helper's `.at(-1)`: the figures of a later commit, not the measured page's.
    run.scan_ms += 1;
  });
  editP11(dir, "webkit", "W4", 4, (run) => {
    run.requests = 0;
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, "P-11 W4 cold run 1[webkit]")),
    /idle without the served page's applied commit/,
  );
  assert.match(
    reasons(cell(r, P11_W4_2)),
    /the first commit after the request is \d+ bytes, not the served \d+/,
  );
  assert.match(
    reasons(cell(r, "P-11 W4 cold run 3[webkit]")),
    /scan_ms .* is not the served page's commit/,
  );
  assert.match(
    reasons(cell(r, "P-11 W4 cold run 4[webkit]")),
    /no \/sync request reached the stub/,
  );
  assert.equal(
    cell(r, "P-11 W4 cold run 5[webkit]").status,
    "ok",
    "the other runs are not affected",
  );
});

test("case: a step that ended waiting for the session is not a verdict on the page", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editP11(dir, "webkit", "W4", 2, (run) => {
    const state = { kind: "waiting", reason: "paused_by_session" };
    run.outcome = "refused";
    run.detail = JSON.stringify(state);
    run.observation.terminal.state = state;
    run.observation.step_end.recorded = "waiting";
    run.observation.commits = [];
    run.scan_ms = null;
    run.commit_ms = null;
  });
  const c = cell(contract.resolveEvidence(dir), P11_W4_2);
  assert.equal(c.status, "invalid");
  assert.match(
    reasons(c),
    /the step ended waiting \(paused_by_session\): not a verdict on the page/,
  );
});

test("control: a valid workload genuinely refused (backing off, or waiting for a valid cache, after the request) resolves ok with outcome refused: a finding, not a structural fault", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const refusal = (state) => (run) => {
    run.outcome = "refused";
    run.detail = JSON.stringify(state);
    run.observation.terminal.state = state;
    run.observation.step_end.recorded = state.kind;
    run.observation.commits = [];
    run.scan_ms = null;
    run.commit_ms = null;
  };
  editP11(dir, "webkit", "W4", 2, refusal({ kind: "backing_off", since: 1 }));
  editP11(
    dir,
    "webkit",
    "W4",
    3,
    refusal({ kind: "waiting", reason: "cache_not_valid" }),
  );
  const r = contract.resolveEvidence(dir);
  for (const id of [P11_W4_2, "P-11 W4 cold run 3[webkit]"]) {
    const c = cell(r, id);
    assert.equal(c.status, "ok", `${id}: ${reasons(c)}`);
    assert.equal(c.outcome, "refused");
  }
});

test("case: a live application without its observation, or whose observation does not show its outcome, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editJson(join(dir, "w2/P-W2.chromium.json"), (file) => {
    file.live.observation.state = { kind: "running", catchingUp: false };
  });
  editJson(join(dir, "w2/P-W2.webkit.json"), (file) => {
    delete file.live.observation;
  });
  // The capture value row repeats the live record: kept equal so only the observation is in question.
  const values = join(dir, "values.jsonl");
  const rows = readFileSync(values, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  for (const row of rows)
    if (row.id === "P-W2 capture") {
      const file = JSON.parse(
        readFileSync(join(dir, `w2/P-W2.${row.engine}.json`), "utf8"),
      );
      row.value.live = file.live;
    }
  writeFileSync(values, `${rows.map((x) => JSON.stringify(x)).join("\n")}\n`);
  const r = contract.resolveEvidence(dir);
  const c = cell(r, LIVE);
  assert.equal(c.status, "invalid", reasons(c));
  assert.match(
    reasons(c),
    /recorded admitted, but the observation shows no verdict \(running\)/,
  );
  assert.match(
    reasons(cell(r, "P-W2 W2 live application[webkit]")),
    /without the observation it was classified from/,
  );
});

test("case: a stage recorded under contract version 3 (review 9's Air request) is not evidence of version 4", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editJson(join(dir, "stages/fixture.json"), (v) => {
    v.contract_version = 3;
  });
  const r = contract.resolveEvidence(dir);
  assert.equal(r.complete, false);
  assert.ok(
    r.cells.some((c) =>
      c.reasons.join(" ").includes("recorded under contract 3, not 4"),
    ),
  );
});

// WEB-09c revision 9 (review 9 R2) and revision 10 (review 10's R2 follow-up; design assessment DA-1 to DA-5; family
// profiling-evidence-completeness): a cold run's, the live application's and a device engine run's outcome is evidence only when its
// retained witness corroborates it.
//
// Review 9 found two WebKit cold runs of the Air request profile-20261013-013915-cf05e051 recorded `refused` with the detail
// {"kind":"running","catchingUp":true}. Review 10 then found revision 9's corroboration optional: a first commit without bytes, a terminal
// equal to or before the request, a failed step paired with idle, and live dense commits of zero or invented size absent from the trace all
// resolved `ok` and derived desktop support; the design assessment added device results whose engine detail contradicts their outcome.
// Contract version 5 (scripts/lib/profile-contract.mjs, with scripts/lib/profile-outcome-rules.mjs) requires the witnesses.
//
// Each case edits one fact of a complete synthetic programme (scripts/validation/profile-programme-fixture.mjs, which imports neither the
// contract, the projection nor the rules) and resolves it; expected statuses and reasons are written here. Where a case isolates a semantic
// rule, the intended duplicates (the W2 capture row's live copy, a coherent witness's events and summaries) are edited consistently and the
// test asserts the duplicate checks did NOT fire. Public consumers: the hand-over assembler (`profile-sync.mjs --only handoff`), the strict
// validator with and without --allow-partial, and the validator's standalone device-results mode. Positive controls: the complete
// programme, genuine refusals (back-off, waiting for a valid cache, a failed step's stop, after a has_more continuation), a long has_more
// schedule, the density threshold and a genuine live stop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const device = await load("scripts/lib/profile-device-results.mjs");
const programme = await load(
  "scripts/validation/profile-programme-fixture.mjs",
);
const hashes = JSON.parse(
  readFileSync(join(root, "scripts/lib/profile-workload-hashes.json"), "utf8"),
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
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const editJson = (file, change) => {
  const value = readJson(file);
  writeFileSync(file, `${JSON.stringify(change(value) ?? value, null, 2)}\n`);
};
const reasons = (c) => c.reasons.join(" | ");
const DUPLICATE =
  /the capture row's (live application|cold outcome) is not the file's/;

/** Edits cold run `run` (1-based) of `workload`: the engine's P-11 file, or (`workload` W2) its P-W2 file. */
const editCold = (dir, engine, workload, run, change) =>
  editJson(
    join(
      dir,
      workload === "W2"
        ? `w2/P-W2.${engine}.json`
        : `memory/P-11.${engine}.json`,
    ),
    (file) => {
      const row = file.rows.find((r) => r.workload === workload);
      change(row.runs[run - 1], row);
    },
  );
/** The values.jsonl rows, and a writer of them. */
const valueRows = (dir) =>
  readFileSync(join(dir, "values.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const writeValueRows = (dir, rows) =>
  writeFileSync(
    join(dir, "values.jsonl"),
    `${rows.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
/**
 * Edits the live application in its file AND in its one W2 capture value row (DA-4: rows carry their identity flattened, `name` and
 * `engine`, the value's own fields at the top level, so the copy is `row.live`), keeping the intentional duplicate equal.
 */
const editLive = (dir, engine, change) => {
  let live;
  editJson(join(dir, `w2/P-W2.${engine}.json`), (file) => {
    change(file.live);
    live = file.live;
  });
  const rows = valueRows(dir);
  const matched = rows.filter(
    (r) => r.name === "P-W2 capture" && r.engine === engine,
  );
  assert.equal(matched.length, 1, "exactly one capture row was edited");
  matched[0].live = live;
  writeValueRows(dir, rows);
};
const tracePath = (dir, engine) =>
  join(dir, `w2/P-W2.${engine}.live-engine-trace.txt`);
const editTrace = (dir, engine, change) => {
  const lines = readFileSync(tracePath(dir, engine), "utf8").split("\n");
  writeFileSync(tracePath(dir, engine), change(lines).join("\n"));
};
const captureBytes = (dir, engine) =>
  readFileSync(join(dir, `w2/W2-captured.${engine}.limit-1.json`)).length;

/** Applies `change` to the first commit after the request in BOTH of the witness's representations (its events and its commits). */
const editFirstCommit = (change) => (run) => {
  const o = run.observation;
  for (const e of o.events)
    if (e.event === "data.sync_commit") change(e.payload);
  change(o.commits[0]);
};
/** Rewrites a cold witness into the coherent schedule of a request step that ended in `state` with no commit. */
const endWithout =
  (state, outcome, when = "event") =>
  (run) => {
    const o = run.observation;
    o.events = [
      {
        trace: 1,
        event: "data.sync_next",
        payload: { when, state: state.kind },
      },
    ];
    o.published[2] = { ...o.published[2], trace: 1, state };
    o.terminal = { index: 2, at: o.published[2].at, trace: 1, state };
    o.step_end = { trace: 1, event: "data.sync_next", recorded: state.kind };
    o.commits = [];
    run.outcome = outcome;
    run.detail = JSON.stringify(state);
    run.scan_ms = null;
    run.commit_ms = null;
  };
/** The coherent schedule of a step that committed the served page, then threw; `final` is what was published after the failure. */
const failedStep = (final, outcome) => (run) => {
  const o = run.observation;
  const commit = o.commits[0];
  o.events = [
    { trace: 1, event: "data.sync_commit", payload: commit },
    { trace: 2, event: "data.sync_step_failed", payload: null },
  ];
  o.published[2] = { ...o.published[2], trace: 3, state: final };
  o.terminal = { index: 2, at: o.published[2].at, trace: 3, state: final };
  o.step_end = { trace: 2, event: "data.sync_step_failed", recorded: null };
  run.outcome = outcome;
  run.detail = JSON.stringify(final);
  if (outcome !== "admitted") {
    run.scan_ms = null;
    run.commit_ms = null;
  }
};

const node = (args) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
  });
const assemble = (dir) => {
  const r = node([
    join(root, "scripts/profile-sync.mjs"),
    "--evidence",
    dir,
    "--only",
    "handoff",
  ]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return readJson(join(dir, "handoff/results.json"));
};
const validate = (dir, ...extra) =>
  node([
    join(root, "scripts/validate-profile-handoff.mjs"),
    "--handoff",
    join(dir, "handoff"),
    ...extra,
  ]);
/** The public verdict of a contradicted package: no desktop support, refused strictly and with --allow-partial. */
const refusedEndToEnd = (dir) => {
  const results = assemble(dir);
  assert.equal(results.acceptance_scope.desktop_decision.supports, false);
  const strict = validate(dir);
  assert.equal(strict.status, 1, `${strict.stdout}${strict.stderr}`);
  const partial = validate(dir, "--allow-partial");
  assert.equal(partial.status, 1, `${partial.stdout}${partial.stderr}`);
};

const P11 = (engine, workload, run) =>
  `P-11 ${workload} cold run ${run}[${engine}]`;
const W2_5 = "P-W2 W2 cold run 5[webkit]";
const LIVE = (engine) => `P-W2 W2 live application[${engine}]`;

// ---- controls -----------------------------------------------------------------------------------------------------------------------

test("control: the complete synthetic programme's every outcome cell is ok under contract version 5; assembled, it supports the desktop decision and passes the strict validator and the standalone device-results mode; one contradicted device file is refused there", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  assert.equal(evidence.CONTRACT_VERSION, 5);
  assert.equal(device.DEVICE_SCHEMA, 3);
  const r = contract.resolveEvidence(dir);
  assert.equal(r.complete, true);
  const outcomes = r.cells.filter((c) => c.kind === "outcome");
  // Three engines x (W1, W3, W4, W6 five cold runs each + six W7 controls + five W2 cold runs + the live application).
  assert.equal(outcomes.length, 96);
  assert.deepEqual(
    outcomes.filter((c) => c.status !== "ok").map((c) => c.id),
    [],
  );
  const results = assemble(dir);
  assert.equal(results.acceptance_scope.desktop_decision.supports, true);
  const strict = validate(dir);
  assert.equal(strict.status, 0, `${strict.stdout}${strict.stderr}`);
  // The operator's mode: the hand-over's certified W2 hashes and one engine's results file.
  const w2Hashes = join(dir, "handoff/fixtures/W2-hashes.json");
  const file = join(dir, "handoff/evidence/device-page/results.webkit.json");
  const healthy = node([
    join(root, "scripts/validate-profile-handoff.mjs"),
    file,
    "--w2-hashes",
    w2Hashes,
  ]);
  assert.equal(healthy.status, 0, `${healthy.stdout}${healthy.stderr}`);
  const contradicted = join(dir, "contradicted.json");
  const data = readJson(file);
  const w1 = data.runs.find((x) => x.workload === "W1" && x.run === 1);
  w1.detail = JSON.stringify({ kind: "running", catchingUp: true });
  writeFileSync(contradicted, JSON.stringify(data));
  const refused = node([
    join(root, "scripts/validate-profile-handoff.mjs"),
    contradicted,
    "--w2-hashes",
    w2Hashes,
  ]);
  assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
  assert.match(
    `${refused.stdout}${refused.stderr}`,
    /recorded admitted, but its end state shows no verdict \(the step ended in running\)/,
  );
});

test("control: valid workloads genuinely refused (a back-off, waiting for a valid cache, a failed step's stop, a back-off after a has_more continuation that kept the served page's commit) resolve ok with outcome refused: findings, not structural faults", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(
    dir,
    "webkit",
    "W4",
    2,
    endWithout({ kind: "backing_off", since: 1 }, "refused"),
  );
  editCold(
    dir,
    "webkit",
    "W4",
    3,
    endWithout({ kind: "waiting", reason: "cache_not_valid" }, "refused"),
  );
  editCold(
    dir,
    "webkit",
    "W4",
    4,
    failedStep({ kind: "stopped", cause: "local_storage" }, "refused"),
  );
  editCold(dir, "webkit", "W4", 5, (run) => {
    // The served page committed (has_more), the continuation's step ended backing off.
    const o = run.observation;
    const commit = o.commits[0];
    const state = { kind: "backing_off", since: 7 };
    o.events = [
      { trace: 1, event: "data.sync_commit", payload: commit },
      {
        trace: 2,
        event: "data.sync_next",
        payload: { when: "now", state: "running" },
      },
      {
        trace: 4,
        event: "data.sync_next",
        payload: { when: "after", state: "backing_off" },
      },
    ];
    o.published[2] = { ...o.published[2], trace: 4, state };
    o.terminal = { index: 2, at: o.published[2].at, trace: 4, state };
    o.step_end = { trace: 4, event: "data.sync_next", recorded: "backing_off" };
    run.outcome = "refused";
    run.detail = JSON.stringify(state);
    run.scan_ms = null;
    run.commit_ms = null;
  });
  const r = contract.resolveEvidence(dir);
  for (const run of [2, 3, 4, 5]) {
    const c = cell(r, P11("webkit", "W4", run));
    assert.equal(c.status, "ok", `${c.id}: ${reasons(c)}`);
    assert.equal(c.outcome, "refused");
  }
});

test("control (DA-1): a has_more schedule of more than 40 publications is retained whole and admitted; nothing is truncated away", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "chromium", "W1", 1, (run) => {
    const o = run.observation;
    const commit = o.commits[0];
    const published = o.published.slice(0, 2);
    const events = [{ trace: 1, event: "data.sync_commit", payload: commit }];
    let trace = 2;
    let at = published[1].at;
    for (let i = 0; i < 25; i += 1) {
      events.push({
        trace,
        event: "data.sync_next",
        payload: { when: "now", state: "running" },
      });
      trace += 2; // the continuation's tick
      at += 3;
      published.push({
        index: published.length,
        generation: 1,
        at,
        trace,
        state: { kind: "running", catchingUp: i % 2 === 0 },
      });
      const small = { bytes: 80, scan_ms: 0, commit_ms: 1, kind: "applied" };
      events.push({ trace, event: "data.sync_commit", payload: small });
      trace += 1;
      at += 3;
      published.push({
        index: published.length,
        generation: 1,
        at,
        trace,
        state: { kind: "running", catchingUp: i % 2 !== 0 },
      });
    }
    const idle = { kind: "idle", lastSyncedAt: "2026-10-13T01:00:00.000Z" };
    published.push({
      index: published.length,
      generation: 1,
      at: at + 3,
      trace,
      state: idle,
    });
    events.push({
      trace,
      event: "data.sync_next",
      payload: { when: "after", state: "idle" },
    });
    o.published = published;
    o.events = events;
    o.terminal = {
      index: published.length - 1,
      at: at + 3,
      trace,
      state: idle,
    };
    o.step_end = { trace, event: "data.sync_next", recorded: "idle" };
    o.commits = events
      .filter((e) => e.event === "data.sync_commit")
      .map((e) => e.payload);
    run.detail = JSON.stringify(idle);
    assert.ok(published.length > 40);
  });
  const c = cell(contract.resolveEvidence(dir), P11("chromium", "W1", 1));
  assert.equal(c.status, "ok", reasons(c));
  assert.equal(c.outcome, "admitted");
});

// ---- review 9 (preserved) -----------------------------------------------------------------------------------------------------------

test("case: review 9's Air record (refused over a running state, no observation) is invalid in P-11 and P-W2, and the strict validator refuses the hand-over", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const airRecord = (run) => {
    run.outcome = "refused";
    run.detail = JSON.stringify({ kind: "running", catchingUp: true });
    delete run.observation;
  };
  editCold(dir, "webkit", "W4", 2, airRecord);
  editCold(dir, "webkit", "W2", 5, airRecord);
  const r = contract.resolveEvidence(dir);
  for (const id of [P11("webkit", "W4", 2), W2_5]) {
    const c = cell(r, id);
    assert.equal(c.status, "invalid", id);
    assert.match(
      reasons(c),
      /a refused run without the observation it was classified from/,
    );
  }
  assert.equal(r.complete, false);
  refusedEndToEnd(dir);
});

test("case: a refusal whose step ended while running was the last state published is invalid: running is not a verdict on the page", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 2, (run) => {
    const o = run.observation;
    const running = o.published[1].state;
    o.published = o.published.slice(0, 2);
    o.events = [
      {
        trace: 1,
        event: "data.sync_next",
        payload: { when: "event", state: "stopped" },
      },
    ];
    o.terminal = { ...o.published[1], index: 1 };
    delete o.terminal.generation;
    o.step_end = { trace: 1, event: "data.sync_next", recorded: "stopped" };
    o.commits = [];
    run.outcome = "refused";
    run.detail = JSON.stringify(running);
    run.scan_ms = null;
    run.commit_ms = null;
  });
  const c = cell(contract.resolveEvidence(dir), P11("webkit", "W4", 2));
  assert.equal(c.status, "invalid");
  assert.match(
    reasons(c),
    /no state was published after the request before its end \(the terminal is the request itself\)/,
  );
  assert.match(
    reasons(c),
    /recorded refused, but the observation shows no verdict \(running\)/,
  );
});

test("case: a startup waiting state claimed as the terminal (before the request) is not a refusal", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 2, (run) => {
    const o = run.observation;
    const state = o.published[0].state;
    o.terminal = { index: 0, at: o.published[0].at, trace: 0, state };
    run.outcome = "refused";
    run.detail = JSON.stringify(state);
    run.scan_ms = null;
    run.commit_ms = null;
  });
  const c = cell(contract.resolveEvidence(dir), P11("webkit", "W4", 2));
  assert.equal(c.status, "invalid");
  assert.match(reasons(c), /the recorded terminal state is not the step end's/);
  assert.match(
    reasons(c),
    /recorded refused, but the observation shows admitted/,
  );
});

test("case: an outcome its observation does not show, or a detail that is not the observed state, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 2, (run) => {
    run.outcome = "refused";
  });
  editCold(dir, "webkit", "W4", 3, (run) => {
    run.detail = JSON.stringify({ kind: "running", catchingUp: false });
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 2))),
    /recorded refused, but the observation shows admitted/,
  );
  const c3 = cell(r, P11("webkit", "W4", 3));
  assert.equal(c3.status, "invalid");
  assert.match(reasons(c3), /the detail is not the observed terminal state/);
});

test("case: a step end that records another state than the one published is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 2, (run) => {
    const o = run.observation;
    o.events.at(-1).payload.state = "backing_off";
    o.step_end.recorded = "backing_off";
  });
  const c = cell(contract.resolveEvidence(dir), P11("webkit", "W4", 2));
  assert.equal(c.status, "invalid");
  assert.match(
    reasons(c),
    /the step's end records backing_off, but idle was published/,
  );
});

test("case: admitted without the served page's applied commit, with another page's bytes, with figures that are not that commit's, or with no request, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(
    dir,
    "webkit",
    "W4",
    1,
    editFirstCommit((c) => {
      c.kind = "dropped";
    }),
  );
  editCold(
    dir,
    "webkit",
    "W4",
    2,
    editFirstCommit((c) => {
      c.bytes += 1;
    }),
  );
  editCold(dir, "webkit", "W4", 3, (run) => {
    // The old helper's `.at(-1)`: the figures of a later commit, not the measured page's.
    run.scan_ms += 1;
  });
  editCold(dir, "webkit", "W4", 4, (run) => {
    run.requests = 0;
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 1))),
    /idle without the served page's applied commit/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 2))),
    /the first commit after the request is \d+ bytes, not the served \d+/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 3))),
    /scan_ms .* is not the served page's commit/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 4))),
    /no \/sync request reached the stub/,
  );
  assert.equal(
    cell(r, P11("webkit", "W4", 5)).status,
    "ok",
    "the other runs are not affected",
  );
});

test("case: a step that ended waiting for the session is not a verdict on the page", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(
    dir,
    "webkit",
    "W4",
    2,
    endWithout({ kind: "waiting", reason: "paused_by_session" }, "refused"),
  );
  const c = cell(contract.resolveEvidence(dir), P11("webkit", "W4", 2));
  assert.equal(c.status, "invalid");
  assert.match(
    reasons(c),
    /the step ended waiting \(paused_by_session\): not a verdict on the page/,
  );
});

// ---- review 10 (DA-1): cold corroboration, P-11 and W2 alike --------------------------------------------------------------------------

for (const [label, engine, workload, run, id] of [
  ["P-11", "webkit", "W4", 2, P11("webkit", "W4", 2)],
  ["P-W2", "webkit", "W2", 5, W2_5],
])
  test(`case (review 10, ${label}): the served-byte identity is required: deleting the first commit's bytes (from both representations, or only the summary) is invalid`, (t) => {
    const dir = scratch(t);
    writeComplete(dir);
    editCold(
      dir,
      engine,
      workload,
      run,
      editFirstCommit((c) => {
        delete c.bytes;
      }),
    );
    editCold(dir, engine, workload, run - 1, (r) => {
      delete r.observation.commits[0].bytes;
    });
    const r = contract.resolveEvidence(dir);
    const c = cell(r, id);
    assert.equal(c.status, "invalid");
    assert.match(
      reasons(c),
      /the first commit after the request does not record its bytes/,
    );
    const summary = cell(
      r,
      id.replace(`cold run ${run}`, `cold run ${run - 1}`),
    );
    assert.equal(summary.status, "invalid");
    assert.match(
      reasons(summary),
      /the recorded commits are not the request step's commits/,
    );
    assert.doesNotMatch(reasons(c), DUPLICATE);
    assert.equal(r.complete, false);
  });

test("case (review 10): the request and terminal cannot be one entry, nor the terminal and step end precede the request (summary or coherent witness)", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  // Review 10's equal-index record: terminal index = request index, the states as recorded.
  editCold(dir, "webkit", "W4", 1, (run) => {
    run.observation.terminal.index = run.observation.request.index;
  });
  // Review 10's reversed record: terminal time before the request's, the step end's trace before the request's.
  editCold(dir, "webkit", "W4", 2, (run) => {
    const o = run.observation;
    o.terminal.at = o.request.at - 1;
    o.step_end.trace = o.request.trace - 1;
  });
  // The terminal's state alone replaced by the request's running (its index, time and position kept).
  editCold(dir, "webkit", "W4", 4, (run) => {
    run.observation.terminal.state = run.observation.published[1].state;
  });
  // The same reversal written coherently into the retained publications.
  editCold(dir, "webkit", "W4", 3, (run) => {
    const o = run.observation;
    o.published[2].at = o.published[1].at - 1;
    o.terminal.at = o.published[2].at;
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 1))),
    /the recorded terminal state is not the step end's/,
  );
  const reversed = reasons(cell(r, P11("webkit", "W4", 2)));
  assert.match(reversed, /the recorded step end is not the request step's end/);
  assert.match(reversed, /the recorded terminal state is not the step end's/);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 4))),
    /the recorded terminal state is not the step end's/,
  );
  const coherent = reasons(cell(r, P11("webkit", "W4", 3)));
  assert.match(coherent, /published state 2 is out of order/);
  assert.match(coherent, /the terminal state was published before the request/);
});

test("case (review 10): a failed step paired with an idle admission is invalid, whether only its summary or its whole witness says so", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 1, (run) => {
    run.observation.step_end.event = "data.sync_step_failed";
    run.observation.step_end.recorded = null;
  });
  editCold(
    dir,
    "webkit",
    "W4",
    2,
    failedStep({ kind: "idle", lastSyncedAt: "x" }, "admitted"),
  );
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 1))),
    /the recorded step end is not the request step's end/,
  );
  const coherent = cell(r, P11("webkit", "W4", 2));
  assert.equal(coherent.status, "invalid");
  assert.match(
    reasons(coherent),
    /a failed step ends in stopped\/local_storage, not idle/,
  );
});

test("case (DA-1): an idle published before the served page's commit, an unknown or out-of-order event, or truncated publications are invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 1, (run) => {
    const o = run.observation;
    o.published[2].trace = 1;
    o.terminal.trace = 1;
  });
  editCold(dir, "webkit", "W4", 2, (run) => {
    run.observation.events.unshift({
      trace: 0,
      event: "data.sync_tick",
      payload: {},
    });
  });
  editCold(dir, "webkit", "W4", 3, (run) => {
    run.observation.published = run.observation.published.slice(0, 2);
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 1))),
    /the idle state was published before the served page's commit/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 2))),
    /step event 0 is malformed or unknown/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 3))),
    /no state was published after the request before its end/,
  );
});

test("case (DA-1, invariant 1): a second engine start, another page instance, a foreign generation or a revision-9 observation is no verdict", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "webkit", "W4", 1, (run) => {
    run.observation.epochs.push({ generation: 2, run: 1, trace: 1 });
  });
  editCold(dir, "webkit", "W4", 2, (run) => {
    run.observation.mark.page = "another-page";
  });
  editCold(dir, "webkit", "W4", 3, (run) => {
    run.observation.published[0].generation = 7;
  });
  editCold(dir, "webkit", "W4", 4, (run) => {
    run.observation.method = "engine-state-log/1";
  });
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 1))),
    /the engine was started 2 times since the mark/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 2))),
    /another page instance than its mark \(a reload\)/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 3))),
    /published state 0 belongs to engine generation 7, not the observed 1/,
  );
  assert.match(
    reasons(cell(r, P11("webkit", "W4", 4))),
    /observation method engine-state-log\/1 is not engine-state-log\/2/,
  );
});

test("case (DA-1, invariant 4): served bytes are bound to the recorded workload and the captured W2 file, never the row's own figure", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  // Two matching invented numbers: the row's bytes and every run's commit moved together.
  editJson(join(dir, "memory/P-11.webkit.json"), (file) => {
    const row = file.rows.find((r) => r.workload === "W3");
    row.bytes += 10;
    for (const run of row.runs) editFirstCommit((c) => (c.bytes += 10))(run);
  });
  editJson(join(dir, "w2/P-W2.chromium.json"), (file) => {
    const row = file.rows[0];
    row.bytes += 10;
    for (const run of row.runs) editFirstCommit((c) => (c.bytes += 10))(run);
  });
  const r = contract.resolveEvidence(dir);
  const w3 = hashes.workloads.find((w) => w.name === "W3").bytes;
  const p11 = reasons(cell(r, P11("webkit", "W3", 1)));
  assert.match(
    p11,
    new RegExp(
      `the row records ${w3 + 10} served bytes; the recorded W3 is ${w3}`,
    ),
  );
  assert.match(
    p11,
    new RegExp(
      `the first commit after the request is ${w3 + 10} bytes, not the served ${w3}`,
    ),
  );
  const w2 = reasons(cell(r, "P-W2 W2 cold run 1[chromium]"));
  assert.match(
    w2,
    /served bytes; the recorded limit-1 capture \(certified against its file by the capture cell\) is \d+/,
  );
  assert.match(w2, /bytes, not the served \d+/);
});

// ---- review 10 (DA-2): the live application ---------------------------------------------------------------------------------------------

test("case (review 10): review 9's live records (no observation, or a running state) are invalid with both copies kept equal", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editLive(dir, "chromium", (live) => {
    live.observation.state_entry.state = { kind: "running", catchingUp: false };
  });
  editLive(dir, "webkit", (live) => {
    delete live.observation;
  });
  const r = contract.resolveEvidence(dir);
  const c = cell(r, LIVE("chromium"));
  assert.equal(c.status, "invalid", reasons(c));
  assert.match(reasons(c), /no verdict \(running\)/);
  assert.match(
    reasons(c),
    /recorded admitted, but the observation shows no verdict \(running\)/,
  );
  assert.doesNotMatch(reasons(c), DUPLICATE);
  const w = cell(r, LIVE("webkit"));
  assert.match(reasons(w), /without the observation it was classified from/);
  assert.doesNotMatch(reasons(w), DUPLICATE);
});

test("case (review 10): an invented live dense commit (zero bytes; 999,999,999 bytes and 999 ms absent from the retained trace) is invalid; the assembled hand-over withholds support and both validator modes refuse it", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editLive(dir, "chromium", (live) => {
    live.observation.dense.commit = { kind: "applied", bytes: 0 };
  });
  editLive(dir, "webkit", (live) => {
    live.observation.dense.commit = {
      kind: "applied",
      bytes: 999_999_999,
      scan_ms: 999,
      commit_ms: 999,
    };
  });
  const r = contract.resolveEvidence(dir);
  const zero = reasons(cell(r, LIVE("chromium")));
  assert.match(
    zero,
    /the dense commit is 0 bytes, below 90% of the captured \d+/,
  );
  assert.match(
    zero,
    /the dense commit is not the retained trace's commit at its position/,
  );
  const invented = cell(r, LIVE("webkit"));
  assert.equal(invented.status, "invalid");
  assert.match(
    reasons(invented),
    /the dense commit is not the retained trace's commit at its position/,
  );
  for (const e of ["chromium", "webkit"])
    assert.doesNotMatch(reasons(cell(r, LIVE(e))), DUPLICATE);
  refusedEndToEnd(dir);
});

test("case and control (DA-2): density is judged against the verified capture: one byte below 90% is invalid; exactly 90% is admitted", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  for (const [engine, delta] of [
    ["chromium", -1],
    ["firefox", 0],
  ]) {
    const bytes = Math.ceil(0.9 * captureBytes(dir, engine)) + delta;
    editTrace(dir, engine, (lines) => {
      const at = lines[3].indexOf("{");
      const commit = JSON.parse(lines[3].slice(at));
      commit.bytes = bytes;
      lines[3] = `${lines[3].slice(0, at)}${JSON.stringify(commit)}`;
      return lines;
    });
    editLive(dir, engine, (live) => {
      live.observation.dense.commit.bytes = bytes;
      live.commits[1].bytes = bytes;
    });
  }
  const r = contract.resolveEvidence(dir);
  const below = cell(r, LIVE("chromium"));
  assert.equal(below.status, "invalid");
  assert.match(reasons(below), /below 90% of the captured \d+/);
  const exact = cell(r, LIVE("firefox"));
  assert.equal(exact.status, "ok", reasons(exact));
  assert.equal(exact.outcome, "admitted");
});

test("case (DA-2): a dense commit outside the epoch, an idle published before it, a missing live trace, or commits that are not the trace's are invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editLive(dir, "chromium", (live) => {
    live.observation.epochs[0].trace = 4;
  });
  editLive(dir, "firefox", (live) => {
    live.observation.state_entry.trace = 3;
  });
  rmSync(tracePath(dir, "webkit"));
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, LIVE("chromium"))),
    /the dense commit lies outside the observation's epoch and boundary/,
  );
  assert.match(
    reasons(cell(r, LIVE("firefox"))),
    /the idle state was not published after the dense commit/,
  );
  assert.match(
    reasons(cell(r, LIVE("webkit"))),
    /the live engine trace is not retained/,
  );
  const dir2 = `${dir}-2`;
  writeComplete(dir2);
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  editLive(dir2, "chromium", (live) => {
    live.commits = [live.commits[1]];
  });
  editLive(dir2, "webkit", (live) => {
    live.observation.method = "live-dense-commit/1";
  });
  const r2 = contract.resolveEvidence(dir2);
  assert.match(
    reasons(cell(r2, LIVE("chromium"))),
    /the recorded commits are not the retained live trace's/,
  );
  assert.match(
    reasons(cell(r2, LIVE("webkit"))),
    /observation method live-dense-commit\/1 is not live-dense-commit\/2/,
  );
});

test("case (DA-2): the cited dense commit must be the epoch's FIRST of at least 90% of the capture: an earlier qualifying commit refuses it", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const bytes = Math.ceil(0.9 * captureBytes(dir, "chromium"));
  editTrace(dir, "chromium", (lines) => {
    const at = lines[1].indexOf("{");
    const commit = JSON.parse(lines[1].slice(at));
    commit.bytes = bytes;
    lines[1] = `${lines[1].slice(0, at)}${JSON.stringify(commit)}`;
    return lines;
  });
  editLive(dir, "chromium", (live) => {
    live.commits[0].bytes = bytes;
  });
  const c = cell(contract.resolveEvidence(dir), LIVE("chromium"));
  assert.equal(c.status, "invalid");
  assert.match(
    reasons(c),
    /an earlier commit of the epoch already met the density: the observed commit is not the first dense one/,
  );
  assert.doesNotMatch(reasons(c), DUPLICATE);
});

test("case (DA-4): the W2 capture row's live copy must equal the file's (an additional guard beside the semantic rules)", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editJson(join(dir, "w2/P-W2.firefox.json"), (file) => {
    file.live.elapsed_ms += 1;
  });
  const c = cell(contract.resolveEvidence(dir), LIVE("firefox"));
  assert.equal(c.status, "invalid");
  assert.match(
    reasons(c),
    /the capture row's live application is not the file's/,
  );
});

test("control (DA-2): a genuine live stop without a dense commit is a refused application (a finding), not an invalid record", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editTrace(dir, "webkit", (lines) => [
    lines[0],
    lines[1],
    `4ms data.sync_next ${JSON.stringify({ when: "event", state: "stopped" })}`,
  ]);
  editLive(dir, "webkit", (live) => {
    live.outcome = "refused";
    live.commits = [live.commits[0]];
    live.observation.boundary = 3;
    live.observation.dense = null;
    live.observation.state_entry = {
      ...live.observation.state_entry,
      trace: 2,
      state: { kind: "stopped", cause: "storage_full" },
    };
  });
  const c = cell(contract.resolveEvidence(dir), LIVE("webkit"));
  assert.equal(c.status, "ok", reasons(c));
  assert.equal(c.outcome, "refused");
});

// ---- DA-3: device engine outcomes -----------------------------------------------------------------------------------------------------

/** The webkit device results and their checker, against that package's own W2 capture (the hand-over's deviceCheck inputs). */
const deviceFile = (dir, engine = "webkit") =>
  join(dir, `device-page/results.${engine}.json`);
const checkDevice = (dir, data, engine = "webkit") => {
  const h = createHash("sha256")
    .update(readFileSync(join(dir, `w2/W2-captured.${engine}.limit-1.json`)))
    .digest("hex");
  return device.checkDeviceResults(data, {
    recorded: hashes,
    w2Hashes: new Set([h]),
    w2Expected: h,
  });
};
const runOf = (data, workload, run = 1) =>
  data.runs.find((x) => x.workload === workload && x.run === run);

test("case (DA-3): device engine runs whose end state, first commit or figures contradict their outcome are malformed; legitimate refusals, errors, W5 and killed formats stay valid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const healthy = readJson(deviceFile(dir));
  const control = checkDevice(dir, healthy);
  assert.deepEqual(control.errors, []);
  const errorsOf = (change) => {
    const data = structuredClone(healthy);
    change(data);
    return checkDevice(dir, data).errors;
  };
  const one = (change, pattern) => {
    const errors = errorsOf(change);
    assert.equal(errors.length, 1, errors.join(" | "));
    assert.match(errors[0], pattern);
  };
  one((d) => {
    runOf(d, "W1").detail = JSON.stringify({
      kind: "running",
      catchingUp: true,
    });
  }, /recorded admitted, but its end state shows no verdict \(the step ended in running\)/);
  const w7 = healthy.runs.find((x) => x.workload.startsWith("W7-")).workload;
  one((d) => {
    runOf(d, w7).detail = JSON.stringify({ kind: "idle" });
  }, /recorded refused, but its end state shows admitted/);
  one((d) => {
    runOf(d, w7).detail = JSON.stringify({
      kind: "waiting",
      reason: "paused_by_session",
    });
  }, /recorded refused, but its end state shows no verdict \(the step ended waiting \(paused_by_session\)/);
  one((d) => {
    runOf(d, "W1").first_commit = null;
  }, /an admitted engine run without the served body's applied commit/);
  one((d) => {
    runOf(d, "W2").first_commit.bytes += 1;
  }, /the first commit is \d+ bytes, not the served \d+/);
  one((d) => {
    runOf(d, "W3").scan_ms += 1;
    // The run's figure moved alone: not the first commit's.
  }, /scan_ms is not the served body's commit's/);
  one((d) => {
    delete runOf(d, "W4").first_commit;
  }, /first_commit is neither a commit nor an explicit null/);
  one((d) => {
    runOf(d, "W5-limit-1").first_commit = { kind: "applied", bytes: 1 };
  }, /W5 is the processing path only: no commit/);
  one((d) => {
    runOf(d, "W1").detail = "synthetic text";
  }, /an admitted engine run's detail is not the state it ended in/);
  // Legitimate: a refusal waiting for a valid cache; an error and a time-out with their own text; a killed attempt with nothing.
  assert.deepEqual(
    errorsOf((d) => {
      runOf(d, w7).detail = JSON.stringify({
        kind: "waiting",
        reason: "cache_not_valid",
      });
      Object.assign(runOf(d, "W6", 2), {
        outcome: "error",
        detail: "the run threw: synthetic",
        first_commit: null,
      });
      Object.assign(runOf(d, "W6", 3), {
        outcome: "timeout",
        detail: "",
        first_commit: null,
      });
      Object.assign(runOf(d, "W6", 4), {
        outcome: "killed",
        detail: "the page reloaded before the run finished; reserved at x",
        sha256_verified: false,
        bytes: 0,
        elapsed_ms: 0,
        scan_ms: null,
        commit_ms: null,
        request_count: 0,
        limit: null,
        changes_written: null,
        cursor_after: null,
        heap_peak_bytes: null,
        heap_after_bytes: null,
        heap_baseline_bytes: null,
        first_commit: null,
      });
    }),
    [],
  );
  // A schema-2 file is history, never read as current evidence.
  const old = errorsOf((d) => {
    d.schema = 2;
  });
  assert.match(
    old.join(" | "),
    /schema must be 3 \(schema 2 is a historical record/,
  );
});

test("case (DA-3): one contradicted device engine outcome in the package makes its device cells invalid, withholds support and is refused by both validator modes", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const file = deviceFile(dir);
  const data = readJson(file);
  const w7 = data.runs.find((x) => x.workload.startsWith("W7-"));
  w7.detail = JSON.stringify({ kind: "idle" });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(file, text);
  // The binder names the file by its hash: kept current, so only the outcome is in question.
  const rows = valueRows(dir);
  const binder = rows.filter(
    (r) => r.name === "P-11 device page" && r.engine === "webkit",
  );
  assert.equal(binder.length, 1);
  binder[0].results_sha256 = createHash("sha256").update(text).digest("hex");
  writeValueRows(dir, rows);
  const r = contract.resolveEvidence(dir);
  const invalid = r.cells.filter(
    (c) => c.engine === "webkit" && c.status === "invalid",
  );
  assert.ok(invalid.length > 0);
  assert.ok(
    invalid.some((c) =>
      /recorded refused, but its end state shows admitted/.test(reasons(c)),
    ),
  );
  assert.ok(
    invalid.every(
      (c) =>
        !/the results file is not the one its run recorded/.test(reasons(c)),
    ),
  );
  assert.equal(r.complete, false);
  refusedEndToEnd(dir);
});

// ---- versions -----------------------------------------------------------------------------------------------------------------------

test("case: stages recorded under contract versions 3 (review 9's Air request) and 4 (revision 9) are not evidence of version 5", (t) => {
  for (const version of [3, 4]) {
    const dir = `${scratch(t)}-${version}`;
    writeComplete(dir);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    editJson(join(dir, "stages/fixture.json"), (v) => {
      v.contract_version = version;
    });
    const r = contract.resolveEvidence(dir);
    assert.equal(r.complete, false);
    assert.ok(
      r.cells.some((c) =>
        c.reasons
          .join(" ")
          .includes(`recorded under contract ${version}, not 5`),
      ),
    );
  }
});

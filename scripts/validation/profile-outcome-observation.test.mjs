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
//
// Revision 11 (review 11's R2 follow-up; design assessment DA-L1/DA-H1, Q3; contract version 6): the live witness
// (`live-dense-commit/3`) retains its publications and step-event lines, and its terminal state must be the one the completing step end
// rests on. The live cases below carry review 11's three contradictions, absent/outside-boundary ends, failed-stop ordering, has_more and
// back-off success, genuine refusals, an intact historical prefix and the trace's page binding through the contract, the assembler and
// both validator modes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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
const payloadOf = (line) => JSON.parse(line.slice(line.indexOf("{")));
/**
 * Replaces the live trace's line `at` in every representation of that one raw line: the trace file, the witness's retained line and
 * (when it is the completing end) the step-end claim; `claim` is written by the case. Both live copies are kept equal.
 */
const editLiveLine = (dir, engine, at, line, claim) => {
  editTrace(dir, engine, (lines) => {
    lines[at] = line;
    return lines;
  });
  editLive(dir, engine, (live) => {
    for (const e of live.observation.events) if (e.trace === at) e.line = line;
    if (claim) live.observation.step_end = claim;
    live.commits = readFileSync(tracePath(dir, engine), "utf8")
      .split("\n")
      .filter((l) => l.includes("data.sync_commit"))
      .map(payloadOf);
  });
};
/**
 * Revision 11 (DA-H1): writes engine `engine`'s live application as the fixture harness records the schedule `ops`, written by the case
 * from the production engine's order: `["publish", state]` (an identical state is not published again, as `setState` does), `[event,
 * payload]` a trace line, `["failed"]` a failed step's line. Every publication carries the trace length at its time; the witness retains
 * them all and every commit/step-end line. The claims (`dense`, the completing `end` line, the publication `entry` it rests on) and the
 * outcome are given by the case, never derived here.
 */
const writeLive = (dir, engine, ops, { outcome, dense, end, entry }) => {
  const lines = [];
  const published = [];
  let current = null;
  for (const [op, value] of ops) {
    if (op === "publish") {
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      current = value;
      published.push({
        index: published.length,
        generation: 1,
        at: 700 + 10 * published.length,
        trace: lines.length,
        state: value,
      });
    } else if (op === "failed")
      lines.push(`${lines.length + 1}ms data.sync_step_failed `);
    else lines.push(`${lines.length + 1}ms ${op} ${JSON.stringify(value)}`);
  }
  writeFileSync(tracePath(dir, engine), lines.join("\n"));
  const events = lines
    .map((line, trace) => ({ trace, line }))
    .filter((e) => /^\d+ms data\.sync_(commit|next|step_failed) /.test(e.line));
  const endEvent = lines[end].split(" ")[1];
  editLive(dir, engine, (live) => {
    const page = live.observation.page;
    live.outcome = outcome;
    live.commits = lines
      .filter((l) => l.includes("data.sync_commit"))
      .map(payloadOf);
    live.trace_page = page;
    live.observation = {
      ...live.observation,
      boundary: lines.length,
      published,
      events,
      dense:
        dense === null
          ? null
          : { trace: dense, commit: payloadOf(lines[dense]) },
      step_end: {
        trace: end,
        event: endEvent,
        recorded:
          endEvent === "data.sync_next" ? payloadOf(lines[end]).state : null,
      },
      state_entry: published[entry],
    };
  });
};
const TICK = (why) => ["data.sync_tick", { why, coalesced: false }];
const NEXT = (when, state) => ["data.sync_next", { when, state }];
const COMMIT = (bytes, extra = {}) => [
  "data.sync_commit",
  {
    bytes,
    scan_ms: 3,
    commit_ms: 9,
    kind: "applied",
    value: "committed",
    ...extra,
  },
];
const RUNNING = ["publish", { kind: "running", catchingUp: true }];
const START = ["publish", { kind: "waiting", reason: "cache_not_valid" }];
const IDLE = [
  "publish",
  { kind: "idle", lastSyncedAt: "2026-10-13T01:00:00.000Z" },
];
/** No problem of the trace binding or the page instance fired (an isolating case's failure is the semantic rule's). */
const BINDING =
  /not the page's trace lines at their positions|was not retained|not read from the observation's page instance/;

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

test("control: the complete synthetic programme's every outcome cell is ok under contract version 15; assembled, it supports the desktop decision and passes the strict validator and the standalone device-results mode; one contradicted device file is refused there", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  assert.equal(evidence.CONTRACT_VERSION, 15);
  assert.equal(device.DEVICE_SCHEMA, 4);
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
    /observation method engine-state-log\/1 is not engine-state-log\/3/,
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
  // Revision 11: the running state written consistently (the step's end records it, the witness rests on it).
  const running = { kind: "running", catchingUp: false };
  editLiveLine(
    dir,
    "chromium",
    5,
    `6ms data.sync_next ${JSON.stringify({ when: "now", state: "running" })}`,
    { trace: 5, event: "data.sync_next", recorded: "running" },
  );
  editLive(dir, "chromium", (live) => {
    live.observation.published[2].state = running;
    live.observation.state_entry.state = running;
  });
  editLive(dir, "webkit", (live) => {
    delete live.observation;
  });
  const r = contract.resolveEvidence(dir);
  const c = cell(r, LIVE("chromium"));
  assert.equal(c.status, "invalid", reasons(c));
  assert.match(reasons(c), /no step end inside the observation ends it/);
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
    const line = readFileSync(tracePath(dir, engine), "utf8").split("\n")[4];
    const commit = { ...payloadOf(line), bytes };
    editLiveLine(
      dir,
      engine,
      4,
      `${line.slice(0, line.indexOf("{"))}${JSON.stringify(commit)}`,
    );
    editLive(dir, engine, (live) => {
      live.observation.dense.commit.bytes = bytes;
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
  // Revision 11: the epoch moved after the dense commit's line (4), so the cited commit precedes it.
  editLive(dir, "chromium", (live) => {
    live.observation.epochs[0].trace = 5;
  });
  // Revision 11: the idle publication moved to the dense commit's position, in the slice and the claim alike.
  editLive(dir, "firefox", (live) => {
    live.observation.published[2].trace = 4;
    live.observation.state_entry.trace = 4;
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
    /observation method live-dense-commit\/1 is not live-dense-commit\/3/,
  );
});

test("case (DA-2): the cited dense commit must be the epoch's FIRST of at least 90% of the capture: an earlier qualifying commit refuses it", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const bytes = Math.ceil(0.9 * captureBytes(dir, "chromium"));
  const line = readFileSync(tracePath(dir, "chromium"), "utf8").split("\n")[1];
  editLiveLine(
    dir,
    "chromium",
    1,
    `${line.slice(0, line.indexOf("{"))}${JSON.stringify({ ...payloadOf(line), bytes })}`,
  );
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
  // Revision 11: written with its step end (a small page with has_more, then a step that stopped).
  writeLive(
    dir,
    "webkit",
    [
      START,
      TICK("start"),
      RUNNING,
      COMMIT(8_035),
      NEXT("now", "running"),
      TICK("now"),
      ["publish", { kind: "stopped", cause: "storage_full" }],
      NEXT("event", "stopped"),
    ],
    { outcome: "refused", dense: null, end: 4, entry: 2 },
  );
  const c = cell(contract.resolveEvidence(dir), LIVE("webkit"));
  assert.equal(c.status, "ok", reasons(c));
  assert.equal(c.outcome, "refused");
});

// ---- review 11: the live terminal state and its step end (revision 11, DA-L1, M1-M9) ---------------------------------------------------

/** The healthy synthetic live trace's completing end (line 5: `data.sync_next` idle, resting on the idle published at trace 5). */
const END = 5;
const endLine = (dir, engine) =>
  readFileSync(tracePath(dir, engine), "utf8").split("\n")[END];
const stamp = (dir, engine) => endLine(dir, engine).split(" ")[0];

test("case (review 11, M2): a stopped, failed-step or running end beside the idle witness, its commits unchanged and every representation of that trace line edited alike, is invalid by the terminal relation; the hand-over withholds support and both validator modes exit 1", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editLiveLine(
    dir,
    "chromium",
    END,
    `${stamp(dir, "chromium")} data.sync_next ${JSON.stringify({ when: "event", state: "stopped" })}`,
    { trace: END, event: "data.sync_next", recorded: "stopped" },
  );
  editLiveLine(
    dir,
    "firefox",
    END,
    `${stamp(dir, "firefox")} data.sync_step_failed `,
    { trace: END, event: "data.sync_step_failed", recorded: null },
  );
  editLiveLine(
    dir,
    "webkit",
    END,
    `${stamp(dir, "webkit")} data.sync_next ${JSON.stringify({ when: "now", state: "running" })}`,
    { trace: END, event: "data.sync_next", recorded: "running" },
  );
  const r = contract.resolveEvidence(dir);
  assert.equal(r.complete, false);
  const expected = {
    chromium: /the step end at trace 5 records stopped, but idle was published/,
    firefox: /the failed step's stop is not retained inside the observation/,
    webkit: /the step end at trace 5 records running, but idle was published/,
  };
  for (const [engine, reason] of Object.entries(expected)) {
    const c = cell(r, LIVE(engine));
    assert.equal(c.status, "invalid", `${engine}: ${reasons(c)}`);
    assert.match(reasons(c), reason);
    assert.match(
      reasons(c),
      /recorded admitted, but the observation shows no verdict \(idle\)/,
    );
    assert.doesNotMatch(reasons(c), DUPLICATE);
    assert.doesNotMatch(reasons(c), BINDING);
  }
  refusedEndToEnd(dir);
});

test("case (review 11, original form): only the trace file's end line replaced (stopped, failed-step, running), the witness unchanged, is invalid by the trace binding and refused end to end", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const lines = {
    chromium: (s) =>
      `${s} data.sync_next ${JSON.stringify({ when: "event", state: "stopped" })}`,
    firefox: (s) => `${s} data.sync_step_failed `,
    webkit: (s) =>
      `${s} data.sync_next ${JSON.stringify({ when: "now", state: "running" })}`,
  };
  for (const [engine, line] of Object.entries(lines)) {
    const s = stamp(dir, engine);
    editTrace(dir, engine, (all) => {
      all[END] = line(s);
      return all;
    });
  }
  const r = contract.resolveEvidence(dir);
  for (const engine of Object.keys(lines)) {
    const c = cell(r, LIVE(engine));
    assert.equal(c.status, "invalid", `${engine}: ${reasons(c)}`);
    assert.match(
      reasons(c),
      /the retained step events are not the page's trace lines at their positions/,
    );
    assert.doesNotMatch(reasons(c), DUPLICATE);
  }
  refusedEndToEnd(dir);
});

test("case (M3): an end absent from the witness, a malformed end, or one outside the boundary is invalid, and a matching idle end after the boundary does not repair it", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  // Absent from the witness (the trace keeps it).
  editLive(dir, "chromium", (live) => {
    live.observation.events = live.observation.events.filter(
      (e) => e.trace !== END,
    );
  });
  // Malformed (no payload) in every representation.
  editLiveLine(dir, "firefox", END, `${stamp(dir, "firefox")} data.sync_next `);
  // The witness's boundary drawn before its end; the idle end then lies only in the suffix of the trace.
  editLive(dir, "webkit", (live) => {
    live.observation.boundary = END;
    live.observation.events = live.observation.events.filter(
      (e) => e.trace !== END,
    );
  });
  const r = contract.resolveEvidence(dir);
  const absent = reasons(cell(r, LIVE("chromium")));
  assert.match(
    absent,
    /the trace's step event at 5, inside the observation, was not retained/,
  );
  assert.match(absent, /no step end inside the observation ends it/);
  assert.match(
    reasons(cell(r, LIVE("firefox"))),
    /step event 3 is malformed or unknown/,
  );
  const suffix = cell(r, LIVE("webkit"));
  assert.equal(suffix.status, "invalid");
  assert.match(reasons(suffix), /no step end inside the observation ends it/);
  assert.doesNotMatch(reasons(suffix), BINDING);
  for (const e of ["chromium", "firefox", "webkit"])
    assert.doesNotMatch(reasons(cell(r, LIVE(e))), DUPLICATE);
  refusedEndToEnd(dir);
});

test("control (M4, M5): several has_more continuations, and a back-off retried to the dense page, are admitted with the first dense commit; the programme stays complete, supports the desktop decision and passes both validator modes", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const dense = captureBytes(dir, "chromium");
  writeLive(
    dir,
    "chromium",
    [
      START,
      TICK("start"),
      RUNNING,
      COMMIT(8_035),
      NEXT("now", "running"),
      TICK("now"),
      COMMIT(dense),
      NEXT("now", "running"),
      TICK("now"),
      COMMIT(dense),
      NEXT("now", "running"),
      TICK("now"),
      COMMIT(512),
      IDLE,
      NEXT("after", "idle"),
    ],
    { outcome: "admitted", dense: 4, end: 11, entry: 2 },
  );
  writeLive(
    dir,
    "firefox",
    [
      START,
      TICK("start"),
      RUNNING,
      ["publish", { kind: "backing_off", since: 5 }],
      NEXT("after", "backing_off"),
      TICK("timer"),
      RUNNING,
      COMMIT(captureBytes(dir, "firefox")),
      IDLE,
      NEXT("after", "idle"),
    ],
    { outcome: "admitted", dense: 3, end: 4, entry: 4 },
  );
  const r = contract.resolveEvidence(dir);
  for (const engine of ["chromium", "firefox"]) {
    const c = cell(r, LIVE(engine));
    assert.equal(c.status, "ok", `${engine}: ${reasons(c)}`);
    assert.equal(c.outcome, "admitted");
  }
  assert.equal(r.complete, true);
  const results = assemble(dir);
  assert.equal(results.acceptance_scope.desktop_decision.supports, true);
  for (const extra of [[], ["--allow-partial"]]) {
    const v = validate(dir, ...extra);
    assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  }
});

test("control (M6): genuine live refusals (a normal stopped end without a dense commit, a failed step's local_storage stop, a stop after a dense has_more continuation) resolve ok refused: a valid record of a failure that withholds desktop support, not invalid evidence", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  writeLive(
    dir,
    "chromium",
    [
      START,
      TICK("start"),
      RUNNING,
      ["publish", { kind: "stopped", cause: "device_capacity" }],
      NEXT("event", "stopped"),
    ],
    { outcome: "refused", dense: null, end: 1, entry: 2 },
  );
  writeLive(
    dir,
    "firefox",
    [
      START,
      TICK("start"),
      RUNNING,
      ["failed"],
      ["publish", { kind: "stopped", cause: "local_storage" }],
    ],
    { outcome: "refused", dense: null, end: 1, entry: 2 },
  );
  writeLive(
    dir,
    "webkit",
    [
      START,
      TICK("start"),
      RUNNING,
      COMMIT(captureBytes(dir, "webkit")),
      NEXT("now", "running"),
      TICK("now"),
      ["publish", { kind: "stopped", cause: "floor" }],
      NEXT("event", "stopped"),
    ],
    { outcome: "refused", dense: 1, end: 4, entry: 2 },
  );
  const r = contract.resolveEvidence(dir);
  for (const engine of ["chromium", "firefox", "webkit"]) {
    const c = cell(r, LIVE(engine));
    assert.equal(c.status, "ok", `${engine}: ${reasons(c)}`);
    assert.equal(c.outcome, "refused");
  }
  assert.equal(r.complete, true);
  const results = assemble(dir);
  assert.equal(results.acceptance_scope.desktop_decision.supports, false);
  assert.match(
    results.acceptance_scope.desktop_decision.withheld_because.join(" "),
    /a valid workload failed on a desktop engine/,
  );
  const strict = validate(dir);
  assert.equal(strict.status, 0, `${strict.stdout}${strict.stderr}`);
});

test("case (M7): a failed step followed by a stop of another cause, or by an idle, or whose stop was published before its line, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const failedThen = (engine, state) =>
    writeLive(
      dir,
      engine,
      [START, TICK("start"), RUNNING, ["failed"], ["publish", state]],
      { outcome: "refused", dense: null, end: 1, entry: 2 },
    );
  failedThen("chromium", { kind: "stopped", cause: "floor" });
  failedThen("firefox", {
    kind: "idle",
    lastSyncedAt: "2026-10-13T01:00:00.000Z",
  });
  // Reversed: the local_storage stop published before the failure line.
  writeLive(
    dir,
    "webkit",
    [
      START,
      TICK("start"),
      RUNNING,
      ["publish", { kind: "stopped", cause: "local_storage" }],
      ["failed"],
    ],
    { outcome: "refused", dense: null, end: 1, entry: 2 },
  );
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, LIVE("chromium"))),
    /a failed step ends in stopped\/local_storage, not stopped/,
  );
  assert.match(
    reasons(cell(r, LIVE("firefox"))),
    /a failed step ends in stopped\/local_storage, not idle/,
  );
  assert.match(
    reasons(cell(r, LIVE("webkit"))),
    /the failed step's stop is not retained inside the observation/,
  );
  for (const e of ["chromium", "firefox", "webkit"]) {
    assert.equal(cell(r, LIVE(e)).status, "invalid");
    assert.doesNotMatch(reasons(cell(r, LIVE(e))), BINDING);
  }
});

test("case (M8, M9): a trace that continues after the boundary (a later poll, a failure, a restart) leaves the frozen witness admitted; a trace read from another page instance, or not named, is invalid", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const suffix = [
    `7ms data.sync_tick ${JSON.stringify({ why: "timer", coalesced: false })}`,
    `8ms data.sync_commit ${JSON.stringify({ bytes: 64, scan_ms: 1, commit_ms: 1, kind: "applied", value: "committed" })}`,
    `9ms data.sync_next ${JSON.stringify({ when: "now", state: "running" })}`,
    "10ms data.sync_step_failed ",
  ];
  editTrace(dir, "chromium", (all) => [...all, ...suffix]);
  editLive(dir, "chromium", (live) => {
    live.commits = [...live.commits, payloadOf(suffix[1])];
  });
  editLive(dir, "firefox", (live) => {
    live.trace_page = "another-page";
  });
  editLive(dir, "webkit", (live) => {
    delete live.trace_page;
  });
  const r = contract.resolveEvidence(dir);
  const kept = cell(r, LIVE("chromium"));
  assert.equal(kept.status, "ok", reasons(kept));
  assert.equal(kept.outcome, "admitted");
  for (const e of ["firefox", "webkit"]) {
    const c = cell(r, LIVE(e));
    assert.equal(c.status, "invalid");
    assert.match(
      reasons(c),
      /the retained live trace was not read from the observation's page instance/,
    );
    assert.doesNotMatch(reasons(c), DUPLICATE);
  }
});

// ---- DA-3: device engine outcomes -----------------------------------------------------------------------------------------------------

/** The webkit device results and their checker, against that package's own W2 capture (the hand-over's deviceCheck inputs). */
const deviceFile = (dir, engine = "webkit") =>
  join(dir, `device-page/results.${engine}.json`);
const checkDevice = (dir, data, engine = "webkit") => {
  const bytes = readFileSync(
    join(dir, `w2/W2-captured.${engine}.limit-1.json`),
  );
  const h = createHash("sha256").update(bytes).digest("hex");
  return device.checkDeviceResults(data, {
    recorded: hashes,
    w2Hashes: new Set([h]),
    w2Expected: h,
    // Schema 4 (revision 12): the capture's bytes, from which an admitted W2 run's effects are derived.
    w2Bytes: new Map([[h, bytes]]),
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
  // ADAPTED (revision 12, schema 4; labelled): each edit below changes ONE representation of the run, and schema 4 retains a second one
  // (the observation the outcome was classified from), so the same edit is also reported as disagreeing with that observation. The
  // first error is still the original assertion; any other must be one of those named disagreements, never an unrelated fault.
  const OBSERVATION_DISAGREEMENT =
    /: (the detail is not the observed terminal state|first_commit is not the observation's measured commit|recorded \w+, but its observation shows .*)$/;
  const one = (change, pattern) => {
    const errors = errorsOf(change);
    assert.ok(errors.length >= 1, "no error");
    assert.match(errors[0], pattern);
    for (const other of errors.slice(1))
      assert.match(other, OBSERVATION_DISAGREEMENT, errors.join(" | "));
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
      // (Schema 4: the refusal's observation ends in the same state as its detail.)
      const waiting = { kind: "waiting", reason: "cache_not_valid" };
      runOf(d, w7).detail = JSON.stringify(waiting);
      const o = runOf(d, w7).observation;
      o.terminal.state = waiting;
      o.published[2].state = waiting;
      o.events.at(-1).payload.state = "waiting";
      o.step_end.recorded = "waiting";
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
        observation: null,
        effects: null,
      });
    }),
    [],
  );
  // Schema-2 and schema-3 files are history, never read as current evidence.
  for (const schema of [2, 3]) {
    const old = errorsOf((d) => {
      d.schema = schema;
    });
    assert.match(
      old.join(" | "),
      new RegExp(`schema must be 4 \\(schema ${schema} is a historical record`),
    );
  }
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

// Revision 16 (adapted): version 10 (revision 15) joins the list and the current version is 11. Revision 17 (adapted, version literals
// only): version 11 (revision 16) joins the list and the current version is 12. Revision 19 (adapted, version literals only): version 14
// (revision 18 after A18-T2) joins the list and the current version is 15.
test("case: stages recorded under contract versions 3 (review 9's Air request), 4 (revision 9), 5 (revision 10), 6 (revision 11), 7 (revision 12), 8 (revision 13), 9 (revision 14), 10 (revision 15), 11 (revision 16), 12 (revision 17), 13 (revision 18 before A18-T2) and 14 (revision 18) are not evidence of version 15", (t) => {
  for (const version of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
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
          .includes(`recorded under contract ${version}, not 15`),
      ),
    );
  }
});

// ---- revision 12 (review 12, design assessment DA-M1/DA-M2, Q3): each timed sample is its own operation ---------------------------------
//
// Each case changes ONE association and rebinds every other representation as a writer would have written it (the raw series, its
// summary and hash), so only the association can refuse it. The complete programme (first control above) resolves these cells ok.

const sha = (text) => createHash("sha256").update(text).digest("hex");
const measurementRows = (dir) =>
  readFileSync(join(dir, "measurements.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
/** Rewrites a series as `record()` would have written it: its samples, raw file, summary and the raw file's hash together. */
const rewriteSeries = (dir, name, engine, change) => {
  const rows = measurementRows(dir);
  const row = rows.find((r) => r.name === name && r.engine === engine);
  assert.ok(row, `no series ${name}`);
  const raw = readJson(join(dir, row.raw));
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
  writeFileSync(
    join(dir, "measurements.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
};
const p2Trace = (dir, engine) => join(dir, `raw/P-2.trace.${engine}.txt`);
const p2Support = (dir, engine) => join(dir, `raw/P-2.samples.${engine}.json`);
const P2_SCAN = "P-2 dense-100 scan_ms";
const P2_COMMIT = "P-2 dense-100 commit_ms";
/** The invalid cells of a resolution (ok and unavailable are satisfied). */
const unsatisfied = (r) =>
  r.cells
    .filter((c) => !["ok", "unavailable"].includes(c.status))
    .map((c) => c.id)
    .sort();

/** Revision 18: the P-2 support's binding to its trace (line count and SHA-256) regenerated, as the writer would have written it. */
const rebindP2 = (dir, engine) => {
  const text = readFileSync(p2Trace(dir, engine), "utf8");
  editJson(p2Support(dir, engine), (v) => {
    v.trace = { lines: text.split("\n").length, sha256: sha(text) };
  });
};
/** Edits the P-2 trace file (`editTrace` above is the live W2 trace's). */
const editP2Trace = (dir, engine, change) => {
  const lines = readFileSync(p2Trace(dir, engine), "utf8").split("\n");
  writeFileSync(p2Trace(dir, engine), change(lines).join("\n"));
};
/** The support entry of `shape` iteration `index` (warm-ups included). */
const p2Entry = (dir, engine, shape, index) => {
  const e = readJson(p2Support(dir, engine)).iterations.find(
    (x) => x.shape === shape && x.index === index,
  );
  assert.ok(e, `no iteration ${shape} ${index}`);
  return e;
};
/** Review 18's schedule on one iteration: its commit applied/lease_lapsed and its step ending running; the binding regenerated. */
const lapseP2 = (dir, engine, shape, index) => {
  const e = p2Entry(dir, engine, shape, index);
  editP2Trace(dir, engine, (lines) => {
    const commit = lines[e.selected.commit];
    assert.match(commit, /"value":"committed"/);
    lines[e.selected.commit] = commit.replace(
      '"value":"committed"',
      '"value":"lease_lapsed"',
    );
    lines[e.selected.end] = lines[e.selected.end].replace(
      '"state":"idle"',
      '"state":"running"',
    );
    return lines;
  });
  rebindP2(dir, engine);
};
/** Every P-2 cell of an engine: the 32 series or capability cells and the trace cell. */
const p2Cells = (r, engine) =>
  r.cells
    .filter((c) => c.item === "P-2" && c.engine === engine)
    .map((c) => c.id)
    .sort();

test("case R12-M1 (DA-M1): a P-2 sample whose own commit wrote no page (a lapsed hold, its step ending running) is invalid in both series, and the package withholds support", (t) => {
  // REVISION 18 ADAPTATION (labelled; contract 13, design assessment invariant 7): the same schedule on dense-100's first measured
  // iteration (index 5, after its five warm-ups), its trace binding regenerated. One collection verdict now governs every P-2 cell of the
  // engine, so all 33 of WebKit's P-2 cells are invalid (revision 12 named the two series that rest on that commit), for the same reason.
  const dir = scratch(t);
  writeComplete(dir);
  lapseP2(dir, "webkit", "dense-100", 5);
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), p2Cells(r, "webkit"));
  assert.equal(p2Cells(r, "webkit").length, 33);
  for (const id of [`${P2_SCAN}[webkit]`, `${P2_COMMIT}[webkit]`])
    assert.match(
      reasons(cell(r, id)),
      /dense-100 iteration 5: its page is invalid: its commit wrote no page \(applied\/lease_lapsed\)/,
    );
  assert.equal(r.complete, false);
  refusedEndToEnd(dir);
});

test("case R12-M2 (DA-M1): revision 11's selection (a sample's figures taken from a LATER commit, its support moved there and its series rebound) is invalid", (t) => {
  // REVISION 18 ADAPTATION (labelled; `p2-sample/2`): the first measured dense-100 iteration now cites the NEXT iteration's commit and
  // end (its read extended over them) and its scan value is that commit's. Revision 12 refused it as "not the first commit after the
  // sample began"; the rule now re-derives the first commit from the iteration's own slice and refuses the recorded selection.
  // REVISION 19 ADAPTATION (labelled; review 19 R19-P2, `p2-sample/4`): the extended read now ends when the lines it is extended over were
  // traced (the next iteration's read time). Revision 18 moved its position only, so the read retained lines timed after it: the new
  // chronology rule refused that first, before the selection this case is about. Edit, series and expected reason are otherwise unchanged.
  const dir = scratch(t);
  writeComplete(dir);
  const file = p2Support(dir, "webkit");
  const support = readJson(file);
  const at = support.iterations.findIndex(
    (x) => x.shape === "dense-100" && x.index === 5,
  );
  const [first, second] = support.iterations.slice(at, at + 2);
  const lines = readFileSync(p2Trace(dir, "webkit"), "utf8").split("\n");
  const later = payloadOf(lines[second.selected.commit]);
  first.selected = { ...second.selected };
  first.read = { ...first.read, to: second.read.to, at: second.read.at };
  writeFileSync(file, `${JSON.stringify(support, null, 2)}\n`);
  rewriteSeries(dir, P2_SCAN, "webkit", (s) => [later.scan_ms, ...s.slice(1)]);
  const r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, `${P2_SCAN}[webkit]`)),
    /dense-100 iteration 5: its recorded selection is not the commit its trace shows/,
  );
  assert.equal(r.complete, false);
});

test("case R12-M3 (DA-M1): two samples' scan times swapped (summary and hash recomputed) are invalid; the other series is untouched", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  rewriteSeries(dir, P2_SCAN, "chromium", (s) => [s[1], s[0], ...s.slice(2)]);
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), [`${P2_SCAN}[chromium]`]);
  assert.match(
    reasons(cell(r, `${P2_SCAN}[chromium]`)),
    /sample 0: [\d.]+ is not its commit's scan_ms/,
  );
});

test("case R12-M4 (DA-M2): a P-4 sync sample paired with ANOTHER sample's request (segments recomputed from it), or with no retained support, is invalid; a request-latency sample needs no written page", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  // REVISION 13 ADAPTATION (labelled; contract 8): revision 12's support named one request per sample, so its "another sample's request"
  // was spliced into that field. The witness (`sync-request-sample/2`) retains every /sync entry the read saw; the same intent is the next
  // sample's request substituted for sample 0's own entry, with every series value recomputed from it. That request began after sample 0's
  // step ended, so no request lies inside the step and the sample is invalid in every series that rests on it.
  const file = join(dir, "samples/P-4.sync.firefox.json");
  const support = readJson(file);
  const [a, b] = support.samples;
  a.resources = [{ ...b.resources[0] }];
  // REVISION 16 ADAPTATION (labelled; DA16-S1, invariant I3): the next sample's entry ended after sample 0's read, which no page read
  // can retain; it is now refused for that first (asserted below). To keep this case's intent (the selection finds no request of its
  // own step), sample 0's read is extended to that entry's end; the next sample's mark then precedes it, which the frame reports only
  // after sample 0's own refusal.
  const unextended = structuredClone(support);
  a.read.at = b.resources[0].responseEnd + 0.1;
  writeFileSync(file, `${JSON.stringify(support, null, 2)}\n`);
  const lineOf = (e, at) => e.lines[at - e.mark.from];
  const tick = Number(lineOf(a, a.selected.start).split("ms")[0]);
  const commit = Number(lineOf(a, a.selected.commit).split("ms")[0]);
  const r0 = a.resources[0];
  const set = (seg, v) =>
    rewriteSeries(dir, `P-4 sync page ${seg}`, "firefox", (s) => [
      v,
      ...s.slice(1),
    ]);
  set("pre_issue_ms", r0.requestStart - tick);
  set("request_ms", r0.responseEnd - r0.requestStart);
  set("post_response_ms", commit - r0.responseEnd);
  rewriteSeries(
    dir,
    "P-10 sync page request_ms (unthrottled loopback)",
    "firefox",
    (s) => [r0.responseEnd - r0.requestStart, ...s.slice(1)],
  );
  const r = contract.resolveEvidence(dir);
  for (const name of [
    "P-4 sync page pre_issue_ms",
    "P-4 sync page request_ms",
    "P-4 sync page post_response_ms",
    "P-4 sync page total_ms",
    "P-10 sync page request_ms (unthrottled loopback)",
  ])
    assert.match(
      reasons(cell(r, `${name}[firefox]`)),
      /sample 0: its operation is invalid: 0 \/sync requests lie inside the operation/,
      name,
    );
  assert.equal(r.complete, false);
  refusedEndToEnd(dir);
  writeFileSync(file, `${JSON.stringify(unextended, null, 2)}\n`);
  assert.match(
    reasons(
      cell(contract.resolveEvidence(dir), "P-4 sync page request_ms[firefox]"),
    ),
    /sample 0: its operation is invalid: a \/sync request entry lies outside the sample's observation/,
  );
  // The support removed: the throttled series has nothing to rest on.
  const dir2 = scratch(t);
  writeComplete(dir2);
  rmSync(join(dir2, "samples/P-10.sync.webkit.json"));
  const r2 = contract.resolveEvidence(dir2);
  assert.deepEqual(unsatisfied(r2), [
    "P-10 sync page duration_ms (proxy delay 250 ms)[webkit]",
  ]);
  assert.match(
    reasons(
      cell(r2, "P-10 sync page duration_ms (proxy delay 250 ms)[webkit]"),
    ),
    /its per-sample support \(samples\/P-10\.sync\.webkit\.json\) is missing or malformed/,
  );
  // A latency sample whose commit lapsed is still ONE operation: no written page is required of it.
  const dir3 = scratch(t);
  writeComplete(dir3);
  editJson(join(dir3, "samples/P-4.sync.chromium.json"), (v) => {
    const e = v.samples[0];
    const at = e.selected.commit - e.mark.from;
    e.lines[at] =
      `${e.lines[at].split(" ")[0]} data.sync_commit ${JSON.stringify({ kind: "applied", value: "lease_lapsed" })}`;
  });
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir3)), []);
});

test("case R12-E1 (invariant 5): an admitted cold run whose recorded cache is not the served page's (W4's 800 changes as 800 rows; a W2 run that left nothing) is invalid; a negative control is not judged by its effects", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editCold(dir, "firefox", "W4", 3, (run) => {
    run.effects = { ...run.effects, rows: 800 };
  });
  editCold(dir, "chromium", "W2", 2, (run) => {
    run.effects = {
      method: "cache-rows/1",
      rows: 0,
      entries_sha256: sha(""),
    };
  });
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), [
    "P-11 W4 cold run 3[firefox]",
    "P-W2 W2 cold run 2[chromium]",
  ]);
  assert.match(
    reasons(cell(r, "P-11 W4 cold run 3[firefox]")),
    /the cache holds 800 rows; the served page leaves 80/,
  );
  assert.match(
    reasons(cell(r, "P-W2 W2 cold run 2[chromium]")),
    /the cache holds 0 rows; the served page leaves 200/,
  );
  refusedEndToEnd(dir);
});

test("case R12-E2 (invariant 5): an admitted device W2 run that left nothing is refused with the engine's file; its capture being valid, no exemption applies", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const data = readJson(deviceFile(dir));
  const w2 = runOf(data, "W2", 2);
  w2.effects = { method: "cache-rows/1", rows: 0, entries_sha256: sha("") };
  w2.changes_written = 0;
  const errors = checkDevice(dir, data).errors;
  assert.deepEqual(errors, [
    "runs[6] (W2 run 2): the cache holds 0 rows; the served page leaves 200",
  ]);
});

// ---- revision 13 (review 13 R2, design assessment DA-R2-A/DA-R2-B/DA-N1, Q3/Q4): each request sample is re-derived from its witness ------
// The P-4/P-10 sync support is each sample's bounded witness (`sync-request-sample/2`) and the P-4 draft series carry theirs
// (`draft-request-sample/1`). Every case below edits one witness of a complete programme, rebinds every series value that rests on it
// (computed HERE from the edited times, by hand, never with the rule the contract applies) and expects the cell, the reason, the
// withheld desktop support and both validator modes' refusal.

const SYNC_P4 = [
  "P-4 sync page pre_issue_ms",
  "P-4 sync page request_ms",
  "P-4 sync page post_response_ms",
  "P-4 sync page total_ms",
];
const SYNC_P10U = "P-10 sync page request_ms (unthrottled loopback)";
const DRAFT_P4 = [
  "P-4 draft enqueue_ms",
  "P-4 draft claim_ms",
  "P-4 draft stamping_ms",
  "P-4 draft request_ms",
  "P-4 draft record_ms",
  "P-4 draft total_ms",
];
const DRAFT_P10U = "P-10 draft request_ms (unthrottled loopback)";
const syncFile = (dir, engine, which = "P-4") =>
  join(dir, `samples/${which}.sync.${engine}.json`);
const draftFile = (dir, engine) =>
  join(dir, `samples/P-4.draft.${engine}.json`);
const ln = (ms, event, data) =>
  `${ms}ms ${event} ${data === undefined ? "" : JSON.stringify(data)}`;
const msAt = (line) => Number(String(line).split("ms")[0]);
/** Moves every later sample's positions by `delta` trace lines (lines were inserted into, or removed from, sample `k`). */
const shiftAfter = (v, k, delta) => {
  for (const e of v.samples.slice(k + 1)) {
    e.mark.from += delta;
    // Revision 14: a draft witness has a timing read and a completion read (and record positions, which trace lines do not move).
    if (e.read) e.read.to += delta;
    if (e.timing) e.timing.to += delta;
    if (e.completion) e.completion.to += delta;
    for (const key of Object.keys(e.selected))
      if (["start", "commit", "end", "send", "answer"].includes(key))
        e.selected[key] += delta;
  }
};
/** Sets sample `k` of each named series of `engine` to `values[name]`. */
const rebind = (dir, engine, k, values) => {
  for (const [name, value] of Object.entries(values))
    rewriteSeries(dir, name, engine, (s) =>
      s.map((x, i) => (i === k ? value : x)),
    );
};
/** What revision 12's selector made of a witness: the first real tick, the first commit after it, the request; values by hand. */
const syncValues = (tickMs, commitMs, r) => ({
  "P-4 sync page pre_issue_ms": r.requestStart - tickMs,
  "P-4 sync page request_ms": r.responseEnd - r.requestStart,
  "P-4 sync page post_response_ms": commitMs - r.responseEnd,
  "P-4 sync page total_ms": commitMs - tickMs,
  [SYNC_P10U]: r.responseEnd - r.requestStart,
});

test("control R13-K1: the complete programme's sync and draft witnesses resolve ok (a wake inside a step, a later step's start after the read, an acknowledged or removed draft row); a request-latency step whose commit wrote nothing is one sample", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const p4 = readJson(syncFile(dir, "webkit"));
  // Revision 16 (adapted): version 3.
  assert.equal(p4.method, "sync-request-sample/4");
  assert.ok(
    p4.samples.some((e) => e.lines.some((l) => l.includes('"coalesced":true'))),
  );
  assert.ok(p4.samples.some((e) => e.read.to > e.selected.end + 1));
  // Revision 14 (adapted from `draft-request-sample/1`): the draft witness is version 2; some receipts removed their row (absent).
  // Revision 15 (adapted again): version 3, whose completion read records its start. Revision 16 (adapted): version 4. Revision 17
  // (adapted, version literal only): version 5.
  const drafts = readJson(draftFile(dir, "webkit"));
  assert.equal(drafts.method, "draft-request-sample/6");
  assert.ok(
    drafts.samples.some(
      (e) => e.completion.row.kind === "absent" && e.records[5].removed,
    ),
  );
  assert.ok(
    drafts.samples.some((e) => e.completion.row.status === "acknowledged"),
  );
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), []);
  // The throttled P-10 witness: a lapsed commit still ends ONE request's processing (latency needs no written page).
  editJson(syncFile(dir, "firefox", "P-10"), (v) => {
    const e = v.samples[3];
    const at = e.selected.commit - e.mark.from;
    e.lines[at] = ln(msAt(e.lines[at]), "data.sync_commit", {
      kind: "applied",
      value: "lease_lapsed",
    });
    e.lines[e.selected.end - e.mark.from] = ln(
      msAt(e.lines[e.selected.end - e.mark.from]),
      "data.sync_next",
      { when: "after", state: "running" },
    );
  });
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), []);
});

test("case R13-C1 (review 13 R2, DA-R2-A/B): an earlier step that ended without a request before the sample's step: revision 12's 92-style selection, or the honest later step, is invalid in every series that rests on it; the package withholds support and both validator modes refuse it", (t) => {
  for (const honest of [false, true]) {
    const dir = `${scratch(t)}-${honest}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    const v = readJson(syncFile(dir, "chromium"));
    const e = v.samples[0];
    const tick = msAt(e.lines[0]);
    // Review 13's order: tick, end (a local-storage stop: no request), then the requesting step.
    e.lines.splice(
      0,
      0,
      ln(tick - 90, "data.sync_tick", { why: "nudge", coalesced: false }),
      ln(tick - 89, "data.sync_next", { when: "event", state: "stopped" }),
    );
    // REVISION 16 HARNESS CORRECTION (labelled; DA16-H1): the mark precedes the inserted step it triggered (it was left after it, a line
    // before the mark, which `/3` refuses first). Schedule, values and expected reason unchanged.
    e.mark.at = tick - 90.5;
    e.read.to += 2;
    e.selected = {
      start: honest ? e.selected.start + 2 : e.mark.from,
      commit: e.selected.commit + 2,
      end: e.selected.end + 2,
      request: 0,
    };
    shiftAfter(v, 0, 2);
    writeFileSync(syncFile(dir, "chromium"), `${JSON.stringify(v, null, 2)}\n`);
    const commit = msAt(e.lines[e.selected.commit - e.mark.from]);
    rebind(
      dir,
      "chromium",
      0,
      syncValues(honest ? tick : tick - 90, commit, e.resources[0]),
    );
    if (!honest)
      assert.equal(
        syncValues(tick - 90, commit, e.resources[0])[
          "P-4 sync page pre_issue_ms"
        ] -
          syncValues(tick, commit, e.resources[0])[
            "P-4 sync page pre_issue_ms"
          ],
        90,
      );
    const r = contract.resolveEvidence(dir);
    const ids = [...SYNC_P4, SYNC_P10U].map((n) => `${n}[chromium]`);
    assert.deepEqual(unsatisfied(r), ids.sort());
    for (const id of ids)
      assert.match(
        reasons(cell(r, id)),
        /sample 0: its operation is invalid: the sample's step ended without a commit \(.*data\.sync_next.*"state":"stopped".*\): no later step can stand for it/,
        id,
      );
    assert.equal(r.complete, false);
    refusedEndToEnd(dir);
  }
});

test("case R13-C2 (DA-R2-B): the witness's own boundaries: a removed step end leaves the operation pending, a removed start shows a step that began before the sample, a second start inside the step, two commits, an edited slice that is no longer contiguous", (t) => {
  const cases = [
    [
      "end removed",
      (e) => {
        e.lines.splice(e.selected.end - e.mark.from, 1);
      },
      -1,
      /sample 0: its operation is pending: the sample's step has not ended/,
    ],
    [
      "start removed",
      (e) => {
        e.lines.splice(0, 1);
      },
      -1,
      /sample 0: its operation is invalid: a step that began before the sample traced data\.sync_commit inside it/,
    ],
    [
      "second start",
      (e) => {
        e.lines.splice(
          1,
          0,
          ln(msAt(e.lines[0]) + 1, "data.sync_tick", {
            why: "timer",
            coalesced: false,
          }),
        );
      },
      1,
      /sample 0: its operation is invalid: a second step started before the sample's step ended/,
    ],
    [
      "two commits",
      (e) => {
        const at = e.selected.commit - e.mark.from;
        e.lines.splice(at, 0, e.lines[at]);
      },
      1,
      /sample 0: its operation is invalid: the sample's step traced two commits/,
    ],
    [
      "not contiguous",
      (e) => {
        e.lines.pop();
      },
      0,
      /sample 0: its operation is invalid: its trace slice is not contiguous from the mark to the read/,
    ],
  ];
  for (const [label, edit, delta, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/ /g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(syncFile(dir, "webkit"), (v) => {
      const e = v.samples[0];
      edit(e);
      e.read.to += delta;
      shiftAfter(v, 0, delta);
    });
    const r = contract.resolveEvidence(dir);
    const ids = [...SYNC_P4, SYNC_P10U].map((n) => `${n}[webkit]`).sort();
    assert.deepEqual(unsatisfied(r), ids, label);
    assert.match(
      reasons(cell(r, "P-4 sync page request_ms[webkit]")),
      reason,
      label,
    );
  }
});

test("case R13-C3 (DA-R2-B, invariant 3): a second /sync request inside the step, one that began before it, one overlapping its end, an entry without usable timing, or a full resource buffer leave no unique request", (t) => {
  const cases = [
    [
      "second inside",
      (e) =>
        e.resources.push({
          ...e.resources[0],
          startTime: e.resources[0].startTime + 0.1,
        }),
      /2 \/sync requests lie inside the operation \(2 since the sample began\)/,
    ],
    // REVISION 16 HARNESS CORRECTIONS (labelled; DA16-H1, invariant I3): an entry the read retains began after the mark and ended before
    // the read, so the mark is moved before the earlier entry and the read after the overlapping one; schedules and reasons unchanged.
    [
      "began before",
      (e) => {
        e.resources.unshift({
          ...e.resources[0],
          startTime: msAt(e.lines[0]) - 5,
          requestStart: msAt(e.lines[0]) - 4,
          responseEnd: msAt(e.lines[0]) - 3,
        });
        e.mark.at = msAt(e.lines[0]) - 5.5;
      },
      /a \/sync request began before the sample's operation/,
    ],
    [
      "overlaps the end",
      (e) => {
        e.resources.push({
          ...e.resources[0],
          startTime: e.resources[0].startTime + 1,
          requestStart: e.resources[0].startTime + 1.2,
          responseEnd: msAt(e.lines[e.selected.commit - e.mark.from]) + 30,
        });
        e.read.at = e.resources.at(-1).responseEnd + 0.5;
      },
      /a \/sync request overlaps the sample's operation without lying inside it/,
    ],
    [
      "no timing",
      (e) => {
        e.resources[0].requestStart = null;
      },
      /a request entry has no usable timing/,
    ],
    [
      "buffer full",
      (e) => {
        e.read.resource_entries = 250;
      },
      /the resource-timing buffer was full: requests may be missing/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/ /g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(syncFile(dir, "firefox", "P-10"), (v) => {
      edit(v.samples[7]);
    });
    const r = contract.resolveEvidence(dir);
    assert.deepEqual(
      unsatisfied(r),
      ["P-10 sync page duration_ms (proxy delay 250 ms)[firefox]"],
      label,
    );
    assert.match(
      reasons(
        cell(r, "P-10 sync page duration_ms (proxy delay 250 ms)[firefox]"),
      ),
      new RegExp(`sample 7: its operation is invalid: ${reason.source}`),
      label,
    );
  }
});

test("case R13-C4 (invariant 1): identity and binding: a reloaded page, an engine started again, another page instance in the file, another engine's file, another test's file, a recorded selection the witness does not show, overlapping samples, the old method and a recorded failure are each refused", (t) => {
  const cases = [
    [
      "reloaded",
      (v) => {
        v.samples[4].read.page = "another-page";
      },
      /sample 4: its operation is invalid: the page was reloaded or replaced during the sample/,
    ],
    [
      // Revision 18 (A18-T2, adapted): the time origin is recorded, not compared; a moved one is the drift control below, a missing one is refused.
      "no time origin",
      (v) => {
        v.samples[4].read.time_origin = null;
      },
      /sample 4: its operation is invalid: its mark or its read records no time origin/,
    ],
    [
      "engine started",
      (v) => {
        v.samples[4].read.epochs = [
          { generation: 2, run: 1, trace: v.samples[4].mark.from + 1 },
        ];
        v.samples[4].read.generation = 2;
      },
      /sample 4: its operation is invalid: the engine was started again during the sample/,
    ],
    [
      "another page instance",
      (v) => {
        v.samples[4].mark.page = "another-page";
        v.samples[4].read.page = "another-page";
      },
      /sample 4: it was collected on another page instance/,
    ],
    [
      "engine binding",
      (v) => {
        v.engine = "webkit";
      },
      /samples\/P-4\.sync\.chromium\.json is webkit's support, not chromium's/,
    ],
    [
      "collection binding",
      (v) => {
        v.evidence.collection.test = "P-10: a different test";
      },
      /samples\/P-4\.sync\.chromium\.json was not written by this series' stage, invocation and test/,
    ],
    [
      "selection moved",
      (v) => {
        v.samples[4].selected.commit = v.samples[4].selected.end;
      },
      /sample 4: its recorded selection is not the operation its witness shows/,
    ],
    [
      "overlap",
      (v) => {
        const e = v.samples[5];
        const by = e.mark.from - (v.samples[4].read.to - 1);
        e.mark.from -= by;
        e.read.to -= by;
        for (const key of ["start", "commit", "end"]) e.selected[key] -= by;
      },
      /sample 5: it overlaps the previous sample's operation/,
    ],
    [
      "old method",
      (v) => {
        // Revision 18 (A18-T2, adapted): the previous method, which compared the time origin, is history.
        v.method = "sync-request-sample/3";
      },
      /samples\/P-4\.sync\.chromium\.json is not sync-request-sample\/4/, // revision 18 (adapted): the current method is /4
    ],
    [
      "failure recorded",
      (v) => {
        v.failure = {
          index: 320,
          warmup: false,
          problem: "the sample's step has not ended within 30000 ms",
          witness: null,
        };
      },
      /records an incomplete sample: the sample's step has not ended within 30000 ms/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/ /g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(syncFile(dir, "chromium"), edit);
    const r = contract.resolveEvidence(dir);
    const ids = [...SYNC_P4, SYNC_P10U].map((n) => `${n}[chromium]`).sort();
    assert.deepEqual(unsatisfied(r), ids, label);
    assert.match(
      reasons(cell(r, "P-4 sync page total_ms[chromium]")),
      reason,
      label,
    );
  }
});

test("control (revision 18, A18-T2; the measurement identity decision): a time origin that moves on one page instance - inside a sync sample, across a sync file, between a draft's awaits and across a draft file - keeps every selection and value: sync and draft resolve ok end to end; a missing one in a draft identity is refused", (t) => {
  // macOS WebKit moves `performance.timeOrigin` with the disciplined wall clock on an unchanged document (+1 ms every 92 s, measured).
  const dir = scratch(t);
  writeComplete(dir);
  const before = readFileSync(join(dir, "measurements.jsonl"), "utf8");
  let edited = 0;
  for (const engine of ENGINES)
    for (const which of ["P-4", "P-10"]) {
      const file = syncFile(dir, engine, which);
      if (!existsSync(file)) continue;
      editJson(file, (v) => {
        for (const [k, e] of v.samples.entries()) {
          e.mark.time_origin += k;
          e.read.time_origin += k + 1;
        }
      });
      edited += 1;
    }
  const moved = (id, by) => id && { ...id, time_origin: id.time_origin + by };
  for (const engine of ENGINES) {
    editJson(draftFile(dir, engine), (v) => {
      for (const [k, e] of v.samples.entries()) {
        e.mark.time_origin += k;
        for (const key of Object.keys(e.identities))
          e.identities[key] = moved(e.identities[key], k);
        e.timing.identity = moved(e.timing.identity, k + 1);
        e.completion.identity_before = moved(
          e.completion.identity_before,
          k + 1,
        );
        e.completion.identity_after = moved(e.completion.identity_after, k + 2);
      }
    });
    edited += 1;
  }
  assert.ok(edited >= 6, `${edited} support files edited`);
  assert.equal(readFileSync(join(dir, "measurements.jsonl"), "utf8"), before);
  // Every cell ok: the contract re-derived every edited sample's selection and values and found the writer's.
  supportedEndToEnd(dir, "a moved time origin");
  // Malformed data is still refused: a draft identity without a time origin.
  const missing = `${scratch(t)}-no-origin`;
  t.after(() => rmSync(missing, { recursive: true, force: true }));
  writeComplete(missing);
  editFirstDrafts(missing, "no time origin", (e) => {
    e.completion.identity_after = {
      ...e.completion.identity_after,
      time_origin: Number.NaN,
    };
  });
  draftsRefusedEndToEnd(
    missing,
    "no time origin",
    /the witness's dispatch identity records no time origin after the completion read/,
  );
  // ... and the binding before the first await without one.
  const unbound = `${scratch(t)}-no-origin-before`;
  t.after(() => rmSync(unbound, { recursive: true, force: true }));
  writeComplete(unbound);
  editFirstDrafts(unbound, "no time origin before", (e) => {
    e.identities.before = { ...e.identities.before, time_origin: null };
  });
  draftsRefusedEndToEnd(
    unbound,
    "no time origin before",
    /the witness's dispatch identity records no time origin(?! (after|before|at) )/,
  );
});

test("case R13-D1 (DA-N1): a draft whose first send got no answer and was sent again: revision 12's first-send stamping (92 ms longer) is invalid in every draft series; the package withholds support and both validator modes refuse it", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const v = readJson(draftFile(dir, "chromium"));
  const e = v.samples[0];
  const sendB = msAt(e.lines[0]);
  const sendA = sendB - 92;
  e.mark.t1 = Math.min(e.mark.t1, sendA - 0.5);
  e.mark.t0 = Math.min(e.mark.t0, e.mark.t1 - 0.25);
  // A (not sent: no answer), then B (resend) and its answer.
  e.lines = [
    ln(sendA, "data.outbox_send", { resend: false }),
    ln(sendB, "data.outbox_send", { resend: true }),
    e.lines[1],
  ];
  // Revision 14 adaptation: the witness's timing and completion reads both move with the inserted line.
  e.timing.to += 1;
  e.completion.to += 1;
  e.selected = {
    ...e.selected,
    send: e.mark.from,
    answer: e.mark.from + 2,
    request: 0,
  };
  shiftAfter(v, 0, 1);
  writeFileSync(draftFile(dir, "chromium"), `${JSON.stringify(v, null, 2)}\n`);
  const r0 = e.resources[0];
  const answer = msAt(e.lines[2]);
  const values = {
    "P-4 draft enqueue_ms": e.mark.t1 - e.mark.t0,
    "P-4 draft claim_ms": sendA - e.mark.t1,
    "P-4 draft stamping_ms": r0.requestStart - sendA,
    "P-4 draft request_ms": r0.responseEnd - r0.requestStart,
    "P-4 draft record_ms": answer - r0.responseEnd,
    "P-4 draft total_ms": e.timing.done - e.mark.t0,
    [DRAFT_P10U]: r0.responseEnd - r0.requestStart,
  };
  assert.ok(values["P-4 draft stamping_ms"] - (r0.requestStart - sendB) === 92);
  rebind(dir, "chromium", 0, values);
  const r = contract.resolveEvidence(dir);
  const ids = [...DRAFT_P4, DRAFT_P10U].map((n) => `${n}[chromium]`).sort();
  assert.deepEqual(unsatisfied(r), ids);
  for (const id of ids)
    assert.match(
      reasons(cell(r, id)),
      /sample 0: its operation is invalid: the draft was sent again before an answer: a first attempt that got no answer cannot donate its send/,
      id,
    );
  assert.equal(r.complete, false);
  refusedEndToEnd(dir);
});

test("case R13-D2 (DA-N1): the draft witness's other relations: a draft waiting at the mark, a first send that is a resend, a send before the enqueue ended, a failed step before the answer, a second /commands request, the outcome not recorded, a read before the answer, the support missing", (t) => {
  const cases = [
    [
      "waiting",
      (e) => {
        e.mark.waiting = 1;
      },
      /another draft was waiting when the sample began/,
    ],
    [
      "resend",
      (e) => {
        e.lines[0] = e.lines[0].replace('"resend":false', '"resend":true');
      },
      /the sample's first send is a resend/,
    ],
    [
      "send before enqueue end",
      (e) => {
        e.mark.t1 = msAt(e.lines[0]) + 3;
      },
      /its send precedes the end of its enqueue/,
    ],
    [
      "failed step",
      (e) => {
        e.lines[1] = ln(msAt(e.lines[1]), "data.outbox_step_failed");
      },
      /the dispatcher's step failed before the answer/,
    ],
    [
      "second request",
      // REVISION 17 HARNESS CORRECTION (labelled; review 17 R17-BUFFER, DA17-BF invariant 4): the added entry is in the buffer the
      // completion read counted (its total was left at 1, below its two retained entries, which no writer records); reason unchanged.
      (e) => {
        e.resources.push({
          ...e.resources[0],
          startTime: e.resources[0].startTime + 0.05,
        });
        e.completion.resource_entries += 1;
      },
      /2 \/commands requests lie inside the operation/,
    ],
    // Revision 14 adaptations of revision 13's "not settled" and "another draft settled": the completion is now the receipt's own
    // record, so the first is a receipt whose result was never delivered (pending, never complete) and the second a receipt record of
    // another draft.
    [
      "receipt not completed",
      (e) => {
        e.records.pop();
        e.completion.log_to -= 1;
        // Revision 15 (adapted): the read began with the same records (`draft-request-sample/3` records its start position).
        e.completion.log_before -= 1;
      },
      /^pending: the draft's receipt transaction has not completed/,
      "pending",
    ],
    [
      "another draft's receipt",
      (e) => {
        // Revision 15 (adapted): another draft's receipt is its call AND its result; a result alone naming another draft contradicts
        // its call, which case R15-C2 refuses with that reason.
        e.records[4].local_id = "00000000-0000-4000-8000-000000000000";
        e.records[5].local_id = "00000000-0000-4000-8000-000000000000";
      },
      /another draft's dispatch \(data\.admitReceipt\) was recorded during the sample/,
    ],
    [
      "read before answer",
      (e) => {
        // Revision 15 (adapted): the read's one time (`at` = `done`) 1.5 ms before the answer it saw. Its retained receipt call, recorded
        // before the read's position yet timed after it, now refuses it first (the closed interval); revision 14's message was "the
        // sample was read before its answer", which an internally consistent `/3` witness cannot reach before this check.
        e.timing.done = msAt(e.lines[1]) - 1.5;
        e.timing.at = e.timing.done;
      },
      /a dispatch record's time \(\d+\) contradicts the timing read/,
    ],
  ];
  for (const [label, edit, reason, status = "invalid"] of cases) {
    const dir = `${scratch(t)}-${label.replace(/ /g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(draftFile(dir, "firefox"), (v) => {
      edit(v.samples[9]);
    });
    const r = contract.resolveEvidence(dir);
    const ids = [...DRAFT_P4, DRAFT_P10U].map((n) => `${n}[firefox]`).sort();
    assert.deepEqual(unsatisfied(r), ids, label);
    assert.match(
      reasons(cell(r, "P-4 draft stamping_ms[firefox]")),
      new RegExp(
        `sample 9: its operation is ${status}: ${reason.source.replace(/^\^?(pending: )?/, "")}`,
      ),
      label,
    );
  }
  const dir = scratch(t);
  writeComplete(dir);
  rmSync(draftFile(dir, "webkit"));
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(
    unsatisfied(r),
    [...DRAFT_P4, DRAFT_P10U].map((n) => `${n}[webkit]`).sort(),
  );
  assert.match(
    reasons(cell(r, "P-4 draft request_ms[webkit]")),
    /its per-sample support \(samples\/P-4\.draft\.webkit\.json\) is missing or malformed/,
  );
});

test("control R13-K2 (the released backend's first real-writer run): a draft read in the same evaluation as its answer may lie up to the answer line's 1 ms rounding before it; its total is then still the sample's", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const v = readJson(draftFile(dir, "webkit"));
  const e = v.samples[11];
  const answer = msAt(e.lines[1]);
  e.timing.done = answer - 0.3;
  e.timing.at = e.timing.done;
  // Revision 15 (adapted): production begins the receipt's call in the answer's own turn, so a read in that evaluation follows the call:
  // its record lies before the read's position, no later than its time (the answer's raw time is at most 0.5 ms before its line).
  e.records[4].at = answer - 0.35;
  writeFileSync(draftFile(dir, "webkit"), `${JSON.stringify(v, null, 2)}\n`);
  rebind(dir, "webkit", 11, {
    "P-4 draft total_ms": e.timing.done - e.mark.t0,
  });
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), []);
});

test("case R13-C5 (DA-R2-B): two samples' values exchanged with their selections intact (summary and hash recomputed) are refused by the recomputation, for the sync request series and the draft stamping series", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const swap = (s) => [s[1], s[0], ...s.slice(2)];
  rewriteSeries(dir, "P-4 sync page request_ms", "chromium", swap);
  rewriteSeries(dir, "P-4 draft stamping_ms", "chromium", swap);
  const sync = readJson(syncFile(dir, "chromium")).samples;
  const draft = readJson(draftFile(dir, "chromium")).samples;
  const req = (e) => e.resources[0].responseEnd - e.resources[0].requestStart;
  const stamp = (e) => e.resources[0].requestStart - msAt(e.lines[0]);
  assert.notEqual(req(sync[0]), req(sync[1]));
  assert.notEqual(stamp(draft[0]), stamp(draft[1]));
  const r = contract.resolveEvidence(dir);
  // P-10's unthrottled series is no longer P-4's samples, and the P-4 total no longer their sum: both named too.
  assert.deepEqual(unsatisfied(r), [
    "P-10 sync page request_ms (unthrottled loopback)[chromium]",
    "P-4 draft stamping_ms[chromium]",
    "P-4 sync page request_ms[chromium]",
    "P-4 sync page total_ms[chromium]",
  ]);
  assert.match(
    reasons(cell(r, "P-4 sync page request_ms[chromium]")),
    new RegExp(
      `sample 0: ${req(sync[1])} is not its operation's request_ms \\(${req(sync[0])}\\)`,
    ),
  );
  assert.match(
    reasons(cell(r, "P-4 draft stamping_ms[chromium]")),
    new RegExp(
      `sample 0: ${stamp(draft[1])} is not its operation's stamping_ms \\(${stamp(draft[0])}\\)`,
    ),
  );
});

// ---- revision 14 (review 14 R2, design assessment DA-R14-A/B/C, Q6): a draft sample is complete only by its own dispatch's receipt ------
// Each case edits ONE draft witness of a complete programme (`draft-request-sample/2`). The review's schedules change only completion
// evidence, so every timing value, summary and hash stays exactly as the writer computed it: only the completion relation can refuse it.
// Every series that rests on the sample (the six P-4 draft segments and P-10's unthrottled draft reuse) must be named with the reason.

const draftIds = (engine) =>
  [...DRAFT_P4, DRAFT_P10U].map((n) => `${n}[${engine}]`).sort();
/** Moves every later sample's dispatch record positions by `delta` (records were inserted into sample `k`). */
const shiftLogAfter = (v, k, delta) => {
  for (const e of v.samples.slice(k + 1)) {
    e.mark.log_from += delta;
    e.timing.log_to += delta;
    e.completion.log_to += delta;
    // Revision 15: the completion read's recorded start moves with them.
    if (e.completion.log_before !== undefined) e.completion.log_before += delta;
    for (const r of e.records) {
      r.seq += delta;
      if (r.of !== undefined) r.of += delta;
    }
    for (const key of ["claim", "issued", "receipt", "received"])
      e.selected[key] += delta;
  }
};
const draftRefusal = (dir, engine, k, reason, status = "invalid") => {
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds(engine));
  for (const id of [
    `P-4 draft stamping_ms[${engine}]`,
    `P-4 draft total_ms[${engine}]`,
    `${DRAFT_P10U}[${engine}]`,
  ])
    assert.match(
      reasons(cell(r, id)),
      new RegExp(`sample ${k}: its operation is ${status}: ${reason.source}`),
      id,
    );
  assert.equal(r.complete, false);
};

test("case R14-C1 (review 14 R2): the review's schedules with their timing values unchanged: an unreadable completion read, a replacement page with an empty queue, and a failed receipt followed by a resend whose receipt was admitted are each refused in every draft series; desktop support is withheld and both validator modes refuse", (t) => {
  const cases = [
    [
      "unreadable",
      (v) => {
        v.samples[0].completion.row = {
          kind: "error",
          problem: "Error: independent injected queue read failure",
        };
      },
      /the completion read failed: Error: independent injected queue read failure/,
    ],
    [
      "replacement page",
      (v) => {
        const e = v.samples[0];
        e.completion.identity_after = {
          ...e.completion.identity_after,
          page: "replacement-page",
          time_origin: e.completion.identity_after.time_origin + 100_000,
        };
        e.completion.row = { kind: "absent" };
      },
      // Revision 18 (A18-T2, adapted): the time origin is recorded, not compared, so the change names the page instance only.
      /the page was reloaded or replaced during the sample \(after the completion read: page\)/,
    ],
    [
      "retry after answer",
      (v) => {
        const e = v.samples[0];
        const L = e.local_id;
        const base = e.records[0];
        const failed = e.records[5];
        delete failed.inner;
        delete failed.removed;
        Object.assign(failed, { outer: "failed", reason: "abort" });
        const answer = msAt(e.lines[1]);
        const seq = failed.seq + 1;
        const at = failed.at + 250;
        const commit = {
          dispatcher: 1,
          run: 1,
          service: 2,
          local_id: L,
          epoch: 3,
        };
        const request = {
          dispatcher: 1,
          run: 1,
          key: L,
          path: e.resources[0].name,
        };
        e.records.push(
          {
            seq,
            at: failed.at + 0.2,
            event: "write_begin",
            dispatcher: 1,
            run: 1,
            service: 2,
            plan: "data.recordLocalWriteOutcome",
            local_id: null,
          },
          {
            seq: seq + 1,
            at: failed.at + 1,
            event: "write_end",
            of: seq,
            dispatcher: 1,
            run: 1,
            service: 2,
            plan: "data.recordLocalWriteOutcome",
            local_id: null,
            outer: "ran",
          },
          { seq: seq + 2, at, event: "request_begin", ...request },
          {
            seq: seq + 3,
            at: at + 8,
            event: "request_end",
            of: seq + 2,
            outer: "response",
            http: 200,
            ...request,
          },
          {
            seq: seq + 4,
            at: at + 9.5,
            event: "commit_begin",
            plan: "data.admitReceipt",
            ...commit,
          },
          {
            seq: seq + 5,
            at: at + 12,
            event: "commit_end",
            of: seq + 4,
            plan: "data.admitReceipt",
            outer: "applied",
            inner: "admitted",
            removed: false,
            ...commit,
          },
        );
        e.lines.push(
          ln(Math.round(at), "data.outbox_send", { resend: true }),
          ln(Math.round(at + 9), "data.outbox_answer", { kind: "receipt" }),
        );
        e.resources.push({
          ...e.resources[0],
          startTime: at + 0.5,
          requestStart: at + 1,
          responseEnd: at + 8,
        });
        // REVISION 17 HARNESS CORRECTION (labelled; R17-BUFFER, DA17-BF invariant 4): the resend's entry is counted in the completion
        // read's total, as the writer counts it from the same array; schedule and reason unchanged.
        e.completion.resource_entries += 1;
        e.completion.to += 2;
        e.completion.log_to += 6;
        e.completion.at = at + 13;
        e.completion.row = { kind: "row", local_id: L, status: "acknowledged" };
        assert.ok(base.seq === e.mark.log_from && answer < at);
        shiftAfter(v, 0, 2);
        shiftLogAfter(v, 0, 6);
      },
      /the draft's receipt transaction was not applied \(failed\/abort\)/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/ /g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    const before = readFileSync(join(dir, "measurements.jsonl"), "utf8");
    editJson(draftFile(dir, "chromium"), edit);
    // Completion evidence only: no series value, summary or hash changed.
    assert.equal(readFileSync(join(dir, "measurements.jsonl"), "utf8"), before);
    draftRefusal(dir, "chromium", 0, reason);
    refusedEndToEnd(dir);
  }
});

test("case R14-C2 (DA-R14-A/B/C): the receipt's actual result, the actor and epoch of the dispatch, the binding at the completion read, the row's corroboration and the evidence's integrity each refuse the sample with their own reason", (t) => {
  const cases = [
    [
      "applied noop",
      (e) => {
        delete e.records[5].removed;
        Object.assign(e.records[5], { inner: "noop", reason: "not_in_flight" });
      },
      /the draft's receipt was not admitted \(noop\/not_in_flight\)/,
    ],
    [
      "dropped",
      (e) => {
        delete e.records[5].inner;
        delete e.records[5].removed;
        Object.assign(e.records[5], {
          outer: "dropped",
          reason: "identity_changed",
        });
      },
      /the draft's receipt transaction was not applied \(dropped\/identity_changed\)/,
    ],
    [
      "restarted before the completion read",
      (e) => {
        e.completion.identity_before = {
          ...e.completion.identity_before,
          run: 2,
        };
        e.completion.identity_after = {
          ...e.completion.identity_after,
          run: 2,
        };
      },
      /the dispatcher was rebuilt, restarted or stopped during the sample \(before the completion read: run\)/,
    ],
    [
      "service replaced during the completion read",
      (e) => {
        e.completion.identity_after = {
          ...e.completion.identity_after,
          service: 7,
          current_service: 7,
        };
      },
      /the account service ended or was replaced during the sample \(after the completion read: service, current_service\)/,
    ],
    [
      "another dispatcher's receipt",
      (e) => {
        e.records[4].dispatcher = 2;
        e.records[5].dispatcher = 2;
      },
      /the receipt was made by another dispatcher, run or service than the sample's/,
    ],
    [
      "receipt at another epoch",
      (e) => {
        e.records[4].epoch = 4;
        e.records[5].epoch = 4;
      },
      /the dispatch was captured at another epoch than the sample's/,
    ],
    [
      "bare absent",
      (e) => {
        e.records[5].removed = false;
        e.completion.row = { kind: "absent" };
      },
      /the draft's row is gone though its receipt kept it: no recorded relation explains the removal/,
    ],
    [
      "removed but present",
      (e) => {
        e.records[5].removed = true;
        e.completion.row = {
          kind: "row",
          local_id: e.local_id,
          status: "acknowledged",
        };
      },
      /the receipt removed the draft's row but the completion read found it \(acknowledged\)/,
    ],
    [
      "unrecognised read",
      (e) => {
        e.completion.row = { kind: "unread" };
      },
      /the completion read returned no recognised result/,
    ],
    [
      "another draft waiting",
      (e) => {
        e.completion.waiting = 1;
      },
      /another draft was waiting at the completion read/,
    ],
    [
      "unobserved",
      (e) => {
        e.identities.before = { ...e.identities.before, observing: false };
      },
      /the sample's dispatcher was not observed/,
    ],
    [
      "trimmed",
      (e) => {
        e.completion.log_first = e.mark.log_from + 1;
      },
      /dispatch records of the sample were trimmed from the log/,
    ],
    [
      "gap in the records",
      (e) => {
        e.records[2].seq += 100;
      },
      /its dispatch records are not contiguous from the mark to the completion read/,
    ],
    [
      "request unseen by the timing read",
      // REVISION 17 HARNESS CORRECTION (labelled; R17-BUFFER, DA17-BF invariant 5): the timing read that did not yet see the request saw
      // an empty buffer (its total was left at 1: an entry that was not a request, gone by the completion read, which no uninterrupted
      // buffer allows); reason unchanged.
      (e) => {
        e.timing.requests = 0;
        e.timing.resource_entries = 0;
      },
      /its timing read did not see its request/,
    ],
    [
      "enqueue refused",
      (e) => {
        e.enqueue = { kind: "refused", local_id: null };
      },
      /the sample's draft was not enqueued \(refused\)/,
    ],
    [
      "claim refused",
      (e) => {
        e.records[1].inner = "stopped";
      },
      /the claim did not claim the draft \(applied\/stopped\)/,
    ],
    [
      "selection moved",
      (e) => {
        e.selected.received -= 1;
      },
      null,
      "selection",
    ],
  ];
  for (const [label, edit, reason, kind] of cases) {
    const dir = `${scratch(t)}-${label.replace(/ /g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(draftFile(dir, "webkit"), (v) => edit(v.samples[7]));
    if (kind === "selection") {
      const r = contract.resolveEvidence(dir);
      assert.deepEqual(unsatisfied(r), draftIds("webkit"), label);
      assert.match(
        reasons(cell(r, "P-4 draft request_ms[webkit]")),
        /sample 7: its recorded selection is not the operation its witness shows/,
        label,
      );
      continue;
    }
    try {
      draftRefusal(dir, "webkit", 7, reason);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }
});

test("case R14-C3: version-8 draft support (`draft-request-sample/1`) is refused; a mark before the previous sample's completion (its dispatch records) overlaps it", (t) => {
  let dir = scratch(t);
  writeComplete(dir);
  editJson(draftFile(dir, "firefox"), (v) => {
    v.method = "draft-request-sample/1";
  });
  let r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds("firefox"));
  assert.match(
    reasons(cell(r, "P-4 draft claim_ms[firefox]")),
    // Revision 16 (adapted): the current method was /4; revision 17 (adapted, version literal only): it is /5.
    /samples\/P-4\.draft\.firefox\.json is not draft-request-sample\/6/,
  );
  dir = `${scratch(t)}-overlap`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  editJson(draftFile(dir, "firefox"), (v) => {
    v.samples[4].mark.log_from = v.samples[3].completion.log_to - 1;
  });
  r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds("firefox"));
  assert.match(
    reasons(cell(r, "P-4 draft enqueue_ms[firefox]")),
    /sample 4: it overlaps the previous sample's operation/,
  );
});

// ---- revision 15 (review 15 R2, design assessment DA15-R2a/R2b, Q4): completion evidence is checked against its own call and interval ------
// Each case edits ONLY completion evidence of ONE draft witness of a complete programme (`draft-request-sample/3`): every series value,
// selected index, count, summary and hash stays as the writer computed it, so only the evidence's integrity can refuse it. The expected
// reasons are written here by hand from the rule's contract (scripts/lib/profile-sample-rules.mjs), not computed by it.

test("case R15-C1 (review 15 R2): the review's nine completion-integrity schedules end to end: the healthy and every contradicted receipt result or completion time is judged through the contract, ordinary assembly and both validator modes (healthy 0/0 with desktop support; each contradiction refused 1/1 in exactly the six P-4 draft cells and P-10's draft reuse, support withheld)", (t) => {
  const cases = [
    ["healthy", () => {}, null],
    [
      "receipt result failed",
      (e) => {
        e.records.at(-1).outer = "failed";
      },
      /dispatch record \d+ is malformed: its failed commit_end names no reason/,
    ],
    [
      "receipt result names another service",
      (e) => {
        e.records.at(-1).service = 999;
      },
      /a commit result \(record \d+\) contradicts its call \(service\)/,
    ],
    [
      "receipt result omits its service",
      (e) => {
        delete e.records.at(-1).service;
      },
      /dispatch record \d+ is malformed: its commit_end names no service/,
    ],
    [
      "receipt result epoch 100 greater than its call",
      (e) => {
        e.records.at(-1).epoch += 100;
      },
      /a commit result \(record \d+\) contradicts its call \(epoch\)/,
    ],
    [
      "receipt result names another plan",
      (e) => {
        e.records.at(-1).plan = "data.recordOutcome";
      },
      /a commit result \(record \d+\) contradicts its call \(plan\)/,
    ],
    [
      "receipt result 60 s after the completion read",
      (e) => {
        e.records.at(-1).at = e.completion.at + 60_000;
      },
      /a dispatch record's time \(\d+\) contradicts the completion read's start/,
    ],
    [
      "receipt result has no time",
      (e) => {
        delete e.records.at(-1).at;
      },
      /dispatch record \d+ is malformed: its time is not a finite, non-negative page time/,
    ],
    [
      "completion read 60 s before the enqueue",
      (e) => {
        e.completion.at = e.mark.t0 - 60_000;
      },
      /its completion read's times are not after its timing read and in order/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    const before = readFileSync(join(dir, "measurements.jsonl"), "utf8");
    const v = readJson(draftFile(dir, "chromium"));
    const selected = structuredClone(v.samples[0].selected);
    editJson(draftFile(dir, "chromium"), (w) => {
      edit(w.samples[0]);
    });
    // Completion evidence only: no series value, summary, hash or selection changed.
    assert.equal(
      readFileSync(join(dir, "measurements.jsonl"), "utf8"),
      before,
      label,
    );
    assert.deepEqual(
      readJson(draftFile(dir, "chromium")).samples[0].selected,
      selected,
      label,
    );
    if (reason === null) {
      assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), [], label);
      const results = assemble(dir);
      assert.equal(
        results.acceptance_scope.desktop_decision.supports,
        true,
        label,
      );
      for (const extra of [[], ["--allow-partial"]]) {
        const run = validate(dir, ...extra);
        assert.equal(
          run.status,
          0,
          `${label} ${extra}: ${run.stdout}${run.stderr}`,
        );
      }
      continue;
    }
    try {
      draftRefusal(dir, "chromium", 0, reason);
      refusedEndToEnd(dir);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }
});

test("case R15-C2 (DA15-R2a/R2b, invariants 1-3): claim and request results, end references and the closed interval: a result contradicting its call, a malformed result, a duplicate, a result naming another kind or itself, records out of order or before the mark, a receipt delivered during the completion read, each read's position against its time, and a request to another path than its entry each refuse the sample with their own reason", (t) => {
  const cases = [
    [
      "claim result epoch",
      (e) => {
        e.records[1].epoch += 1;
      },
      /a commit result \(record \d+\) contradicts its call \(epoch\)/,
    ],
    [
      "claim result service missing",
      (e) => {
        delete e.records[1].service;
      },
      /dispatch record \d+ is malformed: its commit_end names no service/,
    ],
    [
      "claim result another dispatcher",
      (e) => {
        e.records[1].dispatcher = 7;
      },
      /a commit result \(record \d+\) contradicts its call \(dispatcher\)/,
    ],
    [
      "request result another key",
      (e) => {
        e.records[3].key = "00000000-0000-4000-8000-000000000000";
      },
      /a request result \(record \d+\) contradicts its call \(key\)/,
    ],
    [
      "request result another path",
      (e) => {
        e.records[3].path = "/api/experimental/v1/other";
      },
      /a request result \(record \d+\) contradicts its call \(path\)/,
    ],
    [
      "request result without HTTP status",
      (e) => {
        delete e.records[3].http;
      },
      /dispatch record \d+ is malformed: its answered request_end names no HTTP status/,
    ],
    [
      "two results of one call",
      (e) => {
        e.records[5].of = e.records[0].seq;
      },
      /a commit call \(record \d+\) has two results/,
    ],
    [
      "a result naming another kind",
      (e) => {
        e.records[3].of = e.records[1].seq;
      },
      /a request result \(record \d+\) names a commit_end as its call/,
    ],
    [
      "a result naming itself",
      (e) => {
        e.records[5].of = e.records[5].seq;
      },
      /dispatch record \d+ is malformed: its commit_end names no earlier call/,
    ],
    [
      "an unknown outcome",
      (e) => {
        e.records[5].outer = "maybe";
      },
      /dispatch record \d+ is malformed: its commit_end's outcome \(maybe\) is not one of/,
    ],
    [
      "records going back",
      (e) => {
        e.records[1].at = e.records[0].at - 0.01;
      },
      /the dispatch records' times go back \(record \d+\)/,
    ],
    [
      "a record before the mark",
      (e) => {
        e.records[0].at = e.mark.t0 - 1;
      },
      /a dispatch record \(\d+\) precedes the sample's mark/,
    ],
    [
      "receipt delivered during the completion read",
      (e) => {
        e.completion.log_before -= 1;
        e.completion.started_at = e.records[5].at - 0.1;
      },
      /the receipt's result was delivered during the completion read: the read cannot corroborate it/,
    ],
    [
      "completion start position contradicts its time",
      (e) => {
        e.completion.started_at = e.records[5].at - 0.1;
      },
      /a dispatch record's time \(\d+\) contradicts the completion read's start/,
    ],
    [
      "timing position contradicts its time",
      (e) => {
        e.timing.log_to -= 1;
      },
      /a dispatch record's time \(\d+\) contradicts the timing read/,
    ],
    [
      "completion start missing",
      (e) => {
        delete e.completion.log_before;
      },
      /its completion read records no start inside the sample's records/,
    ],
    [
      "timing read with two times",
      (e) => {
        e.timing.at = e.timing.done + 1;
      },
      /its timing read does not record one time/,
    ],
    [
      "request to another path than its entry",
      (e) => {
        e.records[2].path = "/api/experimental/v1/other";
        e.records[3].path = "/api/experimental/v1/other";
      },
      /the dispatcher's request was made to another path than its \/commands entry/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    const before = readFileSync(join(dir, "measurements.jsonl"), "utf8");
    editJson(draftFile(dir, "firefox"), (v) => {
      edit(v.samples[2]);
    });
    assert.equal(
      readFileSync(join(dir, "measurements.jsonl"), "utf8"),
      before,
      label,
    );
    try {
      draftRefusal(dir, "firefox", 2, reason);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }
});

test("case R15-C3: version-9 draft support (`draft-request-sample/2`) is refused; a mark taken before the previous sample's completion read ended overlaps it in time, and a mark at that very time (with its values rebound) does not", (t) => {
  let dir = scratch(t);
  writeComplete(dir);
  editJson(draftFile(dir, "webkit"), (v) => {
    v.method = "draft-request-sample/2";
  });
  let r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds("webkit"));
  assert.match(
    reasons(cell(r, "P-4 draft claim_ms[webkit]")),
    // Revision 16 (adapted): the current method was /4; revision 17 (adapted, version literal only): it is /5.
    /samples\/P-4\.draft\.webkit\.json is not draft-request-sample\/6/,
  );
  dir = `${scratch(t)}-overlap`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  editJson(draftFile(dir, "webkit"), (v) => {
    v.samples[4].mark.t0 = v.samples[3].completion.at - 0.5;
  });
  r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds("webkit"));
  assert.match(
    reasons(cell(r, "P-4 draft total_ms[webkit]")),
    /sample 4: it overlaps the previous sample's operation in time/,
  );
  dir = `${scratch(t)}-tie`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  const v = readJson(draftFile(dir, "webkit"));
  const e = v.samples[4];
  e.mark.t0 = v.samples[3].completion.at;
  writeFileSync(draftFile(dir, "webkit"), `${JSON.stringify(v, null, 2)}\n`);
  rebind(dir, "webkit", 4, {
    "P-4 draft enqueue_ms": e.mark.t1 - e.mark.t0,
    "P-4 draft total_ms": e.timing.done - e.mark.t0,
  });
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), []);
});

// ---- revision 16 (review 16 R16-SYNC, design assessment DA16-S1/S2/D1/H1, Q4) --------------------------------------------------------------
// `sync-request-sample/3` and `draft-request-sample/4` (contract version 11): the sync witness's own observation interval (typed mark and
// read times enclosing every retained line and entry, the lines' times never going back), the exact endpoint pathname for both helper
// callers, and each sync mark following the previous read in time. Every case edits retained witnesses of a complete programme and is
// judged by the contract, the ordinary assembler and both validator modes; expected cells and reasons are written here.
const syncIds = (engine) =>
  [...SYNC_P4, SYNC_P10U, "P-10 sync page duration_ms (proxy delay 250 ms)"]
    .map((n) => `${n}[${engine}]`)
    .sort();
const ENGINES = ["chromium", "firefox", "webkit"];

test("case R16-C1 (review 16 R16-SYNC): the review's sync schedules on the first P-4 and P-10 witness of every engine, end to end: healthy 0/0 with desktop support; a second request, a read timed before its mark, both observation times missing, a step end traced before its tick and an entry to /not-sync each refused 1/1 in every series resting on them, with the selections and values unchanged", (t) => {
  const cases = [
    ["healthy", () => {}, null],
    [
      "second request (the review's known-invalid control)",
      (w) => {
        w.resources.push(structuredClone(w.resources[0]));
        w.read.resource_entries += 1;
      },
      /2 \/sync requests lie inside the operation \(2 since the sample began\)/,
    ],
    [
      "read 1000 ms before its mark",
      (w) => {
        w.read.at = w.mark.at - 1000;
      },
      /its read is timed before its mark/,
    ],
    [
      "both observation times missing",
      (w) => {
        delete w.read.at;
        delete w.mark.at;
      },
      /its mark records no finite, non-negative page time/,
    ],
    [
      "step end traced at 1 ms, before its tick",
      (w) => {
        const i = w.selected.end - w.mark.from;
        w.lines[i] = w.lines[i].replace(/^-?\d+ms/, "1ms");
      },
      /a trace line \(\d+\) precedes the sample's mark/,
    ],
    [
      "entry named /not-sync",
      (w) => {
        w.resources[0].name = "/not-sync";
      },
      /a retained request entry is not the \/sync endpoint \(\/not-sync\)/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    const before = readFileSync(join(dir, "measurements.jsonl"), "utf8");
    for (const engine of ENGINES)
      for (const which of ["P-4", "P-10"])
        editJson(syncFile(dir, engine, which), (v) => {
          const selected = structuredClone(v.samples[0].selected);
          edit(v.samples[0]);
          assert.deepEqual(v.samples[0].selected, selected, label);
        });
    // Witnesses only: no series value, summary or hash changed.
    assert.equal(
      readFileSync(join(dir, "measurements.jsonl"), "utf8"),
      before,
      label,
    );
    const r = contract.resolveEvidence(dir);
    if (reason === null) {
      assert.deepEqual(unsatisfied(r), [], label);
      const results = assemble(dir);
      assert.equal(
        results.acceptance_scope.desktop_decision.supports,
        true,
        label,
      );
      for (const extra of [[], ["--allow-partial"]]) {
        const run = validate(dir, ...extra);
        assert.equal(
          run.status,
          0,
          `${label} ${extra}: ${run.stdout}${run.stderr}`,
        );
      }
      continue;
    }
    try {
      assert.deepEqual(unsatisfied(r), ENGINES.flatMap(syncIds).sort());
      for (const engine of ENGINES)
        for (const id of [
          `P-4 sync page pre_issue_ms[${engine}]`,
          `P-4 sync page total_ms[${engine}]`,
          `${SYNC_P10U}[${engine}]`,
          `P-10 sync page duration_ms (proxy delay 250 ms)[${engine}]`,
        ])
          assert.match(
            reasons(cell(r, id)),
            new RegExp(`sample 0: its operation is invalid: ${reason.source}`),
            id,
          );
      assert.equal(r.complete, false);
      refusedEndToEnd(dir);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }
});

test("case R16-C2 (DA16-S1/S2, invariants I1-I5): a middle and the last witness, a whole witness translated earlier with its durations kept, an entry outside its read and a tail line after it are refused in their engine's series; a mark tied to the previous read is not", (t) => {
  const cases = [
    [
      "middle sample's read before its mark",
      "chromium",
      "P-4",
      150,
      (v) => {
        v.samples[150].read.at = v.samples[150].mark.at - 0.25;
      },
      /sample 150: its operation is invalid: its read is timed before its mark/,
    ],
    [
      "last sample's entry to another endpoint",
      "webkit",
      "P-4",
      299,
      (v) => {
        v.samples[299].resources[0].name = "/api/experimental/v1/commands";
      },
      /sample 299: its operation is invalid: a retained request entry is not the \/sync endpoint \(\/api\/experimental\/v1\/commands\)/,
    ],
    [
      "an entry ending after the read (inside the commit's rounding)",
      "firefox",
      "P-10",
      6,
      (v) => {
        const e = v.samples[6];
        const commit = msAt(e.lines[e.selected.commit - e.mark.from]);
        e.resources[0].responseEnd = e.read.at + 0.1;
        assert.ok(e.resources[0].responseEnd <= commit + 1);
      },
      /sample 6: its operation is invalid: a \/sync request entry lies outside the sample's observation/,
    ],
    [
      "a later step's tick retained after the read",
      "webkit",
      "P-10",
      2,
      (v) => {
        const e = v.samples[2];
        e.lines.push(
          ln(Math.ceil(e.read.at) + 5, "data.sync_tick", {
            why: "timer",
            coalesced: false,
          }),
        );
        e.read.to += 1;
        shiftAfter(v, 2, 1);
      },
      /sample 2: its operation is invalid: a trace line \(\d+\) follows the sample's read/,
    ],
    [
      "a whole witness translated before the previous read (positions, durations and local order kept)",
      "webkit",
      "P-4",
      10,
      (v) => {
        const e = v.samples[10];
        const d = Math.ceil(e.mark.at - v.samples[9].read.at) + 2;
        e.mark.at -= d;
        e.read.at -= d;
        e.lines = e.lines.map((l) =>
          l.replace(/^(-?\d+)ms/, (_, ms) => `${Number(ms) - d}ms`),
        );
        for (const r of e.resources) {
          r.startTime -= d;
          r.requestStart -= d;
          r.responseEnd -= d;
        }
      },
      /sample 10: it overlaps the previous sample's operation in time/,
    ],
  ];
  for (const [label, engine, which, k, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    const before = readJson(syncFile(dir, engine, which)).samples[k].selected;
    editJson(syncFile(dir, engine, which), edit);
    const ids =
      which === "P-4"
        ? [...SYNC_P4, SYNC_P10U].map((n) => `${n}[${engine}]`).sort()
        : [`P-10 sync page duration_ms (proxy delay 250 ms)[${engine}]`];
    const r = contract.resolveEvidence(dir);
    assert.deepEqual(unsatisfied(r), ids, label);
    for (const id of ids) assert.match(reasons(cell(r, id)), reason, label);
    assert.deepEqual(
      readJson(syncFile(dir, engine, which)).samples[k].selected,
      before,
      label,
    );
  }
  // One end to end: the translated witness through assembly and both validator modes.
  const dir = `${scratch(t)}-translated-public`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  editJson(syncFile(dir, "chromium", "P-10"), cases[4][4]);
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), [
    "P-10 sync page duration_ms (proxy delay 250 ms)[chromium]",
  ]);
  refusedEndToEnd(dir);
  // A tie: the mark at the previous read's very time (its values do not depend on the mark's time).
  const tie = `${scratch(t)}-tie`;
  t.after(() => rmSync(tie, { recursive: true, force: true }));
  writeComplete(tie);
  editJson(syncFile(tie, "firefox"), (v) => {
    v.samples[40].mark.at = v.samples[39].read.at;
  });
  assert.deepEqual(unsatisfied(contract.resolveEvidence(tie)), []);
});

test("case R16-C3 (DA16-D1): a draft whose request, its result and its entry agree on another endpoint, or whose entry lies outside [t0, completion read], is refused in every draft series and end to end; version-10 support (`sync-request-sample/2`, `draft-request-sample/3`) is refused", (t) => {
  const OTHER = "/api/experimental/v1/task-commands";
  const cases = [
    [
      "coherently foreign endpoint",
      (e) => {
        for (const r of e.records)
          if (r.event === "request_begin" || r.event === "request_end")
            r.path = OTHER;
        e.resources[0].name = OTHER;
      },
      /a retained request entry is not the \/commands endpoint \(\/api\/experimental\/v1\/task-commands\)/,
    ],
    [
      "entry beginning before the enqueue",
      (e) => {
        e.resources[0].startTime = e.mark.t0 - 0.5;
      },
      /a \/commands request entry lies outside the sample's observation/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(draftFile(dir, "firefox"), (v) => {
      edit(v.samples[0]);
    });
    try {
      draftRefusal(dir, "firefox", 0, reason);
      refusedEndToEnd(dir);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }
  let dir = `${scratch(t)}-old-sync`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  editJson(syncFile(dir, "chromium"), (v) => {
    v.method = "sync-request-sample/2";
  });
  let r = contract.resolveEvidence(dir);
  assert.deepEqual(
    unsatisfied(r),
    [...SYNC_P4, SYNC_P10U].map((n) => `${n}[chromium]`).sort(),
  );
  assert.match(
    reasons(cell(r, "P-4 sync page request_ms[chromium]")),
    /samples\/P-4\.sync\.chromium\.json is not sync-request-sample\/4/,
  );
  dir = `${scratch(t)}-old-draft`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  editJson(draftFile(dir, "chromium"), (v) => {
    v.method = "draft-request-sample/3";
  });
  r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds("chromium"));
  assert.match(
    reasons(cell(r, "P-4 draft request_ms[chromium]")),
    // Revision 18 (adapted, version literal only): the current draft method is `/6`.
    /samples\/P-4\.draft\.chromium\.json is not draft-request-sample\/6/,
  );
});

// ---- revision 17 (review 17 R17-REQUEST/R17-BUFFER, design assessment DA17-RQ/BF/HR, Q1-Q7 and Q12) ------------------------------------
// `draft-request-sample/5` (contract version 12): the dispatcher's observed call is causally possible for its selected entry (it began no
// later than the entry started and returned no earlier than the entry's request was sent; raw page-clock times, no allowance, ties
// valid), and both ResourceTiming snapshots are typed, below the buffer, contain their counts and belong to one uninterrupted buffer.
// Each case edits ONLY the first P-4 draft witness of every engine, as review 17's diagnostics did: the selections, the six values, every
// series, summary and hash stay exactly as written, so only the relation can refuse the sample; ordinary assembly regenerates hashes.

/** Edits the first draft witness of every engine; the selection and every series row stay as the writer wrote them. */
const editFirstDrafts = (dir, label, edit) => {
  const before = readFileSync(join(dir, "measurements.jsonl"), "utf8");
  for (const engine of ENGINES)
    editJson(draftFile(dir, engine), (v) => {
      const selected = structuredClone(v.samples[0].selected);
      edit(v.samples[0]);
      assert.deepEqual(v.samples[0].selected, selected, label);
    });
  assert.equal(
    readFileSync(join(dir, "measurements.jsonl"), "utf8"),
    before,
    label,
  );
};
/** Healthy end to end: every cell ok, desktop support, both validator modes 0. */
const supportedEndToEnd = (dir, label) => {
  assert.deepEqual(unsatisfied(contract.resolveEvidence(dir)), [], label);
  const results = assemble(dir);
  assert.equal(results.acceptance_scope.desktop_decision.supports, true, label);
  for (const extra of [[], ["--allow-partial"]]) {
    const run = validate(dir, ...extra);
    assert.equal(
      run.status,
      0,
      `${label} ${extra}: ${run.stdout}${run.stderr}`,
    );
  }
};
/** Refused end to end: exactly the seven draft cells of every engine, each with the reason, support withheld, both modes 1. */
const draftsRefusedEndToEnd = (dir, label, reason) => {
  try {
    const r = contract.resolveEvidence(dir);
    assert.deepEqual(unsatisfied(r), ENGINES.flatMap(draftIds).sort());
    for (const engine of ENGINES)
      for (const id of draftIds(engine))
        assert.match(
          reasons(cell(r, id)),
          new RegExp(`sample 0: its operation is invalid: ${reason.source}`),
          id,
        );
    assert.equal(r.complete, false);
    refusedEndToEnd(dir);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
};
const requestOf = (w) => w.records.find((r) => r.event === "request_begin");
const resultOf = (w) => w.records.find((r) => r.event === "request_end");

test("case R17-C1 (review 17 R17-REQUEST, DA17-RQ, Q1/Q2/Q12): a dispatcher call that began after its entry ended (the review's schedule), one that began well after the entry started inside the send and answer, one just after, and a call that returned before the entry's request was sent are refused in all seven draft cells of every engine, support withheld, both modes 1; a foreign endpoint keeps its own reason", (t) => {
  const BEGAN =
    /the dispatcher's request began after its \/commands entry started: the entry is not that call's/;
  const RETURNED =
    /the dispatcher's request returned before its \/commands entry's request was sent: the entry is not that call's/;
  const cases = [
    [
      "begins 0.05 ms after the entry ended (review 17)",
      (w) => {
        requestOf(w).at = w.resources[0].responseEnd + 0.05;
      },
      BEGAN,
    ],
    [
      "begins midway between the entry's start and its request",
      (w) => {
        const r = w.resources[0];
        requestOf(w).at = (r.startTime + r.requestStart) / 2;
      },
      BEGAN,
    ],
    [
      "begins within the trace rounding after the entry started",
      (w) => {
        requestOf(w).at = w.resources[0].startTime + 0.001;
      },
      BEGAN,
    ],
    [
      "returns between its begin and the entry's start (review 17's sub-millisecond variant)",
      (w) => {
        resultOf(w).at = (requestOf(w).at + w.resources[0].startTime) / 2;
      },
      RETURNED,
    ],
    [
      "returns just before the entry's request was sent",
      (w) => {
        resultOf(w).at = w.resources[0].requestStart - 0.001;
      },
      RETURNED,
    ],
    [
      "foreign endpoint (review 17's known-invalid control)",
      (w) => {
        w.resources[0].name = "/not-commands";
      },
      /a retained request entry is not the \/commands endpoint \(\/not-commands\)/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editFirstDrafts(dir, label, edit);
    draftsRefusedEndToEnd(dir, label, reason);
  }
});

test("case R17-C2 (review 17 R17-BUFFER, DA17-BF, Q4-Q7/Q12): the timing total missing, mistyped, zero below its request, or full while the later total is 1; the completion total zero below its retained entry, or full; both totals zero; and a buffer that shrank from 249 to 1 are refused in all seven draft cells of every engine, support withheld, both modes 1", (t) => {
  const cases = [
    [
      "timing total missing",
      (w) => {
        delete w.timing.resource_entries;
      },
      /its timing read does not record the resource buffer's entries/,
    ],
    [
      "timing total a string",
      (w) => {
        w.timing.resource_entries = "1";
      },
      /its timing read does not record the resource buffer's entries/,
    ],
    [
      "timing total zero with one counted request",
      (w) => {
        w.timing.resource_entries = 0;
      },
      /its timing read saw more requests than the buffer held/,
    ],
    [
      "timing total full (250), the later total 1",
      (w) => {
        w.timing.resource_entries = 250;
      },
      /the resource-timing buffer was full at the timing read: requests may be missing/,
    ],
    [
      "completion total zero with one retained entry",
      (w) => {
        w.completion.resource_entries = 0;
      },
      /the completion read retains more requests than the buffer held/,
    ],
    [
      "both totals zero",
      (w) => {
        w.timing.resource_entries = 0;
        w.completion.resource_entries = 0;
      },
      /the completion read retains more requests than the buffer held/,
    ],
    [
      "the buffer shrank from 249 to 1",
      (w) => {
        w.timing.resource_entries = 249;
      },
      /the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries/,
    ],
    [
      "completion total full (review 17's known-invalid control)",
      (w) => {
        w.completion.resource_entries = 250;
      },
      /the resource-timing buffer was full: requests may be missing/,
    ],
  ];
  for (const [label, edit, reason] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editFirstDrafts(dir, label, edit);
    draftsRefusedEndToEnd(dir, label, reason);
  }
});

test("control R17-C3 (DA17-RQ/BF/HR, Q3/Q6/Q7/Q12): a call beginning exactly at its entry's start and returning exactly when its request was sent (the generic headers-return boundary), totals 249 at both reads, and a buffer that grew by an unrelated entry keep their selections and values and support the desktop decision with both modes 0; version-11 draft support (`draft-request-sample/4`) is refused", (t) => {
  const cases = [
    [
      "begin at the entry's start, return at its request's start",
      (w) => {
        const r = w.resources[0];
        requestOf(w).at = r.startTime;
        resultOf(w).at = r.requestStart;
      },
    ],
    [
      "both totals 249",
      (w) => {
        w.timing.resource_entries = 249;
        w.completion.resource_entries = 249;
      },
    ],
    [
      "an unrelated entry between the reads (1 then 2)",
      (w) => {
        w.completion.resource_entries = 2;
      },
    ],
  ];
  for (const [label, edit] of cases) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editFirstDrafts(dir, label, edit);
    // Every cell ok: the contract re-derived each edited sample's selection and values and found the writer's.
    supportedEndToEnd(dir, label);
  }
  const dir = `${scratch(t)}-old-draft-4`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeComplete(dir);
  editJson(draftFile(dir, "webkit"), (v) => {
    v.method = "draft-request-sample/4";
  });
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), draftIds("webkit"));
  assert.match(
    reasons(cell(r, "P-4 draft request_ms[webkit]")),
    /samples\/P-4\.draft\.webkit\.json is not draft-request-sample\/6/,
  );
  // Revision 18 (A18-T2): version-13 draft support (`/5`, which compared the time origin) is history too.
  const five = `${scratch(t)}-old-draft-5`;
  t.after(() => rmSync(five, { recursive: true, force: true }));
  writeComplete(five);
  editJson(draftFile(five, "webkit"), (v) => {
    v.method = "draft-request-sample/5";
  });
  const r5 = contract.resolveEvidence(five);
  assert.deepEqual(unsatisfied(r5), draftIds("webkit"));
  assert.match(
    reasons(cell(r5, "P-4 draft request_ms[webkit]")),
    /samples\/P-4\.draft\.webkit\.json is not draft-request-sample\/6/,
  );
});

// ---- revision 18 (review 18 R18-P2, design assessment invariants 1-7, C3/C4, schedule matrix): the whole P-2 collection ------------------
//
// Review 18: a failed WARM-UP (its admission rounds all lapsed, its step ending running; the engine's empty retry then reaching idle) was
// skipped by the writer, absent from `p2-sample/1`, and the package resolved 758 ok + 38 unavailable with desktop support. Each case below
// changes one thing and regenerates every other representation as the writer would have written it (the support's trace binding, the
// series, the assembled hashes), so only the P-2 collection rule can refuse it.

test("case R18-C1 (review 18 R18-P2): a failed first warm-up in every engine's trace (the review's schedule), a failed first measured iteration and a failed later-shape warm-up are each refused in every P-2 cell, end to end; desktop support is withheld and both validator modes refuse", (t) => {
  for (const [label, edit, where] of [
    [
      "first warm-up, all engines",
      (dir) => {
        for (const engine of programme.ENGINES)
          lapseP2(dir, engine, "ordinary-100", 0);
      },
      /ordinary-100 iteration 0 \(a warm-up\): its page is invalid: its commit wrote no page \(applied\/lease_lapsed\)/,
    ],
    [
      "first measured",
      (dir) => lapseP2(dir, "chromium", "ordinary-100", 20),
      /ordinary-100 iteration 20: its page is invalid: its commit wrote no page/,
    ],
    [
      "later shape's warm-up",
      (dir) => lapseP2(dir, "chromium", "dense-400", 2),
      /dense-400 iteration 2 \(a warm-up\): its page is invalid: its commit wrote no page/,
    ],
  ]) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    edit(dir);
    const r = contract.resolveEvidence(dir);
    const engines = label.endsWith("all engines")
      ? programme.ENGINES
      : ["chromium"];
    assert.deepEqual(
      unsatisfied(r),
      engines.flatMap((e) => p2Cells(r, e)).sort(),
      label,
    );
    for (const engine of engines)
      for (const id of p2Cells(r, engine)) {
        assert.equal(cell(r, id).status, "invalid", `${label}: ${id}`);
        assert.match(reasons(cell(r, id)), where, `${label}: ${id}`);
      }
    // The other P-2 stages and every non-P-2 cell are untouched: no checksum or stage problem explains the refusal.
    assert.ok(
      r.cells
        .filter((c) => c.item !== "P-2")
        .every((c) => ["ok", "unavailable"].includes(c.status)),
      label,
    );
    refusedEndToEnd(dir);
  }
});

test("control R18-K1 (review 18's other schedule, no new rule): a step that ended running without a commit before an iteration's own commit, and a zero-duration commit, keep the collection complete; the package supports the desktop decision and both modes pass", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const engine = "firefox";
  const file = p2Support(dir, engine);
  const support = readJson(file);
  const at = support.iterations.findIndex(
    (x) => x.shape === "ordinary-100" && x.index === 20,
  );
  const pos = support.iterations[at].mark.from;
  editP2Trace(dir, engine, (lines) => {
    const ms = Number(lines[pos].split("ms ")[0]);
    lines.splice(
      pos,
      0,
      `${ms}ms data.sync_tick {"why":"now","coalesced":false}`,
      `${ms}ms data.sync_next {"when":"after","state":"running"}`,
    );
    return lines;
  });
  for (const [k, e] of support.iterations.entries()) {
    if (k > at) e.mark.from += 2;
    if (k >= at) {
      e.read.to += 2;
      e.selected.commit += 2;
      e.selected.end += 2;
    }
  }
  writeFileSync(file, `${JSON.stringify(support, null, 2)}\n`);
  rebindP2(dir, engine);
  const r = contract.resolveEvidence(dir);
  assert.deepEqual(unsatisfied(r), []);
  const results = assemble(dir);
  assert.equal(results.acceptance_scope.desktop_decision.supports, true);
  assert.equal(validate(dir).status, 0);
  assert.equal(validate(dir, "--allow-partial").status, 0);
});

test("case R18-C2 (design assessment C2/C3, invariants 1, 3, 6): the support's own integrity: a warm-up deleted, reordered or duplicated, a shape omitted, a prefix with no failure, a failure that is not the next iteration's, another engine's or the old method, an unbound trace, a secondary error, the body not served or another left queued, and another page or engine start in the sequence are each refused with their own reason", (t) => {
  const iterationsOf = (v) => v.iterations;
  const at = (v, shape, index) =>
    v.iterations.findIndex((x) => x.shape === shape && x.index === index);
  for (const [label, change, reason] of [
    [
      "warm-up deleted",
      (v) => iterationsOf(v).splice(at(v, "ordinary-200", 3), 1),
      /entry \d+ is not ordinary-200 iteration 3 \(a warm-up\): the iterations are not the schedule's, in order/,
    ],
    [
      "warm-ups reordered",
      (v) => {
        const i = at(v, "dense-100", 1);
        const [a, b] = v.iterations.slice(i, i + 2);
        v.iterations.splice(i, 2, b, a);
      },
      /is not dense-100 iteration 1 \(a warm-up\)/,
    ],
    [
      "warm-up duplicated",
      (v) => {
        const i = at(v, "dense-200", 0);
        // The count is kept (the last iteration dropped), so only the order can refuse it.
        v.iterations.splice(i, 0, structuredClone(v.iterations[i]));
        v.iterations.pop();
      },
      /is not dense-200 iteration 1 \(a warm-up\)/,
    ],
    [
      "shape omitted",
      (v) => {
        v.schedule = v.schedule.filter((s) => s.shape !== "dense-400");
        v.iterations = v.iterations.filter((x) => x.shape !== "dense-400");
      },
      /declares another schedule than the programme's/,
    ],
    [
      "fewer warm-ups declared",
      (v) => {
        v.schedule[0].warmup = 2;
        v.iterations.splice(2, 18);
        for (const x of v.iterations)
          if (x.shape === "ordinary-100") x.index -= x.index >= 20 ? 18 : 0;
      },
      /declares another schedule than the programme's/,
    ],
    [
      "prefix, no failure",
      (v) => v.iterations.splice(at(v, "dense-800-W1", 0)),
      /keeps 1418 of the 1436 scheduled iterations and records no failure/,
    ],
    [
      "failure not the next iteration's",
      (v) => {
        v.iterations.splice(at(v, "dense-100", 0));
        v.failure = {
          shape: "dense-100",
          index: 3,
          warmup: true,
          phase: "selection",
          problem: "x",
        };
      },
      /records a failure that is not its next iteration's/,
    ],
    [
      "failure at the next iteration",
      (v) => {
        v.iterations.splice(at(v, "dense-100", 0));
        v.failure = {
          shape: "dense-100",
          index: 0,
          warmup: true,
          phase: "settle",
          problem: "no commit and idle engine followed the nudge",
        };
      },
      /the P-2 collection failed at dense-100 iteration 0 \(a warm-up\) \(settle\): no commit and idle engine followed the nudge/,
    ],
    [
      "another engine's",
      (v) => {
        v.engine = "firefox";
      },
      /is firefox's support, not chromium's/,
    ],
    [
      "old method",
      (v) => {
        // Revision 18 (A18-T1/A18-T2, adapted): `/2` compared the time origin and is history, like `/1`.
        v.method = "p2-sample/2";
      },
      /is not p2-sample\/4/,
    ],
    [
      "previous method",
      (v) => {
        // Revision 19 (R19-P2): `/3` accepted trace times outside their own observation and is history, like `/2`.
        v.method = "p2-sample/3";
      },
      /is not p2-sample\/4/,
    ],
    [
      "unbound trace",
      (v) => {
        v.trace.sha256 = "0".repeat(64);
      },
      /is not bound to raw\/P-2\.trace\.chromium\.txt/,
    ],
    [
      "secondary error",
      (v) => {
        v.secondary = ["the trace could not be written"];
      },
      /records a secondary error: the trace could not be written/,
    ],
    [
      "body not served",
      (v) => {
        v.iterations[at(v, "ordinary-400", 0)].served = 0;
      },
      /ordinary-400 iteration 0 \(a warm-up\): its page is invalid: its body was answered 0 times/,
    ],
    [
      "another answer queued",
      (v) => {
        v.iterations[at(v, "ordinary-400", 7)].pending = 1;
      },
      /ordinary-400 iteration 7 \(a warm-up\): its page is invalid: 1 scripted answer/,
    ],
    [
      "another page",
      (v) => {
        const i = at(v, "ordinary-800", 30);
        v.iterations[i].mark.page = "other";
        v.iterations[i].read.page = "other";
      },
      /ordinary-800 iteration 30: the page was replaced between iterations/,
    ],
    [
      "engine started again",
      (v) => {
        const i = at(v, "dense-200", 9);
        for (const x of v.iterations.slice(i)) {
          x.mark.generation = 2;
          x.read.generation = 2;
          x.mark.epochs = 2;
          x.read.epochs = 2;
        }
      },
      /dense-200 iteration 9: the engine was started again between iterations/,
    ],
  ]) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    editJson(p2Support(dir, "chromium"), (v) => {
      change(v);
    });
    const r = contract.resolveEvidence(dir);
    assert.deepEqual(unsatisfied(r), p2Cells(r, "chromium"), label);
    assert.match(reasons(cell(r, "P-2:trace[chromium]")), reason, label);
    assert.match(reasons(cell(r, `${P2_SCAN}[chromium]`)), reason, label);
  }
});

test("case R18-C3 (design assessment C3, invariant 7): a failed collection that published NO series (the writer's own failure path) is invalid at the trace cell, never a harmless missing-only package; a capability record does not stand in for it; both validator modes refuse", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  const engine = "firefox";
  // The writer's failure path: support with the failure and the iterations before it, the trace, and no P-2 series row; Firefox's
  // long-task capability values are kept (a capability shortcut).
  editJson(p2Support(dir, engine), (v) => {
    v.iterations = v.iterations.slice(0, 1);
    v.failure = {
      shape: "ordinary-100",
      index: 1,
      warmup: true,
      phase: "selection",
      problem: "its commit wrote no page (applied/lease_lapsed)",
      witness: null,
    };
  });
  writeFileSync(
    join(dir, "measurements.jsonl"),
    `${measurementRows(dir)
      .filter((r) => !(r.name.startsWith("P-2 ") && r.engine === engine))
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`,
  );
  const r = contract.resolveEvidence(dir);
  const trace = cell(r, `P-2:trace[${engine}]`);
  assert.equal(trace.status, "invalid");
  assert.match(
    reasons(trace),
    /the P-2 collection failed at ordinary-100 iteration 1 \(a warm-up\) \(selection\): its commit wrote no page/,
  );
  const long = cell(r, `P-2 dense-100 long_task_ms_per_page[${engine}]`);
  assert.equal(long.status, "invalid");
  assert.match(reasons(long), /the P-2 collection failed/);
  assert.equal(cell(r, `${P2_SCAN}[${engine}]`).status, "missing");
  assert.equal(r.complete, false);
  refusedEndToEnd(dir);
});

test("case R18-C4 (design assessment C3): the stamp binds the support to its rows and its case; a row's warm-up count must be its collection's; strict mode never accepts a shortened schedule, the relaxed writer qualification accepts its declared prefix", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  editJson(p2Support(dir, "webkit"), (v) => {
    v.evidence.invocation = "another-invocation";
  });
  let r = contract.resolveEvidence(dir);
  assert.match(
    reasons(cell(r, `${P2_SCAN}[webkit]`)),
    /was not written by this series' stage, invocation and test/,
  );
  assert.match(
    reasons(cell(r, "P-2:trace[webkit]")),
    /written by invocation another-invocation/,
  );
  const dir2 = `${scratch(t)}-rows`;
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  writeComplete(dir2);
  const rows = measurementRows(dir2);
  for (const row of rows)
    if (row.name === "P-2 dense-200 wall_ms" && row.engine === "chromium")
      row.warmup = 0;
  writeFileSync(
    join(dir2, "measurements.jsonl"),
    `${rows.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  r = contract.resolveEvidence(dir2);
  assert.deepEqual(unsatisfied(r), ["P-2 dense-200 wall_ms[chromium]"]);
  assert.match(
    reasons(cell(r, "P-2 dense-200 wall_ms[chromium]")),
    /its row records 0 warm-ups, its collection 5/,
  );
  // A shortened writer qualification: the first shape, two warm-ups and three samples, declared as such.
  const dir3 = `${scratch(t)}-short`;
  t.after(() => rmSync(dir3, { recursive: true, force: true }));
  writeComplete(dir3);
  editJson(p2Support(dir3, "chromium"), (v) => {
    v.schedule = [{ shape: "ordinary-100", warmup: 2, samples: 3 }];
    v.iterations = v.iterations.slice(0, 5);
  });
  const trace = (rr) => cell(rr, "P-2:trace[chromium]");
  assert.match(
    reasons(trace(contract.resolveEvidence(dir3))),
    /declares another schedule than the programme's/,
  );
  // Relaxed: positions and bytes still checked; ordinary-100's iterations 0-4 were its warm-ups 0-4 here, so iterations 2-4 serve the
  // bytes of ordinary iterations 2-4 and their selections stand.
  assert.equal(
    trace(contract.resolveEvidence(dir3, { relaxed: true })).status,
    "ok",
  );
  editJson(p2Support(dir3, "chromium"), (v) => {
    v.schedule = [
      { shape: "dense-100", warmup: 2, samples: 3 },
      { shape: "ordinary-100", warmup: 2, samples: 3 },
    ];
  });
  assert.match(
    reasons(trace(contract.resolveEvidence(dir3, { relaxed: true }))),
    /declares a schedule the programme does not take/,
  );
});

// ---- revision 19 (review 19 R19-P2, design assessment C1-C3, invariants 2 and 5, Q12): each P-2 iteration's trace inside its observation ---
//
// Review 19: the P-2 rule checked the frames and trace positions but not the trace's times, so a read claiming to end before the commit it
// retains, a mark after that commit, an end timed before it and a negative commit time each resolved 758 ok + 38 unavailable with desktop
// support. The synthetic programme's first ordinary-100 warm-up is exactly review 19's iteration (mark 1001, tick 1003, commit 1006, idle
// end 1009, read 1010). Each case changes only times, regenerating the trace binding where the trace changes, so no lifetime, position,
// byte, value or binding check can be the reason; selections, values, counts and series are untouched.

/** Moves one iteration's frame time (`mark` or `read`) in its support. */
const retimeP2Frame = (dir, engine, shape, index, frame, at) =>
  editJson(p2Support(dir, engine), (v) => {
    const e = v.iterations.find((x) => x.shape === shape && x.index === index);
    assert.ok(e, `no iteration ${shape} ${index}`);
    e[frame].at = at;
  });
/** Re-times one of an iteration's selected trace lines (`commit` or `end`) and regenerates the binding. */
const retimeP2Line = (dir, engine, shape, index, which, ms) => {
  const e = p2Entry(dir, engine, shape, index);
  editP2Trace(dir, engine, (lines) => {
    const before = lines[e.selected[which]];
    assert.match(before, /^\d+ms data\.sync_(commit|next) /);
    lines[e.selected[which]] = before.replace(/^\d+ms /, `${ms}ms `);
    return lines;
  });
  rebindP2(dir, engine);
};
const msOfLine = (dir, engine, position) =>
  Number(
    readFileSync(p2Trace(dir, engine), "utf8")
      .split("\n")
      [position].split("ms ")[0],
  );

test("case R19-C1 (review 19 R19-P2): the review's four contradictions on the first warm-up of every engine are each refused in all 99 P-2 cells end to end; desktop support is withheld and both validator modes refuse", (t) => {
  const FIRST = /ordinary-100 iteration 0 \(a warm-up\): its page is invalid: /;
  for (const [label, edit, reason] of [
    [
      "read at 1002 before the commit at 1006",
      (dir, engine) =>
        retimeP2Frame(dir, engine, "ordinary-100", 0, "read", 1002),
      /a trace line \(1\) follows the sample's read/,
    ],
    [
      "mark at 1009 after the commit at 1006",
      (dir, engine) =>
        retimeP2Frame(dir, engine, "ordinary-100", 0, "mark", 1009),
      /a trace line \(0\) precedes the sample's mark/,
    ],
    [
      "end at 1004 after a commit at 1006",
      (dir, engine) =>
        retimeP2Line(dir, engine, "ordinary-100", 0, "end", 1004),
      /the trace's times go back \(line 2\)/,
    ],
    [
      "commit at -100",
      (dir, engine) =>
        retimeP2Line(dir, engine, "ordinary-100", 0, "commit", -100),
      /a trace line \(1\) is timed before the page's clock began/,
    ],
  ]) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    for (const engine of programme.ENGINES) {
      // The review's healthy iteration, exactly: the edit is the only contradiction.
      const e = p2Entry(dir, engine, "ordinary-100", 0);
      assert.deepEqual(
        [e.mark.at, e.read.at, e.selected],
        [1001, 1010, { commit: 1, end: 2 }],
      );
      assert.deepEqual(
        [0, 1, 2].map((p) => msOfLine(dir, engine, p)),
        [1003, 1006, 1009],
      );
      edit(dir, engine);
    }
    const r = contract.resolveEvidence(dir);
    const p2 = programme.ENGINES.flatMap((e) => p2Cells(r, e)).sort();
    assert.equal(p2.length, 99, label);
    assert.deepEqual(unsatisfied(r), p2, label);
    for (const id of p2) {
      assert.equal(cell(r, id).status, "invalid", `${label}: ${id}`);
      assert.match(reasons(cell(r, id)), FIRST, `${label}: ${id}`);
      assert.match(reasons(cell(r, id)), reason, `${label}: ${id}`);
    }
    assert.ok(
      r.cells
        .filter((c) => c.item !== "P-2")
        .every((c) => ["ok", "unavailable"].includes(c.status)),
      label,
    );
    refusedEndToEnd(dir);
  }
});

test("case R19-C2 (design assessment Q12): a contradiction at a measured position, a later shape's warm-up or the final iteration is refused in that engine's 33 P-2 cells only, end to end; a later healthy iteration never repairs it", (t) => {
  for (const [label, engine, edit, where] of [
    [
      "first measured iteration, read before its commit",
      "chromium",
      (dir) => {
        const e = p2Entry(dir, "chromium", "ordinary-100", 20);
        retimeP2Frame(
          dir,
          "chromium",
          "ordinary-100",
          20,
          "read",
          e.mark.at + 1,
        );
      },
      /ordinary-100 iteration 20: its page is invalid: a trace line \(\d+\) follows the sample's read/,
    ],
    [
      "later shape's warm-up, mark after its commit",
      "firefox",
      (dir) => {
        const e = p2Entry(dir, "firefox", "dense-400", 2);
        retimeP2Frame(
          dir,
          "firefox",
          "dense-400",
          2,
          "mark",
          msOfLine(dir, "firefox", e.selected.commit) + 2,
        );
      },
      /dense-400 iteration 2 \(a warm-up\): its page is invalid: a trace line \(\d+\) precedes the sample's mark/,
    ],
    [
      "final iteration of the programme, end before its commit",
      "webkit",
      (dir) => {
        const v = readJson(p2Support(dir, "webkit"));
        const last = v.iterations.at(-1);
        retimeP2Line(
          dir,
          "webkit",
          last.shape,
          last.index,
          "end",
          msOfLine(dir, "webkit", last.selected.commit) - 1,
        );
      },
      /: its page is invalid: the trace's times go back \(line \d+\)/,
    ],
  ]) {
    const dir = `${scratch(t)}-${label.replace(/\W+/g, "-")}`;
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeComplete(dir);
    edit(dir);
    const r = contract.resolveEvidence(dir);
    assert.equal(p2Cells(r, engine).length, 33, label);
    assert.deepEqual(unsatisfied(r), p2Cells(r, engine), label);
    for (const id of p2Cells(r, engine))
      assert.match(reasons(cell(r, id)), where, `${label}: ${id}`);
    refusedEndToEnd(dir);
  }
});

test("control R19-K1 (design assessment Q2/Q12): ties and the trace's 1 ms rounding at both frame edges keep every selection and value; the package supports the desktop decision and both validator modes pass", (t) => {
  const dir = scratch(t);
  writeComplete(dir);
  for (const engine of programme.ENGINES) {
    // Tick 1003 one rounding below a mark at 1004; end 1009 one rounding above a read at 1008.
    retimeP2Frame(dir, engine, "ordinary-100", 0, "mark", 1004);
    retimeP2Frame(dir, engine, "ordinary-100", 0, "read", 1008);
    // A commit and its end traced in the same rounded millisecond.
    const e = p2Entry(dir, engine, "ordinary-100", 20);
    retimeP2Line(
      dir,
      engine,
      "ordinary-100",
      20,
      "end",
      msOfLine(dir, engine, e.selected.commit),
    );
  }
  supportedEndToEnd(dir, "rounding edges and ties");
});

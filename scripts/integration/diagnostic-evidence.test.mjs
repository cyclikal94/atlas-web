// WEB-09c revision 26 (R26-DIAG; design assessment Q5): the diagnostic evidence reader. Hand-built VALID X0 and X2 attempts (transcript
// bytes, receipt copy, tap records, probe bodies, proof), then independent omissions, misbindings and substitutions, each refused even
// though "the browser passed". Nothing here launches anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  attemptProblems,
  PROOF_SCHEMA,
  x0Problems,
  x2Problems,
} from "./diagnostic-evidence.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const START = 1_800_000_000;
const RET = 90 * 86400;
const E = START + RET;
const hex = (n, w) => n.toString(16).padStart(w, "0");
const tokenOf = ({ boundary, expiry, revision, index }, mac = "a") =>
  `d2.${hex(boundary, 16)}.${hex(expiry, 16)}.${hex(revision, 16)}.${hex(index, 8)}.0000beef.${mac.repeat(64)}`;
const EXPECTED = {
  selectionIdentity: "selection-id",
  executableSha256: "e".repeat(64),
  apiVersion: "0.30.0",
  features: { "sync-diagnostic": true, "test-hooks": false },
  retentionSeconds: RET,
  publicOrigin: "http://127.0.0.1:5000",
};
const clone = (v) => structuredClone(v);

/**
 * One attempt: `commands` are [op, args, answer-fields, sentAt, answeredAt]; answers default to ok with the operation's effect. Returns the
 * files map, the envelope and the transcript entries, consistent with each other.
 */
function attemptWorld(commands, { attempt = "att-1", stderr = [] } = {}) {
  const receipt = {
    schema: 2,
    kind: "atlas-sync-diagnostic-receipt",
    attempt,
    pid: 4242,
    fixture_dir: { path: "/t/fixture-att-1", dev: 1, ino: 2 },
    database: { path: "/t/fixture-att-1/fixture.sqlite", dev: 1, ino: 3 },
    executable: {
      path: "/run/atlas-sync-diagnostic",
      sha256: EXPECTED.executableSha256,
    },
    features: EXPECTED.features,
    api_version: "0.30.0",
    address: "127.0.0.1:40000",
    public_origin: EXPECTED.publicOrigin,
    sync_start: START,
    retention_seconds: RET,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
  const lines = [];
  const push = (stream, value, at) =>
    lines.push({
      n: lines.length + 1,
      at,
      stream,
      line: typeof value === "string" ? value : JSON.stringify(value),
    });
  push(
    "stdout",
    { event: "ready", receipt, receipt_sha256: sha(receiptBytes) },
    10,
  );
  for (const l of stderr) push("stderr", l, 11);
  const effect = {
    inspect: "none",
    add_account: "applied",
    age_history: "applied",
    advance_clock: "applied",
    collect: "applied",
  };
  const accounts = {};
  const specCalls = [];
  commands.forEach(([op, args, fields, sentAt, answeredAt], i) => {
    const seq = i + 1;
    push("stdin", { attempt, seq, op, args }, sentAt);
    if (op === "shutdown")
      push(
        "stdout",
        {
          event: "stopped",
          attempt,
          seq,
          served: true,
          removed: ["fixture.sqlite", "receipt.json"],
          cleanup_error: null,
          ...fields,
        },
        answeredAt,
      );
    else {
      push(
        "stdout",
        {
          attempt,
          seq,
          op,
          ok: true,
          result: {},
          effect: effect[op],
          sync_now: START,
          ...fields,
        },
        answeredAt,
      );
      if (op === "add_account")
        accounts[args.username] = { account_id: fields.result.account, seq };
      else
        specCalls.push({
          op,
          args,
          seq,
          outcome: "ok",
          at_request: sentAt - 1,
          at_answer: answeredAt + 1,
        });
    }
  });
  const transcript = Buffer.from(
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  const files = new Map([
    ["att/transcript.jsonl", transcript],
    ["att/receipt.json", receiptBytes],
  ]);
  const envelope = {
    schema: "web09c-diagnostic-attempt/1",
    attempt,
    case: "PAIR-X0",
    engine: "chromium",
    selection_identity: EXPECTED.selectionIdentity,
    executable: {
      path: "/run/atlas-sync-diagnostic",
      sha256: EXPECTED.executableSha256,
    },
    fixture: { parent: "/t", leaf: "/t/fixture-att-1" },
    public_origin: EXPECTED.publicOrigin,
    env_keys: ["HOME", "LANG", "PATH", "TMPDIR"],
    ready: {
      receipt_sha256: sha(receiptBytes),
      receipt_file: "att/receipt.json",
    },
    ready_problems: [],
    transcript: { file: "att/transcript.jsonl", sha256: sha(transcript) },
    accounts,
    spec_calls: specCalls,
    shutdown: { requested_remove: true },
    exit: { code: 0, signal: null },
    latched: null,
    fixture_after: { leaf_exists: false },
  };
  return {
    files,
    envelope,
    entries: lines,
    readFile: (f) => {
      if (!files.has(f)) throw new Error(`ENOENT ${f}`);
      return files.get(f);
    },
  };
}
/** Re-serialises a world's transcript after `edit(entries)` (the envelope's hash follows unless `keepHash`). */
function retranscribe(w, edit, { keepHash = false } = {}) {
  edit(w.entries);
  w.entries.forEach((e, i) => {
    e.n = i + 1;
  });
  const bytes = Buffer.from(
    `${w.entries.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  w.files.set("att/transcript.jsonl", bytes);
  if (!keepHash) w.envelope.transcript.sha256 = sha(bytes);
  return w;
}
const accountAnswer = (id) => ({ result: { account: id } });
const attemptOk = (w) =>
  assert.deepEqual(
    attemptProblems(w.envelope, { readFile: w.readFile, expected: EXPECTED }),
    [],
  );
const attemptRefused = (w, expected) => {
  const found = attemptProblems(w.envelope, {
    readFile: w.readFile,
    expected: EXPECTED,
  });
  assert.ok(
    found.some((p) => expected.test(p)),
    JSON.stringify(found),
  );
};

// ---- X0 --------------------------------------------------------------------------------------------------------------------------
const STATE0 = {
  sync_now: START,
  revision_clock: 9,
  accounts: [{ id: "reader", sync_floor: 0 }],
  batches: [
    {
      account: "reader",
      revision: 9,
      created_at: START,
      payload_sha256: "p",
      payload_bytes: 10,
    },
  ],
  devices: [],
  sessions: [
    {
      account: "reader",
      device: "d",
      expires_at: START + 999999,
      token_hash: "h",
    },
  ],
  receipts_sha256: "r",
  resources_sha256: "q",
  truncated: false,
};
function x0World() {
  const header = { boundary: 5, expiry: E, revision: 9, index: 3 };
  const token = tokenOf(header);
  const w = attemptWorld([
    [
      "add_account",
      { username: "pair-writer", password: "[redacted]" },
      accountAnswer("writer"),
      1000,
      1001,
    ],
    [
      "add_account",
      { username: "pair-pair-x0", password: "[redacted]" },
      accountAnswer("reader"),
      1002,
      1003,
    ],
    ["inspect", {}, { result: STATE0 }, 2000, 2001],
    [
      "advance_clock",
      { time: E - 1 },
      { result: { from: START, to: E - 1 }, sync_now: E - 1 },
      2002,
      2003,
    ],
    [
      "advance_clock",
      { time: E },
      { result: { from: E - 1, to: E }, sync_now: E },
      2010,
      2011,
    ],
    [
      "inspect",
      {},
      { result: { ...STATE0, sync_now: E }, sync_now: E },
      2012,
      2013,
    ],
    [
      "inspect",
      {},
      { result: { ...STATE0, sync_now: E }, sync_now: E },
      2030,
      2031,
    ],
    [
      "advance_clock",
      { time: E + 1 },
      { result: { from: E, to: E + 1 }, sync_now: E + 1 },
      2040,
      2041,
    ],
    ["shutdown", { remove: true }, {}, 3000, 3001],
  ]);
  const probeBody = Buffer.from(
    JSON.stringify({
      batches: [{ revision: 9, segment: { index: 3, last: false } }],
      has_more: true,
    }),
  );
  w.files.set("bodies/probe-x0-e-minus-1.json", probeBody);
  const requests = [
    {
      seq: 20,
      status: 200,
      query: { cursor: "c-before" },
      next_cursor: token,
      segment: { index: 2, last: false },
      has_more: true,
      revision: 9,
      last_revision: 9,
      t_request: 1900,
    },
    {
      seq: 21,
      status: 410,
      code: "resync_required",
      gated: true,
      query: { cursor: token },
      t_request: 1950,
      t_gate_open: 2020,
      t_upstream_end: 2025,
    },
  ];
  const proof = {
    schema: PROOF_SCHEMA,
    case: "PAIR-X0",
    interval: "iv-1",
    attempt: "att-1",
    engine: "chromium",
    reader_account: "reader",
    continuation: { token_sha256: sha(token), header },
    staged: { tap_seq: 20 },
    refused: { tap_seq: 21 },
    hand_off_seq: 21,
    controls: {
      inspect_before: 3,
      advance_e_minus_1: 4,
      advance_e: 5,
      inspect_after_e: 6,
      inspect_at_refusal: 7,
      advance_e_plus_1: 8,
    },
    probes: {
      e_minus_1: {
        label: "x0-e-minus-1",
        session: "browser",
        token_sha256: sha(token),
        status: 200,
        code: null,
        body_file: "probe-x0-e-minus-1.json",
        body_sha256: sha(probeBody),
        at_sent: 2004,
        at_answered: 2005,
      },
      session_after_e: {
        label: "session-live",
        status: 200,
        at_sent: 2012,
        at_answered: 2012,
      },
      e_plus_1: {
        label: "x0-e-plus-1",
        session: "browser",
        token_sha256: sha(token),
        status: 410,
        code: "resync_required",
        body_file: null,
        body_sha256: null,
        at_sent: 2042,
        at_answered: 2043,
      },
    },
  };
  return { ...w, requests, proof, token };
}
const x0 = (w) =>
  x0Problems(w.proof, {
    attempt: w.envelope,
    entries: w.entries,
    requests: w.requests,
    readFile: (f) => w.readFile(`bodies/${f}`),
  });

test("X0: a complete, owned attempt with a causal expiry proof is accepted", () => {
  const w = x0World();
  attemptOk(w);
  assert.deepEqual(x0(w), []);
});

const answerOf = (w, seq) =>
  w.entries.find(
    (e) =>
      e.stream === "stdout" &&
      JSON.parse(e.line).seq === seq &&
      JSON.parse(e.line).op,
  );
const setAnswer = (w, seq, edit) => {
  const e = answerOf(w, seq);
  const v = JSON.parse(e.line);
  edit(v);
  e.line = JSON.stringify(v);
};
for (const [name, edit, expected] of [
  [
    "not an X0 proof (an X1 record relabelled)",
    (w) => (w.proof.case = "PAIR-X1"),
    /not an X0 proof/,
  ],
  [
    "another attempt's proof",
    (w) => (w.proof.attempt = "att-2"),
    /names another attempt/,
  ],
  [
    "an injected 410 (the tap altered the answer)",
    (w) =>
      (w.requests[1].delivered = {
        injected: "TAP-INJECTED answer_410",
        status: 410,
      }),
    /altered by the tap/,
  ],
  [
    "a diagnostic 503 instead of the server's 410",
    (w) =>
      Object.assign(w.requests[1], {
        status: 503,
        code: "diagnostic_fixture_unavailable",
      }),
    /not the server's 410/,
  ],
  [
    "the continuation was not held at the gate",
    (w) => delete w.requests[1].gated,
    /not held at the request gate/,
  ],
  [
    "the request was queued only after the control command",
    (w) => (w.requests[1].t_request = 2002.5),
    /not queued at the gate before/,
  ],
  [
    "the gate opened before the clock reached E",
    (w) => (w.requests[1].t_gate_open = 2008),
    /forwarded before the clock reached E/,
  ],
  [
    "the refusal asks with another continuation",
    (w) =>
      (w.requests[1].query.cursor = tokenOf(
        { boundary: 5, expiry: E, revision: 9, index: 3 },
        "b",
      )),
    /continuation is not the proof's/,
  ],
  [
    "the token's expiry is not start + retention",
    (w) => (w.proof.continuation.header.expiry = E + 5),
    /header is not the token's own|not the sync start \+ retention/,
  ],
  [
    "the staged piece is the last one",
    (w) => (w.requests[0].segment.last = true),
    /not a non-final piece/,
  ],
  [
    "the interval handed off elsewhere",
    (w) => (w.proof.hand_off_seq = 20),
    /did not hand off at the real 410/,
  ],
  [
    "the first clock step skipped E−1",
    (w) => setAnswer(w, 4, (a) => (a.result.to = E - 100)),
    /start → E−1/,
  ],
  [
    "the durable state changed across the clock steps",
    (w) => setAnswer(w, 6, (a) => (a.result.batches = [])),
    /durable state changed/,
  ],
  [
    "the floor was raised by the time of the refusal (pruning)",
    (w) =>
      setAnswer(
        w,
        7,
        (a) => (a.result.accounts = [{ id: "reader", sync_floor: 9 }]),
      ),
    /accounts changed|floor is not at or below/,
  ],
  [
    "the continuation's revision was gone at the refusal",
    (w) => setAnswer(w, 7, (a) => (a.result.batches = [])),
    /batches changed|no longer stored/,
  ],
  [
    "an inspection was truncated",
    (w) => setAnswer(w, 7, (a) => (a.result.truncated = true)),
    /truncated/,
  ],
  [
    "the token was refused already at E−1",
    (w) => (w.proof.probes.e_minus_1.status = 410),
    /at E−1 was answered 410/,
  ],
  [
    "the E−1 probe's bytes are not retained",
    (w) => (w.proof.probes.e_minus_1.body_sha256 = "0".repeat(64)),
    /E−1 probe's body is not the retained bytes/,
  ],
  [
    "the E−1 probe used another session",
    (w) => (w.proof.probes.e_minus_1.session = "control"),
    /same token on the browser's session/,
  ],
  [
    "the E−1 probe ran after the clock reached E",
    (w) => (w.proof.probes.e_minus_1.at_answered = 2010.5),
    /not between the two clock steps/,
  ],
  [
    "the session was not live after E",
    (w) => (w.proof.probes.session_after_e.status = 401),
    /session was not shown live/,
  ],
  [
    "the token was still answered at E+1",
    (w) => (w.proof.probes.e_plus_1.status = 200),
    /at E\+1 was not refused/,
  ],
  [
    "a control names a command of another operation",
    (w) => (w.proof.controls.advance_e = 3),
    /advance_e is not a successful advance_clock/,
  ],
]) {
  test(`X0 refused: ${name}`, () => {
    const w = x0World();
    edit(w);
    const found = x0(w);
    assert.ok(
      found.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(found)}`,
    );
  });
}
test("X0 refused: a collection anywhere in the attempt confounds expiry", () => {
  const w = x0World();
  retranscribe(w, (entries) => {
    const at = entries.findIndex(
      (e) => e.stream === "stdin" && JSON.parse(e.line).op === "shutdown",
    );
    entries.splice(at, 0, {
      at: 2500,
      stream: "stdin",
      line: JSON.stringify({
        attempt: "att-1",
        seq: 0,
        op: "collect",
        args: { time: START },
      }),
    });
  });
  assert.ok(x0(w).some((p) => /collected or aged history/.test(p)));
});

// ---- X2 --------------------------------------------------------------------------------------------------------------------------
function x2World() {
  const header = { boundary: 5, expiry: E, revision: 9, index: 3 };
  const token = tokenOf(header);
  const controlHeader = { boundary: 11, expiry: E, revision: 12, index: 1 };
  const controlToken = tokenOf(controlHeader, "c");
  const before = {
    sync_now: START,
    revision_clock: 12,
    accounts: [
      { id: "control", sync_floor: 0 },
      { id: "reader", sync_floor: 0 },
    ],
    batches: [
      {
        account: "control",
        revision: 12,
        created_at: START,
        payload_sha256: "pc",
        payload_bytes: 10,
      },
      {
        account: "reader",
        revision: 9,
        created_at: START - RET,
        payload_sha256: "p",
        payload_bytes: 10,
      },
    ],
    devices: [
      {
        account: "reader",
        device: "d",
        last_seen: START,
        cursor_key_sha256: "k",
      },
    ],
    sessions: [
      {
        account: "reader",
        device: "d",
        expires_at: START + 999999,
        token_hash: "h",
      },
    ],
    receipts_sha256: "r",
    resources_sha256: "q",
    truncated: false,
  };
  const after = clone(before);
  after.accounts[1].sync_floor = 9;
  after.batches = [before.batches[0]];
  const w = attemptWorld([
    [
      "add_account",
      { username: "pair-writer", password: "[redacted]" },
      accountAnswer("writer"),
      1000,
      1001,
    ],
    [
      "add_account",
      { username: "pair-pair-x2", password: "[redacted]" },
      accountAnswer("reader"),
      1002,
      1003,
    ],
    [
      "add_account",
      { username: "pair-x2-control", password: "[redacted]" },
      accountAnswer("control"),
      1004,
      1005,
    ],
    [
      "inspect",
      {},
      {
        result: {
          ...before,
          batches: [
            before.batches[0],
            { ...before.batches[1], created_at: START },
          ],
        },
      },
      650,
      651,
    ],
    [
      "age_history",
      {
        batches: [
          {
            account: "reader",
            revision: 9,
            payload_sha256: "p",
            created_at: START - RET,
          },
        ],
      },
      { result: { aged: [] } },
      700,
      701,
    ],
    [
      "collect",
      { time: START },
      {
        result: {
          time: START,
          before,
          after,
          removed_batches: [before.batches[1]],
        },
      },
      2000,
      2001,
    ],
    ["inspect", {}, { result: after }, 2030, 2031],
    ["shutdown", { remove: true }, {}, 3000, 3001],
  ]);
  const probeBody = Buffer.from(
    JSON.stringify({
      batches: [{ revision: 12, segment: { index: 1, last: false } }],
      has_more: true,
    }),
  );
  w.files.set("bodies/probe-x2-control.json", probeBody);
  const requests = [
    {
      seq: 30,
      status: 200,
      query: { cursor: "c-before" },
      next_cursor: token,
      segment: { index: 2, last: false },
      has_more: true,
      revision: 9,
      last_revision: 9,
      t_request: 1900,
    },
    {
      seq: 31,
      status: 410,
      code: "resync_required",
      gated: true,
      query: { cursor: token },
      t_request: 1950,
      t_gate_open: 2020,
      t_upstream_end: 2025,
    },
  ];
  const proof = {
    schema: PROOF_SCHEMA,
    case: "PAIR-X2",
    interval: "iv-2",
    attempt: "att-1",
    engine: "chromium",
    reader_account: "reader",
    target: { account: "reader", revision: 9, payload_sha256: "p" },
    drained_before_grant_at: 500,
    grant_at: 600,
    continuation: { token_sha256: sha(token), header },
    staged: { tap_seq: 30 },
    refused: { tap_seq: 31 },
    hand_off_seq: 31,
    controls: {
      inspect_before_ageing: 4,
      age_history: 5,
      collect: 6,
      inspect_at_refusal: 7,
    },
    control_account: {
      account: "control",
      revision: 12,
      continuation_sha256: sha(controlToken),
      continuation_header: controlHeader,
      probe_after: {
        label: "x2-control",
        session: "control",
        token_sha256: sha(controlToken),
        status: 200,
        code: null,
        body_file: "probe-x2-control.json",
        body_sha256: sha(probeBody),
        at_sent: 2005,
        at_answered: 2006,
      },
    },
  };
  return { ...w, requests, proof, token };
}
const x2 = (w) =>
  x2Problems(w.proof, {
    attempt: w.envelope,
    entries: w.entries,
    requests: w.requests,
    readFile: (f) => w.readFile(`bodies/${f}`),
  });

test("X2: a complete, owned attempt with a causal pruning proof is accepted", () => {
  const w = x2World();
  attemptOk(w);
  assert.deepEqual(x2(w), []);
});
const collectOf = (w, edit) => setAnswer(w, 6, (a) => edit(a.result, a));
for (const [name, edit, expected] of [
  ["not an X2 proof", (w) => (w.proof.case = "PAIR-X0"), /not an X2 proof/],
  [
    "the ageing names another batch",
    (w) => (w.proof.target.revision = 8),
    /did not age exactly the target batch/,
  ],
  [
    "the ageing back-dated less than the cutoff needs",
    (w) =>
      retranscribe(w, (en) => {
        const e = en.find(
          (x) =>
            x.stream === "stdin" && JSON.parse(x.line).op === "age_history",
        );
        const v = JSON.parse(e.line);
        v.args.batches[0].created_at = START - RET + 10;
        e.line = JSON.stringify(v);
      }),
    /did not age exactly the target batch/,
  ],
  [
    "the target was requested before the ageing",
    (w) => (w.requests[0].t_request = 690),
    /carried the target before the ageing/,
  ],
  [
    "the gate was drained after the grant",
    (w) => (w.proof.drained_before_grant_at = 650),
    /not closed and drained before the grant/,
  ],
  [
    "the collection ran at another time",
    (w) => collectOf(w, (r) => (r.time = START + 5)),
    /did not run at the sync start/,
  ],
  [
    "the collector removed another batch too",
    (w) =>
      collectOf(w, (r, a) => {
        r.removed_batches.push(a.result.before.batches[0]);
      }),
    /not exactly the target batch/,
  ],
  [
    "the reader's floor was not raised",
    (w) => collectOf(w, (r) => (r.after.accounts[1].sync_floor = 0)),
    /floor after collection is 0/,
  ],
  [
    "sessions were collected too",
    (w) => collectOf(w, (r) => (r.after.sessions = [])),
    /sessions changed in the collection/,
  ],
  [
    "the token had expired (expiry confounds pruning)",
    (w) => {
      w.proof.continuation.header.expiry = START;
      w.requests[1].query.cursor = tokenOf({
        boundary: 5,
        expiry: START,
        revision: 9,
        index: 3,
      });
      w.requests[0].next_cursor = w.requests[1].query.cursor;
      w.proof.continuation.token_sha256 = sha(w.requests[1].query.cursor);
    },
    /had expired/,
  ],
  [
    "the control account's floor moved",
    (w) => collectOf(w, (r) => (r.after.accounts[0].sync_floor = 3)),
    /control account's floor changed/,
  ],
  [
    "the control account's continuation was refused",
    (w) => (w.proof.control_account.probe_after.status = 410),
    /control account's continuation was not answered 200/,
  ],
  [
    "the control probe used another continuation",
    (w) => (w.proof.control_account.probe_after.token_sha256 = "0".repeat(64)),
    /not the control account's continuation/,
  ],
  [
    "the control account is the reader",
    (w) => (w.proof.control_account.account = "reader"),
    /control account is the reader|control account's/,
  ],
  [
    "an injected 410",
    (w) => (w.requests[1].delivered = { injected: "x", status: 410 }),
    /altered by the tap/,
  ],
  [
    "the gate opened before the collection was acknowledged",
    (w) => (w.requests[1].t_gate_open = 2000.5),
    /forwarded before the control command's acknowledgement/,
  ],
]) {
  test(`X2 refused: ${name}`, () => {
    const w = x2World();
    edit(w);
    const found = x2(w);
    assert.ok(
      found.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(found)}`,
    );
  });
}
test("X2 refused: a clock step anywhere in the attempt confounds pruning", () => {
  const w = x2World();
  retranscribe(w, (entries) => {
    const at = entries.findIndex(
      (e) => e.stream === "stdin" && JSON.parse(e.line).op === "shutdown",
    );
    entries.splice(at, 0, {
      at: 2500,
      stream: "stdin",
      line: JSON.stringify({
        attempt: "att-1",
        seq: 0,
        op: "advance_clock",
        args: { time: E },
      }),
    });
  });
  assert.ok(x2(w).some((p) => /moved the clock/.test(p)));
});

// ---- the attempt envelope ---------------------------------------------------------------------------------------------------------
for (const [name, edit, expected] of [
  [
    "the transcript's bytes changed after the envelope was written",
    (w) =>
      retranscribe(
        w,
        (en) => en.push({ at: 4000, stream: "stderr", line: "late" }),
        { keepHash: true },
      ),
    /transcript's bytes are not the ones/,
  ],
  [
    "a missing transcript",
    (w) => w.files.delete("att/transcript.jsonl"),
    /cannot be re-read/,
  ],
  [
    "a partial collection answered ok:false",
    (w) =>
      retranscribe(w, () =>
        setAnswer(w, 6, (a) =>
          Object.assign(a, { ok: false, effect: "partial", partial: {} }),
        ),
      ),
    /failed|effect partial/,
  ],
  [
    "an unknown effect",
    (w) =>
      retranscribe(w, () => setAnswer(w, 4, (a) => (a.effect = "unknown"))),
    /effect unknown/,
  ],
  [
    "an answer with ownership lost",
    (w) =>
      retranscribe(w, () => setAnswer(w, 5, (a) => (a.ownership_lost = true))),
    /ownership lost/,
  ],
  [
    "an ownership-lost event",
    (w) =>
      retranscribe(w, (en) =>
        en.splice(1, 0, {
          at: 12,
          stream: "stdout",
          line: JSON.stringify({ event: "ownership_lost", error: "x" }),
        }),
      ),
    /answer no command/,
  ],
  [
    "a rejected line",
    (w) =>
      retranscribe(w, (en) => {
        const at = en.findIndex((e) => e.stream === "stdin");
        en.splice(at + 2, 0, {
          at: 1001.5,
          stream: "stdout",
          line: JSON.stringify({ event: "rejected", error: "expected seq 2" }),
        });
      }),
    /has 2 answers/,
  ],
  [
    "served:false (an incomplete drain)",
    (w) =>
      retranscribe(w, (en) => {
        const e = en.findLast((x) => x.stream === "stdout");
        const v = JSON.parse(e.line);
        v.served = false;
        e.line = JSON.stringify(v);
      }),
    /served:false/,
  ],
  [
    "a clean-up error",
    (w) =>
      retranscribe(w, (en) => {
        const e = en.findLast((x) => x.stream === "stdout");
        const v = JSON.parse(e.line);
        v.cleanup_error = "not empty";
        e.line = JSON.stringify(v);
      }),
    /clean-up error/,
  ],
  [
    "a stopped that removed nothing",
    (w) =>
      retranscribe(w, (en) => {
        const e = en.findLast((x) => x.stream === "stdout");
        const v = JSON.parse(e.line);
        v.removed = null;
        e.line = JSON.stringify(v);
      }),
    /did not remove fixture\.sqlite/,
  ],
  [
    "no sequenced shutdown (EOF)",
    (w) => retranscribe(w, (en) => en.splice(-2, 2)),
    /not ended by its sequenced shutdown/,
  ],
  [
    "a shutdown that kept the fixture",
    (w) =>
      retranscribe(w, (en) => {
        const e = en.findLast((x) => x.stream === "stdin");
        const v = JSON.parse(e.line);
        v.args.remove = false;
        e.line = JSON.stringify(v);
      }),
    /did not ask for removal/,
  ],
  [
    "a refused HTTP admission on stderr",
    (w) =>
      retranscribe(w, (en) =>
        en.push({
          at: 3002,
          stream: "stderr",
          line: '{"event":"diagnostic_http","phase":"refused","method":"GET","path":"/x"}',
        }),
      ),
    /refused HTTP admission/,
  ],
  [
    "a sequence gap",
    (w) =>
      retranscribe(w, (en) => {
        const e = en.find(
          (x) => x.stream === "stdin" && JSON.parse(x.line).seq === 4,
        );
        const v = JSON.parse(e.line);
        v.seq = 40;
        e.line = JSON.stringify(v);
      }),
    /has seq 40, expected 4/,
  ],
  [
    "an account created after setup ended",
    (w) =>
      retranscribe(w, (en) => {
        const at = en.findIndex(
          (e) => e.stream === "stdin" && JSON.parse(e.line).op === "shutdown",
        );
        en.splice(
          at,
          0,
          {
            at: 2900,
            stream: "stdin",
            line: JSON.stringify({
              attempt: "att-1",
              seq: 9,
              op: "add_account",
              args: { username: "late" },
            }),
          },
          {
            at: 2901,
            stream: "stdout",
            line: JSON.stringify({
              attempt: "att-1",
              seq: 9,
              op: "add_account",
              ok: true,
              result: { account: "late" },
              effect: "applied",
              sync_now: E,
            }),
          },
        );
        const s = en.find(
          (e) => e.stream === "stdin" && JSON.parse(e.line).op === "shutdown",
        );
        const v = JSON.parse(s.line);
        v.seq = 10;
        s.line = JSON.stringify(v);
        const st = en.findLast((x) => x.stream === "stdout");
        const sv = JSON.parse(st.line);
        sv.seq = 10;
        st.line = JSON.stringify(sv);
      }),
    /add_account after setup ended/,
  ],
  [
    "a command the spec's calls do not account for",
    (w) => w.envelope.spec_calls.splice(0, 1),
    /not one of the spec's recorded calls/,
  ],
  [
    "a spec call the transcript does not hold",
    (w) =>
      w.envelope.spec_calls.push({ op: "collect", seq: 99, outcome: "ok" }),
    /does not hold/,
  ],
  [
    "a spec call that failed",
    (w) => (w.envelope.spec_calls[0].outcome = "CommandFailed"),
    /call ended CommandFailed/,
  ],
  [
    "an account that is not its add_account's answer",
    (w) => (w.envelope.accounts["pair-writer"].account_id = "someone"),
    /not the answer of add_account/,
  ],
  [
    "a latched attempt",
    (w) => (w.envelope.latched = { kind: "no_acknowledgement" }),
    /attempt latched/,
  ],
  [
    "a non-zero exit",
    (w) => (w.envelope.exit = { code: 1, signal: null }),
    /exited/,
  ],
  [
    "a fixture left behind",
    (w) => (w.envelope.fixture_after = { leaf_exists: true }),
    /still exists/,
  ],
  [
    "an ATLAS_ variable passed to the child",
    (w) => w.envelope.env_keys.push("ATLAS_IT_x"),
    /ATLAS_ variable/,
  ],
  [
    "a refused ready receipt",
    (w) => w.envelope.ready_problems.push("receipt pid"),
    /ready receipt was refused/,
  ],
  [
    "another selection",
    (w) => (w.envelope.selection_identity = "other"),
    /approved diagnostic selection/,
  ],
  [
    "another executable",
    (w) => (w.envelope.executable.sha256 = "0".repeat(64)),
    /staged executable is not the approved one/,
  ],
  [
    "a receipt copy that differs",
    (w) => w.files.set("att/receipt.json", Buffer.from("{}")),
    /receipt\.json copy is not the ready receipt/,
  ],
  [
    "another envelope schema",
    (w) => (w.envelope.schema = "web09c-diagnostic-attempt/0"),
    /schema/,
  ],
]) {
  test(`attempt refused: ${name}`, () => {
    const w = x0World();
    edit(w);
    attemptRefused(w, expected);
  });
}

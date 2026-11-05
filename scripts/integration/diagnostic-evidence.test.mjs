// WEB-09c revision 26 (R26-DIAG; design assessment Q5): the diagnostic evidence reader. Hand-built VALID X0 and X2 attempts (transcript
// bytes, receipt copy, tap records, probe bodies, proof), then independent omissions, misbindings and substitutions, each refused even
// though "the browser passed". Nothing here launches anything.
//
// Revision 27 (R27-DIAG.a): the reader orders events by the attempt's CAUSAL JOURNAL, never by timestamps. The hand-built worlds below keep
// artificial times only as the GENERATOR's statement of the intended causal order: `finalise` turns them into a real journal (the
// maintained createJournal), writes every position into the transcript, the tap records, the bridge calls and the spec's markers, and
// re-hashes the files. A negative edits an intended order and finalises again; journal-level negatives edit the journal itself.
// The composed controls with the runner's real factories and DEFAULT clocks are in diagnostic-compose.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createJournal } from "./causal-journal.mjs";
import {
  ATTEMPT_SCHEMA,
  attemptJournal,
  attemptProblems,
  exchangesOf,
  PROOF_SCHEMA,
  PROOF_VALIDATORS,
  proofExchanges,
  retentionProblems,
  syncTraffic,
  x0Problems,
  x2Problems,
} from "./diagnostic-evidence.mjs";
import {
  concludeAttempt,
  GUARD_METHOD,
  RETAINED_SCHEMA,
} from "./diagnostic-fixture.mjs";
import { assembleInterval, CAUSAL_FIELDS } from "./pair-evidence.mjs";

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
// Revision 37 (R37-DIAG): the paths of the tap's records (the real ones carry a method and a path; the worlds below do too).
const SYNC_PATH = "/api/experimental/v1/sync";
const PEOPLE_PATH = "/api/experimental/v1/people/P1";
const GRANT_PATH = "/api/experimental/v1/access-commands";

/**
 * Writes the world's journal from its intended order (artificial times, ties in insertion order): every transcript entry, every tap
 * record's arrival / gate opening / upstream end, every bridge call and answer, and the markers (each probe's `<label>:begin|end` from its
 * `at_sent`/`at_answered`, X2's drain and grant from the proof's times, and any `w.markTimes`). Idempotent: it rebuilds from the times.
 */
function finalise(w) {
  const evs = [];
  let order = 0;
  const add = (t, producer, kind, ref, apply) => {
    if (typeof t !== "number") return;
    evs.push({ t, order: order++, producer, kind, ref, apply });
  };
  for (const e of w.entries) {
    let ref = { n: e.n };
    if (e.stream === "stdin")
      try {
        const v = JSON.parse(e.line);
        ref = { n: e.n, seq: v.seq, op: v.op };
      } catch {
        // a malformed line keeps its number only
      }
    add(e.at, "control", e.stream, ref, (j) => {
      e.j = j;
    });
  }
  for (const r of w.requests ?? []) {
    add(r.t_request, "tap", "request", { seq: r.seq }, (j) => {
      r.j_request = j;
    });
    add(r.t_gate_open, "tap", "gate_open", { seq: r.seq }, (j) => {
      r.j_gate_open = j;
    });
    add(
      r.t_upstream_end,
      "tap",
      "upstream_end",
      { seq: r.seq, status: r.status },
      (j) => {
        r.j_upstream_end = j;
      },
    );
  }
  for (const c of w.envelope.spec_calls ?? []) {
    add(c.at_request, "bridge", "call", { op: c.op }, (j) => {
      c.j_request = j;
    });
    add(
      c.at_answer,
      "bridge",
      "answer",
      { op: c.op, seq: c.seq, outcome: c.outcome },
      (j) => {
        c.j_answer = j;
      },
    );
  }
  const prefix = w.proof?.mark_prefix ?? "x";
  const marks = { ...(w.markTimes ?? {}) };
  for (const probe of [
    ...Object.values(w.proof?.probes ?? {}),
    w.proof?.control_account?.probe_after,
  ])
    if (probe?.label) {
      marks[`${probe.label}:begin`] = probe.at_sent;
      marks[`${probe.label}:end`] = probe.at_answered;
    }
  if (typeof w.proof?.drained_before_grant_at === "number") {
    marks.drain_complete = w.proof.drained_before_grant_at;
    marks.grant_begin = w.proof.grant_at - 1;
    marks.grant_end = w.proof.grant_at;
  }
  if (w.proof) w.proof.marks = {};
  w.envelope.spec_marks = [];
  for (const [name, t] of Object.entries(marks))
    add(t, "bridge", "mark", { name: `${prefix}:${name}` }, (j) => {
      if (w.proof) w.proof.marks[name] = j;
      w.envelope.spec_marks.push({ name: `${prefix}:${name}`, j });
    });
  evs.sort((a, b) => a.t - b.t || a.order - b.order);
  const lines = [];
  let now = 0;
  const journal = createJournal({
    attempt: w.envelope.attempt,
    append: (line) => lines.push(line),
    now: () => now,
  });
  for (const e of evs) {
    now = e.t;
    e.apply(journal.record(e.producer, e.kind, e.ref));
  }
  const bytes = Buffer.from(
    `${w.entries.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  w.files.set("att/transcript.jsonl", bytes);
  if (!w.keepHash) w.envelope.transcript.sha256 = sha(bytes);
  const jb = Buffer.from(lines.join(""));
  w.files.set("att/journal.jsonl", jb);
  w.envelope.journal = {
    file: "att/journal.jsonl",
    sha256: sha(jb),
    ...journal.state(),
  };
  w.events = attemptJournal(w.envelope, w.readFile).events;
  return w;
}
/** The world as the runner would hand it to a proof validator. */
const ctxOf = (w) => ({
  attempt: w.envelope,
  entries: w.entries,
  requests: w.requests,
  journal: w.events,
  readFile: (f) => w.readFile(`bodies/${f}`),
});
const ready = (w) => (w.frozen ? w : finalise(w));

/**
 * Revision 34 (R34-RET): the record a VERIFIED materialisation writes (diagnostic-fixture.mjs `materialiseRetained`), for these synthetic
 * envelopes (database identity 1/3 as the transcript's receipt parses it). Its real production from anchored SQLite files is qualified in
 * diagnostic-fixture.test.mjs; here only the reader is judged.
 * Revision 35 (R35-RET): /2 — the guarded anchors of the removed source (database + the WAL the reader guard held), with the guard's proof.
 */
function retainedRecord(attempt, receiptSha256) {
  const database = {
    name: "fixture.sqlite",
    dev: "1",
    ino: "3",
    size: "8192",
    sha256: "a".repeat(64),
  };
  const wal = {
    name: "fixture.sqlite-wal",
    dev: "1",
    ino: "6",
    size: "4152",
    sha256: "f".repeat(64),
  };
  return {
    schema: RETAINED_SCHEMA,
    attempt,
    status: "verified",
    dir: `/retained/retained-${attempt}`,
    source: `/t/fixture-${attempt}`,
    anchors: [
      database,
      {
        name: "receipt.json",
        dev: "1",
        ino: "4",
        size: "700",
        sha256: receiptSha256,
      },
      wal,
    ],
    quiescence: {
      exit: { code: 0, signal: null },
      stopped_seq: 9,
      removed: [
        "fixture.sqlite",
        "fixture.sqlite-wal",
        "fixture.sqlite-shm",
        "receipt.json",
      ],
    },
    guard: {
      acquired: {
        // Revision 36 (R36-RET): /2 guard method, bound to the attempt's authority, opened through its private name.
        method: GUARD_METHOD,
        held: true,
        attempt,
        receipt_sha256: receiptSha256,
        namespace: "private",
        private_dir: { path: `/retained/guard-${attempt}`, dev: "1", ino: "7" },
        opened: { name: "guard.sqlite", dev: "1", ino: "3" },
        journal_mode: "wal",
        database: { dev: "1", ino: "3" },
        wal: { dev: "1", ino: "6" },
      },
      release: {
        released: true,
        lost: false,
        exit_observed_before_release: true,
        exit: { code: 0, signal: null },
        problems: [],
      },
    },
    selection: {
      method: "guarded-anchors",
      wal_generation: "guarded",
      files: [
        { ...database, origin: "anchor" },
        { ...wal, origin: "anchor" },
      ],
    },
    inspect: {
      file: "inspect.sqlite",
      sha256: "b".repeat(64),
      integrity: "ok",
      tables: { accounts: 2 },
    },
    manifest: { file: "manifest.json", sha256: "c".repeat(64) },
    problems: [],
  };
}

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
          // Revision 35: under the reader guard the executable's removal finds the WAL and its index (SQLite could not retire them).
          removed: [
            "fixture.sqlite",
            "fixture.sqlite-wal",
            "fixture.sqlite-shm",
            "receipt.json",
          ],
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
    schema: ATTEMPT_SCHEMA,
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
    retention: retainedRecord(attempt, sha(receiptBytes)),
  };
  const w = {
    files,
    envelope,
    entries: lines,
    readFile: (f) => {
      if (!files.has(f)) throw new Error(`ENOENT ${f}`);
      return files.get(f);
    },
  };
  return w;
}
/** Re-serialises a world's transcript after `edit(entries)` (the envelope's hash follows unless `keepHash`). */
function retranscribe(w, edit, { keepHash = false } = {}) {
  if (keepHash) finalise(w);
  edit(w.entries);
  w.entries.forEach((e, i) => {
    e.n = i + 1;
  });
  if (keepHash) w.keepHash = true;
  return w;
}
const accountAnswer = (id) => ({ result: { account: id } });
const attemptOk = (w) =>
  assert.deepEqual(
    attemptProblems(ready(w).envelope, {
      readFile: w.readFile,
      expected: EXPECTED,
    }),
    [],
  );
const attemptRefused = (w, expected) => {
  const found = attemptProblems(ready(w).envelope, {
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
    caller: "ordinary",
    mark_prefix: "x0",
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
        at_answered: 2012.5,
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
const x0 = (w) => x0Problems(w.proof, ctxOf(ready(w)));

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
      100,
      101,
    ],
    [
      "add_account",
      { username: "pair-pair-x2", password: "[redacted]" },
      accountAnswer("reader"),
      102,
      103,
    ],
    [
      "add_account",
      { username: "pair-x2-control", password: "[redacted]" },
      accountAnswer("control"),
      104,
      105,
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
      method: "GET",
      path: SYNC_PATH,
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
      method: "GET",
      path: SYNC_PATH,
      status: 410,
      code: "resync_required",
      gated: true,
      query: { cursor: token },
      t_request: 1950,
      t_gate_open: 2020,
      t_upstream_end: 2025,
    },
    // Revision 37 (R37-DIAG; design assessment C2): the grant's own two public requests (tests/pair/support.ts `access`: the person's
    // policy version, then the access command), INSIDE the grant's bracket (599 to 600), after the drain (500) and before the target's
    // inspection (650) and ageing (700/701), as the real X2 attempt recorded them (drain, grant begin, GET, POST, grant end, age).
    {
      seq: 26,
      method: "GET",
      path: PEOPLE_PATH,
      status: 200,
      t_request: 599.2,
      t_upstream_end: 599.4,
    },
    {
      seq: 27,
      method: "POST",
      path: GRANT_PATH,
      status: 200,
      t_request: 599.6,
      t_upstream_end: 599.8,
    },
  ];
  const proof = {
    schema: PROOF_SCHEMA,
    case: "PAIR-X2",
    caller: "ordinary",
    mark_prefix: "x2",
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
const x2 = (w) => x2Problems(w.proof, ctxOf(ready(w)));

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
    (w) => {
      finalise(w).frozen = true;
      w.files.delete("att/transcript.jsonl");
    },
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

// ---- revision 34 (R34-RET): a complete attempt's fixture is retained VERIFIED -------------------------------------------------------
test("R34-RET: a complete attempt with its verified retention is accepted (positive control)", () => {
  attemptOk(x0World());
});
for (const [name, edit, expected] of [
  [
    "no retention recorded",
    (w) => delete w.envelope.retention,
    /retention: the attempt records no retained fixture/,
  ],
  [
    "a retention anchored but not verified (the exit not observed)",
    (w) => {
      w.envelope.retention.status = "anchored_unverified";
      w.envelope.retention.quiescence.exit = null;
    },
    /retention: the fixture is not retained verified \(anchored_unverified\)/,
  ],
  [
    "a retention judged before the executable's exit",
    (w) => (w.envelope.retention.quiescence.exit = null),
    /retention: the retained fixture was judged before the executable's exit/,
  ],
  [
    "a failed materialisation",
    (w) => {
      w.envelope.retention.status = "failed";
      w.envelope.retention.problems = ["writing the manifest: ENOSPC"];
    },
    /retention: the fixture is not retained verified \(failed\): writing the manifest: ENOSPC/,
  ],
  [
    "a retained database that is not the receipt's file",
    (w) => (w.envelope.retention.anchors[0].ino = "99"),
    /retention: the retained database is not the receipt's file/,
  ],
  [
    "no retained database",
    (w) => w.envelope.retention.anchors.shift(),
    /retention: the retained database is not the receipt's file/,
  ],
  [
    "a retained receipt that is not the ready receipt",
    (w) => (w.envelope.retention.anchors[1].sha256 = "d".repeat(64)),
    /retention: the retained receipt is not the ready receipt/,
  ],
  [
    "a retained file the fixture does not own",
    (w) =>
      w.envelope.retention.anchors.push({
        name: "other.db",
        dev: "1",
        ino: "5",
        size: "1",
        sha256: "e".repeat(64),
      }),
    /retention: other\.db is retained, but the fixture does not own it/,
  ],
  [
    "a file anchored twice",
    (w) =>
      w.envelope.retention.anchors.push({ ...w.envelope.retention.anchors[0] }),
    /retention: a retained file is anchored twice/,
  ],
  [
    "an anchor with no final hash",
    (w) => delete w.envelope.retention.anchors[0].sha256,
    /retention: the retained fixture\.sqlite has no final hash/,
  ],
  [
    "no intact inspectable copy",
    (w) => (w.envelope.retention.inspect = null),
    /retention: the retained fixture has no intact inspectable copy/,
  ],
  [
    "an unsealed manifest",
    (w) => (w.envelope.retention.manifest = null),
    /retention: the retained fixture's manifest is not sealed/,
  ],
  [
    "another retention schema",
    (w) => (w.envelope.retention.schema = "web09c-diagnostic-retained/0"),
    /retention: retention schema/,
  ],
  [
    "a retention naming another attempt",
    (w) => (w.envelope.retention.attempt = "att-2"),
    /retention: the retained fixture names another attempt/,
  ],
  [
    "a revision-33 envelope (schema /2, no retention)",
    (w) => {
      w.envelope.schema = "web09c-diagnostic-attempt/2";
      delete w.envelope.retention;
    },
    /never upgraded/,
  ],
])
  test(`R34-RET attempt refused: ${name}`, () => {
    const w = x0World();
    edit(w);
    attemptRefused(w, expected);
  });
// ---- revision 35 (R35-RET; design assessment T3): the retention must name its ONE SQLite state and justify it -----------------------
const r35 = (w) => w.envelope.retention;
const selectedWal = (w) =>
  r35(w).selection.files.find((f) => f.name === "fixture.sqlite-wal");
const stoppedLine = (en) => en.findLast((x) => x.stream === "stdout");
for (const [name, edit, expected] of [
  [
    "a revision-34 retention (schema /1, no selection)",
    (w) => {
      r35(w).schema = "web09c-diagnostic-retained/1";
      delete r35(w).selection;
      delete r35(w).guard;
    },
    /retention: retention schema "web09c-diagnostic-retained\/1"/,
  ],
  [
    "no selection (a self-consistent record that never says which state it is)",
    (w) => delete r35(w).selection,
    /retention: the retention does not name how its one SQLite state was selected \(null\)/,
  ],
  [
    "an unknown selection method",
    (w) => (r35(w).selection.method = "latest-inode"),
    /does not name how its one SQLite state was selected \("latest-inode"\)/,
  ],
  [
    "the review's stale schedule: the anchored WAL replayed for a removed source with NO guard",
    (w) => delete r35(w).guard,
    /retention: no reader guard was held before the anchor/,
  ],
  [
    "a guard that was not held",
    (w) => (r35(w).guard.acquired.held = false),
    /retention: no reader guard was held before the anchor/,
  ],
  [
    "a guard of another method",
    (w) => (r35(w).guard.acquired.method = "other/1"),
    /retention: no reader guard was held before the anchor/,
  ],
  [
    "a guard on another database",
    (w) => (r35(w).guard.acquired.database = { dev: "1", ino: "99" }),
    /retention: the guard held another database than the receipt's/,
  ],
  [
    "a selected WAL that is not the generation the guard held",
    (w) => (r35(w).guard.acquired.wal = { dev: "1", ino: "77" }),
    /retention: the selected WAL is not the anchored generation the guard held/,
  ],
  [
    "a selected WAL whose bytes are not its anchor's",
    (w) => (selectedWal(w).sha256 = "e".repeat(64)),
    /retention: the selected fixture\.sqlite-wal is not its anchor/,
  ],
  [
    "no selected WAL",
    (w) =>
      (r35(w).selection.files = r35(w).selection.files.filter(
        (f) => f.name !== "fixture.sqlite-wal",
      )),
    /retention: the selected WAL is not the anchored generation the guard held/,
  ],
  [
    "a rollback journal selected beside the guarded WAL",
    (w) =>
      r35(w).selection.files.push({
        name: "fixture.sqlite-journal",
        dev: "1",
        ino: "8",
        sha256: "9".repeat(64),
        origin: "anchor",
      }),
    /retention: a rollback journal is selected beside the guarded WAL/,
  ],
  [
    "a selected database that is not the receipt's anchor",
    (w) => (r35(w).selection.files[0].sha256 = "e".repeat(64)),
    /retention: the selected database is not the receipt's anchored file/,
  ],
  [
    "a guard lost before its release",
    (w) => (r35(w).guard.release.lost = true),
    /retention: the guard was lost or not released/,
  ],
  [
    "a guard never released",
    (w) => (r35(w).guard.release.released = false),
    /retention: the guard was lost or not released/,
  ],
  [
    "a guard released before the exit",
    (w) => (r35(w).guard.release.exit_observed_before_release = false),
    /retention: the guard was released before the executable's exit/,
  ],
  [
    "a removal that did not find the guarded WAL (both records agree)",
    (w) => {
      const drop = (list) => list.filter((n) => n !== "fixture.sqlite-wal");
      r35(w).quiescence.removed = drop(r35(w).quiescence.removed);
      retranscribe(w, (en) => {
        const e = stoppedLine(en);
        const v = JSON.parse(e.line);
        v.removed = drop(v.removed);
        e.line = JSON.stringify(v);
      });
    },
    /retention: the executable's removal did not find the guarded WAL/,
  ],
  [
    "a retention whose removal is not the transcript's stopped removal",
    (w) => r35(w).quiescence.removed.pop(),
    /retention: its removal is not the transcript's stopped removal/,
  ],
  [
    "a removed source retained as its final names",
    (w) => {
      r35(w).selection.method = "final-named-after-exit";
      for (const f of r35(w).selection.files)
        if (f.name !== "fixture.sqlite") f.origin = "final";
    },
    /retention: a removed fixture is not retained as its guarded anchors/,
  ],
  [
    "a file selected twice",
    (w) => r35(w).selection.files.push({ ...r35(w).selection.files[0] }),
    /retention: a file is selected twice/,
  ],
  [
    "a selected file that is not SQLite state",
    (w) =>
      r35(w).selection.files.push({
        name: "receipt.json",
        dev: "1",
        ino: "4",
        sha256: "1".repeat(64),
        origin: "anchor",
      }),
    /retention: receipt\.json is selected, but it is not SQLite state/,
  ],
])
  test(`R35-RET attempt refused: ${name}`, () => {
    const w = x0World();
    edit(w);
    attemptRefused(w, expected);
  });
test("R35-RET: a kept source's final-named retention is internally valid (its attempt fails only on the kept fixture and its removal)", () => {
  const w = x0World();
  const r = r35(w);
  r.selection.method = "final-named-after-exit";
  r.selection.wal_generation = "replaced";
  for (const f of r.selection.files)
    if (f.name !== "fixture.sqlite") f.origin = "final";
  r.quiescence.removed = null;
  assert.deepEqual(
    retentionProblems(r, {
      attempt: w.envelope.attempt,
      receipt: { database: { dev: "1", ino: "3" } },
      receiptSha256: r.anchors[1].sha256,
    }),
    [],
  );
  r.selection.files[1].origin = "anchor";
  assert.deepEqual(
    retentionProblems(r, {
      attempt: w.envelope.attempt,
      receipt: { database: { dev: "1", ino: "3" } },
      receiptSha256: r.anchors[1].sha256,
    }),
    ["the kept fixture.sqlite-wal was not read from the final state"],
  );
  r.quiescence.removed = ["fixture.sqlite"];
  assert.ok(
    retentionProblems(r, {
      attempt: w.envelope.attempt,
      receipt: { database: { dev: "1", ino: "3" } },
      receiptSha256: r.anchors[1].sha256,
    }).includes(
      "the source was removed, so its final names cannot be the selection",
    ),
  );
});
// ---- revision 36 (R36-RET): the guard's proof bound to the attempt's authority; the `retired-into-database` selection -------------------
for (const [name, edit, expected] of [
  [
    "a guard bound to another attempt",
    (w) => (r35(w).guard.acquired.attempt = "another-attempt"),
    /retention: the guard was bound to another attempt or receipt/,
  ],
  [
    "a guard bound to another receipt digest",
    (w) => (r35(w).guard.acquired.receipt_sha256 = "0".repeat(64)),
    /retention: the guard was bound to another attempt or receipt/,
  ],
  [
    "a guard that opened the fixture's own name (revision 35's namespace)",
    (w) => (r35(w).guard.acquired.namespace = "fixture"),
    /retention: the guard did not open the receipt's database through its private name/,
  ],
  [
    "a guard whose opened file is not the receipt's database",
    (w) =>
      (r35(w).guard.acquired.opened = {
        name: "guard.sqlite",
        dev: "1",
        ino: "99",
      }),
    /retention: the guard did not open the receipt's database through its private name/,
  ],
  [
    "a revision-35 guard (method sqlite-shared-reader/1)",
    (w) => (r35(w).guard.acquired.method = "sqlite-shared-reader/1"),
    /retention: no reader guard was held before the anchor/,
  ],
  [
    "a revision-35 retention (schema /2)",
    (w) => (r35(w).schema = "web09c-diagnostic-retained/2"),
    /retention: retention schema "web09c-diagnostic-retained\/2"/,
  ],
  [
    "a removed source retained as its retired database (valid, but not the guarded anchors a complete attempt needs)",
    (w) => {
      const r = r35(w);
      r.selection = {
        method: "retired-into-database",
        wal_generation: "retired",
        files: [r.selection.files[0]],
        corroboration: {
          database: "d".repeat(64),
          with_wal: "d".repeat(64),
          equal: true,
        },
      };
    },
    /retention: a removed fixture is not retained as its guarded anchors/,
  ],
])
  test(`R36-RET attempt refused: ${name}`, () => {
    const w = x0World();
    edit(w);
    attemptRefused(w, expected);
  });
/** A `retired-into-database` retention (diagnostic-fixture.mjs): the removal found no WAL; the anchored database alone, corroborated. */
function retiredRecord(w) {
  const r = structuredClone(r35(w));
  r.quiescence.removed = [
    "fixture.sqlite",
    "fixture.sqlite-shm",
    "receipt.json",
  ];
  r.selection = {
    method: "retired-into-database",
    wal_generation: "retired",
    files: [{ ...r.selection.files[0] }],
    corroboration: {
      database: "d".repeat(64),
      with_wal: "d".repeat(64),
      equal: true,
    },
  };
  return r;
}
test("R36-RET: a retired-into-database retention is accepted by the reader only with its removal and corroboration", () => {
  const w = x0World();
  const judge = (r) =>
    retentionProblems(r, {
      attempt: w.envelope.attempt,
      receipt: { database: { dev: "1", ino: "3" } },
      receiptSha256: r35(w).anchors[1].sha256,
    });
  assert.deepEqual(judge(retiredRecord(w)), [], "positive control");
  // No WAL anchored at all: the corroboration has nothing to replay (with_wal null).
  const noWal = retiredRecord(w);
  noWal.anchors = noWal.anchors.filter((a) => a.name !== "fixture.sqlite-wal");
  noWal.selection.corroboration.with_wal = null;
  assert.deepEqual(
    judge(noWal),
    [],
    "positive control without an anchored WAL",
  );
  for (const [why, edit, want] of [
    [
      "a removal that found the WAL",
      (r) => r.quiescence.removed.push("fixture.sqlite-wal"),
      "a retired WAL needs the executable's removal of the database without a WAL or journal",
    ],
    [
      "a removal that found a journal",
      (r) => r.quiescence.removed.push("fixture.sqlite-journal"),
      "a retired WAL needs the executable's removal of the database without a WAL or journal",
    ],
    [
      "no removal",
      (r) => (r.quiescence.removed = null),
      "a retired WAL needs the executable's removal of the database without a WAL or journal",
    ],
    [
      "a removal that did not find the database",
      (r) => (r.quiescence.removed = ["receipt.json"]),
      "a retired WAL needs the executable's removal of the database without a WAL or journal",
    ],
    [
      "the anchored WAL selected too",
      (r) => r.selection.files.push({ ...r35(w).selection.files[1] }),
      "a retired WAL's selection is the anchored database alone",
    ],
    [
      "an uncorroborated selection",
      (r) => (r.selection.corroboration.equal = false),
      "the retired WAL is not corroborated: replaying the anchored WAL must change no content",
    ],
    [
      "a corroboration whose replayed content differs",
      (r) => (r.selection.corroboration.with_wal = "e".repeat(64)),
      "the retired WAL is not corroborated: replaying the anchored WAL must change no content",
    ],
    [
      "a corroboration that never replayed the anchored WAL",
      (r) => (r.selection.corroboration.with_wal = null),
      "the retired WAL is not corroborated: replaying the anchored WAL must change no content",
    ],
    [
      "no corroboration",
      (r) => delete r.selection.corroboration,
      "the retired WAL is not corroborated: replaying the anchored WAL must change no content",
    ],
  ]) {
    const r = retiredRecord(w);
    edit(r);
    assert.ok(judge(r).includes(want), `${why}: ${JSON.stringify(judge(r))}`);
  }
  const journal = retiredRecord(w);
  journal.anchors.push({
    name: "fixture.sqlite-journal",
    dev: "1",
    ino: "8",
    size: "1",
    sha256: "9".repeat(64),
  });
  assert.ok(
    judge(journal).includes(
      "a rollback journal was anchored beside a retired WAL",
    ),
  );
});
test("R34-RET: a preliminary attempt may not already record a retention (it is made after the removal decision)", () => {
  const w = x0World();
  ready(w);
  const envelope = { ...w.envelope, shutdown: null };
  const found = attemptProblems(envelope, {
    readFile: w.readFile,
    expected: EXPECTED,
    stage: "preliminary",
  });
  assert.ok(
    found.includes("a preliminary attempt already records a retention"),
    JSON.stringify(found),
  );
});

// ---- revision 27 (R27-DIAG.a): the journal is the order; raw timestamps are diagnosis only ------------------------------------------
/** Rewrites the finalised journal file through `edit(lines)` (parsed events), re-hashing it unless `keepHash`; the world is frozen. */
function rejournal(w, edit, { keepHash = false, count = true } = {}) {
  finalise(w);
  const lines = String(w.files.get("att/journal.jsonl"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  edit(lines);
  const bytes = Buffer.from(
    lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
  );
  w.files.set("att/journal.jsonl", bytes);
  if (!keepHash) w.envelope.journal.sha256 = sha(bytes);
  if (count) w.envelope.journal.events = lines.length;
  w.events = attemptJournal(w.envelope, w.readFile).events;
  w.frozen = true;
  return w;
}
const both = (w) => [
  ...attemptProblems(w.envelope, { readFile: w.readFile, expected: EXPECTED }),
  ...x0Problems(w.proof, ctxOf(w)),
];

test("R27-DIAG.a: the review's mixed clocks pass when the causal order is right (tap times process-relative, transcript epoch)", () => {
  const w = finalise(x0World());
  w.frozen = true;
  // The runner's real domains: the tap's performance.now() (tens of ms since the process started), the transcript's Date.now().
  for (const [i, r] of w.requests.entries()) {
    r.t_request = 43.279334 + i;
    if (r.t_gate_open !== undefined) r.t_gate_open = 46.882709;
    if (r.t_upstream_end !== undefined) r.t_upstream_end = 47.1;
  }
  for (const e of w.entries) e.at = 1_793_564_239_000 + e.n;
  retranscribeFrozen(w);
  assert.deepEqual(both(w), []);
});
/** Re-serialises a frozen world's transcript (positions untouched) and re-hashes it. */
function retranscribeFrozen(w) {
  const bytes = Buffer.from(
    `${w.entries.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  w.files.set("att/transcript.jsonl", bytes);
  w.envelope.transcript.sha256 = sha(bytes);
}
test("R27-DIAG.a: equal raw ticks and a wall clock that steps BACKWARDS change nothing (the positions are the order)", () => {
  const same = rejournal(x0World(), (lines) => {
    for (const l of lines) l.at = 1_793_564_239_315;
  });
  assert.deepEqual(both(same), []);
  const back = rejournal(x0World(), (lines) => {
    lines.forEach((l, i) => {
      l.at = 2_000_000_000_000 - i * 1000;
    });
  });
  assert.deepEqual(both(back), []);
});
test("R27-DIAG.a: a CAUSAL inversion fails whatever the clocks say (the gate opened before the acknowledgement)", () => {
  const w = x0World();
  // The gate opening is moved before the E−1 command's acknowledgement in the intended order, and its raw time is left AFTER it.
  w.requests[1].t_gate_open = 2002.5;
  finalise(w).frozen = true;
  w.requests[1].t_gate_open = 99_999;
  assert.ok(
    x0(w).some((p) =>
      /forwarded before the control command's acknowledgement/.test(p),
    ),
    JSON.stringify(x0(w)),
  );
});
for (const [name, edit, expected] of [
  [
    "a gap (one event missing)",
    (lines) => lines.splice(5, 1),
    /a gap, a replay or a reorder/,
  ],
  [
    "a replayed event",
    (lines) => lines.splice(5, 0, { ...lines[5] }),
    /a gap, a replay or a reorder/,
  ],
  [
    "two events reordered",
    (lines) => {
      const [a] = lines.splice(3, 1);
      lines.splice(4, 0, a);
    },
    /a gap, a replay or a reorder/,
  ],
  [
    "an event of another attempt",
    (lines) => {
      lines[2].attempt = "att-2";
    },
    /belongs to attempt att-2/,
  ],
  [
    "an event without its raw clock",
    (lines) => {
      delete lines[2].clock;
    },
    /does not name its raw clock/,
  ],
  [
    "an unknown event kind",
    (lines) => {
      lines[2].kind = "guess";
    },
    /unknown event/,
  ],
  [
    "a transcript position that names a tap event",
    (lines) => {
      const at = lines.findIndex(
        (l) => l.producer === "control" && l.kind === "stdin",
      );
      const tapAt = lines.findIndex((l) => l.producer === "tap");
      [lines[at].producer, lines[at].kind, lines[at].ref] = [
        "tap",
        "request",
        { seq: 1 },
      ];
      [lines[tapAt].producer, lines[tapAt].kind] = ["control", "stdin"];
    },
    /a tap\.request, not a control\.stdin|names journal event/,
  ],
])
  test(`R27-DIAG.a journal refused: ${name}`, () => {
    const w = rejournal(x0World(), edit);
    const found = both(w);
    assert.ok(
      found.some((p) => expected.test(p)),
      JSON.stringify(found),
    );
  });
test("R27-DIAG.a journal refused: bytes changed after the envelope named them, a missing file, an incomplete journal", () => {
  const changed = rejournal(
    x0World(),
    (l) => l.push({ ...l.at(-1), j: l.length + 1 }),
    {
      keepHash: true,
      count: false,
    },
  );
  assert.ok(
    both(changed).some((p) => /journal's bytes are not the ones/.test(p)),
  );
  assert.ok(
    both(changed).some((p) => /holds \d+ events, the attempt recorded/.test(p)),
  );
  const missing = finalise(x0World());
  missing.frozen = true;
  missing.files.delete("att/journal.jsonl");
  assert.ok(
    attemptProblems(missing.envelope, {
      readFile: missing.readFile,
      expected: EXPECTED,
    }).some((p) => /causal journal cannot be (re-)?read/.test(p)),
  );
  for (const state of [
    { overflowed: true, complete: false },
    { write_errors: [{ j: 3, error: "ENOSPC" }], complete: false },
  ]) {
    const w = finalise(x0World());
    w.frozen = true;
    Object.assign(w.envelope.journal, state);
    assert.ok(
      attemptProblems(w.envelope, {
        readFile: w.readFile,
        expected: EXPECTED,
      }).some((p) => /journal is incomplete|could not be written/.test(p)),
      JSON.stringify(state),
    );
  }
});
test("R27-DIAG.a: a tap position that names another exchange, or a transcript entry with another's position, is refused", () => {
  const w = finalise(x0World());
  w.frozen = true;
  w.requests[1].j_gate_open = w.requests[1].j_request;
  assert.ok(
    x0(w).some((p) => /gate opening names journal event/.test(p)),
    JSON.stringify(x0(w)),
  );
  const t = finalise(x0World());
  t.frozen = true;
  [t.entries[3].j, t.entries[4].j] = [t.entries[4].j, t.entries[3].j];
  retranscribeFrozen(t);
  assert.ok(
    attemptProblems(t.envelope, {
      readFile: t.readFile,
      expected: EXPECTED,
    }).some((p) => /transcript entry \d+ names journal event/.test(p)),
  );
});
test("R27-DIAG.a: markers — a probe without its two markers, a marker of another case's prefix, a bridge call that does not bracket its command", () => {
  const unmarked = finalise(x0World());
  unmarked.frozen = true;
  delete unmarked.proof.marks["x0-e-minus-1:end"];
  assert.ok(x0(unmarked).some((p) => /E−1 probe is not bracketed/.test(p)));
  const prefixed = finalise(x0World());
  prefixed.frozen = true;
  prefixed.proof.mark_prefix = "x2";
  assert.ok(
    x0(prefixed).some((p) =>
      /markers are not named for its case|whose name is/.test(p),
    ),
  );
  const call = finalise(x0World());
  call.frozen = true;
  call.envelope.spec_calls[1].j_answer = call.envelope.spec_calls[1].j_request;
  assert.ok(
    attemptProblems(call.envelope, {
      readFile: call.readFile,
      expected: EXPECTED,
    }).some((p) =>
      /answer names journal event|does not bracket command/.test(p),
    ),
  );
});
test("R27-DIAG.a: a schema-1 envelope or proof is refused, never upgraded", () => {
  const w = finalise(x0World());
  w.frozen = true;
  w.envelope.schema = "web09c-diagnostic-attempt/1";
  assert.ok(
    attemptProblems(w.envelope, {
      readFile: w.readFile,
      expected: EXPECTED,
    }).some((p) => /never upgraded/.test(p)),
  );
  w.proof.schema = "web09c-diagnostic-proof/1";
  assert.ok(x0(w).some((p) => /not an X0 proof/.test(p)));
});

// ---- revision 27 (DA-DIAG-F): the preliminary validation before the shutdown --------------------------------------------------------
test("DA-DIAG-F: the attempt before its shutdown is valid at the preliminary stage, and not at the terminal one", () => {
  const w = x0World();
  w.entries.splice(-2, 2);
  w.envelope.shutdown = null;
  w.envelope.exit = null;
  w.envelope.fixture_after = null;
  // Revision 34: before the removal decision the runner has made no retention yet (it follows the shutdown).
  w.envelope.retention = null;
  finalise(w).frozen = true;
  assert.deepEqual(
    attemptProblems(w.envelope, {
      readFile: w.readFile,
      expected: EXPECTED,
      stage: "preliminary",
    }),
    [],
  );
  const terminal = attemptProblems(w.envelope, {
    readFile: w.readFile,
    expected: EXPECTED,
  });
  assert.ok(
    terminal.some((p) => /not ended by its sequenced shutdown/.test(p)),
  );
  // A preliminary record that already claims a shutdown, or holds one, is refused.
  w.envelope.shutdown = { requested_remove: true };
  assert.ok(
    attemptProblems(w.envelope, {
      readFile: w.readFile,
      expected: EXPECTED,
      stage: "preliminary",
    }).some((p) => /already records a shutdown/.test(p)),
  );
  const full = finalise(x0World());
  full.envelope.shutdown = null;
  full.frozen = true;
  assert.ok(
    attemptProblems(full.envelope, {
      readFile: full.readFile,
      expected: EXPECTED,
      stage: "preliminary",
    }).some((p) => /before the removal decision/.test(p)),
  );
});

// ---- revision 27 (R27-DIAG.b): the recovery-caller and local-work proofs --------------------------------------------------------------
/** XR0 from X0: the recovery caller (fence, re-arm, grant and sign-in markers before the schedule; its trace window). */
function xr0World() {
  const w = x0World();
  Object.assign(w.proof, {
    case: "PAIR-XR0",
    mark_prefix: "xr0",
    caller: "recovery",
    caller_evidence: {
      sign_in: "settled",
      trace_window: [
        { event: "request.issued", data: { klass: "recovery" } },
        { event: "request.issued", data: { klass: "recovery" } },
        { event: "data.recovery_finish", data: { result: "cleared" } },
      ],
    },
  });
  w.markTimes = {
    fence_recorded: 1500,
    hold_rearmed: 1510,
    grant_end: 1520,
    sign_in_begin: 1530,
  };
  return w;
}
const xr0 = (w) => x0Problems(w.proof, ctxOf(ready(w)));
test("XR0: the recovery caller's expiry proof is accepted", () => {
  assert.deepEqual(xr0(xr0World()), []);
  const w = finalise(xr0World());
  assert.deepEqual(
    attemptProblems(w.envelope, { readFile: w.readFile, expected: EXPECTED }),
    [],
  );
});
for (const [name, edit, expected] of [
  [
    "filed as the ordinary caller",
    (w) => (w.proof.caller = "ordinary"),
    /names the caller ordinary/,
  ],
  [
    "an X0 proof claiming the recovery caller",
    (w) => Object.assign(w.proof, { case: "PAIR-X0", mark_prefix: "x0" }),
    /names the caller recovery|markers? /,
  ],
  [
    "the hold re-armed after the grant",
    (w) => (w.markTimes.hold_rearmed = 1525),
    /not in that order/,
  ],
  [
    "the sign-in before the grant",
    (w) => (w.markTimes.sign_in_begin = 1515),
    /not in that order/,
  ],
  [
    "an ordinary request while fenced",
    (w) =>
      w.proof.caller_evidence.trace_window.splice(1, 0, {
        event: "request.issued",
        data: { klass: "ordinary" },
      }),
    /ordinary request was issued while fenced/,
  ],
  [
    "no recovery-class request",
    (w) => w.proof.caller_evidence.trace_window.splice(0, 2),
    /no recovery-class request/,
  ],
  [
    "the fence never cleared",
    (w) => w.proof.caller_evidence.trace_window.pop(),
    /did not finish by clearing the fence/,
  ],
  [
    "the sign-in failed",
    (w) => (w.proof.caller_evidence.sign_in = "failed: 401"),
    /sign-in ended failed/,
  ],
  [
    "the refusal requested before the sign-in began (not the caller's catch-up)",
    (w) => (w.markTimes.sign_in_begin = 1960),
    /not requested by the recovery caller|not in that order/,
  ],
])
  test(`XR0 refused: ${name}`, () => {
    const w = xr0World();
    edit(w);
    const found = xr0(w);
    assert.ok(
      found.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(found)}`,
    );
  });
test("XR2: the recovery caller's pruning proof is accepted, and refused as the ordinary caller", () => {
  const make = () => {
    const w = x2World();
    Object.assign(w.proof, {
      case: "PAIR-XR2",
      mark_prefix: "xr2",
      caller: "recovery",
      caller_evidence: {
        sign_in: "settled",
        trace_window: [
          { event: "request.issued", data: { klass: "recovery" } },
          { event: "data.recovery_finish", data: { result: "cleared" } },
        ],
      },
    });
    // The fence and the re-arm precede the drain; the sign-in follows the ageing and precedes every catch-up request.
    w.markTimes = {
      fence_recorded: 300,
      hold_rearmed: 310,
      sign_in_begin: 800,
    };
    return w;
  };
  const ok = finalise(make());
  assert.deepEqual(x2Problems(ok.proof, ctxOf(ok)), []);
  const w = make();
  w.proof.caller = "ordinary";
  assert.ok(
    x2Problems(w.proof, ctxOf(finalise(w))).some((p) =>
      /names the caller ordinary/.test(p),
    ),
  );
  const early = make();
  early.markTimes.sign_in_begin = 550;
  assert.ok(
    x2Problems(early.proof, ctxOf(finalise(early))).some((p) =>
      /not in that order/.test(p),
    ),
  );
});

/** XL0 from X0: the departed page's queued request (lost), the reloaded page's own request (refused), the local work and its table. */
function xl0World() {
  const w = x0World();
  const token = w.token;
  // The departed page's request: queued before the clock steps, forwarded after E, refused, reaching nobody.
  w.requests[1].seq = 21;
  const again = {
    seq: 22,
    status: 410,
    code: "resync_required",
    gated: true,
    query: { cursor: token },
    t_request: 2016,
    t_gate_open: 2020.5,
    t_upstream_end: 2026,
  };
  w.requests.push(again);
  const standing = {
    draft: {
      local_id: "L1",
      command_digest: "d".repeat(64),
      receipt_revision: 12,
      status: "acknowledged",
    },
    effects: [{ local_id: "L1", resource_id: "P1", receipt_revision: 12 }],
    resource_in_cache: 0,
    applied_revision: 8,
  };
  const settled = {
    draft: null,
    effects: [],
    resource_in_cache: 1,
    applied_revision: 13,
  };
  Object.assign(w.proof, {
    case: "PAIR-XL0",
    mark_prefix: "xl0",
    lost: { tap_seq: 21 },
    refused: { tap_seq: 22 },
    hand_off_seq: 22,
    local_work: {
      local_id: "L1",
      resource_id: "P1",
      command_sha256: "d".repeat(64),
      receipt_revision: 12,
      sent: [
        {
          idempotency_key: "L1",
          body_sha256: "b".repeat(64),
          path: "/api/experimental/v1/commands",
          status: 200,
        },
      ],
      barriers: {
        receipt_admitted: standing,
        after_reload: standing,
        recovery_invalidated: standing,
        recovery_staged_hidden: standing,
        recovery_final_held: standing,
        // Revision 28: the data activation (revision 27's recovery_exposed) and the rendered settlement are separate barriers.
        recovery_activated: {
          ...standing,
          resource_in_cache: 1,
          applied_revision: 13,
        },
        recovery_rendered: {
          ...standing,
          resource_in_cache: 1,
          applied_revision: 13,
        },
        settled,
      },
    },
  });
  w.markTimes = {
    receipt_admitted: 1990,
    reload_begin: 2014,
    reload_end: 2017,
  };
  return w;
}
const xl0 = (w) => x0Problems(w.proof, ctxOf(ready(w)));
test("XL0: expiry with admitted local work and a reload is accepted (settled by the activation, or after display)", () => {
  assert.deepEqual(xl0(xl0World()), []);
  const owed = xl0World();
  owed.proof.local_work.barriers.recovery_activated = {
    draft: null,
    effects: [],
    resource_in_cache: 1,
    applied_revision: 13,
  };
  assert.deepEqual(xl0(owed), []);
});
// Revision 39 (R39-DIAG; design assessment Q6): the saved route judges XL0 by request identity and causal request/gate positions, never by
// which answer completed first. The live refusal completing BEFORE the departed one (review attempt PAIR-XL0-chromium-370f3ae03603's
// order) is the same valid proof; swapping the two identities is refused.
test("XL0 (revision 39): the live refusal's answer completing before the departed one's is accepted; the identities swapped are refused", () => {
  const liveFirst = xl0World();
  const departed = liveFirst.requests.find((r) => r.seq === 21);
  const live = liveFirst.requests.find((r) => r.seq === 22);
  departed.t_upstream_end = 2027;
  assert.ok(live.t_upstream_end < departed.t_upstream_end);
  assert.deepEqual(xl0(liveFirst), []);
  const swapped = xl0World();
  swapped.proof.lost = { tap_seq: 22 };
  swapped.proof.refused = { tap_seq: 21 };
  swapped.proof.hand_off_seq = 21;
  const found = xl0(swapped);
  assert.ok(
    found.some((p) =>
      /departed page's continuation was not queued at the gate before the clock steps|does not precede the refusal/.test(
        p,
      ),
    ),
    JSON.stringify(found),
  );
});
for (const [name, edit, expected] of [
  [
    "sent twice (a duplicate effect)",
    (w) => w.proof.local_work.sent.push({ ...w.proof.local_work.sent[0] }),
    /sent 2 times/,
  ],
  [
    "sent with another key",
    (w) => (w.proof.local_work.sent[0].idempotency_key = "L2"),
    /not sent with its local id/,
  ],
  [
    "receipted at the staged revision, not after it",
    (w) => {
      w.proof.local_work.receipt_revision = 9;
      for (const b of Object.values(w.proof.local_work.barriers)) {
        if (b.draft) b.draft.receipt_revision = 9;
        for (const e of b.effects) e.receipt_revision = 9;
      }
    },
    /not at a revision after the staged one/,
  ],
  [
    "receipted after the durable baseline",
    (w) => (w.markTimes.receipt_admitted = 2000.5),
    /not admitted before the durable baseline/,
  ],
  [
    "the reload began before E was acknowledged",
    (w) => (w.markTimes.reload_begin = 2010.5),
    /reload did not begin after E/,
  ],
  [
    "the refusal is the departed page's own request",
    (w) => {
      w.proof.refused.tap_seq = 21;
      w.proof.hand_off_seq = 21;
    },
    /not the reloaded page's own request|does not precede the refusal/,
  ],
  [
    "the lost request was queued after the clock steps",
    (w) => (w.requests[1].t_request = 2003),
    /queued at the gate before the clock steps/,
  ],
  [
    "the draft vanished at the invalidation (W18 retired the work)",
    (w) => {
      w.proof.local_work.barriers.recovery_invalidated = {
        draft: null,
        effects: [],
        resource_in_cache: 0,
        applied_revision: 8,
      };
    },
    /at recovery_invalidated is not the same admitted draft/,
  ],
  [
    "an older staged word retired the effect while hidden",
    (w) => {
      w.proof.local_work.barriers.recovery_staged_hidden = {
        ...w.proof.local_work.barriers.recovery_staged_hidden,
        effects: [],
      };
    },
    /at recovery_staged_hidden is not the same/,
  ],
  [
    "the body digest changed across the reload",
    (w) => {
      w.proof.local_work.barriers.after_reload = {
        ...w.proof.local_work.barriers.after_reload,
        draft: {
          ...w.proof.local_work.barriers.after_reload.draft,
          command_digest: "e".repeat(64),
        },
      };
    },
    /at after_reload is not the same/,
  ],
  [
    "a partial reconciliation at the exposure",
    (w) => {
      w.proof.local_work.barriers.recovery_activated = {
        draft: null,
        effects: [{ local_id: "L1", resource_id: "P1", receipt_revision: 12 }],
        resource_in_cache: 1,
        applied_revision: 13,
      };
    },
    /neither standing nor settled/,
  ],
  [
    "never settled after display",
    (w) => {
      w.proof.local_work.barriers.settled =
        w.proof.local_work.barriers.recovery_final_held;
    },
    /was not settled once the account was displayed|resource 0 times/,
  ],
  [
    "the resource twice in the cache",
    (w) => (w.proof.local_work.barriers.settled.resource_in_cache = 2),
    /holds the local resource 2 times/,
  ],
  [
    "the resource in the hidden cache before the activation",
    (w) => {
      w.proof.local_work.barriers.recovery_final_held = {
        ...w.proof.local_work.barriers.recovery_final_held,
        resource_in_cache: 1,
      };
    },
    /in the live cache at recovery_final_held/,
  ],
  [
    "a barrier missing",
    (w) => delete w.proof.local_work.barriers.after_reload,
    /not observed at after_reload/,
  ],
  [
    "no local work at all",
    (w) => (w.proof.local_work = null),
    /records no local work/,
  ],
  [
    "(revision 28) a partial reconciliation at the rendered settlement",
    (w) => {
      w.proof.local_work.barriers.recovery_rendered = {
        draft: null,
        effects: [{ local_id: "L1", resource_id: "P1", receipt_revision: 12 }],
        resource_in_cache: 1,
        applied_revision: 13,
      };
    },
    /local work at recovery_rendered is neither standing nor settled/,
  ],
  [
    "(revision 28) no rendered-settlement barrier",
    (w) => delete w.proof.local_work.barriers.recovery_rendered,
    /local work is not observed at recovery_rendered/,
  ],
  [
    "(revision 28) the resource absent from the cache at the rendered settlement",
    (w) =>
      (w.proof.local_work.barriers.recovery_rendered.resource_in_cache = 0),
    /holds the local resource 0 times at recovery_rendered/,
  ],
])
  test(`XL0 refused: ${name}`, () => {
    const w = xl0World();
    edit(w);
    const found = xl0(w);
    assert.ok(
      found.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(found)}`,
    );
  });
test("X0/X2 refused: a zero-local-work case that carries local work", () => {
  const w = x0World();
  w.proof.local_work = xl0World().proof.local_work;
  assert.ok(
    x0(w).some((p) => /zero-local-work case carries local work/.test(p)),
  );
});
test("R27-DIAG.a: a marker position that names another event (a tap request between the steps) is refused", () => {
  const w = finalise(x0World());
  w.frozen = true;
  // A real event between the E−1 acknowledgement and the E command, but not the probe's begin marker.
  const between = [...w.events.values()].find(
    (e) =>
      e.producer === "bridge" &&
      e.kind === "answer" &&
      e.ref.op === "advance_clock",
  );
  w.proof.marks["x0-e-minus-1:begin"] = between.j;
  assert.ok(
    x0(w).some((p) =>
      /marker x0-e-minus-1:begin names journal event \d+, a bridge\.answer/.test(
        p,
      ),
    ),
    JSON.stringify(x0(w)),
  );
});
test("R27-DIAG.a: a bridge call whose position belongs to another call of the same operation is refused", () => {
  const w = finalise(x0World());
  w.frozen = true;
  const inspects = w.envelope.spec_calls.filter((c) => c.op === "inspect");
  [inspects[0].j_request, inspects[1].j_request] = [
    inspects[1].j_request,
    inspects[0].j_request,
  ];
  assert.ok(
    attemptProblems(w.envelope, {
      readFile: w.readFile,
      expected: EXPECTED,
    }).some((p) =>
      /does not bracket command #\d+ and its acknowledgement/.test(p),
    ),
  );
});
test("X2 refused: a /sync (not of the target) reached the backend between the drain and the ageing", () => {
  const w = x2World();
  w.requests.unshift({
    seq: 29,
    method: "GET",
    path: SYNC_PATH,
    status: 200,
    query: { cursor: "c-poll" },
    next_cursor: "c-before",
    segment: null,
    has_more: false,
    revision: null,
    last_revision: null,
    t_request: 650.5,
  });
  assert.ok(
    x2(w).some((p) =>
      /exchange 29 reached the backend between the drain and the ageing/.test(
        p,
      ),
    ),
    JSON.stringify(x2(w)),
  );
});

// Revision 28 (R28-DIAG.b, DA28-OBS): the runner gives the proof's reader the interval; the proof's reader account must be the account the
// interval's recovery observed.
test("R28-DIAG.b: the proof's reader account is the interval's observed reader account", () => {
  const w = ready(x0World());
  const ctx = ctxOf(w);
  assert.deepEqual(
    x0Problems(w.proof, { ...ctx, interval: { reader_account: "reader" } }),
    [],
  );
  for (const interval of [{ reader_account: "someone-else" }, {}, null])
    assert.ok(
      x0Problems(w.proof, { ...ctx, interval }).some((p) =>
        /the proof's reader is not the account the interval's recovery observed/.test(
          p,
        ),
      ),
      JSON.stringify(interval),
    );
});

// ---- revision 33 (R33-DIAG; design assessment C2/Q2): every causal case through the SAVED route --------------------------------------
// The five cases' healthy worlds (X0, X2, XR0, XR2, XL0) with two NON-SYNC exchanges of the window (a GET and a POST, journalled by
// `finalise` like every tap record), assembled by the maintained assembleInterval, JSON round-tripped, and judged by the case's validator
// (PROOF_VALIDATORS) on both saved collections (proofExchanges), as run-development-pair.mjs judges them. The caller and local-work
// predicates of XR0/XR2/XL0 are judged on the same saved records. Revision 32's projection is the control: refused at each non-sync arrival.
function xr2World() {
  const w = x2World();
  Object.assign(w.proof, {
    case: "PAIR-XR2",
    mark_prefix: "xr2",
    caller: "recovery",
    caller_evidence: {
      sign_in: "settled",
      trace_window: [
        { event: "request.issued", data: { klass: "recovery" } },
        { event: "data.recovery_finish", data: { result: "cleared" } },
      ],
    },
  });
  w.markTimes = { fence_recorded: 300, hold_rearmed: 310, sign_in_begin: 800 };
  return w;
}
const SAVED_CASES = {
  "PAIR-X0": x0World,
  "PAIR-X2": x2World,
  "PAIR-XR0": xr0World,
  "PAIR-XR2": xr2World,
  "PAIR-XL0": xl0World,
};
/**
 * The world with its non-sync exchanges, finalised, assembled and reloaded. `strip`: revision 32's projection (no causal references).
 * Revision 37 (R37-DIAG; design assessment C2): a world that already holds its own non-sync exchanges (X2 and XR2: the grant's GET and POST
 * inside the grant's bracket) keeps exactly those, in their real chronology; the others get two before their first /sync, as before.
 * `edit(saved, w)` changes the RELOADED record before it is judged (a saved-route negative); `given(saved)` is what the reader is given.
 */
function savedOf(
  make,
  { strip = false, edit = null, given = proofExchanges, before = null } = {},
) {
  const w = make();
  if (before) before(w);
  const own = w.requests.filter((r) => syncTraffic(r) === false);
  const first = Math.min(
    ...w.requests.filter((r) => !own.includes(r)).map((r) => r.t_request),
  );
  const others =
    own.length > 0
      ? []
      : [
          {
            seq: 90,
            method: "GET",
            path: PEOPLE_PATH,
            status: 200,
            t_request: first - 2,
            t_upstream_end: first - 1.5,
          },
          {
            seq: 91,
            method: "POST",
            path: GRANT_PATH,
            status: 200,
            t_request: first - 1,
            t_upstream_end: first - 0.5,
          },
        ];
  w.requests.push(...others);
  finalise(w);
  const label = `${w.proof.case}:node:iv`;
  const records = w.requests
    .map((r) => ({
      method: "GET",
      path: SYNC_PATH,
      ...r,
      label,
      proxy_id: 500 + r.seq,
      downstream: { outcome: "delivered", events: [] },
    }))
    .sort((a, b) => a.seq - b.seq);
  const assembled = assembleInterval({
    iv: {
      id: label,
      caseId: w.proof.case,
      engine: "node",
      barriers: [],
      piecesPersisted: 0,
      attempts: [],
      target: null,
      handOff: null,
      readerAccount: w.proof.reader_account,
      opening: null,
      holdReleases: [],
      observations: [],
      terminal: { final_seq: null, activated_by_seq: null },
      traces: [],
    },
    records,
    collection: null,
    details: {
      backend: "diagnostic",
      selection: "sel",
      apiVersion: "x",
      workload: "W-real",
      preGrantCursor: "c0",
      driven: "rearmed_prefix",
      requiredObservations: [],
      terminal: "recovered",
      appliedRevision: null,
      oracle: { verdict: "match", problems: [] },
      person: "P1",
    },
    memory: { kind: null, reason: "none" },
    readBody: (f) => w.readFile(`bodies/${f}`),
  });
  const saved = JSON.parse(JSON.stringify(assembled));
  if (strip)
    for (const o of saved.other_requests)
      for (const k of CAUSAL_FIELDS) delete o[k];
  saved.interval = label;
  if (edit) edit(saved, w);
  const problems = PROOF_VALIDATORS[w.proof.case](w.proof, {
    ...ctxOf(w),
    interval: saved,
    requests: given(saved),
  });
  return { w, saved, problems };
}
/** Revision 37: the non-sync exchanges each saved case carries (X2/XR2: the grant's own; the others: two before their first /sync). */
const setupOf = (id) =>
  id === "PAIR-X2" || id === "PAIR-XR2"
    ? [
        [26, "GET"],
        [27, "POST"],
      ]
    : [
        [90, "GET"],
        [91, "POST"],
      ];
for (const [id, make] of Object.entries(SAVED_CASES)) {
  test(`R33 Q2 ${id}: the saved route (non-sync GET and POST, assembler, JSON reload, both collections) is accepted by the case's validator`, () => {
    const r = savedOf(make);
    assert.deepEqual(
      r.saved.other_requests.map((o) => [o.seq, o.method]),
      setupOf(id),
    );
    for (const o of r.saved.other_requests) {
      assert.ok(
        Number.isInteger(o.j_request),
        `exchange ${o.seq}'s arrival kept`,
      );
      assert.ok(
        Number.isInteger(o.j_upstream_end),
        `exchange ${o.seq}'s end kept`,
      );
    }
    assert.deepEqual(r.problems, []);
  });
  test(`R33 Q2 ${id} control: revision 32's projection is refused at each non-sync arrival`, () => {
    const r = savedOf(make, { strip: true });
    assert.deepEqual(
      r.problems.filter((p) => /arrival/.test(p)),
      setupOf(id).map(
        ([seq]) => `exchange ${seq}'s arrival names no journal position`,
      ),
    );
  });
}

// ---- revision 37 (R37-DIAG; design assessment C1-C3, T1-T7): the pruning predicate judges the GATE's traffic, at its forwarding ----------
// The real X2 attempt recorded: drain, grant begin, the grant's GET /people and POST /access-commands, grant end, inspect, age. Revision 36
// refused both setup requests because it prohibited EVERY exchange between the drain and the ageing. Every exchange is still bound to its
// journal events; only /sync traffic (the tap's own class) is prohibited, judged at its forwarding (gate opening, else arrival).
const positionsOf = (w) => {
  const x = exchangesOf(w.entries, w.envelope.attempt);
  const cmd = (seq) => x.commands.find((c) => c.seq === seq);
  const age = cmd(w.proof.controls.age_history);
  const inspect = cmd(w.proof.controls.inspect_before_ageing);
  return {
    marks: w.proof.marks,
    inspectSent: inspect.j,
    ageSent: age.j,
    ageAck: age.answers[0].j,
  };
};
for (const id of ["PAIR-X2", "PAIR-XR2"]) {
  test(`R37 T1 ${id}: the saved route in the REAL grant chronology (drain, grant GET and POST inside the bracket, inspect, age) is accepted`, () => {
    const r = savedOf(SAVED_CASES[id]);
    const p = positionsOf(r.w);
    const [get, post] = r.saved.other_requests;
    assert.deepEqual(
      [get.method, get.path, post.method, post.path],
      ["GET", PEOPLE_PATH, "POST", GRANT_PATH],
    );
    // The schedule itself, asserted independently of the validator (journal positions, strictly increasing).
    const order = [
      p.marks.drain_complete,
      p.marks.grant_begin,
      get.j_request,
      get.j_upstream_end,
      post.j_request,
      post.j_upstream_end,
      p.marks.grant_end,
      p.inspectSent,
      p.ageSent,
      p.ageAck,
      Math.min(...r.saved.requests.map((x) => x.j_request)),
    ];
    assert.ok(
      order.every(
        (v, i) => Number.isInteger(v) && (i === 0 || order[i - 1] < v),
      ),
      JSON.stringify(order),
    );
    assert.equal(r.saved.requests.length + r.saved.other_requests.length, 4);
    assert.deepEqual(r.problems, []);
  });
  for (const seq of [26, 27]) {
    const other = seq === 26 ? 27 : 26;
    for (const [name, edit, expected] of [
      [
        "its arrival missing",
        (o) => delete o.j_request,
        `exchange ${seq}'s arrival names no journal position`,
      ],
      [
        "its arrival naming the other setup request's",
        (o, saved) =>
          (o.j_request = saved.other_requests.find(
            (x) => x.seq === other,
          ).j_request),
        new RegExp(
          `exchange ${seq}'s arrival names journal event \\d+, whose seq is ${other}, not ${seq}`,
        ),
      ],
      [
        "its arrival naming its own upstream end (another event kind)",
        (o) => (o.j_request = o.j_upstream_end),
        new RegExp(
          `exchange ${seq}'s arrival names journal event \\d+, a tap\\.upstream_end, not a tap\\.request`,
        ),
      ],
      [
        "its upstream end naming the other setup request's",
        (o, saved) =>
          (o.j_upstream_end = saved.other_requests.find(
            (x) => x.seq === other,
          ).j_upstream_end),
        new RegExp(
          `exchange ${seq}'s upstream end names journal event \\d+, whose seq is ${other}, not ${seq}`,
        ),
      ],
      [
        "its upstream end beyond the journal",
        (o) => (o.j_upstream_end = 99999),
        `exchange ${seq}'s upstream end names journal event 99999, which the journal does not hold`,
      ],
    ])
      test(`R37 T2 ${id} refused: grant setup exchange ${seq} with ${name}`, () => {
        const r = savedOf(SAVED_CASES[id], {
          edit: (saved) =>
            edit(
              saved.other_requests.find((x) => x.seq === seq),
              saved,
            ),
        });
        assert.ok(
          r.problems.some((p) =>
            typeof expected === "string" ? p === expected : expected.test(p),
          ),
          JSON.stringify(r.problems),
        );
      });
  }
  test(`R37 T2 ${id} refused: the reader given the sync collection only (the grant's exchanges left out)`, () => {
    const r = savedOf(SAVED_CASES[id], { given: (saved) => saved.requests });
    assert.ok(
      r.problems.includes(
        "the proof's reader was not given exactly the saved interval's exchanges",
      ),
      JSON.stringify(r.problems),
    );
  });
  test(`R37 T5 ${id} refused: an exchange given twice, or one more than the saved interval holds`, () => {
    for (const given of [
      (saved) => [...proofExchanges(saved), saved.other_requests[0]],
      // A real, correctly bound exchange the saved record no longer lists (its collection lost it after the reader's input was taken).
      (saved) => {
        const all = proofExchanges(saved);
        saved.other_requests = saved.other_requests.slice(0, 1);
        return all;
      },
    ]) {
      const r = savedOf(SAVED_CASES[id], { given });
      assert.ok(
        r.problems.includes(
          "the proof's reader was not given exactly the saved interval's exchanges",
        ),
        JSON.stringify(r.problems),
      );
    }
  });
  test(`R37 T5 ${id} refused: a /sync relabelled out of the sync collection, or other traffic in it`, () => {
    const relabelled = savedOf(SAVED_CASES[id], {
      edit: (saved) => (saved.requests[0].method = "POST"),
    });
    assert.ok(
      relabelled.problems.includes(
        `exchange ${relabelled.saved.requests[0].seq} is in the sync collection but is not /sync traffic`,
      ),
      JSON.stringify(relabelled.problems),
    );
    const moved = savedOf(SAVED_CASES[id], {
      edit: (saved) => {
        Object.assign(saved.other_requests[1], {
          method: "GET",
          path: SYNC_PATH,
        });
      },
    });
    assert.ok(
      moved.problems.includes(
        "exchange 27 is in the other collection but is not other traffic",
      ),
      JSON.stringify(moved.problems),
    );
    const unnamed = savedOf(SAVED_CASES[id], {
      edit: (saved) => delete saved.other_requests[0].path,
    });
    assert.ok(
      unnamed.problems.includes(
        "exchange 26 is in the other collection but is not other traffic",
      ) &&
        unnamed.problems.includes(
          "exchange 26 names no method and path: its traffic is unknown",
        ),
      JSON.stringify(unnamed.problems),
    );
  });
  test(`R37 T3 ${id} refused: a non-target /sync forwarded between the drain and the ageing, through the saved route`, () => {
    const r = savedOf(SAVED_CASES[id], {
      before: (w) =>
        w.requests.push({
          seq: 28,
          method: "GET",
          path: SYNC_PATH,
          status: 200,
          query: { cursor: "c-poll" },
          next_cursor: "c-before",
          segment: null,
          has_more: false,
          revision: null,
          last_revision: null,
          t_request: 650.5,
          t_upstream_end: 650.6,
        }),
    });
    assert.ok(
      r.problems.includes(
        "exchange 28 reached the backend between the drain and the ageing",
      ),
      JSON.stringify(r.problems),
    );
    assert.ok(
      !r.problems.some((p) => /exchange 2[67] /.test(p)),
      JSON.stringify(r.problems),
    );
  });
}

/** An X2 world with one more /sync (non-target unless `fields` say otherwise): seq 40, `fields` its times and contents. */
const withSync = (fields) => {
  const w = x2World();
  w.requests.push({
    seq: 40,
    method: "GET",
    path: SYNC_PATH,
    query: { cursor: "c-poll" },
    status: 200,
    next_cursor: "c-before",
    segment: null,
    has_more: false,
    revision: null,
    last_revision: null,
    ...fields,
  });
  return w;
};
const INTERVAL_40 =
  "exchange 40 reached the backend between the drain and the ageing";
const TARGET_40 =
  "exchange 40 carried the target before the ageing was acknowledged";
// T3: the interval rule and the target rule are INDEPENDENT; each refuses on its own.
for (const [name, fields, expectInterval, expectTarget] of [
  [
    "a non-target /sync arriving and forwarded after the drain",
    { t_request: 680, t_upstream_end: 681 },
    true,
    false,
  ],
  [
    "a target /sync (body revision) forwarded before the drain",
    { t_request: 450, t_upstream_end: 451, revision: 9 },
    false,
    true,
  ],
  [
    "a target /sync (last revision) forwarded before the drain",
    { t_request: 450, t_upstream_end: 451, last_revision: 9 },
    false,
    true,
  ],
  [
    "a target /sync (continuation of the target) forwarded before the drain",
    {
      t_request: 450,
      t_upstream_end: 451,
      query: {
        cursor: tokenOf({ boundary: 5, expiry: E, revision: 9, index: 2 }),
      },
    },
    false,
    true,
  ],
  [
    "a target /sync forwarded inside the interval",
    { t_request: 680, t_upstream_end: 681, revision: 9 },
    true,
    true,
  ],
])
  test(`R37 T3 X2 refused: ${name}`, () => {
    const found = x2(withSync(fields));
    assert.equal(
      found.includes(INTERVAL_40),
      expectInterval,
      JSON.stringify(found),
    );
    assert.equal(
      found.includes(TARGET_40),
      expectTarget,
      JSON.stringify(found),
    );
  });
// T4: a /sync queued at the gate BEFORE the drain is judged at its forwarding, never at its arrival alone.
for (const [name, fields, refused] of [
  [
    "queued before the drain and still held",
    { t_request: 450, gated: true, status: null },
    false,
  ],
  [
    "queued before the drain, released after the ageing's acknowledgement",
    { t_request: 450, gated: true, t_gate_open: 701.5, t_upstream_end: 701.6 },
    false,
  ],
  [
    "queued before the drain, released between the drain and the ageing",
    { t_request: 450, gated: true, t_gate_open: 680, t_upstream_end: 681 },
    true,
  ],
  [
    "queued before the drain, released between the ageing's command and its acknowledgement",
    { t_request: 450, gated: true, t_gate_open: 700.5, t_upstream_end: 700.6 },
    true,
  ],
  [
    "queued after the drain, released between the drain and the ageing",
    { t_request: 520, gated: true, t_gate_open: 680, t_upstream_end: 681 },
    true,
  ],
  [
    "queued after the drain, released after the ageing's acknowledgement",
    { t_request: 520, gated: true, t_gate_open: 701.5, t_upstream_end: 701.6 },
    false,
  ],
])
  test(`R37 T4 X2: a non-target /sync ${name} is ${refused ? "refused" : "accepted"}`, () => {
    const found = x2(withSync(fields));
    if (refused) assert.ok(found.includes(INTERVAL_40), JSON.stringify(found));
    else assert.deepEqual(found, []);
  });
test("R37 T4 X2 refused: a released gated /sync whose gate opening is unrecorded", () => {
  const found = x2(
    withSync({ t_request: 450, gated: true, t_upstream_end: 681 }),
  );
  assert.ok(
    found.includes(
      "exchange 40 was gated but answered without a recorded gate opening",
    ),
    JSON.stringify(found),
  );
});
// T5: the traffic class is the tap's; a record without one is UNKNOWN (judged as /sync and refused), never exempt.
test("R37 T5: syncTraffic classifies exactly as the tap and the assembler do", () => {
  for (const [r, want] of [
    [{ method: "GET", path: SYNC_PATH }, true],
    [{ method: "GET", path: "/sync" }, true],
    [{ method: "POST", path: SYNC_PATH }, false],
    [{ method: "GET", path: `${SYNC_PATH}/x` }, false],
    [{ method: "GET", path: PEOPLE_PATH }, false],
    [{ method: "POST", path: GRANT_PATH }, false],
    [{ method: "get", path: SYNC_PATH }, false],
    [{ path: SYNC_PATH }, null],
    [{ method: "GET" }, null],
    [{ method: "GET", path: null }, null],
    [null, null],
  ])
    assert.equal(syncTraffic(r), want, JSON.stringify(r));
  // The assembler's partition agrees with the class for every classified shape.
  const records = [
    { seq: 1, method: "GET", path: SYNC_PATH },
    { seq: 2, method: "POST", path: SYNC_PATH },
    { seq: 3, method: "GET", path: PEOPLE_PATH },
    { seq: 4, method: "POST", path: GRANT_PATH },
    { seq: 5, method: "GET", path: `${SYNC_PATH}/x` },
  ].map((r) => ({ ...r, label: "iv", status: 200, downstream: null }));
  const a = assembleInterval({
    iv: {
      id: "iv",
      caseId: "PAIR-X2",
      engine: "node",
      barriers: [],
      attempts: [],
      observations: [],
      traces: [],
      terminal: { final_seq: null, activated_by_seq: null },
    },
    records,
    collection: null,
    details: {
      requiredObservations: [],
      oracle: { verdict: "match", problems: [] },
    },
    memory: { kind: null, reason: "none" },
    readBody: () => Buffer.from("{}"),
  });
  assert.deepEqual(
    a.requests.map((r) => r.seq),
    records.filter((r) => syncTraffic(r) === true).map((r) => r.seq),
  );
  assert.deepEqual(
    a.other_requests.map((r) => r.seq),
    records.filter((r) => syncTraffic(r) === false).map((r) => r.seq),
  );
});
for (const [name, edit, expected, alsoInterval] of [
  [
    "a record naming no method",
    (r) => delete r.method,
    "exchange 40 names no method and path: its traffic is unknown",
    true,
  ],
  [
    "a record naming no path",
    (r) => delete r.path,
    "exchange 40 names no method and path: its traffic is unknown",
    true,
  ],
  [
    "other traffic recorded as gated",
    (r) =>
      Object.assign(r, {
        method: "POST",
        path: GRANT_PATH,
        gated: true,
        t_gate_open: 690,
      }),
    "exchange 40 was gated but is not /sync traffic",
    false,
  ],
])
  test(`R37 T5 X2 refused: ${name}`, () => {
    const w = withSync({ t_request: 680, t_upstream_end: 681 });
    edit(w.requests.at(-1));
    const found = x2(w);
    assert.ok(found.includes(expected), JSON.stringify(found));
    assert.equal(
      found.includes(INTERVAL_40),
      alsoInterval,
      JSON.stringify(found),
    );
  });
for (const [name, fields] of [
  ["a POST to the sync path", { method: "POST" }],
  ["a GET of another endpoint", { path: PEOPLE_PATH }],
  ["the grant's access command", { method: "POST", path: GRANT_PATH }],
])
  test(`R37 T5 X2: other traffic forwarded between the drain and the ageing (${name}) is accepted`, () => {
    const w = withSync({ t_request: 680, t_upstream_end: 681, ...fields });
    assert.deepEqual(x2(w), []);
  });

// T7: the same pruning records through the attempt's conclusion (concludeAttempt, with owned stand-ins): only the positive is eligible and
// asked to remove its fixture; the negative stays failed with its first reason, and removal is withheld even though retention succeeds.
async function concludePruning(problems) {
  const asked = [];
  const out = await concludeAttempt({
    stopTransports: async () => [],
    preliminary: async () => problems.map((p) => `interval PAIR-X2: ${p}`),
    latched: () => null,
    guard: async () => ({
      held: true,
      problems: [],
      record: { held: true },
      alive: () => true,
    }),
    preserve: async () => ({
      ready: true,
      problems: [],
      dir: "/retained",
      anchors: [],
    }),
    finish: async (remove) => {
      asked.push(remove);
      return { requested_remove: remove };
    },
    release: async () => ({ released: true, lost: false, problems: [] }),
    materialise: async () => ({ status: "verified", problems: [] }),
    terminal: async (finished) =>
      finished.requested_remove
        ? []
        : ["the fixture was kept: the attempt is not complete"],
  });
  return { out, asked };
}
test("R37 T7: the positive pruning record is eligible and its removal asked; the sync-forwarding negative is failed and kept", async () => {
  const good = savedOf(SAVED_CASES["PAIR-X2"]);
  assert.deepEqual(good.problems, []);
  const pos = await concludePruning(good.problems);
  assert.equal(pos.out.eligible, true);
  assert.equal(pos.out.remove_requested, true);
  assert.deepEqual(pos.asked, [true]);
  assert.deepEqual(pos.out.terminal, []);
  const badRun = savedOf(SAVED_CASES["PAIR-X2"], {
    before: (w) =>
      w.requests.push({
        seq: 28,
        method: "GET",
        path: SYNC_PATH,
        status: 200,
        query: { cursor: "c-poll" },
        revision: null,
        last_revision: null,
        t_request: 650.5,
        t_upstream_end: 650.6,
      }),
  });
  const neg = await concludePruning(badRun.problems);
  assert.equal(neg.out.eligible, false);
  assert.equal(neg.out.remove_requested, false);
  assert.deepEqual(neg.asked, [false]);
  assert.equal(
    neg.out.preliminary[0],
    "interval PAIR-X2: exchange 28 reached the backend between the drain and the ageing",
  );
  assert.equal(neg.out.preserved, true);
  assert.ok(neg.out.terminal.length > 0);
});

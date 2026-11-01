// WEB-09c revision 27 (R27-DIAG.a; design assessment Q1): the COMPOSED clock contract. The review of revision 26 showed that the runner's
// real composition — the tap on `performance.now()`, the control on `Date.now()` — could never satisfy the reader's chronology, while the
// unit worlds hid it by putting every event in one artificial clock. Here the MAINTAINED factories are composed exactly as the runner composes
// them (`launchAttempt` with the attempt's `attemptJournal`, `composeAttemptTransport` for the bridge and the tap), with their DEFAULT clocks,
// against short stand-ins: an in-process child that speaks the executable's stdin/stdout protocol over real streams, and a loopback backend
// whose continuation expires at the stand-in's sync clock (X0) or whose target revision is pruned by its collector (X2). The spec's side is
// the maintained bridge client (`controlCall`) with acknowledged markers. The resulting transcript, journal, tap records and probes reach the
// maintained readers (`attemptProblems`, `x0Problems`, `x2Problems`).
//
// Controls: the correct order passes with the default (mixed-origin) clocks, with a journal whose raw clock never moves (equal ticks), and
// with one that runs BACKWARDS; an inverted causal order (the gate opened before the clock reached E; before the collection was
// acknowledged) fails. Nothing here launches the approved executable or any backend.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  ATTEMPT_SCHEMA,
  attemptProblems,
  PROOF_SCHEMA,
  attemptJournal as readJournal,
  readTranscript,
  x0Problems,
  x2Problems,
} from "./diagnostic-evidence.mjs";
import {
  attemptJournal,
  composeAttemptTransport,
  controlCall,
  finishAttempt,
  launchAttempt,
  RETENTION_SECONDS,
} from "./diagnostic-fixture.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const EXE_SHA = "e".repeat(64);
const FEATURES = { "sync-diagnostic": true, "test-hooks": false };
const hex = (n, w) => n.toString(16).padStart(w, "0");
const tokenOf = ({ boundary, expiry, revision, index }) =>
  `d2.${hex(boundary, 16)}.${hex(expiry, 16)}.${hex(revision, 16)}.${hex(index, 8)}.0000beef.${"a".repeat(64)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The stand-in world: the executable's protocol over real streams (an in-process child), its sync clock and collector, and the backend's
 * answers that depend on them. `kind`: "x0" (the continuation expires at E) or "x2" (the target batch is pruned by `collect`).
 */
function standIn({ attempt, fixtureDir, origin, start }) {
  const READER = "reader";
  const CONTROL = "control";
  const R = 9;
  const header = {
    boundary: 5,
    expiry: start + RETENTION_SECONDS,
    revision: R,
    index: 3,
  };
  const token = tokenOf(header);
  const controlHeader = {
    boundary: 11,
    expiry: start + RETENTION_SECONDS,
    revision: 12,
    index: 1,
  };
  const controlToken = tokenOf(controlHeader);
  const world = {
    now: start,
    setup: true,
    accounts: [
      { id: CONTROL, sync_floor: 0 },
      { id: READER, sync_floor: 0 },
    ],
    batches: [
      {
        account: CONTROL,
        revision: 12,
        created_at: start,
        payload_sha256: "pc",
        payload_bytes: 10,
      },
      {
        account: READER,
        revision: R,
        created_at: start,
        payload_sha256: "p",
        payload_bytes: 10,
      },
    ],
  };
  const state = () => ({
    sync_now: world.now,
    revision_clock: 12,
    accounts: structuredClone(world.accounts),
    batches: structuredClone(world.batches),
    devices: [],
    sessions: [
      {
        account: READER,
        device: "d",
        expires_at: start + 999_999,
        token_hash: "h",
      },
    ],
    receipts_sha256: "r",
    resources_sha256: "q",
    truncated: false,
  });
  const receipt = {
    schema: 2,
    kind: "atlas-sync-diagnostic-receipt",
    attempt,
    pid: 4242,
    fixture_dir: { path: fixtureDir, dev: "1", ino: "2" },
    database: { path: `${fixtureDir}/fixture.sqlite`, dev: "1", ino: "3" },
    executable: { path: "/stand-in/atlas-sync-diagnostic", sha256: EXE_SHA },
    features: FEATURES,
    api_version: "0.30.0",
    address: "127.0.0.1:1",
    public_origin: origin,
    sync_start: start,
    retention_seconds: RETENTION_SECONDS,
  };
  const receiptText = JSON.stringify(receipt);
  // The child: stdin/stdout/stderr streams and an exit event, as `spawn` returns them.
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const out = (v) => child.stdout.write(`${JSON.stringify(v)}\n`);
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      const cmd = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      const answer = (fields) =>
        out({
          attempt,
          seq: cmd.seq,
          op: cmd.op,
          ok: true,
          sync_now: world.now,
          ...fields,
        });
      const args = cmd.args ?? {};
      // Each answer leaves the stand-in after a tick, so the parent's observations are in separate macrotasks.
      setImmediate(() => {
        switch (cmd.op) {
          case "add_account":
            answer({ result: { account: args.username }, effect: "applied" });
            break;
          case "inspect":
            answer({ result: state(), effect: "none" });
            break;
          case "advance_clock": {
            const from = world.now;
            world.now = args.time;
            world.setup = false;
            answer({ result: { from, to: world.now }, effect: "applied" });
            break;
          }
          case "age_history":
            for (const b of args.batches)
              for (const x of world.batches)
                if (x.account === b.account && x.revision === b.revision)
                  x.created_at = b.created_at;
            answer({ result: { aged: args.batches }, effect: "applied" });
            break;
          case "collect": {
            const before = state();
            const cutoff = args.time - RETENTION_SECONDS;
            const removed = world.batches.filter((b) => b.created_at <= cutoff);
            world.batches = world.batches.filter((b) => b.created_at > cutoff);
            for (const b of removed)
              for (const a of world.accounts)
                if (a.id === b.account) a.sync_floor = b.revision;
            answer({
              result: {
                time: args.time,
                before,
                after: state(),
                removed_batches: removed,
              },
              effect: "applied",
            });
            break;
          }
          case "shutdown":
            out({
              event: "stopped",
              attempt,
              seq: cmd.seq,
              served: true,
              removed: args.remove ? ["fixture.sqlite", "receipt.json"] : null,
              cleanup_error: null,
            });
            child.stdout.end();
            setImmediate(() => child.emit("exit", 0, null));
            break;
          default:
            out({
              attempt,
              seq: cmd.seq,
              op: cmd.op,
              ok: false,
              error: "unsupported",
              effect: "none",
            });
        }
      });
    }
  });
  child.stdin.on("finish", () => undefined);
  setImmediate(() =>
    out({
      event: "ready",
      receipt,
      receipt_sha256: sha(Buffer.from(receiptText)),
    }),
  );
  // The backend: the reader's piece 2 (whose continuation is `token`); the continuation answered while unexpired and unpruned, else the
  // server's 410; the control account's continuation answered (X2); the session live.
  const piece = (revision, index, next) =>
    JSON.stringify({
      phase: "delta",
      batches: [{ revision, segment: { index, last: false }, changes: [] }],
      has_more: true,
      next_cursor: next,
    });
  const refused = JSON.stringify({
    code: "resync_required",
    message: "x",
    details: [],
  });
  const backend = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.endsWith("/browser-sessions/current")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ session_id: "s" }));
    }
    const cursor = url.searchParams.get("cursor");
    const expired = world.now >= header.expiry;
    const pruned =
      (world.accounts.find((a) => a.id === READER)?.sync_floor ?? 0) >= R;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (cursor === "c-before") return send(200, piece(R, 2, token));
    if (cursor === token)
      return expired || pruned
        ? send(410, refused)
        : send(200, piece(R, 3, tokenOf({ ...header, index: 4 })));
    if (cursor === controlToken)
      return send(200, piece(12, 1, "c-control-next"));
    return send(404, "{}");
  });
  return {
    child,
    receiptText,
    backend,
    token,
    header,
    controlToken,
    controlHeader,
    world,
  };
}

/** The runner's composition, as `diagnosticStack` makes it, around the stand-in; then the spec's X0 or X2 schedule; then the readers. */
async function composed({ kind, journalNow, invert = false }) {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "atlas-compose-"),
  );
  const attempt = `compose-${kind}-${randomBytes(4).toString("hex")}`;
  const files = new Map();
  const evidence = join(dir, "evidence");
  mkdirSync(join(evidence, "att"), { recursive: true });
  const journalFile = join(evidence, "att", "journal.jsonl");
  const journal = attemptJournal(
    attempt,
    journalFile,
    journalNow ? { now: journalNow } : {},
  );
  const fixtureDir = join(dir, `fixture-${attempt}`);
  const origin = "http://127.0.0.1:5000";
  const start = 1_800_000_000;
  const s = standIn({ kind, attempt, fixtureDir, origin, start });
  await new Promise((r) => s.backend.listen(0, "127.0.0.1", r));
  const backendUrl = `http://127.0.0.1:${s.backend.address().port}`;
  const specCalls = [];
  const specMarks = [];
  let running = null;
  let tapUrls = null;
  let parts = null;
  try {
    running = await launchAttempt(
      {
        spawn: () => s.child,
        realpath: (p) => p,
        exists: () => false,
        stat: (p) =>
          p.endsWith("fixture.sqlite")
            ? { dev: "1", ino: "3" }
            : { dev: "1", ino: "2" },
        readFile: (p) => {
          if (p.endsWith("receipt.json")) return Buffer.from(s.receiptText);
          throw new Error(`ENOENT ${p}`);
        },
        record: (entry) => {
          const line = `${JSON.stringify(entry)}\n`;
          files.set(
            "att/transcript.jsonl",
            Buffer.concat([
              files.get("att/transcript.jsonl") ?? Buffer.alloc(0),
              Buffer.from(line),
            ]),
          );
        },
      },
      {
        executable: "/stand-in/atlas-sync-diagnostic",
        executableSha256: EXE_SHA,
        fixtureParent: dir,
        attempt,
        publicOrigin: origin,
        apiVersion: "0.30.0",
        features: FEATURES,
        env: { PATH: "/usr/bin" },
        journal,
      },
    );
    assert.deepEqual(running.problems, []);
    const accounts = {};
    for (const name of [
      "pair-writer",
      "reader",
      ...(kind === "x2" ? ["control"] : []),
    ]) {
      const a = await running.control.send("add_account", {
        username: name,
        password: "x",
      });
      accounts[name] = { account_id: a.result.account, seq: a.seq };
    }
    const socketPath = join(dir, "c.sock");
    const token = randomBytes(12).toString("hex");
    parts = composeAttemptTransport({
      journal,
      control: running.control,
      socketPath,
      token,
      onCall: (c) => specCalls.push(c),
      onMark: (m) => specMarks.push(m),
      tap: {
        upstream: backendUrl,
        bodiesDir: join(evidence, "bodies"),
        correlation: null,
      },
    });
    await parts.bridge.listen();
    tapUrls = await parts.tap.start();
    const at = { socketPath, token };
    const prefix = kind;
    const marks = {};
    const mark = async (name) => {
      const r = await controlCall(at, "POST", "/mark", {
        name: `${prefix}:${name}`,
      });
      assert.equal(r.status, 200);
      marks[name] = r.body.j;
    };
    const op = async (name, args = {}) => {
      const r = await controlCall(at, "POST", "/command", { op: name, args });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.answer;
    };
    const gate = (closed) =>
      fetch(`${tapUrls.controlUrl}/gate`, {
        method: "POST",
        body: JSON.stringify({ closed }),
      });
    const viaTap = (cursor) =>
      fetch(
        `${tapUrls.tapUrl}/api/experimental/v1/sync?cursor=${encodeURIComponent(cursor)}&max_changes=4`,
      );
    const direct = async (label, cursor) => {
      await mark(`${label}:begin`);
      const r = await fetch(
        `${backendUrl}/api/experimental/v1/sync?cursor=${encodeURIComponent(cursor)}&max_changes=4`,
      );
      const bytes = Buffer.from(await r.arrayBuffer());
      await mark(`${label}:end`);
      const file = `probe-${label}.json`;
      files.set(`bodies/${file}`, bytes);
      let code = null;
      try {
        code = JSON.parse(String(bytes)).code ?? null;
      } catch {
        code = null;
      }
      return {
        label,
        status: r.status,
        code,
        body_file: file,
        body_sha256: sha(bytes),
      };
    };
    const controls = {};
    const proof = {
      schema: PROOF_SCHEMA,
      attempt,
      interval: "iv",
      engine: "chromium",
      reader_account: "reader",
      caller: "ordinary",
      mark_prefix: prefix,
      marks,
      continuation: { token_sha256: sha(s.token), header: s.header },
    };
    let targetDone = null;
    if (kind === "x2") {
      // Gate and drain before the grant; the target batch aged in setup; nothing of it requested before.
      await gate(true);
      await mark("drain_complete");
      await mark("grant_begin");
      await mark("grant_end");
      const st = await op("inspect");
      controls.inspect_before_ageing = st.seq;
      const aged = await op("age_history", {
        batches: [
          {
            account: "reader",
            revision: 9,
            payload_sha256: "p",
            created_at: start - RETENTION_SECONDS,
          },
        ],
      });
      controls.age_history = aged.seq;
      await gate(false);
      targetDone = { account: "reader", revision: 9, payload_sha256: "p" };
    }
    // The staged piece, then the continuation queued at the closed gate.
    assert.equal((await viaTap("c-before")).status, 200);
    await gate(true);
    const pending = viaTap(s.token);
    for (let i = 0; i < 400 && !parts.tap.records.some((r) => r.gated); i += 1)
      await sleep(5);
    assert.ok(
      parts.tap.records.some((r) => r.gated),
      "the continuation waits at the gate",
    );
    const probes = {};
    if (kind === "x0") {
      const E = s.header.expiry;
      controls.inspect_before = (await op("inspect")).seq;
      controls.advance_e_minus_1 = (
        await op("advance_clock", { time: E - 1 })
      ).seq;
      probes.e_minus_1 = {
        ...(await direct("x0-e-minus-1", s.token)),
        session: "browser",
        token_sha256: sha(s.token),
      };
      if (invert) await gate(false);
      controls.advance_e = (await op("advance_clock", { time: E })).seq;
      await mark("session-live:begin");
      const live = await fetch(
        `${backendUrl}/api/experimental/v1/browser-sessions/current`,
      );
      await mark("session-live:end");
      probes.session_after_e = { label: "session-live", status: live.status };
      controls.inspect_after_e = (await op("inspect")).seq;
    } else {
      controls.collect = (await op("collect", { time: start })).seq;
    }
    if (!invert) await gate(false);
    const refusedAnswer = await pending;
    assert.equal(refusedAnswer.status, kind === "x0" && invert ? 200 : 410);
    await refusedAnswer.arrayBuffer();
    controls.inspect_at_refusal = (await op("inspect")).seq;
    if (kind === "x0") {
      controls.advance_e_plus_1 = (
        await op("advance_clock", { time: s.header.expiry + 1 })
      ).seq;
      probes.e_plus_1 = {
        ...(await direct("x0-e-plus-1", s.token)),
        session: "browser",
        token_sha256: sha(s.token),
      };
      Object.assign(proof, { case: "PAIR-X0", controls, probes });
    } else {
      const probe = await direct("x2-control", s.controlToken);
      Object.assign(proof, {
        case: "PAIR-X2",
        controls,
        target: targetDone,
        control_account: {
          account: "control",
          revision: 12,
          continuation_sha256: sha(s.controlToken),
          continuation_header: s.controlHeader,
          probe_after: {
            ...probe,
            session: "control",
            token_sha256: sha(s.controlToken),
          },
        },
      });
    }
    await parts.tap.stop();
    await parts.bridge.close();
    const finished = await finishAttempt(running, { remove: true });
    // The envelope as the runner seals it, with the transcript's and the journal's retained bytes.
    files.set("att/journal.jsonl", readFileSync(journalFile));
    const transcriptBytes = files.get("att/transcript.jsonl");
    files.set("att/receipt.json", Buffer.from(s.receiptText));
    const records = parts.tap.records.filter((r) => r.path.endsWith("/sync"));
    const [stagedRec, refusedRec] = records;
    Object.assign(proof, {
      staged: { tap_seq: stagedRec.seq },
      refused: { tap_seq: refusedRec.seq },
      hand_off_seq: refusedRec.seq,
    });
    const envelope = {
      schema: ATTEMPT_SCHEMA,
      attempt,
      selection_identity: "sel",
      executable: { sha256: EXE_SHA },
      env_keys: running.env,
      ready: {
        receipt_sha256: running.ready.receipt_sha256,
        receipt_file: "att/receipt.json",
      },
      ready_problems: running.problems,
      transcript: {
        file: "att/transcript.jsonl",
        sha256: sha(transcriptBytes),
      },
      journal: {
        file: "att/journal.jsonl",
        sha256: sha(files.get("att/journal.jsonl")),
        ...journal.state(),
      },
      accounts: {},
      spec_calls: specCalls,
      spec_marks: specMarks,
      shutdown: { requested_remove: finished.requested_remove },
      exit: finished.exit,
      latched: finished.latched,
      fixture_after: { leaf_exists: false },
    };
    const readFile = (f) => {
      if (!files.has(f)) throw new Error(`ENOENT ${f}`);
      return files.get(f);
    };
    const expected = {
      selectionIdentity: "sel",
      executableSha256: EXE_SHA,
      apiVersion: "0.30.0",
      features: FEATURES,
      retentionSeconds: RETENTION_SECONDS,
      publicOrigin: origin,
    };
    const ctx = {
      attempt: envelope,
      entries: readTranscript(transcriptBytes),
      journal: readJournal(envelope, readFile).events,
      requests: records,
      readFile: (f) => readFile(`bodies/${f}`),
    };
    return {
      attempt: attemptProblems(envelope, { readFile, expected }),
      proof: (kind === "x0" ? x0Problems : x2Problems)(proof, ctx),
      records,
      transcript: ctx.entries,
    };
  } finally {
    await parts?.tap.stop().catch(() => undefined);
    await parts?.bridge.close().catch(() => undefined);
    s.backend.closeAllConnections?.();
    await new Promise((r) => s.backend.close(r));
    if (running && running.control.state().phase !== "stopped")
      s.child.emit("exit", 0, null);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Q1 X0: the runner's real composition with DEFAULT clocks (tap performance.now, control Date.now) reaches the readers and passes", async () => {
  const r = await composed({ kind: "x0" });
  // The two raw domains really are incompatible: the tap's times are process-relative, the transcript's epoch milliseconds.
  assert.ok(r.records[1].t_gate_open < 1e9, `tap ${r.records[1].t_gate_open}`);
  assert.ok(
    r.transcript.at(-1).at > 1e12,
    `transcript ${r.transcript.at(-1).at}`,
  );
  assert.deepEqual(r.attempt, []);
  assert.deepEqual(r.proof, []);
});
test("Q1 X2: the composed pruning schedule with DEFAULT clocks passes", async () => {
  const r = await composed({ kind: "x2" });
  assert.deepEqual(r.attempt, []);
  assert.deepEqual(r.proof, []);
});
test("Q1: the same composition with a journal whose raw clock never moves (equal ticks) passes", async () => {
  const r = await composed({ kind: "x0", journalNow: () => 1_793_564_239_315 });
  assert.deepEqual([...r.attempt, ...r.proof], []);
});
test("Q1: the same composition with a raw wall clock that runs BACKWARDS passes (no reader orders by it)", async () => {
  let t = 2_000_000_000_000;
  const r = await composed({ kind: "x2", journalNow: () => (t -= 1000) });
  assert.deepEqual([...r.attempt, ...r.proof], []);
});
test("Q1 negative: the gate opened BEFORE the clock reached E — the composed reader refuses it (whatever the clocks)", async () => {
  const r = await composed({ kind: "x0", invert: true });
  assert.ok(
    r.proof.some((p) =>
      /forwarded before the clock reached E|not the server's 410/.test(p),
    ),
    JSON.stringify(r.proof),
  );
});

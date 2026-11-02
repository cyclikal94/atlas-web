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
//
// Revision 33 (R33-DIAG; design assessment of 2 Nov 2026, token 9fbb8181ecf04530aa69c0b722f7454d, C2/Q1-Q3): the composition now also
// carries the runner's SAVED route. The browser side goes through the maintained holding proxy (`createProxy`, correlation header) in front
// of the tap, as the runner composes them, and sends NON-SYNC traffic as well (a GET of the browser session and of a resource, a POST of an
// access command while the continuation waits at the gate, another GET after the refusal). The labelled window is then collected, joined to
// the proxy's downstream outcomes (`joinExchanges`), assembled (`assembleInterval`), written, read back and judged as the runner judges it:
// the generic reader (`validateInterval`, whose collection accounting must be complete) and the case's proof validator
// (`PROOF_VALIDATORS`) on BOTH collections (`proofExchanges`). Revision 32's projection dropped every non-sync exchange's journal
// references, so this route failed at each non-sync arrival while the raw sync-only route above passed.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createProxy } from "./delaying-proxy.mjs";
import {
  ATTEMPT_SCHEMA,
  attemptProblems,
  PROOF_SCHEMA,
  PROOF_VALIDATORS,
  proofExchanges,
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
import { CORRELATION_HEADER } from "./pair-attempts.mjs";
import {
  assembleInterval,
  CAUSAL_FIELDS,
  joinExchanges,
  validateInterval,
} from "./pair-evidence.mjs";

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
    // Revision 33: the browser's non-sync traffic (a resource read, an access command); the request body is read, never recorded.
    if (url.pathname.includes("/people/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "p1" }));
    }
    if (req.method === "POST" && url.pathname.endsWith("/access-commands")) {
      req.resume();
      return req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
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

/** Revision 33: the generic reader's collection-accounting problems (pair-evidence.mjs `validateInterval`, "Collection"). */
const ACCOUNTING =
  /collection window|bounded log|body writes|still open when the interval ended|listed more than once|outside the interval|tap exchanges in the interval|other_requests\[/;

/** The runner's composition, as `diagnosticStack` makes it, around the stand-in; then the spec's X0 or X2 schedule; then the readers. */
async function composed({ kind, journalNow, invert = false, corrupt = null }) {
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
  let proxy = null;
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
        correlation: CORRELATION_HEADER,
      },
    });
    await parts.bridge.listen();
    tapUrls = await parts.tap.start();
    // Revision 33: the browser reaches the tap through the holding proxy, as in the runner (the correlation header joins each exchange to
    // its downstream outcome), and the interval's window is the tap's label.
    proxy = createProxy({
      upstream: tapUrls.tapUrl,
      correlation: CORRELATION_HEADER,
    });
    const proxyUrls = await proxy.start();
    const IV = `PAIR-${kind.toUpperCase()}:node:iv`;
    const tapControl = async (method, path, body) => {
      const r = await fetch(`${tapUrls.controlUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return r.json();
    };
    const { seq: since } = await tapControl("POST", "/label", { label: IV });
    const browser = async (method, path, body) => {
      const r = await fetch(
        `${proxyUrls.proxyUrl}/api/experimental/v1${path}`,
        {
          method,
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json" },
              }),
        },
      );
      await r.arrayBuffer();
      assert.equal(r.status, 200, `${method} ${path}`);
    };
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
        `${proxyUrls.proxyUrl}/api/experimental/v1/sync?cursor=${encodeURIComponent(cursor)}&max_changes=4`,
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
      interval: IV,
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
    // Revision 33: non-sync reads before the staged piece (GET), as a page makes them.
    await browser("GET", "/browser-sessions/current");
    await browser("GET", "/people/p1");
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
    // Revision 33: a non-sync POST while the continuation waits (the gate holds /sync only).
    await browser("POST", "/access-commands", { command: "noop" });
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
    // Revision 33: the page's session check after the refusal (GET).
    await browser("GET", "/browser-sessions/current");
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
    // Revision 33: the interval's collection, as the spec makes it (tests/pair/support.ts `collect`): the label ends the window, the body
    // writes are flushed, the proxy's log is read.
    const { seq: until } = await tapControl("POST", "/label", { label: null });
    const flushed = await tapControl("POST", "/flush");
    const proxyLog = await (await fetch(`${proxyUrls.controlUrl}/log`)).json();
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
    // Revision 33: the SAVED route. The window's exchanges joined, assembled, written and read back; judged by the generic reader and by
    // the case's validator on both collections, as run-development-pair.mjs judges a saved interval.
    const window = joinExchanges(
      parts.tap.records.filter((r) => r.seq <= until && r.label === IV),
      proxyLog,
      [],
    );
    const bodies = (f) => readFileSync(join(evidence, "bodies", f));
    const assembled = assembleInterval({
      iv: {
        id: IV,
        caseId: proof.case,
        engine: "node",
        barriers: [],
        piecesPersisted: 0,
        attempts: [],
        target: null,
        handOff: { at_seq: refusedRec.seq, reason: "the server's real 410" },
        readerAccount: "reader",
        opening: null,
        holdReleases: [],
        observations: [],
        terminal: null,
        traces: [],
      },
      records: window,
      collection: {
        since,
        until,
        dropped_through: 0,
        pending_writes: flushed.pending_writes,
        write_errors: flushed.write_errors,
        unsettled: [],
      },
      details: {
        backend: "diagnostic",
        selection: "sel",
        apiVersion: "0.30.0",
        workload: "W-real",
        preGrantCursor: "c-before",
        driven: "prefix",
        requiredObservations: [],
        caller: "ordinary",
        localWork: false,
        terminal: "recovered",
        appliedRevision: null,
        oracle: { verdict: "match", problems: [] },
        person: "p1",
      },
      memory: { kind: null, reason: "the composed stand-in has no page" },
      readBody: bodies,
    });
    const intervalFile = join(evidence, "interval.json");
    writeFileSync(intervalFile, `${JSON.stringify(assembled, null, 2)}\n`);
    const saved = JSON.parse(readFileSync(intervalFile, "utf8"));
    const judged = corrupt ? corrupt(structuredClone(saved), ctx) : saved;
    const validator = PROOF_VALIDATORS[judged.case];
    return {
      attempt: attemptProblems(envelope, { readFile, expected }),
      proof: (kind === "x0" ? x0Problems : x2Problems)(proof, ctx),
      records,
      transcript: ctx.entries,
      window,
      saved,
      // The generic reader's collection accounting (its other checks need barriers, observations and a target this stand-in does not
      // drive; pair-evidence.test.mjs and pair-driver.test.mjs qualify them).
      accounting: validateInterval(judged, { readBody: bodies }).filter((p) =>
        ACCOUNTING.test(p),
      ),
      savedProof: validator
        ? validator(proof, {
            ...ctx,
            interval: judged,
            requests: proofExchanges(judged),
          })
        : [`no validator for ${judged.case}`],
    };
  } finally {
    await proxy?.stop().catch(() => undefined);
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

// ---- revision 33 (R33-DIAG): the saved route, mixed sync and non-sync traffic --------------------------------------------------------
/** The fields a non-sync exchange may persist: its accounting and its causal references (pair-evidence.mjs `CAUSAL_FIELDS`). */
const OTHER_FIELDS = new Set([
  "seq",
  "label",
  "proxy_id",
  "method",
  "path",
  "status",
  "upstream_error",
  "downstream",
  ...CAUSAL_FIELDS,
]);
const nonSync = (saved) => saved.other_requests;
const arrival = (seq) => `exchange ${seq}'s arrival`;

for (const kind of ["x0", "x2"])
  test(`R33 Q2 ${kind.toUpperCase()}: mixed sync/non-sync traffic through the proxy, tap, join, assembler and a JSON reload reaches the generic reader and the proof validator on both collections, and passes`, async () => {
    const r = await composed({ kind });
    assert.deepEqual(r.attempt, []);
    assert.deepEqual(r.proof, [], "the raw sync-only route still passes");
    const others = nonSync(r.saved);
    assert.ok(
      others.some((o) => o.method === "GET") &&
        others.some((o) => o.method === "POST"),
      `a GET and a POST came through the tap: ${JSON.stringify(others.map((o) => [o.method, o.path]))}`,
    );
    assert.equal(
      others.length,
      4,
      "the four non-sync exchanges of the schedule",
    );
    // Each one's references are its tap record's own, exactly; the tap writes no gate or delivery reference for a non-sync exchange,
    // and none is invented. Nothing else of the tap record is persisted.
    const bySeq = new Map(r.window.map((w) => [w.seq, w]));
    for (const o of others) {
      const raw = bySeq.get(o.seq);
      assert.ok(Number.isInteger(raw?.j_request), `exchange ${o.seq} raw`);
      assert.equal(o.j_request, raw.j_request, `exchange ${o.seq} j_request`);
      assert.equal(o.j_upstream_end, raw.j_upstream_end);
      assert.deepEqual(
        CAUSAL_FIELDS.filter((k) => k in o),
        ["j_request", "j_upstream_end"],
        `exchange ${o.seq}'s causal references`,
      );
      assert.deepEqual(
        Object.keys(o).filter((k) => !OTHER_FIELDS.has(k)),
        [],
        `exchange ${o.seq} persists only allowed fields`,
      );
      assert.equal(o.proxy_id, raw.proxy_id);
      assert.ok(Number.isInteger(o.proxy_id), "joined by its proxy id");
      assert.equal(o.downstream?.outcome, "delivered");
    }
    // Every exchange of the window exactly once across both collections.
    const seqs = proofExchanges(r.saved)
      .map((x) => x.seq)
      .sort((a, b) => a - b);
    const { since, until } = r.saved.collection;
    assert.deepEqual(
      seqs,
      Array.from({ length: until - since }, (_, i) => since + 1 + i),
    );
    assert.deepEqual(r.accounting, [], "the generic reader's accounting");
    assert.deepEqual(
      r.savedProof,
      [],
      "the proof validator on both collections",
    );
  });

test("R33 Q2 control: revision 32's projection (every non-sync journal reference absent) is refused at each non-sync arrival", async () => {
  const r = await composed({
    kind: "x0",
    corrupt: (saved) => {
      for (const o of saved.other_requests)
        for (const k of CAUSAL_FIELDS) delete o[k];
      return saved;
    },
  });
  assert.deepEqual(r.accounting, []);
  const seqs = nonSync(r.saved).map((o) => o.seq);
  for (const seq of seqs)
    assert.ok(
      r.savedProof.includes(`${arrival(seq)} names no journal position`),
      `exchange ${seq}: ${JSON.stringify(r.savedProof)}`,
    );
  assert.equal(
    r.savedProof.filter((p) => /arrival names no journal position/.test(p))
      .length,
    seqs.length,
    "exactly the non-sync arrivals (the sync records keep theirs)",
  );
});

/** One corrupted NON-SYNC exchange (the POST unless named), refused by the saved route with `expected` (a string the problem contains). */
async function refusedNonSync(change, expected, { pick = "POST" } = {}) {
  let target = null;
  const r = await composed({
    kind: "x0",
    corrupt: (saved, ctx) => {
      const others = saved.other_requests;
      target = others.find((o) => o.method === pick);
      change(target, { saved, others, ctx });
      return saved;
    },
  });
  assert.ok(target, "the corrupted exchange exists");
  const want =
    typeof expected === "function" ? expected(target, r.saved) : expected;
  assert.ok(
    r.savedProof.some((p) => p.includes(want)) ||
      r.accounting.some((p) => p.includes(want)),
    `${want}: ${JSON.stringify([...r.accounting, ...r.savedProof])}`,
  );
  return r;
}
const eventOf = (ctx, producer, kind) =>
  [...ctx.journal.entries()].find(
    ([, e]) => e.producer === producer && e.kind === kind,
  )?.[0];

test("R33 Q3 refused: a non-sync exchange without its arrival reference (the reader is given every collection)", async () => {
  await refusedNonSync(
    (o) => {
      delete o.j_request;
    },
    (o) => `${arrival(o.seq)} names no journal position`,
  );
});
test("R33 Q3 refused: a non-sync exchange naming ANOTHER exchange's arrival", async () => {
  await refusedNonSync(
    (o, { saved }) => {
      o.j_request = saved.requests[0].j_request;
    },
    (o, saved) =>
      `${arrival(o.seq)} names journal event ${saved.requests[0].j_request}, whose seq is ${saved.requests[0].seq}, not ${o.seq}`,
  );
});
test("R33 Q3 refused: a non-sync arrival naming its own upstream end (the wrong event kind)", async () => {
  await refusedNonSync((o) => {
    o.j_request = o.j_upstream_end;
  }, "a tap.upstream_end, not a tap.request");
});
test("R33 Q3 refused: a non-sync arrival naming a bridge marker (another producer)", async () => {
  await refusedNonSync((o, { ctx }) => {
    o.j_request = eventOf(ctx, "bridge", "mark");
  }, "a bridge.mark, not a tap.request");
});
test("R33 Q3 refused: a non-sync arrival naming an event the journal does not hold", async () => {
  await refusedNonSync((o) => {
    o.j_request = 999_999;
  }, "which the journal does not hold");
});
test("R33 Q3 refused: a malformed (non-integer) non-sync arrival is not accepted", async () => {
  await refusedNonSync(
    (o) => {
      o.j_request = String(o.j_request);
    },
    (o) => `${arrival(o.seq)} names no journal position`,
  );
});
test("R33 Q3 refused: a non-sync upstream end whose status is not the exchange's", async () => {
  await refusedNonSync(
    (o) => {
      o.status = 500;
    },
    (o) => `exchange ${o.seq}'s upstream end names journal event`,
    { pick: "GET" },
  );
});
test("R33 Q3 refused: an omitted non-sync exchange (the window's accounting)", async () => {
  await refusedNonSync((o, { others }) => {
    others.splice(others.indexOf(o), 1);
  }, "tap exchanges in the interval");
});
test("R33 Q3 refused: a duplicated non-sync exchange", async () => {
  await refusedNonSync((o, { others }) => {
    others.push(structuredClone(o));
  }, "an exchange is listed more than once");
});
test("R33: the runner gives a saved interval's proof reader every collection (proofExchanges)", () => {
  const runner = readFileSync(
    new URL("./run-development-pair.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    runner.includes("requests: proofExchanges(interval),"),
    "run-development-pair.mjs passes proofExchanges(interval) to the validator",
  );
  assert.deepEqual(
    proofExchanges({
      requests: [{ seq: 1 }],
      other_requests: [{ seq: 2 }, { seq: 3 }],
    }).map((x) => x.seq),
    [1, 2, 3],
  );
  assert.deepEqual(proofExchanges({ requests: [{ seq: 1 }] }), [{ seq: 1 }]);
});

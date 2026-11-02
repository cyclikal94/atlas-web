// WEB-09c revision 26 (R26-DIAG, family `segmented-sync-development-pairing`): the maintained client ADAPTER of the approved diagnostic
// executable `atlas-sync-diagnostic` (pair-selection.mjs DIAGNOSTIC_SELECTION). It owns one fixture ATTEMPT: launch, the ready receipt,
// the private stdin/stdout control protocol, the transcript, and the shutdown; and it gives the spec (a separate Playwright process) a
// narrow, private bridge to a few commands over an owned Unix socket. Nothing here starts a browser, and nothing is added to the backend,
// the preview or the product.
//
// The protocol is the executable's own (backend crates/server/src/bin/atlas-sync-diagnostic.rs at the approved HEAD; docs/testing.md
// "Sync diagnostic fixture"):
//   - argv `--fixture-dir NEW_ABSOLUTE_DIR --attempt ID --bind 127.0.0.1:0 --public-origin ORIGIN`; any inherited `ATLAS_*` variable is
//     refused, so the child gets an explicit allow-listed environment (`childEnvironment`), never the runner's (which carries ATLAS_IT_);
//   - stdout: first `{"event":"ready","receipt":{schema 2 …},"receipt_sha256"}` (or `{"event":"failed"}`), then one answer per accepted
//     command `{"attempt","seq","op","ok",("result"|"error"),"effect","sync_now",("partial"),("ownership_lost")}`, and the events
//     `rejected` (consumes nothing), `ownership_lost`, `failed`, `stopped {"seq","served","removed","cleanup_error"}`;
//   - stdin: JSON lines `{"attempt","seq","op","args"}`, seq from 1, at most 8 KiB; EOF stops the attempt keeping the fixture;
//   - stderr: the server's log plus `diagnostic_http` / `diagnostic_control` / `diagnostic_sync_time` admission events.
//
// Invariants this adapter keeps (design assessment of 1 Nov 2026, §4):
//   - exactly ONE command outstanding; a sequence number is consumed only when its line was written; nothing is ever re-sent;
//   - an accepted command that failed with any effect other than `none`, a missing acknowledgement, a rejection of a line we sent, an
//     unsolicited stop, an ownership loss, a refused HTTP admission, malformed output or an early exit LATCHES the attempt: it can never
//     again produce passing evidence (`latched`), and no further command is sent;
//   - success needs the sequenced `shutdown {remove: true}` answered by its `stopped` with `served: true`, the owned files removed and no
//     cleanup error; the fixture's PARENT is never removed recursively (`removeParentIfEmpty`).
//
// Revision 27 (R27-DIAG.a, design assessment C1): with the attempt's `journal` (causal-journal.mjs), every transcript line the control
// writes or reads and every bridge call, answer and marker is ALSO an event of the attempt's one causal order, and carries its position `j`.
// The `at` fields stay raw `Date.now()` of the runner (diagnosis only); no reader orders events by them. The spec's actions are bracketed by
// acknowledged markers (`POST /mark`), so nothing compares the spec's own clock with the runner's.
// Revision 27 (DA-DIAG-F, C5): `concludeAttempt` validates the evidence BEFORE the owned shutdown decides whether the fixture is removed,
// and again after it (terminal); a known failure keeps the fixture.
// Revision 34 (R34-RET, family `diagnostic-fixture-retention-composition`): a preliminary pass alone never authorises the only inspectable
// fixture's removal, because the terminal judgement (stopped, served, exit, saved evidence) comes AFTER the executable's own removal. Before
// the sequenced shutdown, `preserveFixture` ANCHORS the owned files: a hard link of each to a private retained directory outside the
// fixture's parent and every recursively removed tree, bound to the receipt's directory/database identities and receipt hash. Removal is
// asked only once that anchor is verified (`concludeAttempt` `preserve`); the executable's unlink then removes a NAME, never the bytes.
// After the executable's exit (no writer is left), `materialiseRetained` hashes the final anchored bytes and materialises a verified,
// self-contained inspectable copy (SQLite integrity check + VACUUM INTO, with the WAL when one was anchored), sealed by a manifest. A failed
// anchor keeps the source (remove:false); nothing here ever deletes a file; the retained directory survives every outcome, success included.
// Revision 35 (R35-RET, incomplete fix of the same family): inodes are not one SQLite state. A WAL anchored and later RETIRED (the last
// connection checkpointed and deleted it; a new WAL's commits were then checkpointed into the same database inode) was replayed over newer
// pages and sealed as `verified`. Now (1) a separate read-only reader process (diagnostic-guard.mjs, `acquireGuard`) holds the database
// from BEFORE the anchor until AFTER the exit, so SQLite cannot retire the anchored WAL; the anchor binds that generation and removal also
// needs the guard; (2) `materialiseRetained` selects ONE authoritative set: the final named state when the source was kept, or the anchors
// of a removed source only with the guard's complete proof (held, never lost, released after the exit, the WAL found by the executable's
// own removal); otherwise `failed`, the raw anchors kept; (3) the retention record (/2) states that selection and proof.
// Revision 36 (R36-RET, regression of revision 35; design assessment of 2 Nov 2026, token 41c6b27cf2ff4ddf898b1066cb9640d4, C1-C4):
// revision 35's guard opened the fixture's PATHNAME with SQLite before ownership was bound, creating companions beside a replacement. Now
// (1) ONE owned-source check (`ownedSource`: the ready receipt's directory/database paths and identities, its digest, the attempt, no
// ownership-loss latch, lstat only) gates both the guard (before its child is spawned) and the anchor (before any directory or link is
// made); (2) the guard is given that authority and binds the file SQLite opens to the receipt's inode through a private hard link in its
// own directory (diagnostic-guard.mjs), so SQLite never opens a fixture path; (3) a removed source whose WAL the executable's last close
// retired is materialised as its anchored database ALONE (`retired-into-database`: SQLite deletes a WAL only after checkpointing all of
// it), corroborated by replaying the anchored WAL over a copy and finding no change — so a guard lost before that close no longer costs
// the coherent state; (4) the retention record (/3) and the guard method (/2) carry the authority and the binding, for both readers.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createJournal } from "./causal-journal.mjs";
import {
  GUARD_METHOD,
  GUARD_NAME,
  authorityProblems as guardAuthorityProblems,
} from "./diagnostic-guard.mjs";
import { createTap } from "./pair-tap.mjs";

export const RETENTION_SECONDS = 90 * 86400;
export const MAX_COMMAND_BYTES = 8192;
/** What the spec may ask through the bridge; account creation and shutdown belong to the runner alone. */
export const SPEC_OPERATIONS = Object.freeze([
  "inspect",
  "age_history",
  "advance_clock",
  "collect",
]);
/** The effect each operation's successful answer must report (atlas-sync-diagnostic.rs `run`). */
export const SUCCESS_EFFECT = Object.freeze({
  inspect: "none",
  add_account: "applied",
  age_history: "applied",
  advance_clock: "applied",
  collect: "applied",
});
/** The names the executable may create and `remove` may delete (atlas-sync-diagnostic.rs OWNED). */
export const OWNED_FILES = Object.freeze([
  "fixture.sqlite",
  "fixture.sqlite-wal",
  "fixture.sqlite-shm",
  "fixture.sqlite-journal",
  "receipt.json",
]);
export const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const FIXTURE_PATH_PATTERN = /^\/[A-Za-z0-9/._-]+$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A fresh attempt id: letters, digits and `-` only (the executable's rule), never reused. */
export const newAttemptId = (caseId, engine) =>
  `${caseId}-${engine}-${randomBytes(6).toString("hex")}`.replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );

/**
 * The child's whole environment: only these inherited names, and never an `ATLAS_*` one (the executable refuses any; the runner's own
 * ownership mark ATLAS_IT_… must not reach it). Throws if the result would still hold one (a caller passing a poisoned allow-list).
 */
export const CHILD_ENV_ALLOWED = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
]);
export function childEnvironment(
  source = process.env,
  allowed = CHILD_ENV_ALLOWED,
) {
  const env = {};
  for (const name of allowed)
    if (typeof source[name] === "string") env[name] = source[name];
  const leaked = Object.keys(env).filter((k) => k.startsWith("ATLAS_"));
  if (leaked.length > 0)
    throw new Error(`refusing to pass ${leaked.join(", ")} to the diagnostic`);
  return env;
}

/** The executable's argv. The fixture directory must not exist (the executable creates it); the bind is always a loopback literal. */
export function launchArguments({ fixtureDir, attempt, publicOrigin }) {
  if (!FIXTURE_PATH_PATTERN.test(fixtureDir))
    throw new Error(
      `the fixture directory ${fixtureDir} is not an absolute [A-Za-z0-9/._-] path`,
    );
  if (!ATTEMPT_PATTERN.test(attempt))
    throw new Error(`the attempt id ${attempt} is not 1-64 of [A-Za-z0-9_-]`);
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.hostname !== "127.0.0.1")
    throw new Error(
      `the public origin ${publicOrigin} is not a canonical loopback origin`,
    );
  return [
    "--fixture-dir",
    fixtureDir,
    "--attempt",
    attempt,
    "--bind",
    "127.0.0.1:0",
    "--public-origin",
    publicOrigin,
  ];
}

/**
 * One stdout/stdin line as JSON, keeping file identities exact: `dev` and `ino` are u64 in the receipt and may exceed 2^53, so they are
 * kept as their decimal source text (JSON.parse with source text, Node >= 21). Throws on malformed JSON.
 */
export function parseLine(text) {
  return JSON.parse(text, (key, value, context) =>
    (key === "dev" || key === "ino") && typeof value === "number"
      ? (context?.source ?? String(value))
      : value,
  );
}

/**
 * The ready event against what this attempt launched. `expected`: attempt, pid, fixtureDir (canonical), executable {path (canonical),
 * sha256}, apiVersion, publicOrigin, features, retentionSeconds. `observed`: receiptBytes (receipt.json as read from disk), dir and
 * database identities from stat ({dev, ino} as decimal strings). Returns the problems (none: this is our fixture, ready).
 */
export function readyProblems(event, expected, observed) {
  const problems = [];
  const bad = (p) => problems.push(p);
  if (event?.event !== "ready")
    return [
      `the first line is not ready: ${JSON.stringify(event)?.slice(0, 300)}`,
    ];
  const r = event.receipt;
  if (r === null || typeof r !== "object")
    return ["the ready event has no receipt"];
  const want = (what, got, value) => {
    if (JSON.stringify(got) !== JSON.stringify(value))
      bad(
        `receipt ${what} ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`,
      );
  };
  want("schema", r.schema, 2);
  want("kind", r.kind, "atlas-sync-diagnostic-receipt");
  want("attempt", r.attempt, expected.attempt);
  want("pid", r.pid, expected.pid);
  want("fixture directory", r.fixture_dir?.path, expected.fixtureDir);
  want("database", r.database?.path, `${expected.fixtureDir}/fixture.sqlite`);
  want("executable path", r.executable?.path, expected.executable.path);
  want("executable sha256", r.executable?.sha256, expected.executable.sha256);
  want("features", r.features, expected.features);
  want("api_version", r.api_version, expected.apiVersion);
  want("public origin", r.public_origin, expected.publicOrigin);
  want("retention", r.retention_seconds, expected.retentionSeconds);
  if (!(Number.isSafeInteger(r.sync_start) && r.sync_start > 0))
    bad(`receipt sync_start ${r.sync_start}`);
  const address = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(String(r.address));
  if (!address || Number(address[1]) < 1 || Number(address[1]) > 65535)
    bad(`receipt address ${r.address} is not a loopback port`);
  if (
    observed.dir === null ||
    r.fixture_dir?.dev !== observed.dir?.dev ||
    r.fixture_dir?.ino !== observed.dir?.ino
  )
    bad("the fixture directory's identity is not the receipt's");
  if (
    observed.database === null ||
    r.database?.dev !== observed.database?.dev ||
    r.database?.ino !== observed.database?.ino
  )
    bad("the database file's identity is not the receipt's");
  if (!observed.receiptBytes) bad("receipt.json could not be read");
  else {
    const onDisk = sha256(observed.receiptBytes);
    if (onDisk !== event.receipt_sha256)
      bad(
        `receipt.json hashes to ${onDisk}, the ready event says ${event.receipt_sha256}`,
      );
    let parsed = null;
    try {
      parsed = parseLine(String(observed.receiptBytes));
    } catch {
      bad("receipt.json is not JSON");
    }
    if (parsed !== null && JSON.stringify(parsed) !== JSON.stringify(r))
      bad("receipt.json is not the receipt the ready event carries");
  }
  return problems;
}

/** Why an attempt can no longer be evidence. */
export class Latched extends Error {
  constructor(kind, detail) {
    super(`the diagnostic attempt is latched (${kind}): ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}
/** An accepted command answered `ok: false` (its sequence number was consumed). */
export class CommandFailed extends Error {
  constructor(answer) {
    super(
      `diagnostic ${answer.op} #${answer.seq} failed: ${answer.error ?? "no error text"} (effect ${answer.effect})`,
    );
    this.answer = answer;
  }
}

/**
 * The control protocol over one child's streams. `input` is the child's stdin (writable), `output` its stdout and `errors` its stderr
 * (readable). `record(entry)` receives every line, in order, as `{n, at, stream, line}` (the caller persists it incrementally).
 * `timeoutMs` bounds each acknowledgement (the executable waits at most 10 s for quiescence before answering).
 *
 * Returns { ready: Promise<ready event>, send(op, args), shutdown(remove), state(), latched() }.
 */
export function createControl({
  input,
  output,
  errors,
  attempt,
  record = () => undefined,
  journal = null,
  now = () => Date.now(),
  timeoutMs = 30_000,
  readyTimeoutMs = 60_000,
  maxOutputLine = 8 * 1024 * 1024,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t),
}) {
  let n = 0;
  let next = 1;
  let phase = "starting";
  let latched = null;
  let pending = null;
  let unanswered = null;
  let stopped = null;
  let readyEvent = null;
  const answers = [];
  let settleReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = { resolve, reject };
  });
  ready.catch(() => undefined);
  const note = (stream, line, ref = {}) => {
    n += 1;
    const j = journal
      ? journal.record("control", stream, { n, ...ref })
      : undefined;
    record({ n, ...(j === undefined ? {} : { j }), at: now(), stream, line });
  };
  const latch = (kind, detail) => {
    if (latched === null) latched = { kind, detail, at: now() };
    cancel(readyTimer);
    const error = new Latched(kind, detail);
    if (phase === "starting") settleReady.reject(error);
    if (pending) {
      const p = pending;
      pending = null;
      cancel(p.timer);
      p.reject(error);
    }
    return error;
  };
  const readyTimer = schedule(() => {
    if (phase === "starting")
      latch("no_ready", `no ready event within ${readyTimeoutMs} ms`);
  }, readyTimeoutMs);

  const onLine = (text) => {
    note("stdout", text);
    let event;
    try {
      event = parseLine(text);
    } catch {
      latch(
        "malformed_output",
        `stdout line is not JSON: ${text.slice(0, 200)}`,
      );
      return;
    }
    if (phase === "starting") {
      cancel(readyTimer);
      if (event?.event === "ready") {
        phase = "ready";
        readyEvent = event;
        settleReady.resolve(event);
      } else if (event?.event === "failed")
        latch("failed", `the executable failed to start: ${event.error}`);
      else
        latch("protocol", `the first line is not ready: ${text.slice(0, 200)}`);
      return;
    }
    if (event?.event === "stopped") {
      phase = "stopped";
      stopped = event;
      if (pending?.op === "shutdown" && event.seq === pending.seq) {
        const p = pending;
        pending = null;
        cancel(p.timer);
        p.resolve(event);
        return;
      }
      latch(
        "unexpected_stop",
        `the executable stopped without our shutdown: ${text.slice(0, 300)}`,
      );
      return;
    }
    if (event?.event === "ownership_lost") {
      latch("ownership_lost", String(event.error));
      return;
    }
    if (event?.event === "failed") {
      latch("failed", String(event.error));
      return;
    }
    if (event?.event === "rejected") {
      // We only ever write well-formed lines with the next sequence number: any rejection means the channel is not what we think it is.
      latch("rejected", `${event.error}${event.stopping ? " (stopping)" : ""}`);
      return;
    }
    const isAnswer =
      pending !== null &&
      event?.attempt === attempt &&
      event?.seq === pending.seq &&
      event?.op === pending.op &&
      typeof event?.ok === "boolean";
    if (!isAnswer) {
      latch(
        "unexpected_output",
        `an answer nothing was waiting for: ${text.slice(0, 300)}`,
      );
      return;
    }
    const p = pending;
    pending = null;
    cancel(p.timer);
    answers.push({
      seq: event.seq,
      op: event.op,
      ok: event.ok,
      effect: event.effect,
    });
    if (event.ownership_lost === true) {
      const error = latch(
        "ownership_lost",
        `answer #${event.seq}: ${event.error}`,
      );
      p.reject(error);
      return;
    }
    if (event.ok !== true) {
      // The sequence number is consumed; a failure that may have changed the fixture leaves the attempt unknowable.
      if (event.effect !== "none")
        latch(
          "ambiguous_effect",
          `#${event.seq} ${event.op} failed with effect ${event.effect}`,
        );
      p.reject(new CommandFailed(event));
      return;
    }
    if (event.effect !== SUCCESS_EFFECT[event.op]) {
      const error = latch(
        "unexpected_effect",
        `#${event.seq} ${event.op} succeeded with effect ${event.effect}, expected ${SUCCESS_EFFECT[event.op]}`,
      );
      p.reject(error);
      return;
    }
    p.resolve(event);
  };

  let buffer = "";
  output.setEncoding?.("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.length > 0) onLine(line);
    }
    if (buffer.length > maxOutputLine)
      latch("malformed_output", `a stdout line over ${maxOutputLine} bytes`);
  });
  output.on("end", () => {
    if (buffer.length > 0) {
      note("stdout", buffer);
      latch("malformed_output", "an unterminated last stdout line");
    }
    if (phase !== "stopped")
      latch("exited", "stdout ended before a stopped event");
  });
  let errorBuffer = "";
  errors?.setEncoding?.("utf8");
  errors?.on("data", (chunk) => {
    errorBuffer += chunk;
    for (;;) {
      const at = errorBuffer.indexOf("\n");
      if (at < 0) break;
      const line = errorBuffer.slice(0, at);
      errorBuffer = errorBuffer.slice(at + 1);
      note("stderr", line);
      // A refused HTTP admission is the fixture's ownership loss seen from the HTTP side.
      if (line.includes('"diagnostic_http"') && line.includes('"refused"'))
        latch("http_refused", line.slice(0, 300));
    }
  });
  errors?.on("end", () => {
    if (errorBuffer.length > 0) note("stderr", errorBuffer);
  });
  input.on?.("error", (error) =>
    latch("stdin", String(error?.message ?? error)),
  );

  const write = (op, args, { evenIfLatched = false } = {}) => {
    if (latched && !evenIfLatched)
      throw new Latched(latched.kind, latched.detail);
    if (unanswered)
      throw new Latched(
        "no_acknowledgement",
        `#${unanswered.seq} ${unanswered.op} was never answered: nothing more is sent`,
      );
    if (phase !== "ready")
      throw new Error(`no command can be sent while the attempt is ${phase}`);
    if (pending)
      throw new Error(
        `#${pending.seq} ${pending.op} is still outstanding (one command at a time)`,
      );
    const seq = next;
    const line = JSON.stringify({ attempt, seq, op, args: args ?? {} });
    if (Buffer.byteLength(line) + 1 > MAX_COMMAND_BYTES)
      throw new Error(
        `the ${op} command is over ${MAX_COMMAND_BYTES} bytes; nothing was sent`,
      );
    next += 1;
    return new Promise((resolve, reject) => {
      pending = {
        seq,
        op,
        resolve,
        reject,
        timer: schedule(() => {
          if (pending?.seq === seq) {
            // The command may still be running in the executable: nothing more is ever written (finishAttempt closes stdin instead).
            unanswered = { seq, op };
            latch(
              "no_acknowledgement",
              `#${seq} ${op} was not acknowledged within ${timeoutMs} ms (never re-sent)`,
            );
          }
        }, timeoutMs),
      };
      note("stdin", line, { seq, op });
      input.write(`${line}\n`);
    });
  };
  return {
    ready,
    /** One command; resolves with its successful answer. Never re-sent. */
    send(op, args) {
      if (op === "shutdown") throw new Error("use shutdown()");
      if (!(op in SUCCESS_EFFECT))
        throw new Error(`unknown diagnostic operation ${op}`);
      return write(op, args);
    },
    /** The sequenced shutdown; resolves with its `stopped` event. Allowed on a latched attempt that is still running (to stop it). */
    shutdown(remove) {
      // A latched attempt is never cleaned up by us: its fixture is kept for inspection (`remove` must then be false).
      if (latched && remove)
        throw new Latched(
          latched.kind,
          `${latched.detail} (a latched attempt keeps its fixture)`,
        );
      return write("shutdown", { remove }, { evenIfLatched: true });
    },
    state: () => ({
      phase,
      next,
      latched,
      outstanding: pending ? { seq: pending.seq, op: pending.op } : null,
      unanswered,
      ready: readyEvent,
      stopped,
      answers: [...answers],
    }),
    latched: () => latched,
  };
}

// ---- the spec's private bridge: an owned Unix socket, one bearer secret per attempt ----------------------------------------------------
const tokenOk = (presented, token) => {
  const a = Buffer.from(String(presented ?? ""));
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
};
/**
 * Serves `POST /command {op, args}` and `GET /state` on `socketPath` for the attempt's `control`, to a caller presenting `token`. Only
 * `allowed` operations pass; one at a time (the control refuses an overlapping one). Every call is reported to `onCall` (the runner keeps
 * them with the attempt). Answers: 200 {answer}; 409 {failed: answer} (accepted, ok:false); 423 {latched}; 400/401/403 refusals.
 */
export const MARK_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
export function createControlServer({
  control,
  socketPath,
  token,
  allowed = SPEC_OPERATIONS,
  onCall = () => undefined,
  onMark = () => undefined,
  journal = null,
  now = () => Date.now(),
}) {
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!tokenOk(req.headers.authorization, token))
      return reply(401, { error: "unauthorised" });
    if (req.method === "GET" && req.url === "/state")
      return reply(200, control.state());
    if (
      !(
        req.method === "POST" &&
        (req.url === "/command" || req.url === "/mark")
      )
    )
      return reply(404, { error: "not found" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) return reply(400, { error: "too large" });
    }
    let call;
    try {
      call = JSON.parse(body);
    } catch {
      return reply(400, { error: "not JSON" });
    }
    if (req.url === "/mark") {
      // An acknowledged MARKER of the spec (revision 27): its position is assigned now, when the runner receives it, and answered before
      // the spec acts; the spec's own clock is never used.
      if (!journal) return reply(409, { error: "this attempt has no journal" });
      if (!MARK_PATTERN.test(String(call?.name ?? "")))
        return reply(400, {
          error: `the marker name ${call?.name} is refused`,
        });
      const j = journal.record("bridge", "mark", { name: call.name });
      onMark({ name: call.name, j, at: now() });
      return reply(200, { name: call.name, j });
    }
    if (!allowed.includes(call?.op))
      return reply(403, { error: `the spec may not send ${call?.op}` });
    const entry = { op: call.op, args: call.args ?? {}, at_request: now() };
    if (journal)
      entry.j_request = journal.record("bridge", "call", { op: call.op });
    const answered = (outcome, seq) => {
      entry.at_answer = now();
      if (journal)
        entry.j_answer = journal.record("bridge", "answer", {
          op: call.op,
          seq: seq ?? null,
          outcome,
        });
    };
    try {
      const answer = await control.send(call.op, call.args ?? {});
      answered("ok", answer.seq);
      Object.assign(entry, { seq: answer.seq, outcome: "ok" });
      onCall(entry);
      return reply(200, {
        answer,
        ...(journal
          ? { j_request: entry.j_request, j_answer: entry.j_answer }
          : {}),
      });
    } catch (error) {
      const outcome = error?.constructor?.name ?? "Error";
      answered(
        outcome,
        error instanceof CommandFailed ? error.answer.seq : null,
      );
      Object.assign(entry, {
        outcome,
        error: String(error?.message ?? error),
      });
      if (error instanceof CommandFailed) {
        entry.seq = error.answer.seq;
        onCall(entry);
        return reply(409, { failed: error.answer, latched: control.latched() });
      }
      onCall(entry);
      return reply(423, { error: entry.error, latched: control.latched() });
    }
  });
  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve(socketPath));
      }),
    // Every bridge connection ends with the attempt: an unanswered call is cut, never left holding the runner open.
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The spec's side of the bridge. Resolves with {status, body}; never retries. */
export function controlCall({ socketPath, token }, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// ---- tokens -------------------------------------------------------------------------------------------------------------------------
/**
 * The header of a continuation the server ISSUED (`d2.{boundary:016x}.{expiry:016x}.{revision:016x}.{index:08x}.{sealed}.{mac}`,
 * crates/core/src/sync_cursor.rs `sign_continuation`), read, never altered or re-signed. Null for anything else.
 */
export function continuationOf(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 7 || parts[0] !== "d2") return null;
  const lengths = [16, 16, 16, 8, 8, 64];
  if (
    !lengths.every(
      (len, i) =>
        parts[i + 1].length === len && /^[0-9a-f]+$/.test(parts[i + 1]),
    )
  )
    return null;
  const number = (s) => Number.parseInt(s, 16);
  return {
    boundary: number(parts[1]),
    expiry: number(parts[2]),
    revision: number(parts[3]),
    index: number(parts[4]),
  };
}

// ---- one attempt's lifetime ---------------------------------------------------------------------------------------------------------
/**
 * Launches one attempt. `deps`: spawn(command, args, options) → child (the runner's owned-group spawn), realpath, exists, stat(path) →
 * {dev, ino} as decimal strings (or throws), readFile, record(entry). `fixtureParent` is the attempt's own directory (not removed
 * recursively by anyone); the leaf `fixture-<attempt>` must not exist. Resolves with the running attempt and its ready problems (the caller
 * refuses to use an attempt with any); throws (latched) if no ready event arrives.
 */
export async function launchAttempt(
  deps,
  {
    executable,
    executableSha256,
    fixtureParent,
    attempt,
    publicOrigin,
    apiVersion,
    features,
    retentionSeconds = RETENTION_SECONDS,
    env = childEnvironment(),
    journal = null,
    timeoutMs,
    readyTimeoutMs,
  },
) {
  const fixtureDir = `${deps.realpath(fixtureParent)}/fixture-${attempt}`;
  if (deps.exists(fixtureDir))
    throw new Error(`the fixture directory ${fixtureDir} already exists`);
  const args = launchArguments({ fixtureDir, attempt, publicOrigin });
  const child = deps.spawn(executable, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const control = createControl({
    input: child.stdin,
    output: child.stdout,
    errors: child.stderr,
    attempt,
    record: deps.record,
    journal,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(readyTimeoutMs ? { readyTimeoutMs } : {}),
  });
  // Revision 34 (design assessment C1): the launch intent (the owned process and the leaf it was told to create) is recorded BEFORE ready
  // is awaited, so an attempt that never becomes ready is still attributable; it is an intent, never a verified receipt.
  deps.onSpawn?.({ pid: child.pid ?? null, fixtureDir, args });
  const ready = await control.ready;
  const statOrNull = (path) => {
    try {
      return deps.stat(path);
    } catch {
      return null;
    }
  };
  let receiptBytes = null;
  try {
    receiptBytes = deps.readFile(`${fixtureDir}/receipt.json`);
  } catch {
    receiptBytes = null;
  }
  const problems = readyProblems(
    ready,
    {
      attempt,
      pid: child.pid,
      fixtureDir,
      executable: { path: deps.realpath(executable), sha256: executableSha256 },
      apiVersion,
      publicOrigin,
      features,
      retentionSeconds,
    },
    {
      receiptBytes,
      dir: statOrNull(fixtureDir),
      database: statOrNull(`${fixtureDir}/fixture.sqlite`),
    },
  );
  return {
    child,
    control,
    exited,
    args,
    env: Object.keys(env).sort(),
    fixtureDir,
    ready,
    receiptBytes,
    problems,
    backendUrl: `http://${ready.receipt.address}`,
  };
}

/**
 * Ends one attempt, owned and in order: the sequenced `shutdown` (removing the owned files only when `remove` and the attempt is not
 * latched), its `stopped` event, then the process's exit. When no command can be sent (an outstanding one, or the attempt already
 * stopped), stdin is closed (EOF: the executable stops and KEEPS the fixture). Never signals the process: an attempt that does not exit
 * is reported, and the runner's owned-group clean-up then stops it (still a failed attempt). Resolves with what happened.
 */
export async function finishAttempt(
  running,
  { remove, exitTimeoutMs = 20_000 },
) {
  const { control, child } = running;
  const state = control.state();
  const outcome = {
    requested_remove: remove,
    stopped: null,
    shutdown_error: null,
    eof: false,
    exit: null,
  };
  // After an unanswered command `write` refuses every line (shutdown included): the attempt is then ended by EOF below.
  if (state.phase === "ready" && state.outstanding === null) {
    try {
      outcome.stopped = await control.shutdown(
        remove && state.latched === null,
      );
    } catch (error) {
      outcome.shutdown_error = String(error?.message ?? error);
    }
  }
  if (child.stdin && !child.stdin.destroyed) {
    outcome.eof = outcome.stopped === null;
    child.stdin.end();
  }
  let timer;
  outcome.exit = await Promise.race([
    running.exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), exitTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
  outcome.latched = control.latched();
  outcome.stopped ??= control.state().stopped;
  return outcome;
}

/** Removes the attempt's own parent directory only if it is EMPTY (never recursively): a kept fixture or a replacement file stays. */
export function removeParentIfEmpty(deps, parent) {
  try {
    deps.rmdir(parent);
    return { removed: true, error: null };
  } catch (error) {
    return {
      removed: false,
      error: String(error?.code ?? error?.message ?? error),
    };
  }
}

// ---- revision 35 (R35-RET): one SQLite generation, held by a separate read-only reader from before the anchor until after the exit ----
/** The guard child (diagnostic-guard.mjs: why it is a separate process, and its protocol). */
export const GUARD_SCRIPT = new URL("./diagnostic-guard.mjs", import.meta.url)
  .pathname;
export { GUARD_METHOD };
/** Revision 36: the control latches that mean the fixture is no longer the attempt's (createControl): nothing of it is opened or anchored. */
export const OWNERSHIP_LOST_LATCHES = Object.freeze([
  "ownership_lost",
  "http_refused",
]);
/**
 * Revision 36 (R36-RET, design assessment C1): the ONE owned-source check before the guard and the anchor. `fixtureDir`, the ready
 * `receipt` (its `fixture_dir`/`database` paths and identities) and `receiptSha256` are the attempt's authority; `latch` the control's
 * latch at the decision. Only `deps.lstat` is used (never following a link; nothing is opened, read, linked or created). Returns
 * { owned, authority: {attempt, fixture_dir, database, receipt_sha256} | null, problems }.
 */
export function ownedSource(
  deps,
  { attempt, fixtureDir, receipt, receiptSha256, latch = null },
) {
  const problems = [];
  const bad = (p) => {
    problems.push(p);
    return { owned: false, authority: null, problems };
  };
  if (!ATTEMPT_PATTERN.test(String(attempt ?? "")))
    return bad(`the attempt id ${JSON.stringify(attempt)} is not one`);
  if (OWNERSHIP_LOST_LATCHES.includes(latch?.kind))
    return bad(
      `the attempt lost its fixture (${latch.kind}): nothing of it is opened or anchored`,
    );
  if (!receipt?.fixture_dir || !receipt?.database || !receiptSha256)
    return bad("no ready receipt: nothing can be attributed to this attempt");
  if (!FIXTURE_PATH_PATTERN.test(String(fixtureDir ?? "")))
    return bad(`the fixture path ${fixtureDir} is not a safe absolute path`);
  if (
    receipt.fixture_dir.path !== fixtureDir ||
    receipt.database.path !== `${fixtureDir}/fixture.sqlite`
  )
    return bad("the receipt does not name this fixture directory's database");
  const authority = {
    attempt,
    fixture_dir: {
      path: fixtureDir,
      dev: String(receipt.fixture_dir.dev),
      ino: String(receipt.fixture_dir.ino),
    },
    database: {
      path: receipt.database.path,
      dev: String(receipt.database.dev),
      ino: String(receipt.database.ino),
    },
    receipt_sha256: receiptSha256,
  };
  const shape = guardAuthorityProblems({
    ...authority,
    private_dir: "/not-nested-shape-check",
  });
  if (shape.length > 0) return bad(shape.join("; "));
  const kindOf = (path) => {
    try {
      const s = deps.lstat(path);
      return {
        directory: s.isDirectory(),
        file: s.isFile(),
        id: identityOf(s),
      };
    } catch (error) {
      return { error: codeOf(error) };
    }
  };
  const dir = kindOf(fixtureDir);
  if (!dir.directory || !sameIdentity(dir.id, authority.fixture_dir))
    return bad("the fixture directory is not the receipt's: nothing anchored");
  const db = kindOf(authority.database.path);
  if (!db.file || !sameIdentity(db.id, authority.database))
    return bad("the fixture database is not the receipt's: not anchored");
  return { owned: true, authority, problems };
}
/**
 * Holds the attempt's database with the reader guard. `deps.spawn(command, args, options)` → child (the runner's owned-group spawn);
 * `deps.lstat`/`deps.realpath` (default: the real ones) for the owned-source check.
 * Resolves with a handle: `held` (true only on the guard's `held` report), `record` (JSON: method, pid, the authority it was bound to, its
 * private directory and the identity it opened, journal mode, the database and WAL identities it holds, or why not), `problems`, `alive()`
 * (when held: the guard has not ended), and `release({ exitObserved })` → { released, lost, exit_observed_before_release, exit,
 * problems }. `lost` is true when the guard ended BEFORE its release was asked (its hold, and so the single-generation proof, ended
 * early). A guard that never reported `held` is told EOF (it then closes and exits) and proves nothing.
 *
 * Revision 36 (R36-RET): the authority comes first. `ownedSource` (the receipt's identities, its digest, the attempt, no ownership-loss
 * `latch`) must pass BEFORE the child is spawned; otherwise nothing is started and nothing of the fixture is touched. The child gets that
 * authority and `privateParent` (the runner's own retained parent, which must not nest with the fixture's parent); it creates
 * `<privateParent>/guard-<attempt>` and opens only its private link of the receipt's inode (diagnostic-guard.mjs). `onPause(at)`
 * (qualification only) is awaited at each of the child's `pause` points before it is told to continue.
 */
export async function acquireGuard(
  deps,
  {
    attempt,
    fixtureDir,
    receipt,
    receiptSha256,
    latch = null,
    privateParent,
    pause = [],
    onPause = null,
    timeoutMs = 10_000,
    releaseTimeoutMs = 10_000,
  },
) {
  const record = {
    method: GUARD_METHOD,
    attempt: attempt ?? null,
    receipt_sha256: receiptSha256 ?? null,
    authority: null,
    pid: null,
    spawned: false,
    held: false,
    namespace: null,
    private_dir: null,
    opened: null,
    journal_mode: null,
    database: null,
    wal: null,
    stage: null,
    refused: null,
  };
  const problems = [];
  const lines = [];
  let wake = null;
  let exited = null;
  let releaseAsked = false;
  let lostAt = null;
  let child = null;
  const handle = {
    held: false,
    record,
    problems,
    release: async () => ({
      released: false,
      lost: false,
      exit_observed_before_release: false,
      exit: null,
      problems: ["the guard was never held"],
    }),
  };
  const refuseBefore = (reason) => {
    record.stage = "before-spawn";
    record.refused = reason;
    problems.push(`the guard was not started: ${reason}`);
    return handle;
  };
  const owned = ownedSource(
    { lstat: deps.lstat ?? ((path) => lstatSync(path, { bigint: true })) },
    { attempt, fixtureDir, receipt, receiptSha256, latch },
  );
  if (!owned.owned) return refuseBefore(owned.problems.join("; "));
  record.authority = owned.authority;
  let parent;
  try {
    parent = (deps.realpath ?? realpathSync)(privateParent);
  } catch (error) {
    return refuseBefore(
      `the guard's private parent ${privateParent}: ${codeOf(error)}`,
    );
  }
  const fixtureParent = fixtureDir.slice(0, fixtureDir.lastIndexOf("/"));
  if (within(parent, fixtureParent) || within(fixtureParent, parent))
    return refuseBefore(
      `the guard's private parent ${parent} and the fixture's parent ${fixtureParent} nest`,
    );
  const authority = {
    ...owned.authority,
    private_dir: `${parent}/guard-${attempt}`,
  };
  const shape = guardAuthorityProblems(authority);
  if (shape.length > 0) return refuseBefore(shape.join("; "));
  try {
    child = deps.spawn(
      process.execPath,
      [
        "--no-warnings",
        GUARD_SCRIPT,
        "--authority",
        JSON.stringify(authority),
        ...(pause.length > 0 ? ["--pause", pause.join(",")] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (error) {
    problems.push(`the guard could not start: ${codeOf(error)}`);
    return handle;
  }
  record.spawned = true;
  record.pid = child.pid ?? null;
  child.stdin?.on("error", () => undefined);
  child.stderr?.resume();
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    text += chunk;
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n")) {
      const line = text.slice(0, at);
      text = text.slice(at + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push({ event: "malformed", line });
      }
    }
    wake?.();
  });
  const exit = new Promise((resolve) => {
    const done = (code, signal) => {
      if (exited) return;
      exited = { code, signal };
      if (!releaseAsked) lostAt = exited;
      wake?.();
      resolve(exited);
    };
    child.once("exit", done);
    child.once("error", () => done(null, null));
  });
  const next = (ms) =>
    new Promise((resolve) => {
      let timer = null;
      const check = () => {
        if (lines.length > 0 || exited) {
          wake = null;
          clearTimeout(timer);
          resolve(lines.shift() ?? null);
        }
      };
      wake = check;
      timer = setTimeout(() => {
        wake = null;
        resolve(undefined);
      }, ms);
      check();
    });
  const bounded = (promise, ms) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  let first = await next(timeoutMs);
  while (first?.event === "paused") {
    // Qualification only: a deterministic boundary inside the child; the stimulus runs, then the child continues.
    try {
      await onPause?.(first.at);
    } finally {
      child.stdin?.write("continue\n");
    }
    first = await next(timeoutMs);
  }
  if (first?.event !== "held") {
    record.refused = first?.reason ?? first?.error ?? null;
    record.stage = first?.stage ?? null;
    if (first?.event === "refused") {
      record.journal_mode = first.journal_mode ?? null;
      record.database = first.database ?? null;
      record.wal = first.wal ?? null;
    }
    problems.push(
      first === undefined
        ? `the guard did not answer within ${timeoutMs} ms`
        : first === null
          ? `the guard ended without an answer (${JSON.stringify(exited)})`
          : `the guard was not held (${first.event}: ${record.refused})`,
    );
    child.stdin?.end();
    return handle;
  }
  // The held report must be the authority's own: the method, attempt, digest, its private namespace and the receipt's inode opened.
  const unbound = [];
  if (first.method !== GUARD_METHOD) unbound.push(`method ${first.method}`);
  if (first.attempt !== authority.attempt) unbound.push("another attempt");
  if (first.receipt_sha256 !== authority.receipt_sha256)
    unbound.push("another receipt digest");
  if (
    first.namespace !== "private" ||
    first.private_dir?.path !== authority.private_dir
  )
    unbound.push("not its private namespace");
  if (
    first.opened?.name !== GUARD_NAME ||
    !sameIdentity(first.opened, authority.database)
  )
    unbound.push("it opened another file than the receipt's database");
  if (!sameIdentity(first.database, authority.database))
    unbound.push("the database it observed is not the receipt's");
  if (unbound.length > 0) {
    record.refused = `the guard's report is not bound to its authority: ${unbound.join("; ")}`;
    problems.push(record.refused);
    child.stdin?.end();
    return handle;
  }
  record.held = true;
  record.namespace = first.namespace;
  record.private_dir = first.private_dir;
  record.opened = first.opened;
  record.journal_mode = first.journal_mode;
  record.database = first.database;
  record.wal = first.wal;
  handle.held = true;
  handle.alive = () => exited === null;
  handle.release = async ({ exitObserved = false } = {}) => {
    const result = {
      released: false,
      lost: lostAt !== null || exited !== null,
      exit_observed_before_release: exitObserved === true,
      exit: null,
      problems: [],
    };
    if (result.lost) {
      result.exit = exited;
      result.problems.push(
        `the guard ended before its release (${JSON.stringify(exited)}): the single-generation hold is not proven`,
      );
      return result;
    }
    releaseAsked = true;
    child.stdin.write("release\n");
    child.stdin.end();
    const ack = await next(releaseTimeoutMs);
    result.released = ack?.event === "released";
    if (!result.released)
      result.problems.push(
        `the guard did not report its release (${JSON.stringify(ack ?? null)})`,
      );
    result.exit = await bounded(exit, releaseTimeoutMs);
    if (result.exit?.code !== 0)
      result.problems.push(
        `the guard exited ${JSON.stringify(result.exit)} after its release`,
      );
    if (!result.exit_observed_before_release)
      result.problems.push(
        "the guard was released before the executable's exit was observed",
      );
    return result;
  };
  return handle;
}

// ---- revision 34 (R34-RET): the owned fixture is anchored before its removal can be asked, and materialised after the exit ----------
// Revision 35 (R35-RET): /2 — the retention names the ONE source set it materialised and how it was selected (`selection`), with the reader
// guard's proof when that set is the anchors of a removed source. A /1 retention is refused, never upgraded.
// Revision 36 (R36-RET): /3 — the guard proof carries its authority and private binding; `retired-into-database` is a selection.
export const RETAINED_SCHEMA = "web09c-diagnostic-retained/3";
/** SQLite's own state, materialised together for inspection (the shared-memory index is rebuilt by SQLite and is never needed). */
export const MATERIALISED_FILES = Object.freeze([
  "fixture.sqlite",
  "fixture.sqlite-wal",
  "fixture.sqlite-journal",
]);
/** The file-system operations of the retention (injected by the tests to produce the refusals). */
export function retentionDeps() {
  return {
    realpath: realpathSync,
    lstat: (path) => lstatSync(path, { bigint: true }),
    link: linkSync,
    mkdir: (path) => mkdirSync(path, { mode: 0o700 }),
    readFile: readFileSync,
    writeExclusive: (path, data) =>
      writeFileSync(path, data, { flag: "wx", mode: 0o600 }),
    copyExclusive: (from, to) =>
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL),
    openDatabase: async (path, options) => {
      const { DatabaseSync } = await import("node:sqlite");
      return options === undefined
        ? new DatabaseSync(path)
        : new DatabaseSync(path, options);
    },
  };
}
const identityOf = (s) => ({ dev: String(s.dev), ino: String(s.ino) });
const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const codeOf = (error) => String(error?.code ?? error?.message ?? error);
const within = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/**
 * Anchors the attempt's owned files BEFORE the sequenced shutdown (the executable's `remove` unlinks names; an anchored inode keeps the
 * bytes, and every later write of the still-running executable — WAL frames, the checkpoint at its pool close — lands in that same inode).
 * `retainedParent` is the attempt's own private directory: outside the fixture's parent (so a clean `removeParentIfEmpty` still works) and
 * outside every recursively removed tree. Creates `<retainedParent>/retained-<attempt>` (it must not exist) and hard-links each owned name
 * that is a regular file into it. Ownership is bound first and again after: the directory and database identities are the receipt's and
 * receipt.json hashes to the ready event's hash; a replaced, linked or unknown file is never anchored as the fixture. `ready` only when the
 * database and receipt are anchored and nothing was refused; otherwise the caller must not ask for removal (the source then stays). Never
 * removes anything (a partial anchor stays, labelled by its problems).
 *
 * Revision 35 (R35-RET): hard links keep inodes, not one SQLite state. A WAL anchored here and later RETIRED (the last connection closed
 * after a full checkpoint; the next one made a new WAL whose commits were checkpointed into the same database inode) would be replayed
 * over newer pages: an intact but stale database. So the anchor is bound to the reader `guard` (acquireGuard), held BEFORE this call:
 * while it is held SQLite cannot retire the WAL, and `ready` additionally needs the guard held on the receipt's database and the anchored
 * WAL to be exactly the generation the guard holds (no rollback journal beside it). `anchored` is the ownership/anchor verdict alone
 * (problems); `guard_problems` say why removal would not be covered. A refused guard keeps the source: materialiseRetained then reads its
 * final named state after the exit instead.
 */
export function preserveFixture(
  deps,
  {
    fixtureDir,
    receipt,
    receiptSha256,
    retainedParent,
    attempt,
    guard = null,
    latch = null,
  },
) {
  const out = {
    schema: RETAINED_SCHEMA,
    attempt,
    ready: false,
    anchored: false,
    dir: null,
    source: fixtureDir ?? null,
    anchors: [],
    absent: [],
    guard:
      guard === null || guard === undefined
        ? null
        : {
            method: guard.method ?? null,
            held: guard.held === true,
            attempt: guard.attempt ?? null,
            receipt_sha256: guard.receipt_sha256 ?? null,
            namespace: guard.namespace ?? null,
            private_dir: guard.private_dir ?? null,
            opened: guard.opened ?? null,
            journal_mode: guard.journal_mode ?? null,
            database: guard.database ?? null,
            wal: guard.wal ?? null,
          },
    guard_problems: [],
    problems: [],
  };
  const bad = (p) => {
    out.problems.push(p);
    return out;
  };
  // Revision 36 (R36-RET): the one owned-source check BEFORE any directory or link is made (a rejected source is never traversed).
  const source = ownedSource(deps, {
    attempt,
    fixtureDir,
    receipt,
    receiptSha256,
    latch,
  });
  if (!source.owned) {
    for (const p of source.problems) out.problems.push(p);
    return out;
  }
  let parent;
  try {
    parent = deps.realpath(retainedParent);
  } catch (error) {
    return bad(`the retained parent ${retainedParent}: ${codeOf(error)}`);
  }
  const fixtureParent = fixtureDir.slice(0, fixtureDir.lastIndexOf("/"));
  if (within(parent, fixtureParent) || within(fixtureParent, parent))
    return bad(
      `the retained parent ${parent} and the fixture's parent ${fixtureParent} nest`,
    );
  const dir = `${parent}/retained-${attempt}`;
  if (!FIXTURE_PATH_PATTERN.test(dir))
    return bad(`the retained path ${dir} is not a safe absolute path`);
  try {
    deps.mkdir(dir);
  } catch (error) {
    return bad(`creating ${dir} (it must not exist): ${codeOf(error)}`);
  }
  out.dir = dir;
  const owned = () => {
    try {
      const s = deps.lstat(fixtureDir);
      return (
        s.isDirectory() && sameIdentity(identityOf(s), receipt.fixture_dir)
      );
    } catch {
      return false;
    }
  };
  if (!owned())
    return bad("the fixture directory is not the receipt's: nothing anchored");
  for (const name of OWNED_FILES) {
    const from = `${fixtureDir}/${name}`;
    let source;
    try {
      source = deps.lstat(from);
    } catch (error) {
      if (error?.code === "ENOENT") {
        out.absent.push(name);
        continue;
      }
      bad(`${name}: ${codeOf(error)}`);
      continue;
    }
    if (!source.isFile()) {
      bad(`${name} is not a regular file: not anchored`);
      continue;
    }
    const id = identityOf(source);
    if (name === "fixture.sqlite" && !sameIdentity(id, receipt.database)) {
      bad("the fixture database is not the receipt's: not anchored");
      continue;
    }
    if (name === "receipt.json") {
      let bytes = null;
      try {
        bytes = deps.readFile(from);
      } catch (error) {
        bad(`receipt.json cannot be read: ${codeOf(error)}`);
        continue;
      }
      if (sha256(bytes) !== receiptSha256) {
        bad("receipt.json is not the ready receipt: not anchored");
        continue;
      }
    }
    const to = `${dir}/${name}`;
    try {
      deps.link(from, to);
    } catch (error) {
      // A companion SQLite removed between the look and the link (its last connection closed) is absent, not a failure.
      if (
        error?.code === "ENOENT" &&
        !["fixture.sqlite", "receipt.json"].includes(name)
      ) {
        out.absent.push(name);
        continue;
      }
      bad(`anchoring ${name}: ${codeOf(error)}`);
      continue;
    }
    let anchored = null;
    try {
      anchored = identityOf(deps.lstat(to));
    } catch (error) {
      bad(`the anchor of ${name} cannot be read: ${codeOf(error)}`);
      continue;
    }
    if (!sameIdentity(anchored, id)) {
      bad(`the anchor of ${name} is not the owned file`);
      continue;
    }
    out.anchors.push({ name, ...id, size: String(source.size) });
  }
  if (!owned()) bad("the fixture directory changed while it was anchored");
  for (const name of ["fixture.sqlite", "receipt.json"])
    if (!out.anchors.some((a) => a.name === name))
      bad(`${name} is not anchored`);
  out.anchored = out.problems.length === 0;
  const unguarded = (p) => out.guard_problems.push(p);
  const wal = out.anchors.find((a) => a.name === "fixture.sqlite-wal");
  if (out.guard?.held !== true)
    unguarded(
      "no SQLite reader guard is held: the WAL generation cannot be bound, so removal is not asked",
    );
  else {
    if (out.guard.method !== GUARD_METHOD)
      unguarded(`the guard method ${out.guard.method} is not ${GUARD_METHOD}`);
    // Revision 36: bound to THIS attempt's authority, opened through its private namespace as the receipt's inode.
    if (
      out.guard.attempt !== attempt ||
      out.guard.receipt_sha256 !== receiptSha256
    )
      unguarded("the guard was bound to another attempt or receipt");
    if (
      out.guard.namespace !== "private" ||
      !sameIdentity(out.guard.opened, receipt.database)
    )
      unguarded(
        "the guard did not open the receipt's database through its private name",
      );
    if (out.guard.journal_mode !== "wal")
      unguarded(`the guarded database is in ${out.guard.journal_mode} mode`);
    if (!sameIdentity(out.guard.database, receipt.database))
      unguarded("the guard holds another database than the receipt's");
    if (!wal) unguarded("the guarded WAL is not anchored");
    else if (!sameIdentity(wal, out.guard.wal))
      unguarded("the anchored WAL is not the generation the guard holds");
    if (out.anchors.some((a) => a.name === "fixture.sqlite-journal"))
      unguarded("a rollback journal is anchored beside the guarded WAL");
  }
  out.ready = out.anchored && out.guard_problems.length === 0;
  return out;
}

const quoteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;
const integrityOf = (db) =>
  db
    .prepare("PRAGMA integrity_check")
    .all()
    .map((r) => r.integrity_check);
const tablesOf = (db) =>
  Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        Number(
          db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(name)}`).get()
            .n,
        ),
      ]),
  );

/**
 * Revision 36: the logical content of the database at `path` (an exclusive copy the caller owns; opened writable so SQLite replays a WAL
 * beside it): every schema row and every table's rows, values exact (64-bit integers, blobs as hex), order-independent. Its SHA-256.
 */
async function contentDigestOf(deps, path) {
  const db = await deps.openDatabase(path);
  try {
    const exact = (row) =>
      JSON.stringify(Object.values(row), (_, v) =>
        typeof v === "bigint"
          ? `i:${v}`
          : v instanceof Uint8Array
            ? `b:${Buffer.from(v).toString("hex")}`
            : v,
      );
    const read = (sql) => {
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      return statement.all();
    };
    const schema = read(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
    ).map(exact);
    const tables = read(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).map(({ name }) => [
      name,
      read(`SELECT * FROM ${quoteIdentifier(name)}`)
        .map(exact)
        .sort(),
    ]);
    return sha256(JSON.stringify({ schema, tables }));
  } finally {
    db.close();
  }
}

/**
 * After the shutdown: ONE coherent SQLite state made inspectable (revision 35, R35-RET; design assessment invariants 1-5). Nothing is
 * judged until the executable's EXIT was observed (no writer of it is left). The anchors are re-identified and hashed; they are the raw
 * evidence and are never opened. Then exactly ONE authoritative source set is selected (never a retired WAL with a later database):
 *   - `final-named-after-exit`: the source was KEPT (its directory and database are still the receipt's). After the exit its names ARE the
 *     stopped SQLite state: the database (the anchored inode) with whatever WAL/journal is named now, each first linked into `final/`.
 *   - `guarded-anchors`: the executable REMOVED the source. Its anchors are that state only with the reader guard's whole proof: held on the
 *     receipt's database before the anchor, the anchored WAL being the generation it held, no rollback journal, never lost, released only
 *     after the exit, and the executable's own removal finding that WAL (so SQLite never retired it). Without every part the status is
 *     `failed`: the anchors stay, labelled, and are never presented as the stopped state.
 *   - `retired-into-database` (revision 36): the executable REMOVED the source and its own removal found no WAL and no journal: the last
 *     connection checkpointed the whole WAL into the database and deleted it, so the anchored database alone is the stopped state, with or
 *     without the guard. Corroborated: the anchored WAL replayed over a copy changes no content; otherwise `failed`.
 *   - a replaced directory or database name is `failed`: a replacement is never inspected as the fixture.
 * The selected files are copied to `work/`, checked by SQLite's integrity check, materialised by VACUUM INTO as one self-contained
 * `inspect.sqlite`, checked again read-only, and sealed by an exclusively written, read-back manifest (attempt, receipt, identities, the
 * selection with each file's origin and final hash, the guard's proof, quiescence, inspection). `status`: `verified`; `anchored_unverified`
 * (exit not observed, or the anchor itself refused: kept, never judged); `unavailable` (nothing anchored); `failed`. Nothing is removed.
 */
export async function materialiseRetained(
  deps,
  preservation,
  {
    exit = null,
    stopped = null,
    receipt = null,
    receiptSha256 = null,
    guard = null,
  } = {},
) {
  const out = {
    schema: RETAINED_SCHEMA,
    attempt: preservation?.attempt ?? null,
    status: "unavailable",
    dir: preservation?.dir ?? null,
    source: preservation?.source ?? null,
    anchors: [],
    quiescence: {
      exit,
      stopped_seq: stopped?.seq ?? null,
      removed: stopped?.removed ?? null,
    },
    guard: { acquired: preservation?.guard ?? null, release: guard ?? null },
    selection: null,
    inspect: null,
    manifest: null,
    problems: [],
  };
  const fail = (p) => {
    out.status = "failed";
    out.problems.push(p);
    return out;
  };
  if (!preservation?.dir || (preservation.anchors ?? []).length === 0) {
    out.problems.push("nothing was anchored: no retained representation");
    return out;
  }
  out.status = "anchored_unverified";
  if (
    preservation.anchored !== true ||
    !preservation.anchors.some((a) => a.name === "fixture.sqlite")
  ) {
    // A refused anchor (the source was then kept) is never materialised: what is anchored may be partial or not the fixture's own.
    out.problems.push(
      `the anchor was refused, so it is kept and never materialised: ${(preservation.problems ?? []).join("; ") || "the database is not anchored"}`,
    );
    return out;
  }
  if (exit === null || exit === undefined) {
    out.problems.push(
      "the executable's exit was not observed: the anchored files may still change; they are kept, not verified",
    );
    return out;
  }
  const { dir, source } = preservation;
  for (const anchor of preservation.anchors) {
    const path = `${dir}/${anchor.name}`;
    try {
      const s = deps.lstat(path);
      if (!s.isFile() || !sameIdentity(identityOf(s), anchor))
        return fail(`the anchor of ${anchor.name} was replaced`);
      out.anchors.push({
        ...anchor,
        size: String(s.size),
        sha256: sha256(deps.readFile(path)),
      });
    } catch (error) {
      return fail(`the anchor of ${anchor.name}: ${codeOf(error)}`);
    }
  }
  const anchorOf = (name) => out.anchors.find((a) => a.name === name) ?? null;
  // The source's state after the exit: `owned` (the receipt's identity), `absent`, or `replaced` (anything else).
  const stateOf = (path, want, directory) => {
    try {
      const s = deps.lstat(path);
      return (directory ? s.isDirectory() : s.isFile()) &&
        sameIdentity(identityOf(s), want)
        ? "owned"
        : "replaced";
    } catch (error) {
      return error?.code === "ENOENT"
        ? "absent"
        : `unreadable (${codeOf(error)})`;
    }
  };
  const dirState = stateOf(source, receipt?.fixture_dir, true);
  const dbState =
    dirState === "owned"
      ? stateOf(`${source}/fixture.sqlite`, receipt?.database, false)
      : "absent";
  if (![dirState, dbState].every((s) => s === "owned" || s === "absent"))
    return fail(
      `the source's final state is not the fixture's own (directory ${dirState}, database ${dbState}): it is never inspected as the fixture`,
    );
  const walAnchor = anchorOf("fixture.sqlite-wal");
  const files = [];
  let method;
  let walGeneration;
  if (dbState === "owned") {
    // Kept: after the exit the NAMES are the stopped state. The database name is the anchored inode; each named companion is linked now.
    method = "final-named-after-exit";
    files.push({ ...anchorOf("fixture.sqlite"), origin: "anchor" });
    let finalWal = null;
    try {
      deps.mkdir(`${dir}/final`);
      for (const name of MATERIALISED_FILES.filter(
        (n) => n !== "fixture.sqlite",
      )) {
        const from = `${source}/${name}`;
        let s;
        try {
          s = deps.lstat(from);
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        if (!s.isFile())
          return fail(`the kept ${name} is not a regular file: not inspected`);
        const to = `${dir}/final/${name}`;
        deps.link(from, to);
        const linked = deps.lstat(to);
        if (!sameIdentity(identityOf(linked), identityOf(s)))
          return fail(`the final ${name} changed while it was linked`);
        const file = {
          name,
          ...identityOf(linked),
          size: String(linked.size),
          sha256: sha256(deps.readFile(to)),
          origin: "final",
        };
        if (name === "fixture.sqlite-wal") finalWal = file;
        files.push(file);
      }
    } catch (error) {
      return fail(`linking the kept source's final state: ${codeOf(error)}`);
    }
    walGeneration =
      finalWal === null
        ? "absent"
        : walAnchor !== null && sameIdentity(finalWal, walAnchor)
          ? "anchored"
          : "replaced";
  } else if (
    Array.isArray(stopped?.removed) &&
    stopped.removed.includes("fixture.sqlite") &&
    !stopped.removed.includes("fixture.sqlite-wal") &&
    !stopped.removed.includes("fixture.sqlite-journal")
  ) {
    // Revision 36 (R36-RET, design assessment C3/T5): removed, and the executable's own removal found NO WAL and no journal. SQLite
    // deletes a WAL only after its last connection checkpointed ALL of it into the database (https://sqlite.org/wal.html), and after the
    // pool's close nothing reopens it (atlas-sync-diagnostic.rs: pool close, owner check, remove, exit), so the anchored database inode
    // ALONE is the stopped state, whatever became of the guard. Corroborated below: replaying the anchored WAL (if any) over a copy of the
    // database changes nothing — a retired generation older than later checkpointed pages (revision 35's stale replay) would.
    method = "retired-into-database";
    walGeneration = "retired";
    if (anchorOf("fixture.sqlite-journal") !== null)
      return fail("a rollback journal was anchored beside a retired WAL");
    files.push({ ...anchorOf("fixture.sqlite"), origin: "anchor" });
  } else {
    // Removed by the executable: only the guard's whole proof makes the anchors that state.
    method = "guarded-anchors";
    walGeneration = "guarded";
    const held = preservation.guard;
    const unproven = [];
    if (held?.held !== true)
      unproven.push("no reader guard was held before the anchor");
    else {
      if (held.method !== GUARD_METHOD)
        unproven.push(`the guard method ${held.method}`);
      if (!sameIdentity(held.database, receipt?.database))
        unproven.push("the guard held another database");
      // Revision 36: the guard's authority and the identity it opened (through its private name) are this attempt's receipt's.
      if (
        held.attempt !== preservation.attempt ||
        held.receipt_sha256 !== receiptSha256
      )
        unproven.push("the guard was bound to another attempt or receipt");
      if (
        held.namespace !== "private" ||
        !sameIdentity(held.opened, receipt?.database)
      )
        unproven.push(
          "the guard did not open the receipt's database through its private name",
        );
      if (walAnchor === null) unproven.push("no WAL was anchored");
      else if (!sameIdentity(walAnchor, held.wal))
        unproven.push("the anchored WAL is not the guarded generation");
    }
    if (anchorOf("fixture.sqlite-journal") !== null)
      unproven.push("a rollback journal was anchored");
    if (guard?.lost !== false)
      unproven.push(
        "the guard was lost (or never reported) before its release",
      );
    if (guard?.released !== true) unproven.push("the guard was not released");
    if (guard?.exit_observed_before_release !== true)
      unproven.push("the guard was not released after the exit");
    if (
      !(
        Array.isArray(stopped?.removed) &&
        stopped.removed.includes("fixture.sqlite-wal")
      )
    )
      unproven.push(
        "the executable's removal did not find the guarded WAL (it may have been retired)",
      );
    if (unproven.length > 0)
      return fail(
        `the anchors of a removed source are not one proven SQLite state: ${unproven.join("; ")}`,
      );
    for (const name of ["fixture.sqlite", "fixture.sqlite-wal"])
      files.push({ ...anchorOf(name), origin: "anchor" });
  }
  out.selection = { method, wal_generation: walGeneration, files };
  if (method === "retired-into-database") {
    // The corroboration: the logical content of the database alone and of the database with the anchored WAL replayed, each in its
    // own exclusive copy (the anchors are never opened). Unequal content refuses the selection; the anchors stay raw.
    const replay = `${dir}/replay`;
    const corroboration = { database: null, with_wal: null, equal: null };
    out.selection.corroboration = corroboration;
    try {
      deps.mkdir(replay);
      deps.mkdir(`${replay}/database`);
      deps.copyExclusive(
        `${dir}/fixture.sqlite`,
        `${replay}/database/fixture.sqlite`,
      );
      corroboration.database = await contentDigestOf(
        deps,
        `${replay}/database/fixture.sqlite`,
      );
      if (walAnchor !== null) {
        deps.mkdir(`${replay}/with-wal`);
        for (const name of ["fixture.sqlite", "fixture.sqlite-wal"])
          deps.copyExclusive(`${dir}/${name}`, `${replay}/with-wal/${name}`);
        corroboration.with_wal = await contentDigestOf(
          deps,
          `${replay}/with-wal/fixture.sqlite`,
        );
      }
    } catch (error) {
      return fail(`corroborating the retired WAL: ${codeOf(error)}`);
    }
    corroboration.equal =
      walAnchor === null || corroboration.with_wal === corroboration.database;
    if (!corroboration.equal)
      return fail(
        "the anchored WAL changes the database it was retired into: the anchors are not one proven SQLite state",
      );
  }
  const work = `${dir}/work`;
  const inspect = `${dir}/inspect.sqlite`;
  const pathOf = (f) =>
    f.origin === "final" ? `${dir}/final/${f.name}` : `${dir}/${f.name}`;
  try {
    deps.mkdir(work);
    for (const f of files) deps.copyExclusive(pathOf(f), `${work}/${f.name}`);
  } catch (error) {
    return fail(`copying the selected state for inspection: ${codeOf(error)}`);
  }
  let db = null;
  try {
    db = await deps.openDatabase(`${work}/fixture.sqlite`);
    const integrity = integrityOf(db);
    if (integrity.join() !== "ok")
      return fail(
        `the selected database is not intact: ${integrity.join("; ")}`,
      );
    db.exec(`VACUUM INTO '${inspect}'`);
  } catch (error) {
    return fail(`materialising the selected database: ${codeOf(error)}`);
  } finally {
    try {
      db?.close();
    } catch {
      // the copy is ours; a close failure is not the evidence
    }
  }
  try {
    const view = await deps.openDatabase(inspect, { readOnly: true });
    try {
      const integrity = integrityOf(view);
      if (integrity.join() !== "ok")
        return fail(
          `the inspectable copy is not intact: ${integrity.join("; ")}`,
        );
      out.inspect = {
        file: "inspect.sqlite",
        sha256: sha256(deps.readFile(inspect)),
        integrity: "ok",
        tables: tablesOf(view),
      };
    } finally {
      view.close();
    }
  } catch (error) {
    return fail(`reading the inspectable copy: ${codeOf(error)}`);
  }
  const manifest = {
    schema: RETAINED_SCHEMA,
    kind: "atlas-diagnostic-retained-fixture",
    attempt: out.attempt,
    source: out.source,
    receipt_sha256: receiptSha256,
    fixture_dir: receipt?.fixture_dir
      ? { dev: receipt.fixture_dir.dev, ino: receipt.fixture_dir.ino }
      : null,
    database: receipt?.database
      ? { dev: receipt.database.dev, ino: receipt.database.ino }
      : null,
    anchors: out.anchors,
    selection: out.selection,
    guard: out.guard,
    quiescence: out.quiescence,
    inspect: out.inspect,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    deps.writeExclusive(`${dir}/manifest.json`, text);
    const back = deps.readFile(`${dir}/manifest.json`);
    if (String(back) !== text) return fail("the manifest did not read back");
    out.manifest = { file: "manifest.json", sha256: sha256(back) };
  } catch (error) {
    return fail(`writing the manifest: ${codeOf(error)}`);
  }
  out.status = "verified";
  return out;
}

/** Re-reads a `verified` retention from disk (manifest, inspectable copy, anchors and selected final files, by hash); its problems. */
export function verifyRetained(deps, retention) {
  if (retention?.status !== "verified")
    return [
      `the fixture is not retained verified (${retention?.status ?? "no retention"}): ${(retention?.problems ?? []).join("; ")}`,
    ];
  const problems = [];
  for (const [what, file, want] of [
    ["manifest", retention.manifest?.file, retention.manifest?.sha256],
    ["inspectable copy", retention.inspect?.file, retention.inspect?.sha256],
    ...retention.anchors.map((a) => [`anchor ${a.name}`, a.name, a.sha256]),
    ...(retention.selection?.files ?? [])
      .filter((f) => f.origin === "final")
      .map((f) => [`final ${f.name}`, `final/${f.name}`, f.sha256]),
  ])
    try {
      if (sha256(deps.readFile(`${retention.dir}/${file}`)) !== want)
        problems.push(`the retained ${what} changed`);
    } catch (error) {
      problems.push(`the retained ${what} cannot be re-read: ${codeOf(error)}`);
    }
  return problems;
}

/**
 * Revision 27 (DA-DIAG-F, design assessment C5): the end of one attempt, in an order that cannot remove the fixture of a failed attempt.
 *   1. `stopTransports()` — the browser is gone; the proxy, the tap and the bridge stop, so every stream is settled. Its problems are kept.
 *   2. `preliminary()` — the evidence is validated NOW, while the fixture still exists: the interval records, the causal proofs, the journal
 *      and the attempt's transcript so far (no shutdown yet), the transport answers (503, 429), the browser's verdict.
 *   3. removal is ELIGIBLE only when the transports stopped cleanly, the preliminary validation found nothing and the control is not latched
 *      (read again after the stop). `finish(eligible)` then asks the executable's own sequenced shutdown to remove the owned files (or to
 *      keep them: `finishAttempt` sends `remove:false`, or EOF when an answer is outstanding). Nothing here removes anything itself.
 *   4. `terminal(finished)` — the complete validation after the shutdown (its stopped event, served:true, the removal, the exit).
 * Every step runs even after an earlier failure (so the evidence of a failure is complete); a thrown step is a problem of that step.
 *
 * Revision 34 (R34-RET): the terminal judgement follows the executable's removal, so step 3's eligibility alone cannot authorise it.
 *   3a. `preserve()` — the owned files are anchored (`preserveFixture`) for EVERY attempt; removal is asked only when the attempt is
 *       eligible AND the anchor is ready. Without a `preserve` step, or when it throws or refuses, removal is never asked (the source stays).
 *   3b. `finish(remove)` as before, with that conjunction.
 *   3c. `materialise(preservation, finished)` — after the exit, the verified inspectable representation (`materialiseRetained`).
 *   4.  `terminal(finished, retention)` judges the retention too. A late failure therefore leaves the anchored fixture, not an empty parent.
 *
 * Revision 35 (R35-RET): an anchor is one SQLite state only while no WAL generation can be retired after it.
 *   3a'. `guard()` — BEFORE the anchor, the reader guard (`acquireGuard`) holds the database; its handle is given to `preserve(guard)`,
 *        which binds the anchored WAL to the generation it holds. Removal is asked only when the attempt is eligible AND preserved AND the
 *        guard is held with no problem. Without a `guard` step, or when it throws, refuses or is not held, removal is never asked.
 *   3b'. `release(guard, finished)` — after the shutdown and the exit; its result (released, lost, after the exit) is the guard's proof.
 *   3c'. `materialise(preservation, finished, released)`.
 *
 * Revision 36 (R36-RET): `guard(latch)` and `preserve(guard, latch)` receive the latch read at the decision; both refuse an ownership-loss
 * latch before touching the fixture (ownedSource), and neither runs SQLite on the fixture's path.
 */
export async function concludeAttempt({
  stopTransports,
  preliminary,
  latched,
  guard = null,
  preserve = null,
  finish,
  release = null,
  materialise = null,
  terminal,
}) {
  const run = async (step, ...args) => {
    try {
      return { value: await step(...args), problems: [] };
    } catch (error) {
      return {
        value: null,
        problems: [
          `${step.name || "step"}: ${String(error?.message ?? error)}`,
        ],
      };
    }
  };
  const stop = await run(stopTransports);
  const transport = [...(stop.value ?? []), ...stop.problems];
  const pre = await run(preliminary);
  const before = [...(pre.value ?? []), ...pre.problems];
  const latch = latched();
  const eligible =
    transport.length === 0 && before.length === 0 && latch === null;
  // Revision 36 (R36-RET): the guard and the anchor are given the latch, so a lost fixture is never opened or anchored.
  const holding = guard
    ? await run(guard, latch)
    : {
        value: null,
        problems: [
          "no SQLite reader guard step: the fixture's removal is never asked",
        ],
      };
  const guardProblems = [
    ...holding.problems,
    ...(holding.value?.problems ?? []),
  ];
  const guarded = holding.value?.held === true && guardProblems.length === 0;
  if (!guarded && guardProblems.length === 0)
    guardProblems.push("the SQLite reader guard is not held");
  const kept = preserve
    ? await run(preserve, holding.value, latch)
    : {
        value: null,
        problems: [
          "no preservation step: the fixture's removal is never asked",
        ],
      };
  const preservationProblems = [
    ...kept.problems,
    ...(kept.value?.problems ?? []),
    ...(kept.value?.guard_problems ?? []),
  ];
  const preserved =
    kept.value?.ready === true && preservationProblems.length === 0;
  if (!preserved && preservationProblems.length === 0)
    preservationProblems.push("the fixture's anchor is not ready");
  // The guard must still be holding when the removal is decided (a guard that ended after its report proves nothing from then on).
  const holdingNow = guarded && holding.value?.alive?.() !== false;
  if (guarded && !holdingNow)
    guardProblems.push(
      "the SQLite reader guard ended before the removal decision",
    );
  const remove = eligible && preserved && holdingNow;
  const done = await run(finish, remove);
  const freed =
    holding.value && release
      ? await run(release, holding.value, done.value)
      : {
          value: null,
          problems: holding.value ? ["no guard release step"] : [],
        };
  const retained = materialise
    ? await run(materialise, kept.value, done.value, freed.value)
    : { value: null, problems: [] };
  const end = await run(terminal, done.value, retained.value);
  return {
    transport,
    preliminary: before,
    latched_at_decision: latch,
    eligible,
    preservation: kept.value,
    preservation_problems: preservationProblems,
    preserved,
    guard: holding.value?.record ?? null,
    guard_problems: guardProblems,
    guarded: holdingNow,
    released: freed.value,
    release_problems: [...freed.problems, ...(freed.value?.problems ?? [])],
    remove_requested: remove,
    finished: done.value,
    finish_problems: done.problems,
    retention: retained.value,
    retention_problems: [
      ...retained.problems,
      ...(retained.value?.problems ?? []),
    ],
    terminal: [...(end.value ?? []), ...end.problems],
  };
}

/**
 * Revision 27 (R27-DIAG.a): the attempt's causal journal, persisted line by line to `file` (the runner's composition; the composed
 * qualification uses this same function with its DEFAULT clock).
 */
export function attemptJournal(attempt, file, options = {}) {
  return createJournal({
    attempt,
    append: (line) => appendFileSync(file, line),
    ...options,
  });
}
/**
 * Revision 27: the attempt's transports composed as the runner composes them — the spec's private bridge and the tap, BOTH recording into
 * the attempt's one journal (the control already does, through `launchAttempt`). Defaults are the maintained ones (the tap's
 * `performance.now()`, the bridge's `Date.now()`); nothing compares them.
 */
export function composeAttemptTransport({
  journal,
  control,
  socketPath,
  token,
  onCall,
  onMark,
  tap,
}) {
  const bridge = createControlServer({
    control,
    socketPath,
    token,
    journal,
    onCall,
    onMark,
  });
  const tapServer = createTap({ ...tap, journal });
  return { bridge, tap: tapServer };
}

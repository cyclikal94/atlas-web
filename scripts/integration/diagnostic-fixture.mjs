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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createJournal } from "./causal-journal.mjs";
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
 */
export async function concludeAttempt({
  stopTransports,
  preliminary,
  latched,
  finish,
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
  const done = await run(finish, eligible);
  const end = await run(terminal, done.value);
  return {
    transport,
    preliminary: before,
    latched_at_decision: latch,
    eligible,
    finished: done.value,
    finish_problems: done.problems,
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

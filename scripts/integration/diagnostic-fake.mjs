#!/usr/bin/env node
// WEB-09c revision 26 (R26-DIAG): a TEST STAND-IN for `atlas-sync-diagnostic`, used ONLY by diagnostic-fixture.test.mjs to qualify the
// client adapter's protocol, lifecycle and clean-up (design assessment Q2/Q3). It reproduces the executable's observable protocol
// (backend crates/server/src/bin/atlas-sync-diagnostic.rs at the approved HEAD): argv, the inherited-ATLAS_ refusal, the new fixture
// directory (0700) with an empty database file and a schema-2 receipt, `ready`, one answer per accepted command with `effect` and
// `sync_now`, `rejected` lines that consume nothing, setup-only commands, forward-only clock, `shutdown {remove}` answered by `stopped`
// and removal of only the owned files. It serves NO HTTP and has no database: it is never evidence about the backend, and backend
// branch coverage is never inferred from it. `--fake-mode` selects one injected deviation.
// Revision 34 (R34-RET): a `sqlite:` prefix on the mode makes the database REAL (node:sqlite, WAL mode, automatic checkpoints off, so the
// committed rows stay in the WAL until the close): each add_account commits a row, and every stop closes the database (its checkpoint and
// WAL deletion) BEFORE the owned removal, as the executable's pool close does; `sqlite:unclosed` removes without closing (the rows then
// exist only in the WAL). Still never evidence about the backend's own SQLite use.
// Revision 35 (R35-RET): `sqlite:rotate` closes, reopens, commits same-count late changes and closes again before the removal.
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const RETENTION = 90 * 86400;
const OWNED = [
  "fixture.sqlite",
  "fixture.sqlite-wal",
  "fixture.sqlite-shm",
  "fixture.sqlite-journal",
  "receipt.json",
];
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const argv = process.argv.slice(2);
let mode = "normal";
const flags = {};
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] === "--fake-mode") mode = argv[i + 1];
  else flags[argv[i]] = argv[i + 1];
}
const sqlite = mode.startsWith("sqlite:");
if (sqlite) mode = mode.slice("sqlite:".length);
let database = null;
let databasePath = null;
let DatabaseSync = null;
const closeDatabase = () => {
  if (database !== null && mode === "rotate") {
    // Revision 35 (R35-RET): the reviewer's WAL-replacement schedule inside the stand-in: the LAST connection closes (unguarded, SQLite
    // checkpoints and deletes the WAL), a new connection then commits an UPDATE, a DELETE and an INSERT (the same row count) through
    // whatever WAL it opens, and closes again. Under the client's reader guard both closes keep the one anchored WAL.
    database.close();
    database = new DatabaseSync(databasePath);
    database.exec(
      "PRAGMA wal_autocheckpoint=0; UPDATE accounts SET username = 'ada-late' WHERE username = 'ada'; DELETE FROM accounts WHERE username = 'grace'; INSERT INTO accounts (id, username) VALUES ('late', 'hopper-late')",
    );
  }
  if (database !== null && mode !== "unclosed") database.close();
  database = null;
};
const fail = (error) => {
  out({ event: "failed", error });
  process.exit(2);
};
const inherited = Object.keys(process.env).filter((k) =>
  k.startsWith("ATLAS_"),
);
if (inherited.length > 0)
  fail(`refusing inherited configuration ${JSON.stringify(inherited)}`);
const dir0 = flags["--fixture-dir"];
const attempt = flags["--attempt"];
const origin = flags["--public-origin"];
if (!dir0 || !attempt || !flags["--bind"] || !origin) fail("usage");
if (!isAbsolute(dir0)) fail("--fixture-dir must be absolute");
if (mode === "failed-start") fail("startup failed: injected");
if (mode === "no-ready") setInterval(() => undefined, 1000);
else {
  const dir = join(realpathSync(dirname(dir0)), basename(dir0));
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    fail(`creating ${dir} (it must not exist): ${e.code}`);
  }
  closeSync(openSync(join(dir, "fixture.sqlite"), "wx", 0o600));
  if (sqlite) {
    ({ DatabaseSync } = await import("node:sqlite"));
    databasePath = join(dir, "fixture.sqlite");
    database = new DatabaseSync(databasePath);
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL)",
    );
  }
  const id = (p) => {
    const s = statSync(p, { bigint: true });
    return { dev: s.dev, ino: s.ino };
  };
  const exe = process.argv[1];
  const start = Math.floor(Date.now() / 1000);
  const di = id(dir);
  const db = id(join(dir, "fixture.sqlite"));
  const receipt = {
    schema: 2,
    kind: "atlas-sync-diagnostic-receipt",
    attempt: mode === "wrong-attempt" ? `${attempt}x` : attempt,
    pid: process.pid,
    fixture_dir: { path: dir, dev: "@DEV0", ino: "@INO0" },
    database: { path: join(dir, "fixture.sqlite"), dev: "@DEV1", ino: "@INO1" },
    executable: {
      path: exe,
      sha256: createHash("sha256").update(readFileSync(exe)).digest("hex"),
    },
    features: { "sync-diagnostic": true, "test-hooks": mode === "test-hooks" },
    api_version: "0.30.0",
    address: "127.0.0.1:1",
    public_origin: new URL(origin).origin,
    sync_start: start,
    retention_seconds: RETENTION,
  };
  // u64 identities exactly as serde writes them (bare decimal numbers, possibly beyond 2^53), in the file and in the ready line alike.
  const fill = (t) =>
    t
      .replace('"@DEV0"', String(di.dev))
      .replace('"@INO0"', String(di.ino))
      .replace('"@DEV1"', String(db.dev))
      .replace('"@INO1"', String(db.ino));
  const receiptText = fill(JSON.stringify(receipt, null, 2));
  writeFileSync(join(dir, "receipt.json"), receiptText, {
    flag: "wx",
    mode: 0o600,
  });
  const receiptSha = createHash("sha256").update(receiptText).digest("hex");
  const ready = `{"event":"ready","receipt":${fill(JSON.stringify(receipt))},"receipt_sha256":"${receiptSha}"}`;
  if (mode === "split-output") {
    for (let i = 0; i < ready.length; i += 7)
      process.stdout.write(ready.slice(i, i + 7));
    process.stdout.write("\n");
  } else process.stdout.write(`${ready}\n`);
  if (mode === "refused-http")
    process.stderr.write(
      `${JSON.stringify({ event: "diagnostic_http", phase: "refused", method: "GET", path: "/x" })}\n`,
    );
  let now = start;
  let setup = true;
  let aged = false;
  let next = 1;
  let accounts = 0;
  let answered = 0;
  let pending = "";
  const answer = (cmd, fields) => {
    answered += 1;
    const line = {
      attempt: cmd.attempt,
      seq: cmd.seq,
      op: cmd.op,
      ...fields,
      sync_now: now,
    };
    if (mode === "coalesced" && answered === 1) {
      pending = `${JSON.stringify(line)}\n`;
      return;
    }
    process.stdout.write(`${pending}${JSON.stringify(line)}\n`);
    pending = "";
  };
  const stop = (seq, remove) => {
    let removed = null;
    let cleanup = null;
    closeDatabase();
    if (remove) {
      removed = [];
      try {
        for (const name of OWNED) {
          try {
            unlinkSync(join(dir, name));
            removed.push(name);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        rmdirSync(dir);
      } catch (e) {
        cleanup = `${dir} is not empty; left in place (${e.code})`;
        removed = null;
      }
    }
    out({
      event: "stopped",
      attempt,
      seq,
      served: mode !== "served-false",
      removed,
      cleanup_error: cleanup,
    });
    process.exit(cleanup ? 1 : 0);
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) {
        if (buffer.length > 8192) {
          out({
            event: "rejected",
            error: "command line over 8192 bytes or unterminated",
            stopping: true,
          });
          stop(null, false);
        }
        return;
      }
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (text.length + 1 > 8192) {
        out({
          event: "rejected",
          error: "command line over 8192 bytes or unterminated",
          stopping: true,
        });
        stop(null, false);
      }
      let cmd;
      try {
        cmd = JSON.parse(text);
        const extra = Object.keys(cmd).filter(
          (k) => !["attempt", "seq", "op", "args"].includes(k),
        );
        if (extra.length) throw new Error(`unknown field ${extra[0]}`);
      } catch (e) {
        out({ event: "rejected", error: `malformed command: ${e.message}` });
        continue;
      }
      if (
        cmd.attempt !== attempt ||
        cmd.seq !== next ||
        (mode === "reject-first" && next === 1)
      ) {
        out({
          event: "rejected",
          attempt: cmd.attempt,
          seq: cmd.seq,
          error: `expected attempt ${attempt} seq ${next}`,
        });
        if (mode === "reject-first") mode = "normal";
        continue;
      }
      next += 1;
      if (cmd.op === "shutdown") {
        if (typeof cmd.args?.remove !== "boolean") {
          answer(cmd, { ok: false, error: "malformed arguments" });
          continue;
        }
        stop(cmd.seq, cmd.args.remove);
      }
      if (mode === `no-ack-${cmd.op}`) continue;
      if (mode === `lose-${cmd.op}`) {
        answer(cmd, {
          ok: false,
          error: "ownership lost: fixture database replaced",
          effect: "none",
          ownership_lost: true,
        });
        out({
          event: "ownership_lost",
          error: "ownership lost: fixture database replaced",
          stopping: true,
        });
        out({
          event: "stopped",
          attempt,
          seq: null,
          served: true,
          removed: null,
          cleanup_error: "ownership lost",
        });
        process.exit(0);
      }
      if (mode === `unknown-${cmd.op}`) {
        answer(cmd, {
          ok: false,
          error: "the write failed",
          effect: "unknown",
        });
        continue;
      }
      if (mode === `stop-after-${cmd.op}`) {
        answer(cmd, {
          ok: true,
          result: {},
          effect: cmd.op === "inspect" ? "none" : "applied",
        });
        out({
          event: "stopped",
          attempt,
          seq: null,
          served: true,
          removed: null,
          cleanup_error: null,
        });
        process.exit(0);
      }
      const args = cmd.args ?? {};
      switch (cmd.op) {
        case "inspect":
          answer(cmd, {
            ok: true,
            result: {
              sync_now: now,
              accounts: [],
              batches: [],
              truncated: false,
            },
            effect: mode === "inspect-applied" ? "applied" : "none",
          });
          break;
        case "add_account":
          if (!setup)
            answer(cmd, {
              ok: false,
              error: "add_account is a setup command",
              effect: "none",
            });
          else {
            const account = `00000000-0000-4000-8000-${String(++accounts).padStart(12, "0")}`;
            database
              ?.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)")
              .run(account, String(args.username));
            answer(cmd, {
              ok: true,
              result: { account },
              effect: "applied",
            });
          }
          break;
        case "age_history":
          if (!setup || aged)
            answer(cmd, {
              ok: false,
              error: "age_history is a single setup command",
              effect: "none",
            });
          else {
            aged = true;
            answer(cmd, {
              ok: true,
              result: { aged: args.batches ?? [] },
              effect: "applied",
            });
          }
          break;
        case "advance_clock":
          if (!(args.time > now && args.time <= start + 2 * RETENTION))
            answer(cmd, {
              ok: false,
              error: "the sync time only advances",
              effect: "none",
            });
          else {
            const from = now;
            now = args.time;
            setup = false;
            answer(cmd, {
              ok: true,
              result: { from, to: now },
              effect: "applied",
            });
          }
          break;
        case "collect":
          setup = false;
          if (mode === "partial-collect")
            answer(cmd, {
              ok: false,
              error: "the collector failed",
              effect: "partial",
              partial: {
                time: args.time,
                before: {},
                after: null,
                after_error: "x",
              },
            });
          else
            answer(cmd, {
              ok: true,
              result: {
                time: args.time,
                before: {},
                after: {},
                removed_batches: [],
              },
              effect: "applied",
            });
          break;
        default:
          answer(cmd, {
            ok: false,
            error: `unsupported command ${cmd.op}`,
            effect: "none",
          });
      }
    }
  });
  process.stdin.on("end", () => {
    closeDatabase();
    out({
      event: "stopped",
      attempt,
      seq: null,
      served: true,
      removed: null,
      cleanup_error: null,
    });
    process.exit(0);
  });
}

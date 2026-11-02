#!/usr/bin/env node
// WEB-09c revision 35 (R35-RET, family `diagnostic-fixture-retention-composition`): the SQLite READER GUARD of one diagnostic attempt.
//
// Why it exists. An anchored WAL inode is only meaningful together with the database it belongs to. SQLite deletes a WAL (and the next
// connection creates a NEW one, a different inode) only when the LAST connection to the database closes and can take the database file's
// exclusive lock (https://sqlite.org/wal.html, "the last connection ... does one last checkpoint and then deletes the WAL"). A connection
// in WAL mode holds a SHARED lock on the database file for as long as it is open, so while this separate process keeps one read-only
// connection open the executable's pool can close, reopen, write, checkpoint and close again, but it can never retire the WAL: every
// later frame lands in the WAL inode that was named when the guard was held, and that one generation is what the client anchors. A
// read-only connection never checkpoints or deletes anything when it closes, so releasing the guard changes no byte of the fixture.
//
// It is a separate PROCESS because POSIX record locks belong to a process and are dropped when that process closes ANY descriptor of the
// file: the runner hashes and copies the anchored (hard-linked, same inode) files, which would silently release a guard held in its own
// process.
//
// Protocol (stdout JSON lines, one per state; stdin): started with `--database ABSOLUTE_PATH`, it opens the database read-only, reads its
// journal mode and its schema (entering WAL mode holds the shared lock), then reports the identities it holds:
//   {"event":"held","journal_mode":"wal","database":{dev,ino},"wal":{dev,ino},"journal":false}
// or refuses (`{"event":"refused","reason"}`: not WAL mode, no WAL file, a rollback journal present) or fails (`{"event":"failed"}`), and
// then exits. While held it waits for the line `release` on stdin, closes the connection, reports `{"event":"released"}` and exits 0.
// Stdin EOF without `release` (its parent is gone) closes the connection and exits 4 without `released`. It never writes the database.
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const identity = (path) => {
  try {
    const s = lstatSync(path, { bigint: true });
    if (!s.isFile()) return { dev: null, ino: null, kind: "not-a-file" };
    return { dev: String(s.dev), ino: String(s.ino) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

async function main() {
  const at = process.argv.indexOf("--database");
  const database = at > 0 ? process.argv[at + 1] : null;
  if (!database || !isAbsolute(database)) {
    out({ event: "failed", error: "usage: --database ABSOLUTE_PATH" });
    process.exit(2);
  }
  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(database, { readOnly: true });
    const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode);
    // A real read: in WAL mode the connection now holds the database file's shared lock until it is closed.
    db.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
    const held = {
      journal_mode: mode,
      database: identity(database),
      wal: identity(`${database}-wal`),
      journal: identity(`${database}-journal`) !== null,
    };
    const reason =
      mode !== "wal"
        ? `the database is in ${mode} journal mode, not WAL: no generation guard applies`
        : held.wal === null
          ? "no WAL file is present while the guard is held"
          : held.wal.ino === null || held.database?.ino === null
            ? "the database or its WAL is not a regular file"
            : held.journal
              ? "a rollback journal is present beside the WAL"
              : null;
    if (reason !== null) {
      db.close();
      out({ event: "refused", reason, ...held });
      process.exit(3);
    }
    out({ event: "held", ...held });
  } catch (error) {
    try {
      db?.close();
    } catch {
      // the connection is ours; the report is the failure below
    }
    out({
      event: "failed",
      error: String(error?.code ?? error?.message ?? error),
    });
    process.exit(2);
  }
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.split("\n").includes("release")) return;
    db.close();
    out({ event: "released" });
    process.exit(0);
  });
  process.stdin.on("end", () => {
    db.close();
    process.exit(4);
  });
}

await main();

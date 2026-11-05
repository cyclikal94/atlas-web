#!/usr/bin/env node
// WEB-09c revision 35 (R35-RET, family `diagnostic-fixture-retention-composition`): the SQLite READER GUARD of one diagnostic attempt.
//
// Why it exists. An anchored WAL inode is only meaningful together with the database it belongs to. SQLite deletes a WAL (and the next
// connection creates a NEW one, a different inode) only when the LAST connection to the database closes and can take the database file's
// exclusive lock (https://sqlite.org/wal.html, "the last connection ... does one last checkpoint and then deletes the WAL"). A connection
// in WAL mode holds a SHARED lock on the database file for as long as it is open, so while this separate process keeps one read-only
// connection open the executable's pool can close, reopen, write, checkpoint and close again, but it can never retire the WAL: every
// later frame lands in the WAL inode that was named when the guard was held, and that one generation is what the client anchors.
//
// It is a separate PROCESS because POSIX record locks belong to a process and are dropped when that process closes ANY descriptor of the
// file: the runner hashes and copies the anchored (hard-linked, same inode) files, which would silently release a guard held in its own
// process.
//
// Revision 36 (R36-RET, regression of revision 35; design assessment of 2 Nov 2026, token 41c6b27cf2ff4ddf898b1066cb9640d4, C1/C2,
// invariants 1-2): revision 35 opened the PATHNAME it was given with SQLite and only then looked at what that path was. A read-only
// WAL-mode open creates `-wal`/`-shm` beside whatever the path names (https://sqlite.org/wal.html#read_only_databases), so a database,
// directory or symlink replaced after the ready receipt got foreign companions and a schema query before the refusal. Now:
//   1. The guard is given the attempt's AUTHORITY (attempt, the receipt's directory and database paths and identities, the receipt digest)
//      and a private directory of its own. Before anything else it lstat()s the directory and the database name (never following a link)
//      and refuses on any difference: nothing foreign is opened, read, linked or created.
//   2. SQLite never opens the fixture's pathname. The guard hard-links the database NAME into its own new 0700 directory and lstat()s that
//      link: only when the link is the receipt's inode is it the guard's database. That private name cannot change under the guard (the
//      directory is the guard's alone), so the file SQLite opens IS the receipt's inode — the binding is the private name, not an
//      observation of the shared path. A replacement between the check and the link is refused, and the guard removes only its own link
//      name (a foreign inode's link count rose and fell; no foreign directory entry, byte or companion changed).
//   3. The connection's companions are the PRIVATE `guard.sqlite-wal`/`-shm`. The guard never reads the executable's WAL, so it needs no
//      part of its WAL index: what it must hold is the database FILE's shared lock, which is per inode, whatever the name. A read-only
//      connection never writes the database (its descriptor is read-only) and, being read-only, never checkpoints or deletes the
//      executable's WAL; its view is never evidence (the retention is materialised from the anchors after the exit). The two hazards of a
//      second name (https://sqlite.org/howtocorrupt.html §2.4, §2.2): a WRITER using another journal name — the guard writes nothing; and
//      POSIX locks dropped by an unrelated close — the guard is its own process and opens no other descriptor of the inode.
//   4. After the lock is held it observes (lstat only, never opens) the fixture's directory, database name, WAL and journal, bracketed by
//      the directory identity: the WAL named now is the generation that can no longer be retired. A WAL that is absent, not a regular file
//      or has another link is refused.
//
// Protocol (stdout JSON lines, one per state; stdin lines). Started with `--authority JSON` (see `authorityProblems`) and optionally
// `--pause POINT[,POINT]` (qualification only: at each named point it reports `{"event":"paused","at"}` and waits for the line `continue`;
// the runner never passes it). Points: `before-link` (the ownership check passed), `before-open` (the private link is bound), `before-report`
// (the connection holds; the fixture is not yet observed). Then it reports
//   {"event":"held","method","attempt","receipt_sha256","namespace":"private","private_dir":{path,dev,ino},"opened":{name,dev,ino},
//    "journal_mode":"wal","database":{dev,ino},"wal":{dev,ino,nlink},"journal":false}
// or refuses (`{"event":"refused","stage","reason",...}`) or fails (`{"event":"failed","stage","error"}`) and exits. While held it waits for
// the line `release`, closes the connection, reports `{"event":"released"}` and exits 0. Stdin EOF without `release` (its parent is gone)
// closes the connection and exits 4 without `released`. It never writes the database, and it removes nothing but its own refused link.
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

export const GUARD_METHOD = "sqlite-private-name-reader/2";
export const GUARD_NAME = "guard.sqlite";
export const PAUSE_POINTS = Object.freeze([
  "before-link",
  "before-open",
  "before-report",
]);
const ATTEMPT = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_PATH = /^\/[A-Za-z0-9/._-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^[0-9]+$/;
const within = (path, dir) => path === dir || path.startsWith(`${dir}/`);
const idOk = (id) =>
  DIGITS.test(String(id?.dev)) && DIGITS.test(String(id?.ino));

/** Why `authority` cannot bind a guard (none: it can). Shape only; nothing is touched. */
export function authorityProblems(authority) {
  const a = authority ?? {};
  const problems = [];
  if (!ATTEMPT.test(String(a.attempt ?? "")))
    problems.push(
      `the attempt ${JSON.stringify(a.attempt ?? null)} is not one`,
    );
  const dir = a.fixture_dir?.path;
  if (!SAFE_PATH.test(String(dir ?? "")) || !idOk(a.fixture_dir))
    problems.push(
      "the receipt's fixture directory has no safe path and identity",
    );
  if (
    !SAFE_PATH.test(String(a.database?.path ?? "")) ||
    !idOk(a.database) ||
    a.database.path !== `${dir}/fixture.sqlite`
  )
    problems.push(
      "the receipt's database is not the fixture directory's fixture.sqlite with an identity",
    );
  if (!HEX64.test(String(a.receipt_sha256 ?? "")))
    problems.push("no ready receipt digest");
  const own = a.private_dir;
  if (!SAFE_PATH.test(String(own ?? "")))
    problems.push("the guard's private directory is not a safe absolute path");
  else if (
    SAFE_PATH.test(String(dir ?? "")) &&
    (within(own, dir) || within(dir, own))
  )
    problems.push(
      "the guard's private directory and the fixture directory nest",
    );
  return problems;
}

const identity = (s) => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (s, want) =>
  s.dev === String(want?.dev) && s.ino === String(want?.ino);
/** lstat() as `{kind, dev, ino, nlink}` (never following a link), or null when the name is absent. */
const look = (path) => {
  try {
    const s = lstatSync(path, { bigint: true });
    const kind = s.isFile()
      ? "file"
      : s.isDirectory()
        ? "directory"
        : s.isSymbolicLink()
          ? "symlink"
          : "other";
    return { kind, ...identity(s), nlink: String(s.nlink) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

async function main() {
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const arg = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : null;
  };
  let authority = null;
  try {
    authority = JSON.parse(arg("--authority") ?? "null");
  } catch {
    authority = null;
  }
  const shape = authorityProblems(authority);
  const pauses = String(arg("--pause") ?? "")
    .split(",")
    .filter(Boolean);
  if (shape.length > 0 || pauses.some((p) => !PAUSE_POINTS.includes(p))) {
    out({
      event: "failed",
      stage: "authority",
      error: shape.join("; ") || `unknown pause point in ${pauses}`,
    });
    process.exit(2);
  }
  // stdin: `continue` (a pause), `release` (the hold). Lines are queued so neither is lost to the other.
  const lines = [];
  let wake = null;
  let ended = false;
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      lines.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
    wake?.();
  });
  process.stdin.on("end", () => {
    ended = true;
    wake?.();
  });
  const nextLine = () =>
    new Promise((resolve) => {
      const check = () => {
        if (lines.length > 0 || ended) {
          wake = null;
          resolve(lines.shift() ?? null);
        }
      };
      wake = check;
      check();
    });
  let db = null;
  const close = () => {
    try {
      db?.close();
    } catch {
      // the connection is the guard's own; the report is what follows
    }
    db = null;
  };
  const pause = async (at) => {
    if (!pauses.includes(at)) return;
    out({ event: "paused", at });
    for (;;) {
      const line = await nextLine();
      if (line === "continue") return;
      if (line === null) {
        close();
        process.exit(4);
      }
    }
  };
  const refuse = (stage, reason, facts = {}) => {
    close();
    out({ event: "refused", stage, reason, ...facts });
    process.exit(3);
  };
  const { fixture_dir: fixtureDir, database } = authority;
  const own = authority.private_dir;
  const linked = `${own}/${GUARD_NAME}`;
  let stage = "ownership";
  try {
    // 1. Ownership before anything: lstat only, the receipt's identities.
    const dir = look(fixtureDir.path);
    if (dir?.kind !== "directory" || !same(dir, fixtureDir))
      refuse(
        stage,
        "the fixture directory is not the receipt's: nothing is opened",
        { directory: dir },
      );
    const name = look(database.path);
    if (name?.kind !== "file" || !same(name, database))
      refuse(
        stage,
        "the fixture database is not the receipt's: nothing is opened",
        { database: name },
      );
    stage = "private";
    mkdirSync(own, { mode: 0o700 });
    const privateDir = look(own);
    if (privateDir?.kind !== "directory")
      refuse(stage, "the guard's private directory is not a directory");
    await pause("before-link");
    // 2. The binding: the private name of the receipt's inode.
    stage = "link";
    try {
      linkSync(database.path, linked);
    } catch (error) {
      refuse(
        stage,
        `the database cannot be linked privately: ${String(error?.code ?? error)}`,
      );
    }
    const bound = look(linked);
    if (bound?.kind !== "file" || !same(bound, database)) {
      // A replacement between the check and the link: the link is the guard's own name; it is removed, nothing else.
      unlinkSync(linked);
      refuse(
        stage,
        "the linked file is not the receipt's database (replaced between the check and the link): never opened",
        {
          linked: bound,
        },
      );
    }
    await pause("before-open");
    // 3. SQLite opens the private name only.
    stage = "open";
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(linked, { readOnly: true });
    const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode);
    // A real read: in WAL mode the connection now holds the database file's shared lock (per inode) until it is closed.
    db.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
    const opened = look(linked);
    const entries = readdirSync(own).sort();
    if (opened?.kind !== "file" || !same(opened, database))
      refuse(stage, "the guard's private name changed while it was opened");
    if (
      entries.some(
        (e) =>
          ![GUARD_NAME, `${GUARD_NAME}-wal`, `${GUARD_NAME}-shm`].includes(e),
      )
    )
      refuse(
        stage,
        `the guard's private directory holds another name (${entries.join(", ")})`,
      );
    if (mode !== "wal")
      refuse(
        stage,
        `the database is in ${mode} journal mode, not WAL: no generation guard applies`,
      );
    await pause("before-report");
    // 4. The fixture as it is now that the lock is held (lstat only), bracketed by the directory identity.
    stage = "observe";
    const dirNow = look(fixtureDir.path);
    const nameNow = look(database.path);
    const wal = look(`${database.path}-wal`);
    const journal = look(`${database.path}-journal`);
    const dirAgain = look(fixtureDir.path);
    const facts = {
      journal_mode: mode,
      database: nameNow && { dev: nameNow.dev, ino: nameNow.ino },
      wal: wal && { dev: wal.dev, ino: wal.ino, nlink: wal.nlink },
      journal: journal !== null,
    };
    if (
      ![dirNow, dirAgain].every(
        (d) => d?.kind === "directory" && same(d, fixtureDir),
      )
    )
      refuse(
        stage,
        "the fixture directory changed while the guard was acquired",
        facts,
      );
    if (nameNow?.kind !== "file" || !same(nameNow, database))
      refuse(
        stage,
        "the fixture database name changed while the guard was acquired",
        facts,
      );
    if (wal === null)
      refuse(stage, "no WAL file is present while the guard is held", facts);
    if (wal.kind !== "file")
      refuse(stage, "the WAL is not a regular file", facts);
    if (wal.nlink !== "1")
      refuse(
        stage,
        `the WAL has ${wal.nlink} links: it is not SQLite's own file alone`,
        facts,
      );
    if (journal !== null)
      refuse(stage, "a rollback journal is present beside the WAL", facts);
    out({
      event: "held",
      method: GUARD_METHOD,
      attempt: authority.attempt,
      receipt_sha256: authority.receipt_sha256,
      namespace: "private",
      private_dir: { path: own, dev: privateDir.dev, ino: privateDir.ino },
      opened: { name: GUARD_NAME, dev: opened.dev, ino: opened.ino },
      ...facts,
    });
  } catch (error) {
    close();
    out({
      event: "failed",
      stage,
      error: String(error?.code ?? error?.message ?? error),
    });
    process.exit(2);
  }
  for (;;) {
    const line = await nextLine();
    if (line === "release") {
      close();
      out({ event: "released" });
      process.exit(0);
    }
    if (line === null) {
      close();
      process.exit(4);
    }
  }
}

// Run as the guard child (diagnostic-fixture.mjs imports only its exports).
const invoked = (() => {
  try {
    return (
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();
if (invoked) await main();

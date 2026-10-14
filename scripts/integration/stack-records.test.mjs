import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createStackStore,
  publishAtomically,
  readStackRecords,
  stackFile,
  stacksDir,
} from "./stack-records.mjs";

/** Review r8 H4d (revision 9): the durable per-stack records every finaliser recovers from. */
const dir = mkdtempSync(join(tmpdir(), "atlas-stack-records-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
/** A record file as JSON, or null when it is missing or torn (so a torn write fails an assertion, not the parse). */
const readRecord = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
let n = 0;
const runDir = () => {
  n += 1;
  return join(dir, `run-${n}`);
};

test("a publication that fails before its rename leaves the previous complete file, and no partial sibling", () => {
  const path = join(dir, "summary.json");
  publishAtomically(path, '{"version":1}\n');
  assert.throws(
    () =>
      publishAtomically(path, '{"version":2}\n', {
        fail: () => {
          throw new Error("injected failure before the rename");
        },
      }),
    /injected/,
  );
  assert.equal(readFileSync(path, "utf8"), '{"version":1}\n');
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("summary.json.")),
    [],
  );
  publishAtomically(path, '{"version":3}\n');
  assert.equal(readRecord(path)?.version, 3);
});

test("each commit is a new complete version: sequence up, phase never back, an established fact never lost", () => {
  const run = runDir();
  const store = createStackStore(run);
  const name = { browser: "chromium", stack: "base", index: 0 };
  const a = store.commit(
    { ...name, outcome: "running", report: "/r.json", started_at: "t" },
    "started",
  );
  assert.equal(a.seq, 1);
  const b = store.commit(
    {
      ...name,
      outcome: "failed",
      reason: "the report has errors",
      failure: { kind: "report_errors", reason: "the report has errors" },
    },
    "judged",
  );
  assert.equal(b.seq, 2);
  assert.equal(
    b.report,
    "/r.json",
    "what the stack is stays with every version",
  );
  // A later version that says less (a stale writer) keeps the fact and cannot move the phase back.
  const c = store.commit(
    { ...name, outcome: "cancelled", reason: "stopped" },
    "started",
  );
  assert.equal(c.seq, 3);
  assert.equal(c.phase, "judged");
  assert.equal(c.outcome, "failed");
  assert.equal(c.failure?.kind, "report_errors");
  assert.equal(readRecord(stackFile(run, "chromium", 0))?.seq, 3);
  // Another writer (the reaper) continues the same sequence from the file.
  const other = createStackStore(run);
  const d = other.commit(
    { ...name, outcome: "cancelled", cleanup: { by: "reaper", ok: true } },
    "settled",
  );
  assert.equal(d.seq, 4);
  assert.equal(d.outcome, "failed");
  assert.equal(d.phase, "settled");
});

test("a record that cannot be written is not committed (throws, the previous version stays); an unreadable one is never overwritten", () => {
  const run = runDir();
  const store = createStackStore(run, {
    fail: (phase) => {
      if (phase === "settled") throw new Error("injected: disk full");
    },
  });
  const name = { browser: "firefox", stack: "base", index: 1 };
  store.commit({ ...name, outcome: "passed", reason: null }, "judged");
  assert.throws(
    () => store.commit({ ...name, outcome: "passed" }, "settled"),
    /disk full/,
  );
  assert.equal(readRecord(stackFile(run, "firefox", 1))?.phase, "judged");
  writeFileSync(stackFile(run, "webkit", 0), "{ torn");
  const reader = createStackStore(run);
  assert.throws(
    () =>
      reader.commit(
        { browser: "webkit", stack: "base", index: 0, outcome: "passed" },
        "settled",
      ),
    /cannot be read/,
  );
  assert.equal(readFileSync(stackFile(run, "webkit", 0), "utf8"), "{ torn");
  const { records, errors } = readStackRecords(run);
  assert.equal(records.get("firefox-1")?.phase, "judged");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /webkit-0\.json/);
  assert.equal(existsSync(stacksDir(run)), true);
});

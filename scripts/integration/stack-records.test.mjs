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
  commitObservation,
  covers,
  createStackStore,
  joinVersions,
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

// ---- review r9 H4e (revision 10): observations, coverage and the overlay ---------------------------------------------------------------
const name = { browser: "chromium", stack: "base", index: 0 };
const evidence = (r) =>
  (r?.failures ?? []).filter((f) => f.kind === "evidence").map((f) => f.reason);

test("H4e: a failed write is an observation of its own: overlay kept with its ordinal, seq null, the last committed sequence and the phase never moved back", () => {
  let refuse = false;
  const store = createStackStore(runDir(), {
    fail: () => {
      if (refuse) throw new Error("disk full");
    },
  });
  const observe = (known, record, phase, obs) =>
    commitObservation({
      store,
      known,
      record: { ...name, ...record },
      phase,
      obs,
      describe: (error) =>
        `could not be committed (${phase}): ${error.message}`,
    });
  const a = observe(
    null,
    { outcome: "passed", reason: null, cleanup: { ok: true } },
    "settled",
    1,
  );
  assert.equal(a.committed, true);
  assert.equal(a.record.seq, 1);
  assert.equal(a.record.obs, 1);
  refuse = true;
  const b = observe(a.record, { outcome: "passed", reason: null }, "judged", 2);
  assert.equal(b.committed, false);
  assert.equal(b.record.seq, null);
  assert.equal(b.record.committed_seq, 1);
  assert.equal(b.record.obs, 2);
  assert.equal(b.record.phase, "settled", "never back to judged");
  assert.equal(b.record.outcome, "evidence_failed");
  assert.deepEqual(evidence(b.record), [
    "could not be committed (judged): disk full",
  ]);
  assert.equal(
    store.latest("chromium", 0).seq,
    1,
    "nothing claimed as committed",
  );
  // A later successful write from a caller holding only the first version still carries the failure (the overlay is merged in).
  refuse = false;
  const c = observe(
    b.record,
    { outcome: "passed", reason: null, cleanup: { ok: true } },
    "settled",
    3,
  );
  assert.equal(c.committed, true);
  assert.equal(c.record.seq, 2);
  assert.equal(c.record.obs, 3);
  assert.equal(c.record.committed_seq, undefined);
  assert.equal(c.record.outcome, "evidence_failed");
  assert.deepEqual(evidence(c.record), [
    "could not be committed (judged): disk full",
  ]);
  assert.ok(
    covers(c.record, b.record),
    "the later version covers the failed observation",
  );
  assert.ok(!covers(a.record, b.record), "the earlier one does not");
});

test("H4e: coverage needs an explicit ordinal; joins order by ordinal, keep every fact and never revert newer fields", () => {
  assert.equal(covers(null, null), true, "nothing observed");
  assert.equal(covers(null, { obs: 1 }), false);
  assert.equal(covers({ obs: 2 }, { obs: 2 }), true);
  assert.equal(covers({ obs: 1 }, { obs: 2 }), false);
  assert.equal(
    covers({ seq: 5 }, { seq: 1 }),
    false,
    "no ordinal: not covered",
  );
  assert.equal(covers({ obs: 3, unreadable: "x" }, { obs: 1 }), false);
  const older = {
    ...name,
    obs: 1,
    outcome: "failed",
    reason: "the report has errors",
    failure: { kind: "report_errors", reason: "the report has errors" },
    report_errors: ["teardown"],
  };
  const newer = {
    ...name,
    obs: 2,
    outcome: "passed",
    reason: "newer",
    counts: { passed: 1 },
  };
  for (const joined of [
    joinVersions(older, newer),
    joinVersions(newer, older),
  ]) {
    assert.equal(joined.obs, 2);
    assert.deepEqual(joined.counts, { passed: 1 }, "the newer fields");
    assert.deepEqual(joined.report_errors, ["teardown"], "the older facts");
    assert.equal(joined.outcome, "failed", "a pass never hides the failure");
  }
});

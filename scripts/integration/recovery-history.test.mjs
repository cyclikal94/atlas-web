// Review r12 H4g (revision 13): the run's recoveries in one order, and a history of what they established that only grows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attemptFile,
  awaitEarlier,
  claimAttempt,
  claimFile,
  EMPTY,
  historyOf,
  joinHistory,
  keepPrevious,
  previousFile,
  readHistory,
  recordAttempt,
  recoveriesDir,
  running,
  startedOf,
  unknownAttempt,
} from "./recovery-history.mjs";

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-recovery-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A history compared as sets (lists of errors keep first-seen order; that order is not what a join promises). */
const asSets = (h) => ({
  errors: [...h.errors].sort(),
  cleanupNotVerified: h.cleanupNotVerified,
  runErrors: [...h.runErrors].sort(),
  outcome: h.outcome,
  attempts: h.attempts.map((e) => ({
    ...e,
    evidence_errors: [...(e.evidence_errors ?? [])].sort(),
  })),
});

const A = historyOf({
  attempt: 1,
  at: "2026-10-15T01:00:00.000Z",
  reason: "lost",
  ok: true,
  evidence_errors: ["copy: ENOTDIR", "summary.json: EIO"],
  run_evidence_errors: ["admissions: EIO"],
  run_outcome: "failed",
});
const B = historyOf({
  attempt: 2,
  at: "2026-10-15T01:01:00.000Z",
  reason: "lost",
  ok: false,
  evidence_errors: ["summary.json: EIO"],
  run_outcome: "passed",
});
const C = unknownAttempt(3, { pid: 42, at: "2026-10-15T01:02:00.000Z" });
// The same attempt as A, from its corrected reaper.json (one more failure known).
const A2 = historyOf({
  attempt: 1,
  at: "2026-10-15T01:00:00.000Z",
  reason: "lost",
  ok: true,
  evidence_errors: ["copy: ENOTDIR", "summary.json: EIO", "reaper.json: EIO"],
});

test("joins are commutative, associative and idempotent as sets, and never lose a failure, a clean-up or an established outcome", () => {
  const xs = [EMPTY, A, B, C, A2];
  for (const x of xs) {
    assert.deepEqual(asSets(joinHistory(x, x)), asSets(x), "idempotent");
    assert.deepEqual(
      asSets(joinHistory(x, EMPTY)),
      asSets(x),
      "EMPTY is neutral",
    );
    for (const y of xs) {
      assert.deepEqual(
        asSets(joinHistory(x, y)),
        asSets(joinHistory(y, x)),
        "commutative",
      );
      for (const z of xs)
        assert.deepEqual(
          asSets(joinHistory(joinHistory(x, y), z)),
          asSets(joinHistory(x, joinHistory(y, z))),
          "associative",
        );
    }
  }
  const all = [A, B, C, A2].reduce(joinHistory, EMPTY);
  assert.deepEqual([...all.errors].sort(), [
    "copy: ENOTDIR",
    "reaper.json: EIO",
    `recovery attempt 3 ended without its record (pid 42): what it found and did is unknown`,
    "summary.json: EIO",
  ]);
  assert.equal(all.cleanupNotVerified, true);
  assert.deepEqual(all.runErrors, ["admissions: EIO"]);
  assert.equal(all.outcome, "failed", "a later 'passed' never lowers it");
  // One line per attempt: the two descriptions of attempt 1 are one, with every failure of either.
  assert.deepEqual(
    all.attempts.map((e) => [e.attempt, e.ok, e.unknown ?? false]),
    [
      [1, true, false],
      [2, false, false],
      [3, null, true],
    ],
  );
  assert.deepEqual(all.attempts[0].evidence_errors, [
    "copy: ENOTDIR",
    "summary.json: EIO",
    "reaper.json: EIO",
  ]);
  // plan_error is kept over failed whichever came first.
  const p = historyOf({ ok: true, run_outcome: "plan_error" });
  assert.equal(joinHistory(A, p).outcome, "plan_error");
  assert.equal(joinHistory(p, A).outcome, "plan_error");
});

test("a record from before revision 13 still says what it found; a clean-up is verified only by ok: true", () => {
  const legacy = historyOf({
    ok: true,
    evidence_errors: ["x"],
    at: "t",
    reason: "r",
  });
  assert.deepEqual(legacy.errors, ["x"]);
  assert.equal(legacy.cleanupNotVerified, false);
  assert.equal(historyOf({ ok: false }).cleanupNotVerified, true);
  // A deadline leaves `ok` unsaid: not verified.
  assert.equal(historyOf({ deadline_reached: true }).cleanupNotVerified, true);
  // The history a record carries counts, also its attempts' clean-ups.
  const carried = historyOf({
    ok: true,
    recovery_history: {
      evidence_errors: ["earlier"],
      cleanup_not_verified: false,
      attempts: [{ attempt: 1, ok: false, evidence_errors: [] }],
    },
  });
  assert.deepEqual(carried.errors, ["earlier"]);
  assert.equal(carried.cleanupNotVerified, true);
  const clean = historyOf({
    attempt: 2,
    ok: true,
    evidence_errors: [],
    recovery_history: {
      evidence_errors: [],
      cleanup_not_verified: false,
      attempts: [{ attempt: 1, ok: true, evidence_errors: [] }],
    },
  });
  assert.deepEqual(clean.errors, []);
  assert.equal(clean.cleanupNotVerified, false);
});

test("readHistory: an absent previous reaper.json is no history; a clean one is clean; every unreadable state is a named failure, never absence", (t) => {
  const dir = scratch(t);
  assert.deepEqual(readHistory(dir, 1), { history: EMPTY, errors: [] });
  writeFileSync(
    join(dir, "reaper.json"),
    JSON.stringify({ ok: true, evidence_errors: [] }),
  );
  const clean = readHistory(dir, 1);
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.history.errors, []);
  assert.equal(clean.history.cleanupNotVerified, false);
  const cases = [
    [
      "torn",
      () => writeFileSync(join(dir, "reaper.json"), '{"ok":tr'),
      /could not be read/,
    ],
    [
      "null",
      () => writeFileSync(join(dir, "reaper.json"), "null"),
      /is not valid evidence: it is not a JSON object/,
    ],
    [
      "a list",
      () => writeFileSync(join(dir, "reaper.json"), "[]"),
      /it is not a JSON object/,
    ],
    [
      "errors of another type",
      () =>
        writeFileSync(
          join(dir, "reaper.json"),
          '{"ok":true,"evidence_errors":"x"}',
        ),
      /`evidence_errors` is not a list/,
    ],
    [
      "ok of another type",
      () => writeFileSync(join(dir, "reaper.json"), '{"ok":"yes"}'),
      /`ok` is not true or false/,
    ],
    [
      "history of another shape",
      () =>
        writeFileSync(
          join(dir, "reaper.json"),
          '{"ok":true,"recovery_history":{"evidence_errors":[1]}}',
        ),
      /`recovery_history` is not a recovery history/,
    ],
    [
      "a directory",
      () => {
        rmSync(join(dir, "reaper.json"), { force: true });
        mkdirSync(join(dir, "reaper.json"));
      },
      /could not be read: EISDIR/,
    ],
  ];
  for (const [label, make, error] of cases) {
    make();
    const r = readHistory(dir, 1);
    assert.equal(r.errors.length, 1, label);
    assert.match(r.errors[0], /^the previous recovery's reaper\.json /, label);
    assert.match(r.errors[0], error, label);
    assert.equal(
      r.history.cleanupNotVerified,
      true,
      `${label}: its clean-up is unknown`,
    );
  }
});

test("readHistory: every earlier attempt record is read (also one written after a refusal), unreadable ones are failures, ended attempts are unknown", (t) => {
  const dir = scratch(t);
  mkdirSync(recoveriesDir(dir));
  recordAttempt(
    dir,
    1,
    JSON.stringify({ attempt: 1, ok: true, evidence_errors: ["one"] }),
  );
  writeFileSync(attemptFile(dir, 2), "{");
  // A later attempt's record (it refused while this one waited) is read too; this attempt's own number is not.
  recordAttempt(
    dir,
    5,
    JSON.stringify({
      attempt: 5,
      ok: true,
      evidence_errors: ["five"],
      refused: "r",
    }),
  );
  writeFileSync(
    attemptFile(dir, 4),
    JSON.stringify({ attempt: 4, ok: true, evidence_errors: ["mine"] }),
  );
  const r = readHistory(dir, 4, [{ attempt: 3, claim: { pid: 7, at: "t" } }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^recovery attempt 2's record could not be read: /);
  assert.deepEqual(r.history.errors, [
    "one",
    "five",
    "recovery attempt 3 ended without its record (pid 7): what it found and did is unknown",
  ]);
  assert.equal(r.history.cleanupNotVerified, true);
  assert.deepEqual(
    r.history.attempts.map((e) => e.attempt),
    [1, 3, 5],
  );
});

test("claims are exclusive and complete: the next number is taken, a claim is never replaced", (t) => {
  const dir = scratch(t);
  assert.equal(claimAttempt(dir, { pid: 11, started: "s" }), 1);
  // Someone else's claim of 2 already there: it is kept, and this claim is 3.
  writeFileSync(
    claimFile(dir, 2),
    JSON.stringify({ attempt: 2, pid: 12, started: null }),
  );
  assert.equal(claimAttempt(dir, { pid: 13, started: "s" }), 3);
  assert.deepEqual(JSON.parse(readFileSync(claimFile(dir, 1), "utf8")), {
    attempt: 1,
    pid: 11,
    started: "s",
  });
  assert.equal(JSON.parse(readFileSync(claimFile(dir, 2), "utf8")).pid, 12);
  // A run folder where no claim can be written: thrown, never a number.
  const file = join(dir, "not-a-folder");
  writeFileSync(file, "");
  assert.throws(() => claimAttempt(file, { pid: 1 }), /ENOTDIR|EEXIST/);
});

test("awaitEarlier: an ended attempt (record, or claimant gone) is waited for no longer; a running or unknown claimant is never overtaken", (t) => {
  const dir = scratch(t);
  claimAttempt(dir, { pid: 101, started: "a" });
  claimAttempt(dir, { pid: 102, started: "b" });
  claimAttempt(dir, { pid: 103, started: "c" });
  recordAttempt(dir, 1, "{}");
  let slept = 0;
  const sleep = () => {
    slept += 1;
  };
  // 2 is gone without a record: ended, unknown.
  const gone = awaitEarlier(dir, 3, { waitMs: 0, sleep, live: () => false });
  assert.deepEqual(gone, {
    ready: true,
    ended: [{ attempt: 2, claim: { attempt: 2, pid: 102, started: "b" } }],
  });
  // Running: waited for until the bound, then not ready (nothing may be replaced).
  const busy = awaitEarlier(dir, 3, {
    waitMs: 50,
    pollMs: 1,
    sleep: () => {
      slept += 1;
      const until = Date.now() + 5;
      while (Date.now() < until);
    },
    live: () => true,
  });
  assert.equal(busy.ready, false);
  assert.deepEqual(busy.waiting, {
    attempt: 2,
    why: "its claimant (pid 102) is running",
  });
  assert.ok(slept > 0, "it waited");
  // Unknown (the process table cannot be read) is not "gone".
  const unknown = awaitEarlier(dir, 3, { waitMs: 0, sleep, live: () => null });
  assert.equal(unknown.ready, false);
  assert.match(unknown.waiting.why, /cannot be known/);
  // The claimant ends while this attempt waits: it goes on, the attempt unknown.
  let polls = 0;
  const ends = awaitEarlier(dir, 3, {
    waitMs: 60_000,
    sleep: () => {
      polls += 1;
    },
    live: () => polls < 3,
  });
  assert.equal(ends.ready, true);
  assert.equal(polls, 3);
  assert.deepEqual(
    ends.ended.map((e) => e.attempt),
    [2],
  );
  // Its record appears while this attempt waits: ended, not unknown.
  let more = 0;
  const recorded = awaitEarlier(dir, 3, {
    waitMs: 60_000,
    sleep: () => {
      more += 1;
      if (more === 2) recordAttempt(dir, 2, "{}");
    },
    live: () => true,
  });
  assert.deepEqual(recorded, { ready: true, ended: [] });
  // A claim that cannot be read names no owner: never overtaken.
  claimAttempt(dir, { pid: 104 });
  writeFileSync(claimFile(dir, 3), "{");
  const torn = awaitEarlier(dir, 5, { waitMs: 0, sleep, live: () => false });
  assert.equal(torn.ready, false);
  assert.equal(torn.waiting.attempt, 3);
});

test("running(): a live process with its start time is running; the same pid with another start time, or a finished one, is not", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((r) => child.once("spawn", r));
  const started = startedOf(child.pid);
  assert.ok(started);
  assert.equal(running(child.pid, started), true);
  assert.equal(running(child.pid, null), true);
  assert.equal(running(child.pid, "Thu Jan  1 00:00:00 1970"), false);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.equal(running(child.pid, started), false);
});

test("keepPrevious keeps the previous reaper.json's bytes, whatever they are, before it is replaced", (t) => {
  const dir = scratch(t);
  mkdirSync(recoveriesDir(dir));
  assert.equal(keepPrevious(dir, 1), false, "nothing to keep");
  writeFileSync(join(dir, "reaper.json"), '{"torn');
  assert.equal(keepPrevious(dir, 2), true);
  assert.equal(readFileSync(previousFile(dir, 2), "utf8"), '{"torn');
  assert.equal(
    statSync(previousFile(dir, 2)).ino,
    statSync(join(dir, "reaper.json")).ino,
  );
  rmSync(join(dir, "reaper.json"));
  mkdirSync(join(dir, "reaper.json"));
  assert.equal(keepPrevious(dir, 3), false, "a directory stays where it is");
});

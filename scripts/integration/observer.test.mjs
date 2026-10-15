// Review r15 H4j (revision 16): the runner's reading of the reaper's receipt (observer.mjs). Every state that is not an answer to the
// barrier waited for stays unanswered or fails; none is a pass.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  awaitReceipt,
  OBSERVER_FILE,
  readReceipt,
  receiptText,
} from "./observer.mjs";

const INV = "inv-observer";
function runDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-observer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (dir, value) =>
  writeFileSync(
    join(dir, OBSERVER_FILE),
    typeof value === "string" ? value : JSON.stringify(value),
  );
const receipt = (fields = {}) => ({
  schema: 1,
  invocation: INV,
  barrier: 1,
  phase: "barrier",
  errors: [],
  ...fields,
});

test("H4j: a receipt answers its barrier with every error it holds (control: the reaper's own text reads back)", (t) => {
  const dir = runDir(t);
  writeFileSync(
    join(dir, OBSERVER_FILE),
    receiptText({
      invocation: INV,
      barrier: 2,
      phase: "barrier",
      errors: ["observed: EIO"],
    }),
  );
  const r = readReceipt(dir, { invocation: INV, barrier: 2 });
  assert.equal(r.state, "covered");
  assert.deepEqual(r.receipt.errors, ["observed: EIO"]);
  // A newer receipt answers an older barrier too (receipts are cumulative).
  assert.equal(
    readReceipt(dir, { invocation: INV, barrier: 1 }).state,
    "covered",
  );
});

test("H4j: no receipt or an older one is not yet an answer; the terminal phase is required when asked for", (t) => {
  const dir = runDir(t);
  assert.equal(
    readReceipt(dir, { invocation: INV, barrier: 1 }).state,
    "pending",
  );
  put(dir, receipt({ barrier: 1, errors: ["older"] }));
  const older = readReceipt(dir, { invocation: INV, barrier: 2 });
  assert.equal(older.state, "pending");
  assert.match(older.why, /answers barrier 1, not yet 2/);
  const notTerminal = readReceipt(dir, {
    invocation: INV,
    barrier: 1,
    phase: "released",
  });
  assert.equal(notTerminal.state, "pending");
  put(dir, receipt({ barrier: 1, phase: "released" }));
  assert.equal(
    readReceipt(dir, { invocation: INV, barrier: 1, phase: "released" }).state,
    "covered",
  );
});

test("H4j: an unreadable, malformed or other invocation's receipt fails at once", (t) => {
  const cells = [
    ["{ torn", /could not be read/],
    [JSON.stringify([]), /not a JSON object/],
    [receipt({ schema: 2 }), /`schema` is not 1/],
    [receipt({ barrier: "1" }), /`barrier` is not a barrier number/],
    [receipt({ phase: "done" }), /`phase` is not/],
    [receipt({ errors: "EIO" }), /`errors` is not a list/],
    [receipt({ errors: [1] }), /`errors` is not a list/],
    [
      receipt({ invocation: "another" }),
      /names invocation another, not inv-observer/,
    ],
  ];
  for (const [value, error] of cells) {
    const dir = runDir(t);
    put(dir, value);
    const r = readReceipt(dir, { invocation: INV, barrier: 1 });
    assert.equal(r.state, "failed", JSON.stringify(value));
    assert.match(r.error, error);
  }
  // A path that cannot be read as a file (a directory there) is unreadable, not absent.
  const dir = runDir(t);
  mkdirSync(join(dir, OBSERVER_FILE));
  assert.equal(
    readReceipt(dir, { invocation: INV, barrier: 1 }).state,
    "failed",
  );
});

test("H4j: waiting is bounded: no answer by the bound, or the reaper ending first, fails; a late answer within it is taken", async (t) => {
  const dir = runDir(t);
  const started = Date.now();
  const timedOut = await awaitReceipt(dir, {
    invocation: INV,
    barrier: 1,
    ms: 200,
  });
  assert.equal(timedOut.state, "failed");
  assert.match(
    timedOut.error,
    /did not answer barrier 1 within 200 ms \(no receipt yet\)/,
  );
  assert.ok(Date.now() - started >= 200);
  // A stale receipt never satisfies a newer barrier, also when the wait ends.
  put(dir, receipt({ barrier: 1 }));
  const stale = await awaitReceipt(dir, {
    invocation: INV,
    barrier: 2,
    ms: 100,
  });
  assert.equal(stale.state, "failed");
  assert.match(stale.error, /answers barrier 1, not yet 2/);
  const ended = await awaitReceipt(dir, {
    invocation: INV,
    barrier: 2,
    ms: 10_000,
    ended: Promise.resolve({ code: 0 }),
  });
  assert.equal(ended.state, "failed");
  assert.match(ended.error, /ended without answering barrier 2/);
  setTimeout(() => put(dir, receipt({ barrier: 2, errors: ["late"] })), 100);
  const late = await awaitReceipt(dir, {
    invocation: INV,
    barrier: 2,
    ms: 5000,
  });
  assert.equal(late.state, "covered");
  assert.deepEqual(late.receipt.errors, ["late"]);
  // An unreadable receipt is not waited out.
  put(dir, "{ torn");
  const unreadable = await awaitReceipt(dir, {
    invocation: INV,
    barrier: 3,
    ms: 10_000,
  });
  assert.equal(unreadable.state, "failed");
  assert.match(unreadable.error, /could not be read/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { Cancelled } from "./ownership.mjs";
import { createScope } from "./scope.mjs";

/** A step that waits for `release()` or the scope's stop, whichever comes first (an acknowledgement, not a sleep). */
function gate() {
  let release;
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  return { release, opened };
}
const stoppable = (signal, until) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    until.then(resolve);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

test("a healthy scope disposes of everything it registered, last first, and is ok", async () => {
  const scope = createScope("healthy");
  const order = [];
  await scope.run("prepare", async () => {
    scope.defer("first", () => order.push("first"));
    scope.defer("second", () => {
      order.push("second");
      return { ok: true, detail: 2 };
    });
  });
  const closed = await scope.close();
  assert.deepEqual(order, ["second", "first"]);
  assert.equal(closed.ok, true);
  assert.equal(closed.producers_settled, true);
  assert.deepEqual(
    closed.steps.map((s) => [s.label, s.ok]),
    [
      ["second", true],
      ["first", true],
    ],
  );
});

test("H4a: a stop during preparation waits for the producer, then disposes of what it created meanwhile", async () => {
  const scope = createScope("h4a");
  const created = [];
  const disposed = [];
  const createdAfterStop = gate();
  const preparing = scope.run("prepare", async (signal) => {
    // The disposal of the containers is registered before the first creation, as run.mjs does for PostgreSQL.
    scope.defer("containers", () => {
      disposed.push(...created);
      return { ok: true };
    });
    created.push("pg");
    // A creation that is already under way when the stop arrives completes (it is not abortable)...
    await createdAfterStop.opened;
    created.push("backend");
    // ...and the next wait ends with the stop.
    await stoppable(signal, new Promise(() => undefined));
  });
  const closing = scope.close("received SIGTERM");
  let finished = false;
  closing.then(() => {
    finished = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(finished, false, "disposal waits for the producer");
  assert.deepEqual(
    disposed,
    [],
    "nothing is disposed while a producer can still create",
  );
  createdAfterStop.release();
  const closed = await closing;
  await assert.rejects(preparing, Cancelled);
  assert.deepEqual(
    disposed,
    ["pg", "backend"],
    "the late creation is disposed too",
  );
  assert.equal(closed.ok, true);
  assert.equal(closed.reason, "received SIGTERM");
});

test("one disposal: the signal path and the stack's own end share the same promise and nothing runs twice", async () => {
  const scope = createScope("once");
  let runs = 0;
  scope.defer("tmp", () => {
    runs += 1;
  });
  const [a, b] = [
    scope.close("received SIGTERM"),
    scope.close("the stack ended"),
  ];
  assert.equal(a === b, true, "both callers hold the same disposal");
  const closed = await a;
  assert.equal(runs, 1);
  assert.equal(closed.reason, "received SIGTERM", "the first reason wins");
});

test("after a stop no producer starts and check() refuses", async () => {
  const scope = createScope("latched");
  scope.stop("first stack failed");
  scope.stop("a later reason does not replace the first");
  assert.equal(scope.reason, "first stack failed");
  assert.throws(() => scope.check(), Cancelled);
  let ran = false;
  await assert.rejects(
    scope.run("late", () => {
      ran = true;
    }),
    Cancelled,
  );
  assert.equal(ran, false);
});

test("a failed disposal step, a producer that never settles and a registration after disposal are never ok", async () => {
  const failing = createScope("failing");
  failing.defer("rm", () => {
    throw new Error("removal denied");
  });
  failing.defer("verify", () => ({ ok: false, left: ["c1"] }));
  const closed = await failing.close();
  assert.equal(closed.ok, false);
  assert.deepEqual(
    closed.steps.map((s) => [s.label, s.ok]),
    [
      ["verify", false],
      ["rm", false],
    ],
  );
  assert.match(closed.steps[1].error, /removal denied/);

  const stuck = createScope("stuck", { settleMs: 100 });
  const late = [];
  const hang = gate();
  stuck.run("deaf", async () => {
    await hang.opened; // does not look at the stop
    stuck.defer("late-resource", () => {
      late.push("disposed");
    });
  });
  const stuckClosed = await stuck.close();
  assert.equal(stuckClosed.producers_settled, false);
  assert.deepEqual(stuckClosed.unsettled_producers, ["deaf"]);
  assert.equal(stuckClosed.ok, false);
  hang.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    late,
    ["disposed"],
    "a registration after disposal is disposed at once",
  );
  assert.equal(stuckClosed.late.length, 1);
  assert.equal(stuckClosed.ok, false);
});

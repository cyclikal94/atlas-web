import assert from "node:assert/strict";
import test from "node:test";
import { scheduleStage } from "./scheduler.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(steps, { limit = 3, fail = null, throwAt = null } = {}) {
  const done = new Set(),
    events = [];
  let failed = false,
    active = 0,
    peak = 0;
  await scheduleStage(steps, {
    limit,
    mayOverlap: (s) => s.parallel === true,
    succeeded: (id) => done.has(id),
    stopped: () => failed,
    execute: async (s, { requirePool }) => {
      events.push(`start:${s.id}`);
      active++;
      peak = Math.max(peak, active);
      assert.equal(requirePool, limit > 1 && s.parallel === true);
      if (!s.parallel) assert.equal(active, 1);
      await sleep(s.ms ?? 10);
      active--;
      events.push(`end:${s.id}`);
      if (s.id === throwAt) throw Error("owned failure");
      if (s.id === fail) failed = true;
      else done.add(s.id);
    },
  });
  return { events, peak, done };
}
test("independent pooled work overlaps, dependency and exclusive barriers stay ordered", async () => {
  const r = await run([
    { id: "a", parallel: true },
    { id: "b", parallel: true },
    { id: "local" },
    { id: "c", parallel: true, after: ["a", "b", "local"] },
  ]);
  assert.equal(r.peak, 2);
  assert.ok(r.events.indexOf("start:local") > r.events.indexOf("end:b"));
  assert.ok(r.events.indexOf("start:c") > r.events.indexOf("end:local"));
});
test("failure prevents new admission but drains already-started work", async () => {
  const r = await run(
    [
      { id: "bad", parallel: true, ms: 1 },
      { id: "running", parallel: true, ms: 25 },
      { id: "later", parallel: true },
    ],
    { limit: 2, fail: "bad" },
  );
  assert.ok(r.events.includes("end:running"));
  assert.ok(!r.events.includes("start:later"));
});
test("exceptions drain active jobs before being rethrown", async () => {
  const events = [];
  await assert.rejects(
    scheduleStage([{ id: "bad" }, { id: "running" }, { id: "later" }], {
      limit: 2,
      mayOverlap: () => true,
      succeeded: () => true,
      stopped: () => false,
      execute: async (s) => {
        if (s.id === "bad") throw Error("bad");
        await sleep(20);
        events.push(s.id);
      },
    }),
    /bad/,
  );
  assert.deepEqual(events, ["running"]);
});
test("default concurrency remains serial and unresolved prerequisites refuse", async () => {
  assert.equal(
    (
      await run(
        [
          { id: "a", parallel: true },
          { id: "b", parallel: true },
        ],
        { limit: 1 },
      )
    ).peak,
    1,
  );
  await assert.rejects(run([{ id: "a", after: ["missing"] }]), /Unmet/);
});

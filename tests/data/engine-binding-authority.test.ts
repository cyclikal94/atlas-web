// @vitest-environment node
import { describe, expect, test } from "vitest";
import { CAPTURE_OPERATION } from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import { scopeOf } from "../support/data/marker-storage";

/**
 * N1 (WEB-13b revision 5; handover `delivery/handoffs/web13b-n1-approved-20261025.md`): a local write of the sync engine that failed, and
 * whose failure counter could not be written either, created its fallback stop after the counter's await asking only whether the account's
 * SERVICE stood. The service outlives the leadership binding (the leader's unbind aborts the ownership and stops the engine; the account's
 * runtime keeps the service), so a binding that had ended left a `capture` marker, and showed `stopped` in its stopped engine, and the
 * account's next owner was stopped on a failure it never met: no request at all (the design assessment's Q15, executed in revision 5's
 * `n1` probe before this correction). The engine now asks for the binding of the run that met the failure too, after every wait and at
 * the synchronous creation of the stop, and publishes no state for a binding that is over. A failure of the binding that stands is
 * recorded and shown exactly as before, and a stop a counter COMMITTED stays in the record for whoever owns the account next.
 *
 * FIXTURE evidence: the production engine, plans and markers over the doubles of IndexedDB and `localStorage`; the network is a script
 * and time is fake. Every fault is a named injection whose hits are asserted; the DELIVERY of the counter's result is held after its
 * transaction ran (`holdDelivery`), and the binding's end is the leader's (the ownership aborted, the engine stopped, the service live).
 */
type World = Awaited<ReturnType<typeof engineWorld>>;

const COUNTER = "data.recordLocalWriteOutcome";
const STOPPED = { kind: "stopped", cause: "local_storage" } as const;

function fail(w: World, label: string, times: number) {
  const hits = { count: 0 };
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label !== label || hits.count >= times) return false;
      hits.count += 1;
      return true;
    },
    mode: "error",
    times,
  });
  return hits;
}

/** Holds the DELIVERY of the first run of `name`: its transaction runs (and commits or fails) at once, the engine hears at `release()`. */
function holdDelivery(w: World, name: string) {
  const store = w.service.store as unknown as {
    run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
  };
  const real = store.run.bind(store);
  let hits = 0;
  let release = () => {};
  store.run = (plan, ...rest) => {
    const result = real(plan, ...rest);
    if (plan.name !== name || hits > 0) return result;
    hits += 1;
    return new Promise((resolve, reject) =>
      result.then(
        (value) => {
          release = () => resolve(value);
        },
        (error) => {
          release = () => reject(error);
        },
      ),
    );
  };
  return {
    get hits() {
      return hits;
    },
    release: () => release(),
  };
}

/** The failures the counter was asked to record, by operation, as each run of it is submitted. */
function counted(w: World) {
  const store = w.service.store as unknown as {
    run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
  };
  const real = store.run.bind(store);
  const operations: string[] = [];
  store.run = (plan, ...rest) => {
    const input = rest[0] as
      | { operation?: string; outcome?: { kind?: string } }
      | undefined;
    if (plan.name === COUNTER && input?.outcome?.kind === "failure")
      operations.push(input.operation ?? "");
    return real(plan, ...rest);
  };
  return operations;
}

/** The leader's unbind: the ownership aborts and the engine stops; the account's service goes on. */
async function endBinding(w: World) {
  w.ownership.abort();
  w.engine.stop();
  await w.settle();
  expect(w.ownership.value.signal.aborted).toBe(true);
  expect(w.service.live, "the service outlives the binding").toBe(true);
}

const newOwnership = () => ({
  token: null,
  signal: new AbortController().signal,
});
const marked = (w: World) =>
  w.markers.has(scopeOf(w.service.account), CAPTURE_OPERATION);

/** The capture write fails once and its counter fails once; the counter's rejection is held. Nothing has been requested. */
async function captureFailureHeld(w: World) {
  const capture = fail(w, "data.captureRequest", 1);
  const counter = fail(w, COUNTER, 1);
  const held = holdDelivery(w, COUNTER);
  w.start();
  await w.settle();
  expect([capture.count, counter.count, held.hits]).toEqual([1, 1, 1]);
  expect(w.requests).toHaveLength(0);
  return held;
}

describe("N1: the sync engine creates a stop only while the binding that met the failure stands", () => {
  for (const next of [
    "a reload (a new engine)",
    "the same engine (the leader reuses it)",
  ] as const)
    test(`the counter's rejection is delivered after the binding ENDED: no capture marker, nothing shown, and the next owner through ${next} requests`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      try {
        const held = await captureFailureHeld(w);
        await endBinding(w);
        held.release();
        await w.settle();
        expect(marked(w), "no fallback after the binding ended").toBe(false);
        expect(w.state(), "nothing shown by the ended engine").toEqual({
          kind: "not_started",
        });
        expect(w.sync().local_write_streaks ?? {}).toEqual({});
        w.script.push(w.emptyPage("cursor-1"));
        if (next === "a reload (a new engine)") w.reload();
        w.engine.start(newOwnership());
        await w.settle();
        expect(w.requests, "the successor is not stopped").toHaveLength(1);
        expect(w.state()).toMatchObject({ kind: "idle" });
      } finally {
        w.engine.stop();
      }
    });

  test("control: the binding stands, so the counter's rejection records the capture stop in the marker and shows it", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    try {
      const held = await captureFailureHeld(w);
      held.release();
      await w.settle();
      expect(marked(w)).toBe(true);
      expect(w.state()).toEqual(STOPPED);
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(0);
    } finally {
      w.engine.stop();
    }
  });

  for (const ended of [true, false])
    test(`the marker cannot be written either: ${ended ? "after the binding ended nothing is held in this tab, and the same engine under a new ownership requests" : "control: the binding stands, this tab holds the stop and says it is memory-only"}`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      try {
        w.markerStorage.failWrites = true;
        const held = await captureFailureHeld(w);
        if (ended) await endBinding(w);
        held.release();
        await w.settle();
        expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
        if (!ended) {
          expect(w.state()).toEqual({ ...STOPPED, memoryOnly: true });
          w.fire();
          await w.settle();
          expect(w.requests).toHaveLength(0);
          return;
        }
        expect(w.state()).toEqual({ kind: "not_started" });
        w.script.push(w.emptyPage("cursor-1"));
        w.engine.start(newOwnership());
        await w.settle();
        expect(w.requests).toHaveLength(1);
      } finally {
        w.engine.stop();
      }
    });

  test("control: a below-bound counter that SUCCEEDS after the binding ended records its count and nothing else; the next owner requests", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    try {
      const capture = fail(w, "data.captureRequest", 1);
      const held = holdDelivery(w, COUNTER);
      w.start();
      await w.settle();
      expect([capture.count, held.hits]).toEqual([1, 1]);
      await endBinding(w);
      held.release();
      await w.settle();
      expect(marked(w)).toBe(false);
      expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 1 });
      w.script.push(w.emptyPage("cursor-1"));
      w.reload();
      w.engine.start(newOwnership());
      await w.settle();
      expect(w.requests).toHaveLength(1);
    } finally {
      w.engine.stop();
    }
  });

  test("a counter that COMMITS the capture stop at its bound after the binding ended: the ended engine shows nothing, and the next owner stops on the record without a request", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    try {
      w.setSync({ local_write_streaks: { [CAPTURE_OPERATION]: 2 } });
      const capture = fail(w, "data.captureRequest", 1);
      const held = holdDelivery(w, COUNTER);
      w.start();
      await w.settle();
      expect([capture.count, held.hits]).toEqual([1, 1]);
      await endBinding(w);
      held.release();
      await w.settle();
      expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 3 });
      expect(w.state(), "nothing shown by the ended engine").toEqual({
        kind: "not_started",
      });
      expect(marked(w), "no fallback beside the durable stop").toBe(false);
      w.reload();
      w.engine.start(newOwnership());
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual(STOPPED);
    } finally {
      w.engine.stop();
    }
  });
});

describe("N1: a page's failed commit is counted for the binding that met it, through the sizing record's wait", () => {
  for (const between of [
    "the binding ENDS",
    "the same binding's run restarts",
  ] as const)
    test(`the page commit fails and ${between} while its sizing record is delivered: ${between === "the binding ENDS" ? "nothing is counted" : "the failure is counted (a display interruption is not the end of the binding)"}`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      try {
        const commit = fail(w, "data.commitPage", 1);
        const failures = counted(w);
        const held = holdDelivery(w, "data.recordSizingOutcome");
        w.script.push(w.emptyPage("cursor-1"));
        w.start();
        await w.settle();
        expect(w.requests).toHaveLength(1);
        expect([commit.count, held.hits]).toEqual([1, 1]);
        if (between === "the binding ENDS") await endBinding(w);
        else {
          w.engine.stop();
          await w.settle();
          w.script.push(w.emptyPage("cursor-1"));
          w.start();
          await w.settle();
        }
        held.release();
        await w.settle();
        // What the counter was asked to record (the restarted run's own commit of the page then succeeds and ends the streak).
        expect(
          failures.filter((operation) => operation.startsWith("page:")),
        ).toHaveLength(between === "the binding ENDS" ? 0 : 1);
        expect(marked(w)).toBe(false);
      } finally {
        w.engine.stop();
      }
    });
});

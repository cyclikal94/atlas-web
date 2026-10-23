// @vitest-environment node
import { describe, expect, test } from "vitest";
import { World } from "../session/world";
import { FakeIdb } from "./fake-idb";
import { outboxWorld } from "./outbox-world";

/**
 * R30/DA-H1 (revision 25): the automatic driver of the double of IndexedDB delivers what is RUNNABLE and parks on the world's wake
 * otherwise. Before, it drained again whenever anything was queued, so one future timer, frozen page or cleared timer kept a
 * `setImmediate` loop alive for the rest of the file: 79.7 million drains without progress in one whole unit run, up to 918 such loops
 * in one worker. These are the actual `World` and `FakeIdb` (no extracted copy): the counters are `pumpStats`, and every bound is a count
 * reached in a few turns, so a driver that spins fails at its assertion, not by a timeout.
 */
const turns = async (n = 50): Promise<void> => {
  for (let i = 0; i < n; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function driven(...pages: string[]) {
  const world = new World();
  for (const page of pages.length > 0 ? pages : ["A"]) world.registerPage(page);
  const idb = new FakeIdb(world);
  idb.autoDrive = true;
  const seen: string[] = [];
  const event = (name: string, page = "A", delay?: number): number =>
    world.schedule(
      delay === undefined ? "misc" : "timer",
      page,
      { name },
      () => seen.push(name),
      delay,
    );
  return { world, idb, seen, event };
}

describe("R30/DA-H1: the automatic driver delivers runnable work and parks otherwise", () => {
  test("teardown joins an in-flight drain and reports a failure delivered after disposal", async () => {
    const { world, idb } = driven();
    world.schedule("misc", "A", {}, () => {
      throw new Error("late drain failure");
    });
    idb.pump();
    await expect(idb.disposeAndWait()).rejects.toThrow("late drain failure");
    expect(idb.driving).toBe(false);
    await expect(idb.disposeAndWait()).resolves.toBeUndefined();
  });

  test("an empty world: one drain, then the driver stops", async () => {
    const { idb } = driven();
    idb.pump();
    await turns();
    expect(idb.pumpStats).toEqual({ drains: 1, idleDrains: 1 });
    expect(idb.driving).toBe(false);
  });

  test("ready work is delivered in order, and the driver stops when the queue is empty", async () => {
    const { world, idb, seen, event } = driven();
    event("a");
    event("b");
    idb.pump();
    await turns();
    expect(seen).toEqual(["a", "b"]);
    expect(world.pendingCount()).toBe(0);
    expect(idb.driving).toBe(false);
    expect(idb.pumpStats.idleDrains).toBe(0);
  });

  test("a timer still in the future PARKS the driver: no drain without progress, no fake time, until `advance` delivers it once", async () => {
    const { world, idb, seen, event } = driven();
    event("later", "A", 1_000);
    idb.pump();
    await turns(200);
    expect(idb.pumpStats).toEqual({ drains: 1, idleDrains: 1 });
    expect(world.time).toBe(0);
    expect(world.pendingCount()).toBe(1);
    expect(world.hasRunnable()).toBe(false);
    expect(idb.driving).toBe(true);
    expect(seen).toEqual([]);
    await world.advance(1_000);
    await turns();
    expect(seen).toEqual(["later"]);
    expect(world.time).toBe(1_000);
    expect(idb.pumpStats.idleDrains).toBe(1);
  });

  test("an event for a frozen page parks the driver; thawing the page wakes it and the event is delivered", async () => {
    const { world, idb, seen, event } = driven("A", "B");
    world.setFrozen("B", true);
    event("for B", "B");
    idb.pump();
    await turns(200);
    expect(idb.pumpStats.idleDrains).toBe(1);
    expect(seen).toEqual([]);
    world.setFrozen("B", false);
    await turns();
    expect(seen).toEqual(["for B"]);
    expect(idb.driving).toBe(false);
    expect(idb.pumpStats.idleDrains).toBe(1);
  });

  test("a parked driver is woken by new work scheduled from outside a drain (another producer, a release of held work)", async () => {
    const { world, idb, seen, event } = driven();
    event("later", "A", 5_000);
    idb.pump();
    await turns();
    expect(idb.driving).toBe(true);
    event("now");
    await turns();
    expect(seen).toEqual(["now"]);
    world.schedule(
      "Da",
      "A",
      { name: "held" },
      () => seen.push("held"),
      "unbounded",
    );
    await turns();
    expect(seen).toEqual(["now"]);
    expect(world.heldCount()).toBe(1);
    expect(world.release("Da")).toBe(1);
    await turns();
    expect(seen).toEqual(["now", "held"]);
    expect(world.pendingCount()).toBe(1);
    expect(idb.pumpStats.idleDrains).toBe(1);
  });

  test("work that arrives just after a drain's last delivery is not lost (scheduled two macrotasks after the last event ran)", async () => {
    const { world, idb, seen, event } = driven();
    event("later", "A", 5_000);
    world.schedule("misc", "A", { name: "last" }, () => {
      seen.push("last");
      // Two `setImmediate` hops: after the drain's own turn has found nothing more and the drain has ended.
      setImmediate(() =>
        setImmediate(() =>
          world.schedule("misc", "A", { name: "late" }, () =>
            seen.push("late"),
          ),
        ),
      );
    });
    idb.pump();
    await turns();
    expect(seen).toEqual(["last", "late"]);
    expect(world.pendingCount()).toBe(1);
  });

  test("an event whose page is destroyed is dropped, and a driver parked only on it stops", async () => {
    const { world, idb, seen, event } = driven("A", "B");
    world.setFrozen("B", true);
    event("for B", "B");
    idb.pump();
    await turns();
    expect(idb.driving).toBe(true);
    world.markDestroyed("B");
    await turns();
    expect(seen).toEqual([]);
    expect(world.pendingCount()).toBe(0);
    expect(idb.driving).toBe(false);
  });

  test("a manual drain alongside the automatic one delivers each event once, in order", async () => {
    const { world, idb, seen, event } = driven();
    for (let i = 0; i < 20; i += 1) event(`e${i}`);
    idb.pump();
    await Promise.all([world.runUntilIdle(), world.runUntilIdle()]);
    await turns();
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => `e${i}`));
  });

  test("a cleared timer is withdrawn from the world (`cancel`): it is neither delivered nor left queued; a delivered one cannot be cancelled", async () => {
    const { world, idb, seen, event } = driven();
    const id = event("cleared", "A", 1_000);
    const held = world.schedule(
      "Da",
      "A",
      {},
      () => seen.push("held"),
      "unbounded",
    );
    idb.pump();
    await turns();
    expect(world.cancel(id)).toBe(true);
    expect(world.cancel(id)).toBe(false);
    expect(world.cancel(held)).toBe(true);
    expect(world.heldCount()).toBe(0);
    expect(world.pendingCount()).toBe(0);
    await world.advance(2_000);
    expect(seen).toEqual([]);
    const ran = event("ran");
    await turns();
    expect(seen).toEqual(["ran"]);
    expect(world.cancel(ran)).toBe(false);
  });

  test("a drain that throws stops the driver and is reported by `dispose` (the owning test's failure), not lost or retried", async () => {
    const { world, idb, event } = driven();
    world.schedule("misc", "A", {}, () => {
      throw new Error("a delivery threw");
    });
    idb.pump();
    await turns();
    expect(idb.pumpFailure).toBeInstanceOf(Error);
    expect(idb.driving).toBe(false);
    event("after");
    idb.pump();
    await turns();
    expect(world.pendingCount()).toBe(1);
    expect(() => idb.dispose()).toThrow("a delivery threw");
  });

  test("`dispose` ends a parked driver and a drain in flight; another world keeps driving", async () => {
    const one = driven();
    const two = driven();
    one.event("later", "A", 1_000);
    two.event("later", "A", 1_000);
    one.idb.pump();
    two.idb.pump();
    await turns();
    one.idb.dispose();
    expect(one.idb.driving).toBe(false);
    one.event("after dispose");
    one.idb.pump();
    two.event("still driven");
    await turns();
    expect(one.seen).toEqual([]);
    expect(two.seen).toEqual(["still driven"]);
    // In flight: the drain that is under way delivers what is runnable until it is idle (it is the world's own `runUntilIdle`), then
    // does not start again and does not park, so work scheduled after it has ended is not delivered.
    for (let i = 0; i < 5; i += 1) two.event(`e${i}`);
    two.idb.pump();
    two.idb.dispose();
    await turns();
    expect(two.seen).toEqual(["still driven", "e0", "e1", "e2", "e3", "e4"]);
    two.event("after");
    await turns();
    expect(two.seen.includes("after")).toBe(false);
    expect(two.idb.driving).toBe(false);
  });
});

/** Shared across the next two tests, in order: the first leaves a parked driver behind, the second sees it ended by the test setup. */
let leftBehind: FakeIdb | null = null;
let leftAfterFailure: FakeIdb | null = null;

describe("R30/DA-H1: a test's drivers end with that test", () => {
  test("a test leaves a parked driver (a future timer) without disposing it", async () => {
    const { idb, event } = driven();
    event("never due", "A", 60_000);
    idb.pump();
    await turns();
    expect(idb.driving).toBe(true);
    leftBehind = idb;
  });

  test("the next test finds it ended: the setup disposed it when its test ended", async () => {
    expect(leftBehind?.driving).toBe(false);
    const world = leftBehind?.world as World;
    world.schedule("misc", "A", {}, () => undefined);
    leftBehind?.pump();
    await turns();
    // The timer that never fell due and the event just scheduled: both still queued, neither delivered.
    expect(world.pendingCount()).toBe(2);
  });

  test.fails("a test that FAILS at an assertion midway leaves a parked driver (this test is expected to fail)", async () => {
    const { idb, event } = driven();
    event("never due", "A", 60_000);
    idb.pump();
    await turns();
    leftAfterFailure = idb;
    expect(idb.driving).toBe(false);
  });

  test("its driver was ended all the same: teardown runs for a failed test", () => {
    expect(leftAfterFailure).not.toBeNull();
    expect(leftAfterFailure?.driving).toBe(false);
  });

  test("the outbox world's timers are withdrawn when cleared, and its dispatcher stops with the test", async () => {
    const w = await outboxWorld();
    const before = w.env.world.pendingCount();
    const handle = w.timers.setTimeout(() => undefined, 30_000);
    expect(w.env.world.pendingCount()).toBe(before + 1);
    w.timers.clearTimeout(handle);
    expect(w.env.world.pendingCount()).toBe(before);
    w.start();
    await w.settle();
    expect(w.dispatcher.state.get().kind).not.toBe("not_started");
    leftOutbox = w;
  });

  test("the outbox world of the previous test was ended: its dispatcher is stopped and its double no longer drives", () => {
    expect(leftOutbox?.dispatcher.state.get().kind).toBe("not_started");
    expect(leftOutbox?.env.idb.driving).toBe(false);
  });
});

let leftOutbox: Awaited<ReturnType<typeof outboxWorld>> | null = null;

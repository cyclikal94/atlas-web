// @vitest-environment node
import { describe, expect, test } from "vitest";
import { endAll, ownedByTest } from "../lifetime";
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

/** How a call or a promise ended: whether it threw or rejected, and with exactly what (compared with `Object.is`, any value). */
type Outcome = { failed: boolean; reason: unknown };
function attempt(run: () => void): Outcome {
  try {
    run();
    return { failed: false, reason: undefined };
  } catch (reason) {
    return { failed: true, reason };
  }
}
async function settled(promise: Promise<unknown>): Promise<Outcome> {
  try {
    await promise;
    return { failed: false, reason: undefined };
  } catch (reason) {
    return { failed: true, reason };
  }
}

/**
 * Run checks that consume the double's drain failure themselves (revision 26). When they pass, no failure may be left unreported. When
 * one fails first, the failure it did not get to consume is that same defect, and is consumed here rather than reported a second time,
 * as a plain error, by the teardown of the test: the check that failed stays the test's only failure.
 */
async function consuming(idb: FakeIdb, checks: () => Promise<void>) {
  let passed = false;
  try {
    await checks();
    passed = true;
  } finally {
    await turns();
    const leftover = attempt(() => idb.dispose());
    if (passed) expect(leftover.failed).toBe(false);
  }
}

/** Every kind of JavaScript value a drain can be rejected with (R32, revision 26): failure is never told apart by its value. */
const rejections: [string, unknown][] = [
  ["an Error", new Error("a delivery threw")],
  ["null", null],
  ["undefined", undefined],
  ["false", false],
  ["0", 0],
  ["the empty string", ""],
  ["a plain object", { reason: "object" }],
  ["a symbol", Symbol("reason")],
];

describe("R30/DA-H1: the automatic driver delivers runnable work and parks otherwise", () => {
  test("teardown joins an in-flight drain and reports a failure delivered after disposal", async () => {
    const { world, idb } = driven();
    world.schedule("misc", "A", {}, () => {
      throw new Error("late drain failure");
    });
    idb.pump();
    await consuming(idb, async () => {
      await expect(idb.disposeAndWait()).rejects.toThrow("late drain failure");
      expect(idb.driving).toBe(false);
      await expect(idb.disposeAndWait()).resolves.toBeUndefined();
    });
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
    await consuming(idb, async () => {
      await turns();
      expect(idb.pumpFailure).toBeInstanceOf(Error);
      expect(idb.driving).toBe(false);
      event("after");
      idb.pump();
      await turns();
      expect(world.pendingCount()).toBe(1);
      expect(() => idb.dispose()).toThrow("a delivery threw");
    });
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

describe("R32: a failed drain is reported whatever value it was rejected with", () => {
  for (const [label, reason] of rejections) {
    test(`rejected with ${label} before disposal: the first reason is kept, nothing is driven again, \`dispose\` reports it once`, async () => {
      const { world, idb, seen, event } = driven();
      world.schedule("misc", "A", {}, () => {
        throw reason;
      });
      idb.pump();
      await consuming(idb, async () => {
        await turns();
        expect(idb.pumpFailed).toBe(true);
        expect(Object.is(idb.pumpFailure, reason)).toBe(true);
        expect(idb.driving).toBe(false);
        // Neither new work (a wake), a direct `pump` nor a second failing delivery starts another drain or replaces the first reason.
        event("after");
        idb.pump();
        world.schedule("misc", "A", {}, () => {
          throw new Error("a later failure");
        });
        idb.pump();
        await turns();
        // The first reason first: a later failure can replace it only through a second drain, which the next checks forbid.
        expect(Object.is(idb.pumpFailure, reason)).toBe(true);
        expect(seen).toEqual([]);
        expect(world.pendingCount()).toBe(2);
        expect(idb.pumpStats).toEqual({ drains: 0, idleDrains: 0 });
        const first = attempt(() => idb.dispose());
        expect(first.failed).toBe(true);
        expect(Object.is(first.reason, reason)).toBe(true);
        expect(attempt(() => idb.dispose()).failed).toBe(false);
        expect((await settled(idb.disposeAndWait())).failed).toBe(false);
      });
    });

    test(`rejected with ${label} after disposal began: joined teardown reports it once`, async () => {
      const { world, idb } = driven();
      world.schedule("misc", "A", {}, () => {
        throw reason;
      });
      idb.pump();
      await consuming(idb, async () => {
        // A drain delivers nothing synchronously (it yields a turn first), so this disposal begins before the failure exists.
        expect(idb.pumpFailed).toBe(false);
        const joined = await settled(idb.disposeAndWait());
        expect(joined.failed).toBe(true);
        expect(Object.is(joined.reason, reason)).toBe(true);
        expect(idb.pumpFailed).toBe(true);
        expect(idb.driving).toBe(false);
        expect((await settled(idb.disposeAndWait())).failed).toBe(false);
        expect(attempt(() => idb.dispose()).failed).toBe(false);
      });
    });
  }

  test("a healthy drain in flight when teardown begins is joined and reports nothing", async () => {
    const { idb, seen, event } = driven();
    event("a");
    event("b");
    idb.pump();
    expect((await settled(idb.disposeAndWait())).failed).toBe(false);
    expect(seen).toEqual(["a", "b"]);
    expect(idb.pumpFailed).toBe(false);
  });

  test("ending a scope runs every ender newest first and rethrows exactly the first failure, null and undefined included", async () => {
    for (const [, reason] of rejections) {
      const ran: string[] = [];
      const scope = [
        () => {
          ran.push("oldest");
          throw new Error("an older failure");
        },
        () => {
          ran.push("middle");
        },
        async () => {
          ran.push("newest");
          throw reason;
        },
      ];
      const ended = await settled(endAll(scope));
      expect(ran).toEqual(["newest", "middle", "oldest"]);
      expect(ended.failed).toBe(true);
      expect(Object.is(ended.reason, reason)).toBe(true);
      expect(scope).toEqual([]);
    }
    expect((await settled(endAll([() => undefined]))).failed).toBe(false);
  });
});

/** Shared across the next two tests, in order: the first leaves a parked driver behind, the second sees it ended by the test setup. */
let leftBehind: FakeIdb | null = null;
let leftAfterFailure: FakeIdb | null = null;
let leftAfterTimeout: FakeIdb | null = null;
let lateNull: { idb: FakeIdb; ran: string[] } | null = null;

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

  test.fails("a test that TIMES OUT leaves a parked driver (this test is expected to fail, by its own short time limit)", async () => {
    const { idb, event } = driven();
    event("never due", "A", 60_000);
    idb.pump();
    await turns();
    leftAfterTimeout = idb;
    await new Promise<never>(() => undefined);
  }, 200);

  test("its driver was ended all the same: teardown runs for a timed-out test", () => {
    expect(leftAfterTimeout).not.toBeNull();
    expect(leftAfterTimeout?.driving).toBe(false);
  });

  test.fails("R32: a drain rejected with null DURING the test's teardown fails that test (this test is expected to fail, in its teardown alone)", () => {
    const ran: string[] = [];
    ownedByTest(() => {
      ran.push("older ender");
    });
    const { world, idb, event } = driven();
    event("never due", "A", 60_000);
    idb.pump();
    // Newer than the double, so teardown runs it first: the failing delivery only now becomes runnable, and wakes the parked driver.
    ownedByTest(() => {
      ran.push(`newer ender (failed: ${idb.pumpFailed})`);
      world.schedule("misc", "A", {}, () => {
        ran.push("failing delivery");
        throw null;
      });
    });
    lateNull = { idb, ran };
    // The body itself passes: only the teardown can make this test fail.
    expect(ran).toEqual([]);
  });

  test("its teardown joined the drain, reported the null once and still ran every other ender", async () => {
    expect(lateNull?.ran).toEqual([
      "newer ender (failed: false)",
      "failing delivery",
      "older ender",
    ]);
    expect(lateNull?.idb.pumpFailed).toBe(true);
    expect(lateNull?.idb.pumpFailure).toBeNull();
    expect(lateNull?.idb.driving).toBe(false);
    // Already reported (by that teardown): a second disposal is quiet.
    expect(
      (await settled(lateNull?.idb.disposeAndWait() as Promise<void>)).failed,
    ).toBe(false);
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

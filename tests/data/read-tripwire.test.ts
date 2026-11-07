// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readTripwire } from "../support/data/read-tripwire";
import { World } from "../support/session/world";

/**
 * R29 (revision 24): the bound the pacing cases of `outbox-claim-admission.test.ts` observe their queue reads with. Only a commit past the
 * bound is a violation, only of the plan it names, from wherever it is delivered; nothing is thrown into the world's log; a halted world
 * and a failing reaction are harness failures, not a violation; and a disposed observation counts nothing more.
 */
const LABEL = "data.readDispatchWindow";
const commit = (world: World, label = LABEL, type = "idb.commit"): void => {
  world.log({ type, label, page: null });
};
const commits = (world: World, n: number, label = LABEL): void => {
  for (let i = 0; i < n; i += 1) commit(world, label);
};

describe("R29: a read tripwire latches the first commit past its bound, and nothing else", () => {
  test("exactly the bound is not a violation; the next commit is, once, with its count, time and log position", () => {
    const world = new World();
    let calls = 0;
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 30,
      seed: 0,
      onViolation: () => {
        calls += 1;
      },
    });
    commits(world, 30);
    expect(wire.count).toBe(30);
    expect(wire.violation).toBeNull();
    expect(calls).toBe(0);
    world.time = 1_234;
    commit(world);
    expect(wire.violation).toEqual({
      count: 31,
      time: 1_234,
      seq: world.logs.length - 1,
    });
    expect(calls).toBe(1);
    commits(world, 5);
    expect(wire.count).toBe(36);
    expect(wire.violation?.count).toBe(31);
    expect(calls).toBe(1);
    expect(() => wire.check()).not.toThrow();
  });

  test("another plan's commits, another kind of entry and commits before the observation began (the seed) are counted as they should be", () => {
    const world = new World();
    commits(world, 4);
    const seed = world.logs.length;
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 30,
      seed,
      onViolation: () => undefined,
    });
    commits(world, 40, "data.markInFlight");
    for (let i = 0; i < 40; i += 1) commit(world, LABEL, "idb.committing");
    expect(wire.count).toBe(4);
    commits(world, 26);
    expect(wire.count).toBe(30);
    expect(wire.violation).toBeNull();
    commit(world);
    expect(wire.violation?.count).toBe(31);
  });

  test("a commit delivered by `advance` (a timer) trips it at the time it lands, and the reaction can end the work at once", async () => {
    const world = new World();
    let alive = true;
    const loop = (): void => {
      if (!alive) return;
      commit(world);
      world.schedule("timer", null, {}, loop, 100);
    };
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 30,
      seed: 0,
      onViolation: () => {
        alive = false;
      },
    });
    world.schedule("timer", null, {}, loop, 100);
    await world.runUntilIdle();
    expect(wire.count).toBe(0);
    await world.advance(10_000);
    expect(wire.violation).toEqual({
      count: 31,
      time: 3_100,
      seq: expect.any(Number),
    });
    expect(wire.count).toBe(31);
    expect(world.pendingCount()).toBe(0);
  });

  test("a commit delivered while the world runs until idle trips it there, and a hot loop ended by the reaction lets the world go idle", async () => {
    const world = new World();
    let alive = true;
    const loop = (): void => {
      if (!alive) return;
      commit(world);
      world.schedule("misc", null, {}, loop, 0);
    };
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 30,
      seed: 0,
      onViolation: () => {
        alive = false;
      },
    });
    world.schedule("misc", null, {}, loop, 0);
    await world.runUntilIdle();
    expect(wire.violation?.count).toBe(31);
    expect(wire.violation?.time).toBe(0);
    expect(wire.count).toBe(31);
  });

  test("a reaction that throws does not throw into the world's log: `check()` reports it as a plain error, not an assertion", () => {
    const world = new World();
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 1,
      seed: 0,
      onViolation: () => {
        throw new TypeError("boom");
      },
    });
    commit(world);
    expect(() => commit(world)).not.toThrow();
    expect(wire.violation?.count).toBe(2);
    let thrown: unknown;
    try {
      wire.check();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor).toBe(Error);
    expect((thrown as Error).message).toMatch(
      /onViolation failed: TypeError: boom/,
    );
  });

  test("a halted (livelocked) world is a harness failure: its quiet is not idle and it is no violation", () => {
    const world = new World();
    world.maxLogs = 10;
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 30,
      seed: 0,
      onViolation: () => undefined,
    });
    commits(world, 20);
    expect(world.livelocked).toBe(true);
    expect(wire.violation).toBeNull();
    expect(() => wire.check()).toThrow(/halted \(livelocked\)/);
  });

  test("a disposed observation counts nothing and calls nothing", () => {
    const world = new World();
    let calls = 0;
    const wire = readTripwire(world, {
      label: LABEL,
      limit: 1,
      seed: 0,
      onViolation: () => {
        calls += 1;
      },
    });
    commit(world);
    wire.dispose();
    commits(world, 5);
    expect(wire.count).toBe(1);
    expect(wire.violation).toBeNull();
    expect(calls).toBe(0);
  });
});

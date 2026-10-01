// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createWebLocksPort } from "../../../src/session/adapters/web-locks";
import { StoreError } from "../../../src/session/ports/store";
import { FakeHintBus } from "./hints";
import { FakeLockManager } from "./locks";
import { FakeAuthStore, SharedStore } from "./store";
import { World } from "./world";

/**
 * F-FID-*: the fakes implement each platform fact the specification relies on (plan WP0 exit criteria). A fake that
 * is more permissive than the platform would prove nothing.
 */
function locksWorld() {
  const world = new World();
  world.registerPage("p1");
  world.registerPage("p2");
  world.registerPage("p3");
  const manager = new FakeLockManager(world);
  const port = (page: string) => createWebLocksPort(manager.forPage(page));
  return { world, manager, port };
}

describe("F-FID locks", () => {
  test("first-in-first-out per name", async () => {
    const { world, port } = locksWorld();
    const order: string[] = [];
    const first = port("p1").acquire("L");
    const second = port("p2").acquire("L");
    const third = port("p3").acquire("L");
    void second.then((h) => {
      order.push("p2");
      h?.release();
    });
    void third.then((h) => {
      order.push("p3");
      h?.release();
    });
    (
      await (async () => {
        await world.runUntilIdle();
        return first;
      })()
    )?.release();
    order.unshift("p1");
    await world.runUntilIdle();
    expect(order).toEqual(["p1", "p2", "p3"]);
  });

  test("a grant follows the holder's release only after the release is PUBLISHED (D1)", async () => {
    const { world, port } = locksWorld();
    world.setKnob("D1", "unbounded");
    const a = port("p1");
    const b = port("p2");
    const holder = await (async () => {
      const p = a.acquire("L");
      await world.runUntilIdle();
      return p;
    })();
    expect(holder).not.toBeNull();
    let granted = false;
    void b.acquire("L").then(() => {
      granted = true;
    });
    await world.runUntilIdle();
    expect(granted).toBe(false);
    holder?.release();
    await world.runUntilIdle();
    expect(granted).toBe(false); // released, but the release is not yet published
    expect(world.heldCount("D1")).toBe(1);
    world.release("D1");
    await world.runUntilIdle();
    expect(granted).toBe(true);
  });

  test("ifAvailable is null while the lock is held and while its release is unpublished; true proves a release", async () => {
    const { world, port } = locksWorld();
    const holder = await (async () => {
      const p = port("p1").acquire("L");
      await world.runUntilIdle();
      return p;
    })();
    expect(
      await (async () => {
        const p = port("p2").probe("L");
        await world.runUntilIdle();
        return p;
      })(),
    ).toBe(false);
    world.setKnob("D1", "unbounded");
    holder?.release();
    await world.runUntilIdle();
    expect(
      await (async () => {
        const p = port("p2").probe("L");
        await world.runUntilIdle();
        return p;
      })(),
    ).toBe(false);
    world.release("D1");
    await world.runUntilIdle();
    expect(
      await (async () => {
        const p = port("p2").probe("L");
        await world.runUntilIdle();
        return p;
      })(),
    ).toBe(true);
  });

  test("an abort before the grant rejects with AbortError; after the grant it is ignored", async () => {
    const { world, port } = locksWorld();
    const held = await (async () => {
      const p = port("p1").acquire("L");
      await world.runUntilIdle();
      return p;
    })();
    const controller = new AbortController();
    const waiting = port("p2").acquire("L", { signal: controller.signal });
    await world.runUntilIdle();
    controller.abort();
    expect(await waiting).toBeNull();
    held?.release();
    await world.runUntilIdle();
    // After the grant the signal is ignored.
    const late = new AbortController();
    const granted = port("p3").acquire("L", { signal: late.signal });
    await world.runUntilIdle();
    const handle = await granted;
    late.abort();
    expect(handle).not.toBeNull();
    expect(
      world.logs.some((l) => l.type === "lock.aborted" && l.page === "p3"),
    ).toBe(false);
  });

  test("a destroyed page's locks are released by the platform, through the same publication delay", async () => {
    const { world, manager, port } = locksWorld();
    const held = await (async () => {
      const p = port("p1").acquire("L");
      await world.runUntilIdle();
      return p;
    })();
    expect(held).not.toBeNull();
    world.setKnob("D1", "unbounded");
    let granted = false;
    void port("p2")
      .acquire("L")
      .then(() => {
        granted = true;
      });
    await world.runUntilIdle();
    world.markDestroyed("p1");
    manager.destroyPage("p1");
    await world.runUntilIdle();
    expect(granted).toBe(false);
    world.release("D1");
    await world.runUntilIdle();
    expect(granted).toBe(true);
  });

  test("query() and steal throw and are logged, so any use fails a test", async () => {
    const { world, manager } = locksWorld();
    const locks = manager.forPage("p1");
    expect(() => locks.query()).toThrow();
    expect(() =>
      (
        locks as unknown as {
          request: (n: string, o: object, cb: () => void) => unknown;
        }
      ).request("L", { steal: true }, () => undefined),
    ).toThrow();
    expect(world.logs.map((l) => l.type)).toEqual(
      expect.arrayContaining(["spy.locks_query", "spy.locks_steal"]),
    );
  });

  test("the release of a callback that threw still frees the lock", async () => {
    const { world, manager } = locksWorld();
    const request = manager.forPage("p1").request("L", {}, () => {
      throw new Error("boom");
    });
    const failure = request.catch((error: Error) => error.message);
    await world.runUntilIdle();
    expect(await failure).toBe("boom");
    expect(manager.isFree("L")).toBe(true);
  });
});

function storeWorld() {
  const world = new World();
  for (const p of ["p1", "p2"]) world.registerPage(p);
  const shared = new SharedStore(world);
  return {
    world,
    shared,
    a: new FakeAuthStore(shared, "p1"),
    b: new FakeAuthStore(shared, "p2"),
  };
}
const setEpoch =
  (n: number) =>
  (
    records: Readonly<import("../../../src/session/model/types").AuthRecords>,
  ) => {
    const state = structuredClone(records.auth_state);
    state.latest_epoch = n;
    return { write: { auth_state: state }, result: n };
  };
const readEpoch = (
  records: Readonly<import("../../../src/session/model/types").AuthRecords>,
) => ({ write: null, result: records.auth_state.latest_epoch });

describe("F-FID IndexedDB double", () => {
  test("a transaction sees exactly the committed effects of every earlier-created one, whatever the page's completion delay", async () => {
    const { world, a, b } = storeWorld();
    world.setKnob("D0", "unbounded", (m) => m.page === "p1");
    const first = a.transact(setEpoch(7), { label: "w" });
    const second = b.transact(readEpoch, { label: "r" });
    await world.runUntilIdle();
    expect(await second.complete).toBe(7); // created after, runs after, sees the write although p1 never got its `complete`
    expect(world.heldCount("D0")).toBe(1);
    void first;
  });

  test("the body runs in a later task, never inside `transact` (the caller's continuation comes first)", async () => {
    const { world, a } = storeWorld();
    let ran = false;
    a.transact(
      (records) => {
        ran = true;
        return { write: null, result: records.auth_state.latest_epoch };
      },
      { label: "r" },
    );
    expect(ran).toBe(false);
    await world.runUntilIdle();
    expect(ran).toBe(true);
  });

  test("an abort reverts atomically and rejects with StoreError", async () => {
    const { world, shared, a } = storeWorld();
    shared.inject({ match: (tx) => tx.label === "w", mode: "abort" });
    const tx = a.transact(setEpoch(9), { label: "w" });
    await world.runUntilIdle();
    await expect(tx.complete).rejects.toBeInstanceOf(StoreError);
    expect(shared.records.auth_state.latest_epoch).toBe(0);
  });

  test("every body receives a structured clone: no page shares a live object", async () => {
    const { world, shared, a } = storeWorld();
    a.transact(
      (records) => {
        (records.auth_state as { latest_epoch: number }).latest_epoch = 99; // a rogue mutation of the argument
        return { write: null, result: 0 };
      },
      { label: "r" },
    );
    await world.runUntilIdle();
    expect(shared.records.auth_state.latest_epoch).toBe(0);
  });

  test("a stuck transaction blocks the ones behind it; a pending one does not", async () => {
    const { world, shared, a, b } = storeWorld();
    shared.inject({
      match: (tx) => tx.label === "stuck",
      mode: "pending_blocking",
      times: 1,
    });
    a.transact(setEpoch(1), { label: "stuck" });
    const behind = b.transact(readEpoch, { label: "r" });
    await world.runUntilIdle();
    let settled = false;
    void behind.complete.then(() => {
      settled = true;
    });
    await world.settle();
    expect(settled).toBe(false);
    const other = storeWorld();
    other.shared.inject({
      match: (tx) => tx.label === "lost",
      mode: "pending",
      times: 1,
    });
    other.a.transact(setEpoch(1), { label: "lost" });
    const proceeds = other.b.transact(readEpoch, { label: "r" });
    await other.world.runUntilIdle();
    expect(await proceeds.complete).toBe(0);
  });

  test("commit_then_lose_completion commits but never delivers", async () => {
    const { world, shared, a } = storeWorld();
    shared.inject({
      match: () => true,
      mode: "commit_then_lose_completion",
      times: 1,
    });
    let delivered = false;
    void a.transact(setEpoch(4), { label: "w" }).complete.then(() => {
      delivered = true;
    });
    await world.runUntilIdle();
    expect(shared.records.auth_state.latest_epoch).toBe(4);
    expect(delivered).toBe(false);
  });

  test("a transaction destroyed with its page can commit or abort, as the test decides", async () => {
    for (const pending of ["commit", "abort"] as const) {
      const { world, shared, a } = storeWorld();
      a.transact(setEpoch(5), { label: "w" });
      world.markDestroyed("p1");
      shared.destroyPage("p1", pending);
      await world.runUntilIdle();
      expect(shared.records.auth_state.latest_epoch).toBe(
        pending === "commit" ? 5 : 0,
      );
    }
  });

  test("invariant violations are recorded at the commit that caused them (P-F)", async () => {
    const { world, shared, a } = storeWorld();
    a.transact(
      (records) => {
        const state = structuredClone(records.auth_state);
        state.fence_seq = 0;
        state.fences = {
          A: [{ seq: 5, epoch: 0, obs_id: "x", kind: "drift", created_at: "" }],
        };
        return { write: { auth_state: state }, result: 0 };
      },
      { label: "bad" },
    );
    await world.runUntilIdle();
    expect(shared.violations.length).toBeGreaterThan(0);
  });
});

describe("F-FID hints and delay knobs", () => {
  test("a hint reaches every other live page per destination delay (D2), never the sender, never a frozen or destroyed page", async () => {
    const world = new World();
    for (const p of ["p1", "p2", "p3", "p4"]) world.registerPage(p);
    const bus = new FakeHintBus(world);
    const got: string[] = [];
    for (const p of ["p1", "p2", "p3", "p4"])
      bus.channelFor(p).subscribe(() => got.push(p));
    world.setKnob("D2", "unbounded", (m) => m.page === "p3");
    world.setFrozen("p4", true);
    bus.channelFor("p1").post({ type: "auth_state_changed" });
    await world.runUntilIdle();
    expect(got).toEqual(["p2"]);
    world.release("D2");
    await world.runUntilIdle();
    expect(got).toEqual(["p2", "p3"]);
  });

  test("every delay knob holds until released and then delivers in order; timers need `advance`", async () => {
    const world = new World();
    world.registerPage("p1");
    const seen: string[] = [];
    world.setKnob("D3", "unbounded");
    world.schedule("D3", "p1", {}, () => seen.push("act"));
    world.schedule("Da", "p1", {}, () => seen.push("answer"), 10);
    world.schedule("timer", "p1", {}, () => seen.push("timer"), 5000);
    await world.runUntilIdle();
    expect(seen).toEqual(["answer"]);
    world.release("D3");
    await world.runUntilIdle();
    expect(seen).toEqual(["answer", "act"]);
    await world.advance(5000);
    expect(seen).toEqual(["answer", "act", "timer"]);
  });

  test("a frozen page's deliveries wait; a destroyed page's are dropped", async () => {
    const world = new World();
    world.registerPage("p1");
    world.registerPage("p2");
    const seen: string[] = [];
    world.setFrozen("p1", true);
    world.schedule("misc", "p1", {}, () => seen.push("frozen"));
    world.schedule("misc", "p2", {}, () => seen.push("dead"));
    world.markDestroyed("p2");
    await world.runUntilIdle();
    expect(seen).toEqual([]);
    world.setFrozen("p1", false);
    await world.runUntilIdle();
    expect(seen).toEqual(["frozen"]);
  });
});

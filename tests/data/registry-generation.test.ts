// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createRegistry } from "../../src/data/store/registry";

/**
 * R37 (revision 21): the registry counts CLOSURES of an account, so an open that began before a closure can tell it from one that began
 * after it. The latch alone cannot: a deliberately authorised new open starts while the account is latched and lifts the latch when it
 * finishes, an earlier open that a closure ended finds the same latch value.
 *
 * `generation(account)` goes up on every `closeAll` and on every latch to something other than `open`, for that account alone; it never
 * goes down, and lifting a latch (`open`) is not a closure.
 */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("ConnectionRegistry.generation", () => {
  test("starts at the same number for every account, and a read changes nothing", () => {
    const registry = createRegistry("t");
    const first = registry.generation(A);
    expect(registry.generation(A)).toBe(first);
    expect(registry.generation(B)).toBe(first);
  });

  test("closeAll is a closure, whether or not any connection is registered, and whichever latch it names", () => {
    const registry = createRegistry("t");
    const start = registry.generation(A);
    registry.closeAll(A);
    expect(registry.generation(A)).toBeGreaterThan(start);
    const after = registry.generation(A);
    registry.closeAll(A, { latch: "closed_for_identity" });
    expect(registry.generation(A)).toBeGreaterThan(after);
    const again = registry.generation(A);
    registry.closeAll(A, { latch: "upgrade_pending" });
    expect(registry.generation(A)).toBeGreaterThan(again);
  });

  test("closeAll is a closure even when it names the latch `open` (it closes the connections and leaves the latch open)", () => {
    const registry = createRegistry("t");
    let closed = 0;
    registry.register(A, { close: () => (closed += 1) });
    const start = registry.generation(A);
    registry.closeAll(A, { latch: "open" });
    expect(closed).toBe(1);
    expect(registry.latch(A)).toBe("open");
    expect(registry.generation(A)).toBeGreaterThan(start);
  });

  test("a latch to anything but `open` is a closure, even when the latch has that value already; lifting a latch is not", () => {
    const registry = createRegistry("t");
    registry.setLatch(A, "closed_for_deletion");
    const latched = registry.generation(A);
    registry.setLatch(A, "closed_for_deletion");
    expect(registry.generation(A)).toBeGreaterThan(latched);
    const again = registry.generation(A);
    registry.setLatch(A, "open");
    expect(registry.generation(A)).toBe(again);
    expect(registry.latch(A)).toBe("open");
  });

  test("it is per account: closing A says nothing about B", () => {
    const registry = createRegistry("t");
    const b = registry.generation(B);
    registry.closeAll(A);
    registry.setLatch(A, "closed_for_identity");
    expect(registry.generation(B)).toBe(b);
  });

  test("registering and unregistering a connection is not a closure", () => {
    const registry = createRegistry("t");
    const start = registry.generation(A);
    const off = registry.register(A, { close: () => undefined });
    off();
    expect(registry.generation(A)).toBe(start);
  });

  test("a closure closes the registered connections, and the generation read inside a listener is already the new one", () => {
    const registry = createRegistry("t");
    let closed = 0;
    registry.register(A, { close: () => (closed += 1) });
    const before = registry.generation(A);
    let seen = -1;
    registry.onLatch((account) => {
      if (account === A) seen = registry.generation(A);
    });
    registry.closeAll(A);
    expect(closed).toBe(1);
    expect(registry.generation(A)).toBeGreaterThan(before);
    expect(seen).toBe(registry.generation(A));
  });
});

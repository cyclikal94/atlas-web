// @vitest-environment node
import { describe, expect, test } from "vitest";
import { commitPage } from "../../src/data/plans/commit-page";
import { recordReadOutcome } from "../../src/data/plans/retry-state";
import type { Identity, Store } from "../../src/session";
import { DataTestWorld } from "../support/data/env";

/**
 * G1 (plan 5.2.2): the database a commit lands in is chosen by the request's STAMPED account, never by whatever the page's identity
 * says at commit time. A service is bound to one account, and a request stamped with another is refused before any transaction is
 * created, and says it was G1 that refused it. FIXTURE evidence: the double of IndexedDB.
 */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get() {
    return this.value;
  }
  set(next: T) {
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

describe("G1: a service refuses a request stamped for another account, even when the page's identity is that other account", () => {
  test("the refusal is at G1, before any transaction is created, and nothing is written", async () => {
    const world = new DataTestWorld();
    world.idb.autoDrive = true;
    const page = world.page("A");
    page.identity.account = A;
    const identity = new Cell<Identity | null>({
      account_id: A,
      epoch: 1,
      session_id: "s",
    });
    const events: Array<[string, unknown]> = [];
    const runtime = new world.modules.accountService.DataRuntime({
      identity,
      persistence: world.modules.accountService.unorderedPersistence,
      registry: page.registry,
      open: (a, o) => page.open(a, o),
      trace: {
        emit: (event: string, data?: unknown) => events.push([event, data]),
      } as never,
    });
    const opened = await runtime.open(A, { create: true });
    if (opened.kind !== "opened") throw new Error("setup");
    const service = opened.service;
    await world.settle();
    const before = JSON.stringify(world.idb.snapshot(`atlas-${A}`));
    const transactions = () =>
      world.world.logs.filter((e) => e.type === "idb.commit").length;
    const created = transactions();
    // The stamped account is B. The identity is ALSO B, so G2's comparison would not object: only G1 can.
    page.identity.account = B;
    identity.set({ account_id: B, epoch: 1, session_id: "s2" });
    const foreign = { ...service.capture(1), account: B };
    const out = await service.commit(recordReadOutcome, {
      captured: foreign,
      caller: "sync",
      outcome: { kind: "failure" },
      now: 1,
    });
    expect(out).toEqual({ kind: "dropped", reason: "identity_changed" });
    expect(events.filter(([e]) => e === "data.commit_dropped")).toEqual([
      ["data.commit_dropped", { reason: "identity_changed", stage: "g1" }],
    ]);
    expect(transactions()).toBe(created);
    expect(JSON.stringify(world.idb.snapshot(`atlas-${A}`))).toBe(before);
    void commitPage;
  });
});

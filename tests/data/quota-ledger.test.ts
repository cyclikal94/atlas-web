// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createQuotaGuard,
  type QuotaReservation,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R7 (revision 6): every write that LANDS is accounted for, independently of the lifetime of the cached estimate.
 *
 * The first revision recorded a landed write's debit from the cached estimate at the moment of settlement, and settlement drops the
 * cache. Two reservations in flight at once therefore lost the second one's debit: the first to settle emptied the cache, and the
 * second had nothing to debit against, so a lagging estimate overstated the free space by that write. The guard now keeps a ledger of
 * the writes the estimate may not show yet (the free space judged before them, and the bytes of every one that has landed since),
 * and caps a re-read by it: `min(estimate, base - landed)`.
 *
 * FIXTURE evidence: the estimate is a stub that lags on purpose; the engine's own quota is not exercised.
 */
const MIB = 1024 * 1024;
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const FLOOR = RESERVE / 2;
const TTL = DATA_CONFIG.quotaEstimateTtlMs;

const guardOver = (state: { free: number }, now = { t: 0 }) =>
  createQuotaGuard({
    storage: { estimate: async () => ({ usage: 0, quota: state.free }) },
    now: () => now.t,
  });

/** Reservations are taken in order, then settled in `order` (indices), with the clock where it is. */
async function landed(
  guard: ReturnType<typeof createQuotaGuard>,
  sizes: readonly number[],
  order: readonly number[],
) {
  const held: QuotaReservation[] = [];
  for (const size of sizes) held.push(await guard.reserve("input", size));
  for (const at of order) (held[at] as QuotaReservation).settle("written");
  return held;
}

describe("the reviewer's schedule: a constant, lagging estimate", () => {
  test("two overlapping 1 MiB writes land, and the third is refused (6.5 MiB reported, 4.5 left, 3.5 would be left, below the 4 MiB floor)", async () => {
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state);
    const [a, b] = await landed(guard, [MIB, MIB], [0, 1]);
    expect(a?.verdict).toBe("ok");
    expect(b?.verdict).toBe("ok");
    expect(await guard.check("input", MIB)).toBe("refuse");
  });

  test("the control: sequential reservation and settlement refuse in the same place", async () => {
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state);
    (await guard.reserve("input", MIB)).settle("written");
    (await guard.reserve("input", MIB)).settle("written");
    expect(await guard.check("input", MIB)).toBe("refuse");
  });

  test("the order in which overlapping writes settle does not matter, whatever their number", async () => {
    // Room for exactly two 1 MiB writes above the floor, whatever the estimate says.
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [1, 2, 0],
    ]) {
      const state = { free: FLOOR + 2.5 * MIB };
      const guard = guardOver(state);
      const held = await landed(guard, [MIB, MIB, MIB], []);
      // Three were judged against the same figure; the third had the other two held, so it was refused at the door.
      expect(held.map((r) => r.verdict)).toEqual(["ok", "ok", "refuse"]);
      for (const at of order.filter((i) => i < 2))
        (held[at] as QuotaReservation).settle("written");
      expect(await guard.check("input", MIB), `order ${order}`).toBe("refuse");
    }
  });

  test("every landed write counts: n writes settle between reads, and the cap is the sum of all of them", async () => {
    const now = { t: 0 };
    const state = { free: FLOOR + 10 * MIB };
    const guard = guardOver(state, now);
    // Ten 0.5 MiB writes in flight at once (room for 20), all landing before the next read.
    const held: QuotaReservation[] = [];
    for (let i = 0; i < 10; i += 1)
      held.push(await guard.reserve("input", MIB / 2));
    for (const r of held) r.settle("written");
    // 5 MiB landed of 10 above the floor: 5 left; a 5.5 MiB write is refused, a 4.5 MiB one is not, though the estimate says 10.
    expect(await guard.check("input", 5.5 * MIB)).toBe("refuse");
    expect(await guard.check("input", 4.5 * MIB)).toBe("ok");
  });
});

describe("the estimate and the ledger", () => {
  test("an estimate that DOES show the writes is not counted twice (the cap is a minimum, not a sum)", async () => {
    const now = { t: 0 };
    const state = { free: FLOOR + 3 * MIB };
    const guard = guardOver(state, now);
    await landed(guard, [MIB, MIB], [0, 1]);
    // The browser has caught up: it now reports exactly the floor plus one MiB, which is what two 1 MiB writes leave.
    state.free = FLOOR + 1 * MIB;
    now.t = 1_000;
    // A third 1 MiB write would leave exactly the floor: admitted. Counting the two writes AGAIN on top would refuse it.
    expect(await guard.check("input", MIB)).toBe("ok");
    expect(await guard.check("input", MIB + 1)).toBe("refuse");
  });

  test("an invalidation while writes are outstanding drops the cache and nothing else: the ledger still holds, whichever settles after it", async () => {
    const now = { t: 0 };
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state, now);
    const a = await guard.reserve("input", MIB);
    const b = await guard.reserve("input", MIB);
    a.settle("written");
    // Another tab says it wrote (and the cache is dropped); the second write lands afterwards.
    guard.invalidate();
    b.settle("written");
    guard.invalidate();
    expect(await guard.check("input", MIB)).toBe("refuse");
  });

  test("a refresh between two reservations does not lose either: the second was judged on the capped figure, and lands on the same ledger", async () => {
    const now = { t: 0 };
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state, now);
    const a = await guard.reserve("input", MIB);
    a.settle("written");
    now.t = 100;
    const b = await guard.reserve("input", MIB);
    expect(b.verdict).toBe("ok");
    b.settle("written");
    expect(await guard.check("input", MIB)).toBe("refuse");
  });

  test("the ledger ends with the lifetime of the LATEST write: before it, the cap stands; after it, the browser's figure is trusted again", async () => {
    const now = { t: 0 };
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state, now);
    (await guard.reserve("input", MIB)).settle("written");
    now.t = TTL - 1_000;
    (await guard.reserve("input", MIB)).settle("written");
    // The first write's lifetime is over; the second's is not: both are still counted.
    now.t = TTL + 500;
    expect(await guard.check("input", MIB)).toBe("refuse");
    // The latest write's lifetime is over too, and the figure is read again (the cached one has been invalidated): the browser's
    // own figure is trusted.
    now.t = 2 * TTL - 1_000 + 1;
    guard.invalidate();
    expect(await guard.check("input", MIB)).toBe("ok");
  });

  test("a write judged before the ledger ended but landing after it starts a new one", async () => {
    const now = { t: 0 };
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state, now);
    const slow = await guard.reserve("input", MIB);
    now.t = 3 * TTL;
    slow.settle("written");
    expect(await guard.check("input", 2.6 * MIB)).toBe("refuse");
    expect(await guard.check("input", 1 * MIB)).toBe("ok");
  });

  test("a reservation that is NOT written adds nothing to the ledger, and a refused one holds nothing", async () => {
    const state = { free: 6.5 * MIB };
    const guard = guardOver(state);
    const a = await guard.reserve("input", MIB);
    const b = await guard.reserve("input", MIB);
    a.settle("not_written");
    b.settle("not_written");
    expect(await guard.check("input", 2.4 * MIB)).toBe("ok");
    expect((await guard.reserve("input", 3 * MIB)).verdict).toBe("refuse");
    expect(await guard.check("input", 2.4 * MIB)).toBe("ok");
  });

  test("with no estimate at all (unavailable) nothing can be capped and nothing throws", async () => {
    const guard = createQuotaGuard({ storage: undefined, now: () => 0 });
    const a = await guard.reserve("input", MIB);
    expect(a.verdict).toBe("unknown");
    a.settle("written");
    expect(await guard.check("input", MIB)).toBe("unknown");
  });
});

describe("two tabs over one origin", () => {
  test("another tab's landed write is seen by the next admission once the origin's estimate shows it (data_changed invalidates the cache)", async () => {
    const now = { t: 0 };
    const origin = { free: FLOOR + 2 * MIB };
    // One origin, one estimate, two guards: two tabs.
    const tab1 = guardOver(origin, now);
    const tab2 = guardOver(origin, now);
    expect(await tab2.check("input", MIB)).toBe("ok");
    (await tab1.reserve("input", MIB)).settle("written");
    // The estimate catches up with tab 1's write ...
    origin.free = FLOOR + 1 * MIB;
    // ... tab 2 trusts its five-second-old figure until it is told; told (`data_changed`), it reads again.
    expect(await tab2.check("input", MIB + 1)).toBe("ok");
    tab2.invalidate();
    expect(await tab2.check("input", MIB + 1)).toBe("refuse");
    expect(await tab2.check("input", MIB)).toBe("ok");
  });

  test("a tab with a write in flight keeps its own hold and ledger through the other tab's invalidations", async () => {
    const now = { t: 0 };
    const origin = { free: 6.5 * MIB };
    const tab = guardOver(origin, now);
    const first = await tab.reserve("input", MIB);
    tab.invalidate();
    const second = await tab.reserve("input", MIB);
    // The first is still held: the second was judged with it counted.
    expect(second.verdict).toBe("ok");
    tab.invalidate();
    first.settle("written");
    tab.invalidate();
    second.settle("written");
    tab.invalidate();
    expect(await tab.check("input", MIB)).toBe("refuse");
  });
});

describe("through the public facade: overlapping enqueues near the floor", () => {
  const create = (id: string, padding: number): EnqueueRequest => ({
    endpoint: "/commands",
    targets: [
      {
        resourceId: id,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    build: () => ({
      command: { kind: "create", id, pad: "x".repeat(padding) },
    }),
  });

  test("several large imports enqueued at once, the estimate never showing any of them: exactly the ones that fit are admitted, and the next is refused", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    // Room for two 1 MiB imports above the floor and not a third (each estimate also counts the command's envelope).
    w.freeBytes = FLOOR + 2.6 * MIB;
    w.quota.invalidate();
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map((i) => w.outbox.enqueue(create(`big-${i}`, MIB))),
    );
    expect(
      outcomes.map((o) => (o.kind === "queued" ? "queued" : o.reason)),
    ).toEqual(["queued", "queued", "quota", "quota"]);
    // And once they have all landed (the estimate still reports the old figure) a further one is still refused.
    expect(await w.outbox.enqueue(create("after", MIB))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect(w.drafts()).toHaveLength(2);
  });
});

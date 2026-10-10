// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { deriveNotices } from "../../src/data/model/status";
import { scopeOf } from "../support/data/marker-storage";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R5, drafts and receipts: a local IndexedDB write failure that stopped an operation (three failures, or a counter that could not
 * be written) is durable, operation-specific, restored on a cold start through the PUBLIC dispatcher and facade, kept through
 * unrelated wakes, and cleared by that operation's explicit recovery. FIXTURE evidence: no backend, fake time.
 */
const create = (id: string): EnqueueRequest => ({
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
    command: { kind: "create", id },
    displayPatch: { [id]: { label: id } },
  }),
});

async function started() {
  const w = await outboxWorld();
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  w.start();
  await w.settle();
  return w;
}
const queued = async (
  w: Awaited<ReturnType<typeof started>>,
  request: EnqueueRequest,
) => {
  const out = await w.outbox.enqueue(request);
  if (out.kind !== "queued") throw new Error(`enqueue: ${out.kind}`);
  await w.settle();
  return out.localId;
};
const failReceipts = (w: Awaited<ReturnType<typeof started>>, times = 3) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.admitReceipt",
    mode: "error",
    times,
  });

describe("R5: a draft's receipt write fails three times (dispatcher)", () => {
  test("the stop is restored after a reload: that draft is not resent, the rest of the queue goes on, and the state says so", async () => {
    const w = await started();
    failReceipts(w);
    const first = await queued(w, create("a"));
    await w.advance(5_000);
    expect(w.sync().local_write_streaks).toEqual({ [`receipt:${first}`]: 3 });
    const sentBefore = w.sent.length;

    // A reload: a new dispatcher and facade over the same database; every in-memory fact is lost.
    w.reload();
    w.start();
    await w.settle();
    expect(w.sent.length).toBe(sentBefore);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    // An unrelated wake, and coming online, change nothing.
    w.fire();
    w.goOnline();
    await w.settle();
    expect(w.sent.length).toBe(sentBefore);

    // Another draft is still sent and acknowledged.
    const second = await queued(w, create("b"));
    expect(w.sent.filter((s) => s.key === second)).toHaveLength(1);
    expect(w.sent.filter((s) => s.key === first)).toHaveLength(3);

    // "Try again" clears exactly that draft's operations, and the draft is sent again under the same key.
    w.dispatcher.retry(first);
    await w.settle();
    expect(w.sent.filter((s) => s.key === first)).toHaveLength(4);
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.dispatcher.state.get().kind).toBe("idle");
  });

  test("a failed counter write stops that draft AT ONCE, records a fallback marker, and a reload finds the marker", async () => {
    const w = await started();
    failReceipts(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    const id = await queued(w, create("a"));
    await w.advance(2_000);
    expect(w.markers.has(scopeOf(w.service.account), `receipt:${id}`)).toBe(
      true,
    );
    expect(w.sync().local_write_streaks).toEqual({});
    const sent = w.sent.length;

    w.reload();
    w.start();
    await w.settle();
    expect(w.sent.length).toBe(sent);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });

    w.dispatcher.retry();
    await w.settle();
    expect(w.markers.has(scopeOf(w.service.account), `receipt:${id}`)).toBe(
      false,
    );
    expect(w.sent.length).toBe(sent + 1);
    expect(w.drafts().find((d) => d.local_id === id)?.status).toBe(
      "acknowledged",
    );
  });

  test("when BOTH stores fail the stop is held in memory, says so, and a reload no longer knows it", async () => {
    const w = await started();
    failReceipts(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.markerStorage.failWrites = true;
    await queued(w, create("a"));
    await w.advance(2_000);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
    const notices = deriveNotices({
      online: true,
      engine: null,
      recovery: { registered: false, active: false },
      cache: "valid",
      lastSyncedAt: null,
      summary: null,
      outbox: w.dispatcher.state.get(),
      storageNotResponding: false,
    });
    expect(notices).toContainEqual({
      kind: "storage_not_responding",
      memoryOnly: true,
    });
    w.reload();
    w.start();
    await w.settle();
    expect(w.dispatcher.state.get().kind).not.toBe("stopped");
  });
});

describe("R5 (revision 6): a stop only this tab's memory holds lasts as long as the tab (dispatcher)", () => {
  const memoryOnlyStop = async () => {
    const w = await started();
    failReceipts(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.markerStorage.failWrites = true;
    const first = await queued(w, create("a"));
    await w.advance(2_000);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
    return { w, first, sent: w.sent.length };
  };

  test("a wake, coming online and a long wait do not resend it", async () => {
    const { w, sent } = await memoryOnlyStop();
    for (let i = 0; i < 3; i += 1) {
      w.fire();
      w.goOnline();
      await w.settle();
      await w.advance(60_000);
    }
    expect(w.sent.length).toBe(sent);
  });

  test("a stop and a start of the dispatcher (an ownership change in a tab that stays alive) is not a reload: the draft is still not resent, and the state still says memory-only", async () => {
    const { w, sent } = await memoryOnlyStop();
    w.dispatcher.stop();
    w.start();
    await w.settle();
    w.fire();
    await w.settle();
    await w.advance(60_000);
    expect(w.sent.length).toBe(sent);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
  });

  test("another draft is still sent, and its success does not lift the stopped draft's stop", async () => {
    const { w, first, sent } = await memoryOnlyStop();
    w.dispatcher.stop();
    w.start();
    await w.settle();
    const second = await queued(w, create("b"));
    expect(w.sent.filter((s) => s.key === second)).toHaveLength(1);
    w.fire();
    await w.advance(60_000);
    expect(w.sent.filter((s) => s.key === first)).toHaveLength(sent);
  });

  test("only that draft's explicit retry lifts it (after a restart too), and it is then sent under the same key", async () => {
    const { w, first, sent } = await memoryOnlyStop();
    w.dispatcher.stop();
    w.start();
    await w.settle();
    w.dispatcher.retry(first);
    await w.settle();
    expect(w.sent.length).toBe(sent + 1);
    expect(w.sent.at(-1)?.key).toBe(first);
    expect(w.drafts().find((d) => d.local_id === first)?.status).toBe(
      "acknowledged",
    );
    expect(w.dispatcher.state.get().kind).toBe("idle");
  });

  test("a RELOAD is what forgets it (the disclosed limitation): a new dispatcher over the same database has no record of it", async () => {
    const { w, sent } = await memoryOnlyStop();
    w.reload();
    w.start();
    await w.settle();
    await w.advance(5_000);
    expect(w.sent.length).toBeGreaterThan(sent);
  });
});

describe("R5: a draft's own save fails three times (facade)", () => {
  const failSaves = (w: Awaited<ReturnType<typeof started>>, times = 3) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.enqueueDraft",
      mode: "error",
      times,
    });

  test("three failed saves of one draft raise the flag; a reload restores it from the durable streak; Try again clears it", async () => {
    const w = await started();
    failSaves(w);
    const request = {
      ...create("a"),
      localId: "11111111-1111-4111-8111-111111111aaa",
    };
    for (let i = 0; i < 3; i += 1)
      expect(await w.outbox.enqueue(request)).toEqual({
        kind: "refused",
        reason: "storage",
      });
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(w.sync().local_write_streaks).toEqual({
      "draft:11111111-1111-4111-8111-111111111aaa": 3,
    });

    w.reload();
    await w.settle();
    // The flag is back without anything retrying the save.
    expect(w.outbox.storageNotResponding.get()).toBe(true);

    w.outbox.retry();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.sync().local_write_streaks).toEqual({});
  });

  test("a failed counter write raises the flag at once and a marker keeps it across a reload", async () => {
    const w = await started();
    failSaves(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    const request = {
      ...create("a"),
      localId: "11111111-1111-4111-8111-111111111bbb",
    };
    expect(await w.outbox.enqueue(request)).toEqual({
      kind: "refused",
      reason: "storage",
    });
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
    expect(
      w.markers.has(
        scopeOf(w.service.account),
        "draft:11111111-1111-4111-8111-111111111bbb",
      ),
    ).toBe(true);

    w.reload();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    w.outbox.retry();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
  });

  test("when neither store can record it the facade says memory-only", async () => {
    const w = await started();
    failSaves(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.markerStorage.failWrites = true;
    await w.outbox.enqueue({
      ...create("a"),
      localId: "11111111-1111-4111-8111-111111111ccc",
    });
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(w.outbox.storageMemoryOnly.get()).toBe(true);
    // A later success of the same save clears both.
    expect(
      (
        await w.outbox.enqueue({
          ...create("a"),
          localId: "11111111-1111-4111-8111-111111111ccc",
        })
      ).kind,
    ).toBe("queued");
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
  });
});

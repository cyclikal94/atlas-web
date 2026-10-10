// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  directoryKey,
  recordStop,
  retireStops,
  type SlotLocks,
  witnessStops,
} from "../../src/data/engine/write-failure-marker";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { CAPTURE_OPERATION } from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import {
  FakeMarkerStorage,
  markerKeys,
  markerStands,
  pageMarkers,
  scopeOf,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R58 (revision 34): a failure that is recorded stays recorded or recovered; nothing is published afterwards.
 *
 * The review of revision 33 showed that a failure whose slot had not arrived was held in the page's memory while it waited to be
 * published, that an entitled recovery (a successful edit, a retry, a discard) released the memory hold and never named the pending
 * publication, and that when the lock was delivered the old failure was written: the recovered operation was stopped again, and
 * after a reload the warning came back (after a discard, with an empty draft list). A service-liveness check does not help, because the
 * service is alive: it recovered.
 *
 * A failure never waits for a lock now: its key is written in the step that records it, so a recovery that follows names it (the
 * witness is of a key that stands) and ends it by its exact key, and what is delivered later is the LISTING of a key in a directory,
 * which is made only for a key that still stands. These cases hold the lock back (the acquisition is requested, and its delivery is
 * held, as the review's schedules did), recover the operation by every route that the review named plus the others of the design
 * assessment (Q-P1 to Q-P3), deliver the lock, and look at the warning, the draft list, the raw keys and a page that loads afterwards.
 *
 * FIXTURE evidence: the production facade, plans and dispatcher over the double of IndexedDB and of `localStorage`; native counterpart
 * with real Web Locks in three engines: E-O14 (`fixture.data-durable.spec.ts`).
 */
const A = "acct-1";
const OP = "draft:a";
const OTHER = "draft:b";

/** Locks whose acquisition is REQUESTED at once and whose DELIVERY is held until `deliver()` (the review's `delayed`). */
function held(storage: FakeMarkerStorage, name = "held") {
  const real = storage.lockWorld.page(name);
  let requested = 0;
  const waiting: Array<() => void> = [];
  const locks: SlotLocks = {
    tryAcquire: async (lock) => {
      requested += 1;
      const handle = await real.tryAcquire(lock);
      return new Promise((resolve) => {
        waiting.push(() => resolve(handle));
      });
    },
  };
  return {
    locks,
    requested: () => requested,
    deliver: async () => {
      // The request reaches the lock world a turn after it was made; the delivery follows it, and then the continuation runs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const resolve of waiting.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function markersWithHeldLocks(storage: FakeMarkerStorage, name = "held") {
  const lock = held(storage, name);
  const markers = createWriteFailureMarkers(storage, undefined, {
    id: () => name,
    locks: lock.locks,
    slotStart: () => 0,
  });
  return { markers, ...lock };
}

describe("the primitive: a recovered failure is not published when the lock is delivered (Q-P1, Q-P2)", () => {
  for (const ordering of [
    "delivered before the recovery",
    "delivered after the recovery",
  ] as const)
    test(`${ordering}: nothing stands, nothing is listed, and a page that loads afterwards finds nothing`, async () => {
      const storage = new FakeMarkerStorage();
      const scope = scopeOf(A);
      const { markers, deliver, requested } = markersWithHeldLocks(storage);
      const memory: string[] = [];
      expect(
        recordStop(markers, scope, OP, () => true, {
          hold: () => {
            memory.push("hold");
          },
        }),
      ).toBe("marker");
      // The acquisition was requested (the lock is being waited for) and the failure does not depend on it.
      expect(requested()).toBe(1);
      expect(markerStands(storage, A, OP)).toBe(true);
      expect(memory).toEqual([]);
      if (ordering === "delivered before the recovery") await deliver();
      const witness = witnessStops(markers, markers.stops, scope, [OP]);
      expect(witness.stood.get(OP)?.marker.kind).toBe("instance");
      retireStops(markers, markers.stops, witness);
      expect(markerStands(storage, A, OP)).toBe(false);
      if (ordering === "delivered after the recovery") await deliver();
      await markers.prepare();
      expect(markerStands(storage, A, OP)).toBe(false);
      expect(markers.probe(scope, OP)).toBe("unmarked");
      const reloaded = pageMarkers(storage, { events: false });
      expect(reloaded.probe(scope, OP)).toBe("unmarked");
      expect(reloaded.inspect(scope)).toEqual({ operations: [], known: true });
      // A listing that was made BEFORE the recovery keeps its entry for a key that is gone (it ends nothing, and the next write of the
      // directory drops it); a listing that would be made AFTER the recovery is never made, because the key does not stand.
      if (ordering === "delivered after the recovery")
        for (const [key, value] of storage.items)
          if (key.startsWith("atlas-write-dir:"))
            expect(value).not.toContain(OP);
      markers.release();
    });

  test("two failures of one operation, a witness, a third failure, a recovery, then the delivery: exactly the witnessed pair ends and the third stands (Q-P2)", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const { markers, deliver } = markersWithHeldLocks(storage);
    const hold = { hold: () => undefined };
    expect(recordStop(markers, scope, OP, () => true, hold)).toBe("marker");
    expect(recordStop(markers, scope, OP, () => true, hold)).toBe("marker");
    const witness = witnessStops(markers, markers.stops, scope, [OP]);
    // The page's own earlier instance of the operation is replaced by the next (one marker per operation for a page that keeps failing).
    expect(markerKeys(storage, A, OP)).toHaveLength(1);
    const third = recordStop(markers, scope, OP, () => true, hold);
    expect(third).toBe("marker");
    expect(markerKeys(storage, A, OP)).toHaveLength(1);
    retireStops(markers, markers.stops, witness);
    // The third failure is NEWER than the act: the witness names the instance that stood when the act began and nothing else.
    expect(markers.probe(scope, OP)).toBe("marked");
    await deliver();
    await markers.prepare();
    expect(markers.probe(scope, OP)).toBe("marked");
    expect(pageMarkers(storage, { events: false }).probe(scope, OP)).toBe(
      "marked",
    );
    markers.release();
  });

  test("a recovery of one operation never reaches the pending listing of another", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const { markers, deliver } = markersWithHeldLocks(storage);
    const hold = { hold: () => undefined };
    recordStop(markers, scope, OP, () => true, hold);
    recordStop(markers, scope, OTHER, () => true, hold);
    retireStops(
      markers,
      markers.stops,
      witnessStops(markers, markers.stops, scope, [OP]),
    );
    await deliver();
    await markers.prepare();
    const listed = JSON.parse(
      storage.items.get(directoryKey(scope, 0)) as string,
    ) as { e: Array<[string, string]> };
    expect(listed.e.map(([operation]) => operation)).toEqual([OTHER]);
    expect(markers.probe(scope, OTHER)).toBe("marked");
    expect(markers.probe(scope, OP)).toBe("unmarked");
    markers.release();
  });

  test("a failure that ANOTHER page ended before the slot arrived is not listed when it does (a late listing brings nothing back, not even an entry)", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const { markers, deliver } = markersWithHeldLocks(storage);
    expect(markers.set(scope, OP).state).toBe("recorded");
    expect(markers.set(scope, OTHER).state).toBe("recorded");
    // A page that read the failure ends it by its exact key (this page's memory of it is not told).
    const recoverer = pageMarkers(storage.page("recoverer"), { events: false });
    expect(
      recoverer.retire(scope, OP, recoverer.witness(scope, OP), {
        explicit: true,
      }),
    ).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
    await deliver();
    await markers.prepare();
    const listed = JSON.parse(
      storage.items.get(directoryKey(scope, 0)) as string,
    ) as { e: Array<[string, string]> };
    expect(listed.e.map(([operation]) => operation)).toEqual([OTHER]);
    markers.release();
  });

  test("a failure whose service ends before the lock arrives is durable all the same (the invalidator that is disposed at once): the key was written while the lifetime lived", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const { markers, deliver } = markersWithHeldLocks(storage);
    let alive = true;
    expect(
      recordStop(markers, scope, OP, () => alive, { hold: () => undefined }),
    ).toBe("marker");
    alive = false; // the service is disposed right away: nothing of it is live when the lock is delivered
    markers.release();
    await deliver();
    const follower = pageMarkers(storage, { events: false });
    expect(follower.probe(scope, OP)).toBe("marked");
    expect(follower.inspect(scope)).toEqual({ operations: [OP], known: true });
  });

  test("a lock delivered after `release` is let go, and lists nothing", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const { markers, deliver } = markersWithHeldLocks(storage);
    markers.set(scope, OP);
    markers.release();
    await deliver();
    expect(storage.lockWorld.held.size).toBe(0);
    expect(storage.items.has(directoryKey(scope, 0))).toBe(false);
    expect(markerStands(storage, A, OP)).toBe(true);
  });
});

// ---- the production facade ------------------------------------------------------------------------------------------------------
const request = (label: string, localId = "a"): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: "r",
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id: "r",
      label,
      expected_version: bases.r as number,
    },
  }),
});

async function facadeWorld() {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  const lock = markersWithHeldLocks(w.markerStorage, "facade");
  w.reload({ markers: lock.markers });
  return { w, ...lock };
}
const finish = (w: OutboxWorld, markers: { release(): void }): void => {
  markers.release();
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const faultCounter = (w: OutboxWorld, label: string) => {
  for (const plan of [label, "data.recordLocalWriteOutcome"])
    w.env.idb.inject({
      match: (tx) => tx.label === plan,
      mode: "error",
      times: 1,
    });
};

describe("the facade: edit, retry, discard, enqueue and supersede recover a failure that waits for its lock (the review's schedules)", () => {
  type Recovery = "edit" | "retry" | "discard";
  for (const recovery of ["edit", "retry", "discard"] as const)
    for (const delivered of ["before", "after"] as const)
      test(`${recovery}, lock delivered ${delivered} the recovery: the warning stays down, after a reload too`, async () => {
        const { w, markers, deliver, requested } = await facadeWorld();
        try {
          expect((await w.outbox.enqueue(request("saved"))).kind).toBe(
            "queued",
          );
          await w.settle();
          faultCounter(w, "data.editQueuedDraft");
          expect(await w.outbox.editQueued("a", request("failed"))).toEqual({
            kind: "refused",
            reason: "storage",
          });
          await w.settle();
          expect(w.outbox.storageNotResponding.get()).toBe(true);
          expect(requested()).toBe(1);
          // The failure is durable at once: its key stands before any lock arrives (the review's finding is the opposite).
          expect(
            markerStands(w.markerStorage, w.service.account, "draft:a"),
          ).toBe(true);
          if (delivered === "before") {
            await deliver();
            await markers.prepare();
            await w.settle();
          }
          await (async (r: Recovery) => {
            if (r === "edit")
              expect((await w.outbox.editQueued("a", request("ok"))).kind).toBe(
                "edited",
              );
            else if (r === "discard")
              expect((await w.outbox.discard("a")).kind).toBe("discarded");
            else await w.outbox.retry("a");
          })(recovery);
          await w.settle();
          expect(w.outbox.storageNotResponding.get()).toBe(false);
          if (delivered === "after") {
            await deliver();
            await markers.prepare();
            await w.settle();
          }
          expect(w.outbox.storageNotResponding.get()).toBe(false);
          expect(
            markerStands(w.markerStorage, w.service.account, "draft:a"),
          ).toBe(false);
          // A page that loads afterwards (a new facade over the same storage) finds it recovered.
          w.reload();
          await w.settle();
          expect(w.outbox.storageNotResponding.get()).toBe(false);
          expect(w.markers.probe(w.service, "draft:a")).toBe("unmarked");
          if (recovery === "discard") expect(w.drafts()).toEqual([]);
        } finally {
          finish(w, markers);
        }
      });

  test("control: a failure that is NOT recovered still stands after the lock arrives, and after a reload", async () => {
    const { w, markers, deliver } = await facadeWorld();
    try {
      await w.outbox.enqueue(request("saved"));
      await w.settle();
      faultCounter(w, "data.editQueuedDraft");
      await w.outbox.editQueued("a", request("failed"));
      await w.settle();
      await deliver();
      await markers.prepare();
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      w.reload();
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(w.markers.probe(w.service, "draft:a")).toBe("marked");
    } finally {
      finish(w, markers);
    }
  });

  test("a retry that FAILS to lift anything recovers nothing: the failure stands whatever the lock does", async () => {
    const { w, markers, deliver } = await facadeWorld();
    try {
      await w.outbox.enqueue(request("saved"));
      await w.settle();
      faultCounter(w, "data.editQueuedDraft");
      await w.outbox.editQueued("a", request("failed"));
      await w.settle();
      // The retry's own removal of the marker is refused: no recovery.
      const removeItem = w.markerStorage.removeItem.bind(w.markerStorage);
      w.markerStorage.removeItem = () => {
        throw new DOMException("refused", "SecurityError");
      };
      await w.outbox.retry("a");
      await w.settle();
      w.markerStorage.removeItem = removeItem;
      await deliver();
      await markers.prepare();
      await w.settle();
      expect(w.markers.probe(w.service, "draft:a")).not.toBe("unmarked");
    } finally {
      finish(w, markers);
    }
  });

  test("a NEWER failure recorded after the recovery is not reached by the delivery", async () => {
    const { w, markers, deliver } = await facadeWorld();
    try {
      await w.outbox.enqueue(request("saved"));
      await w.settle();
      faultCounter(w, "data.editQueuedDraft");
      await w.outbox.editQueued("a", request("failed"));
      await w.settle();
      expect((await w.outbox.editQueued("a", request("ok"))).kind).toBe(
        "edited",
      );
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      faultCounter(w, "data.editQueuedDraft");
      await w.outbox.editQueued("a", request("failed again"));
      await w.settle();
      await deliver();
      await markers.prepare();
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(w.markers.probe(w.service, "draft:a")).toBe("marked");
    } finally {
      finish(w, markers);
    }
  });
});

// ---- the dispatcher (Q-P3) --------------------------------------------------------------------------------------------------------
describe("the dispatcher: a queue stop that waits for its lock ends with the read that lands, and is not published afterwards", () => {
  for (const delivered of ["before", "after"] as const)
    test(`the lock delivered ${delivered} the next read: no stop returns after a reload`, async () => {
      const w = await outboxWorld();
      const lock = markersWithHeldLocks(w.markerStorage, "dispatcher");
      w.reload({ markers: lock.markers });
      try {
        for (const label of [
          "data.readDispatchWindow",
          "data.recordLocalWriteOutcome",
        ])
          w.env.idb.inject({
            match: (tx) => tx.label === label,
            mode: "error",
            times: 1,
          });
        w.start();
        await w.settle();
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "local_storage",
        });
        expect(markerStands(w.markerStorage, w.service.account, "queue")).toBe(
          true,
        );
        expect(lock.requested()).toBeGreaterThanOrEqual(1);
        if (delivered === "before") {
          await lock.deliver();
          await lock.markers.prepare();
        }
        w.fire();
        await w.settle();
        expect(w.dispatcher.state.get().kind).toBe("idle");
        expect(markerStands(w.markerStorage, w.service.account, "queue")).toBe(
          false,
        );
        if (delivered === "after") {
          await lock.deliver();
          await lock.markers.prepare();
        }
        expect(markerStands(w.markerStorage, w.service.account, "queue")).toBe(
          false,
        );
        w.reload();
        w.start();
        await w.settle();
        expect(w.markers.probe(w.service, "queue")).toBe("unmarked");
        expect(w.dispatcher.state.get().kind).toBe("idle");
      } finally {
        finish(w, lock.markers);
      }
    });

  test("a draft stopped by the dispatcher's own failure to claim it is sent once after the person's retry, whatever the lock does", async () => {
    const w = await outboxWorld();
    const lock = markersWithHeldLocks(w.markerStorage, "dispatcher");
    w.reload({ markers: lock.markers });
    try {
      w.online = false;
      w.put("cache", [cacheRow({ id: "r", version: 5 })]);
      expect((await w.outbox.enqueue(request("saved"))).kind).toBe("queued");
      await w.settle();
      for (const label of ["data.markInFlight", "data.recordLocalWriteOutcome"])
        w.env.idb.inject({
          match: (tx) => tx.label === label,
          mode: "error",
          times: 1,
        });
      w.online = true;
      w.start();
      await w.settle();
      expect(w.sent).toHaveLength(0);
      expect(markerStands(w.markerStorage, w.service.account, "draft:a")).toBe(
        true,
      );
      await w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((sent) => sent.key)).toEqual(["a"]);
      await lock.deliver();
      await lock.markers.prepare();
      expect(markerStands(w.markerStorage, w.service.account, "draft:a")).toBe(
        false,
      );
      expect(w.sent).toHaveLength(1);
    } finally {
      finish(w, lock.markers);
    }
  });
});

// ---- the sync engine (Q-P4) -------------------------------------------------------------------------------------------------------
describe("the sync engine: a capture stop that waits for its lock is lifted by the person's retry, and the lock arriving later brings nothing back", () => {
  async function stopped(delivered: "before" | "after" | "never") {
    const w = await engineWorld({ cursor: "cursor-0" });
    const lock = markersWithHeldLocks(w.markerStorage, "engine");
    w.reload({ markers: lock.markers });
    for (const label of ["data.captureRequest", "data.recordLocalWriteOutcome"])
      w.env.idb.inject({
        match: (tx) => tx.label === label,
        mode: "error",
        times: 1,
      });
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(
      markerStands(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toBe(true);
    expect(w.requests).toHaveLength(0);
    if (delivered === "before") {
      await lock.deliver();
      await lock.markers.prepare();
    }
    return { w, lock };
  }

  for (const delivered of ["before", "after"] as const)
    test(`retry, the lock delivered ${delivered} it: the request goes, and after a reload nothing stops the engine`, async () => {
      const { w, lock } = await stopped(delivered);
      try {
        w.engine.retryNow();
        await w.settle();
        await w.advance(10_000);
        expect(w.requests.length).toBeGreaterThanOrEqual(1);
        expect(
          markerStands(w.markerStorage, w.service.account, CAPTURE_OPERATION),
        ).toBe(false);
        if (delivered === "after") {
          await lock.deliver();
          await lock.markers.prepare();
        }
        expect(
          markerStands(w.markerStorage, w.service.account, CAPTURE_OPERATION),
        ).toBe(false);
        const before = w.requests.length;
        w.engine.stop();
        w.reload({ markers: "fresh" });
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.requests.length).toBeGreaterThan(before);
        expect(w.state().kind).not.toBe("stopped");
        w.engine.stop();
      } finally {
        lock.markers.release();
      }
    });

  test("R57 (the invalidator): the engine records its stop, its service is disposed at once, and the lock arrives after: a page that loads afterwards finds the marker", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    const lock = markersWithHeldLocks(w.markerStorage, "invalidator");
    w.reload({ markers: lock.markers });
    try {
      for (const label of [
        "data.captureRequest",
        "data.recordLocalWriteOutcome",
      ])
        w.env.idb.inject({
          match: (tx) => tx.label === label,
          mode: "error",
          times: 1,
        });
      w.start();
      await w.settle();
      expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
      // The lock has been asked for and is not delivered: a publication that waited for it would have nothing to publish after this.
      expect(lock.requested()).toBeGreaterThanOrEqual(1);
      w.engine.stop();
      w.service.dispose("closed");
      lock.markers.release();
      await lock.deliver();
      const follower = pageMarkers(w.markerStorage, { events: false });
      expect(
        follower.probe(scopeOf(w.service.account), CAPTURE_OPERATION),
      ).toBe("marked");
      expect(follower.inspect(scopeOf(w.service.account))).toEqual({
        operations: [CAPTURE_OPERATION],
        known: true,
      });
    } finally {
      lock.markers.release();
    }
  });

  test("control: with no retry the stop stands after the lock arrives, and after a reload nothing is requested", async () => {
    const { w, lock } = await stopped("never");
    try {
      await lock.deliver();
      await lock.markers.prepare();
      await w.advance(10_000);
      expect(w.requests).toHaveLength(0);
      w.engine.stop();
      w.reload({ markers: "fresh" });
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
      w.engine.stop();
    } finally {
      lock.markers.release();
    }
  });

  test("an invalidation whose write waits behind a quota stop keeps its marker through a retry that cannot write, and the delivery changes nothing", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
    const lock = markersWithHeldLocks(w.markerStorage, "engine");
    w.reload({ markers: lock.markers });
    try {
      w.env.idb.inject({
        match: (tx) => tx.label === "data.invalidateCache",
        mode: "quota",
        times: 100,
      });
      w.script.push(w.status(410, { body: { code: "resync_required" } }));
      w.start();
      await w.settle();
      const invalidation = `invalidate:cursor-0`;
      expect(
        markerStands(w.markerStorage, w.service.account, invalidation),
      ).toBe(true);
      w.engine.retryNow();
      await w.settle();
      await w.advance(10_000);
      // A retry is not evidence that the cache has become valid: the marker that hides it stands while the write cannot land.
      expect(
        markerStands(w.markerStorage, w.service.account, invalidation),
      ).toBe(true);
      await lock.deliver();
      await lock.markers.prepare();
      expect(
        markerStands(w.markerStorage, w.service.account, invalidation),
      ).toBe(true);
      w.engine.stop();
    } finally {
      lock.markers.release();
    }
  });
});

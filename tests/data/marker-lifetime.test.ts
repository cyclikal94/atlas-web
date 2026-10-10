// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  DIRECTORY_PREFIX,
  directoryKey,
  MARKER_PREFIX,
  recordStop,
} from "../../src/data/engine/write-failure-marker";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import {
  CAPTURE_OPERATION,
  READ_RETRY_OPERATION,
} from "../../src/data/plans/sync-writers";
import { createAccountDatabasePort } from "../../src/data/ports/account-database";
import { engineWorld } from "../support/data/engine-world";
import {
  FakeMarkerStorage,
  markerKeys,
  markerStands,
  pageMarkers,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R56 (revision 33): a callback that outlives its service records NOTHING, and what an obsolete writer could still write belongs to its own
 * lifetime and to no other.
 *
 * The independent review of revision 32 failed the operation and its counter transaction, held the delivery of the counter's rejection,
 * closed the service through the production account-database port, deleted the database and cleared the markers, created a new incarnation
 * and then delivered the old rejection: the writer recorded the old operation's fallback marker under a key that named the account and
 * not the database's lifetime, so a fresh reader of the REPLACEMENT database saw it marked (the facade restored an obsolete warning, and
 * reused logical operations such as `capture` and `queue` stopped the replacement). The same shape was reached from the sync engine's
 * capture, the facade's edit and the dispatcher's read of the queue.
 *
 * Two layers, each sufficient for the replacement and neither relied on alone. (1) Every writer asks whether its service still lives
 * AFTER the awaited counter and immediately before the write (`recordStop`), and records nothing, holds nothing in memory and shows
 * nothing when it does not. (2) Every key names the lifetime, so a page whose notice of the deletion is late, or a callback that could not
 * be stopped, can only write the keys of its own, dead, lifetime, which no reader of the replacement consults; and cleaning an account
 * up after its deletion is housekeeping that no answer depends on.
 *
 * FIXTURE evidence: the production facade, dispatcher, engine and plans over the double of IndexedDB and of `localStorage`, with the
 * counter's rejection held exactly as the review held it (`delayResult`: the plan has run and FAILED; only its answer is late). The
 * native counterpart over Dexie, IndexedDB and `localStorage` in three engines is E-O12 (`fixture.data-lifetime.spec.ts`).
 */
const ACCOUNT_NEXT = "incarnation-2";

const request = (localId: string, label = localId): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: `r-${localId}`,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id: `r-${localId}`,
      label,
      expected_version: bases[`r-${localId}`] as number,
    },
  }),
});

/** The outbox world with the cache the drafts target, the page offline (the dispatcher is started when a test wants it). */
async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r-a", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
  ]);
  return w;
}

/** Every key of the fallback store, by an oracle that does not read through the markers: markers and directories alike. */
const stored = (storage: FakeMarkerStorage): string[] =>
  [...storage.items.keys()]
    .filter(
      (key) =>
        key.startsWith(MARKER_PREFIX) || key.startsWith(DIRECTORY_PREFIX),
    )
    .sort();

/** The plan runs at once; its answer (a rejection when the plan failed) is delivered when released. */
function delayResult(
  store: { run: unknown },
  name: string,
): { release(): void; held(): boolean } {
  const real = (store.run as (...args: unknown[]) => Promise<unknown>).bind(
    store,
  );
  let armed = true;
  let isHeld = false;
  let release: () => void = () => undefined;
  store.run = (plan: { name: string }, input: unknown, options: unknown) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== name) return answer;
    armed = false;
    isHeld = true;
    // The plan may have FAILED already; its rejection is delivered on release and must not be reported as unhandled before then.
    answer.catch(() => undefined);
    return new Promise<unknown>((resolve, reject) => {
      release = () => {
        isHeld = false;
        void answer.then(resolve, reject);
      };
    });
  };
  return { release: () => release(), held: () => isHeld };
}

describe("the module: a writer whose lifetime ended records nothing", () => {
  test("`set` with a `live` that says no writes neither a directory nor a key, and says the failure is obsolete (not unavailable)", () => {
    const storage = new FakeMarkerStorage();
    const markers = pageMarkers(storage);
    const published = markers.set(scopeOf("a"), "draft:x", () => false);
    expect(published.state).toBe("obsolete");
    expect(stored(storage)).toEqual([]);
    expect(markers.probe(scopeOf("a"), "draft:x")).toBe("unmarked");
  });

  // ADAPTED, revision 34 (R58). Revision 33 waited for the slot before it wrote, so a lifetime that ended meanwhile was checked again
  // after the wait ("a lifetime that ends while the slot is being taken writes nothing"). A failure never waits for a lock now: the last
  // look at the lifetime is in the step of the first write, and there is no later step. The old intent (an ended lifetime creates no
  // fallback state) is kept for the lifetime that ended BEFORE the call (the first case), and the slot that arrives after the lifetime
  // ended is shown to create nothing but the entry of a key that was written while the lifetime lived.
  test("the last look is in the SAME step as the write: a lifetime that has ended writes nothing, and one that ends after the write has nothing more written for it than the listing of its key", async () => {
    const storage = new FakeMarkerStorage();
    const locks = storage.lockWorld.page("late");
    const markers = createWriteFailureMarkers(storage, undefined, {
      id: () => "late",
      locks,
      slotStart: () => 0,
    });
    let alive = false;
    const ended = markers.set(scopeOf("a"), "draft:x", () => alive);
    expect(ended.state).toBe("obsolete");
    expect(stored(storage)).toEqual([]);
    alive = true;
    const published = markers.set(scopeOf("a"), "draft:y", () => alive);
    expect(published.state).toBe("recorded");
    const key = stored(storage);
    expect(key).toHaveLength(1);
    alive = false;
    // The slot arrives after the lifetime ended: it lists the key that was written while the lifetime lived, and writes nothing else.
    await markers.prepare();
    expect(stored(storage).filter((k) => k.startsWith(MARKER_PREFIX))).toEqual(
      key,
    );
    expect(stored(storage).filter((k) => !k.startsWith(MARKER_PREFIX))).toEqual(
      [directoryKey(scopeOf("a"), 0)],
    );
  });

  test("`recordStop` takes no hold for an obsolete failure, holds one for an unavailable store, and takes none when the marker is recorded, whether or not the page holds a slot (adapted, revision 34)", async () => {
    const storage = new FakeMarkerStorage();
    const holds: string[] = [];
    const memory = (name: string) => ({
      hold: () => {
        holds.push(`hold:${name}`);
      },
    });
    const scope = scopeOf("a");
    expect(
      recordStop(
        pageMarkers(storage),
        scope,
        "draft:x",
        () => false,
        memory("obsolete"),
      ),
    ).toBe("obsolete");
    expect(holds).toEqual([]);
    // A store that cannot be written: held in memory, and never released.
    storage.failWrites = true;
    expect(
      recordStop(
        pageMarkers(storage),
        scope,
        "draft:x",
        () => true,
        memory("unavailable"),
      ),
    ).toBe("memory");
    storage.failWrites = false;
    expect(holds).toEqual(["hold:unavailable"]);
    // ADAPTED: a slot still being taken used to hold the stop in memory until the marker was durable (R56) and then release exactly that
    // hold. The marker is durable in the step that records it: no hold is taken, so none can be released late.
    holds.length = 0;
    const late = createWriteFailureMarkers(storage, undefined, {
      id: () => "late",
      locks: storage.lockWorld.page("late"),
      slotStart: () => 0,
    });
    expect(
      recordStop(late, scope, "draft:y", () => true, memory("no-slot-yet")),
    ).toBe("marker");
    expect(markerStands(storage, "a", "draft:y")).toBe(true);
    await late.prepare();
    expect(holds).toEqual([]);
    // A page that can take no slot at all records the marker too.
    const none = createWriteFailureMarkers(storage, undefined, { locks: null });
    expect(
      recordStop(none, scope, "draft:z", () => true, memory("no-slot")),
    ).toBe("marker");
    expect(markerStands(storage, "a", "draft:z")).toBe(true);
    expect(holds).toEqual([]);
  });

  test("another lifetime's keys are not this lifetime's: an obsolete writer that cannot be stopped writes only its own, dead, lifetime", () => {
    const storage = new FakeMarkerStorage();
    const old = scopeOf("a", "incarnation-1");
    const next = scopeOf("a", ACCOUNT_NEXT);
    const reader = pageMarkers(storage, { events: false });
    // The old lifetime's page was not told in time and publishes after the new lifetime began.
    const late = pageMarkers(storage.page("late"));
    expect(late.set(old, "capture").state).toBe("recorded");
    expect(reader.probe(next, "capture")).toBe("unmarked");
    expect(reader.inspect(next)).toEqual({ operations: [], known: true });
    expect(reader.witness(next, "capture")).toEqual({ kind: "none" });
    expect(reader.probe(old, "capture")).toBe("marked");
    expect(markerStands(storage, next, "capture")).toBe(false);
  });

  test("cleaning up a deleted account removes every lifetime's keys and directories and the page's memory of them; another account is untouched", () => {
    const storage = new FakeMarkerStorage();
    const markers = pageMarkers(storage);
    markers.set(scopeOf("a", "incarnation-1"), "capture");
    markers.set(scopeOf("a", ACCOUNT_NEXT), "queue");
    markers.set(scopeOf("b", "incarnation-1"), "capture");
    markers.stops.hold(scopeOf("a", "incarnation-1"), "draft:m");
    markers.clearAccount("a");
    expect(stored(storage).filter((key) => key.includes(":a:"))).toEqual([]);
    expect(
      stored(storage).some(
        (key) => key.startsWith(MARKER_PREFIX) && key.includes(":b:"),
      ),
    ).toBe(true);
    expect(markers.probe(scopeOf("b", "incarnation-1"), "capture")).toBe(
      "marked",
    );
    expect(markers.stops.operations(scopeOf("a", "incarnation-1"))).toEqual([]);
  });

  test("cleanup is housekeeping: a lifetime whose cleanup never happened (a crash, a deletion that found the database absent) is unreachable, not stale", () => {
    const storage = new FakeMarkerStorage();
    const markers = pageMarkers(storage);
    markers.set(scopeOf("a", "incarnation-1"), "capture");
    // No `clearAccount`. The replacement's reads, witnesses and inspections are unaffected, and its own failures are recorded and ended
    // as if the old keys were not there.
    const replacement = scopeOf("a", ACCOUNT_NEXT);
    expect(markers.probe(replacement, "capture")).toBe("unmarked");
    expect(markers.set(replacement, "capture").state).toBe("recorded");
    const seen = markers.witness(replacement, "capture");
    expect(markers.retire(replacement, "capture", seen)).toBe(true);
    expect(markers.probe(replacement, "capture")).toBe("unmarked");
    expect(markerStands(storage, "a", "capture")).toBe(true);
  });

  test("a directory of a lifetime is at its own address", () => {
    expect(directoryKey(scopeOf("a", "x"), 3)).not.toBe(
      directoryKey(scopeOf("a", "y"), 3),
    );
    const storage = new FakeMarkerStorage();
    plantMarker(storage, scopeOf("a", "x"), "capture", "p.1", 3);
    expect(storage.items.has(directoryKey(scopeOf("a", "x"), 3))).toBe(true);
    expect(storage.items.has(directoryKey(scopeOf("a", "y"), 3))).toBe(false);
  });
});

describe("the facade: a failed edit, a failed counter whose rejection is delivered after the service ended", () => {
  async function queued(w: OutboxWorld, id = "a"): Promise<void> {
    expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
      "queued",
    );
    await w.settle();
  }
  const failEdit = (w: OutboxWorld) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.editQueuedDraft",
      mode: "error",
      times: 1,
    });
  const failCounter = (w: OutboxWorld) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });

  test("live control: the same schedule, the service still live, records the stop in the marker and the warning is up", async () => {
    const w = await world();
    try {
      await queued(w);
      failEdit(w);
      failCounter(w);
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      expect(held.held()).toBe(true);
      held.release();
      expect(await edit).toEqual({ kind: "refused", reason: "storage" });
      await w.settle();
      expect(markerStands(w.markerStorage, w.service.account, "draft:a")).toBe(
        true,
      );
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      w.dispatcher.stop();
      w.service.dispose("closed");
    }
  });

  test("the service ended, the database deleted and its markers cleaned, then the old rejection arrives: nothing is recorded, held or shown, and the replacement's reader sees nothing", async () => {
    const w = await world();
    try {
      await queued(w);
      failEdit(w);
      failCounter(w);
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      // The counter has FAILED (the plan ran); only the delivery of its rejection is held.
      expect(held.held()).toBe(true);
      const old = {
        account: w.service.account,
        incarnationId: w.service.incarnationId,
      };
      // The production close and deletion: the service ends, then the account's database is deleted and its markers are cleaned up.
      w.service.dispose("closed");
      w.markers.clearAccount(w.service.account);
      expect(stored(w.markerStorage)).toEqual([]);
      held.release();
      expect(await edit).toEqual({
        kind: "refused",
        reason: "identity_changed",
      });
      await w.settle();
      // Nothing, for any lifetime: no directory, no key.
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.markers.stops.operations(old)).toEqual([]);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      expect(w.outbox.storageMemoryOnly.get()).toBe(false);
      // A fresh reader of the replacement lifetime, with nothing in memory.
      const fresh = pageMarkers(w.markerStorage, { events: false });
      const next = scopeOf(w.service.account, ACCOUNT_NEXT);
      expect(fresh.probe(next, "draft:a")).toBe("unmarked");
      expect(fresh.inspect(next)).toEqual({ operations: [], known: true });
    } finally {
      w.dispatcher.stop();
    }
  });

  test("the same schedule when the cleanup never ran (the wipe found the database already absent): still nothing, and a replacement reader is untouched", async () => {
    const w = await world();
    try {
      await queued(w);
      failEdit(w);
      failCounter(w);
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      w.service.dispose("closed");
      held.release();
      expect(await edit).toMatchObject({ kind: "refused" });
      await w.settle();
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      w.dispatcher.stop();
    }
  });

  test("the deletion FAILS (the production port closes the service and the database, and so its lifetime, stays): the old rejection then arrives and records nothing, and a reader of that same lifetime sees nothing", async () => {
    const w = await world();
    try {
      await queued(w);
      failEdit(w);
      failCounter(w);
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      expect(held.held()).toBe(true);
      const lifetime = {
        account: w.service.account,
        incarnationId: w.service.incarnationId,
      };
      const port = createAccountDatabasePort({
        host: w.page.host,
        registry: w.page.registry,
        markers: w.markers,
        now: () => 0,
      });
      w.dispatcher.stop();
      await port.closeOwnConnections(w.service.account);
      w.env.idb.deleteError = true;
      expect(await port.delete(w.service.account)).toBe("error");
      // The service ended with the close; the database was not deleted, so it is the SAME lifetime a replacement would open.
      expect(w.service.live).toBe(false);
      held.release();
      expect(await edit).toEqual({
        kind: "refused",
        reason: "identity_changed",
      });
      await w.settle();
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.markers.stops.operations(lifetime)).toEqual([]);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      expect(w.outbox.storageMemoryOnly.get()).toBe(false);
      const fresh = pageMarkers(w.markerStorage, { events: false });
      expect(fresh.probe(lifetime, "draft:a")).toBe("unmarked");
      expect(fresh.inspect(lifetime)).toEqual({ operations: [], known: true });
    } finally {
      w.dispatcher.stop();
    }
  });

  test("the rejection arrives BEFORE the cleanup (as when a deletion is blocked and completes later): nothing is recorded then, and the cleanup that follows finds nothing to remove", async () => {
    const w = await world();
    try {
      await queued(w);
      failEdit(w);
      failCounter(w);
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      expect(held.held()).toBe(true);
      w.service.dispose("closed");
      held.release();
      expect(await edit).toEqual({
        kind: "refused",
        reason: "identity_changed",
      });
      await w.settle();
      // While the deletion is still pending: nothing, for any lifetime.
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      // The deletion completes and its cleanup runs: there is nothing of this lifetime to clean, and nothing appears.
      w.markers.clearAccount(w.service.account);
      expect(stored(w.markerStorage)).toEqual([]);
    } finally {
      w.dispatcher.stop();
    }
  });

  test("an edit that fails with the service live and whose counter SUCCEEDS is counted, not recorded in the marker (control for the counter path)", async () => {
    const w = await world();
    try {
      await queued(w);
      failEdit(w);
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      w.service.dispose("closed");
      held.release();
      expect(await edit).toEqual({
        kind: "refused",
        reason: "identity_changed",
      });
      await w.settle();
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      w.dispatcher.stop();
    }
  });
});

describe("a counter that REACHES the bound after the lifetime ended stops nothing and shows nothing (the writers' other branch)", () => {
  test("facade: two earlier failures, a third whose counter succeeds (reaching the bound) delivered after the service ended: no warning for a lifetime that is over", async () => {
    const w = await world();
    try {
      expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await w.settle();
      w.setSync({ local_write_streaks: { "draft:a": 2 } });
      w.env.idb.inject({
        match: (tx) => tx.label === "data.editQueuedDraft",
        mode: "error",
        times: 1,
      });
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      const edit = w.outbox.editQueued("a", request("a", "unsaved"));
      await w.settle();
      expect(held.held()).toBe(true);
      w.service.dispose("closed");
      held.release();
      expect(await edit).toEqual({
        kind: "refused",
        reason: "identity_changed",
      });
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      expect(stored(w.markerStorage)).toEqual([]);
    } finally {
      w.dispatcher.stop();
    }
  });

  test("dispatcher: two earlier failures of the queue read, a third whose counter succeeds delivered after the service ended: the dispatcher is not stopped for a lifetime that is over", async () => {
    const w = await world();
    w.online = true;
    try {
      w.setSync({ local_write_streaks: { queue: 2 } });
      w.env.idb.inject({
        match: (tx) => tx.label === "data.readDispatchWindow",
        mode: "error",
        times: 1,
      });
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      w.start();
      await w.settle();
      expect(held.held()).toBe(true);
      w.service.dispose("closed");
      held.release();
      await w.settle();
      expect(w.dispatcher.state.get()).not.toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
      expect(stored(w.markerStorage)).toEqual([]);
    } finally {
      w.dispatcher.stop();
    }
  });

  test("engine: two earlier failures of the capture write, a third whose counter succeeds delivered after the service ended: the engine is not stopped for a lifetime that is over", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
    w.setSync({ local_write_streaks: { [CAPTURE_OPERATION]: 2 } });
    w.env.idb.inject({
      match: (tx) => tx.label === "data.captureRequest",
      mode: "error",
      times: 1,
    });
    // The capture gate refuses a streak at the bound only; two is below it, so the capture runs and its write fails.
    const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
    w.start();
    await w.settle();
    expect(held.held()).toBe(true);
    w.service.dispose("closed");
    held.release();
    await w.settle();
    expect(w.state()).not.toEqual({ kind: "stopped", cause: "local_storage" });
    expect(stored(w.markerStorage)).toEqual([]);
    w.engine.stop();
  });
});

describe("the dispatcher: the read of the queue and the claim of a draft", () => {
  const fail = (w: OutboxWorld, label: string) =>
    w.env.idb.inject({
      match: (tx) => tx.label === label,
      mode: "error",
      times: 1,
    });

  test("live control: the queue read fails with its counter, and the stop is recorded under `queue`", async () => {
    const w = await world();
    w.online = true;
    try {
      fail(w, "data.readDispatchWindow");
      fail(w, "data.recordLocalWriteOutcome");
      w.start();
      await w.settle();
      expect(markerStands(w.markerStorage, w.service.account, "queue")).toBe(
        true,
      );
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
    } finally {
      w.dispatcher.stop();
      w.service.dispose("closed");
    }
  });

  test("the queue read and its counter failed, the service ended and its markers were cleaned, then the rejection arrives: nothing is recorded under `queue`, for either lifetime", async () => {
    const w = await world();
    w.online = true;
    try {
      fail(w, "data.readDispatchWindow");
      fail(w, "data.recordLocalWriteOutcome");
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      w.start();
      await w.settle();
      expect(held.held()).toBe(true);
      w.service.dispose("closed");
      w.markers.clearAccount(w.service.account);
      held.release();
      await w.settle();
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.markers.stops.operations(w.service)).toEqual([]);
      const fresh = pageMarkers(w.markerStorage, { events: false });
      expect(
        fresh.probe(scopeOf(w.service.account, ACCOUNT_NEXT), "queue"),
      ).toBe("unmarked");
      expect(w.dispatcher.state.get()).not.toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
    } finally {
      w.dispatcher.stop();
    }
  });

  test("the claim of a draft and its counter failed, the service ended, then the rejection arrives: nothing is recorded under `draft:<id>`, and the replacement's draft of that id is not stalled", async () => {
    const w = await world();
    w.online = true;
    try {
      w.online = true;
      expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await w.settle();
      w.dispatcher.stop();
      fail(w, "data.markInFlight");
      fail(w, "data.recordLocalWriteOutcome");
      const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
      w.start();
      await w.settle();
      expect(held.held()).toBe(true);
      w.service.dispose("closed");
      w.markers.clearAccount(w.service.account);
      held.release();
      await w.settle();
      expect(stored(w.markerStorage)).toEqual([]);
      expect(w.markers.stops.operations(w.service)).toEqual([]);
    } finally {
      w.dispatcher.stop();
    }
  });
});

describe("the sync engine: the capture write, the page's commit and the bookkeeping it must not lose", () => {
  const failCapture = (w: Awaited<ReturnType<typeof engineWorld>>) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.captureRequest",
      mode: "error",
      times: 1,
    });
  const failCounter = (w: Awaited<ReturnType<typeof engineWorld>>) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });

  test("live control: the capture write and its counter fail, and the stop is recorded under `capture`", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
    failCapture(w);
    failCounter(w);
    w.start();
    await w.settle();
    expect(
      markerStands(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toBe(true);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    w.engine.stop();
  });

  test("the capture write and its counter failed, the service ended and its markers were cleaned, then the rejection arrives: nothing is recorded under `capture` for either lifetime, and the replacement is not stopped", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
    failCapture(w);
    failCounter(w);
    const held = delayResult(w.service.store, "data.recordLocalWriteOutcome");
    w.start();
    await w.settle();
    expect(held.held()).toBe(true);
    w.service.dispose("closed");
    w.markers.clearAccount(w.service.account);
    held.release();
    await w.settle();
    expect(stored(w.markerStorage)).toEqual([]);
    expect(w.state()).not.toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.state()).not.toMatchObject({ memoryOnly: true });
    const fresh = pageMarkers(w.markerStorage, { events: false });
    expect(
      fresh.probe(scopeOf(w.service.account, ACCOUNT_NEXT), CAPTURE_OPERATION),
    ).toBe("unmarked");
    expect(
      markerKeys(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toEqual([]);
    w.engine.stop();
  });
});

describe("the sync engine's direct bookkeeping writers: a counter that cannot be written and the quota stop of an invalidation", () => {
  test("live control: the sync caller's retry record cannot be written, and the stop is recorded under `retry-state`", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 4; i += 1) w.script.push(w.status(503));
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordReadOutcome",
      mode: "error",
      times: 1,
    });
    w.start();
    await w.settle();
    expect(
      markerStands(w.markerStorage, w.service.account, READ_RETRY_OPERATION),
    ).toBe(true);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    w.engine.stop();
  });

  test("the retry record failed, the service ended and its markers were cleaned, then the rejection arrives: nothing is recorded under `retry-state`, for either lifetime", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 4; i += 1) w.script.push(w.status(503));
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordReadOutcome",
      mode: "error",
      times: 1,
    });
    const held = delayResult(w.service.store, "data.recordReadOutcome");
    w.start();
    await w.settle();
    expect(held.held()).toBe(true);
    w.service.dispose("closed");
    w.markers.clearAccount(w.service.account);
    held.release();
    await w.settle();
    expect(stored(w.markerStorage)).toEqual([]);
    expect(w.state()).not.toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.state()).not.toMatchObject({ memoryOnly: true });
    expect(
      pageMarkers(w.markerStorage, { events: false }).probe(
        scopeOf(w.service.account, ACCOUNT_NEXT),
        READ_RETRY_OPERATION,
      ),
    ).toBe("unmarked");
    w.engine.stop();
  });

  test("live control: the invalidation's write fails for want of space, and the stop is recorded under `invalidate:<cursor>`", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.invalidateCache",
      mode: "quota",
      times: 1,
    });
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(
      markerStands(w.markerStorage, w.service.account, "invalidate:cursor-0"),
    ).toBe(true);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "storage_full",
      invalidating: true,
    });
    w.engine.stop();
  });

  test("the invalidation's quota failure was delivered after the service ended: nothing is recorded under `invalidate:<cursor>` and the replacement's cache is not hidden by it", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.invalidateCache",
      mode: "quota",
      times: 1,
    });
    const held = delayResult(w.service.store, "data.invalidateCache");
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(held.held()).toBe(true);
    w.service.dispose("closed");
    w.markers.clearAccount(w.service.account);
    held.release();
    await w.settle();
    expect(stored(w.markerStorage)).toEqual([]);
    expect(w.state()).not.toMatchObject({ cause: "storage_full" });
    expect(
      pageMarkers(w.markerStorage, { events: false }).probe(
        scopeOf(w.service.account, ACCOUNT_NEXT),
        "invalidate:cursor-0",
      ),
    ).toBe("unmarked");
    w.engine.stop();
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  AccountService,
  DataRuntime,
} from "../../src/data/engine/account-service";
import {
  LOCAL_WRITE_STOPS_STORE,
  type SyncChannel,
  type SyncMessage,
} from "../../src/data/engine/sync-channel";
import type { WriteFailureMarkers } from "../../src/data/engine/write-failure-marker";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { deriveNotices } from "../../src/data/model/status";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { createDataEnv } from "../../src/data/ui/env";
import { pageMarkers, plantMarker } from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R60 (revision 37): a durable stop recorded by one page reaches a HEALTHY follower page. The review of revision 36 let a follower
 * complete an empty, healthy observation, then had another page record three failed saves in `sync_state.local_write_streaks`: the
 * writer warned, but its announcement reached only its own page, no cross-tab hint was posted, and even an explicit same-account hint was
 * skipped because the follower was healthy, so its warning stayed absent (a fresh facade showed it). A writer now posts a hint naming the
 * stop records' store (`LOCAL_WRITE_STOPS_STORE`) when it records a durable stop or ends a durable failure it saw, and a facade reads its
 * records on such a hint whatever it shows. Other hints are still read only while a stop is shown or unsure, and nothing polls.
 *
 * R59 (revision 37), the observer half: a facade made over a service that has ALREADY ended subscribes to nothing and reads nothing (its
 * end was announced before it could hear it); a look checks liveness before it reads as well as after.
 *
 * The oracle: the follower is ANOTHER page (its own markers page and channel listeners; the writer's posts reach it only when the test
 * relays them, as `BroadcastChannel` would, and never reach the writer), its reads of the stop records are counted at its own view of the
 * store, the durable record is read back from the database, and the notice is what `deriveNotices` gives the screens.
 *
 * FIXTURE evidence: the production facade, dispatcher, controller and plans over the doubles of IndexedDB and `localStorage`, fake time;
 * the failures are NAMED injections on the plans' transactions; no backend.
 */
const STOP_READS = "data.readLocalWriteStops";
const HINT: SyncMessage = {
  type: "data_changed",
  account: "",
  stores: [LOCAL_WRITE_STOPS_STORE],
};

const request = (localId: string, target = "r"): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: target,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id: target,
      label: localId,
      expected_version: bases[target] as number,
    },
  }),
});

async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
  ]);
  return w;
}
const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
/** The hints the writer posted that name the stop records (`LOCAL_WRITE_STOPS_STORE`). */
const stopHints = (w: OutboxWorld): SyncMessage[] =>
  w.posted.filter(
    (m) =>
      m.type === "data_changed" && m.stores.includes(LOCAL_WRITE_STOPS_STORE),
  );

/** A view of the service whose store counts the stop-record reads made through it (one page's reads, not the world's). */
function counted(service: AccountService): {
  service: AccountService;
  reads: () => number;
} {
  let reads = 0;
  const store = new Proxy(service.store, {
    get(target, key) {
      if (key !== "run") return Reflect.get(target, key, target);
      return (plan: { name: string }, ...rest: unknown[]) => {
        if (plan.name === STOP_READS) reads += 1;
        return (target.run as (...a: unknown[]) => unknown)(plan, ...rest);
      };
    },
  });
  return {
    service: new Proxy(service, {
      get: (target, key) =>
        key === "store" ? store : Reflect.get(target, key, target),
    }),
    reads: () => reads,
  };
}

interface Follower {
  facade: Outbox;
  markers: WriteFailureMarkers;
  reads(): number;
  /** Delivers a message to THIS page, as another tab's `BroadcastChannel` post would. */
  hear(message: SyncMessage): void;
  /** Delivers to this page every message the writer posted since the last relay. */
  relay(): void;
  listeners(): number;
  close(): void;
}

/** Another page of the same account: its own markers page, its own channel, its own reads. */
function follower(w: OutboxWorld, service: AccountService = w.service) {
  const listeners = new Set<(message: SyncMessage) => void>();
  const channel: SyncChannel = {
    post: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const view = counted(service);
  const markers = pageMarkers(
    w.markerStorage.page(`follower-${crypto.randomUUID()}`),
  );
  const facade = createOutbox({
    service: view.service,
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: {
      iso: () => new Date(w.now()).toISOString(),
      now: () => w.now(),
    },
    fence: () => w.fence,
    markers,
    channel,
    timers: w.timers,
  });
  let relayed = w.posted.length;
  const hear = (message: SyncMessage): void => {
    for (const listener of [...listeners]) listener(message);
  };
  return {
    facade,
    markers,
    reads: view.reads,
    hear,
    relay() {
      const fresh = w.posted.slice(relayed);
      relayed = w.posted.length;
      for (const message of fresh) hear(message);
    },
    listeners: () => listeners.size,
    close() {
      facade.disposeObservation();
      markers.release();
    },
  } satisfies Follower;
}

describe("R60: a durable stop one page records reaches a healthy follower", () => {
  for (const failures of [2, 3])
    test(`the facade's ${failures === 3 ? "third failed save (a durable stop)" : "two failed saves (below the bound, the control)"}: ${failures === 3 ? "the writer posts ONE hint naming the stop records, and the healthy follower shows the warning" : "no stop hint, and the follower stays clear"}`, async () => {
      const w = await world();
      const reader = follower(w);
      try {
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(false);
        expect(reader.reads()).toBe(1);
        fail(w, "data.enqueueDraft", failures);
        for (let i = 0; i < failures; i += 1) {
          expect(stopHints(w)).toHaveLength(0);
          expect(await w.outbox.enqueue(request("a"))).toEqual({
            kind: "refused",
            reason: "storage",
          });
        }
        await w.settle();
        expect(w.sync().local_write_streaks).toEqual({ "draft:a": failures });
        expect(stopHints(w)).toHaveLength(failures === 3 ? 1 : 0);
        expect(w.outbox.storageNotResponding.get()).toBe(failures === 3);
        reader.relay();
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(failures === 3);
        // Nothing polls: the follower read once at the start and once for the hint, and no more however long it waits.
        const after = reader.reads();
        expect(after).toBe(failures === 3 ? 2 : 1);
        await w.advance(65_000);
        expect(reader.reads()).toBe(after);
        expect(reader.facade.storageNotResponding.get()).toBe(failures === 3);
      } finally {
        reader.close();
        finish(w);
      }
    });

  test("the ignored-hint path: a stop another page wrote into the record is read on a hint naming it, though the follower was healthy and complete (the review's own hint too)", async () => {
    for (const stores of [
      [LOCAL_WRITE_STOPS_STORE],
      [LOCAL_WRITE_STOPS_STORE, "drafts"],
    ]) {
      const w = await world();
      const reader = follower(w);
      try {
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(false);
        // Another page's three failures, in the record only: nothing of this page hears of them.
        w.setSync({ local_write_streaks: { "draft:z": 3 } });
        await w.advance(10_000);
        expect(reader.facade.storageNotResponding.get()).toBe(false);
        reader.hear({ ...HINT, account: w.service.account, stores });
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(true);
      } finally {
        reader.close();
        finish(w);
      }
    }
  });

  test("a hint that names no stop record is still not read by a healthy follower (no new read load), and one for another account never is", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      await w.settle();
      const quiet = reader.reads();
      for (let i = 0; i < 10; i += 1)
        reader.hear({
          type: "data_changed",
          account: w.service.account,
          stores: ["drafts", "resource_versions"],
        });
      for (let i = 0; i < 10; i += 1)
        reader.hear({ ...HINT, account: "someone-else" });
      await w.settle();
      expect(reader.reads()).toBe(quiet);
    } finally {
      reader.close();
      finish(w);
    }
  });

  test("a hint naming the stop records whose page recorded nothing for this follower's records (another lifetime, a reset): one read, nothing shown", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      await w.settle();
      const quiet = reader.reads();
      reader.hear({ ...HINT, account: w.service.account });
      await w.settle();
      expect(reader.reads()).toBe(quiet + 1);
      expect(reader.facade.storageNotResponding.get()).toBe(false);
    } finally {
      reader.close();
      finish(w);
    }
  });

  test("bounded: a burst of fifty stop hints is one look and at most one more", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      await w.settle();
      const quiet = reader.reads();
      w.setSync({ local_write_streaks: { "draft:z": 3 } });
      for (let i = 0; i < 50; i += 1)
        reader.hear({ ...HINT, account: w.service.account });
      await w.settle();
      expect(reader.reads() - quiet).toBeGreaterThanOrEqual(1);
      expect(reader.reads() - quiet).toBeLessThanOrEqual(2);
      expect(reader.facade.storageNotResponding.get()).toBe(true);
    } finally {
      reader.close();
      finish(w);
    }
  });

  test("the dispatcher's receipt write fails three times (a durable stop of `receipt:<id>`): it posts the hint, and the healthy follower shows the warning", async () => {
    const w = await world();
    w.online = true;
    w.start();
    const reader = follower(w);
    try {
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(false);
      fail(w, "data.admitReceipt", 3);
      const out = await w.outbox.enqueue(request("a"));
      expect(out.kind).toBe("queued");
      await w.advance(5_000);
      expect(w.sync().local_write_streaks).toEqual({ "receipt:a": 3 });
      expect(stopHints(w)).toHaveLength(1);
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(true);
    } finally {
      reader.close();
      finish(w);
    }
  });

  test("the dispatcher's claim fails three times (a durable stop of `draft:<id>`): it posts the hint, and the healthy follower shows the warning", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      expect((await w.outbox.enqueue(request("a"))).kind).toBe("queued");
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(false);
      fail(w, "data.markInFlight", 3);
      w.online = true;
      w.start();
      await w.advance(5_000);
      expect(w.dispatcher.state.get().kind).toBe("stopped");
      expect(w.sync().local_write_streaks).toEqual({ "draft:a": 3 });
      expect(stopHints(w)).toHaveLength(1);
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(true);
    } finally {
      reader.close();
      finish(w);
    }
  });
});

describe("R60: the end of a durable stop reaches a follower that shows it", () => {
  test("the facade's Try again ends the durable stop it saw: it posts the hint, and the follower takes its warning down", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      await w.settle();
      fail(w, "data.enqueueDraft", 3);
      for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(request("a"));
      await w.settle();
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(true);
      const before = stopHints(w).length;
      w.outbox.retry("a");
      await w.settle();
      expect(w.sync().local_write_streaks).toEqual({});
      expect(stopHints(w).length).toBe(before + 1);
      // Without the hint nothing tells the follower: it shows the stop it read, and nothing polls.
      await w.advance(65_000);
      expect(reader.facade.storageNotResponding.get()).toBe(true);
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(false);
    } finally {
      reader.close();
      finish(w);
    }
  });

  test("the dispatcher's Try again ends the durable stop it saw: it posts the hint, and the follower takes its warning down", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      expect((await w.outbox.enqueue(request("a"))).kind).toBe("queued");
      fail(w, "data.markInFlight", 3);
      w.online = true;
      w.start();
      await w.advance(5_000);
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(true);
      const before = stopHints(w).length;
      w.dispatcher.retry("a");
      await w.settle();
      expect(w.sync().local_write_streaks).toEqual({});
      expect(stopHints(w).length).toBeGreaterThan(before);
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(false);
    } finally {
      reader.close();
      finish(w);
    }
  });
});

describe("R60: the controller's notice on a follower page", () => {
  test("a follower page's controller shows the existing notice once the writer's stop hint arrives, and not before", async () => {
    const w = await world();
    const listeners = new Set<(message: SyncMessage) => void>();
    const markers = pageMarkers(w.markerStorage.page("controller-follower"));
    const ui = createDataEnv({
      identity: w.identity,
      loadRuntime: async () =>
        ({
          open: async () => ({
            kind: "opened",
            service: w.service,
            created: false,
          }),
        }) as unknown as DataRuntime,
      online: { get: () => false, subscribe: () => () => undefined },
      quota: w.quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: {
        now: () => w.now(),
        iso: () => new Date(w.now()).toISOString(),
      },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
      readMe: async () => ({ kind: "closed" }),
      currentDeviceId: async () => ({ kind: "closed" }),
      onOnline: () => () => undefined,
      channel: {
        post: () => undefined,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      markers,
      timers: w.timers,
    });
    const notice = (): boolean =>
      deriveNotices(ui.inputs.get()).some(
        (n) => n.kind === "storage_not_responding",
      );
    try {
      await w.settle();
      expect(ui.service()).not.toBeNull();
      expect(notice()).toBe(false);
      let relayed = w.posted.length;
      fail(w, "data.enqueueDraft", 3);
      for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(request("a"));
      await w.advance(DATA_CONFIG.factsReadRetryMaxMs);
      expect(notice()).toBe(false);
      for (const message of w.posted.slice(relayed))
        for (const listener of [...listeners]) listener(message);
      relayed = w.posted.length;
      await w.settle();
      expect(notice()).toBe(true);
    } finally {
      ui.dispose();
      markers.release();
      finish(w);
    }
  });
});

describe("R59: an observation made over a service that has already ended is inert", () => {
  for (const ended of [false, true])
    test(`${ended ? "over an ended service: no read, no subscription, no timer, whatever it is told" : "control, over a live service: it reads at once and on news"}`, async () => {
      const w = await world();
      await w.settle();
      w.outbox.disposeObservation();
      if (ended) w.service.dispose("closed");
      const worldListeners = w.channelListeners.size;
      const reader = follower(w);
      try {
        await w.settle();
        expect(reader.reads()).toBe(ended ? 0 : 1);
        expect(reader.listeners()).toBe(ended ? 0 : 1);
        // News on the page, a hint naming the records, and a marker another page changes.
        reader.markers.stops.announce(
          w.service,
          {},
          {
            recorded: ["draft:peer"],
          },
        );
        reader.hear({ ...HINT, account: w.service.account });
        plantMarker(
          w.markerStorage.page("other").storage,
          w.service,
          "draft:peer",
        );
        await w.advance(65_000);
        if (ended) {
          expect(reader.reads()).toBe(0);
          expect(reader.facade.storageNotResponding.get()).toBe(false);
        } else expect(reader.reads()).toBeGreaterThan(1);
        expect(w.channelListeners.size).toBe(worldListeners);
      } finally {
        reader.close();
        if (!ended) w.service.dispose("closed");
        w.dispatcher.stop();
      }
    });

  test("a look checks liveness BEFORE it reads: over a service that is not live (its account latched, not ended) it reads nothing and schedules nothing; when it is live again a hint is read", async () => {
    const w = await world();
    await w.settle();
    w.outbox.disposeObservation();
    let latched = true;
    const view = new Proxy(w.service, {
      get: (target, key) =>
        key === "live"
          ? !latched && target.live
          : Reflect.get(target, key, target),
    });
    const reader = follower(w, view);
    try {
      await w.advance(65_000);
      expect(reader.reads()).toBe(0);
      latched = false;
      reader.hear({ ...HINT, account: w.service.account });
      await w.settle();
      expect(reader.reads()).toBe(1);
    } finally {
      reader.close();
      finish(w);
    }
  });
});

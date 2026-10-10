// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import type { SyncChannel } from "../../src/data/engine/sync-channel";
import {
  createWriteFailureMarkers,
  markerKey,
  type WriteFailureMarkers,
} from "../../src/data/engine/write-failure-marker";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { deriveNotices } from "../../src/data/model/status";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { createDataEnv, type DataEnv } from "../../src/data/ui/env";
import { controllerProbe } from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import {
  markerKeys,
  pageMarkers,
  plantMarker,
  setGlobalStorage,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R55 (revision 36): the PUBLIC warning recovers when a record that could not be read becomes readable, with no event, no action and no
 * network. The review of revision 35 started a follower while `localStorage` reads were refused, with an immutable `draft:*` failure
 * marker standing; the facade's first look could not read it, and when access returned nothing looked again (no event is raised when a
 * refused access is granted), so the controller's cache gate reopened while the existing "local storage isn't responding" notice stayed
 * away. The facade now keeps its observation's completeness and, while unsure, looks again by itself at the facts' re-read pace, inside a
 * lifetime its owner ends (`disposeObservation`) and the service ends.
 *
 * The oracle is independent of the scheduling: the production pacing CAP (`factsReadRetryMaxMs`) bounds how long after access returns the
 * notice may take, the raw `localStorage` items say what stands, the notices are what `deriveNotices` gives the screens, and the reads and
 * timers are counted at the store and the timer seam. Q-numbers are the design assessment's qualification plan.
 *
 * FIXTURE evidence: the production facade, controller, plans and markers over the doubles of IndexedDB and `localStorage`, with injected
 * refusals (not a naturally occurring browser outage) and fake time; no backend. The native cases are E-R55 in `fixture.data-marker.spec.ts`.
 */
const STOP_READS = "data.readLocalWriteStops";
const FIRST = DATA_CONFIG.factsReadRetryMs;
const CAP = DATA_CONFIG.factsReadRetryMaxMs;
/** A long outage, in fake time: the pace has reached its cap long before it ends. */
const OUTAGE = 30_000;

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

async function world(
  options: { cacheStatus?: "valid" | "invalid" | "empty" } = {},
): Promise<OutboxWorld> {
  const w = await outboxWorld(options);
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r", version: 5 }),
    cacheRow({ id: "r-a", version: 5 }),
  ]);
  // The world's own facade is another observer of the same records: it is let go of, so that every read counted is the facade's under test.
  w.outbox.disposeObservation();
  return w;
}
const account = (w: OutboxWorld): string => w.service.account;
const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};

/** The times (fake) of every read of the stop records. Arm it FIRST: the double stops at the first rule that matches, and this never does. */
function stopReads(w: OutboxWorld): number[] {
  const at: number[] = [];
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label === STOP_READS) at.push(w.now());
      return false;
    },
    mode: "error",
  });
  return at;
}
/** The stop records' database read fails until the returned function is called. */
const databaseRefused = (w: OutboxWorld): (() => void) =>
  w.env.idb.inject({
    match: (tx) => tx.label === STOP_READS,
    mode: "error",
    times: 1_000_000,
  });

/** The world's timers, with a count of those still pending (set and neither fired nor cleared). */
function countedTimers(w: OutboxWorld) {
  const live = new Set<unknown>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const handle: unknown = w.timers.setTimeout(() => {
          live.delete(handle);
          fn();
        }, ms);
        live.add(handle);
        return handle;
      },
      clearTimeout: (handle: unknown): void => {
        live.delete(handle);
        w.timers.clearTimeout(handle);
      },
    },
    live: () => live.size,
  };
}

/** The world's `atlas-sync`: what another tab posts reaches every listener (`w.deliver`), and what a page posts is recorded. */
const worldChannel = (w: OutboxWorld): SyncChannel => ({
  post: (message) => {
    w.posted.push(message);
  },
  subscribe: (listener) => {
    w.channelListeners.add(listener);
    return () => {
      w.channelListeners.delete(listener);
    };
  },
});

/** A facade of the page `markers` belongs to, over the world's service, channel and fake time (no dispatcher unless one is given). */
const facadeOver = (
  w: OutboxWorld,
  markers: WriteFailureMarkers,
  options: {
    timers?: OutboxWorld["timers"];
    dispatcher?: OutboxWorld["dispatcher"];
  } = {},
): Outbox =>
  createOutbox({
    service: w.service,
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date(w.now()).toISOString(), now: () => w.now() },
    fence: () => w.fence,
    channel: worldChannel(w),
    markers,
    timers: options.timers ?? w.timers,
    ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
  });

/** The production controller of a page over the world, on fake time, with the page's markers. */
async function controllerOver(
  w: OutboxWorld,
  markers: WriteFailureMarkers,
): Promise<DataEnv> {
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  const env = createDataEnv({
    identity: w.identity,
    loadRuntime: async () => runtime,
    online: { get: () => w.online, subscribe: () => () => undefined },
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => w.now(), iso: () => new Date(w.now()).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    channel: worldChannel(w),
    markers,
    timers: w.timers,
  });
  await w.settle();
  if (env.outbox() === null)
    throw new Error("setup: the controller has no outbox");
  return env;
}
const warned = (env: DataEnv): boolean =>
  deriveNotices(env.inputs.get()).some(
    (notice) => notice.kind === "storage_not_responding",
  );

/** Another tab of the origin: what it writes reaches every other page as a `storage` event. */
const anotherTab = (w: OutboxWorld, name = "another-tab") =>
  w.markerStorage.page(name);
const refuseReads = (w: OutboxWorld, refused: boolean): void => {
  w.markerStorage.failEnumeration = refused;
  w.markerStorage.failGets = refused;
};

/** Every value a store takes from now on. */
function history(store: { get(): boolean; subscribe(f: () => void): void }) {
  const seen: boolean[] = [store.get()];
  store.subscribe(() => seen.push(store.get()));
  return seen;
}

// ---- Q1: the review's follower, promoted ---------------------------------------------------------------------------------------------
describe("Q1: a follower started while the markers cannot be read shows the existing notice once they can, with no event", () => {
  for (const blocked of [false, true])
    for (const present of [false, true])
      test(`follower over a no-slot publisher: reads refused=${blocked}, marker standing=${present}`, async () => {
        const w = await engineWorld();
        const operation = "draft:saved-before-close";
        // A production publisher with NO directory slot (locks unavailable), as in the review: the key is the only trace.
        const writer = createWriteFailureMarkers(w.markerStorage, undefined, {
          id: () => "publisher",
          locks: null,
        });
        const key = markerKey(w.service, operation, "publisher.1");
        let ui: Awaited<ReturnType<typeof controllerProbe>> | undefined;
        try {
          if (present) {
            expect(writer.set(w.service, operation).state).toBe("recorded");
            expect(w.markerStorage.peek(key)).toBe("1");
          }
          writer.release();
          w.markerStorage.failEnumeration = blocked;
          w.markerStorage.failGets = blocked;
          const reader = createWriteFailureMarkers(w.markerStorage, undefined, {
            id: () => "follower",
            locks: null,
          });
          ui = await controllerProbe(w, { leader: false, markers: reader });
          const notice = (): boolean =>
            (ui?.notices() ?? []).some(
              (n) => n.kind === "storage_not_responding",
            );
          if (blocked) {
            expect(reader.probe(w.service, operation)).toBe("unknown");
            // Unknown is not a stop: nothing is invented while the read is refused, however long it lasts.
            await w.advance(OUTAGE);
            expect(notice()).toBe(false);
          } else expect(notice()).toBe(present);
          // Access returns: no storage value changes and no event is raised. No look, wake or action is made by the test.
          w.markerStorage.failEnumeration = false;
          w.markerStorage.failGets = false;
          await w.advance(CAP);
          expect(w.markerStorage.peek(key)).toBe(present ? "1" : null);
          expect(reader.probe(w.service, operation)).toBe(
            present ? "marked" : "unmarked",
          );
          expect(ui.gate()).toBe("open");
          expect(notice()).toBe(present);
        } finally {
          ui?.dispose();
          writer.release();
          w.engine.stop();
          w.service.dispose("closed");
        }
      });
});

// ---- Q2: every public facade recovers on its own -------------------------------------------------------------------------------------
describe("Q2: the direct facade, a controller with no engine and no gate timer, and an attached leader each recover", () => {
  for (const present of [false, true]) {
    test(`a facade with no dispatcher (marker standing=${present})`, async () => {
      const w = await world();
      if (present) plantMarker(anotherTab(w).storage, account(w), "draft:a");
      refuseReads(w, true);
      const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
      await w.settle();
      expect(facade.storageNotResponding.get()).toBe(false);
      await w.advance(OUTAGE);
      expect(facade.storageNotResponding.get()).toBe(false);
      refuseReads(w, false);
      await w.advance(CAP);
      expect(facade.storageNotResponding.get()).toBe(present);
      finish(w);
    });

    test(`the controller's own facade, with no engine and a cache the gate never probes a marker for (marker standing=${present})`, async () => {
      const w = await world({ cacheStatus: "empty" });
      if (present) plantMarker(anotherTab(w).storage, account(w), "draft:a");
      refuseReads(w, true);
      const env = await controllerOver(
        w,
        pageMarkers(w.markerStorage.page("cold")),
      );
      // The premise: the cache gate has no marker to re-read, so its own paced timer is not running and cannot mask the facade's.
      expect(env.inputs.get().cache).toBe("empty");
      await w.advance(OUTAGE);
      expect(warned(env)).toBe(false);
      refuseReads(w, false);
      await w.advance(CAP);
      expect(env.outbox()?.storageNotResponding.get()).toBe(present);
      expect(warned(env)).toBe(present);
      env.dispose();
      finish(w);
    });

    test(`an attached leader's facade and the controller's own, on one page (marker standing=${present})`, async () => {
      const w = await world({ cacheStatus: "empty" });
      if (present) plantMarker(anotherTab(w).storage, account(w), "draft:a");
      refuseReads(w, true);
      const markers = pageMarkers(w.markerStorage.page("cold"));
      const env = await controllerOver(w, markers);
      const leader = facadeOver(w, markers, { dispatcher: w.dispatcher });
      env.attachLeader({ outbox: leader });
      await w.advance(OUTAGE);
      expect(warned(env)).toBe(false);
      refuseReads(w, false);
      await w.advance(CAP);
      expect(leader.storageNotResponding.get()).toBe(present);
      expect(env.outbox()?.storageNotResponding.get()).toBe(present);
      expect(warned(env)).toBe(present);
      env.dispose();
      finish(w);
    });
  }
});

// ---- Q3: each record that can be unreadable ------------------------------------------------------------------------------------------
type Refusal = "getter" | "enumeration" | "get" | "one key" | "database";
const REFUSALS: readonly Refusal[] = [
  "getter",
  "enumeration",
  "get",
  "one key",
  "database",
];

/** A facade built while `refusal` holds, over a stop of `draft:a` (a marker; for `database`, a durable streak) when `present`. */
async function coldFacade(
  w: OutboxWorld,
  refusal: Refusal,
  present: boolean,
): Promise<{ facade: Outbox; restore(): void; cleanup?(): void }> {
  if (present && refusal === "database") {
    w.env.idb.inject({
      match: (tx) => tx.label === "data.enqueueDraft",
      mode: "error",
      times: 3,
    });
    for (let i = 0; i < 3; i += 1)
      expect((await w.outbox.enqueue(request("a", "r-a"))).kind).toBe(
        "refused",
      );
    expect(w.sync().local_write_streaks["draft:a"]).toBe(3);
    // The world's facade recorded it; the page under test is a new one that never saw it.
    w.markers.stops.release(w.service, "draft:a");
  } else if (present) plantMarker(anotherTab(w).storage, account(w), "draft:a");
  switch (refusal) {
    case "getter": {
      // Blocked site data: the global getter throws when the page builds its markers, and returns the storage once access is granted.
      const unset = setGlobalStorage("throws");
      const markers = createWriteFailureMarkers(undefined, undefined, {
        ownSlot: 7,
      });
      const facade = facadeOver(w, markers);
      let granted: (() => void) | null = null;
      return {
        facade,
        restore: () => {
          unset();
          granted = setGlobalStorage(w.markerStorage);
        },
        // The global is put back as it was found, whatever happened.
        cleanup: () => {
          if (granted) granted();
          else unset();
        },
      };
    }
    case "enumeration":
      w.markerStorage.failEnumeration = true;
      return {
        facade: facadeOver(w, pageMarkers(w.markerStorage.page("cold"))),
        restore: () => {
          w.markerStorage.failEnumeration = false;
        },
      };
    case "get":
      w.markerStorage.failGets = true;
      return {
        facade: facadeOver(w, pageMarkers(w.markerStorage.page("cold"))),
        restore: () => {
          w.markerStorage.failGets = false;
        },
      };
    case "one key":
      w.markerStorage.failGetsFor = (key) => key.includes("draft:a");
      return {
        facade: facadeOver(w, pageMarkers(w.markerStorage.page("cold"))),
        restore: () => {
          w.markerStorage.failGetsFor = null;
        },
      };
    case "database": {
      const unrefuse = databaseRefused(w);
      return {
        facade: facadeOver(w, pageMarkers(w.markerStorage.page("cold"))),
        restore: unrefuse,
      };
    }
  }
}

describe("Q3: a refused getter, enumeration, item, single key or database read, restored with no event", () => {
  for (const refusal of REFUSALS)
    for (const present of [false, true])
      test(`${refusal} refused, stop standing=${present}: nothing is invented while unknown; the existing notice follows the records once read`, async () => {
        const w = await world();
        const reads = stopReads(w);
        const cold = await coldFacade(w, refusal, present);
        try {
          await w.settle();
          await w.advance(OUTAGE);
          // A refusal of one key that does not exist refuses nothing: the read is complete, and that is the control of the pace.
          const refusing = !(refusal === "one key" && !present);
          // An unread record is unknown, never a stop and never an absence. A marker that can still be FOUND (its directory names it and
          // its item can be read while the enumeration is refused) is a stop the incomplete read establishes (I1).
          expect(cold.facade.storageNotResponding.get()).toBe(
            present && refusal === "enumeration",
          );
          // While unsure it kept looking (paced); with nothing refused it looked once.
          if (refusing) expect(reads.length).toBeGreaterThan(2);
          else expect(reads).toHaveLength(1);
          cold.restore();
          await w.advance(CAP);
          expect(cold.facade.storageNotResponding.get()).toBe(present);
          // A look that read everything ends the pace, whether or not anything was found: nothing more is read.
          const after = reads.length;
          await w.advance(6 * CAP);
          expect(reads.length).toBe(after);
        } finally {
          cold.cleanup?.();
          finish(w);
        }
      });

  test("control: an environment with no `localStorage` at all is not a refusal; the facade knows the whole of it and schedules nothing", async () => {
    const w = await world();
    const reads = stopReads(w);
    const unset = setGlobalStorage("absent");
    try {
      const facade = facadeOver(
        w,
        createWriteFailureMarkers(undefined, undefined, { ownSlot: 7 }),
      );
      await w.settle();
      const first = reads.length;
      expect(first).toBe(1);
      await w.advance(OUTAGE);
      expect(reads.length).toBe(first);
      expect(facade.storageNotResponding.get()).toBe(false);
    } finally {
      unset();
      finish(w);
    }
  });
});

// ---- Q4/Q5: completeness transitions with the same operations, and warm outages ------------------------------------------------------
describe("Q4 and Q5: completeness is part of what the facade observes; a warm outage keeps what it knew and recovers", () => {
  test("Q4: [a] unknown -> [a] known: a known stop held while the database is unreadable stays, and the pace ends when the read completes", async () => {
    const w = await world();
    const reads = stopReads(w);
    const markers = pageMarkers(w.markerStorage.page("cold"));
    // A stop held in the page's memory alone: known whatever can be read.
    markers.stops.hold(w.service, "draft:a");
    const unrefuse = databaseRefused(w);
    const facade = facadeOver(w, markers);
    await w.advance(OUTAGE);
    expect(facade.storageNotResponding.get()).toBe(true);
    expect(facade.storageMemoryOnly.get()).toBe(true);
    unrefuse();
    await w.advance(CAP);
    expect(facade.storageNotResponding.get()).toBe(true);
    const after = reads.length;
    await w.advance(6 * CAP);
    expect(reads.length).toBe(after);
    finish(w);
  });

  test("Q4: a warm facade that finds the markers unreadable on another tab's change keeps its stop, and shows the change once they can be read", async () => {
    const w = await world();
    const reads = stopReads(w);
    const elsewhere = anotherTab(w);
    plantMarker(elsewhere.storage, account(w), "draft:a", "tab.1");
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(true);
    const healthy = reads.length;
    await w.advance(OUTAGE);
    // Healthy and settled: no paced look.
    expect(reads.length).toBe(healthy);
    refuseReads(w, true);
    // The other tab retires the marker during the outage: the event reaches this page, whose read is now incomplete.
    for (const key of markerKeys(w.markerStorage, account(w), "draft:a"))
      elsewhere.storage.removeItem(key);
    await w.settle();
    expect(reads.length).toBe(healthy + 1);
    // Unknown is not absence: the stop it knew stands.
    expect(facade.storageNotResponding.get()).toBe(true);
    await w.advance(OUTAGE);
    expect(facade.storageNotResponding.get()).toBe(true);
    refuseReads(w, false);
    await w.advance(CAP);
    expect(facade.storageNotResponding.get()).toBe(false);
    const after = reads.length;
    await w.advance(6 * CAP);
    expect(reads.length).toBe(after);
    finish(w);
  });

  test("Q4: a cold start that could not read the records stays unsure: a prompt that comes before the paced look is due is read, and shows the stop", async () => {
    const w = await world();
    const reads = stopReads(w);
    plantMarker(anotherTab(w).storage, account(w), "draft:a");
    refuseReads(w, true);
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
    await w.settle();
    expect(reads).toHaveLength(1);
    expect(facade.storageNotResponding.get()).toBe(false);
    // Access returns with no event; no time passes, so the paced look is not due. Another tab's change of the database is a prompt.
    refuseReads(w, false);
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts"],
    });
    await w.settle();
    expect(reads).toHaveLength(2);
    expect(facade.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("Q4: a later outage makes a warm facade unsure again (a hint is then heard), and a complete read makes it sure (a hint is not)", async () => {
    const w = await world();
    const reads = stopReads(w);
    const markers = pageMarkers(w.markerStorage.page("cold"));
    const facade = facadeOver(w, markers);
    await w.settle();
    const hint = (): void =>
      w.deliver({
        type: "data_changed",
        account: account(w),
        stores: ["drafts"],
      });
    // Healthy: nothing shown and nothing unsure, so another tab's change of the database is not read.
    let before = reads.length;
    hint();
    await w.settle();
    expect(reads.length).toBe(before);
    // The database becomes unreadable; another writer of the page announces a stop, and the look it causes cannot read the records.
    const unrefuse = databaseRefused(w);
    markers.stops.announce(w.service, {}, { recorded: ["draft:elsewhere"] });
    await w.settle();
    expect(reads.length).toBe(before + 1);
    expect(facade.storageNotResponding.get()).toBe(false);
    // Unsure again: a hint is read at once (the paced look is not due yet).
    before = reads.length;
    hint();
    await w.settle();
    expect(reads.length).toBe(before + 1);
    unrefuse();
    await w.advance(CAP);
    // Sure again: the hint is not read.
    before = reads.length;
    hint();
    await w.settle();
    expect(reads.length).toBe(before);
    finish(w);
  });

  test("Q5: two stops known, one retired elsewhere during the outage: no false clearing while unknown, the other shown after, and the end only on evidence", async () => {
    const w = await world();
    const elsewhere = anotherTab(w);
    plantMarker(elsewhere.storage, account(w), "draft:a", "tab.1");
    plantMarker(elsewhere.storage, account(w), "draft:b", "tab.1");
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
    await w.settle();
    const seen = history(facade.storageNotResponding);
    refuseReads(w, true);
    for (const key of markerKeys(w.markerStorage, account(w), "draft:a"))
      elsewhere.storage.removeItem(key);
    await w.advance(OUTAGE);
    refuseReads(w, false);
    await w.advance(CAP);
    expect(markerKeys(w.markerStorage, account(w), "draft:b")).toHaveLength(1);
    expect(seen).toEqual([true]);
    for (const key of markerKeys(w.markerStorage, account(w), "draft:b"))
      elsewhere.storage.removeItem(key);
    await w.settle();
    expect(seen).toEqual([true, false]);
    finish(w);
  });
});

// ---- Q6: held reads and newer signals ------------------------------------------------------------------------------------------------
/** The plan named `name` runs at once and its answer is delivered when `release()` is called (the NEXT run of it only). */
function holdNext(
  store: OutboxWorld["service"]["store"],
  name: string,
): { release(): void; held(): boolean } {
  const real = store.run.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let armed = true;
  let holding = false;
  let release: () => void = () => undefined;
  (store as { run: unknown }).run = (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== name) return answer;
    armed = false;
    holding = true;
    return new Promise<unknown>((resolve, reject) => {
      release = () => {
        holding = false;
        void answer.then(resolve, reject);
      };
    });
  };
  return { release: () => release(), held: () => holding };
}

describe("Q6: a read that is still to be answered never publishes over a newer signal, a newer act or the end of the service", () => {
  async function warmOnA(w: OutboxWorld) {
    const elsewhere = anotherTab(w);
    plantMarker(elsewhere.storage, account(w), "draft:a", "tab.1");
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(true);
    const removeA = (): void => {
      for (const key of markerKeys(w.markerStorage, account(w), "draft:a"))
        elsewhere.storage.removeItem(key);
    };
    return { facade, elsewhere, removeA };
  }

  test("a newer marker heard while the look that read none is held: that look publishes nothing, so the warning never flickers", async () => {
    const w = await world();
    const { facade, elsewhere, removeA } = await warmOnA(w);
    const seen = history(facade.storageNotResponding);
    const hold = holdNext(w.service.store, STOP_READS);
    removeA();
    await w.settle();
    expect(hold.held()).toBe(true);
    plantMarker(elsewhere.storage, account(w), "draft:b", "tab.1");
    await w.settle();
    hold.release();
    await w.settle();
    expect(seen).toEqual([true]);
    expect(facade.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("control, the reverse order: the held look is answered first and publishes its absence, then the newer marker is shown", async () => {
    const w = await world();
    const { facade, elsewhere, removeA } = await warmOnA(w);
    const seen = history(facade.storageNotResponding);
    const hold = holdNext(w.service.store, STOP_READS);
    removeA();
    await w.settle();
    hold.release();
    await w.settle();
    plantMarker(elsewhere.storage, account(w), "draft:b", "tab.1");
    await w.settle();
    expect(seen).toEqual([true, false, true]);
    finish(w);
  });

  test("control, no intervening change: the held look publishes what it read when answered", async () => {
    const w = await world();
    const { facade, removeA } = await warmOnA(w);
    const hold = holdNext(w.service.store, STOP_READS);
    removeA();
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(true);
    hold.release();
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("the service ends while the paced look is held: it publishes nothing, and nothing is read or scheduled afterwards", async () => {
    const w = await world();
    const reads = stopReads(w);
    plantMarker(anotherTab(w).storage, account(w), "draft:a");
    refuseReads(w, true);
    const counted = countedTimers(w);
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")), {
      timers: counted.timers,
    });
    await w.advance(OUTAGE);
    refuseReads(w, false);
    const hold = holdNext(w.service.store, STOP_READS);
    await w.advance(CAP);
    expect(hold.held()).toBe(true);
    w.service.dispose("closed");
    hold.release();
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(false);
    expect(counted.live()).toBe(0);
    const ended = reads.length;
    await w.advance(6 * CAP);
    expect(reads.length).toBe(ended);
    w.dispatcher.stop();
  });

  test("a save that succeeds while the paced look is held makes a look of its own, which answers it (it is not queued behind the held read)", async () => {
    const w = await world();
    plantMarker(anotherTab(w).storage, account(w), "draft:a");
    refuseReads(w, true);
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
    await w.advance(OUTAGE);
    refuseReads(w, false);
    const hold = holdNext(w.service.store, STOP_READS);
    await w.advance(CAP);
    expect(hold.held()).toBe(true);
    let outcome: string | null = null;
    void facade.enqueue(request("c")).then((answer) => {
      outcome = answer.kind;
    });
    await w.settle();
    expect(outcome).toBe("queued");
    expect(facade.storageNotResponding.get()).toBe(true);
    hold.release();
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(true);
    finish(w);
  });
});

// ---- Q7: bounded work ----------------------------------------------------------------------------------------------------------------
describe("Q7: one timer and one read at a time, paced and capped, quiet when healthy, and not driven by events", () => {
  test("a permanent refusal: the gaps between looks start at the first wait, never shrink, never exceed the cap, and one timer at most is pending", async () => {
    const w = await world();
    const reads = stopReads(w);
    refuseReads(w, true);
    const counted = countedTimers(w);
    facadeOver(w, pageMarkers(w.markerStorage.page("cold")), {
      timers: counted.timers,
    });
    let most = 0;
    for (let elapsed = 0; elapsed < 120_000; elapsed += 1_000) {
      await w.advance(1_000);
      most = Math.max(most, counted.live());
    }
    expect(most).toBe(1);
    const gaps = reads.slice(1).map((at, i) => at - (reads[i] as number));
    expect(gaps[0]).toBeGreaterThanOrEqual(FIRST);
    for (let i = 1; i < gaps.length; i += 1)
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] as number);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(CAP);
    // 120 s at a pace that reaches 10 s within its first 16 s: no more than 6 + 12 looks after the first.
    expect(reads.length).toBeLessThanOrEqual(1 + 6 + 12);
    expect(reads.length).toBeGreaterThanOrEqual(1 + 6 + 10);
    finish(w);
  });

  test("bursts of hints and of unchanged marker events during an outage add at most one look and never a second timer", async () => {
    const w = await world();
    const reads = stopReads(w);
    refuseReads(w, true);
    const counted = countedTimers(w);
    facadeOver(w, pageMarkers(w.markerStorage.page("cold")), {
      timers: counted.timers,
    });
    await w.settle();
    const before = reads.length;
    const elsewhere = anotherTab(w);
    for (let i = 0; i < 50; i += 1) {
      w.deliver({
        type: "data_changed",
        account: account(w),
        stores: ["drafts"],
      });
      // A marker of this account that is not the outbox's, and one of another account: the outbox's markers read the same (unknown).
      elsewhere.storage.setItem(`unrelated-${i}`, "1");
    }
    await w.settle();
    expect(reads.length - before).toBeLessThanOrEqual(2);
    expect(counted.live()).toBe(1);
    finish(w);
  });

  test("healthy and settled: no timer and no read, however long", async () => {
    const w = await world();
    const reads = stopReads(w);
    const counted = countedTimers(w);
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")), {
      timers: counted.timers,
    });
    await w.settle();
    expect(reads).toHaveLength(1);
    await w.advance(120_000);
    expect(reads).toHaveLength(1);
    expect(counted.live()).toBe(0);
    expect(facade.storageNotResponding.get()).toBe(false);
    finish(w);
  });
});

// ---- Q8: lifetimes -------------------------------------------------------------------------------------------------------------------
describe("Q8: the observation ends with its owner or its service, and a fresh one recovers independently", () => {
  test("the service ends while the pace is pending: the timer is cancelled and nothing is read", async () => {
    const w = await world();
    const reads = stopReads(w);
    refuseReads(w, true);
    const counted = countedTimers(w);
    facadeOver(w, pageMarkers(w.markerStorage.page("cold")), {
      timers: counted.timers,
    });
    await w.advance(OUTAGE);
    expect(counted.live()).toBe(1);
    w.service.dispose("closed");
    expect(counted.live()).toBe(0);
    const ended = reads.length;
    refuseReads(w, false);
    await w.advance(6 * CAP);
    expect(reads.length).toBe(ended);
    w.dispatcher.stop();
  });

  test("disposeObservation while the pace is pending: cancelled, idempotent, no read after, and the facade still saves", async () => {
    const w = await world();
    const reads = stopReads(w);
    refuseReads(w, true);
    const counted = countedTimers(w);
    const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")), {
      timers: counted.timers,
    });
    await w.advance(OUTAGE);
    expect(counted.live()).toBe(1);
    facade.disposeObservation();
    facade.disposeObservation();
    expect(counted.live()).toBe(0);
    const disposed = reads.length;
    refuseReads(w, false);
    await w.advance(6 * CAP);
    expect(reads.length).toBe(disposed);
    expect((await facade.enqueue(request("c"))).kind).toBe("queued");
    finish(w);
  });

  test("the controller is stopped with its service still live: its facade reads nothing more; started again, a fresh facade recovers on its own", async () => {
    const w = await world({ cacheStatus: "empty" });
    const reads = stopReads(w);
    plantMarker(anotherTab(w).storage, account(w), "draft:a");
    refuseReads(w, true);
    const env = await controllerOver(
      w,
      pageMarkers(w.markerStorage.page("cold")),
    );
    const first = env.outbox();
    await w.advance(OUTAGE);
    env.dispose();
    expect(w.service.live).toBe(true);
    const stopped = reads.length;
    await w.advance(6 * CAP);
    expect(reads.length).toBe(stopped);
    env.start();
    await w.settle();
    expect(env.outbox()).not.toBe(first);
    refuseReads(w, false);
    await w.advance(CAP);
    expect(warned(env)).toBe(true);
    expect(first?.storageNotResponding.get()).toBe(false);
    env.dispose();
    finish(w);
  });

  test("an obsolete leader detach does not end the replacement's observation; the replacement recovers and is shown", async () => {
    const w = await world({ cacheStatus: "empty" });
    plantMarker(anotherTab(w).storage, account(w), "draft:a");
    refuseReads(w, true);
    const markers = pageMarkers(w.markerStorage.page("cold"));
    const env = await controllerOver(w, markers);
    const old = facadeOver(w, markers);
    const detachOld = env.attachLeader({ outbox: old });
    const replacement = facadeOver(w, markers);
    env.attachLeader({ outbox: replacement });
    detachOld();
    detachOld();
    old.disposeObservation();
    await w.advance(OUTAGE);
    refuseReads(w, false);
    await w.advance(CAP);
    expect(replacement.storageNotResponding.get()).toBe(true);
    expect(warned(env)).toBe(true);
    expect(old.storageNotResponding.get()).toBe(false);
    env.dispose();
    finish(w);
  });
});

// ---- Q9: an act's entitlement is not enlarged by what recovery reads -----------------------------------------------------------------
describe("Q9: a newer failure found by the recovery is not ended by an act that began before it", () => {
  for (const newer of [true, false])
    test(`"Try again" for a stop whose newer instance appears while the act waits and the markers are unreadable (newer=${newer})`, async () => {
      const w = await world();
      const elsewhere = anotherTab(w);
      plantMarker(elsewhere.storage, account(w), "draft:a", "tab.1");
      const facade = facadeOver(w, pageMarkers(w.markerStorage.page("cold")));
      await w.settle();
      expect(facade.storageNotResponding.get()).toBe(true);
      const [witnessed] = markerKeys(w.markerStorage, account(w), "draft:a");
      // The act's durable reset is held, so the act is still under way when the newer failure arrives.
      const hold = holdNext(w.service.store, "data.recordLocalWriteOutcome");
      facade.retry("a");
      await w.settle();
      expect(hold.held()).toBe(true);
      expect(w.markerStorage.peek(witnessed as string)).toBe(null);
      refuseReads(w, true);
      if (newer) plantMarker(elsewhere.storage, account(w), "draft:a", "tab.2");
      await w.settle();
      hold.release();
      await w.settle();
      await w.advance(OUTAGE);
      refuseReads(w, false);
      await w.advance(CAP);
      const standing = markerKeys(w.markerStorage, account(w), "draft:a");
      expect(standing).toHaveLength(newer ? 1 : 0);
      if (newer) expect(standing[0]).not.toBe(witnessed);
      expect(facade.storageNotResponding.get()).toBe(newer);
      finish(w);
    });
});

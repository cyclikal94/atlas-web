// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import type { OutboxDispatcher } from "../../src/data/engine/outbox-dispatcher";
import {
  createLocalStops,
  createWriteFailureMarkers,
  markerKey,
} from "../../src/data/engine/write-failure-marker";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { deriveNotices } from "../../src/data/model/status";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { createDataEnv } from "../../src/data/ui/env";
import {
  markerKeys,
  pageMarkers,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R46 and R47 (revision 27): ONE stop, whichever writer holds it.
 *
 * A stop is the failure state of one logical operation, and the operation is written by more than one component of a page: the facade
 * (a save, an edit, a supersession, a discard) and the dispatcher (the claim) both write `draft:<id>`, and a page may hold more than one
 * facade (the controller's own, and the attached leader's). Revision 26 ended an operation's failures in the transaction that wrote
 * them and kept the marker, but each writer kept the stops that only the tab's memory held in a set of its own, so the writers could
 * neither see nor end one another's: a dispatcher stop the facade had succeeded in editing or discarding stayed, an ordinary wake
 * sent a draft whose facade stop was still standing, and, when a read of the record failed, the facade forgot the stops it knew of, so
 * an unrelated "Try again" hid them. The stops of the page's memory are now ONE record (`LocalStops`, with the markers), read by the
 * dispatcher with the markers and the record, ended by whichever writer succeeds or abandons, and announced to the other writers; and
 * what a look could not read it does not forget.
 *
 * FIXTURE evidence: the production facade, plans and dispatcher over the double of IndexedDB and of `localStorage`; no backend.
 */
const request = (
  localId: string,
  label: string = localId,
  target = "r",
): EnqueueRequest => ({
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
      label,
      expected_version: bases[target] as number,
    },
  }),
});

type Mechanism = "streak" | "marker" | "memory";
const MECHANISMS: Mechanism[] = ["streak", "marker", "memory"];

const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const account = (w: OutboxWorld): string => w.service.account;
const streaksOf = (w: OutboxWorld): Record<string, number> =>
  w.sync().local_write_streaks;
const markersOf = (w: OutboxWorld): string[] =>
  w.markers.operations(scopeOf(account(w))).sort();
const memoryOf = (w: OutboxWorld): string[] =>
  w.markers.stops.operations(w.service).sort();
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
/** Which record holds the stop of `operation`. */
const where = (w: OutboxWorld, operation: string) => ({
  streak: streaksOf(w)[operation] ?? 0,
  marker: markersOf(w).includes(operation),
  memory: memoryOf(w).includes(operation),
});
const NOTHING = { streak: 0, marker: false, memory: false };

/** A world with the cached resources the drafts below edit. */
async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r", version: 5 }),
    cacheRow({ id: "r-a", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
    cacheRow({ id: "r-c", version: 5 }),
    cacheRow({ id: "r-u", version: 5 }),
  ]);
  return w;
}

/** Another facade of the same page (the controller's own and the leader's are two), over the same service, dispatcher and markers. */
const secondFacade = (w: OutboxWorld, options: { dispatcher?: boolean } = {}) =>
  createOutbox({
    service: w.service,
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: {
      iso: () => new Date(w.now()).toISOString(),
      now: () => w.now(),
    },
    fence: () => w.fence,
    ...(options.dispatcher === false ? {} : { dispatcher: w.dispatcher }),
    markers: w.markers,
  });

/** The claim of the dispatcher fails by `mechanism`: the record counts it (three), or the counter and then the marker cannot be written. */
const armClaim = (w: OutboxWorld, mechanism: Mechanism): void => {
  fail(w, "data.markInFlight", mechanism === "streak" ? 3 : 1);
  if (mechanism !== "streak") fail(w, "data.recordLocalWriteOutcome", 1);
  w.markerStorage.failWrites = mechanism === "memory";
};

/** `a` is queued, and the dispatcher's claim of it fails by `mechanism` until the dispatcher stops it. */
async function dispatcherStop(
  w: OutboxWorld,
  mechanism: Mechanism,
): Promise<void> {
  expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
    "queued",
  );
  armClaim(w, mechanism);
  w.online = true;
  w.start();
  await w.settle();
  await w.advance(5_000);
  w.markerStorage.failWrites = false;
  expect(w.dispatcher.state.get().kind).toBe("stopped");
  expect(w.sent).toHaveLength(0);
  expect(where(w, "draft:a")).toEqual({
    streak: mechanism === "streak" ? 3 : 0,
    marker: mechanism === "marker",
    memory: mechanism === "memory",
  });
}

type FacadeMethod = "editQueued" | "discard";
const PLAN = {
  editQueued: "data.editQueuedDraft",
  discard: "data.discardDraft",
} as const;
const call = (
  outbox: Outbox,
  method: FacadeMethod,
  id: string,
  label = "new",
) =>
  method === "editQueued"
    ? outbox.editQueued(id, request(id, label))
    : outbox.discard(id);

/** The facade's own write of `id` fails by `mechanism` (three failures, or one whose counter and marker cannot be written). */
async function facadeStop(
  w: OutboxWorld,
  method: FacadeMethod,
  mechanism: Mechanism,
  id = "a",
  outbox: Outbox = w.outbox,
): Promise<void> {
  const times = mechanism === "streak" ? 3 : 1;
  fail(w, PLAN[method], times);
  if (mechanism !== "streak") fail(w, "data.recordLocalWriteOutcome", 1);
  w.markerStorage.failWrites = mechanism === "memory";
  for (let i = 0; i < times; i += 1)
    expect((await call(outbox, method, id)).kind).toBe("refused");
  w.markerStorage.failWrites = false;
  expect(outbox.storageNotResponding.get()).toBe(true);
  expect(outbox.storageMemoryOnly.get()).toBe(mechanism === "memory");
  expect(where(w, `draft:${id}`)).toEqual({
    streak: mechanism === "streak" ? 3 : 0,
    marker: mechanism === "marker",
    memory: mechanism === "memory",
  });
}

const bodies = (w: OutboxWorld): string[] => w.sent.map((s) => s.body);

// ---- the page's memory of its stops -------------------------------------------------------------------------------------------------
describe("LocalStops: the page's memory of the stops no store could hold", () => {
  const A = { account: "acct", incarnationId: "one" };

  test("holds, tells, and releases exactly the operation it is given, in exactly its scope", () => {
    const stops = createLocalStops();
    stops.hold(A, "draft:a");
    stops.hold(A, "receipt:a");
    stops.hold({ account: "acct", incarnationId: "two" }, "draft:a");
    stops.hold({ account: "other", incarnationId: "one" }, "draft:a");
    expect(stops.operations(A).sort()).toEqual(["draft:a", "receipt:a"]);
    expect(stops.has(A, "draft:a")).toBe(true);
    expect(stops.has(A, "draft:ba")).toBe(false);
    expect(stops.release(A, "draft:a")).toBe(true);
    expect(stops.release(A, "draft:a")).toBe(false);
    expect(stops.operations(A)).toEqual(["receipt:a"]);
    // The other incarnation (a database deleted and created again) and the other account are untouched.
    expect(stops.operations({ account: "acct", incarnationId: "two" })).toEqual(
      ["draft:a"],
    );
    expect(
      stops.operations({ account: "other", incarnationId: "one" }),
    ).toEqual(["draft:a"]);
  });

  test("an account's markers and its memory of stops are removed together (its database was deleted)", () => {
    const storage = new Map<string, string>();
    const markers = createWriteFailureMarkers(
      {
        get length() {
          return storage.size;
        },
        key: (index) => [...storage.keys()][index] ?? null,
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
        removeItem: (key) => void storage.delete(key),
      },
      undefined,
      { ownSlot: 0 },
    );
    markers.set(scopeOf("acct"), "draft:a");
    markers.stops.hold(A, "draft:b");
    markers.stops.hold({ account: "acct", incarnationId: "two" }, "draft:c");
    markers.stops.hold({ account: "other", incarnationId: "one" }, "draft:d");
    markers.clearAccount("acct");
    expect(markers.operations(scopeOf("acct"))).toEqual([]);
    expect(markers.stops.operations(A)).toEqual([]);
    expect(
      markers.stops.operations({ account: "acct", incarnationId: "two" }),
    ).toEqual([]);
    expect(
      markers.stops.operations({ account: "other", incarnationId: "one" }),
    ).toEqual(["draft:d"]);
  });

  test("an announcement reaches every listener with its news and its announcer, and one listener's defect stops no other", () => {
    const stops = createLocalStops();
    const heard: Array<[string, object]> = [];
    const me = {};
    stops.subscribe(() => {
      throw new Error("a defect");
    });
    const off = stops.subscribe((scope, from, news) => {
      heard.push([`${scope.account}/${news.ended?.join(",")}`, from]);
    });
    expect(() => stops.announce(A, me, { ended: ["draft:a"] })).not.toThrow();
    expect(heard).toEqual([["acct/draft:a", me]]);
    off();
    stops.announce(A, me, { ended: ["draft:a"] });
    expect(heard).toHaveLength(1);
  });

  test("two writers handed the same markers hold one record; markers of their own do not share it", async () => {
    const w = await world();
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
    // A facade given the dispatcher and no markers shares the dispatcher's record; the markers' own is the page's.
    expect(w.dispatcher.stops).toBe(w.markers.stops);
    finish(w);
  });
});

// ---- direction 1: a stop the dispatcher holds ends with the facade's success or abandonment ------------------------------------------
describe("R46: a stop the dispatcher holds ends when the facade's own write of that operation succeeds or abandons it", () => {
  type Method = "editQueued" | "discard" | "enqueue (a repeat)";
  const METHODS: Method[] = ["editQueued", "discard", "enqueue (a repeat)"];
  for (const mechanism of MECHANISMS)
    for (const method of METHODS)
      test(`the dispatcher's ${mechanism} stop of a draft ends on the facade's ${method}: the record, the marker and the memory are gone, the draft goes on`, async () => {
        const w = await world();
        await dispatcherStop(w, mechanism);
        // Histories that belong to other operations are not this success's to touch.
        w.setSync({
          local_write_streaks: {
            ...streaksOf(w),
            "draft:other": 2,
            "page:9": 1,
          },
        });

        const done =
          method === "editQueued"
            ? await w.outbox.editQueued("a", request("a", "edited"))
            : method === "discard"
              ? await w.outbox.discard("a")
              : await w.outbox.enqueue(request("a", "original"));
        expect(done.kind).toBe(
          method === "editQueued"
            ? "edited"
            : method === "discard"
              ? "discarded"
              : "queued",
        );
        await w.settle();
        await w.advance(10_000);

        // Nothing of the operation is held anywhere, and the unrelated histories are as they were.
        expect(where(w, "draft:a")).toEqual(NOTHING);
        expect(where(w, "receipt:a")).toEqual(NOTHING);
        expect(streaksOf(w)).toEqual({ "draft:other": 2, "page:9": 1 });
        expect(w.markers.stops.operations(w.service)).toEqual([]);
        expect(w.outbox.storageNotResponding.get()).toBe(false);
        expect(w.outbox.storageMemoryOnly.get()).toBe(false);
        expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
        if (method === "discard") {
          expect(w.drafts()).toHaveLength(0);
          expect(w.sent).toHaveLength(0);
        } else {
          // The draft is sent, once, under its own key, with what was saved last.
          expect(w.sent).toHaveLength(1);
          expect(w.sent[0]?.key).toBe("a");
          expect(bodies(w)[0]).toContain(
            method === "editQueued" ? '"label":"edited"' : '"label":"original"',
          );
          expect(w.drafts()[0]?.status).toBe("acknowledged");
        }
        finish(w);
      });

  for (const mechanism of MECHANISMS)
    test(`control: the explicit retry ends the dispatcher's ${mechanism} stop as well, and the draft is sent`, async () => {
      const w = await world();
      await dispatcherStop(w, mechanism);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(where(w, "draft:a")).toEqual(NOTHING);
      expect(w.sent).toHaveLength(1);
      expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
      finish(w);
    });

  for (const mechanism of MECHANISMS)
    test(`another draft's ${mechanism} stop stays when this draft's success ends its own, and the dispatcher keeps holding that one back`, async () => {
      const w = await world();
      await dispatcherStop(w, mechanism);
      // A second draft, stopped the same way by the dispatcher (the fault is armed before the save that wakes it).
      armClaim(w, mechanism);
      expect(
        (await w.outbox.enqueue(request("b", "b-original", "r-b"))).kind,
      ).toBe("queued");
      await w.settle();
      await w.advance(5_000);
      w.markerStorage.failWrites = false;
      expect(where(w, "draft:b")).toEqual({
        streak: mechanism === "streak" ? 3 : 0,
        marker: mechanism === "marker",
        memory: mechanism === "memory",
      });

      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      await w.advance(10_000);
      expect(where(w, "draft:a")).toEqual(NOTHING);
      expect(where(w, "draft:b")).toEqual({
        streak: mechanism === "streak" ? 3 : 0,
        marker: mechanism === "marker",
        memory: mechanism === "memory",
      });
      expect(w.sent).toHaveLength(0);
      expect(w.dispatcher.state.get().kind).toBe("stopped");
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(w.outbox.storageMemoryOnly.get()).toBe(mechanism === "memory");
      finish(w);
    });

  test("a draft the facade replaces (supersession) ends the dispatcher's stop of the draft it abandons and of its own receipt", async () => {
    const w = await world();
    expect((await w.outbox.enqueue(request("old", "old"))).kind).toBe("queued");
    w.script.push(w.error(409, "operation_conflict"));
    w.online = true;
    w.start();
    await w.settle();
    expect(w.drafts()[0]?.status).toBe("operation_conflict");
    // Its receipt stops are the dispatcher's; one is held in the memory of the page.
    w.markers.stops.hold(w.service, "receipt:old");
    w.markers.stops.hold(w.service, "draft:old");
    expect(
      (await w.outbox.supersede("old", request("new", "replacement"))).kind,
    ).toBe("superseded");
    await w.settle();
    expect(w.markers.stops.operations(w.service)).toEqual([]);
    finish(w);
  });
});

// ---- direction 2: a stop the facade holds is honoured by the dispatcher -------------------------------------------------------------
describe("R46: an ordinary wake honours a stop the facade holds, in every mechanism, until recovery or an explicit retry", () => {
  const OLD_AND_NEW = '"label":"original"';
  for (const mechanism of MECHANISMS)
    for (const method of ["editQueued", "discard"] as const)
      test(`a ${mechanism} stop of the facade's ${method}: a start, a wake, coming online, a restart and a long wait send nothing, and another draft is still sent`, async () => {
        const w = await world();
        expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
          "queued",
        );
        await facadeStop(w, method, mechanism);

        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        for (let i = 0; i < 3; i += 1) {
          w.fire();
          w.goOnline();
          await w.settle();
          await w.advance(60_000);
        }
        w.dispatcher.stop();
        w.start();
        await w.settle();
        await w.advance(60_000);
        expect(w.sent).toHaveLength(0);
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "local_storage",
          ...(mechanism === "memory" ? { memoryOnly: true } : {}),
        });
        expect(w.drafts().find((d) => d.local_id === "a")?.status).toBe(
          "queued",
        );
        // The stop is the draft's: a different draft is sent, and its success does not lift this stop.
        expect(
          (await w.outbox.enqueue(request("b", "b-label", "r-b"))).kind,
        ).toBe("queued");
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key)).toEqual(["b"]);
        expect(where(w, "draft:a")).toEqual({
          streak: mechanism === "streak" ? 3 : 0,
          marker: mechanism === "marker",
          memory: mechanism === "memory",
        });
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        finish(w);
      });

  for (const mechanism of MECHANISMS)
    for (const recovery of [
      "the facade's retry",
      "the dispatcher's retry",
      "the unscoped retry",
    ] as const)
      test(`a ${mechanism} stop of the facade's edit ends with ${recovery}, and the draft is then sent under its own key with what was saved`, async () => {
        const w = await world();
        expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
          "queued",
        );
        await facadeStop(w, "editQueued", mechanism);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);

        if (recovery === "the facade's retry") w.outbox.retry("a");
        else if (recovery === "the dispatcher's retry") w.dispatcher.retry("a");
        else w.outbox.retry();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(1);
        expect(w.sent[0]?.key).toBe("a");
        expect(bodies(w)[0]).toContain(OLD_AND_NEW);
        expect(where(w, "draft:a")).toEqual(NOTHING);
        expect(w.markers.stops.operations(w.service)).toEqual([]);
        if (recovery !== "the dispatcher's retry") {
          expect(w.outbox.storageNotResponding.get()).toBe(false);
          expect(w.outbox.storageMemoryOnly.get()).toBe(false);
        }
        expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
        finish(w);
      });

  for (const mechanism of MECHANISMS)
    test(`a ${mechanism} stop of the facade's edit ends with the edit's own success, and the draft is sent with what the success saved`, async () => {
      const w = await world();
      expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await facadeStop(w, "editQueued", mechanism);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);

      expect((await w.outbox.editQueued("a", request("a", "saved"))).kind).toBe(
        "edited",
      );
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(1);
      expect(bodies(w)[0]).toContain('"label":"saved"');
      expect(where(w, "draft:a")).toEqual(NOTHING);
      expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      finish(w);
    });

  for (const mechanism of MECHANISMS)
    test(`a ${mechanism} stop of the facade's discard ends with the discard's own success, and nothing is ever sent`, async () => {
      const w = await world();
      expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await facadeStop(w, "discard", mechanism);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(w.drafts()).toHaveLength(0);
      expect(where(w, "draft:a")).toEqual(NOTHING);
      expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
      finish(w);
    });

  test("a draft that becomes eligible LATER (the draft before it settles) is still held back by a stop recorded in the meantime", async () => {
    const w = await world();
    w.online = true;
    // `first` and `a` share a target, so `a` waits for `first` to settle; `first` is sent, fails to reach the server, and backs off.
    w.script.push(new Error("network"));
    w.start();
    await w.settle();
    expect((await w.outbox.enqueue(request("first", "first"))).kind).toBe(
      "queued",
    );
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["first"]);
    expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
      "queued",
    );
    // The facade's edit of `a` fails and the stop can be recorded nowhere but in this tab's memory.
    await facadeStop(w, "editQueued", "memory");
    await w.advance(120_000);
    // `first` was resent and settled; `a` is now the draft the queue would send, and is not.
    expect(w.sent.map((s) => s.key)).toEqual(["first", "first"]);
    expect(w.drafts().find((d) => d.local_id === "first")?.status).toBe(
      "acknowledged",
    );
    expect(w.drafts().find((d) => d.local_id === "a")?.status).toBe("queued");
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
    w.outbox.retry("a");
    await w.settle();
    await w.advance(10_000);
    expect(w.sent.map((s) => s.key)).toEqual(["first", "first", "a"]);
    finish(w);
  });
});

// ---- a facade that is not composed with the dispatcher (the controller's own) -----------------------------------------------------
describe("R46: a facade the dispatcher was not composed with still ends the dispatcher's stop, and a healthy save costs it nothing", () => {
  for (const mechanism of MECHANISMS)
    for (const method of ["editQueued", "discard"] as const)
      test(`the dispatcher's ${mechanism} stop ends on the ${method} of a facade that has no dispatcher, and the dispatcher looks again by itself`, async () => {
        const w = await world();
        await dispatcherStop(w, mechanism);
        const apart = secondFacade(w, { dispatcher: false });
        await w.settle();
        // It shows the stop it did not record, and ends it with its own success or abandonment.
        expect(apart.storageNotResponding.get()).toBe(true);
        expect(apart.storageMemoryOnly.get()).toBe(mechanism === "memory");
        expect((await call(apart, method, "a", "apart")).kind).toBe(
          method === "editQueued" ? "edited" : "discarded",
        );
        await w.settle();
        await w.advance(10_000);
        expect(where(w, "draft:a")).toEqual(NOTHING);
        expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
        expect(w.sent).toHaveLength(method === "editQueued" ? 1 : 0);
        if (method === "editQueued")
          expect(bodies(w)[0]).toContain('"label":"apart"');
        expect(w.outbox.storageNotResponding.get()).toBe(false);
        expect(apart.storageNotResponding.get()).toBe(false);
        finish(w);
      });

  test("a draft the dispatcher stalled is released by a LONE wake when its stop ended in the record (another tab's retry), and is sent at once", async () => {
    const w = await world();
    await dispatcherStop(w, "streak");
    // Another tab ended the stop; nothing of this page's writers is involved, and ONE notification reaches the dispatcher.
    w.setSync({ local_write_streaks: {} });
    w.fire();
    await w.settle();
    // No further wake and no time has passed: the release of the draft is followed by a look at the queue, which sends it.
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.key).toBe("a");
    expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    finish(w);
  });

  test("a facade that is not composed with the dispatcher lifts the dispatcher's memory stop by its own retry", async () => {
    const w = await world();
    await dispatcherStop(w, "memory");
    const apart = secondFacade(w, { dispatcher: false });
    await w.settle();
    apart.retry("a");
    await w.settle();
    expect(memoryOf(w)).toEqual([]);
    expect(apart.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("the dispatcher's retry lifts a stop the page holds in memory that the dispatcher has not looked at yet", async () => {
    const w = await world();
    expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
      "queued",
    );
    // The page is offline: the dispatcher runs and has read nothing.
    w.start();
    await w.settle();
    await facadeStop(w, "editQueued", "memory");
    w.dispatcher.retry("a");
    await w.settle();
    expect(memoryOf(w)).toEqual([]);
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    // Another draft's stop is not the retry's.
    w.markers.stops.hold(w.service, "draft:other");
    w.dispatcher.retry("a");
    await w.settle();
    expect(memoryOf(w)).toEqual(["draft:other"]);
    w.dispatcher.retry();
    await w.settle();
    expect(memoryOf(w)).toEqual([]);
    finish(w);
  });

  test("the dispatcher holding a draft back does not step for news of another account, or of another lifetime of this account's database", async () => {
    const w = await world();
    await dispatcherStop(w, "memory");
    const looks = countPlan(w.service.store, "data.readDispatchWindow");
    for (const where of [
      { account: "someone-else", incarnationId: w.service.incarnationId },
      { account: account(w), incarnationId: "an-older-incarnation" },
    ])
      w.markers.stops.announce(where, {}, { ended: ["draft:a"] });
    await w.settle();
    expect(looks()).toBe(0);
    // News of this account's own database does make it look again.
    w.markers.stops.announce(
      { account: account(w), incarnationId: w.service.incarnationId },
      {},
      { ended: ["draft:a"] },
    );
    await w.settle();
    expect(looks()).toBeGreaterThan(0);
    finish(w);
  });

  test("a memory stop that appeared for the draft while its request was in flight ends with the receipt that landed", async () => {
    const w = await world();
    w.online = true;
    w.start();
    let answer: () => void = () => undefined;
    w.script.push(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(w.receipt());
        }),
    );
    expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
      "queued",
    );
    await w.settle();
    expect(w.sent).toHaveLength(1);
    // While the request is out, another writer of the page records a stop of the draft's receipt that no store could hold.
    w.markers.stops.hold(w.service, "receipt:a");
    w.markers.stops.announce(
      { account: account(w), incarnationId: w.service.incarnationId },
      {},
      { recorded: ["receipt:a"] },
    );
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    answer();
    await w.settle();
    expect(w.drafts()[0]?.status).toBe("acknowledged");
    expect(memoryOf(w)).toEqual([]);
    // The facade that showed it is told that it ended.
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
    finish(w);
  });

  test("a healthy save by a facade the dispatcher was not composed with does not make the dispatcher look at the queue", async () => {
    const w = await world();
    w.online = true;
    w.start();
    await w.settle();
    const apart = secondFacade(w, { dispatcher: false });
    const looks = countPlan(w.service.store, "data.readDispatchWindow");
    expect((await apart.enqueue(request("a", "original"))).kind).toBe("queued");
    // Nothing is held back, so there is nothing for an announcement to release: the dispatcher has not been told to step.
    expect(looks()).toBe(0);
    finish(w);
  });
});

// ---- a retirement that cannot be established ---------------------------------------------------------------------------------------
describe("R46: a stop whose clearing cannot be established stands in every writer", () => {
  const removalFails = (w: OutboxWorld): (() => void) => {
    const storage = w.markerStorage as unknown as {
      removeItem: (key: string) => void;
    };
    storage.removeItem = () => {
      throw new Error("the marker cannot be removed");
    };
    return () => void Reflect.deleteProperty(storage, "removeItem");
  };

  test("a marker that cannot be removed keeps the dispatcher's stop standing after the facade's success, in the dispatcher and the warning, until it is removed", async () => {
    const w = await world();
    await dispatcherStop(w, "marker");
    const restore = removalFails(w);
    expect((await w.outbox.editQueued("a", request("a", "edited"))).kind).toBe(
      "edited",
    );
    await w.settle();
    await w.advance(10_000);
    // The record is clean (the plan ended it in the transaction), the marker is not: the draft is still stopped, and says so.
    expect(streaksOf(w)["draft:a"]).toBeUndefined();
    expect(markersOf(w)).toEqual(["draft:a"]);
    expect(w.sent).toHaveLength(0);
    expect(w.dispatcher.state.get().kind).toBe("stopped");
    expect(w.outbox.storageNotResponding.get()).toBe(true);

    restore();
    // The next success of the same operation removes it, and the draft goes on.
    expect((await w.outbox.editQueued("a", request("a", "again"))).kind).toBe(
      "edited",
    );
    await w.settle();
    await w.advance(10_000);
    expect(markersOf(w)).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(bodies(w)[0]).toContain('"label":"again"');
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a retry whose durable clearing cannot be written leaves the record's stop standing in both writers; the next retry ends it", async () => {
    const w = await world();
    await dispatcherStop(w, "streak");
    // Every clearing of the draft's operations fails (the facade's and the dispatcher's, each more than once).
    const broken = fail(w, "data.recordLocalWriteOutcome", 1_000);
    w.outbox.retry("a");
    await w.settle();
    await w.advance(10_000);
    expect(streaksOf(w)["draft:a"]).toBe(3);
    expect(w.sent).toHaveLength(0);
    expect(w.dispatcher.state.get().kind).toBe("stopped");
    expect(w.outbox.storageNotResponding.get()).toBe(true);

    broken();
    w.outbox.retry("a");
    await w.settle();
    await w.advance(10_000);
    expect(streaksOf(w)).toEqual({});
    expect(w.sent).toHaveLength(1);
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a memory stop is lifted by a retry even when the durable clearing cannot be written: the person lifted the only thing that held it", async () => {
    const w = await world();
    await dispatcherStop(w, "memory");
    fail(w, "data.recordLocalWriteOutcome", 1_000);
    w.outbox.retry("a");
    await w.settle();
    await w.advance(10_000);
    expect(memoryOf(w)).toEqual([]);
    expect(w.sent).toHaveLength(1);
    finish(w);
  });
});

// ---- a new writer in the same page ------------------------------------------------------------------------------------------------
describe("R46: a writer that starts later in the same page finds the page's stops", () => {
  for (const mechanism of MECHANISMS)
    test(`a new dispatcher and facade (a change of leader in a live page) honour a ${mechanism} stop the old facade recorded, and the facade shows it at once`, async () => {
      const w = await world();
      expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await facadeStop(w, "editQueued", mechanism);
      w.rebuild();
      await w.settle();
      // The new facade shows what stands without anything being retried; the memory-only form is the page's, not the facade's.
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(w.outbox.storageMemoryOnly.get()).toBe(mechanism === "memory");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(60_000);
      expect(w.sent).toHaveLength(0);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(1);
      finish(w);
    });

  test("a reload forgets the memory-only stop (the disclosed limitation) and keeps the durable and the marker forms", async () => {
    for (const mechanism of MECHANISMS) {
      const w = await world();
      expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await facadeStop(w, "editQueued", mechanism);
      w.reload();
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      if (mechanism === "memory") {
        expect(w.sent).toHaveLength(1);
        expect(w.outbox.storageNotResponding.get()).toBe(false);
      } else {
        expect(w.sent).toHaveLength(0);
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        expect(w.dispatcher.state.get().kind).toBe("stopped");
      }
      finish(w);
    }
  });

  test("a facade composed with a dispatcher and given no markers shares the dispatcher's record; a facade with neither has its own", async () => {
    const w = await world();
    const record = createLocalStops();
    const dispatcher = {
      state: {
        get: () => ({ kind: "idle" as const }),
        subscribe: () => () => undefined,
      },
      stops: record,
      start: () => undefined,
      stop: () => undefined,
      retry: () => undefined,
      wake: () => undefined,
      settled: async () => undefined,
    } satisfies OutboxDispatcher;
    const make = (extra: object) =>
      createOutbox({
        service: w.service,
        quota: w.quota,
        ids: { uuid: () => crypto.randomUUID() },
        clock: {
          iso: () => new Date(w.now()).toISOString(),
          now: () => w.now(),
        },
        fence: () => w.fence,
        ...extra,
      });
    const composed = make({ dispatcher });
    expect((await composed.enqueue(request("a", "original"))).kind).toBe(
      "queued",
    );
    // No markers at all: the stop that cannot be counted can be held in memory only, and that is the dispatcher's record.
    fail(w, "data.editQueuedDraft", 1);
    fail(w, "data.recordLocalWriteOutcome", 1);
    expect((await composed.editQueued("a", request("a", "new"))).kind).toBe(
      "refused",
    );
    expect(record.operations(w.service)).toEqual(["draft:a"]);
    expect(composed.storageMemoryOnly.get()).toBe(true);

    const alone = make({});
    fail(w, "data.editQueuedDraft", 1);
    fail(w, "data.recordLocalWriteOutcome", 1);
    expect((await alone.editQueued("a", request("a", "new"))).kind).toBe(
      "refused",
    );
    expect(alone.storageMemoryOnly.get()).toBe(true);
    expect(record.operations(w.service)).toEqual(["draft:a"]);
    finish(w);
  });
});

// ---- the controller's own composition ------------------------------------------------------------------------------------------------
/** The controller over the world's page: its own facade, and the world's markers (the page's). */
async function envOver(w: OutboxWorld) {
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
    clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    // The page's markers: what the controller, the leader's facade and the leader's dispatcher are all given.
    markers: w.markers,
  });
  await w.settle();
  return env;
}
const noticesOf = (env: Awaited<ReturnType<typeof envOver>>) =>
  deriveNotices(env.inputs.get()).filter(
    (notice) => notice.kind === "storage_not_responding",
  );

describe("R46 and R47: the controller's facade and the attached leader are two facades of one page", () => {
  for (const mechanism of MECHANISMS)
    test(`a ${mechanism} stop of a save made through the controller's facade is honoured by the leader's dispatcher, shown through the leader's facade, and ended by the controller's own success`, async () => {
      const w = await world();
      const env = await envOver(w);
      const facade = env.outbox();
      if (facade === null)
        throw new Error("setup: the controller has no outbox");
      env.attachLeader({ outbox: w.outbox });
      expect((await facade.enqueue(request("a", "original"))).kind).toBe(
        "queued",
      );
      await facadeStop(w, "editQueued", mechanism, "a", facade);
      await w.settle();
      // What the person reads follows the leader's facade (and its dispatcher), which did not write the failure.
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(noticesOf(env)).toEqual([
        { kind: "storage_not_responding", memoryOnly: mechanism === "memory" },
      ]);

      w.online = true;
      w.start();
      await w.settle();
      await w.advance(60_000);
      expect(w.sent).toHaveLength(0);

      expect((await facade.editQueued("a", request("a", "saved"))).kind).toBe(
        "edited",
      );
      await w.settle();
      await w.advance(10_000);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      expect(noticesOf(env)).toEqual([]);
      expect(w.sent).toHaveLength(1);
      expect(bodies(w)[0]).toContain('"label":"saved"');
      env.dispose();
      finish(w);
    });
});

// ---- R47: what a look could not read is not forgotten --------------------------------------------------------------------------------
/** Three failures of the save of `id` leave its durable stop (count three). */
async function durableStop(
  w: OutboxWorld,
  id: string,
  outbox: Outbox = w.outbox,
): Promise<void> {
  fail(w, "data.enqueueDraft", 3);
  for (let i = 0; i < 3; i += 1)
    expect((await outbox.enqueue(request(id, id, `r-${id}`))).kind).toBe(
      "refused",
    );
  expect(streaksOf(w)[`draft:${id}`]).toBe(3);
  expect(outbox.storageNotResponding.get()).toBe(true);
}
const unreadable = (w: OutboxWorld, times = 1_000) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.readLocalWriteStops",
    mode: "error",
    times,
  });
/** The plan named `name` runs at once and its answer is delivered when `release()` is called: a read made before a write and told of after. */
function delayResult(
  store: OutboxWorld["service"]["store"],
  name: string,
): { release(): void } {
  const real = store.run.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let armed = true;
  let release: () => void = () => undefined;
  (store as { run: unknown }).run = (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== name) return answer;
    armed = false;
    return new Promise<unknown>((resolve, reject) => {
      release = () => {
        void answer.then(resolve, reject);
      };
    });
  };
  return { release: () => release() };
}
/** How many times a plan was run (a count of its transactions). */
function countPlan(
  store: OutboxWorld["service"]["store"],
  name: string,
): () => number {
  const real = store.run.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let runs = 0;
  (store as { run: unknown }).run = (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => {
    if (plan.name === name) runs += 1;
    return real(plan, input, options);
  };
  return () => runs;
}
/** How many times the record of stops was read. */
const countReads = (store: OutboxWorld["service"]["store"]): (() => number) =>
  countPlan(store, "data.readLocalWriteStops");

describe("R47: an unreadable record is UNKNOWN, not empty: a stop this page knew of stands until its retirement is established", () => {
  for (const reads of [1, 2, 3, 20])
    for (const prefix of ["retry", "save", "discard", "edit"] as const)
      test(`B's durable stop outlasts ${reads} unreadable look(s) after ${prefix} of an unrelated draft, however often the retry is repeated, and then ends only with B's own retry`, async () => {
        const w = await world();
        await durableStop(w, "b");
        expect((await w.outbox.enqueue(request("u", "u", "r-u"))).kind).toBe(
          "queued",
        );
        const broken = unreadable(w, reads);
        if (prefix === "retry") w.outbox.retry("u");
        else if (prefix === "save")
          expect((await w.outbox.enqueue(request("x", "x", "r-a"))).kind).toBe(
            "queued",
          );
        else if (prefix === "discard")
          expect((await w.outbox.discard("u")).kind).toBe("discarded");
        else
          expect(
            (await w.outbox.editQueued("u", request("u", "u2", "r-u"))).kind,
          ).toBe("edited");
        await w.settle();
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        for (let i = 0; i < 3; i += 1) {
          w.outbox.retry("u");
          await w.settle();
          expect(w.outbox.storageNotResponding.get()).toBe(true);
        }
        expect(streaksOf(w)["draft:b"]).toBe(3);

        // The record can be read again, and B is still stopped: the answer is the record's.
        broken();
        w.outbox.retry("u");
        await w.settle();
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        expect(streaksOf(w)["draft:b"]).toBe(3);

        w.outbox.retry("b");
        await w.settle();
        expect(streaksOf(w)).toEqual({});
        expect(w.outbox.storageNotResponding.get()).toBe(false);
        finish(w);
      });

  test("a stop this page's own successful save ended is not shown as gone while the record is unreadable (a read that could not be made never says recovered), and is as soon as one lands", async () => {
    const w = await world();
    await durableStop(w, "b");
    const broken = unreadable(w);
    expect((await w.outbox.enqueue(request("b", "b", "r-b"))).kind).toBe(
      "queued",
    );
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    broken();
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts"],
    });
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("the unscoped retry lifts what the page knew of while the record cannot be read, and the warning ends only because the clearing was written", async () => {
    const w = await world();
    await durableStop(w, "b");
    unreadable(w);
    w.outbox.retry();
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a retry whose clearing cannot be written, with the record unreadable, keeps the warning: nothing established a recovery", async () => {
    const w = await world();
    await durableStop(w, "b");
    unreadable(w);
    const broken = fail(w, "data.recordLocalWriteOutcome", 1_000);
    w.outbox.retry("b");
    await w.settle();
    expect(streaksOf(w)["draft:b"]).toBe(3);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    // Both can be done again: the next retry lifts it.
    broken();
    w.outbox.retry("b");
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    finish(w);
  });

  test("a stop another writer retired is not shown as ended while the record cannot be read; it is, as soon as a read says so", async () => {
    const w = await world();
    await durableStop(w, "b");
    const other = secondFacade(w);
    const broken = unreadable(w);
    expect((await other.enqueue(request("b", "b", "r-b"))).kind).toBe("queued");
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    // The record is clean, but this facade cannot read it: it still shows what it knew.
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    broken();
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts", "resource_versions"],
    });
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("stops of the markers and of the page's memory are known without the record, and survive its unreadability too", async () => {
    const w = await world();
    expect((await w.outbox.enqueue(request("a", "a", "r-a"))).kind).toBe(
      "queued",
    );
    expect((await w.outbox.enqueue(request("b", "b", "r-b"))).kind).toBe(
      "queued",
    );
    await facadeStop(w, "editQueued", "marker", "a");
    await facadeStop(w, "editQueued", "memory", "b");
    unreadable(w);
    expect((await w.outbox.enqueue(request("u", "u", "r-u"))).kind).toBe(
      "queued",
    );
    w.outbox.retry("a");
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(w.outbox.storageMemoryOnly.get()).toBe(true);
    w.outbox.retry("b");
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
    finish(w);
  });

  test("the notice a person reads keeps the stop through every unreadable reconciliation, and ends with the stop's own retry (the controller's own facade)", async () => {
    const w = await world();
    const env = await envOver(w);
    const facade = env.outbox();
    if (facade === null) throw new Error("setup: the controller has no outbox");
    await durableStop(w, "b", facade);
    await w.settle();
    expect(noticesOf(env)).toHaveLength(1);
    unreadable(w);
    expect((await facade.enqueue(request("u", "u", "r-u"))).kind).toBe(
      "queued",
    );
    env.actions.retryChanges("u");
    await w.settle();
    env.actions.retryChanges("u");
    await w.settle();
    expect(env.inputs.get().storageNotResponding).toBe(true);
    expect(noticesOf(env)).toHaveLength(1);
    expect(streaksOf(w)["draft:b"]).toBe(3);
    env.actions.retryChanges("b");
    await w.settle();
    expect(noticesOf(env)).toHaveLength(0);
    expect(streaksOf(w)).toEqual({});
    env.dispose();
    finish(w);
  });
});

// ---- R47: another writer's change reaches the warning ------------------------------------------------------------------------------
describe("R47: the warning follows the stops that stand, whichever writer of the page recorded or ended them", () => {
  for (const mechanism of MECHANISMS)
    for (const order of [
      "made after the stop",
      "made before the stop",
    ] as const)
      for (const action of ["edit", "discard", "retry"] as const)
        test(`a ${mechanism} stop recorded by one facade: the other facade (${order}) shows it, and its own ${action} takes the first one's warning down, with no message from another tab`, async () => {
          const w = await world();
          expect((await w.outbox.enqueue(request("a", "a", "r-a"))).kind).toBe(
            "queued",
          );
          const early =
            order === "made before the stop" ? secondFacade(w) : null;
          await facadeStop(w, "editQueued", mechanism, "a");
          await w.settle();
          const other = early ?? secondFacade(w);
          await w.settle();
          // Both show what stands, and the memory-only form is the page's.
          for (const facade of [w.outbox, other]) {
            expect(facade.storageNotResponding.get()).toBe(true);
            expect(facade.storageMemoryOnly.get()).toBe(mechanism === "memory");
          }

          if (action === "edit")
            expect(
              (await other.editQueued("a", request("a", "x", "r-a"))).kind,
            ).toBe("edited");
          else if (action === "discard")
            expect((await other.discard("a")).kind).toBe("discarded");
          else other.retry("a");
          await w.settle();
          expect(where(w, "draft:a")).toEqual(NOTHING);
          for (const facade of [w.outbox, other]) {
            expect(facade.storageNotResponding.get()).toBe(false);
            expect(facade.storageMemoryOnly.get()).toBe(false);
          }
          finish(w);
        });

  for (const mechanism of MECHANISMS)
    test(`a ${mechanism} stop the dispatcher records is shown by the facade at once, and ends with the facade's discard`, async () => {
      const w = await world();
      await dispatcherStop(w, mechanism);
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(w.outbox.storageMemoryOnly.get()).toBe(mechanism === "memory");
      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      expect(w.outbox.storageMemoryOnly.get()).toBe(false);
      finish(w);
    });

  test("another tab's success (the record) reaches a facade through the hint it posts, and a hint is read only while a stop is shown or unsure", async () => {
    const w = await world();
    const reads = countReads(w.service.store);
    await w.settle();
    // Nothing is shown and nothing is unsure: a hint is not read at all.
    const quiet = reads();
    for (let i = 0; i < 5; i += 1)
      w.deliver({
        type: "data_changed",
        account: account(w),
        stores: ["drafts"],
      });
    await w.settle();
    expect(reads()).toBe(quiet);

    await durableStop(w, "b");
    await w.settle();
    // Another tab ended the stop: the record says so, and the hint reaches this page.
    w.setSync({ local_write_streaks: {} });
    const before = reads();
    // A burst of hints is one look, and at most one more.
    for (let i = 0; i < 20; i += 1)
      w.deliver({
        type: "data_changed",
        account: account(w),
        stores: ["drafts"],
      });
    await w.settle();
    expect(reads() - before).toBeLessThanOrEqual(2);
    expect(reads() - before).toBeGreaterThanOrEqual(1);
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a hint for another account is not read", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const reads = countReads(w.service.store);
    w.deliver({
      type: "data_changed",
      account: "someone-else",
      stores: ["drafts"],
    });
    await w.settle();
    expect(reads()).toBe(0);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("a marker another tab removes is heard by a facade that listens to the markers' feed, and ends its warning", async () => {
    const w = await world();
    const markers = pageMarkers(w.markerStorage);
    const facade = createOutbox({
      service: w.service,
      quota: w.quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: { iso: () => new Date(w.now()).toISOString(), now: () => w.now() },
      fence: () => w.fence,
      markers,
    });
    expect((await facade.enqueue(request("a", "a", "r-a"))).kind).toBe(
      "queued",
    );
    await facadeStop(w, "editQueued", "marker", "a", facade);
    const elsewhere = w.markerStorage.page("another-tab");
    // ADAPTED, revision 32: a marker is a key of its own, so "removing the marker" is removing the key (or keys) that stand.
    for (const key of markerKeys(w.markerStorage, account(w), "draft:a"))
      elsewhere.storage.removeItem(key);
    await w.settle();
    expect(markersOf(w)).toEqual([]);
    expect(facade.storageNotResponding.get()).toBe(false);
    // And one it sets is shown.
    plantMarker(elsewhere.storage, account(w), "draft:a", "tab.1");
    await w.settle();
    expect(facade.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("a marker another tab sets or removes for a page, a capture, an invalidation, the queue or another account is not the outbox's: the facade does not look at the record for it (R15)", async () => {
    const w = await world();
    const markers = pageMarkers(w.markerStorage);
    const facade = createOutbox({
      service: w.service,
      quota: w.quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: { iso: () => new Date(w.now()).toISOString(), now: () => w.now() },
      fence: () => w.fence,
      markers,
    });
    expect((await facade.enqueue(request("a", "a", "r-a"))).kind).toBe(
      "queued",
    );
    await w.settle();
    const reads = countReads(w.service.store);
    const elsewhere = w.markerStorage.page("another-tab");
    // ADAPTED, revision 33: a marker's key names the database lifetime too, and the news is only of keys that parse as markers.
    const key = (operation: string, who = account(w)) =>
      markerKey(scopeOf(who), operation, "elsewhere.1");
    for (const unrelated of [
      key("page:5"),
      key("capture"),
      key("invalidate:cursor"),
      key("queue"),
      key("draft:someone-elses", "someone-else"),
    ]) {
      elsewhere.storage.setItem(unrelated, "1");
      elsewhere.storage.removeItem(unrelated);
    }
    // A cleared storage touches everything, and held nothing of the outbox's.
    elsewhere.clear();
    await w.settle();
    expect(reads()).toBe(0);
    expect(facade.storageNotResponding.get()).toBe(false);

    // The facade's own marker is not news to it either: what it last saw includes what it wrote itself.
    await facadeStop(w, "editQueued", "marker", "a", facade);
    await w.settle();
    const afterOwn = reads();
    elsewhere.storage.setItem(key("page:6"), "1");
    elsewhere.storage.removeItem(key("page:6"));
    await w.settle();
    expect(reads()).toBe(afterOwn);

    // An outbox marker another tab removes, or sets, is (ADAPTED, revision 32: removing it is removing the keys that stand).
    for (const standing of markerKeys(w.markerStorage, account(w), "draft:a"))
      elsewhere.storage.removeItem(standing);
    await w.settle();
    expect(reads()).toBeGreaterThan(afterOwn);
    expect(facade.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a look that was read before a stop was recorded never takes that stop down, whichever message started it", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const late = delayResult(w.service.store, "data.readLocalWriteStops");
    // A hint starts a look, whose answer (B only) will be delivered late...
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts"],
    });
    // (the look has READ the record by now: the double schedules a transaction, and runs it here)
    await w.settle();
    // ...and meanwhile another stop is recorded.
    await durableStop(w, "c");
    late.release();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    w.outbox.retry("b");
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(streaksOf(w)).toEqual({ "draft:c": 3 });
    w.outbox.retry("c");
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });
});

// ---- the looks a facade makes ---------------------------------------------------------------------------------------------------------
describe("R47: a facade looks at the record when it could be wrong, once at a time, and never on news that cannot concern it", () => {
  const scope = (w: OutboxWorld, incarnationId = w.service.incarnationId) => ({
    account: account(w),
    incarnationId,
  });

  test("its own success while a stop is shown is one look, not two (a facade does not hear itself)", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const reads = countReads(w.service.store);
    expect((await w.outbox.enqueue(request("u", "u", "r-u"))).kind).toBe(
      "queued",
    );
    await w.settle();
    expect(reads()).toBe(1);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("a facade does not hear itself: the stop it records is read once, not once for the stop and once for its own news of it", async () => {
    const w = await world();
    const reads = countReads(w.service.store);
    fail(w, "data.enqueueDraft", 3);
    for (let i = 0; i < 3; i += 1)
      expect((await w.outbox.enqueue(request("b", "b", "r-b"))).kind).toBe(
        "refused",
      );
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    // The one look after the stop that was recorded (the page's first look was made before the count began), and nothing for the news
    // the facade made itself.
    expect(reads()).toBe(1);
    finish(w);
  });

  test("news of an operation it does not show is not read; news of one it shows, or of a stop that was recorded, is read once", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const reads = countReads(w.service.store);
    const stranger = {};
    w.markers.stops.announce(scope(w), stranger, { ended: ["draft:zzz"] });
    await w.settle();
    expect(reads()).toBe(0);
    w.markers.stops.announce(scope(w), stranger, { ended: ["draft:b"] });
    await w.settle();
    expect(reads()).toBe(1);
    w.markers.stops.announce(scope(w), stranger, { recorded: ["draft:q"] });
    await w.settle();
    expect(reads()).toBe(2);
    // The record is what answers: nothing changed, so B still stands and q does not.
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("news of another account, or of another lifetime of this account's database, is not read", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const reads = countReads(w.service.store);
    const stranger = {};
    for (const where of [
      { account: "someone-else", incarnationId: w.service.incarnationId },
      scope(w, "an-older-incarnation"),
    ]) {
      w.markers.stops.announce(where, stranger, { recorded: ["draft:b"] });
      w.markers.stops.announce(where, stranger, { ended: ["draft:b"] });
    }
    await w.settle();
    expect(reads()).toBe(0);
    finish(w);
  });

  test("the dispatcher's own queue stop is not a draft's: the facade does not show it, and does not call it memory-only", async () => {
    const w = await world();
    w.markers.stops.hold(w.service, "queue");
    w.markers.stops.announce(scope(w), {}, { recorded: ["queue"] });
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
    finish(w);
  });

  test("a message that arrives while a look is outstanding is looked at after it, so the last word is the record's", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const late = delayResult(w.service.store, "data.readLocalWriteStops");
    // The first hint starts a look whose answer (B stands) will be delivered late...
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts"],
    });
    // (the look has READ the record by now: the double schedules a transaction, and runs it here)
    await w.settle();
    // ...B is retired by another tab, and its hint arrives while that look is outstanding.
    w.setSync({ local_write_streaks: {} });
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts"],
    });
    late.release();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a stop recorded while a look that another writer's news started is outstanding is never taken down by that look's older answer (the warning does not flicker)", async () => {
    const w = await world();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    const seen: boolean[] = [];
    w.outbox.storageNotResponding.subscribe(() =>
      seen.push(w.outbox.storageNotResponding.get()),
    );
    const late = delayResult(w.service.store, "data.readLocalWriteStops");
    // News of a stop recorded elsewhere starts a look, which READS the record (nothing stands yet) and answers late...
    w.markers.stops.announce(scope(w), {}, { recorded: ["draft:elsewhere"] });
    await w.settle();
    // ...and a stop is recorded here meanwhile.
    await durableStop(w, "c");
    late.release();
    await w.settle();
    expect(seen).not.toContain(false);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("a look that a newer stop made out of date is followed by a look of its own: what another tab retired meanwhile is not shown", async () => {
    const w = await world();
    await durableStop(w, "b");
    await w.settle();
    const late = delayResult(w.service.store, "data.readLocalWriteStops");
    w.deliver({
      type: "data_changed",
      account: account(w),
      stores: ["drafts"],
    });
    // (the look has READ the record by now: the double schedules a transaction, and runs it here)
    await w.settle();
    // B is retired elsewhere, and C is stopped here, while the first look is outstanding.
    w.setSync({ local_write_streaks: {} });
    await durableStop(w, "c");
    late.release();
    await w.settle();
    expect(streaksOf(w)).toEqual({ "draft:c": 3 });
    w.outbox.retry("c");
    // Nothing else is known to stand (B was retired elsewhere, and the look that said so was not lost to the stop recorded meanwhile):
    // the person's "Try again" takes the warning down at once, as it does when nothing else stands.
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("after a reload, with the record unreadable, the retry lifts the stop the last look found (the page failed nothing itself)", async () => {
    const w = await world();
    await durableStop(w, "b");
    w.reload();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    unreadable(w);
    w.outbox.retry();
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });
});

// ---- a seeded program over two facades and the dispatcher, against an independent model --------------------------------------------
describe("R46 and R47: a seeded random program over two facades and the dispatcher agrees with an independent model of every record", () => {
  const generator = (seed: number) => {
    let t = seed >>> 0;
    return (): number => {
      t = (t + 0x6d2b79f5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  interface Model {
    count: number;
    marker: boolean;
    memory: boolean;
    /** The facades that saw a failure of the draft since they started (a retry reaches such a count below the bound). */
    seen: [boolean, boolean];
  }
  const IDS = ["a", "ba", "b", "x:a"];
  const SEEDS = 40;
  const STEPS = 28;

  test(`${SEEDS} programs of ${STEPS} steps (failures of every mechanism, successes and retries through either facade, the dispatcher's retry, new facades, reloads): both warnings, both memory flags, the record, the markers and the page's memory match the model after every step`, async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = generator(seed);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(next() * items.length)] as T;
      const w = await world();
      // The dispatcher runs (the page is offline, so it holds nothing back and sends nothing) and so can be told to retry.
      w.start();
      let facades: [Outbox, Outbox] = [w.outbox, secondFacade(w)];
      const model = new Map<string, Model>(
        IDS.map((id) => [
          id,
          { count: 0, marker: false, memory: false, seen: [false, false] },
        ]),
      );
      const trail: string[] = [];
      const check = () => {
        const here = `seed ${seed}, after ${trail.join(" ; ")}`;
        let stopped = false;
        let memory = false;
        for (const [id, state] of model) {
          expect(
            streaksOf(w)[`draft:${id}`] ?? 0,
            `${here}: count of ${id}`,
          ).toBe(state.count);
          expect(
            markersOf(w).includes(`draft:${id}`),
            `${here}: marker of ${id}`,
          ).toBe(state.marker);
          expect(
            memoryOf(w).includes(`draft:${id}`),
            `${here}: memory of ${id}`,
          ).toBe(state.memory);
          if (state.count >= 3 || state.marker || state.memory) stopped = true;
          if (state.memory) memory = true;
        }
        for (const [index, facade] of facades.entries()) {
          expect(
            facade.storageNotResponding.get(),
            `${here}: warning ${index}`,
          ).toBe(stopped);
          expect(
            facade.storageMemoryOnly.get(),
            `${here}: memory-only ${index}`,
          ).toBe(memory);
        }
      };
      const target = (id: string): string =>
        id === "x:a" ? "r-c" : `r-${id === "ba" ? "a" : id}`;
      for (let step = 0; step < STEPS; step += 1) {
        const id = pick(IDS);
        const state = model.get(id) as Model;
        const via = pick([0, 1] as const);
        const facade = facades[via] as Outbox;
        const action = pick([
          "fail",
          "fail",
          "fail",
          "succeed",
          "succeed",
          "retry-one",
          "retry-all",
          "dispatcher-retry",
          "rebuild-facade",
          "reload",
        ] as const);
        if (action === "fail") {
          const mechanism = pick([
            "counter",
            "counter",
            "marker",
            "memory",
          ] as const);
          fail(w, "data.enqueueDraft", 1);
          if (mechanism !== "counter")
            fail(w, "data.recordLocalWriteOutcome", 1);
          if (mechanism === "memory") w.markerStorage.failWrites = true;
          expect(await facade.enqueue(request(id, id, target(id)))).toEqual({
            kind: "refused",
            reason: "storage",
          });
          w.markerStorage.failWrites = false;
          state.seen[via] = true;
          if (mechanism === "counter") state.count += 1;
          else if (mechanism === "marker") state.marker = true;
          else state.memory = true;
          trail.push(`${via}.fail(${id}, ${mechanism})`);
        } else if (action === "succeed") {
          expect((await facade.enqueue(request(id, id, target(id)))).kind).toBe(
            "queued",
          );
          Object.assign(state, {
            count: 0,
            marker: false,
            memory: false,
            seen: [false, false],
          });
          trail.push(`${via}.succeed(${id})`);
        } else if (action === "retry-one" || action === "retry-all") {
          if (action === "retry-one") facade.retry(id);
          else facade.retry();
          await w.settle();
          for (const [other, o] of model)
            if (action === "retry-all" || other === id) {
              // A count below the bound is reached only by a facade that saw it fail; a stop, a marker and a memory stop always.
              if (o.count >= 3 || o.seen[via] || o.marker || o.memory) {
                const before = o.count;
                Object.assign(o, { marker: false, memory: false });
                // ADAPTED, revision 32 (R53): the durable streak is reset on the VERSION of the failure the facade had seen when the
                // person asked. A stop (a count at the bound) is always seen: the news of it made every facade look. A count below the
                // bound is the facade's to end only if it saw THAT failure (its own, or one a look read); another facade's failure
                // since is a newer one, and the retry leaves it. Both outcomes are lawful for a count below the bound, so the record says
                // which happened, and nothing else may have: it is either what it was or nothing.
                const actual = streaksOf(w)[`draft:${other}`] ?? 0;
                if (before >= 3) o.count = 0;
                else {
                  expect(
                    [0, before],
                    `seed ${seed}: the count of ${other} after ${trail.join(" ; ")} ; retry`,
                  ).toContain(actual);
                  o.count = actual;
                }
              }
              // The facade keeps a failure it could not end in its bookkeeping (`failed`), and the next retry reaches it again.
              if (o.count === 0) o.seen[via] = false;
            }
          trail.push(
            action === "retry-one" ? `${via}.retry(${id})` : `${via}.retry()`,
          );
        } else if (action === "dispatcher-retry") {
          // The dispatcher's own retry lifts what its own bookkeeping and the page's memory name: for a memory stop, ALL of the operation's
          // records (the stop's count below the bound and a marker too, as the facade's own lifting does). A stop that only the record or
          // a marker holds, and that it has not looked at, is not its to lift (the program is offline, so it has read nothing).
          w.dispatcher.retry(id);
          await w.settle();
          trail.push(`dispatcher.retry(${id})`);
          if (state.memory) {
            const before = state.count;
            Object.assign(state, { marker: false, memory: false });
            // ADAPTED, revision 32 (R53): the dispatcher resets a streak on the version it has SEEN, and a page that is offline has read
            // no window; what it has not seen it leaves. Either is lawful; the record says which, and it is never anything else.
            const actual = streaksOf(w)[`draft:${id}`] ?? 0;
            expect(
              [0, before],
              `seed ${seed}: the count of ${id} after ${trail.join(" ; ")}`,
            ).toContain(actual);
            state.count = actual;
          }
        } else if (action === "rebuild-facade") {
          facades =
            via === 0
              ? [secondFacade(w), facades[1]]
              : [facades[0], secondFacade(w)];
          for (const o of model.values()) o.seen[via] = false;
          trail.push(`${via}.new facade`);
        } else {
          w.reload();
          w.start();
          await w.settle();
          facades = [w.outbox, secondFacade(w)];
          for (const o of model.values())
            Object.assign(o, { memory: false, seen: [false, false] });
          trail.push("reload");
        }
        await w.settle();
        check();
      }
      finish(w);
    }
  }, 180_000);
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
} from "../../src/data/engine/write-failure-marker";
import { invalidateOperation } from "../../src/data/model/retry";
import {
  CAPTURE_OPERATION,
  READ_RETRY_OPERATION,
  SIZING_OPERATION,
} from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import {
  markerStands,
  plantMarker,
  setGlobalStorage,
  withGlobalStorage,
} from "../support/data/marker-storage";
import { cacheRow } from "../support/data/rows";

/**
 * R47(c) (revision 29): ordinary sync does not take a marker store it cannot read for one with no stops in it.
 *
 * The capture gate was handed `markers.operations(account)`, an enumeration that answers `[]` when it throws, so a page that reloaded
 * with the enumeration unreadable sent a `GET /sync` through every stop it enforces (the capture write, the sync caller's retry record,
 * the sizing record, the current page's commit, an admitted invalidation at this position): the cursor advanced, and the retirement of
 * the invalidation record after the page applied then ERASED the marker that hid the cache. The gate is now asked about exactly the
 * operations it names (it reads the position inside its transaction, so a predicate), through the markers' own three-valued answer: a
 * `marked` operation stops, an `unknown` one (neither the key nor the enumeration can be read, and the page established nothing) is the
 * `unreadable` gate, which sends nothing and asks again on a pace, and every other operation is unaffected. EVERY test below builds a
 * FRESH markers object over a record that an earlier page wrote.
 *
 * FIXTURE evidence: the production engine, plans and guards over the double of IndexedDB and of `localStorage`; the network is a script
 * and time is fake. Native engines: E-C8 (`fixture.data-gate.spec.ts`) and E-O10.
 */
type World = Awaited<ReturnType<typeof engineWorld>>;
/**
 * ADAPTED, revision 33 (R55): a marker is found by reading the directories' fixed addresses and the key of each failure they list, and
 * the origin's keys are never listed. A read can fail for the directories (`directory`), for the listed failure's own key (`marker`:
 * that operation, and no other, is then unknown) or for every key (`getItem`).
 */
type Unreadable = "directory" | "marker" | "getItem";
const KINDS: Unreadable[] = ["directory", "marker", "getItem"];

const OPERATIONS = [
  CAPTURE_OPERATION,
  READ_RETRY_OPERATION,
  SIZING_OPERATION,
  "page:cursor-0",
  invalidateOperation("cursor-0"),
];
const UNRELATED = ["page:elsewhere", "draft:unrelated", "receipt:unrelated"];

const STOPPED = { kind: "stopped", cause: "local_storage" } as const;
const unreadable = (w: World, kind: Unreadable): void => {
  w.markerStorage.failGets = kind === "getItem";
  w.markerStorage.failGetsFor =
    kind === "directory"
      ? (key) => key.startsWith(DIRECTORY_PREFIX)
      : kind === "marker"
        ? (key) => key.startsWith(MARKER_PREFIX)
        : null;
};
const readable = (w: World): void => {
  w.markerStorage.failEnumeration = false;
  w.markerStorage.failGets = false;
  w.markerStorage.failGetsFor = null;
};
/**
 * ADAPTED, revision 32 (R52): a marker is a key of its own (`<operation>#<page>.<count>`), written once. `unreadable("getItem")` no longer
 * makes a marker unreadable (a value is never read, so the cases that varied which way the store could not be read keep their names and
 * say what is now so), and `unreadable("enumeration")` does: a marker is read by listing the account's keys and nothing else.
 */
const raw = (w: World, operation: string): boolean =>
  markerStands(w.markerStorage, w.service.account, operation);

/** A world at `cursor-0` with a cache to hide, and a marker for `operation` that an EARLIER page wrote. */
async function cold(operations: readonly string[]): Promise<World> {
  const w = await engineWorld({ cursor: "cursor-0" });
  w.put("cache", [cacheRow({ id: "retained", value: { name: "private" } })]);
  const prior = w.markerStorage.page("prior-page");
  for (const operation of operations)
    plantMarker(prior.storage, w.service.account, operation, "prior.1");
  return w;
}

/** The page reloads: a new engine and a new, fresh markers object (it has read and established nothing), with the store as `kind` says. */
function reload(w: World, kind: Unreadable | "readable"): void {
  if (kind === "readable") readable(w);
  else unreadable(w, kind);
  w.reload({ markers: "fresh" });
}

describe("a marker that stands is honoured whichever way the store can be read", () => {
  for (const operation of OPERATIONS)
    for (const kind of KINDS)
      test(`${operation}, ${kind} unreadable: no request, the cursor stays, the marker stands, and the state says local storage is not responding`, async () => {
        const w = await cold([operation]);
        reload(w, kind);
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.requests).toHaveLength(0);
        expect(w.sync().cursor).toBe("cursor-0");
        expect(raw(w, operation)).toBe(true);
        // A marker of an admitted invalidation that is READ also says so (it hides the cache); one that cannot be read is not known to
        // be one, and the engine does not claim it (ADAPTED, revision 33: whichever read cannot be made). ADAPTED, revision 34: with only
        // the directories unreadable the listing (the other witness) names the marker, and an invalidation's marker that is read says so.
        expect(w.state()).toEqual(
          kind === "directory" && operation === invalidateOperation("cursor-0")
            ? { ...STOPPED, invalidating: true }
            : STOPPED,
        );
        w.engine.stop();
      });

  for (const operation of OPERATIONS)
    test(`${operation}: the same schedule with the markers readable sends nothing either (the control)`, async () => {
      const w = await cold([operation]);
      reload(w, "readable");
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.requests).toHaveLength(0);
      expect(raw(w, operation)).toBe(true);
      w.engine.stop();
    });
});

describe("operations that are not this step's do not stop it, and a store that can be read does not hold it", () => {
  for (const operation of UNRELATED)
    test(`${operation}, only its own marker key unreadable: the request goes (exact-operation isolation, ADAPTED revision 33)`, async () => {
      const w = await cold([operation]);
      reload(w, "marker");
      w.start();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.sync().cursor).toBe("cursor-1");
      expect(raw(w, operation)).toBe(true);
      w.engine.stop();
    });

  // ADAPTED, revision 33: a page whose directories cannot be read cannot say that ANY of the five operations of its step is unmarked: it
  // sends nothing (the `unreadable` gate), whatever the markers that stand belong to, and asks again on a pace.
  for (const operation of UNRELATED)
    test(`${operation}, only the directories unreadable: nothing can be said of this step's operations, so nothing is sent until a read lands`, async () => {
      const w = await cold([operation]);
      reload(w, "directory");
      w.start();
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(raw(w, operation)).toBe(true);
      readable(w);
      await w.advance(70_000);
      expect(w.requests.length).toBeGreaterThanOrEqual(1);
      expect(raw(w, operation)).toBe(true);
      w.engine.stop();
    });

  test("a healthy page sends at once and reads values only at the directories' fixed addresses (adapted, revision 34: the origin's keys are walked for each observation, and no value is read by the walk)", async () => {
    const w = await cold([]);
    reload(w, "readable");
    const asked: string[] = [];
    const getItem = w.markerStorage.getItem.bind(w.markerStorage);
    w.markerStorage.getItem = (key) => {
      asked.push(key);
      return getItem(key);
    };
    const listed = w.markerStorage.enumerations;
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    // No marker stands, so no value but the directories' addresses is read (R55); the second witness walks the keys.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((key) => key.startsWith(DIRECTORY_PREFIX))).toBe(true);
    expect(w.markerStorage.enumerations).toBeGreaterThan(listed);
    w.engine.stop();
  });
});

describe("a store that cannot be read at all: nothing is sent, and a read that lands decides", () => {
  test("both unreadable with NO marker: no request, the cursor stays, the cache is not advanced over a stop nobody could read", async () => {
    const w = await cold([]);
    reload(w, "getItem");
    w.start();
    await w.settle();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(0);
    expect(w.sync().cursor).toBe("cursor-0");
    expect(w.state()).toEqual(STOPPED);
    w.engine.stop();
  });

  test("it is asked again on a pace, with no person's act: readable, the request goes and the sync is back (idle)", async () => {
    const w = await cold([]);
    reload(w, "getItem");
    w.start();
    await w.settle();
    await w.advance(5_000);
    expect(w.requests).toHaveLength(0);
    readable(w);
    await w.advance(70_000);
    // The first request is the one that was held; the engine then polls on its idle schedule, as any engine does.
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
    expect(w.requests[0]?.searchParams.get("cursor")).toBe("cursor-0");
    expect(w.sync().cursor).not.toBe("cursor-0");
    expect(w.state().kind).not.toBe("stopped");
    w.engine.stop();
  });

  test("readable, with a marker that was there: the stop stands (read now, not forgotten), and nothing is sent without the retry", async () => {
    const w = await cold([`page:cursor-0`]);
    reload(w, "getItem");
    w.start();
    await w.settle();
    await w.advance(10_000);
    readable(w);
    await w.advance(120_000);
    expect(w.requests).toHaveLength(0);
    expect(raw(w, "page:cursor-0")).toBe(true);
    expect(w.state()).toEqual(STOPPED);
    w.engine.stop();
  });

  test("the asking is paced and not a loop: a bounded number of reads over five minutes", async () => {
    const w = await cold([]);
    reload(w, "getItem");
    // ADAPTED, revision 33: an observation of an unreadable store is one refused read of the first directory (formerly a use of the
    // listing's length), so the reads counted are the observations made.
    let gets = 0;
    const getItem = w.markerStorage.getItem.bind(w.markerStorage);
    w.markerStorage.getItem = (key) => {
      gets += 1;
      return getItem(key);
    };
    w.start();
    await w.settle();
    await w.advance(300_000);
    expect(w.requests).toHaveLength(0);
    // Each look asks about the five operations, and there are a handful of looks: nothing proportional to the time that passed.
    expect(gets).toBeGreaterThan(0);
    expect(gets).toBeLessThan(100);
    w.engine.stop();
  });

  test("a wake while it is unreadable evaluates again at once and is not a retry: still nothing is sent", async () => {
    const w = await cold([]);
    reload(w, "getItem");
    w.start();
    await w.settle();
    w.fire();
    w.goOnline();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    readable(w);
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });
});

describe("what the person's retry may do when the record cannot be read", () => {
  // ADAPTED, revision 32 (R52 and R53). Revision 31's retry removed the one shared key of the operation although nothing could be read.
  // A key that names its failure cannot be removed without being named, and what a listing finds LATER may be a failure newer than
  // the person's act, which the act is not entitled to end. So a retry made while the store cannot be listed ends nothing and the
  // stop stands (as `unknown`); the retry made when a listing lands names the failure that stands and ends it, and the request goes.
  test("a stop of a page's commit, both unreadable: the retry cannot name the record and removes nothing; the retry made when a listing lands removes it, and the request goes", async () => {
    const w = await cold(["page:cursor-0"]);
    reload(w, "getItem");
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(raw(w, "page:cursor-0")).toBe(true);
    expect(w.requests).toHaveLength(0);
    readable(w);
    await w.advance(70_000);
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(raw(w, "page:cursor-0")).toBe(false);
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
    w.engine.stop();
  });

  // R52 and R53 (revision 32): the retry is an act that names what stands when it BEGINS. If a listing lands between the step that found
  // the five operations unreadable and the person's click (the engine asks again on a pace of its own), the click names the markers that
  // stand for every one of them and ends them, as it does for the stopped operation; it ends none of an admitted invalidation's (a
  // retry is not evidence that the cache is valid). Made while the listing still fails it names nothing (the cases above).
  // ADAPTED, revision 34: the markers are unreadable here because their KEYS cannot be read (`marker`); with only the directories
  // unreadable the listing names them and the step reads them (the readable schedule: one stopped operation at a time).
  test("a retry made after a listing lands again, before the engine has asked again, ends the markers that stand for EVERY operation the last step could not read, and the request goes", async () => {
    const w = await cold([CAPTURE_OPERATION, "page:cursor-0"]);
    reload(w, "marker");
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    readable(w);
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(raw(w, CAPTURE_OPERATION)).toBe(false);
    expect(raw(w, "page:cursor-0")).toBe(false);
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
    w.engine.stop();
  });

  test("a retry made after a listing lands again never ends the marker of an admitted invalidation: it is not evidence that the cache is valid", async () => {
    const op = invalidateOperation("cursor-0");
    const w = await cold([op]);
    // ADAPTED, revision 34 (`marker`, as above): a marker that is read is an admitted invalidation's, and its retry is the bounded cycle.
    reload(w, "marker");
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    readable(w);
    w.engine.retryNow();
    await w.settle();
    await w.advance(120_000);
    expect(raw(w, op)).toBe(true);
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ ...STOPPED, invalidating: true });
    w.engine.stop();
  });

  test("a retry whose removal THROWS is no recovery: nothing is sent", async () => {
    const w = await cold(["page:cursor-0"]);
    reload(w, "readable");
    w.markerStorage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    w.start();
    await w.settle();
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(w.requests).toHaveLength(0);
    expect(raw(w, "page:cursor-0")).toBe(true);
    w.engine.stop();
  });

  test("a retry never lifts the unreadable record of an admitted invalidation: it is not evidence that the cache is valid", async () => {
    const op = invalidateOperation("cursor-0");
    const w = await cold([op]);
    reload(w, "getItem");
    w.start();
    await w.settle();
    w.engine.retryNow();
    await w.settle();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(0);
    expect(raw(w, op)).toBe(true);
    readable(w);
    await w.advance(120_000);
    // The read that lands says the marker is there: the stop of the invalidation stands, and the record was not erased.
    expect(w.requests).toHaveLength(0);
    expect(raw(w, op)).toBe(true);
    w.engine.stop();
  });
});

describe("the invalidation's record is not retired by a page that was never allowed to be requested", () => {
  for (const kind of ["directory", "getItem"] as const)
    test(`${kind} unreadable: the position does not advance, so nothing retires the record, and a follower stays concealed from it`, async () => {
      const op = invalidateOperation("cursor-0");
      const w = await cold([op]);
      reload(w, kind);
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sync().cursor).toBe("cursor-0");
      expect(raw(w, op)).toBe(true);
      w.engine.stop();
    });
});

describe("a page built while the storage getter threw (the production default path)", () => {
  test("sends nothing while the getter throws, and the same markers find the store when access is restored", async () => {
    const w = await cold(["page:cursor-0"]);
    const markers = withGlobalStorage("throws", () =>
      createWriteFailureMarkers(),
    );
    const restore = setGlobalStorage("throws");
    try {
      w.reload({ markers });
      w.start();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual(STOPPED);
    } finally {
      restore();
    }
    const again = setGlobalStorage(w.markerStorage);
    try {
      await w.advance(120_000);
      // Read now: the marker is there, and the stop stands.
      expect(w.requests).toHaveLength(0);
      expect(raw(w, "page:cursor-0")).toBe(true);
    } finally {
      again();
      w.engine.stop();
    }
  });

  test("with NO marker it resumes by itself once the getter stops throwing", async () => {
    const w = await cold([]);
    const markers = withGlobalStorage("throws", () =>
      createWriteFailureMarkers(),
    );
    const restore = setGlobalStorage("throws");
    try {
      w.reload({ markers });
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.requests).toHaveLength(0);
    } finally {
      restore();
    }
    const again = setGlobalStorage(w.markerStorage);
    try {
      await w.advance(120_000);
      expect(w.requests.length).toBeGreaterThanOrEqual(1);
      expect(w.requests[0]?.searchParams.get("cursor")).toBe("cursor-0");
    } finally {
      again();
      w.engine.stop();
    }
  });
});

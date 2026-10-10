// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
  SLOT_COUNT,
} from "../../src/data/engine/write-failure-marker";
import {
  FakeMarkerStorage,
  markerInstances,
  markerKeys,
  pageMarkers,
  plantMarker,
  scopeOf,
  setGlobalStorage,
  withGlobalStorage,
} from "../support/data/marker-storage";

/**
 * R47 (revision 29): the marker STORE is a read that can fail, and so is each way of reading it.
 *
 * Revision 28 made a failed read of a marker unknown, but captured `localStorage` once, at construction: when obtaining it threw
 * (blocked site data) the module kept `undefined` for good and answered every question as an EMPTY store, so a page built while access
 * was refused found no stops (the cache opened, a stopped draft was sent), and restoring access did not help the object that was
 * already built. The store is now asked for at every use until it has been obtained once; a refusal is `unknown` and is never kept; and
 * a refused access never turns into an absent one. A read of the individual key that fails is tried again as a read of the enumeration,
 * and the other way round only for `inspect`, which has no key to ask for. A removal that RETURNED is NOT kept as evidence that a key
 * is gone (R47, revision 30): it established absence at that moment only, and another page may have written a new marker since; a
 * removal that threw is no evidence either.
 *
 * FIXTURE evidence: a double of `localStorage` whose reads and removals fail on demand, behind a global whose getter throws; native
 * engines are E-O10 and E-C8.
 */
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

const A1 = "acct-1";
const A2 = "acct-2";
const OP = "draft:a";
const OTHER = "draft:b";

function world() {
  const storage = new FakeMarkerStorage();
  const theirs = storage.page("another-tab");
  const blind = (): void => {
    storage.failGets = true;
    storage.failEnumeration = true;
  };
  const sighted = (): void => {
    storage.failGets = false;
    storage.failEnumeration = false;
  };
  return { storage, theirs, blind, sighted };
}

describe("a store that cannot be obtained is unknown, never an empty one", () => {
  test("built while the getter throws: every answer is `unknown`, the read is incomplete, nothing can be written and nothing is invented", () => {
    const { storage } = world();
    plantMarker(storage, A1, OP);
    const markers = withGlobalStorage("throws", () =>
      createWriteFailureMarkers(undefined, undefined, { ownSlot: 0 }),
    );
    restores.push(setGlobalStorage("throws"));
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.has(scopeOf(A1), OP)).toBe(false);
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: false,
    });
    expect(markers.operations(scopeOf(A1))).toEqual([]);
    expect(markers.set(scopeOf(A1), OP).state).toBe("unavailable");
    markers.clear(scopeOf(A1), OP);
    markers.clearAccount(A1);
    // Nothing was established by any of that: the record in the store is untouched and still unread.
    expect(markerKeys(storage, A1, OP)).toHaveLength(1);
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });

  test("access restored AFTER construction: the same object finds the store and reads what is there (revision 28 kept `undefined` for good)", () => {
    const { storage } = world();
    plantMarker(storage, A1, OP);
    const markers = withGlobalStorage("throws", () =>
      createWriteFailureMarkers(undefined, undefined, { ownSlot: 0 }),
    );
    restores.push(setGlobalStorage("throws"));
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    restores.pop()?.();
    restores.push(setGlobalStorage(storage));
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: true,
    });
    expect(markers.set(scopeOf(A1), OTHER).state).toBe("recorded");
    // ADAPTED, revision 32: the failure's name is in the KEY (`<operation>#<page>.<count>`), and the value is the fixed `1`.
    expect(markerInstances(storage, A1, OTHER)).toHaveLength(1);
    expect(markerInstances(storage, A1, OTHER)[0]).toMatch(/^[a-z0-9-]+\.\d+$/);
  });

  test("a refused access never becomes an ABSENT one: a global that then disappears says nothing either", () => {
    const markers = withGlobalStorage("throws", () =>
      createWriteFailureMarkers(undefined, undefined, { ownSlot: 0 }),
    );
    restores.push(setGlobalStorage("absent"));
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: false,
    });
  });

  test("an environment that never had a `localStorage` has nothing to hide: `unmarked` and a complete empty read (a worker, a test of the engine)", () => {
    const markers = withGlobalStorage("absent", () =>
      createWriteFailureMarkers(undefined, undefined, { ownSlot: 0 }),
    );
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: true,
    });
    expect(markers.set(scopeOf(A1), OP).state).toBe("unavailable");
  });

  test("a store obtained once is kept: access that is lost later does not turn what it established into nothing", () => {
    const { storage } = world();
    const markers = withGlobalStorage(storage, () =>
      createWriteFailureMarkers(undefined, undefined, { ownSlot: 0 }),
    );
    restores.push(setGlobalStorage("throws"));
    expect(markers.set(scopeOf(A1), OP).state).toBe("recorded");
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    storage.failGets = true;
    storage.failEnumeration = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
  });

  test("the account is looked at through whatever the global gives at the time, so a store that comes and goes is read when it is there", () => {
    const { storage } = world();
    const markers = withGlobalStorage("throws", () =>
      createWriteFailureMarkers(undefined, undefined, { ownSlot: 0 }),
    );
    restores.push(setGlobalStorage("throws"));
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    restores.pop()?.();
    restores.push(setGlobalStorage(storage));
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
  });
});

// ADAPTED, revision 33 (R55): a marker is found by reading the FIXED addresses of the directories and the key of each failure they list.
// ADAPTED again, revision 34: and by the listing of the origin's keys, which is the other witness. Each case below keeps the intent of the
// revision-29 case it replaces (one read that cannot be made does not hide what another read finds) in the new representation.
describe("a read that cannot be made does not hide what another read finds", () => {
  test("a listed failure's own key cannot be read while the directories can: THAT operation is `unknown`, every other is read (isolation)", () => {
    const { storage, theirs } = world();
    const markers = pageMarkers(storage, { events: false });
    plantMarker(theirs.storage, A1, OP);
    storage.failGetsFor = (key) => key.startsWith(MARKER_PREFIX);
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1)).known).toBe(false);
  });

  // ADAPTED, revision 34. Revision 33 said `unknown` for every operation when the directories could not be read, because nothing else
  // could say what stood. The listing can: it names the failure that stands (so the operation is `marked`), and it cannot make up for the
  // directories it could not read, so no OTHER operation is known to be free, and `inspect` says its read was incomplete.
  test("the directories cannot be read: the listing still names what stands, and nothing can be said of any other operation: `unknown`, and `inspect` says its read was incomplete", () => {
    const { storage, theirs } = world();
    const markers = pageMarkers(storage, { events: false });
    plantMarker(theirs.storage, A1, OP);
    storage.failGetsFor = (key) => key.startsWith(DIRECTORY_PREFIX);
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: false,
    });
  });

  // ADAPTED, revision 34. Revision 33: "the origin's keys cannot be listed: it changes nothing, because nothing is read by listing them".
  // The listing is a witness now: when it cannot be made, what the directories name still stands, and the absence of any other marker is
  // not known (a failure may stand that no directory lists).
  test("the origin's keys cannot be listed: what the directories name stands, and nothing else is known to be absent", () => {
    const { storage, theirs } = world();
    const markers = pageMarkers(storage, { events: false });
    plantMarker(theirs.storage, A1, OP);
    storage.failEnumeration = true;
    storage.forbidEnumeration = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: false,
    });
    expect(markers.witness(scopeOf(A1), OP).kind).toBe("instance");
    // The listing that lands again says the scope is whole.
    storage.failEnumeration = false;
    storage.forbidEnumeration = false;
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: true,
    });
  });

  test("neither lands: `unknown` for an operation this page has no evidence about, whatever the store holds", () => {
    const { storage, theirs, blind } = world();
    const markers = pageMarkers(storage, { events: false });
    plantMarker(theirs.storage, A1, OP);
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
  });

  test("a read that lands is a landed read: it establishes what it found and ends what it contradicts", () => {
    const { storage, theirs, blind } = world();
    const markers = pageMarkers(storage, { events: false });
    markers.set(scopeOf(A1), OP);
    for (const key of markerKeys(storage, A1, OP))
      theirs.storage.removeItem(key);
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    blind();
    // The landed read said it was gone, and a later failed read does not bring it back.
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });

  test("a read is the directories' fixed addresses, the keys they list and the walk of the origin's keys: no value is read but the directories' (adapted, revision 34)", () => {
    const { storage } = world();
    const markers = pageMarkers(storage, { events: false });
    const asked: string[] = [];
    const getItem = storage.getItem.bind(storage);
    storage.getItem = (key) => {
      asked.push(key);
      return getItem(key);
    };
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    expect(asked).toHaveLength(SLOT_COUNT);
    expect(asked.every((key) => key.startsWith(DIRECTORY_PREFIX))).toBe(true);
    expect(storage.enumerations).toBeGreaterThan(0);
  });
});

describe("a removal that returned is NOT evidence that the key is gone at a later boundary (R47, revision 30)", () => {
  // ADAPTED, revision 30 (separately labelled, for the reviewer to accept or reject). Revision 29 kept a removal that returned as the
  // page's "evidence" that the key was gone, which answered `unmarked` where nothing could be read. The review of revision 29 showed
  // that this turns an OLD fact into a PRESENT one: the removal established absence AT the removal, and another page may have
  // written a NEW marker since, which a delayed notification has not announced and a failed read cannot show. Each assertion below
  // keeps the intent of one of revision 29's (named in its title) and says what is now so: the page knows only what a read that
  // LANDED said, or what it established; a removal leaves nothing behind.
  test("(adapted) the page removed it and can no longer read: `unknown`, for that operation and every other, and the read stays incomplete", () => {
    const { storage, theirs, blind } = world();
    const markers = pageMarkers(storage);
    plantMarker(theirs.storage, A1, OP);
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    // ADAPTED, revision 32: `clear` removes what a listing finds, and nothing can be listed, so it removes nothing (it has no production
    // caller); a key is never guessed. The page learns nothing from it either way.
    markers.clear(scopeOf(A1), OP);
    expect(markerKeys(storage, A1, OP)).toHaveLength(1);
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.has(scopeOf(A1), OP)).toBe(false);
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.probe(scopeOf(A2), OP)).toBe("unknown");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: false,
    });
  });

  test("a removal that THREW is no evidence either: the stop stands, as established or as unknown", () => {
    const { storage, blind } = world();
    const markers = pageMarkers(storage);
    markers.set(scopeOf(A1), OP);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    blind();
    markers.clear(scopeOf(A1), OP);
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    markers.clear(scopeOf(A1), OTHER);
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
  });

  test("a read that lands is the marker: whatever the store says, and an established marker stays established when reads then fail", () => {
    const { storage, theirs } = world();
    const markers = pageMarkers(storage);
    markers.clear(scopeOf(A1), OP);
    plantMarker(theirs.storage, A1, OP);
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    storage.failGets = true;
    storage.failEnumeration = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
  });

  // The review's schedule at the module: an older removal, then another page's NEW marker, with its notification delayed.
  for (const { schedule, readable, delivered, written, expected } of [
    {
      schedule: "the notification is held and nothing can be read",
      readable: false,
      delivered: false,
      written: true,
      expected: "unknown",
    },
    {
      schedule: "the notification is delivered and nothing can be read",
      readable: false,
      delivered: true,
      written: true,
      expected: "unknown",
    },
    {
      schedule: "the marker can be read (the notification is held)",
      readable: true,
      delivered: false,
      written: true,
      expected: "marked",
    },
    {
      schedule: "there is no new marker and nothing can be read",
      readable: false,
      delivered: false,
      written: false,
      expected: "unknown",
    },
    {
      schedule: "there is no new marker and it can be read",
      readable: true,
      delivered: false,
      written: false,
      expected: "unmarked",
    },
  ] as const)
    test(`an older removal, then another page's NEW marker: ${schedule}: ${expected}`, () => {
      const { storage, theirs, blind } = world();
      const markers = pageMarkers(storage);
      markers.subscribe(() => undefined);
      markers.clear(scopeOf(A1), OP);
      if (!readable) blind();
      if (!delivered) storage.hold();
      if (written) plantMarker(theirs.storage, A1, OP);
      expect(markers.probe(scopeOf(A1), OP)).toBe(expected);
      expect(markers.has(scopeOf(A1), OP)).toBe(expected === "marked");
    });

  test("what the page can observe is the SAME with and without the new marker, so no honest answer separates them: both are `unknown`, never `unmarked`", () => {
    const observe = (foreign: boolean) => {
      const { storage, theirs, blind } = world();
      const markers = pageMarkers(storage);
      const heard: boolean[] = [];
      markers.subscribe((change) => heard.push(change.touches(A1, OP)));
      markers.clear(scopeOf(A1), OP);
      blind();
      storage.hold();
      if (foreign) plantMarker(theirs.storage, A1, OP);
      return {
        raw: markerKeys(storage, A1, OP).length > 0 ? "1" : null,
        seen: {
          heard,
          probe: markers.probe(scopeOf(A1), OP),
          has: markers.has(scopeOf(A1), OP),
          inspect: markers.inspect(scopeOf(A1)),
        },
      };
    };
    const withNew = observe(true);
    const without = observe(false);
    // The record differs...
    expect(withNew.raw).toBe("1");
    expect(without.raw).toBeNull();
    // ...and everything this page can see is identical, so its decision must be too, and the only safe one is "unknown".
    expect(withNew.seen).toEqual(without.seen);
    expect(withNew.seen.probe).toBe("unknown");
    expect(withNew.seen.heard).toEqual([]);
  });

  test("the answer does not depend on listening: a page with no feed and a page whose feed delivered the change agree", () => {
    for (const listening of [true, false]) {
      const { storage, theirs, blind } = world();
      const markers = pageMarkers(storage, { events: listening });
      if (listening) markers.subscribe(() => undefined);
      markers.clear(scopeOf(A1), OP);
      blind();
      plantMarker(theirs.storage, A1, OP);
      expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    }
  });

  test("(adapted) it subscribes to nothing of its own: a page that listens to nothing has no listener, whatever it removes", () => {
    const { storage, blind } = world();
    const markers = pageMarkers(storage);
    markers.clear(scopeOf(A1), OP);
    markers.clear(scopeOf(A1), OTHER);
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(storage.listening).toBe(0);
    const off = markers.subscribe(() => undefined);
    expect(storage.listening).toBe(1);
    off();
    expect(storage.listening).toBe(0);
  });

  test("(adapted) a read that lands says what the store says, and a later failure leaves nothing of an earlier removal", () => {
    const { storage, blind, sighted } = world();
    const markers = pageMarkers(storage);
    markers.clear(scopeOf(A1), OP);
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    sighted();
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unmarked");
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
  });

  test("the page's own later write of it makes it `marked` again, and `clearAccount` forgets what it established with the account", () => {
    const { storage, blind } = world();
    const markers = pageMarkers(storage);
    markers.clear(scopeOf(A1), OP);
    markers.set(scopeOf(A1), OP);
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    markers.clear(scopeOf(A1), OTHER);
    markers.clearAccount(A1);
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });

  test("an enumeration that lands says what is there, and nothing is kept of the removals that came before it", () => {
    const { storage, blind } = world();
    const markers = pageMarkers(storage);
    markers.clear(scopeOf(A1), OP);
    markers.clear(scopeOf(A1), OTHER);
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: true,
    });
    blind();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
  });

  test("(adapted) a page that removes the marker of every page it applies keeps nothing of them, so there is nothing to bound: every one answers `unknown`", () => {
    const { storage, blind } = world();
    const markers = pageMarkers(storage);
    for (let n = 0; n < 200; n += 1)
      markers.clear(scopeOf(A1), `page:cursor-${n}`);
    blind();
    expect(markers.probe(scopeOf(A1), "page:cursor-199")).toBe("unknown");
    expect(markers.probe(scopeOf(A1), "page:cursor-136")).toBe("unknown");
    expect(markers.probe(scopeOf(A1), "page:cursor-0")).toBe("unknown");
  });
});

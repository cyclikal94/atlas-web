// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createWriteFailureMarkers,
  SLOT_COUNT,
} from "../../src/data/engine/write-failure-marker";
import {
  FakeMarkerStorage,
  markerKeys,
  markerStands,
  pageMarkers,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";

/**
 * R47 (revision 28): a marker that cannot be READ is not a marker that is ABSENT.
 *
 * The markers used to answer a failed enumeration with an empty list and a failed `getItem` with `false`, so every consumer took an
 * unreadable store for one with no stops in it: the facade replaced its warning with the empty answer, the dispatcher sent a draft whose
 * marker was still there, and the cache gate opened for a cache the server had said was invalid. The module now keeps what this PAGE has
 * established (a marker it wrote, or one a read found) until it removes the marker itself or a read that lands shows it gone, and says,
 * separately, whether the read was complete (`inspect`: `known`) or what one marker's state is (`probe`: `marked`, `unmarked` or
 * `unknown`). The facade, the dispatcher and the cache gate are tested through the production code in the files that follow; this file is
 * the module's own contract.
 *
 * FIXTURE evidence: a double of `localStorage` whose enumeration and individual reads can be made to throw a `SecurityError`
 * independently of one another; the native engines are E-O10.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

const A1 = "acct-1";
const A2 = "acct-2";
const OP = "draft:a";
const OTHER = "draft:b";

function page() {
  const storage = new FakeMarkerStorage();
  const markers = pageMarkers(storage);
  const other = storage.page("another-tab");
  const theirs = pageMarkers(other);
  return { storage, markers, other, theirs };
}

describe("a healthy store answers exactly as before", () => {
  test("a marker that is there is `marked`, one that is not is `unmarked`, and the answers agree with `has` and `operations`", () => {
    const { markers } = page();
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    expect(markers.has(scopeOf(A1), OP)).toBe(false);
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: true,
    });
    expect(markers.set(scopeOf(A1), OP).state).toBe("recorded");
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.has(scopeOf(A1), OP)).toBe(true);
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: true,
    });
    expect(markers.operations(scopeOf(A1))).toEqual([OP]);
    markers.clear(scopeOf(A1), OP);
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: true,
    });
  });

  test("a page with no `localStorage` at all has no markers and nothing to hide: `unmarked`, and a complete (empty) read", () => {
    vi.stubGlobal("localStorage", undefined);
    const markers = createWriteFailureMarkers();
    expect(markers.set(scopeOf(A1), OP).state).toBe("unavailable");
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: true,
    });
  });

  test("a healthy read asks the storage for the directories' fixed addresses and the keys they list, and takes ONE snapshot of the origin's keys; never a value but those (adapted, revisions 33 to 35)", () => {
    const storage = new FakeMarkerStorage();
    const calls = { get: 0, length: 0, key: 0, keys: 0 };
    const real = {
      get: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      keys: storage.keys.bind(storage),
    };
    storage.getItem = (key) => {
      calls.get += 1;
      return real.get(key);
    };
    storage.key = (index) => {
      calls.key += 1;
      return real.key(index);
    };
    storage.keys = () => {
      calls.keys += 1;
      return real.keys();
    };
    const markers = pageMarkers(storage);
    markers.set(scopeOf(A1), OP);
    markers.set(scopeOf(A1), OTHER);
    markers.has(scopeOf(A1), OP);
    // ADAPTED, revision 33 (R55): a read is the `SLOT_COUNT` directory addresses and the key of each failure they list (the two written
    // above). ADAPTED, revision 34: and one walk of the origin's keys, which reads no value (a failure that both witnesses find is
    // read once). A healthy page with no marker reads only the directory addresses and walks the keys.
    calls.get = 0;
    calls.key = 0;
    calls.keys = 0;
    markers.has(scopeOf(A1), OP);
    // ADAPTED, revision 35 (R55): revision 34 walked the keys by index twice (`key: 2 * items`) and compared the walks. The authority is
    // now ONE snapshot of the keys (`keys`, the standard's single "get the keys"), and `key(i)` is not read at all; the instances this
    // page established are listed by it, so none is read again by name. The intent is unchanged: a fixed, bounded set of reads.
    expect(calls).toEqual({ get: SLOT_COUNT + 2, length: 0, key: 0, keys: 1 });
    markers.inspect(scopeOf(A1));
    expect(calls.get).toBe(2 * (SLOT_COUNT + 2));
    expect(calls.keys).toBe(2);
    expect(calls.key).toBe(0);
  });
});

describe("a failed read is `unknown` until this page has established the marker", () => {
  test("a marker this page WROTE stays marked while it cannot be read again, whichever read fails", () => {
    for (const failing of ["failGets", "failEnumeration"] as const) {
      const { storage, markers } = page();
      expect(markers.set(scopeOf(A1), OP).state).toBe("recorded");
      storage.failGets = true;
      if (failing === "failGets") {
        expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
        expect(markers.has(scopeOf(A1), OP)).toBe(true);
      } else {
        expect(markers.inspect(scopeOf(A1))).toEqual({
          operations: [OP],
          known: false,
        });
        expect(markers.operations(scopeOf(A1))).toEqual([OP]);
      }
    }
  });

  test("with BOTH reads failing the page still knows the marker it wrote, and says it does not know the rest", () => {
    const { storage, markers } = page();
    markers.set(scopeOf(A1), OP);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: false,
    });
    // A marker it never saw may be there: `unknown`, which is not `unmarked`.
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.has(scopeOf(A1), OTHER)).toBe(false);
  });

  // Adapted in revision 29 (the intent is kept): the later read that fails is now a read that cannot be made AT ALL (neither the key nor the
  // enumeration), because a single failing read falls back to the other and would say `marked` without anything having been established.
  test("a marker ANOTHER page wrote and a read of this one found is established too (the follower's case)", () => {
    const { storage, markers, theirs } = page();
    theirs.set(scopeOf(A1), OP);
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    storage.failGets = false;
    storage.failGets = false;
    // The enumeration that landed once is what a later failing one keeps.
    expect(markers.inspect(scopeOf(A1)).operations).toEqual([OP]);
    storage.failGets = true;
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: false,
    });
  });

  test("a marker this page never established, read while the store is unreadable, is `unknown`: never `unmarked`", () => {
    const { storage, markers, theirs } = page();
    theirs.set(scopeOf(A1), OP);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: false,
    });
    // The honest consequence for a caller that only asks `has`: no marker is KNOWN. The three-valued answer is how it tells.
    expect(markers.has(scopeOf(A1), OP)).toBe(false);
  });

  test("establishment is by account and by operation: nothing established for one is known for another", () => {
    const { storage, markers } = page();
    markers.set(scopeOf(A1), OP);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.probe(scopeOf(A2), OP)).toBe("unknown");
    expect(markers.inspect(scopeOf(A2))).toEqual({
      operations: [],
      known: false,
    });
    expect(markers.inspect(scopeOf(A1)).operations).toEqual([OP]);
    expect(markers.probe(scopeOf(A1), "draft:ba")).toBe("unknown");
    expect(markers.probe(scopeOf(A1), "a")).toBe("unknown");
  });
});

describe("what ends an established marker, and what does not", () => {
  // Revision 29 changed this assertion to `unmarked` (a removal that returned was kept as evidence of absence). The review of
  // revision 29 rejected that: a removal established absence AT the removal and says nothing about a marker another page wrote
  // since. REVISION 30 RESTORES revision 28's assertion (separately labelled, for the reviewer to accept or reject): after the page's
  // own removal a failed read is not `marked` (the marker it removed is not brought back) and not `unmarked` either (nothing says
  // that no new one was written): `unknown`, as for an operation the page never read.
  test("the page's own removal of it ends it: afterwards a failed read is not `marked`, and not `unmarked` either (restored, revision 30)", () => {
    const { storage, markers } = page();
    markers.set(scopeOf(A1), OP);
    markers.clear(scopeOf(A1), OP);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A1), OTHER)).toBe("unknown");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: false,
    });
  });

  test("a removal that THROWS ends nothing: the marker may still be there, and it stays established", () => {
    const { storage, markers } = page();
    markers.set(scopeOf(A1), OP);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    markers.clear(scopeOf(A1), OP);
    expect(markerStands(storage, A1, OP)).toBe(true);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.inspect(scopeOf(A1)).operations).toEqual([OP]);
  });

  // Adapted in revision 29 (the intent is kept): an individual read that fails is now tried again as a read of the enumeration, so a
  // later read is `unknown` only when BOTH ways of reading fail, as in every test of this file that wants an unreadable store.
  test("a read that LANDS and finds it gone ends it (another tab removed it): a later read that cannot be made at all is `unknown` (adapted, revision 29)", () => {
    const { storage, markers, theirs } = page();
    markers.set(scopeOf(A1), OP);
    theirs.clear(scopeOf(A1), OP);
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });

  test("an enumeration that lands REPLACES what the page established for the account, in both directions", () => {
    const { storage, markers, theirs } = page();
    markers.set(scopeOf(A1), OP);
    theirs.set(scopeOf(A1), OTHER);
    theirs.clear(scopeOf(A1), OP);
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OTHER],
      known: true,
    });
    storage.failGets = true;
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OTHER],
      known: false,
    });
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });

  test("a failing read does not end what a read established (adapted, revision 32: the per-key read that revision 29 fell back to is not made)", () => {
    const { storage, markers, theirs } = page();
    markers.set(scopeOf(A1), OP);
    theirs.clear(scopeOf(A1), OP);
    storage.failGets = true;
    // The listing fails: the page still has OP established, and no other read can say that it is gone.
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [OP],
      known: false,
    });
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    storage.failGets = false;
    // A listing that lands says it is gone.
    expect(markers.probe(scopeOf(A1), OP)).toBe("unmarked");
    expect(markers.inspect(scopeOf(A1))).toEqual({
      operations: [],
      known: true,
    });
  });

  test("`clearAccount` removes the markers and what the page established for the account, and nothing of another account", () => {
    const { storage, markers } = page();
    markers.set(scopeOf(A1), OP);
    markers.set(scopeOf(A2), OP);
    markers.clearAccount(A1);
    expect(markerStands(storage, A1, OP)).toBe(false);
    expect(markerStands(storage, A2, OP)).toBe(true);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markers.probe(scopeOf(A2), OP)).toBe("marked");
  });

  test("a clearing of the account whose listing fails removes nothing it cannot list, and forgets what it established", () => {
    const { storage, markers } = page();
    markers.set(scopeOf(A1), OP);
    storage.failEnumeration = true;
    markers.clearAccount(A1);
    // Its database is gone: nothing here is left to protect. The marker the listing could not reach is the module's existing
    // best-effort limit (a later enumeration that lands finds it).
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
    expect(markerStands(storage, A1, OP)).toBe(true);
  });

  test("a marker is its KEY: the value is never read (adapted, revision 32: a value other than the fixed `1` made a key `unmarked`)", () => {
    const { storage, markers } = page();
    plantMarker(storage, A1, OP);
    for (const key of markerKeys(storage, A1, OP)) storage.items.set(key, "0");
    // Nothing but this module writes under the prefix, and an instance is named by its key; reading the value would make the marker
    // depend on a read that can fail by itself (an individual read, R47) for no information.
    expect(markers.probe(scopeOf(A1), OP)).toBe("marked");
    expect(markers.has(scopeOf(A1), OP)).toBe(true);
  });
});

describe("the page's own writes keep the contract it already had", () => {
  test("a marker that cannot be written is not established (the stop is held in memory instead)", () => {
    const { storage, markers } = page();
    storage.failWrites = true;
    expect(markers.set(scopeOf(A1), OP).state).toBe("unavailable");
    storage.failWrites = false;
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });

  test("another page's change is still a prompt and nothing else: it establishes nothing", () => {
    const { storage, markers, theirs } = page();
    const heard: string[] = [];
    markers.subscribe((change) => {
      if (change.touches(A1, OP)) heard.push("touched");
    });
    theirs.set(scopeOf(A1), OP);
    expect(heard).toEqual(["touched"]);
    storage.failGets = true;
    storage.failGets = true;
    expect(markers.probe(scopeOf(A1), OP)).toBe("unknown");
  });
});

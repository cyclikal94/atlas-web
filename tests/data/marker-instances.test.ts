// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createLocalStops,
  markerStateOf,
  retireStops,
  unreadStops,
  witnessStops,
} from "../../src/data/engine/write-failure-marker";
import {
  FakeMarkerStorage,
  markerInstances,
  markerKeys,
  markerStands,
  pageMarkers,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";

/**
 * R50 and R51 (revision 31): a stop is an INSTANCE, and a success ends the instances it could have recovered and no newer one.
 *
 * The independent review of revision 30 held the delivery of a successful write's result, recorded a NEWER failure of the same
 * operation, and released the result: the success's later cleanup removed the newer stop (the facade) or the newer invalidation (the
 * engine's page completion), because the marker was one fixed value that could not say which failure it belonged to. Every failure
 * that records a marker (or holds a stop in the page's memory) is now a new instance with a new name; a write takes a WITNESS of what
 * stands when it is issued; and its success retires exactly the instances in the witness, whenever its result is delivered. This file
 * is the module's own contract (the callers are `outbox-late-success.test.ts` and `engine-late-completion.test.ts`).
 *
 * FIXTURE evidence: a double of `localStorage` that models pages; the native `localStorage` and a second real page are E-O10 and E-C8.
 */
const A = "acct-1";
const OP = "draft:a";
const OTHER = "draft:b";
/**
 * Adapted, revision 32 (R52): a failure's name is in its KEY (`<operation>#<page>.<count>`), written once and removed by that exact key,
 * so these tests read the keys that stand (`markerKeys`, `markerInstances`) and not the value of one shared key. What each case asserts
 * is what it asserted before, in the new representation; the cases that depended on a value being readable are rewritten for a
 * listing (the individual read is not how a marker is read any more) and labelled.
 */

function pages() {
  const storage = new FakeMarkerStorage();
  const mine = pageMarkers(storage);
  const other = storage.page("another-tab");
  const theirs = pageMarkers(other);
  return { storage, mine, theirs };
}

describe("a failure is an instance with its own name", () => {
  test("every `set` writes a NEW name, even over a marker that stands, and the page's pages do not share a name", () => {
    const { storage, mine, theirs } = pages();
    expect(mine.set(scopeOf(A), OP).state).toBe("recorded");
    const [first] = markerInstances(storage, A, OP);
    expect(first).toMatch(/^[a-z0-9-]+\.\d+$/);
    expect(mine.set(scopeOf(A), OP).state).toBe("recorded");
    // The page's own older instance is replaced (one marker per operation for a page that keeps failing), and the new one is another.
    const [second] = markerInstances(storage, A, OP);
    expect(markerInstances(storage, A, OP)).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(theirs.set(scopeOf(A), OP).state).toBe("recorded");
    // Another page's instance is its own: both stand, and the names differ.
    const both = markerInstances(storage, A, OP);
    expect(both).toHaveLength(2);
    expect(new Set(both).size).toBe(2);
  });

  // RETIRED, revision 33: "a marker with no name is still a marker, and the one instance no success can end". A key written before keys
  // named their failure and their database's lifetime is read by nothing: the card is new, nothing of the earlier formats has shipped
  // and the review of revision 32 requires no migration. Its replacement: a key of ANOTHER lifetime of the same account is not a marker
  // of this one, whatever its name (R56; see also `marker-lifetime.test.ts`).
  test("a marker of another lifetime of the same account is not this lifetime's marker, and no success of this lifetime can end it", () => {
    const { storage, mine } = pages();
    const old = scopeOf(A, "incarnation-0");
    plantMarker(storage, old, OP, "old.1");
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
    expect(mine.witness(scopeOf(A), OP)).toEqual({ kind: "none" });
    expect(mine.inspect(scopeOf(A))).toEqual({ operations: [], known: true });
    expect(markerStands(storage, old, OP)).toBe(true);
    // Retiring what this lifetime never saw touches nothing of the other.
    expect(
      mine.retire(scopeOf(A), OP, { kind: "instance", instances: ["old.1"] }),
    ).toBe(false);
    expect(markerStands(storage, old, OP)).toBe(true);
  });

  test("the memory of a page names each hold: a hold recorded again is a new instance, and a release with an instance ends only that one", () => {
    const stops = createLocalStops();
    const scope = { account: A, incarnationId: "i1" };
    stops.hold(scope, OP);
    const first = stops.instance(scope, OP);
    expect(first).not.toBeNull();
    stops.hold(scope, OP);
    const second = stops.instance(scope, OP);
    expect(second).not.toBe(first);
    // The older instance's release finds a newer hold and leaves it.
    expect(stops.release(scope, OP, first as string)).toBe(false);
    expect(stops.has(scope, OP)).toBe(true);
    expect(stops.release(scope, OP, second as string)).toBe(true);
    expect(stops.has(scope, OP)).toBe(false);
    expect(stops.instance(scope, OP)).toBeNull();
    // Without an instance (the person's retry, a deleted account) whatever stands ends.
    stops.hold(scope, OP);
    expect(stops.release(scope, OP)).toBe(true);
    // Another scope's hold of the same operation is not touched.
    const next = { account: A, incarnationId: "i2" };
    stops.hold(next, OP);
    expect(stops.release(scope, OP)).toBe(false);
    expect(stops.has(next, OP)).toBe(true);
  });
});

describe("`witness` and `retire`: a success ends the instance it saw", () => {
  test("a marker that stood when the write was issued is ended by its success", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    expect(seen.kind).toBe("instance");
    expect(mine.retire(scopeOf(A), OP, seen)).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
  });

  test("a marker another page records AFTER the witness is a newer failure and stays", () => {
    const { storage, mine, theirs } = pages();
    const seen = mine.witness(scopeOf(A), OP);
    expect(seen).toEqual({ kind: "none" });
    theirs.set(scopeOf(A), OP);
    expect(mine.retire(scopeOf(A), OP, seen)).toBe(false);
    expect(markerStands(storage, A, OP)).toBe(true);
  });

  test("a NEW instance over the one that was witnessed stays, whichever page wrote it", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    theirs.set(scopeOf(A), OP);
    const [mineBefore] = markerInstances(storage, A, OP).filter((name) =>
      seen.kind === "instance" ? seen.instances.includes(name) : false,
    );
    const newer = markerInstances(storage, A, OP).filter(
      (name) => name !== mineBefore,
    );
    expect(newer).toHaveLength(1);
    // The success ends the instance it saw (the exact key) and the other page's instance stands.
    expect(mine.retire(scopeOf(A), OP, seen)).toBe(true);
    expect(markerInstances(storage, A, OP)).toEqual(newer);
    // This page's own newer failure too.
    const seenAgain = mine.witness(scopeOf(A), OP);
    mine.set(scopeOf(A), OP);
    const own = markerInstances(storage, A, OP).filter(
      (name) =>
        seenAgain.kind === "instance" && !seenAgain.instances.includes(name),
    );
    expect(own).toHaveLength(1);
    expect(mine.retire(scopeOf(A), OP, seenAgain)).toBe(true);
    expect(markerInstances(storage, A, OP)).toContain(own[0]);
  });

  test("a marker that is already gone is not removed twice, and another operation's marker is not touched", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    mine.set(scopeOf(A), OTHER);
    const seen = mine.witness(scopeOf(A), OP);
    theirs.clear(scopeOf(A), OP);
    // The exact key is gone already: removing it again changes nothing, and nothing else is touched.
    const before = [...storage.items.keys()];
    mine.retire(scopeOf(A), OP, seen);
    expect([...storage.items.keys()]).toEqual(before);
    expect(markerStands(storage, A, OTHER)).toBe(true);
  });

  test("`none` retires nothing, however a marker stands later", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    expect(mine.retire(scopeOf(A), OP, { kind: "none" })).toBe(false);
    expect(markerStands(storage, A, OP)).toBe(true);
  });

  test("what a witness says is what `probe` says of it", () => {
    expect(markerStateOf({ kind: "none" })).toBe("unmarked");
    expect(markerStateOf({ kind: "instance", instances: ["x.1"] })).toBe(
      "marked",
    );
    expect(markerStateOf({ kind: "instance", instances: [""] })).toBe("marked");
    expect(markerStateOf({ kind: "unread" })).toBe("unknown");
  });
});

describe("a marker that cannot be read", () => {
  test("a page that never listed it cannot name it: its success cannot end it, and neither can a retry made now (adapted, revision 32)", () => {
    const { storage, theirs } = pages();
    theirs.set(scopeOf(A), OP);
    storage.failGets = true;
    const cold = pageMarkers(storage);
    const seen = cold.witness(scopeOf(A), OP);
    expect(seen).toEqual({ kind: "unread" });
    expect(cold.probe(scopeOf(A), OP)).toBe("unknown");
    expect(cold.retire(scopeOf(A), OP, seen)).toBe(false);
    expect(markerStands(storage, A, OP)).toBe(true);
    // Adapted from revision 31, where the retry removed the one shared key blind: a key that names its failure cannot be removed by
    // an act that could not list it, and listing it later would name failures that may be newer than the act. The retry made when a
    // listing lands names them and ends them (see the next case).
    expect(cold.retire(scopeOf(A), OP, seen, { explicit: true })).toBe(false);
    expect(markerStands(storage, A, OP)).toBe(true);
    storage.failGets = false;
    const later = cold.witness(scopeOf(A), OP);
    expect(later.kind).toBe("instance");
    expect(cold.retire(scopeOf(A), OP, later, { explicit: true })).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  // ADAPTED, revision 34. In revision 33 no read depended on a listing, so a refused listing changed nothing. The listing is the second
  // witness now; when it is refused, the directories still name the marker (the old intent: a page names a marker that a witness can
  // read), and the page can end it by its exact key. What the refused listing costs is the claim that nothing else stands.
  test("a page whose listing of the origin's keys is refused names the marker all the same, because a directory lists it (adapted, revision 34)", () => {
    const { storage, theirs } = pages();
    theirs.set(scopeOf(A), OP);
    storage.failEnumeration = true;
    storage.forbidEnumeration = true;
    const cold = pageMarkers(storage);
    const seen = cold.witness(scopeOf(A), OP);
    expect(seen.kind).toBe("instance");
    expect(cold.probe(scopeOf(A), OP)).toBe("marked");
    expect(cold.probe(scopeOf(A), "draft:never")).toBe("unknown");
    expect(cold.retire(scopeOf(A), OP, seen)).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  test("a page that read the marker names it, and its success is OWED the removal when the store refuses it: the first listing that lands makes it", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    expect(mine.retire(scopeOf(A), OP, seen)).toBe(false);
    // The record stands, and the page does not take it as a stop it knows of: it is unknown whether a NEWER one stands.
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(mine.inspect(scopeOf(A))).toEqual({ operations: [OP], known: true });
    storage.removeItem = removeItem;
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  test("while the store cannot be listed an ended marker is not a stop the page knows of; the removal is made when a listing lands", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    expect(mine.retire(scopeOf(A), OP, seen)).toBe(false);
    storage.failGets = true;
    // Owed: not `marked` (the page ended it), and not `unmarked` either (a newer one may stand): unknown.
    expect(mine.probe(scopeOf(A), OP)).toBe("unknown");
    expect(mine.inspect(scopeOf(A))).toEqual({ operations: [], known: false });
    storage.failGets = false;
    storage.removeItem = removeItem;
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  test("a success delivered while the store cannot be obtained at all is owed the same removal", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    mine.retire(scopeOf(A), OP, seen);
    storage.removeItem = removeItem;
    expect(mine.inspect(scopeOf(A))).toEqual({ operations: [], known: true });
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  test("a failure this page records after the success was owed is a new instance: the debt removes the old key and not the new one", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    mine.retire(scopeOf(A), OP, seen);
    storage.removeItem = removeItem;
    mine.set(scopeOf(A), OP);
    expect(mine.probe(scopeOf(A), OP)).toBe("marked");
    // The old instance is gone (debt and replacement both ended it) and the new one stands.
    expect(markerInstances(storage, A, OP)).toHaveLength(1);
  });

  test("a removal that is refused leaves the debt standing", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    mine.retire(scopeOf(A), OP, seen);
    expect(mine.probe(scopeOf(A), OP)).toBe("marked");
    storage.removeItem = removeItem;
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
  });

  test("the person's explicit act (`blind`) ends a named instance even when the store cannot be listed now, and `clear` ends whatever a listing finds", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    storage.failGets = true;
    storage.failEnumeration = true;
    expect(mine.retire(scopeOf(A), OP, seen, { explicit: true })).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
    storage.failGets = false;
    storage.failEnumeration = false;
    theirs.set(scopeOf(A), OTHER);
    mine.clear(scopeOf(A), OTHER);
    expect(markerStands(storage, A, OTHER)).toBe(false);
  });

  test("clearing an account forgets what it was owed: a marker that appears later is read as it is, whatever its name", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const owedKey = markerKeys(storage, A, OP)[0] as string;
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    mine.retire(scopeOf(A), OP, seen);
    storage.removeItem = removeItem;
    mine.clearAccount(A);
    expect(markerStands(storage, A, OP)).toBe(false);
    // The very key that was owed appears again (a name is unique, so this is the test's own construction of "the same instance"): the
    // debt is gone with the account, so nothing removes it.
    plantMarker(
      storage,
      scopeOf(A),
      OP,
      owedKey.slice(owedKey.lastIndexOf("#") + 1),
    );
    expect(mine.probe(scopeOf(A), OP)).toBe("marked");
    expect(storage.items.has(owedKey)).toBe(true);
  });
});

describe("a listing names the markers it finds", () => {
  test("a page that listed a marker while the store was healthy can name it when the store stops being readable", () => {
    const { storage, theirs } = pages();
    theirs.set(scopeOf(A), OP);
    const page = pageMarkers(storage);
    expect(page.inspect(scopeOf(A))).toEqual({ operations: [OP], known: true });
    const named = markerInstances(storage, A, OP);
    storage.failGets = true;
    storage.failEnumeration = true;
    expect(page.witness(scopeOf(A), OP)).toEqual({
      kind: "instance",
      instances: named,
    });
  });
});

describe("`witnessStops` and `retireStops`: the memory of a page and its markers, together", () => {
  const scope = scopeOf(A);

  test("a success ends the hold and the marker that stood when it was issued, and nothing recorded since", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    mine.stops.hold(scope, OP);
    mine.set(scopeOf(A), OTHER);
    const witness = witnessStops(mine, mine.stops, scope, [OP]);
    // A newer failure of the same operation, in the memory of this page and in the marker of another, after the write was issued.
    mine.stops.hold(scope, OP);
    theirs.set(scopeOf(A), OP);
    const sawOp = witness.stood.get(OP)?.marker;
    const saw = sawOp?.kind === "instance" ? sawOp.instances : [];
    const newer = markerInstances(storage, A, OP).filter(
      (name) => !saw.includes(name),
    );
    expect(newer).toHaveLength(1);
    // The marker the write saw ends (its exact key); the memory hold and the other page's marker are newer failures and stay.
    expect(retireStops(mine, mine.stops, witness)).toEqual([OP]);
    expect(mine.stops.has(scope, OP)).toBe(true);
    expect(markerInstances(storage, A, OP)).toEqual(newer);
    expect(markerStands(storage, A, OTHER)).toBe(true);
  });

  test("with nothing newer, both end, and only the operations named", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    mine.set(scopeOf(A), OTHER);
    mine.stops.hold(scope, OP);
    mine.stops.hold(scope, OTHER);
    const witness = witnessStops(mine, mine.stops, scope, [OP, OTHER]);
    expect(
      retireStops(mine, mine.stops, witness, { operations: [OP] }),
    ).toEqual([OP]);
    expect(mine.stops.has(scope, OP)).toBe(false);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(mine.stops.has(scope, OTHER)).toBe(true);
    expect(markerStands(storage, A, OTHER)).toBe(true);
    expect(retireStops(mine, mine.stops, witness)).toEqual([OTHER]);
  });

  // RETIRED, revision 33: "a marker of an earlier build names no instance, so a success cannot name it: only `blind` ends it". There is no
  // such marker any more (see the retired case above); the explicit act keeps its other meaning, that a removal it cannot make is not owed.

  test("a success's removal that the store refuses is OWED to the next read; the person's explicit act owes nothing (revision 33: what `explicit` still means)", () => {
    for (const explicit of [false, true]) {
      const { storage, mine } = pages();
      mine.set(scopeOf(A), OP);
      const witness = witnessStops(mine, mine.stops, scope, [OP]);
      const removeItem = storage.removeItem.bind(storage);
      storage.removeItem = () => {
        throw new DOMException("refused", "SecurityError");
      };
      retireStops(mine, mine.stops, witness, { explicit });
      storage.removeItem = removeItem;
      // The next read: a debt is made good there; an explicit act's refused removal leaves the stop standing for the person's next act.
      mine.probe(scopeOf(A), OP);
      expect(markerStands(storage, A, OP)).toBe(explicit);
      expect(mine.probe(scopeOf(A), OP)).toBe(explicit ? "marked" : "unmarked");
    }
  });

  test("a healthy page, with nothing standing, writes nothing and ends nothing", () => {
    const { storage, mine } = pages();
    const writes = storage.log.length;
    const witness = witnessStops(mine, mine.stops, scope, [OP]);
    expect(retireStops(mine, mine.stops, witness)).toEqual([]);
    expect(storage.log.length).toBe(writes);
  });

  test("a marker that could not be listed when the witness was taken is named by `unreadStops`, and neither a success nor a retry made then can end it (adapted, revision 32)", () => {
    const { storage, theirs } = pages();
    theirs.set(scopeOf(A), OP);
    storage.failGets = true;
    storage.failEnumeration = true;
    const cold = pageMarkers(storage);
    const witness = witnessStops(cold, cold.stops, scope, [OP, OTHER]);
    expect(unreadStops(witness).sort()).toEqual([OP, OTHER]);
    expect(retireStops(cold, cold.stops, witness)).toEqual([]);
    // Adapted from revision 31 (where the blind retry removed the shared key unread): the act is entitled to the failures that stood
    // when it began, and a key that names its failure cannot be removed without naming it. The retry made when a listing lands can.
    expect(retireStops(cold, cold.stops, witness, { explicit: true })).toEqual(
      [],
    );
    expect(markerStands(storage, A, OP)).toBe(true);
    storage.failGets = false;
    storage.failEnumeration = false;
    const listed = witnessStops(cold, cold.stops, scope, [OP, OTHER]);
    expect(unreadStops(listed)).toEqual([]);
    expect(retireStops(cold, cold.stops, listed, { explicit: true })).toEqual([
      OP,
    ]);
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  test("without markers (a page that has none) only the memory is witnessed and retired", () => {
    const stops = createLocalStops();
    stops.hold(scope, OP);
    const witness = witnessStops(undefined, stops, scope, [OP]);
    stops.hold(scope, OP);
    expect(retireStops(undefined, stops, witness)).toEqual([]);
    expect(stops.has(scope, OP)).toBe(true);
    const later = witnessStops(undefined, stops, scope, [OP]);
    expect(retireStops(undefined, stops, later)).toEqual([OP]);
  });
});

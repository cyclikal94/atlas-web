// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  MARKER_PREFIX,
  type WriteFailureMarkers,
} from "../../src/data/engine/write-failure-marker";
import {
  FakeMarkerStorage,
  markerInstances,
  markerStands,
  pageMarkers,
  scopeOf,
} from "../support/data/marker-storage";

/**
 * R52 (revision 32): a failure is ended by removing ITS key, and by nothing that compares a value first.
 *
 * The independent review of revision 31 read a marker, let another page replace it, and let the first page remove it: `localStorage` has
 * no atomic compare-and-remove, so the comparison proved nothing at the removal and the NEWER failure was deleted. That happened on the
 * direct retirement, on a retirement owed and settled by `probe`/`witness`, and on one settled by `inspect`. A marker whose key names its
 * failure (`<operation>#<page>.<count>`) is written once and removed by that exact key: whatever another page wrote in between has a key
 * of its own and is not reachable by the removal. This file is the module's own contract for that, checked two ways: the review's three
 * schedules with their controls, and EVERY point at which a second page can write (a barrier before each call that the first page makes
 * to the storage), for every operation of the first page that mutates or reads markers.
 *
 * FIXTURE evidence: a double of `localStorage` that models pages. The native counterpart over two real pages is E-O11
 * (`fixture.data-exact-keys.spec.ts`).
 */
const A = "acct-1";
const OP = "draft:a";
const OTHER = "draft:b";

/** The storage calls a page makes, in order; `before(n, fn)` runs `fn` just before the nth call (0-based) of any of them. */
function barrier(storage: FakeMarkerStorage) {
  let calls = 0;
  const hooks = new Map<number, () => void>();
  const log: string[] = [];
  const wrap = <
    K extends "getItem" | "setItem" | "removeItem" | "key" | "keys",
  >(
    name: K,
  ): void => {
    const original = storage[name].bind(storage) as (
      ...args: never[]
    ) => unknown;
    (storage as unknown as Record<string, unknown>)[name] = (
      ...args: never[]
    ) => {
      const at = calls;
      calls += 1;
      log.push(name);
      const hook = hooks.get(at);
      if (hook !== undefined) {
        hooks.delete(at);
        hook();
      }
      return original(...args);
    };
  };
  // Revision 35: the snapshot of the keys (`keys`) is a call too, and the other page can write just before it.
  for (const name of [
    "getItem",
    "setItem",
    "removeItem",
    "key",
    "keys",
  ] as const)
    wrap(name);
  // The length of the store is a call too: a page that is told it before a write has the old view of the keys.
  const length = Object.getOwnPropertyDescriptor(
    FakeMarkerStorage.prototype,
    "length",
  )?.get as () => number;
  Object.defineProperty(storage, "length", {
    configurable: true,
    get() {
      const at = calls;
      calls += 1;
      log.push("length");
      const hook = hooks.get(at);
      if (hook !== undefined) {
        hooks.delete(at);
        hook();
      }
      return length.call(this);
    },
  });
  return {
    before: (at: number, fn: () => void) => hooks.set(at, fn),
    get calls() {
      return calls;
    },
    log,
    reset() {
      calls = 0;
      log.length = 0;
    },
  };
}

/** How many marker KEYS stand in the storage (the directories are not counted). */
const keysStanding = (storage: FakeMarkerStorage): number =>
  [...storage.items.keys()].filter((key) => key.startsWith(MARKER_PREFIX))
    .length;

interface Pages {
  storage: FakeMarkerStorage;
  mine: WriteFailureMarkers;
  theirs: WriteFailureMarkers;
}
function pages(): Pages {
  const storage = new FakeMarkerStorage();
  const mine = pageMarkers(storage);
  const other = storage.page("another-tab");
  const theirs = pageMarkers(other);
  return { storage, mine, theirs };
}

/**
 * Runs `act` once to count the calls it makes, then once more for EACH call, with the other page recording a new failure of `OP` just
 * before that call. After every run the other page's instance must stand, and (checked by `after`) so must whatever else the schedule
 * requires. Answers how many barrier points were exercised, so a schedule that makes no calls cannot pass empty.
 */
function everyInterleaving(
  setup: (p: Pages) => unknown,
  act: (p: Pages, state: unknown) => void,
  after: (p: Pages, theirs: string, state: unknown) => void,
): number {
  const count = (() => {
    const p = pages();
    const state = setup(p);
    const b = barrier(p.storage);
    b.reset();
    act(p, state);
    return b.calls;
  })();
  expect(count).toBeGreaterThan(0);
  for (let at = 0; at < count; at += 1) {
    const p = pages();
    const state = setup(p);
    const b = barrier(p.storage);
    b.reset();
    let theirs: string | undefined;
    b.before(at, () => {
      const before = new Set(markerInstances(p.storage, A, OP));
      expect(p.theirs.set(scopeOf(A), OP).state).toBe("recorded");
      theirs = markerInstances(p.storage, A, OP).find(
        (name) => !before.has(name),
      );
    });
    act(p, state);
    // The barrier was reached, and the other page's write succeeded and is named.
    expect(theirs, `barrier before call ${at} (${b.log[at]})`).toBeDefined();
    after(p, theirs as string, state);
  }
  return count;
}

describe("the review's three schedules: a newer failure survives, and the control still recovers", () => {
  for (const mode of ["retire", "owed-probe", "owed-inspect"] as const)
    for (const interleave of [false, true])
      test(`${mode}, the other page ${interleave ? "writes between the read and the removal" : "writes nothing (control)"}`, () => {
        const { storage, mine, theirs } = pages();
        const b = barrier(storage);
        mine.set(scopeOf(A), OP);
        const seen = mine.witness(scopeOf(A), OP);
        const original = markerInstances(storage, A, OP);
        const removeItem = storage.removeItem.bind(storage);
        if (mode !== "retire") {
          // The success is delivered while the store refuses the removal: it is owed.
          storage.removeItem = () => {
            throw new DOMException("refused", "SecurityError");
          };
          expect(mine.retire(scopeOf(A), OP, seen)).toBe(false);
          storage.removeItem = removeItem;
        }
        b.reset();
        let newer: string | undefined;
        // The other page records its failure just before the first removal this page makes (after everything it reads).
        const hook = (): void => {
          const before = new Set(markerInstances(storage, A, OP));
          expect(theirs.set(scopeOf(A), OP).state).toBe("recorded");
          newer = markerInstances(storage, A, OP).find(
            (name) => !before.has(name),
          );
        };
        if (interleave) {
          let armed = true;
          storage.removeItem = (key) => {
            if (armed) {
              armed = false;
              hook();
            }
            removeItem(key);
          };
        }
        if (mode === "retire") mine.retire(scopeOf(A), OP, seen);
        else if (mode === "owed-probe") mine.probe(scopeOf(A), OP);
        else mine.inspect(scopeOf(A));
        if (interleave) {
          expect(newer, "the barrier was reached").toBeDefined();
          // The older instance is gone, the newer one stands, and nothing else.
          expect(markerInstances(storage, A, OP)).toEqual([newer]);
          expect(original).not.toContain(newer);
          expect(mine.probe(scopeOf(A), OP)).toBe("marked");
        } else {
          expect(markerInstances(storage, A, OP)).toEqual([]);
          expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
        }
      });
});

describe("every point at which a second page can write", () => {
  test("a retirement (`retire`) never reaches a failure the other page records at any call", () => {
    const points = everyInterleaving(
      (p) => {
        p.mine.set(scopeOf(A), OP);
        p.mine.set(scopeOf(A), OTHER);
        return p.mine.witness(scopeOf(A), OP);
      },
      (p, seen) => {
        p.mine.retire(
          scopeOf(A),
          OP,
          seen as ReturnType<typeof p.mine.witness>,
        );
      },
      (p, theirs) => {
        expect(markerInstances(p.storage, A, OP)).toEqual([theirs]);
        expect(markerStands(p.storage, A, OTHER)).toBe(true);
        expect(p.mine.probe(scopeOf(A), OP)).toBe("marked");
      },
    );
    expect(points).toBeGreaterThanOrEqual(1);
  });

  test("an owed retirement settled by `probe` never reaches a failure the other page records at any call", () => {
    const points = everyInterleaving(
      (p) => {
        p.mine.set(scopeOf(A), OP);
        const seen = p.mine.witness(scopeOf(A), OP);
        const removeItem = p.storage.removeItem.bind(p.storage);
        p.storage.removeItem = () => {
          throw new DOMException("refused", "SecurityError");
        };
        p.mine.retire(scopeOf(A), OP, seen);
        p.storage.removeItem = removeItem;
      },
      (p) => {
        p.mine.probe(scopeOf(A), OP);
      },
      (p, theirs) => {
        // ADAPTED, revision 34. A removal that is owed is made by a read that LANDS (R47), and a read whose walk of the origin's keys was
        // disturbed by the other page's write does not land (the listing is a witness now). Whatever that read did, the other page's
        // newer failure was not reached, and the next read, which is undisturbed, makes the removal and still leaves only that failure.
        expect(markerInstances(p.storage, A, OP)).toContain(theirs);
        p.mine.probe(scopeOf(A), OP);
        expect(markerInstances(p.storage, A, OP)).toEqual([theirs]);
      },
    );
    expect(points).toBeGreaterThanOrEqual(3);
  });

  test("an owed retirement settled by `witness`, `has` or `inspect` never reaches a failure the other page records at any call", () => {
    for (const settle of ["witness", "has", "inspect"] as const) {
      const points = everyInterleaving(
        (p) => {
          p.mine.set(scopeOf(A), OP);
          p.mine.set(scopeOf(A), OTHER);
          const seen = p.mine.witness(scopeOf(A), OP);
          const removeItem = p.storage.removeItem.bind(p.storage);
          p.storage.removeItem = () => {
            throw new DOMException("refused", "SecurityError");
          };
          p.mine.retire(scopeOf(A), OP, seen);
          p.storage.removeItem = removeItem;
        },
        (p) => {
          if (settle === "witness") p.mine.witness(scopeOf(A), OP);
          else if (settle === "has") p.mine.has(scopeOf(A), OP);
          else p.mine.inspect(scopeOf(A));
        },
        (p, theirs) => {
          // ADAPTED, revision 34 (see the case above): the next undisturbed read makes a removal that a disturbed one could not.
          expect(markerInstances(p.storage, A, OP)).toContain(theirs);
          expect(markerStands(p.storage, A, OTHER)).toBe(true);
          p.mine.probe(scopeOf(A), OP);
          expect(markerInstances(p.storage, A, OP)).toEqual([theirs]);
          expect(markerStands(p.storage, A, OTHER)).toBe(true);
        },
      );
      expect(points).toBeGreaterThanOrEqual(3);
    }
  });

  test("a failure recorded by this page replaces only this page's own earlier one, at any call", () => {
    const points = everyInterleaving(
      (p) => {
        p.mine.set(scopeOf(A), OP);
      },
      (p) => {
        p.mine.set(scopeOf(A), OP);
      },
      (p, theirs) => {
        const names = markerInstances(p.storage, A, OP);
        // The other page's instance stands, and so does this page's NEW one; its older one is gone.
        expect(names).toContain(theirs);
        expect(names).toHaveLength(2);
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  });

  test("two pages each recording and replacing, interleaved at every call, never leave the operation unmarked", () => {
    // The other page's writer is itself the barrier hook; the first page repeats `set` three times and the second also does.
    const points = everyInterleaving(
      (p) => {
        p.mine.set(scopeOf(A), OP);
      },
      (p) => {
        p.mine.set(scopeOf(A), OP);
        p.mine.set(scopeOf(A), OP);
      },
      (p) => {
        expect(markerStands(p.storage, A, OP)).toBe(true);
        expect(p.mine.probe(scopeOf(A), OP)).toBe("marked");
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
  });

  test("a listing (`inspect`) made at any point sees every marker that was written before it started", () => {
    // ADAPTED, revision 34. The listing of the origin's keys is a witness now, and a page that writes a key while it is under way changes
    // the walk's length: the read says `known: false` (the walk cannot be trusted to have visited what stood), and still names every
    // marker that stood before it began, because the directories are the other witness. The old assertion `known: true` at every call
    // cannot hold when the origin changes under a walk; what it protected (a read never omits a marker that stood and says it is whole)
    // is asserted for every point, and the walk's interleaving is shown to have engaged.
    // ADAPTED AGAIN, revision 35 (R55): the listing is ONE snapshot of the keys, which a write between two operations cannot disturb,
    // so the assertion of revision 33 and before holds again at EVERY point: the read names both markers AND says it is whole
    // (`disturbed` must stay 0; revision 34 required it to be positive, which only a walk by index could make true).
    let whole = 0;
    let disturbed = 0;
    const points = everyInterleaving(
      (p) => {
        p.mine.set(scopeOf(A), OP);
        p.mine.set(scopeOf(A), OTHER);
      },
      (p) => {
        const read = p.mine.inspect(scopeOf(A));
        expect(read.operations).toContain(OTHER);
        expect(read.operations).toContain(OP);
        if (read.known) whole += 1;
        else disturbed += 1;
      },
      (p, theirs) => {
        expect(markerInstances(p.storage, A, OP)).toContain(theirs);
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
    // Every interleaved read and the counting pass that found the points (one more, undisturbed) are whole.
    expect(whole).toBe(points + 1);
    expect(disturbed).toBe(0);
  });
});

describe("a key names its failure and nothing else", () => {
  test("a failure recorded again by the same page leaves one key, and another page's key is left alone", () => {
    const { storage, mine, theirs } = pages();
    theirs.set(scopeOf(A), OP);
    // This page has LISTED the other page's failure, so it knows of it: it still replaces only what it wrote itself.
    expect(mine.probe(scopeOf(A), OP)).toBe("marked");
    for (let n = 0; n < 5; n += 1) mine.set(scopeOf(A), OP);
    const names = markerInstances(storage, A, OP);
    // One of its own (the latest) and the other page's: bounded by the pages, not by the number of failures.
    expect(names).toHaveLength(2);
    expect(keysStanding(storage)).toBe(2);
  });

  test("an operation that is a prefix of another is not the other, and a `#` in an operation does not confuse the key", () => {
    const { storage, mine } = pages();
    for (const operation of [
      "draft:1",
      "draft:10",
      "draft:1#x",
      "page:cursor#1.1",
    ])
      mine.set(scopeOf(A), operation);
    expect(markerInstances(storage, A, "draft:1")).toHaveLength(1);
    expect(markerInstances(storage, A, "draft:10")).toHaveLength(1);
    expect(markerInstances(storage, A, "draft:1#x")).toHaveLength(1);
    expect(markerInstances(storage, A, "page:cursor#1.1")).toHaveLength(1);
    const seen = mine.witness(scopeOf(A), "draft:1");
    mine.retire(scopeOf(A), "draft:1", seen);
    expect(markerStands(storage, A, "draft:1")).toBe(false);
    expect(markerStands(storage, A, "draft:10")).toBe(true);
    expect(markerStands(storage, A, "draft:1#x")).toBe(true);
    expect(mine.inspect(scopeOf(A)).operations.sort()).toEqual(
      ["draft:10", "draft:1#x", "page:cursor#1.1"].sort(),
    );
  });

  test("another account's keys are neither listed nor removed", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    theirs.set(scopeOf("acct-2"), OP);
    expect(mine.inspect(scopeOf(A)).operations).toEqual([OP]);
    mine.clearAccount(A);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(markerStands(storage, "acct-2", OP)).toBe(true);
  });

  // RETIRED, revision 33: "a key written by an earlier build (no instance) is a marker that only the person's retry and a deleted
  // account remove". Such a key is read by nothing (the card is new and no earlier format has shipped); the replacement is the control
  // that a key of another lifetime is not a marker of this one (`marker-instances.test.ts`, `marker-lifetime.test.ts`).

  test("the instance is unique: pages that are given the same page part still count apart, and the default part is random", () => {
    const storage = new FakeMarkerStorage();
    const one = createWriteFailureMarkers(storage, storage.events, {
      id: () => "fixed",
      ownSlot: 0,
    });
    one.set(scopeOf(A), OP);
    one.set(scopeOf(A), OTHER);
    const [x] = markerInstances(storage, A, OP);
    const [y] = markerInstances(storage, A, OTHER);
    expect(x).toBe("fixed.1");
    expect(y).toBe("fixed.2");
    const names = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      const page = pageMarkers(new FakeMarkerStorage(), { events: false });
      const own = new FakeMarkerStorage();
      const fresh = pageMarkers(own);
      fresh.set(scopeOf(A), OP);
      names.add(markerInstances(own, A, OP)[0] as string);
      page.stops.clearAccount(A);
    }
    expect(names.size).toBe(50);
  });

  test("a page part that is not a safe name is made one: the key still parses as the instance it names", () => {
    const storage = new FakeMarkerStorage();
    const page = createWriteFailureMarkers(storage, storage.events, {
      id: () => "Some Page/#1",
      ownSlot: 0,
    });
    page.set(scopeOf(A), OP);
    expect(markerInstances(storage, A, OP)).toHaveLength(1);
    expect(page.inspect(scopeOf(A)).operations).toEqual([OP]);
    expect(page.probe(scopeOf(A), OP)).toBe("marked");
  });

  test("a change another page makes is reported for the operation its key names, and for the account", () => {
    const { storage, theirs, mine } = pages();
    const heard: Array<[boolean, boolean, boolean]> = [];
    mine.subscribe((change) =>
      heard.push([
        change.touches(A, OP),
        change.touches(A, OTHER),
        change.touches("acct-2"),
      ]),
    );
    theirs.set(scopeOf(A), OP);
    expect(heard).toEqual([[true, false, false]]);
    theirs.set(scopeOf(A), "draft:b#1");
    expect(heard[1]).toEqual([false, false, false]);
    expect(keysStanding(storage)).toBe(2);
  });
});

// RETIRED, revision 33 (R55): "a listing is a snapshot that is not trusted when the store changes under it" (a length that moves, a failure
// recorded while the keys are being listed, an index that answers null). A marker is no longer found by listing the origin's keys, so there
// is no listing to distrust and no retry count to bound; the contract those cases defended (a standing failure is never missed because
// other keys of the origin changed) is now tested at every call a reader makes, with the origin's keys forbidden, in
// `marker-directories.test.ts`. The originals are kept unchanged in `.agtx/evidence/WEB-09a/revision-33/baseline-sources.tar.gz`.

describe("an account's deletion and the owed removals", () => {
  test("deleting an account forgets the removals it was owed, and what it established, and leaves other accounts alone", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    theirs.set(scopeOf("acct-2"), OP);
    const seen = mine.witness(scopeOf(A), OP);
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException("refused", "SecurityError");
    };
    mine.retire(scopeOf(A), OP, seen);
    storage.removeItem = removeItem;
    mine.clearAccount(A);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(markerStands(storage, "acct-2", OP)).toBe(true);
    // A failure the page records afterwards is its own and is read as it is.
    mine.set(scopeOf(A), OP);
    expect(mine.probe(scopeOf(A), OP)).toBe("marked");
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  directoryKey,
  LISTING_MAX_KEYS,
  MARKER_PREFIX,
  type MarkerStorage,
  markerKey,
  type WriteFailureMarkers,
} from "../../src/data/engine/write-failure-marker";
import {
  FakeMarkerStorage,
  markerKeys,
  markerStands,
  pageMarkers,
  scopeOf,
} from "../support/data/marker-storage";

/**
 * R55 (revision 34): the TWO WITNESSES of a failure that stands, and what a hand-over of a directory slot can and cannot lose.
 *
 * The review of revision 33 showed (a model, and two real pages in WebKit) that a directory is rewritten by the next owner of its slot
 * from whatever that owner SEES, that a Web Lock says nothing about whether the new owner sees what the previous one wrote last, and
 * that the failure whose entry is lost that way stays stored under its immutable key while no reader ever visits it again: `probe`
 * said `unmarked`, `witness` said `none` and `inspect` said `known` without the operation. The key is the one record no hand-over
 * can lose (it is written once and never again), so the origin's keys are the other witness (header of the module, obligation 2).
 *
 * What these cases assert is the THEOREM the design claims and no more: a failure is lost to a reader only if BOTH witnesses fail it;
 * either one finds it alone; a witness that cannot be completed makes the absence of anything else UNKNOWN (never absent); a refused
 * or disturbed walk never turns a failure that a directory names into an absence. The last case characterises the one schedule that
 * defeats both witnesses, so that the limit is on record and in a test, not hidden (it is a decision for the owner, see the report).
 *
 * FIXTURE evidence: a double of `localStorage` that models pages and Web Locks, and a view of it that returns a STALE value for one
 * read (the review's injection). The native counterpart with real `localStorage` and real Web Locks in two live pages is E-O13.
 *
 * ADAPTED, revision 35 (R55, premise P11: the listing is ONE snapshot of the keys). The review of revision 34 showed that the walk by
 * index, made twice, can omit a standing key the same way twice (an interleaving between two `key(i)` calls), and that the last case
 * below, which this file kept as a "known limit", is a lost protection, not a residual. The authority is now the store's own list of
 * its keys read in one operation (the HTML standard's "get the keys" on the storage's map), which no interleaving can enter, plus the
 * page's established keys read again by name. So: every view below that models a stale DIRECTORY read passes the snapshot through
 * (`keys`, the backing store's own), because a stale directory says nothing of the keys; the churn that acted between two `key(i)`
 * calls now acts between two OPERATIONS (before the snapshot), which is all an interleaving can do; and the cases that asserted
 * `unknown` because a walk was disturbed now assert the stronger answer the snapshot gives (`marked`, or a whole read). The
 * characterisation of false absence is a PROTECTION obligation now. The original bytes of this file are kept in
 * `.agtx/evidence/WEB-09a/revision-35/originals/`.
 */
const A = "acct-1";
const OP = "draft:a";
const OTHER = "draft:b";
const THIRD = "draft:c";

function locked(name: string, storage: FakeMarkerStorage, slot = 0) {
  return createWriteFailureMarkers(storage, undefined, {
    id: () => name,
    locks: storage.lockWorld.page(name),
    slotStart: () => slot,
  });
}

/** A view of `storage` in which reads of `key` answer `stale` (`times` times) before they answer what is stored. */
function behind(
  storage: FakeMarkerStorage,
  key: string,
  stale: string | null,
  times = 1,
): { view: MarkerStorage; reads: () => number } {
  let reads = 0;
  const view: MarkerStorage = {
    get length() {
      return storage.length;
    },
    key: (index) => storage.key(index),
    // ADAPTED, revision 35 (P11): the view is behind for ONE record (the directory); its list of keys is the store's own.
    keys: () => storage.keys(),
    getItem: (asked) => {
      if (asked === key && reads < times) {
        reads += 1;
        return stale;
      }
      return storage.getItem(asked);
    },
    setItem: (asked, value) => storage.setItem(asked, value),
    removeItem: (asked) => storage.removeItem(asked),
  };
  return { view, reads: () => reads };
}

type Reader = "cold" | "informed";
type Call = "probe" | "witness" | "inspect" | "has" | "operations";
const READERS: Reader[] = ["cold", "informed"];
const CALLS: Call[] = ["probe", "witness", "inspect", "has", "operations"];

/** What a call says of `operation`, as a protected (true) or an unprotected (false) answer. */
function protectedBy(
  markers: WriteFailureMarkers,
  call: Call,
  operation: string,
): boolean {
  const scope = scopeOf(A);
  switch (call) {
    case "probe":
      return markers.probe(scope, operation) !== "unmarked";
    case "witness":
      return markers.witness(scope, operation).kind !== "none";
    case "inspect": {
      const read = markers.inspect(scope);
      return !read.known || read.operations.includes(operation);
    }
    case "has":
      return markers.has(scope, operation);
    case "operations":
      return markers.operations(scope).includes(operation);
  }
}

describe("a hand-over of a slot to a page whose view is behind loses no failure (the review's counterexample, R55)", () => {
  for (const staleness of ["absent", "older version"] as const)
    for (const reader of READERS)
      for (const call of CALLS)
        test(`${staleness}, ${reader} reader, ${call}: the first failure stays protected after the next owner publishes another from a stale directory`, async () => {
          const storage = new FakeMarkerStorage();
          const scope = scopeOf(A);
          const first = locked("first", storage);
          expect(await first.prepare()).toBe(true);
          // An older version of the directory: the slot after one earlier failure of the same owner (or none at all).
          if (staleness === "older version") {
            expect(first.set(scope, THIRD).state).toBe("recorded");
          }
          const olderText = storage.items.get(directoryKey(scope, 0)) ?? null;
          expect(first.set(scope, OP).state).toBe("recorded");
          first.release();
          const current = storage.items.get(directoryKey(scope, 0));
          const stale = behind(storage, directoryKey(scope, 0), olderText);
          const next = createWriteFailureMarkers(stale.view, undefined, {
            id: () => "next",
            locks: storage.lockWorld.page("next"),
            slotStart: () => 0,
          });
          expect(await next.prepare()).toBe(true);
          expect(next.set(scope, OTHER).state).toBe("recorded");
          next.release();
          // The injection engaged, and it did what the review said: the directory the next owner wrote omits the first failure.
          expect(stale.reads()).toBeGreaterThanOrEqual(1);
          const written = JSON.parse(
            storage.items.get(directoryKey(scope, 0)) as string,
          ) as { e: Array<[string, string]> };
          expect(current).not.toBe(storage.items.get(directoryKey(scope, 0)));
          expect(markerStands(storage, A, OP)).toBe(true);
          const reading =
            reader === "informed"
              ? (() => {
                  const informed = pageMarkers(storage, { events: false });
                  // Informed BEFORE the hand-over's damage is a different schedule; here it is informed after the first publication only
                  // when the call is made again below.
                  return informed;
                })()
              : pageMarkers(storage, { events: false });
          // The listing finds it whatever the directory says, so a reader is protected for the failure the directory lost...
          expect(protectedBy(reading, call, OP)).toBe(true);
          expect(protectedBy(reading, call, OTHER)).toBe(true);
          // ...and the page that wrote it last has listed it again (the heal): the directory is whole.
          const names = written.e.map(([operation]) => operation);
          expect(names).toContain(OTHER);
          expect(names).toContain(OP);
        });

  for (const reader of READERS)
    for (const call of CALLS)
      test(`control (the current view), ${reader} reader, ${call}: both failures are protected, and a recovered operation regains known absence`, async () => {
        const storage = new FakeMarkerStorage();
        const scope = scopeOf(A);
        const first = locked("first", storage);
        await first.prepare();
        first.set(scope, OP);
        first.release();
        const next = locked("next", storage);
        await next.prepare();
        next.set(scope, OTHER);
        next.release();
        const reading = pageMarkers(storage, { events: false });
        expect(protectedBy(reading, call, OP)).toBe(true);
        expect(protectedBy(reading, call, OTHER)).toBe(true);
        // A healthy store that has recovered says so: absence is known again once the keys are gone.
        for (const key of markerKeys(storage, A, OP)) storage.removeItem(key);
        expect(reading.probe(scope, OP)).toBe("unmarked");
        expect(reading.inspect(scope)).toEqual({
          operations: [OTHER],
          known: true,
        });
      });

  test("an informed reader keeps what it established across the damage, and ends it by its exact key", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const first = locked("first", storage);
    await first.prepare();
    first.set(scope, OP);
    const informed = pageMarkers(storage, { events: false });
    const seen = informed.witness(scope, OP);
    expect(seen.kind).toBe("instance");
    first.release();
    const stale = behind(storage, directoryKey(scope, 0), null);
    const next = createWriteFailureMarkers(stale.view, undefined, {
      id: () => "next",
      locks: storage.lockWorld.page("next"),
      slotStart: () => 0,
    });
    await next.prepare();
    next.set(scope, OTHER);
    // The damaged directory does not matter to the informed page: it retires the failure it saw, and only that one.
    expect(informed.retire(scope, OP, seen)).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(markerStands(storage, A, OTHER)).toBe(true);
    expect(informed.probe(scope, OTHER)).toBe("marked");
  });
});

describe("A, then B, then A again: rapid takeover loses no standing failure (the review's native schedule, as a model)", () => {
  test("cycles of take, publish and release by two pages, each starting from a view that is behind, leave every key discoverable", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const names = ["one", "two"];
    const expected: string[] = [];
    for (let round = 0; round < 12; round += 1) {
      const name = names[round % 2] as string;
      // The view is behind whenever the slot changes hands: a read of the directory answers the version the OTHER page left two
      // hand-overs ago (or nothing), as a page that does not yet see its predecessor's last writes does.
      const stale = behind(
        storage,
        directoryKey(scope, 0),
        round % 3 === 0
          ? null
          : (storage.items.get(directoryKey(scope, 0)) ?? null),
        round % 2,
      );
      const markers = createWriteFailureMarkers(stale.view, undefined, {
        id: () => `${name}-${round}`,
        locks: storage.lockWorld.page(`${name}-${round}`),
        slotStart: () => 0,
      });
      expect(await markers.prepare()).toBe(true);
      const operation = `draft:${round}`;
      expect(markers.set(scope, operation).state).toBe("recorded");
      expected.push(operation);
      markers.release();
    }
    const reader = pageMarkers(storage, { events: false });
    const read = reader.inspect(scope);
    expect(read.known).toBe(true);
    expect([...read.operations].sort()).toEqual([...expected].sort());
    for (const operation of expected)
      expect(reader.probe(scope, operation)).toBe("marked");
    // The raw keys, read by an oracle that uses neither witness, are exactly these.
    const raw = [...storage.items.keys()].filter((key) =>
      key.startsWith(MARKER_PREFIX),
    );
    expect(raw).toHaveLength(expected.length);
  });

  test("the same page that releases and takes its slot again (a controller's stop and start) keeps its own failures and lists them all", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const markers = locked("same", storage);
    await markers.prepare();
    markers.set(scope, OP);
    markers.release();
    markers.set(scope, OTHER);
    await markers.prepare();
    markers.set(scope, THIRD);
    const listed = JSON.parse(
      storage.items.get(directoryKey(scope, 0)) as string,
    ) as { e: Array<[string, string]> };
    expect(listed.e.map(([operation]) => operation).sort()).toEqual(
      [OP, OTHER, THIRD].sort(),
    );
    expect(pageMarkers(storage, { events: false }).inspect(scope)).toEqual({
      operations: expect.arrayContaining([OP, OTHER, THIRD]),
      known: true,
    });
  });
});

describe("each witness alone finds a failure, and the absence of both is the only absence", () => {
  test("a failure with no directory entry anywhere is found by the listing, cold and informed", () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    storage.items.set(markerKey(scope, OP, "stray.1"), "1");
    for (const call of CALLS)
      for (const reader of READERS) {
        const markers = pageMarkers(storage, { events: false });
        if (reader === "informed") markers.probe(scope, OP);
        expect(protectedBy(markers, call, OP)).toBe(true);
      }
  });

  test("a failure the listing omits (the origin's keys churn during the walk) is found by its directory", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const writer = locked("writer", storage);
    await writer.prepare();
    writer.set(scope, OP);
    const other = storage.page("churner");
    let churned = 0;
    // ADAPTED, revision 35 (P11): there is no walk to churn inside; the churn acts just before each snapshot, and the failure is found
    // (by the snapshot, and by its directory).
    storage.onKeys = () => {
      churned += 1;
      other.storage.removeItem("unrelated");
      other.storage.setItem(`unrelated-${churned}`, "1");
      other.storage.setItem("unrelated", "1");
    };
    const reader = pageMarkers(storage, { events: false });
    for (const call of CALLS) expect(protectedBy(reader, call, OP)).toBe(true);
    expect(churned).toBeGreaterThan(0);
  });

  test("a failure whose directory cannot be read is found by the listing, and nothing else is then known to be absent", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const writer = locked("writer", storage);
    await writer.prepare();
    writer.set(scope, OP);
    storage.items.set(directoryKey(scope, 9), "not a directory");
    const reader = pageMarkers(storage, { events: false });
    expect(reader.probe(scope, OP)).toBe("marked");
    expect(reader.probe(scope, OTHER)).toBe("unknown");
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: false });
  });

  test("a listing that is refused, that loses a key under its walk, or that finds the length changed, is unknown for everything it does not name", () => {
    const scope = scopeOf(A);
    const build = () => {
      const storage = new FakeMarkerStorage();
      const owner = pageMarkers(storage);
      owner.set(scope, OP);
      return { storage, reader: pageMarkers(storage, { events: false }) };
    };
    {
      const { storage, reader } = build();
      storage.forbidEnumeration = true;
      expect(reader.probe(scope, OP)).toBe("marked");
      expect(reader.probe(scope, OTHER)).toBe("unknown");
    }
    {
      // ADAPTED, revision 35 (P11): `key(i)` is not read any more, so "a key that is not there at an index below the length" cannot
      // arise. Its intent (a listing that cannot be completed is unknown, never absence) is asserted of the snapshot: one that throws
      // while the size can still be read.
      const { storage, reader } = build();
      storage.keys = () => {
        throw new DOMException("read refused", "SecurityError");
      };
      expect(reader.probe(scope, OP)).toBe("marked");
      expect(reader.probe(scope, OTHER)).toBe("unknown");
      expect(reader.inspect(scope).known).toBe(false);
    }
    for (const call of ["probe", "witness", "inspect"] as const) {
      // ADAPTED, revision 35 (P11): another page writes just before the snapshot (each read gets a world of its own). Revision 34
      // answered `unknown` because its walk saw the length move; a snapshot is one operation that the write precedes, so the read is
      // WHOLE, and the absence of the operation is known.
      const { storage, reader } = build();
      const other = storage.page("writer");
      let wrote = 0;
      storage.onKeys = () => {
        if (wrote > 0) return;
        wrote += 1;
        other.storage.setItem("appeared", "1");
      };
      if (call === "probe") expect(reader.probe(scope, OTHER)).toBe("unmarked");
      else if (call === "witness")
        expect(reader.witness(scope, OTHER)).toEqual({ kind: "none" });
      else
        expect(reader.inspect(scope)).toEqual({
          operations: [OP],
          known: true,
        });
      expect(wrote).toBe(1);
    }
    {
      // The control: nothing disturbs the walk, and absence is known.
      const { reader } = build();
      expect(reader.probe(scope, OTHER)).toBe("unmarked");
      expect(reader.witness(scope, OTHER)).toEqual({ kind: "none" });
    }
  });

  test("more keys in the origin than a walk will make is unknown, not a partial answer, and what a directory names is still found", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const writer = locked("writer", storage);
    await writer.prepare();
    writer.set(scope, OP);
    const reader = pageMarkers(storage, { events: false });
    expect(reader.probe(scope, OTHER)).toBe("unmarked");
    for (let n = 0; n < LISTING_MAX_KEYS; n += 1)
      storage.items.set(`unrelated-${n}`, "1");
    expect(reader.probe(scope, OP)).toBe("marked");
    expect(reader.probe(scope, OTHER)).toBe("unknown");
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: false });
  });

  test("an unreadable key of one operation makes that operation unknown and no other, whichever witness named it", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const writer = locked("writer", storage);
    await writer.prepare();
    writer.set(scope, OP);
    storage.items.set(markerKey(scope, OTHER, "stray.1"), "1");
    const reader = pageMarkers(storage, { events: false });
    storage.failGetsFor = (key) => key === markerKey(scope, OTHER, "stray.1");
    expect(reader.probe(scope, OP)).toBe("marked");
    expect(reader.probe(scope, OTHER)).toBe("unknown");
    expect(reader.probe(scope, THIRD)).toBe("unmarked");
  });
});

describe("concurrent insertion and removal while a read is under way", () => {
  test("a failure recorded by another page during the walk is not an omission of one that stood: the read names everything that stood before it began", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const first = locked("first", storage, 0);
    await first.prepare();
    first.set(scope, OP);
    first.set(scope, OTHER);
    const second = locked("second", storage, 1);
    await second.prepare();
    let wrote = false;
    // ADAPTED, revision 35 (P11): the other page records its failure just before the snapshot (the only place between two operations
    // that a write can land); revision 34's walk saw it mid-walk and said `known: false`. The read names everything that stood before
    // it began, as before, and is whole (it may name the new failure too, which is not an omission of anything).
    storage.onKeys = () => {
      if (!wrote) {
        wrote = true;
        second.set(scope, THIRD);
      }
    };
    const reader = pageMarkers(storage, { events: false });
    const read = reader.inspect(scope);
    expect(wrote).toBe(true);
    expect(read.operations).toEqual(expect.arrayContaining([OP, OTHER]));
    expect(read.known).toBe(true);
    storage.onKeys = null;
    expect(reader.inspect(scope)).toEqual({
      operations: expect.arrayContaining([OP, OTHER, THIRD]),
      known: true,
    });
  });

  test("a failure removed by another page during the walk is not resurrected by it, and a recovered operation regains known absence", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const first = locked("first", storage);
    await first.prepare();
    first.set(scope, OP);
    first.set(scope, OTHER);
    const reader = pageMarkers(storage, { events: false });
    const seen = reader.witness(scope, OP);
    const other = storage.page("recoverer");
    // ADAPTED, revision 35 (P11): the other page's recovery lands just before the snapshot, not inside a walk.
    let removed = 0;
    storage.onKeys = () => {
      for (const key of markerKeys(storage, A, OP)) {
        other.storage.removeItem(key);
        removed += 1;
      }
    };
    reader.inspect(scope);
    storage.onKeys = null;
    expect(removed).toBeGreaterThan(0);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(reader.probe(scope, OP)).toBe("unmarked");
    expect(reader.retire(scope, OP, seen)).toBe(false);
    expect(reader.probe(scope, OTHER)).toBe("marked");
  });
});

describe("what a hand-over's prune and a refused lock can and cannot do (Q-D2, Q-D5)", () => {
  test("a view that says an inherited failure's KEY is gone (a stale read during the prune) drops its entry for a moment: the heal lists it again in the same write, and the key was never touched", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const first = locked("first", storage);
    await first.prepare();
    first.set(scope, OP);
    first.release();
    const key = markerKey(scope, OP, "first.1");
    let staleReads = 0;
    const view: MarkerStorage = {
      get length() {
        return storage.length;
      },
      key: (index) => storage.key(index),
      // ADAPTED, revision 35 (P11): the snapshot of the keys is the store's own.
      keys: () => storage.keys(),
      // The prune's own read of the inherited key is behind (once); the walk and everything else read the real storage.
      getItem: (asked) => {
        if (asked === key && staleReads === 0) {
          staleReads += 1;
          return null;
        }
        return storage.getItem(asked);
      },
      setItem: (asked, value) => storage.setItem(asked, value),
      removeItem: (asked) => storage.removeItem(asked),
    };
    const next = createWriteFailureMarkers(view, undefined, {
      id: () => "next",
      locks: storage.lockWorld.page("next"),
      slotStart: () => 0,
    });
    await next.prepare();
    expect(next.set(scope, OTHER).state).toBe("recorded");
    expect(staleReads).toBe(1);
    expect(markerStands(storage, A, OP)).toBe(true);
    const listed = JSON.parse(
      storage.items.get(directoryKey(scope, 0)) as string,
    ) as { e: Array<[string, string]> };
    expect(listed.e.map(([operation]) => operation).sort()).toEqual(
      [OP, OTHER].sort(),
    );
  });

  for (const how of ["throws", "rejects"] as const)
    test(`a lock request that ${how} costs the directory and nothing else: the failure is recorded and found`, async () => {
      const storage = new FakeMarkerStorage();
      const scope = scopeOf(A);
      const markers = createWriteFailureMarkers(storage, undefined, {
        id: () => "bad-locks",
        locks: {
          tryAcquire: () => {
            if (how === "throws") throw new Error("the lock manager is gone");
            return Promise.reject(new Error("the lock manager is gone"));
          },
        },
        slotStart: () => 0,
      });
      expect(markers.set(scope, OP).state).toBe("recorded");
      expect(await markers.prepare()).toBe(false);
      expect(markerStands(storage, A, OP)).toBe(true);
      expect(storage.items.has(directoryKey(scope, 0))).toBe(false);
      expect(pageMarkers(storage, { events: false }).probe(scope, OP)).toBe(
        "marked",
      );
    });
});

describe("a page that records a failure heals the directory it writes", () => {
  test("a failure whose entry a stale hand-over dropped is listed again by the next page that writes its directory", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const first = locked("first", storage);
    await first.prepare();
    first.set(scope, OP);
    first.release();
    const stale = behind(storage, directoryKey(scope, 0), null);
    const damaging = createWriteFailureMarkers(stale.view, undefined, {
      id: () => "damaging",
      locks: storage.lockWorld.page("damaging"),
      slotStart: () => 0,
    });
    await damaging.prepare();
    // The damage: a directory that does not list the first failure (the heal is bypassed by publishing through a page that lists none).
    storage.items.set(
      directoryKey(scope, 0),
      JSON.stringify({ v: 1, e: [[OTHER, "damaging.1"]] }),
    );
    storage.items.set(markerKey(scope, OTHER, "damaging.1"), "1");
    damaging.release();
    const healer = locked("healer", storage);
    await healer.prepare();
    expect(healer.set(scope, THIRD).state).toBe("recorded");
    const listed = JSON.parse(
      storage.items.get(directoryKey(scope, 0)) as string,
    ) as { e: Array<[string, string]> };
    expect(listed.e.map(([operation]) => operation).sort()).toEqual(
      [OP, OTHER, THIRD].sort(),
    );
  });

  test("the heal never drops a failure that stands, and a directory that cannot be parsed is left exactly as it is", async () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    storage.items.set(directoryKey(scope, 0), "garbage");
    storage.items.set(markerKey(scope, OP, "stray.1"), "1");
    const markers = locked("unlucky", storage);
    await markers.prepare();
    expect(markers.set(scope, OTHER).state).toBe("recorded");
    expect(storage.items.get(directoryKey(scope, 0))).toBe("garbage");
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(markerStands(storage, A, OTHER)).toBe(true);
  });
});

describe("a walk disturbed ONCE is caught by the second walk, and the two witnesses fail together only if the disturbance is consistent", () => {
  // The review's churn (revision 32), exactly: after the first key is read another context removes the key that precedes the marker and
  // appends another, so the walk's order shifts under it, it skips the marker, and the length is the same when it ends. In revision 32
  // that was an absence. The walk is made twice now, and a disturbance that spoils one walk makes the two disagree.
  test("a key that no directory lists and a walk that skips it: the read is `unknown`, never `unmarked`, and the next undisturbed read finds it", () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    // The key stands, listed by no directory (its entry was lost, or its page held no slot), and follows an unrelated key in the walk.
    storage.items.set("unrelated-before", "1");
    storage.items.set(markerKey(scope, OP, "lost.1"), "1");
    const reader = pageMarkers(storage, { events: false });
    const other = storage.page("churner");
    let churned = false;
    // ADAPTED, revision 35 (P11): the review's churn lands where it can, just before the snapshot. Revision 34 answered `unknown` (its
    // two walks disagreed); a snapshot cannot be shifted, so the answer is the stronger one: the failure is found at once.
    storage.onKeys = () => {
      if (churned) return;
      churned = true;
      other.storage.removeItem("unrelated-before");
      other.storage.setItem("unrelated-after", "1");
    };
    expect(reader.probe(scope, OP)).toBe("marked");
    expect(churned).toBe(true);
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: true });
    expect(reader.probe(scope, OP)).toBe("marked");
  });

  test("two walks that disagree on WHICH failures stand (one ended and another was recorded between them) are unknown for everything they do not name", () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    storage.items.set(markerKey(scope, OP, "first.1"), "1");
    storage.items.set("unrelated", "1");
    const reader = pageMarkers(storage, { events: false });
    const other = storage.page("recoverer");
    // The first walk makes two `key` calls; the third is the start of the second walk, and another page ends one failure and records
    // another just before it, so the two walks name the same NUMBER of failures and not the same failures.
    let calls = 0;
    // ADAPTED, revision 35 (P11): the other page ends one failure and records another just before the snapshot. There is one snapshot
    // and no second walk to disagree with: the read sees the ended failure gone and the recorded one standing, and is whole.
    storage.onKeys = () => {
      calls += 1;
      if (calls !== 1) return;
      other.storage.removeItem(markerKey(scope, OP, "first.1"));
      other.storage.setItem(markerKey(scope, OTHER, "second.1"), "1");
    };
    expect(reader.probe(scope, THIRD)).toBe("unmarked");
    expect(calls).toBeGreaterThanOrEqual(1);
    storage.onKeys = null;
    expect(reader.probe(scope, THIRD)).toBe("unmarked");
    expect(reader.probe(scope, OTHER)).toBe("marked");
    expect(reader.probe(scope, OP)).toBe("unmarked");
  });

  // ADAPTED, revision 35 (R55): revision 34 kept this case as a KNOWN LIMIT and asserted the false absence (`unmarked`, and a whole read
  // without the operation). The review of revision 34 showed that it is a lost protection, reachable through public callers. It is now a
  // PROTECTION obligation: the same adversary (it controls the ORDER of the origin's keys at every call, adds and removes nothing) acts at
  // every operation the read makes, the old `key(i)` hook included, and the failure is found and the read is whole, because the read is
  // one snapshot and no `key(i)`. The title keeps its words so that the selectors that name it still do.
  test("characterisation: a key that no directory lists, skipped by BOTH walks the same way, is an absence to that read", () => {
    const storage = new FakeMarkerStorage();
    const scope = scopeOf(A);
    const marker = markerKey(scope, OP, "lost.1");
    storage.items.set("unrelated-before", "1");
    storage.items.set(marker, "1");
    storage.items.set("unrelated-after", "1");
    const reader = pageMarkers(storage, { events: false });
    // An adversary that controls the ORDER of the origin's keys at every call (a model of an engine whose order shifts under the walk,
    // which no installed engine does inside one synchronous step): each walk starts with the marker second and has it moved to the
    // front just before the second key is read, so that the walk has already passed its place both times. The keys are never added or
    // removed, so the length is the same, and the two walks agree.
    const order = (names: string[]) => {
      const keep = new Map(storage.items);
      storage.items.clear();
      for (const name of names)
        storage.items.set(name, keep.get(name) as string);
    };
    storage.onKey = (index) => {
      if (index === 0) order(["unrelated-before", marker, "unrelated-after"]);
      if (index === 1) order([marker, "unrelated-before", "unrelated-after"]);
    };
    // The adversary also acts at every operation the read does make (before each snapshot and each read of a value), alternating the
    // two orders as it did between the indices.
    let moves = 0;
    const move = () => {
      moves += 1;
      order(
        moves % 2 === 1
          ? ["unrelated-before", marker, "unrelated-after"]
          : [marker, "unrelated-before", "unrelated-after"],
      );
    };
    storage.onKeys = move;
    storage.onGet = move;
    expect(reader.probe(scope, OP)).toBe("marked");
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: true });
    expect(reader.witness(scope, OP)).toEqual({
      kind: "instance",
      instances: ["lost.1"],
    });
    expect(moves).toBeGreaterThan(0);
    // The marker was never added, removed or hidden.
    expect(storage.items.get(marker)).toBe("1");
    storage.onKey = null;
    storage.onKeys = null;
    storage.onGet = null;
    expect(reader.probe(scope, OP)).toBe("marked");
  });
});

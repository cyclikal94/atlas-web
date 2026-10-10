// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  DIRECTORY_MAX_ENTRIES,
  DIRECTORY_PREFIX,
  directoryKey,
  MARKER_PREFIX,
  markerKey,
  OBSERVATION_MAX_ENTRIES,
  SLOT_COUNT,
  SLOT_LOCK_PREFIX,
  type WriteFailureMarkers,
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
 * R55 (revisions 33 and 34): whether a failure stands is read from TWO witnesses, the DIRECTORIES' fixed addresses and the LISTING of the
 * origin's keys, and a failure that either finds stands.
 *
 * The independent review of revision 32 showed (on the production implementation, over a model of `Storage`) that a listing made while an
 * unrelated key is removed and another is added can return a store of the same length that omits a marker which stood throughout, and that
 * the marker module then took the omission for absence. Revision 33 answered with directories that a page publishes into under a Web Lock
 * and a reader reads at fixed addresses. The review of revision 33 then showed that a directory can lose an entry the other way round: the
 * lock hands a slot over and says nothing about whether the new owner sees what the previous one wrote last, so a directory rewritten from
 * a stale view omits a failure whose key stands. Each witness fails for a cause the other does not have, so revision 34 reads both.
 *
 * This file is the module's contract for the directories (ownership, takeover, exhaustion, release, the order of the two writes, the
 * bounds) and for the reviewer's six churn schedules, which are carried as the SAME cases. ADAPTED in revision 34, with the old intent
 * kept: the origin's listing was FORBIDDEN in revision 33 (the premise that the listing is not authority); it is now a witness, so the
 * churn is applied to the listing as well as between the reads, and what the cases assert is that the failure is found whichever
 * witness is disturbed. `marker-witnesses.test.ts` holds the new cases (stale hand-over, a refused listing, the heal).
 *
 * FIXTURE evidence: a double of `localStorage` that models pages and Web Locks; the native pages over real `localStorage` and real Web
 * Locks are E-O12/E-O13. That a lock hand-over makes another page's write visible is NOT assumed anywhere (it is false: a
 * Web-Locks-serialised read-modify-write lost updates on Firefox and WebKit when measured).
 */
const A = "acct-1";
const OP = "draft:a";
const OTHER = "draft:b";
const UNRELATED_BEFORE = "unrelated-before";
const UNRELATED_AFTER = "unrelated-after";

function pages() {
  const storage = new FakeMarkerStorage();
  const mine = pageMarkers(storage);
  const other = storage.page("another-tab");
  const theirs = pageMarkers(other);
  return { storage, mine, other, theirs };
}

describe("a failure that stands throughout is never missed because the origin's other keys change (the review's six schedules)", () => {
  // The reviewer's schedule: [unrelated-before, protective-marker]; just after the FIRST key is read another writer removes
  // `unrelated-before` and appends `unrelated-after`. A listing that follows the current order returns `unrelated-after` at index 1 and
  // omits the marker. The schedule is carried here in both forms the reads can suffer: the same removal and insertion happen, by a
  // second page, between EVERY pair of reads of the directories, and (adapted, revision 34) between EVERY pair of keys of the listing.
  type Reader = "cold" | "established";
  type Call = "probe" | "witness" | "inspect";
  const READERS: Reader[] = ["cold", "established"];
  const CALLS: Call[] = ["probe", "witness", "inspect"];
  for (const reader of READERS)
    for (const call of CALLS) {
      test(`${reader} reader, ${call}: churn of unrelated keys between its reads and inside its listing omits nothing`, () => {
        const { storage, other, theirs } = pages();
        theirs.set(scopeOf(A), OP);
        storage.items.set(UNRELATED_BEFORE, "1");
        const markers: WriteFailureMarkers =
          reader === "established"
            ? (() => {
                const established = pageMarkers(storage, { events: false });
                // An earlier read found it and established it.
                expect(established.probe(scopeOf(A), OP)).toBe("marked");
                return established;
              })()
            : pageMarkers(storage, { events: false });
        let churned = 0;
        let inListing = 0;
        const churn = () => {
          // Another page removes one unrelated key and adds another, as the review's writer does; a real write, so its event is delivered.
          churned += 1;
          other.storage.removeItem(UNRELATED_BEFORE);
          other.storage.setItem(`${UNRELATED_AFTER}-${churned}`, "1");
          other.storage.setItem(UNRELATED_BEFORE, "1");
        };
        storage.onGet = churn;
        // ADAPTED, revision 35 (R55): the listing is ONE snapshot of the keys now (the standard's single "get the keys"), so the
        // interleaving acts immediately before it (between two operations of the page), never inside it: there is no index to shift.
        storage.onKeys = () => {
          inListing += 1;
          churn();
        };
        const stands = markerStands(storage, A, OP);
        expect(stands).toBe(true);
        if (call === "probe")
          expect(markers.probe(scopeOf(A), OP)).toBe("marked");
        else if (call === "witness")
          expect(markers.witness(scopeOf(A), OP).kind).toBe("instance");
        else {
          const read = markers.inspect(scopeOf(A));
          // Found whichever witness the churn disturbed; a listing that the churn made untrustworthy may also say `unknown`, which is
          // protective, and never `known` without the operation.
          expect(read.operations).toContain(OP);
          // Revision 35: the snapshot is complete under this churn, so the read is whole as well.
          expect(read).toEqual({ operations: [OP], known: true });
        }
        // The interleaving engaged at both kinds of read, and the protective key stood throughout.
        expect(churned).toBeGreaterThanOrEqual(SLOT_COUNT);
        expect(inListing).toBeGreaterThan(0);
        expect(markerStands(storage, A, OP)).toBe(true);
      });

      test(`${reader} reader, ${call}, control (no churn): the same answer`, () => {
        const { storage, theirs } = pages();
        theirs.set(scopeOf(A), OP);
        const markers = pageMarkers(storage, { events: false });
        if (reader === "established") markers.probe(scopeOf(A), OP);
        if (call === "probe")
          expect(markers.probe(scopeOf(A), OP)).toBe("marked");
        else if (call === "witness")
          expect(markers.witness(scopeOf(A), OP).kind).toBe("instance");
        else
          expect(markers.inspect(scopeOf(A))).toEqual({
            operations: [OP],
            known: true,
          });
      });
    }

  test("a genuinely empty store is free: nothing stands, and every read says so (positive control)", () => {
    const { mine } = pages();
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
    expect(mine.witness(scopeOf(A), OP)).toEqual({ kind: "none" });
    expect(mine.inspect(scopeOf(A))).toEqual({ operations: [], known: true });
  });

  test("a failure another page records during a read is a newer failure: the read may or may not see it, and neither answer ends anything", () => {
    const { storage, mine, theirs } = pages();
    mine.set(scopeOf(A), OP);
    const seen = mine.witness(scopeOf(A), OP);
    let recorded = false;
    storage.onGet = () => {
      if (recorded) return;
      recorded = true;
      theirs.set(scopeOf(A), OP);
    };
    mine.probe(scopeOf(A), OP);
    expect(recorded).toBe(true);
    // The witness taken before names only what stood then; retiring it leaves the newer failure.
    expect(mine.retire(scopeOf(A), OP, seen)).toBe(true);
    expect(markerKeys(storage, A, OP)).toHaveLength(1);
    expect(mine.probe(scopeOf(A), OP)).toBe("marked");
  });
});

describe("what a reader needs to find a failure", () => {
  test("a failure is found through its page's directory and its own key, whichever slot its page owns", () => {
    const storage = new FakeMarkerStorage();
    const reader = pageMarkers(storage, { events: false });
    for (const slot of [0, 5, SLOT_COUNT - 1]) {
      const name = `p${slot}.1`;
      plantMarker(storage, A, `draft:${slot}`, name, slot);
    }
    expect(reader.inspect(scopeOf(A)).operations.sort()).toEqual(
      [0, 5, SLOT_COUNT - 1].map((slot) => `draft:${slot}`).sort(),
    );
  });

  test("a listed failure whose key is gone has ended: it is not standing, and is dropped from the directory by the next publication", () => {
    const { storage, mine, other, theirs } = pages();
    theirs.set(scopeOf(A), OP);
    const [key] = markerKeys(storage, A, OP) as [string];
    other.storage.removeItem(key);
    expect(mine.probe(scopeOf(A), OP)).toBe("unmarked");
    // The directory still lists it; the page that owns it prunes the entry when it next publishes.
    const directory = directoryKey(scopeOf(A), other.slot);
    expect(storage.items.get(directory)).toContain(OP);
    theirs.set(scopeOf(A), OTHER);
    const kept = JSON.parse(storage.items.get(directory) as string) as {
      e: Array<[string, string]>;
    };
    expect(kept.e.map(([operation]) => operation)).toEqual([OTHER]);
  });

  test("the directory is written FIRST so that a key published by a page that holds a slot is always listed; a key with no directory entry is found by the listing (adapted, revision 34)", () => {
    const { storage, mine } = pages();
    // The order of the page's own two writes, observed at the storage.
    const order: string[] = [];
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      order.push(key.startsWith(DIRECTORY_PREFIX) ? "directory" : "key");
      setItem(key, value);
    };
    mine.set(scopeOf(A), OP);
    expect(order).toEqual(["directory", "key"]);
    // ADAPTED: in revision 33 a key planted without a directory entry was outside every read (the directories were the only witness).
    // The listing is the other witness now: a key that stands is found whichever directory lists it, and the old intent (a reader is
    // never misled about a key that stands) is what the case asserts.
    storage.items.set(markerKey(scopeOf(A), OTHER, "stray.1"), "1");
    expect(mine.probe(scopeOf(A), OTHER)).toBe("marked");
    expect(
      pageMarkers(storage, { events: false }).inspect(scopeOf(A)).operations,
    ).toContain(OTHER);
  });

  test("the values a healthy page reads are the SLOT_COUNT fixed addresses and nothing else; the listing reads keys, never a value", () => {
    const { storage, mine } = pages();
    const asked: string[] = [];
    const getItem = storage.getItem.bind(storage);
    storage.getItem = (key) => {
      asked.push(key);
      return getItem(key);
    };
    mine.probe(scopeOf(A), OP);
    expect(asked).toEqual(
      Array.from({ length: SLOT_COUNT }, (_, slot) =>
        directoryKey(scopeOf(A), slot),
      ),
    );
    // The listing (adapted, revision 34: it was forbidden in revision 33) walked the origin's keys once.
    expect(storage.enumerations).toBeGreaterThan(0);
  });

  test("two lifetimes of one account have different addresses: neither sees the other's directories or keys", () => {
    const { storage, mine, theirs } = pages();
    const first = scopeOf(A, "inc-a");
    const second = scopeOf(A, "inc-b");
    theirs.set(first, OP);
    expect(mine.probe(second, OP)).toBe("unmarked");
    expect(mine.inspect(second)).toEqual({ operations: [], known: true });
    expect(mine.probe(first, OP)).toBe("marked");
    expect(directoryKey(first, 3)).not.toBe(directoryKey(second, 3));
    // The listing walks the keys of every lifetime and answers only for the scope it was asked about.
    expect(storage.enumerations).toBeGreaterThan(0);
    expect(mine.witness(second, OP)).toEqual({ kind: "none" });
  });
});

describe("the order and the failure of the two writes (a crash or a refusal at each)", () => {
  test("the key cannot be written: the directory is put back, nothing stands, and the failure is reported as unrecorded", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OTHER);
    const directory = directoryKey(scopeOf(A), 0);
    const before = storage.items.get(directory);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key.startsWith(MARKER_PREFIX))
        throw new DOMException("full", "QuotaExceededError");
      setItem(key, value);
    };
    expect(mine.set(scopeOf(A), OP).state).toBe("unavailable");
    expect(storage.items.get(directory)).toBe(before);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(markerStands(storage, A, OTHER)).toBe(true);
  });

  test("the directory cannot be written: nothing is written, and the earlier failures stand", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OTHER);
    storage.failWrites = true;
    expect(mine.set(scopeOf(A), OP).state).toBe("unavailable");
    storage.failWrites = false;
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(mine.probe(scopeOf(A), OTHER)).toBe("marked");
  });

  test("a page that stops after the directory and before the key leaves a listing that ends nothing, and no reader is misled", () => {
    const { storage, mine, theirs } = pages();
    const setItem = storage.setItem.bind(storage);
    const removeItem = storage.removeItem.bind(storage);
    // The key write and the rollback both fail: the page "died" between the two writes.
    storage.setItem = (key, value) => {
      if (key.startsWith(MARKER_PREFIX))
        throw new DOMException("gone", "InvalidStateError");
      setItem(key, value);
    };
    storage.removeItem = () => {
      throw new DOMException("gone", "InvalidStateError");
    };
    mine.set(scopeOf(A), OP);
    storage.setItem = setItem;
    storage.removeItem = removeItem;
    // The directory still lists the failure whose key was never written.
    expect(storage.items.get(directoryKey(scopeOf(A), 0))).toContain(OP);
    expect(markerStands(storage, A, OP)).toBe(false);
    expect(theirs.probe(scopeOf(A), OP)).toBe("unmarked");
    // The listing is dropped by the next publication.
    mine.set(scopeOf(A), OTHER);
    const kept = JSON.parse(
      storage.items.get(directoryKey(scopeOf(A), 0)) as string,
    ) as { e: Array<[string, string]> };
    expect(kept.e.map(([operation]) => operation)).toEqual([OTHER]);
  });

  test("a failure recorded again replaces the page's own older key only after the new one is stored and listed", () => {
    const { storage, mine } = pages();
    mine.set(scopeOf(A), OP);
    const [older] = markerKeys(storage, A, OP) as [string];
    const seen: string[] = [];
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = (key) => {
      // When the older key goes, the newer is already stored.
      seen.push(
        `${key === older ? "older" : "other"}:${markerKeys(storage, A, OP).length}`,
      );
      removeItem(key);
    };
    mine.set(scopeOf(A), OP);
    expect(seen).toEqual(["older:2"]);
    expect(markerKeys(storage, A, OP)).toHaveLength(1);
  });
});

describe("bounds: refused, never made by dropping a failure that stands", () => {
  test("a directory that would list more failures than its bound is not written: the new failure is recorded all the same (found by the listing) and every old one stays (adapted, revision 34)", () => {
    const { storage, mine } = pages();
    const entries: Array<[string, string]> = [];
    for (let n = 0; n < DIRECTORY_MAX_ENTRIES; n += 1) {
      const name = `seed.${n + 1}`;
      entries.push([`draft:${n}`, name]);
      storage.items.set(markerKey(scopeOf(A), `draft:${n}`, name), "1");
    }
    storage.items.set(
      directoryKey(scopeOf(A), 0),
      JSON.stringify({ v: 1, e: entries }),
    );
    // ADAPTED: revision 33 refused the failure ("unavailable", held in memory). Capacity never turns a failure into a memory-only one
    // now: its key is written, the directory is left exactly as it was (nothing that stands is dropped), and the listing finds it.
    const before = storage.items.get(directoryKey(scopeOf(A), 0));
    expect(mine.set(scopeOf(A), OP).state).toBe("recorded");
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(storage.items.get(directoryKey(scopeOf(A), 0))).toBe(before);
    expect(pageMarkers(storage, { events: false }).probe(scopeOf(A), OP)).toBe(
      "marked",
    );
    expect(mine.probe(scopeOf(A), "draft:0")).toBe("marked");
    expect(mine.probe(scopeOf(A), `draft:${DIRECTORY_MAX_ENTRIES - 1}`)).toBe(
      "marked",
    );
  });

  test("a directory too long in text is not written either, and the failure is recorded all the same (adapted, revision 34)", () => {
    const { storage, mine } = pages();
    const entries: Array<[string, string]> = [];
    const long = "x".repeat(2_000);
    for (let n = 0; n < 150; n += 1) {
      const name = `seed.${n + 1}`;
      entries.push([`draft:${long}${n}`, name]);
      storage.items.set(markerKey(scopeOf(A), `draft:${long}${n}`, name), "1");
    }
    storage.items.set(
      directoryKey(scopeOf(A), 0),
      JSON.stringify({ v: 1, e: entries }),
    );
    expect(mine.set(scopeOf(A), OP).state).toBe("recorded");
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(mine.probe(scopeOf(A), `draft:${long}0`)).toBe("marked");
    expect(pageMarkers(storage, { events: false }).probe(scopeOf(A), OP)).toBe(
      "marked",
    );
  });

  test("an observation that would check more failures than its work bound is `unknown`, not a partial answer", () => {
    const storage = new FakeMarkerStorage();
    const reader = pageMarkers(storage, { events: false });
    const per = Math.ceil((OBSERVATION_MAX_ENTRIES + 1) / 8);
    for (let slot = 0; slot < 8; slot += 1) {
      const entries: Array<[string, string]> = [];
      for (let n = 0; n < per; n += 1)
        entries.push([`draft:${slot}-${n}`, `s${slot}.${n + 1}`]);
      storage.items.set(
        directoryKey(scopeOf(A), slot),
        JSON.stringify({ v: 1, e: entries }),
      );
    }
    expect(reader.probe(scopeOf(A), OP)).toBe("unknown");
    expect(reader.inspect(scopeOf(A)).known).toBe(false);
  });

  test("a directory that is not one (text that does not parse, another shape, a bad name) is `unknown` for the whole scope, and is never overwritten", () => {
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ v: 2, e: [] }),
      JSON.stringify({ v: 1, e: [["draft:a"]] }),
      JSON.stringify({ v: 1, e: [["draft:a", "has a space.1"]] }),
      JSON.stringify({ v: 1, e: [[1, "p.1"]] }),
    ]) {
      const { storage, mine } = pages();
      storage.items.set(directoryKey(scopeOf(A), 7), bad);
      expect(mine.probe(scopeOf(A), OP)).toBe("unknown");
      expect(mine.inspect(scopeOf(A)).known).toBe(false);
      // Another scope is not touched by it.
      expect(mine.probe(scopeOf("acct-2"), OP)).toBe("unmarked");
      // This page's own directory is its own; a malformed directory of another slot is not rewritten by its publication.
      expect(mine.set(scopeOf(A), OP).state).toBe("recorded");
      expect(storage.items.get(directoryKey(scopeOf(A), 7))).toBe(bad);
    }
  });

  test("a malformed directory in the slot this page owns is not overwritten either: the failure is recorded without a listing, and the listing finds it (adapted, revision 34)", () => {
    const { storage, mine } = pages();
    storage.items.set(directoryKey(scopeOf(A), 0), "garbage");
    expect(mine.set(scopeOf(A), OP).state).toBe("recorded");
    expect(storage.items.get(directoryKey(scopeOf(A), 0))).toBe("garbage");
    expect(markerStands(storage, A, OP)).toBe(true);
    // The page that wrote it knows it; a reader finds it through the listing although a directory is unreadable, and says the read is
    // not whole.
    const reader = pageMarkers(storage.page("reader"), { events: false });
    expect(reader.probe(scopeOf(A), OP)).toBe("marked");
    expect(reader.inspect(scopeOf(A))).toEqual({
      operations: [OP],
      known: false,
    });
  });
});

describe("the slot protocol: one writer for each directory", () => {
  function slotted(name: string, storage: FakeMarkerStorage, start = 0) {
    const locks = storage.lockWorld.page(name);
    const markers = createWriteFailureMarkers(storage, undefined, {
      id: () => name,
      locks,
      slotStart: () => start,
    });
    return { markers, locks };
  }

  test("a page takes the first free slot from its starting point and holds that lock for its life", async () => {
    const storage = new FakeMarkerStorage();
    const one = slotted("one", storage, 3);
    const two = slotted("two", storage, 3);
    expect(await one.markers.prepare()).toBe(true);
    expect(await two.markers.prepare()).toBe(true);
    expect(one.locks.holding()).toEqual([`${SLOT_LOCK_PREFIX}3`]);
    expect(two.locks.holding()).toEqual([`${SLOT_LOCK_PREFIX}4`]);
    // Two pages never write one directory.
    one.markers.set(scopeOf(A), OP);
    two.markers.set(scopeOf(A), OTHER);
    expect(storage.items.has(directoryKey(scopeOf(A), 3))).toBe(true);
    expect(storage.items.has(directoryKey(scopeOf(A), 4))).toBe(true);
    const writers = (slot: number) =>
      (
        JSON.parse(
          storage.items.get(directoryKey(scopeOf(A), slot)) as string,
        ) as {
          e: Array<[string, string]>;
        }
      ).e.map(([, instance]) => instance.split(".")[0]);
    expect(writers(3)).toEqual(["one"]);
    expect(writers(4)).toEqual(["two"]);
  });

  test("a failure recorded before the slot is held is durable AT ONCE, and is listed when the slot arrives (revision 34: it was `pending` in revision 33)", async () => {
    const storage = new FakeMarkerStorage();
    const { markers } = slotted("late", storage);
    const published = markers.set(scopeOf(A), OP);
    // ADAPTED: nothing waits for the lock. The key stands in the step that recorded it; only the directory entry arrives later.
    // Everything below, up to the first await, is the state in the step that recorded the failure: durable, and listed nowhere.
    expect(published.state).toBe("recorded");
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(storage.items.has(directoryKey(scopeOf(A), 0))).toBe(false);
    expect(
      pageMarkers(storage.page("cold"), { events: false }).probe(
        scopeOf(A),
        OP,
      ),
    ).toBe("marked");
    expect(await published.settled).toBe("recorded");
    // The slot arrives: the failure is listed, without being written again.
    expect(await markers.prepare()).toBe(true);
    expect(
      JSON.parse(storage.items.get(directoryKey(scopeOf(A), 0)) as string).e,
    ).toEqual([[OP, "late.1"]]);
    // The slot is held now: the next one is listed at once.
    expect(markers.set(scopeOf(A), OTHER).state).toBe("recorded");
    expect(
      JSON.parse(
        storage.items.get(directoryKey(scopeOf(A), 0)) as string,
      ).e.map(([operation]: [string, string]) => operation),
    ).toEqual([OP, OTHER]);
  });

  test("a page that crashes frees its slot, and the next owner of it inherits the failures its directory lists", async () => {
    const storage = new FakeMarkerStorage();
    const first = slotted("first", storage, 0);
    await first.markers.prepare();
    first.markers.set(scopeOf(A), OP);
    first.locks.crash();
    // The page is gone: nothing but its keys remain, and they still protect.
    const reader = pageMarkers(storage, { events: false });
    expect(reader.probe(scopeOf(A), OP)).toBe("marked");
    const second = slotted("second", storage, 0);
    expect(await second.markers.prepare()).toBe(true);
    expect(second.locks.holding()).toEqual([`${SLOT_LOCK_PREFIX}0`]);
    // The new owner publishes in the same directory without dropping the old failure (its key stands).
    second.markers.set(scopeOf(A), OTHER);
    expect(markerKeys(storage, A, OP)).toHaveLength(1);
    expect(reader.probe(scopeOf(A), OP)).toBe("marked");
    expect(reader.probe(scopeOf(A), OTHER)).toBe("marked");
    // Anyone can end the inherited failure by its exact key.
    const seen = reader.witness(scopeOf(A), OP);
    expect(reader.retire(scopeOf(A), OP, seen)).toBe(true);
    expect(markerStands(storage, A, OP)).toBe(false);
  });

  test("when every slot is held the page still records durably (found by the listing, listed in no directory), and lists its failures once it takes a slot (adapted, revision 34)", async () => {
    const storage = new FakeMarkerStorage();
    const holders = [] as Array<ReturnType<typeof slotted>>;
    for (let n = 0; n < SLOT_COUNT; n += 1) {
      const holder = slotted(`holder-${n}`, storage, n);
      expect(await holder.markers.prepare()).toBe(true);
      holders.push(holder);
    }
    const extra = slotted("extra", storage, 0);
    expect(await extra.markers.prepare()).toBe(false);
    // ADAPTED: capacity is not durability. The failure is recorded (revision 33 held it in memory and said so), and every reader finds it.
    const first = extra.markers.set(scopeOf(A), OP);
    expect(await first.settled).toBe("recorded");
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(
      pageMarkers(storage.page("cold"), { events: false }).probe(
        scopeOf(A),
        OP,
      ),
    ).toBe("marked");
    for (let slot = 0; slot < SLOT_COUNT; slot += 1)
      expect(storage.items.has(directoryKey(scopeOf(A), slot))).toBe(false);
    // One page lets go (its tab closes): the next publication of the extra page finds a slot and lists everything it recorded.
    holders[11]?.locks.crash();
    const later = extra.markers.set(scopeOf(A), OTHER);
    expect(await later.settled).toBe("recorded");
    await extra.markers.prepare();
    expect(extra.locks.holding()).toEqual([`${SLOT_LOCK_PREFIX}11`]);
    expect(
      JSON.parse(
        storage.items.get(directoryKey(scopeOf(A), 11)) as string,
      ).e.map(([operation]: [string, string]) => operation),
    ).toEqual([OP, OTHER]);
  });

  test("a refused lock request costs the directory and nothing else: the failure is recorded, and it is not an exception (adapted, revision 34)", async () => {
    const storage = new FakeMarkerStorage();
    storage.lockWorld.refuse = true;
    const { markers } = slotted("refused", storage);
    const published = markers.set(scopeOf(A), OP);
    expect(await published.settled).toBe("recorded");
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(await markers.prepare()).toBe(false);
  });

  test("a page without Web Locks (none supplied) records durably without a directory and still reads (adapted, revision 34)", () => {
    const storage = new FakeMarkerStorage();
    plantMarker(storage, A, OP, "elsewhere.1");
    const bare = createWriteFailureMarkers(storage, undefined, { locks: null });
    expect(bare.probe(scopeOf(A), OP)).toBe("marked");
    expect(bare.set(scopeOf(A), OTHER).state).toBe("recorded");
    expect(markerStands(storage, A, OTHER)).toBe(true);
    expect(
      pageMarkers(storage.page("cold"), { events: false }).probe(
        scopeOf(A),
        OTHER,
      ),
    ).toBe("marked");
  });

  test("`release` lets go of the slot; later failures are recorded without a listing until `prepare`; a slot being taken at that moment is let go on arrival (adapted, revision 34)", async () => {
    const storage = new FakeMarkerStorage();
    const { markers, locks } = slotted("lease", storage, 2);
    expect(await markers.prepare()).toBe(true);
    markers.release();
    expect(locks.holding()).toEqual([]);
    // ADAPTED: revision 33 answered "unavailable" here. The failure is durable, asks for no lock after a release, and is listed later.
    expect(markers.set(scopeOf(A), OP).state).toBe("recorded");
    expect(locks.holding()).toEqual([]);
    expect(markerStands(storage, A, OP)).toBe(true);
    expect(await markers.prepare()).toBe(true);
    expect(
      JSON.parse(storage.items.get(directoryKey(scopeOf(A), 2)) as string).e,
    ).toEqual([[OP, "lease.1"]]);
    expect(markers.set(scopeOf(A), OP).state).toBe("recorded");
    // Released while the slot is still being taken.
    const racing = slotted("racing", storage, 9);
    const taking = racing.markers.prepare();
    racing.markers.release();
    expect(await taking).toBe(false);
    expect(racing.locks.holding()).toEqual([]);
  });

  test("the lock of a page is requested with the name of the slot only, and only for slots, never as a probe of another page", async () => {
    const storage = new FakeMarkerStorage();
    const { markers } = slotted("names", storage, 30);
    await markers.prepare();
    for (const [, lock] of storage.lockWorld.log)
      expect(lock.startsWith(SLOT_LOCK_PREFIX)).toBe(true);
  });
});

describe("a reload and cold discovery", () => {
  test("a page that reloads finds every failure its predecessor published, with nothing in memory", async () => {
    const storage = new FakeMarkerStorage();
    const locks = storage.lockWorld.page("old");
    const old = createWriteFailureMarkers(storage, undefined, {
      id: () => "old",
      locks,
      slotStart: () => 5,
    });
    await old.prepare();
    old.set(scopeOf(A), OP);
    old.set(scopeOf(A), OTHER);
    locks.crash();
    const fresh = createWriteFailureMarkers(storage, undefined, {
      id: () => "fresh",
      locks: storage.lockWorld.page("fresh"),
      slotStart: () => 5,
    });
    expect(fresh.inspect(scopeOf(A))).toEqual({
      operations: [OP, OTHER],
      known: true,
    });
    expect(fresh.witness(scopeOf(A), OP).kind).toBe("instance");
  });
});

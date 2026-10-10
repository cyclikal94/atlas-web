// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  MARKER_PREFIX,
  type MarkerChange,
  markerKey,
} from "../../src/data/engine/write-failure-marker";
import {
  FakeMarkerStorage,
  markerKeys,
  pageMarkers,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";

/**
 * R15 (revision 11): the marker module reports the changes ANOTHER page makes to the fallback markers, so that an already-open
 * controller can look again. What is reported is a key and nothing else (never a value, never an account's content), and the question a
 * listener asks is scoped: this account, this operation. FIXTURE evidence: a double of `localStorage` that models pages, and jsdom's
 * `StorageEvent` for the default wiring; the native `storage` event in three engines is E-C8.
 */
afterEach(() => {
  window.localStorage.clear();
});

const OP = "invalidate:cursor-0";

function twoPages() {
  const storage = new FakeMarkerStorage();
  const mine = pageMarkers(storage);
  const other = storage.page("another-tab");
  const theirs = pageMarkers(other);
  const heard: MarkerChange[] = [];
  const off = mine.subscribe((change) => heard.push(change));
  return { storage, mine, theirs, other, heard, off };
}

describe("what is reported, and the question a listener asks", () => {
  test("a marker another page sets is reported, and the change answers only for its own account and operation", () => {
    const { theirs, heard } = twoPages();
    theirs.set(scopeOf("acct-1"), OP);
    expect(heard).toHaveLength(1);
    const change = heard[0] as MarkerChange;
    expect(change.touches("acct-1", OP)).toBe(true);
    expect(change.touches("acct-1")).toBe(true);
    expect(change.touches("acct-1", "invalidate:cursor-1")).toBe(false);
    expect(change.touches("acct-1", "page:cursor-0")).toBe(false);
    expect(change.touches("acct-2", OP)).toBe(false);
    expect(change.touches("acct-2")).toBe(false);
    // An account whose id is the start of another's does not match it ("acct-" is not "acct-1").
    expect(change.touches("acct-")).toBe(false);
    expect(change.touches("acct")).toBe(false);
  });

  test("a marker another page removes is reported the same way", () => {
    const { theirs, heard } = twoPages();
    theirs.set(scopeOf("acct-1"), OP);
    theirs.clear(scopeOf("acct-1"), OP);
    expect(heard).toHaveLength(2);
    expect(heard[1]?.touches("acct-1", OP)).toBe(true);
  });

  test("clearing an account's markers reports each marker it removes", () => {
    const { theirs, heard } = twoPages();
    theirs.set(scopeOf("acct-1"), OP);
    theirs.set(scopeOf("acct-1"), "page:cursor-0");
    heard.length = 0;
    theirs.clearAccount("acct-1");
    expect(heard).toHaveLength(2);
    expect(heard.map((change) => change.touches("acct-1", OP))).toEqual([
      true,
      false,
    ]);
  });

  test("a cleared storage may have taken any marker with it: the change touches everything", () => {
    const { other, heard } = twoPages();
    other.clear();
    expect(heard).toHaveLength(1);
    expect(heard[0]?.touches("acct-1", OP)).toBe(true);
    expect(heard[0]?.touches("anything")).toBe(true);
  });

  test("a key that is not a marker (another use of the origin's storage) is not reported", () => {
    const { other, heard } = twoPages();
    other.storage.setItem("atlas-theme", "dark");
    other.storage.removeItem("atlas-theme");
    other.storage.setItem(`${MARKER_PREFIX.slice(0, -1)}`, "1");
    expect(heard).toEqual([]);
  });

  test("a directory is not reported: a failure's own key is the truth and is written after it (R55)", () => {
    const { other, heard } = twoPages();
    plantMarker(other.storage, scopeOf("acct-1"), OP, "tab.1");
    // The directory write says nothing a failure's key does not: one report, for the key.
    expect(heard).toHaveLength(1);
    expect(heard[0]?.touches("acct-1", OP)).toBe(true);
  });

  test("this page's own writes are not reported to it, as the browser does not report them", () => {
    const { mine, heard } = twoPages();
    mine.set(scopeOf("acct-1"), OP);
    mine.clear(scopeOf("acct-1"), OP);
    expect(heard).toEqual([]);
  });

  test("nothing is reported when nothing changed (a marker that was not there removed)", () => {
    const { theirs, heard } = twoPages();
    theirs.set(scopeOf("acct-1"), OP);
    heard.length = 0;
    theirs.clear(scopeOf("acct-2"), OP);
    expect(heard).toEqual([]);
  });

  // ADAPTED, revision 31 (separately labelled; the original asserted that `set` of the same marker again reports nothing). A failure
  // recorded again is a NEW instance with a new name, so it IS a change and is reported: a page that is told learns that a stop is
  // newer than any write it issued before, which the fixed value `1` could not say. What stays true is the browser's own rule, that
  // writing the very same value says nothing, which the double models.
  // ADAPTED again, revision 32 (R52): a failure recorded again is a new KEY (and the page's own older key is removed once it is stored), so
  // the other page hears the new key and the removal of the old: two reports, each naming the operation. Writing the very same value
  // under a key that stands still says nothing.
  test("a failure recorded again is a new instance and is reported; writing the very same value says nothing", () => {
    const { theirs, heard, storage } = twoPages();
    theirs.set(scopeOf("acct-1"), OP);
    expect(heard).toHaveLength(1);
    const [key] = markerKeys(storage, "acct-1", OP) as [string];
    heard.length = 0;
    theirs.set(scopeOf("acct-1"), OP);
    // The new instance's write and the removal of the replaced one.
    expect(heard).toHaveLength(2);
    expect(heard.every((change) => change.touches("acct-1", OP))).toBe(true);
    heard.length = 0;
    const [current] = markerKeys(storage, "acct-1", OP) as [string];
    expect(current).not.toBe(key);
    storage.page("same").storage.setItem(current, "1");
    expect(heard).toEqual([]);
  });

  test("a marker that could not be written is not reported (nothing changed): the writer is told, and holds the stop in memory", () => {
    const { storage, theirs, heard } = twoPages();
    storage.failWrites = true;
    expect(theirs.set(scopeOf("acct-1"), OP).state).toBe("unavailable");
    expect(heard).toEqual([]);
  });

  test("a change carries no value: what a marker says is what `has` and `operations` read when the listener asks", () => {
    const { mine, theirs, heard } = twoPages();
    theirs.set(scopeOf("acct-1"), OP);
    expect(Object.keys(heard[0] ?? {})).toEqual(["touches"]);
    expect(mine.has(scopeOf("acct-1"), OP)).toBe(true);
    theirs.clear(scopeOf("acct-1"), OP);
    expect(mine.has(scopeOf("acct-1"), OP)).toBe(false);
  });

  test("events held back (a page that hears late) arrive in order when released, and the marker is already there to read", () => {
    const { storage, mine, theirs, heard } = twoPages();
    storage.hold();
    theirs.set(scopeOf("acct-1"), OP);
    theirs.clear(scopeOf("acct-1"), OP);
    theirs.set(scopeOf("acct-1"), OP);
    expect(heard).toEqual([]);
    expect(mine.has(scopeOf("acct-1"), OP)).toBe(true);
    storage.release();
    expect(heard).toHaveLength(3);
  });

  test("a listener that unsubscribes hears nothing more, and leaves no feed behind", () => {
    const { storage, theirs, heard, off } = twoPages();
    expect(storage.listening).toBeGreaterThan(0);
    const before = storage.listening;
    off();
    expect(storage.listening).toBe(before - 1);
    theirs.set(scopeOf("acct-1"), OP);
    expect(heard).toEqual([]);
  });

  test("a storage with no feed (a caller's own, or no window) never reports, and unsubscribing it is harmless", () => {
    const storage = new FakeMarkerStorage();
    const markers = pageMarkers(storage, { events: false });
    const heard: MarkerChange[] = [];
    const off = markers.subscribe((change) => heard.push(change));
    storage.page("another-tab").storage.setItem(`${MARKER_PREFIX}a:${OP}`, "1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `${MARKER_PREFIX}a:${OP}`,
        storageArea: window.localStorage,
      }),
    );
    expect(heard).toEqual([]);
    expect(() => off()).not.toThrow();
  });
});

describe("the default feed: the window's `storage` event for the page's own localStorage", () => {
  const key = markerKey(scopeOf("acct-1"), OP, "other.1");
  const fire = (init: StorageEventInit) =>
    window.dispatchEvent(new StorageEvent("storage", init));

  test("an event for the page's localStorage and a marker key is reported", () => {
    const markers = createWriteFailureMarkers(undefined, undefined, {
      ownSlot: 0,
    });
    const heard: MarkerChange[] = [];
    const off = markers.subscribe((change) => heard.push(change));
    fire({ key, storageArea: window.localStorage });
    expect(heard).toHaveLength(1);
    expect(heard[0]?.touches("acct-1", OP)).toBe(true);
    expect(heard[0]?.touches("acct-2", OP)).toBe(false);
    off();
  });

  test("an event for another storage area (sessionStorage), or for another key, is not", () => {
    const markers = createWriteFailureMarkers(undefined, undefined, {
      ownSlot: 0,
    });
    const heard: MarkerChange[] = [];
    const off = markers.subscribe((change) => heard.push(change));
    fire({ key, storageArea: window.sessionStorage });
    fire({ key: "atlas-theme", storageArea: window.localStorage });
    expect(heard).toEqual([]);
    off();
  });

  test("a cleared storage (a null key) is reported and touches everything", () => {
    const markers = createWriteFailureMarkers(undefined, undefined, {
      ownSlot: 0,
    });
    const heard: MarkerChange[] = [];
    const off = markers.subscribe((change) => heard.push(change));
    fire({ key: null, storageArea: window.localStorage });
    expect(heard).toHaveLength(1);
    expect(heard[0]?.touches("acct-9", "page:x")).toBe(true);
    off();
  });

  test("after unsubscribing the window's listener is gone", () => {
    const markers = createWriteFailureMarkers(undefined, undefined, {
      ownSlot: 0,
    });
    const heard: MarkerChange[] = [];
    const off = markers.subscribe((change) => heard.push(change));
    off();
    fire({ key, storageArea: window.localStorage });
    expect(heard).toEqual([]);
  });

  test("the markers themselves still read and write the real localStorage", () => {
    const markers = createWriteFailureMarkers(undefined, undefined, {
      ownSlot: 0,
    });
    expect(markers.set(scopeOf("acct-1"), OP).state).toBe("recorded");
    // ADAPTED, revision 32: the failure's name is in the key, and the value is the fixed `1`.
    const stored = Object.keys(window.localStorage).filter((name) =>
      name.startsWith(`${markerKey(scopeOf("acct-1"), OP, "")}`),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/#[a-z0-9-]+\.\d+$/);
    expect(window.localStorage.getItem(stored[0] as string)).toBe("1");
    expect(markers.has(scopeOf("acct-1"), OP)).toBe(true);
    expect(markers.operations(scopeOf("acct-1"))).toEqual([OP]);
    markers.clear(scopeOf("acct-1"), OP);
    expect(markers.has(scopeOf("acct-1"), OP)).toBe(false);
  });
});

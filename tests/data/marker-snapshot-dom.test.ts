// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  markerKey,
  snapshotKeys,
} from "../../src/data/engine/write-failure-marker";
import { scopeOf } from "../support/data/marker-storage";

/**
 * R55 (revision 35): the browser's own `Storage` is listed by ONE operation, `Object.keys(localStorage)` (the HTML standard: a
 * Storage object's supported property names are "the result of running get the keys on storage's map"), and never by index.
 *
 * jsdom's `localStorage` is a real `Storage` (an instance of the global `Storage`, with named properties), so these cases pin the path
 * the production page takes: the markers obtain the global store, recognise it as a `Storage` before looking for a `keys` member (a key
 * the origin stored under the name `keys` would otherwise be read as one), never call `Storage.prototype.key`, and read the size only as
 * the work bound, so a size that cannot be read is an incomplete read. FIXTURE evidence: jsdom's implementation, not an installed
 * browser; E-O13 D9 is the native counterpart.
 */
const OP = "draft:a";
const scope = scopeOf("acct-dom");

const restore: Array<() => void> = [];
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  localStorage.clear();
});

/** Replaces a member of `Storage.prototype` for the test, and puts it back afterwards. */
function patchPrototype(
  name: "key" | "length",
  value: PropertyDescriptor,
): void {
  const proto = Storage.prototype as unknown as Record<string, unknown>;
  const before = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { configurable: true, ...value });
  restore.push(() => {
    if (before) Object.defineProperty(proto, name, before);
  });
}

describe("the real Storage is listed by Object.keys, in one operation", () => {
  test("the store is a Storage, and its snapshot is the list of its keys", () => {
    expect(localStorage).toBeInstanceOf(Storage);
    localStorage.setItem("one", "1");
    localStorage.setItem("two", "2");
    expect([...(snapshotKeys(localStorage) ?? [])].sort()).toEqual([
      "one",
      "two",
    ]);
  });

  test("a failure recorded through the global store is found by a cold page, and `Storage.prototype.key` is never called", () => {
    const writer = createWriteFailureMarkers(undefined, undefined, {
      id: () => "writer",
      locks: null,
    });
    expect(writer.set(scope, OP).state).toBe("recorded");
    expect(localStorage.getItem(markerKey(scope, OP, "writer.1"))).toBe("1");
    let indexed = 0;
    patchPrototype("key", {
      value() {
        indexed += 1;
        throw new Error(
          "Storage.key was called: a read walked the keys by index",
        );
      },
      writable: true,
    });
    const reader = createWriteFailureMarkers(undefined, undefined, {
      id: () => "reader",
      locks: null,
    });
    expect(reader.probe(scope, OP)).toBe("marked");
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: true });
    expect(reader.probe(scope, "draft:other")).toBe("unmarked");
    expect(indexed).toBe(0);
  });

  test("a key the origin stored under the name `keys` does not stop the store from being listed", () => {
    localStorage.setItem("keys", "not a function");
    const writer = createWriteFailureMarkers(undefined, undefined, {
      id: () => "writer",
      locks: null,
    });
    writer.set(scope, OP);
    expect(typeof (localStorage as unknown as { keys: unknown }).keys).toBe(
      "string",
    );
    const reader = createWriteFailureMarkers(undefined, undefined, {
      id: () => "reader",
      locks: null,
    });
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: true });
  });

  test("a size that cannot be read makes the read incomplete (the work bound comes first); restored, the read is whole without an event", () => {
    const writer = createWriteFailureMarkers(undefined, undefined, {
      id: () => "writer",
      locks: null,
    });
    writer.set(scope, OP);
    const size = Object.getOwnPropertyDescriptor(Storage.prototype, "length")
      ?.get as () => number;
    expect(size).toBeTypeOf("function");
    let refuse = true;
    patchPrototype("length", {
      get(this: Storage) {
        if (refuse) throw new DOMException("read refused", "SecurityError");
        return size.call(this);
      },
    });
    const reader = createWriteFailureMarkers(undefined, undefined, {
      id: () => "reader",
      locks: null,
    });
    expect(reader.probe(scope, "draft:other")).toBe("unknown");
    expect(reader.inspect(scope)).toEqual({ operations: [], known: false });
    refuse = false;
    expect(reader.inspect(scope)).toEqual({ operations: [OP], known: true });
  });
});

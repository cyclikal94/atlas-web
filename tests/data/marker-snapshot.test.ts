// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  directoryKey,
  LISTING_MAX_KEYS,
  type MarkerStorage,
  markerKey,
  parseMarkerKey,
  type StopScope,
  snapshotKeys,
  type WriteFailureMarkers,
} from "../../src/data/engine/write-failure-marker";
import { invalidateOperation } from "../../src/data/model/retry";
import {
  type ControllerProbe,
  controllerProbe,
} from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import { FakeMarkerStorage, scopeOf } from "../support/data/marker-storage";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R55 (revision 35): the AUTHORITY of a read of the markers is ONE snapshot of the origin's keys (header of the module, obligation 2).
 *
 * The review of revision 34 published a failure with no directory slot (the interval before a slot arrives, or every slot held), then
 * read it cold through a view of the storage whose keys are SORTED (one permitted implementation-defined order) while a peer removed
 * and added two UNRELATED keys between indexed reads, restoring them at each walk's end. The failure was never removed, re-added or
 * hidden, and `getItem` of it always answered `1`, yet both walks of revision 34 omitted it in the same way: `probe` said `unmarked`,
 * `witness` `none`, `inspect` `{ operations: [], known: true }`; through the production facade a reload under that churn lost the
 * warning and SENT the original draft over a failed edit, and a cold controller follower showed the cache.
 *
 * These cases replay that exact schedule against the new authority, with the same churn acting wherever an interleaving can act (between
 * any two operations of the page, and between any two `key(i)`, which the read no longer makes), and assert the protection the review
 * asked for, against paired controls on the same plumbing: a quiet view, a directory-backed failure, a healthy scope that must still be
 * known to be clear, and the public callers' healthy outcomes. A reference set of failure keys read from the raw items (not through any
 * production read) is the oracle.
 *
 * FIXTURE evidence: doubles of `localStorage`, of IndexedDB and of the network. The real `Storage` path (`Object.keys`) is pinned in
 * `marker-snapshot-dom.test.ts`; the native counterpart in three installed engines is E-O13 D9.
 */
const ACCOUNT = "acct-1";
const OP = "draft:a";
const BEFORE = "a:unrelated";
const AFTER = "z:unrelated";
const REPLACEMENT = "zz:unrelated";

/** The failure keys of a scope, read from the raw items: the oracle, independent of every production read. */
const rawFailures = (raw: FakeMarkerStorage, scope: StopScope): string[] =>
  [...raw.items.keys()]
    .filter((key) => {
      const parsed = parseMarkerKey(key);
      return (
        parsed !== null &&
        parsed.account === scope.account &&
        parsed.incarnationId === scope.incarnationId
      );
    })
    .sort();

/**
 * The review's view of `raw`: keys SORTED, and (when `churn`) a peer that removes `BEFORE` and adds `REPLACEMENT` after index 0 is
 * read and restores them after the last index, so that a walk's length is the same at both ends. Revision 35 adds what a real `Storage`
 * has: ONE operation that answers every key (`keys`, the standard's "get the keys"), and the same churn acts just before it and before
 * every read of a value, alternating the two arrangements, so that it is engaged on every path the read takes. `calls` records them.
 */
function view(raw: FakeMarkerStorage, churn: boolean) {
  raw.items.set(BEFORE, "1");
  raw.items.set(AFTER, "1");
  const calls = { key: 0, keys: 0, get: 0, churned: 0 };
  let shifted = false;
  const shift = () => {
    if (!churn) return;
    calls.churned += 1;
    if (shifted) {
      raw.items.delete(REPLACEMENT);
      raw.items.set(BEFORE, "1");
    } else {
      raw.items.delete(BEFORE);
      raw.items.set(REPLACEMENT, "1");
    }
    shifted = !shifted;
  };
  const sorted = () => [...raw.items.keys()].sort();
  const storage: MarkerStorage = {
    get length() {
      return raw.items.size;
    },
    key(index) {
      calls.key += 1;
      const keys = sorted();
      const result = keys[index] ?? null;
      if (churn && index === 0) {
        raw.items.delete(BEFORE);
        raw.items.set(REPLACEMENT, "1");
      }
      if (churn && index === keys.length - 1) {
        raw.items.delete(REPLACEMENT);
        raw.items.set(BEFORE, "1");
      }
      return result;
    },
    keys() {
      shift();
      calls.keys += 1;
      return sorted();
    },
    getItem(key) {
      shift();
      calls.get += 1;
      return raw.getItem(key);
    },
    setItem: (key, value) => raw.setItem(key, value),
    removeItem: (key) => raw.removeItem(key),
  };
  return { storage, calls };
}

/** A page that will never hold a directory slot (every slot held elsewhere, or the interval before one arrives). */
const noSlot = (storage: MarkerStorage, id: string): WriteFailureMarkers =>
  createWriteFailureMarkers(storage, undefined, {
    id: () => id,
    locks: { tryAcquire: async () => null },
  });

/** The review's publication: the production publisher with no slot; `listed` adds a directory entry as another page would. */
function publish(
  raw: FakeMarkerStorage,
  scope: StopScope,
  listed: boolean,
): string {
  const writer = noSlot(raw, "writer");
  expect(writer.set(scope, OP).state).toBe("recorded");
  writer.release();
  const key = markerKey(scope, OP, "writer.1");
  expect(raw.getItem(key)).toBe("1");
  if (listed)
    raw.setItem(
      directoryKey(scope, 0),
      JSON.stringify({ v: 1, e: [[OP, "writer.1"]] }),
    );
  return key;
}

type Call = "probe" | "witness" | "inspect" | "has" | "operations";
const CALLS: Call[] = ["probe", "witness", "inspect", "has", "operations"];

function ask(markers: WriteFailureMarkers, call: Call, scope: StopScope) {
  switch (call) {
    case "probe":
      return markers.probe(scope, OP);
    case "witness":
      return markers.witness(scope, OP);
    case "inspect":
      return markers.inspect(scope);
    case "has":
      return markers.has(scope, OP);
    case "operations":
      return markers.operations(scope);
  }
}

/** The answer that PROTECTS the standing failure, exactly (not merely "not absent"): the snapshot finds it and the read is whole. */
const PROTECTED: Record<Call, unknown> = {
  probe: "marked",
  witness: { kind: "instance", instances: ["writer.1"] },
  inspect: { operations: [OP], known: true },
  has: true,
  operations: [OP],
};
/** The answer of a scope that is clear and was read whole: the healthy control (a protection that never clears is no protection). */
const CLEAR: Record<Call, unknown> = {
  probe: "unmarked",
  witness: { kind: "none" },
  inspect: { operations: [], known: true },
  has: false,
  operations: [],
};

describe("the review's discovery schedule: a standing failure with no directory entry is found by the snapshot (R55, revision 35)", () => {
  for (const mode of ["churn", "quiet", "directory"] as const)
    for (const reader of ["cold", "informed"] as const)
      for (const call of CALLS)
        test(`${call}, ${reader} reader, ${mode}: the failure is found and the read is whole`, () => {
          const raw = new FakeMarkerStorage();
          const scope = scopeOf(ACCOUNT);
          const key = publish(raw, scope, mode === "directory");
          const v = view(raw, mode !== "quiet");
          const markers = noSlot(v.storage, "reader");
          if (reader === "informed")
            expect(markers.probe(scope, OP)).toBe("marked");
          expect(ask(markers, call, scope)).toEqual(PROTECTED[call]);
          // The oracle: the failure stood throughout and was never touched.
          expect(raw.getItem(key)).toBe("1");
          expect(rawFailures(raw, scope)).toEqual([key]);
          // The read took the snapshot and never walked by index; under churn, the interleaving engaged.
          expect(v.calls.keys).toBeGreaterThan(0);
          expect(v.calls.key).toBe(0);
          if (mode !== "quiet") expect(v.calls.churned).toBeGreaterThan(0);
          markers.release();
        });

  for (const reader of ["cold", "informed"] as const)
    for (const call of CALLS)
      test(`control: a clear scope under the same churn, ${reader} reader, ${call}: known to be clear`, () => {
        const raw = new FakeMarkerStorage();
        const scope = scopeOf(ACCOUNT);
        // Another scope's failure stands (another account), and none of this one's.
        publish(raw, scopeOf("acct-2"), false);
        const v = view(raw, true);
        const markers = noSlot(v.storage, "reader");
        if (reader === "informed")
          expect(markers.probe(scope, OP)).toBe("unmarked");
        expect(ask(markers, call, scope)).toEqual(CLEAR[call]);
        expect(v.calls.churned).toBeGreaterThan(0);
      });

  test("control: once the failure is retired by its exact key, every reader regains known absence under the same churn", () => {
    const raw = new FakeMarkerStorage();
    const scope = scopeOf(ACCOUNT);
    publish(raw, scope, false);
    const v = view(raw, true);
    const markers = noSlot(v.storage, "reader");
    const seen = markers.witness(scope, OP);
    expect(seen).toEqual({ kind: "instance", instances: ["writer.1"] });
    expect(markers.retire(scope, OP, seen)).toBe(true);
    expect(rawFailures(raw, scope)).toEqual([]);
    for (const call of CALLS)
      expect(ask(markers, call, scope)).toEqual(CLEAR[call]);
    const cold = noSlot(v.storage, "cold");
    for (const call of CALLS)
      expect(ask(cold, call, scope)).toEqual(CLEAR[call]);
  });

  test("a newer failure recorded by another page while the first is witnessed survives the first's retirement (exact identity kept)", () => {
    const raw = new FakeMarkerStorage();
    const scope = scopeOf(ACCOUNT);
    publish(raw, scope, false);
    const v = view(raw, true);
    const markers = noSlot(v.storage, "reader");
    const seen = markers.witness(scope, OP);
    const later = noSlot(raw, "later");
    expect(later.set(scope, OP).state).toBe("recorded");
    expect(markers.retire(scope, OP, seen)).toBe(true);
    expect(markers.witness(scope, OP)).toEqual({
      kind: "instance",
      instances: ["later.1"],
    });
    expect(noSlot(v.storage, "cold").probe(scope, OP)).toBe("marked");
  });
});

describe("a read that cannot take the snapshot is incomplete: what is named stands, nothing else is known to be absent", () => {
  const withoutSnapshot = (raw: FakeMarkerStorage): MarkerStorage => ({
    get length() {
      return raw.length;
    },
    key: (index) => raw.key(index),
    getItem: (key) => raw.getItem(key),
    setItem: (key, value) => raw.setItem(key, value),
    removeItem: (key) => raw.removeItem(key),
  });

  test("a store with no single-operation listing: a failure no directory names is unknown, never absent (cold); one a directory names is found", () => {
    const raw = new FakeMarkerStorage();
    const scope = scopeOf(ACCOUNT);
    publish(raw, scope, false);
    const cold = noSlot(withoutSnapshot(raw), "cold");
    expect(cold.probe(scope, OP)).toBe("unknown");
    expect(cold.witness(scope, OP)).toEqual({ kind: "unread" });
    expect(cold.inspect(scope)).toEqual({ operations: [], known: false });
    raw.setItem(
      directoryKey(scope, 3),
      JSON.stringify({ v: 1, e: [[OP, "writer.1"]] }),
    );
    expect(noSlot(withoutSnapshot(raw), "cold-2").probe(scope, OP)).toBe(
      "marked",
    );
    expect(noSlot(withoutSnapshot(raw), "cold-3").inspect(scope)).toEqual({
      operations: [OP],
      known: false,
    });
  });

  for (const fault of ["size", "keys"] as const)
    test(`a snapshot whose ${fault === "size" ? "size read" : "list of keys"} is refused: unknown for what is not named, and a healthy read without an event once it works again`, () => {
      const raw = new FakeMarkerStorage();
      const scope = scopeOf(ACCOUNT);
      publish(raw, scope, false);
      let refuse = true;
      const storage: MarkerStorage = {
        get length() {
          if (refuse && fault === "size")
            throw new DOMException("refused", "SecurityError");
          return raw.length;
        },
        key: (index) => raw.key(index),
        keys: () => {
          if (refuse && fault === "keys")
            throw new DOMException("refused", "SecurityError");
          return raw.keys();
        },
        getItem: (key) => raw.getItem(key),
        setItem: (key, value) => raw.setItem(key, value),
        removeItem: (key) => raw.removeItem(key),
      };
      const markers = noSlot(storage, "reader");
      expect(markers.probe(scope, OP)).toBe("unknown");
      expect(markers.inspect(scope)).toEqual({ operations: [], known: false });
      refuse = false;
      expect(markers.probe(scope, OP)).toBe("marked");
      expect(markers.inspect(scope)).toEqual({ operations: [OP], known: true });
    });

  test("bounded work: a size or a list over `LISTING_MAX_KEYS` is unknown (never a partial answer); at the bound it is read", () => {
    const raw = new FakeMarkerStorage();
    const scope = scopeOf(ACCOUNT);
    publish(raw, scope, false);
    for (let n = raw.items.size; n < LISTING_MAX_KEYS; n += 1)
      raw.items.set(`unrelated-${n}`, "1");
    expect(raw.items.size).toBe(LISTING_MAX_KEYS);
    expect(snapshotKeys(raw)).toHaveLength(LISTING_MAX_KEYS);
    expect(noSlot(raw, "at-bound").inspect(scope)).toEqual({
      operations: [OP],
      known: true,
    });
    raw.items.set("one-more", "1");
    // The size is the bound and it is read FIRST: an origin over it is never materialised (no snapshot is taken).
    const before = raw.snapshots;
    expect(snapshotKeys(raw)).toBeNull();
    expect(raw.snapshots).toBe(before);
    expect(noSlot(raw, "over-bound").probe(scope, "draft:other")).toBe(
      "unknown",
    );
    // A list longer than the size said (the size is only the bound): over the bound is refused as well.
    raw.items.delete("one-more");
    const lying: MarkerStorage = {
      get length() {
        return 1;
      },
      key: () => null,
      keys: () => [...raw.items.keys(), "extra"],
      getItem: (key) => raw.getItem(key),
      setItem: (key, value) => raw.setItem(key, value),
      removeItem: (key) => raw.removeItem(key),
    };
    expect(snapshotKeys(lying)).toBeNull();
  });
});

describe("an established failure is read again by name: a snapshot that omits it is contradicted, never believed (obligation 2 (c))", () => {
  test("an informed reader whose snapshot leaves out a key it established, while the key stands: marked, and the read is incomplete", () => {
    const raw = new FakeMarkerStorage();
    const scope = scopeOf(ACCOUNT);
    const key = publish(raw, scope, false);
    let omit = false;
    const storage: MarkerStorage = {
      get length() {
        return raw.length;
      },
      key: (index) => raw.key(index),
      keys: () => raw.keys().filter((name) => !(omit && name === key)),
      getItem: (name) => raw.getItem(name),
      setItem: (name, value) => raw.setItem(name, value),
      removeItem: (name) => raw.removeItem(name),
    };
    const markers = noSlot(storage, "reader");
    expect(markers.probe(scope, OP)).toBe("marked");
    omit = true;
    expect(markers.probe(scope, OP)).toBe("marked");
    expect(markers.witness(scope, OP)).toEqual({
      kind: "instance",
      instances: ["writer.1"],
    });
    expect(markers.inspect(scope)).toEqual({ operations: [OP], known: false });
    expect(markers.probe(scope, "draft:other")).toBe("unknown");
    // Nothing was forgotten: when the snapshot lists it again, the read is whole.
    omit = false;
    expect(markers.inspect(scope)).toEqual({ operations: [OP], known: true });
    // Control: the key really ended (another page retired it): the informed reader learns the absence, whole.
    raw.removeItem(key);
    expect(markers.inspect(scope)).toEqual({ operations: [], known: true });
    expect(markers.probe(scope, OP)).toBe("unmarked");
  });
});

/**
 * The public callers, as the review drove them (Q7, Q8 of the design assessment): the production outbox facade and dispatcher over a
 * reload under the churn, and the production controller as a cold follower. Each protection case has a healthy control on the same
 * plumbing that must make progress, so a design that is merely always-unknown would fail it.
 */
const request = (label: string) => ({
  localId: "a",
  endpoint: "/commands" as const,
  targets: [
    {
      resourceId: "r-a",
      role: "primary" as const,
      basis: "resource" as const,
      versionChecked: true,
    },
  ],
  build: (bases: Record<string, number>) => ({
    command: {
      kind: "edit",
      id: "r-a",
      label,
      expected_version: bases["r-a"] ?? 0,
    },
  }),
});

describe("the public callers under the review's churn (R55, revision 35)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  for (const churn of [true, false])
    test(`outbox, ${churn ? "churn" : "quiet"}: a failed edit whose counter also failed stays warned after a reload, and the original draft is NOT sent`, async () => {
      const w = await outboxWorld();
      cleanups.push(() => {
        w.dispatcher.stop();
        w.service.dispose("closed");
        w.markers.release();
      });
      w.online = false;
      w.put("cache", [cacheRow({ id: "r-a", version: 5 })]);
      expect((await w.outbox.enqueue(request("original"))).kind).toBe("queued");
      await w.settle();
      const writer = noSlot(w.markerStorage, "writer");
      w.reload({ markers: writer });
      await w.settle();
      for (const label of [
        "data.editQueuedDraft",
        "data.recordLocalWriteOutcome",
      ])
        w.env.idb.inject({
          match: (tx) => tx.label === label,
          mode: "error",
          times: 1,
        });
      expect((await w.outbox.editQueued("a", request("unsaved"))).kind).toBe(
        "refused",
      );
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      writer.release();
      const key = markerKey(w.service, "draft:a", "writer.1");
      expect(w.markerStorage.getItem(key)).toBe("1");
      const v = view(w.markerStorage, churn);
      w.reload({ markers: noSlot(v.storage, "reader") });
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(1000);
      expect(w.sent).toHaveLength(0);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(w.markerStorage.getItem(key)).toBe("1");
      expect(v.calls.key).toBe(0);
      if (churn) expect(v.calls.churned).toBeGreaterThan(0);
    });

  for (const churn of [true, false])
    test(`outbox control, ${churn ? "churn" : "quiet"}: with no failure recorded, the same reload sends the draft exactly once, with its body`, async () => {
      const w = await outboxWorld();
      cleanups.push(() => {
        w.dispatcher.stop();
        w.service.dispose("closed");
        w.markers.release();
      });
      w.online = false;
      w.put("cache", [cacheRow({ id: "r-a", version: 5 })]);
      expect((await w.outbox.enqueue(request("original"))).kind).toBe("queued");
      await w.settle();
      const v = view(w.markerStorage, churn);
      w.reload({ markers: noSlot(v.storage, "reader") });
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(1000);
      expect(w.sent).toHaveLength(1);
      expect(JSON.stringify(w.sent[0])).toContain("original");
      expect(v.calls.key).toBe(0);
    });

  for (const churn of [true, false])
    for (const marked of [true, false])
      test(`controller, cold follower, ${churn ? "churn" : "quiet"}: ${marked ? "a standing invalidation keeps the cache hidden" : "control: no invalidation, the gate is not held by one"}`, async () => {
        const w = await engineWorld();
        let ui: ControllerProbe | undefined;
        cleanups.push(() => {
          ui?.dispose();
          w.engine.stop();
          w.service.dispose("closed");
        });
        const op = invalidateOperation("cursor-0");
        let key: string | null = null;
        if (marked) {
          const writer = noSlot(w.markerStorage, "writer");
          expect(writer.set(w.service, op).state).toBe("recorded");
          writer.release();
          key = markerKey(w.service, op, "writer.1");
        }
        const v = view(w.markerStorage, churn);
        const markers = noSlot(v.storage, "reader");
        ui = await controllerProbe(w, { leader: false, markers });
        if (marked) {
          expect(ui.gate()).not.toBe("open");
          expect(markers.probe(w.service, op)).toBe("marked");
          expect(w.markerStorage.getItem(key as string)).toBe("1");
        } else expect(markers.probe(w.service, op)).toBe("unmarked");
        expect(v.calls.key).toBe(0);
        if (churn) expect(v.calls.churned).toBeGreaterThan(0);
      });
});

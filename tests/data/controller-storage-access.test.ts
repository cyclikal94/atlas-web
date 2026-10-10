// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import { createWriteFailureMarkers } from "../../src/data/engine/write-failure-marker";
import { invalidateOperation } from "../../src/data/model/retry";
import { controllerProbe } from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import {
  type GlobalStorage,
  markerStands,
  pageMarkers,
  scopeOf,
  setGlobalStorage,
  withGlobalStorage,
} from "../support/data/marker-storage";
import { cacheRow } from "../support/data/rows";

/**
 * R47(a) (revision 29): a storage getter that throws is not a store with nothing in it, for the gate either.
 *
 * Seeded with the state the previous review showed reachable by an admitted 410 whose invalidation write failed: a retained cache and
 * cursor, a facts record that still says `valid`, and the invalidation's marker (`invalidate:<cursor>`) or its durable counter. A fresh
 * controller whose markers were built while `localStorage` threw used to read an empty store (the module captured `undefined` once),
 * accept the facts, and open the gate over a cache the server had said was invalid, in every engine. The markers now keep a refusal as
 * `unknown`: the cache is `unverified` and hidden until a read lands, access restored later finds the marker (the controller asks again
 * on a pace: nothing notifies it), and a marker or counter that can be read hides it as before.
 *
 * FIXTURE evidence: the production controller, engine, plans and store over the double of IndexedDB, behind a global `localStorage` whose
 * getter throws on demand; no native rendering is claimed. The native probe over real IndexedDB and `localStorage` is E-C8.
 */
const OP = invalidateOperation("cursor-0");
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

async function seeded(how: "marker" | "counter" | "none") {
  const w = await engineWorld({ cursor: "cursor-0" });
  w.put("cache", [cacheRow({ id: "private", value: { name: "retained" } })]);
  const earlier = await controllerProbe(w, { leader: false });
  expect(earlier.gate()).toBe("open");
  earlier.dispose();
  if (how === "counter") w.setSync({ local_write_streaks: { [OP]: 1 } });
  if (how === "marker") w.markers.set(scopeOf(w.service.account), OP);
  expect(markerStands(w.markerStorage, w.service.account, OP)).toBe(
    how === "marker",
  );
  return w;
}

/** A fresh page: markers built under `behaviour`, then the global left as `after` says. */
function page(
  behaviour: GlobalStorage,
  after: "restored" | "kept" | GlobalStorage,
) {
  const markers = withGlobalStorage(behaviour, () =>
    createWriteFailureMarkers(),
  );
  if (after === "kept") restores.push(setGlobalStorage(behaviour));
  else if (after !== "restored") restores.push(setGlobalStorage(after));
  return markers;
}

describe("a cache the server said was invalid stays hidden when the storage getter threw", () => {
  for (const how of ["marker", "counter"] as const)
    for (const [label, after] of [
      ["and access was restored at once (the global is gone)", "restored"],
      ["and it still throws", "kept"],
    ] as const)
      test(`${how}: built while the getter threw, ${label}: not open`, async () => {
        const w = await seeded(how);
        const markers = page("throws", after);
        const probe = await controllerProbe(w, { leader: false, markers });
        probe.offline();
        await w.settle();
        expect(probe.gate()).not.toBe("open");
        expect(probe.ui.inputs.get().cache).toBe(
          how === "counter" ? "invalid" : "unverified",
        );
        // The record itself was never touched.
        expect(markerStands(w.markerStorage, w.service.account, OP)).toBe(
          how === "marker",
        );
        probe.dispose();
      });

  test("access restored later: the same controller finds the marker on its own pace and hides the cache as `invalid`, without any event", async () => {
    const w = await seeded("marker");
    const markers = page("throws", "kept");
    const probe = await controllerProbe(w, { leader: false, markers });
    expect(probe.ui.inputs.get().cache).toBe("unverified");
    restores.pop()?.();
    restores.push(setGlobalStorage(w.markerStorage));
    await w.advance(20_000);
    expect(probe.ui.inputs.get().cache).toBe("invalid");
    expect(probe.gate()).not.toBe("open");
    probe.dispose();
  });

  test("with NO marker anywhere, a store that cannot be obtained keeps the cache `unverified`, and a read that lands opens it, without any event", async () => {
    const w = await seeded("none");
    const markers = page("throws", "kept");
    const probe = await controllerProbe(w, { leader: false, markers });
    expect(probe.ui.inputs.get().cache).toBe("unverified");
    expect(probe.gate()).not.toBe("open");
    restores.pop()?.();
    restores.push(setGlobalStorage(w.markerStorage));
    await w.advance(20_000);
    expect(probe.ui.inputs.get().cache).toBe("valid");
    expect(probe.gate()).toBe("open");
    probe.dispose();
  });

  test("controls: the marker read through a store that is there hides the cache, and an environment with no `localStorage` at all has nothing to hide", async () => {
    const w = await seeded("marker");
    const read = await controllerProbe(w, {
      leader: false,
      markers: page(w.markerStorage, "restored"),
    });
    expect(read.ui.inputs.get().cache).toBe("invalid");
    read.dispose();
    const none = await seeded("none");
    const bare = await controllerProbe(none, {
      leader: false,
      markers: page("absent", "restored"),
    });
    expect(bare.gate()).toBe("open");
    bare.dispose();
  });
});

describe("the look at an unreadable marker is paced, bounded and ends with the controller", () => {
  test("a bounded number of reads over five minutes, and none after the controller is disposed", async () => {
    const w = await seeded("none");
    const markers = page("throws", "kept");
    let probes = 0;
    const probe = markers.probe.bind(markers);
    markers.probe = (account, operation) => {
      probes += 1;
      return probe(account, operation);
    };
    const follower = await controllerProbe(w, { leader: false, markers });
    await w.advance(300_000);
    expect(follower.ui.inputs.get().cache).toBe("unverified");
    expect(probes).toBeGreaterThan(1);
    // The facts' own pace: doubling from 250 ms to a ceiling of 10 s, and nothing proportional to anything else.
    expect(probes).toBeLessThan(60);
    follower.dispose();
    const after = probes;
    await w.advance(300_000);
    expect(probes).toBe(after);
  });

  test("the look is a timer of the controller's own and it ends with the controller: nothing is left pending after it is disposed, or once the marker can be read", async () => {
    const w = await seeded("none");
    const pending = new Set<unknown>();
    const setTimeout_ = w.timers.setTimeout.bind(w.timers);
    const clearTimeout_ = w.timers.clearTimeout.bind(w.timers);
    w.timers.setTimeout = (fn, ms) => {
      const handle: unknown = setTimeout_(() => {
        pending.delete(handle);
        fn();
      }, ms);
      pending.add(handle);
      return handle;
    };
    w.timers.clearTimeout = (handle) => {
      pending.delete(handle);
      clearTimeout_(handle);
    };
    const markers = page("throws", "kept");
    const follower = await controllerProbe(w, { leader: false, markers });
    expect(follower.ui.inputs.get().cache).toBe("unverified");
    expect(pending.size).toBeGreaterThan(0);
    // The marker can be read: the look that was waiting is cancelled at once, not left to fire.
    restores.pop()?.();
    restores.push(setGlobalStorage(w.markerStorage));
    await w.advance(20_000);
    expect(follower.ui.inputs.get().cache).toBe("valid");
    expect(pending.size).toBe(0);
    follower.dispose();
    // And a look that is waiting when a controller is disposed goes with it.
    restores.pop()?.();
    const blocked = page("throws", "kept");
    const second = await controllerProbe(w, {
      leader: false,
      markers: blocked,
    });
    expect(second.ui.inputs.get().cache).toBe("unverified");
    expect(pending.size).toBeGreaterThan(0);
    second.dispose();
    expect(pending.size).toBe(0);
  });

  test("a marker that can be read leaves nothing scheduled (the healthy path costs no look)", async () => {
    const w = await seeded("none");
    let probes = 0;
    const markers = pageMarkers(w.markerStorage, { events: false });
    const probe = markers.probe.bind(markers);
    markers.probe = (account, operation) => {
      probes += 1;
      return probe(account, operation);
    };
    const follower = await controllerProbe(w, { leader: false, markers });
    await w.settle();
    const settled = probes;
    await w.advance(300_000);
    expect(probes).toBe(settled);
    expect(follower.gate()).toBe("open");
    follower.dispose();
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
} from "../../src/data/engine/write-failure-marker";
import { invalidateOperation } from "../../src/data/model/retry";
import type { CacheState } from "../../src/data/model/status";
import { resetSizingFloor } from "../../src/data/plans/sync-writers";
import {
  type ControllerProbe,
  controllerProbe,
} from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import { pageMarkers, scopeOf } from "../support/data/marker-storage";
import { cacheRow, draftRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R47 and R10 (revision 28): an invalidation the server admitted stays hidden until its recovery is ESTABLISHED, and a marker that cannot
 * be read is not a marker that is absent.
 *
 * The seventh review reproduced it over the production controller: the leader receives `410 resync_required`, its invalidation
 * transaction fails, and either its failure counter cannot be written (the account's fallback marker records it) or the failure is a
 * quota failure (recorded in the marker at once). A follower reads the marker and hides the cache (`refreshing`); then the follower's
 * read of the marker fails and it goes offline, and its gate became `open` with the cache `valid`, although the marker and the retained
 * cache row remained and nothing had recovered: `markers.has` answered `false` for a read that threw, on every recomputation.
 *
 * The follower is its own PAGE over the world's `localStorage`, with its own markers object (what a second tab has). A marker it has
 * READ is established on that page, so a later failed read keeps the cache hidden; a marker it has never been able to read leaves the
 * cache `unverified`, exactly as a facts read that failed with no earlier read does (R13). FIXTURE evidence: the production controller,
 * engine, plans and store over the double of IndexedDB, a scripted network and a `localStorage` double whose reads throw; no native
 * rendering is claimed.
 */
const OP = invalidateOperation("cursor-0");

type Path = "counter" | "marker" | "quota";
const PATHS: readonly Path[] = ["counter", "marker", "quota"];
/** The paths whose only record, besides the engine's memory, is the fallback marker. */
const MARKER_PATHS: readonly Path[] = ["marker", "quota"];
/**
 * ADAPTED, revision 33 (R55): a marker is found by reading the directories' fixed addresses and the key of each failure they list; the
 * origin's keys are never listed. A read can fail for the directories (`directory`), for the listed failure's own key (`marker`: only
 * when one stands) or for every key (`getItem`).
 */
type Unreadable = "directory" | "marker" | "getItem";
const KINDS: readonly Unreadable[] = ["directory", "marker", "getItem"];

async function build() {
  const w = await engineWorld({ cursor: "cursor-0" });
  w.put("cache", [
    cacheRow({ id: uuid(9), value: { name: "retained private resource" } }),
  ]);
  w.put("drafts", [draftRow({ local_id: "kept", status: "queued" })]);
  return w;
}
type World = Awaited<ReturnType<typeof build>>;

const unreadable = (w: World, kind: Unreadable): void => {
  w.markerStorage.failGets = kind === "getItem";
  w.markerStorage.failGetsFor =
    kind === "directory"
      ? (key) => key.startsWith(DIRECTORY_PREFIX)
      : kind === "marker"
        ? (key) => key.startsWith(MARKER_PREFIX)
        : null;
};
const readable = (w: World): void => {
  w.markerStorage.failEnumeration = false;
  w.markerStorage.failGets = false;
  w.markerStorage.failGetsFor = null;
};

/** A write to the singleton re-evaluates a live read of it (the double pushes a commit to the watchers of the stores it touched). */
const nudge = (w: World, probe: ControllerProbe) => {
  const service = probe.ui.service() ?? w.service;
  return service.store.run(resetSizingFloor, {
    incarnationId: service.incarnationId,
  });
};

/** The failure of the leader's invalidation, recorded by `path`, with a leader and a follower that were open and `valid` before it. */
async function arrange(path: Path) {
  const w = await build();
  const leader = await controllerProbe(w, { leader: true });
  const follower = await controllerProbe(w, { leader: false });
  expect(follower.ui.inputs.get().cache).toBe("valid");
  expect(follower.gate()).toBe("open");
  w.env.idb.inject({
    match: (tx) => tx.label === "data.invalidateCache",
    mode: path === "quota" ? "quota" : "error",
    times: 100,
  });
  if (path === "marker")
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 100,
    });
  w.script.push(w.status(410, { body: { code: "resync_required" } }));
  w.start();
  await w.settle();
  return { w, leader, follower };
}

const finish = (w: World, ...probes: ControllerProbe[]) => {
  for (const probe of probes) probe.dispose();
  w.engine.stop();
};

function watchCache(probe: ControllerProbe): CacheState[] {
  const seen: CacheState[] = [];
  probe.ui.inputs.subscribe(() => {
    const cache = probe.ui.inputs.get().cache;
    if (seen.at(-1) !== cache) seen.push(cache);
  });
  return seen;
}

describe("a follower that has read the marker keeps the cache hidden while the marker cannot be read", () => {
  const events: Array<{
    name: string;
    run(w: World, follower: ControllerProbe): Promise<void> | void;
  }> = [
    { name: "going offline", run: (_w, follower) => follower.offline() },
    {
      name: "going offline and back online",
      run: (_w, follower) => {
        follower.offline();
        follower.online();
      },
    },
    {
      name: "an unrelated write that re-reads the facts",
      run: async (w, follower) => {
        await nudge(w, follower);
      },
    },
    {
      name: "a marker of an unrelated operation that another page writes",
      run: (w) => {
        const page = w.markerStorage.page("another-tab");
        pageMarkers(page).set(scopeOf(w.service.account), "page:cursor-0");
      },
    },
    {
      name: "ten simulated minutes",
      run: async (w) => {
        await w.advance(600_000);
      },
    },
  ];

  for (const path of MARKER_PATHS)
    for (const kind of KINDS)
      for (const event of events)
        test(`${path}, ${kind} unreadable: after ${event.name} the gate is not open, the cache is invalid, and the marker and the cached row remain`, async () => {
          const { w, leader, follower } = await arrange(path);
          const account = w.service.account;
          expect(follower.gate()).toBe("refreshing");
          expect(follower.ui.inputs.get().cache).toBe("invalid");
          unreadable(w, kind);
          const seen = watchCache(follower);
          await event.run(w, follower);
          await w.settle();
          expect(follower.gate()).not.toBe("open");
          expect(follower.ui.inputs.get().cache).toBe("invalid");
          expect(seen).not.toContain("valid");
          // Nothing recovered: the marker is still there, the database still says `valid` (the invalidation was never written), and
          // the retained row is still in the store.
          readable(w);
          expect(w.markers.operations(scopeOf(account))).toContain(OP);
          expect(w.sync().cache_status).toBe("valid");
          expect(w.rows("cache")).toHaveLength(1);
          finish(w, leader, follower);
        });

  for (const kind of KINDS)
    test(`counter, ${kind} unreadable: the durable count at the position hides it whatever the markers say (the control)`, async () => {
      const { w, leader, follower } = await arrange("counter");
      unreadable(w, kind);
      follower.offline();
      follower.online();
      await w.settle();
      expect(follower.gate()).toBe("refreshing");
      expect(follower.ui.inputs.get().cache).toBe("invalid");
      finish(w, leader, follower);
    });

  for (const path of PATHS)
    test(`${path}: the leader's own gate does not depend on the markers at all`, async () => {
      const { w, leader, follower } = await arrange(path);
      unreadable(w, "getItem");
      leader.offline();
      leader.online();
      await w.settle();
      expect(leader.gate()).toBe("refreshing");
      finish(w, leader, follower);
    });

  for (const kind of KINDS)
    test(`marker, ${kind} unreadable then readable again: the cache stays hidden because the marker is still there, and opens only once it is removed and a read lands`, async () => {
      const { w, leader, follower } = await arrange("marker");
      unreadable(w, kind);
      follower.offline();
      await w.settle();
      expect(follower.gate()).not.toBe("open");
      readable(w);
      follower.online();
      await w.settle();
      expect(follower.gate()).toBe("refreshing");
      expect(follower.ui.inputs.get().cache).toBe("invalid");
      // The leader's guarded invalidation is made some other way: the marker is removed by the page that wrote it, and the follower is
      // told by the storage event. What is shown follows a read that lands.
      const own = w.markerStorage.page("another-tab");
      pageMarkers(own).clear(scopeOf(w.service.account), OP);
      await w.settle();
      await nudge(w, follower);
      await w.settle();
      expect(follower.ui.inputs.get().cache).not.toBe("invalid");
      finish(w, leader, follower);
    });
});

describe("a marker this page has never been able to read leaves the cache unverified, not open", () => {
  for (const kind of KINDS)
    test(`${kind} unreadable from the start (a reload): a follower with a retained cache and a marker it cannot read hides the cache until a read lands, then shows what the marker says`, async () => {
      const { w, leader, follower } = await arrange("marker");
      follower.dispose();
      unreadable(w, kind);
      const reloaded = await controllerProbe(w, { leader: false });
      // The facts say `valid` and nothing durable names the invalidation. The gate asks for the ONE marker of the position. ADAPTED,
      // revision 33: whichever read cannot be made (the directories, the listed failure's own key, or every key), this page has never
      // seen the marker and the cache is not established until a read lands.
      // ADAPTED, revision 34: with only the DIRECTORIES unreadable the listing (the other witness) names the marker, so the page has
      // read it and the cache is `invalid`; the other two kinds cannot read it by either witness and stay `unverified`. Either way the
      // cache is hidden until a read lands, which is what the case protects.
      expect(reloaded.ui.inputs.get().cache).toBe(
        kind === "directory" ? "invalid" : "unverified",
      );
      expect(reloaded.gate()).toBe("refreshing");
      readable(w);
      reloaded.offline();
      reloaded.online();
      await w.settle();
      // The marker is still there: it is what the read that landed says.
      expect(reloaded.ui.inputs.get().cache).toBe("invalid");
      expect(reloaded.gate()).toBe("refreshing");
      finish(w, leader, reloaded);
    });

  for (const kind of KINDS)
    test(`${kind} unreadable from the start, and NO marker anywhere: unverified while unreadable (never open on a read that failed), open once a read lands (adapted, revision 29: one way of reading that fails falls back to the other)`, async () => {
      const w = await build();
      unreadable(w, kind);
      const follower = await controllerProbe(w, { leader: false });
      // ADAPTED, revision 33: with no marker anywhere only a read of the DIRECTORIES can fail (the listed failure's own key is not read
      // when nothing is listed), and then the cache is `unverified` until a read lands.
      const unread = kind !== "marker";
      expect(follower.ui.inputs.get().cache).toBe(
        unread ? "unverified" : "valid",
      );
      expect(follower.gate()).toBe(unread ? "refreshing" : "open");
      readable(w);
      follower.offline();
      follower.online();
      await w.settle();
      expect(follower.ui.inputs.get().cache).toBe("valid");
      expect(follower.gate()).toBe("open");
      finish(w, follower);
    });

  test("a cache the page READ as unmarked is not hidden by a marker read that fails later only when the failure is the read of THIS position's marker, and no other way of reading it lands: it is `unverified` until one lands (adapted, revision 29)", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    expect(follower.gate()).toBe("open");
    w.markerStorage.failGets = true;
    w.markerStorage.failEnumeration = true;
    follower.offline();
    follower.online();
    await w.settle();
    expect(follower.ui.inputs.get().cache).toBe("unverified");
    expect(follower.gate()).toBe("refreshing");
    w.markerStorage.failGets = false;
    w.markerStorage.failEnumeration = false;
    follower.offline();
    follower.online();
    await w.settle();
    expect(follower.ui.inputs.get().cache).toBe("valid");
    expect(follower.gate()).toBe("open");
    finish(w, follower);
  });

  test("a marker established for ANOTHER position or account says nothing about this one: the read of this position's marker that fails is unverified", async () => {
    const w = await build();
    const page = w.markerStorage.page("another-tab");
    const other = pageMarkers(page);
    other.set(scopeOf(w.service.account), invalidateOperation("cursor-9"));
    other.set(scopeOf("other-acct"), OP);
    const follower = await controllerProbe(w, { leader: false });
    expect(follower.gate()).toBe("open");
    w.markerStorage.failGets = true;
    w.markerStorage.failEnumeration = true;
    follower.offline();
    await w.settle();
    expect(follower.ui.inputs.get().cache).toBe("unverified");
    finish(w, follower);
  });
});

describe("the engine, the facade and the gate share one reading of the markers", () => {
  test("a stop recorded in the marker is honoured by the engine's capture gate while the markers cannot be read", async () => {
    const { w, leader, follower } = await arrange("marker");
    const requests = w.requests.length;
    unreadable(w, "getItem");
    // Every wake of the engine asks the markers; the marker the engine itself wrote is established.
    w.fire();
    await w.settle();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(requests);
    finish(w, leader, follower);
  });
});

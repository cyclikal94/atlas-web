// @vitest-environment node
import { describe, expect, test } from "vitest";
import { invalidateOperation } from "../../src/data/model/retry";
import { controllerProbe } from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import {
  markerKeys,
  markerStands,
  pageMarkers,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";
import { cacheRow } from "../support/data/rows";

/**
 * R47 reopened (revision 30): an OLDER removal of a marker is no proof about a NEWER stop, at the display boundary and at the admission
 * boundary of ordinary sync.
 *
 * Revision 29 kept every removal that returned as the page's "evidence" that the key was gone, so that a page that could no longer read
 * its markers answered `unmarked` (and showed the cache, and let the engine request) after it had removed one. The review of revision 29
 * reached it without calling `markers.clear` itself: an ordinary successful EMPTY delta page retains `cursor-0` (F-C2 permits it), and its
 * success path clears `page:cursor-0` and `invalidate:cursor-0`. Another page then recorded a NEW `invalidate:cursor-0`; its notification
 * was delayed and the reads failed; the facts still said `valid` (the failed invalidation is represented only by its fallback marker),
 * and the controller published `cache: valid`, `gate: open` over a cache that the server had said was invalid. A completed removal
 * establishes absence AT that removal; it says nothing about a marker written after it, which only a read that lands (asked at the
 * point of use) or a notification (which may be late, and is never the only protection) can show. Nothing is kept of a removal now.
 *
 * What a page that cannot read does is therefore the same whether or not the other page wrote a new marker (the two schedules differ
 * only in a record it cannot read and a notification it has not heard): it does not show the cache and it does not request. That is
 * deliberate, and tested as such below ("indistinguishable"); the cache opens, and the request goes, when a read lands and finds nothing.
 *
 * FIXTURE evidence: the production controller, engine and plans over the double of IndexedDB and of `localStorage` (whose reads fail on
 * demand and whose notifications can be held). Native engines: E-C8 (`fixture.data-gate.spec.ts`).
 */
const OP = invalidateOperation("cursor-0");
/** ANOTHER page records a NEW failure of the invalidation (its directory first, then its key), and the keys that stand for it. */
const plant = (w: World, account: string): string =>
  plantMarker(
    w.markerStorage.page("other-writer").storage,
    account,
    OP,
    "other.1",
  );
const stands = (w: World, account: string): boolean =>
  markerStands(w.markerStorage, account, OP);

type World = Awaited<ReturnType<typeof engineWorld>>;

interface Schedule {
  name: string;
  /** Another page wrote a NEW marker after the removal. */
  newMarker: boolean;
  /** The store can be read when the cache is derived. */
  readable: boolean;
  /** The notification of the new marker reaches this page. */
  delivered: boolean;
}

/** The review's schedules (its controls included) and the two this revision adds to make the unreadable control explicit. */
const SCHEDULES: Schedule[] = [
  {
    name: "delayed notification, nothing can be read",
    newMarker: true,
    readable: false,
    delivered: false,
  },
  {
    name: "delivered notification, nothing can be read",
    newMarker: true,
    readable: false,
    delivered: true,
  },
  {
    name: "the marker can be read (the notification is held)",
    newMarker: true,
    readable: true,
    delivered: false,
  },
  {
    name: "no new marker, nothing can be read",
    newMarker: false,
    readable: false,
    delivered: false,
  },
  {
    name: "no new marker, and it can be read",
    newMarker: false,
    readable: true,
    delivered: false,
  },
];
const OPEN: Record<string, boolean> = {
  "delayed notification, nothing can be read": false,
  "delivered notification, nothing can be read": false,
  "the marker can be read (the notification is held)": false,
  // ADAPTED, revision 30 (separately labelled, for the reviewer to accept or reject). The review's control expected `open` here, which
  // is what revision 29 did and what makes its failing case fail: this schedule and the first one are indistinguishable to the page.
  // The cache opens as soon as a read lands and finds nothing (the next case).
  "no new marker, nothing can be read": false,
  "no new marker, and it can be read": true,
};

const blind = (w: World): void => {
  w.markerStorage.failGets = true;
  w.markerStorage.failEnumeration = true;
};

function apply(w: World, schedule: Schedule, account: string): void {
  if (!schedule.readable) blind(w);
  if (!schedule.delivered) w.markerStorage.hold();
  if (schedule.newMarker) plant(w, account);
}

describe("the cache gate after an older removal of the invalidation's marker", () => {
  for (const schedule of SCHEDULES)
    test(`the consumer removed the marker itself: ${schedule.name}: ${OPEN[schedule.name] ? "open" : "hidden"}`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("cache", [
        cacheRow({ id: "private", value: { name: "retained" } }),
      ]);
      const page = w.markerStorage.page("consumer");
      const markers = pageMarkers(page);
      const off = markers.subscribe(() => undefined);
      markers.clear(scopeOf(w.service.account), OP);
      apply(w, schedule, w.service.account);
      const p = await controllerProbe(w, { leader: false, markers });
      try {
        p.offline();
        await w.settle();
        expect(p.gate() === "open").toBe(OPEN[schedule.name]);
        if (schedule.newMarker) expect(stands(w, w.service.account)).toBe(true);
      } finally {
        p.dispose();
        off();
        w.engine.stop();
      }
    });

  for (const schedule of SCHEDULES)
    test(`an ordinary page success retires the marker (no direct removal), then: ${schedule.name}: ${OPEN[schedule.name] ? "open" : "hidden"}`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("cache", [
        cacheRow({ id: "private", value: { name: "retained" } }),
      ]);
      // An ordinary successful EMPTY page that retains its cursor (F-C2): the engine's success path clears the page's and the
      // invalidation's markers at this position.
      w.script.push(w.emptyPage("cursor-0"));
      w.start();
      await w.settle();
      w.engine.stop();
      expect(w.requests).toHaveLength(1);
      expect(w.sync().cursor).toBe("cursor-0");
      const off = w.markers.subscribe(() => undefined);
      apply(w, schedule, w.service.account);
      const p = await controllerProbe(w, { leader: false, markers: w.markers });
      try {
        p.offline();
        await w.settle();
        expect(p.gate() === "open").toBe(OPEN[schedule.name]);
        if (!OPEN[schedule.name])
          expect(["unverified", "invalid"]).toContain(p.ui.inputs.get().cache);
      } finally {
        p.dispose();
        off();
        w.service.dispose("closed");
      }
    });

  test("what the page can observe is the SAME with and without the new marker, so is what it shows: hidden in both, never `valid` for either", async () => {
    const run = async (newMarker: boolean) => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("cache", [
        cacheRow({ id: "private", value: { name: "retained" } }),
      ]);
      w.script.push(w.emptyPage("cursor-0"));
      w.start();
      await w.settle();
      w.engine.stop();
      const off = w.markers.subscribe(() => undefined);
      apply(
        w,
        {
          name: "x",
          newMarker,
          readable: false,
          delivered: false,
        },
        w.service.account,
      );
      const p = await controllerProbe(w, { leader: false, markers: w.markers });
      try {
        p.offline();
        await w.settle();
        return {
          raw: stands(w, w.service.account) ? "1" : null,
          seen: {
            gate: p.gate(),
            cache: p.ui.inputs.get().cache,
            probe: w.markers.probe(scopeOf(w.service.account), OP),
          },
        };
      } finally {
        p.dispose();
        off();
        w.service.dispose("closed");
      }
    };
    const withNew = await run(true);
    const without = await run(false);
    expect(withNew.raw).toBe("1");
    expect(without.raw).toBeNull();
    expect(withNew.seen).toEqual(without.seen);
    expect(withNew.seen.gate).not.toBe("open");
    expect(withNew.seen.probe).toBe("unknown");
  });

  test("the cache comes back through a read, not through an event: after the new marker is removed and the store can be read, a look finds nothing against it", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "private", value: { name: "retained" } })]);
    w.script.push(w.emptyPage("cursor-0"));
    w.start();
    await w.settle();
    w.engine.stop();
    const off = w.markers.subscribe(() => undefined);
    apply(
      w,
      {
        name: "x",
        newMarker: true,
        readable: false,
        delivered: false,
      },
      w.service.account,
    );
    const p = await controllerProbe(w, { leader: false, markers: w.markers });
    try {
      p.offline();
      await w.settle();
      expect(p.gate()).not.toBe("open");
      // The store can be read again (nothing notifies the page): the controller asks again on its own pace and finds the marker.
      w.markerStorage.failGets = false;
      w.markerStorage.failEnumeration = false;
      await w.advance(20_000);
      expect(p.ui.inputs.get().cache).toBe("invalid");
      expect(p.gate()).not.toBe("open");
      // Another page ends it; the page reads again when it is told, and opens the cache only through that read.
      w.markerStorage.release();
      for (const key of markerKeys(w.markerStorage, w.service.account, OP))
        w.markerStorage.page("other-writer").storage.removeItem(key);
      w.markerStorage.release();
      await w.advance(20_000);
      expect(p.ui.inputs.get().cache).toBe("valid");
      expect(p.gate()).toBe("open");
    } finally {
      p.dispose();
      off();
      w.service.dispose("closed");
    }
  });
});

describe("ordinary sync after its own page success, then another page's new stop", () => {
  for (const schedule of SCHEDULES)
    test(`${schedule.name}: ${schedule.newMarker || !schedule.readable ? "no request" : "the request goes"}`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("cache", [
        cacheRow({ id: "private", value: { name: "retained" } }),
      ]);
      w.script.push(w.emptyPage("cursor-0"));
      w.start();
      await w.settle();
      w.engine.stop();
      expect(w.requests).toHaveLength(1);
      apply(w, schedule, w.service.account);
      // The same page, the same markers and the SAME engine, started again (an ownership change in a page that stays alive): anything the
      // engine itself kept of its own retirement of the marker (the mutants MU-955 name) is still there.
      w.start();
      await w.settle();
      await w.advance(10_000);
      try {
        const sent = w.requests.length;
        if (schedule.newMarker || !schedule.readable) {
          expect(sent).toBe(1);
          expect(w.sync().cursor).toBe("cursor-0");
          // A marker the page can read is a stop and says so; one it cannot read is an unknown, and the page says storage is not responding.
          expect(w.state()).toEqual(
            schedule.readable
              ? { kind: "stopped", cause: "local_storage", invalidating: true }
              : { kind: "stopped", cause: "local_storage" },
          );
        } else {
          expect(sent).toBe(2);
        }
        if (schedule.newMarker) expect(stands(w, w.service.account)).toBe(true);
      } finally {
        w.engine.stop();
        w.service.dispose("closed");
      }
    });

  // With nothing readable the gate also asks about four operations the page never removed (`capture`, `retry-state`, `sizing`, the
  // page's), which are unknown, so the engine would stop for them whatever it believed of the invalidation's. This case makes the
  // invalidation's own operation the ONLY unreadable one (the others are read and found absent), so that what is tested is the belief
  // about an older removal and nothing else: revision 29 requested through a NEW invalidation marker here.
  // ADAPTED, revision 32 (R52): a marker is read by listing the account's keys, so no storage state makes ONE operation unreadable (a
  // store that cannot be listed is unknown for all five). The mixture is built at the markers port instead: its witness says `unread`
  // for the invalidation's operation and answers as the real markers do for the others. The rule under test is the engine's, asked of
  // the port's contract; the notification of a new marker is still held, and the later read is the real listing.
  for (const newMarker of [true, false])
    test(`only the invalidation's own marker cannot be read (the gate's other four questions land), ${newMarker ? "another page recorded a NEW one (notification held)" : "no new marker"}: no request`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("cache", [
        cacheRow({ id: "private", value: { name: "retained" } }),
      ]);
      w.script.push(w.emptyPage("cursor-0"));
      w.start();
      await w.settle();
      w.engine.stop();
      expect(w.requests).toHaveLength(1);
      const witness = w.markers.witness.bind(w.markers);
      w.markers.witness = (account, operation) =>
        operation === OP ? { kind: "unread" } : witness(account, operation);
      w.markerStorage.hold();
      if (newMarker) plant(w, w.service.account);
      w.start();
      await w.settle();
      await w.advance(10_000);
      try {
        expect(w.requests).toHaveLength(1);
        expect(w.sync().cursor).toBe("cursor-0");
        expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
        // The store can be read again: the request goes only if no marker is there.
        w.markers.witness = witness;
        await w.advance(70_000);
        if (newMarker) expect(w.requests).toHaveLength(1);
        else expect(w.requests.length).toBeGreaterThan(1);
      } finally {
        w.engine.stop();
        w.service.dispose("closed");
      }
    });

  test("the request goes once a read lands and finds nothing, without anyone's act (the engine asks again on its pace)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("cache", [cacheRow({ id: "private", value: { name: "retained" } })]);
    w.script.push(w.emptyPage("cursor-0"));
    w.start();
    await w.settle();
    w.engine.stop();
    blind(w);
    w.markerStorage.hold();
    w.start();
    await w.settle();
    await w.advance(10_000);
    try {
      expect(w.requests).toHaveLength(1);
      w.markerStorage.failGets = false;
      w.markerStorage.failEnumeration = false;
      await w.advance(70_000);
      expect(w.requests.length).toBeGreaterThan(1);
    } finally {
      w.engine.stop();
      w.service.dispose("closed");
    }
  });
});

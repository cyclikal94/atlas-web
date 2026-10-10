// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { invalidateOperation } from "../../src/data/model/retry";
import type { CacheState } from "../../src/data/model/status";
import { readMerged } from "../../src/data/plans/outbox";
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
 * R15 (revision 11): an ALREADY-OPEN follower hides a cache that another page can record as invalid only through the account's fallback
 * marker. The sixth review reproduced it over the production controller, `CacheGate` and real IndexedDB in three engines: a follower
 * with a successful read of the facts shows the retained cache; the leader receives `410 resync_required`, its invalidation transaction
 * fails, and either its failure counter cannot be written either, or the failure is a quota failure and is deliberately not counted;
 * the account/position marker is written to `localStorage` (the leader hides its cache and stops) while the database still says
 * `valid`; and the follower, which read the marker only when something ELSE made it recompute, stayed `open`.
 *
 * What these tests drive is the PRODUCTION controller (`createDataEnv`), engine, plans and store over the double of IndexedDB, with a
 * scripted network and fake time, and what they check is what the screens derive: the gate and the cache state. A follower is its own
 * PAGE over the world's `localStorage` (`controllerProbe`): the engine's writes reach it as a `storage` event, as the browser delivers
 * one, and never reach the engine's own page. FIXTURE evidence: a named injected transaction fault, not a native storage fault and not
 * genuine quota exhaustion; the native cases are E-C8 in `fixture.data-gate.spec.ts`.
 *
 * The notification is a PROMPT and never a record (the required correction): a marker that appears hides the cache, a marker that goes
 * opens nothing by itself, and what is shown follows a read of the facts begun after the change.
 */
const OP = invalidateOperation("cursor-0");
const FACTS = "data.readSyncFacts";
const FIRST_WAIT = DATA_CONFIG.factsReadRetryMs;

/** What recorded the failed invalidation: the durable counter (the control), the fallback marker, or a quota failure's marker. */
type Path = "counter" | "marker" | "quota";
const PATHS: readonly Path[] = ["counter", "marker", "quota"];
type Mode = "pending" | "error" | "abort";

async function build() {
  const w = await engineWorld({ cursor: "cursor-0" });
  w.put("cache", [
    cacheRow({ id: uuid(9), value: { name: "retained private resource" } }),
  ]);
  w.put("drafts", [draftRow({ local_id: "kept", status: "queued" })]);
  return w;
}
type World = Awaited<ReturnType<typeof build>>;

/** Another page's marker store: what a second tab's `createWriteFailureMarkers` is over the same `localStorage`. */
const otherPage = (w: World, name = "another-tab") => {
  const page = w.markerStorage.page(name);
  return {
    markers: pageMarkers(page),
    clear: () => page.clear(),
  };
};

/** The follower's cache state, every change from now on. */
function watchCache(probe: ControllerProbe): CacheState[] {
  const seen: CacheState[] = [];
  probe.ui.inputs.subscribe(() => {
    const cache = probe.ui.inputs.get().cache;
    if (seen.at(-1) !== cache) seen.push(cache);
  });
  return seen;
}

/** Counts the reads of the sync facts. Arm it BEFORE a fault: the double stops at the first rule that matches, and this never does. */
function countReads(w: World): () => number {
  let reads = 0;
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label === FACTS) reads += 1;
      return false;
    },
    mode: "error",
    times: 1,
  });
  return () => reads;
}

const failFacts = (w: World, mode: Mode, times = 1) =>
  w.env.idb.inject({ match: (tx) => tx.label === FACTS, mode, times });

/** A write to the singleton re-evaluates a live read of it (the double pushes a commit to the watchers of the stores it touched). */
const nudge = (w: World, probe: ControllerProbe) => {
  const service = probe.ui.service() ?? w.service;
  return service.store.run(resetSizingFloor, {
    incarnationId: service.incarnationId,
  });
};

/** What a screen may still use while the cache is hidden: the cached row is readable and the draft is there and counted. */
async function retained(w: World, probe: ControllerProbe) {
  const cached = await probe.ui.service()?.store.run(readMerged, {
    incarnationId: w.service.incarnationId,
    id: uuid(9),
  });
  const summary = probe.ui.summary.get();
  return {
    cached: cached?.base?.id,
    drafts: w.rows("drafts").length,
    queued: summary.status === "ready" ? summary.value.waiting : null,
  };
}

/** A leader (the engine, in its own page) and a follower that is OPEN before anything fails, with its cache state recorded from there. */
async function arrange(path: Path) {
  const w = await build();
  const leader = await controllerProbe(w, { leader: true });
  const follower = await controllerProbe(w, { leader: false });
  // The review's schedule needs a follower with an established, successful read and nothing scheduled.
  expect(follower.ui.inputs.get().cache).toBe("valid");
  expect(follower.gate()).toBe("open");
  const seen = watchCache(follower);
  w.env.idb.inject({
    match: (tx) => tx.label === "data.invalidateCache",
    mode: path === "quota" ? "quota" : "error",
    times: 100,
  });
  // The counter write fails too, so only the marker records it; a quota failure is not counted at all.
  if (path === "marker")
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 100,
    });
  w.script.push(w.status(410, { body: { code: "resync_required" } }));
  w.start();
  await w.settle();
  return { w, leader, follower, seen };
}

const finish = (w: World, ...probes: ControllerProbe[]) => {
  for (const probe of probes) probe.dispose();
  w.engine.stop();
};

describe("an already-open follower learns of an invalidation another page could only record in the fallback marker", () => {
  for (const path of PATHS)
    test(`${path}: open before, hidden after the leader's invalidation fails, with no further request or read of its own; the cache and the draft are kept`, async () => {
      const { w, leader, follower, seen } = await arrange(path);
      const account = w.service.account;
      // One GET: the leader received the 410, and the database still says `valid`: its invalidation could not be written.
      expect(w.requests).toHaveLength(1);
      expect(w.sync().cache_status).toBe("valid");
      if (path === "counter") {
        expect(w.sync().local_write_streaks[OP]).toBeGreaterThan(0);
        expect(w.markers.operations(scopeOf(account))).toEqual([]);
      } else {
        expect(w.sync().local_write_streaks).toEqual({});
        expect(w.markers.operations(scopeOf(account))).toEqual([OP]);
      }
      expect(leader.gate()).toBe("refreshing");
      // The follower was told (the marker's `storage` event; the counter's own commit): hidden, and it never read `valid` again.
      expect(follower.gate()).toBe("refreshing");
      expect(follower.ui.inputs.get().cache).toBe("invalid");
      expect(seen).not.toContain("valid");
      expect(seen.at(-1)).toBe("invalid");
      // Ten simulated minutes: nothing prompts a recomputation, and nothing opens it.
      await w.advance(600_000);
      expect(follower.gate()).toBe("refreshing");
      expect(leader.gate()).toBe("refreshing");
      expect(w.requests).toHaveLength(1);
      expect(await retained(w, follower)).toEqual({
        cached: uuid(9),
        drafts: 1,
        queued: 1,
      });
      finish(w, leader, follower);
    });

  for (const path of ["marker", "quota"] as const)
    test(`${path}: the follower checks again by reading the facts once, begun after the marker, and hides the cache in between`, async () => {
      const w = await build();
      const leader = await controllerProbe(w, { leader: true });
      const follower = await controllerProbe(w, { leader: false });
      const reads = countReads(w);
      const seen = watchCache(follower);
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
      expect(follower.ui.inputs.get().cache).toBe("invalid");
      // Never `valid` after the marker; the cache state went through "not established" on its way (the read is made again, not assumed).
      expect(seen).toEqual(["unverified", "invalid"]);
      expect(reads()).toBeGreaterThan(0);
      finish(w, leader, follower);
    });
});

describe("a marker that does not concern the displayed account and position changes nothing", () => {
  type Foreign = readonly [string, (account: string) => [string, string]];
  const FOREIGN: readonly Foreign[] = [
    [
      "another account's marker for the same position",
      () => ["other-acct", OP],
    ],
    [
      "this account's marker for ANOTHER position",
      (account) => [account, invalidateOperation("cursor-9")],
    ],
    [
      "this account's marker for an unrelated operation (a page's own write)",
      (account) => [account, "page:cursor-0"],
    ],
  ];
  for (const [name, key] of FOREIGN)
    test(`${name}: no read, no change of state, still open`, async () => {
      const w = await build();
      const follower = await controllerProbe(w, { leader: false });
      const reads = countReads(w);
      const seen = watchCache(follower);
      const other = otherPage(w);
      const [account, operation] = key(w.service.account);
      other.markers.set(scopeOf(account), operation);
      await w.settle();
      expect(follower.gate()).toBe("open");
      expect(follower.ui.inputs.get().cache).toBe("valid");
      expect(reads()).toBe(0);
      expect(seen).toEqual([]);
      // ... and when it goes, no more than when it came.
      other.markers.clear(scopeOf(account), operation);
      await w.settle();
      expect(follower.gate()).toBe("open");
      expect(reads()).toBe(0);
      expect(seen).toEqual([]);
      finish(w, follower);
    });

  test("a key that is not one of ours (another use of the origin's storage) is ignored", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    const reads = countReads(w);
    const page = w.markerStorage.page("another-tab");
    page.storage.setItem("some-other-key", "1");
    await w.settle();
    expect(follower.gate()).toBe("open");
    expect(reads()).toBe(0);
    finish(w, follower);
  });

  test("the marker of THIS position, written by another page, does hide it (the control for the three above)", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    otherPage(w).markers.set(scopeOf(w.service.account), OP);
    await w.settle();
    expect(follower.gate()).toBe("refreshing");
    expect(follower.ui.inputs.get().cache).toBe("invalid");
    expect(await retained(w, follower)).toMatchObject({ cached: uuid(9) });
    finish(w, follower);
  });
});

describe("the notification prompts a check and never authorises display", () => {
  const MODES: readonly Mode[] = ["pending", "error", "abort"];

  for (const mode of MODES)
    test(`a marker another page removes while the facts still say valid: hidden while the read begun after it is ${mode}, open only when one lands`, async () => {
      const w = await build();
      const other = otherPage(w);
      other.markers.set(scopeOf(w.service.account), OP);
      const follower = await controllerProbe(w, { leader: false });
      expect(follower.ui.inputs.get().cache).toBe("invalid");
      // The marker goes. Nothing durable says the position is safe (the facts read `valid`, no counter): what the read says decides.
      failFacts(w, mode);
      other.markers.clear(scopeOf(w.service.account), OP);
      expect(follower.ui.inputs.get().cache).toBe("unverified");
      expect(follower.gate()).toBe("refreshing");
      if (mode === "pending") {
        await w.advance(FIRST_WAIT * 4);
        expect(follower.gate()).toBe("refreshing");
        await nudge(w, follower);
        await w.settle();
      } else {
        // A failed read is made again at the pace of the R13 re-read; until one lands the cache stays hidden.
        await w.advance(FIRST_WAIT - 1);
        expect(follower.gate()).toBe("refreshing");
        await w.advance(1);
      }
      expect(follower.ui.inputs.get().cache).toBe("valid");
      expect(follower.gate()).toBe("open");
      finish(w, follower);
    });

  test("a marker another page removes while the facts say `invalid`: hidden before, during and after the read", async () => {
    const w = await build();
    w.setSync({ cache_status: "invalid", local_write_streaks: {} });
    const other = otherPage(w);
    other.markers.set(scopeOf(w.service.account), OP);
    const follower = await controllerProbe(w, { leader: false });
    const seen = watchCache(follower);
    other.markers.clear(scopeOf(w.service.account), OP);
    await w.settle();
    expect(follower.gate()).toBe("refreshing");
    expect(follower.ui.inputs.get().cache).toBe("invalid");
    expect(seen).not.toContain("valid");
    finish(w, follower);
  });

  test("a marker that appears while the read that would confirm it fails: hidden through the failure, and still hidden when it lands", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    failFacts(w, "error", 2);
    otherPage(w).markers.set(scopeOf(w.service.account), OP);
    expect(follower.gate()).toBe("refreshing");
    await w.advance(FIRST_WAIT);
    await w.advance(FIRST_WAIT * 2);
    expect(follower.ui.inputs.get().cache).toBe("invalid");
    expect(follower.gate()).toBe("refreshing");
    finish(w, follower);
  });

  test("two changes in a row (set, then removed) read once for each and end on what the markers say last", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    const reads = countReads(w);
    const other = otherPage(w);
    for (let n = 0; n < 10; n += 1) {
      other.markers.set(scopeOf(w.service.account), OP);
      other.markers.clear(scopeOf(w.service.account), OP);
    }
    await w.settle();
    // Twenty changes: no more than twenty reads, none of them left standing, and the last word is the last change's.
    expect(reads()).toBeLessThanOrEqual(20);
    expect(follower.ui.inputs.get().cache).toBe("valid");
    expect(follower.gate()).toBe("open");
    other.markers.set(scopeOf(w.service.account), OP);
    await w.settle();
    expect(follower.gate()).toBe("refreshing");
    await w.advance(600_000);
    expect(follower.gate()).toBe("refreshing");
    finish(w, follower);
  });

  test("a cleared storage may have taken the marker with it: it is read about again, and the state follows what is found", async () => {
    const w = await build();
    const other = otherPage(w);
    other.markers.set(scopeOf(w.service.account), OP);
    const follower = await controllerProbe(w, { leader: false });
    expect(follower.gate()).toBe("refreshing");
    const reads = countReads(w);
    other.clear();
    await w.settle();
    expect(reads()).toBeGreaterThan(0);
    expect(follower.ui.inputs.get().cache).toBe("valid");
    expect(follower.gate()).toBe("open");
    finish(w, follower);
  });
});

describe("a successful recovery: the invalidation lands, the marker goes, and the cache stays hidden until a snapshot is applied", () => {
  for (const path of ["marker", "quota"] as const)
    test(`${path}: the leader's retry writes the invalidation; the follower was hidden and never reads \`valid\` in between; the new position opens it`, async () => {
      const { w, leader, follower, seen } = await arrange(path);
      expect(follower.gate()).toBe("refreshing");
      // The fault is gone and the person asks again: the guarded write lands, and the marker (the record that hid it) goes.
      w.env.idb.clearInjections();
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(60_000);
      expect(w.sync().cache_status).toBe("invalid");
      expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
      // The marker's removal reached the follower as a notification; the durable `invalid` is what it reads now.
      expect(follower.gate()).toBe("refreshing");
      expect(follower.ui.inputs.get().cache).toBe("invalid");
      expect(seen).not.toContain("valid");
      // A fresh snapshot is applied at a new position: only now does the content open, in both pages.
      w.setSync({
        cache_status: "valid",
        cursor: "cursor-1",
        local_write_streaks: {},
      });
      await nudge(w, follower);
      await w.settle();
      expect(follower.ui.inputs.get().cache).toBe("valid");
      expect(follower.gate()).toBe("open");
      finish(w, leader, follower);
    });
});

describe("controls: the records the follower already read, and a controller that is gone", () => {
  for (const path of ["marker", "quota"] as const)
    test(`${path}: a follower that opens AFTER the marker was written, or a page that reloads, is hidden from its first read`, async () => {
      const { w, leader, follower } = await arrange(path);
      const late = await controllerProbe(w, { leader: false });
      expect(late.ui.inputs.get().cache).toBe("invalid");
      expect(late.gate()).toBe("refreshing");
      follower.dispose();
      const reloaded = await controllerProbe(w, { leader: false });
      expect(reloaded.gate()).toBe("refreshing");
      finish(w, leader, late, reloaded);
    });

  test("a disposed controller no longer listens: a marker changes nothing, reads nothing, and no listener is left", async () => {
    const w = await build();
    // (adapted, revision 36) The count is taken BEFORE the controller exists: its disposal leaves every feed it made behind it, its own
    // facade's included (R55, revision 36: the facade's observation ends with the binding). The original compared with `listening - 1`,
    // which counted only the controller's own feed and so encoded the facade's feed outliving the controller.
    const before = w.markerStorage.listening;
    const follower = await controllerProbe(w, { leader: false });
    const listening = w.markerStorage.listening;
    expect(listening).toBeGreaterThan(before);
    follower.dispose();
    expect(w.markerStorage.listening).toBe(before);
    const reads = countReads(w);
    otherPage(w).markers.set(scopeOf(w.service.account), OP);
    await w.settle();
    expect(reads()).toBe(0);
    w.engine.stop();
  });
});

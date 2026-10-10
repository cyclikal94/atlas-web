// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { RecoverySeam } from "../../src/data/engine/recovery-seam";
import type {
  InvalidationHold,
  SyncEngine,
} from "../../src/data/engine/sync-engine";
import { DATA_CONFIG } from "../../src/data/model/config";
import { invalidateOperation } from "../../src/data/model/retry";
import type { Notice } from "../../src/data/model/status";
import { controllerProbe } from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import { scopeOf } from "../support/data/marker-storage";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R10 (revision 9): the cache the server has said is invalid stays hidden for as long as its invalidation is outstanding, through every
 * transition that used to forget it. The fourth review reproduced six schedules over the production controller, engine and store plans:
 * a memory-only stop followed by an offline wake, and an explicit retry followed by connectivity loss or by a persistence hold that
 * cannot verify the commit. In each the retry (or the wake) erased or replaced the only record that hid the cache, the database still
 * said `valid`, and the gate was `open` with no notice after ten simulated minutes.
 *
 * What these tests drive is the PRODUCTION controller (`createDataEnv`), engine and store plans over the double of IndexedDB, with a
 * scripted network and fake time, and what they check is what the screens derive from the controller's inputs: the gate and the notices.
 * A FOLLOWER tab and a RELOAD are a second controller built over the same database and markers (the first one's memory does not come
 * with it). FIXTURE evidence: a named injected transaction fault, not a native storage fault and not genuine quota exhaustion.
 */
type World = Awaited<ReturnType<typeof build>>["w"];

const OP = invalidateOperation("cursor-0");
const BOUND = DATA_CONFIG.localWritePauseAfter;

function recovery(requested: string[]): RecoverySeam {
  return {
    registered: true,
    request: (reason) => {
      requested.push(reason);
    },
    active: { get: () => false, subscribe: () => () => undefined },
  };
}

async function build(options: { cursor?: string } = {}) {
  const requested: string[] = [];
  const w = await engineWorld({
    cursor: options.cursor ?? "cursor-0",
    recovery: recovery(requested),
  });
  w.put("cache", [cacheRow({ id: uuid(9) })]);
  w.put("drafts", [draftRow({ local_id: "kept", status: "queued" })]);
  w.put("pending_effects", [
    effectRow({
      resource_id: uuid(9),
      local_id: "kept-effect",
      display: { label: "overlay" },
    }),
  ]);
  return { w, requested };
}

type Fault = "abort" | "error" | "quota";
/** What recorded the failure: the durable counter, the account's fallback marker, or only this tab's memory. */
type RecordedBy = "counter" | "marker" | "memory";

const ARRANGEMENTS: ReadonlyArray<readonly [Fault, RecordedBy]> = [
  ["abort", "counter"],
  ["abort", "marker"],
  ["abort", "memory"],
  ["error", "counter"],
  ["error", "marker"],
  ["error", "memory"],
  // A quota failure is not counted (a counter would need the very space that is missing): marker, or memory alone.
  ["quota", "marker"],
  ["quota", "memory"],
];

const failInvalidation = (w: World, mode: Fault, times = 100) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.invalidateCache",
    mode,
    times,
  });

const failCounter = (w: World) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.recordLocalWriteOutcome",
    mode: "error",
    times: 100,
  });

/**
 * Counts the attempts to write the invalidation. Arm it BEFORE the fault: the double stops at the first rule that matches, and this
 * one never does.
 */
function countAttempts(w: World): () => number {
  let attempts = 0;
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label === "data.invalidateCache") attempts += 1;
      return false;
    },
    mode: "error",
    times: 1,
  });
  return () => attempts;
}

const holds = (w: World): string[] =>
  w.engine.invalidations.get().map((hold) => hold.operation);

const durable = (w: World) => ({
  streaks: { ...w.sync().local_write_streaks },
  markers: w.markers.operations(scopeOf(w.service.account)),
});

const notice = (fault: Fault, record: RecordedBy): Notice =>
  fault === "quota"
    ? { kind: "storage_full", cache: "invalid" }
    : { kind: "page_not_saved", memoryOnly: record === "memory" };

/** The failed write, recorded as `record` says, with the controller attached and the first step done. */
async function arrange(fault: Fault, record: RecordedBy) {
  const { w, requested } = await build();
  const leader = await controllerProbe(w, { leader: true });
  expect(leader.gate()).toBe("open");
  const attempts = countAttempts(w);
  failInvalidation(w, fault);
  if (record !== "counter" && fault !== "quota") failCounter(w);
  if (record === "memory") w.markerStorage.failWrites = true;
  w.script.push(w.status(410, { body: { code: "resync_required" } }));
  w.start();
  await w.settle();
  // The failure is outstanding: one GET, the database still says `valid`, the cache is hidden and the stop says why.
  expect(w.requests).toHaveLength(1);
  expect(w.sync().cache_status).toBe("valid");
  expect(w.state()).toMatchObject({
    kind: "stopped",
    invalidating: true,
    cause: fault === "quota" ? "storage_full" : "local_storage",
  });
  expect(leader.gate()).toBe("refreshing");
  expect(holds(w)).toEqual([OP]);
  const recorded = durable(w);
  if (record === "counter") expect(recorded.streaks).toEqual({ [OP]: BOUND });
  else expect(recorded.streaks).toEqual({});
  expect(recorded.markers).toEqual(record === "marker" ? [OP] : []);
  // The first cycle's attempts: the bound when a counter can be written, one when it cannot or the failure is a quota.
  expect(attempts()).toBe(record === "counter" ? BOUND : 1);
  return { w, requested, leader, attempts };
}

/** The attempts one retry's cycle makes: the bound when the failure is counted, one when it cannot be or is a quota failure. */
const cycle = (record: RecordedBy) => (record === "counter" ? BOUND : 1);

/**
 * The browser has lost connectivity but no wake has been delivered to the engine yet (`offline` is an event, and a frozen or
 * throttled page learns of it late): the engine is still `stopped`, and a click on "Retry applying changes" reaches it in that state.
 */
const silentlyOffline = (w: World): void => {
  w.online = false;
};

const finish = (...probes: Array<{ dispose(): void }>) => {
  for (const probe of probes) probe.dispose();
};

describe("an offline wake does not lift the hold (the review's first schedule)", () => {
  for (const [fault, record] of ARRANGEMENTS)
    test(`${fault}, recorded by ${record}: hidden through the wake and ten minutes; one GET; drafts kept; the stop and its notice return online`, async () => {
      const { w, requested, leader } = await arrange(fault, record);
      leader.offline();
      await w.settle();
      expect(leader.gate()).toBe("refreshing");
      await w.advance(600_000);
      // The engine is only waiting for connectivity; the cache is still known to be invalid, whatever else it is doing.
      expect(w.state()).toMatchObject({
        kind: "waiting",
        reason: "offline",
        invalidating: true,
      });
      expect(leader.gate()).toBe("refreshing");
      expect(holds(w)).toEqual([OP]);
      expect(w.sync().cache_status).toBe("valid");
      expect(w.requests).toHaveLength(1);
      expect(requested).toEqual([]);
      expect(w.rows("drafts")).toHaveLength(1);
      expect(w.cache()).toHaveLength(1);
      expect(w.rows("pending_effects")).toHaveLength(1);
      // Back online the stop is restored from whatever recorded it, with its notice, and still nothing is sent.
      leader.online();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests).toHaveLength(1);
      expect(leader.gate()).toBe("refreshing");
      // (An offline wake replaces the engine's state, so a quota stop is shown again as the generic one: the notice, not the hold.)
      expect(leader.notices()).toEqual([
        notice(fault === "quota" ? "error" : fault, record),
      ]);
      finish(leader);
      w.engine.stop();
    });

  for (const [fault, record] of ARRANGEMENTS)
    test(`${fault}, recorded by ${record}: the explicit retry after the wake writes it, once, and asks for recovery, once`, async () => {
      const { w, requested, leader } = await arrange(fault, record);
      leader.offline();
      await w.settle();
      leader.online();
      await w.settle();
      w.env.idb.clearInjections();
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests).toHaveLength(1);
      expect(requested).toEqual(["resync_required"]);
      expect(w.sync().cache_status).toBe("invalid");
      expect(durable(w)).toEqual({ streaks: {}, markers: [] });
      expect(holds(w)).toEqual([]);
      expect(leader.gate()).toBe("refreshing");
      expect(leader.notices()).toEqual([]);
      expect(w.state()).not.toHaveProperty("invalidating");
      expect(w.rows("drafts")).toHaveLength(1);
      finish(leader);
      w.engine.stop();
    });
});

describe("an explicit retry does not erase what hides the cache (the review's second schedule)", () => {
  for (const [fault, record] of ARRANGEMENTS)
    test(`${fault}, recorded by ${record}: retry, then connectivity loss before any attempt: hidden, the record is exactly as it was, nothing is sent`, async () => {
      const { w, leader, attempts } = await arrange(fault, record);
      const before = durable(w);
      const first = attempts();
      silentlyOffline(w);
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(600_000);
      // The retry reached a STOPPED engine, lifted the stop, and found no connectivity: nothing attempted, nothing erased.
      expect(w.state()).toMatchObject({
        kind: "waiting",
        reason: "offline",
        invalidating: true,
      });
      expect(attempts()).toBe(first);
      expect(leader.gate()).toBe("refreshing");
      expect(holds(w)).toEqual([OP]);
      expect(durable(w)).toEqual(before);
      expect(w.sync().cache_status).toBe("valid");
      expect(w.requests).toHaveLength(1);
      expect(w.rows("drafts")).toHaveLength(1);
      // Connectivity returns: the lifted cycle goes on (its own bound), the record only ever grows, and the stop returns after it.
      leader.online();
      await w.settle();
      await w.advance(60_000);
      expect(attempts()).toBe(first + cycle(record));
      expect(leader.gate()).toBe("refreshing");
      expect(holds(w)).toEqual([OP]);
      expect(w.state()).toMatchObject({ kind: "stopped", invalidating: true });
      expect(w.requests).toHaveLength(1);
      finish(leader);
      w.engine.stop();
    });

  for (const [fault, record] of ARRANGEMENTS)
    test(`${fault}, recorded by ${record}: retry, then connectivity loss during its first attempt: hidden, and the cycle's attempts survive the gap`, async () => {
      const { w, leader } = await arrange(fault, record);
      const before = durable(w);
      // Connectivity goes when the retry's first capture runs (the step has already passed its own online check).
      let armed = false;
      w.env.idb.inject({
        match: (tx) => {
          if (armed && tx.label === "data.captureRequest") w.online = false;
          return false;
        },
        mode: "error",
        times: 1,
      });
      armed = true;
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(600_000);
      expect(w.online).toBe(false);
      expect(leader.gate()).toBe("refreshing");
      expect(holds(w)).toEqual([OP]);
      // Whatever the attempt did, no record that hides the cache went away: the streak never fell, the marker is still there.
      const after = durable(w);
      expect(after.markers).toEqual(before.markers);
      for (const [operation, count] of Object.entries(before.streaks))
        expect(after.streaks[operation]).toBeGreaterThanOrEqual(count);
      expect(w.sync().cache_status).toBe("valid");
      expect(w.requests).toHaveLength(1);
      finish(leader);
      w.engine.stop();
    });

  for (const [fault, record] of ARRANGEMENTS)
    test(`${fault}, recorded by ${record}: a retry while the persistence hold cannot verify the commit: hidden for ten minutes, record intact, paced, then written when it can`, async () => {
      const { w, requested, leader } = await arrange(fault, record);
      const before = durable(w);
      w.gate.mode = "unavailable";
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(600_000);
      expect(leader.gate()).toBe("refreshing");
      expect(holds(w)).toEqual([OP]);
      expect(durable(w)).toEqual(before);
      expect(w.sync().cache_status).toBe("valid");
      // It asked for the hold, again and again but paced, and sent nothing: the retained write needs no new request.
      const refused = w.gate.requests.filter(
        (request) => request.answer === "unavailable",
      ).length;
      expect(refused).toBeGreaterThan(1);
      expect(refused).toBeLessThan(40);
      expect(w.requests).toHaveLength(1);
      expect(requested).toEqual([]);
      // The hold can verify again and the fault is gone: the write lands, and only then does the record go.
      w.gate.mode = "held";
      w.env.idb.clearInjections();
      await w.advance(120_000);
      expect(w.sync().cache_status).toBe("invalid");
      expect(requested).toEqual(["resync_required"]);
      expect(durable(w)).toEqual({ streaks: {}, markers: [] });
      expect(holds(w)).toEqual([]);
      expect(leader.gate()).toBe("refreshing");
      expect(w.requests).toHaveLength(1);
      finish(leader);
      w.engine.stop();
    });
});

describe("a follower tab and a reload keep the cache hidden after a retry that used to clear the durable record", () => {
  // Only what is durable can be known by a tab that did not hold the failure in its own memory.
  const DURABLE = ARRANGEMENTS.filter(([, record]) => record !== "memory");
  for (const [fault, record] of DURABLE)
    test(`${fault}, recorded by ${record}: after a retry and connectivity loss a follower hides the cache; so does a reload, which stops before it sends anything`, async () => {
      const { w, leader } = await arrange(fault, record);
      silentlyOffline(w);
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(60_000);
      expect(leader.gate()).toBe("refreshing");
      // A FOLLOWER: another tab's controller over the same database and markers, with no engine of its own.
      const follower = await controllerProbe(w, { leader: false });
      expect(follower.gate()).toBe("refreshing");
      finish(follower);
      // A RELOAD: the engine, its holds and the controller's memory are gone; the durable record is all there is.
      finish(leader);
      w.reload();
      const reloaded = await controllerProbe(w, { leader: true });
      expect(reloaded.gate()).toBe("refreshing");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests).toHaveLength(1);
      expect(reloaded.gate()).toBe("refreshing");
      expect(w.state()).toMatchObject({ kind: "stopped", invalidating: true });
      expect(holds(w)).toEqual([OP]);
      expect(reloaded.notices()).toEqual([
        notice(fault === "quota" ? "error" : fault, "counter"),
      ]);
      // And its explicit retry is the same as any other: the guarded write lands (the server is asked again after a reload).
      w.env.idb.clearInjections();
      w.script.push(w.status(410, { body: { code: "resync_required" } }));
      reloaded.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests).toHaveLength(2);
      expect(w.sync().cache_status).toBe("invalid");
      expect(durable(w)).toEqual({ streaks: {}, markers: [] });
      expect(holds(w)).toEqual([]);
      expect(reloaded.gate()).toBe("refreshing");
      finish(reloaded);
      w.engine.stop();
    });

  for (const fault of ["abort", "error", "quota"] as const)
    test(`${fault}, recorded nowhere durable: a follower and a reload cannot know (the disclosed limitation), but this tab hides the cache until it is written`, async () => {
      const { w, leader } = await arrange(fault, "memory");
      silentlyOffline(w);
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(60_000);
      expect(leader.gate()).toBe("refreshing");
      const follower = await controllerProbe(w, { leader: false });
      expect(follower.gate()).toBe("open");
      finish(follower, leader);
      w.engine.stop();
    });
});

describe("a first admission that the persistence hold cannot verify is held too", () => {
  test("hidden for ten minutes with ONE request (the server is not asked again), nothing counted or recorded durably, written when the hold can verify, recovery once", async () => {
    const { w, requested } = await build();
    const leader = await controllerProbe(w, { leader: true });
    w.gate.mode = "unavailable";
    for (let i = 0; i < 30; i += 1) w.script.push(w.status(410));
    w.start();
    await w.settle();
    await w.advance(600_000);
    expect(leader.gate()).toBe("refreshing");
    expect(holds(w)).toEqual([OP]);
    expect(w.requests).toHaveLength(1);
    expect(w.sync().cache_status).toBe("valid");
    expect(durable(w)).toEqual({ streaks: {}, markers: [] });
    expect(leader.notices()).toEqual([]);
    expect(w.rows("drafts")).toHaveLength(1);
    // A second tab can only see what is durable, and nothing is: the disclosed limitation of a hold that is in memory alone.
    const follower = await controllerProbe(w, { leader: false });
    expect(follower.gate()).toBe("open");
    w.gate.mode = "held";
    await w.advance(120_000);
    expect(w.sync().cache_status).toBe("invalid");
    expect(requested).toEqual(["resync_required"]);
    expect(holds(w)).toEqual([]);
    expect(leader.gate()).toBe("refreshing");
    expect(w.requests).toHaveLength(1);
    finish(leader, follower);
    w.engine.stop();
  });
});

describe("the retry's own bound is the bound of every local write", () => {
  test("a persistent fault: BOUND attempts, then the stop and its notice; every wake sends nothing; the next retry is another BOUND; the record only ever grows", async () => {
    const { w, requested } = await build();
    const leader = await controllerProbe(w, { leader: true });
    const attempts = countAttempts(w);
    failInvalidation(w, "error");
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(attempts()).toBe(BOUND);
    expect(durable(w).streaks).toEqual({ [OP]: BOUND });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      leader.ui.actions.retryUpdates();
      await w.settle();
      await w.advance(60_000);
      expect(attempts()).toBe(BOUND * (cycle + 1));
      expect(w.state()).toMatchObject({
        kind: "stopped",
        cause: "local_storage",
        invalidating: true,
      });
      expect(leader.gate()).toBe("refreshing");
      expect(leader.notices()).toEqual([
        { kind: "page_not_saved", memoryOnly: false },
      ]);
      // Never erased on the way: the streak keeps counting.
      expect(durable(w).streaks[OP]).toBe(BOUND * (cycle + 1));
      for (const wake of [
        () => w.fire(),
        () => w.goOnline(),
        () => w.engine.nudge("receipt"),
        () => w.engine.nudge("now"),
      ]) {
        wake();
        await w.settle();
        await w.advance(60_000);
      }
      expect(attempts()).toBe(BOUND * (cycle + 1));
    }
    expect(w.requests).toHaveLength(1);
    expect(requested).toEqual([]);
    finish(leader);
    w.engine.stop();
  });

  test("a stop and a start of the engine end the retry's cycle and keep the hold: the stop stands until the next retry, and nothing is sent", async () => {
    const { w } = await build();
    const leader = await controllerProbe(w, { leader: true });
    const attempts = countAttempts(w);
    failInvalidation(w, "error");
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(attempts()).toBe(BOUND);
    // The retry lifts the stop and its cycle is paused by connectivity, with attempts to spare...
    silentlyOffline(w);
    leader.ui.actions.retryUpdates();
    await w.settle();
    expect(w.state()).toMatchObject({ kind: "waiting", reason: "offline" });
    // ...and an ownership change in a tab that stays alive ends it.
    w.engine.stop();
    w.online = true;
    w.start();
    await w.settle();
    await w.advance(60_000);
    expect(attempts()).toBe(BOUND);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({ kind: "stopped", invalidating: true });
    expect(holds(w)).toEqual([OP]);
    expect(leader.gate()).toBe("refreshing");
    finish(leader);
    w.engine.stop();
  });

  test("a transient fault is retried within the bound without a hold left behind: one GET, written, recovery asked once", async () => {
    for (const times of [1, BOUND - 1]) {
      const { w, requested } = await build();
      const leader = await controllerProbe(w, { leader: true });
      failInvalidation(w, "error", times);
      w.script.push(w.status(410));
      w.start();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests).toHaveLength(1);
      expect(requested).toEqual(["resync_required"]);
      expect(w.sync().cache_status).toBe("invalid");
      expect(holds(w)).toEqual([]);
      expect(durable(w)).toEqual({ streaks: {}, markers: [] });
      expect(leader.gate()).toBe("refreshing");
      expect(leader.notices()).toEqual([]);
      finish(leader);
      w.engine.stop();
    }
  });

  test("the control with no fault at all: written at once, no hold ever, the gate refreshing and nothing to report", async () => {
    const { w, requested } = await build();
    const leader = await controllerProbe(w, { leader: true });
    const seen: string[][] = [];
    const off = w.engine.invalidations.subscribe(() => seen.push(holds(w)));
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(seen).toEqual([]);
    expect(requested).toEqual(["resync_required"]);
    expect(w.sync().cache_status).toBe("invalid");
    expect(leader.gate()).toBe("refreshing");
    expect(leader.notices()).toEqual([]);
    off();
    finish(leader);
    w.engine.stop();
  });
});

describe("a stale invalidating response cannot hide a newer valid cache", () => {
  /** The first write fails and the page goes offline before the retry, so the hold is outstanding and the position has not been looked at. */
  const stage = async () => {
    const { w, requested } = await build();
    const leader = await controllerProbe(w, { leader: true });
    w.env.idb.inject({
      match: (tx) => {
        if (tx.label !== "data.invalidateCache") return false;
        w.online = false;
        return true;
      },
      mode: "error",
      times: 1,
    });
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.sync().cache_status).toBe("valid");
    expect(holds(w)).toEqual([OP]);
    expect(leader.gate()).toBe("refreshing");
    return { w, requested, leader };
  };

  test("the position moved on (another page committed): the engine's own claim stands until it has looked, then the hold is dropped and the cache is open", async () => {
    const { w, requested, leader } = await stage();
    // Another page's commit moved the position and cleared the streak it left at the old one.
    w.setSync({ cursor: "cursor-9", local_write_streaks: {} });
    const fresh = await controllerProbe(w, { leader: true });
    // The running engine still reports its hold (it is offline and has not looked at the position): hidden, the safe side.
    expect(holds(w)).toEqual([OP]);
    expect(fresh.gate()).toBe("refreshing");
    fresh.online();
    await w.settle();
    await w.advance(1_000);
    // It has looked: the hold belonged to a position the cache is no longer at, and is forgotten.
    expect(holds(w)).toEqual([]);
    expect(w.sync().cache_status).toBe("valid");
    expect(requested).toEqual([]);
    expect(fresh.gate()).toBe("open");
    expect(fresh.notices()).toEqual([]);
    finish(leader, fresh);
    w.engine.stop();
  });

  test("the recovery generation moved on: the retained write is dropped and nothing is hidden", async () => {
    const { w, requested, leader } = await stage();
    w.setSync({ recovery_generation: w.sync().recovery_generation + 1 });
    leader.online();
    await w.settle();
    await w.advance(1_000);
    expect(holds(w)).toEqual([]);
    expect(w.sync().cache_status).toBe("valid");
    expect(requested).toEqual([]);
    // The durable streak at this position was the failure's: the superseded generation's, now moot.
    const fresh = await controllerProbe(w, { leader: true });
    expect(fresh.gate()).toBe("open");
    finish(leader, fresh);
    w.engine.stop();
  });

  test("another page has already written the invalidation: not written twice, recovery not asked for twice, the cache hidden by the database", async () => {
    const { w, requested, leader } = await stage();
    w.setSync({
      cache_status: "invalid",
      cursor: null,
      recovery_generation: w.sync().recovery_generation + 1,
    });
    leader.online();
    await w.settle();
    await w.advance(1_000);
    expect(holds(w)).toEqual([]);
    expect(requested).toEqual([]);
    expect(w.requests).toHaveLength(1);
    const fresh = await controllerProbe(w, { leader: true });
    expect(fresh.gate()).toBe("refreshing");
    finish(leader, fresh);
    w.engine.stop();
  });

  test("the identity moved on: the retained write is not applied under the older stamp; the cache stays hidden until the server answers again, and its answer settles it", async () => {
    // Two ways to wake the engine: the browser's `online` event (which is several wakes: the event itself, the controller's and the
    // subscription's) and ONE notification that finds connectivity back (a single wake, which starts the step and nothing more).
    // Revision 10 (R22): a wake that arrives while a step runs is honoured, so with the first an engine that APPLIED the older stamp
    // (and had it refused, which parks it) is rescued by the wake that arrived during that step; only the second leaves nothing to
    // rescue it, and shows that the stamp was let go rather than applied.
    for (const trigger of ["online event", "one notification"] as const)
      for (const answer of ["gone", "page"] as const) {
        const label = `${trigger} / ${answer}`;
        const { w, requested, leader } = await stage();
        w.identity.move({ account: w.service.account, epoch: 2 });
        w.script.push(
          answer === "gone" ? w.status(410) : w.emptyPage("cursor-5"),
        );
        if (trigger === "online event") leader.online();
        else {
          w.online = true;
          w.fire();
        }
        await w.settle();
        await w.advance(10_000);
        // The write stamped with the earlier epoch was refused; the hold stood meanwhile, and the new epoch asked again.
        if (answer === "gone") {
          expect(w.requests, label).toHaveLength(2);
          expect(requested, label).toEqual(["resync_required"]);
          expect(w.sync().cache_status, label).toBe("invalid");
          expect(leader.gate(), label).toBe("refreshing");
        } else {
          // The server now answers the same position with a page: an admitted state change that supersedes the hold.
          expect(w.requests, label).toHaveLength(2);
          expect(requested, label).toEqual([]);
          expect(w.sync().cache_status, label).toBe("valid");
          expect(w.sync().cursor, label).toBe("cursor-5");
          expect(leader.gate(), label).toBe("open");
        }
        expect(holds(w), label).toEqual([]);
        finish(leader);
        w.engine.stop();
      }
  });
});

describe("what the hold is keyed by", () => {
  test("a hold of another account, another incarnation or another position hides nothing here", async () => {
    const { w } = await build();
    const probe = await controllerProbe(w, { leader: false });
    // The controller's key: this account, this database's incarnation, this position's operation. None of these holds is it.
    const foreign: ReadonlyArray<InvalidationHold> = [
      {
        account: "22222222-2222-4222-8222-222222222222",
        incarnationId: w.service.incarnationId,
        operation: OP,
      },
      {
        account: w.service.account,
        incarnationId: "another-incarnation",
        operation: OP,
      },
      {
        account: w.service.account,
        incarnationId: w.service.incarnationId,
        operation: invalidateOperation("cursor-1"),
      },
    ];
    const engine = {
      state: w.engine.state,
      invalidations: { get: () => foreign, subscribe: () => () => undefined },
      retryNow: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      nudge: () => undefined,
      settled: async () => undefined,
    } as unknown as SyncEngine;
    const off = probe.ui.attachLeader({ engine });
    expect(probe.gate()).toBe("open");
    // The control: the same hold with the right key hides it.
    off();
    const right = {
      ...engine,
      invalidations: {
        get: () => [
          {
            account: w.service.account,
            incarnationId: w.service.incarnationId,
            operation: OP,
          },
        ],
        subscribe: () => () => undefined,
      },
    } as unknown as SyncEngine;
    probe.ui.attachLeader({ engine: right });
    expect(probe.gate()).toBe("refreshing");
    finish(probe);
  });

  test("a leader that detaches takes nothing with it: what this tab held stays held for exactly its position, and no longer", async () => {
    const { w } = await build();
    const probe = await controllerProbe(w, { leader: false });
    const off = probe.ui.attachLeader({
      engine: w.engine,
      recovery: w.recovery,
    });
    failInvalidation(w, "error");
    failCounter(w);
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(holds(w)).toEqual([OP]);
    expect(probe.gate()).toBe("refreshing");
    // The leader goes (leadership lost): nothing is durable, the engine's memory was all that held the failure.
    off();
    expect(probe.ui.inputs.get().engine).toBeNull();
    expect(probe.gate()).toBe("refreshing");
    // The position moves on (another page's commit): that is a different cache, and the carried hold does not hide it.
    w.setSync({ cursor: "cursor-9", local_write_streaks: {} });
    await probe.ui.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await w.settle();
    expect(probe.gate()).toBe("open");
    finish(probe);
    w.engine.stop();
  });
});

/**
 * R30 (revision 14): the detach function `attachLeader` returns belongs to the attachment that made it. A leader that was replaced
 * has a disposer that may still run, late or again; it used to cut the replacement's subscriptions (engine state, invalidations,
 * outbox, recovery), so a `410` that the replacement admitted while every write of its invalidation failed left the gate `open` over
 * a cache the server had called invalid. The reviewer's schedule, over the PRODUCTION controller, engine and store plans.
 */
describe("R30: a replaced leader's detach function cannot disconnect the leader that replaced it", () => {
  for (const cleanup of ["none", "late", "twice"] as const)
    test(`a 410 admitted by the replacement keeps the cache hidden (the replaced leader's disposer: ${cleanup})`, async () => {
      const { w } = await build();
      const probe = await controllerProbe(w, { leader: false });
      const detachOld = probe.ui.attachLeader({
        engine: w.engine,
        recovery: w.recovery,
      });
      // "twice": the disposer has already run once, as it may, before the replacement attaches.
      if (cleanup === "twice") detachOld();
      w.reload();
      const detachNew = probe.ui.attachLeader({
        engine: w.engine,
        recovery: w.recovery,
      });
      // The obsolete disposer, after the replacement attached: late, or a second time.
      if (cleanup !== "none") detachOld();
      expect(probe.gate()).toBe("open");
      // The write of the invalidation fails everywhere (the transaction, its counter, the fallback marker): the engine's memory alone
      // holds what the server said, and the gate follows the engine's invalidations store.
      failInvalidation(w, "error");
      failCounter(w);
      w.markerStorage.failWrites = true;
      w.script.push(w.status(410, { body: { code: "resync_required" } }));
      w.start();
      await w.settle();
      expect(w.state()).toMatchObject({ kind: "stopped", invalidating: true });
      expect(holds(w)).toEqual([OP]);
      expect(probe.gate()).toBe("refreshing");
      expect(w.sync().cache_status).toBe("valid");
      // The replacement's own disposer still detaches it, once: the hold it admitted is carried, and keeps hiding that position.
      detachNew();
      expect(probe.ui.inputs.get().engine).toBeNull();
      expect(probe.gate()).toBe("refreshing");
      detachNew();
      expect(probe.gate()).toBe("refreshing");
      w.engine.stop();
      probe.dispose();
    });

  test("the control: with no replacement, the one disposer detaches the leader and the gate still follows what the controller carried", async () => {
    const { w } = await build();
    const probe = await controllerProbe(w, { leader: false });
    const detach = probe.ui.attachLeader({
      engine: w.engine,
      recovery: w.recovery,
    });
    failInvalidation(w, "error");
    failCounter(w);
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410, { body: { code: "resync_required" } }));
    w.start();
    await w.settle();
    expect(probe.gate()).toBe("refreshing");
    detach();
    detach();
    expect(probe.ui.inputs.get().engine).toBeNull();
    expect(probe.gate()).toBe("refreshing");
    w.engine.stop();
    probe.dispose();
  });
});

/**
 * R31 (revision 15): `dispose()` and `start()` of the SAME controller are a reversible pair (R29), and the invalidation a detached
 * leader admitted (every write of it failed: the transaction, its counter and the fallback marker) was held by the controller alone.
 * `dispose(); start()` used to clear it, so the same account, incarnation and position was exposed as `open` with no recovery and no
 * newer cache. The reviewer's schedule over the PRODUCTION controller, engine and plans, in every order of detach and restart, with
 * the controls that must not change: a leader that stays attached, and a cache nothing has invalidated.
 */
describe("R31: a restart of the controller keeps the invalidation a detached leader admitted", () => {
  /** A valid cache, a follower-style controller with the leader attached, and a `410` whose every durable record fails. */
  async function admitted() {
    const { w } = await build();
    const probe = await controllerProbe(w, { leader: false });
    const detach = probe.ui.attachLeader({
      engine: w.engine,
      recovery: w.recovery,
    });
    expect(probe.gate()).toBe("open");
    failInvalidation(w, "error");
    failCounter(w);
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410, { body: { code: "resync_required" } }));
    w.start();
    await w.settle();
    expect(holds(w)).toEqual([OP]);
    expect(probe.gate()).toBe("refreshing");
    // The engine's memory alone holds what the server said: the database still calls the cache valid.
    expect(w.sync().cache_status).toBe("valid");
    expect(durable(w)).toEqual({ streaks: {}, markers: [] });
    return { w, probe, detach };
  }
  const restart = async (
    w: World,
    probe: { ui: { dispose(): void; start(): void } },
  ) => {
    probe.ui.dispose();
    probe.ui.start();
    await w.settle();
  };

  for (const order of [
    "the leader detaches, then the controller restarts",
    "the controller restarts, then the leader detaches",
    "the leader stays attached through the restart",
  ] as const)
    for (const restarts of [1, 3])
      test(`${order} (${restarts} restart(s)): the gate stays refreshing and the database is untouched`, async () => {
        const { w, probe, detach } = await admitted();
        if (order.startsWith("the leader detaches")) detach();
        for (let i = 0; i < restarts; i += 1) {
          await restart(w, probe);
          expect(probe.gate()).toBe("refreshing");
        }
        if (order.startsWith("the controller restarts")) {
          detach();
          expect(probe.gate()).toBe("refreshing");
          await restart(w, probe);
        }
        expect(probe.gate()).toBe("refreshing");
        // Nothing was written by the restart, and nothing was asked of the server again.
        expect(w.sync().cache_status).toBe("valid");
        expect(w.requests).toHaveLength(1);
        detach();
        w.engine.stop();
        probe.dispose();
      });

  test("a leader that was replaced, then a restart: the replaced engine's hold is carried and keeps hiding its position", async () => {
    const { w, probe } = await admitted();
    // The first engine's page reloads: a new engine is the leader, and the old one's admitted invalidation is handed on.
    w.engine.stop();
    w.reload();
    const detachNew = probe.ui.attachLeader({
      engine: w.engine,
      recovery: w.recovery,
    });
    expect(holds(w)).toEqual([]);
    expect(probe.gate()).toBe("refreshing");
    await restart(w, probe);
    expect(probe.gate()).toBe("refreshing");
    detachNew();
    await restart(w, probe);
    expect(probe.gate()).toBe("refreshing");
    probe.dispose();
  });

  test("the position moving on while the controller is stopped is another cache: the restart exposes it, and the old hold hides nothing of it", async () => {
    const { w, probe, detach } = await admitted();
    detach();
    probe.ui.dispose();
    w.setSync({ cursor: "cursor-9", local_write_streaks: {} });
    probe.ui.start();
    await w.settle();
    expect(probe.gate()).toBe("open");
    probe.dispose();
    w.engine.stop();
  });

  test("the hold ends with its cache: the invalidation recorded and the cache replaced, a restart exposes the recovered cache", async () => {
    const { w, probe, detach } = await admitted();
    detach();
    await restart(w, probe);
    expect(probe.gate()).toBe("refreshing");
    // Another page wrote the invalidation (the durable state speaks) and recovery then replaced the cache, at a position the old hold
    // never named: after the restart nothing the controller carried can hide it.
    w.setSync({ cache_status: "invalid" });
    await restart(w, probe);
    expect(probe.gate()).toBe("refreshing");
    w.setSync({
      cache_status: "valid",
      cursor: "cursor-5",
      local_write_streaks: {},
    });
    await restart(w, probe);
    expect(probe.gate()).toBe("open");
    probe.dispose();
    w.engine.stop();
  });

  test("the control: with the fallback marker saved, a restart (and a reload) keeps it hidden from the marker, as before", async () => {
    const { w } = await build();
    const probe = await controllerProbe(w, { leader: false });
    const detach = probe.ui.attachLeader({
      engine: w.engine,
      recovery: w.recovery,
    });
    failInvalidation(w, "error");
    failCounter(w);
    w.script.push(w.status(410, { body: { code: "resync_required" } }));
    w.start();
    await w.settle();
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([OP]);
    detach();
    await restart(w, probe);
    expect(probe.gate()).toBe("refreshing");
    // A reload: a new controller over the same database and markers, nothing of the old one's memory.
    const reloaded = await controllerProbe(w, { leader: false });
    expect(reloaded.gate()).toBe("refreshing");
    reloaded.dispose();
    probe.dispose();
    w.engine.stop();
  });

  test("the control: a cache nothing has invalidated stays open through the same restarts", async () => {
    const { w } = await build();
    const probe = await controllerProbe(w, { leader: false });
    const detach = probe.ui.attachLeader({
      engine: w.engine,
      recovery: w.recovery,
    });
    detach();
    await restart(w, probe);
    expect(probe.gate()).toBe("open");
    await restart(w, probe);
    expect(probe.gate()).toBe("open");
    probe.dispose();
    w.engine.stop();
  });
});

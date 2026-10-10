// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { RecoverySeam } from "../../src/data/engine/recovery-seam";
import { DATA_CONFIG } from "../../src/data/model/config";
import { invalidateOperation } from "../../src/data/model/retry";
import {
  deriveGate,
  deriveNotices,
  type StatusInputs,
} from "../../src/data/model/status";
import { readSyncFacts } from "../../src/data/plans/facts";
import {
  CAPTURE_OPERATION,
  captureRequest,
} from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import { scopeOf } from "../support/data/marker-storage";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R10 (revision 8): a failed WRITE of an admitted invalidation no longer leaves the cache displayable and the engine quiet.
 *
 * After `410 resync_required` the engine committed `invalidateRecoveryPosition`; when that local transaction failed it returned
 * `{when: "event"}` with no failure state, no retry and no recovery request, the rollback left `cache_status: "valid"`, `deriveGate` said
 * `open`, and ten minutes later there was one GET, an open gate and no notice (the third review's three probes: abort, error, quota).
 *
 * Now the invalidation is RETAINED with the stamp it was admitted under and its write is retried under its own operation identity
 * (`invalidate:<cursor>`): the bounded rule of every local write (three consecutive durable failures stop it, at once when the counter
 * cannot be written, a quota failure at once and not counted), and the cache is hidden for as long as the write is outstanding: by the
 * stop itself (`invalidating`), by its durable streak at the current position, by its fallback marker, or by this tab's memory. The
 * plan's guards still admit the retry only for the position, generation and epoch it was admitted at.
 *
 * These run the PRODUCTION engine, plans and guards over the double of IndexedDB; the network is a script and time is fake. FIXTURE
 * evidence: a named injected transaction fault, not a native storage fault and not genuine quota exhaustion.
 */
type World = Awaited<ReturnType<typeof engineWorld>>;

const OP = invalidateOperation("cursor-0");
const BOUND = DATA_CONFIG.localWritePauseAfter;
const FAULTS = ["abort", "error", "quota"] as const;
const DEVICE = { cause: "local_storage", kind: "stopped" } as const;

function recovery(requested: string[]): RecoverySeam {
  return {
    registered: true,
    request: (reason) => {
      requested.push(reason);
    },
    active: { get: () => false, subscribe: () => () => undefined },
  };
}

const inputs = (w: World): StatusInputs => ({
  online: w.online,
  engine: w.state(),
  cache: w.sync().cache_status,
  recovery: { registered: true, active: false },
  lastSyncedAt: "2026-10-02T10:00:00.000Z",
  summary: null,
  outbox: null,
  storageNotResponding: false,
});

const failInvalidation = (
  w: World,
  mode: (typeof FAULTS)[number],
  times = 100,
) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.invalidateCache",
    mode,
    times,
  });

async function build(
  options: { requested?: string[]; cursor?: string } = {},
): Promise<World> {
  const requested = options.requested ?? [];
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
  return w;
}

const facts = async (w: World) =>
  w.service.store.run(readSyncFacts, {
    incarnationId: w.service.incarnationId,
  });

describe("the review's three probes, with the failure that persists: the cache is hidden, the notice is actionable, and nothing is silent", () => {
  for (const fault of FAULTS) {
    test(`${fault}: one GET, no recovery request, a hidden cache, a notice, drafts kept; ten minutes later it is the same`, async () => {
      const requested: string[] = [];
      const w = await build({ requested });
      failInvalidation(w, fault, 50);
      w.script.push(w.status(410, { body: { code: "resync_required" } }));
      w.start();
      await w.settle();
      await w.advance(600_000);
      expect(w.requests).toHaveLength(1);
      expect(requested).toEqual([]);
      // The database still says `valid`, because the write that would say otherwise is what failed. The cache is hidden anyway.
      expect(w.sync().cache_status).toBe("valid");
      expect(deriveGate(inputs(w))).toBe("refreshing");
      expect(w.state()).toMatchObject({
        kind: "stopped",
        invalidating: true,
        cause: fault === "quota" ? "storage_full" : "local_storage",
      });
      const notices = deriveNotices(inputs(w));
      expect(notices).toEqual([
        fault === "quota"
          ? { kind: "storage_full", cache: "invalid" }
          : { kind: "page_not_saved", memoryOnly: false },
      ]);
      expect(w.rows("drafts")).toHaveLength(1);
      expect(w.cache()).toHaveLength(1);
      expect(w.rows("pending_effects")).toHaveLength(1);
      w.engine.stop();
    });

    test(`${fault}: the stop is left only by the explicit retry, which writes the invalidation and asks for recovery, once`, async () => {
      const requested: string[] = [];
      const w = await build({ requested });
      failInvalidation(w, fault, 50);
      w.script.push(w.status(410));
      w.start();
      await w.settle();
      expect(w.state().kind).toBe("stopped");
      w.env.idb.clearInjections();
      w.engine.retryNow();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(requested).toEqual(["resync_required"]);
      expect(w.sync().cache_status).toBe("invalid");
      expect(w.sync().local_write_streaks).toEqual({});
      expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
      expect(deriveGate(inputs(w))).toBe("refreshing");
      expect(deriveNotices(inputs(w))).toEqual([]);
      expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
      // The overlay is gone with the invalidation; the draft is not.
      expect(
        (w.rows("pending_effects") as Array<{ display: unknown }>)[0]?.display,
      ).toBeNull();
      expect(w.rows("drafts")).toHaveLength(1);
      w.engine.stop();
    });
  }

  test("the successful invalidation control hides the retained cache and requests recovery, with no failure state", async () => {
    const requested: string[] = [];
    const w = await build({ requested });
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(deriveGate(inputs(w))).toBe("refreshing");
    expect(requested).toEqual(["resync_required"]);
    expect(deriveNotices(inputs(w))).toEqual([]);
    expect(w.sync().local_write_streaks).toEqual({});
    w.engine.stop();
  });
});

describe("a transient failure is retried within the bound, without a second request, and recovers", () => {
  for (const fault of ["abort", "error"] as const)
    for (const times of [1, BOUND - 1])
      test(`${fault} x${times}: the retained invalidation is written on the retry; one GET; recovery asked once; nothing left to report`, async () => {
        const requested: string[] = [];
        const w = await build({ requested });
        failInvalidation(w, fault, times);
        w.script.push(w.status(410));
        w.start();
        await w.settle();
        await w.advance(600_000);
        expect(w.requests).toHaveLength(1);
        expect(requested).toEqual(["resync_required"]);
        expect(w.sync().cache_status).toBe("invalid");
        expect(w.sync().local_write_streaks).toEqual({});
        expect(deriveGate(inputs(w))).toBe("refreshing");
        expect(deriveNotices(inputs(w))).toEqual([]);
        expect(w.state()).toEqual({
          kind: "waiting",
          reason: "cache_not_valid",
        });
        expect(w.rows("drafts")).toHaveLength(1);
        w.engine.stop();
      });

  test("a 422 on a sent cursor (a construction defect) is the same: retained, retried, recovered", async () => {
    const requested: string[] = [];
    const w = await build({ requested });
    failInvalidation(w, "error", 1);
    w.script.push(w.status(422));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(requested).toEqual(["construction_defect"]);
    expect(w.sync().cache_status).toBe("invalid");
  });
});

describe("while the write is outstanding the cache is hidden, whatever shows it", () => {
  test("a durable failure streak at the current position is a hidden cache for every reader of the facts (any tab, after a reload)", async () => {
    const w = await build();
    // The retry is held back (the page went offline at the first failure), so the streak is at rest at 1.
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
    expect(w.sync().local_write_streaks).toEqual({ [OP]: 1 });
    expect(w.sync().cache_status).toBe("valid");
    // The engine reports the hold on every state it shows, not only on the stop (R10, revision 9).
    expect(w.state()).toEqual({
      kind: "waiting",
      reason: "offline",
      invalidating: true,
    });
    expect(await facts(w)).toMatchObject({
      cacheStatus: "valid",
      invalidating: true,
      invalidateOperation: OP,
    });
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("the retry that follows a wake while offline-then-online writes the invalidation; a reload in between asks the server again and writes it too", async () => {
    for (const reload of [false, true]) {
      const requested: string[] = [];
      const w = await build({ requested });
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
      if (reload) {
        w.reload();
        w.script.push(w.status(410));
        w.start();
        await w.settle();
      }
      w.goOnline();
      await w.settle();
      await w.advance(60_000);
      expect(w.sync().cache_status).toBe("invalid");
      expect(requested).toEqual(["resync_required"]);
      // Retained in memory: no second request. After a reload the memory is gone and the server is asked again.
      expect(w.requests).toHaveLength(reload ? 2 : 1);
      expect(w.sync().local_write_streaks).toEqual({});
      w.engine.stop();
    }
  });

  test("a stop's fallback marker (the counter could not be written) hides the cache, survives a reload, and the first step after it sends nothing", async () => {
    const w = await build();
    failInvalidation(w, "error", 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ ...DEVICE, invalidating: true });
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.markers.has(scopeOf(w.service.account), OP)).toBe(true);
    expect(deriveGate(inputs(w))).toBe("refreshing");
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ ...DEVICE, invalidating: true });
    expect(deriveGate(inputs(w))).toBe("refreshing");
    w.engine.stop();
  });

  test("a stop only this tab holds (neither the counter nor the marker could be written) hides the cache and says it is memory-only", async () => {
    const w = await build();
    failInvalidation(w, "error", 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.state()).toEqual({
      ...DEVICE,
      memoryOnly: true,
      invalidating: true,
    });
    expect(deriveGate(inputs(w))).toBe("refreshing");
    expect(deriveNotices(inputs(w))).toEqual([
      { kind: "page_not_saved", memoryOnly: true },
    ]);
    // A wake does not lift it.
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({ kind: "stopped", invalidating: true });
    w.engine.stop();
  });

  test("the quota stop is recorded in the account's marker, survives a reload as a stop, and a wake does not change the notice", async () => {
    const w = await build();
    failInvalidation(w, "quota", 1);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.state()).toEqual({
      kind: "stopped",
      cause: "storage_full",
      invalidating: true,
    });
    expect(w.markers.has(scopeOf(w.service.account), OP)).toBe(true);
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({
      cause: "storage_full",
      invalidating: true,
    });
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ ...DEVICE, invalidating: true });
    expect(deriveGate(inputs(w))).toBe("refreshing");
    w.engine.stop();
  });
});

describe("every wake, however often and however long afterwards, leaves a stopped invalidation stopped", () => {
  const WAKES: ReadonlyArray<readonly [string, (w: World) => void]> = [
    ["a subscription wake", (w) => w.fire()],
    ["the browser coming online", (w) => w.goOnline()],
    ["a receipt nudge", (w) => w.engine.nudge("receipt")],
    ["an immediate nudge", (w) => w.engine.nudge("now")],
  ];
  for (const fault of ["error", "quota"] as const)
    for (const [name, signal] of WAKES)
      test(`${fault}: ${name} sends nothing, writes nothing and keeps the cache hidden`, async () => {
        const w = await build();
        failInvalidation(w, fault, 50);
        w.script.push(w.status(410));
        w.start();
        await w.settle();
        const streaks = JSON.stringify(w.sync().local_write_streaks);
        for (let i = 0; i < 3; i += 1) {
          signal(w);
          await w.settle();
          await w.advance(60_000);
        }
        expect(w.requests).toHaveLength(1);
        expect(w.state()).toMatchObject({
          kind: "stopped",
          invalidating: true,
        });
        expect(deriveGate(inputs(w))).toBe("refreshing");
        expect(JSON.stringify(w.sync().local_write_streaks)).toBe(streaks);
        expect(w.sync().cache_status).toBe("valid");
        w.engine.stop();
      });

  test("a stop and a start of the engine (an ownership change in a tab that stays alive) does not lift it", async () => {
    const w = await build();
    failInvalidation(w, "error", 50);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    w.engine.stop();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ ...DEVICE, invalidating: true });
  });
});

describe("a stale invalidating response cannot hide a newer valid cache", () => {
  const stage = async (requested: string[] = []) => {
    const w = await build({ requested });
    // Held back after the first failure, so the invalidation is retained and its write has not been retried.
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
    expect(w.state()).toEqual({
      kind: "waiting",
      reason: "offline",
      invalidating: true,
    });
    return w;
  };

  test("the position moved on (another page committed): the retained write is DROPPED, the cache stays valid and visible, and sync resumes", async () => {
    const requested: string[] = [];
    const w = await stage(requested);
    w.setSync({ cursor: "cursor-9" });
    w.goOnline();
    await w.settle();
    await w.advance(1_000);
    expect(w.sync().cache_status).toBe("valid");
    expect(w.sync().cursor).not.toBeNull();
    expect(requested).toEqual([]);
    expect(deriveGate(inputs(w))).toBe("open");
    expect(deriveNotices(inputs(w))).toEqual([]);
    // The failure's streak belonged to the old position; at the new one there is nothing to hide.
    expect(await facts(w)).toMatchObject({ invalidating: false });
    w.engine.stop();
  });

  test("the recovery generation moved on: the retained write is dropped, nothing is hidden", async () => {
    const requested: string[] = [];
    const w = await stage(requested);
    w.setSync({ recovery_generation: w.sync().recovery_generation + 1 });
    w.goOnline();
    await w.settle();
    await w.advance(1_000);
    expect(w.sync().cache_status).toBe("valid");
    expect(requested).toEqual([]);
    expect(deriveGate(inputs(w))).toBe("open");
    w.engine.stop();
  });

  test("another page has already written the invalidation: the retained one is not written twice, and recovery is not asked for twice", async () => {
    const requested: string[] = [];
    const w = await stage(requested);
    w.setSync({
      cache_status: "invalid",
      cursor: null,
      recovery_generation: w.sync().recovery_generation + 1,
    });
    w.goOnline();
    await w.settle();
    await w.advance(1_000);
    expect(w.sync().cache_status).toBe("invalid");
    expect(requested).toEqual([]);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    w.engine.stop();
  });

  test("the identity moved on: the retained write is not applied for the newer identity, and nothing is hidden by it", async () => {
    const requested: string[] = [];
    const w = await stage(requested);
    w.identity.move({ account: w.service.account, epoch: 2 });
    w.goOnline();
    await w.settle();
    await w.advance(1_000);
    expect(w.sync().cache_status).toBe("valid");
    expect(requested).toEqual([]);
    w.engine.stop();
  });
});

describe("the bounded rule is the one of every local write", () => {
  test("two consecutive failures do not stop it; a third does; the streak is the invalidation's own", async () => {
    const w = await build();
    failInvalidation(w, "error", BOUND - 1);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.state().kind).not.toBe("stopped");
    const w2 = await build();
    failInvalidation(w2, "error", BOUND);
    w2.script.push(w2.status(410));
    w2.start();
    await w2.settle();
    expect(w2.state()).toEqual({ ...DEVICE, invalidating: true });
    expect(w2.sync().local_write_streaks).toEqual({ [OP]: BOUND });
    w.engine.stop();
    w2.engine.stop();
  });

  test("the sizing ladder is not moved: no page was applied", async () => {
    const w = await build();
    // Classified already, so the first capture's one-time classification is not a difference.
    w.setSync({ sizing: { ...w.sync().sizing, class: "unknown" } });
    const before = JSON.stringify(w.sync().sizing);
    failInvalidation(w, "error", BOUND);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ ...DEVICE, invalidating: true });
    expect(JSON.stringify(w.sync().sizing)).toBe(before);
    w.engine.stop();
  });

  test("a stop of the invalidation does not stop another operation, and another operation's streak does not stop it", async () => {
    const w = await build();
    w.setSync({ local_write_streaks: { "page:other": BOUND } });
    // `page:other` is not the current position's operation: it stops nothing here, and the invalidation proceeds.
    failInvalidation(w, "error", 1);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.sync().cache_status).toBe("invalid");
    expect(w.sync().local_write_streaks).toEqual({ "page:other": BOUND });
    w.engine.stop();
  });

  test("a page that commits at the position clears the invalidation's streak at it", async () => {
    const w = await build();
    w.setSync({ local_write_streaks: { [OP]: 1 } });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.sync().cursor).toBe("cursor-1");
    expect(w.sync().local_write_streaks).toEqual({});
  });
});

/**
 * R10 (revision 9): what hides the cache is the HOLD, not the counter, the marker or the engine's state. The fourth review showed an
 * offline wake and an explicit retry forgetting the only record there was, with the database still saying `valid`. These are the engine's
 * side of it (the controller's is `controller-invalidation-hold.test.ts`): the hold's lifecycle, a retry that lifts the stop without
 * erasing anything, the retry's own bound for every kind of record, and a reload that adopts what it finds.
 */
describe("the hold: from the first failed write until the guarded write succeeds or the position is superseded", () => {
  const held = (w: World) =>
    w.engine.invalidations.get().map((h) => h.operation);
  const record = (w: World) => ({
    streaks: { ...w.sync().local_write_streaks },
    markers: w.markers.operations(scopeOf(w.service.account)),
  });
  /** Counts the attempts to write the invalidation. Arm it BEFORE the fault: the double stops at the first rule that matches. */
  const countAttempts = (w: World): (() => number) => {
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
  };
  const failCounter = (w: World) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 100,
    });

  test("it exists from the first failure, even when the retry that follows recovers: [held], then nothing", async () => {
    const w = await build();
    const seen: string[][] = [];
    w.engine.invalidations.subscribe(() => seen.push(held(w)));
    failInvalidation(w, "error", 1);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(seen).toEqual([[OP], []]);
    expect(held(w)).toEqual([]);
    w.engine.stop();
  });

  test("the state says so from the instant the hold is added and stops saying so when it ends, without waiting for the next transition", async () => {
    const w = await build();
    const states: Array<{ kind: string; invalidating?: true }> = [];
    w.engine.state.subscribe(() => states.push(w.state()));
    failInvalidation(w, "error", 1);
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    const kinds = states.map(
      (state) => `${state.kind}${state.invalidating ? "+hold" : ""}`,
    );
    // The step that was running when the write failed is reported as holding, then as not holding once the retry has written it.
    const added = kinds.indexOf("running+hold");
    expect(added).toBeGreaterThan(-1);
    expect(kinds.indexOf("running", added)).toBeGreaterThan(added);
    expect(kinds[kinds.length - 1]).toBe("waiting");
    w.engine.stop();
  });

  test("it is held through an offline wake, a wake online, every nudge, an explicit retry in flight and a stop and start; the state reports it on each", async () => {
    const w = await build();
    failInvalidation(w, "error");
    failCounter(w);
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(held(w)).toEqual([OP]);
    const states: unknown[] = [];
    w.engine.state.subscribe(() => states.push(w.state()));
    // The retry reaches a stopped engine (connectivity is lost, no wake yet), lifts the stop and finds nothing to attempt it with.
    w.online = false;
    w.engine.retryNow();
    await w.settle();
    w.fire();
    await w.settle();
    w.engine.nudge("now");
    await w.settle();
    w.engine.nudge("receipt");
    await w.advance(60_000);
    w.engine.stop();
    w.online = true;
    w.start();
    await w.settle();
    expect(held(w)).toEqual([OP]);
    // Every state the engine showed while it held the invalidation, but the `not_started` of no engine at all, said so.
    for (const state of states as Array<{ kind: string; invalidating?: true }>)
      if (state.kind !== "not_started") expect(state.invalidating).toBe(true);
    expect(states.length).toBeGreaterThan(2);
    w.engine.stop();
  });

  test("an explicit retry lifts the stop and erases NOTHING: the streak, the marker and the memory stop stand until the write lands", async () => {
    for (const record_ of ["counter", "marker", "memory"] as const) {
      const w = await build();
      failInvalidation(w, "error");
      if (record_ !== "counter") failCounter(w);
      if (record_ === "memory") w.markerStorage.failWrites = true;
      w.script.push(w.status(410));
      w.start();
      await w.settle();
      const before = record(w);
      // The retry's connectivity goes before its first attempt, so nothing but the retry itself has happened.
      w.online = false;
      w.engine.retryNow();
      await w.settle();
      await w.advance(60_000);
      expect(record(w)).toEqual(before);
      expect(held(w)).toEqual([OP]);
      expect(w.sync().cache_status).toBe("valid");
      // Back online with the fault gone: the retained write lands, and only now does every record go.
      w.env.idb.clearInjections();
      w.goOnline();
      await w.settle();
      await w.advance(60_000);
      expect(w.sync().cache_status).toBe("invalid");
      expect(record(w)).toEqual({ streaks: {}, markers: [] });
      expect(held(w)).toEqual([]);
      expect(w.requests).toHaveLength(1);
      w.engine.stop();
    }
  });

  test("a retry's cycle has the bound of every local write, whatever recorded the failure: one attempt when the counter cannot be written or the failure is a quota, BOUND when it can; no wake adds one", async () => {
    const cases: Array<
      [string, "abort" | "error" | "quota", "counter" | "marker", number]
    > = [
      ["a counted failure", "error", "counter", BOUND],
      ["a failure whose counter cannot be written", "error", "marker", 1],
      ["a quota failure (never counted)", "quota", "marker", 1],
    ];
    for (const [name, fault, how, perCycle] of cases) {
      const w = await build();
      const attempts = countAttempts(w);
      failInvalidation(w, fault);
      if (how === "marker" && fault !== "quota") failCounter(w);
      w.script.push(w.status(410));
      w.start();
      await w.settle();
      expect(attempts(), `${name}: the first cycle`).toBe(perCycle);
      for (let cycle = 2; cycle <= 3; cycle += 1) {
        w.engine.retryNow();
        await w.settle();
        await w.advance(60_000);
        expect(attempts(), `${name}: cycle ${cycle}`).toBe(perCycle * cycle);
        expect(w.state()).toMatchObject({
          kind: "stopped",
          invalidating: true,
        });
        for (const wake of [
          () => w.fire(),
          () => w.goOnline(),
          () => w.engine.nudge("now"),
        ]) {
          wake();
          await w.settle();
          await w.advance(60_000);
        }
        expect(attempts(), `${name}: wakes add none`).toBe(perCycle * cycle);
      }
      expect(w.requests).toHaveLength(1);
      expect(held(w)).toEqual([OP]);
      w.engine.stop();
    }
  });

  test("a FIRST admission whose commit cannot be verified (the persistence hold is unavailable) is retained and held too: one GET, a hidden cache, paced asks, written when it can, recovery once", async () => {
    const requested: string[] = [];
    const w = await build({ requested });
    w.gate.mode = "unavailable";
    // Were the server asked again each time (as it was), these would be answered too.
    for (let i = 0; i < 30; i += 1) w.script.push(w.status(410));
    w.start();
    await w.settle();
    await w.advance(600_000);
    expect(w.requests).toHaveLength(1);
    expect(held(w)).toEqual([OP]);
    expect(w.state()).toMatchObject({ invalidating: true });
    expect(deriveGate(inputs(w))).toBe("refreshing");
    // Never counted as a failure: no streak, no marker, no stop; the database still says `valid`.
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
    expect(w.sync().cache_status).toBe("valid");
    const asks = w.gate.requests.filter((r) => r.answer === "unavailable");
    expect(asks.length).toBeGreaterThan(1);
    expect(asks.length).toBeLessThan(40);
    expect(requested).toEqual([]);
    expect(w.rows("drafts")).toHaveLength(1);
    // The hold can verify again: the retained write lands, with no second request.
    w.gate.mode = "held";
    await w.advance(120_000);
    expect(w.sync().cache_status).toBe("invalid");
    expect(requested).toEqual(["resync_required"]);
    expect(held(w)).toEqual([]);
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("a first admission that could not be verified, with the identity moved to a newer epoch meanwhile: the stamp is let go, the server is asked again under the current one, and the hold stands until its answer settles it", async () => {
    const requested: string[] = [];
    const w = await build({ requested });
    w.gate.mode = "unavailable";
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    await w.advance(5_000);
    expect(held(w)).toEqual([OP]);
    w.identity.move({ account: w.service.account, epoch: 2 });
    w.gate.mode = "held";
    w.script.push(w.status(410));
    w.fire();
    await w.settle();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(2);
    expect(requested).toEqual(["resync_required"]);
    expect(w.sync().cache_status).toBe("invalid");
    expect(held(w)).toEqual([]);
    w.engine.stop();
  });

  test("a reload adopts the stop it finds as a hold, so an offline wake after it keeps reporting it; the position moving on then drops it", async () => {
    const w = await build();
    failInvalidation(w, "error");
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(w.sync().local_write_streaks).toEqual({ [OP]: BOUND });
    w.reload();
    // The new engine knows nothing: until it looks, nothing is held in its memory.
    expect(held(w)).toEqual([]);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ ...DEVICE, invalidating: true });
    expect(held(w)).toEqual([OP]);
    w.online = false;
    w.fire();
    await w.settle();
    expect(w.state()).toEqual({
      kind: "waiting",
      reason: "offline",
      invalidating: true,
    });
    // Another page's commit moved the position and cleared the streak it left: the next look at the cache forgets the hold, and the
    // state stops saying so.
    w.setSync({ cursor: "cursor-9", local_write_streaks: {} });
    w.goOnline();
    await w.settle();
    await w.advance(1_000);
    expect(held(w)).toEqual([]);
    expect(w.state()).not.toHaveProperty("invalidating");
    w.engine.stop();
  });

  test("a hold is not ended by a gate that says nothing about the cache (a wipe's `closing`): what is hidden stays hidden", async () => {
    const w = await build();
    failInvalidation(w, "error");
    failCounter(w);
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(held(w)).toEqual([OP]);
    w.setSync({ draft_fence: { closing: true } as never });
    w.fire();
    await w.settle();
    expect(w.state()).toMatchObject({ kind: "waiting", invalidating: true });
    expect(held(w)).toEqual([OP]);
    w.engine.stop();
  });

  test("a hold is ended by a gate that says the position is settled: the cache is already invalid, so the database hides it", async () => {
    const w = await build();
    failInvalidation(w, "error");
    failCounter(w);
    w.markerStorage.failWrites = true;
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(held(w)).toEqual([OP]);
    w.setSync({ cache_status: "invalid", cursor: null });
    w.fire();
    await w.settle();
    expect(held(w)).toEqual([]);
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    w.engine.stop();
  });
});

describe("the capture gate: a lifted stop lets one step through and erases nothing; only the invalidation's stop can be lifted", () => {
  const capture = (
    w: World,
    input: { stoppedOperations?: string[]; liftedOperations?: string[] },
  ) =>
    w.service.store.run(captureRequest, {
      incarnationId: w.service.incarnationId,
      signals: { hasStorageEstimate: true },
      ...input,
    });

  test("the durable streak at the bound, and a marker or memory stop named by `stoppedOperations`, are lifted by exactly the invalidation's operation", async () => {
    for (const how of ["streak", "named"] as const) {
      const w = await build();
      if (how === "streak") w.setSync({ local_write_streaks: { [OP]: BOUND } });
      const stopped = how === "named" ? { stoppedOperations: [OP] } : {};
      // ADAPTED, revision 32 (R53): the gate also says the version of the durable failure it decided on (a streak planted without one is
      // version 0; a marker's or memory's stop has none), which the person's retry resets on. Nothing else about the result changed.
      expect(await capture(w, stopped)).toEqual({
        kind: "gated",
        reason: "local_storage",
        operation: OP,
        version: how === "streak" ? 0 : null,
      });
      const seq = w.sync().request_seq;
      // Lifted: captured, the sequence advanced, and the streak is exactly what it was (the plan erases nothing).
      expect(
        await capture(w, { ...stopped, liftedOperations: [OP] }),
      ).toMatchObject({ kind: "captured", cursor: "cursor-0" });
      expect(w.sync().request_seq).toBe(seq + 1);
      expect(w.sync().local_write_streaks).toEqual(
        how === "streak" ? { [OP]: BOUND } : {},
      );
      // Lifting another position's operation lifts nothing here.
      expect(
        await capture(w, {
          ...stopped,
          liftedOperations: [invalidateOperation("cursor-5")],
        }),
      ).toMatchObject({ kind: "gated", operation: OP });
    }
  });

  test("the capture write's own stop and the page's stop are NOT lifted by a lifted invalidation, nor by being named as lifted", async () => {
    const w = await build();
    w.setSync({ local_write_streaks: { [CAPTURE_OPERATION]: BOUND } });
    expect(
      await capture(w, { liftedOperations: [CAPTURE_OPERATION, OP] }),
    ).toMatchObject({ kind: "gated", operation: CAPTURE_OPERATION });
    w.setSync({ local_write_streaks: { "page:cursor-0": BOUND } });
    expect(
      await capture(w, { liftedOperations: ["page:cursor-0", OP] }),
    ).toMatchObject({ kind: "gated", operation: "page:cursor-0" });
    // Both stops AND the invalidation's: lifting the invalidation still leaves the others in force, in their order.
    w.setSync({
      local_write_streaks: {
        [CAPTURE_OPERATION]: BOUND,
        "page:cursor-0": BOUND,
        [OP]: BOUND,
      },
    });
    expect(await capture(w, { liftedOperations: [OP] })).toMatchObject({
      kind: "gated",
      operation: CAPTURE_OPERATION,
    });
  });
});

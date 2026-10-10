// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type AccountService,
  unorderedPersistence,
} from "../../src/data/engine/account-service";
import {
  LOCAL_WRITE_STOPS_STORE,
  type SyncChannel,
  type SyncMessage,
} from "../../src/data/engine/sync-channel";
import type { WriteFailureMarkers } from "../../src/data/engine/write-failure-marker";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { pageMarkers } from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R60 completed (revision 38, `durable-stop-publication`): EVERY writer exit that commits a change of the record of durable stops tells
 * the account's other pages, including the exits whose public answer is not a success.
 *
 *  - DA-R60-C (the design assessment of review 37): three failed public saves of `x` leave NO draft and a durable stop of `draft:x`,
 *    which a warm follower page shows; the public `discard(x)` answers `not_found`, and its plan ends the stop in the same transaction
 *    (R46). That branch returned before any hint, so the follower kept the warning while a fresh page would read none. The plan now
 *    reports the longest streak it ended, and the facade posts the stop hint when that was a STOP.
 *  - The record of a request that got no answer (`recordFailureOfSend`) ends the receipt's failures in its transaction (R46); a receipt
 *    stop recorded by another page while the request was in flight was ended without any hint. The plan reports it the same way.
 *  - A stop counter (or an answer's record) whose transaction COMMITTED while its producer ended (the service, or the dispatcher's run)
 *    returned before the hint (R56 forbids the obsolete page's own effects, rightly). The commit is in the record all the same: the hint
 *    is posted, and nothing else of the obsolete act is done. An ABORTED counter commits nothing and posts nothing.
 *
 * The hint is a content-free request to re-read (never the stop itself): a follower derives its warning from its own records.
 *
 * The oracle: the follower is ANOTHER page (its own markers page and channel; the writer's posts reach it only when relayed, as
 * `BroadcastChannel` would), the durable record is read back from the database, the hints are those the writer actually posted, and
 * nothing polls (each case waits 65 s without a relay first, so only the hint can take a warning down).
 *
 * FIXTURE evidence: the production facade, dispatcher and plans over the doubles of IndexedDB and `localStorage`, fake time; the
 * failures and closures are NAMED injections; no backend.
 */
const STOP_READS = "data.readLocalWriteStops";

const request = (localId: string, target = "r"): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: target,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id: target,
      label: localId,
      expected_version: bases[target] as number,
    },
  }),
});

async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
  ]);
  return w;
}
const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
const stopHints = (w: OutboxWorld): SyncMessage[] =>
  w.posted.filter(
    (m) =>
      m.type === "data_changed" && m.stores.includes(LOCAL_WRITE_STOPS_STORE),
  );
const draftsHints = (w: OutboxWorld): SyncMessage[] =>
  w.posted.filter(
    (m) => m.type === "data_changed" && m.stores.includes("drafts"),
  );

/** A view of the service whose store counts the stop-record reads made through it (one page's reads, not the world's). */
function counted(service: AccountService): {
  service: AccountService;
  reads: () => number;
} {
  let reads = 0;
  const store = new Proxy(service.store, {
    get(target, key) {
      if (key !== "run") return Reflect.get(target, key, target);
      return (plan: { name: string }, ...rest: unknown[]) => {
        if (plan.name === STOP_READS) reads += 1;
        return (target.run as (...a: unknown[]) => unknown)(plan, ...rest);
      };
    },
  });
  return {
    service: new Proxy(service, {
      get: (target, key) =>
        key === "store" ? store : Reflect.get(target, key, target),
    }),
    reads: () => reads,
  };
}

interface Follower {
  facade: Outbox;
  markers: WriteFailureMarkers;
  reads(): number;
  hear(message: SyncMessage): void;
  relay(): void;
  close(): void;
}

/** Another page of the same account: its own markers page, its own channel, its own reads, over its own live view of the database. */
function follower(w: OutboxWorld, service: AccountService = w.service) {
  const listeners = new Set<(message: SyncMessage) => void>();
  const channel: SyncChannel = {
    post: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const view = counted(service);
  const markers = pageMarkers(
    w.markerStorage.page(`follower-${crypto.randomUUID()}`),
  );
  const facade = createOutbox({
    service: view.service,
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: {
      iso: () => new Date(w.now()).toISOString(),
      now: () => w.now(),
    },
    fence: () => w.fence,
    markers,
    channel,
    timers: w.timers,
  });
  let relayed = w.posted.length;
  const hear = (message: SyncMessage): void => {
    for (const listener of [...listeners]) listener(message);
  };
  return {
    facade,
    markers,
    reads: view.reads,
    hear,
    relay() {
      const fresh = w.posted.slice(relayed);
      relayed = w.posted.length;
      for (const message of fresh) hear(message);
    },
    close() {
      facade.disposeObservation();
      markers.release();
    },
  } satisfies Follower;
}

/**
 * The same account's database opened by ANOTHER page (its own registry and connection), so the follower stays live when the writer's
 * service ends. Its service is a real `DataRuntime`'s, as the writer's is.
 */
async function otherPage(w: OutboxWorld): Promise<{
  service: AccountService;
  close(): void;
}> {
  const page = w.env.page("B");
  page.identity.account = w.service.account;
  page.identity.epoch = 1;
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: {
      get: () => ({
        account_id: w.service.account,
        epoch: 1,
        session_id: "b",
      }),
      subscribe: () => () => undefined,
    },
    persistence: unorderedPersistence,
    registry: page.registry,
    open: (account, options) => page.open(account, options),
  });
  const opened = await runtime.open(w.service.account, { create: false });
  if (opened.kind !== "opened") throw new Error(`page B: ${opened.kind}`);
  expect(opened.service.live).toBe(true);
  expect(opened.service.incarnationId).toBe(w.service.incarnationId);
  return {
    service: opened.service,
    close() {
      runtime.dispose();
    },
  };
}

/** Three failed public saves of `id`: no draft is created, and the durable streak reaches its bound (a stop). */
async function stopBySaves(w: OutboxWorld, id: string, times = 3) {
  fail(w, "data.enqueueDraft", times);
  for (let i = 0; i < times; i += 1)
    expect(await w.outbox.enqueue(request(id))).toEqual({
      kind: "refused",
      reason: "storage",
    });
  await w.settle();
}

describe("DA-R60-C: a discard of a draft that never existed ends its stop, and tells the follower", () => {
  test("three failed saves leave no draft and a stop the follower shows; discard answers not_found, posts ONE stop hint, and the same warm follower takes its warning down", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(false);
      await stopBySaves(w, "x");
      expect(w.drafts()).toEqual([]);
      expect(w.sync().local_write_streaks).toEqual({ "draft:x": 3 });
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(true);
      const before = stopHints(w).length;
      const drafts = draftsHints(w).length;
      // The person's answer is the plan's refusal, and nothing of the page's bookkeeping.
      expect(await w.outbox.discard("x")).toEqual({
        kind: "refused",
        reason: "not_found",
      });
      await w.settle();
      expect(w.sync().local_write_streaks).toEqual({});
      expect(stopHints(w).length).toBe(before + 1);
      // No draft changed, and no other hint is posted for it.
      expect(draftsHints(w).length).toBe(drafts);
      // Nothing polls: without the hint the follower keeps the stop it read.
      await w.advance(65_000);
      expect(reader.facade.storageNotResponding.get()).toBe(true);
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(false);
      // A fresh page agrees with the follower.
      const fresh = follower(w);
      await w.settle();
      expect(fresh.facade.storageNotResponding.get()).toBe(false);
      fresh.close();
    } finally {
      reader.close();
      finish(w);
    }
  });

  for (const failures of [0, 2])
    test(`control: ${failures === 0 ? "no streak at all" : "two failures (below the bound: no stop anywhere)"}: discard answers not_found and posts no stop hint, and the healthy follower reads nothing more`, async () => {
      const w = await world();
      const reader = follower(w);
      try {
        await w.settle();
        if (failures > 0) await stopBySaves(w, "x", failures);
        expect(w.sync().local_write_streaks).toEqual(
          failures === 0 ? {} : { "draft:x": failures },
        );
        reader.relay();
        await w.settle();
        const reads = reader.reads();
        const before = stopHints(w).length;
        expect(await w.outbox.discard("x")).toEqual({
          kind: "refused",
          reason: "not_found",
        });
        await w.settle();
        expect(w.sync().local_write_streaks).toEqual({});
        expect(stopHints(w).length).toBe(before);
        reader.relay();
        await w.advance(65_000);
        expect(reader.reads()).toBe(reads);
        expect(reader.facade.storageNotResponding.get()).toBe(false);
      } finally {
        reader.close();
        finish(w);
      }
    });

  test("another draft's stop stands: the discard of x ends only x's stop, and the follower keeps the warning for y", async () => {
    const w = await world();
    const reader = follower(w);
    try {
      await w.settle();
      await stopBySaves(w, "x");
      await stopBySaves(w, "y");
      expect(w.sync().local_write_streaks).toEqual({
        "draft:x": 3,
        "draft:y": 3,
      });
      reader.relay();
      await w.settle();
      expect(reader.facade.storageNotResponding.get()).toBe(true);
      const reads = reader.reads();
      const before = stopHints(w).length;
      expect((await w.outbox.discard("x")).kind).toBe("refused");
      await w.settle();
      expect(w.sync().local_write_streaks).toEqual({ "draft:y": 3 });
      expect(stopHints(w).length).toBe(before + 1);
      reader.relay();
      await w.settle();
      // It read its records again on the hint, and they still hold a stop.
      expect(reader.reads()).toBeGreaterThan(reads);
      expect(reader.facade.storageNotResponding.get()).toBe(true);
    } finally {
      reader.close();
      finish(w);
    }
  });
});

describe("R60 (revision 38): the record of a request that got no answer ends a receipt stop, and tells the follower", () => {
  for (const streak of [3, 2])
    test(`another page's receipt ${streak === 3 ? "STOP" : "failures below the bound (the control)"} recorded while the request was in flight: the network error's record ends ${streak === 3 ? "it and posts the stop hint; the follower takes its warning down" : "them and posts no stop hint"}`, async () => {
      const w = await world();
      const reader = follower(w);
      try {
        expect((await w.outbox.enqueue(request("a"))).kind).toBe("queued");
        await w.settle();
        let release: (answer: Error) => void = () => undefined;
        w.script.push(
          () =>
            new Promise<Error>((resolve) => {
              release = resolve;
            }),
        );
        w.online = true;
        w.start();
        await w.settle();
        expect(w.sent).toHaveLength(1);
        // While the request is in flight another page records the receipt's failures (and, at the bound, says so).
        w.setSync({ local_write_streaks: { "receipt:a": streak } });
        reader.hear({
          type: "data_changed",
          account: w.service.account,
          stores: [LOCAL_WRITE_STOPS_STORE],
        });
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(streak === 3);
        const before = stopHints(w).length;
        const reads = reader.reads();
        release(new TypeError("Failed to fetch"));
        await w.settle();
        expect(w.drafts()[0]?.attempts).toBe(1);
        expect(w.sync().local_write_streaks).toEqual({});
        expect(stopHints(w).length).toBe(before + (streak === 3 ? 1 : 0));
        await w.advance(1_000);
        expect(reader.facade.storageNotResponding.get()).toBe(streak === 3);
        reader.relay();
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(false);
        if (streak === 2) expect(reader.reads()).toBe(reads);
      } finally {
        reader.close();
        finish(w);
      }
    });
});

describe("R60 (revision 38): a stop that COMMITTED while its producer ended still reaches the follower", () => {
  for (const schedule of ["ended", "aborted", "live"] as const)
    test(`the facade's third failed save, its counter ${schedule === "ended" ? "committed while the writer's service ended: the hint is posted and the follower shows the stop; the obsolete page shows and records nothing" : schedule === "aborted" ? "ABORTED while the writer's service ended (control): nothing committed, no hint, no marker" : "committed, the writer live (control): the hint, and the writer's own warning"}`, async () => {
      const w = await world();
      const b = await otherPage(w);
      const reader = follower(w, b.service);
      try {
        await w.settle();
        await stopBySaves(w, "x", 2);
        reader.relay();
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(false);
        const before = stopHints(w).length;
        fail(w, "data.enqueueDraft", 1);
        let ended = false;
        if (schedule !== "live")
          // The writer's service ends while its counter's transaction is applying its write (the counter's put of the singleton;
          // the failed save wrote nothing). An aborted counter never reaches its write: it ends at the save's refusal.
          w.env.idb.afterPut = (store) => {
            if (store !== "sync_state" || ended) return;
            ended = true;
            w.service.dispose("closed");
          };
        const end =
          schedule === "aborted"
            ? w.env.idb.inject({
                match: (tx) => {
                  if (tx.label === "data.recordLocalWriteOutcome" && !ended) {
                    ended = true;
                    w.service.dispose("closed");
                  }
                  return false;
                },
                mode: "error",
              })
            : () => undefined;
        // After the observer above (injections are consulted in order, and the first that matches decides).
        if (schedule === "aborted") fail(w, "data.recordLocalWriteOutcome", 1);
        const out = await w.outbox.enqueue(request("x"));
        end();
        w.env.idb.afterPut = null;
        await w.settle();
        expect(ended).toBe(schedule !== "live");
        expect(out).toEqual({
          kind: "refused",
          reason: schedule === "live" ? "storage" : "identity_changed",
        });
        expect(w.sync().local_write_streaks).toEqual({
          "draft:x": schedule === "aborted" ? 2 : 3,
        });
        expect(stopHints(w).length).toBe(
          before + (schedule === "aborted" ? 0 : 1),
        );
        // The obsolete writer shows nothing and leaves no fallback marker of a lifetime that is over.
        expect(w.outbox.storageNotResponding.get()).toBe(schedule === "live");
        expect(w.markerStorage.keys().length).toBe(0);
        reader.relay();
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(
          schedule !== "aborted",
        );
      } finally {
        reader.close();
        b.close();
        w.dispatcher.stop();
        if (w.service.live) w.service.dispose("closed");
      }
    });

  for (const schedule of ["ended", "live"] as const)
    test(`the dispatcher's third failed claim, its counter ${schedule === "ended" ? "committed while the service ended: the hint is posted and the follower shows the stop" : "committed, live (control): the hint"}`, async () => {
      const w = await world();
      const b = await otherPage(w);
      const reader = follower(w, b.service);
      try {
        expect((await w.outbox.enqueue(request("a"))).kind).toBe("queued");
        await w.settle();
        fail(w, "data.markInFlight", 3);
        // Two failed claims before, counted below the bound; the third's counter is the one that ends with its service.
        let counters = 0;
        let ended = false;
        if (schedule === "ended")
          w.env.idb.afterPut = (store) => {
            if (store !== "sync_state" || ended) return;
            counters += 1;
            if (counters < 3) return;
            ended = true;
            w.service.dispose("closed");
          };
        const before = stopHints(w).length;
        w.online = true;
        w.start();
        await w.advance(5_000);
        w.env.idb.afterPut = null;
        expect(ended).toBe(schedule === "ended");
        expect(w.sync().local_write_streaks).toEqual({ "draft:a": 3 });
        expect(stopHints(w).length).toBe(before + 1);
        expect(w.markerStorage.keys().length).toBe(0);
        reader.relay();
        await w.settle();
        expect(reader.facade.storageNotResponding.get()).toBe(true);
      } finally {
        reader.close();
        b.close();
        w.dispatcher.stop();
        if (w.service.live) w.service.dispose("closed");
      }
    });

  for (const answer of ["receipt", "unavailable"] as const)
    for (const schedule of ["stopped", "live"] as const)
      test(`${answer === "receipt" ? "a receipt admitted" : "a 503 recorded (a counted retry)"} ${schedule === "stopped" ? "while the dispatcher's run ENDED (its result delivered to a run that is over): the ordinary hint is still posted, and a follower showing the receipt's stop takes it down" : "by a run that stands (control): the ordinary hint"}`, async () => {
        const w = await world();
        const b = await otherPage(w);
        const reader = follower(w, b.service);
        try {
          expect((await w.outbox.enqueue(request("a"))).kind).toBe("queued");
          await w.settle();
          let release: (answer: Response) => void = () => undefined;
          w.script.push(
            () =>
              new Promise<Response>((resolve) => {
                release = resolve;
              }),
          );
          w.online = true;
          w.start();
          await w.settle();
          expect(w.sent).toHaveLength(1);
          // Another page's receipt stop, recorded while the request was in flight; the follower shows it.
          w.setSync({ local_write_streaks: { "receipt:a": 3 } });
          reader.hear({
            type: "data_changed",
            account: w.service.account,
            stores: [LOCAL_WRITE_STOPS_STORE],
          });
          await w.settle();
          expect(reader.facade.storageNotResponding.get()).toBe(true);
          let stopped = false;
          if (schedule === "stopped")
            w.env.idb.afterPut = (store) => {
              if (store !== "sync_state" || stopped) return;
              stopped = true;
              w.dispatcher.stop();
            };
          const before = draftsHints(w).length;
          release(
            answer === "receipt"
              ? w.receipt(7)
              : w.error(503, "service_unavailable"),
          );
          await w.settle();
          w.env.idb.afterPut = null;
          expect(stopped).toBe(schedule === "stopped");
          expect(w.sync().local_write_streaks).toEqual({});
          expect(draftsHints(w).length).toBe(before + 1);
          await w.advance(65_000);
          expect(reader.facade.storageNotResponding.get()).toBe(true);
          reader.relay();
          await w.settle();
          expect(reader.facade.storageNotResponding.get()).toBe(false);
        } finally {
          reader.close();
          b.close();
          finish(w);
        }
      });
});

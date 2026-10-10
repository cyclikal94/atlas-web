// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { deriveNotices } from "../../src/data/model/status";
import {
  recordLocalWriteOutcome,
  recordReadOutcome,
} from "../../src/data/plans/retry-state";
import { engineWorld } from "../support/data/engine-world";

import { scopeOf } from "../support/data/marker-storage";

/**
 * R4 and R5, through the PRODUCTION engine, plans and guards over the double of IndexedDB. The network is a script and time is
 * fake. FIXTURE evidence: nothing here talks to a backend (the released-backend resume path is the integration case I-O4).
 *
 * R4: the approved reconciliation table gives the sync read caller two resume triggers, the browser coming back `online` and the
 * caller's own explicit "Retry now", and nothing else (not another caller's success, not the passage of time). R5: a local
 * IndexedDB write failure that stopped an operation is a durable, operation-specific stop.
 */
const paused = async () => {
  const w = await engineWorld();
  for (let i = 0; i < 60; i += 1) w.script.push(w.status(500));
  w.start();
  await w.settle();
  for (let i = 0; i < 12 && w.state().kind !== "paused"; i += 1)
    await w.advance(60_000);
  expect(w.state().kind).toBe("paused");
  w.script.length = 0;
  return w;
};

const unrecognised = async (
  options: Parameters<typeof engineWorld>[0] = {},
) => {
  const w = await engineWorld(options);
  w.script.push(w.status(409), w.status(409), w.status(409));
  w.start();
  await w.settle();
  await w.advance(2_000);
  await w.advance(4_000);
  expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
  return w;
};

describe("R4: the sync caller's resume triggers", () => {
  test("a pause by duration is ended by the browser coming back online: the next wake sends a request", async () => {
    const w = await paused();
    const n = w.requests.length;
    // No connectivity change yet: another reason to wake does not resume it.
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n);
    expect(w.state().kind).toBe("paused");
    // Offline, then online again.
    w.online = false;
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n);
    w.goOnline();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.sync().read_retry_states.sync).toMatchObject({
      paused: false,
      backing_off_since: null,
    });
    expect(w.state().kind).toBe("idle");
  });

  test("an explicit Retry now ends a pause by duration and sends one request", async () => {
    const w = await paused();
    const n = w.requests.length;
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.state().kind).toBe("idle");
  });

  test("three unrecognised answers stop the caller; the FIRST Retry now sends a request (it used to fall back into the persisted pause)", async () => {
    const w = await unrecognised();
    const n = w.requests.length;
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.state().kind).toBe("idle");
    expect(w.sync().read_retry_states.sync).toMatchObject({
      paused: false,
      unrecognised_streak: 0,
    });
  });

  test("the `online` event itself resumes the pause, even when this engine never saw the offline that preceded it (a frozen or discarded page; the released-backend case)", async () => {
    const w = await paused();
    const n = w.requests.length;
    // `online()` has read true throughout: there is no transition to infer, only the event.
    expect(w.online).toBe(true);
    w.goOnline();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.sync().read_retry_states.sync).toMatchObject({ paused: false });
  });

  test("an offline-to-online change that is only READ at a wake (a flag and two wakes, no `online` event) resumes it too, once", async () => {
    const w = await paused();
    const n = w.requests.length;
    w.online = false;
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n);
    w.online = true;
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.sync().read_retry_states.sync).toMatchObject({ paused: false });
  });

  test("the unrecognised stop is not a connectivity problem: coming online, and every other wake, leave it exactly as it is", async () => {
    const w = await unrecognised();
    const n = w.requests.length;
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n);
    // Still the unrecognised stop, not flipped into a generic "still trying" pause by a wake.
    expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
  });

  test("the unrecognised stop is durable: a restart of the engine finds it, sends nothing, and shows it", async () => {
    const w = await unrecognised();
    const n = w.requests.length;
    w.engine.stop();
    w.start();
    await w.settle();
    expect(w.requests.length).toBe(n);
    expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
  });

  test("resuming the sync caller never resets an unrelated caller, and an unrelated caller's success never resumes it", async () => {
    const w = await paused();
    const other = {
      backing_off_since: 5,
      paused: true,
      unrecognised_streak: 3,
    };
    w.setSync({
      read_retry_states: { ...w.sync().read_retry_states, households: other },
    });
    // Another caller's own success is not the sync caller's recovery.
    const out = await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "households",
      outcome: { kind: "success" },
      now: 1,
    });
    expect(out.kind).toBe("applied");
    const n = w.requests.length;
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n);
    expect(w.state().kind).toBe("paused");
    // Put the unrelated caller back as it was, then resume ONLY the sync caller.
    w.setSync({
      read_retry_states: { ...w.sync().read_retry_states, households: other },
    });
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.sync().read_retry_states.households).toEqual(other);
    expect(w.sync().read_retry_states.sync).toMatchObject({ paused: false });
  });

  test("a short back-off is cut short by coming online, and only that caller's clock is reset", async () => {
    const w = await engineWorld();
    w.script.push(w.status(500));
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("backing_off");
    const n = w.requests.length;
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(
      w.sync().read_retry_states.sync?.backing_off_since ?? null,
    ).toBeNull();
  });
});

describe("R5: a local write failure stops ONE operation durably (sync pages)", () => {
  const failPage = (w: Awaited<ReturnType<typeof engineWorld>>, times = 3) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.commitPage",
      mode: "error",
      times,
    });

  const stopped = async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    failPage(w);
    w.start();
    await w.settle();
    for (let i = 0; i < 6 && w.state().kind !== "stopped"; i += 1)
      await w.advance(1_000);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    return w;
  };

  test("three failed commits of one page stop that page's operation in the durable record", async () => {
    const w = await stopped();
    expect(w.sync().local_write_streaks).toEqual({ "page:cursor-0": 3 });
    // The marker is only the FALLBACK for a counter that cannot be written.
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
  });

  test("the stop survives a restart and every wake: no request, and the stopped state is shown at once (cold start)", async () => {
    const w = await stopped();
    const n = w.requests.length;
    w.engine.stop();
    w.start();
    await w.settle();
    expect(w.requests.length).toBe(n);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(n);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
  });

  test("a seeded durable streak of three is enforced on a fresh start (the reviewer's reproduction)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({ local_write_streaks: { "page:cursor-0": 3 } });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
  });

  test("Try again clears exactly that operation's streak, not another operation's, and the page then commits", async () => {
    const w = await stopped();
    w.setSync({
      local_write_streaks: {
        ...w.sync().local_write_streaks,
        "draft:other": 2,
      },
    });
    const n = w.requests.length;
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBe(n + 1);
    expect(w.state().kind).toBe("idle");
    expect(w.sync().local_write_streaks).toEqual({ "draft:other": 2 });
  });

  test("another operation's success does not clear this one's streak, and a stop of another cursor does not stop this page", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({ local_write_streaks: { "page:cursor-9": 3 } });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.sync().local_write_streaks).toEqual({ "page:cursor-9": 3 });
  });

  test("a failed counter write stops AT ONCE, records the stop in the account's fallback marker, and a reload finds it", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    failPage(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.markers.has(scopeOf(w.service.account), "page:cursor-0")).toBe(
      true,
    );
    expect(w.sync().local_write_streaks).toEqual({});

    const n = w.requests.length;
    w.engine.stop();
    w.start();
    await w.settle();
    // The marker, not the durable counter, kept the stop across the restart.
    expect(w.requests.length).toBe(n);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });

    w.engine.retryNow();
    await w.settle();
    expect(w.markers.has(scopeOf(w.service.account), "page:cursor-0")).toBe(
      false,
    );
    expect(w.requests.length).toBe(n + 1);
    expect(w.state().kind).toBe("idle");
  });

  test("a marker is cleared by the operation's own success", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.markers.set(scopeOf(w.service.account), "page:cursor-0");
    // The marker alone stops the page (a counter could not be written before the reload).
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    // A marker of another page does not.
    w.markers.clear(scopeOf(w.service.account), "page:cursor-0");
    w.markers.set(scopeOf(w.service.account), "page:cursor-5");
    w.engine.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });

  test("when BOTH stores fail the stop is held in memory, says so, and is gone after a reload", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    failPage(w, 1);
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 1,
    });
    w.markerStorage.failWrites = true;
    w.start();
    await w.settle();
    expect(w.state()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
    const notices = deriveNotices({
      online: true,
      engine: w.state(),
      recovery: { registered: false, active: false },
      cache: "valid",
      lastSyncedAt: null,
      summary: null,
      outbox: null,
      storageNotResponding: false,
    });
    expect(notices).toContainEqual({
      kind: "page_not_saved",
      memoryOnly: true,
    });
    // A RELOAD (a new engine over the same database): nothing durable remembers it, which is exactly what the copy tells the person.
    w.reload();
    w.start();
    await w.settle();
    expect(w.state().kind).not.toBe("stopped");
  });

  describe("R5 (revision 6): a stop that only this tab's memory holds is kept for as long as the tab lives", () => {
    /** The commit of a page fails, its streak cannot be written, and the fallback marker cannot be written either. */
    const memoryOnlyStop = async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      failPage(w, 1);
      w.env.idb.inject({
        match: (tx) => tx.label === "data.recordLocalWriteOutcome",
        mode: "error",
        times: 1,
      });
      w.markerStorage.failWrites = true;
      w.start();
      await w.settle();
      expect(w.state()).toEqual({
        kind: "stopped",
        cause: "local_storage",
        memoryOnly: true,
      });
      expect(w.requests).toHaveLength(1);
      return w;
    };
    const STOPPED = {
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    } as const;

    test("the reviewer's schedule: one unrelated subscription wake sends nothing, and the stop still says it is memory-only", async () => {
      const w = await memoryOnlyStop();
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual(STOPPED);
    });

    test.each([
      [
        "a subscription wake (the session view, visibility)",
        (w: Awaited<ReturnType<typeof memoryOnlyStop>>) => w.fire(),
      ],
      [
        "the browser coming online",
        (w: Awaited<ReturnType<typeof memoryOnlyStop>>) => w.goOnline(),
      ],
      [
        "a receipt nudge",
        (w: Awaited<ReturnType<typeof memoryOnlyStop>>) =>
          w.engine.nudge("receipt"),
      ],
      [
        "an immediate nudge",
        (w: Awaited<ReturnType<typeof memoryOnlyStop>>) =>
          w.engine.nudge("now"),
      ],
    ])(
      "%s does not lift it: no request, however many times and however long afterwards",
      async (_name, signal) => {
        const w = await memoryOnlyStop();
        for (let i = 0; i < 3; i += 1) {
          signal(w);
          await w.settle();
          await w.advance(60_000);
        }
        expect(w.requests).toHaveLength(1);
        expect(w.state()).toEqual(STOPPED);
      },
    );

    test("going offline and online again, with wakes in between, does not lift it", async () => {
      const w = await memoryOnlyStop();
      w.online = false;
      w.fire();
      await w.settle();
      w.goOnline();
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual(STOPPED);
    });

    test("a stop and a start of the engine (an ownership change in a tab that stays alive) is not a reload: the stop stands, and still says memory-only", async () => {
      const w = await memoryOnlyStop();
      w.engine.stop();
      w.start();
      await w.settle();
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual(STOPPED);
    });

    test("unrelated work does not clear it: another operation's success, another operation's streak", async () => {
      const w = await memoryOnlyStop();
      await w.service.store.run(recordLocalWriteOutcome, {
        incarnationId: w.service.incarnationId,
        operation: "draft:other",
        outcome: { kind: "success", expect: null },
      });
      w.setSync({
        local_write_streaks: { ...w.sync().local_write_streaks, "draft:x": 1 },
      });
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual(STOPPED);
      expect(w.sync().local_write_streaks).toEqual({ "draft:x": 1 });
    });

    test("it is scoped to its OPERATION: when the page it names is no longer the current one (another page moved the cursor), this page is not stopped", async () => {
      const w = await memoryOnlyStop();
      w.setSync({ cursor: "cursor-7" });
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(2);
      expect(w.requests[1]?.searchParams.get("cursor")).toBe("cursor-7");
    });

    test("only the explicit retry of that operation lifts it: the page is requested, and the stop is gone for good", async () => {
      const w = await memoryOnlyStop();
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      w.engine.retryNow();
      await w.settle();
      expect(w.requests).toHaveLength(2);
      expect(w.state().kind).toBe("idle");
      // And it does not come back: a later wake is an ordinary one.
      w.fire();
      await w.settle();
      expect(w.state().kind).not.toBe("stopped");
    });

    test("a second stop of the same page (the retry fails again) is held in memory again, and a reload is still the only thing that forgets it", async () => {
      const w = await memoryOnlyStop();
      failPage(w, 1);
      // Two counter writes fail: the retry's own clearing of the old streak, and then the new failure's.
      w.env.idb.inject({
        match: (tx) => tx.label === "data.recordLocalWriteOutcome",
        mode: "error",
        times: 2,
      });
      w.engine.retryNow();
      await w.settle();
      expect(w.requests).toHaveLength(2);
      expect(w.state()).toEqual(STOPPED);
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(2);
      w.reload();
      w.start();
      await w.settle();
      expect(w.requests).toHaveLength(3);
    });

    test("a stop that WAS recorded (the marker, or the streak) is not reported as memory-only on a later wake", async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      failPage(w, 1);
      w.env.idb.inject({
        match: (tx) => tx.label === "data.recordLocalWriteOutcome",
        mode: "error",
        times: 1,
      });
      w.start();
      await w.settle();
      expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    });
  });

  test("the bound is the configured one: two failures do not stop, the third does", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    failPage(w, 2);
    w.start();
    await w.settle();
    for (let i = 0; i < 4; i += 1) await w.advance(1_000);
    expect(w.state().kind).toBe("idle");
    expect(DATA_CONFIG.localWritePauseAfter).toBe(3);
    expect(w.sync().local_write_streaks).toEqual({});
  });
});

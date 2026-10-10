// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  READ_RETRY_OPERATION,
  SIZING_OPERATION,
} from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import { scopeOf } from "../support/data/marker-storage";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";
import { EPOCH_BASE } from "../support/session/env";

/**
 * R19 and R20 (revision 9), through the PRODUCTION engine, plans and guards over the double of IndexedDB. The network is a script,
 * time is fake and every fault is a NAMED injection (a write that throws, a quota failure, a persistence gate that cannot verify): a
 * real engine cannot be made to raise them on request, and none of this is a genuine backend outage. FIXTURE evidence.
 *
 * R19: the whole `5xx` family is ONE network/5xx class (contract-hygiene item 3): backed off, paused after the sustained duration,
 * resumed by `online` or the caller's own "Retry now", never an unrecognised answer. Only a capacity outcome that is specified by its
 * code (`503` `device_capacity`) is decided apart from it.
 *
 * R20: the two counters a step needs to bound itself, the `sync` caller's retry record and the sizing record, may themselves fail to
 * be written. A swallowed failure removed the bound (64 requests in an hour with no end; 21 identical allocations at one instant), so
 * now the count is made in the page's memory first and a failed write is the specified local-storage stop: immediate, uncounted,
 * recorded in the account's fallback marker, then in the tab's memory, and left only by "Try again".
 */
type World = Awaited<ReturnType<typeof engineWorld>>;

const failRecord = (
  w: World,
  mode: "error" | "quota" = "error",
  times?: number,
) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.recordReadOutcome",
    mode:
      mode === "error"
        ? "error"
        : { kind: "throw_on_write", n: 1, as: "quota" },
    ...(times === undefined ? {} : { times }),
  });

const script = (w: World, status: number, times = 400) => {
  for (let i = 0; i < times; i += 1) w.script.push(w.status(status));
};

/** Runs the engine until it is `paused` (a sustained outage) and returns the number of requests it took. */
const untilPaused = async (w: World): Promise<number> => {
  w.start();
  await w.settle();
  for (let i = 0; i < 90 && w.state().kind !== "paused"; i += 1)
    await w.advance(60_000);
  expect(w.state().kind).toBe("paused");
  return w.requests.length;
};

describe("R19: the whole 5xx family is the network/5xx class", () => {
  test.each([[500], [501], [502], [503], [504], [505], [520], [599], [429]])(
    "%i: backed off, never an unrecognised streak, paused by duration, bounded, resumed by online and by Retry now",
    async (status) => {
      const w = await engineWorld();
      script(w, status);
      w.start();
      await w.settle();
      await w.advance(7_000);
      // 2 s, 4 s: the third request is at 6 s; nothing has stopped the caller.
      expect(w.requests).toHaveLength(3);
      expect(w.state().kind).toBe("backing_off");
      expect(w.sync().read_retry_states.sync).toMatchObject({
        paused: false,
        unrecognised_streak: 0,
      });
      // Sustained: the duration, not a count of answers, ends the automatic retries.
      for (let i = 0; i < 90 && w.state().kind !== "paused"; i += 1)
        await w.advance(60_000);
      expect(w.state().kind).toBe("paused");
      const n = w.requests.length;
      expect(n).toBeLessThanOrEqual(12);
      expect(w.sync().read_retry_states.sync).toMatchObject({
        paused: true,
        unrecognised_streak: 0,
      });
      // Nothing more is asked for as long as it stands, however long and whatever wakes.
      w.fire();
      await w.advance(7_200_000);
      expect(w.requests).toHaveLength(n);
      // `online` resumes a pause by duration...
      w.online = false;
      w.fire();
      await w.settle();
      w.goOnline();
      await w.settle();
      expect(w.requests.length).toBeGreaterThan(n);
      const m = w.requests.length;
      // ...and so does the caller's own "Retry now", after a second sustained outage.
      for (let i = 0; i < 90 && w.state().kind !== "paused"; i += 1)
        await w.advance(60_000);
      expect(w.state().kind).toBe("paused");
      const paused = w.requests.length;
      expect(paused).toBeGreaterThan(m);
      w.engine.retryNow();
      await w.settle();
      expect(w.requests.length).toBeGreaterThan(paused);
    },
  );

  test("a Retry-After on a gateway failure is honoured like any other 5xx", async () => {
    const w = await engineWorld();
    w.script.push(w.status(502, { headers: { "retry-after": "30" } }));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    await w.advance(29_000);
    expect(w.requests).toHaveLength(1);
    await w.advance(2_000);
    expect(w.requests).toHaveLength(2);
  });

  test("control: the specified capacity outcome is still decided by its code, and an unrecognised status is still unrecognised", async () => {
    const capacity = await engineWorld();
    capacity.script.push(
      capacity.status(503, { body: { code: "device_capacity" } }),
    );
    capacity.start();
    await capacity.settle();
    expect(capacity.state()).toEqual({
      kind: "stopped",
      cause: "device_capacity",
    });
    expect(capacity.requests).toHaveLength(1);

    const unknown = await engineWorld();
    script(unknown, 418, 10);
    unknown.start();
    await unknown.settle();
    await unknown.advance(10_000);
    expect(unknown.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
    expect(unknown.requests).toHaveLength(3);
    // `online` does not end it.
    unknown.online = false;
    unknown.fire();
    await unknown.settle();
    unknown.goOnline();
    await unknown.settle();
    expect(unknown.requests).toHaveLength(3);
  });
});

describe("R20: the sync caller's retry record cannot be written", () => {
  test("control: with the record working, a sustained outage stops at the duration and stays stopped", async () => {
    const w = await engineWorld();
    script(w, 503);
    const n = await untilPaused(w);
    expect(n).toBeLessThanOrEqual(12);
    await w.advance(7_200_000);
    expect(w.requests).toHaveLength(n);
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
  });

  test("a failed write is the specified local-storage stop: immediate, uncounted, in the fallback marker, and nothing is asked again", async () => {
    const w = await engineWorld();
    script(w, 503);
    failRecord(w);
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.requests).toHaveLength(1);
    expect(
      w.markers.has(scopeOf(w.service.account), READ_RETRY_OPERATION),
    ).toBe(true);
    // Not counted: the streak of a local write is not touched, and no retry record exists.
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.sync().read_retry_states.sync).toBeUndefined();
    // Two simulated hours, every wake and an offline/online cycle: still one request.
    w.fire();
    await w.advance(3_600_000);
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.advance(3_600_000);
    w.engine.nudge("now");
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
  });

  test("the reviewer's schedule: an unrecognised answer with the record failing makes ONE request, not a stream of them", async () => {
    const w = await engineWorld();
    script(w, 418, 100);
    failRecord(w);
    w.start();
    await w.settle();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
  });

  test("a reload finds the stop in the account's marker and sends nothing; a restart of one engine keeps it", async () => {
    const w = await engineWorld();
    script(w, 503);
    failRecord(w);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.reload();
    w.start();
    await w.settle();
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
  });

  test("Try again clears exactly that stop and the caller's retry bounds apply again", async () => {
    const w = await engineWorld();
    script(w, 503);
    const off = failRecord(w);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    off();
    w.engine.retryNow();
    await w.settle();
    expect(
      w.markers.has(scopeOf(w.service.account), READ_RETRY_OPERATION),
    ).toBe(false);
    expect(w.requests.length).toBeGreaterThan(1);
    for (let i = 0; i < 90 && w.state().kind !== "paused"; i += 1)
      await w.advance(60_000);
    // The record is back: a sustained outage pauses it by duration as before.
    expect(w.state().kind).toBe("paused");
    expect(w.sync().read_retry_states.sync).toMatchObject({ paused: true });
    const n = w.requests.length;
    await w.advance(7_200_000);
    expect(w.requests).toHaveLength(n);
  });

  test("when the marker cannot be written either, the stop is held in this tab alone, says so, and a reload forgets it", async () => {
    const w = await engineWorld();
    script(w, 503);
    failRecord(w);
    w.markerStorage.failWrites = true;
    w.start();
    await w.settle();
    expect(w.state()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
    expect(w.requests).toHaveLength(1);
    w.fire();
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({ memoryOnly: true });
    // A reload is the one thing that forgets it: the disclosed limitation, said plainly by the notice above.
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(1);
  });

  test("a quota failure is the full storage it is: stopped at once as storage_full, no marker, and Retry now asks again", async () => {
    const w = await engineWorld();
    script(w, 503);
    const off = failRecord(w, "quota");
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "storage_full" });
    expect(w.requests).toHaveLength(1);
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(1);
    off();
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(1);
  });

  test("a write that cannot be VERIFIED (the persistence gate) is not a storage failure: the count stands in memory and the bound holds", async () => {
    const w = await engineWorld();
    script(w, 503);
    w.gate.mode = "unavailable";
    w.start();
    await w.settle();
    for (let i = 0; i < 90 && w.state().kind !== "paused"; i += 1)
      await w.advance(60_000);
    // Paused from the page's own count, with nothing durable and no storage stop.
    expect(w.state().kind).toBe("paused");
    expect(w.sync().read_retry_states.sync).toBeUndefined();
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
    const n = w.requests.length;
    expect(n).toBeLessThanOrEqual(12);
    w.fire();
    await w.advance(7_200_000);
    expect(w.requests).toHaveLength(n);
    // `online` ends a pause by duration here too.
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(n);
  });

  test("three unrecognised answers pause the caller from the page's own count when none can be verified, and only Retry now ends it", async () => {
    const w = await engineWorld();
    script(w, 418, 50);
    w.gate.mode = "unavailable";
    w.start();
    await w.settle();
    await w.advance(20_000);
    expect(w.requests).toHaveLength(3);
    expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    expect(w.requests).toHaveLength(3);
    w.gate.mode = "held";
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(3);
  });

  test("what the page counted while it could not be verified is carried into the record by the next write that lands (the clock is the first failure's)", async () => {
    const w = await engineWorld();
    script(w, 503, 10);
    w.gate.mode = "unavailable";
    w.start();
    await w.settle();
    const first = w.state();
    expect(first.kind).toBe("backing_off");
    const since = (first as { since: number }).since;
    await w.advance(2_000);
    w.gate.mode = "held";
    await w.advance(5_000);
    expect(w.sync().read_retry_states.sync).toMatchObject({
      backing_off_since: since,
      paused: false,
    });
  });

  test("a page that applies clears what only the page counted: the next outage starts its own clock", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.gate.mode = "unavailable";
    w.script.push(w.status(503), w.json(page()));
    w.start();
    await w.settle();
    // The first failure could not be recorded; the retry (2 s) applies a page, and the page's own count is gone with it.
    w.gate.mode = "held";
    await w.advance(3_000);
    expect(w.state().kind).toBe("idle");
    script(w, 503, 100);
    await w.advance(61_000);
    // A new outage begins at about 63 s. Had the earlier count survived, its clock (from 0 s) would pause the caller at about 180 s.
    await w.advance(130_000);
    expect(w.state().kind).toBe("backing_off");
    for (let i = 0; i < 20 && w.state().kind !== "paused"; i += 1)
      await w.advance(30_000);
    expect(w.state().kind).toBe("paused");
  });

  test("a stale or closed answer to the write is the engine moving on, never a count: it waits for the session", async () => {
    const w = await engineWorld();
    script(w, 503, 10);
    w.gate.mode = "stale";
    w.start();
    await w.settle();
    await w.advance(60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    expect(w.sync().read_retry_states.sync).toBeUndefined();
    // The count that belonged to a stamp that no longer stands is not kept: the next failure, with the gate back, starts its own clock.
    w.gate.mode = "held";
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.sync().read_retry_states.sync?.backing_off_since).toBe(
      EPOCH_BASE + w.env.world.time,
    );
  });
});

const alloc = (w: World, times = 20) => {
  for (let i = 0; i < times; i += 1) {
    const response = new Response("x");
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => {
        throw new RangeError("injected allocation failure");
      },
    });
    w.script.push(response);
  }
};

describe("R20: the sizing record cannot be written", () => {
  const failSizing = (w: World) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordSizingOutcome",
      mode: "error",
    });

  test("control: with the record working at the lowest rung the floor stops it after three", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    alloc(w);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(3);
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
  });

  test("the ladder cannot step and the floor cannot count: ONE request, then the specified stop, not a stream of identical allocations", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    alloc(w);
    failSizing(w);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.markers.has(scopeOf(w.service.account), SIZING_OPERATION)).toBe(
      true,
    );
    // Nothing more, whatever wakes it, until "Try again".
    w.fire();
    await w.advance(3_600_000);
    w.goOnline();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });

  test("when the sizing record AND its marker cannot be written, the stop is held in this tab alone, says so, and every wake leaves it (revision 29: the memory form of this stop, which only the marker form was tested for)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    alloc(w);
    failSizing(w);
    w.markerStorage.failWrites = true;
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({
      kind: "stopped",
      cause: "local_storage",
      memoryOnly: true,
    });
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
    w.fire();
    await w.advance(3_600_000);
    w.goOnline();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({ memoryOnly: true });
  });

  test("a reload keeps the stop; Try again lets the ladder move once the record can be written", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    alloc(w, 1);
    const off = failSizing(w);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    off();
    w.engine.retryNow();
    await w.settle();
    expect(w.markers.has(scopeOf(w.service.account), SIZING_OPERATION)).toBe(
      false,
    );
    expect(w.requests.length).toBeGreaterThan(1);
    expect(w.state().kind).not.toBe("stopped");
  });

  test("a sizing record that fails above the lowest rung stops the same way (the ladder is the counter)", async () => {
    const w = await engineWorld({
      cursor: "cursor-0",
      signals: { deviceMemoryGiB: 8, hasStorageEstimate: true },
    });
    alloc(w, 5);
    failSizing(w);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.sync().sizing.limit).toBeGreaterThan(1);
  });
});

/** A page that a bookkeeping failure must not disturb: the healthy path writes exactly what it always did. */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n), value: { n } },
});
const page = (): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: "cursor-1",
  batches: [{ revision: 3, changes: [upsert(1)] }],
});

describe("R20: the bookkeeping failures do not change the healthy path", () => {
  test("a failing retry record is never touched by a request that succeeds", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(w.json(page()));
    failRecord(w);
    w.start();
    await w.settle();
    expect(w.cache().map((row) => row.id)).toEqual([uuid(1)]);
    expect(w.sync()).toMatchObject({ cursor: "cursor-1" });
    expect(w.state().kind).toBe("idle");
    expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
  });
});

describe("a wake that arrives while a step runs never costs the step its own schedule (found in revision 9)", () => {
  /**
   * `tick` coalesces a wake that arrives while a step runs, and then used to leave its loop WITHOUT scheduling what the step had
   * decided (the loop's `continue` evaluated its condition after the flag had been cleared): after `online` during an outage the
   * first retry was made and the second never was, with the chip saying "trying again" and nothing on the clock. The one request
   * per `online` is by design (the existing resume tests hold it); what changed is that the step's own timer is set.
   */
  const held = (w: World) => {
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    return (response: Response) => release(response);
  };

  test("a back-off after a failure is scheduled although a wake arrived during the step", async () => {
    const w = await engineWorld();
    const release = held(w);
    script(w, 503, 10);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.fire();
    release(w.status(503));
    await w.settle();
    expect(w.state().kind).toBe("backing_off");
    expect(w.requests).toHaveLength(1);
    await w.advance(2_100);
    expect(w.requests).toHaveLength(2);
  });

  test("the idle poll after a healthy page is scheduled too", async () => {
    const w = await engineWorld();
    const release = held(w);
    w.start();
    await w.settle();
    w.fire();
    release(w.emptyPage("cursor-1"));
    await w.settle();
    expect(w.state().kind).toBe("idle");
    expect(w.requests).toHaveLength(1);
    await w.advance(61_000);
    expect(w.requests.length).toBeGreaterThan(1);
  });

  test("after an outage `online` resumes the caller and the retry chain CONTINUES: the next pause is by duration again", async () => {
    const w = await engineWorld();
    script(w, 503);
    await untilPaused(w);
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    const resumed = w.requests.length;
    for (let i = 0; i < 90 && w.state().kind !== "paused"; i += 1)
      await w.advance(60_000);
    expect(w.state().kind).toBe("paused");
    expect(w.requests.length).toBeGreaterThan(resumed);
  });
});

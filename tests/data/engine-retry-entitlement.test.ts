// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { recordLocalWriteOutcome } from "../../src/data/plans/retry-state";
import { CAPTURE_OPERATION } from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import {
  markerInstances,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";

/**
 * R53 (revision 32), the engine's half (S3): the person's "Try again" for a stopped sync step ends the failure that stood when it was
 * made, and a failure recorded after it, by another page's engine or the same one, is left.
 *
 * The engine's explicit retry ended its stopped operation in two records: the fallback marker (the instance it saw when the person
 * asked; revision 31, but with a removal that compared and then removed, R52) and the durable streak, reset by a second transaction that
 * knew nothing of which failure it was entitled to end. The streak is now reset on the version of the failure the engine had seen (the
 * capture gate's snapshot, or its own failure's transaction), so a failure recorded while the retry waits on the database is left, the
 * gate reads it at the next step, and the step stops again with nothing requested.
 *
 * FIXTURE evidence: the production engine, plans, guards and markers over the double of IndexedDB and of `localStorage`; the other
 * page's failure is the production plan or marker run by a second writer. Native two-page cases are E-O11.
 */
type World = Awaited<ReturnType<typeof engineWorld>>;
const STOPPED = { kind: "stopped", cause: "local_storage" } as const;

const failCapture = (w: World, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.captureRequest",
    mode: "error",
    times,
  });
const failCounter = (w: World, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.recordLocalWriteOutcome",
    mode: "error",
    times,
  });

const durableStop = async (): Promise<World> => {
  const w = await engineWorld({ cursor: "cursor-0" });
  failCapture(w, DATA_CONFIG.localWritePauseAfter);
  w.start();
  await w.settle();
  for (let i = 0; i < 6 && w.state().kind !== "stopped"; i += 1)
    await w.advance(1_000);
  expect(w.state()).toEqual(STOPPED);
  expect(w.requests).toHaveLength(0);
  expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 3 });
  return w;
};

const markerStop = async (): Promise<World> => {
  const w = await engineWorld({ cursor: "cursor-0" });
  failCapture(w, 1);
  failCounter(w, 1);
  w.start();
  await w.settle();
  expect(w.state()).toEqual(STOPPED);
  expect(w.markers.has(scopeOf(w.service.account), CAPTURE_OPERATION)).toBe(
    true,
  );
  return w;
};

type RunStore = {
  run: (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
};

/** Holds the START of the next reset of the durable failure state (a `success` outcome of the production plan) until `release()`. */
function holdReset(w: World) {
  const store = w.service.store as unknown as RunStore;
  const real = store.run.bind(store);
  let armed = true;
  let asked = 0;
  let run: () => void = () => undefined;
  store.run = (plan, input, options) => {
    const given = input as { outcome?: { kind: string } };
    if (
      !armed ||
      plan.name !== "data.recordLocalWriteOutcome" ||
      given.outcome?.kind !== "success"
    )
      return real(plan, input, options);
    armed = false;
    asked += 1;
    return new Promise((resolve, reject) => {
      run = () => {
        real(plan, input, options).then(resolve, reject);
      };
    });
  };
  return { asked: () => asked, release: () => run() };
}

const otherPageFails = async (
  w: World,
  operation: string,
  times: number,
): Promise<void> => {
  for (let i = 0; i < times; i += 1)
    await w.service.store.run(recordLocalWriteOutcome, {
      incarnationId: w.service.incarnationId,
      operation,
      outcome: { kind: "failure" },
    });
};

describe("R53 (engine): a durable stop is ended on the version the engine saw", () => {
  test("a failure another page records while the reset waits is left: the gate reads it at the next step and the step stops again, with nothing requested", async () => {
    const w = await durableStop();
    const hold = holdReset(w);
    w.engine.retryNow();
    await w.settle();
    expect(hold.asked()).toBe(1);
    await otherPageFails(w, CAPTURE_OPERATION, 1);
    expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 4 });
    hold.release();
    await w.settle();
    await w.advance(10_000);
    expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 4 });
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
  });

  test("control: nothing recorded meanwhile, the retry ends the stop it saw and the request goes", async () => {
    const w = await durableStop();
    const hold = holdReset(w);
    w.engine.retryNow();
    await w.settle();
    expect(hold.asked()).toBe(1);
    hold.release();
    await w.settle();
    await w.advance(10_000);
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
  });

  test("a stop restored after a reload is ended by the retry too (the gate's snapshot is the version it saw)", async () => {
    const w = await durableStop();
    w.reload();
    w.start();
    await w.settle();
    expect(w.state()).toEqual(STOPPED);
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
  });

  test("a failure that another page recorded after the gate read, before the person asked, is not ended by that first retry; the next does", async () => {
    const w = await durableStop();
    // The engine's snapshot is version V; another page fails the capture again (V'), with nothing that tells this page.
    await otherPageFails(w, CAPTURE_OPERATION, 1);
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    // The retry left V', the gate read it at the next step (it saw version V'), and the step stopped again.
    expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 4 });
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
  });
});

describe("R53 (engine): a marker stop is ended by the exact key the engine saw", () => {
  test("a marker another page records while the retry waits stands, and the step stops again", async () => {
    const w = await markerStop();
    const [older] = markerInstances(
      w.markerStorage,
      w.service.account,
      CAPTURE_OPERATION,
    );
    expect(older).toBeDefined();
    const hold = holdReset(w);
    w.engine.retryNow();
    await w.settle();
    // The older marker is gone at once (the act removed the key it saw); the reset is what is held.
    expect(
      markerInstances(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toEqual([]);
    plantMarker(
      w.markerStorage.page("another-tab").storage,
      w.service.account,
      CAPTURE_OPERATION,
      "tab.9",
    );
    hold.release();
    await w.settle();
    await w.advance(10_000);
    expect(
      markerInstances(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toEqual(["tab.9"]);
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
  });

  test("control: nothing recorded meanwhile, the marker is ended and the request goes", async () => {
    const w = await markerStop();
    w.engine.retryNow();
    await w.settle();
    await w.advance(10_000);
    expect(
      markerInstances(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toEqual([]);
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
  });

  test("a marker whose reads throw after the click is ended by its exact key, and a newer one that can no longer be read is not", async () => {
    const w = await markerStop();
    const hold = holdReset(w);
    w.engine.retryNow();
    await w.settle();
    plantMarker(
      w.markerStorage.page("another-tab").storage,
      w.service.account,
      CAPTURE_OPERATION,
      "tab.9",
    );
    w.markerStorage.failEnumeration = true;
    w.markerStorage.failGets = true;
    hold.release();
    await w.settle();
    await w.advance(10_000);
    w.markerStorage.failEnumeration = false;
    w.markerStorage.failGets = false;
    await w.advance(120_000);
    expect(
      markerInstances(w.markerStorage, w.service.account, CAPTURE_OPERATION),
    ).toEqual(["tab.9"]);
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
  });
});

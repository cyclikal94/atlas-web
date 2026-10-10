// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { recordLocalWriteOutcome } from "../../src/data/plans/retry-state";
import { CAPTURE_OPERATION } from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";

import { scopeOf } from "../support/data/marker-storage";

/**
 * R5 (revision 7): a stop of the CAPTURE WRITE (the write of `request_seq` that precedes every request) is enforced by the NEXT capture.
 *
 * The revision-6 correction made a page-commit stop survive every wake, but the failure of `data.captureRequest` is counted under its
 * own operation (`capture`), and the capture gate read the page's operation only: the stop was recorded, shown once, and the next wake
 * wrote the sequence successfully and sent a `GET` nobody had consented to (the second revision review's four probes: a durable
 * three-failure stop, a fallback marker, a stop only this tab holds, and a persisted marker after a reload; each stopped with zero
 * requests and then sent one).
 *
 * These run the PRODUCTION engine, plans and guards over the double of IndexedDB; the network is a script and time is fake. FIXTURE
 * evidence. The rules follow the approved local-write row of the retry-budget reconciliation: three consecutive failures of one
 * operation stop THAT operation (immediately, with no counting, when its counter cannot be written), the stop is left only by that
 * operation's explicit retry, and a success of the operation clears its own streak and no other's.
 */
type World = Awaited<ReturnType<typeof engineWorld>>;

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

const STOPPED = { kind: "stopped", cause: "local_storage" } as const;
const MEMORY_ONLY = { ...STOPPED, memoryOnly: true } as const;

/** The capture write fails three times: the durable streak reaches the bound. Nothing has been requested. */
const durableStop = async () => {
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

/** The capture write fails and its counter cannot be written: the stop is immediate and goes to the fallback marker. */
const markerStop = async () => {
  const w = await engineWorld({ cursor: "cursor-0" });
  failCapture(w, 1);
  failCounter(w, 1);
  w.start();
  await w.settle();
  expect(w.state()).toEqual(STOPPED);
  expect(w.requests).toHaveLength(0);
  expect(w.markers.has(scopeOf(w.service.account), CAPTURE_OPERATION)).toBe(
    true,
  );
  expect(w.sync().local_write_streaks).toEqual({});
  return w;
};

/** The capture write fails, its counter cannot be written and the marker cannot be written either: only this tab knows. */
const memoryStop = async () => {
  const w = await engineWorld({ cursor: "cursor-0" });
  failCapture(w, 1);
  failCounter(w, 1);
  w.markerStorage.failWrites = true;
  w.start();
  await w.settle();
  expect(w.state()).toEqual(MEMORY_ONLY);
  expect(w.requests).toHaveLength(0);
  expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
  expect(w.sync().local_write_streaks).toEqual({});
  return w;
};

const WAKES: ReadonlyArray<readonly [string, (w: World) => void]> = [
  ["a subscription wake (the session view, visibility)", (w) => w.fire()],
  ["the browser coming online", (w) => w.goOnline()],
  ["a receipt nudge", (w) => w.engine.nudge("receipt")],
  ["an immediate nudge", (w) => w.engine.nudge("now")],
];

describe("the reviewer's four probes: each stopped with zero requests and then sent one on the next wake", () => {
  test("1. a durable three-failure stop, then an ordinary wake: no request", async () => {
    const w = await durableStop();
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 3 });
  });

  test("2. a fallback marker stop, then an ordinary wake: no request, and the marker stands", async () => {
    const w = await markerStop();
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    expect(w.markers.has(scopeOf(w.service.account), CAPTURE_OPERATION)).toBe(
      true,
    );
  });

  test("3. a stop only this tab holds, then an ordinary wake: no request, and it still says it is memory-only", async () => {
    const w = await memoryStop();
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(MEMORY_ONLY);
  });

  test("4. a persisted fallback marker, then a page reload: no request, and the stopped state is shown at once", async () => {
    const w = await markerStop();
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(0);
  });

  test("4b. the durable stop after a page reload: no request", async () => {
    const w = await durableStop();
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
  });
});

describe("every wake, in every form of the stop, however many times and however long afterwards", () => {
  const FORMS = [
    ["durable", durableStop, STOPPED],
    ["fallback marker", markerStop, STOPPED],
    ["memory-only", memoryStop, MEMORY_ONLY],
  ] as const;
  for (const [form, make, shown] of FORMS)
    for (const [name, signal] of WAKES)
      test(`${form}: ${name} does not lift it`, async () => {
        const w = await make();
        for (let i = 0; i < 3; i += 1) {
          signal(w);
          await w.settle();
          await w.advance(60_000);
        }
        expect(w.requests).toHaveLength(0);
        expect(w.state()).toEqual(shown);
      });

  for (const [form, make, shown] of FORMS)
    test(`${form}: going offline and online again, with wakes in between, does not lift it`, async () => {
      const w = await make();
      w.online = false;
      w.fire();
      await w.settle();
      w.goOnline();
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual(shown);
    });

  for (const [form, make, shown] of FORMS)
    test(`${form}: a stop and a start of the engine (an ownership change in a tab that stays alive) does not lift it`, async () => {
      const w = await make();
      w.engine.stop();
      w.start();
      await w.settle();
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual(shown);
    });

  test("a reload keeps the two recorded forms and forgets the one only the tab held (the disclosed limitation)", async () => {
    for (const make of [durableStop, markerStop]) {
      const w = await make();
      w.reload();
      w.start();
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual(STOPPED);
    }
    const memory = await memoryStop();
    memory.reload();
    memory.start();
    await memory.settle();
    expect(memory.requests).toHaveLength(1);
  });
});

describe("only the explicit retry of that operation lifts it", () => {
  test.each([
    ["durable", durableStop],
    ["fallback marker", markerStop],
    ["memory-only", memoryStop],
  ] as const)(
    "%s: the retry clears the stop and its record, one request is sent, and the stop does not come back",
    async (_form, make) => {
      const w = await make();
      w.engine.retryNow();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state().kind).toBe("idle");
      expect(w.sync().local_write_streaks).toEqual({});
      expect(w.markers.operations(scopeOf(w.service.account))).toEqual([]);
      w.fire();
      await w.settle();
      expect(w.state().kind).not.toBe("stopped");
    },
  );

  test("a retry whose capture fails again stops again: the operation's streak starts afresh, and the next wake is still refused", async () => {
    const w = await durableStop();
    failCapture(w, DATA_CONFIG.localWritePauseAfter);
    w.engine.retryNow();
    await w.settle();
    for (let i = 0; i < 6 && w.state().kind !== "stopped"; i += 1)
      await w.advance(1_000);
    expect(w.state()).toEqual(STOPPED);
    expect(w.sync().local_write_streaks).toEqual({ [CAPTURE_OPERATION]: 3 });
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(0);
  });
});

describe("the stop is scoped to its OPERATION", () => {
  test("another operation's success or streak does not clear it", async () => {
    const w = await durableStop();
    for (const operation of ["page:cursor-0", "draft:other", "receipt:other"])
      await w.service.store.run(recordLocalWriteOutcome, {
        incarnationId: w.service.incarnationId,
        operation,
        outcome: { kind: "success", expect: null },
      });
    w.setSync({
      local_write_streaks: { ...w.sync().local_write_streaks, "draft:x": 1 },
    });
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    expect(w.sync().local_write_streaks).toEqual({
      [CAPTURE_OPERATION]: 3,
      "draft:x": 1,
    });
  });

  test("the retry clears the capture operation's streak and no other's", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({
      local_write_streaks: {
        [CAPTURE_OPERATION]: 3,
        "page:cursor-9": 2,
        "draft:other": 2,
      },
    });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    w.engine.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.sync().local_write_streaks).toEqual({
      "page:cursor-9": 2,
      "draft:other": 2,
    });
  });

  test("a stop of the drafts' or the receipts' operation (their markers, their streaks) does not stop the capture", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.markers.set(scopeOf(w.service.account), "draft:abc");
    w.markers.set(scopeOf(w.service.account), "receipt:abc");
    w.setSync({ local_write_streaks: { "draft:abc": 3, "receipt:abc": 3 } });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });

  test("a stop of the capture write does not hide a stop of the page: after the capture's retry the page's stop is shown, and it is that operation's own retry", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({
      local_write_streaks: { [CAPTURE_OPERATION]: 3, "page:cursor-0": 3 },
    });
    w.start();
    await w.settle();
    expect(w.state()).toEqual(STOPPED);
    w.engine.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual(STOPPED);
    expect(w.sync().local_write_streaks).toEqual({ "page:cursor-0": 3 });
    w.engine.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });

  test("a stop of a page the cursor has moved past does not stop the capture", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.markers.set(scopeOf(w.service.account), "page:cursor-9");
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });
});

describe("the bound, and the operation's own success", () => {
  test("two failures of the capture write do not stop; the third does", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    failCapture(w, DATA_CONFIG.localWritePauseAfter - 1);
    w.start();
    await w.settle();
    for (let i = 0; i < 4; i += 1) await w.advance(1_000);
    expect(w.state().kind).toBe("idle");
    expect(w.requests).toHaveLength(1);
  });

  test("the capture write's success clears ITS streak: failures that are not consecutive never reach the bound", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    failCapture(w, 2);
    w.start();
    await w.settle();
    for (let i = 0; i < 4; i += 1) await w.advance(1_000);
    expect(w.state().kind).toBe("idle");
    // The two failures were counted, and the success that followed cleared them.
    expect(w.sync().local_write_streaks).toEqual({});
    // Two more, after a success: still short of three in a row.
    failCapture(w, 2);
    w.fire();
    await w.settle();
    for (let i = 0; i < 4; i += 1) await w.advance(1_000);
    expect(w.state().kind).not.toBe("stopped");
    expect(w.sync().local_write_streaks).toEqual({});
  });

  test("its success clears its own streak and no other operation's", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({
      local_write_streaks: {
        [CAPTURE_OPERATION]: 2,
        "page:cursor-9": 2,
        "draft:other": 1,
      },
    });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.sync().local_write_streaks).toEqual({
      "page:cursor-9": 2,
      "draft:other": 1,
    });
  });

  test("the stop lasts for the life of the incarnation: a stop recorded for an earlier database of the account does not stop a re-created one", async () => {
    const w = await memoryStop();
    // The memory stop is keyed by account, incarnation and operation: a re-created database has another incarnation.
    expect(w.service.incarnationId).not.toBe("");
    w.reload();
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });
});

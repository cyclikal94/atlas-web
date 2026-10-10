// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import type { EngineState } from "../../src/data/engine/sync-engine";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../src/data/scan/validate";
import {
  type AllocationSite,
  type FaultKind,
  injectFault,
  restoreFaults,
  type ScanSite,
} from "../support/data/allocation-faults";
import { engineWorld } from "../support/data/engine-world";
import { draftRow } from "../support/data/rows";
import { type PageSpec, uuid } from "../support/data/sync-pages";

/**
 * R44 (revision 24), through the production engine, plans and the double of IndexedDB. The invariant: an allocation failure observed
 * while processing a page the contract allows, at ANY stage from the response body to the end of the commit, is one signal about the
 * DEVICE: it steps the ladder down (one rung, automatically), it counts toward the floor only at the lowest rung, and it is never read
 * as malformed data (the unrecognised-response budget), as a storage fault (the local-storage stop) or as a defect of a step. A
 * malformed page keeps its own classification, and the run, ownership, hold and marker checks are unchanged.
 *
 * The failures are NAMED injections at one site of the production scanner or decoder (`tests/support/data/allocation-faults.ts`): they
 * test the handling of the exception, not a physical memory-exhaustion measurement. Every case asserts its PREMISE (the fault fired, at
 * the scanner or the decoder, as many times as intended) before it asserts a consequence.
 */
const big = { deviceMemoryGiB: 8, hasStorageEstimate: true } as const;
const CURSOR = "after-page";

const change = (n: number, filler = 0) => ({
  kind: "upsert" as const,
  resource: {
    id: uuid(n),
    kind: "person",
    parent_id: null,
    label: `Person ${n}`,
    value: filler > 0 ? { filler: "x".repeat(filler) } : { n },
    version: 1,
    can_edit: true,
    archived: false,
  },
});
const pageOf = (count: number, filler = 0): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: CURSOR,
  batches: [
    {
      revision: 1,
      changes: Array.from({ length: count }, (_, i) => change(i + 1, filler)),
    },
  ],
});
/** Few changes: the scan's arrays stay at their initial length. */
const SMALL = 3;
/** More than 512 changes: the scan's arrays grow once. */
const GROWN = 520;
/** At least `markerMinBytes`: the attempt writes the crash-loop marker before it commits. */
const BULKY = { count: 12, filler: 30_000 };

type World = Awaited<ReturnType<typeof engineWorld>>;
const limits = (w: World) =>
  w.requests.map((u) => Number(u.searchParams.get("limit")));
const cursors = (w: World) =>
  w.requests.map((u) => u.searchParams.get("cursor"));
const retry = (w: World) => w.sync().read_retry_states.sync;
const track = (w: World): EngineState[] => {
  const seen: EngineState[] = [];
  w.engine.state.subscribe(() => seen.push(w.engine.state.get()));
  return seen;
};
const ids = (w: World) =>
  w
    .cache()
    .map((r) => r.id)
    .sort();
const expectedIds = (count: number) =>
  Array.from({ length: count }, (_, i) => uuid(i + 1)).sort();
const labels = (w: World) =>
  w.env.world.logs
    .filter((e) => e.type === "idb.commit" && e.wrote === true)
    .map((e) => e.label);
/** The scanner's or the decoder's own frames: the fault fired where it was meant to. */
const SCANNER = /src\/data\/scan\/scan\.ts/;
const DECODER = /src\/data\/scan\/validate\.ts/;

/**
 * Settles the world and asserts that it SETTLED: an engine that asks again at once, without bound, never lets the world reach idle (the
 * world says so with an error). That is a finding of these cases (the failure is bounded, or it is not), so it is recorded and
 * asserted, not left to end the test by an error.
 */
const settleBounded = async (w: World): Promise<void> => {
  let reached = true;
  try {
    await w.settle();
  } catch {
    reached = false;
  }
  expect(
    reached,
    "the engine reaches a terminal state: it does not ask again at once without bound",
  ).toBe(true);
};

afterEach(() => {
  restoreFaults();
});

describe("R44: an allocation failure anywhere in the scan steps the ladder down and the same position is asked for again", () => {
  const SITES: Array<{ site: ScanSite; count: number; grown: boolean }> = [
    { site: "offsets.initial", count: SMALL, grown: false },
    { site: "nodes.initial", count: SMALL, grown: false },
    { site: "offsets.growth", count: GROWN, grown: true },
    { site: "nodes.growth", count: GROWN, grown: true },
    { site: "offsets.copy", count: SMALL, grown: false },
    { site: "nodes.copy", count: SMALL, grown: false },
    { site: "offsets.copy", count: GROWN, grown: true },
    { site: "nodes.copy", count: GROWN, grown: true },
  ];
  test.each(SITES)(
    "$site ($count changes): 4 -> 2, the page commits whole at the smaller size, the run never stops and nothing is counted as data or storage",
    async ({ site, count, grown }) => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      const states = track(w);
      const fault = injectFault(site, { grown });
      w.script.push(w.json(pageOf(count)), w.json(pageOf(count)));
      w.start();
      await w.settle();
      expect(fault.hits).toBe(1);
      expect(fault.stacks[0]).toMatch(SCANNER);
      expect(limits(w)).toEqual([4, 2]);
      expect(cursors(w)).toEqual(["cursor-0", "cursor-0"]);
      expect(ids(w)).toEqual(expectedIds(count));
      expect(w.sync()).toMatchObject({
        cursor: CURSOR,
        page_seq: 1,
        sizing: {
          limit: 2,
          class: "unconstrained",
          floor_hits: 0,
          attempt: null,
        },
        local_write_streaks: {},
      });
      expect(retry(w)?.unrecognised_streak ?? 0).toBe(0);
      expect(states.some((s) => s.kind === "stopped")).toBe(false);
      expect(w.state().kind).toBe("idle");
      // One landed commit: the failed attempt wrote nothing.
      expect(labels(w).filter((l) => l === "data.commitPage")).toHaveLength(1);
    },
  );

  test.each([
    "key.decode",
    "key.parse",
    "cursor.decode",
    "cursor.parse",
  ] as const)(
    "the decoding of a small token (%s) is the same signal",
    async (site) => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      const fault = injectFault(site, { cursor: CURSOR });
      w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
      w.start();
      await w.settle();
      expect(fault.hits).toBe(1);
      expect(fault.stacks[0]).toMatch(SCANNER);
      expect(limits(w)).toEqual([4, 2]);
      expect(ids(w)).toEqual(expectedIds(SMALL));
      expect(w.sync()).toMatchObject({
        cursor: CURSOR,
        sizing: { limit: 2, floor_hits: 0, attempt: null },
      });
      expect(retry(w)?.unrecognised_streak ?? 0).toBe(0);
      expect(w.state().kind).toBe("idle");
    },
  );
});

describe("R44: an allocation failure while decoding or validating an element, inside the commit, is the same signal", () => {
  test.each(["change.decode", "change.parse"] as const)(
    "%s: 4 -> 2, the valid page is NOT asked for again at the unchanged size and counts nothing as unrecognised",
    async (site) => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      const fault = injectFault(site);
      w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
      w.start();
      await w.settle();
      expect(fault.hits).toBe(1);
      expect(fault.stacks[0]).toMatch(DECODER);
      expect(limits(w)).toEqual([4, 2]);
      expect(ids(w)).toEqual(expectedIds(SMALL));
      expect(w.sync()).toMatchObject({
        cursor: CURSOR,
        page_seq: 1,
        sizing: { limit: 2, floor_hits: 0, attempt: null },
      });
      expect(retry(w)?.unrecognised_streak ?? 0).toBe(0);
      expect(w.state().kind).toBe("idle");
    },
  );

  test("a REMOVE element's decoding fails the same way", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const page: PageSpec = {
      ...pageOf(1),
      batches: [
        {
          revision: 1,
          changes: [change(1), { kind: "remove" as const, id: uuid(77) }],
        },
      ],
    };
    // The first element matches `{"kind":` as well: skip it, so that the failing decode is the remove's.
    const fault = injectFault("change.decode", { skip: 1 });
    w.script.push(w.json(page), w.json(page));
    w.start();
    await w.settle();
    expect(fault.hits).toBe(1);
    expect(limits(w)).toEqual([4, 2]);
    expect(w.sync().sizing).toMatchObject({ limit: 2, floor_hits: 0 });
    expect(w.state().kind).toBe("idle");
  });

  test("a kind validator that runs out of memory is the device's signal, not 'validator_failed' (invalid data)", async () => {
    const validators = createValueValidators();
    let failures = 1;
    validators.register("person", () => {
      if (failures > 0) {
        failures -= 1;
        throw new RangeError("named validator allocation failure");
      }
      return true;
    });
    const w = await engineWorld({
      signals: big,
      cursor: "cursor-0",
      decode: { validators, derivers: createKeyDerivers() },
    });
    w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    expect(failures).toBe(0);
    expect(limits(w)).toEqual([4, 2]);
    expect(ids(w)).toEqual(expectedIds(SMALL));
    expect(retry(w)?.unrecognised_streak ?? 0).toBe(0);
    expect(w.sync().sizing).toMatchObject({ limit: 2, floor_hits: 0 });
  });

  test("a validator's ORDINARY defect is still not a storage fault and still invalid data (control)", async () => {
    const validators = createValueValidators();
    validators.register("person", () => {
      throw new Error("a defect of the registrant");
    });
    const w = await engineWorld({
      signals: big,
      cursor: "cursor-0",
      decode: { validators, derivers: createKeyDerivers() },
    });
    w.script.push(w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4]);
    expect(retry(w)?.unrecognised_streak).toBe(1);
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    expect(w.state().kind).toBe("backing_off");
  });

  test("a key deriver that runs out of memory is the device's signal too (it is not caught on the way)", async () => {
    const derivers = createKeyDerivers();
    let failures = 1;
    derivers.register("person", () => {
      if (failures > 0) {
        failures -= 1;
        throw new RangeError("named deriver allocation failure");
      }
      return null;
    });
    const w = await engineWorld({
      signals: big,
      cursor: "cursor-0",
      decode: { validators: createValueValidators(), derivers },
    });
    w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    expect(failures).toBe(0);
    expect(limits(w)).toEqual([4, 2]);
    expect(w.sync().sizing).toMatchObject({ limit: 2, floor_hits: 0 });
    expect(ids(w)).toEqual(expectedIds(SMALL));
  });
});

describe("R44 with R42: a large page's attempt marker is retired by the failed attempt, so the ladder steps ONE rung", () => {
  test.each(["change.decode", "change.parse"] as const)(
    "%s on a page over markerMinBytes: 4 -> 2 (not 4 -> 1), the marker is gone and the next attempt leaves none",
    async (site) => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      const page = pageOf(BULKY.count, BULKY.filler);
      const fault = injectFault(site);
      w.script.push(w.json(page), w.json(page));
      w.start();
      await settleBounded(w);
      expect(JSON.stringify(page).length).toBeGreaterThan(
        DATA_CONFIG.markerMinBytes,
      );
      expect(fault.hits).toBe(1);
      expect(limits(w)).toEqual([4, 2]);
      // Two attempts wrote a marker; the failed one retired its own, the landed one cleared its in its own transaction.
      expect(
        labels(w).filter((l) => l === "data.recordSizingAttempt"),
      ).toHaveLength(2);
      expect(
        labels(w).filter((l) => l === "data.retireSizingAttempt"),
      ).toHaveLength(1);
      expect(w.sync().sizing).toMatchObject({
        limit: 2,
        floor_hits: 0,
        attempt: null,
      });
      expect(ids(w)).toEqual(expectedIds(BULKY.count));
      expect(w.state().kind).toBe("idle");
    },
  );

  test("the lowest rung: three failed attempts are three counts (a marker left behind would be a fourth and fifth)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    const page = pageOf(BULKY.count, BULKY.filler);
    const fault = injectFault("change.decode", { times: 10_000 });
    for (let i = 0; i < 8; i += 1) w.script.push(w.json(page));
    w.start();
    await settleBounded(w);
    expect(fault.hits).toBe(DATA_CONFIG.floorAfter);
    expect(limits(w)).toEqual([1, 1, 1]);
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    expect(w.sync().sizing).toMatchObject({
      limit: 1,
      floor_hits: DATA_CONFIG.floorAfter,
      attempt: null,
    });
    expect(w.cache()).toEqual([]);
  });
});

describe("R44: a failure part-way through a page rolls the whole page back", () => {
  test("the 251st element's decoding fails after 200 rows were streamed into the transaction: nothing of that attempt lands, the retry commits all 300 once", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const fault = injectFault("change.decode", { skip: 250 });
    w.script.push(w.json(pageOf(300)), w.json(pageOf(300)));
    w.start();
    await settleBounded(w);
    expect(fault.hits).toBe(1);
    expect(limits(w)).toEqual([4, 2]);
    expect(ids(w)).toEqual(expectedIds(300));
    expect(w.sync()).toMatchObject({ cursor: CURSOR, page_seq: 1 });
    expect(labels(w).filter((l) => l === "data.commitPage")).toHaveLength(1);
  });

  test("a persistent mid-page failure leaves the cache, the position and the drafts exactly as they were", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.put("drafts", [draftRow({ local_id: "d1", status: "queued" })]);
    const fault = injectFault("change.parse", { skip: 250, times: 10_000 });
    for (let i = 0; i < 8; i += 1) w.script.push(w.json(pageOf(300)));
    w.start();
    await settleBounded(w);
    expect(fault.hits).toBeGreaterThanOrEqual(DATA_CONFIG.floorAfter);
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    expect(w.cache()).toEqual([]);
    expect(w.sync()).toMatchObject({ cursor: "cursor-0", page_seq: 0 });
    expect(w.rows("drafts")).toHaveLength(1);
  });
});

describe("R44: repeated allocation failure is bounded exhaustion, and 'Try again' starts the count again", () => {
  const PERSISTENT: Array<{
    site: AllocationSite;
    grown?: boolean;
    count: number;
  }> = [
    { site: "offsets.initial", count: SMALL },
    { site: "nodes.copy", count: SMALL },
    { site: "offsets.growth", count: GROWN, grown: true },
    { site: "key.decode", count: SMALL },
    { site: "cursor.parse", count: SMALL },
    { site: "change.decode", count: SMALL },
    { site: "change.parse", count: SMALL },
  ];

  test.each(PERSISTENT)(
    "$site at the lowest rung (no device-memory signal): FLOOR_AFTER attempts, then `stopped / floor`, and nothing else is touched",
    async ({ site, count, grown }) => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("drafts", [draftRow({ local_id: "d1", status: "queued" })]);
      const fault = injectFault(site, {
        times: 10_000,
        cursor: CURSOR,
        ...(grown ? { grown } : {}),
      });
      for (let i = 0; i < 8; i += 1) w.script.push(w.json(pageOf(count)));
      w.start();
      await settleBounded(w);
      expect(fault.hits).toBeGreaterThanOrEqual(DATA_CONFIG.floorAfter);
      expect(limits(w)).toEqual([1, 1, 1]);
      expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
      expect(w.sync()).toMatchObject({
        cursor: "cursor-0",
        page_seq: 0,
        sizing: { limit: 1, floor_hits: DATA_CONFIG.floorAfter, attempt: null },
        local_write_streaks: {},
      });
      expect(retry(w)?.unrecognised_streak ?? 0).toBe(0);
      expect(w.cache()).toEqual([]);
      expect(w.rows("drafts")).toHaveLength(1);
      // Terminal until the person asks: nothing is requested however long it waits.
      await w.advance(10 * 60_000);
      expect(w.requests).toHaveLength(DATA_CONFIG.floorAfter);
    },
  );

  test.each(["offsets.initial", "change.decode"] as const)(
    "%s from the device's first rung: 4 -> 2 -> 1, then three at the lowest rung",
    async (site) => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      injectFault(site, { times: 10_000 });
      for (let i = 0; i < 8; i += 1) w.script.push(w.json(pageOf(SMALL)));
      w.start();
      await settleBounded(w);
      expect(limits(w)).toEqual([4, 2, 1, 1, 1]);
      expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
      expect(w.sync().sizing).toMatchObject({
        limit: 1,
        floor_hits: DATA_CONFIG.floorAfter,
      });
    },
  );

  test.each(["offsets.copy", "change.parse"] as const)(
    "%s: 'Try again' resets the count and asks again; a success then clears everything, and the same page commits whole",
    async (site) => {
      const w = await engineWorld({ cursor: "cursor-0" });
      injectFault(site, { times: 10_000 });
      for (let i = 0; i < 8; i += 1) w.script.push(w.json(pageOf(SMALL)));
      w.start();
      await settleBounded(w);
      expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
      restoreFaults();
      w.engine.retryNow();
      await settleBounded(w);
      expect(w.state().kind).toBe("idle");
      expect(w.sync()).toMatchObject({
        cursor: CURSOR,
        sizing: { limit: 1, floor_hits: 0, attempt: null },
      });
      expect(ids(w)).toEqual(expectedIds(SMALL));
    },
  );

  test("'Try again' with the failure still there: exactly FLOOR_AFTER more attempts (the count really restarted), then the floor again", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    injectFault("nodes.initial", { times: 10_000 });
    for (let i = 0; i < 12; i += 1) w.script.push(w.json(pageOf(SMALL)));
    w.start();
    await settleBounded(w);
    expect(limits(w)).toEqual([1, 1, 1]);
    w.engine.retryNow();
    await settleBounded(w);
    expect(limits(w)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    expect(w.sync().sizing).toMatchObject({
      limit: 1,
      floor_hits: DATA_CONFIG.floorAfter,
    });
  });

  test("a floor reached in the scan is durable: a restarted engine on the same database is still stopped, with no request", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    injectFault("offsets.initial", { times: 10_000 });
    for (let i = 0; i < 8; i += 1) w.script.push(w.json(pageOf(SMALL)));
    w.start();
    await settleBounded(w);
    const issued = w.requests.length;
    w.engine.stop();
    w.start();
    await settleBounded(w);
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    expect(w.requests).toHaveLength(issued);
  });

  test("a success after failures at the lowest rung clears the count (an allocation failure from the scan, then a healthy page)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    injectFault("offsets.initial", { times: 2 });
    for (let i = 0; i < 4; i += 1) w.script.push(w.json(pageOf(SMALL)));
    w.start();
    await settleBounded(w);
    expect(limits(w)).toEqual([1, 1, 1]);
    expect(w.state().kind).toBe("idle");
    expect(w.sync().sizing).toMatchObject({
      limit: 1,
      floor_hits: 0,
      attempt: null,
    });
    expect(ids(w)).toEqual(expectedIds(SMALL));
  });
});

describe("R44 controls: malformed data keeps its own classification, and a healthy page does not step down", () => {
  test("a healthy page: one request at the device's rung, nothing counted", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.script.push(w.json(pageOf(GROWN)));
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4]);
    expect(w.sync().sizing).toMatchObject({
      limit: 4,
      floor_hits: 0,
      attempt: null,
    });
    expect(ids(w)).toEqual(expectedIds(GROWN));
  });

  test("a response body that cannot be allocated still steps down (the existing path, unchanged)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const unreadable = new Response("x");
    Object.defineProperty(unreadable, "arrayBuffer", {
      value: async () => {
        throw new RangeError("Array buffer allocation failed");
      },
    });
    w.script.push(unreadable, w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4, 2]);
    expect(ids(w)).toEqual(expectedIds(SMALL));
  });

  const MALFORMED: Array<{ site: AllocationSite; kind: FaultKind }> = [
    { site: "key.decode", kind: "syntax" },
    { site: "key.decode", kind: "utf8" },
    { site: "key.parse", kind: "syntax" },
    { site: "cursor.parse", kind: "syntax" },
    { site: "cursor.decode", kind: "utf8" },
    { site: "change.decode", kind: "syntax" },
    { site: "change.decode", kind: "utf8" },
    { site: "change.parse", kind: "syntax" },
    { site: "change.parse", kind: "utf8" },
  ];
  test.each(MALFORMED)(
    "a $kind fault at $site is a fault of the DATA: the unrecognised budget counts it, the ladder does not move, and the same size is asked for again",
    async ({ site, kind }) => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      const fault = injectFault(site, { kind, cursor: CURSOR });
      w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
      w.start();
      await w.settle();
      expect(fault.hits).toBe(1);
      expect(limits(w)).toEqual([4]);
      expect(retry(w)?.unrecognised_streak).toBe(1);
      expect(w.sync().sizing).toMatchObject({
        limit: 4,
        floor_hits: 0,
        attempt: null,
      });
      expect(w.state().kind).toBe("backing_off");
      await w.advance(5_000);
      expect(limits(w)).toEqual([4, 4]);
      expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
      expect(retry(w)?.unrecognised_streak ?? 0).toBe(0);
      expect(w.state().kind).toBe("idle");
      expect(ids(w)).toEqual(expectedIds(SMALL));
    },
  );

  test("a page that stays malformed ends at `unrecognised` after the budget, never at the floor: the two terminal states are not mixed", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    injectFault("change.parse", { kind: "syntax", times: 10_000 });
    for (let i = 0; i < 6; i += 1) w.script.push(w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    await w.advance(60_000);
    expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
    expect(limits(w)).toEqual(
      Array(DATA_CONFIG.unrecognisedPauseAfter).fill(4),
    );
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    expect(w.cache()).toEqual([]);
  });

  test("a REAL invalid UTF-8 byte inside an element (no injection) is invalid data, as before", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const text = JSON.stringify(pageOf(SMALL)).replace("Person 1", "PersonZZ1");
    const bytes = new TextEncoder().encode(text);
    const at = text.indexOf("ZZ");
    bytes[at] = 0xff;
    bytes[at + 1] = 0xfe;
    for (let i = 0; i < 4; i += 1)
      w.script.push(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4]);
    expect(retry(w)?.unrecognised_streak).toBe(1);
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    expect(w.cache()).toEqual([]);
  });

  test("a REAL syntax fault in the document (no injection) is invalid data, as before", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.script.push(
      new Response('{"phase":"delta","batches":[', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4]);
    expect(retry(w)?.unrecognised_streak).toBe(1);
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
  });

  test("a defect that is neither an allocation failure nor invalid data still reaches the loop's own stop: it is not a sizing signal", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const fault = injectFault("offsets.initial", { kind: "defect" });
    w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    expect(fault.hits).toBe(1);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(limits(w)).toEqual([4]);
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
  });
});

describe("R44: the run, ownership and hold checks are unchanged", () => {
  const ended = async (during: "body" | "scan") => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const fault = during === "scan" ? injectFault("offsets.initial") : null;
    const response = w.json(pageOf(SMALL));
    const read = response.arrayBuffer.bind(response);
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => {
        // The run ends while the body is being read.
        w.engine.stop();
        if (during === "body")
          throw new RangeError("Array buffer allocation failed");
        return read();
      },
    });
    w.script.push(response);
    w.start();
    await w.settle();
    await w.advance(10 * 60_000);
    return { w, fault };
  };

  test("a run that ended while its response was read publishes nothing when the SCAN fails: not a `stopped` over a `not_started`, and no further request", async () => {
    const { w, fault } = await ended("scan");
    expect(fault?.hits).toBe(1);
    expect(w.state()).toEqual({ kind: "not_started" });
    expect(limits(w)).toEqual([4]);
  });

  test("and the same as the body read's failure (the two stages agree)", async () => {
    const scan = await ended("scan");
    const body = await ended("body");
    expect(body.w.state()).toEqual(scan.w.state());
    expect(limits(body.w)).toEqual(limits(scan.w));
    expect(body.w.sync().sizing).toEqual(scan.w.sync().sizing);
  });

  test("a scan failure, then a page another leader's commit guard refuses: the owner check still stops it, one rung down and nothing else", async () => {
    const w = await engineWorld({
      signals: big,
      cursor: "cursor-0",
      ownerToken: "tok-OLD",
    });
    w.setSync({
      owner: { tab_id: "t", ownership_token: "tok-NEW", heartbeat_at: 1 },
    });
    injectFault("offsets.initial");
    w.script.push(w.json(pageOf(SMALL)), w.json(pageOf(SMALL)));
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4, 2]);
    expect(w.cache()).toEqual([]);
    expect(w.sync()).toMatchObject({
      cursor: "cursor-0",
      sizing: { limit: 2, floor_hits: 0, attempt: null },
    });
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
  });
});

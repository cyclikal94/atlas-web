// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  admissionBytesFor,
  DATA_CONFIG,
  maxResponseBytesFor,
} from "../../src/data/model/config";
import { engineWorld } from "../support/data/engine-world";
import { recoveryWorld } from "../support/data/recovery-world";

/**
 * R21-QUOTA (WEB-09c revision 21): the quota check before a delta request judges the response THAT request may bring. With `max_changes = m`
 * the response holds at most `m` changes whatever the limit (BE-Q23 §1), so the estimate is `m`'s; without the parameter (no budget, a
 * snapshot, or a continuation sent without one) the whole-batch estimate stands. Both callers (the sync engine and the recovery job's
 * catch-up) through the PRODUCTION engine/job, plans and the REAL quota guard over the double of IndexedDB; the free space is a declared
 * `navigator.storage.estimate()` value (not disk exhaustion) and the server a script against BE-Q23's PROVISIONAL contract.
 *
 * The boundaries are exact (`free < reserve + estimate` refuses): at `R + E` the request is issued, at `R + E - 1` none is, so any other
 * estimate (the whole-batch one, `m × limit`, the configured `m` where a stepped one is in force, the default configuration) fails one side.
 */

const MIB = 1024 * 1024;
const R = DATA_CONFIG.quotaReserveBytes;
/**
 * The test's OWN arithmetic of a response bounded by `m` changes (the contract's count with the configured per-change bytes, margin and
 * envelope), independent of `admissionBytesFor`, so that the callers' boundaries do not move with the code they test.
 */
const bounded = (
  m: number,
  c: {
    bytesPerChange: number;
    responseMargin: number;
    responseOverhead: number;
  } = DATA_CONFIG,
): number =>
  Math.ceil(m * c.bytesPerChange * c.responseMargin + c.responseOverhead);
const STAGE = {
  revision: 7,
  next_index: 1,
  boundary_cursor: "delta-0",
  cursor: "cont-0",
  changes: 4,
  bytes: 966,
  started_at: 0,
};

const person = (n: number) => ({
  kind: "upsert" as const,
  resource: {
    id: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
    kind: "person",
    parent_id: null,
    label: "quota-control",
    value: null,
    version: 1,
    can_edit: true,
    archived: false,
    policy_version: 1,
  },
});
/** The review's revision: eight person upserts in two four-change pieces (966 and 965 bytes). */
const piece = (index: number): Response =>
  new Response(
    JSON.stringify({
      phase: "delta",
      batches: [
        {
          revision: 7,
          changes: Array.from({ length: 4 }, (_, n) =>
            person(4 * index + n + 1),
          ),
          segment: { index, last: index === 1 },
        },
      ],
      next_cursor: index === 1 ? "final" : "cont-0",
      has_more: index === 0,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

type Caller = "ordinary" | "recovery";
/** The engine's and the job's configuration override (the provisional constants' own literal types). */
type Config = NonNullable<Parameters<typeof engineWorld>[0]>["config"];
const CALLERS: readonly Caller[] = ["ordinary", "recovery"];

/** A delta-position world of either caller, its `/sync` requests and its stop state, behind one shape. */
async function world(
  caller: Caller,
  options: { capable?: () => boolean; config?: Config } = {},
) {
  const capable = options.capable ?? (() => true);
  if (caller === "ordinary") {
    const w = await engineWorld({
      cursor: "delta-0",
      segmentedCapable: capable,
      config: options.config,
    });
    return {
      w,
      run: async () => {
        w.start();
        await w.settle();
      },
      sync: () => w.requests.filter((u) => u.pathname.endsWith("/sync")),
      storageFull: () =>
        w.state().kind === "stopped" &&
        (w.state() as { cause?: string }).cause === "storage_full",
    };
  }
  const w = await recoveryWorld({
    cursor: "delta-0",
    phase: "delta",
    cacheStatus: "valid",
    displayed: false,
    segmentedCapable: capable,
    config: options.config,
  });
  return {
    w,
    run: async () => {
      await w.bindJob();
      await w.settle();
    },
    sync: () =>
      w.requests.map((r) => r.url).filter((u) => u.pathname.endsWith("/sync")),
    storageFull: () =>
      w.state().kind === "stopped" &&
      (w.state() as { cause?: string }).cause === "storage_full",
  };
}

/**
 * The first request at a declared free space, answered by a network failure (no landed bytes to blur the next judgement): whether it was
 * issued, with which parameters, and whether the caller stopped for storage instead.
 */
async function firstRequestAt(
  caller: Caller,
  free: number,
  setup: {
    capable?: () => boolean;
    config?: Config;
    sync?: Record<string, unknown>;
  } = {},
) {
  const x = await world(caller, setup);
  if (setup.sync !== undefined) x.w.setSync(setup.sync as never);
  x.w.freeBytes = free;
  x.w.script.push(new TypeError("network down"));
  await x.run();
  const first = x.sync()[0];
  return {
    issued: first !== undefined,
    query:
      first === undefined
        ? null
        : Object.fromEntries(first.searchParams.entries()),
    storageFull: x.storageFull(),
  };
}

const sizing = (limit: number, maxChanges?: number) => ({
  sizing: {
    limit,
    class: "unknown",
    floor_hits: 0,
    attempt: null,
    ...(maxChanges === undefined ? {} : { max_changes: maxChanges }),
  },
});

describe("R21-QUOTA: the admission estimate", () => {
  test("is the negotiated budget's, whatever the limit, and the whole-batch one without a budget", () => {
    expect(
      [4, 25, 50, 100, 200, 800].map((m) => admissionBytesFor(1, m)),
    ).toEqual([120_832, 411_136, 756_736, 1_447_936, 2_830_336, 11_124_736]);
    expect(admissionBytesFor(4, 100)).toBe(admissionBytesFor(1, 100));
    expect(admissionBytesFor(1, null)).toBe(maxResponseBytesFor(1));
    expect(admissionBytesFor(4, null)).toBe(maxResponseBytesFor(4));
    const config = {
      ...DATA_CONFIG,
      bytesPerChange: 1_000,
      responseMargin: 2,
      responseOverhead: 10_000,
    };
    expect(admissionBytesFor(1, 4, config)).toBe(18_000);
    expect(admissionBytesFor(2, null, config)).toBe(
      maxResponseBytesFor(2, config),
    );
    // The body ceiling is not the admission estimate: it stays the limit's.
    expect(maxResponseBytesFor(1)).toBe(11_124_736);
  });
});

describe.each(CALLERS)("R21-QUOTA: %s delta requests", (caller) => {
  // Q1, Q2, Q3: the review's schedule (m = 4, limit 1) and its two controls.
  test.each([
    { name: "ample space", free: 32 * MIB, rows: 8 },
    { name: "below the reserve", free: 7 * MIB, rows: 0 },
    { name: "the bounded response fits", free: 12 * MIB, rows: 8 },
  ])("m = 4, $name", async ({ free, rows }) => {
    // The 12 MiB case lies above the reserve plus three bounded estimates, and below the reserve plus the whole-batch one.
    expect(12 * MIB).toBeGreaterThan(R + 3 * bounded(4));
    expect(12 * MIB).toBeLessThan(R + maxResponseBytesFor(1));
    const x = await world(caller, { config: { segmentedMaxChanges: 4 } });
    x.w.freeBytes = free;
    x.w.script.push(piece(0), piece(1));
    await x.run();
    expect(x.w.cache()).toHaveLength(rows);
    if (rows > 0) {
      expect(
        x
          .sync()
          .slice(0, 2)
          .map((u) => [
            u.searchParams.get("cursor"),
            u.searchParams.get("limit"),
            u.searchParams.get("max_changes"),
          ]),
      ).toEqual([
        ["delta-0", "1", "4"],
        ["cont-0", "1", "4"],
      ]);
      expect(x.w.sync()).toMatchObject({
        applied_revision: 7,
        delta_stage: null,
      });
      expect(x.w.rows("delta_staging" as never)).toEqual([]);
      expect(x.storageFull()).toBe(false);
    } else {
      expect(x.sync()).toEqual([]);
      expect(x.storageFull()).toBe(true);
      expect(x.w.sync()).toMatchObject({ cursor: "delta-0" });
      expect(x.w.sync().delta_stage ?? null).toBeNull();
      expect(x.w.sync().sizing).toMatchObject({ limit: 1, floor_hits: 0 });
      expect(x.w.sync().sizing.max_changes ?? null).toBeNull();
      expect(x.w.sync().sizing.attempt).toBeNull();
    }
  });

  // Q4: the budget in force (the configured default, a stepped one), independent of the limit.
  test.each([
    { name: "the default budget at limit 1", limit: 1, stepped: undefined },
    { name: "the default budget at limit 4", limit: 4, stepped: undefined },
    { name: "a stepped-down budget", limit: 1, stepped: 50 },
  ])(
    "$name: issued at the reserve plus its estimate, refused one byte below",
    async ({ limit, stepped }) => {
      const m = stepped ?? (DATA_CONFIG.segmentedMaxChanges as number);
      const sync = sizing(limit, stepped);
      const at = await firstRequestAt(caller, R + bounded(m), {
        sync,
      });
      expect(at).toEqual({
        issued: true,
        query: {
          cursor: "delta-0",
          limit: String(limit),
          max_changes: String(m),
        },
        storageFull: false,
      });
      const below = await firstRequestAt(caller, R + bounded(m) - 1, { sync });
      expect(below).toEqual({ issued: false, query: null, storageFull: true });
    },
  );

  // Q5: the caller's own configuration is the estimate's.
  test("a supplied configuration's per-change bytes, margin and overhead", async () => {
    // Deliberately not the provisional constants (their literal types are widened for the purpose).
    const config = {
      segmentedMaxChanges: 4,
      bytesPerChange: 1_000,
      responseMargin: 2 as number,
      responseOverhead: 10_000,
    } as Config;
    const e = bounded(4, { ...DATA_CONFIG, ...config });
    expect(e).toBe(18_000);
    expect(
      (await firstRequestAt(caller, R + e, { config, sync: sizing(1) })).issued,
    ).toBe(true);
    expect(
      await firstRequestAt(caller, R + e - 1, { config, sync: sizing(1) }),
    ).toEqual({ issued: false, query: null, storageFull: true });
  });

  // Q6: no negotiation, no budget: the parameter is absent and the whole-batch estimate stands.
  test.each([
    { name: "a server not known to segment", capable: false, configured: 4 },
    { name: "no configured budget", capable: true, configured: null },
  ])(
    "$name: no max_changes, and the whole-batch estimate",
    async ({ capable, configured }) => {
      const setup = {
        capable: () => capable,
        config: { segmentedMaxChanges: configured },
        sync: sizing(1),
      };
      expect(
        await firstRequestAt(caller, R + maxResponseBytesFor(1), setup),
      ).toEqual({
        issued: true,
        query: { cursor: "delta-0", limit: "1" },
        storageFull: false,
      });
      expect(
        await firstRequestAt(caller, R + maxResponseBytesFor(1) - 1, setup),
      ).toEqual({ issued: false, query: null, storageFull: true });
    },
  );

  // Q7: a held continuation after a reload/takeover that does not know the server segments: the PERSISTED budget, not the new default.
  test("a held continuation keeps the persisted stepped budget and its estimate", async () => {
    const sync = { cursor: "cont-0", delta_stage: STAGE, ...sizing(1, 50) };
    const setup = { capable: () => false, sync };
    expect(await firstRequestAt(caller, R + bounded(50), setup)).toEqual({
      issued: true,
      query: { cursor: "cont-0", limit: "1", max_changes: "50" },
      storageFull: false,
    });
    expect(await firstRequestAt(caller, R + bounded(50) - 1, setup)).toEqual({
      issued: false,
      query: null,
      storageFull: true,
    });
  });

  // Q8: a continuation sent without a budget asks for the whole remainder: no earlier piece's `m` is reused for its estimate.
  test("a held continuation with no budget is estimated as the whole remainder", async () => {
    const sync = { cursor: "cont-0", delta_stage: STAGE, ...sizing(1) };
    const setup = {
      capable: () => false,
      config: { segmentedMaxChanges: null },
      sync,
    };
    expect(
      await firstRequestAt(caller, R + maxResponseBytesFor(1), setup),
    ).toEqual({
      issued: true,
      query: { cursor: "cont-0", limit: "1" },
      storageFull: false,
    });
    expect(
      await firstRequestAt(caller, R + maxResponseBytesFor(1) - 1, setup),
    ).toEqual({ issued: false, query: null, storageFull: true });
  });

  test.each([
    { name: "with room for the whole batch, activates", room: 32 * MIB },
    { name: "one byte short of the whole batch, is refused", room: -1 },
  ])(
    "a revision begun with m = 4, finished by a reloaded page with no budget, $name",
    async ({ room }) => {
      // A reload whose new page has no budget and does not know the server segments: the remainder is asked without `max_changes`.
      const config: { segmentedMaxChanges: number | null } = {
        segmentedMaxChanges: 4,
      };
      let capable = true;
      const x = await world(caller, { capable: () => capable, config });
      x.w.freeBytes = 32 * MIB;
      x.w.script.push(piece(0), new TypeError("network down"));
      await x.run();
      expect(x.w.sync()).toMatchObject({
        cursor: "cont-0",
        delta_stage: { next_index: 1 },
      });
      config.segmentedMaxChanges = null;
      capable = false;
      const sent = x.sync().length;
      x.w.freeBytes = room > 0 ? room : R + maxResponseBytesFor(1) + room;
      x.w.script.push(piece(1));
      // The guard keeps its estimate for its lifetime: the new free space is read once that has passed, with no page running meanwhile.
      if (caller === "ordinary") {
        const w = x.w as Awaited<ReturnType<typeof engineWorld>>;
        w.reload();
        await w.advance(DATA_CONFIG.quotaEstimateTtlMs + 1);
        w.start();
        await w.advance(60_000);
      } else {
        const w = x.w as Awaited<ReturnType<typeof recoveryWorld>>;
        w.job.bind(null);
        await w.advance(DATA_CONFIG.quotaEstimateTtlMs + 1);
        await w.reload();
        await w.advance(60_000);
      }
      const after = x.sync().slice(sent);
      if (room > 0) {
        expect(
          Object.fromEntries(after[0]?.searchParams.entries() ?? []),
        ).toEqual({ cursor: "cont-0", limit: "1" });
        expect(x.w.cache()).toHaveLength(8);
        expect(x.w.sync()).toMatchObject({
          applied_revision: 7,
          delta_stage: null,
        });
      } else {
        expect(after).toEqual([]);
        expect(x.storageFull()).toBe(true);
        expect(x.w.cache()).toEqual([]);
        expect(x.w.sync()).toMatchObject({
          cursor: "cont-0",
          delta_stage: { next_index: 1 },
        });
        expect(x.w.rows("delta_staging" as never)).toHaveLength(4);
      }
    },
  );
});

describe.each(CALLERS)(
  "R21-QUOTA: %s, the response's own reservation still decides",
  (caller) => {
    // Q11: the narrower early check admits the bounded request; while the response is in flight another writer (a save) takes the room; the
    // piece's reservation of the bytes actually received is refused, and nothing is staged. The control holds nothing and stages the piece.
    test.each([
      { name: "a save held while the response is in flight", hold: true },
      { name: "the control: no other writer", hold: false },
    ])("$name", async ({ hold }) => {
      const x = await world(caller, { config: { segmentedMaxChanges: 4 } });
      const quota = x.w.quota as {
        reserve(
          kind: "input",
          bytes: number,
        ): Promise<{ verdict: string; settle(outcome: "not_written"): void }>;
      };
      // Slack beyond one estimate, so that the control's next request is admitted over the piece's landed bytes; the save takes all of it.
      const e = bounded(4) + 4096;
      x.w.freeBytes = R + e;
      let held: {
        verdict: string;
        settle(outcome: "not_written"): void;
      } | null = null;
      x.w.script.push(async () => {
        if (hold) held = await quota.reserve("input", e);
        return piece(0);
      }, new TypeError("network down"));
      await x.run();
      expect(x.sync()[0]?.searchParams.get("max_changes")).toBe("4");
      expect(x.w.cache()).toEqual([]);
      if (hold) {
        expect(held).toMatchObject({ verdict: "ok" });
        expect(x.storageFull()).toBe(true);
        expect(x.sync()).toHaveLength(1);
        expect(x.w.rows("delta_staging" as never)).toEqual([]);
        expect(x.w.sync()).toMatchObject({ cursor: "delta-0" });
        expect(x.w.sync().delta_stage ?? null).toBeNull();
        // A refusal for want of space is not a tab that did not survive: no crash marker, no step-down.
        expect(x.w.sync().sizing).toMatchObject({ limit: 1, attempt: null });
        expect(x.w.sync().sizing.max_changes ?? null).toBeNull();
        (held as unknown as { settle(outcome: "not_written"): void }).settle(
          "not_written",
        );
      } else {
        expect(x.storageFull()).toBe(false);
        expect(x.sync()[1]?.searchParams.get("cursor")).toBe("cont-0");
        expect(x.w.rows("delta_staging" as never)).toHaveLength(4);
        expect(x.w.sync()).toMatchObject({
          cursor: "cont-0",
          delta_stage: { next_index: 1, boundary_cursor: "delta-0" },
        });
      }
    });
  },
);

describe("R21-QUOTA: the recovery job's snapshot", () => {
  // Q9: a snapshot never carries the parameter, so its estimate stays the whole-batch one even with a budget configured and stepped.
  test("a snapshot request is estimated as the whole batch, with a budget configured and stepped", async () => {
    const at = async (free: number) => {
      const w = await recoveryWorld({ segmentedCapable: () => true });
      w.setSync(sizing(1, 50) as never);
      w.freeBytes = free;
      w.script.push(new TypeError("network down"));
      await w.bindJob();
      await w.settle();
      const first = w.requests.find((r) => r.url.pathname.endsWith("/sync"));
      return {
        issued: first !== undefined,
        maxChanges: first?.url.searchParams.get("max_changes") ?? null,
        state: w.state(),
      };
    };
    expect(await at(R + maxResponseBytesFor(1))).toMatchObject({
      issued: true,
      maxChanges: null,
    });
    expect(await at(R + maxResponseBytesFor(1) - 1)).toMatchObject({
      issued: false,
      state: { kind: "stopped", cause: "storage_full" },
    });
  });
});

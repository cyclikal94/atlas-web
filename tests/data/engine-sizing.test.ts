// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { FORBIDDEN_STREAK_FIELDS } from "../../src/data/model/sync-state";
import { recordLocalWriteOutcome } from "../../src/data/plans/retry-state";
import { engineWorld } from "../support/data/engine-world";
import { cacheRow, draftRow } from "../support/data/rows";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * F-Z2 to F-Z6, F-C14, F-Q1 (plan 8.3, 8.4): Q23 and the local-failure bounds, through the production engine and plans. A real
 * engine cannot be made to raise QuotaExceededError or run out of memory on request, so every such fault here is a NAMED
 * injection (a write that throws a quota failure or a RangeError, a stubbed storage estimate); the reports say so.
 */
const upsert = (n: number, bulk = 0) => ({
  kind: "upsert" as const,
  resource: {
    ...projection(new Rng(n), n),
    id: uuid(n),
    value: bulk ? { filler: "x".repeat(bulk) } : { n },
  },
});
const page = (
  changes: PageSpec["batches"][number]["changes"],
  over: Partial<PageSpec> = {},
): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: "cursor-1",
  batches: [{ revision: 3, changes }],
  ...over,
});
const big = { deviceMemoryGiB: 8, hasStorageEstimate: true } as const;
const limits = (w: { requests: URL[] }) =>
  w.requests.map((u) => Number(u.searchParams.get("limit")));
const inject = (
  w: Awaited<ReturnType<typeof engineWorld>>,
  as: "error" | "quota" | "alloc",
  times = 99,
) =>
  w.env.idb.inject({
    match: (tx) => tx.label === "data.commitPage",
    mode: { kind: "throw_on_write", n: 1, as },
    times,
  });

describe("F-Z2: the ladder is driven by what happens", () => {
  test("an allocation failure steps 4 -> 2 -> 1, the next request asks for less, and the same cursor is requested again", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    inject(w, "alloc", 2);
    w.script.push(
      w.json(page([upsert(1)])),
      w.json(page([upsert(1)])),
      w.json(page([upsert(1)])),
    );
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4, 2, 1]);
    expect(w.requests.map((u) => u.searchParams.get("cursor"))).toEqual([
      "cursor-0",
      "cursor-0",
      "cursor-0",
    ]);
    // The third attempt, at the lowest rung, succeeded: the page is applied and the count of failures at the floor is clear.
    expect(w.cache().map((r) => r.id)).toEqual([uuid(1)]);
    expect(w.sync()).toMatchObject({
      cursor: "cursor-1",
      sizing: {
        limit: 1,
        class: "unconstrained",
        floor_hits: 0,
        attempt: null,
      },
    });
  });

  test("a response body that cannot be allocated (a RangeError reading it) steps down too", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const unreadable = new Response("x");
    Object.defineProperty(unreadable, "arrayBuffer", {
      value: async () => {
        throw new RangeError("Array buffer allocation failed");
      },
    });
    w.script.push(unreadable);
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([4, 2]);
  });

  test("a non-quota commit abort steps the ladder down but never reaches the floor (it has its own bound)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    inject(w, "error", 2);
    w.start();
    await w.settle();
    expect(limits(w).slice(0, 3)).toEqual([4, 2, 1]);
    expect(w.sync().sizing.floor_hits).toBe(0);
  });

  test("a quota failure NEVER steps down: it stops at once with storage_full and no retry loop (MU-35, F-C14)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    inject(w, "quota", 99);
    w.start();
    await w.settle();
    await w.advance(10 * 60_000);
    expect(w.state()).toEqual({ kind: "stopped", cause: "storage_full" });
    expect(limits(w)).toEqual([4]);
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    // Drafts are untouched: user input is the last thing to be refused.
    expect(w.sync().cursor).toBe("cursor-0");
  });

  test("an OVERSIZE or invalid page never steps down (it is not exhaustion)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.script.push(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(10 ** 9) },
      }),
    );
    w.start();
    await w.settle();
    expect(w.sync().sizing.limit).toBe(4);
  });
});

describe("F-Z4: the floor is reached only by repeated failure at the lowest rung, and shows only then", () => {
  test("FLOOR_AFTER failures at limit 1 stop the engine with `floor`; nothing else is touched (drafts, cache, the recovery streak fields)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" }); // no device-memory signal: starts at the lowest rung
    w.put("cache", [cacheRow({ id: uuid(9) })]);
    w.put("drafts", [draftRow({ local_id: "d1", status: "queued" })]);
    inject(w, "alloc", 99);
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    expect(limits(w)).toEqual([1, 1, 1]);
    expect(w.sync().sizing).toMatchObject({
      limit: 1,
      floor_hits: DATA_CONFIG.floorAfter,
    });
    expect(w.rows("drafts")).toHaveLength(1);
    expect(w.cache().map((r) => r.id)).toEqual([uuid(9)]);
    // The floor is a resource decision, not an error response: it writes none of 09b's fields (A:3471).
    for (const field of FORBIDDEN_STREAK_FIELDS)
      expect(w.sync()).not.toHaveProperty(field);
    expect(w.sync().cache_status).toBe("valid");
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(3);
  });

  test("ONE failure at the lowest rung is not the floor", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    inject(w, "alloc", 1);
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("idle");
    expect(w.sync().sizing.floor_hits).toBe(0);
  });

  test('"Try again" resets the count and asks again; a success then clears it', async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    inject(w, "alloc", 3);
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    w.engine.retryNow();
    await w.settle();
    expect(w.state().kind).toBe("idle");
    expect(w.sync().sizing).toMatchObject({ floor_hits: 0, limit: 1 });
  });

  test("the floor is durable: a restarted engine on the same database is still stopped, with no request", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    inject(w, "alloc", 3);
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("stopped");
    const issued = w.requests.length;
    w.engine.stop();
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    expect(w.requests).toHaveLength(issued);
  });
});

describe("the crash-loop marker (decision D-09)", () => {
  test("a marker found at start means the previous attempt did not finish: the ladder steps down before the next request", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.setSync({
      sizing: {
        limit: 4,
        class: "unconstrained",
        floor_hits: 0,
        attempt: { id: "a", limit: 4, started_at: 1 },
      },
    });
    w.start();
    await w.settle();
    expect(limits(w)).toEqual([2]);
    expect(w.sync().sizing.attempt).toBeNull();
  });

  test("a page of at least the threshold writes the marker BEFORE it is processed and the commit clears it in the same transaction; a small page writes none", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    const bulky = Array.from({ length: 12 }, (_, i) => upsert(i + 1, 30_000));
    w.script.push(
      w.json(page(bulky, { hasMore: true, nextCursor: "c1" })),
      w.json(page([upsert(99)], { nextCursor: "c2" })),
    );
    w.start();
    await w.settle();
    const labels = w.env.world.logs
      .filter((e) => e.type === "idb.commit" && e.wrote === true)
      .map((e) => e.label);
    const attempt = labels.indexOf("data.recordSizingAttempt");
    const firstCommit = labels.indexOf("data.commitPage");
    expect(attempt).toBeGreaterThanOrEqual(0);
    expect(attempt).toBeLessThan(firstCommit);
    expect(labels.filter((l) => l === "data.recordSizingAttempt")).toHaveLength(
      1,
    ); // the small second page wrote none
    expect(w.sync().sizing.attempt).toBeNull();
    expect(w.sync().cursor).toBe("c2");
  });
});

describe("F-C14: a local write failure that is not quota", () => {
  test("the same page is re-requested up to three times (a fresh stamp each time), then it stops with local_storage; a different operation's success does not reset the count", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    inject(w, "error", 99);
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.requests.map((u) => u.searchParams.get("cursor"))).toEqual([
      "cursor-0",
      "cursor-0",
      "cursor-0",
    ]);
    expect(w.sync().local_write_streaks).toEqual({ "page:cursor-0": 3 });
    // A different operation succeeding does not clear THIS operation's streak.
    await w.service.store.run(recordLocalWriteOutcome, {
      incarnationId: w.service.incarnationId,
      operation: "draft:other",
      outcome: { kind: "success", expect: null },
    });
    expect(w.sync().local_write_streaks).toEqual({ "page:cursor-0": 3 });
    expect(w.sync().request_seq).toBe(3);
  });

  test('the count survives a restart (it is durable), and "Retry applying changes" resumes', async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    inject(w, "error", 3);
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("stopped");
    w.engine.stop();
    expect(w.sync().local_write_streaks["page:cursor-0"]).toBe(3);
    const requests = w.requests.length;
    w.start();
    await w.settle();
    // R5 (revision): the stop is DURABLE and operation-specific. A restart does not retry the page: the engine finds the three
    // failures in the record, sends nothing, and shows the stopped state until the person asks ("Retry applying changes").
    expect(w.requests.length).toBe(requests);
    expect(w.state()).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(w.sync().local_write_streaks["page:cursor-0"]).toBe(3);
    w.engine.retryNow();
    await w.settle();
    // The record says the cursor has not moved, so the same page is asked for again, and it now applies.
    expect(w.state().kind).toBe("idle");
    expect(w.sync().cursor).toMatch(/^cursor-/);
    expect(w.sync().local_write_streaks).toEqual({});
  });

  test("a page that succeeds clears that page's streak", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    inject(w, "error", 2);
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("idle");
    expect(w.sync().local_write_streaks).toEqual({});
  });
});

describe("F-Q1: the quota reserve", () => {
  test("free space below the reserve stops the engine BEFORE a request is made (the data stores stop first, atlas-auth keeps room)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.freeBytes = 1024 * 1024;
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ kind: "stopped", cause: "storage_full" });
    // Space is freed and the person asks again.
    w.freeBytes = 500 * 1024 * 1024;
    w.quota.invalidate();
    w.engine.retryNow();
    await w.settle();
    expect(w.state().kind).toBe("idle");
  });
  test("an estimate that is missing is `unknown`: the engine relies on actual failures and carries on", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.freeBytes = null;
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("idle");
  });
});

describe("admission and ownership", () => {
  test("an elected leader's token must match the one in the database; a stale leader's page is refused and the engine stops issuing", async () => {
    const w = await engineWorld({ cursor: "cursor-0", ownerToken: "tok-OLD" });
    w.setSync({
      owner: { tab_id: "t", ownership_token: "tok-NEW", heartbeat_at: 1 },
    });
    w.start();
    await w.settle();
    expect(w.cache()).toEqual([]);
    expect(w.sync().cursor).toBe("cursor-0");
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    const matching = await engineWorld({
      cursor: "cursor-0",
      ownerToken: "tok-NEW",
    });
    matching.setSync({
      owner: { tab_id: "t", ownership_token: "tok-NEW", heartbeat_at: 1 },
    });
    matching.script.push(matching.json(page([upsert(1)])));
    matching.start();
    await matching.settle();
    expect(matching.cache()).toHaveLength(1);
  });

  test("an account switch while a request is in flight: the answer is dropped and nothing is written", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(async () => {
      w.identity.move({
        account: "22222222-2222-4222-8222-222222222222",
        epoch: 2,
      });
      return w.json(page([upsert(1)]));
    });
    w.start();
    await w.settle();
    expect(w.cache()).toEqual([]);
    expect(w.sync().cursor).toBe("cursor-0");
    expect(w.sync().page_seq).toBe(0);
  });

  test("stop() ends the loop: no further request is issued, whatever fires", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.start();
    await w.settle();
    w.engine.stop();
    const issued = w.requests.length;
    w.fire();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(issued);
    expect(w.state()).toEqual({ kind: "not_started" });
  });

  test("a lost leadership (the ownership signal aborts) stops the loop", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.start();
    await w.settle();
    w.ownership.abort();
    const issued = w.requests.length;
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(issued);
  });
});

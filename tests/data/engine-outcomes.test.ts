// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { RecoverySeam } from "../../src/data/engine/recovery-seam";
import { DATA_CONFIG } from "../../src/data/model/config";
import { StampedRequestError } from "../../src/session";
import { engineWorld } from "../support/data/engine-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * F-C12 and F-C13 (plan 8.3): the outcome table of `GET /sync`, table-driven, through the PRODUCTION engine, plans and guards over
 * the double of IndexedDB. The network is a script; the schedule is fake time. FIXTURE evidence: nothing here talks to a backend.
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
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
const readState = (w: Awaited<ReturnType<typeof engineWorld>>) => w.sync();

describe("a 200 page", () => {
  test("is requested with the stored cursor and the initial limit, applied, and the engine goes idle at the live edge", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(w.json(page([upsert(1)])));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]?.searchParams.get("cursor")).toBe("cursor-0");
    expect(w.requests[0]?.searchParams.get("limit")).toBe("1"); // no device-memory signal: the lowest rung
    expect(w.cache().map((r) => r.id)).toEqual([uuid(1)]);
    expect(w.state().kind).toBe("idle");
    expect(readState(w)).toMatchObject({
      cursor: "cursor-1",
      page_seq: 1,
      request_seq: 1,
    });
    expect(w.posted).toEqual([
      {
        type: "data_changed",
        account: w.service.account,
        stores: ["cache", "sync_state"],
      },
    ]);
  });

  test("with has_more it continues IMMEDIATELY, yielding between pages and never holding a transaction across the yield (F-C15)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(
      w.json(page([upsert(1)], { hasMore: true, nextCursor: "c1" })),
      w.json(page([upsert(2)], { hasMore: true, nextCursor: "c2" })),
      w.json(page([upsert(3)], { nextCursor: "c3" })),
    );
    w.start();
    await w.settle();
    expect(w.requests.map((u) => u.searchParams.get("cursor"))).toEqual([
      "cursor-0",
      "c1",
      "c2",
    ]);
    expect(w.yields).toBe(2);
    expect(w.state().kind).toBe("idle");
    // Each yield happens after the previous page's commit has completed and before the next capture begins.
    const log = w.env.world.logs;
    const commits = log.filter(
      (e) => e.type === "idb.commit" && e.label === "data.commitPage",
    );
    const captures = log.filter(
      (e) => e.type === "idb.create" && e.label === "data.captureRequest",
    );
    expect(commits).toHaveLength(3);
    expect(captures).toHaveLength(3);
    for (let i = 1; i < captures.length; i += 1)
      expect((captures[i]?.seq ?? 0) > (commits[i - 1]?.seq ?? 0)).toBe(true);
  });

  test("at the live edge it polls again after SYNC_IDLE_MS, and a receipt nudge polls after SYNC_RECEIPT_MS", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    await w.advance(DATA_CONFIG.syncIdleMs - 1);
    expect(w.requests).toHaveLength(1);
    await w.advance(1);
    expect(w.requests).toHaveLength(2);
    w.engine.nudge("receipt");
    await w.advance(DATA_CONFIG.syncReceiptMs - 1);
    expect(w.requests).toHaveLength(2);
    await w.advance(1);
    expect(w.requests).toHaveLength(3);
  });

  test("an initial limit of 4 for a device with 8 GiB or more, 1 otherwise (Q23)", async () => {
    const big = await engineWorld({
      signals: { deviceMemoryGiB: 8, hasStorageEstimate: true },
    });
    big.start();
    await big.settle();
    expect(big.requests[0]?.searchParams.get("limit")).toBe("4");
    const small = await engineWorld({
      signals: { deviceMemoryGiB: 2, hasStorageEstimate: true },
    });
    small.start();
    await small.settle();
    expect(small.requests[0]?.searchParams.get("limit")).toBe("1");
    for (const w of [big, small])
      for (const url of w.requests)
        expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(
          DATA_CONFIG.syncLimitMax,
        );
  });
});

describe("the local gate: no request is sent", () => {
  for (const [name, options, expected] of [
    [
      "the phase is snapshot",
      { phase: "snapshot" as const },
      "cache_not_valid",
    ],
    [
      "the cache is invalid",
      { cache_status: "invalid" as const },
      "cache_not_valid",
    ],
    [
      "the cache is empty",
      { cache_status: "empty" as const },
      "cache_not_valid",
    ],
  ] as const) {
    test(`${name}: waiting, zero requests`, async () => {
      const w = await engineWorld();
      w.setSync({ ...(options as object) } as never);
      w.start();
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual({ kind: "waiting", reason: expected });
    });
  }
  test("offline: waiting/offline and zero requests, until `online` fires", async () => {
    const w = await engineWorld();
    w.online = false;
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ kind: "waiting", reason: "offline" });
    w.online = true;
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(1);
  });
  test("a closing fence (a wipe is under way): no request", async () => {
    const w = await engineWorld();
    w.setSync({
      draft_fence: {
        token: "t",
        started_at: 1,
        operation_ids: [],
        consent_digest: "",
        closing: true,
      },
    });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
  });
  test("the page's identity is not the service's account: no request", async () => {
    const w = await engineWorld();
    w.identity.move({ account: null, epoch: 1 });
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(0);
  });
});

describe("F-C12: the six StampedRequestError kinds; an unsent request is not an attempt", () => {
  const countersUntouched = (w: Awaited<ReturnType<typeof engineWorld>>) => {
    const s = readState(w);
    expect(
      s.read_retry_states.sync ?? {
        backing_off_since: null,
        paused: false,
        unrecognised_streak: 0,
      },
    ).toMatchObject({
      backing_off_since: null,
      paused: false,
      unrecognised_streak: 0,
    });
    expect(s.local_write_streaks).toEqual({});
    expect(s.sizing.floor_hits).toBe(0);
  };

  test("not_sent: retried quietly on the bounded schedule, NEVER counted (MU-21), then waits for the session", async () => {
    const w = await engineWorld();
    for (let i = 0; i < DATA_CONFIG.notSentBackoffMs.length + 3; i += 1)
      w.script.push(new StampedRequestError("not_sent"));
    w.start();
    await w.settle();
    let total = 0;
    for (const ms of DATA_CONFIG.notSentBackoffMs) {
      total += ms;
      await w.advance(ms);
    }
    expect(total).toBeLessThan(8_000); // about six seconds, as WEB-08a's list screens
    expect(w.requests.length).toBe(DATA_CONFIG.notSentBackoffMs.length + 1);
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    countersUntouched(w);
    // request_seq is incremented when a request is CAPTURED for issue, so an unsent one leaves a gap: safe (strict comparison).
    expect(readState(w).request_seq).toBe(w.requests.length);
  });

  test("not_covered: waiting/paused_by_session with a doubling back-off from 2 s, never counted", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 4; i += 1)
      w.script.push(new StampedRequestError("not_covered"));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    await w.advance(1_999);
    expect(w.requests).toHaveLength(1);
    await w.advance(1);
    expect(w.requests).toHaveLength(2);
    await w.advance(4_000);
    expect(w.requests).toHaveLength(3);
    countersUntouched(w);
  });

  for (const kind of ["closed", "closed_unresolved", "auth_state"] as const) {
    test(`${kind}: stops issuing and never spins; only an eligibility change resumes it`, async () => {
      const w = await engineWorld();
      w.script.push(new StampedRequestError(kind));
      w.start();
      await w.settle();
      await w.advance(10 * 60_000);
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual({
        kind: "waiting",
        reason: "paused_by_session",
      });
      countersUntouched(w);
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(2);
    });
  }

  test("stale: dropped silently and re-evaluated; a run of them is paced rather than spun; nothing is counted", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 6; i += 1)
      w.script.push(new StampedRequestError("stale"));
    w.start();
    await w.settle();
    // The first few are re-evaluated at once, then paced at one second.
    expect(w.requests.length).toBeGreaterThanOrEqual(3);
    expect(w.requests.length).toBeLessThan(6);
    await w.advance(5_000);
    expect(w.requests.length).toBeGreaterThanOrEqual(6);
    countersUntouched(w);
    expect(w.cache()).toEqual([]);
  });
});

describe("F-C12: statuses", () => {
  test("500 and 503 temporarily_unavailable: ONE generic back-off branch (BE-CH3), durable, counted as a read failure", async () => {
    for (const make of [
      (w: Awaited<ReturnType<typeof engineWorld>>) =>
        w.status(500, { body: { code: "internal_error" } }),
      (w: Awaited<ReturnType<typeof engineWorld>>) =>
        w.status(503, { body: { code: "temporarily_unavailable" } }),
      (w: Awaited<ReturnType<typeof engineWorld>>) =>
        w.status(503, { body: { code: "not_ready" } }),
    ]) {
      const w = await engineWorld();
      w.script.push(make(w));
      w.start();
      await w.settle();
      expect(w.state().kind).toBe("backing_off");
      expect(
        readState(w).read_retry_states.sync?.backing_off_since,
      ).not.toBeNull();
      // Retried after the back-off, not before.
      await w.advance(1_999);
      expect(w.requests).toHaveLength(1);
      await w.advance(1);
      expect(w.requests).toHaveLength(2);
    }
  });

  test("429 honours Retry-After (capped at the maximum back-off)", async () => {
    const w = await engineWorld();
    w.script.push(w.status(429, { headers: { "retry-after": "30" } }));
    w.start();
    await w.settle();
    await w.advance(29_999);
    expect(w.requests).toHaveLength(1);
    await w.advance(1);
    expect(w.requests).toHaveLength(2);
    const huge = await engineWorld();
    huge.script.push(huge.status(429, { headers: { "retry-after": "86400" } }));
    huge.start();
    await huge.settle();
    await huge.advance(DATA_CONFIG.backoffMaxMs);
    expect(huge.requests).toHaveLength(2);
  });

  test("a network error is a counted failure with the same back-off", async () => {
    const w = await engineWorld();
    w.script.push(new TypeError("Failed to fetch"));
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("backing_off");
    await w.advance(2_000);
    expect(w.requests).toHaveLength(2);
  });

  test("the back-off is DURATION-based: after the sustained threshold it becomes `paused` (an actionable Retry now), durably", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 40; i += 1)
      w.script.push(
        w.status(503, { body: { code: "temporarily_unavailable" } }),
      );
    w.start();
    await w.settle();
    for (let i = 0; i < 12 && w.state().kind !== "paused"; i += 1)
      await w.advance(60_000);
    expect(w.state().kind).toBe("paused");
    const issued = w.requests.length;
    expect(readState(w).read_retry_states.sync?.paused).toBe(true);
    // Paused means STOPPED: time alone does not resume it, nor does another caller's success.
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(issued);
    w.engine.retryNow();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(issued);
    expect(readState(w).read_retry_states.sync?.paused).toBe(false);
  });

  test("503 device_capacity: stopped, blocking, NO retry", async () => {
    const w = await engineWorld();
    w.script.push(w.status(503, { body: { code: "device_capacity" } }));
    w.start();
    await w.settle();
    await w.advance(10 * 60_000);
    expect(w.state()).toEqual({ kind: "stopped", cause: "device_capacity" });
    expect(w.requests).toHaveLength(1);
  });

  for (const [status, reason] of [
    [410, "resync_required"],
    [400, "construction_defect"],
    [422, "construction_defect"],
  ] as const) {
    test(`${status}: the cache is invalidated and hidden, the position abandoned, a new recovery generation begins; drafts and overlays survive (F-C13)`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.put("cache", [cacheRow({ id: uuid(9) })]);
      w.put("drafts", [draftRow({ local_id: "d1", status: "queued" })]);
      w.put("pending_effects", [
        effectRow({
          resource_id: uuid(9),
          local_id: "d1",
          display: { label: "shown" },
        }),
      ]);
      w.script.push(w.status(status, { body: { code: reason } }));
      w.start();
      await w.settle();
      expect(readState(w)).toMatchObject({
        cache_status: "invalid",
        cursor: null,
        recovery_generation: 1,
      });
      expect(w.rows("drafts")).toHaveLength(1);
      expect(
        (w.rows("pending_effects")[0] as { display: unknown }).display,
      ).toBeNull();
      expect(w.cache()).toHaveLength(1); // hidden by the gate, replaced by 09b's atomic activation; never edited here
      // The default seam has no recovery job: the engine SAYS so, rather than claiming a resync is under way.
      expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
      await w.advance(10 * 60_000);
      expect(w.requests).toHaveLength(1);
    });
  }

  test("with a REGISTERED recovery seam the engine asks it to recover and waits, so the chip can read Resyncing from this instant", async () => {
    const requested: string[] = [];
    const recovery: RecoverySeam = {
      registered: true,
      request: (reason) => requested.push(reason),
      active: { get: () => true, subscribe: () => () => undefined },
    };
    const w = await engineWorld({ recovery, cursor: "cursor-0" });
    w.script.push(w.status(410));
    w.start();
    await w.settle();
    expect(requested).toEqual(["resync_required"]);
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
  });

  test("a duplicate or delayed 410 for a cursor that has since moved does NOT invalidate a cache that is valid (CAS)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(async () => {
      // Another page commits a page while this request is in flight.
      w.setSync({ cursor: "cursor-ELSEWHERE" });
      return w.status(410);
    });
    w.start();
    await w.settle();
    // The stale 410 was refused on its compare-and-set: the cache is still valid and no recovery generation began. The engine
    // then re-evaluated from the record and asked again from the position the OTHER page left.
    expect(readState(w)).toMatchObject({
      cache_status: "valid",
      recovery_generation: 0,
    });
    expect(w.requests.map((u) => u.searchParams.get("cursor"))).toEqual([
      "cursor-0",
      "cursor-ELSEWHERE",
    ]);
    expect(w.state().kind).toBe("idle");
  });

  test("409 access_changed, 403 and any other status are UNRECOGNISED: counted, never a success, three consecutive stop with a durable pause", async () => {
    for (const status of [409, 403, 404, 418]) {
      const w = await engineWorld();
      for (let i = 0; i < 6; i += 1) w.script.push(w.status(status));
      w.start();
      await w.settle();
      expect(
        readState(w).read_retry_states.sync?.unrecognised_streak,
        `${status} #1`,
      ).toBe(1);
      await w.advance(2_000);
      expect(
        readState(w).read_retry_states.sync?.unrecognised_streak,
        `${status} #2`,
      ).toBe(2);
      await w.advance(4_000);
      expect(
        readState(w).read_retry_states.sync?.unrecognised_streak,
        `${status} #3`,
      ).toBe(3);
      expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
      expect(readState(w).read_retry_states.sync?.paused).toBe(true);
      expect(readState(w).cache_status).toBe("valid"); // not treated as resync_required
      const issued = w.requests.length;
      await w.advance(10 * 60_000);
      expect(w.requests).toHaveLength(issued);
    }
  });
});

describe("a page that cannot be applied does not move the sizing ladder (it is not exhaustion)", () => {
  const unrecognisedAndUnmoved = async (
    w: Awaited<ReturnType<typeof engineWorld>>,
  ) => {
    w.start();
    await w.settle();
    expect(readState(w).read_retry_states.sync?.unrecognised_streak).toBe(1);
    expect(readState(w).sizing).toMatchObject({
      limit: 1,
      floor_hits: 0,
      attempt: null,
    });
    expect(w.cache()).toEqual([]);
    expect(readState(w).cursor).toBe("cursor-0");
  };
  test("F-C11: an invalid structure (nothing is written, MU-34)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(
      new Response('{"phase":"delta","batches":"nope"}', { status: 200 }),
    );
    await unrecognisedAndUnmoved(w);
  });
  test("F-C11: a snapshot page on the delta path", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(w.json(page([upsert(1)], { phase: "snapshot" })));
    await unrecognisedAndUnmoved(w);
  });
  test("F-C11: an element that fails validation", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.script.push(
      new Response(
        `{"phase":"delta","batches":[{"revision":1,"changes":[{"kind":"upsert","resource":{"id":"BAD"}}]}],"next_cursor":"c","has_more":false}`,
        { status: 200 },
      ),
    );
    await unrecognisedAndUnmoved(w);
  });
  test("F-C11: an OVERSIZE body is a contract violation, not a device limit (declared and actual)", async () => {
    const declared = await engineWorld({ cursor: "cursor-0" });
    declared.script.push(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(10 ** 9) },
      }),
    );
    await unrecognisedAndUnmoved(declared);
    const actual = await engineWorld({ cursor: "cursor-0" });
    actual.script.push(
      new Response(`{"x":"${"a".repeat(8_000_000)}"}`, { status: 200 }),
    );
    await unrecognisedAndUnmoved(actual);
  });
});

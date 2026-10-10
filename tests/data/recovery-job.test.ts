// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { snapshotPageOperation } from "../../src/data/model/recovery";
import { StampedRequestError } from "../../src/session";
import { ACCOUNT } from "../support/data/page-world";
import {
  type RecoveryWorld,
  recoveryWorld,
} from "../support/data/recovery-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * The recovery job (plan 7.2 to 7.4) over the production plans and the IndexedDB double: the ordinary first snapshot and its
 * activation, the server-instructed restarts (Q24), the three recovery-scoped retry classes with reload (reconciliation traces 5 and 6
 * and the unrecognised variant of 6), the whole-page retry of a failed local commit, and the recovery mode of matrix 3.7.3 (`begin`,
 * recovery-class reads only, the data commit, then `finish`), with byte-identical unsent work.
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});
const snap = (n: number[], over: Partial<PageSpec> = {}): PageSpec => ({
  phase: "snapshot",
  hasMore: true,
  nextCursor: `snap-${n[0]}`,
  batches: [{ revision: 50, changes: n.map(upsert) }],
  ...over,
});
const finalSnap = (n: number[], cursor = "delta-1") =>
  snap(n, { hasMore: false, nextCursor: cursor });
const delta = (n: number[], over: Partial<PageSpec> = {}): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: "delta-2",
  batches: [{ revision: 60, changes: n.map(upsert) }],
  ...over,
});
const cursors = (w: RecoveryWorld) =>
  w.requests.map((r) => r.url.searchParams.get("cursor"));
const ids = (w: RecoveryWorld) =>
  w
    .cache()
    .map((row) => row.id)
    .sort();

describe("ordinary mode: the first snapshot and its activation", () => {
  test("a fresh database pages the snapshot cursor-less, then at each staged position, and activates it atomically", async () => {
    const w = await recoveryWorld();
    w.script.push(
      w.page_(snap([1, 2])),
      w.page_(snap([3], { nextCursor: "snap-3" })),
      w.page_(finalSnap([4])),
    );
    await w.bindJob();
    await w.settle();
    expect(cursors(w)).toEqual([null, "snap-1", "snap-3"]);
    expect(w.requests.every((r) => r.klass === "ordinary")).toBe(true);
    expect(ids(w)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(w.sync()).toMatchObject({
      cache_status: "valid",
      phase: "delta",
      cursor: "delta-1",
      applied_revision: 50,
    });
    expect(w.state()).toEqual({ kind: "idle" });
    expect(w.job.exclusive.get()).toBe(false);
    // Nothing reached the cache before the activation: every staged page was posted as `sync_state` only.
    expect(w.posted.map((m) => m.type === "data_changed" && m.stores)).toEqual([
      ["sync_state"],
      ["sync_state"],
      ["cache", "sync_state"],
    ]);
  });

  test("a valid cache on a displayed account needs nothing: no request, the job is idle and not exclusive", async () => {
    const w = await recoveryWorld({
      cursor: "c",
      phase: "delta",
      cacheStatus: "valid",
    });
    await w.bindJob();
    await w.settle();
    expect(w.requests).toEqual([]);
    expect(w.state()).toEqual({ kind: "idle" });
    expect(w.job.exclusive.get()).toBe(false);
  });

  test("the engine's request after an invalidation starts a snapshot, and the chip's `active` is true from that instant (Q24)", async () => {
    const w = await recoveryWorld({
      cursor: "c",
      phase: "delta",
      cacheStatus: "valid",
    });
    await w.bindJob();
    await w.settle();
    w.setSync({ cache_status: "invalid", cursor: null });
    w.script.push(w.page_(finalSnap([7])));
    w.job.request("resync_required");
    expect(w.job.active.get()).toBe(true);
    expect(w.job.notice.get()).toMatchObject({ reason: "resync_required" });
    await w.settle();
    expect(ids(w)).toEqual([uuid(7)]);
    expect(w.sync().cache_status).toBe("valid");
    expect(w.job.active.get()).toBe(false);
  });
});

describe("server-instructed restarts (410, 409 access_changed): uncounted, with the Q24 notice", () => {
  for (const [what, answer, reason] of [
    ["410 resync_required", 410, "resync_required"],
    ["409 access_changed", 409, "access_changed"],
  ] as const)
    test(`${what} on page two discards the staging and restarts cursor-less, counting nothing`, async () => {
      const w = await recoveryWorld();
      w.script.push(
        w.page_(snap([1])),
        w.status(answer, { code: reason }),
        w.page_(finalSnap([2])),
      );
      await w.bindJob();
      await w.settle();
      expect(cursors(w)).toEqual([null, "snap-1", null]);
      expect(ids(w)).toEqual([uuid(2)]);
      expect(w.sync()).toMatchObject({
        recovery_attempt_streak: 0,
        sync_error_streak: 0,
        cache_status: "valid",
      });
      const notice = w.job.notice.get();
      expect(notice).toMatchObject({ reason });
      // Acknowledge only dismisses.
      w.job.acknowledge(notice?.id as string);
      expect(w.job.notice.get()).toBeNull();
      expect(w.sync().cache_status).toBe("valid");
    });
});

describe("the recovery-scoped retry classes (reconciliation traces 5 and 6)", () => {
  test("trace 6: three cursor-less 400s, with a reload between each, reach the blocking state and no automatic fourth request follows", async () => {
    const w = await recoveryWorld();
    w.script.push(w.status(400));
    await w.bindJob();
    await w.settle();
    expect(w.sync().sync_error_streak).toBe(1);
    for (let n = 2; n <= 3; n += 1) {
      // The tab reloads before the back-off ends: the durable count survives it.
      w.script.push(w.status(400));
      await w.reload();
      await w.settle();
      expect(w.sync().sync_error_streak).toBe(n);
    }
    expect(w.sync().sync_error_streak).toBe(DATA_CONFIG.syncErrorStopAfter);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "sync_blocked",
      blocked: "sync_error",
    });
    const before = w.requests.length;
    await w.advance(60 * 60_000);
    w.fire();
    w.goOnline();
    await w.settle();
    expect(w.requests.length).toBe(before);
  });

  test("trace 6, the unrecognised variant: three unrecognised cursor-less answers reach the same state and count", async () => {
    const w = await recoveryWorld();
    w.script.push(w.status(418), w.status(418), w.status(418));
    await w.bindJob();
    await w.advance(10 * 60_000);
    expect(w.sync().sync_error_streak).toBe(3);
    expect(w.state()).toMatchObject({ cause: "sync_blocked" });
    expect(w.requests).toHaveLength(3);
  });

  test("a page load permits ONE attempt while blocked, subject to the same counter: a failure leaves it blocked with no further request", async () => {
    const w = await recoveryWorld();
    w.setSync({ sync_error_streak: 3 });
    w.script.push(w.status(400), w.status(400));
    await w.bindJob();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.sync().sync_error_streak).toBe(4);
    expect(w.state()).toMatchObject({ cause: "sync_blocked" });
  });

  test("the permitted attempt is spent only by a request that is ISSUED: one withheld at the issue check is still made afterwards", async () => {
    const w = await recoveryWorld();
    w.setSync({ sync_error_streak: 3 });
    // The page goes offline during the quota read: the capture is made, the issue check refuses, nothing is sent.
    w.beforeEstimate = () => {
      w.online = false;
      w.beforeEstimate = undefined;
    };
    await w.bindJob();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    w.script.push(w.status(400));
    w.goOnline();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.sync().sync_error_streak).toBe(4);
    expect(w.state()).toMatchObject({ cause: "sync_blocked" });
  });

  for (const kind of ["not_sent", "not_covered"] as const)
    test(`the permitted attempt is RETURNED when the session refuses its request before sending it (${kind}): the next one is made`, async () => {
      const w = await recoveryWorld();
      w.setSync({ sync_error_streak: 3 });
      // The post-display verification's detection hold refuses the load's request (E-B13 in WebKit): nothing left the page.
      w.script.push(new StampedRequestError(kind), w.status(400));
      await w.bindJob();
      await w.advance(10 * 60_000);
      expect(w.requests).toHaveLength(2);
      expect(w.sync().sync_error_streak).toBe(4);
      expect(w.state()).toMatchObject({ cause: "sync_blocked" });
      // That sent attempt was the load's one: nothing follows it.
      await w.advance(10 * 60_000);
      expect(w.requests).toHaveLength(2);
    });

  test("that one attempt's success resets the cursor-less counter", async () => {
    const w = await recoveryWorld();
    w.setSync({ sync_error_streak: 3 });
    w.script.push(w.page_(finalSnap([1])));
    await w.bindJob();
    await w.settle();
    expect(w.sync()).toMatchObject({
      sync_error_streak: 0,
      cache_status: "valid",
    });
  });

  test("trace 5: a healthy page one and a failing page two trip the per-cursor counter and count the whole attempt; page one's success never resets it; a reload keeps it; at 3 the client stops", async () => {
    const w = await recoveryWorld();
    await w.bindJob();
    const cycle = () => {
      w.script.push(
        w.page_(snap([1])),
        w.status(418),
        w.status(418),
        w.status(418),
      );
    };
    cycle();
    await w.advance(10 * 60_000);
    expect(w.sync()).toMatchObject({
      recovery_attempt_streak: 1,
      sync_error_streak: 0,
      delta_error_streak: 0,
    });
    // The tab reloads mid-cycle (the durable count survives), and the same pattern repeats twice more.
    cycle();
    cycle();
    await w.reload();
    await w.advance(10 * 60_000);
    expect(w.sync().recovery_attempt_streak).toBe(3);
    // Page one succeeded on every cycle: the cursor-less counter is clear, and the whole-attempt one is not.
    expect(w.sync().sync_error_streak).toBe(0);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "sync_blocked",
      blocked: "attempts",
    });
    const before = w.requests.length;
    await w.advance(60 * 60_000);
    expect(w.requests.length).toBe(before);
    // The person's "Try again" resets the whole-attempt counter for a fresh budget and permits an attempt.
    w.script.push(w.page_(finalSnap([9])));
    w.job.retryNow();
    await w.settle();
    expect(w.sync()).toMatchObject({
      recovery_attempt_streak: 0,
      cache_status: "valid",
    });
  });

  test("a 400 on a staged cursor abandons it at once and counts the whole attempt", async () => {
    const w = await recoveryWorld();
    w.script.push(w.page_(snap([1])), w.status(422), w.page_(finalSnap([2])));
    await w.bindJob();
    await w.advance(10 * 60_000);
    expect(cursors(w)).toEqual([null, "snap-1", null]);
    // The activation that commits resets it again.
    expect(w.sync()).toMatchObject({
      recovery_attempt_streak: 0,
      cache_status: "valid",
    });
  });
});

describe("a failed local commit is retried as a WHOLE page (Q24), within the local-write bound", () => {
  test("three failures of a staged page stop it; each retry asked for the same position; Try again resumes it", async () => {
    const w = await recoveryWorld();
    w.env.idb.inject({
      match: (tx) => tx.label === "data.commitStagingPage",
      mode: { kind: "throw_on_write", n: 1, as: "error" },
      times: 3,
    });
    w.script.push(w.page_(snap([1])), w.page_(snap([1])), w.page_(snap([1])));
    await w.bindJob();
    await w.settle();
    expect(cursors(w)).toEqual([null, null, null]);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    const op = snapshotPageOperation(null);
    expect(w.sync().local_write_streaks[op]).toBe(3);
    w.script.push(w.page_(finalSnap([1])));
    w.job.retryNow();
    await w.settle();
    expect(w.sync().local_write_streaks[op]).toBeUndefined();
    expect(w.sync().cache_status).toBe("valid");
  });

  test("the stop of the first page survives a reload, although the reload restarts the attempt under a new generation", async () => {
    const w = await recoveryWorld();
    w.env.idb.inject({
      match: (tx) => tx.label === "data.commitStagingPage",
      mode: { kind: "throw_on_write", n: 1, as: "error" },
      times: 3,
    });
    w.script.push(w.page_(snap([1])), w.page_(snap([1])), w.page_(snap([1])));
    await w.bindJob();
    await w.settle();
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    const generation = w.sync().recovery_generation;
    await w.reload();
    await w.advance(10 * 60_000);
    expect(w.sync().recovery_generation).toBe(generation + 1);
    expect(w.requests).toHaveLength(3);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
  });

  test("so does the stop of a one-page snapshot, whose failing commit is the activation", async () => {
    const w = await recoveryWorld();
    w.env.idb.inject({
      match: (tx) => tx.label === "data.activateSnapshot",
      mode: { kind: "throw_on_write", n: 1, as: "error" },
      times: 3,
    });
    w.script.push(
      w.page_(finalSnap([1])),
      w.page_(finalSnap([1])),
      w.page_(finalSnap([1])),
    );
    await w.bindJob();
    await w.settle();
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    await w.reload();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(3);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
  });

  test("a quota refusal at the activation stops with storage_full and is not retried automatically", async () => {
    const w = await recoveryWorld();
    w.env.idb.inject({
      match: (tx) => tx.label === "data.activateSnapshot",
      mode: { kind: "throw_on_write", n: 1, as: "quota" },
      times: 1,
    });
    w.script.push(w.page_(finalSnap([1])));
    await w.bindJob();
    await w.advance(10 * 60_000);
    expect(w.state()).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(w.requests).toHaveLength(1);
    expect(w.sync().cache_status).toBe("empty");
  });
});

describe("recovery mode (matrix 3.7.3): only after `begin` says eligible, recovery-class reads, the data commit, then `finish`", () => {
  async function fenced() {
    const w = await recoveryWorld({
      cursor: "delta-0",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.put("cache", [cacheRow({ id: uuid(40) })]);
    return w;
  }

  test("T24 A: a valid saved cursor is caught up with recovery-class reads while hidden, and `finish` follows the data commit", async () => {
    const w = await fenced();
    w.script.push(w.page_(delta([41], { hasMore: true, nextCursor: "d-1" })));
    w.script.push(w.page_(delta([42])));
    await w.bindJob();
    await w.settle();
    expect(
      w.requests.map((r) => [r.klass, r.url.searchParams.get("cursor")]),
    ).toEqual([
      ["recovery", "delta-0"],
      ["recovery", "d-1"],
    ]);
    expect(ids(w)).toEqual([uuid(40), uuid(41), uuid(42)]);
    const order = w.calls.map((c) => c.call);
    expect(order[0]).toBe("begin");
    expect(order.at(-2)).toBe("finish");
    expect(
      w.calls
        .filter((c) => c.call === "report")
        .map((c) => (c as { phase: string | null }).phase),
    ).toEqual(["catching_up", null]);
    expect(w.state()).toEqual({ kind: "idle" });
  });

  test("T24 B: a 410 on the first recovery page builds a replacement snapshot while hidden, and nothing of the unsent work is written", async () => {
    const w = await fenced();
    const unsent = draftRow({ local_id: "unsent", status: "queued" });
    w.put("drafts", [unsent]);
    w.put("pending_effects", [
      effectRow({
        resource_id: uuid(40),
        local_id: "unsent",
        display: { label: "mine" },
      }),
    ]);
    const work = () =>
      JSON.stringify([
        w.rows("drafts"),
        w.rows("draft_commands"),
        w.rows("pending_effects"),
      ]);
    const before = work();
    w.script.push(
      w.status(410, { code: "resync_required" }),
      w.page_(finalSnap([50])),
    );
    await w.bindJob();
    await w.settle();
    expect(
      w.requests.map((r) => [r.klass, r.url.searchParams.get("cursor")]),
    ).toEqual([
      ["recovery", "delta-0"],
      ["recovery", null],
    ]);
    expect(ids(w)).toEqual([uuid(50)]);
    expect(work()).toBe(before);
    expect(w.calls.some((c) => c.call === "finish")).toBe(true);
  });

  for (const reason of [
    "operation_pending",
    "credential_unverified",
    "current_epoch_entry",
    "attempt_gating",
  ] as const)
    test(`T24 H: an ineligible \`begin\` (${reason}) sends nothing`, async () => {
      const w = await fenced();
      w.begins.push({ kind: "ineligible", reason });
      await w.bindJob();
      await w.advance(60_000);
      expect(w.requests).toEqual([]);
      expect(w.state()).toEqual({ kind: "eligible_wait", reason });
      expect(w.calls.some((c) => c.call === "finish")).toBe(false);
    });

  test("an unresolved lease is asked about again, paced, and sends nothing meanwhile", async () => {
    const w = await fenced();
    w.begins.push(
      { kind: "ineligible", reason: "unresolved_lease" },
      { kind: "ineligible", reason: "unresolved_lease" },
    );
    w.script.push(w.page_(delta([])));
    await w.bindJob();
    await w.settle();
    expect(w.requests).toEqual([]);
    await w.advance(DATA_CONFIG.recoveryBeginRetryMs * 4);
    expect(w.calls.filter((c) => c.call === "begin").length).toBe(3);
    expect(w.requests).toHaveLength(1);
  });

  test("T24 C: a recovery-time `auth_state` stops the run with nothing counted; the re-authentication's new epoch begins again", async () => {
    const w = await fenced();
    w.script.push(new StampedRequestError("auth_state"));
    await w.bindJob();
    await w.settle();
    expect(w.state()).toEqual({
      kind: "eligible_wait",
      reason: "current_epoch_entry",
    });
    expect(w.sync().read_retry_states.sync).toBeUndefined();
    w.script.push(w.page_(delta([])));
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    await w.settle();
    expect(w.requests.map((r) => r.epoch)).toEqual([1, 2]);
    expect(w.calls.filter((c) => c.call === "begin")).toHaveLength(2);
  });

  test("T24 G: a stale answer (a newer settlement) begins again with a new handle", async () => {
    const w = await fenced();
    w.script.push(new StampedRequestError("stale"), w.page_(delta([])));
    await w.bindJob();
    await w.settle();
    const finishes = w.calls.filter((c) => c.call === "finish") as Array<{
      handle: { s: number };
    }>;
    expect(w.calls.filter((c) => c.call === "begin")).toHaveLength(2);
    expect(finishes.at(-1)?.handle.s).toBe(2);
  });

  test("T24 F: `rerun` begins again with a new `s`; a catch-up with nothing to apply sends one request and finishes", async () => {
    const w = await fenced();
    w.finishes.push("rerun", "cleared");
    w.script.push(
      w.page_(delta([])),
      w.page_(delta([], { nextCursor: "delta-2" })),
    );
    await w.bindJob();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    const handles = w.calls.filter((c) => c.call === "finish") as Array<{
      handle: { s: number };
    }>;
    expect(handles.map((c) => c.handle.s)).toEqual([1, 2]);
    expect(w.state()).toEqual({ kind: "idle" });
  });

  test("`finish` that times out on the lock is retried with the data already committed, and no further request is made", async () => {
    const w = await fenced();
    w.finishes.push("lock_timeout", "cleared");
    w.script.push(w.page_(delta([])));
    await w.bindJob();
    await w.advance(60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.calls.filter((c) => c.call === "finish")).toHaveLength(2);
  });
});

describe("superseded bindings", () => {
  test("an answer that arrives after the job was re-bound (a takeover) writes nothing and counts nothing", async () => {
    const w = await recoveryWorld();
    let release: (r: Response) => void = () => undefined;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await w.bindJob("old");
    await w.settle();
    expect(w.requests).toHaveLength(1);
    // A new binding takes the database over (a new token through W20); its own first request waits too.
    w.script.push(() => new Promise<Response>(() => undefined));
    await w.bindJob("new");
    await w.settle();
    const before = w.snapshot();
    release(w.page_(snap([1])));
    await w.settle();
    expect(w.snapshot()).toEqual(before);
  });
});

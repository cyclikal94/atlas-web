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
    // ADAPTED (R4 of the review of 10 October 2026): the replacement's own first step now runs as soon as the old one has ended (before,
    // it was absorbed by the old step and never ran, which this test did not notice). Its capture (W21) legitimately moves the request
    // fields of `sync_state`; everything else, and every row the old answer would have staged or counted, is exactly as it was.
    expect(w.requests).toHaveLength(2);
    const strip = (snapshot: Record<string, object[]> | null) => ({
      ...snapshot,
      sync_state: (snapshot?.sync_state ?? []).map((row) => ({
        ...row,
        request_seq: 0,
        staging_request_seq: null,
        staging_started_at: null,
      })),
    });
    expect(strip(w.snapshot())).toEqual(strip(before));
    expect(w.rows("cache")).toEqual([]);
  });
});

/**
 * Review cycle 1 of 10 October 2026, R1 and R3 to R5 (finding families recovery-finish-epoch-binding, recovery-eligibility-wake,
 * recovery-rebind-scheduling and recovery-outcome-stamp-admission), each beside the control that shows what the job legitimately does.
 * The reviewer's own probes (`.agtx/evidence/review-1/probes/recovery-review.test.ts`, `recovery-boundaries.test.ts`) are the origin of
 * the first case of each family; they are kept there unchanged.
 */
describe("review cycle 1: a finish is the finish of its own data commit (R1)", () => {
  async function fenced() {
    return recoveryWorld({
      cursor: "delta-0",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
  }
  const finishes = (w: RecoveryWorld) =>
    (
      w.calls.filter((c) => c.call === "finish") as Array<{
        handle: { epoch: number; s: number };
      }>
    ).map((c) => c.handle.epoch);

  for (const failure of ["lock_timeout", "failed"] as const) {
    test(`control: a \`finish\` that answers ${failure} is asked again with the SAME handle and no further request`, async () => {
      const w = await fenced();
      w.finishes.push(failure, "cleared");
      w.script.push(w.page_(delta([], { nextCursor: "d2" })));
      await w.bindJob();
      await w.advance(60_000);
      expect(w.requests.map((r) => r.epoch)).toEqual([1]);
      expect(finishes(w)).toEqual([1, 1]);
      expect(w.sync().cursor).toBe("d2");
      expect(w.state()).toEqual({ kind: "idle" });
    });

    test(`R1 (${failure}): a second re-authentication catches up under its own handle before it finishes; the earlier commit proves nothing for it`, async () => {
      const w = await fenced();
      w.finishes.push(failure, "cleared");
      w.script.push(w.page_(delta([], { nextCursor: "d2" })));
      await w.bindJob();
      await w.settle();
      expect(w.state().kind).toBe("finishing");
      expect(w.requests.map((r) => r.epoch)).toEqual([1]);
      // A same-account re-authentication: epoch 2, the same binding (the leader does not rebind for it).
      w.script.push(w.page_(delta([], { nextCursor: "d3" })));
      w.identity.move({ account: ACCOUNT, epoch: 2 });
      await w.advance(60_000);
      expect(w.requests.map((r) => [r.klass, r.epoch])).toEqual([
        ["recovery", 1],
        ["recovery", 2],
      ]);
      expect(w.sync().cursor).toBe("d3");
      // The epoch-2 handle is finished only after the epoch-2 data commit.
      expect(finishes(w)).toEqual([1, 2]);
      const order = w.calls
        .filter((c) => c.call === "finish" || c.call === "begin")
        .map((c) => c.call);
      expect(order).toEqual(["begin", "finish", "begin", "finish"]);
    });
  }

  test("R1: a `stale` request answer after a data commit is not finished on the old commit either", async () => {
    const w = await fenced();
    w.finishes.push("lock_timeout", "cleared");
    w.script.push(w.page_(delta([], { nextCursor: "d2" })));
    await w.bindJob();
    await w.settle();
    // The retried `finish` finds a newer settlement: `superseded`; the new run catches up first.
    w.finishes.unshift("superseded");
    w.script.push(w.page_(delta([], { nextCursor: "d3" })));
    await w.advance(60_000);
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cursor).toBe("d3");
    const calls = w.calls
      .filter((c) => c.call === "finish" || c.call === "begin")
      .map((c) => c.call);
    expect(calls).toEqual(["begin", "finish", "finish", "begin", "finish"]);
  });
});

describe("review cycle 1: a refusal that only the durable record ends is asked again on the record's notification (R3)", () => {
  for (const reason of [
    "attempt_gating",
    "operation_pending",
    "credential_unverified",
    "current_epoch_entry",
  ] as const) {
    test(`R3 (${reason}): resolved in the SAME epoch with the view still neutral, the next notification begins the recovery`, async () => {
      const w = await recoveryWorld({
        cursor: "d1",
        phase: "delta",
        cacheStatus: "valid",
        displayed: false,
      });
      w.begins.push({ kind: "ineligible", reason });
      await w.bindJob();
      await w.settle();
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toEqual({ kind: "eligible_wait", reason });
      // The gate is removed (an attempt resolved, O11 resolved): the session evaluates and notifies; the identity and the view are the
      // same as before (same account, same epoch, still neutral).
      // ADAPTED (R3 of the review of 10 October 2026, second cycle): the gate's removal is now made in the world's record (`setGate`),
      // which `begin` and the admission probe both read. Before, the world's `begin` forgot its scripted refusal after answering it, so a
      // bare notification stood for the removal; the assertions below are unchanged.
      w.script.push(w.page_(delta([], { nextCursor: "d2" })));
      w.setGate(null);
      w.fire();
      await w.settle();
      await w.advance(60_000);
      expect(w.requests.map((r) => r.klass)).toEqual(["recovery"]);
      expect(w.sync().cursor).toBe("d2");
      expect(w.calls.filter((c) => c.call === "finish")).toHaveLength(1);
    });
  }

  test("control: a refusal that stands is asked about once per notification, never in a loop of its own", async () => {
    const w = await recoveryWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.begins.push(
      { kind: "ineligible", reason: "attempt_gating" },
      { kind: "ineligible", reason: "attempt_gating" },
      { kind: "ineligible", reason: "attempt_gating" },
    );
    await w.bindJob();
    await w.settle();
    w.fire();
    await w.settle();
    await w.advance(120_000);
    const begins = w.calls.filter((c) => c.call === "begin").length;
    // ADAPTED (R3, second cycle): was `toBe(2)` (one `begin` per notification). A standing refusal is now re-checked by the admission
    // probe, a read of the record, so an unchanged gate asks `begin` nothing more at all: the notification and two minutes of paced
    // reconciliation probed the record and asked nothing.
    expect(begins).toBe(1);
    expect(w.probes.length).toBeGreaterThan(1);
    // The refusal is reported once: an unchanged answer causes no further evaluation.
    expect(
      w.calls.filter(
        (c) =>
          c.call === "report" &&
          (c as { phase: string | null }).phase === "failed",
      ),
    ).toHaveLength(1);
    expect(w.requests).toHaveLength(0);
  });

  test("control: an offline wait is still left only by `online`, and a back-off is not cut short by a notification", async () => {
    const w = await recoveryWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.online = false;
    await w.bindJob();
    await w.settle();
    expect(w.state()).toEqual({ kind: "eligible_wait", reason: "offline" });
    w.fire();
    await w.settle();
    expect(w.calls.filter((c) => c.call === "begin")).toHaveLength(0);
  });
});

describe("review cycle 1: a replacement binding is scheduled by its own binding (R4)", () => {
  test("control: an ordinary notification after the old answer also lets the replacement proceed", async () => {
    const w = await recoveryWorld();
    w.honourAbort = false;
    let release: (r: Response) => void = () => undefined;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await w.bindJob("old");
    await w.settle();
    w.script.push(w.page_(finalSnap([2])));
    await w.bindJob("new");
    await w.settle();
    release(w.page_(finalSnap([1])));
    await w.settle();
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cache_status).toBe("valid");
  });

  test("R4: with NO further notification, the replacement starts as soon as the obsolete step has ended, and the old answer applies nothing", async () => {
    const w = await recoveryWorld();
    // The old call is settled only later than the rebinding (its wrapper's own clean-up), so the old step is still busy when the job is
    // bound again: the replacement's start is absorbed by `busy` and must be scheduled when the old step ends.
    w.honourAbort = false;
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
    w.script.push(w.page_(finalSnap([2])));
    await w.bindJob("new");
    await w.settle();
    release(w.page_(finalSnap([1])));
    await w.settle();
    await w.advance(60_000);
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cache_status).toBe("valid");
    // Only the replacement's snapshot is in the cache.
    expect(ids(w)).toEqual([uuid(2)]);
  });

  test("R4: the obsolete request is aborted with its binding's ownership signal", async () => {
    const w = await recoveryWorld();
    const signals: AbortSignal[] = [];
    w.script.push(
      () =>
        new Promise<Response>(() => {
          // Never answered: the request's own signal is what ends it.
        }),
    );
    await w.bindJob("old");
    await w.settle();
    signals.push(w.ownership.signal);
    w.script.push(w.page_(finalSnap([2])));
    await w.bindJob("new");
    await w.settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(w.sent.map((request) => request.signal.aborted)).toEqual([
      true,
      false,
    ]);
  });
});

describe("review cycle 1: a response-derived budget write is admitted with its request's stamp (R5)", () => {
  test("control: a current-epoch `409 access_changed` abandons the snapshot and restarts it (with the Q24 notice)", async () => {
    const w = await recoveryWorld();
    w.script.push(w.status(409, { code: "access_changed" }));
    await w.bindJob();
    await w.settle();
    expect(w.sync().recovery_generation).toBe(2);
    expect(w.requests).toHaveLength(2);
    expect(w.job.notice.get()?.reason).toBe("access_changed");
  });

  test("R5: an error body decoded after a re-authentication changes nothing of the newer epoch: no abandonment, no budget, no notice", async () => {
    const w = await recoveryWorld();
    let release: (v: ArrayBuffer) => void = () => undefined;
    let decoding = false;
    const response = w.status(409, { code: "access_changed" });
    response.arrayBuffer = () => {
      decoding = true;
      return new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      });
    };
    w.script.push(response);
    await w.bindJob();
    await w.settle();
    expect(decoding).toBe(true);
    const before = w.sync();
    w.script.push(() => new Promise<Response>(() => undefined));
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    await w.settle();
    release(
      new TextEncoder().encode(JSON.stringify({ code: "access_changed" }))
        .buffer as ArrayBuffer,
    );
    await w.settle();
    expect(w.sync().recovery_generation).toBe(before.recovery_generation);
    expect(w.sync().recovery_budget_version ?? 0).toBe(
      before.recovery_budget_version ?? 0,
    );
    expect(w.job.notice.get()).toBeNull();
  });

  for (const [what, answer] of [
    ["410", () => ({ code: 410, body: { code: "resync_required" } })],
    ["400 (cursor-less)", () => ({ code: 400, body: {} })],
    ["422 (cursor-less)", () => ({ code: 422, body: {} })],
    ["an unrecognised status", () => ({ code: 418, body: {} })],
  ] as const)
    test(`R5 (${what}): W24 waits for the persistence hold, the epoch moves meanwhile, and the transaction admits nothing`, async () => {
      const w = await recoveryWorld();
      const { code, body } = answer();
      w.script.push(w.status(code, body));
      w.gate.queue = true;
      await w.bindJob();
      await w.settle();
      const waiting = w.gate.waiting.splice(0);
      expect(waiting).toHaveLength(1);
      const before = JSON.stringify(w.sync());
      // A same-account re-authentication becomes current while W24 waits for its hold; the hold is then granted (a stale grant).
      w.gate.queue = false;
      w.script.push(() => new Promise<Response>(() => undefined));
      w.identity.move({ account: ACCOUNT, epoch: 2 });
      waiting[0]?.answer("held");
      await w.settle();
      const after = w.sync();
      const parsed = JSON.parse(before);
      expect(after.recovery_generation).toBe(parsed.recovery_generation);
      expect(after.sync_error_streak ?? 0).toBe(parsed.sync_error_streak ?? 0);
      expect(after.recovery_attempt_streak ?? 0).toBe(
        parsed.recovery_attempt_streak ?? 0,
      );
      expect(w.job.notice.get()).toBeNull();
    });
});

describe("review cycle 1: the recovery touches no draft, `pending_effects` or outbox entry; the owed bookkeeping follows the display (R8)", () => {
  for (const path of ["catch_up", "snapshot"] as const)
    test(`${path}: while fenced the whole queue is byte-identical (acknowledged work too); once displayed, W26 releases the acknowledged receipt and leaves unsent work alone`, async () => {
      const w = await recoveryWorld({
        cursor: "delta-0",
        phase: "delta",
        cacheStatus: "valid",
        displayed: false,
      });
      w.put("drafts", [
        draftRow({ local_id: "unsent", status: "queued" }),
        draftRow({
          local_id: "acked",
          status: "acknowledged",
          held_pending_cache: true,
          receipt_revision: 45,
        }),
      ]);
      w.put("pending_effects", [
        effectRow({
          resource_id: uuid(41),
          local_id: "unsent",
          display: { label: "mine" },
        }),
        effectRow({
          resource_id: uuid(41),
          local_id: "acked",
          receipt_revision: 45,
          no_publication_floor: 0,
          display: { label: "sent" },
        }),
      ]);
      const queue = () =>
        JSON.stringify([
          w.rows("drafts"),
          w.rows("draft_commands"),
          w.rows("pending_effects"),
        ]);
      const unsent = () =>
        JSON.stringify([
          (w.rows("drafts") as Array<{ local_id: string }>).filter(
            (d) => d.local_id === "unsent",
          ),
          (w.rows("pending_effects") as Array<{ local_id: string }>).filter(
            (e) => e.local_id === "unsent",
          ),
        ]);
      const before = queue();
      const unsentBefore = unsent();
      if (path === "catch_up") w.script.push(w.page_(delta([41])));
      else
        w.script.push(
          w.status(410, { code: "resync_required" }),
          w.page_(finalSnap([41])),
        );
      await w.bindJob();
      await w.settle();
      expect(w.calls.some((c) => c.call === "finish")).toBe(true);
      expect(queue()).toBe(before);
      expect(w.sync().recovery_reconcile_pending).toBe(true);
      // The session displays the account (an ordinary exposure); the job's next step is ordinary and does what was owed.
      w.view.set({ kind: "displaying", account_id: ACCOUNT, epoch: 1 });
      await w.settle();
      expect(w.sync().recovery_reconcile_pending).toBe(false);
      expect(unsent()).toBe(unsentBefore);
      expect(
        (w.rows("drafts") as Array<{ local_id: string }>).map(
          (d) => d.local_id,
        ),
      ).toEqual(["unsent"]);
    });
});

describe("review cycle 2: a request refused before it was sent is an explicit admission wait (R3)", () => {
  const PACE = DATA_CONFIG.notSentBackoffMs.length;
  async function fencedWithCursor() {
    return recoveryWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
  }
  const begins = (w: RecoveryWorld) =>
    w.calls.filter((c) => c.call === "begin").length;
  const finishes = (w: RecoveryWorld) =>
    w.calls.filter((c) => c.call === "finish") as Array<{
      handle: { s: number; epoch: number };
    }>;
  /** A refusal of the wrapper AFTER `begin` said eligible: another page adds a gate meanwhile, and the cover closes. */
  const closedBy =
    (w: RecoveryWorld, kind: "closed" | "closed_unresolved") => () => {
      w.setGate("credential_unverified");
      return new StampedRequestError(kind);
    };

  for (const kind of ["closed", "closed_unresolved"] as const) {
    test(`R3 (${kind} after \`begin\`): the job waits, sends nothing while the gate stands, and resumes in the SAME epoch when it is resolved, under a fresh handle`, async () => {
      const w = await fencedWithCursor();
      w.script.push(closedBy(w, kind));
      await w.bindJob();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toEqual({ kind: "admission_wait", mode: "recovery" });
      // Notifications and time change nothing while the gate stands: no `begin`, no request.
      for (let i = 0; i < 5; i += 1) w.fire();
      await w.advance(120_000);
      expect(w.requests).toHaveLength(1);
      expect(begins(w)).toBe(1);
      // O11 resolves the credential in the same epoch; the view stays neutral. Resolved only after the wait was installed and the
      // job is idle, so no pending wake can stand in for the fix.
      w.script.push(w.page_(delta([], { nextCursor: "d2" })));
      w.setGate(null);
      w.fire();
      await w.settle();
      expect(w.requests.map((r) => [r.klass, r.epoch])).toEqual([
        ["recovery", 1],
        ["recovery", 1],
      ]);
      expect(w.sync().cursor).toBe("d2");
      expect(begins(w)).toBe(2);
      // The refused request's handle (s = 1) proves nothing: `finish` is asked with the new one.
      expect(finishes(w).map((c) => c.handle.s)).toEqual([2]);
      expect(w.state()).toEqual({ kind: "idle" });
    });
  }

  test("R3 (closed_unresolved, lease only): with no gate, the job re-enters `begin` at once (which resolves the leases) and proceeds", async () => {
    const w = await fencedWithCursor();
    w.script.push(
      new StampedRequestError("closed_unresolved"),
      w.page_(delta([], { nextCursor: "d2" })),
    );
    w.begins.push(
      {
        kind: "eligible",
        handle: { account: ACCOUNT, epoch: 1, s: 1 },
      },
      { kind: "ineligible", reason: "unresolved_lease" },
    );
    await w.bindJob();
    await w.settle();
    expect(w.state()).toEqual({
      kind: "eligible_wait",
      reason: "unresolved_lease",
    });
    await w.advance(DATA_CONFIG.recoveryBeginRetryMs * 2);
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cursor).toBe("d2");
    expect(begins(w)).toBe(3);
  });

  test("R3: a gate that came and went while the refusal was handled (never seen, no notification) is tried once at once", async () => {
    const w = await fencedWithCursor();
    w.script.push(
      new StampedRequestError("closed"),
      w.page_(delta([], { nextCursor: "d2" })),
    );
    await w.bindJob();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cursor).toBe("d2");
  });

  test("R3: a notification during the refusal step is honoured: the resolution before the wait is installed is not lost", async () => {
    const w = await fencedWithCursor();
    w.script.push(
      () => {
        w.setGate("attempt_gating");
        // Resolved, and notified, while the job is still busy with the refusal.
        w.setGate(null);
        w.fire();
        return new StampedRequestError("closed");
      },
      w.page_(delta([], { nextCursor: "d2" })),
    );
    await w.bindJob();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cursor).toBe("d2");
  });

  test("R3 (ordinary snapshot): a cover closed by another tab's gating attempt waits while the view stays displayed, and resumes when it resolves", async () => {
    const w = await recoveryWorld();
    w.script.push(() => {
      w.setGate("attempt_gating");
      return new StampedRequestError("closed");
    });
    await w.bindJob();
    await w.settle();
    expect(w.state()).toEqual({ kind: "admission_wait", mode: "ordinary" });
    w.fire();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(1);
    expect(w.sync().cache_status).not.toBe("valid");
    w.script.push(w.page_(finalSnap([1])));
    w.setGate(null);
    w.fire();
    await w.settle();
    expect(w.requests.map((r) => r.klass)).toEqual(["ordinary", "ordinary"]);
    expect(w.sync().cache_status).toBe("valid");
    expect(w.state()).toEqual({ kind: "idle" });
  });

  for (const fenced of [false, true])
    test(`R3 (not_sent outlasting the immediate retries, ${fenced ? "recovery catch-up" : "ordinary snapshot"}): waits on the page's hold, counts nothing, and a released hold resumes it`, async () => {
      const w = fenced ? await fencedWithCursor() : await recoveryWorld();
      w.hold = true;
      for (let i = 0; i <= PACE; i += 1)
        w.script.push(new StampedRequestError("not_sent"));
      await w.bindJob();
      for (let i = 0; i < 12; i += 1) await w.advance(1_000);
      expect(w.requests).toHaveLength(PACE + 1);
      expect(w.state()).toEqual({
        kind: "admission_wait",
        mode: fenced ? "recovery" : "ordinary",
      });
      for (let i = 0; i < 5; i += 1) w.fire();
      await w.advance(600_000);
      expect(w.requests).toHaveLength(PACE + 1);
      // Nothing was counted: unsent requests consume no read or recovery budget.
      expect(w.sync().read_retry_states.sync).toBeUndefined();
      w.script.push(
        fenced
          ? w.page_(delta([], { nextCursor: "d2" }))
          : w.page_(finalSnap([1])),
      );
      w.hold = false;
      w.fire();
      await w.settle();
      expect(w.requests).toHaveLength(PACE + 2);
      if (fenced) expect(w.sync().cursor).toBe("d2");
      else expect(w.sync().cache_status).toBe("valid");
    });

  test("R3 (lost hint): a hold released with NO notification is found by the paced read-only reconciliation", async () => {
    const w = await recoveryWorld();
    w.hold = true;
    for (let i = 0; i <= PACE; i += 1)
      w.script.push(new StampedRequestError("not_sent"));
    await w.bindJob();
    await w.advance(600_000);
    expect(w.requests).toHaveLength(PACE + 1);
    const probed = w.probes.length;
    w.script.push(w.page_(finalSnap([1])));
    w.hold = false;
    await w.advance(DATA_CONFIG.recoveryBeginRetryMaxMs);
    expect(w.probes.length).toBeGreaterThan(probed);
    expect(w.requests).toHaveLength(PACE + 2);
    expect(w.sync().cache_status).toBe("valid");
  });

  test("control: one transient not_sent still recovers at once", async () => {
    const w = await recoveryWorld();
    w.script.push(new StampedRequestError("not_sent"), w.page_(finalSnap([1])));
    await w.bindJob();
    await w.advance(1_000);
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cache_status).toBe("valid");
  });

  test("control: a refusal the probe cannot see is tried ONCE more at once, then only on a paced back-off: notifications, the job's own reports and time make no request loop", async () => {
    const w = await fencedWithCursor();
    w.reportNotifies = true;
    for (let i = 0; i < 200; i += 1)
      w.script.push(new StampedRequestError("not_sent"));
    await w.bindJob();
    for (let i = 0; i < 6; i += 1) await w.advance(1_000);
    // The immediate retries, then the one attempt an open, unchanged revision permits at once.
    expect(w.requests).toHaveLength(PACE + 2);
    const before = w.requests.length;
    // Twenty notifications at once: probes, never a request.
    for (let i = 0; i < 20; i += 1) w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(before);
    // Ten minutes: paced attempts only (1 s doubling to 60 s), so a bounded handful, never a burst. Time alone makes no probe loop
    // either: the first second asks the admission probe a handful of times (3), never once a millisecond (WEB-08d revision 17: a job
    // that re-probes every millisecond is now an assertion failure here, not a run that exhausts the world or the test's time).
    const probed = w.probes.length;
    await w.advance(1_000);
    expect(w.probes.length - probed).toBeLessThanOrEqual(10);
    await w.advance(599_000);
    const paced = w.requests.length - before;
    expect(paced).toBeGreaterThanOrEqual(5);
    expect(paced).toBeLessThanOrEqual(16);
    // At the bound the attempts are a minute apart.
    const at = w.requests.length;
    await w.advance(59_000);
    expect(w.requests.length - at).toBeLessThanOrEqual(1);
    // Nothing was counted.
    expect(w.sync().read_retry_states.sync).toBeUndefined();
  });

  test("R3 (open but refused, e.g. a token only a new verification can fetch): the paced attempt recovers once the cause is gone, with no notification", async () => {
    const w = await recoveryWorld();
    for (let i = 0; i < PACE + 4; i += 1)
      w.script.push(new StampedRequestError("not_sent"));
    w.script.push(w.page_(finalSnap([1])));
    await w.bindJob();
    // Waiting for the paced attempt is no probe loop: the first ten seconds ask the admission probe a handful of times (8), never once a
    // millisecond (WEB-08d revision 17: a job that re-probes every millisecond is an assertion failure here, before the long wait, not
    // a run that exhausts the test's time under load). The two waits are the original 120 s.
    const probed = w.probes.length;
    await w.advance(10_000);
    expect(w.probes.length - probed).toBeLessThanOrEqual(30);
    await w.advance(110_000);
    expect(w.requests).toHaveLength(PACE + 5);
    expect(w.sync().cache_status).toBe("valid");
  });

  test("control: a changed revision is a fresh opportunity, with a fresh run of immediate retries", async () => {
    const w = await fencedWithCursor();
    for (let i = 0; i < PACE + 2; i += 1)
      w.script.push(new StampedRequestError("not_sent"));
    await w.bindJob();
    for (let i = 0; i < 6; i += 1) await w.advance(1_000);
    expect(w.requests).toHaveLength(PACE + 2);
    w.script.push(w.page_(delta([], { nextCursor: "d2" })));
    w.salt += 1;
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(PACE + 3);
    expect(w.sync().cursor).toBe("d2");
  });

  test("control: an unreadable admission record is unknown: nothing is asked until it can be read and is open", async () => {
    const w = await fencedWithCursor();
    w.script.push(closedBy(w, "closed"));
    await w.bindJob();
    await w.settle();
    w.admissionUnreadable = true;
    w.setGate(null);
    w.fire();
    await w.advance(5_000);
    expect(begins(w)).toBe(1);
    expect(w.requests).toHaveLength(1);
    w.script.push(w.page_(delta([], { nextCursor: "d2" })));
    w.admissionUnreadable = false;
    w.fire();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cursor).toBe("d2");
  });

  test("control: a current-epoch entry (a recovery-time 401) is not lifted by notifications in its epoch; the re-authentication's epoch resumes", async () => {
    const w = await fencedWithCursor();
    w.script.push(new StampedRequestError("auth_state"));
    await w.bindJob();
    await w.settle();
    for (let i = 0; i < 5; i += 1) w.fire();
    await w.advance(120_000);
    expect(begins(w)).toBe(1);
    expect(w.state()).toEqual({
      kind: "eligible_wait",
      reason: "current_epoch_entry",
    });
    w.script.push(w.page_(delta([], { nextCursor: "d2" })));
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    await w.settle();
    expect(w.requests.map((r) => r.epoch)).toEqual([1, 2]);
  });

  test("R3 (`finish` not_eligible): a gate added before `finish` is waited on, and its resolution begins again under a new handle", async () => {
    const w = await fencedWithCursor();
    w.finishes.push("not_eligible", "cleared");
    // Another page adds the gate after the answer and before `finish`.
    w.script.push(() => {
      w.setGate("credential_unverified");
      return w.page_(delta([], { nextCursor: "d2" }));
    });
    await w.bindJob();
    await w.settle();
    expect(w.state().kind).toBe("eligible_wait");
    w.fire();
    await w.advance(60_000);
    expect(begins(w)).toBe(1);
    expect(w.requests).toHaveLength(1);
    w.script.push(w.page_(delta([], { nextCursor: "d3" })));
    w.setGate(null);
    w.fire();
    await w.settle();
    expect(begins(w)).toBe(2);
    expect(finishes(w).map((c) => c.handle.s)).toEqual([1, 2]);
    expect(w.sync().cursor).toBe("d3");
    expect(w.state()).toEqual({ kind: "idle" });
  });

  test("control: a stop is not lifted by admission changes (a paused read caller stays paused)", async () => {
    const w = await recoveryWorld({ config: { pauseAfterMs: 1 } as never });
    w.script.push(w.status(503), w.status(503), w.status(503));
    await w.bindJob();
    await w.advance(600_000);
    const state = w.state().kind;
    const sent = w.requests.length;
    w.salt += 1;
    w.fire();
    await w.advance(600_000);
    expect(w.state().kind).toBe(state);
    if (state === "paused") expect(w.requests).toHaveLength(sent);
  });

  test("R3 with R4: a replacement binding during a standing wait starts on its own, from `begin`", async () => {
    const w = await fencedWithCursor();
    w.script.push(closedBy(w, "closed"));
    await w.bindJob();
    await w.settle();
    expect(w.state()).toEqual({ kind: "admission_wait", mode: "recovery" });
    w.setGate(null);
    w.script.push(w.page_(delta([], { nextCursor: "d2" })));
    await w.bindJob();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.sync().cursor).toBe("d2");
  });
});

describe("WEB-08c K-2: a gate that ends with nothing to recover clears the reported failure (state 3 never strands the display)", () => {
  for (const reason of ["attempt_gating", "operation_pending"] as const)
    test(`K-2 (${reason}): the job reported 'failed' during the gate; once begin says no_fence it reports null`, async () => {
      // A switch or an in-place re-authentication gates the account (not displayed); its attempt then resolves back to the SAME account
      // with no fence (not_activated, or a same-account settlement), or a stale retirement leaves no fence. Nothing is left to recover.
      const w = await recoveryWorld({
        cursor: "d1",
        phase: "delta",
        cacheStatus: "valid",
        displayed: false,
      });
      w.begins.push({ kind: "ineligible", reason });
      await w.bindJob();
      await w.settle();
      const reports = () =>
        w.calls
          .filter((c) => c.call === "report")
          .map((c) => (c as { phase: string | null }).phase);
      expect(reports()).toEqual(["failed"]);
      w.begins.push({ kind: "ineligible", reason: "no_fence" });
      w.setGate(null);
      w.fire();
      await w.settle();
      await w.advance(60_000);
      expect(reports()).toEqual(["failed", null]);
      expect(w.requests).toEqual([]);
    });

  test("control: no_fence with nothing reported reports nothing", async () => {
    const w = await recoveryWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.begins.push({ kind: "ineligible", reason: "no_fence" });
    await w.bindJob();
    await w.settle();
    expect(w.calls.filter((c) => c.call === "report")).toEqual([]);
  });
});
describe("WEB-08c K-2, R3 of the review of 11 October 2026: a gate that ended BEFORE the admission wait's first probe", () => {
  const reportsOf = (w: Awaited<ReturnType<typeof recoveryWorld>>) =>
    w.calls
      .filter((c) => c.call === "report")
      .map((c) => (c as { phase: string | null }).phase);
  const beginsOf = (w: Awaited<ReturnType<typeof recoveryWorld>>) =>
    w.calls.filter((c) => c.call === "begin").length;

  for (const reason of ["attempt_gating", "operation_pending"] as const)
    test(`R3 (${reason}): begin reported the gate, the gate ended before the first probe (nothing fenced): the probe differs from begin's own revision, begin is asked again and the failure is withdrawn`, async () => {
      // The reviewer's production schedule: "Confirm it's you" raises the gate, the job's `begin` says attempt_gating and reports
      // `failed`, and the activation is refused at once, so the attempt is cleared BEFORE the wait's first probe. That probe's baseline is
      // already the ungated record: blocked (nothing is fenced) and never changing again.
      const w = await recoveryWorld({
        cursor: "d1",
        phase: "delta",
        cacheStatus: "valid",
        displayed: false,
      });
      w.begins.push({ kind: "ineligible", reason });
      w.afterBegin = (answer) => {
        if (answer.kind !== "ineligible" || answer.reason !== reason) return;
        w.afterBegin = undefined;
        w.setGate(null);
        w.unfenced = true;
        w.begins.push({ kind: "ineligible", reason: "no_fence" });
      };
      await w.bindJob();
      await w.settle();
      await w.advance(60_000);
      expect(reportsOf(w)).toEqual(["failed", null]);
      expect(beginsOf(w)).toBe(2);
      expect(w.job.state.get().kind).toBe("idle");
      expect(w.requests).toEqual([]);
    });

  test("control: the gate ends AFTER the first probe (nothing fenced, the faithful probe): the changed revision asks begin again and the failure is withdrawn", async () => {
    const w = await recoveryWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.begins.push({ kind: "ineligible", reason: "attempt_gating" });
    await w.bindJob();
    await w.settle();
    expect(reportsOf(w)).toEqual(["failed"]);
    w.begins.push({ kind: "ineligible", reason: "no_fence" });
    w.setGate(null);
    w.unfenced = true;
    w.fire();
    await w.settle();
    await w.advance(60_000);
    expect(reportsOf(w)).toEqual(["failed", null]);
    expect(w.requests).toEqual([]);
  });

  test("no loop: a gate that still stands at the first probe asks nothing more until the revision changes", async () => {
    const w = await recoveryWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.setGate("attempt_gating");
    w.reportNotifies = true;
    await w.bindJob();
    await w.settle();
    await w.advance(10 * 60_000);
    expect(beginsOf(w)).toBe(1);
    expect(reportsOf(w)).toEqual(["failed"]);
    // The gate ends: the revision changes, begin is asked, and nothing being fenced, the failure is withdrawn.
    w.setGate(null);
    w.unfenced = true;
    w.begins.push({ kind: "ineligible", reason: "no_fence" });
    w.fire();
    await w.settle();
    expect(beginsOf(w)).toBe(2);
    expect(reportsOf(w)).toEqual(["failed", null]);
    expect(w.requests).toEqual([]);
  });
});

/**
 * WEB-08c revision 4 (DA-N1 of the design assessment of 14 October 2026, S9; WEB08C-T24D-QUOTA-20261014; RECOVERY-NAVIGATION-ENROLMENT-20261014
 * D2): a recovery page that cannot be committed for want of space stops at once and is retried ONLY by "Try again". Connectivity returning,
 * a wake of the job (the session's notifications, visibility) and time are no retry; the page's stop is recorded in the account's
 * write-failure marker, so a reload or a takeover (a new job over the same database) finds it at the capture gate and sends nothing. A
 * marker that cannot be written is a stop of this tab's memory: no loop here; a reload permits one fresh attempt (the accepted limit).
 */
describe("DA-N1: a recovery quota stop is left only by Try again", () => {
  async function fencedAt(cursor: string) {
    const w = await recoveryWorld({
      cursor,
      phase: "delta",
      cacheStatus: "valid",
      displayed: false,
    });
    w.put("cache", [cacheRow({ id: uuid(40) })]);
    return w;
  }
  const pageMarkers = (w: RecoveryWorld) =>
    w.markerStorage
      .keys()
      .filter(
        (key) =>
          key.startsWith("atlas-write-failing:") &&
          key.includes(":page:delta-0#"),
      );
  const reports = (w: RecoveryWorld) =>
    w.calls
      .filter((c) => c.call === "report")
      .map((c) => (c as { phase: string | null }).phase);
  const quotaOnce = (w: RecoveryWorld, times = 1) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.commitPage",
      mode: { kind: "throw_on_write", n: 1, as: "quota" },
      times,
    });

  test("S9: quota once; online, wakes and time send nothing; one Try again fetches the whole page again from the same cursor and finishes", async () => {
    const w = await fencedAt("delta-0");
    quotaOnce(w);
    w.script.push(w.page_(delta([41])), w.page_(delta([41])));
    await w.bindJob();
    await w.settle();
    expect(w.state()).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(w.state()).not.toHaveProperty("memoryOnly");
    expect(w.requests.map((r) => r.url.searchParams.get("cursor"))).toEqual([
      "delta-0",
    ]);
    expect(pageMarkers(w)).toHaveLength(1);
    expect(ids(w)).toEqual([uuid(40)]);
    expect(w.sync().cursor).toBe("delta-0");
    expect(reports(w).at(-1)).toBe("failed");
    // Connectivity "returns", the session notifies (view, identity, visibility), time passes: nothing is asked again.
    w.online = false;
    w.fire();
    await w.settle();
    w.goOnline();
    await w.settle();
    w.fire();
    w.view.set({ kind: "neutral", state: "3" as never });
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(w.calls.filter((c) => c.call === "finish")).toHaveLength(0);
    // The person's act: the whole page again, from the same saved position; the marker is retired and the recovery finishes.
    w.job.retryNow();
    await w.settle();
    expect(w.requests.map((r) => r.url.searchParams.get("cursor"))).toEqual([
      "delta-0",
      "delta-0",
    ]);
    expect(ids(w)).toEqual([uuid(40), uuid(41)]);
    expect(pageMarkers(w)).toHaveLength(0);
    expect(w.calls.filter((c) => c.call === "finish")).toHaveLength(1);
    expect(reports(w).at(-1)).toBeNull();
  });

  test("S7/S6: the stop survives a reload or takeover (a new job over the same database finds the marker and sends nothing); Try again there retries", async () => {
    const w = await fencedAt("delta-0");
    quotaOnce(w);
    w.script.push(w.page_(delta([41])), w.page_(delta([41])));
    await w.bindJob();
    await w.settle();
    expect(pageMarkers(w)).toHaveLength(1);
    await w.reload();
    await w.advance(10 * 60_000);
    w.goOnline();
    await w.advance(60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    expect(reports(w).at(-1)).toBe("failed");
    w.job.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(ids(w)).toEqual([uuid(40), uuid(41)]);
    expect(pageMarkers(w)).toHaveLength(0);
    expect(w.calls.filter((c) => c.call === "finish")).toHaveLength(1);
  });

  test("D2 (accepted limit): a marker that cannot be written leaves a stop of this tab's memory: no automatic retry here; a reload permits ONE attempt, which stops again while quota persists", async () => {
    const w = await fencedAt("delta-0");
    quotaOnce(w, 2);
    w.markerStorage.failWrites = true;
    w.script.push(
      w.page_(delta([41])),
      w.page_(delta([41])),
      w.page_(delta([41])),
    );
    await w.bindJob();
    await w.settle();
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "storage_full",
      memoryOnly: true,
    });
    w.goOnline();
    w.fire();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(1);
    await w.reload();
    await w.advance(10 * 60_000);
    w.goOnline();
    await w.advance(10 * 60_000);
    // One fresh attempt after the reload, which fails on quota again and stops (no loop); nothing of the page was committed.
    expect(w.requests).toHaveLength(2);
    expect(w.state()).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(ids(w)).toEqual([uuid(40)]);
    expect(w.sync().cursor).toBe("delta-0");
  });

  test("control (E-R4): a DataError of the same page keeps its three automatic whole-page attempts, then stops", async () => {
    const w = await fencedAt("delta-0");
    w.env.idb.inject({
      match: (tx) => tx.label === "data.commitPage",
      mode: { kind: "throw_on_write", n: 1, as: "error" },
      times: 3,
    });
    w.script.push(
      w.page_(delta([41])),
      w.page_(delta([41])),
      w.page_(delta([41])),
    );
    await w.bindJob();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(3);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
  });

  test("the guard's refusal BEFORE a request (no space for the page) is not re-entered by online either; Try again asks again", async () => {
    const w = await fencedAt("delta-0");
    w.freeBytes = 1024;
    w.script.push(w.page_(delta([41])));
    await w.bindJob();
    await w.settle();
    expect(w.state()).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(w.requests).toHaveLength(0);
    const begins = w.calls.filter((c) => c.call === "begin").length;
    w.freeBytes = 500 * 1024 * 1024;
    w.goOnline();
    w.fire();
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(0);
    expect(w.calls.filter((c) => c.call === "begin")).toHaveLength(begins);
    w.job.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(ids(w)).toEqual([uuid(40), uuid(41)]);
  });
});

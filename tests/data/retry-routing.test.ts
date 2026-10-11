// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import type { SyncMessage } from "../../src/data/engine/sync-channel";
import { parseSyncMessage } from "../../src/data/engine/sync-channel";
import { DATA_CONFIG } from "../../src/data/model/config";
import { createDataEnv } from "../../src/data/ui/env";
import {
  A,
  B,
  type LeaderWorld,
  leaderWorld,
} from "../support/data/leader-world";
import { ACCOUNT, pageWorld } from "../support/data/page-world";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * R2 of the review of 10 October 2026 (finding family recovery-retry-public-composition): the person's retry of UPDATES reaches the
 * recovery job (or the engine) that owns the attempt, wherever it was pressed. The leading page applies it itself; a follower page has
 * neither engine nor job and asks the leading page on `atlas-sync` for the account and the epoch it shows; the leader applies it only if
 * it is bound to exactly those. The neutral state 3's "Try again" is wired through `session.recovery.onRetry` in the browser composition
 * (`src/data/ui/browser-leader.ts`) and is exercised through the visible button in a real engine (E-R4, E-R9).
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});
const snapshot = (): PageSpec => ({
  phase: "snapshot",
  hasMore: false,
  nextCursor: "delta-1",
  batches: [{ revision: 10, changes: [upsert(1)] }],
});
const syncs = (w: LeaderWorld, page?: string) =>
  w.requests.filter(
    (r) => r.path === "/sync" && (page === undefined || r.page === page),
  );

/** A leader page A whose job is PAUSED (a sustained `503`), and a follower page B. Nothing automatic is sent while it is paused. */
async function pausedLeader() {
  const w = leaderWorld();
  w.server = (request) =>
    request.path === "/sync" ? w.status(503) : w.status(404);
  const one = w.page("A");
  const two = w.page("B");
  await w.settle();
  await w.advance(DATA_CONFIG.retrySustainedMs + 180_000);
  expect(one.leader.job.state.get().kind).toBe("paused");
  expect(w.sync()?.read_retry_states.sync?.paused).toBe(true);
  const asked = syncs(w).length;
  await w.advance(600_000);
  expect(syncs(w)).toHaveLength(asked);
  w.server = (request) => {
    if (request.path !== "/sync") return w.status(404);
    if (request.cursor === null) return w.json(snapshot());
    return w.json({
      phase: "delta",
      hasMore: false,
      nextCursor: request.cursor,
      batches: [],
    });
  };
  return { w, one, two, asked };
}

describe("L-12: the person's retry of updates reaches the recovery owner from any page (R2)", () => {
  test("a FOLLOWER's retry is applied by the leading page: the paused job resumes and the snapshot completes; the follower sends nothing", async () => {
    const { w, one, two, asked } = await pausedLeader();
    two.leader.retryUpdates({ account: A, epoch: 1 });
    await w.settle();
    expect(syncs(w, "A").length).toBeGreaterThan(asked);
    expect(syncs(w, "B")).toHaveLength(0);
    expect(w.sync()?.cache_status).toBe("valid");
    expect(one.leader.job.state.get()).toEqual({ kind: "idle" });
  });

  test("on the leading page itself the retry is its own job's, without the channel", async () => {
    const { w, one, asked } = await pausedLeader();
    one.leader.retryUpdates({ account: A, epoch: 1 });
    await w.settle();
    expect(syncs(w, "A").length).toBeGreaterThan(asked);
    expect(w.sync()?.cache_status).toBe("valid");
  });

  for (const [what, target] of [
    ["another epoch", { account: A, epoch: 2 }],
    ["another account", { account: B, epoch: 1 }],
  ] as const)
    test(`control: a retry made against ${what} is not applied by the leader`, async () => {
      const { w, two, asked } = await pausedLeader();
      two.leader.retryUpdates(target);
      await w.settle();
      await w.advance(60_000);
      expect(syncs(w)).toHaveLength(asked);
      expect(w.sync()?.read_retry_states.sync?.paused).toBe(true);
    });
});

describe("the follower controller asks the leading page (R2)", () => {
  test("`retryUpdates` on a follower posts `retry_requested` for the account and the epoch it shows, and nothing else", async () => {
    const w = await pageWorld({ cursor: "d1", phase: "delta" });
    const posted: SyncMessage[] = [];
    const runtime = new w.env.modules.accountService.DataRuntime({
      identity: w.identity,
      persistence: unorderedPersistence,
      registry: w.page.registry,
      open: (account, options) => w.page.open(account, options),
    });
    const ui = createDataEnv({
      identity: w.identity,
      loadRuntime: async () => runtime,
      online: { get: () => true, subscribe: () => () => undefined },
      quota: {
        check: async () => "admit",
      } as never,
      ids: { uuid: () => crypto.randomUUID() },
      clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
      readMe: async () => ({ kind: "closed" }),
      currentDeviceId: async () => ({ kind: "closed" }),
      onOnline: () => () => undefined,
      channel: {
        post: (message) => {
          posted.push(message);
        },
        subscribe: () => () => undefined,
      },
    });
    ui.attachFollower();
    ui.actions.retryUpdates();
    expect(posted).toEqual([
      { type: "retry_requested", account: ACCOUNT, epoch: 1 },
    ]);
    ui.dispose();
  });

  test("the message is part of the channel's closed union, and a malformed one is ignored", () => {
    expect(
      parseSyncMessage({ type: "retry_requested", account: A, epoch: 3 }),
    ).toEqual({ type: "retry_requested", account: A, epoch: 3 });
    for (const bad of [
      { type: "retry_requested", account: A },
      { type: "retry_requested", account: A, epoch: "3" },
      { type: "retry_requested", account: A, epoch: -1 },
      { type: "retry_requested", account: "", epoch: 1 },
    ])
      expect(parseSyncMessage(bad)).toBeNull();
  });
});

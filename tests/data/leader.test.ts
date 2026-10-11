// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { DraftRow } from "../../src/data/model/types";
import {
  A,
  B,
  type LeaderWorld,
  leaderWorld,
  type ServerRequest,
} from "../support/data/leader-world";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * Production leadership (P-1 to P-8) over the deterministic world: one fixed origin-wide lock, never released across a transition; a
 * follower that issues nothing; a binding per (leader, account, incarnation) with its own ownership token; the engine stopped while
 * the recovery job has the cache; and reconciliation row 6 case (f), both variants, with two pages.
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});
const snapshot = (over: Partial<PageSpec> = {}): PageSpec => ({
  phase: "snapshot",
  hasMore: false,
  nextCursor: "delta-1",
  batches: [{ revision: 10, changes: [upsert(1)] }],
  ...over,
});
const syncs = (w: LeaderWorld, page?: string): ServerRequest[] =>
  w.requests.filter(
    (r) => r.path === "/sync" && (page === undefined || r.page === page),
  );
const held = (w: LeaderWorld, page: string) =>
  w.env.lockManager.holdsExclusive(page, w.leaderName);

/** A server that answers the first cursor-less `/sync` with a one-page snapshot and every delta request with an empty page. */
function snapshotServer(w: LeaderWorld): void {
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
}

describe("L: the election", () => {
  test("L-1/L-2 the first page holds the ONE fixed lock and leads; the second follows, its request queued, and issues nothing", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    const two = w.page("B");
    await w.settle();
    expect(one.leader.role.get()).toEqual({ kind: "leader" });
    expect(two.leader.role.get()).toEqual({ kind: "follower" });
    expect(held(w, "A")).toBe(true);
    expect(held(w, "B")).toBe(false);
    expect(syncs(w, "B")).toEqual([]);
    expect(two.attachments.at(-1)).toEqual({ role: "follower" });
    expect(one.attachments.at(-1)).toMatchObject({ role: "leader" });
    // The leader created the database, snapshotted it and activated it; the owner is the leader's tab.
    expect(w.sync()).toMatchObject({
      cache_status: "valid",
      cursor: "delta-1",
      owner: { tab_id: one.env.registry.tabId },
    });
  });

  test("L-3 the lock is never released across A to B to A, a sign-out or a re-authentication; the follower's request is never granted", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    const two = w.page("B");
    await w.settle();
    const tokens: string[] = [];
    const record = () => {
      const binding = one.leader.binding.get();
      if (binding !== null) tokens.push(binding.token);
    };
    record();
    for (const [account, epoch] of [
      [B, 1],
      [A, 1],
      [null, 1],
      [A, 2],
    ] as const) {
      one.identity.move(account, epoch);
      await w.settle();
      expect(held(w, "A"), `${account}/${epoch}`).toBe(true);
      expect(two.leader.role.get(), `${account}/${epoch}`).toEqual({
        kind: "follower",
      });
      record();
    }
    // Every binding wrote a token of its own.
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.length).toBeGreaterThanOrEqual(4);
  });

  test("L-4 the leader's page goes away: the queued request is granted and that page leads, binds and owns the database", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    w.page("A");
    const two = w.page("B");
    await w.settle();
    const first = w.sync()?.owner?.ownership_token;
    w.destroy("A");
    await w.settle();
    expect(two.leader.role.get()).toEqual({ kind: "leader" });
    expect(held(w, "B")).toBe(true);
    expect(w.sync()?.owner).toMatchObject({ tab_id: two.env.registry.tabId });
    expect(w.sync()?.owner?.ownership_token).not.toBe(first);
    expect(two.attachments.at(-1)).toMatchObject({ role: "leader" });
  });

  test("L-5 the engine and the dispatcher run with the binding's token: the engine's delta pages are applied under OWN", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    const token = one.leader.binding.get()?.token;
    expect(w.sync()?.owner?.ownership_token).toBe(token);
    const before = w.sync()?.page_seq ?? 0;
    // The engine's live-edge poll: an ordinary delta request on the activated cursor, applied (page_seq advances).
    await w.advance(61_000);
    const deltas = syncs(w, "A").filter((r) => r.cursor === "delta-1");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((r) => r.klass === "ordinary")).toBe(true);
    expect(w.sync()?.page_seq ?? 0).toBeGreaterThan(before);
    expect(one.leader.dispatcher.state.get().kind).not.toBe("not_started");
  });

  test("L-6 the engine is stopped while the job has the cache, and started again with the same ownership once it is done", async () => {
    const w = leaderWorld();
    let release: (r: Response) => void = () => undefined;
    w.server = (request) => {
      if (request.cursor === null)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return w.json({
        phase: "delta",
        hasMore: false,
        nextCursor: request.cursor ?? "x",
        batches: [],
      });
    };
    const one = w.page("A");
    await w.settle();
    expect(one.leader.job.exclusive.get()).toBe(true);
    expect(one.leader.engine.state.get()).toEqual({ kind: "not_started" });
    expect(syncs(w)).toHaveLength(1);
    release(w.json(snapshot()));
    await w.settle();
    expect(one.leader.job.exclusive.get()).toBe(false);
    expect(one.leader.engine.state.get().kind).not.toBe("not_started");
  });

  test("L-7 dispose (tests and HMR only) gives the lock up and the follower leads", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    const two = w.page("B");
    await w.settle();
    one.leader.dispose();
    await w.settle();
    expect(two.leader.role.get()).toEqual({ kind: "leader" });
  });

  test("L-8 a logout or retirement pending for the account: no database is created and nothing is sent (row 3)", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    w.env.page("A").pending.add(A);
    w.page("A");
    await w.advance(60_000);
    expect(syncs(w)).toEqual([]);
    expect(w.sync()).toBeUndefined();
  });
});

describe("L-9: a closure of the account is never undone by the leader", () => {
  test("a wipe's latch: the leader does not reopen by itself, nor on notifications while the logout is pending; it rebinds once it has resolved", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    expect(one.leader.binding.get()).not.toBeNull();
    // A confirmed logout is pending and its wipe closes the page's connections (`wipe_imminent`), the identity still A for now.
    one.env.pending.add(A);
    one.env.registry.closeAll(A, { latch: "closed_for_deletion" });
    await w.advance(60_000);
    expect(one.leader.binding.get()).toBeNull();
    expect(one.env.registry.latch(A)).toBe("closed_for_deletion");
    // The session's notifications keep arriving while the operation is pending: still nothing is opened.
    one.view.set({ kind: "neutral", state: "1e.checking" as never });
    await w.advance(60_000);
    expect(one.env.registry.latch(A)).toBe("closed_for_deletion");
    expect(one.leader.binding.get()).toBeNull();
    // The operation resolves (here: Keep, still signed in) and the session notifies: the leader binds again.
    one.env.pending.delete(A);
    one.view.set({ kind: "displaying", account_id: A, epoch: 1 });
    await w.settle();
    expect(one.leader.binding.get()).not.toBeNull();
  });
});

describe("L-9b: a closure with nothing pending is not undone by the leader either", () => {
  test("another tab's deletion latches the account here: the leader's service ends and it does not reopen by itself; only the session's next notification looks again", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    expect(one.leader.binding.get()).not.toBeNull();
    one.env.registry.closeAll(A, { latch: "closed_for_deletion" });
    await w.advance(60_000);
    expect(one.leader.binding.get()).toBeNull();
    expect(one.env.registry.latch(A)).toBe("closed_for_deletion");
  });
});

describe("L-11: a draft saved through another facade is sent by the leader at once", () => {
  test("the `drafts` hint wakes the leader's dispatcher: the draft is sent without waiting for an unrelated wake", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    // Idle: the dispatcher has nothing to send and sleeps until an event.
    await w.advance(120_000);
    const before = w.requests.filter((r) => r.path === "/commands").length;
    w.env.idb.seed(accountDatabaseName(A), "drafts", [
      {
        local_id: "33333333-0000-4000-8000-000000000001",
        account_id: A,
        endpoint: "/commands",
        target_id: null,
        kind: "note",
        command: { kind: "note", text: "from another facade" },
        command_digest: "d".repeat(64),
        defaults_revision: null,
        target_resource_ids: [],
        side_effect_bases: {},
        index_targets: [],
        bases: {},
        bumped: [],
        defaults_context: null,
        review_block: null,
        depends_on: [],
        status: "queued",
        held_pending_cache: false,
        unavailable_outcome: false,
        retry_state: null,
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        display_patch: null,
        receipt_revision: null,
        created_seq: 1,
        created_at: "2026-10-10T09:00:00.000Z",
      } as never,
    ]);
    w.server = (request) =>
      request.path === "/commands"
        ? new Response(JSON.stringify({ revision: 30 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : w.json({
            phase: "delta",
            hasMore: false,
            nextCursor: request.cursor ?? "x",
            batches: [],
          });
    w.hint({
      type: "data_changed",
      account: A,
      stores: ["drafts", "resource_versions"],
    });
    await w.settle();
    const sent = w.requests.filter((r) => r.path === "/commands");
    expect(sent.length - before).toBe(1);
    expect(sent.at(-1)).toMatchObject({
      page: "A",
      key: "33333333-0000-4000-8000-000000000001",
    });
    void one;
  });
});

describe("L-10: nothing ordinary runs while the account is not displayed", () => {
  test("a fence stops the engine and the dispatcher (a refused request would re-evaluate the session and wake them again); the display starts them again", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    expect(one.leader.engine.state.get().kind).not.toBe("not_started");
    expect(one.leader.dispatcher.state.get().kind).not.toBe("not_started");
    // A fence: the session shows a neutral state for the account (a 401 was recorded). The recovery job is not eligible yet.
    one.begins.push({ kind: "ineligible", reason: "current_epoch_entry" });
    one.view.set({ kind: "neutral", state: "1d.reauth" as never });
    await w.settle();
    expect(one.leader.engine.state.get()).toEqual({ kind: "not_started" });
    expect(one.leader.dispatcher.state.get()).toEqual({ kind: "not_started" });
    const before = w.requests.length;
    await w.advance(5 * 60_000);
    expect(w.requests.length).toBe(before);
    // Displayed again: both run again, under the same binding.
    const token = one.leader.binding.get()?.token;
    one.view.set({ kind: "displaying", account_id: A, epoch: 1 });
    await w.settle();
    expect(one.leader.engine.state.get().kind).not.toBe("not_started");
    expect(one.leader.dispatcher.state.get().kind).not.toBe("not_started");
    expect(one.leader.binding.get()?.token).toBe(token);
  });
});

describe("F: reconciliation row 6 case (f), two pages, the leader lock held throughout", () => {
  test("F-1 variant 1: a stalled delta read of A, a confirmed wipe of A, B, then A again: the stalled answer writes nothing to the second A database", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    const two = w.page("B");
    await w.settle();
    // The engine's next delta request on A stalls.
    let release: (r: Response) => void = () => undefined;
    w.server = (request) => {
      if (request.path !== "/sync") return w.status(404);
      if (request.account === A && request.cursor === "delta-1")
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (request.cursor === null)
        return w.json(snapshot({ nextCursor: `delta-${request.account}` }));
      return w.json({
        phase: "delta",
        hasMore: false,
        nextCursor: request.cursor,
        batches: [],
      });
    };
    await w.advance(61_000);
    expect(
      syncs(w).some((r) => r.account === A && r.cursor === "delta-1"),
    ).toBe(true);
    const firstIncarnation = w.sync()?.incarnation_id;
    // A confirmed logout wipes A: every page's connections close, the database is deleted.
    one.env.registry.closeAll(A, { latch: "closed_for_deletion" });
    two.env.registry.closeAll(A, { latch: "closed_for_deletion" });
    one.identity.move(null);
    two.identity.move(null);
    await w.settle();
    expect(await w.env.run(one.env.host.delete(accountDatabaseName(A)))).toBe(
      "deleted",
    );
    // B on tab 1, then A again: a second A database, a new incarnation, a first snapshot.
    one.identity.move(B);
    two.identity.move(B);
    await w.settle();
    one.identity.move(A);
    two.identity.move(A);
    await w.settle();
    const second = w.sync();
    expect(second?.incarnation_id).not.toBe(firstIncarnation);
    expect(second?.cache_status).toBe("valid");
    const pagesBefore = second?.page_seq ?? 0;
    // The stalled answer of the FIRST A arrives now.
    release(
      w.json({
        phase: "delta",
        hasMore: false,
        nextCursor: "stale-cursor",
        batches: [{ revision: 99, changes: [upsert(77)] }],
      }),
    );
    await w.settle();
    // Dropped (incarnation, owner, generation, position): nothing of it reached cache, cache_staging, sync_state or pending_effects.
    const after = w.env.idb.snapshot(accountDatabaseName(A));
    const rows = JSON.stringify(after);
    expect(rows).not.toContain(uuid(77));
    expect(rows).not.toContain("stale-cursor");
    expect(w.sync()?.applied_revision).not.toBe(99);
    expect(w.sync()?.incarnation_id).toBe(second?.incarnation_id);
    // Only the second database's own engine moved it (its own polls), never the stalled answer.
    expect(w.sync()?.page_seq ?? 0).toBeGreaterThanOrEqual(pagesBefore);
    expect(held(w, "A")).toBe(true);
    expect(two.leader.role.get()).toEqual({ kind: "follower" });
    expect(syncs(w, "B")).toEqual([]);
  });

  test("F-2 variant 2: a queued command stalls in flight under A; B binds; its late answer is discarded; A returns and the command is retried once with its original key", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    const two = w.page("B");
    await w.settle();
    // A command is saved under A.
    const outbox = one.leader.outbox();
    expect(outbox).not.toBeNull();
    let release: (r: Response) => void = () => undefined;
    let sends = 0;
    w.server = (request) => {
      if (request.path === "/commands") {
        sends += 1;
        if (sends === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return new Response(JSON.stringify({ revision: 12 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.path !== "/sync") return w.status(404);
      if (request.cursor === null)
        return w.json(snapshot({ nextCursor: `delta-${request.account}` }));
      return w.json({
        phase: "delta",
        hasMore: false,
        nextCursor: request.cursor,
        batches: [],
      });
    };
    const saved = await w.env.run(
      (outbox as NonNullable<typeof outbox>).enqueue({
        endpoint: "/commands",
        targets: [],
        build: () => ({ command: { kind: "note", body: "x" } }),
      }),
    );
    expect(saved).toMatchObject({ kind: "queued" });
    await w.settle();
    const first = w.requests.filter((r) => r.path === "/commands");
    expect(first).toHaveLength(1);
    const key = first[0]?.key;
    // B binds on tab 1 (no wipe), then the stalled answer arrives: discarded by the stamp.
    one.identity.move(B);
    two.identity.move(B);
    await w.settle();
    release(
      new Response(JSON.stringify({ revision: 12 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await w.settle();
    const draftsOfA = () =>
      (w.env.idb.snapshot(accountDatabaseName(A))?.drafts ?? []) as DraftRow[];
    expect(draftsOfA().map((d) => d.status)).toEqual(["in_flight"]);
    // A returns: its database and cursor resume (no new snapshot), and the command is sent once more with the same key.
    const cursorBefore = w.sync()?.cursor;
    one.identity.move(A);
    two.identity.move(A);
    await w.advance(60_000);
    const sent = w.requests.filter((r) => r.path === "/commands");
    expect(sent.length).toBe(2);
    expect(sent.every((r) => r.key === key && r.page === "A")).toBe(true);
    expect(w.sync()?.cursor).toBe(cursorBefore);
    expect(
      syncs(w).filter((r) => r.account === A && r.cursor === null),
    ).toHaveLength(1);
    expect(w.requests.filter((r) => r.page === "B")).toEqual([]);
  });
});

describe("L-13: an account switch while the old account's request is in flight (R4 of the review of 10 October 2026)", () => {
  test("the new account's binding starts its own snapshot as soon as the old step ends, with no further notification; the old answer applies nothing", async () => {
    const w = leaderWorld();
    let release: (r: Response) => void = () => undefined;
    w.server = (request) => {
      if (request.path !== "/sync") return w.status(404);
      if (request.account === A && request.cursor === null)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (request.cursor === null) return w.json(snapshot());
      return w.json({
        phase: "delta",
        hasMore: false,
        nextCursor: request.cursor,
        batches: [],
      });
    };
    const one = w.page("A");
    await w.settle();
    expect(syncs(w).map((r) => r.account)).toEqual([A]);
    // The person switches to B: the leader rebinds (A's ownership aborted, B opened and owned) while A's request is still held, so the
    // job's step for A is still busy when it is bound to B.
    one.identity.move(B);
    await w.settle();
    expect(one.leader.binding.get()?.account).toBe(B);
    release(w.json(snapshot()));
    await w.settle();
    await w.advance(1_000);
    const forB = syncs(w).filter((r) => r.account === B);
    expect(forB.length).toBeGreaterThan(0);
    expect(w.sync(B)?.cache_status).toBe("valid");
    // A's late answer wrote nothing to A's database (its binding was aborted; A's attempt is still the one it captured).
    expect(w.sync(A)?.cache_status).not.toBe("valid");
  });
});

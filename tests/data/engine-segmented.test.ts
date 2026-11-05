// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { engineWorld } from "../support/data/engine-world";
import { type Change, projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * U9 (WEB-09c, BOUNDED-SYNC-PAGINATION-20261027): segmented delta delivery through the PRODUCTION sync engine, plans and guards over the
 * double of IndexedDB; the server is a script and time is fake. FIXTURE evidence against BE-Q23's PROVISIONAL contract
 * (`model/segmented-sync.ts`): nothing here talks to a backend, and no backend implements the contract yet.
 */

const changesOf = (seed: number, n: number): Change[] =>
  Array.from({ length: n }, (_, k) => ({
    kind: "upsert" as const,
    resource: {
      ...projection(new Rng(seed + k), k),
      id: uuid(seed + k),
      version: 1,
    },
  }));

const segmentPage = (spec: {
  revision: number;
  changes: Change[];
  index: number;
  last: boolean;
  nextCursor: string;
  hasMore?: boolean;
}): Response =>
  new Response(
    JSON.stringify({
      phase: "delta",
      batches: [
        {
          revision: spec.revision,
          changes: spec.changes,
          segment: { index: spec.index, last: spec.last },
        },
      ],
      next_cursor: spec.nextCursor,
      has_more: spec.hasMore ?? !spec.last,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** The three segments of one revision of 12 changes (4 each), the last ending the feed. */
const threeSegments = (revision = 7) => {
  const changes = changesOf(100, 12);
  return {
    changes,
    pages: () => [
      segmentPage({
        revision,
        changes: changes.slice(0, 4),
        index: 0,
        last: false,
        nextCursor: "cont-0",
      }),
      segmentPage({
        revision,
        changes: changes.slice(4, 8),
        index: 1,
        last: false,
        nextCursor: "cont-1",
      }),
      segmentPage({
        revision,
        changes: changes.slice(8),
        index: 2,
        last: true,
        nextCursor: "final",
      }),
    ],
  };
};

const query = (url: URL) => Object.fromEntries(url.searchParams.entries());

describe("U9: the engine and segmented delivery", () => {
  test("I7: without a known-capable server no request carries max_changes, and a segment it did not ask for is an unrecognised answer", async () => {
    const w = await engineWorld();
    const before = w.snapshot();
    w.script.push(
      segmentPage({
        revision: 7,
        changes: changesOf(1, 2),
        index: 0,
        last: false,
        nextCursor: "cont-0",
      }),
    );
    w.start();
    await w.settle();
    expect(query(w.requests[0] as URL)).toEqual({
      cursor: "cursor-0",
      limit: String(DATA_CONFIG.initialLimitOther),
    });
    expect(w.cache()).toEqual(before?.cache);
    expect(w.sync().cursor).toBe("cursor-0");
    expect(w.sync().read_retry_states.sync?.unrecognised_streak).toBe(1);
    expect(w.rows("sync_state")).toHaveLength(1);
  });

  test("a capable server: every request carries the budget; the revision is staged, then activated once; the view moves only then", async () => {
    const w = await engineWorld({ segmentedCapable: () => true });
    const { changes, pages } = threeSegments();
    let sawCacheDuringStaging: number | null = null;
    const [first, second, third] = pages();
    w.script.push(
      first as Response,
      () => {
        sawCacheDuringStaging = w.cache().length;
        return second as Response;
      },
      third as Response,
    );
    w.start();
    await w.settle();
    expect(w.requests.slice(0, 3).map(query)).toEqual([
      { cursor: "cursor-0", limit: "1", max_changes: "100" },
      { cursor: "cont-0", limit: "1", max_changes: "100" },
      { cursor: "cont-1", limit: "1", max_changes: "100" },
    ]);
    expect(sawCacheDuringStaging).toBe(0);
    expect(
      w
        .cache()
        .map((r) => r.id)
        .sort(),
    ).toEqual(
      changes
        .map((c) => (c as { resource: { id: string } }).resource.id)
        .sort(),
    );
    expect(w.sync()).toMatchObject({
      cursor: "final",
      applied_revision: 7,
      page_seq: 1,
      delta_stage: null,
    });
    expect(w.rows("delta_staging" as never)).toEqual([]);
    expect(w.state().kind).toBe("idle");
    // A staged segment told other pages only that the position moved; the activation that the cache changed.
    const stores = w.posted
      .filter((m) => m.type === "data_changed")
      .map((m) => [...(m as { stores: readonly string[] }).stores]);
    expect(stores).toEqual([
      ["sync_state"],
      ["sync_state"],
      ["cache", "sync_state"],
    ]);
  });

  test("I3: a reload mid-revision resumes from the stored continuation, even where the new page does not know the server segments", async () => {
    const w = await engineWorld({ segmentedCapable: () => true });
    const { changes, pages } = threeSegments();
    const [first, second, third] = pages();
    w.script.push(first as Response, new TypeError("network down"));
    w.start();
    await w.settle();
    expect(w.sync().cursor).toBe("cont-0");
    expect(w.cache()).toEqual([]);
    // The reloaded page has no capability answer (as production has none): the held continuation is still followed with the budget.
    w.reload();
    w.script.push(second as Response, third as Response);
    w.engine.start(w.ownership.value);
    await w.advance(60_000);
    const resumed = w.requests.slice(2).map(query);
    expect(resumed[0]).toEqual({
      cursor: "cont-0",
      limit: "1",
      max_changes: "100",
    });
    expect(resumed[1]).toEqual({
      cursor: "cont-1",
      limit: "1",
      max_changes: "100",
    });
    expect(w.cache()).toHaveLength(changes.length);
    // (The idle poll after the activation has moved the position on since; the revision was applied once.)
    expect(w.sync()).toMatchObject({ applied_revision: 7, delta_stage: null });
    expect(w.rows("delta_staging" as never)).toEqual([]);
  });

  test("I5: 410 mid-revision invalidates the position and drops the staged words with it", async () => {
    const w = await engineWorld({ segmentedCapable: () => true });
    const [first] = threeSegments().pages();
    w.script.push(first as Response, w.status(410));
    w.start();
    await w.settle();
    expect(w.sync()).toMatchObject({
      cache_status: "invalid",
      cursor: null,
      delta_stage: null,
    });
    expect(w.rows("delta_staging" as never)).toEqual([]);
    expect(w.cache()).toEqual([]);
  });

  test("a tab that did not survive a segmented page steps max_changes down (limit already 1), and the next request carries it", async () => {
    const w = await engineWorld({ segmentedCapable: () => true });
    w.setSync({
      sizing: {
        limit: 1,
        class: "unknown",
        floor_hits: 0,
        attempt: { id: "gone", limit: 1, started_at: 0, max_changes: 100 },
      },
    });
    w.start();
    await w.settle();
    expect(query(w.requests[0] as URL)).toMatchObject({
      limit: "1",
      max_changes: "50",
    });
    expect(w.sync().sizing).toMatchObject({ max_changes: 50, floor_hits: 0 });
  });

  test("I9: a quota refusal while staging stops for storage, with the staged words and the live cache untouched", async () => {
    const w = await engineWorld({ segmentedCapable: () => true });
    const [first, second] = threeSegments().pages();
    w.script.push(first as Response, () => {
      w.freeBytes = 1024 * 1024;
      return second as Response;
    });
    w.start();
    await w.settle();
    // The second segment was small enough to admit; the request for the third is refused by the early check, before it is sent.
    expect(w.state()).toEqual({ kind: "stopped", cause: "storage_full" });
    expect(w.requests).toHaveLength(2);
    expect(w.sync()).toMatchObject({
      cursor: "cont-1",
      delta_stage: { next_index: 2, boundary_cursor: "cursor-0" },
    });
    expect((w.rows("delta_staging" as never) as unknown[]).length).toBe(8);
    expect(w.cache()).toEqual([]);
  });

  test("I4: a server that keeps breaking the revision asks it again from where it began, and pauses at the unrecognised bound", async () => {
    const w = await engineWorld({ segmentedCapable: () => true });
    for (let i = 0; i < DATA_CONFIG.unrecognisedPauseAfter; i += 1) {
      const [first, , third] = threeSegments().pages();
      w.script.push(first as Response, third as Response);
    }
    w.start();
    for (let i = 0; i < 10 && w.state().kind !== "stopped"; i += 1)
      await w.advance(60_000);
    expect(w.state()).toEqual({ kind: "stopped", cause: "unrecognised" });
    // Every restart went back to the boundary: each first segment was asked for at cursor-0.
    expect(w.requests.map((u) => u.searchParams.get("cursor"))).toEqual(
      Array.from({ length: DATA_CONFIG.unrecognisedPauseAfter }, () => [
        "cursor-0",
        "cont-0",
      ]).flat(),
    );
    expect(w.cache()).toEqual([]);
    expect(w.rows("delta_staging" as never)).toEqual([]);
  });
});
